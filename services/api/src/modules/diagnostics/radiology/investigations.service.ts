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
import { withDatabaseRefusals } from './radiology.errors.js';
import { radiologyEvent } from './radiology.events.js';
import { mentionsFoetalSex } from './radiology.schemas.js';
import type {
  AmendInvestigationReportRequest,
  CosignInvestigationReportRequest,
  CreateInvestigationStudyRequest,
  DetachMediaRequest,
  DoneInvestigationRequest,
  InvestigationMediaRequest,
  InvestigationReportRequest,
  InvestigationWorklistQuery,
  SignInvestigationReportRequest,
  StartInvestigationRequest,
} from './radiology.schemas.js';
import type {
  InvestigationReportVersionView,
  InvestigationReportView,
  InvestigationStudyView,
} from './radiology.types.js';

/**
 * OP-022 — the investigation console: everything that is neither a lab analyzer
 * nor a DICOM modality. ECG strips, endoscopy stills, PFT traces, outside
 * reports.
 *
 * **Co-signature is the reason this module exists separately from radiology.**
 * `OP-022 §5`: "residents cannot finalise services with `cosign_required`". Two
 * things enforce it and they are deliberately different in kind:
 * `clinical.enforce_investigation_cosign()` refuses at the row — a version with
 * no countersigner cannot reach `final` on such a service, and a countersignature
 * by the author is refused as "a signature, not a countersignature" — while this
 * service asserts `invest.report.cosign` before it tries, so a resident gets a
 * 403 that names the key rather than a constraint violation from four layers
 * down. The trigger is the guarantee; the assertion is the manners.
 *
 * **The PC-PNDT text check lives here and not in radiology, and that is not an
 * inconsistency.** A radiology report has no field that could carry a foetal sex
 * and no override — the schema assertion in `migration.sql §C.7` sees to that.
 * An investigation service, though, may legitimately be an obstetric ultrasound
 * performed on a machine too old to speak DICOM, so `OP-022 §5` puts a keyword
 * validator on the free text with an override "by authorised doctor & reason",
 * and `investigation_report_versions` carries the three columns that record the
 * verdict and the override. The check is recorded on every version of a
 * PC-PNDT-flagged service, passing or failing.
 *
 * **The accession comes from `RAD_ACC`.** `OP-022 §5` says the accession series
 * is "shared with OP-008", and it is: one patient, one visit, one number
 * whichever console the study is performed on. The report number is derived from
 * it rather than allocated from OP-022's own `INV_RPT` series, because that
 * series is not seeded in `packages/db` and this module may not add it —
 * recorded as a gap rather than papered over with a second, divergent series.
 */
@Injectable()
export class InvestigationsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  // ── the study ─────────────────────────────────────────────────────────────

  async createStudy(body: CreateInvestigationStudyRequest): Promise<InvestigationStudyView> {
    const ctx = getContext();
    const branchId = body.branchId ?? ctx.branchId;
    if (branchId === null) throw AppError.conflict('An investigation study belongs to a branch.');
    const id = newId();

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const service = await this.loadService(tx, body.serviceKey);
        const allocation = await this.numbering.allocate(tx, {
          key: 'RAD_ACC',
          branchId,
          refType: 'clinical.investigation_studies',
          refId: id,
        });

        await tx.query(
          `INSERT INTO clinical.investigation_studies (
             id, hospital_id, branch_id, clinical_order_id, patient_id, visit_id, encounter_id,
             accession_no, service_key, service_name, modality_group, priority, status,
             device_ref, scheduled_at, tat_due_at, is_pcpndt, is_ionising,
             created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11::mdm."InvestigationModalityGroup", $12::lab."LabPriority",
             CASE WHEN $13::timestamptz IS NULL THEN 'ordered' ELSE 'scheduled' END::clinical."InvestigationStudyStatus",
             $14, $13::timestamptz,
             CASE WHEN $15::int IS NULL THEN NULL ELSE now() + ($15::int || ' minutes')::interval END,
             $16, $17,
             $18, $18, now()
           )`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.clinicalOrderId ?? null,
            body.patientId,
            body.visitId ?? null,
            body.encounterId ?? null,
            allocation.formatted,
            body.serviceKey,
            service.name,
            service.modality_group,
            body.priority,
            body.scheduledAt ?? null,
            body.deviceRef ?? null,
            service.tat_report_minutes,
            service.is_pcpndt,
            service.is_ionising,
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'clinical.investigation_studies',
          rowId: id,
          businessKey: allocation.formatted,
          dataClass: 'phi',
          patientId: body.patientId,
          encounterId: body.encounterId ?? null,
          before: null,
          after: { service: service.name, priority: body.priority },
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('investigation.scheduled', id, {
            studyId: id,
            orderId: body.clinicalOrderId ?? id,
            patientId: body.patientId,
            serviceKey: body.serviceKey,
            priority: body.priority,
            scheduledFor: new Date(body.scheduledAt ?? new Date().toISOString()).toISOString(),
          }),
        );
      }),
    );

    return this.getStudy(id);
  }

  async checkIn(studyId: string): Promise<InvestigationStudyView> {
    await this.transition(studyId, 'checked_in', async (tx, study) => {
      await tx.query(`UPDATE clinical.investigation_studies SET checked_in_at = now() WHERE id = $1`, [
        studyId,
      ]);
      await this.outbox.publish(
        tx,
        radiologyEvent('investigation.checked_in', studyId, {
          studyId,
          orderId: study.clinical_order_id ?? studyId,
          patientId: study.patient_id,
          checkedInAt: new Date().toISOString(),
        }),
      );
    });
    return this.getStudy(studyId);
  }

  /** `OP-022 §5`: identity verification before any capture. The CHECK says so too. */
  async start(studyId: string, body: StartInvestigationRequest): Promise<InvestigationStudyView> {
    await this.transition(studyId, 'in_progress', async (tx, study) => {
      const ctx = getContext();
      await tx.query(
        `UPDATE clinical.investigation_studies
            SET identity_verified = true, identity_method = $2, technician_user_id = $3
          WHERE id = $1`,
        [studyId, body.identityMethod, ctx.userId],
      );
      await this.outbox.publish(
        tx,
        radiologyEvent('investigation.started', studyId, {
          studyId,
          patientId: study.patient_id,
          performedByUserId: ctx.userId ?? '',
          identityVerified: true,
          startedAt: new Date().toISOString(),
        }),
      );
    });
    return this.getStudy(studyId);
  }

  /**
   * `OP-022 §5`: "Radiation investigations (dental X-ray, fluoro stills) log
   * dose via OP-008 dose register." The CHECK
   * `investigation_studies_dose_recorded` refuses a performed ionising study
   * with no dose reference, so the console cannot become a way around the
   * register.
   */
  async done(studyId: string, body: DoneInvestigationRequest): Promise<InvestigationStudyView> {
    await this.transition(studyId, 'awaiting_report', async (tx, study) => {
      if (study.is_ionising && body.doseRecordRef === undefined) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'This investigation uses ionising radiation, so it is entered in the OP-008 dose register before it is marked done.',
          {
            nextAction: 'Record the dose against the exam and send its reference with this request.',
            reference: 'OP-022 §5; AERB dose register',
          },
        );
      }
      const mediaCount = await tx.one<{ count: string }>(
        `SELECT count(*)::text AS count FROM clinical.investigation_media
          WHERE study_id = $1 AND deleted_at IS NULL AND detached_at IS NULL`,
        [studyId],
      );

      await tx.query(
        `UPDATE clinical.investigation_studies
            SET performed_at = now(), technique_notes = COALESCE($2, technique_notes),
                repeat_flag = $3, repeat_reason = $4,
                dose_record_ref = COALESCE($5::uuid, dose_record_ref)
          WHERE id = $1`,
        [
          studyId,
          body.techniqueNotes ?? null,
          body.repeatFlag,
          body.repeatReason ?? null,
          body.doseRecordRef ?? null,
        ],
      );

      await this.outbox.publish(
        tx,
        radiologyEvent('investigation.done', studyId, {
          studyId,
          orderId: study.clinical_order_id ?? studyId,
          patientId: study.patient_id,
          mediaCount: Number(mediaCount.count),
          completedAt: new Date().toISOString(),
        }),
      );
    });
    return this.getStudy(studyId);
  }

  // ── media ─────────────────────────────────────────────────────────────────

  async addMedia(studyId: string, body: InvestigationMediaRequest): Promise<{ readonly id: string }> {
    const id = newId();

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const study = await this.loadStudy(tx, studyId);
        if (!study.identity_verified) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'Nothing is captured against a study until the patient has been identified with two identifiers.',
            { reference: 'OP-022 §5' },
          );
        }

        await tx.query(
          `INSERT INTO clinical.investigation_media (
             id, hospital_id, study_id, patient_id, kind, file_id, thumbnail_file_id, mime_type,
             size_bytes, duration_seconds, sequence_no, source, sop_instance_uid,
             uploaded_by, uploaded_at, created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5::clinical."InvestigationMediaKind", $6, $7, $8,
             $9, $10, $11, $12::clinical."InvestigationMediaSource", $13,
             $14, now(), $14, $14, now()
           )`,
          [
            id,
            ctx.hospitalId,
            studyId,
            study.patient_id,
            body.kind,
            body.fileId,
            body.thumbnailFileId ?? null,
            body.mimeType,
            body.sizeBytes,
            body.durationSeconds ?? null,
            body.sequenceNo,
            body.source,
            body.sopInstanceUid ?? null,
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'clinical.investigation_media',
          rowId: id,
          businessKey: study.accession_no,
          dataClass: 'phi',
          patientId: study.patient_id,
          encounterId: null,
          before: null,
          after: { kind: body.kind, source: body.source },
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('investigation.media.added', id, {
            mediaId: id,
            studyId,
            patientId: study.patient_id,
            mediaType: body.kind,
            uploadedBy: ctx.userId ?? '',
            at: new Date().toISOString(),
          }),
        );
      }),
    );

    return { id };
  }

  /** `OP-022 §5`: "detach/move requires reason & audit; deletion soft only." */
  async detachMedia(mediaId: string, body: DetachMediaRequest): Promise<{ readonly detached: true }> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const rows = await tx.rows<{ study_id: string; patient_id: string }>(
          `UPDATE clinical.investigation_media
              SET detached_at = now(), detach_reason = $2, detached_by = $3, updated_at = now()
            WHERE id = $1 AND detached_at IS NULL
            RETURNING study_id, patient_id`,
          [mediaId, body.reason, ctx.userId],
        );
        const row = rows[0];
        if (row === undefined) throw AppError.notFound('The media');

        await this.audit.write(tx, {
          action: 'update',
          entity: 'clinical.investigation_media',
          rowId: mediaId,
          businessKey: null,
          dataClass: 'phi',
          patientId: row.patient_id,
          encounterId: null,
          before: { detached_at: null },
          after: { detached_at: new Date().toISOString() },
          reasonText: body.reason,
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('investigation.media.detached', mediaId, {
            mediaId,
            fromStudyId: row.study_id,
            toStudyId: null,
            reason: body.reason,
            detachedBy: ctx.userId ?? '',
            at: new Date().toISOString(),
          }),
        );
      }),
    );

    return { detached: true };
  }

  // ── the report ────────────────────────────────────────────────────────────

  async createReport(studyId: string, body: InvestigationReportRequest): Promise<InvestigationReportView> {
    const ctx = getContext();
    let reportId = '';

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const study = await this.loadStudy(tx, studyId);
        const service = await this.loadService(tx, study.service_key);

        const existing = await tx.maybeOne<{ id: string }>(
          `SELECT id FROM clinical.investigation_reports WHERE study_id = $1`,
          [studyId],
        );
        if (existing !== undefined) {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This study already has a report.');
        }

        reportId = newId();
        await tx.query(
          `INSERT INTO clinical.investigation_reports (
             id, hospital_id, branch_id, study_id, patient_id, report_no, cosign_required,
             created_by, updated_by, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, now())`,
          [
            reportId,
            ctx.hospitalId,
            study.branch_id,
            studyId,
            study.patient_id,
            `${study.accession_no}/R`,
            service.cosign_required,
            ctx.userId,
          ],
        );

        await this.insertVersion(tx, {
          reportId,
          version: 1,
          status: service.cosign_required ? 'draft_for_cosign' : 'draft',
          templateKey: body.templateKey ?? null,
          body: body.body,
          impression: body.impression ?? null,
          critical: body.critical,
          criticalAckRef: null,
          authorUserId: ctx.userId ?? '',
          pcpndtTextCheckPassed: study.is_pcpndt ? !mentionsFoetalSex(body.impression) : null,
          amendmentReason: null,
        });

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'clinical.investigation_reports',
          rowId: reportId,
          businessKey: `${study.accession_no}/R`,
          dataClass: 'phi',
          patientId: study.patient_id,
          encounterId: null,
          before: null,
          after: { cosign_required: service.cosign_required, version: 1 },
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('investigation.report.draft', reportId, {
            reportId,
            studyId,
            orderId: study.clinical_order_id ?? studyId,
            patientId: study.patient_id,
            authorUserId: ctx.userId ?? '',
            cosignRequired: service.cosign_required,
            at: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.getReport(reportId);
  }

  async sendForCosign(reportId: string): Promise<InvestigationReportView> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const report = await this.loadReport(tx, reportId);
        if (report.current_status !== 'draft' && report.current_status !== 'draft_for_cosign') {
          throw AppError.conflict('Only a draft can be sent for countersignature.');
        }
        await tx.query(
          `UPDATE clinical.investigation_report_versions SET status = 'draft_for_cosign'
            WHERE report_id = $1 AND version = $2`,
          [reportId, report.current_version],
        );
        await this.outbox.publish(
          tx,
          radiologyEvent('investigation.report.cosign.requested', reportId, {
            reportId,
            patientId: report.patient_id,
            requestedBy: ctx.userId ?? '',
            consultantUserId: null,
            slaMinutes: 240,
            at: new Date().toISOString(),
          }),
        );
      }),
    );
    return this.getReport(reportId);
  }

  /**
   * `OP-022 §5`: the critical flag and the communication that must precede the
   * signature.
   *
   * The `critical_ack_ref` stored on the version is the id of the **audit row**
   * that records the communication. There is no dedicated table in this schema
   * for an investigation call-back, and inventing one here would put a second,
   * divergent record of the same fact beside `core.audit_log` — which is already
   * the tamper-evident, hash-chained, never-deleted record an assessor reads.
   * Pointing at it is stronger than duplicating it.
   */
  async flagCritical(
    reportId: string,
    input: { readonly summary: string; readonly informedName: string; readonly method: string },
  ): Promise<InvestigationReportView> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const report = await this.loadReport(tx, reportId);
        if (!['draft', 'draft_for_cosign'].includes(report.current_status)) {
          throw AppError.conflict(
            'Flag the finding critical before the report is signed; afterwards it is an amendment.',
          );
        }

        const ackId = await this.audit.write(tx, {
          action: 'sign',
          entity: 'clinical.investigation_report_versions',
          rowId: reportId,
          businessKey: null,
          dataClass: 'phi',
          patientId: report.patient_id,
          encounterId: null,
          before: null,
          after: {
            critical: true,
            informed_name: input.informedName,
            method: input.method,
            summary: input.summary.slice(0, 500),
          },
          reasonText: `Critical investigation finding communicated to ${input.informedName} by ${input.method}.`,
          sensitivity: 'sensitive',
        });

        await tx.query(
          `UPDATE clinical.investigation_report_versions
              SET critical = true, critical_ack_ref = $3
            WHERE report_id = $1 AND version = $2`,
          [reportId, report.current_version, ackId],
        );
        await tx.query(
          `UPDATE clinical.investigation_reports SET ever_critical = true, updated_at = now() WHERE id = $1`,
          [reportId],
        );

        await this.outbox.publish(
          tx,
          radiologyEvent('investigation.critical.flagged', reportId, {
            reportId,
            studyId: report.study_id,
            patientId: report.patient_id,
            orderingDoctorUserId: null,
            summary: input.summary.slice(0, 500),
            flaggedBy: ctx.userId ?? '',
            at: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.getReport(reportId);
  }

  async sign(reportId: string, body: SignInvestigationReportRequest): Promise<InvestigationReportView> {
    return this.finalise(reportId, {
      signMethod: body.signMethod,
      impression: body.impression,
      pcpndtOverrideReason: body.pcpndtOverrideReason,
      isCosign: false,
      discrepancy: null,
      cosignChanges: null,
    });
  }

  async cosign(reportId: string, body: CosignInvestigationReportRequest): Promise<InvestigationReportView> {
    return this.finalise(reportId, {
      signMethod: body.signMethod,
      impression: body.impression,
      isCosign: true,
      discrepancy: body.discrepancy,
      cosignChanges: body.cosignChanges ?? null,
    });
  }

  async amend(reportId: string, body: AmendInvestigationReportRequest): Promise<InvestigationReportView> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const report = await this.loadReport(tx, reportId);
        if (!['final', 'amended'].includes(report.current_status)) {
          throw AppError.conflict('Only a signed report can be amended.');
        }
        const study = await this.loadStudy(tx, report.study_id);
        const passed = study.is_pcpndt ? !mentionsFoetalSex(body.impression) : null;
        if (passed === false) this.refuseFoetalSex();

        const previous = await tx.one<{ critical_ack_ref: string | null }>(
          `SELECT critical_ack_ref FROM clinical.investigation_report_versions
            WHERE report_id = $1 AND version = $2`,
          [reportId, report.current_version],
        );
        if (body.critical && previous.critical_ack_ref === null) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'An amended report that carries a critical finding needs the communication on record before it is signed.',
          );
        }

        const nextVersion = report.current_version + 1;
        await this.insertVersion(tx, {
          reportId,
          version: nextVersion,
          status: 'amended',
          templateKey: null,
          body: body.body,
          impression: body.impression,
          critical: body.critical,
          criticalAckRef: body.critical ? previous.critical_ack_ref : null,
          authorUserId: ctx.userId ?? '',
          pcpndtTextCheckPassed: passed,
          amendmentReason: body.reason,
          signedBy: ctx.userId,
          signMethod: body.signMethod,
          cosignerUserId: report.cosign_required ? ctx.userId : null,
        });

        await tx.query(
          `UPDATE clinical.investigation_report_versions
              SET superseded_by_version = $3, superseded_at = now()
            WHERE report_id = $1 AND version = $2`,
          [reportId, report.current_version, nextVersion],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'clinical.investigation_report_versions',
          rowId: reportId,
          businessKey: null,
          dataClass: 'phi',
          patientId: report.patient_id,
          encounterId: null,
          before: { version: report.current_version },
          after: { version: nextVersion, status: 'amended' },
          reasonText: body.reason,
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('investigation.report.amended', reportId, {
            reportId,
            patientId: report.patient_id,
            version: nextVersion,
            reason: body.reason,
            amendedBy: ctx.userId ?? '',
            at: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.getReport(reportId);
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async getStudy(studyId: string): Promise<InvestigationStudyView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<StudyRow & { media_count: string }>(
        `${STUDY_SELECT}, (SELECT count(*) FROM clinical.investigation_media m
                             WHERE m.study_id = s.id AND m.deleted_at IS NULL AND m.detached_at IS NULL
                          )::text AS media_count
           FROM clinical.investigation_studies s WHERE s.id = $1`,
        [studyId],
      );
      if (row === undefined) throw AppError.notFound('The investigation study');
      return toStudyView(row, Number(row.media_count));
    });
  }

  async worklist(query: InvestigationWorklistQuery): Promise<Page<InvestigationStudyView>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = 'clinical.investigation_studies';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${String(values.push(value))}`;
      const clauses: string[] = [];
      if (query.status !== undefined) {
        clauses.push(`s.status = ${bind(query.status)}::clinical."InvestigationStudyStatus"`);
      }
      if (query.modalityGroup !== undefined) {
        clauses.push(`s.modality_group = ${bind(query.modalityGroup)}::mdm."InvestigationModalityGroup"`);
      }
      if (after !== null) {
        clauses.push(`(s.created_at, s.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<StudyRow & { cursor_key: string; media_count: string }>(
        `${STUDY_SELECT}, (SELECT count(*) FROM clinical.investigation_media m
                             WHERE m.study_id = s.id AND m.deleted_at IS NULL AND m.detached_at IS NULL
                          )::text AS media_count,
                s.created_at::text AS cursor_key
           FROM clinical.investigation_studies s
           ${where}
          ORDER BY s.created_at DESC, s.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<StudyRow & { media_count: string }>(rows, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });
      return {
        items: page.items.map((r) => toStudyView(r, Number(r.media_count))),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  async getReport(reportId: string): Promise<InvestigationReportView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const report = await this.loadReport(tx, reportId);
      const versions = await tx.rows<VersionRow>(
        `SELECT version, status::text AS status, critical, impression, author_user_id, cosigner_user_id,
                discrepancy, signed_by, signed_at::text AS signed_at, pcpndt_text_check_passed,
                content_sha256, prev_sha256
           FROM clinical.investigation_report_versions WHERE report_id = $1 ORDER BY version`,
        [reportId],
      );
      return {
        id: report.id,
        studyId: report.study_id,
        patientId: report.patient_id,
        reportNo: report.report_no,
        currentVersion: report.current_version,
        currentStatus: report.current_status,
        cosignRequired: report.cosign_required,
        everCritical: report.ever_critical,
        versions: versions.map(toVersionView),
      };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async finalise(
    reportId: string,
    input: {
      readonly signMethod: string;
      readonly impression: string | undefined;
      readonly pcpndtOverrideReason?: string | undefined;
      readonly isCosign: boolean;
      readonly discrepancy: string | null;
      readonly cosignChanges: Readonly<Record<string, unknown>> | null;
    },
  ): Promise<InvestigationReportView> {
    // Asserted before the transaction opens: a resident must be told they lack
    // the consultant's key, not shown a trigger's message about countersignatures.
    const requiresCosign = await this.cosignRequired(reportId);
    if (requiresCosign && !input.isCosign) {
      await this.policy.assert('invest.report.cosign');
    }

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const report = await this.loadReport(tx, reportId);
        if (['final', 'amended'].includes(report.current_status)) {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This report is already signed.');
        }
        const study = await this.loadStudy(tx, report.study_id);

        const version = await tx.one<{
          impression: string | null;
          critical: boolean;
          critical_ack_ref: string | null;
          author_user_id: string;
        }>(
          `SELECT impression, critical, critical_ack_ref, author_user_id
             FROM clinical.investigation_report_versions WHERE report_id = $1 AND version = $2`,
          [reportId, report.current_version],
        );

        const impression = input.impression ?? version.impression;
        if (impression === null || impression.trim().length === 0) {
          throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, 'A signed report needs an impression.');
        }
        if (version.critical && version.critical_ack_ref === null) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'A critical finding is communicated before the report is released. Record the call first; the report is not withheld once it is.',
            { reference: 'OP-022 §5' },
          );
        }

        // The keyword validator. Its verdict is recorded on the version whether it
        // passes or fails, and only a named doctor with a reason may proceed past
        // a failure.
        const passed = study.is_pcpndt ? !mentionsFoetalSex(impression) : null;
        if (passed === false && input.pcpndtOverrideReason === undefined) this.refuseFoetalSex();

        await tx.query(
          `UPDATE clinical.investigation_report_versions
              SET status = 'final', signed_by = $3, signed_at = now(),
                  sign_method = $4::clinical."SignMethod", impression = $5,
                  cosigner_user_id = CASE WHEN $6 THEN $3 ELSE cosigner_user_id END,
                  cosigned_at = CASE WHEN $6 THEN now() ELSE cosigned_at END,
                  cosign_changes = COALESCE($7::jsonb, cosign_changes),
                  discrepancy = COALESCE($8, discrepancy),
                  pcpndt_text_check_passed = $9,
                  pcpndt_override_by = CASE WHEN $10::text IS NULL THEN NULL ELSE $3 END,
                  pcpndt_override_reason = $10
            WHERE report_id = $1 AND version = $2`,
          [
            reportId,
            report.current_version,
            ctx.userId,
            input.signMethod,
            impression,
            requiresCosign,
            input.cosignChanges === null ? null : JSON.stringify(input.cosignChanges),
            input.discrepancy,
            passed,
            input.pcpndtOverrideReason ?? null,
          ],
        );

        await tx.query(
          `UPDATE clinical.investigation_studies SET status = 'reported', updated_at = now() WHERE id = $1`,
          [report.study_id],
        );

        await this.audit.write(tx, {
          action: 'sign',
          entity: 'clinical.investigation_report_versions',
          rowId: reportId,
          businessKey: report.report_no,
          dataClass: 'phi',
          patientId: report.patient_id,
          encounterId: null,
          before: { status: report.current_status },
          after: {
            status: 'final',
            version: report.current_version,
            cosigned: requiresCosign,
            pcpndt_text_check_passed: passed,
          },
        });

        if (input.isCosign) {
          await this.outbox.publish(
            tx,
            radiologyEvent('investigation.report.cosign.approved', reportId, {
              reportId,
              patientId: report.patient_id,
              cosignedBy: ctx.userId ?? '',
              discrepancy: input.discrepancy !== null && input.discrepancy !== 'none',
              at: new Date().toISOString(),
            }),
          );
        }

        await this.outbox.publish(
          tx,
          radiologyEvent('investigation.report.final', reportId, {
            reportId,
            studyId: report.study_id,
            orderId: study.clinical_order_id ?? report.study_id,
            patientId: report.patient_id,
            signedBy: ctx.userId ?? '',
            version: report.current_version,
            critical: version.critical,
            at: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.getReport(reportId);
  }

  private async cosignRequired(reportId: string): Promise<boolean> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<{ cosign_required: boolean }>(
        `SELECT cosign_required FROM clinical.investigation_reports WHERE id = $1`,
        [reportId],
      );
      if (row === undefined) throw AppError.notFound('The investigation report');
      return row.cosign_required;
    });
  }

  private async transition(
    studyId: string,
    to: string,
    extra: (tx: TransactionClient, study: StudyRow) => Promise<void>,
  ): Promise<void> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const study = await this.loadStudy(tx, studyId);
        if (study.status === 'cancelled') throw AppError.conflict('This study is cancelled.');

        await tx.query(
          `UPDATE clinical.investigation_studies
              SET status = $2::clinical."InvestigationStudyStatus", updated_by = $3,
                  updated_at = now(), version = version + 1
            WHERE id = $1`,
          [studyId, to, getContext().userId],
        );
        await extra(tx, study);

        await this.audit.write(tx, {
          action: 'update',
          entity: 'clinical.investigation_studies',
          rowId: studyId,
          businessKey: study.accession_no,
          dataClass: 'phi',
          patientId: study.patient_id,
          encounterId: null,
          before: { status: study.status },
          after: { status: to },
        });
      }),
    );
  }

  private async insertVersion(tx: TransactionClient, input: InvestigationVersionInput): Promise<void> {
    const ctx = getContext();
    await tx.query(
      `INSERT INTO clinical.investigation_report_versions (
         id, hospital_id, report_id, version, status, template_key, body, impression,
         critical, critical_ack_ref, author_user_id, cosigner_user_id, cosigned_at,
         signed_by, signed_at, sign_method, pcpndt_text_check_passed, amendment_reason,
         verify_token, created_by
       ) VALUES (
         $1, $2, $3, $4, $5::clinical."InvestigationReportStatus", $6, $7::jsonb, $8,
         $9, $10, $11, $12, CASE WHEN $12::uuid IS NULL THEN NULL ELSE now() END,
         $13, CASE WHEN $13::uuid IS NULL THEN NULL ELSE now() END,
         $14::clinical."SignMethod", $15, $16,
         $17, $11
       )`,
      [
        newId(),
        ctx.hospitalId,
        input.reportId,
        input.version,
        input.status,
        input.templateKey,
        JSON.stringify(input.body),
        input.impression,
        input.critical,
        input.criticalAckRef,
        input.authorUserId,
        input.cosignerUserId ?? null,
        input.signedBy ?? null,
        input.signMethod ?? null,
        input.pcpndtTextCheckPassed,
        input.amendmentReason,
        newId().replace(/-/g, ''),
      ],
    );
  }

  private refuseFoetalSex(): never {
    throw new AppError(
      ProblemType.STATUTORY_LIMIT,
      'This service is flagged under the PC-PNDT Act 1994 and the report text communicates the sex of the foetus. Section 5 prohibits that in any manner; Section 23 makes it punishable with imprisonment.',
      {
        clinicalImpact:
          'No field in this product records a foetal sex. The keyword check is the last route, and it refuses rather than redacts.',
        nextAction:
          'Remove the reference. If the check has misread clinically necessary wording, an authorised doctor may override it with a recorded reason.',
        reference: 'PC-PNDT Act 1994, ss. 5 and 23; OP-022 §5',
      },
    );
  }

  private async loadStudy(tx: TransactionClient, studyId: string): Promise<StudyRow> {
    const row = await tx.maybeOne<StudyRow>(
      `${STUDY_SELECT} FROM clinical.investigation_studies s WHERE s.id = $1`,
      [studyId],
    );
    if (row === undefined) throw AppError.notFound('The investigation study');
    return row;
  }

  private async loadReport(tx: TransactionClient, reportId: string): Promise<ReportRow> {
    const row = await tx.maybeOne<ReportRow>(
      `SELECT id, study_id, patient_id, report_no, current_version,
              current_status::text AS current_status, cosign_required, ever_critical
         FROM clinical.investigation_reports WHERE id = $1`,
      [reportId],
    );
    if (row === undefined) throw AppError.notFound('The investigation report');
    return row;
  }

  private async loadService(tx: TransactionClient, serviceKey: string): Promise<ServiceRow> {
    const row = await tx.maybeOne<ServiceRow>(
      `SELECT record_key, name, modality_group::text AS modality_group, cosign_required,
              is_pcpndt, is_ionising, tat_report_minutes, requires_media
         FROM mdm.mdm_investigation_services
        WHERE record_key = $1 AND status = 'active'
          AND effective_from <= now() AND (effective_to IS NULL OR effective_to > now())
        ORDER BY effective_from DESC, version DESC LIMIT 1`,
      [serviceKey],
    );
    if (row === undefined) {
      throw new AppError(
        ProblemType.RETIRED_MASTER_RECORD,
        'That investigation service is not an active, effective-dated entry in the master.',
      );
    }
    return row;
  }
}

// ── rows and projections ────────────────────────────────────────────────────

const STUDY_SELECT = `
  SELECT s.id, s.accession_no, s.patient_id, s.branch_id, s.clinical_order_id, s.service_key,
         s.service_name, s.modality_group::text AS modality_group, s.priority::text AS priority,
         s.status::text AS status, s.is_pcpndt, s.is_ionising, s.identity_verified,
         s.scheduled_at::text AS scheduled_at, s.performed_at::text AS performed_at`;

interface StudyRow {
  readonly id: string;
  readonly accession_no: string;
  readonly patient_id: string;
  readonly branch_id: string;
  readonly clinical_order_id: string | null;
  readonly service_key: string;
  readonly service_name: string;
  readonly modality_group: string;
  readonly priority: string;
  readonly status: string;
  readonly is_pcpndt: boolean;
  readonly is_ionising: boolean;
  readonly identity_verified: boolean;
  readonly scheduled_at: string | null;
  readonly performed_at: string | null;
}

interface ReportRow {
  readonly id: string;
  readonly study_id: string;
  readonly patient_id: string;
  readonly report_no: string;
  readonly current_version: number;
  readonly current_status: string;
  readonly cosign_required: boolean;
  readonly ever_critical: boolean;
}

interface VersionRow {
  readonly version: number;
  readonly status: string;
  readonly critical: boolean;
  readonly impression: string | null;
  readonly author_user_id: string;
  readonly cosigner_user_id: string | null;
  readonly discrepancy: string | null;
  readonly signed_by: string | null;
  readonly signed_at: string | null;
  readonly pcpndt_text_check_passed: boolean | null;
  readonly content_sha256: string;
  readonly prev_sha256: string | null;
}

interface ServiceRow {
  readonly record_key: string;
  readonly name: string;
  readonly modality_group: string;
  readonly cosign_required: boolean;
  readonly is_pcpndt: boolean;
  readonly is_ionising: boolean;
  readonly tat_report_minutes: number | null;
  readonly requires_media: boolean;
}

interface InvestigationVersionInput {
  readonly reportId: string;
  readonly version: number;
  readonly status: string;
  readonly templateKey: string | null;
  readonly body: Readonly<Record<string, unknown>>;
  readonly impression: string | null;
  readonly critical: boolean;
  readonly criticalAckRef: string | null;
  readonly authorUserId: string;
  readonly pcpndtTextCheckPassed: boolean | null;
  readonly amendmentReason: string | null;
  readonly signedBy?: string | null;
  readonly signMethod?: string | null;
  readonly cosignerUserId?: string | null;
}

function toStudyView(row: StudyRow, mediaCount: number): InvestigationStudyView {
  return {
    id: row.id,
    accessionNo: row.accession_no,
    patientId: row.patient_id,
    serviceKey: row.service_key,
    serviceName: row.service_name,
    modalityGroup: row.modality_group,
    priority: row.priority,
    status: row.status,
    isPcpndt: row.is_pcpndt,
    isIonising: row.is_ionising,
    mediaCount,
    scheduledAt: row.scheduled_at,
    performedAt: row.performed_at,
  };
}

function toVersionView(row: VersionRow): InvestigationReportVersionView {
  return {
    version: row.version,
    status: row.status,
    critical: row.critical,
    impression: row.impression,
    authorUserId: row.author_user_id,
    cosignerUserId: row.cosigner_user_id,
    discrepancy: row.discrepancy,
    signedBy: row.signed_by,
    signedAt: row.signed_at,
    pcpndtTextCheckPassed: row.pcpndt_text_check_passed,
    contentSha256: row.content_sha256,
    prevSha256: row.prev_sha256,
  };
}
