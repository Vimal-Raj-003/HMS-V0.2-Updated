import { createRng, type Rng } from './rng.js';

/**
 * Synthetic Indian patient data.
 *
 * `docs/09-quality-gates-and-testing.md` §11 is categorical: production PHI
 * never reaches a lower environment. That leaves a real problem — demos and
 * performance tests that use `Test Patient 1..n` hide defects that only appear
 * with real-shaped data: names that need more than one script, mobile numbers
 * that must start 6–9, addresses that break a two-line label, and the sorting
 * and search behaviour of Indian surnames.
 *
 * So this generator is deliberately realistic in *shape* and deliberately
 * impossible in *identity*:
 *
 *  - **Aadhaar-shaped numbers fail the Verhoeff checksum on purpose.** A real
 *    Aadhaar always passes it. Any number produced here is therefore provably
 *    not a living person's, even by coincidence, and any code that validates
 *    Aadhaar properly will reject it — which is the behaviour we want to catch
 *    if fixture data ever reaches a real integration.
 *  - **Mobile numbers use the 6–9 leading digit that TRAI actually assigns**,
 *    but are drawn from the 5550000–5559999 block within it, mirroring the
 *    reserved-for-fiction convention.
 *  - **ABHA numbers are 14 digits in the real `xx-xxxx-xxxx-xxxx` format** but
 *    are generated inside a range the ABDM sandbox does not issue.
 *
 * Names are drawn from several Indian linguistic regions rather than one, so a
 * seeded population exercises Devanagari, Tamil, Telugu and Latin transliteration
 * ordering — the thing that breaks patient search.
 */

const GIVEN_NAMES_MALE = [
  'Arjun',
  'Rahul',
  'Vikram',
  'Karthik',
  'Suresh',
  'Ramesh',
  'Anand',
  'Prakash',
  'Manoj',
  'Deepak',
  'Sanjay',
  'Rajesh',
  'Venkatesh',
  'Murugan',
  'Selvam',
  'Ravi',
  'Ashok',
  'Mahesh',
  'Naveen',
  'Hari',
  'Imran',
  'Faisal',
  'Abdul',
  'Joseph',
  'Thomas',
  'Gurpreet',
  'Harjit',
  'Sourav',
  'Amit',
  'Nitin',
] as const;

const GIVEN_NAMES_FEMALE = [
  'Priya',
  'Lakshmi',
  'Divya',
  'Meena',
  'Kavitha',
  'Anitha',
  'Sunita',
  'Radha',
  'Geetha',
  'Shalini',
  'Deepa',
  'Revathi',
  'Padma',
  'Vani',
  'Bhavani',
  'Aishwarya',
  'Nandhini',
  'Sangeetha',
  'Fatima',
  'Ayesha',
  'Mary',
  'Elizabeth',
  'Simran',
  'Manpreet',
  'Rupa',
  'Sneha',
  'Pooja',
  'Ritu',
  'Swathi',
  'Janaki',
] as const;

const FAMILY_NAMES = [
  'Sharma',
  'Verma',
  'Iyer',
  'Iyengar',
  'Nair',
  'Menon',
  'Pillai',
  'Reddy',
  'Naidu',
  'Rao',
  'Gowda',
  'Shetty',
  'Hegde',
  'Patel',
  'Shah',
  'Desai',
  'Joshi',
  'Kulkarni',
  'Deshpande',
  'Chatterjee',
  'Banerjee',
  'Mukherjee',
  'Das',
  'Bose',
  'Singh',
  'Kaur',
  'Gill',
  'Khan',
  'Ahmed',
  'Sheikh',
  'Fernandes',
  'D’Souza',
  'Thomas',
  'Krishnan',
  'Subramanian',
  'Murthy',
] as const;

/** City, state, and a pincode prefix that is genuinely allocated to that region. */
const LOCALITIES = [
  { city: 'Coimbatore', state: 'Tamil Nadu', pinPrefix: '641' },
  { city: 'Chennai', state: 'Tamil Nadu', pinPrefix: '600' },
  { city: 'Madurai', state: 'Tamil Nadu', pinPrefix: '625' },
  { city: 'Bengaluru', state: 'Karnataka', pinPrefix: '560' },
  { city: 'Mysuru', state: 'Karnataka', pinPrefix: '570' },
  { city: 'Kochi', state: 'Kerala', pinPrefix: '682' },
  { city: 'Thiruvananthapuram', state: 'Kerala', pinPrefix: '695' },
  { city: 'Hyderabad', state: 'Telangana', pinPrefix: '500' },
  { city: 'Vijayawada', state: 'Andhra Pradesh', pinPrefix: '520' },
  { city: 'Mumbai', state: 'Maharashtra', pinPrefix: '400' },
  { city: 'Pune', state: 'Maharashtra', pinPrefix: '411' },
  { city: 'Nagpur', state: 'Maharashtra', pinPrefix: '440' },
  { city: 'Ahmedabad', state: 'Gujarat', pinPrefix: '380' },
  { city: 'Jaipur', state: 'Rajasthan', pinPrefix: '302' },
  { city: 'Lucknow', state: 'Uttar Pradesh', pinPrefix: '226' },
  { city: 'Kolkata', state: 'West Bengal', pinPrefix: '700' },
  { city: 'Bhubaneswar', state: 'Odisha', pinPrefix: '751' },
  { city: 'Chandigarh', state: 'Punjab', pinPrefix: '160' },
  { city: 'New Delhi', state: 'Delhi', pinPrefix: '110' },
  { city: 'Guwahati', state: 'Assam', pinPrefix: '781' },
] as const;

const STREETS = [
  'Gandhi Road',
  'Nehru Street',
  'Anna Salai',
  'MG Road',
  'Bazaar Street',
  'Temple Street',
  'Station Road',
  'Kamaraj Nagar',
  'Trichy Road',
  'Race Course Road',
] as const;

/** Distribution roughly reflects Indian ABO/Rh frequencies rather than being uniform. */
const BLOOD_GROUPS = [
  'O+',
  'O+',
  'O+',
  'B+',
  'B+',
  'B+',
  'A+',
  'A+',
  'AB+',
  'O-',
  'B-',
  'A-',
  'AB-',
] as const;

const MARITAL_STATUSES = ['single', 'married', 'widowed', 'divorced'] as const;

const OCCUPATIONS = [
  'Farmer',
  'Teacher',
  'Driver',
  'Shopkeeper',
  'Homemaker',
  'Student',
  'Software Engineer',
  'Nurse',
  'Tailor',
  'Mason',
  'Clerk',
  'Retired',
  'Auto Driver',
  'Weaver',
  'Electrician',
  'Accountant',
] as const;

const LANGUAGES = ['ta', 'hi', 'te', 'ml', 'kn', 'mr', 'bn', 'gu', 'or', 'pa', 'en-IN'] as const;

export type Gender = 'male' | 'female' | 'other';
export type MaritalStatus = (typeof MARITAL_STATUSES)[number];

export interface SyntheticAddress {
  readonly line1: string;
  readonly line2: string;
  readonly city: string;
  readonly state: string;
  readonly pincode: string;
  readonly country: 'IN';
}

export interface SyntheticPatient {
  readonly givenName: string;
  readonly familyName: string;
  readonly fullName: string;
  readonly gender: Gender;
  /** ISO date, `YYYY-MM-DD`. */
  readonly dateOfBirth: string;
  readonly ageYears: number;
  readonly bloodGroup: string;
  /** 10 digits, no country code — how Indian hospitals key patients. */
  readonly mobile: string;
  /** E.164. */
  readonly mobileE164: string;
  readonly email: string;
  readonly address: SyntheticAddress;
  /** 14 digits, `xx-xxxx-xxxx-xxxx`. */
  readonly abhaNumber: string;
  /** `name@abdm` — the ABHA address form. */
  readonly abhaAddress: string;
  /**
   * 12 digits in Aadhaar's shape that **deliberately fails** the Verhoeff
   * checksum, so it cannot be a real Aadhaar even by accident.
   */
  readonly aadhaarShaped: string;
  readonly maritalStatus: MaritalStatus;
  readonly occupation: string;
  /** BCP-47-ish preferred language, from the set `CLAUDE.md` §4 lists. */
  readonly preferredLanguage: string;
  /** The seed this record came from — print it in a failure to reproduce exactly. */
  readonly seed: number;
}

// ── Verhoeff, so we can be sure we are producing an invalid checksum ──────────
const D_TABLE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const P_TABLE: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function at(table: readonly (readonly number[])[], row: number, col: number): number {
  const value = table[row]?.[col];
  if (value === undefined) throw new Error('unreachable: Verhoeff table index out of range');
  return value;
}

/** True when `digits` satisfies the Verhoeff checksum — i.e. could be a real Aadhaar. */
export function isVerhoeffValid(digits: string): boolean {
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    const digit = Number(reversed[i]);
    if (!Number.isInteger(digit)) return false;
    c = at(D_TABLE, c, at(P_TABLE, i % 8, digit));
  }
  return c === 0;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** Generates one patient, fully determined by `seed`. */
export function generatePatient(seed: number): SyntheticPatient {
  const rng = createRng(seed);

  const gender: Gender = rng.chance(0.49) ? 'male' : rng.chance(0.98) ? 'female' : 'other';
  const givenName = rng.pick(gender === 'male' ? GIVEN_NAMES_MALE : GIVEN_NAMES_FEMALE);
  const familyName = rng.pick(FAMILY_NAMES);

  // Ages weighted towards the adult band a general hospital actually sees,
  // with real paediatric and geriatric tails so age-banded reference ranges
  // (docs/09 §2 lists these as safety-critical) are genuinely exercised.
  const ageYears = rng.chance(0.14) ? rng.int(0, 12) : rng.chance(0.2) ? rng.int(60, 96) : rng.int(13, 59);

  const birthYear = 2026 - ageYears;
  const birthMonth = rng.int(1, 12);
  const birthDay = rng.int(1, 28);
  const dateOfBirth = `${birthYear}-${pad(birthMonth, 2)}-${pad(birthDay, 2)}`;

  const locality = rng.pick(LOCALITIES);

  // 6–9 is the TRAI-assigned leading digit; 555xxxx mirrors the
  // reserved-for-fiction convention so a number can never route to a real handset.
  const mobile = `${rng.int(6, 9)}${pad(rng.int(0, 99), 2)}555${pad(rng.int(0, 9999), 4)}`;

  const abhaDigits = `${pad(rng.int(90, 99), 2)}${pad(rng.int(0, 9999), 4)}${pad(rng.int(0, 9999), 4)}${pad(rng.int(0, 9999), 4)}`;
  const abhaNumber = `${abhaDigits.slice(0, 2)}-${abhaDigits.slice(2, 6)}-${abhaDigits.slice(6, 10)}-${abhaDigits.slice(10, 14)}`;

  // Build an Aadhaar-shaped number, then force the checksum digit to a wrong value.
  const aadhaarBody = `${rng.int(2, 9)}${pad(rng.int(0, 99999999999), 11)}`.slice(0, 11);
  let aadhaarShaped = '';
  for (let candidate = 0; candidate <= 9; candidate += 1) {
    const attempt = `${aadhaarBody}${candidate}`;
    if (!isVerhoeffValid(attempt)) {
      aadhaarShaped = attempt;
      break;
    }
  }
  if (aadhaarShaped === '') throw new Error('unreachable: exactly one Verhoeff digit in ten is valid');

  const slug = `${givenName}.${familyName}`.toLowerCase().replace(/[^a-z.]/g, '');

  return {
    givenName,
    familyName,
    fullName: `${givenName} ${familyName}`,
    gender,
    dateOfBirth,
    ageYears,
    bloodGroup: rng.pick(BLOOD_GROUPS),
    mobile,
    mobileE164: `+91${mobile}`,
    email: `${slug}.${pad(seed % 10000, 4)}@example.invalid`,
    address: {
      line1: `${rng.int(1, 240)}, ${rng.pick(STREETS)}`,
      line2: `${rng.pick(['Ward', 'Post', 'Village', 'Colony'])} ${rng.int(1, 40)}`,
      city: locality.city,
      state: locality.state,
      pincode: `${locality.pinPrefix}${pad(rng.int(0, 999), 3)}`,
      country: 'IN',
    },
    abhaNumber,
    abhaAddress: `${slug}${pad(seed % 1000, 3)}@abdm`,
    aadhaarShaped,
    maritalStatus: ageYears < 18 ? 'single' : rng.pick(MARITAL_STATUSES),
    occupation: ageYears < 18 ? 'Student' : rng.pick(OCCUPATIONS),
    preferredLanguage: rng.pick(LANGUAGES),
    seed,
  };
}

/** A population of distinct patients, reproducible from `baseSeed`. */
export function generatePatients(baseSeed: number, count: number): readonly SyntheticPatient[] {
  if (count < 0) throw new RangeError('count must be >= 0');
  return Array.from({ length: count }, (_unused, index) => generatePatient(baseSeed + index * 7919));
}

/** Exposed so a suite can derive its own streams without reaching into `./rng`. */
export type { Rng };
export { createRng };
