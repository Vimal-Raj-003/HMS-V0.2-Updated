import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { createHash } from 'node:crypto';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { withDischargeErrors } from './discharge.errors.js';
import { dischargeEvent } from './discharge.events.js';
import type {
  AmendSummaryRequest,
  CompleteRequest,
  DamaRequest,
  DeclareDeathRequest,
  DischargeQuery,
  DraftSummaryRequest,
  InitiateRequest,
  MccdRequest,
  MortuaryQuery,
  PostMortemRequest,
  ReceiveBodyRequest,
  ReconcileBatchRequest,
  ReleaseRequest,
  VerifyNokRequest,
} from './discharge.schemas.js';
import type {
  DischargeDetail,
  DischargeRow,
  MortuaryRow,
  ReconciliationRow,
  ReleaseChecklist,
  SummaryRow,
} from './discharge.types.js';

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}
function asTextOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : asText(v);
}
function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(asText(v));
}
function asNumberOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : asNumber(v);
}
function asBool(v: unknown): boolean {
  return v === true || v === 't' || v === 'true';
}
function asStringArray(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.map(asText) : [];
}

/**
 * Phase 7G — IP-002 and IP-017.
 *
 * ── This service never decides whether a summary may be signed ──────────────
 *
 * It writes `signed_by` and `signed_at` and lets the trigger refuse. Counting
 * unresolved medicines here as well would give the rule two implementations,
 * and the day they disagree is the day a summary is signed with a medicine
 * nobody decided about. What the service does do is *show* the count on the
 * worklist row, so the doctor sees the blocker before attempting the signature
 * rather than after.
 *
 * ── Nor whether a body may be released ──────────────────────────────────────
 *
 * `releaseChecklist` reads the same four facts the trigger reads and reports
 * them, so the custodian can tell a family what is outstanding. `release`
 * itself writes `released_at` and lets the trigger decide. The checklist is a
 * courtesy; the trigger is the rule.
 *
 * ── The content hash is over what was signed ────────────────────────────────
 *
 * Computed at the moment of signature from the fields the immutability trigger
 * protects, so a later comparison detects exactly the tampering the trigger
 * would have refused. Hashing the whole row would make the hash change when a
 * countersignature is added, which is a legitimate edit.
 */
@Injectable()
export class DischargeService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {}

  private hospitalId(): string {
    const id = getContext().hospitalId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private branchId(): string {
    const id = getContext().branchId;
    if (id === null || id === undefined) {
      throw AppError.conflict('This action needs a branch. Choose one and try again.');
    }
    return id;
  }
  private actorId(): string {
    const id = getContext().userId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withDischargeErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IP-002 — the discharge
  // ═══════════════════════════════════════════════════════════════════════════

  async initiate(body: InitiateRequest): Promise<DischargeRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const actor = this.actorId();

      await tx.query(
        `INSERT INTO clinical.ip_discharges (
           id, hospital_id, branch_id, admission_id, patient_id, kind,
           initiated_at, initiated_by, destination, follow_up_at, follow_up_with, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::clinical."DischargeKind", now(), $7, $8, $9::timestamptz, $10, now(), now())`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.admissionId,
          body.patientId,
          body.kind,
          actor,
          body.destination ?? null,
          body.followUpAt ?? null,
          body.followUpWith ?? null,
        ],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'ip_discharge',
        rowId: id,
        businessKey: body.admissionId,
        dataClass: 'phi',
        before: null,
        after: { kind: body.kind, destination: body.destination ?? null },
      });

      await this.outbox.publish(
        tx,
        dischargeEvent('ip.discharge.initiated', id, {
          dischargeId: id,
          admissionId: body.admissionId,
          patientId: body.patientId,
          kind: body.kind,
          destination: body.destination ?? null,
          initiatedBy: actor,
        }),
      );

      return this.readOne(tx, id);
    });
  }

  async list(query: DischargeQuery): Promise<Page<DischargeRow>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `${this.selectDischarge()}
          WHERE d.hospital_id = $1
            AND ($2::boolean IS NOT TRUE OR d.completed_at IS NULL)
            AND ($3::text IS NULL OR d.kind::text = $3::text)
          ORDER BY d.initiated_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.openOnly, query.kind ?? null, query.limit],
      );
      return { items: rows.map((r) => this.toDischarge(r)), nextCursor: null, hasMore: false };
    });
  }

  async detail(id: string): Promise<DischargeDetail> {
    return this.guard(async (tx) => {
      const discharge = await this.readOne(tx, id);

      const { rows: recon } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ip_med_reconciliations
          WHERE discharge_id = $1
          ORDER BY (action = 'unresolved') DESC, drug_name`,
        [id],
      );
      const { rows: summaries } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ip_discharge_summaries WHERE discharge_id = $1 ORDER BY version DESC`,
        [id],
      );

      return {
        discharge,
        reconciliation: recon.map((r) => this.toReconciliation(r)),
        summaries: summaries.map((r) => this.toSummary(r)),
      };
    });
  }

  /**
   * Builds the three lists, every row `unresolved`.
   *
   * This is the half of IP-002 §B.1 that makes the other half real. The trigger
   * refuses a signature while any medicine is unresolved — but if nothing ever
   * created an unresolved row, the count would always be zero and the rule
   * would be decorative. So the list is assembled from what the record already
   * knows: the active MAR orders on this admission, and the last prescription
   * the patient had before they came in.
   *
   * `ON CONFLICT DO NOTHING`: prefill is re-runnable, and re-running it must
   * never reopen a medicine somebody has already decided about. A doctor who
   * stopped a statin at 11 a.m. should not find it unresolved again at noon
   * because a colleague reloaded the screen.
   */
  async prefillReconciliation(dischargeId: string): Promise<readonly ReconciliationRow[]> {
    return this.guard(async (tx) => {
      await tx.query(
        `WITH d AS (
           SELECT id, hospital_id, admission_id FROM clinical.ip_discharges WHERE id = $1
         ),
         a AS (
           SELECT adm.id, adm.patient_id, adm.admitted_at
             FROM clinical.ip_admissions adm JOIN d ON d.admission_id = adm.id
         ),
         inpatient AS (
           SELECT o.drug_name,
                  btrim(concat_ws(' ', o.dose::text, o.dose_unit, o.frequency)) AS dose_text
             FROM clinical.ip_mar_orders o JOIN a ON a.id = o.admission_id
            WHERE o.discontinued_at IS NULL
         ),
         home_rx AS (
           SELECT p.id
             FROM clinical.prescriptions p JOIN a ON a.patient_id = p.patient_id
            WHERE p.signed_at IS NOT NULL AND p.signed_at < a.admitted_at
            ORDER BY p.signed_at DESC
            LIMIT 1
         ),
         home AS (
           SELECT COALESCE(i.generic_name, i.brand_name) AS drug_name,
                  btrim(concat_ws(' ', i.strength_text, i.frequency_code)) AS dose_text
             FROM clinical.prescription_items i JOIN home_rx ON home_rx.id = i.prescription_id
            WHERE COALESCE(i.generic_name, i.brand_name) IS NOT NULL
         ),
         merged AS (
           SELECT COALESCE(h.drug_name, ip.drug_name) AS drug_name,
                  h.dose_text  AS home_dose,
                  ip.dose_text AS inpatient_dose
             FROM home h
             FULL OUTER JOIN inpatient ip
               ON lower(btrim(ip.drug_name)) = lower(btrim(h.drug_name))
         )
         INSERT INTO clinical.ip_med_reconciliations (
           id, hospital_id, discharge_id, admission_id, drug_name,
           home_dose, inpatient_dose, action, created_at, updated_at
         )
         SELECT gen_random_uuid(), d.hospital_id, d.id, d.admission_id, m.drug_name,
                NULLIF(m.home_dose, ''), NULLIF(m.inpatient_dose, ''), 'unresolved', now(), now()
           FROM merged m CROSS JOIN d
          WHERE m.drug_name IS NOT NULL AND btrim(m.drug_name) <> ''
         ON CONFLICT (discharge_id, lower(btrim(drug_name))) DO NOTHING`,
        [dischargeId],
      );

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ip_med_reconciliations
          WHERE discharge_id = $1
          ORDER BY (action = 'unresolved') DESC, drug_name`,
        [dischargeId],
      );
      return rows.map((r) => this.toReconciliation(r));
    });
  }

  /**
   * Records the decisions on a batch of medicines.
   *
   * An upsert on `(discharge_id, drug_name)` rather than an insert: the ward
   * seeds the three lists as `unresolved` rows and the doctor works down them,
   * so every call after the first is a decision on a row that already exists.
   */
  async reconcile(dischargeId: string, body: ReconcileBatchRequest): Promise<readonly ReconciliationRow[]> {
    return this.guard(async (tx) => {
      const actor = this.actorId();

      for (const med of body.medicines) {
        await tx.query(
          `INSERT INTO clinical.ip_med_reconciliations (
             id, hospital_id, discharge_id, admission_id, drug_name,
             home_dose, inpatient_dose, discharge_dose, action, reason,
             decided_at, decided_by, created_at, updated_at
           )
           SELECT $1, d.hospital_id, d.id, d.admission_id, $2,
                  $3, $4, $5, $6::clinical."MedReconAction", $7, now(), $8, now(), now()
             FROM clinical.ip_discharges d WHERE d.id = $9
           ON CONFLICT (discharge_id, lower(btrim(drug_name))) DO UPDATE SET
             home_dose = COALESCE(EXCLUDED.home_dose, clinical.ip_med_reconciliations.home_dose),
             inpatient_dose = COALESCE(EXCLUDED.inpatient_dose, clinical.ip_med_reconciliations.inpatient_dose),
             discharge_dose = EXCLUDED.discharge_dose,
             action = EXCLUDED.action,
             reason = EXCLUDED.reason,
             decided_at = EXCLUDED.decided_at,
             decided_by = EXCLUDED.decided_by,
             updated_at = now()`,
          [
            newId(),
            med.drugName,
            med.homeDose ?? null,
            med.inpatientDose ?? null,
            med.dischargeDose ?? null,
            med.action,
            med.reason ?? null,
            actor,
            dischargeId,
          ],
        );
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'ip_med_reconciliation',
        rowId: dischargeId,
        businessKey: `${String(body.medicines.length)} medicine(s)`,
        dataClass: 'phi',
        before: null,
        after: { medicines: body.medicines.map((m) => `${m.drugName}: ${m.action}`) },
      });

      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ip_med_reconciliations
          WHERE discharge_id = $1
          ORDER BY (action = 'unresolved') DESC, drug_name`,
        [dischargeId],
      );

      const remaining = rows.filter((r) => asText(r['action']) === 'unresolved').length;
      const first = rows[0];
      if (remaining === 0 && first !== undefined) {
        await this.outbox.publish(
          tx,
          dischargeEvent('ip.discharge.medications_reconciled', dischargeId, {
            dischargeId,
            admissionId: asText(first['admission_id']),
            medicineCount: rows.length,
            stopped: rows.filter((r) => asText(r['action']) === 'stop').length,
            changed: rows.filter((r) => asText(r['action']) === 'change').length,
            started: rows.filter((r) => asText(r['action']) === 'new_medicine').length,
          }),
        );
      }

      return rows.map((r) => this.toReconciliation(r));
    });
  }

  /** Saves a draft. A draft is editable; signing it is a separate call. */
  async draftSummary(dischargeId: string, body: DraftSummaryRequest): Promise<SummaryRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_discharge_summaries (
           id, hospital_id, branch_id, discharge_id, admission_id, patient_id, version,
           admission_diagnosis, final_diagnosis, icd10_codes, procedures_performed,
           course_in_hospital, significant_findings, condition_on_discharge,
           discharge_medications, follow_up_plan, red_flag_advice, diet_advice,
           patient_copy_locale, drafted_by, drafted_at, created_at, updated_at
         )
         SELECT $1, d.hospital_id, d.branch_id, d.id, d.admission_id, $2, 1,
                $3, $4, $5::text[], $6::text[], $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15,
                now(), now(), now()
           FROM clinical.ip_discharges d WHERE d.id = $16
         ON CONFLICT (discharge_id, version) DO UPDATE SET
           admission_diagnosis = EXCLUDED.admission_diagnosis,
           final_diagnosis = EXCLUDED.final_diagnosis,
           icd10_codes = EXCLUDED.icd10_codes,
           procedures_performed = EXCLUDED.procedures_performed,
           course_in_hospital = EXCLUDED.course_in_hospital,
           significant_findings = EXCLUDED.significant_findings,
           condition_on_discharge = EXCLUDED.condition_on_discharge,
           discharge_medications = EXCLUDED.discharge_medications,
           follow_up_plan = EXCLUDED.follow_up_plan,
           red_flag_advice = EXCLUDED.red_flag_advice,
           diet_advice = EXCLUDED.diet_advice,
           patient_copy_locale = EXCLUDED.patient_copy_locale,
           updated_at = now()
         RETURNING *`,
        [
          id,
          body.patientId,
          body.admissionDiagnosis ?? null,
          body.finalDiagnosis,
          body.icd10Codes,
          body.proceduresPerformed,
          body.courseInHospital,
          body.significantFindings ?? null,
          body.conditionOnDischarge,
          body.dischargeMedications === undefined ? null : JSON.stringify(body.dischargeMedications),
          body.followUpPlan,
          body.redFlagAdvice,
          body.dietAdvice ?? null,
          body.patientCopyLocale ?? null,
          this.actorId(),
          dischargeId,
        ],
      );

      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That discharge does not exist.');
      return this.toSummary(row);
    });
  }

  /**
   * Signs the current draft.
   *
   * Refused by `summary_is_signed_on_reconciled_medicines` while any medicine
   * is unresolved. Nothing here checks that, on purpose.
   */
  async signSummary(summaryId: string): Promise<SummaryRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const hash = await this.hashOf(tx, summaryId);
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_discharge_summaries
            SET signed_by = $2, signed_at = now(), content_hash = $3, updated_at = now()
          WHERE id = $1 AND signed_at IS NULL
          RETURNING *`,
        [summaryId, actor, hash],
      );

      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That summary does not exist, or it is already signed.');
      }

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'ip_discharge_summary',
        rowId: summaryId,
        businessKey: `v${asText(row['version'])}`,
        dataClass: 'phi',
        before: null,
        after: { version: asNumber(row['version']), contentHash: asTextOrNull(row['content_hash']) },
      });

      await this.outbox.publish(
        tx,
        dischargeEvent('ip.discharge.summary.signed', summaryId, {
          summaryId,
          dischargeId: asText(row['discharge_id']),
          admissionId: asText(row['admission_id']),
          patientId: asText(row['patient_id']),
          version: asNumber(row['version']),
          signedBy: actor,
          amendReason: asTextOrNull(row['amend_reason']),
        }),
      );

      return this.toSummary(row);
    });
  }

  /**
   * The consultant countersigns.
   *
   * `cosigner_is_a_second_person` refuses the signer, so a resident who signed
   * cannot close their own loop even if somebody granted them the key.
   */
  async cosignSummary(summaryId: string): Promise<SummaryRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_discharge_summaries
            SET cosigned_by = $2, cosigned_at = now(), updated_at = now()
          WHERE id = $1 AND signed_at IS NOT NULL AND cosigned_at IS NULL
          RETURNING *`,
        [summaryId, actor],
      );

      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That summary is not signed yet, or it has already been countersigned.');
      }

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'ip_discharge_summary',
        rowId: summaryId,
        businessKey: `v${asText(row['version'])} countersigned`,
        dataClass: 'phi',
        before: null,
        after: { cosignedBy: actor },
      });

      return this.toSummary(row);
    });
  }

  /**
   * Issues a new version of a signed summary.
   *
   * The old version is not touched. `supersedes_id` makes the chain walkable,
   * and the reason is stored on the new version because the reader of an
   * amendment usually has the superseded one in front of them too.
   */
  async amendSummary(summaryId: string, body: AmendSummaryRequest): Promise<SummaryRow> {
    return this.guard(async (tx) => {
      const { rows: previous } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ip_discharge_summaries WHERE id = $1 AND signed_at IS NOT NULL`,
        [summaryId],
      );
      const prior = previous[0];
      if (prior === undefined) {
        throw AppError.conflict('Only a signed summary is amended. An unsigned draft is simply edited.');
      }

      const id = newId();
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_discharge_summaries (
           id, hospital_id, branch_id, discharge_id, admission_id, patient_id,
           version, supersedes_id, amend_reason,
           admission_diagnosis, final_diagnosis, icd10_codes, procedures_performed,
           course_in_hospital, significant_findings, condition_on_discharge,
           discharge_medications, follow_up_plan, red_flag_advice, diet_advice,
           patient_copy_locale, drafted_by, drafted_at, signed_by, signed_at, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,
           $7,$8,$9,
           $10,$11,$12::text[],$13::text[],
           $14,$15,$16,
           $17::jsonb,$18,$19,$20,
           $21,$22, now(), $22, now(), now(), now()
         ) RETURNING *`,
        [
          id,
          asText(prior['hospital_id']),
          asText(prior['branch_id']),
          asText(prior['discharge_id']),
          asText(prior['admission_id']),
          body.patientId,
          asNumber(prior['version']) + 1,
          summaryId,
          body.amendReason,
          body.admissionDiagnosis ?? null,
          body.finalDiagnosis,
          body.icd10Codes,
          body.proceduresPerformed,
          body.courseInHospital,
          body.significantFindings ?? null,
          body.conditionOnDischarge,
          body.dischargeMedications === undefined ? null : JSON.stringify(body.dischargeMedications),
          body.followUpPlan,
          body.redFlagAdvice,
          body.dietAdvice ?? null,
          body.patientCopyLocale ?? null,
          actor,
        ],
      );

      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The amendment was not written.');

      const hash = await this.hashOf(tx, id);
      await tx.query(
        `UPDATE clinical.ip_discharge_summaries SET content_hash = $2, updated_at = now() WHERE id = $1`,
        [id, hash],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'ip_discharge_summary',
        rowId: id,
        businessKey: `v${asText(row['version'])} supersedes v${asText(prior['version'])}`,
        dataClass: 'phi',
        before: { version: asNumber(prior['version']) },
        after: { version: asNumber(row['version']), reason: body.amendReason },
      });

      await this.outbox.publish(
        tx,
        dischargeEvent('ip.discharge.summary.signed', id, {
          summaryId: id,
          dischargeId: asText(row['discharge_id']),
          admissionId: asText(row['admission_id']),
          patientId: asText(row['patient_id']),
          version: asNumber(row['version']),
          signedBy: actor,
          amendReason: body.amendReason,
        }),
      );

      return this.toSummary(row);
    });
  }

  async recordDama(dischargeId: string, body: DamaRequest): Promise<DischargeRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_discharges
            SET kind = 'dama', destination = COALESCE(destination, 'home'),
                dama_risks_explained = $2, dama_witness_name = $3, dama_signed_at = now(),
                updated_at = now()
          WHERE id = $1 AND completed_at IS NULL
          RETURNING *`,
        [dischargeId, body.risksExplained, body.witnessName],
      );

      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That discharge does not exist, or the patient has already left.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'ip_discharge',
        rowId: dischargeId,
        businessKey: 'against medical advice',
        dataClass: 'phi',
        before: null,
        after: { witness: body.witnessName, reason: getContext().reason ?? null },
      });

      await this.outbox.publish(
        tx,
        dischargeEvent('ip.discharge.dama_recorded', dischargeId, {
          dischargeId,
          admissionId: asText(row['admission_id']),
          patientId: asText(row['patient_id']),
          witnessName: body.witnessName,
          signedAt: asText(row['dama_signed_at']),
        }),
      );

      return this.readOne(tx, dischargeId);
    });
  }

  async complete(dischargeId: string, body: CompleteRequest): Promise<DischargeRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_discharges
            SET completed_at = now(), completed_by = $2,
                destination = COALESCE($3, destination),
                gate_pass_no = COALESCE($4, gate_pass_no),
                gate_pass_at = CASE WHEN $4::text IS NULL THEN gate_pass_at ELSE now() END,
                updated_at = now()
          WHERE id = $1 AND completed_at IS NULL
          RETURNING *`,
        [dischargeId, actor, body.destination ?? null, body.gatePassNo ?? null],
      );

      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That discharge does not exist, or the patient has already left.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'ip_discharge',
        rowId: dischargeId,
        businessKey: 'patient left',
        dataClass: 'phi',
        before: null,
        after: { destination: asTextOrNull(row['destination']) },
      });

      await this.outbox.publish(
        tx,
        dischargeEvent('ip.discharge.completed', dischargeId, {
          dischargeId,
          admissionId: asText(row['admission_id']),
          patientId: asText(row['patient_id']),
          kind: asText(row['kind']),
          destination: asTextOrNull(row['destination']),
          completedAt: asText(row['completed_at']),
        }),
      );

      return this.readOne(tx, dischargeId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IP-017 — the mortuary
  // ═══════════════════════════════════════════════════════════════════════════

  async declareDeath(body: DeclareDeathRequest): Promise<MortuaryRow> {
    return this.guard(async (tx) => {
      const id = newId();
      const actor = this.actorId();
      const alloc = await this.numbering.allocate(tx, {
        key: 'MORTUARY',
        branchId: this.branchId(),
        refType: 'mortuary_record',
        refId: id,
      });

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO clinical.ip_mortuary_records (
           id, hospital_id, branch_id, admission_id, patient_id, mlc_id, record_no,
           declared_at, declared_by, cause_of_death, body_tag_no, post_mortem_required,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10,$11,$12, now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          this.branchId(),
          body.admissionId ?? null,
          body.patientId,
          body.mlcId ?? null,
          alloc.formatted,
          body.declaredAt,
          actor,
          body.causeOfDeath,
          body.bodyTagNo,
          body.postMortemRequired,
        ],
      );

      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The death file was not written.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'mortuary_record',
        rowId: id,
        businessKey: alloc.formatted,
        dataClass: 'phi',
        before: null,
        after: { bodyTagNo: body.bodyTagNo, postMortemRequired: body.postMortemRequired },
      });

      await this.outbox.publish(
        tx,
        dischargeEvent('mortuary.case.created', id, {
          recordId: id,
          recordNo: alloc.formatted,
          patientId: body.patientId,
          admissionId: body.admissionId ?? null,
          bodyTagNo: body.bodyTagNo,
          mlc: body.mlcId !== undefined,
          declaredAt: body.declaredAt,
        }),
      );

      return this.toMortuary(row);
    });
  }

  async mortuaryList(query: MortuaryQuery): Promise<Page<MortuaryRow>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM clinical.ip_mortuary_records
          WHERE hospital_id = $1
            AND ($2::boolean IS NOT TRUE OR released_at IS NULL)
          ORDER BY declared_at DESC
          LIMIT $3`,
        [this.hospitalId(), query.inHouseOnly, query.limit],
      );
      return { items: rows.map((r) => this.toMortuary(r)), nextCursor: null, hasMore: false };
    });
  }

  /**
   * Receives the body into cold storage.
   *
   * The scanned tag is compared with the tag on the file and the two must
   * agree. This one *is* checked in the service, because there is no column to
   * compare against — the scan exists only for the length of the request.
   */
  async receiveBody(recordId: string, body: ReceiveBodyRequest): Promise<MortuaryRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows: existing } = await tx.query<Record<string, unknown>>(
        `SELECT body_tag_no FROM clinical.ip_mortuary_records WHERE id = $1`,
        [recordId],
      );
      const found = existing[0];
      if (found === undefined) throw AppError.notFound('That death file does not exist.');

      const expected = asText(found['body_tag_no']);
      if (expected !== body.bodyTagScan.trim()) {
        throw AppError.conflict(
          `The tag scanned at the door reads ${body.bodyTagScan.trim()}, and this file is for ${expected}. ` +
            'Two bodies under one tag is how the wrong one is released. Stop and check both.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_mortuary_records
            SET received_at = now(), received_by = $2, cold_storage_unit = $3,
                last_office_at = CASE WHEN $4 THEN COALESCE(last_office_at, now()) ELSE last_office_at END,
                last_office_by = CASE WHEN $4 THEN COALESCE(last_office_by, $2) ELSE last_office_by END,
                updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [recordId, actor, body.coldStorageUnit, body.lastOfficeDone],
      );

      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That death file does not exist.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'mortuary_record',
        rowId: recordId,
        businessKey: expected,
        dataClass: 'phi',
        before: null,
        after: { coldStorageUnit: body.coldStorageUnit },
      });

      return this.toMortuary(row);
    });
  }

  async issueMccd(recordId: string, body: MccdRequest): Promise<MortuaryRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_mortuary_records
            SET mccd_form = $2, mccd_no = $3, mccd_issued_at = now(), mccd_issued_by = $4,
                registrar_reported_at = COALESCE($5::timestamptz, registrar_reported_at),
                updated_at = now()
          WHERE id = $1 AND mccd_issued_at IS NULL
          RETURNING *`,
        [recordId, body.mccdForm, body.mccdNo, actor, body.registrarReportedAt ?? null],
      );

      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'That death file does not exist, or the certificate has already been issued. A reissue is a new numbered copy, not an edit.',
        );
      }

      await this.audit.write(tx, {
        action: 'sign',
        entity: 'mortuary_record',
        rowId: recordId,
        businessKey: `MCCD ${body.mccdForm}/${body.mccdNo}`,
        dataClass: 'phi',
        before: null,
        after: { mccdForm: body.mccdForm, mccdNo: body.mccdNo },
      });

      await this.outbox.publish(
        tx,
        dischargeEvent('mortuary.certificate.issued', recordId, {
          recordId,
          recordNo: asText(row['record_no']),
          mccdForm: body.mccdForm,
          mccdNo: body.mccdNo,
          issuedBy: actor,
        }),
      );

      return this.toMortuary(row);
    });
  }

  async recordPostMortem(recordId: string, body: PostMortemRequest): Promise<MortuaryRow> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_mortuary_records
            SET post_mortem_at = $2::timestamptz, post_mortem_ref = $3, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [recordId, body.postMortemAt, body.postMortemRef],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That death file does not exist.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'mortuary_record',
        rowId: recordId,
        businessKey: body.postMortemRef,
        dataClass: 'phi',
        before: null,
        after: { postMortemAt: body.postMortemAt },
      });

      return this.toMortuary(row);
    });
  }

  async verifyNok(recordId: string, body: VerifyNokRequest): Promise<MortuaryRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_mortuary_records
            SET nok_name = $2, nok_relationship = $3, nok_id_type = $4, nok_id_ref = $5,
                nok_verified_at = now(), nok_verified_by = $6, updated_at = now()
          WHERE id = $1 AND released_at IS NULL
          RETURNING *`,
        [recordId, body.nokName, body.nokRelationship, body.nokIdType, body.nokIdRef, actor],
      );

      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('That death file does not exist, or the body has already been released.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'mortuary_record',
        rowId: recordId,
        businessKey: `${body.nokName} (${body.nokRelationship})`,
        dataClass: 'phi',
        before: null,
        after: { idType: body.nokIdType },
      });

      return this.toMortuary(row);
    });
  }

  /**
   * What is standing between this body and the door.
   *
   * Derived from the same four facts the trigger reads. If this ever disagrees
   * with the trigger, the trigger is right — this is the explanation, not the
   * decision.
   */
  async releaseChecklist(recordId: string): Promise<ReleaseChecklist> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT m.*, c.mlc_no, c.status::text AS mlc_status
           FROM clinical.ip_mortuary_records m
           LEFT JOIN clinical.mlc_cases c ON c.id = m.mlc_id
          WHERE m.id = $1`,
        [recordId],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That death file does not exist.');

      const unclaimed = asBool(row['unclaimed']);
      const certificateIssued = row['mccd_issued_at'] !== null && row['mccd_no'] !== null;
      const nextOfKinVerified = unclaimed || (row['nok_verified_at'] !== null && row['nok_id_ref'] !== null);
      const mlcStatus = asTextOrNull(row['mlc_status']);
      const mlcCleared = mlcStatus === null || mlcStatus === 'closed' || mlcStatus === 'cancelled';
      const postMortemSettled = !asBool(row['post_mortem_required']) || row['post_mortem_at'] !== null;

      const blockers: string[] = [];
      if (!certificateIssued) blockers.push('The certificate of cause of death has not been issued.');
      if (!nextOfKinVerified) {
        blockers.push('The next of kin has not been identified and checked against a document.');
      }
      if (!mlcCleared) {
        const mlcNo = asTextOrNull(row['mlc_no']);
        blockers.push(
          mlcNo === null
            ? 'The medico-legal case is still open. Police clearance is needed before release.'
            : `Medico-legal case ${mlcNo} is still open. Police clearance is needed before release.`,
        );
      }
      if (!postMortemSettled) blockers.push('A post-mortem is required and has not been performed.');

      return {
        recordId,
        bodyTagNo: asText(row['body_tag_no']),
        certificateIssued,
        nextOfKinVerified,
        mlcCleared,
        postMortemSettled,
        releasable: blockers.length === 0 && row['released_at'] === null,
        blockers,
      };
    });
  }

  /**
   * Releases the body.
   *
   * Writes `released_at` and lets `body_release_is_lawful` decide. The tag is
   * scanned again at the door for the same reason it was scanned coming in.
   */
  async release(recordId: string, body: ReleaseRequest): Promise<MortuaryRow> {
    return this.guard(async (tx) => {
      const actor = this.actorId();
      const { rows: existing } = await tx.query<Record<string, unknown>>(
        `SELECT body_tag_no FROM clinical.ip_mortuary_records WHERE id = $1 AND released_at IS NULL`,
        [recordId],
      );
      const found = existing[0];
      if (found === undefined) {
        throw AppError.conflict('That death file does not exist, or the body has already been released.');
      }

      const expected = asText(found['body_tag_no']);
      if (expected !== body.bodyTagScan.trim()) {
        throw AppError.conflict(
          `The tag scanned at the door reads ${body.bodyTagScan.trim()}, and this file is for ${expected}. ` +
            'A body released against the wrong file cannot be recalled. Stop and check both.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE clinical.ip_mortuary_records
            SET released_at = now(), released_by = $2, release_note = $3, updated_at = now()
          WHERE id = $1 AND released_at IS NULL
          RETURNING *`,
        [recordId, actor, body.releaseNote ?? null],
      );

      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The release was not written.');

      await this.audit.write(tx, {
        action: 'update',
        entity: 'mortuary_record',
        rowId: recordId,
        businessKey: `${asText(row['record_no'])} released`,
        dataClass: 'phi',
        before: null,
        after: {
          releasedTo: asTextOrNull(row['nok_name']),
          relationship: asTextOrNull(row['nok_relationship']),
        },
      });

      await this.outbox.publish(
        tx,
        dischargeEvent('mortuary.body.released', recordId, {
          recordId,
          recordNo: asText(row['record_no']),
          bodyTagNo: expected,
          releasedTo: asTextOrNull(row['nok_name']) ?? 'unclaimed',
          relationship: asTextOrNull(row['nok_relationship']) ?? 'none',
          releasedAt: asText(row['released_at']),
        }),
      );

      return this.toMortuary(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Reading
  // ═══════════════════════════════════════════════════════════════════════════

  private selectDischarge(): string {
    return `SELECT d.*,
                   (SELECT count(*) FROM clinical.ip_med_reconciliations r
                     WHERE r.discharge_id = d.id AND r.action = 'unresolved') AS unresolved_medicines,
                   s.version AS summary_version,
                   s.signed_at AS summary_signed_at
              FROM clinical.ip_discharges d
              LEFT JOIN LATERAL (
                SELECT version, signed_at FROM clinical.ip_discharge_summaries
                 WHERE discharge_id = d.id ORDER BY version DESC LIMIT 1
              ) s ON TRUE`;
  }

  private async readOne(tx: TransactionClient, id: string): Promise<DischargeRow> {
    const { rows } = await tx.query<Record<string, unknown>>(`${this.selectDischarge()} WHERE d.id = $1`, [
      id,
    ]);
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That discharge does not exist.');
    return this.toDischarge(row);
  }

  /**
   * A hash over the fields the immutability trigger protects.
   *
   * Deliberately not the whole row: a countersignature is a legitimate edit,
   * and a hash that changed when one was added would report tampering every
   * time a consultant did their job.
   */
  private async hashOf(tx: TransactionClient, summaryId: string): Promise<string> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT final_diagnosis AS a, course_in_hospital AS b, condition_on_discharge AS c,
              COALESCE(discharge_medications::text, '') AS d, follow_up_plan AS e, red_flag_advice AS f
         FROM clinical.ip_discharge_summaries WHERE id = $1`,
      [summaryId],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('That summary does not exist.');
    const canonical = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => asText(row[k])).join('');
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  private toDischarge(r: Record<string, unknown>): DischargeRow {
    return {
      id: asText(r['id']),
      admissionId: asText(r['admission_id']),
      patientId: asText(r['patient_id']),
      kind: asText(r['kind']),
      destination: asTextOrNull(r['destination']),
      initiatedAt: asText(r['initiated_at']),
      initiatedBy: asText(r['initiated_by']),
      completedAt: asTextOrNull(r['completed_at']),
      followUpAt: asTextOrNull(r['follow_up_at']),
      followUpWith: asTextOrNull(r['follow_up_with']),
      gatePassNo: asTextOrNull(r['gate_pass_no']),
      unresolvedMedicines: asNumber(r['unresolved_medicines'] ?? 0),
      summaryVersion: asNumberOrNull(r['summary_version']),
      summarySignedAt: asTextOrNull(r['summary_signed_at']),
    };
  }

  private toReconciliation(r: Record<string, unknown>): ReconciliationRow {
    return {
      id: asText(r['id']),
      drugName: asText(r['drug_name']),
      homeDose: asTextOrNull(r['home_dose']),
      inpatientDose: asTextOrNull(r['inpatient_dose']),
      dischargeDose: asTextOrNull(r['discharge_dose']),
      action: asText(r['action']),
      reason: asTextOrNull(r['reason']),
      decidedAt: asTextOrNull(r['decided_at']),
      decidedBy: asTextOrNull(r['decided_by']),
    };
  }

  private toSummary(r: Record<string, unknown>): SummaryRow {
    return {
      id: asText(r['id']),
      dischargeId: asText(r['discharge_id']),
      version: asNumber(r['version']),
      supersedesId: asTextOrNull(r['supersedes_id']),
      amendReason: asTextOrNull(r['amend_reason']),
      admissionDiagnosis: asTextOrNull(r['admission_diagnosis']),
      finalDiagnosis: asText(r['final_diagnosis']),
      icd10Codes: asStringArray(r['icd10_codes']),
      proceduresPerformed: asStringArray(r['procedures_performed']),
      courseInHospital: asText(r['course_in_hospital']),
      significantFindings: asTextOrNull(r['significant_findings']),
      conditionOnDischarge: asText(r['condition_on_discharge']),
      dischargeMedications: r['discharge_medications'] ?? null,
      followUpPlan: asText(r['follow_up_plan']),
      redFlagAdvice: asText(r['red_flag_advice']),
      dietAdvice: asTextOrNull(r['diet_advice']),
      patientCopyLocale: asTextOrNull(r['patient_copy_locale']),
      draftedBy: asText(r['drafted_by']),
      draftedAt: asText(r['drafted_at']),
      signedBy: asTextOrNull(r['signed_by']),
      signedAt: asTextOrNull(r['signed_at']),
      cosignedBy: asTextOrNull(r['cosigned_by']),
      cosignedAt: asTextOrNull(r['cosigned_at']),
      contentHash: asTextOrNull(r['content_hash']),
    };
  }

  private toMortuary(r: Record<string, unknown>): MortuaryRow {
    return {
      id: asText(r['id']),
      recordNo: asText(r['record_no']),
      patientId: asText(r['patient_id']),
      admissionId: asTextOrNull(r['admission_id']),
      mlcId: asTextOrNull(r['mlc_id']),
      bodyTagNo: asText(r['body_tag_no']),
      declaredAt: asText(r['declared_at']),
      declaredBy: asText(r['declared_by']),
      causeOfDeath: asText(r['cause_of_death']),
      lastOfficeAt: asTextOrNull(r['last_office_at']),
      receivedAt: asTextOrNull(r['received_at']),
      coldStorageUnit: asTextOrNull(r['cold_storage_unit']),
      mccdForm: asTextOrNull(r['mccd_form']),
      mccdNo: asTextOrNull(r['mccd_no']),
      mccdIssuedAt: asTextOrNull(r['mccd_issued_at']),
      postMortemRequired: asBool(r['post_mortem_required']),
      postMortemAt: asTextOrNull(r['post_mortem_at']),
      postMortemRef: asTextOrNull(r['post_mortem_ref']),
      nokName: asTextOrNull(r['nok_name']),
      nokRelationship: asTextOrNull(r['nok_relationship']),
      nokVerifiedAt: asTextOrNull(r['nok_verified_at']),
      releasedAt: asTextOrNull(r['released_at']),
      releasedBy: asTextOrNull(r['released_by']),
      unclaimed: asBool(r['unclaimed']),
    };
  }
}
