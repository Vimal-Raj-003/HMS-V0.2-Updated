-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-010 + OP-039 — the procedure console and the OPD nursing floor
-- The spine most other consoles call into
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── Five rules ──────────────────────────────────────────────────────────────
--
-- 1. A procedure does not start on a promise: consent where consent is
--    required, a time-out where the procedure is invasive, and a checklist
--    either complete or overridden by a named person with a reason. Consent has
--    no override — a signature nobody gave cannot be supplied by seniority.
--
-- 2. A time-out is two different people and five questions. One person
--    confirming is a person agreeing with themselves, which is the failure the
--    ritual exists to catch.
--
-- 3. A sedated patient leaves on a score and an escort. Aldrete 9, and somebody
--    to take them home.
--
-- 4. A room holds one case at a time. Half-open, because a case ending at 14:00
--    and another starting at 14:00 is a turnover.
--
-- 5. A drug given in an OPD room carries the same five rights as one given on a
--    ward: identity verified, batch in date, and a second person on a
--    high-alert drug who is not the person giving it.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: OP010.

-- CreateEnum
CREATE TYPE "clinical"."ProcedureCategory" AS ENUM ('diagnostic', 'therapeutic', 'invasive', 'cosmetic', 'screening');

-- CreateEnum
CREATE TYPE "clinical"."ProcedureRoomType" AS ENUM ('minor_ot', 'procedure_room', 'injection_room', 'dressing', 'plaster', 'endoscopy', 'eye_laser', 'observation_bay', 'nebulisation');

-- CreateEnum
CREATE TYPE "clinical"."ProcedureOrderStatus" AS ENUM ('ordered', 'scheduled', 'checked_in', 'ready', 'in_progress', 'completed', 'abandoned', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "clinical"."ProcedureBookingStatus" AS ENUM ('booked', 'confirmed', 'checked_in', 'done', 'cancelled', 'no_show', 'rescheduled');

-- CreateEnum
CREATE TYPE "clinical"."AnaesthesiaType" AS ENUM ('none', 'local', 'regional', 'sedation', 'general');

-- CreateEnum
CREATE TYPE "clinical"."OpdTaskType" AS ENUM ('injection', 'iv_fluid', 'infusion', 'nebulisation', 'oxygen', 'dressing', 'suture_removal', 'plaster_apply', 'plaster_check', 'plaster_remove', 'catheter', 'ear_syringing', 'ecg', 'cannulation', 'minor_ot_prep', 'observation', 'other');

-- CreateEnum
CREATE TYPE "clinical"."OpdTaskStatus" AS ENUM ('ordered', 'awaiting_payment', 'released', 'queued', 'in_progress', 'observation', 'completed', 'missed', 'cancelled', 'held');

-- CreateEnum
CREATE TYPE "clinical"."AdminRoute" AS ENUM ('im', 'iv_push', 'iv_infusion', 'sc', 'id', 'inhalation', 'topical', 'oral', 'other');

-- CreateEnum
CREATE TYPE "clinical"."IdentityMethod" AS ENUM ('qr', 'wristband', 'two_identifiers');

-- CreateEnum
CREATE TYPE "clinical"."ObservationOutcome" AS ENUM ('uneventful', 'reaction', 'left_early');

-- CreateTable
CREATE TABLE "clinical"."procedure_rooms" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "type" "clinical"."ProcedureRoomType" NOT NULL,
    "sub_store_id" UUID,
    "open_hours" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "procedure_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."procedure_orders" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_no" VARCHAR(60) NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "visit_id" UUID,
    "procedure_code" VARCHAR(40) NOT NULL,
    "procedure_name" VARCHAR(200) NOT NULL,
    "category" "clinical"."ProcedureCategory" NOT NULL,
    "side" "clinical"."Laterality" NOT NULL DEFAULT 'not_applicable',
    "site_text" VARCHAR(200),
    "indication_icd10" VARCHAR(12),
    "urgency" VARCHAR(16) NOT NULL DEFAULT 'routine',
    "requires_consent" BOOLEAN NOT NULL DEFAULT false,
    "consent_id" UUID,
    "sedation_requested" BOOLEAN NOT NULL DEFAULT false,
    "status" "clinical"."ProcedureOrderStatus" NOT NULL DEFAULT 'ordered',
    "cancel_reason" TEXT,
    "source_module" VARCHAR(24),
    "ordered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ordered_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "procedure_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."procedure_bookings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "doctor_id" UUID,
    "anaesthetist_id" UUID,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "clinical"."ProcedureBookingStatus" NOT NULL DEFAULT 'booked',
    "cancel_reason" TEXT,
    "instructions_sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "procedure_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."procedure_checklists" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "template_key" VARCHAR(60) NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "ready_by" UUID,
    "ready_at" TIMESTAMPTZ(6),
    "override_reason" TEXT,
    "override_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "procedure_checklists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."procedure_timeouts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "confirmed_by_1" UUID NOT NULL,
    "confirmed_by_2" UUID NOT NULL,
    "patient_ok" BOOLEAN NOT NULL,
    "procedure_ok" BOOLEAN NOT NULL,
    "side_ok" BOOLEAN NOT NULL,
    "consent_ok" BOOLEAN NOT NULL,
    "allergy_ok" BOOLEAN NOT NULL,
    "confirmed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procedure_timeouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."procedures" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "performed_by" UUID NOT NULL,
    "assistants" UUID[] DEFAULT ARRAY[]::UUID[],
    "anaesthetist_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "anaesthesia" "clinical"."AnaesthesiaType" NOT NULL DEFAULT 'none',
    "sedation_record" JSONB,
    "findings" TEXT,
    "technique" TEXT,
    "ebl_ml" INTEGER,
    "specimens" JSONB,
    "complications" JSONB,
    "outcome" VARCHAR(16),
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "document_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "procedures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."procedure_recovery" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "procedure_id" UUID NOT NULL,
    "observations" JSONB DEFAULT '[]',
    "aldrete_score" INTEGER,
    "escort_name" VARCHAR(160),
    "escort_relationship" VARCHAR(60),
    "discharged_at" TIMESTAMPTZ(6),
    "discharged_by" UUID,
    "instructions" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "procedure_recovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."procedure_consumables" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "procedure_id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "batch_id" UUID,
    "qty" DECIMAL(12,3) NOT NULL,
    "uom" VARCHAR(16) NOT NULL,
    "source" VARCHAR(12) NOT NULL DEFAULT 'manual',
    "chargeable" BOOLEAN NOT NULL DEFAULT true,
    "charge_intent_id" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "procedure_consumables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."opd_nursing_tasks" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "order_id" UUID,
    "type" "clinical"."OpdTaskType" NOT NULL,
    "room_type" "clinical"."ProcedureRoomType" NOT NULL,
    "room_id" UUID,
    "day_no" SMALLINT,
    "day_total" SMALLINT,
    "scheduled_at" TIMESTAMPTZ(6),
    "priority" VARCHAR(12) NOT NULL DEFAULT 'routine',
    "status" "clinical"."OpdTaskStatus" NOT NULL DEFAULT 'ordered',
    "hold_reason" TEXT,
    "assigned_nurse_id" UUID,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opd_nursing_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."opd_med_administrations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "drug_name" VARCHAR(200) NOT NULL,
    "drug_id" UUID,
    "ordered_dose" DECIMAL(12,3) NOT NULL,
    "given_dose" DECIMAL(12,3) NOT NULL,
    "dose_unit" VARCHAR(16) NOT NULL,
    "dose_change_reason" TEXT,
    "route" "clinical"."AdminRoute" NOT NULL,
    "site" VARCHAR(60),
    "batch_no" VARCHAR(60),
    "expiry" DATE,
    "barcode_verified" BOOLEAN NOT NULL DEFAULT false,
    "identity_method" "clinical"."IdentityMethod" NOT NULL,
    "high_alert" BOOLEAN NOT NULL DEFAULT false,
    "verifier_id" UUID,
    "allergy_checked" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "given_by" UUID NOT NULL,
    "observation_until" TIMESTAMPTZ(6),
    "observation_outcome" "clinical"."ObservationOutcome",
    "reaction" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "opd_med_administrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."opd_dressings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "wound_id" UUID,
    "site" VARCHAR(120) NOT NULL,
    "assessment" JSONB NOT NULL DEFAULT '{}',
    "materials" JSONB DEFAULT '[]',
    "sutures_removed" INTEGER,
    "sutures_retained" INTEGER,
    "infection_signs" BOOLEAN NOT NULL DEFAULT false,
    "next_due_at" TIMESTAMPTZ(6),
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,

    CONSTRAINT "opd_dressings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "procedure_rooms_hospital_id_branch_id_type_is_active_idx" ON "clinical"."procedure_rooms"("hospital_id", "branch_id", "type", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "uq_procedure_room_code" ON "clinical"."procedure_rooms"("hospital_id", "code");

-- CreateIndex
CREATE INDEX "procedure_orders_hospital_id_patient_id_ordered_at_idx" ON "clinical"."procedure_orders"("hospital_id", "patient_id", "ordered_at" DESC);

-- CreateIndex
CREATE INDEX "procedure_orders_hospital_id_branch_id_status_ordered_at_idx" ON "clinical"."procedure_orders"("hospital_id", "branch_id", "status", "ordered_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_procedure_order_no" ON "clinical"."procedure_orders"("hospital_id", "order_no");

-- CreateIndex
CREATE INDEX "procedure_bookings_hospital_id_branch_id_start_at_idx" ON "clinical"."procedure_bookings"("hospital_id", "branch_id", "start_at");

-- CreateIndex
CREATE INDEX "procedure_bookings_hospital_id_room_id_start_at_idx" ON "clinical"."procedure_bookings"("hospital_id", "room_id", "start_at");

-- CreateIndex
CREATE INDEX "procedure_checklists_hospital_id_order_id_idx" ON "clinical"."procedure_checklists"("hospital_id", "order_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_checklist_per_order" ON "clinical"."procedure_checklists"("order_id", "template_key");

-- CreateIndex
CREATE INDEX "procedure_timeouts_hospital_id_order_id_idx" ON "clinical"."procedure_timeouts"("hospital_id", "order_id");

-- CreateIndex
CREATE INDEX "procedures_hospital_id_patient_id_started_at_idx" ON "clinical"."procedures"("hospital_id", "patient_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "procedures_hospital_id_branch_id_started_at_idx" ON "clinical"."procedures"("hospital_id", "branch_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "procedure_recovery_procedure_id_key" ON "clinical"."procedure_recovery"("procedure_id");

-- CreateIndex
CREATE INDEX "procedure_recovery_hospital_id_discharged_at_idx" ON "clinical"."procedure_recovery"("hospital_id", "discharged_at");

-- CreateIndex
CREATE INDEX "procedure_consumables_hospital_id_procedure_id_idx" ON "clinical"."procedure_consumables"("hospital_id", "procedure_id");

-- CreateIndex
CREATE INDEX "opd_nursing_tasks_hospital_id_branch_id_room_type_status_sc_idx" ON "clinical"."opd_nursing_tasks"("hospital_id", "branch_id", "room_type", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "opd_nursing_tasks_hospital_id_patient_id_status_idx" ON "clinical"."opd_nursing_tasks"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "opd_med_administrations_hospital_id_patient_id_started_at_idx" ON "clinical"."opd_med_administrations"("hospital_id", "patient_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "opd_med_administrations_hospital_id_task_id_idx" ON "clinical"."opd_med_administrations"("hospital_id", "task_id");

-- CreateIndex
CREATE INDEX "opd_dressings_hospital_id_patient_id_recorded_at_idx" ON "clinical"."opd_dressings"("hospital_id", "patient_id", "recorded_at" DESC);

-- AddForeignKey
ALTER TABLE "clinical"."procedure_bookings" ADD CONSTRAINT "procedure_bookings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "clinical"."procedure_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."procedure_bookings" ADD CONSTRAINT "procedure_bookings_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "clinical"."procedure_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."procedure_checklists" ADD CONSTRAINT "procedure_checklists_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "clinical"."procedure_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."procedure_timeouts" ADD CONSTRAINT "procedure_timeouts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "clinical"."procedure_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."procedures" ADD CONSTRAINT "procedures_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "clinical"."procedure_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."procedure_recovery" ADD CONSTRAINT "procedure_recovery_procedure_id_fkey" FOREIGN KEY ("procedure_id") REFERENCES "clinical"."procedures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."opd_med_administrations" ADD CONSTRAINT "opd_med_administrations_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "clinical"."opd_nursing_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."opd_dressings" ADD CONSTRAINT "opd_dressings_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "clinical"."opd_nursing_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  A room holds one case at a time ───────────────────────────────────
--
-- Half-open on purpose: a case ending at 14:00 and another starting at 14:00 is
-- a turnover, not a clash. A cancelled booking releases the room, which is why
-- the constraint is partial.
ALTER TABLE "clinical"."procedure_bookings"
  ADD CONSTRAINT "booking_ends_after_it_starts" CHECK ("end_at" > "start_at");

ALTER TABLE "clinical"."procedure_bookings"
  ADD CONSTRAINT "one_case_per_room"
  EXCLUDE USING gist (
    "room_id" WITH =,
    tstzrange("start_at", "end_at", '[)') WITH &&
  ) WHERE ("status" IN ('booked', 'confirmed', 'checked_in', 'done'));

ALTER TABLE "clinical"."procedure_bookings"
  ADD CONSTRAINT "cancelled_booking_says_why"
  CHECK ("status" NOT IN ('cancelled', 'rescheduled')
         OR ("cancel_reason" IS NOT NULL AND length(btrim("cancel_reason")) >= 4));


-- ── §B.2  A time-out is two people and five questions ───────────────────────
ALTER TABLE "clinical"."procedure_timeouts"
  ADD CONSTRAINT "timeout_is_two_people"
  CHECK ("confirmed_by_1" <> "confirmed_by_2");

-- A time-out with a box unticked is not a time-out. Recording one means all
-- five were answered yes; a "no" stops the procedure rather than being filed.
ALTER TABLE "clinical"."procedure_timeouts"
  ADD CONSTRAINT "timeout_answers_every_question"
  CHECK ("patient_ok" AND "procedure_ok" AND "side_ok" AND "consent_ok" AND "allergy_ok");


-- ── §B.3  A procedure does not start on a promise ───────────────────────────
--
-- The order of the checks is the order a theatre does them in, and each message
-- says what is missing rather than that something is.
CREATE OR REPLACE FUNCTION clinical.assert_procedure_may_start()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_order record; v_checklist record; v_timeouts int;
BEGIN
  SELECT * INTO v_order FROM clinical.procedure_orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- Consent has no override. A signature nobody gave cannot be supplied by
  -- seniority, by urgency, or by a checkbox.
  IF v_order.requires_consent AND v_order.consent_id IS NULL THEN
    RAISE EXCEPTION 'Consent has not been signed for % (OP-010 §5). This is the one check with no override: a signature nobody gave cannot be supplied by seniority.',
      v_order.procedure_name USING ERRCODE = 'OP010';
  END IF;

  -- An invasive procedure needs the pause. Two people, five questions.
  IF v_order.category = 'invasive' THEN
    SELECT count(*) INTO v_timeouts FROM clinical.procedure_timeouts WHERE order_id = NEW.order_id;
    IF v_timeouts = 0 THEN
      RAISE EXCEPTION 'No time-out has been recorded for % (OP-010 §5). Right patient, right procedure, right side, consent seen, allergies known — confirmed by two people, before anything is cut.',
        v_order.procedure_name USING ERRCODE = 'OP010';
    END IF;
  END IF;

  -- The checklist may be overridden, and the override is signed.
  SELECT * INTO v_checklist FROM clinical.procedure_checklists WHERE order_id = NEW.order_id LIMIT 1;
  IF FOUND AND NOT v_checklist.ready
     AND (v_checklist.override_reason IS NULL OR v_checklist.override_by IS NULL) THEN
    RAISE EXCEPTION 'The pre-procedure checklist for % is not complete (OP-010 §5). It can be overridden, but not silently: record who decided and why.',
      v_order.procedure_name USING ERRCODE = 'OP010';
  END IF;

  -- A procedure on a side names it. "Which knee" is not a detail to be filled
  -- in from memory afterwards.
  IF v_order.category = 'invasive' AND v_order.side = 'not_applicable'
     AND COALESCE(btrim(v_order.site_text), '') = '' THEN
    RAISE EXCEPTION 'Procedure % names neither a side nor a site (OP-010 §5).',
      v_order.procedure_name USING ERRCODE = 'OP010';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "a_procedure_does_not_start_on_a_promise"
  BEFORE INSERT ON "clinical"."procedures"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_procedure_may_start();

-- A note, once signed, is a document. Changing it is a new version.
CREATE OR REPLACE FUNCTION clinical.refuse_editing_a_signed_procedure()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF OLD.signed_at IS NULL THEN RETURN NEW; END IF;

  IF NEW.findings      IS DISTINCT FROM OLD.findings
     OR NEW.technique  IS DISTINCT FROM OLD.technique
     OR NEW.complications IS DISTINCT FROM OLD.complications
     OR NEW.specimens  IS DISTINCT FROM OLD.specimens
     OR NEW.signed_by  IS DISTINCT FROM OLD.signed_by
     OR NEW.signed_at  IS DISTINCT FROM OLD.signed_at THEN
    RAISE EXCEPTION 'This procedure note is signed and cannot be edited (OP-010 §5). Add an addendum — a note that changes after signature is one an insurer and a court cannot rely on.'
      USING ERRCODE = 'OP010';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "signed_procedure_note_is_immutable"
  BEFORE UPDATE ON "clinical"."procedures"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_editing_a_signed_procedure();

ALTER TABLE "clinical"."procedures"
  ADD CONSTRAINT "procedure_ends_after_it_starts"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

ALTER TABLE "clinical"."procedures"
  ADD CONSTRAINT "signed_procedure_is_owned"
  CHECK (("signed_at" IS NULL) = ("signed_by" IS NULL));

-- Sedation and general anaesthesia are somebody's responsibility by name.
ALTER TABLE "clinical"."procedures"
  ADD CONSTRAINT "sedation_names_who_gave_it"
  CHECK ("anaesthesia" NOT IN ('sedation', 'general') OR "anaesthetist_id" IS NOT NULL);


-- ── §B.4  A sedated patient leaves on a score and an escort ─────────────────
CREATE OR REPLACE FUNCTION clinical.assert_recovery_discharge()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_anaesthesia text;
BEGIN
  IF NEW.discharged_at IS NULL THEN RETURN NEW; END IF;

  SELECT anaesthesia::text INTO v_anaesthesia FROM clinical.procedures WHERE id = NEW.procedure_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF NEW.discharged_by IS NULL THEN
    RAISE EXCEPTION 'Discharging from recovery names who decided (OP-010 §5).' USING ERRCODE = 'OP010';
  END IF;

  IF v_anaesthesia IN ('sedation', 'general') THEN
    IF NEW.aldrete_score IS NULL OR NEW.aldrete_score < 9 THEN
      RAISE EXCEPTION 'The Aldrete score is % (OP-010 §5). A patient sedated for a procedure goes home at 9 or above, and the one who does not is the readmission everybody remembers.',
        COALESCE(NEW.aldrete_score::text, 'not recorded') USING ERRCODE = 'OP010';
    END IF;

    IF COALESCE(btrim(NEW.escort_name), '') = '' THEN
      RAISE EXCEPTION 'No escort is recorded (OP-010 §5). A patient discharged from sedation alone may not drive, may not remember the instructions, and has nobody to notice if they deteriorate.'
        USING ERRCODE = 'OP010';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "recovery_discharge_needs_a_score_and_an_escort"
  BEFORE INSERT OR UPDATE ON "clinical"."procedure_recovery"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_recovery_discharge();

ALTER TABLE "clinical"."procedure_recovery"
  ADD CONSTRAINT "aldrete_is_out_of_ten"
  CHECK ("aldrete_score" IS NULL OR "aldrete_score" BETWEEN 0 AND 10);


-- ── §B.5  A drug given in an OPD room has the same five rights ──────────────
--
-- The MAR's rules, in the injection room. The patient is verified, the batch is
-- in date, and a high-alert drug has a second person who is not the giver.
ALTER TABLE "clinical"."opd_med_administrations"
  ADD CONSTRAINT "high_alert_drug_has_a_second_person"
  CHECK (NOT "high_alert" OR ("verifier_id" IS NOT NULL AND "verifier_id" <> "given_by"));

ALTER TABLE "clinical"."opd_med_administrations"
  ADD CONSTRAINT "a_changed_dose_says_why"
  CHECK ("given_dose" = "ordered_dose"
         OR ("dose_change_reason" IS NOT NULL AND length(btrim("dose_change_reason")) >= 4));

ALTER TABLE "clinical"."opd_med_administrations"
  ADD CONSTRAINT "doses_are_positive"
  CHECK ("ordered_dose" > 0 AND "given_dose" > 0);

ALTER TABLE "clinical"."opd_med_administrations"
  ADD CONSTRAINT "administration_ends_after_it_starts"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

CREATE OR REPLACE FUNCTION clinical.assert_opd_administration()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  -- An expired batch is a hard stop with no override anywhere in the product.
  IF NEW.expiry IS NOT NULL AND NEW.expiry < current_date THEN
    RAISE EXCEPTION '% batch % expired on % (OP-039 §5). An expired drug is not given, and there is no override for this.',
      NEW.drug_name, COALESCE(NEW.batch_no, 'unnumbered'), NEW.expiry USING ERRCODE = 'OP010';
  END IF;

  IF NOT NEW.allergy_checked THEN
    RAISE EXCEPTION 'The allergy list has not been checked before giving % (OP-039 §5).',
      NEW.drug_name USING ERRCODE = 'OP010';
  END IF;

  -- A batch typed rather than scanned is a batch nobody can find in a recall.
  -- Manual entry is allowed — a label may be unreadable — and it is recorded.
  IF NOT NEW.barcode_verified AND NEW.batch_no IS NOT NULL
     AND COALESCE(btrim(NEW.dose_change_reason), '') = ''
     AND NEW.high_alert THEN
    RAISE EXCEPTION 'A high-alert drug''s batch is scanned, not typed (OP-039 §5). % is on the high-alert list.',
      NEW.drug_name USING ERRCODE = 'OP010';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "an_opd_dose_carries_the_five_rights"
  BEFORE INSERT OR UPDATE ON "clinical"."opd_med_administrations"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_opd_administration();

-- A course of injections knows where it is: day 3 of 5, never day 7 of 5.
ALTER TABLE "clinical"."opd_nursing_tasks"
  ADD CONSTRAINT "course_day_is_within_the_course"
  CHECK ("day_no" IS NULL OR "day_total" IS NULL OR ("day_no" >= 1 AND "day_no" <= "day_total"));

ALTER TABLE "clinical"."opd_nursing_tasks"
  ADD CONSTRAINT "held_task_says_why"
  CHECK ("status" NOT IN ('held', 'cancelled', 'missed')
         OR ("hold_reason" IS NOT NULL AND length(btrim("hold_reason")) >= 4));

-- Sutures out plus sutures left in cannot exceed what a wound could hold, and
-- neither is negative. A retained suture found six weeks later is a wound that
-- was never going to heal.
ALTER TABLE "clinical"."opd_dressings"
  ADD CONSTRAINT "suture_counts_are_counts"
  CHECK (("sutures_removed" IS NULL OR "sutures_removed" >= 0)
     AND ("sutures_retained" IS NULL OR "sutures_retained" >= 0));

COMMENT ON CONSTRAINT "one_case_per_room" ON "clinical"."procedure_bookings" IS
  'Half-open on purpose: a case ending at 14:00 and another starting at 14:00 is a turnover, not a clash.';

COMMENT ON TABLE "clinical"."procedure_timeouts" IS
  'The pause before the knife: right patient, right procedure, right side, consent seen, allergies known — confirmed by two different people. One person confirming is a person agreeing with themselves.';


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
      AND (c.relname LIKE 'procedure%' OR c.relname LIKE 'opd\_%')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % OP-010/OP-039 table(s)', v_count;
END $$;

-- A procedure that happened, a drug that was given and a dressing that was
-- changed are facts about a patient. None is deleted; an order is cancelled
-- with a reason and a note is amended.
REVOKE DELETE ON "clinical"."procedures"                FROM hms_app;
REVOKE DELETE ON "clinical"."procedure_timeouts"        FROM hms_app;
REVOKE DELETE ON "clinical"."procedure_orders"          FROM hms_app;
REVOKE DELETE ON "clinical"."opd_med_administrations"   FROM hms_app;
REVOKE DELETE ON "clinical"."opd_dressings"             FROM hms_app;


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
  WHERE n.nspname = 'clinical' AND (c.relname LIKE 'procedure%' OR c.relname LIKE 'opd\_%')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'OP-010/OP-039 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;
