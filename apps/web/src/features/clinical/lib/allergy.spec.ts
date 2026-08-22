import { describe, expect, it } from 'vitest';
import { isSafeToAssumeNoAllergy } from '@vims/ui';
import type { AllergyItem } from '../api/types';
import { allergyStatusIsUnknown, toAllergyStatement } from './allergy';

/**
 * `docs/06` §10 — "an empty allergy area that could mean 'none' or 'not asked'"
 * is a listed defect, and these are the tests that fail if it comes back.
 *
 * The property under test throughout: **`none-known` is reachable only from an
 * explicit `none_known` statement on the patient record.** Not from an empty
 * list, not from a failed request, not from a record this session may not read.
 */

function item(overrides: Partial<AllergyItem> = {}): AllergyItem {
  return {
    id: 'allergy-1',
    category: 'drug',
    substance_text: 'Penicillin',
    substance_code: null,
    reaction: ['anaphylaxis'],
    criticality: 'high',
    severity: 'anaphylaxis',
    status: 'active',
    verification: 'confirmed',
    recorded_by: 'Dr A Menon',
    recorded_at: '2026-01-04T10:00:00.000Z',
    ...overrides,
  };
}

describe('the four allergy states', () => {
  it('renders "not recorded" when nobody has asked — never "none"', () => {
    const statement = toAllergyStatement({ items: [], statement: 'not_recorded' });
    expect(statement.kind).toBe('not-recorded');
    expect(isSafeToAssumeNoAllergy(statement)).toBe(false);
  });

  it('renders "unable to assess" with its reason, distinctly from "not recorded"', () => {
    const statement = toAllergyStatement({
      items: [],
      statement: 'unable_to_assess',
      unableReason: 'the patient is unconscious and came in alone.',
    });
    expect(statement).toStrictEqual({
      kind: 'unable-to-assess',
      reason: 'the patient is unconscious and came in alone.',
    });
    expect(isSafeToAssumeNoAllergy(statement)).toBe(false);
  });

  it('renders "none known" only from an explicit assertion, attributed and dated', () => {
    const statement = toAllergyStatement({
      items: [],
      statement: 'none_known',
      assertedBy: 'Sister Rani',
      assertedOn: '2026-08-01T09:30:00.000Z',
    });
    expect(statement).toStrictEqual({
      kind: 'none-known',
      assertedBy: 'Sister Rani',
      assertedOn: '01-08-2026',
    });
    expect(isSafeToAssumeNoAllergy(statement)).toBe(true);
  });

  it('lists what is recorded when there is something to list', () => {
    const statement = toAllergyStatement({ items: [item()], statement: 'known' });
    expect(statement.kind).toBe('known');
    if (statement.kind === 'known') {
      expect(statement.entries[0]?.allergen.display).toBe('Penicillin');
      expect(statement.entries[0]?.severity).toBe('severe');
    }
  });
});

describe('the states that must never become "none known"', () => {
  it('degrades to "unable to assess" when the list could not be loaded', () => {
    const statement = toAllergyStatement({ items: null, failed: true });
    expect(statement.kind).toBe('unable-to-assess');
    expect(isSafeToAssumeNoAllergy(statement)).toBe(false);
    if (statement.kind === 'unable-to-assess') {
      expect(statement.reason).toContain('could not be loaded');
    }
  });

  it('degrades to "unable to assess" when the list is still loading', () => {
    expect(toAllergyStatement({ items: null }).kind).toBe('unable-to-assess');
  });

  it('degrades to "unable to assess" when the record claims allergies but none came back', () => {
    const statement = toAllergyStatement({ items: [], statement: 'known' });
    expect(statement.kind).toBe('unable-to-assess');
    expect(isSafeToAssumeNoAllergy(statement)).toBe(false);
  });

  it('falls back to "not recorded" — never "none known" — when the statement is unreadable', () => {
    expect(toAllergyStatement({ items: [] }).kind).toBe('not-recorded');
    expect(isSafeToAssumeNoAllergy(toAllergyStatement({ items: [] }))).toBe(false);
  });
});

describe('what is matched against', () => {
  it('never lists an entry recorded in error as a live allergy', () => {
    const statement = toAllergyStatement({
      items: [item({ status: 'entered_in_error' })],
      statement: 'known',
    });
    expect(statement.kind).toBe('unable-to-assess');
  });

  it('maps an unknown severity upwards, never downwards', () => {
    const statement = toAllergyStatement({ items: [item({ severity: 'not-a-severity' })] });
    if (statement.kind === 'known') expect(statement.entries[0]?.severity).toBe('unknown');
  });

  it('keeps anaphylaxis at the top of the design system’s scale', () => {
    const statement = toAllergyStatement({ items: [item({ severity: 'anaphylaxis' })] });
    if (statement.kind === 'known') expect(statement.entries[0]?.severity).toBe('severe');
  });

  it('never invents a reaction for an entry that documents none', () => {
    const statement = toAllergyStatement({ items: [item({ reaction: [] })] });
    if (statement.kind === 'known') expect(statement.entries[0]?.reactions.kind).toBe('not-documented');
  });
});

describe('the inverse predicate', () => {
  it('calls three of the four states unknown', () => {
    expect(allergyStatusIsUnknown({ kind: 'not-recorded' })).toBe(true);
    expect(allergyStatusIsUnknown({ kind: 'unable-to-assess', reason: 'x' })).toBe(true);
    expect(allergyStatusIsUnknown({ kind: 'none-known', assertedBy: 'a', assertedOn: 'b' })).toBe(false);
  });
});
