import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  AllergyEditor,
  activeAllergies,
  bannerStatusFor,
  isSafeToAssumeNoAllergy,
  type AllergyEditorLabels,
  type AllergyEntry,
  type AllergyStatement,
} from '../clinical/allergy-editor.js';
import { findAccessibilityViolations } from './axe.js';

const labels: AllergyEditorLabels = {
  region: 'Allergies',
  statusHeading: 'Allergies',
  notRecorded: 'Allergies not recorded',
  notRecordedAction: 'Ask the patient before prescribing.',
  unableToAssess: (reason) => `Unable to assess — ${reason}`,
  noneKnown: (by, on) => `No known allergies (asked by ${by} on ${on})`,
  declareNoneKnown: 'Record: no known allergies',
  declareUnableToAssess: 'Record: unable to assess',
  unableToAssessReasonLabel: 'Unable to assess because',
  unableToAssessReasonPlaceholder: 'Choose a reason',
  addAllergy: 'Add allergy',
  allergenLabel: 'Allergen',
  allergenPlaceholder: 'Drug, food or substance',
  categoryLabel: 'Category',
  category: {
    drug: 'Drug',
    'drug-class': 'Drug class',
    food: 'Food',
    environment: 'Environment',
    'contrast-media': 'Contrast media',
    latex: 'Latex',
    other: 'Other',
  },
  reactionLabel: 'Reaction',
  reactionPlaceholder: 'e.g. anaphylaxis',
  reactionNotDocumented: 'Reaction not documented',
  severityLabel: 'Severity',
  severity: { mild: 'Mild', moderate: 'Moderate', severe: 'Severe', unknown: 'Severity unknown' },
  criticalityLabel: 'Criticality',
  criticality: { low: 'Low risk', high: 'High risk', 'unable-to-assess': 'Risk not assessed' },
  verificationUnverified: 'Unverified',
  verificationConfirmed: (by, on) => `Confirmed by ${by} on ${on}`,
  verificationRefuted: (by, on) => `Refuted by ${by} on ${on}`,
  confirm: 'Confirm',
  refute: 'Refute',
  remove: 'Remove',
  save: 'Save allergy',
  cancel: 'Cancel',
  listLabel: 'Recorded allergies',
  recordedByPrefix: 'Recorded by',
};

const asserter = { name: 'Nurse J. Pillai', on: '20-08-2026' };
const reasons = [
  { code: 'unconscious', label: 'Patient unconscious, no informant' },
  { code: 'language', label: 'No interpreter available' },
];

const penicillin: AllergyEntry = {
  id: 'alg_1',
  allergen: { display: 'Penicillin', category: 'drug' },
  reactions: { kind: 'documented', reactions: ['anaphylaxis'] },
  severity: 'severe',
  criticality: 'high',
  verification: { kind: 'unverified' },
  recordedBy: 'Dr A. Menon',
  recordedOn: '12-08-2026',
};

let nextId = 0;
function makeId(): string {
  nextId += 1;
  return `alg_new_${String(nextId)}`;
}

function Harness({
  initial,
  onChange,
  canVerify = false,
}: {
  readonly initial: AllergyStatement;
  readonly onChange?: (statement: AllergyStatement) => void;
  readonly canVerify?: boolean;
}): React.JSX.Element {
  const [statement, setStatement] = useState<AllergyStatement>(initial);
  return (
    <AllergyEditor
      statement={statement}
      labels={labels}
      asserter={asserter}
      unableToAssessReasons={reasons}
      newEntryId={makeId}
      canVerify={canVerify}
      onChange={(next) => {
        setStatement(next);
        onChange?.(next);
      }}
    />
  );
}

describe('AllergyEditor — the four states are never conflated', () => {
  it('makes an empty known-allergy list unrepresentable', () => {
    // @ts-expect-error — `known` carries a non-empty tuple; an empty list cannot compile.
    const impossible: AllergyStatement = { kind: 'known', entries: [] };
    expect(impossible.kind).toBe('known');
  });

  it('renders "not recorded" as a warning, not as silence', () => {
    const { container } = render(<Harness initial={{ kind: 'not-recorded' }} />);
    expect(container.querySelector('[data-statement="not-recorded"]')?.textContent).toContain(
      'Allergies not recorded',
    );
    expect(container.querySelector('[data-statement="none-known"]')).toBeNull();
    expect(container.querySelector('[data-statement="unable-to-assess"]')).toBeNull();
  });

  it('renders "unable to assess" as its own state, with its reason', () => {
    const { container } = render(
      <Harness initial={{ kind: 'unable-to-assess', reason: 'Patient unconscious, no informant' }} />,
    );
    const banner = container.querySelector('[data-statement="unable-to-assess"]');
    expect(banner?.textContent).toBe('Unable to assess — Patient unconscious, no informant');
    expect(container.querySelector('[data-statement="none-known"]')).toBeNull();
    expect(container.querySelector('[data-statement="not-recorded"]')).toBeNull();
  });

  it('renders "none known" as an attributed, dated positive assertion', () => {
    const { container } = render(
      <Harness initial={{ kind: 'none-known', assertedBy: 'Nurse J. Pillai', assertedOn: '20-08-2026' }} />,
    );
    expect(container.querySelector('[data-statement="none-known"]')?.textContent).toBe(
      'No known allergies (asked by Nurse J. Pillai on 20-08-2026)',
    );
  });

  it('lets exactly one state clear a prescribing check', () => {
    expect(isSafeToAssumeNoAllergy({ kind: 'not-recorded' })).toBe(false);
    expect(isSafeToAssumeNoAllergy({ kind: 'unable-to-assess', reason: 'Unconscious' })).toBe(false);
    expect(isSafeToAssumeNoAllergy({ kind: 'known', entries: [penicillin] })).toBe(false);
    expect(isSafeToAssumeNoAllergy({ kind: 'none-known', assertedBy: 'X', assertedOn: '20-08-2026' })).toBe(
      true,
    );
  });

  it('keeps an unverified allergy visibly unverified', () => {
    const { container } = render(<Harness initial={{ kind: 'known', entries: [penicillin] }} />);
    const row = container.querySelector('[data-allergy-id="alg_1"]');
    expect(row?.getAttribute('data-verification-kind')).toBe('unverified');
    expect(container.querySelector('[data-verification="unverified"]')?.textContent).toBe('Unverified');
    expect(container.querySelector('[data-verification="confirmed"]')).toBeNull();
  });

  it('records a newly typed allergy as unverified, never as confirmed', () => {
    const onChange = vi.fn<(statement: AllergyStatement) => void>();
    render(<Harness initial={{ kind: 'not-recorded' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Add allergy/ }));
    fireEvent.change(screen.getByLabelText(/Allergen/), { target: { value: 'Sulfa' } });
    fireEvent.change(screen.getByLabelText(/Reaction/), { target: { value: 'rash' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allergy' }));

    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next?.kind).toBe('known');
    if (next?.kind !== 'known') throw new Error('expected a known statement');
    expect(next.entries[0].verification.kind).toBe('unverified');
    expect(next.entries[0].allergen.display).toBe('Sulfa');
    expect(next.entries[0].reactions).toEqual({ kind: 'documented', reactions: ['rash'] });
    expect(next.entries[0].recordedBy).toBe('Nurse J. Pillai');
  });

  it('records "reaction not documented" rather than an empty reaction list', () => {
    const onChange = vi.fn<(statement: AllergyStatement) => void>();
    render(<Harness initial={{ kind: 'not-recorded' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Add allergy/ }));
    fireEvent.change(screen.getByLabelText(/Allergen/), { target: { value: 'Iodine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save allergy' }));
    const next = onChange.mock.calls.at(-1)?.[0];
    if (next?.kind !== 'known') throw new Error('expected a known statement');
    expect(next.entries[0].reactions).toEqual({ kind: 'not-documented' });
  });

  it('never turns "remove the last allergy" into "no known allergies"', () => {
    const onChange = vi.fn<(statement: AllergyStatement) => void>();
    render(<Harness initial={{ kind: 'known', entries: [penicillin] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({ kind: 'not-recorded' });
  });

  it('keeps a refuted allergy on the record but out of the CDSS match set', () => {
    render(<Harness initial={{ kind: 'known', entries: [penicillin] }} canVerify />);
    fireEvent.click(screen.getByRole('button', { name: 'Refute' }));
    const refuted: AllergyStatement = {
      kind: 'known',
      entries: [{ ...penicillin, verification: { kind: 'refuted', by: 'x', on: '20-08-2026' } }],
    };
    expect(activeAllergies(refuted)).toEqual([]);
    expect(screen.getByText(/Refuted by/)).toBeInTheDocument();
  });

  it('confirms an allergy with the asserting clinician and date', () => {
    const onChange = vi.fn<(statement: AllergyStatement) => void>();
    render(<Harness initial={{ kind: 'known', entries: [penicillin] }} onChange={onChange} canVerify />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    const next = onChange.mock.calls.at(-1)?.[0];
    if (next?.kind !== 'known') throw new Error('expected a known statement');
    expect(next.entries[0].verification).toEqual({
      kind: 'confirmed',
      by: 'Nurse J. Pillai',
      on: '20-08-2026',
    });
  });

  it('declares "no known allergies" with the asker and the date attached', () => {
    const onChange = vi.fn<(statement: AllergyStatement) => void>();
    render(<Harness initial={{ kind: 'not-recorded' }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record: no known allergies' }));
    expect(onChange.mock.calls.at(-1)?.[0]).toEqual({
      kind: 'none-known',
      assertedBy: 'Nurse J. Pillai',
      assertedOn: '20-08-2026',
    });
  });

  it('projects onto the banner without losing the distinction', () => {
    const bannerLabels = {
      unableToAssess: (reason: string) => `Unable to assess — ${reason}`,
      reactionNotDocumented: 'Reaction not documented',
    };
    expect(bannerStatusFor({ kind: 'not-recorded' }, bannerLabels)).toEqual({ kind: 'not-recorded' });
    expect(bannerStatusFor({ kind: 'unable-to-assess', reason: 'Unconscious' }, bannerLabels)).toEqual({
      kind: 'unable-to-assess',
      reason: 'Unable to assess — Unconscious',
    });
    expect(
      bannerStatusFor({ kind: 'none-known', assertedBy: 'N', assertedOn: '20-08-2026' }, bannerLabels),
    ).toEqual({ kind: 'none-known', verifiedOn: '20-08-2026' });

    const projected = bannerStatusFor({ kind: 'known', entries: [penicillin] }, bannerLabels);
    if (projected.kind !== 'known') throw new Error('expected known');
    expect(projected.allergies[0]?.substance).toBe('Penicillin');
    expect(projected.allergies[0]?.reaction).toBe('anaphylaxis');
  });

  it('is operable from the keyboard', () => {
    render(<Harness initial={{ kind: 'not-recorded' }} />);
    const add = screen.getByRole('button', { name: /Add allergy/ });
    add.focus();
    expect(document.activeElement).toBe(add);
    fireEvent.click(add);
    const allergen = screen.getByLabelText(/Allergen/);
    allergen.focus();
    fireEvent.change(allergen, { target: { value: 'Aspirin' } });
    // Enter commits the draft without reaching for the mouse.
    fireEvent.keyDown(allergen, { key: 'Enter' });
    expect(screen.getByText('Aspirin')).toBeInTheDocument();
  });

  it('has no axe violations in any of the four states', async () => {
    for (const statement of [
      { kind: 'not-recorded' } as const,
      { kind: 'unable-to-assess', reason: 'Unconscious' } as const,
      { kind: 'none-known', assertedBy: 'N', assertedOn: '20-08-2026' } as const,
      { kind: 'known', entries: [penicillin] } as const,
    ]) {
      const { container, unmount } = render(<Harness initial={statement} canVerify />);
      await expect(findAccessibilityViolations(container)).resolves.toEqual([]);
      unmount();
    }
  });
});
