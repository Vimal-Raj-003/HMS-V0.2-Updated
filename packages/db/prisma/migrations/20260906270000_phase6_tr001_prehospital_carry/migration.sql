-- ═════════════════════════════════════════════════════════════════════════════
-- TR-001 — a third state for a triage record: carried from the road
--
-- TR-009's handover carries the crew's last observation set into the ER, and
-- exit gate 1 requires that it arrives "with zero re-keying". Writing it as a
-- triage record hit `triage_has_a_category`, whose comment reads: "a record
-- with neither [a level nor a tag] is not a triage."
--
-- Both rules are right, and the collision is the interesting part.
--
--   * The crew did not assign an ESI level, and could not have: ESI's decision
--     points are a resource count and a "would I give them my last bed?"
--     judgement, neither of which is a roadside observation. Having the server
--     guess them would be exactly the "a UI computed a level the clinician did
--     not" failure that `packages/contracts/scores` exists to prevent.
--   * Discarding the observations and asking the nurse to retype them is the
--     transposed digit that exit gate 1 exists to eliminate.
--
-- So the honest object is neither: an observation set, taken by the crew,
-- carried in, and awaiting a category. `source = 'prehospital_handover'` names
-- that state, and the CHECK below admits it. The nurse's triage arrives as
-- sequence 2 and both survive — which is what TR-001 does with every re-triage
-- already.
--
-- What this does **not** do is set `er_visits.esi_level` or `triaged_at`. The
-- patient is not triaged until somebody triages them, and OP-006's board still
-- shows them as waiting for it.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "clinical"."triage_records"
  ADD COLUMN "source" varchar(24) NOT NULL DEFAULT 'triage';

ALTER TABLE "clinical"."triage_records"
  ADD CONSTRAINT "triage_source_is_known"
  CHECK ("source" IN ('triage', 'prehospital_handover'));

ALTER TABLE "clinical"."triage_records"
  DROP CONSTRAINT "triage_has_a_category";

ALTER TABLE "clinical"."triage_records"
  ADD CONSTRAINT "triage_has_a_category"
  CHECK (
    (system = 'esi' AND "esi_level" IS NOT NULL AND tag IS NULL)
    OR (system IN ('start', 'jump_start') AND tag IS NOT NULL AND "esi_level" IS NULL)
    -- The third state. Observations in, category pending.
    OR ("source" = 'prehospital_handover' AND "esi_level" IS NULL AND tag IS NULL)
  );

-- A carried record is the crew's, not a clinician's, and it is never the last
-- word: it exists so a nurse triages *from* it. Being append-only like every
-- other triage record, it cannot later be edited into looking like one.
COMMENT ON COLUMN "clinical"."triage_records"."source" IS
  '`triage` or `prehospital_handover`. A handover record carries the crew''s last road observations with no category, because assigning one is the receiving nurse''s act and the crew never recorded the ESI decision points. The nurse''s triage arrives as the next sequence, and both survive.';
