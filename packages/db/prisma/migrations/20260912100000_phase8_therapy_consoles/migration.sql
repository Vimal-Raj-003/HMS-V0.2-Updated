-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-015 · OP-017 · OP-011 · OP-035 — the therapy consoles
-- One episode, one goal, one session, four disciplines
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Physiotherapy, wound care, dietetics and speech and swallow are four
-- different clinical worlds with one administrative shape: somebody is
-- referred, somebody assesses them, a plan is written with goals on it, and
-- then the same twenty minutes happens twice a week for eight weeks.
--
-- What differs is the assessment and the plan. What does not differ is the
-- episode, the goal, the session and the bill — so those live once, in
-- `therapy_*`, and each console brings only its own clinical content. A fourth
-- copy of "a course of sessions" would be four places to fix the day somebody
-- notices sessions are being billed twice.
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
--  1. A session is delivered against a *live plan* on a *live episode*, and a
--     plan exists only behind a signed assessment. Treatment before assessment
--     is the finding in every physiotherapy audit ever written, and it is not
--     carelessness — it is a busy department starting the exercises while the
--     paperwork catches up. The result is a course nobody can justify when the
--     insurer asks.
--
--  2. A session is billed once. A partial unique index on the charge intent,
--     because therapy is the one place in a hospital where the same short act
--     repeats forty times against one authorisation and a duplicate is
--     invisible in a list of forty identical rows.
--
--  3. Sessions delivered do not exceed sessions authorised. A package of ten
--     that delivered fourteen is either fraud or four hours of unpaid work, and
--     which one depends entirely on whether somebody extended it. So extending
--     is an act with a name and a reason, and the eleventh session waits.
--
--  4. A goal carries a metric, a baseline and a target, and every active goal
--     is resolved before the episode discharges. "Improve mobility" is a
--     sentiment; an outcome report over sentiments is empty.
--
--  5. Wound area is π/4 × length × width, and the reduction is against the
--     first assessment. Both derived: a wound clinic's entire referral logic is
--     a threshold on the second one, and a percentage somebody typed is a
--     percentage that agrees with whatever the clinic hoped.
--
--  6. A wound is `healed` only with a closing assessment that measures zero. A
--     wound closed on the record while the last measurement says 4 cm² is a
--     district nurse arriving to a discharged patient with an open ulcer.
--
--  7. A wound bed's tissue percentages total 100. Sixty per cent granulation
--     and sixty per cent slough is a description of two wounds.
--
--  8. A diet plan's totals are summed from its meals, and a plan whose meals
--     exceed its own restriction is refused by nutrient and by amount. A renal
--     plan 1,100 mg over on potassium is the most consequential arithmetic
--     error in outpatient dietetics, and nothing but a sum will find it.
--
--  9. An IDDSI swallow order names a food level (3–7) *and* a fluid level
--     (0–4), or it is nil-by-mouth and names neither. The numbers overlap
--     without meaning the same thing, and a kitchen reading one for the other
--     sends a tray that can kill somebody.
--
-- 10. A swallow order is not in force until the kitchen and the ward have
--     acknowledged it, and one patient has one live order. Two live orders is a
--     ward with two answers to "what can this person eat", and the one they act
--     on is whichever they happened to read.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATEs: OP015, OP017, OP011, OP035.
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "mdm"."VegClass" AS ENUM ('veg', 'egg', 'non_veg', 'vegan');

-- CreateEnum
CREATE TYPE "specialty"."MalnutritionClass" AS ENUM ('none', 'moderate', 'severe');

-- CreateEnum
CREATE TYPE "specialty"."DietPlanStatus" AS ENUM ('draft', 'active', 'superseded', 'closed');

-- CreateEnum
CREATE TYPE "specialty"."SlpDomain" AS ENUM ('swallow', 'articulation', 'language', 'voice', 'fluency', 'motor_speech', 'cognitive_communication', 'aac');

-- CreateEnum
CREATE TYPE "specialty"."SwallowOrderStatus" AS ENUM ('pending', 'active', 'superseded', 'cancelled');

-- CreateEnum
CREATE TYPE "specialty"."TherapyDiscipline" AS ENUM ('physio', 'wound', 'nutrition', 'speech');

-- CreateEnum
CREATE TYPE "specialty"."TherapyEpisodeStatus" AS ENUM ('triaged', 'assessing', 'active', 'on_hold', 'discharged');

-- CreateEnum
CREATE TYPE "specialty"."TherapyPlanStatus" AS ENUM ('draft', 'active', 'superseded', 'completed', 'on_hold');

-- CreateEnum
CREATE TYPE "specialty"."TherapyGoalStatus" AS ENUM ('active', 'met', 'partially_met', 'not_met', 'revised', 'discontinued');

-- CreateEnum
CREATE TYPE "specialty"."TherapySessionStatus" AS ENUM ('scheduled', 'attended', 'no_show', 'cancelled');

-- CreateEnum
CREATE TYPE "specialty"."TherapySetting" AS ENUM ('op', 'ip', 'icu', 'tele', 'home');

-- CreateEnum
CREATE TYPE "specialty"."WoundAetiology" AS ENUM ('pressure', 'diabetic_foot', 'venous', 'arterial', 'mixed_ulcer', 'traumatic', 'surgical', 'ssi', 'burn', 'malignant', 'other');

-- CreateEnum
CREATE TYPE "specialty"."WoundStatus" AS ENUM ('open', 'healing', 'stalled', 'deteriorating', 'healed', 'amputated', 'deceased', 'lost_to_followup');

-- CreateEnum
CREATE TYPE "specialty"."WoundTrajectory" AS ENUM ('on_track', 'stalled', 'deteriorating');

-- CreateTable
CREATE TABLE "mdm"."food_items" (
    "id" UUID NOT NULL,
    "hospital_id" UUID,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "local_names" JSONB NOT NULL DEFAULT '{}',
    "food_group" VARCHAR(40) NOT NULL,
    "per_100g" JSONB NOT NULL,
    "allergens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "veg_class" "mdm"."VegClass" NOT NULL,
    "portion_units" JSONB NOT NULL DEFAULT '[]',
    "cost_per_100g" DECIMAL(10,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "food_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."nutrition_assessments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "episode_id" UUID,
    "encounter_id" UUID,
    "admission_id" UUID,
    "dietician_id" UUID NOT NULL,
    "anthropometry" JSONB NOT NULL DEFAULT '{}',
    "bmi" DECIMAL(5,2),
    "weight_loss_pct_3m" DECIMAL(5,2),
    "bmr" INTEGER,
    "tdee" INTEGER,
    "requirements" JSONB NOT NULL DEFAULT '{}',
    "recall_24h" JSONB NOT NULL DEFAULT '{}',
    "intake_totals" JSONB NOT NULL DEFAULT '{}',
    "gap_analysis" JSONB NOT NULL DEFAULT '{}',
    "malnutrition_class" "specialty"."MalnutritionClass" NOT NULL DEFAULT 'none',
    "sga" CHAR(1),
    "nrs2002" INTEGER,
    "pes_statement" TEXT,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "food_allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "form_response_id" UUID,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "nutrition_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."diet_plans" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "meals" JSONB NOT NULL DEFAULT '[]',
    "totals" JSONB NOT NULL DEFAULT '{}',
    "kcal_target" INTEGER,
    "macro_targets" JSONB NOT NULL DEFAULT '{}',
    "restrictions" JSONB NOT NULL DEFAULT '{}',
    "supplements" JSONB NOT NULL DEFAULT '[]',
    "instructions" TEXT,
    "cost_per_day" DECIMAL(10,2),
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "status" "specialty"."DietPlanStatus" NOT NULL DEFAULT 'draft',
    "document_id" UUID,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "diet_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."slp_assessments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "encounter_id" UUID,
    "domains" "specialty"."SlpDomain"[],
    "kind" VARCHAR(24) NOT NULL,
    "tools" JSONB NOT NULL DEFAULT '[]',
    "swallow" JSONB NOT NULL DEFAULT '{}',
    "voice" JSONB NOT NULL DEFAULT '{}',
    "fluency" JSONB NOT NULL DEFAULT '{}',
    "language" JSONB NOT NULL DEFAULT '{}',
    "articulation" JSONB NOT NULL DEFAULT '{}',
    "severity" VARCHAR(24),
    "dx_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "report_doc_id" UUID,
    "form_response_id" UUID,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "slp_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."slp_swallow_orders" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "admission_id" UUID,
    "npo" BOOLEAN NOT NULL DEFAULT false,
    "food_level" INTEGER,
    "fluid_level" INTEGER,
    "strategies" JSONB NOT NULL DEFAULT '{}',
    "status" "specialty"."SwallowOrderStatus" NOT NULL DEFAULT 'pending',
    "effective_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "ordered_by" UUID NOT NULL,
    "ack_kitchen_by" UUID,
    "ack_kitchen_at" TIMESTAMPTZ(6),
    "ack_ward_by" UUID,
    "ack_ward_at" TIMESTAMPTZ(6),
    "change_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "slp_swallow_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."therapy_episodes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "discipline" "specialty"."TherapyDiscipline" NOT NULL,
    "setting" "specialty"."TherapySetting" NOT NULL DEFAULT 'op',
    "referral_id" UUID,
    "source" VARCHAR(16) NOT NULL DEFAULT 'opd',
    "referring_doctor_id" UUID,
    "diagnosis_icd10" VARCHAR(16),
    "precautions" JSONB NOT NULL DEFAULT '{}',
    "sessions_authorised" INTEGER,
    "authorisation_extended_by" UUID,
    "authorisation_extended_at" TIMESTAMPTZ(6),
    "authorisation_extended_reason" TEXT,
    "lead_therapist_id" UUID,
    "status" "specialty"."TherapyEpisodeStatus" NOT NULL DEFAULT 'triaged',
    "sla_due_at" TIMESTAMPTZ(6),
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "outcome" VARCHAR(40),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "therapy_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."therapy_assessments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "admission_id" UUID,
    "kind" VARCHAR(20) NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '{}',
    "scores" JSONB NOT NULL DEFAULT '{}',
    "impression" TEXT,
    "form_response_id" UUID,
    "therapist_id" UUID NOT NULL,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "therapy_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."therapy_goals" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "description" VARCHAR(400) NOT NULL,
    "metric" VARCHAR(80) NOT NULL,
    "baseline" VARCHAR(80) NOT NULL,
    "target" VARCHAR(80) NOT NULL,
    "code" VARCHAR(24),
    "target_date" DATE,
    "status" "specialty"."TherapyGoalStatus" NOT NULL DEFAULT 'active',
    "outcome_note" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "therapy_goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."therapy_plans" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "assessment_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "items" JSONB NOT NULL DEFAULT '[]',
    "frequency_per_week" INTEGER,
    "sessions_planned" INTEGER,
    "precautions_snapshot" JSONB NOT NULL DEFAULT '{}',
    "home_programme" JSONB NOT NULL DEFAULT '{}',
    "status" "specialty"."TherapyPlanStatus" NOT NULL DEFAULT 'draft',
    "therapist_id" UUID NOT NULL,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "therapy_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."therapy_sessions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "setting" "specialty"."TherapySetting" NOT NULL DEFAULT 'op',
    "status" "specialty"."TherapySessionStatus" NOT NULL DEFAULT 'scheduled',
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "ended_at" TIMESTAMPTZ(6),
    "duration_min" INTEGER,
    "work_done" JSONB NOT NULL DEFAULT '[]',
    "response" TEXT,
    "homework" TEXT,
    "pain_pre" INTEGER,
    "pain_post" INTEGER,
    "therapist_id" UUID NOT NULL,
    "caregiver_present" BOOLEAN NOT NULL DEFAULT false,
    "charge_intent_id" UUID,
    "units" DECIMAL(5,2),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "therapy_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."wounds" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "episode_id" UUID,
    "wound_no" INTEGER NOT NULL,
    "location_snomed" VARCHAR(40),
    "location_text" VARCHAR(160) NOT NULL,
    "side" "clinical"."Laterality" NOT NULL DEFAULT 'not_applicable',
    "aetiology" "specialty"."WoundAetiology" NOT NULL,
    "onset_date" DATE,
    "cause" VARCHAR(240),
    "classification" JSONB NOT NULL DEFAULT '{}',
    "status" "specialty"."WoundStatus" NOT NULL DEFAULT 'open',
    "hospital_acquired" BOOLEAN NOT NULL DEFAULT false,
    "incident_id" UUID,
    "healed_at" TIMESTAMPTZ(6),
    "healing_days" INTEGER,
    "opened_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."wound_assessments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "wound_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assessed_by" UUID NOT NULL,
    "context" VARCHAR(12) NOT NULL DEFAULT 'opd',
    "length_cm" DECIMAL(5,2),
    "width_cm" DECIMAL(5,2),
    "depth_cm" DECIMAL(5,2),
    "area_cm2" DECIMAL(8,2),
    "area_reduction_pct" DECIMAL(6,2),
    "trajectory" "specialty"."WoundTrajectory",
    "undermining" JSONB NOT NULL DEFAULT '{}',
    "tunnelling" JSONB NOT NULL DEFAULT '{}',
    "tissue_pct" JSONB NOT NULL DEFAULT '{}',
    "exudate" JSONB NOT NULL DEFAULT '{}',
    "infection_signs" JSONB NOT NULL DEFAULT '{}',
    "periwound" JSONB NOT NULL DEFAULT '{}',
    "pain_nrs" INTEGER,
    "odour" BOOLEAN NOT NULL DEFAULT false,
    "probe_to_bone" BOOLEAN NOT NULL DEFAULT false,
    "exposed_structures" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scores" JSONB NOT NULL DEFAULT '{}',
    "culture_order_id" UUID,
    "form_response_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "wound_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."wound_photos" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "wound_id" UUID NOT NULL,
    "assessment_id" UUID,
    "patient_id" UUID NOT NULL,
    "s3_key" VARCHAR(500) NOT NULL,
    "thumb_key" VARCHAR(500),
    "taken_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taken_by" UUID NOT NULL,
    "device" VARCHAR(80),
    "stage" VARCHAR(24) NOT NULL DEFAULT 'routine',
    "has_scale_marker" BOOLEAN NOT NULL DEFAULT false,
    "calibration" JSONB NOT NULL DEFAULT '{}',
    "annotations" JSONB NOT NULL DEFAULT '{}',
    "consent_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wound_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."wound_dressing_events" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "wound_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "session_id" UUID,
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performed_by" UUID NOT NULL,
    "location" VARCHAR(24) NOT NULL DEFAULT 'dressing_room',
    "consumables" JSONB NOT NULL DEFAULT '[]',
    "consumption_id" UUID,
    "npwt_canister_changed" BOOLEAN NOT NULL DEFAULT false,
    "pain_pre" INTEGER,
    "pain_post" INTEGER,
    "notes" TEXT,
    "next_due_at" TIMESTAMPTZ(6),
    "charge_intent_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wound_dressing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "food_items_hospital_id_food_group_is_active_idx" ON "mdm"."food_items"("hospital_id", "food_group", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "uq_food_item_code" ON "mdm"."food_items"("hospital_id", "code");

-- CreateIndex
CREATE INDEX "nutrition_assessments_hospital_id_patient_id_created_at_idx" ON "specialty"."nutrition_assessments"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "nutrition_assessments_hospital_id_branch_id_malnutrition_cl_idx" ON "specialty"."nutrition_assessments"("hospital_id", "branch_id", "malnutrition_class");

-- CreateIndex
CREATE INDEX "diet_plans_hospital_id_patient_id_status_idx" ON "specialty"."diet_plans"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "diet_plans_hospital_id_branch_id_status_valid_from_idx" ON "specialty"."diet_plans"("hospital_id", "branch_id", "status", "valid_from");

-- CreateIndex
CREATE INDEX "slp_assessments_hospital_id_episode_id_created_at_idx" ON "specialty"."slp_assessments"("hospital_id", "episode_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "slp_assessments_hospital_id_patient_id_kind_idx" ON "specialty"."slp_assessments"("hospital_id", "patient_id", "kind");

-- CreateIndex
CREATE INDEX "slp_swallow_orders_hospital_id_patient_id_effective_from_idx" ON "specialty"."slp_swallow_orders"("hospital_id", "patient_id", "effective_from" DESC);

-- CreateIndex
CREATE INDEX "slp_swallow_orders_hospital_id_branch_id_status_idx" ON "specialty"."slp_swallow_orders"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "therapy_episodes_hospital_id_branch_id_discipline_status_idx" ON "specialty"."therapy_episodes"("hospital_id", "branch_id", "discipline", "status");

-- CreateIndex
CREATE INDEX "therapy_episodes_hospital_id_patient_id_discipline_opened_a_idx" ON "specialty"."therapy_episodes"("hospital_id", "patient_id", "discipline", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "therapy_episodes_hospital_id_status_sla_due_at_idx" ON "specialty"."therapy_episodes"("hospital_id", "status", "sla_due_at");

-- CreateIndex
CREATE INDEX "therapy_assessments_hospital_id_episode_id_created_at_idx" ON "specialty"."therapy_assessments"("hospital_id", "episode_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "therapy_assessments_hospital_id_patient_id_kind_idx" ON "specialty"."therapy_assessments"("hospital_id", "patient_id", "kind");

-- CreateIndex
CREATE INDEX "therapy_goals_hospital_id_episode_id_status_idx" ON "specialty"."therapy_goals"("hospital_id", "episode_id", "status");

-- CreateIndex
CREATE INDEX "therapy_plans_hospital_id_episode_id_status_idx" ON "specialty"."therapy_plans"("hospital_id", "episode_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_therapy_plan_version" ON "specialty"."therapy_plans"("episode_id", "version");

-- CreateIndex
CREATE INDEX "therapy_sessions_hospital_id_branch_id_scheduled_at_idx" ON "specialty"."therapy_sessions"("hospital_id", "branch_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "therapy_sessions_hospital_id_episode_id_scheduled_at_idx" ON "specialty"."therapy_sessions"("hospital_id", "episode_id", "scheduled_at" DESC);

-- CreateIndex
CREATE INDEX "therapy_sessions_hospital_id_therapist_id_scheduled_at_idx" ON "specialty"."therapy_sessions"("hospital_id", "therapist_id", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_therapy_session_seq" ON "specialty"."therapy_sessions"("episode_id", "seq");

-- CreateIndex
CREATE INDEX "wounds_hospital_id_branch_id_status_idx" ON "specialty"."wounds"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "wounds_hospital_id_aetiology_status_idx" ON "specialty"."wounds"("hospital_id", "aetiology", "status");

-- CreateIndex
CREATE INDEX "wounds_hospital_id_hospital_acquired_created_at_idx" ON "specialty"."wounds"("hospital_id", "hospital_acquired", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_wound_no" ON "specialty"."wounds"("hospital_id", "patient_id", "wound_no");

-- CreateIndex
CREATE INDEX "wound_assessments_hospital_id_wound_id_assessed_at_idx" ON "specialty"."wound_assessments"("hospital_id", "wound_id", "assessed_at" DESC);

-- CreateIndex
CREATE INDEX "wound_assessments_hospital_id_trajectory_idx" ON "specialty"."wound_assessments"("hospital_id", "trajectory");

-- CreateIndex
CREATE INDEX "wound_photos_hospital_id_wound_id_taken_at_idx" ON "specialty"."wound_photos"("hospital_id", "wound_id", "taken_at" DESC);

-- CreateIndex
CREATE INDEX "wound_dressing_events_hospital_id_wound_id_performed_at_idx" ON "specialty"."wound_dressing_events"("hospital_id", "wound_id", "performed_at" DESC);

-- CreateIndex
CREATE INDEX "wound_dressing_events_hospital_id_branch_id_performed_at_idx" ON "specialty"."wound_dressing_events"("hospital_id", "branch_id", "performed_at" DESC);

-- AddForeignKey
ALTER TABLE "specialty"."diet_plans" ADD CONSTRAINT "diet_plans_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "specialty"."nutrition_assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."slp_swallow_orders" ADD CONSTRAINT "slp_swallow_orders_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "specialty"."slp_assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."therapy_assessments" ADD CONSTRAINT "therapy_assessments_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."therapy_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."therapy_goals" ADD CONSTRAINT "therapy_goals_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."therapy_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."therapy_plans" ADD CONSTRAINT "therapy_plans_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."therapy_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."therapy_plans" ADD CONSTRAINT "therapy_plans_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "specialty"."therapy_assessments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."therapy_sessions" ADD CONSTRAINT "therapy_sessions_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."therapy_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."therapy_sessions" ADD CONSTRAINT "therapy_sessions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "specialty"."therapy_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."wound_assessments" ADD CONSTRAINT "wound_assessments_wound_id_fkey" FOREIGN KEY ("wound_id") REFERENCES "specialty"."wounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."wound_photos" ADD CONSTRAINT "wound_photos_assessment_id_fkey" FOREIGN KEY ("assessment_id") REFERENCES "specialty"."wound_assessments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."wound_dressing_events" ADD CONSTRAINT "wound_dressing_events_wound_id_fkey" FOREIGN KEY ("wound_id") REFERENCES "specialty"."wounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- §B.1  The therapy spine — shared by all four consoles
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.1.1  A goal is measurable ───────────────────────────────────────────
--
-- Metric, baseline and target are NOT NULL columns rather than a blob, so a
-- goal that cannot be reported on cannot be written. And a goal that has left
-- `active` says what happened: an outcome report over unexplained failures
-- teaches a department nothing.
ALTER TABLE "specialty"."therapy_goals"
  ADD CONSTRAINT "a_goal_is_measurable"
  CHECK (length(btrim("metric")) > 0
     AND length(btrim("baseline")) > 0
     AND length(btrim("target")) > 0);

ALTER TABLE "specialty"."therapy_goals"
  ADD CONSTRAINT "a_resolved_goal_says_what_happened"
  CHECK ("status" = 'active'
     OR ("resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL
         AND "outcome_note" IS NOT NULL AND length(btrim("outcome_note")) >= 4));

-- ── §B.1.2  An extension of the authorisation is an act ────────────────────
ALTER TABLE "specialty"."therapy_episodes"
  ADD CONSTRAINT "an_extension_names_itself"
  CHECK (
    ("authorisation_extended_by" IS NULL AND "authorisation_extended_at" IS NULL
       AND "authorisation_extended_reason" IS NULL)
    OR ("authorisation_extended_by" IS NOT NULL AND "authorisation_extended_at" IS NOT NULL
        AND "authorisation_extended_reason" IS NOT NULL
        AND length(btrim("authorisation_extended_reason")) >= 8)
  );

ALTER TABLE "specialty"."therapy_episodes"
  ADD CONSTRAINT "an_authorisation_is_a_positive_number"
  CHECK ("sessions_authorised" IS NULL OR "sessions_authorised" > 0);

-- ── §B.1.3  A plan follows a signed assessment ─────────────────────────────
CREATE OR REPLACE FUNCTION specialty.a_plan_follows_an_assessment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_signed_at timestamptz;
  v_episode uuid;
BEGIN
  SELECT signed_at, episode_id INTO v_signed_at, v_episode
    FROM specialty.therapy_assessments WHERE id = NEW.assessment_id;

  IF v_episode IS DISTINCT FROM NEW.episode_id THEN
    RAISE EXCEPTION 'That assessment belongs to a different episode (OP-015 §B.1.3). A plan follows the assessment of the course it is part of.'
      USING ERRCODE = 'OP015';
  END IF;

  IF NEW.status IN ('active', 'completed') AND v_signed_at IS NULL THEN
    RAISE EXCEPTION 'This plan cannot be activated: the assessment behind it is not signed (OP-015 §B.1.3). Treatment before assessment is a course nobody can justify when the payer asks for the clinical reasoning.'
      USING ERRCODE = 'OP015';
  END IF;

  IF NEW.status IN ('active', 'completed')
     AND (NEW.signed_by IS NULL OR NEW.signed_at IS NULL) THEN
    RAISE EXCEPTION 'An active plan names the therapist who signed it (OP-015 §B.1.3).'
      USING ERRCODE = 'OP015';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "a_plan_follows_an_assessment"
  BEFORE INSERT OR UPDATE ON "specialty"."therapy_plans"
  FOR EACH ROW EXECUTE FUNCTION specialty.a_plan_follows_an_assessment();

-- One active plan per episode. Two is two courses of treatment running at the
-- same time against the same authorisation.
CREATE UNIQUE INDEX "uq_one_active_therapy_plan"
  ON "specialty"."therapy_plans" ("episode_id")
  WHERE "status" = 'active';

-- ── §B.1.4  A session is delivered against a live plan, within the authorisation
--
-- Three checks in one place because they are one question the therapist is
-- actually asking: may I see this patient now? The answers are "the plan is not
-- active", "the episode is on hold" and "you have used the tenth of ten
-- sessions", and each of them is something a person can do something about.
CREATE OR REPLACE FUNCTION specialty.a_session_needs_a_live_plan()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_plan_status specialty."TherapyPlanStatus";
  v_plan_episode uuid;
  v_ep_status specialty."TherapyEpisodeStatus";
  v_authorised int;
  v_delivered int;
BEGIN
  SELECT status, episode_id INTO v_plan_status, v_plan_episode
    FROM specialty.therapy_plans WHERE id = NEW.plan_id;

  IF v_plan_episode IS DISTINCT FROM NEW.episode_id THEN
    RAISE EXCEPTION 'That plan belongs to a different episode (OP-015 §B.1.4).'
      USING ERRCODE = 'OP015';
  END IF;

  SELECT status, sessions_authorised INTO v_ep_status, v_authorised
    FROM specialty.therapy_episodes WHERE id = NEW.episode_id;

  -- A session already delivered stays delivered when a plan is superseded; only
  -- a *new* attendance needs a live plan.
  IF NEW.status IN ('scheduled', 'attended') THEN
    IF v_plan_status <> 'active' THEN
      RAISE EXCEPTION 'That plan is % and cannot take a session (OP-015 §B.1.4). Activate the current plan, or write a new one from a signed assessment.', v_plan_status
        USING ERRCODE = 'OP015';
    END IF;

    IF v_ep_status NOT IN ('active') THEN
      RAISE EXCEPTION 'This episode is % (OP-015 §B.1.4). A session belongs to a course that is running.', v_ep_status
        USING ERRCODE = 'OP015';
    END IF;
  END IF;

  -- The authorisation. Counted over attendances rather than bookings, because a
  -- cancelled slot has not used anybody's package.
  IF NEW.status = 'attended' AND v_authorised IS NOT NULL THEN
    SELECT count(*) INTO v_delivered
      FROM specialty.therapy_sessions
     WHERE episode_id = NEW.episode_id AND status = 'attended'
       AND id IS DISTINCT FROM NEW.id;

    IF v_delivered >= v_authorised THEN
      RAISE EXCEPTION 'All % authorised session(s) on this episode have been delivered (OP-015 §B.1.4). Extend the authorisation with a reason before the next one, or the work is either unbilled or unauthorised.', v_authorised
        USING ERRCODE = 'OP015';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "a_session_needs_a_live_plan"
  BEFORE INSERT OR UPDATE OF status, plan_id ON "specialty"."therapy_sessions"
  FOR EACH ROW EXECUTE FUNCTION specialty.a_session_needs_a_live_plan();

-- ── §B.1.5  A session is billed once ───────────────────────────────────────
--
-- The same twenty minutes charged twice is invisible in a list of forty
-- identical rows, and therapy is where that list exists.
CREATE UNIQUE INDEX "uq_therapy_session_charge"
  ON "specialty"."therapy_sessions" ("charge_intent_id")
  WHERE "charge_intent_id" IS NOT NULL;

ALTER TABLE "specialty"."therapy_sessions"
  ADD CONSTRAINT "an_attended_session_happened"
  CHECK ("status" <> 'attended'
     OR ("started_at" IS NOT NULL AND "duration_min" IS NOT NULL AND "duration_min" > 0));

ALTER TABLE "specialty"."therapy_sessions"
  ADD CONSTRAINT "session_pain_scores_are_zero_to_ten"
  CHECK (("pain_pre" IS NULL OR "pain_pre" BETWEEN 0 AND 10)
     AND ("pain_post" IS NULL OR "pain_post" BETWEEN 0 AND 10));

-- ── §B.1.6  A discharge closes every goal ──────────────────────────────────
--
-- Not tidiness. A department's outcome data is the resolved goals, and an
-- episode discharged with three goals still `active` is three outcomes that
-- silently never existed.
CREATE OR REPLACE FUNCTION specialty.a_discharge_closes_the_goals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE v_open int;
BEGIN
  IF NEW.status = 'discharged' AND OLD.status IS DISTINCT FROM 'discharged' THEN
    SELECT count(*) INTO v_open
      FROM specialty.therapy_goals
     WHERE episode_id = NEW.id AND status = 'active';

    IF v_open > 0 THEN
      RAISE EXCEPTION '% goal(s) on this episode are still open (OP-015 §B.1.6). Record what happened to each one — met, partly met, not met or revised — before discharging: the department''s outcome data is those answers.', v_open
        USING ERRCODE = 'OP015';
    END IF;

    IF NEW.outcome IS NULL OR length(btrim(NEW.outcome)) = 0 THEN
      RAISE EXCEPTION 'A discharged episode records how the course ended (OP-015 §B.1.6).'
        USING ERRCODE = 'OP015';
    END IF;

    NEW.closed_at := coalesce(NEW.closed_at, now());
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "a_discharge_closes_the_goals"
  BEFORE UPDATE ON "specialty"."therapy_episodes"
  FOR EACH ROW EXECUTE FUNCTION specialty.a_discharge_closes_the_goals();


-- ─────────────────────────────────────────────────────────────────────────────
-- §B.2  OP-017 · Wound care
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.2.1  Area and the reduction are derived ─────────────────────────────
--
-- π/4 × L × W is the standard elliptical approximation, and the reduction is
-- against this wound's first assessment. The whole referral logic of a wound
-- clinic is a threshold on the second number — about 40 % by four weeks — so a
-- percentage somebody typed is a percentage that agrees with whatever the
-- clinic hoped, in a chart nobody re-derives.
CREATE OR REPLACE FUNCTION specialty.derive_wound_area()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_baseline numeric;
  v_baseline_at timestamptz;
  v_weeks numeric;
BEGIN
  IF NEW.length_cm IS NULL OR NEW.width_cm IS NULL THEN
    NEW.area_cm2 := NULL;
  ELSE
    -- `pi()` is double precision; the measurements are numeric, and the area
    -- has to stay numeric or a 15.71 becomes a 15.710000000000001 in a report.
    NEW.area_cm2 := round((pi()::numeric / 4) * NEW.length_cm * NEW.width_cm, 2);
  END IF;

  SELECT area_cm2, assessed_at INTO v_baseline, v_baseline_at
    FROM specialty.wound_assessments
   WHERE wound_id = NEW.wound_id AND area_cm2 IS NOT NULL
     AND id IS DISTINCT FROM NEW.id
   ORDER BY assessed_at, created_at, id
   LIMIT 1;

  IF v_baseline IS NULL OR v_baseline = 0 OR NEW.area_cm2 IS NULL THEN
    -- The first measurement is its own baseline: zero reduction, and no
    -- trajectory, because one point is not a trend.
    NEW.area_reduction_pct := CASE WHEN NEW.area_cm2 IS NULL THEN NULL ELSE 0 END;
    NEW.trajectory := NULL;
  ELSE
    NEW.area_reduction_pct := round((v_baseline - NEW.area_cm2) / v_baseline * 100, 2);
    v_weeks := extract(epoch FROM (NEW.assessed_at - v_baseline_at)) / 604800.0;

    NEW.trajectory := CASE
      WHEN NEW.area_reduction_pct < 0 THEN 'deteriorating'::specialty."WoundTrajectory"
      -- Before four weeks there is not enough evidence to call it stalled.
      WHEN v_weeks < 4 THEN 'on_track'::specialty."WoundTrajectory"
      WHEN NEW.area_reduction_pct < 40 THEN 'stalled'::specialty."WoundTrajectory"
      ELSE 'on_track'::specialty."WoundTrajectory"
    END;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "wound_area_is_derived_never_typed"
  BEFORE INSERT OR UPDATE ON "specialty"."wound_assessments"
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_wound_area();

-- ── §B.2.2  The wound bed adds up to one wound ─────────────────────────────
--
-- Sixty per cent granulation and sixty per cent slough is a description of two
-- wounds, and a tissue chart built from it is nonsense in a direction that
-- looks plausible.
CREATE OR REPLACE FUNCTION specialty.tissue_totals_one_hundred()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE v_total numeric;
BEGIN
  IF NEW.tissue_pct IS NULL OR NEW.tissue_pct = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(sum((value#>>'{}')::numeric), 0) INTO v_total
    FROM jsonb_each(NEW.tissue_pct);

  IF abs(v_total - 100) > 0.5 THEN
    RAISE EXCEPTION 'The wound bed adds up to %%%, not 100 (OP-017 §B.2.2). Granulation, slough, necrotic and epithelial tissue are shares of one wound.', v_total
      USING ERRCODE = 'OP017';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "tissue_totals_one_hundred"
  BEFORE INSERT OR UPDATE OF tissue_pct ON "specialty"."wound_assessments"
  FOR EACH ROW EXECUTE FUNCTION specialty.tissue_totals_one_hundred();

ALTER TABLE "specialty"."wound_assessments"
  ADD CONSTRAINT "wound_measurements_are_measurements"
  CHECK (("length_cm" IS NULL OR ("length_cm" >= 0 AND "length_cm" <= 200))
     AND ("width_cm"  IS NULL OR ("width_cm"  >= 0 AND "width_cm"  <= 200))
     AND ("depth_cm"  IS NULL OR ("depth_cm"  >= 0 AND "depth_cm"  <= 50))
     AND ("pain_nrs"  IS NULL OR "pain_nrs" BETWEEN 0 AND 10));

-- ── §B.2.3  A wound is healed when it has closed ───────────────────────────
--
-- Not when somebody ticks a box. A wound marked healed while its last
-- measurement says 4 cm² is a district nurse arriving to a discharged patient
-- with an open ulcer — and it is how pressure-ulcer statistics come to be wrong
-- in the direction nobody audits.
CREATE OR REPLACE FUNCTION specialty.a_wound_heals_by_closing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_last_area numeric;
  v_last_at timestamptz;
BEGIN
  IF NEW.status <> 'healed' OR OLD.status = 'healed' THEN
    RETURN NEW;
  END IF;

  -- Two assessments can share an `assessed_at` — a correction entered moments
  -- after the original, or a bulk import. "The last assessment" has to be one
  -- row whichever way it is asked, so the tie breaks on entry order: `id` is a
  -- uuid v7 here, which sorts chronologically.
  SELECT area_cm2, assessed_at INTO v_last_area, v_last_at
    FROM specialty.wound_assessments
   WHERE wound_id = NEW.id
   ORDER BY assessed_at DESC, created_at DESC, id DESC
   LIMIT 1;

  IF v_last_area IS NULL THEN
    RAISE EXCEPTION 'This wound has no measured assessment, so it cannot be recorded as healed (OP-017 §B.2.3). Record a closing assessment first.'
      USING ERRCODE = 'OP017';
  END IF;

  IF v_last_area > 0 THEN
    RAISE EXCEPTION 'The last assessment measures this wound at % cm² (OP-017 §B.2.3). Record a closing assessment showing it has closed, or leave it open — a wound closed on the record and open on the patient is how a discharged patient loses their district nurse.', v_last_area
      USING ERRCODE = 'OP017';
  END IF;

  NEW.healed_at := coalesce(NEW.healed_at, v_last_at, now());
  NEW.healing_days := greatest(
    0,
    (NEW.healed_at::date - coalesce(NEW.onset_date, NEW.created_at::date))
  );

  RETURN NEW;
END $$;

CREATE TRIGGER "a_wound_heals_by_closing"
  BEFORE UPDATE ON "specialty"."wounds"
  FOR EACH ROW EXECUTE FUNCTION specialty.a_wound_heals_by_closing();

ALTER TABLE "specialty"."wounds"
  ADD CONSTRAINT "wound_number_is_positive"
  CHECK ("wound_no" > 0);


-- ─────────────────────────────────────────────────────────────────────────────
-- §B.3  OP-011 · Dietetics
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.3.1  A food carries what it is made of ──────────────────────────────
ALTER TABLE "mdm"."food_items"
  ADD CONSTRAINT "a_food_has_a_composition"
  CHECK ("per_100g" ? 'kcal' AND "per_100g" ? 'protein'
     AND "per_100g" ? 'carb' AND "per_100g" ? 'fat');

-- ── §B.3.2  A plan's totals are summed, and its restrictions are enforced ──
--
-- The header and the meals are written by the same person minutes apart and
-- then diverge forever: the plan says 1,800 kcal at the top and the meals below
-- add up to 2,400. And a renal plan 1,100 mg over on potassium is the most
-- consequential arithmetic error in outpatient dietetics — invisible unless
-- something adds it up.
CREATE OR REPLACE FUNCTION specialty.sum_diet_plan_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_totals jsonb := '{}'::jsonb;
  v_nutrient text;
  v_sum numeric;
  v_limit numeric;
  v_key text;
BEGIN
  -- Every nutrient a restriction can be written against, summed across every
  -- item of every meal at (grams / 100) × the item's per-100 g value.
  FOREACH v_nutrient IN ARRAY ARRAY['kcal','protein','carb','fat','fibre','na','k','po4']
  LOOP
    SELECT round(coalesce(sum(
             (coalesce((item->>'qty')::numeric, 0) / 100.0)
             * coalesce((f.per_100g->>v_nutrient)::numeric, 0)
           ), 0), 2)
      INTO v_sum
      FROM jsonb_array_elements(coalesce(NEW.meals, '[]'::jsonb)) meal
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(meal->'items', '[]'::jsonb)) item
      JOIN mdm.food_items f ON f.id = (item->>'foodId')::uuid;

    v_totals := v_totals || jsonb_build_object(v_nutrient, v_sum);
  END LOOP;

  NEW.totals := v_totals;

  -- Now the restrictions, by name and by amount.
  FOR v_key, v_nutrient IN
    SELECT * FROM (VALUES ('naMg','na'), ('kMg','k'), ('po4Mg','po4'),
                          ('kcalMax','kcal'), ('proteinMaxG','protein')) AS r(k, n)
  LOOP
    IF NEW.restrictions ? v_key THEN
      v_limit := (NEW.restrictions->>v_key)::numeric;
      v_sum := (v_totals->>v_nutrient)::numeric;
      IF v_sum > v_limit THEN
        RAISE EXCEPTION 'This plan restricts % to % but its meals contain % — % over (OP-011 §B.3.2). Adjust the meals or the restriction; a plan that breaks its own limit is the error nobody finds by reading it.',
          v_nutrient, v_limit, v_sum, round(v_sum - v_limit, 2)
          USING ERRCODE = 'OP011';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

CREATE TRIGGER "diet_plan_totals_are_summed"
  BEFORE INSERT OR UPDATE OF meals, restrictions, totals ON "specialty"."diet_plans"
  FOR EACH ROW EXECUTE FUNCTION specialty.sum_diet_plan_totals();

-- One active plan per patient. Two is a kitchen and a patient reading different
-- documents.
CREATE UNIQUE INDEX "uq_one_active_diet_plan"
  ON "specialty"."diet_plans" ("hospital_id", "patient_id")
  WHERE "status" = 'active';

ALTER TABLE "specialty"."diet_plans"
  ADD CONSTRAINT "a_plan_period_runs_forwards"
  CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");

ALTER TABLE "specialty"."diet_plans"
  ADD CONSTRAINT "an_active_diet_plan_is_signed"
  CHECK ("status" <> 'active' OR ("signed_by" IS NOT NULL AND "signed_at" IS NOT NULL));

ALTER TABLE "specialty"."nutrition_assessments"
  ADD CONSTRAINT "sga_is_a_b_or_c"
  CHECK ("sga" IS NULL OR "sga" IN ('A','B','C'));


-- ─────────────────────────────────────────────────────────────────────────────
-- §B.4  OP-035 · Speech and swallow
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.4.1  An IDDSI order names both levels, or neither ───────────────────
--
-- The framework numbers foods 3 to 7 and drinks 0 to 4, and the numbers overlap
-- without meaning the same thing: "level 4" is pureed food *and* extremely
-- thick fluid. A kitchen reading one for the other sends a tray that can kill
-- somebody, so a half-specified order does not exist.
ALTER TABLE "specialty"."slp_swallow_orders"
  ADD CONSTRAINT "an_iddsi_order_is_complete"
  CHECK (
    CASE WHEN "npo"
      THEN "food_level" IS NULL AND "fluid_level" IS NULL
      ELSE "food_level" IS NOT NULL AND "fluid_level" IS NOT NULL
    END
  );

ALTER TABLE "specialty"."slp_swallow_orders"
  ADD CONSTRAINT "iddsi_levels_are_iddsi_levels"
  CHECK (("food_level"  IS NULL OR "food_level"  BETWEEN 3 AND 7)
     AND ("fluid_level" IS NULL OR "fluid_level" BETWEEN 0 AND 4));

-- ── §B.4.2  An order is in force when the kitchen and the ward have read it ─
--
-- This is the whole failure mode of the console. A therapist assesses at eleven
-- and writes level 4 fluids; the tray that arrives at twelve was plated at ten.
-- Until both acknowledgements exist the order is `pending`, so the ward is
-- looking at "waiting for the kitchen" rather than at a green tick that is not
-- true yet.
CREATE OR REPLACE FUNCTION specialty.a_swallow_order_is_acknowledged()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  IF NEW.status = 'active'
     AND (NEW.ack_kitchen_at IS NULL OR NEW.ack_ward_at IS NULL) THEN
    RAISE EXCEPTION 'This swallow order is not in force yet: it needs an acknowledgement from the kitchen%s and from the ward%s (OP-035 §B.4.2). A recommendation nobody has read changes nothing about the tray that arrives.',
      CASE WHEN NEW.ack_kitchen_at IS NULL THEN ' (outstanding)' ELSE '' END,
      CASE WHEN NEW.ack_ward_at IS NULL THEN ' (outstanding)' ELSE '' END
      USING ERRCODE = 'OP035';
  END IF;

  -- An acknowledgement is a person and a time, never half of one.
  IF (NEW.ack_kitchen_by IS NULL) <> (NEW.ack_kitchen_at IS NULL)
     OR (NEW.ack_ward_by IS NULL) <> (NEW.ack_ward_at IS NULL) THEN
    RAISE EXCEPTION 'An acknowledgement records who acknowledged it and when (OP-035 §B.4.2).'
      USING ERRCODE = 'OP035';
  END IF;

  -- A downgrade the ward cannot explain is a downgrade the ward will quietly
  -- ignore the next time.
  IF NEW.status IN ('superseded', 'cancelled')
     AND (NEW.change_reason IS NULL OR length(btrim(NEW.change_reason)) < 4) THEN
    RAISE EXCEPTION 'Superseding or cancelling a swallow order records why (OP-035 §B.4.2).'
      USING ERRCODE = 'OP035';
  END IF;

  IF NEW.status IN ('superseded', 'cancelled') THEN
    NEW.ended_at := coalesce(NEW.ended_at, now());
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "a_swallow_order_is_acknowledged"
  BEFORE INSERT OR UPDATE ON "specialty"."slp_swallow_orders"
  FOR EACH ROW EXECUTE FUNCTION specialty.a_swallow_order_is_acknowledged();

-- ── §B.4.3  One live order per patient ─────────────────────────────────────
--
-- Two is a ward with two answers to "what can this person eat", and the one
-- they act on is whichever they happened to read. `pending` counts: an order
-- waiting for the kitchen is still the order in play.
CREATE UNIQUE INDEX "uq_one_live_swallow_order"
  ON "specialty"."slp_swallow_orders" ("hospital_id", "patient_id")
  WHERE "status" IN ('pending', 'active');


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
            AND (c.relname LIKE 'therapy\_%' OR c.relname LIKE 'wound%'
                 OR c.relname LIKE 'slp\_%'
                 OR c.relname IN ('nutrition_assessments','diet_plans')))
        OR (n.nspname = 'mdm' AND c.relname = 'food_items'))
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % therapy table(s)', v_count;
END $$;

-- A session that was delivered, a wound measurement, a photograph and a diet
-- plan a kitchen cooked from are evidence. They are corrected by a new row, not
-- removed — and a session in particular, because a deleted session is a
-- deleted charge and a deleted attendance in the same act.
REVOKE DELETE ON "specialty"."therapy_sessions"       FROM hms_app;
REVOKE DELETE ON "specialty"."therapy_assessments"    FROM hms_app;
REVOKE DELETE ON "specialty"."wound_assessments"      FROM hms_app;
REVOKE DELETE ON "specialty"."wound_photos"           FROM hms_app;
REVOKE DELETE ON "specialty"."wound_dressing_events"  FROM hms_app;
REVOKE DELETE ON "specialty"."diet_plans"             FROM hms_app;
REVOKE DELETE ON "specialty"."slp_assessments"        FROM hms_app;

-- A swallow order is superseded or cancelled with a reason, never deleted. It
-- is the record of what a ward was told a patient could safely eat.
REVOKE DELETE ON "specialty"."slp_swallow_orders"     FROM hms_app;


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
  WHERE c.relkind IN ('r','p') AND c.relispartition = false
    AND ((n.nspname = 'specialty'
          AND (c.relname LIKE 'therapy\_%' OR c.relname LIKE 'wound%' OR c.relname LIKE 'slp\_%'
               OR c.relname IN ('nutrition_assessments','diet_plans')))
      OR (n.nspname = 'mdm' AND c.relname = 'food_items'))
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Therapy tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;
