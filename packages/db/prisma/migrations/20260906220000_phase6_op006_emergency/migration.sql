-- ═════════════════════════════════════════════════════════════════════════════
-- OP-006 — ER intake, the ER board and dispositions
--
-- `docs/prompts/phase-06-emergency-trauma-ortho.md` §6.1, exit gates 1 and 2.
--
-- ── What the constraints are protecting ─────────────────────────────────────
--
-- **Care never waits for identity.** §B.1 requires an ER visit to carry either a
-- patient or a temporary tag — and *not* to require a patient. A patient who
-- arrives unconscious with no name is tagged, wristbanded, triaged and treated,
-- and the UHID is reconciled hours later. Parmanand Katara v. Union of India
-- (1989) makes emergency treatment a duty that cannot be conditioned on
-- formalities; a foreign key demanding a registered patient would make the
-- lawful thing unrecordable.
--
-- **Nothing here can hang a payment gate off it.** No column in these five
-- tables references a bill, a payer or a balance. That is the strongest form the
-- guarantee takes: not that the check is skipped, but that there is nowhere to
-- put one.
--
-- **A bay holds one patient.** §B.2 is a partial unique index rather than a
-- service check, because the failure it prevents is two patients assigned to one
-- trolley during a surge — exactly when the service layer is under most load and
-- the staff are least able to notice.
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
CREATE TYPE "clinical"."ErZoneKind" AS ENUM ('resus', 'acute', 'fast_track', 'observation', 'paediatric', 'isolation', 'decontamination', 'triage', 'waiting');

-- CreateEnum
CREATE TYPE "clinical"."ErBayKind" AS ENUM ('resus_bay', 'trolley', 'chair', 'wheelchair', 'cubicle', 'isolation_room');

-- CreateEnum
CREATE TYPE "clinical"."ErBayStatus" AS ENUM ('free', 'occupied', 'cleaning', 'blocked', 'out_of_service');

-- CreateEnum
CREATE TYPE "clinical"."ErArrivalMode" AS ENUM ('walk_in', 'ambulance', 'police', 'referred', 'transfer', 'mci', 'brought_dead');

-- CreateEnum
CREATE TYPE "clinical"."ErVisitStatus" AS ENUM ('inbound', 'arrived', 'triaged', 'in_treatment', 'boarding', 'disposition_pending', 'departed');

-- CreateEnum
CREATE TYPE "clinical"."ErDispositionKind" AS ENUM ('admit', 'discharge', 'refer_out', 'lama', 'absconded', 'death', 'observation', 'brought_dead');

-- AlterTable

-- CreateTable
CREATE TABLE "clinical"."er_zones" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" "clinical"."ErZoneKind" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "er_zones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."er_bays" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "kind" "clinical"."ErBayKind" NOT NULL DEFAULT 'trolley',
    "barcode" VARCHAR(64),
    "status" "clinical"."ErBayStatus" NOT NULL DEFAULT 'free',
    "current_visit_id" UUID,
    "has_monitor" BOOLEAN NOT NULL DEFAULT false,
    "has_ventilator" BOOLEAN NOT NULL DEFAULT false,
    "has_oxygen" BOOLEAN NOT NULL DEFAULT true,
    "vacated_at" TIMESTAMPTZ(6),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "er_bays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."er_visits" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "er_no" VARCHAR(40) NOT NULL,
    "patient_id" UUID,
    "temp_identity" VARCHAR(40),
    "display_name" VARCHAR(200),
    "approximate_age" INTEGER,
    "gender" VARCHAR(16),
    "photo_file_id" UUID,
    "encounter_id" UUID,
    "arrival_mode" "clinical"."ErArrivalMode" NOT NULL,
    "brought_by" VARCHAR(200),
    "brought_by_phone" VARCHAR(20),
    "pre_hospital_ref" UUID,
    "ambulance_ref" VARCHAR(40),
    "chief_complaint" TEXT,
    "mlc_suspected" BOOLEAN NOT NULL DEFAULT false,
    "mlc_ref" UUID,
    "esi_level" INTEGER,
    "triaged_at" TIMESTAMPTZ(6),
    "target_seen_by" TIMESTAMPTZ(6),
    "zone_id" UUID,
    "bay_id" UUID,
    "status" "clinical"."ErVisitStatus" NOT NULL DEFAULT 'arrived',
    "expected_at" TIMESTAMPTZ(6),
    "arrived_at" TIMESTAMPTZ(6),
    "first_seen_at" TIMESTAMPTZ(6),
    "disposition_at" TIMESTAMPTZ(6),
    "departed_at" TIMESTAMPTZ(6),
    "is_unidentified" BOOLEAN NOT NULL DEFAULT false,
    "merged_into_patient_id" UUID,
    "merged_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "er_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."er_bay_movements" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "bay_id" UUID NOT NULL,
    "moved_in_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "moved_out_at" TIMESTAMPTZ(6),
    "method" VARCHAR(16) NOT NULL DEFAULT 'assigned',
    "reason" TEXT,
    "by_id" UUID,

    CONSTRAINT "er_bay_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."er_dispositions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "kind" "clinical"."ErDispositionKind" NOT NULL,
    "admission_request_id" UUID,
    "admit_ward_hint" VARCHAR(80),
    "referred_to_facility" VARCHAR(200),
    "referral_reason" TEXT,
    "transport_mode" VARCHAR(40),
    "lama_witness_name" VARCHAR(200),
    "lama_witness_relation" VARCHAR(80),
    "lama_risks_explained" BOOLEAN NOT NULL DEFAULT false,
    "death_at" TIMESTAMPTZ(6),
    "death_cause_text" TEXT,
    "body_released_at" TIMESTAMPTZ(6),
    "summary_text" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "er_dispositions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "er_zones_hospital_id_branch_id_is_active_sort_order_idx" ON "clinical"."er_zones"("hospital_id", "branch_id", "is_active", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "er_zones_hospital_id_branch_id_code_key" ON "clinical"."er_zones"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "er_bays_hospital_id_branch_id_status_idx" ON "clinical"."er_bays"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "er_bays_hospital_id_barcode_idx" ON "clinical"."er_bays"("hospital_id", "barcode");

-- CreateIndex
CREATE UNIQUE INDEX "er_bays_hospital_id_branch_id_code_key" ON "clinical"."er_bays"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "er_visits_hospital_id_branch_id_status_esi_level_arrived_at_idx" ON "clinical"."er_visits"("hospital_id", "branch_id", "status", "esi_level", "arrived_at");

-- CreateIndex
CREATE INDEX "er_visits_hospital_id_patient_id_arrived_at_idx" ON "clinical"."er_visits"("hospital_id", "patient_id", "arrived_at" DESC);

-- CreateIndex
CREATE INDEX "er_visits_hospital_id_branch_id_arrived_at_idx" ON "clinical"."er_visits"("hospital_id", "branch_id", "arrived_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "er_visits_hospital_id_er_no_key" ON "clinical"."er_visits"("hospital_id", "er_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_er_visit_temp_identity" ON "clinical"."er_visits"("hospital_id", "temp_identity");

-- CreateIndex
CREATE INDEX "er_bay_movements_hospital_id_visit_id_moved_in_at_idx" ON "clinical"."er_bay_movements"("hospital_id", "visit_id", "moved_in_at");

-- CreateIndex
CREATE INDEX "er_bay_movements_hospital_id_bay_id_moved_in_at_idx" ON "clinical"."er_bay_movements"("hospital_id", "bay_id", "moved_in_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "er_dispositions_visit_id_key" ON "clinical"."er_dispositions"("visit_id");

-- CreateIndex
CREATE INDEX "er_dispositions_hospital_id_kind_decided_at_idx" ON "clinical"."er_dispositions"("hospital_id", "kind", "decided_at" DESC);

-- AddForeignKey
ALTER TABLE "clinical"."er_bays" ADD CONSTRAINT "er_bays_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "clinical"."er_zones"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."er_bay_movements" ADD CONSTRAINT "er_bay_movements_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "clinical"."er_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."er_bay_movements" ADD CONSTRAINT "er_bay_movements_bay_id_fkey" FOREIGN KEY ("bay_id") REFERENCES "clinical"."er_bays"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."er_dispositions" ADD CONSTRAINT "er_dispositions_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "clinical"."er_visits"("id") ON DELETE CASCADE ON UPDATE CASCADE;



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
  WHERE n.nspname = 'clinical' AND c.relname LIKE 'er\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'OP-006 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── B.1  SOMEBODY IS ALWAYS IDENTIFIABLE, AND NOBODY HAS TO BE REGISTERED ───
--
-- One of a patient id and a temporary tag, always. Never neither — a visit
-- nobody can be matched to is a record that helps no one — and never a
-- requirement for a UHID, because the patient on the trolley at 3 a.m. may not
-- be able to tell anyone their name and treatment cannot wait for that.
ALTER TABLE "clinical"."er_visits"
  ADD CONSTRAINT "er_visit_has_an_identity"
  CHECK ("patient_id" IS NOT NULL OR "temp_identity" IS NOT NULL);

-- An unidentified visit carries the tag. Clearing the flag without resolving to
-- a patient would leave a record nobody can attach to anybody.
ALTER TABLE "clinical"."er_visits"
  ADD CONSTRAINT "er_visit_unidentified_has_a_tag"
  CHECK (NOT "is_unidentified" OR "temp_identity" IS NOT NULL);

-- The merge resolves the tag to a real patient and says when. Exit gate 2 turns
-- on the ER number surviving it, so the merge adds a patient rather than
-- replacing the record.
ALTER TABLE "clinical"."er_visits"
  ADD CONSTRAINT "er_visit_merge_is_complete"
  CHECK ("merged_into_patient_id" IS NULL
         OR ("merged_at" IS NOT NULL AND "patient_id" IS NOT NULL AND NOT "is_unidentified"));


-- ── B.2  A BAY HOLDS ONE PATIENT ────────────────────────────────────────────
--
-- A partial unique index rather than a service check. The failure it prevents —
-- two patients assigned to one trolley — happens during a surge, which is
-- exactly when the service layer is busiest and the staff least able to notice.
CREATE UNIQUE INDEX "uq_er_bay_one_occupant"
  ON "clinical"."er_bays" ("id")
  WHERE "current_visit_id" IS NOT NULL AND status = 'occupied';

CREATE UNIQUE INDEX "uq_er_visit_one_bay"
  ON "clinical"."er_bays" ("hospital_id", "current_visit_id")
  WHERE "current_visit_id" IS NOT NULL;

-- An occupied bay names its occupant, and a free one does not.
ALTER TABLE "clinical"."er_bays"
  ADD CONSTRAINT "er_bay_occupancy_is_coherent"
  CHECK ((status = 'occupied') = ("current_visit_id" IS NOT NULL));

-- A patient is in one bay at a time: at most one movement without an exit.
CREATE UNIQUE INDEX "uq_er_movement_one_open_per_visit"
  ON "clinical"."er_bay_movements" ("visit_id")
  WHERE "moved_out_at" IS NULL;

ALTER TABLE "clinical"."er_bay_movements"
  ADD CONSTRAINT "er_movement_out_after_in"
  CHECK ("moved_out_at" IS NULL OR "moved_out_at" >= "moved_in_at");


-- ── B.3  the clock runs forward ─────────────────────────────────────────────
--
-- ER length of stay, door-to-doctor and the ESI target timers are all derived
-- from these, and a negative interval on a dashboard is worse than none — it
-- gets averaged into a number somebody reports to NABH.
ALTER TABLE "clinical"."er_visits"
  ADD CONSTRAINT "er_visit_timestamps_ordered"
  CHECK (("first_seen_at" IS NULL OR "arrived_at" IS NULL OR "first_seen_at" >= "arrived_at")
     AND ("disposition_at" IS NULL OR "arrived_at" IS NULL OR "disposition_at" >= "arrived_at")
     AND ("departed_at" IS NULL OR "disposition_at" IS NULL OR "departed_at" >= "disposition_at"));

-- An inbound pre-alert has an ETA and has not arrived; anything else has.
ALTER TABLE "clinical"."er_visits"
  ADD CONSTRAINT "er_visit_arrival_matches_status"
  CHECK ((status = 'inbound' AND "arrived_at" IS NULL)
      OR (status <> 'inbound' AND "arrived_at" IS NOT NULL));

ALTER TABLE "clinical"."er_visits"
  ADD CONSTRAINT "er_visit_triage_is_complete"
  CHECK (("esi_level" IS NULL) = ("triaged_at" IS NULL));

ALTER TABLE "clinical"."er_visits"
  ADD CONSTRAINT "er_visit_esi_in_range"
  CHECK ("esi_level" IS NULL OR ("esi_level" >= 1 AND "esi_level" <= 5));

ALTER TABLE "clinical"."er_visits"
  ADD CONSTRAINT "er_visit_age_plausible"
  CHECK ("approximate_age" IS NULL OR ("approximate_age" >= 0 AND "approximate_age" <= 130));


-- ── B.4  a disposition carries what that decision requires ──────────────────
--
-- Each of these is a real failure. A LAMA with no witness is a discharge nobody
-- can defend when the patient deteriorates at home. A referral with no
-- destination is a patient sent into the night. A death with no time makes the
-- certificate unissuable.
ALTER TABLE "clinical"."er_dispositions"
  ADD CONSTRAINT "er_disposition_lama_is_witnessed"
  CHECK (kind <> 'lama'
         OR ("lama_witness_name" IS NOT NULL AND "lama_risks_explained"));

ALTER TABLE "clinical"."er_dispositions"
  ADD CONSTRAINT "er_disposition_referral_names_where"
  CHECK (kind <> 'refer_out'
         OR ("referred_to_facility" IS NOT NULL AND "referral_reason" IS NOT NULL));

ALTER TABLE "clinical"."er_dispositions"
  ADD CONSTRAINT "er_disposition_death_has_a_time"
  CHECK (kind NOT IN ('death', 'brought_dead') OR "death_at" IS NOT NULL);

ALTER TABLE "clinical"."er_dispositions"
  ADD CONSTRAINT "er_disposition_admit_names_the_request"
  CHECK (kind <> 'admit' OR "admission_request_id" IS NOT NULL);

ALTER TABLE "clinical"."er_dispositions"
  ADD CONSTRAINT "er_disposition_body_release_after_death"
  CHECK ("body_released_at" IS NULL OR ("death_at" IS NOT NULL AND "body_released_at" >= "death_at"));


-- ── B.5  a decided visit does not move ──────────────────────────────────────
--
-- Once a disposition exists the episode is over. Reassigning a bay afterwards
-- would put a departed patient back on the board and take a trolley out of the
-- count during a surge.
CREATE OR REPLACE FUNCTION "clinical".refuse_moving_a_decided_er_visit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM clinical.er_dispositions d WHERE d.visit_id = NEW.visit_id) THEN
    RAISE EXCEPTION
      'This ER visit already has a disposition (OP-006 §B.5). Reassigning a bay now would put a departed patient back on the board and hold a trolley that is free.'
      USING ERRCODE = 'OP006';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "er_bay_movements_not_after_disposition"
  BEFORE INSERT ON "clinical"."er_bay_movements"
  FOR EACH ROW EXECUTE FUNCTION "clinical".refuse_moving_a_decided_er_visit();


-- ── B.6  zones and bays ─────────────────────────────────────────────────────
ALTER TABLE "clinical"."er_bays"
  ADD CONSTRAINT "er_bay_vacated_is_dirty_or_free"
  CHECK ("vacated_at" IS NULL OR status <> 'occupied');

COMMENT ON COLUMN "clinical"."er_visits"."patient_id" IS
  'Nullable on purpose. Parmanand Katara v. Union of India (1989): emergency treatment cannot be conditioned on formalities, so an unconscious patient with no name is tagged, triaged and treated, and the UHID is reconciled later.';

COMMENT ON COLUMN "clinical"."er_visits"."esi_level" IS
  'Denormalised from TR-001 in the same transaction as the triage record. The board is the busiest read in the hospital at 3 a.m. and sorts strictly by this then arrival time; a join here is one that gets slow on the night it matters.';

COMMENT ON TABLE "clinical"."er_visits" IS
  'No column in this table references a bill, a payer or a balance. There is nowhere to hang a "pay first" gate, which is a stronger guarantee than skipping the check.';


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
      AND c.relname NOT LIKE '\_prisma%'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % OP-006 table(s)', v_count;
END $$;

-- An ER visit and its disposition are clinical record. `docs/03`: clinical rows
-- are never hard-deleted.
REVOKE DELETE ON "clinical"."er_visits"        FROM hms_app;
REVOKE DELETE ON "clinical"."er_dispositions"  FROM hms_app;
REVOKE DELETE ON "clinical"."er_bay_movements" FROM hms_app;
