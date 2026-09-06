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
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  est_shares_sum_to_payable: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      "The patient's share and the payer's share must add up to the payable total. A quote that says two different things at once becomes whichever number was read aloud.",
  },
  est_payable_is_gross_less_discount: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The payable total must be the gross less the discount.',
  },
  est_discount_within_gross: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A discount cannot exceed the gross it comes off.',
  },
  est_issued_has_validity_and_total: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'An issued estimate needs a total and an expiry date. A quote with no expiry is a price the hospital is held to for ever.',
  },
  est_issued_has_somebody_to_give_it_to: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An issued estimate names a patient or an enquirer. Otherwise nobody can be told it exists.',
  },
  est_declined_has_a_reason: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A declined estimate records why. A run of declines on one procedure is a pricing signal, and it is lost without the reason.',
  },
  est_converted_names_the_encounter: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A converted estimate names the encounter it became.',
  },
  est_line_amount_is_qty_by_rate: {
    type: ProblemType.VALIDATION_FAILED,
    detail: "A line's amount must be its quantity times its unit rate.",
  },
  est_line_discount_within_amount: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A line discount cannot exceed the line.',
  },
  est_line_taxable_needs_a_rate: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A taxable line carries a GST rate above zero.',
  },
  uq_est_scenario_per_class: {
    type: ProblemType.CONFLICT,
    detail: 'This estimate already prices that room class.',
  },
  uq_est_scenario_one_chosen: {
    type: ProblemType.CONFLICT,
    detail: 'Only one room-class scenario can be the chosen one.',
  },
  est_scenario_amounts_sane: {
    type: ProblemType.VALIDATION_FAILED,
    detail: "A scenario's patient share cannot exceed its own total.",
  },
  est_variance_is_actual_less_estimated: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The variance must be the actual less the estimated. A figure that does not follow from the two numbers flatters whoever wrote it, which is the whole thing measuring the estimator is meant to prevent.',
  },
  est_variance_pct_matches_amount: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The variance percentage must follow from the amounts, to two decimal places.',
  },
  est_variance_totals_non_negative: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A variance sample needs a positive estimate to measure against.',
  },
  est_totals_non_negative: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An estimate cannot carry a negative amount.',
  },
  est_copay_bounded: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A co-pay above 100% is not a co-pay.',
  },
  est_variance_samples_estimate_id_key: {
    type: ProblemType.CONFLICT,
    detail: 'This estimate has already been reconciled against its bill.',
  },
  est_estimates_hospital_id_estimate_no_key: {
    type: ProblemType.CONFLICT,
    detail: 'That estimate number is already in use.',
  },
};

/**
 * Turn what the database refused into a refusal the caller can act on.
 *
 * RC-008's triggers raise the custom SQLSTATE `RC008` and each already carries a
 * message written for the person who hit it — "an issued estimate cannot be
 * repriced; supersede it with a revision". Passing that through is better than
 * mapping each trigger to a second sentence here: one wording to maintain, and
 * it lives next to the rule it describes.
 */
export function mapEstimateDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const pg = asPostgresError(error);
  if (pg === null) return error;

  if (pg.code === 'RC008') {
    const detail = pg.message ?? 'This action is not allowed on an estimate in its current state.';
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
export async function withEstimateErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapEstimateDatabaseError(error);
  }
}
