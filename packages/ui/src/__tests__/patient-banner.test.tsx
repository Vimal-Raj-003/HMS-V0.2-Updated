import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PatientBanner, type PatientBannerLabels, type PatientIdentity } from '../clinical/patient-banner.js';
import { findAccessibilityViolations } from './axe.js';

const labels: PatientBannerLabels = {
  region: 'Patient identity and alerts',
  allergyPrefix: 'ALLERGY:',
  allergiesNotRecorded: 'Allergies not recorded',
  noKnownAllergies: (verifiedOn) => `No known allergies (verified ${verifiedOn})`,
  moreAllergies: (count) => `+${String(count)}`,
  isolationPrefix: 'ISOLATION',
  mlcPrefix: 'MLC',
  bloodGroupPrefix: 'Blood group',
  weightPrefix: 'Weight kg',
  weightMissing: 'Weight not recorded',
  uhidPrefix: 'UHID',
  episodePrefix: 'IP',
  lengthOfStayPrefix: 'LOS',
  payerPrefix: 'Payer',
  breakGlass: 'Break-glass',
  maskedNotice: 'Outside care team',
  sex: { male: 'M', female: 'F', other: 'O', unknown: 'Unknown' },
};

const base: PatientIdentity = {
  uhid: '0021-45871',
  familyName: 'Sharma',
  givenName: 'Ramesh Kumar',
  age: '45 y',
  sex: 'male',
  episodeId: '2026/IP/018452',
  ward: 'Ward 3B',
  bed: 'Bed 12',
  lengthOfStay: '6 d 4 h',
  attendingConsultant: 'Dr A. Menon',
  department: 'Ortho',
  payer: 'Star Health',
  creditStatus: 'TPA approved',
  bloodGroup: 'B+',
  weightKg: 72,
  allergies: {
    kind: 'known',
    allergies: [
      { substance: 'Penicillin', reaction: 'anaphylaxis', severity: 'severe' },
      { substance: 'Sulfa', reaction: 'rash', severity: 'mild' },
    ],
  },
  isolation: { type: 'Contact' },
  mlc: { number: '4471' },
  alerts: [{ kind: 'fall-risk', label: 'Fall risk' }],
};

describe('PatientBanner — CLAUDE.md §5 / docs/06 §4.2', () => {
  it('shows the two identifiers, age/sex and episode', () => {
    render(<PatientBanner patient={base} labels={labels} />);
    expect(screen.getByRole('region', { name: labels.region })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /SHARMA, Ramesh Kumar/ })).toBeInTheDocument();
    expect(screen.getByText(/45 y \/ M/)).toBeInTheDocument();
    expect(screen.getByText(/UHID 0021-45871/)).toBeInTheDocument();
    expect(screen.getByText(/IP 2026\/IP\/018452/)).toBeInTheDocument();
  });

  it('renders the allergy first, in danger, with the reaction and an overflow count', () => {
    const { container } = render(<PatientBanner patient={base} labels={labels} />);
    const allergy = container.querySelector('[data-flag="allergy"]');
    expect(allergy).not.toBeNull();
    expect(allergy?.textContent).toContain('ALLERGY: Penicillin (anaphylaxis)');
    expect(allergy?.textContent).toContain('+1');
    expect(allergy?.className).toContain('text-danger-on-surface');

    // §4.2 — allergies are always the first chip in the flag row.
    const flags = [...container.querySelectorAll('[data-flag]')];
    expect(flags[0]).toBe(allergy);
  });

  it('renders isolation and MLC as their own flags', () => {
    const { container } = render(<PatientBanner patient={base} labels={labels} />);
    expect(container.querySelector('[data-flag="isolation"]')?.textContent).toContain('ISOLATION Contact');
    expect(container.querySelector('[data-flag="mlc"]')?.textContent).toContain('MLC 4471');
    expect(container.querySelector('[data-flag="alert-fall-risk"]')?.textContent).toContain('Fall risk');
  });

  it('never leaves the allergy area empty — "not recorded" is a warning, not silence', () => {
    const { container } = render(
      <PatientBanner patient={{ ...base, allergies: { kind: 'not-recorded' } }} labels={labels} />,
    );
    expect(container.querySelector('[data-flag="allergy"]')).toBeNull();
    const chip = container.querySelector('[data-flag="allergy-not-recorded"]');
    expect(chip?.textContent).toBe('Allergies not recorded');
    expect(chip?.className).toContain('warning');
  });

  it('renders "no known allergies" as an explicit verified positive state', () => {
    const { container } = render(
      <PatientBanner
        patient={{ ...base, allergies: { kind: 'none-known', verifiedOn: '12-08-2026' } }}
        labels={labels}
      />,
    );
    expect(container.querySelector('[data-flag="allergy-none-known"]')?.textContent).toBe(
      'No known allergies (verified 12-08-2026)',
    );
  });

  it('flags a missing weight instead of defaulting it (docs/06 §5.2 #18)', () => {
    const patient = { ...base };
    delete (patient as { weightKg?: number }).weightKg;
    const { container } = render(<PatientBanner patient={patient} labels={labels} />);
    const weight = container.querySelector('[data-flag="weight"]');
    expect(weight?.textContent).toBe('Weight not recorded');
    expect(weight?.className).toContain('warning');
  });

  it('masks the identity outside the care team and offers break-glass', () => {
    const onBreakGlass = vi.fn();
    render(<PatientBanner patient={base} labels={labels} mode="masked" onBreakGlass={onBreakGlass} />);
    expect(screen.getByRole('heading', { name: 'SR · 5871' })).toBeInTheDocument();
    screen.getByRole('button', { name: 'Break-glass' }).click();
    expect(onBreakGlass).toHaveBeenCalledTimes(1);
  });

  it('opens the source record when a flag is activated by keyboard', () => {
    const onFlagSelect = vi.fn();
    const { container } = render(
      <PatientBanner patient={base} labels={labels} onFlagSelect={onFlagSelect} />,
    );
    const allergy = container.querySelector<HTMLButtonElement>('[data-flag="allergy"]');
    expect(allergy?.tagName).toBe('BUTTON');
    allergy?.focus();
    expect(document.activeElement).toBe(allergy);
    allergy?.click();
    expect(onFlagSelect).toHaveBeenCalledWith('allergy');
  });

  it('has no axe violations', async () => {
    const { container } = render(<PatientBanner patient={base} labels={labels} />);
    await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
  });
});
