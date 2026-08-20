import { createHash } from 'node:crypto';
import { seedChoice, seedId, seedPick } from './ids.js';

/**
 * Synthetic Indian patients, generated inside `@vims/db`.
 *
 * `@vims/testing` already has `generatePatients`, and it is better than this
 * one — but `@vims/testing` depends on `@vims/db`, so importing it here would
 * make the Turborepo graph cyclic and `turbo run build` would refuse to run.
 * The `activity.ts` header says exactly this and predicted that the Phase-1
 * seeder would need its own. This is that generator, built on the same
 * `seedPick`/`seedChoice` hashing the rest of the seeds use, so a patient is a
 * pure function of `(hospitalCode, index)` and the millionth row is identical
 * on every machine and on every run.
 *
 * Deliberately realistic in *shape* and impossible in *identity*:
 *
 *   * Mobile numbers use a TRAI-assigned leading digit (6–9) but are drawn from
 *     the `555xxxx` block, mirroring the reserved-for-fiction convention, so a
 *     number can never route to a real handset.
 *   * Aadhaar is never generated at all — only a peppered SHA-256 over a
 *     synthetic string and four digits that are not from a real number. There
 *     is nothing here to leak.
 *   * ABHA numbers are 14 digits in the real `xx-xxxx-xxxx-xxxx` format, inside
 *     a range the ABDM sandbox does not issue.
 *
 * Names come from several Indian linguistic regions rather than one, because a
 * single-region population does not exercise the thing that actually breaks
 * patient search: trigram behaviour across transliterated surnames.
 */

const GIVEN_MALE = [
  'Arjun', 'Rahul', 'Vikram', 'Karthik', 'Suresh', 'Ramesh', 'Anand', 'Prakash',
  'Manoj', 'Deepak', 'Sanjay', 'Rajesh', 'Venkatesh', 'Murugan', 'Selvam', 'Ravi',
  'Ashok', 'Mahesh', 'Naveen', 'Hari', 'Imran', 'Faisal', 'Abdul', 'Joseph',
  'Thomas', 'Gurpreet', 'Harjit', 'Sourav', 'Amit', 'Nitin', 'Balaji', 'Sridhar',
] as const;

const GIVEN_FEMALE = [
  'Priya', 'Lakshmi', 'Divya', 'Meena', 'Kavitha', 'Anitha', 'Sunita', 'Radha',
  'Geetha', 'Shalini', 'Deepa', 'Revathi', 'Padma', 'Vani', 'Bhavani', 'Nandini',
  'Fatima', 'Ayesha', 'Mary', 'Elizabeth', 'Simran', 'Manpreet', 'Rupa', 'Sneha',
  'Aarthi', 'Vidya', 'Chitra', 'Jayanthi', 'Pooja', 'Rekha', 'Swathi', 'Usha',
] as const;

const FAMILY = [
  'Sharma', 'Verma', 'Iyer', 'Iyengar', 'Nair', 'Menon', 'Pillai', 'Reddy',
  'Naidu', 'Rao', 'Gowda', 'Shetty', 'Hegde', 'Kulkarni', 'Deshpande', 'Patil',
  'Joshi', 'Bhat', 'Das', 'Ghosh', 'Chatterjee', 'Banerjee', 'Singh', 'Kaur',
  'Khan', 'Sheikh', 'Ansari', 'D Souza', 'Fernandes', 'Pereira', 'Patel', 'Shah',
  'Subramanian', 'Krishnan', 'Balakrishnan', 'Muthu', 'Selvaraj', 'Ramalingam',
] as const;

const BLOOD_GROUPS = ['a_pos', 'a_neg', 'b_pos', 'b_neg', 'ab_pos', 'ab_neg', 'o_pos', 'o_neg'] as const;
const MARITAL = ['single', 'married', 'widowed', 'divorced'] as const;
const LANGUAGES = ['en-IN', 'hi', 'kn', 'ta', 'te', 'ml', 'mr'] as const;
const CHANNELS = ['counter', 'kiosk', 'online', 'app', 'call_centre', 'camp'] as const;

/** Pincode prefix, city, district, state, GST state code. */
const LOCALITIES: readonly (readonly [string, string, string, string, string])[] = [
  ['5600', 'Bengaluru', 'Bengaluru Urban', 'Karnataka', '29'],
  ['5700', 'Mysuru', 'Mysuru', 'Karnataka', '29'],
  ['6000', 'Chennai', 'Chennai', 'Tamil Nadu', '33'],
  ['5000', 'Hyderabad', 'Hyderabad', 'Telangana', '36'],
  ['6820', 'Kochi', 'Ernakulam', 'Kerala', '32'],
  ['4000', 'Mumbai', 'Mumbai Suburban', 'Maharashtra', '27'],
];

const STREETS = [
  'MG Road', 'Residency Road', 'Bannerghatta Road', 'Anna Salai', 'Sardar Patel Road',
  'Gandhi Bazaar', 'Church Street', 'Temple Street', 'Station Road', 'Hospital Road',
] as const;

const OCCUPATIONS = ['FARMER', 'TEACHER', 'DRIVER', 'CLERK', 'ENGINEER', 'HOMEMAKER', 'STUDENT', 'RETIRED', 'LABOUR', 'BUSINESS'] as const;
const RELIGIONS = ['HINDU', 'MUSLIM', 'CHRISTIAN', 'SIKH', 'JAIN', 'BUDDHIST', 'OTHER'] as const;
const ID_TYPES = ['AADHAAR', 'PAN', 'PASSPORT', 'VOTER', 'DL'] as const;

export interface SyntheticPatient {
  readonly index: number;
  readonly titleCode: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly fullName: string;
  readonly gender: 'male' | 'female' | 'other';
  /** ISO `YYYY-MM-DD`. */
  readonly dob: string;
  readonly ageYears: number;
  readonly bloodGroup: string;
  readonly maritalStatus: string;
  /** Ten digits, no country code — what a receptionist types. */
  readonly mobileLocal: string;
  /** E.164. */
  readonly mobile: string;
  readonly email: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
  readonly city: string;
  readonly district: string;
  readonly state: string;
  readonly pincode: string;
  readonly language: string;
  readonly occupationCode: string;
  readonly religionCode: string;
  readonly idTypeCode: string;
  readonly idLast4: string;
  readonly hasAadhaar: boolean;
  readonly aadhaarLast4: string | null;
  readonly aadhaarHash: Buffer | null;
  readonly abhaNumber: string | null;
  readonly abhaAddress: string | null;
  readonly sourceChannel: string;
  readonly category: string;
  readonly isSenior: boolean;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/**
 * The pepper is a fixed, obviously-synthetic string. Production derives it per
 * hospital from the KMS (`patients.aadhaar_hash_key_version` names which key),
 * but a seed must be reproducible, and a seeded hash must never be a hash a
 * real Aadhaar could produce.
 */
const SEED_AADHAAR_PEPPER = 'vims-seed-pepper-not-a-real-key';

export function syntheticPatient(hospitalCode: string, index: number): SyntheticPatient {
  const key = `${hospitalCode}|${index}`;
  const genderRoll = seedPick(100, key, 'gender');
  const gender: 'male' | 'female' | 'other' = genderRoll < 49 ? 'male' : genderRoll < 99 ? 'female' : 'other';
  const firstName = gender === 'male'
    ? seedChoice(GIVEN_MALE, key, 'given')
    : seedChoice(GIVEN_FEMALE, key, 'given');
  const lastName = seedChoice(FAMILY, key, 'family');

  // Weighted towards the adult band a general hospital sees, with real
  // paediatric and geriatric tails so age-banded rules are genuinely exercised.
  const ageRoll = seedPick(100, key, 'age-band');
  const ageYears = ageRoll < 14
    ? seedPick(13, key, 'age-child')
    : ageRoll < 34
      ? 60 + seedPick(36, key, 'age-senior')
      : 13 + seedPick(47, key, 'age-adult');

  const birthYear = 2026 - ageYears;
  const dob = `${birthYear}-${pad(1 + seedPick(12, key, 'dob-m'), 2)}-${pad(1 + seedPick(28, key, 'dob-d'), 2)}`;

  const locality = LOCALITIES[seedPick(LOCALITIES.length, key, 'locality')] ?? LOCALITIES[0];
  if (locality === undefined) throw new Error('unreachable: LOCALITIES is non-empty');
  const mobileLocal = `${6 + seedPick(4, key, 'mob-lead')}${pad(seedPick(100, key, 'mob-a'), 2)}555${pad(seedPick(10_000, key, 'mob-b'), 4)}`;

  const titleCode = ageYears < 2
    ? 'BABY'
    : gender === 'male'
      ? (ageYears < 15 ? 'MASTER' : 'MR')
      : (ageYears < 15 || seedPick(2, key, 'ms') === 0 ? 'MS' : 'MRS');

  const abhaDigits =
    `${pad(90 + seedPick(10, key, 'abha-a'), 2)}${pad(seedPick(10_000, key, 'abha-b'), 4)}` +
    `${pad(seedPick(10_000, key, 'abha-c'), 4)}${pad(seedPick(10_000, key, 'abha-d'), 4)}`;
  // Roughly a third of patients have a linked ABHA — the realistic 2026 figure,
  // and the one that makes the partial index on `abha_number` worth measuring.
  const hasAbha = seedPick(3, key, 'abha?') === 0;
  const slug = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '');

  const idTypeCode = seedChoice(ID_TYPES, key, 'idtype');
  const hasAadhaar = idTypeCode === 'AADHAAR';
  const aadhaarLast4 = hasAadhaar ? pad(seedPick(10_000, key, 'aadhaar'), 4) : null;

  return {
    index,
    titleCode,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    gender,
    dob,
    ageYears,
    bloodGroup: seedChoice(BLOOD_GROUPS, key, 'blood'),
    maritalStatus: ageYears < 18 ? 'single' : seedChoice(MARITAL, key, 'marital'),
    mobileLocal,
    mobile: `+91${mobileLocal}`,
    email: `${slug}.${pad(index % 100_000, 6)}@example.invalid`,
    addressLine1: `${1 + seedPick(240, key, 'door')}, ${seedChoice(STREETS, key, 'street')}`,
    addressLine2: `${seedChoice(['Ward', 'Post', 'Village', 'Colony'] as const, key, 'a2')} ${1 + seedPick(40, key, 'a2n')}`,
    city: locality[1],
    district: locality[2],
    state: locality[3],
    pincode: `${locality[0]}${pad(seedPick(100, key, 'pin'), 2)}`,
    language: seedChoice(LANGUAGES, key, 'lang'),
    occupationCode: ageYears < 18 ? 'STUDENT' : ageYears >= 60 ? 'RETIRED' : seedChoice(OCCUPATIONS, key, 'occ'),
    religionCode: seedChoice(RELIGIONS, key, 'religion'),
    idTypeCode,
    idLast4: pad(seedPick(10_000, key, 'idlast4'), 4),
    hasAadhaar,
    aadhaarLast4,
    aadhaarHash: hasAadhaar
      ? createHash('sha256').update(`${SEED_AADHAAR_PEPPER}|${key}|${aadhaarLast4 ?? ''}`).digest()
      : null,
    abhaNumber: hasAbha
      ? `${abhaDigits.slice(0, 2)}-${abhaDigits.slice(2, 6)}-${abhaDigits.slice(6, 10)}-${abhaDigits.slice(10, 14)}`
      : null,
    abhaAddress: hasAbha ? `${slug}${pad(index % 1000, 3)}@sbx` : null,
    sourceChannel: seedChoice(CHANNELS, key, 'channel'),
    category: ageYears >= 60 ? 'senior_citizen' : ageYears < 1 ? 'infant' : 'general',
    isSenior: ageYears >= 60,
  };
}

/**
 * OP-001 §5: "exact ABHA/Aadhaar-hash = 1.0; mobile+DOB = 0.9". The
 * deterministic half of duplicate detection is a digest of the normalised
 * identity, precomputed so an exact collision is an index probe rather than a
 * scan — which is what keeps duplicate detection inside the 400 ms
 * registration budget.
 */
export function dedupeFingerprint(patient: SyntheticPatient): string {
  return createHash('sha256')
    .update([
      patient.mobileLocal,
      patient.dob,
      `${patient.firstName} ${patient.lastName}`.toUpperCase().replace(/[^A-Z]/g, ''),
      patient.gender,
    ].join('|'))
    .digest('hex')
    .slice(0, 40);
}

/** A stable synthetic UHID in the seeded `{BR}{SEQ:8}` pattern. */
export function syntheticUhid(branchShortCode: string, index: number): string {
  return `${branchShortCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}${pad(index + 1, 8)}`;
}

/** The uuid a seeded patient always has. */
export function patientSeedId(hospitalCode: string, index: number): string {
  return seedId('patient', hospitalCode, String(index));
}
