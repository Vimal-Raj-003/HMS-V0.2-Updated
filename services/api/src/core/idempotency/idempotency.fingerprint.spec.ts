import { describe, expect, it } from 'vitest';
import { DEFAULT_IDEMPOTENCY_OPTIONS, Idempotent } from './idempotency.decorator.js';
import { checkIdempotencyKey, fingerprintRequest, stableStringify } from './idempotency.fingerprint.js';

const base = {
  method: 'POST',
  route: '/api/v1/patients',
  params: {},
  query: {},
  body: { firstName: 'Asha', lastName: 'Rao', mobile: '9845012345' },
};

describe('request fingerprint', () => {
  it('is stable across key order, because a client may serialise either way', () => {
    const a = fingerprintRequest({ ...base, body: { firstName: 'Asha', mobile: '9845012345' } });
    const b = fingerprintRequest({ ...base, body: { mobile: '9845012345', firstName: 'Asha' } });
    expect(a).toBe(b);
  });

  it('is stable at every nesting depth, not only at the top level', () => {
    const a = fingerprintRequest({ ...base, body: { patient: { a: 1, b: { x: 1, y: 2 } } } });
    const b = fingerprintRequest({ ...base, body: { patient: { b: { y: 2, x: 1 }, a: 1 } } });
    expect(a).toBe(b);
  });

  it('changes when any value changes — the 500 versus 5000 case', () => {
    const fiveHundred = fingerprintRequest({ ...base, body: { amount: '500.00' } });
    const fiveThousand = fingerprintRequest({ ...base, body: { amount: '5000.00' } });
    expect(fiveHundred).not.toBe(fiveThousand);
  });

  it('keeps array order significant', () => {
    const a = fingerprintRequest({ ...base, body: { lines: ['cash', 'upi'] } });
    const b = fingerprintRequest({ ...base, body: { lines: ['upi', 'cash'] } });
    expect(a).not.toBe(b);
  });

  it('separates the same body sent to two different routes', () => {
    const patients = fingerprintRequest({ ...base, route: '/api/v1/patients' });
    const merge = fingerprintRequest({ ...base, route: '/api/v1/patients/merge' });
    expect(patients).not.toBe(merge);
  });

  it('separates the same body sent for two different path ids', () => {
    const first = fingerprintRequest({ ...base, route: '/cash/receipts/:id/void', params: { id: 'a' } });
    const second = fingerprintRequest({ ...base, route: '/cash/receipts/:id/void', params: { id: 'b' } });
    expect(first).not.toBe(second);
  });

  it('is a sha-256 hex digest, which is what the VARCHAR(64) column holds', () => {
    expect(fingerprintRequest(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not confuse a missing body with an empty object', () => {
    expect(fingerprintRequest({ ...base, body: undefined })).not.toBe(
      fingerprintRequest({ ...base, body: {} }),
    );
  });
});

describe('stableStringify', () => {
  it('collapses undefined to null so a present-but-undefined key is stable', () => {
    expect(stableStringify({ a: undefined })).toBe('{"a":null}');
  });

  it('never emits a non-finite number, which has no JSON form', () => {
    expect(stableStringify({ a: Number.NaN, b: Number.POSITIVE_INFINITY })).toBe('{"a":null,"b":null}');
  });
});

describe('key validation', () => {
  it('treats an absent header as missing', () => {
    expect(checkIdempotencyKey(undefined)).toEqual({ kind: 'missing' });
  });

  it('treats whitespace as missing rather than as a key', () => {
    expect(checkIdempotencyKey('   ')).toEqual({ kind: 'missing' });
  });

  it('rejects a key short enough to collide with another submission', () => {
    expect(checkIdempotencyKey('abc')).toMatchObject({ kind: 'invalid' });
  });

  it('rejects a key longer than the column', () => {
    expect(checkIdempotencyKey('x'.repeat(201))).toMatchObject({ kind: 'invalid' });
  });

  it('rejects a repeated header rather than silently picking one', () => {
    expect(checkIdempotencyKey(['one-key-value', 'another-key'])).toMatchObject({ kind: 'invalid' });
  });

  it('rejects an embedded space, since the value reaches problem details and logs', () => {
    expect(checkIdempotencyKey('good-key bad')).toMatchObject({ kind: 'invalid' });
  });

  it('accepts a UUID and trims surrounding whitespace', () => {
    expect(checkIdempotencyKey('  018f4a2e-3c11-7a44-9f3e-2b6c0c5d1a77  ')).toEqual({
      kind: 'ok',
      key: '018f4a2e-3c11-7a44-9f3e-2b6c0c5d1a77',
    });
  });
});

describe('@Idempotent options', () => {
  it('defaults to the 24 h cache docs/07 §4 specifies', () => {
    expect(DEFAULT_IDEMPOTENCY_OPTIONS.ttlHours).toBe(24);
  });

  it('refuses a nonsensical TTL at module load, not at request time', () => {
    expect(() => Idempotent({ ttlHours: 0 })).toThrow(/ttlHours/);
    expect(() => Idempotent({ ttlHours: 5000 })).toThrow(/ttlHours/);
  });

  it('refuses a lock shorter than a realistic handler', () => {
    expect(() => Idempotent({ lockSeconds: 1 })).toThrow(/lockSeconds/);
  });

  it('accepts a route that legitimately needs a longer window', () => {
    expect(() => Idempotent({ ttlHours: 48, lockSeconds: 300 })).not.toThrow();
  });
});
