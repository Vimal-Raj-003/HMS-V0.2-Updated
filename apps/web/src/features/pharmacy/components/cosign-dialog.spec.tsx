import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CoSignDialog } from './cosign-dialog';

/**
 * The second pharmacist's signature — `phase-04` exit gate 4.
 *
 * The property under test is that this is a **sign-in**, not a confirmation.
 * The cheap implementation of a two-person control is a checkbox reading
 * "verified by second pharmacist", or a dropdown of colleagues' names, and both
 * are controls one person can satisfy standing alone at a counter. These tests
 * fail if either appears.
 */
function open(onConfirm = vi.fn()): { readonly onConfirm: ReturnType<typeof vi.fn> } {
  render(
    <CoSignDialog
      open
      onOpenChange={() => undefined}
      title="Second authorising pharmacist"
      purpose="This dispense contains a controlled drug, so two authorised pharmacists must sign it."
      actingUserName="R. Iyer"
      pending={false}
      error={null}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm };
}

describe('the co-sign dialog', () => {
  it('asks for a username and a password, not for a name from a list', () => {
    open();
    expect(screen.getByTestId('cosign-identifier')).toBeInTheDocument();
    const credential = screen.getByTestId('cosign-credential');
    expect(credential).toHaveAttribute('type', 'password');
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says whose signature this is, and that the acting user cannot give it', () => {
    open();
    expect(screen.getByRole('dialog')).toHaveTextContent(/signs in here themselves/iu);
    expect(screen.getByRole('dialog')).toHaveTextContent(
      /Two signatures from one person are one signature/iu,
    );
    expect(screen.getByRole('dialog')).toHaveTextContent(/R\. Iyer cannot countersign their own dispense/iu);
  });

  it('starts empty every time, so a colleague’s username is never pre-filled', () => {
    open();
    expect(screen.getByTestId('cosign-identifier')).toHaveValue('');
    expect(screen.getByTestId('cosign-credential')).toHaveValue('');
  });

  it('never offers to autofill either field from the browser’s password manager', () => {
    open();
    expect(screen.getByTestId('cosign-identifier')).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByTestId('cosign-credential')).toHaveAttribute('autocomplete', 'off');
  });

  it('will not submit without both halves of the credential', () => {
    const { onConfirm } = open();
    const confirm = screen.getByTestId('cosign-confirm');
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByTestId('cosign-identifier'), { target: { value: 'p.nair' } });
    expect(screen.getByTestId('cosign-confirm')).toBeDisabled();

    fireEvent.change(screen.getByTestId('cosign-credential'), { target: { value: 'their-password' } });
    expect(screen.getByTestId('cosign-confirm')).toBeEnabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('sends the second person’s own credential, as a password', () => {
    const { onConfirm } = open();
    fireEvent.change(screen.getByTestId('cosign-identifier'), { target: { value: '  p.nair  ' } });
    fireEvent.change(screen.getByTestId('cosign-credential'), { target: { value: 'their-password' } });
    fireEvent.click(screen.getByTestId('cosign-confirm'));

    expect(onConfirm).toHaveBeenCalledWith({
      identifier: 'p.nair',
      credentialKind: 'password',
      credential: 'their-password',
    });
  });

  /**
   * `services/api` has no PIN or TOTP verifier and refuses both with
   * `not-implemented`. Offering them would be offering a control that does not
   * exist.
   */
  it('offers no factor the API cannot actually verify', () => {
    open();
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/PIN|TOTP|biometric/iu);
  });

  it('renders the API’s refusal with its reference rather than its own words', () => {
    render(
      <CoSignDialog
        open
        onOpenChange={() => undefined}
        title="Second authorising pharmacist"
        purpose="Controlled drug."
        actingUserName="R. Iyer"
        pending={false}
        error={
          new (class extends Error {
            constructor() {
              super('refused');
            }
          })()
        }
        onConfirm={() => undefined}
      />,
    );
    expect(screen.getByTestId('problem-card')).toBeInTheDocument();
    expect(screen.getByTestId('problem-reference')).toBeInTheDocument();
  });
});
