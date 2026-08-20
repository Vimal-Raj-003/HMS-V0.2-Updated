# IP-004 — Nursing Mobile (bedside vitals, barcode medication verification, push alerts, wound photos, tasks, offline sync)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | IP / Inpatient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Module ID       | IP-004                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Phase           | 7 (PWA) / 13 (React Native)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Priority        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Depends on      | IP-003 (all nursing business logic & APIs — IP-004 is the mobile client + offline layer), IP-001 (beds/census), EN-013 (wristband/drug barcodes), EN-037 (push: Web Push/FCM, escalation), EN-029 (CDSS checks), IP-014 (unit dose labels), OP-004 (sample collection labels), OP-017 (wound care records), IP-013 (code activation), IP-009 (ICU nurse variant), EN-005 (bedside label/wristband reprint), EN-042 (Bluetooth/LE spot-check devices), EN-007 (device sessions, MDM), EN-024 (audit), NC-030 (roster) |
| Feature flag    | `module.nursing_mobile.enabled` (sub: `nmobile.offline`, `nmobile.wound_photos`, `nmobile.ble_devices`, `nmobile.voice_notes`, `nmobile.code_button`, `nmobile.reprint`)                                                                                                                                                                                                                                                                                                                                             |
| Primary roles   | Nurse — Ward (17), Nurse — ICU (18), Nurse — OT (20, checklist), Ward boy (23, tasks)                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Secondary roles | Nurse Supervisor (22), Phlebotomist (34, collection tasks), Doctor (view only via IP-010), IT Admin (56, device management)                                                                                                                                                                                                                                                                                                                                                                                          |
| Regulatory      | NABH MOM.6 (bedside identification before administration), AAC.6 (two identifiers), COP (wound documentation), DPDP (photos = PHI; on-device encryption; no gallery leakage), IT Act (device security), ISMP barcode-medication-administration guidance                                                                                                                                                                                                                                                              |

## 1. Purpose

IP-004 is the phone/tablet client for IP-003 built as an installable PWA (Phase 7) and later a React Native app (Phase 13) sharing contracts. It puts the nurse's task list, wristband-first identification, barcode 5-Rights medication verification, quick vitals with instant NEWS2, I/O, SBAR notes, wound photo capture and push alerts with acknowledgement/escalation in the nurse's hand at the bedside, and keeps working when Wi-Fi drops (IndexedDB queue with deterministic sync and conflict rules). All business rules live in IP-003 services; the mobile app never bypasses them.

## 2. Users & Jobs-to-be-done

- **Ward nurse** (Android phone / 8–10" tablet, hospital-issued or BYOD with policy): open shift → my patients & due tasks; walk to bed → scan wristband → chart vitals (< 30 s), give meds with scans (< 45 s/dose), record I/O, note, photo; get alerts (critical vitals, new orders, nurse call) → acknowledge; reprint wristband at bedside; raise emergency code.
- **ICU nurse**: hourly validate device values (IP-009 flowsheet mobile subset), drips.
- **Phlebotomist / sample nurse**: collection rounds by ward with scan & label print.
- **Ward boy**: transport/housekeeping tasks (from IP-001/NC-018) with scan at pick-up/drop.
- **Supervisor**: ward summary, escalations, reassign.

## 3. Core Workflows

### 3.1 Login, device & shift start

1. **Nurse** logs in (username/password + PIN quick unlock; SSO if configured) → selects branch/ward (from assignments in IP-003) → device registered (`core.device_sessions`: device id, model, OS, push token) → home shows **My Patients** (assigned beds) and **Tasks due** (next 2 h) with counts; pull-to-refresh; background sync every 60 s + Socket.IO for alerts.
2. Screen lock after 2 min idle; PIN unlock keeps clinical context; remote wipe of app data via EN-007 device console.

### 3.2 Bedside identification (wristband-first)

- Any patient action starts with **Scan wristband** (camera with ML barcode/QR decoding or built-in scanner on rugged devices) → verifies admission active, ward match, patient banner shown (photo, name, UHID, age/sex, allergies red, alerts, isolation) → "Confirm identity" (name + DOB spoken back) → context locked to that patient for subsequent actions until "Leave bedside". Manual search fallback logs `identification_method=manual` with reason (KPI).

### 3.3 Bedside vitals

- Vitals form (numeric keypad, previous values shown, device auto-fill via BLE spot-check monitors — `nmobile.ble_devices` — or EN-042 gateway) → save → instant NEWS2/PEWS/MEWS with colour band and required action; if escalation tier reached the app opens the SBAR-call helper (doctor list, one-tap call/push, note templated) → IP-003 `nursing.vitals.recorded` / `nursing.ews.escalated`.

### 3.4 Barcode medication verification

1. Task "Due meds" grouped per patient → tap → **Scan wristband** (if not already in context) → **Scan medication** (unit-dose label from IP-014 or GTIN) → app calls IP-003 `verify-scan` (or offline rule engine snapshot) → shows 5 Rights panel: ✓/✗ per right, alerts (allergy, dose range, lab/vitals gate, PRN limits) → outcome Given/Held/Refused with reason → for high-alert: **witness** — second nurse enters PIN/2FA on same device (or approves via push on their own phone within 60 s) → saved; medication photo documentation optional (`photo of prepared dose`) per policy.
2. Red ✗ blocks; override requires reason + witness (per IP-003 rules); wrong-patient scan hard-stop with near-miss log.
3. Infusions: start with rate; bag change scan; stop → volume to I/O.

### 3.5 Push alerts & escalation

- Alert types: critical vitals/EWS (own patients), critical lab (own patients), new/changed/STAT orders, nurse call, witness request, task overdue, handover pending, code blue (ward-wide), broadcast from supervisor. Delivered via Web Push/FCM (EN-037) with PHI-free body ("Bed 12: critical vitals — open app") → in-app detail → **Acknowledge** button; unacknowledged critical alerts escalate after 5 min (configurable) to in-charge/all ward nurses; acknowledgement log visible to doctor.
- Doctor orders → push to assigned nurse ("New medication order for Bed 4"), tap → order & first task.
- Do-not-disturb never applies to critical tier; sound/vibration profiles per tier; alert centre with filters.

### 3.6 Wound & clinical photo capture (`nmobile.wound_photos`)

- From wound register (IP-003/OP-017): capture with in-app camera (no gallery), auto-tag patient/admission/site/date/nurse, optional ruler/measurement overlay, consent flag check (EN-028: photo consent), image stored encrypted (S3 presigned upload; local encrypted cache until uploaded, then purged), thumbnails in timeline; comparison slider with previous photos; pressure-injury staging fields.
- Also: dressing photos, drain output photos, skin checks, IV site phlebitis, medication administration photo (policy).

### 3.7 Tasks & other actions

- Task list (IP-003 engine): complete/skip with reason, reassign (supervisor); sample collection with label print to nearest Bluetooth/Wi-Fi label printer (EN-005) after scan; transport tasks scan at pick-up/drop; hourly rounding checklist; care-plan interventions; SBAR quick note with templates & voice-to-text (`nmobile.voice_notes`, device STT; AI-004 later); I/O quick add; GCS/pain quick score; nurse-call accept/attend from lock-screen notification.
- **Wristband reprint** (`nmobile.reprint`): from patient context → prints to ward wristband printer (EN-005/EN-013), reason logged (damaged/illegible/lost).
- **Emergency code button** (`nmobile.code_button`): long-press → choose Code Blue/Rapid Response/Fire/Security → confirm → IP-013 activation with location (ward/bed) → broadcast.
- Handover: view I-PASS cards, walk-round acknowledgement with scan (IP-003 handover).

### 3.8 Offline mode (`nmobile.offline`)

1. App shell, reference data (drug names for own patients' orders, admin-time rules, reason codes, forms) and current patient snapshots (banner, allergies, active orders, MAR next 8 h, latest vitals) cached in IndexedDB (encrypted with device-bound key) for assigned patients; refreshed on each sync.
2. While offline: vitals, MAR outcomes (verification uses cached order snapshot ≤ 2 h; older → warning "verify manually", high-alert witness still required locally with second PIN), I/O, notes, tasks complete, photos (queued) are stored in an outbox with client UUIDs, device time and monotonic sequence; UI shows "Pending sync (n)"; alerts cannot be received (banner "Offline — alerts paused; use phone/nurse call").
3. On reconnect: batch `POST /nursing/sync/batch` in sequence; server applies IP-003 rules with `offline_captured=true` and original timestamps; **conflict rules**: order cancelled/changed before the administration time → administration accepted but flagged `needs_review` and doctor/in-charge notified; duplicate dose (same schedule id already actioned by another nurse) → rejected, nurse notified; vitals never conflict (append-only); notes append; photos upload with retry; server ack marks items synced; failed items stay in outbox with reason.
4. Data retention offline ≤ 24 h; app refuses new offline captures beyond 4 h offline without re-auth (PIN) to limit stale snapshots.

### 3.9 Exceptions

1. Camera can't decode wristband (smudged) → manual entry of IP no. + second identifier + reason; reprint prompt.
2. Push token expired → app re-registers on launch; supervisor sees "device unreachable" list.
3. Device lost → EN-007 remote wipe; sessions revoked; audit.
4. Low battery/network transitions → outbox persists across app restarts.

## 4. Data Model (mobile-specific; core tables in IP-003)

- **core.device_sessions** (existing): + app enum(nursing/doctor/patient/staff), push_token, platform, app_version, last_sync_at, ward_id, wiped_at.
- **ip.mobile_sync_batches** (id, hospital_id, device_id, user_id, received_at, item_count, applied, rejected jsonb, offline_from, offline_to).
- **ip.mobile_sync_items** (batch_id, client_id uuid unique, kind enum(vitals/mar/io/note/task/photo/assessment), captured_at, payload jsonb, result enum(applied/rejected/needs_review), server_row_id?, reason).
- **clinical.clinical_photos** (id, hospital_id, patient_id, admission_id, type enum(wound/dressing/skin/iv_site/drain/med_admin/other), site, wound_id?, file_id (S3), thumb_file_id, captured_by, captured_at, device_id, consent_id, measurements jsonb, sha256) — never deleted; PHI encrypted at rest.
- **ip.alert_acknowledgements** (alert_id (EN-037), user_id, device_id, acknowledged_at, latency_ms, escalated bool).
- **ip.identification_events** (admission_id, user_id, method enum(scan/manual), reason?, at, action_context) — for scan-compliance KPI.
- Client store (IndexedDB): `patients_snapshot`, `orders_snapshot`, `mar_next`, `reference`, `outbox`, `photos_pending` — encrypted (WebCrypto AES-GCM key in device keystore where available).

## 5. Business Rules & Validations

- All clinical writes go through IP-003 endpoints; no client-side rule bypass; offline uses cached rule snapshot and marks results `offline_captured` for server re-validation.
- Wristband scan is the default identification; manual identification requires reason and is reported (target scan compliance ≥ 95 %).
- Witness authentication is a separate credential (PIN/2FA) — the app enforces different user id; witness approval via push valid 60 s.
- Photos: in-app camera only, no gallery import (except configured "import scanned consent"), auto-purge from device after upload confirmation, consent flag checked (photo consent or clinical-necessity policy), watermark with patient id and timestamp on export.
- Critical alerts: acknowledgement SLA 5 min → escalation; DND bypass; alert bodies PHI-free.
- Offline window limits (4 h captures, 24 h retention); batch sync ordered by client sequence; idempotent by client_id.
- Device security: PIN lock 2 min, screenshot blocking on RN build (FLAG_SECURE), root/jailbreak detection → deny (configurable), MDM enrolment recommended; app data wiped on logout of shared devices.
- Voice notes are transcribed on device or by consented service; nurse must review before saving.

## 6. API Surface (mobile-specific; others in IP-003)

| Method | Path                                               | Purpose                                                                                 | Permission                | Idem          | Pag    |
| ------ | -------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------- | ------------- | ------ |
| POST   | /api/v1/devices/register                           | register push token/device                                                              | auth.session              | Y             | –      |
| GET    | /api/v1/nursing/mobile/bootstrap?ward=             | snapshot for assigned patients (banner, orders, MAR next 8 h, vitals, tasks, reference) | nursing.board.read        | –             | –      |
| GET    | /api/v1/nursing/mobile/delta?since=                | incremental changes                                                                     | nursing.board.read        | –             | cursor |
| POST   | /api/v1/nursing/sync/batch                         | offline outbox (IP-003)                                                                 | per item                  | Y (client_id) | –      |
| POST   | /api/v1/nursing/identify                           | wristband scan → admission context                                                      | nursing.board.read        | –             | –      |
| POST   | /api/v1/clinical/photos/presign, /photos           | upload wound/clinical photos                                                            | nursing.register.write    | Y             | –      |
| GET    | /api/v1/clinical/photos?admission=&wound=          | list/thumbnails                                                                         | nursing.note.read         | –             | cursor |
| POST   | /api/v1/alerts/{id}/ack                            | acknowledge (EN-037)                                                                    | nursing.alert.ack         | Y             | –      |
| POST   | /api/v1/nursing/mar/{id}/witness/request, /approve | remote witness via push                                                                 | nursing.mar.witness       | Y             | –      |
| POST   | /api/v1/print/wristband/reprint                    | reprint at ward printer                                                                 | ip.print                  | Y             | –      |
| POST   | /api/v1/codes/activate                             | code blue/RRT (IP-013)                                                                  | code.activate             | Y             | –      |
| GET    | /api/v1/nursing/mobile/devices                     | supervisor: device/push health                                                          | nursing.assignment.manage | –             | cursor |

## 7. Domain Events (outbox)

- Emits through IP-003 (`nursing.vitals.recorded`, `nursing.mar.administered`, …) with `channel=mobile`, `offline_captured`.
- `nursing.mobile.sync_batch_applied` {device, applied, rejected, needs_review}; `nursing.mobile.identification_manual` {reason}; `clinical.photo.captured` {type, wound_id}; `alert.acknowledged` {latency}; `nursing.mobile.device_unreachable`.
- Consumes: EN-037 alert dispatch, IP-003 task/order events, IP-013 code broadcasts, NC-030 assignments.

## 8. Screens (UI — phone single-pane with bottom nav; tablet 2-pane)

- **Home**: My patients (cards with acuity, next task time), Tasks due (timeline), Alerts badge, Sync status; bottom nav: Patients · Tasks · Scan · Alerts · More; big central **Scan** button.
- **Scan / Identify**: full-screen camera with torch, manual fallback; success → patient banner sheet.
- **Patient sheet** (bottom sheet + tabs): Vitals, Meds due, I/O, Notes, Photos, Lines, Care plan; sticky banner with allergies/isolation.
- **Vitals**: keypad inputs, BLE device pick, previous values ghosted, NEWS2 result screen with action; offline badge.
- **Meds due**: list by time; **Administer** flow: scan drug → 5R panel → outcome → witness → done (haptic feedback; colour-blind safe icons).
- **Alerts**: list by severity with timers, acknowledge, open patient; lock-screen notifications with actions (Ack / Open).
- **Photo capture**: camera with grid, ruler overlay, site picker, staging fields; upload progress; compare view.
- **Tasks**: grouped by time/patient; swipe complete; skip reason sheet; label print action.
- **Handover**: read-only I-PASS cards, ack per patient (scan optional).
- **Settings/More**: device info, sync log, printer selection, PIN, language, sign out (wipe).
- Offline: persistent banner; every list shows cached-at time; queued items with retry.
- Accessibility: ≥ 44 px targets, one-handed reach, high contrast, screen-reader labels; i18n.

## 9. Integrations

- EN-037 push (Web Push VAPID for PWA; FCM/APNs for RN), EN-013 barcodes (GS1 DataMatrix/Code128/QR), EN-005 Bluetooth/Wi-Fi label & wristband printers (ZPL over TCP via print service), EN-042 BLE spot-check monitors (Masimo/Omron/Contec-class; Web Bluetooth on Android PWA, native BLE in RN), device STT (Web Speech / native), EN-007 device management/remote wipe, IP-013 code system, S3 presigned uploads.
- Fallbacks: no push → polling every 60 s while app foreground + Socket.IO; printer offline → print to station queue; camera denied → USB/Bluetooth scanner input mode.

## 10. Reports & Analytics

- Scan compliance (patient/drug) per nurse/ward, alert acknowledgement latency & escalations, offline capture volume & needs_review rate, sync failures, photo counts, device health (unreachable devices), bedside vitals share vs station entry, time-from-due-to-given distribution.
- Read models: `analytics.mv_mobile_scan_compliance`, `analytics.mv_alert_ack_latency`, `analytics.mv_mobile_sync_health`.

## 11. Notifications

- To nurse (push): task due/overdue, STAT order, EWS escalation, critical lab, nurse call, witness request, handover, code; to supervisor: unacknowledged critical alerts, device unreachable, high needs_review rate; to doctor (via IP-010): held/refused critical, ack log.

## 12. Permissions (RBAC keys)

Reuses IP-003 keys; adds `nursing.alert.ack`, `nursing.mobile.use`, `code.activate` (IP-013), `ip.print` (reprint), `nursing.photo.capture|read`.
Defaults: Ward/ICU/OT nurse: mobile.use, alert.ack, photo.capture/read, print; Ward boy: task.read/update; Supervisor: + devices view; IT admin: device management.

## 13. Non-functional

- 4,000 concurrent nurse devices; bootstrap payload < 300 KB per ward assignment; delta sync < 200 ms p95; push end-to-end < 3 s.
- PWA: Serwist service worker precache; IndexedDB ≤ 100 MB per device; photos ≤ 5 MB each compressed on device; works on Android 10+/Chrome 110+, iOS 16.4+ (Web Push), RN build later.
- Battery: background sync throttled; camera released promptly.
- Security: encrypted local store, PIN lock, remote wipe, FLAG_SECURE (RN), certificate pinning (RN), no PHI in notifications/logs; audit every clinical write with device id.

## 14. Acceptance Criteria

1. Given a nurse scans a wristband, then the patient banner with allergies and isolation appears within 1 s and subsequent actions are locked to that admission until "Leave bedside".
2. Given wristband scan of a discharged patient, then the app refuses context with "Not an active admission".
3. Given a due insulin dose, when the nurse scans patient and drug and marks Given, then the app requires a second nurse PIN (different user) before saving; same-user PIN is rejected.
4. Given the drug barcode maps to a different drug, then a red ✗ appears and Given is disabled unless override with reason + witness.
5. Given vitals saved with NEWS2 = 6, then the escalation helper opens with the on-call doctor and a push is sent; the doctor's acknowledgement is visible in the app.
6. Given a critical alert not acknowledged in 5 min, then it escalates to the in-charge and all ward nurses; acknowledgement latency is stored.
7. Given the device is offline, when the nurse records vitals and gives two doses (one high-alert with local witness PIN), then items sit in the outbox with "Pending sync (3)"; on reconnect they apply in order with original timestamps and `offline_captured=true`.
8. Given an order was stopped while offline and the dose was given, then sync applies the record flagged `needs_review` and notifies the doctor and in-charge.
9. Given another nurse already charted the same schedule id online, then the offline duplicate is rejected and the nurse sees the reason.
10. Given a wound photo is captured, then it is uploaded encrypted, tagged with patient/site/nurse/time, purged from the device after confirmation, and visible in the wound timeline with compare view.
11. Given photo consent is refused on the admission, then capture for non-clinical-necessity types is blocked with an explanation.
12. Given a wristband reprint from bedside, then the ZPL job prints on the ward printer and the reprint reason is logged.
13. Given long-press on the emergency button and "Code Blue" confirmed, then IP-013 activation includes ward/bed and broadcasts within 3 s.
14. Given 4 h continuous offline, then new captures require PIN re-auth and after 24 h unsynced items trigger a supervisor alert.
15. Given the app is idle 2 min, then it locks; PIN unlock restores the same patient context.
16. Given a manual identification without scan, then a reason is mandatory and the event counts against scan compliance.

## 15. Enhancements / Later phases

- From VIMS sheet row 23: wristband reprinting at bedside (here), voice-to-text nursing notes on mobile (here; AI-004 later), medication admin photo documentation (here, policy), real-time nurse location RTLS (EN-042 later), emergency code activation from mobile (here).
- Later: React Native build with native BLE/scanner SDKs (Zebra/Honeywell), smart-pump association by scan, offline CDS engine parity, wearable (smartwatch) alerts, AR wound measurement, family messaging relay.

## 16. Open Questions for the Hospital

1. Devices: hospital-issued Android phones/tablets or BYOD? Rugged scanners (Zebra TC-series) available? MDM in place?
2. Wi-Fi coverage map & known dead zones (offline importance); allowed offline duration?
3. Wristband/label printers per ward and models; unit-dose labelling by pharmacy?
4. Witness policy via remote push approval acceptable, or same-device PIN only?
5. Photo consent policy and retention; watermark requirements; who may view photos?
6. Push provider (FCM/APNs) accounts; are personal phones allowed to receive PHI-free pushes?
7. Voice notes allowed? On-device only or cloud STT (data residency)?
8. Alert SLA per tier and escalation targets; DND policy on night shift?
