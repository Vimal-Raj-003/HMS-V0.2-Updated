-- ─────────────────────────────────────────────────────────────────────────────
-- Tenant-isolation proof, runnable against any environment
--
-- Implements the non-negotiable cases from docs/09 §3.1 at the SQL level, i.e.
-- proving that the *policy* is doing the work and not the application guard.
-- Also backs `GET /api/v1/org/rls/self-test` (EN-041 §6) and the RLS check that
-- gates a branch go-live (EN-041 §3.9.9).
--
-- Run:  docker exec -i vims-hms-postgres psql -U postgres -d vims_hms \
--         -v ON_ERROR_STOP=1 -f - < verify-isolation.sql
--
-- Every assertion RAISEs on failure, so a non-zero exit means isolation is broken
-- and the build must not ship.
-- ─────────────────────────────────────────────────────────────────────────────
\set QUIET on
SET client_min_messages = notice;

DO $outer$
DECLARE
  hosp_a  uuid := '11111111-1111-7111-8111-111111111111';
  hosp_b  uuid := '22222222-2222-7222-8222-222222222222';
  br_a    uuid := '1111111a-1111-7111-8111-111111111111';
  br_b    uuid := '2222222b-2222-7222-8222-222222222222';
  grp     uuid := '33333333-3333-7333-8333-333333333333';
  v_count bigint;
  v_open  text;
  v_fail  int := 0;
BEGIN
  -- ── fixture: two tenants that look identical (docs/09 §3.1 step 1) ─────────
  INSERT INTO core.org_groups (id, name, legal_name, updated_at)
  VALUES (grp, 'Isolation Test Group', 'Isolation Test Group Pvt Ltd', now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO core.hospitals (id, group_id, code, legal_name, display_name,
                              address, contacts, dpo, grievance_officer, updated_at)
  VALUES
    (hosp_a, grp, 'RLS-A', 'Isolation Test A Pvt Ltd', 'Isolation Test A', '{}', '{}', '{}', '{}', now()),
    (hosp_b, grp, 'RLS-B', 'Isolation Test B Pvt Ltd', 'Isolation Test B', '{}', '{}', '{}', '{}', now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO core.branches (id, hospital_id, group_id, code, name, short_name, colour_token, status, updated_at)
  VALUES
    (br_a, hosp_a, grp, 'A-MAIN', 'A Main Campus', 'A-Main', 'branch-1', 'live', now()),
    (br_b, hosp_b, grp, 'B-MAIN', 'B Main Campus', 'B-Main', 'branch-2', 'live', now())
  ON CONFLICT (id) DO NOTHING;

  RAISE NOTICE 'fixture ready: two tenants, one branch each';

  -- ── CASE 1: every application table has RLS with a write check ─────────────
  SELECT count(*) INTO v_count FROM core.v_rls_coverage WHERE NOT rls_enabled;
  IF v_count > 0 THEN
    RAISE WARNING 'FAIL case 1a: % table(s) have no row-level security', v_count;
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'PASS case 1a: RLS enabled on every application table';
  END IF;

  SELECT count(*) INTO v_count
  FROM core.v_rls_coverage WHERE is_tenant_scoped AND NOT has_write_check;
  IF v_count > 0 THEN
    -- EN-041 §3.3.3: read isolation without a write check is useless.
    RAISE WARNING 'FAIL case 1b: % tenant-scoped table(s) have no WITH CHECK clause', v_count;
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'PASS case 1b: every tenant-scoped table has both USING and WITH CHECK';
  END IF;

  -- ── CASE 2: only the sanctioned tables are world-readable ─────────────────
  SELECT string_agg(table_name, ', ' ORDER BY table_name) INTO v_open
  FROM core.v_rls_open_policies
  WHERE table_name NOT IN ('permissions', 'setting_definitions');
  IF v_open IS NOT NULL THEN
    RAISE WARNING 'FAIL case 2: unexpected open policies on: %', v_open;
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'PASS case 2: only the global catalogues are unrestricted';
  END IF;

  -- ── CASE 3: the read-only role can never write ────────────────────────────
  SELECT count(*) INTO v_count FROM core.v_grant_coverage WHERE readonly_has_write;
  IF v_count > 0 THEN
    RAISE WARNING 'FAIL case 3: hms_readonly holds a write privilege on % table(s)', v_count;
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'PASS case 3: hms_readonly is SELECT-only everywhere';
  END IF;

  -- ── CASE 4: the audit log is not mutable by the application ──────────────
  SELECT count(*) INTO v_count
  FROM core.v_grant_coverage
  WHERE table_name IN ('audit_log', 'login_audit', 'org_cross_branch_access_log')
    AND (app_can_update OR app_can_delete);
  IF v_count > 0 THEN
    RAISE WARNING 'FAIL case 4: the application role can modify % audit table(s)', v_count;
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'PASS case 4: audit tables are append-only for the application role';
  END IF;

  -- ── CASE 5: the application role does not bypass RLS ─────────────────────
  SELECT count(*) INTO v_count FROM pg_roles WHERE rolname = 'hms_app' AND rolbypassrls;
  IF v_count > 0 THEN
    RAISE WARNING 'FAIL case 5: hms_app has BYPASSRLS — tenant isolation is decorative';
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'PASS case 5: hms_app is subject to RLS (NOBYPASSRLS)';
  END IF;

  -- ── CASE 6: the application role cannot DDL ──────────────────────────────
  SELECT count(*) INTO v_count
  FROM pg_roles WHERE rolname IN ('hms_app', 'hms_readonly') AND (rolcreatedb OR rolcreaterole OR rolsuper);
  IF v_count > 0 THEN
    RAISE WARNING 'FAIL case 6: an application role holds CREATEDB/CREATEROLE/SUPERUSER';
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'PASS case 6: application roles hold no elevated attributes';
  END IF;

  -- ── CASE 7: the append-only trigger actually fires ───────────────────────
  -- Belt and braces per EN-024 §14 AC-5: the grant is revoked AND a trigger
  -- raises, so this must fail even when executed by the owner.
  INSERT INTO core.audit_log (
    id, hospital_id, occurred_at, entity, action, data_class, actor_type
  ) VALUES (
    '44444444-4444-7444-8444-444444444444', hosp_a, now(),
    'core.hospitals', 'insert', 'operational', 'system'
  ) ON CONFLICT DO NOTHING;

  BEGIN
    UPDATE core.audit_log SET entity = 'tampered'
    WHERE id = '44444444-4444-7444-8444-444444444444';
    RAISE WARNING 'FAIL case 7a: an audit row was modified — the append-only trigger did not fire';
    v_fail := v_fail + 1;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS case 7a: modifying an audit row is rejected by the database trigger';
  END;

  BEGIN
    DELETE FROM core.audit_log WHERE id = '44444444-4444-7444-8444-444444444444';
    RAISE WARNING 'FAIL case 7b: an audit row was deleted — the append-only trigger did not fire';
    v_fail := v_fail + 1;
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS case 7b: deleting an audit row is rejected by the database trigger';
  END;

  -- ── CASE 8: the chain sealer produces a verifiable chain ────────────────
  PERFORM core.seal_audit_chain(hosp_a, 100);
  SELECT count(*) INTO v_count FROM core.audit_log WHERE hospital_id = hosp_a AND sealed_at IS NULL;
  IF v_count > 0 THEN
    RAISE WARNING 'FAIL case 8a: % audit row(s) remain unsealed after sealing', v_count;
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'PASS case 8a: the chain sealer sealed every pending row';
  END IF;

  SELECT count(*) INTO v_count
  FROM core.verify_audit_chain(hosp_a, now() - interval '1 day', now() + interval '1 day');
  IF v_count > 0 THEN
    RAISE WARNING 'FAIL case 8b: chain verification reported % finding(s) on a clean chain', v_count;
    v_fail := v_fail + 1;
  ELSE
    RAISE NOTICE 'PASS case 8b: the hash chain verifies with no findings';
  END IF;

  -- ── verdict ─────────────────────────────────────────────────────────────
  IF v_fail > 0 THEN
    RAISE EXCEPTION 'TENANT ISOLATION VERIFICATION FAILED: % case(s) failed. This build must not ship.', v_fail;
  END IF;
  RAISE NOTICE '─────────────────────────────────────────────';
  RAISE NOTICE 'ALL SQL-LEVEL ISOLATION CASES PASSED';
END
$outer$;
