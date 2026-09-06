-- ═════════════════════════════════════════════════════════════════════════════
-- TR-001 — a START triage is a triage
--
-- OP-006 shipped `er_visit_triage_is_complete` as
--
--     CHECK ((esi_level IS NULL) = (triaged_at IS NULL))
--
-- which was right for the module that wrote it: OP-006 knows only about ESI, and
-- a triage time with no level would have been a half-written record.
--
-- TR-001 introduces the second ladder. In a declared mass-casualty incident the
-- nurse triages with START — red, yellow, green, black — and does not count
-- resources, because counting resources for a patient you have thirty seconds
-- for is not a thing anybody does. Those patients are triaged. They have no ESI
-- level, and the OP-006 constraint refuses to let the visit record say when they
-- were seen.
--
-- The fix is not to stop stamping `triaged_at`. It is to say what "triaged"
-- actually means: the visit carries a level or a tag.
--
-- ── Why the tag is denormalised too ────────────────────────────────────────
--
-- `esi_level` sits on `er_visits` so the board sorts on acuity without a join.
-- Without the tag beside it, every MCI patient sorts into the same bucket as the
-- un-triaged — at exactly the moment the board is the only thing holding the
-- department together. So the tag is written in the same transaction as the
-- triage record, the same way the level is.
--
-- ── Where black sorts ──────────────────────────────────────────────────────
--
-- Last. A black tag under START is expectant: the patient is not expected to
-- survive with the resources available, and the doctrine is that they are not
-- treated while red and yellow patients are waiting. That is the hardest
-- sentence in this file and it is the whole point of triaging under scarcity.
-- It belongs in the sort order rather than in somebody's head at 2 a.m.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "clinical"."er_visits"
  ADD COLUMN "triage_tag" "clinical"."TriageTag";

ALTER TABLE "clinical"."er_visits"
  DROP CONSTRAINT "er_visit_triage_is_complete";

ALTER TABLE "clinical"."er_visits"
  ADD CONSTRAINT "er_visit_triage_is_complete"
  CHECK (("esi_level" IS NULL AND "triage_tag" IS NULL) = ("triaged_at" IS NULL));

-- A visit carries one ladder's answer, not both. A patient with an ESI level and
-- a START tag is a record two people triaged under two systems without talking,
-- and whichever one the board reads is a coin toss.
ALTER TABLE "clinical"."er_visits"
  ADD CONSTRAINT "er_visit_has_one_triage_ladder"
  CHECK ("esi_level" IS NULL OR "triage_tag" IS NULL);

-- The board's acuity sort, as an index it can actually use.
CREATE INDEX "er_visits_acuity_idx"
  ON "clinical"."er_visits" ("hospital_id", "branch_id", "status", "esi_level", "triage_tag");

COMMENT ON COLUMN "clinical"."er_visits"."triage_tag" IS
  'START/JumpSTART category, set instead of esi_level during a declared MCI. Denormalised from TR-001 for the board''s acuity sort — black sorts last, which is what expectant means.';
