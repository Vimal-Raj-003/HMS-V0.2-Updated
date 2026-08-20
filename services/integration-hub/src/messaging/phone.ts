/**
 * E.164 normalisation — EN-009 §5 "Number validation: E.164 with default country
 * from hospital; invalid → blocked; landline SMS blocked".
 *
 * Normalisation is not cosmetic. The opt-out ledger, the block list and the DND
 * registry are all keyed by the number, and `9876543210`, `09876543210`,
 * `+91 98765 43210` and `919876543210` are the same person. A ledger that stores
 * them as four different keys does not refuse the send it was written to refuse
 * — which is the failure mode that reaches TRAI as a complaint.
 */

export type PhoneRejection = 'empty' | 'not_numeric' | 'too_short' | 'too_long' | 'landline' | 'unknown_country';

export type PhoneNormalisation =
  | { readonly ok: true; readonly e164: string; readonly countryCode: string; readonly national: string }
  | { readonly ok: false; readonly reason: PhoneRejection; readonly detail: string };

/** Indian mobile numbers start 6–9; anything else on a +91 number is a landline. */
const INDIA_MOBILE_FIRST_DIGIT = /^[6-9]/;

/**
 * Only the country codes a deployment actually uses are listed. An unknown
 * country is *rejected* rather than guessed: guessing produces a well-formed
 * number that belongs to somebody else.
 */
const KNOWN_COUNTRIES: Readonly<Record<string, { readonly nationalLength: number; readonly mobileFirst?: RegExp }>> =
  Object.freeze({
    '91': { nationalLength: 10, mobileFirst: INDIA_MOBILE_FIRST_DIGIT },
    '971': { nationalLength: 9 },
    '974': { nationalLength: 8 },
    '966': { nationalLength: 9 },
    '65': { nationalLength: 8 },
    '44': { nationalLength: 10 },
    '1': { nationalLength: 10 },
  });

/** Longest-prefix match, so `+1` does not shadow `+91`. */
function splitCountry(digits: string): { readonly cc: string; readonly national: string } | undefined {
  for (const length of [3, 2, 1]) {
    const cc = digits.slice(0, length);
    if (Object.hasOwn(KNOWN_COUNTRIES, cc)) return { cc, national: digits.slice(length) };
  }
  return undefined;
}

export function normaliseToE164(input: string, defaultCountryCode = '91'): PhoneNormalisation {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty', detail: 'no number supplied' };
  if (/[^\d\s+()\-.]/.test(trimmed)) {
    return { ok: false, reason: 'not_numeric', detail: 'contains characters that are not part of a number' };
  }

  const hadPlus = trimmed.startsWith('+');
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 0) return { ok: false, reason: 'empty', detail: 'no digits in the supplied number' };

  // `09876543210` — the national trunk prefix, typed by every front-office desk.
  if (!hadPlus && digits.startsWith('0')) digits = digits.replace(/^0+/, '');

  const country = KNOWN_COUNTRIES[defaultCountryCode];
  if (country === undefined) {
    return { ok: false, reason: 'unknown_country', detail: `no dialling rules for +${defaultCountryCode}` };
  }

  // A bare national number takes the hospital's country.
  if (!hadPlus && digits.length === country.nationalLength) digits = `${defaultCountryCode}${digits}`;

  const split = splitCountry(digits);
  if (split === undefined) {
    return { ok: false, reason: 'unknown_country', detail: `no dialling rules for the country in +${digits}` };
  }

  const rules = KNOWN_COUNTRIES[split.cc];
  if (rules === undefined) {
    return { ok: false, reason: 'unknown_country', detail: `no dialling rules for +${split.cc}` };
  }
  if (split.national.length < rules.nationalLength) {
    return { ok: false, reason: 'too_short', detail: `+${split.cc} numbers have ${String(rules.nationalLength)} digits` };
  }
  if (split.national.length > rules.nationalLength) {
    return { ok: false, reason: 'too_long', detail: `+${split.cc} numbers have ${String(rules.nationalLength)} digits` };
  }
  if (rules.mobileFirst !== undefined && !rules.mobileFirst.test(split.national)) {
    // EN-009 §5: an SMS to a landline is billed and never arrives.
    return { ok: false, reason: 'landline', detail: 'not a mobile number in this country' };
  }

  return { ok: true, e164: `+${split.cc}${split.national}`, countryCode: split.cc, national: split.national };
}

/**
 * `«phone:3210»` — the same shape `phi-redactor.ts` produces, so a refusal
 * reason quoted in an error, a log line or a support ticket reads identically to
 * the message log and still carries nothing.
 */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  return digits.length >= 4 ? `«phone:${digits.slice(-4)}»` : '«phone»';
}
