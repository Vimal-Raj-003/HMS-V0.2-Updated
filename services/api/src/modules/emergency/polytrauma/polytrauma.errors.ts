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
  uq_pt_procedure_sequence: {
    type: ProblemType.CONFLICT,
    detail: 'Two procedures cannot occupy the same position in the queue.',
    nextAction: 'Send the whole arrangement, not one move.',
  },
  uq_pt_one_lead_per_case: {
    type: ProblemType.CONFLICT,
    detail: 'This board already has a lead. A board with two leads has none.',
    nextAction: 'Stand the current lead down first.',
  },
  procedure_sequence_is_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Positions in the queue start at one.',
  },
  procedure_finishes_after_it_starts: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A procedure is marked done from the point it started. One that finished without ever starting is a record nobody can reconstruct.',
  },
  deferral_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Deferring a procedure on a patient who is still injured records why. It is a decision, and somebody will read it on the ward round tomorrow.',
  },
  abandonment_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Abandoning a planned procedure records why.',
  },
  waiver_states_its_grounds: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An emergency waiver states why nobody could be asked and why it could not wait. Those grounds are the whole of its lawfulness.',
  },
  settled_consent_is_dated: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A consent that has been decided records when.',
  },
  given_consent_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A consent that was given names who gave it. "The patient consented" with no name is a sentence, not a record.',
  },
  blood_counts_are_sane: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'More units cannot be issued than were reserved.',
  },
  mtp_activation_is_dated: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A massive transfusion protocol records the time it was activated. The whole protocol is timed from it.',
  },
  consult_sla_is_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A consult target is between one minute and a week.',
  },
  seen_consult_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A consult marked seen names who saw the patient.',
  },
  advised_consult_carries_advice: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Advice recorded with nothing in it is a consult nobody can act on.',
  },
  declined_consult_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A declined consult says why, so the asking team knows what to do instead.',
  },
  closed_board_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A closed board names who closed it.',
  },
  board_closes_after_it_opens: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A board closes after it opens.',
  },
  uq_polytrauma_case_no: {
    type: ProblemType.CONFLICT,
    detail: 'That board number is already in use.',
  },
};

/**
 * Wraps a unit of work so Postgres's refusals arrive as problems a person can act on.
 *
 * TR-007's own SQLSTATE carries messages written for the screen — the ordering
 * rule names both procedures and both classes, the consent rule names the one
 * that is not settled — and those pass through verbatim. Only the trigger knows
 * which of the six rules fired and against what.
 */
export async function withPolytraumaErrors<T>(work: () => Promise<T>): Promise<T> {
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
