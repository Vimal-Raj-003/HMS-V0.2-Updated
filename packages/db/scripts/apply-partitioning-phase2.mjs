#!/usr/bin/env node
/**
 * Post-processes the generated migration for the Phase-2 tables — the clinical
 * masters (`mdm.mdm_drugs`, `mdm_drug_brands`, `mdm_instructions`, …), vitals
 * and the observation record (`clinical.vitals*`), encounters, the versioned
 * document store, prescriptions, CPOE, CDSS (`clinical.cdss_*`), MRD
 * (`clinical.mrd_*`), the charge intent (`billing.charge_intents`) and the
 * doctor-PWA sync ledger (`core.mobile_sync_log`).
 *
 * A fourth script rather than a flag on the first three, for the reason
 * `apply-partitioning-phase1.mjs` gives: an applied migration is never edited
 * (docs/03 §Migrations), so a shared script would need to know which migration
 * it is fixing, and that is how the wrong one gets patched.
 *
 *   1. **Partitioning.** Prisma cannot express `PARTITION BY RANGE`. Four
 *      Phase-2 tables need it; each already declares the composite primary key
 *      `(id, <partition key>)` in the Prisma model, because a unique index on a
 *      partitioned table must contain every partitioning column.
 *
 *      Every one of those partition keys is `timestamptz(3)`, not `(6)`. That is
 *      deliberate and it is the fix for the defect Phase 1 hit twice (D-31): a
 *      microsecond-precision timestamp read into a JavaScript `Date` silently
 *      loses its sub-millisecond digits, so writing it back as half of a
 *      composite key matches zero rows. At millisecond precision the round trip
 *      is exact, and nothing in this phase measures a nurse's cuff reading or an
 *      alert fire to the microsecond. The migration says so again in §A, where
 *      an operator reading the SQL will see it.
 *
 *   2. **Spurious DropIndex removal.** Prisma emits `DROP INDEX` for every index
 *      that exists in the database but not in the Prisma schema: the trigram,
 *      prefix, partial and `NULLS NOT DISTINCT` indexes hand-written in the
 *      Phase-0 and Phase-1 migrations. Applying them would remove the patient
 *      search paths, the receipt-number uniqueness and the settings-scope
 *      uniqueness. They are drift only in Prisma's model of the world.
 *
 *   3. **Spurious AlterTable removal.** Prisma re-emits a `SET DEFAULT` for
 *      `queue.queue_definitions.reset_time` because it formats the literal
 *      differently from the way PostgreSQL stored it. Semantically identical,
 *      and not Phase 2's business.
 *
 * Usage:  node scripts/apply-partitioning-phase2.mjs <path-to-migration.sql>
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** `schema"."table` fragment → [partition key, human name, why] */
const PARTITIONED = new Map([
  [
    'clinical"."vitals',
    [
      'recorded_at',
      'clinical.vitals',
      'docs/03 §Table rules names it: every OPD, ward, ICU and ER observation set, several per patient per day, retained with the clinical record for ten years (OP-007 §5)',
    ],
  ],
  [
    'clinical"."cdss_alert_events',
    [
      'fired_at',
      'clinical.cdss_alert_events',
      'EN-029 §4 specifies monthly partitioning: one row per rule per order line per evaluation, ten-year medico-legal retention',
    ],
  ],
  [
    'clinical"."cdss_scores',
    [
      'computed_at',
      'clinical.cdss_scores',
      'EN-029 §4 specifies monthly partitioning: a NEWS2 or PEWS score for every observation set, living with the clinical record',
    ],
  ],
  [
    'core"."mobile_sync_log',
    [
      'received_at',
      'core.mobile_sync_log',
      'OP-019 §4 specifies partitioning: one row per queued mutation per device, operational metadata with a 90-day life, not a clinical record',
    ],
  ],
]);

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/apply-partitioning-phase2.mjs <path-to-migration.sql>');
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
    `-- "${key}" is timestamptz(3): a microsecond value read into a JS Date and\n` +
    `-- written back as half of this table's composite key would match no rows (D-31).\n`;
  sql = sql.slice(0, m.index) + replacement + sql.slice(m.index + m[0].length);
  patched += 1;
}

writeFileSync(target, sql);
console.log(`patched ${patched}/${PARTITIONED.size} tables to PARTITION BY RANGE`);
console.log(`removed ${dropped.length} spurious DropIndex statement(s): ${dropped.join(', ') || 'none'}`);
console.log(`removed ${altered.length} spurious AlterTable statement(s): ${altered.join(', ') || 'none'}`);
