-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · OP-018 · OP-021 · IP-020 — the hand-offs
-- Three modules, one failure: the hand-off happens and nobody watches for the reply
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **A drug scheduled under the NDPS Act cannot be prescribed by
--    telemedicine, in any mode, ever.** India's Telemedicine Practice
--    Guidelines came into force in a week in March 2020 because the alternative
--    was a country with no lawful way to consult a doctor, and they are annexed
--    to the Medical Council regulations — binding on registration rather than
--    advisory. Their prohibited list is the one absolute in them.
--
-- 2. **A List A drug on a first consultation needs video.** The list is small
--    and the reason is specific: a doctor may start these having *seen* the
--    patient, and a phone call is not seeing them.
--
-- 3. **A List B drug needs a follow-up.** It is an add-on to a medicine already
--    running, and a first contact by definition has nothing to add on to.
--
-- 4. **Every tele-prescription carries a verified patient and a registration
--    number.** A tele-consultation with an unverified patient is a prescription
--    to somebody unknown.
--
-- 5. **A referral is open until somebody replies**, and the date a reply is due
--    is derived from the urgency. The commonest failure in a referral system is
--    not a lost letter: it is a referral acknowledged and never replied to,
--    with the referrer reading silence as "handled". Phase 2 already built
--    `clinical.referrals`, so this adds the clock rather than a second table.
--
-- 6. **A pathway variance carries a reason and a category.** A pathway that is
--    followed tells you nothing; the variances are the data, and which of the
--    four categories they fall into is the point — three of them are the
--    hospital's problem and one is not.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: OP018.
-- ═════════════════════════════════════════════════════════════════════════════


-- CreateEnum
CREATE TYPE "mdm"."TelemedicineDrugList" AS ENUM ('list_o', 'list_a', 'list_b', 'prohibited');

-- CreateEnum
CREATE TYPE "specialty"."ConsultMode" AS ENUM ('video', 'audio', 'text');

-- AlterTable
ALTER TABLE "clinical"."referrals" ADD COLUMN     "acknowledged_at" TIMESTAMPTZ(6),
ADD COLUMN     "reply_due_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "mdm"."telemedicine_drug_rules" (
    "id" UUID NOT NULL,
    "drug_key" VARCHAR(80) NOT NULL,
    "drug_name" VARCHAR(160) NOT NULL,
    "list_code" "mdm"."TelemedicineDrugList" NOT NULL,
    "note" TEXT,
    "source" VARCHAR(40) NOT NULL DEFAULT 'TPG-2020',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "telemedicine_drug_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."tele_consults" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "practitioner_id" UUID NOT NULL,
    "practitioner_reg_no" VARCHAR(60) NOT NULL,
    "mode" "specialty"."ConsultMode" NOT NULL,
    "first_consult" BOOLEAN NOT NULL DEFAULT true,
    "follows_consult_id" UUID,
    "initiated_by" VARCHAR(16) NOT NULL DEFAULT 'patient',
    "consent_id" UUID,
    "identity_verification" JSONB NOT NULL DEFAULT '{}',
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "complaint" TEXT,
    "advice" TEXT,
    "referred_in_person" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tele_consults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."tele_prescription_lines" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "consult_id" UUID NOT NULL,
    "drug_key" VARCHAR(80) NOT NULL,
    "drug_name" VARCHAR(160) NOT NULL,
    "dose" VARCHAR(80) NOT NULL,
    "frequency" VARCHAR(40) NOT NULL,
    "duration_days" INTEGER NOT NULL,
    "list_code" "mdm"."TelemedicineDrugList",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tele_prescription_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pathway_instances" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "admission_id" UUID,
    "pathway_key" VARCHAR(60) NOT NULL,
    "pathway_name" VARCHAR(160) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "steps" JSONB NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "adherence_pct" DECIMAL(5,2),
    "variance_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pathway_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."pathway_step_records" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "instance_id" UUID NOT NULL,
    "step_key" VARCHAR(60) NOT NULL,
    "day_no" INTEGER NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "done_at" TIMESTAMPTZ(6),
    "variance_reason" TEXT,
    "variance_category" VARCHAR(16),
    "recorded_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pathway_step_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_tele_drug_rule" ON "mdm"."telemedicine_drug_rules"("drug_key");

-- CreateIndex
CREATE INDEX "tele_consults_hospital_id_patient_id_started_at_idx" ON "specialty"."tele_consults"("hospital_id", "patient_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "tele_consults_hospital_id_practitioner_id_started_at_idx" ON "specialty"."tele_consults"("hospital_id", "practitioner_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "tele_prescription_lines_hospital_id_consult_id_idx" ON "specialty"."tele_prescription_lines"("hospital_id", "consult_id");

-- CreateIndex
CREATE INDEX "pathway_instances_hospital_id_patient_id_started_at_idx" ON "specialty"."pathway_instances"("hospital_id", "patient_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "pathway_step_records_hospital_id_instance_id_idx" ON "specialty"."pathway_step_records"("hospital_id", "instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_pathway_step" ON "specialty"."pathway_step_records"("instance_id", "step_key");

-- AddForeignKey
ALTER TABLE "specialty"."tele_prescription_lines" ADD CONSTRAINT "tele_prescription_lines_consult_id_fkey" FOREIGN KEY ("consult_id") REFERENCES "specialty"."tele_consults"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."pathway_step_records" ADD CONSTRAINT "pathway_step_records_instance_id_fkey" FOREIGN KEY ("instance_id") REFERENCES "specialty"."pathway_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  The four lists ────────────────────────────────────────────────────
--
-- The prohibited list is the absolute one: everything scheduled under the NDPS
-- Act, and there is no mode, no consultation type and no permission that
-- reaches it.
CREATE OR REPLACE FUNCTION specialty.a_teleprescription_obeys_the_lists()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_rule    record;
  v_consult record;
BEGIN
  SELECT r.list_code, r.note INTO v_rule
    FROM mdm.telemedicine_drug_rules r WHERE r.drug_key = NEW.drug_key;

  SELECT c.mode, c.first_consult, c.identity_verification, c.practitioner_reg_no
    INTO v_consult
    FROM specialty.tele_consults c WHERE c.id = NEW.consult_id;

  -- Recorded at the moment of prescribing, so a later change to the list does
  -- not rewrite what was lawful then.
  NEW.list_code := v_rule.list_code;

  IF v_rule.list_code IS NULL THEN
    RAISE EXCEPTION
      '% is not on any of the telemedicine drug lists. The Guidelines work by listing what may be prescribed remotely, so a drug that is not on a list cannot be prescribed by telemedicine — see the patient. (OP-018 §B.1)',
      NEW.drug_name
      USING ERRCODE = 'OP018';
  END IF;

  IF v_rule.list_code = 'prohibited' THEN
    RAISE EXCEPTION
      '% is on the prohibited list — scheduled under the Narcotic Drugs and Psychotropic Substances Act — and may not be prescribed by telemedicine in any mode, on any consultation, by anybody. This is the one absolute in the Telemedicine Practice Guidelines and there is no setting that changes it. (OP-018 §B.1)',
      NEW.drug_name
      USING ERRCODE = 'OP018';
  END IF;

  IF v_rule.list_code = 'list_a' AND v_consult.first_consult AND v_consult.mode <> 'video' THEN
    RAISE EXCEPTION
      '% is a List A drug, which a doctor may start on a first consultation only having seen the patient. This consultation is %, and a phone call is not seeing them. Either move to video, or make this a follow-up. (OP-018 §B.1)',
      NEW.drug_name, v_consult.mode
      USING ERRCODE = 'OP018';
  END IF;

  IF v_rule.list_code = 'list_b' AND v_consult.first_consult THEN
    RAISE EXCEPTION
      '% is a List B drug — an add-on to a medicine already running — and this is a first consultation, which by definition has nothing to add on to. (OP-018 §B.1)',
      NEW.drug_name
      USING ERRCODE = 'OP018';
  END IF;

  -- A prescription out of a tele-consultation carries the practitioner's
  -- registration number, and the patient has to have been identified.
  IF length(btrim(coalesce(v_consult.practitioner_reg_no, ''))) < 3 THEN
    RAISE EXCEPTION 'A tele-prescription carries the practitioner''s registration number. (OP-018 §B.1)'
      USING ERRCODE = 'OP018';
  END IF;

  IF NOT (jsonb_typeof(v_consult.identity_verification) = 'object'
          AND v_consult.identity_verification <> '{}'::jsonb) THEN
    RAISE EXCEPTION 'The patient''s identity has not been verified on this consultation. A tele-prescription to an unverified patient is a prescription to somebody unknown. (OP-018 §B.1)'
      USING ERRCODE = 'OP018';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_teleprescription_obeys_the_lists
  BEFORE INSERT OR UPDATE OF drug_key, consult_id, list_code
    ON specialty.tele_prescription_lines
  FOR EACH ROW EXECUTE FUNCTION specialty.a_teleprescription_obeys_the_lists();

-- A follow-up says what it follows.
ALTER TABLE "specialty"."tele_consults"
  ADD CONSTRAINT "a_followup_names_what_it_follows"
  CHECK ("first_consult" = true OR "follows_consult_id" IS NOT NULL);

-- Anything but a patient-initiated consultation needs consent explicitly; a
-- patient who rang the doctor has given it by ringing.
ALTER TABLE "specialty"."tele_consults"
  ADD CONSTRAINT "a_consultation_the_patient_did_not_start_has_consent"
  CHECK ("initiated_by" = 'patient' OR "consent_id" IS NOT NULL);

ALTER TABLE "specialty"."tele_consults"
  ADD CONSTRAINT "an_initiator_is_known"
  CHECK ("initiated_by" IN ('patient', 'practitioner', 'caregiver', 'health_worker'));

ALTER TABLE "specialty"."tele_prescription_lines"
  ADD CONSTRAINT "a_teleprescription_is_time_limited"
  CHECK ("duration_days" BETWEEN 1 AND 90);


-- ── §B.2  A referral is open until somebody replies ─────────────────────────
--
-- Phase 2 built the table; this adds the clock. The date a reply is due comes
-- from the urgency, and the status comes from what has actually arrived rather
-- than from what somebody set.
CREATE OR REPLACE FUNCTION clinical.referral_reply_hours(p_urgency clinical."ReferralUrgency")
RETURNS int LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_urgency
    WHEN 'emergency' THEN 4
    WHEN 'urgent'    THEN 48
    ELSE 14 * 24
  END
$$;

CREATE OR REPLACE FUNCTION clinical.derive_referral_clock()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.reply_due_at := NEW.created_at
    + make_interval(hours => clinical.referral_reply_hours(NEW.urgency));

  -- The status follows what arrived. A referral marked closed with no reply is
  -- the exact combination this module exists to prevent.
  IF NEW.status = 'closed' AND NEW.replied_at IS NULL THEN
    RAISE EXCEPTION 'This referral has had no reply, so it is not closed — it is open and overdue. A referral acknowledged and never replied to is how a suspected cancer waits eleven months for an appointment nobody chased. (OP-018 §B.2)'
      USING ERRCODE = 'OP018';
  END IF;

  IF NEW.replied_at IS NOT NULL
     AND (NEW.reply_text IS NULL OR length(btrim(NEW.reply_text)) < 4) THEN
    RAISE EXCEPTION 'A reply says something. (OP-018 §B.2)' USING ERRCODE = 'OP018';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_derive_referral_clock
  BEFORE INSERT OR UPDATE OF urgency, status, replied_at, reply_text, acknowledged_at, reply_due_at
    ON clinical.referrals
  FOR EACH ROW EXECUTE FUNCTION clinical.derive_referral_clock();


-- ── §B.3  A variance has a reason and a category ────────────────────────────
--
-- A pathway that is followed tells you nothing. The variances are the data, and
-- which of four categories they fall into is the point: clinical, patient,
-- system or resource — three of which are the hospital's problem and one of
-- which is not.
ALTER TABLE "specialty"."pathway_step_records"
  ADD CONSTRAINT "a_step_outcome_is_known"
  CHECK ("outcome" IN ('done', 'varied', 'not_applicable'));

-- `variance_category IN (...)` is NULL when the column is NULL, and a CHECK that
-- evaluates to NULL passes. The category has to be asserted present in its own
-- right or the constraint silently accepts the row it exists to refuse.
ALTER TABLE "specialty"."pathway_step_records"
  ADD CONSTRAINT "a_variance_says_why_and_of_what_kind"
  CHECK ("outcome" <> 'varied'
      OR ("variance_reason" IS NOT NULL AND length(btrim("variance_reason")) >= 4
          AND "variance_category" IS NOT NULL
          AND "variance_category" IN ('clinical', 'patient', 'system', 'resource')));

ALTER TABLE "specialty"."pathway_step_records"
  ADD CONSTRAINT "a_completed_step_says_when"
  CHECK ("outcome" <> 'done' OR "done_at" IS NOT NULL);

-- Adherence and the variance count are the instance's arithmetic, kept from the
-- step records rather than tallied by a service.
CREATE OR REPLACE FUNCTION specialty.roll_up_pathway()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_instance uuid;
  v_total    int;
  v_done     int;
  v_varied   int;
BEGIN
  v_instance := coalesce(NEW.instance_id, OLD.instance_id);

  SELECT count(*) FILTER (WHERE outcome <> 'not_applicable'),
         count(*) FILTER (WHERE outcome = 'done'),
         count(*) FILTER (WHERE outcome = 'varied')
    INTO v_total, v_done, v_varied
    FROM specialty.pathway_step_records WHERE instance_id = v_instance;

  UPDATE specialty.pathway_instances
     SET adherence_pct = CASE WHEN v_total = 0 THEN NULL
                              ELSE round(v_done::numeric / v_total * 100, 2) END,
         variance_count = v_varied,
         updated_at = now()
   WHERE id = v_instance;

  RETURN NULL;
END $$;

CREATE TRIGGER trg_roll_up_pathway
  AFTER INSERT OR UPDATE OR DELETE ON specialty.pathway_step_records
  FOR EACH ROW EXECUTE FUNCTION specialty.roll_up_pathway();


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
            AND c.relname IN ('tele_consults','tele_prescription_lines',
                              'pathway_instances','pathway_step_records'))
        OR (n.nspname = 'mdm' AND c.relname = 'telemedicine_drug_rules'))
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % hand-off table(s)', v_count;
END $$;

-- The drug lists are the Guidelines. A hospital that could move a drug off the
-- prohibited list has repealed the part that matters.
REVOKE INSERT, UPDATE, DELETE ON "mdm"."telemedicine_drug_rules" FROM hms_app;
GRANT SELECT ON "mdm"."telemedicine_drug_rules" TO hms_app, hms_readonly;

-- A prescription that was written was written.
REVOKE DELETE ON "specialty"."tele_prescription_lines" FROM hms_app;
REVOKE DELETE ON "specialty"."tele_consults"           FROM hms_app;


-- ═════════════════════════════════════════════════════════════════════════════
-- §E. REFERENCE DATA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A working subset of the Guidelines' annexures, in the migration for the same
-- reason the Beers criteria and the opioid factors are: published law,
-- identical in every hospital, and read-only to the seed's own role.

INSERT INTO mdm.telemedicine_drug_rules (id, drug_key, drug_name, list_code, note, source, created_at, updated_at)
VALUES
  (gen_random_uuid(), 'paracetamol',    'Paracetamol',    'list_o', 'Over the counter.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'ors',            'Oral rehydration salts', 'list_o', 'Over the counter.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'cetirizine',     'Cetirizine',     'list_o', 'Over the counter.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'ferrous_sulfate','Ferrous sulfate','list_o', 'Over the counter.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'ondansetron',    'Ondansetron',    'list_a', 'May be started on a first consultation, by video.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'azithromycin',   'Azithromycin',   'list_a', 'May be started on a first consultation, by video.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'salbutamol_inh', 'Salbutamol inhaler', 'list_a', 'May be started on a first consultation, by video.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'metformin',      'Metformin',      'list_b', 'Add-on to an existing regimen; needs a follow-up.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'enalapril',      'Enalapril',      'list_b', 'Add-on to an existing regimen; needs a follow-up.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'atorvastatin',   'Atorvastatin',   'list_b', 'Add-on to an existing regimen; needs a follow-up.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'morphine',       'Morphine',       'prohibited', 'Scheduled under the NDPS Act. Not by telemedicine, in any mode.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'fentanyl',       'Fentanyl',       'prohibited', 'Scheduled under the NDPS Act. Not by telemedicine, in any mode.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'alprazolam',     'Alprazolam',     'prohibited', 'Psychotropic under the NDPS Act. Not by telemedicine, in any mode.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'methylphenidate','Methylphenidate','prohibited', 'Psychotropic under the NDPS Act. Not by telemedicine, in any mode.', 'TPG-2020', now(), now()),
  (gen_random_uuid(), 'buprenorphine',  'Buprenorphine',  'prohibited', 'Scheduled under the NDPS Act. Not by telemedicine, in any mode.', 'TPG-2020', now(), now())
ON CONFLICT (drug_key) DO NOTHING;


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
      -- `telemedicine_drug_rules` joins the exemption list for the same reason
      -- the Beers criteria are on it: published law, identical in every
      -- tenant, and with no `hospital_id` the generator below would give it
      -- `USING (false)` — a table the application cannot read, which means a
      -- trigger that finds every drug unlisted and a hospital that cannot
      -- prescribe remotely at all.
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
  WHERE n.nspname = 'specialty'
    AND c.relname IN ('tele_consults','tele_prescription_lines',
                      'pathway_instances','pathway_step_records')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Hand-off tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;
