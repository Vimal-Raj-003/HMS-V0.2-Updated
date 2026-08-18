# EN-015 — Gate Pass, Visitor & Bystander Pass Management (Visitor Entry with Photo/OTP, Gate Register, Vehicle Log, Material Gate Pass Returnable/Non-Returnable, Bystander QR Pass, Visiting-Hours & Ward Limits, Emergency Override, Security Dashboard)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-015 |
| Phase | 9 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | EN-013 (QR encoding/scan resolver for passes), EN-005 (pass/label printing at gate), EN-009 (SMS/WhatsApp pass link & OTP), EN-007 (settings, device tokens for gate kiosks/scanners, roles), EN-024 (audit), IP-001 (admission, ward/bed, patient status), IP-002 (discharge → auto-deactivate), IP-012 (isolation/infection-control screening), NC-019 (Security Management — incidents; EN-015 supplies visitor/vehicle data), EN-021 (CCTV event tagging at gates), NC-006/NC-005 (material gate pass ↔ stock issue/return, PO/vendor), NC-002 (asset movement out of premises), NC-016 (BMW waste vehicle exit), NC-013 (ambulance gate exemption), EN-038 (approval matrix for non-returnable passes and pass extension), EN-028 (visitor data consent notice), EN-020 (face recognition for frequent visitors — later) |
| Feature flag | `module.gatepass.enabled` (sub: `gatepass.vehicle`, `gatepass.material`, `gatepass.bystander_qr`, `gatepass.face_recognition`, `gatepass.contractor`) |
| Primary roles | Security Officer / Guard (51 — gate console), Nurse — Ward (17 — issue/extend bystander pass), Front Office (24 — visitor desk), Stores Keeper (44 — material pass), Branch Admin (3 — configure) |
| Secondary roles | Hospital Admin (policy, non-returnable approval), Doctor/Nurse in-charge (emergency override), Infection Control Nurse (21 — screening rules, outbreak lockdown), Biomedical (48 — equipment out), Purchase (45 — returnable tracking), Auditor (58), Family/Attendant (60 — digital pass on phone) |
| Regulatory | NABH FMS (visitor control, safety of patients & staff), NABH PRE (patient rights — attendant access, privacy), DPDP Act 2023 & Rules 2025 (visitor photo/ID = personal data: notice at capture, purpose limitation, retention limit, no Aadhaar number storage — only masked last 4 or token), Aadhaar Act §7/offline KYC limits (never store full Aadhaar or biometric of visitors), IT Act (CCTV/photo evidence), state Clinical Establishment rules (visitor register maintenance), BMW Rules 2016 (waste vehicle exit manifest), Factory/Fire safety (contractor induction, hot-work permits), Companies Act (asset movement documentation for audit) |

## 1. Purpose
EN-015 controls who and what crosses the hospital boundary: visitor registration with photo and optional OTP verification, a digital gate register with entry/exit timestamps, vehicle in/out and parking logs, material gate passes (returnable and non-returnable) with approval and return follow-up, and IP **bystander passes** with QR validation, ward-wise visiting hours, per-patient visitor limits, extension/revocation and auto-deactivation on discharge. It gives the security team one real-time dashboard of who is inside, which vehicles are parked, which materials are pending return, and which visiting-hour violations occurred.

## 2. Users & Jobs-to-be-done
- **Security Guard — main gate** (tablet/kiosk + webcam + QR scanner, standing, high-throughput): register a visitor in < 30 s, print/send pass, scan pass on exit, log vehicles, check material gate passes against approval. Continuous, 3 shifts.
- **Security Guard — ward entry point** (phone/tablet): scan bystander QR → allow/deny with reason; enforce count and hours.
- **Ward Nurse / Nurse in-charge** (desktop/tablet at nursing station): issue bystander passes at admission, replace lost pass, request extension, revoke on misbehaviour, apply emergency override for critical patients.
- **Front Office**: issue visitor passes for OPD/administrative visitors, contractors, vendors, media; verify appointments.
- **Stores/Biomedical/Purchase**: raise material gate pass for equipment going out for repair/demo/calibration; close it on return.
- **Hospital/Branch Admin**: configure visiting hours per ward, visitor limits, pass templates, approval matrix, blacklists.
- **Family / Attendant (patient app)**: receive digital pass with QR on phone, see visiting hours, request extension.
- **Security Supervisor**: live dashboard, incident linkage (NC-019), overdue-return chase list, shift handover report.

## 3. Core Workflows

### 3.1 Visitor entry (general / OPD attendant / vendor / contractor / media)
1. **Visitor arrives** → Guard opens Gate Console → selects purpose (patient visit / OPD attendant / vendor / contractor / interview / official / media / delivery-courier) → captures **name, mobile, ID type (Voter/DL/Passport/Employee card/Aadhaar-masked), ID last-4 only, address (optional), photo (webcam capture)**, whom-to-meet (patient search by UHID/name/bed **or** staff/department) → System validates → Event `gatepass.visitor.checked_in`.
2. **OTP verification** (optional per hospital policy, mandatory for patient visits after hours): system sends 6-digit OTP to the visitor's mobile (EN-009 template `gate_pass_otp`) → guard enters code → `mobile_verified=true`. Failure allowed twice then guard may override with reason (audited).
3. **Policy checks** run in order and are shown as a single verdict card: (a) **visiting hours** for the target ward/department, (b) **patient-wise visitor limit** currently inside, (c) patient status (isolation IP-012 / no-visitors flag / MLC restriction TR-008 / deceased), (d) **blacklist** (name+mobile / ID hash), (e) infection-control screening questionnaire (fever, cough, recent contact — configurable, shown in visitor's language), (f) outbreak lockdown level. Verdict = `allow` / `allow_with_warning` / `deny`; deny reason displayed in the visitor's language and printed as a slip if requested.
4. **Pass issue** → number from `VISITOR_PASS` series → pass rendered with QR (EN-013 payload `VP|<hospital>|<pass_id>|<hmac>`), photo, name, valid-from/until, ward/area allowed, colour band by zone → printed (EN-005 thermal/badge printer) **and/or** sent to phone as WhatsApp/SMS link (digital pass, market gap closed) → Event `gatepass.pass.issued`.
5. **Inside movement**: ward-entry guard scans QR → system validates active + correct ward + within hours + count not exceeded → `allow`/`deny` logged with scan point → Event `gatepass.pass.scanned`.
6. **Exit**: guard scans QR (or searches by mobile/pass no) → `checked_out_at` stamped, duration computed, pass badge collected → Event `gatepass.visitor.checked_out`. Unreturned physical badge flagged.
7. **Auto-close**: passes not checked out by end of day are auto-closed at the configured cutoff with `exit_source=auto` and appear in the anomaly report.

### 3.2 Bystander (attendant) pass for inpatients
1. **On admission** (`ip.admission.completed` from IP-001) the ward allowance is computed: ward class → `allowed_bystanders` (ICU 1, General 2, Deluxe 2, Paediatrics 2 incl. mother, Labour room 1, Isolation 0 by default — configurable) → nursing station prompt "Issue bystander pass(es)".
2. **Nurse issues pass**: selects relation (spouse/parent/child/sibling/friend/attendant-hired), captures name, mobile, photo, ID last-4 → pass valid for the admission period, restricted to the patient's **ward/bed**, with visiting-hour window and overnight-stay flag → QR pass printed on wristband-style badge or badge card (EN-013/EN-005) + digital copy to phone → Event `gatepass.bystander.issued`.
3. **Ward entry validation**: QR scan at ward door → checks active status, ward match, visiting hours, patient still admitted, pass not revoked → `allow` or `deny(reason)`. Deny reasons: `outside_hours`, `limit_exceeded`, `revoked`, `patient_discharged`, `ward_mismatch`, `expired`.
4. **Extension**: attendant or nurse raises extension request (e.g. beyond visiting hours for a critical patient, or additional bystander for a dependent patient) → approver per EN-038 matrix (Nurse in-charge for ≤ 4 h; Duty Medical Officer for overnight; Admin for extra bystander beyond limit) → approved extension writes a new validity window with reason → Event `gatepass.pass.extended`.
5. **Revoke**: nurse/security revokes with category (disciplinary / clinical — patient needs rest / infection control / lost badge / misuse) → pass `revoked`, QR immediately rejected, replacement issue allowed with `replaces_pass_id` → Event `gatepass.pass.revoked`.
6. **Emergency override**: Doctor or Nurse in-charge can override visiting restrictions for a critical/terminal patient (extra visitors, off-hours entry, ICU relaxation) → mandatory reason + duration (default 2 h) → override recorded against patient and pass, surfaced on security dashboard as an active exception → Event `gatepass.override.applied`.
7. **Auto-deactivate on discharge**: `ip.discharge.completed` / `ip.patient.transferred` / `patient.death.recorded` → all passes for that admission are deactivated (transfer re-points them to the new ward instead) → attendant gets a WhatsApp note ("pass closed, please return badge") → Event `gatepass.pass.auto_deactivated`.

### 3.3 Vehicle in/out log
1. Guard logs **vehicle entry**: number plate (ANPR camera optional — EN-021 feed; else typed with format validation), type (2-wheeler/car/ambulance/goods/staff/VIP/emergency), driver name & mobile, purpose, occupant count, **parking bay assignment** from configured zones (patient/staff/visitor/ambulance/emergency-lane) → parking slip with QR → Event `gatepass.vehicle.entered`.
2. Exit scan/search → exit time, duration, parking charges (if paid parking configured → posts a charge to the visitor bill or cash counter NC-001) → Event `gatepass.vehicle.exited`.
3. Ambulances (NC-013) and emergency vehicles are logged but never blocked; barrier auto-open signal (dry-contact via gate controller) if integrated.
4. Occupancy per zone shown live; zone full → guard warned and redirected.

### 3.4 Material gate pass
1. **Returnable** (equipment to vendor for repair, cylinder to refiller, demo device, event equipment, biomedical calibration NC-020): requester (Stores/Biomedical/Dept) raises pass listing items (link to `inventory.items`/`assets` with asset tag, serial, quantity, UoM, estimated value), destination (vendor NC-021), reason, **expected return date**, transporter (name, vehicle, mobile) → approval per EN-038 (Store In-charge → HOD → Admin above value threshold) → gate copy generated with QR → guard scans at exit, verifies item count, records photo evidence → Event `gatepass.material.issued`.
2. **Return**: guard/stores scans pass QR on re-entry → marks items returned (full/partial, with condition notes) → stock/asset status restored (NC-006/NC-002) → pass closed → Event `gatepass.material.returned`. Partial return keeps the pass open with the balance.
3. **Overdue follow-up**: daily job flags passes past expected return → escalation ladder (requester D+1, HOD D+3, Admin D+7) via EN-037 → overdue register with ageing; write-off requires Admin approval and posts a loss entry to NC-009.
4. **Non-returnable** (scrap, condemned assets, BMW waste consignment, samples to referral lab, food waste, donated items): requires **Admin approval** (and Condemnation Board reference for assets, SPCB manifest for BMW), documents attached, then gate release; asset disposal event to NC-002; waste manifest number to NC-016 → Event `gatepass.material.released`.
5. Exceptions: item mismatch at gate → guard raises **discrepancy** → pass held, security incident created (NC-019), requester and HOD notified.

### 3.5 Contractor & delivery management
- **Contractor pass**: firm (NC-021 vendor), work order/contract ref, workers list, **safety induction** completion (NC-027 training record, validity 6/12 months), PPE check, work area, hot-work/height-work permit reference, validity dates → daily check-in/out per worker; induction expired → entry denied.
- **Delivery/courier**: courier company, AWB, addressee department, package description, photo → routed to receiving desk; food deliveries restricted to designated zones; no delivery direct to ICU/OT.

### 3.6 Security dashboard & shift handover
- Live tiles: **visitors inside** (by zone/ward), **vehicles in parking** (by zone with capacity bar), **active bystander passes**, **pending material returns** (with overdue count), **today's denials & violations**, **active emergency overrides**, **open incidents** (NC-019), CCTV quick-links per gate (EN-021).
- **Shift handover** report generated at shift end: counts, open items, incidents, overdue returns; signed off by outgoing/incoming supervisor.

### 3.7 Exceptions & offline
- **Network/kiosk offline**: gate console (PWA) issues passes from a reserved offline number block, stores photos locally in IndexedDB (capped, encrypted), validates QR **offline** using the HMAC signature + last-synced pass status snapshot (≤ 15 min old), and syncs on reconnect; conflicts (pass revoked while offline) are reported as post-hoc violations.
- **Lost pass**: re-issue with `replaces_pass_id`; original invalidated instantly.
- **VIP/dignitary movement**: pre-registered visitor list uploaded (CSV) with time window; fast-track check-in by name search.
- **Outbreak/lockdown mode**: one switch sets hospital-wide "no visitors except attendants", auto-denies new visitor passes, broadcasts banner to TV boards (EN-018) and to the patient app.

## 4. Data Model (schema `engage`, prefix `gate_`; security-operational, not clinical)
- `gate_policies` — id, hospital_id, branch_id, scope (hospital/ward/department/zone), ward_id?, visiting_windows jsonb `[{days:[mon..sun], from:'11:00', to:'12:00'},{from:'17:00',to:'19:00'}]`, allowed_bystanders int, allowed_visitors_per_patient int, max_concurrent_visitors int, overnight_allowed bool, min_visitor_age int?, otp_required bool, id_required bool, photo_required bool, screening_form_id?, lockdown_level enum(none/restricted/no_visitors), effective_from, effective_to, version, active.
- `gate_visitors` — id, hospital_id, full_name, mobile citext, mobile_verified bool, id_type enum(voter/dl/passport/employee/aadhaar_masked/other), id_last4, address jsonb?, photo_file_id, face_template_id? (EN-020, opt-in), is_frequent bool, visit_count, blacklisted bool, blacklist_reason, created_at; UNIQUE(hospital_id, mobile, id_last4) soft; trigram index on full_name; DPDP retention job.
- `gate_passes` — id, hospital_id, branch_id, pass_no (series `VISITOR_PASS`/`BYSTANDER_PASS`/`CONTRACTOR_PASS`), type enum(visitor/bystander/contractor/vendor/media/staff_temp/delivery), visitor_id, patient_id?, admission_id?, ward_id?, bed_id?, relation, purpose, zones_allowed text[], valid_from timestamptz, valid_to timestamptz, visiting_windows jsonb (snapshot), status enum(active/expired/revoked/closed/replaced), overnight bool, issued_by, issue_channel enum(gate/ward/frontoffice/app), qr_payload_hash, badge_printed bool, badge_returned bool, digital_sent_at, replaces_pass_id?, revoke_reason, revoked_by, revoked_at, override_id?, created_at; index (hospital_id, status, valid_to), (patient_id, status), (visitor_id).
- `gate_pass_events` — id, pass_id, hospital_id, event enum(issued/scan_allow/scan_deny/checked_in/checked_out/extended/revoked/replaced/auto_deactivated), scan_point_id, verdict_reason, actor_id/device_id, at, geo?, photo_file_id?; partitioned monthly (high volume).
- `gate_register` — id, hospital_id, branch_id, pass_id?, visitor_id, entry_at, entry_gate_id, exit_at, exit_gate_id, exit_source enum(scan/manual/auto), duration_min generated, purpose, met_patient_id?, met_staff_id?, notes; partitioned monthly; index (hospital_id, entry_at desc).
- `gate_scan_points` — id, hospital_id, branch_id, code, name, kind enum(main_gate/ward_door/opd_entry/ot_lobby/icu_lobby/parking/service_gate), ward_id?, device_id (EN-007 device token), active.
- `gate_vehicles` — id, hospital_id, branch_id, plate_no citext, vehicle_type, driver_name, driver_mobile, purpose, occupants int, zone_id, bay_code, entry_at, exit_at, duration_min, charge_amount numeric(14,2)?, receipt_id?, anpr_confidence numeric?, entry_photo_file_id, logged_by, created_at; index (hospital_id, entry_at desc), (plate_no).
- `gate_parking_zones` — id, hospital_id, branch_id, code, name, category enum(patient/visitor/staff/ambulance/emergency/vendor), capacity int, occupied int (materialised), active.
- `gate_material_passes` — id, hospital_id, branch_id, pass_no (series `MGP`), kind enum(returnable/non_returnable), requester_id, department_id, vendor_id?, destination, reason, expected_return_date date?, transporter jsonb (name, mobile, vehicle_no), total_value numeric(14,2), approval_id (EN-038), status enum(draft/pending_approval/approved/rejected/issued/partially_returned/returned/overdue/closed/written_off), issued_at, issued_by, gate_out_by, returned_at, closed_at, discrepancy_note, docs jsonb (file ids); index (hospital_id, status, expected_return_date).
- `gate_material_items` — id, material_pass_id, item_id? (inventory), asset_id? (NC-002), description, serial_no, batch_no, qty numeric, uom, unit_value, qty_returned numeric, condition_on_return, returned_at.
- `gate_overrides` — id, hospital_id, patient_id?, ward_id?, pass_id?, type enum(visiting_hours/visitor_limit/icu_relaxation/lockdown_exception), reason text not null, granted_by (doctor/nurse in-charge), valid_from, valid_to, created_at.
- `gate_blacklist` — id, hospital_id, name, mobile, id_last4, photo_file_id?, reason, incident_ref (NC-019), added_by, active_from, active_to.
- `gate_screening_responses` — id, hospital_id, pass_id, form_id (EN-039), answers jsonb, risk enum(low/medium/high), temperature numeric?, action_taken, at.
- `gate_contractor_workers` — id, hospital_id, vendor_id, worker_name, id_last4, induction_completed_at, induction_valid_to, ppe_ok bool, permits jsonb, photo_file_id, active.
- Retention: `gate_register`, `gate_pass_events`, `gate_vehicles` 1 year online then archive; visitor photos purged after **90 days** (configurable, DPDP minimisation) unless linked to an incident; material passes retained 8 years (audit).

## 5. Business Rules & Validations
- A pass is valid only if `status='active'` AND `now() between valid_from and valid_to` AND current time falls in a visiting window (unless an active `gate_override` covers it) AND the target ward matches AND the patient is still admitted.
- **Visitor limit** is evaluated on *currently inside* count (`gate_register` rows with `exit_at is null` for that patient), not on passes issued.
- ICU/Isolation/NICU default `allowed_visitors_per_patient = 1` and `allowed_bystanders = 1`; isolation wards default 0 with mandatory PPE note; overrides always require reason and are time-boxed (max 24 h, renewable).
- Photo capture is mandatory for patient-visit and contractor passes; DPDP **notice text is displayed at capture** (multilingual) and the acknowledgement is stored on the pass; Aadhaar **number is never stored** — only type + last 4 digits, never the biometric.
- OTP: 6 digits, 5-minute expiry, max 3 sends per number per hour; override of OTP failure requires guard supervisor reason.
- Non-returnable material passes **cannot** be issued without a completed approval chain; asset-bearing passes require the asset's condemnation/AMC reference; BMW consignments require the manifest number.
- Returnable pass overdue = `expected_return_date < today AND status in (issued, partially_returned)`; write-off requires Hospital Admin + reason + NC-009 loss posting.
- Pass numbers come from EN-007 numbering series, non-gapless, reset daily for visitor passes and per-FY for material passes.
- QR payload contains no PHI: only pass id + HMAC (key rotated quarterly); patient name never printed on a visitor badge — only bed/ward and first name initial (DPDP), configurable.
- Blacklisted visitor attempts are always denied at the gate and generate a security alert; override impossible at guard level (Security Officer + Admin only).
- A bystander pass follows the patient on **intra-hospital transfer** (ward_id updated) and terminates on discharge/death/DAMA.
- Vehicle plate stored uppercase without spaces; duplicate active entry for the same plate blocked (must exit first) unless `force` with reason.
- Screening `risk=high` blocks entry and routes the visitor to the screening desk; recorded for infection-control review (IP-012).

## 6. API Surface (`/api/v1/gate`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET/POST/PATCH | /policies ; /policies/:id | visiting hours, limits, lockdown | `gate.policy.configure` | versioned |
| POST | /visitors ; GET /visitors?q=mobile\|name | visitor lookup/create | `gate.visitor.manage` | trigram search, dedupe by mobile |
| POST | /visitors/:id/otp/request \| /otp/verify | mobile verification | `gate.visitor.manage` | rate-limited |
| POST | /passes | issue visitor/bystander/contractor pass | `gate.pass.issue` | Idempotency-Key; returns QR + print job |
| GET | /passes?type&status&ward&patient&q | list | `gate.pass.read` | cursor |
| POST | /passes/validate | scan validation `{qr, scanPointId}` | `gate.pass.scan` (device token) | < 100 ms; returns verdict + reason + photo |
| POST | /passes/:id/extend \| /revoke \| /replace \| /checkout | lifecycle | `gate.pass.manage` / `gate.pass.revoke` | reason mandatory |
| POST | /overrides | emergency visiting override | `gate.override.apply` (Doctor, Nurse in-charge) | time-boxed, audited |
| POST | /register/checkin ; POST /register/checkout | manual register entry/exit | `gate.register.manage` | offline-syncable |
| GET | /register?from&to&patient&visitor&gate | gate register search | `gate.register.read` | export audited |
| POST/GET/PATCH | /vehicles ; /vehicles/:id/exit ; GET /vehicles/live | vehicle log | `gate.vehicle.manage` / `.read` | ANPR webhook |
| GET/POST | /parking/zones ; GET /parking/occupancy | parking | `gate.parking.manage` / `.read` | |
| POST/GET/PATCH | /material-passes ; /:id/submit \| /approve \| /reject \| /issue \| /return \| /close \| /write-off | material gate pass | `gate.material.create/approve/issue/return/writeoff` | EN-038 approvals |
| GET | /material-passes/overdue | overdue returns | `gate.material.read` | |
| GET/POST/DELETE | /blacklist | blacklist | `gate.blacklist.manage` (Security Officer, Admin) | audited |
| GET/POST | /contractors/workers ; POST /workers/:id/induction | contractor induction | `gate.contractor.manage` | |
| POST | /screening | screening questionnaire response | `gate.pass.issue` | |
| GET | /dashboard/live | security dashboard payload | `gate.dashboard.read` | WS `gate:<branch>` |
| GET | /reports/visitor-traffic ; /reports/violations ; /reports/vehicle ; /reports/material-ageing ; /reports/shift-handover | reports | `gate.report.read` | CSV/PDF |
| POST | /lockdown | set lockdown level | `gate.policy.configure` (Admin) | broadcasts to EN-018 |

## 7. Domain Events (outbox)
- `gatepass.visitor.checked_in|checked_out` → EN-021 (CCTV bookmark at gate), NC-019, EN-001 footfall analytics.
- `gatepass.pass.issued|scanned|denied|extended|revoked|replaced|auto_deactivated` → EN-037 (attendant notification), EN-024 audit, ward dashboards (IP-003).
- `gatepass.override.applied|expired` → IP-003 nursing station banner, EN-024, security dashboard.
- `gatepass.vehicle.entered|exited` → NC-013 (ambulance turnaround), parking occupancy read-model, EN-021.
- `gatepass.material.requested|approved|issued|returned|overdue|written_off` → NC-006/NC-002 (stock/asset status), NC-005 (vendor repair tracking), NC-009 (write-off posting), EN-037 escalation.
- `gatepass.violation.recorded` (outside-hours entry, limit exceeded, badge not returned, item mismatch) → NC-019 incident, NC-015 quality indicator.
- `gatepass.lockdown.changed` → EN-018 TV banner, PE-001 patient app, EN-009 broadcast.
- Consumes: `ip.admission.completed`, `ip.patient.transferred`, `ip.discharge.completed`, `patient.death.recorded`, `ip.isolation.started|ended`, `vendor.po.created` (returnable context).

## 8. Screens (UI)
- **Gate Console** (tablet/kiosk, landscape, gloved-hand friendly large targets; webcam + USB QR scanner): left = capture form (mobile-first field with auto-lookup of frequent visitors), centre = live camera preview with capture button, right = verdict card (allow/deny + reasons) and pass preview. Shortcuts: `F2` new visitor, `F3` scan, `F4` vehicle, `F5` material, `Enter` issue & print, `Esc` clear. Real-time: policy/lockdown changes push instantly. Offline: banner + reserved number block + local queue counter.
- **Ward Entry Scanner** (phone PWA/handheld): full-screen camera scan → giant green ALLOW / red DENY card with visitor photo, patient name (masked per policy), bed, and reason text; audio beep distinct for allow/deny; works offline against cached signed pass list.
- **Bystander Pass Desk** (nursing station, desktop/tablet): patient list of admitted beds with pass count chips (1/2 issued), issue drawer (relation, photo, mobile), extend/revoke actions with reason picker, print + "send to phone" buttons.
- **Visitor & Gate Register** (desktop): searchable table (date range, gate, patient, visitor, status), row expands to event timeline with photos; export (audited).
- **Vehicle & Parking Board** (desktop/TV): zone occupancy bars, live in/out list, overstay highlights, ANPR match confidence.
- **Material Gate Pass** (desktop): request wizard (items via barcode/asset-tag scan EN-013 → destination → transporter → attachments), approval inbox, gate-issue screen with item checklist, return screen with condition capture, overdue ageing board (0-7/8-15/16-30/30+ days).
- **Security Dashboard** (desktop + wall TV via EN-018): tiles + map of gates, active overrides list, denial feed, incident quick-create, CCTV thumbnails.
- **Contractor Induction** (tablet): worker list, induction status chips, permit attachments, expiry warnings.
- **Family Digital Pass** (patient/family phone, PE-001/OP-020): QR pass card (brightness boost on open), visiting-hours schedule, "request extension" button, multilingual instructions and hospital rules, wheelchair/special-needs request flag.
- Empty/error states: "No active passes for this ward", "Camera unavailable — capture ID manually (reason required)", "Offline: 12 passes pending sync".

## 9. Integrations
- **EN-013** QR generation/scan resolver; **EN-005** badge/slip printers at each gate (auto-print queue with printer health); **EN-009** OTP + digital pass links; **EN-021** CCTV bookmark on every gate event and ANPR plate feed; barrier/boom controllers and turnstiles via dry-contact relay or vendor HTTP API (adapter in EN-017); flap-barrier + RFID staff card readers (staff entry reuses NC-029 attendance punches); **EN-020** face recognition for frequent visitors (opt-in, later); Google/Apple Wallet pass generation (later); **EN-017** connector for third-party access-control systems (Honeywell/Matrix/eSSL) that own physical doors.

## 10. Reports & Analytics
- Ward-wise visitor traffic by hour/day (peak-hour heatmap), average visit duration, visitor-to-patient ratio, visiting-hour **compliance rate %** and violations log, denial reasons breakdown, emergency override log by doctor/ward, badge non-return rate, vehicle throughput and parking utilisation/overstay, material pass ageing & value at risk outside premises, contractor man-days on site, blacklist hits. Read-models: `analytics.mv_gate_daily` (per branch/ward/day counts), `analytics.mv_parking_hourly`.
- NABH evidence pack: visitor control policy, register extract, violation CAPA linkage (NC-015).

## 11. Notifications
- **Visitor/attendant**: OTP, digital pass link, "visiting hours end in 15 min", pass revoked, "please return badge at exit", lockdown notice.
- **Nurse/ward**: extra visitor at bedside beyond limit, override expiring, pass auto-deactivated on discharge.
- **Security**: blacklist hit, denied entry attempt at ICU, parking zone full, badge not returned, item mismatch.
- **Requester/HOD/Admin**: material return due tomorrow, overdue D+3/D+7 escalation, non-returnable pass awaiting approval.
- **TV (EN-018)**: visiting-hours banner per ward, lockdown banner.

## 12. Permissions (RBAC keys)
`gate.policy.configure` (Hospital/Branch Admin) · `gate.visitor.manage` (Security Guard, Front Office) · `gate.pass.issue` (Security Guard, Front Office, Ward Nurse) · `gate.pass.read` (Security, Nurse, Admin) · `gate.pass.scan` (device tokens, Guard) · `gate.pass.manage` (Ward Nurse, Security Officer) · `gate.pass.revoke` (Nurse in-charge, Security Officer) · `gate.override.apply` (Doctor, Nurse in-charge; ABAC `assigned_ward_only`) · `gate.register.manage/read` (Security) · `gate.vehicle.manage/read` (Security) · `gate.parking.manage` (Security Supervisor) · `gate.material.create` (Stores, Biomedical, Dept in-charge) · `gate.material.approve` (Store In-charge, HOD, Admin by value) · `gate.material.issue` (Security Guard) · `gate.material.return` (Stores) · `gate.material.writeoff` (Hospital Admin) · `gate.blacklist.manage` (Security Officer, Admin) · `gate.contractor.manage` (Security Officer, Facility) · `gate.dashboard.read` (Security, Admin) · `gate.report.read` (Security Officer, Admin, Auditor) · `gate.export` (audited).

## 13. Non-functional
- 2000-bed enterprise: ~4000 visitor check-ins/day, ~2500 bystander passes active, ~1800 vehicle movements/day, 12 gates, 40 ward scan points, 30 material passes/day. Pass validation p95 < 100 ms (Redis-cached active-pass set per ward); check-in flow (form → photo → print) ≤ 30 s median.
- Photos stored as JPEG ≤ 120 KB (client-side resize) in S3/MinIO with presigned access; never inlined in logs or QR.
- Offline: gate console PWA functions for ≥ 4 h without network (issue + validate + queue sync); printer offline → digital pass fallback.
- Accessibility: WCAG 2.2 AA; verdict colour + icon + text (never colour alone); pass instructions in `en, hi, ta, te, ml, kn, mr, bn` with large print option; audio cue for scan verdict.
- Security: QR HMAC (HS256, rotating key), device-bound scanner tokens (EN-007), rate limit 60 scans/min/device, no PHI in QR or badge print.

## 14. Acceptance Criteria
1. Given a visitor arrives during ICU visiting hours and the patient already has 1 visitor inside, when the guard attempts to issue a second pass, then the system denies it with reason `limit_exceeded` and shows the current visitor's check-in time.
2. Given OTP verification is enabled, when the visitor's mobile is not verified after 2 attempts, then the guard can only proceed by recording an override reason, and the pass is flagged `mobile_unverified` in the register.
3. Given a bystander pass is scanned at a ward door outside the configured visiting window, when no active override exists, then the scanner shows DENY with reason `outside_hours` in the visitor's language and logs a violation event.
4. Given a doctor applies an emergency override for a critical patient with a 2-hour validity, when the same pass is scanned within that window, then it is allowed and both the allow verdict and the override reference appear in the audit trail.
5. Given a patient is discharged, when `ip.discharge.completed` is processed, then all bystander passes for that admission become inactive within 60 seconds, subsequent scans deny with `patient_discharged`, and the attendant receives a badge-return message.
6. Given an inter-ward transfer, when the patient moves from ICU to General ward, then the existing bystander pass ward reference is updated and the allowed-bystander count is re-evaluated against the new ward policy.
7. Given a returnable material gate pass with an expected return date of yesterday, when the daily job runs, then the pass status becomes `overdue`, appears on the ageing board, and escalation notifications reach the requester and HOD.
8. Given a non-returnable material pass without a completed approval chain, when the guard attempts gate release, then the action is blocked and the guard sees "Approval pending — cannot release".
9. Given a blacklisted mobile number, when the guard tries to register that visitor, then the pass is denied at guard level, a security alert fires, and only a Security Officer can override with a reason.
10. Given the gate console loses network, when the guard issues 10 passes offline, then passes print with offline-block numbers, scans validate against the cached signed list, and on reconnect all records sync with no duplicate pass numbers.
11. Given a vehicle is already logged as inside, when the same plate is entered again without an exit, then the system blocks the duplicate entry unless a supervisor forces it with a reason.
12. Given lockdown level `no_visitors` is set, when any new visitor pass is attempted, then it is denied hospital-wide, bystander passes continue to work, and the lockdown banner appears on all TV boards within 5 seconds.
13. Given a visitor photo older than the configured retention period (90 days) and not linked to an incident, when the retention job runs, then the photo file is deleted while the register row is retained without the image.
14. Given a material pass returns 3 of 5 items, when the return is recorded, then the pass status becomes `partially_returned`, the balance of 2 items remains tracked, and stock/asset records reflect only the returned items.
15. Given a security guard exports the gate register for a date range, when the export completes, then an `admin.audit` entry records the export with the user, filter and row count.

## 15. Enhancements / Later phases
- Facial recognition for frequent visitors and blacklist matching at the gate (EN-020, opt-in with DPDP notice and separate consent) — market/source enhancement.
- Digital pass in Google/Apple Wallet with automatic expiry; NFC badge instead of QR.
- Self-service visitor kiosk (EN-034) with ID-card OCR (AI-003) and unattended badge printing.
- Full ANPR integration with barrier automation and paid-parking POS with UPI (EN-010).
- Pre-registration of visitors by the patient's family from the app with slot booking to smooth visiting-hour crowding.
- Contractor safety-permit workflow (hot work, height, confined space) with digital sign-off (EN-016).
- Emergency evacuation roll-call: who is inside per zone, exported to a mustering app (ties to EN-018 evacuation map display).
- Wheelchair/special-needs flagging with porter dispatch (IP-025/NC-018 task) — source enhancement.
- Visitor satisfaction micro-survey on exit (EN-030); crowd-density prediction for visiting-hour staffing (AI-005).
- Integration with third-party access-control/turnstile systems and staff RFID cards for a single physical-security view.

## 16. Open Questions for the Hospital
1. Exact visiting hours per ward class (General, Private, ICU, NICU, Labour, Isolation, Psychiatry) and per day of week; are there separate attendant-only windows?
2. Allowed bystanders per ward class and the approval level for exceeding them; is overnight attendant stay permitted and in which wards?
3. Is OTP verification mandatory for all visitors, only for patient visits, or only after hours? Is photo capture mandatory, and is signage/notice text already approved by the DPO?
4. Which ID types are acceptable? Confirm the policy of storing only ID type + last 4 digits (no Aadhaar number, no ID scan image).
5. Physical badge model: printed thermal slip, reusable plastic badge, or phone-only digital pass? Who collects badges at exit and what is the non-return penalty?
6. Which gates and ward doors get scanners, and is there existing access-control/turnstile hardware (make/model) to integrate with?
7. Paid parking? If yes, tariff slabs, receipting (cash counter or standalone), and who reconciles.
8. Material gate pass approval matrix by value and item class (asset vs consumable vs waste), and who signs non-returnable releases (Condemnation Board?).
9. Contractor safety-induction validity period and who maintains the training records.
10. Retention periods desired for visitor photos, gate register and CCTV-linked events; DPDP notice language(s) required.
11. Lockdown/outbreak policy owner and the escalation path for declaring it.
12. Should visitor footfall data feed marketing/CRM (NC-026), or must it stay strictly within security use (purpose limitation)?
