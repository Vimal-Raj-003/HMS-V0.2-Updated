#!/usr/bin/env node
/**
 * Post-processes the generated migration for the Phase-3 tables — the
 * diagnostics masters (`mdm.mdm_lab_*`, `mdm.mdm_rad_procedures`,
 * `mdm.mdm_investigation_services`), the LIS (`lab.*`), lab quality
 * (`lab.labq_*`), analyzer interfacing (`integration.lab_*`), radiology
 * (`rad.rad_*`), the PACS index (`rad.pacs_*`) and the investigation console
 * (`clinical.investigation_*`).
 *
 * A fifth script rather than a flag on the first four, for the reason
 * `apply-partitioning-phase1.mjs` gives: an applied migration is never edited
 * (docs/03 §Migrations), so a shared script would need to know which migration
 * it is fixing, and that is how the wrong one gets patched.
 *
 *   1. **Partitioning.** Prisma cannot express `PARTITION BY RANGE`. Six
 *      Phase-3 tables need it; each already declares the composite primary key
 *      `(id, <partition key>)` in the Prisma model, because a unique index on a
 *      partitioned table must contain every partitioning column.
 *
 *      Every one of those partition keys is `timestamptz(3)`, not `(6)`. Same
 *      reasoning as Phase 2 (D-31): a microsecond-precision timestamp read into
 *      a JavaScript `Date` silently loses its sub-millisecond digits, so writing
 *      it back as half of a composite key matches zero rows. Nothing in this
 *      phase is measured to the microsecond — an analyzer result, a QC point, a
 *      stored DICOM instance and a viewer open are all events whose ordering
 *      within a millisecond comes from the UUIDv7 in `id`.
 *
 *      `lab.lab_result_versions` is the one that makes the arithmetic
 *      unavoidable: `docs/prompts/phase-03` exit gate 8 is 20 000 results a day,
 *      `OP-004 §4` extrapolates to ~36 M rows a year, and a retention DELETE
 *      over that is not a maintenance window anybody would agree to.
 *
 *   2. **Spurious DropIndex removal.** Prisma emits `DROP INDEX` for every index
 *      that exists in the database but not in the Prisma schema: the trigram,
 *      prefix, partial and `NULLS NOT DISTINCT` indexes hand-written in the
 *      Phase-0, Phase-1 and Phase-2 migrations. Applying them would remove the
 *      patient search paths, the drug search paths, the receipt-number
 *      uniqueness and the settings-scope uniqueness. They are drift only in
 *      Prisma's model of the world.
 *
 *   3. **Spurious AlterTable removal.** Prisma re-emits a `SET DEFAULT` for
 *      `queue.queue_definitions.reset_time` because it formats the literal
 *      differently from the way PostgreSQL stored it. Semantically identical,
 *      and not Phase 3's business — exactly as in Phase 2.
 *
 * Usage:  node scripts/apply-partitioning-phase3.mjs <path-to-migration.sql>
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** `schema"."table` fragment → [partition key, human name, why] */
const PARTITIONED = new Map([
  [
    'lab"."lab_results',
    [
      'created_at',
      'lab.lab_results',
      'phase-03 exit gate 8 is 20 000 results/day and OP-004 §4 extrapolates to ~36 M rows a year; one identity row per analyte per order line',
    ],
  ],
  [
    'lab"."lab_result_versions',
    [
      'recorded_at',
      'lab.lab_result_versions',
      'the values behind those results, plus every amendment — the largest table in the phase, and a ten-year clinical record that must age out by DROP PARTITION',
    ],
  ],
  [
    'lab"."labq_qc_runs',
    [
      'run_at',
      'lab.labq_qc_runs',
      'EN-031 §4 specifies monthly partitioning: two or three control levels per analyte per instrument per shift, retained five years for NABL',
    ],
  ],
  [
    'integration"."lab_if_messages',
    [
      'received_at',
      'integration.lab_if_messages',
      'EN-004 §4 specifies monthly partitioning: one row per HL7/ASTM frame in each direction, with the raw bytes purged at 90 days and the parsed metadata kept two years',
    ],
  ],
  [
    'rad"."pacs_instances',
    [
      'stored_at',
      'rad.pacs_instances',
      'one row per DICOM object: a single CT of the abdomen is one to three thousand of them, so this is the second-largest table in the phase',
    ],
  ],
  [
    'rad"."pacs_view_audit',
    [
      'at',
      'rad.pacs_view_audit',
      'EN-008 §5 requires every image view, download and export to be logged, and docs/04 §6 makes that a PHI-read audit with a long retention',
    ],
  ],
]);

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/apply-partitioning-phase3.mjs <path-to-migration.sql>');
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
