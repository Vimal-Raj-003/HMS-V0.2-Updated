import { ProblemType } from '@vims/contracts';
import { getContext } from '../../../core/context/request-context.js';
import { AppError } from '../../../core/problem/app-error.js';

/**
 * Small, stateless pieces shared by the vitals, encounter, document, timeline
 * and MRD services. Nothing here holds state, so none of it is a Nest provider.
 */

/**
 * The branch the caller is acting in.
 *
 * `clinical.vitals`, `clinical.encounters` and `clinical.documents` all carry
 * `branch_id NOT NULL`, and the generated RLS policy narrows every read with
 * `branch_id = ANY(core.current_branch_ids())`. A session that has not chosen a
 * branch would insert a row it cannot then read back — which surfaces as an
 * unexplainable empty list rather than as an error. Better to say so here.
 */
export function requireBranch(): string {
  const branchId = getContext().branchId;
  if (branchId === null) {
    throw new AppError(
      ProblemType.BRANCH_NOT_GRANTED,
      'Choose a branch before recording vitals or opening a consultation.',
      { nextAction: 'Switch to a branch and retry.' },
    );
  }
  return branchId;
}

/**
 * `numeric` and `decimal` arrive from `pg` as **strings**, deliberately: the
 * driver will not silently round a value it cannot represent. Every read of a
 * decimal column in this module goes through here, so the parse happens in one
 * place and a NULL stays a NULL rather than becoming `NaN`.
 */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Whole days between a date of birth and an instant. Negative ages are clamped to 0. */
export function ageDaysAt(dob: string | Date | null, at: Date): number | null {
  if (dob === null) return null;
  const born = dob instanceof Date ? dob : new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(born.getTime())) return null;
  const days = Math.floor((at.getTime() - born.getTime()) / 86_400_000);
  return days < 0 ? 0 : days;
}

/** PostgreSQL error code, when the thrown thing is one. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** The constraint a unique/check/exclusion violation names. */
export function pgConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('constraint' in error)) return undefined;
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

/** The `MESSAGE` a `RAISE EXCEPTION` carried, when the thrown thing is one. */
export function pgMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

/**
 * Turns the Phase-2 migration's own invariants into RFC 9457 problems.
 *
 * These rules are enforced by CHECK constraints and triggers rather than by a
 * service branch, and deliberately so: a service check alone can be raced, and a
 * rule that only the service knows is a rule the next caller bypasses. The
 * constraint is the enforcement; this is the translation, so the nurse sees
 * "diastolic must be below systolic" instead of a 500.
 *
 * The messages name the clinical rule, not the constraint, because the person
 * reading them is standing at a tablet with a patient in front of them.
 */
export async function mapClinicalConstraints<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = pgErrorCode(error);
    const constraint = pgConstraint(error);

    if (code === '23514') {
      const detail = CHECK_MESSAGES[constraint ?? ''];
      if (detail !== undefined) {
        throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, detail);
      }
    }

    if (code === '23505' && constraint === 'uq_encounter_diagnoses_primary') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'This encounter already has a primary diagnosis, and there can be exactly one (OP-002 §5).',
        { nextAction: 'Demote the existing primary diagnosis to secondary first.' },
      );
    }
    if (code === '23505' && constraint === 'uq_encounter_diagnoses_code') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'That diagnosis is already recorded on this encounter.',
      );
    }
    if (code === '23505' && constraint === 'mrd_records_encounter_key') {
      throw AppError.conflict('A medical record has already been opened for this encounter.');
    }

    // `clinical.enforce_document_version_immutability()` and
    // `clinical.seal_document_version()` both raise `restrict_violation`. They
    // are the append-only clinical record, and reaching one from the API is a
    // defect in this module rather than something the caller can fix — but the
    // caller still deserves a 422 that says what happened rather than a 500.
    if (code === '2F004' || code === '23001' || code === 'P0001') {
      const message = pgMessage(error) ?? '';
      if (message.includes('clinical.document_versions')) {
        throw new AppError(
          ProblemType.CLINICAL_HARD_STOP,
          'A signed clinical document cannot be changed. Record an amendment instead: it creates a new version with a reason, and the original stays readable.',
          { nextAction: 'Use the amend action on the encounter.' },
        );
      }
    }

    throw error;
  }
}

/**
 * One line per constraint, in the words of the rule it carries. Kept as a table
 * rather than a chain of `if`s so that adding a constraint to the migration and
 * forgetting its message is a visible gap rather than an invisible 500.
 */
const CHECK_MESSAGES: Readonly<Record<string, string>> = {
  vitals_bp_order: 'Diastolic pressure must be lower than systolic. Re-check the cuff reading.',
  vitals_systolic_range: 'That systolic pressure is outside the measurable range (40–300 mmHg).',
  vitals_diastolic_range: 'That diastolic pressure is outside the measurable range (10–200 mmHg).',
  vitals_pulse_range: 'That pulse is outside the measurable range (20–300 /min).',
  vitals_spo2_range: 'Oxygen saturation is a percentage between 0 and 100.',
  vitals_resp_range: 'That respiratory rate is outside the measurable range (4–80 /min).',
  vitals_temp_range: 'That temperature is outside the measurable range (30–45 °C).',
  vitals_height_range: 'That height is outside the measurable range (30–250 cm).',
  vitals_weight_range:
    'That weight is outside the measurable range (0.3–400 kg). A weight of zero is not a measurement — leave it blank if the patient was not weighed.',
  vitals_pain_range: 'A pain score is between 0 and 10.',
  vitals_gcs_range: 'A Glasgow Coma Scale total is between 3 and 15.',
  vitals_bmi_derived: 'BMI is derived from height and weight and cannot be entered by hand.',
  vitals_correction_pairing: 'A correction must say which reading it replaces and why.',
  vitals_subject: 'An observation must belong to a visit, an admission or an ER attendance.',
  vitals_alerts_parameters: 'An alert must name the parameters that raised it.',
  encounters_dosing_weight_unknown_pairing:
    'A dosing weight and its source travel together: "unknown" means no figure, and a figure is never "unknown".',
  encounters_dosing_weight_plausible:
    'That dosing weight is outside the plausible range (0.3–400 kg). Zero is not a weight.',
  encounters_dosing_weight_attributed:
    'A recorded weight is a clinical assertion: it needs the person who asserted it and when.',
  encounters_dosing_weight_measured_source: 'A measured weight must name the observation it was measured in.',
  encounters_bsa_requires_weight: 'Body-surface area cannot be computed without a weight.',
  encounters_egfr_pairing:
    'An eGFR needs the date it was measured, or the renal dose rule cannot age it out.',
  encounters_completion_pairing: 'A completed encounter must carry the instant it was completed.',
  encounters_cancel_reason: 'A cancelled encounter must carry a reason.',
  encounters_episode: 'An encounter belongs to a visit, an admission or an ER attendance.',
  encounters_cosign_required: 'Only an encounter that requires a co-signature can carry one.',
  document_versions_amendment_reason:
    'An amendment must carry a reason. Without one it is an overwrite wearing a version number.',
  document_versions_signed_when_final: 'A finalised clinical document must be signed.',
  document_versions_chain_root: 'Only the first version of a document starts the hash chain.',
  mrd_deficiencies_key: 'That deficiency is already open on this record.',
};
