-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-033 · IP-015 · OP-034 — the two ends of life
-- One problem seen twice: a body that is not a standard adult
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **A weight-based dose never passes the adult dose.** Paediatric dosing is
--    milligrams per kilogram, which works until the kilograms reach an adult's.
--    Fifteen milligrams per kilogram of paracetamol on a ninety-kilogram
--    fifteen-year-old is 1350 mg, half again the adult single dose — and the
--    error is invisible because every step of the arithmetic is correct. The
--    ceiling is the adult dose, always, and it is the database's.
--
-- 2. **A child's weight is in grams.** There is no kilogram column on a child
--    or a neonate anywhere here. A newborn's weight entered in kilograms is a
--    dose out by a factor of a thousand, and the way to prevent that is not a
--    range check — a 3 kg baby entered as 3 passes any range check written for
--    kilograms. It is to have nowhere to put the number.
--
-- 3. **Growth centiles are derived.** Weight-for-age against the WHO standard
--    for that sex and that number of days, as a z-score and then as the centile
--    a parent is actually told. A centile somebody reads off a paper chart with
--    a ruler is a centile with a band of error wider than the referral
--    threshold.
--
-- 4. **Neonatal fluids are millilitres per kilogram per day, and the day is
--    derived from the birth.** The figure climbs through the first week — sixty
--    on day one to a hundred and fifty by day seven — so getting the day wrong
--    is either a dehydrated baby or a patent ductus. The total that hangs is
--    computed, and the enteral feeds come off it.
--
-- 5. **Anticholinergic burden is summed by the database.** Three points for a
--    strong drug and one for a weak. Above three it causes falls and confusion,
--    and cumulatively raises dementia risk. Nobody computes it, because it
--    means looking up eleven drugs in a table — so the table is here.
--
-- 6. **Beers criteria are matched, not remembered.** A drug on the list in a
--    person over sixty-five is flagged with the published rationale. It is a
--    prompt rather than a prohibition, which is why continuing one takes a
--    written justification rather than a refusal.
--
-- 7. **Frailty and falls risk are scored from their items**, because a
--    clinician who writes "frail" has decided before counting.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: OP033.
-- ═════════════════════════════════════════════════════════════════════════════


-- CreateTable
CREATE TABLE "mdm"."anticholinergic_scores" (
    "id" UUID NOT NULL,
    "drug_key" VARCHAR(80) NOT NULL,
    "drug_name" VARCHAR(160) NOT NULL,
    "score" INTEGER NOT NULL,
    "source" VARCHAR(40) NOT NULL DEFAULT 'ACB-2012',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "anticholinergic_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mdm"."beers_criteria" (
    "id" UUID NOT NULL,
    "drug_key" VARCHAR(80) NOT NULL,
    "drug_name" VARCHAR(160) NOT NULL,
    "strength" VARCHAR(32) NOT NULL,
    "condition" VARCHAR(160),
    "rationale" TEXT NOT NULL,
    "min_age" INTEGER NOT NULL DEFAULT 65,
    "source" VARCHAR(40) NOT NULL DEFAULT 'AGS-Beers-2023',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "beers_criteria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."paed_growth_records" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "age_days" INTEGER NOT NULL,
    "sex" VARCHAR(8) NOT NULL,
    "weight_g" INTEGER,
    "length_cm" DECIMAL(5,1),
    "hc_cm" DECIMAL(4,1),
    "weight_for_age_z" DECIMAL(4,2),
    "weight_centile" DECIMAL(5,2),
    "nutrition_band" VARCHAR(24),
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "paed_growth_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."paed_doses" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "drug_key" VARCHAR(80) NOT NULL,
    "drug_name" VARCHAR(160) NOT NULL,
    "weight_g" INTEGER NOT NULL,
    "age_days" INTEGER NOT NULL,
    "dose_mg_per_kg" DECIMAL(10,4) NOT NULL,
    "frequency" VARCHAR(24) NOT NULL,
    "route" VARCHAR(16) NOT NULL,
    "adult_max_single_mg" DECIMAL(10,2),
    "adult_max_daily_mg" DECIMAL(10,2),
    "doses_per_day" INTEGER NOT NULL DEFAULT 1,
    "calc_single_mg" DECIMAL(10,3),
    "final_single_mg" DECIMAL(10,3),
    "final_daily_mg" DECIMAL(10,3),
    "cap_applied" DECIMAL(1,0),
    "prescribed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "paed_doses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."nicu_admissions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "admission_id" UUID,
    "newborn_id" UUID,
    "birth_at" TIMESTAMPTZ(6) NOT NULL,
    "ga_weeks_at_birth" INTEGER NOT NULL,
    "ga_days_at_birth" INTEGER NOT NULL DEFAULT 0,
    "birth_weight_g" INTEGER NOT NULL,
    "gestation_band" VARCHAR(24),
    "birth_weight_band" VARCHAR(16),
    "admitted_at" TIMESTAMPTZ(6) NOT NULL,
    "discharged_at" TIMESTAMPTZ(6),
    "outcome" VARCHAR(40),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "nicu_admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."nicu_fluid_orders" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "nicu_admission_id" UUID NOT NULL,
    "for_date" DATE NOT NULL,
    "day_of_life" INTEGER NOT NULL,
    "weight_g" INTEGER NOT NULL,
    "ml_per_kg_per_day" DECIMAL(5,1) NOT NULL,
    "total_ml_per_day" DECIMAL(7,2),
    "ml_per_hour" DECIMAL(6,2),
    "fluid" VARCHAR(80) NOT NULL,
    "additives" JSONB NOT NULL DEFAULT '[]',
    "enteral_ml" DECIMAL(7,2) NOT NULL DEFAULT 0,
    "iv_ml_per_day" DECIMAL(7,2),
    "prescribed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "nicu_fluid_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."geri_assessments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL,
    "assessed_by" UUID NOT NULL,
    "age_years" INTEGER NOT NULL,
    "fried_items" JSONB NOT NULL,
    "fried_score" INTEGER,
    "frailty_band" VARCHAR(16),
    "falls_last_year" INTEGER NOT NULL DEFAULT 0,
    "falls_injury" BOOLEAN NOT NULL DEFAULT false,
    "falls_risk" VARCHAR(16),
    "adl_barthel" INTEGER,
    "cognition" JSONB NOT NULL DEFAULT '{}',
    "mood" JSONB NOT NULL DEFAULT '{}',
    "continence" JSONB NOT NULL DEFAULT '{}',
    "social" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "geri_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."geri_medication_reviews" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "assessment_id" UUID,
    "reviewed_at" TIMESTAMPTZ(6) NOT NULL,
    "reviewed_by" UUID NOT NULL,
    "age_years" INTEGER NOT NULL,
    "medications" JSONB NOT NULL,
    "drug_count" INTEGER,
    "acb_score" INTEGER,
    "acb_drugs" JSONB NOT NULL DEFAULT '[]',
    "beers_flags" JSONB NOT NULL DEFAULT '[]',
    "beers_count" INTEGER,
    "actions" JSONB NOT NULL DEFAULT '[]',
    "justifications" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "geri_medication_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_acb_drug" ON "mdm"."anticholinergic_scores"("drug_key");

-- CreateIndex
CREATE UNIQUE INDEX "uq_beers_drug_condition" ON "mdm"."beers_criteria"("drug_key", "condition");

-- CreateIndex
CREATE INDEX "paed_growth_records_hospital_id_patient_id_measured_at_idx" ON "specialty"."paed_growth_records"("hospital_id", "patient_id", "measured_at" DESC);

-- CreateIndex
CREATE INDEX "paed_doses_hospital_id_patient_id_created_at_idx" ON "specialty"."paed_doses"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "nicu_admissions_hospital_id_branch_id_discharged_at_idx" ON "specialty"."nicu_admissions"("hospital_id", "branch_id", "discharged_at");

-- CreateIndex
CREATE INDEX "nicu_admissions_hospital_id_patient_id_idx" ON "specialty"."nicu_admissions"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "nicu_fluid_orders_hospital_id_for_date_idx" ON "specialty"."nicu_fluid_orders"("hospital_id", "for_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_nicu_fluid_day" ON "specialty"."nicu_fluid_orders"("nicu_admission_id", "for_date");

-- CreateIndex
CREATE INDEX "geri_assessments_hospital_id_patient_id_assessed_at_idx" ON "specialty"."geri_assessments"("hospital_id", "patient_id", "assessed_at" DESC);

-- CreateIndex
CREATE INDEX "geri_medication_reviews_hospital_id_patient_id_reviewed_at_idx" ON "specialty"."geri_medication_reviews"("hospital_id", "patient_id", "reviewed_at" DESC);

-- AddForeignKey
ALTER TABLE "specialty"."nicu_fluid_orders" ADD CONSTRAINT "nicu_fluid_orders_nicu_admission_id_fkey" FOREIGN KEY ("nicu_admission_id") REFERENCES "specialty"."nicu_admissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."geri_medication_reviews" ADD CONSTRAINT "geri_medication_reviews_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "specialty"."geri_assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  A weight-based dose does not pass the adult dose ──────────────────
--
-- The error this prevents is invisible: every step of the arithmetic is
-- correct, the prescriber is competent, and the answer is an overdose because
-- the child weighs what an adult weighs.
CREATE OR REPLACE FUNCTION specialty.derive_paed_dose()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_calc numeric; v_final numeric;
BEGIN
  IF NEW.weight_g <= 0 OR NEW.weight_g > 200000 THEN
    RAISE EXCEPTION 'A child''s weight is recorded in grams, from 1 g to 200 kg. A figure like 3 is three grams, not three kilograms — which is the error this unit exists to make impossible. (OP-033 §B.1)'
      USING ERRCODE = 'OP033';
  END IF;

  v_calc  := round(NEW.dose_mg_per_kg * (NEW.weight_g / 1000.0), 3);
  v_final := v_calc;
  NEW.cap_applied := 0;

  IF NEW.adult_max_single_mg IS NOT NULL AND v_final > NEW.adult_max_single_mg THEN
    v_final := NEW.adult_max_single_mg;
    NEW.cap_applied := 1;
  END IF;

  NEW.calc_single_mg  := v_calc;
  NEW.final_single_mg := v_final;
  NEW.final_daily_mg  := round(v_final * NEW.doses_per_day, 3);

  -- And the daily ceiling, which bites on a drug given six-hourly long before
  -- the single-dose one does.
  IF NEW.adult_max_daily_mg IS NOT NULL AND NEW.final_daily_mg > NEW.adult_max_daily_mg THEN
    RAISE EXCEPTION
      'That is % mg a day, and the adult daily maximum for % is % mg. At % kg this child is dosed as an adult, so the adult ceiling is the ceiling — reduce the frequency or the dose. (OP-033 §B.1)',
      NEW.final_daily_mg, NEW.drug_name, NEW.adult_max_daily_mg,
      round(NEW.weight_g / 1000.0, 1)
      USING ERRCODE = 'OP033';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_paed_dose
  BEFORE INSERT OR UPDATE OF weight_g, dose_mg_per_kg, doses_per_day, adult_max_single_mg,
                             adult_max_daily_mg, calc_single_mg, final_single_mg,
                             final_daily_mg, cap_applied
    ON specialty.paed_doses
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_paed_dose();

ALTER TABLE "specialty"."paed_doses"
  ADD CONSTRAINT "a_frequency_is_plausible" CHECK ("doses_per_day" BETWEEN 1 AND 24);

ALTER TABLE "specialty"."paed_doses"
  ADD CONSTRAINT "a_per_kilogram_dose_is_positive" CHECK ("dose_mg_per_kg" > 0);


-- ── §B.2  Growth, in grams and in centiles ──────────────────────────────────
--
-- The WHO weight-for-age standard, as an LMS approximation good enough to place
-- a child in a band and refer them. A centile read off a paper chart with a
-- ruler has a band of error wider than the referral threshold.
CREATE OR REPLACE FUNCTION specialty.who_weight_median_kg(p_age_days int, p_sex text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  -- A piecewise fit to the WHO 2006 median. Close enough to band a child and
  -- to trend them; a full LMS table belongs in reference data and is the
  -- documented next step.
  SELECT CASE
    WHEN p_age_days <= 0 THEN CASE WHEN p_sex = 'male' THEN 3.3 ELSE 3.2 END
    WHEN p_age_days <= 365 THEN
      (CASE WHEN p_sex = 'male' THEN 3.3 ELSE 3.2 END)
        + (CASE WHEN p_sex = 'male' THEN 6.3 ELSE 6.0 END) * (p_age_days / 365.0)
    WHEN p_age_days <= 1825 THEN
      (CASE WHEN p_sex = 'male' THEN 9.6 ELSE 9.2 END)
        + (CASE WHEN p_sex = 'male' THEN 8.7 ELSE 8.6 END) * ((p_age_days - 365) / 1460.0)
    ELSE
      (CASE WHEN p_sex = 'male' THEN 18.3 ELSE 17.8 END)
        + 2.6 * ((p_age_days - 1825) / 365.0)
  END::numeric
$$;

CREATE OR REPLACE FUNCTION specialty.derive_growth()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_median numeric;
  v_sd     numeric;
  v_kg     numeric;
  v_z      numeric;
BEGIN
  IF NEW.weight_g IS NULL THEN
    NEW.weight_for_age_z := NULL;
    NEW.weight_centile   := NULL;
    NEW.nutrition_band   := NULL;
    RETURN NEW;
  END IF;

  IF NEW.weight_g <= 0 OR NEW.weight_g > 200000 THEN
    RAISE EXCEPTION 'A child''s weight is in grams. (OP-033 §B.2)' USING ERRCODE = 'OP033';
  END IF;

  v_kg     := NEW.weight_g / 1000.0;
  v_median := specialty.who_weight_median_kg(NEW.age_days, NEW.sex);
  -- The WHO distribution is right-skewed; a twelve per cent coefficient of
  -- variation is a workable approximation across the age range.
  v_sd     := v_median * 0.12;

  v_z := round((v_kg - v_median) / v_sd, 2);
  NEW.weight_for_age_z := v_z;

  -- The normal cumulative distribution, by the Zelen and Severo approximation.
  -- Good to about four decimal places, which is four more than a centile needs.
  NEW.weight_centile := round((
    CASE WHEN v_z >= 0 THEN 1 ELSE 0 END
    + (CASE WHEN v_z >= 0 THEN -1 ELSE 1 END)
      * 0.5 * power(
          1 + 0.0498673470 * abs(v_z) + 0.0211410061 * power(abs(v_z), 2)
            + 0.0032776263 * power(abs(v_z), 3) + 0.0000380036 * power(abs(v_z), 4)
            + 0.0000488906 * power(abs(v_z), 5) + 0.0000053830 * power(abs(v_z), 6),
          -16)
  )::numeric * 100, 2);

  NEW.nutrition_band := CASE
    WHEN v_z < -3 THEN 'severe_underweight'
    WHEN v_z < -2 THEN 'underweight'
    WHEN v_z <= 2 THEN 'normal'
    ELSE 'overweight'
  END;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_growth
  BEFORE INSERT OR UPDATE OF weight_g, age_days, sex, weight_for_age_z, weight_centile,
                             nutrition_band
    ON specialty.paed_growth_records
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_growth();

ALTER TABLE "specialty"."paed_growth_records"
  ADD CONSTRAINT "a_growth_record_names_a_sex" CHECK ("sex" IN ('male', 'female'));

ALTER TABLE "specialty"."paed_growth_records"
  ADD CONSTRAINT "an_age_in_days_is_childhood" CHECK ("age_days" BETWEEN 0 AND 7300);


-- ── §B.3  The neonatal unit ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION specialty.derive_nicu_bands()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.gestation_band := CASE
    WHEN NEW.ga_weeks_at_birth < 28 THEN 'extremely_preterm'
    WHEN NEW.ga_weeks_at_birth < 32 THEN 'very_preterm'
    WHEN NEW.ga_weeks_at_birth < 34 THEN 'moderate_preterm'
    WHEN NEW.ga_weeks_at_birth < 37 THEN 'late_preterm'
    WHEN NEW.ga_weeks_at_birth < 42 THEN 'term'
    ELSE 'post_term'
  END;

  NEW.birth_weight_band := CASE
    WHEN NEW.birth_weight_g < 1000 THEN 'elbw'
    WHEN NEW.birth_weight_g < 1500 THEN 'vlbw'
    WHEN NEW.birth_weight_g < 2500 THEN 'lbw'
    WHEN NEW.birth_weight_g <= 4000 THEN 'normal'
    ELSE 'macrosomic'
  END;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_nicu_bands
  BEFORE INSERT OR UPDATE OF ga_weeks_at_birth, birth_weight_g, gestation_band, birth_weight_band
    ON specialty.nicu_admissions
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_nicu_bands();

ALTER TABLE "specialty"."nicu_admissions"
  ADD CONSTRAINT "a_neonatal_gestation_is_plausible"
  CHECK ("ga_weeks_at_birth" BETWEEN 20 AND 45 AND "ga_days_at_birth" BETWEEN 0 AND 6);

ALTER TABLE "specialty"."nicu_admissions"
  ADD CONSTRAINT "a_birth_weight_is_in_grams"
  CHECK ("birth_weight_g" BETWEEN 200 AND 8000);

-- The day of life, and the volume that follows from it.
CREATE OR REPLACE FUNCTION specialty.derive_nicu_fluids()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_birth timestamptz;
BEGIN
  SELECT a.birth_at INTO v_birth
    FROM specialty.nicu_admissions a WHERE a.id = NEW.nicu_admission_id;

  -- Day one is the day of birth. Every published fluid table counts that way,
  -- and counting from zero is a whole day of volume out.
  NEW.day_of_life := (NEW.for_date - v_birth::date) + 1;

  IF NEW.day_of_life < 1 THEN
    RAISE EXCEPTION 'That date is before the baby was born. (OP-033 §B.3)' USING ERRCODE = 'OP033';
  END IF;

  IF NEW.weight_g <= 0 OR NEW.weight_g > 10000 THEN
    RAISE EXCEPTION 'A neonate''s weight is in grams, from 200 to about 8000. A figure like 3 is three grams. (OP-033 §B.3)'
      USING ERRCODE = 'OP033';
  END IF;

  NEW.total_ml_per_day := round(NEW.ml_per_kg_per_day * (NEW.weight_g / 1000.0), 2);
  NEW.iv_ml_per_day    := greatest(round(NEW.total_ml_per_day - NEW.enteral_ml, 2), 0);
  NEW.ml_per_hour      := round(NEW.iv_ml_per_day / 24.0, 2);

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_nicu_fluids
  BEFORE INSERT OR UPDATE OF for_date, weight_g, ml_per_kg_per_day, enteral_ml,
                             day_of_life, total_ml_per_day, iv_ml_per_day, ml_per_hour
    ON specialty.nicu_fluid_orders
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_nicu_fluids();

ALTER TABLE "specialty"."nicu_fluid_orders"
  ADD CONSTRAINT "a_neonatal_fluid_rate_is_plausible"
  CHECK ("ml_per_kg_per_day" BETWEEN 20 AND 220);


-- ── §B.4  The burden, added up ──────────────────────────────────────────────
--
-- Three points for a strong anticholinergic and one for a weak. Above three it
-- causes falls and confusion, and cumulatively raises dementia risk. Nobody
-- computes it, because it means looking up eleven drugs in a table.
CREATE OR REPLACE FUNCTION specialty.acb_threshold() RETURNS int
  LANGUAGE sql IMMUTABLE AS $$ SELECT 3 $$;

CREATE OR REPLACE FUNCTION specialty.derive_medication_review()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_acb    int := 0;
  v_drugs  jsonb := '[]'::jsonb;
  v_beers  jsonb := '[]'::jsonb;
  v_count  int;
  r        record;
BEGIN
  IF jsonb_typeof(NEW.medications) <> 'array' THEN
    RAISE EXCEPTION 'A medication review is a list of what the person is taking. (OP-033 §B.4)'
      USING ERRCODE = 'OP033';
  END IF;

  SELECT jsonb_array_length(NEW.medications) INTO v_count;
  NEW.drug_count := v_count;

  FOR r IN
    SELECT m ->> 'drugKey' AS key, m ->> 'drugName' AS name
      FROM jsonb_array_elements(NEW.medications) AS m
     WHERE m ? 'drugKey'
  LOOP
    -- Anticholinergic burden.
    DECLARE v_score int;
    BEGIN
      SELECT s.score INTO v_score FROM mdm.anticholinergic_scores s WHERE s.drug_key = r.key;
      IF v_score IS NOT NULL THEN
        v_acb := v_acb + v_score;
        v_drugs := v_drugs || jsonb_build_object('drugKey', r.key, 'drugName', r.name, 'score', v_score);
      END IF;
    END;

    -- Beers, against this person's age.
    DECLARE b record;
    BEGIN
      FOR b IN
        SELECT c.strength, c.condition, c.rationale
          FROM mdm.beers_criteria c
         WHERE c.drug_key = r.key AND NEW.age_years >= c.min_age
      LOOP
        v_beers := v_beers || jsonb_build_object(
          'drugKey', r.key, 'drugName', r.name,
          'strength', b.strength, 'condition', b.condition, 'rationale', b.rationale);
      END LOOP;
    END;
  END LOOP;

  NEW.acb_score   := v_acb;
  NEW.acb_drugs   := v_drugs;
  NEW.beers_flags := v_beers;
  NEW.beers_count := jsonb_array_length(v_beers);

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_medication_review
  BEFORE INSERT OR UPDATE OF medications, age_years, drug_count, acb_score, acb_drugs,
                             beers_flags, beers_count
    ON specialty.geri_medication_reviews
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_medication_review();


-- ── §B.5  Frailty and falls, scored from their items ────────────────────────
--
-- A clinician who writes "frail" has decided before counting, and frailty is
-- what changes whether an operation is a good idea.
CREATE OR REPLACE FUNCTION specialty.derive_geri_scores()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_score int := 0;
BEGIN
  IF jsonb_typeof(NEW.fried_items) = 'object' THEN
    v_score :=
        CASE WHEN (NEW.fried_items ->> 'weightLoss')::boolean  THEN 1 ELSE 0 END
      + CASE WHEN (NEW.fried_items ->> 'exhaustion')::boolean  THEN 1 ELSE 0 END
      + CASE WHEN (NEW.fried_items ->> 'lowActivity')::boolean THEN 1 ELSE 0 END
      + CASE WHEN (NEW.fried_items ->> 'slowGait')::boolean    THEN 1 ELSE 0 END
      + CASE WHEN (NEW.fried_items ->> 'weakGrip')::boolean    THEN 1 ELSE 0 END;
  END IF;

  NEW.fried_score := v_score;
  NEW.frailty_band := CASE
    WHEN v_score >= 3 THEN 'frail'
    WHEN v_score >= 1 THEN 'pre_frail'
    ELSE 'robust'
  END;

  -- Two falls, or one with an injury, is high risk — and a previous fall is the
  -- single best predictor of the next one.
  NEW.falls_risk := CASE
    WHEN NEW.falls_last_year >= 2 OR NEW.falls_injury THEN 'high'
    WHEN NEW.falls_last_year = 1 THEN 'moderate'
    ELSE 'low'
  END;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_geri_scores
  BEFORE INSERT OR UPDATE OF fried_items, falls_last_year, falls_injury, fried_score,
                             frailty_band, falls_risk
    ON specialty.geri_assessments
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_geri_scores();

ALTER TABLE "specialty"."geri_assessments"
  ADD CONSTRAINT "a_barthel_index_is_out_of_a_hundred"
  CHECK ("adl_barthel" IS NULL OR ("adl_barthel" BETWEEN 0 AND 100 AND "adl_barthel" % 5 = 0));

ALTER TABLE "specialty"."geri_assessments"
  ADD CONSTRAINT "falls_are_counted_not_estimated" CHECK ("falls_last_year" BETWEEN 0 AND 365);


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
      AND ((n.nspname = 'specialty'
            AND c.relname IN ('paed_growth_records','paed_doses','nicu_admissions',
                              'nicu_fluid_orders','geri_assessments','geri_medication_reviews'))
        OR (n.nspname = 'mdm' AND c.relname IN ('anticholinergic_scores','beers_criteria')))
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % lifespan table(s)', v_count;
END $$;

-- The two reference tables are published criteria, identical in every tenant
-- and read-only to the application. A hospital that could edit the Beers list
-- could edit away the flag it did not want.
REVOKE INSERT, UPDATE, DELETE ON "mdm"."anticholinergic_scores" FROM hms_app;
REVOKE INSERT, UPDATE, DELETE ON "mdm"."beers_criteria"         FROM hms_app;
GRANT SELECT ON "mdm"."anticholinergic_scores" TO hms_app, hms_readonly;
GRANT SELECT ON "mdm"."beers_criteria"         TO hms_app, hms_readonly;

-- A dose that was given and a measurement that was taken are clinical record.
REVOKE DELETE ON "specialty"."paed_doses"           FROM hms_app;
REVOKE DELETE ON "specialty"."paed_growth_records"  FROM hms_app;
REVOKE DELETE ON "specialty"."nicu_fluid_orders"    FROM hms_app;


-- ═════════════════════════════════════════════════════════════════════════════
-- §E. REFERENCE DATA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Both lists live here rather than in the tenant seed, for the reason the
-- opioid conversion factors and the immunisation schedules do: they are
-- published criteria, identical in every hospital, and the seed runs as a role
-- that has been deliberately denied write access to them.

INSERT INTO mdm.anticholinergic_scores (id, drug_key, drug_name, score, source, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'amitriptyline',   'Amitriptyline',   3, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'chlorpheniramine','Chlorphenamine',  3, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'oxybutynin',      'Oxybutynin',      3, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'olanzapine',      'Olanzapine',      3, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'promethazine',    'Promethazine',    3, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'hydroxyzine',     'Hydroxyzine',     3, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'paroxetine',      'Paroxetine',      3, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'nortriptyline',   'Nortriptyline',   1, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'ranitidine',      'Ranitidine',      1, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'furosemide',      'Furosemide',      1, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'prednisolone',    'Prednisolone',    1, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'warfarin',        'Warfarin',        1, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'digoxin',         'Digoxin',         1, 'ACB-2012', now(), now()),
  (gen_random_uuid(), 'metoprolol',      'Metoprolol',      1, 'ACB-2012', now(), now())
ON CONFLICT (drug_key) DO NOTHING;

INSERT INTO mdm.beers_criteria
  (id, drug_key, drug_name, strength, condition, rationale, min_age, source, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'amitriptyline', 'Amitriptyline', 'avoid', NULL,
   'Strongly anticholinergic, sedating, and causes orthostatic hypotension. Falls and confusion.',
   65, 'AGS-Beers-2023', now(), now()),
  (gen_random_uuid(), 'diazepam', 'Diazepam', 'avoid', NULL,
   'Long-acting benzodiazepine: older people metabolise it slowly, and the risk of falls, fractures and delirium is increased.',
   65, 'AGS-Beers-2023', now(), now()),
  (gen_random_uuid(), 'glibenclamide', 'Glibenclamide', 'avoid', NULL,
   'Long-acting sulfonylurea with a high risk of prolonged hypoglycaemia in older people.',
   65, 'AGS-Beers-2023', now(), now()),
  (gen_random_uuid(), 'nsaid_nonselective', 'Non-selective NSAID', 'avoid_with_condition', 'ckd',
   'Increases the risk of gastrointestinal bleeding and of acute kidney injury on an already reduced clearance.',
   65, 'AGS-Beers-2023', now(), now()),
  (gen_random_uuid(), 'oxybutynin', 'Oxybutynin', 'avoid', NULL,
   'Strongly anticholinergic; there are better-tolerated alternatives for urinary urgency.',
   65, 'AGS-Beers-2023', now(), now()),
  (gen_random_uuid(), 'promethazine', 'Promethazine', 'avoid', NULL,
   'First-generation antihistamine: strongly anticholinergic and sedating.',
   65, 'AGS-Beers-2023', now(), now()),
  (gen_random_uuid(), 'digoxin', 'Digoxin', 'use_with_caution', 'heart_failure',
   'Avoid as first-line, and doses above 0.125 mg daily carry a higher risk of toxicity with reduced renal clearance.',
   65, 'AGS-Beers-2023', now(), now())
ON CONFLICT (drug_key, condition) DO NOTHING;


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
      AND c.relname NOT IN ('cdss_safety_floor','console_components','opioid_conversion_factors',
                            'immunisation_schedules','anticholinergic_scores','beers_criteria')
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
  WHERE n.nspname = 'specialty'
    AND c.relname IN ('paed_growth_records','paed_doses','nicu_admissions',
                      'nicu_fluid_orders','geri_assessments','geri_medication_reviews')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Lifespan tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;




/* `mdm.anticholinergic_scores` and `mdm.beers_criteria` are exempt for the same
   reason the opioid conversion factors are: published criteria, identical in
   every tenant, read-only to the application, and useless to a hospital that
   could not read them. */
