-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 7D · IP-006 + IP-024 + EN-003 + TR-004
-- The theatre, the WHO checklist, and sterile supply
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── Two gates, and why they are shapes ──────────────────────────────────────
--
-- 1. No incision before the time-out; no closure before sign-out with the
--    counts reconciled. `phase-07`: "Configuration may add items but may never
--    remove or bypass the three phases." A configurable checklist can be
--    configured to nothing, so the three phases are columns and a trigger reads
--    them. Extra items live in the JSON beside them and can be added freely.
--
-- 2. A load whose biological indicator failed cannot issue a set. The BI is the
--    only one of the three indicators that proves anything — Bowie-Dick tests
--    the vacuum and the chemical strip says the pack was exposed — and it takes
--    hours to read, which is why a load waits in quarantine.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: IP006.

-- CreateEnum
CREATE TYPE "clinical"."OtCaseState" AS ENUM ('requested', 'scheduled', 'ready', 'signed_in', 'timed_out', 'in_progress', 'signed_out', 'closed', 'cancelled', 'postponed');

-- CreateEnum
CREATE TYPE "clinical"."SterilisationState" AS ENUM ('received', 'decontaminated', 'inspected', 'sterilising', 'quarantined', 'released', 'failed', 'recalled');

-- CreateTable
CREATE TABLE "clinical"."ot_theatres" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(24) NOT NULL DEFAULT 'general',
    "has_laminar_flow" BOOLEAN NOT NULL DEFAULT false,
    "has_c_arm" BOOLEAN NOT NULL DEFAULT false,
    "has_microscope" BOOLEAN NOT NULL DEFAULT false,
    "turnover_minutes" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ot_theatres_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ot_cases" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "case_no" VARCHAR(60) NOT NULL,
    "patient_id" UUID NOT NULL,
    "admission_id" UUID,
    "theatre_id" UUID,
    "polytrauma_case_id" UUID,
    "fracture_id" UUID,
    "planned_procedure" VARCHAR(300) NOT NULL,
    "procedure_code" VARCHAR(40),
    "specialty" VARCHAR(60) NOT NULL,
    "side" VARCHAR(16),
    "urgency" VARCHAR(16) NOT NULL DEFAULT 'elective',
    "anaesthesia_type" VARCHAR(24),
    "asa_grade" INTEGER,
    "surgeon_id" UUID,
    "assistant_ids" UUID[],
    "anaesthetist_id" UUID,
    "scrub_nurse_id" UUID,
    "circulating_nurse_id" UUID,
    "scheduled_start" TIMESTAMPTZ(6),
    "estimated_minutes" INTEGER,
    "state" "clinical"."OtCaseState" NOT NULL DEFAULT 'requested',
    "consent_at" TIMESTAMPTZ(6),
    "consent_id" UUID,
    "site_marked_at" TIMESTAMPTZ(6),
    "site_marked_by" UUID,
    "fasting_from" TIMESTAMPTZ(6),
    "pac_cleared_at" TIMESTAMPTZ(6),
    "pac_cleared_by" UUID,
    "crossmatch_ref" VARCHAR(60),
    "antibiotic_given_at" TIMESTAMPTZ(6),
    "sign_in_at" TIMESTAMPTZ(6),
    "sign_in_by" UUID,
    "sign_in_items" JSONB,
    "time_out_at" TIMESTAMPTZ(6),
    "time_out_by" UUID,
    "time_out_items" JSONB,
    "sign_out_at" TIMESTAMPTZ(6),
    "sign_out_by" UUID,
    "sign_out_items" JSONB,
    "swab_count_in" INTEGER,
    "swab_count_out" INTEGER,
    "instrument_count_in" INTEGER,
    "instrument_count_out" INTEGER,
    "sharps_count_in" INTEGER,
    "sharps_count_out" INTEGER,
    "count_discrepancy" BOOLEAN NOT NULL DEFAULT false,
    "count_resolution" TEXT,
    "wheeled_in_at" TIMESTAMPTZ(6),
    "anaesthesia_start_at" TIMESTAMPTZ(6),
    "incision_at" TIMESTAMPTZ(6),
    "closure_at" TIMESTAMPTZ(6),
    "wheeled_out_at" TIMESTAMPTZ(6),
    "performed_procedure" TEXT,
    "findings" TEXT,
    "blood_loss_ml" INTEGER,
    "specimens" TEXT[],
    "fluoroscopy_minutes" DECIMAL(6,2),
    "fluoroscopy_dose_mgy" DECIMAL(10,2),
    "operative_note" TEXT,
    "post_op_orders" TEXT,
    "bumped_case_id" UUID,
    "bump_reason" TEXT,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ot_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."cssd_sets" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "set_type" VARCHAR(40) NOT NULL,
    "contents" JSONB,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "shelf_life_days" INTEGER NOT NULL DEFAULT 180,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cssd_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."cssd_loads" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "load_no" VARCHAR(60) NOT NULL,
    "autoclave_id" VARCHAR(40) NOT NULL,
    "cycle_no" VARCHAR(40),
    "state" "clinical"."SterilisationState" NOT NULL DEFAULT 'received',
    "peak_temperature_c" DECIMAL(6,2),
    "hold_minutes" DECIMAL(6,2),
    "peak_pressure_bar" DECIMAL(6,2),
    "bowie_dick" VARCHAR(10),
    "chemical_indicator" VARCHAR(10),
    "biological_indicator" VARCHAR(10) NOT NULL DEFAULT 'pending',
    "bi_read_at" TIMESTAMPTZ(6),
    "bi_read_by" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "released_by" UUID,
    "recalled_at" TIMESTAMPTZ(6),
    "recalled_by" UUID,
    "recall_note" TEXT,
    "operator_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cssd_loads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."cssd_load_items" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "load_id" UUID NOT NULL,
    "set_id" UUID NOT NULL,
    "expires_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cssd_load_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."cssd_issues" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "set_id" UUID NOT NULL,
    "load_id" UUID,
    "ot_case_id" UUID,
    "patient_id" UUID,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" UUID,
    "issued_to" VARCHAR(120),
    "returned_at" TIMESTAMPTZ(6),
    "returned_by" UUID,
    "return_state" VARCHAR(20),
    "recalled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cssd_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_theatre_code" ON "clinical"."ot_theatres"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "ot_cases_hospital_id_branch_id_state_scheduled_start_idx" ON "clinical"."ot_cases"("hospital_id", "branch_id", "state", "scheduled_start");

-- CreateIndex
CREATE INDEX "ot_cases_hospital_id_patient_id_idx" ON "clinical"."ot_cases"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "ot_cases_hospital_id_theatre_id_scheduled_start_idx" ON "clinical"."ot_cases"("hospital_id", "theatre_id", "scheduled_start");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ot_case_no" ON "clinical"."ot_cases"("hospital_id", "case_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cssd_set_code" ON "clinical"."cssd_sets"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "cssd_loads_hospital_id_branch_id_state_started_at_idx" ON "clinical"."cssd_loads"("hospital_id", "branch_id", "state", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_cssd_load_no" ON "clinical"."cssd_loads"("hospital_id", "load_no");

-- CreateIndex
CREATE INDEX "cssd_load_items_hospital_id_set_id_idx" ON "clinical"."cssd_load_items"("hospital_id", "set_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cssd_load_item" ON "clinical"."cssd_load_items"("load_id", "set_id");

-- CreateIndex
CREATE INDEX "cssd_issues_hospital_id_branch_id_issued_at_idx" ON "clinical"."cssd_issues"("hospital_id", "branch_id", "issued_at" DESC);

-- CreateIndex
CREATE INDEX "cssd_issues_hospital_id_load_id_idx" ON "clinical"."cssd_issues"("hospital_id", "load_id");

-- CreateIndex
CREATE INDEX "cssd_issues_hospital_id_set_id_returned_at_idx" ON "clinical"."cssd_issues"("hospital_id", "set_id", "returned_at");

-- AddForeignKey
ALTER TABLE "clinical"."ot_cases" ADD CONSTRAINT "ot_cases_theatre_id_fkey" FOREIGN KEY ("theatre_id") REFERENCES "clinical"."ot_theatres"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."cssd_load_items" ADD CONSTRAINT "cssd_load_items_load_id_fkey" FOREIGN KEY ("load_id") REFERENCES "clinical"."cssd_loads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."cssd_load_items" ADD CONSTRAINT "cssd_load_items_set_id_fkey" FOREIGN KEY ("set_id") REFERENCES "clinical"."cssd_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."cssd_issues" ADD CONSTRAINT "cssd_issues_set_id_fkey" FOREIGN KEY ("set_id") REFERENCES "clinical"."cssd_sets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."cssd_issues" ADD CONSTRAINT "cssd_issues_ot_case_id_fkey" FOREIGN KEY ("ot_case_id") REFERENCES "clinical"."ot_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  No incision before the time-out ───────────────────────────────────
--
-- The time-out is where the team says the patient's name, the procedure and the
-- side out loud, together, and stops if any of the three disagree. It is the
-- single control against wrong-site and wrong-patient surgery, and it works
-- only if the knife cannot precede it.
CREATE OR REPLACE FUNCTION clinical.assert_timeout_before_incision()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF NEW.incision_at IS NULL OR (TG_OP = 'UPDATE' AND OLD.incision_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  IF NEW.sign_in_at IS NULL THEN
    RAISE EXCEPTION 'Sign-in has not been completed on case % (IP-006 §B.1). The three phases run in order.',
      NEW.case_no USING ERRCODE = 'IP006';
  END IF;

  IF NEW.time_out_at IS NULL OR NEW.time_out_by IS NULL THEN
    RAISE EXCEPTION 'The time-out has not been completed on case % (IP-006 §B.1). It is where the team says the patient, the procedure and the side out loud together and stops if any of the three disagree — so the incision cannot precede it. There is no override.',
      NEW.case_no USING ERRCODE = 'IP006';
  END IF;

  IF NEW.incision_at < NEW.time_out_at THEN
    RAISE EXCEPTION 'The incision on case % is recorded before its time-out (IP-006 §B.1).',
      NEW.case_no USING ERRCODE = 'IP006';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "incision_follows_the_time_out"
  BEFORE INSERT OR UPDATE ON "clinical"."ot_cases"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_timeout_before_incision();


-- ── §B.2  No closure before sign-out, with the counts reconciled ────────────
--
-- A retained swab is a never event, and the count is the only thing standing
-- between a patient and one. "Reconciled" means the numbers agree; where they
-- do not, the case can still close, but only on a recorded resolution — because
-- the alternative is a theatre that leaves the case open forever and the
-- discrepancy unrecorded.
CREATE OR REPLACE FUNCTION clinical.assert_signout_before_closure()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_swab_gap int; v_instr_gap int; v_sharps_gap int;
BEGIN
  IF NEW.state <> 'closed' OR (TG_OP = 'UPDATE' AND OLD.state = 'closed') THEN
    RETURN NEW;
  END IF;

  IF NEW.sign_out_at IS NULL OR NEW.sign_out_by IS NULL THEN
    RAISE EXCEPTION 'Case % cannot close without its sign-out (IP-006 §B.2).',
      NEW.case_no USING ERRCODE = 'IP006';
  END IF;

  v_swab_gap   := COALESCE(NEW.swab_count_in, 0)       - COALESCE(NEW.swab_count_out, -1);
  v_instr_gap  := COALESCE(NEW.instrument_count_in, 0) - COALESCE(NEW.instrument_count_out, -1);
  v_sharps_gap := COALESCE(NEW.sharps_count_in, 0)     - COALESCE(NEW.sharps_count_out, -1);

  IF NEW.swab_count_in IS NULL OR NEW.swab_count_out IS NULL
     OR NEW.instrument_count_in IS NULL OR NEW.instrument_count_out IS NULL
     OR NEW.sharps_count_in IS NULL OR NEW.sharps_count_out IS NULL THEN
    RAISE EXCEPTION 'Case % cannot close without its instrument, swab and sharps counts (IP-006 §B.2). A retained swab is a never event, and the count is the only thing standing between a patient and one.',
      NEW.case_no USING ERRCODE = 'IP006';
  END IF;

  IF v_swab_gap <> 0 OR v_instr_gap <> 0 OR v_sharps_gap <> 0 THEN
    IF NEW.count_resolution IS NULL OR length(btrim(NEW.count_resolution)) < 12 THEN
      RAISE EXCEPTION 'The counts on case % do not reconcile (swabs %, instruments %, sharps %) and no resolution is recorded (IP-006 §B.2). Image the patient, find the item, or record what was done — the case may close on a resolution, never on silence.',
        NEW.case_no, v_swab_gap, v_instr_gap, v_sharps_gap USING ERRCODE = 'IP006';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "closure_follows_the_sign_out"
  BEFORE INSERT OR UPDATE ON "clinical"."ot_cases"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_signout_before_closure();

-- The discrepancy flag follows the counts, not the person filling the form.
CREATE OR REPLACE FUNCTION clinical.set_count_discrepancy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  NEW.count_discrepancy :=
       (NEW.swab_count_in IS NOT NULL AND NEW.swab_count_out IS NOT NULL
        AND NEW.swab_count_in <> NEW.swab_count_out)
    OR (NEW.instrument_count_in IS NOT NULL AND NEW.instrument_count_out IS NOT NULL
        AND NEW.instrument_count_in <> NEW.instrument_count_out)
    OR (NEW.sharps_count_in IS NOT NULL AND NEW.sharps_count_out IS NOT NULL
        AND NEW.sharps_count_in <> NEW.sharps_count_out);
  RETURN NEW;
END $$;

CREATE TRIGGER "count_discrepancy_is_computed"
  BEFORE INSERT OR UPDATE ON "clinical"."ot_cases"
  FOR EACH ROW EXECUTE FUNCTION clinical.set_count_discrepancy();

-- Each phase names the person who ran it. "The checklist was done" is not a
-- record; "Dr Rao ran the time-out at 09:14" is.
ALTER TABLE "clinical"."ot_cases"
  ADD CONSTRAINT "checklist_phases_are_owned"
  CHECK (("sign_in_at"  IS NULL) = ("sign_in_by"  IS NULL)
     AND ("time_out_at" IS NULL) = ("time_out_by" IS NULL)
     AND ("sign_out_at" IS NULL) = ("sign_out_by" IS NULL));

ALTER TABLE "clinical"."ot_cases"
  ADD CONSTRAINT "checklist_runs_in_order"
  CHECK (("time_out_at" IS NULL OR "sign_in_at" IS NULL OR "time_out_at" >= "sign_in_at")
     AND ("sign_out_at" IS NULL OR "time_out_at" IS NULL OR "sign_out_at" >= "time_out_at"));

ALTER TABLE "clinical"."ot_cases"
  ADD CONSTRAINT "ot_times_run_forward"
  CHECK (("closure_at" IS NULL OR "incision_at" IS NULL OR "closure_at" >= "incision_at")
     AND ("wheeled_out_at" IS NULL OR "wheeled_in_at" IS NULL OR "wheeled_out_at" >= "wheeled_in_at"));

-- Bumping an elective case records why. Somebody's operation was cancelled.
ALTER TABLE "clinical"."ot_cases"
  ADD CONSTRAINT "bump_states_its_reason"
  CHECK ("bumped_case_id" IS NULL
         OR ("bump_reason" IS NOT NULL AND length(btrim("bump_reason")) >= 8));

ALTER TABLE "clinical"."ot_cases"
  ADD CONSTRAINT "cancellation_states_its_reason"
  CHECK ("state" NOT IN ('cancelled', 'postponed')
         OR ("cancel_reason" IS NOT NULL AND length(btrim("cancel_reason")) >= 4));

ALTER TABLE "clinical"."ot_cases"
  ADD CONSTRAINT "asa_grade_in_range" CHECK ("asa_grade" IS NULL OR "asa_grade" BETWEEN 1 AND 6);

ALTER TABLE "clinical"."ot_cases"
  ADD CONSTRAINT "counts_are_not_negative"
  CHECK (COALESCE("swab_count_in", 0) >= 0 AND COALESCE("swab_count_out", 0) >= 0
     AND COALESCE("instrument_count_in", 0) >= 0 AND COALESCE("instrument_count_out", 0) >= 0
     AND COALESCE("sharps_count_in", 0) >= 0 AND COALESCE("sharps_count_out", 0) >= 0);


-- ── §B.3  A failed load issues nothing ──────────────────────────────────────
CREATE OR REPLACE FUNCTION clinical.assert_load_is_released()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_load record;
BEGIN
  IF NEW.load_id IS NULL THEN RETURN NEW; END IF;

  SELECT load_no, state::text AS state, biological_indicator
    INTO v_load FROM clinical.cssd_loads WHERE id = NEW.load_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_load.biological_indicator = 'fail' THEN
    RAISE EXCEPTION 'Load % failed its biological indicator and nothing from it may be issued (EN-003 §B.3). The BI is the only one of the three indicators that proves the spores died.',
      v_load.load_no USING ERRCODE = 'IP006';
  END IF;

  IF v_load.state IN ('failed', 'recalled') THEN
    RAISE EXCEPTION 'Load % is % and nothing from it may be issued (EN-003 §B.3).',
      v_load.load_no, v_load.state USING ERRCODE = 'IP006';
  END IF;

  IF v_load.state <> 'released' THEN
    RAISE EXCEPTION 'Load % is % — it has not been released (EN-003 §B.3). A pack sits in quarantine until the biological indicator reads, which takes hours; issuing before that is issuing on hope.',
      v_load.load_no, v_load.state USING ERRCODE = 'IP006';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "issue_comes_from_a_released_load"
  BEFORE INSERT OR UPDATE ON "clinical"."cssd_issues"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_load_is_released();

-- And a load cannot be released while its BI is pending or failed.
CREATE OR REPLACE FUNCTION clinical.assert_bi_before_release()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF NEW.released_at IS NULL OR (TG_OP = 'UPDATE' AND OLD.released_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  IF NEW.biological_indicator <> 'pass' THEN
    RAISE EXCEPTION 'Load % cannot be released: its biological indicator reads "%" (EN-003 §B.3). Bowie-Dick tests the vacuum and the chemical strip says the pack was exposed; only the biological one says the spores died.',
      NEW.load_no, NEW.biological_indicator USING ERRCODE = 'IP006';
  END IF;

  IF NEW.released_by IS NULL THEN
    RAISE EXCEPTION 'Releasing load % names who released it (EN-003 §B.3).',
      NEW.load_no USING ERRCODE = 'IP006';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "release_follows_the_biological_indicator"
  BEFORE INSERT OR UPDATE ON "clinical"."cssd_loads"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_bi_before_release();

ALTER TABLE "clinical"."cssd_loads"
  ADD CONSTRAINT "indicator_results_are_known"
  CHECK ("biological_indicator" IN ('pass', 'fail', 'pending')
     AND ("bowie_dick" IS NULL OR "bowie_dick" IN ('pass', 'fail', 'pending'))
     AND ("chemical_indicator" IS NULL OR "chemical_indicator" IN ('pass', 'fail', 'pending')));

ALTER TABLE "clinical"."cssd_loads"
  ADD CONSTRAINT "bi_read_is_owned"
  CHECK ("biological_indicator" = 'pending' OR ("bi_read_at" IS NOT NULL AND "bi_read_by" IS NOT NULL));

ALTER TABLE "clinical"."cssd_loads"
  ADD CONSTRAINT "recall_states_its_reason"
  CHECK ("recalled_at" IS NULL OR ("recalled_by" IS NOT NULL AND "recall_note" IS NOT NULL));

-- One live issue per set. A tray in two theatres at once is a tray somebody has
-- lost track of, and the recall list would then name the wrong patient.
CREATE UNIQUE INDEX "uq_one_live_issue_per_set"
  ON "clinical"."cssd_issues" ("set_id")
  WHERE "returned_at" IS NULL;

COMMENT ON CONSTRAINT "checklist_phases_are_owned" ON "clinical"."ot_cases" IS
  'Each phase names the person who ran it. "The checklist was done" is not a record; "Dr Rao ran the time-out at 09:14" is, and it is the one a coroner asks for.';

COMMENT ON TABLE "clinical"."cssd_issues" IS
  'Half of the recall query. Given a load whose biological indicator failed, this joins to every set issued from it and every case those sets touched — which is the list somebody needs at 6 a.m. and cannot reconstruct from paper.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §D. ROW-LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r record; v_has_hospital boolean; v_hospital_null boolean; v_has_branch boolean;
  v_using text; v_check text; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory','finance','queue','engage','billing','integration','ops')
      AND c.relkind IN ('r','p') AND c.relispartition = false
      AND c.relname NOT LIKE '\_prisma%' AND c.relname <> 'cdss_safety_floor'
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

DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'clinical' AND (c.relname LIKE 'ot\_%' OR c.relname LIKE 'cssd\_%')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 7D tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;



-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'clinical' AND c.relkind IN ('r','p') AND c.relispartition = false
      AND (c.relname LIKE 'ot\_%' OR c.relname LIKE 'cssd\_%')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % Phase 7D table(s)', v_count;
END $$;

-- An operation happened. A load was run. Neither is deleted; a correction is a
-- new record that says what the first one got wrong.
REVOKE DELETE ON "clinical"."ot_cases"    FROM hms_app;
REVOKE DELETE ON "clinical"."cssd_loads"  FROM hms_app;
REVOKE DELETE ON "clinical"."cssd_issues" FROM hms_app;
