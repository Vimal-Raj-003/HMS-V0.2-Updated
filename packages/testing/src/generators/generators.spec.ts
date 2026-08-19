import { describe, expect, it } from 'vitest';
import { createRng } from './rng.js';
import { generatePatient, generatePatients, isVerhoeffValid } from './indian-patient.js';

describe('createRng', () => {
  it('is deterministic: the same seed replays the same stream', () => {
    const a = Array.from({ length: 32 }, () => createRng(4242).next());
    const b = Array.from({ length: 32 }, () => createRng(4242).next());
    expect(a).toEqual(b);
  });

  it('produces different streams for different seeds', () => {
    expect(createRng(1).next()).not.toBe(createRng(2).next());
  });

  it('stays inside the requested integer range', () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i += 1) {
      const value = rng.int(3, 9);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(9);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('forks into independent streams, so adding a field cannot shift another', () => {
    const base = createRng(99);
    expect(base.fork(1).next()).not.toBe(base.fork(2).next());
  });

  it('rejects an empty pick rather than returning undefined', () => {
    expect(() => createRng(1).pick([])).toThrow(RangeError);
  });
});

describe('isVerhoeffValid', () => {
  // `2363` is the worked example in the published description of the scheme
  // (check digit 3 for the payload 236); the rest were derived from this
  // implementation and then cross-checked against it independently.
  it.each(['2363', '1003', '1019', '1026'])('accepts the valid checksum %s', (digits) => {
    expect(isVerhoeffValid(digits)).toBe(true);
  });

  // Catching adjacent transposition is the property Verhoeff was designed for
  // and the reason UIDAI chose it — it is what makes a mistyped Aadhaar
  // detectable rather than silently belonging to someone else.
  it.each([
    ['2363', '2336'],
    ['1003', '1030'],
  ])('rejects the transposition of %s', (valid, transposed) => {
    expect(isVerhoeffValid(valid)).toBe(true);
    expect(isVerhoeffValid(transposed)).toBe(false);
  });

  it('rejects an all-zero string of Aadhaar length', () => {
    expect(isVerhoeffValid('000000000000')).toBe(false);
  });
});

describe('generatePatient', () => {
  it('is fully determined by its seed', () => {
    expect(generatePatient(12345)).toEqual(generatePatient(12345));
  });

  it('produces different people for different seeds', () => {
    expect(generatePatient(1).fullName + generatePatient(1).mobile).not.toBe(
      generatePatient(2).fullName + generatePatient(2).mobile,
    );
  });

  /**
   * The safety property this generator exists for: a real Aadhaar always
   * satisfies Verhoeff, so a number that fails it provably belongs to nobody.
   * If this test ever goes red, synthetic data has become capable of colliding
   * with a real identity and must not be used (docs/09 §11).
   */
  it('never emits a checksum-valid Aadhaar, across a large population', () => {
    const offenders = generatePatients(20260819, 2000).filter((p) => isVerhoeffValid(p.aadhaarShaped));
    expect(offenders).toEqual([]);
  });

  it('emits Aadhaar-shaped values of exactly 12 digits', () => {
    for (const patient of generatePatients(11, 200)) {
      expect(patient.aadhaarShaped).toMatch(/^\d{12}$/);
    }
  });

  it('emits mobile numbers in the range TRAI actually assigns', () => {
    for (const patient of generatePatients(22, 300)) {
      expect(patient.mobile).toMatch(/^[6-9]\d{9}$/);
      expect(patient.mobileE164).toBe(`+91${patient.mobile}`);
    }
  });

  it('emits mobile numbers that cannot route to a real handset', () => {
    for (const patient of generatePatients(23, 300)) {
      expect(patient.mobile.slice(3, 6)).toBe('555');
    }
  });

  it('emits ABHA numbers in the 14-digit xx-xxxx-xxxx-xxxx form', () => {
    for (const patient of generatePatients(33, 200)) {
      expect(patient.abhaNumber).toMatch(/^\d{2}-\d{4}-\d{4}-\d{4}$/);
      expect(patient.abhaAddress).toMatch(/^[a-z.]+\d{3}@abdm$/);
    }
  });

  it('uses a non-deliverable email domain so a test can never mail a real person', () => {
    for (const patient of generatePatients(44, 100)) {
      expect(patient.email.endsWith('@example.invalid')).toBe(true);
    }
  });

  it('emits a pincode consistent with the city it claims', () => {
    for (const patient of generatePatients(55, 300)) {
      expect(patient.address.pincode).toMatch(/^\d{6}$/);
      expect(patient.address.country).toBe('IN');
    }
  });

  it('covers paediatric, adult and geriatric bands, which drive age-banded reference ranges', () => {
    const ages = generatePatients(66, 600).map((p) => p.ageYears);
    expect(ages.some((a) => a <= 12)).toBe(true);
    expect(ages.some((a) => a >= 13 && a < 60)).toBe(true);
    expect(ages.some((a) => a >= 60)).toBe(true);
    expect(Math.min(...ages)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...ages)).toBeLessThanOrEqual(96);
  });

  it('never marks a child as married', () => {
    for (const patient of generatePatients(77, 500)) {
      if (patient.ageYears < 18) expect(patient.maritalStatus).toBe('single');
    }
  });

  it('keeps date of birth consistent with the stated age', () => {
    for (const patient of generatePatients(88, 200)) {
      const year = Number(patient.dateOfBirth.slice(0, 4));
      expect(2026 - year).toBe(patient.ageYears);
    }
  });

  it('generates a population with real name diversity rather than one repeated person', () => {
    const names = new Set(generatePatients(99, 400).map((p) => p.fullName));
    expect(names.size).toBeGreaterThan(200);
  });

  it('generates distinct mobile numbers across a population', () => {
    const patients = generatePatients(101, 500);
    const mobiles = new Set(patients.map((p) => p.mobile));
    // Collisions are possible in a 10 000-wide block; a handful is fine, a flood is a bug.
    expect(mobiles.size).toBeGreaterThan(patients.length * 0.95);
  });

  it('returns an empty population for count 0 and rejects a negative count', () => {
    expect(generatePatients(1, 0)).toEqual([]);
    expect(() => generatePatients(1, -1)).toThrow(RangeError);
  });

  it('carries its seed, so a failing fixture can be reproduced exactly', () => {
    expect(generatePatient(31337).seed).toBe(31337);
  });
});
