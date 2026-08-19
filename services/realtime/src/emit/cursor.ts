/**
 * The reconnect cursor.
 *
 * `docs/01` §6: "clients reconcile with a REST snapshot on reconnect
 * (`?since=<cursor>`)". For that sentence to be implementable the client has to
 * be *given* a cursor, and the cursor has to mean something both ends agree on.
 *
 * Here it means: "you have seen every push to this room up to and including
 * sequence `seq`, emitted at `emittedAt`." It is monotonic per room, opaque to
 * the client (so its shape can change), and carries no tenant or patient data —
 * it travels in a URL query string, where `docs/04` §7 allows no identifiers.
 */
export interface CursorParts {
  /** Unix epoch milliseconds of the push. */
  readonly emittedAt: number;
  /** Monotonic per-room sequence, starting at 1. */
  readonly seq: number;
}

/** The cursor a client holds before it has ever received a push. */
export const INITIAL_CURSOR_SEQ = 0;

export function encodeCursor(parts: CursorParts): string {
  return Buffer.from(`${parts.emittedAt}.${parts.seq}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorParts | null {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 128) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const dot = decoded.indexOf('.');
  if (dot <= 0) return null;
  const emittedAt = Number(decoded.slice(0, dot));
  const seq = Number(decoded.slice(dot + 1));
  if (!Number.isSafeInteger(emittedAt) || !Number.isSafeInteger(seq)) return null;
  if (emittedAt < 0 || seq < 0) return null;
  return { emittedAt, seq };
}

/**
 * Is the client's cursor still adjacent to the room's current one?
 *
 * `false` means the client missed at least one coalesced push and must refetch
 * the REST snapshot rather than apply the next diff on top of a stale base —
 * applying a diff to the wrong base is how a bed board ends up showing a
 * discharged patient.
 */
export function isCursorCurrent(clientCursor: string | undefined, roomSeq: number): boolean {
  if (clientCursor === undefined) return roomSeq === INITIAL_CURSOR_SEQ;
  const parts = decodeCursor(clientCursor);
  if (parts === null) return false;
  return parts.seq === roomSeq;
}
