-- ═════════════════════════════════════════════════════════════════════════════
-- RC-006 · What a console's work costs, and the rule that it is charged once
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Thirty specialty consoles shipped and not one produced a billable line. The
-- staging table they were meant to write to — `billing.charge_intents` — had
-- been built properly: a status running pending → posted, a `bill_line_id` to
-- point at what the charge became, a unique index making one charge per act
-- structural, and a trigger refusing to cancel a charge that has already
-- reached a bill. Nobody wrote a row and nobody drained one, so the hospital
-- did the work for free.
--
-- Two things were missing, and only one of them was code.
--
-- ── Somewhere to say what an act is worth ─────────────────────────────────
--
-- `mdm.device_result_types.billing_service_code` was the only column in the
-- database that named a billable service for a console act, which is why the
-- single path that raised an intent was the single path with somewhere to look
-- it up. §A adds one map instead of a column on each of fifteen masters.
--
-- ── And the rule that a posted charge is final ────────────────────────────
--
-- The existing trigger refuses `posted → cancelled` and demands a reason for a
-- reversal, which is most of the way there. What it did not refuse was a second
-- posting overwriting `bill_line_id` — pointing a charge at a different line
-- and orphaning the first. §B closes that.
--
-- §A  The map
-- §B  A posted charge points at one line, forever
-- §C  Grants
-- §D  Row-level security
--
-- CreateTable
CREATE TABLE "mdm"."console_charge_map" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID,
    "console_code" VARCHAR(40) NOT NULL,
    "act_kind" VARCHAR(80) NOT NULL,
    "service_id" UUID,
    "not_billable" BOOLEAN NOT NULL DEFAULT false,
    "qty_unit" VARCHAR(24),
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "console_charge_map_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "console_charge_map_hospital_id_console_code_idx" ON "mdm"."console_charge_map"("hospital_id", "console_code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_console_charge_map" ON "mdm"."console_charge_map"("hospital_id", "console_code", "act_kind");


-- ═════════════════════════════════════════════════════════════════════════════
-- §A. THE MAP
-- ═════════════════════════════════════════════════════════════════════════════

-- A row either names a service or says the act is deliberately not billable.
-- One that does neither is a hospital that has half-answered the question, and
-- the biller's worklist cannot tell that apart from an act nobody has mapped.
ALTER TABLE "mdm"."console_charge_map"
  ADD CONSTRAINT "a_mapping_answers_the_question"
  CHECK ("service_id" IS NOT NULL OR "not_billable" = true);

-- And not both. "Bill service X, but do not bill it" is not a configuration.
ALTER TABLE "mdm"."console_charge_map"
  ADD CONSTRAINT "a_mapping_does_not_contradict_itself"
  CHECK ("service_id" IS NULL OR "not_billable" = false);


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. A POSTED CHARGE POINTS AT ONE LINE, FOREVER
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `assert_charge_intent_transition` already refuses to cancel a billed charge
-- and demands a reason to reverse one. It returns early when the status has not
-- changed, though — so a second posting could rewrite `bill_line_id` on a
-- charge that was already posted, pointing it at a different line and leaving
-- the first orphaned on the bill with nothing referring to it.
--
-- The poster is written to be safe to re-run, and this is what makes that
-- claim true rather than intended.
CREATE OR REPLACE FUNCTION billing.a_posted_charge_keeps_its_line()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.bill_line_id IS NOT NULL AND NEW.bill_line_id IS DISTINCT FROM OLD.bill_line_id THEN
    RAISE EXCEPTION
      'This charge is already on bill line % and cannot be moved to another (RC-006 §B). Reverse it and raise the work again — a charge that changes which line it points at leaves the first line on the bill with nothing explaining it.',
      OLD.bill_line_id
      USING ERRCODE = 'SP001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_posted_charge_keeps_its_line
  BEFORE UPDATE OF bill_line_id ON billing.charge_intents
  FOR EACH ROW EXECUTE FUNCTION billing.a_posted_charge_keeps_its_line();


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname = 'mdm' AND c.relname = 'console_charge_map'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % table(s)', v_count;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §D. ROW-LEVEL SECURITY
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
                            'immunisation_schedules','anticholinergic_scores','beers_criteria',
                            'telemedicine_drug_rules')
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
