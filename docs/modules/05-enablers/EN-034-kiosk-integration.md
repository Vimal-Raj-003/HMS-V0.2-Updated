# EN-034 — Kiosk Integration (Self Check-in via UHID / ABHA QR / Mobile OTP, Token Print, Payment Kiosk with UPI & Card, Report Print & Download, Feedback Kiosk, Queue Status, Accessibility, Device Management & Heartbeat, Hygiene, Offline Degradation)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Module ID       | EN-034                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Phase           | 10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Depends on      | OP-001 (registration, appointments, patient search), EN-006 (queue & token issue), EN-005 (thermal token/receipt printing, A4 report printing), EN-010 (payment gateway — UPI QR, card via P2PE terminal), EN-011 (ABHA QR scan & ABDM check-in), EN-013 (barcode/QR decoding), EN-009 (SMS/WhatsApp confirmations & OTP), EN-030 (feedback surveys), EN-007 (device accounts, settings), EN-024 (audit), EN-037 (device-down alerts), EN-018 (shares the display/signage device fleet concepts), EN-042 (device heartbeat & telemetry patterns)                                                                                                                                                                                                         |
| Consumed by     | EN-006 (tokens issued at kiosk), OP-001 (check-ins, demographic updates), NC-001 (cash counter reconciliation excludes kiosk digital payments but reports them), OP-005/IP-005 (payments posted to bills), OP-004/OP-008 (report collection), EN-030 (feedback responses with channel `kiosk`), EN-001 (self-service adoption analytics)                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Feature flag    | `module.kiosk.enabled` (sub: `kiosk.checkin`, `kiosk.payment`, `kiosk.reports`, `kiosk.feedback`, `kiosk.registration`, `kiosk.abha`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Primary roles   | Patient (59) & Family/Attendant (60) — anonymous kiosk users; Kiosk/Device account (64)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Secondary roles | Receptionist / Front Office (24 — assists and monitors), IT Admin (56 — fleet, provisioning, firmware), Branch Admin (3 — flow config, languages, hours), Cashier (26 — payment reconciliation), Housekeeping Supervisor (50 — cleaning schedule), Biomedical/Facility (48/49 — hardware faults), Marketing (55 — idle-screen content)                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Regulatory      | **DPDP Act 2023 & Rules 2025** — a kiosk is a shared, public terminal: notice on screen, minimum data on display, automatic session termination, no residual PHI after logout; **ABDM/ABHA** scan-and-share check-in (HIP registration, ABHA QR at counter, consent artefact — EN-011); **PCI-DSS** — card payments only through a P2PE-certified terminal; the kiosk application never sees or stores PAN/CVV; **GST** invoice/receipt requirements for any printed payment receipt; **RPwD Act 2016 & Harmonised Guidelines for Accessible India** — accessible height, reach, tactile/audio support; **NABH** patient rights (information availability, grievance channel), infection-control policy for shared touch surfaces; CERT-In log retention |

## 1. Purpose

EN-034 turns physical kiosks in the lobby, lab reception, pharmacy and ward corridors into a safe, accessible extension of the HMS: patients check themselves in with a UHID card, ABHA QR or mobile OTP, print a token, pay a bill by UPI or card, collect a lab report, see queue status, and leave feedback — reducing counter queues without creating a privacy or hygiene hazard. It also owns the **fleet**: provisioning, kiosk mode lockdown, heartbeat, peripheral health (printer, scanner, payment terminal), remote configuration, and graceful offline degradation.

## 2. Users & Jobs-to-be-done

- **Patient with an appointment (kiosk, 30–60 s)**: scan the appointment QR / ABHA QR / enter mobile + OTP → confirm identity → check in → token printed with department, doctor, token number and estimated wait.
- **Walk-in patient**: search by mobile/UHID, confirm demographics (or complete a short registration), select department, pay the consultation fee, and receive a token — without joining the counter queue.
- **Patient paying a bill**: scan the bill QR or enter the bill number → see the amount → pay by UPI QR or card on the attached terminal → printed GST receipt + SMS receipt.
- **Patient collecting a report**: authenticate (mobile OTP or UHID + DOB) → see ready reports → print at the kiosk printer or send the download link to their phone.
- **Departing patient (feedback kiosk)**: 3 taps of emoji/star feedback with an optional comment (EN-030), fully anonymous or linked by token.
- **Attendant/family (60)**: check queue status for a relative, pay an IP interim bill, and print a visitor/bystander pass QR (EN-015).
- **Front Office (24)**: watch the kiosk status board, help a stuck patient, take over a session at the counter, and clear a paper jam.
- **IT Admin (56)**: provision a new kiosk in minutes with a pairing code, push configuration and content, monitor heartbeats and peripheral health, and remotely lock or reboot a device.

## 3. Core Workflows

### 3.1 Kiosk provisioning & device management

1. IT Admin creates a **kiosk record** (branch, physical location, purpose profile: `checkin` / `payment` / `reports` / `feedback` / `multi`, language set, business hours, idle content) → the system issues a short **pairing code**.
2. The kiosk app (Next.js PWA in Chrome/Chromium kiosk mode on Windows or a locked-down Android tablet) is launched, the pairing code is entered once → the device receives a **device certificate + long-lived device token** (EN-007 device accounts, rotated every 30 days) bound to a hardware fingerprint. No staff credentials ever live on a kiosk.
3. **Kiosk mode lockdown**: full-screen, no URL bar, no OS taskbar, disabled right-click/keyboard shortcuts/USB storage/printing dialogs; an admin exit requires a staff PIN + reason (audited). Auto-launch on boot and auto-restart on crash (watchdog).
4. **Heartbeat** every 30 s carries: app version, uptime, network quality, peripheral status (token printer paper/ink, report printer, QR scanner, card terminal, camera, card dispenser), CPU/RAM/temperature, last transaction, screen-on state. Missing 3 heartbeats → `offline` → alert (EN-037).
5. **Remote actions**: reload, reboot, clear cache, update configuration, push a new app version (staged rollout by ring: pilot → branch → fleet, with automatic rollback if crash-rate rises), lock with a message ("This kiosk is temporarily closed — please use the counter"), and screenshot for support (privacy-guarded: only on the idle screen).
6. **Peripheral pairing**: token printer (ESC/POS via EN-005), A4 report printer, 2D QR scanner (HID keyboard-wedge), payment terminal (vendor SDK/USB/BT), optional Aadhaar-free biometric (not required), camera for QR fallback, and a card dispenser for UHID cards where used.

### 3.2 Session & identity (the safety core)

1. **Idle state** shows branded content (EN-018 shares the content model): hospital info, health tips, queue summary, doctor availability, marketing slides, and a large "Touch to start / छूकर शुरू करें" prompt with a language chooser.
2. **Start** → language selection persists for the session only → the patient chooses a task.
3. **Identification** (any of, per configuration):
   - **UHID card / appointment slip QR** scanned (EN-013 decode).
   - **ABHA QR scan-and-share** (EN-011): the patient scans the kiosk's displayed ABHA QR _from their app_, or presents their ABHA QR to the kiosk scanner → demographic + ABHA number received with a consent artefact → matched to the MPI or offered as a new registration.
   - **Mobile number + OTP** (EN-009): the strongest common path; OTP valid 5 minutes, 3 attempts, rate-limited per number and per device.
   - **UHID + DOB** as a fallback where SMS is unreliable (configurable, weaker — never used for report content).
4. **Multiple matches on a mobile number** (family) → a picker showing masked names (`RA••• K•••`, age, gender) — never full demographics; the patient selects theirs.
5. **Session rules**: hard timeout **90 s of inactivity** with a 15 s "are you still there?" countdown, then full session wipe and return to idle; a visible **"Finish & clear"** button on every screen; all session state is memory-only (no localStorage of PHI), and the app clears clipboard, form state and cached responses on exit.
6. **Privacy display rules**: names partially masked on shared screens, no diagnosis or clinical values ever rendered on a kiosk, report _content_ never displayed (print or link only), and a privacy-filter-friendly layout (critical info in the centre, large text).

### 3.3 Self check-in & token

1. Identified patient → the kiosk shows **today's appointments** (department, doctor, time, status) and any walk-in option enabled for the branch.
2. **Check-in validations**: within the check-in window (default 60 min before to 30 min after the slot), correct branch, appointment not already checked in/cancelled, no blocking dues if the branch requires payment-before-consult, and mandatory demographic confirmation if the record is stale (>12 months) or missing a key field.
3. **Demographic confirmation** shows only what is needed (name, age/sex, mobile last 4, address city) with an "update at counter" path; kiosks never allow editing of name/DOB/gender (identity-critical fields) — corrections go to the counter with a flag.
4. On confirm → OP-001 marks the appointment `checked_in` → EN-006 issues a **token** → thermal print (department, doctor, token no., counter/room, estimated wait, QR for live status, branch, timestamp) + SMS/WhatsApp copy → Events `kiosk.checkin.completed`, `queue.token.issued`.
5. **Walk-in registration** (`kiosk.registration`, optional): minimal fields (name, mobile with OTP, age/sex, address PIN) creating a provisional patient that must be verified at the counter before any clinical encounter; ABHA creation is offered but never mandatory (ABDM rule).
6. **Exceptions**: appointment not found → offer walk-in or "see counter"; arrived too early → show the window and offer queue status; dues blocking → route to the payment task; printer out of paper → token issued digitally with an on-screen + SMS QR and a front-office alert.

### 3.4 Payment kiosk

1. Patient selects **Pay a bill** → identifies (as §3.2) or scans the bill QR → the kiosk shows bill number, date, service summary (categories only, never diagnoses), amount payable, and any advance/dues.
2. **Payment methods**: **UPI** (dynamic QR generated by EN-010 with the exact amount and a 5-minute expiry, plus a "pay from your phone" flow), **card** on the attached **P2PE terminal** (the kiosk app never touches PAN/CVV — it sends only amount and reference and receives an approval token), and **payment link by SMS** as a fallback. Cash is never accepted at a kiosk.
3. Confirmation is **server-confirmed only** (webhook/status poll from EN-010) — the kiosk never marks a payment successful on a client-side event. On success: receipt posted to the bill (OP-005/IP-005), GST-compliant receipt printed, SMS/email receipt sent, Event `kiosk.payment.completed`.
4. **Failure/timeout**: clear message with the reference number, "no money was deducted — if debited it will auto-reverse in 3–5 days", a printed slip with the reference, and an automatic reconciliation entry for the cashier to check (EN-010 reconciliation owns the truth).
5. **Partial payments and advances** are allowed where the branch configures them; refunds are **never** issued at a kiosk (counter only).

### 3.5 Report print & download

1. Patient authenticates by **mobile OTP** (mandatory for report tasks — UHID+DOB is not sufficient) → the kiosk lists **ready** reports (test/study name category, date, status) with no values on screen.
2. Patient chooses **Print** (A4 printer at the kiosk, watermark + QR verification per EN-039/EN-013, page count shown) or **Send to my phone** (a signed, single-use, 24-hour link by SMS/WhatsApp, portal login or OTP-gated).
3. Print jobs are queued through EN-005 with a per-session cap (default 20 pages), a jam/out-of-paper fallback ("collect at the lab counter"), and a **print audit** entry per report (who authenticated, when, which document) as a PHI disclosure.
4. Pending/incomplete reports show status only ("in progress — expected 4 PM") and never partial results; critical results are **never** released at a kiosk (they route through the clinician per EN-029).

### 3.6 Feedback kiosk & queue status

- **Feedback** (EN-030): a 3-question express survey with large emoji/star controls, an optional voice-free comment via keyboard, submitted anonymously or linked to the token if the patient scanned it; auto-reset 15 s after submit; department/branch context comes from the kiosk record.
- **Queue status** (EN-006): a no-authentication screen showing current token per department/doctor and the estimated wait, plus a scan-your-token option for a personal "you are number 14, ~35 minutes" view.
- **Wayfinding & information**: floor maps, department locations, doctor availability today, visiting hours, tariff display (NABH rate transparency), and a grievance entry point (NC-032).

### 3.7 Accessibility, hygiene & physical design

- **Accessibility**: mounting height and reach per the Harmonised Guidelines (operable controls 800–1200 mm, knee clearance for wheelchair approach at the lower kiosk in each cluster — at least one accessible unit per bank), **large-text mode** toggle (≥150 %), high-contrast theme, minimum 12 mm touch targets, **audio guidance** with a headphone jack and volume control, tactile start button, screen-reader-compatible markup, no time-critical interactions without an extension option ("need more time?"), and multilingual UI + audio.
- **Hygiene / infection control**: antimicrobial screen coating and a wipeable bezel, a visible cleaning schedule with a QR the housekeeping staff scans to log each clean (NC-024), a hand-sanitiser dispenser mounted alongside, a **contactless preference** (QR-first flows, "pay from your phone", "send to my phone") so a patient can complete tasks with minimal touching, and an isolation-area policy (kiosks are not placed inside isolation zones; if they are, a stricter cleaning frequency and a disposable stylus are configured).
- **Physical/safety**: cable management, tamper-evident enclosure, UPS backup (≥15 min) so a payment in flight can complete, screen privacy filter, and camera (if fitted) physically shuttered unless a QR scan is active.

### 3.8 Offline degradation

- The kiosk keeps a **read-only cache** of today's appointment list for the branch, the department/doctor list, the queue snapshot, and the survey definition.
- When the network drops: check-in switches to **offline mode** — it verifies the patient against the cached appointment list, issues a **provisional token** from a device-local reserved number block (prefix `K<device>-`), prints it, and queues the check-in event; on reconnect the events sync, tokens are reconciled with EN-006, and duplicates are resolved by the server.
- **Payments are disabled offline** (no exceptions), report printing is disabled offline, and feedback is queued locally (up to 24 h).
- The screen shows an honest banner: "Working offline — token issued; please confirm at the counter". After 30 minutes offline the kiosk locks itself to the queue-status/idle screen and alerts IT.

## 4. Data Model (schema `engage`, prefix `kiosk_`)

- `kiosk_devices` — id, hospital_id, branch_id, code citext, name, location_text, floor, purpose_profile enum(checkin/payment/reports/feedback/multi/queue_display), hardware jsonb (model, os, screen, serial), fingerprint_hash, device_token_ref, cert_expires_at, app_version, config_version, languages text[], business_hours jsonb, accessible_unit bool, status enum(unpaired/active/locked/maintenance/retired), paired_at, last_seen_at, created…; UNIQUE(hospital_id, code).
- `kiosk_config` — id, device_id?/branch_id? (fallback hierarchy: device → branch → hospital), tasks_enabled jsonb (checkin, walkin, registration, payment, reports, feedback, queue, wayfinding), auth_methods jsonb (uhid_qr, abha_qr, mobile_otp, uhid_dob), session_timeout_sec, print_page_cap, checkin_window jsonb, payment jsonb (methods, min/max, partial_allowed), idle_content jsonb, theme, version, effective_from.
- `kiosk_heartbeats` — id, device_id, at, app_version, uptime_sec, network jsonb (type, rtt, loss), peripherals jsonb (token_printer{status,paper}, report_printer, scanner, card_terminal, camera), cpu_pct, mem_pct, temp_c, screen_on, last_txn_at; **partitioned monthly**, 30-day retention.
- `kiosk_sessions` — id uuidv7, hospital_id, branch_id, device_id, started_at, ended_at, end_reason enum(completed/timeout/cancelled/error/staff_takeover), language, tasks_attempted text[], tasks_completed text[], identified bool, auth_method, patient_id?, appointment_id?, duration_sec, steps int, abandoned_at_step?, error_code?; **partitioned monthly**; **no PHI beyond patient_id**; index (device_id, started_at desc).
- `kiosk_transactions` — id, session_id, device_id, type enum(checkin/walkin_register/token/payment/report_print/report_link/feedback/pass_print), ref_type, ref_id, amount?, payment_ref (EN-010), status enum(success/failed/pending/reversed/offline_queued), failure_code, printed bool, print_job_ref (EN-005), pages, at; index (device_id, at desc), (type, status, at).
- `kiosk_offline_queue` — id, device_id, kind enum(checkin/token/feedback), payload jsonb, created_at, synced_at, resolution enum(applied/duplicate/rejected), reject_reason.
- `kiosk_incidents` — id, device_id, kind enum(offline/paper_out/printer_error/scanner_error/terminal_error/crash/tamper/temperature/ups_on_battery), severity, opened_at, closed_at, auto_closed bool, ticket_ref (NC-028), note.
- `kiosk_cleaning_logs` — id, device_id, cleaned_by, method, at, verified_by; scanned from the kiosk QR by housekeeping.
- `kiosk_app_releases` — id, version, channel enum(pilot/branch/fleet), artifact_ref, checksum, released_at, rollout jsonb, rollback_of?, crash_rate.
- `kiosk_print_audit` — id, session_id, device_id, patient_id, document_type, document_ref, pages, auth_method, at; retained 3 years as a PHI disclosure record.
- Retention: sessions & transactions 2 years, heartbeats 30 days, incidents 1 year, print audit 3 years, offline queue purged after sync + 7 days.

## 5. Business Rules & Validations

- **No PHI persists on the device**: all session state is in memory, cleared on session end, timeout or crash; the service worker caches only non-PHI reference data; the app must pass a "walk away test" — after 90 s the next person sees nothing about the previous one.
- **Report tasks require mobile OTP**; UHID+DOB is never sufficient to release a document. Report _content_ is never rendered on screen — print or secure link only.
- **Identity-critical fields (name, DOB, gender, UHID) can never be edited at a kiosk**; corrections are flagged for the counter.
- **Card data never touches the kiosk app** — P2PE terminal only; no card entry screen exists in the codebase. Cash is never accepted; refunds are never issued.
- **Payments are confirmed server-side only** (webhook/poll from EN-010); a client-side "success" event alone never posts a receipt.
- **Offline**: check-in and token issue may proceed from the cached appointment list with a provisional token from a reserved block; payments, report printing and registration are hard-disabled offline. Offline check-ins are reconciled server-side with duplicate detection.
- Session timeout ≤ 90 s inactivity (configurable 60–120 s), with an explicit "Finish & clear" on every screen; a payment in progress extends the timeout until the gateway resolves or 3 minutes elapse.
- **One accessible unit per kiosk bank** is mandatory in configuration; large-text and audio modes are always available and cannot be disabled by branch config.
- Devices authenticate with a **device certificate bound to a hardware fingerprint**; a fingerprint mismatch locks the device and alerts IT (stolen/cloned device protection). Device tokens rotate every 30 days and are revocable instantly.
- Kiosk mode exit requires a staff PIN + reason and is audited; three failed PIN attempts lock the device and alert.
- **Rate limits**: OTP 3 per number per 10 min per device and 10 per device per hour; report prints capped per session; payment attempts capped at 3 per session — all to blunt fraud and nuisance use.
- A device offline for > 3 heartbeats raises an incident; offline > 30 min locks the kiosk to the idle/queue screen so patients are not misled.
- Every printed document carries the branch, timestamp, device code and a verification QR; every print is audited as a PHI disclosure.
- Idle-screen content is moderated (Marketing publishes, Branch Admin approves) and may never display patient names or clinical information.

## 6. API Surface (`/api/v1/kiosk`)

| Method   | Path                                                                   | Purpose                             | Permission                              | Notes                               |
| -------- | ---------------------------------------------------------------------- | ----------------------------------- | --------------------------------------- | ----------------------------------- |
| POST     | /devices ; GET /devices ; PATCH /devices/:id                           | fleet registry                      | `kiosk.device.manage` (IT Admin)        | issues pairing code                 |
| POST     | /devices/:id/pair {pairingCode, fingerprint}                           | device pairing                      | public + pairing code                   | returns device cert/token once      |
| POST     | /devices/:id/lock \| /unlock \| /reboot \| /reload \| /retire          | remote actions                      | `kiosk.device.manage`                   | audited                             |
| GET/PUT  | /config?deviceId                                                       | effective configuration             | device token / `kiosk.config.manage`    | device → branch → hospital fallback |
| POST     | /heartbeat                                                             | telemetry                           | device token                            | 30 s cadence, rate-limited          |
| POST     | /session/start ; /session/end                                          | session lifecycle                   | device token                            | no PHI in payload                   |
| POST     | /identify/otp/request ; /identify/otp/verify                           | mobile OTP identification           | device token                            | rate-limited per number & device    |
| POST     | /identify/qr                                                           | UHID / appointment / ABHA QR        | device token                            | EN-011 for ABHA scan-and-share      |
| GET      | /appointments/today                                                    | patient's appointments for check-in | device token + session identity         | minimal fields, masked              |
| POST     | /checkin                                                               | check in an appointment             | device token                            | idempotent per appointment          |
| POST     | /walkin                                                                | provisional registration + token    | device token (`kiosk.registration`)     | flagged for counter verification    |
| POST     | /token/print \| /reprint                                               | token issue & print                 | device token                            | via EN-006 + EN-005                 |
| GET      | /bills/payable ; POST /payment/initiate ; GET /payment/:ref/status     | payment flow                        | device token                            | server-confirmed only               |
| GET      | /reports/ready ; POST /reports/:id/print ; POST /reports/:id/send-link | report collection                   | device token + OTP-verified session     | print audited                       |
| POST     | /feedback/submit                                                       | express survey                      | device token                            | routes to EN-030                    |
| GET      | /queue/status?department                                               | public queue board data             | device token                            | no auth needed                      |
| POST     | /offline/sync                                                          | flush the local queue               | device token                            | duplicate-safe                      |
| GET      | /fleet/health ; GET /devices/:id/telemetry                             | monitoring                          | `kiosk.fleet.read` (IT, Front Office)   | WS `kiosk:health`                   |
| GET/POST | /incidents ; POST /incidents/:id/close                                 | device incidents                    | `kiosk.incident.manage`                 | links NC-028                        |
| POST     | /releases ; POST /releases/:id/rollout \| /rollback                    | app version management              | `kiosk.release.manage` (Super Admin/IT) | staged rings                        |
| POST     | /cleaning-log                                                          | housekeeping cleaning scan          | device token / housekeeping app         | NC-024                              |
| GET      | /analytics/usage ; /analytics/funnel ; /analytics/deflection           | reports                             | `kiosk.report.read`                     | read models                         |

## 7. Domain Events (outbox)

- `kiosk.session.started|completed|abandoned` → usage analytics, funnel read model.
- `kiosk.checkin.completed` → OP-001 appointment status, EN-006 token issue, EN-018 board.
- `kiosk.walkin.registered` → OP-001 provisional patient + counter verification task.
- `kiosk.payment.completed|failed` → OP-005/IP-005 receipt posting, EN-010 reconciliation, NC-001 daily summary (digital section).
- `kiosk.report.printed|link_sent` → PHI disclosure audit (EN-024), OP-004/OP-008 delivery evidence.
- `kiosk.feedback.submitted` → EN-030 response with channel `kiosk`.
- `kiosk.device.online|offline|locked|tamper_detected|fingerprint_mismatch` → EN-037 alert to IT & Front Office, NC-028 ticket.
- `kiosk.peripheral.fault` (paper out, printer error, terminal error) → front-office task + IT alert.
- `kiosk.offline.mode_entered|synced` → operations dashboard; duplicate tokens reported.
- `kiosk.release.rolled_out|rolled_back` → IT audit.
- Consumes: `appointment.created|cancelled`, `queue.token.called`, `lab.report.released`, `bill.finalized`, `payment.confirmed`, `patient.merged` (session identity invalidation).

## 8. Screens (UI)

All patient-facing kiosk screens: **1080p portrait or landscape, touch-first, ≥28 px base font, ≥12 mm targets, one primary action per screen, max 3 taps per task, no keyboard except an on-screen numeric/alphanumeric pad, no scrolling on primary flows.**

- **Idle / Attract** (kiosk): full-bleed branded slides, "Touch to start" in all configured languages cycling, queue summary strip, current time, and a discreet device code for support. Offline banner when applicable.
- **Language & Task chooser** (kiosk): 6 large tiles max — Check in, Pay bill, Collect report, Queue status, Feedback, Help — each with icon + word + local-language word.
- **Identify** (kiosk): three big options (Scan your QR / ABHA / Mobile OTP) with an animated scan target; OTP pad with large digits, resend timer, and "get help at counter".
- **Family picker** (kiosk): masked name cards with age/gender; never more than 6.
- **Check-in confirm** (kiosk): appointment card (doctor, department, time), "Is this you?" with masked demographics, `Confirm & get token` primary button.
- **Token printed** (kiosk): giant token number, department, counter/room, estimated wait, QR for live status, "SMS sent to ••••3421", auto-return in 10 s.
- **Payment** (kiosk): bill summary (categories only), amount in large type, method tiles (UPI QR / Card on terminal / Send link), live UPI QR with countdown, terminal prompt animation, then success/failure with reference and printed receipt.
- **Reports** (kiosk): list of ready documents (type + date only), `Print` / `Send to my phone`, page count and "collecting at counter" fallback; explicit "your report will not be shown on this screen" privacy note.
- **Feedback** (kiosk): 3 questions, emoji/star row, optional comment, thank-you with auto-reset.
- **Queue status** (kiosk/TV-like): department columns with now-serving and waiting counts, refreshed via WS.
- **Accessibility bar** (persistent, kiosk): large-text toggle, high-contrast toggle, audio toggle with volume, language switch, "need more time?" — always visible, never hidden behind a menu.
- **Staff overlay** (kiosk, PIN-gated): device code, network status, peripheral status, "clear session", "lock kiosk", "print test page", exit-kiosk-mode with reason.
- **Kiosk Fleet Dashboard** (desktop + Front Office wall view, IT/Front Office): map/grid of devices with RAG status, last seen, app version, paper level, today's transactions, incidents; row actions (lock, reload, reboot, ticket); filters by branch/purpose; auto-refresh via WS. Red cards float to the top.
- **Kiosk Configuration** (desktop, Branch Admin/IT): task toggles, auth methods, session timeout, check-in window, payment methods and caps, languages, idle content scheduling, theme, and a "preview as kiosk" mode.
- Empty/error states (patient-facing, all localised and blame-free): "We couldn't find an appointment for this number — please see counter 3", "The printer is out of paper — your token has been sent to your phone", "Payment could not be completed — no money was deducted. Reference K-88213", "This kiosk is temporarily closed — counters are open until 8 PM".

## 9. Integrations

- **EN-006** token issue and queue status; **OP-001** appointments, patient search, provisional registration; **EN-011** ABHA scan-and-share check-in with consent artefact; **EN-013** QR/barcode decoding; **EN-009** OTP, token SMS/WhatsApp, report links; **EN-010** UPI dynamic QR and card terminal orchestration with server-side confirmation and reconciliation; **EN-005** thermal token/receipt printing (ESC/POS) and A4 report printing with print-queue status; **EN-030** feedback responses; **EN-015** bystander/visitor pass printing where enabled; **EN-018** shares the idle-content model and the same device fleet philosophy; **EN-037** device alerting; **NC-028** helpdesk tickets for hardware faults; **NC-024** housekeeping cleaning logs.
- **Hardware**: Windows/Android kiosk enclosures (e.g. 21–32" capacitive touch), ESC/POS thermal printers (Epson TM-T82/T88, TVS), A4 laser printers, 2D imagers (Honeywell/Zebra/Newland) as HID, P2PE card terminals (Pine Labs, Ezetap, Mswipe, Razorpay POS), UPS, optional card dispensers. Device management can additionally sit behind an MDM (Android Enterprise/Intune) — EN-034 owns app-level config, MDM owns OS-level policy.

## 10. Reports & Analytics

- **Adoption/deflection**: kiosk transactions per day by type and device, % of check-ins done at kiosk vs counter (counter-deflection rate), average counter queue length before/after kiosk deployment, peak-hour deflection.
- **Funnel**: sessions started → identified → task completed, with drop-off by step and by language; abandonment reasons (timeout, failed OTP, no appointment, printer fault).
- **Speed**: median session duration by task (target: check-in < 45 s, payment < 90 s, report < 60 s), OTP success rate, scan success rate.
- **Payments**: kiosk collections by method and branch, success/failure/reversal rates, average ticket size, reconciliation exceptions.
- **Device health**: uptime %, offline episodes and duration, incidents by kind, paper-out frequency, mean time to repair, app version distribution, crash rate by version.
- **Accessibility usage**: large-text/audio mode usage, accessible-unit utilisation, language distribution (informs staffing and signage).
- **Hygiene**: cleaning-log compliance per device per shift.
- Read models: `analytics.mv_kiosk_daily`, `analytics.mv_kiosk_funnel`, `analytics.mv_kiosk_device_health`.

## 11. Notifications

- **IT / Front Office**: device offline > 90 s, paper out / low, printer or scanner error, card terminal disconnected, tamper or fingerprint mismatch, UPS on battery, crash-rate spike after a release, kiosk locked by staff.
- **Front Office**: "patient at Kiosk 2 needs help" (triggered by 3 failed identifications or an explicit Help button), walk-in provisional registrations awaiting counter verification, offline check-ins needing reconciliation.
- **Patient (via EN-009)**: token SMS/WhatsApp copy, payment receipt, report link, "your check-in is confirmed".
- **Housekeeping**: cleaning due per schedule (NC-024).
- **Marketing/Branch Admin**: idle-content schedule published/expired.

## 12. Permissions (RBAC keys)

`kiosk.device.manage` (IT Admin 56) · `kiosk.config.manage` (IT Admin, Branch Admin 3) · `kiosk.fleet.read` (IT, Front Office 24, Hospital Admin 2) · `kiosk.incident.manage` (IT, Facility 49) · `kiosk.release.manage` (Super Admin 1, IT Admin) · `kiosk.session.takeover` (Front Office — pull a stuck session to the counter) · `kiosk.report.read` (Admin, IT, Branch Admin) · `kiosk.content.manage` (Marketing 55, approved by Branch Admin) · device-scoped implicit rights via the **Kiosk/Device role (64)**: `kiosk.checkin.create`, `kiosk.token.issue`, `kiosk.payment.initiate`, `kiosk.report.print` (session-authenticated), `kiosk.feedback.submit`, `kiosk.queue.read` — all scoped to the device's branch and rate-limited.

## 13. Non-functional

- **Volumes (2000-bed, 5000 OP/day)**: 8–16 kiosks per large branch; target 25–40 % of OPD check-ins self-served ⇒ 1200–2000 kiosk check-ins/day, 300–600 payments/day, 200–400 report collections/day, 400–800 feedback submissions/day; peak 09:00–11:00 with ~6 sessions/minute across the fleet.
- **Performance**: first meaningful paint on idle < 1 s; screen-to-screen transition < 250 ms; OTP request round-trip p95 < 1.5 s; appointment lookup p95 < 400 ms; token print (command sent to paper out) < 3 s; payment status resolution < 8 s typical, 3 min hard timeout.
- **Availability**: kiosk app must survive network loss (offline check-in per §3.8), printer loss (digital token), and gateway loss (payments disabled with a clear message); auto-restart within 15 s of a crash; UPS ≥ 15 min.
- **Footprint**: app bundle ≤ 3 MB gzipped, memory ≤ 400 MB steady, runs on a 4 GB RAM mini-PC or a mid-range Android tablet; content assets streamed and cached with a size budget.
- **Security**: device certificate + hardware fingerprint, 30-day token rotation, TLS 1.3, no PHI at rest, kiosk-mode lockdown, screen privacy filter, USB storage disabled, remote wipe of cache, all admin exits audited; the device account can do nothing outside its branch and task scope.
- **Accessibility**: WCAG 2.2 AA, RPwD-compliant mounting for the designated accessible unit, audio guidance with headphone jack, large-text ≥150 %, high contrast, no colour-only signalling, timeouts extendable on request.
- **i18n**: full UI + audio in `en-IN, hi, ta, te, ml, kn, mr, bn` (branch-configurable subset), RTL-ready for `ar`; printed tokens/receipts bilingual (English + local).
- **Hygiene**: cleaning schedule enforced by QR-scan logging with a compliance report; contactless alternatives available for every task.

## 14. Acceptance Criteria

1. **Given** a patient with a booked appointment scans their appointment QR, **when** they confirm identity, **then** the appointment is checked in, a token prints within 3 seconds with department, doctor, token number and estimated wait, and an SMS copy is sent.
2. **Given** a patient identifies by mobile OTP, **when** the number matches three family members, **then** a picker shows masked names with age and gender only, and no other demographic data is displayed.
3. **Given** a session is idle for 90 seconds, **when** the countdown expires, **then** the session is wiped, the kiosk returns to the idle screen, and no trace of the previous patient (name, appointment, report list) is retrievable by the next user.
4. **Given** a patient requests a lab report at the kiosk, **when** they authenticate with UHID and DOB only, **then** the report task is refused and mobile OTP is required.
5. **Given** report printing is authorised, **when** the report prints, **then** no result values are ever displayed on the kiosk screen, the printout carries a verification QR and watermark, and a PHI print-audit record is written.
6. **Given** a UPI payment is initiated, **when** the patient completes it on their phone, **then** the receipt is posted only after server-side confirmation from EN-010, a GST-compliant receipt prints, and the bill reflects the payment.
7. **Given** a card payment is made, **when** the transaction runs, **then** the card is read only by the P2PE terminal, the kiosk application never receives or stores PAN/CVV, and only an approval token is recorded.
8. **Given** a payment fails or times out, **when** the flow ends, **then** the patient sees the reference number and a clear "no money was deducted; if debited it auto-reverses in 3–5 days" message, and a reconciliation entry is created.
9. **Given** the network is unavailable, **when** a patient with a cached appointment checks in, **then** a provisional token from the device's reserved block prints, payment and report tasks are disabled with an explanation, and the check-in syncs and reconciles without creating a duplicate token when connectivity returns.
10. **Given** a kiosk misses three consecutive heartbeats, **when** the monitor evaluates, **then** the device shows as offline on the fleet dashboard, an alert reaches IT and Front Office, and an incident is opened.
11. **Given** the token printer runs out of paper, **when** a check-in completes, **then** the token is delivered digitally by SMS with an on-screen QR, a front-office task is raised, and the peripheral fault is reported.
12. **Given** a device is moved to different hardware, **when** its fingerprint no longer matches, **then** the device locks, refuses all API calls, and raises a tamper alert.
13. **Given** the accessibility bar, **when** a patient enables large text and audio, **then** every subsequent screen renders at ≥150 % with audio prompts in the selected language, and the setting persists only for that session.
14. **Given** a patient attempts to change their name or date of birth, **when** they open the demographic confirmation, **then** those fields are read-only with a "please visit the counter" action, and only non-identity fields may be updated.
15. **Given** three failed identification attempts, **when** the third fails, **then** the kiosk offers help, notifies the front desk, and does not reveal whether the number exists in the system.
16. **Given** an app release is rolled out to the pilot ring, **when** the crash rate exceeds the threshold, **then** the rollout halts automatically and the previous version is restored on affected devices.
17. **Given** a staff member exits kiosk mode, **when** they enter the PIN and reason, **then** the exit is audited with device, user and reason, and three failed PIN attempts lock the device.
18. **Given** a housekeeping staff member scans the kiosk cleaning QR, **when** the log is submitted, **then** the cleaning is recorded against the device and shift, and compliance appears in the hygiene report.

## 15. Enhancements / Later phases

- **Face-match check-in** against the registered patient photo (opt-in, on-device matching only, no biometric template leaving the device) and **fingerprint** identity where EN-020 is deployed — both strictly optional and never mandatory (ABDM/DPDP posture).
- **Aadhaar-free e-KYC via ABHA** for full self-registration with demographic auto-fill, and ABHA creation at the kiosk (EN-011 M1).
- **Kiosk-based sample-collection token** for lab (call to phlebotomy bay), **pharmacy pickup token**, and **discharge-clearance status** for attendants.
- **Voice-first kiosk** in Indian languages for low-literacy users; sign-language video guidance loop.
- **Cash-accepting/queue-buster tablets** carried by staff (a "mobile kiosk" mode of the same app) for peak-hour roaming check-in.
- **Digital signage convergence** with EN-018 so the same fleet can flip between kiosk and display roles by schedule.
- **Predictive maintenance** from heartbeat telemetry (printer failure prediction, thermal head wear) via EN-042/AI-005.
- **Wayfinding with indoor navigation** (QR → phone-based route to the department) and hospital map integration.

## 16. Open Questions for the Hospital

1. How many **kiosks**, at which locations and in which branches, and what is the physical form factor (floor-standing, wall-mounted, counter tablet)?
2. Which **tasks** should each kiosk offer at go-live — check-in only, or also payment, report collection, walk-in registration and feedback?
3. Is **walk-in self-registration** acceptable, or must every new patient be registered by staff (provisional record + counter verification is the default)?
4. What **identification methods** are permitted (UHID QR, ABHA QR, mobile OTP, UHID+DOB), and is mobile OTP available for all patients (SMS reachability)?
5. Which **payment methods** at kiosks — UPI only, or card via a P2PE terminal? Which terminal vendor, and who owns the merchant account and reconciliation?
6. Should kiosks **print reports**, and is there a policy on which report types may be released without a counter interaction (e.g. exclude HIV, oncology, genetic)?
7. What is the **check-in window** policy (how early/late relative to the appointment) and does the branch require payment before consultation?
8. Which **languages** and whether **audio guidance** is required; who supplies voice recordings?
9. What is the **cleaning/infection-control policy** for shared touch surfaces, and should cleaning be logged by QR scan?
10. Where will the **accessible (wheelchair-height) unit** be placed in each kiosk bank, and are the Harmonised Guidelines dimensions already specified by the architect?
11. What should happen when the network is down — is an **offline provisional token** acceptable, and who reconciles it at the counter?
12. Is there an existing **MDM** (Intune, Android Enterprise, Scalefusion) that should manage the OS layer, with EN-034 handling only the application?
13. Who owns kiosk **hardware support** (vendor AMC vs in-house biomedical/IT), and what is the target repair SLA?
14. Should idle screens carry **advertising or third-party content**, and who approves it (NABH and patient-dignity considerations)?
