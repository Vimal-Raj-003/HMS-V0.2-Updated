# ADR-0009 — TV/display tables live in `core`, not `engage`

- Status: accepted
- Date: 2026-08-19
- Deciders: platform team (Phase 0)

## Context

`EN-018` (TV output & digital signage) specifies its tables under an `engage`
schema. Phase 0 needed those tables — a queue board is one of the first things a
hospital sees — but `engage` does not exist yet: it is introduced in Phase 10
with the patient-engagement modules.

Creating it early is not free. Three mechanisms in `packages/db` are keyed to the
schema list:

- the RLS policy generator in `..._rls_policies`, which walks a fixed set of
  schemas and would simply not see `engage`;
- the least-privilege grants in `..._grants`;
- the three security views (`core.v_rls_coverage`, `core.v_grant_coverage`,
  `core.v_rls_open_policies`) that `packages/db/src/rls/verify-isolation.sql`
  asserts against — and which `packages/testing`'s database suite now runs on
  every CI build.

A table outside those mechanisms is not merely untidy. It would be **unprotected
and unnoticed**: no policy, no grant, and invisible to the coverage check that
exists precisely to catch a table nobody remembered to protect.

## Decision

The EN-018 tables are created as `core.display_*` in Phase 0. Each file header
records the intended destination and the one-line `ALTER TABLE … SET SCHEMA`
migration path for the Phase 10 move.

## Consequences

- The display tables inherit RLS, grants and coverage checking on the day they
  are created, with no special case.
- `core` carries thirteen tables that will move later. The move is mechanical and
  covered by the same coverage test that would otherwise have been silent.
- When `engage` is introduced in Phase 10, the generator and the three views must
  be extended to cover it **before** anything is moved — otherwise the move
  itself would create the gap this decision avoids.

## Alternatives considered

- **Create `engage` now.** Rejected: the schema would exist for one module while
  the generator, grants and coverage views all had to grow a special case, and a
  half-adopted schema is exactly where a missing policy hides.
- **Defer the tables to Phase 10.** Rejected: `phase-00 §0.5` requires a working
  TV board, and `apps/tv-kiosk` needs somewhere to read from.
