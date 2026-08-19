import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ConfirmWithReasonDialog,
  type ConfirmWithReasonLabels,
} from '../clinical/confirm-with-reason-dialog.js';
import { findAccessibilityViolations } from './axe.js';

const labels: ConfirmWithReasonLabels = {
  title: 'Cancel order',
  description: 'The order will be reversed and the reason recorded in the audit log.',
  reasonLabel: 'Reason',
  reasonPlaceholder: 'Choose a reason',
  notePlaceholder: 'Add the clinical reason',
  confirm: 'Cancel order',
  cancel: 'Keep order',
  typedValuePrompt: (expected) => `Type ${expected} to confirm`,
  reasonRequired: 'A reason is required and is written to the audit log.',
  typedValueMismatch: 'The typed value must match exactly.',
};

describe('ConfirmWithReasonDialog — docs/06 §6.9 levels 4 and 5', () => {
  it('keeps confirm disabled until a non-empty reason exists', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmWithReasonDialog open onOpenChange={() => undefined} labels={labels} onConfirm={onConfirm} />,
    );

    const confirm = screen.getByRole('button', { name: 'Cancel order' });
    expect(confirm).toBeDisabled();

    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('treats whitespace as no reason at all', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmWithReasonDialog open onOpenChange={() => undefined} labels={labels} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '   \n\t ' } });
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms with the trimmed reason once one is typed', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmWithReasonDialog open onOpenChange={() => undefined} labels={labels} onConfirm={onConfirm} />,
    );
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '  Duplicate order  ' } });

    const confirm = screen.getByRole('button', { name: 'Cancel order' });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ reasonText: 'Duplicate order' });
  });

  it('additionally requires the typed distinguishing value at friction level 5', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmWithReasonDialog
        open
        onOpenChange={() => undefined}
        labels={labels}
        confirmationValue="5871"
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Wrong patient' } });
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type 5871 to confirm/), { target: { value: '587' } });
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Type 5871 to confirm/), { target: { value: '5871' } });
    const confirm = screen.getByRole('button', { name: 'Cancel order' });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith({ reasonText: 'Wrong patient' });
  });

  it('is a hard stop: Escape does not close it (docs/06 §6.8)', () => {
    const onOpenChange = vi.fn();
    render(
      <ConfirmWithReasonDialog open onOpenChange={onOpenChange} labels={labels} onConfirm={() => undefined} />,
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('is fully operable from the keyboard and traps focus in the hard stop', () => {
    render(
      <ConfirmWithReasonDialog open onOpenChange={() => undefined} labels={labels} onConfirm={() => undefined} />,
    );
    const dialog = screen.getByRole('alertdialog');
    // Radix moves focus into the dialog on open; every control must be inside it.
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (const name of ['Keep order', 'Cancel order']) {
      expect(dialog.contains(screen.getByRole('button', { name }))).toBe(true);
    }
    const reason = screen.getByLabelText(/Reason/);
    reason.focus();
    expect(document.activeElement).toBe(reason);
  });

  it('has no axe violations', async () => {
    render(
      <ConfirmWithReasonDialog open onOpenChange={() => undefined} labels={labels} onConfirm={() => undefined} />,
    );
    await expect(findAccessibilityViolations(screen.getByRole('alertdialog'))).resolves.toEqual([]);
  });
});
