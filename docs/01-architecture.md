# 01 — System Architecture

## 1. The shape of the system

```
                                   ┌───────────────────────────────────────────┐
   Browsers / Tablets / Phones     │  Cloudflare (cloud)  |  Nginx (on-prem)   │
   TVs / Kiosks / Scanners  ─────▶ │  WAF · DDoS · TLS · CDN · rate limit      │
                                   └──────────────────┬────────────────────────┘
                                                      │
        ┌─────────────────────────────────────────────┼──────────────────────────────────┐
        │                                             │                                  │
┌───────▼────────┐   ┌────────────────┐   ┌───────────▼─────────┐   ┌────────────────────▼┐
│ apps/web       │   │ apps/tv-kiosk  │   │ services/api        │   │ services/realtime    │
│ Next.js 15 PWA │   │ Next.js kiosk  │   │ NestJS (Fastify)    │   │ Socket.IO            │
│ RSC + Client   │──▶│ display client │   │ modular monolith    │◀─▶│ presence, queues,    │
│ role workspaces│   │                │   │ /api/v1  OpenAPI3.1 │   │ alerts, bed board    │
└───────┬────────┘   └────────────────┘   └───────────┬─────────┘   └────────┬─────────────┘
        │                                             │                      │
        │                        ┌────────────────────┼──────────────────────┼──────────────┐
        │                        │                    │                      │              │
        │              ┌─────────▼────────┐ ┌─────────▼────────┐  ┌──────────▼───────┐ ┌────▼──────────┐
        │              │ services/worker  │ │ services/        │  │ services/ai      │ │ print-agent   │
        │              │ BullMQ jobs:     │ │ integration-hub  │  │ (Phase 12)       │ │ (on-site,     │
        │              │ PDF, SMS, bills, │ │ HL7 MLLP, ASTM,  │  │ Claude + pgvector│ │  LAN printers)│
        │              │ outbox relay,    │ │ FHIR, ABDM, PACS,│  └──────────────────┘ └───────────────┘
        │              │ reports, cron    │ │ devices, payers  │
        │              └─────────┬────────┘ └─────────┬────────┘
        │                        │                    │
   ┌────▼────────────────────────▼────────────────────▼─────────────────────────────────────┐
   │  PostgreSQL 17 (primary + replicas, PgBouncer)  ·  Redis 7  ·  S3/MinIO  ·  Orthanc PACS │
   └──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Deployment profiles** (same code, different composition — see `10-deployment-devops.md`):
- **Cloud SaaS:** Vercel/containers for web, ECS/EKS or Azure Container Apps for services, RDS/Neon Postgres,
  ElastiCache/Upstash Redis, S3, Cloudflare in front.
- **On-prem / hybrid:** single `docker compose` stack or a small K8s cluster inside the hospital, MinIO for objects,
  local Orthanc, optional outbound-only internet for SMS/WhatsApp/ABDM/payments; a **cloud replica** for DR and
  patient portal can be enabled (hybrid).
- **Edge cases:** hospitals with poor connectivity run everything on-prem; the PWA works on the LAN.

## 2. Why a modular monolith (and where we break it out)

A hospital transaction touches many domains at once (an admission touches patient, bed, billing, insurance,
pharmacy, diet, nursing). Distributed transactions across microservices at go-live would be a correctness and
staffing disaster for a small team. So:

- **One deployable API** (`services/api`) with **hard module boundaries**. A module may only touch its own tables;
  everything else goes through another module's **service interface** or a **domain event**. This is enforced by
  ESLint import rules (`no-restricted-imports` across module folders) and a boundary test in CI.
- **Separate processes only where the runtime demands it**: long-lived WebSockets (`realtime`), CPU/IO-heavy async
  work (`worker`), TCP/MLLP + vendor SDK listeners (`integration-hub`), GPU/LLM latency (`ai`), and the on-site
  `print-agent` (needs LAN access to printers).
- **Extraction path:** each module already has its own schema, service interface and events, so promoting a hot module
  (e.g. LIS or billing) into its own deployable later is mechanical, not a rewrite. Do it only when metrics demand it.

## 3. Request lifecycle (every API call)

```
HTTP → Fastify → [1] TraceId + request log (no PHI)
                → [2] Auth guard        (JWT verify, session valid, device trusted)
                → [3] Tenant guard      (hospital_id/branch_id from token; reject cross-tenant)
                → [4] Rate limit        (per user, per IP, per endpoint class)
                → [5] Zod DTO validation (shared schema from packages/contracts)
                → [6] Policy check      (RBAC permission + ABAC conditions; deny by default)
                → [7] Idempotency check (money/order endpoints)
                → [8] TX begin → SET LOCAL app.hospital_id / app.user_id / app.role   ← RLS activated
                    → Service (business rules, invariants)
                        → Repository (Prisma/Kysely)
                        → audit_log insert
                        → outbox_events insert
                    → TX commit
                → [9] Response (typed, problem+json on error)
                → [10] Outbox relay (worker) → Redis Stream → realtime push / jobs / integrations
```

Rule: **nothing bypasses steps 3, 6, 8.** Reports and analytics use the same guards against read replicas.

## 4. Module boundary contract

Every module directory declares, in `module.contract.ts`:
- `tables`: the schemas/tables it owns (nobody else may query them),
- `publishes`: domain events it emits,
- `subscribes`: events it consumes,
- `provides`: the typed service interface other modules may call in-process,
- `permissions`: RBAC keys it registers.

CI fails if a module imports another module's repository, or queries a table it does not own.

## 5. Event catalogue (naming: `<aggregate>.<past-tense-fact>`)

Core examples (each module spec §7 lists its own):
`patient.registered` · `patient.merged` · `appointment.booked/cancelled` · `queue.token.issued/called` ·
`encounter.started/closed` · `vitals.recorded` · `vitals.abnormal` · `rx.created/dispensed` ·
`order.placed/collected/resulted/validated` · `lab.result.critical` · `rad.report.finalized` ·
`admission.created` · `bed.assigned/released/blocked` · `nursing.med.administered/held` ·
`ot.scheduled/started/completed` · `implant.used` · `blood.issued/transfused` ·
`charge.posted` · `bill.finalized` · `payment.received` · `refund.issued` ·
`preauth.submitted/approved` · `claim.submitted/settled/denied` ·
`stock.issued/received/adjusted` · `expiry.due` · `asset.breakdown` ·
`discharge.initiated/completed` · `mlc.registered` · `trauma.activation` · `code.blue.activated`.

Consumers are idempotent (event id dedupe), retryable, and never assume ordering across aggregates.

## 6. Real-time architecture

- Socket.IO rooms: `h:<hospital>:b:<branch>:queue:<doctor>`, `…:ward:<ward>`, `…:bedboard`, `…:user:<userId>`,
  `…:ot`, `…:er`, `…:display:<screen>`.
- Redis adapter for horizontal scaling; sticky sessions not required (Redis pub/sub).
- **Backpressure rules:** boards push diffs, not full snapshots; max 1 push/sec per room (coalesced);
  clients reconcile with a REST snapshot on reconnect (`?since=<cursor>`).
- Critical alerts (critical lab value, code blue, deteriorating NEWS2, panic button) go through **EN-037** with
  must-acknowledge + escalation timers, and are also delivered by push/SMS so they survive a closed browser.

## 7. Offline & degraded-mode strategy

| Scenario | Behaviour |
|---|---|
| Browser offline (nurse tablet in a lift) | PWA serves cached shell + reference data; vitals/MAR/notes queue in IndexedDB with `client_id`; sync on reconnect; server rejects duplicates by `client_id`; conflicts surfaced for human resolution (never silent overwrite). |
| Internet down, LAN up (on-prem) | Everything works except SMS/WhatsApp/ABDM/payments; those queue with retry and the UI shows a "pending external" badge. |
| Database failover | PgBouncer + app retry with exponential backoff; writes fail loudly (never silently dropped); read-only mode banner. |
| Printer offline | Job stays in the print queue with retry + "print elsewhere" option. |
| Lab analyzer offline | Manual result entry path always available; interface backlog replays on recovery. |
| **Total system outage** | Documented **downtime protocol**: pre-printed forms, offline registration numbering block reserved per branch, and a **catch-up entry** workflow with back-dated timestamps that are flagged and audited. |

## 8. Multi-tenancy & multi-branch (see EN-041)

- Row-level tenancy in one database is the default (simplest to operate, cheapest, easiest cross-branch MPI).
- **Isolation levers available per customer:** dedicated schema, dedicated database, or fully dedicated stack
  (enterprise/on-prem). Application code is identical; only the connection resolver changes.
- Group hierarchy: `group → hospital → branch → unit/ward`. Shared: patient master, clinical record (consent-gated
  cross-branch view), masters. Branch-scoped: billing, inventory, HR, queues, cash, numbering.

## 9. Security architecture summary (full detail in `04-security-compliance.md`)

Defence in depth: edge WAF → mTLS/TLS 1.3 → auth → tenant guard → RBAC/ABAC → RLS → column-level encryption for
identifiers (Aadhaar last-4 only, ABHA tokens encrypted with `pgcrypto` + KMS-held keys) → audit → immutable backups.
Secrets in Vault/SSM; no PHI in logs, URLs, or analytics events; PHI egress to AI providers is opt-in and redacted.

## 10. Performance architecture summary (full detail in `07-performance-scalability.md`)

Server components for first paint; TanStack Query for interactivity; cursor pagination; Redis caching of masters;
materialised read models for dashboards; partitioned high-write tables; PgBouncer; read replicas for reports;
job queues for anything > 300 ms that the user does not need synchronously (PDF, SMS, claim packs, report exports).

## 11. Directory layout

```
vims-hms/
├─ apps/
│  ├─ web/                 Next.js 15 PWA (all staff + patient workspaces, role-routed)
│  ├─ tv-kiosk/            token boards, ward boards, kiosk self-service
│  └─ mobile/              (Phase 13) Expo React Native: doctor, nurse, patient, staff
├─ services/
│  ├─ api/                 NestJS modular monolith  (src/modules/<domain>/<module>/)
│  ├─ realtime/            Socket.IO gateway
│  ├─ worker/              BullMQ processors + cron
│  ├─ integration-hub/     HL7/ASTM listeners, FHIR, ABDM, payer, device adapters
│  ├─ ai/                  (Phase 12) LLM gateway, RAG, evals
│  └─ print-agent/         small Node agent installed on-site for LAN printers
├─ packages/
│  ├─ contracts/           Zod schemas, DTOs, permission keys, event types (shared FE/BE)
│  ├─ ui/                  design system: tokens, shadcn components, charts, clinical widgets
│  ├─ db/                  Prisma schema, Kysely types, migrations, seeds, RLS SQL
│  ├─ print-templates/     HTML/CSS templates, ZPL/ESC-POS templates
│  ├─ i18n/                locale bundles
│  ├─ flags/               feature flags + licence entitlement client
│  └─ testing/             fixtures, factories, Testcontainers helpers
├─ infra/                  docker-compose, helm, terraform, nginx, backup scripts
├─ docs/                   ← this build kit (specs are the contract)
└─ .github/workflows/      CI/CD
```

## 12. Architectural decision records

Every non-obvious choice gets an ADR in `docs/adr/NNNN-title.md` (context, options, decision, consequences).
Seed ADRs: 0001 modular monolith · 0002 PostgreSQL over Supabase-as-platform · 0003 RLS tenancy ·
0004 outbox events · 0005 PWA before native · 0006 Orthanc for PACS · 0007 rules-CDSS before LLM-CDSS.
