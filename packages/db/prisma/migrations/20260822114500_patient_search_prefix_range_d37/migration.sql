-- ─────────────────────────────────────────────────────────────────────────────
-- D-37 — the patient-search prefix indexes, and the operator they must be asked
-- for with.
--
-- No schema changes. The three indexes below were always correct; what was wrong
-- was the *operator* the application asked for them with, and this migration
-- writes that contract into the database so the next person to touch the query
-- finds it with `\d+` rather than in a decision log.
--
-- The mechanism, once, in full:
--
--   Under row-level security PostgreSQL will not evaluate a **non-leakproof**
--   qualifier ahead of a policy's own qualifier — a leaky operator could reveal,
--   through an error or through how long it took, the contents of a row the
--   policy was about to hide. `restriction_is_securely_promotable()`
--   (optimizer/util/restrictinfo.c) therefore refuses to promote such a clause
--   to an *index* condition, and it is demoted to a heap filter.
--
--   `~~` (LIKE) is not leakproof. So `mobile_local LIKE 'x%'` entered
--   idx_patients_mobile_prefix on `hospital_id` alone and filtered every row the
--   tenant owns: 101 ms over 176 000 patients on the `volume` seed, and over a
--   second at the three million OP-001 §13 plans for. `=` is leakproof, which is
--   why the exact-match paths were always fine and the defect looked partial.
--
--   `text_pattern_ge` (`~>=~`) and `text_pattern_lt` (`~<~`) ARE leakproof —
--   they compare bytewise, which is precisely what `varchar_pattern_ops` orders
--   by, and they are the same pair PostgreSQL derives from a prefix LIKE in
--   `prefix_quals()` when nothing is in its way. Asking for the half-open range
--   directly is the identical predicate expressed in operators the planner is
--   willing to push into the index. `[prefix, nextPrefix)` bytewise is exactly
--   the set of strings beginning with `prefix`, so this is a rewrite and not a
--   widening, and tenant isolation is untouched: not one policy changed.
--
-- Two things this deliberately does NOT do:
--
--   1. It does not restructure the tenant predicate. That was the first
--      candidate and it was measured against three policy shapes — the current
--      CASE-based `accessible_hospital_ids()`, a single-uuid STABLE function,
--      and an inline `current_setting()`. All three still produced a sequential
--      scan, because `restriction_is_securely_promotable()` inspects the
--      *query's* clause and never the policy's shape. Folding the tenant
--      predicate to a constant cannot fix a leakproofness problem.
--
--   2. It does not mark any operator LEAKPROOF. That is a superuser action —
--      `hms_migrator` owns neither `pg_catalog` nor `ext`, so this file could
--      not perform it even if the trade-off had been accepted — and it is a real
--      information-leak trade-off that belongs in an ADR and in the database
--      bootstrap, not in a schema migration.
--
-- The name trigram is NOT fixed by any of this and remains open: of the eight
-- operators `gin_trgm_ops` supports (`%`, `%>`, `%>>`, `~~`, `~~*`, `~`, `~*`,
-- `=`), only `=` is leakproof, so no trigram index is reachable under RLS at
-- all. `idx_patients_name_trgm`, `idx_patients_local_name_trgm`,
-- `idx_patients_mobile_trgm` and `idx_patients_uhid_trgm` are therefore
-- unreachable from an application query today; the first two are still used by
-- `hms_migrator`-owned maintenance and by the dedupe path's control plans, and
-- none is dropped here because that is a separate decision.
-- ─────────────────────────────────────────────────────────────────────────────

COMMENT ON INDEX patient.idx_patients_mobile_prefix IS
  'Mobile prefix search. Reachable under RLS ONLY via the leakproof bytewise range `mobile_local ~>=~ $lower AND mobile_local ~<~ $upper`; a bare `LIKE ''x%''` is demoted to a heap filter because `~~` is not leakproof (D-37).';

COMMENT ON INDEX patient.idx_patients_uhid_prefix IS
  'UHID prefix search. Reachable under RLS ONLY via the leakproof bytewise range `uhid_normalised ~>=~ $lower AND uhid_normalised ~<~ $upper`; a bare `LIKE ''x%''` is demoted to a heap filter because `~~` is not leakproof (D-37).';

COMMENT ON INDEX patient.idx_identifiers_value_prefix IS
  'Identifier prefix search. Reachable under RLS ONLY via the leakproof bytewise range `value_normalised ~>=~ $lower AND value_normalised ~<~ $upper`; a bare `LIKE ''x%''` leaves the probe bounded on `hospital_id` alone (D-37).';

COMMENT ON INDEX patient.idx_patients_name_trgm IS
  'Fuzzy name search. UNREACHABLE from an application query under row-level security: `%` (similarity_op) is not leakproof and no leakproof operator drives a trigram index. Open in D-37; the only remaining lever is marking similarity_op LEAKPROOF, which is a superuser decision.';

-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK: comments only; nothing to undo. To restore the previous (absent)
-- comments:
--
--   COMMENT ON INDEX patient.idx_patients_mobile_prefix IS NULL;
--   COMMENT ON INDEX patient.idx_patients_uhid_prefix IS NULL;
--   COMMENT ON INDEX patient.idx_identifiers_value_prefix IS NULL;
--   COMMENT ON INDEX patient.idx_patients_name_trgm IS NULL;
-- ─────────────────────────────────────────────────────────────────────────────
