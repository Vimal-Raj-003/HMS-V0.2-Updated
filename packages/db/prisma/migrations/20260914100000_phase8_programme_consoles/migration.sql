-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-013 · OP-014 — the programme consoles
-- Where the unit of work is a schedule, and the failure is a sequence
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Both of these run people through a plan rather than through a consultation,
-- and in both the characteristic mistake is doing the right thing in the wrong
-- order — a dose three days early, a sugar drawn before the breakfast, a report
-- signed over a scan nobody did. None of those looks like a mistake afterwards.
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **A vaccine dose respects its minimum age and its minimum interval.** Both
--    exist because a dose inside them produces a weaker response, and both are
--    routinely broken by a busy camp working from a chart on a wall. The
--    refusal names the date the dose *becomes* valid, because "come back on the
--    14th" is the only useful form of it.
--
-- 2. **An opened vial has a clock, and a dose after it is refused.** Six hours
--    for most live vaccines, twenty-eight days for many killed ones, from the
--    puncture. The alternative is a cold chain that looks intact in every
--    record and a vial that has been on a bench since morning.
--
-- 3. **A vial does not yield more doses than it holds.** Twelve doses out of a
--    ten-dose vial is wastage being hidden or a dilution error, and both matter
--    enough that neither should be possible to record.
--
-- 4. **A batch under a cold chain hold does not move.** When a refrigerator
--    breaches, its batches are held while somebody decides. Until then every
--    dose from them is refused — which is the only moment a hold means
--    anything, because a held batch that can still be given is a note in a book.
--
-- 5. **A serious adverse event is not closed without its first information
--    report.** The statutory clock is twenty-four hours, and the report that
--    does not go is the one nobody was told was due.
--
-- 6. **A health check station does not start before what it depends on.** The
--    post-prandial sugar before the breakfast is a wasted morning; the mammogram
--    before the consent is worse.
--
-- 7. **A health check report is not signed while a station is pending.** The
--    characteristic failure is a "normal" report covering an ultrasound the
--    patient skipped because the queue was long: it reads as reassurance, it is
--    filed, and the finding nobody looked for surfaces two years later. Each
--    station is done, or explicitly skipped with a reason that goes on the
--    report.
--
-- 8. **The health score is derived from the domain scores.** It is the number
--    the patient reads and the corporate client is invoiced against.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATEs: OP013, OP014.
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "specialty"."HcBookingStatus" AS ENUM ('booked', 'confirmed', 'checked_in', 'in_progress', 'completed', 'report_ready', 'delivered', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "specialty"."HcTaskStatus" AS ENUM ('pending', 'called', 'in_progress', 'done', 'skipped', 'not_applicable');

-- CreateEnum
CREATE TYPE "specialty"."HcReportStatus" AS ENUM ('draft', 'final', 'addendum');

-- CreateEnum
CREATE TYPE "mdm"."VaccineStorage" AS ENUM ('ilr', 'deep_freezer', 'ultra_cold');

-- CreateEnum
CREATE TYPE "specialty"."PlanDoseStatus" AS ENUM ('due', 'given', 'overdue', 'skipped', 'contraindicated', 'refused', 'given_elsewhere');

-- CreateEnum
CREATE TYPE "specialty"."VialDiscardReason" AS ENUM ('time_expired', 'vvm', 'cold_chain_breach', 'contaminated', 'empty');

-- CreateEnum
CREATE TYPE "specialty"."BreachAction" AS ENUM ('hold', 'released', 'discarded');

-- CreateEnum
CREATE TYPE "specialty"."AefiSeverity" AS ENUM ('minor', 'severe', 'serious');

-- CreateTable
CREATE TABLE "specialty"."hc_packages" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "tier" VARCHAR(40),
    "gender" VARCHAR(10) NOT NULL DEFAULT 'any',
    "age_min" INTEGER,
    "age_max" INTEGER,
    "fasting_hours" INTEGER,
    "station_sequence" JSONB NOT NULL,
    "report_template_id" UUID,
    "health_score_model_id" UUID,
    "add_ons" JSONB NOT NULL DEFAULT '[]',
    "valid_days" INTEGER,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "corporate_only" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hc_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."hc_bookings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID,
    "corporate_id" UUID,
    "employee_ref" VARCHAR(60),
    "package_id" UUID NOT NULL,
    "package_version" INTEGER NOT NULL,
    "add_ons" JSONB NOT NULL DEFAULT '[]',
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "channel" VARCHAR(24) NOT NULL,
    "advance_bill_id" UUID,
    "payment_status" VARCHAR(20) NOT NULL DEFAULT 'unpaid',
    "status" "specialty"."HcBookingStatus" NOT NULL DEFAULT 'booked',
    "instructions_sent_at" TIMESTAMPTZ(6),
    "reminders" JSONB NOT NULL DEFAULT '[]',
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hc_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."hc_episodes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "booking_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "visit_id" UUID,
    "checked_in_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "routing_slip_no" VARCHAR(32) NOT NULL,
    "consent_id" UUID,
    "orders" JSONB NOT NULL DEFAULT '{}',
    "completed_at" TIMESTAMPTZ(6),
    "physician_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hc_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."hc_station_tasks" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "station" VARCHAR(32) NOT NULL,
    "seq" INTEGER NOT NULL,
    "depends_on" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "specialty"."HcTaskStatus" NOT NULL DEFAULT 'pending',
    "token_id" UUID,
    "called_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "done_at" TIMESTAMPTZ(6),
    "done_by" UUID,
    "skip_reason" TEXT,
    "source_ref" UUID,
    "wait_min" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hc_station_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."hc_reports" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "domain_scores" JSONB NOT NULL DEFAULT '{}',
    "health_score" DECIMAL(5,2),
    "risk_calcs" JSONB NOT NULL DEFAULT '{}',
    "comparison" JSONB NOT NULL DEFAULT '{}',
    "summary" TEXT,
    "recommendations" JSONB NOT NULL DEFAULT '[]',
    "referrals" JSONB NOT NULL DEFAULT '[]',
    "status" "specialty"."HcReportStatus" NOT NULL DEFAULT 'draft',
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "pdf_key" VARCHAR(500),
    "document_id" UUID,
    "delivered" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hc_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."hc_health_score_models" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "domains" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "hc_health_score_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mdm"."vaccines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID,
    "antigen_code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "brand" VARCHAR(120),
    "manufacturer" VARCHAR(160),
    "doses_per_vial" INTEGER NOT NULL,
    "dose_volume_ml" DECIMAL(5,2) NOT NULL,
    "route" VARCHAR(24) NOT NULL,
    "default_site_by_age" JSONB NOT NULL DEFAULT '{}',
    "storage" "mdm"."VaccineStorage" NOT NULL,
    "vvm_type" VARCHAR(12),
    "open_vial_hours" INTEGER NOT NULL,
    "live" BOOLEAN NOT NULL DEFAULT false,
    "requires_diluent" BOOLEAN NOT NULL DEFAULT false,
    "diluent_item_id" UUID,
    "item_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vaccines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mdm"."immunisation_schedules" (
    "id" UUID NOT NULL,
    "hospital_id" UUID,
    "name" VARCHAR(60) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "rules" JSONB NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "immunisation_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."immunisation_plan_doses" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "antigen_code" VARCHAR(24) NOT NULL,
    "dose_no" INTEGER NOT NULL,
    "due_date" DATE NOT NULL,
    "window_from" DATE,
    "window_to" DATE,
    "status" "specialty"."PlanDoseStatus" NOT NULL DEFAULT 'due',
    "given_record_id" UUID,
    "reason" TEXT,
    "next_reminder_at" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "immunisation_plan_doses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."open_vials" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "vaccine_id" UUID NOT NULL,
    "item_id" UUID,
    "batch_no" VARCHAR(60) NOT NULL,
    "expiry_date" DATE NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by" UUID NOT NULL,
    "doses_total" INTEGER NOT NULL,
    "doses_used" INTEGER NOT NULL DEFAULT 0,
    "discard_due_at" TIMESTAMPTZ(6) NOT NULL,
    "discarded_at" TIMESTAMPTZ(6),
    "discard_reason" "specialty"."VialDiscardReason",
    "wastage_doses" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "open_vials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."cold_chain_units" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "asset_id" UUID,
    "code" VARCHAR(40) NOT NULL,
    "kind" VARCHAR(24) NOT NULL,
    "location" VARCHAR(160) NOT NULL,
    "min_c" DECIMAL(5,2) NOT NULL,
    "max_c" DECIMAL(5,2) NOT NULL,
    "sensor_id" VARCHAR(60),
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cold_chain_units_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."cold_chain_breaches" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "peak_c" DECIMAL(5,2) NOT NULL,
    "duration_min" INTEGER,
    "batches_affected" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "action" "specialty"."BreachAction" NOT NULL DEFAULT 'hold',
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cold_chain_breaches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."vaccination_records" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "visit_id" UUID,
    "plan_dose_id" UUID,
    "vaccine_id" UUID NOT NULL,
    "antigen_code" VARCHAR(24) NOT NULL,
    "dose_no" INTEGER NOT NULL,
    "batch_no" VARCHAR(60) NOT NULL,
    "expiry_date" DATE NOT NULL,
    "vvm_stage" INTEGER,
    "vial_id" UUID,
    "diluent_batch" VARCHAR(60),
    "site" VARCHAR(40) NOT NULL,
    "route" VARCHAR(24) NOT NULL,
    "dose_ml" DECIMAL(5,2) NOT NULL,
    "administered_at" TIMESTAMPTZ(6) NOT NULL,
    "administered_by" UUID NOT NULL,
    "ordered_by" UUID,
    "consent_id" UUID,
    "screening" JSONB NOT NULL DEFAULT '{}',
    "observation_until" TIMESTAMPTZ(6),
    "camp_id" UUID,
    "source" VARCHAR(24) NOT NULL DEFAULT 'in_house',
    "external_facility" VARCHAR(160),
    "certificate_id" UUID,
    "registry_status" VARCHAR(16) NOT NULL DEFAULT 'na',
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "void_reason" TEXT,
    "voided_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vaccination_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."aefi_reports" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "vaccination_record_ids" UUID[],
    "onset_at" TIMESTAMPTZ(6) NOT NULL,
    "reported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reporter_id" UUID NOT NULL,
    "symptoms" JSONB NOT NULL DEFAULT '{}',
    "severity" "specialty"."AefiSeverity" NOT NULL,
    "category" VARCHAR(32),
    "treatment" TEXT,
    "outcome" VARCHAR(24),
    "fir_sent_at" TIMESTAMPTZ(6),
    "pir_due_at" DATE,
    "pir_sent_at" TIMESTAMPTZ(6),
    "cif_due_at" DATE,
    "cif_sent_at" TIMESTAMPTZ(6),
    "causality" VARCHAR(40),
    "district_case_id" VARCHAR(60),
    "incident_id" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "aefi_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hc_packages_hospital_id_is_public_corporate_only_idx" ON "specialty"."hc_packages"("hospital_id", "is_public", "corporate_only");

-- CreateIndex
CREATE UNIQUE INDEX "uq_hc_package_version" ON "specialty"."hc_packages"("hospital_id", "code", "version");

-- CreateIndex
CREATE INDEX "hc_bookings_hospital_id_branch_id_scheduled_at_status_idx" ON "specialty"."hc_bookings"("hospital_id", "branch_id", "scheduled_at", "status");

-- CreateIndex
CREATE INDEX "hc_bookings_hospital_id_corporate_id_status_idx" ON "specialty"."hc_bookings"("hospital_id", "corporate_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "hc_episodes_booking_id_key" ON "specialty"."hc_episodes"("booking_id");

-- CreateIndex
CREATE INDEX "hc_episodes_hospital_id_branch_id_checked_in_at_idx" ON "specialty"."hc_episodes"("hospital_id", "branch_id", "checked_in_at" DESC);

-- CreateIndex
CREATE INDEX "hc_episodes_hospital_id_patient_id_checked_in_at_idx" ON "specialty"."hc_episodes"("hospital_id", "patient_id", "checked_in_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_hc_routing_slip" ON "specialty"."hc_episodes"("hospital_id", "routing_slip_no");

-- CreateIndex
CREATE INDEX "hc_station_tasks_hospital_id_status_started_at_idx" ON "specialty"."hc_station_tasks"("hospital_id", "status", "started_at");

-- CreateIndex
CREATE INDEX "hc_station_tasks_hospital_id_episode_id_seq_idx" ON "specialty"."hc_station_tasks"("hospital_id", "episode_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "uq_hc_task_station" ON "specialty"."hc_station_tasks"("episode_id", "station");

-- CreateIndex
CREATE INDEX "hc_reports_hospital_id_status_created_at_idx" ON "specialty"."hc_reports"("hospital_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_hc_report_version" ON "specialty"."hc_reports"("episode_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "uq_hc_score_model_version" ON "specialty"."hc_health_score_models"("hospital_id", "name", "version");

-- CreateIndex
CREATE INDEX "vaccines_hospital_id_antigen_code_is_active_idx" ON "mdm"."vaccines"("hospital_id", "antigen_code", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "uq_vaccine_brand" ON "mdm"."vaccines"("hospital_id", "antigen_code", "brand");

-- CreateIndex
CREATE UNIQUE INDEX "uq_immunisation_schedule_version" ON "mdm"."immunisation_schedules"("hospital_id", "name", "version");

-- CreateIndex
CREATE INDEX "immunisation_plan_doses_hospital_id_due_date_status_idx" ON "specialty"."immunisation_plan_doses"("hospital_id", "due_date", "status");

-- CreateIndex
CREATE INDEX "immunisation_plan_doses_hospital_id_patient_id_status_idx" ON "specialty"."immunisation_plan_doses"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_plan_dose" ON "specialty"."immunisation_plan_doses"("hospital_id", "patient_id", "antigen_code", "dose_no");

-- CreateIndex
CREATE INDEX "open_vials_hospital_id_branch_id_discard_due_at_idx" ON "specialty"."open_vials"("hospital_id", "branch_id", "discard_due_at");

-- CreateIndex
CREATE INDEX "open_vials_hospital_id_batch_no_idx" ON "specialty"."open_vials"("hospital_id", "batch_no");

-- CreateIndex
CREATE INDEX "cold_chain_units_hospital_id_branch_id_status_idx" ON "specialty"."cold_chain_units"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_cold_chain_unit_code" ON "specialty"."cold_chain_units"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "cold_chain_breaches_hospital_id_action_started_at_idx" ON "specialty"."cold_chain_breaches"("hospital_id", "action", "started_at" DESC);

-- CreateIndex
CREATE INDEX "vaccination_records_hospital_id_patient_id_administered_at_idx" ON "specialty"."vaccination_records"("hospital_id", "patient_id", "administered_at" DESC);

-- CreateIndex
CREATE INDEX "vaccination_records_hospital_id_batch_no_idx" ON "specialty"."vaccination_records"("hospital_id", "batch_no");

-- CreateIndex
CREATE INDEX "vaccination_records_hospital_id_branch_id_administered_at_idx" ON "specialty"."vaccination_records"("hospital_id", "branch_id", "administered_at" DESC);

-- CreateIndex
CREATE INDEX "aefi_reports_hospital_id_severity_status_idx" ON "specialty"."aefi_reports"("hospital_id", "severity", "status");

-- CreateIndex
CREATE INDEX "aefi_reports_hospital_id_patient_id_onset_at_idx" ON "specialty"."aefi_reports"("hospital_id", "patient_id", "onset_at" DESC);

-- AddForeignKey
ALTER TABLE "specialty"."hc_bookings" ADD CONSTRAINT "hc_bookings_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "specialty"."hc_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."hc_episodes" ADD CONSTRAINT "hc_episodes_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "specialty"."hc_bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."hc_station_tasks" ADD CONSTRAINT "hc_station_tasks_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."hc_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."hc_reports" ADD CONSTRAINT "hc_reports_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."hc_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."cold_chain_breaches" ADD CONSTRAINT "cold_chain_breaches_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "specialty"."cold_chain_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."vaccination_records" ADD CONSTRAINT "vaccination_records_vial_id_fkey" FOREIGN KEY ("vial_id") REFERENCES "specialty"."open_vials"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- §B.1  OP-013 · Immunisation
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.1.1  The minimum age and the minimum interval ───────────────────────
--
-- The two rules every national schedule states and every busy session breaks.
-- A dose given inside either does not count, the child is recorded as
-- protected, and nobody finds out for a decade.
--
-- The refusal names the date the dose becomes valid, because a nurse holding a
-- syringe needs "come back on the 14th", not "interval violation".
CREATE OR REPLACE FUNCTION specialty.a_dose_waits_its_interval()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_dob date;
  v_rule jsonb;
  v_min_age int;
  v_min_interval int;
  v_prev_at timestamptz;
  v_age_days int;
  v_valid_from date;
BEGIN
  IF NEW.voided THEN
    RETURN NEW;
  END IF;

  SELECT dob INTO v_dob FROM patient.patients WHERE id = NEW.patient_id;

  -- The rule for this antigen and dose number, from whichever schedule is in
  -- force. A dose with no rule is a travel or catch-up vaccine outside the
  -- programme, and it is not this trigger's business.
  SELECT r INTO v_rule
    FROM mdm.immunisation_schedules s
    CROSS JOIN LATERAL jsonb_array_elements(s.rules) r
   WHERE s.is_active
     AND (s.hospital_id IS NULL OR s.hospital_id = NEW.hospital_id)
     AND r->>'antigen' = NEW.antigen_code
     AND (r->>'doseNo')::int = NEW.dose_no
   ORDER BY s.hospital_id NULLS LAST, s.version DESC
   LIMIT 1;

  IF v_rule IS NULL THEN
    RETURN NEW;
  END IF;

  -- ── Minimum age ────────────────────────────────────────────────────────
  v_min_age := nullif(v_rule->>'minAgeDays', '')::int;
  IF v_min_age IS NOT NULL AND v_dob IS NOT NULL THEN
    v_age_days := (NEW.administered_at::date - v_dob);
    IF v_age_days < v_min_age THEN
      v_valid_from := v_dob + v_min_age;
      RAISE EXCEPTION '% dose % cannot be given before % days of age; this patient is % days old and becomes eligible on % (OP-013 §B.1.1). A dose given early does not count and has to be repeated.',
        NEW.antigen_code, NEW.dose_no, v_min_age, v_age_days, to_char(v_valid_from, 'DD Mon YYYY')
        USING ERRCODE = 'OP013';
    END IF;
  END IF;

  -- ── Minimum interval from the previous dose ────────────────────────────
  v_min_interval := nullif(v_rule->>'minIntervalDays', '')::int;
  IF v_min_interval IS NOT NULL AND NEW.dose_no > 1 THEN
    -- Any previous dose of this antigen counts, wherever it was given: a dose
    -- from a card the mother brought is still a dose the interval runs from.
    SELECT max(administered_at) INTO v_prev_at
      FROM specialty.vaccination_records
     WHERE hospital_id = NEW.hospital_id
       AND patient_id = NEW.patient_id
       AND antigen_code = NEW.antigen_code
       AND dose_no < NEW.dose_no
       AND NOT voided
       AND id IS DISTINCT FROM NEW.id;

    IF v_prev_at IS NOT NULL
       AND (NEW.administered_at::date - v_prev_at::date) < v_min_interval THEN
      v_valid_from := v_prev_at::date + v_min_interval;
      RAISE EXCEPTION '% dose % needs % days after the previous dose, which was given on %. It becomes valid on % (OP-013 §B.1.1) — a dose given sooner does not count and has to be repeated.',
        NEW.antigen_code, NEW.dose_no, v_min_interval,
        to_char(v_prev_at, 'DD Mon YYYY'), to_char(v_valid_from, 'DD Mon YYYY')
        USING ERRCODE = 'OP013';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "a_dose_waits_its_interval"
  BEFORE INSERT ON "specialty"."vaccination_records"
  FOR EACH ROW EXECUTE FUNCTION specialty.a_dose_waits_its_interval();

-- ── §B.1.2  The vial's clock, its capacity, and any hold on its batch ──────
CREATE OR REPLACE FUNCTION specialty.a_dose_comes_from_a_usable_vial()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_discard_due timestamptz;
  v_discarded timestamptz;
  v_total int;
  v_used int;
  v_held text;
BEGIN
  IF NEW.voided OR NEW.source IN ('external_history', 'registry_sync') THEN
    -- A dose recorded from somebody else's card came from somebody else's vial.
    RETURN NEW;
  END IF;

  -- ── The batch, against any live cold chain hold ────────────────────────
  SELECT string_agg(to_char(b.started_at, 'DD Mon HH24:MI'), ', ') INTO v_held
    FROM specialty.cold_chain_breaches b
   WHERE b.hospital_id = NEW.hospital_id
     AND b.action = 'hold'
     AND NEW.batch_no = ANY (b.batches_affected);

  IF v_held IS NOT NULL THEN
    RAISE EXCEPTION 'Batch % is held after a cold chain breach (%) and cannot be given until somebody decides whether it is still viable (OP-013 §B.1.2). A held batch that can still be administered is a note in a book.',
      NEW.batch_no, v_held
      USING ERRCODE = 'OP013';
  END IF;

  IF NEW.vial_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT discard_due_at, discarded_at, doses_total, doses_used
    INTO v_discard_due, v_discarded, v_total, v_used
    FROM specialty.open_vials WHERE id = NEW.vial_id;

  IF v_discarded IS NOT NULL THEN
    RAISE EXCEPTION 'That vial was discarded on % (OP-013 §B.1.2).', to_char(v_discarded, 'DD Mon HH24:MI')
      USING ERRCODE = 'OP013';
  END IF;

  IF NEW.administered_at > v_discard_due THEN
    RAISE EXCEPTION 'That vial was due for discard at % and cannot be drawn from afterwards (OP-013 §B.1.2). The open-vial clock starts at the puncture, and a cold chain that looks intact in the record is the whole problem it exists to prevent.',
      to_char(v_discard_due, 'DD Mon HH24:MI')
      USING ERRCODE = 'OP013';
  END IF;

  IF v_used >= v_total THEN
    RAISE EXCEPTION 'That vial holds % doses and % have already been drawn (OP-013 §B.1.2). More doses out of a vial than it contains is wastage being hidden or a dilution error, and both matter.',
      v_total, v_used
      USING ERRCODE = 'OP013';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "a_dose_comes_from_a_usable_vial"
  BEFORE INSERT ON "specialty"."vaccination_records"
  FOR EACH ROW EXECUTE FUNCTION specialty.a_dose_comes_from_a_usable_vial();

-- The count is the database's, so "doses used" and the administrations that
-- used them cannot disagree.
CREATE OR REPLACE FUNCTION specialty.count_vial_doses()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE v_vial uuid;
BEGIN
  v_vial := coalesce(NEW.vial_id, OLD.vial_id);
  IF v_vial IS NULL THEN RETURN NULL; END IF;

  UPDATE specialty.open_vials v
     SET doses_used = (SELECT count(*) FROM specialty.vaccination_records r
                        WHERE r.vial_id = v_vial AND NOT r.voided),
         updated_at = now()
   WHERE v.id = v_vial;
  RETURN NULL;
END $$;

CREATE TRIGGER "vial_doses_are_counted"
  AFTER INSERT OR UPDATE OF voided OR DELETE ON "specialty"."vaccination_records"
  FOR EACH ROW EXECUTE FUNCTION specialty.count_vial_doses();

-- The discard time is the vaccine's own policy applied at the puncture, not a
-- number somebody types.
CREATE OR REPLACE FUNCTION specialty.derive_vial_discard_time()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE v_hours int; v_total int;
BEGIN
  SELECT open_vial_hours, doses_per_vial INTO v_hours, v_total
    FROM mdm.vaccines WHERE id = NEW.vaccine_id;

  IF v_hours IS NULL THEN
    RAISE EXCEPTION 'That vaccine has no open-vial policy recorded, so a vial of it has no discard time (OP-013 §B.1.2).'
      USING ERRCODE = 'OP013';
  END IF;

  NEW.discard_due_at := NEW.opened_at + make_interval(hours => v_hours);
  NEW.doses_total := coalesce(NEW.doses_total, v_total);
  RETURN NEW;
END $$;

CREATE TRIGGER "vial_discard_time_is_derived"
  BEFORE INSERT ON "specialty"."open_vials"
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_vial_discard_time();

ALTER TABLE "specialty"."open_vials"
  ADD CONSTRAINT "a_vial_holds_doses"
  CHECK ("doses_total" > 0 AND "doses_used" >= 0);

ALTER TABLE "specialty"."open_vials"
  ADD CONSTRAINT "a_discarded_vial_says_why"
  CHECK ("discarded_at" IS NULL OR "discard_reason" IS NOT NULL);

-- A dose recorded in error is voided with a reason, never deleted: the record
-- has to show that somebody once thought it had been given.
ALTER TABLE "specialty"."vaccination_records"
  ADD CONSTRAINT "a_voided_dose_says_why"
  CHECK (NOT "voided" OR ("void_reason" IS NOT NULL AND "voided_by" IS NOT NULL));

-- One live record per antigen and dose number. A second is a double-entry, and
-- in an immunisation record a double-entry reads as a double dose.
CREATE UNIQUE INDEX "uq_one_live_dose_per_antigen"
  ON "specialty"."vaccination_records" ("hospital_id", "patient_id", "antigen_code", "dose_no")
  WHERE NOT "voided";

-- A plan dose that was not given says why. "Not given" with no reason is
-- indistinguishable from a child nobody followed up.
ALTER TABLE "specialty"."immunisation_plan_doses"
  ADD CONSTRAINT "a_dose_not_given_says_why"
  CHECK ("status" NOT IN ('skipped', 'contraindicated', 'refused')
     OR ("reason" IS NOT NULL AND length(btrim("reason")) >= 4));

-- ── §B.1.3  A serious adverse event is not closed without its report ───────
CREATE OR REPLACE FUNCTION specialty.a_serious_aefi_is_reported()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  IF NEW.status = 'closed' AND NEW.severity = 'serious' AND NEW.fir_sent_at IS NULL THEN
    RAISE EXCEPTION 'This is a serious adverse event and its first information report has not been sent (OP-013 §B.1.3). The statutory clock is twenty-four hours, and the report that does not go is the one nobody was told was due.'
      USING ERRCODE = 'OP013';
  END IF;

  -- The reporting clock starts at the report, and the dates are the
  -- programme's rather than a clerk's arithmetic.
  IF NEW.severity IN ('severe', 'serious') THEN
    NEW.pir_due_at := coalesce(NEW.pir_due_at, (NEW.reported_at + interval '7 days')::date);
    NEW.cif_due_at := coalesce(NEW.cif_due_at, (NEW.reported_at + interval '90 days')::date);
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "a_serious_aefi_is_reported"
  BEFORE INSERT OR UPDATE ON "specialty"."aefi_reports"
  FOR EACH ROW EXECUTE FUNCTION specialty.a_serious_aefi_is_reported();

-- `array_length` of an empty array is NULL, not 0, and a CHECK that evaluates
-- to NULL passes. The coalesce is the whole rule.
ALTER TABLE "specialty"."aefi_reports"
  ADD CONSTRAINT "an_aefi_follows_a_dose"
  CHECK (coalesce(array_length("vaccination_record_ids", 1), 0) >= 1);


-- ─────────────────────────────────────────────────────────────────────────────
-- §B.2  OP-014 · Health check-ups
-- ─────────────────────────────────────────────────────────────────────────────

-- ── §B.2.1  A station waits for what it depends on ─────────────────────────
--
-- The post-prandial sugar before the breakfast is a wasted morning and a repeat
-- visit; the mammogram before the consent is worse. The dependencies come from
-- the package and are copied onto the slip at check-in, so a package revised
-- mid-morning does not change a slip already walking round the building.
CREATE OR REPLACE FUNCTION specialty.a_station_waits_for_its_dependencies()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_blocking text;
BEGIN
  IF NEW.status NOT IN ('in_progress', 'done')
     OR OLD.status IN ('in_progress', 'done') THEN
    RETURN NEW;
  END IF;

  IF array_length(NEW.depends_on, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  -- Anything still outstanding. `skipped` and `not_applicable` count as
  -- resolved: a station the patient declined does not block the rest of the
  -- morning, it just has to have been a decision.
  SELECT string_agg(t.station, ', ' ORDER BY t.seq) INTO v_blocking
    FROM specialty.hc_station_tasks t
   WHERE t.episode_id = NEW.episode_id
     AND t.station = ANY (NEW.depends_on)
     AND t.status NOT IN ('done', 'skipped', 'not_applicable');

  IF v_blocking IS NOT NULL THEN
    RAISE EXCEPTION '% cannot start until % (OP-014 §B.2.1). The sequence is the package''s, and out of order it is a wasted morning at best.',
      NEW.station, v_blocking
      USING ERRCODE = 'OP014';
  END IF;

  IF NEW.status = 'in_progress' THEN
    NEW.started_at := coalesce(NEW.started_at, now());
    IF NEW.called_at IS NOT NULL THEN
      NEW.wait_min := coalesce(
        NEW.wait_min,
        greatest(0, (extract(epoch FROM (NEW.started_at - NEW.called_at)) / 60)::int)
      );
    END IF;
  END IF;

  IF NEW.status = 'done' THEN
    NEW.done_at := coalesce(NEW.done_at, now());
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "a_station_waits_for_its_dependencies"
  BEFORE UPDATE ON "specialty"."hc_station_tasks"
  FOR EACH ROW EXECUTE FUNCTION specialty.a_station_waits_for_its_dependencies();

-- A station that was not done says why, and the reason goes on the report.
ALTER TABLE "specialty"."hc_station_tasks"
  ADD CONSTRAINT "a_skipped_station_says_why"
  CHECK ("status" NOT IN ('skipped', 'not_applicable')
     OR ("skip_reason" IS NOT NULL AND length(btrim("skip_reason")) >= 4));

ALTER TABLE "specialty"."hc_station_tasks"
  ADD CONSTRAINT "a_done_station_names_who"
  CHECK ("status" <> 'done' OR "done_by" IS NOT NULL);

-- ── §B.2.2  A report is not signed over a station nobody did ───────────────
--
-- The characteristic health-check failure: a "normal" report covering an
-- ultrasound the patient skipped because the queue was long. It reads as
-- reassurance, it is filed, and the finding nobody looked for surfaces two
-- years later. Each station is done, or explicitly skipped with a reason —
-- and the reason appears on the report, which is what makes the difference
-- visible to the person reading it.
CREATE OR REPLACE FUNCTION specialty.a_report_covers_every_station()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_pending text;
  v_count int;
BEGIN
  IF NEW.status <> 'final' OR (TG_OP = 'UPDATE' AND OLD.status = 'final') THEN
    RETURN NEW;
  END IF;

  SELECT string_agg(t.station, ', ' ORDER BY t.seq), count(*) INTO v_pending, v_count
    FROM specialty.hc_station_tasks t
   WHERE t.episode_id = NEW.episode_id
     AND t.status NOT IN ('done', 'skipped', 'not_applicable');

  IF v_count > 0 THEN
    RAISE EXCEPTION '% station(s) on this check are still outstanding: % (OP-014 §B.2.2). Finish them, or mark each one skipped with a reason that goes on the report — a "normal" report over a scan nobody did reads as reassurance and is filed.',
      v_count, v_pending
      USING ERRCODE = 'OP014';
  END IF;

  IF NEW.signed_by IS NULL OR NEW.signed_at IS NULL THEN
    RAISE EXCEPTION 'A final health check report names the physician who signed it (OP-014 §B.2.2).'
      USING ERRCODE = 'OP014';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "a_report_covers_every_station"
  BEFORE INSERT OR UPDATE ON "specialty"."hc_reports"
  FOR EACH ROW EXECUTE FUNCTION specialty.a_report_covers_every_station();

-- ── §B.2.3  The health score is derived from the domain scores ─────────────
--
-- The number on the front of the report, which the patient reads and the
-- corporate client is invoiced against. A typed one is a number nobody can
-- reproduce from the results underneath it.
CREATE OR REPLACE FUNCTION specialty.derive_health_score()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
DECLARE
  v_model jsonb;
  v_domain jsonb;
  v_total numeric := 0;
  v_weights numeric := 0;
  v_score numeric;
  v_weight numeric;
BEGIN
  IF NEW.domain_scores IS NULL OR NEW.domain_scores = '{}'::jsonb THEN
    NEW.health_score := NULL;
    RETURN NEW;
  END IF;

  -- The weights come from the model the package names; without one every domain
  -- weighs the same, which is a defensible default and an explicit one.
  SELECT m.domains INTO v_model
    FROM specialty.hc_health_score_models m
    JOIN specialty.hc_packages p ON p.health_score_model_id = m.id
    JOIN specialty.hc_episodes e ON e.id = NEW.episode_id
    JOIN specialty.hc_bookings b ON b.id = e.booking_id AND b.package_id = p.id
   WHERE m.is_active
   LIMIT 1;

  IF v_model IS NULL THEN
    SELECT round(avg((value#>>'{}')::numeric), 2) INTO v_score
      FROM jsonb_each(NEW.domain_scores);
    NEW.health_score := v_score;
    RETURN NEW;
  END IF;

  FOR v_domain IN SELECT * FROM jsonb_array_elements(v_model) LOOP
    v_score := nullif(NEW.domain_scores->>(v_domain->>'name'), '')::numeric;
    v_weight := coalesce((v_domain->>'weight')::numeric, 1);
    IF v_score IS NOT NULL THEN
      v_total := v_total + v_score * v_weight;
      v_weights := v_weights + v_weight;
    END IF;
  END LOOP;

  NEW.health_score := CASE WHEN v_weights = 0 THEN NULL ELSE round(v_total / v_weights, 2) END;
  RETURN NEW;
END $$;

CREATE TRIGGER "health_score_is_derived_never_typed"
  BEFORE INSERT OR UPDATE OF domain_scores, health_score ON "specialty"."hc_reports"
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_health_score();

ALTER TABLE "specialty"."hc_packages"
  ADD CONSTRAINT "a_package_has_a_sequence"
  CHECK (jsonb_typeof("station_sequence") = 'array'
     AND jsonb_array_length("station_sequence") > 0);

ALTER TABLE "specialty"."hc_packages"
  ADD CONSTRAINT "a_package_age_range_runs_forwards"
  CHECK ("age_min" IS NULL OR "age_max" IS NULL OR "age_min" <= "age_max");

ALTER TABLE "specialty"."hc_bookings"
  ADD CONSTRAINT "a_cancelled_booking_says_why"
  CHECK ("status" <> 'cancelled'
     OR ("cancel_reason" IS NOT NULL AND length(btrim("cancel_reason")) >= 4));


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
            AND (c.relname LIKE 'hc\_%' OR c.relname LIKE 'cold\_chain\_%'
                 OR c.relname IN ('vaccination_records','open_vials','aefi_reports',
                                  'immunisation_plan_doses')))
        OR (n.nspname = 'mdm' AND c.relname IN ('vaccines','immunisation_schedules')))
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % programme table(s)', v_count;
END $$;

-- A dose given is a dose given. It is voided with a reason (§B.1.2), never
-- removed: a child's record has to show that somebody once thought it had been
-- administered, and a school or an outbreak investigation will ask.
REVOKE DELETE ON "specialty"."vaccination_records" FROM hms_app;

-- The rest of the evidence chain. A discarded vial, a breach and an adverse
-- event are all things a programme audit reads.
REVOKE DELETE ON "specialty"."open_vials"          FROM hms_app;
REVOKE DELETE ON "specialty"."cold_chain_breaches" FROM hms_app;
REVOKE DELETE ON "specialty"."aefi_reports"        FROM hms_app;
REVOKE DELETE ON "specialty"."hc_reports"          FROM hms_app;

-- The number the vial has actually yielded is the database's (§B.1.2), counted
-- from the administrations, so "doses used" and the doses that used them can
-- never disagree.
--
-- A column-level REVOKE does **not** carve an exception out of a table-level
-- GRANT — Postgres treats the table grant as covering every column, and the
-- narrower revoke is silently a no-op. So the table grant goes and the columns
-- come back one by one. The only legitimate later write to a vial is
-- discarding it; everything else about it was decided at the puncture.
REVOKE UPDATE ON "specialty"."open_vials" FROM hms_app;
GRANT UPDATE (discarded_at, discard_reason, wastage_doses, updated_at)
  ON "specialty"."open_vials" TO hms_app;

-- The schedules and the vaccine master are the programme's, not a clinic's.
-- Revising them is EN-027 master-data administration, not a session in the
-- immunisation room.
REVOKE INSERT, UPDATE, DELETE ON "mdm"."immunisation_schedules" FROM hms_app;
GRANT SELECT ON "mdm"."immunisation_schedules" TO hms_app, hms_readonly;


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

/* `mdm.immunisation_schedules` is exempt for the same reason the opioid
   conversion factors are: it is the published national programme, identical in
   every tenant, and a hospital that could not read it could not compute a due
   date or refuse an early dose. */

DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'specialty'
    AND (c.relname LIKE 'hc\_%' OR c.relname LIKE 'cold\_chain\_%'
         OR c.relname IN ('vaccination_records','open_vials','aefi_reports','immunisation_plan_doses'))
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Programme tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;
