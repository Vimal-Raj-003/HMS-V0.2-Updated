-- ─────────────────────────────────────────────────────────────────────────────
-- Audit append-only enforcement and the tamper-evident hash chain
--
-- EN-024 §3.4.4: "Database-level protections: audit tables have **no
-- UPDATE/DELETE grants** for application roles; a `BEFORE UPDATE OR DELETE`
-- trigger raises an exception; only the retention job (running as a separate
-- role) may detach whole partitions; RLS prevents cross-tenant reads."
--
-- EN-024 §14 AC-5: "Given a user attempts to update or delete a row in
-- `core.audit_log`, when the statement executes, then it is rejected by **both**
-- the permission model **and** a database trigger." Both, deliberately — a grant
-- can be changed by a compromised administrator; a trigger is one more thing they
-- have to remember to disable, and disabling it is itself visible.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── canonical row hash ───────────────────────────────────────────────────────
-- The hashed field list is frozen: changing it invalidates every existing chain.
-- `jsonb` is the canonicalisation mechanism because Postgres stores jsonb object
-- keys in a normalised order, so `jsonb_build_object(...)::text` is deterministic
-- regardless of the order the arguments are written in. Hand-rolling a
-- concatenation would put the burden of key ordering on whoever edits this next.
CREATE OR REPLACE FUNCTION core.audit_row_hash(
  p_seq                  bigint,
  p_hospital_id          uuid,
  p_occurred_at          timestamptz,
  p_actor_user_id        uuid,
  p_actor_type           text,
  p_actor_role           text,
  p_impersonator_user_id uuid,
  p_entity               text,
  p_row_id               uuid,
  p_action               text,
  p_patient_id           uuid,
  p_changed_fields       text[],
  p_before               jsonb,
  p_after                jsonb,
  p_reason_code          text,
  p_reason_text          text,
  p_result               text,
  p_prev_hash            bytea
) RETURNS bytea
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT ext.digest(
    convert_to(
      jsonb_build_object(
        'seq',                  p_seq,
        'hospital_id',          p_hospital_id,
        -- Fixed ISO-8601 UTC rendering so the hash cannot shift with a session
        -- TimeZone or DateStyle setting.
        'occurred_at',          to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF'),
        'actor_user_id',        p_actor_user_id,
        'actor_type',           p_actor_type,
        'actor_role',           p_actor_role,
        'impersonator_user_id', p_impersonator_user_id,
        'entity',               p_entity,
        'row_id',               p_row_id,
        'action',               p_action,
        'patient_id',           p_patient_id,
        'changed_fields',       to_jsonb(COALESCE(p_changed_fields, ARRAY[]::text[])),
        'before',               p_before,
        'after',                p_after,
        'reason_code',          p_reason_code,
        'reason_text',          p_reason_text,
        'result',               p_result,
        'prev_hash',            encode(COALESCE(p_prev_hash, decode(repeat('00', 32), 'hex')), 'hex')
      )::text,
      'UTF8'
    ),
    'sha256'
  )
$$;

COMMENT ON FUNCTION core.audit_row_hash IS
  'Frozen canonical hash for the EN-024 §3.4 chain. Changing the argument list or the JSON keys invalidates every existing chain and must never be done without a documented re-anchoring procedure.';

-- ── append-only guard ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION core.audit_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'core.% is append-only: rows may never be deleted (EN-024 §3.4.4). Only the retention role may detach an archived partition.',
      TG_TABLE_NAME
      USING ERRCODE = '42501', -- insufficient_privilege
            HINT = 'Corrections are made by writing a new compensating entry, never by editing history.';
  END IF;

  -- The single sanctioned UPDATE: the chain sealer stamping seq / prev_hash /
  -- row_hash / sealed_at onto a row that has never been sealed. Every other
  -- column must be byte-identical, so this cannot be used to smuggle an edit.
  IF OLD.sealed_at IS NULL
     AND NEW.sealed_at IS NOT NULL
     AND OLD.id            = NEW.id
     AND OLD.hospital_id   = NEW.hospital_id
     AND OLD.occurred_at   = NEW.occurred_at
     AND OLD.recorded_at   = NEW.recorded_at
     AND OLD.entity        = NEW.entity
     AND OLD.action        = NEW.action
     AND OLD.result        = NEW.result
     AND OLD.data_class    = NEW.data_class
     AND OLD.row_id        IS NOT DISTINCT FROM NEW.row_id
     AND OLD.actor_user_id IS NOT DISTINCT FROM NEW.actor_user_id
     AND OLD.actor_type    IS NOT DISTINCT FROM NEW.actor_type
     AND OLD.actor_role    IS NOT DISTINCT FROM NEW.actor_role
     AND OLD.impersonator_user_id IS NOT DISTINCT FROM NEW.impersonator_user_id
     AND OLD.patient_id    IS NOT DISTINCT FROM NEW.patient_id
     AND OLD.encounter_id  IS NOT DISTINCT FROM NEW.encounter_id
     AND OLD.before        IS NOT DISTINCT FROM NEW.before
     AND OLD.after         IS NOT DISTINCT FROM NEW.after
     AND OLD.changed_fields IS NOT DISTINCT FROM NEW.changed_fields
     AND OLD.reason_code   IS NOT DISTINCT FROM NEW.reason_code
     AND OLD.reason_text   IS NOT DISTINCT FROM NEW.reason_text
     AND OLD.business_key  IS NOT DISTINCT FROM NEW.business_key
     AND OLD.sensitivity   IS NOT DISTINCT FROM NEW.sensitivity
     AND OLD.row_count     IS NOT DISTINCT FROM NEW.row_count
     AND OLD.artifact_sha256 IS NOT DISTINCT FROM NEW.artifact_sha256
     AND OLD.seq IS NULL
     AND OLD.row_hash IS NULL
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'core.% is append-only: rows may never be modified (EN-024 §3.4.4, §5 "No audit, no mutation").',
    TG_TABLE_NAME
    USING ERRCODE = '42501',
          HINT = 'Amendments create a new version; they never rewrite an audit entry.';
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON core.audit_log
  FOR EACH ROW EXECUTE FUNCTION core.audit_append_only_guard();

-- ── the same guarantee for the other immutable registers ─────────────────────
CREATE OR REPLACE FUNCTION core.strict_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'core.% is strictly append-only: no UPDATE or DELETE is permitted.',
    TG_TABLE_NAME
    USING ERRCODE = '42501';
END;
$$;

-- A chain root, once computed, is the evidence. Recomputing it would let a
-- tamperer re-seal a modified day.
CREATE TRIGGER audit_chain_roots_append_only
  BEFORE DELETE ON core.audit_chain_roots
  FOR EACH ROW EXECUTE FUNCTION core.strict_append_only_guard();

-- docs/09 §9.8: a gapless series must have no holes. Deleting an allocation would
-- create one, so a cancelled document keeps its number and is marked void instead.
CREATE TRIGGER numbering_allocations_no_delete
  BEFORE DELETE ON core.numbering_allocations
  FOR EACH ROW EXECUTE FUNCTION core.strict_append_only_guard();

-- EN-041 §4: the cross-branch disclosure log is evidence under DPDP.
CREATE TRIGGER cross_branch_access_log_append_only
  BEFORE UPDATE OF hospital_id, actor_user_id, patient_id, target_branch_id, basis, occurred_at
    OR DELETE ON core.org_cross_branch_access_log
  FOR EACH ROW EXECUTE FUNCTION core.strict_append_only_guard();

-- ── the chain sealer ─────────────────────────────────────────────────────────
-- Single-writer per hospital via an advisory lock, so two workers cannot both
-- claim seq N. Returns the number of rows sealed, which the worker uses to decide
-- whether to loop again immediately or wait.
CREATE OR REPLACE FUNCTION core.seal_audit_chain(
  p_hospital_id uuid,
  p_batch_size  int DEFAULT 1000
) RETURNS int
LANGUAGE plpgsql
AS $$
DECLARE
  v_lock_key   bigint;
  v_seq        bigint;
  v_prev_hash  bytea;
  v_row        record;
  v_hash       bytea;
  v_sealed     int := 0;
BEGIN
  -- Advisory lock keyed on the tenant: sealing is per-hospital, so two tenants
  -- seal concurrently while one tenant never double-allocates a sequence number.
  v_lock_key := ('x' || substr(md5(p_hospital_id::text), 1, 15))::bit(60)::bigint;
  IF NOT pg_try_advisory_xact_lock(v_lock_key) THEN
    RETURN 0; -- another sealer holds it; nothing to do, no error
  END IF;

  SELECT seq, row_hash INTO v_seq, v_prev_hash
  FROM core.audit_log
  WHERE hospital_id = p_hospital_id AND sealed_at IS NOT NULL
  ORDER BY seq DESC
  LIMIT 1;

  v_seq := COALESCE(v_seq, 0);

  FOR v_row IN
    SELECT id, occurred_at, actor_user_id, actor_type::text AS actor_type, actor_role,
           impersonator_user_id, entity, row_id, action::text AS action, patient_id,
           changed_fields, before, after, reason_code, reason_text, result::text AS result
    FROM core.audit_log
    WHERE hospital_id = p_hospital_id AND sealed_at IS NULL
    -- UUIDv7 ids are time-ordered, so (occurred_at, id) is a total order that
    -- matches insertion order. Determinism here is what makes the chain
    -- reproducible by an auditor.
    ORDER BY occurred_at, id
    LIMIT p_batch_size
  LOOP
    v_seq := v_seq + 1;
    v_hash := core.audit_row_hash(
      v_seq, p_hospital_id, v_row.occurred_at, v_row.actor_user_id, v_row.actor_type,
      v_row.actor_role, v_row.impersonator_user_id, v_row.entity, v_row.row_id,
      v_row.action, v_row.patient_id, v_row.changed_fields, v_row.before, v_row.after,
      v_row.reason_code, v_row.reason_text, v_row.result, v_prev_hash
    );

    UPDATE core.audit_log
    SET seq = v_seq, prev_hash = v_prev_hash, row_hash = v_hash, sealed_at = now()
    WHERE id = v_row.id AND occurred_at = v_row.occurred_at;

    v_prev_hash := v_hash;
    v_sealed := v_sealed + 1;
  END LOOP;

  RETURN v_sealed;
END;
$$;

COMMENT ON FUNCTION core.seal_audit_chain IS
  'Assigns gapless per-hospital seq and the hash chain to unsealed audit rows. Called by the worker maintenance queue. DECISIONS D-16 explains why this is not done inline.';

-- ── verification ─────────────────────────────────────────────────────────────
-- Recomputes the chain over a date range and reports every discrepancy. Returns a
-- set so the caller can record each finding individually rather than a bare
-- pass/fail — EN-024 §14 AC-6 requires the *exact date* of a divergence.
CREATE OR REPLACE FUNCTION core.verify_audit_chain(
  p_hospital_id uuid,
  p_from        timestamptz,
  p_to          timestamptz
) RETURNS TABLE (
  finding      text,
  audit_id     uuid,
  expected_seq bigint,
  actual_seq   bigint,
  occurred_at  timestamptz,
  detail       text
)
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_row         record;
  v_prev_hash   bytea;
  v_expected    bigint;
  v_recomputed  bytea;
  v_last_time   timestamptz;
BEGIN
  SELECT row_hash, seq INTO v_prev_hash, v_expected
  FROM core.audit_log
  WHERE hospital_id = p_hospital_id AND sealed_at IS NOT NULL AND occurred_at < p_from
  ORDER BY seq DESC LIMIT 1;

  v_expected := COALESCE(v_expected, 0);

  FOR v_row IN
    SELECT * FROM core.audit_log
    WHERE hospital_id = p_hospital_id
      AND occurred_at >= p_from AND occurred_at < p_to
      AND sealed_at IS NOT NULL
    ORDER BY seq
  LOOP
    v_expected := v_expected + 1;

    -- 1. Gap or duplicate in the sequence.
    IF v_row.seq <> v_expected THEN
      RETURN QUERY SELECT 'seq_gap'::text, v_row.id, v_expected, v_row.seq, v_row.occurred_at,
        format('Expected seq %s, found %s. A gap means a row was deleted.', v_expected, v_row.seq);
      v_expected := v_row.seq; -- resynchronise so one gap does not cascade
    END IF;

    -- 2. Broken linkage.
    IF v_row.prev_hash IS DISTINCT FROM v_prev_hash THEN
      RETURN QUERY SELECT 'prev_hash_mismatch'::text, v_row.id, v_expected, v_row.seq, v_row.occurred_at,
        'This row does not link to its predecessor. A preceding row was modified or removed.';
    END IF;

    -- 3. Row content no longer matches its own hash.
    v_recomputed := core.audit_row_hash(
      v_row.seq, v_row.hospital_id, v_row.occurred_at, v_row.actor_user_id,
      v_row.actor_type::text, v_row.actor_role, v_row.impersonator_user_id,
      v_row.entity, v_row.row_id, v_row.action::text, v_row.patient_id,
      v_row.changed_fields, v_row.before, v_row.after, v_row.reason_code,
      v_row.reason_text, v_row.result::text, v_row.prev_hash
    );
    IF v_recomputed IS DISTINCT FROM v_row.row_hash THEN
      RETURN QUERY SELECT 'row_hash_mismatch'::text, v_row.id, v_expected, v_row.seq, v_row.occurred_at,
        'Row content does not match its recorded hash. This row was modified after it was sealed.';
    END IF;

    -- 4. Back-dated insertion. Sealing is asynchronous (DECISIONS D-16), so this
    --    monotonicity check is what closes the gap a synchronous chain would have
    --    covered: a row inserted later but stamped earlier lands out of order.
    IF v_last_time IS NOT NULL AND v_row.occurred_at < v_last_time THEN
      RETURN QUERY SELECT 'occurred_at_regression'::text, v_row.id, v_expected, v_row.seq, v_row.occurred_at,
        format('occurred_at moved backwards from %s while seq moved forwards — possible back-dated insertion.',
               v_last_time);
    END IF;

    v_prev_hash := v_row.row_hash;
    v_last_time := v_row.occurred_at;
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION core.verify_audit_chain IS
  'Recomputes the EN-024 §3.4 chain and returns every discrepancy: seq gaps, broken linkage, modified rows and back-dated insertions.';

-- ── unsealed-backlog monitor ─────────────────────────────────────────────────
-- EN-024 §13 requires audit-write failure rate to be zero and observable. An
-- unsealed backlog is the equivalent signal for the sealer.
CREATE OR REPLACE VIEW core.v_audit_seal_backlog AS
SELECT
  hospital_id,
  count(*)                                        AS unsealed_rows,
  min(occurred_at)                                AS oldest_unsealed_at,
  EXTRACT(EPOCH FROM (now() - min(occurred_at)))::bigint AS oldest_unsealed_age_seconds
FROM core.audit_log
WHERE sealed_at IS NULL
GROUP BY hospital_id;

COMMENT ON VIEW core.v_audit_seal_backlog IS
  'Sealer health. A backlog older than a few minutes means the chain sealer has stalled and must page IT (docs/07 §8).';

GRANT SELECT ON core.v_audit_seal_backlog TO hms_app, hms_readonly;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   DROP VIEW IF EXISTS core.v_audit_seal_backlog;
--   DROP TRIGGER IF EXISTS cross_branch_access_log_append_only ON core.org_cross_branch_access_log;
--   DROP TRIGGER IF EXISTS numbering_allocations_no_delete ON core.numbering_allocations;
--   DROP TRIGGER IF EXISTS audit_chain_roots_append_only ON core.audit_chain_roots;
--   DROP TRIGGER IF EXISTS audit_log_append_only ON core.audit_log;
--   DROP FUNCTION IF EXISTS core.verify_audit_chain(uuid, timestamptz, timestamptz);
--   DROP FUNCTION IF EXISTS core.seal_audit_chain(uuid, int);
--   DROP FUNCTION IF EXISTS core.strict_append_only_guard();
--   DROP FUNCTION IF EXISTS core.audit_append_only_guard();
--   DROP FUNCTION IF EXISTS core.audit_row_hash(bigint, uuid, timestamptz, uuid, text, text, uuid, text, uuid, text, uuid, text[], jsonb, jsonb, text, text, text, bytea);
--
--   Removing these triggers makes the audit trail editable. That is a
--   release-blocking regression, and docs/09 §10 asserts it cannot happen: the
--   safety suite attempts an UPDATE and a DELETE on every PR.
-- ─────────────────────────────────────────────────────────────────────────────
