-- ═════════════════════════════════════════════════════════════════════════════
-- RC-007 — government schemes (PMJAY/Ayushman, CGHS, ECHS, ESIC, state)
--
-- `docs/prompts/phase-05-billing-rcm.md` §5.6, exit gate 6.
--
-- ── What this migration is really for ───────────────────────────────────────
--
-- Thirteen tables, and one of them earns the migration: `scheme_cash_attempts`,
-- together with the trigger in §B.1 that makes it necessary. Exit gate 6 says a
-- scheme beneficiary cannot be charged cash *anywhere in the system*, and the
-- only way to write that sentence and mean it is to enforce it below the
-- application, at the one table every collection point must write to.
--
-- That table is `billing.payment_lines`. The cash counter writes one. The
-- pharmacy window writes one. An IP deposit, an OPD advance, a forex tender —
-- all of them are a `payments` row with `payment_lines` beneath it. So the block
-- lives there, and a Phase 7 or Phase 9 module that collects money without ever
-- having read this file is still refused.
--
-- Gateway tenders need no equivalent: `billing."PayMethod"` has no `cash`
-- member, so `pay_payments` cannot represent a banknote.
--
-- ── Sections ────────────────────────────────────────────────────────────────
--   §A  tables, enums, indexes, foreign keys, RLS
--   §B  the constraints, each with the failure it prevents
--   §C  grants
-- ═════════════════════════════════════════════════════════════════════════════


-- ═════════════════════════════════════════════════════════════════════════════
-- §A. TABLES
-- ═════════════════════════════════════════════════════════════════════════════
-- CreateEnum
CREATE TYPE "billing"."SchemeType" AS ENUM ('pmjay', 'cghs', 'echs', 'esic', 'state', 'other');

-- CreateEnum
CREATE TYPE "billing"."SchemeCashBlockScope" AS ENUM ('active_case', 'always', 'off');

-- CreateEnum
CREATE TYPE "billing"."SchemeVersionStatus" AS ENUM ('draft', 'published', 'superseded');

-- CreateEnum
CREATE TYPE "billing"."SchemeBeneficiaryStatus" AS ENUM ('unverified', 'verified', 'mismatch', 'expired', 'rejected');

-- CreateEnum
CREATE TYPE "billing"."SchemeVerificationMethod" AS ENUM ('portal', 'api', 'biometric', 'otp', 'card', 'manual');

-- CreateEnum
CREATE TYPE "billing"."SchemeVerificationOutcome" AS ENUM ('verified', 'not_found', 'mismatch', 'expired', 'exhausted', 'error');

-- CreateEnum
CREATE TYPE "billing"."SchemeCaseStatus" AS ENUM ('open', 'preauth_pending', 'approved', 'in_treatment', 'discharged', 'claim_submitted', 'settled', 'rejected', 'closed');

-- CreateEnum
CREATE TYPE "billing"."SchemeClaimStatus" AS ENUM ('draft', 'assembled', 'submitted', 'queried', 'approved', 'partially_approved', 'rejected', 'paid', 'closed');

-- CreateEnum
CREATE TYPE "billing"."SchemeClaimFormat" AS ENUM ('pmjay_json', 'cghs_pdf', 'echs_xml', 'esic_csv', 'state_csv', 'manual');

-- CreateEnum
CREATE TYPE "billing"."SchemeShortfallStatus" AS ENUM ('open', 'appealed', 'recovered', 'written_off');

-- AlterTable

-- CreateTable
CREATE TABLE "billing"."scheme_masters" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "type" "billing"."SchemeType" NOT NULL,
    "authority" VARCHAR(160),
    "state_code" VARCHAR(8),
    "empanelment_no" VARCHAR(64),
    "cash_block_scope" "billing"."SchemeCashBlockScope" NOT NULL DEFAULT 'active_case',
    "requires_preauth" BOOLEAN NOT NULL DEFAULT true,
    "claim_format" "billing"."SchemeClaimFormat" NOT NULL DEFAULT 'manual',
    "claim_window_days" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "scheme_masters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_package_versions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "authority_ref" VARCHAR(80),
    "status" "billing"."SchemeVersionStatus" NOT NULL DEFAULT 'draft',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "scheme_package_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_packages" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "version_id" UUID NOT NULL,
    "package_code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(300) NOT NULL,
    "specialty" VARCHAR(120),
    "procedure_type" VARCHAR(24) NOT NULL DEFAULT 'unspecified',
    "base_rate" DECIMAL(14,2) NOT NULL,
    "stratification" JSONB NOT NULL DEFAULT '{}',
    "implant_allowed" BOOLEAN NOT NULL DEFAULT false,
    "implant_cap" DECIMAL(14,2),
    "pre_auth_required" BOOLEAN NOT NULL DEFAULT true,
    "los_days" INTEGER,
    "incompatible_with" TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "scheme_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_beneficiaries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "member_id" VARCHAR(64) NOT NULL,
    "family_id" VARCHAR(64),
    "name_on_card" VARCHAR(200),
    "relation" VARCHAR(24) NOT NULL DEFAULT 'self',
    "entitlement_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "entitlement_balance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "valid_from" DATE,
    "valid_till" DATE,
    "status" "billing"."SchemeBeneficiaryStatus" NOT NULL DEFAULT 'unverified',
    "verified_at" TIMESTAMPTZ(6),
    "verified_by" UUID,
    "verification_method" "billing"."SchemeVerificationMethod",
    "verification_ref" VARCHAR(120),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "scheme_beneficiaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_verifications" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "method" "billing"."SchemeVerificationMethod" NOT NULL,
    "outcome" "billing"."SchemeVerificationOutcome" NOT NULL,
    "request_ref" VARCHAR(120),
    "response" JSONB NOT NULL DEFAULT '{}',
    "message" TEXT,
    "balance_reported" DECIMAL(14,2),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id" UUID,

    CONSTRAINT "scheme_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_cases" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "case_no" VARCHAR(40) NOT NULL,
    "scheme_id" UUID NOT NULL,
    "beneficiary_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "admission_id" UUID,
    "status" "billing"."SchemeCaseStatus" NOT NULL DEFAULT 'open',
    "authority_case_no" VARCHAR(64),
    "admitted_at" TIMESTAMPTZ(6),
    "discharged_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "package_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "claimed_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "settled_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "shortfall_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "scheme_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_case_packages" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "package_code" VARCHAR(40) NOT NULL,
    "package_name" VARCHAR(300) NOT NULL,
    "rate" DECIMAL(14,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "amount" DECIMAL(14,2) NOT NULL,
    "implant_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approval_ref" VARCHAR(64),
    "approved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "scheme_case_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_cash_attempts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "case_id" UUID,
    "collection_point" VARCHAR(32) NOT NULL,
    "mode" VARCHAR(24) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "outcome" VARCHAR(24) NOT NULL DEFAULT 'blocked',
    "reason" TEXT NOT NULL,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempted_by" UUID,

    CONSTRAINT "scheme_cash_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_claims" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "claim_no" VARCHAR(40) NOT NULL,
    "case_id" UUID NOT NULL,
    "format" "billing"."SchemeClaimFormat" NOT NULL,
    "status" "billing"."SchemeClaimStatus" NOT NULL DEFAULT 'draft',
    "claimed_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "approved_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "shortfall_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "window_closes_on" DATE,
    "submitted_at" TIMESTAMPTZ(6),
    "submitted_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "authority_claim_no" VARCHAR(64),
    "utr" VARCHAR(60),
    "remarks" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "scheme_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_claim_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "package_code" VARCHAR(40) NOT NULL,
    "description" VARCHAR(300) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "rate" DECIMAL(14,2) NOT NULL,
    "claimed_amount" DECIMAL(14,2) NOT NULL,
    "approved_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "disallowed_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "disallow_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheme_claim_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_claim_documents" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "doc_type" VARCHAR(40) NOT NULL,
    "file_id" UUID,
    "is_mandatory" BOOLEAN NOT NULL DEFAULT true,
    "uploaded_at" TIMESTAMPTZ(6),
    "uploaded_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheme_claim_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_shortfalls" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "category" VARCHAR(32) NOT NULL,
    "reason_code" VARCHAR(40) NOT NULL,
    "narrative" TEXT,
    "status" "billing"."SchemeShortfallStatus" NOT NULL DEFAULT 'open',
    "appeal_ref" VARCHAR(64),
    "appealed_at" TIMESTAMPTZ(6),
    "recovered_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "write_off_requested_by" UUID,
    "write_off_requested_at" TIMESTAMPTZ(6),
    "write_off_approved_by" UUID,
    "write_off_approved_at" TIMESTAMPTZ(6),
    "write_off_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "scheme_shortfalls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."scheme_reconciliations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "scheme_id" UUID NOT NULL,
    "batch_ref" VARCHAR(64) NOT NULL,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "total_claimed" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_paid" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_shortfall" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "claim_count" INTEGER NOT NULL DEFAULT 0,
    "file_id" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(24) NOT NULL DEFAULT 'received',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "scheme_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "scheme_masters_hospital_id_is_active_type_idx" ON "billing"."scheme_masters"("hospital_id", "is_active", "type");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_masters_hospital_id_code_key" ON "billing"."scheme_masters"("hospital_id", "code");

-- CreateIndex
CREATE INDEX "scheme_package_versions_hospital_id_scheme_id_status_idx" ON "billing"."scheme_package_versions"("hospital_id", "scheme_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_package_versions_scheme_id_version_no_key" ON "billing"."scheme_package_versions"("scheme_id", "version_no");

-- CreateIndex
CREATE INDEX "scheme_packages_hospital_id_package_code_idx" ON "billing"."scheme_packages"("hospital_id", "package_code");

-- CreateIndex
CREATE INDEX "scheme_packages_hospital_id_version_id_is_active_idx" ON "billing"."scheme_packages"("hospital_id", "version_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_packages_version_id_package_code_key" ON "billing"."scheme_packages"("version_id", "package_code");

-- CreateIndex
CREATE INDEX "scheme_beneficiaries_hospital_id_patient_id_status_idx" ON "billing"."scheme_beneficiaries"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "scheme_beneficiaries_hospital_id_scheme_id_member_id_idx" ON "billing"."scheme_beneficiaries"("hospital_id", "scheme_id", "member_id");

-- CreateIndex
CREATE INDEX "scheme_verifications_hospital_id_beneficiary_id_at_idx" ON "billing"."scheme_verifications"("hospital_id", "beneficiary_id", "at" DESC);

-- CreateIndex
CREATE INDEX "scheme_cases_hospital_id_patient_id_status_idx" ON "billing"."scheme_cases"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "scheme_cases_hospital_id_branch_id_status_created_at_idx" ON "billing"."scheme_cases"("hospital_id", "branch_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "scheme_cases_hospital_id_case_no_key" ON "billing"."scheme_cases"("hospital_id", "case_no");

-- CreateIndex
CREATE INDEX "scheme_case_packages_hospital_id_case_id_idx" ON "billing"."scheme_case_packages"("hospital_id", "case_id");

-- CreateIndex
CREATE INDEX "scheme_cash_attempts_hospital_id_patient_id_attempted_at_idx" ON "billing"."scheme_cash_attempts"("hospital_id", "patient_id", "attempted_at" DESC);

-- CreateIndex
CREATE INDEX "scheme_cash_attempts_hospital_id_scheme_id_attempted_at_idx" ON "billing"."scheme_cash_attempts"("hospital_id", "scheme_id", "attempted_at" DESC);

-- CreateIndex
CREATE INDEX "scheme_claims_hospital_id_status_created_at_idx" ON "billing"."scheme_claims"("hospital_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "scheme_claims_hospital_id_case_id_idx" ON "billing"."scheme_claims"("hospital_id", "case_id");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_claims_hospital_id_claim_no_key" ON "billing"."scheme_claims"("hospital_id", "claim_no");

-- CreateIndex
CREATE INDEX "scheme_claim_lines_hospital_id_claim_id_idx" ON "billing"."scheme_claim_lines"("hospital_id", "claim_id");

-- CreateIndex
CREATE INDEX "scheme_claim_documents_hospital_id_claim_id_idx" ON "billing"."scheme_claim_documents"("hospital_id", "claim_id");

-- CreateIndex
CREATE UNIQUE INDEX "scheme_claim_documents_claim_id_doc_type_key" ON "billing"."scheme_claim_documents"("claim_id", "doc_type");

-- CreateIndex
CREATE INDEX "scheme_shortfalls_hospital_id_status_created_at_idx" ON "billing"."scheme_shortfalls"("hospital_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "scheme_shortfalls_hospital_id_claim_id_idx" ON "billing"."scheme_shortfalls"("hospital_id", "claim_id");

-- CreateIndex
CREATE INDEX "scheme_reconciliations_hospital_id_status_received_at_idx" ON "billing"."scheme_reconciliations"("hospital_id", "status", "received_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "scheme_reconciliations_hospital_id_scheme_id_batch_ref_key" ON "billing"."scheme_reconciliations"("hospital_id", "scheme_id", "batch_ref");

-- AddForeignKey
ALTER TABLE "billing"."scheme_package_versions" ADD CONSTRAINT "scheme_package_versions_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "billing"."scheme_masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_packages" ADD CONSTRAINT "scheme_packages_version_id_fkey" FOREIGN KEY ("version_id") REFERENCES "billing"."scheme_package_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_beneficiaries" ADD CONSTRAINT "scheme_beneficiaries_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "billing"."scheme_masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_verifications" ADD CONSTRAINT "scheme_verifications_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "billing"."scheme_beneficiaries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_cases" ADD CONSTRAINT "scheme_cases_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "billing"."scheme_masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_cases" ADD CONSTRAINT "scheme_cases_beneficiary_id_fkey" FOREIGN KEY ("beneficiary_id") REFERENCES "billing"."scheme_beneficiaries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_case_packages" ADD CONSTRAINT "scheme_case_packages_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "billing"."scheme_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_claims" ADD CONSTRAINT "scheme_claims_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "billing"."scheme_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_claim_lines" ADD CONSTRAINT "scheme_claim_lines_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "billing"."scheme_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_claim_documents" ADD CONSTRAINT "scheme_claim_documents_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "billing"."scheme_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_shortfalls" ADD CONSTRAINT "scheme_shortfalls_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "billing"."scheme_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."scheme_reconciliations" ADD CONSTRAINT "scheme_reconciliations_scheme_id_fkey" FOREIGN KEY ("scheme_id") REFERENCES "billing"."scheme_masters"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



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
  WHERE n.nspname = 'billing' AND c.relname LIKE 'scheme\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'RC-007 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── B.1  NO CASH FROM A SCHEME BENEFICIARY ──────────────────────────────────
--
-- Exit gate 6. This is the whole module.
--
-- An empanelled hospital that takes ₹500 from an Ayushman cardholder for a
-- covered admission is in breach of its empanelment, and the patient — who was
-- told the treatment is free — has no way to know that. The families this
-- protects are the ones least able to challenge a receipt.
--
-- So the rule is enforced here rather than in a service. `billing.payment_lines`
-- is the one table every collection point in this system must write to: the cash
-- counter, the pharmacy window, an OPD advance, an IP deposit, a forex tender.
-- A module built in Phase 7 or Phase 9 that takes money and has never heard of
-- RC-007 is refused by Postgres.
--
-- SECURITY DEFINER on purpose. A non-definer function runs under the caller's
-- RLS, so a session whose branch scope excluded the row that records the
-- entitlement would see no beneficiary and be allowed to collect. A safety
-- control must not be evadable by narrowing your own visibility, so the lookup
-- runs as the owner and filters on `hospital_id` explicitly instead.
CREATE OR REPLACE FUNCTION "billing".refuse_scheme_cash_tender()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, billing
AS $$
DECLARE
  v_patient uuid;
  v_scheme  text;
BEGIN
  -- Physical tenders only. `advance_adjust`, `credit`, `patient_wallet` and the
  -- digital modes move no banknote, and they are how something genuinely outside
  -- the package is *meant* to be settled.
  IF NEW.mode NOT IN ('cash', 'forex') THEN
    RETURN NEW;
  END IF;

  SELECT p.patient_id INTO v_patient
    FROM billing.payments p
   WHERE p.id = NEW.payment_id AND p.paid_at = NEW.payment_paid_at;

  -- A tender with no patient behind it (a miscellaneous counter sale) cannot be
  -- a beneficiary's.
  IF v_patient IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT m.name INTO v_scheme
    FROM billing.scheme_beneficiaries b
    JOIN billing.scheme_masters m ON m.id = b.scheme_id
   WHERE b.patient_id  = v_patient
     AND b.hospital_id = NEW.hospital_id
     AND b.status      = 'verified'
     AND (b.valid_from IS NULL OR b.valid_from <= CURRENT_DATE)
     AND (b.valid_till IS NULL OR b.valid_till >= CURRENT_DATE)
     AND m.is_active
     AND (
       m.cash_block_scope = 'always'
       OR (m.cash_block_scope = 'active_case'
           AND EXISTS (
             SELECT 1 FROM billing.scheme_cases c
              WHERE c.beneficiary_id = b.id
                AND c.status NOT IN ('closed', 'rejected')))
     )
   LIMIT 1;

  IF v_scheme IS NOT NULL THEN
    -- No patient identifier in the message: this text reaches logs, and
    -- `docs/04` §3 keeps PHI out of them. The scheme is enough for the cashier
    -- to understand the refusal and for an auditor to trace it.
    RAISE EXCEPTION
      'RC-007: this patient is a verified % beneficiary. A scheme patient tenders no cash — record the charge against the scheme case instead.',
      v_scheme
      USING ERRCODE = 'RC007';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "payment_lines_scheme_cash_block"
  BEFORE INSERT OR UPDATE ON "billing"."payment_lines"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_scheme_cash_tender();

COMMENT ON FUNCTION "billing".refuse_scheme_cash_tender() IS
  'RC-007 exit gate 6. Every collection point writes billing.payment_lines, so the no-cash rule is enforced once, here, rather than repeated in every module that takes money and forgotten by one of them.';


-- ── B.2  the HBP rate list cannot have two published versions at once ───────
--
-- A claim is settled at the rate in force on the date of admission. Two
-- overlapping published versions means that date resolves to two rates, and the
-- difference shows up months later as a deduction nobody can explain.
ALTER TABLE "billing"."scheme_package_versions"
  ADD CONSTRAINT "scheme_versions_no_overlapping_published"
  EXCLUDE USING gist (
    "scheme_id" WITH =,
    daterange("effective_from", "effective_to", '[)') WITH &&
  ) WHERE (status = 'published');

ALTER TABLE "billing"."scheme_package_versions"
  ADD CONSTRAINT "scheme_version_dates_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");


-- ── B.3  a published rate list is immutable ─────────────────────────────────
--
-- Same reason as `mdm.tariff_versions`: editing a published rate silently
-- re-prices claims already submitted against it, and the resulting mismatch
-- looks like the authority short-paid us rather than like our own edit.
CREATE OR REPLACE FUNCTION "billing".refuse_published_scheme_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
  IF TG_TABLE_NAME = 'scheme_package_versions' THEN
    v_status := COALESCE(OLD.status::text, NEW.status::text);
    -- Publishing, and superseding what was published, are the two legal moves.
    IF TG_OP = 'UPDATE' AND OLD.status = 'published' AND NEW.status = 'superseded' THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'draft' THEN
      RETURN NEW;
    END IF;
  ELSE
    SELECT v.status::text INTO v_status
      FROM billing.scheme_package_versions v
     WHERE v.id = COALESCE(OLD.version_id, NEW.version_id);
  END IF;

  IF v_status = 'published' THEN
    RAISE EXCEPTION
      'A published scheme rate list is immutable (RC-007 §B.3). Supersede it with a new version instead of editing %.',
      TG_TABLE_NAME
      USING ERRCODE = 'RC007';
  END IF;

  RETURN COALESCE(NEW, OLD);
END $$;

CREATE TRIGGER "scheme_versions_immutable_when_published"
  BEFORE UPDATE OR DELETE ON "billing"."scheme_package_versions"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_published_scheme_edit();

CREATE TRIGGER "scheme_packages_immutable_when_published"
  BEFORE INSERT OR UPDATE OR DELETE ON "billing"."scheme_packages"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_published_scheme_edit();


-- ── B.4  one live entitlement per patient per scheme ────────────────────────
--
-- Two verified PMJAY rows for one patient means two family floaters, and the
-- second admission is claimed against a balance that was already spent.
CREATE UNIQUE INDEX "uq_scheme_beneficiary_live"
  ON "billing"."scheme_beneficiaries" ("hospital_id", "patient_id", "scheme_id")
  WHERE status IN ('unverified', 'verified');


-- ── B.5  "verified" is a claim about an event, so it needs the event ────────
--
-- A row that says verified with no timestamp and no method is somebody's
-- assumption. On the day the authority rejects the claim for ineligibility,
-- that is the difference between evidence and a shrug.
ALTER TABLE "billing"."scheme_beneficiaries"
  ADD CONSTRAINT "scheme_beneficiary_verified_has_proof"
  CHECK (status <> 'verified'
         OR ("verified_at" IS NOT NULL AND "verification_method" IS NOT NULL));

ALTER TABLE "billing"."scheme_beneficiaries"
  ADD CONSTRAINT "scheme_beneficiary_dates_ordered"
  CHECK ("valid_till" IS NULL OR "valid_from" IS NULL OR "valid_till" >= "valid_from");

-- The floater cannot go negative, and cannot exceed what was granted.
ALTER TABLE "billing"."scheme_beneficiaries"
  ADD CONSTRAINT "scheme_beneficiary_balance_within_entitlement"
  CHECK ("entitlement_balance" >= 0
         AND "entitlement_amount" >= 0
         AND "entitlement_balance" <= "entitlement_amount");


-- ── B.6  one open case per encounter per scheme ─────────────────────────────
CREATE UNIQUE INDEX "uq_scheme_case_open_per_encounter"
  ON "billing"."scheme_cases" ("hospital_id", "encounter_id", "scheme_id")
  WHERE "encounter_id" IS NOT NULL AND status NOT IN ('closed', 'rejected');

ALTER TABLE "billing"."scheme_cases"
  ADD CONSTRAINT "scheme_case_amounts_non_negative"
  CHECK ("package_amount" >= 0 AND "claimed_amount" >= 0
         AND "settled_amount" >= 0 AND "shortfall_amount" >= 0);

ALTER TABLE "billing"."scheme_cases"
  ADD CONSTRAINT "scheme_case_discharge_after_admission"
  CHECK ("discharged_at" IS NULL OR "admitted_at" IS NULL OR "discharged_at" >= "admitted_at");


-- ── B.7  the claimed line adds up, and the implant stays under its cap ──────
ALTER TABLE "billing"."scheme_case_packages"
  ADD CONSTRAINT "scheme_case_package_amount_is_rate_by_qty"
  CHECK ("quantity" > 0 AND "amount" = "rate" * "quantity");

ALTER TABLE "billing"."scheme_case_packages"
  ADD CONSTRAINT "scheme_case_package_implant_non_negative"
  CHECK ("implant_amount" >= 0);

-- One primary procedure per case. Two primaries is how a case gets claimed at
-- two full package rates when the scheme pays the second at 50 %.
CREATE UNIQUE INDEX "uq_scheme_case_one_primary"
  ON "billing"."scheme_case_packages" ("case_id")
  WHERE "is_primary";

CREATE OR REPLACE FUNCTION "billing".assert_scheme_implant_within_cap()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_allowed boolean; v_cap numeric(14,2);
BEGIN
  IF NEW.implant_amount = 0 THEN RETURN NEW; END IF;

  SELECT p.implant_allowed, p.implant_cap INTO v_allowed, v_cap
    FROM billing.scheme_packages p WHERE p.id = NEW.package_id;

  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION
      'Package % does not allow a separate implant claim (RC-007 §5.6).', NEW.package_code
      USING ERRCODE = 'RC007';
  END IF;

  IF v_cap IS NOT NULL AND NEW.implant_amount > v_cap THEN
    RAISE EXCEPTION
      'Implant claim % exceeds the % cap of % for package %.',
      NEW.implant_amount, 'scheme', v_cap, NEW.package_code
      USING ERRCODE = 'RC007';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "scheme_case_package_implant_cap"
  BEFORE INSERT OR UPDATE ON "billing"."scheme_case_packages"
  FOR EACH ROW EXECUTE FUNCTION "billing".assert_scheme_implant_within_cap();


-- ── B.8  a claim's arithmetic ───────────────────────────────────────────────
--
-- The authority never approves more than was claimed, and never pays more than
-- it approved. Once it has decided, the shortfall is the difference — stated as
-- a column rather than recomputed by each report, so two reports cannot disagree
-- about how much money is missing.
ALTER TABLE "billing"."scheme_claims"
  ADD CONSTRAINT "scheme_claim_amounts_non_negative"
  CHECK ("claimed_amount" >= 0 AND "approved_amount" >= 0
         AND "paid_amount" >= 0 AND "shortfall_amount" >= 0);

ALTER TABLE "billing"."scheme_claims"
  ADD CONSTRAINT "scheme_claim_approved_within_claimed"
  CHECK ("approved_amount" <= "claimed_amount");

ALTER TABLE "billing"."scheme_claims"
  ADD CONSTRAINT "scheme_claim_paid_within_approved"
  CHECK ("paid_amount" <= "approved_amount");

ALTER TABLE "billing"."scheme_claims"
  ADD CONSTRAINT "scheme_claim_shortfall_is_the_difference"
  CHECK (status NOT IN ('approved', 'partially_approved', 'rejected', 'paid', 'closed')
         OR "shortfall_amount" = "claimed_amount" - "approved_amount");

-- A submitted claim has a submission; a paid one has a payment date.
ALTER TABLE "billing"."scheme_claims"
  ADD CONSTRAINT "scheme_claim_submitted_has_timestamp"
  CHECK (status IN ('draft', 'assembled') OR "submitted_at" IS NOT NULL);

ALTER TABLE "billing"."scheme_claims"
  ADD CONSTRAINT "scheme_claim_paid_has_date"
  CHECK (status <> 'paid' OR ("paid_at" IS NOT NULL AND "paid_amount" > 0));


-- ── B.9  a claim line accounts for every rupee ──────────────────────────────
--
-- approved + disallowed = claimed, always. A line where they do not add up is a
-- rupee that has left the claim without anybody deciding it should.
ALTER TABLE "billing"."scheme_claim_lines"
  ADD CONSTRAINT "scheme_claim_line_claimed_is_rate_by_qty"
  CHECK ("quantity" > 0 AND "claimed_amount" = "rate" * "quantity");

ALTER TABLE "billing"."scheme_claim_lines"
  ADD CONSTRAINT "scheme_claim_line_balances"
  CHECK ("approved_amount" + "disallowed_amount" = "claimed_amount");

ALTER TABLE "billing"."scheme_claim_lines"
  ADD CONSTRAINT "scheme_claim_line_disallowance_has_a_reason"
  CHECK ("disallowed_amount" = 0 OR "disallow_reason" IS NOT NULL);


-- ── B.10  a claim does not leave draft with its checklist incomplete ────────
--
-- A PMJAY claim rejected for a missing discharge summary is thirty days of
-- working capital and a resubmission window that may already have closed. The
-- checklist is cheap to satisfy before submission and expensive afterwards.
CREATE OR REPLACE FUNCTION "billing".assert_scheme_claim_documents()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_missing text;
BEGIN
  IF NEW.status IN ('draft', 'assembled') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status NOT IN ('draft', 'assembled') THEN RETURN NEW; END IF;

  SELECT string_agg(d.doc_type, ', ' ORDER BY d.doc_type) INTO v_missing
    FROM billing.scheme_claim_documents d
   WHERE d.claim_id = NEW.id AND d.is_mandatory AND d.file_id IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'This claim cannot be submitted while a mandatory document is missing: %.', v_missing
      USING ERRCODE = 'RC007';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "scheme_claim_checklist_complete"
  BEFORE INSERT OR UPDATE ON "billing"."scheme_claims"
  FOR EACH ROW EXECUTE FUNCTION "billing".assert_scheme_claim_documents();


-- ── B.11  writing money off is maker-checker ────────────────────────────────
--
-- A shortfall written off is revenue the hospital has decided to stop chasing.
-- The person who worked the claim is exactly the person with a reason to make it
-- disappear quietly, so they cannot be the person who agrees it is gone.
ALTER TABLE "billing"."scheme_shortfalls"
  ADD CONSTRAINT "scheme_shortfall_maker_is_not_checker"
  CHECK ("write_off_approved_by" IS NULL
         OR "write_off_requested_by" IS NULL
         OR "write_off_approved_by" <> "write_off_requested_by");

ALTER TABLE "billing"."scheme_shortfalls"
  ADD CONSTRAINT "scheme_shortfall_written_off_is_complete"
  CHECK (status <> 'written_off'
         OR ("write_off_requested_by" IS NOT NULL
             AND "write_off_approved_by" IS NOT NULL
             AND "write_off_approved_at" IS NOT NULL
             AND "write_off_reason" IS NOT NULL));

ALTER TABLE "billing"."scheme_shortfalls"
  ADD CONSTRAINT "scheme_shortfall_recovery_within_amount"
  CHECK ("amount" > 0 AND "recovered_amount" >= 0 AND "recovered_amount" <= "amount");

ALTER TABLE "billing"."scheme_shortfalls"
  ADD CONSTRAINT "scheme_shortfall_appealed_has_ref"
  CHECK (status <> 'appealed' OR "appeal_ref" IS NOT NULL);


-- ── B.12  the refusal log and the verification log are append-only ──────────
--
-- "We do not take cash from scheme patients" is a policy. "We were asked eleven
-- times and refused eleven times, here they are" is a control. Only the second
-- survives an audit, and only if the rows cannot be tidied up afterwards.
CREATE OR REPLACE FUNCTION "billing".refuse_scheme_evidence_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only (RC-007 §B.12). It is the evidence that the control worked.',
    TG_TABLE_NAME
    USING ERRCODE = 'RC007';
END $$;

CREATE TRIGGER "scheme_cash_attempts_append_only"
  BEFORE UPDATE OR DELETE ON "billing"."scheme_cash_attempts"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_scheme_evidence_edit();

CREATE TRIGGER "scheme_verifications_append_only"
  BEFORE UPDATE OR DELETE ON "billing"."scheme_verifications"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_scheme_evidence_edit();


-- ── B.13  masters and reconciliation sanity ─────────────────────────────────
ALTER TABLE "billing"."scheme_masters"
  ADD CONSTRAINT "scheme_master_dates_ordered"
  CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from");

ALTER TABLE "billing"."scheme_masters"
  ADD CONSTRAINT "scheme_master_claim_window_positive"
  CHECK ("claim_window_days" > 0 AND "claim_window_days" <= 365);

ALTER TABLE "billing"."scheme_packages"
  ADD CONSTRAINT "scheme_package_rate_positive" CHECK ("base_rate" > 0);

ALTER TABLE "billing"."scheme_packages"
  ADD CONSTRAINT "scheme_package_implant_cap_needs_permission"
  CHECK ("implant_cap" IS NULL OR ("implant_allowed" AND "implant_cap" > 0));

ALTER TABLE "billing"."scheme_reconciliations"
  ADD CONSTRAINT "scheme_recon_period_ordered" CHECK ("period_to" >= "period_from");

ALTER TABLE "billing"."scheme_reconciliations"
  ADD CONSTRAINT "scheme_recon_totals_non_negative"
  CHECK ("total_claimed" >= 0 AND "total_paid" >= 0
         AND "total_shortfall" >= 0 AND "claim_count" >= 0);

ALTER TABLE "billing"."scheme_cash_attempts"
  ADD CONSTRAINT "scheme_cash_attempt_amount_positive" CHECK ("amount" > 0);


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
  RAISE NOTICE 'Granted application DML on % RC-007 table(s)', v_count;
END $$;

-- Belt to the trigger's braces: the evidence tables cannot be rewritten even if
-- a future migration drops a trigger by accident.
REVOKE UPDATE, DELETE ON "billing"."scheme_cash_attempts"  FROM hms_app;
REVOKE UPDATE, DELETE ON "billing"."scheme_verifications"  FROM hms_app;
REVOKE DELETE          ON "billing"."scheme_claims"        FROM hms_app;
REVOKE DELETE          ON "billing"."scheme_cases"         FROM hms_app;

-- The cash-block function is SECURITY DEFINER, so it must not be executable by
-- anyone who could redefine what it means to be blocked.
REVOKE ALL ON FUNCTION "billing".refuse_scheme_cash_tender() FROM PUBLIC;

COMMENT ON TABLE "billing"."scheme_cash_attempts" IS
  'Append-only. Every rupee the system refused to take from a scheme beneficiary. An NHA audit does not ask whether you take cash; it asks you to show what happened when someone tried.';

COMMENT ON TABLE "billing"."scheme_case_packages" IS
  'The HBP rate is copied here at selection, not joined. The master is revised mid-year and a claim settles at the rate in force on the day of admission; reading it live would re-price a submitted claim and make our own edit look like the authority short-paying us.';

COMMENT ON TABLE "billing"."scheme_verifications" IS
  'Append-only. When a claim is rejected for "beneficiary not eligible", this is the row that says the authority''s own portal told us otherwise on the day of admission, and what it said.';
