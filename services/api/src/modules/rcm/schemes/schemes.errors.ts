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
 * RC-007's CHECK constraints, in the words the person who hit them needs.
 *
 * The triggers are not listed: they raise SQLSTATE `RC007` with a message
 * already written for a human, and repeating it here would give the codebase two
 * versions of the same sentence to keep in step. See `mapSchemeDatabaseError`.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  scheme_versions_no_overlapping_published: {
    type: ProblemType.CONFLICT,
    detail:
      'Another rate list is already published over that period. A claim settles at the rate in force on the day of admission, and two published lists make that date resolve to two rates.',
    nextAction: 'End the current version the day before this one starts, or supersede it.',
  },
  scheme_beneficiary_verified_has_proof: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A verified entitlement records when it was verified and how. Verification is what turns the cash block on, so it is not something the system will take on trust.',
  },
  scheme_beneficiary_balance_within_entitlement: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The remaining floater cannot be negative, or larger than the entitlement it came from.',
  },
  scheme_beneficiary_dates_ordered: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A card cannot expire before it becomes valid.',
  },
  uq_scheme_beneficiary_live: {
    type: ProblemType.CONFLICT,
    detail:
      'This patient already has a live entitlement under that scheme. Two of them would mean two family floaters, and the second admission would be claimed against a balance already spent.',
  },
  uq_scheme_case_open_per_encounter: {
    type: ProblemType.CONFLICT,
    detail: 'This encounter already has an open case under that scheme.',
  },
  uq_scheme_case_one_primary: {
    type: ProblemType.CONFLICT,
    detail:
      'This case already has a primary procedure. Two primaries would claim two full package rates where the scheme pays the second at a fraction.',
  },
  scheme_case_package_amount_is_rate_by_qty: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The package amount must be its rate times its quantity.',
  },
  scheme_claim_approved_within_claimed: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The authority cannot approve more than was claimed.',
  },
  scheme_claim_paid_within_approved: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The amount paid cannot exceed the amount approved.',
  },
  scheme_claim_shortfall_is_the_difference: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Once a claim is decided, its shortfall is exactly what was claimed less what was approved.',
  },
  scheme_claim_submitted_has_timestamp: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A submitted claim records when it was submitted.',
  },
  scheme_claim_paid_has_date: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A paid claim records when the money arrived and how much of it.',
  },
  scheme_claim_line_balances: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Every rupee on a claim line is either approved or disallowed. A line where the two do not add up to what was claimed has money leaving without a decision behind it.',
  },
  scheme_claim_line_disallowance_has_a_reason: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A disallowance carries its reason. A deduction with nothing behind it cannot be appealed, and an appeal is the only way that money comes back.',
  },
  scheme_shortfall_maker_is_not_checker: {
    type: ProblemType.CONFLICT,
    detail: 'A write-off needs a second pair of hands: the person who asked for it cannot also approve it.',
  },
  scheme_shortfall_written_off_is_complete: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Writing a shortfall off records who asked, who agreed, when, and why.',
  },
  scheme_shortfall_recovery_within_amount: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'More cannot be recovered than the shortfall was worth.',
  },
  scheme_package_rate_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A scheme package has a rate above zero. A free package is an exclusion, not a rate.',
  },
  scheme_package_implant_cap_needs_permission: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A package that does not allow implants cannot carry an implant cap.',
  },
  scheme_master_claim_window_positive: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A claim window is between 1 and 365 days.',
  },
  scheme_recon_period_ordered: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A settlement period cannot end before it starts.',
  },
};

/**
 * Turn what the database refused into a refusal the caller can act on.
 *
 * RC-007's triggers all raise the custom SQLSTATE `RC007`, and each already
 * carries a message written for the person who hit it — "this patient is a
 * verified PM-JAY beneficiary…", "this claim cannot be submitted while a
 * mandatory document is missing: case_sheet". Passing that message through is
 * better than mapping each trigger to a second sentence here: there is one
 * wording to maintain, and it lives next to the rule it describes.
 *
 * Without this, a cashier who tries to take ₹500 from a scheme patient sees
 * "Something went wrong on our side" — which is both untrue and useless.
 */
export function mapSchemeDatabaseError(error: unknown): unknown {
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
export async function withSchemeErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapSchemeDatabaseError(error);
  }
}
