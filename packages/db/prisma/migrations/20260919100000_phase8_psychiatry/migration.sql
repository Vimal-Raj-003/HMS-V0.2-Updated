-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-032 — psychiatry and mental health
-- Where the statute exists because the patient's own account was discarded
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The Mental Healthcare Act 2017 rewrote Indian mental health law around one
-- idea: the person decides. It presumes capacity, gives them a binding advance
-- directive and a nominated representative of their own choosing, puts a clock
-- on every involuntary admission with a Review Board at the end of it, and
-- makes restraint a reportable act rather than a nursing decision.
--
-- Every one of those is a shape a database can hold, and a system that holds
-- them badly is a system that detains people lawfully on paper.
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **Capacity is presumed, and an assessment that says otherwise expires.**
--    Four limbs — understand, retain, weigh, communicate — all recorded,
--    because "lacks capacity" without them is an opinion. The verdict is
--    derived from the four, and it is decision-specific and dated, because
--    capacity fluctuates and a six-month-old assessment is not evidence of
--    anything.
--
-- 2. **Every admission carries its own clock, derived from its section.**
--    Seventy-two hours for an emergency under §94; thirty days for a supported
--    admission under §89, with the Board told inside seven; ninety on the
--    Board's own authority under §90. A patient held past their authority is
--    not a workflow problem, it is unlawful detention, and the date it happens
--    is arithmetic.
--
-- 3. **A supported admission rests on a current capacity assessment.** An
--    expired one is not one.
--
-- 4. **Restraint is ordered, monitored, and reported.** §97 permits exactly one
--    ground — preventing imminent harm — and there is no enum value here for
--    convenience. A psychiatrist's order within the hour, quarter-hourly
--    observations, the nominated representative told. A restraint with no
--    observations is a person left in a room.
--
-- 5. **Electroconvulsive therapy is never unmodified.** §95: anaesthesia and a
--    muscle relaxant, always. Unmodified ECT is prohibited outright in India,
--    and there is no field here that records it having been given.
--
-- 6. **And never to a minor without the Board's permission.** Also §95, also
--    absolute, also with no override.
--
-- 7. **A scale's total and its bands are computed from its answers**, and
--    PHQ-9's ninth question is scored apart from the total — because a total of
--    eight with a positive ninth is a different afternoon from a total of eight
--    without, and the ninth question is about wanting to be dead.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: OP032.
-- ═════════════════════════════════════════════════════════════════════════════


-- CreateEnum
CREATE TYPE "specialty"."PsyRiskLevel" AS ENUM ('low', 'moderate', 'high');

-- CreateEnum
CREATE TYPE "specialty"."MhcaAdmissionType" AS ENUM ('independent_86', 'supported_89', 'supported_90', 'minor_87', 'emergency_94');

-- CreateEnum
CREATE TYPE "specialty"."RestraintType" AS ENUM ('physical', 'chemical', 'seclusion');

-- CreateTable
CREATE TABLE "specialty"."psy_episodes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "primary_dx_icd10" VARCHAR(16),
    "dx_history" JSONB NOT NULL DEFAULT '[]',
    "risk_level" "specialty"."PsyRiskLevel" NOT NULL DEFAULT 'low',
    "lead_clinician_id" UUID NOT NULL,
    "care_team" UUID[] DEFAULT ARRAY[]::UUID[],
    "status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "sensitivity" VARCHAR(16) NOT NULL DEFAULT 'high',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "psy_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."psy_scales" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID,
    "patient_id" UUID NOT NULL,
    "scale" VARCHAR(24) NOT NULL,
    "items" JSONB NOT NULL,
    "total" DECIMAL(6,2),
    "severity_band" VARCHAR(24),
    "item9_flag" BOOLEAN NOT NULL DEFAULT false,
    "completed_by" VARCHAR(16) NOT NULL DEFAULT 'patient',
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "psy_scales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."mhca_instruments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "content" JSONB NOT NULL,
    "made_at" TIMESTAMPTZ(6) NOT NULL,
    "valid_from" DATE NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "mhrb_ref" VARCHAR(80),
    "witnessed_by" JSONB NOT NULL DEFAULT '[]',
    "document_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mhca_instruments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."psy_capacity_assessments" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "assessed_at" TIMESTAMPTZ(6) NOT NULL,
    "assessed_by" UUID NOT NULL,
    "understands" BOOLEAN NOT NULL,
    "retains" BOOLEAN NOT NULL,
    "weighs" BOOLEAN NOT NULL,
    "communicates" BOOLEAN NOT NULL,
    "has_capacity" BOOLEAN NOT NULL,
    "decision_scope" VARCHAR(120) NOT NULL,
    "rationale" TEXT NOT NULL,
    "valid_until" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "psy_capacity_assessments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."mhca_admissions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "admission_id" UUID,
    "admission_type" "specialty"."MhcaAdmissionType" NOT NULL,
    "admitted_at" TIMESTAMPTZ(6) NOT NULL,
    "capacity_assessment_id" UUID,
    "nr_instrument_id" UUID,
    "authority_expires_at" TIMESTAMPTZ(6),
    "mhrb_intimation_due_at" TIMESTAMPTZ(6),
    "mhrb_intimated_at" TIMESTAMPTZ(6),
    "mhrb_ref" VARCHAR(80),
    "discharged_at" TIMESTAMPTZ(6),
    "outcome" VARCHAR(40),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mhca_admissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."psy_restraint_events" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "kind" "specialty"."RestraintType" NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "duration_min" INTEGER,
    "reason" TEXT NOT NULL,
    "ordered_by" UUID,
    "ordered_at" TIMESTAMPTZ(6),
    "monitoring" JSONB NOT NULL DEFAULT '[]',
    "nr_informed_at" TIMESTAMPTZ(6),
    "reported_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "psy_restraint_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."psy_ect_courses" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "indication" TEXT NOT NULL,
    "consent_id" UUID,
    "nr_consent_id" UUID,
    "capacity_assessment_id" UUID,
    "mhrb_permission_ref" VARCHAR(80),
    "minor" BOOLEAN NOT NULL DEFAULT false,
    "max_sessions" INTEGER NOT NULL DEFAULT 12,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "psy_ect_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."psy_ect_sessions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "given_at" TIMESTAMPTZ(6) NOT NULL,
    "placement" VARCHAR(24) NOT NULL,
    "charge_mc" DECIMAL(6,2),
    "seizure_sec" INTEGER,
    "anaesthesia" JSONB NOT NULL,
    "complications" JSONB NOT NULL DEFAULT '[]',
    "aldrete" INTEGER,
    "cognition_pre" JSONB,
    "cognition_post" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "psy_ect_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "psy_episodes_hospital_id_patient_id_status_idx" ON "specialty"."psy_episodes"("hospital_id", "patient_id", "status");

-- CreateIndex
CREATE INDEX "psy_scales_hospital_id_patient_id_scale_recorded_at_idx" ON "specialty"."psy_scales"("hospital_id", "patient_id", "scale", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "mhca_instruments_hospital_id_patient_id_kind_idx" ON "specialty"."mhca_instruments"("hospital_id", "patient_id", "kind");

-- CreateIndex
CREATE INDEX "psy_capacity_assessments_hospital_id_patient_id_assessed_at_idx" ON "specialty"."psy_capacity_assessments"("hospital_id", "patient_id", "assessed_at" DESC);

-- CreateIndex
CREATE INDEX "mhca_admissions_hospital_id_patient_id_admitted_at_idx" ON "specialty"."mhca_admissions"("hospital_id", "patient_id", "admitted_at" DESC);

-- CreateIndex
CREATE INDEX "mhca_admissions_hospital_id_authority_expires_at_idx" ON "specialty"."mhca_admissions"("hospital_id", "authority_expires_at");

-- CreateIndex
CREATE INDEX "psy_restraint_events_hospital_id_started_at_idx" ON "specialty"."psy_restraint_events"("hospital_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "psy_ect_courses_hospital_id_patient_id_started_at_idx" ON "specialty"."psy_ect_courses"("hospital_id", "patient_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "psy_ect_sessions_hospital_id_given_at_idx" ON "specialty"."psy_ect_sessions"("hospital_id", "given_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_ect_session_seq" ON "specialty"."psy_ect_sessions"("course_id", "seq");

-- AddForeignKey
ALTER TABLE "specialty"."psy_scales" ADD CONSTRAINT "psy_scales_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."psy_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."psy_capacity_assessments" ADD CONSTRAINT "psy_capacity_assessments_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."psy_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."mhca_admissions" ADD CONSTRAINT "mhca_admissions_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."psy_episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."psy_restraint_events" ADD CONSTRAINT "psy_restraint_events_admission_id_fkey" FOREIGN KEY ("admission_id") REFERENCES "specialty"."mhca_admissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."psy_ect_courses" ADD CONSTRAINT "psy_ect_courses_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."psy_episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."psy_ect_sessions" ADD CONSTRAINT "psy_ect_sessions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "specialty"."psy_ect_courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  Capacity is presumed, and an assessment expires ───────────────────
--
-- The Act's four limbs, all recorded. "Lacks capacity" without them is an
-- opinion, and an opinion is what the Act was written to stop being sufficient.
CREATE OR REPLACE FUNCTION specialty.capacity_assessment_validity_days() RETURNS int
  LANGUAGE sql IMMUTABLE AS $$ SELECT 30 $$;

CREATE OR REPLACE FUNCTION specialty.derive_capacity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Derived from the four limbs. A person has capacity unless one fails.
  NEW.has_capacity := NEW.understands AND NEW.retains AND NEW.weighs AND NEW.communicates;

  NEW.valid_until := (NEW.assessed_at
    + make_interval(days => specialty.capacity_assessment_validity_days()))::date;

  IF NOT NEW.has_capacity AND length(btrim(NEW.rationale)) < 20 THEN
    RAISE EXCEPTION 'An assessment that a person lacks capacity has to say why, in enough words to be reviewed. This is the finding the whole of the Act turns on. (OP-032 §B.1)'
      USING ERRCODE = 'OP032';
  END IF;

  IF length(btrim(NEW.decision_scope)) < 4 THEN
    RAISE EXCEPTION 'Capacity is decision-specific. Name the decision: a person may lack capacity for a treatment choice and keep it for where they live. (OP-032 §B.1)'
      USING ERRCODE = 'OP032';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_capacity
  BEFORE INSERT OR UPDATE OF understands, retains, weighs, communicates, assessed_at,
                             has_capacity, valid_until, rationale, decision_scope
    ON specialty.psy_capacity_assessments
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_capacity();


-- ── §B.2  Every admission carries its own clock ─────────────────────────────
--
-- A patient held past their authority is not a workflow problem. It is unlawful
-- detention, and the date it happens is arithmetic.
CREATE OR REPLACE FUNCTION specialty.mhca_authority_hours(p_type specialty."MhcaAdmissionType")
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type
    WHEN 'emergency_94'  THEN 72        -- §94: seventy-two hours.
    WHEN 'supported_89'  THEN 30 * 24   -- §89: thirty days.
    WHEN 'supported_90'  THEN 90 * 24   -- §90: on the Board's authority.
    WHEN 'minor_87'      THEN 30 * 24
    ELSE NULL                           -- §86: independent. They can leave.
  END
$$;

CREATE OR REPLACE FUNCTION specialty.derive_mhca_clock()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_hours int;
  v_cap   record;
BEGIN
  v_hours := specialty.mhca_authority_hours(NEW.admission_type);
  NEW.authority_expires_at := CASE WHEN v_hours IS NULL THEN NULL
                                   ELSE NEW.admitted_at + make_interval(hours => v_hours) END;

  -- §89 and §87: the Board is told within seven days. Not "informed at some
  -- point" — a dated obligation with a date.
  NEW.mhrb_intimation_due_at := CASE
    WHEN NEW.admission_type IN ('supported_89', 'minor_87')
    THEN NEW.admitted_at + interval '7 days'
    ELSE NULL
  END;

  -- ── A supported admission rests on a current capacity assessment ──────────
  IF NEW.admission_type IN ('supported_89', 'supported_90') THEN
    IF NEW.capacity_assessment_id IS NULL THEN
      RAISE EXCEPTION 'A supported admission rests on a capacity assessment, and none is recorded. Capacity is presumed until it is assessed, so without one this is a person being detained who is entitled to leave. (OP-032 §B.2)'
        USING ERRCODE = 'OP032';
    END IF;

    SELECT c.has_capacity, c.valid_until, c.assessed_at INTO v_cap
      FROM specialty.psy_capacity_assessments c WHERE c.id = NEW.capacity_assessment_id;

    IF v_cap.has_capacity IS NULL THEN
      RAISE EXCEPTION 'That capacity assessment does not exist. (OP-032 §B.2)'
        USING ERRCODE = 'OP032';
    END IF;

    IF v_cap.has_capacity THEN
      RAISE EXCEPTION 'That assessment found the person has capacity to decide, so a supported admission does not apply — an independent admission under §86 does, and they may leave. (OP-032 §B.2)'
        USING ERRCODE = 'OP032';
    END IF;

    IF v_cap.valid_until < NEW.admitted_at::date THEN
      RAISE EXCEPTION 'That capacity assessment expired on %. Capacity fluctuates, and an assessment from % is not evidence of anything today. (OP-032 §B.2)',
        v_cap.valid_until, v_cap.assessed_at::date
        USING ERRCODE = 'OP032';
    END IF;
  END IF;

  -- §90 is the Board's authority, not the hospital's.
  IF NEW.admission_type = 'supported_90'
     AND (NEW.mhrb_ref IS NULL OR length(btrim(NEW.mhrb_ref)) < 3) THEN
    RAISE EXCEPTION 'A supported admission beyond thirty days is the Review Board''s authority, not the hospital''s. Record the Board''s reference. (OP-032 §B.2)'
      USING ERRCODE = 'OP032';
  END IF;

  -- §87 is a minor, admitted on the nominated representative's application.
  IF NEW.admission_type = 'minor_87' AND NEW.nr_instrument_id IS NULL THEN
    RAISE EXCEPTION 'A minor is admitted on the application of their nominated representative. Record which one. (OP-032 §B.2)'
      USING ERRCODE = 'OP032';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_mhca_clock
  BEFORE INSERT OR UPDATE OF admission_type, admitted_at, capacity_assessment_id,
                             nr_instrument_id, mhrb_ref, authority_expires_at,
                             mhrb_intimation_due_at
    ON specialty.mhca_admissions
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_mhca_clock();

ALTER TABLE "specialty"."mhca_admissions"
  ADD CONSTRAINT "a_discharge_follows_an_admission"
  CHECK ("discharged_at" IS NULL OR "discharged_at" >= "admitted_at");


-- ── §B.3  Restraint is ordered, monitored, reported ─────────────────────────
--
-- §97 permits exactly one ground: preventing imminent harm. There is no enum
-- value here for staff convenience, and that absence is the rule.
CREATE OR REPLACE FUNCTION specialty.restraint_order_window_min() RETURNS int
  LANGUAGE sql IMMUTABLE AS $$ SELECT 60 $$;

CREATE OR REPLACE FUNCTION specialty.a_restraint_is_ordered_and_watched()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_gap int;
BEGIN
  IF NEW.ended_at IS NOT NULL THEN
    NEW.duration_min := (extract(epoch FROM (NEW.ended_at - NEW.started_at)) / 60)::int;
    IF NEW.duration_min < 0 THEN
      RAISE EXCEPTION 'A restraint ends after it starts. (OP-032 §B.3)' USING ERRCODE = 'OP032';
    END IF;
  ELSE
    NEW.duration_min := NULL;
  END IF;

  IF length(btrim(NEW.reason)) < 12 THEN
    RAISE EXCEPTION 'Restraint is permitted only to prevent imminent harm, and the reason has to say what harm and to whom. It goes to the Review Board in a monthly return. (OP-032 §B.3)'
      USING ERRCODE = 'OP032';
  END IF;

  -- A psychiatrist's order within the hour. A restraint nobody ordered is one
  -- somebody decided at a nursing station.
  IF NEW.ordered_at IS NOT NULL THEN
    v_gap := (extract(epoch FROM (NEW.ordered_at - NEW.started_at)) / 60)::int;
    IF v_gap > specialty.restraint_order_window_min() THEN
      RAISE EXCEPTION 'The order came % minutes after the restraint began, and the Act allows %. An order that arrives later is a ratification, not an order. (OP-032 §B.3)',
        v_gap, specialty.restraint_order_window_min()
        USING ERRCODE = 'OP032';
    END IF;
  END IF;

  -- Ending it needs the order and the observations to exist. A restraint with
  -- no observations is a person left in a room.
  IF NEW.ended_at IS NOT NULL THEN
    IF NEW.ordered_by IS NULL OR NEW.ordered_at IS NULL THEN
      RAISE EXCEPTION 'This restraint has no psychiatrist''s order against it. (OP-032 §B.3)'
        USING ERRCODE = 'OP032';
    END IF;
    IF coalesce(jsonb_array_length(NEW.monitoring), 0) = 0 THEN
      RAISE EXCEPTION 'A restraint with no observations is a person left in a room. Record the quarter-hourly checks before closing it. (OP-032 §B.3)'
        USING ERRCODE = 'OP032';
    END IF;
    IF NEW.nr_informed_at IS NULL THEN
      RAISE EXCEPTION 'The nominated representative is told that the person was restrained. (OP-032 §B.3)'
        USING ERRCODE = 'OP032';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_restraint_is_ordered_and_watched
  BEFORE INSERT OR UPDATE ON specialty.psy_restraint_events
  FOR EACH ROW EXECUTE FUNCTION specialty.a_restraint_is_ordered_and_watched();

-- And there is no enum value for convenience. This asserts it stays that way.
DO $$
DECLARE v_found text;
BEGIN
  SELECT string_agg(e.enumlabel, ', ') INTO v_found
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = 'specialty' AND t.typname = 'RestraintType'
     AND e.enumlabel ~* '(convenien|punish|staffing|discipline)';
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION
      'MHCA §97 permits restraint only to prevent imminent harm. A value naming any other ground would be that ground being permitted: %', v_found;
  END IF;
END $$;


-- ── §B.4  Electroconvulsive therapy: two absolutes ──────────────────────────
--
-- §95 of the Act. Unmodified ECT — without anaesthesia and a muscle relaxant —
-- is prohibited outright in India, and ECT on a minor needs the Review Board's
-- permission. Neither has an override, here or anywhere.
CREATE OR REPLACE FUNCTION specialty.ect_is_modified_and_permitted()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_course record;
BEGIN
  SELECT c.minor, c.mhrb_permission_ref, c.max_sessions, c.consent_id, c.nr_consent_id
    INTO v_course
    FROM specialty.psy_ect_courses c WHERE c.id = NEW.course_id;

  -- Modified means anaesthesia and a muscle relaxant. Both, named.
  IF NOT (jsonb_typeof(NEW.anaesthesia) = 'object'
          AND NEW.anaesthesia ? 'agent' AND NEW.anaesthesia ? 'relaxant'
          AND length(btrim(NEW.anaesthesia ->> 'agent')) > 0
          AND length(btrim(NEW.anaesthesia ->> 'relaxant')) > 0) THEN
    RAISE EXCEPTION
      'Unmodified electroconvulsive therapy is prohibited under §95 of the Mental Healthcare Act. Record the anaesthetic agent and the muscle relaxant. There is no setting that permits this and no field that records it having been given without them. (OP-032 §B.4)'
      USING ERRCODE = 'OP032';
  END IF;

  -- A minor needs the Board, before the first session and not after it.
  IF v_course.minor
     AND (v_course.mhrb_permission_ref IS NULL
          OR length(btrim(v_course.mhrb_permission_ref)) < 3) THEN
    RAISE EXCEPTION
      'Electroconvulsive therapy on a minor requires the Mental Health Review Board''s permission under §95, recorded before the first session. There is no other route. (OP-032 §B.4)'
      USING ERRCODE = 'OP032';
  END IF;

  IF NEW.seq > v_course.max_sessions THEN
    RAISE EXCEPTION 'This course is authorised for % sessions and this is number %. Extending a course is a new consent and a new course. (OP-032 §B.4)',
      v_course.max_sessions, NEW.seq
      USING ERRCODE = 'OP032';
  END IF;

  IF v_course.consent_id IS NULL AND v_course.nr_consent_id IS NULL THEN
    RAISE EXCEPTION 'This course has no consent against it — the person''s own, or their nominated representative''s where the Act allows. (OP-032 §B.4)'
      USING ERRCODE = 'OP032';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_ect_is_modified_and_permitted
  BEFORE INSERT OR UPDATE ON specialty.psy_ect_sessions
  FOR EACH ROW EXECUTE FUNCTION specialty.ect_is_modified_and_permitted();

ALTER TABLE "specialty"."psy_ect_sessions"
  ADD CONSTRAINT "an_ect_session_is_numbered_from_one" CHECK ("seq" >= 1);

ALTER TABLE "specialty"."psy_ect_courses"
  ADD CONSTRAINT "an_ect_course_has_a_plausible_length"
  CHECK ("max_sessions" BETWEEN 1 AND 30);


-- ── §B.5  A scale is scored by its answers ──────────────────────────────────
--
-- A total somebody adds up at the end of a clinic is a total that gets rounded
-- towards the answer they expected. And PHQ-9's ninth question is about wanting
-- to be dead, so it is carried separately from the total.
CREATE OR REPLACE FUNCTION specialty.score_psy_scale()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_total numeric := 0;
  v_item9 numeric;
BEGIN
  IF jsonb_typeof(NEW.items) <> 'object' THEN
    RAISE EXCEPTION 'A scale is scored from its answers, as an object of item numbers to scores. (OP-032 §B.5)'
      USING ERRCODE = 'OP032';
  END IF;

  SELECT coalesce(sum((value)::numeric), 0) INTO v_total
    FROM jsonb_each_text(NEW.items)
   WHERE value ~ '^-?[0-9]+(\.[0-9]+)?$';

  NEW.total := v_total;

  NEW.severity_band := CASE NEW.scale
    WHEN 'phq9' THEN CASE WHEN v_total >= 20 THEN 'severe'
                          WHEN v_total >= 15 THEN 'moderately_severe'
                          WHEN v_total >= 10 THEN 'moderate'
                          WHEN v_total >= 5  THEN 'mild'
                          ELSE 'minimal' END
    WHEN 'gad7' THEN CASE WHEN v_total >= 15 THEN 'severe'
                          WHEN v_total >= 10 THEN 'moderate'
                          WHEN v_total >= 5  THEN 'mild'
                          ELSE 'minimal' END
    WHEN 'mmse' THEN CASE WHEN v_total >= 24 THEN 'normal'
                          WHEN v_total >= 18 THEN 'mild'
                          WHEN v_total >= 10 THEN 'moderate'
                          ELSE 'severe' END
    ELSE NULL
  END;

  -- The ninth question, apart from the total.
  v_item9 := CASE WHEN NEW.scale = 'phq9' AND NEW.items ? '9'
                  THEN (NEW.items ->> '9')::numeric ELSE NULL END;
  NEW.item9_flag := coalesce(v_item9 > 0, false);

  RETURN NEW;
END $$;

CREATE TRIGGER trg_score_psy_scale
  BEFORE INSERT OR UPDATE OF items, scale, total, severity_band, item9_flag
    ON specialty.psy_scales
  FOR EACH ROW EXECUTE FUNCTION specialty.score_psy_scale();


-- ── §B.6  An instrument is revoked, never removed ───────────────────────────
ALTER TABLE "specialty"."mhca_instruments"
  ADD CONSTRAINT "an_instrument_is_one_of_two"
  CHECK ("kind" IN ('advance_directive', 'nominated_representative'));

-- Only the Board can set aside a directive. A hospital revoking one records
-- either the person's own revocation or the Board's reference.
ALTER TABLE "specialty"."mhca_instruments"
  ADD CONSTRAINT "a_revocation_says_who_revoked_it"
  CHECK ("revoked_at" IS NULL
      OR (("revoked_reason" IS NOT NULL AND length(btrim("revoked_reason")) >= 8)
          OR "mhrb_ref" IS NOT NULL));


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
      AND c.relname IN ('psy_episodes','psy_scales','mhca_instruments',
                        'psy_capacity_assessments','mhca_admissions','psy_restraint_events',
                        'psy_ect_courses','psy_ect_sessions')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % psychiatry table(s)', v_count;
END $$;

-- These are the records a Review Board and a court read. Nothing is deleted
-- from any of them: an advance directive is revoked, an admission is
-- discharged, a restraint is ended, and all three stay.
REVOKE DELETE ON "specialty"."mhca_instruments"           FROM hms_app;
REVOKE DELETE ON "specialty"."psy_capacity_assessments"   FROM hms_app;
REVOKE DELETE ON "specialty"."mhca_admissions"            FROM hms_app;
REVOKE DELETE ON "specialty"."psy_restraint_events"       FROM hms_app;
REVOKE DELETE ON "specialty"."psy_ect_sessions"           FROM hms_app;

-- A capacity assessment is a finding at a moment. Correcting one is a new
-- assessment, because the whole point of the expiry is that findings age.
REVOKE UPDATE ON "specialty"."psy_capacity_assessments" FROM hms_app;


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
    AND c.relname IN ('psy_episodes','psy_scales','mhca_instruments',
                      'psy_capacity_assessments','mhca_admissions','psy_restraint_events',
                      'psy_ect_courses','psy_ect_sessions')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Psychiatry tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


