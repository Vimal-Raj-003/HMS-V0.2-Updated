'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import type { CurrencyCode } from '@vims/contracts/primitives';
import {
  Button,
  DenominationSheet,
  SkeletonList,
  defaultInrDenominations,
  formatFaceValue,
  useToast,
  type Denomination,
  type DenominationCounts,
  type DenominationSheetLabels,
} from '@vims/ui';
import { useMemo, useState } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { approveVariance, closePreview, closeShift } from '../api/client';
import { frontOfficeKeys } from '../api/keys';
import type { ShiftView } from '../api/types';
import { asCurrency, closeBlockers, parseMoney, toDenominationLines } from '../lib/cash';
import { ActionUnavailable } from './frontoffice-gate';

/**
 * Closing the drawer — NC-001 §3.6, §8 "Shift close wizard".
 *
 * **A shift never closes over an unexplained variance.** That rule lives on the
 * server, and it is enforced there in the only way that is safe: a close whose
 * count differs from the expected figure does not *fail* — failing would throw
 * away the count the cashier has just keyed in — it parks the shift in `closing`
 * with the count, the variance and the reason recorded, and refuses to finish
 * until a **different** person approves it.
 *
 * The screen's job is to say so plainly *before* the button is pressed, which
 * takes one small piece of work: `GET /shifts/:id/close-preview` is literally
 * `get(shiftId)` on the server, and `viewOf` hard-codes `blockedBy: null`, so the
 * preview never reports a blocker even when one exists. `closeBlockers` derives
 * them from the fields the preview does return, and honours the server's own
 * `blockedBy` when an actual close attempt sets it.
 *
 * The count itself is `DenominationSheet`, unmodified: it totals in `bigint`
 * through `Money`, refuses a fractional count rather than flooring it, and will
 * not submit a non-zero variance without a reason.
 */

const SHEET_LABELS: DenominationSheetLabels = {
  caption: 'Closing count',
  scrollRegion: 'Denomination sheet',
  denomination: 'Denomination',
  count: 'Count',
  rowTotal: 'Line total',
  countedTotal: 'Counted in the drawer',
  expectedTotal: 'Expected by the system',
  balanced: 'Balances exactly',
  over: (amount) => `Over by ${amount}`,
  short: (amount) => `Short by ${amount}`,
  varianceReasonLabel: 'Explain the difference',
  varianceReasonPlaceholder: 'What happened, in one line — a recount, a change error, a missing receipt',
  varianceReasonRequired:
    'A variance cannot be closed over silently. Somebody other than you has to approve it afterwards.',
  submit: 'Close the shift',
  countFieldLabel: (label) => `Count of ${label}`,
  announceTotal: (counted, variance) => `Counted ${counted}. ${variance}.`,
};

export function CloseShiftPanel({
  shift,
  onChanged,
}: {
  readonly shift: ShiftView;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const { hospitalId, granted, userId } = useSession();
  const keys = frontOfficeKeys(hospitalId);
  const { publish } = useToast();
  const currency: CurrencyCode = asCurrency(shift.currency);

  const [counts, setCounts] = useState<DenominationCounts>({});

  const denominations: readonly Denomination[] = useMemo(
    () => defaultInrDenominations((minor) => formatFaceValue(minor, currency)),
    [currency],
  );

  const preview = useQuery({
    queryKey: keys.closePreview(shift.id),
    queryFn: ({ signal }) => closePreview(shift.id, { signal }),
    staleTime: 5_000,
  });

  const previewShift = preview.data ?? shift;
  const blockers = closeBlockers(previewShift, userId);
  const expected = parseMoney(previewShift.expectedCash, currency);

  const canApproveVariance = granted.has('receipt.shift.variance.approve');
  // NC-001 §5: "cashier ≠ variance approver". Holding the key is not enough —
  // the server refuses your own shift with a segregation-of-duties problem, so
  // the control is not drawn for it either.
  const mayApproveThisShift = canApproveVariance && previewShift.cashierUserId !== userId;

  const close = useMutation({
    mutationFn: (input: { readonly varianceReason?: string }) =>
      closeShift(shift.id, {
        denominations: toDenominationLines(denominations, counts, currency),
        ...(input.varianceReason === undefined ? {} : { varianceReason: input.varianceReason }),
      }),
    onSuccess: (result) => {
      onChanged();
      void preview.refetch();
      if (result.blockedBy === null && result.status === 'closed') {
        publish({
          title: 'Shift closed',
          description: `Counted ${result.countedCash ?? '—'} against ${result.expectedCash}.`,
          severity: 'success',
        });
      } else {
        publish({
          title: 'The shift did not close',
          description:
            result.blockedBy === 'pending_confirmations'
              ? 'A digital tender has not been confirmed by the gateway yet.'
              : 'The variance needs approval from somebody other than you.',
          severity: 'warning',
        });
      }
    },
  });

  const approve = useMutation({
    mutationFn: (reason: string) => approveVariance(shift.id, reason),
    onSuccess: () => {
      onChanged();
      void preview.refetch();
      publish({ title: 'Variance approved', severity: 'success' });
    },
  });

  if (preview.isPending) return <SkeletonList label="Working out what the drawer should hold" rows={5} />;
  if (preview.error !== null) {
    return (
      <ProblemCard
        error={preview.error}
        onRetry={() => {
          void preview.refetch();
        }}
      />
    );
  }

  return (
    <section
      data-testid="close-panel"
      aria-label="Close the shift"
      className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4"
    >
      <h2 className="text-lg font-semibold text-fg-default">Close the shift</h2>

      {blockers.length === 0 ? null : (
        <ul data-testid="close-blockers" className="flex flex-col gap-2">
          {blockers.map((blocker) => (
            <li
              key={blocker.kind}
              role="alert"
              className="rounded-md border border-warning-border bg-warning-surface p-3 text-sm text-warning-on-surface"
            >
              {blocker.kind === 'pending_confirmations' ? (
                <>
                  <span className="font-medium">
                    {blocker.count} digital tender(s) have not been confirmed by the gateway.
                  </span>{' '}
                  A UPI or card payment that never confirmed is money the hospital does not have; closing over
                  it books revenue that may never arrive. Wait for the confirmation, or have the payment
                  cancelled.
                </>
              ) : blocker.kind === 'variance_approval' ? (
                <>
                  <span className="font-medium">
                    The drawer is out by {blocker.variance.format()} and nobody has approved it.
                  </span>{' '}
                  {blocker.reason === null ? '' : `Recorded reason: “${blocker.reason}”. `}
                  The shift stays in “closing” until a head cashier or finance approves the difference.
                </>
              ) : blocker.kind === 'already_closed' ? (
                <span className="font-medium">
                  This shift is already closed. Corrections go on an adjustment voucher.
                </span>
              ) : (
                <>
                  <span className="font-medium">This is not your shift.</span> Only the cashier who opened a
                  drawer can close it; anyone else needs a force-close, which takes two people and a reason.
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <DenominationSheet
        currency={currency}
        denominations={denominations}
        counts={counts}
        onCountsChange={setCounts}
        expected={expected}
        labels={SHEET_LABELS}
        disabled={close.isPending || previewShift.status === 'closed'}
        onSubmit={(result) => {
          close.mutate(result.varianceReason === undefined ? {} : { varianceReason: result.varianceReason });
        }}
      />

      {close.error === null ? null : <ProblemCard error={close.error} />}

      {previewShift.status === 'closing' &&
      previewShift.variance !== null &&
      !parseMoney(previewShift.variance, currency).isZero ? (
        mayApproveThisShift ? (
          <div className="rounded-md border border-strong p-3">
            <p className="text-sm text-fg-default">
              You may approve this variance because it is not your drawer.
            </p>
            {approve.error === null ? null : <ProblemCard error={approve.error} />}
            <Button
              variant="primary"
              size="sm"
              className="mt-2"
              data-testid="approve-variance"
              disabled={approve.isPending}
              onClick={() => {
                approve.mutate(
                  previewShift.varianceReason ?? 'Variance reviewed and accepted by the approver.',
                );
              }}
            >
              Approve the variance
            </Button>
          </div>
        ) : (
          <ActionUnavailable
            title={
              canApproveVariance
                ? 'You cannot approve a variance on your own shift'
                : 'Approving a variance is not yours to do'
            }
            because={
              canApproveVariance
                ? 'The person who counted the drawer is never the person who signs off the difference. Ask the head cashier or finance — the server refuses your own shift regardless of what this screen draws.'
                : 'A closing variance is signed off by the head cashier or finance, never by the cashier who counted the drawer.'
            }
            permission="receipt.shift.variance.approve"
          />
        )
      ) : null}

      <p className="text-2xs text-fg-muted">
        Expected is the opening float plus cash collected, less cash refunded and voided — derived from the
        payment events, never keyed by hand. Every figure on this sheet is counted in whole minor units;
        nothing is rounded.
      </p>
      <p className="text-2xs text-fg-muted">
        Opening float {parseMoney(previewShift.openingFloat, currency).format()} ·{' '}
        {previewShift.receiptsCount} receipts · {previewShift.refundsCount} refunds ·{' '}
        {previewShift.voidsCount} voids
      </p>
    </section>
  );
}
