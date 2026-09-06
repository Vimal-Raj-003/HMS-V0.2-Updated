-- ═════════════════════════════════════════════════════════════════════════════
-- RC-008 — the immutability trigger silently cancelled deletes, and let an
-- issued estimate be un-issued
--
-- Two defects in `refuse_issued_estimate_edit()` as shipped in `…180000`.
--
-- **1. `RETURN NEW` on the allowed path.** In a `BEFORE DELETE` trigger `NEW` is
-- NULL, and returning NULL from a BEFORE trigger *suppresses the row operation*.
-- So `DELETE FROM est_estimates WHERE status = 'draft'` reported success and
-- deleted nothing. A silent no-op is worse than a refusal: the caller believes
-- the row is gone and nothing in the log says otherwise. `RETURN COALESCE(NEW,
-- OLD)` lets a draft actually be deleted.
--
-- **2. `status` was outside the frozen column list**, so an issued estimate
-- could be set back to `draft` — and from there repriced and reissued at a
-- different number, with the trigger satisfied at every step. That is precisely
-- the sequence §B.1 exists to prevent: the family holds a piece of paper saying
-- ₹2,40,000 and the system now says something else, with no revision recorded
-- and nothing to compare.
--
-- Status must still move: an issued estimate becomes accepted, declined,
-- expired, converted or superseded, and recording that is not editing the quote.
-- So the rule is directional rather than absolute — forward through the
-- lifecycle, never back to `draft`.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "billing".refuse_issued_estimate_edit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME <> 'est_estimates' THEN
    -- A line or a scenario belonging to an issued estimate.
    IF EXISTS (
      SELECT 1 FROM billing.est_estimates e
       WHERE e.id = COALESCE(NEW.estimate_id, OLD.estimate_id)
         AND e.status <> 'draft'
    ) THEN
      RAISE EXCEPTION
        'This estimate has been issued and cannot be changed (RC-008 §B.1). Supersede it with a revision so the family can see what changed.'
        USING ERRCODE = 'RC008';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- A draft is working paper: freely editable, and deletable. COALESCE rather
  -- than NEW, because NEW is NULL on DELETE and returning NULL from a BEFORE
  -- trigger cancels the row operation without saying so.
  IF OLD.status = 'draft' THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'An issued estimate is never deleted (RC-008 §B.1).'
      USING ERRCODE = 'RC008';
  END IF;

  -- Un-issuing would let a quote be repriced and reissued with the trigger
  -- satisfied at every step, which is the exact sequence §B.1 exists to stop.
  IF NEW.status = 'draft' THEN
    RAISE EXCEPTION
      'An issued estimate cannot be returned to draft (RC-008 §B.1). The family holds the number that was issued; supersede it with a revision instead.'
      USING ERRCODE = 'RC008';
  END IF;

  -- What the family was quoted. None of it may move once issued.
  IF NEW.total_gross    IS DISTINCT FROM OLD.total_gross
     OR NEW.total_discount IS DISTINCT FROM OLD.total_discount
     OR NEW.total_payable  IS DISTINCT FROM OLD.total_payable
     OR NEW.patient_share  IS DISTINCT FROM OLD.patient_share
     OR NEW.payer_share    IS DISTINCT FROM OLD.payer_share
     OR NEW.co_pay_pct     IS DISTINCT FROM OLD.co_pay_pct
     OR NEW.deductible     IS DISTINCT FROM OLD.deductible
     OR NEW.valid_till     IS DISTINCT FROM OLD.valid_till
     OR NEW.los_days       IS DISTINCT FROM OLD.los_days
     OR NEW.bed_class_id   IS DISTINCT FROM OLD.bed_class_id
     OR NEW.title          IS DISTINCT FROM OLD.title
     OR NEW.issued_at      IS DISTINCT FROM OLD.issued_at
  THEN
    RAISE EXCEPTION
      'An issued estimate cannot be repriced (RC-008 §B.1). Supersede it with a revision — the family was given the old number and is entitled to see both.'
      USING ERRCODE = 'RC008';
  END IF;

  RETURN NEW;
END $$;
