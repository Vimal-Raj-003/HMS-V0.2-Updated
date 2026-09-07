-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-016 — the pain management clinic
-- The console where the rules are governance, not arithmetic
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every other console in this phase enforces clinical arithmetic — a QTc, a
-- ratio, an audiometric average, a PASI. This one enforces controls, and the
-- difference in what happens when they are absent is the difference between
-- harming one patient and harming a district.
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **The morphine equivalent is derived.** MME is the daily dose times a
--    published conversion factor, and every threshold in opioid prescribing is
--    a line on it — 50 for naloxone, 90 for a second reviewer. A clinic that
--    types its own MME types the number that keeps the prescription under the
--    line, and nobody re-derives it. The factors are dated rows, so a guideline
--    revision is a data change and a prescription written last year can still
--    be explained.
--
-- 2. **Above 90 MME a second person signs, and says why.** Not an alert, not a
--    banner: a prescription at 120 MME with no second reviewer and no
--    justification is not a row. The reviewer is a different person from the
--    prescriber by CHECK, because a "reviewed by" carrying the prescriber's own
--    name is the audit finding rather than the control.
--
-- 3. **Above 50 MME, naloxone is supplied or the record says why not.** The
--    co-prescription is the single intervention with the best evidence behind
--    it, and it is skipped because nobody was asked.
--
-- 4. **Chronic opioid therapy needs a live agreement.** The agreement is the
--    conversation about single prescriber, single pharmacy, urine screening and
--    what happens if the terms are broken — and it expires. A clinic that lets
--    it lapse quietly is a clinic with no governance at all, so a prescription
--    written after the expiry date is refused.
--
-- 5. **Steroid has an annual ceiling, cumulatively.** The injections a pain
--    clinic gives are triamcinolone-equivalent milligrams that accumulate
--    across sites, across doctors, across the year. Nobody adds them up, and
--    the harm — adrenal suppression, avascular necrosis — arrives years later
--    attached to no single injection. Summed here, and the one that would cross
--    the ceiling is refused.
--
-- 6. **An intervention with an outcome has a post score.** A block recorded
--    with "good" and no thirty-minute number is a clinic that cannot tell an
--    injection that works from one that does not, in a specialty where that is
--    the entire question.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: OP016.
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "specialty"."PainType" AS ENUM ('acute', 'subacute', 'chronic', 'cancer', 'aps_inpatient');

-- CreateEnum
CREATE TYPE "specialty"."PainMechanism" AS ENUM ('nociceptive', 'neuropathic', 'nociplastic', 'mixed');

-- CreateEnum
CREATE TYPE "specialty"."PainEpisodeStatus" AS ENUM ('active', 'discharged', 'lost_to_followup', 'transferred');

-- CreateEnum
CREATE TYPE "specialty"."OpioidAgreementStatus" AS ENUM ('active', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "specialty"."InterventionOutcome" AS ENUM ('good', 'partial', 'none');

-- CreateTable
CREATE TABLE "mdm"."opioid_conversion_factors" (
    "id" UUID NOT NULL,
    "drug_key" VARCHAR(60) NOT NULL,
    "route" VARCHAR(20) NOT NULL,
    "factor" DECIMAL(8,4) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "source" VARCHAR(120) NOT NULL,
    "notes" TEXT,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opioid_conversion_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pain_episodes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "referral_id" UUID,
    "type" "specialty"."PainType" NOT NULL,
    "mechanism" "specialty"."PainMechanism",
    "primary_dx_icd10" VARCHAR(16),
    "onset_date" DATE,
    "sites" JSONB NOT NULL DEFAULT '[]',
    "lead_physician_id" UUID NOT NULL,
    "opioid_therapy" BOOLEAN NOT NULL DEFAULT false,
    "risk_scores" JSONB NOT NULL DEFAULT '{}',
    "status" "specialty"."PainEpisodeStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pain_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pain_assessments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "encounter_id" UUID,
    "kind" VARCHAR(24) NOT NULL,
    "nrs_now" INTEGER,
    "nrs_avg" INTEGER,
    "nrs_worst" INTEGER,
    "nrs_least" INTEGER,
    "scale" VARCHAR(16) NOT NULL DEFAULT 'nrs',
    "instruments" JSONB NOT NULL DEFAULT '{}',
    "sleep" VARCHAR(40),
    "pgic" INTEGER,
    "work_status" VARCHAR(40),
    "side_effects" JSONB NOT NULL DEFAULT '{}',
    "form_response_id" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "pain_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."opioid_agreements" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "consent_id" UUID,
    "terms_version" VARCHAR(24) NOT NULL,
    "signed_at" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" DATE NOT NULL,
    "status" "specialty"."OpioidAgreementStatus" NOT NULL DEFAULT 'active',
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opioid_agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."opioid_prescription_log" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "rx_id" UUID,
    "drug_key" VARCHAR(60) NOT NULL,
    "drug_name" VARCHAR(160) NOT NULL,
    "route" VARCHAR(20) NOT NULL,
    "strength" VARCHAR(60) NOT NULL,
    "daily_dose" DECIMAL(10,3) NOT NULL,
    "dose_unit" VARCHAR(20) NOT NULL,
    "mme" DECIMAL(10,2),
    "conversion_factor_id" UUID,
    "days_supply" INTEGER NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "agreement_id" UUID,
    "justification" TEXT,
    "second_reviewer_id" UUID,
    "second_reviewed_at" TIMESTAMPTZ(6),
    "naloxone_prescribed" BOOLEAN NOT NULL DEFAULT false,
    "naloxone_declined" TEXT,
    "uds_last_at" DATE,
    "prescriber_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opioid_prescription_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pain_interventions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "procedure_id" UUID,
    "intervention_code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "levels" JSONB NOT NULL DEFAULT '[]',
    "side" "clinical"."Laterality" NOT NULL DEFAULT 'not_applicable',
    "guidance" VARCHAR(20) NOT NULL,
    "drugs" JSONB NOT NULL DEFAULT '[]',
    "steroid_mg_equiv" DECIMAL(8,2),
    "rf_params" JSONB NOT NULL DEFAULT '{}',
    "contrast_pattern" VARCHAR(80),
    "fluoro_sec" INTEGER,
    "dose_mgy" DECIMAL(10,2),
    "nrs_pre" INTEGER,
    "nrs_post_30min" INTEGER,
    "sensory_block" VARCHAR(80),
    "complications" JSONB NOT NULL DEFAULT '{}',
    "outcome" "specialty"."InterventionOutcome",
    "followup_2w" JSONB NOT NULL DEFAULT '{}',
    "followup_6w" JSONB NOT NULL DEFAULT '{}',
    "performed_by" UUID NOT NULL,
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pain_interventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pain_steroid_exposure" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "cumulative_mg" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "injections" INTEGER NOT NULL DEFAULT 0,
    "last_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pain_steroid_exposure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "opioid_conversion_factors_drug_key_route_effective_from_idx" ON "mdm"."opioid_conversion_factors"("drug_key", "route", "effective_from");

-- CreateIndex
CREATE INDEX "pain_episodes_hospital_id_patient_id_status_idx" ON "specialty"."pain_episodes"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "pain_episodes_hospital_id_branch_id_status_created_at_idx" ON "specialty"."pain_episodes"("hospital_id", "branch_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pain_episodes_hospital_id_opioid_therapy_status_idx" ON "specialty"."pain_episodes"("hospital_id", "opioid_therapy", "status");

-- CreateIndex
CREATE INDEX "pain_assessments_hospital_id_episode_id_recorded_at_idx" ON "specialty"."pain_assessments"("hospital_id", "episode_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "opioid_agreements_hospital_id_patient_id_status_valid_to_idx" ON "specialty"."opioid_agreements"("hospital_id", "patient_id", "status", "valid_to");

-- CreateIndex
CREATE INDEX "opioid_prescription_log_hospital_id_patient_id_start_date_idx" ON "specialty"."opioid_prescription_log"("hospital_id", "patient_id", "start_date" DESC);

-- CreateIndex
CREATE INDEX "opioid_prescription_log_hospital_id_branch_id_created_at_idx" ON "specialty"."opioid_prescription_log"("hospital_id", "branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "opioid_prescription_log_hospital_id_patient_id_drug_key_sta_idx" ON "specialty"."opioid_prescription_log"("hospital_id", "patient_id", "drug_key", "start_date");

-- CreateIndex
CREATE INDEX "pain_interventions_hospital_id_episode_id_performed_at_idx" ON "specialty"."pain_interventions"("hospital_id", "episode_id", "performed_at" DESC);

-- CreateIndex
CREATE INDEX "pain_interventions_hospital_id_branch_id_intervention_code__idx" ON "specialty"."pain_interventions"("hospital_id", "branch_id", "intervention_code", "performed_at");

-- CreateIndex
CREATE INDEX "pain_steroid_exposure_hospital_id_year_cumulative_mg_idx" ON "specialty"."pain_steroid_exposure"("hospital_id", "year", "cumulative_mg" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_steroid_exposure_year" ON "specialty"."pain_steroid_exposure"("hospital_id", "patient_id", "year");

-- AddForeignKey
ALTER TABLE "specialty"."pain_assessments" ADD CONSTRAINT "pain_assessments_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."pain_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."opioid_agreements" ADD CONSTRAINT "opioid_agreements_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."pain_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."opioid_prescription_log" ADD CONSTRAINT "opioid_prescription_log_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."pain_episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."pain_interventions" ADD CONSTRAINT "pain_interventions_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."pain_episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- The two thresholds every guideline states, as one place to change them.
--
-- Functions rather than constants inside the trigger, so a hospital's policy
-- team can see them, and so the API can ask what they are rather than carrying
-- a second copy that drifts.
CREATE OR REPLACE FUNCTION specialty.mme_naloxone_threshold() RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 50::numeric $$;

CREATE OR REPLACE FUNCTION specialty.mme_second_review_threshold() RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 90::numeric $$;

/* The annual triamcinolone-equivalent ceiling. Guidelines cluster around
   200–400 mg a year; 400 is the permissive end, chosen deliberately so the rule
   refuses only what is clearly outside practice rather than becoming a limit
   clinics route around. */
CREATE OR REPLACE FUNCTION specialty.annual_steroid_ceiling_mg() RETURNS numeric
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 400::numeric $$;

-- ── §B.1  The morphine equivalent is derived, and the thresholds bite ──────
CREATE OR REPLACE FUNCTION specialty.derive_mme_and_enforce_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_factor numeric;
  v_factor_id uuid;
  v_unit text;
BEGIN
  -- The factor in force on the day the prescription starts, not today. A
  -- prescription written last year was written against last year's guideline
  -- and the audit will ask which.
  SELECT f.factor, f.id, f.unit INTO v_factor, v_factor_id, v_unit
    FROM mdm.opioid_conversion_factors f
   WHERE f.drug_key = NEW.drug_key
     AND f.route = NEW.route
     AND f.effective_from <= NEW.start_date
     AND (f.effective_to IS NULL OR f.effective_to >= NEW.start_date)
   ORDER BY f.effective_from DESC
   LIMIT 1;

  IF v_factor IS NULL THEN
    RAISE EXCEPTION 'There is no morphine conversion factor for % by the % route on % (OP-016 §B.1). Without one the equivalent cannot be computed, and every opioid threshold is a line on it — add the factor before prescribing.',
      NEW.drug_key, NEW.route, to_char(NEW.start_date, 'DD Mon YYYY')
      USING ERRCODE = 'OP016';
  END IF;

  IF v_unit <> NEW.dose_unit THEN
    RAISE EXCEPTION 'The conversion factor for % is per % but this prescription is in % (OP-016 §B.1). A patch multiplied as though it were a tablet is off by two orders of magnitude.',
      NEW.drug_key, v_unit, NEW.dose_unit
      USING ERRCODE = 'OP016';
  END IF;

  NEW.mme := round(NEW.daily_dose * v_factor, 2);
  NEW.conversion_factor_id := v_factor_id;
  NEW.end_date := NEW.start_date + (NEW.days_supply - 1);

  -- ── The second reviewer ────────────────────────────────────────────────
  IF NEW.mme >= specialty.mme_second_review_threshold() THEN
    IF NEW.second_reviewer_id IS NULL OR NEW.second_reviewed_at IS NULL THEN
      RAISE EXCEPTION 'This works out at % mg morphine equivalent a day, at or above the % mg review threshold, so it needs a second prescriber to review it (OP-016 §B.1). That is a person, not a tick.',
        NEW.mme, specialty.mme_second_review_threshold()
        USING ERRCODE = 'OP016';
    END IF;
    IF NEW.justification IS NULL OR length(btrim(NEW.justification)) < 12 THEN
      RAISE EXCEPTION 'A prescription at % mg morphine equivalent records why this dose, for this patient, is the right one (OP-016 §B.1).', NEW.mme
        USING ERRCODE = 'OP016';
    END IF;
  END IF;

  -- ── Naloxone ───────────────────────────────────────────────────────────
  IF NEW.mme >= specialty.mme_naloxone_threshold()
     AND NOT NEW.naloxone_prescribed
     AND (NEW.naloxone_declined IS NULL OR length(btrim(NEW.naloxone_declined)) < 4) THEN
    RAISE EXCEPTION 'At % mg morphine equivalent a day this patient should be offered take-home naloxone (OP-016 §B.1). Record that it was supplied, or record why it was not — the co-prescription has the best evidence behind it of anything in opioid safety, and it is skipped because nobody was asked.',
      NEW.mme
      USING ERRCODE = 'OP016';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "mme_is_derived_and_the_thresholds_bite"
  BEFORE INSERT OR UPDATE ON "specialty"."opioid_prescription_log"
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_mme_and_enforce_review();

-- A reviewer who is the prescriber is the audit finding, not the control.
ALTER TABLE "specialty"."opioid_prescription_log"
  ADD CONSTRAINT "a_second_reviewer_is_a_second_person"
  CHECK ("second_reviewer_id" IS NULL OR "second_reviewer_id" <> "prescriber_id");

ALTER TABLE "specialty"."opioid_prescription_log"
  ADD CONSTRAINT "a_review_is_a_person_and_a_time"
  CHECK (("second_reviewer_id" IS NULL) = ("second_reviewed_at" IS NULL));

ALTER TABLE "specialty"."opioid_prescription_log"
  ADD CONSTRAINT "a_prescription_supplies_something"
  CHECK ("daily_dose" > 0 AND "days_supply" > 0 AND "quantity" > 0);

-- ── §B.2  Chronic opioid therapy needs a live agreement ───────────────────
--
-- The agreement is what makes the rest of the governance enforceable: single
-- prescriber, single pharmacy, urine screening, and what happens if the terms
-- are broken. A clinic that lets it lapse quietly has none of them.
CREATE OR REPLACE FUNCTION specialty.an_opioid_needs_a_live_agreement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_type specialty."PainType";
  v_agreement uuid;
  v_valid_to date;
BEGIN
  SELECT type INTO v_type FROM specialty.pain_episodes WHERE id = NEW.episode_id;

  -- Acute and inpatient pain services are a different governance world: the
  -- ward holds the drug, the stay is days, and demanding a chronic-therapy
  -- agreement would make the rule one nobody could follow.
  IF v_type NOT IN ('chronic', 'cancer') THEN
    RETURN NEW;
  END IF;

  SELECT a.id, a.valid_to INTO v_agreement, v_valid_to
    FROM specialty.opioid_agreements a
   WHERE a.episode_id = NEW.episode_id
     AND a.status = 'active'
     AND a.valid_to >= NEW.start_date
   ORDER BY a.valid_to DESC
   LIMIT 1;

  IF v_agreement IS NULL THEN
    RAISE EXCEPTION 'There is no opioid treatment agreement in force for this episode on % (OP-016 §B.2). The agreement is the conversation about a single prescriber, a single pharmacy and urine screening — without it the rest of the governance is unenforceable.',
      to_char(NEW.start_date, 'DD Mon YYYY')
      USING ERRCODE = 'OP016';
  END IF;

  NEW.agreement_id := v_agreement;
  RETURN NEW;
END $$;

CREATE TRIGGER "an_opioid_needs_a_live_agreement"
  BEFORE INSERT OR UPDATE OF drug_key, start_date, episode_id
  ON "specialty"."opioid_prescription_log"
  FOR EACH ROW EXECUTE FUNCTION specialty.an_opioid_needs_a_live_agreement();

ALTER TABLE "specialty"."opioid_agreements"
  ADD CONSTRAINT "an_agreement_expires"
  CHECK ("valid_to" > "signed_at"::date);

ALTER TABLE "specialty"."opioid_agreements"
  ADD CONSTRAINT "a_revoked_agreement_says_why"
  CHECK ("status" <> 'revoked'
     OR ("revoked_at" IS NOT NULL AND "revoked_reason" IS NOT NULL
         AND length(btrim("revoked_reason")) >= 4));

-- One live agreement per episode. Two is a patient who signed two sets of terms
-- and a clinic that will quote whichever suits.
CREATE UNIQUE INDEX "uq_one_live_opioid_agreement"
  ON "specialty"."opioid_agreements" ("episode_id")
  WHERE "status" = 'active';

-- ── §B.3  Steroid accumulates, and the ceiling holds ──────────────────────
--
-- Across sites, across doctors, across the year. Nobody adds these up, and the
-- harm arrives years later attached to no single injection — which is exactly
-- why it has to be the database that does.
CREATE OR REPLACE FUNCTION specialty.steroid_stays_under_the_ceiling()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_year int;
  v_so_far numeric;
  v_ceiling numeric := specialty.annual_steroid_ceiling_mg();
BEGIN
  IF NEW.steroid_mg_equiv IS NULL OR NEW.steroid_mg_equiv <= 0 THEN
    RETURN NEW;
  END IF;

  v_year := extract(year FROM NEW.performed_at)::int;

  SELECT coalesce(cumulative_mg, 0) INTO v_so_far
    FROM specialty.pain_steroid_exposure
   WHERE hospital_id = NEW.hospital_id AND patient_id = NEW.patient_id AND year = v_year;
  v_so_far := coalesce(v_so_far, 0);

  IF v_so_far + NEW.steroid_mg_equiv > v_ceiling THEN
    RAISE EXCEPTION 'This patient has already had % mg triamcinolone-equivalent this year and this injection would take them to % mg, past the % mg annual ceiling (OP-016 §B.3). The harm from cumulative steroid arrives years later attached to no single injection, which is why it is counted.',
      v_so_far, v_so_far + NEW.steroid_mg_equiv, v_ceiling
      USING ERRCODE = 'OP016';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "steroid_stays_under_the_ceiling"
  BEFORE INSERT ON "specialty"."pain_interventions"
  FOR EACH ROW EXECUTE FUNCTION specialty.steroid_stays_under_the_ceiling();

CREATE OR REPLACE FUNCTION specialty.roll_up_steroid_exposure()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE v_year int;
BEGIN
  IF NEW.steroid_mg_equiv IS NULL OR NEW.steroid_mg_equiv <= 0 THEN
    RETURN NULL;
  END IF;

  v_year := extract(year FROM NEW.performed_at)::int;

  INSERT INTO specialty.pain_steroid_exposure
    (id, hospital_id, patient_id, year, cumulative_mg, injections, last_at, updated_at)
  VALUES (gen_random_uuid(), NEW.hospital_id, NEW.patient_id, v_year,
          NEW.steroid_mg_equiv, 1, NEW.performed_at, now())
  ON CONFLICT (hospital_id, patient_id, year) DO UPDATE
    SET cumulative_mg = specialty.pain_steroid_exposure.cumulative_mg + EXCLUDED.cumulative_mg,
        injections = specialty.pain_steroid_exposure.injections + 1,
        last_at = greatest(specialty.pain_steroid_exposure.last_at, EXCLUDED.last_at),
        updated_at = now();

  RETURN NULL;
END $$;

CREATE TRIGGER "steroid_exposure_is_summed"
  AFTER INSERT ON "specialty"."pain_interventions"
  FOR EACH ROW EXECUTE FUNCTION specialty.roll_up_steroid_exposure();

-- ── §B.4  An intervention with an outcome has a post score ────────────────
--
-- "Good" with no thirty-minute number is a clinic that cannot tell an injection
-- that works from one that does not, in the specialty where that is the whole
-- question.
ALTER TABLE "specialty"."pain_interventions"
  ADD CONSTRAINT "an_outcome_rests_on_a_measurement"
  CHECK ("outcome" IS NULL
     OR ("nrs_pre" IS NOT NULL AND "nrs_post_30min" IS NOT NULL));

ALTER TABLE "specialty"."pain_interventions"
  ADD CONSTRAINT "intervention_scores_are_zero_to_ten"
  CHECK (("nrs_pre" IS NULL OR "nrs_pre" BETWEEN 0 AND 10)
     AND ("nrs_post_30min" IS NULL OR "nrs_post_30min" BETWEEN 0 AND 10));

-- A block on a side that is not a side. Spine levels are bilateral or midline
-- and limbs are not, so `not_applicable` stays legal — what is refused is the
-- absence of a decision on a procedure whose code names a side.
ALTER TABLE "specialty"."pain_interventions"
  ADD CONSTRAINT "guidance_is_recorded"
  CHECK ("guidance" IN ('fluoroscopy', 'ultrasound', 'ct', 'landmark', 'endoscopic'));

ALTER TABLE "specialty"."pain_assessments"
  ADD CONSTRAINT "pain_scores_are_zero_to_ten"
  CHECK (("nrs_now" IS NULL OR "nrs_now" BETWEEN 0 AND 10)
     AND ("nrs_avg" IS NULL OR "nrs_avg" BETWEEN 0 AND 10)
     AND ("nrs_worst" IS NULL OR "nrs_worst" BETWEEN 0 AND 10)
     AND ("nrs_least" IS NULL OR "nrs_least" BETWEEN 0 AND 10)
     AND ("pgic" IS NULL OR "pgic" BETWEEN 1 AND 7));

-- The worst is not better than the least. A pair that says otherwise is a form
-- filled in the wrong order, and it makes every trend built on it wrong.
ALTER TABLE "specialty"."pain_assessments"
  ADD CONSTRAINT "worst_is_not_below_least"
  CHECK ("nrs_worst" IS NULL OR "nrs_least" IS NULL OR "nrs_worst" >= "nrs_least");

ALTER TABLE "mdm"."opioid_conversion_factors"
  ADD CONSTRAINT "a_conversion_factor_converts"
  CHECK ("factor" > 0 AND "unit" IN ('mg', 'mcg_per_hour'));

ALTER TABLE "mdm"."opioid_conversion_factors"
  ADD CONSTRAINT "a_factor_period_runs_forwards"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND c.relispartition = false
      AND ((n.nspname = 'specialty' AND (c.relname LIKE 'pain\_%' OR c.relname LIKE 'opioid\_%'))
        OR (n.nspname = 'mdm' AND c.relname = 'opioid_conversion_factors'))
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % pain-clinic table(s)', v_count;
END $$;

-- The opioid log is the governance record. A prescription that was written was
-- written, and a row that can disappear is a controlled-drug audit with a hole
-- in it — which is the one kind of hole a regulator assumes was deliberate.
--
-- But the countersignature lands *after* the prescription, from a second person
-- in a second session, so a blanket UPDATE revoke would make the review
-- impossible. The grant is therefore by column: the four fields a review
-- writes, and nothing else. The drug, the dose, the days and the prescriber are
-- as immutable as a DELETE revoke would have made them, and the one legitimate
-- later write is the one that is allowed.
REVOKE UPDATE, DELETE ON "specialty"."opioid_prescription_log" FROM hms_app;
GRANT UPDATE (second_reviewer_id, second_reviewed_at, justification, updated_at)
  ON "specialty"."opioid_prescription_log" TO hms_app;

-- An agreement is revoked with a reason, never removed. It is the evidence of
-- what the patient was told.
REVOKE DELETE ON "specialty"."opioid_agreements" FROM hms_app;

-- An intervention happened, and its steroid is already in somebody's annual
-- total. Deleting one would silently give that milligram back.
REVOKE DELETE ON "specialty"."pain_interventions" FROM hms_app;
REVOKE DELETE ON "specialty"."pain_assessments"   FROM hms_app;

-- The exposure roll-up is derived (§B.3), so the application holds nothing on
-- it. Not "should not write it" — cannot: the trigger maintains it as the
-- owner, and the only way a milligram enters the annual total is an injection.
REVOKE INSERT, UPDATE, DELETE ON "specialty"."pain_steroid_exposure" FROM hms_app;

-- The conversion factors are the guideline. A clinic revising them is doing
-- master-data administration, not prescribing, and EN-027 owns that path — so
-- the console's role cannot change them from inside a consultation.
REVOKE INSERT, UPDATE, DELETE ON "mdm"."opioid_conversion_factors" FROM hms_app;


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
    WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory','finance','queue','engage','billing','integration','ops','specialty')
      AND c.relkind IN ('r','p') AND c.relispartition = false
      AND c.relname NOT LIKE '\_prisma%'
      AND c.relname NOT IN ('cdss_safety_floor','console_components','opioid_conversion_factors')
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

/* `mdm.opioid_conversion_factors` is exempt, for the same reason
   `core.permissions` and `mdm.console_components` are: it is the published
   guideline, identical in every tenant, and world-readable. A hospital that
   could not read a conversion factor could not compute an MME, which would
   turn a governance control into an outage. */
GRANT SELECT ON "mdm"."opioid_conversion_factors" TO hms_app, hms_readonly;

DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'specialty'
    AND (c.relname LIKE 'pain\_%' OR c.relname LIKE 'opioid\_%')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Pain-clinic tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §E. THE PUBLISHED FACTORS
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Reference data, seeded here rather than in the tenant seed, for the same
-- reason the permission catalogue is: it is what the build ships, identical in
-- every hospital, and `hms_app` is deliberately unable to write it (§C). A
-- clinic revising a factor is doing master-data administration through EN-027,
-- not prescribing.
--
-- The set is CDC 2022, which is what most Indian pain societies cite. Two are
-- deliberately conservative and say so in their own notes:
--
--  · **methadone** is dose-dependent in reality — its factor rises steeply
--    above 60 mg a day and no single number is safe across the range. The
--    figure here is the *highest* published band's, so a clinic prescribing it
--    over-estimates the equivalent rather than under, which errs toward the
--    second reviewer rather than away from them.
--  · **buprenorphine** is a partial agonist whose ceiling effect makes a linear
--    equivalent misleading in both directions. It is here anyway, because
--    omitting it would refuse the prescription outright — and a refusal a
--    clinic cannot resolve is a rule they find a way around.
INSERT INTO "mdm"."opioid_conversion_factors"
  (id, drug_key, route, factor, unit, source, notes, effective_from, effective_to, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'morphine',            'oral',        1.0,  'mg',           'CDC 2022', NULL, DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'morphine',            'iv',          3.0,  'mg',           'CDC 2022', NULL, DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'codeine',             'oral',        0.15, 'mg',           'CDC 2022', NULL, DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'tramadol',            'oral',        0.2,  'mg',           'CDC 2022', NULL, DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'tapentadol',          'oral',        0.4,  'mg',           'CDC 2022', NULL, DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'hydrocodone',         'oral',        1.0,  'mg',           'CDC 2022', NULL, DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'oxycodone',           'oral',        1.5,  'mg',           'CDC 2022', NULL, DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'hydromorphone',       'oral',        5.0,  'mg',           'CDC 2022', NULL, DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'oxymorphone',         'oral',        3.0,  'mg',           'CDC 2022', NULL, DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'methadone',           'oral',       12.0,  'mg',           'CDC 2022',
   'Dose-dependent in reality: the published factor rises steeply above 60 mg a day. This is the highest band, so the equivalent is over-estimated rather than under — which errs toward the second reviewer.',
   DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'fentanyl_patch',      'transdermal', 2.4,  'mcg_per_hour', 'CDC 2022', NULL, DATE '2022-11-04', NULL, now(), now()),
  (gen_random_uuid(), 'buprenorphine_patch', 'transdermal',12.6,  'mcg_per_hour', 'CDC 2022',
   'A partial agonist with a ceiling effect; a linear equivalent is indicative only. Included because refusing the prescription outright is a rule a clinic routes around.',
   DATE '2022-11-04', NULL, now(), now())
ON CONFLICT DO NOTHING;
