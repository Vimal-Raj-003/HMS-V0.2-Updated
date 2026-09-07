-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-031 · IP-023 — oncology and chemotherapy
-- Where the errors are a decimal point, a route, and a number nobody added up
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every module in this build has rules whose violation harms somebody. This one
-- has rules whose violation kills them the same week, and the errors are not
-- exotic.
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **Body surface area is derived, and so is every dose computed from it.**
--    Mosteller: the square root of height times weight over 3600. A prescriber
--    types two measurements; the machine does the rest. The alternative — a
--    person doing that multiplication on a ward round and writing the answer in
--    a box — is the most documented fatal error in oncology, and it has killed
--    children in every health system that has looked for it.
--
-- 2. **Creatinine clearance is derived too**, by Cockcroft-Gault, and capped at
--    125 for Calvert, because carboplatin dosed on an implausibly good kidney
--    is carboplatin overdosed.
--
-- 3. **A vinca alkaloid is never given intrathecally.** This is the
--    never-event. Vincristine into the spinal fluid is an ascending paralysis
--    and then death over about a week, and there is no treatment. It has
--    happened dozens of times worldwide, always in a system that had a field
--    where the route could be typed. Here it is refused, absolutely, with no
--    override key and no permission that reaches it — and the refusal explains
--    itself, because the person who hits it will be sure it is a bug.
--
-- 4. **An absolute cap is absolute.** Vincristine's two milligrams exists
--    precisely because the per-square-metre arithmetic is what kills: a tall
--    adult computes to 3.5 mg, and 3.5 mg of vincristine is a neuropathy
--    somebody does not recover from.
--
-- 5. **The cumulative dose is the database's, across years.** Doxorubicin
--    causes an irreversible cardiomyopathy past roughly 450 mg per square
--    metre, accumulated across cycles, regimens, relapses and years. Nobody
--    adds that up by hand, and the harm arrives as heart failure a decade after
--    the cancer was cured. Eighty per cent warns; the cap refuses.
--
-- 6. **A drug is given on its own day of the protocol.** Day 8 given on day 1
--    is a double dose with a chart that looks ordinary.
--
-- 7. **Counts before the cycle.** Neutrophils and platelets below the
--    regimen's own thresholds stop the cycle being signed — unless a second
--    oncologist signs it with a reason, which is a real decision and sometimes
--    the right one.
--
-- 8. **The pharmacist's recalculation is a gate.** No drug is administered
--    against a line the pharmacy has not independently approved. Two people
--    doing the same arithmetic separately is the control that catches the
--    decimal point, and it only works if the second one can stop the first.
--
-- 9. **Two nurses at the chair, and they are two people.** The same shape as
--    the opioid countersignature and the blood bedside check.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: OP031.
-- ═════════════════════════════════════════════════════════════════════════════


-- CreateEnum
CREATE TYPE "mdm"."ChemoDoseBasis" AS ENUM ('mg_m2', 'mg_kg', 'auc', 'flat', 'mg_m2_capped');

-- CreateEnum
CREATE TYPE "specialty"."OncoIntent" AS ENUM ('curative', 'adjuvant', 'neoadjuvant', 'palliative');

-- CreateEnum
CREATE TYPE "specialty"."CycleStatus" AS ENUM ('planned', 'fitness_pending', 'ready', 'pharm_pending', 'pharm_approved', 'in_progress', 'administered', 'deferred', 'cancelled');

-- CreateEnum
CREATE TYPE "specialty"."PharmStatus" AS ENUM ('pending', 'approved', 'queried', 'rejected');

-- CreateTable
CREATE TABLE "mdm"."chemo_regimens" (
    "id" UUID NOT NULL,
    "hospital_id" UUID,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "indication_sites" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "cycle_length_days" INTEGER NOT NULL,
    "planned_cycles" INTEGER NOT NULL,
    "emetogenicity" VARCHAR(16) NOT NULL DEFAULT 'moderate',
    "lab_thresholds" JSONB NOT NULL DEFAULT '{}',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chemo_regimens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mdm"."chemo_regimen_drugs" (
    "id" UUID NOT NULL,
    "hospital_id" UUID,
    "regimen_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "drug_id" UUID,
    "drug_name" VARCHAR(120) NOT NULL,
    "drug_class" VARCHAR(24) NOT NULL,
    "dose_basis" "mdm"."ChemoDoseBasis" NOT NULL,
    "dose_value" DECIMAL(10,3) NOT NULL,
    "unit" VARCHAR(12) NOT NULL,
    "bsa_cap" DECIMAL(4,2),
    "absolute_cap" DECIMAL(10,3),
    "route" VARCHAR(16) NOT NULL,
    "infusion_min" INTEGER,
    "diluent" VARCHAR(60),
    "volume_ml" INTEGER,
    "stability_h" INTEGER,
    "vesicant" BOOLEAN NOT NULL DEFAULT false,
    "days" INTEGER[],
    "cumulative_cap" DECIMAL(10,2),
    "cap_unit" VARCHAR(16),
    "is_premed" BOOLEAN NOT NULL DEFAULT false,
    "is_supportive" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chemo_regimen_drugs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."onco_cases" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "case_no" VARCHAR(32) NOT NULL,
    "primary_site_icdo3" VARCHAR(16) NOT NULL,
    "morphology_icdo3" VARCHAR(16),
    "laterality" "clinical"."Laterality" NOT NULL DEFAULT 'not_applicable',
    "grade" VARCHAR(16),
    "dx_date" DATE NOT NULL,
    "dx_basis" VARCHAR(24) NOT NULL,
    "biomarkers" JSONB NOT NULL DEFAULT '{}',
    "tnm" JSONB NOT NULL DEFAULT '{}',
    "ecog" INTEGER,
    "kps" INTEGER,
    "intent" "specialty"."OncoIntent" NOT NULL,
    "oncologist_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "registry" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "onco_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."onco_treatment_plans" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "regimen_id" UUID NOT NULL,
    "regimen_version" INTEGER NOT NULL,
    "intent" "specialty"."OncoIntent" NOT NULL,
    "start_date" DATE NOT NULL,
    "planned_cycles" INTEGER NOT NULL,
    "height_cm" DECIMAL(5,1) NOT NULL,
    "weight_kg" DECIMAL(5,2) NOT NULL,
    "age_years" INTEGER NOT NULL,
    "female" BOOLEAN NOT NULL,
    "creatinine_mg_dl" DECIMAL(5,2),
    "bsa_method" VARCHAR(16) NOT NULL DEFAULT 'mosteller',
    "bsa" DECIMAL(4,2),
    "crcl" DECIMAL(6,2),
    "consent_id" UUID,
    "estimate_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "stop_reason" TEXT,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "onco_treatment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."chemo_cycles" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "cycle_no" INTEGER NOT NULL,
    "day_no" INTEGER NOT NULL DEFAULT 1,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "specialty"."CycleStatus" NOT NULL DEFAULT 'planned',
    "fitness" JSONB NOT NULL DEFAULT '{}',
    "fitness_failures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deferred_reason" TEXT,
    "preauth_id" UUID,
    "bill_id" UUID,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "second_signer_id" UUID,
    "second_signed_at" TIMESTAMPTZ(6),
    "override_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chemo_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."chemo_order_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "regimen_drug_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "drug_name" VARCHAR(120) NOT NULL,
    "drug_class" VARCHAR(24) NOT NULL,
    "dose_basis" "mdm"."ChemoDoseBasis" NOT NULL,
    "basis_value" DECIMAL(10,3) NOT NULL,
    "calc_dose" DECIMAL(10,3),
    "reduction_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "reduction_reason" VARCHAR(200),
    "final_dose" DECIMAL(10,3),
    "unit" VARCHAR(12) NOT NULL,
    "cap_applied" BOOLEAN NOT NULL DEFAULT false,
    "route" VARCHAR(16) NOT NULL,
    "infusion_min" INTEGER,
    "diluent" VARCHAR(60),
    "volume_ml" INTEGER,
    "vesicant" BOOLEAN NOT NULL DEFAULT false,
    "cumulative_before" DECIMAL(12,2),
    "cumulative_after" DECIMAL(12,2),
    "pharm_status" "specialty"."PharmStatus" NOT NULL DEFAULT 'pending',
    "pharm_by" UUID,
    "pharm_at" TIMESTAMPTZ(6),
    "pharm_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chemo_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."chemo_administrations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "order_line_id" UUID NOT NULL,
    "chair_id" UUID,
    "verify_nurse1_id" UUID NOT NULL,
    "verify_nurse2_id" UUID NOT NULL,
    "barcode_verified" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "rate" VARCHAR(40),
    "access" VARCHAR(16) NOT NULL DEFAULT 'peripheral',
    "reactions" JSONB NOT NULL DEFAULT '[]',
    "extravasation" JSONB,
    "vitals" JSONB NOT NULL DEFAULT '[]',
    "interruptions" JSONB NOT NULL DEFAULT '[]',
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "chemo_administrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."onco_cumulative_doses" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "drug_name" VARCHAR(120) NOT NULL,
    "drug_class" VARCHAR(24) NOT NULL,
    "total_dose" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "unit" VARCHAR(12) NOT NULL,
    "total_per_m2" DECIMAL(12,2),
    "cap" DECIMAL(12,2),
    "last_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "onco_cumulative_doses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."toxicity_assessments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "cycle_id" UUID,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'clinician',
    "items" JSONB NOT NULL,
    "max_grade" INTEGER,
    "action" VARCHAR(24),
    "assessed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "toxicity_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chemo_regimens_hospital_id_status_idx" ON "mdm"."chemo_regimens"("hospital_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_chemo_regimen_version" ON "mdm"."chemo_regimens"("hospital_id", "code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "uq_regimen_drug_seq" ON "mdm"."chemo_regimen_drugs"("regimen_id", "seq");

-- CreateIndex
CREATE INDEX "onco_cases_hospital_id_patient_id_idx" ON "specialty"."onco_cases"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "onco_cases_hospital_id_status_idx" ON "specialty"."onco_cases"("hospital_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_onco_case_no" ON "specialty"."onco_cases"("hospital_id", "case_no");

-- CreateIndex
CREATE INDEX "onco_treatment_plans_hospital_id_case_id_start_date_idx" ON "specialty"."onco_treatment_plans"("hospital_id", "case_id", "start_date" DESC);

-- CreateIndex
CREATE INDEX "chemo_cycles_hospital_id_scheduled_at_status_idx" ON "specialty"."chemo_cycles"("hospital_id", "scheduled_at", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_chemo_cycle_day" ON "specialty"."chemo_cycles"("plan_id", "cycle_no", "day_no");

-- CreateIndex
CREATE INDEX "chemo_order_lines_hospital_id_cycle_id_idx" ON "specialty"."chemo_order_lines"("hospital_id", "cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_chemo_order_seq" ON "specialty"."chemo_order_lines"("cycle_id", "seq");

-- CreateIndex
CREATE INDEX "chemo_administrations_hospital_id_cycle_id_idx" ON "specialty"."chemo_administrations"("hospital_id", "cycle_id");

-- CreateIndex
CREATE INDEX "onco_cumulative_doses_hospital_id_case_id_idx" ON "specialty"."onco_cumulative_doses"("hospital_id", "case_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cumulative_drug" ON "specialty"."onco_cumulative_doses"("case_id", "drug_name");

-- CreateIndex
CREATE INDEX "toxicity_assessments_hospital_id_case_id_assessed_at_idx" ON "specialty"."toxicity_assessments"("hospital_id", "case_id", "assessed_at" DESC);

-- AddForeignKey
ALTER TABLE "mdm"."chemo_regimen_drugs" ADD CONSTRAINT "chemo_regimen_drugs_regimen_id_fkey" FOREIGN KEY ("regimen_id") REFERENCES "mdm"."chemo_regimens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."onco_treatment_plans" ADD CONSTRAINT "onco_treatment_plans_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "specialty"."onco_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."onco_treatment_plans" ADD CONSTRAINT "onco_treatment_plans_regimen_id_fkey" FOREIGN KEY ("regimen_id") REFERENCES "mdm"."chemo_regimens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."chemo_cycles" ADD CONSTRAINT "chemo_cycles_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "specialty"."onco_treatment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."chemo_order_lines" ADD CONSTRAINT "chemo_order_lines_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "specialty"."chemo_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."chemo_administrations" ADD CONSTRAINT "chemo_administrations_order_line_id_fkey" FOREIGN KEY ("order_line_id") REFERENCES "specialty"."chemo_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."onco_cumulative_doses" ADD CONSTRAINT "onco_cumulative_doses_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "specialty"."onco_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."toxicity_assessments" ADD CONSTRAINT "toxicity_assessments_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "specialty"."onco_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  Body surface area and clearance, derived ──────────────────────────
--
-- Mosteller: √(height × weight / 3600). Two measurements in, one number out,
-- and every dose in the module is a multiplication on it. A person doing this
-- on a ward round is the most documented fatal error in oncology.
CREATE OR REPLACE FUNCTION specialty.bsa_mosteller(p_height_cm numeric, p_weight_kg numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT round(sqrt(p_height_cm * p_weight_kg / 3600.0), 2)
$$;

-- Du Bois, for the units that prefer it: 0.007184 × h^0.725 × w^0.425.
CREATE OR REPLACE FUNCTION specialty.bsa_dubois(p_height_cm numeric, p_weight_kg numeric)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT round((0.007184 * power(p_height_cm, 0.725) * power(p_weight_kg, 0.425))::numeric, 2)
$$;

-- Cockcroft-Gault. The 0.85 for female physiology is a pharmacokinetic
-- constant — muscle mass against creatinine — not a demographic adjustment.
CREATE OR REPLACE FUNCTION specialty.crcl_cockcroft_gault(
  p_age int, p_weight_kg numeric, p_creatinine numeric, p_female boolean)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_creatinine IS NULL OR p_creatinine <= 0 THEN NULL
    ELSE round(((140 - p_age) * p_weight_kg / (72.0 * p_creatinine))
               * CASE WHEN p_female THEN 0.85 ELSE 1 END, 2)
  END
$$;

-- Calvert caps the clearance it will believe. A kidney reported at 180 is a
-- creatinine assay artefact, and carboplatin dosed on it is an overdose.
CREATE OR REPLACE FUNCTION specialty.calvert_gfr_cap() RETURNS numeric
  LANGUAGE sql IMMUTABLE AS $$ SELECT 125::numeric $$;

CREATE OR REPLACE FUNCTION specialty.derive_plan_numbers()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.height_cm <= 0 OR NEW.weight_kg <= 0 THEN
    RAISE EXCEPTION 'A height and a weight are what every dose in this plan is computed from. (OP-031 §B.1)'
      USING ERRCODE = 'OP031';
  END IF;

  NEW.bsa := CASE WHEN NEW.bsa_method = 'dubois'
                  THEN specialty.bsa_dubois(NEW.height_cm, NEW.weight_kg)
                  ELSE specialty.bsa_mosteller(NEW.height_cm, NEW.weight_kg) END;

  NEW.crcl := specialty.crcl_cockcroft_gault(
                NEW.age_years, NEW.weight_kg, NEW.creatinine_mg_dl, NEW.female);

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_plan_numbers
  BEFORE INSERT OR UPDATE OF height_cm, weight_kg, age_years, female, creatinine_mg_dl,
                             bsa_method, bsa, crcl
    ON specialty.onco_treatment_plans
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_plan_numbers();

ALTER TABLE "specialty"."onco_treatment_plans"
  ADD CONSTRAINT "a_person_has_a_plausible_size"
  CHECK ("height_cm" BETWEEN 30 AND 250 AND "weight_kg" BETWEEN 1 AND 400
     AND "age_years" BETWEEN 0 AND 130);

ALTER TABLE "specialty"."onco_cases"
  ADD CONSTRAINT "performance_status_is_scored_in_range"
  CHECK (("ecog" IS NULL OR "ecog" BETWEEN 0 AND 5)
     AND ("kps" IS NULL OR ("kps" BETWEEN 0 AND 100 AND "kps" % 10 = 0)));


-- ── §B.2  A vinca alkaloid is never intrathecal ─────────────────────────────
--
-- The never-event. Vincristine into the spinal fluid is an ascending paralysis
-- and then death over about a week, and there is no treatment. It has happened
-- dozens of times worldwide — every time in a system that had a field where the
-- route could be typed, and every time to somebody whose colleagues were
-- competent and tired.
--
-- There is no override for this. Not a permission, not a reason field, not a
-- second signature. The refusal explains itself at length, because the person
-- who meets it will be certain it is a bug in the software.
CREATE OR REPLACE FUNCTION specialty.a_vinca_is_never_intrathecal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF lower(NEW.route) IN ('it', 'intrathecal') AND NEW.drug_class = 'vinca' THEN
    RAISE EXCEPTION
      'A vinca alkaloid (%) cannot be given by the intrathecal route, and this is not a setting anybody can change. Intrathecal vincristine causes an ascending paralysis and death over about a week, and there is no treatment for it. If this looks like a mistake in the software, it is not: check the order. (OP-031 §B.2)',
      NEW.drug_name
      USING ERRCODE = 'OP031';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_vinca_is_never_intrathecal
  BEFORE INSERT OR UPDATE OF route, drug_class ON specialty.chemo_order_lines
  FOR EACH ROW EXECUTE FUNCTION specialty.a_vinca_is_never_intrathecal();

-- And the same at the library, so a regimen cannot even be written that way.
CREATE OR REPLACE FUNCTION mdm.a_regimen_never_puts_a_vinca_intrathecally()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF lower(NEW.route) IN ('it', 'intrathecal') AND NEW.drug_class = 'vinca' THEN
    RAISE EXCEPTION
      'No regimen can specify a vinca alkaloid (%) by the intrathecal route. Intrathecal vincristine is uniformly fatal. (OP-031 §B.2)',
      NEW.drug_name
      USING ERRCODE = 'OP031';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_regimen_never_puts_a_vinca_intrathecally
  BEFORE INSERT OR UPDATE OF route, drug_class ON mdm.chemo_regimen_drugs
  FOR EACH ROW EXECUTE FUNCTION mdm.a_regimen_never_puts_a_vinca_intrathecally();


-- ── §B.3  The dose is arithmetic, and the cap is absolute ───────────────────
CREATE OR REPLACE FUNCTION specialty.derive_chemo_dose()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_plan  record;
  v_drug  record;
  v_bsa   numeric;
  v_dose  numeric;
  v_gfr   numeric;
BEGIN
  SELECT p.bsa, p.weight_kg, p.crcl, p.id AS plan_id, p.case_id
    INTO v_plan
    FROM specialty.onco_treatment_plans p
    JOIN specialty.chemo_cycles c ON c.plan_id = p.id
   WHERE c.id = NEW.cycle_id;

  SELECT d.bsa_cap, d.absolute_cap, d.days, d.cumulative_cap, d.cap_unit
    INTO v_drug
    FROM mdm.chemo_regimen_drugs d WHERE d.id = NEW.regimen_drug_id;

  -- ── The protocol day ──────────────────────────────────────────────────────
  -- Day 8 given on day 1 is a double dose with a chart that looks ordinary.
  IF v_drug.days IS NOT NULL AND array_length(v_drug.days, 1) > 0 THEN
    IF NOT ((SELECT c.day_no FROM specialty.chemo_cycles c WHERE c.id = NEW.cycle_id)
            = ANY (v_drug.days)) THEN
      RAISE EXCEPTION '% is given on day % of this regimen, and this cycle is day %. (OP-031 §B.3)',
        NEW.drug_name,
        array_to_string(v_drug.days, ', '),
        (SELECT c.day_no FROM specialty.chemo_cycles c WHERE c.id = NEW.cycle_id)
        USING ERRCODE = 'OP031';
    END IF;
  END IF;

  v_bsa := CASE WHEN NEW.dose_basis = 'mg_m2_capped' AND v_drug.bsa_cap IS NOT NULL
                THEN least(v_plan.bsa, v_drug.bsa_cap)
                ELSE v_plan.bsa END;

  v_dose := CASE NEW.dose_basis
    WHEN 'mg_m2'        THEN NEW.basis_value * v_bsa
    WHEN 'mg_m2_capped' THEN NEW.basis_value * v_bsa
    WHEN 'mg_kg'        THEN NEW.basis_value * v_plan.weight_kg
    -- Calvert. The clearance it will believe is capped, because a kidney
    -- reported at 180 is an assay artefact and carboplatin dosed on it is an
    -- overdose.
    WHEN 'auc'          THEN NEW.basis_value * (least(v_plan.crcl, specialty.calvert_gfr_cap()) + 25)
    ELSE NEW.basis_value
  END;

  IF v_dose IS NULL THEN
    RAISE EXCEPTION 'This dose cannot be computed: the plan is missing the measurement it depends on (surface area, weight or clearance). (OP-031 §B.3)'
      USING ERRCODE = 'OP031';
  END IF;

  -- An absolute ceiling is absolute. Vincristine's two milligrams exists
  -- because the per-square-metre arithmetic is what kills: a tall adult
  -- computes to 3.5 mg, and that is a neuropathy nobody recovers from.
  NEW.cap_applied := false;
  IF v_drug.absolute_cap IS NOT NULL AND v_dose > v_drug.absolute_cap THEN
    v_dose := v_drug.absolute_cap;
    NEW.cap_applied := true;
  END IF;

  NEW.calc_dose  := round(v_dose, 3);
  NEW.final_dose := round(v_dose * (1 - NEW.reduction_pct / 100.0), 3);

  IF NEW.reduction_pct > 0
     AND (NEW.reduction_reason IS NULL OR length(btrim(NEW.reduction_reason)) < 4) THEN
    RAISE EXCEPTION 'A dose reduction carries a reason — toxicity, organ function or performance status. (OP-031 §B.3)'
      USING ERRCODE = 'OP031';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_chemo_dose
  BEFORE INSERT OR UPDATE OF dose_basis, basis_value, reduction_pct, reduction_reason,
                             calc_dose, final_dose, cap_applied, regimen_drug_id
    ON specialty.chemo_order_lines
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_chemo_dose();

ALTER TABLE "specialty"."chemo_order_lines"
  ADD CONSTRAINT "a_reduction_is_a_percentage"
  CHECK ("reduction_pct" >= 0 AND "reduction_pct" <= 100);


-- ── §B.4  The lifetime total, kept by the database ──────────────────────────
--
-- Doxorubicin causes an irreversible cardiomyopathy past roughly 450 mg per
-- square metre, accumulated across cycles, regimens, relapses and years, in a
-- patient who may have been treated in three hospitals. Nobody adds that up by
-- hand, and the harm arrives as heart failure a decade after the cancer was
-- cured — by which time nothing on the chart looks like a mistake.
CREATE OR REPLACE FUNCTION specialty.cumulative_warning_fraction() RETURNS numeric
  LANGUAGE sql IMMUTABLE AS $$ SELECT 0.80::numeric $$;

CREATE OR REPLACE FUNCTION specialty.dose_stays_under_the_lifetime_cap()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_case  uuid;
  v_bsa   numeric;
  v_cap   numeric;
  v_unit  text;
  v_prior numeric;
  v_this  numeric;
  v_after numeric;
BEGIN
  SELECT p.case_id, p.bsa INTO v_case, v_bsa
    FROM specialty.onco_treatment_plans p
    JOIN specialty.chemo_cycles c ON c.plan_id = p.id
   WHERE c.id = NEW.cycle_id;

  SELECT d.cumulative_cap, d.cap_unit INTO v_cap, v_unit
    FROM mdm.chemo_regimen_drugs d WHERE d.id = NEW.regimen_drug_id;

  SELECT coalesce(cd.total_per_m2, 0) INTO v_prior
    FROM specialty.onco_cumulative_doses cd
   WHERE cd.case_id = v_case AND cd.drug_name = NEW.drug_name;
  v_prior := coalesce(v_prior, 0);

  -- Per square metre, because that is the unit every anthracycline ceiling is
  -- published in and the unit a cardiologist will ask for.
  v_this  := CASE WHEN v_bsa IS NULL OR v_bsa = 0 THEN 0
                  ELSE round(coalesce(NEW.final_dose, 0) / v_bsa, 2) END;
  v_after := v_prior + v_this;

  NEW.cumulative_before := v_prior;
  NEW.cumulative_after  := v_after;

  IF v_cap IS NOT NULL AND v_after > v_cap THEN
    RAISE EXCEPTION
      'This dose would take lifetime % to % %, past the ceiling of %. Beyond it the cardiomyopathy is irreversible and it arrives years later, when nothing on the chart looks like a mistake. A cardiology clearance and a change of regimen are the way through, not a larger number. (OP-031 §B.4)',
      NEW.drug_name, v_after, coalesce(v_unit, 'mg/m²'), v_cap
      USING ERRCODE = 'OP031';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_dose_stays_under_the_lifetime_cap
  BEFORE INSERT OR UPDATE OF final_dose, cumulative_before, cumulative_after
    ON specialty.chemo_order_lines
  FOR EACH ROW EXECUTE FUNCTION specialty.dose_stays_under_the_lifetime_cap();

-- The running total moves when the drug actually goes in, not when it is
-- ordered. A cycle deferred at the chair should not count against a lifetime.
-- SECURITY DEFINER on purpose, and it is the same decision as the REVOKE in
-- §C. `hms_app` holds no write on the lifetime totals, because a total it could
-- edit is a ceiling it could walk round; the arithmetic still has to happen, so
-- it happens with the database's own authority rather than the caller's.
CREATE OR REPLACE FUNCTION specialty.administration_adds_to_the_lifetime()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = specialty, mdm, pg_temp AS $$
DECLARE
  v_line record;
  v_case uuid;
  v_bsa  numeric;
  v_cap  numeric;
BEGIN
  IF NOT NEW.completed THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.completed THEN RETURN NULL; END IF;

  SELECT l.drug_name, l.drug_class, l.final_dose, l.unit, l.regimen_drug_id
    INTO v_line
    FROM specialty.chemo_order_lines l WHERE l.id = NEW.order_line_id;

  SELECT p.case_id, p.bsa INTO v_case, v_bsa
    FROM specialty.onco_treatment_plans p
    JOIN specialty.chemo_cycles c ON c.plan_id = p.id
   WHERE c.id = NEW.cycle_id;

  SELECT d.cumulative_cap INTO v_cap
    FROM mdm.chemo_regimen_drugs d WHERE d.id = v_line.regimen_drug_id;

  INSERT INTO specialty.onco_cumulative_doses
    (id, hospital_id, case_id, drug_name, drug_class, total_dose, unit, total_per_m2, cap,
     last_at, created_at, updated_at)
  VALUES (gen_random_uuid(), NEW.hospital_id, v_case, v_line.drug_name, v_line.drug_class,
          coalesce(v_line.final_dose, 0), v_line.unit,
          CASE WHEN v_bsa IS NULL OR v_bsa = 0 THEN NULL
               ELSE round(coalesce(v_line.final_dose, 0) / v_bsa, 2) END,
          v_cap, now(), now(), now())
  ON CONFLICT (case_id, drug_name) DO UPDATE
    SET total_dose   = specialty.onco_cumulative_doses.total_dose + excluded.total_dose,
        total_per_m2 = coalesce(specialty.onco_cumulative_doses.total_per_m2, 0)
                     + coalesce(excluded.total_per_m2, 0),
        cap          = coalesce(excluded.cap, specialty.onco_cumulative_doses.cap),
        last_at      = excluded.last_at,
        updated_at   = now();

  RETURN NULL;
END $$;

CREATE TRIGGER trg_administration_adds_to_the_lifetime
  AFTER INSERT OR UPDATE OF completed ON specialty.chemo_administrations
  FOR EACH ROW EXECUTE FUNCTION specialty.administration_adds_to_the_lifetime();


-- ── §B.5  Counts before the cycle ───────────────────────────────────────────
--
-- Chemotherapy given on a neutrophil count of 0.4 is a febrile neutropenia and
-- sometimes a death. The thresholds live on the regimen, because they differ by
-- regimen, and the failures are computed rather than judged.
-- Deriving the failures and checking the signature are one function, not two.
-- Same-timing triggers on a table fire in alphabetical order by name, so a
-- separate check trigger named `a_cycle_is_signed...` would run *before*
-- `derive_cycle_fitness` and judge the signature against the previous row's
-- failures. They are not two rules that happen to share a table: the second
-- reads what the first computes, and a dependency like that belongs in one
-- place where it cannot be reordered by a rename.
CREATE OR REPLACE FUNCTION specialty.cycle_fitness_and_signature()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_th   jsonb;
  v_fail text[] := ARRAY[]::text[];
BEGIN
  SELECT r.lab_thresholds INTO v_th
    FROM mdm.chemo_regimens r
    JOIN specialty.onco_treatment_plans p ON p.regimen_id = r.id
   WHERE p.id = NEW.plan_id;

  IF jsonb_typeof(NEW.fitness) = 'object' AND jsonb_typeof(v_th) = 'object' THEN
    IF v_th ? 'anc' AND NEW.fitness ? 'ancK'
       AND (NEW.fitness ->> 'ancK')::numeric < (v_th ->> 'anc')::numeric THEN
      v_fail := v_fail || format('neutrophils %s, below %s',
                                 NEW.fitness ->> 'ancK', v_th ->> 'anc');
    END IF;
    IF v_th ? 'platelets' AND NEW.fitness ? 'plateletsK'
       AND (NEW.fitness ->> 'plateletsK')::numeric < (v_th ->> 'platelets')::numeric THEN
      v_fail := v_fail || format('platelets %s, below %s',
                                 NEW.fitness ->> 'plateletsK', v_th ->> 'platelets');
    END IF;
    IF v_th ? 'creatinineMax' AND NEW.fitness ? 'creatinine'
       AND (NEW.fitness ->> 'creatinine')::numeric > (v_th ->> 'creatinineMax')::numeric THEN
      v_fail := v_fail || format('creatinine %s, above %s',
                                 NEW.fitness ->> 'creatinine', v_th ->> 'creatinineMax');
    END IF;
    IF v_th ? 'bilirubinMax' AND NEW.fitness ? 'bilirubin'
       AND (NEW.fitness ->> 'bilirubin')::numeric > (v_th ->> 'bilirubinMax')::numeric THEN
      v_fail := v_fail || format('bilirubin %s, above %s',
                                 NEW.fitness ->> 'bilirubin', v_th ->> 'bilirubinMax');
    END IF;
  END IF;

  NEW.fitness_failures := v_fail;

  -- Signing a cycle whose counts are out of range is a real decision and
  -- sometimes the right one — a patient whose marrow will not recover further,
  -- with a curable disease. It takes a second oncologist and a reason, and the
  -- two signers are two people.
  IF NEW.signed_at IS NOT NULL AND coalesce(array_length(v_fail, 1), 0) > 0 THEN
    IF NEW.second_signer_id IS NULL OR NEW.override_reason IS NULL
       OR length(btrim(NEW.override_reason)) < 8 THEN
      RAISE EXCEPTION 'This cycle cannot be signed: %. Giving it anyway is a decision a second oncologist takes with you, in writing. (OP-031 §B.5)',
        array_to_string(v_fail, '; ')
        USING ERRCODE = 'OP031';
    END IF;
    IF NEW.second_signer_id = NEW.signed_by THEN
      RAISE EXCEPTION 'A second opinion is a second person. (OP-031 §B.5)'
        USING ERRCODE = 'OP031';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_cycle_fitness_and_signature
  BEFORE INSERT OR UPDATE OF fitness, fitness_failures, plan_id, signed_at, signed_by,
                             second_signer_id, override_reason
    ON specialty.chemo_cycles
  FOR EACH ROW EXECUTE FUNCTION specialty.cycle_fitness_and_signature();

ALTER TABLE "specialty"."chemo_cycles"
  ADD CONSTRAINT "a_signed_cycle_names_its_signer"
  CHECK (("signed_at" IS NULL) = ("signed_by" IS NULL));

ALTER TABLE "specialty"."chemo_cycles"
  ADD CONSTRAINT "a_deferred_cycle_says_why"
  CHECK ("status" <> 'deferred'
      OR ("deferred_reason" IS NOT NULL AND length(btrim("deferred_reason")) >= 4));


-- ── §B.6  The pharmacist is a gate, and the chair is two people ─────────────
--
-- Two people doing the same arithmetic separately is the control that catches
-- the decimal point, and it only works if the second one can stop the first.
CREATE OR REPLACE FUNCTION specialty.nothing_runs_unverified()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_line record; v_cycle record;
BEGIN
  SELECT l.pharm_status, l.drug_name, l.final_dose
    INTO v_line
    FROM specialty.chemo_order_lines l WHERE l.id = NEW.order_line_id;

  IF v_line.pharm_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION '% has not been approved by pharmacy (%). The pharmacist recomputes the dose independently, and that is the check that catches a decimal point. (OP-031 §B.6)',
      v_line.drug_name, coalesce(v_line.pharm_status::text, 'not reviewed')
      USING ERRCODE = 'OP031';
  END IF;

  SELECT c.signed_at, c.status INTO v_cycle
    FROM specialty.chemo_cycles c WHERE c.id = NEW.cycle_id;

  IF v_cycle.signed_at IS NULL THEN
    RAISE EXCEPTION 'This cycle has not been signed by the oncologist. (OP-031 §B.6)'
      USING ERRCODE = 'OP031';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_nothing_runs_unverified
  BEFORE INSERT ON specialty.chemo_administrations
  FOR EACH ROW EXECUTE FUNCTION specialty.nothing_runs_unverified();

ALTER TABLE "specialty"."chemo_administrations"
  ADD CONSTRAINT "two_nurses_are_two_people"
  CHECK ("verify_nurse2_id" <> "verify_nurse1_id");

ALTER TABLE "specialty"."chemo_administrations"
  ADD CONSTRAINT "an_infusion_ends_after_it_starts"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

ALTER TABLE "specialty"."chemo_administrations"
  ADD CONSTRAINT "a_completed_infusion_has_an_end"
  CHECK ("completed" = false OR "ended_at" IS NOT NULL);

-- A pharmacist who queries or rejects a line says why. A rejection with no
-- sentence is a queue somebody clears.
ALTER TABLE "specialty"."chemo_order_lines"
  ADD CONSTRAINT "a_pharmacy_query_says_why"
  CHECK ("pharm_status" NOT IN ('queried', 'rejected')
      OR ("pharm_notes" IS NOT NULL AND length(btrim("pharm_notes")) >= 4));

ALTER TABLE "specialty"."chemo_order_lines"
  ADD CONSTRAINT "a_pharmacy_decision_names_its_pharmacist"
  CHECK ("pharm_status" = 'pending' OR ("pharm_by" IS NOT NULL AND "pharm_at" IS NOT NULL));


-- ── §B.7  Toxicity grading ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION specialty.derive_toxicity_grade()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_max int;
BEGIN
  SELECT max((item ->> 'grade')::int) INTO v_max
    FROM jsonb_array_elements(NEW.items) AS item
   WHERE item ? 'grade';

  NEW.max_grade := v_max;
  -- Grade 3 is where the next cycle changes; grade 4 is where this one stops.
  NEW.action := CASE
    WHEN v_max IS NULL THEN NULL
    WHEN v_max >= 5 THEN 'died'
    WHEN v_max = 4 THEN 'hold'
    WHEN v_max = 3 THEN 'dose_reduce'
    ELSE 'none'
  END;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_toxicity_grade
  BEFORE INSERT OR UPDATE OF items, max_grade, action ON specialty.toxicity_assessments
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_toxicity_grade();

ALTER TABLE "specialty"."toxicity_assessments"
  ADD CONSTRAINT "toxicity_items_are_a_list" CHECK (jsonb_typeof("items") = 'array');


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
            AND c.relname IN ('onco_cases','onco_treatment_plans','chemo_cycles',
                              'chemo_order_lines','chemo_administrations',
                              'onco_cumulative_doses','toxicity_assessments'))
        OR (n.nspname = 'mdm' AND c.relname IN ('chemo_regimens','chemo_regimen_drugs')))
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % oncology table(s)', v_count;
END $$;

-- The lifetime total is the database's arithmetic. `hms_app` reads it and
-- nothing else: a total that can be edited is a ceiling that can be walked
-- round, and the walk ends in heart failure ten years later.
REVOKE INSERT, UPDATE, DELETE ON "specialty"."onco_cumulative_doses" FROM hms_app;

-- An administration happened. A cycle and a case are the clinical record.
REVOKE DELETE ON "specialty"."chemo_administrations" FROM hms_app;
REVOKE DELETE ON "specialty"."chemo_cycles"          FROM hms_app;
REVOKE DELETE ON "specialty"."onco_cases"            FROM hms_app;

-- An approved regimen is a controlled document. New versions supersede.
REVOKE DELETE ON "mdm"."chemo_regimens"      FROM hms_app;
REVOKE DELETE ON "mdm"."chemo_regimen_drugs" FROM hms_app;


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
                            'immunisation_schedules')
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
    AND c.relname IN ('onco_cases','onco_treatment_plans','chemo_cycles','chemo_order_lines',
                      'chemo_administrations','onco_cumulative_doses','toxicity_assessments')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Oncology tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


/* `mdm.chemo_regimens` and its drug lines carry a nullable `hospital_id`: the
   seeded library is global and every hospital reads it, while a hospital that
   writes its own regimen owns that row. The generator's nullable-tenant policy
   is exactly right for that, and it has already been applied above. */
