#!/usr/bin/env node
/**
 * Post-processes the generated migration for the Phase-0 platform-module tables
 * (`notif_*`, `wf_*`, `tpl_*`, `lic_*`, `print_*`, `sso_*`, `bc_*`, `display_*`,
 * `mdm.*`, `integration.ihub_*`).
 *
 * Same rationale as `apply-partitioning.mjs`, which does this for the base
 * Phase-0 migration: Prisma cannot express `PARTITION BY RANGE`, and doing the
 * edit by hand every time the schema is regenerated is how a partition silently
 * goes missing. Kept as a second script rather than folded into the first
 * because the two operate on different migrations and must stay independently
 * re-runnable.
 *
 * It also strips the `DropIndex` statements Prisma emits for indexes that exist
 * in the database but not in the Prisma schema. Those are the hand-written
 * trigram, partial and `NULLS NOT DISTINCT` indexes from
 * `..._partitions_and_indexes` and `..._rls_tenant_key_exceptions` — SQL Prisma
 * cannot represent and therefore believes is drift. Applying the drops would
 * remove the index that makes the RLS join on `core.roles` index-backed and the
 * uniqueness that stops two identical settings rows existing.
 *
 * Usage:  node scripts/apply-partitioning-modules.mjs <path-to-migration.sql>
 */
import { readFileSync, writeFileSync } from 'node:fs';

/** `schema"."table` fragment → [partition key, human name, why] */
const PARTITIONED = new Map([
  ['core"."notif_notifications', ['created_at', 'core.notif_notifications', 'every clinical alert for every recipient; retention is per type, 10 years for clinical safety (EN-037 §4)']],
  ['core"."notif_deliveries', ['queued_at', 'core.notif_deliveries', 'one row per channel attempt per recipient; 180-day CERT-In retention (EN-037 §4)']],
  ['core"."wf_requests', ['requested_at', 'core.wf_requests', '7-year statutory retention of approval evidence (EN-038 §4)']],
  ['core"."wf_actions', ['acted_at', 'core.wf_actions', 'append-only approval timeline, several rows per request (EN-038 §4)']],
  ['core"."tpl_render_jobs', ['created_at', 'core.tpl_render_jobs', 'one row per rendered document; artefacts for signed documents are permanent (EN-039 §4)']],
  ['core"."lic_usage_daily', ['usage_date', 'core.lic_usage_daily', 'daily metering per meter per branch, 3-year retention (EN-040 §4)']],
  ['core"."print_jobs', ['created_at', 'core.print_jobs', 'every token, label, wristband and receipt printed; 1-year metadata retention (EN-005 §5)']],
  ['core"."sso_login_attempts', ['occurred_at', 'core.sso_login_attempts', '180-day CERT-In retention of every authentication attempt (EN-025 §4)']],
  ['core"."sso_scim_operations', ['occurred_at', 'core.sso_scim_operations', 'one row per provisioning operation from the IdP (EN-025 §4)']],
  ['core"."bc_scan_events', ['occurred_at', 'core.bc_scan_events', 'every barcode scan on every screen, sampled (EN-013 §4)']],
  ['core"."display_device_events', ['occurred_at', 'core.display_device_events', 'device heartbeat and render telemetry, 90-day retention (EN-018 §4)']],
  ['integration"."ihub_messages', ['created_at', 'integration.ihub_messages', 'every inbound and outbound integration message; 180 days online then archived (EN-017 §4)']],
]);

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/apply-partitioning-modules.mjs <path-to-migration.sql>');
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
