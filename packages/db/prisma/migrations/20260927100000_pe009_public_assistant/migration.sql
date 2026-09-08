-- ═════════════════════════════════════════════════════════════════════════════
-- PE-009 · The public assistant, and the request that is not yet an appointment
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The landing page gets an assistant that answers questions and takes an
-- appointment request. Three decisions are made here rather than in the service,
-- because a rule in a service is a rule until somebody writes a second service.
--
-- ── 1. It captures a request, not an appointment ──────────────────────────
--
-- The obvious build is for the chat to create a row in `clinical.appointments`.
-- It must not, for two reasons that are not stylistic.
--
-- An appointment belongs to a patient, and the visitor typing into a box on the
-- internet is not one. Creating a patient from unverified text would put
-- unverified names and phone numbers into the master patient index — the exact
-- population the MPI's deduplication exists to keep clean — and every one of
-- them would have to be merged or purged by hand later.
--
-- And nothing here proves the phone number belongs to the person typing it. No
-- OTP provider is wired (open question O-2). Without that proof, a confirmed
-- booking endpoint is an anonymous write into a consultant's clinic: fill every
-- slot for a fortnight, or book a stranger's number into an appointment they
-- never asked for and will be telephoned about.
--
-- So a request lands here, front office sees it, telephones the person, and
-- books. That is also what hospitals actually do with web enquiries, and the
-- conversion is recorded in `appointment_id` so the two are never separate
-- stories.
--
-- ── 2. A row cannot exist without consent ─────────────────────────────────
--
-- DPDP 2023 wants consent recorded against the purpose it was given for. §B.1
-- makes `consent_given` a CHECK that only accepts true, so "insert without
-- consent" is not a code path that has to be remembered — it is a statement the
-- database refuses. The version of the notice they agreed to is stored beside
-- it, because a consent whose wording nobody can reconstruct is not evidence.
--
-- ── 3. The visitor's IP is never stored ───────────────────────────────────
--
-- Abuse control needs to tell two callers apart; it does not need to know where
-- either of them lives. §C keeps a SHA-256 of the address and no column that
-- could hold the address itself. Same argument as PC-PNDT, smaller stakes: a
-- column that exists is a column that can be filled.
--
-- §A  The request
-- §B  What a request may say about itself
-- §C  Abuse control that survives a rollback
-- §D  Grants
-- §E  Row-level security

-- CreateTable
CREATE TABLE "engage"."appointment_requests" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID,
    "channel" VARCHAR(24) NOT NULL DEFAULT 'web_assistant',
    "requester_name" VARCHAR(120) NOT NULL,
    "requester_phone" VARCHAR(20) NOT NULL,
    "requester_email" VARCHAR(254),
    "speciality_key" UUID,
    "practitioner_key" UUID,
    "slot_id" UUID,
    "preferred_date" DATE,
    "preferred_period" VARCHAR(12),
    -- Deliberately short, and deliberately called a reason rather than a
    -- history. A public text box that invites a symptom narrative collects
    -- health data from someone who has not been told it is being collected.
    "reason" VARCHAR(280),
    "consent_given" BOOLEAN NOT NULL,
    "consent_text_version" VARCHAR(24) NOT NULL,
    "locale" VARCHAR(12) NOT NULL DEFAULT 'en-IN',
    "status" VARCHAR(16) NOT NULL DEFAULT 'new',
    "appointment_id" UUID,
    "handled_by" UUID,
    "handled_at" TIMESTAMPTZ(6),
    "decline_reason" VARCHAR(200),
    "requester_ip_hash" BYTEA,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "appointment_requests_pkey" PRIMARY KEY ("id")
);

-- The front-office worklist: the open ones, oldest first.
CREATE INDEX "appointment_requests_worklist_idx"
  ON "engage"."appointment_requests"("hospital_id", "status", "created_at");

CREATE INDEX "appointment_requests_phone_idx"
  ON "engage"."appointment_requests"("hospital_id", "requester_phone");

-- One appointment is the conversion of at most one request. Without this, two
-- clerks working the list at once can both convert, and the second silently
-- re-points a booked appointment at a different enquiry.
CREATE UNIQUE INDEX "uq_appointment_request_conversion"
  ON "engage"."appointment_requests"("appointment_id")
  WHERE "appointment_id" IS NOT NULL;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. WHAT A REQUEST MAY SAY ABOUT ITSELF
-- ═════════════════════════════════════════════════════════════════════════════

-- §B.1  Consent is not a flag that can be false.
--
-- `NOT NULL` plus a CHECK that only accepts true. There is no INSERT that
-- records a request from somebody who did not agree to be contacted about it,
-- and no configuration that relaxes this.
ALTER TABLE "engage"."appointment_requests"
  ADD CONSTRAINT "a_request_carries_its_consent"
  CHECK ("consent_given" = true);

-- §B.2  The status vocabulary.
--
-- `IS NOT NULL` is written out rather than assumed. `NULL IN (...)` evaluates
-- to NULL, and a CHECK that evaluates to NULL *passes* — which is how an
-- unconstrained NULL gets into a column that looks constrained.
ALTER TABLE "engage"."appointment_requests"
  ADD CONSTRAINT "a_request_status_is_known"
  CHECK ("status" IS NOT NULL AND "status" IN ('new', 'contacted', 'booked', 'declined', 'expired'));

ALTER TABLE "engage"."appointment_requests"
  ADD CONSTRAINT "a_request_channel_is_known"
  CHECK ("channel" IS NOT NULL AND "channel" IN ('web_assistant', 'web_form', 'phone', 'walk_in'));

ALTER TABLE "engage"."appointment_requests"
  ADD CONSTRAINT "a_request_period_is_known"
  CHECK ("preferred_period" IS NULL
         OR "preferred_period" IN ('morning', 'afternoon', 'evening', 'any'));

-- §B.3  A booked request names what it became; a declined one says why.
--
-- Both directions matter. A request marked booked with nothing to point at
-- cannot be audited, and a request declined without a reason is indistinguishable
-- from one that was quietly dropped.
ALTER TABLE "engage"."appointment_requests"
  ADD CONSTRAINT "a_booked_request_names_its_appointment"
  CHECK ("status" <> 'booked' OR "appointment_id" IS NOT NULL);

ALTER TABLE "engage"."appointment_requests"
  ADD CONSTRAINT "a_declined_request_says_why"
  CHECK ("status" <> 'declined' OR "decline_reason" IS NOT NULL);

-- §B.4  Who handled it and when are one fact, not two.
ALTER TABLE "engage"."appointment_requests"
  ADD CONSTRAINT "a_handled_request_names_who_and_when"
  CHECK (("handled_at" IS NULL) = ("handled_by" IS NULL));

-- §B.5  A phone number that could be dialled.
--
-- Loose on purpose — this is a global product and E.164 is the only shape worth
-- insisting on. The point is to refuse a name, an empty string or an essay, not
-- to adjudicate national numbering plans in a CHECK.
ALTER TABLE "engage"."appointment_requests"
  ADD CONSTRAINT "a_request_phone_could_be_dialled"
  CHECK ("requester_phone" ~ '^\+?[0-9][0-9 ()-]{6,19}$');

-- §B.6  A conversion is final.
--
-- Same rule as RC-006 §B and for the same reason: once this request has become
-- an appointment, re-pointing it at a different one leaves the first appointment
-- with nothing that explains where it came from. `handled_at` is derived here
-- too, so "who dealt with this and when" is never a thing somebody typed.
CREATE OR REPLACE FUNCTION engage.a_request_keeps_its_appointment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.appointment_id IS NOT NULL AND NEW.appointment_id IS DISTINCT FROM OLD.appointment_id THEN
    RAISE EXCEPTION
      'This enquiry was already booked as appointment % and cannot be re-pointed at another (PE-009 §B.6). If the appointment was wrong, cancel it — an enquiry that changes what it became leaves the first appointment with nothing explaining where it came from.',
      OLD.appointment_id
      USING ERRCODE = 'PE009';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'new' THEN
    NEW.handled_at := COALESCE(NEW.handled_at, now());
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_request_keeps_its_appointment
  BEFORE UPDATE ON engage.appointment_requests
  FOR EACH ROW EXECUTE FUNCTION engage.a_request_keeps_its_appointment();

COMMENT ON TABLE "engage"."appointment_requests" IS
  'PE-009: an enquiry from the public site, not an appointment. The visitor is not yet a patient and their phone number is not yet verified, so front office telephones and books; `appointment_id` records what the enquiry became. Consent is a CHECK, not a column that can be false.';

COMMENT ON COLUMN "engage"."appointment_requests"."requester_ip_hash" IS
  'SHA-256 of the caller address, for abuse control. There is deliberately no column that could hold the address itself.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. ABUSE CONTROL THAT SURVIVES A ROLLBACK
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A public endpoint that reaches a language model is a bill and a denial-of-
-- service surface at the same time. `RATE_LIMIT_*` has been in the environment
-- contract since phase 0 with nothing reading it; this is the first endpoint
-- that genuinely cannot ship without it.
--
-- Postgres rather than Redis, following `core.idempotency_keys`: two API pods
-- share a database and do not share a mutex, and `CLAUDE.md` §8 prefers Postgres
-- to a new dependency. The counter is one row per (hospital, bucket, caller)
-- that rolls its own window, so the table is bounded by distinct callers rather
-- than growing once per request.
--
-- The service increments this in its **own** transaction, before the work. A
-- counter incremented inside the request transaction is no counter at all: the
-- attacker sends requests that fail, the transaction rolls back, and the
-- increment rolls back with it.
CREATE TABLE "engage"."public_rate_limits" (
    "hospital_id" UUID NOT NULL,
    "bucket" VARCHAR(32) NOT NULL,
    "subject_hash" BYTEA NOT NULL,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "hits" INTEGER NOT NULL,

    CONSTRAINT "public_rate_limits_pkey" PRIMARY KEY ("hospital_id", "bucket", "subject_hash")
);

ALTER TABLE "engage"."public_rate_limits"
  ADD CONSTRAINT "a_rate_limit_counts_upward"
  CHECK ("hits" > 0);

-- For the sweep that removes callers who have gone away.
CREATE INDEX "public_rate_limits_window_idx"
  ON "engage"."public_rate_limits"("window_start");

COMMENT ON TABLE "engage"."public_rate_limits" IS
  'PE-009 §C: request counters for unauthenticated endpoints, keyed on a hash of the caller. One row per caller with a self-rolling window, so the table is bounded by distinct callers rather than by traffic.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §D. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname = 'engage'
      AND c.relname IN ('appointment_requests', 'public_rate_limits')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % table(s)', v_count;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §E. ROW-LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r record; v_has_hospital boolean; v_hospital_null boolean; v_has_branch boolean;
  v_using text; v_check text; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory','finance','queue','engage','billing','integration','ops','specialty')
      AND c.relkind IN ('r','p') AND c.relispartition = false
      AND c.relname NOT LIKE '\_prisma%'
      AND c.relname NOT IN ('cdss_safety_floor','console_components','opioid_conversion_factors',
                            'immunisation_schedules','anticholinergic_scores','beers_criteria',
                            'telemedicine_drug_rules')
      AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation')
    ORDER BY n.nspname, c.relname
  LOOP
    SELECT count(*) FILTER (WHERE column_name='hospital_id') > 0,
           bool_or(column_name='hospital_id' AND is_nullable='YES'),
           count(*) FILTER (WHERE column_name='branch_id') > 0
      INTO v_has_hospital, v_hospital_null, v_has_branch
      FROM information_schema.columns
     WHERE table_schema = r.schema_name AND table_name = r.table_name;
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema_name, r.table_name);
    IF v_has_hospital AND NOT v_hospital_null THEN
      v_using := 'hospital_id = ANY (core.accessible_hospital_ids())';
      IF v_has_branch THEN v_using := v_using || ' AND (branch_id IS NULL OR branch_id = ANY (core.current_branch_ids()))'; END IF;
      v_check := v_using;
    ELSIF v_has_hospital AND v_hospital_null THEN
      v_using := '(hospital_id IS NULL OR hospital_id = ANY (core.accessible_hospital_ids()))';
      IF v_has_branch THEN v_using := v_using || ' AND (branch_id IS NULL OR branch_id = ANY (core.current_branch_ids()))'; END IF;
      v_check := 'hospital_id = ANY (core.accessible_hospital_ids())';
      IF v_has_branch THEN v_check := v_check || ' AND (branch_id IS NULL OR branch_id = ANY (core.current_branch_ids()))'; END IF;
    ELSE v_using := 'false'; v_check := 'false';
    END IF;
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', r.schema_name, r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I.%I FOR ALL TO hms_app USING (%s) WITH CHECK (%s)', r.schema_name, r.table_name, v_using, v_check);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_ro ON %I.%I', r.schema_name, r.table_name);
    EXECUTE format('CREATE POLICY tenant_isolation_ro ON %I.%I FOR SELECT TO hms_readonly USING (%s)', r.schema_name, r.table_name, v_using);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'RLS enabled on % new table(s)', v_count;
END $$;

-- Constraint names are the API's error-message keys, so two rules may not share
-- one (D-219). Re-asserted here because this migration adds seven.
DO $$
DECLARE v_dupes text;
BEGIN
  SELECT string_agg(format('%s (%s)', conname, tables), '; ' ORDER BY conname) INTO v_dupes
  FROM (
    SELECT c.conname, string_agg(DISTINCT t.relname, ', ') AS tables
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory',
                         'finance','queue','engage','billing','integration','ops','specialty')
       AND c.contype IN ('c','u','x') AND t.relispartition = false
     GROUP BY c.conname HAVING count(DISTINCT t.relname) > 1
  ) d;
  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Two rules share a constraint name: %', v_dupes;
  END IF;
END $$;
