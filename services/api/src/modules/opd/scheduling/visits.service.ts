import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import type {
  CancelVisitRequest,
  CloseVisitRequest,
  CreateVisitRequest,
  ListVisitsQuery,
  TransferVisitRequest,
} from './dto/scheduling.dto.js';
import { QueueTokensService } from './queue-tokens.service.js';
import { branchTimeZone, branchToday, mapConstraints, requireBranch } from './scheduling.common.js';
import { schedulingEvent } from './scheduling.events.js';

/**
 * OP-001 §3.5 — the OP visit, and the token that comes with it.
 *
 * Two rules shape this file:
 *
 *  - **A visit and its token are one transaction.** `openVisit` allocates the
 *    `OP_VISIT` number, writes the visit, issues the queue token and publishes
 *    both events on the caller's `tx`. A visit with no token is a patient nobody
 *    calls; a token with no visit is a number nobody can explain.
 *  - **A visit cannot be cancelled once the consultation has started**
 *    (OP-001 §5). After that the money has moved and the correction is a billing
 *    reversal, not a disappearing visit, so the route refuses rather than
 *    quietly doing something adjacent.
 *
 * Every mutation writes **one audit row per mutated row** and its registered
 * outbox event inside the same transaction (EN-024 §5), and no query carries a
 * `hospital_id` predicate — isolation is row-level security, which is why a
 * cross-tenant id reads as 404 rather than 403 (`docs/09` §3.1 case 2).
 */

const RESOURCE = 'opd.visits';

export interface VisitListItem {
  readonly id: string;
  readonly visit_no: string;
  readonly patient_id: string;
  readonly appointment_id: string | null;
  readonly practitioner_key: string | null;
  readonly department_key: string | null;
  readonly visit_type: string;
  readonly payer_type: string;
  readonly status: string;
  readonly token_id: string | null;
  readonly token_display: string | null;
  readonly queue_id: string | null;
  readonly vitals_required: boolean;
  readonly source_channel: string;
  readonly checked_in_at: Date;
  readonly consult_started_at: Date | null;
  readonly closed_at: Date | null;
  readonly cancelled_at: Date | null;
}

export interface VisitDetail extends VisitListItem {
  readonly cancel_reason: string | null;
  readonly notes: string | null;
  readonly version: number;
}

/** Everything `openVisit` needs, whether it came from a walk-in or a check-in. */
export interface OpenVisitInput {
  readonly branchId: string;
  readonly patientId: string;
  readonly practitionerKey: string;
  readonly departmentKey: string | null;
  readonly specialityKey: string | null;
  readonly consultTypeKey: string | null;
  readonly roomKey: string | null;
  readonly appointmentId: string | null;
  readonly appointmentDueAt: Date | null;
  readonly visitType: string;
  readonly payerType: string;
  readonly sourceChannel: string;
  readonly queueId: string | undefined;
  readonly notes: string | null;
  readonly idempotencyKey: string | null;
}

export interface OpenedVisit {
  readonly visitId: string;
  readonly visitNo: string;
  readonly tokenId: string;
  readonly tokenDisplay: string;
  readonly queueId: string;
  readonly status: string;
}

interface PatientRow {
  readonly id: string;
  readonly uhid: string;
  readonly status: string;
  readonly is_vip: boolean;
  readonly is_staff: boolean;
  readonly is_pregnant: boolean;
  readonly is_differently_abled: boolean;
  readonly age_years: number | null;
}

@Injectable()
export class VisitsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(QueueTokensService) private readonly tokens: QueueTokensService,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  async list(query: ListVisitsQuery): Promise<Page<VisitListItem>> {
    const branchId = requireBranch();
    const hospitalId = getContext().hospitalId ?? '';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource: RESOURCE });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const timeZone = await branchTimeZone(tx, branchId);

      const where: string[] = ['v.branch_id = $1::uuid'];
      const values: unknown[] = [branchId];
      const bind = (value: unknown): string => `$${values.push(value)}`;

      if (query.doctor !== undefined) where.push(`v.practitioner_key = ${bind(query.doctor)}::uuid`);
      if (query.patientId !== undefined) where.push(`v.patient_id = ${bind(query.patientId)}::uuid`);
      if (query.status !== undefined) where.push(`v.status = ${bind(query.status)}::clinical."VisitStatus"`);
      if (query.date !== undefined) {
        // Half-open on the *instant* rather than a cast of `checked_in_at`, so
        // the branch index on (…, checked_in_at) is usable and "today" means the
        // branch's today rather than the server's.
        const day = bind(query.date);
        const tz = bind(timeZone);
        where.push(
          `v.checked_in_at >= (${day}::date + time '00:00') AT TIME ZONE ${tz}`,
          `v.checked_in_at <  (${day}::date + 1 + time '00:00') AT TIME ZONE ${tz}`,
        );
      }
      if (after !== null) {
        where.push(`(v.checked_in_at, v.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }

      const fetched = await tx.rows<VisitListItem & { cursor_key: string }>(
        `SELECT v.id, v.visit_no, v.patient_id, v.appointment_id, v.practitioner_key, v.department_key,
                v.visit_type::text AS visit_type, v.payer_type::text AS payer_type,
                v.status::text AS status, v.token_id, v.token_display, v.queue_id,
                v.vitals_required, v.source_channel::text AS source_channel,
                v.checked_in_at, v.consult_started_at, v.closed_at, v.cancelled_at,
                v.checked_in_at::text AS cursor_key
           FROM clinical.op_visits v
          WHERE ${where.join(' AND ')}
          ORDER BY v.checked_in_at DESC, v.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      return this.cursors.keysetPage<VisitListItem>(fetched, limit, {
        hospitalId,
        resource: RESOURCE,
        direction: 'desc',
      });
    });
  }

  async get(id: string): Promise<VisitDetail> {
    return this.db.withTenant(currentTenantContext(), async (tx) => this.loadVisit(tx, id));
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /** `POST /visits` — the walk-in path (OP-001 §3.5.3). */
  async createWalkIn(body: CreateVisitRequest, idempotencyKey: string | null): Promise<VisitDetail> {
    const branchId = requireBranch();

    const visitId = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const replay = await this.findReplay(tx, idempotencyKey);
      if (replay !== null) return replay;

      const opened = await this.openVisit(tx, {
        branchId,
        patientId: body.patientId,
        practitionerKey: body.practitionerKey,
        departmentKey: body.departmentKey ?? null,
        specialityKey: body.specialityKey ?? null,
        consultTypeKey: body.consultTypeKey ?? null,
        roomKey: body.roomKey ?? null,
        appointmentId: null,
        appointmentDueAt: null,
        visitType: body.visitType,
        payerType: body.payerType,
        sourceChannel: body.sourceChannel,
        queueId: body.queueId,
        notes: body.notes ?? null,
        idempotencyKey,
      });
      return opened.visitId;
    });

    return this.get(visitId);
  }

  /**
   * Creates the visit, issues the token and announces both.
   *
   * Called by `POST /visits` and by `POST /appointments/{id}/check-in`, always on
   * the caller's transaction so that neither half can commit without the other.
   */
  async openVisit(tx: TransactionClient, input: OpenVisitInput): Promise<OpenedVisit> {
    const ctx = getContext();
    const patient = await this.loadPatient(tx, input.patientId);
    const timeZone = await branchTimeZone(tx, input.branchId);
    const seriesDate = await branchToday(tx, timeZone);

    const queue = await this.tokens.resolveQueue(tx, input.branchId, input.practitionerKey, input.queueId);

    const vitals = await tx.maybeOne<{ required: boolean | null }>(
      `SELECT bool_or(t.vitals_required) AS required
         FROM clinical.doctor_schedule_templates t
        WHERE t.practitioner_key = $1::uuid AND t.branch_id = $2::uuid
          AND t.status = 'published' AND t.deleted_at IS NULL`,
      [input.practitionerKey, input.branchId],
    );
    const vitalsRequired = vitals?.required === true;

    // The visit number is allocated inside this transaction, so a check-in that
    // fails afterwards gives the number back instead of burning it.
    const allocation = await this.numbering.allocate(tx, {
      key: 'OP_VISIT',
      branchId: input.branchId,
      refType: 'clinical.op_visits',
    });

    const visitId = newId();
    const status = vitalsRequired ? 'waiting_vitals' : 'waiting_doctor';

    const token = await this.tokens.issue(tx, {
      branchId: input.branchId,
      queue,
      seriesDate,
      patientId: patient.id,
      visitId,
      appointmentId: input.appointmentId,
      practitionerKey: input.practitionerKey,
      roomKey: input.roomKey,
      source: input.sourceChannel === 'kiosk' ? 'kiosk' : 'desk',
      priority: {
        fromAppointment: input.appointmentId !== null,
        emergency: input.visitType === 'emergency_opd',
        ageYears: patient.age_years,
        isDifferentlyAbled: patient.is_differently_abled,
        isPregnant: patient.is_pregnant,
        isStaff: patient.is_staff,
        isVip: patient.is_vip,
      },
      appointmentDueAt: input.appointmentDueAt,
    });

    await mapConstraints(async () =>
      tx.query(
        `INSERT INTO clinical.op_visits (
           id, hospital_id, branch_id, visit_no, patient_id, appointment_id,
           practitioner_key, department_key, speciality_key, consult_type_key, room_key,
           visit_type, payer_type, status, token_id, token_display, queue_id,
           vitals_required, source_channel, notes, idempotency_key,
           created_by, updated_by, updated_at
         ) VALUES (
           $1, $2, $3::uuid, $4, $5::uuid, $6::uuid,
           $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid,
           $12::clinical."VisitType", $13::clinical."VisitPayerType", $14::clinical."VisitStatus",
           $15::uuid, $16, $17::uuid,
           $18, $19::clinical."AppointmentChannel", $20, $21,
           $22, $22, now()
         )`,
        [
          visitId,
          ctx.hospitalId,
          input.branchId,
          allocation.formatted,
          patient.id,
          input.appointmentId,
          input.practitionerKey,
          input.departmentKey,
          input.specialityKey,
          input.consultTypeKey,
          input.roomKey ?? queue.room_key,
          input.visitType,
          input.payerType,
          status,
          token.id,
          token.tokenDisplay,
          queue.id,
          vitalsRequired,
          input.sourceChannel,
          input.notes,
          input.idempotencyKey,
          ctx.userId,
        ],
      ),
    );

    await this.audit.write(tx, {
      action: 'insert',
      entity: 'clinical.op_visits',
      rowId: visitId,
      businessKey: allocation.formatted,
      dataClass: 'phi',
      patientId: patient.id,
      encounterId: visitId,
      before: null,
      after: {
        visit_no: allocation.formatted,
        practitioner_key: input.practitionerKey,
        visit_type: input.visitType,
        payer_type: input.payerType,
        status,
        token_display: token.tokenDisplay,
        appointment_id: input.appointmentId,
        source_channel: input.sourceChannel,
      },
    });

    await this.outbox.publish(
      tx,
      schedulingEvent('visit.checked_in', visitId, {
        visitId,
        patientId: patient.id,
        doctorId: input.practitionerKey,
        departmentId: input.departmentKey,
        tokenNo: token.tokenDisplay,
        branchId: input.branchId,
      }),
    );

    return {
      visitId,
      visitNo: allocation.formatted,
      tokenId: token.id,
      tokenDisplay: token.tokenDisplay,
      queueId: queue.id,
      status,
    };
  }

  /** `PATCH /visits/{id}/cancel` — refused once the consultation has started. */
  async cancel(id: string, body: CancelVisitRequest): Promise<VisitDetail> {
    const branchId = requireBranch();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const visit = await this.lockVisit(tx, id);

      if (visit.consult_started_at !== null) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'This consultation has already started, so the visit cannot be cancelled (OP-001 §5).',
          {
            nextAction: 'Use the billing reversal path to correct the charge instead.',
            clinicalImpact: 'The clinical record of a started consultation must survive the correction.',
          },
        );
      }
      if (visit.status === 'cancelled' || visit.status === 'closed') {
        throw new AppError(ProblemType.ALREADY_DECIDED, `This visit is already ${visit.status}.`);
      }

      await tx.query(
        `UPDATE clinical.op_visits
            SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2,
                updated_at = now(), updated_by = $3, version = version + 1
          WHERE id = $1::uuid`,
        [id, body.reason, getContext().userId],
      );

      if (visit.token_id !== null) {
        await this.tokens.cancel(tx, visit.token_id, branchId, body.reason);
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.op_visits',
        rowId: id,
        businessKey: visit.visit_no,
        dataClass: 'phi',
        patientId: visit.patient_id,
        encounterId: id,
        before: { status: visit.status },
        after: { status: 'cancelled' },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        schedulingEvent('visit.cancelled', id, { visitId: id, reason: body.reason }),
      );
    });

    return this.get(id);
  }

  /**
   * `PATCH /visits/{id}/transfer` — OP-001 §3.5.4.
   *
   * The visit keeps its number and its history and moves to the new doctor; the
   * token moves with it, as a *new* number in the destination queue, because two
   * queues have independent series and reusing the old display value would have
   * two boards calling the same number.
   *
   * The event registry in `packages/contracts` has no `visit.transferred`, so
   * what is published is `queue.token.transferred`, which is registered and
   * carries the from/to queues and the reason. Inventing an event type here
   * would produce a row nothing is subscribed to; adding one to the registry is
   * a change to a package this module does not own.
   */
  async transfer(id: string, body: TransferVisitRequest): Promise<VisitDetail> {
    const branchId = requireBranch();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const visit = await this.lockVisit(tx, id);

      if (visit.status === 'cancelled' || visit.status === 'closed') {
        throw new AppError(ProblemType.ALREADY_DECIDED, `This visit is already ${visit.status}.`);
      }
      if (visit.practitioner_key === body.practitionerKey) {
        throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, 'The visit is already with that doctor.');
      }

      const patient = await this.loadPatient(tx, visit.patient_id);
      const timeZone = await branchTimeZone(tx, branchId);
      const seriesDate = await branchToday(tx, timeZone);
      const queue = await this.tokens.resolveQueue(tx, branchId, body.practitionerKey, body.queueId);

      let tokenId = visit.token_id;
      let tokenDisplay = visit.token_display;
      if (visit.token_id !== null) {
        const moved = await this.tokens.transfer(tx, {
          fromTokenId: visit.token_id,
          branchId,
          queue,
          seriesDate,
          patientId: visit.patient_id,
          visitId: id,
          appointmentId: visit.appointment_id,
          practitionerKey: body.practitionerKey,
          roomKey: null,
          source: 'desk',
          priority: {
            fromAppointment: visit.appointment_id !== null,
            emergency: visit.visit_type === 'emergency_opd',
            ageYears: patient.age_years,
            isDifferentlyAbled: patient.is_differently_abled,
            isPregnant: patient.is_pregnant,
            isStaff: patient.is_staff,
            isVip: patient.is_vip,
          },
          reason: body.reason,
        });
        tokenId = moved.id;
        tokenDisplay = moved.tokenDisplay;
      }

      await tx.query(
        `UPDATE clinical.op_visits
            SET practitioner_key = $2::uuid,
                department_key = COALESCE($3::uuid, department_key),
                speciality_key = COALESCE($4::uuid, speciality_key),
                queue_id = $5::uuid, token_id = $6::uuid, token_display = $7,
                updated_at = now(), updated_by = $8, version = version + 1
          WHERE id = $1::uuid`,
        [
          id,
          body.practitionerKey,
          body.departmentKey ?? null,
          body.specialityKey ?? null,
          queue.id,
          tokenId,
          tokenDisplay,
          getContext().userId,
        ],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.op_visits',
        rowId: id,
        businessKey: visit.visit_no,
        dataClass: 'phi',
        patientId: visit.patient_id,
        encounterId: id,
        before: { practitioner_key: visit.practitioner_key, token_display: visit.token_display },
        after: { practitioner_key: body.practitionerKey, token_display: tokenDisplay },
        reasonText: body.reason,
      });
    });

    return this.get(id);
  }

  /** `PATCH /visits/{id}/close`. */
  async close(id: string, body: CloseVisitRequest): Promise<VisitDetail> {
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const visit = await this.lockVisit(tx, id);

      if (visit.status === 'closed') {
        throw new AppError(ProblemType.ALREADY_DECIDED, 'This visit is already closed.');
      }
      if (visit.status === 'cancelled') {
        throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, 'A cancelled visit cannot be closed.');
      }

      const closed = await tx.one<{ closed_at: Date }>(
        `UPDATE clinical.op_visits
            SET status = 'closed', closed_at = now(),
                consult_ended_at = COALESCE(consult_ended_at, now()),
                notes = COALESCE($2, notes),
                updated_at = now(), updated_by = $3, version = version + 1
          WHERE id = $1::uuid
          RETURNING closed_at`,
        [id, body.note ?? null, getContext().userId],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.op_visits',
        rowId: id,
        businessKey: visit.visit_no,
        dataClass: 'phi',
        patientId: visit.patient_id,
        encounterId: id,
        before: { status: visit.status },
        after: { status: 'closed' },
      });

      await this.outbox.publish(
        tx,
        schedulingEvent('visit.closed', id, {
          visitId: id,
          closedAt: closed.closed_at.toISOString(),
          // `false`: a human pressed the button. The 24-hour auto-close in
          // OP-001 §5 is a scheduled job and will publish this with `true`.
          automatic: false,
        }),
      );
    });

    return this.get(id);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async loadVisit(tx: TransactionClient, id: string): Promise<VisitDetail> {
    const visit = await tx.maybeOne<VisitDetail>(
      `SELECT v.id, v.visit_no, v.patient_id, v.appointment_id, v.practitioner_key, v.department_key,
              v.visit_type::text AS visit_type, v.payer_type::text AS payer_type,
              v.status::text AS status, v.token_id, v.token_display, v.queue_id,
              v.vitals_required, v.source_channel::text AS source_channel,
              v.checked_in_at, v.consult_started_at, v.closed_at, v.cancelled_at,
              v.cancel_reason, v.notes, v.version
         FROM clinical.op_visits v
        WHERE v.id = $1::uuid`,
      [id],
    );
    // Another tenant's visit was filtered out by RLS, so it arrives here as
    // absent and leaves as 404 — never 403, which would confirm it exists.
    if (visit === undefined) throw AppError.notFound('The visit');
    return visit;
  }

  private async lockVisit(tx: TransactionClient, id: string): Promise<VisitDetail> {
    const locked = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM clinical.op_visits WHERE id = $1::uuid FOR UPDATE`,
      [id],
    );
    if (locked === undefined) throw AppError.notFound('The visit');
    return this.loadVisit(tx, id);
  }

  private async loadPatient(tx: TransactionClient, patientId: string): Promise<PatientRow> {
    const patient = await tx.maybeOne<PatientRow>(
      `SELECT p.id, p.uhid, p.status::text AS status, p.is_vip, p.is_staff, p.is_pregnant,
              p.is_differently_abled,
              COALESCE(p.age_years, CASE WHEN p.dob IS NULL THEN NULL
                                         ELSE EXTRACT(YEAR FROM age(p.dob))::int END) AS age_years
         FROM patient.patients p
        WHERE p.id = $1::uuid AND p.deleted_at IS NULL`,
      [patientId],
    );
    if (patient === undefined) throw AppError.notFound('The patient');

    if (patient.status === 'merged') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'This record was merged into another patient. Open the surviving record instead.',
      );
    }
    if (patient.status === 'blocked') {
      throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, 'This patient record is blocked.');
    }
    return patient;
  }

  /** Returns the visit a retried request already created, if any. */
  private async findReplay(tx: TransactionClient, key: string | null): Promise<string | null> {
    if (key === null) return null;
    const existing = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM clinical.op_visits WHERE idempotency_key = $1`,
      [key],
    );
    return existing?.id ?? null;
  }
}
