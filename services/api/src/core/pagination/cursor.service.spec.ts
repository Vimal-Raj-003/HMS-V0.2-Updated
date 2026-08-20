import { Buffer } from 'node:buffer';
import type { CursorPayload } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import {
  CursorService,
  buildPage,
  decodeCursorWith,
  deriveCursorKey,
  encodeCursorWith,
} from './cursor.service.js';
import type { Env } from '../config/env.js';

const HOSPITAL_A = '018f4b5c-0000-7000-8000-00000000000a';
const HOSPITAL_B = '018f4b5c-0000-7000-8000-00000000000b';
const ROW_ID = '018f4b5c-0000-7000-8000-0000000000ff';

const KEY = deriveCursorKey('a'.repeat(48));
const forUsersInA = { hospitalId: HOSPITAL_A, resource: 'users' };
const payload: CursorPayload = {
  h: HOSPITAL_A,
  r: 'users',
  k: ['2026-08-20T10:00:00.000Z'],
  id: ROW_ID,
  d: 'desc',
};

describe('cursor key derivation', () => {
  it('does not reuse the JWT secret as the signing key', () => {
    // Recovering the cursor key from a leaked cursor must not hand over the
    // token-signing secret with it.
    expect(KEY.toString('utf8')).not.toContain('a'.repeat(48));
    expect(KEY).toHaveLength(32);
  });

  it('changes when the source secret changes, so rotating tokens rotates cursors', () => {
    expect(deriveCursorKey('b'.repeat(48)).equals(KEY)).toBe(false);
  });

  it('is deterministic, so two API instances agree on a cursor', () => {
    expect(deriveCursorKey('a'.repeat(48)).equals(KEY)).toBe(true);
  });
});

describe('cursor codec', () => {
  const cursor = encodeCursorWith(KEY, payload);

  it('round-trips the sort tuple unchanged', () => {
    expect(decodeCursorWith(KEY, cursor, forUsersInA)).toEqual(payload);
  });

  it('is opaque — the sort tuple is not readable in the wire form', () => {
    expect(cursor).not.toContain(ROW_ID);
    expect(cursor).not.toContain('2026-08-20');
  });

  it('refuses a cursor minted for another hospital', () => {
    expect(() => decodeCursorWith(KEY, cursor, { hospitalId: HOSPITAL_B, resource: 'users' })).toThrow(
      /not valid for this list/,
    );
  });

  it('refuses a cursor minted for another resource', () => {
    expect(() => decodeCursorWith(KEY, cursor, { hospitalId: HOSPITAL_A, resource: 'audit' })).toThrow(
      /not valid for this list/,
    );
  });

  it('refuses a payload edited by one character, even with the old signature', () => {
    const mac = cursor.slice(cursor.lastIndexOf('.') + 1);
    const tampered = Buffer.from(JSON.stringify({ ...payload, h: HOSPITAL_B })).toString('base64url');
    expect(() => decodeCursorWith(KEY, `${tampered}.${mac}`, forUsersInA)).toThrow();
  });

  it('refuses a cursor signed with a different key', () => {
    const foreign = encodeCursorWith(deriveCursorKey('z'.repeat(48)), payload);
    expect(() => decodeCursorWith(KEY, foreign, forUsersInA)).toThrow();
  });

  it('refuses an unsigned, empty or truncated cursor rather than treating it as page one', () => {
    const body = cursor.slice(0, cursor.lastIndexOf('.'));
    expect(() => decodeCursorWith(KEY, body, forUsersInA)).toThrow();
    expect(() => decodeCursorWith(KEY, '', forUsersInA)).toThrow();
    expect(() => decodeCursorWith(KEY, `${body}.`, forUsersInA)).toThrow();
    expect(() => decodeCursorWith(KEY, '.abc', forUsersInA)).toThrow();
  });

  it('reports a 400, not a 500, for a corrupt cursor', () => {
    try {
      decodeCursorWith(KEY, 'not-a-cursor.at-all', forUsersInA);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as { status: number }).status).toBe(400);
    }
  });
});

interface Row {
  readonly id: string;
  readonly createdAt: string;
}

function rows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `018f4b5c-0000-7000-8000-0000000000${(16 + i).toString(16).padStart(2, '0')}`,
    createdAt: `2026-08-20T10:00:${String(59 - i).padStart(2, '0')}.000Z`,
  }));
}

describe('page building', () => {
  const options = {
    hospitalId: HOSPITAL_A,
    resource: 'users',
    direction: 'desc' as const,
    sortKeys: (r: Row) => [r.createdAt],
  };
  const encode = (p: CursorPayload): string => encodeCursorWith(KEY, p);

  it('trims the probe row and reports more', () => {
    const page = buildPage(rows(11), 10, options, encode);
    expect(page.items).toHaveLength(10);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('mints the cursor from the last row it actually returned, not the probe', () => {
    const fetched = rows(11);
    const page = buildPage(fetched, 10, options, encode);
    const decoded = decodeCursorWith(KEY, page.nextCursor ?? '', forUsersInA);
    expect(decoded.id).toBe(fetched[9]?.id);
    expect(decoded.k).toEqual([fetched[9]?.createdAt]);
  });

  it('returns no cursor on the last page, so a client knows to stop', () => {
    const page = buildPage(rows(4), 10, options, encode);
    expect(page.items).toHaveLength(4);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result without minting a cursor', () => {
    const page = buildPage([], 10, options, encode);
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('never reports a total — docs/07 §4 rules out COUNT(*) for paging', () => {
    expect(buildPage(rows(11), 10, options, encode)).not.toHaveProperty('total');
  });
});

describe('CursorService', () => {
  const service = new CursorService({ JWT_ACCESS_SECRET: 'a'.repeat(48) } as Env);

  it('clamps a browser page size to the interactive ceiling', () => {
    expect(service.pageSize(5000)).toBe(100);
    expect(service.pageSize(0)).toBe(1);
    expect(service.pageSize(25)).toBe(25);
  });

  it('treats a missing cursor as the first page and a bad one as an error', () => {
    expect(service.start(undefined, forUsersInA)).toBeNull();
    expect(service.start('', forUsersInA)).toBeNull();
    expect(() => service.start('garbage', forUsersInA)).toThrow();
  });

  it('agrees with the standalone functions, so tests and runtime share one format', () => {
    expect(service.decode(encodeCursorWith(KEY, payload), forUsersInA)).toEqual(payload);
  });
});

interface KeyedRow {
  readonly id: string;
  readonly name: string;
  readonly cursor_key: string;
}

describe('keysetPage', () => {
  const service = new CursorService({ JWT_ACCESS_SECRET: 'a'.repeat(48) } as Env);
  const options = { hospitalId: HOSPITAL_A, resource: 'users', direction: 'desc' as const };

  const fetched: KeyedRow[] = [
    { id: '018f4b5c-0000-7000-8000-000000000001', name: 'a', cursor_key: '2026-08-20 16:44:28.676123+00' },
    { id: '018f4b5c-0000-7000-8000-000000000002', name: 'b', cursor_key: '2026-08-20 16:44:28.676050+00' },
    { id: '018f4b5c-0000-7000-8000-000000000003', name: 'c', cursor_key: '2026-08-20 16:44:28.675900+00' },
  ];

  it('strips the sort-key alias from the items it returns', () => {
    const page = service.keysetPage<Omit<KeyedRow, 'cursor_key'>>(fetched, 2, options);
    expect(page.items).toEqual([
      { id: fetched[0]?.id, name: 'a' },
      { id: fetched[1]?.id, name: 'b' },
    ]);
    expect(JSON.stringify(page.items)).not.toContain('cursor_key');
  });

  /**
   * The regression this method exists for. A JavaScript `Date` holds
   * milliseconds and `timestamptz` holds microseconds, so minting the cursor
   * from a parsed date truncates it — and the next page then asks for rows
   * strictly earlier than a moment up to 999 µs before the row the cursor names,
   * skipping everything in that window. Only pages 2 and later are affected,
   * which is exactly the kind of bug a single-page test never sees.
   */
  it('carries the database’s microsecond precision into the cursor, unrounded', () => {
    const page = service.keysetPage<Omit<KeyedRow, 'cursor_key'>>(fetched, 2, options);
    const decoded = service.decode(page.nextCursor ?? '', forUsersInA);
    expect(decoded.k).toEqual(['2026-08-20 16:44:28.676050+00']);
    expect(decoded.id).toBe(fetched[1]?.id);
  });

  it('reports the end of the list without a cursor', () => {
    const page = service.keysetPage<Omit<KeyedRow, 'cursor_key'>>(fetched, 5, options);
    expect(page.items).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });
});
