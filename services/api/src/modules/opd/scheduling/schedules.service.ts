import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import type {
  CreateScheduleExceptionRequest,
  DoctorSlotsQuery,
  PublishScheduleRequest,
  PutScheduleTemplatesRequest,
} from './dto/scheduling.dto.js';
import { branchToday, branchTimeZone, mapConstraints, requireBranch } from './scheduling.common.js';
import { schedulingEvent } from './scheduling.events.js';
import { addDays, expandSessions, type GeneratedSlot, type TemplateSession } from './slot-grid.js';

/**
 * OP-001 §3.6 — the doctor's weekly grid, and the act of publishing it.
 *
 * The split that this file exists to hold is the one OP-001 §12 states and
 * `docs/05` calls segregation of duties: **a doctor or HOD configures a
 * schedule (`schedule.configure`), a branch administrator publishes it
 * (`schedule.publish`)**. They are separate permission keys because publishing
 * is what the website, the portal and the call centre start booking against; a
 * doctor who could publish their own grid could open Saturday clinics nobody
 * staffed. So edits land as `draft` rows and stay invisible to booking until a
 * second person turns them into `published` rows and materialises the slots.
 *
 * Slots are **materialised**, not computed per request. OP-001 §13 budgets a
 * slot query at 150 ms and the booking path needs a row it can take a lock on:
 * you cannot `SELECT … FOR UPDATE` a slot that only exists as arithmetic, and
 * without that lock two receptionists can both take the last place. The grid in
 * `slot-grid.ts` produces branch-local wall-clock strings and PostgreSQL turns
 * them into instants, so a clinic on the morning of a DST change keeps its
 * advertised local time.
 */

export interface ScheduleTemplateRow {
  readonly id: string;
  readonly practitioner_key: string;
  readonly weekday: number;
  readonly start_time: string;
  readonly end_time: string;
  readonly slot_minutes: number;
  readonly capacity_per_slot: number;
  readonly overbook_allowance: number;
  readonly buffer_minutes: number;
  readonly online_quota_pct: number;
  readonly walkin_reserve: number;
  readonly online_booking_window_days: number;
  readonly vitals_required: boolean;
  readonly tele_enabled: boolean;
  readonly room_key: string | null;
  readonly department_key: string | null;
  readonly speciality_key: string | null;
  readonly consult_type_keys: readonly string[] | null;
  readonly status: string;
  readonly version: number;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly published_at: Date | null;
}

export interface ScheduleExceptionRow {
  readonly id: string;
  readonly practitioner_key: string | null;
  readonly kind: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly is_full_day: boolean;
  readonly reason: string;
  readonly replacement_practitioner_key: string | null;
  readonly affected_appointments: number;
  readonly created_at: Date;
}

export interface SlotView {
  readonly id: string;
  readonly slot_date: string;
  readonly slot_start: Date;
  readonly slot_end: Date;
  readonly capacity: number;
  readonly overbook_allowance: number;
  readonly booked_count: number;
  readonly online_quota: number;
  readonly online_booked_count: number;
  readonly walkin_reserve: number;
  readonly status: string;
  readonly tele_enabled: boolean;
  readonly room_key: string | null;
  readonly speciality_key: string | null;
  readonly consult_type_keys: readonly string[] | null;
  /** `capacity - booked_count`, floored at zero: places left before overbooking. */
  readonly available: number;
  /** Places left including the configured overbook allowance. */
  readonly available_with_overbook: number;
}

export interface PublishResult {
  readonly doctorId: string;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly templatesPublished: number;
  readonly slotsCreated: number;
  readonly horizonTo: string;
}

/** Exception kinds that stop a slot existing at all (OP-001 §3.6.2). */
const BLOCKING_EXCEPTION_KINDS = ['leave', 'holiday', 'blocked', 'conference', 'emergency'];

@Injectable()
export class SchedulesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  // ── slots (appointment.slot.read) ─────────────────────────────────────────

  /**
   * `GET /doctors/{id}/slots?date=` — OP-001 §3.4.1.
   *
   * Reads the materialised grid rather than recomputing it, and never returns a
   * slot that has already started: a receptionist who can click a 09:00 slot at
   * 09:40 will, and the patient arrives to a clinic that has moved on.
   */
  async slotsFor(doctorId: string, query: DoctorSlotsQuery): Promise<{ items: readonly SlotView[] }> {
    const branchId = requireBranch();

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [doctorId, branchId, query.date];
      const bind = (value: unknown): string => `$${values.push(value)}`;

      const filters: string[] = [
        's.practitioner_key = $1',
        's.branch_id = $2::uuid',
        's.slot_date = $3::date',
        `s.status <> 'cancelled'`,
        's.slot_start > now()',
      ];
      if (query.consultTypeKey !== undefined) {
        filters.push(
          `(cardinality(s.consult_type_keys) = 0 OR s.consult_type_keys @> ARRAY[${bind(query.consultTypeKey)}::uuid])`,
        );
      }
      if (!query.includeFull) {
        filters.push(`s.status <> 'blocked'`, 's.booked_count < s.capacity');
      }

      const items = await tx.rows<SlotView>(
        `SELECT s.id, s.slot_date::text AS slot_date, s.slot_start, s.slot_end,
                s.capacity, s.overbook_allowance, s.booked_count,
                s.online_quota, s.online_booked_count, s.walkin_reserve,
                s.status::text AS status, s.tele_enabled, s.room_key, s.speciality_key,
                s.consult_type_keys,
                GREATEST(s.capacity - s.booked_count, 0) AS available,
                GREATEST(s.capacity + s.overbook_allowance - s.booked_count, 0) AS available_with_overbook
           FROM clinical.schedule_slots s
          WHERE ${filters.join(' AND ')}
          ORDER BY s.slot_start ASC`,
        values,
      );

      return { items };
    });
  }

  // ── templates (schedule.configure) ────────────────────────────────────────

  async templatesFor(doctorId: string): Promise<{ items: readonly ScheduleTemplateRow[] }> {
    const branchId = requireBranch();
    return this.db.withTenant(currentTenantContext(), async (tx) => ({
      items: await tx.rows<ScheduleTemplateRow>(
        `SELECT t.id, t.practitioner_key, t.weekday, t.start_time::text AS start_time,
                t.end_time::text AS end_time, t.slot_minutes, t.capacity_per_slot,
                t.overbook_allowance, t.buffer_minutes, t.online_quota_pct, t.walkin_reserve,
                t.online_booking_window_days, t.vitals_required, t.tele_enabled,
                t.room_key, t.department_key, t.speciality_key, t.consult_type_keys,
                t.status::text AS status, t.version,
                t.effective_from::text AS effective_from, t.effective_to::text AS effective_to,
                t.published_at
           FROM clinical.doctor_schedule_templates t
          WHERE t.practitioner_key = $1 AND t.branch_id = $2::uuid AND t.deleted_at IS NULL
          ORDER BY t.status, t.weekday, t.start_time`,
        [doctorId, branchId],
      ),
    }));
  }

  /**
   * Replaces the doctor's **draft** grid. Published rows are untouched: they are
   * what the portal is booking against right now, and replacing them without a
   * second person's approval is the thing `schedule.publish` exists to prevent.
   */
  async putTemplates(
    doctorId: string,
    body: PutScheduleTemplatesRequest,
  ): Promise<{ items: readonly ScheduleTemplateRow[] }> {
    const branchId = requireBranch();
    const ctx = getContext();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      await this.assertPractitionerExists(tx, doctorId);

      // Soft-delete, because DELETE on this table is revoked from `hms_app`:
      // a schedule that once existed explains an appointment that was booked
      // against it, and an auditor asked to explain a Sunday clinic needs it.
      const superseded = await tx.query(
        `UPDATE clinical.doctor_schedule_templates
            SET deleted_at = now(), updated_at = now(), updated_by = $3
          WHERE practitioner_key = $1 AND branch_id = $2::uuid
            AND status = 'draft' AND deleted_at IS NULL`,
        [doctorId, branchId, ctx.userId],
      );

      for (const session of body.sessions) {
        await mapConstraints(async () =>
          tx.query(
            `INSERT INTO clinical.doctor_schedule_templates (
               id, hospital_id, branch_id, practitioner_key, room_key, department_key, speciality_key,
               weekday, start_time, end_time, slot_minutes, capacity_per_slot, overbook_allowance,
               buffer_minutes, consult_type_keys, online_quota_pct, walkin_reserve,
               online_booking_window_days, max_walkins, vitals_required, tele_enabled,
               status, effective_from, effective_to, created_by, updated_by, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7,
               $8, $9::time, $10::time, $11, $12, $13,
               $14, $15::uuid[], $16, $17,
               $18, $19, $20, $21,
               'draft', $22::date, $23::date, $24, $24, now()
             )`,
            [
              newId(),
              ctx.hospitalId,
              branchId,
              doctorId,
              session.roomKey ?? null,
              session.departmentKey ?? null,
              session.specialityKey ?? null,
              session.weekday,
              session.startTime,
              session.endTime,
              session.slotMinutes,
              session.capacityPerSlot,
              session.overbookAllowance,
              session.bufferMinutes,
              session.consultTypeKeys,
              session.onlineQuotaPct,
              session.walkinReserve,
              session.onlineBookingWindowDays,
              session.maxWalkins ?? null,
              session.vitalsRequired,
              session.teleEnabled,
              body.effectiveFrom,
              body.effectiveTo ?? null,
              ctx.userId,
            ],
          ),
        );
      }

      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'clinical.doctor_schedule_templates',
        rowId: null,
        businessKey: doctorId,
        dataClass: 'operational',
        before: { draft_sessions_replaced: superseded.rowCount ?? 0 },
        after: { draft_sessions: body.sessions.length, effective_from: body.effectiveFrom },
      });
    });

    return this.templatesFor(doctorId);
  }

  // ── exceptions (schedule.configure) ───────────────────────────────────────

  async exceptionsFor(doctorId: string): Promise<{ items: readonly ScheduleExceptionRow[] }> {
    const branchId = requireBranch();
    return this.db.withTenant(currentTenantContext(), async (tx) => ({
      items: await tx.rows<ScheduleExceptionRow>(
        `SELECT e.id, e.practitioner_key, e.kind::text AS kind, e.starts_at, e.ends_at,
                e.is_full_day, e.reason, e.replacement_practitioner_key,
                e.affected_appointments, e.created_at
           FROM clinical.schedule_exceptions e
          WHERE e.practitioner_key = $1 AND e.branch_id = $2::uuid AND e.deleted_at IS NULL
          ORDER BY e.starts_at DESC`,
        [doctorId, branchId],
      ),
    }));
  }

  /**
   * Records a leave/holiday/block. Existing appointments inside the window are
   * **counted, not cancelled**: OP-001 §3.4.7 puts them through a bulk-reschedule
   * wizard with notifications, and silently voiding somebody's appointment
   * because a doctor filed leave is the failure that wizard exists to prevent.
   */
  async createException(
    doctorId: string,
    body: CreateScheduleExceptionRequest,
  ): Promise<ScheduleExceptionRow> {
    const branchId = requireBranch();
    const ctx = getContext();
    const id = newId();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      await this.assertPractitionerExists(tx, doctorId);

      const affected = await tx.one<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM clinical.appointments a
          WHERE a.practitioner_key = $1 AND a.branch_id = $2::uuid
            AND a.status IN ('booked', 'confirmed')
            AND tstzrange(a.slot_start, a.slot_end) && tstzrange($3::timestamptz, $4::timestamptz)`,
        [doctorId, branchId, body.startsAt, body.endsAt],
      );

      await tx.query(
        `INSERT INTO clinical.schedule_exceptions (
           id, hospital_id, branch_id, practitioner_key, kind, starts_at, ends_at,
           is_full_day, reason, replacement_practitioner_key, affected_appointments,
           created_by, updated_at
         ) VALUES ($1, $2, $3, $4, $5::clinical."ScheduleExceptionKind", $6::timestamptz, $7::timestamptz,
                   $8, $9, $10, $11, $12, now())`,
        [
          id,
          ctx.hospitalId,
          branchId,
          doctorId,
          body.kind,
          body.startsAt,
          body.endsAt,
          body.isFullDay,
          body.reason,
          body.replacementPractitionerKey ?? null,
          Number(affected.count),
          ctx.userId,
        ],
      );

      // Block the empty slots inside the window. A slot with bookings on it is
      // left alone so the bulk-reschedule wizard can still see what it must move.
      await tx.query(
        `UPDATE clinical.schedule_slots
            SET status = 'blocked', blocked_reason = left($4, 200), exception_id = $5,
                updated_at = now(), version = version + 1
          WHERE practitioner_key = $1 AND branch_id = $6::uuid
            AND booked_count = 0 AND status <> 'cancelled'
            AND tstzrange(slot_start, slot_end) && tstzrange($2::timestamptz, $3::timestamptz)`,
        [doctorId, body.startsAt, body.endsAt, body.reason, id, branchId],
      );

      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'clinical.schedule_exceptions',
        rowId: id,
        businessKey: doctorId,
        dataClass: 'operational',
        before: null,
        after: {
          kind: body.kind,
          starts_at: body.startsAt,
          ends_at: body.endsAt,
          affected_appointments: Number(affected.count),
        },
        reasonText: body.reason,
      });
    });

    const list = await this.exceptionsFor(doctorId);
    const created = list.items.find((row) => row.id === id);
    if (created === undefined) throw AppError.notFound('The schedule exception');
    return created;
  }

  // ── publish (schedule.publish) ────────────────────────────────────────────

  /**
   * `POST /doctors/{id}/schedule/publish` — OP-001 §3.6.1.
   *
   * Turns the draft grid into a published version and materialises the slots the
   * portal will book against, in one transaction with its audit row and its
   * `schedule.published` event.
   */
  async publish(doctorId: string, body: PublishScheduleRequest): Promise<PublishResult> {
    const branchId = requireBranch();
    const ctx = getContext();

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const timeZone = await branchTimeZone(tx, branchId);
      const today = await branchToday(tx, timeZone);

      const drafts = await tx.rows<ScheduleTemplateRow>(
        `SELECT t.id, t.practitioner_key, t.weekday, t.start_time::text AS start_time,
                t.end_time::text AS end_time, t.slot_minutes, t.capacity_per_slot,
                t.overbook_allowance, t.buffer_minutes, t.online_quota_pct, t.walkin_reserve,
                t.online_booking_window_days, t.vitals_required, t.tele_enabled,
                t.room_key, t.department_key, t.speciality_key, t.consult_type_keys,
                t.status::text AS status, t.version,
                t.effective_from::text AS effective_from, t.effective_to::text AS effective_to,
                t.published_at
           FROM clinical.doctor_schedule_templates t
          WHERE t.practitioner_key = $1 AND t.branch_id = $2::uuid
            AND t.status = 'draft' AND t.deleted_at IS NULL
          ORDER BY t.weekday, t.start_time
          FOR UPDATE`,
        [doctorId, branchId],
      );

      if (drafts.length === 0) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'There is no draft schedule to publish for this doctor at this branch.',
          { nextAction: 'Ask the doctor or HOD to save a weekly grid first (schedule.configure).' },
        );
      }

      const latest = await tx.one<{ version: number }>(
        `SELECT COALESCE(max(version), 0) AS version
           FROM clinical.doctor_schedule_templates
          WHERE practitioner_key = $1 AND branch_id = $2::uuid AND status <> 'draft'`,
        [doctorId, branchId],
      );
      const version = latest.version + 1;

      const effectiveFrom = drafts.reduce<string>(
        (min, row) => (row.effective_from < min ? row.effective_from : min),
        '9999-12-31',
      );
      const generateFrom = effectiveFrom > today ? effectiveFrom : today;
      const window = drafts.reduce<number>((min, row) => Math.min(min, row.online_booking_window_days), 365);
      const horizonTo = addDays(generateFrom, (body.horizonDays ?? window) - 1);

      // The previous published version stops here. `superseded_by_id` stays NULL
      // because a version is a *set* of weekday rows, not a row-to-row mapping —
      // pointing Monday-old at one of several Monday-new rows would assert a
      // lineage that does not exist.
      await tx.query(
        `UPDATE clinical.doctor_schedule_templates
            SET status = 'superseded', effective_to = LEAST(COALESCE(effective_to, $3::date), $3::date),
                updated_at = now(), updated_by = $4
          WHERE practitioner_key = $1 AND branch_id = $2::uuid
            AND status = 'published' AND deleted_at IS NULL`,
        [doctorId, branchId, generateFrom, ctx.userId],
      );

      await tx.query(
        `UPDATE clinical.doctor_schedule_templates
            SET status = 'published', version = $3, published_at = now(), published_by = $4,
                updated_at = now(), updated_by = $4
          WHERE id = ANY($1::uuid[]) AND branch_id = $2::uuid`,
        [drafts.map((d) => d.id), branchId, version, ctx.userId],
      );

      // Unbooked future slots from the superseded version are removed before the
      // new grid lands, or a changed slot length would collide with the old one
      // through `schedule_slots_no_overlap`. Anything with a booking on it is
      // kept: a published change must never make somebody's appointment vanish.
      await tx.query(
        `DELETE FROM clinical.schedule_slots
          WHERE practitioner_key = $1 AND branch_id = $2::uuid
            AND slot_date >= $3::date AND booked_count = 0`,
        [doctorId, branchId, generateFrom],
      );

      const sessions: TemplateSession[] = drafts.map((row) => ({
        templateId: row.id,
        weekday: row.weekday,
        startTime: row.start_time,
        endTime: row.end_time,
        slotMinutes: row.slot_minutes,
        bufferMinutes: row.buffer_minutes,
        capacityPerSlot: row.capacity_per_slot,
        overbookAllowance: row.overbook_allowance,
        onlineQuotaPct: row.online_quota_pct,
        walkinReserve: row.walkin_reserve,
        consultTypeKeys: row.consult_type_keys ?? [],
        teleEnabled: row.tele_enabled,
        roomKey: row.room_key,
        specialityKey: row.speciality_key,
      }));

      const generated = expandSessions(sessions, generateFrom, horizonTo);
      const slotsCreated = await this.materialise(tx, doctorId, branchId, timeZone, generated);

      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'clinical.doctor_schedule_templates',
        rowId: null,
        businessKey: doctorId,
        dataClass: 'operational',
        before: { status: 'draft' },
        after: {
          status: 'published',
          version,
          effective_from: generateFrom,
          horizon_to: horizonTo,
          templates: drafts.length,
          slots_created: slotsCreated,
        },
      });

      await this.outbox.publish(
        tx,
        schedulingEvent('schedule.published', doctorId, {
          doctorId,
          version,
          effectiveFrom: new Date(`${generateFrom}T00:00:00Z`).toISOString(),
        }),
      );

      return {
        doctorId,
        version,
        effectiveFrom: generateFrom,
        templatesPublished: drafts.length,
        slotsCreated,
        horizonTo,
      };
    });
  }

  /**
   * Writes the generated grid.
   *
   * The wall-clock strings become instants inside PostgreSQL
   * (`(date + time) AT TIME ZONE tz`) so the IANA rules that apply are the ones
   * the database was patched with, and a slot that falls inside a blocking
   * exception is never created at all.
   */
  private async materialise(
    tx: TransactionClient,
    doctorId: string,
    branchId: string,
    timeZone: string,
    generated: readonly GeneratedSlot[],
  ): Promise<number> {
    if (generated.length === 0) return 0;
    const ctx = getContext();

    const payload = generated.map((slot) => ({
      id: newId(),
      template_id: slot.templateId,
      room_key: slot.roomKey,
      speciality_key: slot.specialityKey,
      local_date: slot.localDate,
      local_start: slot.localStart,
      local_end: slot.localEnd,
      capacity: slot.capacity,
      overbook_allowance: slot.overbookAllowance,
      online_quota: slot.onlineQuota,
      walkin_reserve: slot.walkinReserve,
      consult_type_keys: slot.consultTypeKeys,
      tele_enabled: slot.teleEnabled,
    }));

    const inserted = await mapConstraints(async () =>
      tx.query(
        `INSERT INTO clinical.schedule_slots (
           id, hospital_id, branch_id, template_id, practitioner_key, room_key, speciality_key,
           slot_date, slot_start, slot_end, capacity, overbook_allowance, online_quota,
           walkin_reserve, consult_type_keys, tele_enabled, status, updated_at
         )
         SELECT g.id, $1, $2::uuid, g.template_id, $3::uuid, g.room_key, g.speciality_key,
                g.local_date::date,
                (g.local_date::date + g.local_start::time) AT TIME ZONE $4,
                (g.local_date::date + g.local_end::time) AT TIME ZONE $4,
                g.capacity, g.overbook_allowance, g.online_quota, g.walkin_reserve,
                g.consult_type_keys, g.tele_enabled, 'open', now()
           FROM jsonb_to_recordset($5::jsonb) AS g(
                  id uuid, template_id uuid, room_key uuid, speciality_key uuid,
                  local_date text, local_start text, local_end text,
                  capacity int, overbook_allowance int, online_quota int, walkin_reserve int,
                  consult_type_keys uuid[], tele_enabled boolean)
          WHERE NOT EXISTS (
                  SELECT 1 FROM clinical.schedule_exceptions e
                   WHERE e.practitioner_key = $3::uuid
                     AND e.branch_id = $2::uuid
                     AND e.deleted_at IS NULL
                     AND e.kind::text = ANY($6::text[])
                     AND tstzrange(e.starts_at, e.ends_at) && tstzrange(
                           (g.local_date::date + g.local_start::time) AT TIME ZONE $4,
                           (g.local_date::date + g.local_end::time) AT TIME ZONE $4))
         ON CONFLICT (hospital_id, practitioner_key, slot_start) DO NOTHING`,
        [ctx.hospitalId, branchId, doctorId, timeZone, JSON.stringify(payload), BLOCKING_EXCEPTION_KINDS],
      ),
    );

    return inserted.rowCount ?? 0;
  }

  /**
   * A doctor id that is not a practitioner of this hospital reads as "not
   * found", never as a validation error naming the table — the id space is
   * shared across tenants and RLS is what makes the row invisible.
   */
  private async assertPractitionerExists(tx: TransactionClient, doctorId: string): Promise<void> {
    const row = await tx.maybeOne<{ record_key: string }>(
      `SELECT record_key FROM mdm.mdm_practitioners
        WHERE record_key = $1 AND status IN ('active', 'pending_approval')
        LIMIT 1`,
      [doctorId],
    );
    if (row === undefined) throw AppError.notFound('The doctor');
  }
}
