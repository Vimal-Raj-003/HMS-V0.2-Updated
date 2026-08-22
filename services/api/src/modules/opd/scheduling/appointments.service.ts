import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import type {
  BookAppointmentRequest,
  CancelAppointmentRequest,
  CheckInRequest,
  ConfirmAppointmentRequest,
  ListAppointmentsQuery,
  RescheduleAppointmentRequest,
} from './dto/scheduling.dto.js';
import { mapConstraints, requireBranch } from './scheduling.common.js';
import { schedulingEvent } from './scheduling.events.js';
import { VisitsService, type OpenedVisit } from './visits.service.js';

/**
 * OP-001 §3.4 — booking, confirming, rescheduling, cancelling and checking in.
 *
 * The property this file exists to guarantee is the one OP-001 §5 states in six
 * words — "slot capacity enforced with row lock" — and it is worth spelling out
 * why nothing weaker will do. Two receptionists take the last place in a slot at
 * the same instant. Read-then-write ("is there room? yes → insert") lets both
 * read `booked_count = 0` before either writes, and both patients leave with a
 * confirmation for a slot that holds one. So every booking path here:
 *
 *  1. takes `SELECT … FROM clinical.schedule_slots WHERE id = $1 FOR UPDATE`,
 *     which serialises everything that follows for *that* slot and, under READ
 *     COMMITTED, re-reads the row after the lock is granted, so the loser sees
 *     the winner's `booked_count`;
 *  2. increments `booked_count` in the same transaction, where the CHECK
 *     constraint `booked_count <= capacity + overbook_allowance` is the backstop
 *     if a future caller ever skips step 1.
 *
 * **Overbooking is never implicit.** Exceeding `capacity` requires the caller to
 * ask for it (`overbook: true`) *and* to hold `appointment.overbook`, which is a
 * reason-required key; the row is then flagged `is_overbooked` with
 * `overbook_approved_by` set, and the table's CHECK constraint refuses the flag
 * without an approver. A slot that is full for somebody without that permission
 * stays full.
 *
 * Every mutation writes one audit row per mutated row and its registered outbox
 * event inside the same transaction (EN-024 §5). No query carries a
 * `hospital_id` predicate — RLS does the isolation, so a cross-tenant id is a
 * 404, not a 403 (`docs/09` §3.1 case 2).
 */

const RESOURCE = 'opd.appointments';

/** Statuses that still occupy a place in a slot. */
const LIVE_STATUSES = ['booked', 'confirmed', 'checked_in'];

/**
 * How far ahead of the slot a patient may check in.
 *
 * OP-001 §3.5.1 wants an "early/late tolerance" that the hospital configures,
 * and `packages/contracts` has no setting definition for it yet, so this is a
 * documented default rather than an invented configuration key. Two hours is
 * generous enough for a patient who came early by bus and tight enough to stop
 * tomorrow's appointment being checked in today by a mis-scan.
 */
export const EARLY_CHECK_IN_TOLERANCE_MINUTES = 120;

export interface AppointmentListItem {
  readonly id: string;
  readonly appointment_no: string;
  readonly patient_id: string | null;
  readonly lead_name: string | null;
  readonly practitioner_key: string | null;
  readonly speciality_key: string | null;
  readonly consult_type_key: string | null;
  readonly slot_id: string | null;
  readonly slot_start: Date;
  readonly slot_end: Date;
  readonly slot_date: string;
  readonly channel: string;
  readonly status: string;
  readonly is_tele: boolean;
  readonly is_overbooked: boolean;
  readonly visit_id: string | null;
  readonly checked_in_at: Date | null;
  readonly confirmed_at: Date | null;
  readonly cancelled_at: Date | null;
}

export interface AppointmentDetail extends AppointmentListItem {
  readonly lead_mobile: string | null;
  readonly department_key: string | null;
  readonly cancel_reason: string | null;
  readonly cancel_note: string | null;
  readonly rescheduled_from_id: string | null;
  readonly rescheduled_to_id: string | null;
  readonly notes: string | null;
  readonly version: number;
}

export interface CheckInResult {
  readonly appointment: AppointmentDetail;
  readonly visitId: string;
  readonly visitNo: string;
  readonly tokenDisplay: string;
  readonly queueId: string;
}

interface LockedSlot {
  readonly id: string;
  readonly branch_id: string;
  readonly practitioner_key: string;
  readonly speciality_key: string | null;
  readonly room_key: string | null;
  readonly slot_date: string;
  readonly slot_start: Date;
  readonly slot_end: Date;
  readonly capacity: number;
  readonly overbook_allowance: number;
  readonly booked_count: number;
  readonly online_quota: number;
  readonly online_booked_count: number;
  readonly status: string;
  readonly tele_enabled: boolean;
  readonly consult_type_keys: readonly string[] | null;
  readonly is_past: boolean;
}

@Injectable()
export class AppointmentsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(VisitsService) private readonly visits: VisitsService,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  async list(query: ListAppointmentsQuery): Promise<Page<AppointmentListItem>> {
    const branchId = requireBranch();
    const hospitalId = getContext().hospitalId ?? '';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource: RESOURCE });

    const where: string[] = ['a.branch_id = $1::uuid'];
    const values: unknown[] = [branchId];
    const bind = (value: unknown): string => `$${values.push(value)}`;

    if (query.doctor !== undefined) where.push(`a.practitioner_key = ${bind(query.doctor)}::uuid`);
    if (query.patientId !== undefined) where.push(`a.patient_id = ${bind(query.patientId)}::uuid`);
    if (query.status !== undefined) {
      where.push(`a.status = ${bind(query.status)}::clinical."AppointmentStatus"`);
    }
    // `slot_date` rather than `slot_start::date`: the cast is not immutable (it
    // depends on the session TimeZone) so PostgreSQL will not index it, and the
    // stored column already holds the branch-local day the clinic means.
    if (query.date !== undefined) where.push(`a.slot_date = ${bind(query.date)}::date`);
    if (after !== null) {
      where.push(`(a.slot_start, a.id) > (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
    }

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const fetched = await tx.rows<AppointmentListItem & { cursor_key: string }>(
        `SELECT a.id, a.appointment_no, a.patient_id, a.lead_name, a.practitioner_key,
                a.speciality_key, a.consult_type_key, a.slot_id,
                a.slot_start, a.slot_end, a.slot_date::text AS slot_date,
                a.channel::text AS channel, a.status::text AS status,
                a.is_tele, a.is_overbooked, a.visit_id,
                a.checked_in_at, a.confirmed_at, a.cancelled_at,
                a.slot_start::text AS cursor_key
           FROM clinical.appointments a
          WHERE ${where.join(' AND ')}
          ORDER BY a.slot_start ASC, a.id ASC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      return this.cursors.keysetPage<AppointmentListItem>(fetched, limit, {
        hospitalId,
        resource: RESOURCE,
        direction: 'asc',
      });
    });
  }

  async get(id: string): Promise<AppointmentDetail> {
    return this.db.withTenant(currentTenantContext(), async (tx) => this.loadAppointment(tx, id));
  }

  // ── book ──────────────────────────────────────────────────────────────────

  async book(body: BookAppointmentRequest, idempotencyKey: string | null): Promise<AppointmentDetail> {
    const branchId = requireBranch();
    const ctx = getContext();

    // Asked *before* the transaction opens, so an unauthorised overbooking never
    // takes the slot lock at all.
    if (body.overbook) await this.policy.assert('appointment.overbook');

    const appointmentId = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const replay = await this.findReplay(tx, idempotencyKey);
      if (replay !== null) return replay;

      const slot = await this.lockSlot(tx, body.slotId);
      this.assertSlotBookable(slot, branchId, body.consultTypeKey ?? null);

      const overbooking = slot.booked_count >= slot.capacity;
      if (overbooking && !body.overbook) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'That slot is full. Choose another slot or add the patient to the waitlist.',
          { nextAction: 'Pick a different slot, or ask a user with `appointment.overbook` to force it.' },
        );
      }

      if (body.patientId !== undefined) {
        await this.assertPatientBookable(tx, body.patientId, slot.practitioner_key, slot.slot_date, null);
      }

      const allocation = await this.numbering.allocate(tx, {
        key: 'APPT',
        branchId,
        refType: 'clinical.appointments',
      });

      const id = newId();
      const isOnline = body.channel === 'online' || body.channel === 'app';

      await this.insertAppointment(tx, {
        id,
        branchId,
        appointmentNo: allocation.formatted,
        slot,
        body,
        overbooking,
        idempotencyKey,
        rescheduledFromId: null,
      });
      await this.takeSlotPlace(tx, slot.id, isOnline);
      await this.recordStatus(tx, id, null, 'booked', body.channel, null);

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'clinical.appointments',
        rowId: id,
        businessKey: allocation.formatted,
        dataClass: 'phi',
        patientId: body.patientId ?? null,
        before: null,
        after: {
          appointment_no: allocation.formatted,
          practitioner_key: slot.practitioner_key,
          slot_start: slot.slot_start.toISOString(),
          slot_date: slot.slot_date,
          channel: body.channel,
          status: 'booked',
          is_overbooked: overbooking,
        },
        ...(overbooking ? { reasonText: ctx.reason } : {}),
      });

      await this.outbox.publish(
        tx,
        schedulingEvent('appointment.booked', id, {
          appointmentId: id,
          patientId: body.patientId ?? null,
          doctorId: slot.practitioner_key,
          slotStart: slot.slot_start.toISOString(),
          slotEnd: slot.slot_end.toISOString(),
          channel: body.channel,
        }),
      );

      return id;
    });

    return this.get(appointmentId);
  }

  // ── confirm ───────────────────────────────────────────────────────────────

  async confirm(id: string, body: ConfirmAppointmentRequest): Promise<AppointmentDetail> {
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const appointment = await this.lockAppointment(tx, id);
      if (appointment.status === 'confirmed') {
        throw new AppError(ProblemType.ALREADY_DECIDED, 'This appointment is already confirmed.');
      }
      if (appointment.status !== 'booked') {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `An appointment with status "${appointment.status}" cannot be confirmed.`,
        );
      }

      const updated = await tx.one<{ confirmed_at: Date }>(
        `UPDATE clinical.appointments
            SET status = 'confirmed', confirmed_at = now(),
                updated_at = now(), updated_by = $2, version = version + 1
          WHERE id = $1::uuid
          RETURNING confirmed_at`,
        [id, getContext().userId],
      );

      await this.recordStatus(
        tx,
        id,
        appointment.status,
        'confirmed',
        appointment.channel,
        body.note ?? null,
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.appointments',
        rowId: id,
        businessKey: appointment.appointment_no,
        dataClass: 'phi',
        patientId: appointment.patient_id,
        before: { status: appointment.status },
        after: { status: 'confirmed' },
      });

      await this.outbox.publish(
        tx,
        schedulingEvent('appointment.confirmed', id, {
          appointmentId: id,
          confirmedAt: updated.confirmed_at.toISOString(),
        }),
      );
    });

    return this.get(id);
  }

  // ── reschedule ────────────────────────────────────────────────────────────

  /**
   * Moves an appointment to a new slot.
   *
   * The old row is **kept** and marked `rescheduled`, and a new row is created
   * with `rescheduled_from_id` pointing back — which is also why
   * `appointment.rescheduled` carries `previousAppointmentId`. Overwriting the
   * slot in place would erase the fact that the patient was moved, which is the
   * fact a complaint six weeks later is about.
   *
   * Both slot rows are locked in a deterministic order (by id), so two
   * receptionists swapping patients between the same pair of slots cannot
   * deadlock each other.
   */
  async reschedule(id: string, body: RescheduleAppointmentRequest): Promise<AppointmentDetail> {
    const branchId = requireBranch();
    const ctx = getContext();

    const created = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const appointment = await this.lockAppointment(tx, id);
      if (!LIVE_STATUSES.includes(appointment.status)) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `An appointment with status "${appointment.status}" cannot be rescheduled.`,
        );
      }
      if (appointment.status === 'checked_in') {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'This patient has already checked in. Cancel the visit before rescheduling.',
        );
      }
      if (appointment.slot_id === body.slotId) {
        throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, 'That is the slot it is already in.');
      }

      const slots = await this.lockSlots(
        tx,
        [body.slotId, appointment.slot_id].filter((value): value is string => value !== null),
      );
      const target = slots.get(body.slotId);
      if (target === undefined) throw AppError.notFound('The slot');
      this.assertSlotBookable(target, branchId, appointment.consult_type_key);

      if (target.booked_count >= target.capacity) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'That slot is full. Choose another slot for the reschedule.',
        );
      }

      // The old row must leave the live statuses *before* the new one is
      // inserted, or `uq_appointments_patient_doctor_day` rejects a move to
      // another time on the same day — which is the commonest reschedule there is.
      await tx.query(
        `UPDATE clinical.appointments
            SET status = 'rescheduled', updated_at = now(), updated_by = $2, version = version + 1
          WHERE id = $1::uuid`,
        [id, ctx.userId],
      );
      if (appointment.slot_id !== null) await this.releaseSlotPlace(tx, appointment.slot_id, false);

      const allocation = await this.numbering.allocate(tx, {
        key: 'APPT',
        branchId,
        refType: 'clinical.appointments',
      });
      const replacementId = newId();

      await this.insertAppointment(tx, {
        id: replacementId,
        branchId,
        appointmentNo: allocation.formatted,
        slot: target,
        body: {
          slotId: target.id,
          ...(appointment.patient_id === null ? {} : { patientId: appointment.patient_id }),
          ...(appointment.lead_name === null ? {} : { leadName: appointment.lead_name }),
          ...(appointment.lead_mobile === null ? {} : { leadMobile: appointment.lead_mobile }),
          ...(appointment.consult_type_key === null ? {} : { consultTypeKey: appointment.consult_type_key }),
          channel: appointment.channel as BookAppointmentRequest['channel'],
          isTele: appointment.is_tele,
          overbook: false,
          ...(body.note === undefined ? {} : { notes: body.note }),
        },
        overbooking: false,
        idempotencyKey: null,
        rescheduledFromId: id,
      });
      await this.takeSlotPlace(tx, target.id, false);

      await tx.query(
        `UPDATE clinical.appointments SET rescheduled_to_id = $2::uuid, updated_at = now()
          WHERE id = $1::uuid`,
        [id, replacementId],
      );

      await this.recordStatus(
        tx,
        id,
        appointment.status,
        'rescheduled',
        appointment.channel,
        body.note ?? null,
      );
      await this.recordStatus(tx, replacementId, null, 'booked', appointment.channel, body.note ?? null);

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.appointments',
        rowId: id,
        businessKey: appointment.appointment_no,
        dataClass: 'phi',
        patientId: appointment.patient_id,
        before: { status: appointment.status, slot_start: appointment.slot_start.toISOString() },
        after: { status: 'rescheduled', rescheduled_to_id: replacementId },
        ...(body.note === undefined ? {} : { reasonText: body.note }),
      });
      await this.audit.write(tx, {
        action: 'insert',
        entity: 'clinical.appointments',
        rowId: replacementId,
        businessKey: allocation.formatted,
        dataClass: 'phi',
        patientId: appointment.patient_id,
        before: null,
        after: {
          appointment_no: allocation.formatted,
          rescheduled_from_id: id,
          slot_start: target.slot_start.toISOString(),
          slot_date: target.slot_date,
          status: 'booked',
        },
      });

      await this.outbox.publish(
        tx,
        schedulingEvent('appointment.rescheduled', replacementId, {
          appointmentId: replacementId,
          previousAppointmentId: id,
          slotStart: target.slot_start.toISOString(),
          slotEnd: target.slot_end.toISOString(),
        }),
      );

      return replacementId;
    });

    return this.get(created);
  }

  // ── cancel ────────────────────────────────────────────────────────────────

  /**
   * Cancels an appointment and gives the place back.
   *
   * The event carries the reason **and the party who cancelled**, because
   * OP-001 §5's refund rule turns on both: "100 % if cancelled ≥ 24 h, else 0,
   * always full if the hospital cancels". OP-005 cannot compute a refund from an
   * appointment id alone, and looking the reason up afterwards is exactly the
   * lookup that goes missing when the row is later amended.
   */
  async cancel(id: string, body: CancelAppointmentRequest): Promise<AppointmentDetail> {
    const ctx = getContext();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const appointment = await this.lockAppointment(tx, id);

      if (appointment.status === 'cancelled') {
        throw new AppError(ProblemType.ALREADY_DECIDED, 'This appointment is already cancelled.');
      }
      if (!LIVE_STATUSES.includes(appointment.status)) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `An appointment with status "${appointment.status}" cannot be cancelled.`,
        );
      }
      if (appointment.status === 'checked_in') {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'This patient has already checked in. Cancel the visit instead.',
          { nextAction: 'Use PATCH /visits/{id}/cancel.' },
        );
      }

      await tx.query(
        `UPDATE clinical.appointments
            SET status = 'cancelled',
                cancel_reason = $2::clinical."AppointmentCancelReason",
                cancel_note = $3, cancelled_by = $4, cancelled_at = now(),
                updated_at = now(), updated_by = $4, version = version + 1
          WHERE id = $1::uuid`,
        [id, body.reason, body.note ?? null, ctx.userId],
      );

      if (appointment.slot_id !== null) {
        await this.releaseSlotPlace(
          tx,
          appointment.slot_id,
          appointment.channel === 'online' || appointment.channel === 'app',
        );
      }

      await this.recordStatus(tx, id, appointment.status, 'cancelled', appointment.channel, body.reason, {
        cancelledBy: body.cancelledBy,
        note: body.note ?? null,
      });

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.appointments',
        rowId: id,
        businessKey: appointment.appointment_no,
        dataClass: 'phi',
        patientId: appointment.patient_id,
        before: { status: appointment.status },
        after: { status: 'cancelled', cancel_reason: body.reason, cancelled_by_party: body.cancelledBy },
        reasonCode: body.reason,
        reasonText: body.note ?? ctx.reason,
      });

      await this.outbox.publish(
        tx,
        schedulingEvent('appointment.cancelled', id, {
          appointmentId: id,
          // The reason code first, so a consumer can switch on it, with the
          // free-text note appended for the human reading the refund queue.
          reason: body.note === undefined ? body.reason : `${body.reason}: ${body.note}`,
          cancelledBy: body.cancelledBy,
        }),
      );
    });

    return this.get(id);
  }

  // ── check-in ──────────────────────────────────────────────────────────────

  /**
   * `POST /appointments/{id}/check-in` — the visit and the token, together.
   *
   * Both are written on one transaction by `VisitsService.openVisit`, so the
   * patient cannot end up registered but invisible to the queue board.
   */
  async checkIn(id: string, body: CheckInRequest, idempotencyKey: string | null): Promise<CheckInResult> {
    const branchId = requireBranch();
    const ctx = getContext();

    const visitId = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const appointment = await this.lockAppointment(tx, id);

      if (appointment.status === 'checked_in' && appointment.visit_id !== null) {
        // A double scan of the same QR is not an error worth failing a queue for.
        return appointment.visit_id;
      }
      if (appointment.status !== 'booked' && appointment.status !== 'confirmed') {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `An appointment with status "${appointment.status}" cannot be checked in.`,
        );
      }
      if (appointment.patient_id === null) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'This booking is for an unregistered lead. Register the patient before checking in.',
          { nextAction: 'Register the patient (patient.record.create), then check in.' },
        );
      }
      if (appointment.practitioner_key === null) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'This booking has no doctor, so no queue can be chosen for it.',
        );
      }

      const tooEarly = await tx.one<{ too_early: boolean }>(
        `SELECT $1::timestamptz - now() > make_interval(mins => $2::int) AS too_early`,
        [appointment.slot_start, EARLY_CHECK_IN_TOLERANCE_MINUTES],
      );
      if (tooEarly.too_early) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `This appointment is more than ${EARLY_CHECK_IN_TOLERANCE_MINUTES} minutes away; check-in opens closer to the time.`,
          { nextAction: 'Ask the patient to wait, or book a walk-in visit instead.' },
        );
      }

      const opened: OpenedVisit = await this.visits.openVisit(tx, {
        branchId,
        patientId: appointment.patient_id,
        practitionerKey: appointment.practitioner_key,
        departmentKey: appointment.department_key,
        specialityKey: appointment.speciality_key,
        consultTypeKey: appointment.consult_type_key,
        roomKey: body.roomKey ?? null,
        appointmentId: id,
        appointmentDueAt: appointment.slot_start,
        visitType: body.visitType ?? 'new',
        payerType: body.payerType,
        sourceChannel: body.sourceChannel,
        queueId: body.queueId,
        notes: body.notes ?? null,
        idempotencyKey,
      });

      await tx.query(
        `UPDATE clinical.appointments
            SET status = 'checked_in', checked_in_at = now(), visit_id = $2::uuid,
                updated_at = now(), updated_by = $3, version = version + 1
          WHERE id = $1::uuid`,
        [id, opened.visitId, ctx.userId],
      );

      await this.recordStatus(tx, id, appointment.status, 'checked_in', appointment.channel, null, {
        visitId: opened.visitId,
        tokenDisplay: opened.tokenDisplay,
      });

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.appointments',
        rowId: id,
        businessKey: appointment.appointment_no,
        dataClass: 'phi',
        patientId: appointment.patient_id,
        encounterId: opened.visitId,
        before: { status: appointment.status },
        after: { status: 'checked_in', visit_id: opened.visitId, token: opened.tokenDisplay },
      });

      return opened.visitId;
    });

    const [appointment, visit] = await Promise.all([this.get(id), this.visits.get(visitId)]);
    return {
      appointment,
      visitId,
      visitNo: visit.visit_no,
      tokenDisplay: visit.token_display ?? '',
      queueId: visit.queue_id ?? '',
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Takes the slot's row lock.
   *
   * `FOR UPDATE` here is the whole concurrency story: the second of two
   * simultaneous bookings blocks until the first commits and then re-reads
   * `booked_count`, so it sees the place has gone.
   */
  private async lockSlot(tx: TransactionClient, slotId: string): Promise<LockedSlot> {
    const locked = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM clinical.schedule_slots WHERE id = $1::uuid FOR UPDATE`,
      [slotId],
    );
    if (locked === undefined) throw AppError.notFound('The slot');
    const slot = await this.readSlot(tx, slotId);
    if (slot === undefined) throw AppError.notFound('The slot');
    return slot;
  }

  /** Locks several slots at once, ordered by id, so two movers cannot deadlock. */
  private async lockSlots(
    tx: TransactionClient,
    slotIds: readonly string[],
  ): Promise<Map<string, LockedSlot>> {
    const ids = [...new Set(slotIds)].sort();
    await tx.query(
      `SELECT id FROM clinical.schedule_slots WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [ids],
    );
    const rows = await tx.rows<LockedSlot>(`${SLOT_COLUMNS} WHERE s.id = ANY($1::uuid[])`, [ids]);
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async readSlot(tx: TransactionClient, slotId: string): Promise<LockedSlot | undefined> {
    return tx.maybeOne<LockedSlot>(`${SLOT_COLUMNS} WHERE s.id = $1::uuid`, [slotId]);
  }

  private assertSlotBookable(slot: LockedSlot, branchId: string, consultTypeKey: string | null): void {
    if (slot.branch_id !== branchId) throw AppError.notFound('The slot');
    if (slot.status === 'blocked' || slot.status === 'cancelled') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'That slot is blocked — the doctor is unavailable at that time.',
      );
    }
    if (slot.is_past) {
      throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, 'That slot is in the past.');
    }
    if (
      consultTypeKey !== null &&
      slot.consult_type_keys !== null &&
      slot.consult_type_keys.length > 0 &&
      !slot.consult_type_keys.includes(consultTypeKey)
    ) {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'That consultation type is not offered in this slot.',
      );
    }
  }

  /**
   * OP-001 §5: "same patient same doctor same day duplicate blocked."
   *
   * Probed here for a message a receptionist can act on; enforced by
   * `uq_appointments_patient_doctor_day`, which is what actually holds under a
   * race (see `mapConstraints`).
   */
  private async assertPatientBookable(
    tx: TransactionClient,
    patientId: string,
    practitionerKey: string,
    slotDate: string,
    excludeAppointmentId: string | null,
  ): Promise<void> {
    const patient = await tx.maybeOne<{ id: string; status: string }>(
      `SELECT id, status::text AS status FROM patient.patients
        WHERE id = $1::uuid AND deleted_at IS NULL`,
      [patientId],
    );
    if (patient === undefined) throw AppError.notFound('The patient');
    if (patient.status !== 'active') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        `This patient record is ${patient.status} and cannot be booked.`,
      );
    }

    const clash = await tx.maybeOne<{ appointment_no: string }>(
      `SELECT appointment_no FROM clinical.appointments
        WHERE patient_id = $1::uuid AND practitioner_key = $2::uuid AND slot_date = $3::date
          AND status IN ('booked', 'confirmed', 'checked_in')
          AND ($4::uuid IS NULL OR id <> $4::uuid)
        LIMIT 1`,
      [patientId, practitionerKey, slotDate, excludeAppointmentId],
    );
    if (clash !== undefined) {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        `This patient already has appointment ${clash.appointment_no} with this doctor on that day (OP-001 §5).`,
        { nextAction: 'Reschedule the existing appointment instead of booking a second one.' },
      );
    }
  }

  private async insertAppointment(
    tx: TransactionClient,
    input: {
      readonly id: string;
      readonly branchId: string;
      readonly appointmentNo: string;
      readonly slot: LockedSlot;
      readonly body: BookAppointmentRequest;
      readonly overbooking: boolean;
      readonly idempotencyKey: string | null;
      readonly rescheduledFromId: string | null;
    },
  ): Promise<void> {
    const ctx = getContext();
    await mapConstraints(async () =>
      tx.query(
        `INSERT INTO clinical.appointments (
           id, hospital_id, branch_id, appointment_no, patient_id, lead_name, lead_mobile,
           practitioner_key, speciality_key, resource_key, consult_type_key,
           slot_id, slot_start, slot_end, slot_date,
           channel, status, is_tele, is_overbooked, overbook_approved_by,
           rescheduled_from_id, notes, idempotency_key, booked_by, created_by, updated_by, updated_at
         ) VALUES (
           $1, $2, $3::uuid, $4, $5::uuid, $6, $7,
           $8::uuid, $9::uuid, $10::uuid, $11::uuid,
           $12::uuid, $13::timestamptz, $14::timestamptz, $15::date,
           $16::clinical."AppointmentChannel", 'booked', $17, $18, $19::uuid,
           $20::uuid, $21, $22, $23, $23, $23, now()
         )`,
        [
          input.id,
          ctx.hospitalId,
          input.branchId,
          input.appointmentNo,
          input.body.patientId ?? null,
          input.body.leadName ?? null,
          input.body.leadMobile ?? null,
          input.slot.practitioner_key,
          input.slot.speciality_key,
          input.slot.room_key,
          input.body.consultTypeKey ?? null,
          input.slot.id,
          input.slot.slot_start,
          input.slot.slot_end,
          input.slot.slot_date,
          input.body.channel,
          input.body.isTele,
          input.overbooking,
          // The CHECK constraint refuses `is_overbooked` without an approver, so
          // an overbooking always names the person who authorised it.
          input.overbooking ? ctx.userId : null,
          input.rescheduledFromId,
          input.body.notes ?? null,
          input.idempotencyKey,
          ctx.userId,
        ],
      ),
    );
  }

  private async takeSlotPlace(tx: TransactionClient, slotId: string, online: boolean): Promise<void> {
    await mapConstraints(async () =>
      tx.query(
        `UPDATE clinical.schedule_slots
            SET booked_count = booked_count + 1,
                online_booked_count = online_booked_count + CASE WHEN $2::boolean THEN 1 ELSE 0 END,
                status = CASE WHEN booked_count + 1 >= capacity + overbook_allowance
                              THEN 'full'::clinical."SlotStatus"
                              ELSE 'filling'::clinical."SlotStatus" END,
                updated_at = now(), version = version + 1
          WHERE id = $1::uuid`,
        [slotId, online],
      ),
    );
  }

  private async releaseSlotPlace(tx: TransactionClient, slotId: string, online: boolean): Promise<void> {
    await mapConstraints(async () =>
      tx.query(
        `UPDATE clinical.schedule_slots
            SET booked_count = GREATEST(booked_count - 1, 0),
                online_booked_count = GREATEST(
                  online_booked_count - CASE WHEN $2::boolean THEN 1 ELSE 0 END, 0),
                status = CASE WHEN GREATEST(booked_count - 1, 0) = 0
                              THEN 'open'::clinical."SlotStatus"
                              WHEN GREATEST(booked_count - 1, 0) >= capacity + overbook_allowance
                              THEN 'full'::clinical."SlotStatus"
                              ELSE 'filling'::clinical."SlotStatus" END,
                updated_at = now(), version = version + 1
          WHERE id = $1::uuid AND status <> 'blocked'`,
        [slotId, online],
      ),
    );
  }

  /** The status ladder OP-001 §4 asks for — every transition, with its actor. */
  private async recordStatus(
    tx: TransactionClient,
    appointmentId: string,
    from: string | null,
    to: string,
    channel: string,
    reason: string | null,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    const ctx = getContext();
    await tx.query(
      `INSERT INTO clinical.appointment_status_history (
         id, hospital_id, appointment_id, from_status, to_status, reason, channel,
         actor_id, actor_type, meta
       ) VALUES ($1, $2, $3::uuid, $4::clinical."AppointmentStatus", $5::clinical."AppointmentStatus",
                 $6, $7::clinical."AppointmentChannel", $8, $9, $10::jsonb)`,
      [
        newId(),
        ctx.hospitalId,
        appointmentId,
        from,
        to,
        reason,
        channel,
        ctx.userId,
        ctx.userId === null ? 'system' : 'user',
        JSON.stringify(meta),
      ],
    );
  }

  private async loadAppointment(tx: TransactionClient, id: string): Promise<AppointmentDetail> {
    const appointment = await tx.maybeOne<AppointmentDetail>(
      `SELECT a.id, a.appointment_no, a.patient_id, a.lead_name, a.lead_mobile,
              a.practitioner_key, a.speciality_key, a.department_key, a.consult_type_key, a.slot_id,
              a.slot_start, a.slot_end, a.slot_date::text AS slot_date,
              a.channel::text AS channel, a.status::text AS status,
              a.is_tele, a.is_overbooked, a.visit_id,
              a.checked_in_at, a.confirmed_at, a.cancelled_at,
              a.cancel_reason::text AS cancel_reason, a.cancel_note,
              a.rescheduled_from_id, a.rescheduled_to_id, a.notes, a.version
         FROM clinical.appointments a
        WHERE a.id = $1::uuid`,
      [id],
    );
    if (appointment === undefined) throw AppError.notFound('The appointment');
    return appointment;
  }

  private async lockAppointment(tx: TransactionClient, id: string): Promise<AppointmentDetail> {
    const locked = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM clinical.appointments WHERE id = $1::uuid FOR UPDATE`,
      [id],
    );
    if (locked === undefined) throw AppError.notFound('The appointment');
    return this.loadAppointment(tx, id);
  }

  private async findReplay(tx: TransactionClient, key: string | null): Promise<string | null> {
    if (key === null) return null;
    const existing = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM clinical.appointments WHERE idempotency_key = $1`,
      [key],
    );
    return existing?.id ?? null;
  }
}

/** The slot projection every booking path reads, kept in one place. */
const SLOT_COLUMNS = `SELECT s.id, s.branch_id, s.practitioner_key, s.speciality_key, s.room_key,
              s.slot_date::text AS slot_date, s.slot_start, s.slot_end,
              s.capacity, s.overbook_allowance, s.booked_count,
              s.online_quota, s.online_booked_count, s.status::text AS status,
              s.tele_enabled, s.consult_type_keys,
              (s.slot_start <= now()) AS is_past
         FROM clinical.schedule_slots s`;
