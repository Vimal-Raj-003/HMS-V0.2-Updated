import { createHash } from 'node:crypto';

/**
 * The pure half of the Master Patient Index (OP-001 §5).
 *
 * Everything here is a total function of its arguments: no database, no clock
 * of its own, no request context. That is deliberate — duplicate scoring and
 * name/mobile normalisation are the two pieces of this module whose behaviour a
 * hospital will argue about, and an argument is only settleable if the rule can
 * be executed on a table of examples. `patient.identity.spec.ts` is that table.
 *
 * The one place the outside world leaks in is `nameSimilarity`: trigram
 * similarity is computed by PostgreSQL (`ext.similarity()`), because computing
 * it in TypeScript would be a *second*, subtly different implementation of the
 * thing the index is built on, and the two would disagree exactly when it
 * mattered. So the score function takes the number and does not produce it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The name key used for the deterministic fingerprint.
 *
 * Upper-cased and stripped to A–Z, which folds away the three things that
 * genuinely differ between two spellings of the same person at a busy desk:
 * case, punctuation (`D'Souza` / `DSouza`) and spacing. It deliberately does
 * **not** fold accents or transliterate — `packages/db`'s seed uses the same
 * recipe, and the two must agree or a seeded patient and an API-registered one
 * would never match on the deterministic rule.
 */
export function normaliseNameKey(firstName: string, lastName: string | null | undefined): string {
  return `${firstName} ${lastName ?? ''}`.toUpperCase().replace(/[^A-Z]/g, '');
}

/**
 * The printed name. Title is excluded on purpose: `Mr` is not part of anyone's
 * name, it changes with marital status, and it would make two records of the
 * same person compare unequal.
 */
export function composeFullName(parts: {
  readonly firstName: string;
  readonly middleName?: string | null | undefined;
  readonly lastName?: string | null | undefined;
}): string {
  return [parts.firstName, parts.middleName, parts.lastName]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim())
    .join(' ');
}

/**
 * `patients.uhid_normalised` — upper-cased, punctuation-stripped.
 *
 * A receptionist types what they remember off a card that reads
 * `BLR-A/0000123`, and `varchar_pattern_ops` prefix matching only helps if both
 * sides went through the same funnel.
 */
export function normaliseUhid(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** `patient.identifiers.value_normalised` — upper-cased, punctuation-stripped. */
export function normaliseIdentifierValue(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9@.]/g, '');
}

/**
 * ABHA numbers are printed as `91-1234-5678-9012` and typed a dozen ways. The
 * stored form keeps the hyphens (that is what `patients.abha_number` holds in
 * the seed), so comparison normalises to digits on both sides.
 */
export function normaliseAbhaNumber(raw: string): string {
  return raw.replace(/[^0-9]/g, '');
}

/** An ABHA address is an email-shaped handle (`asha.rao001@sbx`), case-folded. */
export function normaliseAbhaAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Every spelling of one ABHA number, so the search can stay an index probe.
 *
 * `patients.abha_number` is `varchar(20)` holding whatever ABDM returned —
 * hyphenated in practice — and the partial index on it is a plain btree. Making
 * the *query* normalise (`regexp_replace(abha_number, …) = $1`) would put a
 * function on the indexed column and turn a probe into a scan of every patient
 * who has an ABHA. Normalising the *input* into its handful of equivalent forms
 * and probing with `= ANY(...)` keeps the index in play.
 */
export function abhaNumberVariants(raw: string): string[] {
  const trimmed = raw.trim();
  const digits = normaliseAbhaNumber(trimmed);
  const variants = new Set<string>([trimmed]);
  if (digits.length > 0) variants.add(digits);
  if (digits.length === 14) {
    variants.add(`${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}`);
  }
  return [...variants];
}

export interface NormalisedMobile {
  /** E.164 including the `+`, which is what `patients.mobile` stores. */
  readonly e164: string;
  /** National significant number, digits only — `patients.mobile_local`. */
  readonly local: string;
}

/**
 * Splits whatever was typed into the two forms the schema stores.
 *
 * Both exist because they serve different indexes: `mobile` is probed exactly
 * (`idx` on `(hospital_id, mobile)`), `mobile_local` is probed by prefix
 * (`varchar_pattern_ops`) as the receptionist types. Deriving one from the other
 * at query time would defeat both.
 *
 * The default dial code is `91`; a number typed with an explicit `+` keeps its
 * own country code and is not re-homed to India.
 */
export function normaliseMobile(raw: string, defaultDialCode = '91'): NormalisedMobile {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^0-9]/g, '');

  if (trimmed.startsWith('+')) {
    if (digits.startsWith(defaultDialCode) && digits.length > defaultDialCode.length) {
      const local = digits.slice(defaultDialCode.length);
      return { e164: `+${defaultDialCode}${local}`, local };
    }
    // A foreign number: we cannot split country code from subscriber number
    // without a numbering plan table, so the whole thing is kept as the local
    // part rather than guessed at. Prefix search still works; it just searches
    // the full string.
    return { e164: `+${digits}`, local: digits };
  }

  let local = digits.replace(/^0+/, '');
  if (local.length > 10 && local.startsWith(defaultDialCode)) local = local.slice(defaultDialCode.length);
  return { e164: `+${defaultDialCode}${local}`, local };
}

/** The CHECK constraint `patients_mobile_e164`, expressed once in TypeScript. */
export const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;

export function isE164(value: string): boolean {
  return E164_PATTERN.test(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Age and date of birth
// ─────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD`, the form `date` columns and `pg` both round-trip losslessly. */
export function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface AgeCapture {
  readonly ageYears?: number | undefined;
  readonly ageMonths?: number | undefined;
  readonly ageDays?: number | undefined;
}

export interface ResolvedBirth {
  readonly dob: string | null;
  readonly dobIsEstimated: boolean;
  readonly ageYears: number | null;
  readonly ageMonths: number | null;
  readonly ageDays: number | null;
}

/**
 * OP-001 §5: "Age computed live from DOB; if age-only recorded, DOB estimated as
 * 1-Jan-(year) with flag; neonates: age in days."
 *
 * The captured triple is stored alongside the estimate rather than discarded,
 * because "38 years old, told to us in April" and "born 1 January 1988" are
 * different statements and a report that averages them together should be able
 * to exclude the estimated ones — which is what `dob_is_estimated` is for.
 */
export function resolveBirth(dob: string | null | undefined, age: AgeCapture, today: Date): ResolvedBirth {
  const ageYears = age.ageYears ?? null;
  const ageMonths = age.ageMonths ?? null;
  const ageDays = age.ageDays ?? null;

  if (typeof dob === 'string' && dob.length > 0) {
    return { dob, dobIsEstimated: false, ageYears, ageMonths, ageDays };
  }

  if (ageDays !== null && ageYears === null && ageMonths === null) {
    // A neonate aged in days has a knowable birth date, so it is computed rather
    // than estimated to 1 January — which for a two-day-old would be absurd.
    const born = new Date(today.getTime() - ageDays * 86_400_000);
    return { dob: toDateOnly(born), dobIsEstimated: true, ageYears, ageMonths, ageDays };
  }

  if (ageYears !== null) {
    const year = today.getUTCFullYear() - ageYears;
    return {
      dob: `${String(year).padStart(4, '0')}-01-01`,
      dobIsEstimated: true,
      ageYears,
      ageMonths,
      ageDays,
    };
  }

  if (ageMonths !== null) {
    const born = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - ageMonths, today.getUTCDate()),
    );
    return { dob: toDateOnly(born), dobIsEstimated: true, ageYears, ageMonths, ageDays };
  }

  // The CHECK `patients_age_basis` refuses this row; the caller validates first.
  return { dob: null, dobIsEstimated: false, ageYears, ageMonths, ageDays };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic fingerprint
// ─────────────────────────────────────────────────────────────────────────────

export interface FingerprintInput {
  readonly mobileLocal: string;
  readonly dob: string | null;
  readonly firstName: string;
  readonly lastName: string | null | undefined;
  readonly gender: string;
}

/**
 * `patients.dedupe_fingerprint` — the 0.9 rule, precomputed.
 *
 * The recipe is copied byte-for-byte from `packages/db/src/seed/synthetic.ts`
 * (`dedupeFingerprint`) and must stay that way: an imported or seeded patient
 * and one registered through this API have to land on the same digest, or the
 * deterministic rule silently stops firing for half the MPI. The 40-character
 * truncation is the schema's (`varchar(64)` holding a 40-char slice), not a
 * security decision — this is a matching key, not a secret.
 */
export function dedupeFingerprint(input: FingerprintInput): string {
  return createHash('sha256')
    .update(
      [
        input.mobileLocal,
        input.dob ?? '',
        normaliseNameKey(input.firstName, input.lastName),
        input.gender,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 40);
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate scoring — OP-001 §5
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OP-001 §5, verbatim: "exact ABHA/Aadhaar-hash = 1.0; mobile+DOB = 0.9; name
 * trigram ≥0.6 + gender + DOB±1y = 0.85; ≥0.85 blocks without override
 * permission `patient.record.create_override`."
 */
export const DUPLICATE_BLOCK_THRESHOLD = 0.85;
export const NAME_SIMILARITY_FLOOR = 0.6;

export interface DuplicateSignals {
  readonly abhaNumberMatch: boolean;
  readonly abhaAddressMatch: boolean;
  /**
   * Aadhaar is compared as a peppered digest and never as a number. No route
   * populates this today — see `PatientService.register` — but the rule is
   * implemented and tested so that wiring EN-011's e-KYC path is one line rather
   * than a re-derivation of the scoring table.
   */
  readonly aadhaarHashMatch: boolean;
  readonly fingerprintMatch: boolean;
  readonly mobileMatch: boolean;
  readonly dobExactMatch: boolean;
  readonly dobWithinOneYear: boolean;
  readonly genderMatch: boolean;
  /** `ext.similarity(full_name, $q)` from PostgreSQL, 0…1. */
  readonly nameSimilarity: number;
}

export interface DuplicateScore {
  /** 0…1, three decimal places — the precision of `dedupe_candidates.score`. */
  readonly score: number;
  /** Every rule that fired, not merely the winning one. */
  readonly ruleHits: readonly string[];
}

/**
 * Scores one candidate pair.
 *
 * The score is the **maximum** of the rules that fired, not their sum: the rules
 * overlap heavily (a fingerprint match implies a mobile+DOB match implies, often,
 * a name match) and adding them would push every ordinary family member over the
 * blocking threshold. `ruleHits` keeps all of them, because the MRD officer
 * reviewing the pair needs the evidence, not the arithmetic.
 */
export function scoreDuplicate(signals: DuplicateSignals): DuplicateScore {
  const ruleHits: string[] = [];
  let score = 0;

  const fire = (value: number, rule: string): void => {
    ruleHits.push(rule);
    if (value > score) score = value;
  };

  if (signals.abhaNumberMatch) fire(1, 'abha_number_exact');
  if (signals.abhaAddressMatch) fire(1, 'abha_address_exact');
  if (signals.aadhaarHashMatch) fire(1, 'aadhaar_hash_exact');
  if (signals.fingerprintMatch) fire(0.9, 'dedupe_fingerprint_exact');
  if (signals.mobileMatch && signals.dobExactMatch) fire(0.9, 'mobile_dob');
  if (signals.nameSimilarity >= NAME_SIMILARITY_FLOOR && signals.genderMatch && signals.dobWithinOneYear) {
    fire(0.85, 'name_trgm_gender_dob');
  }

  return { score: Math.round(score * 1000) / 1000, ruleHits };
}

/** OP-001 §5 / §14 AC-2: at or above the threshold, the save is refused. */
export function blocksRegistration(score: number): boolean {
  return score >= DUPLICATE_BLOCK_THRESHOLD;
}

/**
 * Whether two dates of birth are within a year of each other, the tolerance the
 * 0.85 rule uses. Both are `YYYY-MM-DD`; either being absent means the rule
 * cannot fire, which is the safe direction (it under-detects rather than
 * blocking an unrelated patient).
 */
export function dobWithinOneYear(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const left = Date.parse(`${a}T00:00:00Z`);
  const right = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return false;
  return Math.abs(left - right) <= 366 * 86_400_000;
}
