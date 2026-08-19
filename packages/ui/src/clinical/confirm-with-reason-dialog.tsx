'use client';

import { useEffect, useId, useState } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  DialogBody,
  DialogFooter,
  DialogHeader,
} from '../primitives/dialog.js';
import { Label } from '../primitives/label.js';
import { Textarea } from '../primitives/input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../primitives/select.js';
import { Input } from '../primitives/input.js';

/**
 * `ConfirmWithReasonDialog` — docs/06 §6.9, friction levels 4 and 5:
 *
 *   4. "Confirm + reason (coded list + free text)" — order cancellation, dose held or
 *      refused, appointment cancel, amendment.
 *   5. "Confirm + reason + typed value" — refund, bill void, patient merge,
 *      discharge-against-advice: type the bill no. or UHID last 4.
 *
 * Built on the hard-stop `AlertDialog` (§6.8): no ESC, no click-outside, no close X.
 * **Confirm stays disabled until a non-empty reason exists**, and — when
 * `confirmationValue` is given — until the typed value matches exactly. Whitespace is
 * not a reason.
 */
export interface ReasonOption {
  readonly code: string;
  /** Already-localised label. */
  readonly label: string;
  /** Force free text even when a code is chosen (e.g. "Other"). */
  readonly requiresNote?: boolean;
}

export interface ConfirmWithReasonLabels {
  readonly title: string;
  readonly description: string;
  readonly reasonLabel: string;
  readonly reasonPlaceholder: string;
  readonly notePlaceholder: string;
  readonly confirm: string;
  readonly cancel: string;
  /** e.g. `(v) => \`Type ${v} to confirm\`` */
  readonly typedValuePrompt: (expected: string) => string;
  readonly reasonRequired: string;
  readonly typedValueMismatch: string;
}

export interface ConfirmWithReasonResult {
  readonly reasonCode?: string;
  readonly reasonText: string;
}

export interface ConfirmWithReasonDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly labels: ConfirmWithReasonLabels;
  /** §6.9 level 4 — a coded list. Omit for free-text-only reasons. */
  readonly reasonOptions?: readonly ReasonOption[];
  /** §6.9 level 5 — the distinguishing value the user must retype (bill no., UHID last 4). */
  readonly confirmationValue?: string;
  readonly onConfirm: (result: ConfirmWithReasonResult) => void;
  readonly className?: string;
}

export function ConfirmWithReasonDialog({
  open,
  onOpenChange,
  labels,
  reasonOptions,
  confirmationValue,
  onConfirm,
  className,
}: ConfirmWithReasonDialogProps): React.JSX.Element {
  const fieldId = useId();
  const [reasonCode, setReasonCode] = useState<string>('');
  const [reasonText, setReasonText] = useState<string>('');
  const [typedValue, setTypedValue] = useState<string>('');

  useEffect(() => {
    if (!open) {
      setReasonCode('');
      setReasonText('');
      setTypedValue('');
    }
  }, [open]);

  const selectedOption = reasonOptions?.find((option) => option.code === reasonCode);
  const noteRequired = reasonOptions === undefined || selectedOption?.requiresNote === true;

  const trimmedReason = reasonText.trim();
  const hasReason = noteRequired ? trimmedReason.length > 0 : reasonCode !== '';
  const typedValueOk = confirmationValue === undefined || typedValue.trim() === confirmationValue;
  const canConfirm = hasReason && typedValueOk;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={cn(className)} data-slot="confirm-with-reason">
        <DialogHeader>
          <AlertDialogTitle>{labels.title}</AlertDialogTitle>
          <AlertDialogDescription>{labels.description}</AlertDialogDescription>
        </DialogHeader>

        <DialogBody>
          {reasonOptions === undefined ? null : (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${fieldId}-code`} required>
                {labels.reasonLabel}
              </Label>
              <Select value={reasonCode} onValueChange={setReasonCode}>
                <SelectTrigger id={`${fieldId}-code`} aria-required="true">
                  <SelectValue placeholder={labels.reasonPlaceholder} />
                </SelectTrigger>
                <SelectContent>
                  {reasonOptions.map((option) => (
                    <SelectItem key={option.code} value={option.code}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1">
            <Label htmlFor={`${fieldId}-note`} required={noteRequired}>
              {labels.reasonLabel}
            </Label>
            <Textarea
              id={`${fieldId}-note`}
              value={reasonText}
              placeholder={labels.notePlaceholder}
              aria-required={noteRequired}
              aria-invalid={noteRequired && trimmedReason.length === 0}
              aria-describedby={`${fieldId}-reason-hint`}
              onChange={(event) => {
                setReasonText(event.target.value);
              }}
            />
            <p id={`${fieldId}-reason-hint`} className="text-xs text-fg-muted">
              {labels.reasonRequired}
            </p>
          </div>

          {confirmationValue === undefined ? null : (
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${fieldId}-typed`} required>
                {labels.typedValuePrompt(confirmationValue)}
              </Label>
              <Input
                id={`${fieldId}-typed`}
                value={typedValue}
                autoComplete="off"
                aria-required="true"
                aria-invalid={!typedValueOk}
                aria-describedby={`${fieldId}-typed-hint`}
                onChange={(event) => {
                  setTypedValue(event.target.value);
                }}
              />
              <p id={`${fieldId}-typed-hint`} className="text-xs text-fg-muted">
                {labels.typedValueMismatch}
              </p>
            </div>
          )}
        </DialogBody>

        <DialogFooter>
          {/* §6.8 — "primary action is the *safe* one and destructive continue is danger". */}
          <AlertDialogCancel asChild>
            <Button variant="primary">{labels.cancel}</Button>
          </AlertDialogCancel>
          <AlertDialogAction asChild>
            <Button
              variant="danger"
              disabled={!canConfirm}
              onClick={(event) => {
                if (!canConfirm) {
                  // Belt and braces: even if the disabled attribute were removed by a
                  // rogue extension or a future refactor, an empty reason cannot pass.
                  event.preventDefault();
                  return;
                }
                onConfirm({
                  reasonText: trimmedReason,
                  ...(reasonCode === '' ? {} : { reasonCode }),
                });
              }}
            >
              {labels.confirm}
            </Button>
          </AlertDialogAction>
        </DialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
