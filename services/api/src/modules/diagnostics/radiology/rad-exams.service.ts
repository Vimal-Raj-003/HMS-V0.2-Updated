import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { RadOrdersService } from './rad-orders.service.js';
import { withDatabaseRefusals } from './radiology.errors.js';
import { radiologyEvent } from './radiology.events.js';
import type {
  CompleteExamRequest,
  ContrastRequest,
  DoseRequest,
  FormFRequest,
  RepeatExposureRequest,
  StartExamRequest,
} from './radiology.schemas.js';
import type { DoseSummaryView, RadExamView } from './radiology.types.js';

/**
 * OP-008 §3.3.2 and §3.6 — the technologist's record of the examination, the
 * contrast given, the exposures repeated, the dose delivered, and the PC-PNDT
 * register.
 *
 * The one thing to understand about this service is **where the two hard blocks
 * are not**.
 *
 * `rad.enforce_dose_recorded()` fires at *report signature*, not here.
 * `docs/DECISIONS.md D-41` explains the choice and it is worth repeating,
 * because the obvious place to put it is exactly here: an RDSR object typically
 * arrives seconds to minutes *after* the technologist marks the exam done.
 * Blocking at that moment does not produce a dose figure; it produces a
 * technologist who cannot finish their worklist, and the predictable response is
 * to type a plausible number. A fabricated dose in the AERB register is worse
 * than a late one. So `complete()` never refuses for a missing dose, and
 * `RadReportsService.sign()` refuses for it every time, with no setting that
 * relaxes it.
 *
 * `rad.enforce_form_f()` fires *here as well as* at signature, and this is the
 * opposite choice for the opposite reason. The Act makes Form F a precondition
 * of conducting the procedure, not of reporting it; a scan performed without one
 * is already the offence. So completion is blocked, the machine's registration
 * is checked at the same moment, and `mapDatabaseRefusal` surfaces the refusal
 * as the statute rather than as a validation error somebody might look for a way
 * around.
 */
@Injectable()
export class RadExamsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(RadOrdersService) private readonly orders: RadOrdersService,
  ) {}

  // ── acquisition ───────────────────────────────────────────────────────────

  async start(orderItemId: string, body: StartExamRequest): Promise<RadExamView> {
    const examId = newId();

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const item = await this.orders.loadItem(tx, orderItemId);
        if (['cancelled', 'rejected'].includes(item.status)) {
          throw AppError.conflict('This order line is cancelled; nothing may be acquired against it.');
        }

        const existing = await tx.maybeOne<{ id: string }>(
          `SELECT id FROM rad.rad_exams WHERE order_item_id = $1`,
          [orderItemId],
        );
        if (existing !== undefined) {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'An examination already exists for this order line. Log a repeat against it rather than starting a second one.',
          );
        }

        await tx.query(
          `INSERT INTO rad.rad_exams (
             id, hospital_id, branch_id, order_item_id, patient_id, room_id, study_instance_uid,
             accession_no, modality, status, technician_user_id, protocol_name,
             identity_verified, identity_method, safety_checklist_completed, started_at,
             is_emergency_placeholder, reconciliation_due_at, created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9::mdm."RadModality", 'in_progress', $10, $11,
             true, $12, true, now(),
             $13, CASE WHEN $13 THEN now() + interval '24 hours' ELSE NULL END, $10, $10, now()
           )`,
          [
            examId,
            ctx.hospitalId,
            item.branch_id,
            orderItemId,
            item.patient_id,
            body.roomId,
            item.study_instance_uid,
            item.accession_no,
            item.modality,
            ctx.userId,
            body.protocolName ?? null,
            body.identityMethod,
            body.isEmergencyPlaceholder,
          ],
        );

        await this.orders.advance(tx, item.order_id, orderItemId, 'in_progress', null);
        await tx.query(
          `UPDATE rad.pacs_mwl_entries SET status = 'in_progress', updated_at = now()
            WHERE order_item_id = $1 AND status IN ('pending', 'queried')`,
          [orderItemId],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'rad.rad_exams',
          rowId: examId,
          businessKey: item.accession_no,
          dataClass: 'phi',
          patientId: item.patient_id,
          encounterId: item.encounter_id,
          before: null,
          after: { status: 'in_progress', room_id: body.roomId, identity_method: body.identityMethod },
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('rad.study.started', examId, {
            examId,
            orderId: item.order_id,
            accessionNo: item.accession_no,
            patientId: item.patient_id,
            roomId: body.roomId,
            technologistUserId: ctx.userId,
            startedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(examId);
  }

  async complete(examId: string, body: CompleteExamRequest): Promise<RadExamView> {
    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const exam = await this.loadExam(tx, examId);
        if (exam.status === 'completed') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This examination is already complete.');
        }

        // The Form F trigger fires on this statement. It is the reason the whole
        // transaction is wrapped: the refusal must reach the technologist as the
        // Act, not as a constraint name.
        await tx.query(
          `UPDATE rad.rad_exams
              SET status = 'completed', completed_at = now(),
                  technologist_notes = COALESCE($2, technologist_notes),
                  updated_by = $3, updated_at = now(), version = version + 1
            WHERE id = $1`,
          [examId, body.technologistNotes ?? null, getContext().userId],
        );

        await this.orders.advance(tx, exam.order_id, exam.order_item_id, 'awaiting_report', null);
        await tx.query(
          `UPDATE rad.pacs_mwl_entries SET status = 'completed', updated_at = now()
            WHERE order_item_id = $1 AND status NOT IN ('cancelled', 'expired')`,
          [exam.order_item_id],
        );

        const contrastUsed = await tx.one<{ used: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM rad.rad_contrast_events WHERE exam_id = $1) AS used`,
          [examId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'rad.rad_exams',
          rowId: examId,
          businessKey: exam.accession_no,
          dataClass: 'phi',
          patientId: exam.patient_id,
          encounterId: null,
          before: { status: exam.status },
          after: { status: 'completed', repeat_count: exam.repeat_count },
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('rad.study.completed', examId, {
            examId,
            orderId: exam.order_id,
            accessionNo: exam.accession_no,
            patientId: exam.patient_id,
            contrastUsed: contrastUsed.used,
            completedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(examId);
  }

  /** AERB QA evidence, and the repeat-rate KPI by technologist and room. */
  async logRepeat(examId: string, body: RepeatExposureRequest): Promise<RadExamView> {
    const repeatId = newId();

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const exam = await this.loadExam(tx, examId);

        await tx.query(
          `INSERT INTO rad.rad_repeat_reject_events
             (id, hospital_id, exam_id, kind, reason_code, reason_note, view_name, technician_user_id, at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $8)`,
          [
            repeatId,
            ctx.hospitalId,
            examId,
            body.kind,
            body.reasonCode,
            body.reasonNote ?? null,
            body.viewName ?? null,
            ctx.userId,
          ],
        );

        await tx.query(
          `UPDATE rad.rad_exams SET repeat_count = repeat_count + 1, updated_by = $2, updated_at = now()
            WHERE id = $1`,
          [examId, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'rad.rad_repeat_reject_events',
          rowId: repeatId,
          businessKey: exam.accession_no,
          dataClass: 'phi',
          patientId: exam.patient_id,
          encounterId: null,
          before: null,
          after: { kind: body.kind, reason_code: body.reasonCode },
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('rad.repeat.logged', repeatId, {
            repeatId,
            examId,
            roomId: exam.room_id ?? exam.id,
            technologistUserId: ctx.userId,
            reasonCode: body.reasonCode,
            loggedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(examId);
  }

  /**
   * The contrast record, and the reaction that turns into an allergy record and
   * an incident.
   *
   * `OP-008 §3.3.2` requires the lot number, and the CHECK on
   * `rad_contrast_events` requires it too: a recall that cannot name the lot is
   * a recall of every patient who had contrast that week.
   */
  async recordContrast(examId: string, body: ContrastRequest): Promise<RadExamView> {
    const eventId = newId();

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const exam = await this.loadExam(tx, examId);

        await tx.query(
          `INSERT INTO rad.rad_contrast_events (
             id, hospital_id, exam_id, patient_id, agent_name, agent_key, volume_ml, concentration,
             lot_no, expiry_date, route, injector_name, flow_rate_ml_s, administered_by, administered_at,
             reaction_observed, reaction_severity, reaction_description, created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10::date, $11, $12, $13, $14, now(),
             $15, $16, $17, $14, $14, now()
           )`,
          [
            eventId,
            ctx.hospitalId,
            examId,
            exam.patient_id,
            body.agentName,
            body.agentKey ?? null,
            body.volumeMl ?? null,
            body.concentration ?? null,
            body.lotNo,
            body.expiryDate ?? null,
            body.route ?? null,
            body.injectorName ?? null,
            body.flowRateMlS ?? null,
            ctx.userId,
            body.reactionObserved,
            body.reactionSeverity ?? null,
            body.reactionDescription ?? null,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'rad.rad_contrast_events',
          rowId: eventId,
          businessKey: exam.accession_no,
          dataClass: 'phi',
          patientId: exam.patient_id,
          encounterId: null,
          before: null,
          after: { agent: body.agentName, lot_no: body.lotNo, reaction: body.reactionObserved },
          sensitivity: body.reactionObserved ? 'sensitive' : 'normal',
        });

        if (body.reactionObserved && body.reactionSeverity !== undefined) {
          await this.outbox.publish(
            tx,
            radiologyEvent('rad.contrast.reaction', eventId, {
              contrastEventId: eventId,
              examId,
              patientId: exam.patient_id,
              agent: body.agentName,
              severity: body.reactionSeverity,
              occurredAt: new Date().toISOString(),
            }),
          );
        }
      }),
    );

    return this.get(examId);
  }

  // ── dose (OP-008 §3.6, AERB) ──────────────────────────────────────────────

  async recordDose(examId: string, body: DoseRequest): Promise<DoseSummaryView> {
    let patientId = '';

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ctx = getContext();
        const exam = await this.loadExam(tx, examId);
        patientId = exam.patient_id;

        const drl = await tx.maybeOne<{
          drl_ctdivol_mgy: string | null;
          drl_dlp_mgycm: string | null;
          body_part_dicom: string | null;
        }>(
          `SELECT p.drl_ctdivol_mgy::text AS drl_ctdivol_mgy,
                  p.drl_dlp_mgycm::text AS drl_dlp_mgycm,
                  p.body_part_dicom
             FROM mdm.mdm_rad_procedures p
             JOIN rad.rad_order_items i ON i.procedure_key = p.record_key
            WHERE i.id = $1 AND p.status = 'active'
            ORDER BY p.effective_from DESC LIMIT 1`,
          [exam.order_item_id],
        );

        const kFactor = await tx.maybeOne<{ k_factor: string }>(
          `SELECT k.k_factor::text AS k_factor
             FROM rad.rad_dose_k_factors k
             JOIN patient.patients p ON p.id = $2
            WHERE k.modality = $1::mdm."RadModality"
              AND k.status = 'active'
              AND k.effective_from <= now()
              AND (k.effective_to IS NULL OR k.effective_to > now())
              AND (p.dob IS NULL OR (
                    (now()::date - p.dob) BETWEEN k.age_min_days AND k.age_max_days))
              AND ($3::text IS NULL OR k.body_region = $3::text)
            ORDER BY k.effective_from DESC LIMIT 1`,
          [exam.modality, exam.patient_id, drl?.body_part_dicom ?? null],
        );

        const dlp = body.dlpMgycm ?? null;
        const k = kFactor === undefined ? null : Number(kFactor.k_factor);
        const effectiveMsv = dlp !== null && k !== null ? dlp * k : null;

        const drlCtdi =
          drl?.drl_ctdivol_mgy === null || drl === undefined ? null : Number(drl.drl_ctdivol_mgy);
        const drlDlp = drl?.drl_dlp_mgycm === null || drl === undefined ? null : Number(drl.drl_dlp_mgycm);
        const drlExceeded =
          (drlCtdi !== null && body.ctdivolMgy !== undefined && body.ctdivolMgy > drlCtdi) ||
          (drlDlp !== null && dlp !== null && dlp > drlDlp);

        const doseId = newId();
        await tx.query(
          `INSERT INTO rad.rad_dose_records (
             id, hospital_id, branch_id, exam_id, patient_id, study_instance_uid, modality, protocol_name,
             ctdivol_mgy, dlp_mgycm, dap_gycm2, kvp, mas, exposure_count, fluoro_time_s,
             effective_dose_msv, k_factor_used, source, rdsr_instance_uid, entered_by,
             drl_ctdivol_mgy, drl_dlp_mgycm, drl_exceeded, recorded_at,
             created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7::mdm."RadModality", $8,
             $9, $10, $11, $12, $13, $14, $15,
             $16, $17, $18, $19, $20,
             $21, $22, $23, now(),
             $20, $20, now()
           )`,
          [
            doseId,
            ctx.hospitalId,
            exam.branch_id,
            examId,
            exam.patient_id,
            exam.study_instance_uid,
            exam.modality,
            body.protocolName ?? null,
            body.ctdivolMgy ?? null,
            dlp,
            body.dapGycm2 ?? null,
            body.kvp ?? null,
            body.mas ?? null,
            body.exposureCount ?? null,
            body.fluoroTimeS ?? null,
            effectiveMsv,
            effectiveMsv === null ? null : k,
            body.source,
            body.rdsrInstanceUid ?? null,
            ctx.userId,
            drlCtdi,
            drlDlp,
            drlExceeded,
          ],
        );

        const summary = await this.refreshDoseSummary(tx, exam.patient_id);

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'rad.rad_dose_records',
          rowId: doseId,
          businessKey: exam.accession_no,
          dataClass: 'phi',
          patientId: exam.patient_id,
          encounterId: null,
          before: null,
          after: { source: body.source, dlp_mgycm: dlp, drl_exceeded: drlExceeded },
        });

        await this.outbox.publish(
          tx,
          radiologyEvent('rad.dose.recorded', doseId, {
            doseRecordId: doseId,
            examId,
            patientId: exam.patient_id,
            modality: exam.modality,
            source: registeredDoseSource(body.source),
            ctdiVol: body.ctdivolMgy === undefined ? null : String(body.ctdivolMgy),
            dlp: dlp === null ? null : String(dlp),
            dap: body.dapGycm2 === undefined ? null : String(body.dapGycm2),
            recordedAt: new Date().toISOString(),
          }),
        );

        if (drlExceeded) {
          await this.outbox.publish(
            tx,
            radiologyEvent('rad.drl.exceeded', doseId, {
              doseRecordId: doseId,
              examId,
              protocolKey: body.protocolName ?? exam.modality,
              observed: String(dlp ?? body.ctdivolMgy ?? 0),
              drl: String(drlDlp ?? drlCtdi ?? 0),
              detectedAt: new Date().toISOString(),
            }),
          );
        }

        if (summary.crossedThreshold) {
          await this.outbox.publish(
            tx,
            radiologyEvent('rad.dose.threshold_exceeded', exam.patient_id, {
              patientId: exam.patient_id,
              cumulativeDlp: summary.view.msv12m,
              thresholdDlp: String(summary.threshold),
              isPaediatric: summary.isPaediatric,
              detectedAt: new Date().toISOString(),
            }),
          );
        }
      }),
    );

    return this.doseSummary(patientId);
  }

  async doseSummary(patientId: string): Promise<DoseSummaryView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<DoseSummaryRow>(
        `SELECT patient_id, cumulative_msv_lifetime::text, msv_12m::text, ct_count_12m,
                study_count_12m, threshold_breached, last_study_at::text AS last_study_at
           FROM rad.rad_patient_dose_summary WHERE patient_id = $1`,
        [patientId],
      );
      if (row === undefined) {
        return {
          patientId,
          cumulativeMsvLifetime: '0',
          msv12m: '0',
          ctCount12m: 0,
          studyCount12m: 0,
          thresholdBreached: false,
          lastStudyAt: null,
        };
      }
      return toDoseSummaryView(row);
    });
  }

  // ── PC-PNDT Form F (OP-008 §5) ────────────────────────────────────────────

  /**
   * Writes the Form F register entry for one obstetric ultrasound.
   *
   * The serial is derived from the accession number rather than allocated from a
   * separate series, and that is deliberate: the Act requires one Form per
   * procedure, and deriving the serial from the accession makes the two
   * impossible to get out of step. The unique index on
   * `(hospital_id, form_serial_no)` and the one on `(order_item_id)` between them
   * mean a second Form for the same scan cannot be written at all.
   *
   * Nothing in this method, in `formFSchema`, or in the table it writes to can
   * record the sex of a foetus. That is not an omission to be tidied up later:
   * `migration.sql §C.7` reads `information_schema` at migration time and refuses
   * to apply if such a column ever appears anywhere in `rad`, `lab` or the
   * investigation tables.
   */
  async recordFormF(orderItemId: string, body: FormFRequest): Promise<{ readonly formSerialNo: string }> {
    const ctx = getContext();
    const performedAt = new Date(body.performedAt);
    let serial = '';

    await withDatabaseRefusals(() =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const item = await this.orders.loadItem(tx, orderItemId);
        if (!item.is_pcpndt) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'Form F belongs to a procedure the master marks as covered by the PC-PNDT Act. This one is not.',
            {
              nextAction:
                'Check the procedure on the order line; if it is an obstetric ultrasound, the master entry needs its PC-PNDT flag set.',
            },
          );
        }

        const exam = await tx.maybeOne<{ id: string }>(
          `SELECT id FROM rad.rad_exams WHERE order_item_id = $1`,
          [orderItemId],
        );

        serial = `${item.accession_no}/F`;

        await tx.query(
          `INSERT INTO rad.rad_form_f (
             id, hospital_id, branch_id, order_item_id, exam_id, patient_id, form_serial_no,
             facility_registration_no, machine_registration_no,
             patient_name, patient_age_years, husband_or_father_name, full_address,
             identity_document_type, identity_document_ref_masked,
             gravida, para, living_children, previous_abortions,
             gestational_age_weeks, last_menstrual_period,
             referring_doctor_name, referring_doctor_registration_no,
             indication_codes, indication_other, procedures_performed,
             woman_declaration_signed, woman_declaration_doc_id, woman_declaration_at,
             doctor_declaration_signed, doctor_declaration_doc_id, doctor_declaration_at,
             performed_by_user_id, performed_by_name, performed_by_registration_no, performed_at,
             return_month, return_year, retention_until, created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9,
             $10, $11, $12, $13,
             $14, $15,
             $16, $17, $18, $19,
             $20, $21::date,
             $22, $23,
             $24::text[], $25, $26::text[],
             $27, $28, CASE WHEN $27 THEN now() ELSE NULL END,
             $29, $30, CASE WHEN $29 THEN now() ELSE NULL END,
             $31, $32, $33, $34::timestamptz,
             $35, $36, ($34::timestamptz + interval '5 years')::date, $31, $31, now()
           )
           ON CONFLICT (order_item_id) DO UPDATE SET
             woman_declaration_signed = EXCLUDED.woman_declaration_signed,
             woman_declaration_doc_id = EXCLUDED.woman_declaration_doc_id,
             woman_declaration_at = EXCLUDED.woman_declaration_at,
             doctor_declaration_signed = EXCLUDED.doctor_declaration_signed,
             doctor_declaration_doc_id = EXCLUDED.doctor_declaration_doc_id,
             doctor_declaration_at = EXCLUDED.doctor_declaration_at,
             exam_id = COALESCE(rad.rad_form_f.exam_id, EXCLUDED.exam_id),
             indication_codes = EXCLUDED.indication_codes,
             indication_other = EXCLUDED.indication_other,
             procedures_performed = EXCLUDED.procedures_performed,
             updated_by = EXCLUDED.updated_by, updated_at = now(), version = rad.rad_form_f.version + 1`,
          [
            newId(),
            ctx.hospitalId,
            item.branch_id,
            orderItemId,
            exam?.id ?? null,
            item.patient_id,
            serial,
            body.facilityRegistrationNo,
            body.machineRegistrationNo,
            body.patientName,
            body.patientAgeYears,
            body.husbandOrFatherName,
            body.fullAddress,
            body.identityDocumentType,
            body.identityDocumentRefMasked,
            body.gravida ?? null,
            body.para ?? null,
            body.livingChildren ?? null,
            body.previousAbortions ?? null,
            body.gestationalAgeWeeks ?? null,
            body.lastMenstrualPeriod ?? null,
            body.referringDoctorName,
            body.referringDoctorRegistrationNo ?? null,
            body.indicationCodes,
            body.indicationOther ?? null,
            body.proceduresPerformed,
            body.womanDeclarationSigned,
            body.womanDeclarationDocId ?? null,
            body.doctorDeclarationSigned,
            body.doctorDeclarationDocId ?? null,
            ctx.userId,
            body.performedByName,
            body.performedByRegistrationNo,
            body.performedAt,
            performedAt.getUTCMonth() + 1,
            performedAt.getUTCFullYear(),
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'rad.rad_form_f',
          rowId: orderItemId,
          businessKey: serial,
          dataClass: 'phi',
          patientId: item.patient_id,
          encounterId: null,
          before: null,
          after: {
            machine_registration_no: body.machineRegistrationNo,
            woman_declaration_signed: body.womanDeclarationSigned,
            doctor_declaration_signed: body.doctorDeclarationSigned,
          },
          sensitivity: 'sensitive',
        });
      }),
    );

    return { formSerialNo: serial };
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  async get(examId: string): Promise<RadExamView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<ExamRow & { dose_recorded: boolean }>(
        `SELECT e.id, e.order_item_id, e.patient_id, e.accession_no, e.modality::text AS modality,
                e.status::text AS status, e.room_id, e.study_instance_uid, e.repeat_count,
                e.started_at::text AS started_at, e.completed_at::text AS completed_at,
                e.branch_id, i.order_id,
                EXISTS (SELECT 1 FROM rad.rad_dose_records d WHERE d.exam_id = e.id) AS dose_recorded
           FROM rad.rad_exams e
           JOIN rad.rad_order_items i ON i.id = e.order_item_id
          WHERE e.id = $1`,
        [examId],
      );
      if (row === undefined) throw AppError.notFound('The examination');
      return {
        id: row.id,
        orderItemId: row.order_item_id,
        patientId: row.patient_id,
        accessionNo: row.accession_no,
        modality: row.modality,
        status: row.status,
        roomId: row.room_id,
        studyInstanceUid: row.study_instance_uid,
        repeatCount: row.repeat_count,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        doseRecorded: row.dose_recorded,
      };
    });
  }

  private async loadExam(tx: TransactionClient, examId: string): Promise<ExamRow> {
    const row = await tx.maybeOne<ExamRow>(
      `SELECT e.id, e.order_item_id, e.patient_id, e.accession_no, e.modality::text AS modality,
              e.status::text AS status, e.room_id, e.study_instance_uid, e.repeat_count,
              e.started_at::text AS started_at, e.completed_at::text AS completed_at,
              e.branch_id, i.order_id
         FROM rad.rad_exams e
         JOIN rad.rad_order_items i ON i.id = e.order_item_id
        WHERE e.id = $1`,
      [examId],
    );
    if (row === undefined) throw AppError.notFound('The examination');
    return row;
  }

  /**
   * Recomputes the per-patient dose read model from the dose records.
   *
   * Recomputed rather than incremented, because a corrected RDSR arriving late
   * would otherwise leave the summary permanently wrong, and this is the number
   * a radiologist is shown when deciding whether to order another CT
   * (`OP-008 §3.6.2`). The paediatric threshold is stricter, as the same section
   * requires.
   */
  private async refreshDoseSummary(
    tx: TransactionClient,
    patientId: string,
  ): Promise<{
    readonly view: DoseSummaryView;
    readonly crossedThreshold: boolean;
    readonly threshold: number;
    readonly isPaediatric: boolean;
  }> {
    const ctx = getContext();
    const age = await tx.maybeOne<{ years: string | null }>(
      `SELECT CASE WHEN dob IS NULL THEN NULL
                   ELSE extract(year from age(now(), dob))::text END AS years
         FROM patient.patients WHERE id = $1`,
      [patientId],
    );
    const isPaediatric = age?.years !== null && age?.years !== undefined && Number(age.years) < 18;
    const threshold = isPaediatric ? 50 : 100;

    const previous = await tx.maybeOne<{ threshold_breached: boolean }>(
      `SELECT threshold_breached FROM rad.rad_patient_dose_summary WHERE patient_id = $1`,
      [patientId],
    );

    const row = await tx.one<DoseSummaryRow>(
      `INSERT INTO rad.rad_patient_dose_summary AS s (
         id, hospital_id, patient_id, cumulative_msv_lifetime, msv_12m, ct_count_12m, study_count_12m,
         last_study_at, threshold_breached, threshold_breached_at, refreshed_at, updated_at
       )
       SELECT $1, $2, $3,
              COALESCE(sum(d.effective_dose_msv), 0),
              COALESCE(sum(d.effective_dose_msv) FILTER (WHERE d.recorded_at >= now() - interval '12 months'), 0),
              count(*) FILTER (WHERE d.modality = 'CT' AND d.recorded_at >= now() - interval '12 months'),
              count(*) FILTER (WHERE d.recorded_at >= now() - interval '12 months'),
              max(d.recorded_at),
              COALESCE(sum(d.effective_dose_msv) FILTER (WHERE d.recorded_at >= now() - interval '12 months'), 0) > $4,
              CASE WHEN COALESCE(sum(d.effective_dose_msv) FILTER (WHERE d.recorded_at >= now() - interval '12 months'), 0) > $4
                   THEN now() ELSE NULL END,
              now(), now()
         FROM rad.rad_dose_records d
        WHERE d.patient_id = $3
       ON CONFLICT (hospital_id, patient_id) DO UPDATE SET
         cumulative_msv_lifetime = EXCLUDED.cumulative_msv_lifetime,
         msv_12m = EXCLUDED.msv_12m,
         ct_count_12m = EXCLUDED.ct_count_12m,
         study_count_12m = EXCLUDED.study_count_12m,
         last_study_at = EXCLUDED.last_study_at,
         threshold_breached = EXCLUDED.threshold_breached,
         threshold_breached_at = COALESCE(s.threshold_breached_at, EXCLUDED.threshold_breached_at),
         refreshed_at = now(), updated_at = now()
       RETURNING patient_id, cumulative_msv_lifetime::text, msv_12m::text, ct_count_12m,
                 study_count_12m, threshold_breached, last_study_at::text AS last_study_at`,
      [newId(), ctx.hospitalId, patientId, threshold],
    );

    return {
      view: toDoseSummaryView(row),
      crossedThreshold: row.threshold_breached && previous?.threshold_breached !== true,
      threshold,
      isPaediatric,
    };
  }
}

interface ExamRow {
  readonly id: string;
  readonly order_item_id: string;
  readonly order_id: string;
  readonly patient_id: string;
  readonly branch_id: string;
  readonly accession_no: string;
  readonly modality: string;
  readonly status: string;
  readonly room_id: string | null;
  readonly study_instance_uid: string | null;
  readonly repeat_count: number;
  readonly started_at: string | null;
  readonly completed_at: string | null;
}

interface DoseSummaryRow {
  readonly patient_id: string;
  readonly cumulative_msv_lifetime: string;
  readonly msv_12m: string;
  readonly ct_count_12m: number;
  readonly study_count_12m: number;
  readonly threshold_breached: boolean;
  readonly last_study_at: string | null;
}

function toDoseSummaryView(row: DoseSummaryRow): DoseSummaryView {
  return {
    patientId: row.patient_id,
    cumulativeMsvLifetime: row.cumulative_msv_lifetime,
    msv12m: row.msv_12m,
    ctCount12m: Number(row.ct_count_12m),
    studyCount12m: Number(row.study_count_12m),
    thresholdBreached: row.threshold_breached,
    lastStudyAt: row.last_study_at,
  };
}

/**
 * The dose register accepts five sources; the registered `rad.dose.recorded`
 * event names three.
 *
 * MPPS and OCR are both machine-read rather than typed, so they collapse onto
 * the nearest registered value rather than being dropped: a consumer counting
 * "manual" entries for the AERB pack must not be told a scraped figure was
 * typed by a person, and must not be told nothing at all.
 */
function registeredDoseSource(source: string): 'rdsr' | 'header' | 'manual' {
  switch (source) {
    case 'rdsr':
      return 'rdsr';
    case 'header':
    case 'mpps':
      return 'header';
    default:
      return 'manual';
  }
}
