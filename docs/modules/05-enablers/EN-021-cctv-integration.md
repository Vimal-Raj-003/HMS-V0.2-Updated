# EN-021 — CCTV Integration (ONVIF/RTSP Camera Registry, Feed Dashboard, HMS Event Tagging & Bookmarks, Retention, Privacy Zones / No-Record Areas, Access Audit)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Module ID       | EN-021                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Phase           | 9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on      | NC-019 (Security Management — incidents, the primary business consumer), EN-015 (gate/visitor events to bookmark), EN-017 (VMS/NVR connectors, ONVIF adapters, retries), EN-007 (roles, device tokens, settings), EN-024 (audit — every view/export is an audited access), EN-028 (patient/staff privacy notices), EN-023 (camera network segmentation, firmware vulnerabilities), EN-022 (footage retention & backup policy), EN-018 (security wall board), TR-008 (MLC/forensic evidence chain of custody), IP-013 (code blue location bookmark), NC-016 (BMW storage area monitoring), NC-006 (store/pharmacy narcotic cupboard monitoring), OP-003/IP-014 (narcotic room), IP-007 (blood bank)                                                                                                                                                                                                                                                                      |
| Feature flag    | `module.cctv.enabled` (sub: `cctv.live_view`, `cctv.playback`, `cctv.export`, `cctv.anpr`, `cctv.analytics`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Primary roles   | Security Officer / Guard (51), Security Supervisor, IT Admin (56 — camera fleet & network)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Secondary roles | Hospital Admin (policy, export approval), Privacy Officer / DPO (57 — privacy zones, access audit), Quality Manager (54 — incident review), Nursing Supervisor (22 — restricted, incident-scoped only), Auditor (58), Police/court (via a controlled export process, never direct access)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Regulatory      | DPDP Act 2023 & Rules 2025 (CCTV footage of identifiable persons is personal data — notice at every entry point, purpose limitation to safety/security, storage limitation, access control, breach reporting), Supreme Court _Puttaswamy_ privacy proportionality, **no cameras in areas of intimate privacy** (toilets, changing rooms, labour room delivery area, examination/consultation rooms, ICU bed spaces where the patient is exposed, breastfeeding rooms) — a hard rule under privacy law and hospital ethics, IT Act §65B (electronic evidence certificate for court-admissible footage), CrPC/BNSS evidence handling & chain of custody (with TR-008), NABH FMS (security surveillance of sensitive areas: pharmacy narcotics, blood bank, records room, cash counters, mortuary, entries), state Clinical Establishment security requirements, Aadhaar/biometric rules do **not** apply unless facial recognition is enabled (then DPDP + DPIA required) |

## 1. Purpose

EN-021 connects the hospital's existing CCTV/VMS estate to the HMS: a camera registry with location mapping, a live-feed dashboard for the security console and gate screens, automatic **bookmarking of HMS events** onto camera timelines (gate entries, code blue, narcotic cupboard opening, cash counter refunds, incident reports) so an investigator can jump straight to the relevant footage, retention and export governance with a full access audit, and enforcement of **privacy zones and no-record areas** so surveillance never crosses into places the law and clinical ethics forbid.

## 2. Users & Jobs-to-be-done

- **Security Guard** (console/wall screen): watch live tiles of the assigned gates and corridors; jump to a camera from an alert.
- **Security Supervisor** (desktop): investigate an incident — open the incident (NC-019), see auto-linked bookmarks, scrub playback, mark evidence, request an export with approval.
- **IT Admin**: register cameras and NVRs, monitor which cameras are offline or have drifted clocks, keep firmware patched (EN-023), manage the segregated camera VLAN.
- **Privacy Officer**: verify that no camera covers a prohibited area, review privacy-zone masks, run the quarterly access-audit report, handle a patient's query about footage.
- **Quality/Medico-legal**: obtain a certified export for an MLC case or a court summons through the documented, audited process.
- **Nursing Supervisor**: view a specific corridor clip attached to a fall/violence incident — scoped to that incident only, never open browsing.

## 3. Core Workflows

### 3.1 Camera & VMS registration

1. IT Admin registers an **NVR/VMS** (Hikvision, Dahua, CP Plus, Milestone XProtect, Genetec, Axis Camera Station, or a plain ONVIF NVR): type, base URL/IP, API credentials (Vault), protocol (ONVIF Profile S/G/T, vendor REST API, RTSP-only), stream limits, recording server details, timezone → EN-017 connector.
2. **Camera discovery** via ONVIF WS-Discovery on the camera VLAN, or manual entry: name, code, model, RTSP URLs (main + sub stream), resolution/fps, PTZ capability, audio capability (default **audio disabled** — recording audio in a hospital raises consultation-confidentiality problems), location (building/floor/zone/room), **area classification** (public/semi-public/restricted/**prohibited**), field-of-view note, mounted-on-map coordinates.
3. **Privacy classification gate**: a camera whose location is classified `prohibited` (toilet, changing room, labour delivery area, consultation/examination room, ICU bed space, breastfeeding room, mortuary viewing room) cannot be activated — the registration is blocked with a mandatory Privacy Officer review; cameras adjacent to such areas must define **privacy masks** (ONVIF/vendor mask regions) or a **no-record schedule**.
4. Activation requires: signage confirmation (a photo of the "CCTV in operation" notice at the area entry, per DPDP notice duty), a stated purpose, a retention period, and the Privacy Officer's sign-off for restricted areas → Event `cctv.camera.activated`.
5. Health monitoring: reachability probe + stream check every 60 s; alerts on offline, no-recording, disk full on the NVR, clock drift > 60 s (evidence integrity depends on accurate time), tamper/blur/scene-change detection where the camera supports it.

### 3.2 Live view

- The security console requests a stream: the server issues a **short-lived signed URL** to a transcoding/proxy endpoint (RTSP → WebRTC or HLS/LL-HLS) — the browser never receives raw NVR credentials, and cameras are never exposed directly to the user network.
- Layouts: 1/4/9/16-tile grids per role and location, saved views, PTZ controls where permitted (with an operator lock so two people don't fight over one camera), sequence/tour mode, single-click "open on wall board" (EN-018).
- Every live-view session writes an access record (who, which cameras, from when to when, from which IP).

### 3.3 HMS event tagging & bookmarks

1. Configured HMS events create **bookmarks** on the mapped cameras' timelines: `gatepass.visitor.checked_in|checked_out`, `gatepass.vehicle.entered|exited`, `gatepass.violation.recorded`, `display.code.activated` (Code Blue/Pink/Red with location), `nc.incident.reported` (NC-019/NC-015), `pharmacy.narcotic.cupboard_opened`, `billing.refund.approved` / cash-counter shortfall (NC-001), `blood.component.issued` (IP-007), `asset.moved_out` (EN-015 material pass), `mortuary.body.released` (IP-017), `bmw.consignment.dispatched` (NC-016), `er.mass_casualty.declared` (OP-006).
2. Mapping is configuration: `event_type + location scope → camera set + pre-roll/post-roll seconds` (defaults 30 s pre / 120 s post).
3. A bookmark stores: event reference, camera ids, start/end timestamps, a text label, and a **link**, not a copy — footage stays on the NVR unless explicitly exported (avoids duplicating PHI-adjacent video into the HMS).
4. In the incident screen (NC-019) or a gate register row, the user sees "3 linked camera clips" and can open playback at the exact moment, subject to permission.
5. Optional **auto-preservation**: high-severity events (violence, theft, MLC, infant abduction Code Pink) mark the associated footage segments as **protected from retention deletion** until an investigator releases them.

### 3.4 Playback, evidence export & chain of custody

1. Playback (`cctv.playback`) requires a **reason** (incident id, MLC number, or free text) — no unexplained browsing of recorded footage; the reason and the exact time range viewed are audited.
2. **Export** (`cctv.export`) is a request → approval workflow: requester states purpose (internal investigation / police requisition / court summons / insurance / patient request), legal reference (FIR/summons number), time range, cameras → approver = Hospital Admin + Privacy Officer (police/court requests additionally require the written requisition attached) → export job produces a watermarked file (case id, exporter, timestamp overlay) plus a **hash (SHA-256) manifest** and, where needed, a **§65B certificate** template for court admissibility (TR-008 links it into the medico-legal file).
3. Chain of custody: every export is logged with requester, approver, purpose, recipient, handover mode (encrypted USB / secure link), acknowledgement, and the file hash; the recipient's acknowledgement is stored.
4. Exports expire: download links valid 72 h; internally stored copies auto-purge after the case closes + retention.

### 3.5 Retention & privacy enforcement

- Retention per **area class** (default: public areas 30 days, restricted areas 90 days, cash/narcotics/blood bank 90 days, gates 90 days) enforced by the NVR's own policy with EN-021 monitoring compliance and alerting on drift (e.g. disk full causing early overwrite).
- **No-record areas/zones**: hard blocks in the registry, ONVIF privacy masks pushed to the camera where supported, and a scheduled **no-record window** for cameras covering multi-use spaces (e.g. a hall used for a health camp with screening booths).
- **Signage register**: a record of notices displayed at each area entry (photo + location + language), reviewed annually — DPDP notice evidence.
- Quarterly **privacy audit**: a report of all cameras with their area class, masks, retention, last review date, and any access anomalies (out-of-hours viewing, high-volume viewers, viewing without an incident reference).

### 3.6 Exceptions

- **Camera offline** → alert with duration; if the camera covers a critical area (narcotics, cash, blood bank, main gate), escalate to the Security Supervisor within 15 min and record downtime for NABH evidence.
- **NVR unreachable** → live tiles show a clear "feed unavailable" placeholder (never a frozen last frame, which is dangerously misleading); bookmarks are still recorded and reconcile when the NVR returns.
- **Retention conflict** — a preserved clip's storage would be overwritten → the system copies it to protected object storage before deletion and notifies the case owner.
- **Facial recognition is off by default**; enabling it (later phase) requires a DPIA, Privacy Officer approval and hospital-board sign-off.

## 4. Data Model (schema `engage`, prefix `cctv_`)

- `cctv_systems` — id, hospital_id, branch_id, name, vendor, kind enum(nvr/vms/cloud), base_url, api_version, credentials_ref (Vault), protocol enum(onvif/vendor_api/rtsp_only), stream_limit, recording_server, timezone, connector_id (EN-017), status, health jsonb, last_probe_at.
- `cctv_cameras` — id, hospital_id, branch_id, system_id, code, name, model, onvif_profile, rtsp_main, rtsp_sub (references only; credentials never inline), resolution, fps, ptz bool, audio_enabled bool default false, building, floor, zone, room_text, map_x, map_y, area_class enum(public/semi_public/restricted/prohibited), purpose_text, retention_days, privacy_masks jsonb, no_record_schedule jsonb, signage_evidence_file_id, privacy_reviewed_by, privacy_reviewed_at, status enum(pending_review/active/offline/disabled/retired), last_seen_at, clock_drift_sec, created…; UNIQUE(hospital_id, code).
- `cctv_event_mappings` — id, hospital_id, event_type, scope jsonb (branch/ward/gate/zone), camera_ids uuid[], pre_roll_sec, post_roll_sec, auto_preserve bool, severity_threshold, active.
- `cctv_bookmarks` — id, hospital_id, camera_id, event_type, ref_type, ref_id (gate pass, incident, code activation, refund…), label, starts_at, ends_at, preserved bool, preserve_until date?, created_by (system/user), created_at; index (hospital_id, ref_type, ref_id), (camera_id, starts_at desc); partitioned monthly.
- `cctv_access_log` — id, hospital_id, user_id, action enum(live_view/playback/ptz/snapshot/export_request/export_download), camera_ids uuid[], time_range tstzrange?, reason_type enum(incident/mlc/routine_monitoring/complaint/police/court/other), reason_ref, reason_text, ip, user_agent, at, duration_sec; partitioned monthly; mirrored into EN-024.
- `cctv_exports` — id, hospital_id, requested_by, purpose, legal_ref, requisition_file_id?, camera_ids uuid[], time_range, status enum(requested/approved/rejected/processing/ready/delivered/expired/purged), approved_by (Admin), privacy_approved_by (DPO), file_ref, file_sha256, size_bytes, watermark_text, certificate_65b_file_id?, recipient, delivery_mode, acknowledged_by, acknowledged_at, expires_at, created_at.
- `cctv_health_events` — camera_id/system_id, event enum(offline/online/no_recording/disk_full/tamper/clock_drift/stream_error), detail, at; retention 90 days.
- `cctv_privacy_reviews` — id, hospital_id, review_date, reviewer (DPO), cameras_reviewed int, findings jsonb, actions jsonb, next_review_due.
- Note: **footage itself is never stored in Postgres**; only references, bookmarks and exported evidence objects (in a restricted, encrypted bucket with object-lock for preserved evidence).

## 5. Business Rules & Validations

- **Prohibited areas can never have an active camera.** The area class is mandatory at registration; `prohibited` blocks activation outright and raises a Privacy Officer task. This is a hard rule, not a warning.
- Audio recording is disabled by default and can be enabled only with Hospital Admin + Privacy Officer approval and a documented purpose (never in clinical areas where consultations are audible).
- No live or recorded access without an authenticated, permissioned user; **playback and export always require a reason**; routine live monitoring by the assigned guard is permitted without a per-session reason but is still logged with camera scope and duration.
- Camera streams are proxied — RTSP credentials and NVR endpoints are never exposed to the browser or to any client-side code; signed stream URLs expire in ≤ 60 s and are single-use.
- Retention is capped by policy per area class; extending retention requires Privacy Officer approval and a stated legal basis; preserved evidence is exempt from auto-deletion but has its own review date.
- Exports are watermarked, hashed, expiring, and delivered only to the approved recipient; police/court exports require the written requisition on file and produce a §65B certificate draft.
- Camera clocks must be NTP-synced; a drift > 60 s marks that camera's footage as "time-integrity questionable" on any export (evidence honesty).
- The camera network is a **segregated VLAN** with no route to the clinical network except through the proxy; cameras with known-vulnerable firmware are flagged by EN-023 and may be quarantined.
- Facial recognition, people counting and behaviour analytics are **off** unless separately enabled with a DPIA; if enabled, biometric-template rules from EN-020 apply.
- Patients/staff may ask what footage exists of them (DSAR): the response process is defined in EN-028 — footage of _other_ identifiable people cannot be disclosed, so exports for DSAR require redaction or refusal with reasons.
- Any viewing of ward-area cameras by a non-security role requires an incident reference and is reported in the monthly privacy digest.

## 6. API Surface (`/api/v1/cctv`)

| Method         | Path                                                                                                     | Purpose                                             | Permission                                                           | Notes                          |
| -------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------ |
| GET/POST/PATCH | /systems ; /systems/:id ; POST /systems/:id/test \| /discover                                            | NVR/VMS registry & ONVIF discovery                  | `cctv.system.manage` (IT Admin)                                      | credentials write-only         |
| GET/POST/PATCH | /cameras ; /cameras/:id ; POST /cameras/:id/activate \| /disable                                         | camera registry                                     | `cctv.camera.manage` (IT Admin; activation needs DPO for restricted) | area_class mandatory           |
| POST           | /cameras/:id/privacy-mask ; /no-record-schedule                                                          | privacy enforcement                                 | `cctv.privacy.manage` (DPO)                                          | pushed to camera via ONVIF     |
| POST           | /cameras/:id/stream                                                                                      | issue signed live stream URL                        | `cctv.live.view`                                                     | ≤ 60 s TTL, single-use, logged |
| POST           | /cameras/:id/ptz                                                                                         | PTZ control                                         | `cctv.ptz.control`                                                   | operator lock                  |
| POST           | /playback                                                                                                | signed playback URL `{cameraIds, from, to, reason}` | `cctv.playback.view`                                                 | reason mandatory, audited      |
| POST           | /snapshot                                                                                                | still image capture                                 | `cctv.live.view`                                                     | watermarked, audited           |
| GET/POST/PATCH | /event-mappings                                                                                          | HMS event → camera mapping                          | `cctv.mapping.manage`                                                |                                |
| GET            | /bookmarks?ref&camera&from&to ; POST /bookmarks ; POST /bookmarks/:id/preserve\|release                  | bookmarks                                           | `cctv.bookmark.read` / `.manage`                                     |                                |
| POST/GET       | /exports ; POST /exports/:id/approve\|reject ; GET /exports/:id/download ; POST /exports/:id/acknowledge | evidence export workflow                            | `cctv.export.request` / `cctv.export.approve` (Admin + DPO)          | watermark + hash + §65B        |
| GET            | /health ; GET /health/cameras?status=offline                                                             | fleet health                                        | `cctv.health.read`                                                   | WS                             |
| GET            | /access-log?user&camera&from&to&reason                                                                   | access audit                                        | `cctv.audit.read` (DPO, Auditor)                                     | export audited                 |
| GET/POST       | /privacy-reviews                                                                                         | quarterly review record                             | `cctv.privacy.manage`                                                |                                |
| GET            | /reports/uptime ; /reports/access ; /reports/exports ; /reports/coverage                                 | reports                                             | `cctv.report.read`                                                   |                                |

## 7. Domain Events (outbox)

- `cctv.camera.activated|disabled|offline|online|tamper_detected|clock_drift` → EN-037 (security/IT alerts), EN-023 (tamper = incident), NC-019.
- `cctv.bookmark.created|preserved|released` → NC-019 incident record, TR-008 MLC file.
- `cctv.export.requested|approved|rejected|ready|delivered|expired` → EN-024, NC-023 (legal case file), DPO log.
- `cctv.access.recorded` (aggregated) → privacy digest.
- `cctv.retention.at_risk` (preserved clip nearing overwrite) → case owner + IT.
- Consumes: `gatepass.*`, `display.code.activated`, `nc.incident.reported`, `pharmacy.narcotic.*`, `billing.refund.approved`, `blood.component.issued`, `mortuary.body.released`, `bmw.consignment.dispatched`, `er.mass_casualty.declared`.

## 8. Screens (UI)

- **Security Video Wall** (desktop + wall TV via EN-018): 1/4/9/16-tile grid with camera labels and online chips, saved layouts per guard post, sequence mode, alert pop-in (a red-bordered tile auto-appears when a mapped event fires at that camera), PTZ pad for capable cameras. Shortcuts: `1/4/9/16` layout, `←/→` cycle, `Space` pause tour, `E` open event bookmark.
- **Camera Registry & Map** (desktop, IT/DPO): floor-plan view with camera pins coloured by area class and status, list view with filters (offline, unreviewed privacy, retention drift), camera detail (streams, masks, schedule, signage photo, review history).
- **Investigation Workspace** (desktop, Security Supervisor): incident/gate-event context on the left, timeline scrubber with bookmark markers in the centre, multi-camera synchronised playback (up to 4), snapshot & clip-marking tools, "request export" button that pre-fills purpose and time range. Reason prompt appears before any playback.
- **Export Requests** (desktop): request list with status chips, approval panel showing purpose, legal reference and requisition attachment, hash/watermark preview, delivery & acknowledgement tracking.
- **Privacy Console** (desktop, DPO): prohibited-area checklist, cameras pending privacy review, mask coverage preview, signage register with photos, quarterly review wizard, access-anomaly report (out-of-hours viewing, no-reason viewing, top viewers).
- **Health Dashboard** (desktop): offline cameras pinned with downtime duration, recording status, NVR disk usage, clock drift list.
- Empty/error states: "Feed unavailable — NVR unreachable since 11:42" (never a frozen frame), "This camera is pending privacy review and cannot be viewed", "Playback requires a reason — link an incident or enter a justification".

## 9. Integrations

- **ONVIF** Profile S (streaming), G (recording/playback), T (advanced streaming) for vendor-neutral discovery, streaming, PTZ and privacy masks; **RTSP/RTP** for streams; vendor APIs for Hikvision/Dahua/CP Plus/Milestone/Genetec/Axis where ONVIF is insufficient (bookmarks, retention queries).
- **Media proxy**: RTSP→WebRTC (low-latency live) and RTSP→HLS (playback/wall boards) transcoder service, GPU-optional, with per-session signed tokens.
- **EN-015** gate events and ANPR plate reads; **NC-019** incidents; **EN-018** wall boards; **EN-017** connector lifecycle and health; **EN-023** camera firmware CVE tracking and network segmentation checks; **TR-008** medico-legal evidence packaging.
- Access-control panels and intrusion alarms (door forced/held) can raise the same bookmark pipeline where the hospital has them.

## 10. Reports & Analytics

- Camera uptime % and downtime episodes by area criticality, recording-compliance report (cameras actually recording vs registered), retention compliance vs policy, coverage map gaps for NABH-required areas (narcotics, blood bank, cash, records, mortuary, entries), access-audit summary (views by user/role/reason, out-of-hours access, playback without incident reference), export register (count, purpose, approver, recipient, outstanding acknowledgements), preserved-evidence inventory with case status, privacy-review completion. MV `analytics.mv_cctv_monthly`.

## 11. Notifications

- IT/Security: camera offline (critical area within 15 min, others hourly digest), NVR disk > 85 %, recording stopped, tamper/blur detected, clock drift, firmware vulnerability (EN-023).
- Privacy Officer: camera pending privacy review > 7 days, access without reason detected, export requested for police/court, retention policy exceeded.
- Case owner: preserved footage nearing retention limit, export ready/expiring, recipient has not acknowledged.

## 12. Permissions (RBAC keys)

`cctv.system.manage` (IT Admin) · `cctv.camera.manage` (IT Admin) · `cctv.privacy.manage` (Privacy Officer) · `cctv.live.view` (Security Guard/Officer — ABAC scoped to assigned cameras) · `cctv.ptz.control` (Security Officer) · `cctv.playback.view` (Security Supervisor, Quality Manager, Nursing Supervisor with incident scope; reason mandatory) · `cctv.bookmark.read` (Security, Quality) · `cctv.bookmark.manage` (Security Supervisor) · `cctv.mapping.manage` (Security Officer, IT Admin) · `cctv.export.request` (Security Supervisor, Quality, Legal) · `cctv.export.approve` (Hospital Admin **and** Privacy Officer — dual approval) · `cctv.audit.read` (Privacy Officer, Auditor) · `cctv.health.read` (IT, Security) · `cctv.report.read` (Admin, Security Officer, Auditor).

## 13. Non-functional

- Scale: 300–600 cameras across a 2000-bed campus, 30 concurrent live viewers, 16-tile wall boards ×4. The HMS does **not** record or store video — the NVR/VMS does; EN-021 handles registry, proxying, bookmarks and governance, so HMS storage growth is negligible (< 1 GB/month excluding exports).
- Live latency (WebRTC proxy) < 2 s glass-to-glass at sub-stream resolution; playback seek < 3 s; 16-tile grid uses sub-streams (≤ 720p) to keep client CPU < 40 %.
- Bookmark write latency < 500 ms from the source event; bookmark creation must never block the source workflow (fire-and-forget through the outbox).
- Availability: CCTV failure must never affect clinical modules — all EN-021 calls are non-blocking and degrade to "feed unavailable".
- Security: segregated camera VLAN, no inbound internet to cameras, credentials in Vault, signed single-use stream tokens, TLS everywhere, exports encrypted at rest with object-lock, MFA step-up for export approval.
- Accessibility: console usable on desktop only (video wall use case); status conveyed by icon + text, not colour alone; captions/labels on every tile.

## 14. Acceptance Criteria

1. Given a camera is registered with area class `prohibited`, when an admin tries to activate it, then activation is blocked, no stream is ever issued, and a Privacy Officer review task is created.
2. Given a user requests a live stream, when the URL is issued, then it is signed, single-use, expires within 60 seconds, and the NVR credentials never appear in any client-visible payload.
3. Given a visitor checks in at the main gate, when the event is processed, then a bookmark is created on the mapped gate cameras covering 30 s before to 120 s after, linked to the gate register row.
4. Given a Code Blue is activated in ICU-2, when the event fires, then bookmarks are created on the mapped corridor cameras and the security console shows the linked clips in the incident view.
5. Given a supervisor opens playback, when no reason is supplied, then playback is refused; when a reason is supplied, the exact cameras, time range and reason are written to the access log.
6. Given an export is requested for a police requisition, when the written requisition is not attached, then approval cannot be completed; once approved by both Hospital Admin and Privacy Officer, the export is watermarked, hashed, and a §65B certificate draft is generated.
7. Given an export link is 73 hours old, when the recipient tries to download it, then the link is expired and a new approval is required.
8. Given a camera's clock has drifted by 5 minutes, when an export is produced from it, then the export and its certificate note the time-integrity issue.
9. Given the NVR is unreachable, when the wall board renders, then each tile shows "feed unavailable" with the outage start time rather than a frozen last frame.
10. Given footage linked to an open MLC case is approaching its retention limit, when the retention job evaluates it, then the clip is preserved (copied to protected storage if necessary) and the case owner is notified.
11. Given a nursing supervisor with incident-scoped playback permission, when they attempt to view a camera unrelated to their incident, then access is denied and the attempt is logged.
12. Given the quarterly privacy review, when it is run, then every camera's area class, mask configuration, retention and signage evidence are listed with the last review date, and cameras never reviewed are flagged.
13. Given facial recognition is not enabled, when the system processes video, then no biometric templates are created anywhere and no analytics are applied.
14. Given a CCTV connector fails entirely, when a nurse uses any clinical screen, then no clinical workflow is delayed or blocked by the failure.

## 15. Enhancements / Later phases

- Video analytics: loitering, crowd density at OPD, fall detection in corridors, PPE compliance, queue-length estimation feeding EN-006 — each requiring a DPIA before enablement.
- ANPR at gates fully integrated with EN-015's vehicle log (auto-fill plate, auto-open barrier for registered ambulances).
- Facial recognition for blacklist/absconding-patient alerts (strictly opt-in, DPO + board approval, EN-020 template rules).
- Body-worn cameras for security staff during violent-incident response, with the same consent/retention governance.
- Infant-abduction (Code Pink) automation: RFID tag + camera lock-down of exits.
- Redaction service (automatic face blurring of third parties) so DSAR and insurance exports can be fulfilled without exposing other people.
- Cloud VMS option for small branches; edge recording with central indexing for multi-branch groups (EN-041).
- Integration of CCTV health into the NABH FMS evidence pack and automated coverage-gap analysis against a required-area checklist.
- Live camera view embedded in the ER/OT command dashboards for situational awareness during mass-casualty events (OP-006/TR-007).

## 16. Open Questions for the Hospital

1. Which VMS/NVR is installed (vendor, version), how many cameras, and does it expose ONVIF Profile G (playback) or only vendor APIs?
2. Confirmed list of areas where cameras exist today — are any in prohibited areas (toilets, changing rooms, labour room, consultation rooms) that must be removed before go-live?
3. Retention period per area class currently configured on the NVR, and the legal/insurance basis for it.
4. Who may view live feeds, who may view playback, and who approves exports? Is dual approval (Admin + DPO) acceptable?
5. Is audio recording enabled on any camera? If yes, on what basis, and can it be disabled in clinical areas?
6. Is CCTV signage present at every monitored area entry, and in which languages? Who maintains the signage register?
7. Is the camera network on a separate VLAN, and can the HMS proxy reach the NVR without exposing cameras to the clinical network?
8. Process today for police/court footage requisitions — who handles it, and is a §65B certificate routinely issued?
9. Which HMS events should automatically bookmark footage (gate entries, code blue, narcotics, cash refunds, incidents)? Any others specific to this hospital?
10. Is there an appetite for video analytics or facial recognition, and is management prepared for the DPIA and privacy scrutiny that entails?
