-- ═════════════════════════════════════════════════════════════════════════════
-- NC-022 · Budgets, and the commitment that cannot exceed one
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Phase 9A.5, and the closing of a hook Phase 4 deliberately left open.
-- `inventory.pur_indents.budget_line_ref` and
-- `inventory.pur_purchase_orders.budget_line_ref` have been `VARCHAR(64)`
-- since August, pointing at nothing: a free-text field a buyer could type
-- anything into, next to an `estimated_value` nobody checked against anything.
-- A hospital could therefore raise ten million rupees of purchase orders
-- against a two-million-rupee budget and find out at the year end.
--
-- ── The rule this file exists for ────────────────────────────────────────
--
-- **A commitment cannot take a budget line past its budget.** Not warned
-- about, not flagged on a report — refused, by a trigger, at the moment the
-- indent or PO reserves the money.
--
-- The arithmetic is deliberately three-part, because two would be wrong:
--
--     available = revised_amount − committed − actual
--
-- `committed` is money promised to a vendor and not yet spent; `actual` is
-- money that has left. A control that watched only actuals would approve a
-- year's spending in a week — every PO would pass, because none of them has
-- been paid yet — which is exactly how public-sector budgets used to fail.
--
-- ── And a virement has to balance ────────────────────────────────────────
--
-- Moving budget between lines is the ordinary way a hospital copes with a year
-- that did not go to plan, and it must not create money. §C uses the same
-- deferred-constraint shape as double entry: the legs of a virement are summed
-- at COMMIT and refused if they do not net to zero.
--
-- §A  Cycles, lines and revisions
-- §B  Commitment control
-- §C  Virements, which must net to zero
-- §D  Closing the Phase 4 hook
-- §E  Grants and row-level security

-- ═════════════════════════════════════════════════════════════════════════════
-- §A. CYCLES AND LINES
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE "finance"."budget_cycles" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "book_id" UUID NOT NULL,
    "fiscal_year_id" UUID,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    -- draft → active → closed. Only an active cycle accepts commitments; a
    -- draft is still being argued over and a closed one is history.
    "status" VARCHAR(16) NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "budget_cycles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_budget_cycle_code" ON "finance"."budget_cycles"("book_id", "code");

ALTER TABLE "finance"."budget_cycles"
  ADD CONSTRAINT "a_budget_cycle_runs_forwards" CHECK ("ends_on" > "starts_on");
ALTER TABLE "finance"."budget_cycles"
  ADD CONSTRAINT "a_budget_cycle_status_is_known"
  CHECK ("status" IS NOT NULL AND "status" IN ('draft', 'active', 'closed'));


/**
 * One line of a budget: this cost centre, this account, this much.
 *
 * `committed` and `actual` are maintained by triggers, not by whoever
 * remembers. `available` is not a column at all — it is arithmetic, and a
 * stored copy is wrong the moment a PO is raised in another session.
 */
CREATE TABLE "finance"."budget_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "cost_centre_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    -- `operating` pays for the year's running; `capital` buys something that
    -- lasts. They are never fungible without a board decision, which is why a
    -- virement between the two is refused in §C.
    "budget_kind" VARCHAR(16) NOT NULL DEFAULT 'operating',
    "original_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    -- The original survives every revision. A budget that is only ever its
    -- current number cannot answer "what did we plan, and by how much did we
    -- miss?", which is the only question variance analysis asks.
    "revised_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "committed_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "actual_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    -- Below this proportion remaining, the line is worth a warning. It does
    -- not block anything; blocking is what the hard limit is for.
    "alert_threshold_pct" SMALLINT NOT NULL DEFAULT 80,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "budget_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_budget_line_code" ON "finance"."budget_lines"("cycle_id", "code");
CREATE UNIQUE INDEX "uq_budget_line_dimensions"
  ON "finance"."budget_lines"("cycle_id", "cost_centre_id", "account_id", "budget_kind");

ALTER TABLE "finance"."budget_lines"
  ADD CONSTRAINT "a_budget_kind_is_known"
  CHECK ("budget_kind" IS NOT NULL AND "budget_kind" IN ('operating', 'capital'));
ALTER TABLE "finance"."budget_lines"
  ADD CONSTRAINT "a_budget_amounts_are_not_negative"
  CHECK ("original_amount" >= 0 AND "revised_amount" >= 0
         AND "committed_amount" >= 0 AND "actual_amount" >= 0);
ALTER TABLE "finance"."budget_lines"
  ADD CONSTRAINT "a_alert_threshold_is_a_percentage"
  CHECK ("alert_threshold_pct" BETWEEN 0 AND 100);


/**
 * Every change to a line's amount, and why.
 *
 * Append-only. A budget whose history can be edited cannot answer the question
 * an auditor actually asks, which is not "what is the budget" but "who moved
 * it, when, and what did they say at the time".
 */
CREATE TABLE "finance"."budget_revisions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "revision_no" SMALLINT NOT NULL,
    "from_amount" DECIMAL(16,2) NOT NULL,
    "to_amount" DECIMAL(16,2) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "approved_by" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Set when the revision is one leg of a virement.
    "virement_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "budget_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_budget_revision_no" ON "finance"."budget_revisions"("line_id", "revision_no");
CREATE INDEX "budget_revisions_virement_idx" ON "finance"."budget_revisions"("virement_id");

CREATE OR REPLACE FUNCTION finance.a_budget_revision_is_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'A budget revision cannot be % (NC-022 §A). An auditor does not ask what the budget is, they ask who moved it and what they said at the time; a history that can be edited answers neither.',
    CASE TG_OP WHEN 'DELETE' THEN 'deleted' ELSE 'changed' END
    USING ERRCODE = 'NC022';
END $$;

CREATE TRIGGER trg_a_budget_revision_is_append_only
  BEFORE UPDATE OR DELETE ON finance.budget_revisions
  FOR EACH ROW EXECUTE FUNCTION finance.a_budget_revision_is_append_only();


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. COMMITMENT CONTROL
-- ═════════════════════════════════════════════════════════════════════════════

/**
 * Money promised but not yet spent.
 *
 * An indent reserves; a PO firms the reservation up; a GRN turns it into an
 * actual. Each stage releases the one before it, which is why the source is
 * recorded rather than just the amount.
 */
CREATE TABLE "finance"."budget_commitments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    -- indent | purchase_order | capex_request | manual
    "source_kind" VARCHAR(24) NOT NULL,
    "source_id" UUID NOT NULL,
    "source_ref" VARCHAR(64),
    "amount" DECIMAL(16,2) NOT NULL,
    -- open → released (superseded by a later stage, or cancelled)
    --      → realised (became an actual)
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "released_reason" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "budget_commitments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "budget_commitments_line_idx" ON "finance"."budget_commitments"("line_id", "status");
-- One live commitment per source document. A PO amended twice must not hold
-- the budget three times.
CREATE UNIQUE INDEX "uq_commitment_per_source"
  ON "finance"."budget_commitments"("source_kind", "source_id")
  WHERE "status" = 'open';

ALTER TABLE "finance"."budget_commitments"
  ADD CONSTRAINT "a_commitment_is_positive" CHECK ("amount" > 0);
ALTER TABLE "finance"."budget_commitments"
  ADD CONSTRAINT "a_commitment_source_is_known"
  CHECK ("source_kind" IS NOT NULL
         AND "source_kind" IN ('indent', 'purchase_order', 'capex_request', 'manual'));
ALTER TABLE "finance"."budget_commitments"
  ADD CONSTRAINT "a_commitment_status_is_known"
  CHECK ("status" IS NOT NULL AND "status" IN ('open', 'released', 'realised'));


-- §B.1  ── THE RULE ─────────────────────────────────────────────────────────
--
-- A commitment cannot take a line past its budget.
--
-- Checked against `revised − committed − actual`, and the three-part sum is
-- the point. A control that watched actuals alone would approve a year's
-- spending in a week, because no purchase order has been paid yet.
CREATE OR REPLACE FUNCTION finance.a_commitment_fits_the_budget()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_revised numeric(16,2); v_committed numeric(16,2); v_actual numeric(16,2);
  v_available numeric(16,2); v_cycle_status text; v_code text; v_active boolean;
BEGIN
  IF NEW.status <> 'open' THEN RETURN NEW; END IF;

  SELECT l.revised_amount, l.committed_amount, l.actual_amount, l.code, l.active, c.status
    INTO v_revised, v_committed, v_actual, v_code, v_active, v_cycle_status
    FROM finance.budget_lines l
    JOIN finance.budget_cycles c ON c.id = l.cycle_id
   WHERE l.id = NEW.line_id;

  IF v_revised IS NULL THEN
    RAISE EXCEPTION 'That budget line does not exist (NC-022 §B.1).' USING ERRCODE = 'NC022';
  END IF;

  IF NOT v_active THEN
    RAISE EXCEPTION 'Budget line % is closed and cannot take a commitment (NC-022 §B.1).',
      v_code USING ERRCODE = 'NC022';
  END IF;

  IF v_cycle_status <> 'active' THEN
    RAISE EXCEPTION
      'That budget cycle is %, so nothing can be committed against it (NC-022 §B.1). A draft cycle is still being argued over; a closed one is history.',
      v_cycle_status USING ERRCODE = 'NC022';
  END IF;

  -- The existing commitment for this source is excluded, so amending a PO
  -- upwards is checked on the difference rather than on the whole thing twice.
  v_available := v_revised - v_committed - v_actual
    + coalesce((SELECT sum(amount) FROM finance.budget_commitments
                 WHERE line_id = NEW.line_id AND status = 'open' AND id = NEW.id), 0);

  IF NEW.amount > v_available THEN
    RAISE EXCEPTION
      'Budget line % has % available and this commits % (NC-022 §B.1). Budget is %, already committed %, already spent %. Raise the line, move budget from another, or reduce the order — a commitment that quietly exceeded its line is how a hospital discovers in March that it spent the year''s money by August.',
      v_code, v_available, NEW.amount, v_revised, v_committed, v_actual
      USING ERRCODE = 'NC022';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_commitment_fits_the_budget
  BEFORE INSERT OR UPDATE OF amount, line_id, status ON finance.budget_commitments
  FOR EACH ROW EXECUTE FUNCTION finance.a_commitment_fits_the_budget();


-- §B.2  `committed_amount` is the sum of the open commitments, derived.
CREATE OR REPLACE FUNCTION finance.a_committed_total_is_derived()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_line uuid;
BEGIN
  v_line := CASE WHEN TG_OP = 'DELETE' THEN OLD.line_id ELSE NEW.line_id END;
  UPDATE finance.budget_lines l
     SET committed_amount = coalesce((
           SELECT sum(amount) FROM finance.budget_commitments
            WHERE line_id = v_line AND status = 'open'), 0),
         updated_at = now()
   WHERE l.id = v_line;

  -- An UPDATE that moves a commitment between lines has to settle both.
  IF TG_OP = 'UPDATE' AND OLD.line_id IS DISTINCT FROM NEW.line_id THEN
    UPDATE finance.budget_lines l
       SET committed_amount = coalesce((
             SELECT sum(amount) FROM finance.budget_commitments
              WHERE line_id = OLD.line_id AND status = 'open'), 0),
           updated_at = now()
     WHERE l.id = OLD.line_id;
  END IF;

  RETURN NULL;
END $$;

CREATE TRIGGER trg_a_committed_total_is_derived
  AFTER INSERT OR UPDATE OR DELETE ON finance.budget_commitments
  FOR EACH ROW EXECUTE FUNCTION finance.a_committed_total_is_derived();


/**
 * Budget position, computed. `available` is never a column.
 */
CREATE OR REPLACE VIEW finance.v_budget_position AS
SELECT
  l.hospital_id,
  l.cycle_id,
  c.code   AS cycle_code,
  l.id     AS line_id,
  l.code   AS line_code,
  l.budget_kind,
  l.cost_centre_id,
  cc.name  AS cost_centre_name,
  l.account_id,
  a.code   AS account_code,
  a.name   AS account_name,
  l.original_amount,
  l.revised_amount,
  l.committed_amount,
  l.actual_amount,
  (l.revised_amount - l.committed_amount - l.actual_amount) AS available,
  (l.revised_amount - l.original_amount)                    AS revision_movement,
  CASE
    WHEN l.revised_amount = 0 THEN 0
    ELSE round(((l.committed_amount + l.actual_amount) / l.revised_amount) * 100, 1)
  END AS used_pct,
  (l.revised_amount > 0
   AND ((l.committed_amount + l.actual_amount) / l.revised_amount) * 100 >= l.alert_threshold_pct)
    AS over_alert_threshold
FROM finance.budget_lines l
JOIN finance.budget_cycles c ON c.id = l.cycle_id
JOIN finance.cost_centres cc ON cc.id = l.cost_centre_id
JOIN finance.accounts a      ON a.id = l.account_id
WHERE l.active = true;

COMMENT ON VIEW finance.v_budget_position IS
  'NC-022: budget, committed, actual and what is left. `available` is arithmetic, never a stored column — a copy is wrong the moment a purchase order is raised in another session.';


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. VIREMENTS, WHICH MUST NET TO ZERO
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE "finance"."budget_virements" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "reference" VARCHAR(40),
    "reason" VARCHAR(500) NOT NULL,
    "requested_by" UUID NOT NULL,
    "approved_by" UUID NOT NULL,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "budget_virements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "budget_virements_cycle_idx" ON "finance"."budget_virements"("cycle_id");

-- Moving money between departments is the moment somebody's budget shrinks, so
-- it takes two people for the same reason a write-off does.
ALTER TABLE "finance"."budget_virements"
  ADD CONSTRAINT "a_virement_needs_a_second_person"
  CHECK ("approved_by" <> "requested_by");

/**
 * A virement must not create money.
 *
 * The same deferred-constraint shape as double entry, and for the same reason:
 * the legs are written one at a time and cannot balance until the last one
 * lands, so the check belongs at COMMIT. Without it a "transfer" that credits
 * one line and forgets to debit the other is a budget increase nobody
 * approved.
 */
CREATE OR REPLACE FUNCTION finance.a_virement_nets_to_zero()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_virement uuid; v_net numeric(16,2); v_legs int;
BEGIN
  v_virement := CASE WHEN TG_OP = 'DELETE' THEN OLD.virement_id ELSE NEW.virement_id END;
  IF v_virement IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM finance.budget_virements WHERE id = v_virement) THEN
    RETURN NULL;
  END IF;

  SELECT coalesce(sum(to_amount - from_amount), 0), count(*)
    INTO v_net, v_legs
    FROM finance.budget_revisions WHERE virement_id = v_virement;

  IF v_legs < 2 THEN
    RAISE EXCEPTION
      'Virement % has % leg(s) (NC-022 §C). A transfer needs somewhere to come from and somewhere to go.',
      v_virement, v_legs USING ERRCODE = 'NC022';
  END IF;

  IF v_net <> 0 THEN
    RAISE EXCEPTION
      'Virement % does not net to zero: it moves % (NC-022 §C). A transfer that creates budget is a budget increase nobody approved. Checked when the transaction commits, so nothing has been stored.',
      v_virement, v_net USING ERRCODE = 'NC022';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER trg_a_virement_nets_to_zero
  AFTER INSERT OR UPDATE OR DELETE ON finance.budget_revisions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION finance.a_virement_nets_to_zero();


-- Operating and capital money are not fungible without a board decision, so a
-- virement may not quietly convert one into the other.
CREATE OR REPLACE FUNCTION finance.a_virement_stays_within_its_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_kinds int;
BEGIN
  IF NEW.virement_id IS NULL THEN RETURN NEW; END IF;

  SELECT count(DISTINCT l.budget_kind) INTO v_kinds
    FROM finance.budget_revisions r
    JOIN finance.budget_lines l ON l.id = r.line_id
   WHERE r.virement_id = NEW.virement_id;

  IF v_kinds > 1 THEN
    RAISE EXCEPTION
      'A virement cannot move budget between operating and capital (NC-022 §C). Capital buys something that lasts and operating pays for the year; converting one into the other is a board decision, not a transfer.'
      USING ERRCODE = 'NC022';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_virement_stays_within_its_kind
  AFTER INSERT ON finance.budget_revisions
  FOR EACH ROW EXECUTE FUNCTION finance.a_virement_stays_within_its_kind();


-- A revision moves the line it describes. Derived, so the two cannot disagree.
CREATE OR REPLACE FUNCTION finance.a_revision_moves_its_line()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE finance.budget_lines
     SET revised_amount = NEW.to_amount, updated_at = now()
   WHERE id = NEW.line_id;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_a_revision_moves_its_line
  AFTER INSERT ON finance.budget_revisions
  FOR EACH ROW EXECUTE FUNCTION finance.a_revision_moves_its_line();


-- ═════════════════════════════════════════════════════════════════════════════
-- §D. CLOSING THE PHASE 4 HOOK
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `budget_line_ref` has been a free-text VARCHAR(64) since August, next to an
-- `estimated_value` nobody compared to anything. Adding a typed column beside
-- it — rather than repurposing the text one — means existing rows keep
-- whatever a buyer typed, and the new reference is either a real budget line
-- or nothing.
ALTER TABLE "inventory"."pur_indents"
  ADD COLUMN "budget_line_id" UUID;
ALTER TABLE "inventory"."pur_purchase_orders"
  ADD COLUMN "budget_line_id" UUID;

CREATE INDEX "pur_indents_budget_line_idx" ON "inventory"."pur_indents"("budget_line_id");
CREATE INDEX "pur_purchase_orders_budget_line_idx" ON "inventory"."pur_purchase_orders"("budget_line_id");

COMMENT ON COLUMN "inventory"."pur_indents"."budget_line_ref" IS
  'Superseded by `budget_line_id` (NC-022 §D). Free text, kept so rows written before Phase 9 keep what the buyer typed.';
COMMENT ON COLUMN "inventory"."pur_purchase_orders"."budget_line_ref" IS
  'Superseded by `budget_line_id` (NC-022 §D). Free text, kept so rows written before Phase 9 keep what the buyer typed.';


-- Foreign keys, in the repo's style.
ALTER TABLE "finance"."budget_cycles" ADD CONSTRAINT "budget_cycles_book_id_fkey"
  FOREIGN KEY ("book_id") REFERENCES "finance"."books"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- RESTRICT, not CASCADE, on everything that carries history. A cascade here
-- would be a lie: §A's append-only trigger refuses the cascaded delete anyway,
-- and the error then blames `budget_revisions` for a statement that named
-- `budget_cycles`. Better that the constraint says what is actually true —
-- a budget with a history is permanent.
ALTER TABLE "finance"."budget_lines" ADD CONSTRAINT "budget_lines_cycle_id_fkey"
  FOREIGN KEY ("cycle_id") REFERENCES "finance"."budget_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."budget_lines" ADD CONSTRAINT "budget_lines_cost_centre_id_fkey"
  FOREIGN KEY ("cost_centre_id") REFERENCES "finance"."cost_centres"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."budget_lines" ADD CONSTRAINT "budget_lines_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "finance"."accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."budget_revisions" ADD CONSTRAINT "budget_revisions_line_id_fkey"
  FOREIGN KEY ("line_id") REFERENCES "finance"."budget_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."budget_revisions" ADD CONSTRAINT "budget_revisions_virement_id_fkey"
  FOREIGN KEY ("virement_id") REFERENCES "finance"."budget_virements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."budget_commitments" ADD CONSTRAINT "budget_commitments_line_id_fkey"
  FOREIGN KEY ("line_id") REFERENCES "finance"."budget_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "finance"."budget_virements" ADD CONSTRAINT "budget_virements_cycle_id_fkey"
  FOREIGN KEY ("cycle_id") REFERENCES "finance"."budget_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory"."pur_indents" ADD CONSTRAINT "pur_indents_budget_line_id_fkey"
  FOREIGN KEY ("budget_line_id") REFERENCES "finance"."budget_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory"."pur_purchase_orders" ADD CONSTRAINT "pur_purchase_orders_budget_line_id_fkey"
  FOREIGN KEY ("budget_line_id") REFERENCES "finance"."budget_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §E. GRANTS AND ROW-LEVEL SECURITY
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
  GRANT SELECT ON finance.v_budget_position TO hms_app, hms_readonly;
  RAISE NOTICE 'Granted application DML on % table(s)', v_count;
END $$;

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
