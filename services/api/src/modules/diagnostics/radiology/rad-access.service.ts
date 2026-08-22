import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { radiologyEvent } from './radiology.events.js';

/**
 * The ABAC scope on `rad.image.view`, `rad.study.read` and `rad.telerad.read`,
 * and the audit trail that goes with every image access.
 *
 * `packages/contracts/src/rbac/permissions.ts` says this out loud on the EN-008
 * group: *"Two of these keys carry a scope the catalogue cannot express, so it
 * is stated here and enforced by ABAC, not by the key… Holding the key is
 * necessary and never sufficient."* A permission catalogue can say "this user
 * may open images". It cannot say "…of patients in their care, or of studies
 * assigned to them, or of anybody at all provided they say why". That sentence
 * has to live in a service, and this is the service.
 *
 * Three rules, applied in this order, and the order is the point:
 *
 *  1. **Assigned studies only, for an external reader.** A user who holds
 *     tele-radiology assignments in this hospital is an outside radiologist
 *     working a queue. EN-008 §5: "Tele-radiologist sees only assigned studies
 *     (ABAC `assigned_studies_only`)". They get no break-glass: break-glass is a
 *     control for clinicians *inside* the hospital who can be asked about it the
 *     next morning, and an external partner cannot be. The refusal is
 *     `ABAC_CONDITION_FAILED`, not `PERMISSION_DENIED`, because the key is held
 *     and the scope is what failed.
 *  2. **Care team.** The ordering clinician, the technologist who performed the
 *     exam, the radiologist assigned to read it, anybody in the ordering
 *     clinician's department, and anybody who has seen the patient in the last
 *     ninety days. Deliberately generous, for the reason `care-team.service.ts`
 *     records: a break-glass prompt that fires on ordinary work trains people to
 *     type "urgent" into it without reading.
 *  3. **Break-glass.** Access is granted, not refused — refusing a clinician at
 *     3 a.m. is its own patient-safety event — provided they say why. Without a
 *     reason the request is refused with `BREAK_GLASS_REASON_REQUIRED`.
 *
 * **Every successful access writes `rad.pacs_view_audit` in the same
 * transaction**, whichever of the three routes allowed it. EN-008 §5: "every
 * view logged". The table has `INSERT` and `SELECT` only — `migration.sql §D.1`
 * revokes `UPDATE` and `DELETE` — so the disclosure record cannot be tidied up
 * afterwards, which is the property that makes it answer a privacy complaint
 * three years later.
 */

const CARE_TEAM_WINDOW_DAYS = 90;

export interface StudyAccessDecision {
  readonly breakGlass: boolean;
  readonly reason: string | null;
  readonly purpose: 'care' | 'break_glass' | 'telerad';
}

export interface StudyAccessInput {
  readonly studyId: string | null;
  readonly studyInstanceUid: string | null;
  readonly patientId: string | null;
  readonly action: 'view' | 'download' | 'export' | 'annotate' | 'print' | 'burn' | 'share';
  readonly instanceCount?: number | null;
  readonly bytesTransferred?: bigint | null;
}

@Injectable()
export class RadAccessService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /**
   * Decides, records and returns. There is no "check" method that a caller could
   * use without also writing the audit row — the two are one act.
   */
  async authoriseAndAudit(tx: TransactionClient, input: StudyAccessInput): Promise<StudyAccessDecision> {
    const ctx = getContext();
    const userId = ctx.userId;
    if (userId === null) {
      throw new Error('RadAccessService reached without an authenticated user; a guarded route cannot.');
    }

    const decision = await this.decide(tx, userId, input);
    await this.record(tx, input, decision);
    return decision;
  }

  /** The read-side twin: a study list is scoped, but a list is not a disclosure of one study. */
  async isCareTeam(tx: TransactionClient, patientId: string): Promise<boolean> {
    const ctx = getContext();
    if (ctx.userId === null) return false;
    return this.careTeamOf(tx, ctx.userId, patientId, null);
  }

  private async decide(
    tx: TransactionClient,
    userId: string,
    input: StudyAccessInput,
  ): Promise<StudyAccessDecision> {
    const external = await this.isExternalReader(tx, userId);
    if (external) {
      const assigned = await this.isAssigned(tx, userId, input.studyId, input.studyInstanceUid);
      if (!assigned) {
        throw new AppError(
          ProblemType.ABAC_CONDITION_FAILED,
          'Tele-radiology access is limited to the studies assigned to you for reading.',
          {
            nextAction: 'Ask the radiology desk to assign this study to you if you are expected to read it.',
            reference: 'EN-008 §5 — assigned_studies_only',
          },
        );
      }
      return { breakGlass: false, reason: null, purpose: 'telerad' };
    }

    if (input.patientId !== null && (await this.careTeamOf(tx, userId, input.patientId, input.studyId))) {
      return { breakGlass: false, reason: null, purpose: 'care' };
    }

    const reason = getContext().reason;
    if (reason === null || reason.trim().length < 8) {
      throw new AppError(
        ProblemType.BREAK_GLASS_REASON_REQUIRED,
        'This patient is not in your care team. Say why you need these images; the access is granted and reviewed.',
        {
          nextAction: 'Retry with an `x-reason` header explaining the clinical need.',
          clinicalImpact: 'Break-glass access to imaging is recorded and reported to the Privacy Officer.',
        },
      );
    }

    return { breakGlass: true, reason, purpose: 'break_glass' };
  }

  /**
   * A user with any tele-radiology assignment in this hospital is an external
   * reader, and the assignment table is the only place that fact is recorded —
   * which is why it is read here rather than inferred from a role name.
   */
  private async isExternalReader(tx: TransactionClient, userId: string): Promise<boolean> {
    const row = await tx.one<{ external: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM rad.rad_teleradiology_assignments a
          WHERE a.radiologist_user_id = $1
       ) AND NOT EXISTS (
         SELECT 1 FROM mdm.mdm_practitioners p
          WHERE p.user_id = $1 AND p.status = 'active'
       ) AS external`,
      [userId],
    );
    return row.external;
  }

  private async isAssigned(
    tx: TransactionClient,
    userId: string,
    studyId: string | null,
    studyInstanceUid: string | null,
  ): Promise<boolean> {
    const row = await tx.one<{ assigned: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM rad.rad_teleradiology_assignments a
           JOIN rad.rad_order_items i ON i.id = a.order_item_id
           LEFT JOIN rad.pacs_studies s ON s.order_item_id = i.id
          WHERE a.radiologist_user_id = $1
            AND a.status <> 'cancelled'
            AND (
              ($2::uuid IS NOT NULL AND s.id = $2::uuid)
              OR ($3::text IS NOT NULL AND i.study_instance_uid = $3::text)
            )
       ) AS assigned`,
      [userId, studyId, studyInstanceUid],
    );
    return row.assigned;
  }

  /**
   * One statement rather than five round trips: this runs on every study open
   * and every viewer launch, and it sits inside the Class-C read budget
   * (`docs/07` §3).
   */
  private async careTeamOf(
    tx: TransactionClient,
    userId: string,
    patientId: string,
    studyId: string | null,
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
           SELECT 1 FROM rad.rad_orders o
            LEFT JOIN me ON true
            WHERE o.patient_id = $2
              AND o.ordered_at >= now() - ($3 || ' days')::interval
              AND (
                o.ordering_user_id = $1
                OR (me.record_key IS NOT NULL AND o.ordering_practitioner_key = me.record_key)
              )
         )
         OR EXISTS (
           SELECT 1 FROM rad.rad_exams e
            WHERE e.patient_id = $2 AND e.technician_user_id = $1
         )
         OR EXISTS (
           SELECT 1 FROM rad.rad_report_versions v
             JOIN rad.rad_reports r ON r.id = v.report_id
            WHERE r.patient_id = $2 AND (v.author_user_id = $1 OR v.signed_by = $1 OR v.cosigner_user_id = $1)
         )
         OR EXISTS (
           SELECT 1 FROM rad.rad_teleradiology_assignments a
             JOIN rad.rad_order_items i ON i.id = a.order_item_id
             LEFT JOIN rad.pacs_studies s ON s.order_item_id = i.id
            WHERE a.radiologist_user_id = $1
              AND ($4::uuid IS NOT NULL AND s.id = $4::uuid)
         )
         OR EXISTS (
           SELECT 1 FROM clinical.encounters e
            LEFT JOIN me ON true
            WHERE e.patient_id = $2
              AND e.started_at >= now() - ($3 || ' days')::interval
              AND (
                e.doctor_user_id = $1
                OR (me.record_key IS NOT NULL AND e.practitioner_key = me.record_key)
                OR (me.department_key IS NOT NULL AND e.department_key = me.department_key)
              )
         )
       ) AS care_team`,
      [userId, patientId, String(CARE_TEAM_WINDOW_DAYS), studyId],
    );
    return row.care_team;
  }

  private async record(
    tx: TransactionClient,
    input: StudyAccessInput,
    decision: StudyAccessDecision,
  ): Promise<void> {
    const ctx = getContext();

    await tx.query(
      `INSERT INTO rad.pacs_view_audit (
         id, hospital_id, branch_id, token_id, user_id, patient_id, study_id, study_instance_uid,
         action, purpose, break_glass_reason, instance_count, bytes_transferred, ip, user_agent, at
       ) VALUES (
         $1, $2, $3, NULL, $4, $5, $6, $7,
         $8::rad."PacsViewAction", $9, $10, $11, $12, $13::inet, $14, now()
       )`,
      [
        newId(),
        ctx.hospitalId,
        ctx.branchId,
        ctx.userId,
        input.patientId,
        input.studyId,
        input.studyInstanceUid,
        input.action,
        decision.purpose,
        decision.breakGlass ? decision.reason : null,
        input.instanceCount ?? null,
        input.bytesTransferred === undefined || input.bytesTransferred === null
          ? null
          : input.bytesTransferred.toString(10),
        ctx.ip,
        ctx.userAgent,
      ],
    );

    if (decision.breakGlass) {
      await this.audit.write(tx, {
        action: 'break_glass',
        entity: 'rad.pacs_studies',
        rowId: input.studyId,
        businessKey: input.studyInstanceUid,
        dataClass: 'phi',
        patientId: input.patientId,
        encounterId: null,
        before: null,
        after: { action: input.action },
        reasonText: decision.reason,
        sensitivity: 'sensitive',
      });
    }

    if (input.action === 'view' && input.studyId !== null && input.patientId !== null) {
      await this.outbox.publish(
        tx,
        radiologyEvent('pacs.study.viewed', input.studyId, {
          studyId: input.studyId,
          patientId: input.patientId,
          viewerUserId: ctx.userId ?? '',
          breakGlass: decision.breakGlass,
          reason: decision.reason,
          at: new Date().toISOString(),
        }),
      );
    }
  }
}
