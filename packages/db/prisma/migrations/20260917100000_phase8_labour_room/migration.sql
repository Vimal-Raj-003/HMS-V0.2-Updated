-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · IP-011 — the labour room and the newborn
-- The first console that produces a patient rather than recording one
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **Crossing the action line stops the chart.** A partograph is one of the
--    most effective safety interventions in obstetrics and it works for exactly
--    one reason: the second diagonal line is supposed to force a decision.
--    Augment, assist, section, refer — but decide, and write down which. What
--    happens instead is that the line is crossed, the chart keeps being filled
--    in, and the decision arrives two hours later with a stillbirth or a
--    ruptured uterus attached. So the next *dilatation* cannot be plotted until
--    a decision is recorded. Everything else — the fetal heart, the blood
--    pressure, the drugs — continues, because nothing about this should slow
--    care down; it is the chart that stops, not the room.
--
-- 2. **The alert and action lines are the database's, not a nurse's ruler.**
--    One centimetre an hour from the start of the active phase, action four
--    hours to its right. It is a subtraction and a multiplication on a chart
--    somebody is holding while a woman is pushing.
--
-- 3. **An abnormal fetal heart raises immediately and does not block.** Under
--    110 or over 160 for a recorded observation. A bradycardia needs a person
--    in the room in seconds, and a rule that stopped the chart would be a rule
--    that stopped the recording of the bradycardia.
--
-- 4. **The second stage has a clock.** Three hours for a first baby with an
--    epidural, two without; two hours and one for a subsequent one. Beyond it,
--    the risk to the baby rises steeply and somebody has to decide again.
--
-- 5. **A uterotonic within one minute of birth.** Active management of the
--    third stage is the single most effective thing anybody does to prevent
--    postpartum haemorrhage, which is the leading cause of maternal death in
--    India, and it is a one-minute window. The delay is derived and recorded,
--    because a unit that thinks it does this and does not is only visible in
--    the distribution.
--
-- 6. **Blood loss over the threshold activates the protocol by itself.** Five
--    hundred millilitres after a vaginal birth, a thousand after a caesarean.
--    Nobody activates a haemorrhage protocol a moment too early; they activate
--    it twenty minutes late, having been sure it was settling.
--
-- 7. **Tranexamic acid is only counted inside three hours.** Within three
--    hours of birth it reduces death from bleeding; after three hours it does
--    not, and may harm. The window is derived from the birth, not from the
--    activation.
--
-- 8. **A live birth records APGAR at one and five minutes, and at ten when the
--    five-minute score is under seven.** And a resuscitation with
--    positive-pressure ventilation records its timeline, because a
--    resuscitation with no times is a resuscitation nobody can review.
--
-- 9. **Two bands, one code, and a mismatch is a hard stop.** Babies are swapped
--    in busy units; it is discovered years later or never, and there is no
--    remedy. Every handover scans both bands and the database decides whether
--    they match.
--
-- 10. **Form 1 within twenty-one days.** After that a birth registration needs
--     a magistrate, and the family finds out when the child is five and needs a
--     school place.
--
-- ── And this is where the sex of the baby is recorded ───────────────────────
--
-- `specialty.newborns.sex` is the only column in the whole obstetric build that
-- names it, and it is here because the baby is born and it goes on the birth
-- certificate. OP-040 §B.6 asserts its absence from every antenatal table; this
-- migration is the other half of that sentence.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: IP011.
-- ═════════════════════════════════════════════════════════════════════════════


-- CreateEnum
CREATE TYPE "specialty"."PartographStandard" AS ENUM ('who_classic', 'lcg');

-- CreateEnum
CREATE TYPE "specialty"."LabourOutcome" AS ENUM ('vaginal', 'assisted', 'lscs', 'referred', 'undelivered');

-- CreateEnum
CREATE TYPE "specialty"."DeliveryMode" AS ENUM ('spontaneous_vaginal', 'vacuum', 'forceps', 'breech', 'lscs_elective', 'lscs_emergency');

-- CreateEnum
CREATE TYPE "specialty"."NewbornStatus" AS ENUM ('live', 'stillbirth_fresh', 'stillbirth_macerated', 'neonatal_death');

-- CreateTable
CREATE TABLE "specialty"."labour_episodes" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "pregnancy_id" UUID,
    "edd_at_admission" DATE,
    "gpal" JSONB NOT NULL DEFAULT '{}',
    "risk_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blood_group" VARCHAR(8),
    "rh_negative" BOOLEAN,
    "onset_at" TIMESTAMPTZ(6),
    "membrane_status" VARCHAR(16),
    "membrane_rupture_at" TIMESTAMPTZ(6),
    "liquor" VARCHAR(24),
    "presentation" VARCHAR(24),
    "parity" INTEGER NOT NULL DEFAULT 0,
    "partograph_standard" "specialty"."PartographStandard" NOT NULL DEFAULT 'who_classic',
    "active_phase_from" TIMESTAMPTZ(6),
    "second_stage_from" TIMESTAMPTZ(6),
    "epidural" BOOLEAN NOT NULL DEFAULT false,
    "companion_present" BOOLEAN NOT NULL DEFAULT false,
    "consents" JSONB NOT NULL DEFAULT '{}',
    "outcome" "specialty"."LabourOutcome",
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "labour_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."partograph_entries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "param" VARCHAR(24) NOT NULL,
    "value" JSONB NOT NULL,
    "dilatation_cm" INTEGER,
    "fhr" INTEGER,
    "source" VARCHAR(16) NOT NULL DEFAULT 'manual',
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partograph_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."partograph_alerts" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "raised_at" TIMESTAMPTZ(6) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "details" JSONB NOT NULL DEFAULT '{}',
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "acknowledged_by" UUID,
    "acknowledged_at" TIMESTAMPTZ(6),
    "decision" VARCHAR(32),
    "decision_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partograph_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."deliveries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "episode_id" UUID NOT NULL,
    "baby_seq" INTEGER NOT NULL,
    "mode" "specialty"."DeliveryMode" NOT NULL,
    "delivered_at" TIMESTAMPTZ(6) NOT NULL,
    "place" VARCHAR(60),
    "attendants" JSONB NOT NULL DEFAULT '[]',
    "indication" TEXT,
    "ot_case_id" UUID,
    "decision_to_delivery_min" INTEGER,
    "episiotomy" BOOLEAN NOT NULL DEFAULT false,
    "tear_degree" VARCHAR(16),
    "repair_by" UUID,
    "uterotonic_drug" VARCHAR(60),
    "uterotonic_at" TIMESTAMPTZ(6),
    "uterotonic_delay_sec" INTEGER,
    "placenta" JSONB NOT NULL DEFAULT '{}',
    "third_stage" JSONB NOT NULL DEFAULT '{}',
    "ebl_ml" INTEGER,
    "ebl_method" VARCHAR(24),
    "complications" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pph_activations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "activated_at" TIMESTAMPTZ(6) NOT NULL,
    "trigger" VARCHAR(24) NOT NULL,
    "ebl_at_trigger" INTEGER,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "txa_at" TIMESTAMPTZ(6),
    "txa_within_3h" BOOLEAN,
    "mtp_activation_id" UUID,
    "ot_case_id" UUID,
    "outcome" TEXT,
    "deactivated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pph_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."newborns" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "mother_patient_id" UUID NOT NULL,
    "mother_admission_id" UUID,
    "admission_id" UUID,
    "delivery_id" UUID NOT NULL,
    "birth_at" TIMESTAMPTZ(6) NOT NULL,
    "sex" VARCHAR(16) NOT NULL,
    "status" "specialty"."NewbornStatus" NOT NULL DEFAULT 'live',
    "birth_weight_g" INTEGER,
    "length_cm" DECIMAL(4,1),
    "hc_cm" DECIMAL(4,1),
    "ga_weeks" INTEGER,
    "apgar_1" INTEGER,
    "apgar_5" INTEGER,
    "apgar_10" INTEGER,
    "apgar_components" JSONB NOT NULL DEFAULT '{}',
    "resuscitation" JSONB NOT NULL DEFAULT '{}',
    "vitamin_k_at" TIMESTAMPTZ(6),
    "cord_clamp_delayed" BOOLEAN NOT NULL DEFAULT false,
    "first_feed_at" TIMESTAMPTZ(6),
    "skin_to_skin_min" INTEGER,
    "wristband_pair_code" VARCHAR(24) NOT NULL,
    "nicu_admitted" BOOLEAN NOT NULL DEFAULT false,
    "temp_name" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "newborns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."newborn_exams" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "newborn_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "examined_at" TIMESTAMPTZ(6) NOT NULL,
    "examined_by" UUID NOT NULL,
    "findings" JSONB NOT NULL DEFAULT '{}',
    "anomalies" JSONB NOT NULL DEFAULT '[]',
    "cchd_screen" JSONB NOT NULL DEFAULT '{}',
    "hip" VARCHAR(24),
    "red_reflex" VARCHAR(24),
    "weight_g" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "newborn_exams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."newborn_identity_checks" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "newborn_id" UUID NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "mother_band_scan" VARCHAR(24) NOT NULL,
    "baby_band_scan" VARCHAR(24) NOT NULL,
    "matched" BOOLEAN NOT NULL,
    "context" VARCHAR(32) NOT NULL,
    "checked_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newborn_identity_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."birth_reports" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "newborn_id" UUID NOT NULL,
    "form1" JSONB NOT NULL,
    "due_by" DATE NOT NULL,
    "verified_by" UUID,
    "verified_at" TIMESTAMPTZ(6),
    "submitted_at" TIMESTAMPTZ(6),
    "crs_reg_no" VARCHAR(60),
    "hospital_cert_no" VARCHAR(40),
    "issued_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "birth_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "labour_episodes_hospital_id_branch_id_completed_at_idx" ON "specialty"."labour_episodes"("hospital_id", "branch_id", "completed_at");

-- CreateIndex
CREATE INDEX "labour_episodes_hospital_id_patient_id_idx" ON "specialty"."labour_episodes"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "partograph_entries_hospital_id_episode_id_recorded_at_idx" ON "specialty"."partograph_entries"("hospital_id", "episode_id", "recorded_at");

-- CreateIndex
CREATE INDEX "partograph_alerts_hospital_id_episode_id_raised_at_idx" ON "specialty"."partograph_alerts"("hospital_id", "episode_id", "raised_at");

-- CreateIndex
CREATE INDEX "deliveries_hospital_id_delivered_at_idx" ON "specialty"."deliveries"("hospital_id", "delivered_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_delivery_baby_seq" ON "specialty"."deliveries"("episode_id", "baby_seq");

-- CreateIndex
CREATE INDEX "pph_activations_hospital_id_activated_at_idx" ON "specialty"."pph_activations"("hospital_id", "activated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "newborns_delivery_id_key" ON "specialty"."newborns"("delivery_id");

-- CreateIndex
CREATE INDEX "newborns_hospital_id_birth_at_idx" ON "specialty"."newborns"("hospital_id", "birth_at" DESC);

-- CreateIndex
CREATE INDEX "newborns_hospital_id_mother_patient_id_idx" ON "specialty"."newborns"("hospital_id", "mother_patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_wristband_pair" ON "specialty"."newborns"("hospital_id", "wristband_pair_code");

-- CreateIndex
CREATE INDEX "newborn_exams_hospital_id_newborn_id_examined_at_idx" ON "specialty"."newborn_exams"("hospital_id", "newborn_id", "examined_at");

-- CreateIndex
CREATE INDEX "newborn_identity_checks_hospital_id_newborn_id_checked_at_idx" ON "specialty"."newborn_identity_checks"("hospital_id", "newborn_id", "checked_at");

-- CreateIndex
CREATE UNIQUE INDEX "birth_reports_newborn_id_key" ON "specialty"."birth_reports"("newborn_id");

-- CreateIndex
CREATE INDEX "birth_reports_hospital_id_due_by_idx" ON "specialty"."birth_reports"("hospital_id", "due_by");

-- AddForeignKey
ALTER TABLE "specialty"."partograph_entries" ADD CONSTRAINT "partograph_entries_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."labour_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."partograph_alerts" ADD CONSTRAINT "partograph_alerts_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."labour_episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."deliveries" ADD CONSTRAINT "deliveries_episode_id_fkey" FOREIGN KEY ("episode_id") REFERENCES "specialty"."labour_episodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."pph_activations" ADD CONSTRAINT "pph_activations_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "specialty"."deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."newborns" ADD CONSTRAINT "newborns_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "specialty"."deliveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."newborn_exams" ADD CONSTRAINT "newborn_exams_newborn_id_fkey" FOREIGN KEY ("newborn_id") REFERENCES "specialty"."newborns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."newborn_identity_checks" ADD CONSTRAINT "newborn_identity_checks_newborn_id_fkey" FOREIGN KEY ("newborn_id") REFERENCES "specialty"."newborns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."birth_reports" ADD CONSTRAINT "birth_reports_newborn_id_fkey" FOREIGN KEY ("newborn_id") REFERENCES "specialty"."newborns"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  The partograph's two lines ────────────────────────────────────────
--
-- One centimetre an hour from the start of the active phase is the alert line;
-- four hours to its right is the action line. Both are arithmetic on a chart
-- somebody is holding while a woman is pushing, which is exactly why they are
-- computed here.
--
-- The action line is the one that matters. Crossing it raises a *blocking*
-- alert, and the next dilatation cannot be plotted until somebody records what
-- they decided to do. Everything else keeps being recorded — the fetal heart,
-- the blood pressure, the drugs — because a rule that slowed the room down
-- would be worse than the one it replaced.

CREATE OR REPLACE FUNCTION specialty.action_line_hours() RETURNS int
  LANGUAGE sql IMMUTABLE AS $$ SELECT 4 $$;

-- Where the alert line says she should be by now.
CREATE OR REPLACE FUNCTION specialty.expected_dilatation_cm(
  p_active_from timestamptz, p_at timestamptz, p_standard specialty."PartographStandard")
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_active_from IS NULL THEN NULL
              ELSE least(
                CASE WHEN p_standard = 'lcg' THEN 5 ELSE 4 END
                  + extract(epoch FROM (p_at - p_active_from)) / 3600.0,
                10)
         END::numeric
$$;

CREATE OR REPLACE FUNCTION specialty.partograph_watches_the_lines()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ep        record;
  v_expected  numeric;
  v_behind_h  numeric;
  v_blocking  record;
  v_limit_min int;
BEGIN
  SELECT e.active_phase_from, e.second_stage_from, e.partograph_standard, e.parity,
         e.epidural, e.hospital_id, e.completed_at
    INTO v_ep
    FROM specialty.labour_episodes e WHERE e.id = NEW.episode_id;

  IF v_ep.hospital_id IS DISTINCT FROM NEW.hospital_id THEN
    RAISE EXCEPTION 'That labour episode belongs to a different hospital. (IP-011 §B.1)'
      USING ERRCODE = 'IP011';
  END IF;

  -- Pull the two charted numbers out of the value so the trigger and the chart
  -- read one figure rather than two copies of it.
  IF NEW.param = 'dilatation' THEN
    NEW.dilatation_cm := (NEW.value ->> 'cm')::int;
    IF NEW.dilatation_cm IS NULL OR NEW.dilatation_cm < 0 OR NEW.dilatation_cm > 10 THEN
      RAISE EXCEPTION 'A cervix dilates from 0 to 10 cm. (IP-011 §B.1)' USING ERRCODE = 'IP011';
    END IF;
  ELSIF NEW.param = 'fhr' THEN
    NEW.fhr := (NEW.value ->> 'bpm')::int;
    IF NEW.fhr IS NULL OR NEW.fhr < 50 OR NEW.fhr > 240 THEN
      RAISE EXCEPTION 'A fetal heart rate runs from 50 to 240. (IP-011 §B.1)' USING ERRCODE = 'IP011';
    END IF;
  END IF;

  -- ── The block ─────────────────────────────────────────────────────────────
  -- Only dilatation. The chart stops advancing; the observations do not.
  IF NEW.param = 'dilatation' THEN
    SELECT a.id, a.raised_at INTO v_blocking
      FROM specialty.partograph_alerts a
     WHERE a.episode_id = NEW.episode_id AND a.blocking AND a.decision IS NULL
     ORDER BY a.raised_at LIMIT 1;

    IF v_blocking.id IS NOT NULL THEN
      RAISE EXCEPTION 'This labour crossed the action line at %, and no decision has been recorded. The point of the line is that one of augmentation, assisted delivery, caesarean, referral or a documented decision to continue now happens — plotting past it is how a chart comes to look complete beside a stillbirth. Record the decision, then continue the chart. (IP-011 §B.1)',
        to_char(v_blocking.raised_at, 'HH24:MI')
        USING ERRCODE = 'IP011';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_partograph_watches_the_lines
  BEFORE INSERT ON specialty.partograph_entries
  FOR EACH ROW EXECUTE FUNCTION specialty.partograph_watches_the_lines();

-- Raising the alerts happens after the row lands, so the entry that crossed the
-- line is itself on the chart.
CREATE OR REPLACE FUNCTION specialty.partograph_raises_its_alerts()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_ep       record;
  v_expected numeric;
  v_behind_h numeric;
  v_limit    int;
  v_elapsed  int;
BEGIN
  SELECT e.active_phase_from, e.second_stage_from, e.partograph_standard, e.parity, e.epidural
    INTO v_ep
    FROM specialty.labour_episodes e WHERE e.id = NEW.episode_id;

  IF NEW.param = 'dilatation' AND v_ep.active_phase_from IS NOT NULL THEN
    v_expected := specialty.expected_dilatation_cm(
                    v_ep.active_phase_from, NEW.recorded_at, v_ep.partograph_standard);

    IF NEW.dilatation_cm < v_expected THEN
      -- How far right of the alert line this point falls, in hours.
      v_behind_h := round(v_expected - NEW.dilatation_cm, 2);

      IF v_behind_h >= specialty.action_line_hours() THEN
        INSERT INTO specialty.partograph_alerts
          (id, hospital_id, episode_id, raised_at, kind, details, blocking, created_at)
        SELECT gen_random_uuid(), NEW.hospital_id, NEW.episode_id, NEW.recorded_at, 'action_line',
               jsonb_build_object('dilatationCm', NEW.dilatation_cm,
                                  'expectedCm', round(v_expected, 1),
                                  'hoursBehind', v_behind_h),
               true, now()
        WHERE NOT EXISTS (
          SELECT 1 FROM specialty.partograph_alerts a
           WHERE a.episode_id = NEW.episode_id AND a.kind = 'action_line' AND a.decision IS NULL);
      ELSE
        INSERT INTO specialty.partograph_alerts
          (id, hospital_id, episode_id, raised_at, kind, details, blocking, created_at)
        SELECT gen_random_uuid(), NEW.hospital_id, NEW.episode_id, NEW.recorded_at, 'alert_line',
               jsonb_build_object('dilatationCm', NEW.dilatation_cm,
                                  'expectedCm', round(v_expected, 1),
                                  'hoursBehind', v_behind_h),
               false, now()
        WHERE NOT EXISTS (
          SELECT 1 FROM specialty.partograph_alerts a
           WHERE a.episode_id = NEW.episode_id AND a.kind = 'alert_line'
             AND a.acknowledged_at IS NULL);
      END IF;
    END IF;
  END IF;

  -- A bradycardia needs somebody in the room in seconds, so this raises and
  -- never blocks.
  IF NEW.param = 'fhr' AND (NEW.fhr < 110 OR NEW.fhr > 160) THEN
    INSERT INTO specialty.partograph_alerts
      (id, hospital_id, episode_id, raised_at, kind, details, blocking, created_at)
    VALUES (gen_random_uuid(), NEW.hospital_id, NEW.episode_id, NEW.recorded_at, 'fhr_abnormal',
            jsonb_build_object('fhr', NEW.fhr), false, now());
  END IF;

  -- The second-stage clock: three hours for a first baby with an epidural, two
  -- without; two and one for a subsequent one.
  IF v_ep.second_stage_from IS NOT NULL THEN
    v_limit := CASE WHEN v_ep.parity = 0 THEN CASE WHEN v_ep.epidural THEN 180 ELSE 120 END
                    ELSE CASE WHEN v_ep.epidural THEN 120 ELSE 60 END END;
    v_elapsed := (extract(epoch FROM (NEW.recorded_at - v_ep.second_stage_from)) / 60)::int;
    IF v_elapsed > v_limit THEN
      INSERT INTO specialty.partograph_alerts
        (id, hospital_id, episode_id, raised_at, kind, details, blocking, created_at)
      SELECT gen_random_uuid(), NEW.hospital_id, NEW.episode_id, NEW.recorded_at,
             'second_stage_prolonged',
             jsonb_build_object('minutes', v_elapsed, 'limitMinutes', v_limit,
                                'parity', v_ep.parity, 'epidural', v_ep.epidural),
             false, now()
      WHERE NOT EXISTS (
        SELECT 1 FROM specialty.partograph_alerts a
         WHERE a.episode_id = NEW.episode_id AND a.kind = 'second_stage_prolonged'
           AND a.acknowledged_at IS NULL);
    END IF;
  END IF;

  RETURN NULL;
END $$;

CREATE TRIGGER trg_partograph_raises_its_alerts
  AFTER INSERT ON specialty.partograph_entries
  FOR EACH ROW EXECUTE FUNCTION specialty.partograph_raises_its_alerts();

-- A decision is one of a small number of things, not free text — because the
-- point of the action line is that one of them now happens.
ALTER TABLE "specialty"."partograph_alerts"
  ADD CONSTRAINT "a_decision_is_one_of_the_five"
  CHECK ("decision" IS NULL
      OR "decision" IN ('augment', 'assist', 'caesarean', 'refer', 'continue_expectantly'));

ALTER TABLE "specialty"."partograph_alerts"
  ADD CONSTRAINT "a_decision_has_a_decider"
  CHECK ("decision" IS NULL OR ("acknowledged_by" IS NOT NULL AND "acknowledged_at" IS NOT NULL));

-- Continuing expectantly past the action line is a real and sometimes correct
-- decision. It is also the one that needs a sentence beside it.
ALTER TABLE "specialty"."partograph_alerts"
  ADD CONSTRAINT "continuing_past_the_action_line_says_why"
  CHECK ("decision" <> 'continue_expectantly'
      OR ("decision_note" IS NOT NULL AND length(btrim("decision_note")) >= 8));


-- ── §B.2  The third stage, and the minute that prevents most of the deaths ──
--
-- A uterotonic within one minute of birth, controlled cord traction, uterine
-- massage. It is the single most effective thing anybody does about the leading
-- cause of maternal death in India, and it is a one-minute window. The delay is
-- derived rather than asserted, because a unit that believes it does this and
-- does not is only visible in the distribution of that number.
CREATE OR REPLACE FUNCTION specialty.derive_third_stage()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.uterotonic_at IS NULL THEN
    NEW.uterotonic_delay_sec := NULL;
  ELSE
    NEW.uterotonic_delay_sec := (extract(epoch FROM (NEW.uterotonic_at - NEW.delivered_at)))::int;
    IF NEW.uterotonic_delay_sec < 0 THEN
      RAISE EXCEPTION 'The uterotonic is recorded before the birth. Active management is the minute *after* the baby is out. (IP-011 §B.2)'
        USING ERRCODE = 'IP011';
    END IF;
  END IF;

  IF NEW.uterotonic_drug IS NULL AND NEW.uterotonic_at IS NOT NULL THEN
    RAISE EXCEPTION 'Record which uterotonic was given. Oxytocin, misoprostol and carbetocin are not interchangeable in a review. (IP-011 §B.2)'
      USING ERRCODE = 'IP011';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_third_stage
  BEFORE INSERT OR UPDATE OF delivered_at, uterotonic_at, uterotonic_drug, uterotonic_delay_sec
    ON specialty.deliveries
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_third_stage();

ALTER TABLE "specialty"."deliveries"
  ADD CONSTRAINT "blood_loss_is_a_volume" CHECK ("ebl_ml" IS NULL OR "ebl_ml" BETWEEN 0 AND 10000);

-- Visual estimation understates blood loss by roughly a third, which is why the
-- method is recorded and not only the number.
-- Note the explicit NOT NULL. `NULL IN (...)` is NULL, and a CHECK that
-- evaluates to NULL passes — so the obvious form of this constraint lets a
-- blood loss through with no method at all, which is the case it exists for.
ALTER TABLE "specialty"."deliveries"
  ADD CONSTRAINT "a_blood_loss_says_how_it_was_measured"
  CHECK ("ebl_ml" IS NULL
      OR ("ebl_method" IS NOT NULL
          AND "ebl_method" IN ('visual', 'gravimetric', 'calibrated_drape', 'suction_and_swabs')));

ALTER TABLE "specialty"."deliveries"
  ADD CONSTRAINT "a_baby_is_numbered_from_one" CHECK ("baby_seq" >= 1);

ALTER TABLE "specialty"."deliveries"
  ADD CONSTRAINT "an_emergency_caesarean_names_its_indication"
  CHECK ("mode" <> 'lscs_emergency'
      OR ("indication" IS NOT NULL AND length(btrim("indication")) >= 4));


-- ── §B.3  The haemorrhage protocol activates itself ─────────────────────────
--
-- Five hundred millilitres after a vaginal birth, a thousand after a caesarean.
-- Nobody activates a haemorrhage protocol a moment too early. They activate it
-- twenty minutes late, having been quite sure it was settling — which is why
-- the threshold belongs to the database and not to the person watching.
CREATE OR REPLACE FUNCTION specialty.pph_threshold_ml(p_mode specialty."DeliveryMode")
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_mode IN ('lscs_elective', 'lscs_emergency') THEN 1000 ELSE 500 END
$$;

CREATE OR REPLACE FUNCTION specialty.blood_loss_activates_the_protocol()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_threshold int;
BEGIN
  IF NEW.ebl_ml IS NULL THEN RETURN NULL; END IF;
  v_threshold := specialty.pph_threshold_ml(NEW.mode);
  IF NEW.ebl_ml < v_threshold THEN RETURN NULL; END IF;

  INSERT INTO specialty.pph_activations
    (id, hospital_id, delivery_id, activated_at, trigger, ebl_at_trigger, created_at, updated_at)
  SELECT gen_random_uuid(), NEW.hospital_id, NEW.id, now(), 'ebl_threshold', NEW.ebl_ml, now(), now()
  WHERE NOT EXISTS (
    SELECT 1 FROM specialty.pph_activations a
     WHERE a.delivery_id = NEW.id AND a.deactivated_at IS NULL);

  RETURN NULL;
END $$;

CREATE TRIGGER trg_blood_loss_activates_the_protocol
  AFTER INSERT OR UPDATE OF ebl_ml ON specialty.deliveries
  FOR EACH ROW EXECUTE FUNCTION specialty.blood_loss_activates_the_protocol();

-- Tranexamic acid within three hours of birth reduces death from bleeding.
-- After three hours it does not, and may harm. The window runs from the birth,
-- not from whenever somebody got round to activating the protocol.
CREATE OR REPLACE FUNCTION specialty.derive_txa_window()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_birth timestamptz;
  v_txa   timestamptz;
  v_step  jsonb;
BEGIN
  SELECT d.delivered_at INTO v_birth FROM specialty.deliveries d WHERE d.id = NEW.delivery_id;

  v_txa := NULL;
  IF jsonb_typeof(NEW.steps) = 'array' THEN
    FOR v_step IN SELECT * FROM jsonb_array_elements(NEW.steps) LOOP
      IF v_step ->> 'step' = 'txa' AND v_step ? 'at' THEN
        v_txa := (v_step ->> 'at')::timestamptz;
      END IF;
    END LOOP;
  END IF;

  NEW.txa_at := v_txa;
  NEW.txa_within_3h := CASE WHEN v_txa IS NULL THEN NULL
                            ELSE v_txa <= v_birth + interval '3 hours' END;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_txa_window
  BEFORE INSERT OR UPDATE OF steps, txa_at, txa_within_3h ON specialty.pph_activations
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_txa_window();

ALTER TABLE "specialty"."pph_activations"
  ADD CONSTRAINT "a_closed_activation_says_what_happened"
  CHECK ("deactivated_at" IS NULL
      OR ("outcome" IS NOT NULL AND length(btrim("outcome")) >= 4));


-- ── §B.4  The baby ──────────────────────────────────────────────────────────
--
-- APGAR at one and five minutes on every live birth, and at ten when the
-- five-minute score is under seven — because that is the score that predicts
-- what happens next, and the ten-minute one is what a neurology review reads
-- eight years later. A resuscitation that used positive-pressure ventilation
-- records its timeline: a resuscitation with no times is a resuscitation nobody
-- can review.
CREATE OR REPLACE FUNCTION specialty.a_live_birth_is_scored()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'live' THEN
    -- A stillbirth has no APGAR, and asking for one is cruel as well as wrong.
    RETURN NEW;
  END IF;

  IF NEW.apgar_1 IS NULL OR NEW.apgar_5 IS NULL THEN
    RAISE EXCEPTION 'A live birth records APGAR at one minute and at five. (IP-011 §B.4)'
      USING ERRCODE = 'IP011';
  END IF;

  IF NEW.apgar_5 < 7 AND NEW.apgar_10 IS NULL THEN
    RAISE EXCEPTION 'The five-minute APGAR is %, so a ten-minute score is required. It is the figure a neurology review reads years later, and it cannot be reconstructed. (IP-011 §B.4)',
      NEW.apgar_5
      USING ERRCODE = 'IP011';
  END IF;

  IF jsonb_typeof(NEW.resuscitation) = 'object'
     AND NEW.resuscitation ? 'ppv'
     AND NOT (NEW.resuscitation -> 'ppv' ? 'startAt') THEN
    RAISE EXCEPTION 'Positive-pressure ventilation was given, so the resuscitation needs its times. A resuscitation with no timeline is one nobody can review. (IP-011 §B.4)'
      USING ERRCODE = 'IP011';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_live_birth_is_scored
  BEFORE INSERT OR UPDATE OF status, apgar_1, apgar_5, apgar_10, resuscitation
    ON specialty.newborns
  FOR EACH ROW EXECUTE FUNCTION specialty.a_live_birth_is_scored();

ALTER TABLE "specialty"."newborns"
  ADD CONSTRAINT "an_apgar_is_out_of_ten"
  CHECK (("apgar_1" IS NULL OR "apgar_1" BETWEEN 0 AND 10)
     AND ("apgar_5" IS NULL OR "apgar_5" BETWEEN 0 AND 10)
     AND ("apgar_10" IS NULL OR "apgar_10" BETWEEN 0 AND 10));

ALTER TABLE "specialty"."newborns"
  ADD CONSTRAINT "a_birth_weight_is_a_birth_weight"
  CHECK ("birth_weight_g" IS NULL OR "birth_weight_g" BETWEEN 200 AND 8000);

ALTER TABLE "specialty"."newborns"
  ADD CONSTRAINT "a_newborn_sex_is_recorded_as_one_of_four"
  CHECK ("sex" IN ('male', 'female', 'ambiguous', 'unknown'));

ALTER TABLE "specialty"."newborns"
  ADD CONSTRAINT "a_gestation_at_birth_is_plausible"
  CHECK ("ga_weeks" IS NULL OR "ga_weeks" BETWEEN 20 AND 45);


-- ── §B.5  Two bands, one code ───────────────────────────────────────────────
--
-- Babies are swapped in busy units. It is discovered years later or never, and
-- there is no remedy — not for the families and not for the hospital. So a
-- handover scans both bands, the database decides whether they match, and a
-- mismatch is recorded as what it is rather than corrected into agreement.
CREATE OR REPLACE FUNCTION specialty.bands_have_to_match()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_code text;
BEGIN
  SELECT n.wristband_pair_code INTO v_code
    FROM specialty.newborns n WHERE n.id = NEW.newborn_id;

  NEW.matched := (NEW.mother_band_scan = NEW.baby_band_scan)
             AND (NEW.baby_band_scan = v_code);

  IF NOT NEW.matched THEN
    -- The row is written. What is refused is treating it as a completed
    -- handover, and that refusal is the caller's to see.
    RAISE WARNING 'Wristband mismatch on newborn %: mother band %, baby band %, expected %.',
      NEW.newborn_id, NEW.mother_band_scan, NEW.baby_band_scan, v_code;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_bands_have_to_match
  BEFORE INSERT OR UPDATE OF mother_band_scan, baby_band_scan, matched
    ON specialty.newborn_identity_checks
  FOR EACH ROW EXECUTE FUNCTION specialty.bands_have_to_match();

-- A baby is not discharged, transferred or handed over on an unmatched check.
-- This is the hard stop: the last identity check on the record has to have
-- matched before the newborn leaves anybody's hands.
CREATE OR REPLACE FUNCTION specialty.a_baby_leaves_only_on_a_matched_check()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_last record;
BEGIN
  IF NEW.admission_id IS NOT DISTINCT FROM OLD.admission_id
     AND NEW.nicu_admitted = OLD.nicu_admitted THEN
    RETURN NEW;
  END IF;

  SELECT c.matched, c.checked_at, c.context INTO v_last
    FROM specialty.newborn_identity_checks c
   WHERE c.newborn_id = NEW.id
   ORDER BY c.checked_at DESC, c.created_at DESC
   LIMIT 1;

  IF v_last.matched IS NULL THEN
    RAISE EXCEPTION 'This baby has no identity check. Scan both wristbands before moving them. (IP-011 §B.5)'
      USING ERRCODE = 'IP011';
  END IF;

  IF v_last.matched IS NOT TRUE THEN
    RAISE EXCEPTION 'The last identity check on this baby did not match, at % during %. A baby does not move on an unmatched pair — resolve it and scan again. (IP-011 §B.5)',
      to_char(v_last.checked_at, 'DD Mon HH24:MI'), v_last.context
      USING ERRCODE = 'IP011';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_baby_leaves_only_on_a_matched_check
  BEFORE UPDATE ON specialty.newborns
  FOR EACH ROW EXECUTE FUNCTION specialty.a_baby_leaves_only_on_a_matched_check();


-- ── §B.6  Form 1, and the twenty-one days ───────────────────────────────────
--
-- After twenty-one days a birth registration needs a magistrate, and the family
-- finds out when the child is five and needs a school place.
CREATE OR REPLACE FUNCTION specialty.birth_report_days() RETURNS int
  LANGUAGE sql IMMUTABLE AS $$ SELECT 21 $$;

CREATE OR REPLACE FUNCTION specialty.derive_birth_report_window()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_birth timestamptz;
BEGIN
  SELECT n.birth_at INTO v_birth FROM specialty.newborns n WHERE n.id = NEW.newborn_id;
  NEW.due_by := (v_birth + make_interval(days => specialty.birth_report_days()))::date;

  IF NEW.submitted_at IS NOT NULL AND NEW.verified_at IS NULL THEN
    RAISE EXCEPTION 'Form 1 is verified by medical records before it goes to the Registrar. (IP-011 §B.6)'
      USING ERRCODE = 'IP011';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_birth_report_window
  BEFORE INSERT OR UPDATE OF newborn_id, due_by, verified_at, submitted_at
    ON specialty.birth_reports
  FOR EACH ROW EXECUTE FUNCTION specialty.derive_birth_report_window();

ALTER TABLE "specialty"."birth_reports"
  ADD CONSTRAINT "a_registered_birth_names_its_number"
  CHECK ("crs_reg_no" IS NULL OR "submitted_at" IS NOT NULL);


-- ── §B.7  The episode ───────────────────────────────────────────────────────
ALTER TABLE "specialty"."labour_episodes"
  ADD CONSTRAINT "a_second_stage_follows_an_active_phase"
  CHECK ("second_stage_from" IS NULL OR "active_phase_from" IS NULL
      OR "second_stage_from" >= "active_phase_from");

ALTER TABLE "specialty"."labour_episodes"
  ADD CONSTRAINT "a_completed_labour_has_an_outcome"
  CHECK (("completed_at" IS NULL) = ("outcome" IS NULL));

ALTER TABLE "specialty"."labour_episodes"
  ADD CONSTRAINT "membranes_that_ruptured_say_when"
  CHECK ("membrane_status" IS NULL OR "membrane_status" = 'intact'
      OR "membrane_rupture_at" IS NOT NULL);


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
      AND c.relname IN ('labour_episodes','partograph_entries','partograph_alerts','deliveries',
                        'pph_activations','newborns','newborn_exams','newborn_identity_checks',
                        'birth_reports')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % labour room table(s)', v_count;
END $$;

-- A partograph is a contemporaneous record. An entry that can be deleted or
-- moved is not one, and the chart is the document a coroner reads.
REVOKE UPDATE, DELETE ON "specialty"."partograph_entries" FROM hms_app;

-- The identity check is the evidence. A mismatch that can be edited into a
-- match is worse than no check at all.
REVOKE UPDATE, DELETE ON "specialty"."newborn_identity_checks" FROM hms_app;

-- A birth happened. Nothing deletes a delivery, a newborn or an activation of
-- the haemorrhage protocol.
REVOKE DELETE ON "specialty"."deliveries"      FROM hms_app;
REVOKE DELETE ON "specialty"."newborns"        FROM hms_app;
REVOKE DELETE ON "specialty"."pph_activations" FROM hms_app;
REVOKE DELETE ON "specialty"."birth_reports"   FROM hms_app;

-- An alert is acknowledged and decided; it is not withdrawn.
REVOKE DELETE ON "specialty"."partograph_alerts" FROM hms_app;


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
    AND c.relname IN ('labour_episodes','partograph_entries','partograph_alerts','deliveries',
                      'pph_activations','newborns','newborn_exams','newborn_identity_checks',
                      'birth_reports')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Labour room tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;
