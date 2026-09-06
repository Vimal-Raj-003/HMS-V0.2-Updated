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
  uq_room_charge_idempotency: {
    type: ProblemType.CONFLICT,
    detail:
      'That night is already charged. The job is idempotent on (admission, date, code, occupancy), which is exactly why a re-run is safe — this is the index refusing a duplicate somebody asked for another way.',
  },
  charge_units_are_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A charge is for more than zero units.',
  },
  charge_amounts_are_not_negative: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A rate, an amount and a tax are zero or more. A credit is a reversal line, not a negative charge.',
  },
  charge_covers_a_real_window: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A charge covers a window that ends after it starts.',
  },
  exemption_states_its_ground: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An exempt line states its ground. "Exempt" with no reason is a line nobody can defend to a GST officer, and intensive care exemption is a statutory position rather than a preference.',
  },
  exempt_line_bears_no_tax: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A line is exempt or it is taxed. It cannot be both.',
  },
  gst_amount_follows_the_rate: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The tax does not match the rate applied to the amount. That kind of error survives a hundred bills and then arrives as an assessment.',
  },
  supersession_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Superseding a charge names who did it.',
  },
  cutoff_is_an_hour: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The cut-off is an hour of the day, 0 to 23.',
  },
  grace_is_sane: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A grace period is between nothing and a day.',
  },
  minimum_is_at_least_a_day: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A stay of any length is at least one day.',
  },
  clearance_state_is_known: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A clearance is pending, blocked or cleared.',
  },
  cleared_clearance_is_owned: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A cleared discharge names who cleared it.',
  },
  blocked_clearance_names_what: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A blocked discharge lists what is outstanding. "Blocked" with an empty list is a door somebody has to phone four departments to open.',
  },
  override_states_its_grounds: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Letting a patient leave over an unresolved bill records the grounds. A patient who insists on leaving is leaving; the question is whether the hospital wrote down that it knew.',
  },
  uq_clearance_per_admission: {
    type: ProblemType.CONFLICT,
    detail: 'That admission already has a clearance record.',
  },
  failed_run_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A failed charge run records what went wrong.',
  },
};

/**
 * Wraps a unit of work so Postgres's refusals arrive as problems a person can act on.
 *
 * The exclusion constraint's translation is the one that matters at 3 a.m.: a
 * lost race is not an error the nurse caused, and the message says what
 * happened and what to do rather than naming a constraint.
 */
export async function withIpBillingErrors<T>(work: () => Promise<T>): Promise<T> {
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
