import { ProblemType } from '@vims/contracts';
import { AppError } from '../../../core/problem/app-error.js';

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

/**
 * RC-008's CHECK constraints, in the words the person who hit them needs.
 *
 * The triggers are not listed: they raise SQLSTATE `RC008` with a message
 * already written for a human, and repeating it here would give the codebase two
 * versions of the same sentence to keep in step.
 */
/**
 * RC-006's CHECK constraints, in the words the person who hit them needs.
 *
 * The triggers are not listed: they raise SQLSTATE `RC006` with a message
 * already written for a human, and repeating it here would give the codebase two
 * versions of the same sentence to keep in step.
 */
/**
 * NC-034's CHECK constraints, in the words the person who hit them needs.
 *
 * The triggers are not listed: the anti-kickback one raises SQLSTATE `NC034`
 * with a message written for a human, and repeating it here would give the
 * codebase two versions of the sentence that matters most.
 */
/**
 * OP-006's CHECK constraints, in the words the person who hit them needs.
 *
 * The triggers are not listed: they raise SQLSTATE `OP006` with a message
 * already written for a human.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  er_visit_has_an_identity: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An ER visit needs either a patient or a temporary tag. It does not need a registered patient - a tag is enough to start treatment.',
  },
  er_visit_unidentified_has_a_tag: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An unidentified patient carries a tag, so somebody can be matched to the record later.',
  },
  er_visit_merge_is_complete: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Reconciling a tag records the patient it resolved to and when.',
  },
  er_visit_timestamps_ordered: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The ER clock runs forward: seen after arrival, decided after arrival, departed after the decision. A negative interval gets averaged into a number somebody reports.',
  },
  er_visit_arrival_matches_status: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An inbound pre-alert has not arrived yet; anything else has.',
  },
  er_visit_triage_is_complete: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A triage level and the time it was assigned go together.',
  },
  er_visit_esi_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'ESI runs from 1 to 5.',
  },
  er_bay_occupancy_is_coherent: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An occupied bay names its occupant, and a free one does not.',
  },
  uq_er_visit_one_bay: {
    type: ProblemType.CONFLICT,
    detail: 'That patient is already in another bay.',
  },
  uq_er_movement_one_open_per_visit: {
    type: ProblemType.CONFLICT,
    detail: 'That patient is already in a bay. Move them rather than assigning a second one.',
  },
  er_disposition_lama_is_witnessed: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A discharge against medical advice needs a named witness and a record that the risks were explained - without both it is a discharge nobody can defend if the patient deteriorates at home.',
  },
  er_disposition_referral_names_where: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A referral names where the patient is going and why. Otherwise they are sent into the night.',
  },
  er_disposition_death_has_a_time: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A death records the time. The certificate cannot be issued without it.',
  },
  er_disposition_admit_names_the_request: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An admission from the ER carries the request the ward will pick up.',
  },
  er_visits_hospital_id_er_no_key: {
    type: ProblemType.CONFLICT,
    detail: 'That ER number is already in use.',
  },
  uq_er_visit_temp_identity: {
    type: ProblemType.CONFLICT,
    detail: 'That tag is already on another patient.',
  },
};

/**
 * Turn what the database refused into a refusal the caller can act on.
 *
 * OP-006's triggers raise the custom SQLSTATE `OP006` with a message already
 * written for the person who hit it. Passing it through keeps one wording, next
 * to the rule it describes.
 */
export function mapErDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const pg = asPostgresError(error);
  if (pg === null) return error;

  if (pg.code === 'OP006') {
    const detail = pg.message ?? 'This action is not allowed on this ER visit in its current state.';
    return new AppError(ProblemType.CONFLICT, detail);
  }

  if (pg.constraint !== undefined) {
    const byConstraint = CONSTRAINT_TRANSLATIONS[pg.constraint];
    if (byConstraint !== undefined) {
      return new AppError(byConstraint.type, byConstraint.detail, {
        ...(byConstraint.nextAction === undefined ? {} : { nextAction: byConstraint.nextAction }),
      });
    }
  }

  if (pg.code === '23505') {
    return new AppError(
      ProblemType.CONFLICT,
      'That identifier is already in use in this hospital. Nothing was written — re-read the record and try again.',
    );
  }

  return error;
}

/** Runs `fn` and translates anything the database refuses into a stated refusal. */
export async function withErErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapErDatabaseError(error);
  }
}
