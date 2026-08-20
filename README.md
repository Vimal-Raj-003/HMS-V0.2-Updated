# Vim's HMS — Build Kit

**What this is:** everything Claude Code needs to build **Vim's HMS** — an enterprise, multi-tenant,
cloud + on-prem Hospital Management System — from an empty folder to a production system, in phases you control.

**Who it is for:** VIMS ENTERPRISE (Vimal) building the product with Claude Code, targeting Indian hospitals of
50–2000+ beds (trauma & orthopaedic centres first), architected to expand to UAE/Qatar/Africa/SEA.

---

## Start here (5 minutes)

1. Create an empty repo. Copy the contents of this kit into it (`CLAUDE.md` at the root, `docs/` beside it).
2. Read `docs/prompts/README-how-to-use-these-prompts.md` — it explains the loop.
3. Open Claude Code in that repo and paste the whole of `docs/prompts/phase-00-foundation.md`.
4. Answer its questions, run the exit gate at the bottom of the prompt, then move to Phase 1.

Do not skip Phase 0. Everything else inherits its tenancy, auth, audit and design rails.

---

## What is in the kit

| Path                                    | What it is                                                                                                                                                                              | When you read it                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `CLAUDE.md`                             | **The master system prompt.** Always in Claude Code's context. Product definition, locked stack, architecture principles, coding standards, build order, Definition of Done.            | Every session, automatically                   |
| `docs/01-architecture.md`               | System shape, request lifecycle, module boundaries, events, real-time, offline, tenancy                                                                                                 | Phase 0, and whenever a design question arises |
| `docs/02-tech-stack-decision.md`        | Every technology choice with the reasoning — including **why PostgreSQL 17 and not Supabase-as-platform**, and what to use instead                                                      | Before arguing about the stack                 |
| `docs/03-database-conventions.md`       | Schemas, table rules, RLS, numbering, audit, outbox, partitioning, migrations, performance rules                                                                                        | Every time a table is created                  |
| `docs/04-security-compliance.md`        | Regulatory map (DPDP Rules 2025, ABDM, NABH, NABL, AERB, PC-PNDT, NDPS, BMW, GST, CERT-In…), security controls, **clinical safety engineering**, per-module checklist                   | Every module                                   |
| `docs/05-rbac-roles-and-logins.md`      | 64 role templates, login model for every user type, permission naming, segregation of duties                                                                                            | Phase 0 and any auth work                      |
| `docs/06-ui-ux-design-system.md`        | Both themes with real tokens, layout system, 44 clinical components, keyboard/barcode standards, accessibility, i18n, screen archetypes                                                 | Any UI work                                    |
| `docs/07-performance-scalability.md`    | Workload model for 2000 beds, performance budgets, frontend/backend playbooks, scaling plan, load tests, SLOs                                                                           | Any performance decision                       |
| `docs/08-integration-catalogue.md`      | ~75 external integrations with protocol, failure mode, retry, fallback, owner module, credentials needed                                                                                | Any integration work                           |
| `docs/09-quality-gates-and-testing.md`  | Test pyramid, 32 e2e golden journeys, clinical safety suite, data-integrity invariants, CI stages, release process                                                                      | Every phase's exit gate                        |
| `docs/10-deployment-devops.md`          | Environments, cloud & on-prem topologies, sizing tables by bed count, CI/CD, backups, DR, on-prem runbook, support SLAs                                                                 | Go-live planning                               |
| `docs/11-market-analysis.md`            | Indian HMS market 2026, competitor deep-dive on your five brochures, differentiation bets, ROI model, pricing & packaging, GTM, risks                                                   | Commercial decisions                           |
| `docs/12-module-index.md`               | **The module registry** — 177 modules with IDs, phases, priorities, origin                                                                                                              | Constantly                                     |
| `docs/13-data-migration-and-golive.md`  | Migration methodology, cutover timeline, training plan, readiness checklist, hypercare                                                                                                  | Before each hospital go-live                   |
| `docs/modules/**`                       | **177 module specifications**, one file each, 16 sections: workflows, data model, rules, APIs, events, screens, integrations, reports, permissions, acceptance criteria, open questions | Whenever building that module                  |
| `docs/prompts/phase-00…13`              | **14 paste-ready build prompts.** One phase per Claude Code session.                                                                                                                    | The main loop                                  |
| `docs/templates/`                       | Module spec template, UAT script template                                                                                                                                               | Adding a module                                |
| `docs/adr/`                             | Architecture decision records                                                                                                                                                           | When changing a locked decision                |
| `docs/PROGRESS.md`, `docs/DECISIONS.md` | Living state of the build — Claude Code updates these every session                                                                                                                     | Every session                                  |

---

## The shape of what you are building

- **177 modules** across 8 domains: OPD Clinical (40) · Trauma & Ortho (11) · Inpatient (25) ·
  Non-Clinical/ERP (35) · Enablers & Integrations (42) · Revenue Cycle (8) · Patient Engagement (8) · AI (8).
  This extends your 151-module master sheet and the 86-module FAMI CARE proposal — the cross-walk is in
  `docs/11-market-analysis.md` §9.
- **Stack:** Next.js 15 PWA + NestJS 11 (modular monolith) + **PostgreSQL 17** + Redis + S3/MinIO + Orthanc PACS,
  deployable to cloud _or_ inside the hospital. TypeScript everywhere, one contracts package shared by both ends.
- **64 login roles**, one login screen, role-aware workspaces, RBAC + ABAC + Postgres row-level security.
- **India-first compliance built in**, global-ready by configuration.
- **PWA first** (desktop, laptop, tablet, phone, TV, kiosk), native React Native apps in Phase 13.

## The rules that keep it fast and safe

Multi-layer by construction (UI → API → service → repository → SQL). Every list paginated and indexed. Dashboards
read from materialised views, never live joins. Heavy work goes to queues. Real-time pushes diffs, not snapshots.
Clinical hard-stops that configuration can never disable. Every mutation audited. Nothing clinical or financial is
ever hard-deleted. Every phase ends with a gate you can verify yourself.

## Where your answers are still needed

Each module spec ends with **§16 Open Questions for the Hospital**. The commercially significant ones to settle
early: the drug-knowledge-base licence (CIMS / First Databank / in-house) in `EN-029`, the SMS/WhatsApp and payment
gateway vendors, ABDM sandbox credentials and the STQC audit slot, whether finance runs as a full GL or exports to
Tally, and the audit-log retention decision flagged in `docs/07` §1.3.

---

_Prepared for VIMS ENTERPRISE. Sources analysed: the 151-module master sheet, the ₹343.75L / 2713 man-day FAMI CARE
costed proposal, and the Aosta BackBone, MocDoc, SMART HMIS, SmartHospital India and PCS Prodoc brochures, plus
2026 market and regulatory research._
