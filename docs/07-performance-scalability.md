# 07 — Performance & Scalability

> The reference workload is a **2000-bed multi-branch group** (flagship ~900 beds + 3 branches of 300–400).
> Everything here is a *budget*, not an aspiration: budgets are asserted in CI (`k6`, `size-limit`, EXPLAIN gate)
> and monitored as SLOs in production. If a number below cannot be met, raise an ADR — do not silently miss it.
> Companion docs: `01-architecture.md` (shape), `03-database-conventions.md` (schema rules), `09-quality-gates-and-testing.md`.

---

## 1. Workload model (the numbers everything is sized against)

### 1.1 Daily transaction volumes
| Flow | Volume/day | Peak | Source module |
|---|---|---|---|
| OP visits / registrations | 5,000 | 45 % between 08:30–11:30 → ~900 reg/h | OP-001, EN-006 |
| OP consultations | 5,000 (300 concurrent doctors) | 400 consults/h | OP-002 |
| ER visits | 600 | 80/h evening peak; mass-casualty surge ×5 | OP-006, TR-001 |
| IP beds occupied | 1,500 of 2000 (75 %) | — | IP-001 |
| Admissions / discharges | ~270 each (ALOS 5.5 d) | 60 discharges 10:00–13:00 | IP-001/IP-002 |
| OT cases | 120 | 20/h 08:00–10:00 | IP-006 |
| Lab tests (analytes) | **20,000** from ~6,500 orders | 2,600 results/h 09:00–12:00 | OP-004 |
| Lab analyzers | **30+** bidirectional (HL7 MLLP / ASTM) | bursts of 2,500 msg/min | EN-004 |
| Radiology studies | 1,200 (X-ray 700, USG 250, CT 180, MRI 70) | 25–40 GB DICOM/day | OP-008, EN-008 |
| Prescriptions / Rx lines | 4,500 / 20,000 | — | OP-002, OP-003 |
| MAR administrations | **40,000** | 8,000/h at 08:00 & 20:00 | IP-003 |
| Vitals sets (IP + OPD + ICU flowsheet) | ~21,000 | 3,000/h | IP-003, OP-007, IP-009 |
| Nursing tasks | 30,000 | — | IP-003 |
| Bills / receipts | 8,000 / 9,500 | 1,400 bills/h 11:00–13:00 | OP-005, IP-005, NC-001 |
| Stock ledger movements | 60,000 | — | NC-006, IP-014 |
| Notifications delivered | **50,000** (30k SMS/WhatsApp, 15k push/in-app, 5k email) | 6,000/h | EN-037, EN-009, EN-032 |
| Integration messages | **1.5–2 M** | ≥ 3,000 msg/s aggregate capability | EN-017 |
| Audit rows | ~800,000 | — | EN-024 |
| Outbox events | ~500,000 | 20k/h | core |
| Token calls | 15,000 | — | EN-006, EN-018 |

### 1.2 Concurrency
| Dimension | Peak | Notes |
|---|---|---|
| Authenticated staff sessions | **2,000** (10:00–12:00) | ~55 % idle-but-open (nurses keep tabs open a full shift) |
| Active API requests | **1,800 rps** sustained peak, 3,200 rps burst | 6–10 API pods |
| DB queries | ~6,000 qps peak (85 % reads) | after Redis absorbs masters/read models |
| WebSocket clients | 2,000 staff + **500 board/display sockets** | boards: OPD tokens, ward, OT, lab TAT, command centre, IT ops |
| Socket messages | 400 msg/s steady, 2,000 msg/s at shift change | diffs only, ≤ 1 push/s/room coalesced |
| Concurrent report/export jobs | 50 (month-end) | `bulk` queue, replica-backed |
| Print jobs | 12,000/day, 40/min peak | EN-005 agents per branch |

> **Reconciliation note:** EN-018 §13 caps displays at 200 boards/branch and 400/group. The 500 concurrent
> board sockets modelled here include non-EN-018 realtime surfaces (command-centre wallboards IP-025, IT ops
> EN-017, lab TAT). Treat 400 as the EN-018 device cap and 500 as the realtime-service sizing figure.

### 1.3 Three-year data volumes (Postgres, per major table)
| Table | Rows/day | 3-year rows | Row size | 3-year heap + index | Strategy |
|---|---|---|---|---|---|
| `patient.patients` | ~1,200 new | 1.5 M | 1.5 KB | 2.2 + 1.5 GB | trigram GIN on name/phone/uhid |
| `clinical.encounters` | 5,600 | 6.1 M | 2 KB | 12 + 4 GB | — |
| `clinical.vitals` | 21,000 | 23 M | 400 B | 9 + 6 GB | monthly partitions, 1 y raw device then aggregate |
| `clinical.orders` / `order_items` | 15k / 25k | 16 M / 27 M | 500/300 B | 8 + 12 GB | partial index on open statuses |
| `clinical.prescription_items` | 20,000 | 22 M | 400 B | 9 + 5 GB | — |
| `lab.results` | 35,000 | 38 M | 300 B | 11 + 8 GB | monthly partitions |
| `ip.mar_schedule` / `mar_administrations` | 45k / 40k | 49 M / 44 M | 350/400 B | 17 + 17 GB | monthly partitions |
| `ip.nursing_tasks` | 30,000 | 33 M | 300 B | 10 + 7 GB | monthly partitions |
| `billing.bill_items` | 45,000 | 49 M | 300 B | 15 + 9 GB | — |
| `inventory.stock_ledger` | 60,000 | 66 M | 250 B | 17 + 12 GB | monthly partitions |
| `core.audit_log` | 800,000 | 876 M | 600 B | ~520 GB | **12 months hot partitions**, older → encrypted Parquet on S3 (object-lock), queryable for the full statutory period via export tooling/partition restore, archive SLA ≤ 4 h; **medico-legal / legal-hold rows never leave hot** — see `04` §5 |
| `integration.ihub_messages` | 1.8 M | 2 B | ~600 B metadata | 180 d online ≈ 360 GB | EN-017 retention: metadata 180 d, payloads 30 d in S3 |
| `engage.notifications` | 50,000 | 55 M | 300 B | 16 + 9 GB | 1 y online, monthly partitions |
| `core.outbox_events` | 500,000 | — | 500 B | < 20 GB hot | purged 7 d after publish |

**Totals:** Postgres hot working set **1.2–1.8 TB at 3 years** with audit/message archival in place (3.5–4 TB without — this is why archival is not optional). Object storage: **DICOM ~33 TB / 3 y** (90 d hot NVMe ≈ 2.7 TB → S3-IA → Glacier at 1 y) and **documents/PDFs ~5.5 TB / 3 y**.

---

## 2. Performance budgets

### 2.1 API by endpoint class (server time, excluding network; measured at the API pod)
| Class | Examples | p50 | p95 | p99 |
|---|---|---|---|---|
| **A** Cached reference | drug/ICD/LOINC/service search, tariff lookup, masters | 25 ms | **80 ms** | 150 ms |
| **B** Read model / board | ward board, bed board, OPD queue, worklist page 1, dashboard tile | 40 ms | **150 ms** | 300 ms |
| **C** Record read | encounter, MAR grid, patient timeline page, bill detail, result set | 60 ms | **250 ms** | 500 ms |
| **D** Transactional write | vitals + EWS, place order, MAR administer, charge post, receipt, token call | 80 ms | **300 ms** | 600 ms |
| **E** Compound write | sign Rx (+ hash, outbox, PDF enqueue), finalise bill, admit, discharge init | 150 ms | **500 ms** | 1,000 ms |
| **F** Full-text / fuzzy search | patient search, notes search, document OCR search | 90 ms | **400 ms** | 800 ms |
| **G** Interactive analytics (MV-backed, replica) | MIS dashboard, indicator drill-down | 400 ms | **1.5 s** | 3 s |
| **H** Batch/export | reports, claim packs, migrations | enqueue p95 **< 200 ms**; completion SLO by size (§2.4) |

Module-specific budgets that override the class (already in the specs and binding): CDSS check **< 100 ms/line** (OP-002), barcode scan verify **< 150 ms** (IP-003), ward board **< 200 ms**, MAR grid **< 250 ms**, drug search **< 120 ms**, hub dispatch overhead p95 **< 15 ms**, MLLP ACK **< 200 ms** (EN-017).

> **Refinement of CLAUDE.md §6** ("p95 API < 200 ms"): that figure is the *weighted median of classes A–D*. Classes E–G carry the explicit higher budgets above; nothing else may exceed 200 ms p95 without an ADR.

### 2.2 Frontend (Core Web Vitals + interaction)
| Device | Route | LCP | TTI | INP | CLS |
|---|---|---|---|---|---|
| **Low-end hospital PC** (i3-6100, 4 GB, Chrome, 1366×768, 100 Mbps LAN) | clinical route, cold | ≤ 2.0 s | ≤ 2.5 s | ≤ 200 ms | ≤ 0.05 |
| same, warm (SW-cached shell) | any | ≤ 1.2 s | ≤ 1.5 s | ≤ 150 ms | ≤ 0.02 |
| **Mid-range Android tablet** (Snapdragon 680, 4 GB, WiFi) | nursing/bedside, cold | ≤ 2.5 s | ≤ 3.5 s | ≤ 250 ms | ≤ 0.05 |
| same, warm | nursing/bedside | ≤ 1.5 s | ≤ 2.5 s | ≤ 200 ms | ≤ 0.02 |
| Tablet on 3G-class link (clinic camps, ambulance) | shell + worklist | ≤ 4.0 s | ≤ 5.0 s | ≤ 300 ms | ≤ 0.1 |

> **Refinement of CLAUDE.md §6** ("TTI < 2.5 s on 3G-class tablets"): 2.5 s is the **warm/PWA-cached** target. Cold-start on a genuine 3G link is budgeted at 5 s; the shell is precached at install so real-world starts are warm.

### 2.3 Realtime, devices, auth
| Path | Budget |
|---|---|
| Event → WebSocket client (board, queue, bed) | p95 **< 500 ms**, p99 < 1 s (EN-018) |
| Critical alert (critical lab, code blue, NEWS2 ≥ 7) → clinician device | p95 **< 1 s** in-app, < 5 s push, < 30 s SMS escalation |
| Barcode scan → resolved entity on screen | **≤ 250 ms** cached resolve, ≤ 400 ms with server verify |
| Device vitals (EN-042) → nurse confirm screen | p95 < 2 s |
| Login: submit → role home interactive | p95 **< 2.5 s** cold, < 1.2 s warm; 2FA step adds ≤ 400 ms |
| Session refresh / token rotation | invisible; p95 < 120 ms |

### 2.4 Documents, reports, exports
| Artefact | Budget |
|---|---|
| Rx / receipt / token (A5 or thermal) | enqueue < 100 ms, rendered p95 **< 3 s**, printed < 5 s |
| Lab/radiology report PDF | p95 < 4 s |
| Discharge summary (multi-section, images) | p95 < 8 s |
| Claim pack (30–60 pages, attachments) | p95 < 30 s |
| Standard MIS report (MV-backed, ≤ 100k rows) | p95 **< 10 s** |
| Large export (1 M rows CSV/XLSX) | streamed, first byte < 2 s, ≥ 20,000 rows/s, no server buffering |
| Nightly IP room-charge posting (1,500 beds) | complete < 15 min inside the 01:00–02:00 window |

---

## 3. Frontend performance playbook

**RSC vs client boundary.** Server components: app shell, role nav, page headers, first page of worklists, static reference panels, print/PDF templates, patient-portal content pages. Client components: every interactive clinical surface (consultation editor, Rx grid, MAR, order composer, billing counter, bed board, charts, scanners, sockets). **Never** put a WebSocket, scanner listener, or IndexedDB access in RSC. Server Actions only for simple, non-idempotency-critical mutations (preferences, filters, draft text); everything that needs `Idempotency-Key`, optimistic UI or offline queueing goes through REST + TanStack Query.

**Bundle budgets (brotli, enforced by `size-limit` in CI; fail on +10 % regression):**
| Bucket | Budget |
|---|---|
| Shared shell (framework + shell + tokens + nav) | ≤ 130 KB |
| Any clinical route, first load JS (shell + route) | ≤ 200 KB |
| Any clinical route CSS | ≤ 40 KB |
| Heavy lazy chunks (OHIF viewer, ECharts dashboards, layout builder, report builder, body-map/partograph) | ≤ 400 KB each, `next/dynamic`, never in the initial graph |
| Fonts per locale | ≤ 90 KB (Latin subset) + ≤ 120 KB per Indic script, lazy |

**Code splitting & prefetching.** Split by route group and by role workspace; prefetch the *next likely* route on intent (hover/focus/idle): from the OPD queue prefetch the consultation workspace for the top 3 tokens; from the ward board prefetch the MAR of the nurse's assigned beds; from the billing list prefetch the bill detail of the focused row. Prefetch worklist page 2 when the user passes 60 % scroll. Never prefetch PHI-bearing routes for patients outside the care team.

**Virtualisation thresholds:** lists > 100 rows, tables > 100 rows or > 25 columns, grids > 500 cells (MAR 24 h × 40 drugs virtualises both axes), timeline > 200 items, combobox > 50 options, bed board > 120 tiles. Below the threshold, virtualisation is banned (it costs more than it saves and breaks find-in-page).

**Images & DICOM.** All UI imagery is SVG or `next/image` with explicit dimensions (CLS 0). Patient photos: 96 px WebP thumbnails from a presigned URL, cached 24 h. DICOM never enters the app bundle: thumbnails are server-rendered JPEG (256 px) from Orthanc, full studies open in OHIF in a separate route with its own budget; prior-study prefetch is triggered by the radiologist opening the worklist row, not by list render.

**Avoiding waterfalls.** One composite endpoint per screen (`GET /opd/consult-context/{visitId}` returns banner + vitals + allergies + active meds + last labs) instead of six round trips; parallel `Promise.all` in RSC; no client fetch that depends on another client fetch's result more than one level deep; `Suspense` boundaries per pane so a slow context rail never delays the note editor.

**TanStack Query cache strategy.** Key shape `[tenantId, branchId, resource, params]` — tenant/branch in the key makes cross-tenant leakage structurally impossible.
| Data class | staleTime | gcTime | Refetch | Persisted (IndexedDB) |
|---|---|---|---|---|
| Masters (drugs ~40k, ICD ~14k, tests ~2k, services, tariff) | 24 h | 7 d | on version bump (delta sync) | ✅ versioned |
| Read models (boards, queues, census) | 0 | 5 min | socket-driven invalidation only | ❌ |
| Worklists | 15 s | 5 min | on window focus | last view only |
| Patient chart / timeline | 30 s | 10 min | on focus + on relevant event | ❌ (offline drafts are separate) |
| Financial (bills, receipts, balances) | 0 | 1 min | always fresh; never optimistic | ❌ |
| User prefs / permissions | 5 min | 1 h | on role/branch switch | ✅ |

**Invalidation by event** (socket → query keys): `vitals.recorded|abnormal` → `[…,'vitals',admissionId]`, `[…,'wardBoard',wardId]` · `rx.created|amended` → `[…,'rxQueue',storeId]`, `[…,'chart',patientId]` · `order.placed|cancelled` → `[…,'orders',patientId]`, `[…,'labWorklist']` · `lab.result.validated|critical` → `[…,'results',patientId]`, `[…,'doctorInbox',doctorId]` · `bed.assigned|released|blocked` → `[…,'bedBoard',wardId]`, `[…,'census']` · `charge.posted|bill.finalized|payment.received` → `[…,'bill',billId]`, `[…,'cashierShift']` · `nursing.mar.administered` → `[…,'mar',admissionId]`, `[…,'tasks',nurseId]` · `queue.token.called` → `[…,'queue',doctorId]`. Rule: **invalidate keys, do not push payloads into the cache** for clinical data — the refetch is the authority.

**Service-worker layers (`@serwist/next`).** L1 precache: shell, tokens, fonts (active locale), icons, offline page. L2 stale-while-revalidate: masters delta bundles, static reference content, patient photos. L3 network-first with 3 s timeout: read models and worklists. L4 background sync queue: offline mutations (vitals, MAR, notes, tasks) with `client_id` dedupe. **Never cache**: financial responses, PHI documents, presigned URLs, auth tokens. Cache version is tied to the build; a version bump purges L2/L3 but never the L4 queue.

**Memory on 12-hour shifts.** Budget: ≤ **250 MB** heap steady after 12 h on a nursing-station tab, ≤ 400 MB peak; ≤ 400 MB on a display box (EN-018). Rules: bounded query cache (max 200 entries, LRU eviction), `AbortController` on every fetch, explicit teardown of sockets/timers/`ResizeObserver`/chart instances on unmount, revoke every `createObjectURL`, cap in-memory series (vitals window 72 h, timeline 200 items, message log 500 rows), no unbounded arrays of events or logs, detach heavy routes (OHIF) fully on navigate. **Leak gate in CI:** Playwright run simulating 12 h of ward events at 20× speed with `performance.measureUserAgentSpecificMemory()` sampled hourly — fail if the growth slope exceeds **5 MB/h** or heap crosses 400 MB. Operationally: TV/kiosk devices soft-reload at 04:00; staff tabs open > 12 h get a "refresh recommended" nudge that saves drafts first.

---

## 4. Backend playbook

**N+1 elimination.** Repositories return aggregates, not rows-then-loops. Every list endpoint fetches its children with a single `IN`/`LATERAL`/`JOIN LATERAL` query or a per-request **DataLoader** batching layer (keyed by `(tenant, entity, id)`, flushed on the microtask tick, max batch 500). CI has a `no-n-plus-one` integration test: it counts queries per request via `pg_stat_statements` deltas and fails if a list of 50 items issues more than 6 queries.

**Cursor pagination.** Mandatory above 100k rows; keyset on `(created_at, id)` or the screen's natural sort with `id` as the tiebreaker; `OFFSET` is banned (lint rule on repository code). Page sizes: 25 default, 100 max interactive, 1,000 for machine consumers. Cursors are opaque base64 of the sort tuple, signed, tenant-scoped.

**Index design per access pattern** (every composite starts with `hospital_id`, per `03` §Table rules):
```sql
-- OPD queue: doctor's live list, hot window only
CREATE INDEX idx_visits_queue ON opd.op_visits (hospital_id, branch_id, doctor_id, status, token_no)
  WHERE status IN ('waiting_vitals','waiting_doctor','called','in_consult');
-- Pharmacy Rx queue
CREATE INDEX idx_rx_queue ON clinical.prescriptions (hospital_id, pharmacy_store_id, status, created_at DESC)
  WHERE status IN ('signed','partially_dispensed');
-- MAR due lookup (partitioned parent)
CREATE INDEX idx_mar_due ON ip.mar_schedule (hospital_id, admission_id, scheduled_at)
  INCLUDE (status, drug_id, is_high_alert);
-- Ward task board
CREATE INDEX idx_tasks_ward_due ON ip.nursing_tasks (hospital_id, ward_id, status, due_at)
  WHERE status IN ('due','overdue');
-- Patient search (trigram)
CREATE INDEX idx_patients_name_trgm ON patient.patients USING gin (full_name gin_trgm_ops);
CREATE INDEX idx_patients_phone ON patient.patients (hospital_id, phone);
-- Result retrieval / cumulative view
CREATE INDEX idx_results_patient_test ON lab.results (hospital_id, patient_id, test_id, resulted_at DESC);
-- Integration message triage
CREATE INDEX idx_ihub_retry ON integration.ihub_messages (status, next_attempt_at) WHERE status IN ('queued','failed');
-- Outbox relay (the hottest small index in the system)
CREATE INDEX idx_outbox_unpublished ON core.outbox_events (occurred_at) WHERE published_at IS NULL;
```
Rules: index for the screen's **default sort**, use partial indexes for "open work" states (they stay small forever), `INCLUDE` columns to make the hot query index-only, drop indexes that `pg_stat_user_indexes` shows unused for 60 days.

**Partitioning & retention (`pg_partman`, monthly).** Partitioned: `clinical.vitals`, `lab.results`, `ip.mar_schedule`, `ip.mar_administrations`, `ip.nursing_tasks`, `ip.intake_output`, `core.audit_log`, `core.outbox_events`, `engage.notifications`, `integration.ihub_messages`, `inventory.stock_ledger`, `queue_events`, `clinical.cdss_alert_log`. Premake 3 months ahead; detach-and-archive rather than `DELETE` (a month must be droppable in < 1 s); archived partitions → Parquet on S3 via the retention job; **legal hold** (medico-legal, MLC, open claims) blocks archival at the row level and is checked by the job before detach.

**Materialised views & refresh cadence** (schema `analytics`, always `REFRESH ... CONCURRENTLY`, on the replica where read-only):
| MV | Cadence | Driver |
|---|---|---|
| `mv_ward_board`, `mv_bed_census` | event-driven (Redis) + 60 s reconcile | IP-001/IP-003 |
| `mv_opd_encounter_daily`, `mv_prescribing_indicators` | 15 min | OP-002 |
| `mv_mar_compliance_daily`, `mv_nursing_indicators_daily`, `mv_ews_escalations` | hourly | IP-003 |
| `mv_ihub_hourly` / `mv_ihub_daily` | 5 min / nightly | EN-017 |
| `mv_revenue_daily`, `mv_ar_aging`, `mv_claim_status` | hourly / nightly 02:00 | OP-005, RC-005 |
| `mv_lab_tat`, `mv_display_daily` | 15 min / nightly | OP-004, EN-018 |
Rule from `03`: **never aggregate live transactional tables for a dashboard.** Refresh jobs run in the `bulk` queue with a lock so two refreshes never overlap; a refresh exceeding 2× its median duration alerts.

**Redis cache — keys, TTL, invalidation:**
| Key pattern | Contents | TTL | Invalidated by |
|---|---|---|---|
| `h:{hid}:mdm:drugs:v{ver}` | drug search index slice | 24 h | `mdm.drug.updated` → version bump |
| `h:{hid}:mdm:services:v{ver}` / `:icd:` / `:loinc:` | masters | 24 h | `mdm.*.published` |
| `h:{hid}:b:{bid}:tariff:{payerId}:{serviceId}` | effective-dated price | 6 h | `tariff.revision.activated` (RC-003) |
| `h:{hid}:b:{bid}:stock:{storeId}:{drugId}` | stock on hand | 60 s | `stock.issued|received|adjusted` |
| `h:{hid}:b:{bid}:queue:{doctorId}` | rendered queue state | none (live) | `queue.token.*` |
| `h:{hid}:ward:{wardId}:board` | ward board state | none (live) | `ip.*`, `nursing.task.*` |
| `display:board:{boardId}:state` | rendered board state | none | source events (EN-018) |
| `h:{hid}:patient:{pid}:banner` | banner facts (allergies, alerts, isolation, MLC) | 10 min | `allergy.recorded`, `patient.updated`, `bed.assigned` |
| `h:{hid}:cdss:rules:v{ver}` | compiled CDSS rule set | 12 h | `cdss.ruleset.published` (EN-029) |
| `sess:{sessionId}` / `rl:{scope}:{key}` | session / rate-limit counters | 12 h / window | logout, policy change |
| `idem:{connector}:{key}` | idempotency results | 24 h | — |
Rules: cache keys are **always tenant-prefixed**; version-suffixed keys are replaced, never deleted-then-written (no empty window); a cache miss must never be more expensive than 2× the uncached query (no stampede — use a short lock or `SETNX` single-flight).

**Connection pooling (PgBouncer, transaction mode).**
```
busy_connections   = peak_db_qps × avg_query_seconds
server_pool_size   = ceil( busy_connections / target_utilisation )      target_utilisation = 0.7
client_pool_size   = ceil( server_pool_size / n_app_instances ) × 1.5   (clients may over-subscribe the pooler)
```
Reference sizing: 6,000 qps × 0.004 s = 24 busy → **`default_pool_size = 40`** per (db,user) on the primary; `reserve_pool_size = 10`, `reserve_pool_timeout = 3`; `max_client_conn = 3000`. Postgres `max_connections = 300` primary (20 reserved for superuser/monitoring/replication), 150 per replica. Prisma/Kysely `connection_limit` = 12 per API pod (6 pods), 6 per worker pod, 4 per realtime pod; the read-only pool (`DATABASE_URL_RO`) is separate and sized 25. Transaction mode is safe for us **only because** tenancy is established with `SET LOCAL app.hospital_id` inside the transaction (`03` §RLS) — plain `SET`/`SET SESSION` would leak across pooled connections and is banned by lint. Prepared statements are disabled or named-per-transaction on the pooled path.

**Queue concurrency & priority classes (BullMQ):**
| Class | Prio | Jobs | Concurrency | Window |
|---|---|---|---|---|
| `critical` | 1 | critical result fan-out, code blue, EWS escalation, panic | 20 (dedicated worker pod) | always |
| `interactive` | 2 | user-waiting PDFs, receipts, labels, payment webhook posting, token print | 16 | always |
| `standard` | 3 | SMS/WhatsApp, notifications, outbox relay, HL7 result filing, charge posting | 32 | always |
| `bulk` | 4 | reports, exports, claim packs, MV refresh, nightly room charges, migrations | 4 | off-peak preferred |
| `maintenance` | 5 | retention, archival, partition premake, reindex, cache warm | 2 | 01:00–05:00 |
Per-connector sub-queues with their own concurrency and rate limits (EN-017 default 8) so one slow partner cannot starve others (bulkhead). Jobs are idempotent, carry `attempts`, exponential backoff with jitter, and land in a DLQ — never a silent drop.

**Bulk operations & streaming exports.** Bulk writes use `COPY` (migration/import, EN-036) or `INSERT ... ON CONFLICT` in batches of 1,000 inside one transaction, with `MERGE ... RETURNING` (PG17) for idempotent upserts. Bulk status changes use a single `UPDATE ... FROM (VALUES ...)`. Exports stream: server-side cursor → transform stream → HTTP chunked / S3 multipart; never `SELECT *` into memory; row limit is enforced by streaming, not by rejection. Every bulk job checkpoints so it can resume.

---

## 5. Database performance discipline

**Query review checklist (part of every PR touching a repository):**
1. Does it start with `hospital_id` (and `branch_id` where scoped)? Does an index cover the predicate + sort?
2. Is pagination keyset (no `OFFSET`)? Is the page size bounded?
3. Are the selected columns explicit (no `SELECT *`, no jsonb blobs pulled for a list)?
4. Any function on an indexed column in `WHERE` (kills the index)? Any implicit cast?
5. Any `IN` list that can exceed 1,000 elements? (batch it)
6. Any `ORDER BY` that is not index-backed on a table > 1 M rows?
7. Does it run inside the RLS transaction with `SET LOCAL`? (RLS predicates must be index-friendly)
8. For writes: is it idempotent? Does it write `audit_log` + `outbox_events` in the same transaction? Is the transaction short (< 100 ms, no external calls inside)?
9. Is a partition key present for a partitioned table (else it scans every partition)?

**EXPLAIN gate.** Any new or modified query on a table > 1 M rows must attach `EXPLAIN (ANALYZE, BUFFERS)` output against the seeded performance dataset (3-year volume, generated by `packages/testing`) to the PR. CI fails on: sequential scan on a table > 1 M rows without justification, estimated-vs-actual row misestimate > 10×, `Buffers: read` > 5,000 for an interactive query, execution > the endpoint class budget.

**Autovacuum tuning for hot tables:**
```sql
-- churny status tables: aggressive vacuum, leave room for HOT
ALTER TABLE clinical.orders            SET (autovacuum_vacuum_scale_factor=0.02, autovacuum_vacuum_threshold=5000,
                                           autovacuum_analyze_scale_factor=0.01, autovacuum_vacuum_cost_limit=2000, fillfactor=85);
ALTER TABLE ip.mar_schedule            SET (autovacuum_vacuum_scale_factor=0.02, fillfactor=85);
ALTER TABLE integration.ihub_messages  SET (autovacuum_vacuum_scale_factor=0.01, fillfactor=80);
-- insert-only tables: insert-vacuum only, rely on partition drop
ALTER TABLE core.audit_log             SET (autovacuum_vacuum_insert_scale_factor=0.05, fillfactor=100);
ALTER TABLE clinical.vitals            SET (autovacuum_vacuum_insert_scale_factor=0.05, fillfactor=100);
-- statistics for high-cardinality filters
ALTER TABLE patient.patients      ALTER COLUMN full_name SET STATISTICS 500;
ALTER TABLE clinical.orders       ALTER COLUMN patient_id SET STATISTICS 500;
ALTER TABLE lab.results           ALTER COLUMN accession_no SET STATISTICS 500;
```
**HOT updates:** keep churny status columns **out of every index** (index the *open-state partial* instead) and set `fillfactor` 80–90 on tables whose rows are updated repeatedly (`orders`, `mar_schedule`, `ihub_messages`, `beds`, `queue_tokens`). Verify with `n_tup_hot_upd / n_tup_upd > 0.8` in `pg_stat_user_tables`; below 0.5 is a design bug.

**Bloat control on vitals/audit:** these are append-only — never update them (corrections are new rows per `03`), so bloat comes only from failed inserts and long transactions. Guard with `idle_in_transaction_session_timeout = 30s`, `statement_timeout = 15s` (interactive pool) / `120s` (report pool), and a weekly bloat report from `pgstattuple` on the top 20 tables; > 25 % bloat schedules a `pg_repack` in the maintenance window.

**Archival strategy.** Monthly job: detach partitions older than the online window → verify legal-hold flags → export to Parquet on S3 (partition-per-file, encrypted) → record in `core.archive_manifest` → drop. Restores are `pg_restore` of a single partition into a scratch schema for auditor queries, target **≤ 4 h from request to queryable** (this is the archive SLA that `04` §5 relies on when it says the archive is "queryable for the full statutory period"). Online windows: audit 12 months, ihub messages 180 days (metadata) / 30 days (payloads), notifications 12 months, vitals raw device data 12 months (then aggregated), everything clinical stays online for its legal retention (`04` §1) — clinical documents are never archived out of reach, only their bulky attachments tier to cold storage. **Medico-legal exemption:** rows or partitions flagged medico-legal (MLC/TR-008, forensic, litigation/consumer-court hold, open insurance dispute) are exempt from archival compaction and stay in hot partitions for the full statutory period; the job aborts the detach if any held row remains and raises an alert rather than archiving silently.

---

## 6. Scaling plan

**Stage 1 — vertical (0 → ~800 beds live).** Single primary (start 8 vCPU / 64 GB / NVMe; grow 16/128 → 32/256 → 64/512), `shared_buffers` 25 % RAM, `effective_cache_size` 70 %, `work_mem` 32 MB (report pool 128 MB), `max_wal_size` 16 GB. 3 API pods, 2 workers, 1 realtime, 1 integration-hub. This carries the full 2000-bed workload on modern hardware for reads *if* the read models and caches are in place — vertical is not a stopgap, it is the plan.

**Stage 2 — read replicas.** `DATABASE_URL_RO` for: analytics/MIS (NC-011, EN-001), FHIR bulk export (EN-019), patient portal reads (PE-001), scheduled reports, DIU verification, auditor workspace. Replica lag budget < 5 s; anything that must be read-your-writes stays on the primary (explicitly routed, lint-enforced). 2 replicas at 2000 beds; a third for DR/cloud hybrid.

**Stage 3 — horizontal for stateless tiers.** API pods scale on p95 latency and CPU (HPA: target 65 % CPU, scale-out at p95 > 250 ms for class C sustained 3 min). Realtime scales on socket count (≤ 800 sockets/pod, Redis adapter, no sticky sessions needed). Workers scale per queue class (`critical` never shares a pod with `bulk`). Integration-hub scales per connector group; MLLP/ASTM listeners are pinned to the on-prem gateway and scale by adding listener processes, not replicas of the same port.

**Stage 4 — module extraction** (only when measured): the candidates in order are **LIS** (highest message rate), **integration-hub** (already separate), **billing/RCM** (independent scaling at month-end), **analytics** (already replica-bound). Each already owns its schema, service interface and events (`01` §4), so extraction is mechanical. Do not extract to fix a query — fix the query.

**Stage 5 — multi-region (cloud only).** Primary region carries writes; a secondary region carries read replicas + realtime for latency and DR (RPO ≤ 5 min, RTO ≤ 1 h per `03`). Group hospitals get message affinity in the hub (EN-017 §15). On-prem tenants never leave their data centre.

**Capacity triggers (act when any is true for 3 consecutive days):**
| Metric | Threshold | Action |
|---|---|---|
| DB CPU (1 h avg, peak window) | > 65 % | vertical bump or offload reports to replica |
| Replica lag p95 | > 5 s | add replica / reduce bulk on replica |
| PgBouncer `cl_waiting` | > 0 for > 30 s | raise `default_pool_size`, then vertical |
| API pod CPU p95 / p95 latency class C | > 70 % / > 250 ms | scale out API |
| Redis memory | > 70 % maxmemory | raise memory or shorten TTLs |
| Socket count per realtime pod | > 800 | scale out realtime |
| Queue `standard` wait time p95 | > 30 s | raise concurrency, then add worker pods |
| DLQ depth (EN-017) | > 500 open | partner/mapping issue — triage, not capacity |
| Postgres data size | > 60 % of disk | archival job health check, then grow volume |
| Largest table partition count | > 40 | verify retention/archival is running |

---

## 7. Load, soak, spike & chaos testing (k6, `services/*/loadtests`)

| Scenario | Shape | Target numbers | Thresholds |
|---|---|---|---|
| `opd-morning-rush` | ramping-arrival-rate 08:30→11:30 compressed to 30 min | 900 registrations/h, 1,200 consults/h, 2,500 billing txns/h, 300 concurrent doctors | class A p95 < 80 ms, D p95 < 300 ms, errors < 0.1 %, no 5xx |
| `lab-result-storm` | constant-arrival-rate, 20 min | 30 analyzers → 2,500 HL7 msg/min inbound, 20k results filed | MLLP ACK p95 < 200 ms, 0 message loss, DLQ 0 |
| `nursing-med-round` | 08:00 spike, 60 min | 8,000 MAR administrations with scan verify, 3,000 vitals sets | scan verify p95 < 150 ms, vitals+EWS p95 < 200 ms |
| `bedboard-broadcast` | 500 WS clients, 40 bed/task events/s, 30 min | fan-out to boards + staff | event→client p95 < 500 ms, no dropped socket, server mem flat |
| `billing-counter` | 60 virtual cashiers, 2 h | 1,400 bills/h, mixed tender, idempotent retries | zero duplicate receipts, D p95 < 300 ms |
| `discharge-wave` | 10:00–13:00, 60 discharges | final bill + summary PDF + pharmacy return | E p95 < 500 ms, PDF p95 < 8 s |
| `report-burst` | 50 concurrent MIS reports, month-end | replica-backed | G p95 < 1.5 s, primary CPU unaffected (< 5 % delta) |
| `soak` | 8 h at 40 % of peak | mixed journeys | heap slope < 5 MB/h, connection count flat, replica lag < 5 s, no partition-premake failure |
| `spike` | 0 → 3× peak in 60 s, hold 5 min | post-outage thundering herd, camp day, mass-casualty | no 5xx > 0.5 %, graceful shed via rate limits, recovery < 2 min |
| `chaos/failover` | quarterly drill | kill primary; kill a worker pod mid-job; kill Redis; saturate one connector; cut the WAN for 30 min | DB failover ≤ 60 s with writes failing loudly (never silently), jobs resume, LAN connectors unaffected, queued cloud messages drain in order without duplicates |

**CI performance regression gate.** Every PR runs a 3-minute k6 smoke against the seeded 3-year dataset covering the touched module's list + write endpoints; the nightly pipeline runs `opd-morning-rush` + `soak` (1 h). Gate fails on: any class budget exceeded, p95 regression > 15 % vs the 7-day baseline, bundle budget exceeded, EXPLAIN gate violation, or memory slope > 5 MB/h. Baselines are stored per module and updated only with a written justification.

---

## 8. Monitoring & SLOs

**Golden signals** (OpenTelemetry → Prometheus/Grafana/Tempo/Loki; Sentry for errors; Better Stack for uptime — `02` §3):
- **Latency**: histogram per endpoint class and per module (`route`, `class`, `hospital_id` as low-cardinality label only when tenant count is bounded — otherwise exemplars).
- **Traffic**: rps per class, socket connections, queue enqueue rate, message rate per connector.
- **Errors**: 5xx rate, 4xx-by-reason (auth/validation/policy), job failure rate, DLQ growth, failed-write count (must be zero-tolerance alerted), CDSS unavailability.
- **Saturation**: DB CPU/IO/connections/`cl_waiting`, replica lag, Redis memory/evictions, pod CPU/memory, queue depth and oldest-job age, disk headroom, partition premake status.

**Per-module SLOs (30-day rolling, error budget = 1 − SLO):**
| Module | SLI | SLO |
|---|---|---|
| Auth / EN-007 | login success p95 < 2.5 s, availability | 99.9 % |
| OP-001/EN-006 registration & queue | class B/D budgets met | 99.5 % |
| OP-002 CPOE | consult context < 250 ms, CDSS < 100 ms | 99.5 % |
| OP-004 LIS + EN-004 | result filed within 60 s of analyzer send | 99.9 % |
| IP-003 nursing | MAR grid < 250 ms, scan verify < 150 ms | 99.9 % (patient-safety path) |
| EN-037 critical alerts | delivered + acknowledged path < 1 s in-app / 30 s SMS escalation | **99.99 %** (no error budget for undelivered critical alerts) |
| OP-005/NC-001 billing | write budgets, zero duplicate receipts | 99.9 % |
| EN-018 boards | event→pixel < 500 ms, board uptime | 99.5 % |
| EN-017 hub | dispatch < 15 ms, at-least-once delivery | 99.9 %, 0 message loss |
| EN-011 ABDM | callback handling within partner SLA | 99 % (partner-dependent, tracked separately) |

**Alert thresholds (page vs ticket):** *page* — any failed clinical write, critical-alert delivery failure, DB failover, replica lag > 60 s, queue `critical` depth > 50 or oldest job > 60 s, DLQ new fingerprint on a clinical connector, error rate > 2 % for 5 min, availability breach of a 99.9 % SLO. *Ticket* — p95 regression > 15 % for 30 min, DLQ depth > 500, cache hit rate < 85 %, disk > 70 %, bloat > 25 %, unused index report, bundle budget drift.

**Dashboards** (one per audience): *Exec/IT board* (uptime, SLO burn, incidents), *API health* (RED per class), *Database* (qps, cache hit, locks, vacuum, bloat, partitions), *Queues & jobs*, *Realtime & boards*, *Integrations* (EN-017 RAG grid), *Frontend RUM* (LCP/INP/CLS by device class and route, sampled, **no PHI in any event or attribute**).

**On-call runbooks** live in `infra/runbooks/`: `db-failover.md`, `replica-lag.md`, `queue-backlog.md`, `dlq-triage.md`, `critical-alert-not-delivered.md`, `slow-opd-morning.md`, `printer-agent-down.md`, `analyzer-interface-down.md`, `read-only-mode.md`, `restore-from-backup.md`. Every paging alert's annotation links to its runbook; an alert without a runbook is a CI failure in the alert-rules repo.
