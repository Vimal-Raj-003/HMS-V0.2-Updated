import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { actorId, withLabErrors } from './lab.common.js';
import { labEvent } from './lab.events.js';
import type { AcknowledgeCriticalRequest, CriticalCallbackRequest, CriticalQuery } from './lab.schemas.js';
import type { LabCriticalAlertView, LabCriticalCallbackView } from './lab.types.js';

/**
 * OP-004 §3.5 and `docs/DECISIONS.md` **D-10** — the critical-value loop.
 *
 * This service exists because of one sentence: *a critical result is released
 * immediately; only its authorisation waits on documentation*. Withholding a
 * panic value to force paperwork is itself a hazard — somebody with a potassium
 * of 7.1 does not become safer because the pathologist has not yet reached the
 * ward — so nothing here gates a value. The alert was raised by a database
 * trigger in the transaction that stored the number, before any of this ran.
 * What this service does is drive the *communication*, which is the part a
 * trigger cannot do.
 *
 * ── The two arms, and why the second is as easy as the first ────────────────
 *
 * A call-back is either a read-back — a named clinician repeating the value back
 * — or a documented "clinician unreachable, escalated to <tier>". The CHECK on
 * `lab_critical_value_callbacks` makes *neither* unstorable and *both at once*
 * unstorable too, because a read-back from somebody you could not reach is not a
 * fact.
 *
 * The escalation arm is deliberately no harder to record than the read-back arm.
 * D-10 calls it "a tracked exception on the NABL KPI, not a silent bypass": if
 * it were harder, the pressure would fall back onto withholding the result,
 * which is exactly the hazard the decision exists to remove.
 *
 * ── Why the acknowledgement comes last ──────────────────────────────────────
 *
 * `OP-004 §3.5.2` closes the loop in one direction only: the laboratory
 * communicates, then the clinician acknowledges. An acknowledgement recorded
 * with no communication behind it would set `first_communicated_at` on an alert
 * nobody ever called through — which is why the alert's own CHECK ties the two
 * together, and why this service refuses the out-of-order case rather than
 * inventing a communication to satisfy it.
 */
@Injectable()
export class LabCriticalValueService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  async list(query: CriticalQuery): Promise<Page<LabCriticalAlertView>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = 'lab.critical_values';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${values.push(value)}`;
      const clauses: string[] = [];
      // "Open" means the loop is not closed: raised, communicated or escalated
      // but not yet acknowledged. An acknowledged or retracted alert is history.
      if (query.open) clauses.push(`a.status IN ('open', 'communicated', 'escalated')`);
      if (query.patientId !== undefined) clauses.push(`a.patient_id = ${bind(query.patientId)}::uuid`);
      if (after !== null) {
        clauses.push(`(a.detected_at, a.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<AlertRow & { cursor_key: string }>(
        `SELECT a.id, a.result_id, a.result_version, a.order_id, a.order_test_id, a.patient_id,
                a.analyte_name, a.flag::text AS flag, a.value_display, a.unit,
                a.detected_at::text AS detected_at, a.due_by::text AS due_by,
                a.status::text AS status, a.escalation_level,
                a.first_communicated_at::text AS first_communicated_at,
                a.acknowledged_at::text AS acknowledged_at,
                a.detected_at::text AS cursor_key
           FROM lab.lab_critical_value_alerts a
           ${where}
          ORDER BY a.detected_at DESC, a.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<AlertRow>(rows, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });

      const callbacks = await this.callbacksFor(
        tx,
        page.items.map((a) => a.id),
      );

      return {
        items: page.items.map((alert) => ({
          ...alert,
          callbacks: callbacks.filter((c) => c.alert_id === alert.id),
        })),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  async get(id: string): Promise<LabCriticalAlertView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const alert = await tx.maybeOne<AlertRow>(
        `SELECT a.id, a.result_id, a.result_version, a.order_id, a.order_test_id, a.patient_id,
                a.analyte_name, a.flag::text AS flag, a.value_display, a.unit,
                a.detected_at::text AS detected_at, a.due_by::text AS due_by,
                a.status::text AS status, a.escalation_level,
                a.first_communicated_at::text AS first_communicated_at,
                a.acknowledged_at::text AS acknowledged_at
           FROM lab.lab_critical_value_alerts a WHERE a.id = $1`,
        [id],
      );
      if (alert === undefined) throw AppError.notFound('The critical-value alert');
      const callbacks = await this.callbacksFor(tx, [id]);
      return { ...alert, callbacks };
    });
  }

  /**
   * Records one communication attempt. Append-only — §D revokes UPDATE and
   * DELETE on this table, because it is the NABL evidence that unlocks the
   * signature, and evidence that can be edited after the fact is a checkbox.
   */
  async notify(alertId: string, body: CriticalCallbackRequest): Promise<LabCriticalAlertView> {
    const ctx = getContext();

    await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const alert = await tx.maybeOne<{
          id: string;
          result_id: string;
          patient_id: string;
          analyte_name: string;
          value_display: string;
          status: string;
          detected_at: string;
          latency_seconds: string;
        }>(
          `SELECT id, result_id, patient_id, analyte_name, value_display, status::text AS status,
                  detected_at::text AS detected_at,
                  GREATEST(0, EXTRACT(EPOCH FROM (now() - detected_at)))::int::text AS latency_seconds
             FROM lab.lab_critical_value_alerts
            WHERE id = $1
            FOR UPDATE`,
          [alertId],
        );
        if (alert === undefined) throw AppError.notFound('The critical-value alert');
        if (alert.status === 'retracted') {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'This alert was retracted — a later version of the result is no longer critical. There is nothing to call through.',
          );
        }

        const actor = await tx.maybeOne<{ display_name: string }>(
          `SELECT display_name FROM core.users WHERE id = $1`,
          [ctx.userId],
        );

        const sequence = await tx.one<{ n: number }>(
          `SELECT COALESCE(max(sequence), 0)::int + 1 AS n
             FROM lab.lab_critical_value_callbacks WHERE alert_id = $1`,
          [alertId],
        );

        // Split the union into the two rows the CHECK will accept, once, here.
        // Every column that belongs to the other arm is explicitly null: that is
        // what makes "both at once" unstorable rather than merely discouraged.
        const arm: CallbackArm =
          body.outcome === 'read_back_confirmed'
            ? {
                readBackConfirmed: true,
                notifiedToUserId: body.notifiedToUserId ?? null,
                notifiedToName: body.notifiedToName,
                notifiedToRole: body.notifiedToRole ?? null,
                notifiedToContact: body.notifiedToContact ?? null,
                readBackValue: body.readBackValue,
                clinicianUnreachable: false,
                escalatedToLevel: null,
                escalatedToRole: null,
                escalatedToUserId: null,
                summary: `read-back confirmed by ${body.notifiedToName}`,
                informedPersonName: body.notifiedToName,
              }
            : {
                readBackConfirmed: false,
                notifiedToUserId: null,
                notifiedToName: null,
                notifiedToRole: null,
                notifiedToContact: null,
                readBackValue: null,
                clinicianUnreachable: true,
                escalatedToLevel: body.escalatedToLevel,
                escalatedToRole: body.escalatedToRole,
                escalatedToUserId: body.escalatedToUserId ?? null,
                summary: `clinician unreachable — escalated to ${body.escalatedToRole}`,
                informedPersonName: `escalated to ${body.escalatedToRole}`,
              };
        const id = newId();

        await tx.query(
          `INSERT INTO lab.lab_critical_value_callbacks (
             id, hospital_id, alert_id, sequence, notified_by, notified_by_name, notified_at,
             method, notified_to_user_id, notified_to_name, notified_to_role, notified_to_contact,
             read_back_confirmed, read_back_value,
             clinician_unreachable, escalated_to_level, escalated_to_role, escalated_to_user_id,
             attempt_count, remarks, latency_seconds, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, now(),
             $7::lab."LabNotifyMethod", $8, $9, $10, $11,
             $12, $13,
             $14, $15, $16, $17,
             $18, $19, $20, $5
           )`,
          [
            id,
            ctx.hospitalId,
            alertId,
            sequence.n,
            ctx.userId,
            actor?.display_name ?? 'Laboratory',
            body.method,
            arm.notifiedToUserId,
            arm.notifiedToName,
            arm.notifiedToRole,
            arm.notifiedToContact,
            arm.readBackConfirmed,
            arm.readBackValue,
            arm.clinicianUnreachable,
            arm.escalatedToLevel,
            arm.escalatedToRole,
            arm.escalatedToUserId,
            body.attemptCount,
            body.remarks ?? null,
            Number(alert.latency_seconds),
          ],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'lab.lab_critical_value_callbacks',
          rowId: id,
          businessKey: alert.analyte_name,
          dataClass: 'phi',
          patientId: alert.patient_id,
          before: { alert_status: alert.status },
          after: {
            outcome: body.outcome,
            method: body.method,
            sequence: sequence.n,
            latency_seconds: Number(alert.latency_seconds),
          },
          sensitivity: 'sensitive',
          reasonText: arm.summary,
        });

        await this.outbox.publish(
          tx,
          labEvent('lab.critical.acknowledged', alertId, {
            alertId,
            resultId: alert.result_id,
            patientId: alert.patient_id,
            outcome: body.outcome,
            calledByUserId: actorId(),
            // On the escalation arm there is, by definition, nobody to name —
            // which is the point of the arm. The tier it went to is what the
            // NABL exception report needs, so that is what travels.
            informedPersonName: arm.informedPersonName,
            escalationTier: arm.escalatedToLevel,
            minutesFromDetection: Math.floor(Number(alert.latency_seconds) / 60),
            acknowledgedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(alertId);
  }

  /** `OP-004 §3.5.2` — the ordering clinician closes the loop from their inbox. */
  async acknowledge(alertId: string, body: AcknowledgeCriticalRequest): Promise<LabCriticalAlertView> {
    const ctx = getContext();

    await withLabErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const alert = await tx.maybeOne<{
          id: string;
          status: string;
          patient_id: string;
          analyte_name: string;
        }>(
          `SELECT id, status::text AS status, patient_id, analyte_name
             FROM lab.lab_critical_value_alerts WHERE id = $1 FOR UPDATE`,
          [alertId],
        );
        if (alert === undefined) throw AppError.notFound('The critical-value alert');
        if (alert.status === 'acknowledged') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This alert has already been acknowledged.');
        }
        if (alert.status === 'open') {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'Nobody has communicated this value yet. The laboratory records the call-back first; the acknowledgement is what closes the loop afterwards (OP-004 §3.5.2).',
          );
        }

        await tx.query(
          `UPDATE lab.lab_critical_value_alerts
              SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(),
                  updated_by = $2, updated_at = now()
            WHERE id = $1`,
          [alertId, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'lab.lab_critical_value_alerts',
          rowId: alertId,
          businessKey: alert.analyte_name,
          dataClass: 'phi',
          patientId: alert.patient_id,
          before: { status: alert.status },
          after: { status: 'acknowledged' },
          sensitivity: 'sensitive',
          ...(body.note === undefined ? {} : { reasonText: body.note }),
        });
      }),
    );

    return this.get(alertId);
  }

  private async callbacksFor(
    tx: TransactionClient,
    alertIds: readonly string[],
  ): Promise<(LabCriticalCallbackView & { alert_id: string })[]> {
    if (alertIds.length === 0) return [];
    return tx.rows<LabCriticalCallbackView & { alert_id: string }>(
      `SELECT alert_id, id, sequence, notified_by_name, notified_at::text AS notified_at,
              method::text AS method, notified_to_name, notified_to_role,
              read_back_confirmed, read_back_value, clinician_unreachable,
              escalated_to_level, escalated_to_role, latency_seconds
         FROM lab.lab_critical_value_callbacks
        WHERE alert_id = ANY($1::uuid[])
        ORDER BY alert_id, sequence`,
      [alertIds],
    );
  }
}

/** One of the two shapes `lab_critical_value_callbacks_evidence` accepts. */
interface CallbackArm {
  readonly readBackConfirmed: boolean;
  readonly notifiedToUserId: string | null;
  readonly notifiedToName: string | null;
  readonly notifiedToRole: string | null;
  readonly notifiedToContact: string | null;
  readonly readBackValue: string | null;
  readonly clinicianUnreachable: boolean;
  readonly escalatedToLevel: number | null;
  readonly escalatedToRole: string | null;
  readonly escalatedToUserId: string | null;
  readonly summary: string;
  readonly informedPersonName: string;
}

interface AlertRow {
  readonly id: string;
  readonly result_id: string;
  readonly result_version: number;
  readonly order_id: string;
  readonly order_test_id: string;
  readonly patient_id: string;
  readonly analyte_name: string;
  readonly flag: string;
  readonly value_display: string;
  readonly unit: string | null;
  readonly detected_at: string;
  readonly due_by: string | null;
  readonly status: string;
  readonly escalation_level: number;
  readonly first_communicated_at: string | null;
  readonly acknowledged_at: string | null;
}
