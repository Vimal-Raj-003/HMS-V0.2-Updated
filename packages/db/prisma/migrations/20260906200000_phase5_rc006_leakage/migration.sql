-- ═════════════════════════════════════════════════════════════════════════════
-- RC-006 — revenue leakage audit
--
-- `docs/prompts/phase-05-billing-rcm.md` §5.7, exit gate 9.
--
-- ── The constraint that defines the module ──────────────────────────────────
--
-- §5.7 says "Never auto-post — propose to a human", and §B.1 below is that
-- sentence made unfalsifiable. A reconciliation that bills what it thinks it
-- found will bill a patient for a test that was cancelled, a consumable that was
-- wasted, or a visit the consultant waived. It would be right most of the time,
-- and the times it was wrong would land on families as charges nobody at the
-- counter can explain.
--
-- So a finding cannot reach `recovered` without an `accepted` action carrying a
-- named human, and it cannot be `accepted` without one either. The trigger
-- checks the trail, not a column somebody could set alongside the status.
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
CREATE TYPE "billing"."LeakReconciler" AS ENUM ('orders_vs_charges', 'dispense_vs_charges', 'consignment_vs_charges', 'discount_without_approval');

-- CreateEnum
CREATE TYPE "billing"."LeakSeverity" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "billing"."LeakScanStatus" AS ENUM ('running', 'complete', 'failed');

-- CreateEnum
CREATE TYPE "billing"."LeakFindingStatus" AS ENUM ('open', 'accepted', 'dismissed', 'recovered', 'expired');

-- CreateEnum
CREATE TYPE "billing"."LeakActionKind" AS ENUM ('proposed', 'accepted', 'dismissed', 'billed', 'recovered', 'reopened');

-- AlterTable

-- CreateTable
CREATE TABLE "billing"."leak_rules" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "reconciler" "billing"."LeakReconciler" NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "min_gap_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "severity" "billing"."LeakSeverity" NOT NULL DEFAULT 'medium',
    "lookback_days" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "leak_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."leak_scans" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "trigger" VARCHAR(24) NOT NULL DEFAULT 'on_demand',
    "encounter_id" UUID,
    "window_from" DATE,
    "window_to" DATE,
    "status" "billing"."LeakScanStatus" NOT NULL DEFAULT 'running',
    "rules_run" INTEGER NOT NULL DEFAULT 0,
    "rows_examined" INTEGER NOT NULL DEFAULT 0,
    "findings_new" INTEGER NOT NULL DEFAULT 0,
    "findings_total" INTEGER NOT NULL DEFAULT 0,
    "gap_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "started_by" UUID,

    CONSTRAINT "leak_scans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."leak_findings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "scan_id" UUID NOT NULL,
    "rule_id" UUID NOT NULL,
    "reconciler" "billing"."LeakReconciler" NOT NULL,
    "severity" "billing"."LeakSeverity" NOT NULL,
    "patient_id" UUID,
    "encounter_id" UUID,
    "bill_id" UUID,
    "source_ref_type" VARCHAR(40) NOT NULL,
    "source_ref_id" UUID NOT NULL,
    "description" VARCHAR(400) NOT NULL,
    "service_name" VARCHAR(300),
    "expected_amount" DECIMAL(14,2) NOT NULL,
    "billed_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "gap_amount" DECIMAL(14,2) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6),
    "status" "billing"."LeakFindingStatus" NOT NULL DEFAULT 'open',
    "accepted_by" UUID,
    "accepted_at" TIMESTAMPTZ(6),
    "dismissed_by" UUID,
    "dismissed_at" TIMESTAMPTZ(6),
    "dismiss_reason" TEXT,
    "recovered_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "leak_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."leak_finding_actions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "kind" "billing"."LeakActionKind" NOT NULL,
    "reason" TEXT,
    "bill_id" UUID,
    "amount" DECIMAL(14,2),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id" UUID,

    CONSTRAINT "leak_finding_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."leak_discharge_checks" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID,
    "scan_id" UUID,
    "open_findings" INTEGER NOT NULL DEFAULT 0,
    "gap_total" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "cleared" BOOLEAN NOT NULL DEFAULT false,
    "cleared_at" TIMESTAMPTZ(6),
    "cleared_by" UUID,
    "override_reason" TEXT,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checked_by" UUID,

    CONSTRAINT "leak_discharge_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing"."leak_recoveries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "bill_id" UUID,
    "amount" DECIMAL(14,2) NOT NULL,
    "route" VARCHAR(32) NOT NULL DEFAULT 'billed_to_patient',
    "note" TEXT,
    "recovered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recovered_by" UUID,

    CONSTRAINT "leak_recoveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leak_rules_hospital_id_is_active_idx" ON "billing"."leak_rules"("hospital_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "leak_rules_hospital_id_reconciler_key" ON "billing"."leak_rules"("hospital_id", "reconciler");

-- CreateIndex
CREATE INDEX "leak_scans_hospital_id_started_at_idx" ON "billing"."leak_scans"("hospital_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "leak_scans_hospital_id_encounter_id_idx" ON "billing"."leak_scans"("hospital_id", "encounter_id");

-- CreateIndex
CREATE INDEX "leak_findings_hospital_id_status_gap_amount_idx" ON "billing"."leak_findings"("hospital_id", "status", "gap_amount" DESC);

-- CreateIndex
CREATE INDEX "leak_findings_hospital_id_encounter_id_status_idx" ON "billing"."leak_findings"("hospital_id", "encounter_id", "status");

-- CreateIndex
CREATE INDEX "leak_findings_hospital_id_scan_id_idx" ON "billing"."leak_findings"("hospital_id", "scan_id");

-- CreateIndex
CREATE INDEX "leak_finding_actions_hospital_id_finding_id_at_idx" ON "billing"."leak_finding_actions"("hospital_id", "finding_id", "at" DESC);

-- CreateIndex
CREATE INDEX "leak_discharge_checks_hospital_id_encounter_id_checked_at_idx" ON "billing"."leak_discharge_checks"("hospital_id", "encounter_id", "checked_at" DESC);

-- CreateIndex
CREATE INDEX "leak_discharge_checks_hospital_id_cleared_checked_at_idx" ON "billing"."leak_discharge_checks"("hospital_id", "cleared", "checked_at" DESC);

-- CreateIndex
CREATE INDEX "leak_recoveries_hospital_id_recovered_at_idx" ON "billing"."leak_recoveries"("hospital_id", "recovered_at" DESC);

-- CreateIndex
CREATE INDEX "leak_recoveries_hospital_id_finding_id_idx" ON "billing"."leak_recoveries"("hospital_id", "finding_id");

-- AddForeignKey
ALTER TABLE "billing"."leak_findings" ADD CONSTRAINT "leak_findings_scan_id_fkey" FOREIGN KEY ("scan_id") REFERENCES "billing"."leak_scans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."leak_findings" ADD CONSTRAINT "leak_findings_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "billing"."leak_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."leak_finding_actions" ADD CONSTRAINT "leak_finding_actions_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "billing"."leak_findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing"."leak_recoveries" ADD CONSTRAINT "leak_recoveries_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "billing"."leak_findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;



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
  WHERE n.nspname = 'billing' AND c.relname LIKE 'leak\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'RC-006 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── B.1  NEVER AUTO-POST ────────────────────────────────────────────────────
--
-- §5.7's own words. A finding is a proposal, and the only thing that turns a
-- proposal into money is a person.
--
-- The trigger reads the **action trail** rather than a column, because a column
-- set in the same statement as the status proves nothing — the service would be
-- attesting to its own behaviour. `leak_finding_actions` is append-only and
-- carries who; requiring a row in it means the audit trail and the state can
-- never disagree.
CREATE OR REPLACE FUNCTION "billing".assert_leak_finding_was_accepted()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  IF NEW.status = 'accepted' THEN
    IF NEW.accepted_by IS NULL THEN
      RAISE EXCEPTION
        'A leakage finding is a proposal (RC-006 §5.7). Accepting one names the person who agreed it is a real gap.'
        USING ERRCODE = 'RC006';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'dismissed' THEN
    IF NEW.dismissed_by IS NULL OR NEW.dismiss_reason IS NULL THEN
      RAISE EXCEPTION
        'Dismissing a finding records who and why (RC-006 §5.7). A dismissal with no reason is indistinguishable from ignoring it.'
        USING ERRCODE = 'RC006';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'recovered' THEN
    IF NOT EXISTS (
      SELECT 1 FROM billing.leak_finding_actions a
       WHERE a.finding_id = NEW.id AND a.kind = 'accepted' AND a.by_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION
        'Nothing found by the leakage audit is billed without a person accepting it first (RC-006 §5.7). There is no accepted action on this finding.'
        USING ERRCODE = 'RC006';
    END IF;
    RETURN NEW;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "leak_findings_never_auto_post"
  BEFORE UPDATE ON "billing"."leak_findings"
  FOR EACH ROW EXECUTE FUNCTION "billing".assert_leak_finding_was_accepted();

COMMENT ON FUNCTION "billing".assert_leak_finding_was_accepted() IS
  'RC-006 §5.7 "never auto-post". Reads the append-only action trail rather than a column, so the state and the audit trail cannot disagree.';


-- ── B.2  the arithmetic of a gap ────────────────────────────────────────────
ALTER TABLE "billing"."leak_findings"
  ADD CONSTRAINT "leak_gap_is_expected_less_billed"
  CHECK ("gap_amount" = "expected_amount" - "billed_amount");

ALTER TABLE "billing"."leak_findings"
  ADD CONSTRAINT "leak_gap_is_positive"
  CHECK ("gap_amount" > 0 AND "expected_amount" > 0 AND "billed_amount" >= 0);

-- More cannot be recovered than was missing.
ALTER TABLE "billing"."leak_findings"
  ADD CONSTRAINT "leak_recovery_within_gap"
  CHECK ("recovered_amount" >= 0 AND "recovered_amount" <= "gap_amount");

ALTER TABLE "billing"."leak_findings"
  ADD CONSTRAINT "leak_recovered_has_money"
  CHECK (status <> 'recovered' OR "recovered_amount" > 0);


-- ── B.3  a rescan finds the same row, not another one ───────────────────────
--
-- The nightly sweep and an on-demand check cover the same ground. Without this
-- a genuine gap becomes a pile of duplicates and the worklist stops being
-- something anybody opens.
CREATE UNIQUE INDEX "uq_leak_finding_live_per_source"
  ON "billing"."leak_findings" ("hospital_id", "reconciler", "source_ref_id")
  WHERE status IN ('open', 'accepted');


-- ── B.4  the discharge gate ─────────────────────────────────────────────────
--
-- Exit gate 9. A check can be cleared two ways: nothing was outstanding, or
-- somebody decided to let it go and said why. What it cannot be is cleared with
-- money on the table and nobody's name against the decision — that is how a
-- missed charge becomes a phone call to a family who has already gone home.
ALTER TABLE "billing"."leak_discharge_checks"
  ADD CONSTRAINT "leak_clearance_is_clean_or_owned"
  CHECK (NOT cleared
         OR "open_findings" = 0
         OR ("override_reason" IS NOT NULL AND "cleared_by" IS NOT NULL));

ALTER TABLE "billing"."leak_discharge_checks"
  ADD CONSTRAINT "leak_cleared_has_a_timestamp"
  CHECK (NOT cleared OR "cleared_at" IS NOT NULL);

ALTER TABLE "billing"."leak_discharge_checks"
  ADD CONSTRAINT "leak_check_counts_non_negative"
  CHECK ("open_findings" >= 0 AND "gap_total" >= 0);


-- ── B.5  the action trail is append-only ────────────────────────────────────
--
-- It is the evidence that a human stood between every finding and every rupee
-- billed because of one. Editable evidence is not evidence.
CREATE OR REPLACE FUNCTION "billing".refuse_leak_action_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'leak_finding_actions is append-only (RC-006 §B.5). It is the proof that a person stood between the audit and the bill.'
    USING ERRCODE = 'RC006';
END $$;

CREATE TRIGGER "leak_finding_actions_append_only"
  BEFORE UPDATE OR DELETE ON "billing"."leak_finding_actions"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_leak_action_edit();

CREATE TRIGGER "leak_recoveries_append_only"
  BEFORE UPDATE OR DELETE ON "billing"."leak_recoveries"
  FOR EACH ROW EXECUTE FUNCTION "billing".refuse_leak_action_edit();


-- ── B.6  scans and rules are sane ───────────────────────────────────────────
ALTER TABLE "billing"."leak_scans"
  ADD CONSTRAINT "leak_scan_counts_non_negative"
  CHECK ("rules_run" >= 0 AND "rows_examined" >= 0 AND "findings_new" >= 0
         AND "findings_total" >= 0 AND "gap_total" >= 0);

ALTER TABLE "billing"."leak_scans"
  ADD CONSTRAINT "leak_scan_window_ordered"
  CHECK ("window_to" IS NULL OR "window_from" IS NULL OR "window_to" >= "window_from");

ALTER TABLE "billing"."leak_scans"
  ADD CONSTRAINT "leak_scan_finished_has_timestamp"
  CHECK (status = 'running' OR "finished_at" IS NOT NULL);

ALTER TABLE "billing"."leak_scans"
  ADD CONSTRAINT "leak_scan_failure_says_why"
  CHECK (status <> 'failed' OR "error" IS NOT NULL);

ALTER TABLE "billing"."leak_rules"
  ADD CONSTRAINT "leak_rule_threshold_non_negative"
  CHECK ("min_gap_amount" >= 0 AND "lookback_days" > 0 AND "lookback_days" <= 3650);

ALTER TABLE "billing"."leak_recoveries"
  ADD CONSTRAINT "leak_recovery_amount_positive" CHECK ("amount" > 0);


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
  RAISE NOTICE 'Granted application DML on % RC-006 table(s)', v_count;
END $$;

REVOKE UPDATE, DELETE ON "billing"."leak_finding_actions"  FROM hms_app;
REVOKE UPDATE, DELETE ON "billing"."leak_recoveries"       FROM hms_app;
REVOKE DELETE          ON "billing"."leak_findings"        FROM hms_app;
REVOKE DELETE          ON "billing"."leak_discharge_checks" FROM hms_app;

-- The reconciliations read across schemas. `hms_app` already holds SELECT on
-- them through the per-phase grants; naming them here is a reminder that
-- RC-006 depends on those reads staying available.
COMMENT ON TABLE "billing"."leak_findings" IS
  'A proposal, never a posting. RC-006 §5.7: an audit that bills what it thinks it found will bill a family for a cancelled test, and the times it is wrong land on people who cannot argue with a receipt.';

COMMENT ON TABLE "billing"."leak_discharge_checks" IS
  'Exit gate 9. Somebody looked before the patient left, and this says what was open when they did. A missed charge found the next morning is a phone call to a family who has gone home.';

COMMENT ON TABLE "billing"."leak_finding_actions" IS
  'Append-only. The proof that a person stood between the audit and every rupee billed because of it.';
