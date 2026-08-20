import type { Pool, PoolClient } from 'pg';

/**
 * The one write primitive the seeds use.
 *
 * `docs/03 §Migrations`: "Seeds are idempotent (`upsert`)." That is a stronger
 * requirement than "re-running does not crash" — re-running must leave the
 * database **byte-identical**, otherwise "the second run changed nothing" cannot
 * be asserted. Three things make that true here:
 *
 *   1. Conflict is always on the primary key, and every seeded primary key is a
 *      deterministic hash of what the row is (`seedId`). Conflicting on a unique
 *      constraint would not work for the tables whose natural key includes a
 *      nullable `hospital_id` — NULLs are distinct in a unique index, so the 64
 *      system role templates would be inserted afresh on every run.
 *   2. `DO UPDATE … WHERE` compares the business columns and skips the write
 *      entirely when nothing differs. Postgres reports `rowCount = 0` for a
 *      conflicting row that was not updated, which is exactly the signal the
 *      idempotency proof needs, and it means `updated_at` is not bumped by a
 *      no-op run.
 *   3. `created_at`, `created_by` and anything else listed as `immutable` are
 *      written on insert and never on update — so a re-run cannot rewrite
 *      provenance, and a non-deterministic value such as an Argon2id hash (which
 *      carries a fresh salt every time it is computed) stays stable.
 *
 * Raw SQL rather than the Prisma client is deliberate. `ON CONFLICT … DO UPDATE
 * … WHERE (…) IS DISTINCT FROM (…)` has no Prisma equivalent — `upsert()` always
 * issues the update — and without it every re-run would touch every row.
 */

export type SeedValue =
  | string
  | number
  | boolean
  | Date
  | Buffer
  | null
  | readonly string[]
  | readonly Date[]
  | Record<string, unknown>;
export type SeedRow = Record<string, SeedValue>;

export interface UpsertOptions {
  /** Qualified table name, e.g. `core.hospitals`. */
  readonly table: string;
  /** Conflict target — the primary-key column(s). */
  readonly conflict: readonly string[];
  /** Columns written on insert but never on update. `created_at` is implicit. */
  readonly immutable?: readonly string[];
}

export interface UpsertResult {
  readonly table: string;
  /** Rows presented. */
  readonly presented: number;
  /** Rows actually inserted or updated. Zero on a clean re-run. */
  readonly written: number;
}

const ALWAYS_IMMUTABLE = ['created_at', 'created_by'] as const;

/** Chunked so a 20 000-row volume seed does not exceed the 65 535 bind-parameter limit. */
function chunkSize(columns: number): number {
  return Math.max(1, Math.floor(60_000 / Math.max(1, columns)));
}

export async function upsert(
  db: Pool | PoolClient,
  options: UpsertOptions,
  rows: readonly SeedRow[],
): Promise<UpsertResult> {
  if (rows.length === 0) return { table: options.table, presented: 0, written: 0 };

  const first = rows[0];
  if (first === undefined) return { table: options.table, presented: 0, written: 0 };
  const columns = Object.keys(first);

  const immutable = new Set<string>([...ALWAYS_IMMUTABLE, ...(options.immutable ?? [])]);
  const conflict = new Set(options.conflict);
  // `updated_at` is set when something else changed, but is never itself a
  // reason to write — otherwise every run would differ from the last.
  const compared = columns.filter((c) => !conflict.has(c) && !immutable.has(c) && c !== 'updated_at');
  const updated = columns.filter((c) => !conflict.has(c) && !immutable.has(c));

  const quoted = columns.map((c) => `"${c}"`).join(', ');
  const conflictSql = options.conflict.map((c) => `"${c}"`).join(', ');

  let written = 0;
  const size = chunkSize(columns.length);

  for (let offset = 0; offset < rows.length; offset += size) {
    const slice = rows.slice(offset, offset + size);
    const params: SeedValue[] = [];
    const tuples = slice.map((row) => {
      const placeholders = columns.map((column) => {
        params.push(normalise(row[column]));
        return `$${params.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    let sql = `INSERT INTO ${options.table} (${quoted}) VALUES ${tuples.join(', ')}`;
    if (updated.length === 0) {
      sql += ` ON CONFLICT (${conflictSql}) DO NOTHING`;
    } else {
      const assignments = updated.map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
      sql += ` ON CONFLICT (${conflictSql}) DO UPDATE SET ${assignments}`;
      if (compared.length > 0) {
        const left = compared.map((c) => `${qualify(options.table)}."${c}"`).join(', ');
        const right = compared.map((c) => `EXCLUDED."${c}"`).join(', ');
        sql += ` WHERE (${left}) IS DISTINCT FROM (${right})`;
      }
    }

    const result = await db.query(sql, params as unknown[]);
    written += result.rowCount ?? 0;
  }

  return { table: options.table, presented: rows.length, written };
}

/**
 * Wraps a value destined for a `jsonb` column.
 *
 * A JSONB parameter is sent as text and parsed by Postgres, so a bare JS string
 * would arrive as invalid JSON (`abc` rather than `"abc"`) and a bare number
 * would happen to work — an inconsistency that fails only for some settings
 * keys. Encoding explicitly removes the class of bug.
 */
export function jsonb(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** `core.hospitals` → `hospitals`, which is how ON CONFLICT DO UPDATE refers to the target row. */
function qualify(table: string): string {
  const parts = table.split('.');
  return `"${parts[parts.length - 1] ?? table}"`;
}

/**
 * node-pg serialises plain objects as `[object Object]`, so JSON/JSONB values
 * must be stringified. Arrays are left alone — the driver renders them as a
 * Postgres array literal, and the target column's type does the casting.
 */
function normalise(value: SeedValue | undefined): SeedValue {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value;
  // A Buffer is a `bytea` parameter, not JSON. It is also an object and an
  // Uint8Array, so it has to be recognised before either of the branches below
  // — stringifying one produces `{"type":"Buffer","data":[…]}`, which Postgres
  // stores as a hex-encoded copy of that JSON rather than as the bytes.
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value as readonly string[];
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}
