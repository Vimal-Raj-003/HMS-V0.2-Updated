import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { assertRegisteredEvent } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { ENV, type Env } from '../../../core/config/env.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { OutboxService, type OutboxEvent } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { PublicRateLimitService } from './rate-limit.service.js';
import type {
  AppointmentRequestBody,
  AppointmentRequestReceipt,
  AppointmentRequestRow,
  RequestConvertBody,
  RequestListQuery,
  RequestUpdateBody,
} from './assistant.schemas.js';

/**
 * Builds the outbox event from the registry rather than from a literal, exactly
 * as `schedulingEvent` does for OP-001. `publish` takes the type as a plain
 * string, so a typo would be written happily, relayed happily and consumed by
 * nobody.
 */
function assistantEvent(
  type: string,
  aggregateId: string,
  payload: Readonly<Record<string, unknown>>,
): OutboxEvent {
  const definition = assertRegisteredEvent(type);
  const parsed = definition.schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Event "${type}" payload does not match its registered schema (docs/09 §4): ` +
        parsed.error.issues
          .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
          .join('; '),
    );
  }
  return {
    eventType: definition.type,
    aggregate: definition.aggregate,
    aggregateId,
    payload,
    schemaVersion: definition.schemaVersion,
    containsPhi: definition.containsPhi,
    retentionDays: definition.retentionDays,
  };
}

/** The wording a visitor agreed to. Stored with the row; changing it means a new version. */
export const CONSENT_TEXT_VERSION = 'pe009-v1';

function iso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' ? v : null;
}

/**
 * PE-009 · The enquiry, and what front office does with it.
 *
 * ── Why this is not `appointments.service.ts` ──────────────────────────────
 *
 * Because an enquiry is not an appointment, and the gap between them is a
 * verified phone number. The migration's header sets out the argument at length;
 * the short version is that an anonymous web caller who could create
 * appointments could fill a consultant's fortnight, and one who could create
 * patients could pollute the master patient index that OP-002's deduplication
 * exists to keep clean.
 *
 * So the public half of this file writes one row into one table. The staff half
 * reads it, and `convert` is the moment a person takes responsibility for it.
 */
@Injectable()
export class AppointmentRequestService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PublicRateLimitService) private readonly limits: PublicRateLimitService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ── Public ────────────────────────────────────────────────────────────────

  async capture(body: AppointmentRequestBody, ip: string | null): Promise<AppointmentRequestReceipt> {
    if (!this.env.ASSISTANT_ENABLED) {
      throw AppError.notFound('The assistant is not enabled for this hospital.');
    }

    // Tighter than the chat budget on purpose: a visitor asks several questions
    // and leaves one enquiry, so five in a window is generous for a person and
    // mean to a script.
    await this.limits.consume(
      body.hospitalId,
      'appointment_request',
      ip,
      this.env.ASSISTANT_RATE_REQUEST_MAX,
    );

    // The tenant is asserted by the caller here, exactly as it is at login
    // (`docs/05`: one login URL per tenant, so the hospital is known before the
    // person is). This is not a widening: `withHospitalScope` sets
    // `app.hospital_id`, and RLS confines every statement below to that one
    // hospital whatever the body claimed. Setting it on the context as well is
    // what lets the shared audit writer stamp the row correctly, rather than
    // this file growing a second, divergent copy of the audit insert.
    const ctx = getContext();
    ctx.hospitalId = body.hospitalId;

    const id = newId();
    const ipHash = ip === null ? null : createHash('sha256').update(ip).digest();

    await this.db.withHospitalScope(body.hospitalId, async (tx) => {
      await tx.query(
        `INSERT INTO engage.appointment_requests (
           id, hospital_id, channel,
           requester_name, requester_phone, requester_email,
           speciality_key, practitioner_key, slot_id,
           preferred_date, preferred_period, reason,
           consent_given, consent_text_version, locale,
           status, requester_ip_hash, updated_at
         ) VALUES (
           $1, $2, 'web_assistant',
           $3, $4, $5,
           $6, $7, $8,
           $9::date, $10, $11,
           true, $12, $13,
           'new', $14, now()
         )`,
        [
          id,
          body.hospitalId,
          body.name.trim(),
          body.phone.trim(),
          body.email ?? null,
          body.specialityKey ?? null,
          body.practitionerKey ?? null,
          body.slotId ?? null,
          body.preferredDate ?? null,
          body.preferredPeriod ?? null,
          body.reason ?? null,
          CONSENT_TEXT_VERSION,
          body.locale ?? 'en-IN',
          ipHash,
        ],
      );

      // `actor_type` will be recorded as `system`: there is no signed-in user,
      // and the visitor is not a patient of this hospital yet, so neither of the
      // more specific actor types is true. What matters medico-legally is that
      // the row exists and says where it came from.
      await this.audit.write(tx, {
        action: 'insert',
        entity: 'appointment_request',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        reasonText: null,
        before: null,
        after: { channel: 'web_assistant', status: 'new', consentTextVersion: CONSENT_TEXT_VERSION },
      });

      // Same transaction as the insert, per `CLAUDE.md` §3: an enquiry that is
      // recorded but never announced is a queue that fills silently. Nothing
      // consumes this yet — the worker's notification path is not wired for it
      // — so front office reaches the enquiries through the worklist endpoint
      // meanwhile. Publishing now means the day a consumer is written, every
      // enquiry since today is already on the stream rather than only the ones
      // that arrive afterwards.
      await this.outbox.publish(
        tx,
        assistantEvent('appointment.request.received', id, {
          requestId: id,
          specialityKey: body.specialityKey ?? null,
          preferredDate: body.preferredDate ?? null,
          preferredPeriod: body.preferredPeriod ?? null,
          channel: 'web_assistant',
        }),
      );
    });

    return {
      id,
      status: 'new',
      // Said here as well as in the interface. The commonest way something like
      // this hurts somebody is by letting them believe they have an appointment
      // and not turn up to anything.
      message:
        'Thank you — this is a request, not a confirmed appointment. Our front office will call you to confirm a time. If it is urgent, please call the hospital or come to the Emergency Department.',
    };
  }

  // ── Staff ─────────────────────────────────────────────────────────────────

  async list(query: RequestListQuery): Promise<readonly AppointmentRequestRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT r.id, r.channel, r.requester_name, r.requester_phone, r.requester_email,
                r.speciality_key, s.name AS speciality_name,
                r.practitioner_key, p.display_name AS practitioner_name,
                r.slot_id,
                r.preferred_date, r.preferred_period, r.reason,
                r.status, r.appointment_id, r.handled_at, r.decline_reason, r.created_at
           FROM engage.appointment_requests r
           -- LEFT joins on purpose: a department or consultant retired since the
           -- enquiry arrived must still let the row render, or the clerk sees a
           -- blank cell and cannot tell a missing name from a missing preference.
           LEFT JOIN mdm.mdm_specialities s
             ON s.record_key = r.speciality_key AND s.status = 'active'
           LEFT JOIN mdm.mdm_practitioners p
             ON p.record_key = r.practitioner_key AND p.status = 'active'
          WHERE ($1::text IS NULL OR r.status = $1::text)
          ORDER BY r.created_at
          LIMIT $2`,
        [query.status ?? null, query.limit],
      );
      return result.rows.map(toRow);
    });
  }

  async update(id: string, body: RequestUpdateBody): Promise<AppointmentRequestRow> {
    if (body.status === 'declined' && body.declineReason === undefined) {
      throw AppError.validation([
        {
          path: 'declineReason',
          message:
            'Say why it was declined. A request that disappears without a reason cannot be told apart from one that was dropped.',
        },
      ]);
    }

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const before = await tx.query<{ status: string }>(
        `SELECT status FROM engage.appointment_requests WHERE id = $1`,
        [id],
      );
      const previous = before.rows[0];
      if (previous === undefined) throw AppError.notFound('That enquiry no longer exists.');

      const result = await tx.query<Record<string, unknown>>(
        `UPDATE engage.appointment_requests
            SET status = $2, decline_reason = $3, handled_by = $4, updated_at = now()
          WHERE id = $1
          RETURNING id, channel, requester_name, requester_phone, requester_email,
                    speciality_key, practitioner_key, slot_id,
                    preferred_date, preferred_period, reason,
                    status, appointment_id, handled_at, decline_reason, created_at`,
        [id, body.status, body.declineReason ?? null, getContext().userId],
      );
      const row = result.rows[0];
      if (row === undefined) throw AppError.notFound('That enquiry no longer exists.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'appointment_request',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        reasonText: body.declineReason ?? null,
        before: { status: previous.status },
        after: { status: body.status },
      });

      return toRow(row);
    });
  }

  /**
   * The moment an enquiry becomes a real appointment.
   *
   * The appointment is booked through the ordinary appointment routes by a
   * person holding `appointment.create`; this only records which enquiry it
   * came from. Doing it the other way — letting this endpoint create the
   * appointment — would put a second booking engine next to the first, and the
   * first is the one that knows about slots, capacity and overbooking.
   *
   * Re-pointing a converted enquiry is refused by a trigger, not by this code
   * (PE-009 §B.6).
   */
  async convert(id: string, body: RequestConvertBody): Promise<AppointmentRequestRow> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const appointment = await tx.query<{ id: string }>(
        `SELECT id FROM clinical.appointments WHERE id = $1`,
        [body.appointmentId],
      );
      if (appointment.rows[0] === undefined) {
        throw AppError.validation([
          {
            path: 'appointmentId',
            message:
              'That appointment does not exist. Book the appointment first, then link the enquiry to it.',
          },
        ]);
      }

      const result = await tx.query<Record<string, unknown>>(
        `UPDATE engage.appointment_requests
            SET status = 'booked', appointment_id = $2, handled_by = $3, updated_at = now()
          WHERE id = $1 AND status <> 'booked'
          RETURNING id, channel, requester_name, requester_phone, requester_email,
                    speciality_key, practitioner_key, slot_id,
                    preferred_date, preferred_period, reason,
                    status, appointment_id, handled_at, decline_reason, created_at`,
        [id, body.appointmentId, getContext().userId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'That enquiry is not open — it has already been booked, or it no longer exists.',
        );
      }

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'appointment_request',
        rowId: id,
        businessKey: body.appointmentId,
        dataClass: 'phi',
        patientId: null,
        encounterId: null,
        reasonText: null,
        before: { status: 'new' },
        after: { status: 'booked', appointmentId: body.appointmentId },
      });

      return toRow(row);
    });
  }
}

function toRow(r: Record<string, unknown>): AppointmentRequestRow {
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const textOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    id: text(r['id']),
    channel: text(r['channel']),
    requesterName: text(r['requester_name']),
    requesterPhone: text(r['requester_phone']),
    requesterEmail: textOrNull(r['requester_email']),
    specialityKey: textOrNull(r['speciality_key']),
    specialityName: textOrNull(r['speciality_name']),
    practitionerKey: textOrNull(r['practitioner_key']),
    practitionerName: textOrNull(r['practitioner_name']),
    slotId: textOrNull(r['slot_id']),
    preferredDate: iso(r['preferred_date'])?.slice(0, 10) ?? null,
    preferredPeriod: textOrNull(r['preferred_period']),
    reason: textOrNull(r['reason']),
    status: text(r['status']),
    appointmentId: textOrNull(r['appointment_id']),
    handledAt: iso(r['handled_at']),
    declineReason: textOrNull(r['decline_reason']),
    createdAt: iso(r['created_at']) ?? '',
  };
}
