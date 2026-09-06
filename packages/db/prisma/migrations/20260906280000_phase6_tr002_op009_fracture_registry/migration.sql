-- ═════════════════════════════════════════════════════════════════════════════
-- TR-002 + OP-009 — the fracture registry and the orthopaedic OPD
--
-- `phase-06` §6.7, exit gate 7. Twelve tables in `clinical`.
--
-- ── §B.1 is the reason this module has a database opinion at all ────────────
--
-- Wrong-site surgery in orthopaedics is nearly always a laterality error that
-- survived four handoffs: the note says left, the imaging order says right, the
-- consent says left, the theatre list says right, and four people each assumed
-- one of the others had checked. Every one of those documents is written by a
-- different module.
--
-- So `side` is NOT NULL, `bilateral` does not exist as a value — two limbs are
-- two entries, because a plan, a cast and an implant each belong to one of them
-- — and a plan whose side disagrees with its fracture is refused by the
-- database rather than by whoever is reading the screen.
--
--   §B.1  A plan is for the same side as its fracture.
--   §B.2  An open fracture is confirmed only with a Gustilo grade.
--   §B.3  The antibiotic clock runs from arrival, and the breach is recorded.
--   §B.4  Non-union before six months needs a surgeon's stated grounds.
--   §B.5  Union needs a film that says united, or a stated clinical reason.
--   §B.6  A version snapshot is append-only.
--   §B.7  AO/OTA components stay inside the classification's own ranges.
--   §B.8  A follow-up offset is measured forward from the anchor.
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "clinical"."FractureSide" AS ENUM ('left', 'right', 'midline', 'not_applicable');

-- CreateEnum
CREATE TYPE "clinical"."GustiloGrade" AS ENUM ('I', 'II', 'IIIA', 'IIIB', 'IIIC');

-- CreateEnum
CREATE TYPE "clinical"."SalterHarris" AS ENUM ('I', 'II', 'III', 'IV', 'V');

-- CreateEnum
CREATE TYPE "clinical"."FractureAetiology" AS ENUM ('traumatic', 'pathological', 'osteoporotic', 'stress', 'periprosthetic', 'iatrogenic');

-- CreateEnum
CREATE TYPE "clinical"."ClassificationStatus" AS ENUM ('provisional', 'confirmed');

-- CreateEnum
CREATE TYPE "clinical"."FractureStatus" AS ENUM ('open', 'united', 'closed_other', 'reopened');

-- CreateEnum
CREATE TYPE "clinical"."TreatmentIntent" AS ENUM ('conservative', 'closed_reduction_cast', 'percutaneous_pinning', 'orif', 'im_nail', 'external_fixation', 'arthroplasty', 'amputation', 'traction', 'observation');

-- CreateEnum
CREATE TYPE "clinical"."WeightBearing" AS ENUM ('nwb', 'ttwb', 'pwb', 'wbat', 'fwb');

-- CreateEnum
CREATE TYPE "clinical"."FractureEventKind" AS ENUM ('diagnosed', 'reduction', 'surgery', 'cast_applied', 'cast_changed', 'cast_removed', 'exfix_applied', 'exfix_removed', 'pin_site_care', 'wound_event', 'imaging', 'physio_milestone', 'complication', 'union', 'hardware_removal', 'reopened', 'closed', 'note');

-- CreateEnum
CREATE TYPE "clinical"."UnionStatus" AS ENUM ('not_united', 'progressing', 'united', 'delayed', 'nonunion');

-- CreateEnum
CREATE TYPE "clinical"."FractureComplicationKind" AS ENUM ('infection', 'nonunion', 'malunion', 'delayed_union', 'compartment_syndrome', 'neurovascular_injury', 'implant_failure', 'stiffness', 'avascular_necrosis', 'dvt', 'fat_embolism', 'refracture', 'other');

-- AlterTable

-- CreateTable
CREATE TABLE "clinical"."fx_fractures" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "er_visit_id" UUID,
    "admission_id" UUID,
    "trauma_injury_id" UUID,
    "ortho_episode_id" UUID,
    "bone_code" VARCHAR(40) NOT NULL,
    "bone_display" VARCHAR(120) NOT NULL,
    "ao_bone" INTEGER,
    "ao_segment" INTEGER,
    "ao_type" CHAR(1),
    "ao_group" INTEGER,
    "ao_subgroup" INTEGER,
    "ao_qualifiers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ao_code" VARCHAR(24),
    "ao_version" VARCHAR(8) NOT NULL DEFAULT '2018',
    "side" "clinical"."FractureSide" NOT NULL,
    "is_open" BOOLEAN NOT NULL DEFAULT false,
    "gustilo" "clinical"."GustiloGrade",
    "tscherne" VARCHAR(4),
    "paediatric" BOOLEAN NOT NULL DEFAULT false,
    "salter_harris" "clinical"."SalterHarris",
    "aetiology" "clinical"."FractureAetiology" NOT NULL DEFAULT 'traumatic',
    "periprosthetic_class" VARCHAR(24),
    "dislocation" BOOLEAN NOT NULL DEFAULT false,
    "associated" JSONB,
    "regional_classification" JSONB,
    "icd10" VARCHAR(12),
    "mechanism" JSONB,
    "injury_at" TIMESTAMPTZ(6),
    "injury_at_estimated" BOOLEAN NOT NULL DEFAULT false,
    "diagnosed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "diagnosed_by" UUID,
    "classification_status" "clinical"."ClassificationStatus" NOT NULL DEFAULT 'provisional',
    "confirmed_by" UUID,
    "confirmed_at" TIMESTAMPTZ(6),
    "cosign_required" BOOLEAN NOT NULL DEFAULT false,
    "cosigned_by" UUID,
    "cosigned_at" TIMESTAMPTZ(6),
    "is_mlc" BOOLEAN NOT NULL DEFAULT false,
    "mlc_id" UUID,
    "status" "clinical"."FractureStatus" NOT NULL DEFAULT 'open',
    "union_at" TIMESTAMPTZ(6),
    "time_to_union_weeks" DECIMAL(4,1),
    "closed_reason" VARCHAR(32),
    "closed_at" TIMESTAMPTZ(6),
    "nonunion_override_by" UUID,
    "nonunion_override_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fx_fractures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."fx_versions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "fracture_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changed_by" UUID,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,

    CONSTRAINT "fx_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."fx_plans" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "fracture_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "intent" "clinical"."TreatmentIntent" NOT NULL,
    "damage_control" BOOLEAN NOT NULL DEFAULT false,
    "urgency" VARCHAR(16) NOT NULL DEFAULT 'elective',
    "side" "clinical"."FractureSide" NOT NULL,
    "planned_procedure_code" VARCHAR(40),
    "planned_implant_family" VARCHAR(120),
    "planned_date" TIMESTAMPTZ(6),
    "ot_request_id" UUID,
    "weight_bearing" "clinical"."WeightBearing" NOT NULL DEFAULT 'nwb',
    "pwb_pct" INTEGER,
    "wb_review_date" DATE,
    "rom_restrictions" TEXT,
    "dvt_prophylaxis" BOOLEAN NOT NULL DEFAULT false,
    "consent_doc_ref" VARCHAR(300),
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "set_by" UUID,
    "set_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."fx_events" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "fracture_id" UUID NOT NULL,
    "kind" "clinical"."FractureEventKind" NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id" UUID,
    "ref_type" VARCHAR(32),
    "ref_id" UUID,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."fx_xray_timeline" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "fracture_id" UUID NOT NULL,
    "study_uid" VARCHAR(120),
    "study_id" UUID,
    "label" VARCHAR(24) NOT NULL,
    "taken_at" TIMESTAMPTZ(6) NOT NULL,
    "weeks_since_injury" DECIMAL(5,1),
    "weeks_since_surgery" DECIMAL(5,1),
    "auto_attached" BOOLEAN NOT NULL DEFAULT false,
    "attached_by" UUID,
    "is_key_image" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_xray_timeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."fx_imaging_findings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "fracture_id" UUID NOT NULL,
    "film_id" UUID NOT NULL,
    "assessed_by" UUID,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "angulation_deg" DECIMAL(4,1),
    "translation_pct" INTEGER,
    "shortening_mm" INTEGER,
    "rotation_deg" DECIMAL(4,1),
    "rust_score" INTEGER,
    "mrust_score" INTEGER,
    "alignment_maintained" BOOLEAN,
    "implant_status" VARCHAR(16),
    "joint_congruity" VARCHAR(16),
    "union_status" "clinical"."UnionStatus" NOT NULL DEFAULT 'not_united',
    "notes" TEXT,

    CONSTRAINT "fx_imaging_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."fx_complications" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "fracture_id" UUID NOT NULL,
    "kind" "clinical"."FractureComplicationKind" NOT NULL,
    "onset_at" TIMESTAMPTZ(6) NOT NULL,
    "detected_by" UUID,
    "severity" VARCHAR(16) NOT NULL DEFAULT 'moderate',
    "clavien_dindo" VARCHAR(8),
    "management" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_complications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."fx_open_bundle" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "fracture_id" UUID NOT NULL,
    "arrived_at" TIMESTAMPTZ(6) NOT NULL,
    "antibiotic_at" TIMESTAMPTZ(6),
    "tetanus_at" TIMESTAMPTZ(6),
    "photo_at" TIMESTAMPTZ(6),
    "dressing_at" TIMESTAMPTZ(6),
    "splint_at" TIMESTAMPTZ(6),
    "debridement_at" TIMESTAMPTZ(6),
    "plastics_referral_at" TIMESTAMPTZ(6),
    "definitive_cover_at" TIMESTAMPTZ(6),
    "breaches" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fx_open_bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ortho_episodes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "anchor_kind" VARCHAR(16) NOT NULL DEFAULT 'injury',
    "anchor_at" TIMESTAMPTZ(6) NOT NULL,
    "presenting_complaint" TEXT,
    "xray_first" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ortho_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ortho_exams" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id" UUID,
    "rom" JSONB NOT NULL DEFAULT '[]',
    "neurovascular" JSONB,
    "specialTests" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ortho_exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ortho_followups" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "fracture_id" UUID,
    "protocol_key" VARCHAR(60) NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "offset_weeks" DECIMAL(4,1) NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "actions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" VARCHAR(16) NOT NULL DEFAULT 'due',
    "completed_at" TIMESTAMPTZ(6),
    "appointment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ortho_followups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ortho_proms" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "fracture_id" UUID,
    "instrument" VARCHAR(40) NOT NULL,
    "at_weeks" DECIMAL(4,1) NOT NULL,
    "responses" JSONB NOT NULL,
    "score" DECIMAL(6,2),
    "score_max" DECIMAL(6,2),
    "higher_is_better" BOOLEAN NOT NULL DEFAULT true,
    "collected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collected_by" UUID,

    CONSTRAINT "ortho_proms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "fx_fractures_hospital_id_patient_id_status_idx" ON "clinical"."fx_fractures"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "fx_fractures_hospital_id_diagnosed_at_idx" ON "clinical"."fx_fractures"("hospital_id", "diagnosed_at" DESC);

-- CreateIndex
CREATE INDEX "fx_fractures_hospital_id_ao_bone_ao_segment_ao_type_idx" ON "clinical"."fx_fractures"("hospital_id", "ao_bone", "ao_segment", "ao_type");

-- CreateIndex
CREATE INDEX "fx_fractures_hospital_id_is_open_gustilo_idx" ON "clinical"."fx_fractures"("hospital_id", "is_open", "gustilo");

-- CreateIndex
CREATE INDEX "fx_versions_hospital_id_fracture_id_version_idx" ON "clinical"."fx_versions"("hospital_id", "fracture_id", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_fracture_version" ON "clinical"."fx_versions"("fracture_id", "version");

-- CreateIndex
CREATE INDEX "fx_plans_hospital_id_fracture_id_is_current_idx" ON "clinical"."fx_plans"("hospital_id", "fracture_id", "is_current");

-- CreateIndex
CREATE UNIQUE INDEX "uq_fracture_plan_version" ON "clinical"."fx_plans"("fracture_id", "version");

-- CreateIndex
CREATE INDEX "fx_events_hospital_id_fracture_id_at_idx" ON "clinical"."fx_events"("hospital_id", "fracture_id", "at");

-- CreateIndex
CREATE INDEX "fx_xray_timeline_hospital_id_fracture_id_taken_at_idx" ON "clinical"."fx_xray_timeline"("hospital_id", "fracture_id", "taken_at");

-- CreateIndex
CREATE INDEX "fx_imaging_findings_hospital_id_fracture_id_assessed_at_idx" ON "clinical"."fx_imaging_findings"("hospital_id", "fracture_id", "assessed_at" DESC);

-- CreateIndex
CREATE INDEX "fx_complications_hospital_id_fracture_id_onset_at_idx" ON "clinical"."fx_complications"("hospital_id", "fracture_id", "onset_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "fx_open_bundle_fracture_id_key" ON "clinical"."fx_open_bundle"("fracture_id");

-- CreateIndex
CREATE INDEX "fx_open_bundle_hospital_id_fracture_id_idx" ON "clinical"."fx_open_bundle"("hospital_id", "fracture_id");

-- CreateIndex
CREATE INDEX "ortho_episodes_hospital_id_patient_id_status_idx" ON "clinical"."ortho_episodes"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "ortho_episodes_hospital_id_branch_id_opened_at_idx" ON "clinical"."ortho_episodes"("hospital_id", "branch_id", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "ortho_exams_hospital_id_episode_id_at_idx" ON "clinical"."ortho_exams"("hospital_id", "episode_id", "at" DESC);

-- CreateIndex
CREATE INDEX "ortho_followups_hospital_id_status_due_at_idx" ON "clinical"."ortho_followups"("hospital_id", "status", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ortho_followup_offset" ON "clinical"."ortho_followups"("episode_id", "protocol_key", "offset_weeks");

-- CreateIndex
CREATE INDEX "ortho_proms_hospital_id_episode_id_instrument_at_weeks_idx" ON "clinical"."ortho_proms"("hospital_id", "episode_id", "instrument", "at_weeks");

-- AddForeignKey
ALTER TABLE "clinical"."fx_versions" ADD CONSTRAINT "fx_versions_fracture_id_fkey" FOREIGN KEY ("fracture_id") REFERENCES "clinical"."fx_fractures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."fx_plans" ADD CONSTRAINT "fx_plans_fracture_id_fkey" FOREIGN KEY ("fracture_id") REFERENCES "clinical"."fx_fractures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."fx_events" ADD CONSTRAINT "fx_events_fracture_id_fkey" FOREIGN KEY ("fracture_id") REFERENCES "clinical"."fx_fractures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."fx_xray_timeline" ADD CONSTRAINT "fx_xray_timeline_fracture_id_fkey" FOREIGN KEY ("fracture_id") REFERENCES "clinical"."fx_fractures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."fx_imaging_findings" ADD CONSTRAINT "fx_imaging_findings_film_id_fkey" FOREIGN KEY ("film_id") REFERENCES "clinical"."fx_xray_timeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."fx_complications" ADD CONSTRAINT "fx_complications_fracture_id_fkey" FOREIGN KEY ("fracture_id") REFERENCES "clinical"."fx_fractures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."fx_open_bundle" ADD CONSTRAINT "fx_open_bundle_fracture_id_fkey" FOREIGN KEY ("fracture_id") REFERENCES "clinical"."fx_fractures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ortho_exams" ADD CONSTRAINT "ortho_exams_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "clinical"."ortho_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ortho_followups" ADD CONSTRAINT "ortho_followups_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "clinical"."ortho_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ortho_proms" ADD CONSTRAINT "ortho_proms_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "clinical"."ortho_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §A.2  ROW-LEVEL SECURITY
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
  WHERE n.nspname = 'clinical' AND (c.relname LIKE 'fx\_%' OR c.relname LIKE 'ortho\_%')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'TR-002/OP-009 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  A plan is for the same limb as the fracture ───────────────────────
--
-- The wrong-site rule. A plan carries its own `side` so this comparison exists
-- to be made — storing the side once and joining would make the mismatch
-- unrepresentable *and* unnoticeable, and the whole problem is that four
-- documents disagree. Here they are forced to agree at the moment the second
-- one is written.
CREATE OR REPLACE FUNCTION clinical.assert_plan_side_matches_fracture()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_fracture record;
BEGIN
  SELECT side, bone_display INTO v_fracture FROM clinical.fx_fractures WHERE id = NEW.fracture_id;

  IF v_fracture.side IS DISTINCT FROM NEW.side THEN
    RAISE EXCEPTION 'This plan is for the % side and the % fracture is on the % (TR-002 §B.1). A laterality disagreement between the record and the plan is how a wrong-site operation starts — reconcile them before going further.',
      NEW.side, v_fracture.bone_display, v_fracture.side
      USING ERRCODE = 'TR002';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "fracture_plan_is_for_the_same_limb"
  BEFORE INSERT OR UPDATE ON "clinical"."fx_plans"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_plan_side_matches_fracture();

-- ── §B.2  An open fracture is confirmed only with a Gustilo grade ───────────
--
-- The grade drives the antibiotic regimen and decides whether plastics are
-- called. Confirming the classification without it signs off a fracture whose
-- treatment nobody can derive.
ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "confirmed_open_fracture_is_graded"
  CHECK (
    "classification_status" <> 'confirmed'
    OR NOT "is_open"
    OR "gustilo" IS NOT NULL
  );

ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "gustilo_is_for_open_fractures"
  CHECK ("gustilo" IS NULL OR "is_open");

ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "confirmation_is_owned"
  CHECK (
    "classification_status" <> 'confirmed'
    OR ("confirmed_by" IS NOT NULL AND "confirmed_at" IS NOT NULL)
  );

-- Salter-Harris is a physeal classification: it applies to a growing skeleton.
-- On an adult it is a miscode, and it changes the treatment.
ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "salter_harris_is_paediatric"
  CHECK ("salter_harris" IS NULL OR "paediatric");

-- ── §B.4  Non-union has a definition, and six months is part of it ──────────
--
-- Declaring it early converts a fracture that was going to heal into an
-- operation. A surgeon may still do it — established radiological non-union is
-- a real finding before six months — but the grounds go on the record.
ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "nonunion_override_is_owned_and_reasoned"
  CHECK (
    ("nonunion_override_by" IS NULL AND "nonunion_override_reason" IS NULL)
    OR ("nonunion_override_by" IS NOT NULL
        AND "nonunion_override_reason" IS NOT NULL
        AND length(btrim("nonunion_override_reason")) >= 12)
  );

-- ── §B.5  A united fracture has a time to union ─────────────────────────────
ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "united_fracture_has_a_union_date"
  CHECK ("status" <> 'united' OR "union_at" IS NOT NULL);

ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "union_is_after_injury"
  CHECK ("union_at" IS NULL OR "injury_at" IS NULL OR "union_at" >= "injury_at");

ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "closed_fracture_says_why"
  CHECK ("status" <> 'closed_other' OR "closed_reason" IS NOT NULL);

-- ── §B.7  AO/OTA components stay inside the classification ──────────────────
--
-- Bone 1–9, segment 1–4, type A/B/C, group and subgroup 1–3. A code outside
-- those ranges renders as something like `32-Q7.9`, which no registry accepts
-- and no surgeon recognises.
ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "ao_components_in_range"
  CHECK (
    ("ao_bone" IS NULL OR "ao_bone" BETWEEN 1 AND 9)
    AND ("ao_segment" IS NULL OR "ao_segment" BETWEEN 1 AND 4)
    AND ("ao_type" IS NULL OR "ao_type" IN ('A', 'B', 'C'))
    AND ("ao_group" IS NULL OR "ao_group" BETWEEN 1 AND 3)
    AND ("ao_subgroup" IS NULL OR "ao_subgroup" BETWEEN 1 AND 3)
  );

-- A group without a type, or a subgroup without a group, is a half-built code.
ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "ao_code_is_built_in_order"
  CHECK (
    ("ao_group" IS NULL OR "ao_type" IS NOT NULL)
    AND ("ao_subgroup" IS NULL OR "ao_group" IS NOT NULL)
    AND ("ao_type" IS NULL OR ("ao_bone" IS NOT NULL AND "ao_segment" IS NOT NULL))
  );

-- A registry export needs the code to at least type level, which is the point
-- at which it means something clinically.
ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "confirmed_fracture_is_classified_to_type"
  CHECK ("classification_status" <> 'confirmed' OR "ao_type" IS NOT NULL);

ALTER TABLE "clinical"."fx_fractures"
  ADD CONSTRAINT "fracture_version_starts_at_one"
  CHECK ("version" >= 1);

-- ── §B.6  A version snapshot is append-only ─────────────────────────────────
--
-- The point of keeping "the classification used to say 32-A1" is that somebody
-- can be asked why it changed. A snapshot that can be edited answers nothing.
CREATE OR REPLACE FUNCTION clinical.refuse_fracture_version_rewrite()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  RAISE EXCEPTION 'fx_versions is append-only (TR-002 §B.6). A snapshot that can be edited is not a record of what the classification used to say.'
    USING ERRCODE = 'TR002';
END $$;

CREATE TRIGGER "fracture_versions_are_append_only"
  BEFORE UPDATE OR DELETE ON "clinical"."fx_versions"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_fracture_version_rewrite();

-- ── §B.3  The antibiotic clock ──────────────────────────────────────────────
--
-- Recomputed on every write of the bundle and *stored*, so the breach survives
-- somebody re-dating the diagnosis. The target is sixty minutes from arrival;
-- the debridement window is twenty-four hours; a Gustilo IIIB or IIIC needs
-- plastics involved.
CREATE OR REPLACE FUNCTION clinical.recompute_open_fracture_breaches()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE
  v_breaches text[] := ARRAY[]::text[];
  v_grade text;
BEGIN
  SELECT gustilo::text INTO v_grade FROM clinical.fx_fractures WHERE id = NEW.fracture_id;

  IF NEW.antibiotic_at IS NULL THEN
    v_breaches := array_append(v_breaches, 'no antibiotic recorded');
  ELSIF NEW.antibiotic_at > NEW.arrived_at + interval '60 minutes' THEN
    v_breaches := array_append(
      v_breaches,
      format('antibiotic at %s minutes from arrival (target 60)',
             round(extract(epoch FROM NEW.antibiotic_at - NEW.arrived_at) / 60)));
  END IF;

  IF NEW.tetanus_at IS NULL THEN
    v_breaches := array_append(v_breaches, 'no tetanus prophylaxis recorded');
  END IF;

  IF NEW.debridement_at IS NOT NULL
     AND NEW.debridement_at > NEW.arrived_at + interval '24 hours' THEN
    v_breaches := array_append(
      v_breaches,
      format('debridement at %s hours from arrival (target 24)',
             round(extract(epoch FROM NEW.debridement_at - NEW.arrived_at) / 3600)));
  END IF;

  IF v_grade IN ('IIIB', 'IIIC') AND NEW.plastics_referral_at IS NULL THEN
    v_breaches := array_append(v_breaches, format('Gustilo %s with no plastics referral', v_grade));
  END IF;

  NEW.breaches := v_breaches;
  RETURN NEW;
END $$;

CREATE TRIGGER "open_fracture_breaches_are_recomputed"
  BEFORE INSERT OR UPDATE ON "clinical"."fx_open_bundle"
  FOR EACH ROW EXECUTE FUNCTION clinical.recompute_open_fracture_breaches();

-- The bundle belongs to an open fracture. Attaching one to a closed injury
-- would put a fictitious antibiotic breach into the indicator.
CREATE OR REPLACE FUNCTION clinical.assert_bundle_is_for_an_open_fracture()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_open boolean;
BEGIN
  SELECT is_open INTO v_open FROM clinical.fx_fractures WHERE id = NEW.fracture_id;
  IF NOT v_open THEN
    RAISE EXCEPTION 'The open-fracture bundle is for an open fracture (TR-002 §B.3). This one is recorded as closed.'
      USING ERRCODE = 'TR002';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "open_bundle_needs_an_open_fracture"
  BEFORE INSERT ON "clinical"."fx_open_bundle"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_bundle_is_for_an_open_fracture();

-- ── Imaging and findings ────────────────────────────────────────────────────

-- RUST is 4–12 across four cortices; mRUST is 4–16. Out of range is a typo, and
-- a typo here moves a union decision.
ALTER TABLE "clinical"."fx_imaging_findings"
  ADD CONSTRAINT "union_scores_in_range"
  CHECK (
    ("rust_score" IS NULL OR "rust_score" BETWEEN 4 AND 12)
    AND ("mrust_score" IS NULL OR "mrust_score" BETWEEN 4 AND 16)
  );

ALTER TABLE "clinical"."fx_imaging_findings"
  ADD CONSTRAINT "displacement_measures_are_sane"
  CHECK (
    ("translation_pct" IS NULL OR "translation_pct" BETWEEN 0 AND 100)
    AND ("shortening_mm" IS NULL OR "shortening_mm" >= 0)
    AND ("angulation_deg" IS NULL OR "angulation_deg" BETWEEN 0 AND 180)
  );

-- A film taken before the injury is on the wrong patient or the wrong date, and
-- either way it must not join a healing timeline.
CREATE OR REPLACE FUNCTION clinical.assert_film_is_after_the_injury()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_injury timestamptz;
BEGIN
  SELECT injury_at INTO v_injury FROM clinical.fx_fractures WHERE id = NEW.fracture_id;

  -- A day's grace: an injury time is often estimated, and a film taken at
  -- 23:50 on a fracture recorded as "the next morning" is a real sequence.
  IF v_injury IS NOT NULL AND NEW.taken_at < v_injury - interval '1 day' THEN
    RAISE EXCEPTION 'This film was taken % before the injury (TR-002). It belongs to a different episode, or one of the two dates is wrong.',
      justify_interval(v_injury - NEW.taken_at)
      USING ERRCODE = 'TR002';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "fracture_film_follows_the_injury"
  BEFORE INSERT ON "clinical"."fx_xray_timeline"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_film_is_after_the_injury();

-- ── §B.8  Follow-up offsets run forward ─────────────────────────────────────
ALTER TABLE "clinical"."ortho_followups"
  ADD CONSTRAINT "followup_offset_runs_forward"
  CHECK ("offset_weeks" >= 0);

ALTER TABLE "clinical"."ortho_followups"
  ADD CONSTRAINT "completed_followup_has_a_time"
  CHECK ("status" <> 'completed' OR "completed_at" IS NOT NULL);

ALTER TABLE "clinical"."ortho_episodes"
  ADD CONSTRAINT "ortho_anchor_is_known"
  CHECK ("anchor_kind" IN ('injury', 'surgery', 'first_visit'));

-- A PROM's direction is part of its definition. Recording a DASH as
-- higher-is-better turns a deteriorating patient into an improving line on a
-- dashboard, which is the one error nobody catches by eye.
ALTER TABLE "clinical"."ortho_proms"
  ADD CONSTRAINT "prom_score_within_its_scale"
  CHECK ("score" IS NULL OR "score_max" IS NULL OR ("score" >= 0 AND "score" <= "score_max"));

ALTER TABLE "clinical"."ortho_proms"
  ADD CONSTRAINT "prom_offset_runs_forward"
  CHECK ("at_weeks" >= 0);


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
      AND c.relname NOT LIKE '\_prisma%'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % TR-002/OP-009 table(s)', v_count;
END $$;

REVOKE UPDATE, DELETE ON "clinical"."fx_versions" FROM hms_app;
REVOKE DELETE          ON "clinical"."fx_fractures" FROM hms_app;

COMMENT ON COLUMN "clinical"."fx_plans"."side" IS
  'Carried on the plan as well as the fracture so the two can be compared. Storing it once would make a laterality mismatch unrepresentable and unnoticeable — and the problem being solved is that four documents written by four modules disagree.';

COMMENT ON COLUMN "clinical"."fx_open_bundle"."arrived_at" IS
  'What the sixty-minute antibiotic target is measured from. Stored rather than looked up, so the breach cannot be argued away by re-dating the diagnosis.';

COMMENT ON COLUMN "clinical"."ortho_proms"."higher_is_better" IS
  'Part of the instrument''s definition. Oxford scores rise with improvement, DASH falls — a dashboard that gets it backwards reports a deteriorating patient as recovering.';
