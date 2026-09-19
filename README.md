# Vim's HMS

An enterprise, multi-tenant Hospital Management System for Indian hospitals of 50–2000+ beds,
built to run in the cloud **or** inside the hospital. Next.js 15 PWA, NestJS 11 modular monolith,
PostgreSQL 17.

Built by VIMS ENTERPRISE. India-first (ABDM, NABH, NABL, GST, DPDP Act 2023), global-ready by
configuration.

> **Status:** Phases 0–8 and 9A are built and tested. Phases 9B–13 are not started.
> See [Build status](#build-status) for what that means in practice, and
> [Known gaps](#known-gaps) for what is deliberately unfinished.

---

## Run it locally

Requires **Node 22.13.0** (`.nvmrc`), **pnpm 9.15.9**, and Docker.

```bash
pnpm install
pnpm infra:up          # Postgres 17 + Redis on :5433 / :6380
pnpm db:migrate:deploy # 70 migrations
pnpm seed:demo         # 2 hospitals, 3 branches, 64 roles, a user per role
pnpm dev               # web :3000, api :4000
```

Then open http://localhost:3000. The seeded demo logins are listed in
[docs/05-rbac-roles-and-logins.md](docs/05-rbac-roles-and-logins.md).

`pnpm infra:nuke` destroys the volumes when you want to start clean.

---

## Repository layout

```
apps/
  web/                Next.js 15 App Router PWA — every staff workspace, the patient landing page
  tv-kiosk/           Waiting-room queue boards and self-service kiosks
services/
  api/                NestJS 11 + Fastify. Modular monolith, 53 modules, one pg.Pool
  worker/             BullMQ jobs — ledger posting, PDFs, SMS/WhatsApp, report runs
  realtime/           Socket.IO over Redis pub/sub — queues, dashboards, critical alerts
  integration-hub/    HL7 v2 (MLLP), ASTM, FHIR R4, ABDM, payment and messaging gateways
packages/
  contracts/          Zod schemas + the RBAC permission catalogue, shared by both ends
  db/                 Prisma schema (101 files), 70 migrations, seeds
  ui/                 Design tokens and the clinical component library
  testing/            Testcontainers harness and the synthetic Indian patient generator
  i18n/  flags/  print-templates/
infra/docker/         Dev and on-prem compose files
docs/                 Specifications — see below
```

### A note on the API module pattern

Modules export `X_CONTROLLERS` / `X_PROVIDERS` arrays that are **spread into `AppModule`**, rather than
declaring their own `@Module`. A nested module builds a second injector and therefore a second
`pg.Pool` against the same database, and then needs a `forwardRef` back through `app.module.ts` to
reach the shared guards. If you add a module, follow the existing pattern.

---

## The rule this codebase is built on

**A rule worth having is a shape in the database, not a check in a service.**

Triggers, CHECK constraints, partial unique indexes, GiST exclusions and `SECURITY DEFINER`
functions — not validation in a controller. A check in a service protects only the callers that
remember to ask, and the caller that forgets is always the batch job written eighteen months later.

Some of what that looks like in practice:

- **Double-entry is a deferred constraint.** A journal is built line by line and is unbalanced until
  the last line lands, so `trg_a_journal_balances` is `DEFERRABLE INITIALLY DEFERRED` and fires at
  COMMIT. An unbalanced journal is refused there and stores nothing.
- **A commitment cannot exceed its budget line.** Refused by a trigger against
  `revised − committed − actual`. Both halves matter: a control that watched only money already
  spent would approve a year's spending in a week, because no purchase order has been paid yet.
- **Clinical documents are append-only.** An "edit" is a new version with a reason. Finalised
  documents are immutable and hash-chained.
- **A derived value has no request field.** A corporate invoice reads its amounts from the bills it
  names; there is no field for the caller to state a different number.
- **Tenancy is row-level security**, not a `WHERE` clause somebody has to remember —
  `hospital_id` / `branch_id` with `tenant_isolation` policies on all 1,264 tables across 15 schemas.

Money is `numeric(14,2)` in the database and a **string** on the wire, because IEEE doubles lose
paise. Totals are summed in SQL, never in JavaScript.

---

## Build status

| Phase | Scope                                                                                | State       |
| ----- | ------------------------------------------------------------------------------------ | ----------- |
| 0     | Monorepo, CI, RLS, auth, RBAC, tenancy, numbering, audit, outbox, design system, PWA | Built       |
| 1     | Patient master, ABHA M1, appointments, queue/token, TV boards, cash counter          | Built       |
| 2     | OPD clinical — vitals, CPOE, e-Rx with rules CDSS, orders, timeline                  | Built       |
| 3     | LIS and RIS/PACS — order → sample → result → validate → report, HL7/ASTM, Orthanc    | Built       |
| 4     | Pharmacy and stores — drug master, dispensing, batches/FEFO, purchase, GRN           | Built       |
| 5     | Billing and RCM — tariff engine, GST, discounts, refunds, packages, pre-auth         | Built       |
| 6     | Emergency, trauma and ortho — ESI/START triage, MLC, fracture registry, implants     | Built       |
| 7     | Inpatient — admission, beds, MAR, NEWS2, handover, OT, ICU, blood bank, CSSD         | Built       |
| 8     | 20+ specialty consoles — dialysis, oncology, labour, ophtha, dental, telemedicine    | Built       |
| 9A    | Finance — general ledger, statements and close, corporate AR, budget control         | Built       |
| 9B–9E | HR/payroll, assets/biomedical, housekeeping/waste, quality/NABH/CRM                  | Not started |
| 10    | Patient, corporate, TPA and referral portals; feedback; kiosk                        | Not started |
| 11    | BI/MIS, report builder, FHIR APIs, ABDM M2/M3, NHCX                                  | Not started |
| 12    | AI — CDSS+, voice notes, coding assist, predictive                                   | Not started |
| 13    | React Native apps                                                                    | Not started |

Phase-by-phase detail, including what was tested and what was deferred, is appended to
[docs/PROGRESS.md](docs/PROGRESS.md) every session. Architectural decisions are numbered in
[docs/DECISIONS.md](docs/DECISIONS.md) (272 entries) and the significant ones expanded in
[docs/adr/](docs/adr/).

---

## Testing

```bash
pnpm typecheck                # tsc --noEmit, strict, across every workspace
pnpm lint                     # eslint --max-warnings=0
pnpm test                     # unit — 147 spec files
pnpm test:integration         # 61 suites against real Postgres via Testcontainers
pnpm test:safety              # the clinical safety suite
pnpm test:e2e                 # 12 Playwright golden journeys
```

Integration tests start a real PostgreSQL container and replay all 70 migrations — they are slow and
they are the ones that catch constraint drift. There is no mocked database anywhere in this
repository, deliberately: the rules live in the database, so a test against a mock tests nothing.

Three further checks run in CI and are worth running before a push:

```bash
pnpm permissions:check        # every @Permission key exists in the catalogue
pnpm tokens:check             # no raw hex colours outside the token files
pnpm charts:check             # charts use the approved palette
```

---

## Known gaps

Stated plainly, because a README that only lists what works is not much use to whoever picks this up
next.

- **k6 load scripts have never been run.** Two scripts exist in [perf/](perf/) and k6 is not
  installed. The performance budgets in [docs/07](docs/07-performance-scalability.md) are therefore
  design targets, not measurements.
- **The emergency red-flag list in the public assistant needs clinical sign-off.** It was written by
  an engineer, it is hard-coded, and it should be configurable master data reviewed by an emergency
  physician before any public deployment.
- **Blocked on credentials, not on code:** ABDM M2/M3 and NHCX need sandbox credentials; the landing
  page assistant needs an LLM key (`ASSISTANT_LLM_BASE_URL` / `ASSISTANT_LLM_API_KEY`) and falls back
  to a scripted flow without one.
- **Capex requests and budget forecasting** are specified in NC-022 but not built — they need the
  approval matrices from 9C and the spend data from 9B/9C respectively. The commitment machinery
  already accepts `source_kind = 'capex_request'`.
- **GRN → realised commitment** is not wired to the event. The route exists and is tested; nothing
  calls it yet.

---

## Specifications

`docs/` is the source of truth. When [CLAUDE.md](CLAUDE.md) and a `docs/` file disagree, the more
specific `docs/` file wins.

| Path                                                                         | What it is                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)                                                       | Master system prompt — product definition, locked stack, standards, Definition of Done        |
| [docs/01-architecture.md](docs/01-architecture.md)                           | Request lifecycle, module boundaries, events, real-time, offline, tenancy                     |
| [docs/02-tech-stack-decision.md](docs/02-tech-stack-decision.md)             | Every technology choice with reasoning, including why PostgreSQL and not Supabase-as-platform |
| [docs/03-database-conventions.md](docs/03-database-conventions.md)           | Schemas, RLS, numbering, audit, outbox, partitioning, migration rules                         |
| [docs/04-security-compliance.md](docs/04-security-compliance.md)             | Regulatory map, security controls, clinical safety engineering, per-module checklist          |
| [docs/05-rbac-roles-and-logins.md](docs/05-rbac-roles-and-logins.md)         | 64 role templates, login model per user type, segregation of duties                           |
| [docs/06-ui-ux-design-system.md](docs/06-ui-ux-design-system.md)             | Both themes with real tokens, 44 clinical components, keyboard/barcode standards, i18n        |
| [docs/07-performance-scalability.md](docs/07-performance-scalability.md)     | Workload model for 2000 beds, budgets, scaling plan, SLOs                                     |
| [docs/08-integration-catalogue.md](docs/08-integration-catalogue.md)         | ~75 external integrations with protocol, failure mode, retry, fallback                        |
| [docs/09-quality-gates-and-testing.md](docs/09-quality-gates-and-testing.md) | Test pyramid, 32 e2e golden journeys, data-integrity invariants, CI stages                    |
| [docs/10-deployment-devops.md](docs/10-deployment-devops.md)                 | Cloud and on-prem topologies, sizing by bed count, backups, DR, runbook                       |
| [docs/11-market-analysis.md](docs/11-market-analysis.md)                     | Market, competitors, differentiation, ROI model, pricing, GTM                                 |
| [docs/12-module-index.md](docs/12-module-index.md)                           | The module registry — 177 modules with IDs, phases, priorities                                |
| [docs/13-data-migration-and-golive.md](docs/13-data-migration-and-golive.md) | Migration methodology, cutover, training, hypercare                                           |
| [docs/modules/](docs/modules/)                                               | 178 module specifications, 16 sections each                                                   |
| [docs/prompts/](docs/prompts/)                                               | 14 phase build prompts — one per session                                                      |
| [docs/PROGRESS.md](docs/PROGRESS.md), [docs/DECISIONS.md](docs/DECISIONS.md) | Living state of the build                                                                     |

Every module spec ends with **§16 Open Questions for the Hospital**. The commercially significant
ones still open: the drug-knowledge-base licence (CIMS / First Databank / in-house) in `EN-029`, the
SMS/WhatsApp and payment gateway vendors, the ABDM sandbox credentials and STQC audit slot, whether
finance runs as a full GL or exports to Tally, and the audit-log retention decision in
[docs/07](docs/07-performance-scalability.md) §1.3.

---

## Contributing

Conventional commits **with a scope** — commitlint rejects a bare `chore:`, so write `chore(repo):`.
Husky runs Prettier and ESLint on staged files.

Before you open a PR: `pnpm lint && pnpm typecheck && pnpm test`, and run the integration suite for
anything that touches the database.

---

_© VIMS ENTERPRISE. Sources analysed during specification: the 151-module master sheet, the
₹343.75L / 2713 man-day FAMI CARE costed proposal, and the Aosta BackBone, MocDoc, SMART HMIS,
SmartHospital India and PCS Prodoc brochures, plus 2026 market and regulatory research._
