import { describe, expect, it } from 'vitest';
import type { PatientDetail } from '../api/types';
import { patientFixture } from './__fixtures__/patient';
import { assessMerge, compareForMerge, decidableRows, defaultFieldChoices, describeImpact } from './merge';

/**
 * The comparison a merge is decided from.
 *
 * The rule worth reading twice is `defaultFieldChoices`: a field only the
 * *retiring* record has filled in defaults to the retiring record's value. The
 * opposite default silently discards the hospital's only copy of a mobile number
 * or an ABHA address, and the officer would have to notice a blank-versus-filled
 * row to stop it.
 */

function pair(
  survivorOverrides: Partial<PatientDetail>,
  victimOverrides: Partial<PatientDetail>,
): readonly [PatientDetail, PatientDetail] {
  return [
    patientFixture({ id: 's', uhid: 'UH-1', ...survivorOverrides }),
    patientFixture({ id: 'v', uhid: 'UH-2', ...victimOverrides }),
  ];
}

describe('the side-by-side comparison', () => {
  it('marks a field contested only when both records hold something and they differ', () => {
    const [survivor, victim] = pair({ mobile: '9845012345' }, { mobile: '9845099999' });
    const row = compareForMerge(survivor, victim).find((candidate) => candidate.field === 'mobile');
    expect(row?.contested).toBe(true);
    expect(row?.onlyOneSide).toBe(false);
  });

  it('does not treat an identical value as a decision', () => {
    const [survivor, victim] = pair({ mobile: '9845012345' }, { mobile: '9845012345' });
    const row = compareForMerge(survivor, victim).find((candidate) => candidate.field === 'mobile');
    expect(row?.contested).toBe(false);
    expect(decidableRows(compareForMerge(survivor, victim)).map((r) => r.field)).not.toContain('mobile');
  });

  it('treats a blank on one side as “only one side”, not as a contest', () => {
    const [survivor, victim] = pair({ email: null }, { email: 'ramesh@example.org' });
    const row = compareForMerge(survivor, victim).find((candidate) => candidate.field === 'email');
    expect(row?.contested).toBe(false);
    expect(row?.onlyOneSide).toBe(true);
  });

  it('treats an empty string as absent, because the database and the form disagree about blank', () => {
    const [survivor, victim] = pair({ city: '   ' }, { city: 'Bengaluru' });
    const row = compareForMerge(survivor, victim).find((candidate) => candidate.field === 'city');
    expect(row?.survivorValue).toBeNull();
    expect(row?.onlyOneSide).toBe(true);
  });

  it('formats a date of birth and a blood group for reading rather than showing the raw column', () => {
    const [survivor, victim] = pair(
      { dob: '1981-04-12T00:00:00.000Z', blood_group: 'o_pos' },
      { dob: '1981-04-13T00:00:00.000Z', blood_group: 'a_neg' },
    );
    const rows = compareForMerge(survivor, victim);
    expect(rows.find((row) => row.field === 'dob')?.survivorValue).toBe('12-04-1981');
    expect(rows.find((row) => row.field === 'blood_group')?.victimValue).toBe('A−');
  });
});

describe('the default pick per field', () => {
  it('keeps the surviving record’s value where both are filled in', () => {
    const [survivor, victim] = pair({ mobile: '9845012345' }, { mobile: '9845099999' });
    expect(defaultFieldChoices(compareForMerge(survivor, victim))['mobile']).toBe('survivor');
  });

  it('keeps the retiring record’s value where the survivor has none', () => {
    const [survivor, victim] = pair({ abha_number: null }, { abha_number: '12345678901234' });
    expect(defaultFieldChoices(compareForMerge(survivor, victim))['abha_number']).toBe('victim');
  });

  it('offers no choice for a field the two records agree on', () => {
    const [survivor, victim] = pair({ mobile: '9845012345' }, { mobile: '9845012345' });
    expect(defaultFieldChoices(compareForMerge(survivor, victim))).not.toHaveProperty('mobile');
  });
});

describe('whether the merge may be attempted at all', () => {
  it('refuses before both records are chosen', () => {
    expect(assessMerge(undefined, undefined).allowed).toBe(false);
  });

  it('refuses a record merged into itself', () => {
    const patient = patientFixture({ id: 'same' });
    const result = assessMerge(patient, patient);
    expect(result.allowed).toBe(false);
    expect(result.refusals.join(' ')).toContain('into itself');
  });

  it('refuses to merge a record that has already been merged', () => {
    const [survivor, victim] = pair({}, { merged_into_id: 'somebody-else' });
    expect(assessMerge(survivor, victim).allowed).toBe(false);
  });

  it('refuses to merge into a record that has itself been retired', () => {
    const [survivor, victim] = pair({ merged_into_id: 'somebody-else' }, {});
    expect(assessMerge(survivor, victim).refusals.join(' ')).toContain('already been merged');
  });

  it('refuses to give a living patient a deceased record’s identity without a second look', () => {
    const [survivor, victim] = pair({ is_deceased: true }, { is_deceased: false });
    expect(assessMerge(survivor, victim).allowed).toBe(false);
  });

  it('allows an ordinary pair', () => {
    const [survivor, victim] = pair({}, {});
    expect(assessMerge(survivor, victim)).toEqual({ allowed: true, refusals: [] });
  });
});

describe('the impact statement', () => {
  it('names the tables in words and drops the ones with nothing in them', () => {
    expect(
      describeImpact([
        { table: 'op_visits', rows: 3 },
        { table: 'patient_identifiers', rows: 0 },
        { table: 'patient_contacts', rows: 1 },
      ]),
    ).toEqual(['3 × Op visits', '1 × Patient contacts']);
  });
});
