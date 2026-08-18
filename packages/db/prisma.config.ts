import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

/**
 * Prisma configuration (replaces the deprecated `package.json#prisma` block).
 *
 * The multi-file schema folder is deliberate: Phase 0 alone defines ~90 models,
 * and the full 177-module system will define several hundred. One 10,000-line
 * `schema.prisma` would be unreviewable, and a reviewable schema is a
 * prerequisite for the table-ownership check that `docs/03 §Shared platform-owned
 * tables` mandates in CI.
 *
 * Presence of this file makes Prisma skip its own dotenv loading, so the repo-root
 * `.env` is loaded here explicitly. `DATABASE_MIGRATE_URL` is used rather than
 * `DATABASE_URL` because migrations must run as the schema owner — the application
 * role deliberately cannot DDL (docs/04 §6) and is subject to RLS, so it could not
 * see the rows a data migration needs to touch.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
process.loadEnvFile?.(path.resolve(here, '../../.env'));

export default defineConfig({
  schema: path.join('prisma', 'schema'),
  migrations: {
    path: path.join('prisma', 'migrations'),
    // Seeds are idempotent (`upsert`) per docs/03 §Migrations, so re-running is safe.
    seed: 'tsx src/seed/run.ts --tier=minimal',
  },
});
