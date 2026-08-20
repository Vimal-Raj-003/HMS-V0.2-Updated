# OP-020 — Patient Mobile App (OTP login, Booking, Queue tracking, Records, Lab reports, Bill pay, Family management, Push) — PWA first, React Native later

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Module ID       | OP-020                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Phase           | 10 (PWA — shares codebase with PE-001 patient portal; booking/queue widgets can ship in Phase 1–2 as web) → 13 (React Native/Expo iOS & Android)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Priority        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Complexity      | Very High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on      | PE-001 (patient portal — same backend & most screens; OP-020 is the mobile shell + native capabilities), OP-001 (appointments, slots, UHID/ABHA), EN-006 (queue position/ETA), EN-010 (Razorpay/UPI payments), OP-005 (bills/receipts), OP-004/OP-008 (reports, images via EN-008 share links), OP-002 (Rx PDFs, visit summaries with doctor-authorised visibility), OP-018 (tele-consult), OP-013 (immunisation schedule), OP-011/OP-015/OP-016/OP-017 (diet plan, HEP, pain diary, wound photo upload), OP-014 (health check-up booking/reports), PE-002 (follow-ups/reminders), PE-003 (education), PE-005 (wellness/loyalty), EN-009 (SMS/WhatsApp OTP & fallbacks), EN-037 (push), EN-011 (ABHA login/link, consent-based fetch), EN-028 (consents; family linking consent), EN-030 (feedback), NC-032 (grievance), EN-002/RC-001 (claim status), AI-001 (chatbot), EN-042 (home devices), TR-009/NC-013 (ambulance SOS), EN-034 (kiosk parity), EN-013 (QR check-in) |
| Feature flag    | `module.patient_app.enabled` (sub: `patient_app.family`, `patient_app.tele`, `patient_app.wellness`, `patient_app.sos`, `patient_app.chatbot`, `patient_app.claims`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Primary roles   | Patient (59), Family / Attendant (60)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Secondary roles | Receptionist/Call centre (24/25, assisted booking & app support), Doctor (authorises note visibility), Billing (27), Privacy officer (57), Marketing (55, campaigns via EN-009 with consent), IT admin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Regulatory      | DPDP Act 2023 & Rules 2025 (consent notices in plain language, purpose limitation, children's data — verifiable parental consent, data principal rights: access/correction/erasure/grievance/nomination; breach notification), ABDM V3 (ABHA login, PHR/consent manager, scan-and-share, HIP/HIU), IT Act SPDI, TRAI DLT (OTP/notification templates), RBI/PCI-DSS via gateway tokenisation (no card data in app), TPG 2020 (tele), MoHFW health-app guidance, Apple/Google health app policies & accessibility, WCAG 2.2 AA                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 1. Purpose

OP-020 is the patient's own window into Vim's HMS on their phone: passwordless OTP/ABHA login, doctor discovery and appointment booking with online payment, live queue tracking with "you are next" pushes, timeline of consultations, prescriptions and lab/radiology reports (PDF & images) with doctor-authorised note visibility, bill view/pay and receipts, family member management from a single login (with consent), reminders (appointments, medications, follow-ups, vaccines), tele-consult in-app, health-check bookings, specialty patient tools (diet plan, home exercises, pain diary, wound photo upload, PROMs), feedback/grievance, and later chatbot, wellness/goals, SOS and insurance claim status. Phase 10 delivers an installable PWA (shared with PE-001), Phase 13 React Native (Expo) with native push, biometrics, camera and health-platform integrations.

## 2. Users & Jobs-to-be-done

- **Patient** (any Android/iOS phone, low-end included, 2G/3G tolerant, multilingual): book/reschedule/cancel, pay, know when to come in, download reports/Rx, pay bills, share records with another doctor (ABDM), manage family, chat with hospital, join tele-call, follow care plans.
- **Family/caregiver**: manage elderly parents'/children's appointments & records with consent; receive their alerts.
- **Reception/call centre**: link app accounts, resend OTP/links, assisted booking, troubleshoot.
- **Doctor**: controls note visibility (share summary/full note), sees PROMs/diaries entered by patient.
- **Privacy officer**: consent ledger, DSAR requests initiated from app.

## 3. Core Workflows

### 3.1 Login & profile

1. Enter mobile → OTP (EN-009 DLT; WhatsApp OTP fallback; rate-limited, 6-digit, 5 min) → verify → JWT session (access 15 min, refresh 30 days rotating, device-bound; biometric app-lock optional (WebAuthn/Expo LocalAuthentication)) → profile auto-loaded from MPI by mobile match (multiple UHIDs → choose/merge request); new user → mini registration (name/DOB/sex/…) → UHID pre-registration (OP-001 completes at first visit) ; **ABHA login/link** (EN-011: ABHA number/address, OTP via ABDM) and create ABHA in-app; language selection; consent notice (DPDP) with granular purposes (care, reminders, marketing opt-in, research) → consent ledger (EN-028).
2. Children (< 18) profiles only under a verified parent/guardian account (verifiable parental consent).

### 3.2 Appointment booking

1. Browse **specialty → doctor** (profile: photo, qualifications, languages, fee, tele availability, next available, ratings from EN-030 if enabled) or symptom-guided (AI-001 later) → slot picker (real-time availability OP-001; branch filter; in-person/tele) → patient/family member → reason → **pay online (Razorpay/UPI/cards/wallets/net-banking; EN-010)** or pay-at-hospital if policy → confirmation with **queue token/appointment no.**, QR for check-in (EN-013/EN-034 kiosk), directions, prep instructions → add to calendar; reschedule/cancel with policy (refund via EN-010; cutoff hours), waitlist join; recurring (dialysis/physio) view.
2. Health check-up (OP-014) and procedure/lab bookings (home sample collection OP-004) with instructions.

### 3.3 Live queue tracking

- After check-in (QR at kiosk/reception or geo-check-in optional): **position, tokens ahead, estimated wait** (EN-006 ETA model), doctor status (in/late/break), room/floor; push: "3 patients ahead", "You are next — proceed to Room 5", "Doctor is ready" ; multi-station routing (vitals → doctor → lab) shown as steps; if delayed > X min → apology + option to reschedule (config); works as lock-screen live activity (RN later).

### 3.4 Medical records

- **Timeline** of visits (OPD/IP/ER/tele/health-check) → per visit: doctor, diagnosis (if released), vitals, **prescription PDF** (download/share, pharmacy reorder request → OP-003 home delivery later), **lab reports** (PDF, structured values with normal ranges & trend graphs, ready push), **radiology reports + images** (viewer link EN-008 share; DICOM download optional), discharge summaries (IP-002), certificates (vaccination, fitness), invoices/receipts, consent copies; **clinical notes visibility** controlled by doctor/hospital policy (summary always; full note on doctor authorisation or after N days); documents from other hospitals via **ABDM consent-based fetch (HIU)** and **scan-and-share** at reception; upload own external reports (photos/PDF) tagged to timeline (visible to doctors); health records vault; DSAR/correction request; download all (DPDP portability).

### 3.5 Bills & payments

- Outstanding OP/IP bills, estimates (RC-008), advance/deposit top-up (IP-005), pay via EN-010 (UPI intent/collect, cards, wallets, EMI links), receipts (PDF, GST), payment history, refunds status, insurance/claim status (`patient_app.claims` via EN-002/RC-001: pre-auth approved/queried, claim settled), corporate/TPA coverage tags, 80D receipts.

### 3.6 Family management (`patient_app.family`)

- Add family member: by mobile OTP of member (adult) or as dependant (child/elderly without phone, with relationship & ID/consent capture per DPDP; hospital verification at desk if needed) → switch profile → book/pay/view for them; permissions per member (view records Y/N, book Y/N, pay Y/N); member can revoke; audit; nomination (DPDP) optional.

### 3.7 Notifications & reminders (EN-037/EN-009)

- Appointment confirmation/reminder (D-1, 2 h), queue updates, lab/radiology report ready, prescription ready/dispensed, bill generated/payment due, follow-up due (PE-002), medication reminders with adherence log (from Rx sig; opt-in) & refill reminder, vaccine due (OP-013), health check-up annual, diet/HEP/pain diary prompts, tele link, feedback request, education content (PE-003), grievance updates; channel preference (push → WhatsApp → SMS fallback), quiet hours, language.

### 3.8 In-app services

- Tele-consult join (OP-018), chatbot (AI-001: FAQs, booking, symptom triage — human hand-off to call centre EN-033), feedback/NPS (EN-030), grievance/complaint (NC-032) with status, health education library (PE-003), wellness/goals/loyalty (PE-005 & steps/HR from Google Health Connect/Apple HealthKit in RN; `patient_app.wellness`), medication adherence score, care-plan tools (OP-011 diet plan & food diary, OP-015 HEP videos & adherence, OP-016 pain diary, OP-017 wound photo upload, OP-009 PROMs, OP-013 immunisation card, OP-040 ANC schedule), emergency **SOS** (`patient_app.sos`: one-tap call to hospital ER/ambulance with GPS location shared to TR-009/NC-013 dispatcher, emergency contacts, medical ID card offline: blood group, allergies, conditions), hospital info (directions, departments, visiting hours, doctors), ABHA card, insurance cards wallet, offline access to last-downloaded reports & QR.

### 3.9 Exceptions

- OTP not received → WhatsApp/voice OTP fallback (EN-033), rate limits & lockout; duplicate profiles → merge request to MRD; payment success but booking failed → auto-refund/retry queue (EN-010 reconciliation); report withheld (critical value process/doctor review pending) → "available after review"; consent withdrawn → data hidden per purpose; account deletion (DPDP erasure) → request → retention exceptions explained (legal record keeping) → portal access removed, marketing data purged; offline: cached timeline/reports/QR readable; booking requires network.

## 4. Data Model (schema `engage` + `patient`; clinical data owned elsewhere)

- **portal_accounts** (PE-001 shared): id, hospital_id (or group scope EN-041), mobile (citext, unique per group), abha_address?, status enum(active/locked/deleted), language, created_at, last_login_at, deletion_requested_at.
- **portal_account_patients** (links): account_id, patient_id, relationship enum(self/child/parent/spouse/sibling/other), permissions jsonb ({records, book, pay, notifications}), consent_id (EN-028), verified_by enum(otp/desk/guardian), status enum(active/revoked), created_at.
- **portal_devices**: id, account_id, platform enum(pwa_android/pwa_ios/rn_android/rn_ios/web), push_token (enc), biometric_lock bool, last_seen_at, revoked_at.
- **portal_sessions** (core sessions with account type patient).
- **record_release_policies**: hospital_id, doc_type, default_visibility enum(hidden/summary/full), delay_days, doctor_override bool; **record_release_overrides**: encounter_id/document_id, visibility, set_by, reason.
- **patient_uploads**: id, patient_id, account_id, kind enum(report/prescription/image/other), s3_key, taken_at, notes, visible_to_doctors bool, reviewed_by?.
- **medication_reminders**: id, patient_id, rx_item_id?, drug_name, schedule jsonb, start/end, channel prefs; **medication_adherence** (partitioned): patient_id, reminder_id, due_at, taken_at?, status enum(taken/missed/skipped).
- **portal_notification_prefs**: account_id, patient_id, channels jsonb, quiet_hours, categories jsonb.
- **sos_events**: id, hospital_id, account_id, patient_id, at, lat/lng, accuracy, contact_called, dispatched_trip_id?, status.
- **health_data_samples** (wellness; consented): patient_id, source enum(healthkit/health_connect/manual/device), type, value, unit, at (partitioned).
- **dsar_requests** (privacy): account_id, patient_id, type enum(access/correction/erasure/portability/nomination/grievance), status, submitted_at, resolved_at, notes.
- **portal_audit** (EN-024): PHI reads by account & family links.
- Read models: `analytics.patient_app_daily`.

## 5. Business Rules & Validations

- OTP: 6 digits, expiry 5 min, max 5 attempts/15 min, resend ≥ 30 s, device fingerprint & rate limit per mobile/IP; login session 30 days rolling; biometric app-lock optional but forced for family accounts with dependants (config).
- Identity: mobile must match MPI or new pre-registration; a mobile shared by multiple patients (family phone) → account may link several profiles only after OTP + relationship consent; hospital desk verification for records access of adults not verifiable by OTP.
- Record visibility follows `record_release_policies` (default: lab/radiology reports after final & critical-value process; Rx immediately; notes summary; discharge summary on finalisation; MLC/psychiatry per restrictions); doctor can restrict/expand per document; withheld reason shown generically.
- Payments through EN-010 only (tokenised; no PAN storage); booking confirmed only on gateway webhook success; refunds via policy engine; receipts numbered gapless by OP-005.
- Family: adult members require their own OTP consent; dependants require guardian declaration + optional ID; permissions revocable; children data purpose-limited; at 18 the linked child is prompted to own account (config).
- Consent ledger (EN-028) records purposes; marketing only with opt-in; DPDP notices per language; data principal requests SLA (config, e.g. 30 days) tracked; erasure honours statutory retention with explanation.
- Push payloads no PHI beyond category (e.g. "Report ready"); deep-link fetch requires unlocked session.
- SOS: only for hospitals with ER/ambulance enabled; shares live location for 15 min; dispatcher acknowledgement shown.
- Health data (HealthKit/Health Connect) only with explicit consent, revocable, never shared with employer/insurer.
- Offline cache: last 20 documents + QR + medical ID encrypted; purge on logout.
- Multi-branch/group: single account across group hospitals (EN-041) with per-hospital RLS scoping.

## 6. API Surface (`/api/v1/portal` — patient scope tokens; shared with PE-001)

| Method      | Path                                                                                                        | Purpose                                          | Permission                        | Idem | Pag    |
| ----------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------- | ---- | ------ |
| POST        | /auth/otp/request, /auth/otp/verify, /auth/abha/login, /auth/refresh, /auth/logout                          | login                                            | public (rate-limited)             | Y    | –      |
| GET/PUT     | /me, /me/profiles, /me/preferences, /me/devices                                                             | account                                          | patient.self                      | Y    | –      |
| POST/DELETE | /me/family (invite/otp/dependant), /me/family/{id}/permissions                                              | family links                                     | patient.family.manage             | Y    | –      |
| GET         | /catalog/specialties, /doctors?specialty=&branch=&mode=, /doctors/{id}/slots?date=                          | discovery                                        | public/patient                    | –    | cursor |
| POST        | /appointments, PATCH /appointments/{id} (reschedule/cancel), POST /appointments/{id}/waitlist               | booking                                          | patient.appointment.manage        | Y    | –      |
| POST        | /payments/intent, /payments/verify (webhook EN-010)                                                         | pay                                              | patient.payment                   | Y    | –      |
| GET         | /queue/{visit_id} (socket `queue:patient:{visit}`)                                                          | live position/ETA                                | patient.queue.read                | –    | –      |
| POST        | /checkin/{token} (QR/geo)                                                                                   | self check-in                                    | patient.queue.read                | Y    | –      |
| GET         | /timeline?patient=&from=, /documents/{id}/url, /reports/{id}, /labs/trends?code=                            | records                                          | patient.record.read (self/family) | –    | cursor |
| POST        | /uploads (presigned)                                                                                        | own documents                                    | patient.record.upload             | Y    | –      |
| POST        | /abdm/consent-requests, GET /abdm/records                                                                   | HIU fetch (EN-011)                               | patient.abdm                      | Y    | cursor |
| GET         | /bills, /bills/{id}/receipt, /estimates, /claims                                                            | billing                                          | patient.bill.read                 | –    | cursor |
| POST        | /bills/{id}/pay, /deposits                                                                                  | payment                                          | patient.payment                   | Y    | –      |
| GET/POST    | /reminders/medications, /reminders/{id}/log                                                                 | adherence                                        | patient.self                      | Y    | cursor |
| POST        | /feedback, /grievances; GET /grievances/{id}                                                                | EN-030/NC-032                                    | patient.self                      | Y    | –      |
| POST        | /sos                                                                                                        | emergency                                        | patient.self                      | Y    | –      |
| GET         | /education?tags=, /wellness/*, /vaccination/card, /diet/plan, /physio/hep, /pain/diary, /wounds/{id}/upload | care tools (delegated)                           | patient scope                     | Y    | –      |
| POST        | /privacy/requests                                                                                           | DSAR                                             | patient.self                      | Y    | –      |
| GET         | /notifications, POST /notifications/{id}/read                                                               | centre                                           | patient.self                      | Y    | cursor |
| POST        | /sync (batch of patient-authored mutations: diaries, adherence, uploads meta)                               | offline sync (idempotent per client mutation id) | patient.self                      | Y    | –      |

## 7. Domain Events (outbox)

- `portal.account.created|linked_patient|family.linked|revoked`, `portal.login`, `appointment.booked|rescheduled|cancelled` (OP-001), `payment.received|refunded` (EN-010), `patient.checked_in.self`, `portal.document.viewed` (audit), `patient.upload.added` → doctor timeline, `medication.adherence.logged`, `sos.raised` {location} → TR-009/NC-013 dispatcher, `feedback.submitted`, `grievance.raised`, `dsar.requested` → privacy officer, `abdm.consent.granted` (EN-011).
- Consumes (for push/timeline): `queue.position.changed`, `queue.called`, `lab.report.released`, `rad.report.released`, `rx.signed`, `pharmacy.dispensed`, `bill.finalized`, `payment.due`, `followup.due`, `vaccination.dose.due`, `tele.session.ready`, `discharge.summary.final`, `claim.status.changed`, `hc.report.delivered`.

## 8. Screens (UI — phone single-pane, bottom nav: Home | Appointments | Records | Bills | More; profile switcher chip for family)

1. **Onboarding/login**: language, mobile → OTP (auto-read SMS on Android), ABHA option, consent notice (plain language, expandable purposes), biometric lock setup; error/lockout states.
2. **Home**: next appointment card with live queue widget (position/ETA/"you are next"), quick actions (book, pay, reports, tele, SOS), reminders due today, family chips, hospital announcements; offline banner (cached data).
3. **Book appointment**: specialty grid → doctor cards → slot picker (day strip, morning/evening) → member/reason → payment sheet (UPI apps) → success with QR & add-to-calendar; reschedule/cancel flows.
4. **Queue tracking**: big token, position ring, ETA, route steps (vitals → doctor), map/floor hint; push CTA; "running late? reschedule".
5. **Records timeline**: filters (visits/reports/Rx/discharge/certificates/uploads/other-hospital), visit detail, report viewer (PDF, values with ranges & trend charts), image viewer link, share (secure link/WhatsApp/ABDM), download all; upload sheet with camera.
6. **Bills**: outstanding list, pay sheet, receipts, deposits, claim status timeline, 80D receipts.
7. **Family**: members list, add flow (OTP/dependant), permissions toggles, revoke.
8. **Care tools**: medications & reminders (adherence calendar), diet plan, exercises (video), pain diary, wound photo upload, PROM questionnaires, immunisation card, ANC schedule.
9. **Tele-consult** (OP-018 UI), **Chatbot** (AI-001), **Feedback/Grievance**, **Education**, **Wellness/goals**, **SOS** (hold 3 s to trigger; medical ID card offline), **Settings/Privacy** (consents, DSAR, devices, delete account, language).
   Behaviour: real-time via socket for queue; push deep links; large type; RTL; dark/light; accessibility labels; low-data mode (no images).

## 9. Integrations

- Camera/barcode (EN-013): `BarcodeDetector`/ZXing in PWA, expo-camera + ML Kit in RN — scan hospital QR at entrance/kiosk/room for self check-in, scan medicine strip barcodes to set reminders, scan report/bill QR to fetch documents, capture photos for uploads (wound OP-017, external reports); biometrics: WebAuthn platform authenticator (PWA) / Expo LocalAuthentication (RN) for app-lock; offline: IndexedDB (PWA) / SQLite encrypted (RN) with sync of diaries/adherence via idempotent batch (`/portal/sync`), conflict rule = server wins for hospital-owned data, client wins for patient-authored diary entries (append-only), duplicates deduped by client mutation id.
- EN-010 Razorpay (Standard Checkout/UPI intent), webhooks; EN-009 OTP/WhatsApp (DLT); EN-037 push (Web Push VAPID; FCM/APNs Phase 13); EN-011 ABDM (ABHA auth, PHR consent, HIU); EN-008 image share links; EN-030 feedback; NC-032 grievance; AI-001 chatbot; TR-009/NC-013 SOS dispatch; HealthKit/Health Connect & BLE devices (RN Phase 13; PWA Web Bluetooth limited); calendar (ICS), maps deep links; SMS Retriever API (Android OTP autofill); Google Play Integrity/App Attest (RN) for anti-abuse.
- Failure handling: gateway webhook retries & reconciliation job; OTP provider failover; report download via presigned URLs (≤ 5 min) with retry.

## 10. Reports & Analytics

- App adoption (registrations, MAU, family links), booking share via app, payment share, no-show rate app vs other, queue satisfaction (delay vs ETA accuracy), report download latency (release → view), reminder engagement & medication adherence, tele uptake, feedback/NPS, grievances TAT, DSAR volume/SLA, SOS events, crash-free rate. Read model `analytics.patient_app_daily` (de-identified).

## 11. Notifications

- Templates (EN-009/EN-037; multilingual): appointment confirmed/reminder, queue position/next/ready, report ready, Rx ready/dispensed, bill due/paid receipt, follow-up due, medication time, refill due, vaccine due, tele link/doctor ready, health-check instructions, feedback request, grievance update, consent/DSAR status, security (new device login), marketing (opt-in only).
- Fallback chain push → WhatsApp → SMS for critical (appointment/queue/report), configurable.

## 12. Permissions (RBAC keys — patient scope + staff)

`patient.self`, `patient.family.manage`, `patient.appointment.manage`, `patient.payment`, `patient.queue.read`, `patient.record.read|upload`, `patient.bill.read`, `patient.abdm`; staff: `portal.account.support` (reception/call centre: link/unlink, resend OTP, view login status — no record access), `portal.release.override` (doctor), `portal.admin.configure` (policies, templates), `privacy.dsar.manage` (DPO). ABAC: self or linked family with permission flag; break-glass not applicable.

## 13. Non-functional

- Performance: PWA TTI < 2.5 s on 3G-class Android; home payload < 150 KB; queue socket update < 1 s; report PDF open < 3 s (presigned CDN); booking end-to-end < 60 s.
- Scale: 500k registered patients/tenant group, 50k MAU, 5k concurrent during morning peak; OTP throughput 200/min; push fan-out via EN-037 queues.
- Offline: cached timeline (last 20 docs), QR/token, medical ID, appointment cards; booking/payment online-only with clear messaging; RN background push.
- Security/privacy: MASVS L1+ (L2 for RN sensitive screens), OTP anti-abuse, device binding, biometric lock, encrypted cache, no PHI in push/logs/URLs, presigned short-lived links, DPDP consent ledger, DSAR tooling, account deletion flow, audit of family access.
- Accessibility/i18n: WCAG 2.2 AA, dynamic type, screen readers, colour-safe; en-IN + hi + regional (ta/te/ml/kn/mr/bn) + ar RTL; SMS/WhatsApp templates per language.
- Store readiness (Phase 13): privacy nutrition labels/data safety forms, health-data disclosures, white-label build variants per hospital brand.

## 14. Acceptance Criteria

1. Given a registered mobile, when OTP is verified, then the account loads all MPI profiles matched to that mobile and prompts to confirm self profile; 6th wrong OTP within 15 min locks for 15 min.
2. Given a doctor slot selected and Razorpay payment succeeded (webhook), then the appointment is confirmed, token/QR shown, confirmation push + WhatsApp sent; if webhook fails to arrive within 2 min, reconciliation confirms or auto-refunds.
3. Given the patient checks in via QR, then the queue widget shows position/ETA and updates within 1 s of queue changes; "You are next" push arrives when position = 1.
4. Given a lab report finalised and released per policy, then a "Report ready" push arrives (no PHI in payload) and the PDF opens within 3 s; a report pending critical-value review shows "available after review".
5. Given a doctor sets note visibility to hidden for an encounter, then the app shows only the visit summary card, and the audit records the override.
6. Given a parent adds a child dependant, then a guardian declaration & consent are captured, the child appears in the profile switcher and bookings/records for the child work; revoking removes access immediately.
7. Given an adult family member added by OTP, then that member's OTP consent is required; the member can later revoke from their own account.
8. Given an outstanding OP bill, when paid in-app via UPI, then OP-005 receipt (gapless number) is generated and visible within 5 s; refunds show status.
9. Given a medication reminder set from an Rx (TID × 5 days), then reminders fire at chosen times and adherence logs sync; adherence % shows on the doctor's timeline.
10. Given SOS is triggered, then location is shared to the dispatcher console within 5 s, the ER number is dialled and the event is logged; the medical ID card is viewable offline.
11. Given a DSAR erasure request, then the privacy officer receives a task, the account is deactivated on completion, marketing data purged, and clinical records retained with an explanation shown to the patient.
12. Given the phone is offline, then previously opened reports, the appointment QR and medical ID open; booking shows an offline message without losing entered data.
13. Given ABHA login, then the ABHA address is linked to the patient and consent-based fetch of external records lists documents from other HIPs (EN-011).
14. Given the app language set to Tamil, then UI, notifications and PDF cover pages (where templated) render in Tamil.

## 15. Enhancements / Later phases

- Sheet row 19 enhancements: AI chatbot (symptom triage + doctor recommendation) — AI-001 Phase 12 (`patient_app.chatbot`); health goals & wellness tracking — PE-005 Phase 10/13 with HealthKit/Health Connect; medication reminder with adherence score — Phase 10 core above; teleconsult in-app — OP-018 Phase 8/10; emergency SOS with location sharing — Phase 10 flag with TR-009/NC-013; insurance claim status tracking — Phase 11 (`patient_app.claims` via RC-001/EN-002).
- Costed proposal line 1575 (OTP login, booking, queue tracking, records, lab reports, bill pay, family mgmt, push) — core.
- Phase 13 RN: native push, live activities/lock-screen queue, biometrics, HealthKit/Health Connect, BLE devices (BP/glucometer), offline vault, widgets, app clips/instant apps for QR check-in, white-label per hospital.
- (market) SmartHospital patient self-booking portal & mobile queue tracking, WhatsApp report delivery; MocDoc patient app — covered; digital health passport & loyalty (PE-005), community (PE-004), pharmacy home delivery ordering (OP-003), home care visit booking (NC-024).

## 16. Open Questions for the Hospital

1. Branding: single VIMS app with hospital picker or white-label per hospital/group? Store accounts?
2. Record release policy defaults (notes visibility, report delay, restricted specialties)?
3. Payment: pay-at-hospital allowed for app bookings? Cancellation/refund policy and cut-offs?
4. Family rules: dependants verification (desk vs self-declared), age of majority handling?
5. Which care tools at launch (medication reminders, diet, HEP, diaries)? Wellness/HealthKit consent needed?
6. SOS: hospital ambulance/ER availability & dispatcher; call number(s)?
7. Languages at launch; WhatsApp OTP allowed; marketing consent wording (DPO review)?
8. DSAR SLA and privacy officer contact; account deletion retention explanation text?
