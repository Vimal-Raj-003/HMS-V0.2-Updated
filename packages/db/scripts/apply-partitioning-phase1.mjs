#!/usr/bin/env node
/**
 * Post-processes the generated migration for the Phase-1 tables — the patient
 * master and consent (`patient.*`), appointments and visits (`clinical.*`),
 * queues and tokens (`queue.*`), messaging (`engage.msg_*`), the cash counter
 * and its receipts (`billing.*`), the Phase-1 domain masters (`mdm.mdm_*`) and
 * ABDM M1 (`integration.abdm_*`).
 *
 * Same two jobs, and the same rationale, as `apply-partitioning.mjs` and
 * `apply-partitioning-modules.mjs` before it. Kept as a third script rather
 * than folded into either because the three operate on different migrations and
 * must stay independently re-runnable — a migration that has been applied is
 * never edited (docs/03 §Migrations), so a shared script would have to grow a
 * flag for "which migration am I fixing", which is how the wrong one gets
 * patched.
 *
 *   1. **Partitioning.** Prisma cannot express `PARTITION BY RANGE`, and doing
 *      the edit by hand every time the schema is regenerated is how a partition
 *      silently goes missing.
 *
 *   2. **Spurious DropIndex removal.** Prisma emits `DROP INDEX` for every
 *      index that exists in the database but not in the Prisma schema. Those
 *      are the hand-written trigram, partial and `NULLS NOT DISTINCT` indexes
 *      from the Phase-0 migrations — SQL Prisma cannot represent and therefore
 *      believes is drift. Applying the drops would remove the trigram index
 *      that makes drug and user search possible and the uniqueness that stops
 *      two identical settings rows existing.
 *
 * Usage:  node scripts/apply-partitioning-phase1.mjs <path-to-migration.sql>
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** `schema"."table` fragment → [partition key, human name, why] */
const PARTITIONED = new Map([
  ['queue"."queue_tokens', ['issued_at', 'queue.queue_tokens', '5000 OP visits/day per branch, one row each and more for multi-stage journeys; two-year retention then aggregate-only (EN-006 §5)']],
  ['queue"."queue_events', ['at', 'queue.queue_events', 'several rows per token — issued, called, recalled, served; docs/03 §Table rules names this table as partitioned by month']],
  ['engage"."msg_messages', ['created_at', 'engage.msg_messages', 'every OTP, token alert, appointment reminder and receipt notification; metadata two years, rendered bodies 90 days (EN-009 §5)']],
  ['engage"."msg_events', ['at', 'engage.msg_events', 'one row per delivery-status webhook per message; raw payloads purged at 30 days (EN-009 §5)']],
  ['billing"."payments', ['paid_at', 'billing.payments', 'every receipt the hospital issues; eight-year GST/IT retention (NC-001 §5), so a month must be archivable without touching the rest']],
  ['billing"."cash_drawer_events', ['opened_at', 'billing.cash_drawer_events', 'every drawer opening at every counter; three-year retention (NC-001 §5)']],
  ['patient"."consent_ledger', ['at', 'patient.consent_ledger', 'the DPDP record of consent — several rows per consent per patient, retained with the clinical record and never deleted (EN-028 §4)']],
  ['integration"."abdm_messages', ['at', 'integration.abdm_messages', 'every ABDM request and callback with an encrypted PHI payload; EN-011 §4 specifies monthly partitioning']],
]);

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/apply-partitioning-phase1.mjs <path-to-migration.sql>');
  process.exit(1);
}

let sql = readFileSync(target, 'utf8');

// ── 1. drop the DropIndex statements ─────────────────────────────────────────
const dropped = [];
sql = sql.replace(/-- DropIndex\nDROP INDEX "([^"]+)"\."([^"]+)";\n\n/g, (_m, schema, name) => {
  dropped.push(`${schema}.${name}`);
  return '';
});

// ── 2. partition the high-write tables ───────────────────────────────────────
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
    `-- A month must be droppable in < 1 s (docs/07 §4), which DELETE can never be.\n`;
  sql = sql.slice(0, m.index) + replacement + sql.slice(m.index + m[0].length);
  patched += 1;
}

writeFileSync(target, sql);
console.log(`patched ${patched}/${PARTITIONED.size} tables to PARTITION BY RANGE`);
console.log(`removed ${dropped.length} spurious DropIndex statement(s): ${dropped.join(', ') || 'none'}`);
