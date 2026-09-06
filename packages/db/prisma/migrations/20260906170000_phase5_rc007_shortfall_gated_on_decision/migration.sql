-- ═════════════════════════════════════════════════════════════════════════════
-- RC-007 — the shortfall rule is gated on the decision, not on a status list
--
-- `scheme_claim_shortfall_is_the_difference` was written as:
--
--     CHECK (status NOT IN ('approved','partially_approved','rejected','paid','closed')
--            OR shortfall_amount = claimed_amount - approved_amount)
--
-- `closed` does not belong in that list. It is reached two ways: from `paid`,
-- where the shortfall was already set correctly and nothing touches it again;
-- and from `draft`, where a claim assembled in error is retired without ever
-- having been decided. The second one has ₹1,25,000 claimed, nothing approved
-- and no shortfall — which is exactly right, and which the constraint refused.
--
-- This is the same mistake as `scheme_claim_line_balances` in
-- `20260906150000`: "has a decision been made?" encoded as a list of statuses,
-- which then drifts from what the statuses actually mean. The claim already
-- records `decided_at`, written by the decision itself and by nothing else, so
-- the rule can simply ask.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE "billing"."scheme_claims"
  DROP CONSTRAINT "scheme_claim_shortfall_is_the_difference";

ALTER TABLE "billing"."scheme_claims"
  ADD CONSTRAINT "scheme_claim_shortfall_is_the_difference"
  CHECK ("decided_at" IS NULL
         OR "shortfall_amount" = "claimed_amount" - "approved_amount");

-- Same reasoning for the submission timestamp: a claim retired from `draft`
-- never went out, so it has none.
ALTER TABLE "billing"."scheme_claims"
  DROP CONSTRAINT "scheme_claim_submitted_has_timestamp";

ALTER TABLE "billing"."scheme_claims"
  ADD CONSTRAINT "scheme_claim_submitted_has_timestamp"
  CHECK (status NOT IN ('submitted', 'queried', 'approved', 'partially_approved', 'paid')
         OR "submitted_at" IS NOT NULL);

COMMENT ON CONSTRAINT "scheme_claim_shortfall_is_the_difference" ON "billing"."scheme_claims" IS
  'From the decision onward the shortfall is exactly claimed less approved. Gated on decided_at rather than on a status list, because a claim can reach a terminal status without ever having been decided.';
