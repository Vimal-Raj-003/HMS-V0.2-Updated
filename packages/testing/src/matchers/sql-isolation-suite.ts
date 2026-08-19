import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import type { TestPostgres } from '../containers/postgres.js';

/**
 * Runs `packages/db/src/rls/verify-isolation.sql` and reports each case.
 *
 * That file already exists and already proves the SQL-level half of
 * `docs/09` §3.1 — but until now it could only be run by hand
 * (`docker exec ... psql -f -`), which means it was not run by CI and could rot
 * silently. Bringing it into vitest costs one function and turns a manual ritual
 * into a build gate.
 *
 * It is deliberately *not* reimplemented in TypeScript. The SQL version is the
 * artefact the DBA reviews and the one `EN-041 §3.9.9` runs against a live
 * branch before go-live; a second implementation would drift from it.
 *
 * The script signals results as `RAISE NOTICE 'PASS case ...'` /
 * `RAISE WARNING 'FAIL case ...'` and finally `RAISE EXCEPTION` if any failed,
 * so we capture the notice stream to report *which* case broke rather than only
 * that something did.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SUITE_PATH = join(REPO_ROOT, 'packages', 'db', 'src', 'rls', 'verify-isolation.sql');

export interface SqlIsolationCase {
  readonly id: string;
  readonly passed: boolean;
  readonly message: string;
}

export interface SqlIsolationResult {
  readonly cases: readonly SqlIsolationCase[];
  readonly passed: number;
  readonly failed: number;
  readonly ok: boolean;
  /** Present when the script raised — i.e. at least one case failed. */
  readonly error?: string;
}

const CASE_RE = /^(PASS|FAIL) (case [0-9a-z]+):\s*(.*)$/i;

export async function runSqlIsolationSuite(pg: TestPostgres): Promise<SqlIsolationResult> {
  // psql meta-commands (`\set`, `\connect`) are not valid over the wire protocol.
  const sql = readFileSync(SUITE_PATH, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('\\'))
    .join('\n');

  const client = new Client({
    host: pg.host,
    port: pg.port,
    database: pg.database,
    // The suite inspects catalogues and calls the sealer, so it runs as the
    // schema owner — exactly as the documented `psql` invocation does.
    user: 'hms_migrator',
    password: 'hms_migrator_dev',
  });

  const cases: SqlIsolationCase[] = [];
  client.on('notice', (notice) => {
    const text = (notice.message ?? '').trim();
    const match = CASE_RE.exec(text);
    if (match) {
      const [, verdict, id, message] = match;
      cases.push({
        id: (id ?? 'case ?').toLowerCase(),
        passed: (verdict ?? '').toUpperCase() === 'PASS',
        message: message ?? '',
      });
    }
  });

  await client.connect();
  let error: string | undefined;
  try {
    await client.query('SET client_min_messages = notice');
    await client.query(sql);
  } catch (raised) {
    error = raised instanceof Error ? raised.message : String(raised);
  } finally {
    await client.end();
  }

  const passed = cases.filter((c) => c.passed).length;
  const failed = cases.length - passed;

  return {
    cases,
    passed,
    failed,
    ok: failed === 0 && error === undefined,
    ...(error === undefined ? {} : { error }),
  };
}
