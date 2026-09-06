-- ═════════════════════════════════════════════════════════════════════════════
-- RC-008 — cost estimator
--
-- `docs/prompts/phase-05-billing-rcm.md` §5.7, exit gate 8. NABH cost
-- transparency.
--
-- ── What the constraints are protecting ─────────────────────────────────────
--
-- An estimate is a number a family plans around. They borrow against it, sell
-- against it, and choose this hospital over another because of it. When the
-- discharge bill is 40% higher the money is usually not there, and the argument
-- happens at the counter with a sick relative in a bed upstairs.
--
-- So the rules below are all versions of one rule: **the number the family was
-- given must remain recoverable, and must never quietly disagree with itself.**
--
--   §B.1  an issued estimate is immutable; a revision supersedes it
--   §B.2  gross − discount = payable, and patient + payer = payable
--   §B.3  an issued estimate has a validity date
--   §B.4  a line's amount is its quantity times its rate, less its discount
--   §B.5  one scenario per room class, and the chosen one is unique
--   §B.6  the event log is append-only
--   §B.7  a variance sample is arithmetic, not opinion
--
-- ── Sections ────────────────────────────────────────────────────────────────
--   §A  tables, indexes, foreign keys, RLS
--   §B  the constraints
--   §C  grants
-- ═════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════
-- §A. TABLES
-- ═════════════════════════════════════════════════════════════════════════════
-- CreateEnum
CREATE TYPE "billing"."EstimateStatus" AS ENUM ('draft', 'issued', 'accepted', 'declined', 'expired', 'converted', 'superseded');

-- CreateEnum
CREATE TYPE "billing"."EstimateLineConfidence" AS ENUM ('firm', 'capped', 'indicative', 'contingent');

-- CreateEnum
CREATE TYPE "billing"."EstimateSource" AS ENUM ('tariff', 'package', 'scheme', 'template', 'manual');

-- CreateEnum
CREATE TYPE "billing"."EstimateEventKind" AS ENUM ('created', 'issued', 'shared', 'viewed', 'accepted', 'declined', 'expired', 'superseded', 'converted');

-- AlterTable

-- CreateTable
CREATE TABLE "billing"."est_templates" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "specialty" VARCHAR(120),
    "procedure_code" VARCHAR(40),
    "assumed_los_days" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "est_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."est_template_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "service_id" UUID,
    "description" VARCHAR(300) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "per_day" BOOLEAN NOT NULL DEFAULT false,
    "confidence" "billing"."EstimateLineConfidence" NOT NULL DEFAULT 'firm',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "est_template_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."est_estimates" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "estimate_no" VARCHAR(40) NOT NULL,
    "patient_id" UUID,
    "enquirer_name" VARCHAR(200),
    "enquirer_phone" VARCHAR(20),
    "encounter_id" UUID,
    "template_id" UUID,
    "payer_id" UUID,
    "plan_id" UUID,
    "scheme_id" UUID,
    "package_id" UUID,
    "bed_class_id" UUID,
    "procedure_code" VARCHAR(40),
    "title" VARCHAR(300) NOT NULL,
    "los_days" INTEGER NOT NULL DEFAULT 1,
    "status" "billing"."EstimateStatus" NOT NULL DEFAULT 'draft',
    "total_gross" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_payable" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "patient_share" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "payer_share" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "co_pay_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "deductible" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "valid_till" DATE,
    "issued_at" TIMESTAMPTZ(6),
    "issued_by" UUID,
    "supersedes_id" UUID,
    "converted_at" TIMESTAMPTZ(6),
    "converted_encounter_id" UUID,
    "decline_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "est_estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."est_estimate_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "estimate_id" UUID NOT NULL,
    "service_id" UUID,
    "description" VARCHAR(300) NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL DEFAULT 1,
    "unit_rate" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "confidence" "billing"."EstimateLineConfidence" NOT NULL DEFAULT 'firm',
    "source" "billing"."EstimateSource" NOT NULL DEFAULT 'tariff',
    "tariff_version_id" UUID,
    "tax_treatment" VARCHAR(16) NOT NULL DEFAULT 'exempt',
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "est_estimate_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."est_estimate_scenarios" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "estimate_id" UUID NOT NULL,
    "bed_class_id" UUID,
    "label" VARCHAR(120) NOT NULL,
    "total_payable" DECIMAL(14,2) NOT NULL,
    "patient_share" DECIMAL(14,2) NOT NULL,
    "delta_vs_chosen" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "is_chosen" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "est_estimate_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."est_estimate_events" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "estimate_id" UUID NOT NULL,
    "kind" "billing"."EstimateEventKind" NOT NULL,
    "channel" VARCHAR(24),
    "note" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id" UUID,

    CONSTRAINT "est_estimate_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."est_variance_samples" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "estimate_id" UUID NOT NULL,
    "procedure_code" VARCHAR(40),
    "template_id" UUID,
    "bed_class_id" UUID,
    "bill_id" UUID,
    "estimated_total" DECIMAL(14,2) NOT NULL,
    "actual_total" DECIMAL(14,2) NOT NULL,
    "estimated_patient_share" DECIMAL(14,2) NOT NULL,
    "actual_patient_share" DECIMAL(14,2) NOT NULL,
    "variance_amount" DECIMAL(14,2) NOT NULL,
    "variance_pct" DECIMAL(8,2) NOT NULL,
    "estimated_los" INTEGER NOT NULL,
    "actual_los" INTEGER,
    "explanation" TEXT,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID,

    CONSTRAINT "est_variance_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."est_variance_summaries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "procedure_code" VARCHAR(40) NOT NULL,
    "bed_class_id" UUID,
    "sample_count" INTEGER NOT NULL DEFAULT 0,
    "mean_variance_pct" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "median_variance_pct" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "p90_variance_pct" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "overrun_rate_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "window_from" DATE NOT NULL,
    "window_to" DATE NOT NULL,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "est_variance_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "est_templates_hospital_id_is_active_idx" ON "billing"."est_templates"("hospital_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "est_templates_hospital_id_code_key" ON "billing"."est_templates"("hospital_id", "code");

-- CreateIndex
CREATE INDEX "est_template_lines_hospital_id_template_id_idx" ON "billing"."est_template_lines"("hospital_id", "template_id");

-- CreateIndex
CREATE INDEX "est_estimates_hospital_id_status_created_at_idx" ON "billing"."est_estimates"("hospital_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "est_estimates_hospital_id_patient_id_created_at_idx" ON "billing"."est_estimates"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "est_estimates_hospital_id_procedure_code_idx" ON "billing"."est_estimates"("hospital_id", "procedure_code");

-- CreateIndex
CREATE UNIQUE INDEX "est_estimates_hospital_id_estimate_no_key" ON "billing"."est_estimates"("hospital_id", "estimate_no");

-- CreateIndex
CREATE INDEX "est_estimate_lines_hospital_id_estimate_id_idx" ON "billing"."est_estimate_lines"("hospital_id", "estimate_id");

-- CreateIndex
CREATE INDEX "est_estimate_scenarios_hospital_id_estimate_id_idx" ON "billing"."est_estimate_scenarios"("hospital_id", "estimate_id");

-- CreateIndex
CREATE INDEX "est_estimate_events_hospital_id_estimate_id_at_idx" ON "billing"."est_estimate_events"("hospital_id", "estimate_id", "at" DESC);

-- CreateIndex
CREATE INDEX "est_variance_samples_hospital_id_procedure_code_recorded_at_idx" ON "billing"."est_variance_samples"("hospital_id", "procedure_code", "recorded_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "est_variance_samples_estimate_id_key" ON "billing"."est_variance_samples"("estimate_id");

-- CreateIndex
CREATE INDEX "est_variance_summaries_hospital_id_computed_at_idx" ON "billing"."est_variance_summaries"("hospital_id", "computed_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_est_variance_summary" ON "billing"."est_variance_summaries"("hospital_id", "procedure_code", "bed_class_id", "window_from", "window_to");

-- AddForeignKey
ALTER TABLE "billing"."est_template_lines" ADD CONSTRAINT "est_template_lines_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "billing"."est_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."est_estimates" ADD CONSTRAINT "est_estimates_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "billing"."est_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."est_estimate_lines" ADD CONSTRAINT "est_estimate_lines_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "billing"."est_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."est_estimate_scenarios" ADD CONSTRAINT "est_estimate_scenarios_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "billing"."est_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."est_estimate_events" ADD CONSTRAINT "est_estimate_events_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "billing"."est_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."est_variance_samples" ADD CONSTRAINT "est_variance_samples_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "billing"."est_estimates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



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
  WHERE n.nspname = 'billing' AND c.relname LIKE 'est\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'RC-008 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── B.1  an issued estimate is immutable ────────────────────────────────────
--
-- "We told them ₹1,80,000" has to remain answerable months later, and an answer
-- that could have been edited last night answers nothing. A revision is a new
-- estimate carrying `supersedes_id`; both survive, and the family can be shown
-- exactly what changed and when.
--
-- The lifecycle columns are the exception: an estimate legitimately moves from
-- `issued` to accepted, declined, expired, converted or superseded after it has
-- been issued, and recording that is not editing the quote. Everything that
-- makes up the number is frozen.
CREATE OR REPLACE FUNCTION "billing".refuse_issued_estimate_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME <> 'est_estimates' THEN
    -- A line or a scenario belonging to an issued estimate.
    IF EXISTS (
      SELECT 1 FROM billing.est_estimates e
       WHERE e.id = COALESCE(NEW.estimate_id, OLD.estimate_id)
         AND e.status <> 'draft'
    ) THEN
      RAISE EXCEPTION
        'This estimate has been issued and cannot be changed (RC-008 §B.1). Supersede it with a revision so the family can see what changed.'
        USING ERRCODE = 'RC008';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF OLD.status = 'draft' THEN RETURN NEW; END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'An issued estimate is never deleted (RC-008 §B.1).'
      USING ERRCODE = 'RC008';
  END IF;

  -- What the family was quoted. None of it may move once issued.
  IF NEW.total_gross    IS DISTINCT FROM OLD.total_gross
     OR NEW.total_discount IS DISTINCT FROM OLD.total_discount
     OR NEW.total_payable  IS DISTINCT FROM OLD.total_payable
     OR NEW.patient_share  IS DISTINCT FROM OLD.patient_share
     OR NEW.payer_share    IS DISTINCT FROM OLD.payer_share
     OR NEW.co_pay_pct     IS DISTINCT FROM OLD.co_pay_pct
     OR NEW.deductible     IS DISTINCT FROM OLD.deductible
     OR NEW.valid_till     IS DISTINCT FROM OLD.valid_till
     OR NEW.los_days       IS DISTINCT FROM OLD.los_days
     OR NEW.bed_class_id   IS DISTINCT FROM OLD.bed_class_id
     OR NEW.title          IS DISTINCT FROM OLD.title
     OR NEW.issued_at      IS DISTINCT FROM OLD.issued_at
  THEN
    RAISE EXCEPTION
      'An issued estimate cannot be repriced (RC-008 §B.1). Supersede it with a revision — the family was given the old number and is entitled to see both.'
      USING ERRCODE = 'RC008';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "est_estimates_immutable_once_issued"
  BEFORE UPDATE OR DELETE ON "billing"."est_estimates"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_issued_estimate_edit();

CREATE TRIGGER "est_estimate_lines_immutable_once_issued"
  BEFORE INSERT OR UPDATE OR DELETE ON "billing"."est_estimate_lines"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_issued_estimate_edit();

CREATE TRIGGER "est_estimate_scenarios_immutable_once_issued"
  BEFORE INSERT OR UPDATE OR DELETE ON "billing"."est_estimate_scenarios"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_issued_estimate_edit();


-- ── B.2  the totals cannot disagree with each other ─────────────────────────
--
-- `patient_share` is the only number most families read. If it and `payer_share`
-- can drift from `total_payable`, then the quote says two different things at
-- once and whichever one is quoted aloud becomes the promise.
ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_totals_non_negative"
  CHECK ("total_gross" >= 0 AND "total_discount" >= 0 AND "total_payable" >= 0
         AND "patient_share" >= 0 AND "payer_share" >= 0 AND "deductible" >= 0);

ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_payable_is_gross_less_discount"
  CHECK ("total_payable" = "total_gross" - "total_discount");

ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_shares_sum_to_payable"
  CHECK ("patient_share" + "payer_share" = "total_payable");

ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_discount_within_gross" CHECK ("total_discount" <= "total_gross");

ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_copay_bounded" CHECK ("co_pay_pct" >= 0 AND "co_pay_pct" <= 100);

ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_los_positive" CHECK ("los_days" >= 0 AND "los_days" <= 365);


-- ── B.3  an issued estimate has an expiry and a total ───────────────────────
--
-- A quote with no expiry is a price the hospital is held to for ever, and one
-- with no total is not a quote. Both are refused at the moment it leaves the
-- desk rather than discovered when somebody waves it at the counter a year on.
ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_issued_has_validity_and_total"
  CHECK (status = 'draft'
         OR ("valid_till" IS NOT NULL AND "issued_at" IS NOT NULL AND "total_payable" > 0));

-- Anybody the quote is for: a registered patient, or a named enquirer. Neither
-- means nobody can be told the estimate exists.
ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_issued_has_somebody_to_give_it_to"
  CHECK (status = 'draft' OR "patient_id" IS NOT NULL OR "enquirer_name" IS NOT NULL);

ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_declined_has_a_reason"
  CHECK (status <> 'declined' OR "decline_reason" IS NOT NULL);

ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_converted_names_the_encounter"
  CHECK (status <> 'converted' OR ("converted_at" IS NOT NULL AND "converted_encounter_id" IS NOT NULL));

ALTER TABLE "billing"."est_estimates"
  ADD CONSTRAINT "est_supersedes_is_not_self"
  CHECK ("supersedes_id" IS NULL OR "supersedes_id" <> "id");


-- ── B.4  a line adds up ─────────────────────────────────────────────────────
ALTER TABLE "billing"."est_estimate_lines"
  ADD CONSTRAINT "est_line_amount_is_qty_by_rate"
  CHECK ("quantity" > 0 AND "unit_rate" >= 0
         AND "amount" = round("quantity" * "unit_rate", 2));

ALTER TABLE "billing"."est_estimate_lines"
  ADD CONSTRAINT "est_line_discount_within_amount"
  CHECK ("discount" >= 0 AND "discount" <= "amount");

ALTER TABLE "billing"."est_estimate_lines"
  ADD CONSTRAINT "est_line_taxable_needs_a_rate"
  CHECK ("tax_treatment" <> 'taxable' OR "gst_rate" > 0);


-- ── B.5  the room-class comparison is coherent ──────────────────────────────
--
-- "What if we take a general ward bed?" is the commonest question a family asks.
-- Two scenarios for one class, or two marked chosen, turns the answer into a
-- guess about which row the screen happened to render.
CREATE UNIQUE INDEX "uq_est_scenario_per_class"
  ON "billing"."est_estimate_scenarios" ("estimate_id", "bed_class_id")
  WHERE "bed_class_id" IS NOT NULL;

CREATE UNIQUE INDEX "uq_est_scenario_one_chosen"
  ON "billing"."est_estimate_scenarios" ("estimate_id")
  WHERE "is_chosen";

ALTER TABLE "billing"."est_estimate_scenarios"
  ADD CONSTRAINT "est_scenario_amounts_sane"
  CHECK ("total_payable" >= 0 AND "patient_share" >= 0 AND "patient_share" <= "total_payable");


-- ── B.6  the event log is append-only ───────────────────────────────────────
--
-- It is the record of what the family was told and when. "Nobody explained the
-- cost to us" is answered by this table or by nothing.
CREATE OR REPLACE FUNCTION "billing".refuse_estimate_event_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'est_estimate_events is append-only (RC-008 §B.6). It is the record of what the family was told and when.'
    USING ERRCODE = 'RC008';
END $$;

CREATE TRIGGER "est_estimate_events_append_only"
  BEFORE UPDATE OR DELETE ON "billing"."est_estimate_events"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_estimate_event_edit();


-- ── B.7  a variance sample is arithmetic, not opinion ───────────────────────
--
-- Exit gate 8 is "estimate-vs-actual variance is reported". A sample whose
-- variance does not equal actual − estimated is a report that flatters whoever
-- wrote it, and the whole point of measuring the estimator is that it cannot.
ALTER TABLE "billing"."est_variance_samples"
  ADD CONSTRAINT "est_variance_is_actual_less_estimated"
  CHECK ("variance_amount" = "actual_total" - "estimated_total");

ALTER TABLE "billing"."est_variance_samples"
  ADD CONSTRAINT "est_variance_totals_non_negative"
  CHECK ("estimated_total" > 0 AND "actual_total" >= 0
         AND "estimated_patient_share" >= 0 AND "actual_patient_share" >= 0);

-- Percentage against the estimate, to two places, matching what the summary
-- averages. Computed once here rather than by each reader.
ALTER TABLE "billing"."est_variance_samples"
  ADD CONSTRAINT "est_variance_pct_matches_amount"
  CHECK ("variance_pct" = round(("actual_total" - "estimated_total") * 100 / "estimated_total", 2));

ALTER TABLE "billing"."est_variance_summaries"
  ADD CONSTRAINT "est_summary_window_ordered" CHECK ("window_to" >= "window_from");

ALTER TABLE "billing"."est_variance_summaries"
  ADD CONSTRAINT "est_summary_rates_bounded"
  CHECK ("sample_count" >= 0 AND "overrun_rate_pct" >= 0 AND "overrun_rate_pct" <= 100);

ALTER TABLE "billing"."est_template_lines"
  ADD CONSTRAINT "est_template_line_qty_positive" CHECK ("quantity" > 0);


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
  RAISE NOTICE 'Granted application DML on % RC-008 table(s)', v_count;
END $$;

REVOKE UPDATE, DELETE ON "billing"."est_estimate_events"  FROM hms_app;
REVOKE DELETE          ON "billing"."est_estimates"       FROM hms_app;
REVOKE UPDATE, DELETE  ON "billing"."est_variance_samples" FROM hms_app;

COMMENT ON TABLE "billing"."est_estimates" IS
  'Immutable from `issued`. A family plans around this number — they borrow against it and choose this hospital because of it — so a revision supersedes rather than overwrites, and both survive.';

COMMENT ON COLUMN "billing"."est_estimates"."patient_share" IS
  'What the family will actually be asked for. The only number most of them read, which is why a constraint keeps it and payer_share summing to the total.';

COMMENT ON TABLE "billing"."est_variance_samples" IS
  'Exit gate 8. One row per estimate that became a real bill. Append-only and arithmetically constrained, because an estimator nobody can measure honestly drifts, and the drift is always in the same direction.';
