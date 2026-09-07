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
  acuity_is_of_one_eye: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An acuity is of one eye. "Both eyes 6/6" is two measurements that agree today, and the day they stop agreeing one row has nowhere to put the difference.',
  },
  refraction_is_of_one_eye: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A refraction is of one eye.',
  },
  pressure_is_of_one_eye: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A pressure is of one eye.',
  },
  examined_segment_is_of_one_eye: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An examined segment belongs to one eye.',
  },
  surgery_is_on_one_eye: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An operation is on one eye. Both eyes on one plan is how a theatre list loses track of which was done.',
  },
  diagnosis_names_an_eye: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An ophthalmic diagnosis names an eye, or both. It cannot be of neither.',
  },
  power_comes_in_quarter_steps: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Powers come in quarter-dioptre steps. No lens is ground to −2.13, and the optician finds out after the patient has gone home.',
  },
  power_is_within_the_range_of_lenses: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'That power is outside the range of lenses that exist.',
  },
  axis_runs_one_to_one_eighty: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An axis runs from 1 to 180. Zero is written as 180 — the same meridian, spelled once.',
  },
  cylinder_names_its_axis: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A cylinder without an axis is a lens that cannot be made.',
  },
  refraction_source_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A refraction came from a device or from a person, and the record says which.',
  },
  pressure_is_physiological: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'That is not a pressure an eye can have. Check the reading and the units.',
  },
  cup_disc_ratio_is_a_ratio: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A cup-to-disc ratio runs from 0 to 1.',
  },
  prescription_expires: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A prescription needs an expiry within five years. One with none is filled three years later on an eye that has changed.',
  },
  cancelled_plan_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Cancelling a planned operation records why. The patient was told it was happening.',
  },
  uq_one_live_plan_per_eye: {
    type: ProblemType.CONFLICT,
    detail:
      'There is already a live plan for that eye. Two open plans is how a theatre list takes the lens off the wrong one.',
    nextAction: 'Cancel or complete the existing plan first.',
  },
  uq_exam_finding_per_segment_eye: {
    type: ProblemType.CONFLICT,
    detail:
      'That segment is already recorded for this eye on this visit. Amend it rather than adding a second.',
  },
  uq_spectacle_rx_no: {
    type: ProblemType.CONFLICT,
    detail: 'That prescription number is already in use.',
  },
  dilation_names_its_drug: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Dilation records which drops were used. They are a medication with a hazard attached — the patient must not drive for hours, and in a narrow angle they can close it.',
  },
  signed_visit_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A signature names the signer.',
  },
  ophtha_visits_encounter_id_key: {
    type: ProblemType.CONFLICT,
    detail: 'This consultation already has an eye visit. Open it rather than starting a second.',
  },
};

/** Wraps a unit of work so Postgres’s refusals arrive as problems a person can act on. */
export async function withOphthalmologyErrors<T>(work: () => Promise<T>): Promise<T> {
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
