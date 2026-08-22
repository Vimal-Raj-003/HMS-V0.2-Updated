import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { RadOrdersService } from './rad-orders.service.js';
import { withDatabaseRefusals } from './radiology.errors.js';
import { radiologyEvent } from './radiology.events.js';
import { mentionsFoetalSex } from './radiology.schemas.js';
import type {
  AmendReportRequest,
  CreateReportRequest,
  CriticalCallbackRequest,
  CriticalFindingRequest,
  PeerReviewRequest,
  SignReportRequest,
  UpdateReportRequest,
  WorklistQuery,
} from './radiology.schemas.js';
import type { CriticalFindingView, RadReportView, RadReportVersionView } from './radiology.types.js';

/**
 * OP-008 §3.4 and §3.5 — the radiology report, its versions, and the critical
 * finding.
 *
 * **Release and authorisation are separated, exactly as `docs/DECISIONS.md D-10`
 * separates them for the lab.** A critical imaging finding is not a reason to
 * hold the report back: somebody with an intracranial haemorrhage does not
 * become safer because the radiologist has not yet reached the ward. So
 * `sign()` always releases — the version becomes `final`, `rad.report.final` is
 * published, and the referring doctor's inbox has it. What waits on the
 * documented call-back is the *closure* of the order: the line sits at
 * `preliminary` until a `rad_critical_callbacks` row exists, and that row cannot
 * exist without evidence, because the CHECK on the table admits exactly two
 * arms — a confirmed read-back naming a person, or a documented "unreachable —
 * escalated to <tier>". Neither is unstorable; both at once is unstorable.
 *
 * **The finding row raises itself at signature.** `rad.enforce_critical_finding
 * _raised()` refuses to let a version whose finding level is `critical` reach
 * `final` with no `rad_critical_findings` row behind it. A service that answered
 * that by refusing the signature would be withholding the report to force
 * paperwork, which is the hazard D-10 exists to remove — so this service creates
 * the finding in the same transaction instead, the way `lab.raise_critical_value
 * _alert()` does it in the database. Raising the obligation is not a privilege
 * and needs no extra key; `rad.critical.notify` gates *recording the call-back*,
 * which stays a separate, named act.
 *
 * **A technologist does not sign and a resident does not finalise.** Neither is
 * a check in this file, and that is the point: `rad.study.complete` and
 * `rad.report.sign` are a `block` pair in `SEGREGATION_OF_DUTIES_RULES`, so no
 * role can hold both, and a resident's role simply does not carry
 * `rad.report.sign`. A resident's draft is written with `requestCosign` and sits
 * at `draft_for_cosign`; the consultant's signature is what finalises it.
 */
@Injectable()
export class RadReportsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(RadOrdersService) private readonly orders: RadOrdersService,
  ) {}

  // ── draft ─────────────────────────────────────────────────────────────────

  async createDraft(body: CreateReportRequest): Promise<RadReportView> {
    const ctx = getContext();
    let reportId = '';

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const item = await this.orders.loadItem(tx, body.orderItemId);
        this.refuseFoetalSex(item.is_pcpndt, body.findingsText, body.impressionText, body.recommendations);

        const existing = await tx.maybeOne<{ id: string }>(
          `SELECT id FROM rad.rad_reports WHERE order_item_id = $1`,
          [body.orderItemId],
        );
        if (existing !== undefined) {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'A report already exists for this study. Edit the draft, or amend the signed version.',
          );
        }

        const exam = await tx.maybeOne<{ id: string }>(
          `SELECT id FROM rad.rad_exams WHERE order_item_id = $1`,
          [body.orderItemId],
        );

        reportId = newId();
        await tx.query(
          `INSERT INTO rad.rad_reports (
             id, hospital_id, branch_id, order_item_id, exam_id, patient_id, accession_no,
             study_instance_uid, created_by, updated_by, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, now())`,
          [
            reportId,
            ctx.hospitalId,
            item.branch_id,
            body.orderItemId,
            exam?.id ?? null,
            item.patient_id,
            item.accession_no,
            item.study_instance_uid,
            ctx.userId,
          ],
        );

        await this.insertVersion(tx, {
          reportId,
          version: 1,
          status: body.requestCosign ? 'draft_for_cosign' : 'draft',
          templateKey: body.templateKey ?? null,
          content: body.content,
          findingsText: body.findingsText ?? null,
          impressionText: body.impressionText ?? null,
          recommendations: body.recommendations ?? null,
          biRads: body.biRads ?? null,
          tiRads: body.tiRads ?? null,
          liRads: body.liRads ?? null,
          pirads: body.pirads ?? null,
          findingLevel: body.findingLevel,
          keyImageRefs: body.keyImageRefs,
          measurements: body.measurements ?? null,
          authorUserId: ctx.userId,
          authorRegistrationNo: await this.registrationOf(tx, ctx.userId),
          amendmentReason: null,
        });

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'rad.rad_reports',
          rowId: reportId,
          businessKey: item.accession_no,
          dataClass: 'phi',
          patientId: item.patient_id,
          encounterId: item.encounter_id,
          before: null,
          after: { status: body.requestCosign ? 'draft_for_cosign' : 'draft', version: 1 },
        });
      }),
    );

    return this.get(reportId);
  }

  async updateDraft(reportId: string, body: UpdateReportRequest): Promise<RadReportView> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const report = await this.loadReport(tx, reportId);
        if (!['draft', 'draft_for_cosign'].includes(report.current_status)) {
          throw AppError.conflict(
            'This report is signed. A signed report is amended by writing the next version with a reason, never edited.',
          );
        }
        this.refuseFoetalSex(report.is_pcpndt, body.findingsText, body.impressionText, body.recommendations);

        await tx.query(
          `UPDATE rad.rad_report_versions SET
             content = COALESCE($3::jsonb, content),
             findings_text = COALESCE($4, findings_text),
             impression_text = COALESCE($5, impression_text),
             recommendations = COALESCE($6, recommendations),
             bi_rads = COALESCE($7, bi_rads), ti_rads = COALESCE($8, ti_rads),
             li_rads = COALESCE($9, li_rads), pirads = COALESCE($10, pirads),
             finding_level = COALESCE($11::rad."RadFindingLevel", finding_level),
             key_image_refs = COALESCE($12::text[], key_image_refs),
             measurements = COALESCE($13::jsonb, measurements),
             template_key = COALESCE($14::uuid, template_key)
           WHERE report_id = $1 AND version = $2`,
          [
            reportId,
            report.current_version,
            body.content === undefined ? null : JSON.stringify(body.content),
            body.findingsText ?? null,
            body.impressionText ?? null,
            body.recommendations ?? null,
            body.biRads ?? null,
            body.tiRads ?? null,
            body.liRads ?? null,
            body.pirads ?? null,
            body.findingLevel ?? null,
            body.keyImageRefs ?? null,
            body.measurements === undefined ? null : JSON.stringify(body.measurements),
            body.templateKey ?? null,
          ],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'rad.rad_report_versions',
          rowId: reportId,
          businessKey: report.accession_no,
          dataClass: 'phi',
          patientId: report.patient_id,
          encounterId: null,
          before: { version: report.current_version, status: report.current_status },
          after: { version: report.current_version, status: report.current_status, edited: true },
        });
      }),
    );

    return this.get(reportId);
  }

  // ── preliminary, sign, amend ──────────────────────────────────────────────

  /**
   * `OP-008 §3.4.5` — the wet read on a STAT trauma CT.
   *
   * A preliminary report is signed: the CHECK on `rad_report_versions` requires
   * a signer and a registration number for every status except the drafts and a
   * cancellation, and it should — a preliminary read that nobody has put their
   * name to is a rumour. The final report supersedes it and the pair stays in
   * the version history, which is what makes the prelim-to-final discrepancy
   * rate in `rad_peer_reviews` computable at all.
   */
  async issuePreliminary(reportId: string, body: SignReportRequest): Promise<RadReportView> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const report = await this.loadReport(tx, reportId);
        if (report.current_status !== 'draft' && report.current_status !== 'draft_for_cosign') {
          throw AppError.conflict('Only a draft can be issued as a preliminary read.');
        }

        const registration = await this.requireRegistration(tx, ctx.userId);
        await tx.query(
          `UPDATE rad.rad_report_versions
              SET status = 'preliminary', signed_by = $3, signed_at = now(),
                  sign_method = $4::clinical."SignMethod", signer_registration_no = $5,
                  impression_text = COALESCE($6, impression_text),
                  finding_level = COALESCE($7::rad."RadFindingLevel", finding_level)
            WHERE report_id = $1 AND version = $2`,
          [
            reportId,
            report.current_version,
            ctx.userId,
            body.signMethod,
            registration,
            body.impressionText ?? null,
            body.findingLevel ?? null,
          ],
        );

        await this.orders.advance(tx, report.order_id, report.order_item_id, 'preliminary', null);

        await this.audit.write(tx, {
          action: 'sign',
          entity: 'rad.rad_report_versions',
          rowId: reportId,
          businessKey: report.accession_no,
          dataClass: 'phi',
          patientId: report.patient_id,
          encounterId: null,
          before: { status: report.current_status },
          after: { status: 'preliminary', version: report.current_version },
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('rad.report.preliminary', reportId, {
            reportId,
            orderId: report.order_id,
            patientId: report.patient_id,
            authorUserId: ctx.userId ?? '',
            isResident: report.current_status === 'draft_for_cosign',
            issuedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(reportId);
  }

  /**
   * The signature.
   *
   * Two shapes, decided by what the report already is, and the difference is
   * forced by `rad.enforce_report_version_immutability()` rather than chosen:
   *
   *  * a **draft** (or a resident's `draft_for_cosign`) is signed in place. The
   *    trigger lets a draft change freely, because a draft is not yet a record.
   *  * a **preliminary read** is superseded by a *new* version. The trigger
   *    refuses to change the signer, the impression or the finding level of a
   *    version that has been issued — which is right: a wet read that could be
   *    quietly rewritten into the final report would destroy the prelim-to-final
   *    discrepancy rate `OP-008 §3.4.5` measures, and would let the pair of
   *    signatures collapse into one.
   *
   * Both paths run the same three gates on the way out, and none of them is in
   * this file: the dose record (`rad.enforce_dose_recorded`, D-41), Form F
   * (`rad.enforce_form_f`) and the critical-finding row
   * (`rad.enforce_critical_finding_raised`).
   */
  async sign(reportId: string, body: SignReportRequest): Promise<RadReportView> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const report = await this.loadReport(tx, reportId);
        if (['final', 'amended'].includes(report.current_status)) {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'This report is already signed. Amend it to change anything on it.',
          );
        }
        if (report.current_status === 'cancelled') {
          throw AppError.conflict('This report is cancelled.');
        }

        const version = await this.loadVersion(tx, reportId, report.current_version);
        const impression = body.impressionText ?? version.impression_text;
        if (impression === null || impression.trim().length === 0) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'A final report needs an impression: that is the part a clinician reads.',
          );
        }
        const findingLevel = body.findingLevel ?? version.finding_level;
        this.refuseFoetalSex(report.is_pcpndt, version.findings_text, impression, version.recommendations);

        // A resident's draft is finalised by the consultant, and the countersignature
        // is what makes it final. `rad.report.sign` is the key the resident does not
        // hold, so reaching here at all means the signer is entitled to sign; what is
        // checked here is that the countersignature is not the author's own.
        const cosign = report.current_status === 'draft_for_cosign';
        if (cosign && version.author_user_id !== null && version.author_user_id === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'A report sent for countersignature cannot be countersigned by the person who wrote it.',
          );
        }

        const supersedesPreliminary = report.current_status === 'preliminary';
        const targetVersion = supersedesPreliminary ? report.current_version + 1 : report.current_version;

        // The obligation raises itself, before the trigger looks for it.
        if (findingLevel === 'critical') {
          await this.ensureCriticalFinding(tx, report, impression, targetVersion);
        }

        const registration = await this.requireRegistration(tx, ctx.userId);
        const pcpndtRegistration = report.is_pcpndt
          ? await this.pcpndtRegistrationOf(tx, report.order_item_id)
          : null;

        if (supersedesPreliminary) {
          await this.insertVersion(tx, {
            reportId,
            version: targetVersion,
            status: 'final',
            templateKey: null,
            content: {},
            findingsText: version.findings_text,
            impressionText: impression,
            recommendations: version.recommendations ?? null,
            biRads: null,
            tiRads: null,
            liRads: null,
            pirads: null,
            findingLevel,
            keyImageRefs: [],
            measurements: null,
            authorUserId: version.author_user_id,
            authorRegistrationNo: await this.registrationOf(tx, version.author_user_id),
            amendmentReason: `Final report superseding the preliminary read at version ${String(report.current_version)}.`,
            signedBy: ctx.userId,
            signMethod: body.signMethod,
            signerRegistrationNo: registration,
            signerPcpndtRegistrationNo: pcpndtRegistration,
          });
          await tx.query(
            `UPDATE rad.rad_report_versions
                SET superseded_by_version = $3, superseded_at = now()
              WHERE report_id = $1 AND version = $2`,
            [reportId, report.current_version, targetVersion],
          );
        } else {
          await tx.query(
            `UPDATE rad.rad_report_versions
                SET status = 'final', signed_by = $3, signed_at = now(),
                    sign_method = $4::clinical."SignMethod", signer_registration_no = $5,
                    signer_pcpndt_registration_no = $6,
                    impression_text = $7,
                    finding_level = $8::rad."RadFindingLevel",
                    cosigner_user_id = CASE WHEN $9 THEN $3 ELSE cosigner_user_id END,
                    cosigned_at = CASE WHEN $9 THEN now() ELSE cosigned_at END,
                    verify_token = COALESCE(verify_token, $10)
              WHERE report_id = $1 AND version = $2`,
            [
              reportId,
              report.current_version,
              ctx.userId,
              body.signMethod,
              registration,
              pcpndtRegistration,
              impression,
              findingLevel,
              cosign,
              newId().replace(/-/g, ''),
            ],
          );
        }

        await this.releaseAndMaybeClose(tx, report, findingLevel);

        await this.audit.write(tx, {
          action: 'sign',
          entity: 'rad.rad_report_versions',
          rowId: reportId,
          businessKey: report.accession_no,
          dataClass: 'phi',
          patientId: report.patient_id,
          encounterId: null,
          before: { status: report.current_status, version: report.current_version },
          after: {
            status: 'final',
            version: targetVersion,
            finding_level: findingLevel,
            cosigned: cosign,
          },
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('rad.report.final', reportId, {
            reportId,
            orderId: report.order_id,
            accessionNo: report.accession_no,
            patientId: report.patient_id,
            signedByUserId: ctx.userId ?? '',
            version: targetVersion,
            hasCriticalFinding: findingLevel === 'critical',
            signedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(reportId);
  }

  /** A signed report is never edited: the amendment is the next version, with a reason. */
  async amend(reportId: string, body: AmendReportRequest): Promise<RadReportView> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const report = await this.loadReport(tx, reportId);
        if (!['final', 'amended'].includes(report.current_status)) {
          throw AppError.conflict('Only a signed report can be amended.');
        }
        this.refuseFoetalSex(report.is_pcpndt, body.findingsText, body.impressionText, body.recommendations);

        const nextVersion = report.current_version + 1;
        if (body.findingLevel === 'critical') {
          await this.ensureCriticalFinding(tx, report, body.impressionText, nextVersion);
        }

        const registration = await this.requireRegistration(tx, ctx.userId);
        const pcpndtRegistration = report.is_pcpndt
          ? await this.pcpndtRegistrationOf(tx, report.order_item_id)
          : null;

        await this.insertVersion(tx, {
          reportId,
          version: nextVersion,
          status: 'amended',
          templateKey: null,
          content: body.content,
          findingsText: body.findingsText ?? null,
          impressionText: body.impressionText,
          recommendations: body.recommendations ?? null,
          biRads: null,
          tiRads: null,
          liRads: null,
          pirads: null,
          findingLevel: body.findingLevel,
          keyImageRefs: [],
          measurements: null,
          authorUserId: ctx.userId,
          authorRegistrationNo: registration,
          amendmentReason: body.reason,
          signedBy: ctx.userId,
          signMethod: body.signMethod,
          signerRegistrationNo: registration,
          signerPcpndtRegistrationNo: pcpndtRegistration,
        });

        await tx.query(
          `UPDATE rad.rad_report_versions
              SET superseded_by_version = $3, superseded_at = now()
            WHERE report_id = $1 AND version = $2`,
          [reportId, report.current_version, nextVersion],
        );

        await this.releaseAndMaybeClose(tx, report, body.findingLevel);

        await this.audit.write(tx, {
          action: 'update',
          entity: 'rad.rad_report_versions',
          rowId: reportId,
          businessKey: report.accession_no,
          dataClass: 'phi',
          patientId: report.patient_id,
          encounterId: null,
          before: { version: report.current_version, status: report.current_status },
          after: { version: nextVersion, status: 'amended' },
          reasonText: body.reason,
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('rad.report.amended', reportId, {
            reportId,
            patientId: report.patient_id,
            version: nextVersion,
            reason: body.reason,
            amendedBy: ctx.userId ?? '',
            amendedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(reportId);
  }

  // ── critical findings (OP-008 §3.5, D-10) ─────────────────────────────────

  async raiseCritical(reportId: string, body: CriticalFindingRequest): Promise<CriticalFindingView> {
    let findingId = '';

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const report = await this.loadReport(tx, reportId);
        findingId = await this.insertFinding(tx, report, {
          level: body.level,
          findingText: body.findingText,
          reportVersion: report.current_version === 0 ? 1 : report.current_version,
          dueInMinutes: body.dueInMinutes,
          orderingUserId: body.orderingUserId ?? null,
        });
      }),
    );

    return this.getFinding(findingId);
  }

  /**
   * The documented call-back — `docs/DECISIONS.md D-10`, and the moment the
   * order may finally close.
   *
   * The row itself is `INSERT`-only (`migration.sql §D.1` revokes `UPDATE` and
   * `DELETE`), so this is a statement about something that happened rather than
   * a checkbox somebody can tick afterwards. Its CHECK admits a confirmed
   * read-back or a documented escalation and nothing else, and
   * `rad.sync_critical_finding_status()` moves the finding to `communicated` or
   * `escalated` from the same statement. Only then does the order line close.
   */
  async recordCallback(findingId: string, body: CriticalCallbackRequest): Promise<CriticalFindingView> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const finding = await this.loadFinding(tx, findingId);
        if (finding.status === 'retracted') {
          throw AppError.conflict('This finding was retracted; there is nothing left to communicate.');
        }

        const actor = await tx.maybeOne<{ display_name: string }>(
          `SELECT display_name FROM core.users WHERE id = $1`,
          [ctx.userId],
        );

        const sequence = await tx.one<{ next: string }>(
          `SELECT (COALESCE(max(sequence), 0) + 1)::text AS next
             FROM rad.rad_critical_callbacks WHERE finding_id = $1`,
          [findingId],
        );

        const callbackId = newId();
        await tx.query(
          `INSERT INTO rad.rad_critical_callbacks (
             id, hospital_id, finding_id, sequence, notified_by, notified_by_name, notified_at, method,
             notified_to_user_id, notified_to_name, notified_to_role, notified_to_contact,
             read_back_confirmed, read_back_value, clinician_unreachable,
             escalated_to_level, escalated_to_role, escalated_to_user_id,
             attempt_count, remarks, latency_seconds, created_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, now(), $7::lab."LabNotifyMethod",
             $8, $9, $10, $11,
             $12, $13, $14,
             $15, $16, $17,
             $18, $19,
             GREATEST(0, EXTRACT(EPOCH FROM (now() - $20::timestamptz))::int), $5
           )`,
          [
            callbackId,
            ctx.hospitalId,
            findingId,
            Number(sequence.next),
            ctx.userId,
            actor?.display_name ?? 'Unknown',
            body.method,
            body.notifiedToUserId ?? null,
            body.notifiedToName ?? null,
            body.notifiedToRole ?? null,
            body.notifiedToContact ?? null,
            body.readBackConfirmed,
            body.readBackValue ?? null,
            body.clinicianUnreachable,
            body.escalatedToLevel ?? null,
            body.escalatedToRole ?? null,
            body.escalatedToUserId ?? null,
            body.attemptCount,
            body.remarks ?? null,
            finding.detected_at,
          ],
        );

        const report = await this.loadReport(tx, finding.report_id);
        await this.releaseAndMaybeClose(tx, report, report.highest_finding_level);

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'rad.rad_critical_callbacks',
          rowId: callbackId,
          businessKey: report.accession_no,
          dataClass: 'phi',
          patientId: finding.patient_id,
          encounterId: null,
          before: null,
          after: {
            read_back_confirmed: body.readBackConfirmed,
            clinician_unreachable: body.clinicianUnreachable,
            escalated_to_role: body.escalatedToRole ?? null,
          },
          sensitivity: 'sensitive',
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('rad.critical.acknowledged', findingId, {
            findingId,
            reportId: finding.report_id,
            patientId: finding.patient_id,
            outcome: body.readBackConfirmed ? 'read_back_confirmed' : 'clinician_unreachable_escalated',
            calledByUserId: ctx.userId ?? '',
            informedPersonName: body.notifiedToName ?? body.escalatedToRole ?? 'escalated',
            minutesFromRaise: Math.max(
              0,
              Math.floor((Date.now() - new Date(finding.detected_at).getTime()) / 60_000),
            ),
            acknowledgedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.getFinding(findingId);
  }

  async listCriticals(query: WorklistQuery): Promise<Page<CriticalFindingView>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = 'rad.critical_findings';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${String(values.push(value))}`;
      const clauses: string[] = [];
      if (query.status !== undefined) {
        clauses.push(`f.status = ${bind(query.status)}::lab."LabCriticalAlertStatus"`);
      }
      if (after !== null) {
        clauses.push(`(f.detected_at, f.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<FindingRow & { cursor_key: string }>(
        `${FINDING_SELECT} ${where}
          ORDER BY f.detected_at DESC, f.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );
      const page = this.cursors.keysetPage<FindingRow>(rows, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });
      return { items: page.items.map(toFindingView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  // ── peer review (OP-008 §3.4.5, RADPEER) ──────────────────────────────────

  async peerReview(reportId: string, body: PeerReviewRequest): Promise<{ readonly id: string }> {
    const id = newId();

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const report = await this.loadReport(tx, reportId);
        const signer = await tx.maybeOne<{ signed_by: string | null }>(
          `SELECT signed_by FROM rad.rad_report_versions
            WHERE report_id = $1 ORDER BY version DESC LIMIT 1`,
          [reportId],
        );
        if (signer?.signed_by !== null && signer?.signed_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'A peer review is somebody else reading the same study. Reviewing your own report is not a peer review.',
          );
        }

        await tx.query(
          `INSERT INTO rad.rad_peer_reviews (
             id, hospital_id, branch_id, report_id, reviewer_user_id, score, discrepancy_type,
             is_prelim_final_comparison, prelim_version, final_version, comment, sampling_basis,
             reviewed_at, created_by, updated_by, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $5, $5, now())`,
          [
            id,
            ctx.hospitalId,
            report.branch_id,
            reportId,
            ctx.userId,
            body.score,
            body.discrepancyType,
            body.isPrelimFinalComparison,
            body.prelimVersion ?? null,
            body.finalVersion ?? null,
            body.comment ?? null,
            body.samplingBasis ?? null,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'rad.rad_peer_reviews',
          rowId: id,
          businessKey: report.accession_no,
          dataClass: 'phi',
          patientId: report.patient_id,
          encounterId: null,
          before: null,
          after: { score: body.score, discrepancy_type: body.discrepancyType },
        });
      }),
    );

    return { id };
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async get(reportId: string): Promise<RadReportView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const report = await this.loadReport(tx, reportId);
      const versions = await tx.rows<VersionRow>(
        `SELECT version, status::text AS status, finding_level::text AS finding_level,
                impression_text, findings_text, author_user_id, cosigner_user_id, signed_by,
                signed_at::text AS signed_at, amendment_reason, content_sha256, prev_sha256
           FROM rad.rad_report_versions WHERE report_id = $1 ORDER BY version`,
        [reportId],
      );
      const open = await tx.one<{ open: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM rad.rad_critical_findings f
            WHERE f.report_id = $1 AND f.level = 'critical' AND f.status = 'open'
         ) AS open`,
        [reportId],
      );

      return {
        id: report.id,
        orderItemId: report.order_item_id,
        patientId: report.patient_id,
        accessionNo: report.accession_no,
        currentVersion: report.current_version,
        currentStatus: report.current_status,
        highestFindingLevel: report.highest_finding_level,
        awaitingCriticalCallback: open.open,
        versions: versions.map(toVersionView),
      };
    });
  }

  async readingWorklist(query: WorklistQuery): Promise<Page<ReadingWorklistItem>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = 'rad.reading_worklist';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${String(values.push(value))}`;
      const clauses: string[] = [
        `i.status IN ('acquired', 'awaiting_report', 'preliminary')`,
        `i.status NOT IN ('cancelled', 'rejected')`,
      ];
      if (query.modality !== undefined) {
        clauses.push(`i.modality = ${bind(query.modality)}::mdm."RadModality"`);
      }
      if (after !== null) {
        clauses.push(`(o.ordered_at, i.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }

      const rows = await tx.rows<ReadingWorklistRow & { cursor_key: string }>(
        `SELECT i.id, i.order_id, i.procedure_name, i.modality::text AS modality,
                i.status::text AS status, o.accession_no, o.patient_id,
                o.priority::text AS priority, o.clinical_indication,
                i.tat_due_at::text AS tat_due_at, r.id AS report_id,
                o.ordered_at::text AS ordered_at, o.ordered_at::text AS cursor_key
           FROM rad.rad_order_items i
           JOIN rad.rad_orders o ON o.id = i.order_id
           LEFT JOIN rad.rad_reports r ON r.order_item_id = i.id
          WHERE ${clauses.join(' AND ')}
          ORDER BY o.ordered_at DESC, i.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<ReadingWorklistRow>(rows, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });
      return {
        items: page.items.map((r) => ({
          orderItemId: r.id,
          orderId: r.order_id,
          reportId: r.report_id,
          accessionNo: r.accession_no,
          patientId: r.patient_id,
          procedureName: r.procedure_name,
          modality: r.modality,
          priority: r.priority,
          status: r.status,
          clinicalIndication: r.clinical_indication,
          tatDueAt: r.tat_due_at,
          orderedAt: r.ordered_at,
        })),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  async getFinding(findingId: string): Promise<CriticalFindingView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<FindingRow>(`${FINDING_SELECT} WHERE f.id = $1`, [findingId]);
      if (row === undefined) throw AppError.notFound('The critical finding');
      return toFindingView(row);
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Closes the order line only when the report is final **and** no critical
   * finding on it is still `open`.
   *
   * This is where D-10's two halves land. The version is already `final` by the
   * time this runs and `rad.report.final` is already on its way, so the report is
   * released whatever happens here. What is conditional is the closure: an order
   * that closed over an open critical would take the finding off every worklist
   * that exists to chase it.
   */
  private async releaseAndMaybeClose(
    tx: TransactionClient,
    report: ReportRow,
    findingLevel: string,
  ): Promise<void> {
    const open = await tx.one<{ open: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM rad.rad_critical_findings f
          WHERE f.report_id = $1 AND f.level = 'critical' AND f.status = 'open'
       ) AS open`,
      [report.id],
    );

    const to = open.open ? 'preliminary' : 'reported';
    await this.orders.advance(
      tx,
      report.order_id,
      report.order_item_id,
      to,
      open.open
        ? `Released; awaiting the documented communication of a ${findingLevel} finding (D-10).`
        : null,
    );
  }

  private async ensureCriticalFinding(
    tx: TransactionClient,
    report: ReportRow,
    findingText: string,
    version?: number,
  ): Promise<void> {
    const existing = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM rad.rad_critical_findings
        WHERE report_id = $1 AND level = 'critical' AND status <> 'retracted' LIMIT 1`,
      [report.id],
    );
    if (existing !== undefined) return;

    await this.insertFinding(tx, report, {
      level: 'critical',
      findingText,
      reportVersion: version ?? report.current_version,
      dueInMinutes: 60,
      orderingUserId: null,
    });
  }

  private async insertFinding(
    tx: TransactionClient,
    report: ReportRow,
    input: {
      readonly level: 'incidental' | 'urgent' | 'critical';
      readonly findingText: string;
      readonly reportVersion: number;
      readonly dueInMinutes: number;
      readonly orderingUserId: string | null;
    },
  ): Promise<string> {
    const ctx = getContext();
    const findingId = newId();
    const orderingUserId =
      input.orderingUserId ??
      (
        await tx.maybeOne<{ ordering_user_id: string | null }>(
          `SELECT ordering_user_id FROM rad.rad_orders WHERE id = $1`,
          [report.order_id],
        )
      )?.ordering_user_id ??
      null;

    await tx.query(
      `INSERT INTO rad.rad_critical_findings (
         id, hospital_id, branch_id, report_id, report_version, order_item_id, patient_id,
         level, finding_text, detected_by, detected_at, due_by, status, ordering_user_id,
         created_by, updated_by, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8::rad."RadFindingLevel", $9, $10, now(), now() + ($11 || ' minutes')::interval, 'open', $12,
         $10, $10, now()
       )`,
      [
        findingId,
        ctx.hospitalId,
        report.branch_id,
        report.id,
        input.reportVersion,
        report.order_item_id,
        report.patient_id,
        input.level,
        input.findingText,
        ctx.userId,
        String(input.dueInMinutes),
        orderingUserId,
      ],
    );

    await this.audit.write(tx, {
      action: 'insert',
      entity: 'rad.rad_critical_findings',
      rowId: findingId,
      businessKey: report.accession_no,
      dataClass: 'phi',
      patientId: report.patient_id,
      encounterId: null,
      before: null,
      after: { level: input.level, report_version: input.reportVersion },
      sensitivity: 'sensitive',
    });

    if (input.level !== 'incidental') {
      await this.outbox.publish(
        tx,
        radiologyEvent('rad.result.critical', findingId, {
          findingId,
          reportId: report.id,
          orderId: report.order_id,
          patientId: report.patient_id,
          orderingDoctorUserId: orderingUserId,
          level: input.level === 'critical' ? 'critical' : 'significant_unexpected',
          summary: input.findingText.slice(0, 500),
          raisedBy: ctx.userId ?? '',
          raisedAt: new Date().toISOString(),
        }),
      );
    }

    return findingId;
  }

  private async insertVersion(tx: TransactionClient, input: VersionInput): Promise<void> {
    const ctx = getContext();
    await tx.query(
      `INSERT INTO rad.rad_report_versions (
         id, hospital_id, report_id, version, status, template_key, content,
         findings_text, impression_text, recommendations, bi_rads, ti_rads, li_rads, pirads,
         finding_level, key_image_refs, measurements, author_user_id, author_registration_no,
         signed_by, signed_at, sign_method, signer_registration_no, signer_pcpndt_registration_no,
         amendment_reason, verify_token, created_by
       ) VALUES (
         $1, $2, $3, $4, $5::rad."RadReportStatus", $6, $7::jsonb,
         $8, $9, $10, $11, $12, $13, $14,
         $15::rad."RadFindingLevel", $16::text[], $17::jsonb, $18, $19,
         $20, CASE WHEN $20::uuid IS NULL THEN NULL ELSE now() END,
         $21::clinical."SignMethod", $22, $23,
         $24, $25, $18
       )`,
      [
        newId(),
        ctx.hospitalId,
        input.reportId,
        input.version,
        input.status,
        input.templateKey,
        JSON.stringify(input.content),
        input.findingsText,
        input.impressionText,
        input.recommendations,
        input.biRads,
        input.tiRads,
        input.liRads,
        input.pirads,
        input.findingLevel,
        input.keyImageRefs,
        input.measurements === null ? null : JSON.stringify(input.measurements),
        input.authorUserId,
        input.authorRegistrationNo,
        input.signedBy ?? null,
        input.signMethod ?? null,
        input.signerRegistrationNo ?? null,
        input.signerPcpndtRegistrationNo ?? null,
        input.amendmentReason,
        newId().replace(/-/g, ''),
      ],
    );
  }

  /**
   * `OP-008 §5`: "Reports signed only by radiologists with valid registration."
   *
   * The registration is read from the practitioner master rather than taken from
   * the request, because it is what prints on the report and what an assessor
   * checks. A signature with no registration behind it is refused here, and the
   * CHECK on `rad_report_versions` refuses it again.
   */
  private async requireRegistration(tx: TransactionClient, userId: string | null): Promise<string> {
    const registration = await this.registrationOf(tx, userId);
    if (registration === null) {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'Your practitioner record carries no council registration number, and a radiology report is signed under one.',
        { nextAction: 'Ask master data to complete your practitioner record before signing.' },
      );
    }
    return registration;
  }

  private async registrationOf(tx: TransactionClient, userId: string | null): Promise<string | null> {
    if (userId === null) return null;
    const row = await tx.maybeOne<{ registration_number: string | null }>(
      `SELECT registration_number FROM mdm.mdm_practitioners
        WHERE user_id = $1 AND status = 'active' ORDER BY version DESC LIMIT 1`,
      [userId],
    );
    return row?.registration_number ?? null;
  }

  /** The signer's registration under the PC-PNDT Act, taken from the Form F they signed. */
  private async pcpndtRegistrationOf(tx: TransactionClient, orderItemId: string): Promise<string | null> {
    const row = await tx.maybeOne<{ performed_by_registration_no: string }>(
      `SELECT performed_by_registration_no FROM rad.rad_form_f WHERE order_item_id = $1`,
      [orderItemId],
    );
    return row?.performed_by_registration_no ?? null;
  }

  /**
   * Section 5 of the PC-PNDT Act 1994 prohibits communicating the sex of a
   * foetus "in any manner", and a free-text impression is a manner.
   *
   * There is no column to hold it and no request field that maps to one, so this
   * is the remaining route — and it refuses rather than redacts, because a
   * product that silently stripped the phrase would be helping to communicate
   * whatever was left.
   */
  private refuseFoetalSex(isPcpndt: boolean, ...values: readonly (string | null | undefined)[]): void {
    if (!isPcpndt) return;
    if (!mentionsFoetalSex(...values)) return;
    throw new AppError(
      ProblemType.STATUTORY_LIMIT,
      'This report is for a procedure covered by the PC-PNDT Act 1994, and the text communicates the sex of the foetus. Section 5 prohibits that in any manner; Section 23 makes it punishable with imprisonment.',
      {
        clinicalImpact:
          'The product records no foetal sex anywhere, by construction. This text is refused whole rather than edited, because a partial removal would still be a communication.',
        nextAction: 'Remove the reference and submit the report again.',
        reference: 'PC-PNDT Act 1994, ss. 5 and 23',
      },
    );
  }

  private async loadReport(tx: TransactionClient, reportId: string): Promise<ReportRow> {
    const row = await tx.maybeOne<ReportRow>(
      `SELECT r.id, r.order_item_id, r.patient_id, r.branch_id, r.accession_no,
              r.current_version, r.current_status::text AS current_status,
              r.highest_finding_level::text AS highest_finding_level,
              i.order_id, i.is_pcpndt, i.is_ionising
         FROM rad.rad_reports r
         JOIN rad.rad_order_items i ON i.id = r.order_item_id
        WHERE r.id = $1`,
      [reportId],
    );
    if (row === undefined) throw AppError.notFound('The radiology report');
    return row;
  }

  private async loadVersion(tx: TransactionClient, reportId: string, version: number): Promise<VersionRow> {
    const row = await tx.maybeOne<VersionRow>(
      `SELECT version, status::text AS status, finding_level::text AS finding_level,
              impression_text, findings_text, recommendations, author_user_id, cosigner_user_id,
              signed_by, signed_at::text AS signed_at, amendment_reason, content_sha256, prev_sha256
         FROM rad.rad_report_versions WHERE report_id = $1 AND version = $2`,
      [reportId, version],
    );
    if (row === undefined) throw AppError.notFound('The report version');
    return row;
  }

  private async loadFinding(tx: TransactionClient, findingId: string): Promise<FindingRow> {
    const row = await tx.maybeOne<FindingRow>(`${FINDING_SELECT} WHERE f.id = $1`, [findingId]);
    if (row === undefined) throw AppError.notFound('The critical finding');
    return row;
  }
}

// ── rows and projections ────────────────────────────────────────────────────

const FINDING_SELECT = `
  SELECT f.id, f.report_id, f.patient_id, f.level::text AS level, f.status::text AS status,
         f.finding_text, f.detected_at::text AS detected_at, f.due_by::text AS due_by,
         f.first_communicated_at::text AS first_communicated_at, f.escalation_level,
         (SELECT count(*) FROM rad.rad_critical_callbacks c WHERE c.finding_id = f.id)::int AS callback_count,
         f.detected_at::text AS cursor_key
    FROM rad.rad_critical_findings f`;

interface ReportRow {
  readonly id: string;
  readonly order_item_id: string;
  readonly order_id: string;
  readonly patient_id: string;
  readonly branch_id: string;
  readonly accession_no: string;
  readonly current_version: number;
  readonly current_status: string;
  readonly highest_finding_level: string;
  readonly is_pcpndt: boolean;
  readonly is_ionising: boolean;
}

interface VersionRow {
  readonly version: number;
  readonly status: string;
  readonly finding_level: string;
  readonly impression_text: string | null;
  readonly findings_text: string | null;
  readonly recommendations?: string | null;
  readonly author_user_id: string | null;
  readonly cosigner_user_id: string | null;
  readonly signed_by: string | null;
  readonly signed_at: string | null;
  readonly amendment_reason: string | null;
  readonly content_sha256: string;
  readonly prev_sha256: string | null;
}

interface FindingRow {
  readonly id: string;
  readonly report_id: string;
  readonly patient_id: string;
  readonly level: string;
  readonly status: string;
  readonly finding_text: string;
  readonly detected_at: string;
  readonly due_by: string | null;
  readonly first_communicated_at: string | null;
  readonly escalation_level: number;
  readonly callback_count: number;
}

interface ReadingWorklistRow {
  readonly id: string;
  readonly order_id: string;
  readonly report_id: string | null;
  readonly accession_no: string;
  readonly patient_id: string;
  readonly procedure_name: string;
  readonly modality: string;
  readonly priority: string;
  readonly status: string;
  readonly clinical_indication: string;
  readonly tat_due_at: string | null;
  readonly ordered_at: string;
}

export interface ReadingWorklistItem {
  readonly orderItemId: string;
  readonly orderId: string;
  readonly reportId: string | null;
  readonly accessionNo: string;
  readonly patientId: string;
  readonly procedureName: string;
  readonly modality: string;
  readonly priority: string;
  readonly status: string;
  readonly clinicalIndication: string;
  readonly tatDueAt: string | null;
  readonly orderedAt: string;
}

interface VersionInput {
  readonly reportId: string;
  readonly version: number;
  readonly status: string;
  readonly templateKey: string | null;
  readonly content: Readonly<Record<string, unknown>>;
  readonly findingsText: string | null;
  readonly impressionText: string | null;
  readonly recommendations: string | null;
  readonly biRads: string | null;
  readonly tiRads: string | null;
  readonly liRads: string | null;
  readonly pirads: string | null;
  readonly findingLevel: string;
  readonly keyImageRefs: readonly string[];
  readonly measurements: Readonly<Record<string, unknown>> | null;
  readonly authorUserId: string | null;
  readonly authorRegistrationNo: string | null;
  readonly amendmentReason: string | null;
  readonly signedBy?: string | null;
  readonly signMethod?: string | null;
  readonly signerRegistrationNo?: string | null;
  readonly signerPcpndtRegistrationNo?: string | null;
}

function toVersionView(row: VersionRow): RadReportVersionView {
  return {
    version: row.version,
    status: row.status,
    findingLevel: row.finding_level,
    impressionText: row.impression_text,
    findingsText: row.findings_text,
    authorUserId: row.author_user_id,
    cosignerUserId: row.cosigner_user_id,
    signedBy: row.signed_by,
    signedAt: row.signed_at,
    amendmentReason: row.amendment_reason,
    contentSha256: row.content_sha256,
    prevSha256: row.prev_sha256,
  };
}

function toFindingView(row: FindingRow): CriticalFindingView {
  return {
    id: row.id,
    reportId: row.report_id,
    patientId: row.patient_id,
    level: row.level,
    status: row.status,
    findingText: row.finding_text,
    detectedAt: row.detected_at,
    dueBy: row.due_by,
    firstCommunicatedAt: row.first_communicated_at,
    escalationLevel: row.escalation_level,
    callbackCount: Number(row.callback_count),
  };
}
