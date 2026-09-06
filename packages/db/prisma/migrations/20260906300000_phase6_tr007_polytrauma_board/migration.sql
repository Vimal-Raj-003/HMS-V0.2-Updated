-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 6 · TR-007 — the polytrauma coordination board
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A polytrauma patient has six problems and six owners. What kills them is
-- usually not any single injury: it is that neurosurgery, orthopaedics and
-- general surgery each have a correct plan and nobody sequenced the three.
-- This board makes the sequence a written, shared object instead of a corridor
-- conversation somebody half-remembers.
--
-- §A  Tables (generated)
-- §B  The rules, as database shapes
-- §C  Grants
-- §D  Row-level security
--
-- ── §B, in one page ─────────────────────────────────────────────────────────
--
--   B.1  Life-saving before limb-saving before definitive. A femoral nail ahead
--        of a laparotomy for a bleeding spleen is a patient who dies with a
--        beautifully fixed femur.
--   B.2  A procedure cannot enter theatre without a settled consent — and an
--        emergency waiver is lawful only for a life-saving one.
--   B.3  A procedure that needs blood cannot start until the units are reserved,
--        not merely requested. "Cross-match 6" and "6 in the fridge" are
--        different facts and a laparotomy started on the first one stops halfway.
--   B.4  A consult's due time is the database's arithmetic, not the caller's.
--   B.5  Escalating a consult that is not breached needs stated grounds.
--   B.6  A board cannot close while a procedure is unfinished or a consult
--        unanswered — the same shape as an implant recall, for the same reason.
--
-- Custom SQLSTATE: TR007.

-- CreateEnum
CREATE TYPE "clinical"."ProcedurePriority" AS ENUM ('life_saving', 'limb_saving', 'definitive', 'adjunct');

-- CreateEnum
CREATE TYPE "clinical"."ProcedureState" AS ENUM ('planned', 'ready', 'in_theatre', 'done', 'abandoned', 'deferred');

-- CreateEnum
CREATE TYPE "clinical"."ConsentState" AS ENUM ('not_sought', 'sought', 'given', 'refused', 'emergency_waiver', 'withdrawn');

-- CreateEnum
CREATE TYPE "clinical"."ConsultState" AS ENUM ('requested', 'acknowledged', 'seen', 'advised', 'declined', 'cancelled');

-- CreateEnum
CREATE TYPE "clinical"."PolytraumaState" AS ENUM ('active', 'handed_over', 'closed');

-- CreateTable
CREATE TABLE "clinical"."pt_cases" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "patient_id" UUID NOT NULL,
    "er_visit_id" UUID,
    "activation_id" UUID,
    "admission_id" UUID,
    "case_no" VARCHAR(60) NOT NULL,
    "lead_clinician_id" UUID,
    "state" "clinical"."PolytraumaState" NOT NULL DEFAULT 'active',
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_by" UUID,
    "closed_at" TIMESTAMPTZ(6),
    "closed_by" UUID,
    "outcome" VARCHAR(60),
    "closure_notes" TEXT,
    "iss_at_open" INTEGER,
    "niss_at_open" INTEGER,
    "triss_at_open" VARCHAR(12),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pt_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."pt_procedures" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "specialty" VARCHAR(60) NOT NULL,
    "fracture_id" UUID,
    "injury_id" UUID,
    "side" VARCHAR(16),
    "priority" "clinical"."ProcedurePriority" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "state" "clinical"."ProcedureState" NOT NULL DEFAULT 'planned',
    "surgeon_id" UUID,
    "planned_for" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "estimated_minutes" INTEGER,
    "rationale" TEXT,
    "defer_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pt_procedures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."pt_consents" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "procedure_id" UUID NOT NULL,
    "state" "clinical"."ConsentState" NOT NULL DEFAULT 'not_sought',
    "signed_by" VARCHAR(120),
    "relationship" VARCHAR(60),
    "explained_locale" VARCHAR(12),
    "explained_by" UUID,
    "risks_discussed" TEXT[],
    "sought_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "reason" TEXT,
    "witness_name" VARCHAR(120),
    "document_ref" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pt_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."pt_blood_requirements" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "procedure_id" UUID,
    "component" VARCHAR(40) NOT NULL,
    "units_required" INTEGER NOT NULL,
    "units_reserved" INTEGER NOT NULL DEFAULT 0,
    "units_issued" INTEGER NOT NULL DEFAULT 0,
    "mtp_activated" BOOLEAN NOT NULL DEFAULT false,
    "mtp_activated_at" TIMESTAMPTZ(6),
    "crossmatch_ref" VARCHAR(60),
    "needed_by" TIMESTAMPTZ(6),
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pt_blood_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."pt_consults" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "specialty" VARCHAR(60) NOT NULL,
    "question" TEXT NOT NULL,
    "urgency" VARCHAR(16) NOT NULL DEFAULT 'routine',
    "sla_minutes" INTEGER NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requested_by" UUID,
    "due_at" TIMESTAMPTZ(6) NOT NULL,
    "state" "clinical"."ConsultState" NOT NULL DEFAULT 'requested',
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" UUID,
    "seen_at" TIMESTAMPTZ(6),
    "seen_by" UUID,
    "advice" TEXT,
    "escalated_at" TIMESTAMPTZ(6),
    "escalated_to" UUID,
    "escalation_note" TEXT,
    "decline_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pt_consults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."pt_team_members" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(60) NOT NULL,
    "specialty" VARCHAR(60),
    "is_lead" BOOLEAN NOT NULL DEFAULT false,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pt_team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."pt_tasks" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "detail" TEXT,
    "owner_id" UUID,
    "procedure_id" UUID,
    "due_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "completed_by" UUID,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pt_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."pt_huddles" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "held_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chair_id" UUID,
    "specialties" TEXT[],
    "attendees" UUID[],
    "decisions" TEXT NOT NULL,
    "concerns" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pt_huddles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clinical"."pt_family_updates" (
    "id" UUID NOT NULL,
    "hospital_id" UUID NOT NULL,
    "case_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "by_id" UUID,
    "spoke_to" VARCHAR(120) NOT NULL,
    "relationship" VARCHAR(60),
    "locale" VARCHAR(12),
    "summary" TEXT NOT NULL,
    "prognosis_discussed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pt_family_updates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pt_cases_hospital_id_branch_id_state_opened_at_idx" ON "clinical"."pt_cases"("hospital_id", "branch_id", "state", "opened_at" DESC);

-- CreateIndex
CREATE INDEX "pt_cases_hospital_id_patient_id_idx" ON "clinical"."pt_cases"("hospital_id", "patient_id");

-- CreateIndex
CREATE INDEX "pt_cases_hospital_id_er_visit_id_idx" ON "clinical"."pt_cases"("hospital_id", "er_visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_polytrauma_case_no" ON "clinical"."pt_cases"("hospital_id", "case_no");

-- CreateIndex
CREATE INDEX "pt_procedures_hospital_id_case_id_sequence_idx" ON "clinical"."pt_procedures"("hospital_id", "case_id", "sequence");

-- CreateIndex
CREATE INDEX "pt_procedures_hospital_id_state_idx" ON "clinical"."pt_procedures"("hospital_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "uq_pt_procedure_sequence" ON "clinical"."pt_procedures"("case_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "pt_consents_procedure_id_key" ON "clinical"."pt_consents"("procedure_id");

-- CreateIndex
CREATE INDEX "pt_consents_hospital_id_state_idx" ON "clinical"."pt_consents"("hospital_id", "state");

-- CreateIndex
CREATE INDEX "pt_blood_requirements_hospital_id_case_id_idx" ON "clinical"."pt_blood_requirements"("hospital_id", "case_id");

-- CreateIndex
CREATE INDEX "pt_consults_hospital_id_case_id_idx" ON "clinical"."pt_consults"("hospital_id", "case_id");

-- CreateIndex
CREATE INDEX "pt_consults_hospital_id_state_due_at_idx" ON "clinical"."pt_consults"("hospital_id", "state", "due_at");

-- CreateIndex
CREATE INDEX "pt_team_members_hospital_id_case_id_idx" ON "clinical"."pt_team_members"("hospital_id", "case_id");

-- CreateIndex
CREATE INDEX "pt_tasks_hospital_id_case_id_completed_at_idx" ON "clinical"."pt_tasks"("hospital_id", "case_id", "completed_at");

-- CreateIndex
CREATE INDEX "pt_huddles_hospital_id_case_id_held_at_idx" ON "clinical"."pt_huddles"("hospital_id", "case_id", "held_at" DESC);

-- CreateIndex
CREATE INDEX "pt_family_updates_hospital_id_case_id_at_idx" ON "clinical"."pt_family_updates"("hospital_id", "case_id", "at" DESC);

-- AddForeignKey
ALTER TABLE "clinical"."pt_procedures" ADD CONSTRAINT "pt_procedures_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."pt_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."pt_consents" ADD CONSTRAINT "pt_consents_procedure_id_fkey" FOREIGN KEY ("procedure_id") REFERENCES "clinical"."pt_procedures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."pt_blood_requirements" ADD CONSTRAINT "pt_blood_requirements_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."pt_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."pt_blood_requirements" ADD CONSTRAINT "pt_blood_requirements_procedure_id_fkey" FOREIGN KEY ("procedure_id") REFERENCES "clinical"."pt_procedures"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."pt_consults" ADD CONSTRAINT "pt_consults_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."pt_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."pt_team_members" ADD CONSTRAINT "pt_team_members_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."pt_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."pt_tasks" ADD CONSTRAINT "pt_tasks_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."pt_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."pt_huddles" ADD CONSTRAINT "pt_huddles_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."pt_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clinical"."pt_family_updates" ADD CONSTRAINT "pt_family_updates_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "clinical"."pt_cases"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ═════════════════════════════════════════════════════════════════════════════
-- §B. THE RULES
-- ═════════════════════════════════════════════════════════════════════════════

-- ── §B.1  Life-saving before limb-saving before definitive ──────────────────
--
-- The one rule this board exists for. Not a sorting convention — a refusal.
-- Two lists made separately and merged by whoever reached the whiteboard first
-- is how a femoral nail ends up ahead of a laparotomy for a bleeding spleen.
--
-- Enforced on the *class*, not the individual procedure: two life-saving
-- procedures may be in any order relative to each other, because which chest
-- and which abdomen goes first is a surgical judgement. What is not a
-- judgement is a definitive case displacing a life-saving one.
CREATE OR REPLACE FUNCTION clinical.assert_procedure_sequence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_bad record;
BEGIN
  -- Checked as a whole-case invariant at COMMIT, reading the table rather than
  -- the row image the statement captured.
  --
  -- The distinction matters. Reordering a list means updating every row, and
  -- the intermediate states are legitimately out of order — a statement that
  -- shifts everything by ten before putting each row in its new place is a
  -- normal way to move rows under a unique index. An AFTER trigger's `NEW` is
  -- frozen at the statement that produced it, so judging each frozen image
  -- would refuse the final, correct arrangement. Reading the table at commit
  -- judges what is actually there.
  --
  -- Deferred and abandoned rows are excluded: a case somebody decided against
  -- should not pin the ordering of the cases that are still happening.
  WITH ranked AS (
    SELECT name, priority, sequence,
           CASE priority
             WHEN 'life_saving' THEN 1
             WHEN 'limb_saving' THEN 2
             WHEN 'definitive'  THEN 3
             ELSE 4
           END AS rank
      FROM clinical.pt_procedures
     WHERE case_id = NEW.case_id
       AND state NOT IN ('abandoned', 'deferred')
  )
  SELECT earlier.name     AS earlier_name,
         earlier.priority AS earlier_priority,
         earlier.sequence AS earlier_seq,
         later.name       AS later_name,
         later.priority   AS later_priority,
         later.sequence   AS later_seq
    INTO v_bad
    FROM ranked earlier
    JOIN ranked later
      ON later.sequence > earlier.sequence
     AND later.rank < earlier.rank
   ORDER BY earlier.sequence, later.sequence
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION '"%" is % and sits at position %, ahead of "%" at position %, which is % (TR-007 §B.1). Life-saving comes before limb-saving comes before definitive.',
      v_bad.earlier_name, replace(v_bad.earlier_priority::text, '_', '-'), v_bad.earlier_seq,
      v_bad.later_name, v_bad.later_seq, replace(v_bad.later_priority::text, '_', '-')
      USING ERRCODE = 'TR007';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "procedure_queue_is_ordered_by_urgency"
  AFTER INSERT OR UPDATE ON "clinical"."pt_procedures"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_procedure_sequence();

ALTER TABLE "clinical"."pt_procedures"
  ADD CONSTRAINT "procedure_sequence_is_positive" CHECK ("sequence" >= 1);

ALTER TABLE "clinical"."pt_procedures"
  ADD CONSTRAINT "procedure_finishes_after_it_starts"
  CHECK ("finished_at" IS NULL OR ("started_at" IS NOT NULL AND "finished_at" >= "started_at"));

-- Deferring a procedure is a decision about a patient who is still injured.
ALTER TABLE "clinical"."pt_procedures"
  ADD CONSTRAINT "deferral_says_why"
  CHECK ("state" <> 'deferred' OR ("defer_reason" IS NOT NULL AND length(btrim("defer_reason")) >= 8));

ALTER TABLE "clinical"."pt_procedures"
  ADD CONSTRAINT "abandonment_says_why"
  CHECK ("state" <> 'abandoned' OR ("defer_reason" IS NOT NULL AND length(btrim("defer_reason")) >= 8));


-- ── §B.2  Consent, and the one case where it is waived ──────────────────────
--
-- A procedure enters theatre on a settled consent: given, refused-and-
-- overridden, or waived. `not_sought` and `sought` are both "nobody has an
-- answer yet", and wheeling a patient in on either is the failure this checks.
--
-- The waiver is narrow on purpose. An unconscious patient with no next of kin
-- can lawfully have their bleeding stopped; they cannot lawfully have their
-- fracture plated while nobody is asking. Tying the waiver to `life_saving`
-- makes the narrow case easy and the wide one impossible.
CREATE OR REPLACE FUNCTION clinical.assert_consent_before_theatre()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_consent record; v_priority text;
BEGIN
  IF NEW.state <> 'in_theatre' OR (TG_OP = 'UPDATE' AND OLD.state = 'in_theatre') THEN
    RETURN NEW;
  END IF;

  SELECT state::text, reason INTO v_consent
    FROM clinical.pt_consents WHERE procedure_id = NEW.id;

  IF NOT FOUND OR v_consent.state IN ('not_sought', 'sought') THEN
    RAISE EXCEPTION 'Consent for "%" has not been settled (TR-007 §B.2). Record it as given, as refused, or — for a life-saving procedure on a patient who cannot consent — as an emergency waiver with grounds.',
      NEW.name USING ERRCODE = 'TR007';
  END IF;

  IF v_consent.state = 'withdrawn' THEN
    RAISE EXCEPTION 'Consent for "%" was withdrawn (TR-007 §B.2).', NEW.name USING ERRCODE = 'TR007';
  END IF;

  IF v_consent.state = 'refused' THEN
    RAISE EXCEPTION 'Consent for "%" was refused (TR-007 §B.2). A refused procedure does not go to theatre; if the refusal has been revisited, record the new decision first.',
      NEW.name USING ERRCODE = 'TR007';
  END IF;

  IF v_consent.state = 'emergency_waiver' THEN
    v_priority := NEW.priority::text;
    IF v_priority <> 'life_saving' THEN
      RAISE EXCEPTION 'An emergency waiver covers a life-saving procedure. "%" is recorded as % (TR-007 §B.2). Somebody has to be asked.',
        NEW.name, replace(v_priority, '_', '-') USING ERRCODE = 'TR007';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "procedure_enters_theatre_on_a_settled_consent"
  BEFORE UPDATE ON "clinical"."pt_procedures"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_consent_before_theatre();

-- A waiver and an against-advice refusal both need grounds.
ALTER TABLE "clinical"."pt_consents"
  ADD CONSTRAINT "waiver_states_its_grounds"
  CHECK ("state" <> 'emergency_waiver' OR ("reason" IS NOT NULL AND length(btrim("reason")) >= 12));

ALTER TABLE "clinical"."pt_consents"
  ADD CONSTRAINT "settled_consent_is_dated"
  CHECK ("state" IN ('not_sought', 'sought') OR "decided_at" IS NOT NULL);

-- A consent that was given records who gave it. "The patient consented" with no
-- name on it is a sentence, not a record.
ALTER TABLE "clinical"."pt_consents"
  ADD CONSTRAINT "given_consent_is_owned"
  CHECK ("state" <> 'given' OR ("signed_by" IS NOT NULL AND length(btrim("signed_by")) >= 2));


-- ── §B.3  Blood that is reserved, not merely requested ──────────────────────
CREATE OR REPLACE FUNCTION clinical.assert_blood_before_theatre()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_short record;
BEGIN
  IF NEW.state <> 'in_theatre' OR (TG_OP = 'UPDATE' AND OLD.state = 'in_theatre') THEN
    RETURN NEW;
  END IF;

  SELECT component, units_required, units_reserved INTO v_short
    FROM clinical.pt_blood_requirements
   WHERE procedure_id = NEW.id AND units_reserved < units_required
   ORDER BY units_required - units_reserved DESC
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION '"%" needs % units of % and % are reserved (TR-007 §B.3). Cross-matched is not the same as in the fridge, and an operation started on the difference stops halfway.',
      NEW.name, v_short.units_required, v_short.component, v_short.units_reserved
      USING ERRCODE = 'TR007';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "procedure_enters_theatre_with_its_blood"
  BEFORE UPDATE ON "clinical"."pt_procedures"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_blood_before_theatre();

ALTER TABLE "clinical"."pt_blood_requirements"
  ADD CONSTRAINT "blood_counts_are_sane"
  CHECK ("units_required" >= 0 AND "units_reserved" >= 0 AND "units_issued" >= 0
         AND "units_issued" <= "units_reserved");

ALTER TABLE "clinical"."pt_blood_requirements"
  ADD CONSTRAINT "mtp_activation_is_dated"
  CHECK (NOT "mtp_activated" OR "mtp_activated_at" IS NOT NULL);


-- ── §B.4  The due time is the database's arithmetic ─────────────────────────
--
-- Computed here rather than accepted from the caller, because an SLA the client
-- calculates is an SLA the client can be wrong about, and this is the column
-- the escalation rule and the board's sort both read.
CREATE OR REPLACE FUNCTION clinical.set_consult_due_at()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  NEW.due_at := NEW.requested_at + make_interval(mins => NEW.sla_minutes);
  RETURN NEW;
END $$;

CREATE TRIGGER "consult_due_at_is_computed"
  BEFORE INSERT OR UPDATE OF requested_at, sla_minutes ON "clinical"."pt_consults"
  FOR EACH ROW EXECUTE FUNCTION clinical.set_consult_due_at();

ALTER TABLE "clinical"."pt_consults"
  ADD CONSTRAINT "consult_sla_is_positive" CHECK ("sla_minutes" BETWEEN 1 AND 10080);

-- Seen means somebody saw the patient, so it names them.
ALTER TABLE "clinical"."pt_consults"
  ADD CONSTRAINT "seen_consult_is_owned"
  CHECK ("state" NOT IN ('seen', 'advised') OR ("seen_at" IS NOT NULL AND "seen_by" IS NOT NULL));

ALTER TABLE "clinical"."pt_consults"
  ADD CONSTRAINT "advised_consult_carries_advice"
  CHECK ("state" <> 'advised' OR ("advice" IS NOT NULL AND length(btrim("advice")) >= 4));

ALTER TABLE "clinical"."pt_consults"
  ADD CONSTRAINT "declined_consult_says_why"
  CHECK ("state" <> 'declined' OR ("decline_reason" IS NOT NULL AND length(btrim("decline_reason")) >= 8));


-- ── §B.5  Escalation is an act, and an early one is explained ───────────────
--
-- Escalating before the clock runs out is legitimate — a patient can be
-- deteriorating faster than an SLA anticipated. It just should not be silent,
-- because an escalation register full of un-breached consults is a register
-- nobody reads.
CREATE OR REPLACE FUNCTION clinical.assert_escalation_is_earned()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
BEGIN
  IF NEW.escalated_at IS NULL OR (TG_OP = 'UPDATE' AND OLD.escalated_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  IF NEW.escalated_to IS NULL THEN
    RAISE EXCEPTION 'An escalation names who it went to (TR-007 §B.5). "We escalated it" cannot be checked.'
      USING ERRCODE = 'TR007';
  END IF;

  IF NEW.escalated_at < NEW.due_at
     AND (NEW.escalation_note IS NULL OR length(btrim(NEW.escalation_note)) < 8) THEN
    RAISE EXCEPTION 'This consult is not yet past its % minute target and is being escalated early (TR-007 §B.5). That is allowed — say why, so the escalation register stays worth reading.',
      NEW.sla_minutes USING ERRCODE = 'TR007';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "consult_escalation_is_earned"
  BEFORE INSERT OR UPDATE ON "clinical"."pt_consults"
  FOR EACH ROW EXECUTE FUNCTION clinical.assert_escalation_is_earned();


-- ── §B.6  A board does not close over unfinished work ───────────────────────
CREATE OR REPLACE FUNCTION clinical.refuse_closing_a_live_board()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, clinical AS $$
DECLARE v_procedures int; v_consults int; v_tasks int;
BEGIN
  IF NEW.closed_at IS NULL OR OLD.closed_at IS NOT NULL THEN RETURN NEW; END IF;

  SELECT count(*) INTO v_procedures FROM clinical.pt_procedures
   WHERE case_id = NEW.id AND state IN ('planned', 'ready', 'in_theatre');

  SELECT count(*) INTO v_consults FROM clinical.pt_consults
   WHERE case_id = NEW.id AND state IN ('requested', 'acknowledged');

  SELECT count(*) INTO v_tasks FROM clinical.pt_tasks
   WHERE case_id = NEW.id AND blocking AND completed_at IS NULL;

  IF v_procedures > 0 OR v_consults > 0 OR v_tasks > 0 THEN
    RAISE EXCEPTION 'This board still has % planned procedure(s), % unanswered consult(s) and % blocking task(s) (TR-007 §B.6). Closing it now closes it over work nobody has picked up. Defer or abandon what is not happening, with grounds.',
      v_procedures, v_consults, v_tasks USING ERRCODE = 'TR007';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER "board_closes_when_the_work_is_settled"
  BEFORE UPDATE ON "clinical"."pt_cases"
  FOR EACH ROW EXECUTE FUNCTION clinical.refuse_closing_a_live_board();

ALTER TABLE "clinical"."pt_cases"
  ADD CONSTRAINT "closed_board_is_owned"
  CHECK ("closed_at" IS NULL OR "closed_by" IS NOT NULL);

ALTER TABLE "clinical"."pt_cases"
  ADD CONSTRAINT "board_closes_after_it_opens"
  CHECK ("closed_at" IS NULL OR "closed_at" >= "opened_at");

-- One lead per case. A board with two leads has none.
CREATE UNIQUE INDEX "uq_pt_one_lead_per_case"
  ON "clinical"."pt_team_members" ("case_id")
  WHERE "is_lead" AND "left_at" IS NULL;


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
  WHERE n.nspname = 'clinical' AND c.relname LIKE 'pt\_%'
    AND c.relkind IN ('r','p') AND c.relispartition = false
    AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='tenant_isolation'));
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'TR-007 tables without RLS or a tenant policy: %', v_missing;
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
      AND c.relname LIKE 'pt\_%'
      AND NOT has_table_privilege('hms_app', c.oid, 'SELECT')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO hms_app', r.s, r.t);
    EXECUTE format('GRANT SELECT ON %I.%I TO hms_readonly', r.s, r.t);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Granted application DML on % TR-007 table(s)', v_count;
END $$;

-- A huddle decision and a family conversation are records of something that was
-- said. Amending one afterwards changes what the room is remembered as having
-- decided, so they are append-only.
REVOKE UPDATE, DELETE ON "clinical"."pt_huddles" FROM hms_app;
REVOKE UPDATE, DELETE ON "clinical"."pt_family_updates" FROM hms_app;

COMMENT ON TABLE "clinical"."pt_procedures" IS
  'The sequence, as a written shared object. A femoral nail ahead of a laparotomy for a bleeding spleen is a patient who dies with a beautifully fixed femur, and the failure is never that somebody chose it — it is that two correct lists were merged by whoever reached the whiteboard first.';

COMMENT ON CONSTRAINT "waiver_states_its_grounds" ON "clinical"."pt_consents" IS
  'An unconscious patient with no next of kin can lawfully have their bleeding stopped. They cannot lawfully have their fracture plated while nobody is asking. Tying the waiver to a life-saving procedure makes the narrow case easy and the wide one impossible.';
