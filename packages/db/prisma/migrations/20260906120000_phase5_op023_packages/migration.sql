-- ─────────────────────────────────────────────────────────────────────────────
-- Vim's HMS — Phase 5, OP-023: packages
--
-- `phase-05` §5.4. Nine tables in `billing`. A package is a promise — "this
-- operation costs ₹85,000, and here is what that includes" — and every table
-- here exists to keep that promise checkable.
--
--   §A  row-level security
--   §B  the constraints §5.4 depends on:
--         B.1  one published version window per package (no overlaps)
--         B.2  a booking cannot be activated twice
--         B.3  units used never exceed units bought
--         B.4  a decided variance names who decided and what happens to the money
--         B.5  a follow-up cannot be used more times than it was sold
--   §C  grants; financial rows are never deleted
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "billing"."PackageKind" AS ENUM ('surgical', 'maternity', 'health_checkup', 'dialysis', 'chemotherapy', 'physiotherapy', 'diagnostic', 'wellness', 'other');

-- CreateEnum
CREATE TYPE "billing"."PackageScope" AS ENUM ('op', 'ip', 'day_care', 'any');

-- CreateEnum
CREATE TYPE "billing"."PackageStatus" AS ENUM ('draft', 'pending_approval', 'active', 'retired');

-- CreateEnum
CREATE TYPE "billing"."PackageBookingStatus" AS ENUM ('booked', 'confirmed', 'activated', 'completed', 'cancelled', 'expired', 'converted');

-- CreateEnum
CREATE TYPE "billing"."PackageActivationStatus" AS ENUM ('active', 'closed', 'converted_itemised');

-- CreateEnum
CREATE TYPE "billing"."PackageChargeDecision" AS ENUM ('covered', 'capped', 'excluded', 'excess_pending', 'excess_approved', 'excess_absorbed');

-- CreateEnum
CREATE TYPE "billing"."PackageVarianceReason" AS ENUM ('complication', 'patient_choice', 'upgrade', 'clinical_need', 'error', 'other');

-- CreateEnum
CREATE TYPE "billing"."PackageVarianceStatus" AS ENUM ('pending', 'approved', 'rejected', 'absorbed');

-- CreateEnum
CREATE TYPE "billing"."PackageBillAction" AS ENUM ('bill_patient', 'bill_insurer', 'absorb', 'convert');

-- AlterTable
ALTER TABLE "queue"."queue_definitions" ALTER COLUMN "reset_time" SET DEFAULT '00:00:00'::time;

-- CreateTable
CREATE TABLE "billing"."packages" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "kind" "billing"."PackageKind" NOT NULL,
    "scope" "billing"."PackageScope" NOT NULL DEFAULT 'any',
    "department_id" UUID,
    "specialty" VARCHAR(64),
    "gender" VARCHAR(16),
    "age_min" INTEGER,
    "age_max" INTEGER,
    "los_days_included" INTEGER,
    "room_class_id" UUID,
    "validity_days" INTEGER NOT NULL DEFAULT 365,
    "max_units" INTEGER,
    "description" TEXT,
    "terms" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "status" "billing"."PackageStatus" NOT NULL DEFAULT 'draft',
    "current_version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."package_versions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "components" JSONB NOT NULL DEFAULT '[]',
    "exclusions" JSONB NOT NULL DEFAULT '[]',
    "rules" JSONB NOT NULL DEFAULT '{}',
    "a_la_carte_total" DECIMAL(14,2),
    "cost_basis" DECIMAL(14,2),
    "gst_split" JSONB NOT NULL DEFAULT '{}',
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "sha256" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "package_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."package_prices" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "package_version_id" UUID NOT NULL,
    "payer_plan_id" UUID,
    "price" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "savings" DECIMAL(14,2),
    "scheme_code" VARCHAR(64),
    "dynamic_rule_id" UUID,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "package_prices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."package_scheme_maps" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "payer_id" UUID,
    "scheme" VARCHAR(24) NOT NULL,
    "external_code" VARCHAR(64) NOT NULL,
    "external_rate" DECIMAL(14,2),
    "inclusions_note" TEXT,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "package_scheme_maps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."package_bookings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "booking_no" VARCHAR(40) NOT NULL,
    "patient_id" UUID NOT NULL,
    "package_version_id" UUID NOT NULL,
    "payer_plan_id" UUID,
    "doctor_id" UUID,
    "planned_date" DATE,
    "channel" VARCHAR(24) NOT NULL DEFAULT 'counter',
    "estimate_id" UUID,
    "advance_required" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advance_paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "advance_receipt_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" "billing"."PackageBookingStatus" NOT NULL DEFAULT 'booked',
    "valid_until" DATE,
    "instructions_sent_at" TIMESTAMPTZ(6),
    "preauth_id" UUID,
    "cancel_reason" TEXT,
    "refund_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "package_bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."package_activations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "booking_id" UUID,
    "package_version_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "admission_id" UUID,
    "daycare_id" UUID,
    "activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_by" UUID NOT NULL,
    "status" "billing"."PackageActivationStatus" NOT NULL DEFAULT 'active',
    "units_total" INTEGER NOT NULL DEFAULT 1,
    "units_used" INTEGER NOT NULL DEFAULT 0,
    "caps_state" JSONB NOT NULL DEFAULT '{}',
    "covered_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "excess_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "exclusions_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMPTZ(6),
    "closure_bill_id" UUID,
    "variance_summary" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "package_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."package_charge_evaluations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "charge_event_id" UUID,
    "service_id" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "decision" "billing"."PackageChargeDecision" NOT NULL,
    "covered_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "patient_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "rule_ref" VARCHAR(120),
    "evaluated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_charge_evaluations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."package_variance_requests" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "item_ref" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason_code" "billing"."PackageVarianceReason" NOT NULL,
    "justification" TEXT,
    "requested_by" UUID NOT NULL,
    "approver_chain" JSONB NOT NULL DEFAULT '[]',
    "status" "billing"."PackageVarianceStatus" NOT NULL DEFAULT 'pending',
    "decision_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "bill_action" "billing"."PackageBillAction",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "package_variance_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."package_followup_entitlements" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "kind" VARCHAR(48) NOT NULL,
    "count_total" INTEGER NOT NULL,
    "count_used" INTEGER NOT NULL DEFAULT 0,
    "valid_until" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "package_followup_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "packages_hospital_id_status_kind_idx" ON "billing"."packages"("hospital_id", "status", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "packages_hospital_id_code_key" ON "billing"."packages"("hospital_id", "code");

-- CreateIndex
CREATE INDEX "package_versions_hospital_id_package_id_effective_from_idx" ON "billing"."package_versions"("hospital_id", "package_id", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "package_versions_package_id_version_key" ON "billing"."package_versions"("package_id", "version");

-- CreateIndex
CREATE INDEX "package_prices_hospital_id_package_version_id_idx" ON "billing"."package_prices"("hospital_id", "package_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "package_prices_package_version_id_payer_plan_id_effective_f_key" ON "billing"."package_prices"("package_version_id", "payer_plan_id", "effective_from");

-- CreateIndex
CREATE INDEX "package_scheme_maps_hospital_id_scheme_idx" ON "billing"."package_scheme_maps"("hospital_id", "scheme");

-- CreateIndex
CREATE UNIQUE INDEX "package_scheme_maps_package_id_scheme_external_code_effecti_key" ON "billing"."package_scheme_maps"("package_id", "scheme", "external_code", "effective_from");

-- CreateIndex
CREATE INDEX "package_bookings_hospital_id_status_planned_date_idx" ON "billing"."package_bookings"("hospital_id", "status", "planned_date");

-- CreateIndex
CREATE INDEX "package_bookings_hospital_id_patient_id_idx" ON "billing"."package_bookings"("hospital_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "package_bookings_hospital_id_booking_no_key" ON "billing"."package_bookings"("hospital_id", "booking_no");

-- CreateIndex
CREATE INDEX "package_activations_hospital_id_status_idx" ON "billing"."package_activations"("hospital_id", "status");

-- CreateIndex
CREATE INDEX "package_activations_hospital_id_admission_id_idx" ON "billing"."package_activations"("hospital_id", "admission_id");

-- CreateIndex
CREATE INDEX "package_activations_hospital_id_encounter_id_idx" ON "billing"."package_activations"("hospital_id", "encounter_id");

-- CreateIndex
CREATE INDEX "package_activations_hospital_id_patient_id_idx" ON "billing"."package_activations"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "package_charge_evaluations_hospital_id_activation_id_evalua_idx" ON "billing"."package_charge_evaluations"("hospital_id", "activation_id", "evaluated_at" DESC);

-- CreateIndex
CREATE INDEX "package_charge_evaluations_hospital_id_decision_idx" ON "billing"."package_charge_evaluations"("hospital_id", "decision");

-- CreateIndex
CREATE INDEX "package_variance_requests_hospital_id_status_created_at_idx" ON "billing"."package_variance_requests"("hospital_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "package_followup_entitlements_hospital_id_valid_until_idx" ON "billing"."package_followup_entitlements"("hospital_id", "valid_until");

-- CreateIndex
CREATE UNIQUE INDEX "package_followup_entitlements_activation_id_kind_key" ON "billing"."package_followup_entitlements"("activation_id", "kind");

-- CreateIndex
CREATE INDEX "pay_webhook_events_hospital_id_provider_event_id_idx" ON "billing"."pay_webhook_events"("hospital_id", "provider", "event_id");

-- AddForeignKey
ALTER TABLE "billing"."package_versions" ADD CONSTRAINT "package_versions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "billing"."packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."package_prices" ADD CONSTRAINT "package_prices_package_version_id_fkey" FOREIGN KEY ("package_version_id") REFERENCES "billing"."package_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."package_scheme_maps" ADD CONSTRAINT "package_scheme_maps_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "billing"."packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."package_bookings" ADD CONSTRAINT "package_bookings_package_version_id_fkey" FOREIGN KEY ("package_version_id") REFERENCES "billing"."package_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."package_activations" ADD CONSTRAINT "package_activations_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "billing"."package_bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."package_activations" ADD CONSTRAINT "package_activations_package_version_id_fkey" FOREIGN KEY ("package_version_id") REFERENCES "billing"."package_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."package_charge_evaluations" ADD CONSTRAINT "package_charge_evaluations_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "billing"."package_activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."package_variance_requests" ADD CONSTRAINT "package_variance_requests_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "billing"."package_activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."package_followup_entitlements" ADD CONSTRAINT "package_followup_entitlements_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "billing"."package_activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "billing"."pay_webhook_events_status_idx" RENAME TO "pay_webhook_events_hospital_id_status_received_at_idx";



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
  WHERE n.nspname = 'billing' AND c.relname LIKE 'package%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'OP-023 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── B.1  a package's version windows may not overlap ────────────────────────
--
-- Same argument as RC-003's tariff versions: if two versions cover one day, the
-- question "what did this patient buy on the 3rd?" has two answers, and the
-- promise stops being enforceable.
ALTER TABLE "billing"."package_versions"
  ADD CONSTRAINT "package_versions_no_overlap"
  EXCLUDE USING gist (
    "package_id" WITH =,
    daterange("effective_from", "effective_to", '[)') WITH &&
  );

ALTER TABLE "billing"."package_versions"
  ADD CONSTRAINT "package_versions_dates_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

-- ── B.2  a booking cannot be activated twice ────────────────────────────────
--
-- Two activations of one booking is one package consumed twice: the caps reset,
-- the patient gets a second course they did not buy, and the variance report
-- balances to nothing. Partial because a cancelled activation legitimately
-- precedes a corrected one.
CREATE UNIQUE INDEX "uq_package_activation_per_booking"
  ON "billing"."package_activations" ("booking_id")
  WHERE "booking_id" IS NOT NULL AND status <> 'converted_itemised';

COMMENT ON INDEX "billing"."uq_package_activation_per_booking" IS
  'OP-023 §5. One activation per booking: a second one resets the caps and hands the patient a course they did not buy.';

-- ── B.3  units used never exceed units bought ───────────────────────────────
ALTER TABLE "billing"."package_activations"
  ADD CONSTRAINT "package_activations_units_within_total"
  CHECK ("units_used" >= 0 AND "units_used" <= "units_total");

ALTER TABLE "billing"."package_activations"
  ADD CONSTRAINT "package_activations_amounts_non_negative"
  CHECK ("covered_amount" >= 0 AND "excess_amount" >= 0 AND "exclusions_amount" >= 0);

-- ── B.4  a decided variance says who decided and what happens to the money ──
--
-- §5.4 requires excess approval *before* billing beyond the package. A variance
-- marked approved with no `bill_action` is an approval nobody can act on, and
-- the charge sits in limbo until the family asks about it.
ALTER TABLE "billing"."package_variance_requests"
  ADD CONSTRAINT "package_variance_decided_is_complete"
  CHECK (
    status = 'pending'
    OR ("decision_by" IS NOT NULL AND "decided_at" IS NOT NULL AND "bill_action" IS NOT NULL)
  );

-- Requester and approver are different people. Same reasoning as every other
-- maker-checker in this phase.
ALTER TABLE "billing"."package_variance_requests"
  ADD CONSTRAINT "package_variance_maker_is_not_checker"
  CHECK ("decision_by" IS NULL OR "decision_by" <> "requested_by");

ALTER TABLE "billing"."package_variance_requests"
  ADD CONSTRAINT "package_variance_amount_positive" CHECK ("amount" > 0);

-- ── B.5  a follow-up cannot be used more often than it was sold ─────────────
--
-- A patient turned away from a visit they already paid for is the failure this
-- prevents; a patient given ten of a three-visit entitlement is the other.
ALTER TABLE "billing"."package_followup_entitlements"
  ADD CONSTRAINT "package_followups_used_within_total"
  CHECK ("count_used" >= 0 AND "count_used" <= "count_total");

-- A charge evaluation must add up: what the package covered plus what the
-- patient owes is the charge.
ALTER TABLE "billing"."package_charge_evaluations"
  ADD CONSTRAINT "package_evaluation_splits_the_charge"
  CHECK (abs(("covered_amount" + "patient_amount") - "amount") <= 0.01);


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'billing' AND c.relkind IN ('r','p') AND c.relispartition = false
      AND c.relname NOT LIKE '\_prisma%'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % OP-023 table(s)', v_count;
END $$;

-- An evaluation is the record of what the package did to a charge. It is
-- evidence in a dispute at the discharge counter, so it is never deleted.
REVOKE DELETE ON "billing"."package_charge_evaluations" FROM hms_app;
REVOKE DELETE ON "billing"."package_variance_requests" FROM hms_app;
REVOKE DELETE ON "billing"."package_activations"       FROM hms_app;

COMMENT ON TABLE "billing"."package_charge_evaluations" IS
  'What the package did to each bill line and why. The answer to "why is this on my bill when I bought a package?", asked at the discharge counter with the family present. Never deleted.';
