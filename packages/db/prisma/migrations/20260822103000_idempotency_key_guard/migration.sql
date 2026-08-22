-- ─────────────────────────────────────────────────────────────────────────────
-- Idempotency: the guarantees `core.idempotency_keys` was created to hold
--
-- The table itself has existed since `..._init_phase0_platform` and has never
-- been written to — Phase 1 shipped with `Idempotency-Key` handled ad hoc inside
-- four services and enforced by nobody. `services/api/src/core/idempotency` now
-- makes it a route decorator plus one global interceptor, and this migration
-- adds the three things that decorator relies on and the table did not have:
--
--   §A  the status vocabulary, as a constraint rather than a convention
--   §B  the invariant that a replayable row actually carries a reply
--   §C  the expiry sweep, on a documented schedule and owned by the retention
--       role rather than by the application
--
-- No new table and no new column: everything the interceptor stores already had
-- a column waiting for it (`request_hash`, `locked_until`, `response_status`,
-- `response_body`, `expires_at`) and the unique index on
-- (hospital_id, key, route) is what makes the concurrent case correct.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═════════════════════════════════════════════════════════════════════════════
-- §A. THE STATUS VOCABULARY
--
-- Three states and no others. `in_flight` means an attempt holds the key and is
-- running; `completed` means the stored response is the answer to every repeat;
-- `failed` means the attempt rolled back and the *same* request may be retried.
-- A fourth spelling arriving from a future module would silently defeat the
-- admission test in `IdempotencyService.reserve`, which decides by comparing
-- against these literals — so the database refuses it.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE core.idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_status_valid;
ALTER TABLE core.idempotency_keys
  ADD CONSTRAINT idempotency_keys_status_valid
  CHECK (status IN ('in_flight', 'completed', 'failed'));

-- An in-flight row must say when its lock lapses, or a pod that dies mid-request
-- wedges that key until the TTL expires — up to 24 hours during which a
-- receptionist cannot re-submit a registration that never completed.
ALTER TABLE core.idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_in_flight_locked;
ALTER TABLE core.idempotency_keys
  ADD CONSTRAINT idempotency_keys_in_flight_locked
  CHECK (status <> 'in_flight' OR locked_until IS NOT NULL);

-- ═════════════════════════════════════════════════════════════════════════════
-- §B. A COMPLETED ROW CARRIES A REPLY
--
-- The point of the table is that the second request gets the *first* request's
-- answer. A row marked `completed` with no `response_status` would be replayed
-- as an empty 200 — which, on `POST /patients`, tells a receptionist the
-- registration produced no patient while a patient sits in the master index.
-- ═════════════════════════════════════════════════════════════════════════════
ALTER TABLE core.idempotency_keys
  DROP CONSTRAINT IF EXISTS idempotency_keys_completed_has_response;
ALTER TABLE core.idempotency_keys
  ADD CONSTRAINT idempotency_keys_completed_has_response
  CHECK (status <> 'completed' OR (response_status IS NOT NULL AND completed_at IS NOT NULL));

-- ═════════════════════════════════════════════════════════════════════════════
-- §C. THE EXPIRY SWEEP
--
-- `docs/07` §4 fixes the cache at 24 hours, and `docs/04` §3 makes that a
-- retention obligation rather than a housekeeping preference: `response_body`
-- holds the reply verbatim, and the reply to `POST /patients` contains a name,
-- a UHID and a date of birth. A key that outlives its TTL is PHI kept past its
-- stated purpose.
--
-- Schedule: **hourly**, invoked by `services/worker` as `hms_retention`.
-- Hourly rather than daily because the table is `fillfactor = 85` and churny
-- (`..._partitions_and_indexes`), and because a sweep that runs 24 times a day
-- never has enough to do to be worth noticing, whereas one that runs once has to
-- delete a whole day at once.
--
-- It runs as the retention role and not as `hms_app` for the same reason every
-- other sweep does: `hms_app` is confined to one tenant by row-level security,
-- so an application-side purge could only ever clean the tenant that happened to
-- be making a request. `hms_retention` holds the permissive
-- `retention_all_tenants` policy created in `..._grants`, and holds SELECT and
-- DELETE on this table and nothing clinical.
-- ═════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION core.purge_expired_idempotency_keys()
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, core, pg_temp
AS $$
DECLARE
  v_deleted bigint;
BEGIN
  DELETE FROM core.idempotency_keys WHERE expires_at <= now();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

COMMENT ON FUNCTION core.purge_expired_idempotency_keys() IS
  'Deletes idempotency keys past their TTL. Run hourly by services/worker as hms_retention. Not merely housekeeping: response_body holds the first reply verbatim, so an expired key is PHI retained past the 24 h purpose stated in docs/07 §4. Returns the row count for the job log.';

GRANT EXECUTE ON FUNCTION core.purge_expired_idempotency_keys() TO hms_retention;

COMMENT ON TABLE core.idempotency_keys IS
  'CLAUDE.md §3: the store behind @Idempotent(). One row per (hospital_id, key, route) — the unique index is what serialises two simultaneous retries, because INSERT … ON CONFLICT DO UPDATE takes a row lock and the loser is refused rather than executed. `request_hash` is the fingerprint of the request that claimed the key: a repeat carrying a different body is a client bug and is refused with 409, never answered with the earlier result.';

COMMENT ON COLUMN core.idempotency_keys.request_hash IS
  'SHA-256 over method, route pattern, path params, query and body with object keys sorted. Sorted because a client that serialises non-deterministically would otherwise have every retry rejected; array order is preserved because [dose1, dose2] is not [dose2, dose1].';

COMMENT ON COLUMN core.idempotency_keys.locked_until IS
  'When the running attempt forfeits the key. Reached only if the pod holding it died — a live handler completes inside the statement timeout — so a later attempt with the same fingerprint may take it over. Nothing was committed by the dead attempt: every handler runs inside DatabaseService.withTenant, which rolls back on any throw.';

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK:
--   ALTER TABLE core.idempotency_keys
--     DROP CONSTRAINT IF EXISTS idempotency_keys_status_valid,
--     DROP CONSTRAINT IF EXISTS idempotency_keys_in_flight_locked,
--     DROP CONSTRAINT IF EXISTS idempotency_keys_completed_has_response;
--   DROP FUNCTION IF EXISTS core.purge_expired_idempotency_keys();
--
--   Reversible without data loss: this migration adds no table, column or index,
--   and every constraint it adds is satisfied by rows the interceptor writes.
--   Reversing it does not disable idempotency — the interceptor keeps working —
--   it removes the database's refusal of a state the application never intends
--   to write, and removes the scheduled purge, which then has to be done by hand.
-- ─────────────────────────────────────────────────────────────────────────────
