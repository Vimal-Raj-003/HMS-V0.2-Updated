-- ─────────────────────────────────────────────────────────────────────────────
-- Least-privilege grants
--
-- docs/04 §6: "least-privilege DB roles (app role cannot DDL; separate migration
-- role; read-only analytics role)".
-- EN-024 §3.4.4: "audit tables have **no UPDATE/DELETE grants** for application
-- roles … only the retention job (running as a separate role) may detach whole
-- partitions".
--
-- Grants are computed from the catalogue rather than listed by hand so a table
-- added in a later phase gets the right privileges automatically. The exceptions
-- are enumerated explicitly, because an exception that is generated is an
-- exception nobody reviews.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── schemas that have no models yet ──────────────────────────────────────────
-- Prisma creates a schema only when a model lives in it. `mdm`, `integration` and
-- `analytics` are declared in the datasource and will fill up in Phases 1–3
-- (EN-027 masters, EN-017 message log, the analytics read models). Creating them
-- now means the grants and default privileges below are already in place when the
-- first table lands, rather than being a step someone has to remember.
CREATE SCHEMA IF NOT EXISTS mdm AUTHORIZATION hms_migrator;
CREATE SCHEMA IF NOT EXISTS integration AUTHORIZATION hms_migrator;
CREATE SCHEMA IF NOT EXISTS analytics AUTHORIZATION hms_migrator;

-- ── schema usage ─────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA core, mdm, integration TO hms_app;
GRANT USAGE ON SCHEMA core, mdm, integration, analytics TO hms_readonly;
GRANT USAGE ON SCHEMA core TO hms_retention;

-- No role but the owner may create objects. This is what "the app role cannot
-- DDL" means concretely: an application-level SQL injection cannot CREATE TABLE,
-- DROP a policy, or define a function.
REVOKE CREATE ON SCHEMA core, mdm, integration, analytics FROM PUBLIC;
REVOKE CREATE ON SCHEMA core, mdm, integration, analytics FROM hms_app, hms_readonly, hms_retention;

-- ── the default: full DML for the application role ───────────────────────────
-- RLS then narrows every one of these to the caller's tenant. Grants say *which
-- tables*; policies say *which rows*. Both are required — a grant without a
-- policy is a cross-tenant leak, and a policy without a grant is a 42501.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, mdm, integration TO hms_app;
GRANT SELECT ON ALL TABLES IN SCHEMA core, mdm, integration, analytics TO hms_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, mdm, integration TO hms_app;

-- Future tables inherit the same treatment, so a Phase-1 migration does not have
-- to remember to grant.
ALTER DEFAULT PRIVILEGES FOR ROLE hms_migrator IN SCHEMA core, mdm, integration
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hms_migrator IN SCHEMA core, mdm, integration, analytics
  GRANT SELECT ON TABLES TO hms_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE hms_migrator IN SCHEMA core, mdm, integration
  GRANT USAGE, SELECT ON SEQUENCES TO hms_app;

-- ── the exceptions, stated one by one ────────────────────────────────────────

-- 1. `core.audit_log` — INSERT and SELECT only.
--    The chain sealer's UPDATE runs as `hms_retention`, not as the application,
--    so even the sanctioned sealing update is outside the app role's reach.
REVOKE UPDATE, DELETE ON core.audit_log FROM hms_app;
GRANT SELECT, INSERT ON core.audit_log TO hms_app;
GRANT SELECT, UPDATE ON core.audit_log TO hms_retention;

-- 2. Chain roots and integrity runs — the sealer and the integrity job write
--    them; the application only reads.
REVOKE UPDATE, DELETE ON core.audit_chain_roots FROM hms_app;
GRANT SELECT, INSERT ON core.audit_chain_roots TO hms_app;
GRANT SELECT, INSERT, UPDATE ON core.audit_chain_roots TO hms_retention;

-- 3. Gapless numbering allocations — never deleted (docs/09 §9.8). A cancelled
--    invoice keeps its number and is marked void.
REVOKE DELETE ON core.numbering_allocations FROM hms_app;

-- 4. The cross-branch disclosure log — DPDP evidence.
REVOKE UPDATE, DELETE ON core.org_cross_branch_access_log FROM hms_app;
GRANT SELECT, INSERT ON core.org_cross_branch_access_log TO hms_app;

-- 5. The login audit — 180-day CERT-In evidence, append-only.
REVOKE UPDATE, DELETE ON core.login_audit FROM hms_app;
GRANT SELECT, INSERT ON core.login_audit TO hms_app;
GRANT SELECT, UPDATE, DELETE ON core.login_audit TO hms_retention;

-- 6. Catalogues synced from packages/contracts at boot. The application reads
--    them constantly and must never be able to invent a permission key or a
--    setting definition at runtime — that would let a compromised service grant
--    itself an authorisation the code never declared.
REVOKE INSERT, UPDATE, DELETE ON core.permissions FROM hms_app;
GRANT SELECT ON core.permissions TO hms_app;
REVOKE INSERT, UPDATE, DELETE ON core.setting_definitions FROM hms_app;
GRANT SELECT ON core.setting_definitions TO hms_app;

-- 7. Retention role reach: it must be able to detach partitions from the
--    partitioned parents, which requires ownership-level rights the migration
--    role holds. Detach itself therefore runs as `hms_migrator` invoked by a job
--    authenticated as `hms_retention`; the retention role reads and archives.
GRANT SELECT ON core.audit_archives, core.audit_retention_policies TO hms_retention;
GRANT INSERT, UPDATE ON core.audit_archives TO hms_retention;
GRANT SELECT, DELETE ON core.outbox_events TO hms_retention;
GRANT SELECT, DELETE ON core.sessions TO hms_retention;
GRANT SELECT, DELETE ON core.idempotency_keys TO hms_retention;
GRANT SELECT, DELETE ON core.mfa_challenges, core.otp_codes TO hms_retention;

-- The retention role is subject to RLS like everyone else, so it needs policies.
-- It operates across tenants by design (it archives whole partitions), so it gets
-- an explicit permissive policy rather than a tenant-scoped one — and that is
-- precisely why it is a *separate* role with no ability to read PHI-bearing
-- business tables.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT unnest(ARRAY[
      'audit_log', 'audit_chain_roots', 'audit_archives', 'audit_retention_policies',
      'outbox_events', 'sessions', 'login_audit', 'idempotency_keys',
      'mfa_challenges', 'otp_codes'
    ]) AS t
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS retention_all_tenants ON core.%I', r.t);
    EXECUTE format(
      'CREATE POLICY retention_all_tenants ON core.%I FOR ALL TO hms_retention USING (true) WITH CHECK (true)',
      r.t
    );
  END LOOP;
END
$$;

-- ── function execution ───────────────────────────────────────────────────────
-- The RLS accessors must be callable by the roles the policies apply to.
GRANT EXECUTE ON FUNCTION
  core.current_hospital_id(), core.current_user_id(), core.current_scope(),
  core.current_branch_ids(), core.accessible_hospital_ids()
  TO hms_app, hms_readonly, hms_retention;

GRANT EXECUTE ON FUNCTION core.audit_row_hash(
  bigint, uuid, timestamptz, uuid, text, text, uuid, text, uuid, text, uuid,
  text[], jsonb, jsonb, text, text, text, bytea
) TO hms_app, hms_retention;

GRANT EXECUTE ON FUNCTION core.verify_audit_chain(uuid, timestamptz, timestamptz) TO hms_app, hms_retention;

-- Sealing and partition maintenance are the retention role's job, not the app's.
GRANT EXECUTE ON FUNCTION core.seal_audit_chain(uuid, int) TO hms_retention;
GRANT EXECUTE ON FUNCTION core.ensure_month_partition(text, text, date) TO hms_retention;

-- ── role attributes live with the roles, not here ────────────────────────────
-- `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` and
-- `search_path` per role (docs/07 §5) are set in
-- `infra/docker/postgres/init/00-roles.sql`, because ALTER ROLE requires
-- CREATEROLE plus ADMIN OPTION on the target — privileges the migration role
-- deliberately does not have. A migration that could alter roles could grant
-- itself superuser, which would make the whole least-privilege split decorative.

-- ── grant coverage view, for the security checklist ──────────────────────────
CREATE OR REPLACE VIEW core.v_grant_coverage AS
SELECT
  t.table_schema,
  t.table_name,
  bool_or(g.privilege_type = 'SELECT' AND g.grantee = 'hms_app') AS app_can_select,
  bool_or(g.privilege_type = 'INSERT' AND g.grantee = 'hms_app') AS app_can_insert,
  bool_or(g.privilege_type = 'UPDATE' AND g.grantee = 'hms_app') AS app_can_update,
  bool_or(g.privilege_type = 'DELETE' AND g.grantee = 'hms_app') AS app_can_delete,
  bool_or(g.grantee = 'hms_readonly' AND g.privilege_type <> 'SELECT') AS readonly_has_write
FROM information_schema.tables t
LEFT JOIN information_schema.role_table_grants g
  ON g.table_schema = t.table_schema AND g.table_name = t.table_name
WHERE t.table_schema IN ('core', 'mdm', 'integration')
  AND t.table_type = 'BASE TABLE'
GROUP BY t.table_schema, t.table_name;

COMMENT ON VIEW core.v_grant_coverage IS
  'Effective privileges per table. `readonly_has_write` true anywhere, or `app_can_update` true on core.audit_log, is a release-blocking defect (docs/04 §6, EN-024 §3.4.4).';

GRANT SELECT ON core.v_grant_coverage TO hms_app, hms_readonly;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP VIEW IF EXISTS core.v_grant_coverage;
--   REVOKE ALL ON ALL TABLES IN SCHEMA core, mdm, integration FROM hms_app, hms_readonly, hms_retention;
--   REVOKE ALL ON ALL SEQUENCES IN SCHEMA core, mdm, integration FROM hms_app;
--   ALTER DEFAULT PRIVILEGES FOR ROLE hms_migrator IN SCHEMA core, mdm, integration
--     REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM hms_app;
--
--   Broadening these grants is how tenant isolation quietly stops being real, so
--   `core.v_grant_coverage` is asserted by the integration suite on every PR.
-- ─────────────────────────────────────────────────────────────────────────────
