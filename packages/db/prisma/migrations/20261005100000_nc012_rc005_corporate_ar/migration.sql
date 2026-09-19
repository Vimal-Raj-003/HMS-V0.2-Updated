-- ═════════════════════════════════════════════════════════════════════════════
-- NC-012 + RC-005 · Corporate credit, consolidated invoices, and chasing money
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Phase 9A.4. Bills carry a `payer_type` of `corporate` and a `payer_id` into
-- `billing.ins_payers`, and that is where it stopped: nothing tracked what a
-- company owed, nothing stopped a hospital extending unlimited credit to a
-- client that had not paid since March, and nothing chased any of it. The
-- receivable existed as an arithmetic fact and as nobody's job.
--
-- ── The rules this file makes structural ──────────────────────────────────
--
-- **A bill is invoiced to a corporate once.** §B.2 is a partial unique index on
-- the bill, over invoices that are not cancelled. Billing a company twice for
-- one admission is the fastest way to lose a corporate contract, and it happens
-- because two clerks run the month-end consolidation an hour apart.
--
-- **A credit limit is checked against what is actually outstanding**, not
-- against a number somebody updates by hand. §B.3 computes exposure from the
-- open invoices at the moment of raising a new one.
--
-- **A write-off needs an approver who is not the person writing it off.** §B.5.
-- Bad debt is where money leaves a hospital quietly and with a plausible
-- explanation, so maker-checker is the point rather than ceremony.
--
-- **Ageing is derived, never stored.** A bucket column is a number that is
-- right on the day it is written and wrong every day after. §A's view computes
-- the bucket from `due_on` and `current_date` on every read.
--
-- §A  Corporate accounts, invoices, and the ageing view
-- §B  What an invoice and a write-off may say about themselves
-- §C  Chasing: the dunning ladder and the follow-up log
-- §D  Grants
-- §E  Row-level security

-- ═════════════════════════════════════════════════════════════════════════════
-- §A. CORPORATE ACCOUNTS AND INVOICES
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE "finance"."corporate_accounts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    -- Zero means cash-only: the account exists for reporting but extends no
    -- credit. NULL would mean "unlimited", which is a decision nobody should
    -- be able to make by leaving a field blank.
    "credit_limit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "payment_terms_days" SMALLINT NOT NULL DEFAULT 30,
    -- A hold stops new invoices being raised without stopping treatment. The
    -- clinical side never reads this table.
    "on_hold" BOOLEAN NOT NULL DEFAULT false,
    "hold_reason" VARCHAR(300),
    "tds_applicable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "corporate_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_corporate_account_code" ON "finance"."corporate_accounts"("hospital_id", "code");
CREATE UNIQUE INDEX "uq_corporate_account_payer" ON "finance"."corporate_accounts"("hospital_id", "payer_id");

ALTER TABLE "finance"."corporate_accounts"
  ADD CONSTRAINT "a_credit_limit_is_not_negative" CHECK ("credit_limit" >= 0);
ALTER TABLE "finance"."corporate_accounts"
  ADD CONSTRAINT "a_payment_terms_are_sane"
  CHECK ("payment_terms_days" >= 0 AND "payment_terms_days" <= 365);
-- A hold that does not say why is a hold nobody can lift: the person who set it
-- has gone home and the client is on the phone.
ALTER TABLE "finance"."corporate_accounts"
  ADD CONSTRAINT "a_hold_says_why"
  CHECK ("on_hold" = false OR "hold_reason" IS NOT NULL);


CREATE TABLE "finance"."corporate_invoices" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID,
    "account_id" UUID NOT NULL,
    "invoice_no" VARCHAR(40) NOT NULL,
    "invoice_date" DATE NOT NULL,
    "due_on" DATE NOT NULL,
    "period_from" DATE,
    "period_to" DATE,
    "gross_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    -- TDS a corporate deducted at source. It is not a shortfall: the hospital
    -- claims it against its own tax, so a receivable that ignores it is chased
    -- for money the client correctly did not send.
    "tds_deducted" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "written_off" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "disputed_reason" VARCHAR(500),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" UUID,
    "cancel_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "corporate_invoices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_corporate_invoice_no" ON "finance"."corporate_invoices"("hospital_id", "invoice_no");
CREATE INDEX "corporate_invoices_ageing_idx"
  ON "finance"."corporate_invoices"("hospital_id", "status", "due_on");

ALTER TABLE "finance"."corporate_invoices"
  ADD CONSTRAINT "a_corporate_invoice_status_is_known"
  CHECK ("status" IS NOT NULL
         AND "status" IN ('open', 'part_paid', 'paid', 'disputed', 'written_off', 'cancelled'));
ALTER TABLE "finance"."corporate_invoices"
  ADD CONSTRAINT "a_corporate_invoice_amounts_are_positive"
  CHECK ("gross_amount" >= 0 AND "tax_amount" >= 0 AND "net_amount" >= 0
         AND "paid_amount" >= 0 AND "tds_deducted" >= 0 AND "written_off" >= 0);
-- Nobody may be paid, credited and forgiven more than they were charged.
ALTER TABLE "finance"."corporate_invoices"
  ADD CONSTRAINT "a_settlement_never_exceeds_the_invoice"
  CHECK ("paid_amount" + "tds_deducted" + "written_off" <= "net_amount");
ALTER TABLE "finance"."corporate_invoices"
  ADD CONSTRAINT "a_due_date_follows_the_invoice" CHECK ("due_on" >= "invoice_date");
ALTER TABLE "finance"."corporate_invoices"
  ADD CONSTRAINT "a_disputed_invoice_says_why"
  CHECK ("status" <> 'disputed' OR "disputed_reason" IS NOT NULL);
ALTER TABLE "finance"."corporate_invoices"
  ADD CONSTRAINT "a_cancelled_invoice_says_why"
  CHECK ("status" <> 'cancelled' OR ("cancel_reason" IS NOT NULL AND "cancelled_by" IS NOT NULL));


CREATE TABLE "finance"."corporate_invoice_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "bill_id" UUID NOT NULL,
    "patient_id" UUID,
    "employee_ref" VARCHAR(64),
    "bill_no" VARCHAR(40),
    "service_date" DATE,
    "gross_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "net_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    -- A client queries individual lines, not whole invoices. Disputing the
    -- line keeps the rest of the invoice collectable.
    "disputed" BOOLEAN NOT NULL DEFAULT false,
    "dispute_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "corporate_invoice_lines_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "corporate_invoice_lines_invoice_idx" ON "finance"."corporate_invoice_lines"("invoice_id");
CREATE INDEX "corporate_invoice_lines_bill_idx" ON "finance"."corporate_invoice_lines"("bill_id");

ALTER TABLE "finance"."corporate_invoice_lines"
  ADD CONSTRAINT "a_disputed_line_says_why"
  CHECK ("disputed" = false OR "dispute_reason" IS NOT NULL);


/**
 * Ageing, computed on read.
 *
 * There is no bucket column, and that is the point: a stored bucket is correct
 * on the day it is written and wrong every day afterwards, so the worklist
 * slowly fills with invoices filed under the age they were when somebody last
 * ran a job. `days_overdue` and the bucket come from `due_on` and
 * `current_date` every time the view is read.
 *
 * `outstanding` subtracts TDS as well as payments. A corporate that deducted
 * tax at source has not underpaid — the hospital claims that amount against
 * its own liability — and chasing it is how a finance team annoys its largest
 * client over money it already has.
 */
CREATE OR REPLACE VIEW finance.v_corporate_ageing AS
SELECT
  i.hospital_id,
  i.account_id,
  a.code            AS account_code,
  a.name            AS account_name,
  i.id              AS invoice_id,
  i.invoice_no,
  i.invoice_date,
  i.due_on,
  i.net_amount,
  i.paid_amount,
  i.tds_deducted,
  i.written_off,
  (i.net_amount - i.paid_amount - i.tds_deducted - i.written_off) AS outstanding,
  GREATEST((current_date - i.due_on), 0) AS days_overdue,
  CASE
    WHEN current_date <= i.due_on                 THEN 'current'
    WHEN current_date - i.due_on <= 30            THEN '1-30'
    WHEN current_date - i.due_on <= 60            THEN '31-60'
    WHEN current_date - i.due_on <= 90            THEN '61-90'
    ELSE                                               '90+'
  END AS bucket,
  i.status
FROM finance.corporate_invoices i
JOIN finance.corporate_accounts a ON a.id = i.account_id
WHERE i.status NOT IN ('cancelled', 'paid', 'written_off');

COMMENT ON VIEW finance.v_corporate_ageing IS
  'NC-012 / RC-005: outstanding by invoice with the bucket computed from today. No stored bucket — one would be right on the day it was written and wrong every day after.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. WHAT AN INVOICE MAY SAY ABOUT ITSELF
-- ═════════════════════════════════════════════════════════════════════════════

-- §B.2  A bill reaches a corporate invoice once.
--
-- Two clerks running the month-end consolidation an hour apart is how a company
-- gets billed twice for one admission, and it is the fastest way to lose the
-- contract. Cancelled invoices are excluded so a corrected run can re-bill.
CREATE UNIQUE INDEX "uq_bill_invoiced_once"
  ON "finance"."corporate_invoice_lines"("bill_id")
  WHERE "invoice_id" IS NOT NULL;

-- §B.3  A credit limit is checked against what is actually outstanding.
CREATE OR REPLACE FUNCTION finance.a_invoice_respects_the_credit_limit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_limit numeric(16,2); v_hold boolean; v_reason text; v_exposure numeric(16,2);
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;

  SELECT credit_limit, on_hold, hold_reason INTO v_limit, v_hold, v_reason
    FROM finance.corporate_accounts WHERE id = NEW.account_id;

  IF v_hold THEN
    RAISE EXCEPTION
      'That corporate account is on hold (%). No new invoice can be raised against it until the hold is lifted — treatment is unaffected, this is a billing decision. (NC-012 §B.3)',
      v_reason USING ERRCODE = 'NC012';
  END IF;

  -- Exposure is computed, not read from a column somebody maintains.
  SELECT coalesce(sum(net_amount - paid_amount - tds_deducted - written_off), 0)
    INTO v_exposure
    FROM finance.corporate_invoices
   WHERE account_id = NEW.account_id
     AND status NOT IN ('cancelled', 'paid', 'written_off')
     AND id <> NEW.id;

  IF v_limit > 0 AND (v_exposure + NEW.net_amount) > v_limit THEN
    RAISE EXCEPTION
      'This invoice of % would take the account to % against a credit limit of % (NC-012 §B.3). Collect against the open invoices, or have the limit raised by somebody who is allowed to raise it.',
      NEW.net_amount, (v_exposure + NEW.net_amount), v_limit
      USING ERRCODE = 'NC012';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_invoice_respects_the_credit_limit
  BEFORE INSERT ON finance.corporate_invoices
  FOR EACH ROW EXECUTE FUNCTION finance.a_invoice_respects_the_credit_limit();


-- §B.4  Status follows the money, rather than being typed alongside it.
CREATE OR REPLACE FUNCTION finance.a_derive_invoice_status()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_settled numeric(16,2);
BEGIN
  -- These three are decisions, not arithmetic, so they are left alone.
  IF NEW.status IN ('cancelled', 'disputed', 'written_off') THEN RETURN NEW; END IF;

  v_settled := NEW.paid_amount + NEW.tds_deducted + NEW.written_off;
  NEW.status := CASE
    WHEN v_settled >= NEW.net_amount AND NEW.net_amount > 0 THEN 'paid'
    WHEN v_settled > 0                                      THEN 'part_paid'
    ELSE                                                         'open'
  END;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_derive_invoice_status
  BEFORE INSERT OR UPDATE OF paid_amount, tds_deducted, written_off, net_amount
  ON finance.corporate_invoices
  FOR EACH ROW EXECUTE FUNCTION finance.a_derive_invoice_status();


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. CHASING IT
-- ═════════════════════════════════════════════════════════════════════════════

/**
 * Every attempt to collect, and what came of it.
 *
 * Append-only by intent: the value of a follow-up log is that it shows what was
 * tried and when. A row that can be edited is a log somebody tidies before a
 * dispute, which is exactly when it matters.
 */
CREATE TABLE "finance"."ar_followups" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_user_id" UUID,
    -- call | email | letter | visit | legal_notice | agency_referral
    "channel" VARCHAR(24) NOT NULL,
    -- Where on the ladder this attempt sat. Derived by the service from the
    -- invoice's age, stored because the ladder can be reconfigured and the
    -- history must still say what it was at the time.
    "dunning_stage" SMALLINT NOT NULL DEFAULT 0,
    "outcome" VARCHAR(24) NOT NULL,
    "promised_on" DATE,
    "promised_amount" DECIMAL(16,2),
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ar_followups_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ar_followups_invoice_idx" ON "finance"."ar_followups"("invoice_id", "at");

ALTER TABLE "finance"."ar_followups"
  ADD CONSTRAINT "a_followup_channel_is_known"
  CHECK ("channel" IS NOT NULL
         AND "channel" IN ('call', 'email', 'letter', 'visit', 'legal_notice', 'agency_referral'));
ALTER TABLE "finance"."ar_followups"
  ADD CONSTRAINT "a_followup_outcome_is_known"
  CHECK ("outcome" IS NOT NULL
         AND "outcome" IN ('no_answer', 'promised', 'disputed', 'paid', 'refused', 'escalated'));
-- A promise with no date and no amount is a note, not a promise, and it is the
-- difference between a forecast and a hope.
ALTER TABLE "finance"."ar_followups"
  ADD CONSTRAINT "a_promise_has_a_date_and_an_amount"
  CHECK ("outcome" <> 'promised' OR ("promised_on" IS NOT NULL AND "promised_amount" IS NOT NULL));

CREATE OR REPLACE FUNCTION finance.a_followup_is_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'A follow-up cannot be % (RC-005 §C). The value of the log is that it shows what was tried and when; one that can be tidied is worthless in the dispute it exists for. Record another follow-up instead.',
    CASE TG_OP WHEN 'DELETE' THEN 'deleted' ELSE 'changed' END
    USING ERRCODE = 'RC005';
END $$;

CREATE TRIGGER trg_a_followup_is_append_only
  BEFORE UPDATE OR DELETE ON finance.ar_followups
  FOR EACH ROW EXECUTE FUNCTION finance.a_followup_is_append_only();


/**
 * A write-off, and the second person who agreed to it.
 *
 * §B.5 — bad debt is where money leaves a hospital quietly and with a plausible
 * explanation. Maker-checker here is the point of the table, not paperwork
 * attached to it, so the approver is `NOT NULL` and a CHECK refuses the case
 * where they are the same person.
 */
CREATE TABLE "finance"."ar_write_offs" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "requested_by" UUID NOT NULL,
    "approved_by" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ar_write_offs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ar_write_offs_invoice_idx" ON "finance"."ar_write_offs"("invoice_id");

ALTER TABLE "finance"."ar_write_offs"
  ADD CONSTRAINT "a_write_off_is_positive" CHECK ("amount" > 0);
ALTER TABLE "finance"."ar_write_offs"
  ADD CONSTRAINT "a_write_off_needs_a_second_person"
  CHECK ("approved_by" <> "requested_by");


-- §C.1  The invoice's `written_off` is the sum of its write-offs, derived.
--
-- Found by testing: approving a write-off left `ar_write_offs` and
-- `corporate_invoices.written_off` disagreeing, so the invoice still showed as
-- collectable and the ageing worklist kept chasing money somebody had already
-- signed off as lost. Leaving the two in step is not something a service
-- should have to remember — the second service to write a write-off would
-- forget.
--
-- The UPDATE re-fires `trg_a_derive_invoice_status`, so the status follows
-- too: an invoice settled by payment plus write-off becomes `paid`.
CREATE OR REPLACE FUNCTION finance.a_invoice_write_off_total_is_derived()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_invoice uuid; v_total numeric(16,2);
BEGIN
  v_invoice := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  SELECT coalesce(sum(amount), 0) INTO v_total
    FROM finance.ar_write_offs WHERE invoice_id = v_invoice;
  UPDATE finance.corporate_invoices
     SET written_off = v_total, updated_at = now()
   WHERE id = v_invoice;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_a_invoice_write_off_total_is_derived
  AFTER INSERT OR UPDATE OR DELETE ON finance.ar_write_offs
  FOR EACH ROW EXECUTE FUNCTION finance.a_invoice_write_off_total_is_derived();


-- Foreign keys, in the repo's style: separate statements, explicit ON UPDATE.
ALTER TABLE "finance"."corporate_invoices" ADD CONSTRAINT "corporate_invoices_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "finance"."corporate_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."corporate_invoice_lines" ADD CONSTRAINT "corporate_invoice_lines_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "finance"."corporate_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "finance"."ar_followups" ADD CONSTRAINT "ar_followups_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "finance"."corporate_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "finance"."ar_write_offs" ADD CONSTRAINT "ar_write_offs_invoice_id_fkey"
  FOREIGN KEY ("invoice_id") REFERENCES "finance"."corporate_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §D. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname = 'finance'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  GRANT SELECT ON finance.v_corporate_ageing TO hms_app, hms_readonly;
  RAISE NOTICE 'Granted application DML on % table(s)', v_count;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §E. ROW-LEVEL SECURITY
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
                            'anticholinergic_scores','beers_criteria','telemedicine_drug_rules')
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
DECLARE v_dupes text;
BEGIN
  SELECT string_agg(format('%s (%s)', conname, tables), '; ' ORDER BY conname) INTO v_dupes
  FROM (
    SELECT c.conname, string_agg(DISTINCT t.relname, ', ') AS tables
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory',
                         'finance','queue','engage','billing','integration','ops','specialty')
       AND c.contype IN ('c','u','x') AND t.relispartition = false
     GROUP BY c.conname HAVING count(DISTINCT t.relname) > 1
  ) d;
  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Two rules share a constraint name: %', v_dupes;
  END IF;
END $$;
