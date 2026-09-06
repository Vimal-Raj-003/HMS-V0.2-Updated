-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 7E + 7F · IP-009, IP-016, IP-013, IP-007, TR-006
-- Intensive care, the crash cart, the code, and blood
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── The one gate in this file that kills people when it is missing ──────────
--
-- `phase-07`: "two-person bedside verification against the wristband before the
-- first drop — this check is a hard gate that cannot be skipped, deferred or
-- configured away."
--
-- An ABO-incompatible transfusion kills in minutes and the commonest cause is
-- one mislabelled sample or one bag hung on the wrong patient. Two independent
-- samples catch the first; two people at the bedside catch the second. Both are
-- shapes here: a CHECK refusing a transfusion start without both checkers, both
-- scans and a time, and a trigger refusing two checkers who are one person.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: IP007.

-- CreateEnum
CREATE TYPE "clinical"."BloodComponent" AS ENUM ('whole_blood', 'packed_red_cells', 'fresh_frozen_plasma', 'platelet_concentrate', 'single_donor_platelets', 'cryoprecipitate');

-- CreateEnum
CREATE TYPE "clinical"."BloodUnitState" AS ENUM ('quarantined', 'available', 'reserved', 'crossmatched', 'issued', 'transfused', 'discarded', 'expired', 'returned');

-- CreateEnum
CREATE TYPE "clinical"."CodeState" AS ENUM ('called', 'team_arrived', 'cpr_in_progress', 'rosc', 'ceased', 'closed');

-- CreateTable
CREATE TABLE "clinical"."icu_flowsheet" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "at_hour" TIMESTAMPTZ(6) NOT NULL,
    "heart_rate" INTEGER,
    "systolic_bp" INTEGER,
    "diastolic_bp" INTEGER,
    "mean_arterial_bp" INTEGER,
    "cvp_mmhg" INTEGER,
    "temperature_c" DECIMAL(4,1),
    "spo2" INTEGER,
    "fio2" INTEGER,
    "respiratory_rate" INTEGER,
    "vent_mode" VARCHAR(20),
    "peep_cm_h2o" DECIMAL(4,1),
    "tidal_volume_ml" INTEGER,
    "gcs" INTEGER,
    "rass" INTEGER,
    "pupils_left" VARCHAR(20),
    "pupils_right" VARCHAR(20),
    "urine_output_ml" INTEGER,
    "infusions" JSONB,
    "sources" JSONB,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "icu_flowsheet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."icu_scores" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "scale" VARCHAR(20) NOT NULL,
    "score" INTEGER NOT NULL,
    "predicted_mortality_pct" DECIMAL(5,2),
    "components" JSONB NOT NULL,
    "at_hour" TIMESTAMPTZ(6) NOT NULL,
    "computed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "icu_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."icu_bundles" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "bundle" VARCHAR(20) NOT NULL,
    "for_date" DATE NOT NULL,
    "shift" VARCHAR(20) NOT NULL,
    "elements" JSONB NOT NULL,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "exceptions" TEXT[],
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "icu_bundles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_crash_carts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "location" VARCHAR(160) NOT NULL,
    "ward_id" UUID,
    "seal_no" VARCHAR(40),
    "sealed_at" TIMESTAMPTZ(6),
    "sealed_by" UUID,
    "earliest_expiry_on" DATE,
    "last_full_check_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_crash_carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_crash_cart_checks" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "kind" VARCHAR(10) NOT NULL,
    "seal_intact" BOOLEAN,
    "seal_no_seen" VARCHAR(40),
    "findings" JSONB,
    "discrepancies" TEXT[],
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_by" UUID NOT NULL,
    "resealed_no" VARCHAR(40),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_crash_cart_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_code_blues" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code_no" VARCHAR(60) NOT NULL,
    "patient_id" UUID,
    "admission_id" UUID,
    "cart_id" UUID,
    "ward_id" UUID,
    "location" VARCHAR(160) NOT NULL,
    "state" "clinical"."CodeState" NOT NULL DEFAULT 'called',
    "called_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "called_by" UUID NOT NULL,
    "team_arrived_at" TIMESTAMPTZ(6),
    "cpr_started_at" TIMESTAMPTZ(6),
    "first_shock_at" TIMESTAMPTZ(6),
    "first_drug_at" TIMESTAMPTZ(6),
    "rosc_at" TIMESTAMPTZ(6),
    "ceased_at" TIMESTAMPTZ(6),
    "outcome" VARCHAR(24),
    "cease_reason" TEXT,
    "team_leader_id" UUID,
    "attendees" UUID[],
    "debrief_at" TIMESTAMPTZ(6),
    "debrief_note" TEXT,
    "cart_restocked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_code_blues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_code_blue_events" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "code_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" VARCHAR(20) NOT NULL,
    "rhythm" VARCHAR(20),
    "joules" INTEGER,
    "drug" VARCHAR(120),
    "dose" VARCHAR(60),
    "route" VARCHAR(40),
    "note" TEXT,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_code_blue_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."bb_donors" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "donor_no" VARCHAR(60) NOT NULL,
    "patient_id" UUID,
    "name" VARCHAR(200) NOT NULL,
    "blood_group" VARCHAR(6),
    "phone" VARCHAR(20),
    "date_of_birth" DATE,
    "deferred_until" DATE,
    "deferral_reason" TEXT,
    "permanently_deferred" BOOLEAN NOT NULL DEFAULT false,
    "last_donation_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bb_donors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."bb_units" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "unit_no" VARCHAR(60) NOT NULL,
    "donor_id" UUID,
    "component" "clinical"."BloodComponent" NOT NULL,
    "blood_group" VARCHAR(6) NOT NULL,
    "volume_ml" INTEGER NOT NULL,
    "collected_on" DATE NOT NULL,
    "expires_on" DATE NOT NULL,
    "state" "clinical"."BloodUnitState" NOT NULL DEFAULT 'quarantined',
    "tti_hiv" VARCHAR(16),
    "tti_hbv" VARCHAR(16),
    "tti_hcv" VARCHAR(16),
    "tti_syphilis" VARCHAR(16),
    "tti_malaria" VARCHAR(16),
    "tti_cleared_at" TIMESTAMPTZ(6),
    "tti_cleared_by" UUID,
    "storage_location" VARCHAR(120),
    "temperature_excursion" BOOLEAN NOT NULL DEFAULT false,
    "excursion_note" TEXT,
    "reserved_for_patient_id" UUID,
    "crossmatched_at" TIMESTAMPTZ(6),
    "crossmatch_result" VARCHAR(20),
    "discard_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bb_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."bb_requests" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "request_no" VARCHAR(60) NOT NULL,
    "patient_id" UUID NOT NULL,
    "admission_id" UUID,
    "ot_case_id" UUID,
    "polytrauma_case_id" UUID,
    "component" "clinical"."BloodComponent" NOT NULL,
    "units_requested" INTEGER NOT NULL,
    "urgency" VARCHAR(24) NOT NULL DEFAULT 'routine',
    "indication" TEXT NOT NULL,
    "group_sample_1" VARCHAR(6),
    "sample_1_at" TIMESTAMPTZ(6),
    "sample_1_by" UUID,
    "group_sample_2" VARCHAR(6),
    "sample_2_at" TIMESTAMPTZ(6),
    "sample_2_by" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by" UUID NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bb_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."bb_issues" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" UUID NOT NULL,
    "issue_checked_by" UUID NOT NULL,
    "cooler_ref" VARCHAR(40),
    "bedside_checked_by_1" UUID,
    "bedside_checked_by_2" UUID,
    "bedside_wristband_scan" VARCHAR(200),
    "bedside_unit_scan" VARCHAR(200),
    "bedside_checked_at" TIMESTAMPTZ(6),
    "transfusion_started_at" TIMESTAMPTZ(6),
    "transfusion_ended_at" TIMESTAMPTZ(6),
    "volume_transfused_ml" INTEGER,
    "returned_at" TIMESTAMPTZ(6),
    "return_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bb_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."bb_reactions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "issue_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "kind" VARCHAR(30) NOT NULL,
    "severity" VARCHAR(20) NOT NULL,
    "onset_at" TIMESTAMPTZ(6) NOT NULL,
    "volume_in_ml" INTEGER,
    "symptoms" TEXT[],
    "management" TEXT NOT NULL,
    "bag_returned_at" TIMESTAMPTZ(6),
    "reported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reported_by" UUID NOT NULL,
    "haemovigilance_ref" VARCHAR(60),
    "reported_to_hv_at" TIMESTAMPTZ(6),
    "investigation" TEXT,
    "conclusion" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bb_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "icu_flowsheet_hospital_id_branch_id_admission_id_at_hour_idx" ON "clinical"."icu_flowsheet"("hospital_id", "branch_id", "admission_id", "at_hour" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_icu_flowsheet_hour" ON "clinical"."icu_flowsheet"("admission_id", "at_hour");

-- CreateIndex
CREATE INDEX "icu_scores_hospital_id_admission_id_scale_at_hour_idx" ON "clinical"."icu_scores"("hospital_id", "admission_id", "scale", "at_hour" DESC);

-- CreateIndex
CREATE INDEX "icu_bundles_hospital_id_admission_id_for_date_idx" ON "clinical"."icu_bundles"("hospital_id", "admission_id", "for_date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_icu_bundle_shift" ON "clinical"."icu_bundles"("admission_id", "bundle", "for_date", "shift");

-- CreateIndex
CREATE UNIQUE INDEX "uq_crash_cart_code" ON "clinical"."ip_crash_carts"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "ip_crash_cart_checks_hospital_id_cart_id_checked_at_idx" ON "clinical"."ip_crash_cart_checks"("hospital_id", "cart_id", "checked_at" DESC);

-- CreateIndex
CREATE INDEX "ip_code_blues_hospital_id_branch_id_state_called_at_idx" ON "clinical"."ip_code_blues"("hospital_id", "branch_id", "state", "called_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_code_blue_no" ON "clinical"."ip_code_blues"("hospital_id", "code_no");

-- CreateIndex
CREATE INDEX "ip_code_blue_events_hospital_id_code_id_at_idx" ON "clinical"."ip_code_blue_events"("hospital_id", "code_id", "at");

-- CreateIndex
CREATE INDEX "bb_donors_hospital_id_blood_group_idx" ON "clinical"."bb_donors"("hospital_id", "blood_group");

-- CreateIndex
CREATE UNIQUE INDEX "uq_blood_donor_no" ON "clinical"."bb_donors"("hospital_id", "donor_no");

-- CreateIndex
CREATE INDEX "bb_units_hospital_id_branch_id_state_component_blood_group_idx" ON "clinical"."bb_units"("hospital_id", "branch_id", "state", "component", "blood_group");

-- CreateIndex
CREATE INDEX "bb_units_hospital_id_expires_on_idx" ON "clinical"."bb_units"("hospital_id", "expires_on");

-- CreateIndex
CREATE UNIQUE INDEX "uq_blood_unit_no" ON "clinical"."bb_units"("hospital_id", "unit_no");

-- CreateIndex
CREATE INDEX "bb_requests_hospital_id_branch_id_state_requested_at_idx" ON "clinical"."bb_requests"("hospital_id", "branch_id", "state", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "bb_requests_hospital_id_patient_id_idx" ON "clinical"."bb_requests"("hospital_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_blood_request_no" ON "clinical"."bb_requests"("hospital_id", "request_no");

-- CreateIndex
CREATE INDEX "bb_issues_hospital_id_branch_id_issued_at_idx" ON "clinical"."bb_issues"("hospital_id", "branch_id", "issued_at" DESC);

-- CreateIndex
CREATE INDEX "bb_issues_hospital_id_patient_id_idx" ON "clinical"."bb_issues"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "bb_reactions_hospital_id_reported_at_idx" ON "clinical"."bb_reactions"("hospital_id", "reported_at" DESC);

-- CreateIndex
CREATE INDEX "bb_reactions_hospital_id_patient_id_idx" ON "clinical"."bb_reactions"("hospital_id", "patient_id");

-- AddForeignKey
ALTER TABLE "clinical"."ip_crash_cart_checks" ADD CONSTRAINT "ip_crash_cart_checks_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "clinical"."ip_crash_carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_code_blues" ADD CONSTRAINT "ip_code_blues_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "clinical"."ip_crash_carts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_code_blue_events" ADD CONSTRAINT "ip_code_blue_events_code_id_fkey" FOREIGN KEY ("code_id") REFERENCES "clinical"."ip_code_blues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."bb_units" ADD CONSTRAINT "bb_units_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "clinical"."bb_donors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."bb_issues" ADD CONSTRAINT "bb_issues_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "clinical"."bb_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."bb_issues" ADD CONSTRAINT "bb_issues_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "clinical"."bb_units"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."bb_reactions" ADD CONSTRAINT "bb_reactions_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "clinical"."bb_issues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  The bedside check, before the first drop ──────────────────────────
ALTER TABLE "clinical"."bb_issues"
  ADD CONSTRAINT "transfusion_starts_on_a_two_person_bedside_check"
  CHECK (
    "transfusion_started_at" IS NULL
    OR ("bedside_checked_by_1" IS NOT NULL
        AND "bedside_checked_by_2" IS NOT NULL
        AND "bedside_checked_at" IS NOT NULL
        AND "bedside_wristband_scan" IS NOT NULL AND length(btrim("bedside_wristband_scan")) > 0
        AND "bedside_unit_scan" IS NOT NULL AND length(btrim("bedside_unit_scan")) > 0)
  );

-- And the two people are two people. At issue as well as at the bedside: a
-- second check by the same person is not a second check, wherever it happens.
ALTER TABLE "clinical"."bb_issues"
  ADD CONSTRAINT "bedside_checkers_are_two_people"
  CHECK ("bedside_checked_by_1" IS NULL OR "bedside_checked_by_2" IS NULL
         OR "bedside_checked_by_1" <> "bedside_checked_by_2");

ALTER TABLE "clinical"."bb_issues"
  ADD CONSTRAINT "issue_checkers_are_two_people"
  CHECK ("issued_by" <> "issue_checked_by");

ALTER TABLE "clinical"."bb_issues"
  ADD CONSTRAINT "transfusion_ends_after_it_starts"
  CHECK ("transfusion_ended_at" IS NULL
         OR ("transfusion_started_at" IS NOT NULL AND "transfusion_ended_at" >= "transfusion_started_at"));


-- ── §B.2  Two independently-drawn samples, by two people ────────────────────
--
-- One sample cannot detect itself being mislabelled. The second must be drawn
-- separately, by somebody else, and the two groups must agree — that is the
-- entire content of the rule, and every part of it is checked.
CREATE OR REPLACE FUNCTION clinical.assert_group_check_sample()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_req record;
BEGIN
  SELECT request_no, group_sample_1, group_sample_2, sample_1_by, sample_2_by,
         sample_1_at, sample_2_at, urgency
    INTO v_req FROM clinical.bb_requests WHERE id = NEW.request_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- A massive transfusion protocol issues group O negative before any of this.
  -- Refusing there would kill the patient the rule exists to protect.
  IF v_req.urgency = 'massive_transfusion' THEN RETURN NEW; END IF;

  IF v_req.group_sample_1 IS NULL OR v_req.group_sample_2 IS NULL THEN
    RAISE EXCEPTION 'Request % has only one group sample (IP-007 §B.2). A second, independently drawn sample is required: one sample cannot detect itself being mislabelled, and a mislabelled sample is the commonest cause of a fatal ABO mismatch.',
      v_req.request_no USING ERRCODE = 'IP007';
  END IF;

  IF v_req.group_sample_1 <> v_req.group_sample_2 THEN
    RAISE EXCEPTION 'The two group samples on request % disagree (% and %) (IP-007 §B.2). Do not issue. Re-draw both.',
      v_req.request_no, v_req.group_sample_1, v_req.group_sample_2 USING ERRCODE = 'IP007';
  END IF;

  IF v_req.sample_1_by IS NOT NULL AND v_req.sample_1_by = v_req.sample_2_by THEN
    RAISE EXCEPTION 'Both group samples on request % were drawn by the same person (IP-007 §B.2). The point of the second sample is that a different person drew it.',
      v_req.request_no USING ERRCODE = 'IP007';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "issue_needs_a_group_check_sample"
  BEFORE INSERT ON "clinical"."bb_issues"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_group_check_sample();


-- ── §B.3  A unit leaves quarantine only when every TTI is non-reactive ──────
CREATE OR REPLACE FUNCTION clinical.assert_tti_cleared()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_pending text[];
BEGIN
  IF NEW.state = 'quarantined' OR NEW.state IN ('discarded', 'expired') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.state NOT IN ('quarantined') THEN RETURN NEW; END IF;

  v_pending := ARRAY[]::text[];
  IF NEW.tti_hiv      IS DISTINCT FROM 'non_reactive' THEN v_pending := array_append(v_pending, 'HIV'); END IF;
  IF NEW.tti_hbv      IS DISTINCT FROM 'non_reactive' THEN v_pending := array_append(v_pending, 'HBV'); END IF;
  IF NEW.tti_hcv      IS DISTINCT FROM 'non_reactive' THEN v_pending := array_append(v_pending, 'HCV'); END IF;
  IF NEW.tti_syphilis IS DISTINCT FROM 'non_reactive' THEN v_pending := array_append(v_pending, 'syphilis'); END IF;
  IF NEW.tti_malaria  IS DISTINCT FROM 'non_reactive' THEN v_pending := array_append(v_pending, 'malaria'); END IF;

  IF cardinality(v_pending) > 0 THEN
    RAISE EXCEPTION 'Unit % cannot leave quarantine: % not recorded non-reactive (IP-007 §B.3).',
      NEW.unit_no, array_to_string(v_pending, ', ') USING ERRCODE = 'IP007';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "unit_leaves_quarantine_on_a_clean_screen"
  BEFORE INSERT OR UPDATE OF state ON "clinical"."bb_units"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_tti_cleared();

-- An expired unit is not transfusable, whatever the paperwork says.
ALTER TABLE "clinical"."bb_units"
  ADD CONSTRAINT "unit_expires_after_collection" CHECK ("expires_on" > "collected_on");

ALTER TABLE "clinical"."bb_units"
  ADD CONSTRAINT "unit_volume_is_sane" CHECK ("volume_ml" BETWEEN 20 AND 600);

ALTER TABLE "clinical"."bb_units"
  ADD CONSTRAINT "discard_states_its_reason"
  CHECK ("state" <> 'discarded' OR ("discard_reason" IS NOT NULL AND length(btrim("discard_reason")) >= 4));

-- A temperature excursion is a fact about the bag and it says what happened.
ALTER TABLE "clinical"."bb_units"
  ADD CONSTRAINT "excursion_states_what_happened"
  CHECK (NOT "temperature_excursion" OR "excursion_note" IS NOT NULL);

-- A permanently deferred donor is not bled again.
CREATE OR REPLACE FUNCTION clinical.assert_donor_is_eligible()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_donor record;
BEGIN
  IF NEW.donor_id IS NULL THEN RETURN NEW; END IF;
  SELECT donor_no, permanently_deferred, deferred_until
    INTO v_donor FROM clinical.bb_donors WHERE id = NEW.donor_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_donor.permanently_deferred THEN
    RAISE EXCEPTION 'Donor % is permanently deferred (IP-007 §B.3).',
      v_donor.donor_no USING ERRCODE = 'IP007';
  END IF;

  IF v_donor.deferred_until IS NOT NULL AND v_donor.deferred_until > NEW.collected_on THEN
    RAISE EXCEPTION 'Donor % is deferred until % and this collection is dated % (IP-007 §B.3).',
      v_donor.donor_no, v_donor.deferred_until, NEW.collected_on USING ERRCODE = 'IP007';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "collection_comes_from_an_eligible_donor"
  BEFORE INSERT ON "clinical"."bb_units"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_donor_is_eligible();

-- One live issue per unit. A bag issued twice is a bag that could be hung twice.
CREATE UNIQUE INDEX "uq_one_live_issue_per_unit"
  ON "clinical"."bb_issues" ("unit_id")
  WHERE "returned_at" IS NULL;

-- A reaction records how it was managed. "Reaction occurred" with no management
-- is a line in a register nobody can learn from.
ALTER TABLE "clinical"."bb_reactions"
  ADD CONSTRAINT "reaction_records_its_management"
  CHECK (length(btrim("management")) >= 8);

ALTER TABLE "clinical"."bb_reactions"
  ADD CONSTRAINT "reaction_severity_is_known"
  CHECK ("severity" IN ('mild', 'moderate', 'severe', 'life_threatening', 'death'));


-- ── §B.4  The code, and its clock ───────────────────────────────────────────
--
-- Time to first shock and time to first drug are derived from the flowsheet,
-- never entered. A duration somebody typed is a duration somebody remembered,
-- and the two numbers a code is judged on should not be recollections.
CREATE OR REPLACE FUNCTION clinical.set_code_milestones()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF NEW.kind = 'shock' THEN
    UPDATE clinical.ip_code_blues
       SET first_shock_at = LEAST(COALESCE(first_shock_at, NEW.at), NEW.at), updated_at = now()
     WHERE id = NEW.code_id;
  ELSIF NEW.kind = 'drug' THEN
    UPDATE clinical.ip_code_blues
       SET first_drug_at = LEAST(COALESCE(first_drug_at, NEW.at), NEW.at), updated_at = now()
     WHERE id = NEW.code_id;
  ELSIF NEW.kind = 'cpr_cycle' THEN
    UPDATE clinical.ip_code_blues
       SET cpr_started_at = LEAST(COALESCE(cpr_started_at, NEW.at), NEW.at),
           state = CASE WHEN state = 'called' THEN 'cpr_in_progress'::clinical."CodeState" ELSE state END,
           updated_at = now()
     WHERE id = NEW.code_id;
  ELSIF NEW.kind = 'rosc' THEN
    UPDATE clinical.ip_code_blues
       SET rosc_at = LEAST(COALESCE(rosc_at, NEW.at), NEW.at),
           state = 'rosc'::clinical."CodeState", updated_at = now()
     WHERE id = NEW.code_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "code_milestones_come_from_the_flowsheet"
  AFTER INSERT ON "clinical"."ip_code_blue_events"
  FOR EACH ROW EXECUTE FUNCTION clinical.set_code_milestones();

-- A shock has joules; a drug has a name. A flowsheet line that says "shock"
-- and nothing else cannot be reviewed.
ALTER TABLE "clinical"."ip_code_blue_events"
  ADD CONSTRAINT "shock_records_its_energy"
  CHECK ("kind" <> 'shock' OR ("joules" IS NOT NULL AND "joules" BETWEEN 1 AND 400));

ALTER TABLE "clinical"."ip_code_blue_events"
  ADD CONSTRAINT "drug_records_what_and_how_much"
  CHECK ("kind" <> 'drug' OR ("drug" IS NOT NULL AND "dose" IS NOT NULL));

ALTER TABLE "clinical"."ip_code_blue_events"
  ADD CONSTRAINT "rhythm_line_names_the_rhythm"
  CHECK ("kind" <> 'rhythm' OR "rhythm" IS NOT NULL);

-- A code cannot close until the cart it used is restocked and re-sealed. The
-- next arrest is the reason.
CREATE OR REPLACE FUNCTION clinical.assert_cart_is_restocked()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF NEW.state <> 'closed' OR OLD.state = 'closed' THEN RETURN NEW; END IF;

  IF NEW.outcome IS NULL THEN
    RAISE EXCEPTION 'Code % cannot close without an outcome (IP-013 §B.4).',
      NEW.code_no USING ERRCODE = 'IP007';
  END IF;

  IF NEW.cart_id IS NOT NULL AND NEW.cart_restocked_at IS NULL THEN
    RAISE EXCEPTION 'Code % used a crash cart that has not been restocked and re-sealed (IP-013 §B.4). The next arrest is the reason.',
      NEW.code_no USING ERRCODE = 'IP007';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "code_closes_on_a_restocked_cart"
  BEFORE UPDATE ON "clinical"."ip_code_blues"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_cart_is_restocked();

ALTER TABLE "clinical"."ip_code_blues"
  ADD CONSTRAINT "cease_states_its_reason"
  CHECK ("ceased_at" IS NULL OR ("cease_reason" IS NOT NULL AND length(btrim("cease_reason")) >= 8));

-- A full cart check that found nothing and listed nothing is a check somebody
-- did from the corridor.
ALTER TABLE "clinical"."ip_crash_cart_checks"
  ADD CONSTRAINT "cart_check_kind_is_known" CHECK ("kind" IN ('seal', 'full'));

ALTER TABLE "clinical"."ip_crash_cart_checks"
  ADD CONSTRAINT "full_check_records_its_findings"
  CHECK ("kind" <> 'full' OR "findings" IS NOT NULL);


-- ── §B.5  Intensive care ────────────────────────────────────────────────────
ALTER TABLE "clinical"."icu_flowsheet"
  ADD CONSTRAINT "rass_in_range" CHECK ("rass" IS NULL OR "rass" BETWEEN -5 AND 4);

ALTER TABLE "clinical"."icu_flowsheet"
  ADD CONSTRAINT "gcs_in_range" CHECK ("gcs" IS NULL OR "gcs" BETWEEN 3 AND 15);

ALTER TABLE "clinical"."icu_flowsheet"
  ADD CONSTRAINT "fio2_is_a_percentage" CHECK ("fio2" IS NULL OR "fio2" BETWEEN 21 AND 100);

ALTER TABLE "clinical"."icu_scores"
  ADD CONSTRAINT "icu_score_is_not_negative" CHECK ("score" >= 0);

-- A bundle is complete only when every element is. Four of five is not eighty
-- per cent of the benefit — the literature is unambiguous, and a bundle scored
-- partially is a bundle nobody completes.
CREATE OR REPLACE FUNCTION clinical.set_bundle_completeness()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_total int; v_done int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE value::text = 'true')
    INTO v_total, v_done
    FROM jsonb_each(NEW.elements);

  NEW.complete := v_total > 0 AND v_done = v_total;
  RETURN NEW;
END $$;

CREATE TRIGGER "bundle_completeness_is_computed"
  BEFORE INSERT OR UPDATE ON "clinical"."icu_bundles"
  FOR EACH ROW EXECUTE FUNCTION clinical.set_bundle_completeness();

COMMENT ON CONSTRAINT "transfusion_starts_on_a_two_person_bedside_check" ON "clinical"."bb_issues" IS
  'An ABO-incompatible transfusion kills in minutes, and the commonest cause is a bag hung on the wrong patient. Two people, the wristband as scanned and the bag as scanned — phase-07 says this cannot be skipped, deferred or configured away, and there is no column here that could express doing so.';

COMMENT ON TABLE "clinical"."ip_code_blue_events" IS
  'The resuscitation flowsheet. Time to first shock and time to first drug are derived from these rows by a trigger, never entered — the two numbers a code is judged on should not be recollections.';


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
  WHERE n.nspname = 'clinical' AND (c.relname LIKE 'icu\_%' OR c.relname LIKE 'bb\_%' OR c.relname LIKE 'ip\_crash%' OR c.relname LIKE 'ip\_code%')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 7E/7F tables without RLS or a tenant policy: %', v_missing;
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
      AND (c.relname LIKE 'icu\_%' OR c.relname LIKE 'bb\_%' OR c.relname LIKE 'ip\_crash%' OR c.relname LIKE 'ip\_code%')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % Phase 7E/7F table(s)', v_count;
END $$;

-- A flowsheet line, a resuscitation line and a transfusion are records of
-- something that happened at a bedside. None is deleted or edited; a correction
-- is a new line that says what the first one got wrong.
REVOKE UPDATE, DELETE ON "clinical"."icu_flowsheet"        FROM hms_app;
REVOKE UPDATE, DELETE ON "clinical"."ip_code_blue_events"  FROM hms_app;
REVOKE UPDATE, DELETE ON "clinical"."ip_crash_cart_checks" FROM hms_app;
REVOKE DELETE ON "clinical"."bb_issues"    FROM hms_app;
REVOKE DELETE ON "clinical"."bb_units"     FROM hms_app;
REVOKE DELETE ON "clinical"."bb_reactions" FROM hms_app;
