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
/**
 * NC-034's CHECK constraints, in the words the person who hit them needs.
 *
 * The triggers are not listed: the anti-kickback one raises SQLSTATE `NC034`
 * with a message written for a human, and repeating it here would give the
 * codebase two versions of the sentence that matters most.
 */
const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  payout_statement_net_is_gross_less_deductions: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The net payable must be the gross less the deductions and the TDS.',
  },
  payout_statement_deductions_within_gross: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Deductions cannot exceed what was earned.',
  },
  payout_maker_is_not_checker: {
    type: ProblemType.CONFLICT,
    detail:
      'The person who computed a payout statement cannot also release it. It is an outbound payment authorised on a calculation nobody else has looked at.',
  },
  payout_approved_is_complete: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An approved statement records who approved it and when.',
  },
  payout_paid_has_a_reference: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A paid statement records when the money left and against what reference.',
  },
  payout_line_earning_within_base: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A doctor cannot earn more from a service than the hospital collected for it. Above 100% the arrangement is not a fee share, and NC-034 has no way to describe what it would be.',
  },
  payout_line_share_bounded: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A share is between 0 and 100 per cent.',
  },
  payout_line_source_is_named: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Every payout line except a retainer names the thing it was earned on.',
  },
  payout_tds_rate_is_lawful: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'Section 194J deducts at 10% where a PAN is on record. A higher rate applies only under section 206AA, when it is not.',
  },
  payout_tds_no_pan_is_deducted_higher: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'With no PAN on record, section 206AA requires 20% rather than 10%.',
  },
  payout_tds_below_threshold_deducts_nothing: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Nothing is deducted under 194J until the year\u2019s professional fees cross \u20b930,000.',
  },
  payout_contract_retainer_needs_a_model: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A monthly retainer belongs to a retainer or salaried contract.',
  },
  payout_contract_session_rate_needs_a_model: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A per-session rate belongs to a visiting-session contract.',
  },
  uq_payout_contract_live_per_doctor: {
    type: ProblemType.CONFLICT,
    detail:
      'This doctor already has a live payout contract. Two would mean two fee shares on one service, and whichever the resolver saw first would win.',
  },
  payout_rule_has_the_right_number: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A percentage rule carries a percentage; a flat, per-session or retainer rule carries an amount.',
  },
  payout_slabs_do_not_overlap: {
    type: ProblemType.CONFLICT,
    detail: 'Slabs within a rule cannot overlap, or an amount falls in two bands at once.',
  },
  payout_dispute_resolved_is_explained: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A settled dispute records who settled it and what was decided.',
  },
  uq_payout_statement_per_doctor_per_period: {
    type: ProblemType.CONFLICT,
    detail: 'This doctor already has a statement for that period.',
  },
  uq_payout_line_per_source: {
    type: ProblemType.CONFLICT,
    detail: 'That service is already on this statement.',
  },
};

/**
 * Turn what the database refused into a refusal the caller can act on.
 *
 * NC-034's triggers raise the custom SQLSTATE `NC034`, and the one that matters —
 * the anti-kickback guard — already carries a message written for the person who
 * hit it, citing the regulation. Passing it through keeps one wording, next to
 * the rule it describes.
 */
export function mapPayoutDatabaseError(error: unknown): unknown {
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
export async function withPayoutErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapPayoutDatabaseError(error);
  }
}
