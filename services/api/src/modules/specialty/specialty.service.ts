import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, validateConsoleTabs, type ConsoleTab } from '@vims/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { getContext } from '../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../core/db/database.service.js';
import { OutboxService } from '../../core/outbox/outbox.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';
import { withSpecialtyErrors } from './specialty.errors.js';
import { specialtyEvent } from './specialty.events.js';
import type {
  AttachRequest,
  CancelOrderRequest,
  ConsoleQuery,
  DeviceOrderQuery,
  DeviceTypeRequest,
  MoveStageRequest,
  OrderDeviceResultRequest,
  PerformRequest,
  RegisterConsoleRequest,
  UpdateConsoleRequest,
  WorklistQuery,
} from './specialty.schemas.js';
import type {
  ConsoleDetail,
  ConsoleRow,
  DeviceOrderRow,
  DeviceTypeRow,
  StageRow,
  WorklistRow,
} from './specialty.types.js';

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
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * OP-025 §0 — the framework thirty consoles are built on.
 *
 * ── The registry is checked twice, for two different readers ────────────────
 *
 * `validateConsoleTabs` runs here so the admin composing a console is told what
 * is wrong in one response listing every problem, rather than being shown the
 * first one the database happened to hit. The trigger runs regardless and is
 * the actual rule — anything holding the connection can write this table, and
 * a console whose tabs do not resolve breaks a whole department's workspace.
 *
 * ── Attaching and reviewing are two people ──────────────────────────────────
 *
 * `review` takes no body. The reviewer is the caller and the moment is now,
 * because a `reviewedBy` field would let the technician who uploaded the scan
 * record the doctor as having seen it — and then the rail of unlooked-at
 * results, the only reason the state exists, would always be empty.
 *
 * ── Moving a stage is one call ──────────────────────────────────────────────
 *
 * Closing the current leg and opening the next is one fact about where the
 * patient is. Two calls would let a dropped connection leave somebody in
 * neither queue, which on a refraction lane means an hour in a chair nobody is
 * watching.
 */
@Injectable()
export class SpecialtyService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
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
    return withSpecialtyErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The registry
  // ═══════════════════════════════════════════════════════════════════════════

  async listConsoles(query: ConsoleQuery): Promise<readonly ConsoleRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.specialty_consoles
          WHERE hospital_id = $1
            AND ($2::boolean IS NOT TRUE OR is_active)
            AND ($3::uuid IS NULL OR $3::uuid = ANY (department_ids))
          ORDER BY sort_order, code`,
        [this.hospitalId(), query.activeOnly, query.departmentId ?? null],
      );
      return rows.map((r) => this.toConsole(r));
    });
  }

  async consoleDetail(code: string): Promise<ConsoleDetail> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.specialty_consoles WHERE hospital_id = $1 AND code = $2`,
        [this.hospitalId(), code],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('No console is registered under that code.');

      const { rows: types } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM mdm.device_result_types WHERE hospital_id = $1 AND console_id = $2 ORDER BY code`,
        [this.hospitalId(), asText(row['id'])],
      );

      return { console: this.toConsole(row), deviceTypes: types.map((t) => this.toDeviceType(t)) };
    });
  }

  async registerConsole(body: RegisterConsoleRequest): Promise<ConsoleRow> {
    this.rejectUnresolvableTabs(body.tabs);

    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO mdm.specialty_consoles (
           id, hospital_id, code, name, module_key, department_ids, tabs,
           worklist_config, billing_links, sort_order, created_at, created_by, updated_at, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7::jsonb,$8::jsonb,$9::jsonb,$10, now(), $11, now(), $11)
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          body.code,
          body.name,
          body.moduleKey,
          body.departmentIds,
          JSON.stringify(body.tabs),
          JSON.stringify(body.worklistConfig ?? {}),
          JSON.stringify(body.billingLinks ?? {}),
          body.sortOrder,
          this.actorId(),
        ],
      );

      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The console was not registered.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'specialty_console',
        rowId: id,
        businessKey: body.code,
        dataClass: 'operational',
        before: null,
        after: { tabs: body.tabs.map((t) => t.key), departments: body.departmentIds.length },
        reasonText: getContext().reason ?? null,
      });

      await this.publishRegistered(tx, row);
      return this.toConsole(row);
    });
  }

  async updateConsole(id: string, body: UpdateConsoleRequest): Promise<ConsoleRow> {
    if (body.tabs !== undefined) this.rejectUnresolvableTabs(body.tabs);

    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE mdm.specialty_consoles
            SET name = COALESCE($3, name),
                department_ids = COALESCE($4::uuid[], department_ids),
                tabs = COALESCE($5::jsonb, tabs),
                worklist_config = COALESCE($6::jsonb, worklist_config),
                billing_links = COALESCE($7::jsonb, billing_links),
                is_active = COALESCE($8::boolean, is_active),
                sort_order = COALESCE($9::int, sort_order),
                updated_at = now(), updated_by = $10
          WHERE hospital_id = $1 AND id = $2
          RETURNING *`,
        [
          this.hospitalId(),
          id,
          body.name ?? null,
          body.departmentIds ?? null,
          body.tabs === undefined ? null : JSON.stringify(body.tabs),
          body.worklistConfig === undefined ? null : JSON.stringify(body.worklistConfig),
          body.billingLinks === undefined ? null : JSON.stringify(body.billingLinks),
          body.isActive ?? null,
          body.sortOrder ?? null,
          this.actorId(),
        ],
      );

      const row = rows[0];
      if (row === undefined) throw AppError.notFound('No console is registered under that id.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'specialty_console',
        rowId: id,
        businessKey: asText(row['code']),
        dataClass: 'operational',
        before: null,
        after: { isActive: asBool(row['is_active']) },
        reasonText: getContext().reason ?? null,
      });

      await this.publishRegistered(tx, row);
      return this.toConsole(row);
    });
  }

  async declareDeviceType(body: DeviceTypeRequest): Promise<DeviceTypeRow> {
    return this.guard(async (tx) => {
      const { rows: consoles } = await tx.query<Record<string, unknown>>(
        `SELECT id FROM mdm.specialty_consoles WHERE hospital_id = $1 AND code = $2`,
        [this.hospitalId(), body.consoleCode],
      );
      const console_ = consoles[0];
      if (console_ === undefined) {
        throw AppError.notFound(
          'No console is registered under that code, so nothing can be declared for it.',
        );
      }

      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO mdm.device_result_types (
           id, hospital_id, code, name, console_id, transport, mime_types,
           parser_key, report_template_key, billing_service_code, review_due_hours, side_required,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::mdm."DeviceResultTransport",$7::text[],$8,$9,$10,$11,$12, now(), now())
         ON CONFLICT (hospital_id, code) DO UPDATE SET
           name = EXCLUDED.name,
           transport = EXCLUDED.transport,
           mime_types = EXCLUDED.mime_types,
           parser_key = EXCLUDED.parser_key,
           report_template_key = EXCLUDED.report_template_key,
           billing_service_code = EXCLUDED.billing_service_code,
           review_due_hours = EXCLUDED.review_due_hours,
           side_required = EXCLUDED.side_required,
           updated_at = now()
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          body.code,
          body.name,
          asText(console_['id']),
          body.transport,
          body.mimeTypes,
          body.parserKey ?? null,
          body.reportTemplateKey ?? null,
          body.billingServiceCode ?? null,
          body.reviewDueHours,
          body.sideRequired,
        ],
      );

      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The device result type was not declared.');
      return this.toDeviceType(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // The shared device path
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Orders an investigation and raises its charge intent in the same transaction.
   *
   * One transaction because F3's second half — cancelling the action voids the
   * intent — is only true if the pair was created atomically. An order that
   * exists without its intent bills nothing; an intent without its order bills
   * for something nobody did.
   */
  async orderDeviceResult(body: OrderDeviceResultRequest): Promise<DeviceOrderRow> {
    return this.guard(async (tx) => {
      const { rows: types } = await tx.query<Record<string, unknown>>(
        `SELECT t.*, c.code AS console_code
           FROM mdm.device_result_types t JOIN mdm.specialty_consoles c ON c.id = t.console_id
          WHERE t.hospital_id = $1 AND t.code = $2 AND t.active`,
        [this.hospitalId(), body.deviceResultTypeCode],
      );
      const type = types[0];
      if (type === undefined) {
        throw AppError.notFound(`${body.deviceResultTypeCode} is not something this hospital can order.`);
      }

      const id = newId();
      const actor = this.actorId();
      const consoleCode = asText(type['console_code']);

      // The intent first, so the order can carry its id and cancelling the one
      // can always find the other.
      let chargeIntentId: string | null = null;
      const serviceCode = asTextOrNull(type['billing_service_code']);
      if (serviceCode !== null) {
        chargeIntentId = newId();
        await tx.query(
          `INSERT INTO billing.charge_intents (
             id, hospital_id, branch_id, patient_id, encounter_id, visit_id,
             source_module, source_table, source_id, service_key, description, qty, currency,
             status, created_at, created_by, updated_at, updated_by
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'specialty.device_orders',$8,$9,$10,1,'INR','pending', now(), $11, now(), $11)`,
          [
            chargeIntentId,
            this.hospitalId(),
            this.branchId(),
            body.patientId,
            body.encounterId,
            body.visitId ?? null,
            consoleCode,
            id,
            body.serviceKey ?? null,
            `${asText(type['name'])}${body.side === 'not_applicable' ? '' : ` (${body.side})`}`,
            actor,
          ],
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO specialty.device_orders (
           id, hospital_id, branch_id, patient_id, encounter_id, visit_id,
           console_code, device_result_type_id, device_result_type_code, side,
           ordered_at, ordered_by, charge_intent_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::clinical."Laterality", now(), $11, $12, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.patientId,
          body.encounterId,
          body.visitId ?? null,
          consoleCode,
          asText(type['id']),
          body.deviceResultTypeCode,
          body.side,
          actor,
          chargeIntentId,
        ],
      );

      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The order was not written.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'device_order',
        rowId: id,
        businessKey: `${consoleCode}/${body.deviceResultTypeCode}`,
        dataClass: 'phi',
        patientId: body.patientId,
        encounterId: body.encounterId,
        before: null,
        after: { side: body.side, chargeIntentId },
      });

      await this.outbox.publish(
        tx,
        specialtyEvent('device.result.ordered', id, {
          orderId: id,
          consoleCode,
          deviceResultTypeCode: body.deviceResultTypeCode,
          patientId: body.patientId,
          encounterId: body.encounterId,
          side: body.side,
          orderedBy: actor,
        }),
      );

      return this.toDeviceOrder({ ...row, device_result_type_name: type['name'] });
    });
  }

  async performDeviceResult(id: string, body: PerformRequest): Promise<DeviceOrderRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.device_orders
            SET status = 'performed',
                performed_at = COALESCE($2::timestamptz, now()), performed_by = $3, updated_at = now()
          WHERE hospital_id = $1 AND id = $4 AND status = 'ordered'
          RETURNING *, (SELECT name FROM mdm.device_result_types t WHERE t.id = device_result_type_id)
                       AS device_result_type_name,
                    (SELECT review_due_hours FROM mdm.device_result_types t WHERE t.id = device_result_type_id)
                       AS review_due_hours`,
        [this.hospitalId(), body.performedAt ?? null, this.actorId(), id],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That order does not exist, or it has already been performed or cancelled.');
      }
      return this.toDeviceOrder(row);
    });
  }

  /** Attaches what arrived, and leaves it unreviewed. */
  async attachDeviceResult(id: string, body: AttachRequest): Promise<DeviceOrderRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.device_orders
            SET status = 'attached', attached_at = now(),
                performed_at = COALESCE(performed_at, now()),
                performed_by = COALESCE(performed_by, $2),
                result_file_id = COALESCE($3::uuid, result_file_id),
                pacs_study_uid = COALESCE($4, pacs_study_uid),
                parsed = COALESCE($5::jsonb, parsed),
                updated_at = now()
          WHERE hospital_id = $1 AND id = $6 AND status IN ('ordered', 'performed', 'attached')
          RETURNING *, (SELECT name FROM mdm.device_result_types t WHERE t.id = device_result_type_id)
                       AS device_result_type_name,
                    (SELECT review_due_hours FROM mdm.device_result_types t WHERE t.id = device_result_type_id)
                       AS review_due_hours`,
        [
          this.hospitalId(),
          this.actorId(),
          body.resultFileId ?? null,
          body.pacsStudyUid ?? null,
          body.parsed === undefined ? null : JSON.stringify(body.parsed),
          id,
        ],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That order does not exist, or it was cancelled.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'device_order',
        rowId: id,
        businessKey: `${asText(row['device_result_type_code'])} attached`,
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        before: null,
        after: { viaPacs: row['pacs_study_uid'] !== null, parsed: row['parsed'] !== null },
      });

      await this.outbox.publish(
        tx,
        specialtyEvent('device.result.attached', id, {
          orderId: id,
          consoleCode: asText(row['console_code']),
          deviceResultTypeCode: asText(row['device_result_type_code']),
          patientId: asText(row['patient_id']),
          encounterId: asText(row['encounter_id']),
          hasParsedValues: row['parsed'] !== null,
          viaPacs: row['pacs_study_uid'] !== null,
        }),
      );

      return this.toDeviceOrder(row);
    });
  }

  /**
   * A clinician says they saw it.
   *
   * No body: the reviewer is whoever called and the moment is now. The database
   * refuses a review before anything is attached, and refuses to un-review.
   */
  async reviewDeviceResult(id: string): Promise<DeviceOrderRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.device_orders
            SET reviewed_at = now(), reviewed_by = $2, updated_at = now()
          WHERE hospital_id = $1 AND id = $3 AND reviewed_at IS NULL
          RETURNING *,
            (SELECT name FROM mdm.device_result_types t WHERE t.id = device_result_type_id)
              AS device_result_type_name,
            GREATEST(0, round(extract(epoch FROM now() - COALESCE(attached_at, ordered_at)) / 60))::int
              AS minutes_unreviewed`,
        [this.hospitalId(), actor, id],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That result does not exist, or somebody has already reviewed it.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'device_order',
        rowId: id,
        businessKey: `${asText(row['device_result_type_code'])} reviewed`,
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        before: null,
        after: { minutesUnreviewed: asNumber(row['minutes_unreviewed']) },
      });

      await this.outbox.publish(
        tx,
        specialtyEvent('device.result.reviewed', id, {
          orderId: id,
          consoleCode: asText(row['console_code']),
          deviceResultTypeCode: asText(row['device_result_type_code']),
          patientId: asText(row['patient_id']),
          reviewedBy: actor,
          minutesUnreviewed: asNumber(row['minutes_unreviewed']),
        }),
      );

      return this.toDeviceOrder(row);
    });
  }

  /**
   * Cancels an order and voids its charge if it has not reached a bill.
   *
   * If it has, the database refuses the void and says so — the charge is
   * reversed by billing with a credit note, and this call fails rather than
   * leaving the order cancelled and the bill still standing.
   */
  async cancelDeviceOrder(id: string, body: CancelOrderRequest): Promise<DeviceOrderRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE specialty.device_orders
            SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now()
          WHERE hospital_id = $1 AND id = $3 AND status <> 'cancelled' AND reviewed_at IS NULL
          RETURNING *, (SELECT name FROM mdm.device_result_types t WHERE t.id = device_result_type_id)
                       AS device_result_type_name`,
        [this.hospitalId(), body.reason, id],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'That order does not exist, is already cancelled, or has been reviewed — a result somebody has read is part of the record.',
        );
      }

      const intentId = asTextOrNull(row['charge_intent_id']);
      if (intentId !== null) {
        await tx.query(
          `UPDATE billing.charge_intents
              SET status = 'cancelled', reversal_reason = $2, updated_at = now(), version = version + 1
            WHERE id = $1 AND status = 'pending'`,
          [intentId, body.reason],
        );
      }

      await this.audit.write(tx, {
        action: 'delete',
        entity: 'device_order',
        rowId: id,
        businessKey: asText(row['device_result_type_code']),
        dataClass: 'phi',
        patientId: asText(row['patient_id']),
        before: { status: 'ordered' },
        after: { status: 'cancelled', chargeIntentVoided: intentId !== null },
        reasonText: body.reason,
      });

      return this.toDeviceOrder(row);
    });
  }

  async listDeviceOrders(query: DeviceOrderQuery): Promise<readonly DeviceOrderRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectDeviceOrder()}
          WHERE o.hospital_id = $1
            AND ($2::uuid IS NULL OR o.encounter_id = $2::uuid)
            AND ($3::text IS NULL OR o.console_code = $3::text)
            AND ($4::boolean IS NOT TRUE OR (o.status = 'attached' AND o.reviewed_at IS NULL))
          ORDER BY (o.status = 'attached' AND o.reviewed_at IS NULL) DESC, o.ordered_at DESC
          LIMIT $5`,
        [
          this.hospitalId(),
          query.encounterId ?? null,
          query.consoleCode ?? null,
          query.unreviewedOnly,
          query.limit,
        ],
      );
      return rows.map((r) => this.toDeviceOrder(r));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stages and the worklist
  // ═══════════════════════════════════════════════════════════════════════════

  /** Closes whatever leg is open for this encounter and opens the next. */
  async moveStage(body: MoveStageRequest): Promise<StageRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();

      const { rows: closed } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.encounter_stages
            SET ended_at = now(), ended_by = $2, updated_at = now()
          WHERE encounter_id = $1 AND ended_at IS NULL
          RETURNING stage_key,
                    round(extract(epoch FROM now() - started_at) / 60)::int AS minutes`,
        [body.encounterId, actor],
      );
      const previous = closed[0];

      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.encounter_stages (
           id, hospital_id, branch_id, encounter_id, patient_id, console_code, stage_key,
           queue_definition_id, started_at, started_by, note, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now(), $9, $10, now(), now())
         RETURNING *, round(extract(epoch FROM now() - started_at) / 60)::int AS minutes`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.encounterId,
          body.patientId,
          body.consoleCode,
          body.stageKey,
          body.queueDefinitionId ?? null,
          actor,
          body.note ?? null,
        ],
      );

      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The stage was not opened.');

      await this.outbox.publish(
        tx,
        specialtyEvent('encounter.stage.moved', id, {
          encounterId: body.encounterId,
          patientId: body.patientId,
          consoleCode: body.consoleCode,
          fromStage: previous === undefined ? null : asText(previous['stage_key']),
          toStage: body.stageKey,
          minutesInPreviousStage: previous === undefined ? null : asNumber(previous['minutes']),
        }),
      );

      return this.toStage(row);
    });
  }

  async stagesFor(encounterId: string): Promise<readonly StageRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT *, round(extract(epoch FROM COALESCE(ended_at, now()) - started_at) / 60)::int AS minutes
           FROM clinical.encounter_stages
          WHERE hospital_id = $1 AND encounter_id = $2
          ORDER BY started_at`,
        [this.hospitalId(), encounterId],
      );
      return rows.map((r) => this.toStage(r));
    });
  }

  /**
   * The console's worklist.
   *
   * Pending and unreviewed results are counted separately because they are
   * different problems: a scan not yet done is a scheduling one, a scan sitting
   * unlooked-at is a clinical one, and a single "results" chip hides whichever
   * is the smaller number that day.
   *
   * The join to `patient.patients` is an inner one deliberately. Row-level
   * security hides a patient from a branch that may not see them, and an outer
   * join would leave their stage on the list with a blank name — a row somebody
   * would click, and then ask about.
   */
  async worklist(query: WorklistQuery): Promise<readonly WorklistRow[]> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT s.encounter_id, s.patient_id,
                p.full_name AS patient_name, p.uhid,
                s.stage_key, s.started_at AS stage_started_at,
                round(extract(epoch FROM now() - s.started_at) / 60)::int AS minutes_in_stage,
                t.token_display,
                (SELECT count(*) FROM specialty.device_orders d
                  WHERE d.encounter_id = s.encounter_id AND d.status IN ('ordered','performed')) AS pending_results,
                (SELECT count(*) FROM specialty.device_orders d
                  WHERE d.encounter_id = s.encounter_id AND d.status = 'attached'
                    AND d.reviewed_at IS NULL) AS unreviewed_results
           FROM clinical.encounter_stages s
           JOIN patient.patients p ON p.id = s.patient_id
           LEFT JOIN LATERAL (
             SELECT token_display FROM queue.queue_tokens q
              WHERE q.patient_id = s.patient_id AND q.series_date = current_date
              ORDER BY q.token_no DESC LIMIT 1
           ) t ON TRUE
          WHERE s.hospital_id = $1
            AND s.console_code = $2
            AND ($3::text IS NULL OR s.stage_key = $3::text)
            AND ($4::boolean IS NOT TRUE OR s.ended_at IS NULL)
          ORDER BY s.started_at
          LIMIT $5`,
        [this.hospitalId(), query.consoleCode, query.stageKey ?? null, query.openOnly, query.limit],
      );

      return rows.map((r) => ({
        encounterId: asText(r['encounter_id']),
        patientId: asText(r['patient_id']),
        patientName: asText(r['patient_name']),
        uhid: asText(r['uhid']),
        stageKey: asTextOrNull(r['stage_key']),
        stageStartedAt: asTextOrNull(r['stage_started_at']),
        minutesInStage: asNumberOrNull(r['minutes_in_stage']),
        tokenDisplay: asTextOrNull(r['token_display']),
        pendingResults: asNumber(r['pending_results'] ?? 0),
        unreviewedResults: asNumber(r['unreviewed_results'] ?? 0),
      }));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reports every unresolvable tab at once.
   *
   * The trigger stops at the first problem, which is right for a rule and wrong
   * for a form: an admin composing an eight-tab console should not discover the
   * mistakes one save at a time.
   */
  private rejectUnresolvableTabs(tabs: readonly ConsoleTab[]): void {
    const problems = validateConsoleTabs(tabs);
    if (problems.length > 0) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `This console cannot be registered as written: ${problems.join(' ')}`,
        { nextAction: 'A console is composed from components this build ships; it cannot invent one.' },
      );
    }
  }

  private async publishRegistered(tx: TransactionClient, row: Record<string, unknown>): Promise<void> {
    const tabs = Array.isArray(row['tabs']) ? (row['tabs'] as unknown[]) : [];
    await this.outbox.publish(
      tx,
      specialtyEvent('console.registered', asText(row['id']), {
        consoleId: asText(row['id']),
        code: asText(row['code']),
        moduleKey: asText(row['module_key']),
        departmentIds: asStringArray(row['department_ids']),
        tabCount: tabs.length,
        isActive: asBool(row['is_active']),
      }),
    );
  }

  private selectDeviceOrder(): string {
    return `SELECT o.*, t.name AS device_result_type_name, t.review_due_hours,
                   CASE WHEN o.attached_at IS NULL OR o.reviewed_at IS NOT NULL THEN NULL
                        ELSE round(extract(epoch FROM now() - o.attached_at) / 60)::int END AS minutes_unreviewed
              FROM specialty.device_orders o
              LEFT JOIN mdm.device_result_types t ON t.id = o.device_result_type_id`;
  }

  private toConsole(r: Record<string, unknown>): ConsoleRow {
    return {
      id: asText(r['id']),
      code: asText(r['code']),
      name: asText(r['name']),
      moduleKey: asText(r['module_key']),
      departmentIds: asStringArray(r['department_ids']),
      tabs: Array.isArray(r['tabs']) ? (r['tabs'] as ConsoleTab[]) : [],
      worklistConfig: asRecord(r['worklist_config']),
      billingLinks: asRecord(r['billing_links']),
      isActive: asBool(r['is_active']),
      sortOrder: asNumber(r['sort_order'] ?? 0),
    };
  }

  private toDeviceType(r: Record<string, unknown>): DeviceTypeRow {
    return {
      id: asText(r['id']),
      code: asText(r['code']),
      name: asText(r['name']),
      consoleId: asText(r['console_id']),
      transport: asText(r['transport']),
      mimeTypes: asStringArray(r['mime_types']),
      parserKey: asTextOrNull(r['parser_key']),
      reportTemplateKey: asTextOrNull(r['report_template_key']),
      billingServiceCode: asTextOrNull(r['billing_service_code']),
      reviewDueHours: asNumber(r['review_due_hours'] ?? 4),
      sideRequired: asBool(r['side_required']),
      active: asBool(r['active']),
    };
  }

  private toDeviceOrder(r: Record<string, unknown>): DeviceOrderRow {
    const minutes = asNumberOrNull(r['minutes_unreviewed']);
    const dueHours = asNumberOrNull(r['review_due_hours']);
    return {
      id: asText(r['id']),
      patientId: asText(r['patient_id']),
      encounterId: asText(r['encounter_id']),
      consoleCode: asText(r['console_code']),
      deviceResultTypeCode: asText(r['device_result_type_code']),
      deviceResultTypeName: asTextOrNull(r['device_result_type_name']),
      side: asText(r['side']),
      status: asText(r['status']),
      orderedAt: asText(r['ordered_at']),
      orderedBy: asText(r['ordered_by']),
      performedAt: asTextOrNull(r['performed_at']),
      attachedAt: asTextOrNull(r['attached_at']),
      resultFileId: asTextOrNull(r['result_file_id']),
      pacsStudyUid: asTextOrNull(r['pacs_study_uid']),
      parsed: r['parsed'] ?? null,
      reviewedAt: asTextOrNull(r['reviewed_at']),
      reviewedBy: asTextOrNull(r['reviewed_by']),
      cancelReason: asTextOrNull(r['cancel_reason']),
      chargeIntentId: asTextOrNull(r['charge_intent_id']),
      minutesUnreviewed: minutes,
      reviewOverdue: minutes !== null && dueHours !== null && minutes > dueHours * 60,
    };
  }

  private toStage(r: Record<string, unknown>): StageRow {
    return {
      id: asText(r['id']),
      encounterId: asText(r['encounter_id']),
      patientId: asText(r['patient_id']),
      consoleCode: asText(r['console_code']),
      stageKey: asText(r['stage_key']),
      queueDefinitionId: asTextOrNull(r['queue_definition_id']),
      startedAt: asText(r['started_at']),
      endedAt: asTextOrNull(r['ended_at']),
      minutes: asNumber(r['minutes'] ?? 0),
      open: r['ended_at'] === null || r['ended_at'] === undefined,
    };
  }
}
