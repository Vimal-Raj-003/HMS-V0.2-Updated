-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-037 — AYUSH
-- Five systems India regulates as medicine, and the four rules that make them so
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **A consultation's system must match a live registration held by the
--    practitioner conducting it, and a prescription inherits the
--    consultation's system.** The National Commission for Indian System of
--    Medicine registers a vaidya in Ayurveda and a hakim in Unani; the National
--    Commission for Homoeopathy registers a homoeopath. One is not a licence in
--    another. Cross-system prescribing is what state regulators actually
--    prosecute, and a lapsed registration is not a registration — so the check
--    reads the validity dates rather than the existence of a row.
--
-- 2. **A heavy-metal preparation has a duration ceiling, and past a shorter
--    threshold cannot exist without a monitoring order.** Rasa aushadhi and
--    Bhasmas contain mercury, lead, arsenic and iron by design. Whether the
--    classical purification renders them safe is above this file's pay grade;
--    what is not in dispute is that the reported harm is chronic use without
--    liver and kidney monitoring. Both numbers are functions a hospital can
--    move, and neither is a request field.
--
-- 3. **A pradhana karma session needs a completed purvakarma session showing
--    samyak snigdha lakshana, and the course's consent.** Vamana and Virechana
--    are induced emesis and induced purgation; the classical texts are
--    unambiguous that they follow adequate oleation, and performing them on an
--    unoleated patient is the characteristic serious harm of Panchakarma —
--    dehydration, electrolyte collapse, and in the reported deaths, aspiration.
--
-- 4. **A gender-matched procedure is performed by a therapist of the patient's
--    gender, unless the patient has consented otherwise.** Abhyanga, Basti,
--    Hijama and Varmam are done by hand on an undressed patient. This is not a
--    preference setting; it is the reason a great many patients attend at all,
--    and the exception is the patient's own recorded consent, never an
--    administrator's setting.
--
-- 5. **A session cannot be marked done without prechecks**, and **a session
--    that recorded an adverse event blocks the next one on its course until a
--    physician has reviewed it.**
--
-- 6. **A homoeopathic line carries a potency on a real scale; a line in any
--    other system carries none.** A remedy without a potency is not a
--    prescription, and a potency on a Kwatha is a data-entry error that will
--    reach a label.
--
-- 7. **A signed consultation carries at least one NAMASTE-coded diagnosis.** An
--    uncoded AYUSH diagnosis cannot be counted, exported to ABDM, or audited,
--    which is how a whole system of medicine ends up with no morbidity data.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
-- §E  Reference data
--
-- CreateEnum
CREATE TYPE "specialty"."AyushSystem" AS ENUM ('ayurveda', 'homoeopathy', 'unani', 'siddha', 'yoga_naturopathy');

-- CreateEnum
CREATE TYPE "specialty"."AyushCouncil" AS ENUM ('ncism', 'nch', 'state_board');

-- CreateEnum
CREATE TYPE "mdm"."AyushMedicineType" AS ENUM ('classical', 'proprietary', 'homoeo_remedy', 'raw_drug', 'inhouse');

-- CreateEnum
CREATE TYPE "mdm"."PanchakarmaPhase" AS ENUM ('purva', 'pradhana', 'paschat');

-- CreateEnum
CREATE TYPE "specialty"."AyushLakshana" AS ENUM ('samyak', 'ayoga', 'atiyoga');

-- CreateEnum
CREATE TYPE "specialty"."AyushCourseStatus" AS ENUM ('planned', 'consented', 'in_progress', 'completed', 'aborted');

-- CreateEnum
CREATE TYPE "specialty"."AyushSessionStatus" AS ENUM ('scheduled', 'done', 'skipped', 'rescheduled');

-- CreateTable
CREATE TABLE "specialty"."ayush_registrations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "practitioner_id" UUID NOT NULL,
    "system" "specialty"."AyushSystem" NOT NULL,
    "council" "specialty"."AyushCouncil" NOT NULL,
    "registration_no" VARCHAR(60) NOT NULL,
    "valid_from" DATE NOT NULL,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ayush_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mdm"."ayush_medicines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID,
    "system" "specialty"."AyushSystem" NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "type" "mdm"."AyushMedicineType" NOT NULL,
    "classical_ref" JSONB,
    "form" VARCHAR(40),
    "manufacturer" VARCHAR(200),
    "licence_no" VARCHAR(60),
    "schedule_e1" BOOLEAN NOT NULL DEFAULT false,
    "heavy_metal" BOOLEAN NOT NULL DEFAULT false,
    "contraindications" JSONB NOT NULL DEFAULT '[]',
    "interactions" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ayush_medicines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mdm"."ayush_procedures" (
    "id" UUID NOT NULL,
    "hospital_id" UUID,
    "system" "specialty"."AyushSystem" NOT NULL,
    "code" VARCHAR(80) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "phase" "mdm"."PanchakarmaPhase" NOT NULL,
    "default_duration_min" INTEGER NOT NULL,
    "room_type" VARCHAR(40) NOT NULL,
    "requires_consent" BOOLEAN NOT NULL DEFAULT false,
    "gender_match_required" BOOLEAN NOT NULL DEFAULT false,
    "invasive" BOOLEAN NOT NULL DEFAULT false,
    "contraindications" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ayush_procedures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ayush_consults" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "encounter_id" UUID,
    "practitioner_id" UUID NOT NULL,
    "system" "specialty"."AyushSystem" NOT NULL,
    "assessment" JSONB NOT NULL DEFAULT '{}',
    "diagnoses" JSONB NOT NULL DEFAULT '[]',
    "plan" JSONB NOT NULL DEFAULT '{}',
    "pathya_apathya" JSONB NOT NULL DEFAULT '{}',
    "lifestyle" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ayush_consults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ayush_prescription_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "consult_id" UUID NOT NULL,
    "medicine_id" UUID NOT NULL,
    "dose" VARCHAR(60) NOT NULL,
    "unit" VARCHAR(20) NOT NULL,
    "anupana" VARCHAR(120),
    "kala" VARCHAR(60),
    "potency" VARCHAR(20),
    "scale" VARCHAR(4),
    "repetition" VARCHAR(60),
    "duration_days" INTEGER NOT NULL,
    "schedule_e1" BOOLEAN NOT NULL DEFAULT false,
    "heavy_metal" BOOLEAN NOT NULL DEFAULT false,
    "monitoring_order_id" UUID,
    "monitoring_due_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ayush_prescription_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ayush_courses" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "consult_id" UUID NOT NULL,
    "admission_id" UUID,
    "system" "specialty"."AyushSystem" NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "plan_days" JSONB NOT NULL,
    "consent_id" UUID,
    "status" "specialty"."AyushCourseStatus" NOT NULL DEFAULT 'planned',
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "abort_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ayush_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."ayush_therapy_sessions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "day_no" INTEGER NOT NULL,
    "procedure_code" VARCHAR(80) NOT NULL,
    "phase" "mdm"."PanchakarmaPhase",
    "room_id" UUID,
    "therapist_ids" UUID[],
    "therapist_genders" VARCHAR(10)[],
    "gender_waiver_consent_id" UUID,
    "prechecks" JSONB NOT NULL DEFAULT '{}',
    "medicines_used" JSONB NOT NULL DEFAULT '[]',
    "params" JSONB NOT NULL DEFAULT '{}',
    "lakshana" "specialty"."AyushLakshana",
    "adverse_event" TEXT,
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "review_note" TEXT,
    "tolerance" VARCHAR(40),
    "post_advice" TEXT,
    "skip_reason" TEXT,
    "status" "specialty"."AyushSessionStatus" NOT NULL DEFAULT 'scheduled',
    "performed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ayush_therapy_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ayush_registrations_hospital_id_system_idx" ON "specialty"."ayush_registrations"("hospital_id", "system");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ayush_registration" ON "specialty"."ayush_registrations"("hospital_id", "practitioner_id", "system");

-- CreateIndex
CREATE INDEX "ayush_medicines_system_name_idx" ON "mdm"."ayush_medicines"("system", "name");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ayush_medicine_code" ON "mdm"."ayush_medicines"("hospital_id", "code");

-- CreateIndex
CREATE INDEX "ayush_procedures_system_phase_idx" ON "mdm"."ayush_procedures"("system", "phase");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ayush_procedure_code" ON "mdm"."ayush_procedures"("hospital_id", "code");

-- CreateIndex
CREATE INDEX "ayush_consults_hospital_id_patient_id_created_at_idx" ON "specialty"."ayush_consults"("hospital_id", "patient_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ayush_consults_hospital_id_system_created_at_idx" ON "specialty"."ayush_consults"("hospital_id", "system", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ayush_prescription_lines_hospital_id_consult_id_idx" ON "specialty"."ayush_prescription_lines"("hospital_id", "consult_id");

-- CreateIndex
CREATE INDEX "ayush_courses_hospital_id_patient_id_start_date_idx" ON "specialty"."ayush_courses"("hospital_id", "patient_id", "start_date" DESC);

-- CreateIndex
CREATE INDEX "ayush_courses_hospital_id_status_idx" ON "specialty"."ayush_courses"("hospital_id", "status");

-- CreateIndex
CREATE INDEX "ayush_therapy_sessions_hospital_id_course_id_day_no_idx" ON "specialty"."ayush_therapy_sessions"("hospital_id", "course_id", "day_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_ayush_session" ON "specialty"."ayush_therapy_sessions"("course_id", "day_no", "procedure_code");

-- AddForeignKey
ALTER TABLE "specialty"."ayush_prescription_lines" ADD CONSTRAINT "ayush_prescription_lines_consult_id_fkey" FOREIGN KEY ("consult_id") REFERENCES "specialty"."ayush_consults"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."ayush_prescription_lines" ADD CONSTRAINT "ayush_prescription_lines_medicine_id_fkey" FOREIGN KEY ("medicine_id") REFERENCES "mdm"."ayush_medicines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."ayush_courses" ADD CONSTRAINT "ayush_courses_consult_id_fkey" FOREIGN KEY ("consult_id") REFERENCES "specialty"."ayush_consults"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."ayush_therapy_sessions" ADD CONSTRAINT "ayush_therapy_sessions_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "specialty"."ayush_courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  A registration is per system, and it is the boundary ──────────────
--
-- The check reads the validity dates rather than the existence of a row,
-- because a lapsed registration is not a registration and the commonest way
-- this rule fails in practice is a renewal nobody chased.
CREATE OR REPLACE FUNCTION specialty.a_consult_is_within_registration()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ok      boolean;
  v_any     boolean;
  v_expired date;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM specialty.ayush_registrations r
     WHERE r.hospital_id = NEW.hospital_id
       AND r.practitioner_id = NEW.practitioner_id
       AND r.system = NEW.system
       AND r.valid_from <= current_date
       AND (r.valid_to IS NULL OR r.valid_to >= current_date)
  ) INTO v_ok;

  IF v_ok THEN RETURN NEW; END IF;

  SELECT EXISTS (SELECT 1 FROM specialty.ayush_registrations r
                  WHERE r.hospital_id = NEW.hospital_id
                    AND r.practitioner_id = NEW.practitioner_id
                    AND r.system = NEW.system),
         max(r2.valid_to)
    INTO v_any, v_expired
    FROM specialty.ayush_registrations r2
   WHERE r2.hospital_id = NEW.hospital_id
     AND r2.practitioner_id = NEW.practitioner_id
     AND r2.system = NEW.system;

  IF v_any THEN
    RAISE EXCEPTION
      'This practitioner''s % registration lapsed on %. A lapsed registration is not a registration, and the consultation cannot be opened until it is renewed. (OP-037 §B.1)',
      NEW.system, coalesce(v_expired::text, 'an unrecorded date')
      USING ERRCODE = 'OP037';
  END IF;

  RAISE EXCEPTION
    'This practitioner holds no % registration. A registration in one system of medicine is not a licence in another — the councils keep separate registers and cross-system practice is what they prosecute. (OP-037 §B.1)',
    NEW.system
    USING ERRCODE = 'OP037';
END $$;

CREATE TRIGGER trg_a_consult_is_within_registration
  BEFORE INSERT OR UPDATE OF practitioner_id, system ON specialty.ayush_consults
  FOR EACH ROW EXECUTE FUNCTION specialty.a_consult_is_within_registration();

-- A signed consultation carries a NAMASTE-coded diagnosis. Unsigned is a draft
-- and may be incomplete; signed is a record and may not.
CREATE OR REPLACE FUNCTION specialty.a_signed_consult_is_coded()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.signed_at IS NULL THEN RETURN NEW; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.diagnoses) d
     WHERE coalesce(btrim(d->>'namasteCode'), '') <> ''
  ) THEN
    RAISE EXCEPTION
      'A signed consultation carries at least one NAMASTE-coded diagnosis. An uncoded AYUSH diagnosis cannot be counted, exported to ABDM or audited, which is how a whole system of medicine ends up with no morbidity data. (OP-037 §B.1)'
      USING ERRCODE = 'OP037';
  END IF;

  IF NEW.signed_by IS NULL THEN
    RAISE EXCEPTION 'A signature has a name on it. (OP-037 §B.1)' USING ERRCODE = 'OP037';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_signed_consult_is_coded
  BEFORE INSERT OR UPDATE OF signed_at, signed_by, diagnoses ON specialty.ayush_consults
  FOR EACH ROW EXECUTE FUNCTION specialty.a_signed_consult_is_coded();


-- ── §B.2  Heavy metal has a ceiling and a clock ─────────────────────────────
--
-- Both numbers are functions rather than literals, so a hospital whose formulary
-- committee sets a stricter ceiling changes one definition instead of hunting
-- for constants — and the refusal quotes whatever the function returns.

-- The longest a heavy-metal preparation may be prescribed for in one line.
CREATE OR REPLACE FUNCTION specialty.rasa_max_days()
RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 45 $$;

-- Past this, the line cannot exist without liver and kidney monitoring.
CREATE OR REPLACE FUNCTION specialty.rasa_monitoring_after_days()
RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT 21 $$;

CREATE OR REPLACE FUNCTION specialty.a_prescription_line_obeys_its_system()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_med     record;
  v_system  specialty."AyushSystem";
  v_max     int := specialty.rasa_max_days();
  v_monitor int := specialty.rasa_monitoring_after_days();
BEGIN
  SELECT m.system, m.name, m.schedule_e1, m.heavy_metal, m.type
    INTO v_med
    FROM mdm.ayush_medicines m WHERE m.id = NEW.medicine_id;

  IF v_med IS NULL THEN
    RAISE EXCEPTION 'That medicine is not in the AYUSH master. (OP-037 §B.2)' USING ERRCODE = 'OP037';
  END IF;

  SELECT c.system INTO v_system FROM specialty.ayush_consults c WHERE c.id = NEW.consult_id;

  -- The system comes from the consultation, and the consultation's system came
  -- from the practitioner's registration. There is no field on this line that
  -- could disagree, and a medicine from another system is the disagreement.
  IF v_med.system <> v_system THEN
    RAISE EXCEPTION
      '% belongs to the % formulary and this is a % consultation. A registration in one system is not a licence in another. (OP-037 §B.2)',
      v_med.name, v_med.system, v_system
      USING ERRCODE = 'OP037';
  END IF;

  -- Stamped at the moment of prescribing, so a later reclassification of the
  -- medicine does not rewrite what was written.
  NEW.schedule_e1 := v_med.schedule_e1;
  NEW.heavy_metal := v_med.heavy_metal;

  IF v_med.heavy_metal THEN
    IF NEW.duration_days > v_max THEN
      RAISE EXCEPTION
        '% is a heavy-metal preparation and % days exceeds the % the formulary allows in one line. The reported harm from Rasa aushadhi is chronic use, not a course. Prescribe % days and review. (OP-037 §B.2)',
        v_med.name, NEW.duration_days, v_max, v_max
        USING ERRCODE = 'OP037';
    END IF;

    IF NEW.duration_days > v_monitor AND NEW.monitoring_order_id IS NULL THEN
      RAISE EXCEPTION
        '% is a heavy-metal preparation for % days, past the % at which liver and kidney monitoring is required. Order the monitoring and record it against this line. (OP-037 §B.2)',
        v_med.name, NEW.duration_days, v_monitor
        USING ERRCODE = 'OP037';
    END IF;

    -- Derived: when the monitoring falls due. No request field — a prescriber
    -- who could set it could set it past the end of the course.
    NEW.monitoring_due_at := now() + make_interval(days => least(NEW.duration_days, v_monitor));
  ELSE
    NEW.monitoring_due_at := NULL;
  END IF;

  -- A remedy without a potency is not a prescription; a potency on a Kwatha is
  -- a data-entry error that reaches a label.
  IF v_system = 'homoeopathy' THEN
    IF NEW.potency IS NULL OR NEW.scale IS NULL THEN
      RAISE EXCEPTION
        'A homoeopathic prescription carries a potency and a scale. (OP-037 §B.2)'
        USING ERRCODE = 'OP037';
    END IF;
  ELSIF NEW.potency IS NOT NULL OR NEW.scale IS NOT NULL THEN
    RAISE EXCEPTION
      'A potency belongs to a homoeopathic remedy, and this is a % prescription. (OP-037 §B.2)',
      v_system
      USING ERRCODE = 'OP037';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_prescription_line_obeys_its_system
  BEFORE INSERT OR UPDATE OF medicine_id, consult_id, duration_days, monitoring_order_id, potency, scale
    ON specialty.ayush_prescription_lines
  FOR EACH ROW EXECUTE FUNCTION specialty.a_prescription_line_obeys_its_system();

ALTER TABLE "specialty"."ayush_prescription_lines"
  ADD CONSTRAINT "a_course_has_a_length"
  CHECK ("duration_days" BETWEEN 1 AND 365);

ALTER TABLE "specialty"."ayush_prescription_lines"
  ADD CONSTRAINT "a_potency_is_on_a_real_scale"
  CHECK ("scale" IS NULL OR "scale" IN ('C', 'X', 'LM', 'Q'));


-- ── §B.3  Pradhana karma follows adequate oleation ──────────────────────────
--
-- The phase is copied from the procedure master rather than named on the
-- session, because a session that could name its own phase could name `purva`
-- and skip this rule entirely.
CREATE OR REPLACE FUNCTION specialty.a_therapy_session_is_safe_to_perform()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_proc     record;
  v_course   record;
  v_gender   text;
  v_oleated  boolean;
  v_unreviewed record;
  v_mismatch text[];
BEGIN
  SELECT p.phase, p.name, p.requires_consent, p.gender_match_required, p.invasive
    INTO v_proc
    FROM mdm.ayush_procedures p
   WHERE p.code = NEW.procedure_code
     AND (p.hospital_id IS NULL OR p.hospital_id = NEW.hospital_id)
   ORDER BY p.hospital_id NULLS LAST
   LIMIT 1;

  IF v_proc IS NULL THEN
    RAISE EXCEPTION 'There is no procedure "%" in the AYUSH master. (OP-037 §B.3)', NEW.procedure_code
      USING ERRCODE = 'OP037';
  END IF;

  -- Derived, always, on insert and on update.
  NEW.phase := v_proc.phase;

  SELECT c.id, c.consent_id, c.patient_id INTO v_course
    FROM specialty.ayush_courses c WHERE c.id = NEW.course_id;

  -- Everything below is about performing the procedure. A scheduled row is a
  -- plan and is allowed to exist before its prerequisites are met — that is
  -- what planning is.
  IF NEW.status <> 'done' THEN RETURN NEW; END IF;

  IF NEW.prechecks = '{}'::jsonb OR jsonb_typeof(NEW.prechecks) <> 'object' THEN
    RAISE EXCEPTION
      'Record the pre-therapy checks before marking % done. Most of the contraindications are things you find by asking. (OP-037 §B.3)',
      v_proc.name
      USING ERRCODE = 'OP037';
  END IF;

  IF NEW.performed_at IS NULL THEN
    RAISE EXCEPTION 'A session that was done says when. (OP-037 §B.3)' USING ERRCODE = 'OP037';
  END IF;

  -- The oleation prerequisite.
  IF v_proc.phase = 'pradhana' THEN
    SELECT EXISTS (
      SELECT 1 FROM specialty.ayush_therapy_sessions s
       WHERE s.course_id = NEW.course_id
         AND s.id <> NEW.id
         AND s.status = 'done'
         AND s.phase = 'purva'
         AND s.lakshana = 'samyak'
    ) INTO v_oleated;

    IF NOT v_oleated THEN
      RAISE EXCEPTION
        '% is a pradhana karma and this course has no completed purvakarma session recording samyak snigdha lakshana. Vamana and Virechana follow adequate oleation; performed on an unoleated patient they cause dehydration, electrolyte collapse and — in the deaths that are reported — aspiration. (OP-037 §B.3)',
        v_proc.name
        USING ERRCODE = 'OP037';
    END IF;

    IF v_course.consent_id IS NULL THEN
      RAISE EXCEPTION
        'The course has no recorded consent, and % is a pradhana karma. (OP-037 §B.3)', v_proc.name
        USING ERRCODE = 'OP037';
    END IF;
  END IF;

  IF (v_proc.requires_consent OR v_proc.invasive) AND v_course.consent_id IS NULL THEN
    RAISE EXCEPTION
      '% draws blood or cuts, and the course has no recorded consent. (OP-037 §B.3)', v_proc.name
      USING ERRCODE = 'OP037';
  END IF;

  -- §B.4 The gender match. Read from the patient record rather than stored on
  -- the session, so there is one answer to what the patient's gender is.
  IF v_proc.gender_match_required AND NEW.gender_waiver_consent_id IS NULL THEN
    SELECT p.gender::text INTO v_gender FROM patient.patients p WHERE p.id = v_course.patient_id;

    IF v_gender IN ('male', 'female') THEN
      SELECT array_agg(g) INTO v_mismatch
        FROM unnest(NEW.therapist_genders) g WHERE g <> v_gender;

      IF cardinality(NEW.therapist_genders) = 0 THEN
        RAISE EXCEPTION
          '% is performed by hand on an undressed patient, so record who performed it and their gender. (OP-037 §B.4)',
          v_proc.name
          USING ERRCODE = 'OP037';
      END IF;

      IF v_mismatch IS NOT NULL THEN
        RAISE EXCEPTION
          '% needs a therapist of the patient''s own gender. This is not a preference setting — it is the reason a great many patients attend at all — and the only exception is the patient''s own recorded consent, which no administrator can supply. (OP-037 §B.4)',
          v_proc.name
          USING ERRCODE = 'OP037';
      END IF;
    END IF;
  END IF;

  -- §B.5 An adverse event stops the course until somebody has looked at it.
  SELECT s.day_no, s.procedure_code INTO v_unreviewed
    FROM specialty.ayush_therapy_sessions s
   WHERE s.course_id = NEW.course_id
     AND s.id <> NEW.id
     AND s.adverse_event IS NOT NULL
     AND s.reviewed_at IS NULL
   ORDER BY s.day_no
   LIMIT 1;

  IF v_unreviewed IS NOT NULL THEN
    RAISE EXCEPTION
      'Day % of this course (%) recorded an adverse event that no physician has reviewed. The next therapy waits for that review, because the commonest thing an unreviewed reaction turns into is the same reaction tomorrow. (OP-037 §B.5)',
      v_unreviewed.day_no, v_unreviewed.procedure_code
      USING ERRCODE = 'OP037';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_therapy_session_is_safe_to_perform
  BEFORE INSERT OR UPDATE ON specialty.ayush_therapy_sessions
  FOR EACH ROW EXECUTE FUNCTION specialty.a_therapy_session_is_safe_to_perform();

ALTER TABLE "specialty"."ayush_therapy_sessions"
  ADD CONSTRAINT "a_skipped_session_says_why"
  CHECK ("status" <> 'skipped'
      OR ("skip_reason" IS NOT NULL AND length(btrim("skip_reason")) >= 4));

ALTER TABLE "specialty"."ayush_therapy_sessions"
  ADD CONSTRAINT "a_review_has_a_reviewer"
  CHECK (("reviewed_by" IS NULL) = ("reviewed_at" IS NULL));

-- A therapist list and a gender list describe the same people.
ALTER TABLE "specialty"."ayush_therapy_sessions"
  ADD CONSTRAINT "a_therapist_has_one_gender"
  CHECK (cardinality("therapist_genders") = 0
      OR cardinality("therapist_genders") = cardinality("therapist_ids"));

ALTER TABLE "specialty"."ayush_therapy_sessions"
  ADD CONSTRAINT "a_gender_is_a_gender"
  CHECK ("therapist_genders" <@ ARRAY['male', 'female', 'other']::varchar[]);

-- A course that was aborted says why. A course abandoned without a reason is
-- indistinguishable from one nobody finished entering.
ALTER TABLE "specialty"."ayush_courses"
  ADD CONSTRAINT "an_aborted_course_says_why"
  CHECK ("status" <> 'aborted'
      OR ("abort_reason" IS NOT NULL AND length(btrim("abort_reason")) >= 8));

-- Named `a_council_registration_...` and not `a_registration_...` because the
-- API's constraint→message map is keyed on the bare constraint name, and
-- `a_registration_runs_forwards` already belongs to PC-PNDT's sonologist
-- register. Two tables may share a name in Postgres; the map cannot. The
-- assertion below turns that from a convention into a check.
ALTER TABLE "specialty"."ayush_registrations"
  ADD CONSTRAINT "a_council_registration_runs_forwards"
  CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");


-- ── §B.6  A constraint name is a message key, so it has to be unique ────────
--
-- `withConsoleErrors` translates a Postgres refusal into problem+json by
-- looking the constraint name up in one map. Two different rules sharing a name
-- therefore share a message, and the second one to be written silently inherits
-- the first one's explanation — a wrong sentence shown to a real person, with
-- nothing failing anywhere.
--
-- This was found by writing exactly that collision. Partitions are excluded:
-- they inherit their parent's constraints by design and are the same rule.
DO $$
DECLARE v_dupes text;
BEGIN
  SELECT string_agg(format('%s (%s)', conname, tables), '; ' ORDER BY conname) INTO v_dupes
  FROM (
    SELECT c.conname, string_agg(DISTINCT t.relname, ', ') AS tables
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname IN ('core','mdm','patient','clinical','lab','rad','pharmacy','inventory',
                         'finance','queue','engage','billing','integration','ops','specialty')
       AND c.contype IN ('c','u','x')
       AND t.relispartition = false
     GROUP BY c.conname
    HAVING count(DISTINCT t.relname) > 1
  ) d;

  IF v_dupes IS NOT NULL THEN
    RAISE EXCEPTION
      'Two rules share a constraint name, and the API''s constraint-to-message map is keyed on that name — so one of them will show the other''s explanation to somebody. Rename one: %',
      v_dupes;
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
    WHERE c.relkind IN ('r','p') AND c.relispartition = false
      AND ((n.nspname = 'specialty'
            AND c.relname IN ('ayush_registrations','ayush_consults','ayush_prescription_lines',
                              'ayush_courses','ayush_therapy_sessions'))
        OR (n.nspname = 'mdm' AND c.relname IN ('ayush_medicines','ayush_procedures')))
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % AYUSH table(s)', v_count;
END $$;

-- A signed consultation and a performed therapy are records of what happened.
REVOKE DELETE ON "specialty"."ayush_consults"          FROM hms_app;
REVOKE DELETE ON "specialty"."ayush_therapy_sessions"  FROM hms_app;

-- `heavy_metal` and `schedule_e1` on a prescription line are the master's
-- classification stamped by the trigger, and the trigger is SECURITY INVOKER
-- because it only reads. Revoking the columns would stop the trigger too, so
-- the protection here is the absence of a request field rather than a REVOKE —
-- see the schemas file.

-- The formulary's own classification is not the console's to change. A hospital
-- that could clear `heavy_metal` on a Bhasma has repealed §B.2.
--
-- Written as a table-level REVOKE followed by a column-level GRANT, and not as
-- `REVOKE UPDATE (col)`, because a column revoke against a role holding the
-- table privilege is a no-op that looks exactly like a rule.
REVOKE UPDATE ON "mdm"."ayush_medicines" FROM hms_app;
GRANT UPDATE (name, code, classical_ref, form, manufacturer, licence_no,
              contraindications, interactions, active, updated_at)
  ON "mdm"."ayush_medicines" TO hms_app;


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
DECLARE v_missing text;
BEGIN
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ') INTO v_missing
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE ((n.nspname = 'specialty'
          AND c.relname IN ('ayush_registrations','ayush_consults','ayush_prescription_lines',
                            'ayush_courses','ayush_therapy_sessions'))
      OR (n.nspname = 'mdm' AND c.relname IN ('ayush_medicines','ayush_procedures')))
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'AYUSH tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §E. REFERENCE DATA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A working subset of the procedure master, hospital-independent because the
-- procedures are classical and the phase each belongs to is not a local
-- decision. The medicine master is *not* seeded: formularies are a hospital's
-- own, and a seeded Bhasma would be a heavy-metal preparation nobody chose.

--
-- Inserted through a NOT EXISTS rather than ON CONFLICT: `hospital_id` is null
-- on every one of these, and NULLs are distinct in a plain unique index, so
-- `ON CONFLICT (hospital_id, code)` would never fire and a second run would
-- duplicate the master.
INSERT INTO mdm.ayush_procedures
  (id, hospital_id, system, code, name, phase, default_duration_min, room_type,
   requires_consent, gender_match_required, invasive, contraindications, created_at, updated_at)
SELECT v.* FROM (VALUES
  -- Purvakarma. Abhyanga is a full-body oil massage by hand.
  -- A VALUES list takes its column types from the first row, and text does not
  -- implicitly become an enum on the way into a column, so the casts live here.
  (gen_random_uuid(), NULL::uuid, 'ayurveda'::specialty."AyushSystem", 'abhyanga'::varchar,
   'Abhyanga'::varchar, 'purva'::mdm."PanchakarmaPhase", 45, 'abhyanga'::varchar,
   false, true, false, '["acute fever","indigestion","immediately after food"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'ayurveda', 'swedana', 'Swedana', 'purva', 20, 'swedana_chamber',
   false, true, false, '["pregnancy","severe cardiac disease","dehydration"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'ayurveda', 'snehapana', 'Snehapana', 'purva', 30, 'ward',
   false, false, false, '["ama","poor agni","acute illness"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'ayurveda', 'shirodhara', 'Shirodhara', 'purva', 45, 'shirodhara',
   false, true, false, '["head injury","acute sinusitis"]'::jsonb, now(), now()),

  -- Pradhana karma. Every one of these needs the oleation behind it.
  (gen_random_uuid(), NULL, 'ayurveda', 'vamana', 'Vamana', 'pradhana', 240, 'vamana',
   true, true, false, '["pregnancy","cardiac disease","uncontrolled hypertension","extremes of age","emaciation"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'ayurveda', 'virechana', 'Virechana', 'pradhana', 300, 'ward',
   true, true, false, '["pregnancy","acute diarrhoea","rectal prolapse","severe debility"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'ayurveda', 'basti_niruha', 'Niruha Basti', 'pradhana', 60, 'basti',
   true, true, false, '["acute diarrhoea","rectal bleeding","intestinal obstruction"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'ayurveda', 'nasya', 'Nasya', 'pradhana', 30, 'nasya',
   true, false, false, '["acute rhinitis","immediately after a bath","pregnancy first trimester"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'ayurveda', 'raktamokshana', 'Raktamokshana', 'pradhana', 45, 'procedure',
   true, true, true, '["anaemia","bleeding disorder","pregnancy","anticoagulant therapy"]'::jsonb, now(), now()),

  -- Paschat karma.
  (gen_random_uuid(), NULL, 'ayurveda', 'samsarjana', 'Samsarjana krama', 'paschat', 15, 'ward',
   false, false, false, '[]'::jsonb, now(), now()),

  -- Unani Ilaj bit-Tadbeer. Hijama and Fasd both break skin.
  (gen_random_uuid(), NULL, 'unani', 'hijama', 'Hijama (cupping)', 'pradhana', 40, 'procedure',
   true, true, true, '["bleeding disorder","anticoagulant therapy","severe anaemia","pregnancy"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'unani', 'fasd', 'Fasd (venesection)', 'pradhana', 30, 'procedure',
   true, true, true, '["anaemia","hypotension","bleeding disorder","pregnancy"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'unani', 'dalak', 'Dalak (massage)', 'purva', 40, 'abhyanga',
   false, true, false, '["acute inflammation","skin infection"]'::jsonb, now(), now()),

  -- Siddha.
  (gen_random_uuid(), NULL, 'siddha', 'varmam', 'Varmam therapy', 'pradhana', 40, 'procedure',
   true, true, false, '["fracture","acute injury","pregnancy"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'siddha', 'thokkanam', 'Thokkanam', 'purva', 45, 'abhyanga',
   false, true, false, '["acute fever","skin infection"]'::jsonb, now(), now()),

  -- Naturopathy.
  (gen_random_uuid(), NULL, 'yoga_naturopathy', 'mud_pack', 'Mud pack', 'purva', 30, 'mud',
   false, false, false, '["open wound","severe cold"]'::jsonb, now(), now()),
  (gen_random_uuid(), NULL, 'yoga_naturopathy', 'hydrotherapy', 'Hydrotherapy', 'purva', 30, 'hydro',
   false, true, false, '["cardiac disease","uncontrolled hypertension","open wound"]'::jsonb, now(), now())
) AS v(id, hospital_id, system, code, name, phase, default_duration_min, room_type,
       requires_consent, gender_match_required, invasive, contraindications, created_at, updated_at)
WHERE NOT EXISTS (
  SELECT 1 FROM mdm.ayush_procedures p WHERE p.hospital_id IS NULL AND p.code = v.code
);
