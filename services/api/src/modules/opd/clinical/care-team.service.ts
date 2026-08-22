import { Inject, Injectable } from '@nestjs/common';
import { ProblemType } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { clinicalEvent } from './clinical.events.js';

/**
 * OP-002 §5 and §14 AC-10 — care team, and break-glass.
 *
 * > "Timeline access outside care team (not ordering/attending, not same
 * > department in last 90 days) → break-glass reason, `READ_PHI` audit."
 *
 * Break-glass is deliberately **not a flag on a role**. It is a recorded act:
 * access is granted first — because refusing a clinician at 3 a.m. is its own
 * patient-safety event — and reviewed afterwards, which is why
 * `encounter.break_glass` exists as an event and why the Privacy Officer's daily
 * report reads it (`docs/05` §Login model, EN-024 §5).
 *
 * Two consequences follow, and both are enforced here:
 *
 *  1. **A reason is required before the data is returned.** Without one the
 *     request is refused with `BREAK_GLASS_REASON_REQUIRED` rather than being
 *     silently allowed. The reason travels in `x-reason`, which the policy guard
 *     has already read into the request context.
 *  2. **The act is written in the same transaction as the read it authorises.**
 *     An audit row that could be lost while the chart was still shown would make
 *     the whole control decorative.
 *
 * Care-team membership is intentionally generous — the attending, anyone from
 * the same department, and anyone who has seen the patient in the last 90 days —
 * because a break-glass prompt that fires on ordinary work trains clinicians to
 * type "urgent" into it without reading. OP-002 §16 Q10 leaves the exact
 * definition to the hospital; this is the default the spec states, and it is
 * the one place to change it.
 */

const CARE_TEAM_WINDOW_DAYS = 90;

export interface AccessDecision {
  /** True when the caller was outside the care team and gave a reason instead. */
  readonly breakGlass: boolean;
  readonly reason: string | null;
}

@Injectable()
export class CareTeamService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /**
   * Grants access to a patient's clinical record, recording a break-glass act
   * when the caller is outside the care team.
   *
   * `encounterId` narrows the question to one encounter when there is one: the
   * doctor who owns it is always in its care team, whatever the department
   * lookup says.
   */
  async authorise(
    tx: TransactionClient,
    input: {
      readonly patientId: string;
      readonly encounterId?: string | null;
      /** What is being opened, for the audit entry. */
      readonly entity: string;
    },
  ): Promise<AccessDecision> {
    const ctx = getContext();
    const userId = ctx.userId;
    if (userId === null) {
      throw new Error('CareTeamService reached without an authenticated user; a guarded route cannot.');
    }

    if (await this.isCareTeam(tx, userId, input.patientId, input.encounterId ?? null)) {
      return { breakGlass: false, reason: null };
    }

    const reason = ctx.reason;
    if (reason === null || reason.trim().length < 8) {
      throw new AppError(
        ProblemType.BREAK_GLASS_REASON_REQUIRED,
        'This patient is not in your care team. Say why you need the record; the access is granted and reviewed.',
        {
          nextAction: 'Retry with an `x-reason` header explaining the clinical need.',
          clinicalImpact: 'Break-glass access is recorded and reported to the Privacy Officer.',
        },
      );
    }

    await this.audit.write(tx, {
      action: 'break_glass',
      entity: input.entity,
      rowId: input.encounterId ?? input.patientId,
      businessKey: null,
      dataClass: 'phi',
      patientId: input.patientId,
      encounterId: input.encounterId ?? null,
      before: null,
      after: null,
      reasonText: reason,
      sensitivity: 'sensitive',
    });

    await this.outbox.publish(
      tx,
      clinicalEvent('encounter.break_glass', input.encounterId ?? input.patientId, {
        patientId: input.patientId,
        encounterId: input.encounterId ?? null,
        clinicianUserId: userId,
        reason,
        occurredAt: new Date().toISOString(),
      }),
    );

    return { breakGlass: true, reason };
  }

  /**
   * The attending, the same department, or anybody who has seen this patient in
   * the last ninety days.
   *
   * One statement rather than three round trips: this runs on every chart open
   * and on every timeline page, and it sits inside the Class-C read budget.
   */
  private async isCareTeam(
    tx: TransactionClient,
    userId: string,
    patientId: string,
    encounterId: string | null,
  ): Promise<boolean> {
    const row = await tx.one<{ care_team: boolean }>(
      `WITH me AS (
         SELECT record_key, department_key
           FROM mdm.mdm_practitioners
          WHERE user_id = $1 AND status = 'active'
          ORDER BY version DESC
          LIMIT 1
       )
       SELECT (
         EXISTS (
           SELECT 1 FROM clinical.encounters e
            WHERE e.id = $3::uuid AND e.doctor_user_id = $1
         )
         OR EXISTS (
           SELECT 1 FROM clinical.encounters e
            LEFT JOIN me ON true
            WHERE e.patient_id = $2
              AND e.started_at >= now() - ($4 || ' days')::interval
              AND (
                e.doctor_user_id = $1
                OR (me.record_key IS NOT NULL AND e.practitioner_key = me.record_key)
                OR (me.department_key IS NOT NULL AND e.department_key = me.department_key)
              )
         )
         OR EXISTS (
           SELECT 1 FROM clinical.op_visits v
            LEFT JOIN me ON true
            WHERE v.patient_id = $2
              AND v.checked_in_at >= now() - ($4 || ' days')::interval
              AND (
                (me.record_key IS NOT NULL AND v.practitioner_key = me.record_key)
                OR (me.department_key IS NOT NULL AND v.department_key = me.department_key)
              )
         )
       ) AS care_team`,
      [userId, patientId, encounterId, String(CARE_TEAM_WINDOW_DAYS)],
    );

    return row.care_team;
  }
}
