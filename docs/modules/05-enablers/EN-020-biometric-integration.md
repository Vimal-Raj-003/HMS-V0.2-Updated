# EN-020 — Biometric Integration (Fingerprint / Face / Iris Devices, Staff Attendance, Patient Identity & Dedupe, Aadhaar Authentication Boundaries, Template Encryption, Device SDK Adapters, Offline Buffering)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-020 |
| Phase | 9 |
| Priority | P1 |
| Complexity | Medium–High |
| Depends on | NC-029 (Attendance & Biometric Integration — the attendance business logic; EN-020 is the device/identity layer), NC-010 (HR employee master, payroll consumption), NC-030 (duty roster — expected shifts), EN-017 (device connectors, buffering, DLQ), EN-007 (users, devices, sessions, step-up auth), EN-024 (audit), EN-028 (biometric consent artefacts), EN-027 (MPI/golden record for patient dedupe), OP-001 (patient registration & identification), EN-011 (ABHA/Aadhaar-linked flows — EN-020 never duplicates ABDM logic), EN-013 (barcode/QR as the non-biometric fallback), IP-007 (blood bank two-person verification — biometric option), OP-003 (narcotic dispensing second-person verification), EN-023 (security monitoring of biometric endpoints) |
| Feature flag | `module.biometric.enabled` (sub: `biometric.attendance`, `biometric.patient_identity`, `biometric.aadhaar_auth`, `biometric.face`, `biometric.iris`, `biometric.clinical_signoff`) |
| Primary roles | HR Executive (47 — attendance exceptions), IT Admin (56 — devices), Receptionist (24 — patient enrolment/verification), Security Officer (51 — access points) |
| Secondary roles | Employee/staff (enrol, punch), Nurse/Doctor (biometric second-person verification where enabled), Privacy Officer (57 — consent & template governance), Auditor (58), Payroll (consumes attendance) |
| Regulatory | **DPDP Act 2023 & Rules 2025** — biometric data is personal data requiring specific consent, purpose limitation, storage limitation and stronger safeguards; **Aadhaar Act 2016 & Aadhaar (Authentication) Regulations** — only AUA/Sub-AUA/KUA entities may perform Aadhaar authentication, **Aadhaar biometrics must never be stored**, only registered/STQC-certified devices with on-device encryption may be used, purpose must be disclosed, alternatives must be offered (Aadhaar cannot be made mandatory for hospital services); Supreme Court *Puttaswamy* proportionality principles; IT Act 2000 §43A + SPDI Rules 2011 (biometric = sensitive personal data); NABH HRM (attendance records) & NABH PSQ (patient identification — biometric is **never** an accepted sole identifier at the bedside; two identifiers rule still applies); ISO/IEC 19794 biometric data interchange formats; STQC/UIDAI registered-device (RD service) specification L0/L1 |

## 1. Purpose
EN-020 is the device and identity layer for biometrics: it registers fingerprint, face and iris capture devices, provides vendor SDK adapters and a uniform capture/match API, stores biometric **templates** (never raw images) encrypted and segregated, and serves two consumers — **staff attendance** (NC-029/NC-010, with offline buffering at each device) and **patient identity** (assisted duplicate detection at registration and identity confirmation at high-risk touchpoints). It also draws the legal boundary for **Aadhaar-based authentication**: performed only through a registered device and a licensed AUA/KUA route, with no biometric or Aadhaar number retained, always optional, and always with a non-biometric alternative.

## 2. Users & Jobs-to-be-done
- **Staff member** (device at the gate/department, 2 s interaction): punch in/out; know immediately whether the punch registered (green light + name/beep + display).
- **HR Executive** (desktop): enrol new joiners, re-enrol poor-quality fingers, review exception punches (missed, duplicate, out-of-geofence), approve manual regularisation, export to payroll.
- **IT Admin**: register devices, assign them to gates/departments, monitor online status and buffered-punch counts, push time sync, replace faulty readers.
- **Receptionist** (desktop + USB scanner): on repeat visits, verify the patient with a fingerprint to pull the right UHID instantly; at first registration, run a biometric dedupe check to prevent duplicate UHIDs.
- **Nurse/Pharmacist** (where enabled): provide a biometric second signature for narcotics or blood issue instead of a password.
- **Privacy Officer**: prove that consent was taken for every enrolled subject, that templates are encrypted and purgeable, and that Aadhaar biometrics are never stored.

## 3. Core Workflows

### 3.1 Device registration & fleet management
1. IT Admin adds a **device**: vendor/model (Mantra MFS100/MFS110, Morpho/Idemia MSO 1300, Startek FM220U, eSSL/Realtime/Matrix attendance terminals, Suprema, Cognitec/face terminals, Iritech iris), modality (fingerprint/face/iris/multi), connection (USB-attached to a workstation via the local agent, LAN/PoE terminal with vendor SDK or Push protocol, or cloud-connected), location (gate/department/ward/registration counter), purpose (`attendance` / `patient_identity` / `access_control` / `clinical_signoff`), STQC/RD-service certification status, firmware version, time-zone.
2. Device is paired using an EN-007 device token; the **local agent** (same family as the EN-005 print agent) exposes a localhost HTTPS API to the browser so no browser plug-in is needed; LAN terminals are polled/pushed through an EN-017 connector.
3. Health monitoring: heartbeat every 60 s (online/offline, firmware, buffered records, clock drift, last capture quality); clock drift > 60 s triggers automatic NTP sync (CERT-In requirement) and an alert.
4. Devices are scoped: an `attendance` device can never be used for `patient_identity` capture and vice versa unless explicitly dual-purposed by the Privacy Officer, because purposes (and therefore consents) differ.

### 3.2 Staff enrolment & attendance punching
1. **Enrolment** (HR desktop + device): employee (NC-010) selected → **consent screen** shown in the employee's language (purpose: attendance; retention: employment + 6 months; alternative: RFID card / mobile geo-punch) → consent captured and stored (EN-028) → capture 2 fingers × 3 samples each (or face with liveness, or iris) → quality score per sample (NFIQ 2.0 for fingerprints); reject below threshold and re-capture → templates extracted **on device/SDK**, encrypted and stored in `bio_templates` → Event `biometric.subject.enrolled`.
2. **Punch**: staff presents finger/face at the terminal → device or server matches 1:N within the enrolled set scoped to that branch → on match, the terminal shows name + IN/OUT + time and beeps; on no-match, a distinct error tone with a retry hint → `bio_punches` row → forwarded to NC-029 which applies shift/roster rules → Event `biometric.punch.recorded`.
3. **IN/OUT determination** is NC-029's business rule (first punch of the shift = IN, toggling, minimum gap between punches, multi-shift, OT); EN-020 only records the raw event with device, time, direction hint, match score and quality.
4. **Offline buffering**: LAN terminals buffer punches in device memory; the local agent also buffers to encrypted IndexedDB/SQLite; on reconnect, punches are uploaded with their **original device timestamps** and de-duplicated by `(device_id, subject_id, punch_time)`; buffered counts are visible in the fleet console and alerted if > threshold or older than 24 h.
5. **Exceptions**: finger not recognised after 3 attempts → fallback (RFID card, PIN on terminal, or supervisor-attested manual punch with reason) → flagged as `exception` for HR review; injured/worn fingers → re-enrol alternate finger; a manual punch always records who attested it.
6. **Anti-fraud**: liveness detection for face (blink/depth where the device supports it), duplicate-template detection at enrolment (one person cannot enrol twice under two employee ids), geofence for mobile punches (NC-014 staff app), photo capture on mobile punch, buddy-punching detection report (same device, impossible-travel, identical match scores).

### 3.3 Patient identity & duplicate prevention (`biometric.patient_identity`)
1. **Optional enrolment at registration** (OP-001): receptionist explains and captures **explicit, revocable consent** (DPDP) → fingerprint template stored against the patient → helps future visits and reduces duplicate UHIDs. Refusal has zero impact on service; the standard identification path (UHID + name + DOB, EN-013 wristband) remains authoritative.
2. **Verification on repeat visit** (1:1 or 1:N within the branch): patient places a finger → candidate list with match scores → receptionist confirms with a second identifier before opening the chart. **A biometric match alone never opens a chart** — NABH's two-identifier rule stands.
3. **Dedupe assist at new registration**: before issuing a new UHID, a 1:N search runs against the enrolled population; hits above the review threshold surface in the MPI **potential-duplicate queue** (EN-027 golden record / OP-001 dedupe) with demographic comparison side by side; merge is a human decision with audit.
4. **High-risk touchpoint confirmation** (optional per hospital): before a surgical procedure, blood transfusion or a high-value insurance claim, an identity re-confirmation can be required; failure escalates to a supervisor rather than blocking care.
5. **Withdrawal**: a patient may withdraw biometric consent at any time from the portal or the front desk → templates are deleted within 30 days (or immediately on request), the withdrawal is logged, and future visits fall back to standard identification.

### 3.4 Aadhaar-based authentication boundaries (`biometric.aadhaar_auth`)
- Aadhaar biometric authentication is used **only** where there is a lawful, disclosed purpose (e.g. ABHA creation/linking via EN-011, government scheme eligibility under RC-007 where the scheme mandates it) and **only** through: a UIDAI **registered device** (L0/L1 RD service) that encrypts the biometric on-device, a licensed **AUA/Sub-AUA/KUA** channel (the hospital's own licence or an authorised aggregator), and a consent screen carrying the UIDAI-prescribed disclosure.
- The HMS **never** stores: the Aadhaar number in clear (only a reference/token or masked last 4 where legally permitted), the Aadhaar biometric, the PID block, or the RD-service response payload. Only the transaction id, timestamp, auth result code and the purpose are retained.
- Aadhaar authentication is **never mandatory** for treatment, admission, billing or record access; an alternative identification route must be offered and visibly presented on the same screen.
- Aadhaar-derived biometrics are never mixed with the hospital's own biometric templates: separate purpose, separate storage, separate consent, and no cross-matching.
- All Aadhaar auth attempts are logged with purpose and outcome for the DPO's report and the annual Aadhaar audit.

### 3.5 Clinical second-person verification (`biometric.clinical_signoff`, optional)
- Where the hospital enables it, a fingerprint can satisfy the *second person* requirement for narcotic dispensing (OP-003/IP-014), blood component issue (IP-007) or high-value discount approval — replacing a shared password (which is a real-world control failure). The verification records subject, device, score, action and reference; a password/PIN path always remains as a fallback so the workflow never deadlocks on a broken reader.

### 3.6 Exceptions & offline
- **Device offline**: punches buffer locally; patient verification silently degrades to the standard path with a notice ("biometric reader unavailable").
- **Server unreachable from a LAN terminal**: terminal continues 1:N matching against its locally synced template subset (branch-scoped) and buffers.
- **Poor-quality biometrics** (manual labour, elderly, dermatological conditions): permanent exemption flag on the subject with an alternate method — the system must never trap a person with unreadable fingerprints in an endless retry loop.
- **Template corruption / vendor change**: templates are vendor-specific; a device-vendor migration requires re-enrolment — the system tracks `template_format` and warns when a device cannot match an existing format.

## 4. Data Model (schema `core`, prefix `bio_`; templates in a separate encrypted tablespace/schema `secure`)
- `bio_devices` — id, hospital_id, branch_id, code, name, vendor, model, modality enum(fingerprint/face/iris/multi), purposes text[] (attendance/patient_identity/access_control/clinical_signoff), connection enum(usb_agent/lan_sdk/lan_push/cloud), address jsonb (ip/port/serial), location_text, department_id?, rd_certified bool, rd_version, firmware, timezone, template_format enum(iso19794_2/ansi378/vendor_proprietary/face_embedding/iris_iso19794_6), match_mode enum(on_device/server), device_token_id (EN-007), status enum(active/offline/faulty/retired), last_heartbeat_at, clock_drift_sec, buffered_count, created…; UNIQUE(hospital_id, code).
- `bio_subjects` — id, hospital_id, subject_type enum(employee/patient/visitor/contractor), employee_id?, user_id?, patient_id?, consent_id (EN-028) not null, purpose enum(attendance/patient_identity/access_control/clinical_signoff), enrolment_status enum(enrolled/partial/exempt/withdrawn/deleted), exempt_reason, enrolled_by, enrolled_at, withdrawn_at, delete_after date, notes; UNIQUE(hospital_id, subject_type, employee_id/patient_id, purpose).
- `bio_templates` (schema `secure`, RLS + column encryption, **no raw images ever**) — id, subject_id, hospital_id, modality, position enum(right_index/left_index/right_thumb/…/face/iris_left/iris_right), template_format, template_enc bytea (AES-256-GCM, key in Vault/HSM, per-tenant DEK), quality_score numeric, nfiq int?, sample_count int, device_id_enrolled, algorithm_version, created_at, last_matched_at, revoked_at; index (subject_id).
- `bio_punches` — id, hospital_id, branch_id, device_id, subject_id?, employee_id?, punch_time timestamptz (device time), server_received_at, direction_hint enum(in/out/unknown), match_score numeric, quality numeric, method enum(fingerprint/face/iris/rfid/pin/manual), offline_captured bool, dedupe_key, exception_flag bool, exception_reason, attested_by?, geo jsonb?, photo_file_id?, created_at; **partitioned monthly**; UNIQUE(dedupe_key); index (hospital_id, employee_id, punch_time desc).
- `bio_match_events` — id, hospital_id, purpose, subject_type, device_id, mode enum(1:1/1:N), candidate_count, top_score, threshold, result enum(match/no_match/multi_match/error), reference_type/reference_id (patient/order/action), actor_user_id, at, latency_ms; partitioned monthly (used for patient verification, clinical sign-off, audit).
- `bio_dedupe_candidates` — id, hospital_id, new_patient_id, existing_patient_id, score, demographic_similarity jsonb, status enum(open/merged/rejected), decided_by, decided_at → feeds EN-027/OP-001 MPI merge.
- `bio_aadhaar_auth_log` — id, hospital_id, purpose enum(abha_creation/abha_link/scheme_eligibility/other), aua_channel, txn_id, device_id, rd_service_version, result_code, result enum(success/failure), error_code, patient_id?, consent_id, at; **contains no Aadhaar number, no biometric, no PID block**; retention per UIDAI/audit requirement.
- `bio_device_events` — device_id, event enum(online/offline/tamper/firmware_update/clock_sync/buffer_uploaded/error), detail jsonb, at.
- `bio_exemptions` — subject_id, reason enum(worn_fingerprints/amputation/skin_condition/religious/refusal/technical), alternate_method enum(rfid/pin/manual/card), approved_by, valid_to.
- Retention: templates deleted on withdrawal or employment end + 6 months (attendance) / consent withdrawal (patients); punches retained per payroll/statutory need (8 years for wage records), match events 3 years, device events 90 days.

## 5. Business Rules & Validations
- **Consent before capture, always.** No template is created without a stored consent artefact (EN-028) naming purpose, retention and alternatives; enrolment UI cannot proceed without it.
- **Templates only, never images.** Raw fingerprint/face/iris images are never persisted or transmitted to the server; templates are encrypted at rest with a per-tenant key in Vault/HSM and are never included in exports, backups accessible to admins in clear, logs, or API responses.
- **Purpose segregation.** A template enrolled for attendance can never be matched for patient identity or Aadhaar authentication, and vice versa; cross-purpose matching is blocked at the service layer and would be a reportable DPDP breach.
- **Aadhaar rules** (§3.4) are hard constraints: registered devices only, no storage of Aadhaar number/biometric/PID, never mandatory, always with an alternative, every attempt logged with purpose.
- **Biometrics are never a sole patient identifier** at the point of care. NABH's two-identifier rule (name + UHID/DOB, wristband scan EN-013) is unchanged; biometric verification is an *additional* assurance and a *search* aid only.
- Match thresholds are configurable per purpose with documented FAR/FRR targets (attendance FAR ≤ 0.01 %, patient verification FAR ≤ 0.001 % with a mandatory human confirmation step); scores are recorded on every match event.
- Failure must never block care or wages: 3 failed attempts always presents an alternate route; a person with an exemption is served identically.
- Duplicate enrolment detection at staff enrolment (1:N against existing staff) prevents one human enrolling as two employees; a hit blocks enrolment pending HR investigation.
- Punch de-duplication: identical `(device, subject, punch_time)` within 60 s is one punch; buffered uploads must preserve device timestamps and are rejected if the device clock drift exceeded the configured tolerance at capture time (flagged for HR review instead of silently trusted).
- Device clocks must be NTP-synced; drift > 5 min quarantines that device's punches for review.
- Withdrawal/erasure: on consent withdrawal or DSAR erasure (EN-028), templates are hard-deleted (not soft-deleted) within 30 days and the deletion is evidenced; punch history is retained as a statutory record but is no longer linkable to a biometric.
- Any bulk export of `bio_*` tables is blocked; only aggregate reports are exportable, and every template access is audited.

## 6. API Surface (`/api/v1/biometric`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET/POST/PATCH | /devices ; /devices/:id ; POST /devices/:id/sync-time \| /test \| /retire | fleet | `biometric.device.manage` | audited |
| POST | /devices/:id/heartbeat ; POST /devices/:id/upload-buffer | device callbacks | device token | dedupe on upload |
| POST | /subjects/:type/:id/consent | record biometric consent | `biometric.enrol` | EN-028 artefact |
| POST | /enrol {subjectRef, purpose, samples[]} | enrol templates | `biometric.enrol` (HR for staff, Reception for patients) | duplicate check runs first |
| POST | /enrol/quality-check | pre-enrolment sample quality | `biometric.enrol` | NFIQ score returned |
| DELETE | /subjects/:id/templates | delete templates (withdrawal/erasure) | `biometric.template.delete` (Privacy Officer, HR) | evidence recorded |
| POST | /verify {deviceId, purpose, subjectRef?} | 1:1 or 1:N match | `biometric.verify` | returns candidates + scores, never templates |
| POST | /punch | attendance punch (device/agent) | device token | forwarded to NC-029 |
| GET | /punches?employee&device&from&to&exception | punch log | `biometric.punch.read` (HR, Admin) | cursor |
| POST | /punches/manual | supervisor-attested manual punch | `biometric.punch.manual` (HR, Dept head) | reason mandatory |
| GET/POST | /dedupe/candidates ; POST /candidates/:id/decide | patient dedupe queue | `biometric.dedupe.review` (MRD, Reception lead) | links to EN-027 merge |
| POST | /aadhaar/auth | Aadhaar authentication via RD device + AUA | `biometric.aadhaar.auth` | purpose mandatory; no storage |
| GET | /aadhaar/log?from&to&purpose | Aadhaar auth audit | `biometric.aadhaar.audit` (DPO, Auditor) | no PII beyond txn |
| GET/POST | /exemptions | exemption management | `biometric.exemption.manage` (HR, Privacy Officer) | |
| GET | /fleet/health ; /reports/enrolment-coverage ; /reports/failures ; /reports/buddy-punch ; /reports/device-uptime | monitoring & reports | `biometric.report.read` | |

## 7. Domain Events (outbox)
- `biometric.subject.enrolled|re_enrolled|withdrawn|templates_deleted` → NC-010 (HR record), EN-028 consent ledger, EN-024.
- `biometric.punch.recorded|exception` → **NC-029** (attendance engine), NC-030 (roster variance), EN-037 (late/absent alerts per HR policy).
- `biometric.verify.matched|no_match|multi_match` → OP-001 (patient identification aid), IP-007/OP-003 (second-person verification), EN-024.
- `biometric.dedupe.candidate_found` → EN-027/OP-001 MPI queue.
- `biometric.device.online|offline|tamper|buffer_high|clock_drift` → EN-037 (IT alert), EN-023 (tamper = security incident).
- `biometric.aadhaar.auth_performed` → EN-011 (ABHA flows), DPO log.
- Consumes: `hr.employee.joined` (prompt enrolment), `hr.employee.exited` (schedule template deletion), `patient.consent.withdrawn` (delete templates), `admin.device.revoked`.

## 8. Screens (UI)
- **Biometric Device Fleet** (desktop, IT): table (device, location, purpose, modality, status chip, last heartbeat, buffered count, firmware, clock drift), filters, bulk time-sync, device detail drawer with last 50 events and a live "test capture" button. Offline devices pinned top.
- **Staff Enrolment** (desktop + attached reader, HR): employee search → consent panel (language selector, purpose/retention/alternatives text, checkbox + signature) → guided capture (finger diagram, live quality meter per sample, 3 samples per finger with retry) → duplicate-check result → done; re-enrol and exemption actions with reasons.
- **Attendance Terminal Display** (device screen, non-interactive): large name + IN/OUT + time on match; distinct red screen and hint on failure; offline chip and buffered count; multilingual prompts.
- **Attendance Exceptions** (desktop, HR): list of exception punches (no-match fallbacks, manual punches, clock-drift quarantined, duplicate suspects) with employee, device, evidence, and approve/regularise/reject actions feeding NC-029.
- **Patient Biometric Verification** (registration desktop): a small panel in the registration screen — "Verify with fingerprint" button → candidate cards with photo, UHID, name, age, last visit and match score → receptionist must confirm a **second identifier** before proceeding; consent status chip; "patient declined" is a single click.
- **Duplicate Review Queue** (desktop, MRD): side-by-side demographic comparison with biometric score, visit history, and Merge/Not-duplicate decisions (executed by EN-027/OP-001).
- **Aadhaar Auth Screen** (registration/ABHA flow): UIDAI-prescribed disclosure text in the patient's language, explicit consent checkbox, "use an alternative instead" button of equal prominence, RD-device status, result card with transaction id only.
- **Privacy & Templates** (desktop, DPO): enrolment coverage by purpose, consent evidence, deletion requests and their completion evidence, Aadhaar auth log, template encryption/key-rotation status.
- Empty/error states: "Reader not detected — install/start the local agent", "Fingerprint quality too low — try another finger or use the card", "This person appears to be already enrolled as EMP-1042 — contact HR", "Biometric unavailable — continue with UHID verification".

## 9. Integrations
- **Device SDKs/adapters**: Mantra, Morpho/Idemia, Startek, Secugen, Suprema, eSSL, Realtime, Matrix, Cognitec/face terminals, Iritech iris — each wrapped as an EN-017 connector package implementing `capture/extract/match/health`; LAN terminals via vendor SDK, HTTP push, or SQL/CSV pull for legacy controllers.
- **Local agent**: signed desktop service exposing `https://127.0.0.1:<port>` with a browser-trusted certificate, handling USB devices, template extraction, and offline buffering (shares the deployment channel with the EN-005 print agent).
- **UIDAI RD service** (registered device) for any Aadhaar flow, through an AUA/KUA aggregator; **EN-011** owns the ABHA business flows.
- **NC-029/NC-010** for attendance/payroll; **NC-030** roster; **EN-027/OP-001** for MPI dedupe/merge; **EN-021** CCTV for face-terminal corroboration at gates; access-control panels (EN-015) for door release.
- Optional: mobile geo-punch through the staff app (NC-014) with face liveness as the biometric factor.

## 10. Reports & Analytics
- Enrolment coverage (% staff enrolled, per department; % patients opted in), match performance (FAR/FRR proxies: no-match rate, multi-match rate, average score by device), device uptime and buffered-punch ageing, exception punches by reason and department, buddy-punching suspicion report (impossible travel between devices, repeated identical scores, punches during approved leave), duplicate UHIDs prevented (count and estimated cost avoided), Aadhaar authentication volume by purpose with success rate, consent withdrawals and deletion SLA compliance. MV `analytics.mv_biometric_daily`.

## 11. Notifications
- IT: device offline > 15 min, buffered punches > 500 or older than 24 h, clock drift, tamper detected, firmware out of date.
- HR: new joiner not enrolled after 3 days, exception punches awaiting regularisation, employee with repeated match failures (suggest re-enrolment).
- Reception/MRD: potential duplicate patient detected at registration.
- Privacy Officer: consent withdrawal received (deletion due date), Aadhaar auth failure spike, any attempt at cross-purpose matching (blocked).

## 12. Permissions (RBAC keys)
`biometric.device.manage` (IT Admin) · `biometric.enrol` (HR Executive for staff; Receptionist for patients) · `biometric.template.delete` (Privacy Officer, HR Manager — audited) · `biometric.verify` (Reception, Nurse, Pharmacist, Blood bank — purpose-scoped) · `biometric.punch.read` (HR, Dept head for own dept via ABAC) · `biometric.punch.manual` (HR, Department head — reason required) · `biometric.dedupe.review` (MRD Officer, Reception lead) · `biometric.aadhaar.auth` (Reception, ABHA operator — purpose-bound) · `biometric.aadhaar.audit` (DPO, Auditor) · `biometric.exemption.manage` (HR, Privacy Officer) · `biometric.report.read` (HR, IT, Admin, Auditor). Template bytes are readable by **no role** — only the matching service can decrypt them.

## 13. Non-functional
- Scale: 6000 staff × 2–4 punches/day ≈ 20k punches/day across ~60 terminals; patient verification ~1500/day at peak registration; enrolled patient population up to 500k templates.
- Latency: on-device 1:N match < 1 s; server-side 1:N over 500k templates < 2 s p95 (indexed by branch + binning/clustering; a dedicated matcher process with an in-memory index, horizontally shardable); 1:1 verify < 300 ms; punch ingest p95 < 100 ms.
- Offline: terminals buffer ≥ 10 000 punches; local agent buffers ≥ 2000; no punch loss across a 24-hour outage; ordered, de-duplicated upload on restore.
- Security: templates encrypted with AES-256-GCM using a per-tenant DEK wrapped by a Vault/HSM KEK, key rotation supported with re-wrap (never re-enrolment); template tables excluded from ordinary backups' plaintext path (encrypted backup only, EN-022); no template ever crosses the API boundary; matcher service isolated on its own network segment with mTLS; rate limits on verify endpoints to prevent template-probing attacks.
- Accessibility: enrolment and terminal prompts in `en, hi, ta, te, ml, kn, mr, bn` with audio cues; readers mounted at wheelchair-accessible height; an exemption path always available so nobody is excluded.
- On-prem: fully functional without internet (except Aadhaar flows, which explicitly require connectivity and degrade to the alternative).

## 14. Acceptance Criteria
1. Given a new employee is enrolled, when the HR user attempts capture without recording consent, then enrolment is blocked and no template is created.
2. Given a fingerprint is captured, when the sample quality is below the configured NFIQ threshold, then the sample is rejected with guidance and no low-quality template is stored.
3. Given a staff member is already enrolled under another employee id, when a second enrolment is attempted, then the duplicate check blocks it and raises an HR investigation item.
4. Given a terminal is offline for 6 hours with 300 punches buffered, when connectivity returns, then all 300 punches upload with their original device timestamps, none are duplicated, and NC-029 processes them against the correct shifts.
5. Given a device's clock has drifted by 12 minutes, when its punches are uploaded, then they are quarantined as exceptions for HR review and an alert is raised, rather than being silently accepted.
6. Given a staff member's fingerprint fails 3 times, when the third attempt fails, then the terminal offers the configured alternative (card/PIN/supervisor punch) and the resulting punch is flagged as an exception with the reason.
7. Given a patient declines biometric enrolment, when registration continues, then no template is created, no repeated prompt appears on future visits, and the patient receives identical service.
8. Given a patient is verified biometrically at reception, when the receptionist attempts to open the chart on the match alone, then the system requires confirmation of a second identifier before proceeding.
9. Given a new registration matches an existing patient above the dedupe threshold, when the UHID is about to be issued, then the potential duplicate appears with a side-by-side comparison and requires a human decision; no automatic merge occurs.
10. Given an Aadhaar authentication is performed, when the transaction completes, then only the transaction id, purpose, timestamp and result code are stored — no Aadhaar number, no biometric, no PID block appears in the database, logs or backups.
11. Given an Aadhaar authentication screen is displayed, when the patient looks for an alternative, then a non-Aadhaar option is presented with equal prominence and service is not conditioned on Aadhaar.
12. Given an attendance template exists, when any service attempts to use it for patient identity matching, then the request is rejected at the service layer and a privacy alert is raised.
13. Given an employee leaves, when the retention period elapses (employment end + 6 months), then their templates are hard-deleted automatically, the deletion is evidenced, and their punch history remains for statutory wage records.
14. Given a patient withdraws biometric consent, when the withdrawal is recorded, then templates are deleted within the SLA, the deletion evidence is visible to the Privacy Officer, and subsequent visits use standard identification.
15. Given a template-probing attack (many rapid verify calls from one client), when the rate limit is exceeded, then the endpoint throttles and a security event is sent to EN-023.
16. Given the biometric reader is unavailable at a bedside second-person verification, when a nurse needs to proceed, then the password/PIN fallback is offered so the clinical workflow is never blocked.

## 15. Enhancements / Later phases
- Palm-vein and contactless palm biometrics (hygienic, better for healthcare environments than contact fingerprint readers).
- Face recognition at gates for frequent visitors and blacklist matching (EN-015), with strict opt-in, signage and a DPIA.
- Mobile-based biometrics (device-native Face ID / fingerprint) as a WebAuthn passkey factor for staff login (EN-007/EN-025) — arguably the better long-term direction because no biometric ever leaves the phone.
- Newborn footprint/parent-baby matching in the labour room (IP-011) for mother–infant identity assurance.
- Biometric-linked medication administration (nurse identity on the MAR without password re-entry, IP-003).
- Liveness/presentation-attack detection certification (ISO/IEC 30107) for face terminals; multi-modal fusion scoring.
- Federated identity across group branches so an employee enrols once and works anywhere (EN-041), with template sync policies.
- Automated FAR/FRR measurement harness with periodic recalibration of thresholds per device model.
- Aadhaar-based eKYC for ABHA at the kiosk (EN-034) with the same non-mandatory guarantees.

## 16. Open Questions for the Hospital
1. Which biometric hardware already exists (make/model/count/locations), and is it STQC/RD-certified where Aadhaar flows are intended?
2. Is biometric attendance mandatory for all staff, or optional with card/PIN alternatives? What does the HR policy and union/contract position say?
3. Modality preference: fingerprint (cheapest, hygiene concerns), face (contactless, higher cost), iris, or palm-vein?
4. Do you intend to enrol **patients** biometrically at all? If yes, for which purposes, and has the DPO approved a data-protection impact assessment?
5. Does the hospital hold an AUA/Sub-AUA/KUA licence, or will Aadhaar flows go through an aggregator? For which purposes exactly?
6. Retention: how long after an employee leaves must templates be kept (default employment + 6 months)? Any statutory requirement to keep punch data longer than 8 years?
7. Which fallback methods are acceptable when biometrics fail — RFID card, PIN, supervisor attestation, or all three?
8. Should biometric verification replace passwords for narcotic/blood second-person checks, and does the pharmacy/blood bank agree?
9. Number of gates/departments needing terminals, network availability at each, and whether devices can reach the server directly or need the local agent.
10. Who owns exception regularisation (HR vs department heads) and what is the approval SLA before payroll cut-off?
11. Is face recognition at gates acceptable to management given the privacy scrutiny, and is signage/consent infrastructure in place?
