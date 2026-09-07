-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-012 · IP-022 — the dialysis unit
-- Where the schedule is a physical object and the zone is an infection control
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Every console before this one scheduled a queue. This one schedules machines,
-- and a machine is a thing: it cannot have two people on it, it cannot treat a
-- hepatitis-positive patient and then a negative one, and it cannot be started
-- while it is still rinsing out the last patient's disinfectant.
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **One patient per machine per window.** A GiST exclusion over the machine
--    and the booked range, half-open so a session ending at 12:00 and one
--    starting at 12:00 is a turnover rather than a clash. Double-booking a
--    dialysis machine is not a diary problem: it is somebody who came for four
--    hours of treatment finding a stranger connected to their chair.
--
-- 2. **The machine's zone matches the patient's serology.** This is the rule
--    the module exists for. Hepatitis B and C move through dialysis units, and
--    when they do it is never one patient — it is a cohort, discovered months
--    later on a routine screen. Every unit in the world knows to cohort
--    positive patients onto dedicated machines, and units still seroconvert
--    people, because on a Tuesday with two machines down somebody puts the next
--    patient on the nearest chair. Here that write is refused, and the refusal
--    names the patient's zone and the machine's.
--
-- 3. **The isolation zone is derived from the serology, never chosen.** A field
--    a clerk can type is a field a clerk can type wrongly, and this particular
--    typo is a cohort. `hbv` outranks `hcv` outranks `hiv` outranks `general`,
--    because a patient positive for more than one is nursed in the strictest
--    room they qualify for.
--
-- 4. **A machine that is not available does not take a session.** Disinfecting,
--    under maintenance, broken. The middle of a chemical rinse cycle is the
--    exact moment a machine looks free.
--
-- 5. **The ultrafiltration rate is derived and it has a ceiling.** Litres to
--    remove, over hours, per kilogram of dry weight. Above about 13 ml/kg/hour
--    the patient crashes on the machine; sustained over months it is myocardial
--    stunning, which is the mechanism by which dialysis patients die of their
--    hearts rather than their kidneys. It is arithmetic on three numbers a
--    nurse writes on a chart, and nobody does it in their head at seven in the
--    morning. So the machine does it, and refuses the session that exceeds the
--    prescription's own limit.
--
-- 6. **A dialyser is reused a counted number of times, and the count is the
--    database's.** Reuse is legitimate and, in most of the world, necessary. It
--    is safe within a use limit, a total-cell-volume floor and a pressure-hold
--    test. What makes it unsafe is that the count lives on a handwritten label
--    on the housing, and the label is what everybody trusts. Past the limit,
--    below 80 % TCV, or after a failed integrity test, the next use is refused.
--
-- 7. **A dialyser belongs to one patient.** The whole of reuse safety rests on
--    it. A label reused across two programmes is a cross-infection with a
--    paper trail saying it never happened.
--
-- 8. **A session that ends early says why.** Aborted is a different clinical
--    fact from cancelled, and it is the one that shows up in a mortality
--    review.
--
-- 9. **An intradialytic chart belongs to its own session, and the machine's
--    running total only goes up.** Two patients three feet apart produce
--    observations identical in shape, and a chart on the wrong session gives
--    both of them the wrong fluid balance.
--
-- 10. **Adequacy is derived from the ureas.** URR and Kt/V are the numbers that
--    decide whether the prescription is working, and hand-computed Kt/V is
--    wrong often enough that the figure is not worth having.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: OP012.
-- ═════════════════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "specialty"."DialysisModality" AS ENUM ('hd', 'hdf', 'sled', 'pd_capd', 'pd_apd');

-- CreateEnum
CREATE TYPE "specialty"."IsolationZone" AS ENUM ('general', 'hbv', 'hcv', 'hiv');

-- CreateEnum
CREATE TYPE "specialty"."MachineStatus" AS ENUM ('available', 'in_use', 'disinfecting', 'maintenance', 'breakdown');

-- CreateEnum
CREATE TYPE "specialty"."DialysisSessionStatus" AS ENUM ('scheduled', 'checked_in', 'on_machine', 'completed', 'aborted', 'no_show', 'cancelled');

-- CreateEnum
CREATE TYPE "specialty"."VascularAccessType" AS ENUM ('avf', 'avg', 'tunnelled_catheter', 'non_tunnelled_catheter', 'pd_catheter');

-- CreateTable
CREATE TABLE "specialty"."dialysis_programs" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "modality" "specialty"."DialysisModality" NOT NULL,
    "aetiology_icd10" VARCHAR(16),
    "start_date" DATE NOT NULL,
    "dry_weight_kg" DECIMAL(5,2) NOT NULL,
    "dry_weight_updated_at" TIMESTAMPTZ(6) NOT NULL,
    "viral_status" JSONB NOT NULL,
    "isolation_zone" "specialty"."IsolationZone" NOT NULL,
    "blood_group" VARCHAR(8),
    "nephrologist_id" UUID,
    "transport_needed" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dialysis_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."dialysis_vascular_accesses" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "type" "specialty"."VascularAccessType" NOT NULL,
    "site" VARCHAR(80) NOT NULL,
    "side" "clinical"."Laterality" NOT NULL DEFAULT 'not_applicable',
    "created_on" DATE,
    "created_by_surgeon" UUID,
    "status" VARCHAR(16) NOT NULL DEFAULT 'maturing',
    "complications" JSONB NOT NULL DEFAULT '[]',
    "last_assessed" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dialysis_vascular_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."dialysis_prescriptions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "frequency_per_week" INTEGER NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "dialyser_item_id" UUID,
    "dialyser_max_uses" INTEGER NOT NULL DEFAULT 1,
    "qb" INTEGER NOT NULL,
    "qd" INTEGER NOT NULL,
    "dialysate" JSONB NOT NULL,
    "uf_max_rate_ml_kg_h" DECIMAL(4,1) NOT NULL DEFAULT 13,
    "heparin" JSONB NOT NULL DEFAULT '{}',
    "anticoag_mode" VARCHAR(24) NOT NULL DEFAULT 'heparin',
    "epo_plan" JSONB NOT NULL DEFAULT '{}',
    "iron_plan" JSONB NOT NULL DEFAULT '{}',
    "target_ktv" DECIMAL(4,2),
    "effective_from" DATE NOT NULL,
    "prescribed_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dialysis_prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."dialysis_machines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "asset_id" UUID,
    "code" VARCHAR(40) NOT NULL,
    "model" VARCHAR(120),
    "serial" VARCHAR(80),
    "zone" "specialty"."IsolationZone" NOT NULL,
    "status" "specialty"."MachineStatus" NOT NULL DEFAULT 'available',
    "hours_run" INTEGER NOT NULL DEFAULT 0,
    "last_service_at" TIMESTAMPTZ(6),
    "next_service_due_at" TIMESTAMPTZ(6),
    "last_disinfection" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dialysis_machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."dialysis_sessions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "machine_id" UUID,
    "chair_no" VARCHAR(16),
    "admission_id" UUID,
    "access_id" UUID,
    "prescription_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "scheduled_end" TIMESTAMPTZ(6) NOT NULL,
    "shift" VARCHAR(16),
    "status" "specialty"."DialysisSessionStatus" NOT NULL DEFAULT 'scheduled',
    "pre_weight_kg" DECIMAL(5,2),
    "pre" JSONB NOT NULL DEFAULT '{}',
    "uf_goal_l" DECIMAL(5,2),
    "uf_rate_ml_kg_h" DECIMAL(5,2),
    "connect_at" TIMESTAMPTZ(6),
    "disconnect_at" TIMESTAMPTZ(6),
    "post_weight_kg" DECIMAL(5,2),
    "post" JSONB NOT NULL DEFAULT '{}',
    "actual_uf_l" DECIMAL(5,2),
    "dialyser_label" VARCHAR(60),
    "dialyser_use_no" INTEGER,
    "complications" JSONB NOT NULL DEFAULT '[]',
    "meds_given" JSONB NOT NULL DEFAULT '[]',
    "urr" DECIMAL(5,2),
    "ktv" DECIMAL(4,2),
    "adequacy_labs" JSONB NOT NULL DEFAULT '{}',
    "abort_reason" TEXT,
    "technician_id" UUID,
    "nurse_id" UUID,
    "bill_id" UUID,
    "package_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dialysis_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."dialyser_uses" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "item_id" UUID,
    "use_no" INTEGER NOT NULL,
    "session_id" UUID,
    "reprocessed_at" TIMESTAMPTZ(6),
    "tcv_pct" DECIMAL(5,2),
    "integrity_ok" BOOLEAN,
    "chemical" VARCHAR(60),
    "reprocessed_by" UUID,
    "discarded_at" TIMESTAMPTZ(6),
    "discard_reason" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "dialyser_uses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dialysis_programs_hospital_id_branch_id_status_idx" ON "specialty"."dialysis_programs"("hospital_id", "branch_id", "status");

-- CreateIndex
CREATE INDEX "dialysis_programs_hospital_id_patient_id_status_idx" ON "specialty"."dialysis_programs"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "dialysis_programs_hospital_id_isolation_zone_status_idx" ON "specialty"."dialysis_programs"("hospital_id", "isolation_zone", "status");

-- CreateIndex
CREATE INDEX "dialysis_vascular_accesses_hospital_id_program_id_status_idx" ON "specialty"."dialysis_vascular_accesses"("hospital_id", "program_id", "status");

-- CreateIndex
CREATE INDEX "dialysis_prescriptions_hospital_id_program_id_effective_fro_idx" ON "specialty"."dialysis_prescriptions"("hospital_id", "program_id", "effective_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_dialysis_prescription_version" ON "specialty"."dialysis_prescriptions"("program_id", "version");

-- CreateIndex
CREATE INDEX "dialysis_machines_hospital_id_branch_id_zone_status_idx" ON "specialty"."dialysis_machines"("hospital_id", "branch_id", "zone", "status");

-- CreateIndex
CREATE UNIQUE INDEX "uq_dialysis_machine_code" ON "specialty"."dialysis_machines"("hospital_id", "branch_id", "code");

-- CreateIndex
CREATE INDEX "dialysis_sessions_hospital_id_branch_id_scheduled_at_idx" ON "specialty"."dialysis_sessions"("hospital_id", "branch_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "dialysis_sessions_hospital_id_program_id_scheduled_at_idx" ON "specialty"."dialysis_sessions"("hospital_id", "program_id", "scheduled_at" DESC);

-- CreateIndex
CREATE INDEX "dialysis_sessions_hospital_id_status_scheduled_at_idx" ON "specialty"."dialysis_sessions"("hospital_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "dialyser_uses_hospital_id_program_id_label_idx" ON "specialty"."dialyser_uses"("hospital_id", "program_id", "label");

-- CreateIndex
CREATE UNIQUE INDEX "uq_dialyser_use_no" ON "specialty"."dialyser_uses"("hospital_id", "label", "use_no");

-- AddForeignKey
ALTER TABLE "specialty"."dialysis_vascular_accesses" ADD CONSTRAINT "dialysis_vascular_accesses_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "specialty"."dialysis_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."dialysis_prescriptions" ADD CONSTRAINT "dialysis_prescriptions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "specialty"."dialysis_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."dialysis_sessions" ADD CONSTRAINT "dialysis_sessions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "specialty"."dialysis_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."dialysis_sessions" ADD CONSTRAINT "dialysis_sessions_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "specialty"."dialysis_prescriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."dialysis_sessions" ADD CONSTRAINT "dialysis_sessions_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "specialty"."dialysis_machines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."dialysis_sessions" ADD CONSTRAINT "dialysis_sessions_access_id_fkey" FOREIGN KEY ("access_id") REFERENCES "specialty"."dialysis_vascular_accesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CreateTable
CREATE TABLE "specialty"."dialysis_observations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "systolic" INTEGER,
    "diastolic" INTEGER,
    "pulse" INTEGER,
    "temperature_c" DECIMAL(4,1),
    "qb" INTEGER,
    "qd" INTEGER,
    "arterial_mmhg" INTEGER,
    "venous_mmhg" INTEGER,
    "tmp_mmhg" INTEGER,
    "uf_removed_l" DECIMAL(5,2),
    "uf_rate_lh" DECIMAL(4,2),
    "conductivity" DECIMAL(4,2),
    "symptoms" JSONB NOT NULL DEFAULT '[]',
    "intervention" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dialysis_observations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dialysis_observations_hospital_id_session_id_recorded_at_idx" ON "specialty"."dialysis_observations"("hospital_id", "session_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "specialty"."dialysis_observations" ADD CONSTRAINT "dialysis_observations_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "specialty"."dialysis_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  The isolation zone is derived from the serology ───────────────────
--
-- Never chosen. A field a clerk can type is a field a clerk can type wrongly,
-- and this particular typo is not a wrong address on a letter — it is a
-- hepatitis-positive patient on a general-zone machine, and then the four
-- people who use that machine after them.
--
-- Precedence is strictest-first: a patient positive for more than one virus is
-- nursed in the most restrictive room they qualify for. HBV leads because it is
-- the most environmentally robust of the three and the one for which every
-- guideline requires a dedicated machine rather than universal precautions
-- alone.
CREATE OR REPLACE FUNCTION specialty.derive_isolation_zone()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_tested timestamptz;
BEGIN
  IF jsonb_typeof(NEW.viral_status) <> 'object' THEN
    RAISE EXCEPTION 'The viral status must be an object with hbsag, hcv and hiv. (OP-012 §B.1)'
      USING ERRCODE = 'OP012';
  END IF;

  IF NOT (NEW.viral_status ? 'hbsag' AND NEW.viral_status ? 'hcv' AND NEW.viral_status ? 'hiv') THEN
    RAISE EXCEPTION 'The viral status is missing a result: hbsag, hcv and hiv must each be recorded before a patient can be assigned a machine, because the zone is computed from all three. (OP-012 §B.1)'
      USING ERRCODE = 'OP012';
  END IF;

  v_tested := CASE
                WHEN NEW.viral_status ? 'testedAt'
                 AND jsonb_typeof(NEW.viral_status -> 'testedAt') = 'string'
                THEN (NEW.viral_status ->> 'testedAt')::timestamptz
                ELSE NULL
              END;

  IF v_tested IS NULL THEN
    RAISE EXCEPTION 'The viral status has no testedAt date. A serology with no date is a zone nobody can vouch for. (OP-012 §B.1)'
      USING ERRCODE = 'OP012';
  END IF;

  IF v_tested > now() + interval '1 day' THEN
    RAISE EXCEPTION 'The serology is dated %, which is in the future. (OP-012 §B.1)', v_tested::date
      USING ERRCODE = 'OP012';
  END IF;

  -- Strictest first. Whatever the caller supplied is discarded.
  NEW.isolation_zone := CASE
    WHEN (NEW.viral_status ->> 'hbsag')::boolean THEN 'hbv'
    WHEN (NEW.viral_status ->> 'hcv')::boolean   THEN 'hcv'
    WHEN (NEW.viral_status ->> 'hiv')::boolean   THEN 'hiv'
    ELSE 'general'
  END::specialty."IsolationZone";

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_isolation_zone
  BEFORE INSERT OR UPDATE OF viral_status, isolation_zone ON specialty.dialysis_programs
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_isolation_zone();

ALTER TABLE "specialty"."dialysis_programs"
  ADD CONSTRAINT "dry_weight_is_a_weight" CHECK ("dry_weight_kg" > 10 AND "dry_weight_kg" < 400);

ALTER TABLE "specialty"."dialysis_programs"
  ADD CONSTRAINT "a_programme_status_is_known"
  CHECK ("status" IN ('active', 'transferred', 'transplanted', 'recovered', 'stopped', 'died'));


-- ── §B.2  The prescription is a prescription ────────────────────────────────
ALTER TABLE "specialty"."dialysis_prescriptions"
  ADD CONSTRAINT "a_prescription_is_deliverable"
  CHECK ("frequency_per_week" BETWEEN 1 AND 7
     AND "duration_min" BETWEEN 30 AND 720
     AND "qb" BETWEEN 50 AND 600
     AND "qd" BETWEEN 100 AND 1000
     AND "dialyser_max_uses" BETWEEN 1 AND 30
     AND "uf_max_rate_ml_kg_h" BETWEEN 1 AND 20);

-- The bath. A potassium chosen for the wrong patient is an arrhythmia on the
-- machine, so the composition is required to be complete rather than partially
-- filled and silently defaulted downstream.
ALTER TABLE "specialty"."dialysis_prescriptions"
  ADD CONSTRAINT "the_bath_is_fully_specified"
  CHECK (jsonb_typeof("dialysate") = 'object'
     AND "dialysate" ? 'k' AND "dialysate" ? 'ca' AND "dialysate" ? 'na' AND "dialysate" ? 'hco3');


-- ── §B.3  One patient per machine per window ────────────────────────────────
--
-- Half-open: a session ending at 12:00 and one starting at 12:00 is a turnover,
-- not a clash. Cancelled and no-show sessions release the machine, which is why
-- the constraint is partial.
ALTER TABLE "specialty"."dialysis_sessions"
  ADD CONSTRAINT "a_session_ends_after_it_starts" CHECK ("scheduled_end" > "scheduled_at");

ALTER TABLE "specialty"."dialysis_sessions"
  ADD CONSTRAINT "a_session_disconnects_after_it_connects"
  CHECK ("disconnect_at" IS NULL OR "connect_at" IS NULL OR "disconnect_at" > "connect_at");

ALTER TABLE "specialty"."dialysis_sessions"
  ADD CONSTRAINT "one_patient_per_machine"
  EXCLUDE USING gist (
    "machine_id" WITH =,
    tstzrange("scheduled_at", "scheduled_end", '[)') WITH &&
  ) WHERE ("machine_id" IS NOT NULL
       AND "status" IN ('scheduled', 'checked_in', 'on_machine', 'completed', 'aborted'));

-- And one machine per patient. Nobody is on two at once, and a session left
-- open on a machine somebody walked away from is how a machine goes missing
-- from the afternoon shift.
CREATE UNIQUE INDEX "uq_one_live_dialysis_session"
  ON "specialty"."dialysis_sessions" ("hospital_id", "patient_id")
  WHERE "status" = 'on_machine';

ALTER TABLE "specialty"."dialysis_sessions"
  ADD CONSTRAINT "an_aborted_session_says_why"
  CHECK ("status" <> 'aborted'
      OR ("abort_reason" IS NOT NULL AND length(btrim("abort_reason")) >= 4));

-- Recording a dialyser means recording which use of it this was.
ALTER TABLE "specialty"."dialysis_sessions"
  ADD CONSTRAINT "a_dialyser_is_named_with_its_use_number"
  CHECK (("dialyser_label" IS NULL) = ("dialyser_use_no" IS NULL));


-- ── §B.4  The zone, the machine, and the needle ─────────────────────────────
--
-- The three ways a correctly-scheduled session still harms somebody: the wrong
-- machine for their serology, a machine that is mid-rinse or broken, and a
-- fistula that has not matured.
CREATE OR REPLACE FUNCTION specialty.session_is_safely_placed()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_zone        specialty."IsolationZone";
  v_prog_hosp   uuid;
  v_machine     record;
  v_access      record;
BEGIN
  SELECT p.isolation_zone, p.hospital_id INTO v_zone, v_prog_hosp
    FROM specialty.dialysis_programs p WHERE p.id = NEW.program_id;

  IF v_prog_hosp IS DISTINCT FROM NEW.hospital_id THEN
    RAISE EXCEPTION 'That dialysis programme belongs to a different hospital. (OP-012 §B.4)'
      USING ERRCODE = 'OP012';
  END IF;

  IF NEW.machine_id IS NOT NULL THEN
    SELECT m.code, m.zone, m.status INTO v_machine
      FROM specialty.dialysis_machines m WHERE m.id = NEW.machine_id;

    -- The rule this module exists for.
    IF v_machine.zone <> v_zone THEN
      RAISE EXCEPTION 'Machine % is a % machine and this patient is nursed in the % zone. A machine crosses zones only after it has been decommissioned and re-commissioned, never between two patients. (OP-012 §B.4)',
        v_machine.code, v_machine.zone, v_zone
        USING ERRCODE = 'OP012';
    END IF;

    IF NEW.status IN ('scheduled', 'checked_in')
       AND v_machine.status IN ('maintenance', 'breakdown') THEN
      RAISE EXCEPTION 'Machine % is %, so it cannot hold a booking. Move the session to another machine in the % zone or release the machine first. (OP-012 §B.4)',
        v_machine.code, v_machine.status, v_zone
        USING ERRCODE = 'OP012';
    END IF;

    IF NEW.status = 'on_machine'
       AND v_machine.status IN ('disinfecting', 'maintenance', 'breakdown') THEN
      RAISE EXCEPTION 'Machine % is %. A patient is not connected to a machine that has not finished its cycle. (OP-012 §B.4)',
        v_machine.code, v_machine.status
        USING ERRCODE = 'OP012';
    END IF;
  END IF;

  IF NEW.access_id IS NOT NULL THEN
    SELECT a.program_id, a.status, a.type, a.site INTO v_access
      FROM specialty.dialysis_vascular_accesses a WHERE a.id = NEW.access_id;

    IF v_access.program_id <> NEW.program_id THEN
      RAISE EXCEPTION 'That vascular access belongs to another patient. (OP-012 §B.4)'
        USING ERRCODE = 'OP012';
    END IF;

    -- Needling a fistula that has not matured destroys it, and the patient goes
    -- back to a neck line for months. It is one of the few permanent harms in
    -- this module.
    IF v_access.status <> 'active' THEN
      RAISE EXCEPTION 'The % at the % is %, not active. Cannulating an access that is not ready can destroy it permanently. (OP-012 §B.4)',
        v_access.type, v_access.site, v_access.status
        USING ERRCODE = 'OP012';
    END IF;
  ELSIF NEW.status = 'on_machine' AND NEW.machine_id IS NOT NULL THEN
    RAISE EXCEPTION 'Record which access was cannulated before connecting the patient. (OP-012 §B.4)'
      USING ERRCODE = 'OP012';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_session_is_safely_placed
  BEFORE INSERT OR UPDATE OF machine_id, access_id, status, program_id ON specialty.dialysis_sessions
  FOR EACH ROW EXECUTE FUNCTION specialty.session_is_safely_placed();


-- ── §B.5  The fluid ─────────────────────────────────────────────────────────
--
-- Litres to remove, over hours, per kilogram. The number that decides whether
-- the patient crashes on the machine, and — repeated three times a week for
-- years — whether their heart survives the treatment that is keeping them
-- alive. It is arithmetic on three figures written on a chart, and nobody does
-- it in their head at seven in the morning.

-- The rinse-back and whatever the patient drinks during the session. Named so
-- that a unit changing it changes one number.
CREATE OR REPLACE FUNCTION specialty.uf_tolerance_l() RETURNS numeric
  LANGUAGE sql IMMUTABLE AS $$ SELECT 0.5::numeric $$;

CREATE OR REPLACE FUNCTION specialty.derive_dialysis_numbers()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_dry      numeric;
  v_max_rate numeric;
  v_hours    numeric;
  v_excess   numeric;
  v_ceiling  numeric;
  v_needed   int;
  v_pre_urea numeric;
  v_post_urea numeric;
  v_r        numeric;
  v_uf       numeric;
  v_t        numeric;
BEGIN
  SELECT p.dry_weight_kg INTO v_dry
    FROM specialty.dialysis_programs p WHERE p.id = NEW.program_id;
  SELECT rx.uf_max_rate_ml_kg_h INTO v_max_rate
    FROM specialty.dialysis_prescriptions rx WHERE rx.id = NEW.prescription_id;

  v_hours := round(extract(epoch FROM (NEW.scheduled_end - NEW.scheduled_at))::numeric / 3600.0, 4);

  IF NEW.pre_weight_kg IS NOT NULL THEN
    v_excess  := NEW.pre_weight_kg - v_dry;
    v_ceiling := greatest(v_excess, 0) + specialty.uf_tolerance_l();

    -- Suggested, not imposed. A patient who is already hypotensive is pulled
    -- less than dry weight on purpose, and a console that could not express
    -- that would be forcing the harm it exists to prevent. What is refused is
    -- the other direction: pulling a patient below the weight they are meant
    -- to leave at.
    IF NEW.uf_goal_l IS NULL THEN
      NEW.uf_goal_l := round(greatest(v_excess, 0), 2);
    ELSIF NEW.uf_goal_l > v_ceiling THEN
      RAISE EXCEPTION 'A goal of % L would take this patient to % kg, below their dry weight of % kg. They weigh % kg now, so the most that comes off is % L including the rinse-back. (OP-012 §B.5)',
        NEW.uf_goal_l, round(NEW.pre_weight_kg - NEW.uf_goal_l, 2), v_dry,
        NEW.pre_weight_kg, round(v_ceiling, 2)
        USING ERRCODE = 'OP012';
    END IF;
  END IF;

  IF NEW.uf_goal_l IS NOT NULL AND v_hours > 0 AND v_dry > 0 THEN
    NEW.uf_rate_ml_kg_h := round((NEW.uf_goal_l * 1000.0) / v_hours / v_dry, 2);

    IF NEW.uf_rate_ml_kg_h > v_max_rate THEN
      v_needed := ceil((NEW.uf_goal_l * 1000.0) / v_max_rate / v_dry * 60.0)::int;
      RAISE EXCEPTION 'Taking % L off % kg in % hours is % ml/kg/hour, and this prescription''s limit is %. Run the session for % minutes instead, or lower the goal. (OP-012 §B.5)',
        NEW.uf_goal_l, v_dry, round(v_hours, 2), NEW.uf_rate_ml_kg_h, v_max_rate, v_needed
        USING ERRCODE = 'OP012';
    END IF;
  ELSE
    NEW.uf_rate_ml_kg_h := NULL;
  END IF;

  -- ── Adequacy ──────────────────────────────────────────────────────────────
  -- Daugirdas second generation. Hand-computed Kt/V is wrong often enough that
  -- the figure is not worth having, and it is the only number that says whether
  -- three sessions a week are doing anything.
  NEW.urr := NULL;
  NEW.ktv := NULL;

  IF jsonb_typeof(NEW.adequacy_labs) = 'object'
     AND NEW.adequacy_labs ? 'preUreaMgDl' AND NEW.adequacy_labs ? 'postUreaMgDl' THEN
    v_pre_urea  := (NEW.adequacy_labs ->> 'preUreaMgDl')::numeric;
    v_post_urea := (NEW.adequacy_labs ->> 'postUreaMgDl')::numeric;

    IF v_pre_urea > 0 AND v_post_urea >= 0 AND v_post_urea <= v_pre_urea THEN
      NEW.urr := round((v_pre_urea - v_post_urea) / v_pre_urea * 100.0, 2);

      v_t  := CASE
                WHEN NEW.connect_at IS NOT NULL AND NEW.disconnect_at IS NOT NULL
                THEN round(extract(epoch FROM (NEW.disconnect_at - NEW.connect_at))::numeric / 3600.0, 4)
                ELSE v_hours
              END;
      v_uf := coalesce(NEW.actual_uf_l, NEW.uf_goal_l);
      v_r  := CASE WHEN v_pre_urea = 0 THEN NULL ELSE v_post_urea / v_pre_urea END;

      IF v_r IS NOT NULL AND v_uf IS NOT NULL AND NEW.post_weight_kg IS NOT NULL
         AND NEW.post_weight_kg > 0 AND v_t > 0
         AND (v_r - 0.008 * v_t) > 0 THEN
        NEW.ktv := round(
          -ln(v_r - 0.008 * v_t) + (4.0 - 3.5 * v_r) * (v_uf / NEW.post_weight_kg),
          2);
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_dialysis_numbers
  BEFORE INSERT OR UPDATE OF pre_weight_kg, post_weight_kg, uf_goal_l, uf_rate_ml_kg_h,
                             actual_uf_l, adequacy_labs, urr, ktv,
                             scheduled_at, scheduled_end, connect_at, disconnect_at,
                             prescription_id
    ON specialty.dialysis_sessions
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_dialysis_numbers();


-- ── §B.6  The dialyser is counted by the database, not by the label ─────────
--
-- Reuse is legitimate, and in most of the world it is what makes three sessions
-- a week affordable. It is safe within a use limit, a total-cell-volume floor
-- and a pressure-hold test. What makes it unsafe is that the count lives on a
-- strip of tape on the housing, in biro, in a room where forty of them look
-- identical.
--
-- Each row records one use *and* the reprocessing done at the end of it — so
-- the row for use N is what licenses use N+1.
CREATE OR REPLACE FUNCTION specialty.dialyser_tcv_floor_pct() RETURNS numeric
  LANGUAGE sql IMMUTABLE AS $$ SELECT 80::numeric $$;

CREATE OR REPLACE FUNCTION specialty.dialyser_use_is_licensed()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_prev     record;
  v_max_use  int;
  v_other    uuid;
BEGIN
  -- A dialyser belongs to one patient. The whole of reuse safety rests on it,
  -- and a label reused across two programmes is a cross-infection with a paper
  -- trail saying it never happened.
  SELECT u.program_id INTO v_other
    FROM specialty.dialyser_uses u
   WHERE u.hospital_id = NEW.hospital_id AND u.label = NEW.label
     AND u.program_id <> NEW.program_id
   LIMIT 1;
  IF v_other IS NOT NULL THEN
    RAISE EXCEPTION 'Dialyser % is already logged against another patient. A dialyser belongs to one patient for its whole life. (OP-012 §B.6)',
      NEW.label
      USING ERRCODE = 'OP012';
  END IF;

  SELECT rx.dialyser_max_uses INTO v_max_use
    FROM specialty.dialysis_prescriptions rx
   WHERE rx.program_id = NEW.program_id
   ORDER BY (rx.effective_from <= current_date) DESC, rx.effective_from DESC, rx.version DESC
   LIMIT 1;

  IF v_max_use IS NULL THEN
    RAISE EXCEPTION 'This patient has no dialysis prescription, so there is no reuse limit to count against. (OP-012 §B.6)'
      USING ERRCODE = 'OP012';
  END IF;

  IF NEW.use_no > v_max_use THEN
    RAISE EXCEPTION 'Dialyser % has reached its limit of % use(s) on this prescription. Discard it and start a new one. (OP-012 §B.6)',
      NEW.label, v_max_use
      USING ERRCODE = 'OP012';
  END IF;

  SELECT u.use_no, u.discarded_at, u.integrity_ok, u.tcv_pct, u.reprocessed_at
    INTO v_prev
    FROM specialty.dialyser_uses u
   WHERE u.hospital_id = NEW.hospital_id AND u.label = NEW.label
   ORDER BY u.use_no DESC
   LIMIT 1;

  -- Gapless. A jump from use 3 to use 5 is a use that happened off the record.
  IF v_prev.use_no IS NULL THEN
    IF NEW.use_no <> 1 THEN
      RAISE EXCEPTION 'Dialyser % has no history, so this is use 1, not use %. (OP-012 §B.6)',
        NEW.label, NEW.use_no
        USING ERRCODE = 'OP012';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.use_no <> v_prev.use_no + 1 THEN
    RAISE EXCEPTION 'Dialyser % is on use %, so the next one is %, not %. (OP-012 §B.6)',
      NEW.label, v_prev.use_no, v_prev.use_no + 1, NEW.use_no
      USING ERRCODE = 'OP012';
  END IF;

  IF v_prev.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'Dialyser % was discarded after use %. (OP-012 §B.6)', NEW.label, v_prev.use_no
      USING ERRCODE = 'OP012';
  END IF;

  IF v_prev.reprocessed_at IS NULL THEN
    RAISE EXCEPTION 'Dialyser % has not been reprocessed since use %. (OP-012 §B.6)', NEW.label, v_prev.use_no
      USING ERRCODE = 'OP012';
  END IF;

  IF v_prev.integrity_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'Dialyser % has no passing integrity test after use %. A filter that failed its pressure hold is leaking blood into dialysate. (OP-012 §B.6)',
      NEW.label, v_prev.use_no
      USING ERRCODE = 'OP012';
  END IF;

  IF v_prev.tcv_pct IS NULL OR v_prev.tcv_pct < specialty.dialyser_tcv_floor_pct() THEN
    RAISE EXCEPTION 'Dialyser % measured % %% total cell volume after use %, and the floor is % %%. Below it the filter has lost enough fibres that the session will not clear. (OP-012 §B.6)',
      NEW.label, coalesce(v_prev.tcv_pct, 0), v_prev.use_no, specialty.dialyser_tcv_floor_pct()
      USING ERRCODE = 'OP012';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_dialyser_use_is_licensed
  BEFORE INSERT ON specialty.dialyser_uses
  FOR EACH ROW EXECUTE FUNCTION specialty.dialyser_use_is_licensed();

ALTER TABLE "specialty"."dialyser_uses"
  ADD CONSTRAINT "a_use_number_starts_at_one" CHECK ("use_no" >= 1);

ALTER TABLE "specialty"."dialyser_uses"
  ADD CONSTRAINT "a_discarded_dialyser_says_why"
  CHECK ("discarded_at" IS NULL
      OR ("discard_reason" IS NOT NULL AND length(btrim("discard_reason")) >= 3));

ALTER TABLE "specialty"."dialyser_uses"
  ADD CONSTRAINT "total_cell_volume_is_a_percentage"
  CHECK ("tcv_pct" IS NULL OR ("tcv_pct" >= 0 AND "tcv_pct" <= 120));

-- One use, one session.
CREATE UNIQUE INDEX "uq_dialyser_use_session"
  ON "specialty"."dialyser_uses" ("session_id") WHERE "session_id" IS NOT NULL;


-- ── §B.7  A session's dialyser has to be one that was logged ────────────────
--
-- Which makes §B.6 the only door. Stamping a label on a session without a use
-- row is the count being kept on the tape again.
CREATE OR REPLACE FUNCTION specialty.session_dialyser_was_logged()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
  -- Either half missing is `a_dialyser_is_named_with_its_use_number`'s to
  -- refuse, and its sentence is the clearer one. A BEFORE trigger runs first,
  -- so it has to stand aside rather than say "use <NULL> was never logged".
  IF NEW.dialyser_label IS NULL OR NEW.dialyser_use_no IS NULL THEN RETURN NEW; END IF;

  SELECT true INTO v_ok
    FROM specialty.dialyser_uses u
   WHERE u.hospital_id = NEW.hospital_id
     AND u.label = NEW.dialyser_label
     AND u.use_no = NEW.dialyser_use_no
     AND u.program_id = NEW.program_id
   LIMIT 1;

  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'Use % of dialyser % has not been logged for this patient. Log the use — which is where the reuse count, the integrity test and the cell volume are checked — before recording it on the session. (OP-012 §B.7)',
      NEW.dialyser_use_no, NEW.dialyser_label
      USING ERRCODE = 'OP012';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_session_dialyser_was_logged
  BEFORE INSERT OR UPDATE OF dialyser_label, dialyser_use_no ON specialty.dialysis_sessions
  FOR EACH ROW EXECUTE FUNCTION specialty.session_dialyser_was_logged();


-- ── §B.8  A machine does not change zone under a live session ───────────────
--
-- Because §B.4's refusal promises it: "a machine crosses zones only after it
-- has been decommissioned and re-commissioned, never between two patients." A
-- promise a trigger makes and nothing keeps is worse than no promise.
CREATE OR REPLACE FUNCTION specialty.machine_zone_is_stable()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_live int;
BEGIN
  IF NEW.zone = OLD.zone THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_live
    FROM specialty.dialysis_sessions s
   WHERE s.machine_id = NEW.id
     AND s.status IN ('scheduled', 'checked_in', 'on_machine');

  IF v_live > 0 THEN
    RAISE EXCEPTION 'Machine % has % session(s) still booked or running in the % zone. Move or cancel them, then re-commission the machine. (OP-012 §B.8)',
      NEW.code, v_live, OLD.zone
      USING ERRCODE = 'OP012';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_machine_zone_is_stable
  BEFORE UPDATE OF zone ON specialty.dialysis_machines
  FOR EACH ROW EXECUTE FUNCTION specialty.machine_zone_is_stable();

ALTER TABLE "specialty"."dialysis_vascular_accesses"
  ADD CONSTRAINT "an_access_status_is_known"
  CHECK ("status" IN ('planned', 'maturing', 'active', 'failed', 'removed'));


-- ── §B.9  The intradialytic chart belongs to its session ────────────────────
--
-- Both rules catch the same class of error: a chart written onto the wrong
-- session. It happens because two patients are three feet apart and their
-- observations are identical in shape, and it produces a fluid balance that is
-- wrong for both of them.
CREATE OR REPLACE FUNCTION specialty.observation_belongs_to_its_session()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_session record;
  v_from    timestamptz;
  v_to      timestamptz;
  v_prev    numeric;
BEGIN
  SELECT s.hospital_id, s.scheduled_at, s.scheduled_end, s.connect_at, s.disconnect_at, s.status
    INTO v_session
    FROM specialty.dialysis_sessions s WHERE s.id = NEW.session_id;

  IF v_session.hospital_id IS DISTINCT FROM NEW.hospital_id THEN
    RAISE EXCEPTION 'That session belongs to a different hospital. (OP-012 §B.9)'
      USING ERRCODE = 'OP012';
  END IF;

  -- An hour either side of the booked window, because a session that started
  -- late is still that session and a paper chart transcribed afterwards is
  -- legitimate.
  v_from := coalesce(v_session.connect_at, v_session.scheduled_at) - interval '1 hour';
  v_to   := coalesce(v_session.disconnect_at, v_session.scheduled_end) + interval '1 hour';

  IF NEW.recorded_at < v_from OR NEW.recorded_at > v_to THEN
    RAISE EXCEPTION 'A reading at % does not belong to a session running from % to %. Check which chair this chart is from. (OP-012 §B.9)',
      to_char(NEW.recorded_at, 'DD Mon HH24:MI'),
      to_char(v_from + interval '1 hour', 'DD Mon HH24:MI'),
      to_char(v_to - interval '1 hour', 'DD Mon HH24:MI')
      USING ERRCODE = 'OP012';
  END IF;

  -- The machine's running total only goes up.
  IF NEW.uf_removed_l IS NOT NULL THEN
    SELECT o.uf_removed_l INTO v_prev
      FROM specialty.dialysis_observations o
     WHERE o.session_id = NEW.session_id
       AND o.recorded_at <= NEW.recorded_at
       AND o.uf_removed_l IS NOT NULL
       AND o.id <> NEW.id
     ORDER BY o.recorded_at DESC, o.created_at DESC
     LIMIT 1;

    IF v_prev IS NOT NULL AND NEW.uf_removed_l < v_prev THEN
      RAISE EXCEPTION 'The machine had already removed % L at the previous reading, so % L now is a total going backwards. Either the figure is mistyped or the machine was reset — and if it was reset, the fluid balance for this session has to be reconciled by hand. (OP-012 §B.9)',
        v_prev, NEW.uf_removed_l
        USING ERRCODE = 'OP012';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_observation_belongs_to_its_session
  BEFORE INSERT OR UPDATE OF session_id, recorded_at, uf_removed_l ON specialty.dialysis_observations
  FOR EACH ROW EXECUTE FUNCTION specialty.observation_belongs_to_its_session();

ALTER TABLE "specialty"."dialysis_observations"
  ADD CONSTRAINT "a_blood_pressure_is_a_blood_pressure"
  CHECK (("systolic" IS NULL OR "systolic" BETWEEN 40 AND 300)
     AND ("diastolic" IS NULL OR "diastolic" BETWEEN 20 AND 200)
     AND ("systolic" IS NULL OR "diastolic" IS NULL OR "systolic" > "diastolic"));

-- ═════════════════════════════════════════════════════════════════════════════
-- §C. GRANTS
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE r record; v_count int := 0;
BEGIN
  FOR r IN
    SELECT n.nspname AS s, c.relname AS t, c.oid
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p') AND c.relispartition = false
      AND n.nspname = 'specialty'
      AND (c.relname LIKE 'dialysis\_%' OR c.relname = 'dialyser_uses')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % dialysis table(s)', v_count;
END $$;

-- A session that happened, happened. It is aborted with a reason or cancelled
-- before it starts; it is never removed, because the sessions a patient did not
-- get are the whole of an adequacy review.
REVOKE DELETE ON "specialty"."dialysis_sessions" FROM hms_app;

-- The reuse log is the count. A row that can be deleted is a use that can be
-- un-happened, and then the tape on the housing is authoritative again — which
-- is the exact failure §B.6 exists to remove. It is append-only, and the only
-- columns that move afterwards are the reprocessing result and the discard.
--
-- Note the shape: a column-level REVOKE does **not** carve an exception out of
-- a table-level GRANT. The table grant has to go first, then the writable
-- columns come back.
REVOKE UPDATE, DELETE ON "specialty"."dialyser_uses" FROM hms_app;
GRANT UPDATE (reprocessed_at, tcv_pct, integrity_ok, chemical, reprocessed_by,
              discarded_at, discard_reason, session_id, updated_at)
  ON "specialty"."dialyser_uses" TO hms_app;

-- A prescription is superseded by a new version, never edited. The dose a
-- patient was actually run on is the record that a mortality review reads.
REVOKE DELETE ON "specialty"."dialysis_prescriptions" FROM hms_app;


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
                            'immunisation_schedules')
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
  WHERE n.nspname = 'specialty'
    AND (c.relname LIKE 'dialysis\_%' OR c.relname = 'dialyser_uses')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Dialysis tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;
