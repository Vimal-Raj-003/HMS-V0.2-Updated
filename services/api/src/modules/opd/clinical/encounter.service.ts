import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { CareTeamService } from './care-team.service.js';
import { mapClinicalConstraints, requireBranch, toNumber } from './clinical.common.js';
import { clinicalEvent } from './clinical.events.js';
import {
  ClinicalDocumentService,
  type ChainVerification,
  type DocumentVersionView,
} from './documents.service.js';
import { MrdService } from './mrd.service.js';
import type {
  AmendEncounterRequest,
  CancelEncounterRequest,
  CompleteEncounterRequest,
  DosingCheckRequest,
  ListEncountersQuery,
  PauseEncounterRequest,
  RecordDiagnosesRequest,
  SetDosingWeightRequest,
  StartEncounterRequest,
  UpdateEncounterRequest,
} from './encounter.schemas.js';

/**
 * OP-002 — the encounter, the consultation, and the signed note.
 *
 * Six properties shape this file.
 *
 * **The lifecycle is a log, not a column.** Every start, pause, resume,
 * completion, amendment and cancellation writes a `clinical.encounter_events`
 * row with actor and instant, because pause/resume is unreconstructible from
 * the encounter row alone and `docs/03` §Table rules requires the history.
 * That table's UPDATE and DELETE are revoked, so the log cannot be tidied.
 *
 * **A signed note is immutable, and the database is what makes it so.** This
 * service never edits a final version; it writes a new one with a reason
 * through `ClinicalDocumentService`. See that file for the trigger it defers to.
 *
 * **A weight is a clinical assertion with an author.** `dosing_weight_source`
 * is a four-arm field whose `unknown` arm is the default and is what blocks
 * per-kilogram dosing (`docs/04` §7). `measured` never accepts a typed-in
 * number: the value is read from the named `clinical.vitals` row.
 *
 * **Opening a chart outside the care team is a recorded act.** `CareTeamService`
 * grants first and records `encounter.break_glass`, rather than refusing a
 * clinician who may have a patient in front of them.
 *
 * **Every mutation writes exactly one audit row per mutated row and its
 * registered outbox event inside the same transaction** (EN-024 §5, `docs/01`
 * §3 step 8).
 *
 * **No query carries a `hospital_id` predicate.** Isolation is row-level
 * security, which is why a cross-tenant id reads as 404 (`docs/09` §3.1 case 2).
 */

const RESOURCE = 'opd.encounters';

/** The four `mdm_code_systems` keys this module accepts → the event's vocabulary. */
const EVENT_CODE_SYSTEM: Readonly<Record<string, string>> = {
  ICD10: 'icd10',
  ICD11: 'icd11',
  SNOMEDCT: 'snomed',
};

export interface EncounterRow {
  readonly id: string;
  readonly patient_id: string;
  readonly visit_id: string | null;
  readonly practitioner_key: string | null;
  readonly doctor_user_id: string | null;
  readonly department_key: string | null;
  readonly type: string;
  readonly status: string;
  readonly started_at: Date;
  readonly completed_at: Date | null;
  readonly cancelled_at: Date | null;
  readonly cancel_reason: string | null;
  readonly active_seconds: number;
  readonly chief_complaint_text: string | null;
  readonly chief_complaint_codes: readonly string[];
  readonly treatment_plan: string | null;
  readonly advice: string | null;
  readonly follow_up_date: Date | null;
  readonly no_diagnosis_reason: string | null;
  readonly dosing_weight_kg: string | null;
  readonly dosing_weight_source: string;
  readonly dosing_weight_at: Date | null;
  readonly dosing_weight_by: string | null;
  readonly dosing_weight_vitals_id: string | null;
  readonly cosign_required: boolean;
  readonly signed_document_id: string | null;
  readonly version: number;
}

export interface DiagnosisRow {
  readonly id: string;
  readonly code_system_key: string;
  readonly code: string;
  readonly description: string;
  readonly rank: string;
  readonly certainty: string;
  readonly severity: string | null;
  readonly laterality: string;
  readonly is_chronic: boolean;
  readonly is_notifiable: boolean;
  readonly problem_id: string | null;
  readonly coding_status: string;
}

export interface EncounterDetail extends EncounterRow {
  readonly diagnoses: readonly DiagnosisRow[];
  readonly note: Record<string, unknown> | null;
  readonly note_document_id: string | null;
  readonly note_version: number | null;
  readonly note_status: string | null;
  /** True when this read was granted by break-glass rather than by care team. */
  readonly break_glass: boolean;
}

export interface DosingContext {
  readonly encounterId: string;
  readonly weightKg: number | null;
  readonly source: string;
  readonly assertedAt: Date | null;
  readonly assertedBy: string | null;
  readonly vitalsId: string | null;
  readonly doseMg: number;
}

@Injectable()
export class EncounterService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(CareTeamService) private readonly careTeam: CareTeamService,
    @Inject(ClinicalDocumentService) private readonly documents: ClinicalDocumentService,
    @Inject(MrdService) private readonly mrd: MrdService,
  ) {}

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * OP-002 §6 `POST /encounters` — start the consultation.
   *
   * OP-002 §5: a consultation may start only for a visit in `waiting_doctor`,
   * or in `waiting_vitals` when the doctor overrides "see without vitals" —
   * and that override is logged, which is why it carries a reason rather than
   * being a boolean.
   */
  async start(body: StartEncounterRequest, idempotencyKey: string | null): Promise<EncounterDetail> {
    const branchId = requireBranch();
    const actor = this.actor();
    const id = newId();

    const created = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const replay = await this.findReplay(tx, idempotencyKey);
      if (replay !== null) return replay;

      const visit = await tx.maybeOne<VisitRow>(
        `SELECT v.id, v.patient_id, v.status::text AS status, v.practitioner_key, v.department_key,
                v.speciality_key, v.appointment_id, v.branch_id, p.uhid
           FROM clinical.op_visits v
           JOIN patient.patients p ON p.id = v.patient_id
          WHERE v.id = $1
          FOR UPDATE OF v`,
        [body.visitId],
      );
      if (visit === undefined) throw AppError.notFound('The visit');

      // Checked before the status rule: once a consultation is open the visit is
      // `in_consult`, and "this visit is in_consult" would name the consequence
      // rather than the cause.
      const open = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM clinical.encounters
          WHERE visit_id = $1 AND status IN ('draft', 'in_progress', 'paused')`,
        [body.visitId],
      );
      if (open !== undefined) {
        throw AppError.conflict(
          'A consultation is already open on this visit. Resume it rather than starting a second one.',
        );
      }

      const override = this.assertStartable(visit, body);

      await mapClinicalConstraints(async () =>
        tx.query(
          `INSERT INTO clinical.encounters (
             id, hospital_id, branch_id, patient_id, visit_id, appointment_id,
             practitioner_key, doctor_user_id, department_key, speciality_key,
             type, status, started_at, cosign_required, idempotency_key,
             created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6,
             $7, $8, $9, $10,
             $11::clinical."EncounterType", 'in_progress', now(), $12, $13,
             $14, $14, now()
           )`,
          [
            id,
            getContext().hospitalId,
            branchId,
            visit.patient_id,
            visit.id,
            visit.appointment_id,
            body.practitionerKey ?? visit.practitioner_key,
            actor,
            body.departmentKey ?? visit.department_key,
            body.specialityKey ?? visit.speciality_key,
            body.type,
            body.cosignRequired,
            idempotencyKey,
            actor,
          ],
        ),
      );

      await this.recordEvent(tx, {
        encounterId: id,
        kind: 'started',
        fromStatus: null,
        toStatus: 'in_progress',
        reason: override,
      });

      // The consultation note starts as a draft immediately, so the five-second
      // autosave in OP-002 §3.2.7 has somewhere to land from the first keystroke
      // rather than only after the doctor types something worth saving.
      await this.documents.openDraft(tx, {
        branchId,
        patientId: visit.patient_id,
        encounterId: id,
        visitId: visit.id,
        type: 'consult_note',
        title: 'OPD consultation note',
        content: {},
        contentText: null,
      });

      // NC-003 / phase-02 §2.7: "every encounter creates a medical record entry".
      await this.mrd.openRecord(tx, {
        branchId,
        patientId: visit.patient_id,
        encounterId: id,
        encounterKind: 'op',
        uhid: visit.uhid,
      });

      // OP-001 owns the visit lifecycle and consumes `visit.consult.started` to
      // move it. The relay is asynchronous, and a queue card still reading
      // "waiting" after the doctor has started would have the patient called
      // twice — so the status is moved here, in the same transaction, and the
      // event is still published for every other consumer (EN-018's board,
      // OP-005's post-consult charge). Recorded as a deliberate cross-module
      // write of one lifecycle column, not as a general licence.
      await tx.query(
        `UPDATE clinical.op_visits
            SET status = 'in_consult', consult_started_at = COALESCE(consult_started_at, now()),
                updated_at = now(), updated_by = $2, version = version + 1
          WHERE id = $1`,
        [visit.id, actor],
      );

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'clinical.encounters',
        rowId: id,
        businessKey: visit.uhid,
        dataClass: 'phi',
        patientId: visit.patient_id,
        encounterId: id,
        before: null,
        after: {
          visit_id: visit.id,
          type: body.type,
          status: 'in_progress',
          cosign_required: body.cosignRequired,
          seen_without_vitals: override,
        },
        reasonText: override,
      });

      await this.outbox.publish(
        tx,
        clinicalEvent('visit.consult.started', id, {
          encounterId: id,
          visitId: visit.id,
          patientId: visit.patient_id,
          doctorUserId: actor,
          departmentKey: body.departmentKey ?? visit.department_key,
          startedAt: new Date().toISOString(),
        }),
      );

      return id;
    });

    return this.get(created);
  }

  /** OP-002 §6 `PATCH /encounters/{id}` — the five-second autosave. */
  async update(id: string, body: UpdateEncounterRequest): Promise<EncounterDetail> {
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const encounter = await this.lock(tx, id);
      this.assertOpen(encounter);

      if (encounter.version !== body.version) {
        throw new AppError(
          ProblemType.OPTIMISTIC_LOCK_CONFLICT,
          'This consultation was changed elsewhere since you loaded it. Reload and re-apply your edit.',
          { nextAction: 'Reload the encounter; your text is preserved in the draft.' },
        );
      }

      await mapClinicalConstraints(async () =>
        tx.query(
          `UPDATE clinical.encounters
              SET chief_complaint_text = COALESCE($2::text, chief_complaint_text),
                  chief_complaint_codes = COALESCE($3::text[], chief_complaint_codes),
                  treatment_plan = COALESCE($4::text, treatment_plan),
                  advice = COALESCE($5::text, advice),
                  advice_codes = COALESCE($6::text[], advice_codes),
                  follow_up_date = COALESCE($7::date, follow_up_date),
                  follow_up_interval_days = COALESCE($8::int, follow_up_interval_days),
                  no_diagnosis_reason = COALESCE($9::text, no_diagnosis_reason),
                  updated_at = now(), updated_by = $10::uuid, version = version + 1
            WHERE id = $1`,
          [
            id,
            body.chiefComplaintText ?? null,
            body.chiefComplaintCodes ?? null,
            body.treatmentPlan ?? null,
            body.advice ?? null,
            body.adviceCodes ?? null,
            body.followUpDate ?? null,
            body.followUpIntervalDays ?? null,
            body.noDiagnosisReason ?? null,
            this.actor(),
          ],
        ),
      );

      if (body.note !== undefined) {
        const documentId = await this.noteDocumentId(tx, id);
        await this.documents.updateDraft(tx, documentId, body.note, renderNoteText(body.note));
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.encounters',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: encounter.patient_id,
        encounterId: id,
        before: { version: encounter.version },
        after: {
          version: encounter.version + 1,
          fields: Object.keys(body).filter((key) => key !== 'version'),
        },
      });
    });

    return this.get(id);
  }

  /** OP-002 §3 — pause and resume, so a paused consult does not hold the queue slot. */
  async setPaused(id: string, paused: boolean, body: PauseEncounterRequest): Promise<EncounterDetail> {
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const encounter = await this.lock(tx, id);
      const target = paused ? 'paused' : 'in_progress';
      const from = paused ? 'in_progress' : 'paused';

      if (encounter.status !== from) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `This consultation is ${encounter.status} and cannot be ${paused ? 'paused' : 'resumed'}.`,
        );
      }

      await tx.query(
        `UPDATE clinical.encounters
            SET status = $2::clinical."EncounterStatus", updated_at = now(), updated_by = $3,
                version = version + 1
          WHERE id = $1`,
        [id, target, this.actor()],
      );

      await this.recordEvent(tx, {
        encounterId: id,
        kind: paused ? 'paused' : 'resumed',
        fromStatus: from,
        toStatus: target,
        reason: body.reason ?? null,
      });

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.encounters',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: encounter.patient_id,
        encounterId: id,
        before: { status: from },
        after: { status: target },
        reasonText: body.reason ?? null,
      });
    });

    return this.get(id);
  }

  /** OP-002 §6 — cancel, with a reason the database also insists on. */
  async cancel(id: string, body: CancelEncounterRequest): Promise<EncounterDetail> {
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const encounter = await this.lock(tx, id);
      if (encounter.status === 'completed' || encounter.status === 'amended') {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'A completed consultation cannot be cancelled. Amend the note instead; the correction is part of the record.',
        );
      }
      if (encounter.status === 'cancelled') {
        throw new AppError(ProblemType.ALREADY_DECIDED, 'This consultation is already cancelled.');
      }

      await mapClinicalConstraints(async () =>
        tx.query(
          `UPDATE clinical.encounters
              SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.reason, this.actor()],
        ),
      );

      await this.recordEvent(tx, {
        encounterId: id,
        kind: 'cancelled',
        fromStatus: encounter.status,
        toStatus: 'cancelled',
        reason: body.reason,
      });

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.encounters',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: encounter.patient_id,
        encounterId: id,
        before: { status: encounter.status },
        after: { status: 'cancelled' },
        reasonText: body.reason,
      });
    });

    return this.get(id);
  }

  // ── diagnoses ─────────────────────────────────────────────────────────────

  /**
   * OP-002 §6 `POST /encounters/{id}/diagnoses`.
   *
   * The spec calls it "add/replace". **Replace is not implementable and should
   * not be**: the migration revokes DELETE on `clinical.encounter_diagnoses`,
   * because what a doctor wrote on a day is not something a later edit removes.
   * So a code already on the encounter is updated in place and a new one is
   * added; removing one is a `certainty` of `rule_out`, which is a clinical
   * statement rather than an erasure.
   *
   * The primary is demoted before the new one is written, so "make B primary"
   * does not trip `uq_encounter_diagnoses_primary` on the way through.
   */
  async recordDiagnoses(id: string, body: RecordDiagnosesRequest): Promise<EncounterDetail> {
    const actor = this.actor();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const encounter = await this.lock(tx, id);
      this.assertOpen(encounter);

      const wantsPrimary = body.diagnoses.find((d) => d.rank === 'primary');
      if (wantsPrimary !== undefined) {
        await tx.query(
          `UPDATE clinical.encounter_diagnoses
              SET rank = 'secondary', updated_at = now(), updated_by = $3
            WHERE encounter_id = $1 AND rank = 'primary'
              AND NOT (code_system_key = $2 AND code = $4)`,
          [id, wantsPrimary.codeSystemKey, actor, wantsPrimary.code],
        );
      }

      for (const diagnosis of body.diagnoses) {
        const problemId = await this.upsertProblem(tx, {
          patientId: encounter.patient_id,
          encounterId: id,
          codeSystemKey: diagnosis.codeSystemKey,
          code: diagnosis.code,
          description: diagnosis.description,
          isChronic: diagnosis.isChronic,
          onsetDate: diagnosis.onsetDate ?? null,
          certainty: diagnosis.certainty,
        });

        await mapClinicalConstraints(async () =>
          tx.query(
            `INSERT INTO clinical.encounter_diagnoses (
               id, hospital_id, encounter_id, patient_id, code_system_key, code, code_version,
               snomed_code, description, rank, certainty, severity, laterality, onset_date,
               is_chronic, is_notifiable, problem_id, coded_by, created_by, updated_by, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7,
               $8, $9, $10::clinical."DiagnosisRank", $11::clinical."DiagnosisCertainty", $12,
               $13::clinical."Laterality", $14::date,
               $15, $16, $17, $18, $18, $18, now()
             )
             ON CONFLICT (encounter_id, code_system_key, code) DO UPDATE
                SET description = EXCLUDED.description,
                    rank = EXCLUDED.rank,
                    certainty = EXCLUDED.certainty,
                    severity = EXCLUDED.severity,
                    laterality = EXCLUDED.laterality,
                    onset_date = EXCLUDED.onset_date,
                    is_chronic = EXCLUDED.is_chronic,
                    is_notifiable = EXCLUDED.is_notifiable,
                    problem_id = EXCLUDED.problem_id,
                    updated_at = now(),
                    updated_by = EXCLUDED.updated_by`,
            [
              newId(),
              getContext().hospitalId,
              id,
              encounter.patient_id,
              diagnosis.codeSystemKey,
              diagnosis.code,
              diagnosis.codeVersion ?? null,
              diagnosis.snomedCode ?? null,
              diagnosis.description,
              diagnosis.rank,
              diagnosis.certainty,
              diagnosis.severity ?? null,
              diagnosis.laterality,
              diagnosis.onsetDate ?? null,
              diagnosis.isChronic,
              diagnosis.isNotifiable,
              problemId,
              actor,
            ],
          ),
        );
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.encounter_diagnoses',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: encounter.patient_id,
        encounterId: id,
        before: null,
        after: {
          codes: body.diagnoses.map((d) => `${d.codeSystemKey}:${d.code}`),
          notifiable: body.diagnoses.filter((d) => d.isNotifiable).map((d) => d.code),
        },
        rowCount: body.diagnoses.length,
      });

      await this.outbox.publish(
        tx,
        clinicalEvent('diagnosis.recorded', id, {
          encounterId: id,
          patientId: encounter.patient_id,
          codes: body.diagnoses.map((d) => ({
            code: d.code,
            system: EVENT_CODE_SYSTEM[d.codeSystemKey] ?? 'icd10',
            rank: d.rank,
            certainty: d.certainty,
          })),
          recordedBy: actor,
          codingStatus: 'doctor',
          recordedAt: new Date().toISOString(),
        }),
      );
    });

    return this.get(id);
  }

  // ── the dosing weight ─────────────────────────────────────────────────────

  /**
   * `POST /encounters/{id}/dosing-weight`.
   *
   * `measured` reads the weight from the named observation set rather than
   * accepting a number, so "measured" cannot mean "typed in and called
   * measured". All three arms stamp the asserter and the instant, which the
   * `encounters_dosing_weight_attributed` CHECK requires — a back-filled
   * encounter can therefore never silently claim somebody weighed the patient.
   */
  async setDosingWeight(id: string, body: SetDosingWeightRequest): Promise<EncounterDetail> {
    const actor = this.actor();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const encounter = await this.lock(tx, id);
      this.assertOpen(encounter);

      let weightKg: number;
      let vitalsId: string | null = null;

      if (body.source === 'measured') {
        const observation = await tx.maybeOne<{ weight_kg: string | null; patient_id: string }>(
          `SELECT weight_kg, patient_id FROM clinical.vitals WHERE id = $1`,
          [body.vitalsId],
        );
        if (observation === undefined) throw AppError.notFound('The observation set');
        if (observation.patient_id !== encounter.patient_id) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'That observation set belongs to a different patient.',
          );
        }
        const measured = toNumber(observation.weight_kg);
        if (measured === null) {
          throw new AppError(
            ProblemType.CLINICAL_HARD_STOP,
            'That observation set has no weight in it. Weigh the patient and record it before dosing by weight.',
            {
              nextAction: 'Send the patient back to the vitals station, or record a stated weight instead.',
              clinicalImpact: 'A per-kilogram dose computed from a guessed weight is a dosing error.',
            },
          );
        }
        weightKg = measured;
        vitalsId = body.vitalsId;
      } else {
        weightKg = body.weightKg;
      }

      await mapClinicalConstraints(async () =>
        tx.query(
          `UPDATE clinical.encounters
              SET dosing_weight_kg = $2,
                  dosing_weight_source = $3::clinical."DosingWeightSource",
                  dosing_weight_at = now(),
                  dosing_weight_by = $4,
                  dosing_weight_vitals_id = $5,
                  updated_at = now(), updated_by = $4, version = version + 1
            WHERE id = $1`,
          [id, weightKg, body.source, actor, vitalsId],
        ),
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.encounters',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: encounter.patient_id,
        encounterId: id,
        before: {
          dosing_weight_kg: toNumber(encounter.dosing_weight_kg),
          dosing_weight_source: encounter.dosing_weight_source,
        },
        after: { dosing_weight_kg: weightKg, dosing_weight_source: body.source, vitals_id: vitalsId },
      });
    });

    return this.get(id);
  }

  /**
   * `POST /encounters/{id}/dosing-weight/check` — the per-kilogram precondition.
   *
   * phase-02 exit gate 3, second half: "**missing weight blocks paediatric
   * dosing**". `docs/04` §7 lists it among the hard stops configuration can
   * never remove, and EN-029 §3.8 is blunt about why: "safer to block than to
   * guess".
   *
   * This is not the dose-range rule — that is EN-029's, and it belongs to the
   * prescribing module. This answers only the question the encounter owns: is
   * there a weight, asserted by somebody, that a per-kilogram dose may be
   * computed from? There is no configuration flag on this path, because there
   * is nothing here to configure: the refusal follows from `dosing_weight_source
   * = 'unknown'`, which is the same value the CHECK constraint ties to a NULL
   * weight.
   */
  async dosingCheck(id: string, body: DosingCheckRequest): Promise<DosingContext> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const encounter = await tx.maybeOne<EncounterRow>(`${ENCOUNTER_SELECT} WHERE e.id = $1`, [id]);
      if (encounter === undefined) throw AppError.notFound('The encounter');

      const weightKg = toNumber(encounter.dosing_weight_kg);
      if (encounter.dosing_weight_source === 'unknown' || weightKg === null) {
        throw new AppError(
          ProblemType.CLINICAL_HARD_STOP,
          `${body.drugLabel ?? 'This drug'} is dosed per kilogram and this patient has no recorded weight. Record the weight before prescribing.`,
          {
            nextAction: 'Weigh the patient, or record a stated weight on the encounter.',
            clinicalImpact:
              'A per-kilogram dose computed from a guessed weight is a dosing error, and in a child a ten-fold one.',
          },
        );
      }

      return {
        encounterId: id,
        weightKg,
        source: encounter.dosing_weight_source,
        assertedAt: encounter.dosing_weight_at,
        assertedBy: encounter.dosing_weight_by,
        vitalsId: encounter.dosing_weight_vitals_id,
        doseMg: Math.round(body.mgPerKg * weightKg * 1000) / 1000,
      };
    });
  }

  // ── completion and amendment ──────────────────────────────────────────────

  /**
   * OP-002 §6 `POST /encounters/{id}/complete` — sign the note and finish.
   *
   * §14 AC-16: completion is blocked without a diagnosis or a stated reason for
   * having none. The database carries the same rule as a CHECK on the encounter;
   * refusing here means the doctor is told which of the two is missing.
   */
  async complete(id: string, body: CompleteEncounterRequest): Promise<EncounterDetail> {
    const branchId = requireBranch();
    const actor = this.actor();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const encounter = await this.lock(tx, id);
      if (encounter.status === 'completed' || encounter.status === 'amended') {
        throw new AppError(ProblemType.ALREADY_DECIDED, 'This consultation has already been completed.');
      }
      this.assertOpen(encounter);

      const diagnoses = await tx.rows<{
        code: string;
        code_system_key: string;
        rank: string;
        certainty: string;
      }>(
        `SELECT code, code_system_key, rank::text AS rank, certainty::text AS certainty
           FROM clinical.encounter_diagnoses WHERE encounter_id = $1`,
        [id],
      );
      const noDiagnosisReason = body.noDiagnosisReason ?? encounter.no_diagnosis_reason;

      if (diagnoses.length === 0 && (noDiagnosisReason === null || noDiagnosisReason.length === 0)) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'Record a diagnosis, or say why there is none, before completing the consultation (OP-002 §14 AC-16).',
          { nextAction: 'Add a diagnosis or give a "no diagnosis" reason.' },
        );
      }
      if (diagnoses.length > 0 && diagnoses.filter((d) => d.rank === 'primary').length !== 1) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'Exactly one diagnosis must be marked primary before the consultation is completed (OP-002 §5).',
        );
      }

      const documentId = await this.noteDocumentId(tx, id);
      const signed = await this.documents.sign(tx, {
        documentId,
        patientId: encounter.patient_id,
        signMethod: body.signMethod,
        ...(body.note === undefined ? {} : { content: body.note, contentText: renderNoteText(body.note) }),
      });

      const activeSeconds = await this.activeSecondsOf(tx, id, encounter.started_at);

      await mapClinicalConstraints(async () =>
        tx.query(
          `UPDATE clinical.encounters
              SET status = 'completed', completed_at = now(), active_seconds = $2,
                  no_diagnosis_reason = COALESCE($3::text, no_diagnosis_reason),
                  follow_up_date = COALESCE($4::date, follow_up_date),
                  signed_document_id = $5,
                  updated_at = now(), updated_by = $6, version = version + 1
            WHERE id = $1`,
          [id, activeSeconds, body.noDiagnosisReason ?? null, body.followUpDate ?? null, documentId, actor],
        ),
      );

      await this.recordEvent(tx, {
        encounterId: id,
        kind: 'completed',
        fromStatus: encounter.status,
        toStatus: 'completed',
        reason: null,
      });

      if (encounter.visit_id !== null) {
        // Same deliberate cross-module lifecycle write as `start()`; see the
        // comment there.
        await tx.query(
          `UPDATE clinical.op_visits
              SET status = 'consult_done', consult_ended_at = now(),
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1 AND status = 'in_consult'`,
          [encounter.visit_id, actor],
        );
      }

      const record = await this.mrdRecordFor(tx, id);
      if (record !== null) {
        await this.mrd.fileDocument(tx, {
          recordId: record,
          documentId,
          documentVersion: signed.version,
          section: 'history_exam',
        });
        await this.mrd.evaluateDeficiencies(tx, {
          recordId: record,
          branchId,
          patientId: encounter.patient_id,
          encounterId: id,
          visitId: encounter.visit_id,
          encounterKind: 'op',
        });
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.encounters',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: encounter.patient_id,
        encounterId: id,
        before: { status: encounter.status },
        after: {
          status: 'completed',
          diagnoses: diagnoses.length,
          signed_document_id: documentId,
          note_version: signed.version,
          active_seconds: activeSeconds,
        },
        artifactSha256: signed.contentSha256,
      });

      await this.outbox.publish(
        tx,
        clinicalEvent('visit.consult.completed', id, {
          encounterId: id,
          visitId: encounter.visit_id,
          patientId: encounter.patient_id,
          doctorUserId: encounter.doctor_user_id ?? actor,
          diagnoses: diagnoses.map((d) => ({
            code: d.code,
            system: EVENT_CODE_SYSTEM[d.code_system_key] ?? 'icd10',
            rank: d.rank as 'primary' | 'secondary',
            certainty: d.certainty as 'provisional' | 'confirmed' | 'rule_out' | 'chronic',
          })),
          noDiagnosisReason: noDiagnosisReason,
          followUpDate: body.followUpDate ?? formatDate(encounter.follow_up_date),
          signedDocumentId: documentId,
          completedAt: new Date().toISOString(),
        }),
      );
    });

    return this.get(id);
  }

  /**
   * OP-002 §6 `POST /encounters/{id}/reopen` — the addendum, and §14 AC-9's
   * amendment.
   *
   * A new version with a reason. The previous version keeps its content, its
   * hash and its signature, and the chain still verifies — which is exactly what
   * phase-02 exit gate 4 asks for, and why this path never issues an UPDATE
   * against a signed row.
   *
   * There is no registered event for an amendment in `packages/contracts`, so
   * none is published: the fact is carried by the `clinical.encounter_events`
   * row and the audit entry. Reported rather than papered over by inventing one.
   */
  async amend(id: string, body: AmendEncounterRequest): Promise<EncounterDetail> {
    const branchId = requireBranch();
    const actor = this.actor();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const encounter = await this.lock(tx, id);
      if (encounter.status !== 'completed' && encounter.status !== 'amended') {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'Only a completed consultation can be amended. Edit the draft instead.',
        );
      }

      const documentId = await this.noteDocumentId(tx, id);
      const amended = await this.documents.amend(tx, {
        documentId,
        patientId: encounter.patient_id,
        reason: body.reason,
        content: body.note,
        contentText: renderNoteText(body.note),
        signMethod: body.signMethod,
      });

      await tx.query(
        `UPDATE clinical.encounters
            SET status = 'amended', updated_at = now(), updated_by = $2, version = version + 1
          WHERE id = $1`,
        [id, actor],
      );

      await this.recordEvent(tx, {
        encounterId: id,
        kind: 'amended',
        fromStatus: encounter.status,
        toStatus: 'amended',
        reason: body.reason,
      });

      const record = await this.mrdRecordFor(tx, id);
      if (record !== null) {
        await this.mrd.fileDocument(tx, {
          recordId: record,
          documentId,
          documentVersion: amended.version,
          section: 'history_exam',
          source: 'late_entry',
          lateEntryReason: body.reason,
        });
        await this.mrd.evaluateDeficiencies(tx, {
          recordId: record,
          branchId,
          patientId: encounter.patient_id,
          encounterId: id,
          visitId: encounter.visit_id,
          encounterKind: 'op',
        });
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'clinical.encounters',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: encounter.patient_id,
        encounterId: id,
        before: { status: encounter.status, note_version: amended.version - 1 },
        after: { status: 'amended', note_version: amended.version },
        reasonText: body.reason,
        artifactSha256: amended.contentSha256,
      });
    });

    return this.get(id);
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  /** OP-002 §6 `GET /encounters/{id}` — the full encounter, break-glass aware. */
  async get(id: string): Promise<EncounterDetail> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const encounter = await tx.maybeOne<EncounterRow>(`${ENCOUNTER_SELECT} WHERE e.id = $1`, [id]);
      if (encounter === undefined) throw AppError.notFound('The encounter');

      const access = await this.careTeam.authorise(tx, {
        patientId: encounter.patient_id,
        encounterId: id,
        entity: 'clinical.encounters',
      });

      const diagnoses = await tx.rows<DiagnosisRow>(
        `SELECT id, code_system_key, code, description, rank::text AS rank,
                certainty::text AS certainty, severity, laterality::text AS laterality,
                is_chronic, is_notifiable, problem_id, coding_status
           FROM clinical.encounter_diagnoses
          WHERE encounter_id = $1
          ORDER BY rank, created_at`,
        [id],
      );

      const note = await tx.maybeOne<{
        document_id: string;
        version: number;
        status: string;
        content: Record<string, unknown>;
      }>(
        `SELECT v.document_id, v.version, v.status::text AS status, v.content
           FROM clinical.document_versions v
           JOIN clinical.documents d ON d.id = v.document_id
          WHERE d.encounter_id = $1 AND d.type = 'consult_note'
          ORDER BY v.version DESC
          LIMIT 1`,
        [id],
      );

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'clinical.encounters',
        rowId: id,
        businessKey: null,
        dataClass: 'phi',
        patientId: encounter.patient_id,
        encounterId: id,
        before: null,
        after: null,
        rowCount: 1,
      });

      return {
        ...encounter,
        diagnoses,
        note: note?.content ?? null,
        note_document_id: note?.document_id ?? null,
        note_version: note?.version ?? null,
        note_status: note?.status ?? null,
        break_glass: access.breakGlass,
      };
    });
  }

  /** OP-002 §6 — the doctor's own list of encounters, keyset-paginated. */
  async list(query: ListEncountersQuery): Promise<Page<EncounterRow>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const resource = `${RESOURCE}.list`;
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = (value: unknown): string => `$${values.push(value)}`;
      const where: string[] = [];

      if (query.patient !== undefined) where.push(`e.patient_id = ${bind(query.patient)}::uuid`);
      if (query.visit !== undefined) where.push(`e.visit_id = ${bind(query.visit)}::uuid`);
      if (query.status !== undefined) {
        where.push(`e.status = ${bind(query.status)}::clinical."EncounterStatus"`);
      }
      if (query.from !== undefined) where.push(`e.started_at >= ${bind(query.from)}::timestamptz`);
      if (query.to !== undefined) where.push(`e.started_at <= ${bind(query.to)}::timestamptz`);
      if (after !== null) {
        where.push(`(e.started_at, e.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }

      const fetched = await tx.rows<EncounterRow & { cursor_key: string }>(
        `SELECT ${ENCOUNTER_COLUMNS}, e.started_at::text AS cursor_key
           FROM clinical.encounters e
          ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
          ORDER BY e.started_at DESC, e.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<EncounterRow>(fetched, limit, {
        hospitalId,
        resource,
        direction: 'desc',
      });

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'clinical.encounters',
        rowId: query.patient ?? null,
        businessKey: null,
        dataClass: 'phi',
        patientId: query.patient ?? null,
        before: null,
        after: null,
        rowCount: page.items.length,
      });

      return page;
    });
  }

  /** The note's full version history, with the chain re-verified from scratch. */
  async noteHistory(id: string): Promise<{
    readonly documentId: string;
    readonly versions: readonly DocumentVersionView[];
    readonly chain: ChainVerification;
  }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const encounter = await tx.maybeOne<{ patient_id: string }>(
        `SELECT patient_id FROM clinical.encounters WHERE id = $1`,
        [id],
      );
      if (encounter === undefined) throw AppError.notFound('The encounter');

      await this.careTeam.authorise(tx, {
        patientId: encounter.patient_id,
        encounterId: id,
        entity: 'clinical.document_versions',
      });

      const documentId = await this.noteDocumentId(tx, id);
      const versions = await this.documents.versions(tx, documentId);
      const chain = await this.documents.verifyChain(tx, documentId);

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'clinical.document_versions',
        rowId: documentId,
        businessKey: null,
        dataClass: 'phi',
        patientId: encounter.patient_id,
        encounterId: id,
        before: null,
        after: null,
        rowCount: versions.length,
      });

      return { documentId, versions, chain };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private actor(): string {
    const userId = getContext().userId;
    if (userId === null) {
      throw new Error('EncounterService reached without an authenticated user; a guarded route cannot.');
    }
    return userId;
  }

  private async findReplay(tx: TransactionClient, key: string | null): Promise<string | null> {
    if (key === null) return null;
    const existing = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM clinical.encounters WHERE idempotency_key = $1`,
      [key],
    );
    return existing?.id ?? null;
  }

  private async lock(tx: TransactionClient, id: string): Promise<EncounterRow> {
    const row = await tx.maybeOne<EncounterRow>(`${ENCOUNTER_SELECT} WHERE e.id = $1 FOR UPDATE`, [id]);
    if (row === undefined) throw AppError.notFound('The encounter');
    return row;
  }

  private assertOpen(encounter: EncounterRow): void {
    if (encounter.status === 'completed' || encounter.status === 'amended') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'This consultation is signed. Record an amendment instead; the original stays part of the record.',
        { nextAction: 'Use the amend action.' },
      );
    }
    if (encounter.status === 'cancelled') {
      throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, 'This consultation was cancelled.');
    }
  }

  /** Returns the "see without vitals" reason when the override was used. */
  private assertStartable(visit: VisitRow, body: StartEncounterRequest): string | null {
    if (visit.status === 'waiting_doctor') return null;

    if (visit.status === 'waiting_vitals') {
      const override = body.seeWithoutVitals;
      if (override === undefined) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          'This patient has not been through the vitals room. Start anyway only by recording why (OP-002 §5).',
          {
            nextAction:
              'Send the patient to the vitals station, or start with a "see without vitals" reason.',
          },
        );
      }
      return override.reason;
    }

    throw new AppError(
      ProblemType.BUSINESS_RULE_VIOLATED,
      `This visit is ${visit.status}; a consultation can only start from the doctor's queue.`,
    );
  }

  private async recordEvent(
    tx: TransactionClient,
    input: {
      readonly encounterId: string;
      readonly kind: string;
      readonly fromStatus: string | null;
      readonly toStatus: string | null;
      readonly reason: string | null;
    },
  ): Promise<void> {
    const ctx = getContext();
    await tx.query(
      `INSERT INTO clinical.encounter_events (
         id, hospital_id, encounter_id, kind, from_status, to_status, reason, actor_user_id, actor_role
       ) VALUES (
         $1, $2, $3, $4::clinical."EncounterEventKind",
         $5::clinical."EncounterStatus", $6::clinical."EncounterStatus", $7, $8, $9
       )`,
      [
        newId(),
        ctx.hospitalId,
        input.encounterId,
        input.kind,
        input.fromStatus,
        input.toStatus,
        input.reason,
        ctx.userId,
        ctx.roleKeys[0] ?? null,
      ],
    );
  }

  private async noteDocumentId(tx: TransactionClient, encounterId: string): Promise<string> {
    const row = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM clinical.documents
        WHERE encounter_id = $1 AND type = 'consult_note'
        ORDER BY created_at
        LIMIT 1`,
      [encounterId],
    );
    if (row === undefined) throw AppError.notFound('The consultation note');
    return row.id;
  }

  private async mrdRecordFor(tx: TransactionClient, encounterId: string): Promise<string | null> {
    const row = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM clinical.mrd_records WHERE encounter_ref = $1 AND encounter_kind = 'op'`,
      [encounterId],
    );
    return row?.id ?? null;
  }

  /**
   * Seconds actually spent with the patient, excluding paused stretches
   * (`clinical.encounters.active_seconds`).
   *
   * Derived from the event log rather than accumulated in a column, because a
   * counter that is incremented on resume is a counter that a crashed request
   * leaves wrong forever, and the "≤ 3 minutes for a follow-up" budget in the
   * exit gate is measured from this number.
   */
  private async activeSecondsOf(
    tx: TransactionClient,
    encounterId: string,
    startedAt: Date,
  ): Promise<number> {
    const events = await tx.rows<{ kind: string; at: Date }>(
      `SELECT kind::text AS kind, at FROM clinical.encounter_events
        WHERE encounter_id = $1 AND kind IN ('paused', 'resumed')
        ORDER BY at ASC`,
      [encounterId],
    );

    let pausedMs = 0;
    let pausedAt: Date | null = null;
    for (const event of events) {
      if (event.kind === 'paused' && pausedAt === null) pausedAt = event.at;
      else if (event.kind === 'resumed' && pausedAt !== null) {
        pausedMs += event.at.getTime() - pausedAt.getTime();
        pausedAt = null;
      }
    }
    if (pausedAt !== null) pausedMs += Date.now() - pausedAt.getTime();

    const elapsed = Date.now() - startedAt.getTime();
    return Math.max(0, Math.round((elapsed - pausedMs) / 1000));
  }

  /**
   * The longitudinal problem list, kept in step with what was diagnosed today.
   *
   * One row per problem, not per mention — which is what makes "active
   * problems" a filter rather than a deduplication job. A `rule_out` never
   * creates one: suspecting a condition is not the same as the patient having it.
   */
  private async upsertProblem(
    tx: TransactionClient,
    input: {
      readonly patientId: string;
      readonly encounterId: string;
      readonly codeSystemKey: string;
      readonly code: string;
      readonly description: string;
      readonly isChronic: boolean;
      readonly onsetDate: string | null;
      readonly certainty: string;
    },
  ): Promise<string | null> {
    if (input.certainty === 'rule_out') return null;
    const ctx = getContext();

    const row = await tx.one<{ id: string }>(
      `INSERT INTO clinical.problems (
         id, hospital_id, patient_id, code_system_key, code, description, status,
         onset_date, is_chronic, source_encounter_id, created_by, updated_by, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::date, $8, $9, $10, $10, now())
       ON CONFLICT (hospital_id, patient_id, code_system_key, code) DO UPDATE
          SET description = EXCLUDED.description,
              is_chronic = clinical.problems.is_chronic OR EXCLUDED.is_chronic,
              onset_date = COALESCE(clinical.problems.onset_date, EXCLUDED.onset_date),
              updated_at = now(),
              updated_by = EXCLUDED.updated_by,
              version = clinical.problems.version + 1
       RETURNING id`,
      [
        newId(),
        ctx.hospitalId,
        input.patientId,
        input.codeSystemKey,
        input.code,
        input.description,
        input.onsetDate,
        input.isChronic,
        input.encounterId,
        ctx.userId,
      ],
    );

    return row.id;
  }
}

interface VisitRow {
  readonly id: string;
  readonly patient_id: string;
  readonly status: string;
  readonly practitioner_key: string | null;
  readonly department_key: string | null;
  readonly speciality_key: string | null;
  readonly appointment_id: string | null;
  readonly branch_id: string;
  readonly uhid: string;
}

const ENCOUNTER_COLUMNS = `
  e.id, e.patient_id, e.visit_id, e.practitioner_key, e.doctor_user_id, e.department_key,
  e.type::text AS type, e.status::text AS status, e.started_at, e.completed_at,
  e.cancelled_at, e.cancel_reason, e.active_seconds,
  e.chief_complaint_text, e.chief_complaint_codes, e.treatment_plan, e.advice,
  e.follow_up_date, e.no_diagnosis_reason,
  e.dosing_weight_kg, e.dosing_weight_source::text AS dosing_weight_source,
  e.dosing_weight_at, e.dosing_weight_by, e.dosing_weight_vitals_id,
  e.cosign_required, e.signed_document_id, e.version`;

const ENCOUNTER_SELECT = `SELECT ${ENCOUNTER_COLUMNS} FROM clinical.encounters e`;

/** `YYYY-MM-DD` from a `date` column, or null. */
function formatDate(value: Date | null): string | null {
  if (value === null) return null;
  return value.toISOString().slice(0, 10);
}

/**
 * A flat text rendering of the note, for full-text search and so the hash is
 * human-checkable.
 *
 * Deliberately lossy in structure and lossless in content: every string in the
 * body appears, so nothing a doctor typed is missing from the searchable text.
 */
export function renderNoteText(note: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.trim().length > 0) parts.push(value.trim());
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) walk(item);
    }
  };

  walk(note);
  return parts.join('\n');
}
