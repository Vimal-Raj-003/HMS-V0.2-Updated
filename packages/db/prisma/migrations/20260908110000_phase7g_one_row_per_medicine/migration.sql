-- ═════════════════════════════════════════════════════════════════════════════
-- Phase 7G follow-up · IP-002 §B.1
--
-- One row per medicine per discharge.
--
-- Two rows for "Metformin" on one discharge is precisely the ambiguity
-- reconciliation exists to remove: one saying continue, one saying stop, and
-- the summary quoting whichever the query happened to order first. It also
-- makes the unresolved count meaningless, and the unresolved count is what
-- blocks the signature.
--
-- The name is normalised for the key but not for display: "metformin" typed on
-- the ward round and "Metformin" from the chart are the same drug, and the
-- pharmacist should not have to reconcile the same medicine twice because of a
-- capital letter.
-- ═════════════════════════════════════════════════════════════════════════════

DELETE FROM "clinical"."ip_med_reconciliations" a
 USING "clinical"."ip_med_reconciliations" b
 WHERE a."discharge_id" = b."discharge_id"
   AND lower(btrim(a."drug_name")) = lower(btrim(b."drug_name"))
   AND a."created_at" < b."created_at";

CREATE UNIQUE INDEX "uq_reconciliation_drug"
  ON "clinical"."ip_med_reconciliations" ("discharge_id", lower(btrim("drug_name")));

COMMENT ON INDEX "clinical"."uq_reconciliation_drug" IS
  'One decision per medicine per discharge. Two rows for one drug is the ambiguity reconciliation exists to remove, and it would make the unresolved count -- which blocks the signature -- meaningless.';
