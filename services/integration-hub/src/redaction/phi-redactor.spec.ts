import { DEFAULT_AUDIT_FIELD_POLICIES } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { PHI_SAMPLE } from '../testing/fixtures.js';
import { IHUB_FIELD_POLICIES, normaliseKey, redactPayload, redactText } from './phi-redactor.js';

/**
 * `docs/04` §2 is the requirement these tests exist to enforce: no PHI in logs.
 * `ihub_messages.payload_redacted` is a log by every meaning that matters — it
 * is searched, exported, backed up and read over shoulders.
 *
 * The assertions are deliberately negative ("the raw identifier is absent")
 * rather than positive ("a token is present"). A positive assertion passes on a
 * payload that contains both the token and the original.
 */

function asText(value: unknown): string {
  return JSON.stringify(value);
}

describe('PHI redactor — field policies', () => {
  it('reuses the shared audit policy set rather than defining a second one', () => {
    // The point of the assertion is the *coupling*: if EN-024 adds a column to
    // the shared list, the hub gets it for free, and this test fails if someone
    // forks the list instead.
    const auditColumns = DEFAULT_AUDIT_FIELD_POLICIES.map((p) => p.column);
    expect(auditColumns).toContain('abha_number');
    expect(auditColumns).toContain('mobile');
    expect(auditColumns).toContain('aadhaar');

    const hubColumns = IHUB_FIELD_POLICIES.map((p) => p.column);
    // The hub only adds what the audit set has no reason to hold: a partner's
    // payload fields, not our own table columns.
    expect(hubColumns).toEqual(['name', 'address', 'dob', 'uhid', 'clinical_text']);
    for (const column of hubColumns) {
      expect(auditColumns).not.toContain(column);
    }
  });

  it('normalises key spellings so patient_name, patientName and "Patient Name" agree', () => {
    expect(normaliseKey('patient_name')).toBe('patientname');
    expect(normaliseKey('patientName')).toBe('patientname');
    expect(normaliseKey('PATIENT NAME')).toBe('patientname');
  });

  it('removes an ABHA number and a mobile number from a nested payload', () => {
    const result = redactPayload({
      patient: { abhaNumber: PHI_SAMPLE.abhaNumber, mobile: PHI_SAMPLE.mobile },
    });
    const stored = asText(result.payload);

    expect(stored).not.toContain(PHI_SAMPLE.abhaNumber);
    expect(stored).not.toContain('1122334455 6677');
    expect(stored).not.toContain(PHI_SAMPLE.mobile);
    expect(stored).not.toContain('9876543210');
    expect(stored).toContain('«abha:6677»');
    expect(stored).toContain('«phone:3210»');
    expect(result.containsPhi).toBe(true);
  });

  it('drops secret-bearing keys entirely rather than replacing their values', () => {
    // "password_hash": "«redacted»" still tells an attacker exactly where to
    // look, and EN-024 §3.1.4 classifies these as `exclude`, not `redact`.
    const result = redactPayload({ username: 'svc_lab', password_hash: 'argon2id$v=19$...' });
    const stored = asText(result.payload);
    expect(stored).not.toContain('argon2id');
    expect(stored).not.toContain('password_hash');
    expect(stored).toContain('svc_lab');
  });

  it('keeps the year of a date of birth and the last four of a UHID', () => {
    const result = redactPayload({ dob: PHI_SAMPLE.dob, uhid: PHI_SAMPLE.uhid });
    const stored = asText(result.payload);
    expect(stored).toContain('«dob:1987»');
    expect(stored).not.toContain('1987-03-11');
    expect(stored).toContain('«uhid:4821»');
    expect(stored).not.toContain('CBE-2026-004821');
  });

  it('replaces a name, an address and free clinical text with typed tokens', () => {
    const result = redactPayload({
      patientName: PHI_SAMPLE.patientName,
      addressLine1: PHI_SAMPLE.addressLine1,
      clinicalNotes: PHI_SAMPLE.clinicalNotes,
    });
    const stored = asText(result.payload);
    expect(stored).not.toContain('Ramesh');
    expect(stored).not.toContain('Nehru Nagar');
    expect(stored).not.toContain('chest pain');
    expect(stored).toContain('«name»');
    expect(stored).toContain('«address»');
    expect(stored).toContain(`«text:${String(PHI_SAMPLE.clinicalNotes.length)}»`);
  });

  it('leaves non-identifying values alone', () => {
    const result = redactPayload({
      orderNumber: PHI_SAMPLE.orderNumber,
      amount: PHI_SAMPLE.amount,
      status: 'final',
      count: 3,
    });
    expect(result.payload).toMatchObject({
      orderNumber: 'ORD-99213',
      amount: 1450.5,
      status: 'final',
      count: 3,
    });
    expect(result.containsPhi).toBe(false);
  });
});

describe('PHI redactor — value scanning', () => {
  it('keeps an HL7 v2 message as its shape and drops its content', () => {
    // The value scanner alone was not enough, and the integration suite proved
    // it: identifiers have shapes, but `IYER^RAMESH` and `14/2 Nehru Nagar` do
    // not, and an HL7 PID segment carries both in plain text. What survives is
    // protocol vocabulary — message type, segment names, length — which is what
    // triage needs and identifies nobody.
    const result = redactPayload({ raw: PHI_SAMPLE.hl7 });
    const stored = asText(result.payload);

    expect(stored).not.toContain('11-2233-4455-6677');
    expect(stored).not.toContain('9876543210');
    expect(stored).not.toContain('IYER');
    expect(stored).not.toContain('Nehru Nagar');
    expect(stored).not.toContain('19870311');
    expect(stored).toContain('«hl7:ORU^R01 seg=MSH,PID len=');
    expect(result.containsPhi).toBe(true);
  });

  it('summarises an ASTM analyzer record the same way', () => {
    const astm = 'H|\\^&|||Roche^Cobas|||||||P|1\rP|1||CBE-2026-004821||IYER^RAMESH||19870311|M';
    const stored = asText(redactPayload({ raw: astm }).payload);
    expect(stored).not.toContain('IYER');
    expect(stored).toContain('«astm:');
  });

  it('still scans a short unstructured string for identifiers', () => {
    // A partner's 422 body quoting the request back is the common case.
    const result = redactPayload({ error: 'ABHA 11-2233-4455-6677 already linked to 9876543210' });
    const stored = asText(result.payload);
    expect(stored).not.toContain('11-2233-4455-6677');
    expect(stored).not.toContain('9876543210');
    expect(stored).toContain('«abha:6677»');
    expect(stored).toContain('«phone:3210»');
  });

  it('refuses to store a long free-text string at all', () => {
    const blob = `Discharge summary: ${'x'.repeat(400)}`;
    const stored = asText(redactPayload({ note: blob }).payload);
    expect(stored).not.toContain('Discharge summary');
    expect(stored).toContain(`«text:${String(blob.length)}»`);
  });

  it('redacts an e-mail address before the digits inside it are read as a phone number', () => {
    const result = redactText('contact 9876543210@example.com for results');
    expect(result.payload).toContain('«email»');
    expect(result.payload).not.toContain('9876543210');
  });

  it('distinguishes a 14-digit ABHA from a 12-digit Aadhaar from a 10-digit mobile', () => {
    const result = redactText(`${'11223344556677'} ${'432187652109'} ${'9876543210'}`);
    expect(result.payload).toBe('«abha:6677» «aadhaar:2109» «phone:3210»');
  });

  it('redacts an identifier that arrived as a JSON number under an unrecognised key', () => {
    // A partner sending `"contactNo": 9876543210` as a number is common, and a
    // key-only policy would store it verbatim.
    const result = redactPayload({ someVendorField: 9876543210 });
    expect(asText(result.payload)).not.toContain('9876543210');
  });

  it('does not mistake a small number for an identifier', () => {
    const result = redactPayload({ quantity: 12, price: 4999 });
    expect(result.payload).toMatchObject({ quantity: 12, price: 4999 });
  });
});

describe('PHI redactor — structure', () => {
  it('walks arrays and preserves order', () => {
    const result = redactPayload({ contacts: [{ mobile: '9876543210' }, { mobile: '9812345678' }] });
    expect(result.payload).toEqual({ contacts: [{ mobile: '«phone:3210»' }, { mobile: '«phone:5678»' }] });
  });

  it('summarises an over-long array instead of storing all of it', () => {
    const result = redactPayload({ rows: Array.from({ length: 10 }, (_, i) => i) }, { maxArrayLength: 3 });
    expect(result.payload).toEqual({ rows: [0, 1, 2, '«… 7 more»'] });
  });

  it('stops at the depth limit rather than recursing on a hostile payload', () => {
    const deep = { a: { b: { c: { d: 'leaf' } } } };
    const result = redactPayload(deep, { maxDepth: 2 });
    expect(asText(result.payload)).toContain('«depth»');
    expect(asText(result.payload)).not.toContain('leaf');
  });

  it('reports the size of the original payload, not the redacted one', () => {
    const payload = { mobile: PHI_SAMPLE.mobile };
    const result = redactPayload(payload);
    expect(result.sizeBytes).toBe(Buffer.byteLength(JSON.stringify(payload), 'utf8'));
  });

  it('counts what it replaced so the dashboard can show it', () => {
    const result = redactPayload({ mobile: '9876543210', altMobile: '9812345678', name: 'A B' });
    expect(result.redactions.phone).toBe(2);
    expect(result.redactions.name).toBe(1);
  });
});
