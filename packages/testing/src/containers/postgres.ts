import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * A PostgreSQL 17 container built from `infra/docker/postgres`.
 *
 * It deliberately does **not** use the stock `postgres:17` image. Half of what
 * `packages/db` asserts depends on things the stock image does not have — the
 * `ext` schema, pgvector, pg_partman, pgaudit, the four least-privilege roles,
 * and the per-role `statement_timeout`/`search_path` attributes set in
 * `infra/docker/postgres/init/00-roles.sql`. A test suite running against a
 * different image would pass while production failed, which is worse than
 * having no test at all.
 *
 * Building the image costs ~60–90 s once; Testcontainers caches it by tag
 * afterwards, so subsequent runs start in ~3 s.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/testing/src/containers → repository root */
const REPO_ROOT = resolve(HERE, '../../../..');
const POSTGRES_CONTEXT = join(REPO_ROOT, 'infra', 'docker', 'postgres');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages', 'db', 'prisma', 'migrations');

/** Tag is pinned so a stale build from another branch is never silently reused. */
const IMAGE_TAG = 'vims-hms/postgres:17-test';

export const DATABASE_NAME = 'vims_hms';

/**
 * The four roles from `infra/docker/postgres/init/00-roles.sql`.
 *
 * `hms_app` is the one that matters: it is `NOBYPASSRLS` and owns nothing, so a
 * query it runs is subject to exactly the policies a real request would meet.
 * Tests that "prove isolation" while connected as `postgres` prove nothing.
 */
export const PG_ROLES = {
  /** Superuser. Container administration only — never assert isolation through it. */
  superuser: { user: 'postgres', password: 'postgres' },
  /** Owns the schema, runs migrations, bypasses RLS by ownership. */
  migrator: { user: 'hms_migrator', password: 'hms_migrator_dev' },
  /** What every service connects as. Subject to RLS. */
  app: { user: 'hms_app', password: 'hms_app_dev' },
  /** Analytics/auditor. SELECT only, everywhere. */
  readonly: { user: 'hms_readonly', password: 'hms_readonly_dev' },
  /** The only role permitted to detach audit partitions (EN-024 §3.4). */
  retention: { user: 'hms_retention', password: 'hms_retention_dev' },
} as const;

export type PgRole = keyof typeof PG_ROLES;

export interface TestPostgres {
  readonly container: StartedTestContainer;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  /** A libpq URL for the given role, for tools that want a connection string. */
  connectionString(role: PgRole): string;
  /** A pooled client for the given role. Pools are cached and closed by `stop()`. */
  pool(role: PgRole): Pool;
  /** Closes every pool, then the container. */
  stop(): Promise<void>;
}

export interface StartTestPostgresOptions {
  /** Apply `packages/db/prisma/migrations` after start. Default `true`. */
  readonly migrate?: boolean;
  /** Seconds to wait for the server to accept connections. Default `120`. */
  readonly startupTimeoutSeconds?: number;
}

/** Ordered list of migration SQL files, exactly as `prisma migrate deploy` would apply them. */
export function migrationFiles(): readonly string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((name) => join(MIGRATIONS_DIR, name, 'migration.sql'));
}

/**
 * Applies every migration in order, as `hms_migrator`.
 *
 * Each file is sent as one simple-protocol statement batch, which is how psql
 * and `prisma migrate deploy` apply them; splitting on `;` would break the
 * `DO $$ ... $$` blocks that carry the RLS generator and the audit guards.
 */
export async function applyMigrations(pg: TestPostgres): Promise<readonly string[]> {
  const pool = pg.pool('migrator');
  const applied: string[] = [];
  for (const file of migrationFiles()) {
    const sql = readFileSync(file, 'utf8');
    try {
      await pool.query(sql);
    } catch (error) {
      const name = file.split('/').slice(-2)[0] ?? file;
      throw new Error(`Migration ${name} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    applied.push(file);
  }
  return applied;
}

/**
 * Starts the container and (by default) applies the migrations.
 *
 * Call once per suite — `beforeAll` — and isolate individual tests with
 * `withRollback` rather than by restarting the container.
 */
export async function startTestPostgres(options: StartTestPostgresOptions = {}): Promise<TestPostgres> {
  const { migrate = true, startupTimeoutSeconds = 120 } = options;

  const built = await GenericContainer.fromDockerfile(POSTGRES_CONTEXT)
    .withCache(true)
    .build(IMAGE_TAG, { deleteOnExit: false });

  const container = await built
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: PG_ROLES.superuser.user,
      POSTGRES_PASSWORD: PG_ROLES.superuser.password,
      POSTGRES_DB: DATABASE_NAME,
    })
    // The entrypoint starts the server once on a unix socket to run
    // /docker-entrypoint-initdb.d, then restarts it for real. Waiting for the
    // second "ready" is what distinguishes "init finished" from "init started".
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2).withStartupTimeout(
        startupTimeoutSeconds * 1000,
      ),
    )
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const pools = new Map<PgRole, Pool>();

  const pg: TestPostgres = {
    container,
    host,
    port,
    database: DATABASE_NAME,
    connectionString(role) {
      const { user, password } = PG_ROLES[role];
      return `postgresql://${user}:${password}@${host}:${port}/${DATABASE_NAME}`;
    },
    pool(role) {
      const existing = pools.get(role);
      if (existing) return existing;
      const { user, password } = PG_ROLES[role];
      const created = new Pool({ host, port, database: DATABASE_NAME, user, password, max: 4 });
      pools.set(role, created);
      return created;
    },
    async stop() {
      for (const pool of pools.values()) await pool.end();
      pools.clear();
      await container.stop();
    },
  };

  await waitForQueryable(pg, startupTimeoutSeconds);
  if (migrate) await applyMigrations(pg);
  return pg;
}

/**
 * The log line can appear a beat before the TCP listener accepts, and the init
 * scripts create the non-superuser roles, so we poll as `hms_app` rather than as
 * `postgres`: that proves the roles exist as well as that the server is up.
 */
async function waitForQueryable(pg: TestPostgres, timeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await pg.pool('app').query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(
    `PostgreSQL did not become queryable within ${timeoutSeconds}s: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
