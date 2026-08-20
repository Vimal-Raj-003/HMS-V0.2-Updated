# EN-008 — PACS Integration & DICOM Viewer (Orthanc Archive, OHIF Viewer, MWL/MPPS, Storage Tiers, Prior Comparison, Tele-radiology, CD/Share Links, AI Hooks)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Module ID       | EN-008                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Phase           | 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Complexity      | Very High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Depends on      | OP-008 (Radiology & Imaging — orders, scheduling, structured reports; RIS functions of EN-035 merged there), OP-001 (patient MPI/UHID), EN-017 (integration hub, DLQ), EN-007 (devices, roles), EN-024 (audit of image access), EN-016 (radiologist e-sign), PE-001 (patient image share), EN-011 (ABDM DiagnosticReport with image links), NC-020/NC-002 (modality assets, AERB), TR-002/OP-009 (X-ray timeline & comparison), OP-006/TR-001 (trauma CT priority), OP-029/OP-026 (echo/dental DICOM), EN-022 (backup), AI-007 (AI radiology assist), EN-042 (dose from modalities), NC-003 (MRD retention) |
| Feature flag    | `module.pacs.enabled` (sub: `pacs.teleradiology`, `pacs.patient_share`, `pacs.cd_burn`, `pacs.ai_hooks`, `pacs.cloud_tier`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Primary roles   | Radiologist (12), Radiology Technician (36), Radiology admin/PACS admin (IT 56)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Secondary roles | Referring doctors (OPD/IP/ER/Ortho/Surgeon), Cardiologist (echo/cath), Dentist (OPG/CBCT), MRD (43), Biomedical (48), Patient (portal), External tele-radiologist (partner), Auditor                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Regulatory      | DICOM PS3 (C-STORE/C-FIND/C-MOVE, MWL, MPPS, Storage Commitment, DICOMweb WADO-RS/QIDO-RS/STOW-RS), IHE SWF/PIR/PDI (portable data), HL7 v2 ORM/ORU, AERB (dose records, radiation safety), NABH (report TAT, critical findings, image retention), MCI/NMC teleradiology guidance (Telemedicine Practice Guidelines 2020), DPDP (PHI images, share links consent, access audit), retention (adult ≥ 3–5 years, minors till 18+3, medico-legal permanent per hospital policy/CEA), PC-PNDT (no fetal sex disclosure; USG records retention 2 years+)                                                         |

## 1. Purpose

EN-008 provides the imaging backbone: an Orthanc-based DICOM archive (on-prem primary, S3 tiers), modality worklist (MWL) fed from OP-008 orders, MPPS/status feedback, DICOMweb access, an embedded zero-footprint OHIF viewer (window/level, zoom/pan, measurements, annotations, multi-frame, MPR basic, cine), automatic prior-study fetch and side-by-side comparison, image-report integration in the radiologist worklist, tele-radiology for remote reporting, patient CD/DVD or time-limited share links, and hooks for AI assistance (AI-007) — for a trauma centre where CT/X-ray availability within minutes is safety-critical.

## 2. Users & Jobs-to-be-done

- **Radiology technician** (modality console + desktop): select patient from MWL at scanner (no retyping), acquire, verify images arrived in PACS, fix mismatches (wrong patient/accession), QC reject/repeat, dose capture.
- **Radiologist** (dual monitor desktop, tablet for review): reading worklist by priority, open study in OHIF beside report editor (OP-008), compare priors, measure/annotate, key images, dictate/type, sign; STAT trauma CT within minutes.
- **Referring doctor** (desktop/tablet/phone): open images from patient timeline/OP-002/IP rounds; ortho X-ray timeline (TR-002); ER trauma quick view.
- **PACS admin / IT**: modality registration (AE titles), MWL config, storage tiers, routing rules, monitoring, patient/study reconciliation, retention/purge, DR.
- **Patient**: view/download own images via portal share link or CD; QR on report.
- **Tele-radiologist**: secure remote worklist and viewer, sign report.

## 3. Core Workflows

### 3.1 Modality & network setup

1. PACS admin registers **modalities** (CT/MR/CR/DX/US/MG/XA/NM/OPG/CBCT/Echo/endoscopy capture): AE title, IP, port, modality type, department/room, asset link (NC-020), supported services (MWL query, MPPS, storage commitment), dose reporting (RDSR/OCR) → `pacs_modalities` → configured in Orthanc (`DicomModalities`) via its REST API by the integration hub → Event `pacs.modality.registered`.
2. Orthanc deployment: primary per branch/campus (on-prem, near modalities) with PostgreSQL index plugin, S3 storage plugin (`pacs.cloud_tier`), DICOMweb plugin, Worklists plugin (MWL directory), Orthanc-Explorer disabled for users; HA pair (active/passive) + `pacs.cloud_tier` replication to central/cloud archive; per-tenant isolation (separate Orthanc per hospital or label-based partitioning with strict app-layer checks — see AC).
3. Routing rules: auto-forward to central archive, to tele-radiology partner, to AI service; compression (JPEG 2000 lossless for long-term tier); anonymisation profiles for research/AI.

### 3.2 Modality Worklist (MWL) & study lifecycle

1. OP-008 order scheduled/arrived → RIS emits `rad.order.scheduled` → hub creates **MWL entry** (Orthanc worklist file: patient name, UHID as PatientID, DOB, sex, accession no, requested procedure code/description, modality, scheduled station AE, scheduled date/time, referring physician, priority, pregnancy/allergy flags in comments) → modality queries MWL (C-FIND) → technologist selects → demographics auto-populated at scanner (zero typing).
2. **MPPS**: modality sends N-CREATE (in progress) → OP-008 status `in_progress`; N-SET (completed/discontinued) → `acquired`/`discontinued` (with reason) → worklist entry removed; if modality lacks MPPS, arrival of first image (C-STORE) triggers `acquired`.
3. Images C-STORE → Orthanc → Lua/HTTP callback → hub ingests metadata (`pacs_studies`, `pacs_series`, `pacs_instances` summary), **matches by accession no** (fallback: PatientID+date+modality) → link to OP-008 order → status `images_available` → radiologist worklist updated; storage commitment N-ACTION acknowledged → modality may purge.
4. **Study completion check**: expected series count/time window per protocol; incomplete → tech alert; QC: reject/repeat images tagged (KO/PR), retake reasons for dose audit.
5. Dose: RDSR (Radiation Dose Structured Report) or dose screen OCR → `pacs_dose_records` (CTDIvol, DLP, DAP, kVp/mAs) → OP-008 dose tracking/AERB, cumulative patient dose alerts.

### 3.3 Reconciliation & corrections

- **Unmatched studies** (no accession, wrong PatientID, emergency "trauma unknown" patients): reconciliation queue → tech/PACS admin merges to correct patient/order (Orthanc modify with audit; original tags preserved in `pacs_corrections`); patient merges from OP-001 MPI propagate (`patient.merged` → re-tag studies); split/move series between studies; wrong-patient safety flow with radiologist notification if already reported.

### 3.4 Viewing (OHIF)

1. Any authorised screen calls **viewer launch** with study UID(s) → server issues short-lived signed DICOMweb token (scoped to study/patient, 15 min, renewable) → OHIF loads via QIDO/WADO-RS through the API gateway (never direct Orthanc exposure) → tools: window/level presets (bone/lung/brain/soft tissue), zoom/pan/rotate/flip, invert, measurements (length, angle, Cobb, ROI, HU, pixel probe), annotations/arrows/text, cine for XA/US, multi-frame scroll, **MPR** (axial/coronal/sagittal) basic, MIP, reference lines, hanging protocols per modality/body part, key image marking (KOS), presentation states (GSPS) saved back (STOW-RS) → Event `pacs.study.viewed` (audit with user, role, purpose/break-glass).
2. **Prior comparison**: on open, system queries priors for same patient (MPI) filtered by anatomy/modality relevance (body part/procedure code map, configurable window) → auto-hangs current vs prior side-by-side; ortho X-ray timeline (TR-002/OP-009) uses the same API to show serial films with dates.
3. Non-DICOM: clinical photos/scanned films/echo videos converted to DICOM (secondary capture/encapsulated) via upload with patient/accession selection; JPEG/MP4 previews.
4. Mobile/tablet: OHIF responsive; low-bandwidth mode (progressive JPEG, thumbnails first); phone shows key images + report.
5. Referring doctors and patients get read-only tools; radiologists full toolset; annotations saved as GSPS with author.

### 3.5 Radiologist worklist & report integration

- OP-008 owns the reading worklist and structured reporting; EN-008 supplies: study status/thumbnails, viewer launch, key images embedding into report PDF, comparison metadata ("compared with CT 12-Mar-2026"), report → PACS as **DICOM SR/encapsulated PDF** (optional) so external viewers see the report; critical finding flag from viewer → OP-008 alert workflow.

### 3.6 Tele-radiology (`pacs.teleradiology`)

- Partner radiologist accounts (external role, MFA, IP allowlist optional) → filtered worklist (assigned studies) → viewer over HTTPS (no VPN needed; VPN optional) → report in OP-008 with digital signature (EN-016) → SLA timers (STAT 30 min, routine 24 h) → auto-assignment rules (night hours, modality) → studies optionally pushed (DICOM TLS/DICOMweb) to partner PACS with return of report via HL7 ORU/FHIR; audit of external access; billing/payout per study (NC-034).

### 3.7 CD/DVD burn & share links

1. Patient/doctor requests images → **share link** (`pacs.patient_share`): select studies → consent (EN-028) → generates time-limited (default 7 days), OTP-protected link (portal or WhatsApp/SMS) to a patient-viewer (OHIF read-only, download DICOM ZIP + JPEG) → access logged; revoke; QR printed on report.
2. **CD/DVD/USB** (`pacs.cd_burn`): IHE PDI export (DICOMDIR + lightweight viewer + report PDF) via burn station agent (EN-005-like device) or ISO download; register issuance (who, when, patient sign) → `pacs_media_issues`.
3. Cross-institution: DICOMweb/DICOM TLS push to another hospital with patient consent (referral/transfer IP-018) — enhancement.

### 3.8 Storage tiers, retention & DR

- Hot (local NVMe/SSD, last 6–12 months, uncompressed), warm (S3/MinIO, JPEG-2000 lossless), cold (S3 Glacier/Deep Archive) with **retrieval on demand** (prefetch when appointment/admission scheduled for patients with archived studies — "prior prefetch job"); retention per modality/patient class (adult/minor/MLC) with legal hold; purge with approval & audit; nightly integrity (checksums), replication to DR site (EN-022), restore drills.

### 3.9 AI hooks (`pacs.ai_hooks`, AI-007)

- Routing of studies (by modality/body part) to AI endpoints (DICOMweb/REST) → results as DICOM SR/segmentation/secondary capture back to PACS with "AI-preliminary" flag → worklist priority bump for suspected critical findings (e.g. ICH on CT head, pneumothorax on CXR) → radiologist confirms in report (never auto-final).

### 3.10 Exceptions

- Network outage between modality and Orthanc: modality buffers; hub alerts; MWL cached at Orthanc so scanning continues; RIS status catches up on reconnect.
- Orthanc down: failover to passive; viewer shows "archive unavailable" with retry; new studies buffered on modalities.
- Emergency unknown patient: temporary UHID (OP-006) → later merge (3.3).

## 4. Data Model (schema `rad`, prefix `pacs_`; Orthanc has its own DB — this is the HMS index/metadata)

- `pacs_servers` — id, hospital_id, branch_id, name, base_url (internal), dicom_aet, dicom_port, role (primary/replica/central/partner), storage_tier_config jsonb, status, last_heartbeat.
- `pacs_modalities` — id, hospital_id, branch_id, aet, ip, port, modality_type, room, asset_id, mwl_enabled, mpps_enabled, storage_commit, dose_capture (rdsr/ocr/manual), tls, active.
- `pacs_studies` — id, hospital_id, branch_id, study_instance_uid UNIQUE, patient_id (MPI), uhid_at_acquisition, accession_no, order_id (OP-008), modality, body_part, study_date, description, series_count, instance_count, size_bytes, status (scheduled/in_progress/acquired/incomplete/reported/archived/purged/legal_hold), tier (hot/warm/cold), orthanc_id, server_id, matched_by (accession/fallback/manual), reconciliation_status, key_images jsonb, ai_status, created_at…; index (hospital_id, patient_id, study_date desc), (accession_no).
- `pacs_series` — study_id, series_uid, modality, body_part, description, instance_count, sop_class, rejected bool; `pacs_instances_summary` (optional counts only; instance-level in Orthanc).
- `pacs_mwl_entries` — order_id, accession_no, patient snapshot jsonb, modality_aet, scheduled_at, status (pending/queried/in_progress/completed/cancelled), file_ref, created/updated.
- `pacs_mpps` — study_id/accession, sop_instance_uid, status, started_at, ended_at, discontinue_reason, modality_aet.
- `pacs_access_tokens` — id, user_id/patient_id, study_uids[], scope (view/download), expires_at, revoked, purpose (care/break_glass/patient_share/telerad).
- `pacs_view_audit` (or EN-024) — token_id, user_id, study_id, action (view/download/export/annotate), at, ip; partitioned monthly.
- `pacs_priors_map` — procedure_code/body_part → relevant procedure codes/body parts, lookback_days.
- `pacs_share_links` — id, hospital_id, patient_id, study_ids[], created_by, consent_id, otp_hash, expires_at, max_views, views, revoked_at, channel; `pacs_media_issues` — patient_id, study_ids[], media_type (cd/dvd/usb/iso), issued_to, issued_by, at, signature_file_id.
- `pacs_telerad_assignments` — study_id, partner_id/user_id, assigned_at, due_at, status, sla_class, pushed (bool), report_received_at.
- `pacs_dose_records` — study_id, patient_id, modality, ctdi_vol, dlp, dap, kvp, mas, exposure_count, source (rdsr/ocr/manual), acquired_at.
- `pacs_corrections` — study_id, type (reassign_patient/merge/split/tag_fix/reject), before jsonb, after jsonb, reason, by, at, orthanc_job_id.
- `pacs_retention_policies` — hospital_id, modality/patient_class, hot_days, warm_days, retain_years, legal_hold_rules; `pacs_purge_log`.
- `pacs_ai_jobs` — study_id, model_key, sent_at, result_at, status, findings jsonb, priority_bump bool.
- `pacs_routing_rules` — match jsonb (modality, aet, body_part), actions jsonb (forward_to, compress, anonymise, ai_route).

## 5. Business Rules & Validations

- PatientID in DICOM = UHID; accession no from OP-008 order; MWL entries only for scheduled/arrived orders; entries expire 24 h after schedule (configurable) → tech must reschedule.
- Study auto-links only when accession matches; fallback match creates `reconciliation_status=needs_review` (never silently attach to wrong patient); mismatched sex/DOB (> tolerance) forces review.
- Viewer access only through signed short-lived tokens; direct Orthanc ports not exposed beyond hub/viewer gateway; every view logged; break-glass (outside care team) requires reason (EN-007/24).
- Tenant isolation: per-hospital Orthanc instance recommended; if shared, every DICOMweb request is filtered by hospital label and studies of another tenant return 404 (tested).
- Prior comparison lookback default 5 years, filtered by body-part map; MLC studies flagged and require `rad.mlc.read`.
- Share links: consent mandatory (patient or guardian), OTP to registered mobile, max 7 days/10 views default, revocable; downloads watermarked JPEG with patient/UHID; DICOM ZIP unaltered.
- Tele-radiologist sees only assigned studies (ABAC `assigned_studies_only`), external accounts MFA + optional IP allowlist; report signature required (EN-016).
- Retention: never purge MLC/legal-hold; minors until 18 + 3 years; adults ≥ 5 years (configurable per policy); purge requires two approvals and writes to purge log; DR replication lag alarm > 15 min.
- Dose alerts: cumulative CTDIvol/DLP thresholds per patient (paediatric stricter) → OP-008 alert; AERB dose register export.
- AI results are advisory; report cannot be auto-finalised by AI; AI SR stored with `AI-preliminary` marker.
- PC-PNDT: obstetric USG studies restricted from patient share unless enabled by policy; no fetal sex fields.

## 6. API Surface (`/api/v1/pacs`)

| Method          | Path                                                                                               | Purpose                      | Permission                                               | Notes                          |
| --------------- | -------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------- | ------------------------------ |
| GET/POST/PATCH  | /servers ; /modalities ; POST /modalities/:id/echo (C-ECHO)                                        | config                       | rad.pacs.configure                                       |                                |
| POST            | /mwl (from OP-008 event) ; DELETE /mwl/:accession ; GET /mwl?modality&date                         | worklist                     | rad.pacs.mwl.manage / read                               | idempotent on accession        |
| POST            | /events/orthanc (webhook: new study/series/instance, MPPS)                                         | ingestion callbacks          | internal (hub)                                           | signed                         |
| GET             | /studies?patientId&from&to&modality&status ; GET /studies/:uid ; GET /patients/:id/studies         | study index                  | rad.study.read (+care-team ABAC)                         | cursor                         |
| GET             | /studies/:uid/priors                                                                               | relevant priors              | rad.study.read                                           |                                |
| POST            | /viewer/token {studyUids[], purpose, reason?}                                                      | signed viewer/DICOMweb token | rad.image.view (break-glass reason if outside care team) | 15 min                         |
| GET             | /dicomweb/… (QIDO/WADO/STOW proxy)                                                                 | viewer data                  | token                                                    | gateway to Orthanc             |
| POST            | /studies/:uid/key-images ; /studies/:uid/annotations (GSPS)                                        | save markings                | rad.image.annotate                                       | STOW                           |
| POST            | /studies/:uid/report-object (SR/PDF push)                                                          | report to PACS               | rad.report.sign (OP-008)                                 |                                |
| GET/POST        | /reconciliation ; POST /reconciliation/:id/assign {patientId, orderId} ; POST /studies/:uid/reject | split                        | merge                                                    | corrections                    | rad.pacs.reconcile | audited |
| POST            | /upload (non-DICOM → DICOM)                                                                        | secondary capture            | rad.image.upload                                         | patient/accession required     |
| POST/GET/DELETE | /share-links ; /share-links/:id ; POST /share-links/:id/revoke ; POST /public/share/:code/otp      | open                         | patient share                                            | rad.image.share ; public (OTP) | consent id         |
| POST/GET        | /media-issues ; POST /studies/:uid/export?format=pdi                                               | zip                          | jpeg                                                     | CD/USB/export                  | rad.image.export   | audited |
| GET/POST/PATCH  | /telerad/assignments ; POST /telerad/push/:studyUid                                                | tele-radiology               | rad.telerad.manage / rad.telerad.read (partner)          |                                |
| GET/POST        | /dose ; /dose/patient/:id/cumulative                                                               | dose                         | rad.dose.read/record                                     |                                |
| GET/PUT         | /retention-policies ; POST /purge/preview ; POST /purge/execute                                    | retention                    | rad.pacs.retention (dual approval)                       |                                |
| GET/POST        | /routing-rules ; /ai/jobs ; POST /ai/route/:studyUid                                               | routing/AI                   | rad.pacs.configure / rad.ai.read                         |                                |
| GET             | /health ; /metrics (storage by tier, ingest lag, replication lag)                                  | monitoring                   | rad.pacs.read                                            |                                |

## 7. Domain Events (outbox)

- `pacs.modality.registered|offline|online`, `pacs.server.degraded|failover`.
- `pacs.mwl.created|updated|removed`.
- `pacs.study.in_progress|acquired|incomplete|images_available|reported_object_stored|archived|restored|purged` → OP-008 status, EN-018 radiology board, referring doctor notification (images ready).
- `pacs.study.unmatched|reconciled|rejected|merged` → OP-008, OP-001 (patient merge feedback).
- `pacs.study.viewed|downloaded|exported|shared` → EN-024 audit.
- `pacs.share_link.created|opened|expired|revoked`, `pacs.media.issued`.
- `pacs.telerad.assigned|pushed|report_received|sla_breached` → OP-008, EN-037.
- `pacs.dose.recorded|threshold_exceeded` → OP-008, NC-020 (AERB).
- `pacs.ai.result_received|critical_flag` → OP-008 worklist priority, EN-037.
- `pacs.replication.lagging|restored` → IT.

## 8. Screens

- **Embedded OHIF viewer** (desktop dual-monitor, tablet, phone read-only): toolbar (W/L presets `1-5`, zoom `Z`, pan `P`, measure `M`, annotate `A`, MPR `Ctrl+M`, cine `Space`, next/prev series `←/→`, scroll wheel slices, key image `K`, compare `C`), hanging protocol per modality, prior thumbnails rail, report side panel (OP-008), critical-finding button, patient banner with allergy/pregnancy/MLC flags; low-bandwidth toggle; loading progressive; error "archive unavailable" with retry.
- **PACS Admin Console** (desktop): servers/modalities health, C-ECHO, ingest lag, storage by tier, replication, routing rules, retention/purge, reconciliation queue (unmatched studies with candidate patients), corrections log.
- **Technologist Study Board** (desktop/tablet by modality): MWL today, in-progress, images received/incomplete, QC reject/repeat, dose entry, send-to-radiologist; `F5` refresh not needed (real-time).
- **Study Browser** (desktop, inside patient chart/OP-008): studies list with thumbnails, status, report link, open in viewer, compare selection, share/export actions.
- **Prior comparison view**: 2×1/2×2 layouts, synced scroll/zoom, date labels; ortho timeline strip (TR-002).
- **Share & Media desk** (desktop): create link, consent capture, OTP channel, expiry, revoke; CD/USB issue register with signature pad; QR on report.
- **Tele-radiology portal** (desktop, external): assigned worklist, SLA timers, viewer, report editor, sign.
- **Patient share viewer** (phone/desktop public): OTP gate, simple viewer, download, expiry notice.
- Offline: viewer requires connectivity; key images cached in report PDF for offline reading (IP-004).

## 9. Integrations

- Orthanc (REST/Lua/plugins: PostgreSQL, S3, DICOMweb, Worklists, Transfers, WSI/other as needed), OHIF v3 (custom extension for HMS auth/token, hanging protocols, report panel), DICOM TLS to modalities/partners, HL7 v2 (ORM/ORU via EN-019 for legacy RIS/modalities), FHIR ImagingStudy for ABDM DiagnosticReport (EN-011), CD burn station agent (Windows) using PDI export, dose (RDSR/OCR/EN-042), AI vendors (DICOMweb/REST; AI-007), EN-022 replication/DR, EN-016 e-sign, EN-009 share link delivery, NC-034 tele-radiology payouts.

## 10. Reports & Analytics

- Studies per modality/day, MWL usage % (studies with accession match), unmatched rate & reconciliation TAT, image availability TAT (order → images, images → report from OP-008), storage growth per tier, retrieval from cold, viewer usage & access audit (who viewed which study), share links issued/opened, CD/USB issued, tele-radiology SLA compliance & volumes, dose registers (AERB), reject/repeat rate per modality/technologist, AI triage stats. MVs `analytics.mv_pacs_daily`.

## 11. Notifications

- Referring doctor: images available (push/in-app), STAT trauma CT available (push + TV OT/ER board), AI critical flag (to radiologist).
- Tech/PACS admin: unmatched study, incomplete study > X min, modality offline, storage > 85 %, replication lag, purge approvals.
- Patient: share link (WhatsApp/SMS with OTP), link expiring.
- Tele-radiologist: assignment, SLA warning.

## 12. Permissions (RBAC keys)

`rad.pacs.configure` (PACS admin/IT) · `rad.pacs.read` · `rad.pacs.mwl.manage/read` (system, tech) · `rad.pacs.reconcile` (tech lead, PACS admin) · `rad.study.read` (clinicians care-team; ABAC) · `rad.image.view` (clinicians; break-glass reason) · `rad.image.annotate` (radiologist, referring doctor limited) · `rad.image.upload` (tech) · `rad.image.share` (radiology desk, doctor with consent) · `rad.image.export` (radiology desk, MRD; audited) · `rad.telerad.manage` (radiology admin) · `rad.telerad.read` (partner, assigned only) · `rad.dose.record/read` · `rad.pacs.retention` (PACS admin + Hospital Admin dual) · `rad.ai.read` · `rad.mlc.read` (radiologist, ER, MLC officer) · patient self-scope via PE-001.

## 13. Non-functional

- Volumes: 2000-bed trauma centre ~1500 studies/day (CT 300, CR/DX 800, US 300, MR 60, others), ~150 GB/day ingest, 40 TB/year; ingest-to-worklist < 10 s after last image; first image in viewer < 2 s on LAN, < 5 s on 20 Mbps WAN (progressive); prior query < 500 ms; MWL query response < 1 s.
- Orthanc HA (active/passive with shared PG index + S3), RPO ≤ 5 min via replication, RTO ≤ 1 h; storage encryption at rest (S3 SSE/LUKS), TLS in transit; DICOM TLS where modalities support.
- Viewer works on tablets (touch gestures) and phones (read-only), Chrome/Edge/Safari; WCAG for UI chrome (not images); i18n UI.
- Security: no direct Orthanc exposure, signed tokens, rate limits, view audit; anonymisation profiles for research/AI.

## 14. Acceptance Criteria

1. Given a CT order scheduled in OP-008, when the modality queries MWL, then the patient (UHID, name, DOB, sex, accession, procedure) is returned within 1 s and the technologist does not type demographics.
2. Given the modality sends MPPS in-progress and completed, when received, then the OP-008 order status moves to in_progress → acquired and the MWL entry disappears.
3. Given images arrive with a matching accession, when ingested, then the study links to the order, status becomes images_available within 10 s of the last image, and the radiologist worklist updates in real time.
4. Given a study arrives with no accession and PatientID mismatch, when ingested, then it appears in the reconciliation queue and is not attached to any patient chart until a tech assigns it (audited).
5. Given a radiologist opens a chest CT, when the viewer loads, then relevant priors (chest CT/CXR within 5 years) auto-hang side-by-side and the report panel shows the prior date.
6. Given a referring doctor outside the care team, when opening images, then a break-glass reason is required and a `READ_PHI` audit row with study UID is written.
7. Given a signed viewer token expired, when the viewer requests WADO-RS, then it gets 401 and silently renews only if the session is still valid.
8. Given a patient share link created with consent, when opened, then OTP to the registered mobile is required, views count, and after expiry/revoke the link returns "expired".
9. Given a CD export, when generated, then it contains DICOMDIR + viewer + report PDF (IHE PDI) and an issue record with signature exists.
10. Given a tele-radiologist assigned 3 studies, when logging in, then only those studies are listed and other studies return 404 by UID.
11. Given cumulative paediatric CT dose exceeding threshold, when a new dose record is stored, then OP-008 receives a dose alert.
12. Given a purge preview for studies older than policy, when executed, then MLC/legal-hold studies are excluded, two approvals are recorded, and the purge log lists study UIDs.
13. Given the primary Orthanc fails, when the viewer requests a study, then it is served from the passive/replica within RTO and IT receives failover alert.
14. Given an AI critical flag on CT head, when received, then the study moves up the radiologist worklist and the report cannot be finalised without radiologist confirmation.
15. Given a shared Orthanc with two tenants, when tenant A requests tenant B's study UID via DICOMweb proxy, then 404 is returned and an audit event recorded.
16. Given a patient merge in OP-001, when processed, then studies of the duplicate are re-tagged to the surviving UHID and a correction record is written.

## 15. Enhancements / Later phases

- AI preliminary read for critical findings (AI-007, `pacs.ai_hooks`), cloud PACS with edge caching (`pacs.cloud_tier` + edge Orthanc), 3D printing exports (STL from segmentation), patient imaging portal with annotations & education overlays, cross-institution DICOMweb sharing (IHE XDS-I/XCA-I), advanced visualisation (volume rendering, vessel analysis, dental CBCT tools), speech-to-report (AI-004), radiology peer review workflow (RADPEER), structured dose management (DoseWatch-like), mammography (MG) hanging protocols/CAD, digital pathology WSI archive, ECG/echo DICOM waveform viewing (OP-029), Orthanc TLS/DICOM audit (ATNA).

## 16. Open Questions for the Hospital

1. Modalities list (make/model, DICOM conformance: MWL/MPPS/storage commitment/RDSR support), network layout, existing PACS to migrate (volume TB, format)?
2. On-prem storage capacity/hardware and cloud tier preference (AWS/Azure/MinIO); retention years per modality; MLC policy.
3. Radiologist reporting setup: on-site vs tele-radiology partners (names, hours, SLA), dual monitor availability.
4. Patient image sharing policy: links allowed? CD/USB charges? Consent wording; obstetric USG sharing (PC-PNDT).
5. Referring doctors' image access outside care team (break-glass) acceptable to management?
6. Dose management: RDSR available? AERB reporting format currently used?
7. AI vendors under consideration (CXR/CT head triage) and data-sharing constraints (anonymisation)?
8. Non-DICOM sources (endoscopy, dermatology photos, dental sensors) to be archived in PACS?
