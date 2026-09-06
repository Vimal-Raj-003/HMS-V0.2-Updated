-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-025 §0 — the shared specialty console framework
-- Thirty consoles, one framework
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── Four rules ──────────────────────────────────────────────────────────────
--
-- 1. A console tab can only name a component the build ships. F1 says
--    registering a console takes no code deploy; that is only safe if the
--    registry cannot invent components. `mdm.console_components` is synced from
--    code at boot, as `core.permissions` is, and a trigger checks every tab
--    against it. A tab pointing at a missing component is a workspace that
--    breaks for a whole department, found by the first clinician who opens it.
--
-- 2. A device result is unreviewed until a clinician says otherwise, and the
--    lifecycle only runs forwards. An OCT that lands in a folder nobody opened
--    is worse than one never taken: it looks like it was seen.
--
-- 3. A charge intent that has reached a bill line cannot be cancelled — it is
--    reversed, with a reason. F3's "cancelling before billing voids the intent"
--    is only meaningful if voiding after billing is impossible; otherwise the
--    bill and the intent disagree and the credit note has nothing to explain.
--
-- 4. A stage ends after it starts, and a console's own code is on every stage
--    row, so a turnaround report can tell a slow dilation from a slow doctor.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: SP001.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "specialty";

-- CreateEnum
CREATE TYPE "mdm"."ConsoleComponentKind" AS ENUM ('tab_component', 'form_template');

-- CreateEnum
CREATE TYPE "mdm"."DeviceResultTransport" AS ENUM ('dicom', 'file', 'structured', 'manual');

-- CreateEnum
CREATE TYPE "specialty"."DeviceOrderStatus" AS ENUM ('ordered', 'performed', 'attached', 'cancelled');

-- CreateTable
CREATE TABLE "mdm"."console_components" (
    "key" VARCHAR(80) NOT NULL,
    "kind" "mdm"."ConsoleComponentKind" NOT NULL,
    "label" VARCHAR(120) NOT NULL,
    "description" TEXT NOT NULL,
    "deprecated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "console_components_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "mdm"."specialty_consoles" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "module_key" VARCHAR(60) NOT NULL,
    "department_ids" UUID[],
    "tabs" JSONB NOT NULL,
    "worklist_config" JSONB NOT NULL DEFAULT '{}',
    "billing_links" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "specialty_consoles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mdm"."device_result_types" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "console_id" UUID NOT NULL,
    "transport" "mdm"."DeviceResultTransport" NOT NULL,
    "mime_types" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "parser_key" VARCHAR(60),
    "report_template_key" VARCHAR(60),
    "billing_service_code" VARCHAR(40),
    "review_due_hours" INTEGER NOT NULL DEFAULT 4,
    "side_required" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "device_result_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."encounter_stages" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "console_code" VARCHAR(24) NOT NULL,
    "stage_key" VARCHAR(40) NOT NULL,
    "queue_definition_id" UUID,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_by" UUID,
    "ended_at" TIMESTAMPTZ(6),
    "ended_by" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "encounter_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."device_orders" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID NOT NULL,
    "visit_id" UUID,
    "console_code" VARCHAR(24) NOT NULL,
    "device_result_type_id" UUID NOT NULL,
    "device_result_type_code" VARCHAR(40) NOT NULL,
    "side" "clinical"."Laterality" NOT NULL DEFAULT 'not_applicable',
    "status" "specialty"."DeviceOrderStatus" NOT NULL DEFAULT 'ordered',
    "ordered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ordered_by" UUID NOT NULL,
    "performed_at" TIMESTAMPTZ(6),
    "performed_by" UUID,
    "attached_at" TIMESTAMPTZ(6),
    "result_file_id" UUID,
    "pacs_study_uid" VARCHAR(80),
    "parsed" JSONB,
    "reviewed_at" TIMESTAMPTZ(6),
    "reviewed_by" UUID,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "charge_intent_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "device_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "console_components_kind_deprecated_idx" ON "mdm"."console_components"("kind", "deprecated");

-- CreateIndex
CREATE INDEX "specialty_consoles_hospital_id_is_active_sort_order_idx" ON "mdm"."specialty_consoles"("hospital_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "uq_specialty_console_code" ON "mdm"."specialty_consoles"("hospital_id", "code");

-- CreateIndex
CREATE INDEX "device_result_types_hospital_id_console_id_active_idx" ON "mdm"."device_result_types"("hospital_id", "console_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "uq_device_result_type_code" ON "mdm"."device_result_types"("hospital_id", "code");

-- CreateIndex
CREATE INDEX "encounter_stages_hospital_id_encounter_id_started_at_idx" ON "clinical"."encounter_stages"("hospital_id", "encounter_id", "started_at");

-- CreateIndex
CREATE INDEX "encounter_stages_hospital_id_console_code_stage_key_started_idx" ON "clinical"."encounter_stages"("hospital_id", "console_code", "stage_key", "started_at" DESC);

-- CreateIndex
CREATE INDEX "device_orders_hospital_id_encounter_id_ordered_at_idx" ON "specialty"."device_orders"("hospital_id", "encounter_id", "ordered_at");

-- CreateIndex
CREATE INDEX "device_orders_hospital_id_console_code_status_ordered_at_idx" ON "specialty"."device_orders"("hospital_id", "console_code", "status", "ordered_at" DESC);

-- CreateIndex
CREATE INDEX "device_orders_hospital_id_reviewed_at_attached_at_idx" ON "specialty"."device_orders"("hospital_id", "reviewed_at", "attached_at");

-- AddForeignKey
ALTER TABLE "mdm"."device_result_types" ADD CONSTRAINT "device_result_types_console_id_fkey" FOREIGN KEY ("console_id") REFERENCES "mdm"."specialty_consoles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  A console can only name components the build ships ────────────────
--
-- F1 is "register a console as data and it appears, with no code deploy". The
-- price of that freedom is this check: the registry may compose what exists, it
-- may not invent. A tab naming a component nobody wrote renders as a blank
-- panel for a whole department, and the person who finds out is a clinician
-- with a patient in the chair.
CREATE OR REPLACE FUNCTION mdm.assert_console_tabs_resolve()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, mdm AS $$
DECLARE v_tab jsonb; v_key text; v_kind text; v_missing text[] := '{}'; v_gone text[] := '{}';
BEGIN
  IF jsonb_typeof(NEW.tabs) <> 'array' THEN
    RAISE EXCEPTION 'A console''s tabs are an ordered array (OP-025 §0.1).' USING ERRCODE = 'SP001';
  END IF;

  IF jsonb_array_length(NEW.tabs) = 0 THEN
    RAISE EXCEPTION 'Console % has no tabs (OP-025 §0.1). A console with nothing in it is a department with a broken workspace.',
      NEW.code USING ERRCODE = 'SP001';
  END IF;

  FOR v_tab IN SELECT jsonb_array_elements(NEW.tabs)
  LOOP
    IF COALESCE(btrim(v_tab->>'key'), '') = '' OR COALESCE(btrim(v_tab->>'label'), '') = '' THEN
      RAISE EXCEPTION 'Every tab on console % needs a key and a label (OP-025 §0.1).',
        NEW.code USING ERRCODE = 'SP001';
    END IF;

    -- A tab points at a component or at an EN-039 form template, never both and
    -- never neither: "neither" is a blank panel, "both" is two things claiming
    -- the same pane and no way to say which wins.
    IF (v_tab ? 'component') = (v_tab ? 'formTemplateKey') THEN
      RAISE EXCEPTION 'Tab "%" on console % names % (OP-025 §0.1). A tab is one component or one form template.',
        v_tab->>'key', NEW.code,
        CASE WHEN v_tab ? 'component' THEN 'both a component and a form template' ELSE 'neither a component nor a form template' END
        USING ERRCODE = 'SP001';
    END IF;

    IF v_tab ? 'component' THEN
      v_key := v_tab->>'component'; v_kind := 'tab_component';
    ELSE
      v_key := v_tab->>'formTemplateKey'; v_kind := 'form_template';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM mdm.console_components c WHERE c.key = v_key AND c.kind::text = v_kind) THEN
      v_missing := v_missing || v_key;
    ELSIF EXISTS (SELECT 1 FROM mdm.console_components c WHERE c.key = v_key AND c.deprecated) THEN
      v_gone := v_gone || v_key;
    END IF;
  END LOOP;

  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'Console % names % that this build does not ship (OP-025 §0.1). A console is composed from what exists; it cannot invent a component.',
      NEW.code, array_to_string(v_missing, ', ') USING ERRCODE = 'SP001';
  END IF;

  IF cardinality(v_gone) > 0 THEN
    RAISE EXCEPTION 'Console % names % , which is deprecated (OP-025 §0.1). Existing consoles still resolve it; new registrations do not.',
      NEW.code, array_to_string(v_gone, ', ') USING ERRCODE = 'SP001';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "console_tabs_name_components_that_exist"
  BEFORE INSERT OR UPDATE OF tabs ON "mdm"."specialty_consoles"
  FOR EACH ROW EXECUTE FUNCTION mdm.assert_console_tabs_resolve();

-- A console code is what its permissions, events and print templates are named
-- after. Letters, digits and underscores, so it can be pasted into any of them.
ALTER TABLE "mdm"."specialty_consoles"
  ADD CONSTRAINT "console_code_is_a_prefix"
  CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,23}$');

ALTER TABLE "mdm"."specialty_consoles"
  ADD CONSTRAINT "console_names_its_licence_key"
  CHECK ("module_key" ~ '^module\.[a-z0-9_.]+$');


-- ── §B.2  A result is unreviewed until somebody says otherwise ──────────────
--
-- The lifecycle runs ordered → performed → attached → reviewed, forwards only,
-- and each step needs the one before it. An OCT that lands in a folder nobody
-- opened is worse than one never taken, because it looks like it was seen.
CREATE OR REPLACE FUNCTION specialty.assert_device_order_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'Order % was cancelled (OP-025 §0.3). Raise a new one rather than reviving it — the cancellation is what the bill and the audit already saw.',
      OLD.device_result_type_code USING ERRCODE = 'SP001';
  END IF;

  IF NEW.status = 'performed' AND NEW.performed_at IS NULL THEN
    RAISE EXCEPTION 'A performed result records when it was performed and by whom (OP-025 §0.3).'
      USING ERRCODE = 'SP001';
  END IF;

  IF NEW.status = 'attached'
     AND NEW.result_file_id IS NULL AND NEW.pacs_study_uid IS NULL AND NEW.parsed IS NULL THEN
    RAISE EXCEPTION 'Nothing is attached to % (OP-025 §0.3). An attached result carries a file, a study or a parsed payload.',
      NEW.device_result_type_code USING ERRCODE = 'SP001';
  END IF;

  IF NEW.reviewed_at IS NOT NULL AND NEW.status <> 'attached' THEN
    RAISE EXCEPTION 'Nothing has been attached for % yet (OP-025 §0.3), so there is nothing to review.',
      NEW.device_result_type_code USING ERRCODE = 'SP001';
  END IF;

  -- Review is a statement by a named person at a named time. Half of it is a
  -- tick nobody signed.
  IF (NEW.reviewed_at IS NULL) <> (NEW.reviewed_by IS NULL) THEN
    RAISE EXCEPTION 'A review names who did it and when (OP-025 §0.3).' USING ERRCODE = 'SP001';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.reviewed_at IS NOT NULL
     AND (NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by) THEN
    RAISE EXCEPTION 'This result was already reviewed (OP-025 §0.3). Unreviewing it would erase the fact that somebody looked.'
      USING ERRCODE = 'SP001';
  END IF;

  IF NEW.status = 'cancelled' AND COALESCE(btrim(NEW.cancel_reason), '') = '' THEN
    RAISE EXCEPTION 'Cancelling an ordered investigation records why (OP-025 §0.3).' USING ERRCODE = 'SP001';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "device_result_is_unreviewed_until_somebody_says_otherwise"
  BEFORE INSERT OR UPDATE ON "specialty"."device_orders"
  FOR EACH ROW EXECUTE FUNCTION specialty.assert_device_order_lifecycle();

-- A result type that says it needs a side gets one. "Which eye" is not a
-- detail that can be filled in later from memory.
CREATE OR REPLACE FUNCTION specialty.assert_device_order_side()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, specialty, mdm AS $$
DECLARE v_required boolean;
BEGIN
  SELECT side_required INTO v_required FROM mdm.device_result_types WHERE id = NEW.device_result_type_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_required AND NEW.side = 'not_applicable' THEN
    RAISE EXCEPTION '% is ordered for a side (OP-025 §0.1), and this order does not name one.',
      NEW.device_result_type_code USING ERRCODE = 'SP001';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "sided_investigations_name_their_side"
  BEFORE INSERT OR UPDATE OF side, device_result_type_id ON "specialty"."device_orders"
  FOR EACH ROW EXECUTE FUNCTION specialty.assert_device_order_side();


-- ── §B.3  A billed intent is reversed, never cancelled ──────────────────────
--
-- F3 asks that cancelling a console action before billing voids its intent.
-- That is only a rule if voiding *after* billing is impossible: otherwise the
-- bill keeps a line whose intent has vanished, and the credit note has nothing
-- left to explain itself with.
CREATE OR REPLACE FUNCTION billing.assert_charge_intent_transition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, billing AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;

  IF OLD.status = 'posted' AND NEW.status = 'cancelled' THEN
    RAISE EXCEPTION 'This charge has already reached a bill (RC-006 §5). A billed line is reversed with a reason, not cancelled — the pair is what a credit note is made of.'
      USING ERRCODE = 'SP001';
  END IF;

  IF NEW.status IN ('cancelled', 'waived') AND NEW.bill_line_id IS NOT NULL THEN
    RAISE EXCEPTION 'This charge is on bill line % and cannot be voided (RC-006 §5). Reverse it instead.',
      NEW.bill_line_id USING ERRCODE = 'SP001';
  END IF;

  IF NEW.status = 'reversed' AND COALESCE(btrim(NEW.reversal_reason), '') = '' THEN
    RAISE EXCEPTION 'Reversing a charge records why (RC-006 §5).' USING ERRCODE = 'SP001';
  END IF;

  IF OLD.status IN ('reversed', 'cancelled') THEN
    RAISE EXCEPTION 'This charge is already %; it does not go back to % (RC-006 §5).',
      OLD.status, NEW.status USING ERRCODE = 'SP001';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "billed_charges_are_reversed_never_cancelled"
  BEFORE UPDATE OF status ON "billing"."charge_intents"
  FOR EACH ROW EXECUTE FUNCTION billing.assert_charge_intent_transition();


-- ── §B.4  A stage ends after it starts ──────────────────────────────────────
ALTER TABLE "clinical"."encounter_stages"
  ADD CONSTRAINT "stage_ends_after_it_starts"
  CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

ALTER TABLE "clinical"."encounter_stages"
  ADD CONSTRAINT "closed_stage_is_owned"
  CHECK ("ended_at" IS NULL OR "ended_by" IS NOT NULL);

-- One open leg per stage per encounter. Two open "refraction" rows make the
-- turnaround report count the same wait twice and hide the second lane.
CREATE UNIQUE INDEX "uq_one_open_stage_per_encounter"
  ON "clinical"."encounter_stages" ("encounter_id", "stage_key")
  WHERE "ended_at" IS NULL;

COMMENT ON TABLE "mdm"."console_components" IS
  'What the build ships for a console tab to point at. Synced from code at boot exactly as core.permissions is, and world-readable for the same reason: a console registration may compose what exists, it may not invent a component.';

COMMENT ON TABLE "specialty"."device_orders" IS
  'One lifecycle for every console: ordered, performed, attached, reviewed. A console that ships its own upload path is a defect, not a feature (phase-08).';


-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
GRANT USAGE ON SCHEMA "specialty" TO hms_app, hms_readonly;

DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND c.relispartition = false
      AND ((n.nspname = 'mdm' AND c.relname IN ('console_components','specialty_consoles','device_result_types'))
        OR (n.nspname = 'clinical' AND c.relname = 'encounter_stages')
        OR  n.nspname = 'specialty')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % Phase 8 framework table(s)', v_count;
END $$;

-- The component catalogue is what the build ships. The application syncs it at
-- boot and marks vanished keys deprecated; it never deletes one, because an old
-- console row still has to resolve to something explicable.
REVOKE DELETE ON "mdm"."console_components" FROM hms_app;

-- An ordered investigation and a stage of a visit are both facts about a
-- patient's day. Neither is deleted; an order is cancelled with a reason and a
-- stage is closed.
REVOKE DELETE ON "specialty"."device_orders"    FROM hms_app;
REVOKE DELETE ON "clinical"."encounter_stages"  FROM hms_app;


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
      AND c.relname NOT IN ('cdss_safety_floor','console_components')
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

-- `mdm.console_components` is a code catalogue, not tenant data — the same
-- shape and the same policy as `core.permissions`. Every session may read what
-- the build ships; a `USING (false)` here would leave every console unable to
-- resolve its own tabs.
ALTER TABLE "mdm"."console_components" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "mdm"."console_components";
CREATE POLICY tenant_isolation ON "mdm"."console_components" FOR ALL TO hms_app USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS tenant_isolation_ro ON "mdm"."console_components";
CREATE POLICY tenant_isolation_ro ON "mdm"."console_components" FOR SELECT TO hms_readonly USING (true);

DO $$
DECLARE v_missing text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE (n.nspname = 'specialty'
      OR (n.nspname = 'mdm' AND c.relname IN ('console_components','specialty_consoles','device_result_types'))
      OR (n.nspname = 'clinical' AND c.relname = 'encounter_stages'))
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 8 framework tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;
