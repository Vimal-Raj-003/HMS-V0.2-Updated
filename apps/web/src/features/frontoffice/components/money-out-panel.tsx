'use client';

import { useMutation } from '@tanstack/react-query';
import { Button, Input, Label, Textarea, useToast } from '@vims/ui';
import { useId, useState } from 'react';
import { ProblemCard } from '@/features/admin/components/problem-card';
import { useSession } from '@/lib/session-context';
import { payRefund, voidReceipt } from '../api/client';
import type { CoSignerInput, ShiftView } from '../api/types';
import { ActionUnavailable } from './frontoffice-gate';
import { isIdentifier } from './context-field';

/**
 * Money leaving the drawer — NC-001 §3.4 and §3.5.
 *
 * Both routes here are `requiresSecondPerson` in the permission catalogue, and
 * that is not a formality: the acting user's own session can **never** satisfy
 * `receipt.refund.pay` or `receipt.void`, however many keys it holds. A second
 * person has to stand at the counter and put their own credential in, and the
 * API verifies it against their account rather than trusting the browser.
 *
 * So this panel does two things a naive implementation would not:
 *
 *  - it renders the co-signer block as a **required** part of the form rather
 *    than an optional extra, because a submit without it is refused;
 *  - when the session does not hold the key at all, it renders an explanation in
 *    the control's place. A missing button on a cash counter reads as a bug and
 *    sends a cashier to borrow a supervisor's password, which is exactly the
 *    behaviour dual control exists to prevent.
 *
 * The co-signer's credential is held in component state for the length of one
 * submission and never stored, logged, or put in a query key.
 */

function CoSignerFields({
  idPrefix,
  value,
  onChange,
}: {
  readonly idPrefix: string;
  readonly value: { readonly identifier: string; readonly credential: string };
  readonly onChange: (next: { readonly identifier: string; readonly credential: string }) => void;
}): React.JSX.Element {
  return (
    <fieldset className="grid gap-3 rounded-md border border-strong p-3 sm:grid-cols-2">
      <legend className="px-1 text-sm font-medium text-fg-default">Second person</legend>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-cosigner`} required>
          Their username or employee ID
        </Label>
        <Input
          id={`${idPrefix}-cosigner`}
          data-testid={`${idPrefix}-cosigner`}
          value={value.identifier}
          autoComplete="off"
          onChange={(event) => {
            onChange({ ...value, identifier: event.target.value });
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-credential`} required>
          Their password or PIN
        </Label>
        <Input
          id={`${idPrefix}-credential`}
          data-testid={`${idPrefix}-credential`}
          type="password"
          value={value.credential}
          autoComplete="new-password"
          onChange={(event) => {
            onChange({ ...value, credential: event.target.value });
          }}
        />
      </div>
      <p className="text-2xs text-fg-muted sm:col-span-2">
        They must enter this themselves. It is verified against their own account and is never stored by this
        screen.
      </p>
    </fieldset>
  );
}

export function MoneyOutPanel({
  shift,
  onChanged,
}: {
  readonly shift: ShiftView;
  readonly onChanged: () => void;
}): React.JSX.Element {
  const fieldId = useId();
  const { granted } = useSession();
  const { publish } = useToast();

  const canRefund = granted.has('receipt.refund.pay');
  const canVoid = granted.has('receipt.void');

  const [refundId, setRefundId] = useState('');
  const [refundSigner, setRefundSigner] = useState({ identifier: '', credential: '' });
  const [receiptId, setReceiptId] = useState('');
  const [voidReason, setVoidReason] = useState('');
  const [voidSigner, setVoidSigner] = useState({ identifier: '', credential: '' });

  const refund = useMutation({
    mutationFn: (input: { readonly id: string; readonly coSigner: CoSignerInput }) =>
      payRefund(input.id, {
        shiftId: shift.id,
        coSigner: input.coSigner,
        identityMethod: 'in_person',
      }),
    onSuccess: (result) => {
      setRefundId('');
      setRefundSigner({ identifier: '', credential: '' });
      onChanged();
      publish({
        title: `Refund ${result.refundNo} paid`,
        description: `${result.amount} handed back in ${result.mode}.`,
        severity: 'success',
      });
    },
  });

  const cancelReceipt = useMutation({
    mutationFn: (input: { readonly id: string; readonly reason: string; readonly coSigner: CoSignerInput }) =>
      voidReceipt(input.id, { reason: input.reason, coSigner: input.coSigner }, input.reason),
    onSuccess: (result) => {
      setReceiptId('');
      setVoidReason('');
      setVoidSigner({ identifier: '', credential: '' });
      onChanged();
      publish({
        title: `Receipt ${result.receiptNo} voided`,
        description: 'The original is kept; a void entry has been written against it.',
        severity: 'warning',
      });
    },
  });

  return (
    <section
      data-testid="money-out-panel"
      aria-label="Refunds and voids"
      className="flex flex-col gap-4 rounded-lg border border-strong bg-layer-1 p-4"
    >
      <h2 className="text-lg font-semibold text-fg-default">Money out</h2>

      {canRefund ? (
        <div className="flex flex-col gap-3" data-testid="refund-form">
          <h3 className="text-md font-medium text-fg-default">Pay an approved refund</h3>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-refund`} required>
              Refund
            </Label>
            <Input
              id={`${fieldId}-refund`}
              data-testid="refund-id"
              value={refundId}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              onChange={(event) => {
                setRefundId(event.target.value);
              }}
            />
          </div>
          <CoSignerFields idPrefix="refund" value={refundSigner} onChange={setRefundSigner} />
          {refund.error === null ? null : <ProblemCard error={refund.error} />}
          <div className="flex justify-end">
            <Button
              variant="danger"
              data-testid="refund-confirm"
              disabled={
                refund.isPending ||
                !isIdentifier(refundId) ||
                refundSigner.identifier.trim().length < 3 ||
                refundSigner.credential.length < 4
              }
              onClick={() => {
                refund.mutate({
                  id: refundId.trim(),
                  coSigner: {
                    identifier: refundSigner.identifier.trim(),
                    credential: refundSigner.credential,
                    credentialKind: 'password',
                  },
                });
              }}
            >
              {refund.isPending ? 'Paying…' : 'Pay the refund'}
            </Button>
          </div>
        </div>
      ) : (
        <ActionUnavailable
          title="Paying a refund is not yours to do"
          because="Money leaving a drawer needs a different person from the one who took it in, and the approval that raised the refund is separate again. Ask the billing desk or the head cashier — they will still need a second person at the counter."
          permission="receipt.refund.pay"
        />
      )}

      {canVoid ? (
        <div className="flex flex-col gap-3 border-t border-default pt-4" data-testid="void-form">
          <h3 className="text-md font-medium text-fg-default">Void a receipt</h3>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-receipt`} required>
              Receipt
            </Label>
            <Input
              id={`${fieldId}-receipt`}
              data-testid="void-receipt-id"
              value={receiptId}
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-xs"
              onChange={(event) => {
                setReceiptId(event.target.value);
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-void-reason`} required>
              Why
            </Label>
            <Textarea
              id={`${fieldId}-void-reason`}
              data-testid="void-reason"
              value={voidReason}
              onChange={(event) => {
                setVoidReason(event.target.value);
              }}
            />
          </div>
          <CoSignerFields idPrefix="void" value={voidSigner} onChange={setVoidSigner} />
          {cancelReceipt.error === null ? null : <ProblemCard error={cancelReceipt.error} />}
          <div className="flex justify-end">
            <Button
              variant="danger"
              data-testid="void-confirm"
              disabled={
                cancelReceipt.isPending ||
                !isIdentifier(receiptId) ||
                voidReason.trim().length < 3 ||
                voidSigner.identifier.trim().length < 3 ||
                voidSigner.credential.length < 4
              }
              onClick={() => {
                cancelReceipt.mutate({
                  id: receiptId.trim(),
                  reason: voidReason.trim(),
                  coSigner: {
                    identifier: voidSigner.identifier.trim(),
                    credential: voidSigner.credential,
                    credentialKind: 'password',
                  },
                });
              }}
            >
              {cancelReceipt.isPending ? 'Voiding…' : 'Void the receipt'}
            </Button>
          </div>
        </div>
      ) : (
        <ActionUnavailable
          title="Voiding a receipt is not yours to do"
          because="A void unmakes money that was already taken, so it needs a supervisor and a second person. The original receipt is never deleted — a void is written against it."
          permission="receipt.void"
        />
      )}
    </section>
  );
}
