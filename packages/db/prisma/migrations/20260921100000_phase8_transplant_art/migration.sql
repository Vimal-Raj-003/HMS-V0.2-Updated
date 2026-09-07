-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 8 · IP-019 · OP-024 — transplant, and assisted reproduction
-- Two statutes about who may consent to a body, and what may not be bought
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── The rules ───────────────────────────────────────────────────────────────
--
-- 1. **A living donor is a near relative, or the Authorisation Committee has
--    said yes.** India's transplant law exists because of a trade: through the
--    1980s Indian kidneys were sold to overseas recipients on a scale that made
--    the country a destination, and the sellers were poor, uninformed, and
--    afterwards sicker and no less poor. The Act's answer is narrow — donate to
--    somebody on a listed set of relationships, or convince a committee there
--    is affection and no money. So `near_relative` here is an enum whose members
--    are the statute's list, and a donor outside it cannot reach a theatre
--    without a committee reference. There is no permission that substitutes.
--
-- 2. **Brain-stem death is four doctors, twice, six hours apart, and none of
--    them on the transplant team.** The alternative is a transplant team
--    certifying its own donor, which is why the Act names the panel rather than
--    describing it.
--
-- 3. **A gamete donor donates once in a lifetime.** §21(g) of the ART Act,
--    written because donors were used dozens of times — a consanguinity problem
--    a generation later, and an exploitation problem now. The count is the
--    database's, kept against the bank's own reference rather than the clinic's.
--
-- 4. **A cycle needs a registered clinic and both consents**, and there is no
--    field anywhere for a payment to a donor, because the Act permits none.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: IP019.
-- ═════════════════════════════════════════════════════════════════════════════


-- CreateEnum
CREATE TYPE "specialty"."NearRelative" AS ENUM ('spouse', 'son', 'daughter', 'father', 'mother', 'brother', 'sister', 'grandfather', 'grandmother', 'grandson', 'granddaughter');

-- CreateEnum
CREATE TYPE "specialty"."DonorType" AS ENUM ('living_near_relative', 'living_other', 'deceased_brainstem', 'deceased_cardiac');

-- CreateEnum
CREATE TYPE "specialty"."TransplantStatus" AS ENUM ('registered', 'workup', 'committee_pending', 'approved', 'scheduled', 'transplanted', 'declined', 'withdrawn');

-- CreateTable
CREATE TABLE "specialty"."transplant_recipients" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "organ" VARCHAR(24) NOT NULL,
    "indication" TEXT NOT NULL,
    "blood_group" VARCHAR(8) NOT NULL,
    "hla_typing" JSONB NOT NULL DEFAULT '{}',
    "notto_id" VARCHAR(40),
    "listed_at" DATE NOT NULL,
    "urgency" VARCHAR(16) NOT NULL DEFAULT 'routine',
    "status" "specialty"."TransplantStatus" NOT NULL DEFAULT 'registered',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "transplant_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."organ_donations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "donor_patient_id" UUID,
    "organ" VARCHAR(24) NOT NULL,
    "donor_type" "specialty"."DonorType" NOT NULL,
    "relationship" "specialty"."NearRelative",
    "relationship_evidence" JSONB NOT NULL DEFAULT '{}',
    "committee_ref" VARCHAR(80),
    "committee_decided_at" TIMESTAMPTZ(6),
    "donor_consent_id" UUID,
    "recipient_consent_id" UUID,
    "brainstem_death_id" UUID,
    "crossmatch" JSONB NOT NULL DEFAULT '{}',
    "status" "specialty"."TransplantStatus" NOT NULL DEFAULT 'registered',
    "performed_at" TIMESTAMPTZ(6),
    "ot_case_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "organ_donations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."brainstem_death_certifications" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "admission_id" UUID,
    "first_exam_at" TIMESTAMPTZ(6) NOT NULL,
    "first_exam" JSONB NOT NULL,
    "second_exam_at" TIMESTAMPTZ(6),
    "second_exam" JSONB,
    "interval_min" INTEGER,
    "rmp_in_charge_id" UUID NOT NULL,
    "authority_nominee_id" UUID NOT NULL,
    "neurologist_id" UUID NOT NULL,
    "treating_doctor_id" UUID NOT NULL,
    "transplant_team_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "certified_at" TIMESTAMPTZ(6),
    "form10_ref" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "brainstem_death_certifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."art_gamete_donors" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "bank_registration_no" VARCHAR(60) NOT NULL,
    "bank_donor_ref" VARCHAR(60) NOT NULL,
    "gamete" VARCHAR(16) NOT NULL,
    "age_years" INTEGER NOT NULL,
    "screening" JSONB NOT NULL DEFAULT '{}',
    "donation_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "art_gamete_donors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "specialty"."art_cycles" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "partner_patient_id" UUID,
    "clinic_registration_no" VARCHAR(60) NOT NULL,
    "cycle_no" INTEGER NOT NULL,
    "started_at" DATE NOT NULL,
    "technique" VARCHAR(24) NOT NULL,
    "donor_id" UUID,
    "patient_consent_id" UUID,
    "partner_consent_id" UUID,
    "stimulation" JSONB NOT NULL DEFAULT '{}',
    "laboratory" JSONB NOT NULL DEFAULT '{}',
    "embryos_transferred" INTEGER,
    "transferred_at" TIMESTAMPTZ(6),
    "outcome" VARCHAR(40),
    "outcome_at" TIMESTAMPTZ(6),
    "registry_ref" VARCHAR(80),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "art_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "transplant_recipients_hospital_id_organ_status_idx" ON "specialty"."transplant_recipients"("hospital_id", "organ", "status");

-- CreateIndex
CREATE INDEX "transplant_recipients_hospital_id_patient_id_idx" ON "specialty"."transplant_recipients"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "organ_donations_hospital_id_status_idx" ON "specialty"."organ_donations"("hospital_id", "status");

-- CreateIndex
CREATE INDEX "organ_donations_hospital_id_recipient_id_idx" ON "specialty"."organ_donations"("hospital_id", "recipient_id");

-- CreateIndex
CREATE INDEX "brainstem_death_certifications_hospital_id_certified_at_idx" ON "specialty"."brainstem_death_certifications"("hospital_id", "certified_at" DESC);

-- CreateIndex
CREATE INDEX "art_gamete_donors_hospital_id_gamete_idx" ON "specialty"."art_gamete_donors"("hospital_id", "gamete");

-- CreateIndex
CREATE UNIQUE INDEX "uq_gamete_donor_ref" ON "specialty"."art_gamete_donors"("bank_registration_no", "bank_donor_ref");

-- CreateIndex
CREATE INDEX "art_cycles_hospital_id_started_at_idx" ON "specialty"."art_cycles"("hospital_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_art_cycle_no" ON "specialty"."art_cycles"("patient_id", "cycle_no");

-- AddForeignKey
ALTER TABLE "specialty"."organ_donations" ADD CONSTRAINT "organ_donations_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "specialty"."transplant_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "specialty"."art_cycles" ADD CONSTRAINT "art_cycles_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "specialty"."art_gamete_donors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  A near relative, or a committee ───────────────────────────────────
--
-- The whole Act, in one trigger. A living donor who is not on the statute's
-- list needs the Authorisation Committee to have satisfied itself that there is
-- affection or attachment and no money — and that is the only route.
CREATE OR REPLACE FUNCTION specialty.a_donation_has_its_authority()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.donor_type = 'living_near_relative' THEN
    IF NEW.relationship IS NULL THEN
      RAISE EXCEPTION 'A near-relative donation names the relationship, and it has to be one the Act lists: spouse, son, daughter, father, mother, brother, sister, grandparent or grandchild. (IP-019 §B.1)'
        USING ERRCODE = 'IP019';
    END IF;
    IF NOT (jsonb_typeof(NEW.relationship_evidence) = 'object'
            AND NEW.relationship_evidence <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'Record how the relationship was established — a document, a photograph, a genetic test. The Authorisation Committee asks, and so does a court. (IP-019 §B.1)'
        USING ERRCODE = 'IP019';
    END IF;

  ELSIF NEW.donor_type = 'living_other' THEN
    IF NEW.relationship IS NOT NULL THEN
      RAISE EXCEPTION 'A donor who is a near relative is recorded as one. The two routes are different and the Act treats them differently. (IP-019 §B.1)'
        USING ERRCODE = 'IP019';
    END IF;
    IF NEW.committee_ref IS NULL OR length(btrim(NEW.committee_ref)) < 3 THEN
      RAISE EXCEPTION
        'This donor is not a near relative under the Act, so the donation needs the Authorisation Committee''s approval and its reference. There is no other route. The Committee exists because organs were bought from people who were poor, and it is the only thing standing between this record and that. (IP-019 §B.1)'
        USING ERRCODE = 'IP019';
    END IF;
    IF NEW.committee_decided_at IS NULL THEN
      RAISE EXCEPTION 'Record when the Authorisation Committee decided. (IP-019 §B.1)'
        USING ERRCODE = 'IP019';
    END IF;

  ELSE
    -- Deceased. The authority is the certification, not a relationship.
    IF NEW.relationship IS NOT NULL THEN
      RAISE EXCEPTION 'A deceased donation has no living relationship to record. (IP-019 §B.1)'
        USING ERRCODE = 'IP019';
    END IF;
    IF NEW.donor_type = 'deceased_brainstem' AND NEW.brainstem_death_id IS NULL THEN
      RAISE EXCEPTION 'A brain-stem death donation names the certification it rests on. (IP-019 §B.1)'
        USING ERRCODE = 'IP019';
    END IF;
  END IF;

  -- Nothing is retrieved without both consents.
  IF NEW.performed_at IS NOT NULL THEN
    IF NEW.recipient_consent_id IS NULL THEN
      RAISE EXCEPTION 'The recipient''s consent is not recorded. (IP-019 §B.1)' USING ERRCODE = 'IP019';
    END IF;
    IF NEW.donor_type IN ('living_near_relative', 'living_other')
       AND NEW.donor_consent_id IS NULL THEN
      RAISE EXCEPTION 'The living donor''s own consent is not recorded. (IP-019 §B.1)'
        USING ERRCODE = 'IP019';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_donation_has_its_authority
  BEFORE INSERT OR UPDATE ON specialty.organ_donations
  FOR EACH ROW EXECUTE FUNCTION specialty.a_donation_has_its_authority();

-- There is no field for a payment, and this keeps it that way.
DO $$
DECLARE v_found text;
BEGIN
  SELECT string_agg(format('%s.%s', table_name, column_name), ', ') INTO v_found
    FROM information_schema.columns
   WHERE table_schema = 'specialty'
     AND table_name IN ('organ_donations', 'transplant_recipients', 'art_gamete_donors')
     AND (column_name ~* '(payment|fee|amount|compensat|consideration|price)');
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION
      'THOTA and the ART Act both prohibit consideration for an organ or a gamete. A column for one would be the trade the statutes exist to stop, with a schema: %', v_found;
  END IF;
END $$;


-- ── §B.2  Four doctors, twice, six hours apart ──────────────────────────────
CREATE OR REPLACE FUNCTION specialty.brainstem_interval_hours() RETURNS int
  LANGUAGE sql IMMUTABLE AS $$ SELECT 6 $$;

CREATE OR REPLACE FUNCTION specialty.brainstem_death_is_lawfully_certified()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_panel uuid[];
  v_overlap uuid[];
BEGIN
  v_panel := ARRAY[NEW.rmp_in_charge_id, NEW.authority_nominee_id,
                   NEW.neurologist_id, NEW.treating_doctor_id];

  -- Four doctors means four people.
  IF (SELECT count(DISTINCT x) FROM unnest(v_panel) AS x) < 4 THEN
    RAISE EXCEPTION 'The Act names four certifiers, and four means four different people: the practitioner in charge of the hospital, the Appropriate Authority''s nominee, a neurologist or neurosurgeon, and the treating doctor. (IP-019 §B.2)'
      USING ERRCODE = 'IP019';
  END IF;

  -- And none of them on the transplant team, because the alternative is a
  -- transplant team certifying its own donor.
  SELECT array_agg(x) INTO v_overlap
    FROM unnest(v_panel) AS x
   WHERE x = ANY (NEW.transplant_team_ids);
  IF v_overlap IS NOT NULL THEN
    RAISE EXCEPTION 'A certifier is on the transplant team. The panel exists precisely so that the team taking the organ is not the panel declaring the donor dead. (IP-019 §B.2)'
      USING ERRCODE = 'IP019';
  END IF;

  IF NEW.second_exam_at IS NOT NULL THEN
    NEW.interval_min := (extract(epoch FROM (NEW.second_exam_at - NEW.first_exam_at)) / 60)::int;
    IF NEW.interval_min < specialty.brainstem_interval_hours() * 60 THEN
      RAISE EXCEPTION 'The two examinations are % minutes apart, and the Act requires %. The interval is the test: a single examination cannot distinguish brain-stem death from a reversible state. (IP-019 §B.2)',
        NEW.interval_min, specialty.brainstem_interval_hours() * 60
        USING ERRCODE = 'IP019';
    END IF;
  ELSE
    NEW.interval_min := NULL;
  END IF;

  IF NEW.certified_at IS NOT NULL THEN
    IF NEW.second_exam_at IS NULL OR NEW.second_exam IS NULL THEN
      RAISE EXCEPTION 'Certification needs both examinations. (IP-019 §B.2)' USING ERRCODE = 'IP019';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_brainstem_death_is_lawfully_certified
  BEFORE INSERT OR UPDATE ON specialty.brainstem_death_certifications
  FOR EACH ROW EXECUTE FUNCTION specialty.brainstem_death_is_lawfully_certified();


-- ── §B.3  One donation in a lifetime ────────────────────────────────────────
--
-- §21(g) of the ART Act, written because donors were used dozens of times — a
-- consanguinity problem a generation later, and an exploitation problem now.
CREATE OR REPLACE FUNCTION specialty.a_donor_donates_once()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_donor record;
BEGIN
  IF NEW.donor_id IS NULL THEN RETURN NEW; END IF;

  SELECT d.donation_count, d.bank_donor_ref, d.gamete INTO v_donor
    FROM specialty.art_gamete_donors d WHERE d.id = NEW.donor_id;

  -- Only a new cycle counts. Editing an existing one does not donate again.
  IF TG_OP = 'UPDATE' AND OLD.donor_id IS NOT DISTINCT FROM NEW.donor_id THEN
    RETURN NEW;
  END IF;

  IF v_donor.donation_count >= 1 THEN
    RAISE EXCEPTION
      'Donor % has already donated. The Act allows one donation in a lifetime, because donors were being used dozens of times — which is an exploitation problem now and a consanguinity problem in twenty years. (IP-019 §B.3)',
      v_donor.bank_donor_ref
      USING ERRCODE = 'IP019';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_a_donor_donates_once
  BEFORE INSERT OR UPDATE OF donor_id ON specialty.art_cycles
  FOR EACH ROW EXECUTE FUNCTION specialty.a_donor_donates_once();

-- The count is the database's, moved when a cycle actually uses the gametes.
-- SECURITY DEFINER, and it is the same decision as the REVOKE in §C: `hms_app`
-- holds no write on the donation count, because a count it could edit is a
-- lifetime limit it could walk round. The arithmetic still has to happen, so it
-- happens with the database's own authority.
CREATE OR REPLACE FUNCTION specialty.count_the_donation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = specialty, pg_temp AS $$
BEGIN
  IF NEW.donor_id IS NULL THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND OLD.donor_id IS NOT DISTINCT FROM NEW.donor_id THEN RETURN NULL; END IF;

  UPDATE specialty.art_gamete_donors
     SET donation_count = donation_count + 1, updated_at = now()
   WHERE id = NEW.donor_id;

  RETURN NULL;
END $$;

CREATE TRIGGER trg_count_the_donation
  AFTER INSERT OR UPDATE OF donor_id ON specialty.art_cycles
  FOR EACH ROW EXECUTE FUNCTION specialty.count_the_donation();


-- ── §B.4  A registered clinic, and both consents ────────────────────────────
CREATE OR REPLACE FUNCTION specialty.an_art_cycle_is_lawful()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF length(btrim(NEW.clinic_registration_no)) < 3 THEN
    RAISE EXCEPTION 'A cycle at a clinic with no registration under the ART Act is an offence by the clinic. (IP-019 §B.4)'
      USING ERRCODE = 'IP019';
  END IF;

  IF NEW.transferred_at IS NOT NULL THEN
    IF NEW.patient_consent_id IS NULL THEN
      RAISE EXCEPTION 'The commissioning woman''s consent is not recorded. (IP-019 §B.4)'
        USING ERRCODE = 'IP019';
    END IF;
    -- Where there are two commissioning parties, the Act needs both.
    IF NEW.partner_patient_id IS NOT NULL AND NEW.partner_consent_id IS NULL THEN
      RAISE EXCEPTION 'Where there is a commissioning couple the Act requires both consents, and the partner''s is not recorded. (IP-019 §B.4)'
        USING ERRCODE = 'IP019';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER trg_an_art_cycle_is_lawful
  BEFORE INSERT OR UPDATE ON specialty.art_cycles
  FOR EACH ROW EXECUTE FUNCTION specialty.an_art_cycle_is_lawful();

-- A triplet pregnancy is the commonest serious harm of this treatment and it is
-- entirely iatrogenic.
ALTER TABLE "specialty"."art_cycles"
  ADD CONSTRAINT "embryos_transferred_is_within_practice"
  CHECK ("embryos_transferred" IS NULL OR "embryos_transferred" BETWEEN 1 AND 3);

ALTER TABLE "specialty"."art_gamete_donors"
  ADD CONSTRAINT "a_gamete_donor_is_of_age"
  CHECK ("age_years" BETWEEN 18 AND 55);

ALTER TABLE "specialty"."art_gamete_donors"
  ADD CONSTRAINT "a_gamete_is_one_of_two" CHECK ("gamete" IN ('oocyte', 'semen'));

ALTER TABLE "specialty"."transplant_recipients"
  ADD CONSTRAINT "an_urgency_is_known"
  CHECK ("urgency" IN ('routine', 'urgent', 'super_urgent'));


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
      AND c.relname IN ('transplant_recipients','organ_donations',
                        'brainstem_death_certifications','art_gamete_donors','art_cycles')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % transplant and ART table(s)', v_count;
END $$;

-- Both of these are inspected registers. Nothing is deleted from either.
REVOKE DELETE ON "specialty"."organ_donations"                 FROM hms_app;
REVOKE DELETE ON "specialty"."brainstem_death_certifications"  FROM hms_app;
REVOKE DELETE ON "specialty"."art_cycles"                      FROM hms_app;

-- The lifetime donation count is the database's arithmetic, and a count the
-- application could edit is a limit it could walk round.
REVOKE UPDATE ON "specialty"."art_gamete_donors" FROM hms_app;
GRANT UPDATE (screening, updated_at) ON "specialty"."art_gamete_donors" TO hms_app;


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
                            'immunisation_schedules','anticholinergic_scores','beers_criteria')
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
    AND c.relname IN ('transplant_recipients','organ_donations',
                      'brainstem_death_certifications','art_gamete_donors','art_cycles')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Transplant and ART tables without RLS or a tenant policy: %', v_missing;
  END IF;
END $$;




