import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { getContext } from '../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../core/db/database.service.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { OutboxService } from '../../core/outbox/outbox.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';
import { withProcedureErrors } from './procedures.errors.js';
import { procedureEvent } from './procedures.events.js';
import type {
  AdministerRequest,
  BookingRequest,
  CancelOrderRequest,
  ChecklistRequest,
  CompleteRequest,
  ConsentRequest,
  ConsumableRequest,
  DressingRequest,
  ObservationOutcomeRequest,
  OrderQuery,
  OrderRequest,
  OverrideRequest,
  PerformRequest,
  RecoveryRequest,
  RoomRequest,
  TaskQuery,
  TaskRequest,
  TaskStatusRequest,
  TimeoutRequest,
} from './procedures.schemas.js';
import type {
  AdministrationRow,
  BookingRow,
  ChecklistRow,
  DressingRow,
  OrderDetail,
  OrderRow,
  ProcedureRow,
  RecoveryRow,
  RoomRow,
  TaskRow,
  TimeoutRow,
} from './procedures.types.js';

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}
function asTextOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : asText(v);
}
function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(asText(v));
}
function asNumberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : asNumber(v);
}
function asBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}
function asStringArray(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.map(asText) : [];
}

/**
 * OP-010 and OP-039 — the procedure spine.
 *
 * ── Nothing here decides whether a procedure may start ──────────────────────
 *
 * `perform` inserts the record and lets the trigger refuse. The blockers on
 * the order row are computed from the same four facts the trigger reads, and
 * they exist so the list can say what is missing before somebody walks the
 * patient into the room — not so the service can decide.
 *
 * ── Consent is the one thing with no path around it ─────────────────────────
 *
 * There is no request field, no permission and no route that starts a
 * procedure requiring consent without one. The checklist can be overridden by
 * a named person with a reason, because that is a real clinical act on an
 * urgent case; a signature nobody gave is not.
 *
 * ── The second person is not the first ──────────────────────────────────────
 *
 * On a high-alert drug the verifier comes from the request, because they are
 * standing there — and the database refuses them when they are the same person
 * as the giver, which no amount of client code can talk it out of.
 */
@Injectable()
export class ProceduresService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {}

  private hospitalId(): string {
    const id = getContext().hospitalId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private branchId(): string {
    const id = getContext().branchId;
    if (id === null || id === undefined) {
      throw AppError.conflict('This action needs a branch. Choose one and try again.');
    }
    return id;
  }
  private actorId(): string {
    const id = getContext().userId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withProcedureErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Rooms
  // ═══════════════════════════════════════════════════════════════════════════

  async createRoom(body: RoomRequest): Promise<RoomRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.procedure_rooms
           (id, hospital_id, branch_id, code, name, type, sub_store_id, open_hours, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::clinical."ProcedureRoomType",$7,$8::jsonb, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.code,
          body.name,
          body.type,
          body.subStoreId ?? null,
          body.openHours === undefined ? null : JSON.stringify(body.openHours),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The room was not created.');
      return this.toRoom(row);
    });
  }

  async listRooms(): Promise<readonly RoomRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.procedure_rooms WHERE hospital_id = $1 ORDER BY type, code`,
        [this.hospitalId()],
      );
      return rows.map((r) => this.toRoom(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Orders
  // ═══════════════════════════════════════════════════════════════════════════

  async order(body: OrderRequest): Promise<OrderRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const actor = this.actorId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'PROC',
        branchId: this.branchId(),
        refType: 'procedure_order',
        refId: id,
      });

      await tx.query(
        `INSERT INTO clinical.procedure_orders
           (id, hospital_id, branch_id, order_no, patient_id, encounter_id, visit_id,
            procedure_code, procedure_name, category, side, site_text, indication_icd10,
            urgency, requires_consent, sedation_requested, source_module,
            ordered_at, ordered_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::clinical."ProcedureCategory",
                 $11::clinical."Laterality",$12,$13,$14,$15,$16,$17, now(), $18, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          alloc.formatted,
          body.patientId,
          body.encounterId,
          body.visitId ?? null,
          body.procedureCode,
          body.procedureName,
          body.category,
          body.side,
          body.siteText ?? null,
          body.indicationIcd10 ?? null,
          body.urgency,
          body.requiresConsent,
          body.sedationRequested,
          body.sourceModule ?? null,
          actor,
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'procedure_order',
        rowId: id,
        businessKey: `${alloc.formatted} ${body.procedureCode}`,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId,
        before: null,
        after: { category: body.category, side: body.side, requiresConsent: body.requiresConsent },
      });

      await this.outbox.publish(
        tx,
        procedureEvent('procedure.ordered', id, {
          orderId: id,
          orderNo: alloc.formatted,
          patientId: body.patientId,
          encounterId: body.encounterId,
          procedureCode: body.procedureCode,
          category: body.category,
          side: body.side,
          sourceModule: body.sourceModule ?? null,
          requiresConsent: body.requiresConsent,
        }),
      );

      return this.readOrder(tx, id);
    });
  }

  async listOrders(query: OrderQuery): Promise<readonly OrderRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectOrder()}
          WHERE o.hospital_id = $1
            AND ($2::boolean IS NOT TRUE
                 OR o.status NOT IN ('completed', 'cancelled', 'abandoned', 'no_show'))
            AND ($3::text IS NULL OR o.status::text = $3::text)
          ORDER BY o.ordered_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.openOnly, query.status ?? null, query.limit],
      );
      return rows.map((r) => this.toOrder(r));
    });
  }

  async orderDetail(id: string): Promise<OrderDetail> {
    return this.guard(async (tx) => {
      const order = await this.readOrder(tx, id);

      const [bookings, checklists, timeouts, procedures] = await Promise.all([
        tx.query<Record<string, unknown>>(
          `SELECT b.*, r.name AS room_name
             FROM clinical.procedure_bookings b
             LEFT JOIN clinical.procedure_rooms r ON r.id = b.room_id
            WHERE b.order_id = $1 ORDER BY b.start_at`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM clinical.procedure_checklists WHERE order_id = $1 ORDER BY template_key`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM clinical.procedure_timeouts WHERE order_id = $1 ORDER BY confirmed_at`,
          [id],
        ),
        tx.query<Record<string, unknown>>(
          `SELECT * FROM clinical.procedures WHERE order_id = $1 ORDER BY started_at`,
          [id],
        ),
      ]);

      return {
        order,
        bookings: bookings.rows.map((r) => this.toBooking(r)),
        checklists: checklists.rows.map((r) => this.toChecklist(r)),
        timeouts: timeouts.rows.map((r) => this.toTimeout(r)),
        procedures: procedures.rows.map((r) => this.toProcedure(r)),
      };
    });
  }

  async cancelOrder(id: string, body: CancelOrderRequest): Promise<OrderRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.procedure_orders
            SET status = 'cancelled', cancel_reason = $3, updated_at = now()
          WHERE hospital_id = $1 AND id = $2
            AND status NOT IN ('completed', 'in_progress', 'cancelled')
          RETURNING *`,
        [this.hospitalId(), id, body.reason],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'That order does not exist, or it is already under way, finished or cancelled. A procedure in progress is abandoned, not cancelled.',
        );
      }

      // The room goes back on the board in the same breath.
      await tx.query(
        `UPDATE clinical.procedure_bookings
            SET status = 'cancelled', cancel_reason = $2, updated_at = now()
          WHERE order_id = $1 AND status IN ('booked', 'confirmed', 'checked_in')`,
        [id, body.reason],
      );

      await this.audit.write(tx, {
        action: 'delete',
        entity: 'procedure_order',
        rowId: id,
        businessKey: asText(row['order_no']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        before: null,
        after: { status: 'cancelled' },
        reasonText: body.reason,
      });

      return this.readOrder(tx, id);
    });
  }

  /**
   * Records the consent that was signed.
   *
   * Deliberately not "grant consent": this attaches an EN-028 consent document
   * that already exists. There is no route anywhere that marks a procedure as
   * consented without one.
   */
  async recordConsent(id: string, body: ConsentRequest): Promise<OrderRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.procedure_orders
            SET consent_id = $3, updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND status NOT IN ('completed', 'cancelled')
          RETURNING *`,
        [this.hospitalId(), id, body.consentId],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That order does not exist, or it is finished or cancelled.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'procedure_order',
        rowId: id,
        businessKey: `${asText(row['order_no'])} consent recorded`,
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        before: null,
        after: { consentId: body.consentId },
      });

      return this.readOrder(tx, id);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The room and the hour
  // ═══════════════════════════════════════════════════════════════════════════

  async book(orderId: string, body: BookingRequest): Promise<BookingRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.procedure_bookings
           (id, hospital_id, branch_id, order_id, room_id, doctor_id, anaesthetist_id,
            start_at, end_at, created_at, created_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9::timestamptz, now(), $10, now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          orderId,
          body.roomId,
          body.doctorId ?? null,
          body.anaesthetistId ?? null,
          body.startAt,
          body.endAt,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The booking was not written.');

      await tx.query(
        `UPDATE clinical.procedure_orders SET status = 'scheduled', updated_at = now()
          WHERE id = $1 AND status = 'ordered'`,
        [orderId],
      );

      await this.outbox.publish(
        tx,
        procedureEvent('procedure.booked', id, {
          bookingId: id,
          orderId,
          roomId: body.roomId,
          startAt: asText(row['start_at']),
          endAt: asText(row['end_at']),
          doctorId: body.doctorId ?? null,
        }),
      );

      return this.toBooking(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The checklist and the pause
  // ═══════════════════════════════════════════════════════════════════════════

  async saveChecklist(orderId: string, body: ChecklistRequest): Promise<ChecklistRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.procedure_checklists
           (id, hospital_id, order_id, template_key, items, ready, ready_by, ready_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6, CASE WHEN $6 THEN $7::uuid END,
                 CASE WHEN $6 THEN now() END, now(), now())
         ON CONFLICT (order_id, template_key) DO UPDATE SET
           items = EXCLUDED.items,
           ready = EXCLUDED.ready,
           ready_by = CASE WHEN EXCLUDED.ready THEN $7::uuid ELSE clinical.procedure_checklists.ready_by END,
           ready_at = CASE WHEN EXCLUDED.ready THEN now() ELSE clinical.procedure_checklists.ready_at END,
           updated_at = now()
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          orderId,
          body.templateKey,
          JSON.stringify(body.items),
          body.ready,
          actor,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The checklist was not saved.');
      return this.toChecklist(row);
    });
  }

  /**
   * Proceeds with an incomplete checklist, naming who decided and why.
   *
   * A real clinical act on an urgent case. It cannot touch consent, which is
   * a separate field the trigger checks separately.
   */
  async overrideChecklist(orderId: string, body: OverrideRequest): Promise<ChecklistRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.procedure_checklists
            SET override_reason = $3, override_by = $4, updated_at = now()
          WHERE hospital_id = $1 AND order_id = $2 AND NOT ready
          RETURNING *`,
        [this.hospitalId(), orderId, body.reason, actor],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'There is no incomplete checklist on that order to override. A complete one needs nothing.',
        );
      }

      await this.audit.write(tx, {
        action: 'override',
        entity: 'procedure_checklist',
        rowId: asText(row['id']),
        businessKey: asText(row['template_key']),
        dataClass: 'phi',
        before: null,
        after: { overriddenBy: actor },
        reasonText: body.reason,
      });

      return this.toChecklist(row);
    });
  }

  /** The pause. The caller is one confirmer; the second comes from the request. */
  async confirmTimeout(orderId: string, body: TimeoutRequest): Promise<TimeoutRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.procedure_timeouts
           (id, hospital_id, order_id, confirmed_by_1, confirmed_by_2,
            patient_ok, procedure_ok, side_ok, consent_ok, allergy_ok, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,true,true,true,true,true, now())
         RETURNING *`,
        [id, this.hospitalId(), orderId, actor, body.confirmedBy2],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The time-out was not recorded.');

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'procedure_timeout',
        rowId: id,
        businessKey: orderId,
        dataClass: 'phi',
        before: null,
        after: { confirmedBy: [actor, body.confirmedBy2] },
      });

      return this.toTimeout(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The procedure
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Starts the procedure.
   *
   * Writes the record and lets `a_procedure_does_not_start_on_a_promise`
   * refuse. Nothing is checked here first, on purpose: a service that also
   * checked would be a second implementation of a rule about consent, and the
   * day they disagree is the day one of them is wrong.
   */
  async perform(orderId: string, body: PerformRequest): Promise<ProcedureRow> {
    return this.guard(async (tx) => {
      const { rows: orders } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.procedure_orders WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), orderId],
      );
      const order = orders[0];
      if (order === undefined) throw AppError.notFound('That procedure order does not exist.');

      const id = newId();
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.procedures
           (id, hospital_id, branch_id, order_id, patient_id, encounter_id, performed_by,
            assistants, anaesthetist_id, anaesthesia, sedation_record, started_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid[],$9,$10::clinical."AnaesthesiaType",$11::jsonb,
                 now(), now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          orderId,
          asText(order['patient_id']),
          asText(order['encounter_id']),
          actor,
          body.assistants,
          body.anaesthetistId ?? null,
          body.anaesthesia,
          body.sedationRecord === undefined ? null : JSON.stringify(body.sedationRecord),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The procedure was not started.');

      await tx.query(
        `UPDATE clinical.procedure_orders SET status = 'in_progress', updated_at = now() WHERE id = $1`,
        [orderId],
      );

      const { rows: counted } = await tx.query<Record<string, unknown>>(
        `SELECT (SELECT count(*) FROM clinical.procedure_timeouts t WHERE t.order_id = $1) AS timeouts,
                (SELECT count(*) FROM clinical.procedure_checklists c
                  WHERE c.order_id = $1 AND NOT c.ready AND c.override_reason IS NOT NULL) AS overridden`,
        [orderId],
      );

      await this.outbox.publish(
        tx,
        procedureEvent('procedure.started', id, {
          procedureId: id,
          orderId,
          patientId: asText(order['patient_id']),
          procedureCode: asText(order['procedure_code']),
          anaesthesia: body.anaesthesia,
          consented: order['consent_id'] !== null,
          timeoutConfirmed: asNumber(counted[0]?.['timeouts'] ?? 0) > 0,
          checklistOverridden: asNumber(counted[0]?.['overridden'] ?? 0) > 0,
        }),
      );

      return this.toProcedure(row);
    });
  }

  async complete(procedureId: string, body: CompleteRequest): Promise<ProcedureRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.procedures
            SET ended_at = now(), findings = $3, technique = $4, ebl_ml = $5,
                specimens = $6::jsonb, complications = $7::jsonb, outcome = $8, updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL
          RETURNING *`,
        [
          this.hospitalId(),
          procedureId,
          body.findings,
          body.technique ?? null,
          body.eblMl ?? null,
          body.specimens === undefined ? null : JSON.stringify(body.specimens),
          body.complications === undefined ? null : JSON.stringify(body.complications),
          body.outcome,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That procedure does not exist, or its note is already signed.');
      }

      await tx.query(
        `UPDATE clinical.procedure_orders
            SET status = $2::clinical."ProcedureOrderStatus", updated_at = now()
          WHERE id = $1`,
        [asText(row['order_id']), body.outcome === 'abandoned' ? 'abandoned' : 'completed'],
      );

      return this.toProcedure(row);
    });
  }

  async sign(procedureId: string): Promise<ProcedureRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.procedures
            SET signed_by = $3, signed_at = now(), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND signed_at IS NULL AND ended_at IS NOT NULL
          RETURNING *`,
        [this.hospitalId(), procedureId, actor],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'That procedure does not exist, has not been completed, or its note is already signed.',
        );
      }

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'procedure',
        rowId: procedureId,
        businessKey: asText(row['order_id']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        before: null,
        after: { outcome: asTextOrNull(row['outcome']) },
      });

      const complications = row['complications'];
      await this.outbox.publish(
        tx,
        procedureEvent('procedure.signed', procedureId, {
          procedureId,
          orderId: asText(row['order_id']),
          patientId: asText(row['patient_id']),
          signedBy: actor,
          outcome: asTextOrNull(row['outcome']),
          hasComplications: Array.isArray(complications) && complications.length > 0,
        }),
      );

      return this.toProcedure(row);
    });
  }

  /**
   * Scores recovery and, when asked, discharges from it.
   *
   * The Aldrete floor and the escort are the database's; this passes the
   * numbers and lets it refuse. `discharge: false` is a score recorded on the
   * way, which is how a recovery bay actually works.
   */
  async recovery(procedureId: string, body: RecoveryRequest): Promise<RecoveryRow> {
    return this.guard(async (tx) => {
      // Without this the insert reaches the database and the foreign key
      // refuses it, which surfaces as a 500. The caller asked about a record
      // that does not exist; the honest answer is that it does not exist.
      const { rows: parent } = await tx.query<{ readonly present: number }>(
        `SELECT 1 AS present FROM clinical.procedures WHERE id = $1 AND hospital_id = $2`,
        [procedureId, this.hospitalId()],
      );
      if (parent[0] === undefined) throw AppError.notFound('That procedure was not found.');
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.procedure_recovery
           (id, hospital_id, procedure_id, aldrete_score, escort_name, escort_relationship,
            instructions, discharged_at, discharged_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8 THEN now() END,
                 CASE WHEN $8 THEN $9::uuid END, now(), now())
         ON CONFLICT (procedure_id) DO UPDATE SET
           aldrete_score = COALESCE(EXCLUDED.aldrete_score, clinical.procedure_recovery.aldrete_score),
           escort_name = COALESCE(EXCLUDED.escort_name, clinical.procedure_recovery.escort_name),
           escort_relationship = COALESCE(EXCLUDED.escort_relationship, clinical.procedure_recovery.escort_relationship),
           instructions = COALESCE(EXCLUDED.instructions, clinical.procedure_recovery.instructions),
           discharged_at = COALESCE(EXCLUDED.discharged_at, clinical.procedure_recovery.discharged_at),
           discharged_by = COALESCE(EXCLUDED.discharged_by, clinical.procedure_recovery.discharged_by),
           updated_at = now()
         RETURNING *`,
        [
          newId(),
          this.hospitalId(),
          procedureId,
          body.aldreteScore ?? null,
          body.escortName ?? null,
          body.escortRelationship ?? null,
          body.instructions ?? null,
          body.discharge,
          actor,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The recovery record was not written.');

      if (body.discharge) {
        const { rows: proc } = await tx.query<Record<string, unknown>>(
          `SELECT patient_id, anaesthesia::text AS anaesthesia FROM clinical.procedures WHERE id = $1`,
          [procedureId],
        );
        await this.outbox.publish(
          tx,
          procedureEvent('procedure.recovery.discharged', procedureId, {
            procedureId,
            patientId: asText(proc[0]?.['patient_id']),
            anaesthesia: asText(proc[0]?.['anaesthesia']),
            aldreteScore: asNumberOrNull(row['aldrete_score']),
            escortRecorded: asTextOrNull(row['escort_name']) !== null,
          }),
        );
      }

      return this.toRecovery(row);
    });
  }

  async recordConsumables(procedureId: string, body: ConsumableRequest): Promise<{ readonly count: number }> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      for (const item of body.items) {
        await tx.query(
          `INSERT INTO clinical.procedure_consumables
             (id, hospital_id, procedure_id, item_id, batch_id, qty, uom, source, chargeable,
              recorded_at, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10)`,
          [
            newId(),
            this.hospitalId(),
            procedureId,
            item.itemId,
            item.batchId ?? null,
            item.qty,
            item.uom,
            item.source,
            item.chargeable,
            actor,
          ],
        );
      }
      return { count: body.items.length };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-039 — the nursing rooms
  // ═══════════════════════════════════════════════════════════════════════════

  async createTask(body: TaskRequest): Promise<TaskRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.opd_nursing_tasks
           (id, hospital_id, branch_id, patient_id, encounter_id, order_id, type, room_type,
            room_id, day_no, day_total, scheduled_at, priority, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::clinical."OpdTaskType",$8::clinical."ProcedureRoomType",
                 $9,$10,$11,$12::timestamptz,$13,$14, now(), now())
         RETURNING *, 0::int AS under_observation`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId,
          body.orderId ?? null,
          body.type,
          body.roomType,
          body.roomId ?? null,
          body.dayNo ?? null,
          body.dayTotal ?? null,
          body.scheduledAt ?? null,
          body.priority,
          body.notes ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The task was not created.');
      return this.toTask(row);
    });
  }

  async listTasks(query: TaskQuery): Promise<readonly TaskRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectTask()}
          WHERE t.hospital_id = $1
            AND ($2::text IS NULL OR t.room_type::text = $2::text)
            AND ($3::boolean IS NOT TRUE
                 OR t.status NOT IN ('completed', 'cancelled', 'missed'))
          ORDER BY
            CASE t.priority WHEN 'stat' THEN 0 WHEN 'urgent' THEN 1 ELSE 2 END,
            COALESCE(t.scheduled_at, t.created_at)
          LIMIT $4`,
        [this.hospitalId(), query.roomType ?? null, query.openOnly, query.limit],
      );
      return rows.map((r) => this.toTask(r));
    });
  }

  async setTaskStatus(id: string, body: TaskStatusRequest): Promise<TaskRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.opd_nursing_tasks
            SET status = $3::clinical."OpdTaskStatus",
                hold_reason = COALESCE($4, hold_reason),
                assigned_nurse_id = CASE WHEN $3 = 'in_progress' THEN $5::uuid ELSE assigned_nurse_id END,
                started_at = CASE WHEN $3 = 'in_progress' THEN COALESCE(started_at, now()) ELSE started_at END,
                completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
                updated_at = now()
          WHERE hospital_id = $1 AND id = $2
          RETURNING *, 0::int AS under_observation`,
        [this.hospitalId(), id, body.status, body.reason ?? null, actor],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That task does not exist.');
      return this.toTask(row);
    });
  }

  /**
   * Gives a drug in an OPD room.
   *
   * Everything that can be refused is refused by the database: an expired
   * batch, an unchecked allergy list, a high-alert drug verified by the person
   * giving it, a dose that differs from the one ordered with no reason. What
   * the service adds is the observation window, computed from the request
   * rather than assumed.
   */
  async administer(taskId: string, body: AdministerRequest): Promise<AdministrationRow> {
    return this.guard(async (tx) => {
      const { rows: tasks } = await tx.query<Record<string, unknown>>(
        `SELECT patient_id, encounter_id FROM clinical.opd_nursing_tasks
          WHERE hospital_id = $1 AND id = $2`,
        [this.hospitalId(), taskId],
      );
      const task = tasks[0];
      if (task === undefined) throw AppError.notFound('That task does not exist.');

      if (body.highAlert && body.verifierId === undefined) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          'A high-alert drug is checked by a second person before it is given.',
          { nextAction: 'Ask the nurse at the next chair to verify.' },
        );
      }

      const id = newId();
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.opd_med_administrations
           (id, hospital_id, task_id, patient_id, encounter_id, drug_name, drug_id,
            ordered_dose, given_dose, dose_unit, dose_change_reason, route, site,
            batch_no, expiry, barcode_verified, identity_method, high_alert, verifier_id,
            allergy_checked, started_at, given_by, observation_until, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::clinical."AdminRoute",$13,$14,$15::date,$16,
                 $17::clinical."IdentityMethod",$18,$19,$20, now(), $21,
                 CASE WHEN $22::int > 0 THEN now() + make_interval(mins => $22::int) END, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          taskId,
          asText(task['patient_id']),
          asText(task['encounter_id']),
          body.drugName,
          body.drugId ?? null,
          body.orderedDose,
          body.givenDose,
          body.doseUnit,
          body.doseChangeReason ?? null,
          body.route,
          body.site ?? null,
          body.batchNo ?? null,
          body.expiry ?? null,
          body.barcodeVerified,
          body.identityMethod,
          body.highAlert,
          body.verifierId ?? null,
          body.allergyChecked,
          actor,
          body.observationMinutes,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The administration was not recorded.');

      await tx.query(
        `UPDATE clinical.opd_nursing_tasks
            SET status = (CASE WHEN $2::int > 0 THEN 'observation' ELSE 'completed' END)::clinical."OpdTaskStatus",
                completed_at = CASE WHEN $2::int > 0 THEN completed_at ELSE now() END,
                updated_at = now()
          WHERE id = $1`,
        [taskId, body.observationMinutes],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'opd_med_administration',
        rowId: id,
        businessKey: `${body.drugName} ${String(body.givenDose)} ${body.doseUnit} ${body.route}`,
        dataClass: 'phi',
        patientId: asText(task['patient_id']),
        before: null,
        after: { highAlert: body.highAlert, barcodeVerified: body.barcodeVerified },
      });

      await this.outbox.publish(
        tx,
        procedureEvent('opdnursing.administered', id, {
          administrationId: id,
          taskId,
          patientId: asText(task['patient_id']),
          drugName: body.drugName,
          route: body.route,
          highAlert: body.highAlert,
          secondPersonVerified: body.verifierId !== undefined,
          barcodeVerified: body.barcodeVerified,
        }),
      );

      return this.toAdministration(row);
    });
  }

  /**
   * Closes the watching window.
   *
   * A reaction leaves the module: an allergy recorded only in a nursing note is
   * one the next prescriber never sees.
   */
  async closeObservation(
    administrationId: string,
    body: ObservationOutcomeRequest,
  ): Promise<AdministrationRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.opd_med_administrations
            SET observation_outcome = $3::clinical."ObservationOutcome",
                reaction = COALESCE($4::jsonb, reaction),
                ended_at = COALESCE(ended_at, now()), updated_at = now()
          WHERE hospital_id = $1 AND id = $2 AND observation_outcome IS NULL
          RETURNING *`,
        [
          this.hospitalId(),
          administrationId,
          body.outcome,
          body.reaction === undefined ? null : JSON.stringify(body.reaction),
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That administration does not exist, or its observation is already closed.');
      }

      await tx.query(
        `UPDATE clinical.opd_nursing_tasks SET status = 'completed', completed_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'observation'`,
        [asText(row['task_id'])],
      );

      if (body.outcome === 'reaction') {
        await this.outbox.publish(
          tx,
          procedureEvent('opdnursing.reaction', administrationId, {
            administrationId,
            patientId: asText(row['patient_id']),
            drugName: asText(row['drug_name']),
            outcome: body.outcome,
          }),
        );
      }

      return this.toAdministration(row);
    });
  }

  async recordDressing(taskId: string, body: DressingRequest): Promise<DressingRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.opd_dressings
           (id, hospital_id, task_id, patient_id, wound_id, site, assessment, materials,
            sutures_removed, sutures_retained, infection_signs, next_due_at, recorded_at, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::timestamptz, now(), $13)
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          taskId,
          body.patientId,
          body.woundId ?? null,
          body.site,
          JSON.stringify(body.assessment),
          body.materials === undefined ? null : JSON.stringify(body.materials),
          body.suturesRemoved ?? null,
          body.suturesRetained ?? null,
          body.infectionSigns,
          body.nextDueAt ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The dressing was not recorded.');

      await tx.query(
        `UPDATE clinical.opd_nursing_tasks SET status = 'completed', completed_at = now(), updated_at = now()
          WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`,
        [taskId],
      );

      return this.toDressing(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reading
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * The order, with what is standing between it and the knife.
   *
   * Derived from the same four facts the trigger reads. If this ever disagrees
   * with the trigger, the trigger is right — this is the explanation, not the
   * decision.
   */
  private selectOrder(): string {
    return `SELECT o.*,
                   (o.requires_consent AND o.consent_id IS NULL) AS needs_consent,
                   (o.category = 'invasive'
                     AND NOT EXISTS (SELECT 1 FROM clinical.procedure_timeouts t WHERE t.order_id = o.id))
                     AS needs_timeout,
                   EXISTS (SELECT 1 FROM clinical.procedure_checklists c
                            WHERE c.order_id = o.id AND NOT c.ready
                              AND (c.override_reason IS NULL OR c.override_by IS NULL))
                     AS needs_checklist
              FROM clinical.procedure_orders o`;
  }

  private selectTask(): string {
    return `SELECT t.*,
                   (SELECT count(*) FROM clinical.opd_med_administrations a
                     WHERE a.task_id = t.id AND a.observation_until > now()
                       AND a.observation_outcome IS NULL) AS under_observation
              FROM clinical.opd_nursing_tasks t`;
  }

  private async readOrder(tx: TransactionClient, id: string): Promise<OrderRow> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${this.selectOrder()} WHERE o.hospital_id = $1 AND o.id = $2`,
      [this.hospitalId(), id],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That procedure order does not exist.');
    return this.toOrder(row);
  }

  private toRoom(r: Record<string, unknown>): RoomRow {
    return {
      id: asText(r['id']),
      code: asText(r['code']),
      name: asText(r['name']),
      type: asText(r['type']),
      subStoreId: asTextOrNull(r['sub_store_id']),
      isActive: asBool(r['is_active']),
    };
  }

  private toOrder(r: Record<string, unknown>): OrderRow {
    const blockers: string[] = [];
    if (asBool(r['needs_consent'])) {
      blockers.push('Consent has not been signed. There is no override for this one.');
    }
    if (asBool(r['needs_timeout'])) {
      blockers.push('No time-out has been recorded — two people, five questions.');
    }
    if (asBool(r['needs_checklist'])) {
      blockers.push('The pre-procedure checklist is not complete and has not been overridden.');
    }

    return {
      id: asText(r['id']),
      orderNo: asText(r['order_no']),
      patientId: asText(r['patient_id']),
      encounterId: asText(r['encounter_id']),
      procedureCode: asText(r['procedure_code']),
      procedureName: asText(r['procedure_name']),
      category: asText(r['category']),
      side: asText(r['side']),
      siteText: asTextOrNull(r['site_text']),
      urgency: asText(r['urgency']),
      requiresConsent: asBool(r['requires_consent']),
      consentId: asTextOrNull(r['consent_id']),
      sedationRequested: asBool(r['sedation_requested']),
      status: asText(r['status']),
      sourceModule: asTextOrNull(r['source_module']),
      orderedAt: asText(r['ordered_at']),
      orderedBy: asText(r['ordered_by']),
      blockers,
      readyToStart: blockers.length === 0,
    };
  }

  private toBooking(r: Record<string, unknown>): BookingRow {
    return {
      id: asText(r['id']),
      orderId: asText(r['order_id']),
      roomId: asText(r['room_id']),
      roomName: asTextOrNull(r['room_name']),
      startAt: asText(r['start_at']),
      endAt: asText(r['end_at']),
      status: asText(r['status']),
      doctorId: asTextOrNull(r['doctor_id']),
    };
  }

  private toChecklist(r: Record<string, unknown>): ChecklistRow {
    return {
      id: asText(r['id']),
      templateKey: asText(r['template_key']),
      items: r['items'] ?? [],
      ready: asBool(r['ready']),
      readyAt: asTextOrNull(r['ready_at']),
      overrideReason: asTextOrNull(r['override_reason']),
      overrideBy: asTextOrNull(r['override_by']),
    };
  }

  private toTimeout(r: Record<string, unknown>): TimeoutRow {
    return {
      id: asText(r['id']),
      confirmedBy1: asText(r['confirmed_by_1']),
      confirmedBy2: asText(r['confirmed_by_2']),
      confirmedAt: asText(r['confirmed_at']),
    };
  }

  private toProcedure(r: Record<string, unknown>): ProcedureRow {
    return {
      id: asText(r['id']),
      orderId: asText(r['order_id']),
      patientId: asText(r['patient_id']),
      performedBy: asText(r['performed_by']),
      assistants: asStringArray(r['assistants']),
      anaesthetistId: asTextOrNull(r['anaesthetist_id']),
      startedAt: asText(r['started_at']),
      endedAt: asTextOrNull(r['ended_at']),
      anaesthesia: asText(r['anaesthesia']),
      findings: asTextOrNull(r['findings']),
      technique: asTextOrNull(r['technique']),
      eblMl: asNumberOrNull(r['ebl_ml']),
      specimens: r['specimens'] ?? null,
      complications: r['complications'] ?? null,
      outcome: asTextOrNull(r['outcome']),
      signedAt: asTextOrNull(r['signed_at']),
      signedBy: asTextOrNull(r['signed_by']),
    };
  }

  private toRecovery(r: Record<string, unknown>): RecoveryRow {
    return {
      id: asText(r['id']),
      procedureId: asText(r['procedure_id']),
      aldreteScore: asNumberOrNull(r['aldrete_score']),
      escortName: asTextOrNull(r['escort_name']),
      escortRelationship: asTextOrNull(r['escort_relationship']),
      dischargedAt: asTextOrNull(r['discharged_at']),
      dischargedBy: asTextOrNull(r['discharged_by']),
      instructions: asTextOrNull(r['instructions']),
    };
  }

  private toTask(r: Record<string, unknown>): TaskRow {
    return {
      id: asText(r['id']),
      patientId: asText(r['patient_id']),
      encounterId: asText(r['encounter_id']),
      orderId: asTextOrNull(r['order_id']),
      type: asText(r['type']),
      roomType: asText(r['room_type']),
      roomId: asTextOrNull(r['room_id']),
      dayNo: asNumberOrNull(r['day_no']),
      dayTotal: asNumberOrNull(r['day_total']),
      scheduledAt: asTextOrNull(r['scheduled_at']),
      priority: asText(r['priority']),
      status: asText(r['status']),
      holdReason: asTextOrNull(r['hold_reason']),
      assignedNurseId: asTextOrNull(r['assigned_nurse_id']),
      startedAt: asTextOrNull(r['started_at']),
      completedAt: asTextOrNull(r['completed_at']),
      notes: asTextOrNull(r['notes']),
      underObservation: asNumber(r['under_observation'] ?? 0),
    };
  }

  private toAdministration(r: Record<string, unknown>): AdministrationRow {
    return {
      id: asText(r['id']),
      taskId: asText(r['task_id']),
      patientId: asText(r['patient_id']),
      drugName: asText(r['drug_name']),
      orderedDose: asNumber(r['ordered_dose']),
      givenDose: asNumber(r['given_dose']),
      doseUnit: asText(r['dose_unit']),
      doseChangeReason: asTextOrNull(r['dose_change_reason']),
      route: asText(r['route']),
      site: asTextOrNull(r['site']),
      batchNo: asTextOrNull(r['batch_no']),
      expiry: asTextOrNull(r['expiry']),
      barcodeVerified: asBool(r['barcode_verified']),
      identityMethod: asText(r['identity_method']),
      highAlert: asBool(r['high_alert']),
      verifierId: asTextOrNull(r['verifier_id']),
      startedAt: asText(r['started_at']),
      givenBy: asText(r['given_by']),
      observationUntil: asTextOrNull(r['observation_until']),
      observationOutcome: asTextOrNull(r['observation_outcome']),
    };
  }

  private toDressing(r: Record<string, unknown>): DressingRow {
    return {
      id: asText(r['id']),
      taskId: asText(r['task_id']),
      patientId: asText(r['patient_id']),
      site: asText(r['site']),
      assessment: r['assessment'] ?? {},
      suturesRemoved: asNumberOrNull(r['sutures_removed']),
      suturesRetained: asNumberOrNull(r['sutures_retained']),
      infectionSigns: asBool(r['infection_signs']),
      nextDueAt: asTextOrNull(r['next_due_at']),
      recordedAt: asText(r['recorded_at']),
    };
  }
}
