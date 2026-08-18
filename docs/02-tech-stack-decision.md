# 02 — Tech Stack Decision (and the Postgres vs Supabase question)

## 1. The question you asked: "Postgres 16 — or something better?"

**Answer: PostgreSQL 17, self-managed or managed, with plain SQL/Prisma — not Supabase as the platform.**
Postgres 16 is a perfectly safe floor; 17 is the better default in 2026 and 18 is the upgrade you plan for, not the
one you start on.

### Why 17 over 16
| Gain in 17 | Why it matters for an HMS |
|---|---|
| Rewritten vacuum memory management (up to ~20× less memory, faster) | vitals, audit_log, stock_ledger, notifications are extremely high-write; bloat and long vacuums are the classic cause of "the HMS became slow after 8 months" |
| Incremental base backups (`pg_basebackup --incremental`) + faster `pg_upgrade` | 2000-bed hospitals reach multi-TB; nightly fulls stop being viable; shorter maintenance windows |
| Better logical replication (failover slots, `pg_createsubscriber`) | zero/low-downtime major upgrades and cloud↔on-prem hybrid replication |
| `JSON_TABLE`, SQL/JSON constructors | turning HL7/FHIR/device JSON into relational rows without app round-trips |
| `MERGE ... RETURNING`, MERGE on views | idempotent upserts for interface and migration pipelines |
| Planner improvements for `IN (...)` on B-tree, parallel index build for BRIN | worklists and time-series scans |
| Streaming I/O for seq scans | overnight reports and analytics refresh |

### Why not 18 as the starting version
18 is attractive (async I/O, UUIDv7 built-in, virtual generated columns, OAuth in libpq), but for a system that
will run inside hospitals: pick the version your managed provider and your on-prem distro both support with a long
runway, and where every extension you need (`pg_partman`, `pgvector`, `pg_cron`, `pgAudit`, `pgBackRest`) is
packaged and battle-tested. **Start on 17; write an ADR to move to 18 once your provider marks it default and the
extension matrix is green.** Nothing in this kit depends on 17-only syntax except where noted, so 16 remains a
valid fallback if a customer's infrastructure forces it.

### Why not Supabase as the platform (while still supporting it as a *provider*)
Supabase is genuinely good — SmartHospital India's brochure shows how far it goes (RLS multi-tenancy, edge
functions, pg_cron). But Vim's HMS has four requirements Supabase-as-platform cannot satisfy:

1. **On-prem / hybrid deployment.** Many Indian hospitals (and every UAE/Qatar government tender) require the
   database inside their own data centre or region, with the vendor able to hand over a self-contained stack.
2. **Long-lived TCP listeners.** Lab analyzers speak HL7 v2 over **MLLP** and ASTM over **serial/TCP**; DICOM speaks
   its own protocol. These need persistent socket servers on the hospital LAN — not serverless functions.
3. **Heavy, stateful background work.** Nightly room-charge posting for 2000 beds, claim-pack PDF assembly, 20k
   lab results/day interface processing, report generation — these want a real job queue with concurrency control,
   priorities and dead-letter queues (BullMQ), not per-invocation edge functions.
4. **Enterprise operations.** HA with your own failover policy, PITR you control, pgBackRest, pgAudit, connection
   pooling tuned per service, read replicas, and the ability to be audited by a hospital's IT/NABH assessor.

**But nothing is thrown away:** because we depend only on *standard PostgreSQL* + RLS, a pure-cloud tenant can be
hosted on **Supabase, Neon, RDS, Azure Flexible Server or Cloud SQL** by changing `DATABASE_URL`. Supabase Auth,
Storage and Edge Functions are simply not used — auth is ours (hospitals need SSO/LDAP, 2FA policies, break-glass,
device sessions), storage is S3/MinIO behind an adapter, and scheduling is `pg_cron` + BullMQ.

### Why not MySQL / SQL Server / Oracle / MongoDB
- **MySQL:** weaker RLS story, weaker JSON/analytics, no `pgvector`, partial-index and CTE gaps.
- **SQL Server / Oracle:** licensing cost per hospital destroys the price position; on-prem hospitals resist it.
- **MongoDB:** the clinical + billing core is deeply relational and needs hard transactional integrity across
  many tables (a bill, its items, the stock ledger and the audit row must commit together). Document storage where
  it genuinely helps (form payloads, device messages, FHIR resources) is served by `jsonb` inside Postgres.

## 2. Frontend stack

| Decision | Choice | Rationale |
|---|---|---|
| Framework | **Next.js 15 App Router + React 19** | one codebase for staff workspaces, patient portal, kiosk & TV; RSC gives fast first paint on weak hospital PCs; file-based routing maps cleanly to role workspaces; huge hiring pool; deploys to Vercel *or* a container on-prem (`output: 'standalone'`) |
| Why not plain SPA (Vite) | — | worklists benefit from server rendering + streaming; SEO needed for the public website module; but note: **all clinical screens are client-interactive**, RSC is used for shell/list first paint only |
| Styling | **Tailwind v4 + shadcn/ui (Radix)** | accessible primitives, we own the code (no vendor lock, no licence), consistent tokens, fast |
| State/data | **TanStack Query v5** (+ Zustand for local UI state) | caching, background refetch, optimistic updates, offline persistence plugin |
| Tables | TanStack Table + virtualisation | 10k-row worklists without jank |
| Forms | react-hook-form + Zod (shared schemas) | one schema validates client & server; dynamic clinical forms (EN-039) generate from JSON |
| Charts | Recharts (simple) / ECharts (dense dashboards, TV boards) | see the `dataviz` guidance when building any chart |
| PWA | @serwist/next | installable, offline shell, background sync, Web Push |
| i18n | next-intl | en-IN default; hi, ta, te, ml, kn, mr, bn, gu, or, pa + ar (RTL) |
| Native (Phase 13) | Expo React Native | shares `packages/contracts` + design tokens; only where PWA is genuinely insufficient (deep barcode/BLE, background push reliability) |

## 3. Backend stack

| Decision | Choice | Rationale |
|---|---|---|
| Framework | **NestJS 11 on Fastify** | modules/DI map 1:1 to our 177-module boundary discipline; interceptors give us tenant/audit/idempotency cross-cuts in one place; Fastify for throughput; OpenAPI generation built-in |
| Why not Express-only / tRPC-only | — | we must publish a versioned public REST API (payers, corporates, government, third-party apps) with OpenAPI; tRPC is internal-only |
| ORM | **Prisma 6** for schema/migrations/CRUD + **Kysely** for complex SQL | Prisma gives velocity & type safety; Kysely gives typed, hand-tuned SQL for reports, upserts, window functions, CTEs — no ORM fighting |
| Validation | Zod (shared) | single source of truth with the frontend |
| Queue | BullMQ | mature, Redis-based, priorities, repeatable jobs, DLQ |
| Realtime | Socket.IO + Redis adapter | reconnection semantics and rooms out of the box; SSE fallback for TV boards |
| Auth | own service (Argon2id, JWT + rotating refresh, TOTP, WebAuthn) + OIDC/SAML/LDAP adapters | hospitals need AD/SSO, break-glass, device sessions, per-role session policy |
| PDF | Playwright/Chromium in worker | pixel-accurate letterheads, tables, QR; same HTML as the screen |
| Search | Postgres FTS + pg_trgm; Meilisearch adapter optional | avoid a second datastore until proven necessary |
| PACS | **Orthanc** (DICOM archive) + **OHIF** (zero-footprint viewer) | open source, on-prem friendly, well-proven, S3 plugin available |
| Observability | OpenTelemetry + Prometheus/Grafana/Loki/Tempo, Sentry, Better Stack | vendor-neutral; on-prem hospitals can host it themselves |

## 4. Infrastructure choices

| Concern | Cloud | On-prem |
|---|---|---|
| Web | Vercel or container on ECS/EKS/ACA | container behind Nginx |
| API/worker/realtime | ECS/EKS/ACA autoscaled | docker compose or K8s (k3s) |
| DB | RDS/Neon/Azure Flexible (PG17), Multi-AZ | Postgres 17 + streaming replica + pgBackRest |
| Cache/queue | ElastiCache / Upstash | Redis/Valkey container |
| Objects | S3 (+ lifecycle to Glacier) | MinIO with erasure coding |
| Edge | Cloudflare (WAF, DDoS, CDN, DNS) | Nginx + ModSecurity, internal CA |
| Secrets | AWS SSM / Azure KV / Vault | Vault or sops-encrypted env |
| Monitoring | Grafana Cloud / Datadog + Sentry + Better Stack | self-hosted Grafana stack |

Your screenshots' stack (Claude Code → GitHub → Vercel → Supabase → Cloudflare → Sentry/Better Stack/PostHog/Upstash)
maps onto the **cloud profile** almost exactly; the two substitutions are **Supabase → managed Postgres 17 + our own
auth/storage services**, and **Upstash → Redis (Upstash is fine for the cloud profile)**. Keep Sentry, Better Stack,
PostHog (product analytics on *staff* usage only, never PHI), and Cloudflare.

## 5. Third-party services to procure (with the decision the hospital must make)

| Need | Options | Notes |
|---|---|---|
| SMS | MSG91, Kaleyra, Gupshup, Twilio | DLT registration on the hospital's entity; template approval lead time ~1–2 weeks |
| WhatsApp | Meta Cloud API via MSG91/Gupshup/360dialog | template approval; utility vs marketing pricing |
| Payments | Razorpay (primary), PayU/PhonePe/Cashfree; Stripe for intl | UPI QR, links, POS integration, settlement webhooks |
| ABDM | NHA sandbox → STQC/CERT-In audit → production | M1 first; M2/M3 in Phase 11; M4/NHCX with RC-001 |
| Drug knowledge base | CIMS India, First Databank, Medi-Span, or in-house formulary | interaction/allergy data licensing is a **budget line item** — decide early (EN-029 §16) |
| Terminology | ICD-10 (WHO), ICD-11 readiness, SNOMED CT India (NRCeS, free for Indian orgs), LOINC | licence registration required for SNOMED |
| e-Sign | NSDL/eMudhra/Protean ESP | Aadhaar eSign needs an ESP contract |
| Lab middleware | direct HL7/ASTM (ours) or vendor middleware | 30+ analyzer models = plan 2–4 weeks of interface work |

## 6. What we deliberately do **not** use in v1

Kafka (Redis Streams + outbox is sufficient at this scale), Kubernetes for the smallest deployments (compose is
simpler to hand over), GraphQL (REST + OpenAPI is what payers/integrators expect), microservices (see ADR-0001),
a separate BI tool (EN-001 covers it; add Metabase/Superset later if a customer insists), blockchain (no real
requirement that Postgres + hash chains do not solve).
