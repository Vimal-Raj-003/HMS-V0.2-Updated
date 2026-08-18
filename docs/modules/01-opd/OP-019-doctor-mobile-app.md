# OP-019 — Doctor Mobile App (Queue, Vitals preview, Quick consult, E-Rx, Lab results, Push alerts, Offline mode, Earnings) — PWA first, React Native later

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-019 |
| Phase | 2 (PWA, installable) → 13 (React Native/Expo iOS & Android) |
| Priority | P1 |
| Complexity | Very High |
| Depends on | OP-002 (consultation/CPOE — same services & Zod contracts), OP-001/EN-006 (queue/tokens), OP-007 (vitals), OP-004/OP-008 (results), OP-003 (Rx dispensed events), EN-037 (notification centre, Web Push/FCM/APNs), EN-029 (CDSS), EN-024 (audit), EN-007 (auth/sessions/device management), EN-013 (barcode camera), EN-039 (templates), OP-018 (tele join), IP-010 (IP rounds features live there; OP-019 shell hosts both), NC-034 (earnings/payout), EN-011 (ABDM), OP-006 (emergency pages), AI-004 (voice-to-text later), EN-032 (email), EN-041 (multi-branch/hospital switch) |
| Feature flag | `module.doctor_app.enabled` (sub: `doctor_app.offline_rx`, `doctor_app.voice`, `doctor_app.messaging`, `doctor_app.earnings`) |
| Primary roles | Doctor — Consultant OPD (6), Doctor — IP (7, via IP-010 features), Surgeon (9), Emergency physician (8), Resident (14) |
| Secondary roles | HOD (5), Medical Superintendent (4), IT admin (56, device policy), Auditor |
| Regulatory | DPDP Rules 2025 (PHI on device: encryption, remote wipe, minimal cache), IT Act SPDI, NMC/TPG 2020 (tele-Rx via app), Drugs & Cosmetics Rules (e-Rx validity/signature), NDPS (narcotic Rx restrictions on mobile — policy), OWASP MASVS L2 (mobile security), Apple App Store/Google Play health-app policies (Phase 13), WCAG 2.2 AA mobile |

## 1. Purpose
OP-019 puts the doctor's daily OPD work on the phone: secure biometric login, live token queue with vitals preview and push when a patient checks in, quick consultation (notes with voice-to-text, ICD-10, e-Rx with drug search/templates/CDSS, lab & radiology ordering), result review with critical alerts, tele-consult join, emergency pages, inter-doctor messaging, an earnings dashboard, and a robust **offline mode** with queued mutations and defined conflict rules. Phase 2 ships it as an installable PWA (same Next.js app, phone layout, service worker), Phase 13 wraps the same contracts/design tokens in React Native (Expo) for store distribution and native capabilities (biometrics, background push, camera/barcode, CallKit).

## 2. Users & Jobs-to-be-done
- **OPD consultant** (phone, 5.5–6.7" portrait; between rooms/branches; 30–120 patients/day): glance queue & vitals, call next, write short notes, prescribe from favourites, order tests, view results & images (thumbnails), sign; approve resident notes; check earnings.
- **On-call/emergency doctor**: receive pages (critical vitals, ER arrivals, code blue), acknowledge, respond; see patient summary.
- **Surgeon**: OT schedule for the day, implant recall alerts, follow-up PROMs (OP-009), pre-op consent status.
- **Resident**: draft notes for co-sign; receive co-sign requests.
- **HOD/MS**: department queue load, delayed patients, escalations.

## 3. Core Workflows
### 3.1 Secure login & session
1. First launch → tenant (hospital URL/QR) → mobile/email/employee ID + password (+ TOTP/SSO per policy) → device registration (`core.device_sessions`: device id, model, OS, push token, app version) → **biometric unlock** (PWA: WebAuthn platform authenticator (Face ID/Touch ID/Android biometric) as passkey bound to device for re-auth; RN: expo-local-authentication + secure enclave/Keystore) → refresh token stored httpOnly (PWA) / SecureStore (RN); access token 15 min; idle 15 min → biometric/PIN quick re-auth (clinical context preserved); remote wipe/logout from EN-007 device management; jailbreak/root detection (RN) → warn/block per policy; screenshots blocked on PHI screens (RN FLAG_SECURE; PWA best-effort blur on background).
### 3.2 Live queue
1. Home = **My queue** for selected branch/room (multi-hospital switch EN-041): cards ordered by token/priority: name, age/sex, token, wait time, vitals chips (BP/SpO2/Temp/HR with abnormal colour), chief complaint, flags (allergy, MLC, VIP, follow-up, tele), status; pull-to-refresh + socket real-time; **push when patient checked in / vitals abnormal / next patient ready**; filters (waiting/in progress/done/no-show); actions: call next (`queue.call`), skip, mark no-show, reorder (if permitted), start consult.
2. Department/other doctors' queues (HOD scope).
### 3.3 Mobile consultation
1. Tap patient → **quick consult** (single-pane, tabs: Summary | Notes | Rx | Orders | Results | History): summary card (problems, allergies, meds, last visit, vitals trend sparkline); notes with templates & **voice-to-text** (Web Speech API in PWA where available / native STT; AI-004 later for medical vocabulary), quick chips (complaints/diagnosis favourites); ICD-10 search (offline top-2000 cache + online); **e-Rx**: drug search (offline drug master cache: name, strength, form; online for full), favourites/templates ("Viral fever adult"), dose/frequency/duration pickers, CDSS via EN-029 (allergy/interaction/dose; offline: cached allergy list + interaction table for top drugs, full check on sync with "delayed alert" banner), narcotic/Schedule X policy (block on mobile if config); lab/radiology order sets; follow-up date; sign (`biometric confirm` for sign optional) → Rx PDF to pharmacy/patient (OP-002 pipeline) → `rx.created`; co-sign for residents.
2. Results: new results list (flag critical red), lab trends, radiology report + key images (thumbnails via EN-008; full OHIF in browser), acknowledge critical (`lab.result.critical.ack`).
3. Tele: join OP-018 call from queue card (audio/video); IP: rounds via IP-010 screens inside the same app shell.
### 3.4 Push notifications (EN-037)
- Types: critical vitals/lab/radiology (high priority, sound, requires ack; escalation if unacked in 5 min), lab result ready, new appointment/booking, patient checked in / next patient, emergency page (ER arrival for on-call, code blue, trauma activation TR-007), Rx dispensed confirmation, co-sign request, referral received (OP-021), OT schedule change, implant recall, tele patient waiting, earnings statement ready, roster/leave (NC-010).
- Channels: PWA Web Push (VAPID; iOS ≥ 16.4 requires installed PWA), RN: FCM/APNs; SMS fallback for critical if push undelivered in 2 min (EN-009); quiet hours per doctor except critical; notification centre with read/ack state; deep links to patient/context; **AI priority sorting** later (AI-005).
### 3.5 Offline mode (PWA & RN)
1. Cache (IndexedDB/SQLite): today's queue snapshot (per branch), patient summaries of queued patients (problems, allergies, meds, last vitals), reference data (ICD top-N + specialty set, drug master subset (favourites + top 3000 + hospital formulary), order sets, templates, tariff-free), own drafts.
2. Mutations queued (`outbox_local` with client_id, idempotency key, `base_version` of entity, created_at device time + monotonic clock offset): notes drafts, Rx drafts/sign, orders, queue actions, acks. UI shows "Offline — N pending" & per-item status; retries with backoff on reconnect; server processes in order per aggregate.
3. **Conflict rules** (server-authoritative, per entity):
   - Notes/encounter documents: append-only versions → offline draft becomes new version; if another version was signed meanwhile → server accepts as **addendum draft** flagged for doctor review (never silently overwrite).
   - Rx: if patient already has a signed Rx for the same visit created online (e.g. from desktop) → offline Rx saved as **draft** with conflict banner; doctor merges; if visit closed → Rx attaches as new "unscheduled follow-up" encounter with prompt.
   - Orders: duplicates (same test/procedure same visit within 24 h) → server dedupes, informs.
   - Queue actions (call/skip/no-show): last-writer-wins by server time only if state transition still valid; invalid (patient already seen by another doctor) → rejected with notice.
   - CDSS: rules re-run on sync; new critical alerts shown as "delayed" and require ack; if a hard-stop rule (severe allergy) fires on a signed offline Rx → Rx status `hold`, pharmacy blocked, doctor push.
   - Acks (critical results): idempotent; earliest ack wins.
   - Clock: server stamps `received_at`; `client_at` retained; skew > 5 min flagged.
4. Cache expiry: PHI cache purged 24 h after last use or on logout/wipe; encrypted at rest (RN SQLCipher; PWA — IndexedDB with WebCrypto-wrapped keys + OS encryption; minimal PHI).
### 3.6 Earnings dashboard (`doctor_app.earnings`, NC-034)
- Today/month consults, procedures, tele; gross fees, hospital share, net payable, pending payouts, statements (PDF), by branch; disputes → helpdesk (NC-028); IT/TDS summary from NC-009.
### 3.7 Messaging (`doctor_app.messaging`, later Phase 8/13)
- Secure inter-doctor/patient-context chat (referral discussions, image share) stored as clinical communication; read receipts; no PHI to third-party apps.
### 3.8 Exceptions
- Push token expired → re-register silently; app version below minimum → forced update; device compromised → block; biometric fail ×5 → password; offline > 24 h → cache purge & re-login; sync errors → visible list with retry/discard (discard requires reason for clinical items).

## 4. Data Model (schema `core`/`engage`; clinical entities owned by OP-002 etc.)
- **device_sessions** (EN-007): id, hospital_id, user_id, device_id, platform enum(pwa_android/pwa_ios/pwa_desktop/rn_android/rn_ios), model, os_version, app_version, push_token (encrypted), push_provider enum(webpush/fcm/apns), biometric_enrolled bool, webauthn_credential_id?, last_seen_at, revoked_at, wipe_requested_at, compromised bool.
- **doctor_app_preferences**: user_id, hospital_id, default_branch_id, room_id, quiet_hours jsonb, notification_prefs jsonb, favourites jsonb (drugs, dx, order sets), voice_lang, home_widgets jsonb.
- **mobile_sync_log** (partitioned): id, hospital_id, user_id, device_id, client_mutation_id, aggregate, aggregate_id, action, client_at, received_at, result enum(applied/deduped/conflict_draft/rejected/held), conflict_reason, server_version.
- **notification_deliveries** (EN-037): notification_id, device_session_id, channel, sent_at, delivered_at, opened_at, acked_at, escalation_level.
- **doctor_earnings_view** (NC-034 read model): doctor_id, period, branch_id, consults, procedures, tele, gross, share, deductions, net, status.
- Local (device): `outbox_local`, `cache_patients`, `cache_queue`, `cache_reference` (versioned by `reference_version` for delta sync).

## 5. Business Rules & Validations
- Every mobile mutation carries `Idempotency-Key` = client_mutation_id; server idempotent per (user, key) for 7 days.
- Sign requires online verification (or offline sign allowed with `doctor_app.offline_rx` → Rx marked `signed_offline`, pharmacy dispensing only after server-side CDSS pass; hard-stop rules can hold).
- Narcotic/Schedule X Rx on mobile: blocked by default (config allows with 2FA step-up).
- Critical alerts must be acked within 5 min else escalate (EN-037 chain: doctor → HOD/on-call → MS); ack from any device closes.
- PHI cache minimal (queued patients + last 7 days own patients), encrypted, purged on logout/24 h/wipe; no PHI in push payload (push carries opaque id; app fetches on open; iOS Web Push shows generic title) — configurable "show patient initials".
- Device registration limit per user (default 3), IT can revoke; app min version enforced by API header `X-App-Version`.
- Voice-to-text output is editable draft; never auto-signed.
- Earnings visible only to self (ABAC own_records) and NC-034 finance; disputes logged.
- Multi-hospital: switching tenant clears cache and re-scopes RLS.

## 6. API Surface (mobile uses the same `/api/v1` as web; additions below)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /devices/register, DELETE /devices/{id}, POST /devices/{id}/wipe | device sessions & push tokens | auth.device.manage (self) / admin.device.manage | Y | – |
| POST | /auth/webauthn/register, /auth/webauthn/assert | passkey/biometric re-auth | self | Y | – |
| GET | /mobile/bootstrap?branch= | queue snapshot + queued patients' summaries + reference versions (single call, ETag) | opd.queue.read | – | – |
| GET | /mobile/reference/{set}?since_version= | delta reference data (icd, drugs, order sets, templates) | opd.reference.read | – | cursor |
| POST | /mobile/sync (batch of mutations) | ordered batch apply → per-item results | per action keys | Y | – |
| GET | /mobile/sync/status?since= | results/conflicts | self | – | cursor |
| GET | /notifications?unread=, POST /notifications/{id}/ack | notification centre | notification.read/ack | Y | cursor |
| GET | /doctor/earnings?period=&branch= | earnings read model | payout.own.read | – | – |
| GET | /doctor/earnings/statements/{id}/pdf | statement | payout.own.read | – | – |
| POST/GET | /messages/threads, /messages | secure messaging (later) | messaging.use | Y | cursor |
Existing: `/queue/*` (EN-006), `/opd/encounters/*`, `/rx/*`, `/orders/*` (OP-002), `/results/*` (OP-004/OP-008), `/tele/*` (OP-018), `/ip/rounds/*` (IP-010).

## 7. Domain Events (outbox)
- Produces (via underlying modules): `queue.called`, `encounter.note.saved`, `rx.created|signed_offline|held`, `order.created`, `result.critical.acked`, `mobile.sync.conflict` {user, aggregate, reason} → doctor task list, `device.registered|revoked|wiped`.
- Consumes (for push): `visit.checked_in`, `vitals.critical|abnormal`, `lab.result.final|critical`, `rad.report.final|critical`, `appointment.booked`, `er.page`, `code.blue`, `trauma.activation`, `pharmacy.dispensed`, `cosign.requested`, `referral.created`, `ot.schedule.changed`, `implant.recall`, `tele.patient.waiting`, `payout.statement.ready`.

## 8. Screens (UI — phone single-pane, bottom nav: Queue | Patients | Results | Alerts | More)
1. **Login/biometric unlock**: tenant picker (QR), credentials, 2FA, enable Face/Touch ID toggle; error states (locked, offline login allowed with cached session ≤ 24 h).
2. **My queue**: cards with vitals chips, swipe right = call next/start, swipe left = skip/no-show; header branch/room switch; offline banner; empty "No patients waiting"; pull-to-refresh.
3. **Quick consult**: sticky patient banner (allergies red), tabs; notes with mic button (hold-to-talk), templates sheet; Rx grid (drug search bottom sheet, dose pickers, favourites), CDSS inline alerts; orders sheet; sign button (biometric confirm); conflict banner when applicable.
4. **Results inbox**: unread/critical filters, trend sparkline, tap → detail; images thumbnails → open viewer; ack button.
5. **Alerts/notification centre**: grouped by priority; ack; escalation timers; quiet-hours toggle.
6. **Patient search** (`⌘K` equivalent: search bar + barcode camera scan of OP slip/wristband EN-013).
7. **Earnings**: KPI tiles, chart by day, statement list, dispute button.
8. **Tele call** (OP-018 UI) & **IP rounds** (IP-010) hosted in shell; **OT today** (surgeon).
9. **Settings**: devices, notifications, favourites, voice language, cache/purge, about/version.
Gestures/shortcuts: hardware back handling, keyboard shortcuts when external keyboard (`N` next, `R` Rx). Real-time via Socket.IO (foreground) + push (background). Dark/light; large tap targets ≥ 44 px.

## 9. Integrations
- Push: Web Push (VAPID) via EN-037; FCM/APNs (Phase 13); SMS fallback EN-009.
- Biometrics: WebAuthn platform authenticators (PWA), Expo LocalAuthentication/SecureStore (RN).
- Voice: Web Speech API / native STT → AI-004 (Whisper/Deepgram) medical STT later.
- Camera: `BarcodeDetector` API / ZXing (PWA), expo-camera + ML Kit (RN) for wristband/OP slip/drug barcode.
- Files: presigned S3 for images/PDF; OHIF (EN-008) in browser tab.
- Store distribution (Phase 13): EAS build/OTA updates; TestFlight/Play internal tracks; MDM (Intune/AirWatch) support via managed app config (tenant URL preset).

## 10. Reports & Analytics
- App adoption (DAU/MAU doctors), queue actions from mobile %, Rx from mobile %, offline sync volume/conflict rate, push delivery/open/ack latency (critical ack p95), crash-free sessions (Sentry), voice usage, earnings views; read model `analytics.doctor_app_daily`.

## 11. Notifications
- As §3.4; templates in EN-037: `Patient checked in: token {n}`, `Critical: {param} {value} — {patient initials}`, `Lab ready ({n})`, `Emergency page: {location}`, `Co-sign requested`, `Rx dispensed`, `Tele patient waiting`, `Earnings statement ready`. Critical → sound + vibration + persistent until ack; SMS fallback.

## 12. Permissions (RBAC keys)
Reuses OP-002/EN-006/OP-004/OP-008/OP-018/IP-010 keys; adds `auth.device.manage`, `admin.device.manage`, `notification.read|ack`, `payout.own.read`, `messaging.use`, `mobile.sync` (implicit with underlying keys), `mobile.offline_rx` (policy flag). Defaults: all doctor roles — device manage self, notification, payout own; residents — no offline sign; IT admin — device admin.

## 13. Non-functional
- Performance: cold start (PWA installed) < 2.5 s TTI on mid-range Android/3G; bootstrap payload < 300 KB gzip for 100-patient queue; queue update latency < 1 s (socket); sync batch of 50 mutations < 2 s.
- Reliability: offline-first for read of cached data and drafts; sync retries with exponential backoff; background sync (Workbox `BackgroundSync` in PWA where supported; RN background tasks).
- Security: MASVS L2; certificate pinning (RN), token binding to device, biometric-gated re-auth, PHI cache encryption & purge, screenshot protection (RN), no PHI in push/logs; remote wipe.
- Compatibility: PWA — Chrome/Edge Android ≥ 100, Safari iOS ≥ 16.4 (Web Push requires Add-to-Home-Screen; document limitation), desktop browsers; RN — iOS 15+, Android 8+.
- Accessibility: WCAG 2.2 AA mobile, dynamic type, high contrast, VoiceOver/TalkBack labels; i18n as platform.
- Print: none on device (share PDF).

## 14. Acceptance Criteria
1. Given a registered device with biometric enrolled, when the app resumes after 20 min idle, then biometric/PIN unlock is required and the queue context is preserved after success.
2. Given a patient checks in for the logged-in doctor, then a push arrives within 5 s (foreground socket < 1 s) with no PHI beyond configured initials, and tapping opens the queue card.
3. Given the phone is offline, when the doctor writes notes and signs an Rx (offline_rx enabled) for a queued patient, then both queue locally with idempotency keys and sync within 30 s of reconnect; the Rx shows `signed_offline` until server CDSS passes, after which pharmacy can dispense.
4. Given a desktop user signed a different Rx for the same visit while offline, when the mobile Rx syncs, then it becomes a conflict draft with a banner (no overwrite) and appears in the doctor's conflict list.
5. Given a critical potassium result, then the alert is delivered with sound, requires ack; if unacked in 5 min it escalates to the configured on-call and SMS fallback is sent when push undelivered in 2 min.
6. Given the doctor acks a critical alert on the phone, then the desktop banner clears within 2 s and the ack is stored once (idempotent).
7. Given voice input "paracetamol 650 thrice daily 3 days", then the text appears in the note draft; nothing is added to Rx automatically (Phase 2); AI-004 later maps to structured Rx as suggestion.
8. Given a barcode scan of an OP slip, then the patient opens within 1 s if in cache, or fetches online.
9. Given IT revokes the device in EN-007, then the next API call returns 401, the app purges local cache and returns to login.
10. Given app version below minimum, then API returns 426 and the app shows forced update.
11. Given the earnings screen, then values equal NC-034 read model for the doctor and are visible only to that doctor.
12. Given a resident, then Rx sign shows "Send for co-sign" only; consultant receives push and can co-sign from mobile.
13. Given Safari iOS PWA not installed, then the app shows a guided "Add to Home Screen" prompt explaining push limitations.
14. Given a batch sync where one mutation is invalid (queue action on already-completed visit), then that item is rejected with reason and the others apply.

## 15. Enhancements / Later phases
- Sheet row 18 enhancements: wearable device data integration (Phase 12 EN-042/OP-020 → doctor view), AI priority sorting of notifications (AI-005), secure inter-doctor messaging (`doctor_app.messaging`, Phase 8/13), digital signature for notes/reports (EN-016 DSC/eSign from mobile, Phase 5+), multi-hospital dashboard (EN-041, Phase 8).
- Costed proposal line 1574 (queue view, vitals preview, quick consult, e-Rx, lab results, push alerts, offline mode, earnings) — core (PWA Phase 2, RN Phase 13).
- Phase 13 RN: CallKit/ConnectionService for tele, background location for ambulance/on-call (optional), Siri/Google Assistant shortcuts, widgets (queue count), Wear OS/watchOS glances.
- (market) SMART HMIS Android doctor app; SmartHospital mobile queue — covered.

## 16. Open Questions for the Hospital
1. Is offline Rx signing acceptable, and for which drug classes? Narcotic Rx from mobile allowed with step-up 2FA?
2. Push privacy: show patient initials/token in notifications or fully generic?
3. Device policy: max devices per doctor, BYOD vs hospital-issued, MDM in use, root/jailbreak blocking?
4. Which doctors get earnings visibility; payout rules (NC-034) and statement cadence?
5. Voice-to-text languages needed at launch?
6. Store publishing accounts (Apple Developer/Google Play) under VIMS or hospital brand (white-label) for Phase 13?
7. Escalation chains for critical alerts per department/on-call rosters (NC-030)?
