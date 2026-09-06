-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 7C · IP-005 — inpatient billing and the midnight room charge
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── The single most important line in this migration ────────────────────────
--
--   CREATE UNIQUE INDEX uq_room_charge_idempotency
--     ON ip_room_charges (admission_id, charge_date, charge_code,
--                         COALESCE(occupancy_id, '00000000-…'))
--     WHERE superseded_at IS NULL;
--
-- `phase-07`: "Every auto line is idempotent on (admission_id, charge_date,
-- charge_code, occupancy_id) — reruns never duplicate", and "run it three
-- times, run it after a back-dated transfer, run it after a clock change — the
-- bill must be identical. This is the single most common source of billing
-- disputes in Indian hospitals; test it like money depends on it, because it
-- does."
--
-- A job that is *careful* not to duplicate is a job that duplicates the night
-- somebody restarts it mid-run, or the night two workers overlap, or the night
-- a retry fires after a timeout that had actually succeeded. A unique index
-- cannot. The job's `ON CONFLICT DO NOTHING` is what makes a re-run cheap; the
-- index is what makes it correct.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: IP005.

-- CreateEnum
CREATE TYPE "clinical"."RoomChargePolicy" AS ENUM ('day_boundary', 'higher_class', 'hourly_proration');

-- CreateTable
CREATE TABLE "clinical"."ip_charge_policies" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID,
    "policy" "clinical"."RoomChargePolicy" NOT NULL DEFAULT 'day_boundary',
    "cutoff_hour" INTEGER NOT NULL DEFAULT 0,
    "discharge_grace_minutes" INTEGER NOT NULL DEFAULT 120,
    "admission_grace_minutes" INTEGER NOT NULL DEFAULT 0,
    "minimum_days" INTEGER NOT NULL DEFAULT 1,
    "day_care_flat" DECIMAL(14,2),
    "gst_threshold_per_day" DECIMAL(14,2) NOT NULL DEFAULT 5000,
    "room_gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_charge_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_room_charges" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "occupancy_id" UUID,
    "bill_id" UUID,
    "bill_item_id" UUID,
    "charge_date" DATE NOT NULL,
    "charge_code" VARCHAR(40) NOT NULL,
    "class_id" UUID,
    "ward_id" UUID,
    "units" DECIMAL(10,3) NOT NULL,
    "unit_rate" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "gst_rate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "gst_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "is_exempt" BOOLEAN NOT NULL DEFAULT true,
    "exempt_reason" VARCHAR(80),
    "policy" "clinical"."RoomChargePolicy" NOT NULL,
    "tariff_version_id" UUID,
    "covers_from" TIMESTAMPTZ(6) NOT NULL,
    "covers_to" TIMESTAMPTZ(6) NOT NULL,
    "superseded_at" TIMESTAMPTZ(6),
    "superseded_by" UUID,
    "posted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_room_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_charge_runs" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "for_date" DATE NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "admissions_considered" INTEGER NOT NULL DEFAULT 0,
    "charges_posted" INTEGER NOT NULL DEFAULT 0,
    "charges_skipped" INTEGER NOT NULL DEFAULT 0,
    "charges_superseded" INTEGER NOT NULL DEFAULT 0,
    "state" VARCHAR(20) NOT NULL DEFAULT 'running',
    "error" TEXT,
    "triggered_by" UUID,
    "trigger" VARCHAR(20) NOT NULL DEFAULT 'schedule',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_charge_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_discharge_clearances" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "checks" JSONB NOT NULL DEFAULT '[]',
    "state" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "blocked_reasons" TEXT[],
    "cleared_at" TIMESTAMPTZ(6),
    "cleared_by" UUID,
    "overridden_at" TIMESTAMPTZ(6),
    "overridden_by" UUID,
    "override_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_discharge_clearances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_charge_policy_scope" ON "clinical"."ip_charge_policies"("hospital_id", "branch_id");

-- CreateIndex
CREATE INDEX "ip_room_charges_hospital_id_branch_id_charge_date_idx" ON "clinical"."ip_room_charges"("hospital_id", "branch_id", "charge_date");

-- CreateIndex
CREATE INDEX "ip_room_charges_hospital_id_admission_id_charge_date_idx" ON "clinical"."ip_room_charges"("hospital_id", "admission_id", "charge_date");

-- CreateIndex
CREATE INDEX "ip_room_charges_hospital_id_run_id_idx" ON "clinical"."ip_room_charges"("hospital_id", "run_id");

-- CreateIndex
CREATE INDEX "ip_charge_runs_hospital_id_branch_id_for_date_idx" ON "clinical"."ip_charge_runs"("hospital_id", "branch_id", "for_date" DESC);

-- CreateIndex
CREATE INDEX "ip_discharge_clearances_hospital_id_branch_id_state_idx" ON "clinical"."ip_discharge_clearances"("hospital_id", "branch_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "uq_clearance_per_admission" ON "clinical"."ip_discharge_clearances"("hospital_id", "admission_id");



-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  Idempotency, as an index ──────────────────────────────────────────
--
-- `COALESCE` on the occupancy because a charge that is not tied to one — a diet
-- line, an attendant bed — still gets one row per admission per day per code.
-- Partial on `superseded_at IS NULL` so a corrected charge can sit beside the
-- one it replaced: the old row is the answer to "what did you charge me on
-- Tuesday", and deleting it to make room for the correction destroys exactly
-- the record a dispute needs.
CREATE UNIQUE INDEX "uq_room_charge_idempotency"
  ON "clinical"."ip_room_charges" (
    "admission_id",
    "charge_date",
    "charge_code",
    COALESCE("occupancy_id", '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE "superseded_at" IS NULL;

ALTER TABLE "clinical"."ip_room_charges"
  ADD CONSTRAINT "charge_units_are_positive" CHECK ("units" > 0);

ALTER TABLE "clinical"."ip_room_charges"
  ADD CONSTRAINT "charge_amounts_are_not_negative"
  CHECK ("unit_rate" >= 0 AND "amount" >= 0 AND "gst_amount" >= 0);

ALTER TABLE "clinical"."ip_room_charges"
  ADD CONSTRAINT "charge_covers_a_real_window" CHECK ("covers_to" > "covers_from");

-- An exemption states its ground. "Exempt" with no reason is a line nobody can
-- defend to a GST officer, and ICU exemption is a statutory position rather
-- than a preference.
ALTER TABLE "clinical"."ip_room_charges"
  ADD CONSTRAINT "exemption_states_its_ground"
  CHECK (NOT "is_exempt" OR "exempt_reason" IS NOT NULL);

-- Tax and exemption are opposites; a row cannot be both.
ALTER TABLE "clinical"."ip_room_charges"
  ADD CONSTRAINT "exempt_line_bears_no_tax"
  CHECK (NOT "is_exempt" OR ("gst_rate" = 0 AND "gst_amount" = 0));

-- The arithmetic, checked. A GST amount that is not the rate applied to the
-- amount is the kind of error that survives a hundred bills and then arrives
-- as an assessment.
ALTER TABLE "clinical"."ip_room_charges"
  ADD CONSTRAINT "gst_amount_follows_the_rate"
  CHECK (
    "gst_rate" = 0
    OR abs("gst_amount" - round("amount" * "gst_rate" / 100, 2)) <= 0.02
  );

-- Superseding names who did it.
ALTER TABLE "clinical"."ip_room_charges"
  ADD CONSTRAINT "supersession_is_owned"
  CHECK (("superseded_at" IS NULL) = ("superseded_by" IS NULL));


-- ── §B.2  A charge is never edited ──────────────────────────────────────────
--
-- The only mutation a posted charge accepts is being superseded. Correcting a
-- night is a new row plus a reversal on the bill, because the question a family
-- asks is "what did you charge me and why", and an edited row cannot answer the
-- first half honestly.
CREATE OR REPLACE FUNCTION clinical.refuse_editing_a_posted_charge()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF OLD.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'This charge was already superseded on %. A superseded charge is history (IP-005 §B.2).',
      OLD.superseded_at USING ERRCODE = 'IP005';
  END IF;

  -- Superseding is the one permitted change; the bill link may also be filled
  -- in after posting, because the line is written in the same transaction but
  -- the id is known second.
  IF NEW.units          IS DISTINCT FROM OLD.units
     OR NEW.unit_rate   IS DISTINCT FROM OLD.unit_rate
     OR NEW.amount      IS DISTINCT FROM OLD.amount
     OR NEW.gst_amount  IS DISTINCT FROM OLD.gst_amount
     OR NEW.charge_date IS DISTINCT FROM OLD.charge_date
     OR NEW.charge_code IS DISTINCT FROM OLD.charge_code THEN
    RAISE EXCEPTION 'A posted charge is not edited (IP-005 §B.2). Supersede it and post the correction, so "what did you charge me on %" still has an answer.',
      OLD.charge_date USING ERRCODE = 'IP005';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "posted_charge_is_immutable"
  BEFORE UPDATE ON "clinical"."ip_room_charges"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_editing_a_posted_charge();

ALTER TABLE "clinical"."ip_charge_policies"
  ADD CONSTRAINT "cutoff_is_an_hour" CHECK ("cutoff_hour" BETWEEN 0 AND 23);

ALTER TABLE "clinical"."ip_charge_policies"
  ADD CONSTRAINT "grace_is_sane"
  CHECK ("discharge_grace_minutes" BETWEEN 0 AND 1440 AND "admission_grace_minutes" BETWEEN 0 AND 1440);

ALTER TABLE "clinical"."ip_charge_policies"
  ADD CONSTRAINT "minimum_is_at_least_a_day" CHECK ("minimum_days" >= 1);


-- ── §B.3  Clearance ─────────────────────────────────────────────────────────
ALTER TABLE "clinical"."ip_discharge_clearances"
  ADD CONSTRAINT "clearance_state_is_known"
  CHECK ("state" IN ('pending', 'blocked', 'cleared'));

ALTER TABLE "clinical"."ip_discharge_clearances"
  ADD CONSTRAINT "cleared_clearance_is_owned"
  CHECK ("state" <> 'cleared' OR ("cleared_at" IS NOT NULL AND "cleared_by" IS NOT NULL));

-- A blocked clearance names what is blocking it. "Blocked" with an empty list
-- is a door somebody has to phone four departments to open.
ALTER TABLE "clinical"."ip_discharge_clearances"
  ADD CONSTRAINT "blocked_clearance_names_what"
  CHECK ("state" <> 'blocked' OR cardinality("blocked_reasons") > 0);

-- Overriding the gate is possible and costs a written reason. A patient who
-- insists on leaving is leaving; the question is whether the hospital wrote
-- down that it knew.
ALTER TABLE "clinical"."ip_discharge_clearances"
  ADD CONSTRAINT "override_states_its_grounds"
  CHECK (
    "overridden_at" IS NULL
    OR ("overridden_by" IS NOT NULL AND "override_reason" IS NOT NULL
        AND length(btrim("override_reason")) >= 12)
  );

ALTER TABLE "clinical"."ip_charge_runs"
  ADD CONSTRAINT "run_state_is_known" CHECK ("state" IN ('running', 'done', 'failed'));

ALTER TABLE "clinical"."ip_charge_runs"
  ADD CONSTRAINT "failed_run_says_why"
  CHECK ("state" <> 'failed' OR "error" IS NOT NULL);

COMMENT ON INDEX "clinical"."uq_room_charge_idempotency" IS
  'The single most important line in Phase 7C. A job that is careful not to duplicate is a job that duplicates the night somebody restarts it mid-run; this cannot. Partial on superseded_at so a correction sits beside the charge it replaced rather than erasing the answer to "what did you charge me on Tuesday".';


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
    WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory','finance','queue','engage','billing','integration','ops')
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
  WHERE n.nspname = 'clinical' AND c.relname LIKE 'ip\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 7C tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;



-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'clinical' AND c.relkind IN ('r','p') AND c.relispartition = false
      AND c.relname LIKE 'ip\_%'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % Phase 7C table(s)', v_count;
END $$;

-- A posted charge is the answer to "what did you charge me on Tuesday".
-- Deleting one destroys exactly the record a dispute needs.
REVOKE DELETE ON "clinical"."ip_room_charges" FROM hms_app;
REVOKE DELETE ON "clinical"."ip_charge_runs"  FROM hms_app;
