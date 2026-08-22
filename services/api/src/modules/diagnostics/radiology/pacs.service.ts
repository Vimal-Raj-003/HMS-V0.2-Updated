import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { RadAccessService } from './rad-access.service.js';
import { withDatabaseRefusals } from './radiology.errors.js';
import { radiologyEvent } from './radiology.events.js';
import type {
  IngestStudyRequest,
  MppsRequest,
  PurgePlanRequest,
  ReconcileStudyRequest,
  RevokeShareLinkRequest,
  ShareLinkRequest,
  StudyQuery,
  ViewerTokenRequest,
} from './radiology.schemas.js';
import type { PacsStudyView, ViewerGrantView } from './radiology.types.js';

/**
 * EN-008 — the archive index, the disclosure record, and retention.
 *
 * **This service stores references, never pixels.** `pacs_studies`,
 * `pacs_series` and `pacs_instances` hold Study/Series/SOP Instance UIDs, the
 * Orthanc object ids, counts and byte sizes. The images live in Orthanc; the
 * viewer reaches them through the gateway with a short-lived token this service
 * issues. `EN-008 §4` draws the line and `EN-035 §5` repeats it: "the order and
 * the report belong to OP-008, the pixels and the study metadata belong to
 * EN-008, and neither writes the other's tables."
 *
 * **Nothing is attached to a patient on a guess.** `EN-008 §5`: "Study
 * auto-links only when accession matches; fallback match creates
 * `reconciliation_status = needs_review` (never silently attach to wrong
 * patient)." `ingest()` matches on the Study Instance UID the RIS generated, on
 * the worklist entry, or on the accession number, and each of those is an
 * identity the RIS itself minted. A demographic resemblance is a `fallback`, and
 * a fallback is never confirmed by this service — it goes to the reconciliation
 * queue for a named human, and the CHECK on `pacs_studies` refuses to let a
 * fallback-matched study be marked reconciled at all. A study with no confident
 * match has **no patient**, which is why `pacs_studies.patient_id` is nullable:
 * a study on the wrong patient is worse than a study nobody can find.
 */
@Injectable()
export class PacsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(RadAccessService) private readonly access: RadAccessService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  // ── ingestion (EN-008 §3, the Orthanc callback) ───────────────────────────

  async ingest(body: IngestStudyRequest): Promise<PacsStudyView> {
    const ctx = getContext();
    let studyId = '';

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const existing = await tx.maybeOne<{ id: string; branch_id: string }>(
          `SELECT id, branch_id FROM rad.pacs_studies WHERE study_instance_uid = $1`,
          [body.studyInstanceUid],
        );

        const match = await this.match(tx, body);
        studyId = existing?.id ?? newId();
        const branchId = existing?.branch_id ?? match.branchId ?? ctx.branchId;
        if (branchId === null) {
          throw AppError.conflict(
            'This study cannot be indexed without a branch: it matched no order and the session is not acting in one.',
          );
        }

        const totals = body.series.reduce(
          (acc, s) => ({
            instances: acc.instances + s.instances.length,
            bytes: acc.bytes + s.instances.reduce((b, i) => b + BigInt(i.sizeBytes), 0n),
          }),
          { instances: 0, bytes: 0n },
        );

        await tx.query(
          `INSERT INTO rad.pacs_studies (
             id, hospital_id, branch_id, study_instance_uid, server_id, orthanc_id,
             patient_id, uhid_at_acquisition, accession_no, order_item_id, exam_id,
             modality, body_part_dicom, study_date, description,
             series_count, instance_count, size_bytes, status, tier,
             matched_by, reconciliation_status, is_mlc, is_pcpndt,
             first_stored_at, last_stored_at, created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11,
             $12::mdm."RadModality", $13, $14::timestamptz, $15,
             $16, $17, $18, 'acquired', 'hot',
             $19::rad."PacsMatchBasis", $20::rad."PacsReconciliationStatus", $21, $22,
             now(), now(), $23, $23, now()
           )
           ON CONFLICT (hospital_id, study_instance_uid) DO UPDATE SET
             orthanc_id = COALESCE(EXCLUDED.orthanc_id, rad.pacs_studies.orthanc_id),
             series_count = GREATEST(rad.pacs_studies.series_count, EXCLUDED.series_count),
             instance_count = GREATEST(rad.pacs_studies.instance_count, EXCLUDED.instance_count),
             size_bytes = GREATEST(rad.pacs_studies.size_bytes, EXCLUDED.size_bytes),
             status = 'acquired',
             last_stored_at = now(),
             updated_by = EXCLUDED.updated_by, updated_at = now(),
             version = rad.pacs_studies.version + 1`,
          [
            studyId,
            ctx.hospitalId,
            branchId,
            body.studyInstanceUid,
            body.serverId ?? null,
            body.orthancId ?? null,
            match.patientId,
            body.uhidAtAcquisition ?? null,
            match.accessionNo ?? body.accessionNo ?? null,
            match.orderItemId,
            match.examId,
            body.modality ?? match.modality,
            body.bodyPartDicom ?? null,
            body.studyDate ?? null,
            body.description ?? null,
            body.series.length,
            totals.instances,
            totals.bytes.toString(10),
            match.basis,
            match.reconciliation,
            match.isMlc,
            match.isPcpndt,
            ctx.userId,
          ],
        );

        for (const series of body.series) {
          const seriesId = newId();
          await tx.query(
            `INSERT INTO rad.pacs_series (
               id, hospital_id, study_id, series_instance_uid, series_number, orthanc_id, modality,
               body_part_dicom, description, sop_class_uid, instance_count, size_bytes,
               is_dose_sr, is_structured_report, created_by, updated_by, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::mdm."RadModality", $8, $9, $10, $11, $12, $13, $14, $15, $15, now())
             ON CONFLICT (hospital_id, series_instance_uid) DO UPDATE SET
               instance_count = GREATEST(rad.pacs_series.instance_count, EXCLUDED.instance_count),
               size_bytes = GREATEST(rad.pacs_series.size_bytes, EXCLUDED.size_bytes),
               updated_at = now()
             RETURNING id`,
            [
              seriesId,
              ctx.hospitalId,
              studyId,
              series.seriesInstanceUid,
              series.seriesNumber ?? null,
              series.orthancId ?? null,
              series.modality ?? body.modality ?? null,
              body.bodyPartDicom ?? null,
              series.description ?? null,
              series.sopClassUid ?? null,
              series.instances.length,
              series.instances.reduce((b, i) => b + BigInt(i.sizeBytes), 0n).toString(10),
              series.isDoseSr,
              series.isStructuredReport,
              ctx.userId,
            ],
          );

          const resolved = await tx.one<{ id: string }>(
            `SELECT id FROM rad.pacs_series WHERE series_instance_uid = $1`,
            [series.seriesInstanceUid],
          );

          for (const instance of series.instances) {
            await tx.query(
              `INSERT INTO rad.pacs_instances (
                 id, hospital_id, series_id, study_id, sop_instance_uid, sop_class_uid,
                 instance_number, orthanc_id, size_bytes, transfer_syntax_uid, number_of_frames,
                 is_rdsr, stored_at, created_by
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13)
               ON CONFLICT DO NOTHING`,
              [
                newId(),
                ctx.hospitalId,
                resolved.id,
                studyId,
                instance.sopInstanceUid,
                instance.sopClassUid ?? null,
                instance.instanceNumber ?? null,
                instance.orthancId ?? null,
                instance.sizeBytes,
                instance.transferSyntaxUid ?? null,
                instance.numberOfFrames ?? null,
                instance.isRdsr,
                ctx.userId,
              ],
            );
          }
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'rad.pacs_studies',
          rowId: studyId,
          businessKey: body.studyInstanceUid,
          dataClass: 'phi',
          patientId: match.patientId,
          encounterId: null,
          before: null,
          after: {
            matched_by: match.basis,
            reconciliation_status: match.reconciliation,
            instance_count: totals.instances,
          },
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('pacs.study.acquired', studyId, {
            studyId,
            accessionNo: match.accessionNo ?? body.accessionNo ?? '',
            seriesCount: body.series.length,
            instanceCount: totals.instances,
            at: new Date().toISOString(),
          }),
        );

        if (match.patientId === null || match.reconciliation === 'needs_review') {
          const payload = {
            studyId,
            studyInstanceUid: body.studyInstanceUid,
            dicomPatientRef: body.uhidAtAcquisition ?? 'unknown',
            accessionRef: body.accessionNo ?? null,
          };
          await this.outbox.publish(
            tx,
            radiologyEvent('pacs.study.unmatched', studyId, { ...payload, at: new Date().toISOString() }),
          );
          await this.outbox.publish(
            tx,
            radiologyEvent('rad.study.unmatched', studyId, {
              ...payload,
              detectedAt: new Date().toISOString(),
            }),
          );
        } else {
          await this.outbox.publish(
            tx,
            radiologyEvent('pacs.study.images_available', studyId, {
              studyId,
              accessionNo: match.accessionNo ?? '',
              patientId: match.patientId,
              at: new Date().toISOString(),
            }),
          );
          if (match.orderId !== null) {
            await this.outbox.publish(
              tx,
              radiologyEvent('rad.study.available', studyId, {
                studyId,
                orderId: match.orderId,
                accessionNo: match.accessionNo ?? '',
                patientId: match.patientId,
                instanceCount: totals.instances,
                availableAt: new Date().toISOString(),
              }),
            );
          }
        }
      }),
    );

    return this.getStudy(studyId, { audit: false });
  }

  /** MPPS: the modality tells the RIS the step began or ended, with no keystroke. */
  async mpps(body: MppsRequest): Promise<{ readonly accepted: true }> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const branchId = ctx.branchId;
        if (branchId === null) throw AppError.conflict('An MPPS message must arrive in a branch context.');

        await tx.query(
          `INSERT INTO rad.pacs_mpps_events (
             id, hospital_id, branch_id, sop_instance_uid, study_instance_uid, accession_no,
             modality_aet, status, started_at, ended_at, discontinue_reason, received_at, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11, now(), $12)`,
          [
            newId(),
            ctx.hospitalId,
            branchId,
            body.sopInstanceUid,
            body.studyInstanceUid ?? null,
            body.accessionNo ?? null,
            body.modalityAet,
            body.status,
            body.startedAt ?? null,
            body.endedAt ?? null,
            body.discontinueReason ?? null,
          ],
        );

        if (body.studyInstanceUid !== undefined) {
          await tx.query(
            `UPDATE rad.pacs_studies
                SET status = CASE WHEN $2 = 'IN PROGRESS' THEN 'in_progress'::rad."PacsStudyStatus"
                                  WHEN $2 = 'COMPLETED' THEN 'acquired'::rad."PacsStudyStatus"
                                  ELSE 'incomplete'::rad."PacsStudyStatus" END,
                    updated_at = now()
              WHERE study_instance_uid = $1`,
            [body.studyInstanceUid, body.status],
          );
        }
      }),
    );

    return { accepted: true };
  }

  // ── reads, scoped and audited ─────────────────────────────────────────────

  async listStudies(query: StudyQuery): Promise<Page<PacsStudyView>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = 'rad.pacs_studies';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      // A list is not a disclosure of one study, but a list of *one patient's*
      // studies is a question about that patient, so it carries the same scope.
      if (query.patientId !== undefined && !(await this.access.isCareTeam(tx, query.patientId))) {
        const reason = ctx.reason;
        if (reason === null || reason.trim().length < 8) {
          throw new AppError(
            ProblemType.BREAK_GLASS_REASON_REQUIRED,
            'This patient is not in your care team. Say why you need their imaging history.',
            { nextAction: 'Retry with an `x-reason` header explaining the clinical need.' },
          );
        }
      }

      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${String(values.push(value))}`;
      const clauses: string[] = [];
      if (query.patientId !== undefined) clauses.push(`s.patient_id = ${bind(query.patientId)}::uuid`);
      if (query.reconciliationStatus !== undefined) {
        clauses.push(
          `s.reconciliation_status = ${bind(query.reconciliationStatus)}::rad."PacsReconciliationStatus"`,
        );
      }
      if (after !== null) {
        clauses.push(`(s.created_at, s.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<StudyRow & { cursor_key: string }>(
        `${STUDY_SELECT} ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT ${bind(limit + 1)}`,
        values,
      );
      const page = this.cursors.keysetPage<StudyRow>(rows, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });
      return { items: page.items.map(toStudyView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  async getStudy(
    studyId: string,
    options: { readonly audit: boolean } = { audit: true },
  ): Promise<PacsStudyView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<StudyRow>(`${STUDY_SELECT} WHERE s.id = $1`, [studyId]);
      if (row === undefined) throw AppError.notFound('The study');
      if (options.audit) {
        await this.access.authoriseAndAudit(tx, {
          studyId: row.id,
          studyInstanceUid: row.study_instance_uid,
          patientId: row.patient_id,
          action: 'view',
          instanceCount: row.instance_count,
        });
      }
      return toStudyView(row);
    });
  }

  /**
   * Issues the short-lived token the OHIF viewer and the DICOMweb gateway
   * present to Orthanc.
   *
   * `EN-008 §5`: "Viewer access only through signed short-lived tokens; direct
   * Orthanc ports not exposed beyond hub/viewer gateway; every view logged;
   * break-glass (outside care team) requires reason." Only the SHA-256 of the
   * token is stored, for the same reason a password hash is: the row is a record
   * that a grant was issued, not a copy of the credential.
   */
  async issueViewerToken(studyId: string, body: ViewerTokenRequest): Promise<ViewerGrantView> {
    const ctx = getContext();

    return withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const row = await tx.maybeOne<StudyRow>(`${STUDY_SELECT} WHERE s.id = $1`, [studyId]);
        if (row === undefined) throw AppError.notFound('The study');

        if (row.reconciliation_status === 'needs_review') {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'This study is waiting in the reconciliation queue: nobody has confirmed whose it is. It cannot be opened for reading until somebody does.',
            { reference: 'EN-008 §5 — never silently attach to the wrong patient' },
          );
        }

        const decision = await this.access.authoriseAndAudit(tx, {
          studyId: row.id,
          studyInstanceUid: row.study_instance_uid,
          patientId: row.patient_id,
          action: body.action,
          instanceCount: row.instance_count,
        });

        const token = randomBytes(32).toString('base64url');
        const tokenId = newId();
        const expiresAt = new Date(Date.now() + body.expiresInMinutes * 60_000);

        await tx.query(
          `INSERT INTO rad.pacs_access_tokens (
             id, hospital_id, user_id, patient_id, token_hash, study_uids, scope, purpose,
             break_glass_reason, issued_at, expires_at, max_uses, issued_ip, created_by
           ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, now(), $10::timestamptz, $11, $12::inet, $3)`,
          [
            tokenId,
            ctx.hospitalId,
            ctx.userId,
            row.patient_id,
            createHash('sha256').update(token).digest('hex'),
            [row.study_instance_uid],
            body.scope,
            decision.purpose,
            decision.breakGlass ? decision.reason : null,
            expiresAt.toISOString(),
            50,
            ctx.ip,
          ],
        );

        return {
          studyId: row.id,
          studyInstanceUid: row.study_instance_uid,
          tokenId,
          token,
          scope: body.scope,
          purpose: decision.purpose,
          expiresAt: expiresAt.toISOString(),
          breakGlass: decision.breakGlass,
          orthancId: row.orthanc_id,
        };
      }),
    );
  }

  // ── reconciliation (EN-008 §3.3) ──────────────────────────────────────────

  /**
   * The named human decision that attaches a study to a patient.
   *
   * A study the archive matched on the accession number or the Study Instance
   * UID may be *confirmed* with one click, because those are identities the RIS
   * itself minted. A **fallback** match may not: it is a demographic
   * resemblance, and confirming it without saying which patient is meant is
   * precisely the "silently attach to wrong patient" EN-008 §5 forbids. The
   * CHECK `pacs_studies_match_requires_review` enforces the same thing from
   * underneath — a `fallback` row cannot hold any reconciliation status other
   * than `needs_review` — so a service that let this through would fail on the
   * `UPDATE` rather than write a wrong answer.
   */
  async reconcile(studyId: string, body: ReconcileStudyRequest): Promise<PacsStudyView> {
    const ctx = getContext();

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const row = await tx.maybeOne<StudyRow>(`${STUDY_SELECT} WHERE s.id = $1`, [studyId]);
        if (row === undefined) throw AppError.notFound('The study');
        if (row.reconciliation_status === 'reconciled') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This study has already been reconciled.');
        }

        const guessed = row.matched_by === 'fallback' || row.matched_by === 'unmatched';
        if (guessed && body.patientId === undefined) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'This study was matched on a demographic resemblance, not on an accession number or a Study Instance UID. Confirming it means naming the patient it belongs to.',
            {
              clinicalImpact:
                'A study attached to the wrong patient puts one person’s imaging in another’s chart, and the report that follows is written about the wrong body.',
              nextAction: 'Send the reconciliation again with the patient you have verified it belongs to.',
              reference: 'EN-008 §5 — never silently attach to wrong patient',
            },
          );
        }

        if (row.patient_id !== null && body.patientId !== undefined && body.patientId !== row.patient_id) {
          throw new AppError(
            ProblemType.APPROVAL_REQUIRED,
            'Moving a study from one patient to another is a re-assignment, not a reconciliation: EN-008 §5 requires a second pair of eyes on it.',
            { nextAction: 'Raise it as a PACS correction so a second authorised user can approve it.' },
          );
        }

        const patientId = body.patientId ?? row.patient_id;
        if (patientId === null) throw AppError.notFound('The patient');
        await this.assertPatientVisible(tx, patientId);

        const item =
          body.orderItemId === undefined
            ? null
            : await tx.maybeOne<{ id: string; order_id: string; accession_no: string }>(
                `SELECT i.id, i.order_id, o.accession_no
                   FROM rad.rad_order_items i JOIN rad.rad_orders o ON o.id = i.order_id
                  WHERE i.id = $1`,
                [body.orderItemId],
              );
        if (body.orderItemId !== undefined && item === null)
          throw AppError.notFound('The imaging order line');

        await tx.query(
          `UPDATE rad.pacs_studies
              SET patient_id = $2,
                  order_item_id = COALESCE($3::uuid, order_item_id),
                  accession_no = COALESCE($4, accession_no),
                  matched_by = 'manual',
                  reconciliation_status = 'reconciled',
                  reconciliation_note = $5,
                  updated_by = $6, updated_at = now(), version = version + 1
            WHERE id = $1`,
          [studyId, patientId, item?.id ?? null, item?.accession_no ?? null, body.note ?? null, ctx.userId],
        );

        const correctionId = newId();
        await tx.query(
          `INSERT INTO rad.pacs_corrections
             (id, hospital_id, study_id, type, before, after, reason, performed_by, at, created_by)
           VALUES ($1, $2, $3, 'accession_fix', $4::jsonb, $5::jsonb, $6, $7, now(), $7)`,
          [
            correctionId,
            ctx.hospitalId,
            studyId,
            JSON.stringify({ patient_id: row.patient_id, matched_by: row.matched_by }),
            JSON.stringify({ patient_id: patientId, matched_by: 'manual' }),
            ctx.reason ?? body.note ?? 'Reconciled by a named operator.',
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'rad.pacs_studies',
          rowId: studyId,
          businessKey: row.study_instance_uid,
          dataClass: 'phi',
          patientId,
          encounterId: null,
          before: { patient_id: row.patient_id, matched_by: row.matched_by },
          after: { patient_id: patientId, matched_by: 'manual', reconciliation_status: 'reconciled' },
          reasonText: ctx.reason,
          sensitivity: 'sensitive',
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('pacs.study.reconciled', studyId, {
            studyId,
            correctionId,
            patientId,
            accessionNo: item?.accession_no ?? row.accession_no ?? '',
            reconciledBy: ctx.userId ?? '',
            reason: ctx.reason ?? body.note ?? 'Reconciled by a named operator.',
            at: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.getStudy(studyId, { audit: false });
  }

  // ── share links (EN-008 §3.6) ─────────────────────────────────────────────

  async createShareLink(body: ShareLinkRequest): Promise<{
    readonly id: string;
    readonly token: string;
    readonly expiresAt: string;
    readonly maxViews: number;
  }> {
    const ctx = getContext();
    const id = newId();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + body.expiresInDays * 86_400_000);

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const branchId = ctx.branchId;
        if (branchId === null) throw AppError.conflict('A share link is created in a branch.');

        const studies = await tx.rows<{ id: string; patient_id: string | null; is_pcpndt: boolean }>(
          `SELECT id, patient_id, is_pcpndt FROM rad.pacs_studies WHERE id = ANY($1::uuid[])`,
          [body.studyIds],
        );
        if (studies.length !== body.studyIds.length) throw AppError.notFound('One of the studies');
        for (const study of studies) {
          if (study.patient_id !== body.patientId) {
            throw AppError.conflict('Every study on a share link must belong to the named patient.');
          }
          // EN-008 §5: "obstetric USG studies restricted from patient share".
          if (study.is_pcpndt && body.channel === 'patient') {
            throw new AppError(
              ProblemType.STATUTORY_LIMIT,
              'An obstetric ultrasound covered by the PC-PNDT Act is not shared to a patient link.',
              { reference: 'EN-008 §5; PC-PNDT Act 1994' },
            );
          }
          await this.access.authoriseAndAudit(tx, {
            studyId: study.id,
            studyInstanceUid: null,
            patientId: study.patient_id,
            action: 'share',
          });
        }

        await tx.query(
          `INSERT INTO rad.pacs_share_links (
             id, hospital_id, branch_id, patient_id, study_ids, consent_id, created_by_user_id,
             channel, recipient_name, recipient_contact_masked, link_token_hash,
             expires_at, max_views, watermark_applied, created_by, updated_by, updated_at
           ) VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9, $10, $11, $12::timestamptz, $13, true, $7, $7, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.patientId,
            body.studyIds,
            body.consentId,
            ctx.userId,
            body.channel,
            body.recipientName ?? null,
            body.recipientContactMasked ?? null,
            createHash('sha256').update(token).digest('hex'),
            expiresAt.toISOString(),
            body.maxViews,
          ],
        );

        await this.audit.write(tx, {
          action: 'export',
          entity: 'rad.pacs_share_links',
          rowId: id,
          businessKey: null,
          dataClass: 'phi',
          patientId: body.patientId,
          encounterId: null,
          before: null,
          after: {
            channel: body.channel,
            study_count: body.studyIds.length,
            expires_at: expiresAt.toISOString(),
          },
          reasonText: ctx.reason,
          sensitivity: 'sensitive',
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('pacs.share_link.created', id, {
            shareLinkId: id,
            studyIds: body.studyIds,
            patientId: body.patientId,
            expiresAt: expiresAt.toISOString(),
            maxViews: body.maxViews,
            createdBy: ctx.userId ?? '',
          }),
        );
        for (const studyId of body.studyIds) {
          await this.outbox.publish(
            tx,
            radiologyEvent('pacs.study.shared', studyId, {
              studyId,
              patientId: body.patientId,
              shareLinkId: id,
              sharedBy: ctx.userId ?? '',
              consentId: body.consentId,
              at: new Date().toISOString(),
            }),
          );
        }
      }),
    );

    return { id, token, expiresAt: expiresAt.toISOString(), maxViews: body.maxViews };
  }

  async revokeShareLink(id: string, body: RevokeShareLinkRequest): Promise<{ readonly revoked: true }> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const rows = await tx.rows<{ id: string; patient_id: string }>(
          `UPDATE rad.pacs_share_links
              SET revoked_at = now(), revoked_by = $2, revoke_reason = $3, updated_at = now()
            WHERE id = $1 AND revoked_at IS NULL
            RETURNING id, patient_id`,
          [id, ctx.userId, body.reason],
        );
        const row = rows[0];
        if (row === undefined) throw AppError.notFound('The share link');

        await this.audit.write(tx, {
          action: 'update',
          entity: 'rad.pacs_share_links',
          rowId: id,
          businessKey: null,
          dataClass: 'phi',
          patientId: row.patient_id,
          encounterId: null,
          before: { revoked_at: null },
          after: { revoked_at: new Date().toISOString() },
          reasonText: body.reason,
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('pacs.share_link.revoked', id, {
            shareLinkId: id,
            revokedBy: ctx.userId ?? '',
            reason: body.reason,
            at: new Date().toISOString(),
          }),
        );
      }),
    );

    return { revoked: true };
  }

  // ── retention (EN-008 §3.7) ───────────────────────────────────────────────

  async retentionPolicies(): Promise<{ readonly items: readonly RetentionPolicyRow[] }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const items = await tx.rows<RetentionPolicyRow>(
        `SELECT id, branch_id, modality::text AS modality, patient_class, hot_days, warm_days,
                retain_years, minor_retain_until_age, minor_extra_years, never_purge_mlc, is_active
           FROM rad.pacs_retention_policies WHERE is_active ORDER BY patient_class`,
      );
      return { items };
    });
  }

  /**
   * Plans a purge. `EN-008 §5`: "never purge MLC/legal-hold… purge requires two
   * approvals".
   *
   * The plan refuses outright if any selected study is medico-legal or under
   * legal hold, rather than quietly dropping it from the list: an operator who
   * asked to purge a protected study has misunderstood something, and a silent
   * partial purge would hide that from them. The CHECK
   * `pacs_studies_never_purge_protected` refuses it a second time.
   */
  async planPurge(body: PurgePlanRequest): Promise<{ readonly id: string; readonly studyCount: number }> {
    const ctx = getContext();
    const id = newId();
    let studyCount = 0;

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const branchId = ctx.branchId;
        if (branchId === null) throw AppError.conflict('A purge run belongs to a branch.');

        const protectedStudies = await tx.rows<{ study_instance_uid: string }>(
          `SELECT study_instance_uid FROM rad.pacs_studies
            WHERE id = ANY($1::uuid[]) AND (is_mlc OR legal_hold)`,
          [body.studyIds],
        );
        if (protectedStudies.length > 0) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `${String(protectedStudies.length)} of the selected studies are medico-legal or under legal hold and are never purged.`,
            { reference: 'EN-008 §5' },
          );
        }

        const eligible = await tx.rows<{ id: string; size_bytes: string }>(
          `SELECT id, size_bytes::text AS size_bytes FROM rad.pacs_studies
            WHERE id = ANY($1::uuid[]) AND purged_at IS NULL`,
          [body.studyIds],
        );
        studyCount = eligible.length;

        await tx.query(
          `INSERT INTO rad.pacs_purge_runs (
             id, hospital_id, branch_id, policy_id, planned_at, study_count, bytes_freed,
             status, purged_study_uids, created_by, updated_by, updated_at
           ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, 'planned', $8::text[], $9, $9, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.policyId ?? null,
            body.plannedAt,
            studyCount,
            eligible.reduce((sum, s) => sum + BigInt(s.size_bytes), 0n).toString(10),
            eligible.map((s) => s.id),
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'rad.pacs_purge_runs',
          rowId: id,
          businessKey: null,
          dataClass: 'operational',
          patientId: null,
          encounterId: null,
          before: null,
          after: { study_count: studyCount, status: 'planned' },
          reasonText: ctx.reason,
        });
      }),
    );

    return { id, studyCount };
  }

  /**
   * Records one of the two approvals a purge needs.
   *
   * The second approver is where `rad.pacs.retention` is actually asserted. The
   * key is flagged `requiresSecondPerson`, and the global `PolicyGuard` has no
   * way to carry a co-signer — so a route decorated with it would be refused for
   * everybody, always. `cash/cosign.service.ts` records the same finding and the
   * same remedy: decorate the route with the counter-operation key the actor
   * genuinely needs, and assert the real authority here with the co-signer
   * attached. The first approver is the co-signer, which is exactly what "two
   * approvals" means; one person clicking twice is one approval, and the CHECK
   * `pacs_purge_runs_two_approvers` says so too.
   */
  async approvePurge(id: string): Promise<{ readonly status: string }> {
    const ctx = getContext();
    let status = 'planned';

    await withDatabaseRefusals(async () => {
      const run = await this.db.withTenant(currentTenantContext(), (tx) =>
        tx.maybeOne<{ approved_by_1: string | null; approved_by_2: string | null; status: string }>(
          `SELECT approved_by_1, approved_by_2, status FROM rad.pacs_purge_runs WHERE id = $1`,
          [id],
        ),
      );
      if (run === undefined) throw AppError.notFound('The purge run');
      if (run.status !== 'planned') {
        throw new AppError(ProblemType.ALREADY_DECIDED, 'This purge run is no longer awaiting approval.');
      }
      if (run.approved_by_1 === ctx.userId) {
        throw new AppError(
          ProblemType.SECOND_PERSON_REQUIRED,
          'You have already approved this purge. The second approval must come from somebody else.',
        );
      }

      if (run.approved_by_1 !== null) {
        await this.policy.assert('rad.pacs.retention', {}, { secondPersonUserId: run.approved_by_1 });
      }

      await this.db.withTenant(currentTenantContext(), async (tx) => {
        const rows = await tx.rows<{ status: string }>(
          `UPDATE rad.pacs_purge_runs
              SET approved_by_1 = COALESCE(approved_by_1, $2),
                  approved_at_1 = COALESCE(approved_at_1, now()),
                  approved_by_2 = CASE WHEN approved_by_1 IS NULL THEN approved_by_2 ELSE $2 END,
                  approved_at_2 = CASE WHEN approved_by_1 IS NULL THEN approved_at_2 ELSE now() END,
                  status = CASE WHEN approved_by_1 IS NULL THEN 'planned' ELSE 'approved' END,
                  updated_by = $2, updated_at = now()
            WHERE id = $1
            RETURNING status`,
          [id, ctx.userId],
        );
        status = rows[0]?.status ?? 'planned';

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'rad.pacs_purge_runs',
          rowId: id,
          businessKey: null,
          dataClass: 'operational',
          patientId: null,
          encounterId: null,
          before: { status: run.status },
          after: { status },
          reasonText: ctx.reason,
        });
      });
    });

    return { status };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async match(tx: TransactionClient, body: IngestStudyRequest): Promise<MatchResult> {
    const byUid = await tx.maybeOne<MatchRow>(`${MATCH_SELECT} WHERE i.study_instance_uid = $1`, [
      body.studyInstanceUid,
    ]);
    if (byUid !== undefined) return matched(byUid, 'study_uid');

    if (body.accessionNo !== undefined) {
      const byMwl = await tx.maybeOne<MatchRow>(
        `${MATCH_SELECT}
           JOIN rad.pacs_mwl_entries w ON w.order_item_id = i.id
          WHERE w.accession_no = $1
          ORDER BY w.scheduled_at DESC LIMIT 1`,
        [body.accessionNo],
      );
      if (byMwl !== undefined) return matched(byMwl, 'mwl');

      const byAccession = await tx.maybeOne<MatchRow>(`${MATCH_SELECT} WHERE o.accession_no = $1 LIMIT 1`, [
        body.accessionNo,
      ]);
      if (byAccession !== undefined) return matched(byAccession, 'accession');
    }

    // A demographic resemblance. Never a confirmation: EN-008 §5.
    if (body.uhidAtAcquisition !== undefined) {
      const byUhid = await tx.maybeOne<{ id: string; branch_id: string }>(
        `SELECT id, branch_id FROM patient.patients WHERE uhid_normalised = $1 AND deleted_at IS NULL`,
        [body.uhidAtAcquisition],
      );
      if (byUhid !== undefined) {
        return {
          patientId: byUhid.id,
          branchId: byUhid.branch_id,
          orderItemId: null,
          orderId: null,
          examId: null,
          accessionNo: body.accessionNo ?? null,
          modality: body.modality ?? null,
          basis: 'fallback',
          reconciliation: 'needs_review',
          isMlc: false,
          isPcpndt: false,
        };
      }
    }

    return {
      patientId: null,
      branchId: null,
      orderItemId: null,
      orderId: null,
      examId: null,
      accessionNo: body.accessionNo ?? null,
      modality: body.modality ?? null,
      basis: 'unmatched',
      reconciliation: 'needs_review',
      isMlc: false,
      isPcpndt: false,
    };
  }

  private async assertPatientVisible(tx: TransactionClient, patientId: string): Promise<void> {
    const row = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM patient.patients WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    if (row === undefined) throw AppError.notFound('The patient');
  }
}

// ── rows and projections ────────────────────────────────────────────────────

const STUDY_SELECT = `
  SELECT s.id, s.study_instance_uid, s.patient_id, s.accession_no, s.order_item_id, s.orthanc_id,
         s.modality::text AS modality, s.status::text AS status, s.tier::text AS tier,
         s.matched_by::text AS matched_by, s.reconciliation_status::text AS reconciliation_status,
         s.series_count, s.instance_count, s.size_bytes::text AS size_bytes, s.is_mlc, s.legal_hold,
         s.created_at::text AS cursor_key
    FROM rad.pacs_studies s`;

const MATCH_SELECT = `
  SELECT i.id AS order_item_id, i.order_id, o.patient_id, o.branch_id, o.accession_no, o.is_mlc,
         i.is_pcpndt, i.modality::text AS modality,
         (SELECT e.id FROM rad.rad_exams e WHERE e.order_item_id = i.id) AS exam_id
    FROM rad.rad_order_items i
    JOIN rad.rad_orders o ON o.id = i.order_id`;

interface MatchRow {
  readonly order_item_id: string;
  readonly order_id: string;
  readonly patient_id: string;
  readonly branch_id: string;
  readonly accession_no: string;
  readonly is_mlc: boolean;
  readonly is_pcpndt: boolean;
  readonly modality: string;
  readonly exam_id: string | null;
}

interface MatchResult {
  readonly patientId: string | null;
  readonly branchId: string | null;
  readonly orderItemId: string | null;
  readonly orderId: string | null;
  readonly examId: string | null;
  readonly accessionNo: string | null;
  readonly modality: string | null;
  readonly basis: 'accession' | 'study_uid' | 'mwl' | 'fallback' | 'manual' | 'unmatched';
  readonly reconciliation: 'matched' | 'needs_review' | 'reconciled' | 'rejected';
  readonly isMlc: boolean;
  readonly isPcpndt: boolean;
}

function matched(row: MatchRow, basis: 'accession' | 'study_uid' | 'mwl'): MatchResult {
  return {
    patientId: row.patient_id,
    branchId: row.branch_id,
    orderItemId: row.order_item_id,
    orderId: row.order_id,
    examId: row.exam_id,
    accessionNo: row.accession_no,
    modality: row.modality,
    basis,
    reconciliation: 'matched',
    isMlc: row.is_mlc,
    isPcpndt: row.is_pcpndt,
  };
}

interface StudyRow {
  readonly id: string;
  readonly study_instance_uid: string;
  readonly patient_id: string | null;
  readonly accession_no: string | null;
  readonly order_item_id: string | null;
  readonly orthanc_id: string | null;
  readonly modality: string | null;
  readonly status: string;
  readonly tier: string;
  readonly matched_by: string;
  readonly reconciliation_status: string;
  readonly series_count: number;
  readonly instance_count: number;
  readonly size_bytes: string;
  readonly is_mlc: boolean;
  readonly legal_hold: boolean;
}

export interface RetentionPolicyRow {
  readonly id: string;
  readonly branch_id: string | null;
  readonly modality: string | null;
  readonly patient_class: string;
  readonly hot_days: number;
  readonly warm_days: number;
  readonly retain_years: number;
  readonly minor_retain_until_age: number | null;
  readonly minor_extra_years: number | null;
  readonly never_purge_mlc: boolean;
  readonly is_active: boolean;
}

function toStudyView(row: StudyRow): PacsStudyView {
  return {
    id: row.id,
    studyInstanceUid: row.study_instance_uid,
    patientId: row.patient_id,
    accessionNo: row.accession_no,
    orderItemId: row.order_item_id,
    modality: row.modality,
    status: row.status,
    tier: row.tier,
    matchedBy: row.matched_by,
    reconciliationStatus: row.reconciliation_status,
    seriesCount: Number(row.series_count),
    instanceCount: Number(row.instance_count),
    sizeBytes: row.size_bytes,
    isMlc: row.is_mlc,
    legalHold: row.legal_hold,
  };
}
