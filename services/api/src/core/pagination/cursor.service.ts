import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  ProblemType,
  clampPageSize,
  cursorPayloadSchema,
  type CursorCodec,
  type CursorPayload,
  type Page,
} from '@vims/contracts';
import { ENV, type Env } from '../config/env.js';
import { AppError } from '../problem/app-error.js';

/**
 * The signed, tenant-scoped cursor codec — the other half of `docs/07` §4's
 * "`OFFSET` is banned".
 *
 * A cursor is a **client-supplied fragment of a WHERE clause**. That is the
 * whole reason it is signed rather than merely base64-encoded: an unsigned
 * cursor lets the caller choose the keyset predicate, and a cursor that does not
 * carry its tenant lets a cursor lifted from hospital A's session page hospital
 * B's list endpoint (`docs/09` §3.1 case 3). RLS would still filter the rows, so
 * this is defence in depth rather than the only defence — but the cheap control
 * belongs at the edge where the value enters.
 *
 * The resource name is bound in too, so a cursor minted for `users` cannot be
 * replayed against `audit`, where the same sort tuple means something else
 * entirely.
 */

/**
 * Domain separation: the cursor key is derived from the access-token secret
 * rather than being its own environment variable.
 *
 * Adding a required secret would break every existing deployment and every test
 * that boots the app, and giving it a default would put a publicly-known signing
 * key in the source tree. Deriving it through HMAC means the two keys are
 * independent — recovering the cursor key does not reveal the JWT secret — while
 * rotating the JWT secret rotates this one too, which is the correct coupling:
 * old cursors stop verifying at exactly the moment old sessions stop working.
 */
const CURSOR_KEY_INFO = 'vims:cursor-signing:v1';

export function deriveCursorKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(CURSOR_KEY_INFO).digest();
}

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

export function encodeCursorWith(key: Buffer, payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(cursorPayloadSchema.parse(payload))).toString('base64url');
  return `${body}.${sign(key, body)}`;
}

export interface CursorExpectation {
  readonly hospitalId: string;
  readonly resource: string;
}

/**
 * Every rejection is the same problem type and the same message.
 *
 * A tampered cursor, a cursor from another tenant and a cursor for another
 * resource are all "this cursor is not usable here"; distinguishing them in the
 * response would tell an attacker which of the three checks they had defeated.
 */
function refuse(): never {
  throw new AppError(
    ProblemType.VALIDATION_FAILED,
    'The page cursor is not valid for this list. Reload the first page.',
    { nextAction: 'Reload the list without a cursor.' },
  );
}

export function decodeCursorWith(key: Buffer, cursor: string, expect: CursorExpectation): CursorPayload {
  const separator = cursor.lastIndexOf('.');
  if (separator <= 0 || separator === cursor.length - 1) refuse();

  const body = cursor.slice(0, separator);
  const mac = cursor.slice(separator + 1);

  const expected = Buffer.from(sign(key, body));
  const actual = Buffer.from(mac);
  // Length is compared first because `timingSafeEqual` throws on a mismatch
  // rather than returning false, and a thrown RangeError here would surface as a
  // 500 instead of a 400.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) refuse();

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    refuse();
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) refuse();
  if (result.data.h !== expect.hospitalId) refuse();
  if (result.data.r !== expect.resource) refuse();
  return result.data;
}

export interface PageOptions<T> {
  readonly hospitalId: string;
  /** Binds the cursor to one list, so it cannot be replayed against another. */
  readonly resource: string;
  readonly direction: 'asc' | 'desc';
  /** The sort-key values of a row, in the same order as the query's ORDER BY. */
  readonly sortKeys: (row: T) => readonly (string | number | null)[];
}

/**
 * Turns `limit + 1` fetched rows into a page.
 *
 * Fetching one extra row is how `hasMore` is known without a `COUNT(*)`, which
 * `docs/07` §4 rules out: counting a partitioned 40-million-row table to render
 * "page 3 of 4,213" costs more than the page itself.
 */
export function buildPage<T extends { readonly id: string }>(
  fetched: readonly T[],
  limit: number,
  options: PageOptions<T>,
  encode: (payload: CursorPayload) => string,
): Page<T> {
  const hasMore = fetched.length > limit;
  const items = hasMore ? fetched.slice(0, limit) : fetched;
  const last = items[items.length - 1];

  const nextCursor =
    hasMore && last !== undefined
      ? encode({
          h: options.hospitalId,
          r: options.resource,
          k: options.sortKeys(last),
          id: last.id,
          d: options.direction,
        })
      : null;

  return { items, nextCursor, hasMore };
}

@Injectable()
export class CursorService implements CursorCodec {
  private readonly key: Buffer;

  constructor(@Inject(ENV) env: Env) {
    this.key = deriveCursorKey(env.JWT_ACCESS_SECRET);
  }

  encode(payload: CursorPayload): string {
    return encodeCursorWith(this.key, payload);
  }

  decode(cursor: string, expect: CursorExpectation): CursorPayload {
    return decodeCursorWith(this.key, cursor, expect);
  }

  /**
   * `docs/07` §4: 25 default, **100 max interactive**. Admin console screens are
   * browser screens, so they get the interactive ceiling — a 1000-row user list
   * is a rendering problem and, since the rows are HR-class data, a privacy one.
   */
  pageSize(requested: number): number {
    return clampPageSize(requested, 'interactive');
  }

  /**
   * Decodes an optional cursor. `undefined` means "first page", which is a
   * different thing from a cursor that fails to verify — the latter is refused
   * rather than silently treated as the first page, because silently restarting
   * a paginated export would duplicate rows without anybody noticing.
   */
  start(cursor: string | undefined, expect: CursorExpectation): CursorPayload | null {
    if (cursor === undefined || cursor.length === 0) return null;
    return this.decode(cursor, expect);
  }

  page<T extends { readonly id: string }>(
    fetched: readonly T[],
    limit: number,
    options: PageOptions<T>,
  ): Page<T> {
    return buildPage(fetched, limit, options, (payload) => this.encode(payload));
  }

  /**
   * The shape every list in this service actually uses: keyset on
   * `(<sort column>, id)` where the sort column arrives as an **exact text
   * rendering** from Postgres, aliased `cursor_key`.
   *
   * The text detour is not fussiness. `timestamptz` has microsecond resolution
   * and a JavaScript `Date` has millisecond resolution, so minting a cursor from
   * the parsed value truncates it — and the next page then asks for rows
   * strictly before a moment that is up to 999 µs *earlier* than the row the
   * cursor names. Every row in that window is skipped, silently, and only on
   * pages 2 and later. Selecting `created_at::text` and passing it back through
   * `::timestamptz` round-trips exactly.
   *
   * The alias is stripped from the returned items, so it never becomes part of
   * the API's shape.
   */
  keysetPage<T extends { readonly id: string }>(
    fetched: readonly (T & { readonly cursor_key: string })[],
    limit: number,
    options: { readonly hospitalId: string; readonly resource: string; readonly direction: 'asc' | 'desc' },
  ): Page<T> {
    const page = buildPage(
      fetched,
      limit,
      { ...options, sortKeys: (row) => [row.cursor_key] },
      (payload) => this.encode(payload),
    );

    return {
      items: page.items.map(({ cursor_key: _cursorKey, ...rest }) => rest as unknown as T),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
}
