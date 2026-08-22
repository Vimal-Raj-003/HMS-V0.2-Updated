import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_BLOCK_THRESHOLD,
  abhaNumberVariants,
  blocksRegistration,
  composeFullName,
  dedupeFingerprint,
  dobWithinOneYear,
  isE164,
  normaliseAbhaAddress,
  normaliseIdentifierValue,
  normaliseMobile,
  normaliseNameKey,
  normaliseUhid,
  resolveBirth,
  scoreDuplicate,
  type DuplicateSignals,
} from './patient.identity.js';

/**
 * The rules a hospital will argue about, executed on a table of examples.
 *
 * Each block below corresponds to a sentence in OP-001 §5, and the test is
 * written so that removing the behaviour breaks it — a scoring test that only
 * asserts "returns a number" would pass against a function that always returned
 * one.
 */

const NONE: DuplicateSignals = {
  abhaNumberMatch: false,
  abhaAddressMatch: false,
  aadhaarHashMatch: false,
  fingerprintMatch: false,
  mobileMatch: false,
  dobExactMatch: false,
  dobWithinOneYear: false,
  genderMatch: false,
  nameSimilarity: 0,
};

describe('name normalisation', () => {
  it('folds the three things that differ between two spellings of one person', () => {
    // Case, punctuation and spacing — and nothing else.
    expect(normaliseNameKey("D'Souza", 'Fernandes')).toBe('DSOUZAFERNANDES');
    expect(normaliseNameKey('d souza', ' fernandes ')).toBe('DSOUZAFERNANDES');
  });

  it('tolerates a patient with no family name, which is common in south India', () => {
    expect(normaliseNameKey('Muthulakshmi', null)).toBe('MUTHULAKSHMI');
    expect(normaliseNameKey('Muthulakshmi', undefined)).toBe('MUTHULAKSHMI');
  });

  it('keeps the title out of the printed name', () => {
    expect(composeFullName({ firstName: 'Asha', lastName: 'Rao' })).toBe('Asha Rao');
    expect(composeFullName({ firstName: 'Asha', middleName: 'K', lastName: 'Rao' })).toBe('Asha K Rao');
    expect(composeFullName({ firstName: 'Asha', middleName: '  ', lastName: null })).toBe('Asha');
  });
});

describe('UHID and identifier normalisation', () => {
  it('accepts what a receptionist types, not only what was printed', () => {
    expect(normaliseUhid('blr-a/000 0123')).toBe('BLRA0000123');
    expect(normaliseUhid('BLRA0000123')).toBe('BLRA0000123');
  });

  it('keeps the shape of an ABHA address but not its case', () => {
    expect(normaliseAbhaAddress('  Asha.Rao001@SBX ')).toBe('asha.rao001@sbx');
    expect(normaliseIdentifierValue('p1234567')).toBe('P1234567');
  });

  it('enumerates the spellings of one ABHA number so the probe can stay an equality', () => {
    const variants = abhaNumberVariants('91-1234-5678-9012');
    expect(variants).toContain('91-1234-5678-9012');
    expect(variants).toContain('91123456789012');
    // A caller who typed only digits gets the hyphenated stored form back too.
    expect(abhaNumberVariants('91123456789012')).toContain('91-1234-5678-9012');
  });
});

describe('mobile normalisation', () => {
  it.each([
    ['9845012345', '+919845012345', '9845012345'],
    ['09845012345', '+919845012345', '9845012345'],
    ['+91 98450 12345', '+919845012345', '9845012345'],
    ['919845012345', '+919845012345', '9845012345'],
    ['+91-98450-12345', '+919845012345', '9845012345'],
  ])('normalises %s to %s', (input, e164, local) => {
    expect(normaliseMobile(input)).toEqual({ e164, local });
  });

  it('does not re-home a foreign number to India', () => {
    // +971 is the UAE. Prefixing it with 91 would send the patient's OTP to a
    // stranger in Bengaluru.
    expect(normaliseMobile('+971501234567').e164).toBe('+971501234567');
  });

  it('produces something the database CHECK will accept', () => {
    expect(isE164(normaliseMobile('9845012345').e164)).toBe(true);
    expect(isE164('9845012345')).toBe(false);
    expect(isE164('+0845012345')).toBe(false);
  });
});

describe('age and date of birth (OP-001 §5)', () => {
  const today = new Date('2026-08-22T00:00:00Z');

  it('keeps a real date of birth as given and does not flag it estimated', () => {
    expect(resolveBirth('1988-03-04', {}, today)).toEqual({
      dob: '1988-03-04',
      dobIsEstimated: false,
      ageYears: null,
      ageMonths: null,
      ageDays: null,
    });
  });

  it('estimates an age-only patient to 1 January and says so', () => {
    const resolved = resolveBirth(undefined, { ageYears: 38 }, today);
    expect(resolved.dob).toBe('1988-01-01');
    expect(resolved.dobIsEstimated).toBe(true);
    // The captured age survives alongside the estimate, so a report can exclude
    // estimated rows rather than averaging them in.
    expect(resolved.ageYears).toBe(38);
  });

  it('dates a neonate from its age in days rather than to 1 January', () => {
    const resolved = resolveBirth(undefined, { ageDays: 2 }, today);
    expect(resolved.dob).toBe('2026-08-20');
    expect(resolved.ageDays).toBe(2);
  });

  it('returns no date when there is no basis for one, so the caller can refuse', () => {
    expect(resolveBirth(undefined, {}, today).dob).toBeNull();
  });
});

describe('dedupe fingerprint', () => {
  it('matches the recipe the database seed uses, byte for byte', () => {
    // Pinned, not merely shaped. `packages/db/src/seed/synthetic.ts` computes
    //   sha256("<mobileLocal>|<dob>|<NAMEKEY>|<gender>").hex.slice(0, 40)
    // and does not export it, so this is the only place the two can be held
    // together. If they ever diverge, a seeded or imported patient and one
    // registered through the API stop matching on the deterministic 0.9 rule —
    // silently, and only for half the MPI.
    const digest = dedupeFingerprint({
      mobileLocal: '9845012345',
      dob: '1988-03-04',
      firstName: 'Asha',
      lastName: 'Rao',
      gender: 'female',
    });
    expect(digest).toBe('381cac721c1fae29926cecd4ff74fb53f7bc7ae7');
  });

  it('is stable across the spellings normalisation folds away', () => {
    const base = {
      mobileLocal: '9845012345',
      dob: '1988-03-04',
      gender: 'female' as const,
    };
    expect(dedupeFingerprint({ ...base, firstName: 'Asha', lastName: 'Rao' })).toBe(
      dedupeFingerprint({ ...base, firstName: ' asha ', lastName: 'r a o' }),
    );
  });

  it('changes when any component of identity changes', () => {
    const base = {
      mobileLocal: '9845012345',
      dob: '1988-03-04',
      firstName: 'Asha',
      lastName: 'Rao',
      gender: 'female',
    };
    const original = dedupeFingerprint(base);
    expect(dedupeFingerprint({ ...base, gender: 'male' })).not.toBe(original);
    expect(dedupeFingerprint({ ...base, dob: '1988-03-05' })).not.toBe(original);
    expect(dedupeFingerprint({ ...base, mobileLocal: '9845012346' })).not.toBe(original);
    expect(dedupeFingerprint({ ...base, lastName: 'Rai' })).not.toBe(original);
  });
});

describe('duplicate scoring (OP-001 §5)', () => {
  it('scores an exact ABHA at 1.0', () => {
    const result = scoreDuplicate({ ...NONE, abhaNumberMatch: true });
    expect(result.score).toBe(1);
    expect(result.ruleHits).toContain('abha_number_exact');
  });

  it('scores an exact Aadhaar digest at 1.0', () => {
    expect(scoreDuplicate({ ...NONE, aadhaarHashMatch: true }).score).toBe(1);
  });

  it('scores mobile + DOB at 0.9', () => {
    const result = scoreDuplicate({ ...NONE, mobileMatch: true, dobExactMatch: true });
    expect(result.score).toBe(0.9);
    expect(result.ruleHits).toEqual(['mobile_dob']);
  });

  it('does not score a shared family mobile on its own', () => {
    // OP-001 §5 explicitly allows one mobile across a family; matching on it
    // alone would block every second child registered on a parent's number.
    expect(scoreDuplicate({ ...NONE, mobileMatch: true }).score).toBe(0);
  });

  it('scores name ≥ 0.6 with gender and DOB ± 1 year at 0.85', () => {
    const result = scoreDuplicate({
      ...NONE,
      nameSimilarity: 0.62,
      genderMatch: true,
      dobWithinOneYear: true,
    });
    expect(result.score).toBe(0.85);
    expect(result.ruleHits).toEqual(['name_trgm_gender_dob']);
  });

  it('holds the 0.6 name floor exactly', () => {
    const at = { ...NONE, nameSimilarity: 0.6, genderMatch: true, dobWithinOneYear: true };
    expect(scoreDuplicate(at).score).toBe(0.85);
    expect(scoreDuplicate({ ...at, nameSimilarity: 0.599 }).score).toBe(0);
  });

  it('needs all three parts of the 0.85 rule, not two of them', () => {
    const full = { ...NONE, nameSimilarity: 0.9, genderMatch: true, dobWithinOneYear: true };
    expect(scoreDuplicate({ ...full, genderMatch: false }).score).toBe(0);
    expect(scoreDuplicate({ ...full, dobWithinOneYear: false }).score).toBe(0);
  });

  it('takes the maximum of the rules that fire, never their sum', () => {
    // A real duplicate fires several rules at once. Adding them would push
    // every twin, and every parent and child on one number, over 1.0.
    const result = scoreDuplicate({
      ...NONE,
      fingerprintMatch: true,
      mobileMatch: true,
      dobExactMatch: true,
      nameSimilarity: 0.95,
      genderMatch: true,
      dobWithinOneYear: true,
    });
    expect(result.score).toBe(0.9);
    expect(result.ruleHits).toHaveLength(3);
  });

  it('keeps every rule that fired as evidence for the MRD officer', () => {
    const result = scoreDuplicate({ ...NONE, abhaNumberMatch: true, fingerprintMatch: true });
    expect(result.ruleHits).toEqual(['abha_number_exact', 'dedupe_fingerprint_exact']);
  });

  it('blocks at the threshold and not below it', () => {
    expect(DUPLICATE_BLOCK_THRESHOLD).toBe(0.85);
    expect(blocksRegistration(0.85)).toBe(true);
    expect(blocksRegistration(0.9)).toBe(true);
    expect(blocksRegistration(0.849)).toBe(false);
    expect(blocksRegistration(0)).toBe(false);
  });
});

describe('DOB ± 1 year tolerance', () => {
  it('accepts a year either side and refuses more', () => {
    expect(dobWithinOneYear('1988-03-04', '1988-03-04')).toBe(true);
    expect(dobWithinOneYear('1988-03-04', '1989-03-04')).toBe(true);
    expect(dobWithinOneYear('1988-03-04', '1987-03-04')).toBe(true);
    expect(dobWithinOneYear('1988-03-04', '1990-03-04')).toBe(false);
  });

  it('cannot fire when either date is unknown, which under-detects rather than over-blocks', () => {
    expect(dobWithinOneYear(null, '1988-03-04')).toBe(false);
    expect(dobWithinOneYear('1988-03-04', null)).toBe(false);
  });
});
