-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-025 — the ophthalmology console
-- The console that proves the framework
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── Four rules ──────────────────────────────────────────────────────────────
--
-- 1. Every measurement names one eye. `bilateral` is a diagnosis or a plan,
--    never a reading: two eyes that measure the same are two measurements that
--    agree, and the day they stop agreeing one row has nowhere to put it.
--
-- 2. logMAR is derived from the notation and the value by a trigger, never
--    typed. A trend is worth plotting only if every point on it was converted
--    the same way, and a chart that disagrees with the note about whether a
--    patient improved is worse than no chart.
--
-- 3. Dioptres come in quarter steps and an axis runs 1 to 180. A sphere of
--    -2.13 is a typo no lens is ground to, and the optical shop rings back
--    after the patient has gone home.
--
-- 4. A signed spectacle prescription is immutable, and a surgery plan that
--    names an intraocular lens names the biometry it was chosen from. A power
--    with no biometry behind it is a guess, and the eye is not adjustable
--    afterwards.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: OP025.

-- CreateEnum
CREATE TYPE "specialty"."OphthaStage" AS ENUM ('registered', 'refraction', 'dilating', 'doctor', 'imaging', 'counselling', 'done');

-- CreateEnum
CREATE TYPE "specialty"."VaNotation" AS ENUM ('snellen_6', 'snellen_20', 'logmar', 'etdrs', 'n_notation', 'cf', 'hm', 'pl', 'pl_proj', 'nlp', 'csm');

-- CreateEnum
CREATE TYPE "specialty"."VaContext" AS ENUM ('ucva', 'bcva', 'pinhole', 'with_glasses', 'near', 'post_op');

-- CreateEnum
CREATE TYPE "specialty"."RefractionKind" AS ENUM ('auto', 'retinoscopy', 'subjective', 'cycloplegic', 'old_glasses', 'final_rx', 'contact_lens');

-- CreateEnum
CREATE TYPE "specialty"."IopMethod" AS ENUM ('nct', 'goldmann', 'icare', 'tonopen', 'schiotz');

-- CreateEnum
CREATE TYPE "specialty"."DrGrade" AS ENUM ('none', 'mild_npdr', 'moderate_npdr', 'severe_npdr', 'pdr');

-- CreateEnum
CREATE TYPE "specialty"."ExamSegment" AS ENUM ('anterior', 'posterior', 'adnexa', 'motility');

-- CreateEnum
CREATE TYPE "specialty"."SpectacleRxKind" AS ENUM ('spectacle', 'contact_lens');

-- CreateEnum
CREATE TYPE "specialty"."SurgeryPlanStatus" AS ENUM ('planned', 'counselled', 'booked', 'done', 'cancelled');

-- CreateTable
CREATE TABLE "specialty"."ophtha_visits" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "stage" "specialty"."OphthaStage" NOT NULL DEFAULT 'registered',
    "dilated_at" TIMESTAMPTZ(6),
    "dilating_drug" VARCHAR(120),
    "cycloplegic" BOOLEAN NOT NULL DEFAULT false,
    "chief_complaint_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ophtha_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ophtha_visual_acuity" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "eye" "clinical"."Laterality" NOT NULL,
    "context" "specialty"."VaContext" NOT NULL,
    "notation" "specialty"."VaNotation" NOT NULL,
    "value" VARCHAR(24) NOT NULL,
    "logmar" DECIMAL(4,2),
    "distance_m" DECIMAL(4,2),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "ophtha_visual_acuity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ophtha_refractions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "eye" "clinical"."Laterality" NOT NULL,
    "kind" "specialty"."RefractionKind" NOT NULL,
    "sph" DECIMAL(5,2),
    "cyl" DECIMAL(5,2),
    "axis" INTEGER,
    "add" DECIMAL(4,2),
    "prism" DECIMAL(4,2),
    "base" VARCHAR(12),
    "va_achieved" VARCHAR(24),
    "pd_mono" DECIMAL(4,1),
    "pd_bino" DECIMAL(4,1),
    "vertex_mm" DECIMAL(4,1),
    "k1" DECIMAL(5,2),
    "k1_axis" INTEGER,
    "k2" DECIMAL(5,2),
    "k2_axis" INTEGER,
    "source" VARCHAR(12) NOT NULL DEFAULT 'manual',
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "ophtha_refractions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ophtha_iop_readings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "eye" "clinical"."Laterality" NOT NULL,
    "method" "specialty"."IopMethod" NOT NULL,
    "value_mmhg" DECIMAL(4,1) NOT NULL,
    "cct_um" INTEGER,
    "corrected_mmhg" DECIMAL(4,1),
    "post_dilation" BOOLEAN NOT NULL DEFAULT false,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "ophtha_iop_readings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ophtha_exam_findings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "segment" "specialty"."ExamSegment" NOT NULL,
    "eye" "clinical"."Laterality" NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '{}',
    "dr_grade" "specialty"."DrGrade",
    "dme" BOOLEAN,
    "cdr_vertical" DECIMAL(3,2),
    "drawing_key" VARCHAR(200),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "ophtha_exam_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ophtha_diagnoses" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "eye" "clinical"."Laterality" NOT NULL,
    "icd10" VARCHAR(12) NOT NULL,
    "snomed" VARCHAR(24),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "ophtha_diagnoses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ophtha_spectacle_rx" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "rx_no" VARCHAR(60) NOT NULL,
    "kind" "specialty"."SpectacleRxKind" NOT NULL DEFAULT 'spectacle',
    "lines" JSONB NOT NULL,
    "pd_mono" DECIMAL(4,1),
    "pd_bino" DECIMAL(4,1),
    "lens_advice" JSONB,
    "valid_until" DATE NOT NULL,
    "signed_by" UUID NOT NULL,
    "signed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signed_under_delegation" BOOLEAN NOT NULL DEFAULT false,
    "printed_at" TIMESTAMPTZ(6),
    "pdf_key" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ophtha_spectacle_rx_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ophtha_surgery_plans" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "procedure_code" VARCHAR(40) NOT NULL,
    "eye" "clinical"."Laterality" NOT NULL,
    "anaesthesia" VARCHAR(40) NOT NULL,
    "iol_model" VARCHAR(120),
    "iol_power" DECIMAL(4,2),
    "iol_formula" VARCHAR(40),
    "target_refraction" DECIMAL(4,2),
    "backup_power" DECIMAL(4,2),
    "biometry" JSONB,
    "biometry_at" TIMESTAMPTZ(6),
    "preop_checklist" JSONB,
    "status" "specialty"."SurgeryPlanStatus" NOT NULL DEFAULT 'planned',
    "consent_id" UUID,
    "estimate_id" UUID,
    "ot_case_id" UUID,
    "npcbvi_flag" BOOLEAN NOT NULL DEFAULT false,
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ophtha_surgery_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ophtha_visits_encounter_id_key" ON "specialty"."ophtha_visits"("encounter_id");

-- CreateIndex
CREATE INDEX "ophtha_visits_hospital_id_branch_id_stage_created_at_idx" ON "specialty"."ophtha_visits"("hospital_id", "branch_id", "stage", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ophtha_visits_hospital_id_patient_id_created_at_idx" ON "specialty"."ophtha_visits"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ophtha_visual_acuity_hospital_id_visit_id_eye_idx" ON "specialty"."ophtha_visual_acuity"("hospital_id", "visit_id", "eye");

-- CreateIndex
CREATE INDEX "ophtha_refractions_hospital_id_visit_id_kind_eye_idx" ON "specialty"."ophtha_refractions"("hospital_id", "visit_id", "kind", "eye");

-- CreateIndex
CREATE INDEX "ophtha_iop_readings_hospital_id_patient_id_recorded_at_idx" ON "specialty"."ophtha_iop_readings"("hospital_id", "patient_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "ophtha_iop_readings_hospital_id_visit_id_eye_idx" ON "specialty"."ophtha_iop_readings"("hospital_id", "visit_id", "eye");

-- CreateIndex
CREATE INDEX "ophtha_exam_findings_hospital_id_visit_id_idx" ON "specialty"."ophtha_exam_findings"("hospital_id", "visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_exam_finding_per_segment_eye" ON "specialty"."ophtha_exam_findings"("visit_id", "segment", "eye");

-- CreateIndex
CREATE INDEX "ophtha_diagnoses_hospital_id_visit_id_idx" ON "specialty"."ophtha_diagnoses"("hospital_id", "visit_id");

-- CreateIndex
CREATE INDEX "ophtha_spectacle_rx_hospital_id_patient_id_created_at_idx" ON "specialty"."ophtha_spectacle_rx"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_spectacle_rx_no" ON "specialty"."ophtha_spectacle_rx"("hospital_id", "rx_no");

-- CreateIndex
CREATE INDEX "ophtha_surgery_plans_hospital_id_status_created_at_idx" ON "specialty"."ophtha_surgery_plans"("hospital_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ophtha_surgery_plans_hospital_id_patient_id_idx" ON "specialty"."ophtha_surgery_plans"("hospital_id", "patient_id");

-- AddForeignKey
ALTER TABLE "specialty"."ophtha_visual_acuity" ADD CONSTRAINT "ophtha_visual_acuity_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "specialty"."ophtha_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."ophtha_refractions" ADD CONSTRAINT "ophtha_refractions_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "specialty"."ophtha_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."ophtha_iop_readings" ADD CONSTRAINT "ophtha_iop_readings_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "specialty"."ophtha_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."ophtha_exam_findings" ADD CONSTRAINT "ophtha_exam_findings_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "specialty"."ophtha_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."ophtha_diagnoses" ADD CONSTRAINT "ophtha_diagnoses_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "specialty"."ophtha_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  A measurement names one eye ───────────────────────────────────────
--
-- `bilateral` belongs to diagnoses and plans. A visual acuity, a refraction, a
-- pressure and an examined segment are each of one eye, and "both eyes are
-- 6/6" is two facts that happen to agree today.
ALTER TABLE "specialty"."ophtha_visual_acuity"
  ADD CONSTRAINT "acuity_is_of_one_eye" CHECK ("eye" IN ('left', 'right'));
ALTER TABLE "specialty"."ophtha_refractions"
  ADD CONSTRAINT "refraction_is_of_one_eye" CHECK ("eye" IN ('left', 'right'));
ALTER TABLE "specialty"."ophtha_iop_readings"
  ADD CONSTRAINT "pressure_is_of_one_eye" CHECK ("eye" IN ('left', 'right'));
ALTER TABLE "specialty"."ophtha_exam_findings"
  ADD CONSTRAINT "examined_segment_is_of_one_eye" CHECK ("eye" IN ('left', 'right'));
ALTER TABLE "specialty"."ophtha_surgery_plans"
  ADD CONSTRAINT "surgery_is_on_one_eye" CHECK ("eye" IN ('left', 'right'));

-- A diagnosis may be of both eyes, but it is still of an eye: `not_applicable`
-- on an ophthalmic diagnosis is a row nobody can act on.
ALTER TABLE "specialty"."ophtha_diagnoses"
  ADD CONSTRAINT "diagnosis_names_an_eye" CHECK ("eye" <> 'not_applicable');


-- ── §B.2  logMAR is derived, never typed ────────────────────────────────────
--
-- 6/18 is 0.48 whoever entered it. The bottom of the ladder — counting
-- fingers, hand movements, light perception — has no fraction at all, and the
-- values used here are the ones the trend charts in the literature use.
CREATE OR REPLACE FUNCTION specialty.derive_logmar()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE v_num numeric; v_den numeric; v_text text;
BEGIN
  v_text := btrim(NEW.value);

  NEW.logmar := CASE NEW.notation
    WHEN 'cf'      THEN 1.90
    WHEN 'hm'      THEN 2.30
    WHEN 'pl'      THEN 2.60
    WHEN 'pl_proj' THEN 2.60
    WHEN 'nlp'     THEN 3.00
    -- A child who fixes and follows has an acuity nobody has measured. A number
    -- here would be invented, and an invented point on a trend is worse than a
    -- gap in it.
    WHEN 'csm'     THEN NULL
    WHEN 'logmar'  THEN NULLIF(regexp_replace(v_text, '[^0-9.\-]', '', 'g'), '')::numeric
    -- ETDRS letters read, 0-100: logMAR = 1.7 - 0.02 x letters.
    WHEN 'etdrs'   THEN 1.70 - 0.02 * NULLIF(regexp_replace(v_text, '[^0-9]', '', 'g'), '')::numeric
    -- Near vision in N-notation has no distance equivalent; it is charted on
    -- its own scale, not on this one.
    WHEN 'n_notation' THEN NULL
    ELSE NULL
  END;

  IF NEW.notation IN ('snellen_6', 'snellen_20') THEN
    -- The shape is checked before the cast, not after: `'good'::numeric` raises
    -- Postgres's own message about invalid input syntax, and the optometrist
    -- who typed it needs to be told what a Snellen acuity looks like instead.
    IF regexp_replace(v_text, '\s', '', 'g') !~ '^[0-9]+(\.[0-9]+)?/[0-9]+(\.[0-9]+)?$' THEN
      RAISE EXCEPTION 'A Snellen acuity is written as a fraction such as 6/18, and "%" is not one (OP-025 §5).',
        NEW.value USING ERRCODE = 'OP025';
    END IF;
    v_num := split_part(regexp_replace(v_text, '\s', '', 'g'), '/', 1)::numeric;
    v_den := split_part(regexp_replace(v_text, '\s', '', 'g'), '/', 2)::numeric;
    IF v_num <= 0 OR v_den <= 0 THEN
      RAISE EXCEPTION 'A Snellen acuity of "%" has a zero in it (OP-025 §5).',
        NEW.value USING ERRCODE = 'OP025';
    END IF;
    NEW.logmar := round(log(10, v_den / v_num), 2);
  END IF;

  IF NEW.logmar IS NOT NULL AND (NEW.logmar < -0.30 OR NEW.logmar > 3.00) THEN
    RAISE EXCEPTION 'A logMAR acuity of % is off the scale (OP-025 §5). -0.30 is better than 6/6; 3.00 is no perception of light.',
      NEW.logmar USING ERRCODE = 'OP025';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "logmar_is_derived_not_typed"
  BEFORE INSERT OR UPDATE ON "specialty"."ophtha_visual_acuity"
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_logmar();


-- ── §B.3  Dioptres in quarter steps, an axis from 1 to 180 ──────────────────
--
-- Every trial lens set, every phoropter and every grinding lab works in 0.25 D.
-- A sphere of -2.13 is a typo, and the person who finds it is the optician
-- after the patient has left.
ALTER TABLE "specialty"."ophtha_refractions"
  ADD CONSTRAINT "power_comes_in_quarter_steps"
  CHECK (("sph" IS NULL OR ("sph" * 4) = round("sph" * 4))
     AND ("cyl" IS NULL OR ("cyl" * 4) = round("cyl" * 4))
     AND ("add" IS NULL OR ("add" * 4) = round("add" * 4)));

ALTER TABLE "specialty"."ophtha_refractions"
  ADD CONSTRAINT "power_is_within_the_range_of_lenses"
  CHECK (("sph" IS NULL OR "sph" BETWEEN -30 AND 30)
     AND ("cyl" IS NULL OR "cyl" BETWEEN -12 AND 12)
     AND ("add" IS NULL OR "add" BETWEEN 0 AND 6));

-- Zero is written as 180: it is the same meridian, and two spellings of one
-- axis is one more thing a lab has to reconcile.
ALTER TABLE "specialty"."ophtha_refractions"
  ADD CONSTRAINT "axis_runs_one_to_one_eighty"
  CHECK (("axis" IS NULL OR "axis" BETWEEN 1 AND 180)
     AND ("k1_axis" IS NULL OR "k1_axis" BETWEEN 1 AND 180)
     AND ("k2_axis" IS NULL OR "k2_axis" BETWEEN 1 AND 180));

-- A cylinder without an axis is a lens that cannot be made.
ALTER TABLE "specialty"."ophtha_refractions"
  ADD CONSTRAINT "cylinder_names_its_axis"
  CHECK ("cyl" IS NULL OR "cyl" = 0 OR "axis" IS NOT NULL);

ALTER TABLE "specialty"."ophtha_refractions"
  ADD CONSTRAINT "refraction_source_is_known"
  CHECK ("source" IN ('device', 'manual'));

ALTER TABLE "specialty"."ophtha_iop_readings"
  ADD CONSTRAINT "pressure_is_physiological"
  CHECK ("value_mmhg" BETWEEN 0 AND 80
     AND ("corrected_mmhg" IS NULL OR "corrected_mmhg" BETWEEN 0 AND 80)
     AND ("cct_um" IS NULL OR "cct_um" BETWEEN 300 AND 800));

ALTER TABLE "specialty"."ophtha_exam_findings"
  ADD CONSTRAINT "cup_disc_ratio_is_a_ratio"
  CHECK ("cdr_vertical" IS NULL OR "cdr_vertical" BETWEEN 0 AND 1);


-- ── §B.4  A signed prescription is immutable ────────────────────────────────
--
-- It leaves the building. An optical shop, another hospital and sometimes a
-- licensing authority all read it, and a prescription that can be edited after
-- signing is one none of them can rely on. A change is a new prescription with
-- its own number.
CREATE OR REPLACE FUNCTION specialty.refuse_editing_a_signed_rx()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  IF NEW.lines        IS DISTINCT FROM OLD.lines
     OR NEW.pd_mono   IS DISTINCT FROM OLD.pd_mono
     OR NEW.pd_bino   IS DISTINCT FROM OLD.pd_bino
     OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
     OR NEW.signed_by IS DISTINCT FROM OLD.signed_by
     OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
     OR NEW.kind      IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'Prescription % is signed and cannot be changed (OP-025 §5). Issue a new one — an optical shop may already be grinding to this.',
      OLD.rx_no USING ERRCODE = 'OP025';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "signed_spectacle_rx_is_immutable"
  BEFORE UPDATE ON "specialty"."ophtha_spectacle_rx"
  FOR EACH ROW EXECUTE FUNCTION specialty.refuse_editing_a_signed_rx();

-- A prescription with no expiry is one an optical shop fills in three years'
-- time, on an eye that has changed. Twelve months by default, five at the most.
ALTER TABLE "specialty"."ophtha_spectacle_rx"
  ADD CONSTRAINT "prescription_expires"
  CHECK ("valid_until" > "signed_at"::date AND "valid_until" <= ("signed_at"::date + 1825));


-- ── §B.5  A lens is chosen from biometry ────────────────────────────────────
--
-- An intraocular lens power with no axial length behind it is a guess, and the
-- eye is not adjustable afterwards. The plan records the numbers and when they
-- were measured; how old is too old is a warning on the screen, because six
-- months is a convention and a stable eye is a stable eye.
CREATE OR REPLACE FUNCTION specialty.assert_iol_has_biometry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  IF NEW.iol_power IS NULL AND NEW.iol_model IS NULL THEN RETURN NEW; END IF;

  IF NEW.biometry IS NULL OR NEW.biometry_at IS NULL THEN
    RAISE EXCEPTION 'This plan names an intraocular lens with no biometry behind it (OP-025 §5). A power chosen without an axial length is a guess, and the eye is not adjustable afterwards.'
      USING ERRCODE = 'OP025';
  END IF;

  IF NEW.iol_power IS NOT NULL AND NEW.iol_formula IS NULL THEN
    RAISE EXCEPTION 'An intraocular lens power records the formula it came from (OP-025 §5). SRK/T, Barrett and Hoffer Q disagree by a dioptre in a short eye.'
      USING ERRCODE = 'OP025';
  END IF;

  IF NEW.biometry_at > now() THEN
    RAISE EXCEPTION 'The biometry is dated in the future (OP-025 §5).' USING ERRCODE = 'OP025';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "an_intraocular_lens_is_chosen_from_biometry"
  BEFORE INSERT OR UPDATE ON "specialty"."ophtha_surgery_plans"
  FOR EACH ROW EXECUTE FUNCTION specialty.assert_iol_has_biometry();

ALTER TABLE "specialty"."ophtha_surgery_plans"
  ADD CONSTRAINT "cancelled_plan_says_why"
  CHECK ("status" <> 'cancelled' OR ("cancel_reason" IS NOT NULL AND length(btrim("cancel_reason")) >= 4));

-- One live plan per eye per patient. Two open cataract plans for the right eye
-- is how a theatre list gets the wrong lens off the wrong plan.
CREATE UNIQUE INDEX "uq_one_live_plan_per_eye"
  ON "specialty"."ophtha_surgery_plans" ("hospital_id", "patient_id", "eye")
  WHERE "status" IN ('planned', 'counselled', 'booked');

-- Dilation is a medication event with a hazard attached: the patient must not
-- drive for hours, and in a narrow angle the drops can close it.
ALTER TABLE "specialty"."ophtha_visits"
  ADD CONSTRAINT "dilation_names_its_drug"
  CHECK ("dilated_at" IS NULL OR ("dilating_drug" IS NOT NULL AND length(btrim("dilating_drug")) > 0));

ALTER TABLE "specialty"."ophtha_visits"
  ADD CONSTRAINT "signed_visit_is_owned"
  CHECK (("signed_at" IS NULL) = ("signed_by" IS NULL));

COMMENT ON COLUMN "specialty"."ophtha_visual_acuity"."logmar" IS
  'Derived by a trigger from the notation and the value, never typed. A trend is worth plotting only if every point on it was converted the same way.';

COMMENT ON CONSTRAINT "power_comes_in_quarter_steps" ON "specialty"."ophtha_refractions" IS
  'Every trial set, phoropter and grinding lab works in 0.25 D. A sphere of -2.13 is a typo the optician finds after the patient has gone home.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'specialty' AND c.relkind IN ('r','p') AND c.relispartition = false
      AND c.relname LIKE 'ophtha\_%'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % OP-025 table(s)', v_count;
END $$;

-- A prescription that left the building and a plan the theatre is booked from
-- are not deleted. A prescription is superseded; a plan is cancelled with a
-- reason.
REVOKE DELETE ON "specialty"."ophtha_spectacle_rx"    FROM hms_app;
REVOKE DELETE ON "specialty"."ophtha_surgery_plans"   FROM hms_app;


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
      AND c.relname NOT IN ('cdss_safety_floor','console_components')
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
  WHERE n.nspname = 'specialty' AND c.relname LIKE 'ophtha\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'OP-025 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;
