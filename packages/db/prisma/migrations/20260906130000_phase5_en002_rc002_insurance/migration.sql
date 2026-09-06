-- ─────────────────────────────────────────────────────────────────────────────
-- Vim's HMS — Phase 5, EN-002 + RC-002: insurance, TPA and pre-authorisation
--
-- `phase-05` §5.5. Fifteen tables in `billing`. Built as one migration because
-- RC-002's case header IS EN-002's `ins_cases` — splitting them would leave one
-- briefly referencing a table that does not exist.
--
--   §A  row-level security
--   §B  the constraints §5.5 depends on:
--         B.1  status history is APPEND-ONLY — a pre-auth trail that can be
--              rewritten is not evidence
--         B.2  an approval must carry an amount and a validity
--         B.3  a partial approval must be less than what was asked
--         B.4  one open case per payer per encounter
--         B.5  an enhancement must point at what it enhances
--         B.6  a replied query is closed, and a closed one was replied to
--   §C  grants; the trail and the transmissions are never deleted
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "billing"."InsPayerType" AS ENUM ('insurer', 'tpa', 'corporate', 'government_scheme', 'embassy', 'other');

-- CreateEnum
CREATE TYPE "billing"."InsNetworkType" AS ENUM ('cashless', 'reimbursement', 'ppn');

-- CreateEnum
CREATE TYPE "billing"."InsEmpanelmentStatus" AS ENUM ('active', 'expiring', 'expired', 'suspended', 'blacklisted');

-- CreateEnum
CREATE TYPE "billing"."InsCaseMode" AS ENUM ('cashless', 'reimbursement', 'corporate_credit', 'scheme');

-- CreateEnum
CREATE TYPE "billing"."InsCaseStatus" AS ENUM ('open', 'preauth_pending', 'preauth_approved', 'preauth_denied', 'in_treatment', 'claim_ready', 'claim_submitted', 'settled', 'closed');

-- CreateEnum
CREATE TYPE "billing"."PreauthStatus" AS ENUM ('draft', 'pending_signature', 'ready', 'submitted', 'query_raised', 'query_replied', 'approved', 'partially_approved', 'denied', 'cancelled', 'expired', 'withdrawn', 'final_authorised');

-- CreateEnum
CREATE TYPE "billing"."PreauthType" AS ENUM ('initial', 'enhancement', 'extension', 'final_authorisation', 'retrospective');

-- CreateEnum
CREATE TYPE "billing"."PreauthChannel" AS ENUM ('portal', 'email', 'api', 'nhcx', 'fax', 'courier');

-- CreateEnum
CREATE TYPE "billing"."PreauthTransmissionStatus" AS ENUM ('queued', 'sent', 'delivered', 'failed', 'acknowledged');

-- CreateEnum
CREATE TYPE "billing"."PreauthSlaStage" AS ENUM ('submit', 'decision', 'query_reply', 'final_auth');

-- CreateEnum
CREATE TYPE "billing"."PreauthEligibilityResult" AS ENUM ('eligible', 'not_eligible', 'inconclusive');

-- AlterTable
ALTER TABLE "queue"."queue_definitions" ALTER COLUMN "reset_time" SET DEFAULT '00:00:00'::time;

-- CreateTable
CREATE TABLE "billing"."ins_payers" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "payer_type" "billing"."InsPayerType" NOT NULL,
    "irdai_reg_no" VARCHAR(40),
    "gstin" VARCHAR(20),
    "pan" VARCHAR(20),
    "address" TEXT,
    "contacts" JSONB NOT NULL DEFAULT '{}',
    "portal_url" TEXT,
    "api_adapter_key" VARCHAR(48),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "ins_payers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."ins_tpas" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "irdai_tpa_licence" VARCHAR(40),
    "contacts" JSONB NOT NULL DEFAULT '{}',
    "portal_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ins_tpas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."ins_plans" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "product_uin" VARCHAR(40),
    "sum_insured_bands" JSONB NOT NULL DEFAULT '[]',
    "room_rent_cap_rule" VARCHAR(24),
    "icu_cap_rule" VARCHAR(24),
    "copay_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "deductible" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "waiting_periods" JSONB NOT NULL DEFAULT '{}',
    "exclusions" JSONB NOT NULL DEFAULT '[]',
    "network_type" "billing"."InsNetworkType" NOT NULL DEFAULT 'cashless',
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ins_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."ins_empanelments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "tpa_id" UUID,
    "contract_no" VARCHAR(64) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE NOT NULL,
    "hospital_code_at_payer" VARCHAR(64),
    "rohini_id" VARCHAR(40),
    "tariff_version_id" UUID,
    "discount_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "credit_days" INTEGER NOT NULL DEFAULT 45,
    "tds_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "contacts_matrix" JSONB NOT NULL DEFAULT '{}',
    "sla" JSONB NOT NULL DEFAULT '{}',
    "documents" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" "billing"."InsEmpanelmentStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "ins_empanelments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."ins_non_payable_items" (
    "id" UUID NOT NULL,
    "hospital_id" UUID,
    "list_name" VARCHAR(120) NOT NULL,
    "item_code" VARCHAR(64),
    "service_id" UUID,
    "category" VARCHAR(32) NOT NULL,
    "rule" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ins_non_payable_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."ins_patient_policies" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "tpa_id" UUID,
    "plan_id" UUID,
    "policy_no" VARCHAR(64) NOT NULL,
    "member_id" VARCHAR(64),
    "holder_name" VARCHAR(200),
    "relationship" VARCHAR(32),
    "sum_insured" DECIMAL(14,2),
    "valid_from" DATE,
    "valid_to" DATE,
    "corporate_id" UUID,
    "employee_id" VARCHAR(64),
    "card_file_id" UUID,
    "consent_id" UUID,
    "verified_status" VARCHAR(24),
    "verified_at" TIMESTAMPTZ(6),
    "verified_by" UUID,
    "verification_source" VARCHAR(32),
    "remaining_si" DECIMAL(14,2),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "ins_patient_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."ins_eligibility_checks" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "encounter_id" UUID,
    "channel" VARCHAR(16) NOT NULL DEFAULT 'manual',
    "request" JSONB NOT NULL DEFAULT '{}',
    "response" JSONB NOT NULL DEFAULT '{}',
    "result" "billing"."PreauthEligibilityResult" NOT NULL DEFAULT 'inconclusive',
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_by" UUID,

    CONSTRAINT "ins_eligibility_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."ins_cases" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "encounter_id" UUID,
    "admission_id" UUID,
    "patient_id" UUID NOT NULL,
    "policy_id" UUID,
    "payer_id" UUID NOT NULL,
    "tpa_id" UUID,
    "mode" "billing"."InsCaseMode" NOT NULL DEFAULT 'cashless',
    "status" "billing"."InsCaseStatus" NOT NULL DEFAULT 'open',
    "priority" SMALLINT NOT NULL DEFAULT 0,
    "sla_deadlines" JSONB NOT NULL DEFAULT '{}',
    "assigned_to" UUID,
    "estimate_id" UUID,
    "approved_amount_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "ins_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."preauth_requests" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "encounter_id" UUID,
    "patient_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "tpa_id" UUID,
    "policy_id" UUID,
    "scheme_id" UUID,
    "preauth_no" VARCHAR(40) NOT NULL,
    "type" "billing"."PreauthType" NOT NULL DEFAULT 'initial',
    "sequence_no" INTEGER NOT NULL DEFAULT 1,
    "parent_request_id" UUID,
    "status" "billing"."PreauthStatus" NOT NULL DEFAULT 'draft',
    "is_emergency" BOOLEAN NOT NULL DEFAULT false,
    "diagnosis_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "procedure_codes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "estimate_id" UUID,
    "requested_amount" DECIMAL(14,2) NOT NULL,
    "approved_amount" DECIMAL(14,2),
    "approved_amount_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "approved_room_class_id" UUID,
    "approved_los_days" INTEGER,
    "co_pay_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "deductible" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "valid_from" DATE,
    "valid_till" DATE,
    "payer_ref_no" VARCHAR(64),
    "channel" "billing"."PreauthChannel" NOT NULL DEFAULT 'portal',
    "submitted_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "submit_due_at" TIMESTAMPTZ(6),
    "decision_due_at" TIMESTAMPTZ(6),
    "sla_breached" BOOLEAN NOT NULL DEFAULT false,
    "denial_reason_code" VARCHAR(40),
    "doctor_id" UUID,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "signature_ref" VARCHAR(120),
    "form_file_id" UUID,
    "decision_letter_file_id" UUID,
    "consent_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "preauth_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."preauth_status_history" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "from_status" VARCHAR(32),
    "to_status" VARCHAR(32) NOT NULL,
    "actor_id" UUID,
    "actor_type" VARCHAR(16) NOT NULL DEFAULT 'staff',
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payer_ref" VARCHAR(64),
    "reason" TEXT,
    "document_file_id" UUID,
    "notes" TEXT,

    CONSTRAINT "preauth_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."preauth_queries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "query_no" INTEGER NOT NULL,
    "direction" VARCHAR(12) NOT NULL DEFAULT 'inbound',
    "category" VARCHAR(16) NOT NULL DEFAULT 'medical',
    "raised_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raised_by_payer_user" VARCHAR(120),
    "text" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "assigned_to" UUID,
    "assigned_role" VARCHAR(64),
    "sla_due_at" TIMESTAMPTZ(6),
    "replied_at" TIMESTAMPTZ(6),
    "reply_text" TEXT,
    "reply_attachments" JSONB NOT NULL DEFAULT '[]',
    "replied_by" UUID,
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "preauth_queries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."preauth_documents" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "doc_type" VARCHAR(40) NOT NULL,
    "file_id" UUID,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "received" BOOLEAN NOT NULL DEFAULT false,
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "uploaded_by" UUID,
    "source_module" VARCHAR(32),
    "page_count" INTEGER,
    "sha256" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "preauth_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."preauth_transmissions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "channel" "billing"."PreauthChannel" NOT NULL,
    "endpoint_ref" VARCHAR(200),
    "payload_file_id" UUID,
    "request_body" JSONB,
    "response_body" JSONB,
    "http_status" INTEGER,
    "nhcx_correlation_id" VARCHAR(120),
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "billing"."PreauthTransmissionStatus" NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "retry_at" TIMESTAMPTZ(6),

    CONSTRAINT "preauth_transmissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."preauth_sla_events" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "stage" "billing"."PreauthSlaStage" NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "breached_at" TIMESTAMPTZ(6),
    "escalation_level" SMALLINT NOT NULL DEFAULT 0,
    "escalated_to" UUID,
    "notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preauth_sla_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."preauth_credit_limits" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "admission_id" UUID,
    "approved_amount" DECIMAL(14,2) NOT NULL,
    "valid_till" DATE,
    "room_class_id" UUID,
    "propagated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,

    CONSTRAINT "preauth_credit_limits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ins_payers_hospital_id_payer_type_active_idx" ON "billing"."ins_payers"("hospital_id", "payer_type", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ins_payers_hospital_id_code_key" ON "billing"."ins_payers"("hospital_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ins_tpas_hospital_id_name_key" ON "billing"."ins_tpas"("hospital_id", "name");

-- CreateIndex
CREATE INDEX "ins_plans_hospital_id_payer_id_idx" ON "billing"."ins_plans"("hospital_id", "payer_id");

-- CreateIndex
CREATE UNIQUE INDEX "ins_plans_payer_id_name_effective_from_key" ON "billing"."ins_plans"("payer_id", "name", "effective_from");

-- CreateIndex
CREATE INDEX "ins_empanelments_hospital_id_status_valid_to_idx" ON "billing"."ins_empanelments"("hospital_id", "status", "valid_to");

-- CreateIndex
CREATE UNIQUE INDEX "ins_empanelments_hospital_id_branch_id_payer_id_tpa_id_cont_key" ON "billing"."ins_empanelments"("hospital_id", "branch_id", "payer_id", "tpa_id", "contract_no");

-- CreateIndex
CREATE INDEX "ins_non_payable_items_hospital_id_list_name_idx" ON "billing"."ins_non_payable_items"("hospital_id", "list_name");

-- CreateIndex
CREATE INDEX "ins_patient_policies_hospital_id_patient_id_idx" ON "billing"."ins_patient_policies"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "ins_patient_policies_hospital_id_policy_no_idx" ON "billing"."ins_patient_policies"("hospital_id", "policy_no");

-- CreateIndex
CREATE INDEX "ins_eligibility_checks_hospital_id_policy_id_checked_at_idx" ON "billing"."ins_eligibility_checks"("hospital_id", "policy_id", "checked_at" DESC);

-- CreateIndex
CREATE INDEX "ins_cases_hospital_id_status_idx" ON "billing"."ins_cases"("hospital_id", "status");

-- CreateIndex
CREATE INDEX "ins_cases_hospital_id_patient_id_idx" ON "billing"."ins_cases"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "ins_cases_hospital_id_encounter_id_idx" ON "billing"."ins_cases"("hospital_id", "encounter_id");

-- CreateIndex
CREATE INDEX "preauth_requests_hospital_id_status_submit_due_at_idx" ON "billing"."preauth_requests"("hospital_id", "status", "submit_due_at");

-- CreateIndex
CREATE INDEX "preauth_requests_hospital_id_case_id_idx" ON "billing"."preauth_requests"("hospital_id", "case_id");

-- CreateIndex
CREATE INDEX "preauth_requests_hospital_id_encounter_id_idx" ON "billing"."preauth_requests"("hospital_id", "encounter_id");

-- CreateIndex
CREATE UNIQUE INDEX "preauth_requests_hospital_id_preauth_no_key" ON "billing"."preauth_requests"("hospital_id", "preauth_no");

-- CreateIndex
CREATE INDEX "preauth_status_history_hospital_id_request_id_at_idx" ON "billing"."preauth_status_history"("hospital_id", "request_id", "at" DESC);

-- CreateIndex
CREATE INDEX "preauth_queries_hospital_id_is_open_sla_due_at_idx" ON "billing"."preauth_queries"("hospital_id", "is_open", "sla_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "preauth_queries_request_id_query_no_key" ON "billing"."preauth_queries"("request_id", "query_no");

-- CreateIndex
CREATE INDEX "preauth_documents_hospital_id_request_id_required_idx" ON "billing"."preauth_documents"("hospital_id", "request_id", "required");

-- CreateIndex
CREATE UNIQUE INDEX "preauth_documents_request_id_doc_type_key" ON "billing"."preauth_documents"("request_id", "doc_type");

-- CreateIndex
CREATE INDEX "preauth_transmissions_hospital_id_status_retry_at_idx" ON "billing"."preauth_transmissions"("hospital_id", "status", "retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "preauth_transmissions_request_id_attempt_no_key" ON "billing"."preauth_transmissions"("request_id", "attempt_no");

-- CreateIndex
CREATE INDEX "preauth_sla_events_hospital_id_due_at_idx" ON "billing"."preauth_sla_events"("hospital_id", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "preauth_sla_events_request_id_stage_key" ON "billing"."preauth_sla_events"("request_id", "stage");

-- CreateIndex
CREATE INDEX "preauth_credit_limits_hospital_id_request_id_propagated_at_idx" ON "billing"."preauth_credit_limits"("hospital_id", "request_id", "propagated_at" DESC);

-- CreateIndex
CREATE INDEX "preauth_credit_limits_hospital_id_admission_id_idx" ON "billing"."preauth_credit_limits"("hospital_id", "admission_id");

-- AddForeignKey
ALTER TABLE "billing"."ins_plans" ADD CONSTRAINT "ins_plans_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "billing"."ins_payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."ins_empanelments" ADD CONSTRAINT "ins_empanelments_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "billing"."ins_payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."ins_patient_policies" ADD CONSTRAINT "ins_patient_policies_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "billing"."ins_payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."ins_patient_policies" ADD CONSTRAINT "ins_patient_policies_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "billing"."ins_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."ins_cases" ADD CONSTRAINT "ins_cases_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "billing"."ins_payers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."ins_cases" ADD CONSTRAINT "ins_cases_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "billing"."ins_patient_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."preauth_requests" ADD CONSTRAINT "preauth_requests_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "billing"."ins_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."preauth_status_history" ADD CONSTRAINT "preauth_status_history_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "billing"."preauth_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."preauth_queries" ADD CONSTRAINT "preauth_queries_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "billing"."preauth_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."preauth_documents" ADD CONSTRAINT "preauth_documents_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "billing"."preauth_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."preauth_transmissions" ADD CONSTRAINT "preauth_transmissions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "billing"."preauth_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."preauth_sla_events" ADD CONSTRAINT "preauth_sla_events_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "billing"."preauth_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."preauth_credit_limits" ADD CONSTRAINT "preauth_credit_limits_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "billing"."preauth_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;



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
  WHERE n.nspname = 'billing' AND (c.relname LIKE 'ins\_%' OR c.relname LIKE 'preauth\_%')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'EN-002/RC-002 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── B.1  the status trail is APPEND-ONLY ────────────────────────────────────
--
-- A pre-auth history that can be edited is not evidence. When a payer disputes
-- what was submitted and when, this table is the hospital's answer, and an
-- answer that could have been rewritten last night answers nothing.
CREATE OR REPLACE FUNCTION "billing".refuse_preauth_history_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'preauth_status_history is append-only (RC-002 §4). Record a new transition instead of editing one.'
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER "preauth_history_append_only"
  BEFORE UPDATE OR DELETE ON "billing"."preauth_status_history"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_preauth_history_edit();

-- ── B.2  an approval carries an amount and a validity ───────────────────────
--
-- "Approved" with no amount is a status nobody can bill against, and an approval
-- with no expiry is one the payer will later say lapsed. RC-002 §5 makes both
-- mandatory at the moment of decision.
ALTER TABLE "billing"."preauth_requests"
  ADD CONSTRAINT "preauth_approved_has_amount_and_validity"
  CHECK (
    status NOT IN ('approved', 'partially_approved', 'final_authorised')
    OR ("approved_amount" IS NOT NULL AND "approved_amount" > 0 AND "valid_till" IS NOT NULL)
  );

-- A denial must say why. A refusal with no reason code cannot be appealed and
-- cannot be counted in the denial analysis RC-004 needs.
ALTER TABLE "billing"."preauth_requests"
  ADD CONSTRAINT "preauth_denial_has_reason"
  CHECK (status <> 'denied' OR "denial_reason_code" IS NOT NULL);

-- ── B.3  a partial approval is less than what was asked ─────────────────────
--
-- If the approved amount equals the request it is an approval, not a partial
-- one, and the distinction decides whether the patient owes a shortfall.
ALTER TABLE "billing"."preauth_requests"
  ADD CONSTRAINT "preauth_partial_is_actually_partial"
  CHECK (
    status <> 'partially_approved'
    OR ("approved_amount" IS NOT NULL AND "approved_amount" < "requested_amount")
  );

ALTER TABLE "billing"."preauth_requests"
  ADD CONSTRAINT "preauth_amounts_sane"
  CHECK (
    "requested_amount" > 0
    AND ("approved_amount" IS NULL OR "approved_amount" >= 0)
    AND ("approved_amount" IS NULL OR "approved_amount" <= "requested_amount")
  );

ALTER TABLE "billing"."preauth_requests"
  ADD CONSTRAINT "preauth_validity_ordered"
  CHECK ("valid_from" IS NULL OR "valid_till" IS NULL OR "valid_till" >= "valid_from");

-- ── B.4  one open case per payer per encounter ──────────────────────────────
--
-- Two open cases for one payer on one encounter means two claim packs for the
-- same money, and the second is rejected as a duplicate months later. A patient
-- with two *different* payers legitimately has two cases, which is why the payer
-- is in the key.
CREATE UNIQUE INDEX "uq_ins_case_open_per_payer_encounter"
  ON "billing"."ins_cases" ("hospital_id", "encounter_id", "payer_id")
  WHERE "encounter_id" IS NOT NULL AND status NOT IN ('closed', 'settled');

-- ── B.5  an enhancement points at what it enhances ──────────────────────────
--
-- Without it the approved total is a number somebody maintains by hand, and the
-- chain of enhancements on a long admission stops adding up.
ALTER TABLE "billing"."preauth_requests"
  ADD CONSTRAINT "preauth_enhancement_has_parent"
  CHECK (type NOT IN ('enhancement', 'extension') OR "parent_request_id" IS NOT NULL);

-- A request cannot be its own parent.
ALTER TABLE "billing"."preauth_requests"
  ADD CONSTRAINT "preauth_parent_is_not_self"
  CHECK ("parent_request_id" IS NULL OR "parent_request_id" <> "id");

-- ── B.6  a replied query is closed; a closed one was replied to ─────────────
--
-- An open query with a reply is a clock still running against work already done;
-- a closed query with no reply is a payer waiting for something nobody sent.
-- Both are how a cashless case quietly becomes a reimbursement one.
ALTER TABLE "billing"."preauth_queries"
  ADD CONSTRAINT "preauth_query_reply_matches_state"
  CHECK (("replied_at" IS NULL) = "is_open");

-- ── An empanelment cannot expire before it starts ───────────────────────────
ALTER TABLE "billing"."ins_empanelments"
  ADD CONSTRAINT "ins_empanelment_dates_ordered" CHECK ("valid_to" > "valid_from");

ALTER TABLE "billing"."ins_patient_policies"
  ADD CONSTRAINT "ins_policy_dates_ordered"
  CHECK ("valid_to" IS NULL OR "valid_from" IS NULL OR "valid_to" >= "valid_from");

-- A co-pay above 100 % is not a co-pay.
ALTER TABLE "billing"."ins_plans"
  ADD CONSTRAINT "ins_plan_copay_bounded" CHECK ("copay_pct" >= 0 AND "copay_pct" <= 100);
ALTER TABLE "billing"."preauth_requests"
  ADD CONSTRAINT "preauth_copay_bounded" CHECK ("co_pay_pct" >= 0 AND "co_pay_pct" <= 100);


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
  RAISE NOTICE 'Granted application DML on % EN-002/RC-002 table(s)', v_count;
END $$;

-- The trail and the transmissions are the hospital's evidence in a payer
-- dispute. The trigger above already refuses an UPDATE on the history; this is
-- the second line, and it covers DELETE on both.
REVOKE UPDATE, DELETE ON "billing"."preauth_status_history" FROM hms_app;
REVOKE DELETE ON "billing"."preauth_transmissions"          FROM hms_app;
REVOKE DELETE ON "billing"."preauth_requests"               FROM hms_app;
REVOKE DELETE ON "billing"."ins_cases"                      FROM hms_app;

COMMENT ON TABLE "billing"."preauth_status_history" IS
  'Append-only. When a payer disputes what was submitted and when, this is the hospital''s answer — and an answer that could have been rewritten answers nothing (RC-002 §4).';

COMMENT ON TABLE "billing"."preauth_transmissions" IS
  'Every attempt to reach the payer, including failures. A pre-auth that "was submitted" per a status column and never left the building is what this makes impossible to hide.';

COMMENT ON TABLE "billing"."preauth_credit_limits" IS
  'What billing was told and when it stopped being true. "The insurer approved it" is not actionable; a rupee amount, a room class and an expiry date are.';
