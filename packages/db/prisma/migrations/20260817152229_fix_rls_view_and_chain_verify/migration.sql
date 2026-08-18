-- ─────────────────────────────────────────────────────────────────────────────
-- Two defects found by `packages/db/src/rls/verify-isolation.sql`
--
-- 1. `core.v_rls_open_policies` reported the `retention_all_tenants` policies as
--    cross-tenant leaks. They are not: `hms_retention` archives whole partitions
--    and is *supposed* to span tenants, which is exactly why it is a separate
--    role that holds no privilege on any PHI-bearing business table. The view was
--    asking "which policies are unrestricted?" when the question that matters is
--    "which policies are unrestricted **for a role that serves user requests**?".
--    A monitor that cries wolf on a designed behaviour gets muted, and then it is
--    not a monitor.
--
-- 2. `core.verify_audit_chain` declared an OUT parameter named `occurred_at`
--    while its body also selects `v_row.occurred_at`, so PL/pgSQL could not
--    resolve the reference. The function raised on every call — meaning the
--    integrity check that the whole §65B evidence chain depends on had never
--    actually run to completion.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. scope the open-policy monitor to request-serving roles ────────────────
CREATE OR REPLACE VIEW core.v_rls_open_policies AS
SELECT
  n.nspname                          AS schema_name,
  c.relname                          AS table_name,
  p.polname                          AS policy_name,
  pg_get_expr(p.polqual, p.polrelid) AS using_expr,
  ARRAY(
    SELECT r.rolname FROM pg_roles r WHERE r.oid = ANY (p.polroles) ORDER BY r.rolname
  )                                  AS granted_to
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN ('core', 'mdm', 'integration')
  AND pg_get_expr(p.polqual, p.polrelid) = 'true'
  -- Only the roles that serve end-user requests. `hms_retention` is excluded by
  -- design; `hms_migrator` owns the tables and bypasses RLS anyway.
  AND EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.oid = ANY (p.polroles) AND r.rolname IN ('hms_app', 'hms_readonly')
  );

COMMENT ON VIEW core.v_rls_open_policies IS
  'Policies granting unrestricted reads to a request-serving role (hms_app / hms_readonly). The integration suite asserts this equals exactly {permissions, setting_definitions}; anything else is a cross-tenant leak. hms_retention is deliberately excluded — it spans tenants to archive partitions and holds no privilege on business tables.';

GRANT SELECT ON core.v_rls_open_policies TO hms_app, hms_readonly;

-- ── 2. rename the colliding OUT parameter ────────────────────────────────────
DROP FUNCTION IF EXISTS core.verify_audit_chain(uuid, timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION core.verify_audit_chain(
  p_hospital_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
) RETURNS TABLE (
  finding          text,
  audit_id         uuid,
  expected_seq     bigint,
  actual_seq       bigint,
  row_occurred_at  timestamptz,
  detail           text
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_row        record;
  v_prev_hash  bytea;
  v_expected   bigint;
  v_recomputed bytea;
  v_last_time  timestamptz;
BEGIN
  -- Anchor on the last sealed row before the window, so a range check still
  -- verifies linkage across the boundary rather than starting from nothing.
  SELECT al.row_hash, al.seq INTO v_prev_hash, v_expected
  FROM core.audit_log al
  WHERE al.hospital_id = p_hospital_id
    AND al.sealed_at IS NOT NULL
    AND al.occurred_at < p_from
  ORDER BY al.seq DESC
  LIMIT 1;

  v_expected := COALESCE(v_expected, 0);

  FOR v_row IN
    SELECT al.* FROM core.audit_log al
    WHERE al.hospital_id = p_hospital_id
      AND al.occurred_at >= p_from
      AND al.occurred_at < p_to
      AND al.sealed_at IS NOT NULL
    ORDER BY al.seq
  LOOP
    v_expected := v_expected + 1;

    -- 1. A gap means a row was deleted; a duplicate means one was inserted.
    IF v_row.seq <> v_expected THEN
      RETURN QUERY SELECT
        'seq_gap'::text, v_row.id, v_expected, v_row.seq, v_row.occurred_at,
        format('Expected seq %s, found %s. A gap means a row was removed from the chain.',
               v_expected, v_row.seq);
      v_expected := v_row.seq; -- resynchronise so one gap does not cascade
    END IF;

    -- 2. Broken linkage: a preceding row was modified or removed.
    IF v_row.prev_hash IS DISTINCT FROM v_prev_hash THEN
      RETURN QUERY SELECT
        'prev_hash_mismatch'::text, v_row.id, v_expected, v_row.seq, v_row.occurred_at,
        'This row does not link to its predecessor.'::text;
    END IF;

    -- 3. Content no longer matches its own hash: this row was edited after sealing.
    v_recomputed := core.audit_row_hash(
      v_row.seq, v_row.hospital_id, v_row.occurred_at, v_row.actor_user_id,
      v_row.actor_type::text, v_row.actor_role, v_row.impersonator_user_id,
      v_row.entity, v_row.row_id, v_row.action::text, v_row.patient_id,
      v_row.changed_fields, v_row.before, v_row.after, v_row.reason_code,
      v_row.reason_text, v_row.result::text, v_row.prev_hash
    );
    IF v_recomputed IS DISTINCT FROM v_row.row_hash THEN
      RETURN QUERY SELECT
        'row_hash_mismatch'::text, v_row.id, v_expected, v_row.seq, v_row.occurred_at,
        'Row content does not match its recorded hash — modified after sealing.'::text;
    END IF;

    -- 4. Back-dated insertion. Because sealing is asynchronous (DECISIONS D-16),
    --    this monotonicity check is what closes the one gap a synchronous chain
    --    would have covered by construction.
    IF v_last_time IS NOT NULL AND v_row.occurred_at < v_last_time THEN
      RETURN QUERY SELECT
        'occurred_at_regression'::text, v_row.id, v_expected, v_row.seq, v_row.occurred_at,
        format('occurred_at moved backwards from %s while seq advanced — possible back-dated insertion.',
               v_last_time);
    END IF;

    v_prev_hash := v_row.row_hash;
    v_last_time := v_row.occurred_at;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION core.verify_audit_chain IS
  'Recomputes the EN-024 §3.4 chain over a window and returns every discrepancy: seq gaps, broken linkage, rows modified after sealing, and back-dated insertions.';

GRANT EXECUTE ON FUNCTION core.verify_audit_chain(uuid, timestamptz, timestamptz) TO hms_app, hms_retention;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   Reverting reintroduces a monitor that reports false positives and an
--   integrity function that cannot execute. Neither is acceptable.
--   To revert anyway, restore the definitions from
--   ..._rls_tenant_key_exceptions and ..._audit_guards respectively.
-- ─────────────────────────────────────────────────────────────────────────────
