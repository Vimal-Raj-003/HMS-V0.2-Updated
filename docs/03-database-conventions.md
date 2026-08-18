# 03 — Database Conventions (PostgreSQL 17)

## Engine & version
- **PostgreSQL 17** (minimum 16). 17 adds faster VACUUM (less bloat on high-write tables like vitals/audit),
  `JSON_TABLE`, incremental backups (`pg_basebackup --incremental`), better logical replication (failover slots),
  `MERGE ... RETURNING`. Plan upgrade to 18 once managed providers mark it GA-stable. See `02-tech-stack-decision.md`.
- Extensions: `pgcrypto`, `uuid-ossp` (or app-side UUIDv7), `pg_trgm`, `btree_gist`, `pgvector`, `pg_partman`,
  `pg_stat_statements`, `pg_cron`, `citext`, `ltree` (org hierarchies), `postgis` (ambulance GPS, optional).

## Schemas
```
core        tenants, branches, users, roles, permissions, sessions, numbering, settings, audit, outbox, files
mdm         master data: departments, services, tariffs, drugs, icd, lab tests, beds, packages, payers…
patient     patients, identifiers (UHID/ABHA), consents, relationships, alerts, allergies
clinical    encounters, vitals, notes, diagnoses, orders, prescriptions, results, documents (versioned)
lab / rad / pharmacy / blood / ot / ip / er / trauma / ortho / specialty.*  (one schema per bounded context)
billing     bills, bill_items, receipts, payments, refunds, credit_notes, insurance_claims, packages
inventory   items, batches, stock_ledger, stores, indents, po, grn, consumption, consignment, assets
finance     ledgers, journals, ap, ar, bank_recon
hr          employees, attendance, leave, payroll, roster
engage      portal accounts, notifications, campaigns, feedback, tickets
analytics   materialised views, summary tables (refreshed by jobs)
integration message_log, hl7_messages, fhir_resources, abdm_*, connector_config
```

## Table rules
- PK: `id uuid` (UUIDv7, time-ordered → index-friendly). Human IDs separately (`uhid`, `bill_no`).
- Multi-tenancy: `hospital_id uuid not null` on every business table; `branch_id uuid` where operationally scoped.
  Composite indexes always start with `hospital_id`.
- Audit columns: `created_at timestamptz default now()`, `created_by uuid`, `updated_at`, `updated_by`,
  `deleted_at` (soft delete only where allowed), `version int` (optimistic locking on editable rows).
- Enums as Postgres `enum` types for stable sets (`gender`, `bill_status`); lookup tables for hospital-configurable sets.
- Money: `numeric(14,2)` + `currency char(3)`; never float. Tax lines stored explicitly (CGST/SGST/IGST, HSN/SAC).
- Time: `timestamptz` only; store hospital TZ in `core.hospitals.timezone`; date-only fields as `date`.
- Names/search: `citext` for emails/usernames; trigram GIN indexes on `patients.full_name`, `phone`, `uhid`.
- JSONB allowed for form payloads (`clinical.form_responses.data`), device raw messages, config; **never** for
  money, status, or anything queried in WHERE without an expression index.
- Large/high-write tables **partitioned by month** (`vitals`, `audit_log`, `notifications`, `hl7_messages`,
  `stock_ledger`, `outbox_events`, `queue_events`) via `pg_partman`; retention per `04-security-compliance.md`.
- Clinical documents (`clinical.documents`) are **append-only versions**: `document_id`, `version`, `status`
  (draft/final/amended/cancelled), `signed_by`, `signed_at`, `sha256`, `prev_sha256` (hash chain).
- Every order/bill/result table has `status` + `status_history` (jsonb or child table) with actor & timestamp.

## Shared platform-owned tables (no single module may claim these)

Some tables are used by many modules and are owned by the **platform**, not by a feature module. They are created in
Phase 0/2, and modules may only *extend* them via their own child tables or documented columns — never redefine them.

| Table | Owner | Created in | Extended by |
|---|---|---|---|
| `core.*` (users, roles, permissions, sessions, settings, numbering_series, feature_flags, licences, audit_log, outbox_events, files, notifications, approval_*, form_templates, print_templates, idempotency_keys) | Platform (EN-007/024/037/038/039/040) | Phase 0 | every module |
| `patient.patients`, `patient.identifiers`, `patient.alerts`, `patient.allergies`, `patient.relationships`, `patient.consents` | OP-001 (+ EN-028 for consents) | Phase 1 | every clinical module |
| `clinical.encounters` | OP-002 | Phase 2 | OP-006, IP-001, all specialty consoles |
| **`clinical.documents`** + `clinical.document_versions` (versioned, signed, hash-chained clinical document store) | **Platform — created in Phase 2 with OP-002, governed by EN-039** | Phase 2 | OP-002 notes, OP-004/OP-008 reports, IP-002 discharge summaries, IP-006 op notes, EN-028 consents, TR-008 forensic docs |
| `clinical.orders`, `clinical.order_items` | OP-002 (CPOE) | Phase 2 | OP-004, OP-008, IP-003, IP-006 |
| `clinical.vitals` (partitioned) | OP-007 | Phase 2 | IP-003, IP-009, TR-006 |
| `mdm.*` masters | EN-027 | Phase 0–2 | every module |
| `billing.charge_intents` | OP-005 | Phase 5 | every module that creates a charge |

**Convention (mandatory from now on):** every module spec §4 declares the tables it owns in the form
`**schema.table**` — one per line — and lists tables it only reads as `reads: schema.table (owner: MODULE-ID)`.
CI runs a script that parses all specs and fails on (a) a table declared as owned by two modules, or
(b) a table written to by a module that does not own it.

## Row-Level Security
```sql
ALTER TABLE patient.patients ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient.patients
  USING (hospital_id = current_setting('app.hospital_id')::uuid);
```
- API sets `SET LOCAL app.hospital_id = '<uuid>'; SET LOCAL app.user_id = ...; SET LOCAL app.role = ...` inside each
  transaction (Prisma `$transaction` middleware / Kysely plugin). Migrations run as owner with RLS bypass.
- Group-level (multi-branch) reads use `app.hospital_ids` array policy for group-admin/analytics roles.

## Numbering series (`core.numbering_series`)
- Keys like `UHID`, `OP_VISIT`, `IP_NO`, `BILL_OP`, `BILL_IP`, `RECEIPT`, `LAB_ACC`, `SAMPLE`, `PO`, `GRN`, `MLC`,
  `BLOOD_BAG`; per hospital/branch/financial-year; pattern e.g. `{BR}/{FY}/{SEQ:6}`;
  gapless (row-locked `SELECT ... FOR UPDATE`) for invoices/receipts, non-gapless (sequence) for tokens.

## Audit (`core.audit_log`, partitioned)
- `who, when, ip, user_agent, hospital_id, table, row_id, action (I/U/D/READ_PHI), before jsonb, after jsonb, reason`.
- Written by application layer inside the same transaction; PHI reads of full records (e.g. opening a patient chart
  outside care team) are logged as `READ_PHI` (break-glass).

## Outbox (`core.outbox_events`)
- `id, hospital_id, aggregate, aggregate_id, event_type, payload jsonb, occurred_at, published_at, attempts`.
- Worker relays to Redis Streams (`hms:events:<hospital>`), consumers ack; DLQ after N attempts.

## Migrations
- Prisma Migrate for schema; hand-written SQL in `prisma/migrations/*/migration.sql` for RLS, partitions, indexes,
  triggers, materialised views (Prisma cannot express them). Never edit an applied migration.
- Every migration: forward SQL + `-- ROLLBACK:` comment block. Seeds are idempotent (`upsert`).

## Performance rules
- Every FK indexed. Every list screen query has a covering index for its default sort (`hospital_id, created_at desc`).
- Cursor pagination (`(created_at, id)`) — no `OFFSET` on tables > 100k rows.
- Hot reads via Redis (`tariff`, `drug search`, `service catalogue`, `bed board`) with event-based invalidation.
- Reports/dashboards from `analytics.*` materialised views (refreshed by `pg_cron`/worker) or summary tables
  updated by events. Never aggregate live transactional tables for a dashboard.
- Connection pooling: PgBouncer (transaction mode) in front of Postgres; app pool sized per service.
- Read replicas for analytics/reporting (`DATABASE_URL_RO`).

## Backup / DR
- Daily full + WAL archiving (or pgBackRest / provider snapshots), incremental (PG17), PITR ≥ 30 days,
  quarterly restore drill logged in `core.dr_drills`. RPO ≤ 5 min, RTO ≤ 1 h for enterprise tier.
