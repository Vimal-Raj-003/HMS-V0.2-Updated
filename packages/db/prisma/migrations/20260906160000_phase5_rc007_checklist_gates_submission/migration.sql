-- ═════════════════════════════════════════════════════════════════════════════
-- RC-007 — the document checklist gates submission, and only submission
--
-- The trigger shipped in `20260906140000` fired on any status outside
-- `('draft','assembled')`, on the reasoning that anything else meant the claim
-- had gone to the authority. `closed` is not such a status: it is where a claim
-- assembled in error is retired, and a claim retired before it was ever sent has
-- no reason to carry a discharge summary. As written, a mistaken draft could
-- neither be submitted (no documents) nor discarded (the same trigger), and it
-- pinned its case open for good.
--
-- The rule that was actually meant is narrower and easier to defend: the pack is
-- checked at the moment it leaves the building. Every status after `submitted`
-- has already passed through it, and `rejected` and `closed` never go out at all.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "billing".assert_scheme_claim_documents()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_missing text;
BEGIN
  -- Only the transition into `submitted`. Everything downstream of it was
  -- checked on the way through; `rejected` and `closed` never reach the
  -- authority, and `closed` is how a claim assembled in error is retired.
  IF NEW.status <> 'submitted' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'submitted' THEN RETURN NEW; END IF;

  SELECT string_agg(d.doc_type, ', ' ORDER BY d.doc_type) INTO v_missing
    FROM billing.scheme_claim_documents d
   WHERE d.claim_id = NEW.id AND d.is_mandatory AND d.file_id IS NULL;

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION
      'This claim cannot be submitted while a mandatory document is missing: %.', v_missing
      USING ERRCODE = 'RC007';
  END IF;

  RETURN NEW;
END $$;
