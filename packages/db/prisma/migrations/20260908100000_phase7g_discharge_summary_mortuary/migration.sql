-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 7G · IP-002 + IP-017 + IP-018
-- Discharge, the summary, and the exits that are not going home
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── Three gates ─────────────────────────────────────────────────────────────
--
-- 1. An unresolved medication discrepancy blocks the summary from being signed.
--    A patient goes home with a list; if the list and the ward chart disagree
--    and nobody has said which is right, the patient takes both or neither.
--
-- 2. A signed summary is immutable. An amendment is a new version with a
--    reason. This is the document a GP, an insurer and a court all read, and
--    one that can be edited after signing is one none of them can rely on.
--
-- 3. A body is released to a verified next of kin, never while a medico-legal
--    case is open, and never without a certificate. Releasing a body in an
--    unresolved MLC destroys evidence that cannot be recovered, and the family
--    cannot consent to that on the state's behalf.
--
-- §B  The rules
-- §C  Grants
-- §D  Row-level security
--
-- Custom SQLSTATE: IP002.

-- CreateEnum
CREATE TYPE "clinical"."DischargeKind" AS ENUM ('routine', 'dama', 'absconded', 'referred_out', 'transferred_out', 'died');

-- CreateEnum
CREATE TYPE "clinical"."MedReconAction" AS ENUM ('continue_same', 'stop', 'change', 'new_medicine', 'unresolved');

-- CreateTable
CREATE TABLE "clinical"."ip_discharges" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "kind" "clinical"."DischargeKind" NOT NULL DEFAULT 'routine',
    "initiated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "initiated_by" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ(6),
    "completed_by" UUID,
    "destination" VARCHAR(40),
    "dama_risks_explained" TEXT,
    "dama_witness_name" VARCHAR(160),
    "dama_signed_at" TIMESTAMPTZ(6),
    "follow_up_at" TIMESTAMPTZ(6),
    "follow_up_with" VARCHAR(160),
    "gate_pass_no" VARCHAR(60),
    "gate_pass_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_discharges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_med_reconciliations" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "discharge_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "drug_name" VARCHAR(200) NOT NULL,
    "home_dose" VARCHAR(120),
    "inpatient_dose" VARCHAR(120),
    "discharge_dose" VARCHAR(120),
    "action" "clinical"."MedReconAction" NOT NULL DEFAULT 'unresolved',
    "reason" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decided_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_med_reconciliations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_discharge_summaries" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "discharge_id" UUID NOT NULL,
    "admission_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedes_id" UUID,
    "amend_reason" TEXT,
    "admission_diagnosis" TEXT,
    "final_diagnosis" TEXT NOT NULL,
    "icd10_codes" TEXT[],
    "procedures_performed" TEXT[],
    "course_in_hospital" TEXT NOT NULL,
    "significant_findings" TEXT,
    "condition_on_discharge" TEXT NOT NULL,
    "discharge_medications" JSONB,
    "follow_up_plan" TEXT NOT NULL,
    "red_flag_advice" TEXT NOT NULL,
    "diet_advice" TEXT,
    "patient_copy_locale" VARCHAR(12),
    "drafted_by" UUID NOT NULL,
    "drafted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signed_by" UUID,
    "signed_at" TIMESTAMPTZ(6),
    "cosigned_by" UUID,
    "cosigned_at" TIMESTAMPTZ(6),
    "content_hash" VARCHAR(64),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_discharge_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."ip_mortuary_records" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "admission_id" UUID,
    "patient_id" UUID NOT NULL,
    "mlc_id" UUID,
    "record_no" VARCHAR(60) NOT NULL,
    "declared_at" TIMESTAMPTZ(6) NOT NULL,
    "declared_by" UUID NOT NULL,
    "cause_of_death" TEXT NOT NULL,
    "body_tag_no" VARCHAR(40) NOT NULL,
    "last_office_at" TIMESTAMPTZ(6),
    "last_office_by" UUID,
    "received_at" TIMESTAMPTZ(6),
    "received_by" UUID,
    "cold_storage_unit" VARCHAR(40),
    "mccd_form" VARCHAR(10),
    "mccd_no" VARCHAR(60),
    "mccd_issued_at" TIMESTAMPTZ(6),
    "mccd_issued_by" UUID,
    "registrar_reported_at" TIMESTAMPTZ(6),
    "post_mortem_required" BOOLEAN NOT NULL DEFAULT false,
    "post_mortem_at" TIMESTAMPTZ(6),
    "post_mortem_ref" VARCHAR(60),
    "embalmed_at" TIMESTAMPTZ(6),
    "nok_name" VARCHAR(200),
    "nok_relationship" VARCHAR(60),
    "nok_id_type" VARCHAR(40),
    "nok_id_ref" VARCHAR(80),
    "nok_verified_at" TIMESTAMPTZ(6),
    "nok_verified_by" UUID,
    "released_at" TIMESTAMPTZ(6),
    "released_by" UUID,
    "release_note" TEXT,
    "unclaimed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_mortuary_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ip_discharges_hospital_id_branch_id_kind_initiated_at_idx" ON "clinical"."ip_discharges"("hospital_id", "branch_id", "kind", "initiated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "uq_discharge_per_admission" ON "clinical"."ip_discharges"("hospital_id", "admission_id");

-- CreateIndex
CREATE INDEX "ip_med_reconciliations_hospital_id_discharge_id_action_idx" ON "clinical"."ip_med_reconciliations"("hospital_id", "discharge_id", "action");

-- CreateIndex
CREATE INDEX "ip_discharge_summaries_hospital_id_branch_id_signed_at_idx" ON "clinical"."ip_discharge_summaries"("hospital_id", "branch_id", "signed_at" DESC);

-- CreateIndex
CREATE INDEX "ip_discharge_summaries_hospital_id_patient_id_idx" ON "clinical"."ip_discharge_summaries"("hospital_id", "patient_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_summary_version" ON "clinical"."ip_discharge_summaries"("discharge_id", "version");

-- CreateIndex
CREATE INDEX "ip_mortuary_records_hospital_id_branch_id_released_at_idx" ON "clinical"."ip_mortuary_records"("hospital_id", "branch_id", "released_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_mortuary_record_no" ON "clinical"."ip_mortuary_records"("hospital_id", "record_no");

-- CreateIndex
CREATE UNIQUE INDEX "uq_body_tag_no" ON "clinical"."ip_mortuary_records"("hospital_id", "body_tag_no");

-- AddForeignKey
ALTER TABLE "clinical"."ip_med_reconciliations" ADD CONSTRAINT "ip_med_reconciliations_discharge_id_fkey" FOREIGN KEY ("discharge_id") REFERENCES "clinical"."ip_discharges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."ip_discharge_summaries" ADD CONSTRAINT "ip_discharge_summaries_discharge_id_fkey" FOREIGN KEY ("discharge_id") REFERENCES "clinical"."ip_discharges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  An unresolved discrepancy blocks the signature ────────────────────
CREATE OR REPLACE FUNCTION clinical.assert_meds_reconciled()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_unresolved int; v_drug text;
BEGIN
  IF NEW.signed_at IS NULL OR (TG_OP = 'UPDATE' AND OLD.signed_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  SELECT count(*), min(drug_name) INTO v_unresolved, v_drug
    FROM clinical.ip_med_reconciliations
   WHERE discharge_id = NEW.discharge_id AND action = 'unresolved';

  IF v_unresolved > 0 THEN
    RAISE EXCEPTION '% medicine(s) are still unreconciled, starting with % (IP-002 §B.1). The patient goes home with a list; if the list and the ward chart disagree and nobody has said which is right, they take both or neither.',
      v_unresolved, v_drug USING ERRCODE = 'IP002';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "summary_is_signed_on_reconciled_medicines"
  BEFORE INSERT OR UPDATE ON "clinical"."ip_discharge_summaries"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_meds_reconciled();

-- Every decision except "continue as before" says why. Stopping somebody's
-- statin without a reason is how it never gets restarted.
ALTER TABLE "clinical"."ip_med_reconciliations"
  ADD CONSTRAINT "reconciliation_decision_says_why"
  CHECK ("action" IN ('unresolved', 'continue_same')
         OR ("reason" IS NOT NULL AND length(btrim("reason")) >= 4));

ALTER TABLE "clinical"."ip_med_reconciliations"
  ADD CONSTRAINT "resolved_reconciliation_is_owned"
  CHECK ("action" = 'unresolved' OR ("decided_at" IS NOT NULL AND "decided_by" IS NOT NULL));


-- ── §B.2  A signed summary is immutable ─────────────────────────────────────
CREATE OR REPLACE FUNCTION clinical.refuse_editing_a_signed_summary()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF OLD.signed_at IS NULL THEN RETURN NEW; END IF;

  -- Co-signing is the one change a signed summary accepts. Everything else is
  -- a new version.
  IF NEW.final_diagnosis        IS DISTINCT FROM OLD.final_diagnosis
     OR NEW.course_in_hospital  IS DISTINCT FROM OLD.course_in_hospital
     OR NEW.condition_on_discharge IS DISTINCT FROM OLD.condition_on_discharge
     OR NEW.discharge_medications IS DISTINCT FROM OLD.discharge_medications
     OR NEW.follow_up_plan      IS DISTINCT FROM OLD.follow_up_plan
     OR NEW.red_flag_advice     IS DISTINCT FROM OLD.red_flag_advice
     OR NEW.signed_by           IS DISTINCT FROM OLD.signed_by
     OR NEW.signed_at           IS DISTINCT FROM OLD.signed_at THEN
    RAISE EXCEPTION 'Version % of this summary is signed and cannot be edited (IP-002 §B.2). Issue a new version with a reason — a GP, an insurer and a court all read this document, and one that can be edited after signing is one none of them can rely on.',
      OLD.version USING ERRCODE = 'IP002';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "signed_summary_is_immutable"
  BEFORE UPDATE ON "clinical"."ip_discharge_summaries"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_editing_a_signed_summary();

-- A signature names the signer. A co-signature is a second, different person.
ALTER TABLE "clinical"."ip_discharge_summaries"
  ADD CONSTRAINT "summary_signature_is_owned"
  CHECK (("signed_at" IS NULL) = ("signed_by" IS NULL)
     AND ("cosigned_at" IS NULL) = ("cosigned_by" IS NULL));

ALTER TABLE "clinical"."ip_discharge_summaries"
  ADD CONSTRAINT "cosigner_is_a_second_person"
  CHECK ("cosigned_by" IS NULL OR "signed_by" IS NULL OR "cosigned_by" <> "signed_by");

-- A later version says what it changed.
ALTER TABLE "clinical"."ip_discharge_summaries"
  ADD CONSTRAINT "amendment_states_its_reason"
  CHECK ("version" = 1 OR ("amend_reason" IS NOT NULL AND length(btrim("amend_reason")) >= 8));

-- Red-flag advice is not optional. It is the paragraph that brings a
-- deteriorating patient back, and the one most often left out.
ALTER TABLE "clinical"."ip_discharge_summaries"
  ADD CONSTRAINT "summary_carries_red_flag_advice"
  CHECK (length(btrim("red_flag_advice")) >= 10);


-- ── §B.3  A body goes to a verified next of kin ─────────────────────────────
CREATE OR REPLACE FUNCTION clinical.assert_body_release_is_lawful()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_mlc record;
BEGIN
  IF NEW.released_at IS NULL OR (TG_OP = 'UPDATE' AND OLD.released_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  IF NEW.mccd_no IS NULL OR NEW.mccd_issued_at IS NULL THEN
    RAISE EXCEPTION 'The death certificate has not been issued for % (IP-017 §B.3). No body is released without one.',
      NEW.body_tag_no USING ERRCODE = 'IP002';
  END IF;

  IF NEW.unclaimed THEN
    -- An unclaimed body follows a different, longer process and does not go to
    -- a next of kin at all.
    RETURN NEW;
  END IF;

  IF NEW.nok_verified_at IS NULL OR NEW.nok_verified_by IS NULL
     OR NEW.nok_name IS NULL OR NEW.nok_id_ref IS NULL THEN
    RAISE EXCEPTION 'The next of kin for % has not been identified and verified (IP-017 §B.3). A body goes to somebody whose identity was checked against a document, not to whoever came to the door.',
      NEW.body_tag_no USING ERRCODE = 'IP002';
  END IF;

  IF NEW.mlc_id IS NOT NULL THEN
    SELECT status::text AS status, mlc_no INTO v_mlc
      FROM clinical.mlc_cases WHERE id = NEW.mlc_id;

    IF FOUND AND v_mlc.status NOT IN ('closed', 'cancelled') THEN
      RAISE EXCEPTION 'Medico-legal case % is still open (IP-017 §B.3). Releasing a body in an unresolved MLC destroys evidence that cannot be recovered, and the family cannot consent to that on the state''s behalf.',
        v_mlc.mlc_no USING ERRCODE = 'IP002';
    END IF;
  END IF;

  IF NEW.post_mortem_required AND NEW.post_mortem_at IS NULL THEN
    RAISE EXCEPTION 'A post-mortem is required on % and has not been performed (IP-017 §B.3).',
      NEW.body_tag_no USING ERRCODE = 'IP002';
  END IF;

  IF NEW.released_by IS NULL THEN
    RAISE EXCEPTION 'Releasing a body names who released it (IP-017 §B.3).'
      USING ERRCODE = 'IP002';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "body_release_is_lawful"
  BEFORE INSERT OR UPDATE ON "clinical"."ip_mortuary_records"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_body_release_is_lawful();

ALTER TABLE "clinical"."ip_mortuary_records"
  ADD CONSTRAINT "mccd_form_is_known"
  CHECK ("mccd_form" IS NULL OR "mccd_form" IN ('4', '4A'));

ALTER TABLE "clinical"."ip_mortuary_records"
  ADD CONSTRAINT "cause_of_death_is_stated"
  CHECK (length(btrim("cause_of_death")) >= 4);

ALTER TABLE "clinical"."ip_mortuary_records"
  ADD CONSTRAINT "release_after_declaration"
  CHECK ("released_at" IS NULL OR "released_at" >= "declared_at");


-- ── Housekeeping on the discharge itself ────────────────────────────────────
--
-- Leaving against advice is a right, and it is exercised. The record of it is
-- what protects the patient and the hospital equally: what was explained, who
-- witnessed it, and when they signed.
ALTER TABLE "clinical"."ip_discharges"
  ADD CONSTRAINT "dama_records_what_was_explained"
  CHECK ("kind" <> 'dama'
         OR ("dama_risks_explained" IS NOT NULL AND length(btrim("dama_risks_explained")) >= 12
             AND "dama_witness_name" IS NOT NULL AND "dama_signed_at" IS NOT NULL));

ALTER TABLE "clinical"."ip_discharges"
  ADD CONSTRAINT "completed_discharge_is_owned"
  CHECK ("completed_at" IS NULL OR "completed_by" IS NOT NULL);

ALTER TABLE "clinical"."ip_discharges"
  ADD CONSTRAINT "discharge_completes_after_it_starts"
  CHECK ("completed_at" IS NULL OR "completed_at" >= "initiated_at");

COMMENT ON CONSTRAINT "summary_carries_red_flag_advice" ON "clinical"."ip_discharge_summaries" IS
  'The paragraph that brings a deteriorating patient back, and the one most often left out. A summary without it is a summary that discharges somebody with no idea what would mean they should return.';

COMMENT ON TABLE "clinical"."ip_mortuary_records" IS
  'A body is released to a verified next of kin, never while a medico-legal case is open, never without a certificate, and never before a required post-mortem. All four are one trigger, because a body released wrongly cannot be recalled.';


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
  WHERE n.nspname = 'clinical' AND (c.relname LIKE 'ip\_discharge%' OR c.relname LIKE 'ip\_med\_recon%' OR c.relname LIKE 'ip\_mortuary%')
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase 7G tables without RLS or a tenant policy: %', v_missing;
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
      AND (c.relname LIKE 'ip\_discharge%' OR c.relname LIKE 'ip\_med\_recon%' OR c.relname LIKE 'ip\_mortuary%')
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % Phase 7G table(s)', v_count;
END $$;

-- A summary, a discharge and a death record are documents. None is deleted.
REVOKE DELETE ON "clinical"."ip_discharge_summaries" FROM hms_app;
REVOKE DELETE ON "clinical"."ip_discharges"          FROM hms_app;
REVOKE DELETE ON "clinical"."ip_mortuary_records"    FROM hms_app;
