# PHASE 0 — FOUNDATION

You are building **Vim's HMS** from scratch. This is Phase 0. Nothing exists yet.

## Before you write any code

Read, in this order, and tell me in three sentences what you understood:
`CLAUDE.md` → `docs/01-architecture.md` → `docs/02-tech-stack-decision.md` → `docs/03-database-conventions.md` →
`docs/04-security-compliance.md` → `docs/05-rbac-roles-and-logins.md` → `docs/06-ui-ux-design-system.md` →
`docs/07-performance-scalability.md` → `docs/09-quality-gates-and-testing.md` → `docs/10-deployment-devops.md` →
`docs/12-module-index.md`, plus the specs for the modules built in this phase:
`docs/modules/05-enablers/EN-007`, `EN-024`, `EN-027`, `EN-037`, `EN-038`, `EN-039`, `EN-040`, `EN-041`,
`EN-005`, `EN-013`, `EN-022`, `EN-025`, `EN-026`, `EN-032`, `EN-017`.

Then produce a **written plan** (files to create, order, risks) and wait for my "go" before implementing.

## Goal of this phase

A running, deployable, empty-but-correct platform: a person can log in, be recognised as a role in a hospital and
branch, see an empty role workspace, and **cannot see another tenant's data — proven by a test**. Everything built
after this inherits these rails.

## Deliverables

### 0.1 Monorepo & tooling

- pnpm workspaces + Turborepo; TypeScript 5 strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- Layout exactly as `docs/01-architecture.md` §11: `apps/web`, `apps/tv-kiosk`, `services/api`, `services/realtime`,
  `services/worker`, `services/integration-hub`, `packages/{contracts,ui,db,print-templates,i18n,flags,testing}`,
  `infra/`, `.github/workflows/`.
- ESLint (incl. **module-boundary rules**), Prettier, commitlint (conventional commits), husky pre-commit
  (lint-staged + typecheck on changed packages), `.editorconfig`, `.nvmrc`.
- `docker compose` for local dev: Postgres 17, Redis 7, MinIO, Mailpit, Orthanc (stub for later phases).
- Root scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `test:e2e`, `db:migrate`, `db:seed`, `seed:hospital`.

### 0.2 Database foundation (`packages/db`)

Implement `docs/03-database-conventions.md` literally:

- Schemas `core`, `mdm`; extensions `pgcrypto`, `citext`, `pg_trgm`, `btree_gist`, `pg_stat_statements`, `pg_cron`,
  `pg_partman` (`pgvector` created but unused until Phase 12).
- Tables: `core.hospitals`, `core.branches`, `core.users`, `core.roles`, `core.permissions`, `core.role_permissions`,
  `core.user_roles` (with branch + department scope), `core.sessions`, `core.devices`, `core.numbering_series`,
  `core.settings`, `core.feature_flags`, `core.licences`, `core.audit_log` (partitioned monthly),
  `core.outbox_events` (partitioned monthly), `core.files`, `core.notifications`, `core.approval_matrices`,
  `core.approval_requests`, `core.form_templates`, `core.print_templates`, `core.print_jobs`, `core.printers`,
  `core.idempotency_keys`, `core.dr_drills`.
- **UUIDv7** generator in app code; `hospital_id` on every business table; audit columns; `timestamptz` only.
- **RLS enabled on every business table** with the `current_setting('app.hospital_id')` policy, plus a group-scope
  policy for multi-branch roles (EN-041). Migration role bypasses; app role does not and cannot DDL.
- `pg_partman` partition maintenance job; retention config table.
- Idempotent seeds: one demo group → two hospitals → three branches, the 64 system role templates from
  `docs/05-rbac-roles-and-logins.md`, permission catalogue, numbering series, settings defaults, one user per role
  with a known dev password.

### 0.3 API foundation (`services/api`)

- NestJS 11 on Fastify, `/api/v1`, OpenAPI 3.1 at `/api/docs` (auth-gated in prod).
- Global cross-cutting layer, in this exact order (see `docs/01-architecture.md` §3): request context + traceId →
  auth guard → tenant guard → rate limit → Zod validation pipe → policy guard → idempotency interceptor →
  transaction interceptor that runs `SET LOCAL app.hospital_id/app.user_id/app.role` → audit interceptor →
  outbox writer → RFC 9457 problem+json exception filter.
- **Auth (EN-007/EN-025):** register/invite, login (Argon2id), TOTP enrol & verify, refresh rotation with reuse
  detection, logout/logout-all, password policy engine, lockout, device sessions, break-glass account with alert,
  OIDC/SAML/LDAP adapter interfaces (implement OIDC now, stub the rest), patient OTP login path.
- **RBAC/ABAC (EN-007):** permission registry synced from `packages/contracts`, `can(user, action, resource, ctx)`
  policy service with the ABAC conditions listed in `docs/05`, `@Permission('key')` decorator; **CI fails on any
  route without a permission key**.
- **Audit (EN-024):** hash-chained append-only writes, PHI-read logging hook, `READ_PHI` break-glass path.
- **Outbox + events:** `outbox_events` writer, worker relay to Redis Streams, typed event contracts.
- **Numbering series, settings, feature flags, licence entitlement (EN-040)** services — with the
  `clinical_safety_exempt` list that licence state can never block.
- **Approval engine (EN-038)** and **form/print template engine (EN-039)** as reusable services (no UI yet beyond admin CRUD).
- **Notification centre (EN-037)** core: channels registry, in-app bell, Web Push, email (EN-032 via SMTP/Mailpit),
  severity, must-acknowledge, escalation timers. (SMS/WhatsApp arrive in Phase 1.)
- **Integration hub skeleton (EN-017):** connector registry, adapter interface, config schema, health checks, DLQ,
  message log with PHI redaction. No live connectors yet.
- Health endpoints `/healthz`, `/readyz`, `/metrics` (Prometheus), OTel tracing.

### 0.4 Realtime & worker

- `services/realtime`: Socket.IO + Redis adapter, room naming per `docs/01-architecture.md` §6, auth handshake with
  the same JWT, presence, diff-push helper with 1 push/sec coalescing.
- `services/worker`: BullMQ queues with the five priority classes from `docs/07` §4, outbox relay processor,
  partition maintenance, retention/deletion jobs, backup verification job, cron scheduler, Playwright PDF renderer,
  print dispatcher to `print-agent` (EN-005) with ZPL/ESC-POS support.

### 0.5 Design system & web shell

- `packages/ui`: implement **all tokens** from `docs/06-ui-ux-design-system.md` (both themes + high-contrast) as CSS
  variables + Tailwind v4 theme; install shadcn base components; build the first-wave clinical components:
  `AppShell`, `RoleNav`, `PatientBanner` (placeholder data), `EmptyState`, `SkeletonList`, `ErrorBoundaryCard`,
  `KeyboardHintBar`, `OfflineBadge`, `CriticalAlertToast`, `MoneyInput`, `BarcodeScanInput`, `AuditDiffViewer`,
  `ApprovalTimeline`, `ConfirmWithReasonDialog`.
- `apps/web`: App Router with route groups per role workspace, `/login` (password + TOTP + OTP paths), branch
  picker, role switcher, ⌘K command palette shell, notification bell, theme switcher, i18n (`next-intl`, en-IN + hi
  scaffolded), PWA (`@serwist/next`) with offline shell and background sync scaffolding, TanStack Query provider
  with tenant-scoped cache keys, error/loading conventions.
- `apps/tv-kiosk`: pairing-code flow + a placeholder board that renders from a realtime room (proves the pipe).
- **Admin console screens:** users, roles & permission matrix editor, branches, settings, numbering series,
  feature flags, licence, printers, audit log viewer, notification templates, approval matrices.

### 0.6 Quality, CI/CD, ops

- Vitest + Testcontainers harness; Playwright with a logged-in fixture per role; axe accessibility test helper;
  k6 skeleton; factories in `packages/testing` incl. the synthetic Indian patient generator (names, mobiles, ABHA-
  shaped ids — never real data).
- **Mandatory tests for this phase:** tenant isolation (user of hospital A cannot read hospital B by direct id —
  test at API _and_ SQL level), permission matrix (every route × every role), auth flows incl. refresh-reuse
  detection and lockout, RLS bypass attempt, idempotency replay, audit chain integrity, outbox at-least-once
  delivery, numbering-series gaplessness under concurrency (run 50 parallel invoice number requests).
- GitHub Actions per `docs/10` §5: install → lint → typecheck → unit → integration (Testcontainers) → build →
  Semgrep + gitleaks + `pnpm audit` + Trivy → e2e → migration dry-run → image build & sign.
- `infra/`: docker-compose for on-prem, Helm chart skeleton, `.env.example`, pgBackRest config, `restore-drill.sh`,
  OTel collector + Grafana/Loki/Tempo compose, alert rules from `docs/10` §7.
- `docs/PROGRESS.md` and `docs/DECISIONS.md` created and filled in.

## Constraints

- No business/clinical module in this phase. If you feel the urge to build patient registration, stop — that is Phase 1.
- No `any`. No route without a permission key. No table without RLS. No mutation without audit.
- Every dependency you add beyond `docs/02-tech-stack-decision.md` needs an ADR and my approval.

## Exit gate (all must pass before Phase 1)

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build` green in CI.
2. `docker compose up` from a clean clone gives a working login in under 10 minutes on a fresh machine.
3. I can log in as **each** of: hospital admin, doctor, nurse, receptionist, cashier, pharmacist, lab tech, patient —
   and each sees a different, correct, empty workspace with only their permitted nav items.
4. Tenant-isolation and permission-matrix tests pass, and deliberately breaking a policy makes them fail (prove it).
5. Audit log shows my login, my role change, and a break-glass read, with hash chain intact.
6. A test job printed a token to the ESC/POS emulator and a PDF rendered with a hospital letterhead.
7. Lighthouse ≥ 90 on `/login` and the empty dashboard; PWA installable; works offline (shell).
8. `docs/PROGRESS.md` lists what exists, what is stubbed, and every open question you hit.
