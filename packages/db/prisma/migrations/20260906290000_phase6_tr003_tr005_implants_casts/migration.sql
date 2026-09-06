-- ═════════════════════════════════════════════════════════════════════════════
-- TR-003 + TR-005 — implant traceability, and everything strapped to a limb
--
-- `phase-06` §6.8–6.9, exit gate 8. Nine tables in `clinical`.
--
-- ── The recall is what this module is for ───────────────────────────────────
--
-- Given a UDI or a lot number, return the exact list of patients carrying that
-- device — by name, with the surgeon and the date. `phase-06` calls it "the
-- single most important test in this deliverable", and a hip-stem recall with
-- an incomplete list is people still walking on a withdrawn device.
--
-- Every constraint below serves that query:
--
--   §B.1  An implant is bound to a patient by a scan, or by a manual entry
--         that says why the scan failed. Never silently.
--   §B.2  A device carries a serial or a lot. One a recall cannot identify is
--         one a recall cannot withdraw.
--   §B.3  A device goes into one patient, once, and is not un-implanted.
--   §B.4  A cast red flag is set by the database from the findings, not by the
--         person filling the form.
--   §B.5  A check that found a red flag says what was done about it.
--   §B.6  A recall names a device identifier or a lot list — one of the two.
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "clinical"."ImplantKind" AS ENUM ('plate', 'screw', 'intramedullary_nail', 'external_fixator', 'k_wire', 'prosthesis', 'spinal_construct', 'cement', 'graft', 'suture_anchor', 'other');

-- CreateEnum
CREATE TYPE "clinical"."ImplantOwnership" AS ENUM ('owned', 'consignment', 'loan_set');

-- CreateEnum
CREATE TYPE "clinical"."ImplantStockStatus" AS ENUM ('available', 'reserved', 'implanted', 'wasted', 'returned', 'expired', 'quarantined');

-- CreateEnum
CREATE TYPE "clinical"."MriConditionality" AS ENUM ('safe', 'conditional', 'unsafe', 'unknown');

-- CreateEnum
CREATE TYPE "clinical"."ImmobilisationKind" AS ENUM ('cast', 'backslab', 'splint', 'brace', 'traction', 'external_fixator', 'sling', 'other');

-- CreateEnum
CREATE TYPE "clinical"."ImmobilisationStatus" AS ENUM ('requested', 'applied', 'changed', 'removed', 'cancelled');

-- AlterTable

-- CreateTable
CREATE TABLE "clinical"."implant_catalogue" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "udi_di" VARCHAR(60),
    "gtin" VARCHAR(20),
    "catalogue_no" VARCHAR(60),
    "manufacturer" VARCHAR(160) NOT NULL,
    "brand" VARCHAR(120),
    "kind" "clinical"."ImplantKind" NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "size_label" VARCHAR(60),
    "laterality" VARCHAR(16) NOT NULL DEFAULT 'universal',
    "material" VARCHAR(80),
    "mri_conditionality" "clinical"."MriConditionality" NOT NULL DEFAULT 'unknown',
    "mri_conditions" JSONB,
    "shelf_life_months" INTEGER,
    "ownership" "clinical"."ImplantOwnership" NOT NULL DEFAULT 'owned',
    "vendor_id" UUID,
    "consignment_price" DECIMAL(14,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "implant_catalogue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."implant_stock" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "catalogue_id" UUID NOT NULL,
    "serial_no" VARCHAR(80),
    "lot_no" VARCHAR(80),
    "udi_pi" VARCHAR(120),
    "expiry_on" DATE,
    "status" "clinical"."ImplantStockStatus" NOT NULL DEFAULT 'available',
    "location" VARCHAR(120),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grn_ref" VARCHAR(60),
    "reserved_for_case_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "implant_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."implant_usages" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "stock_item_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "fracture_id" UUID,
    "ot_case_id" UUID,
    "admission_id" UUID,
    "procedure_code" VARCHAR(40),
    "procedure_name" VARCHAR(200) NOT NULL,
    "side" VARCHAR(16) NOT NULL,
    "surgeon_id" UUID NOT NULL,
    "implanted_at" TIMESTAMPTZ(6) NOT NULL,
    "scanned" BOOLEAN NOT NULL DEFAULT false,
    "scan_payload" VARCHAR(300),
    "manual_reason" TEXT,
    "manual_by" UUID,
    "charged_price" DECIMAL(14,2),
    "charge_intent_ref" VARCHAR(64),
    "explanted_at" TIMESTAMPTZ(6),
    "explant_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "implant_usages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."implant_recalls" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "reference" VARCHAR(80) NOT NULL,
    "catalogue_id" UUID,
    "udi_di" VARCHAR(60),
    "lot_nos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "manufacturer" VARCHAR(160) NOT NULL,
    "kind" VARCHAR(32) NOT NULL DEFAULT 'field_safety_notice',
    "severity" VARCHAR(16) NOT NULL DEFAULT 'medium',
    "summary" TEXT NOT NULL,
    "action_required" TEXT NOT NULL,
    "issued_on" DATE NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "patients_identified_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "implant_recalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."implant_recall_cases" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "recall_id" UUID NOT NULL,
    "usage_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "surgeon_id" UUID NOT NULL,
    "notified_patient_at" TIMESTAMPTZ(6),
    "notified_surgeon_at" TIMESTAMPTZ(6),
    "response" VARCHAR(24) NOT NULL DEFAULT 'pending',
    "response_at" TIMESTAMPTZ(6),
    "contact_attempts" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "implant_recall_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."cast_requests" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "fracture_id" UUID,
    "er_visit_id" UUID,
    "admission_id" UUID,
    "kind" "clinical"."ImmobilisationKind" NOT NULL,
    "side" VARCHAR(16) NOT NULL,
    "body_region" VARCHAR(80) NOT NULL,
    "position" VARCHAR(120),
    "material" VARCHAR(60),
    "weight_bearing" "clinical"."WeightBearing",
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by" UUID,
    "urgency" VARCHAR(16) NOT NULL DEFAULT 'routine',
    "instructions" TEXT,
    "status" "clinical"."ImmobilisationStatus" NOT NULL DEFAULT 'requested',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cast_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."cast_applications" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "kind" "clinical"."ImmobilisationKind" NOT NULL,
    "side" VARCHAR(16) NOT NULL,
    "material" VARCHAR(60) NOT NULL,
    "position" VARCHAR(120),
    "padding" VARCHAR(80),
    "applied_in" VARCHAR(40) NOT NULL,
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_by" UUID,
    "instructions_given_locale" VARCHAR(12),
    "instructions_given_at" TIMESTAMPTZ(6),
    "next_check_due_at" TIMESTAMPTZ(6),
    "planned_removal_at" TIMESTAMPTZ(6),
    "removed_at" TIMESTAMPTZ(6),
    "removed_by" UUID,
    "removal_notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cast_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."cast_checks" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id" UUID,
    "kind" VARCHAR(24) NOT NULL DEFAULT 'scheduled',
    "pain_out_of_proportion" BOOLEAN NOT NULL DEFAULT false,
    "pain_on_passive_stretch" BOOLEAN NOT NULL DEFAULT false,
    "paraesthesia" BOOLEAN NOT NULL DEFAULT false,
    "pallor" BOOLEAN NOT NULL DEFAULT false,
    "pulselessness" BOOLEAN NOT NULL DEFAULT false,
    "other_findings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capillary_refill_sec" INTEGER,
    "skin_intact" BOOLEAN NOT NULL DEFAULT true,
    "cast_intact" BOOLEAN NOT NULL DEFAULT true,
    "neurovascular_intact" BOOLEAN NOT NULL DEFAULT true,
    "red_flag" BOOLEAN NOT NULL DEFAULT false,
    "action_taken" TEXT,
    "escalated_to" UUID,
    "photo_ref" VARCHAR(300),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cast_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."pin_site_schedules" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "application_id" UUID NOT NULL,
    "pin_label" VARCHAR(40) NOT NULL,
    "interval_days" INTEGER NOT NULL DEFAULT 7,
    "last_care_at" TIMESTAMPTZ(6),
    "next_due_at" TIMESTAMPTZ(6) NOT NULL,
    "infection_grade" INTEGER,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pin_site_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "implant_catalogue_hospital_id_udi_di_idx" ON "clinical"."implant_catalogue"("hospital_id", "udi_di");

-- CreateIndex
CREATE INDEX "implant_catalogue_hospital_id_gtin_idx" ON "clinical"."implant_catalogue"("hospital_id", "gtin");

-- CreateIndex
CREATE INDEX "implant_catalogue_hospital_id_kind_is_active_idx" ON "clinical"."implant_catalogue"("hospital_id", "kind", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "uq_implant_catalogue_no" ON "clinical"."implant_catalogue"("hospital_id", "catalogue_no");

-- CreateIndex
CREATE INDEX "implant_stock_hospital_id_branch_id_status_idx" ON "clinical"."implant_stock"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "implant_stock_hospital_id_catalogue_id_status_idx" ON "clinical"."implant_stock"("hospital_id", "catalogue_id", "status");

-- CreateIndex
CREATE INDEX "implant_stock_hospital_id_lot_no_idx" ON "clinical"."implant_stock"("hospital_id", "lot_no");

-- CreateIndex
CREATE INDEX "implant_stock_hospital_id_expiry_on_idx" ON "clinical"."implant_stock"("hospital_id", "expiry_on");

-- CreateIndex
CREATE UNIQUE INDEX "uq_implant_serial" ON "clinical"."implant_stock"("hospital_id", "serial_no");

-- CreateIndex
CREATE UNIQUE INDEX "implant_usages_stock_item_id_key" ON "clinical"."implant_usages"("stock_item_id");

-- CreateIndex
CREATE INDEX "implant_usages_hospital_id_patient_id_implanted_at_idx" ON "clinical"."implant_usages"("hospital_id", "patient_id", "implanted_at" DESC);

-- CreateIndex
CREATE INDEX "implant_usages_hospital_id_surgeon_id_implanted_at_idx" ON "clinical"."implant_usages"("hospital_id", "surgeon_id", "implanted_at" DESC);

-- CreateIndex
CREATE INDEX "implant_usages_hospital_id_fracture_id_idx" ON "clinical"."implant_usages"("hospital_id", "fracture_id");

-- CreateIndex
CREATE INDEX "implant_recalls_hospital_id_closed_at_idx" ON "clinical"."implant_recalls"("hospital_id", "closed_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_implant_recall_reference" ON "clinical"."implant_recalls"("hospital_id", "reference");

-- CreateIndex
CREATE INDEX "implant_recall_cases_hospital_id_recall_id_response_idx" ON "clinical"."implant_recall_cases"("hospital_id", "recall_id", "response");

-- CreateIndex
CREATE INDEX "implant_recall_cases_hospital_id_patient_id_idx" ON "clinical"."implant_recall_cases"("hospital_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_recall_case_per_usage" ON "clinical"."implant_recall_cases"("recall_id", "usage_id");

-- CreateIndex
CREATE INDEX "cast_requests_hospital_id_branch_id_status_requested_at_idx" ON "clinical"."cast_requests"("hospital_id", "branch_id", "status", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "cast_requests_hospital_id_patient_id_idx" ON "clinical"."cast_requests"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "cast_requests_hospital_id_fracture_id_idx" ON "clinical"."cast_requests"("hospital_id", "fracture_id");

-- CreateIndex
CREATE INDEX "cast_applications_hospital_id_request_id_idx" ON "clinical"."cast_applications"("hospital_id", "request_id");

-- CreateIndex
CREATE INDEX "cast_applications_hospital_id_next_check_due_at_idx" ON "clinical"."cast_applications"("hospital_id", "next_check_due_at");

-- CreateIndex
CREATE INDEX "cast_checks_hospital_id_application_id_at_idx" ON "clinical"."cast_checks"("hospital_id", "application_id", "at" DESC);

-- CreateIndex
CREATE INDEX "cast_checks_hospital_id_red_flag_at_idx" ON "clinical"."cast_checks"("hospital_id", "red_flag", "at" DESC);

-- CreateIndex
CREATE INDEX "pin_site_schedules_hospital_id_is_active_next_due_at_idx" ON "clinical"."pin_site_schedules"("hospital_id", "is_active", "next_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_pin_site_label" ON "clinical"."pin_site_schedules"("application_id", "pin_label");

-- AddForeignKey
ALTER TABLE "clinical"."implant_stock" ADD CONSTRAINT "implant_stock_catalogue_id_fkey" FOREIGN KEY ("catalogue_id") REFERENCES "clinical"."implant_catalogue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."implant_usages" ADD CONSTRAINT "implant_usages_stock_item_id_fkey" FOREIGN KEY ("stock_item_id") REFERENCES "clinical"."implant_stock"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."implant_recalls" ADD CONSTRAINT "implant_recalls_catalogue_id_fkey" FOREIGN KEY ("catalogue_id") REFERENCES "clinical"."implant_catalogue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."implant_recall_cases" ADD CONSTRAINT "implant_recall_cases_recall_id_fkey" FOREIGN KEY ("recall_id") REFERENCES "clinical"."implant_recalls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."implant_recall_cases" ADD CONSTRAINT "implant_recall_cases_usage_id_fkey" FOREIGN KEY ("usage_id") REFERENCES "clinical"."implant_usages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."cast_applications" ADD CONSTRAINT "cast_applications_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "clinical"."cast_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."cast_checks" ADD CONSTRAINT "cast_checks_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "clinical"."cast_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."pin_site_schedules" ADD CONSTRAINT "pin_site_schedules_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "clinical"."cast_applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;


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
  WHERE n.nspname = 'clinical' AND (c.relname LIKE 'implant\_%' OR c.relname LIKE 'cast\_%' OR c.relname LIKE 'pin\_site%')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'TR-003/TR-005 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.2  A device a recall can find ────────────────────────────────────────
--
-- Serial, or lot, or both. A stock item with neither is a device that will not
-- appear in any recall list ever produced, and the only time anyone discovers
-- that is when the notice arrives.
ALTER TABLE "clinical"."implant_catalogue"
  ADD CONSTRAINT "implant_catalogue_is_findable"
  CHECK ("udi_di" IS NOT NULL OR "catalogue_no" IS NOT NULL);

-- A UDI-DI names a device model. Two catalogue rows carrying the same one means
-- a field safety notice quoting that identifier matches whichever row it
-- happens to join to and misses the patients recorded against the other — a
-- list that looks complete and is not. Partial, because most locally-sourced
-- consumables have no UDI at all and several of those must coexist.
CREATE UNIQUE INDEX "uq_implant_catalogue_udi"
  ON "clinical"."implant_catalogue" ("hospital_id", "udi_di")
  WHERE "udi_di" IS NOT NULL;

ALTER TABLE "clinical"."implant_stock"
  ADD CONSTRAINT "implant_stock_is_identifiable"
  CHECK ("serial_no" IS NOT NULL OR "lot_no" IS NOT NULL);

-- An implanted or wasted item is consumed. Returning it to `available` would
-- put a device that is inside a person back on the shelf.
CREATE OR REPLACE FUNCTION clinical.refuse_reusing_a_consumed_implant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF OLD.status IN ('implanted', 'wasted', 'returned')
     AND NEW.status NOT IN ('implanted', 'wasted', 'returned') THEN
    RAISE EXCEPTION 'Stock item % is % and cannot go back to % (TR-003 §B.2). A consumed device returning to the shelf is a device two patients can be given.',
      COALESCE(OLD.serial_no, OLD.lot_no), OLD.status, NEW.status
      USING ERRCODE = 'TR003';
  END IF;

  IF OLD.serial_no IS NOT NULL AND NEW.serial_no IS DISTINCT FROM OLD.serial_no THEN
    RAISE EXCEPTION 'A serial number is not edited (TR-003 §B.2). It is what a recall matches on.'
      USING ERRCODE = 'TR003';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "implant_stock_is_consumed_once"
  BEFORE UPDATE ON "clinical"."implant_stock"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_reusing_a_consumed_implant();

-- An expiry that has passed takes the item out of use rather than warning.
ALTER TABLE "clinical"."implant_stock"
  ADD CONSTRAINT "expired_implant_is_not_available"
  CHECK ("status" <> 'available' OR "expiry_on" IS NULL OR "expiry_on" >= CURRENT_DATE);

-- ── §B.1  Bound by a scan, or by a reason ───────────────────────────────────
--
-- An implant recorded against a patient from memory is one the recall may never
-- match — a transposed digit in a serial is a patient who is not on the list.
-- Manual entry stays possible, because a scanner fails in theatre and the
-- operation does not stop, but it costs a name and a sentence.
ALTER TABLE "clinical"."implant_usages"
  ADD CONSTRAINT "implant_is_scanned_or_reasoned"
  CHECK (
    "scanned"
    OR ("manual_reason" IS NOT NULL AND length(btrim("manual_reason")) >= 8 AND "manual_by" IS NOT NULL)
  );

ALTER TABLE "clinical"."implant_usages"
  ADD CONSTRAINT "scanned_implant_carries_its_payload"
  CHECK (NOT "scanned" OR "scan_payload" IS NOT NULL);

-- ── §B.3  Implanted once, and never quietly un-implanted ────────────────────
--
-- An explant is a recorded event with a reason, not the row disappearing. The
-- device was in that patient, and a revision does not change that history.
CREATE OR REPLACE FUNCTION clinical.refuse_unimplanting()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An implant record is never deleted (TR-003 §B.3). It is the only evidence of what is inside this patient.'
      USING ERRCODE = 'TR003';
  END IF;

  IF NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    RAISE EXCEPTION 'This device is already recorded in another patient (TR-003 §B.3). Correcting that is a new record and an explant on this one, so both patients keep an accurate history.'
      USING ERRCODE = 'TR003';
  END IF;

  IF NEW.stock_item_id IS DISTINCT FROM OLD.stock_item_id THEN
    RAISE EXCEPTION 'The device on this record cannot be swapped (TR-003 §B.3). A recall keyed on the wrong serial finds the wrong patient.'
      USING ERRCODE = 'TR003';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "implant_usage_is_permanent"
  BEFORE UPDATE OR DELETE ON "clinical"."implant_usages"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_unimplanting();

ALTER TABLE "clinical"."implant_usages"
  ADD CONSTRAINT "explant_says_why"
  CHECK ("explanted_at" IS NULL OR "explant_reason" IS NOT NULL);

ALTER TABLE "clinical"."implant_usages"
  ADD CONSTRAINT "explant_after_implant"
  CHECK ("explanted_at" IS NULL OR "explanted_at" >= "implanted_at");

-- Moving the stock item to `implanted` is the other half of the binding, and
-- doing it here means a usage cannot exist against an item still on the shelf.
CREATE OR REPLACE FUNCTION clinical.consume_implant_on_use()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_status text;
BEGIN
  SELECT status::text INTO v_status FROM clinical.implant_stock WHERE id = NEW.stock_item_id;

  IF v_status IN ('implanted', 'wasted', 'returned', 'expired') THEN
    RAISE EXCEPTION 'That device is already % (TR-003 §B.3). Scan the item that actually went in.', v_status
      USING ERRCODE = 'TR003';
  END IF;

  UPDATE clinical.implant_stock
     SET status = 'implanted', updated_at = now()
   WHERE id = NEW.stock_item_id;

  RETURN NEW;
END $$;

CREATE TRIGGER "implant_usage_consumes_the_item"
  BEFORE INSERT ON "clinical"."implant_usages"
  FOR EACH ROW EXECUTE FUNCTION clinical.consume_implant_on_use();

-- ── §B.6  A recall that can find somebody ───────────────────────────────────
ALTER TABLE "clinical"."implant_recalls"
  ADD CONSTRAINT "recall_names_a_device_or_a_lot"
  CHECK (
    "udi_di" IS NOT NULL
    OR "catalogue_id" IS NOT NULL
    OR cardinality("lot_nos") > 0
  );

ALTER TABLE "clinical"."implant_recalls"
  ADD CONSTRAINT "recall_kind_is_known"
  CHECK ("kind" IN ('recall', 'field_safety_notice', 'advisory'));

-- A recall is closed when every case has an outcome — not before. Closing it
-- with patients still pending is closing it with people uninformed.
ALTER TABLE "clinical"."implant_recall_cases"
  ADD CONSTRAINT "recall_response_is_known"
  CHECK ("response" IN ('pending','acknowledged','reviewed','revised','declined','unreachable','deceased'));

-- `unreachable` is only honest after somebody tried.
ALTER TABLE "clinical"."implant_recall_cases"
  ADD CONSTRAINT "unreachable_means_somebody_tried"
  CHECK ("response" <> 'unreachable' OR "contact_attempts" >= 2);

CREATE OR REPLACE FUNCTION clinical.refuse_closing_an_open_recall()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_pending int;
BEGIN
  IF NEW.closed_at IS NULL OR OLD.closed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_pending
    FROM clinical.implant_recall_cases c
   WHERE c.recall_id = NEW.id AND c.response = 'pending';

  IF v_pending > 0 THEN
    RAISE EXCEPTION '% patient(s) on recall % have not been accounted for (TR-003 §B.6). Closing it now closes it with people uninformed.',
      v_pending, NEW.reference
      USING ERRCODE = 'TR003';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "recall_closes_when_everyone_is_accounted_for"
  BEFORE UPDATE ON "clinical"."implant_recalls"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_closing_an_open_recall();

-- ── §B.4  The red flag is the database's to set ─────────────────────────────
--
-- Pain out of proportion, pain on passive stretch and paraesthesia in a limb in
-- plaster are compartment syndrome until proven otherwise, and the window is
-- hours. Letting the person filling the form decide whether that counts as a
-- red flag is letting a busy ward at 2 a.m. decide — and the classic miss is
-- exactly that each finding was mentioned to a different person.
CREATE OR REPLACE FUNCTION clinical.set_cast_red_flag()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  NEW.red_flag :=
       NEW.pain_out_of_proportion
    OR NEW.pain_on_passive_stretch
    OR NEW.paraesthesia
    OR NEW.pallor
    OR NEW.pulselessness
    OR NOT NEW.neurovascular_intact
    OR NOT NEW.skin_intact
    OR (NEW.capillary_refill_sec IS NOT NULL AND NEW.capillary_refill_sec > 3);

  -- §B.5. A finding with no action is a finding somebody wrote down and left.
  IF NEW.red_flag AND (NEW.action_taken IS NULL OR length(btrim(NEW.action_taken)) < 8) THEN
    RAISE EXCEPTION 'This check found a red flag and records no action (TR-005 §B.5). Pain out of proportion, pain on passive stretch and paraesthesia in a limb in plaster are compartment syndrome until proven otherwise, and the window is hours.'
      USING ERRCODE = 'TR005';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "cast_check_red_flag_is_computed"
  BEFORE INSERT OR UPDATE ON "clinical"."cast_checks"
  FOR EACH ROW EXECUTE FUNCTION clinical.set_cast_red_flag();

ALTER TABLE "clinical"."cast_checks"
  ADD CONSTRAINT "capillary_refill_is_seconds"
  CHECK ("capillary_refill_sec" IS NULL OR "capillary_refill_sec" BETWEEN 0 AND 60);

-- ── The limb, again ─────────────────────────────────────────────────────────
--
-- The same rule as TR-002 §B.1, applied to plaster. A cast on the wrong limb is
-- less catastrophic than an operation on one, and it is caught by the same
-- comparison, so there is no reason not to make it.
CREATE OR REPLACE FUNCTION clinical.assert_cast_side_matches()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_request record; v_fracture record;
BEGIN
  IF TG_TABLE_NAME = 'cast_applications' THEN
    SELECT side, body_region INTO v_request FROM clinical.cast_requests WHERE id = NEW.request_id;
    -- No request means a bad reference, which the foreign key states far better
    -- than a laterality complaint about a limb nobody recorded.
    IF NOT FOUND THEN RETURN NEW; END IF;
    IF v_request.side IS DISTINCT FROM NEW.side THEN
      RAISE EXCEPTION 'This was applied to the % and the request is for the % % (TR-005). Reconcile before it sets.',
        NEW.side, v_request.side, v_request.body_region
        USING ERRCODE = 'TR005';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.fracture_id IS NOT NULL THEN
    SELECT side::text AS side, bone_display INTO v_fracture
      FROM clinical.fx_fractures WHERE id = NEW.fracture_id;
    IF v_fracture.side IS DISTINCT FROM NEW.side THEN
      RAISE EXCEPTION 'This request is for the % and the % fracture is on the % (TR-005). The same laterality rule as the fracture plan.',
        NEW.side, v_fracture.bone_display, v_fracture.side
        USING ERRCODE = 'TR005';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "cast_request_is_for_the_fractured_limb"
  BEFORE INSERT OR UPDATE ON "clinical"."cast_requests"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_cast_side_matches();

CREATE TRIGGER "cast_application_is_on_the_requested_limb"
  BEFORE INSERT OR UPDATE ON "clinical"."cast_applications"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_cast_side_matches();

ALTER TABLE "clinical"."cast_applications"
  ADD CONSTRAINT "cast_removed_after_applied"
  CHECK ("removed_at" IS NULL OR "removed_at" >= "applied_at");

-- Checketts-Otterburn runs 1 to 6. Grade 3 needs antibiotics, grade 5 usually
-- means the pin comes out — so the number is a decision, not a note.
ALTER TABLE "clinical"."pin_site_schedules"
  ADD CONSTRAINT "pin_infection_grade_in_range"
  CHECK ("infection_grade" IS NULL OR "infection_grade" BETWEEN 1 AND 6);

ALTER TABLE "clinical"."pin_site_schedules"
  ADD CONSTRAINT "pin_care_interval_is_positive"
  CHECK ("interval_days" >= 1);


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
  RAISE NOTICE 'Granted application DML on % TR-003/TR-005 table(s)', v_count;
END $$;

REVOKE DELETE ON "clinical"."implant_usages" FROM hms_app;
REVOKE DELETE ON "clinical"."implant_stock"  FROM hms_app;
REVOKE UPDATE, DELETE ON "clinical"."cast_checks" FROM hms_app;

COMMENT ON TABLE "clinical"."implant_usages" IS
  'The table a recall reads. Given a UDI or a lot, this returns the patients carrying that device, with the surgeon and the date — which is the single test this module exists to pass.';

COMMENT ON COLUMN "clinical"."cast_checks"."red_flag" IS
  'Set by the database from the findings, never by the person filling the form. Pain out of proportion, pain on passive stretch and paraesthesia in a limb in plaster are compartment syndrome until proven otherwise, and the classic miss is that each was mentioned to a different person.';

COMMENT ON CONSTRAINT "implant_is_scanned_or_reasoned" ON "clinical"."implant_usages" IS
  'A serial typed from memory is a transposed digit, and a transposed digit is a patient who is not on the recall list. Manual entry stays possible because scanners fail in theatre — it costs a name and a sentence.';
