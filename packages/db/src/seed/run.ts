/**
 * `pnpm --filter @vims/db seed:<tier>` — the idempotent seeder.
 *
 * `phase-00 §0.2`: "Idempotent seeds: one demo group → two hospitals → three
 * branches, the 64 system role templates from `docs/05`, permission catalogue,
 * numbering series, settings defaults, one user per role with a known dev
 * password."
 *
 * Idempotent means re-runnable *without effect*, not merely without error. Every
 * write goes through `upsert()`, which conflicts on a deterministic primary key
 * and skips the update entirely when nothing differs — so the second run reports
 * `0 rows written` and leaves every `updated_at` untouched. The proof is a
 * throwaway PostgreSQL 17 container (`@vims/testing`'s `startTestPostgres()`),
 * every migration applied in order, then the seeder run twice with a checksum of
 * the whole seeded corpus compared across the two runs. That harness lives in
 * `packages/testing` rather than here: `@vims/testing` already depends on
 * `@vims/db`, so a test in this package that imported it would make the
 * workspace graph cyclic and `turbo run build` would refuse to run.
 *
 * Connects with `DATABASE_MIGRATE_URL`. The application role deliberately cannot
 * write the catalogues (`core.permissions`, `core.lic_enforcement_points`,
 * `mdm.mdm_code_systems`, …) and is subject to RLS, so it could neither insert
 * the rows nor see the ones already there.
 */
import { Pool } from 'pg';
import { createContext, isTier, TIERS, tally, type Tier } from './context.js';
import { seedCatalogues } from './catalogues.js';
import { demoTenancy, seedDepartments, seedHolidays, seedTenancy } from './tenancy.js';
import { seedPlatform } from './platform.js';
import { DEV_PASSWORD, seedUsers } from './users.js';
import { seedModuleConfiguration } from './modules.js';
import { seedActivity } from './activity.js';
import { seedMasters } from './masters.js';
import { seedFrontOffice } from './frontoffice.js';
import { seedPatientPopulation } from './patients.js';

interface Args {
  readonly tier: Tier;
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let tier: Tier = 'minimal';
  let quiet = false;
  for (const arg of argv) {
    if (arg === '--quiet') {
      quiet = true;
      continue;
    }
    const match = /^--tier=(.+)$/.exec(arg);
    if (match === null) continue;
    const value = match[1] ?? '';
    if (!isTier(value)) {
      throw new Error(`Unknown tier "${value}". Expected one of: ${TIERS.join(', ')}.`);
    }
    tier = value;
  }
  return { tier, quiet };
}

function connectionString(): string {
  const url = process.env['DATABASE_MIGRATE_URL'] ?? process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_MIGRATE_URL is not set. Seeds run as the schema owner: the application role cannot write the ' +
        'code-owned catalogues and is subject to RLS, so it would silently seed nothing.',
    );
  }
  return url;
}

export async function runSeed(db: Pool, tier: Tier): Promise<ReturnType<typeof tally>> {
  const ctx = createContext(db, tier);
  const tenancy = demoTenancy();

  // Order is a dependency order, not a preference: role templates reference
  // permission keys by foreign key; users reference roles and branches; module
  // configuration references hospitals; activity references all of it.
  await seedCatalogues(ctx);
  await seedTenancy(ctx, tenancy);
  await seedDepartments(ctx, tenancy);
  await seedHolidays(ctx, tenancy);
  await seedPlatform(ctx, tenancy);
  await seedUsers(ctx, tenancy);

  if (tier !== 'minimal') {
    await seedModuleConfiguration(ctx, tenancy);
    // Phase 1. The masters come first — a schedule template references a
    // practitioner, a queue references a room, a consent type references a
    // department — and the patient population comes last, because it
    // references all of them.
    await seedMasters(ctx, tenancy);
    await seedFrontOffice(ctx, tenancy);
  }
  await seedActivity(ctx, tenancy);
  await seedPatientPopulation(ctx, tenancy);

  return tally(ctx.results);
}

async function main(): Promise<void> {
  const { tier, quiet } = parseArgs(process.argv.slice(2));
  const pool = new Pool({ connectionString: connectionString(), max: 4 });
  const startedAt = Date.now();

  try {
    const result = await runSeed(pool, tier);
    if (quiet) return;

    const names = [...result.byTable.keys()].sort();
    console.log(`\nVim's HMS seed — tier "${tier}"\n`);
    for (const name of names) {
      const entry = result.byTable.get(name);
      if (entry === undefined) continue;
      const changed = entry.written === 0 ? 'unchanged' : `${entry.written} written`;
      console.log(`  ${name.padEnd(38)} ${String(entry.presented).padStart(7)} rows   ${changed}`);
    }
    console.log(
      `\n  ${result.tables} tables · ${result.rowsPresented} rows presented · ` +
        `${result.rowsWritten} rows written · ${Date.now() - startedAt} ms`,
    );
    if (result.rowsWritten === 0) {
      console.log('  Nothing changed — the database already matches the seed.');
    }
    console.log(
      `\n  Sign in with any role key as the username, e.g. "hospital_admin@vims-blr".` +
        `\n  Development password for every seeded account: ${DEV_PASSWORD}` +
        `\n  These accounts exist only where a seed has been run. Never seed a production database.\n`,
    );
  } finally {
    await pool.end();
  }
}

// `import.meta.url` guard so the module can be imported by the integration test
// without executing, while `tsx src/seed/run.ts` still runs it.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
