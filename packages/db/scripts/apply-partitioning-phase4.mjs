#!/usr/bin/env node
/**
 * Post-processes the generated migration for the Phase-4 tables — the
 * supply-chain masters (`mdm.mdm_uoms`, `mdm.mdm_item_categories`,
 * `mdm.mdm_manufacturers`, `mdm.mdm_hsn_codes`, `mdm.mdm_gst_rates`,
 * `mdm.mdm_dpco_ceilings`), stores and inventory (`inventory.*`), the vendor
 * master (`inventory.vnd_*`), purchase to pay (`inventory.pur_*`), consignment
 * (`inventory.csn_*`), consumption (`inventory.cons_*`), cost centres
 * (`finance.*`) and the pharmacy counter (`pharmacy.*`).
 *
 * A sixth script rather than a flag on the first five, for the reason
 * `apply-partitioning-phase1.mjs` gives: an applied migration is never edited
 * (docs/03 §Migrations), so a shared script would need to know which migration
 * it is fixing, and that is how the wrong one gets patched.
 *
 *   1. **Partitioning.** Prisma cannot express `PARTITION BY RANGE`. Three
 *      Phase-4 tables need it; each already declares the composite primary key
 *      `(id, <partition key>)` in the Prisma model, because a unique index on a
 *      partitioned table must contain every partitioning column.
 *
 *      All three partition keys are `timestamptz(3)`, not `(6)`. Same reasoning
 *      as Phases 2 and 3 (D-31): a microsecond-precision timestamp read into a
 *      JavaScript `Date` silently loses its sub-millisecond digits, so writing
 *      it back as half of a composite key matches zero rows. Nothing in this
 *      phase is measured to the microsecond — a stock movement, a fridge
 *      reading and a vendor performance fact are all events whose ordering
 *      within a millisecond comes from the UUIDv7 in `id`.
 *
 *      And all three are **pure append**, which is why they use the base
 *      `core.ensure_month_partition()` helper (SELECT + INSERT, no UPDATE)
 *      rather than the writable variant Phase 3 had to add. That is not an
 *      accident of the data; it is the phase's central guarantee.
 *      `inventory.stock_ledger` is corrected by compensating rows, never by an
 *      UPDATE (`phase-04 §Constraints`); a temperature reading is a
 *      measurement; a vendor event is a fact about a receipt that already
 *      happened.
 *
 *      `inventory.stock_ledger` is the one that makes the arithmetic
 *      unavoidable: `phase-04` exit gate 8 is 2000 dispensing transactions and
 *      500 store movements a day, four lines each, which is ~3.7 M rows a year
 *      before inpatient dispensing exists. A retention DELETE over that is not
 *      a maintenance window anybody would agree to.
 *
 *   2. **Spurious DropIndex removal.** Prisma emits `DROP INDEX` for every
 *      index that exists in the database but not in the Prisma schema: the
 *      trigram, prefix, partial and `NULLS NOT DISTINCT` indexes hand-written
 *      in the Phase-0, Phase-1, Phase-2 and Phase-3 migrations. Applying them
 *      would remove the patient search paths, the drug search paths, the
 *      receipt-number uniqueness and the settings-scope uniqueness. They are
 *      drift only in Prisma's model of the world.
 *
 *   3. **Spurious AlterTable removal.** Prisma re-emits a `SET DEFAULT` for
 *      `queue.queue_definitions.reset_time` because it formats the literal
 *      differently from the way PostgreSQL stored it. Semantically identical,
 *      and not Phase 4's business — exactly as in Phases 2 and 3.
 *
 * Usage:  node scripts/apply-partitioning-phase4.mjs <path-to-migration.sql>
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** `schema"."table` fragment → [partition key, human name, why] */
const PARTITIONED = new Map([
  [
    'inventory"."stock_ledger',
    [
      'moved_at',
      'inventory.stock_ledger',
      'docs/03 §Table rules names it in the monthly-partition list, and phase-04 exit gate 8 sizes it: 2000 dispensing transactions + 500 store movements a day, four lines each, is ~3.7 M rows a year',
    ],
  ],
  [
    'inventory"."temp_readings',
    [
      'recorded_at',
      'inventory.temp_readings',
      'NC-006 §4 specifies monthly partitioning: a cold-chain sensor reporting every five minutes writes ~105 000 rows per zone per year and the readings age out under the cold-chain retention policy',
    ],
  ],
  [
    'inventory"."vnd_events',
    [
      'occurred_at',
      'inventory.vnd_events',
      'NC-021 §4 specifies monthly partitioning: one row per GRN line, service call, complaint and audit finding, so it grows with receipts rather than with vendors',
    ],
  ],
]);

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/apply-partitioning-phase4.mjs <path-to-migration.sql>');
  process.exit(1);
}

let sql = readFileSync(target, 'utf8');

// ── 1. drop the DropIndex statements ─────────────────────────────────────────
const dropped = [];
sql = sql.replace(/-- DropIndex\nDROP INDEX "([^"]+)"\."([^"]+)";\n\n/g, (_m, schema, name) => {
  dropped.push(`${schema}.${name}`);
  return '';
});

// ── 2. drop the spurious AlterTable ──────────────────────────────────────────
const altered = [];
sql = sql.replace(
  /-- AlterTable\nALTER TABLE "queue"\."queue_definitions" ALTER COLUMN "reset_time" SET DEFAULT [^;]+;\n\n/g,
  () => {
    altered.push('queue.queue_definitions.reset_time');
    return '';
  },
);

// ── 3. partition the high-write tables ───────────────────────────────────────
let patched = 0;
for (const [fragment, [key, name, why]] of PARTITIONED) {
  const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(CREATE TABLE "${escaped}" \\((?:[^;]*?)\\n\\))(;)`, 's');
  const m = re.exec(sql);
  if (!m) {
    console.error(`FAIL: could not locate CREATE TABLE for ${name}.`);
    console.error('The schema changed shape. Fix this script rather than hand-editing the migration.');
    process.exit(1);
  }
  const replacement =
    `${m[1]}\nPARTITION BY RANGE ("${key}")${m[2]}\n` +
    `-- Partitioned monthly: ${why}.\n` +
    `-- A month must be droppable in < 1 s (docs/07 §4), which DELETE can never be.\n` +
    `-- Pure append, so the partitions use core.ensure_month_partition() and never\n` +
    `-- receive GRANT UPDATE. For the ledger that is the phase's central guarantee,\n` +
    `-- not a convenience: a correction is a compensating row (phase-04 §Constraints).\n` +
    `-- "${key}" is timestamptz(3): a microsecond value read into a JS Date and\n` +
    `-- written back as half of this table's composite key would match no rows (D-31).\n`;
  sql = sql.slice(0, m.index) + replacement + sql.slice(m.index + m[0].length);
  patched += 1;
}

writeFileSync(target, sql);
console.log(`patched ${patched}/${PARTITIONED.size} tables to PARTITION BY RANGE`);
console.log(`removed ${dropped.length} spurious DropIndex statement(s): ${dropped.join(', ') || 'none'}`);
console.log(`removed ${altered.length} spurious AlterTable statement(s): ${altered.join(', ') || 'none'}`);
