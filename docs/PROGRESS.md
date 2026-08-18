# PROGRESS

> Claude Code updates this file at the end of **every** working session. Newest entry on top.
> Format: date · phase · what was built · what was tested · what is stubbed · open questions · next step.

## Current state

| Field | Value |
|---|---|
| Current phase | **Phase 0 — in progress (foundation rails complete, services not yet built)** |
| Repo status | monorepo scaffolded; `packages/contracts` and `packages/db` complete and verified |
| Last green CI | CI not yet wired (`.github/workflows` pending) |
| Modules complete | 0 / 177 — Phase 0 builds platform *rails*, not modules |
| Blocking questions | none blocking; see `docs/DECISIONS.md` → "Open" |
| Project path | `~/Desktop/Test/HMS/vims-hms-build-kit` (renamed — see D-19) |

### Exit-gate status (`docs/prompts/phase-00-foundation.md`)

| # | Gate | Status |
|---|---|---|
| 1 | `pnpm lint && typecheck && test && test:e2e && build` green in CI | ⬜ partial — `contracts` typechecks and 85 tests pass; other packages have no source yet |
| 2 | `docker compose up` → working login in < 10 min from a clean clone | ⬜ infra up in ~90 s; no login yet (API/web not built) |
| 3 | Log in as each of 8 roles, each seeing a correct empty workspace | ⬜ not reachable yet |
| 4 | Tenant-isolation + permission-matrix tests pass, **and breaking a policy makes them fail** | 🟩 **done at SQL level and proven both ways** — see below |
| 5 | Audit log shows login, role change, break-glass read, hash chain intact | 🟨 chain sealer + verifier built and proven; no login/role-change events yet |
| 6 | Token printed to ESC/POS emulator; PDF rendered with letterhead | ⬜ not started |
| 7 | Lighthouse ≥ 90 on `/login` and dashboard; PWA installable; offline shell | ⬜ not started |
| 8 | `docs/PROGRESS.md` lists what exists, what is stubbed, every open question | 🟩 this file |

---

## Session log

### 2026-08-17 · Phase 0 · Foundation rails: contracts + database

**Built**

*Monorepo and tooling*
- pnpm workspaces + Turborepo with the exact layout from `docs/01 §11`
  (`apps/{web,tv-kiosk}`, `services/{api,realtime,worker,integration-hub}`,
  `packages/{contracts,ui,db,print-templates,i18n,flags,testing}`, `infra/`, `.github/`).
- TypeScript 5.9.3 strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` as `CLAUDE.md` §2 requires.
- ESLint flat config carrying the rules that are *not* stylistic: no `any`, no
  `console.log`, module-boundary `no-restricted-imports` (`docs/01 §4`), a ban on
  `SET`/`SET SESSION app.*` (would leak tenancy across a PgBouncer-pooled
  connection, `docs/07 §4`), a ban on `OFFSET` in repositories, and a hex-literal
  ban outside `packages/ui/src/tokens` (`docs/06 §11`).
- Prettier, commitlint with the `docs`-mandated scope vocabulary, husky, lint-staged.

*Local infrastructure* — `pnpm infra:up`, ~90 s from cold
- **PostgreSQL 17.7** built from our own Dockerfile so dev, CI and on-prem share one
  image. All 11 extensions from `docs/03` install and are verified:
  pgcrypto, citext, pg_trgm, btree_gist, ltree, uuid-ossp, pg_stat_statements,
  pgvector 0.8.6, pg_partman 5.5.0, pg_cron 1.6, pgaudit 17.1.
- Redis 7.4 with `maxmemory-policy noeviction` — BullMQ job data and the
  refresh-token denylist must never be silently evicted.
- MinIO with a **private, versioned** bucket (`docs/04 §4`: no public objects).
- Mailpit for invitation/OTP mail; Orthanc behind an `imaging` profile for Phase 3.
- Four least-privilege roles: `hms_migrator` (owns schema, may DDL),
  `hms_app` (**NOBYPASSRLS**, no DDL), `hms_readonly`, `hms_retention`.

*`packages/contracts`* — 85 tests passing
- `Money`: bigint minor units, no float anywhere, Indian lakh/crore grouping,
  `allocate`/`splitEvenly` that provably never create or destroy a paisa,
  explicit rounding modes with the adjustment returned separately so a bill can
  show it as a line (`docs/06 §5.2 #24`). Property-based tests per `docs/09 §2`.
- `IdGen`/`Clock` as injected interfaces (`docs/09 §2` forbids ambient randomness
  and time in unit tests); UUIDv7 with timestamp extraction for tamper checks.
- RFC 9457 problem+json with the `docs/06 §1.1 heuristic 9` extensions —
  `clinicalImpact`, `nextAction`, `reference` — because `{"title":"Bad Request"}`
  is useless to a nurse at a bedside. `TENANT_MISMATCH` deliberately maps to 404,
  not 403 (`docs/09 §3.1`: do not leak existence).
- Signed, tenant-scoped cursor pagination; `OFFSET` has no representation.
- **Permission catalogue: 220 keys** across the 16 Phase-0 modules, each with data
  class, risk, and flags for sensitive-grant / reason-required / step-up /
  second-person / PHI-read / clinical-safety-exempt. Import-time assertions reject
  duplicates and malformed keys. A test asserts no permission exists that could
  update or delete an audit row (`EN-024 §12`: "the permission does not exist").
- **All 64 system role templates** from `docs/05`, validated at import against the
  catalogue and against `docs/05` row numbers 1–64. Tests assert residents hold no
  override or break-glass key, clinicians *do* hold break-glass, the auditor holds
  nothing mutating, the lab technician cannot validate, and non-care roles mask
  identifiers.
- ABAC condition model (own-patient, care-team, ward, amount limit with
  `whichever_is_lower`, time window, second person, data-class masks) plus the
  policy decision/obligation types.
- **Event registry: ~190 domain events** with Zod payload schemas, PHI flags and
  per-event retention. Naming enforced as `<aggregate>.<past-tense-fact>`.
  Tests assert every payload schema rejects a wrong shape (catching a schema
  accidentally left as `z.unknown()`), and that compliance-evidence events outlive
  the 7-day outbox purge.
- Audit contract: action enum, `DEFAULT_AUDIT_FIELD_POLICIES` (secrets excluded
  outright, Aadhaar/ABHA masked, biometric templates never present even masked),
  frozen hash-chain field list, statutory retention floors with the citing regulation.
- Notification contract: five severities with `critical` non-configurably
  overriding quiet hours, dedupe/coalesce forbidden for `critical`, escalation
  rungs, and `findForbiddenExternalPlaceholders()` enforcing the
  content-minimisation rule that keeps a diagnosis off a lock screen.
- Settings registry (46 typed keys with scope, sensitivity, approval and
  dual-control flags) and the EN-040 entitlement model including the full
  degradation ladder and `CLINICAL_SAFETY_EXEMPT_KEYS`.
- Auth and admin DTOs, including the `/login` challenge union that models every
  stop in `docs/05`'s flow (MFA → branch selection → password change → authenticated
  → use-SSO) so the client never has to guess what to render next.

*`packages/db`* — 48 tables, 7 migrations, all applied
- Prisma multi-file schema (`prisma/schema/*.prisma`) covering tenancy
  (group → hospital → branch → unit, registrations, data domains, branch access,
  cross-branch disclosure log, onboarding, residency), identity (users, roles,
  permissions, user_roles with ABAC scope, sessions, devices, auth policy, MFA/OTP
  challenges, login audit, access requests/reviews, SoD rules, impersonation),
  audit (log, chain roots, integrity runs, break-glass, retention policies,
  archives, exports, cases, field policies) and platform (settings + definitions,
  holidays, numbering series + allocations, feature flags, files, idempotency keys,
  outbox, DR drills, downtime windows).
- **Five tables partitioned monthly** — `audit_log`, `outbox_events`, `sessions`,
  `login_audit`, `org_cross_branch_access_log` — via a repeatable post-processing
  script (`scripts/apply-partitioning.mjs`) rather than a hand edit, because the
  base migration gets regenerated and a silently-missing partition would not fail
  any test until the table was 40 M rows deep.
- **RLS on all 48 tables**, generated from the catalogue so a future table cannot
  be forgotten, with `USING` *and* `WITH CHECK` on every tenant-scoped table.
  Default-deny comes from `current_setting(..., true)` returning NULL, i.e. from
  SQL semantics rather than from remembering to write a guard.
- Append-only enforcement on `audit_log` by **both** revoked grants and a
  `BEFORE UPDATE OR DELETE` trigger (`EN-024 §14 AC-5` requires both), with one
  precisely-scoped exception: the chain sealer may stamp `seq`/`prev_hash`/
  `row_hash`/`sealed_at` onto a never-sealed row provided every other column is
  byte-identical.
- Hash chain: `core.audit_row_hash()` (jsonb-canonicalised sha256, frozen field
  list), `core.seal_audit_chain()` (advisory-locked, single-writer per tenant),
  `core.verify_audit_chain()` returning every discrepancy class — seq gap, broken
  linkage, post-seal modification, back-dated insertion.
- Least-privilege grants with each exception stated individually, plus
  `core.v_rls_coverage`, `core.v_grant_coverage`, `core.v_rls_open_policies` and
  `core.v_audit_seal_backlog` as the monitors those guarantees are checked through.
- 22 partial/trigram/covering indexes from `docs/07 §4`, `NULLS NOT DISTINCT`
  uniqueness for the nullable settings-scope tuple, and a `btree_gist` exclusion
  constraint preventing overlapping branch grants.

**Tested**

- `packages/contracts`: 85 tests green — 41 Money (incl. 6 property-based over
  500 runs each), 28 RBAC catalogue/role-template, 16 event registry/envelope.
- `packages/db/src/rls/verify-isolation.sql`: **12 SQL-level isolation cases, all
  passing**, covering `docs/09 §3.1`:
  RLS enabled everywhere · `WITH CHECK` everywhere · only the two global catalogues
  world-readable · `hms_readonly` write-free · audit tables app-immutable ·
  `hms_app` NOBYPASSRLS · no elevated role attributes · audit UPDATE rejected ·
  audit DELETE rejected · sealer seals all pending rows · chain verifies clean.
- **Negative proof done, as gate 4 demands:** replacing `core.branches`'s policy
  with `USING (true)` made the suite fail 2 cases and exit non-zero; restoring it
  returned all cases to green.

**Two real defects the verification caught (neither would have been caught by review)**
1. `core.hospitals`, `core.org_groups` and `core.role_permissions` had received
   `USING (true)` from the generator because their tenant key is `id`, not
   `hospital_id`. Any authenticated session could have read every other tenant's
   legal name, GSTIN, PAN, address and DPO contact, and enumerated their custom
   roles. Fixed with explicit policies (D-17) and now monitored by
   `core.v_rls_open_policies`.
2. `core.verify_audit_chain()` had an OUT parameter colliding with a column name,
   so it raised on every call — the integrity check the whole §65B evidence chain
   depends on had never actually completed. Fixed (D-19 migration).

**Stubbed / not started**
- `services/api` — no source. The interceptor chain (`docs/01 §3` steps 1–10),
  auth, RBAC/ABAC policy service, audit interceptor, outbox writer, numbering,
  settings, flags, licence entitlement, approvals, templates, notifications and
  the EN-017 skeleton are all still to write. **This is the critical next step.**
- `apps/web`, `apps/tv-kiosk`, `packages/ui` — no source. No login screen, so exit
  gates 2, 3 and 7 are not yet reachable.
- `services/worker`, `services/realtime`, `services/integration-hub` — manifests
  only. The chain sealer and partition maintenance exist as SQL functions but have
  no job wiring yet.
- `packages/db` schema is complete for tenancy/identity/audit/platform but **not**
  for `notif_*`, `wf_*`, `tpl_*`, `lic_*`, `print_*`, `bc_*`, `sso_*`, `mdm.*` or
  `integration.*`. Their contracts exist in `packages/contracts`; the tables do not.
- Seeds — none. No demo group/hospitals/branches, no 64 seeded roles, no per-role
  dev users. `seed:minimal|demo|hospital|volume` are declared but unimplemented.
- CI (`.github/workflows/ci.yml`), Helm chart, pgBackRest config, restore-drill
  script, OTel/Grafana compose, alert rules.
- `packages/testing` Testcontainers harness and the synthetic Indian patient
  generator — needed before the API integration suite can exist.

**Open questions raised**
- None blocking. Every `§16 Open Question` encountered so far has been answered
  with the spec's stated default and recorded in `docs/DECISIONS.md`.
- Worth confirming before Phase 1: `org.uhid_group_unique` defaults to **true**
  (group-unique UHID with a branch prefix, `EN-041 §3.4.1`). That choice is made
  once per deployment and cannot be changed afterwards, so it should be confirmed
  in writing rather than inherited from a default.

**Next step**
1. `packages/testing` — Testcontainers harness, so every subsequent piece is
   testable as it lands.
2. `services/api` — the interceptor chain first (request context → auth → tenant
   guard → rate limit → Zod → policy → idempotency → transaction with
   `SET LOCAL` → audit → outbox → problem+json), then auth, then the admin CRUD.
   Nothing else in Phase 0 can be verified until a request can complete.
3. Seeds: demo group → 2 hospitals → 3 branches → 64 roles → one user per role.
4. `packages/ui` tokens + `apps/web` `/login` and role-routed shell.
5. Wire CI, then run the full exit gate.

### YYYY-MM-DD · Phase 0 · (template — delete when the next real entry is written)
- **Built:** …
- **Tested:** … (list the tests, not "tests written")
- **Stubbed / deferred:** … (with the reason and where it is tracked)
- **Open questions raised:** …
- **Next step:** …
