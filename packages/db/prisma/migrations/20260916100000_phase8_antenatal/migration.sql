-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-040 — the antenatal clinic
-- Where one of the two patients cannot speak and the other is a statute
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every console before this one has one patient. This one has two, and the
-- second is not yet born. Two of the tables here exist because Parliament said
-- so, and getting them wrong is not a data quality problem — it is a criminal
-- offence with a doctor's name on it.
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **The estimated date of delivery is derived, and a dating scan beats a
--    remembered period.** Everything downstream is arithmetic from this one
--    date: whether a baby is preterm, whether growth is restricted, when to
--    induce, when a pregnancy is post-dates. A woman's memory of a last period
--    is not evidence and an early scan is, so Naegele's rule is superseded when
--    the scan disagrees by more than the published tolerance for the window it
--    was done in — five days before nine weeks, widening to twenty-one days
--    after twenty-eight. The refusal is not a refusal at all: the trigger
--    simply writes the better date and says, in a sentence, why.
--
-- 2. **Gestational age has no field anywhere.** It is the working date and
--    today. A typed gestational age is a number that was right once, and it is
--    read on every screen in this module.
--
-- 3. **When the date moves, the whole schedule moves.** Twelve-week booking
--    bloods, the anomaly scan at twenty, the growth scan at thirty-two: each is
--    stored as a week rather than only a date, so that correcting an EDD
--    corrects the calendar rather than leaving eight appointments on the old one.
--
-- 4. **A Rhesus-negative woman gets an anti-D schedule item she cannot lose.**
--    This is the rule with the strangest shape in the build: the harm of
--    missing it lands on a child who has not been conceived. An unsensitised
--    mother's next pregnancy is normal; a sensitised mother's next baby can die
--    of haemolytic disease. So the item is created by the database when the
--    blood group is recorded, and the pregnancy cannot be closed while it is
--    outstanding — done, or waived with a reason, and nothing else.
--
-- 5. **There is no field for the sex of a foetus.** Not restricted, not
--    permissioned, not audited — absent. The PC-PNDT Act exists because
--    sex-selective abortion removed tens of millions of girls from the Indian
--    population, and it is enforced by inspecting records. A system with a
--    column for it, however well guarded, is a system that can be made to hold
--    it. §B.6 asserts the absence across every antenatal table at migration
--    time, so a future migration that adds one fails here rather than in a
--    courtroom.
--
-- 6. **An obstetric ultrasound needs a signed Form F from a registered
--    sonologist**, and the form locks when it is signed.
--
-- 7. **The MTP gates are the statute.** Below twenty weeks, one registered
--    medical practitioner's opinion. Twenty to twenty-four, two opinions from
--    two different doctors and one of the named grounds. Beyond twenty-four, a
--    Medical Board and no other route. A minor needs a guardian's consent; no
--    woman needs a husband's, and there is nowhere to record one. The register
--    serial is gapless because the Rules require a register, and a hole in a
--    register is exactly what an inspection is looking for.
--
-- 8. **The obstetric early warning score is derived**, and so is what it
--    obliges somebody to do. A score somebody totals by hand at the end of a
--    clinic is a score that gets rounded down.
--
-- 9. **A visit with a danger sign on it cannot be signed without a plan.**
--    Ticking "reduced fetal movements" and signing is the commonest way a
--    stillbirth has a normal antenatal record behind it.
--
-- 10. **The postnatal depression referral is derived**, from the total and from
--     the tenth question separately — because the tenth question is about
--     self-harm and a total under thirteen with a positive tenth is still a
--     referral.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: OP040.
-- ═════════════════════════════════════════════════════════════════════════════


-- CreateEnum
CREATE TYPE "specialty"."EddSource" AS ENUM ('lmp', 'usg', 'clinical');

-- CreateEnum
CREATE TYPE "specialty"."RiskCategory" AS ENUM ('low', 'moderate', 'high');

-- CreateEnum
CREATE TYPE "specialty"."PregnancyEpisodeStatus" AS ENUM ('active', 'delivered', 'aborted', 'mtp', 'ectopic', 'transferred', 'lost_to_followup');

-- CreateEnum
CREATE TYPE "specialty"."MtpCategory" AS ENUM ('le20', 'wk20_24', 'gt24_board');

-- CreateEnum
CREATE TYPE "specialty"."MtpMethod" AS ENUM ('medical', 'mva', 'eva', 'de', 'other');

-- CreateTable
CREATE TABLE "specialty"."pregnancies" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "anc_no" VARCHAR(32) NOT NULL,
    "lmp" DATE,
    "lmp_certain" BOOLEAN NOT NULL DEFAULT false,
    "cycle_days" INTEGER NOT NULL DEFAULT 28,
    "edd_lmp" DATE,
    "usg_dating" JSONB,
    "edd_usg" DATE,
    "working_edd" DATE NOT NULL,
    "edd_source" "specialty"."EddSource" NOT NULL,
    "edd_rationale" TEXT,
    "gravida" INTEGER NOT NULL,
    "para" INTEGER NOT NULL DEFAULT 0,
    "living" INTEGER NOT NULL DEFAULT 0,
    "abortions" INTEGER NOT NULL DEFAULT 0,
    "ectopic" INTEGER NOT NULL DEFAULT 0,
    "obstetric_history" JSONB NOT NULL DEFAULT '[]',
    "medical_history" JSONB NOT NULL DEFAULT '{}',
    "booking_bmi" DECIMAL(4,1),
    "blood_group" VARCHAR(8),
    "rh_negative" BOOLEAN,
    "risk_category" "specialty"."RiskCategory" NOT NULL DEFAULT 'low',
    "risk_flags" JSONB NOT NULL DEFAULT '[]',
    "rch_id" VARCHAR(32),
    "pmsma" BOOLEAN NOT NULL DEFAULT false,
    "scheme" VARCHAR(16) NOT NULL DEFAULT 'none',
    "status" "specialty"."PregnancyEpisodeStatus" NOT NULL DEFAULT 'active',
    "outcome" JSONB NOT NULL DEFAULT '{}',
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pregnancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."anc_visits" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "pregnancy_id" UUID NOT NULL,
    "encounter_id" UUID,
    "visit_no" INTEGER NOT NULL,
    "visited_at" TIMESTAMPTZ(6) NOT NULL,
    "ga_days" INTEGER,
    "complaints" JSONB NOT NULL DEFAULT '{}',
    "danger_signs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bp_sys" INTEGER,
    "bp_dia" INTEGER,
    "bp_sys_right" INTEGER,
    "bp_dia_right" INTEGER,
    "weight_kg" DECIMAL(5,2),
    "pallor" VARCHAR(16),
    "oedema" VARCHAR(16),
    "pulse" INTEGER,
    "resp_rate" INTEGER,
    "temperature_c" DECIMAL(4,1),
    "consciousness" VARCHAR(16),
    "urine_albumin" VARCHAR(16),
    "urine_sugar" VARCHAR(16),
    "sfh_cm" DECIMAL(4,1),
    "lie" VARCHAR(24),
    "presentation" VARCHAR(24),
    "engagement" VARCHAR(24),
    "fhr" INTEGER,
    "fetal_movements" VARCHAR(24),
    "exam" JSONB NOT NULL DEFAULT '{}',
    "meows_score" INTEGER,
    "meows_action" VARCHAR(80),
    "supplements" JSONB NOT NULL DEFAULT '{}',
    "immunisation" JSONB NOT NULL DEFAULT '{}',
    "counselling" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "plan" TEXT,
    "next_visit_at" DATE,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "anc_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."anc_schedule_items" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "pregnancy_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "due_ga_weeks" INTEGER NOT NULL,
    "due_at" DATE NOT NULL,
    "order_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'due',
    "result_summary" JSONB NOT NULL DEFAULT '{}',
    "waived_reason" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "anc_schedule_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."delivery_plans" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "pregnancy_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "planned_mode" VARCHAR(24) NOT NULL,
    "indication" TEXT,
    "planned_date" DATE,
    "place" VARCHAR(120),
    "pac_id" UUID,
    "blood_request_id" UUID,
    "admission_booking_id" UUID,
    "consents" JSONB NOT NULL DEFAULT '{}',
    "newborn_plan" JSONB NOT NULL DEFAULT '{}',
    "birth_companion" VARCHAR(120),
    "transport" VARCHAR(120),
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "delivery_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pcpndt_form_f" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "scan_order_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "pregnancy_id" UUID,
    "machine_id" UUID NOT NULL,
    "centre_reg_no" VARCHAR(60) NOT NULL,
    "sonologist_id" UUID NOT NULL,
    "referring_doctor" VARCHAR(160) NOT NULL,
    "indication_code" VARCHAR(40) NOT NULL,
    "declaration" JSONB NOT NULL,
    "result_summary" TEXT,
    "signed_at" TIMESTAMPTZ(6),
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "submitted_in_return_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pcpndt_form_f_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pcpndt_sonologists" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "registration_no" VARCHAR(60) NOT NULL,
    "qualification" VARCHAR(120) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pcpndt_sonologists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."mtp_cases" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "mtp_serial" INTEGER NOT NULL,
    "pregnancy_id" UUID,
    "ga_days_by_usg" INTEGER NOT NULL,
    "category" "specialty"."MtpCategory" NOT NULL,
    "grounds" VARCHAR(40),
    "minor" BOOLEAN NOT NULL DEFAULT false,
    "guardian_consent_id" UUID,
    "opinion_ids" UUID[],
    "form_c_consent_id" UUID NOT NULL,
    "medical_board_ref" VARCHAR(120),
    "method" "specialty"."MtpMethod",
    "regimen" JSONB NOT NULL DEFAULT '{}',
    "procedure_id" UUID,
    "performed_at" TIMESTAMPTZ(6),
    "performed_by" UUID,
    "complications" JSONB NOT NULL DEFAULT '[]',
    "followup" JSONB NOT NULL DEFAULT '{}',
    "anti_d_given" BOOLEAN NOT NULL DEFAULT false,
    "contraception" JSONB NOT NULL DEFAULT '{}',
    "pocso_report_task_id" UUID,
    "register_locked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mtp_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pnc_visits" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "pregnancy_id" UUID NOT NULL,
    "day_no" INTEGER NOT NULL,
    "visited_at" TIMESTAMPTZ(6) NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '{}',
    "bp_sys" INTEGER,
    "bp_dia" INTEGER,
    "epds_total" INTEGER,
    "epds_item10" INTEGER,
    "epds_referral" BOOLEAN NOT NULL DEFAULT false,
    "breastfeeding" VARCHAR(40),
    "contraception" JSONB NOT NULL DEFAULT '{}',
    "referral" TEXT,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pnc_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pregnancies_hospital_id_branch_id_status_idx" ON "specialty"."pregnancies"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "pregnancies_hospital_id_patient_id_idx" ON "specialty"."pregnancies"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "pregnancies_hospital_id_working_edd_idx" ON "specialty"."pregnancies"("hospital_id", "working_edd");

-- CreateIndex
CREATE UNIQUE INDEX "uq_pregnancy_anc_no" ON "specialty"."pregnancies"("hospital_id", "anc_no");

-- CreateIndex
CREATE INDEX "anc_visits_hospital_id_pregnancy_id_visited_at_idx" ON "specialty"."anc_visits"("hospital_id", "pregnancy_id", "visited_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_anc_visit_no" ON "specialty"."anc_visits"("pregnancy_id", "visit_no");

-- CreateIndex
CREATE INDEX "anc_schedule_items_hospital_id_due_at_status_idx" ON "specialty"."anc_schedule_items"("hospital_id", "due_at", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_anc_schedule_item" ON "specialty"."anc_schedule_items"("pregnancy_id", "kind", "code");

-- CreateIndex
CREATE INDEX "delivery_plans_hospital_id_pregnancy_id_idx" ON "specialty"."delivery_plans"("hospital_id", "pregnancy_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_plan_version" ON "specialty"."delivery_plans"("pregnancy_id", "version");

-- CreateIndex
CREATE INDEX "pcpndt_form_f_hospital_id_signed_at_idx" ON "specialty"."pcpndt_form_f"("hospital_id", "signed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_form_f_per_scan" ON "specialty"."pcpndt_form_f"("hospital_id", "scan_order_id");

-- CreateIndex
CREATE INDEX "pcpndt_sonologists_hospital_id_valid_to_idx" ON "specialty"."pcpndt_sonologists"("hospital_id", "valid_to");

-- CreateIndex
CREATE UNIQUE INDEX "uq_pcpndt_sonologist" ON "specialty"."pcpndt_sonologists"("hospital_id", "user_id", "registration_no");

-- CreateIndex
CREATE INDEX "mtp_cases_hospital_id_performed_at_idx" ON "specialty"."mtp_cases"("hospital_id", "performed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_mtp_serial" ON "specialty"."mtp_cases"("hospital_id", "mtp_serial");

-- CreateIndex
CREATE INDEX "pnc_visits_hospital_id_pregnancy_id_visited_at_idx" ON "specialty"."pnc_visits"("hospital_id", "pregnancy_id", "visited_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_pnc_visit_day" ON "specialty"."pnc_visits"("pregnancy_id", "day_no");

-- AddForeignKey
ALTER TABLE "specialty"."anc_visits" ADD CONSTRAINT "anc_visits_pregnancy_id_fkey" FOREIGN KEY ("pregnancy_id") REFERENCES "specialty"."pregnancies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."anc_schedule_items" ADD CONSTRAINT "anc_schedule_items_pregnancy_id_fkey" FOREIGN KEY ("pregnancy_id") REFERENCES "specialty"."pregnancies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."delivery_plans" ADD CONSTRAINT "delivery_plans_pregnancy_id_fkey" FOREIGN KEY ("pregnancy_id") REFERENCES "specialty"."pregnancies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."pcpndt_form_f" ADD CONSTRAINT "pcpndt_form_f_pregnancy_id_fkey" FOREIGN KEY ("pregnancy_id") REFERENCES "specialty"."pregnancies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."pnc_visits" ADD CONSTRAINT "pnc_visits_pregnancy_id_fkey" FOREIGN KEY ("pregnancy_id") REFERENCES "specialty"."pregnancies"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  The estimated date of delivery, derived ───────────────────────────
--
-- Naegele's rule adjusted for cycle length, superseded by an early dating scan
-- when the two disagree by more than the tolerance for the window the scan was
-- done in. The tolerances are ACOG's, and they widen with gestation for the
-- obvious reason: a crown-rump length at eight weeks dates a pregnancy to within
-- days, and a femur at thirty weeks does not date it at all.

-- How far a scan may differ from the period before the scan wins, by the
-- gestational age at which the scan was done. Named so that a hospital changing
-- its policy changes one function.
CREATE OR REPLACE FUNCTION specialty.edd_tolerance_days(p_ga_days_at_scan int)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_ga_days_at_scan <  63 THEN 5    -- to 8w6d
    WHEN p_ga_days_at_scan <  98 THEN 7    -- 9w0d to 13w6d
    WHEN p_ga_days_at_scan < 112 THEN 7    -- 14w0d to 15w6d
    WHEN p_ga_days_at_scan < 154 THEN 10   -- 16w0d to 21w6d
    WHEN p_ga_days_at_scan < 196 THEN 14   -- 22w0d to 27w6d
    ELSE 21                                -- 28w0d and beyond
  END
$$;

CREATE OR REPLACE FUNCTION specialty.derive_working_edd()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_scan_date date;
  v_ga_at_scan int;
  v_tolerance int;
  v_diff int;
BEGIN
  -- Naegele, adjusted: a woman with a thirty-five-day cycle ovulates a week
  -- late, and dating her from a twenty-eight-day assumption makes her baby a
  -- week more preterm than it is.
  NEW.edd_lmp := CASE
                   WHEN NEW.lmp IS NULL THEN NULL
                   ELSE NEW.lmp + 280 + (NEW.cycle_days - 28)
                 END;

  IF jsonb_typeof(NEW.usg_dating) = 'object'
     AND NEW.usg_dating ? 'scanDate' AND NEW.usg_dating ? 'gaDaysAtScan' THEN
    v_scan_date  := (NEW.usg_dating ->> 'scanDate')::date;
    v_ga_at_scan := (NEW.usg_dating ->> 'gaDaysAtScan')::int;
    IF v_ga_at_scan < 1 OR v_ga_at_scan > 300 THEN
      RAISE EXCEPTION 'A gestational age of % days at the scan is not a gestational age. (OP-040 §B.1)', v_ga_at_scan
        USING ERRCODE = 'OP040';
    END IF;
    NEW.edd_usg := v_scan_date + (280 - v_ga_at_scan);
  ELSE
    NEW.edd_usg := NULL;
  END IF;

  -- A doctor who has looked at both and decided is the one case the arithmetic
  -- does not cover, and it is a named act with a reason rather than a silent
  -- edit. Anything else is derived.
  IF NEW.edd_source = 'clinical' THEN
    IF NEW.working_edd IS NULL THEN
      RAISE EXCEPTION 'A clinical estimated date of delivery has to name a date. (OP-040 §B.1)'
        USING ERRCODE = 'OP040';
    END IF;
    IF NEW.edd_rationale IS NULL OR length(btrim(NEW.edd_rationale)) < 8 THEN
      RAISE EXCEPTION 'A clinical estimated date of delivery has to say why it overrides both the period and the scan. (OP-040 §B.1)'
        USING ERRCODE = 'OP040';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.edd_lmp IS NULL AND NEW.edd_usg IS NULL THEN
    RAISE EXCEPTION 'A pregnancy needs a last menstrual period or a dating scan. Without one there is no gestational age, and every decision in this module is a line on it. (OP-040 §B.1)'
      USING ERRCODE = 'OP040';
  END IF;

  IF NEW.edd_usg IS NULL THEN
    NEW.working_edd   := NEW.edd_lmp;
    NEW.edd_source    := 'lmp';
    NEW.edd_rationale := format('From a last period of %s with a %s-day cycle.',
                                to_char(NEW.lmp, 'DD Mon YYYY'), NEW.cycle_days);
  ELSIF NEW.edd_lmp IS NULL THEN
    NEW.working_edd   := NEW.edd_usg;
    NEW.edd_source    := 'usg';
    NEW.edd_rationale := format('From a dating scan on %s; no last period was known.',
                                to_char(v_scan_date, 'DD Mon YYYY'));
  ELSE
    v_tolerance := specialty.edd_tolerance_days(v_ga_at_scan);
    v_diff := abs(NEW.edd_usg - NEW.edd_lmp);
    IF v_diff > v_tolerance THEN
      NEW.working_edd   := NEW.edd_usg;
      NEW.edd_source    := 'usg';
      NEW.edd_rationale := format(
        'The scan on %s dates the pregnancy %s days from the period, and at %sw%sd the scan is trusted beyond %s days.',
        to_char(v_scan_date, 'DD Mon YYYY'), v_diff,
        v_ga_at_scan / 7, v_ga_at_scan % 7, v_tolerance);
    ELSE
      NEW.working_edd   := NEW.edd_lmp;
      NEW.edd_source    := 'lmp';
      NEW.edd_rationale := format(
        'The scan on %s agrees with the period to within %s days, so the period stands.',
        to_char(v_scan_date, 'DD Mon YYYY'), v_diff);
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_working_edd
  BEFORE INSERT OR UPDATE OF lmp, lmp_certain, cycle_days, usg_dating, working_edd, edd_source, edd_rationale
    ON specialty.pregnancies
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_working_edd();

-- The obstetric formula has to add up. The current pregnancy is counted in
-- gravida, so a first pregnancy is G1 P0 A0.
ALTER TABLE "specialty"."pregnancies"
  ADD CONSTRAINT "the_obstetric_formula_adds_up"
  CHECK ("gravida" >= 1 AND "gravida" >= "para" + "abortions" + "ectopic"
     AND "para" >= 0 AND "living" >= 0 AND "abortions" >= 0 AND "ectopic" >= 0);

ALTER TABLE "specialty"."pregnancies"
  ADD CONSTRAINT "a_cycle_is_a_cycle" CHECK ("cycle_days" BETWEEN 20 AND 45);

ALTER TABLE "specialty"."pregnancies"
  ADD CONSTRAINT "a_closed_pregnancy_has_a_closing_time"
  CHECK (("status" = 'active') = ("closed_at" IS NULL));


-- ── §B.2  Gestational age is derived at every visit ─────────────────────────
CREATE OR REPLACE FUNCTION specialty.derive_visit_ga()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_edd date;
BEGIN
  SELECT p.working_edd INTO v_edd FROM specialty.pregnancies p WHERE p.id = NEW.pregnancy_id;
  NEW.ga_days := 280 - (v_edd - NEW.visited_at::date);

  IF NEW.ga_days < -30 OR NEW.ga_days > 330 THEN
    RAISE EXCEPTION 'A visit on % is %w%d, which is outside a pregnancy. Check the visit date or the working estimated date of delivery. (OP-040 §B.2)',
      NEW.visited_at::date, NEW.ga_days / 7, abs(NEW.ga_days % 7)
      USING ERRCODE = 'OP040';
  END IF;

  -- ── The obstetric early warning score, and what it obliges ────────────────
  -- Totalled by hand at the end of a clinic it gets rounded down, which is the
  -- whole reason the score exists rather than a clinician's impression.
  NEW.meows_score := coalesce(
      CASE WHEN NEW.resp_rate IS NULL THEN 0
           WHEN NEW.resp_rate > 30 THEN 2
           WHEN NEW.resp_rate < 10 OR NEW.resp_rate > 20 THEN 1 ELSE 0 END, 0)
    + coalesce(
      CASE WHEN NEW.temperature_c IS NULL THEN 0
           WHEN NEW.temperature_c < 35 OR NEW.temperature_c >= 38 THEN 2
           WHEN NEW.temperature_c < 36 OR NEW.temperature_c >= 37.5 THEN 1 ELSE 0 END, 0)
    + coalesce(
      CASE WHEN NEW.bp_sys IS NULL THEN 0
           WHEN NEW.bp_sys >= 160 OR NEW.bp_sys < 90 THEN 2
           WHEN NEW.bp_sys >= 150 THEN 1 ELSE 0 END, 0)
    + coalesce(
      CASE WHEN NEW.bp_dia IS NULL THEN 0
           WHEN NEW.bp_dia >= 100 THEN 2
           WHEN NEW.bp_dia >= 90 THEN 1 ELSE 0 END, 0)
    + coalesce(
      CASE WHEN NEW.pulse IS NULL THEN 0
           WHEN NEW.pulse >= 120 OR NEW.pulse < 50 THEN 2
           WHEN NEW.pulse >= 100 THEN 1 ELSE 0 END, 0)
    + coalesce(
      CASE WHEN NEW.consciousness IS NULL OR NEW.consciousness = 'alert' THEN 0 ELSE 2 END, 0);

  NEW.meows_action := CASE
    -- Any single parameter at two is a red on its own. That is what makes it a
    -- warning score rather than an average.
    WHEN NEW.bp_sys >= 160 OR NEW.bp_dia >= 110 THEN 'severe hypertension: admit today'
    WHEN NEW.consciousness IS NOT NULL AND NEW.consciousness <> 'alert' THEN 'not alert: urgent obstetric review'
    WHEN NEW.meows_score >= 4 THEN 'urgent obstetric review'
    WHEN NEW.bp_sys >= 140 OR NEW.bp_dia >= 90 THEN
      CASE WHEN NEW.urine_albumin IS NOT NULL AND NEW.urine_albumin NOT IN ('nil', 'trace', '0')
           THEN 'hypertension with proteinuria: pre-eclampsia pathway today'
           ELSE 'repeat the blood pressure in fifteen minutes' END
    WHEN NEW.meows_score >= 2 THEN 'repeat observations in thirty minutes'
    ELSE NULL
  END;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_visit_ga
  BEFORE INSERT OR UPDATE OF visited_at, pregnancy_id, ga_days, bp_sys, bp_dia, pulse,
                             resp_rate, temperature_c, consciousness, urine_albumin,
                             meows_score, meows_action
    ON specialty.anc_visits
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_visit_ga();

-- ── §B.3  A danger sign cannot be signed away ───────────────────────────────
--
-- Ticking "reduced fetal movements" and signing the visit is the commonest way
-- a stillbirth comes to have a normal antenatal record behind it.
ALTER TABLE "specialty"."anc_visits"
  ADD CONSTRAINT "a_danger_sign_needs_a_plan"
  CHECK ("signed_at" IS NULL
      OR coalesce(array_length("danger_signs", 1), 0) = 0
      OR ("plan" IS NOT NULL AND length(btrim("plan")) >= 8));

ALTER TABLE "specialty"."anc_visits"
  ADD CONSTRAINT "a_signed_visit_names_its_signer"
  CHECK (("signed_at" IS NULL) = ("signed_by" IS NULL));

ALTER TABLE "specialty"."anc_visits"
  ADD CONSTRAINT "antenatal_vitals_are_plausible"
  CHECK (("bp_sys" IS NULL OR "bp_sys" BETWEEN 50 AND 300)
     AND ("bp_dia" IS NULL OR "bp_dia" BETWEEN 20 AND 200)
     AND ("bp_sys" IS NULL OR "bp_dia" IS NULL OR "bp_sys" > "bp_dia")
     AND ("pulse" IS NULL OR "pulse" BETWEEN 20 AND 250)
     AND ("resp_rate" IS NULL OR "resp_rate" BETWEEN 4 AND 60)
     AND ("temperature_c" IS NULL OR "temperature_c" BETWEEN 30 AND 45)
     AND ("fhr" IS NULL OR "fhr" BETWEEN 50 AND 240)
     AND ("sfh_cm" IS NULL OR "sfh_cm" BETWEEN 8 AND 55));


-- ── §B.4  When the date moves, the calendar moves with it ───────────────────
--
-- Correcting an EDD and leaving eight appointments on the old one is how an
-- anomaly scan gets booked for twenty-two weeks, by which time the window for
-- the decisions it informs has closed.
CREATE OR REPLACE FUNCTION specialty.reschedule_on_edd_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.working_edd = OLD.working_edd THEN RETURN NEW; END IF;

  UPDATE specialty.anc_schedule_items
     SET due_at = NEW.working_edd - (280 - due_ga_weeks * 7),
         updated_at = now()
   WHERE pregnancy_id = NEW.id
     AND status IN ('due', 'overdue');

  RETURN NEW;
END $$;

-- `AFTER UPDATE OF working_edd` would watch the *statement's* column list, and
-- the working date is set by a BEFORE trigger rather than by the caller — so it
-- would never fire on the case this rule exists for. WHEN watches the value.
CREATE TRIGGER trg_reschedule_on_edd_change
  AFTER UPDATE ON specialty.pregnancies
  FOR EACH ROW WHEN (NEW.working_edd IS DISTINCT FROM OLD.working_edd)
  EXECUTE FUNCTION specialty.reschedule_on_edd_change();


-- ── §B.5  Anti-D, and the child who has not been conceived ──────────────────
--
-- The strangest-shaped rule in the build. A Rhesus-negative woman carrying a
-- Rhesus-positive baby will make antibodies against it unless she is given
-- anti-D — and the harm of missing the dose lands not on this pregnancy, which
-- proceeds normally, but on her *next* baby, who can die of haemolytic disease
-- before or shortly after birth. Nobody in the room when the dose is missed
-- will ever meet the person it harms.
--
-- So the item is created by the database the moment the blood group is
-- recorded, and the pregnancy cannot be closed while it is outstanding. It is
-- done, or waived with a reason — a baby who is also Rhesus negative needs
-- nothing, and that is a legitimate and common waiver — and there is no third
-- state.
CREATE OR REPLACE FUNCTION specialty.raise_anti_d_schedule()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rh_negative IS NOT TRUE THEN RETURN NEW; END IF;

  INSERT INTO specialty.anc_schedule_items
    (id, hospital_id, pregnancy_id, kind, code, name, due_ga_weeks, due_at, status,
     created_at, updated_at)
  VALUES
    (gen_random_uuid(), NEW.hospital_id, NEW.id, 'anti_d', 'ANTI_D_28',
     'Anti-D prophylaxis at 28 weeks', 28, NEW.working_edd - (280 - 28 * 7), 'due',
     now(), now()),
    (gen_random_uuid(), NEW.hospital_id, NEW.id, 'lab', 'ICT',
     'Indirect Coombs test', 28, NEW.working_edd - (280 - 28 * 7), 'due', now(), now())
  ON CONFLICT (pregnancy_id, kind, code) DO NOTHING;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_raise_anti_d_schedule
  AFTER INSERT OR UPDATE OF rh_negative, working_edd ON specialty.pregnancies
  FOR EACH ROW EXECUTE FUNCTION specialty.raise_anti_d_schedule();

CREATE OR REPLACE FUNCTION specialty.anti_d_is_settled_before_closing()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_outstanding int;
BEGIN
  IF NEW.status = 'active' THEN RETURN NEW; END IF;
  IF NEW.rh_negative IS NOT TRUE THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_outstanding
    FROM specialty.anc_schedule_items i
   WHERE i.pregnancy_id = NEW.id AND i.kind = 'anti_d'
     AND i.status NOT IN ('done', 'waived');

  IF v_outstanding > 0 THEN
    RAISE EXCEPTION 'This pregnancy cannot be closed with anti-D outstanding. She is Rhesus negative, and a missed dose does nothing to this baby and can kill the next one. Record the dose, or waive it with a reason — a Rhesus-negative baby needs none. (OP-040 §B.5)'
      USING ERRCODE = 'OP040';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_anti_d_is_settled_before_closing
  BEFORE UPDATE ON specialty.pregnancies
  FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION specialty.anti_d_is_settled_before_closing();

ALTER TABLE "specialty"."anc_schedule_items"
  ADD CONSTRAINT "a_schedule_item_status_is_known"
  CHECK ("status" IN ('due', 'ordered', 'done', 'overdue', 'waived'));

ALTER TABLE "specialty"."anc_schedule_items"
  ADD CONSTRAINT "a_waived_item_says_why"
  CHECK ("status" <> 'waived'
      OR ("waived_reason" IS NOT NULL AND length(btrim("waived_reason")) >= 4));


-- ── §B.6  There is no field for the sex of a foetus ─────────────────────────
--
-- The PC-PNDT Act exists because sex-selective abortion removed tens of
-- millions of girls from the Indian population, and it is enforced by
-- inspecting records. A column for it, however well guarded, is a column that
-- can be made to hold it — so there is none, and this block asserts the absence
-- across every antenatal table at migration time.
--
-- The point of doing it here rather than in a test: a migration written in
-- three years by somebody who has not read this file will fail on the statement
-- that adds the column, next to the paragraph explaining why.
DO $$
DECLARE v_found text;
BEGIN
  SELECT string_agg(format('%s.%s', table_name, column_name), ', ') INTO v_found
    FROM information_schema.columns
   WHERE table_schema = 'specialty'
     AND table_name IN ('pregnancies', 'anc_visits', 'anc_schedule_items', 'delivery_plans',
                        'pcpndt_form_f', 'pcpndt_sonologists', 'mtp_cases', 'pnc_visits')
     AND (column_name ~* '(^|_)(sex|gender)(_|$)');
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION
      'PC-PNDT: an antenatal table has a column for foetal sex (%). There is no lawful use for one, and a column that exists can be filled. Remove it.', v_found;
  END IF;
END $$;


-- ── §B.7  Form F, and who may sign one ──────────────────────────────────────
CREATE OR REPLACE FUNCTION specialty.form_f_is_lawfully_signed()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_registered boolean;
BEGIN
  -- A locked form is the record an inspector reads. Nothing moves in it.
  IF TG_OP = 'UPDATE' AND OLD.locked THEN
    RAISE EXCEPTION 'Form F % is signed and locked. A signed Form F is the record an inspection reads; it is corrected by a new scan and a new form, never by an edit. (OP-040 §B.7)',
      OLD.id
      USING ERRCODE = 'OP040';
  END IF;

  IF NEW.signed_at IS NULL THEN
    NEW.locked := false;
    RETURN NEW;
  END IF;

  SELECT true INTO v_registered
    FROM specialty.pcpndt_sonologists s
   WHERE s.hospital_id = NEW.hospital_id
     AND s.user_id = NEW.sonologist_id
     AND s.valid_from <= NEW.signed_at::date
     AND (s.valid_to IS NULL OR s.valid_to >= NEW.signed_at::date)
   LIMIT 1;

  IF v_registered IS NOT TRUE THEN
    RAISE EXCEPTION 'That sonologist is not registered under the PC-PNDT Act at this centre, or their registration has lapsed. A report signed by somebody not on the register is an offence by the centre, and the centre is this hospital. (OP-040 §B.7)'
      USING ERRCODE = 'OP040';
  END IF;

  IF NOT (NEW.declaration ? 'patientAttested' AND NEW.declaration ? 'sonologistAttested') THEN
    RAISE EXCEPTION 'Form F needs both declarations: the woman''s that she was not told the sex of the foetus, and the sonologist''s that it was not disclosed. They are the whole point of the form. (OP-040 §B.7)'
      USING ERRCODE = 'OP040';
  END IF;

  IF (NEW.declaration ->> 'patientAttested')::boolean IS NOT TRUE
     OR (NEW.declaration ->> 'sonologistAttested')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'Form F cannot be signed with a declaration that has not been made. (OP-040 §B.7)'
      USING ERRCODE = 'OP040';
  END IF;

  NEW.locked := true;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_form_f_is_lawfully_signed
  BEFORE INSERT OR UPDATE ON specialty.pcpndt_form_f
  FOR EACH ROW EXECUTE FUNCTION specialty.form_f_is_lawfully_signed();

ALTER TABLE "specialty"."pcpndt_sonologists"
  ADD CONSTRAINT "a_registration_runs_forwards"
  CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");


-- ── §B.8  The MTP gates are the statute ─────────────────────────────────────
--
-- The Medical Termination of Pregnancy Act as amended in 2021, expressed as a
-- database shape because the alternative is a form somebody fills in
-- afterwards. Note which way the gates face: they do not stop a lawful
-- termination, they stop an unlawful record of one — and the doctor whose name
-- is on it is the person the law reaches.
CREATE OR REPLACE FUNCTION specialty.mtp_meets_the_act()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_opinions int;
  v_distinct int;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.register_locked THEN
    RAISE EXCEPTION 'MTP register entry % is locked. The Rules require a register, and a register that can be edited is not one. (OP-040 §B.8)',
      OLD.mtp_serial
      USING ERRCODE = 'OP040';
  END IF;

  -- Gapless, per centre, assigned here. There is no request field: a serial a
  -- caller can choose is a serial with a hole in it.
  IF TG_OP = 'INSERT' THEN
    SELECT coalesce(max(m.mtp_serial), 0) + 1 INTO NEW.mtp_serial
      FROM specialty.mtp_cases m WHERE m.hospital_id = NEW.hospital_id;
  END IF;

  -- The category is the gestation, not a choice.
  NEW.category := CASE
    WHEN NEW.ga_days_by_usg < 140 THEN 'le20'
    WHEN NEW.ga_days_by_usg < 168 THEN 'wk20_24'
    ELSE 'gt24_board'
  END::specialty."MtpCategory";

  v_opinions := coalesce(array_length(NEW.opinion_ids, 1), 0);
  SELECT count(DISTINCT x) INTO v_distinct FROM unnest(NEW.opinion_ids) AS x;

  IF NEW.category = 'le20' THEN
    IF v_opinions < 1 THEN
      RAISE EXCEPTION 'Below twenty weeks the Act needs one registered medical practitioner''s opinion, and none is recorded. (OP-040 §B.8)'
        USING ERRCODE = 'OP040';
    END IF;
  ELSIF NEW.category = 'wk20_24' THEN
    IF v_opinions < 2 THEN
      RAISE EXCEPTION 'At %w%d the Act needs the opinions of two registered medical practitioners, and % % recorded. (OP-040 §B.8)',
        NEW.ga_days_by_usg / 7, NEW.ga_days_by_usg % 7, v_opinions,
        CASE WHEN v_opinions = 1 THEN 'is' ELSE 'are' END
        USING ERRCODE = 'OP040';
    END IF;
    IF v_distinct < 2 THEN
      RAISE EXCEPTION 'Two opinions means two doctors. The same practitioner cannot form both. (OP-040 §B.8)'
        USING ERRCODE = 'OP040';
    END IF;
    IF NEW.grounds IS NULL THEN
      RAISE EXCEPTION 'From twenty weeks the Act permits termination only on one of the named grounds, and none is recorded. (OP-040 §B.8)'
        USING ERRCODE = 'OP040';
    END IF;
  ELSE
    IF NEW.medical_board_ref IS NULL OR length(btrim(NEW.medical_board_ref)) < 3 THEN
      RAISE EXCEPTION 'Beyond twenty-four weeks only a Medical Board can permit a termination, for substantial foetal abnormality. There is no other route, and no opinion of any number of practitioners substitutes for one. (OP-040 §B.8)'
        USING ERRCODE = 'OP040';
    END IF;
  END IF;

  -- Her consent, and a guardian's only if she is a minor or mentally ill.
  -- Never a husband's — and there is nowhere in this table to record one.
  IF NEW.minor AND NEW.guardian_consent_id IS NULL THEN
    RAISE EXCEPTION 'A minor''s termination needs her guardian''s consent recorded alongside her own. (OP-040 §B.8)'
      USING ERRCODE = 'OP040';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_mtp_meets_the_act
  BEFORE INSERT OR UPDATE ON specialty.mtp_cases
  FOR EACH ROW EXECUTE FUNCTION specialty.mtp_meets_the_act();

-- The same assertion as §B.6, for the same reason and a different word: there is
-- no consent from a husband in this Act, and a column for one would invite the
-- practice the Act removed.
DO $$
DECLARE v_found text;
BEGIN
  SELECT string_agg(column_name, ', ') INTO v_found
    FROM information_schema.columns
   WHERE table_schema = 'specialty' AND table_name = 'mtp_cases'
     AND column_name ~* '(spous|husband|partner)';
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION
      'MTP: no consent but the woman''s (and a guardian''s, if she is a minor) has any standing under the Act. Remove: %', v_found;
  END IF;
END $$;

ALTER TABLE "specialty"."mtp_cases"
  ADD CONSTRAINT "a_gestation_is_a_gestation"
  CHECK ("ga_days_by_usg" BETWEEN 14 AND 300);

ALTER TABLE "specialty"."mtp_cases"
  ADD CONSTRAINT "a_performed_termination_names_its_method_and_doctor"
  CHECK ("performed_at" IS NULL
      OR ("method" IS NOT NULL AND "performed_by" IS NOT NULL));


-- ── §B.9  The postnatal depression referral is derived ──────────────────────
--
-- From the total *and* from the tenth question separately, because the tenth
-- question is about self-harm and a total of eleven with a positive tenth is
-- still a referral. A screen that summed its own would eventually get that
-- wrong in the one direction that matters.
CREATE OR REPLACE FUNCTION specialty.derive_epds_referral()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.epds_referral := coalesce(NEW.epds_total >= 13, false)
                    OR coalesce(NEW.epds_item10 > 0, false);
  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_epds_referral
  BEFORE INSERT OR UPDATE OF epds_total, epds_item10, epds_referral ON specialty.pnc_visits
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_epds_referral();

ALTER TABLE "specialty"."pnc_visits"
  ADD CONSTRAINT "the_epds_is_scored_in_range"
  CHECK (("epds_total" IS NULL OR "epds_total" BETWEEN 0 AND 30)
     AND ("epds_item10" IS NULL OR "epds_item10" BETWEEN 0 AND 3));

ALTER TABLE "specialty"."pnc_visits"
  ADD CONSTRAINT "a_postnatal_day_is_after_the_birth" CHECK ("day_no" BETWEEN 0 AND 365);


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
      AND n.nspname = 'specialty'
      AND c.relname IN ('pregnancies','anc_visits','anc_schedule_items','delivery_plans',
                        'pcpndt_form_f','pcpndt_sonologists','mtp_cases','pnc_visits')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % antenatal table(s)', v_count;
END $$;

-- Statutory registers are not deleted from. Both of these are inspected, and a
-- row that can be removed is a register that proves nothing.
REVOKE DELETE ON "specialty"."pcpndt_form_f" FROM hms_app;
REVOKE DELETE ON "specialty"."mtp_cases"     FROM hms_app;

-- A pregnancy and its visits are the clinical record. They close, they do not
-- disappear.
REVOKE DELETE ON "specialty"."pregnancies" FROM hms_app;
REVOKE DELETE ON "specialty"."anc_visits"  FROM hms_app;
REVOKE DELETE ON "specialty"."pnc_visits"  FROM hms_app;


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
    AND c.relname IN ('pregnancies','anc_visits','anc_schedule_items','delivery_plans',
                      'pcpndt_form_f','pcpndt_sonologists','mtp_cases','pnc_visits')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Antenatal tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;
