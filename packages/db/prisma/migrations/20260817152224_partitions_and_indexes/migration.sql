-- ─────────────────────────────────────────────────────────────────────────────
-- Partitions, partition maintenance and the partial indexes Prisma cannot express
--
-- docs/07 §4: "Premake 3 months ahead; detach-and-archive rather than `DELETE`
-- (a month must be droppable in < 1 s)."
-- ADR-0008: partition maintenance lives in the application (worker `maintenance`
-- queue) using the function defined here, so the product still runs on a managed
-- Postgres that offers no pg_partman. When pg_partman IS present it is configured
-- as a belt-and-braces second driver.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── the partition maintenance function ───────────────────────────────────────
-- Creates `<table>_YYYYMM` for a given month if it does not exist. Idempotent, so
-- the worker can call it every hour without coordination, and a missed run is
-- self-healing rather than an outage.
CREATE OR REPLACE FUNCTION core.ensure_month_partition(
  p_schema      text,
  p_table       text,
  p_month_start date
) RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_partition  text;
  v_from       date := date_trunc('month', p_month_start)::date;
  v_to         date := (date_trunc('month', p_month_start) + interval '1 month')::date;
  v_qualified  text;
BEGIN
  v_partition := format('%s_%s', p_table, to_char(v_from, 'YYYYMM'));
  v_qualified := format('%I.%I', p_schema, v_partition);

  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = p_schema AND c.relname = v_partition
  ) THEN
    RETURN v_partition;
  END IF;

  EXECUTE format(
    'CREATE TABLE %s PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
    v_qualified, p_schema, p_table, v_from, v_to
  );

  RETURN v_partition;
END;
$$;

COMMENT ON FUNCTION core.ensure_month_partition IS
  'Idempotently create one monthly partition. Called by the worker maintenance queue (ADR-0008) and by this migration.';

-- Premake the current month plus three ahead, and one behind so a back-dated
-- catch-up entry from the downtime protocol (docs/01 §7) has somewhere to land.
DO $$
DECLARE
  v_tables text[][] := ARRAY[
    ['core', 'audit_log'],
    ['core', 'outbox_events'],
    ['core', 'sessions'],
    ['core', 'login_audit'],
    ['core', 'org_cross_branch_access_log']
  ];
  i int;
  m int;
BEGIN
  FOR i IN 1 .. array_length(v_tables, 1) LOOP
    FOR m IN -1 .. 3 LOOP
      PERFORM core.ensure_month_partition(
        v_tables[i][1],
        v_tables[i][2],
        (date_trunc('month', now()) + (m || ' month')::interval)::date
      );
    END LOOP;
  END LOOP;
END
$$;

-- ── DEFAULT partitions: a deliberate safety net, not laziness ────────────────
-- Without one, an INSERT whose timestamp falls outside every declared range
-- fails. For `audit_log` that failure rolls back the clinical transaction that
-- triggered it (EN-024 §5 "No audit, no mutation"), so a missed maintenance run
-- or a clock anomaly would stop a nurse from charting. A DEFAULT partition turns
-- that catastrophic failure into a monitored anomaly: the maintenance job alerts
-- when a default partition is non-empty and redistributes the rows.
CREATE TABLE IF NOT EXISTS core.audit_log_default
  PARTITION OF core.audit_log DEFAULT;
CREATE TABLE IF NOT EXISTS core.outbox_events_default
  PARTITION OF core.outbox_events DEFAULT;
CREATE TABLE IF NOT EXISTS core.sessions_default
  PARTITION OF core.sessions DEFAULT;
CREATE TABLE IF NOT EXISTS core.login_audit_default
  PARTITION OF core.login_audit DEFAULT;
CREATE TABLE IF NOT EXISTS core.org_cross_branch_access_log_default
  PARTITION OF core.org_cross_branch_access_log DEFAULT;

COMMENT ON TABLE core.audit_log_default IS
  'Safety net only. A non-empty default partition is an alertable anomaly (docs/07 §6 capacity triggers), never a normal state.';

-- ── pg_partman, when available (belt and braces) ─────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_partman') THEN
    -- `p_template_table` is omitted so partman inherits indexes from the parent.
    PERFORM ext.create_parent(
      p_parent_table := 'core.audit_log',
      p_control      := 'occurred_at',
      p_interval     := '1 month',
      p_premake      := 3
    );
    PERFORM ext.create_parent('core.outbox_events', 'occurred_at', '1 month', p_premake := 3);
    PERFORM ext.create_parent('core.sessions', 'created_at', '1 month', p_premake := 3);
    PERFORM ext.create_parent('core.login_audit', 'occurred_at', '1 month', p_premake := 3);
    PERFORM ext.create_parent('core.org_cross_branch_access_log', 'occurred_at', '1 month', p_premake := 3);
    RAISE NOTICE 'pg_partman configured as the secondary partition driver';
  ELSE
    RAISE NOTICE 'pg_partman absent — the worker maintenance queue is the sole partition driver (ADR-0008)';
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Never fail the migration over an optional optimisation. The worker covers it.
  RAISE NOTICE 'pg_partman configuration skipped: %', SQLERRM;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Partial and expression indexes (docs/07 §4)
--
-- "use partial indexes for 'open work' states (they stay small forever)".
-- ─────────────────────────────────────────────────────────────────────────────

-- docs/07 §4 calls this "the hottest small index in the system": the outbox relay
-- polls it continuously, and because it only covers unpublished rows it stays a
-- few thousand entries wide no matter how large the table grows.
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
  ON core.outbox_events (occurred_at)
  WHERE published_at IS NULL;

-- Dead-letter triage: also permanently small.
CREATE INDEX IF NOT EXISTS idx_outbox_dead_lettered
  ON core.outbox_events (hospital_id, dead_lettered_at DESC)
  WHERE dead_lettered_at IS NOT NULL;

-- Live sessions only. A 180-day session table is mostly revoked rows; the policy
-- engine and the concurrency check only ever ask about live ones.
CREATE INDEX IF NOT EXISTS idx_sessions_live
  ON core.sessions (hospital_id, user_id, expires_at)
  WHERE revoked_at IS NULL;

-- Failed-login bursts (docs/07 §8 alerting, EN-023 brute-force detection).
CREATE INDEX IF NOT EXISTS idx_login_audit_failures
  ON core.login_audit (hospital_id, occurred_at DESC)
  WHERE result <> 'success';

-- Break-glass review queue: pending items first (EN-024 §8).
CREATE INDEX IF NOT EXISTS idx_break_glass_pending
  ON core.audit_break_glass (hospital_id, occurred_at DESC)
  WHERE review_status = 'pending';

-- PHI reads and exports are the privacy officer's daily query (EN-024 §4).
CREATE INDEX IF NOT EXISTS idx_audit_phi_access
  ON core.audit_log (hospital_id, occurred_at DESC)
  WHERE action IN ('read_phi', 'export', 'print', 'break_glass');

-- Denied actions: the security signal, and a tiny slice of the table.
CREATE INDEX IF NOT EXISTS idx_audit_denied
  ON core.audit_log (hospital_id, occurred_at DESC)
  WHERE result = 'denied';

-- Idempotency lookups and the expiry sweep.
CREATE INDEX IF NOT EXISTS idx_idempotency_in_flight
  ON core.idempotency_keys (hospital_id, key)
  WHERE status = 'in_flight';

-- Open access requests (EN-007 §8 admin inbox).
CREATE INDEX IF NOT EXISTS idx_access_requests_pending
  ON core.access_requests (hospital_id, created_at DESC)
  WHERE status = 'pending';

-- Active role assignments — the hottest authorisation query in the product.
-- `INCLUDE` makes it index-only for the permission-cache warm path (docs/07 §4).
CREATE INDEX IF NOT EXISTS idx_user_roles_active
  ON core.user_roles (user_id, hospital_id)
  INCLUDE (role_id, branch_id, scope, conditions)
  WHERE active = true;

-- Licence/branch expiry boards.
CREATE INDEX IF NOT EXISTS idx_branch_registrations_expiring
  ON core.org_branch_registrations (hospital_id, valid_to)
  WHERE valid_to IS NOT NULL AND status = 'valid';

-- Devices that are still paired.
CREATE INDEX IF NOT EXISTS idx_devices_active
  ON core.devices (hospital_id, branch_id, kind)
  WHERE revoked_at IS NULL;

-- Files awaiting a virus scan; docs/04 §4 requires the scan before use.
CREATE INDEX IF NOT EXISTS idx_files_awaiting_scan
  ON core.files (created_at)
  WHERE status IN ('pending_upload', 'scanning');

-- Legal hold blocks archival at the row level (docs/04 §5). The retention job
-- must be able to ask "is anything in this partition held?" cheaply.
CREATE INDEX IF NOT EXISTS idx_files_legal_hold
  ON core.files (hospital_id)
  WHERE legal_hold = true;

-- ── uniqueness Prisma cannot express ─────────────────────────────────────────

-- A soft-deleted erroneous account must not block reuse of its username, but two
-- live accounts must never share one. Prisma cannot express a partial unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_group_username_live
  ON core.users (group_id, username)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_group_email_live
  ON core.users (group_id, lower(email))
  WHERE deleted_at IS NULL AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_hospital_employee_live
  ON core.users (hospital_id, employee_id)
  WHERE deleted_at IS NULL AND employee_id IS NOT NULL;

-- Settings are a hierarchy of nullable scopes. Postgres treats NULLs as distinct
-- in a plain unique constraint, which would allow two hospital-level rows for the
-- same key. `NULLS NOT DISTINCT` (PostgreSQL 15+) is exactly the right tool.
CREATE UNIQUE INDEX IF NOT EXISTS uq_settings_scope
  ON core.settings (hospital_id, branch_id, department_id, user_id, key)
  NULLS NOT DISTINCT;

-- One live pairing code at a time per device.
CREATE UNIQUE INDEX IF NOT EXISTS uq_devices_pairing_code
  ON core.devices (pairing_code)
  WHERE pairing_code IS NOT NULL AND paired_at IS NULL;

-- ── trigram search (docs/07 §4) ──────────────────────────────────────────────
-- EN-007 §13 budgets user search at p95 < 150 ms over ~6000 users. Patient
-- trigram indexes arrive with `patient.patients` in Phase 1.
CREATE INDEX IF NOT EXISTS idx_users_display_name_trgm
  ON core.users USING gin (display_name ext.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_users_username_trgm
  ON core.users USING gin (username ext.gin_trgm_ops);

-- Free-text search over audit reasons (EN-024 §4).
CREATE INDEX IF NOT EXISTS idx_audit_reason_trgm
  ON core.audit_log USING gin (reason_text ext.gin_trgm_ops);

-- ── overlap prevention via btree_gist ────────────────────────────────────────
-- A user must not hold two overlapping grants for the same branch, or the
-- effective-permission answer becomes ambiguous. An exclusion constraint makes
-- that structurally impossible rather than a service-layer check that some future
-- code path forgets. (The bed-occupancy exclusion docs/09 §9.5 requires arrives
-- with `ip.beds` in Phase 7 and uses the same mechanism.)
ALTER TABLE core.org_user_branch_access
  ADD CONSTRAINT org_user_branch_access_no_overlap
  EXCLUDE USING gist (
    user_id WITH =,
    branch_id WITH =,
    tstzrange(from_at, COALESCE(to_at, 'infinity'::timestamptz)) WITH &&
  );

-- ── autovacuum tuning (docs/07 §5) ───────────────────────────────────────────
-- Postgres refuses storage parameters on a partitioned *parent* — they belong to
-- the leaf partitions. So the settings live in a helper that both this migration
-- and core.ensure_month_partition() apply, which means a partition created in
-- 2029 is tuned the same way as one created today. Getting this wrong is subtle:
-- an untuned partition on an append-only table still works, it just bloats.
CREATE OR REPLACE FUNCTION core.apply_partition_storage_params(p_qualified_partition text, p_profile text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_profile = 'append_only' THEN
    -- Inserts only (corrections are new rows per docs/03), so vacuum exists purely
    -- to set visibility-map bits and clean up failed inserts. fillfactor 100
    -- because nothing is ever updated in place.
    EXECUTE format(
      'ALTER TABLE %s SET (autovacuum_vacuum_insert_scale_factor = 0.05, fillfactor = 100)',
      p_qualified_partition);
  ELSIF p_profile = 'churny' THEN
    -- Status columns are rewritten repeatedly. Leaving 15 %% free lets Postgres do
    -- HOT updates in place; docs/07 §5 wants n_tup_hot_upd/n_tup_upd > 0.8.
    EXECUTE format(
      'ALTER TABLE %s SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 5000, '
      'autovacuum_analyze_scale_factor = 0.01, fillfactor = 85)',
      p_qualified_partition);
  END IF;
END;
$$;

-- Apply to every partition that already exists.
DO $$
DECLARE
  r record;
  v_profile text;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS partition_name, pn.relname AS parent_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class pn ON pn.oid = i.inhparent
    WHERE n.nspname = 'core'
      AND pn.relname IN ('audit_log', 'login_audit', 'org_cross_branch_access_log', 'outbox_events', 'sessions')
  LOOP
    v_profile := CASE
      WHEN r.parent_name IN ('audit_log', 'login_audit', 'org_cross_branch_access_log') THEN 'append_only'
      ELSE 'churny'
    END;
    PERFORM core.apply_partition_storage_params(
      format('%I.%I', r.schema_name, r.partition_name), v_profile);
  END LOOP;
END
$$;

-- Non-partitioned churny tables can be tuned directly.
ALTER TABLE core.idempotency_keys
  SET (autovacuum_vacuum_scale_factor = 0.05, fillfactor = 85);
ALTER TABLE core.user_roles
  SET (fillfactor = 90);
ALTER TABLE core.audit_break_glass
  SET (fillfactor = 90);

-- Extended statistics for high-cardinality filters the planner routinely
-- underestimates (docs/07 §5).
ALTER TABLE core.users ALTER COLUMN display_name SET STATISTICS 500;
ALTER TABLE core.audit_log ALTER COLUMN entity SET STATISTICS 500;
ALTER TABLE core.audit_log ALTER COLUMN patient_id SET STATISTICS 500;
ALTER TABLE core.outbox_events ALTER COLUMN event_type SET STATISTICS 500;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP INDEX IF EXISTS core.idx_outbox_unpublished, core.idx_outbox_dead_lettered,
--     core.idx_sessions_live, core.idx_login_audit_failures, core.idx_break_glass_pending,
--     core.idx_audit_phi_access, core.idx_audit_denied, core.idx_idempotency_in_flight,
--     core.idx_access_requests_pending, core.idx_user_roles_active,
--     core.idx_branch_registrations_expiring, core.idx_devices_active,
--     core.idx_files_awaiting_scan, core.idx_files_legal_hold,
--     core.uq_users_group_username_live, core.uq_users_group_email_live,
--     core.uq_users_hospital_employee_live, core.uq_settings_scope,
--     core.uq_devices_pairing_code, core.idx_users_display_name_trgm,
--     core.idx_users_username_trgm, core.idx_audit_reason_trgm;
--   ALTER TABLE core.org_user_branch_access DROP CONSTRAINT org_user_branch_access_no_overlap;
--   DROP FUNCTION IF EXISTS core.ensure_month_partition(text, text, date);
--   -- Partitions are NOT dropped by a rollback: they hold data. Detach and
--   -- archive them through the retention job instead (docs/07 §5).
-- ─────────────────────────────────────────────────────────────────────────────
