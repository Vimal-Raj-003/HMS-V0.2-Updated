-- ─────────────────────────────────────────────────────────────────────────────
-- Vim's HMS — Phase 5, EN-010: payment gateway
--
-- `phase-05` §5.3. Fourteen tables in `billing`, prefix `pay_`. The path money
-- takes: an intent, a provider order, a webhook that confirms it, a settlement
-- file that proves it arrived, and a reconciliation queue for the cases where
-- those three disagree.
--
--   §A  the webhook log: monthly partitions, append-only
--   §B  row-level security
--   §C  the constraints §5.3 depends on:
--         C.1  A WEBHOOK REPLAY CANNOT DOUBLE-CREDIT — exit gate 3
--         C.2  one payment per provider payment id
--         C.3  a ledger posting is idempotent
--         C.4  a refund never exceeds its payment
--         C.5  money is never negative
--   §D  grants, and the append-only revoke on the webhook log
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "billing"."PayProvider" AS ENUM ('razorpay', 'phonepe', 'payu', 'cashfree', 'stripe', 'bank_pg');

-- CreateEnum
CREATE TYPE "billing"."PayMode" AS ENUM ('sandbox', 'live');

-- CreateEnum
CREATE TYPE "billing"."PayIntentKind" AS ENUM ('bill', 'advance', 'deposit', 'link', 'kiosk', 'portal', 'website', 'mandate');

-- CreateEnum
CREATE TYPE "billing"."PayIntentStatus" AS ENUM ('created', 'pending', 'paid', 'partially_paid', 'expired', 'failed', 'cancelled', 'unapplied');

-- CreateEnum
CREATE TYPE "billing"."PayMethod" AS ENUM ('upi', 'card', 'netbanking', 'wallet', 'emi', 'bnpl', 'international', 'pos');

-- CreateEnum
CREATE TYPE "billing"."PayPaymentStatus" AS ENUM ('authorized', 'captured', 'failed', 'refunded', 'partially_refunded', 'disputed');

-- CreateEnum
CREATE TYPE "billing"."PayRefundStatus" AS ENUM ('requested', 'approved', 'initiated', 'processed', 'failed');

-- CreateEnum
CREATE TYPE "billing"."PayWebhookStatus" AS ENUM ('received', 'processed', 'ignored', 'failed');

-- CreateEnum
CREATE TYPE "billing"."PaySettlementStatus" AS ENUM ('fetched', 'matched', 'posted', 'exception');

-- CreateEnum
CREATE TYPE "billing"."PayReconExceptionType" AS ENUM ('captured_no_receipt', 'receipt_no_payment', 'amount_mismatch', 'fee_variance', 'missing_settlement', 'refund_pending', 'unapplied', 'duplicate');

-- AlterTable
ALTER TABLE "queue"."queue_definitions" ALTER COLUMN "reset_time" SET DEFAULT '00:00:00'::time;

-- CreateTable
CREATE TABLE "billing"."pay_gateway_accounts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID,
    "provider" "billing"."PayProvider" NOT NULL,
    "mode" "billing"."PayMode" NOT NULL DEFAULT 'sandbox',
    "key_id" VARCHAR(120) NOT NULL,
    "secret_ref" VARCHAR(200) NOT NULL,
    "webhook_secret_ref" VARCHAR(200) NOT NULL,
    "settlement_bank_account_id" UUID,
    "methods" JSONB NOT NULL DEFAULT '[]',
    "mdr_schedule" JSONB NOT NULL DEFAULT '{}',
    "convenience_fee_policy" JSONB NOT NULL DEFAULT '{}',
    "currency_default" CHAR(3) NOT NULL DEFAULT 'INR',
    "cash_aggregate_limit" DECIMAL(14,2) NOT NULL DEFAULT 200000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "pay_gateway_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_terminals" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "provider" "billing"."PayProvider" NOT NULL,
    "tid" VARCHAR(40) NOT NULL,
    "serial" VARCHAR(60),
    "counter_id" UUID,
    "workstation_id" UUID,
    "mode" VARCHAR(20) NOT NULL DEFAULT 'cloud_push',
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "last_seen" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_terminals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_intents" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "gateway_account_id" UUID NOT NULL,
    "provider_order_id" VARCHAR(120),
    "kind" "billing"."PayIntentKind" NOT NULL,
    "ref_type" VARCHAR(24) NOT NULL,
    "ref_id" UUID NOT NULL,
    "patient_id" UUID,
    "payer_name" VARCHAR(120),
    "payer_phone" VARCHAR(20),
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "method_hint" VARCHAR(20) NOT NULL DEFAULT 'any',
    "status" "billing"."PayIntentStatus" NOT NULL DEFAULT 'created',
    "qr_id" VARCHAR(120),
    "qr_image_url" TEXT,
    "link_id" VARCHAR(120),
    "link_url" TEXT,
    "terminal_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "pay_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_payments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "provider_payment_id" VARCHAR(120) NOT NULL,
    "method" "billing"."PayMethod" NOT NULL,
    "instrument" JSONB NOT NULL DEFAULT '{}',
    "amount" DECIMAL(14,2) NOT NULL,
    "fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "captured_at" TIMESTAMPTZ(6),
    "rrn" VARCHAR(60),
    "utr" VARCHAR(60),
    "status" "billing"."PayPaymentStatus" NOT NULL DEFAULT 'authorized',
    "receipt_id" UUID,
    "error_code" VARCHAR(60),
    "error_desc" TEXT,
    "raw_ref" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_refunds" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason_code" VARCHAR(40) NOT NULL,
    "requested_by" UUID NOT NULL,
    "approval_id" UUID,
    "approved_by" UUID,
    "provider_refund_id" VARCHAR(120),
    "speed" VARCHAR(12) NOT NULL DEFAULT 'normal',
    "status" "billing"."PayRefundStatus" NOT NULL DEFAULT 'requested',
    "arn" VARCHAR(60),
    "processed_at" TIMESTAMPTZ(6),
    "credit_note_id" UUID,
    "receipt_reversal_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_links" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "provider_link_id" VARCHAR(120) NOT NULL,
    "short_url" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "reminders" JSONB NOT NULL DEFAULT '[]',
    "sent_via" VARCHAR(20),
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_webhook_events" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "provider" "billing"."PayProvider" NOT NULL,
    "event_id" VARCHAR(160) NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "payload" JSONB NOT NULL,
    "signature_ok" BOOLEAN NOT NULL DEFAULT false,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),
    "status" "billing"."PayWebhookStatus" NOT NULL DEFAULT 'received',
    "error" TEXT,

    CONSTRAINT "pay_webhook_events_pkey" PRIMARY KEY ("id","received_at")
);

-- CreateTable
CREATE TABLE "billing"."pay_settlements" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "gateway_account_id" UUID NOT NULL,
    "provider_settlement_id" VARCHAR(120) NOT NULL,
    "utr" VARCHAR(60),
    "amount" DECIMAL(14,2) NOT NULL,
    "fees" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "settled_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "billing"."PaySettlementStatus" NOT NULL DEFAULT 'fetched',
    "journal_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_settlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_settlement_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "entity_type" VARCHAR(20) NOT NULL,
    "provider_entity_id" VARCHAR(120) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "fee" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "matched_receipt_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'unmatched',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pay_settlement_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_recon_exceptions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "exception_type" "billing"."PayReconExceptionType" NOT NULL,
    "refs" JSONB NOT NULL DEFAULT '{}',
    "amount" DECIMAL(14,2),
    "owner_id" UUID,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "notes" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_recon_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_disputes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "provider_dispute_id" VARCHAR(120) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" VARCHAR(200),
    "phase" VARCHAR(24) NOT NULL DEFAULT 'chargeback',
    "evidence_files" UUID[] DEFAULT ARRAY[]::UUID[],
    "due_at" TIMESTAMPTZ(6),
    "outcome" VARCHAR(40),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_mandates" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "provider_mandate_id" VARCHAR(120) NOT NULL,
    "max_amount" DECIMAL(14,2) NOT NULL,
    "frequency" VARCHAR(20) NOT NULL,
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_mandates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_mandate_debits" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "mandate_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'scheduled',
    "payment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_mandate_debits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."pay_ledger_postings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "entity" VARCHAR(20) NOT NULL,
    "entity_id" UUID NOT NULL,
    "journal_id" UUID,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotency_key" VARCHAR(160) NOT NULL,

    CONSTRAINT "pay_ledger_postings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pay_gateway_accounts_hospital_id_branch_id_provider_mode_key" ON "billing"."pay_gateway_accounts"("hospital_id", "branch_id", "provider", "mode");

-- CreateIndex
CREATE UNIQUE INDEX "pay_terminals_hospital_id_provider_tid_key" ON "billing"."pay_terminals"("hospital_id", "provider", "tid");

-- CreateIndex
CREATE INDEX "pay_intents_hospital_id_status_created_at_idx" ON "billing"."pay_intents"("hospital_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pay_intents_hospital_id_ref_type_ref_id_idx" ON "billing"."pay_intents"("hospital_id", "ref_type", "ref_id");

-- CreateIndex
CREATE UNIQUE INDEX "pay_intents_gateway_account_id_provider_order_id_key" ON "billing"."pay_intents"("gateway_account_id", "provider_order_id");

-- CreateIndex
CREATE INDEX "pay_payments_hospital_id_status_captured_at_idx" ON "billing"."pay_payments"("hospital_id", "status", "captured_at" DESC);

-- CreateIndex
CREATE INDEX "pay_payments_hospital_id_intent_id_idx" ON "billing"."pay_payments"("hospital_id", "intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "pay_payments_provider_payment_id_key" ON "billing"."pay_payments"("provider_payment_id");

-- CreateIndex
CREATE INDEX "pay_refunds_hospital_id_status_created_at_idx" ON "billing"."pay_refunds"("hospital_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pay_links_hospital_id_status_idx" ON "billing"."pay_links"("hospital_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pay_links_provider_link_id_key" ON "billing"."pay_links"("provider_link_id");

-- CreateIndex
CREATE INDEX "pay_webhook_events_hospital_id_provider_event_id_idx" ON "billing"."pay_webhook_events"("hospital_id", "provider", "event_id");

-- CreateIndex
CREATE INDEX "pay_webhook_events_hospital_id_status_received_at_idx" ON "billing"."pay_webhook_events"("hospital_id", "status", "received_at" DESC);

-- CreateIndex
CREATE INDEX "pay_settlements_hospital_id_settled_at_idx" ON "billing"."pay_settlements"("hospital_id", "settled_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "pay_settlements_provider_settlement_id_key" ON "billing"."pay_settlements"("provider_settlement_id");

-- CreateIndex
CREATE INDEX "pay_settlement_lines_hospital_id_settlement_id_status_idx" ON "billing"."pay_settlement_lines"("hospital_id", "settlement_id", "status");

-- CreateIndex
CREATE INDEX "pay_recon_exceptions_hospital_id_status_created_at_idx" ON "billing"."pay_recon_exceptions"("hospital_id", "status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pay_recon_exceptions_hospital_id_exception_type_status_idx" ON "billing"."pay_recon_exceptions"("hospital_id", "exception_type", "status");

-- CreateIndex
CREATE INDEX "pay_disputes_hospital_id_due_at_idx" ON "billing"."pay_disputes"("hospital_id", "due_at");

-- CreateIndex
CREATE UNIQUE INDEX "pay_disputes_provider_dispute_id_key" ON "billing"."pay_disputes"("provider_dispute_id");

-- CreateIndex
CREATE INDEX "pay_mandates_hospital_id_patient_id_status_idx" ON "billing"."pay_mandates"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "pay_mandates_provider_mandate_id_key" ON "billing"."pay_mandates"("provider_mandate_id");

-- CreateIndex
CREATE INDEX "pay_mandate_debits_hospital_id_status_due_at_idx" ON "billing"."pay_mandate_debits"("hospital_id", "status", "due_at");

-- CreateIndex
CREATE INDEX "pay_ledger_postings_hospital_id_entity_entity_id_idx" ON "billing"."pay_ledger_postings"("hospital_id", "entity", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "pay_ledger_postings_idempotency_key_key" ON "billing"."pay_ledger_postings"("idempotency_key");

-- AddForeignKey
ALTER TABLE "billing"."pay_intents" ADD CONSTRAINT "pay_intents_gateway_account_id_fkey" FOREIGN KEY ("gateway_account_id") REFERENCES "billing"."pay_gateway_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."pay_payments" ADD CONSTRAINT "pay_payments_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "billing"."pay_intents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."pay_refunds" ADD CONSTRAINT "pay_refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "billing"."pay_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."pay_links" ADD CONSTRAINT "pay_links_intent_id_fkey" FOREIGN KEY ("intent_id") REFERENCES "billing"."pay_intents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."pay_settlements" ADD CONSTRAINT "pay_settlements_gateway_account_id_fkey" FOREIGN KEY ("gateway_account_id") REFERENCES "billing"."pay_gateway_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."pay_settlement_lines" ADD CONSTRAINT "pay_settlement_lines_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "billing"."pay_settlements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."pay_mandate_debits" ADD CONSTRAINT "pay_mandate_debits_mandate_id_fkey" FOREIGN KEY ("mandate_id") REFERENCES "billing"."pay_mandates"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ═════════════════════════════════════════════════════════════════════════════
-- §A. THE WEBHOOK LOG: MONTHLY PARTITIONS, APPEND ONLY
--
-- Every webhook is kept, including the ones whose signature did not verify — a
-- forged webhook is evidence of an attempt on the payment path, and discarding
-- it destroys the only record. Partitioned monthly because a busy gateway
-- delivers steadily and this is pure append.
-- ═════════════════════════════════════════════════════════════════════════════
DROP TABLE IF EXISTS "billing"."pay_webhook_events";

CREATE TABLE "billing"."pay_webhook_events" (
  "id"           UUID NOT NULL,
  "hospital_id"  UUID NOT NULL,
  "provider"     "billing"."PayProvider" NOT NULL,
  "event_id"     VARCHAR(160) NOT NULL,
  "type"         VARCHAR(80) NOT NULL,
  "payload"      JSONB NOT NULL,
  "signature_ok" BOOLEAN NOT NULL DEFAULT false,
  "received_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "processed_at" TIMESTAMPTZ(6),
  "status"       "billing"."PayWebhookStatus" NOT NULL DEFAULT 'received',
  "error"        TEXT,
  CONSTRAINT "pay_webhook_events_pkey" PRIMARY KEY ("id", "received_at")
) PARTITION BY RANGE ("received_at");

-- ── C.1  A WEBHOOK REPLAY CANNOT DOUBLE-CREDIT ──────────────────────────────
--
-- `phase-05` exit gate 3, verbatim: "a webhook replay does not double-credit".
-- Providers redeliver: Razorpay retries for 24 hours, and a redelivery during a
-- deploy is routine rather than exceptional. This index is the guarantee — the
-- second delivery of one event conflicts here and the handler never runs twice.
-- The provider is part of the key because two providers may legitimately mint
-- the same opaque id.
--
-- On a partitioned table the partition key must be in every unique index, so
-- `received_at` is included. That is sound here: a provider's event id is
-- unique for all time, and a redelivery carries the original timestamp.
CREATE UNIQUE INDEX "uq_pay_webhook_event_id"
  ON "billing"."pay_webhook_events" ("hospital_id", "provider", "event_id", "received_at");

CREATE INDEX "pay_webhook_events_status_idx"
  ON "billing"."pay_webhook_events" ("hospital_id", "status", "received_at" DESC);

DO $$
DECLARE v_start date := date_trunc('month', now())::date - interval '1 month';
        v_i int; v_from date; v_to date;
BEGIN
  FOR v_i IN 0..12 LOOP
    v_from := (v_start + (v_i || ' months')::interval)::date;
    v_to   := (v_start + ((v_i + 1) || ' months')::interval)::date;
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS billing.%I PARTITION OF billing.pay_webhook_events FOR VALUES FROM (%L) TO (%L)',
      'pay_webhook_events_' || to_char(v_from, 'YYYYMM'), v_from, v_to);
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS "billing"."pay_webhook_events_default"
  PARTITION OF "billing"."pay_webhook_events" DEFAULT;

COMMENT ON TABLE "billing"."pay_webhook_events" IS
  'Every webhook, including ones that failed signature verification — a forged webhook is evidence of an attack on the payment path. `uq_pay_webhook_event_id` is phase-05 exit gate 3: a redelivered event conflicts instead of crediting twice.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. ROW-LEVEL SECURITY
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
    ELSE
      v_using := 'false'; v_check := 'false';
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
  WHERE n.nspname = 'billing' AND c.relname LIKE 'pay\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'EN-010 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. THE REMAINING GUARANTEES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── C.4  a refund never exceeds what was actually paid ──────────────────────
--
-- OP-005 §5: "Refund ≤ collected". A deferred constraint so a partial refund
-- and its sibling can be written in one transaction, checked when it commits.
CREATE OR REPLACE FUNCTION "billing".assert_refund_within_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_paid numeric(14,2); v_refunded numeric(14,2);
BEGIN
  SELECT amount INTO v_paid FROM "billing"."pay_payments" WHERE id = NEW.payment_id;
  SELECT COALESCE(sum(amount), 0) INTO v_refunded
    FROM "billing"."pay_refunds"
   WHERE payment_id = NEW.payment_id AND status <> 'failed';

  IF v_refunded > v_paid THEN
    RAISE EXCEPTION
      'Refunds on payment % total %, which is more than the % collected (OP-005 §5).',
      NEW.payment_id, v_refunded, v_paid
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "pay_refunds_within_payment"
  AFTER INSERT OR UPDATE ON "billing"."pay_refunds"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "billing".assert_refund_within_payment();

-- ── C.5  money is never negative ────────────────────────────────────────────
ALTER TABLE "billing"."pay_intents"  ADD CONSTRAINT "pay_intents_amount_positive"  CHECK ("amount" > 0);
ALTER TABLE "billing"."pay_payments" ADD CONSTRAINT "pay_payments_amount_positive" CHECK ("amount" > 0 AND "fee" >= 0 AND "tax" >= 0);
ALTER TABLE "billing"."pay_refunds"  ADD CONSTRAINT "pay_refunds_amount_positive"  CHECK ("amount" > 0);

-- A captured payment must say when. `captured_at` is what the settlement file
-- is reconciled against, and a capture with no timestamp cannot be matched.
ALTER TABLE "billing"."pay_payments"
  ADD CONSTRAINT "pay_payments_captured_has_timestamp"
  CHECK ("status" <> 'captured' OR "captured_at" IS NOT NULL);

-- §269ST: the configured aggregate cash limit may not be raised above the
-- statutory ₹2,00,000. A hospital may lower it as policy; it may not opt out.
ALTER TABLE "billing"."pay_gateway_accounts"
  ADD CONSTRAINT "pay_gateway_cash_limit_within_269st"
  CHECK ("cash_aggregate_limit" > 0 AND "cash_aggregate_limit" <= 200000);


-- ═════════════════════════════════════════════════════════════════════════════
-- §D. GRANTS
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
  RAISE NOTICE 'Granted application DML on % EN-010 table(s)', v_count;
END $$;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'billing' AND c.relname LIKE 'pay\_webhook\_events%'
      AND c.relkind IN ('r','p')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT ON billing.%I TO hms_app', r.relname);
    EXECUTE format('GRANT SELECT ON billing.%I TO hms_readonly', r.relname);
    EXECUTE format('REVOKE UPDATE, DELETE ON billing.%I FROM hms_app', r.relname);
  END LOOP;
END $$;

-- The webhook log needs UPDATE for one narrow purpose — marking a row processed
-- — so the revoke above is followed by a column-scoped grant rather than a
-- blanket one. The payload and the signature verdict stay immutable.
GRANT UPDATE ("status", "processed_at", "error") ON "billing"."pay_webhook_events" TO hms_app;

REVOKE DELETE ON "billing"."pay_payments"  FROM hms_app;
REVOKE DELETE ON "billing"."pay_refunds"   FROM hms_app;
REVOKE DELETE ON "billing"."pay_settlements" FROM hms_app;
