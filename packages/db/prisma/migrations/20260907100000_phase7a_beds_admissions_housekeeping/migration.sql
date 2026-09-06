-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 7A · IP-001 + IP-018 + NC-018 + IP-025
-- Beds, admissions, transfers, cleaning, and the board that shows them
-- ═════════════════════════════════════════════════════════════════════════════
--
-- §A  Tables (generated)
-- §B  The rules, as database shapes
-- §C  Grants
-- §D  Row-level security
--
-- ── §B, in one page ─────────────────────────────────────────────────────────
--
--   B.1  One patient per bed at one moment. A GiST exclusion constraint on
--        (bed, time range) — the last line of defence behind
--        `FOR UPDATE SKIP LOCKED`, and the reason fifty concurrent claims on
--        one bed produce exactly one admission.
--   B.2  A bed cannot become `available` without a cleaning confirmation. The
--        turnover rule NC-018 exists for; overriding it takes a stated reason.
--   B.3  An occupancy ends after it begins, and an admission is discharged
--        after it is admitted.
--   B.4  A discharged admission holds no open occupancy. A patient who has left
--        cannot still be in a bed.
--   B.5  A hold expires; it cannot be created already expired, and a released
--        hold says why.
--   B.6  A blocked bed states its reason.
--
-- ── The board is derived ────────────────────────────────────────────────────
--
-- There is no `beds_free` column in this migration and there will not be one.
-- `clinical.v_bed_board` is a view over `ip_bed_occupancies`, rebuildable from
-- nothing, and `phase-07` requires a test that rebuilds it and asserts it
-- matches. A hand-maintained counter drifts the first time a transaction rolls
-- back after incrementing it, and the drift is invisible until somebody is sent
-- to a bed with a patient in it.
--
-- Custom SQLSTATE: IP001.

-- CreateEnum
CREATE TYPE "clinical"."BedStatus" AS ENUM ('available', 'occupied', 'reserved', 'cleaning', 'blocked', 'retired');

-- CreateEnum
CREATE TYPE "clinical"."AdmissionStatus" AS ENUM ('requested', 'admitted', 'on_leave', 'discharge_initiated', 'discharged', 'cancelled', 'closed_other');

-- CreateEnum
CREATE TYPE "clinical"."AdmissionKind" AS ENUM ('elective', 'emergency', 'day_care', 'observation', 'er_fast_track', 'transfer_in', 'newborn');

-- CreateEnum
CREATE TYPE "clinical"."HoldReason" AS ENUM ('er_disposition', 'elective_booking', 'ot_return', 'icu_return', 'transfer_in', 'other');

-- CreateEnum
CREATE TYPE "clinical"."CleaningState" AS ENUM ('requested', 'accepted', 'in_progress', 'done', 'inspected', 'failed');

-- CreateTable
CREATE TABLE "clinical"."ip_buildings" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_buildings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_wards" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "building_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "floor" VARCHAR(20) NOT NULL,
    "ward_type" VARCHAR(24) NOT NULL,
    "cleaning_sla_minutes" INTEGER NOT NULL DEFAULT 60,
    "sex_policy" VARCHAR(10) NOT NULL DEFAULT 'any',
    "min_age_years" INTEGER,
    "max_age_years" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_wards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_bed_classes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "tariff_service_id" UUID,
    "tier" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_bed_classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_rooms" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(80),
    "is_shared" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_beds" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "ward_id" UUID NOT NULL,
    "room_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "status" "clinical"."BedStatus" NOT NULL DEFAULT 'available',
    "isolation_capable" BOOLEAN NOT NULL DEFAULT false,
    "has_oxygen_point" BOOLEAN NOT NULL DEFAULT true,
    "has_monitor" BOOLEAN NOT NULL DEFAULT false,
    "has_ventilator_point" BOOLEAN NOT NULL DEFAULT false,
    "has_attendant_bed" BOOLEAN NOT NULL DEFAULT false,
    "block_reason" TEXT,
    "blocked_at" TIMESTAMPTZ(6),
    "blocked_by" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_beds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_admissions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "er_visit_id" UUID,
    "opd_visit_id" UUID,
    "ip_no" VARCHAR(60) NOT NULL,
    "kind" "clinical"."AdmissionKind" NOT NULL,
    "status" "clinical"."AdmissionStatus" NOT NULL DEFAULT 'requested',
    "registration_complete" BOOLEAN NOT NULL DEFAULT true,
    "attending_doctor_id" UUID,
    "admitting_doctor_id" UUID,
    "department" VARCHAR(60),
    "provisional_diagnosis" TEXT,
    "icd10" VARCHAR(20),
    "entitled_class_id" UUID,
    "payer_id" UUID,
    "preauth_case_id" UUID,
    "package_id" UUID,
    "deposit_suggested" DECIMAL(14,2),
    "deposit_taken" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deposit_approval_id" UUID,
    "consent_id" UUID,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by" UUID,
    "admitted_at" TIMESTAMPTZ(6),
    "admitted_by" UUID,
    "expected_discharge_at" TIMESTAMPTZ(6),
    "discharged_at" TIMESTAMPTZ(6),
    "discharged_by" UUID,
    "outcome" VARCHAR(24),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_bed_occupancies" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "bed_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "from_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "to_at" TIMESTAMPTZ(6),
    "end_reason" VARCHAR(24),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_bed_occupancies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_bed_holds" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "bed_id" UUID NOT NULL,
    "admission_id" UUID,
    "patient_id" UUID,
    "reason" "clinical"."HoldReason" NOT NULL,
    "held_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "held_by" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "released_at" TIMESTAMPTZ(6),
    "released_by" UUID,
    "release_reason" VARCHAR(24),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_bed_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_bed_transfers" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "from_bed_id" UUID,
    "to_bed_id" UUID,
    "from_class_id" UUID,
    "to_class_id" UUID,
    "kind" VARCHAR(24) NOT NULL,
    "reason" TEXT NOT NULL,
    "situation" TEXT,
    "background" TEXT,
    "assessment" TEXT,
    "recommendation" TEXT,
    "lines_and_tubes" TEXT[],
    "infusions" TEXT[],
    "pending_results" TEXT[],
    "allergies" TEXT[],
    "destination_facility" VARCHAR(200),
    "stability_note" TEXT,
    "documents_pack" TEXT[],
    "handed_over_by" UUID,
    "accepted_by" UUID,
    "accepted_at" TIMESTAMPTZ(6),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_bed_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_cleaning_tasks" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "bed_id" UUID NOT NULL,
    "kind" VARCHAR(20) NOT NULL DEFAULT 'terminal',
    "state" "clinical"."CleaningState" NOT NULL DEFAULT 'requested',
    "sla_minutes" INTEGER NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "accepted_by" UUID,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "completed_by" UUID,
    "inspected_at" TIMESTAMPTZ(6),
    "inspected_by" UUID,
    "fail_reason" TEXT,
    "checklist" JSONB,
    "escalated_at" TIMESTAMPTZ(6),
    "escalated_to" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_cleaning_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ip_buildings_hospital_id_branch_id_idx" ON "clinical"."ip_buildings"("hospital_id", "branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_building_code" ON "clinical"."ip_buildings"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "ip_wards_hospital_id_branch_id_ward_type_idx" ON "clinical"."ip_wards"("hospital_id", "branch_id", "ward_type");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ward_code" ON "clinical"."ip_wards"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bed_class_code" ON "clinical"."ip_bed_classes"("hospital_id", "code");

-- CreateIndex
CREATE INDEX "ip_rooms_hospital_id_ward_id_idx" ON "clinical"."ip_rooms"("hospital_id", "ward_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_room_code" ON "clinical"."ip_rooms"("hospital_id", "ward_id", "code");

-- CreateIndex
CREATE INDEX "ip_beds_hospital_id_branch_id_ward_id_status_idx" ON "clinical"."ip_beds"("hospital_id", "branch_id", "ward_id", "status");

-- CreateIndex
CREATE INDEX "ip_beds_hospital_id_status_class_id_idx" ON "clinical"."ip_beds"("hospital_id", "status", "class_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_bed_code" ON "clinical"."ip_beds"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "ip_admissions_hospital_id_branch_id_status_admitted_at_idx" ON "clinical"."ip_admissions"("hospital_id", "branch_id", "status", "admitted_at" DESC);

-- CreateIndex
CREATE INDEX "ip_admissions_hospital_id_patient_id_idx" ON "clinical"."ip_admissions"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "ip_admissions_hospital_id_er_visit_id_idx" ON "clinical"."ip_admissions"("hospital_id", "er_visit_id");

-- CreateIndex
CREATE INDEX "ip_admissions_hospital_id_expected_discharge_at_idx" ON "clinical"."ip_admissions"("hospital_id", "expected_discharge_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_admission_ip_no" ON "clinical"."ip_admissions"("hospital_id", "ip_no");

-- CreateIndex
CREATE INDEX "ip_bed_occupancies_hospital_id_branch_id_bed_id_from_at_idx" ON "clinical"."ip_bed_occupancies"("hospital_id", "branch_id", "bed_id", "from_at" DESC);

-- CreateIndex
CREATE INDEX "ip_bed_occupancies_hospital_id_admission_id_from_at_idx" ON "clinical"."ip_bed_occupancies"("hospital_id", "admission_id", "from_at");

-- CreateIndex
CREATE INDEX "ip_bed_holds_hospital_id_branch_id_expires_at_idx" ON "clinical"."ip_bed_holds"("hospital_id", "branch_id", "expires_at");

-- CreateIndex
CREATE INDEX "ip_bed_holds_hospital_id_bed_id_released_at_idx" ON "clinical"."ip_bed_holds"("hospital_id", "bed_id", "released_at");

-- CreateIndex
CREATE INDEX "ip_bed_transfers_hospital_id_branch_id_at_idx" ON "clinical"."ip_bed_transfers"("hospital_id", "branch_id", "at" DESC);

-- CreateIndex
CREATE INDEX "ip_bed_transfers_hospital_id_admission_id_at_idx" ON "clinical"."ip_bed_transfers"("hospital_id", "admission_id", "at");

-- CreateIndex
CREATE INDEX "ip_cleaning_tasks_hospital_id_branch_id_state_due_at_idx" ON "clinical"."ip_cleaning_tasks"("hospital_id", "branch_id", "state", "due_at");

-- CreateIndex
CREATE INDEX "ip_cleaning_tasks_hospital_id_bed_id_requested_at_idx" ON "clinical"."ip_cleaning_tasks"("hospital_id", "bed_id", "requested_at" DESC);

-- AddForeignKey
ALTER TABLE "clinical"."ip_wards" ADD CONSTRAINT "ip_wards_building_id_fkey" FOREIGN KEY ("building_id") REFERENCES "clinical"."ip_buildings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_rooms" ADD CONSTRAINT "ip_rooms_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "clinical"."ip_wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_rooms" ADD CONSTRAINT "ip_rooms_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "clinical"."ip_bed_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_beds" ADD CONSTRAINT "ip_beds_ward_id_fkey" FOREIGN KEY ("ward_id") REFERENCES "clinical"."ip_wards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_beds" ADD CONSTRAINT "ip_beds_room_id_fkey" FOREIGN KEY ("room_id") REFERENCES "clinical"."ip_rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_beds" ADD CONSTRAINT "ip_beds_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "clinical"."ip_bed_classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_bed_occupancies" ADD CONSTRAINT "ip_bed_occupancies_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "clinical"."ip_admissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_bed_occupancies" ADD CONSTRAINT "ip_bed_occupancies_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "clinical"."ip_beds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_bed_holds" ADD CONSTRAINT "ip_bed_holds_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "clinical"."ip_beds"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_bed_holds" ADD CONSTRAINT "ip_bed_holds_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "clinical"."ip_admissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_bed_transfers" ADD CONSTRAINT "ip_bed_transfers_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "clinical"."ip_admissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_cleaning_tasks" ADD CONSTRAINT "ip_cleaning_tasks_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "clinical"."ip_beds"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  One patient per bed, at one moment ────────────────────────────────
--
-- The allocation path takes `FOR UPDATE SKIP LOCKED` on the bed row, so in the
-- ordinary case two claims never collide. This constraint is what happens when
-- the ordinary case does not hold: a back-dated correction, a second process
-- that forgot the lock, a hand-written INSERT during a migration. `phase-07`
-- exit gate 1 fires fifty concurrent claims at one bed and requires exactly one
-- to succeed; the lock makes that fast, and this makes it true.
--
-- `[)` — half-open. A patient leaving a bed at 14:00 and another arriving at
-- 14:00 is a normal turnover, not an overlap. Closed-closed would refuse it and
-- send somebody looking for a bug that is not there.
ALTER TABLE "clinical"."ip_bed_occupancies"
  ADD CONSTRAINT "one_patient_per_bed"
  EXCLUDE USING gist (
    "bed_id" WITH =,
    tstzrange("from_at", "to_at", '[)') WITH &&
  );

ALTER TABLE "clinical"."ip_bed_occupancies"
  ADD CONSTRAINT "occupancy_ends_after_it_starts"
  CHECK ("to_at" IS NULL OR "to_at" > "from_at");

-- Closing an occupancy says why. `transfer` and `discharge` price differently
-- and read differently on a census, and "it just ended" is neither.
ALTER TABLE "clinical"."ip_bed_occupancies"
  ADD CONSTRAINT "closed_occupancy_says_why"
  CHECK ("to_at" IS NULL OR "end_reason" IS NOT NULL);


-- ── §B.2  A bed is not available until somebody has cleaned it ──────────────
--
-- The rule NC-018 exists for. A bed that goes straight from `occupied` to
-- `available` is a bed the next patient is put into unmade, and it happens
-- because the board is what the porter looks at and the board was quicker to
-- update than the cleaning was to do.
--
-- Overriding is possible — a bed vacated for five minutes for an X-ray does not
-- need a terminal clean — and costs a stated reason recorded against the bed.
CREATE OR REPLACE FUNCTION clinical.assert_bed_was_cleaned()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_open int; v_done timestamptz;
BEGIN
  IF NEW.status <> 'available' OR OLD.status = 'available' THEN RETURN NEW; END IF;
  -- Coming back from `blocked` or `reserved` is not a turnover; nobody has been
  -- in the bed, so there is nothing to clean.
  IF OLD.status IN ('blocked', 'reserved', 'retired') THEN RETURN NEW; END IF;

  SELECT count(*) FILTER (WHERE state NOT IN ('done', 'inspected')),
         max(COALESCE(inspected_at, completed_at))
    INTO v_open, v_done
    FROM clinical.cleaning_recent(NEW.id);

  IF v_done IS NULL OR v_open > 0 THEN
    -- The override: a reason written on the bed at the moment of the change.
    IF NEW.block_reason IS NULL OR length(btrim(NEW.block_reason)) < 8 THEN
      RAISE EXCEPTION 'Bed % has not been confirmed clean (NC-018 §B.2). A bed that goes from occupied to available without a clean is a bed the next patient is put into unmade. Complete the cleaning task, or state why this bed needs no clean.',
        NEW.code USING ERRCODE = 'IP001';
    END IF;
  END IF;

  RETURN NEW;
END $$;

-- The most recent turnover's cleaning tasks. A function rather than an inline
-- subquery so the trigger reads as the sentence it is.
CREATE OR REPLACE FUNCTION clinical.cleaning_recent(p_bed_id uuid)
RETURNS TABLE (state text, completed_at timestamptz, inspected_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
  SELECT t.state::text, t.completed_at, t.inspected_at
    FROM clinical.ip_cleaning_tasks t
   WHERE t.bed_id = p_bed_id
     AND t.requested_at > now() - interval '7 days'
   ORDER BY t.requested_at DESC
   LIMIT 5;
$$;

CREATE TRIGGER "bed_is_cleaned_before_it_is_available"
  BEFORE UPDATE OF status ON "clinical"."ip_beds"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_bed_was_cleaned();

ALTER TABLE "clinical"."ip_beds"
  ADD CONSTRAINT "blocked_bed_says_why"
  CHECK ("status" <> 'blocked' OR ("block_reason" IS NOT NULL AND length(btrim("block_reason")) >= 4));


-- ── §B.3 / §B.4  An admission's timeline, and its bed ───────────────────────
ALTER TABLE "clinical"."ip_admissions"
  ADD CONSTRAINT "discharge_after_admission"
  CHECK ("discharged_at" IS NULL OR ("admitted_at" IS NOT NULL AND "discharged_at" >= "admitted_at"));

ALTER TABLE "clinical"."ip_admissions"
  ADD CONSTRAINT "admitted_admission_has_a_time"
  CHECK ("status" IN ('requested', 'cancelled') OR "admitted_at" IS NOT NULL);

ALTER TABLE "clinical"."ip_admissions"
  ADD CONSTRAINT "discharged_admission_has_an_outcome"
  CHECK ("status" <> 'discharged' OR ("discharged_at" IS NOT NULL AND "outcome" IS NOT NULL));

ALTER TABLE "clinical"."ip_admissions"
  ADD CONSTRAINT "deposit_is_not_negative"
  CHECK ("deposit_taken" >= 0 AND ("deposit_suggested" IS NULL OR "deposit_suggested" >= 0));

-- A patient who has left is not in a bed.
--
-- Deferred, because discharging is two writes — close the occupancy, mark the
-- admission — and either order is legitimate. Checking immediately would make
-- the correct code depend on which statement came first.
CREATE OR REPLACE FUNCTION clinical.assert_discharged_holds_no_bed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_bed text;
BEGIN
  IF NEW.status <> 'discharged' THEN RETURN NULL; END IF;

  SELECT b.code INTO v_bed
    FROM clinical.ip_bed_occupancies o
    JOIN clinical.ip_beds b ON b.id = o.bed_id
   WHERE o.admission_id = NEW.id AND o.to_at IS NULL
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Admission % is discharged and still occupies bed % (IP-001 §B.4). Close the occupancy in the same transaction, or the census will show a patient who has gone home.',
      NEW.ip_no, v_bed USING ERRCODE = 'IP001';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "discharged_admission_holds_no_bed"
  AFTER INSERT OR UPDATE ON "clinical"."ip_admissions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_discharged_holds_no_bed();


-- ── §B.5  Holds ─────────────────────────────────────────────────────────────
ALTER TABLE "clinical"."ip_bed_holds"
  ADD CONSTRAINT "hold_expires_after_it_is_taken"
  CHECK ("expires_at" > "held_at");

ALTER TABLE "clinical"."ip_bed_holds"
  ADD CONSTRAINT "released_hold_says_why"
  CHECK ("released_at" IS NULL OR "release_reason" IS NOT NULL);

-- One live hold per bed. Two people each told the bed is theirs is the same
-- failure as two patients in it, discovered slightly earlier.
CREATE UNIQUE INDEX "uq_one_live_hold_per_bed"
  ON "clinical"."ip_bed_holds" ("bed_id")
  WHERE "released_at" IS NULL;


-- ── §B.6  Cleaning ──────────────────────────────────────────────────────────
ALTER TABLE "clinical"."ip_cleaning_tasks"
  ADD CONSTRAINT "cleaning_sla_is_positive" CHECK ("sla_minutes" BETWEEN 1 AND 1440);

ALTER TABLE "clinical"."ip_cleaning_tasks"
  ADD CONSTRAINT "completed_cleaning_is_owned"
  CHECK ("state" NOT IN ('done', 'inspected') OR ("completed_at" IS NOT NULL AND "completed_by" IS NOT NULL));

ALTER TABLE "clinical"."ip_cleaning_tasks"
  ADD CONSTRAINT "failed_cleaning_says_why"
  CHECK ("state" <> 'failed' OR ("fail_reason" IS NOT NULL AND length(btrim("fail_reason")) >= 4));

-- The due time is the database's arithmetic, for the same reason a consult's is.
CREATE OR REPLACE FUNCTION clinical.set_cleaning_due_at()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  NEW.due_at := NEW.requested_at + make_interval(mins => NEW.sla_minutes);
  RETURN NEW;
END $$;

CREATE TRIGGER "cleaning_due_at_is_computed"
  BEFORE INSERT OR UPDATE OF requested_at, sla_minutes ON "clinical"."ip_cleaning_tasks"
  FOR EACH ROW EXECUTE FUNCTION clinical.set_cleaning_due_at();


-- ═════════════════════════════════════════════════════════════════════════════
-- §B.7  THE BED BOARD, AS A VIEW
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Derived from `ip_bed_occupancies` every time it is read. `phase-07` exit gate
-- 2 rebuilds the board from the admissions tables and asserts it matches the
-- live board — which is trivially true when the board *is* the query, and that
-- is the point of writing it this way rather than maintaining a counter.
CREATE OR REPLACE VIEW clinical.v_bed_board AS
SELECT b.hospital_id,
       b.branch_id,
       b.id            AS bed_id,
       b.code          AS bed_code,
       b.status,
       w.id            AS ward_id,
       w.code          AS ward_code,
       w.name          AS ward_name,
       w.ward_type,
       r.id            AS room_id,
       r.code          AS room_code,
       c.id            AS class_id,
       c.code          AS class_code,
       c.tier,
       b.isolation_capable,
       b.has_oxygen_point,
       b.has_monitor,
       b.has_ventilator_point,
       b.has_attendant_bed,
       o.id            AS occupancy_id,
       o.admission_id,
       o.patient_id,
       o.from_at       AS occupied_since,
       a.ip_no,
       a.expected_discharge_at,
       a.attending_doctor_id,
       h.id            AS hold_id,
       h.expires_at    AS hold_expires_at,
       h.reason::text  AS hold_reason,
       t.id            AS cleaning_task_id,
       t.state::text   AS cleaning_state,
       t.due_at        AS cleaning_due_at,
       (t.id IS NOT NULL AND t.state NOT IN ('done', 'inspected') AND t.due_at < now()) AS cleaning_breached
  FROM clinical.ip_beds b
  JOIN clinical.ip_wards w      ON w.id = b.ward_id
  JOIN clinical.ip_rooms r      ON r.id = b.room_id
  JOIN clinical.ip_bed_classes c ON c.id = b.class_id
  LEFT JOIN clinical.ip_bed_occupancies o
         ON o.bed_id = b.id AND o.to_at IS NULL
  LEFT JOIN clinical.ip_admissions a ON a.id = o.admission_id
  LEFT JOIN clinical.ip_bed_holds h
         ON h.bed_id = b.id AND h.released_at IS NULL AND h.expires_at > now()
  LEFT JOIN LATERAL (
    SELECT ct.id, ct.state, ct.due_at
      FROM clinical.ip_cleaning_tasks ct
     WHERE ct.bed_id = b.id AND ct.state NOT IN ('done', 'inspected')
     ORDER BY ct.requested_at DESC
     LIMIT 1
  ) t ON true
 WHERE b.is_active;

COMMENT ON VIEW clinical.v_bed_board IS
  'The bed board, derived. There is no beds_free counter anywhere in this system: a counter drifts the first time a transaction rolls back after incrementing it, and the drift is invisible until somebody is sent to a bed with a patient in it.';

COMMENT ON CONSTRAINT "one_patient_per_bed" ON "clinical"."ip_bed_occupancies" IS
  'The last line of defence behind FOR UPDATE SKIP LOCKED. Fifty concurrent claims on one bed produce exactly one admission: the lock makes that fast, and this makes it true.';


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
    RAISE EXCEPTION 'Phase 7A tables without RLS or a tenant policy: %', v_missing;
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
  RAISE NOTICE 'Granted application DML on % Phase 7A table(s)', v_count;
END $$;

GRANT SELECT ON clinical.v_bed_board TO hms_app, hms_readonly;

-- An occupancy is the record of where a patient physically was. Correcting one
-- is closing it with `end_reason = 'correction'` and opening another, so the
-- census for the hour in between still says something true.
REVOKE DELETE ON "clinical"."ip_bed_occupancies" FROM hms_app;
REVOKE DELETE ON "clinical"."ip_bed_transfers"   FROM hms_app;
REVOKE DELETE ON "clinical"."ip_admissions"      FROM hms_app;
