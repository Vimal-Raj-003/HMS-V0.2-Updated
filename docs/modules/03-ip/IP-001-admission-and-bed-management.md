# IP-001 — Admission & Bed Management (ADT, bed board, ward/room/bed configuration, deposits, consent, insurance pre-auth trigger)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-001 |
| Phase | 7 |
| Priority | P0 |
| Complexity | High |
| Depends on | OP-001 (patient MPI/UHID/ABHA, appointments), OP-002 (admission advice from OPD CPOE), OP-006 (ER admission/bed request), EN-007 (RBAC/settings), EN-027 (MDM: departments, doctors, service catalogue), RC-003 (bed-class tariffs), RC-002 (pre-auth), EN-002 (payer master/TPA), NC-001 (deposit receipts/cash counter), EN-010 (online deposit), EN-028 (consents), EN-013 (wristband/QR), EN-015 (bystander/visitor pass), EN-009 (SMS/WhatsApp), EN-032 (email), EN-018 (ward TV boards), EN-037 (notifications), EN-038 (approvals), EN-024 (audit), NC-018 (housekeeping turnover), NC-030 (nurse roster/ratios), OP-011 (diet order on admit), OP-003/IP-014 (pharmacy admit alert), IP-003 (nursing assessment start), IP-005 (billing effects), IP-002 (discharge/bed release), IP-018 (transfers out), IP-025 (command centre/predicted discharge), EN-011 (ABDM), EN-019 (HL7 ADT A01/A02/A03/A08/A11) |
| Feature flag | `module.ip_adt.enabled` (sub-flags: `adt.bed_board_tv`, `adt.online_deposit`, `adt.belongings_inventory`, `adt.pre_admission`, `adt.auto_bed_suggest`) |
| Primary roles | Receptionist / IP Admission desk (24), Billing Executive IP (27), Nurse — Ward (17), Ward Boy/Transport (23), Housekeeping (50) |
| Secondary roles | Doctor — IP (7), Emergency Physician (8), Surgeon (9), Intensivist (11), Insurance/TPA desk (28), Cashier (26), Nurse Supervisor (22), Branch Admin (3), MS (4), Bed Manager (IP-025), Security (51), Patient/Family (59/60), Auditor (58) |
| Regulatory | NABH 5th ed. AAC.1–AAC.7 (admission, initial assessment within 24 h, transfer, bed availability), AAC.6 (patient identification — two identifiers, wristband), COP.1, PRE.4/PRE.5 (informed consent: general consent at admission, procedure-specific), Clinical Establishments Act (indoor register), MTP/CrPC (MLC flag continuity), DPDP Act 2023 & Rules 2025 (consent ledger, purpose limitation), ABDM V3 (ABHA link, HIP), GST (deposit not taxable until adjusted; receipt voucher), IRDAI/TPA pre-auth timelines (cashless: pre-auth within 24 h of admission / emergency within 24 h), HL7 v2 ADT (interop) |

## 1. Purpose
IP-001 is the single source of truth for who is admitted where. It configures the physical bed hierarchy (branch → block/building → floor → ward/unit → room → bed) with bed classes and effective-dated tariffs, runs the ADT lifecycle (admission request → bed allotment → admission → transfers → temporary leave/bed hold → discharge release → housekeeping → available), collects deposits, captures general/procedure consents (EN-028), issues wristbands (EN-013) and bystander passes (EN-015), triggers insurance pre-authorisation (RC-002) and drives every downstream IP module (nursing assessment, diet, pharmacy, IP billing) through domain events. The bed board is a real-time read model consumed by desktop, tablet, ward TVs and the command centre (IP-025).

## 2. Users & Jobs-to-be-done
- **Admission desk / receptionist** (desktop, 100–250 admissions/day): convert admission advice into an admission in ≤ 3 min; verify identity (UHID/ABHA/two identifiers), choose bed by class/ward availability, collect deposit & print receipt, print admission slip/wristband/bystander pass, capture general consent, register attendant details and belongings, flag insurance/TPA/scheme.
- **Emergency physician / ER nurse** (desktop/tablet): fast-track admission from ER with minimal fields (name/sex/approx age/ER number), bed hold in ICU/ward, complete registration later.
- **Doctor OPD/IP** (desktop/phone): raise admission advice (diagnosis, expected LOS, ward class, isolation need, planned surgery, pre-op requirements) from OP-002/OP-019; view own admitted patients.
- **Ward nurse / in-charge** (desktop nursing station + tablet): see incoming patients, accept arrival ("received in ward" time), request transfers, mark bed for cleaning, block/unblock beds (repair, isolation), keep the census correct.
- **Ward boy / transport** (phone): transport tasks (ER→ward, ward→OT, ward→ward) with start/end times.
- **Housekeeping** (phone): cleaning task on release; confirm "clean" → bed available.
- **Billing/TPA desk** (desktop): deposit adjustments, credit-limit visibility, pre-auth trigger and status; approve class-change billing effects.
- **Bed manager / nurse supervisor** (desktop/TV): occupancy by ward/class, expected discharges, blocked beds, waiting list, ICU pressure, ratio breaches.
- **Branch admin** (desktop): configure buildings/wards/rooms/beds, bed classes, tariffs (via RC-003), housekeeping SLAs, deposit rules, numbering.
- **Patient/family** (portal/kiosk/phone): view bed/ward, running deposit, pre-auth status, pay deposit online, download admission documents.

## 3. Core Workflows

### 3.1 Ward / bed configuration (branch admin)
1. **Admin** creates hierarchy `building → floor → ward (unit) → room → bed`; each ward has type (general/semi-private/private/deluxe/suite/ICU/CCU/NICU/PICU/HDU/isolation/labour/day-care/dialysis/emergency-obs), speciality, sex policy (male/female/mixed/paediatric), nurse:patient ratio target, TV board id. Rooms have `room_type`, sharing capacity, amenities. Beds have code (`W3-R12-B2`), `bed_class_id`, status, features (oxygen, suction, monitor, ventilator-capable, isolation negative-pressure, bariatric, cot/crib).
2. **Admin** defines `bed_classes` (General/Semi/Private/Deluxe/Suite/ICU/HDU/NICU/Isolation…) → each maps to RC-003 tariff plan items: `room_rent`, `nursing_charge`, `service_charge`, `doctor_visit_multiplier`, `class_factor` for procedures/investigations (payer-wise tariffs by class live in RC-003; IP-001 only references `bed_class_id`).
3. Bed lifecycle enums seeded; housekeeping SLA (default 45 min ward, 60 min ICU); deposit policy per class/payer (fixed amount, % of estimated package, scheme = 0); numbering series `IP_NO` pattern (`{BR}/IP/{FY}/{SEQ:6}`); admission form template versions (EN-039); consent templates (EN-028).
4. Bulk import via EN-036; changes effective-dated; a bed cannot be deleted while occupied/blocked with a future reservation (soft-retire only). Event `bed.config.changed` → bed-board read model rebuild.

### 3.2 Admission advice → admission request
1. **Doctor** (OP-002/OP-019/OP-006) creates **admission advice**: patient, provisional diagnosis (ICD-10), admitting department & consultant, requested ward type/class, urgency (elective/urgent/emergency), expected LOS, planned procedure (links IP-006 booking request), isolation requirement (airborne/droplet/contact), special needs (ventilator, dialysis, bariatric), payer intent (self/insurance/scheme/corporate), pre-admission instructions (NPO, stop anticoagulants), estimated cost (RC-008 quote if available) → status `advised` → Event `ip.admission.advised` → shows in admission desk queue + patient portal ("Admission advised — estimate & documents").
2. **Admission desk** opens the request → **System** shows patient banner (photo, UHID, ABHA, allergies, alerts, MLC, outstanding dues, prior admissions, insurance policies on file), bed availability for the requested class, estimated deposit → desk can schedule elective admission date (`pre_admission` flag: checklist of documents/pre-op tests, deposit paid online, room preference) → Event `ip.admission.scheduled`.
3. **Waiting list** when no bed of the requested class: request goes to `waitlisted` with priority (emergency > urgent > elective, then time); when a bed becomes available the system suggests allocation (`adt.auto_bed_suggest`: acuity, sex policy, isolation, features, requested class, same-ward continuity) → desk confirms.

### 3.3 Admission (happy path)
1. **Desk** verifies identity: scans UHID QR/ABHA or two identifiers (name + DOB/phone); unknown patient (ER) uses temporary identity from OP-006 with `identity_status=provisional`.
2. Fills admission form: admitting doctor (+ secondary consultants), department, ward/room/bed (from live board; ICU class requires intensivist acceptance if configured), admission type (elective/emergency/day-care/observation/transfer-in/newborn/maternity), source (OPD/ER/direct/referral/transfer-in/readmission < 30 d auto-flag), payer & policy (EN-002: insurer/TPA/policy no./corporate/scheme PMJAY card), attendant/bystander details (name, relation, phone, ID), emergency contact, MLC flag carry-over, diet preference, language, religion (optional), belongings inventory (`adt.belongings_inventory`: items list, valuables handed to security with receipt), special needs.
3. **System** validates: bed available & not blocked; sex/age policy of ward; isolation need vs bed feature; no open admission for the same patient (or explicit "second admission" for newborn); duplicate check across branches (EN-041); previous unpaid bills → warning/approval per policy; **generates IP number** from numbering series (gapless not required).
4. **Consents** (EN-028): general consent for treatment, financial consent (estimated cost & deposit policy), DPDP data-processing consent, insurance/TPA information-sharing consent, HIV/photo/teaching consents where relevant → captured on tablet signature pad/e-sign (EN-016)/paper scan; procedure-specific consents are linked later by IP-006/OP-010; admission cannot be finalised without general consent except emergency (`consent_deferred=true`, reminder every 4 h).
5. **Deposit** (NC-001/EN-010): system computes suggested deposit from policy (class × expected LOS or package %; scheme/PMJAY = 0; corporate credit = per contract; TPA cashless = configurable nominal); desk collects cash/card/UPI/link → receipt (`RECEIPT` series, GST-neutral advance) → posts to IP-005 patient ledger as `deposit`; deposit waiver/short-deposit requires approval (EN-038 matrix, e.g. billing manager) with reason.
6. **Insurance pre-auth trigger**: if payer = insurance/TPA/scheme → **System** auto-creates RC-002 pre-auth case with admission data (diagnosis, doctor, expected LOS, estimated cost, room class eligibility from policy) and document checklist (ID, policy card, doctor's letter, investigation reports, estimate) → status visible on the admission (`preauth_status`), Event `ip.admission.preauth_requested`; approved amount later sets the credit limit in IP-005 (Event `preauth.approved` consumed).
7. **Prints/outputs**: admission summary, bed allocation slip, deposit receipt, wristband (EN-013: name, UHID, IP no., age/sex, blood group if known, allergy indicator, barcode/QR; colour band for allergy/fall/DNR per policy), bystander pass (EN-015: 1–2 passes per patient with photo/QR, valid till discharge), pre-auth form, welcome kit/ward rules (multilingual).
8. **Bed occupied** → Event `ip.admitted` {ip_no, patient, bed, class, doctor, payer, isolation, source, expected_los} → consumers: IP-005 (open IP bill; room-rent posting starts), IP-003 (create nursing worklist; initial assessment due ≤ 24 h per NABH; vitals schedule), OP-011 (diet order pending), IP-014/OP-003 (ward pharmacy alerted, patient drug profile), EN-018 (ward TV), IP-025 (command centre), EN-011 (ABDM care-context link — Encounter created), EN-019 (HL7 ADT^A01 to PACS/LIS/other systems), EN-009 (SMS/WhatsApp to patient/attendant: ward/bed, visiting hours, helpline), NC-030 (ratio recompute).
9. **Arrival in ward**: transport task to ward boy; ward nurse taps "Received" (records `received_at`, verifies wristband scan → identity check) → nursing admission assessment starts (IP-003).

### 3.4 Emergency (fast-track) admission
1. **ER doctor/nurse** (OP-006) → "Admit now": minimal fields (temp name/sex/age band, ER no., diagnosis, ward class/ICU) → **System** issues IP no. with `registration_complete=false`, `consent_deferred`, `deposit_deferred` → bed hold or direct occupy → Event `ip.admitted` (flag `fast_track`).
2. Desk completes demographics/payer/consent/deposit within configurable window (default 4 h); pending items appear as tasks (EN-037) and on IP-005 bill hold list; when patient identity is later merged with an existing UHID (OP-001 merge), the admission re-points and events replay `ip.admission.updated`.

### 3.5 Bed transfer (intra-branch) with billing effect
1. **Nurse/doctor** raises transfer request: reason (clinical upgrade/downgrade, patient request, isolation, ward closure, ICU step-down), destination class/ward, urgency → **System** shows candidate beds; ICU/HDU destination requires intensivist/HOD acceptance (EN-038); downgrade/upgrade with different class requires billing acknowledgement (patient/attendant informed of tariff change; insurance room-rent eligibility check → warns if new class exceeds policy limit → proportionate deduction alert to TPA desk).
2. Confirm → **System** closes current `bed_occupancies` row (`ended_at`), opens new row (`bed_id`, `bed_class_id`, `started_at`), marks source bed `to_be_cleaned`, transport task created; Event `ip.transferred` {from_bed, to_bed, from_class, to_class, at, reason} → IP-005 applies proration rules (per hospital policy: hourly/day-boundary/higher-class-for-the-day), IP-003 moves worklists/MAR to new ward, EN-018, EN-019 (ADT^A02), IP-012 (isolation).
3. **Swap** (two patients exchange beds) is a single atomic operation. **Undo transfer** allowed within 15 min by supervisor if no charges posted (`ip.transfer.reversed`).

### 3.6 Bed hold, temporary leave, blocking, housekeeping
- **Bed hold/reservation** for expected admissions/ER/OT return/ICU (with TTL; auto-release + alert). Patient away for OT/procedure/dialysis keeps bed `occupied` with `patient_location` = OT/CT/dialysis (location tracking) — no billing change.
- **Temporary leave/LAMA-pending** (patient goes home on pass, rare): bed retained & charged per policy or released; documented.
- **Blocking**: reason (maintenance/repair, isolation clean, fumigation, staffing, reserved for VIP/study), from/to, approval for > 24 h; blocked beds excluded from availability; NC-020/NC-025 work order link.
- **Housekeeping states**: `occupied → to_be_cleaned (on release) → cleaning_in_progress → cleaned → inspected (optional supervisor) → available`; SLA timers; NC-018 dispatch; terminal cleaning flag for isolation/infectious (IP-012).
- Bed board colours: green available, red occupied, yellow discharge-initiated/pending, orange to-be-cleaned/cleaning, blue blocked/maintenance, purple reserved/hold, striped isolation.

### 3.7 Discharge release & other exits
- IP-002 emits `ip.discharge.completed`; IP-001 ends occupancy, sets `to_be_cleaned`, closes admission (`status=discharged`, `discharge_type`), releases bystander passes, notifies TV/command centre, EN-019 ADT^A03. Death → IP-017; transfer-out → IP-018 (`transferred_out`); absconded → status `absconded` with security/MLC steps; DAMA/LAMA → consent captured in IP-002.
- **Cancel admission** (registered but patient never occupied / left within X min): reason, refund of deposit via NC-001, IP no. voided (audit), Event `ip.admission.cancelled` (ADT^A11).

### 3.8 Exceptions
1. Wrong bed selected → correction within 30 min by desk without transfer record if no charge posted; else formal transfer.
2. Patient with outstanding dues > threshold → admission needs billing manager approval (emergency exempt).
3. Insurance policy expired/ineligible room class → warning; patient chooses class with acknowledgement of proportionate deduction.
4. Ward closure/mass transfer (fumigation, disaster) → bulk transfer wizard with approval; each transfer evented.
5. Newborn admission from IP-011: created programmatically with `mother_admission_id`, bed = bassinet/rooming-in with mother (no separate room rent unless NICU).
6. Offline (LAN down at desk): PWA allows admission draft with locally reserved provisional IP no. range (`IP-TMP-xxxx`) → syncs; conflict = duplicate patient → merge queue.

### 3.9 Statutory registers, MRD & interoperability
1. Every admission/discharge writes to the **indoor register** read model (Clinical Establishments Act / state format): IP no., name, age/sex, address, admission/discharge date-time, department, doctor, diagnosis, outcome, MLC no. → printable/exportable monthly by MRD (NC-003).
2. On admission the MRD file (NC-003) is opened; on closure the file goes to deficiency check (IP-002 emits `ip.discharge.completed`).
3. HL7 ADT^A01/A02/A03/A08/A11 messages built by EN-019 from `ip.*` events; ABDM (EN-011) Encounter created at admission for care-context linking so that lab/discharge documents can be pushed later.

### 3.10 Day-care & observation admissions
- Admission type `day_care` (chemo day-care, dialysis, minor procedures) and `observation` (ER obs ≤ 24 h) use the same ADT with `expected_los` in hours; IP-005 applies day-care tariff (no room rent, day-care charge) and auto-closes if the patient is not converted to full admission within the configured window (default 24 h) — conversion is a `PATCH /admissions/{id}` with `admission_type=elective/emergency` and evented as `ip.admission.updated{converted_from:day_care}`.

## 4. Data Model (schema `ip`; masters in `mdm`)
- **mdm.buildings** (id, hospital_id, branch_id, code, name, floors int); **mdm.wards** (id, hospital_id, branch_id, building_id, floor, code, name, ward_type enum, speciality_dept_id, sex_policy enum(male/female/mixed/paediatric/any), age_min, age_max, nurse_ratio_target numeric(4,2), tv_board_id, is_active, cost_centre_id); **mdm.rooms** (id, ward_id, code, room_type, capacity, amenities jsonb, is_active); **mdm.bed_classes** (id, hospital_id, code, name, rank int, tariff_plan_ref, deposit_rule jsonb, colour); **mdm.beds** (id, hospital_id, branch_id, ward_id, room_id, code unique per branch, bed_class_id, features jsonb, status enum(available/occupied/reserved/to_be_cleaned/cleaning/cleaned/blocked/retired), status_since, current_occupancy_id?, is_active, version).
- **ip.admission_requests** (id, hospital_id, branch_id, patient_id, encounter_id (OPD/ER), advised_by, department_id, consultant_id, provisional_dx_icd text[], urgency enum, requested_class_id, requested_ward_type, isolation enum?, special_needs jsonb, expected_los int, planned_procedure_id?, payer_intent, estimate_id?, scheduled_date?, status enum(advised/scheduled/waitlisted/admitted/cancelled/expired), priority int, created_at…).
- **ip.admissions** (id, hospital_id, branch_id, ip_no unique per hospital, patient_id, request_id?, admission_type enum(elective/emergency/day_care/observation/transfer_in/newborn/maternity), source enum, admitted_at, admitting_doctor_id, department_id, secondary_doctors uuid[], provisional_dx text[], payer_type enum(self/insurance/tpa/corporate/scheme/govt), payer_id?, policy_no, preauth_case_id?, credit_limit numeric(14,2)?, mlc_no?, isolation_type?, mother_admission_id?, registration_complete bool, consent_status enum(complete/deferred/refused), deposit_status enum(paid/short/waived/deferred), status enum(admitted/discharge_initiated/discharged/dama/absconded/transferred_out/died/cancelled), expected_discharge_at, discharged_at, discharge_type?, current_bed_id, current_ward_id, current_class_id, patient_location enum(bed/ot/procedure/dialysis/imaging/leave), readmission_within_30d bool, version, audit cols). Indexes: (hospital_id, status, current_ward_id), (hospital_id, patient_id, admitted_at desc), (hospital_id, ip_no).
- **ip.bed_occupancies** (id, admission_id, bed_id, ward_id, bed_class_id, started_at, ended_at?, reason enum(admission/transfer/swap/correction/return_from_leave), billing_effect enum(charge/no_charge/hold_charge), created_by) — exactly one open row per admission (partial unique index `where ended_at is null`); btree_gist exclusion constraint on (bed_id, tstzrange(started_at, ended_at)) so a bed never has overlapping occupants.
- **ip.bed_status_history** (bed_id, from_status, to_status, at, by, reason, sla_due_at, task_id?) — partitioned monthly.
- **ip.bed_reservations** (bed_id, admission_request_id?/admission_id?, reason, from, ttl_until, status, by).
- **ip.bed_blocks** (bed_id, reason enum, from, to, approved_by, work_order_id?, released_at).
- **ip.transfer_requests** (admission_id, from_bed_id, to_class_id, to_ward_id?, reason, urgency, status enum(requested/approved/rejected/completed/cancelled), approver_id, billing_ack_by, insurance_warning jsonb).
- **ip.admission_attendants** (admission_id, name, relation, phone, id_type/id_no masked, pass_id (EN-015), is_primary); **ip.patient_belongings** (admission_id, items jsonb, valuables_receipt_no, handed_to, returned_at, signatures).
- **ip.deposits** (admission_id, receipt_id (NC-001), amount, mode, kind enum(initial/top_up/refund), waived bool, waiver_approver, created_at) — mirrored to IP-005 ledger.
- **ip.admission_consents** (admission_id, consent_id (EN-028), type, status, captured_at).
- **ip.transport_tasks** (admission_id, from_location, to_location, requested_by, assigned_to, status, started_at, completed_at, mode enum(wheelchair/stretcher/walk/bed)).
- Read model **analytics.bed_board** (bed_id, branch, ward, room, code, class, status, patient masked fields, admission_id, doctor, admitted_at, expected_discharge, isolation, alerts, los_days) — refreshed by events into Redis + table.
- All tables RLS by hospital_id; admissions never hard-deleted; retention per MRD (≥ 10 y adult, per state rules).

## 5. Business Rules & Validations
- One open admission per patient per branch (newborn/mother pair allowed); readmission within 30 days flagged for IP-002 quality tracking.
- IP number from `IP_NO` series; format configurable; ER fast-track uses same series (no temp series) but `registration_complete=false`; cancelled numbers retained as voided.
- Bed availability computed from `beds.status` + open reservations; allocation is transactional (`SELECT … FOR UPDATE SKIP LOCKED` on bed) to prevent double allotment; exclusion constraint is the last line of defence.
- Ward sex/age policy enforced (override by nurse supervisor with reason); isolation need requires isolation-capable bed or supervisor override + IP-012 notification.
- General consent mandatory before non-emergency admission; deferred consents auto-remind q4h and block elective OT (IP-006 pre-op check reads `consent_status`).
- Deposit suggestion = max(class deposit rule, package % rule) − existing credit; short/waived deposit needs approval per EN-038 matrix; deposits are non-taxable advances until adjusted in IP-005.
- Insurance patients: pre-auth case created automatically at admission (or on payer change); room-class eligibility check against policy (EN-002) with proportionate-deduction warning; TPA credit limit stored on admission after approval.
- Transfer billing effect per hospital policy (configurable): (a) day-boundary rule — class occupied at midnight/checkout hour is charged for the day; (b) higher-class rule — highest class occupied that day; (c) hourly proration. IP-005 implements; IP-001 records exact timestamps.
- Housekeeping SLA per ward type; breach → escalation to housekeeping supervisor; bed cannot become `available` without cleaning confirmation (except manual override with reason).
- Bed hold TTL default 2 h (ER), 6 h (elective), 24 h (OT ICU return); expiry releases and notifies.
- Expected discharge date maintained (doctor/nurse update); LOS > expected + 2 days → flag to bed manager (IP-025).
- Blocked > 24 h needs approval; retired beds keep history; capacity reports use `is_active` beds only.
- MLC flag from OP-006/TR-008 carries into admission banner; cannot be cleared here.
- Audit: every status change, transfer, deposit waiver, consent, and override written to EN-024 with reason.

## 6. API Surface (`/api/v1/ip`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | /config/buildings, /config/wards, /config/rooms, /config/beds, /config/bed-classes | hierarchy & classes | bed.config.manage | Y | cursor |
| POST | /config/beds/import | bulk import (EN-036) | bed.config.manage | Y | – |
| GET | /beds/board?branch=&ward=&class=&status= | bed board read model | bed.board.read | – | – |
| GET | /beds/availability?class=&ward=&features= | free beds & suggestions | bed.board.read | – | – |
| POST | /beds/{id}/block, /unblock, /reserve, /release-reservation | blocking/holds | bed.block.manage / bed.reserve | Y | – |
| POST | /beds/{id}/housekeeping/{action} | to_be_cleaned→cleaning→cleaned→available | bed.housekeeping.update | Y | – |
| POST | /admission-requests | admission advice | ip.admission.advise | Y | – |
| GET | /admission-requests?status=&ward= | desk queue / waitlist | ip.admission.list | – | cursor |
| PATCH | /admission-requests/{id} | schedule/waitlist/cancel | ip.admission.advise / ip.admission.create | Y | – |
| POST | /admissions | admit (full or fast-track) | ip.admission.create | Y | – |
| GET | /admissions/{id} | admission detail | ip.admission.read | – | – |
| GET | /admissions?status=&ward=&doctor=&payer= | census list | ip.admission.list | – | cursor |
| PATCH | /admissions/{id} | complete registration / update payer, doctors, expected discharge | ip.admission.update | Y | – |
| POST | /admissions/{id}/consents | link EN-028 consent | ip.consent.capture | Y | – |
| POST | /admissions/{id}/deposits | collect/top-up/waive | ip.deposit.collect / ip.deposit.waive | Y | – |
| POST | /admissions/{id}/preauth | (re)trigger RC-002 | ip.preauth.trigger | Y | – |
| POST | /admissions/{id}/transfer-requests | request transfer | ip.transfer.request | Y | – |
| POST | /transfer-requests/{id}/approve|reject|complete | transfer flow | ip.transfer.approve / ip.transfer.execute | Y | – |
| POST | /admissions/{id}/swap | swap beds with another admission | ip.transfer.execute | Y | – |
| POST | /admissions/{id}/location | patient away/back (OT etc.) | ip.admission.update | Y | – |
| POST | /admissions/{id}/received | ward acknowledges arrival | ip.admission.update | Y | – |
| POST | /admissions/{id}/attendants, /belongings, /wristband/print, /passes | attendant/belongings/prints | ip.admission.update / ip.print | Y | – |
| POST | /admissions/{id}/cancel | cancel admission | ip.admission.cancel | Y | – |
| POST | /transport-tasks, PATCH /transport-tasks/{id} | transport | ip.transport.manage | Y | cursor |
| GET | /reports/census, /reports/occupancy, /reports/alos | reports | ip.report.read | – | – |
| Webhooks/consumed | `preauth.approved|rejected|enhanced` (RC-002), `ip.discharge.completed` (IP-002), `patient.merged` (OP-001) | | | | |

## 7. Domain Events (outbox)
- `ip.admission.advised|scheduled|waitlisted|cancelled` → desk queue, portal, RC-008.
- `ip.admitted` {admission_id, ip_no, patient_id, bed_id, ward_id, class_id, doctor_id, department_id, payer_type, payer_id, isolation, fast_track, expected_los, mlc} → IP-005, IP-003, OP-011, IP-014, EN-018, IP-025, EN-011, EN-019, EN-009, NC-030, IP-012.
- `ip.admission.updated` {changed_fields} (payer change → IP-005 re-rates; doctor change → IP-003/IP-010 lists).
- `ip.admission.preauth_requested` → RC-002/EN-002; `ip.credit_limit.set` → IP-005.
- `ip.transferred` {from_bed, to_bed, from_class, to_class, at, reason, billing_effect}, `ip.transfer.reversed`.
- `ip.patient_location.changed` → EN-018, IP-003.
- `bed.status.changed` {bed_id, from, to, at, sla_due} → NC-018, IP-025, EN-018; `bed.blocked|unblocked|reserved|reservation_expired`.
- `bed.housekeeping.sla_breached` → EN-037.
- `ip.deposit.collected|waived|refund_requested` → IP-005, NC-001.
- `ip.consent.captured|deferred|refused` → IP-006 pre-op checks, EN-028 ledger.
- `ip.admission.closed` {status: discharged/dama/died/absconded/transferred_out} (after IP-002/017/018) → EN-019 ADT^A03, EN-015 pass revoke, IP-025.
- Consumes: `preauth.*`, `ip.discharge.initiated|completed`, `patient.merged`, `housekeeping.task.completed` (NC-018), `ot.case.scheduled` (bed hold on return), `er.disposition.admit` (OP-006).

## 8. Screens (UI)
- **Bed Board** (desktop 3-pane; tablet; TV via EN-018 dark full-screen): filters branch/building/floor/ward/class/status; grid or floor-map view; bed tile: code, class icon, colour status, patient initials/name (per privacy setting), sex/age, doctor, LOS, expected discharge, isolation/alert icons; click → side panel (admission summary, actions: transfer, block, clean, print). Real-time via Socket.IO (`bed.status.changed`). Shortcuts: `/` search patient/bed, `F` filter, `T` transfer, `B` block, `H` housekeeping action, `A` admit to selected bed. Empty: "No beds configured — set up wards". Error: stale > 30 s banner with retry.
- **Admission Desk Queue** (desktop): tabs Advised / Scheduled today / Waitlist / Fast-track pending completion; SLA colours; `Enter` open, `N` new direct admission.
- **Admission Form** (desktop 2-column wizard; tablet): identity verify (scan), demographics (read-only from MPI, edit link), clinical (doctor, dept, dx, type, source), bed picker (live availability, class filter, features), payer & policy (eligibility hint, room-class limit), attendants & belongings, consents (signature pad / e-sign / upload), deposit (amount suggestion, pay, receipt), summary & prints. Autosave draft; `Ctrl+S` save, `Ctrl+P` print set, `Alt+B` bed picker. Validation inline; hard stops listed.
- **Fast-track Admit** (ER, desktop/tablet): 6 fields + bed → 20 s flow.
- **Transfer Dialog** (desktop/tablet): reason, destination suggestions, billing effect preview (tariff diff, insurance warning), approvals, transport.
- **Ward Census** (desktop nursing station widget): incoming/expected, in-ward list, outgoing, blocked; "Received" action.
- **Housekeeping Task List** (phone): beds to clean sorted by SLA; start/finish; photo optional; offline queue.
- **Transport Tasks** (phone): accept, start, complete; barcode scan of wristband at pickup/drop.
- **Ward/Bed Configuration** (desktop admin): tree editor, bulk create beds, class mapping, SLA/deposit rules; validation prevents deleting occupied.
- **Occupancy Dashboard** (desktop/TV): totals, occupied/vacant/blocked/cleaning, occupancy % per ward/class, trend, waitlist count, ICU pressure, expected discharges today.
- **Patient/Family view** (portal/phone): ward/bed, treating team, deposit balance, pre-auth status, pay deposit, visiting hours/pass QR.

## 9. Integrations
- RC-002/EN-002 pre-auth (event + REST), NC-001/EN-010 receipts & online deposit (Razorpay link/QR), EN-013 wristband (ZPL/thermal via EN-005), EN-015 passes (QR), EN-028/EN-016 consents & e-sign, EN-018 TV boards, EN-019 HL7 ADT A01/A02/A03/A08/A11 outbound (LIS/PACS/third-party), EN-011 ABDM (Encounter care-context; discharge summary later via IP-002), NC-018 housekeeping tasks, NC-030 roster ratios, IP-025 command centre, OP-006 ER, OP-002 advice, EN-009/EN-032 messages, EN-036 imports, EN-041 group MPI.
- Retries via outbox; HL7 sends via integration-hub with DLQ; TV boards degrade to last snapshot.

## 10. Reports & Analytics
- Daily census (midnight census, admissions/discharges/transfers/deaths), bed occupancy % by ward/class/day, ALOS by department/doctor/DRG-like grouping, bed turnover interval, housekeeping TAT & SLA compliance, waitlist & time-to-bed, ER→ward admit time, deposit collection vs policy, pre-auth trigger-to-approval time, readmissions ≤ 30 d, blocked bed-days, transfer counts (upgrade/downgrade), indoor register (statutory), fast-track completion time.
- Read models: `analytics.mv_bed_occupancy_daily`, `analytics.mv_ip_census`, `analytics.bed_board`, `analytics.mv_admission_funnel`.

## 11. Notifications
- Patient/attendant: admission confirmation (ward/bed, doctor, helpline), deposit receipt link, pre-auth status changes, transfer notice, visiting rules — SMS/WhatsApp (DLT templates) + portal push.
- Staff: desk — new advice/waitlist bed available; ward nurse — incoming patient/transfer in; ward boy — transport task; housekeeping — cleaning task & SLA breach; TPA desk — pre-auth required/room-class mismatch; billing — deposit waiver requests; supervisor — bed hold expiring, ratio breach; doctor — patient admitted (push).
- TV: ward board update, occupancy summary.

## 12. Permissions (RBAC keys)
`bed.config.manage`, `bed.board.read`, `bed.block.manage`, `bed.reserve`, `bed.housekeeping.update`, `ip.admission.advise`, `ip.admission.list|read|create|update|cancel`, `ip.consent.capture`, `ip.deposit.collect|waive`, `ip.preauth.trigger`, `ip.transfer.request|approve|execute`, `ip.transport.manage`, `ip.print`, `ip.report.read|export`.
Defaults: Branch admin (3): bed.config.manage; Receptionist/IP desk (24): admission.*, consent.capture, deposit.collect, preauth.trigger, print, transfer.execute; Cashier (26): deposit.collect; Billing IP (27): deposit.waive (with amount_limit), transfer.approve (billing ack); Doctors (6–11): admission.advise, transfer.request, admission.read; Intensivist/HOD: transfer.approve (ICU); Ward nurse (17): board.read, transfer.request, housekeeping.update (mark to-clean), admission.update (received/location); Housekeeping (50): housekeeping.update; Ward boy (23): transport.manage; TPA desk (28): preauth.trigger, admission.read; Bed manager/Nurse supervisor (22): block.manage, reserve, board.read, transfer.approve; TV device: bed.board.read (masked); Patient (59): own admission read.

## 13. Non-functional
- Volumes: 2000 beds, 300 admissions + 300 discharges + 400 transfers/day, 5k bed status changes/day; board with 2000 tiles renders < 1 s (virtualised), updates < 2 s end-to-end.
- p95: bed availability query < 100 ms (Redis read model), admit transaction < 400 ms, board API < 200 ms.
- Concurrency: bed allocation serialised per bed; exclusion constraint prevents overlaps.
- Offline: desk PWA drafts; housekeeping/transport phone apps queue actions (IndexedDB) and sync; TV shows last snapshot with "stale" indicator.
- Printing: wristband ZPL 2"×11" wristband printers (Zebra HC100 class), A4/A5 slips, thermal receipts.
- Accessibility/i18n: colour + icon + text for statuses; RTL-ready; multilingual admission consent & welcome kit.
- Security: patient names on TV masked per setting; belongings/valuables encrypted fields; PHI access audited.

## 14. Acceptance Criteria
1. Given a ward configured with 10 beds of class Private and 2 blocked, when the desk queries availability for Private, then 8 beds are returned and blocked beds are excluded.
2. Given two desks attempt to admit different patients to bed W3-R12-B2 simultaneously, then exactly one succeeds and the other receives a 409 with the next suggested bed.
3. Given an admission advice from OPD with payer = TPA, when the desk admits, then an RC-002 pre-auth case is auto-created with diagnosis, doctor, expected LOS and estimate, and the admission shows `preauth_status=requested`.
4. Given a female-only ward, when a male patient is allotted, then the system blocks unless a nurse supervisor overrides with a reason, and the override is audited.
5. Given deposit policy 2 days × class tariff and the patient pays less, then the admission is `deposit_status=short`, a waiver approval task is created, and the bill shows deposit short until approved.
6. Given a general consent not captured for an elective admission, then the admission cannot be finalised; for `emergency` type it is allowed with `consent_deferred=true` and reminders every 4 h.
7. Given an admission finalised, then the wristband print job (ZPL) contains UHID, IP no., name, age/sex, allergy indicator and QR resolving to the admission; the bystander pass QR validates at the gate (EN-015).
8. Given a transfer from General to ICU at 14:20 with day-boundary billing rule, then `bed_occupancies` shows the General row ended 14:20 and ICU row started 14:20, `ip.transferred` carries both classes, and IP-005 charges ICU for that day per the configured rule.
9. Given a discharge completed at 11:05, then the bed becomes `to_be_cleaned`, a housekeeping task with SLA 45 min is created, and after "cleaned" the bed becomes `available` and the TV board updates within 2 s.
10. Given a housekeeping SLA elapses without completion, then the housekeeping supervisor is notified and the breach appears in the occupancy dashboard.
11. Given a fast-track ER admission with only name/sex/age band, then an IP number is issued, `registration_complete=false`, and after 4 h without completion a task escalates to the admission desk lead.
12. Given the patient is in OT, when the ward views the bed board, then the bed remains occupied with location "OT" and no charge change occurs.
13. Given a bed reservation for an OT return with TTL 24 h expires, then the reservation is released and the bed manager notified.
14. Given a readmission within 30 days of a prior discharge, then the admission is flagged `readmission_within_30d` and appears in IP-002 readmission tracking.
15. Given a user without `ip.deposit.waive`, when they try to waive a deposit, then the API returns 403 and the attempt is audited.
16. Given a cancelled admission (patient never occupied), then the IP number is retained as voided, deposit refund is created in NC-001, and ADT^A11 is emitted.
17. Given a request to retire a bed currently occupied, then the operation is rejected with a clear message.
18. Given the desk LAN is down, when an admission is drafted offline, then it syncs on reconnect with a proper IP number and no duplicate patient is created (merge queue if suspected).
19. Given a day-care admission not converted within 24 h, then it auto-closes with a day-care bill and `ip.admission.closed{status:discharged, discharge_type:day_care}`.
20. Given a newborn admission created by IP-011, then it carries `mother_admission_id`, shares the mother's room without a second room-rent line, and appears on the bed board as a bassinet tile under the mother's bed.
21. Given ADT is enabled for a downstream LIS, when a patient is transferred, then an HL7 ADT^A02 with PV1 containing new ward/room/bed is queued to the integration hub within 5 s and retried with DLQ on failure.
22. Given a bed swap between two occupied beds, then both occupancy rows close and reopen in one transaction with the same timestamp and two `ip.transferred` events reference each other via `swap_group_id`.

### Golden-path e2e (Playwright)
- OPD advice → desk schedule → admit (identity scan, bed pick, consent e-sign, deposit UPI link, wristband print) → ward "Received" → transfer to ICU with approval → discharge release → housekeeping → available; asserts events, board updates and prints.

## 15. Enhancements / Later phases
- From VIMS sheet row 20: AI-predicted length of stay (AI-005), auto bed suggestion by acuity (basic rules here; ML later), pre-admission checklist completion (portal, `adt.pre_admission`), patient belongings inventory (here), auto-alert dietary/pharmacy on admit (here via events).
- From row 14: predictive bed demand forecasting (AI-005/IP-025), auto housekeeping dispatch on discharge (here + NC-018), patient fall detection IoT (EN-042), family visit scheduling via portal (PE-001/EN-015), patient satisfaction survey per ward (EN-030).
- (market) Emergency → IPD data sync pre-filling patient + insurance (here), single source of admission truth, bed-deletion safety constraints (here), floor-map visual bed grid; RTLS patient location; interpreter need flag; VIP/confidential admissions (masked board); international patient desk (passport/visa/FRRO Form C) — later phase.

## 16. Open Questions for the Hospital
1. Exact building/floor/ward/room/bed inventory and bed classes; any beds shared between classes (convertible)?
2. Room-rent billing rule on transfer: day-boundary (which checkout hour?), higher-class-for-day, or hourly? Same for admission after midnight (grace period)?
3. Deposit policy per class/payer; who can waive; is online deposit allowed pre-admission?
4. Consent set required at admission (languages, e-sign vs wet signature + scan)?
5. Bystander policy: passes per patient, ICU rules, visiting hours, photo capture?
6. Which ADT feeds are needed (LIS/PACS/third-party HL7)? ABDM HIP care-context linking at admission?
7. Housekeeping SLA per ward type; is supervisor inspection required before "available"?
8. ICU admission approval flow (intensivist acceptance) and bed hold TTLs?
9. Belongings/valuables handling process (security safe? receipt format)?
10. Privacy on ward TVs: full name, initials, or bed-only?
11. Readmission and ALOS reporting definitions used for NABH indicators?
12. Multi-branch: can a patient be admitted in two branches concurrently (group MPI rule)?
