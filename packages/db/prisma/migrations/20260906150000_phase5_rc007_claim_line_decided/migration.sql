-- ═════════════════════════════════════════════════════════════════════════════
-- RC-007 — a claim line accounts for every rupee *once it has been decided*
--
-- The constraint shipped in `20260906140000` read:
--
--     CHECK (approved_amount + disallowed_amount = claimed_amount)
--
-- which is right about a decided line and wrong about every other one. A line
-- the moment it is assembled has ₹90,000 claimed, nothing approved and nothing
-- disallowed, and 0 + 0 ≠ 90,000 — so no claim could be assembled at all.
--
-- The original was proven against a row that already carried a decision, which
-- is exactly the row it happened to be correct about. The insert path was never
-- exercised until the module was driven end to end, and it failed on the first
-- claim.
--
-- The fix is to say what was actually meant. A line now carries `decided_at`,
-- and the accounting rule applies from that moment: before a decision, nothing
-- is claimed to be settled; after one, every rupee is either approved or
-- disallowed and there is nowhere else for it to go. The weaker bound —
-- approved + disallowed never exceeds claimed — holds throughout.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "billing"."scheme_claim_lines"
  ADD COLUMN "decided_at" timestamptz(6);

ALTER TABLE "billing"."scheme_claim_lines"
  DROP CONSTRAINT "scheme_claim_line_balances";

-- Always true: a line cannot settle more than it asked for.
ALTER TABLE "billing"."scheme_claim_lines"
  ADD CONSTRAINT "scheme_claim_line_within_claimed"
  CHECK ("approved_amount" >= 0
         AND "disallowed_amount" >= 0
         AND "approved_amount" + "disallowed_amount" <= "claimed_amount");

-- True from the decision onward: every rupee is accounted for.
ALTER TABLE "billing"."scheme_claim_lines"
  ADD CONSTRAINT "scheme_claim_line_balances"
  CHECK ("decided_at" IS NULL
         OR "approved_amount" + "disallowed_amount" = "claimed_amount");

COMMENT ON COLUMN "billing"."scheme_claim_lines"."decided_at" IS
  'When the authority ruled on this line. Null means undecided, which is why the accounting rule is gated on it — an assembled line has claimed everything and settled nothing.';
