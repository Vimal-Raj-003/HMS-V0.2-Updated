-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 7B · IP-003 + IP-004 + IP-014 + IP-012 + EN-029 + EN-039
-- The nursing station: assignments, assessments, the MAR, escalation
-- ═════════════════════════════════════════════════════════════════════════════
--
-- §A  Tables (generated)
-- §B  The rules, as database shapes
-- §C  Grants
-- §D  Row-level security
--
-- ── §B, in one page ─────────────────────────────────────────────────────────
--
--   B.1  A dose marked given carries both scans and a name. Not a checkbox
--        saying somebody scanned — the payloads the scanner actually read.
--   B.2  A high-alert drug carries a second nurse, and it is not the first one.
--        Insulin, heparin, concentrated electrolytes, chemotherapy and opioids
--        kill people at the wrong dose; the witness is the control that catches
--        it, and a witness who is the administering nurse is no control at all.
--   B.3  A dose cannot be released against an unverified order. The
--        pharmacist's check stands between what the doctor wrote and what the
--        ward may give.
--   B.4  Missed, refused and held doses carry a coded reason. Free text makes
--        "patient asleep" and "drug not on the ward" uncountable, and they are
--        different problems with different owners.
--   B.5  An escalation names the rung it is on and when that rung is due. The
--        worker reads the column; nothing depends on a browser being open.
--   B.6  A risk assessment's band is checked against its score. A Braden of 12
--        recorded as "low risk" is a pressure sore in five days.
--
-- `phase-07`: "No feature flag, no configuration value and no emergency mode
-- may bypass the 5 Rights scan or the second-nurse witness." There is no column
-- in this migration that could express such a bypass — which is the strongest
-- form of that promise a schema can make.
--
-- Custom SQLSTATE: IP003.

-- CreateEnum
CREATE TYPE "clinical"."MarDoseState" AS ENUM ('due', 'given', 'missed', 'refused', 'held', 'cancelled', 'not_required');

-- CreateEnum
CREATE TYPE "clinical"."EscalationRung" AS ENUM ('nurse', 'senior_nurse', 'rmo', 'consultant', 'rapid_response', 'code_blue');

-- CreateEnum
CREATE TYPE "clinical"."RiskScale" AS ENUM ('morse_falls', 'braden_pressure', 'pain', 'restraint', 'nutrition', 'dvt');

-- CreateTable
CREATE TABLE "clinical"."ip_nurse_assignments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "nurse_id" UUID NOT NULL,
    "shift" VARCHAR(20) NOT NULL,
    "shift_date" DATE NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "role" VARCHAR(20) NOT NULL DEFAULT 'bedside',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_nurse_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_nurse_patient_assignments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "assignment_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_nurse_patient_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_risk_assessments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "scale" "clinical"."RiskScale" NOT NULL,
    "items" JSONB NOT NULL,
    "score" INTEGER NOT NULL,
    "band" VARCHAR(20) NOT NULL,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assessed_by" UUID NOT NULL,
    "reassess_due_at" TIMESTAMPTZ(6),
    "interventions" TEXT[],
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_risk_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_news2_escalations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "vitals_id" UUID,
    "patient_id" UUID NOT NULL,
    "ward_id" UUID,
    "score" INTEGER NOT NULL,
    "band" VARCHAR(20) NOT NULL,
    "rung" "clinical"."EscalationRung" NOT NULL DEFAULT 'nurse',
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "outcome" TEXT,
    "ladder" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_news2_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_mar_orders" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "prescription_item_id" UUID,
    "drug_id" UUID,
    "drug_name" VARCHAR(200) NOT NULL,
    "drug_barcode" VARCHAR(120),
    "dose" VARCHAR(80) NOT NULL,
    "dose_unit" VARCHAR(20) NOT NULL,
    "route" VARCHAR(40) NOT NULL,
    "frequency" VARCHAR(40) NOT NULL,
    "is_high_alert" BOOLEAN NOT NULL DEFAULT false,
    "is_narcotic" BOOLEAN NOT NULL DEFAULT false,
    "is_prn" BOOLEAN NOT NULL DEFAULT false,
    "prn_indication" TEXT,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "verified_by" UUID,
    "verification_note" TEXT,
    "discontinued_at" TIMESTAMPTZ(6),
    "discontinued_by" UUID,
    "discontinue_reason" TEXT,
    "ordered_by" UUID NOT NULL,
    "ordered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_mar_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_mar_doses" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "state" "clinical"."MarDoseState" NOT NULL DEFAULT 'due',
    "patient_scan" VARCHAR(200),
    "drug_scan" VARCHAR(200),
    "administered_at" TIMESTAMPTZ(6),
    "administered_by" UUID,
    "witnessed_by" UUID,
    "witnessed_at" TIMESTAMPTZ(6),
    "given_dose" VARCHAR(80),
    "site" VARCHAR(80),
    "reason_code" VARCHAR(40),
    "reason_note" TEXT,
    "prn_indication" TEXT,
    "prn_effect" TEXT,
    "prn_effect_at" TIMESTAMPTZ(6),
    "narcotic_balance_after" DECIMAL(12,3),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_mar_doses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_fluid_entries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "direction" VARCHAR(10) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "volume_ml" INTEGER NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_fluid_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_nursing_notes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'progress',
    "situation" TEXT,
    "background" TEXT,
    "assessment" TEXT,
    "recommendation" TEXT,
    "body" TEXT,
    "photo_ref" VARCHAR(200),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ip_nursing_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_shift_handovers" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "from_shift" VARCHAR(20) NOT NULL,
    "to_shift" VARCHAR(20) NOT NULL,
    "shift_date" DATE NOT NULL,
    "composed" JSONB NOT NULL,
    "additions" TEXT,
    "handed_over_by" UUID,
    "handed_over_at" TIMESTAMPTZ(6),
    "received_by" UUID,
    "received_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_shift_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_device_days" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "ward_id" UUID,
    "device_type" VARCHAR(40) NOT NULL,
    "site" VARCHAR(80),
    "inserted_at" TIMESTAMPTZ(6) NOT NULL,
    "inserted_by" UUID,
    "removed_at" TIMESTAMPTZ(6),
    "removed_by" UUID,
    "removal_reason" VARCHAR(60),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_device_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_hai_cases" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "detected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "detected_by" UUID,
    "trigger" JSONB,
    "adjudication" VARCHAR(20) NOT NULL DEFAULT 'candidate',
    "adjudicated_at" TIMESTAMPTZ(6),
    "adjudicated_by" UUID,
    "rationale" TEXT,
    "organism" VARCHAR(120),
    "device_day_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_hai_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_isolation_orders" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "precaution" VARCHAR(20) NOT NULL,
    "organism" VARCHAR(120),
    "indication" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_by" UUID NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "ended_by" UUID,
    "end_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_isolation_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ip_nurse_assignments_hospital_id_branch_id_ward_id_shift_da_idx" ON "clinical"."ip_nurse_assignments"("hospital_id", "branch_id", "ward_id", "shift_date");

-- CreateIndex
CREATE UNIQUE INDEX "uq_nurse_shift" ON "clinical"."ip_nurse_assignments"("hospital_id", "ward_id", "nurse_id", "shift_date", "shift");

-- CreateIndex
CREATE INDEX "ip_nurse_patient_assignments_hospital_id_admission_id_idx" ON "clinical"."ip_nurse_patient_assignments"("hospital_id", "admission_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_nurse_patient" ON "clinical"."ip_nurse_patient_assignments"("assignment_id", "admission_id");

-- CreateIndex
CREATE INDEX "ip_risk_assessments_hospital_id_admission_id_scale_assessed_idx" ON "clinical"."ip_risk_assessments"("hospital_id", "admission_id", "scale", "assessed_at" DESC);

-- CreateIndex
CREATE INDEX "ip_risk_assessments_hospital_id_reassess_due_at_idx" ON "clinical"."ip_risk_assessments"("hospital_id", "reassess_due_at");

-- CreateIndex
CREATE INDEX "ip_news2_escalations_hospital_id_branch_id_resolved_at_due__idx" ON "clinical"."ip_news2_escalations"("hospital_id", "branch_id", "resolved_at", "due_at");

-- CreateIndex
CREATE INDEX "ip_news2_escalations_hospital_id_admission_id_raised_at_idx" ON "clinical"."ip_news2_escalations"("hospital_id", "admission_id", "raised_at" DESC);

-- CreateIndex
CREATE INDEX "ip_mar_orders_hospital_id_branch_id_admission_id_starts_at_idx" ON "clinical"."ip_mar_orders"("hospital_id", "branch_id", "admission_id", "starts_at");

-- CreateIndex
CREATE INDEX "ip_mar_orders_hospital_id_verified_at_idx" ON "clinical"."ip_mar_orders"("hospital_id", "verified_at");

-- CreateIndex
CREATE INDEX "ip_mar_doses_hospital_id_branch_id_admission_id_due_at_idx" ON "clinical"."ip_mar_doses"("hospital_id", "branch_id", "admission_id", "due_at");

-- CreateIndex
CREATE INDEX "ip_mar_doses_hospital_id_state_due_at_idx" ON "clinical"."ip_mar_doses"("hospital_id", "state", "due_at");

-- CreateIndex
CREATE INDEX "ip_mar_doses_hospital_id_order_id_due_at_idx" ON "clinical"."ip_mar_doses"("hospital_id", "order_id", "due_at");

-- CreateIndex
CREATE INDEX "ip_fluid_entries_hospital_id_branch_id_admission_id_at_idx" ON "clinical"."ip_fluid_entries"("hospital_id", "branch_id", "admission_id", "at" DESC);

-- CreateIndex
CREATE INDEX "ip_nursing_notes_hospital_id_branch_id_admission_id_at_idx" ON "clinical"."ip_nursing_notes"("hospital_id", "branch_id", "admission_id", "at" DESC);

-- CreateIndex
CREATE INDEX "ip_shift_handovers_hospital_id_branch_id_ward_id_shift_date_idx" ON "clinical"."ip_shift_handovers"("hospital_id", "branch_id", "ward_id", "shift_date" DESC);

-- CreateIndex
CREATE INDEX "ip_device_days_hospital_id_branch_id_device_type_inserted_a_idx" ON "clinical"."ip_device_days"("hospital_id", "branch_id", "device_type", "inserted_at");

-- CreateIndex
CREATE INDEX "ip_device_days_hospital_id_admission_id_removed_at_idx" ON "clinical"."ip_device_days"("hospital_id", "admission_id", "removed_at");

-- CreateIndex
CREATE INDEX "ip_hai_cases_hospital_id_branch_id_kind_detected_at_idx" ON "clinical"."ip_hai_cases"("hospital_id", "branch_id", "kind", "detected_at" DESC);

-- CreateIndex
CREATE INDEX "ip_hai_cases_hospital_id_adjudication_idx" ON "clinical"."ip_hai_cases"("hospital_id", "adjudication");

-- CreateIndex
CREATE INDEX "ip_isolation_orders_hospital_id_branch_id_ended_at_idx" ON "clinical"."ip_isolation_orders"("hospital_id", "branch_id", "ended_at");

-- CreateIndex
CREATE INDEX "ip_isolation_orders_hospital_id_admission_id_idx" ON "clinical"."ip_isolation_orders"("hospital_id", "admission_id");

-- AddForeignKey
ALTER TABLE "clinical"."ip_nurse_patient_assignments" ADD CONSTRAINT "ip_nurse_patient_assignments_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "clinical"."ip_nurse_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_mar_doses" ADD CONSTRAINT "ip_mar_doses_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "clinical"."ip_mar_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  The five rights, as recorded evidence ─────────────────────────────
--
-- A dose marked `given` carries the wristband payload, the drug payload, a
-- time and a nurse. The payloads matter rather than a boolean: "scanned = true"
-- is a field somebody can set from a form, and a payload can be compared
-- against the wristband on the patient's arm and the box in the nurse's hand.
--
-- The service does that comparison and refuses a mismatch. This constraint is
-- the floor beneath it — a row that reached the table by any other path still
-- cannot claim an administration nobody scanned for.
ALTER TABLE "clinical"."ip_mar_doses"
  ADD CONSTRAINT "given_dose_carries_both_scans"
  CHECK (
    "state" <> 'given'
    OR ("patient_scan" IS NOT NULL AND length(btrim("patient_scan")) > 0
        AND "drug_scan" IS NOT NULL AND length(btrim("drug_scan")) > 0
        AND "administered_at" IS NOT NULL
        AND "administered_by" IS NOT NULL)
  );

-- ── §B.2  The second nurse, who is a different nurse ────────────────────────
CREATE OR REPLACE FUNCTION clinical.assert_high_alert_is_witnessed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_order record;
BEGIN
  IF NEW.state <> 'given' THEN RETURN NEW; END IF;

  SELECT drug_name, is_high_alert, is_narcotic
    INTO v_order
    FROM clinical.ip_mar_orders WHERE id = NEW.order_id;

  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NOT (v_order.is_high_alert OR v_order.is_narcotic) THEN RETURN NEW; END IF;

  IF NEW.witnessed_by IS NULL THEN
    RAISE EXCEPTION '% is a high-alert drug and needs a second nurse to witness the dose (IP-003 §B.2). Insulin, heparin, concentrated electrolytes, chemotherapy and opioids kill people at the wrong dose, and there is no override for this.',
      v_order.drug_name USING ERRCODE = 'IP003';
  END IF;

  IF NEW.witnessed_by = NEW.administered_by THEN
    RAISE EXCEPTION 'The witness on % cannot be the nurse giving it (IP-003 §B.2). A second check by the same person is not a second check.',
      v_order.drug_name USING ERRCODE = 'IP003';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "high_alert_dose_is_witnessed"
  BEFORE INSERT OR UPDATE ON "clinical"."ip_mar_doses"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_high_alert_is_witnessed();

ALTER TABLE "clinical"."ip_mar_doses"
  ADD CONSTRAINT "witness_is_dated"
  CHECK ("witnessed_by" IS NULL OR "witnessed_at" IS NOT NULL);


-- ── §B.3  Nothing is given on an unverified order ───────────────────────────
--
-- The pharmacist's verification stands between what the doctor wrote and what
-- the ward may give. A MAR line that can be administered before it is a dose
-- given on an order nobody checked for interactions, allergies or a decimal
-- point in the wrong place.
CREATE OR REPLACE FUNCTION clinical.assert_order_is_verified()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_order record;
BEGIN
  IF NEW.state <> 'given' THEN RETURN NEW; END IF;

  SELECT drug_name, verified_at, discontinued_at
    INTO v_order FROM clinical.ip_mar_orders WHERE id = NEW.order_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_order.verified_at IS NULL THEN
    RAISE EXCEPTION 'The order for % has not been verified by a pharmacist (IP-003 §B.3). The verification is what stands between what the doctor wrote and what the ward may give.',
      v_order.drug_name USING ERRCODE = 'IP003';
  END IF;

  IF v_order.discontinued_at IS NOT NULL AND NEW.administered_at > v_order.discontinued_at THEN
    RAISE EXCEPTION '% was discontinued at %. A dose given after that is a dose nobody intended.',
      v_order.drug_name, v_order.discontinued_at USING ERRCODE = 'IP003';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "dose_is_given_on_a_verified_order"
  BEFORE INSERT OR UPDATE ON "clinical"."ip_mar_doses"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_order_is_verified();

ALTER TABLE "clinical"."ip_mar_orders"
  ADD CONSTRAINT "verification_is_owned"
  CHECK (("verified_at" IS NULL) = ("verified_by" IS NULL));

ALTER TABLE "clinical"."ip_mar_orders"
  ADD CONSTRAINT "discontinuation_says_why"
  CHECK ("discontinued_at" IS NULL
         OR ("discontinue_reason" IS NOT NULL AND length(btrim("discontinue_reason")) >= 4));


-- ── §B.4  A coded reason, not a sentence ────────────────────────────────────
--
-- "Patient asleep" and "drug not on the ward" are different problems with
-- different owners. A free-text box makes them uncountable, and a ward that
-- cannot count its missed doses cannot fix them.
ALTER TABLE "clinical"."ip_mar_doses"
  ADD CONSTRAINT "unmade_dose_carries_a_code"
  CHECK ("state" NOT IN ('missed', 'refused', 'held') OR "reason_code" IS NOT NULL);

ALTER TABLE "clinical"."ip_mar_doses"
  ADD CONSTRAINT "mar_reason_code_is_known"
  CHECK ("reason_code" IS NULL OR "reason_code" IN (
    'patient_asleep', 'patient_refused', 'patient_absent', 'patient_nbm',
    'drug_unavailable', 'iv_access_lost', 'held_for_procedure', 'held_for_level',
    'held_clinical', 'vomited', 'allergy_suspected', 'duplicate', 'order_changed',
    'not_required', 'other'
  ));

-- A PRN dose records why it was given. A PRN with no indication is a routine
-- dose somebody has relabelled, and nobody can review whether it worked.
--
-- A trigger rather than a CHECK, because whether the drug is when-required is a
-- property of the *order*, and a CHECK cannot see another table.
CREATE OR REPLACE FUNCTION clinical.assert_prn_has_an_indication()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_prn boolean; v_name text;
BEGIN
  IF NEW.state <> 'given' THEN RETURN NEW; END IF;
  SELECT is_prn, drug_name INTO v_prn, v_name FROM clinical.ip_mar_orders WHERE id = NEW.order_id;
  IF NOT FOUND OR NOT v_prn THEN RETURN NEW; END IF;

  IF NEW.prn_indication IS NULL OR length(btrim(NEW.prn_indication)) < 3 THEN
    RAISE EXCEPTION '% is a when-required drug and this dose records no indication (IP-003 §B.4). A PRN with no reason is a routine dose somebody has relabelled, and nobody can review whether it worked.',
      v_name USING ERRCODE = 'IP003';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "prn_dose_states_why"
  BEFORE INSERT OR UPDATE ON "clinical"."ip_mar_doses"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_prn_has_an_indication();


-- ── §B.5  The escalation carries its own clock ──────────────────────────────
ALTER TABLE "clinical"."ip_news2_escalations"
  ADD CONSTRAINT "escalation_due_after_raised" CHECK ("due_at" > "raised_at");

ALTER TABLE "clinical"."ip_news2_escalations"
  ADD CONSTRAINT "acknowledgement_is_owned"
  CHECK (("acknowledged_at" IS NULL) = ("acknowledged_by" IS NULL));

-- Closing an escalation says what was done about the patient. "Resolved" with
-- no outcome is a tick somebody applied to clear a list.
ALTER TABLE "clinical"."ip_news2_escalations"
  ADD CONSTRAINT "resolved_escalation_says_what_happened"
  CHECK ("resolved_at" IS NULL
         OR ("resolved_by" IS NOT NULL AND "outcome" IS NOT NULL AND length(btrim("outcome")) >= 4));

ALTER TABLE "clinical"."ip_news2_escalations"
  ADD CONSTRAINT "news2_score_in_range" CHECK ("score" BETWEEN 0 AND 20);

-- One live escalation per admission. A second one raised while the first is
-- unresolved splits the ladder in two and both climb slowly.
CREATE UNIQUE INDEX "uq_one_live_escalation_per_admission"
  ON "clinical"."ip_news2_escalations" ("admission_id")
  WHERE "resolved_at" IS NULL;


-- ── §B.6  A band that matches its score ─────────────────────────────────────
--
-- Checked per scale, because the bands are the scales' own. A Braden of 12
-- filed as "low risk" is a pressure sore in five days, and it happens when the
-- band is a dropdown beside the score rather than a function of it.
CREATE OR REPLACE FUNCTION clinical.assert_risk_band_matches()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_expected text;
BEGIN
  v_expected := CASE NEW.scale
    -- Morse: 0–24 low, 25–44 moderate, 45+ high.
    WHEN 'morse_falls'    THEN CASE WHEN NEW.score >= 45 THEN 'high'
                                    WHEN NEW.score >= 25 THEN 'moderate'
                                    ELSE 'low' END
    -- Braden runs the other way: lower is worse. ≤9 very high, 10–12 high,
    -- 13–14 moderate, 15–18 low, 19–23 none.
    WHEN 'braden_pressure' THEN CASE WHEN NEW.score <= 9  THEN 'very_high'
                                     WHEN NEW.score <= 12 THEN 'high'
                                     WHEN NEW.score <= 14 THEN 'moderate'
                                     ELSE 'low' END
    ELSE NULL
  END;

  IF v_expected IS NOT NULL AND NEW.band <> v_expected THEN
    RAISE EXCEPTION 'A % score of % is "%", not "%" (IP-003 §B.6). The band is a function of the score — %.',
      replace(NEW.scale::text, '_', ' '), NEW.score, v_expected, NEW.band,
      CASE NEW.scale
        WHEN 'braden_pressure' THEN 'a Braden of 12 filed as low risk is a pressure sore in five days'
        WHEN 'morse_falls'     THEN 'a Morse of 50 filed as moderate is a patient who falls without bed rails'
        ELSE 'filing it under the wrong band hides the patient from the list that would have caught it'
      END
      USING ERRCODE = 'IP003';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "risk_band_follows_the_score"
  BEFORE INSERT OR UPDATE ON "clinical"."ip_risk_assessments"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_risk_band_matches();

-- A high risk with no interventions is an assessment nobody acted on.
ALTER TABLE "clinical"."ip_risk_assessments"
  ADD CONSTRAINT "high_risk_has_interventions"
  CHECK ("band" NOT IN ('high', 'very_high') OR cardinality("interventions") > 0);


-- ── Housekeeping on the rest ────────────────────────────────────────────────
ALTER TABLE "clinical"."ip_fluid_entries"
  ADD CONSTRAINT "fluid_direction_is_known" CHECK ("direction" IN ('intake', 'output'));

ALTER TABLE "clinical"."ip_fluid_entries"
  ADD CONSTRAINT "fluid_volume_is_positive" CHECK ("volume_ml" > 0 AND "volume_ml" <= 20000);

ALTER TABLE "clinical"."ip_device_days"
  ADD CONSTRAINT "device_removed_after_inserted"
  CHECK ("removed_at" IS NULL OR "removed_at" >= "inserted_at");

-- One live device of a kind per patient at a time. Two central lines recorded
-- when there is one doubles the denominator and halves the reported CLABSI rate.
CREATE UNIQUE INDEX "uq_one_live_device_per_admission"
  ON "clinical"."ip_device_days" ("admission_id", "device_type")
  WHERE "removed_at" IS NULL;

ALTER TABLE "clinical"."ip_hai_cases"
  ADD CONSTRAINT "adjudicated_hai_is_owned"
  CHECK ("adjudication" = 'candidate'
         OR ("adjudicated_at" IS NOT NULL AND "adjudicated_by" IS NOT NULL
             AND "rationale" IS NOT NULL AND length(btrim("rationale")) >= 4));

ALTER TABLE "clinical"."ip_isolation_orders"
  ADD CONSTRAINT "isolation_ends_after_it_starts"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

-- One live isolation order per admission per precaution.
CREATE UNIQUE INDEX "uq_one_live_isolation"
  ON "clinical"."ip_isolation_orders" ("admission_id", "precaution")
  WHERE "ended_at" IS NULL;

ALTER TABLE "clinical"."ip_shift_handovers"
  ADD CONSTRAINT "handover_received_after_given"
  CHECK ("received_at" IS NULL OR ("handed_over_at" IS NOT NULL AND "received_at" >= "handed_over_at"));

-- A handover is two signatures, and they are two people.
ALTER TABLE "clinical"."ip_shift_handovers"
  ADD CONSTRAINT "handover_is_between_two_nurses"
  CHECK ("received_by" IS NULL OR "handed_over_by" IS NULL OR "received_by" <> "handed_over_by");

COMMENT ON CONSTRAINT "given_dose_carries_both_scans" ON "clinical"."ip_mar_doses" IS
  'The payloads the scanner read, not a boolean saying somebody scanned. A boolean is a field a form can set; a payload can be compared against the wristband on the arm and the box in the hand.';

COMMENT ON TABLE "clinical"."ip_news2_escalations" IS
  'Escalation carries its own due time and its own rung, and the worker walks overdue rows. Nothing here depends on a browser being open, because the nurse who recorded the deteriorating observation is the one most likely to be busy with the patient.';


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
  WHERE n.nspname = 'clinical' AND c.relname LIKE 'ip\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 7B tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;



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
      AND c.relname LIKE 'ip\_%'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % Phase 7B table(s)', v_count;
END $$;

-- A dose given, a note written and a fluid recorded are records of something
-- that happened at the bedside. Correcting one is a new row that says so, not
-- an edit that makes the first one never have existed.
REVOKE DELETE ON "clinical"."ip_mar_doses"       FROM hms_app;
REVOKE DELETE ON "clinical"."ip_nursing_notes"   FROM hms_app;
REVOKE UPDATE, DELETE ON "clinical"."ip_fluid_entries" FROM hms_app;
REVOKE DELETE ON "clinical"."ip_risk_assessments" FROM hms_app;
REVOKE DELETE ON "clinical"."ip_news2_escalations" FROM hms_app;
