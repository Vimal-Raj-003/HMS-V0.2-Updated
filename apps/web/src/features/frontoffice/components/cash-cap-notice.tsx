'use client';

import type { Money } from '@vims/contracts/primitives';
import { ApiProblem } from '@/lib/api';
import { PAYMENT_MODE_LABELS, NON_CASH_ALTERNATIVES, type CashCapRefusal } from '../lib/cash';

/**
 * The §269ST refusal, rendered as the legal fact it is rather than as an error.
 *
 * This is deliberately **not** a `ProblemCard`: a problem card offers "Try
 * again", and there is nothing to try. Income-tax §269ST forbids *receiving*
 * ₹2,00,000 or more in cash from one person in one day, and §271DA's penalty is
 * equal to the whole sum received — so the boundary rupee costs ₹2,00,000, and a
 * retry is not a recovery, it is a second attempt at the same offence.
 *
 * What a cashier needs at that moment is three things, in this order: how much
 * cash they *can* still take from this payer today, what to do with the balance,
 * and the reference to read out if the patient argues. All three are here, and
 * the amounts are `Money` — `bigint` minor units — so the headroom is exact
 * rather than nearly right.
 */
export function CashCapNotice({
  refusal,
  error,
  amountDue,
}: {
  readonly refusal: CashCapRefusal | null;
  readonly error: unknown;
  readonly amountDue: Money | null;
}): React.JSX.Element {
  const problem = error instanceof ApiProblem ? error.problem : null;
  const reference = problem?.reference ?? 'no-reference';

  const alternatives = NON_CASH_ALTERNATIVES.map((mode) => PAYMENT_MODE_LABELS[mode] ?? mode).join(', ');

  return (
    <div
      role="alert"
      data-testid="cash-cap-notice"
      className="rounded-lg border-2 border-danger-border bg-danger-surface p-4"
    >
      <p className="text-md font-semibold text-danger-on-surface">
        Cash cannot be accepted — §269ST daily limit
      </p>

      {refusal === null ? (
        <p className="mt-1 text-sm text-danger-on-surface">
          {problem?.detail ??
            'The income-tax cash limit for this payer has been reached for today. The tender was refused; nothing was recorded.'}
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-danger-on-surface">
            This payer has already given{' '}
            <span className="font-mono font-semibold" data-testid="cap-already">
              {refusal.alreadyToday.format()}
            </span>{' '}
            in cash today across every counter. Taking{' '}
            <span className="font-mono">{refusal.attempted.format()}</span> more would reach{' '}
            <span className="font-mono">{refusal.wouldReach.format()}</span>, which meets or exceeds the limit
            of <span className="font-mono">{refusal.cap.format()}</span>.
          </p>
          <p className="mt-2 text-sm font-medium text-danger-on-surface">
            You can still take{' '}
            <span className="font-mono font-semibold" data-testid="cap-headroom">
              {refusal.remainingHeadroom.format()}
            </span>{' '}
            in cash from this payer today
            {refusal.remainingHeadroom.isZero ? ' — that is, none.' : '.'}
          </p>
        </>
      )}

      <p className="mt-2 text-sm text-danger-on-surface" data-testid="cap-next-action">
        Take the balance
        {amountDue === null ? '' : ` of ${amountDue.format()}`} by {alternatives} or bank transfer. The
        patient is not being refused care — only this tender.
      </p>

      <p className="mt-2 text-2xs text-danger-on-surface">
        The limit is per payer per day, and a refund or a void does not give the headroom back: “pay two lakh,
        take one back, pay one again” is exactly the split the section exists to forbid.
      </p>

      <p className="mt-2 font-mono text-2xs text-fg-muted">
        Reference: <span data-testid="cap-reference">{reference}</span>
      </p>
    </div>
  );
}
