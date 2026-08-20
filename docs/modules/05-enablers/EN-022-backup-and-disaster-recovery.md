# EN-022 — Backup & Disaster Recovery (pgBackRest/WAL-G, PITR, PG17 Incremental Backups, Object-Storage Lifecycle, Encrypted & Immutable Copies, Restore Runbooks, DR Drill Scheduling & Evidence, RPO/RTO Tiers, On-Prem vs Cloud, Cross-Region Replication)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Module ID       | EN-022                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Phase           | 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Depends on      | EN-007 (System Admin — backup status surfaced in the admin console, settings, dual control), EN-024 (Audit — backup/restore actions are audited; audit store has its own retention), EN-023 (Cybersecurity — ransomware resilience, key management, incident response), EN-017 (integration message payloads & connector configs are part of the backup scope), EN-037 (alerting), NC-023 (Legal/Compliance — evidence for licences and audits), NC-015 (Quality/NABH — DR drill evidence, BCP documentation), EN-041 (multi-branch/group — per-tenant restore), EN-040 (licence tier → RPO/RTO tier), EN-008 (PACS/DICOM archive has its own storage tier), EN-020 (biometric templates — encrypted-only backup path)                                                                                                                                                                                                            |
| Feature flag    | `module.backup_dr.enabled` (always on; sub-flags `dr.cross_region`, `dr.immutable_copies`, `dr.warm_standby`, `dr.self_service_restore`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Primary roles   | IT Admin / Infrastructure (56), Super Admin (SaaS operator — fleet-wide backup posture), Hospital Admin (2 — sees status, approves restores)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Secondary roles | Quality Manager (54 — DR drill evidence for NABH), Auditor (58), Privacy Officer (57 — backup encryption & retention vs DPDP erasure), Medical Superintendent (business continuity decisions during an outage), Department heads (downtime procedures)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Regulatory      | **DPDP Act 2023 & Rules 2025** (security safeguards including backups, breach notification within prescribed timelines, erasure obligations vs backup retention, data-fiduciary accountability), **CERT-In Directions 2022** (log retention 180 days _within India_, incident reporting within 6 hours, NTP sync), NABH 6th edition **IMS/FMS** (data backup policy, disaster management plan, business-continuity plan with documented drills), NABL 4.2 (records & data integrity for lab data), IT Act §43A & SPDI Rules (reasonable security practices), Companies Act §128 (books of account retained 8 years, electronic records accessible in India), Income Tax/GST record retention (6–8 years), medico-legal record retention (MLC/minor records longer, per NC-003), ISO 22301 (BCM) & ISO 27001 A.8.13 (information backup), RBI/insurer requirements where applicable to payment data (EN-010 — no card data stored) |

## 1. Purpose

EN-022 guarantees that Vim's HMS can lose no more than a few minutes of data and be back on its feet within an agreed window, in both cloud and on-prem deployments. It defines and automates: physical PostgreSQL backups with WAL archiving and point-in-time recovery, PG17 incremental backups, object storage and file/DICOM backups, encryption and immutable (WORM) copies for ransomware resilience, cross-region/off-site replication, tiered RPO/RTO targets, tested restore runbooks, scheduled DR drills with recorded evidence, and a status dashboard that tells the hospital — honestly and continuously — whether their data is actually recoverable.

## 2. Users & Jobs-to-be-done

- **IT Admin / Infrastructure** (desktop): configure backup targets and schedules, verify last night's backup, run a restore into a scratch environment, execute the quarterly DR drill, respond to a failure alert at 03:00 from the phone.
- **Super Admin (SaaS)**: see the backup posture of every tenant in one grid; spot the tenant whose backup has been silently failing for 5 days.
- **Hospital Admin**: see "last backup 02:15, verified, PITR window 35 days, last drill 12-Jun passed" without needing a DBA; approve a production restore (dual control).
- **Quality Manager (NABH)**: download the DR drill evidence pack (plan, run sheet, timings, RPO/RTO achieved, gaps, CAPA) at accreditation time.
- **Privacy Officer**: confirm backups are encrypted, held in India, and understand how a DPDP erasure request interacts with backup copies.
- **Clinical departments**: know the downtime procedure — what to do on paper when the HMS is unavailable, and how data is back-entered afterwards.

## 3. Core Workflows

### 3.1 Backup scope & topology

1. **PostgreSQL** (the system of record): physical base backups via **pgBackRest** (preferred; supports incremental, block-level delta, encryption, retention policies, multi-repo) or **WAL-G**, plus continuous **WAL archiving** to the backup repository. PG17's `pg_basebackup --incremental` / summarised WAL is used where pgBackRest is not deployed (small on-prem installs).
   - Schedules per tier (§3.3): full weekly, differential daily, incremental every 6 h, WAL archived continuously (`archive_timeout` 60 s so RPO never exceeds a minute of idle time).
   - Repositories: **repo1** = local/NAS (fast restore), **repo2** = object storage (S3/MinIO/Azure Blob) with lifecycle and object-lock.
2. **Object storage** (reports, scans, signed PDFs, photos, DICOM proxies): versioned buckets + cross-region replication for cloud; for on-prem MinIO, a scheduled `mc mirror` to a second site plus lifecycle to cold storage.
3. **PACS/DICOM** (EN-008/Orthanc): its own archive strategy (often the largest data set) — nightly sync to the DR site, with a documented, separately measured RTO because a full imaging restore is slow.
4. **Redis**: treated as rebuildable cache; only durable queues (BullMQ) are snapshotted (AOF/RDB) so in-flight jobs survive; message durability ultimately rests on the Postgres outbox.
5. **Configuration & secrets**: infrastructure-as-code in Git, secrets in Vault with its own backup + sealed-key escrow; connector configs and mappings (EN-017), print/label templates (EN-005/EN-039), report definitions — all in the database, therefore covered, but exported nightly as a human-readable config bundle for fast bootstrap.
6. **Audit & logs**: `core.audit_log`, `integration.hl7_messages` and application logs shipped to the log store (EN-024/EN-023) with their own 180-day+ retention, backed up separately so a database restore never rolls back the audit trail below the statutory minimum.

### 3.2 Backup execution & verification

1. Scheduler (pg_cron/worker) triggers the backup job → pgBackRest runs with compression (zstd) and encryption → repository writes → `dr_backup_runs` row with type, size, duration, throughput, WAL range, checksum, repo, status → Event `dr.backup.completed|failed`.
2. **Verification is mandatory, not optional**: every backup run is followed by `pgbackrest verify` (checksum/manifest validation), and **at least weekly an automated restore test** provisions a throwaway instance from the latest backup, replays WAL to a chosen point, starts Postgres, runs a smoke suite (row counts on key tables, a known patient record, a bill total, an RLS policy check, `pg_amcheck` on critical indexes) and then destroys the instance → `dr_restore_tests` with pass/fail and timings. **A backup that has never been restored is not a backup** — the dashboard shows "unverified" in amber and escalates after 7 days.
3. Retention: WAL + backups retained to satisfy the **PITR window** (default 35 days for enterprise, 14 for standard); monthly archival copies kept 12 months; a yearly copy kept per statutory retention (8 years for financial data) in cold/immutable storage — implemented as logical/selective exports rather than 8 years of physical backups.
4. Failure handling: retry once, then alert; two consecutive failures escalate to Hospital Admin and Super Admin; failure to archive WAL for > 15 min is a **P1** (it directly erodes RPO) and, if the archive destination is full, triggers automatic overflow to the secondary repo rather than letting `pg_wal` fill the data disk.

### 3.3 RPO/RTO tiers

| Tier                                      | Typical deployment                            | RPO         | RTO          | Mechanism                                                                                                                                                                          |
| ----------------------------------------- | --------------------------------------------- | ----------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platinum** (2000-bed enterprise, group) | Cloud or dual-DC on-prem                      | **≤ 1 min** | **≤ 30 min** | Synchronous or low-lag streaming replica in a second AZ/DC + warm standby app stack + automated failover with quorum; continuous WAL to two repos; cross-region object replication |
| **Gold** (default enterprise)             | Cloud or on-prem + DR site                    | ≤ 5 min     | ≤ 1 h        | Async streaming replica (`remote_apply` off, lag alarmed), WAL archiving every 60 s, warm standby provisioned on demand                                                            |
| **Silver** (mid-size hospital)            | Single-site on-prem + off-site object storage | ≤ 15 min    | ≤ 4 h        | Incremental backups + WAL archive to off-site object storage, restore to standby hardware                                                                                          |
| **Bronze** (small clinic/branch)          | Single server                                 | ≤ 24 h      | ≤ 24 h       | Nightly full backup to off-site storage; documented manual restore                                                                                                                 |

- The tier is set per hospital (licence-linked, EN-040) and drives schedules, replica topology, alert thresholds and drill frequency. **The dashboard always shows the _measured_ RPO/RTO from the last drill next to the _target_** — if they diverge, that is the finding.

### 3.4 Point-in-time recovery (PITR)

1. Operator opens **Restore Console** → chooses scope: full cluster / single database / **single tenant (hospital_id)** / single table set → chooses target time (calendar + time picker, bounded by the available PITR window, showing the earliest recoverable timestamp) → target environment (scratch / staging / production).
2. Production restore requires **dual authorisation** (IT Admin + Hospital Admin) and a stated reason (ransomware, bad migration, mass deletion, corruption); the system shows the estimated data loss (`now - target time`) and the affected record counts where computable, and requires typing the hospital name to confirm.
3. Restore executes: provision instance → `pgbackrest restore --type=time --target=...` → recovery → smoke checks → for tenant-scoped restores, the recovered tenant data is exported and merged back into production through a reviewed, audited data-repair job (never a blind overwrite of live rows).
4. Post-restore: reconciliation report (rows restored, gaps, sequences/numbering series realigned — **critical for gapless invoice series**), outbox replay decision (avoid duplicate SMS/payments — replay defaults to `suppress_side_effects`), cache flush, integration re-sync, and a mandatory incident record (EN-023/NC-015).

### 3.5 DR drills (`dr_drills`)

1. Drills are **scheduled** (Platinum/Gold quarterly, Silver half-yearly, Bronze annually) with a calendar entry, a named lead, participants and a scenario from the library: _primary DB loss_, _whole-site loss_, _ransomware encryption of the primary and repo1_, _accidental mass deletion by an admin_, _object storage loss_, _PACS archive loss_, _WAN/ISP loss with on-prem survival_.
2. Run sheet (auto-generated from the runbook) with timestamped steps; the tool records **actual** detection time, decision time, restore start/end, application-up time, verification-complete time → computes **achieved RPO and RTO**.
3. Evidence pack (PDF): scenario, participants, run sheet with timings, target vs achieved, screenshots/logs, issues found, CAPA items with owners and due dates (pushed to NC-015), sign-off by IT lead + Quality Manager + Medical Superintendent.
4. Failed or partially failed drills automatically create CAPA tasks and are re-tested; a drill overdue by > 30 days raises a compliance alert visible to Hospital Admin and appears as a NABH non-conformity risk.

### 3.6 Ransomware resilience (`dr.immutable_copies`)

- **3-2-1-1-0 rule** enforced by configuration checks: ≥ 3 copies, on ≥ 2 media types, ≥ 1 off-site, **≥ 1 immutable/offline**, **0 unverified restores**.
- Immutable copies: object-lock (S3 Object Lock / MinIO WORM) in _compliance mode_ for a defined period (e.g. 14 days) so even a compromised admin credential cannot delete or encrypt them; separate credentials with write-once permissions, held outside the domain/AD used by the HMS.
- Backup repository credentials are **not** reachable from application servers; the backup agent pushes with a scoped key, and the repo denies deletes from that key.
- Anomaly detection: sudden backup-size deltas, mass-encryption signatures, an unusual spike in row deletions, or backup-deletion attempts raise a **P1** to EN-023 and freeze retention pruning.
- Air-gapped/offline copy option (monthly LTO tape or detached disk rotation) for on-prem hospitals; the dashboard tracks the last offline copy date.

### 3.7 On-prem vs cloud specifics

- **Cloud**: managed Postgres snapshots are _not_ sufficient by themselves — pgBackRest to the hospital's own bucket runs alongside so the tenant is never locked into the provider and can restore elsewhere; cross-region replication for buckets; DR region pre-provisioned with IaC (Terraform) so a full stack can be brought up from code; DNS failover with health checks.
- **On-prem**: primary + standby servers, NAS repo1, off-site object storage (or a second branch's MinIO), UPS/generator dependencies documented, a documented **downtime kit** (offline PDF of ward census, drug list, active orders printed at shift change or generated by a local read-replica), and a "run without WAN" verification in every drill.
- **Hybrid/group** (EN-041): each branch's data lives in one cluster; branch-level restore must be possible without disturbing the others (tenant-scoped restore path in §3.4).

### 3.8 Downtime & business continuity procedures

- **Planned downtime**: maintenance window workflow — notice to all users (in-app + SMS to HODs), read-only mode toggle, banner countdown, automatic checkpoint backup before the change, rollback plan attached, post-change verification checklist.
- **Unplanned downtime**: the BCP kicks in — printed downtime forms per department (registration, orders, MAR, billing), a local read-only mirror at the nursing station if available, and a **back-entry queue** so paper records captured during the outage are entered afterwards with the original timestamps and an `entered_late` flag (clinically important and NABH-required).
- Every downtime event is logged (`dr_downtime_events`) with start/end, cause, affected modules, patients impacted, and back-entry completion status.

## 4. Data Model (schema `core`, prefix `dr_`)

- `dr_policies` — id, hospital_id, tier enum(platinum/gold/silver/bronze), rpo_target_sec, rto_target_sec, pitr_window_days, full_schedule cron, diff_schedule cron, incr_schedule cron, wal_archive_timeout_sec, verify_schedule cron, restore_test_schedule cron, drill_frequency enum(quarterly/half_yearly/annual), retention jsonb (daily/weekly/monthly/yearly copies), immutable_days, offline_copy_required bool, encryption jsonb (algo, key_ref), residency enum(in_india/region), effective_from, version.
- `dr_repositories` — id, hospital_id, name, kind enum(local_fs/nas/s3/minio/azure_blob/gcs/tape), endpoint, bucket/path, credentials_ref (Vault), encryption_key_ref, object_lock enum(none/governance/compliance), lock_days, region, is_offsite bool, is_immutable bool, capacity_bytes, used_bytes, status, last_write_at, last_verify_at.
- `dr_backup_runs` — id, hospital_id, repository_id, cluster_ref, type enum(full/differential/incremental/wal_archive/logical_dump/object_sync/pacs_sync), started_at, finished_at, duration_sec, size_bytes, compressed_bytes, throughput_mbs, wal_start, wal_stop, backup_label, checksum, status enum(running/success/failed/partial), error_text, verified_at, verify_status, triggered_by enum(schedule/manual/pre_change), created_at; index (hospital_id, started_at desc), (status).
- `dr_restore_tests` — id, hospital_id, backup_run_id, target_env, restore_type enum(full/pitr/tenant/table), target_time, started_at, finished_at, rto_measured_sec, rpo_measured_sec, smoke_results jsonb (checks[], pass/fail), status, notes, automated bool.
- `dr_restores` (real restores) — id, hospital_id, reason enum(ransomware/corruption/bad_migration/mass_deletion/hardware_failure/drill/other), reason_text, scope, target_time, requested_by, approved_by (dual), environment enum(scratch/staging/production), started_at, finished_at, data_loss_window_sec, reconciliation jsonb (rows, sequences realigned, outbox decision), incident_ref, status, evidence_file_id.
- `dr_drills` — id, hospital_id, scenario_key, scheduled_for, lead_user_id, participants jsonb, status enum(scheduled/in_progress/passed/passed_with_findings/failed/cancelled), detection_at, decision_at, restore_start_at, restore_end_at, app_up_at, verified_at, rpo_achieved_sec, rto_achieved_sec, rpo_target_sec, rto_target_sec, findings jsonb, capa_refs jsonb (NC-015), evidence_file_id, signed_off_by jsonb, completed_at.
- `dr_drill_scenarios` (seed) — key, name, description, steps jsonb (runbook template), expected_duration_min, systems_involved, required_roles.
- `dr_runbooks` — id, hospital_id, key, title, version, markdown_content, applies_to (tier/deployment), last_reviewed_at, reviewed_by, attachments; printable and exported to the offline downtime kit.
- `dr_downtime_events` — id, hospital_id, kind enum(planned/unplanned), cause, started_at, ended_at, duration_min, modules_affected text[], severity, patients_impacted int?, back_entry_status enum(not_required/pending/in_progress/complete), incident_ref, notes.
- `dr_status_snapshot` (materialised, refreshed every 5 min) — hospital_id, last_backup_at, last_backup_status, last_verified_at, pitr_earliest_at, pitr_window_days_actual, replica_lag_sec, repo_health jsonb, last_restore_test_at & result, last_drill_at & result, next_drill_due, immutable_copy_age_h, offline_copy_age_days, overall_posture enum(green/amber/red), issues jsonb.
- `dr_alerts` — id, hospital_id, kind enum(backup_failed/wal_archive_stalled/replica_lag/verify_failed/restore_test_failed/repo_full/immutable_missing/drill_overdue/ransomware_suspected), severity, opened_at, acknowledged_by, resolved_at, detail jsonb.

## 5. Business Rules & Validations

- **Every hospital has an active `dr_policies` row.** A tenant cannot go live (EN-040 licence activation) without a backup policy, at least one off-site repository and one successful verified backup.
- WAL archiving failure for > 15 minutes is P1; if the archive destination is unavailable, WAL overflows to the secondary repo — under no circumstances is archiving disabled to free disk space (that silently destroys PITR).
- A backup is **not counted as valid** until `verify_status='pass'`; the posture indicator uses verified backups only. No verified restore test in 7 days → posture amber; in 30 days → red and reported to Hospital Admin.
- Production restores require dual authorisation, a reason, an estimated data-loss statement, typed confirmation, and automatically create an incident record; they are never possible from a single credential.
- Backups are **always encrypted** (AES-256, key in Vault/KMS, per-tenant DEK); the key is escrowed separately from the backup repository — losing the key loses the data, so key backup and rotation are part of the drill.
- **Data residency**: for Indian tenants, all backup repositories and replicas must be in Indian regions unless the hospital explicitly approves otherwise; the policy records residency and the dashboard flags violations.
- **DPDP erasure vs backups**: erasure requests (EN-028) are executed in live data immediately and recorded as _pending in backups_; backup copies age out within the retention window, and any restore triggers automatic re-application of the erasure queue before the restored data is served. This position is documented and shown to the DPO — never claimed as "already deleted everywhere".
- Retention pruning is frozen automatically when a ransomware indicator or an open forensic incident exists.
- Numbering series and sequences must be reconciled after any restore before financial documents can be issued; the system blocks invoice generation until reconciliation is confirmed (prevents duplicate invoice numbers — a statutory problem).
- Outbox replay after a restore defaults to `suppress_side_effects=true`; sending SMS/payments again requires explicit selection with a preview of affected recipients.
- Drills are mandatory per tier; an overdue drill is a compliance finding, not a soft reminder.
- Backup/restore/drill records are immutable (append-only, audited); nobody — including Super Admin — can edit a drill's measured timings.

## 6. API Surface (`/api/v1/dr`)

| Method         | Path                                                                                           | Purpose                            | Permission                                             | Notes                   |
| -------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ | ----------------------- |
| GET/PUT        | /policy                                                                                        | RPO/RTO tier, schedules, retention | `dr.policy.configure` (IT Admin + Hospital Admin dual) | versioned               |
| GET/POST/PATCH | /repositories ; POST /repositories/:id/test \| /rotate-credentials                             | backup targets                     | `dr.repository.manage`                                 | secrets write-only      |
| GET            | /backups?type&status&from&to ; GET /backups/:id                                                | backup history                     | `dr.backup.read`                                       | cursor                  |
| POST           | /backups/run {type, reason}                                                                    | manual/pre-change backup           | `dr.backup.run`                                        | audited                 |
| POST           | /backups/:id/verify                                                                            | verify integrity                   | `dr.backup.run`                                        |                         |
| GET/POST       | /restore-tests ; POST /restore-tests/run                                                       | automated restore testing          | `dr.restore.test`                                      | scratch env only        |
| GET            | /pitr/window                                                                                   | earliest/latest recoverable time   | `dr.backup.read`                                       |                         |
| POST           | /restores {scope, targetTime, env, reason} ; POST /restores/:id/approve ; GET /restores/:id    | real restore                       | `dr.restore.request` / `dr.restore.approve` (dual)     | typed confirmation      |
| GET            | /restores/:id/reconciliation                                                                   | post-restore reconciliation report | `dr.restore.request`                                   | sequences, outbox, gaps |
| GET/POST/PATCH | /drills ; POST /drills/:id/start\|step\|complete ; GET /drills/:id/evidence.pdf                | DR drills                          | `dr.drill.manage` / `dr.drill.read`                    | evidence pack           |
| GET            | /drill-scenarios ; GET/POST/PATCH /runbooks ; GET /runbooks/:id/print                          | runbooks                           | `dr.runbook.manage` / read                             | offline kit export      |
| GET            | /status                                                                                        | posture dashboard payload          | `dr.status.read` (Hospital Admin, IT, Auditor)         | 5-min cache             |
| GET            | /status/fleet                                                                                  | all tenants (SaaS)                 | `dr.status.fleet` (Super Admin)                        |                         |
| GET/POST       | /downtime-events ; POST /downtime/:id/close                                                    | downtime log & BCP                 | `dr.downtime.manage`                                   |                         |
| POST           | /maintenance-window {start, end, message, readOnly}                                            | planned downtime                   | `dr.maintenance.manage`                                | notifies users          |
| GET            | /alerts ; POST /alerts/:id/ack                                                                 | DR alerts                          | `dr.status.read`                                       |                         |
| GET            | /reports/backup-success ; /reports/rpo-rto ; /reports/drill-history ; /reports/compliance-pack | reports                            | `dr.report.read`                                       | NABH evidence           |

## 7. Domain Events (outbox)

- `dr.backup.started|completed|failed|verified|verify_failed` → EN-037 (IT alert), EN-007 status panel, Super Admin fleet view.
- `dr.wal.archive_stalled|resumed` → P1 alert, EN-023.
- `dr.replica.lag_exceeded|recovered` → IT alert.
- `dr.restore_test.passed|failed` → posture recompute, Quality (evidence).
- `dr.restore.requested|approved|started|completed|failed` → EN-024 audit, incident record, all-user banner when production is affected.
- `dr.drill.scheduled|started|completed|overdue` → NC-015 (CAPA), Quality Manager, Hospital Admin.
- `dr.repository.unreachable|full|immutable_missing|residency_violation` → IT + DPO.
- `dr.ransomware.suspected` → EN-023 P1 incident, retention freeze, Super Admin.
- `dr.downtime.started|ended`, `dr.maintenance.scheduled` → EN-037 broadcast, EN-018 TV banner, PE-001 patient app notice.
- Consumes: `admin.licence.activated` (require policy), `security.incident.opened` (freeze pruning), `patient.data.erasure_requested` (queue for post-restore re-application).

## 8. Screens (UI)

- **DR Posture Dashboard** (desktop; a summary tile also appears on the EN-007 admin home): one honest headline — **green/amber/red** — with the four facts that matter: last verified backup (age), PITR window (earliest recoverable time), replica lag, last drill result & next due. Below: repository cards (used/capacity, off-site, immutable, last write), backup timeline (7/30 days as a heatmap of success/fail), open DR alerts, RPO/RTO target vs last measured.
- **Backup History** (desktop): table (time, type, size, duration, throughput, repo, verify status), filters, run-now button with reason, drill-down to job logs (no PHI).
- **Restore Console** (desktop, deliberately friction-full): step 1 scope, step 2 time picker bounded by the PITR window with the earliest recoverable time shown prominently, step 3 environment, step 4 impact preview ("you will lose approximately 7 minutes of data; 42 bills and 118 clinical notes were created after this point"), step 5 dual approval, step 6 typed hospital-name confirmation. Live progress with phase timings; post-restore reconciliation checklist that must be completed before the system leaves read-only mode.
- **DR Drill Workspace** (desktop/tablet, used live during a drill): scenario brief, run sheet with per-step timers and "start/complete" buttons, participant checklist, notes/screenshot attachment per step, live RPO/RTO calculation, findings capture, sign-off panel, one-click evidence PDF.
- **Runbook Library** (desktop + printable): versioned markdown runbooks (restore primary DB, fail over to standby, rebuild app tier, restore PACS, recover object storage, ransomware response, downtime & back-entry procedure per department) with a "print offline kit" action producing a PDF bundle for the server room and each nursing station.
- **Downtime Manager** (desktop): declare planned/unplanned downtime, choose affected modules, broadcast message and channels, toggle read-only mode, countdown banner for all users, back-entry queue status per department after restoration.
- **Fleet Posture** (Super Admin, desktop): tenant grid with posture chips, sorted worst-first; a tenant with 3 consecutive failed backups is impossible to miss.
- Empty/error states: "No verified restore test in 12 days — schedule one", "Repository repo2 unreachable since 01:40 — WAL is overflowing to repo1", "PITR window is 6 days, below your 35-day target".

## 9. Integrations

- **pgBackRest** (primary), **WAL-G** (alternative), `pg_basebackup --incremental` (PG17, small installs), streaming replication + `pg_rewind`, Patroni/repmgr for automated failover in Platinum/Gold.
- **Object storage**: AWS S3 (Object Lock, cross-region replication, lifecycle to Glacier), Azure Blob (immutability policies), GCS, MinIO on-prem (versioning + WORM + `mc mirror`).
- **Secrets/keys**: HashiCorp Vault / AWS KMS / Azure Key Vault with escrowed root keys; key rotation exercised during drills.
- **Orchestration**: Terraform/Helm for DR-site stand-up, Docker Compose for on-prem all-in-one, GitHub Actions for scheduled restore tests in CI-provisioned scratch environments.
- **Monitoring**: Prometheus exporters (pgBackRest status, replica lag, repo size), Grafana dashboards, Better Stack/uptime probes; alerts to EN-037 and to a phone/on-call rota.
- **PACS** (EN-008/Orthanc) archive sync; **Vault** backup; **log store** (Loki/OpenSearch) retention (EN-023/EN-024).

## 10. Reports & Analytics

- Backup success rate and duration trend, storage growth forecast per repository (with a "you will hit capacity in N weeks" projection), PITR window actual vs target over time, replica lag distribution, restore-test pass rate and measured RTO trend, drill history with achieved vs target RPO/RTO and open CAPA items, downtime register (count, minutes, causes, MTTR), immutable/offline copy age, residency compliance, cost report for backup storage. **NABH/ISO compliance pack** export: policy + schedules + last 12 months of backup evidence + drill reports + BCP runbooks in one PDF.

## 11. Notifications

- IT/on-call: backup failed (immediate), WAL archiving stalled (P1, phone), verify failed, replica lag > threshold, repository > 85 % full or unreachable, restore test failed, immutable copy missing, ransomware indicators.
- Hospital Admin: weekly posture digest, two consecutive backup failures, drill due in 14 days / overdue, production restore requested (approval request), planned maintenance reminder.
- Quality Manager: drill scheduled/completed with evidence link, CAPA items due.
- All users: maintenance countdown banner, "system in read-only mode", "service restored — please complete back-entry of paper records".
- Super Admin: any tenant red posture, fleet-wide anomaly.

## 12. Permissions (RBAC keys)

`dr.policy.configure` (IT Admin + Hospital Admin, dual control) · `dr.repository.manage` (IT Admin) · `dr.backup.read` (IT, Hospital Admin, Auditor) · `dr.backup.run` (IT Admin) · `dr.restore.test` (IT Admin) · `dr.restore.request` (IT Admin) · `dr.restore.approve` (Hospital Admin/Super Admin — must differ from requester) · `dr.drill.manage` (IT Admin, Quality Manager) · `dr.drill.read` (Admin, Quality, Auditor) · `dr.runbook.manage` (IT Admin) · `dr.status.read` (Hospital Admin, IT, Auditor, Medical Superintendent) · `dr.status.fleet` (Super Admin) · `dr.downtime.manage` (IT Admin, Hospital Admin) · `dr.maintenance.manage` (IT Admin) · `dr.report.read` (Admin, Quality, Auditor).

## 13. Non-functional

- Data volumes for a 2000-bed hospital: Postgres ~1.5–3 TB growing ~40–60 GB/month (vitals, audit, messages, orders); object storage ~2–5 TB/year (reports, scans, signed PDFs); PACS 20–60 TB (managed separately). Backup windows must fit: full backup ≤ 4 h with parallel compression (pgBackRest `--process-max`), incremental ≤ 20 min, verify ≤ 1 h.
- Restore performance targets: Gold tier full cluster restore + WAL replay to a chosen point ≤ 60 min for 2 TB (requires ≥ 200 MB/s repo throughput — validated in drills, not assumed); tenant-scoped restore ≤ 30 min.
- Backups must not degrade production: taken from a standby where available, throttled I/O, run in the low-traffic window (02:00–05:00 hospital time), and never during the month-end billing close if that window is configured as protected.
- WAL archive lag alarm at 5 min; replica lag alarm at 30 s (Platinum) / 120 s (Gold).
- Storage: compressed (zstd-3) typically 4–6× reduction; lifecycle moves > 30-day archives to infrequent/cold tiers; immutable copies retained ≥ 14 days.
- Security: encryption at rest and in transit, per-tenant keys, repository credentials with no delete rights, backup infrastructure outside the production admin domain, MFA + step-up for restore approval, all actions audited.
- On-prem constraint: everything above must work with no internet — off-site becomes "second building/branch"; the drill must include a WAN-down scenario.

## 14. Acceptance Criteria

1. Given the backup schedule, when a nightly incremental runs, then a `dr_backup_runs` row records type, size, duration, WAL range and checksum, and the posture dashboard updates within 5 minutes.
2. Given a backup completes, when verification runs, then the backup is marked verified; if verification fails, the posture turns amber, the backup is not counted as valid, and IT is alerted immediately.
3. Given WAL archiving has not succeeded for 15 minutes, when the check runs, then a P1 alert reaches the on-call engineer, WAL overflows to the secondary repository, and archiving is never disabled to reclaim disk.
4. Given the weekly automated restore test, when it runs, then a throwaway instance is created from the latest backup, WAL is replayed to a target time, smoke checks pass, measured RTO/RPO are recorded, and the instance is destroyed.
5. Given a mass-deletion incident at 14:30, when an admin requests PITR to 14:25, then the console shows the estimated data loss and affected record counts, requires a second approver and a typed confirmation, and records an incident.
6. Given a production restore completes, when reconciliation runs, then numbering series and sequences are realigned, invoice generation stays blocked until reconciliation is confirmed, and the outbox replay defaults to suppressing patient-facing side effects.
7. Given a tenant-scoped restore in a multi-tenant cluster, when it executes, then only that hospital's data is recovered and merged through an audited repair job, and other tenants experience no downtime or data change.
8. Given a quarterly drill is scheduled, when the drill is executed, then achieved RPO and RTO are computed from recorded timings, an evidence PDF is generated with participants and findings, CAPA items are created for gaps, and the record cannot be edited afterwards.
9. Given a drill is 31 days overdue, when the compliance check runs, then a finding is raised to the Hospital Admin and Quality Manager and the posture cannot show green.
10. Given a ransomware simulation deletes the primary and repo1, when the drill proceeds, then recovery succeeds from the immutable off-site copy, proving the 3-2-1-1-0 rule, and the immutable copy could not be deleted by the compromised credential.
11. Given an Indian tenant, when a repository is configured outside India without explicit approval, then activation is blocked and a residency violation is raised to the DPO.
12. Given a DPDP erasure request was executed in live data, when a restore from an older backup occurs, then the erasure queue is automatically re-applied before the restored data is served, and the DPO can see the evidence.
13. Given planned maintenance, when the window starts, then users see a countdown banner, the system enters read-only mode, a pre-change backup is taken automatically, and the rollback plan is attached to the change record.
14. Given an unplanned outage of 40 minutes, when service is restored, then the downtime event is logged with cause and modules affected, departments see the back-entry queue, and late-entered records are flagged with their original clinical timestamps.
15. Given the Super Admin fleet view, when any tenant has two consecutive failed backups, then that tenant appears red at the top of the grid and an alert is raised without anyone having to look for it.
16. Given the compliance pack export, when the Quality Manager generates it, then it contains the backup policy, 12 months of backup evidence, restore-test results, drill reports with sign-offs and the BCP runbooks in a single PDF.

## 15. Enhancements / Later phases

- Automated failover with Patroni + etcd quorum and DNS/anycast switching for sub-5-minute RTO; regular "chaos" failover tests in staging.
- Continuous data protection (logical replication into a delayed replica, e.g. 1 h behind) so logical corruption can be recovered without a full PITR cycle.
- Self-service, scoped restore (`dr.self_service_restore`): a department head can restore a single accidentally deleted document/record from a versioned store without an IT ticket, fully audited.
- Backup analytics with anomaly detection (unexpected size/row-count deltas, entropy changes suggesting encryption) feeding EN-023.
- Cross-cloud portability drill: restore an AWS-hosted tenant into Azure/on-prem from the hospital's own bucket, proving no vendor lock-in.
- Immutable audit-trail anchoring (EN-024 hash root published to an external notary/blockchain) so post-incident tampering is provable.
- Automated BCP tabletop exercises with role-play scripts for clinical departments, and printed downtime kits regenerated nightly with current census/drug data.
- Green-computing: storage-tiering optimisation and backup-cost dashboards per tenant (SaaS chargeback).
- Integration with cyber-insurance reporting requirements (evidence bundle on demand).

## 16. Open Questions for the Hospital

1. Deployment model: cloud, on-prem, or hybrid? If on-prem, is there a second building/site for off-site copies, and what is the link bandwidth?
2. Agreed RPO and RTO per system — is 5 minutes / 1 hour acceptable for the HMS core, and what is acceptable for PACS imaging (usually longer)?
3. Available backup storage capacity and budget; is object storage (MinIO/S3) available, and can Object Lock/WORM be enabled?
4. Who is the DR lead and the on-call rota outside working hours? Is 24×7 on-call funded?
5. Drill frequency and who must participate (IT only, or clinical departments too)? Who signs off for NABH?
6. Existing backup tooling and tape/offline media policy — is anything being replaced?
7. Data-residency constraints: must all copies remain in India? Any group entity abroad that would change this?
8. Retention requirements beyond technical PITR: how long must financial, clinical, MLC and minors' records be retrievable, and in what form (live vs archived export)?
9. Downtime procedures today: do departments have paper forms, and who owns the back-entry process after an outage?
10. Maintenance window that is genuinely acceptable to clinical operations (day/time), and any protected periods (month-end billing, audit season).
11. Does the hospital hold cyber insurance with specific backup/DR evidence requirements?
12. Is there an existing BCP/disaster-management plan document to align with, and who owns it?
