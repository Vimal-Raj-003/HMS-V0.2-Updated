import { ProblemType } from '@vims/contracts';
import { AppError } from '../../../core/problem/app-error.js';
import { moduleRefusalMessage } from '../../../core/problem/module-sqlstates.js';

interface PostgresErrorShape {
  readonly code: string;
  readonly constraint: string | undefined;
  readonly message: string | undefined;
}

function asPostgresError(error: unknown): PostgresErrorShape | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (typeof candidate.code !== 'string') return null;
  return {
    code: candidate.code,
    constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
  };
}

interface Translation {
  readonly type: (typeof ProblemType)[keyof typeof ProblemType];
  readonly detail: string;
  readonly nextAction?: string;
}

const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  given_dose_carries_both_scans: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A dose recorded as given carries the wristband scan and the drug scan. The payloads are the evidence — a box saying somebody scanned is a box a form can tick.',
    nextAction: 'Scan the wristband and the drug, then record the dose.',
  },
  witness_is_dated: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A witnessed dose records when the second nurse checked it.',
  },
  unmade_dose_carries_a_code: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A dose that was not given carries a coded reason. "Patient asleep" and "drug not on the ward" are different problems with different owners, and a ward that cannot count its missed doses cannot fix them.',
  },
  mar_reason_code_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'That is not a reason code this chart knows.',
  },
  verification_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A verified order names the pharmacist who verified it.',
  },
  discontinuation_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Stopping a drug records why, on the order, where the next person to read it will see it.',
  },
  escalation_due_after_raised: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An escalation is answered after it is raised.',
  },
  acknowledgement_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Acknowledging an escalation names who acknowledged it — that is the whole content of an acknowledgement.',
  },
  resolved_escalation_says_what_happened: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Closing an escalation records what was done about the patient. "Resolved" with no outcome is a tick somebody applied to clear a list.',
  },
  uq_one_live_escalation_per_admission: {
    type: ProblemType.CONFLICT,
    detail:
      'This patient already has an escalation running. A second one splits the ladder in two and both climb slowly — the existing one carries the higher score.',
  },
  news2_score_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A NEWS2 score runs from 0 to 20.',
  },
  high_risk_has_interventions: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A high-risk assessment records what was done about it. A Braden of 12 with no interventions is a pressure sore in five days.',
  },
  fluid_volume_is_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A fluid entry is between 1 ml and 20 litres. Direction is what makes it intake or output.',
  },
  fluid_direction_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A fluid entry is intake or output.',
  },
  uq_one_live_device_per_admission: {
    type: ProblemType.CONFLICT,
    detail:
      'That patient already has a live device of this kind recorded. Two central lines when there is one doubles the denominator and halves the reported infection rate.',
  },
  device_removed_after_inserted: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A device comes out after it goes in.',
  },
  uq_one_live_isolation: {
    type: ProblemType.CONFLICT,
    detail: 'That precaution is already running for this patient.',
  },
  adjudicated_hai_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Confirming or rejecting an infection names who decided and why. The rate is defended with the reasoning.',
  },
  handover_is_between_two_nurses: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A handover is between two people. One nurse signing both sides is a shift nobody handed over.',
  },
  handover_received_after_given: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A handover is received after it is given.',
  },
  uq_nurse_shift: {
    type: ProblemType.CONFLICT,
    detail: 'That nurse is already assigned to this ward for this shift.',
  },
};

/**
 * Wraps a unit of work so Postgres's refusals arrive as problems a person can act on.
 *
 * The exclusion constraint's translation is the one that matters at 3 a.m.: a
 * lost race is not an error the nurse caused, and the message says what
 * happened and what to do rather than naming a constraint.
 */
export async function withNursingErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const pg = asPostgresError(error);
    if (pg === null) throw error;

    const refusal = moduleRefusalMessage(pg.code, pg.message);
    if (refusal !== null) return Promise.reject(new AppError(ProblemType.CONFLICT, refusal));

    if (pg.constraint !== undefined) {
      const translation = CONSTRAINT_TRANSLATIONS[pg.constraint];
      if (translation !== undefined) {
        return Promise.reject(
          translation.nextAction === undefined
            ? new AppError(translation.type, translation.detail)
            : new AppError(translation.type, translation.detail, { nextAction: translation.nextAction }),
        );
      }
    }

    throw error;
  }
}
