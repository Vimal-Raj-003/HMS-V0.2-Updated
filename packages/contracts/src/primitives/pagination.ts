/**
 * Cursor (keyset) pagination.
 *
 * `docs/07 §4`: "Cursor pagination. Mandatory above 100k rows; keyset on
 * `(created_at, id)` ... `OFFSET` is banned (lint rule on repository code).
 * Page sizes: 25 default, 100 max interactive, 1,000 for machine consumers.
 * Cursors are opaque base64 of the sort tuple, **signed, tenant-scoped**."
 *
 * The signature is not decoration: an unsigned cursor is a client-supplied SQL
 * predicate. Tenant-scoping it means a cursor lifted from one hospital's session
 * cannot be replayed against another's list endpoint.
 */
import { z } from 'zod';

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX_INTERACTIVE = 100;
export const PAGE_SIZE_MAX_MACHINE = 1000;

/** The decoded sort tuple. `k` values are the ordered sort keys, `id` the tiebreaker. */
export interface CursorPayload {
  /** Tenant this cursor was minted for — checked on every use. */
  readonly h: string;
  /** Resource key, so a cursor for `users` cannot be replayed against `audit`. */
  readonly r: string;
  /** Sort key values, in the same order as the query's ORDER BY. */
  readonly k: readonly (string | number | null)[];
  /** UUID tiebreaker. */
  readonly id: string;
  /** Sort direction the cursor was minted under; changing sort invalidates it. */
  readonly d: 'asc' | 'desc';
}

export const cursorPayloadSchema = z.object({
  h: z.string().uuid(),
  r: z.string().min(1).max(64),
  k: z.array(z.union([z.string(), z.number(), z.null()])).max(4),
  id: z.string().uuid(),
  d: z.enum(['asc', 'desc']),
});

export const paginationQuerySchema = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX_MACHINE).default(PAGE_SIZE_DEFAULT),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque signed cursor for the next page; `null` when the list is exhausted. */
  readonly nextCursor: string | null;
  /**
   * Deliberately **not** a total count. `docs/07 §4` bans OFFSET, and a
   * `COUNT(*)` over a partitioned 40-million-row table to render "1 of 4,213"
   * costs more than the page itself. Screens show "68 items" only where the
   * count is cheap (a partial index) or comes from a read model.
   */
  readonly hasMore: boolean;
}

/**
 * Enforce the interactive ceiling. Machine consumers (`/api/v1/**` with a
 * gateway client credential, EN-026) may request up to 1000; a browser may not,
 * because a 1000-row clinical worklist is a rendering and a privacy problem.
 */
export function clampPageSize(requested: number, audience: 'interactive' | 'machine'): number {
  const max = audience === 'machine' ? PAGE_SIZE_MAX_MACHINE : PAGE_SIZE_MAX_INTERACTIVE;
  return Math.min(Math.max(1, Math.trunc(requested)), max);
}

/** Signer interface — implemented in the API with the service's HMAC key. */
export interface CursorCodec {
  encode(payload: CursorPayload): string;
  /** Throws when the signature, tenant or resource does not match. */
  decode(cursor: string, expect: { hospitalId: string; resource: string }): CursorPayload;
}
