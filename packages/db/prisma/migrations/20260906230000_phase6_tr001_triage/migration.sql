-- ═════════════════════════════════════════════════════════════════════════════
-- TR-001 — triage, trauma activation and the golden hour
--
-- `docs/prompts/phase-06-emergency-trauma-ortho.md` §6.2–6.5, exit gates 3, 4
-- and 5.
--
-- ── Three rules, each a failure somebody has actually had ───────────────────
--
-- **§B.1 Re-triage never overwrites.** A patient triaged ESI-4 who deteriorates
-- to ESI-2 has two records. The first is the only evidence of whether the wait
-- that followed it was reasonable, and an edit destroys it.
--
-- **§B.3 A Level 1 page cannot be silenced.** §6.3 says so in as many words.
-- The failure is a night shift muting the trauma pager after two stand-downs
-- and not hearing the third page.
--
-- **§B.5 A locked score is immutable.** TRISS and ISS go into a trauma registry
-- and into mortality review. An amendment is a new version with a reason, so
-- "the score was changed after the death" is answerable either way.
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
CREATE TYPE "clinical"."TriageSystem" AS ENUM ('esi', 'start', 'jump_start');

-- CreateEnum
CREATE TYPE "clinical"."TriageTag" AS ENUM ('red', 'yellow', 'green', 'black');

-- CreateEnum
CREATE TYPE "clinical"."ActivationTier" AS ENUM ('level_1', 'level_2', 'consult');

-- CreateEnum
CREATE TYPE "clinical"."ActivationStatus" AS ENUM ('active', 'stood_down', 'completed');

-- CreateEnum
CREATE TYPE "clinical"."PageStatus" AS ENUM ('queued', 'sent', 'acknowledged', 'arrived', 'failed');

-- CreateEnum
CREATE TYPE "clinical"."ScoreStatus" AS ENUM ('provisional', 'locked', 'amended');

-- AlterTable

-- CreateTable
CREATE TABLE "clinical"."triage_records" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "er_visit_id" UUID NOT NULL,
    "patient_id" UUID,
    "system" "clinical"."TriageSystem" NOT NULL DEFAULT 'esi',
    "sequence_no" INTEGER NOT NULL,
    "esi_level" INTEGER,
    "decision_point" VARCHAR(2),
    "resource_count" INTEGER,
    "suggested_level" INTEGER,
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "override_reason" TEXT,
    "tag" "clinical"."TriageTag",
    "heart_rate" INTEGER,
    "respiratory_rate" INTEGER,
    "systolic_bp" INTEGER,
    "diastolic_bp" INTEGER,
    "spo2" INTEGER,
    "temperature_c" DECIMAL(4,1),
    "pain_score" INTEGER,
    "glucose" INTEGER,
    "gcs_eye" INTEGER,
    "gcs_verbal" INTEGER,
    "gcs_motor" INTEGER,
    "gcs_total" INTEGER,
    "gcs_intubated" BOOLEAN NOT NULL DEFAULT false,
    "chief_complaint" TEXT,
    "pathways" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "target_seen_by" TIMESTAMPTZ(6),
    "triaged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triaged_by" UUID,
    "device_id" VARCHAR(64),
    "device_sequence" INTEGER,
    "recorded_offline" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "triage_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."trauma_activations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "er_visit_id" UUID NOT NULL,
    "triage_record_id" UUID,
    "tier" "clinical"."ActivationTier" NOT NULL,
    "status" "clinical"."ActivationStatus" NOT NULL DEFAULT 'active',
    "criteria_fired" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clinical_judgement" BOOLEAN NOT NULL DEFAULT false,
    "activated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_by" UUID,
    "stood_down_at" TIMESTAMPTZ(6),
    "stood_down_by" UUID,
    "stand_down_reason" TEXT,
    "final_iss" INTEGER,
    "over_triage" BOOLEAN,
    "under_triage" BOOLEAN,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "trauma_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."activation_pages" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "activation_id" UUID NOT NULL,
    "role" VARCHAR(32) NOT NULL,
    "user_id" UUID,
    "roster_ref" VARCHAR(64),
    "channel" VARCHAR(16) NOT NULL DEFAULT 'push',
    "status" "clinical"."PageStatus" NOT NULL DEFAULT 'queued',
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "sent_at" TIMESTAMPTZ(6),
    "acknowledged_at" TIMESTAMPTZ(6),
    "arrived_at" TIMESTAMPTZ(6),
    "eta_minutes" INTEGER,
    "failure_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activation_pages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."primary_surveys" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "er_visit_id" UUID NOT NULL,
    "activation_id" UUID,
    "injury_at" TIMESTAMPTZ(6),
    "door_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ct_at" TIMESTAMPTZ(6),
    "ot_at" TIMESTAMPTZ(6),
    "airway_patent" BOOLEAN,
    "airway_adjunct" VARCHAR(40),
    "collar_at" TIMESTAMPTZ(6),
    "intubated_at" TIMESTAMPTZ(6),
    "breath_sounds_equal" BOOLEAN,
    "needle_decomp_at" TIMESTAMPTZ(6),
    "chest_drain_at" TIMESTAMPTZ(6),
    "tourniquet_on_at" TIMESTAMPTZ(6),
    "tourniquet_off_at" TIMESTAMPTZ(6),
    "tourniquet_site" VARCHAR(40),
    "pelvic_binder_at" TIMESTAMPTZ(6),
    "iv_access_count" INTEGER NOT NULL DEFAULT 0,
    "io_access" BOOLEAN NOT NULL DEFAULT false,
    "crystalloid_ml" INTEGER NOT NULL DEFAULT 0,
    "blood_units" INTEGER NOT NULL DEFAULT 0,
    "mtp_activated_at" TIMESTAMPTZ(6),
    "fast_result" VARCHAR(24),
    "pupil_left_mm" INTEGER,
    "pupil_right_mm" INTEGER,
    "pupils_reactive" BOOLEAN,
    "exposed_at" TIMESTAMPTZ(6),
    "log_rolled_at" TIMESTAMPTZ(6),
    "temperature_c" DECIMAL(4,1),
    "tetanus_at" TIMESTAMPTZ(6),
    "txa_at" TIMESTAMPTZ(6),
    "antibiotic_at" TIMESTAMPTZ(6),
    "ample_history" JSONB,
    "mechanism" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "primary_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."survey_interventions" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "survey_id" UUID NOT NULL,
    "kind" VARCHAR(40) NOT NULL,
    "detail" TEXT,
    "at_time" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id" UUID,

    CONSTRAINT "survey_interventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."trauma_injuries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "er_visit_id" UUID NOT NULL,
    "region" VARCHAR(24) NOT NULL,
    "ais_severity" INTEGER NOT NULL,
    "ais_code" VARCHAR(24),
    "description" VARCHAR(300) NOT NULL,
    "side" VARCHAR(16),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "trauma_injuries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."trauma_scores" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "er_visit_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" "clinical"."ScoreStatus" NOT NULL DEFAULT 'provisional',
    "arrival_gcs" INTEGER,
    "arrival_sbp" INTEGER,
    "arrival_rr" INTEGER,
    "age_years" INTEGER,
    "mechanism" VARCHAR(16),
    "rts" DECIMAL(6,4),
    "iss" INTEGER,
    "niss" INTEGER,
    "shock_index" DECIMAL(5,2),
    "mgap" INTEGER,
    "gap" INTEGER,
    "triss" DECIMAL(6,4),
    "triss_coefficient_set" VARCHAR(64),
    "locked_at" TIMESTAMPTZ(6),
    "locked_by" UUID,
    "supersedes_id" UUID,
    "amend_reason" TEXT,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "trauma_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."mci_incidents" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "incident_code" VARCHAR(24) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "source" VARCHAR(24) NOT NULL DEFAULT 'local',
    "declared_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declared_by" UUID,
    "stood_down_at" TIMESTAMPTZ(6),
    "stood_down_by" UUID,
    "after_action_report" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mci_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "triage_records_hospital_id_er_visit_id_triaged_at_idx" ON "clinical"."triage_records"("hospital_id", "er_visit_id", "triaged_at" DESC);

-- CreateIndex
CREATE INDEX "triage_records_hospital_id_branch_id_triaged_at_idx" ON "clinical"."triage_records"("hospital_id", "branch_id", "triaged_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_triage_sequence_per_visit" ON "clinical"."triage_records"("er_visit_id", "sequence_no");

-- CreateIndex
CREATE INDEX "trauma_activations_hospital_id_branch_id_status_activated_a_idx" ON "clinical"."trauma_activations"("hospital_id", "branch_id", "status", "activated_at" DESC);

-- CreateIndex
CREATE INDEX "trauma_activations_hospital_id_er_visit_id_idx" ON "clinical"."trauma_activations"("hospital_id", "er_visit_id");

-- CreateIndex
CREATE INDEX "activation_pages_hospital_id_status_created_at_idx" ON "clinical"."activation_pages"("hospital_id", "status", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_activation_page_per_role" ON "clinical"."activation_pages"("activation_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "primary_surveys_er_visit_id_key" ON "clinical"."primary_surveys"("er_visit_id");

-- CreateIndex
CREATE INDEX "primary_surveys_hospital_id_door_at_idx" ON "clinical"."primary_surveys"("hospital_id", "door_at" DESC);

-- CreateIndex
CREATE INDEX "survey_interventions_hospital_id_survey_id_at_time_idx" ON "clinical"."survey_interventions"("hospital_id", "survey_id", "at_time");

-- CreateIndex
CREATE INDEX "trauma_injuries_hospital_id_er_visit_id_idx" ON "clinical"."trauma_injuries"("hospital_id", "er_visit_id");

-- CreateIndex
CREATE INDEX "trauma_scores_hospital_id_er_visit_id_version_no_idx" ON "clinical"."trauma_scores"("hospital_id", "er_visit_id", "version_no" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_trauma_score_version" ON "clinical"."trauma_scores"("er_visit_id", "version_no");

-- CreateIndex
CREATE INDEX "mci_incidents_hospital_id_branch_id_declared_at_idx" ON "clinical"."mci_incidents"("hospital_id", "branch_id", "declared_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "mci_incidents_hospital_id_incident_code_key" ON "clinical"."mci_incidents"("hospital_id", "incident_code");

-- AddForeignKey
ALTER TABLE "clinical"."trauma_activations" ADD CONSTRAINT "trauma_activations_triage_record_id_fkey" FOREIGN KEY ("triage_record_id") REFERENCES "clinical"."triage_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."activation_pages" ADD CONSTRAINT "activation_pages_activation_id_fkey" FOREIGN KEY ("activation_id") REFERENCES "clinical"."trauma_activations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."survey_interventions" ADD CONSTRAINT "survey_interventions_survey_id_fkey" FOREIGN KEY ("survey_id") REFERENCES "clinical"."primary_surveys"("id") ON DELETE CASCADE ON UPDATE CASCADE;



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
  WHERE n.nspname = 'clinical' AND (c.relname LIKE 'triage\_%' OR c.relname LIKE 'trauma\_%' OR c.relname LIKE 'activation\_%' OR c.relname LIKE 'primary\_surve%' OR c.relname LIKE 'survey\_%' OR c.relname LIKE 'mci\_%')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'TR-001 tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE CONSTRAINTS
-- ═════════════════════════════════════════════════════════════════════════════

-- ── B.1  RE-TRIAGE NEVER OVERWRITES ─────────────────────────────────────────
--
-- A patient triaged ESI-4 who deteriorates to ESI-2 gets a second record. The
-- first one is why they waited, and it is the only evidence of whether that wait
-- was reasonable. Editing the level, the observations or the time it was taken
-- destroys that; correcting a typo in the complaint does not.
CREATE OR REPLACE FUNCTION "clinical".refuse_triage_overwrite()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'A triage record is never deleted (TR-001 §B.1). It is the evidence of why the patient waited as long as they did.'
      USING ERRCODE = 'TR001';
  END IF;

  IF NEW.esi_level      IS DISTINCT FROM OLD.esi_level
     OR NEW.tag         IS DISTINCT FROM OLD.tag
     OR NEW.gcs_total   IS DISTINCT FROM OLD.gcs_total
     OR NEW.heart_rate  IS DISTINCT FROM OLD.heart_rate
     OR NEW.respiratory_rate IS DISTINCT FROM OLD.respiratory_rate
     OR NEW.systolic_bp IS DISTINCT FROM OLD.systolic_bp
     OR NEW.spo2        IS DISTINCT FROM OLD.spo2
     OR NEW.triaged_at  IS DISTINCT FROM OLD.triaged_at
     OR NEW.sequence_no IS DISTINCT FROM OLD.sequence_no
  THEN
    RAISE EXCEPTION
      'A triage cannot be rewritten (TR-001 §B.1). Record a re-triage instead — the earlier level is why the patient waited, and both belong in the record.'
      USING ERRCODE = 'TR001';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "triage_records_are_append_only"
  BEFORE UPDATE OR DELETE ON "clinical"."triage_records"
  FOR EACH ROW EXECUTE FUNCTION "clinical".refuse_triage_overwrite();


-- ── B.2  an override says why, and an ESI record has a level ────────────────
--
-- The nurse may always disagree with the algorithm — that is the design. What
-- they may not do is disagree silently, because the override rate against the
-- suggestion is how a hospital finds out its rule set is wrong.
ALTER TABLE "clinical"."triage_records"
  ADD CONSTRAINT "triage_override_says_why"
  CHECK (NOT overridden OR "override_reason" IS NOT NULL);

ALTER TABLE "clinical"."triage_records"
  ADD CONSTRAINT "triage_esi_in_range"
  CHECK ("esi_level" IS NULL OR ("esi_level" >= 1 AND "esi_level" <= 5));

ALTER TABLE "clinical"."triage_records"
  ADD CONSTRAINT "triage_suggested_in_range"
  CHECK ("suggested_level" IS NULL OR ("suggested_level" >= 1 AND "suggested_level" <= 5));

-- An ESI triage has a level; a START triage has a tag. Neither has both, and a
-- record with neither is not a triage.
ALTER TABLE "clinical"."triage_records"
  ADD CONSTRAINT "triage_has_a_category"
  CHECK ((system = 'esi' AND "esi_level" IS NOT NULL AND tag IS NULL)
      OR (system IN ('start', 'jump_start') AND tag IS NOT NULL AND "esi_level" IS NULL));

ALTER TABLE "clinical"."triage_records"
  ADD CONSTRAINT "triage_gcs_components_in_range"
  CHECK (("gcs_eye" IS NULL OR ("gcs_eye" BETWEEN 1 AND 4))
     AND ("gcs_verbal" IS NULL OR ("gcs_verbal" BETWEEN 1 AND 5))
     AND ("gcs_motor" IS NULL OR ("gcs_motor" BETWEEN 1 AND 6))
     AND ("gcs_total" IS NULL OR ("gcs_total" BETWEEN 2 AND 15)));

-- An intubated patient has no verbal score. Recording one is how a GCS gets
-- quietly inflated past the level-1 activation threshold.
ALTER TABLE "clinical"."triage_records"
  ADD CONSTRAINT "triage_intubated_has_no_verbal"
  CHECK (NOT "gcs_intubated" OR "gcs_verbal" IS NULL);

ALTER TABLE "clinical"."triage_records"
  ADD CONSTRAINT "triage_sequence_starts_at_one"
  CHECK ("sequence_no" >= 1);


-- ── B.3  A LEVEL 1 PAGE CANNOT BE SILENCED ──────────────────────────────────
--
-- §6.3, in as many words. The failure this prevents is a night shift muting the
-- trauma pager after two stand-downs and not hearing the third page. It is a
-- CHECK rather than a service rule because the service is what a configuration
-- screen would be talking to.
CREATE OR REPLACE FUNCTION "clinical".refuse_silencing_level_one()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_tier text;
BEGIN
  IF NOT NEW.suppressed THEN RETURN NEW; END IF;

  SELECT a.tier::text INTO v_tier
    FROM clinical.trauma_activations a WHERE a.id = NEW.activation_id;

  IF v_tier = 'level_1' THEN
    RAISE EXCEPTION
      'A Level 1 trauma activation page cannot be silenced (TR-001 §6.3). No configuration reaches this.'
      USING ERRCODE = 'TR001';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "activation_pages_level_one_is_never_silent"
  BEFORE INSERT OR UPDATE ON "clinical"."activation_pages"
  FOR EACH ROW EXECUTE FUNCTION "clinical".refuse_silencing_level_one();

-- The page's own clock runs forward: sent, then acknowledged, then arrived.
ALTER TABLE "clinical"."activation_pages"
  ADD CONSTRAINT "activation_page_times_ordered"
  CHECK (("acknowledged_at" IS NULL OR "sent_at" IS NULL OR "acknowledged_at" >= "sent_at")
     AND ("arrived_at" IS NULL OR "acknowledged_at" IS NULL OR "arrived_at" >= "acknowledged_at"));

ALTER TABLE "clinical"."activation_pages"
  ADD CONSTRAINT "activation_page_failure_says_why"
  CHECK (status <> 'failed' OR "failure_reason" IS NOT NULL);


-- ── B.4  a stand-down has a name and a reason ───────────────────────────────
--
-- Standing a trauma team down is a clinical decision with a person behind it.
-- An activation that quietly became inactive is one nobody can review.
ALTER TABLE "clinical"."trauma_activations"
  ADD CONSTRAINT "activation_stand_down_is_owned"
  CHECK (status <> 'stood_down'
         OR ("stood_down_at" IS NOT NULL AND "stood_down_by" IS NOT NULL
             AND "stand_down_reason" IS NOT NULL));

-- An activation fires from a criterion or from a clinician's judgement. Never
-- from nothing — that is an activation nobody can explain at the M&M meeting.
ALTER TABLE "clinical"."trauma_activations"
  ADD CONSTRAINT "activation_has_a_basis"
  CHECK (cardinality("criteria_fired") > 0 OR "clinical_judgement");

ALTER TABLE "clinical"."trauma_activations"
  ADD CONSTRAINT "activation_final_iss_in_range"
  CHECK ("final_iss" IS NULL OR ("final_iss" >= 1 AND "final_iss" <= 75));


-- ── B.5  A LOCKED SCORE IS IMMUTABLE ────────────────────────────────────────
--
-- ISS and TRISS go into a trauma registry and into mortality review. An
-- amendment is a new version carrying `supersedes_id` and a reason, so the
-- question "was the score changed after the patient died" has an answer either
-- way.
CREATE OR REPLACE FUNCTION "clinical".refuse_locked_score_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A trauma score is never deleted (TR-001 §B.5).' USING ERRCODE = 'TR001';
  END IF;

  IF OLD.status <> 'locked' THEN RETURN NEW; END IF;

  -- The one legal move out of `locked`: being superseded by an amendment.
  IF NEW.status = 'amended'
     AND NEW.rts IS NOT DISTINCT FROM OLD.rts
     AND NEW.iss IS NOT DISTINCT FROM OLD.iss
     AND NEW.niss IS NOT DISTINCT FROM OLD.niss
     AND NEW.triss IS NOT DISTINCT FROM OLD.triss
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'This trauma score is locked (TR-001 §B.5). Record an amendment as a new version with a reason — a score edited after the fact is one a mortality review cannot rely on.'
    USING ERRCODE = 'TR001';
END $$;

CREATE TRIGGER "trauma_scores_immutable_once_locked"
  BEFORE UPDATE OR DELETE ON "clinical"."trauma_scores"
  FOR EACH ROW EXECUTE FUNCTION "clinical".refuse_locked_score_edit();

ALTER TABLE "clinical"."trauma_scores"
  ADD CONSTRAINT "trauma_score_locked_is_signed"
  CHECK (status <> 'locked' OR ("locked_at" IS NOT NULL AND "locked_by" IS NOT NULL));

ALTER TABLE "clinical"."trauma_scores"
  ADD CONSTRAINT "trauma_score_amendment_says_why"
  CHECK ("supersedes_id" IS NULL OR "amend_reason" IS NOT NULL);

ALTER TABLE "clinical"."trauma_scores"
  ADD CONSTRAINT "trauma_score_ranges"
  CHECK (("iss" IS NULL OR ("iss" BETWEEN 1 AND 75))
     AND ("niss" IS NULL OR ("niss" BETWEEN 1 AND 75))
     AND ("rts" IS NULL OR ("rts" BETWEEN 0 AND 7.8408))
     AND ("triss" IS NULL OR ("triss" BETWEEN 0 AND 1))
     AND ("arrival_gcs" IS NULL OR ("arrival_gcs" BETWEEN 3 AND 15)));

-- NISS counts the three worst injuries anywhere; ISS only the worst per region.
-- NISS below ISS is arithmetically impossible and means one of them is wrong.
ALTER TABLE "clinical"."trauma_scores"
  ADD CONSTRAINT "trauma_score_niss_at_least_iss"
  CHECK ("niss" IS NULL OR "iss" IS NULL OR "niss" >= "iss");

ALTER TABLE "clinical"."trauma_scores"
  ADD CONSTRAINT "trauma_score_version_starts_at_one"
  CHECK ("version_no" >= 1);


-- ── B.6  injuries and interventions ─────────────────────────────────────────
ALTER TABLE "clinical"."trauma_injuries"
  ADD CONSTRAINT "trauma_injury_ais_in_range"
  CHECK ("ais_severity" BETWEEN 1 AND 6);

ALTER TABLE "clinical"."trauma_injuries"
  ADD CONSTRAINT "trauma_injury_region_is_known"
  CHECK (region IN ('head_neck', 'face', 'chest', 'abdomen', 'extremity', 'external'));

-- The intervention log is what the golden-hour timers are computed from.
CREATE OR REPLACE FUNCTION "clinical".refuse_intervention_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'survey_interventions is append-only (TR-001 §B.6). The golden-hour timers are computed from it, and a timeline that can be rewritten is not a timeline.'
    USING ERRCODE = 'TR001';
END $$;

CREATE TRIGGER "survey_interventions_append_only"
  BEFORE UPDATE OR DELETE ON "clinical"."survey_interventions"
  FOR EACH ROW EXECUTE FUNCTION "clinical".refuse_intervention_edit();

-- A tourniquet comes off after it goes on, and the survey clock runs forward.
ALTER TABLE "clinical"."primary_surveys"
  ADD CONSTRAINT "survey_tourniquet_times_ordered"
  CHECK ("tourniquet_off_at" IS NULL
         OR ("tourniquet_on_at" IS NOT NULL AND "tourniquet_off_at" >= "tourniquet_on_at"));

ALTER TABLE "clinical"."primary_surveys"
  ADD CONSTRAINT "survey_injury_before_door"
  CHECK ("injury_at" IS NULL OR "injury_at" <= "door_at");

ALTER TABLE "clinical"."primary_surveys"
  ADD CONSTRAINT "survey_volumes_non_negative"
  CHECK ("crystalloid_ml" >= 0 AND "blood_units" >= 0 AND "iv_access_count" >= 0);


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
  RAISE NOTICE 'Granted application DML on % TR-001 table(s)', v_count;
END $$;

REVOKE UPDATE, DELETE ON "clinical"."survey_interventions" FROM hms_app;
REVOKE DELETE          ON "clinical"."triage_records"      FROM hms_app;
REVOKE DELETE          ON "clinical"."trauma_scores"       FROM hms_app;
REVOKE DELETE          ON "clinical"."trauma_activations"  FROM hms_app;

COMMENT ON TABLE "clinical"."triage_records" IS
  'Append-only in the fields that matter. A patient triaged ESI-4 who deteriorates to ESI-2 has two records; the first is the only evidence of whether the wait that followed was reasonable.';

COMMENT ON COLUMN "clinical"."activation_pages"."suppressed" IS
  'Never true for a level-1 activation — a trigger refuses it. The failure this prevents is a night shift muting the trauma pager after two stand-downs and not hearing the third page.';

COMMENT ON TABLE "clinical"."trauma_scores" IS
  'Versioned and immutable once locked. ISS and TRISS go into a registry and into mortality review, so "was the score changed after the death" has to be answerable either way.';
