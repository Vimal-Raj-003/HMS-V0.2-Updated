import { ProblemType } from '@vims/contracts';
import { moduleRefusalMessage } from '../../../core/problem/module-sqlstates.js';
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
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  leak_gap_is_expected_less_billed: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A gap must be what was expected less what was billed.',
  },
  leak_gap_is_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A finding with no gap is not a finding.',
  },
  leak_recovery_within_gap: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'More cannot be recovered than was missing.',
  },
  leak_recovered_has_money: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A finding marked recovered has an amount against it.',
  },
  uq_leak_finding_live_per_source: {
    type: ProblemType.CONFLICT,
    detail:
      'This gap is already on the worklist. A rescan finds the same row rather than a second one, so a real gap does not become a pile nobody works through.',
  },
  leak_clearance_is_clean_or_owned: {
    type: ProblemType.CONFLICT,
    detail:
      'A discharge cannot be cleared with charges still open unless somebody overrides it and says why. Letting the money go is a decision, and it needs a name.',
  },
  leak_cleared_has_a_timestamp: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A cleared check records when it was cleared.',
  },
  leak_scan_failure_says_why: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A failed scan records the error, so a silent no-op cannot look like a clean sweep.',
  },
  leak_rule_threshold_non_negative: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A gap threshold cannot be negative, and a lookback is between 1 and 3650 days.',
  },
  leak_recovery_amount_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A recovery of nothing is not a recovery.',
  },
};

/**
 * Turn what the database refused into a refusal the caller can act on.
 *
 * RC-006's triggers raise the custom SQLSTATE `RC006` and each already carries a
 * message written for the person who hit it — "nothing found by the leakage
 * audit is billed without a person accepting it first". Passing that through is
 * better than mapping each trigger to a second sentence here: one wording to
 * maintain, and it lives next to the rule it describes.
 */
export function mapLeakageDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const pg = asPostgresError(error);
  if (pg === null) return error;

  // Any module's SQLSTATE, not just this one: a trigger fires where the
  // write happens, and TR-008's discharge gate fires inside OP-006.
  const refusal = moduleRefusalMessage(pg.code, pg.message);
  if (refusal !== null) return new AppError(ProblemType.CONFLICT, refusal);

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
export async function withLeakageErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapLeakageDatabaseError(error);
  }
}
