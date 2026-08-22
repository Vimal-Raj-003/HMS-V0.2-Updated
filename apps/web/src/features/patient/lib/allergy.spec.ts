import { isSafeToAssumeNoAllergy } from '@vims/ui';
import { describe, expect, it } from 'vitest';
import type { PatientAllergyRow, PatientBannerData } from '../api/types';
import { bannerAllergyRecords, toAllergyStatement, toBannerAllergyStatus } from './allergy';

/**
 * The four-arm allergy state, and the conflation `docs/06` §10 names:
 * "an empty allergy area that could mean 'none' or 'not asked'".
 *
 * `isSafeToAssumeNoAllergy` is `@vims/ui`'s own predicate and is the assertion
 * that actually matters — it is what a prescribing path would call. Every arm
 * except `none-known` must fail it, and the first test is the one that fails if
 * anybody ever "simplifies" this mapping into a boolean.
 */

function banner(overrides: Partial<PatientBannerData> = {}): PatientBannerData {
  return {
    uhid: '0021-45871',
    full_name: 'SHARMA, Ramesh',
    gender: 'male',
    age_display: '45 y',
    blood_group: 'o_pos',
    photo_file_id: null,
    allergy_statement: 'not_recorded',
    allergy_asserted_at: null,
    allergy_unable_reason: null,
    allergies: [],
    alerts: [],
    is_vip: false,
    is_deceased: false,
    status: 'active',
    merged_into_id: null,
    ...overrides,
  };
}

function allergyRow(overrides: Partial<PatientAllergyRow> = {}): PatientAllergyRow {
  return {
    id: 'al-1',
    category: 'drug',
    substance_text: 'Penicillin',
    criticality: 'high',
    severity: 'severe',
    status: 'active',
    ...overrides,
  };
}

describe('the banner’s allergy status', () => {
  it('renders “not recorded” as its own state, never as “none”', () => {
    expect(toBannerAllergyStatus(banner({ allergy_statement: 'not_recorded' })).kind).toBe('not-recorded');
    // The predicate a prescribing path would call. `not_recorded` must fail it:
    // "nobody has asked" is not "there are none".
    expect(
      isSafeToAssumeNoAllergy(
        toAllergyStatement({
          allergy_statement: 'not_recorded',
          allergy_asserted_by: null,
          allergy_asserted_at: null,
          allergy_unable_reason: null,
        }),
      ),
    ).toBe(false);
  });

  it('renders “unable to assess” with the reason the clinician gave', () => {
    const status = toBannerAllergyStatus(
      banner({ allergy_statement: 'unable_to_assess', allergy_unable_reason: 'Patient unconscious' }),
    );
    expect(status).toEqual({ kind: 'unable-to-assess', reason: 'Patient unconscious' });
  });

  it('never lets “unable to assess” degrade into a blank chip when the reason is missing', () => {
    const status = toBannerAllergyStatus(banner({ allergy_statement: 'unable_to_assess' }));
    expect(status.kind).toBe('unable-to-assess');
    expect(status.kind === 'unable-to-assess' ? status.reason : '').not.toBe('');
  });

  it('renders “none known” as an explicit positive state with its verification date', () => {
    const status = toBannerAllergyStatus(
      banner({ allergy_statement: 'none_known', allergy_asserted_at: '2026-08-12T04:30:00.000Z' }),
    );
    expect(status).toEqual({ kind: 'none-known', verifiedOn: '12-08-2026' });
  });

  it('lists known allergies', () => {
    const status = toBannerAllergyStatus(banner({ allergy_statement: 'known', allergies: [allergyRow()] }));
    expect(status.kind).toBe('known');
    expect(status.kind === 'known' ? status.allergies[0]?.substance : '').toBe('Penicillin');
  });

  it('degrades a “known” statement with nothing renderable to “unable to assess”, not to silence', () => {
    // The dangerous shape: the record says there are allergies and the list is
    // empty. Rendering nothing would read as "none known".
    const status = toBannerAllergyStatus(banner({ allergy_statement: 'known', allergies: [] }));
    expect(status.kind).toBe('unable-to-assess');
  });

  it('is safe to assume no allergy for exactly one of the four arms', () => {
    const arms = [
      toBannerAllergyStatus(banner({ allergy_statement: 'not_recorded' })),
      toBannerAllergyStatus(banner({ allergy_statement: 'unable_to_assess', allergy_unable_reason: 'x' })),
      toBannerAllergyStatus(banner({ allergy_statement: 'none_known' })),
      toBannerAllergyStatus(banner({ allergy_statement: 'known', allergies: [allergyRow()] })),
    ];
    expect(arms.map((arm) => arm.kind === 'none-known')).toEqual([false, false, true, false]);
  });
});

describe('which allergy rows reach the banner', () => {
  it('drops rows entered in error and refuted rows, which the database keeps but nobody should act on', () => {
    const rows = [
      allergyRow({ id: 'a', status: 'active' }),
      allergyRow({ id: 'b', status: 'entered_in_error', substance_text: 'Typo' }),
      allergyRow({ id: 'c', status: 'refuted', substance_text: 'Investigated and disproved' }),
    ];
    expect(bannerAllergyRecords(rows).map((record) => record.substance)).toEqual(['Penicillin']);
  });

  it('maps an unrecorded severity **up** to severe rather than down', () => {
    // Under-stating a reaction nobody graded is the failure that hurts a patient.
    const [record] = bannerAllergyRecords([allergyRow({ severity: 'unknown' })]);
    expect(record?.severity).toBe('severe');
  });

  it('never renders an empty reaction string, which would read as “no reaction”', () => {
    for (const criticality of ['high', 'low', 'unable_to_assess']) {
      const [record] = bannerAllergyRecords([allergyRow({ criticality })]);
      expect(record?.reaction.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe('the editor’s statement', () => {
  it('attributes “none known” to somebody, and says so when nobody is recorded', () => {
    expect(
      toAllergyStatement({
        allergy_statement: 'none_known',
        allergy_asserted_by: 'S. Nurse',
        allergy_asserted_at: '2026-08-12T04:30:00.000Z',
        allergy_unable_reason: null,
      }),
    ).toEqual({ kind: 'none-known', assertedBy: 'S. Nurse', assertedOn: '12-08-2026' });

    expect(
      toAllergyStatement({
        allergy_statement: 'none_known',
        allergy_asserted_by: null,
        allergy_asserted_at: null,
        allergy_unable_reason: null,
      }),
    ).toEqual({ kind: 'none-known', assertedBy: 'Not recorded', assertedOn: '—' });
  });

  it('produces a non-empty entry list for a known statement, or refuses to call it known', () => {
    const known = toAllergyStatement({
      allergy_statement: 'known',
      allergy_asserted_by: null,
      allergy_asserted_at: null,
      allergy_unable_reason: null,
      allergies: [allergyRow()],
    });
    expect(known.kind).toBe('known');

    const empty = toAllergyStatement({
      allergy_statement: 'known',
      allergy_asserted_by: null,
      allergy_asserted_at: null,
      allergy_unable_reason: null,
      allergies: [],
    });
    expect(empty.kind).toBe('unable-to-assess');
  });
});
