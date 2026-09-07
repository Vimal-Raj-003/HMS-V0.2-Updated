-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-029 · OP-030 · OP-028 · OP-026 · OP-027
-- The five device-heavy consoles: cardiology, pulmonology, ENT, dental,
-- dermatology
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Five specialties, one device path. Not one of these tables carries an
-- `investigation_orders` column, an upload key or a worklist definition: an
-- ECG, a spirometry trace, an audiogram, an OPG and a dermoscopy image are all
-- `specialty.device_orders` rows, because `phase-08` calls a second copy of
-- that pipeline a defect rather than a feature. What each console brings is
-- what only it knows — the shape of its own numbers, and the arithmetic that
-- turns them into a diagnosis.
--
-- That arithmetic is the theme of this migration. In all five specialties the
-- number that decides something is *derived* from numbers a device already
-- produced, and in all five it is, somewhere in the world, typed into a box:
--
--   · QTc from the QT and the rate — decides whether a drug is safe to give
--   · FEV1/FVC and bronchodilator reversibility — decides asthma or COPD
--   · the four-frequency average — decides a disability certificate
--   · the DMFT and the chart state — decides a claim
--   · PASI — decides whether a biologic stays funded
--
-- Every one of them is computed by a trigger here, and there is no column to
-- type it into. A derived number cannot drift toward the answer somebody
-- needed, and — the quieter benefit — every point on a trend was converted the
-- same way, so a chart and a chart note cannot disagree about whether a patient
-- got better.
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
--  1. A critical ECG does not become `final` until an acknowledgement names who
--     was told and when. A tracing that sat in a queue is the classic
--     door-to-balloon failure, and afterwards it looks exactly like one that
--     was seen.
--
--  2. A warfarin dose grid sums to its weekly dose. Seven daily doses and a
--     weekly total are one fact written twice, and warfarin is the drug where
--     the two drifting apart puts somebody in hospital.
--
--  3. An unacceptable spirometry effort is not signed. An ATS/ERS grade F is
--     not a bad result, it is not a result — and signing one puts a number into
--     a trend that will be compared against real ones for years.
--
--  4. A PAP prescription carries the pressures its mode needs, in order. IPAP
--     below EPAP is a machine that cannot deliver a breath, and the supplier
--     finds out, not the clinic.
--
--  5. Bone conduction is not worse than air conduction. Sound through the skull
--     cannot need more energy than sound through the canal: a negative air-bone
--     gap is a masking error, and it is the commonest audiometry mistake there
--     is. Caught at entry it is a repeated frequency; caught later it is a
--     patient told they have a conductive loss they do not have.
--
--  6. An extracted tooth receives no new work. Planning a crown on a missing
--     tooth is a consent failure, a billing failure, and the moment somebody
--     looks in a mouth for a tooth that is not there.
--
--  7. The dental chart is materialised from an append-only log, never written.
--     A chart that can be edited directly is a chart where "when did this
--     filling appear?" has no answer, and that is asked every time a claim is
--     queried.
--
--  8. An accepted treatment plan's prices do not move. A plan is a quotation
--     the patient consented to; a change is a new version, presented again.
--
--  9. A phototherapy session cannot exceed its course's ceiling, and cannot
--     escalate after erythema. Those two are how a narrowband UVB burn happens,
--     and the machine will deliver whatever it is asked for.
--
-- 10. A malignant biopsy is not closed without a follow-up. A skin cancer
--     report nobody acted on is the commonest dermatology claim.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATEs: OP029, OP030, OP028, OP026, OP027.
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "specialty"."EcgStatus" AS ENUM ('acquired', 'preliminary', 'final');

-- CreateEnum
CREATE TYPE "specialty"."EcgSource" AS ENUM ('device', 'upload', 'manual');

-- CreateEnum
CREATE TYPE "specialty"."EchoType" AS ENUM ('tte', 'tee', 'stress', 'fetal', 'paeds');

-- CreateEnum
CREATE TYPE "specialty"."StressProtocol" AS ENUM ('bruce', 'mod_bruce', 'naughton', 'pharmacological');

-- CreateEnum
CREATE TYPE "specialty"."StressResult" AS ENUM ('positive', 'negative', 'equivocal', 'inconclusive');

-- CreateEnum
CREATE TYPE "specialty"."AnticoagDrug" AS ENUM ('warfarin', 'acenocoumarol', 'doac');

-- CreateEnum
CREATE TYPE "specialty"."Dentition" AS ENUM ('permanent', 'primary', 'mixed');

-- CreateEnum
CREATE TYPE "specialty"."ToothEventStatus" AS ENUM ('existing', 'planned', 'done', 'cancelled');

-- CreateEnum
CREATE TYPE "specialty"."PlanStatus" AS ENUM ('draft', 'presented', 'accepted', 'partial', 'declined', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "specialty"."PlanItemStatus" AS ENUM ('proposed', 'accepted', 'declined', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "specialty"."LesionStatus" AS ENUM ('active', 'resolved', 'excised', 'monitor');

-- CreateEnum
CREATE TYPE "specialty"."DermScoreType" AS ENUM ('pasi', 'easi', 'scorad', 'bsa', 'dlqi', 'iga_acne', 'salt', 'vasi', 'uas7', 'hurley', 'ihs4', 'leprosy_grade', 'other');

-- CreateEnum
CREATE TYPE "specialty"."BiopsyStatus" AS ENUM ('sent', 'received', 'reported', 'reviewed', 'action_planned');

-- CreateEnum
CREATE TYPE "specialty"."PhototherapyModality" AS ENUM ('nbuvb', 'puva', 'excimer', 'uva1');

-- CreateEnum
CREATE TYPE "specialty"."AudioTestType" AS ENUM ('pta', 'speech', 'tymp', 'oae', 'bera', 'assr', 'freefield', 'vra', 'play', 'rem');

-- CreateEnum
CREATE TYPE "specialty"."AudioTestStatus" AS ENUM ('ordered', 'in_progress', 'signed', 'reviewed', 'cnt');

-- CreateEnum
CREATE TYPE "specialty"."Conduction" AS ENUM ('ac', 'bc');

-- CreateEnum
CREATE TYPE "specialty"."HlDegree" AS ENUM ('normal', 'slight', 'mild', 'moderate', 'mod_severe', 'severe', 'profound');

-- CreateEnum
CREATE TYPE "specialty"."HlType" AS ENUM ('normal', 'conductive', 'snhl', 'mixed');

-- CreateEnum
CREATE TYPE "specialty"."TympType" AS ENUM ('A', 'As', 'Ad', 'B', 'C');

-- CreateEnum
CREATE TYPE "specialty"."HearingAidStatus" AS ENUM ('trial', 'dispensed', 'returned', 'serviced');

-- CreateEnum
CREATE TYPE "specialty"."PftStatus" AS ENUM ('ordered', 'performed', 'interpreted', 'reviewed');

-- CreateEnum
CREATE TYPE "specialty"."SleepStudyType" AS ENUM ('psg', 'hst', 'titration', 'split');

-- CreateEnum
CREATE TYPE "specialty"."SleepStudyStatus" AS ENUM ('scheduled', 'in_progress', 'scored', 'reported', 'no_show', 'cancelled');

-- CreateEnum
CREATE TYPE "specialty"."OsaSeverity" AS ENUM ('none', 'mild', 'moderate', 'severe');

-- CreateEnum
CREATE TYPE "specialty"."PapMode" AS ENUM ('cpap', 'apap', 'bipap', 'asv');

-- CreateTable
CREATE TABLE "specialty"."cardio_consults" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "nyha" INTEGER,
    "ccs" INTEGER,
    "scores" JSONB NOT NULL DEFAULT '{}',
    "cv_history" JSONB NOT NULL DEFAULT '{}',
    "exam" JSONB NOT NULL DEFAULT '{}',
    "plan" JSONB NOT NULL DEFAULT '{}',
    "problem_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cardio_consults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."cardio_ecg_records" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "device_order_id" UUID,
    "source" "specialty"."EcgSource" NOT NULL,
    "acquired_at" TIMESTAMPTZ(6) NOT NULL,
    "tech_id" UUID,
    "hr" INTEGER,
    "pr_ms" INTEGER,
    "qrs_ms" INTEGER,
    "qt_ms" INTEGER,
    "qtc_ms" INTEGER,
    "axis_deg" INTEGER,
    "machine_interp" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "read_interp" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "read_by" UUID,
    "read_at" TIMESTAMPTZ(6),
    "lead_quality" VARCHAR(24),
    "waveform_key" VARCHAR(500),
    "pdf_key" VARCHAR(500),
    "critical" BOOLEAN NOT NULL DEFAULT false,
    "critical_ack_by" UUID,
    "critical_ack_at" TIMESTAMPTZ(6),
    "critical_ack_to" VARCHAR(160),
    "status" "specialty"."EcgStatus" NOT NULL DEFAULT 'acquired',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cardio_ecg_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."cardio_echo_reports" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "device_order_id" UUID,
    "study_uid" VARCHAR(120),
    "type" "specialty"."EchoType" NOT NULL,
    "ef_pct" DECIMAL(4,1),
    "measurements" JSONB NOT NULL DEFAULT '{}',
    "wall_motion" JSONB NOT NULL DEFAULT '{}',
    "conclusions" TEXT,
    "key_images" UUID[] DEFAULT ARRAY[]::UUID[],
    "tech_id" UUID,
    "reported_by" UUID,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "pdf_key" VARCHAR(500),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cardio_echo_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."cardio_stress_tests" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "protocol" "specialty"."StressProtocol" NOT NULL,
    "stages" JSONB NOT NULL DEFAULT '[]',
    "target_hr" INTEGER,
    "max_hr_pct" INTEGER,
    "duke_score" DECIMAL(5,1),
    "termination_reason" VARCHAR(200),
    "result" "specialty"."StressResult",
    "physician_id" UUID NOT NULL,
    "consent_id" UUID,
    "checklist" JSONB NOT NULL DEFAULT '{}',
    "report_key" VARCHAR(500),
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cardio_stress_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."cardio_anticoag_enrolments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "drug" "specialty"."AnticoagDrug" NOT NULL,
    "indication" VARCHAR(160) NOT NULL,
    "target_inr_low" DECIMAL(3,1),
    "target_inr_high" DECIMAL(3,1),
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cardio_anticoag_enrolments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."cardio_inr_visits" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "enrolment_id" UUID NOT NULL,
    "measured_at" TIMESTAMPTZ(6) NOT NULL,
    "inr" DECIMAL(4,2) NOT NULL,
    "source" VARCHAR(12) NOT NULL,
    "weekly_dose_mg" DECIMAL(6,2) NOT NULL,
    "dose_grid" JSONB NOT NULL,
    "next_at" DATE,
    "events" JSONB NOT NULL DEFAULT '[]',
    "ttr_pct" DECIMAL(5,2),
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cardio_inr_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."dental_charts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "dentition" "specialty"."Dentition" NOT NULL DEFAULT 'permanent',
    "state" JSONB NOT NULL DEFAULT '{}',
    "dmft" INTEGER,
    "ohis" DECIMAL(4,2),
    "occlusion" JSONB NOT NULL DEFAULT '{}',
    "soft_tissue" JSONB NOT NULL DEFAULT '{}',
    "rebuilt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dental_charts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."dental_tooth_events" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "tooth_fdi" INTEGER NOT NULL,
    "surfaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "condition_code" VARCHAR(40) NOT NULL,
    "status" "specialty"."ToothEventStatus" NOT NULL,
    "plan_item_id" UUID,
    "procedure_id" UUID,
    "notes" TEXT,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "dental_tooth_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."dental_treatment_plans" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "plan_no" VARCHAR(32) NOT NULL,
    "status" "specialty"."PlanStatus" NOT NULL DEFAULT 'draft',
    "estimate_id" UUID,
    "consent_id" UUID,
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "accepted_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "instalment_schedule" JSONB NOT NULL DEFAULT '[]',
    "presented_by" UUID,
    "presented_at" TIMESTAMPTZ(6),
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_via" VARCHAR(20),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dental_treatment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."dental_plan_items" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "procedure_code" VARCHAR(40) NOT NULL,
    "description" VARCHAR(240) NOT NULL,
    "teeth" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "surfaces" JSONB NOT NULL DEFAULT '{}',
    "phase" INTEGER NOT NULL DEFAULT 1,
    "priority" VARCHAR(12) NOT NULL DEFAULT 'phase1',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "sittings_planned" INTEGER NOT NULL DEFAULT 1,
    "sittings_done" INTEGER NOT NULL DEFAULT 0,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "payer_share" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "patient_share" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "specialty"."PlanItemStatus" NOT NULL DEFAULT 'proposed',
    "alt_group" VARCHAR(24),
    "dentist_id" UUID,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dental_plan_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."dental_sittings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "plan_id" UUID,
    "encounter_id" UUID,
    "procedure_id" UUID,
    "items" JSONB NOT NULL DEFAULT '[]',
    "la" JSONB NOT NULL DEFAULT '{}',
    "materials" JSONB NOT NULL DEFAULT '[]',
    "implant_udi" VARCHAR(80),
    "rct_detail" JSONB NOT NULL DEFAULT '{}',
    "extraction_detail" JSONB NOT NULL DEFAULT '{}',
    "ortho_detail" JSONB NOT NULL DEFAULT '{}',
    "photos" JSONB NOT NULL DEFAULT '[]',
    "next_visit_days" INTEGER,
    "performed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dental_sittings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."derm_lesions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "lesion_no" INTEGER NOT NULL,
    "body_site_snomed" VARCHAR(40),
    "region_key" VARCHAR(40) NOT NULL,
    "side" "clinical"."Laterality" NOT NULL DEFAULT 'not_applicable',
    "morphology" VARCHAR(40) NOT NULL,
    "size_mm" DECIMAL(5,1),
    "colour" VARCHAR(40),
    "descriptors" JSONB NOT NULL DEFAULT '{}',
    "first_seen_encounter_id" UUID,
    "status" "specialty"."LesionStatus" NOT NULL DEFAULT 'active',
    "sensitive" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "derm_lesions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."derm_lesion_observations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "lesion_id" UUID NOT NULL,
    "encounter_id" UUID,
    "findings" JSONB NOT NULL DEFAULT '{}',
    "itch_nrs" INTEGER,
    "photos" UUID[] DEFAULT ARRAY[]::UUID[],
    "observed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "observed_by" UUID NOT NULL,

    CONSTRAINT "derm_lesion_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."derm_scores" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "score_type" "specialty"."DermScoreType" NOT NULL,
    "components" JSONB NOT NULL DEFAULT '{}',
    "value" DECIMAL(6,2),
    "form_response_id" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "derm_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."derm_biopsies" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "procedure_id" UUID,
    "lesion_id" UUID NOT NULL,
    "specimen_no" VARCHAR(40),
    "lab_order_id" UUID,
    "type" VARCHAR(16) NOT NULL,
    "size_mm" DECIMAL(5,1),
    "dif" BOOLEAN NOT NULL DEFAULT false,
    "clinical_dx" VARCHAR(240),
    "status" "specialty"."BiopsyStatus" NOT NULL DEFAULT 'sent',
    "result_summary" TEXT,
    "malignancy_flag" BOOLEAN NOT NULL DEFAULT false,
    "margins" VARCHAR(80),
    "followup_task_id" UUID,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "derm_biopsies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."derm_phototherapy_courses" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "modality" "specialty"."PhototherapyModality" NOT NULL,
    "skin_type" INTEGER NOT NULL,
    "med_mj" DECIMAL(8,2),
    "start_dose_mj" DECIMAL(8,2) NOT NULL,
    "increment_pct" DECIMAL(5,2) NOT NULL,
    "max_dose_mj" DECIMAL(8,2) NOT NULL,
    "freq_per_week" INTEGER NOT NULL,
    "shielding" JSONB NOT NULL DEFAULT '{}',
    "psoralen" JSONB NOT NULL DEFAULT '{}',
    "device_id" UUID,
    "cumulative_dose_mj" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "sessions_count" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "derm_phototherapy_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."derm_phototherapy_sessions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "dose_mj" DECIMAL(8,2) NOT NULL,
    "erythema_grade" INTEGER NOT NULL DEFAULT 0,
    "adverse" JSONB NOT NULL DEFAULT '{}',
    "technician_id" UUID NOT NULL,
    "charge_intent_id" UUID,
    "administered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "derm_phototherapy_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ent_exams" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "ear" JSONB NOT NULL DEFAULT '{}',
    "nose" JSONB NOT NULL DEFAULT '{}',
    "throat" JSONB NOT NULL DEFAULT '{}',
    "neck" JSONB NOT NULL DEFAULT '{}',
    "drawings" JSONB NOT NULL DEFAULT '{}',
    "stop_bang" INTEGER,
    "epworth" INTEGER,
    "form_response_id" UUID,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ent_exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ent_audiology_tests" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "device_order_id" UUID,
    "test_type" "specialty"."AudioTestType" NOT NULL,
    "source" VARCHAR(12) NOT NULL DEFAULT 'manual',
    "booth_id" VARCHAR(40),
    "audiologist_id" UUID NOT NULL,
    "performed_at" TIMESTAMPTZ(6) NOT NULL,
    "calibration_ok" BOOLEAN NOT NULL DEFAULT false,
    "status" "specialty"."AudioTestStatus" NOT NULL DEFAULT 'ordered',
    "pdf_key" VARCHAR(500),
    "charge_intent_id" UUID,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ent_audiology_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ent_audiogram_thresholds" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "test_id" UUID NOT NULL,
    "ear" "clinical"."Laterality" NOT NULL,
    "conduction" "specialty"."Conduction" NOT NULL,
    "freq_hz" INTEGER NOT NULL,
    "threshold_db" INTEGER NOT NULL,
    "masked" BOOLEAN NOT NULL DEFAULT false,
    "no_response" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ent_audiogram_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ent_audiology_results" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "test_id" UUID NOT NULL,
    "ear" "clinical"."Laterality" NOT NULL,
    "pta_avg" DECIMAL(5,1),
    "degree" "specialty"."HlDegree",
    "type" "specialty"."HlType",
    "configuration" VARCHAR(40),
    "srt" INTEGER,
    "sds_pct" INTEGER,
    "mcl" INTEGER,
    "ucl" INTEGER,
    "tymp_type" "specialty"."TympType",
    "ecv_ml" DECIMAL(4,2),
    "peak_dapa" INTEGER,
    "compliance_ml" DECIMAL(4,2),
    "reflexes" JSONB NOT NULL DEFAULT '{}',
    "oae" JSONB NOT NULL DEFAULT '{}',
    "abr" JSONB NOT NULL DEFAULT '{}',
    "interpretation" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ent_audiology_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ent_hearing_aids" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "ear" "clinical"."Laterality" NOT NULL,
    "model" VARCHAR(120) NOT NULL,
    "serial" VARCHAR(80) NOT NULL,
    "item_id" UUID,
    "status" "specialty"."HearingAidStatus" NOT NULL DEFAULT 'trial',
    "fitting" JSONB NOT NULL DEFAULT '{}',
    "dispensed_at" TIMESTAMPTZ(6),
    "warranty_until" DATE,
    "bill_id" UUID,
    "service_log" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ent_hearing_aids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pulmo_consults" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "smoking" JSONB NOT NULL DEFAULT '{}',
    "exposures" JSONB NOT NULL DEFAULT '[]',
    "scores" JSONB NOT NULL DEFAULT '{}',
    "gold_group" VARCHAR(8),
    "gina_step" INTEGER,
    "dx_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "plan" JSONB NOT NULL DEFAULT '{}',
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pulmo_consults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pulmo_pft_studies" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "device_order_id" UUID,
    "tests" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" VARCHAR(12) NOT NULL DEFAULT 'manual',
    "performed_at" TIMESTAMPTZ(6) NOT NULL,
    "tech_id" UUID,
    "demographics" JSONB NOT NULL DEFAULT '{}',
    "quality_grade" CHAR(1),
    "pre_fvc" DECIMAL(5,2),
    "pre_fev1" DECIMAL(5,2),
    "pre_ratio" DECIMAL(4,3),
    "pre_pef" DECIMAL(5,2),
    "post_fvc" DECIMAL(5,2),
    "post_fev1" DECIMAL(5,2),
    "post_ratio" DECIMAL(4,3),
    "rev_fev1_pct" DECIMAL(5,1),
    "rev_fev1_ml" INTEGER,
    "reversible" BOOLEAN,
    "predicted" JSONB NOT NULL DEFAULT '{}',
    "dlco" JSONB NOT NULL DEFAULT '{}',
    "volumes" JSONB NOT NULL DEFAULT '{}',
    "feno_ppb" INTEGER,
    "sixmwt" JSONB NOT NULL DEFAULT '{}',
    "interpretation_auto" TEXT,
    "interpretation" TEXT,
    "curves_key" VARCHAR(500),
    "pdf_key" VARCHAR(500),
    "status" "specialty"."PftStatus" NOT NULL DEFAULT 'ordered',
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pulmo_pft_studies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pulmo_sleep_studies" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "type" "specialty"."SleepStudyType" NOT NULL,
    "bed_id" UUID,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "tech_id" UUID,
    "device_serial" VARCHAR(60),
    "hookup_checklist" JSONB NOT NULL DEFAULT '{}',
    "ahi" DECIMAL(5,1),
    "scored" JSONB NOT NULL DEFAULT '{}',
    "severity" "specialty"."OsaSeverity",
    "interpretation" TEXT,
    "report_key" VARCHAR(500),
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "status" "specialty"."SleepStudyStatus" NOT NULL DEFAULT 'scheduled',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pulmo_sleep_studies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pulmo_pap_prescriptions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "study_id" UUID,
    "mode" "specialty"."PapMode" NOT NULL,
    "pressure_cm" DECIMAL(4,1),
    "pressure_min" DECIMAL(4,1),
    "pressure_max" DECIMAL(4,1),
    "epap" DECIMAL(4,1),
    "ipap" DECIMAL(4,1),
    "mask" VARCHAR(80),
    "humidifier" BOOLEAN NOT NULL DEFAULT false,
    "device_item_id" UUID,
    "serial" VARCHAR(60),
    "ownership" VARCHAR(12) NOT NULL DEFAULT 'rental',
    "start_date" DATE NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "prescribed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pulmo_pap_prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pulmo_pap_compliance" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "rx_id" UUID NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "usage_hours_avg" DECIMAL(4,2) NOT NULL,
    "pct_nights_ge4h" INTEGER NOT NULL,
    "residual_ahi" DECIMAL(5,1),
    "leak" DECIMAL(6,2),
    "source" VARCHAR(12) NOT NULL,
    "report_key" VARCHAR(500),
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pulmo_pap_compliance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cardio_consults_encounter_id_key" ON "specialty"."cardio_consults"("encounter_id");

-- CreateIndex
CREATE INDEX "cardio_consults_hospital_id_branch_id_created_at_idx" ON "specialty"."cardio_consults"("hospital_id", "branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "cardio_consults_hospital_id_patient_id_created_at_idx" ON "specialty"."cardio_consults"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "cardio_ecg_records_hospital_id_patient_id_acquired_at_idx" ON "specialty"."cardio_ecg_records"("hospital_id", "patient_id", "acquired_at" DESC);

-- CreateIndex
CREATE INDEX "cardio_ecg_records_hospital_id_branch_id_status_acquired_at_idx" ON "specialty"."cardio_ecg_records"("hospital_id", "branch_id", "status", "acquired_at" DESC);

-- CreateIndex
CREATE INDEX "cardio_ecg_records_hospital_id_critical_critical_ack_at_idx" ON "specialty"."cardio_ecg_records"("hospital_id", "critical", "critical_ack_at");

-- CreateIndex
CREATE INDEX "cardio_echo_reports_hospital_id_patient_id_created_at_idx" ON "specialty"."cardio_echo_reports"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "cardio_echo_reports_hospital_id_branch_id_signed_at_idx" ON "specialty"."cardio_echo_reports"("hospital_id", "branch_id", "signed_at");

-- CreateIndex
CREATE INDEX "cardio_stress_tests_hospital_id_patient_id_created_at_idx" ON "specialty"."cardio_stress_tests"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "cardio_stress_tests_hospital_id_branch_id_result_idx" ON "specialty"."cardio_stress_tests"("hospital_id", "branch_id", "result");

-- CreateIndex
CREATE INDEX "cardio_anticoag_enrolments_hospital_id_patient_id_status_idx" ON "specialty"."cardio_anticoag_enrolments"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "cardio_anticoag_enrolments_hospital_id_branch_id_status_idx" ON "specialty"."cardio_anticoag_enrolments"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "cardio_inr_visits_hospital_id_enrolment_id_measured_at_idx" ON "specialty"."cardio_inr_visits"("hospital_id", "enrolment_id", "measured_at" DESC);

-- CreateIndex
CREATE INDEX "dental_charts_hospital_id_branch_id_rebuilt_at_idx" ON "specialty"."dental_charts"("hospital_id", "branch_id", "rebuilt_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_dental_chart_patient" ON "specialty"."dental_charts"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "dental_tooth_events_hospital_id_patient_id_tooth_fdi_record_idx" ON "specialty"."dental_tooth_events"("hospital_id", "patient_id", "tooth_fdi", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "dental_tooth_events_hospital_id_branch_id_recorded_at_idx" ON "specialty"."dental_tooth_events"("hospital_id", "branch_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "dental_tooth_events_hospital_id_plan_item_id_idx" ON "specialty"."dental_tooth_events"("hospital_id", "plan_item_id");

-- CreateIndex
CREATE INDEX "dental_treatment_plans_hospital_id_patient_id_status_idx" ON "specialty"."dental_treatment_plans"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "dental_treatment_plans_hospital_id_branch_id_status_created_idx" ON "specialty"."dental_treatment_plans"("hospital_id", "branch_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_dental_plan_no" ON "specialty"."dental_treatment_plans"("hospital_id", "plan_no");

-- CreateIndex
CREATE INDEX "dental_plan_items_hospital_id_plan_id_status_idx" ON "specialty"."dental_plan_items"("hospital_id", "plan_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_dental_plan_item_seq" ON "specialty"."dental_plan_items"("plan_id", "seq");

-- CreateIndex
CREATE INDEX "dental_sittings_hospital_id_patient_id_performed_at_idx" ON "specialty"."dental_sittings"("hospital_id", "patient_id", "performed_at" DESC);

-- CreateIndex
CREATE INDEX "dental_sittings_hospital_id_branch_id_performed_at_idx" ON "specialty"."dental_sittings"("hospital_id", "branch_id", "performed_at" DESC);

-- CreateIndex
CREATE INDEX "dental_sittings_hospital_id_plan_id_idx" ON "specialty"."dental_sittings"("hospital_id", "plan_id");

-- CreateIndex
CREATE INDEX "derm_lesions_hospital_id_patient_id_status_idx" ON "specialty"."derm_lesions"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "derm_lesions_hospital_id_branch_id_status_idx" ON "specialty"."derm_lesions"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_derm_lesion_no" ON "specialty"."derm_lesions"("hospital_id", "patient_id", "lesion_no");

-- CreateIndex
CREATE INDEX "derm_lesion_observations_hospital_id_lesion_id_observed_at_idx" ON "specialty"."derm_lesion_observations"("hospital_id", "lesion_id", "observed_at" DESC);

-- CreateIndex
CREATE INDEX "derm_scores_hospital_id_patient_id_score_type_recorded_at_idx" ON "specialty"."derm_scores"("hospital_id", "patient_id", "score_type", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "derm_scores_hospital_id_branch_id_score_type_idx" ON "specialty"."derm_scores"("hospital_id", "branch_id", "score_type");

-- CreateIndex
CREATE INDEX "derm_biopsies_hospital_id_branch_id_status_idx" ON "specialty"."derm_biopsies"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "derm_biopsies_hospital_id_patient_id_created_at_idx" ON "specialty"."derm_biopsies"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "derm_biopsies_hospital_id_malignancy_flag_followup_task_id_idx" ON "specialty"."derm_biopsies"("hospital_id", "malignancy_flag", "followup_task_id");

-- CreateIndex
CREATE INDEX "derm_phototherapy_courses_hospital_id_patient_id_status_idx" ON "specialty"."derm_phototherapy_courses"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "derm_phototherapy_courses_hospital_id_branch_id_status_idx" ON "specialty"."derm_phototherapy_courses"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "derm_phototherapy_sessions_hospital_id_course_id_administer_idx" ON "specialty"."derm_phototherapy_sessions"("hospital_id", "course_id", "administered_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_phototherapy_session_seq" ON "specialty"."derm_phototherapy_sessions"("course_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "ent_exams_encounter_id_key" ON "specialty"."ent_exams"("encounter_id");

-- CreateIndex
CREATE INDEX "ent_exams_hospital_id_branch_id_created_at_idx" ON "specialty"."ent_exams"("hospital_id", "branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ent_exams_hospital_id_patient_id_created_at_idx" ON "specialty"."ent_exams"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ent_audiology_tests_hospital_id_patient_id_performed_at_idx" ON "specialty"."ent_audiology_tests"("hospital_id", "patient_id", "performed_at" DESC);

-- CreateIndex
CREATE INDEX "ent_audiology_tests_hospital_id_branch_id_status_performed__idx" ON "specialty"."ent_audiology_tests"("hospital_id", "branch_id", "status", "performed_at" DESC);

-- CreateIndex
CREATE INDEX "ent_audiogram_thresholds_hospital_id_test_id_idx" ON "specialty"."ent_audiogram_thresholds"("hospital_id", "test_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_audiogram_point" ON "specialty"."ent_audiogram_thresholds"("test_id", "ear", "conduction", "freq_hz");

-- CreateIndex
CREATE INDEX "ent_audiology_results_hospital_id_test_id_idx" ON "specialty"."ent_audiology_results"("hospital_id", "test_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_audiology_result_ear" ON "specialty"."ent_audiology_results"("test_id", "ear");

-- CreateIndex
CREATE UNIQUE INDEX "ent_hearing_aids_serial_key" ON "specialty"."ent_hearing_aids"("serial");

-- CreateIndex
CREATE INDEX "ent_hearing_aids_hospital_id_patient_id_status_idx" ON "specialty"."ent_hearing_aids"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "ent_hearing_aids_hospital_id_branch_id_status_idx" ON "specialty"."ent_hearing_aids"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pulmo_consults_encounter_id_key" ON "specialty"."pulmo_consults"("encounter_id");

-- CreateIndex
CREATE INDEX "pulmo_consults_hospital_id_branch_id_created_at_idx" ON "specialty"."pulmo_consults"("hospital_id", "branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pulmo_consults_hospital_id_patient_id_created_at_idx" ON "specialty"."pulmo_consults"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pulmo_pft_studies_hospital_id_patient_id_performed_at_idx" ON "specialty"."pulmo_pft_studies"("hospital_id", "patient_id", "performed_at" DESC);

-- CreateIndex
CREATE INDEX "pulmo_pft_studies_hospital_id_branch_id_status_idx" ON "specialty"."pulmo_pft_studies"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "pulmo_sleep_studies_hospital_id_patient_id_scheduled_at_idx" ON "specialty"."pulmo_sleep_studies"("hospital_id", "patient_id", "scheduled_at" DESC);

-- CreateIndex
CREATE INDEX "pulmo_sleep_studies_hospital_id_branch_id_status_scheduled__idx" ON "specialty"."pulmo_sleep_studies"("hospital_id", "branch_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "pulmo_pap_prescriptions_hospital_id_patient_id_status_idx" ON "specialty"."pulmo_pap_prescriptions"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "pulmo_pap_prescriptions_hospital_id_branch_id_status_idx" ON "specialty"."pulmo_pap_prescriptions"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "pulmo_pap_compliance_hospital_id_rx_id_period_from_idx" ON "specialty"."pulmo_pap_compliance"("hospital_id", "rx_id", "period_from" DESC);

-- AddForeignKey
ALTER TABLE "specialty"."cardio_inr_visits" ADD CONSTRAINT "cardio_inr_visits_enrolment_id_fkey" FOREIGN KEY ("enrolment_id") REFERENCES "specialty"."cardio_anticoag_enrolments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."dental_plan_items" ADD CONSTRAINT "dental_plan_items_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "specialty"."dental_treatment_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."derm_lesion_observations" ADD CONSTRAINT "derm_lesion_observations_lesion_id_fkey" FOREIGN KEY ("lesion_id") REFERENCES "specialty"."derm_lesions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."derm_biopsies" ADD CONSTRAINT "derm_biopsies_lesion_id_fkey" FOREIGN KEY ("lesion_id") REFERENCES "specialty"."derm_lesions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."derm_phototherapy_sessions" ADD CONSTRAINT "derm_phototherapy_sessions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "specialty"."derm_phototherapy_courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."ent_audiogram_thresholds" ADD CONSTRAINT "ent_audiogram_thresholds_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "specialty"."ent_audiology_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."ent_audiology_results" ADD CONSTRAINT "ent_audiology_results_test_id_fkey" FOREIGN KEY ("test_id") REFERENCES "specialty"."ent_audiology_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."pulmo_pap_prescriptions" ADD CONSTRAINT "pulmo_pap_prescriptions_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "specialty"."pulmo_sleep_studies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."pulmo_pap_compliance" ADD CONSTRAINT "pulmo_pap_compliance_rx_id_fkey" FOREIGN KEY ("rx_id") REFERENCES "specialty"."pulmo_pap_prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- §B.1  OP-029 · Cardiology
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.1.1  The intervals are intervals ─────────────────────────────────────
--
-- Ranges wide enough to hold every real tracing and narrow enough to catch a
-- transcription slip. A PR of 1600 ms is a decimal point; a QRS of 12 ms is a
-- centisecond entered as a millisecond.
ALTER TABLE "specialty"."cardio_ecg_records"
  ADD CONSTRAINT "ecg_intervals_are_plausible"
  CHECK (
        ("hr"     IS NULL OR "hr"     BETWEEN 15 AND 300)
    AND ("pr_ms"  IS NULL OR "pr_ms"  BETWEEN 40 AND 600)
    AND ("qrs_ms" IS NULL OR "qrs_ms" BETWEEN 40 AND 300)
    AND ("qt_ms"  IS NULL OR "qt_ms"  BETWEEN 150 AND 800)
    AND ("axis_deg" IS NULL OR "axis_deg" BETWEEN -180 AND 180)
  );

-- ── §B.1.2  QTc is Bazett, computed, never typed ────────────────────────────
--
-- QTc = QT / √RR, RR in seconds = 60 / rate. It is the number a pharmacist
-- screens a QT-prolonging drug against, so the number in the note and the
-- number in the alert are the same number by construction. A tracing with no
-- rate gets no corrected interval, rather than a wrong one.
CREATE OR REPLACE FUNCTION specialty.derive_qtc()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  IF NEW.qt_ms IS NULL OR NEW.hr IS NULL OR NEW.hr <= 0 THEN
    NEW.qtc_ms := NULL;
  ELSE
    NEW.qtc_ms := round(NEW.qt_ms::numeric / sqrt(60.0 / NEW.hr::numeric))::int;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "qtc_is_derived_never_typed"
  BEFORE INSERT OR UPDATE OF qt_ms, hr, qtc_ms ON "specialty"."cardio_ecg_records"
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_qtc();

-- ── §B.1.3  A critical tracing is not final until somebody was told ─────────
--
-- The framework already refuses to let a result mark itself reviewed. This is
-- the stronger form the specialty needs: a STEMI, a complete block or a VT
-- cannot reach `final` until an acknowledgement names a person and a time.
CREATE OR REPLACE FUNCTION specialty.critical_ecg_is_acknowledged()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  IF NEW.status = 'final' AND NEW.critical
     AND (NEW.critical_ack_by IS NULL OR NEW.critical_ack_at IS NULL) THEN
    RAISE EXCEPTION 'This ECG is flagged critical and cannot be signed off until the acknowledgement records who was told and when (OP-029 §B.1.3). A tracing that sat in a queue is indistinguishable afterwards from one that was seen.'
      USING ERRCODE = 'OP029';
  END IF;

  -- A read is a read: a tracing that carries an interpretation carries the
  -- person who made it.
  IF NEW.status IN ('preliminary', 'final')
     AND (NEW.read_by IS NULL OR NEW.read_at IS NULL) THEN
    RAISE EXCEPTION 'An ECG read to % must name the reader and the time it was read (OP-029 §B.1.3).', NEW.status
      USING ERRCODE = 'OP029';
  END IF;

  -- The acknowledgement is a pair. Half of one is a note, not a handover.
  IF (NEW.critical_ack_by IS NULL) <> (NEW.critical_ack_at IS NULL) THEN
    RAISE EXCEPTION 'A critical acknowledgement needs both who acknowledged it and when (OP-029 §B.1.3).'
      USING ERRCODE = 'OP029';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "critical_ecg_is_acknowledged"
  BEFORE INSERT OR UPDATE ON "specialty"."cardio_ecg_records"
  FOR EACH ROW EXECUTE FUNCTION specialty.critical_ecg_is_acknowledged();

-- ── §B.1.4  An ejection fraction is a fraction; a class is a class ──────────
ALTER TABLE "specialty"."cardio_echo_reports"
  ADD CONSTRAINT "ef_is_a_percentage"
  CHECK ("ef_pct" IS NULL OR "ef_pct" BETWEEN 5 AND 85);

ALTER TABLE "specialty"."cardio_consults"
  ADD CONSTRAINT "functional_classes_are_one_to_four"
  CHECK (("nyha" IS NULL OR "nyha" BETWEEN 1 AND 4)
     AND ("ccs"  IS NULL OR "ccs"  BETWEEN 1 AND 4));

-- ── §B.1.5  A stress test that ended says why ──────────────────────────────
--
-- "Target heart rate reached" and "chest pain with 3 mm of ST depression" are
-- different tests with the same result column, and the difference is the whole
-- report.
ALTER TABLE "specialty"."cardio_stress_tests"
  ADD CONSTRAINT "a_finished_stress_test_says_why_it_stopped"
  CHECK ("result" IS NULL
     OR ("termination_reason" IS NOT NULL AND length(btrim("termination_reason")) >= 4));

-- ── §B.1.6  The dose grid adds up, and a DOAC has no INR window ────────────
--
-- Seven daily doses and a weekly total are one fact written twice. Warfarin is
-- the drug where the two drifting apart is a bleed or a stroke, and the nurse
-- reads the grid while the doctor wrote the total.
CREATE OR REPLACE FUNCTION specialty.warfarin_grid_adds_up()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_drug specialty."AnticoagDrug";
  v_len int;
  v_sum numeric;
BEGIN
  SELECT drug INTO v_drug FROM specialty.cardio_anticoag_enrolments WHERE id = NEW.enrolment_id;

  IF v_drug = 'doac' THEN
    RAISE EXCEPTION 'A direct oral anticoagulant is not monitored by INR, so this visit has nowhere to belong (OP-029 §B.1.6). Record it against the right enrolment, or against a vitamin-K antagonist.'
      USING ERRCODE = 'OP029';
  END IF;

  IF jsonb_typeof(NEW.dose_grid) <> 'array' THEN
    RAISE EXCEPTION 'The dose grid is seven daily doses, Monday first (OP-029 §B.1.6).'
      USING ERRCODE = 'OP029';
  END IF;

  SELECT jsonb_array_length(NEW.dose_grid) INTO v_len;
  IF v_len <> 7 THEN
    RAISE EXCEPTION 'The dose grid has % entries; a week has seven (OP-029 §B.1.6).', v_len
      USING ERRCODE = 'OP029';
  END IF;

  SELECT coalesce(sum((e#>>'{}')::numeric), 0) INTO v_sum
  FROM jsonb_array_elements(NEW.dose_grid) e;

  -- Two decimal places of tolerance: a half-tablet is 0.5 mg, and the sum of
  -- seven two-place numbers is exact in numeric.
  IF abs(v_sum - NEW.weekly_dose_mg) > 0.01 THEN
    RAISE EXCEPTION 'The seven daily doses add up to % mg but the weekly dose says % mg (OP-029 §B.1.6). The nurse reads the grid and the doctor wrote the total; they have to be the same number.', v_sum, NEW.weekly_dose_mg
      USING ERRCODE = 'OP029';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "warfarin_grid_adds_up"
  BEFORE INSERT OR UPDATE ON "specialty"."cardio_inr_visits"
  FOR EACH ROW EXECUTE FUNCTION specialty.warfarin_grid_adds_up();

ALTER TABLE "specialty"."cardio_inr_visits"
  ADD CONSTRAINT "inr_is_an_inr"
  CHECK ("inr" BETWEEN 0.5 AND 20.0);

-- A therapeutic window belongs to a drug that has one. A target INR written
-- beside a DOAC is a clinic chasing a number that means nothing.
ALTER TABLE "specialty"."cardio_anticoag_enrolments"
  ADD CONSTRAINT "inr_window_belongs_to_a_monitored_drug"
  CHECK (
    CASE WHEN "drug" = 'doac'
      THEN "target_inr_low" IS NULL AND "target_inr_high" IS NULL
      ELSE "target_inr_low" IS NOT NULL AND "target_inr_high" IS NOT NULL
           AND "target_inr_low" < "target_inr_high"
    END
  );


-- ─────────────────────────────────────────────────────────────────────────────
-- §B.2  OP-030 · Pulmonology
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.2.1  The ratio and the reversibility are derived ────────────────────
--
-- FEV1/FVC below 0.70 is obstruction; a 12 % *and* 200 mL improvement after a
-- bronchodilator is asthma rather than COPD. Both are arithmetic on numbers the
-- device already produced, and a report that says "no significant
-- reversibility" over 340 mL and 15 % is a lifetime of the wrong inhaler,
-- invisible on paper afterwards. There is no box.
CREATE OR REPLACE FUNCTION specialty.derive_pft_numbers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  NEW.pre_ratio := CASE
    WHEN NEW.pre_fev1 IS NULL OR NEW.pre_fvc IS NULL OR NEW.pre_fvc <= 0 THEN NULL
    ELSE round(NEW.pre_fev1 / NEW.pre_fvc, 3)
  END;

  NEW.post_ratio := CASE
    WHEN NEW.post_fev1 IS NULL OR NEW.post_fvc IS NULL OR NEW.post_fvc <= 0 THEN NULL
    ELSE round(NEW.post_fev1 / NEW.post_fvc, 3)
  END;

  IF NEW.pre_fev1 IS NULL OR NEW.post_fev1 IS NULL OR NEW.pre_fev1 <= 0 THEN
    NEW.rev_fev1_pct := NULL;
    NEW.rev_fev1_ml  := NULL;
    NEW.reversible   := NULL;
  ELSE
    NEW.rev_fev1_pct := round((NEW.post_fev1 - NEW.pre_fev1) / NEW.pre_fev1 * 100, 1);
    -- The columns are litres; the threshold is in millilitres.
    NEW.rev_fev1_ml  := round((NEW.post_fev1 - NEW.pre_fev1) * 1000)::int;
    -- ATS/ERS: both thresholds, not either.
    NEW.reversible   := (NEW.rev_fev1_pct >= 12 AND NEW.rev_fev1_ml >= 200);
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "pft_ratios_are_derived_never_typed"
  BEFORE INSERT OR UPDATE OF pre_fvc, pre_fev1, post_fvc, post_fev1,
                             pre_ratio, post_ratio, rev_fev1_pct, rev_fev1_ml, reversible
  ON "specialty"."pulmo_pft_studies"
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_pft_numbers();

-- ── §B.2.2  An unacceptable effort is not signed ───────────────────────────
--
-- A grade F is not a poor result. The patient coughed, or stopped early, or the
-- seal leaked: there is no measurement in it. Signing one puts a number into a
-- trend that will be compared against real ones for the next twenty years.
CREATE OR REPLACE FUNCTION specialty.unacceptable_pft_is_not_signed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  IF NEW.signed_at IS NOT NULL AND upper(coalesce(NEW.quality_grade, '')) = 'F' THEN
    RAISE EXCEPTION 'This study is graded F — an unacceptable effort — and cannot be signed (OP-030 §B.2.2). It is not a poor result, it is not a result; repeat the manoeuvre.'
      USING ERRCODE = 'OP030';
  END IF;

  IF NEW.status IN ('interpreted', 'reviewed') AND NEW.quality_grade IS NULL THEN
    RAISE EXCEPTION 'An interpreted study carries its ATS/ERS quality grade (OP-030 §B.2.2). Without it nobody downstream can tell a measurement from an attempt.'
      USING ERRCODE = 'OP030';
  END IF;

  IF NEW.signed_at IS NOT NULL AND NEW.signed_by IS NULL THEN
    RAISE EXCEPTION 'A signed study names its signer (OP-030 §B.2.2).'
      USING ERRCODE = 'OP030';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "unacceptable_pft_is_not_signed"
  BEFORE INSERT OR UPDATE ON "specialty"."pulmo_pft_studies"
  FOR EACH ROW EXECUTE FUNCTION specialty.unacceptable_pft_is_not_signed();

ALTER TABLE "specialty"."pulmo_pft_studies"
  ADD CONSTRAINT "pft_grade_is_ats_ers"
  CHECK ("quality_grade" IS NULL OR upper("quality_grade") IN ('A','B','C','D','E','F'));

-- ── §B.2.3  Apnoea severity is derived from the index ──────────────────────
--
-- The bands are published and fixed — 5, 15, 30 — and the severity is what an
-- insurer, a device supplier and a licensing authority read. Computed, so a
-- 14.6 cannot be rounded up to fund a machine and a 31 cannot be rounded down
-- to avoid a conversation about driving.
CREATE OR REPLACE FUNCTION specialty.derive_osa_severity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  NEW.severity := CASE
    WHEN NEW.ahi IS NULL   THEN NULL
    WHEN NEW.ahi <  5      THEN 'none'::specialty."OsaSeverity"
    WHEN NEW.ahi < 15      THEN 'mild'::specialty."OsaSeverity"
    WHEN NEW.ahi < 30      THEN 'moderate'::specialty."OsaSeverity"
    ELSE                        'severe'::specialty."OsaSeverity"
  END;

  IF NEW.status IN ('scored', 'reported') AND NEW.ahi IS NULL THEN
    RAISE EXCEPTION 'A scored sleep study carries its apnoea-hypopnoea index (OP-030 §B.2.3). Everything downstream — severity, the machine, the licence — is decided on it.'
      USING ERRCODE = 'OP030';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "osa_severity_is_derived_never_typed"
  BEFORE INSERT OR UPDATE ON "specialty"."pulmo_sleep_studies"
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_osa_severity();

ALTER TABLE "specialty"."pulmo_sleep_studies"
  ADD CONSTRAINT "ahi_is_an_index"
  CHECK ("ahi" IS NULL OR "ahi" BETWEEN 0 AND 200);

-- ── §B.2.4  A PAP prescription carries the pressures its mode needs ────────
--
-- One pressure for CPAP, a range for APAP, two ordered pressures for bilevel.
-- IPAP below EPAP is a machine that cannot deliver a breath, and the person who
-- discovers it is the supplier, or the patient.
ALTER TABLE "specialty"."pulmo_pap_prescriptions"
  ADD CONSTRAINT "pap_pressures_match_the_mode"
  CHECK (
    CASE "mode"
      WHEN 'cpap' THEN "pressure_cm" IS NOT NULL
                   AND "pressure_min" IS NULL AND "pressure_max" IS NULL
                   AND "epap" IS NULL AND "ipap" IS NULL
      WHEN 'apap' THEN "pressure_min" IS NOT NULL AND "pressure_max" IS NOT NULL
                   AND "pressure_min" < "pressure_max"
                   AND "pressure_cm" IS NULL AND "epap" IS NULL AND "ipap" IS NULL
      ELSE             "epap" IS NOT NULL AND "ipap" IS NOT NULL
                   AND "epap" < "ipap"
                   AND "pressure_cm" IS NULL
    END
  );

ALTER TABLE "specialty"."pulmo_pap_prescriptions"
  ADD CONSTRAINT "pap_pressures_are_in_range"
  CHECK (
        ("pressure_cm"  IS NULL OR "pressure_cm"  BETWEEN 4 AND 25)
    AND ("pressure_min" IS NULL OR "pressure_min" BETWEEN 4 AND 25)
    AND ("pressure_max" IS NULL OR "pressure_max" BETWEEN 4 AND 25)
    AND ("epap" IS NULL OR "epap" BETWEEN 3 AND 25)
    AND ("ipap" IS NULL OR "ipap" BETWEEN 4 AND 30)
  );

ALTER TABLE "specialty"."pulmo_pap_compliance"
  ADD CONSTRAINT "compliance_period_runs_forwards"
  CHECK ("period_from" <= "period_to");

ALTER TABLE "specialty"."pulmo_pap_compliance"
  ADD CONSTRAINT "compliance_figures_are_plausible"
  CHECK ("usage_hours_avg" BETWEEN 0 AND 24 AND "pct_nights_ge4h" BETWEEN 0 AND 100);


-- ─────────────────────────────────────────────────────────────────────────────
-- §B.3  OP-028 · ENT and audiology
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.3.1  A threshold is a threshold, at a real frequency ────────────────
--
-- Below −10 dB HL is not a hearing threshold; above 120 is past the output of
-- the audiometer. Both are transcription. Bone conduction stops at 4 kHz
-- because bone vibrators have no calibrated output above it, so a bone
-- threshold at 8 kHz is a mislabelled transducer.
ALTER TABLE "specialty"."ent_audiogram_thresholds"
  ADD CONSTRAINT "threshold_is_within_the_audiometer"
  CHECK ("threshold_db" BETWEEN -10 AND 120);

ALTER TABLE "specialty"."ent_audiogram_thresholds"
  ADD CONSTRAINT "threshold_names_an_audiometric_frequency"
  CHECK (
    CASE "conduction"
      WHEN 'ac' THEN "freq_hz" IN (125, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 6000, 8000)
      ELSE           "freq_hz" IN (250, 500, 750, 1000, 1500, 2000, 3000, 4000)
    END
  );

-- An audiogram has two curves. `bilateral` on a threshold is a graph that
-- cannot be drawn.
ALTER TABLE "specialty"."ent_audiogram_thresholds"
  ADD CONSTRAINT "threshold_names_one_ear"
  CHECK ("ear" IN ('left', 'right'));

ALTER TABLE "specialty"."ent_audiology_results"
  ADD CONSTRAINT "audiology_result_names_one_ear"
  CHECK ("ear" IN ('left', 'right'));

ALTER TABLE "specialty"."ent_hearing_aids"
  ADD CONSTRAINT "a_hearing_aid_is_fitted_to_one_ear"
  CHECK ("ear" IN ('left', 'right'));

-- ── §B.3.2  Bone conduction is not worse than air ──────────────────────────
--
-- Sound reaching the cochlea through the skull cannot need more energy than
-- sound reaching it through the ear canal. A negative air-bone gap beyond a
-- step of measurement noise is a masking error or a swapped transducer — the
-- commonest mistake in audiometry, and one that reads as a diagnosis. The check
-- runs in both directions, because either row can be the one entered second.
CREATE OR REPLACE FUNCTION specialty.bone_is_not_worse_than_air()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_air int;
  v_bone int;
BEGIN
  IF NEW.no_response THEN
    -- No response at the limit is not a threshold and cannot be compared.
    RETURN NEW;
  END IF;

  IF NEW.conduction = 'bc' THEN
    v_bone := NEW.threshold_db;
    SELECT threshold_db INTO v_air
      FROM specialty.ent_audiogram_thresholds
     WHERE test_id = NEW.test_id AND ear = NEW.ear AND conduction = 'ac'
       AND freq_hz = NEW.freq_hz AND NOT no_response
       AND id IS DISTINCT FROM NEW.id;
  ELSE
    v_air := NEW.threshold_db;
    SELECT threshold_db INTO v_bone
      FROM specialty.ent_audiogram_thresholds
     WHERE test_id = NEW.test_id AND ear = NEW.ear AND conduction = 'bc'
       AND freq_hz = NEW.freq_hz AND NOT no_response
       AND id IS DISTINCT FROM NEW.id;
  END IF;

  -- One 5 dB step of tolerance. Beyond that it is not noise.
  IF v_air IS NOT NULL AND v_bone IS NOT NULL AND v_bone > v_air + 10 THEN
    RAISE EXCEPTION 'At % Hz in the % ear the bone threshold (% dB) is worse than the air threshold (% dB) (OP-028 §B.3.2). Sound through the skull cannot need more energy than sound through the canal — check the masking and the transducer, and repeat the frequency.',
      NEW.freq_hz, NEW.ear, v_bone, v_air
      USING ERRCODE = 'OP028';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "bone_is_not_worse_than_air"
  BEFORE INSERT OR UPDATE ON "specialty"."ent_audiogram_thresholds"
  FOR EACH ROW EXECUTE FUNCTION specialty.bone_is_not_worse_than_air();

-- ── §B.3.3  The average, the degree and the type are derived ───────────────
--
-- PTA at 500, 1000, 2000 and 4000 Hz, the ASHA degree band it falls in, and the
-- conductive/sensorineural split from the air-bone gap. A disability
-- certificate, a hearing-aid subsidy and a school placement are issued on these
-- three, so they are computed from the thresholds and there is nowhere to type
-- them.
CREATE OR REPLACE FUNCTION specialty.derive_audiology_result()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_air numeric;
  v_bone numeric;
  v_air_n int;
  v_bone_n int;
  v_gap numeric;
BEGIN
  SELECT avg(threshold_db), count(*) INTO v_air, v_air_n
    FROM specialty.ent_audiogram_thresholds
   WHERE test_id = NEW.test_id AND ear = NEW.ear AND conduction = 'ac'
     AND freq_hz IN (500, 1000, 2000, 4000) AND NOT no_response;

  SELECT avg(threshold_db), count(*) INTO v_bone, v_bone_n
    FROM specialty.ent_audiogram_thresholds
   WHERE test_id = NEW.test_id AND ear = NEW.ear AND conduction = 'bc'
     AND freq_hz IN (500, 1000, 2000, 4000) AND NOT no_response;

  -- All four frequencies or no average. A three-frequency mean reported as a
  -- four-frequency average is how a borderline case crosses a threshold.
  IF v_air_n < 4 THEN
    NEW.pta_avg := NULL;
    NEW.degree  := NULL;
    NEW.type    := NULL;
    RETURN NEW;
  END IF;

  NEW.pta_avg := round(v_air, 1);

  NEW.degree := CASE
    WHEN v_air <= 15 THEN 'normal'::specialty."HlDegree"
    WHEN v_air <= 25 THEN 'slight'::specialty."HlDegree"
    WHEN v_air <= 40 THEN 'mild'::specialty."HlDegree"
    WHEN v_air <= 55 THEN 'moderate'::specialty."HlDegree"
    WHEN v_air <= 70 THEN 'mod_severe'::specialty."HlDegree"
    WHEN v_air <= 90 THEN 'severe'::specialty."HlDegree"
    ELSE                  'profound'::specialty."HlDegree"
  END;

  IF v_bone_n < 4 THEN
    -- Without a bone average the gap is unknown, and an unknown gap is not a
    -- normal one. The type stays empty rather than defaulting to sensorineural.
    NEW.type := NULL;
  ELSE
    v_gap := v_air - v_bone;
    NEW.type := CASE
      WHEN v_gap > 10 AND v_bone <= 25 THEN 'conductive'::specialty."HlType"
      WHEN v_gap > 10                  THEN 'mixed'::specialty."HlType"
      WHEN v_air  > 25                 THEN 'snhl'::specialty."HlType"
      ELSE                                  'normal'::specialty."HlType"
    END;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "audiology_result_is_derived_never_typed"
  BEFORE INSERT OR UPDATE ON "specialty"."ent_audiology_results"
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_audiology_result();

-- A threshold changing after the result was written must move the result with
-- it, or the graph and the summary describe different ears.
CREATE OR REPLACE FUNCTION specialty.recompute_audiology_results()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_test uuid;
  v_ear clinical."Laterality";
BEGIN
  v_test := coalesce(NEW.test_id, OLD.test_id);
  v_ear  := coalesce(NEW.ear, OLD.ear);
  -- The no-op update re-fires the BEFORE trigger above, which does the work.
  UPDATE specialty.ent_audiology_results
     SET updated_at = now()
   WHERE test_id = v_test AND ear = v_ear;
  RETURN NULL;
END $$;

CREATE TRIGGER "thresholds_move_the_result_with_them"
  AFTER INSERT OR UPDATE OR DELETE ON "specialty"."ent_audiogram_thresholds"
  FOR EACH ROW EXECUTE FUNCTION specialty.recompute_audiology_results();

-- ── §B.3.4  An uncalibrated booth does not produce a signable test ─────────
--
-- The day's biological check is the entire basis of an audiometric number. A
-- test run without one is not a worse test.
CREATE OR REPLACE FUNCTION specialty.uncalibrated_booth_does_not_sign()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  IF NEW.status IN ('signed', 'reviewed') AND NOT NEW.calibration_ok THEN
    RAISE EXCEPTION 'This test has no calibration check recorded and cannot be signed (OP-028 §B.3.4). A threshold from an unverified audiometer is not a measurement of hearing.'
      USING ERRCODE = 'OP028';
  END IF;

  IF NEW.status IN ('signed', 'reviewed')
     AND (NEW.signed_by IS NULL OR NEW.signed_at IS NULL) THEN
    RAISE EXCEPTION 'A signed audiology test names its signer and the time (OP-028 §B.3.4).'
      USING ERRCODE = 'OP028';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "uncalibrated_booth_does_not_sign"
  BEFORE INSERT OR UPDATE ON "specialty"."ent_audiology_tests"
  FOR EACH ROW EXECUTE FUNCTION specialty.uncalibrated_booth_does_not_sign();

ALTER TABLE "specialty"."ent_exams"
  ADD CONSTRAINT "ent_questionnaire_scores_are_in_range"
  CHECK (("stop_bang" IS NULL OR "stop_bang" BETWEEN 0 AND 8)
     AND ("epworth"   IS NULL OR "epworth"   BETWEEN 0 AND 24));


-- ─────────────────────────────────────────────────────────────────────────────
-- §B.4  OP-026 · Dental
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.4.1  A tooth number is a real tooth ─────────────────────────────────
--
-- FDI two-digit notation: quadrant, then position. 19, 29 and 50 are not teeth,
-- and a typo in the quadrant digit moves the work to the other side of the
-- mouth while reading as perfectly plausible.
CREATE OR REPLACE FUNCTION specialty.is_fdi_tooth(p int)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p IS NOT NULL
     AND (   (p BETWEEN 11 AND 18) OR (p BETWEEN 21 AND 28)
          OR (p BETWEEN 31 AND 38) OR (p BETWEEN 41 AND 48)
          OR (p BETWEEN 51 AND 55) OR (p BETWEEN 61 AND 65)
          OR (p BETWEEN 71 AND 75) OR (p BETWEEN 81 AND 85));
$$;

ALTER TABLE "specialty"."dental_tooth_events"
  ADD CONSTRAINT "tooth_number_is_a_real_tooth"
  CHECK (specialty.is_fdi_tooth("tooth_fdi"));

-- ── §B.4.2  A surface belongs to the tooth it is charted on ────────────────
--
-- Incisors and canines have an incisal edge; premolars and molars have an
-- occlusal table. Neither has the other, and an occlusal restoration charted on
-- an upper central incisor is a line on a claim that no dentist can have done.
CREATE OR REPLACE FUNCTION specialty.tooth_surfaces_exist()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_position int := NEW.tooth_fdi % 10;
  v_anterior boolean := v_position BETWEEN 1 AND 3;
  s text;
BEGIN
  FOREACH s IN ARRAY NEW.surfaces LOOP
    IF s NOT IN ('M','O','D','B','L','P','I','R') THEN
      RAISE EXCEPTION 'Surface "%" is not a tooth surface (OP-026 §B.4.2). Use M, O, D, B, L, P, I or R.', s
        USING ERRCODE = 'OP026';
    END IF;
    IF v_anterior AND s = 'O' THEN
      RAISE EXCEPTION 'Tooth % is an anterior tooth: it has an incisal edge (I), not an occlusal surface (O) (OP-026 §B.4.2).', NEW.tooth_fdi
        USING ERRCODE = 'OP026';
    END IF;
    IF NOT v_anterior AND s = 'I' THEN
      RAISE EXCEPTION 'Tooth % is a posterior tooth: it has an occlusal surface (O), not an incisal edge (I) (OP-026 §B.4.2).', NEW.tooth_fdi
        USING ERRCODE = 'OP026';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

-- ── §B.4.3  An extracted tooth receives no new work ────────────────────────
--
-- Once the log says a tooth has gone, nothing new is planned or done on it —
-- except the handful of acts that are *about* the empty socket: an implant, a
-- pontic, a denture tooth, a graft. Planning a crown on a missing tooth is a
-- consent failure, a billing failure, and the moment somebody looks in a mouth
-- for a tooth that is not there.
CREATE OR REPLACE FUNCTION specialty.absent_tooth_receives_no_new_work()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_absent_since timestamptz;
  v_code text := lower(btrim(NEW.condition_code));
BEGIN
  IF NEW.status NOT IN ('planned', 'done') THEN
    RETURN NEW;
  END IF;

  -- Acts that exist precisely because the tooth does not.
  IF v_code IN ('implant', 'implant_crown', 'implant_placement', 'bridge_pontic',
                'pontic', 'denture_tooth', 'socket_graft', 'ridge_preservation',
                'missing', 'congenitally_absent', 'space_maintainer') THEN
    RETURN NEW;
  END IF;

  SELECT max(recorded_at) INTO v_absent_since
    FROM specialty.dental_tooth_events
   WHERE hospital_id = NEW.hospital_id
     AND patient_id  = NEW.patient_id
     AND tooth_fdi   = NEW.tooth_fdi
     AND status IN ('existing', 'done')
     AND lower(btrim(condition_code)) IN ('extraction', 'extracted', 'missing',
                                          'congenitally_absent', 'avulsed')
     AND id IS DISTINCT FROM NEW.id;

  IF v_absent_since IS NOT NULL THEN
    RAISE EXCEPTION 'Tooth % has been recorded absent since % and cannot take new work (OP-026 §B.4.3). If an implant or a pontic is going into the space, chart it as that; if the tooth is present, correct the chart first.',
      NEW.tooth_fdi, to_char(v_absent_since, 'DD Mon YYYY')
      USING ERRCODE = 'OP026';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "tooth_surfaces_exist"
  BEFORE INSERT ON "specialty"."dental_tooth_events"
  FOR EACH ROW EXECUTE FUNCTION specialty.tooth_surfaces_exist();

CREATE TRIGGER "absent_tooth_receives_no_new_work"
  BEFORE INSERT ON "specialty"."dental_tooth_events"
  FOR EACH ROW EXECUTE FUNCTION specialty.absent_tooth_receives_no_new_work();

-- ── §B.4.4  The chart is materialised from the log ─────────────────────────
--
-- `dental_charts.state` is rebuilt from `dental_tooth_events` on every append.
-- There is no endpoint that writes it and `hms_app` holds no privilege on the
-- table at all (§C), so the only way to change what a tooth looks like is to
-- record what happened to it. A chart that can be edited directly is a chart
-- where "when did this filling appear?" has no answer, and that is the question
-- asked every time a claim is queried.
CREATE OR REPLACE FUNCTION specialty.rebuild_dental_chart()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_state jsonb;
  v_dmft int;
BEGIN
  SELECT coalesce(jsonb_object_agg(t.tooth::text, t.entry), '{}'::jsonb)
    INTO v_state
  FROM (
    SELECT e.tooth_fdi AS tooth,
           jsonb_build_object(
             'done', coalesce(jsonb_agg(DISTINCT e.condition_code)
                       FILTER (WHERE e.status IN ('existing','done')), '[]'::jsonb),
             'planned', coalesce(jsonb_agg(DISTINCT e.condition_code)
                          FILTER (WHERE e.status = 'planned'), '[]'::jsonb),
             'surfaces', coalesce(jsonb_agg(DISTINCT s)
                           FILTER (WHERE s IS NOT NULL), '[]'::jsonb),
             'lastAt', max(e.recorded_at)
           ) AS entry
      FROM specialty.dental_tooth_events e
      LEFT JOIN LATERAL unnest(e.surfaces) AS s ON true
     WHERE e.hospital_id = NEW.hospital_id
       AND e.patient_id  = NEW.patient_id
       AND e.status <> 'cancelled'
     GROUP BY e.tooth_fdi
  ) t;

  -- Decayed, missing or filled permanent teeth. The epidemiological index a
  -- school screening report is built from, derived with the state so the two
  -- cannot disagree.
  SELECT count(DISTINCT e.tooth_fdi) INTO v_dmft
    FROM specialty.dental_tooth_events e
   WHERE e.hospital_id = NEW.hospital_id
     AND e.patient_id  = NEW.patient_id
     AND e.status IN ('existing', 'done')
     AND e.tooth_fdi BETWEEN 11 AND 48
     AND (   lower(e.condition_code) LIKE 'caries%'
          OR lower(e.condition_code) LIKE 'filling%'
          OR lower(e.condition_code) LIKE 'crown%'
          OR lower(e.condition_code) LIKE 'rct%'
          OR lower(e.condition_code) IN ('extraction','extracted','missing'));

  INSERT INTO specialty.dental_charts (
    id, hospital_id, branch_id, patient_id, dentition, state, dmft,
    rebuilt_at, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), NEW.hospital_id, NEW.branch_id, NEW.patient_id,
    'permanent', v_state, v_dmft, now(), now(), now()
  )
  ON CONFLICT (hospital_id, patient_id) DO UPDATE
    SET state = EXCLUDED.state,
        dmft = EXCLUDED.dmft,
        rebuilt_at = now(),
        updated_at = now();

  RETURN NULL;
END $$;

CREATE TRIGGER "chart_is_materialised_from_the_log"
  AFTER INSERT ON "specialty"."dental_tooth_events"
  FOR EACH ROW EXECUTE FUNCTION specialty.rebuild_dental_chart();

-- ── §B.4.5  An accepted plan's prices do not move ──────────────────────────
--
-- A treatment plan is a quotation the patient consented to, often paid in
-- instalments over a year. Once accepted, a line's price is immutable: a change
-- is a new version of the plan, presented again. Silent re-pricing after
-- acceptance is the largest single source of dental complaints.
CREATE OR REPLACE FUNCTION specialty.accepted_plan_price_is_fixed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_status specialty."PlanStatus";
BEGIN
  SELECT status INTO v_status FROM specialty.dental_treatment_plans WHERE id = NEW.plan_id;

  IF v_status IN ('accepted', 'partial', 'completed')
     AND (   NEW.unit_price    IS DISTINCT FROM OLD.unit_price
          OR NEW.quantity      IS DISTINCT FROM OLD.quantity
          OR NEW.discount      IS DISTINCT FROM OLD.discount
          OR NEW.tax           IS DISTINCT FROM OLD.tax
          OR NEW.procedure_code IS DISTINCT FROM OLD.procedure_code
          OR NEW.teeth         IS DISTINCT FROM OLD.teeth) THEN
    RAISE EXCEPTION 'Plan line % was accepted at its current price and cannot be re-priced or re-scoped (OP-026 §B.4.5). Supersede the plan with a new version and present it again.', NEW.seq
      USING ERRCODE = 'OP026';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "accepted_plan_price_is_fixed"
  BEFORE UPDATE ON "specialty"."dental_plan_items"
  FOR EACH ROW EXECUTE FUNCTION specialty.accepted_plan_price_is_fixed();

-- Acceptance is an act with a form: an e-signature, the portal, or a witnessed
-- verbal yes. A plan that became accepted without one is a plan nobody agreed
-- to.
ALTER TABLE "specialty"."dental_treatment_plans"
  ADD CONSTRAINT "acceptance_says_how_the_patient_agreed"
  CHECK (
    "status" NOT IN ('accepted', 'partial', 'completed')
    OR ("accepted_at" IS NOT NULL
        AND "accepted_via" IN ('esign', 'portal', 'verbal_witness'))
  );

ALTER TABLE "specialty"."dental_treatment_plans"
  ADD CONSTRAINT "a_presented_plan_was_presented_by_somebody"
  CHECK ("status" = 'draft' OR ("presented_by" IS NOT NULL AND "presented_at" IS NOT NULL));

ALTER TABLE "specialty"."dental_plan_items"
  ADD CONSTRAINT "plan_line_amounts_are_not_negative"
  CHECK ("unit_price" >= 0 AND "discount" >= 0 AND "tax" >= 0
     AND "quantity" > 0 AND "sittings_planned" > 0 AND "sittings_done" >= 0);

-- Every tooth a line quotes work on is a tooth that exists.
CREATE OR REPLACE FUNCTION specialty.plan_line_names_real_teeth()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE t int;
BEGIN
  FOREACH t IN ARRAY NEW.teeth LOOP
    IF NOT specialty.is_fdi_tooth(t) THEN
      RAISE EXCEPTION '% is not an FDI tooth number (OP-026 §B.4.1). Line % of this plan quotes work on a tooth that does not exist.', t, NEW.seq
        USING ERRCODE = 'OP026';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER "plan_line_names_real_teeth"
  BEFORE INSERT OR UPDATE OF teeth ON "specialty"."dental_plan_items"
  FOR EACH ROW EXECUTE FUNCTION specialty.plan_line_names_real_teeth();


-- ─────────────────────────────────────────────────────────────────────────────
-- §B.5  OP-027 · Dermatology
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.5.1  A score with a formula is computed from its components ─────────
--
-- PASI, EASI, SCORAD and BSA all have published arithmetic over sub-scores that
-- are themselves recorded here. A biologic stays funded on a PASI, and a PASI
-- that can be typed is a PASI that drifts toward whatever number keeps therapy
-- approved — or, when a budget is tight, away from it. Where a score has no
-- formula the console can compute (a questionnaire total, a physician's global
-- assessment), the typed value stands and the trigger leaves it alone.
CREATE OR REPLACE FUNCTION specialty.derive_derm_score()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_total numeric := 0;
  v_region text;
  v_weight numeric;
  v_c jsonb;
  v_area numeric;
  v_sev numeric;
BEGIN
  IF NEW.score_type NOT IN ('pasi', 'easi', 'scorad', 'bsa') THEN
    RETURN NEW;                      -- no formula; the typed value is the score
  END IF;

  IF NEW.components IS NULL OR NEW.components = '{}'::jsonb THEN
    RAISE EXCEPTION 'A % is computed from its components, so it cannot be recorded without them (OP-027 §B.5.1).', upper(NEW.score_type::text)
      USING ERRCODE = 'OP027';
  END IF;

  IF NEW.score_type = 'bsa' THEN
    -- Palm-unit percentages per region, summed.
    SELECT coalesce(sum((value#>>'{}')::numeric), 0) INTO v_total
      FROM jsonb_each(NEW.components);
    NEW.value := round(least(v_total, 100), 2);
    RETURN NEW;
  END IF;

  IF NEW.score_type = 'scorad' THEN
    -- A/5 + 7B/2 + C: extent, intensity, and what the patient reports.
    NEW.value := round(
        coalesce((NEW.components->>'extentPct')::numeric, 0) / 5.0
      + 7.0 * coalesce((NEW.components->>'intensity')::numeric, 0) / 2.0
      + coalesce((NEW.components->>'pruritus')::numeric, 0)
      + coalesce((NEW.components->>'sleepLoss')::numeric, 0)
    , 2);
    RETURN NEW;
  END IF;

  -- PASI and EASI share their shape: four regions, each weighted, each an area
  -- grade multiplied by the sum of its severity items.
  FOR v_region, v_weight IN
    SELECT * FROM (VALUES ('head', 0.1), ('upperLimbs', 0.2),
                          ('trunk', 0.3), ('lowerLimbs', 0.4)) AS w(r, wt)
  LOOP
    v_c := NEW.components -> v_region;
    IF v_c IS NULL THEN
      RAISE EXCEPTION 'A % needs all four regions; "%" is missing (OP-027 §B.5.1).', upper(NEW.score_type::text), v_region
        USING ERRCODE = 'OP027';
    END IF;

    v_area := coalesce((v_c->>'area')::numeric, 0);

    IF NEW.score_type = 'pasi' THEN
      v_sev := coalesce((v_c->>'erythema')::numeric, 0)
             + coalesce((v_c->>'induration')::numeric, 0)
             + coalesce((v_c->>'desquamation')::numeric, 0);
    ELSE
      v_sev := coalesce((v_c->>'erythema')::numeric, 0)
             + coalesce((v_c->>'edema')::numeric, 0)
             + coalesce((v_c->>'excoriation')::numeric, 0)
             + coalesce((v_c->>'lichenification')::numeric, 0);
    END IF;

    v_total := v_total + v_weight * v_area * v_sev;
  END LOOP;

  NEW.value := round(v_total, 2);
  RETURN NEW;
END $$;

CREATE TRIGGER "derm_score_is_derived_from_its_components"
  BEFORE INSERT OR UPDATE ON "specialty"."derm_scores"
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_derm_score();

ALTER TABLE "specialty"."derm_lesion_observations"
  ADD CONSTRAINT "itch_is_a_zero_to_ten_scale"
  CHECK ("itch_nrs" IS NULL OR "itch_nrs" BETWEEN 0 AND 10);

ALTER TABLE "specialty"."derm_lesions"
  ADD CONSTRAINT "lesion_number_is_positive"
  CHECK ("lesion_no" > 0);

-- ── §B.5.2  A phototherapy dose does not exceed its ceiling ────────────────
--
-- Narrowband UVB works by delivering slightly more energy each session until it
-- stops working, and the failure mode is a burn. It is caused by exactly two
-- things: a dose above the course's ceiling, and an increase after the skin has
-- already reacted. The machine will deliver whatever it is asked for, so the
-- refusal lives here rather than in a warning banner.
CREATE OR REPLACE FUNCTION specialty.phototherapy_dose_is_safe()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_max numeric;
  v_modality specialty."PhototherapyModality";
  v_prev_dose numeric;
  v_prev_erythema int;
  v_prev_seq int;
BEGIN
  SELECT max_dose_mj, modality INTO v_max, v_modality
    FROM specialty.derm_phototherapy_courses WHERE id = NEW.course_id;

  IF NEW.dose_mj > v_max THEN
    RAISE EXCEPTION 'This session is % mJ/cm² but the course ceiling is % (OP-027 §B.5.2). Raise the ceiling deliberately with the prescriber, or deliver the dose the course allows.', NEW.dose_mj, v_max
      USING ERRCODE = 'OP027';
  END IF;

  SELECT seq, dose_mj, erythema_grade
    INTO v_prev_seq, v_prev_dose, v_prev_erythema
    FROM specialty.derm_phototherapy_sessions
   WHERE course_id = NEW.course_id AND seq < NEW.seq
   ORDER BY seq DESC
   LIMIT 1;

  IF v_prev_seq IS NOT NULL AND v_prev_erythema >= 2 AND NEW.dose_mj > v_prev_dose THEN
    RAISE EXCEPTION 'Session % caused grade % erythema, so session % cannot be a higher dose than the % mJ/cm² that produced it (OP-027 §B.5.2). Hold or reduce until the skin settles.',
      v_prev_seq, v_prev_erythema, NEW.seq, v_prev_dose
      USING ERRCODE = 'OP027';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "phototherapy_dose_is_safe"
  BEFORE INSERT OR UPDATE OF dose_mj, seq ON "specialty"."derm_phototherapy_sessions"
  FOR EACH ROW EXECUTE FUNCTION specialty.phototherapy_dose_is_safe();

-- The cumulative dose is the number that decides when somebody has had a
-- lifetime's worth of ultraviolet. It is a sum, so it is summed.
CREATE OR REPLACE FUNCTION specialty.roll_up_phototherapy_course()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE v_course uuid;
BEGIN
  v_course := coalesce(NEW.course_id, OLD.course_id);
  UPDATE specialty.derm_phototherapy_courses c
     SET cumulative_dose_mj = coalesce((SELECT sum(s.dose_mj)
                                          FROM specialty.derm_phototherapy_sessions s
                                         WHERE s.course_id = v_course), 0),
         sessions_count     = (SELECT count(*)
                                 FROM specialty.derm_phototherapy_sessions s
                                WHERE s.course_id = v_course),
         updated_at = now()
   WHERE c.id = v_course;
  RETURN NULL;
END $$;

CREATE TRIGGER "phototherapy_course_totals_are_summed"
  AFTER INSERT OR UPDATE OR DELETE ON "specialty"."derm_phototherapy_sessions"
  FOR EACH ROW EXECUTE FUNCTION specialty.roll_up_phototherapy_course();

ALTER TABLE "specialty"."derm_phototherapy_sessions"
  ADD CONSTRAINT "erythema_grade_is_zero_to_four"
  CHECK ("erythema_grade" BETWEEN 0 AND 4);

ALTER TABLE "specialty"."derm_phototherapy_sessions"
  ADD CONSTRAINT "a_session_delivers_something"
  CHECK ("dose_mj" > 0 AND "seq" > 0);

ALTER TABLE "specialty"."derm_phototherapy_courses"
  ADD CONSTRAINT "skin_type_is_fitzpatrick"
  CHECK ("skin_type" BETWEEN 1 AND 6);

ALTER TABLE "specialty"."derm_phototherapy_courses"
  ADD CONSTRAINT "course_doses_make_a_ladder"
  CHECK ("start_dose_mj" > 0
     AND "max_dose_mj" >= "start_dose_mj"
     AND "increment_pct" BETWEEN 0 AND 100
     AND "freq_per_week" BETWEEN 1 AND 7);

-- Eye and genital shielding is not optional, and the cataract arrives twenty
-- years after the course nobody recorded it for.
ALTER TABLE "specialty"."derm_phototherapy_courses"
  ADD CONSTRAINT "a_course_records_its_shielding"
  CHECK ("shielding" ? 'eyes');

-- PUVA without its psoralen is a course whose whole photosensitising step is
-- missing from the record.
ALTER TABLE "specialty"."derm_phototherapy_courses"
  ADD CONSTRAINT "puva_records_its_psoralen"
  CHECK ("modality" <> 'puva' OR "psoralen" ? 'agent');

-- ── §B.5.3  A malignant biopsy is not closed without a follow-up ───────────
--
-- A skin cancer report that nobody acted on is the commonest dermatology
-- negligence claim, and it happens in exactly this gap: the report arrives, it
-- is read, the status moves on, and the patient is never recalled.
CREATE OR REPLACE FUNCTION specialty.malignant_biopsy_has_a_followup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  IF NEW.status IN ('reviewed', 'action_planned')
     AND NEW.malignancy_flag
     AND NEW.followup_task_id IS NULL THEN
    RAISE EXCEPTION 'This biopsy reported a malignancy and cannot be closed without a follow-up task (OP-027 §B.5.3). A report that was read and then filed is indistinguishable, afterwards, from one nobody opened.'
      USING ERRCODE = 'OP027';
  END IF;

  IF NEW.status IN ('reviewed', 'action_planned')
     AND (NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL) THEN
    RAISE EXCEPTION 'A reviewed biopsy names who reviewed it and when (OP-027 §B.5.3).'
      USING ERRCODE = 'OP027';
  END IF;

  IF NEW.status IN ('reported', 'reviewed', 'action_planned')
     AND (NEW.result_summary IS NULL OR length(btrim(NEW.result_summary)) = 0) THEN
    RAISE EXCEPTION 'A reported biopsy carries its result (OP-027 §B.5.3).'
      USING ERRCODE = 'OP027';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "malignant_biopsy_has_a_followup"
  BEFORE INSERT OR UPDATE ON "specialty"."derm_biopsies"
  FOR EACH ROW EXECUTE FUNCTION specialty.malignant_biopsy_has_a_followup();

ALTER TABLE "specialty"."derm_biopsies"
  ADD CONSTRAINT "biopsy_type_is_a_biopsy"
  CHECK ("type" IN ('punch', 'shave', 'excision', 'incisional', 'curettage'));


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
      AND (c.relname LIKE 'cardio\_%' OR c.relname LIKE 'pulmo\_%'
           OR c.relname LIKE 'ent\_%' OR c.relname LIKE 'dental\_%'
           OR c.relname LIKE 'derm\_%')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % device-console table(s)', v_count;
END $$;

-- The chart is derived (§B.4.4). Not "the application should not write it" —
-- the application *cannot*, because it holds no privilege on the table. The
-- rebuild runs as the owner inside a SECURITY DEFINER trigger, and the only
-- way to change what a tooth looks like is to append to the log.
REVOKE INSERT, UPDATE, DELETE ON "specialty"."dental_charts" FROM hms_app;

-- The log is append-only. An event that turned out to be wrong is superseded by
-- another event, exactly as a clinical note is: the chart rebuilds either way,
-- and "when did this filling appear?" keeps an answer.
REVOKE UPDATE, DELETE ON "specialty"."dental_tooth_events" FROM hms_app;

-- A tracing, a spirometry trace, an audiogram and a biopsy report are the
-- evidence. They are corrected by a new version, never removed.
REVOKE DELETE ON "specialty"."cardio_ecg_records"        FROM hms_app;
REVOKE DELETE ON "specialty"."cardio_echo_reports"       FROM hms_app;
REVOKE DELETE ON "specialty"."cardio_stress_tests"       FROM hms_app;
REVOKE DELETE ON "specialty"."cardio_inr_visits"         FROM hms_app;
REVOKE DELETE ON "specialty"."pulmo_pft_studies"         FROM hms_app;
REVOKE DELETE ON "specialty"."pulmo_sleep_studies"       FROM hms_app;
REVOKE DELETE ON "specialty"."ent_audiology_tests"       FROM hms_app;
REVOKE DELETE ON "specialty"."ent_audiology_results"     FROM hms_app;
REVOKE DELETE ON "specialty"."derm_biopsies"             FROM hms_app;

-- A delivered dose of ultraviolet happened. The cumulative total a patient is
-- carried against for the rest of their life is only true if nothing can leave
-- it.
REVOKE DELETE ON "specialty"."derm_phototherapy_sessions" FROM hms_app;

-- A hearing aid that was dispensed and a plan a patient signed are not deleted
-- either: the aid is returned, the plan is cancelled with a reason.
REVOKE DELETE ON "specialty"."ent_hearing_aids"          FROM hms_app;
REVOKE DELETE ON "specialty"."dental_treatment_plans"    FROM hms_app;


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
  WHERE n.nspname = 'specialty'
    AND (c.relname LIKE 'cardio\_%' OR c.relname LIKE 'pulmo\_%'
         OR c.relname LIKE 'ent\_%' OR c.relname LIKE 'dental\_%'
         OR c.relname LIKE 'derm\_%')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Device-console tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;
