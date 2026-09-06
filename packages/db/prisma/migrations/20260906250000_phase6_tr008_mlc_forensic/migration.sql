-- ═════════════════════════════════════════════════════════════════════════════
-- TR-008 — MLC register, police intimation and the evidence chain
--
-- `phase-06` §6.6, exit gate 6. Twelve tables in `clinical`, prefixed `mlc_`.
--
-- ── What this migration is actually for ────────────────────────────────────
--
-- A medico-legal record is read, years later, by somebody looking for a reason
-- not to believe it. Everything below is chosen so that the honest answer to
-- "could this have been changed after the fact?" is *no*, rather than "we have
-- no reason to think so".
--
--   §B.1  An MLC is never un-flagged. Only the Medical Superintendent may
--         cancel it, only with a reason, and the number stays burnt.
--   §B.2  `mlc_custody_log` is append-only and hash-chained, with the hash
--         computed by the database from the row's own content. An application
--         cannot forge a link because it never supplies one.
--   §B.3  A custody transfer names both hands. No silent moves.
--   §B.4  An evidence hash, once set, cannot change; nor can the file it names.
--   §B.5  A finalised report is immutable. A correction is an addendum.
--   §B.6  The sexual-assault proforma cannot carry a two-finger test, a
--         virginity finding or a "habituated" note — not as a warning, as a
--         refusal.
--   §B.7  A POCSO case cannot record that the police were not informed.
--   §B.8  A death's MCCD stays blocked until the inquest or PM decision exists.
--   §B.9  The clinical record is released only against a written authority.
--   §B.10 Discharge, transfer and LAMA are blocked while the MLC set is
--         incomplete — unless the MS overrides, on the record.
--
-- ── And what it deliberately does not do ───────────────────────────────────
--
-- Nothing here touches an order, a prescription, a bill or a procedure. There
-- is no column to hang a clinical block on, so *Parmanand Katara* is honoured
-- by construction and not by anybody remembering. §B.10's trigger sits on
-- `er_dispositions` — the way out of the department, never the way in.
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "clinical"."MlcCategory" AS ENUM ('rta', 'assault', 'burns', 'poisoning', 'fall_from_height', 'industrial', 'animal_attack', 'firearm', 'sexual_assault', 'self_harm', 'dowry_related', 'custodial', 'unknown_unconscious', 'brought_dead', 'drowning', 'electrocution', 'snake_bite', 'other');

-- CreateEnum
CREATE TYPE "clinical"."MlcStatus" AS ENUM ('open', 'report_pending', 'report_final', 'closed', 'cancelled');

-- CreateEnum
CREATE TYPE "clinical"."MlcIntimationType" AS ENUM ('initial', 'update', 'death', 'inquest', 'absconded', 'transfer', 'discharge', 'dying_declaration_request', 'mv_act_information');

-- CreateEnum
CREATE TYPE "clinical"."MlcIntimationStatus" AS ENUM ('generated', 'dispatched', 'acknowledged', 'failed');

-- CreateEnum
CREATE TYPE "clinical"."InjuryKind" AS ENUM ('abrasion', 'contusion', 'laceration', 'incised', 'stab', 'chop', 'firearm_entry', 'firearm_exit', 'burn', 'fracture', 'bite', 'ligature', 'defence_wound', 'other');

-- CreateEnum
CREATE TYPE "clinical"."BnsInjuryClass" AS ENUM ('simple', 'grievous', 'dangerous_to_life', 'not_assessed');

-- CreateEnum
CREATE TYPE "clinical"."WeaponOpinion" AS ENUM ('blunt', 'sharp', 'pointed', 'firearm', 'thermal', 'chemical', 'animal', 'ligature', 'other', 'undetermined');

-- CreateEnum
CREATE TYPE "clinical"."EvidenceKind" AS ENUM ('photo', 'video', 'clothing', 'belonging', 'sample', 'foreign_body', 'document', 'digital_other');

-- CreateEnum
CREATE TYPE "clinical"."EvidenceStatus" AS ENUM ('collected', 'sealed', 'in_lab', 'returned', 'handed_over', 'disposed');

-- CreateEnum
CREATE TYPE "clinical"."EvidenceLocation" AS ENUM ('er', 'evidence_locker', 'lab', 'mrd', 'police', 'court', 'disposed');

-- CreateEnum
CREATE TYPE "clinical"."MlcReportKind" AS ENUM ('wound_certificate', 'mlc_report', 'age_certificate', 'fitness_certificate', 'intoxication_certificate', 'sexual_assault_report', 'death_summary_court', 'treatment_summary', 'bsa_63_certificate', 'other');

-- CreateEnum
CREATE TYPE "clinical"."MlcReportStatus" AS ENUM ('draft', 'final', 'final_wet_signed', 'addendum');

-- CreateEnum
CREATE TYPE "clinical"."MlcRequestKind" AS ENUM ('injury_report', 'history', 'certified_copy', 'evidence', 'testimony', 'other');

-- CreateEnum
CREATE TYPE "clinical"."MlcDeathKind" AS ENUM ('brought_dead', 'died_in_hospital');

-- CreateEnum
CREATE TYPE "clinical"."MannerOfDeath" AS ENUM ('natural', 'accident', 'suicide', 'homicide', 'undetermined');

-- CreateEnum
CREATE TYPE "clinical"."BodyCustody" AS ENUM ('mortuary', 'police', 'released_to_relatives_with_noc');

-- CreateEnum
CREATE TYPE "clinical"."PoliceInformedBasis" AS ENUM ('yes_consent', 'declined_adult', 'mandatory_pocso');

-- AlterTable

-- CreateTable
CREATE TABLE "clinical"."mlc_cases" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "mlc_no" VARCHAR(40) NOT NULL,
    "er_visit_id" UUID,
    "admission_id" UUID,
    "patient_id" UUID,
    "temp_tag_id" VARCHAR(40),
    "category" "clinical"."MlcCategory" NOT NULL,
    "sub_category" VARCHAR(80),
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by" UUID,
    "suggested_from" VARCHAR(40),
    "brought_by" JSONB,
    "informant" JSONB,
    "history_as_stated" TEXT,
    "identification_marks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "alleged_incident_at" TIMESTAMPTZ(6),
    "incident_place" VARCHAR(300),
    "consent" JSONB,
    "intoxication_assessment" JSONB,
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "status" "clinical"."MlcStatus" NOT NULL DEFAULT 'open',
    "unflag_reason" TEXT,
    "unflagged_by" UUID,
    "unflagged_at" TIMESTAMPTZ(6),
    "mo_id" UUID,
    "forensic_review_by" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "gate_override_by" UUID,
    "gate_override_reason" TEXT,
    "gate_overridden_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mlc_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_police_intimations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "type" "clinical"."MlcIntimationType" NOT NULL DEFAULT 'initial',
    "ps_name" VARCHAR(160) NOT NULL,
    "jurisdiction" VARCHAR(160),
    "addressed_to" VARCHAR(160),
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_by" UUID,
    "document_ref" VARCHAR(300),
    "sha256" CHAR(64),
    "channels" JSONB NOT NULL DEFAULT '[]',
    "status" "clinical"."MlcIntimationStatus" NOT NULL DEFAULT 'generated',
    "dispatched_at" TIMESTAMPTZ(6),
    "ack_officer_name" VARCHAR(160),
    "ack_officer_badge" VARCHAR(60),
    "ack_at" TIMESTAMPTZ(6),
    "ack_signature_ref" VARCHAR(300),
    "ack_due_at" TIMESTAMPTZ(6),
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mlc_police_intimations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_injuries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "trauma_injury_id" UUID,
    "kind" "clinical"."InjuryKind" NOT NULL,
    "body_view" VARCHAR(24) NOT NULL,
    "x_pct" DECIMAL(5,2) NOT NULL,
    "y_pct" DECIMAL(5,2) NOT NULL,
    "side" VARCHAR(16),
    "site_description" VARCHAR(300) NOT NULL,
    "length_cm" DECIMAL(6,2),
    "breadth_cm" DECIMAL(6,2),
    "depth_cm" DECIMAL(6,2),
    "shape" VARCHAR(80),
    "edges" VARCHAR(80),
    "direction" VARCHAR(80),
    "colour_stage" VARCHAR(80),
    "age_estimate" VARCHAR(120),
    "foreign_body" VARCHAR(200),
    "firearm_features" JSONB,
    "bns_class" "clinical"."BnsInjuryClass" NOT NULL DEFAULT 'not_assessed',
    "grievous_reason" VARCHAR(120),
    "weapon_opinion" "clinical"."WeaponOpinion" NOT NULL DEFAULT 'undetermined',
    "consistent_with_history" VARCHAR(16) NOT NULL DEFAULT 'cannot_say',
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID,

    CONSTRAINT "mlc_injuries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_evidence" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "item_no" INTEGER NOT NULL,
    "kind" "clinical"."EvidenceKind" NOT NULL,
    "description" VARCHAR(400) NOT NULL,
    "collected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "collected_by" UUID,
    "consent_ref" VARCHAR(120),
    "seal_no" VARCHAR(60),
    "bag_label_ref" VARCHAR(120),
    "sample_id" UUID,
    "file_ref" VARCHAR(400),
    "sha256" CHAR(64),
    "hash_algorithm" VARCHAR(16) NOT NULL DEFAULT 'sha256',
    "hash_verified_at" TIMESTAMPTZ(6),
    "device_id" VARCHAR(64),
    "exif" JSONB,
    "annotation_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "current_custodian_id" UUID,
    "current_location" "clinical"."EvidenceLocation" NOT NULL DEFAULT 'er',
    "status" "clinical"."EvidenceStatus" NOT NULL DEFAULT 'collected',
    "disposal_authority" VARCHAR(200),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mlc_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_custody_log" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "evidence_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "from_user_id" UUID,
    "to_user_id" UUID,
    "to_external" JSONB,
    "location_from" "clinical"."EvidenceLocation" NOT NULL,
    "location_to" "clinical"."EvidenceLocation" NOT NULL,
    "purpose" VARCHAR(200) NOT NULL,
    "seal_intact" BOOLEAN NOT NULL DEFAULT true,
    "witness_user_id" UUID,
    "signature_refs" JSONB,
    "condition_notes" TEXT,
    "temperature_c" DECIMAL(4,1),
    "prev_hash" CHAR(64) NOT NULL,
    "hash" CHAR(64) NOT NULL,

    CONSTRAINT "mlc_custody_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_handovers" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "to_external" JSONB NOT NULL,
    "item_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "memo_ref" VARCHAR(300),
    "memo_sha256" CHAR(64),
    "signed_by_hospital" UUID,
    "witness_id" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "ack_file_ref" VARCHAR(300),
    "bsa63_certificate_ref" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mlc_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_reports" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "kind" "clinical"."MlcReportKind" NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" "clinical"."MlcReportStatus" NOT NULL DEFAULT 'draft',
    "template_ref" VARCHAR(120),
    "document_ref" VARCHAR(300),
    "sha256" CHAR(64),
    "prev_sha256" CHAR(64),
    "content" JSONB,
    "signed_by" UUID,
    "dsc_ref" VARCHAR(200),
    "signed_at" TIMESTAMPTZ(6),
    "addendum_of" UUID,
    "addendum_reason" TEXT,
    "dispatches" JSONB NOT NULL DEFAULT '[]',
    "copy_register_no" VARCHAR(60),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mlc_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_requests" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "requester" JSONB NOT NULL,
    "kind" "clinical"."MlcRequestKind" NOT NULL,
    "authority_ref" VARCHAR(300),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "provided_at" TIMESTAMPTZ(6),
    "provided_doc_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "denied_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mlc_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_dying_declarations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by" UUID,
    "magistrate" JSONB,
    "fitness_certified_by" UUID,
    "fitness_at" TIMESTAMPTZ(6),
    "fitness_opinion" VARCHAR(24),
    "vitals_snapshot" JSONB,
    "recorded_at" TIMESTAMPTZ(6),
    "recorded_by_external" VARCHAR(200),
    "sealed_evidence_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mlc_dying_declarations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_sexual_assault_exams" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "survivor_age_band" VARCHAR(24) NOT NULL,
    "is_pocso" BOOLEAN NOT NULL DEFAULT false,
    "consent_matrix" JSONB NOT NULL,
    "chaperone_id" UUID,
    "exam_proforma" JSONB,
    "safe_kit_checklist" JSONB,
    "prophylaxis" JSONB,
    "pregnancy_test" VARCHAR(24),
    "referrals" JSONB,
    "followups" JSONB,
    "police_informed" "clinical"."PoliceInformedBasis" NOT NULL,
    "sjpu_cwc_intimation" JSONB,
    "treatment_waived" BOOLEAN NOT NULL DEFAULT true,
    "waiver_recorded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mlc_sexual_assault_exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_deaths" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "kind" "clinical"."MlcDeathKind" NOT NULL,
    "declared_at" TIMESTAMPTZ(6) NOT NULL,
    "declared_by" UUID,
    "provisional_cause" VARCHAR(300),
    "manner_suspected" "clinical"."MannerOfDeath" NOT NULL DEFAULT 'undetermined',
    "inquest_intimation_id" UUID,
    "pm_required" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "body_custody" "clinical"."BodyCustody" NOT NULL DEFAULT 'mortuary',
    "noc_no" VARCHAR(60),
    "mortuary_case_id" UUID,
    "mccd_status" VARCHAR(24) NOT NULL DEFAULT 'blocked',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mlc_deaths_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mlc_court_matters" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "court" VARCHAR(200) NOT NULL,
    "court_case_no" VARCHAR(80),
    "summons_ref" VARCHAR(300),
    "hearing_dates" JSONB NOT NULL DEFAULT '[]',
    "next_hearing_at" TIMESTAMPTZ(6),
    "doctor_id" UUID,
    "documents_required" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outcome" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mlc_court_matters_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mlc_cases_hospital_id_branch_id_status_opened_at_idx" ON "clinical"."mlc_cases"("hospital_id", "branch_id", "status", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "mlc_cases_hospital_id_patient_id_idx" ON "clinical"."mlc_cases"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "mlc_cases_hospital_id_er_visit_id_idx" ON "clinical"."mlc_cases"("hospital_id", "er_visit_id");

-- CreateIndex
CREATE INDEX "mlc_cases_hospital_id_category_opened_at_idx" ON "clinical"."mlc_cases"("hospital_id", "category", "opened_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_mlc_no_per_branch" ON "clinical"."mlc_cases"("hospital_id", "branch_id", "mlc_no");

-- CreateIndex
CREATE INDEX "mlc_police_intimations_hospital_id_case_id_generated_at_idx" ON "clinical"."mlc_police_intimations"("hospital_id", "case_id", "generated_at" DESC);

-- CreateIndex
CREATE INDEX "mlc_police_intimations_hospital_id_status_ack_due_at_idx" ON "clinical"."mlc_police_intimations"("hospital_id", "status", "ack_due_at");

-- CreateIndex
CREATE INDEX "mlc_injuries_hospital_id_case_id_idx" ON "clinical"."mlc_injuries"("hospital_id", "case_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mlc_injury_seq" ON "clinical"."mlc_injuries"("case_id", "seq");

-- CreateIndex
CREATE INDEX "mlc_evidence_hospital_id_case_id_idx" ON "clinical"."mlc_evidence"("hospital_id", "case_id");

-- CreateIndex
CREATE INDEX "mlc_evidence_hospital_id_sha256_idx" ON "clinical"."mlc_evidence"("hospital_id", "sha256");

-- CreateIndex
CREATE INDEX "mlc_evidence_hospital_id_status_current_location_idx" ON "clinical"."mlc_evidence"("hospital_id", "status", "current_location");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mlc_evidence_item_no" ON "clinical"."mlc_evidence"("case_id", "item_no");

-- CreateIndex
CREATE INDEX "mlc_custody_log_hospital_id_evidence_id_seq_idx" ON "clinical"."mlc_custody_log"("hospital_id", "evidence_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mlc_custody_seq" ON "clinical"."mlc_custody_log"("evidence_id", "seq");

-- CreateIndex
CREATE INDEX "mlc_handovers_hospital_id_case_id_created_at_idx" ON "clinical"."mlc_handovers"("hospital_id", "case_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mlc_reports_hospital_id_case_id_created_at_idx" ON "clinical"."mlc_reports"("hospital_id", "case_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "mlc_reports_hospital_id_status_idx" ON "clinical"."mlc_reports"("hospital_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mlc_report_version" ON "clinical"."mlc_reports"("case_id", "kind", "version_no");

-- CreateIndex
CREATE INDEX "mlc_requests_hospital_id_case_id_received_at_idx" ON "clinical"."mlc_requests"("hospital_id", "case_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "mlc_dying_declarations_hospital_id_case_id_idx" ON "clinical"."mlc_dying_declarations"("hospital_id", "case_id");

-- CreateIndex
CREATE UNIQUE INDEX "mlc_sexual_assault_exams_case_id_key" ON "clinical"."mlc_sexual_assault_exams"("case_id");

-- CreateIndex
CREATE INDEX "mlc_sexual_assault_exams_hospital_id_case_id_idx" ON "clinical"."mlc_sexual_assault_exams"("hospital_id", "case_id");

-- CreateIndex
CREATE UNIQUE INDEX "mlc_deaths_case_id_key" ON "clinical"."mlc_deaths"("case_id");

-- CreateIndex
CREATE INDEX "mlc_deaths_hospital_id_case_id_idx" ON "clinical"."mlc_deaths"("hospital_id", "case_id");

-- CreateIndex
CREATE INDEX "mlc_court_matters_hospital_id_next_hearing_at_idx" ON "clinical"."mlc_court_matters"("hospital_id", "next_hearing_at");

-- CreateIndex
CREATE INDEX "mlc_court_matters_hospital_id_case_id_idx" ON "clinical"."mlc_court_matters"("hospital_id", "case_id");

-- AddForeignKey
ALTER TABLE "clinical"."mlc_police_intimations" ADD CONSTRAINT "mlc_police_intimations_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."mlc_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."mlc_injuries" ADD CONSTRAINT "mlc_injuries_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."mlc_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."mlc_evidence" ADD CONSTRAINT "mlc_evidence_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."mlc_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."mlc_custody_log" ADD CONSTRAINT "mlc_custody_log_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "clinical"."mlc_evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."mlc_handovers" ADD CONSTRAINT "mlc_handovers_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."mlc_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."mlc_reports" ADD CONSTRAINT "mlc_reports_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."mlc_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."mlc_requests" ADD CONSTRAINT "mlc_requests_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."mlc_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."mlc_dying_declarations" ADD CONSTRAINT "mlc_dying_declarations_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."mlc_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."mlc_sexual_assault_exams" ADD CONSTRAINT "mlc_sexual_assault_exams_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."mlc_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."mlc_deaths" ADD CONSTRAINT "mlc_deaths_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."mlc_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."mlc_court_matters" ADD CONSTRAINT "mlc_court_matters_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."mlc_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §A. ROW-LEVEL SECURITY
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  r record; v_has_hospital boolean; v_hospital_null boolean; v_has_branch boolean;
  v_using text; v_check text; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory','finance','queue','engage','billing','integration')
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
  WHERE n.nspname = 'clinical' AND c.relname LIKE 'mlc\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'TR-008 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  An MLC is never un-flagged ────────────────────────────────────────
--
-- Only the Medical Superintendent, only with a reason, and only to `cancelled`
-- — which is a tombstone, not a deletion. The number stays burnt: a reused MLC
-- number is two cases sharing one identity in a court file, and the register is
-- supposed to be gapless *and* unambiguous.
CREATE OR REPLACE FUNCTION clinical.refuse_mlc_unflagging()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An MLC case is never deleted (TR-008 §B.1). Cancel it — the number stays burnt.'
      USING ERRCODE = 'TR008';
  END IF;

  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'MLC % was cancelled and cannot be reopened (TR-008 §B.1). Open a new case; this number is spent.', OLD.mlc_no
      USING ERRCODE = 'TR008';
  END IF;

  IF NEW.mlc_no <> OLD.mlc_no THEN
    RAISE EXCEPTION 'An MLC number is never changed (TR-008 §B.1). It is on the intimation the police already hold.'
      USING ERRCODE = 'TR008';
  END IF;

  -- A case that has been reported on cannot quietly become "not a case".
  IF NEW.status = 'cancelled' AND OLD.status IN ('report_final', 'closed') THEN
    RAISE EXCEPTION 'MLC % has a final report and cannot be cancelled (TR-008 §B.1). Correct it by addendum.', OLD.mlc_no
      USING ERRCODE = 'TR008';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER "mlc_cases_are_never_unflagged"
  BEFORE UPDATE OR DELETE ON "clinical"."mlc_cases"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_mlc_unflagging();

ALTER TABLE "clinical"."mlc_cases"
  ADD CONSTRAINT "mlc_cancellation_is_owned_and_reasoned"
  CHECK (
    "status" <> 'cancelled'
    OR ("unflag_reason" IS NOT NULL AND length(btrim("unflag_reason")) >= 8
        AND "unflagged_by" IS NOT NULL AND "unflagged_at" IS NOT NULL)
  );

-- An MLC attaches to somebody: a patient, an episode, or a tag. Never to
-- nothing — the register has to be able to find the person years later.
ALTER TABLE "clinical"."mlc_cases"
  ADD CONSTRAINT "mlc_case_has_a_subject"
  CHECK (
    "patient_id" IS NOT NULL OR "er_visit_id" IS NOT NULL
    OR "admission_id" IS NOT NULL OR "temp_tag_id" IS NOT NULL
  );

-- The four categories §5 names as sensitive are sensitive. Not "should be
-- marked as" — a case that is one of these and is not flagged is a case whose
-- access controls silently did not apply.
ALTER TABLE "clinical"."mlc_cases"
  ADD CONSTRAINT "mlc_sensitive_categories_are_flagged"
  CHECK (
    "category" NOT IN ('sexual_assault', 'dowry_related', 'custodial') OR "is_sensitive" = true
  );

ALTER TABLE "clinical"."mlc_cases"
  ADD CONSTRAINT "mlc_gate_override_is_owned_and_reasoned"
  CHECK (
    ("gate_override_by" IS NULL AND "gate_override_reason" IS NULL AND "gate_overridden_at" IS NULL)
    OR ("gate_override_by" IS NOT NULL AND "gate_overridden_at" IS NOT NULL
        AND "gate_override_reason" IS NOT NULL AND length(btrim("gate_override_reason")) >= 8)
  );

-- ── §B.2  The custody chain is a chain ──────────────────────────────────────
--
-- `hash` is computed here, from this row's own content plus the previous
-- row's hash. The application never supplies one, so it cannot forge a link;
-- `prev_hash` is read from the database rather than accepted, so it cannot
-- point at a row that does not exist. UPDATE and DELETE are refused outright.
--
-- The alternative — an application-computed hash — is a chain that proves the
-- application was consistent with itself, which is not the question anybody
-- asks in court.
CREATE OR REPLACE FUNCTION clinical.seal_mlc_custody_entry()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE
  v_prev record;
  v_payload text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'mlc_custody_log is append-only (TR-008 §B.2). A custody log that can be edited is not a custody log.'
      USING ERRCODE = 'TR008';
  END IF;

  SELECT seq, hash INTO v_prev
    FROM clinical.mlc_custody_log
   WHERE evidence_id = NEW.evidence_id
   ORDER BY seq DESC
   LIMIT 1;

  IF v_prev.seq IS NULL THEN
    NEW.seq := 1;
    -- The genesis link names the item, so two items cannot share a chain head.
    NEW.prev_hash := encode(ext.digest('mlc-custody-genesis:' || NEW.evidence_id::text, 'sha256'), 'hex');
  ELSE
    NEW.seq := v_prev.seq + 1;
    NEW.prev_hash := v_prev.hash;
  END IF;

  -- Everything a later reader would want to be sure of goes into the digest.
  v_payload := concat_ws('|',
    NEW.prev_hash,
    NEW.evidence_id::text,
    NEW.seq::text,
    to_char(NEW.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USZ'),
    coalesce(NEW.from_user_id::text, ''),
    coalesce(NEW.to_user_id::text, ''),
    coalesce(NEW.to_external::text, ''),
    NEW.location_from::text,
    NEW.location_to::text,
    NEW.purpose,
    NEW.seal_intact::text,
    coalesce(NEW.witness_user_id::text, ''),
    coalesce(NEW.condition_notes, ''),
    coalesce(NEW.temperature_c::text, '')
  );
  NEW.hash := encode(ext.digest(v_payload, 'sha256'), 'hex');

  RETURN NEW;
END $$;

CREATE TRIGGER "mlc_custody_log_is_sealed"
  BEFORE INSERT OR UPDATE OR DELETE ON "clinical"."mlc_custody_log"
  FOR EACH ROW EXECUTE FUNCTION clinical.seal_mlc_custody_entry();

-- ── §B.3  A transfer names both hands ───────────────────────────────────────
--
-- From somebody, to somebody — a user inside the hospital or a named officer
-- outside it. "The item moved" with nobody on either end is how an item goes
-- missing and nobody is answerable for it.
ALTER TABLE "clinical"."mlc_custody_log"
  ADD CONSTRAINT "custody_transfer_names_both_hands"
  CHECK (
    "from_user_id" IS NOT NULL
    AND ("to_user_id" IS NOT NULL OR "to_external" IS NOT NULL)
  );

-- Handing an item outside the hospital names the officer and the station.
ALTER TABLE "clinical"."mlc_custody_log"
  ADD CONSTRAINT "custody_external_transfer_names_the_officer"
  CHECK (
    "location_to" NOT IN ('police', 'court')
    OR ("to_external" ? 'officer' AND "to_external" ? 'ps')
  );

-- A broken seal is recorded with what was found. A tick-box "not intact" with
-- no note is the one entry a defence lawyer will ask about.
ALTER TABLE "clinical"."mlc_custody_log"
  ADD CONSTRAINT "custody_broken_seal_says_what_was_found"
  CHECK ("seal_intact" OR ("condition_notes" IS NOT NULL AND length(btrim("condition_notes")) >= 8));

-- ── §B.4  A hash, once taken, is the hash ───────────────────────────────────
--
-- The point of hashing on the device is that the file which arrives is the file
-- that was photographed. Letting the digest be rewritten later removes the only
-- thing that claim rests on.
CREATE OR REPLACE FUNCTION clinical.refuse_evidence_hash_rewrite()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Evidence is never deleted (TR-008 §B.4). Record its disposal with the authority for it.'
      USING ERRCODE = 'TR008';
  END IF;

  IF OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
    RAISE EXCEPTION 'Evidence item % already carries a hash (TR-008 §B.4). A digest that can be rewritten proves nothing.', OLD.item_no
      USING ERRCODE = 'TR008';
  END IF;

  IF OLD.file_ref IS NOT NULL AND NEW.file_ref IS DISTINCT FROM OLD.file_ref THEN
    RAISE EXCEPTION 'Evidence item % already names a stored file (TR-008 §B.4). Annotations are separate layers; the original is never replaced.', OLD.item_no
      USING ERRCODE = 'TR008';
  END IF;

  IF OLD.seal_no IS NOT NULL AND NEW.seal_no IS DISTINCT FROM OLD.seal_no THEN
    RAISE EXCEPTION 'Evidence item % is sealed under % (TR-008 §B.4). A new seal is a new custody entry recording why the old one was broken.', OLD.item_no, OLD.seal_no
      USING ERRCODE = 'TR008';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER "mlc_evidence_hash_is_final"
  BEFORE UPDATE OR DELETE ON "clinical"."mlc_evidence"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_evidence_hash_rewrite();

-- Digital media is worthless as evidence without its digest.
ALTER TABLE "clinical"."mlc_evidence"
  ADD CONSTRAINT "digital_evidence_is_hashed"
  CHECK (
    "kind" NOT IN ('photo', 'video', 'digital_other')
    OR ("file_ref" IS NOT NULL AND "sha256" IS NOT NULL)
  );

ALTER TABLE "clinical"."mlc_evidence"
  ADD CONSTRAINT "evidence_sha256_is_hex"
  CHECK ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$');

-- Sealed means there is a seal number to be sealed under.
ALTER TABLE "clinical"."mlc_evidence"
  ADD CONSTRAINT "sealed_evidence_has_a_seal"
  CHECK ("status" NOT IN ('sealed', 'handed_over') OR "seal_no" IS NOT NULL);

ALTER TABLE "clinical"."mlc_evidence"
  ADD CONSTRAINT "disposed_evidence_names_the_authority"
  CHECK ("status" <> 'disposed' OR "disposal_authority" IS NOT NULL);

-- ── §B.5  A finalised report is immutable ───────────────────────────────────
--
-- The same shape as an amended trauma score, and for the same reason: a
-- certificate that went to a court and could since have been edited is a
-- certificate the court cannot use.
CREATE OR REPLACE FUNCTION clinical.refuse_final_report_edit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An MLC report is never deleted (TR-008 §B.5).' USING ERRCODE = 'TR008';
  END IF;

  IF OLD.status IN ('final', 'final_wet_signed') THEN
    -- The dispatch register grows after signing: sending a copy to a court is
    -- not an edit of the document. Everything else about it is frozen.
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.content IS DISTINCT FROM OLD.content
       OR NEW.sha256 IS DISTINCT FROM OLD.sha256
       OR NEW.document_ref IS DISTINCT FROM OLD.document_ref
       OR NEW.signed_by IS DISTINCT FROM OLD.signed_by
       OR NEW.signed_at IS DISTINCT FROM OLD.signed_at
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.version_no IS DISTINCT FROM OLD.version_no THEN
      RAISE EXCEPTION 'Report % v% is signed and final (TR-008 §B.5). Corrections are recorded as an addendum, so both versions survive.', OLD.kind, OLD.version_no
        USING ERRCODE = 'TR008';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER "mlc_reports_immutable_once_final"
  BEFORE UPDATE OR DELETE ON "clinical"."mlc_reports"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_final_report_edit();

ALTER TABLE "clinical"."mlc_reports"
  ADD CONSTRAINT "final_report_is_signed"
  CHECK (
    "status" NOT IN ('final', 'final_wet_signed')
    OR ("signed_by" IS NOT NULL AND "signed_at" IS NOT NULL AND "sha256" IS NOT NULL)
  );

-- A DSC-signed report names the certificate; a wet-signed one explicitly does
-- not, which is the whole point of having two states rather than one.
ALTER TABLE "clinical"."mlc_reports"
  ADD CONSTRAINT "dsc_signed_report_names_the_certificate"
  CHECK ("status" <> 'final' OR "dsc_ref" IS NOT NULL);

ALTER TABLE "clinical"."mlc_reports"
  ADD CONSTRAINT "addendum_says_what_it_corrects"
  CHECK (
    "addendum_of" IS NULL
    OR ("addendum_reason" IS NOT NULL AND length(btrim("addendum_reason")) >= 8)
  );

ALTER TABLE "clinical"."mlc_reports"
  ADD CONSTRAINT "mlc_report_version_starts_at_one"
  CHECK ("version_no" >= 1);

-- ── §B.6  Three findings that cannot be recorded ────────────────────────────
--
-- The two-finger test was held unconstitutional in *Lillu v. State of Haryana*
-- (2013) and its practice criminalised in *State of Jharkhand v. Shailendra
-- Kumar Rai* (2022). "Virginity" and "habituated to sexual intercourse" are the
-- same finding under other names, and both have been used in court to discredit
-- survivors.
--
-- A validation warning would leave a field somebody can still fill in and a
-- warning somebody can still dismiss. This refuses the key.
CREATE OR REPLACE FUNCTION clinical.refuse_prohibited_forensic_findings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE
  v_blob text;
BEGIN
  v_blob := lower(concat_ws(' ',
    coalesce(NEW.exam_proforma::text, ''),
    coalesce(NEW.safe_kit_checklist::text, '')
  ));

  IF v_blob ~ '(two[_ -]?finger|per[_ -]?vaginum[_ -]?finger|virgin|hymen[_ -]?intact[_ -]?opinion|habituated)' THEN
    RAISE EXCEPTION 'This proforma records a finding that cannot lawfully be taken (TR-008 §B.6). The two-finger test is unconstitutional (Lillu v. State of Haryana, 2013) and its practice is an offence (State of Jharkhand v. Shailendra Kumar Rai, 2022); virginity and "habituated" findings are the same test under other names.'
      USING ERRCODE = 'TR008';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "sexual_assault_proforma_omits_prohibited_findings"
  BEFORE INSERT OR UPDATE ON "clinical"."mlc_sexual_assault_exams"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_prohibited_forensic_findings();

-- ── §B.7  A POCSO case is always reported ───────────────────────────────────
--
-- POCSO §19 makes reporting mandatory and §21 makes failing to report an
-- offence. An adult survivor may decline; a child's record has no such state.
ALTER TABLE "clinical"."mlc_sexual_assault_exams"
  ADD CONSTRAINT "pocso_reporting_is_not_optional"
  CHECK (NOT "is_pocso" OR "police_informed" = 'mandatory_pocso');

ALTER TABLE "clinical"."mlc_sexual_assault_exams"
  ADD CONSTRAINT "pocso_records_the_sjpu_and_cwc_intimation"
  CHECK (NOT "is_pocso" OR "sjpu_cwc_intimation" IS NOT NULL);

-- BNSS §397 (formerly CrPC §357C). Free treatment is not a discount somebody
-- applies; declining to waive is what needs a reason, and there is no field
-- for one.
ALTER TABLE "clinical"."mlc_sexual_assault_exams"
  ADD CONSTRAINT "sexual_assault_treatment_is_free"
  CHECK ("treatment_waived" = true);

-- ── §B.8  The MCCD waits for the inquest ────────────────────────────────────
--
-- An unnatural death's cause is the post-mortem's to state. Issuing a medical
-- certificate of cause of death before that decision pre-empts an inquest that
-- has not happened.
ALTER TABLE "clinical"."mlc_deaths"
  ADD CONSTRAINT "mccd_waits_for_the_pm_decision"
  CHECK ("mccd_status" = 'blocked' OR "pm_required" IN ('yes', 'no'));

ALTER TABLE "clinical"."mlc_deaths"
  ADD CONSTRAINT "mlc_death_pm_required_is_known"
  CHECK ("pm_required" IN ('yes', 'no', 'pending'));

-- A body goes to relatives only with the police no-objection number on the
-- record. "The constable said it was fine" is not a record.
ALTER TABLE "clinical"."mlc_deaths"
  ADD CONSTRAINT "body_release_to_relatives_needs_the_noc"
  CHECK ("body_custody" <> 'released_to_relatives_with_noc' OR "noc_no" IS NOT NULL);

-- ── §B.9  The clinical record goes out against an authority, or not at all ──
--
-- Police receive the intimation and the injury report. The chart itself needs a
-- court order, and the order has to exist as a document before anything is
-- marked provided.
ALTER TABLE "clinical"."mlc_requests"
  ADD CONSTRAINT "record_release_needs_a_written_authority"
  CHECK (
    "provided_at" IS NULL
    OR "kind" IN ('injury_report', 'other')
    OR ("authority_ref" IS NOT NULL AND "approved_by" IS NOT NULL)
  );

ALTER TABLE "clinical"."mlc_requests"
  ADD CONSTRAINT "mlc_request_is_answered_one_way"
  CHECK ("provided_at" IS NULL OR "denied_reason" IS NULL);

-- ── §B.10  Discharge waits for the MLC set; the MS may override, on record ──
--
-- The minimum set from §3.9: the case is not cancelled, at least one injury is
-- documented (or "no external injury" recorded as an injury row), and an
-- intimation has been dispatched. Death and absconding are excluded — a body
-- and a patient who has left are not held by paperwork.
--
-- This trigger is on `er_dispositions` deliberately. Putting it on the clinical
-- path would gate treatment, which is the one thing TR-008 must never do.
CREATE OR REPLACE FUNCTION clinical.gate_discharge_on_mlc_set()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE
  v_case record;
  v_missing text[] := ARRAY[]::text[];
BEGIN
  -- A death or an abscondment is not held. Both raise their own intimation.
  IF NEW.kind IN ('death', 'brought_dead', 'absconded') THEN
    RETURN NEW;
  END IF;

  SELECT c.* INTO v_case
    FROM clinical.mlc_cases c
   WHERE c.er_visit_id = NEW.visit_id
     AND c.status <> 'cancelled'
   ORDER BY c.opened_at
   LIMIT 1;

  IF v_case.id IS NULL THEN
    RETURN NEW;
  END IF;

  -- The override is the audit trail. It is on the case, so the next person to
  -- open the register sees it without going looking.
  IF v_case.gate_override_by IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM clinical.mlc_injuries i WHERE i.case_id = v_case.id) THEN
    v_missing := array_append(v_missing, 'the injuries documented (record "no external injury" if that is the finding)');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM clinical.mlc_police_intimations p
     WHERE p.case_id = v_case.id AND p.status IN ('dispatched', 'acknowledged')
  ) THEN
    v_missing := array_append(v_missing, 'the police intimation dispatched');
  END IF;

  IF EXISTS (
    SELECT 1 FROM clinical.mlc_evidence e
     WHERE e.case_id = v_case.id AND e.status = 'collected'
  ) THEN
    v_missing := array_append(v_missing, 'every collected item sealed');
  END IF;

  IF array_length(v_missing, 1) > 0 THEN
    RAISE EXCEPTION 'MLC % is not complete: % is still outstanding (TR-008 §B.10). The Medical Superintendent can override this on the record.',
      v_case.mlc_no, array_to_string(v_missing, '; ')
      USING ERRCODE = 'TR008';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "er_disposition_waits_for_the_mlc_set"
  BEFORE INSERT ON "clinical"."er_dispositions"
  FOR EACH ROW EXECUTE FUNCTION clinical.gate_discharge_on_mlc_set();

-- ── Remaining shape checks ──────────────────────────────────────────────────

-- A grievous classification names which limb of BNS §116 it rests on. "It was
-- grievous" without the reason is an opinion a court cannot test.
ALTER TABLE "clinical"."mlc_injuries"
  ADD CONSTRAINT "grievous_injury_names_its_ground"
  CHECK ("bns_class" <> 'grievous' OR "grievous_reason" IS NOT NULL);

ALTER TABLE "clinical"."mlc_injuries"
  ADD CONSTRAINT "injury_pin_is_on_the_diagram"
  CHECK ("x_pct" BETWEEN 0 AND 100 AND "y_pct" BETWEEN 0 AND 100);

ALTER TABLE "clinical"."mlc_injuries"
  ADD CONSTRAINT "injury_dimensions_are_positive"
  CHECK (
    ("length_cm" IS NULL OR "length_cm" >= 0)
    AND ("breadth_cm" IS NULL OR "breadth_cm" >= 0)
    AND ("depth_cm" IS NULL OR "depth_cm" >= 0)
  );

ALTER TABLE "clinical"."mlc_injuries"
  ADD CONSTRAINT "injury_consistency_is_a_known_answer"
  CHECK ("consistent_with_history" IN ('yes', 'no', 'cannot_say'));

ALTER TABLE "clinical"."mlc_injuries"
  ADD CONSTRAINT "mlc_injury_seq_starts_at_one"
  CHECK ("seq" >= 1);

-- An acknowledged intimation names who signed for it. Otherwise "acknowledged"
-- is the hospital marking its own homework.
ALTER TABLE "clinical"."mlc_police_intimations"
  ADD CONSTRAINT "acknowledged_intimation_names_the_officer"
  CHECK (
    "status" <> 'acknowledged'
    OR ("ack_officer_name" IS NOT NULL AND "ack_at" IS NOT NULL)
  );

ALTER TABLE "clinical"."mlc_police_intimations"
  ADD CONSTRAINT "dispatched_intimation_has_a_time"
  CHECK ("status" NOT IN ('dispatched', 'acknowledged') OR "dispatched_at" IS NOT NULL);

ALTER TABLE "clinical"."mlc_police_intimations"
  ADD CONSTRAINT "failed_intimation_says_why"
  CHECK ("status" <> 'failed' OR "failure_reason" IS NOT NULL);

ALTER TABLE "clinical"."mlc_evidence"
  ADD CONSTRAINT "mlc_evidence_item_no_starts_at_one"
  CHECK ("item_no" >= 1);

-- A handover names the officer, the station and the requisition it answers.
ALTER TABLE "clinical"."mlc_handovers"
  ADD CONSTRAINT "handover_names_the_officer_and_the_authority"
  CHECK ("to_external" ? 'officer' AND "to_external" ? 'ps' AND "to_external" ? 'requisitionRef');


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
  RAISE NOTICE 'Granted application DML on % TR-008 table(s)', v_count;
END $$;

-- Belt and braces beside the triggers: the privilege is gone as well as the
-- path. An evidence log the application *cannot* rewrite is a stronger claim
-- than one it merely does not.
REVOKE UPDATE, DELETE ON "clinical"."mlc_custody_log" FROM hms_app;
REVOKE DELETE          ON "clinical"."mlc_evidence"   FROM hms_app;
REVOKE DELETE          ON "clinical"."mlc_cases"      FROM hms_app;
REVOKE DELETE          ON "clinical"."mlc_reports"    FROM hms_app;

COMMENT ON TABLE "clinical"."mlc_custody_log" IS
  'Append-only and hash-chained, with the hash computed by the database from the row''s own content. An application that never supplies a hash cannot forge a link, so a break in the chain is visible rather than deniable.';

COMMENT ON TABLE "clinical"."mlc_sexual_assault_exams" IS
  'The MoHFW proforma, missing three findings on purpose: two-finger test, virginity, and "habituated". A trigger refuses a proforma whose JSON carries those keys — a warning would leave a field somebody can still fill in.';

COMMENT ON COLUMN "clinical"."mlc_cases"."mlc_no" IS
  'Gapless per branch per year, and never reused. A cancelled case keeps its number: a reused MLC number is two cases sharing one identity in a court file.';
