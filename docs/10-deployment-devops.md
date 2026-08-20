# 10 — Deployment & DevOps

> Same code, two profiles: **cloud SaaS** and **on-prem/hybrid**. A hospital must be able to buy either without
> a different product, and VIMS ENTERPRISE must be able to hand over a self-contained on-prem stack that an
> internal IT team can operate. Everything here is executable: commands, ports, sizes, thresholds, runbooks.
> Companion docs: `01-architecture.md` §1 (shape), `07-performance-scalability.md` (budgets, SLOs, capacity
> triggers), `09-quality-gates-and-testing.md` §15–16 (CI gates, release process), `04-security-compliance.md`.

---

## 1. Environments

| Env                                  | Purpose                                                                 | Data                                                                 | Who deploys                     | Lifetime                |
| ------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------- | ----------------------- |
| **local**                            | developer laptop; `docker compose -f infra/compose/dev.yml up`          | `seed:minimal`                                                       | developer                       | ephemeral               |
| **dev**                              | shared integration of `main`; partner sandboxes wired                   | `seed:demo`                                                          | CI on every merge to `main`     | permanent               |
| **staging**                          | release-candidate verification; production-shaped topology at 1/4 scale | `seed:volume` (3-year synthetic)                                     | CI on RC tag                    | permanent               |
| **uat** (per implementation)         | hospital's own masters + scripted UAT (`09` §12)                        | hospital masters + synthetic patients; migrated data after dry-run 2 | implementation lead             | project duration + 30 d |
| **pre-prod**                         | final smoke on the exact production image and config; DR restore target | last production restore, masked                                      | release manager                 | permanent               |
| **prod**                             | live                                                                    | real                                                                 | release manager, staged rollout | forever                 |
| **sandbox** (per hospital, optional) | training, demos, new-branch rehearsal, API partners                     | masked or synthetic, never live PHI                                  | hospital admin, self-service    | on demand               |

Rules: **no production PHI outside prod and the masked pre-prod restore** (`09` §11). Every non-prod environment
carries a visible environment banner and a distinct favicon/theme so nobody trains on production by accident.
Partner credentials are per-environment; a sandbox connector is paused before the production one is activated
(`08` §0 checklist item 3).

---

## 2. Deployment profile A — cloud SaaS

```
Cloudflare (DNS, WAF, DDoS, TLS, rate limit, bot)
        │
        ├── apps/web            → Vercel  or  ECS/EKS/ACA container (output: standalone)
        ├── apps/tv-kiosk       → same
        └── api.<tenant>.vimshms.in
                 │
        ┌────────▼─────────────────────────────────────────────┐
        │  Kubernetes (EKS/AKS) namespace per environment      │
        │  Deployments: api(3-10) · realtime(2) · worker-      │
        │  critical(2) · worker-standard(2-6) · worker-bulk(2) │
        │  · integration-hub(2) · ai(0-2)                      │
        │  Ingress: nginx/ALB · HPA on p95+CPU · PDB min 1     │
        └────────┬─────────────────────────────────────────────┘
                 │
   PgBouncer(2) ─┴─ RDS/Neon PostgreSQL 17 Multi-AZ (+2 read replicas)
   ElastiCache/Upstash Redis 7 (cluster, AOF)   S3 (+ Glacier lifecycle)
   Orthanc PACS (EC2/AKS statefulset + S3 plugin)   Grafana Cloud / self-hosted LGTM   Sentry
```

Notes: one Kubernetes namespace per environment; **tenant isolation is at the database row level by default**
(`01` §8), with dedicated schema/database/stack available as a commercial lever. `services/print-agent` is _not_
in the cloud — it always runs on the hospital LAN (§5). MLLP/ASTM listeners likewise: even a cloud tenant needs an
on-site gateway container for analyzers and modalities.

## 3. Deployment profile B — on-prem / hybrid

Two topologies, chosen by size:

**B1 — Compose all-in-one** (≤ 500 beds, single server or a pair): `infra/compose/onprem.yml`, systemd-managed,
Traefik or Nginx with the hospital's internal CA, MinIO for objects, local Orthanc, self-hosted Grafana stack.

```yaml
# infra/compose/onprem.yml (abridged — the real file pins digests and mounts secrets from /etc/vims/secrets)
services:
  proxy:      { image: nginx:1.27-alpine, ports: ["443:443","80:80"], depends_on: [web, api] }
  web:        { image: ghcr.io/vims/hms-web:${VERSION},        deploy: {replicas: 2}, mem_limit: 2g }
  api:        { image: ghcr.io/vims/hms-api:${VERSION},        deploy: {replicas: 3}, mem_limit: 4g }
  realtime:   { image: ghcr.io/vims/hms-realtime:${VERSION},   deploy: {replicas: 1}, mem_limit: 2g }
  worker:     { image: ghcr.io/vims/hms-worker:${VERSION},     deploy: {replicas: 2}, mem_limit: 4g,
                environment: [QUEUES=critical,standard] }
  worker-bulk:{ image: ghcr.io/vims/hms-worker:${VERSION},     deploy: {replicas: 1}, mem_limit: 6g,
                environment: [QUEUES=bulk] }
  ihub:       { image: ghcr.io/vims/hms-integration-hub:${VERSION}, mem_limit: 3g,
                ports: ["2575:2575","2576:2576","104:104"] }        # MLLP, ASTM, DICOM
  postgres:   { image: postgres:17-bookworm, shm_size: 2g, volumes: ["/data/pg:/var/lib/postgresql/data"] }
  pgbouncer:  { image: edoburu/pgbouncer:latest, environment: [POOL_MODE=transaction] }
  redis:      { image: redis:7-alpine, command: ["redis-server","--appendonly","yes"] }
  minio:      { image: minio/minio, volumes: ["/data/minio:/data"], command: server /data --console-address ":9001" }
  orthanc:    { image: orthancteam/orthanc:latest, volumes: ["/data/dicom:/var/lib/orthanc/db"] }
  backup:     { image: ghcr.io/vims/pgbackrest:latest, volumes: ["/backup:/backup"] }
  otelcol:    { image: otel/opentelemetry-collector-contrib:latest }
  grafana / prometheus / loki / tempo: self-hosted LGTM stack, 30-day local retention
```

**B2 — k3s cluster** (> 500 beds, or any hospital that wants rolling upgrades without a maintenance window):
3 control-plane/worker nodes + a separate Postgres pair (primary + streaming replica) on bare metal or VMs.
Helm chart `infra/helm/vims-hms` with values files per size (`values-500.yaml` …), `PodDisruptionBudget: minAvailable 1`
on api/realtime/ihub, `topologySpreadConstraints` across nodes, `PriorityClass` so `worker-critical` and `api`
evict `worker-bulk` first. Postgres is deliberately **not** run inside k3s — hospital IT restores databases, not
statefulsets.

**Hybrid:** on-prem primary + a cloud replica (logical replication over an IPSec/WireGuard tunnel) that serves the
patient portal, the DR target and group analytics. PHI leaves the premises only if the hospital's DPO has approved
it and the tenant's `data_residency` config allows it.

---

## 4. Resource sizing

Derived from `07` §1 (a 2000-bed group = 5,000 OP visits/day, 20,000 lab analytes/day, 40,000 MAR
administrations/day, 1,800 rps peak). Smaller sizes scale sub-linearly because the fixed cost of the platform
(auth, realtime, hub, observability) dominates at the low end. **Storage is 3-year sizing including indexes and
excluding DICOM**, which is listed separately.

### 4.1 Application tier

| Component                               | 50 beds            | 200 beds   | 500 beds   | 1000 beds  | 2000 beds       |
| --------------------------------------- | ------------------ | ---------- | ---------- | ---------- | --------------- |
| Concurrent staff sessions (peak)        | 25                 | 120        | 400        | 900        | 2,000           |
| API peak rps                            | 40                 | 180        | 500        | 950        | 1,800           |
| `api`                                   | 2 × (1 vCPU, 2 GB) | 2 × (2, 3) | 3 × (2, 4) | 5 × (2, 4) | 8 × (2, 4)      |
| `realtime`                              | 1 × (0.5, 1)       | 1 × (1, 2) | 2 × (1, 2) | 2 × (2, 3) | 3 × (2, 4)      |
| `worker` critical+standard              | 1 × (1, 2)         | 2 × (1, 3) | 2 × (2, 4) | 4 × (2, 4) | 6 × (2, 4)      |
| `worker-bulk` (PDF, reports, migration) | shared             | 1 × (2, 4) | 1 × (2, 6) | 2 × (2, 6) | 3 × (4, 8)      |
| `integration-hub`                       | 1 × (0.5, 1)       | 1 × (1, 2) | 1 × (2, 3) | 2 × (2, 4) | 2 × (4, 6)      |
| `web` (SSR)                             | 1 × (1, 1.5)       | 2 × (1, 2) | 2 × (2, 3) | 3 × (2, 3) | 4 × (2, 4)      |
| Redis                                   | 1 GB               | 2 GB       | 4 GB       | 8 GB       | 16 GB (cluster) |
| **Total app tier**                      | ~6 vCPU / 12 GB    | ~14 / 28   | ~26 / 52   | ~48 / 96   | ~90 / 180       |

### 4.2 PostgreSQL

|                                           | 50 beds       | 200 beds      | 500 beds           | 1000 beds       | 2000 beds         |
| ----------------------------------------- | ------------- | ------------- | ------------------ | --------------- | ----------------- |
| vCPU                                      | 4             | 8             | 16                 | 24              | 32 (→64 headroom) |
| RAM                                       | 16 GB         | 32 GB         | 64 GB              | 128 GB          | 256 GB (→512)     |
| `shared_buffers` / `effective_cache_size` | 4 / 11 GB     | 8 / 22 GB     | 16 / 45 GB         | 32 / 90 GB      | 64 / 180 GB       |
| `work_mem` (report pool)                  | 8 MB (32)     | 16 (64)       | 32 (128)           | 32 (128)        | 32 (128)          |
| `max_connections` (behind PgBouncer)      | 100           | 200           | 300                | 400             | 500               |
| Data disk (3 y, with archival)            | 200 GB        | 500 GB        | 1.2 TB             | 2.5 TB          | 5 TB              |
| WAL disk (separate volume)                | 50 GB         | 100 GB        | 200 GB             | 400 GB          | 800 GB            |
| Sustained IOPS / peak                     | 1,000 / 3,000 | 3,000 / 8,000 | 6,000 / 15,000     | 12,000 / 30,000 | 25,000 / 60,000   |
| Disk type                                 | NVMe SSD      | NVMe SSD      | NVMe SSD (RAID 10) | NVMe RAID 10    | NVMe RAID 10      |
| Read replicas                             | 0             | 0–1           | 1                  | 2               | 2–3               |
| Backup repo (pgBackRest, 30-day PITR)     | 600 GB        | 1.5 TB        | 4 TB               | 8 TB            | 16 TB             |

### 4.3 Object storage & PACS

|                               | 50          | 200          | 500         | 1000                  | 2000                  |
| ----------------------------- | ----------- | ------------ | ----------- | --------------------- | --------------------- |
| Documents/PDF/photos (3 y)    | 150 GB      | 600 GB       | 1.5 TB      | 3 TB                  | 5.5 TB                |
| DICOM/year (studies/day)      | 0.4 TB (60) | 1.6 TB (250) | 4 TB (600)  | 7 TB (1,000)          | 11 TB (1,200+)        |
| PACS hot tier (90 days, NVMe) | 120 GB      | 450 GB       | 1.1 TB      | 1.9 TB                | 2.7 TB                |
| PACS warm/cold                | NAS/S3-IA   | NAS/S3-IA    | NAS + S3-IA | S3-IA → Glacier @ 1 y | S3-IA → Glacier @ 1 y |

### 4.4 Server BOM shorthand (on-prem)

- **50–200 beds:** 2 × 1U servers (16 c / 64 GB / 2×960 GB NVMe RAID1) — one app+DB primary, one standby/backup; or a single server with a documented, accepted 4-hour RTO.
- **500 beds:** 3 × app nodes (16 c / 64 GB) + 2 × DB nodes (16 c / 128 GB / 4×1.92 TB NVMe RAID10) + 1 × backup/NAS (48 TB usable RAID6).
- **1000–2000 beds:** 4–6 × app nodes (24 c / 96 GB) + 2–3 × DB nodes (32 c / 256–512 GB / 8×3.84 TB NVMe RAID10) + PACS node (dual-socket, 200 TB NAS + tape/object cold tier) + 2 × observability nodes.
- Everything dual-PSU on separate circuits, dual 10 GbE bonded to separate switches, out-of-band management (iDRAC/iLO) on the management VLAN.

---

## 5. Network, ports and segmentation

```
Internet ──[ISP1]──┐                     ┌── VLAN 10  Servers (HMS app, DB, MinIO, Orthanc)
                   ├─ Firewall/UTM ──────┼── VLAN 20  Clinical workstations & nurse tablets (Wi-Fi SSID: HMS-CLIN)
Internet ──[ISP2]──┘   (HA pair)         ├── VLAN 30  Medical devices & analyzers  ← NO internet route
                                         ├── VLAN 40  Imaging modalities & PACS    ← NO internet route
                                         ├── VLAN 50  Printers, label & thermal, kiosks, TV boards
                                         ├── VLAN 60  Biometric, access control, CCTV (separate NVR)
                                         ├── VLAN 90  Management (iDRAC, switches, UPS, out-of-band)
                                         └── VLAN 99  Guest Wi-Fi ← fully isolated, no route to any of the above
```

| Flow                                                 | Port/proto                              | Direction                                                | Notes                                         |
| ---------------------------------------------------- | --------------------------------------- | -------------------------------------------------------- | --------------------------------------------- |
| Browsers/tablets → proxy                             | 443/tcp (TLS 1.3)                       | VLAN 20/50 → 10                                          | HTTP:80 redirects only                        |
| Proxy → web/api/realtime                             | 3000 / 4000 / 4001 tcp                  | within VLAN 10                                           | mTLS on-prem                                  |
| API/worker → PgBouncer → Postgres                    | 6432 → 5432 tcp                         | VLAN 10 only                                             | never exposed beyond VLAN 10                  |
| API/worker → Redis                                   | 6379 tcp                                | VLAN 10                                                  | requirepass + ACL                             |
| Services → MinIO/S3                                  | 9000 tcp / 443                          | VLAN 10                                                  | presigned URLs ≤ 5 min                        |
| Analyzers → integration-hub (HL7 MLLP)               | **2575/tcp**                            | VLAN 30 → 10 (allow-list per device IP)                  | ASTM on 2576, serial via device server        |
| Modalities ↔ Orthanc (DICOM)                         | **104 / 11112 tcp**                     | VLAN 40 ↔ 10                                             | MWL on the same AE title                      |
| Orthanc → OHIF/web                                   | 8042 tcp                                | VLAN 10                                                  | viewer proxied through 443                    |
| print-agent → printers                               | 9100 tcp (RAW), 631 (IPP)               | VLAN 10 → 50                                             | agent runs on the LAN, polls the API outbound |
| Barcode/label printers (ZPL)                         | 9100 tcp                                | VLAN 50                                                  |                                               |
| Biometric/attendance devices                         | vendor tcp (4370 etc.)                  | VLAN 60 → 10                                             |                                               |
| NTP                                                  | 123/udp                                 | all → VLAN 10 NTP host → NPL/NIC                         | CERT-In clock sync requirement                |
| Outbound integrations (ABDM, payment, SMS, WhatsApp) | 443 tcp                                 | VLAN 10 → internet via proxy, **egress allow-list only** |                                               |
| Remote support                                       | WireGuard 51820/udp or vendor jump host | inbound, MFA, time-boxed                                 | §12                                           |
| Monitoring scrape                                    | 9090/9100/4317                          | VLAN 90/10                                               | OTLP gRPC 4317                                |

**Wi-Fi for tablets:** WPA2/3-Enterprise with RADIUS and device certificates on `HMS-CLIN`; ≥ −67 dBm and
≥ 2 APs visible everywhere clinical work happens (wards, ICU, OT corridors, ER, lifts landings); seamless roaming
(802.11r/k/v); a dedicated 5 GHz band with airtime fairness; **survey before go-live, not after** — most "the HMS
is slow on tablets" tickets are Wi-Fi tickets.

---

## 6. CI/CD

CI gates are in `09` §15. Deployment workflows:

| Workflow            | Trigger              | Steps                                                                                                                                                                                           |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`            | every PR/push        | the 12 CI stages (`09` §15)                                                                                                                                                                     |
| `release.yml`       | tag `v*`             | build multi-arch images → SBOM (Syft) → scan (Trivy) → **sign (cosign, keyless OIDC)** → publish → generate changelogs → attach evidence pack                                                   |
| `deploy-cloud.yml`  | manual/auto per wave | verify signature + SBOM policy → `migrate` job → Helm upgrade with `--atomic --timeout 10m` → smoke suite → progressive traffic → auto-rollback on gate failure                                 |
| `deploy-onprem.yml` | manual               | build a **signed offline bundle** (images tar, Helm/compose, migrations, checksums, release note) → publish to the customer portal → on-site/remote apply via `infra/scripts/onprem-upgrade.sh` |
| `nightly.yml`       | cron                 | full e2e, soak, partner sandbox contracts, restore verification, integrity invariants                                                                                                           |

**Deployment steps in detail** (both profiles): pre-flight (`/healthz` of current version, backup freshness < 24 h,
free disk > 25 %, no open Sev-1) → **backup/restore point** → `migrate` (expand-only, see below) → rolling deploy
(maxSurge 1, maxUnavailable 0; readiness = DB reachable + migrations at expected version + Redis reachable) →
**smoke suite** (login, register a synthetic patient, place an order, post a charge, print to a null printer,
publish and consume an event — all in a dedicated smoke tenant) → mark healthy → 24 h heightened watch.
Rollback = redeploy previous tag (target < 10 min), because the schema is backward-compatible by construction.

### 6.1 Migration safety rules (non-negotiable)

1. **Expand → migrate → contract, across at least two releases.**
   _Release N_: add the new nullable column/table/index (`CREATE INDEX CONCURRENTLY`), dual-write, backfill in a chunked, resumable, throttled job. _Release N+1_: switch reads, verify. _Release N+2_: stop writing the old, drop it.
2. **No destructive change ships with the code that stops using the thing.** Dropping a column, table or constraint requires the prior release to have been running in production for ≥ 14 days with zero reads (proved by `pg_stat_statements` and a query-log audit).
3. **Nothing that takes an `ACCESS EXCLUSIVE` lock for more than 2 seconds** on a table > 1 M rows. `lock_timeout = '2s'`, `statement_timeout` set on the migration role; a blocked migration fails fast and is retried in a window rather than queueing behind clinical traffic.
4. **Backfills are jobs, not migrations**: batched (≤ 5,000 rows), checkpointed, idempotent, throttled by the same clinical-latency guard as EN-036 (`p95 class C > 250 ms → pause`), observable, and re-runnable.
5. Every migration file carries a `-- ROLLBACK:` block, and both directions are tested in CI against the previous release's seeded database (`09` §15 stage 5).
6. Migrations run as a **separate DB role** with DDL rights that the application role does not have; the app role can never `ALTER`.
7. **Zero-downtime deploys** require API version tolerance: release N's code must run against release N−1's _and_ N's schema (asserted by a CI job that boots the previous image against the new schema).
8. Data-fixing scripts are never run by hand on production. They are migrations or approved EN-036 batches, with an audit reason, an approver and a rollback plan.

---

## 7. Configuration, secrets and observability

**Configuration** is layered: image defaults → environment file per deployment → per-tenant settings in
`core.settings` (editable by hospital admin, the "configuration over code" principle) → feature flags/entitlements
(EN-040). Anything a hospital might reasonably want to change is a setting, not an env var. Env vars are validated
by a Zod schema at boot; a missing or malformed variable **fails the boot loudly** rather than defaulting.

**Secrets**: AWS SSM / Azure Key Vault / HashiCorp Vault (cloud), Vault or sops-age encrypted files under
`/etc/vims/secrets` with `0600` root ownership (on-prem). Never in git, never in the image, never printed after
save, never in a support ticket. Rotation: DB and Redis credentials 180 days, JWT signing keys 90 days with
overlapping key ids, partner API keys per partner policy, break-glass account credentials sealed and alerting on
use. A `secrets-inventory.md` per tenant records what exists, who owns it and when it rotates.

**Observability stack** (`services/*` → OTel SDK → collector → backends):

- **Collector** (`otelcol`) per cluster/host: receives OTLP 4317/4318, applies the **PHI scrubber processor** (deny-list of attribute keys plus a regex redactor for UHID/phone/Aadhaar patterns — verified by the `09` §8 leakage test), tail-samples traces (100 % of errors and slow spans, 5 % of the rest), exports to Tempo/Prometheus/Loki.
- **Metrics**: Prometheus (or Grafana Cloud/Datadog), 15-day local retention, 13 months downsampled. RED metrics per endpoint class, per module; business metrics too (registrations/hour, unbilled charges, DLQ depth, pending pre-auths) — because operational health and hospital health are the same dashboard for the customer.
- **Logs**: pino JSON → Loki, 30 days hot, 1 year archived (DPDP Rules require **security logs ≥ 1 year**, CERT-In requires 180 days in India). No PHI, ever; correlation is by `trace_id` + `patient_ref` (an opaque per-request token that resolves only inside the app with permission).
- **Traces**: Tempo, 7 days; exemplars link Grafana panels to traces.
- **Errors**: Sentry, with scrubbing configured and verified; release tagging so a spike is attributable to a deploy.
- **Uptime/synthetics**: Better Stack (or equivalent) probing `/healthz`, login, and one read-only clinical read every 60 s from two locations; on-prem probes run from a second host inside the hospital and report outward if egress is allowed.
- **Dashboards** as code in `infra/observability/` (Grafana JSON, alert rules, recording rules) — reviewed like code, and an alert without a linked runbook fails CI.

### 7.1 Alert catalogue

Severity → routing. **P1 pages** (phone call + push, 24×7); **P2 pages during business hours, tickets otherwise**;
**P3 tickets**. Baseline thresholds from `07` §8; this table adds ownership.

| #   | Alert                                   | Condition                                                                                                         | Sev                           | Pages                                                |
| --- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------- |
| 1   | Failed clinical write                   | any 5xx or DB error on a clinical write path, count ≥ 1                                                           | P1                            | Platform on-call + module owner                      |
| 2   | Critical alert not delivered            | EN-037 delivery failure or unacknowledged past escalation tier 2                                                  | P1                            | Platform on-call **and** hospital nursing supervisor |
| 3   | Service down                            | `/healthz` failing 2 consecutive probes, any service                                                              | P1                            | Platform on-call                                     |
| 4   | Database failover / primary unreachable | replica promoted, or 3 failed connections in 60 s                                                                 | P1                            | Platform on-call + DBA                               |
| 5   | Error rate                              | 5xx > 2 % of requests for 5 min                                                                                   | P1                            | Platform on-call                                     |
| 6   | Replica lag                             | > 60 s for 5 min                                                                                                  | P1                            | DBA                                                  |
| 7   | Queue `critical` backlog                | depth > 50 or oldest job > 60 s                                                                                   | P1                            | Platform on-call                                     |
| 8   | Disk                                    | data or WAL volume > 85 %, or < 4 h to full at current rate                                                       | P1                            | Platform on-call                                     |
| 9   | Backup failure                          | nightly pgBackRest exit ≠ 0, or newest backup > 26 h old                                                          | P1                            | DBA                                                  |
| 10  | Security                                | auth bypass signature, privilege-escalation attempt, break-glass burst (> 3/h), WAF critical, new secret detected | P1                            | Security on-call + DPO                               |
| 11  | Interface down                          | analyzer/PACS/ABDM connector no traffic for its `expect_traffic` window, or circuit breaker open                  | P2                            | Integration owner + hospital lab/radiology IT        |
| 12  | DLQ                                     | new fingerprint on a clinical connector (P1) / depth > 500 (P2)                                                   | P1/P2                         | Integration owner                                    |
| 13  | Latency regression                      | class C p95 > 250 ms for 30 min                                                                                   | P2                            | Platform on-call                                     |
| 14  | Redis memory                            | > 85 % maxmemory or evictions > 0                                                                                 | P2                            | Platform on-call                                     |
| 15  | Print agent down                        | agent heartbeat missing > 5 min                                                                                   | P2                            | Hospital IT (business hours), P1 during OPD peak     |
| 16  | Certificate expiry                      | < 14 days                                                                                                         | P2                            | Platform on-call                                     |
| 17  | Licence/entitlement                     | tenant at 95 % of seats/rows, or expiring < 30 d                                                                  | P3                            | Account manager                                      |
| 18  | Integrity invariant breach              | nightly data-integrity job failure (`09` §9)                                                                      | P1 if money/clinical, else P2 | Module owner + Finance/MRD counterpart               |
| 19  | Capacity trigger                        | any `07` §6 trigger true 3 days running                                                                           | P3                            | Platform lead                                        |
| 20  | UPS on battery / power                  | UPS event > 2 min (on-prem, via SNMP)                                                                             | P2                            | Hospital facilities + IT                             |

Escalation: P1 unacknowledged in **5 min** → secondary on-call; **15 min** → engineering manager; **30 min** →
CTO and hospital IT head. Every P1 opens an incident record and a post-incident review within 7 days (`04` §8).

---

## 8. Backup and restore

**Policy:** pgBackRest, full weekly + differential daily + continuous WAL archiving; PITR ≥ **30 days**;
repo1 local NVMe/NAS, repo2 off-site (S3/Azure Blob with **object-lock/immutability** and a separate credential set
so ransomware on the hospital domain cannot delete it). Backups are encrypted (repo cipher AES-256-CBC) and
verified. Object storage (documents, DICOM) has its own versioned + replicated policy. Redis is a cache and
queue — jobs are recoverable from the outbox, so Redis is **not** part of the RPO.

```bash
# /etc/pgbackrest/pgbackrest.conf  (on-prem, abridged)
[global]
repo1-path=/backup/pgbackrest
repo1-retention-full=4
repo1-cipher-type=aes-256-cbc
repo2-type=s3
repo2-s3-bucket=vims-hms-backup-<tenant>
repo2-retention-full=8
repo2-cipher-type=aes-256-cbc
process-max=4
compress-type=zst
start-fast=y
archive-async=y
[vimshms]
pg1-path=/data/pg
pg1-port=5432
```

```bash
# Weekly full (Sun 01:30) / daily diff (01:30) — systemd timers in infra/systemd/
pgbackrest --stanza=vimshms --type=full  backup
pgbackrest --stanza=vimshms --type=diff  backup
pgbackrest --stanza=vimshms info                      # verify newest backup age + WAL continuity
pgbackrest --stanza=vimshms check                     # archive_command and repo reachable

# Point-in-time restore to a scratch instance (never onto the live data directory first)
systemctl stop vims-hms-postgres
pgbackrest --stanza=vimshms --delta \
  --type=time --target="2026-08-17 09:45:00+05:30" --target-action=promote \
  --pg1-path=/data/pg-restore restore
# then start on an alternate port, verify, and only then cut over

# Provider-managed alternative (cloud): RDS/Neon PITR + a nightly logical dump for portability
pg_dump --format=directory --jobs=8 --no-owner --file=/backup/logical/$(date +%F) "$DATABASE_URL"
```

**Restore drill — quarterly, mandatory, logged in `core.dr_drills`** (`03` "Backup / DR"; an assessor will ask).
`infra/scripts/restore-drill.sh`:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
STANZA=vimshms; TARGET="${1:?usage: restore-drill.sh 'YYYY-MM-DD HH:MM:SS+05:30'}"
DRILL_ID=$(uuidgen); WORK=/var/tmp/drill-$DRILL_ID; START=$(date +%s)

pgbackrest --stanza=$STANZA info | tee $WORK/info.txt            # 1. prove backups exist and are current
pgbackrest --stanza=$STANZA --pg1-path=$WORK/pg --delta \
  --type=time --target="$TARGET" --target-action=promote restore  # 2. restore to scratch
pg_ctl -D $WORK/pg -o "-p 5499" start                             # 3. start isolated
psql -p 5499 -d vimshms -f infra/scripts/restore-verify.sql       # 4. verify:
#    - schema_migrations head == expected            - row counts vs the recorded control totals
#    - audit hash chain verifies for the last day    - ΣDr = ΣCr for the last closed period
#    - no orphan bill_items, stock ledger balances   - latest patient/visit/bill timestamps <= target
pg_ctl -D $WORK/pg stop; rm -rf $WORK
END=$(date +%s)
psql "$DATABASE_URL" -c "INSERT INTO core.dr_drills(id,kind,target_time,rto_seconds,result,notes,performed_by)
  VALUES ('$DRILL_ID','pitr_restore','$TARGET',$((END-START)),'pass','quarterly drill','$USER');"
```

The drill **fails** if RTO exceeds the tier target, if any verification query fails, or if the drill was not run
in the last 100 days. A failed drill is a P1.

---

## 9. Disaster recovery

| Tier                                                     | Who                                               | RPO            | RTO       | Mechanism                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------- | -------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **T1 Enterprise** (≥ 500 beds, trauma centres, group HQ) | cloud Multi-AZ or on-prem HA pair + cloud replica | **≤ 5 min**    | **≤ 1 h** | synchronous-ish streaming replica in a second failure domain + WAL to immutable off-site; automated promotion with a manual gate |
| **T2 Standard** (200–500 beds)                           | single site + warm standby                        | ≤ 15 min       | ≤ 4 h     | async streaming replica on the standby server; restore from repo2 if the site is lost                                            |
| **T3 Basic** (< 200 beds, single server)                 | nightly + WAL                                     | ≤ 15 min (WAL) | ≤ 8 h     | rebuild from bundle + PITR restore; documented and _accepted in writing_ by the hospital                                         |

**Failover procedure (T1/T2), on-prem:**

1. Declare (incident commander named in `04` §8). Announce read-only/downtime protocol to wards via EN-018 boards and SMS.
2. Confirm the primary is genuinely lost (not a network partition) — check from two vantage points; **fencing first** to avoid split-brain (stop the old primary's Postgres and disable its systemd unit).
3. Promote: `pg_ctl promote -D /data/pg` (or Patroni-managed failover where deployed). Verify `pg_is_in_recovery() = false` and the last replayed LSN.
4. Repoint PgBouncer (`host=` in `pgbouncer.ini`, `RELOAD`) — the application does not need redeployment; it retries.
5. Verify: `/healthz`, smoke suite, integrity spot-checks (last bill, last MAR, last result), then lift read-only mode.
6. Cloud DNS cutover where the site moved: Cloudflare record TTL is kept at **60 s** precisely so this step is fast; failover is a scripted API call, and health-check-based failover is pre-armed for the API and web records.
7. Rebuild the old primary as the new replica (`pg_basebackup` or `pg_rewind`); never re-promote it without a rebuild.
8. Post-incident: RCA within 7 days, timeline, RPO/RTO actually achieved, CAPA in NC-015.

**Interface and portal considerations during DR:** MLLP/ASTM listeners are LAN-pinned — after failover, analyzer
sessions must be reconnected and the interface backlog replayed (runbook `analyzer-interface-down.md`). Queued
outbound ABDM/payment/SMS messages drain in order from the outbox without duplication (idempotency keys).

---

## 10. On-prem installation runbook

**Pre-visit (2 weeks before):** hardware delivered and racked; VLANs configured per §5; static IPs and DNS names
allocated; internet/egress allow-list opened; UPS commissioned; Wi-Fi survey completed; printers/scanners
delivered; hospital's TLS certificate (or internal CA) available; named hospital IT owner assigned.

1. **Hardware & power.** Rack, dual PSU on separate circuits, UPS sized for **≥ 30 min** at full load with a
   generator backing it (or ≥ 60 min without); UPS SNMP card wired to monitoring; graceful-shutdown agent on the
   DB host configured to shut down cleanly at 20 % battery. Server room: dedicated AC with a temperature alarm,
   smoke detection, physical access control and a visitor log.
2. **OS.** Ubuntu Server 24.04 LTS or RHEL 9 (whatever the hospital's team can actually support). Hardening:
   CIS Level 1 profile, `unattended-upgrades` for security patches, SSH key-only with no root login, `ufw`/firewalld
   default-deny, `fail2ban`, auditd, disabled unused services, separate LVM volumes for `/data/pg`, `/data/pg-wal`,
   `/data/minio`, `/data/dicom`, `/backup`, `/var/log`, filesystem `ext4`/`xfs` with `noatime`, swappiness 1,
   transparent huge pages **disabled**, `vm.overcommit_memory=2` on the DB host.
3. **Time.** `chrony` on all hosts pointing at an internal NTP host that syncs to **NPL/NIC** (CERT-In requirement).
   Clock drift > 1 s alerts — HL7 timestamps, audit chains and MAR times depend on it.
4. **Antivirus exclusions** (get this wrong and Postgres will be mysteriously slow or corrupt): exclude
   `/data/pg`, `/data/pg-wal`, `/backup`, `/data/minio`, `/data/dicom`, Docker's `/var/lib/docker`, and the
   print-agent spool from real-time scanning; scheduled scans only, outside 07:00–23:00. Document the exclusion
   list and have the hospital's security team sign it.
5. **Platform.** Install Docker/k3s, pull the **signed** offline bundle, verify checksums and cosign signature,
   place secrets in `/etc/vims/secrets`, `docker compose up -d` (or `helm install`), run migrations, seed masters.
6. **Storage.** MinIO with erasure coding across ≥ 4 disks where available; Orthanc with a hot NVMe tier and a
   lifecycle job to NAS/object cold storage at 90 days; verify a full DICOM round-trip (C-STORE, MWL query, OHIF view).
7. **Devices.** Register each analyzer's IP in the hub allow-list and confirm a bidirectional order/result cycle;
   configure each modality's AE title/port against Orthanc's MWL; install `print-agent` on the LAN host and map
   every printer (A4/A5 laser, 80 mm thermal ESC/POS, ZPL label, PVC card) with a test print per template; pair
   barcode scanners in keyboard-wedge mode and verify the scan-detection timing (`06` §6.2); configure biometric
   devices; commission TV boards with device tokens and kiosk devices with their printers.
8. **Network validation.** Prove: tablet→API p95 latency inside budget from the furthest ward; Wi-Fi roaming
   between APs without session loss; VLAN 30/40 have no internet route; guest VLAN cannot reach VLAN 10;
   egress allow-list permits exactly the required partner endpoints and nothing else.
9. **Observability & backup.** Bring up the LGTM stack, import dashboards and alert rules, wire alert routing to
   the hospital's channel _and_ VIMS on-call, configure pgBackRest with both repos, run a **full backup and a
   restore drill before go-live** — a backup that has never been restored is not a backup.
10. **Remote support access.** WireGuard tunnel or a hospital-provided jump host; named individual accounts (no
    shared logins), MFA, time-boxed and approved per session, all sessions recorded, and every access logged in
    the hospital's register. Break-glass credentials sealed with alerting on use.
11. **Handover.** §14 checklist, admin training, credentials transferred to the hospital's vault, as-built document
    (IPs, versions, disk layout, backup schedule, contacts) signed by both sides.

---

## 11. Upgrade, patching and capacity

| Layer                           | Cadence                                        | Window                                   | Notes                                                                                        |
| ------------------------------- | ---------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| Application (cloud)             | fortnightly minor, patch on demand             | rolling, no downtime                     | staged waves (`09` §16)                                                                      |
| Application (on-prem)           | monthly, after cloud wave 1 is clean           | agreed window, typically Sun 01:00–04:00 | signed bundle; B2 (k3s) is rolling; B1 (compose) has a ≤ 5-min blip unless replicas are used |
| Security patches (critical CVE) | within **7 days** (48 h if actively exploited) | emergency window                         | out-of-band release allowed                                                                  |
| OS packages                     | monthly, unattended security updates daily     | 02:00                                    | reboots only in a window, one node at a time                                                 |
| PostgreSQL minor                | quarterly, within 90 days of release           | maintenance window                       | replica first, then failover, then old primary                                               |
| PostgreSQL major                | planned, ≥ annually reviewed                   | project, not a window                    | logical replication / `pg_createsubscriber` for near-zero downtime (`02` §1)                 |
| Container base images           | monthly rebuild                                | with the release                         | Trivy gate blocks known-critical bases                                                       |
| Firmware/BIOS/RAID              | annually or on advisory                        | scheduled downtime                       | with the hardware vendor                                                                     |

Every upgrade: announce ≥ 7 days ahead (≥ 24 h for patches) with the plain-language clinical changelog, verify
backup freshness, take a restore point, apply, run the smoke suite, watch for 24 h, and keep the rollback tag ready.
**Never upgrade during hypercare, month-end close, or the 48 h before an accreditation audit.**

**Capacity monitoring** is the `07` §6 trigger table, evaluated daily by a job that opens a P3 ticket automatically
when a trigger is true for 3 consecutive days, with the recommended action pre-filled. A quarterly capacity review
per tenant projects 12 months of growth for DB size, DICOM, IOPS, sessions and licence seats, and produces the
hardware/plan change proposal before the customer feels pain.

---

## 12. Runbooks, support tiers and SLAs

**Runbooks** (`infra/runbooks/`, each with: symptoms, blast radius, diagnosis commands, fix, verification,
comms template, escalation). Index: `incident-command.md` · `downtime-protocol.md` (paper fallback, reserved
numbering block, catch-up entry) · `db-failover.md` · `replica-lag.md` · `restore-from-backup.md` ·
`data-restore-single-record.md` · `queue-backlog.md` · `dlq-triage.md` · `interface-backlog-replay.md` ·
`analyzer-interface-down.md` · `pacs-modality-down.md` · `printer-agent-down.md` · `label-printer-failure.md` ·
`critical-alert-not-delivered.md` · `abdm-outage.md` (queue, degrade to local flow, reconcile on recovery) ·
`payment-gateway-outage.md` · `sms-whatsapp-outage.md` · `read-only-mode.md` · `slow-opd-morning.md` ·
`disk-full.md` · `certificate-renewal.md` · `security-incident.md` (CERT-In 6 h, DPDP Board 72 h) ·
`ransomware-response.md` · `new-branch-onboarding.md` · `tenant-offboarding-and-data-export.md`.

**Support tiers.** _Naming note:_ `04-security-compliance.md` §8 classifies **incidents** as S1–S4 (S1 patient-safety,
S2 data breach, S3 major outage, S4 degraded). The P1–P4 below classify **support tickets and alerts**. They are
different axes: an S2 data breach is always a P1 ticket, but a P1 ticket is not necessarily a security incident.
Both labels are carried on a record when both apply.

| Sev    | Definition                                                                           | Response         | Workaround | Resolution                       | Coverage            |
| ------ | ------------------------------------------------------------------------------------ | ---------------- | ---------- | -------------------------------- | ------------------- |
| **P1** | Patient safety at risk, system down, data loss/breach, billing stopped hospital-wide | **15 min**       | 2 h        | 8 h or an agreed continuity plan | 24×7×365            |
| **P2** | Major function degraded (a department blocked, an interface down, reports wrong)     | 1 h (24×7)       | 8 h        | 3 business days                  | 24×7                |
| **P3** | Minor defect, workaround exists, single user affected                                | 4 business hours | —          | next release train               | Mon–Sat 08:00–20:00 |
| **P4** | Cosmetic, question, enhancement request                                              | 1 business day   | —          | backlog / roadmap                | business hours      |

Support is L1 (hospital super-users, triage from the quick-reference cards) → L2 (VIMS support desk, runbooks,
config) → L3 (engineering). Availability SLA: **99.9 %** monthly for the cloud profile measured on the API and web
synthetics, excluding agreed maintenance windows and hospital-side network/power failures; on-prem availability is
measured on the stack VIMS controls, with the hospital's infrastructure obligations written into the contract.
Credits, exclusions and the measurement method are stated in the agreement, not left to interpretation.

---

## 13. Per-hospital onboarding / handover checklist

**Commercial & compliance:** signed agreement with SLA tier · modules/entitlements configured (EN-040) ·
data-processing agreement, DPDP notice text and DPO contact recorded · data-residency setting · sub-processor list
shared · retention policy agreed per record class.
**Infrastructure:** environment provisioned (cloud tenant or on-prem stack) · DNS + TLS · VLANs, ports, Wi-Fi
validated · UPS/power verified · NTP synced · AV exclusions signed · backup configured **and restore-drilled** ·
monitoring wired to both parties' channels · remote-support access approved and logged.
**Product setup:** hospital/branch hierarchy (EN-041) · numbering series (UHID, OP visit, IP number, bill, receipt,
MLC, blood bag) per branch and FY · roles mapped to real people, SSO/LDAP if used, break-glass sealed · masters
loaded and signed off (departments, doctors with HPR ids, services, tariffs incl. payer tariffs, drugs, items,
suppliers, wards/beds, payers/TPAs/schemes) · letterheads, print templates and consent forms · DLT-registered SMS
and WhatsApp templates · payment gateway keys and reconciliation account · ABDM HFR/HPR registration and M1–M3
credentials · analyzer, modality, printer, scanner, kiosk and TV inventory registered.
**Data:** migration completed and reconciled, or opening balances/stock established (`13`) · duplicate rate within
the agreed threshold · data-quality score above the go-live gate.
**People:** training completed by role with competency sign-off · super-users named per department · quick-reference
cards distributed · UAT sign-off matrix complete · downtime protocol printed and physically placed in each ward,
OT, ER, lab, pharmacy and billing counter.
**Operations:** on-call contacts exchanged both ways · escalation matrix agreed · hypercare roster published ·
first review meeting scheduled at day 15 · as-built document signed.

Nothing on this list is optional; anything not done is a recorded, owned, dated exception approved by both sides.
