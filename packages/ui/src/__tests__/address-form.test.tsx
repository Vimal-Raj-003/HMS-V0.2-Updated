import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  AddressForm,
  emptyIndianAddress,
  isValidPincode,
  type AddressFormLabels,
  type IndianAddress,
  type PincodeArea,
} from '../clinical/address-form.js';
import { findAccessibilityViolations } from './axe.js';

const labels: AddressFormLabels = {
  region: 'Address',
  line1: 'House / flat / building',
  line2: 'Street',
  landmark: 'Landmark',
  pincode: 'PIN code',
  pincodeHint: 'Six digits — we will fill the district and state for you.',
  pincodeInvalid: 'A PIN code is six digits and never starts with 0.',
  area: 'Village / locality',
  city: 'Town / city',
  district: 'District',
  state: 'State / UT',
  statePlaceholder: 'Choose a state',
  country: 'Country',
  lookingUp: 'Looking up the PIN code…',
  lookupNotFound: 'That PIN code is not in the directory.',
  lookupUnavailable: 'The PIN directory is unavailable.',
  lookupManualHint: 'Type the district and state instead.',
  chooseArea: 'Which post office?',
  retryLookup: 'Retry',
  optional: '(optional)',
};

const states = [
  { code: 'TN', label: 'Tamil Nadu' },
  { code: 'KL', label: 'Kerala' },
];

const coimbatore: PincodeArea = {
  area: 'Peelamedu',
  city: 'Coimbatore',
  district: 'Coimbatore',
  stateCode: 'TN',
  stateName: 'Tamil Nadu',
};
const secondOffice: PincodeArea = { ...coimbatore, area: 'Hopes College' };

function Harness({
  lookupPincode,
  scriptLocale,
}: {
  readonly lookupPincode?: (pincode: string) => Promise<readonly PincodeArea[] | null>;
  readonly scriptLocale?: string;
}): React.JSX.Element {
  const [value, setValue] = useState<IndianAddress>(emptyIndianAddress());
  return (
    <AddressForm
      value={value}
      onChange={setValue}
      labels={labels}
      states={states}
      {...(lookupPincode === undefined ? {} : { lookupPincode })}
      {...(scriptLocale === undefined ? {} : { scriptLocale })}
    />
  );
}

describe('isValidPincode', () => {
  it('accepts a real India Post PIN and nothing else', () => {
    expect(isValidPincode('641004')).toBe(true);
    expect(isValidPincode('041004')).toBe(false);
    expect(isValidPincode('64100')).toBe(false);
    expect(isValidPincode('6410045')).toBe(false);
    expect(isValidPincode('64100a')).toBe(false);
  });
});

describe('AddressForm — OP-001 registration', () => {
  it('accepts only digits in the PIN field and caps it at six', () => {
    render(<Harness />);
    const pincode = screen.getByLabelText(/PIN code/);
    fireEvent.change(pincode, { target: { value: '64a1-004999' } });
    expect((pincode as HTMLInputElement).value).toBe('641004');
  });

  it('keeps numerals LTR with a numeric keypad, for RTL and Indic forms alike', () => {
    render(<Harness scriptLocale="ta-IN" />);
    const pincode = screen.getByLabelText(/PIN code/);
    expect(pincode).toHaveAttribute('dir', 'ltr');
    expect(pincode).toHaveAttribute('inputmode', 'numeric');
    // The free-text lines carry the patient's script so the Indic font stack and the
    // screen-reader voice both switch (docs/06 §8).
    expect(screen.getByLabelText(/House \/ flat \/ building/)).toHaveAttribute('lang', 'ta-IN');
  });

  it('fills the district and state from an unambiguous PIN', async () => {
    const lookupPincode = vi
      .fn<(pincode: string) => Promise<readonly PincodeArea[] | null>>()
      .mockResolvedValue([coimbatore]);
    render(<Harness lookupPincode={lookupPincode} />);
    fireEvent.change(screen.getByLabelText(/PIN code/), { target: { value: '641004' } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(lookupPincode).toHaveBeenCalledWith('641004');
    expect(screen.getByLabelText(/District/)).toHaveValue('Coimbatore');
    expect(screen.getByLabelText(/Village \/ locality/)).toHaveValue('Peelamedu');
  });

  it('asks which post office when a PIN is ambiguous instead of guessing', async () => {
    const lookupPincode = vi
      .fn<(pincode: string) => Promise<readonly PincodeArea[] | null>>()
      .mockResolvedValue([coimbatore, secondOffice]);
    render(<Harness lookupPincode={lookupPincode} />);
    fireEvent.change(screen.getByLabelText(/PIN code/), { target: { value: '641004' } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('Which post office?')).toBeInTheDocument();
    expect(screen.getByLabelText(/Village \/ locality/)).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /Hopes College/ }));
    expect(screen.getByLabelText(/Village \/ locality/)).toHaveValue('Hopes College');
  });

  it('degrades to manual entry when the directory is down, and never blocks the desk', async () => {
    const lookupPincode = vi
      .fn<(pincode: string) => Promise<readonly PincodeArea[] | null>>()
      .mockRejectedValue(new Error('gateway timeout'));
    const { container } = render(<Harness lookupPincode={lookupPincode} />);
    fireEvent.change(screen.getByLabelText(/PIN code/), { target: { value: '641004' } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-lookup="unavailable"]')?.textContent).toContain(
      'The PIN directory is unavailable.',
    );
    const district = screen.getByLabelText(/District/);
    expect(district).not.toBeDisabled();
    fireEvent.change(district, { target: { value: 'Coimbatore' } });
    expect(district).toHaveValue('Coimbatore');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('names an unknown PIN rather than silently doing nothing', async () => {
    const lookupPincode = vi
      .fn<(pincode: string) => Promise<readonly PincodeArea[] | null>>()
      .mockResolvedValue([]);
    const { container } = render(<Harness lookupPincode={lookupPincode} />);
    fireEvent.change(screen.getByLabelText(/PIN code/), { target: { value: '999999' } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-lookup="not-found"]')?.textContent).toContain(
      'That PIN code is not in the directory.',
    );
  });

  it('surfaces a server field error on the right field', () => {
    render(
      <AddressForm
        value={emptyIndianAddress()}
        onChange={() => undefined}
        labels={labels}
        states={states}
        errors={{ line1: 'House number is required for a PMJAY claim' }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('House number is required for a PMJAY claim');
    expect(screen.getByLabelText(/House \/ flat \/ building/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('is fully reachable by keyboard', () => {
    render(<Harness />);
    for (const field of [/House \/ flat \/ building/, /PIN code/, /District/, /Town \/ city/]) {
      const element = screen.getByLabelText(field);
      element.focus();
      expect(document.activeElement).toBe(element);
    }
  });

  it('has no axe violations', async () => {
    const { container } = render(<Harness />);
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
