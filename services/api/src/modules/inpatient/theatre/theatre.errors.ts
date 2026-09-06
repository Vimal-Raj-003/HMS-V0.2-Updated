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
  checklist_phases_are_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Each checklist phase names the person who ran it. "The checklist was done" is not a record; "Dr Rao ran the time-out at 09:14" is, and it is the one a coroner asks for.',
  },
  checklist_runs_in_order: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Sign-in, then time-out, then sign-out. The order is the point.',
  },
  ot_times_run_forward: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A case closes after it opens and the patient leaves after they arrive.',
  },
  bump_states_its_reason: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Displacing an elective case records why. Somebody’s operation was cancelled and they will ask.',
  },
  cancellation_states_its_reason: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A cancelled or postponed case records why.',
  },
  asa_grade_in_range: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The ASA physical status grade runs 1 to 6.',
  },
  counts_are_not_negative: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A count is zero or more.',
  },
  indicator_results_are_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An indicator reads pass, fail or pending.',
  },
  bi_read_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A biological indicator that has been read names who read it and when.',
  },
  recall_states_its_reason: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A recall names who ran it and why. It is the document the affected patients’ notes will point at.',
  },
  uq_one_live_issue_per_set: {
    type: ProblemType.CONFLICT,
    detail:
      'That set is already issued and not yet returned. A tray in two theatres at once is a tray somebody has lost track of, and the recall list would then name the wrong patient.',
  },
  uq_ot_case_no: { type: ProblemType.CONFLICT, detail: 'That case number is already in use.' },
  uq_cssd_load_no: { type: ProblemType.CONFLICT, detail: 'That load number is already in use.' },
  uq_cssd_set_code: { type: ProblemType.CONFLICT, detail: 'That set code already exists in this branch.' },
};

/**
 * Wraps a unit of work so Postgres's refusals arrive as problems a person can act on.
 *
 * The exclusion constraint's translation is the one that matters at 3 a.m.: a
 * lost race is not an error the nurse caused, and the message says what
 * happened and what to do rather than naming a constraint.
 */
export async function withTheatreErrors<T>(work: () => Promise<T>): Promise<T> {
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
