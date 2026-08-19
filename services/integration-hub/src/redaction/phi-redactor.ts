/**
 * EN-017 §5 / `docs/04` §2 — PHI redaction on the searchable copy of every
 * message.
 *
 * `ihub_messages.payload_redacted` is JSONB that IT staff search, that lands in
 * every backup, and that a support engineer reads over someone's shoulder. The
 * rule is absolute: "no PHI in URLs, logs, error messages, analytics events,
 * Sentry payloads… or AI prompts". The full payload lives encrypted behind
 * `payload_ref`, and reading *that* is itself audited as a PHI read.
 *
 * Two mechanisms, because either alone is insufficient:
 *
 *  1. **Field policy.** Reuses `DEFAULT_AUDIT_FIELD_POLICIES` from
 *     `@vims/contracts` — the same list the audit diff builder masks with. There
 *     is deliberately no second policy set: two lists of "which columns are
 *     sensitive" drift apart, and the day they do, one of them is wrong in the
 *     direction that leaks. The hub extends the list (`IHUB_FIELD_POLICIES`)
 *     rather than replacing it, because the audit set covers columns of *our*
 *     tables and a partner's payload also carries `patientName`, `addressLine1`
 *     and free clinical text under names no HMS table uses.
 *
 *  2. **Value scanning.** A field policy only helps when the key is recognisable.
 *     Half of what flows through EN-017 is not key-value at all: an HL7 v2 ORU
 *     is one pipe-delimited string, an ASTM record is positional, a SOAP fault
 *     quotes the request back. So every string is *also* scanned for the
 *     identifiers themselves — ABHA, Aadhaar, Indian mobile, e-mail — and those
 *     are replaced in place. Key policy without value scanning would have stored
 *     an entire HL7 message verbatim under the key `raw`.
 *
 * Tokens follow EN-017 §5: typed, with the last four characters kept where the
 * spec allows it (`«phone:9876»`) so a human can still correlate a complaint
 * with a message without the log holding the identifier.
 */
import {
  DEFAULT_AUDIT_FIELD_POLICIES,
  REDACTION_PLACEHOLDER,
  type AuditFieldPolicy,
} from '@vims/contracts';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** What a redaction replaced. Counted per message so the dashboard can show it. */
export type RedactionToken =
  | 'name'
  | 'address'
  | 'dob'
  | 'uhid'
  | 'phone'
  | 'aadhaar'
  | 'abha'
  | 'email'
  | 'pan'
  | 'account'
  | 'text'
  | 'redacted'
  | 'excluded';

export interface RedactionResult {
  /** Safe to store in `payload_redacted` and to print in a log line. */
  readonly payload: JsonValue;
  /** True when anything with `dataClass: 'phi'` was replaced. Sets `contains_phi`. */
  readonly containsPhi: boolean;
  /** Token → occurrences. Empty means nothing matched, which is itself worth knowing. */
  readonly redactions: Readonly<Partial<Record<RedactionToken, number>>>;
  /** Size of the **original** payload, for `ihub_messages.size_bytes`. */
  readonly sizeBytes: number;
}

export interface RedactionOptions {
  /** Nesting beyond this is replaced with a marker. Guards against a hostile payload. */
  readonly maxDepth?: number;
  /** Array elements beyond this are summarised. */
  readonly maxArrayLength?: number;
  /** Strings longer than this are truncated before scanning. */
  readonly maxStringLength?: number;
  /**
   * An unstructured string longer than this is reduced to its length.
   *
   * Found by the integration suite, not by review: a value scanner catches
   * *identifiers*, because identifiers have shapes. It cannot catch a name or a
   * street, because those have none — and an HL7 PID segment carries
   * `IYER^RAMESH` and `14/2 Nehru Nagar^^Coimbatore` in plain text between the
   * fields that do have shapes. The searchable copy therefore refuses to hold a
   * long free string at all; the full text is one `ihub.payload.read` away in
   * the encrypted payload, which is exactly the gate `docs/04` §2 asks for.
   */
  readonly maxFreeTextLength?: number;
}

const DEFAULTS = {
  maxDepth: 12,
  maxArrayLength: 200,
  maxStringLength: 4_000,
  maxFreeTextLength: 200,
} as const;

/**
 * The hub's additions to the shared audit policy set.
 *
 * Typed as `AuditFieldPolicy` on purpose: these are the same kind of statement,
 * expressed in the same vocabulary, and if EN-024 ever needs them they move
 * across without translation.
 */
export const IHUB_FIELD_POLICIES: readonly AuditFieldPolicy[] = Object.freeze([
  {
    entity: '*',
    column: 'name',
    mask: 'redact',
    dataClass: 'phi',
    reasonRequired: false,
    note: 'EN-017 §5: names are replaced with a typed token on the searchable copy.',
  },
  { entity: '*', column: 'address', mask: 'redact', dataClass: 'phi', reasonRequired: false },
  {
    entity: '*',
    column: 'dob',
    mask: 'mask_partial',
    dataClass: 'phi',
    reasonRequired: false,
    note: 'EN-017 §5 keeps the year: age cohorts stay analysable, the date of birth does not.',
  },
  {
    entity: '*',
    column: 'uhid',
    mask: 'mask_partial',
    dataClass: 'phi',
    reasonRequired: false,
    note: 'EN-017 §5: last 4 kept so support can correlate a call with a message.',
  },
  {
    entity: '*',
    column: 'clinical_text',
    mask: 'redact',
    dataClass: 'phi',
    reasonRequired: false,
    note: 'Free-text notes are unbounded PHI: only the length survives.',
  },
]);

const ALL_FIELD_POLICIES: readonly AuditFieldPolicy[] = [
  ...DEFAULT_AUDIT_FIELD_POLICIES,
  ...IHUB_FIELD_POLICIES,
];

/** Which token a policy column produces. Columns absent here fall back to `redacted`. */
const COLUMN_TOKEN: Readonly<Record<string, RedactionToken>> = {
  mobile: 'phone',
  email: 'email',
  aadhaar: 'aadhaar',
  aadhaar_last4: 'aadhaar',
  abha_number: 'abha',
  abha_token: 'redacted',
  pan: 'pan',
  bank_account_no: 'account',
  name: 'name',
  address: 'address',
  dob: 'dob',
  uhid: 'uhid',
  clinical_text: 'text',
};

/**
 * Aliases, because a partner's field is called whatever the partner calls it.
 * Keys are normalised (lower-cased, non-alphanumerics stripped), so
 * `patient_name`, `patientName` and `PATIENT NAME` all arrive here as
 * `patientname`.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  // → mobile
  mobile: 'mobile',
  mobileno: 'mobile',
  mobilenumber: 'mobile',
  phone: 'mobile',
  phoneno: 'mobile',
  phonenumber: 'mobile',
  contact: 'mobile',
  contactno: 'mobile',
  contactnumber: 'mobile',
  telephone: 'mobile',
  msisdn: 'mobile',
  altmobile: 'mobile',
  emergencycontact: 'mobile',
  // → email
  email: 'email',
  emailid: 'email',
  emailaddress: 'email',
  mail: 'email',
  // → aadhaar
  aadhaar: 'aadhaar',
  aadhar: 'aadhaar',
  aadhaarno: 'aadhaar',
  aadhaarnumber: 'aadhaar',
  aadharnumber: 'aadhaar',
  uid: 'aadhaar',
  uidai: 'aadhaar',
  // → abha
  abha: 'abha_number',
  abhano: 'abha_number',
  abhanumber: 'abha_number',
  abhaid: 'abha_number',
  abhaaddress: 'abha_number',
  healthid: 'abha_number',
  healthidnumber: 'abha_number',
  abhatoken: 'abha_token',
  abhaaccesstoken: 'abha_token',
  // → name
  name: 'name',
  fullname: 'name',
  patientname: 'name',
  firstname: 'name',
  lastname: 'name',
  middlename: 'name',
  givenname: 'name',
  familyname: 'name',
  surname: 'name',
  fathername: 'name',
  mothername: 'name',
  guardianname: 'name',
  attendantname: 'name',
  // → address
  address: 'address',
  addressline1: 'address',
  addressline2: 'address',
  address1: 'address',
  address2: 'address',
  street: 'address',
  streetaddress: 'address',
  locality: 'address',
  pincode: 'address',
  postalcode: 'address',
  zip: 'address',
  // → dob
  dob: 'dob',
  dateofbirth: 'dob',
  birthdate: 'dob',
  birthdt: 'dob',
  // → uhid
  uhid: 'uhid',
  mrn: 'uhid',
  mrno: 'uhid',
  hospitalnumber: 'uhid',
  // → free clinical text
  notes: 'clinical_text',
  note: 'clinical_text',
  clinicalnotes: 'clinical_text',
  remarks: 'clinical_text',
  comments: 'clinical_text',
  chiefcomplaint: 'clinical_text',
  historyofpresentillness: 'clinical_text',
  diagnosis: 'clinical_text',
  impression: 'clinical_text',
  observation: 'clinical_text',
  freetext: 'clinical_text',
  // → secrets
  password: 'password_hash',
  passwordhash: 'password_hash',
  apikey: 'api_key',
  clientsecret: 'client_secret',
  privatekey: 'private_key',
  refreshtoken: 'refresh_token',
  accesstoken: 'token_hash',
  authorization: 'token_hash',
  credentialsref: 'credentials_ref',
  biometrictemplate: 'biometric_template',
  bankaccountno: 'bank_account_no',
  accountnumber: 'bank_account_no',
  pan: 'pan',
  panno: 'pan',
};

interface FieldRule {
  readonly mask: AuditFieldPolicy['mask'];
  readonly token: RedactionToken;
  readonly phi: boolean;
}

const FIELD_RULES: ReadonlyMap<string, FieldRule> = buildFieldRules();

function buildFieldRules(): ReadonlyMap<string, FieldRule> {
  const byColumn = new Map<string, FieldRule>();
  for (const policy of ALL_FIELD_POLICIES) {
    // `entity: '*'` policies apply to every payload; entity-specific ones are
    // about our own tables and have no meaning for a partner's document.
    if (policy.entity !== '*') continue;
    byColumn.set(policy.column, {
      mask: policy.mask,
      token: COLUMN_TOKEN[policy.column] ?? 'redacted',
      phi: policy.dataClass === 'phi',
    });
  }

  const rules = new Map<string, FieldRule>();
  for (const [column, rule] of byColumn) {
    rules.set(normaliseKey(column), rule);
  }
  for (const [alias, column] of Object.entries(KEY_ALIASES)) {
    const rule = byColumn.get(column);
    if (rule !== undefined) rules.set(alias, rule);
  }
  return rules;
}

export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Value scanners, in the order they must run.
 *
 * Order is load-bearing. E-mail first, because `9876543210@upi` contains a
 * mobile number. ABHA before Aadhaar, because a 14-digit ABHA contains a
 * 12-digit run. Aadhaar before mobile for the same reason.
 */
const VALUE_SCANNERS: readonly { readonly token: RedactionToken; readonly re: RegExp }[] = [
  { token: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { token: 'abha', re: /(?<!\d)\d{2}-\d{4}-\d{4}-\d{4}(?!\d)/g },
  { token: 'abha', re: /(?<!\d)\d{14}(?!\d)/g },
  { token: 'aadhaar', re: /(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}(?!\d)/g },
  { token: 'phone', re: /(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{4}[-\s]?\d{5}(?!\d)/g },
];

const PHI_TOKENS: ReadonlySet<RedactionToken> = new Set<RedactionToken>([
  'name',
  'address',
  'dob',
  'uhid',
  'phone',
  'aadhaar',
  'abha',
  'email',
  'text',
]);

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** `«phone:9876»` — the shape EN-017 §5 specifies. */
function token(kind: RedactionToken, suffix?: string): string {
  return suffix === undefined || suffix.length === 0 ? `«${kind}»` : `«${kind}:${suffix}»`;
}

class Tally {
  private readonly counts = new Map<RedactionToken, number>();
  private phi = false;

  add(kind: RedactionToken, isPhi: boolean): void {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    if (isPhi) this.phi = true;
  }

  get containsPhi(): boolean {
    return this.phi;
  }

  snapshot(): Readonly<Partial<Record<RedactionToken, number>>> {
    const out: Partial<Record<RedactionToken, number>> = {};
    for (const [kind, count] of this.counts) out[kind] = count;
    return out;
  }
}

/** JSON values only; objects would stringify to `[object Object]`, so they are serialised. */
function jsonToText(value: JsonValue): string {
  if (typeof value === 'string') return value;
  if (value === null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Applies a field policy to one value. */
function applyFieldRule(rule: FieldRule, value: JsonValue, tally: Tally): JsonValue | undefined {
  switch (rule.mask) {
    case 'exclude':
      tally.add('excluded', rule.phi);
      return undefined;
    case 'redact': {
      if (rule.token === 'text' && typeof value === 'string') {
        tally.add('text', rule.phi);
        return token('text', String(value.length));
      }
      tally.add(rule.token, rule.phi);
      return rule.token === 'redacted' ? REDACTION_PLACEHOLDER : token(rule.token);
    }
    case 'mask_partial': {
      const asText = jsonToText(value);
      tally.add(rule.token, rule.phi);
      if (rule.token === 'dob') {
        const year = /(\d{4})/.exec(asText)?.[1];
        return token('dob', year);
      }
      const digits = digitsOnly(asText);
      const last4 = digits.length >= 4 ? digits.slice(-4) : undefined;
      return token(rule.token, last4);
    }
    case 'none':
      return value;
    default:
      return value;
  }
}

/**
 * Envelopes whose *shape* is safe to record and whose *content* is not.
 *
 * An HL7 v2 message type (`ORU^R01`) and its segment names (`MSH`, `PID`, `OBX`)
 * are protocol vocabulary — they are what an engineer needs to triage an
 * interface at 03:00, and they identify nobody. Everything between them is the
 * patient. So the searchable copy keeps the vocabulary and drops the rest.
 */
const HL7_V2_RE = /^MSH\|[^|]{1,8}\|/;
const ASTM_RE = /^H\|\\\^&/;
const X12_RE = /^ISA[*|]/;

function summariseStructuredMessage(input: string): string | undefined {
  const isHl7 = HL7_V2_RE.test(input);
  const isAstm = ASTM_RE.test(input);
  const isX12 = X12_RE.test(input);
  if (!isHl7 && !isAstm && !isX12) return undefined;

  const kind = isHl7 ? 'hl7' : isAstm ? 'astm' : 'x12';
  const segments = [
    ...new Set(
      input
        .split(/[\r\n]+/)
        .map((line) => line.slice(0, 3))
        .filter((code) => /^[A-Z][A-Z0-9]{1,2}$/.test(code)),
    ),
  ].slice(0, 12);

  // MSH-9 is the message type. It is a code from the HL7 table, never a value.
  let type = '';
  if (isHl7) {
    const fields = (input.split(/[\r\n]/)[0] ?? '').split('|');
    const candidate = fields[8] ?? '';
    if (/^[A-Z]{3}\^[A-Z]\d{2}(\^[A-Z0-9_]+)?$/.test(candidate)) type = ` ${candidate}`;
  }

  return `«${kind}:${type.trim()} seg=${segments.join(',')} len=${String(input.length)}»`;
}

/** Replaces identifiers found *inside* a string. This is what catches HL7. */
function redactString(input: string, tally: Tally): string {
  let output = input;
  for (const scanner of VALUE_SCANNERS) {
    output = output.replace(new RegExp(scanner.re.source, scanner.re.flags), (match) => {
      tally.add(scanner.token, PHI_TOKENS.has(scanner.token));
      if (scanner.token === 'email') return token('email');
      const digits = digitsOnly(match);
      return token(scanner.token, digits.length >= 4 ? digits.slice(-4) : undefined);
    });
  }
  return output;
}

function redactNode(
  value: unknown,
  keyRule: FieldRule | undefined,
  depth: number,
  opts: Required<RedactionOptions>,
  tally: Tally,
): JsonValue | undefined {
  if (depth > opts.maxDepth) return '«depth»';

  if (value === null || value === undefined) return null;

  if (typeof value === 'boolean') return value;

  if (typeof value === 'bigint') {
    // JSON has no bigint; storing it as text keeps the value legible in the log
    // without pretending it round-trips as a number.
    return redactNode(value.toString(), keyRule, depth, opts, tally);
  }

  if (typeof value === 'number') {
    if (keyRule !== undefined) return applyFieldRule(keyRule, value, tally);
    // An identifier arriving as a JSON number is still an identifier. Only
    // long runs are scanned: a 10+ digit integer is far more likely an Aadhaar,
    // an ABHA or a phone number than a quantity, and if it *was* a quantity the
    // exact figure belongs in the encrypted payload, not in a searchable log.
    const asText = String(value);
    if (/^\d{10,}$/.test(asText)) {
      const redacted = redactString(asText, tally);
      return redacted === asText ? value : redacted;
    }
    return value;
  }

  if (typeof value === 'string') {
    const truncated =
      value.length > opts.maxStringLength ? `${value.slice(0, opts.maxStringLength)}…` : value;
    if (keyRule !== undefined) return applyFieldRule(keyRule, truncated, tally);

    const structured = summariseStructuredMessage(truncated);
    if (structured !== undefined) {
      tally.add('text', true);
      return structured;
    }
    if (truncated.length > opts.maxFreeTextLength) {
      tally.add('text', true);
      return token('text', String(value.length));
    }
    return redactString(truncated, tally);
  }

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    const limit = Math.min(value.length, opts.maxArrayLength);
    for (let i = 0; i < limit; i += 1) {
      const child = redactNode(value[i], keyRule, depth + 1, opts, tally);
      if (child !== undefined) out.push(child);
    }
    if (value.length > limit) out.push(`«… ${value.length - limit} more»`);
    return out;
  }

  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const rule = FIELD_RULES.get(normaliseKey(key));
      const redacted = redactNode(child, rule, depth + 1, opts, tally);
      // `undefined` is an `exclude` policy: the key itself disappears, because
      // "password_hash": "«redacted»" still tells an attacker where to look.
      if (redacted !== undefined) out[key] = redacted;
    }
    return out;
  }

  // Functions, symbols — nothing legitimate arrives here.
  return '«unsupported»';
}

function measure(value: unknown): number {
  try {
    return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Redacts a bare string — an HL7 v2 message, a SOAP fault, an error text.
 * `error_text` on `ihub_messages` goes through this: a partner that echoes the
 * request back in its 422 body would otherwise put the whole patient in a
 * VARCHAR column nobody thinks of as a payload.
 */
export function redactText(input: string, options: RedactionOptions = {}): RedactionResult & { readonly payload: string } {
  const tally = new Tally();
  const limit = options.maxFreeTextLength ?? DEFAULTS.maxFreeTextLength;
  const structured = summariseStructuredMessage(input);
  let output: string;
  if (structured !== undefined) {
    tally.add('text', true);
    output = structured;
  } else if (input.length > limit) {
    // Same rule as a payload string: a partner that echoes the whole request
    // back in its error body must not thereby put the patient in `error_text`.
    tally.add('text', true);
    output = token('text', String(input.length));
  } else {
    output = redactString(input, tally);
  }
  return {
    payload: output,
    containsPhi: tally.containsPhi,
    redactions: tally.snapshot(),
    sizeBytes: Buffer.byteLength(input, 'utf8'),
  };
}

/**
 * The entry point. Everything written to `ihub_messages.payload_redacted` or
 * `response_redacted` goes through here — there is no second path.
 */
export function redactPayload(payload: unknown, options: RedactionOptions = {}): RedactionResult {
  const opts: Required<RedactionOptions> = {
    maxDepth: options.maxDepth ?? DEFAULTS.maxDepth,
    maxArrayLength: options.maxArrayLength ?? DEFAULTS.maxArrayLength,
    maxStringLength: options.maxStringLength ?? DEFAULTS.maxStringLength,
    maxFreeTextLength: options.maxFreeTextLength ?? DEFAULTS.maxFreeTextLength,
  };
  const tally = new Tally();
  const redacted = redactNode(payload, undefined, 0, opts, tally) ?? null;
  return {
    payload: redacted,
    containsPhi: tally.containsPhi,
    redactions: tally.snapshot(),
    sizeBytes: measure(payload),
  };
}
