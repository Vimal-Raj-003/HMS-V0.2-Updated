import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX_INTERACTIVE,
  PAGE_SIZE_MAX_MACHINE,
  clampPageSize,
  cursorPayloadSchema,
  paginationQuerySchema,
} from './pagination.js';
import type { CursorCodec, CursorPayload } from './pagination.js';

/**
 * `docs/07 §4`: "Cursors are opaque base64 of the sort tuple, **signed,
 * tenant-scoped**." The sentence matters because an unsigned cursor is a
 * client-supplied SQL predicate and an untenanted one is a cross-tenant read —
 * i.e. exactly the leak `docs/09 §3.1` exists to prevent.
 *
 * `CursorCodec` is an interface implemented in the API with the service HMAC key,
 * so the conformance suite below runs a reference implementation against the
 * contract every implementation must satisfy.
 */

const HOSPITAL_A = '0194f2c0-0000-7000-8000-00000000000a';
const HOSPITAL_B = '0194f2c0-0000-7000-8000-00000000000b';
const ROW_ID = '0194f2c0-0000-7000-8000-000000000001';

describe('page-size clamping', () => {
  it('uses the documented default and ceilings', () => {
    expect(PAGE_SIZE_DEFAULT).toBe(25);
    expect(PAGE_SIZE_MAX_INTERACTIVE).toBe(100);
    expect(PAGE_SIZE_MAX_MACHINE).toBe(1000);
  });

  it('caps a browser at 100 rows however many it asks for', () => {
    // docs/07 §4: a 1000-row clinical worklist is a rendering and a privacy problem.
    expect(clampPageSize(1000, 'interactive')).toBe(100);
    expect(clampPageSize(101, 'interactive')).toBe(100);
    expect(clampPageSize(100, 'interactive')).toBe(100);
    expect(clampPageSize(25, 'interactive')).toBe(25);
  });

  it('lets a machine consumer reach 1000 but no further', () => {
    expect(clampPageSize(1000, 'machine')).toBe(1000);
    expect(clampPageSize(50_000, 'machine')).toBe(1000);
    expect(clampPageSize(250, 'machine')).toBe(250);
  });

  it('never returns zero or a negative page size', () => {
    // A zero page size turns a paginated loop into an infinite one.
    expect(clampPageSize(0, 'interactive')).toBe(1);
    expect(clampPageSize(-40, 'interactive')).toBe(1);
    expect(clampPageSize(-40, 'machine')).toBe(1);
  });

  it('truncates a fractional request toward zero rather than rejecting it', () => {
    expect(clampPageSize(25.9, 'interactive')).toBe(25);
    expect(clampPageSize(0.9, 'interactive')).toBe(1);
  });
});

describe('pagination query', () => {
  it('defaults to 25 rows when the client asks for nothing', () => {
    const parsed = paginationQuerySchema.parse({});
    expect(parsed.limit).toBe(PAGE_SIZE_DEFAULT);
    expect(parsed.cursor).toBeUndefined();
  });

  it('coerces the limit from the query string, because query params are strings', () => {
    expect(paginationQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('refuses a limit outside the machine ceiling instead of silently clamping', () => {
    // Silent clamping at the DTO layer hides a misconfigured integration; the
    // caller should learn its request was wrong.
    expect(paginationQuerySchema.safeParse({ limit: '1001' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '-1' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: '10.5' }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: 'all' }).success).toBe(false);
  });

  it('bounds the cursor length so a crafted cursor cannot be an attack surface', () => {
    expect(paginationQuerySchema.safeParse({ cursor: 'a'.repeat(2048) }).success).toBe(true);
    expect(paginationQuerySchema.safeParse({ cursor: 'a'.repeat(2049) }).success).toBe(false);
  });
});

describe('cursor payload', () => {
  const valid: CursorPayload = {
    h: HOSPITAL_A,
    r: 'users',
    k: ['2026-08-17T10:00:00.000Z'],
    id: ROW_ID,
    d: 'desc',
  };

  it('accepts a well-formed keyset tuple', () => {
    expect(cursorPayloadSchema.safeParse(valid).success).toBe(true);
  });

  it('requires a tenant on the cursor itself — there is no untenanted cursor', () => {
    // docs/07 §4: tenant-scoped. Without `h` the decoder has nothing to compare
    // against and a cursor lifted from another session would simply work.
    const { h: _omitted, ...withoutTenant } = valid;
    expect(cursorPayloadSchema.safeParse(withoutTenant).success).toBe(false);
    expect(cursorPayloadSchema.safeParse({ ...valid, h: 'hospital-a' }).success).toBe(false);
    expect(cursorPayloadSchema.safeParse({ ...valid, h: null }).success).toBe(false);
  });

  it('requires the resource key, so a users cursor cannot be replayed against audit', () => {
    const { r: _omitted, ...withoutResource } = valid;
    expect(cursorPayloadSchema.safeParse(withoutResource).success).toBe(false);
    expect(cursorPayloadSchema.safeParse({ ...valid, r: '' }).success).toBe(false);
    expect(cursorPayloadSchema.safeParse({ ...valid, r: 'x'.repeat(65) }).success).toBe(false);
  });

  it('requires a uuid tiebreaker, because keyset order needs a total order', () => {
    expect(cursorPayloadSchema.safeParse({ ...valid, id: '42' }).success).toBe(false);
  });

  it('records the sort direction, so changing the sort invalidates the cursor', () => {
    expect(cursorPayloadSchema.safeParse({ ...valid, d: 'asc' }).success).toBe(true);
    expect(cursorPayloadSchema.safeParse({ ...valid, d: 'ascending' }).success).toBe(false);
  });

  it('accepts only scalar sort keys, and at most four of them', () => {
    // Anything richer than a scalar would end up interpolated into an ORDER BY
    // comparison; four keys is already more than any registered query uses.
    expect(cursorPayloadSchema.safeParse({ ...valid, k: ['a', 1, null, 'd'] }).success).toBe(true);
    expect(cursorPayloadSchema.safeParse({ ...valid, k: ['a', 1, null, 'd', 'e'] }).success).toBe(false);
    expect(cursorPayloadSchema.safeParse({ ...valid, k: [{ sql: '1=1' }] }).success).toBe(false);
    expect(cursorPayloadSchema.safeParse({ ...valid, k: [['nested']] }).success).toBe(false);
  });
});

/**
 * Conformance suite for the `CursorCodec` contract. The reference implementation
 * is deliberately minimal — the assertions are about the contract, not about this
 * code: a codec that fails any of them would let a cursor cross a tenant boundary
 * or carry an attacker-chosen predicate into a WHERE clause.
 */
function referenceCodec(secret: string): CursorCodec {
  const sign = (body: string): string =>
    createHmac('sha256', secret).update(body).digest('base64url');

  return {
    encode(payload: CursorPayload): string {
      const body = Buffer.from(JSON.stringify(cursorPayloadSchema.parse(payload))).toString('base64url');
      return `${body}.${sign(body)}`;
    },
    decode(cursor: string, expect_: { hospitalId: string; resource: string }): CursorPayload {
      const [body, mac] = cursor.split('.');
      if (body === undefined || mac === undefined) throw new Error('Malformed cursor');
      const expected = Buffer.from(sign(body));
      const actual = Buffer.from(mac);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new Error('Cursor signature does not verify');
      }
      const payload = cursorPayloadSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString()));
      if (payload.h !== expect_.hospitalId) throw new Error('Cursor was minted for another tenant');
      if (payload.r !== expect_.resource) throw new Error('Cursor was minted for another resource');
      return payload;
    },
  };
}

describe('cursor codec contract', () => {
  const codec = referenceCodec('service-hmac-key');
  const payload: CursorPayload = { h: HOSPITAL_A, r: 'users', k: ['2026-08-17T10:00:00.000Z'], id: ROW_ID, d: 'desc' };
  const cursor = codec.encode(payload);
  const forA = { hospitalId: HOSPITAL_A, resource: 'users' };

  it('round-trips the sort tuple unchanged', () => {
    expect(codec.decode(cursor, forA)).toEqual(payload);
  });

  it('is opaque — the sort tuple is not readable as plain text', () => {
    expect(cursor).not.toContain('created_at');
    expect(cursor).not.toContain(ROW_ID);
  });

  it('refuses a cursor minted for another hospital', () => {
    // docs/09 §3.1: a cursor lifted from hospital A's session must not page
    // hospital B's list endpoint — and vice versa.
    expect(() => codec.decode(cursor, { hospitalId: HOSPITAL_B, resource: 'users' })).toThrow(/another tenant/);
  });

  it('refuses a cursor minted for another resource', () => {
    expect(() => codec.decode(cursor, { hospitalId: HOSPITAL_A, resource: 'audit' })).toThrow(/another resource/);
  });

  it('refuses a cursor whose payload was edited, even by one character', () => {
    const [body, mac] = cursor.split('.');
    const tampered = Buffer.from(
      JSON.stringify({ ...payload, h: HOSPITAL_B }),
    ).toString('base64url');
    expect(tampered).not.toBe(body);
    expect(() => codec.decode(`${tampered}.${mac ?? ''}`, forA)).toThrow(/signature/);
  });

  it('refuses a cursor signed with a different key', () => {
    const other = referenceCodec('some-other-key').encode(payload);
    expect(() => codec.decode(other, forA)).toThrow(/signature/);
  });

  it('refuses an unsigned or truncated cursor rather than treating it as empty', () => {
    const [body] = cursor.split('.');
    expect(() => codec.decode(body ?? '', forA)).toThrow();
    expect(() => codec.decode('', forA)).toThrow();
    expect(() => codec.decode(`${body ?? ''}.`, forA)).toThrow(/signature/);
  });
});
