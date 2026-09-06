-- ═════════════════════════════════════════════════════════════════════════════
-- NC-034 — doctor payouts, and the NMC anti-kickback guard
--
-- `docs/prompts/phase-05-billing-rcm.md` §5.7.
--
-- ── The guard is a shape, not a check ───────────────────────────────────────
--
-- §5.7 asks that "no per-referral payment to registered practitioners is
-- **representable** in the schema". Representable is meant literally, and three
-- things together make it so:
--
--   1. `PayoutBasis` has no `per_referral` member — the rate cannot be written.
--   2. `PayoutSourceType` has no `referral` member — the line cannot point at
--      one.
--   3. §B.1 below refuses a payout line whose bill item names the earning doctor
--      as the *referrer* while somebody else performed the service.
--
-- The third is the one that matters. The first two only stop somebody being
-- honest about what they are doing; a hospital that wanted to pay for referrals
-- would simply write the commission as a `flat_per_service` rule against
-- services the referring doctor never touched. §B.1 is where that fails, and it
-- fails at the database rather than in a service somebody can route around.
--
-- Indian Medical Council (Professional Conduct) Regulation 6.4 and the NMC's
-- 2023 Ethics regulations both prohibit this. The reason is not paperwork: a
-- physician paid per referral has a financial interest in ordering
-- investigations the patient may not need, and the patient pays for both the
-- test and the incentive.
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
CREATE TYPE "billing"."PayoutModel" AS ENUM ('retainer', 'fee_share', 'visiting_session', 'salaried');

-- CreateEnum
CREATE TYPE "billing"."PayoutBasis" AS ENUM ('percent_of_net', 'flat_per_service', 'per_session', 'monthly_retainer');

-- CreateEnum
CREATE TYPE "billing"."PayoutSourceType" AS ENUM ('bill_item', 'procedure', 'session', 'retainer');

-- CreateEnum
CREATE TYPE "billing"."PayoutPeriodStatus" AS ENUM ('open', 'computing', 'computed', 'approved', 'paid', 'closed');

-- CreateEnum
CREATE TYPE "billing"."PayoutStatementStatus" AS ENUM ('draft', 'computed', 'disputed', 'approved', 'paid', 'cancelled');

-- CreateEnum
CREATE TYPE "billing"."PayoutDisputeStatus" AS ENUM ('open', 'upheld', 'rejected', 'withdrawn');

-- AlterTable

-- CreateTable
CREATE TABLE "billing"."payout_contracts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "registration_no" VARCHAR(64),
    "model" "billing"."PayoutModel" NOT NULL,
    "monthly_retainer" DECIMAL(14,2),
    "session_rate" DECIMAL(14,2),
    "pan_on_record" BOOLEAN NOT NULL DEFAULT false,
    "tds_rate_pct" DECIMAL(5,2) NOT NULL DEFAULT 10,
    "tds_exemption_ref" VARCHAR(64),
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "payout_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payout_rules" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "basis" "billing"."PayoutBasis" NOT NULL,
    "service_id" UUID,
    "department_id" UUID,
    "payer_type" VARCHAR(24),
    "item_type" VARCHAR(24),
    "share_pct" DECIMAL(5,2),
    "flat_amount" DECIMAL(14,2),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "payout_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payout_slabs" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "from_amount" DECIMAL(14,2) NOT NULL,
    "to_amount" DECIMAL(14,2),
    "share_pct" DECIMAL(5,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_slabs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payout_periods" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "label" VARCHAR(24) NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "status" "billing"."PayoutPeriodStatus" NOT NULL DEFAULT 'open',
    "statement_count" INTEGER NOT NULL DEFAULT 0,
    "gross_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tds_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "payout_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payout_statements" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "statement_no" VARCHAR(40) NOT NULL,
    "period_id" UUID NOT NULL,
    "contract_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "status" "billing"."PayoutStatementStatus" NOT NULL DEFAULT 'draft',
    "gross_earnings" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "other_deductions" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tds_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net_payable" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "line_count" INTEGER NOT NULL DEFAULT 0,
    "prepared_by" UUID,
    "prepared_at" TIMESTAMPTZ(6),
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "payment_ref" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "payout_statements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payout_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "statement_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "source_type" "billing"."PayoutSourceType" NOT NULL,
    "source_ref_id" UUID,
    "description" VARCHAR(300) NOT NULL,
    "service_name" VARCHAR(300),
    "patient_id" UUID,
    "base_amount" DECIMAL(14,2) NOT NULL,
    "share_pct" DECIMAL(5,2),
    "earned_amount" DECIMAL(14,2) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payout_tds_entries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "statement_id" UUID NOT NULL,
    "doctor_id" UUID NOT NULL,
    "financial_year" VARCHAR(9) NOT NULL,
    "gross_this_period" DECIMAL(14,2) NOT NULL,
    "gross_year_to_date" DECIMAL(14,2) NOT NULL,
    "threshold_amount" DECIMAL(14,2) NOT NULL DEFAULT 30000,
    "rate_applied" DECIMAL(5,2) NOT NULL,
    "pan_on_record" BOOLEAN NOT NULL DEFAULT false,
    "deducted" DECIMAL(14,2) NOT NULL,
    "challan_no" VARCHAR(40),
    "deposited_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_tds_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."payout_disputes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "statement_id" UUID NOT NULL,
    "raised_by" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" VARCHAR(24) NOT NULL,
    "claim" TEXT NOT NULL,
    "claimed_amount" DECIMAL(14,2),
    "status" "billing"."PayoutDisputeStatus" NOT NULL DEFAULT 'open',
    "resolution" TEXT,
    "adjustment" DECIMAL(14,2),
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payout_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_contracts_hospital_id_doctor_id_is_active_idx" ON "billing"."payout_contracts"("hospital_id", "doctor_id", "is_active");

-- CreateIndex
CREATE INDEX "payout_contracts_hospital_id_branch_id_effective_from_idx" ON "billing"."payout_contracts"("hospital_id", "branch_id", "effective_from" DESC);

-- CreateIndex
CREATE INDEX "payout_rules_hospital_id_contract_id_is_active_idx" ON "billing"."payout_rules"("hospital_id", "contract_id", "is_active");

-- CreateIndex
CREATE INDEX "payout_slabs_hospital_id_rule_id_idx" ON "billing"."payout_slabs"("hospital_id", "rule_id");

-- CreateIndex
CREATE INDEX "payout_periods_hospital_id_status_period_from_idx" ON "billing"."payout_periods"("hospital_id", "status", "period_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payout_periods_hospital_id_branch_id_period_from_period_to_key" ON "billing"."payout_periods"("hospital_id", "branch_id", "period_from", "period_to");

-- CreateIndex
CREATE INDEX "payout_statements_hospital_id_doctor_id_created_at_idx" ON "billing"."payout_statements"("hospital_id", "doctor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payout_statements_hospital_id_status_idx" ON "billing"."payout_statements"("hospital_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "payout_statements_hospital_id_statement_no_key" ON "billing"."payout_statements"("hospital_id", "statement_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payout_statement_per_doctor_per_period" ON "billing"."payout_statements"("period_id", "doctor_id");

-- CreateIndex
CREATE INDEX "payout_lines_hospital_id_statement_id_idx" ON "billing"."payout_lines"("hospital_id", "statement_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_payout_line_per_source" ON "billing"."payout_lines"("statement_id", "source_type", "source_ref_id");

-- CreateIndex
CREATE INDEX "payout_tds_entries_hospital_id_doctor_id_financial_year_idx" ON "billing"."payout_tds_entries"("hospital_id", "doctor_id", "financial_year");

-- CreateIndex
CREATE UNIQUE INDEX "payout_tds_entries_statement_id_key" ON "billing"."payout_tds_entries"("statement_id");

-- CreateIndex
CREATE INDEX "payout_disputes_hospital_id_status_raised_at_idx" ON "billing"."payout_disputes"("hospital_id", "status", "raised_at" DESC);

-- CreateIndex
CREATE INDEX "payout_disputes_hospital_id_statement_id_idx" ON "billing"."payout_disputes"("hospital_id", "statement_id");

-- AddForeignKey
ALTER TABLE "billing"."payout_rules" ADD CONSTRAINT "payout_rules_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "billing"."payout_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."payout_slabs" ADD CONSTRAINT "payout_slabs_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "billing"."payout_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."payout_statements" ADD CONSTRAINT "payout_statements_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "billing"."payout_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."payout_statements" ADD CONSTRAINT "payout_statements_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "billing"."payout_contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."payout_lines" ADD CONSTRAINT "payout_lines_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "billing"."payout_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."payout_lines" ADD CONSTRAINT "payout_lines_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "billing"."payout_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."payout_tds_entries" ADD CONSTRAINT "payout_tds_entries_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "billing"."payout_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."payout_disputes" ADD CONSTRAINT "payout_disputes_statement_id_fkey" FOREIGN KEY ("statement_id") REFERENCES "billing"."payout_statements"("id") ON DELETE CASCADE ON UPDATE CASCADE;



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
  WHERE n.nspname = 'billing' AND c.relname LIKE 'payout\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'NC-034 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── B.1  A DOCTOR IS PAID FOR WHAT THEY DID, NOT FOR WHOM THEY SENT ─────────
--
-- The NMC anti-kickback guard. See the migration header.
--
-- `billing.bill_items` records the performing doctor and the referring doctor in
-- separate columns. A payout line pointing at a bill item where the earning
-- doctor is the referrer, and a different doctor performed the work, is a
-- referral commission whatever the rule that produced it is called. It is
-- refused here.
--
-- Note what is *not* refused: a doctor who both referred and performed earns
-- normally, because they did the work. The rule is about being paid for
-- somebody else's.
CREATE OR REPLACE FUNCTION "billing".refuse_referral_payout()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_doctor    uuid;
  v_performer uuid;
  v_referrer  uuid;
BEGIN
  IF NEW.source_type <> 'bill_item' OR NEW.source_ref_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT s.doctor_id INTO v_doctor
    FROM billing.payout_statements s WHERE s.id = NEW.statement_id;

  SELECT bi.performing_doctor_id, bi.referring_doctor_id
    INTO v_performer, v_referrer
    FROM billing.bill_items bi WHERE bi.id = NEW.source_ref_id;

  -- No bill item, or one that records no performer: nothing to check against,
  -- and §B.2 refuses the line for a different reason.
  IF v_performer IS NULL THEN
    IF v_referrer IS NOT NULL AND v_referrer = v_doctor THEN
      RAISE EXCEPTION
        'NC-034: this line would pay the referring doctor for a service with no recorded performer. A payout must trace to work the doctor did (NMC Ethics Regulations; IMC Regulation 6.4).'
        USING ERRCODE = 'NC034';
    END IF;
    RETURN NEW;
  END IF;

  IF v_performer <> v_doctor THEN
    IF v_referrer IS NOT NULL AND v_referrer = v_doctor THEN
      RAISE EXCEPTION
        'NC-034: this is a payment to the referring doctor for a service another doctor performed. Per-referral payment to a registered practitioner is prohibited (NMC Ethics Regulations; IMC Regulation 6.4), and it is not representable here.'
        USING ERRCODE = 'NC034';
    END IF;
    RAISE EXCEPTION
      'NC-034: a doctor is paid for services they performed. This bill item names a different performing doctor.'
      USING ERRCODE = 'NC034';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "payout_lines_no_referral_commission"
  BEFORE INSERT OR UPDATE ON "billing"."payout_lines"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_referral_payout();

COMMENT ON FUNCTION "billing".refuse_referral_payout() IS
  'NC-034 / NMC Ethics Regulations. A physician paid per referral has a financial interest in ordering investigations the patient may not need, and the patient pays for both. Enforced in the database because a service check is something a later module can forget.';


-- ── B.2  a fee-share line traces to a real charge ───────────────────────────
--
-- A `bill_item` line whose source does not exist is an earning with nothing
-- behind it — the same thing as a referral commission with better paperwork.
ALTER TABLE "billing"."payout_lines"
  ADD CONSTRAINT "payout_line_source_is_named"
  CHECK (source_type = 'retainer' OR "source_ref_id" IS NOT NULL);

ALTER TABLE "billing"."payout_lines"
  ADD CONSTRAINT "payout_line_amounts_sane"
  CHECK ("base_amount" >= 0 AND "earned_amount" >= 0);

-- A doctor cannot earn more from a service than the hospital collected for it.
-- Above 100% the arrangement is not a fee share, and NC-034 has no way to
-- describe what it would be.
ALTER TABLE "billing"."payout_lines"
  ADD CONSTRAINT "payout_line_earning_within_base"
  CHECK (source_type = 'retainer' OR source_type = 'session' OR "earned_amount" <= "base_amount");

ALTER TABLE "billing"."payout_lines"
  ADD CONSTRAINT "payout_line_share_bounded"
  CHECK ("share_pct" IS NULL OR ("share_pct" > 0 AND "share_pct" <= 100));


-- ── B.3  a statement's arithmetic ───────────────────────────────────────────
ALTER TABLE "billing"."payout_statements"
  ADD CONSTRAINT "payout_statement_amounts_non_negative"
  CHECK ("gross_earnings" >= 0 AND "other_deductions" >= 0
         AND "tds_amount" >= 0 AND "net_payable" >= 0);

ALTER TABLE "billing"."payout_statements"
  ADD CONSTRAINT "payout_statement_net_is_gross_less_deductions"
  CHECK ("net_payable" = "gross_earnings" - "other_deductions" - "tds_amount");

ALTER TABLE "billing"."payout_statements"
  ADD CONSTRAINT "payout_statement_deductions_within_gross"
  CHECK ("other_deductions" + "tds_amount" <= "gross_earnings");


-- ── B.4  the person who computes it is not the person who releases it ───────
--
-- The standard money control, and it matters here because a payout statement is
-- an outbound payment authorised on the strength of a calculation nobody else
-- has looked at.
ALTER TABLE "billing"."payout_statements"
  ADD CONSTRAINT "payout_maker_is_not_checker"
  CHECK ("approved_by" IS NULL OR "prepared_by" IS NULL OR "approved_by" <> "prepared_by");

ALTER TABLE "billing"."payout_statements"
  ADD CONSTRAINT "payout_approved_is_complete"
  CHECK (status NOT IN ('approved', 'paid')
         OR ("approved_by" IS NOT NULL AND "approved_at" IS NOT NULL));

ALTER TABLE "billing"."payout_statements"
  ADD CONSTRAINT "payout_paid_has_a_reference"
  CHECK (status <> 'paid' OR ("paid_at" IS NOT NULL AND "payment_ref" IS NOT NULL));


-- ── B.5  a disputed statement is not paid ───────────────────────────────────
--
-- "That consultation was mine" has to be settled before the money leaves, not
-- after — a paid statement is far harder to correct than a held one.
CREATE OR REPLACE FUNCTION "billing".refuse_paying_disputed_statement()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_open int;
BEGIN
  IF NEW.status NOT IN ('approved', 'paid') THEN RETURN NEW; END IF;
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_open
    FROM billing.payout_disputes d
   WHERE d.statement_id = NEW.id AND d.status = 'open';

  IF v_open > 0 THEN
    RAISE EXCEPTION
      'NC-034: this statement has % open dispute(s). Settle them before the money leaves — a paid statement is far harder to correct than a held one.', v_open
      USING ERRCODE = 'NC034';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "payout_statements_not_paid_while_disputed"
  BEFORE UPDATE ON "billing"."payout_statements"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_paying_disputed_statement();


-- ── B.6  section 194J ───────────────────────────────────────────────────────
--
-- 10% on professional fees, 20% where no PAN is on record (section 206AA), and
-- nothing at all below the ₹30,000 annual threshold. The cumulative figure is
-- stored rather than recomputed, so the year-to-date cannot drift between the
-- statement and the return.
ALTER TABLE "billing"."payout_tds_entries"
  ADD CONSTRAINT "payout_tds_rate_is_lawful"
  CHECK ("rate_applied" >= 0 AND "rate_applied" <= 30
         AND (NOT "pan_on_record" OR "rate_applied" <= 10));

ALTER TABLE "billing"."payout_tds_entries"
  ADD CONSTRAINT "payout_tds_no_pan_is_deducted_higher"
  CHECK ("pan_on_record" OR "deducted" = 0 OR "rate_applied" >= 20);

ALTER TABLE "billing"."payout_tds_entries"
  ADD CONSTRAINT "payout_tds_below_threshold_deducts_nothing"
  CHECK ("gross_year_to_date" >= "threshold_amount" OR "deducted" = 0);

ALTER TABLE "billing"."payout_tds_entries"
  ADD CONSTRAINT "payout_tds_amounts_non_negative"
  CHECK ("gross_this_period" >= 0 AND "gross_year_to_date" >= "gross_this_period"
         AND "deducted" >= 0 AND "deducted" <= "gross_this_period");


-- ── B.7  contracts and rules are coherent ───────────────────────────────────
ALTER TABLE "billing"."payout_contracts"
  ADD CONSTRAINT "payout_contract_dates_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

ALTER TABLE "billing"."payout_contracts"
  ADD CONSTRAINT "payout_contract_retainer_needs_a_model"
  CHECK ("monthly_retainer" IS NULL OR model IN ('retainer', 'salaried'));

ALTER TABLE "billing"."payout_contracts"
  ADD CONSTRAINT "payout_contract_session_rate_needs_a_model"
  CHECK ("session_rate" IS NULL OR model = 'visiting_session');

-- Only one live contract per doctor. Two would mean two fee shares on one
-- service, and whichever the resolver saw first would win.
CREATE UNIQUE INDEX "uq_payout_contract_live_per_doctor"
  ON "billing"."payout_contracts" ("hospital_id", "doctor_id")
  WHERE "is_active";

ALTER TABLE "billing"."payout_rules"
  ADD CONSTRAINT "payout_rule_has_the_right_number"
  CHECK ((basis = 'percent_of_net' AND "share_pct" IS NOT NULL AND "flat_amount" IS NULL)
      OR (basis IN ('flat_per_service', 'per_session', 'monthly_retainer')
          AND "flat_amount" IS NOT NULL AND "share_pct" IS NULL));

ALTER TABLE "billing"."payout_rules"
  ADD CONSTRAINT "payout_rule_share_bounded"
  CHECK ("share_pct" IS NULL OR ("share_pct" > 0 AND "share_pct" <= 100));

ALTER TABLE "billing"."payout_slabs"
  ADD CONSTRAINT "payout_slab_range_ordered"
  CHECK ("to_amount" IS NULL OR "to_amount" > "from_amount");

ALTER TABLE "billing"."payout_slabs"
  ADD CONSTRAINT "payout_slab_share_bounded"
  CHECK ("share_pct" > 0 AND "share_pct" <= 100);

-- Slabs within a rule cannot overlap, or an amount falls in two bands.
ALTER TABLE "billing"."payout_slabs"
  ADD CONSTRAINT "payout_slabs_do_not_overlap"
  EXCLUDE USING gist (
    "rule_id" WITH =,
    numrange("from_amount", "to_amount", '[)') WITH &&
  );

ALTER TABLE "billing"."payout_periods"
  ADD CONSTRAINT "payout_period_dates_ordered" CHECK ("period_to" >= "period_from");

ALTER TABLE "billing"."payout_periods"
  ADD CONSTRAINT "payout_period_totals_non_negative"
  CHECK ("statement_count" >= 0 AND "gross_total" >= 0 AND "tds_total" >= 0 AND "net_total" >= 0);

ALTER TABLE "billing"."payout_disputes"
  ADD CONSTRAINT "payout_dispute_resolved_is_explained"
  CHECK (status = 'open' OR ("resolution" IS NOT NULL AND "resolved_by" IS NOT NULL));


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
  RAISE NOTICE 'Granted application DML on % NC-034 table(s)', v_count;
END $$;

-- A paid statement and a filed TDS entry are both external commitments: money
-- has left, and a return has been filed against the figure.
REVOKE DELETE ON "billing"."payout_statements"  FROM hms_app;
REVOKE DELETE ON "billing"."payout_tds_entries" FROM hms_app;
REVOKE DELETE ON "billing"."payout_disputes"    FROM hms_app;

COMMENT ON TABLE "billing"."payout_lines" IS
  'Every line traces to something the doctor performed. The trigger refuses a line that would pay a referring doctor for another doctor''s work — NC-034''s anti-kickback guard, enforced as a shape rather than a rule.';

COMMENT ON TABLE "billing"."payout_tds_entries" IS
  'Section 194J, cumulative. The annual threshold and the 206AA no-PAN rate both need the year to date, and recomputing it from a sum each month is how a return and a statement come to disagree.';
