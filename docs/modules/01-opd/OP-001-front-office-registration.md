# OP-001 — Front Office & Registration (Patient MPI, UHID, ABHA, Appointments, Walk-in, Staff/Doctor Schedule)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                    |
| Module ID       | OP-001                                                                                                                                                                                                                                                                                                                                                          |
| Phase           | 1                                                                                                                                                                                                                                                                                                                                                               |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                              |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                            |
| Depends on      | EN-007 (RBAC/users), EN-027 (master data), EN-011 (ABHA M1), EN-006 (queue engine), EN-009 (SMS/WhatsApp), EN-013 (barcode/QR), EN-018 (TV boards), EN-028 (consent), EN-041 (multi-branch MPI), NC-001 (cash counter), EN-010 (payment gateway), EN-037 (notifications), EN-038 (approval engine)                                                              |
| Feature flag    | `module.front_office.enabled` (sub-flags: `front_office.abha`, `front_office.aadhaar_ekyc`, `front_office.online_booking`, `front_office.kiosk`)                                                                                                                                                                                                                |
| Primary roles   | Receptionist / Front Office (24), Call Centre Agent (25), Cashier (26), Branch Admin (3)                                                                                                                                                                                                                                                                        |
| Secondary roles | Doctor (view schedule/queue), Nurse OPD (queue), Hospital Admin (config), MRD (merge/dedupe), Patient (self-booking, kiosk), Auditor                                                                                                                                                                                                                            |
| Regulatory      | ABDM V3 (ABHA creation/verification, HIP), DPDP Act 2023 + DPDP Rules 2025 (consent, notice, minors), Aadhaar Act (e-KYC only via authorised AUA/KUA, no Aadhaar number stored in clear), TRAI DLT (SMS templates), NABH 5th ed. AAC/PRE (registration, patient identification with 2 identifiers), Clinical Establishments Act (registers), IT Act (photo/PHI) |

## 1. Purpose

OP-001 is the entry point of every patient journey: it owns the enterprise Master Patient Index (MPI) with UHID, ABHA linkage, demographic capture, duplicate control, appointment scheduling for doctors and service rooms, walk-in registration, check-in and token issue (via EN-006), and staff/doctor schedule publishing. It must let a receptionist register a new patient in under 60 seconds and re-register a returning patient in under 15 seconds, on desktop or kiosk, at 5000+ OP visits/day across branches sharing one MPI.

## 2. Users & Jobs-to-be-done

- **Receptionist** (desktop, all day): register new/returning patients, verify identity (OTP/Aadhaar e-KYC/ABHA), take photo, book/reschedule/cancel appointments, check-in, issue token, print UHID card/OP slip, collect consultation fee (hands off to NC-001/OP-005), answer enquiries (doctor availability, bed status read-only, bill estimate via RC-008).
- **Call centre agent** (desktop headset): book/confirm/reschedule appointments by phone, IVR callback lists (EN-033), waitlist calls, no-show follow-up.
- **Patient** (phone PWA/kiosk/website widget): self-register (QR poster), self-book, pre-fill demographics, self check-in, ABHA scan & share.
- **Doctor** (desktop/tablet/phone): publish weekly OPD slots, block leave, see own appointment book and live queue.
- **Branch/Hospital Admin** (desktop): configure UHID series, appointment rules, consultation types, counters, kiosks; approve patient merges.
- **MRD officer**: dedupe queue, merge/unmerge, corrections with reason.
- **Nurse OPD / Vitals** (tablet): sees checked-in queue (OP-007).

## 3. Core Workflows

### 3.1 New patient registration (walk-in)

1. **Receptionist** presses `F2` "New Patient" → System opens registration form pre-focused on Mobile.
2. Enters mobile → System runs **live duplicate search** (mobile exact, name+DOB fuzzy via `pg_trgm`, ABHA, Aadhaar-hash) → shows candidate list with photo, age, last visit → receptionist picks existing (go to 3.2) or continues.
3. Captures mandatory fields: Full name (title, first, last), Gender, DOB or Age (age-only stored with `dob_is_estimated=true`), Mobile (E.164, country default +91), Address (state/district/PIN with pincode auto-fill), Emergency contact name+relation+phone (auto-capture: prompt "same as attendant?"), Preferred language (en/hi/ta/te/ml/kn/mr/bn), Patient category (General/Senior/Staff/Corporate/Scheme/MLC), Referral source (self/doctor/camp/website), Photo (webcam/tablet camera, cropped 300×300, S3), optional Aadhaar e-KYC / ABHA / govt ID type+last-4, blood group, allergies (structured, feeds patient banner), consent (DPDP notice + treatment/general consent e-sign via EN-028).
4. Optional **OTP verification** of mobile (`patient.mobile.verify`); hospital setting `registration.otp_required` (default: optional, mandatory for portal login).
5. **Save** (`Ctrl+S`) → System validates Zod schema, generates **UHID** from numbering series `UHID` (pattern default `{BR}{YY}{SEQ:7}`, non-gapless, check-digit Luhn optional), stores `patients` row + `patient_identifiers`, computes `search_vector`, writes audit → prints UHID card (PVC/thermal, QR = UHID) and issues welcome SMS/WhatsApp (DLT template) → Event `patient.registered`.
6. If a doctor is selected in the same screen (`F4` "Register + Consult") → creates visit (3.4) and token in one transaction.
   **Exceptions:** duplicate suspected with score ≥ 0.85 → hard-stop requiring "Create anyway (reason)" → flagged in MRD dedupe queue. Offline (kiosk/PWA): queue registration locally with temp ID `TMP-<uuid>`; on sync, real UHID assigned and label reprinted.

### 3.2 Returning patient (search & update)

1. `F3` search box accepts UHID, mobile, name, ABHA, appointment no, barcode scan (UHID card) or biometric (EN-020) → results < 300 ms across group MPI (EN-041) with branch tag.
2. Select → banner shows photo, UHID, age/sex, allergies, alerts (MLC, VIP, defaulter/credit block, isolation), last visit → `F5` "Edit" allows demographic update; changes to name/DOB/gender/mobile need reason and are versioned (`patient_demographic_history`) → Event `patient.updated`.
3. Family linking: link relatives (`patient_relationships`, relation enum) for family accounts and dependants (child under 18 → guardian mandatory per DPDP Rules 2025 verifiable parental consent).

### 3.3 ABHA link / create (EN-011 M1)

1. `Link ABHA` → options: (a) scan ABHA QR (Scan & Share, ABDM V3 `/v3/hip/patient/share`) (b) enter ABHA number/address + OTP (Aadhaar/mobile) (c) create ABHA via Aadhaar OTP or DL.
2. System calls EN-011 → verifies → stores `abha_number`, `abha_address`, KYC-verified name/DOB/gender → mismatches vs local record shown side-by-side; receptionist chooses which to keep (audit).
3. Health-locker consent request (M2 HIP link token) queued → Event `patient.abha.linked`. Fallback: ABDM gateway down → mark "ABHA pending", retry job.

### 3.4 Appointment booking (doctor / service room)

1. **Agent/Receptionist/Patient** selects Specialty → Doctor (or "first available") → Date → System shows slots computed from `doctor_schedule_templates` + `schedule_exceptions` + existing bookings + slot capacity (`max_per_slot`, overbook allowance) + consultation type (new/follow-up/procedure/tele/video) + booking channel quotas (online %, walk-in reserve).
2. Selects slot → System validates: not in past, doctor not blocked, patient not already booked same doctor same day (unless allowed), follow-up validity window (free follow-up ≤ N days from last paid consult, from RC-003 tariff), advance payment required? (online bookings: collect via EN-010; refundable per policy).
3. Confirms → `appointments` row status `booked`, appointment no series `APPT` → confirmation SMS/WhatsApp with date/time, doctor, location, prep instructions, "add to calendar" link, cancel/reschedule deep link → Event `appointment.booked`.
4. **Reschedule**: choose new slot → old slot released, history retained (`rescheduled_from_id`) → notify → Event `appointment.rescheduled`.
5. **Cancel**: reason (enum + text) → slot released → if paid: refund trigger to OP-005 (`billing.refund.requested`, policy: full ≥ 24 h, else per config) → notify → waitlist auto-offer to next waitlisted patient (SMS with 30-min accept link) → Event `appointment.cancelled`.
6. Reminders: T-24h and T-2h WhatsApp/SMS with confirm/cancel buttons; no response + no-show → status `no_show` after grace (config 30 min) → PE-002 follow-up list.
7. **Doctor leave/emergency block**: doctor/HOD blocks day → System lists affected appointments → bulk reschedule wizard (same doctor next slot / alternate doctor same specialty) → notifications.

### 3.5 Check-in, visit creation & token

1. Patient arrives → receptionist/kiosk scans appointment QR / UHID / enters mobile → System validates appointment window (early/late tolerance) → creates **OP visit** (`op_visits`, series `OP_VISIT`, type new/follow-up/free-review) → checks payment: consultation fee posted to bill (OP-005) and collected at counter (NC-001) unless credit/corporate/scheme (EN-002/RC-007) or "pay after consult" policy → token requested from EN-006 (doctor queue, priority: appointment > walk-in; senior citizens/disabled/pregnant/staff priority flags; emergency pin-to-top) → prints OP slip (token, doctor, room, est. wait, QR) → Event `visit.checked_in`, `queue.token.issued`.
2. Vitals routing: if doctor/dept configured `vitals_required` → token first enters vitals room queue (OP-007), then auto-transfers to doctor queue.
3. Walk-in without appointment: 3.1/3.2 + immediate visit; queued after scheduled patients within the current slot block (configurable "walk-in interleave ratio").
4. Live queue controls (receptionist): hold, skip, re-queue, transfer to another doctor (with fee difference), mark left; WebSocket pushes to doctor dashboard (OP-002), TV (EN-018), patient app (OP-020).
5. Cancel visit before consult → reverse fee (OP-005 cancel/refund workflow) → token voided.

### 3.6 Doctor / staff schedule configuration

1. Admin/HOD/Doctor: define weekly template per doctor per branch per room: day, start–end, slot length, capacity, consult types allowed, online booking window (e.g. 30 days), buffer, max walk-ins → publish with effective date → Event `schedule.published`.
2. Exceptions: leave, conference, extra clinic, holiday calendar (hospital-wide list) → conflict check with existing bookings.
3. Staff management (creation of users/roles) is EN-007; OP-001 provides the "Doctor OPD profile" (fees by consult type, room, specialties, languages, tele-enabled, photo/bio for website EN-012, HPR ID).

### 3.7 Enquiry desk & misc

- Doctor availability lookup, bed availability (read-only from IP-001), tariff enquiry/bill estimate (RC-008), referral information entry (OP-021), lost UHID card reprint (fee optional), duplicate UHID merge request → MRD.

### 3.8 Merge / unmerge (MRD)

1. MRD reviews dedupe queue (auto-flagged pairs) → compares side by side → **Merge** keeps survivor UHID, marks victim `merged_into_id`, re-points visits/bills/orders via event fan-out (each module reacts to `patient.merged`) → victim UHID becomes alias (searchable, redirect). Unmerge within 30 days if wrong (approval by MRD head).

## 4. Data Model (schema `patient` unless stated)

- **patients**: id, hospital_id (group MPI: `mpi_group_id` for EN-041), uhid (unique per hospital), title, first_name, middle_name, last_name, full_name (generated), gender enum(male/female/other/unknown), dob date, dob_is_estimated bool, age_years/months/days (computed), blood_group enum, marital_status, mobile (E.164), mobile_verified_at, alt_phone, email citext, whatsapp_opt_in, preferred_language, nationality, religion?, occupation, id_type enum(aadhaar/pan/passport/voter/dl/other), id_last4, aadhaar_hash (SHA-256+salt, never clear), photo_file_id, address_line1/2, city, district, state, country, pincode, geo (point?), patient_category enum, referral_source, referred_by_doctor_id, is_vip, is_deceased, deceased_at, merged_into_id, status enum(active/inactive/merged/blocked), search_vector tsvector, dedupe_fingerprint text, created_at… version. Indexes: (hospital_id, uhid) unique; GIN trgm on full_name, mobile; (hospital_id, mobile); (hospital_id, dob, gender). RLS on hospital_id / mpi group.
- **patient_identifiers**: patient_id, type enum(abha_number/abha_address/national_id/passport/insurance_member/corporate_emp/scheme_card/old_mrn/legacy_uhid), value (encrypted for national IDs), verified_at, source, unique(hospital_id, type, value).
- **patient_contacts**: patient_id, kind enum(emergency/attendant/guardian/nok), name, relation enum, phone, is_primary.
- **patient_relationships**: patient_id, related_patient_id, relation, consent_ref (family portal).
- **patient_alerts**: patient_id, type enum(allergy/mlc/vip/credit_block/isolation/fall_risk/custom), text, severity, active_from/to, created_by. Allergies structured in `clinical.allergies` (EN-029) — alerts table just mirrors for banner speed.
- **patient_consents** → EN-028 (`consent_ledger`); front office stores `consent_id` refs.
- **patient_demographic_history**: patient_id, changed_fields jsonb, before/after, reason, changed_by, changed_at.
- **patient_dedupe_candidates**: patient_a_id, patient_b_id, score numeric(4,3), rule_hits jsonb, status enum(open/merged/not_duplicate), reviewed_by/at.
- **patient_merges**: survivor_id, victim_id, merged_by, merged_at, unmerged_at?, details jsonb.
- **schema `clinical`**: **op_visits**: id, hospital_id, branch_id, visit_no, patient_id, appointment_id?, doctor_id, department_id, visit_type enum(new/follow_up/free_review/referral/tele/emergency_opd/health_checkup), consult_type_id, payer_type enum(self/insurance/corporate/scheme/staff), payer_ref_id, status enum(registered/waiting_vitals/waiting_doctor/in_consult/consult_done/closed/cancelled/no_show), token_no, queue_id, checked_in_at, consult_started_at, consult_ended_at, closed_at, cancel_reason, source_channel enum(counter/kiosk/online/app/call_centre/ivr/camp), notes. Index (hospital_id, branch_id, doctor_id, checked_in_at desc), (hospital_id, patient_id, checked_in_at desc). Partition by month optional (>2M rows/yr).
- **appointments**: id, hospital_id, branch_id, appointment_no, patient_id (nullable for unregistered lead: name+mobile), doctor_id, resource_id? (room/USG/ECG), department_id, slot_start, slot_end, consult_type_id, channel, status enum(booked/confirmed/checked_in/completed/cancelled/no_show/rescheduled/waitlisted), advance_receipt_id, cancel_reason, rescheduled_from_id, reminder_sent_at[], booked_by, notes, idempotency_key. Unique partial (doctor_id, slot_start, patient_id) where status in (booked, confirmed). Exclusion via `btree_gist` on (doctor_id, tstzrange(slot_start,slot_end)) when capacity=1.
- **appointment_waitlist**: doctor_id, date, patient_id, priority, offered_at, expires_at, status.
- **doctor_schedule_templates**: doctor_id, branch_id, room_id, weekday, start_time, end_time, slot_minutes, capacity_per_slot, overbook_allowance, consult_types jsonb, online_quota_pct, walkin_reserve, effective_from/to, version, published_at.
- **schedule_exceptions**: doctor_id, date range, kind enum(leave/holiday/extra_clinic/blocked/reduced), reason, replacement_doctor_id?, approved_by.
- **doctor_opd_profiles**: user_id, specialties[], hpr_id, room defaults, fees by consult_type (refs RC-003 tariff), follow_up_days, languages, tele_enabled, bio, website_visible.
- **consult_types**: code (NEW/FU/FREE_REVIEW/PROC/TELE/SECOND_OPINION), fee tariff link, validity rules.
- **registration_counters** (front-office counters), **kiosk_devices** (device token, location, printer).
- **holiday_calendar** (hospital/branch, date, name).
- Numbering: `UHID`, `OP_VISIT`, `APPT` per hospital/branch/FY.

## 5. Business Rules & Validations

- Two-identifier rule (NABH): every printed label/slip shows Name + UHID (+DOB or age/sex); no PHI beyond that on token display boards (first name + masked surname / token only, configurable).
- Mobile may be shared across family (max N=10 per mobile configurable; warn beyond). One mobile-verified primary per portal login.
- Age computed live from DOB; if age-only recorded, DOB estimated as 1-Jan-(year) with flag; neonates: age in days.
- Aadhaar: e-KYC only via licensed AUA/KUA (EN-011/partner); store only hash + last 4 + KYC-verified flag; never OCR-store full number; Aadhaar not mandatory for treatment (Supreme Court judgement) — UI text must say "optional".
- DPDP: privacy notice shown/printed in patient's language at first registration; consent purpose codes (treatment, billing, communication/marketing separate opt-in, research); consent withdrawable from portal; minors → verifiable guardian consent; data retention as per NC-003 policy.
- Duplicate scoring: exact ABHA/Aadhaar-hash = 1.0; mobile+DOB = 0.9; name trigram ≥0.6 + gender + DOB±1y = 0.85; ≥0.85 blocks without override permission `patient.record.create_override`.
- Appointment: cannot book beyond `online_booking_window_days`; slot capacity enforced with row lock; overbook only by users with `appointment.overbook`; same patient same doctor same day duplicate blocked; free follow-up validity from tariff (default 7 days, 1 visit); appointment advance payment refund policy configurable (default 100 % if cancelled ≥ 24 h, else 0, always full if hospital cancels).
- Late arrival > grace → moved to walk-in order (config), no-show marked automatically at clinic end.
- Token priority weights (EN-006): emergency 100, appointment on time 50, senior/disabled/pregnant +20, staff +10, walk-in 0; FIFO within weight.
- Visit closes automatically 24 h after consult if not closed; a visit cannot be cancelled after consult started (use billing reversal path).
- Merge only by MRD role with 2-step confirm; victim UHID never reissued; all child records re-pointed by consumers within 5 min (SLA monitored).
- UHID series non-gapless; appointment no per branch/FY; visit no per branch/FY.
- Immutable: created audit; demographic edits versioned; deletion prohibited (soft `inactive` only for test entries within 24 h by admin).
- Photo mandatory configurable per hospital (default: mandatory for new registrations except emergency).
- Corporate/scheme category requires valid payer ref (employee id / card no) verified against EN-002/RC-007 payer master with validity dates.

## 6. API Surface (`/api/v1`)

| Method   | Path                                                      | Purpose                                     | Permission                   | Idem | Pag    |
| -------- | --------------------------------------------------------- | ------------------------------------------- | ---------------------------- | ---- | ------ |
| POST     | /patients                                                 | register patient                            | patient.record.create        | Y    | –      |
| GET      | /patients?q=&mobile=&uhid=&abha=                          | search (MPI, group-aware)                   | patient.record.list          | –    | cursor |
| GET      | /patients/{id}                                            | full record + banner                        | patient.record.read          | –    | –      |
| PATCH    | /patients/{id}                                            | update demographics (reason)                | patient.record.update        | Y    | –      |
| GET      | /patients/{id}/history                                    | demographic history                         | patient.record.read          | –    | cursor |
| POST     | /patients/{id}/photo                                      | upload photo (presigned)                    | patient.record.update        | –    | –      |
| POST     | /patients/{id}/otp/send, /otp/verify                      | mobile verification                         | patient.mobile.verify        | Y    | –      |
| POST     | /patients/{id}/abha/link, /abha/create                    | via EN-011                                  | patient.abha.link            | Y    | –      |
| GET/POST | /patients/{id}/contacts, /relationships, /alerts          | manage                                      | patient.record.update        | Y    | –      |
| GET      | /patients/dedupe                                          | dedupe queue                                | patient.merge.review         | –    | cursor |
| POST     | /patients/merge, /patients/unmerge                        | merge/unmerge                               | patient.merge.execute        | Y    | –      |
| GET      | /doctors/{id}/slots?date=                                 | available slots                             | appointment.slot.read        | –    | –      |
| POST     | /appointments                                             | book                                        | appointment.create           | Y    | –      |
| GET      | /appointments?doctor=&date=&status=                       | list                                        | appointment.list             | –    | cursor |
| PATCH    | /appointments/{id}/reschedule, /cancel, /confirm          | lifecycle                                   | appointment.update / .cancel | Y    | –      |
| POST     | /appointments/{id}/check-in                               | check-in → visit + token                    | visit.create                 | Y    | –      |
| POST     | /visits                                                   | walk-in visit                               | visit.create                 | Y    | –      |
| GET      | /visits?doctor=&date=&status=                             | queue/list                                  | visit.list                   | –    | cursor |
| PATCH    | /visits/{id}/cancel, /transfer, /close                    | lifecycle                                   | visit.update                 | Y    | –      |
| GET/PUT  | /doctors/{id}/schedule-templates, /schedule-exceptions    | schedule config                             | schedule.configure           | Y    | –      |
| POST     | /doctors/{id}/schedule/publish                            | publish version                             | schedule.publish             | Y    | –      |
| GET      | /public/doctors, /public/slots, POST /public/appointments | website/app booking (rate-limited, captcha) | (public token)               | Y    | –      |
| POST     | /kiosk/checkin                                            | kiosk self check-in                         | kiosk.checkin (device)       | Y    | –      |
| GET      | /front-office/dashboard                                   | counters KPIs read model                    | frontoffice.dashboard.read   | –    | –      |

## 7. Domain Events (outbox)

- `patient.registered` {patient_id, uhid, branch_id, channel} → OP-005 (account), EN-009 (welcome), EN-011 (ABHA pending), NC-003 (MRD file), analytics.
- `patient.updated` {patient_id, changed_fields} → all modules cache invalidation, portal.
- `patient.merged` {survivor_id, victim_id} → every module owning patient_id FKs re-points; NC-003.
- `patient.abha.linked` → EN-011 M2 care-context linking.
- `appointment.booked|rescheduled|cancelled|no_show|confirmed` → EN-009 reminders, PE-002, OP-005 refund on paid cancel, analytics.
- `visit.checked_in` {visit_id, patient_id, doctor_id, token_no} → OP-007 (vitals queue), OP-002 (doctor queue), OP-005 (post consult fee), EN-018 (TV).
- `visit.cancelled` / `visit.closed`.
- `schedule.published` {doctor_id, version} → website (EN-012), portal cache.

## 8. Screens

- **Registration desk** (desktop; tablet fallback): 3-pane — search rail (F3), form (F2 new), right rail (today's counters: registered, checked-in, waiting, collections). Hotkeys: F2 new, F3 search, F4 register+consult, F5 edit, Ctrl+S save, Ctrl+P print card, Alt+A ABHA, Alt+O OTP. Real-time: duplicate hints as you type; printer status. Empty: "No patient found — press F2". Error: RFC 9457 messages inline per field.
- **Appointment book** (desktop): calendar (day/week) per doctor/room; drag-to-reschedule; colour by status; slot capacity meter; waitlist drawer; bulk reschedule wizard. Hotkeys: N new, R reschedule, C cancel, arrow keys navigate slots. Real-time via socket (`appointments:<doctor>:<date>`).
- **Check-in / Queue console** (desktop): today's arrivals, scan-to-check-in field always focused, queue per doctor with hold/skip/transfer; token print. Realtime.
- **Doctor schedule config** (desktop): weekly grid editor, exceptions calendar, publish diff preview.
- **Patient 360 mini-view** (desktop/tablet): banner, identifiers, contacts, consents, visits list, quick actions.
- **Dedupe/Merge** (desktop, MRD): side-by-side compare, field-level pick.
- **Kiosk self-service** (kiosk 1080p touch): language selector, mobile/OTP or ABHA QR/UHID card scan → self-register (minimal) / check-in → prints token; offline: shows "please visit counter" after 10 s. Auto-reset 60 s idle.
- **Patient self-booking** (phone PWA/web widget EN-012): doctor list, slots, pay advance, manage appointments.
- **Front-office dashboard** (desktop/TV): footfall by hour, waiting time by doctor, no-show %, ABHA %.
  Accessibility: WCAG 2.2 AA, all forms keyboard-navigable; high-contrast; large tap targets on kiosk.

## 9. Integrations

- EN-011 ABDM V3 (ABHA create/verify/scan-share, HFR/HPR ids); EN-020 biometric identity (optional); EN-009 SMS/WhatsApp (DLT-registered templates: welcome, appointment confirm/reminder/cancel, token, waitlist offer); EN-010 payment gateway (online advance); EN-013 barcode (UHID card QR, appointment QR, wristband hook for OP-006); EN-005 printers (PVC card, thermal slip); EN-006 queue; EN-018 TV; EN-033 IVR; EN-034 kiosk; EN-012 website; PIN-code API (India Post dataset seeded offline); Aadhaar e-KYC via AUA/KUA partner (config, market); insurance card OCR (AI-003 later). Retries via integration hub with DLQ; fallbacks: manual entry when ABDM/OTP down (flag `pending_verification`).

## 10. Reports & Analytics

- Daily registration register (new/revisit by branch/counter/user), footfall by hour/specialty/doctor, appointment fill rate, no-show rate, average wait (check-in→consult), ABHA linkage %, channel mix (counter/kiosk/online/app/IVR), demographic mix (age/gender/district), referral source conversion, duplicate rate, counter productivity, doctor schedule utilisation, cancelled/refunded appointments.
- Read models: `analytics.mv_daily_footfall`, `analytics.mv_appointment_kpis`, `analytics.mv_wait_times` refreshed every 5 min (pg_cron) — dashboards never hit `op_visits` live.

## 11. Notifications

- SMS/WhatsApp (DLT templates): welcome + UHID; appointment confirmation; reminders T-24h/T-2h with confirm/cancel; reschedule/cancel notice; waitlist offer; token issued (with live queue link); doctor delayed/leave notice; portal OTP. Email: appointment ICS. Push (portal/app): queue position updates. TV: token board (EN-018). In-app bell (EN-037): dedupe assigned to MRD, kiosk printer out of paper (IT).

## 12. Permissions

`patient.record.create|read|list|update|create_override|export|print`, `patient.mobile.verify`, `patient.abha.link`, `patient.alert.manage`, `patient.merge.review|execute`, `appointment.slot.read`, `appointment.create|list|update|cancel|overbook|waitlist`, `visit.create|list|update|cancel|transfer`, `schedule.configure|publish`, `frontoffice.dashboard.read`, `frontoffice.counter.configure`, `kiosk.checkin`.
Defaults: Receptionist: patient.* (except merge/export/override), appointment._, visit._; Call centre: appointment._, patient.read/list; MRD: patient.merge._, patient.record.update; HOD/Doctor: schedule.configure own; Branch Admin: schedule.publish, counters; Auditor: read/list.

## 13. Non-functional

- Volumes: 2000-bed group: 5000 OP visits/day, 15k searches/day, 3M patients in MPI, 300 concurrent front-office users, 200 kiosks/TVs; peaks 08:00–11:00 (40 % of day).
- p95: search < 200 ms, register < 400 ms (incl. numbering), slot query < 150 ms (cached per doctor/day in Redis, invalidated on booking events).
- Offline: kiosk & reception PWA queue registrations/check-ins in IndexedDB with temp IDs; sync conflict rule: server wins on demographics; token issued only online (offline shows manual token pad).
- Printing: PVC card (300 dpi), thermal 80 mm OP slip (ESC/POS), A5 registration form (PDF); print queue via EN-005.
- i18n: registration form labels + printed privacy notice in 8 languages; transliteration helper for names (Hindi/Tamil).
- Security: PHI reads audited (`READ_PHI` on 360 view), export permission for lists, rate limit public booking (10/min/IP + captcha), OTP brute-force lock.

## 14. Acceptance Criteria

1. Given a new walk-in with a mobile not in MPI, when receptionist saves the form with mandatory fields, then a UHID in the configured series is generated, `patient.registered` is emitted, and the card prints within 3 s.
2. Given an existing patient with same mobile+DOB, when registration is attempted, then a duplicate warning ≥ 0.85 blocks save unless `create_override` with reason; the pair appears in the dedupe queue.
3. Given a valid ABHA QR, when scanned, then demographics pre-fill, ABHA number/address stored in `patient_identifiers`, and mismatched fields are shown for choice.
4. Given a doctor template of 15-min slots capacity 2, when a third booking is attempted for a slot, then the API returns 409 unless the user has `appointment.overbook`.
5. Given two receptionists booking the last capacity in the same slot simultaneously, then exactly one succeeds (row lock / exclusion constraint) and the other gets 409.
6. Given a paid online appointment cancelled ≥ 24 h before, when cancelled, then `billing.refund.requested` is emitted with full amount and the patient is notified.
7. Given check-in of an appointment for a doctor whose department requires vitals, then a token is created in the vitals queue first and `visit.checked_in` carries `route=vitals`.
8. Given a walk-in arriving during a slot block, then the token orders after already-scheduled on-time patients per the interleave ratio.
9. Given a doctor blocks tomorrow, then all affected appointments are listed and bulk-rescheduled with notifications sent, and none remain `booked` on the blocked date.
10. Given the kiosk is offline, when a patient tries to check-in, then it shows the counter fallback message and no duplicate visit is created after reconnection.
11. Given MRD merges A into B, then B's timeline shows A's visits within 5 min, A's UHID search redirects to B, and unmerge within 30 days restores A.
12. Given a minor (age < 18) registration, then a guardian contact and guardian consent are mandatory before save.
13. Given a user without `patient.record.export`, when exporting the patient list, then 403 and an audit row are written.
14. Given demographics edited, then `patient_demographic_history` stores before/after with reason and actor; the banner reflects the change instantly on all open sessions (socket).
15. Given 5000 visits/day load test (k6), search p95 stays < 200 ms and check-in p95 < 400 ms.
16. Given a printed OP slip, then it contains name, UHID, age/sex, token, doctor, room, QR — and no Aadhaar/ABHA number.
17. Given privacy notice language = Tamil, then the printed consent/notice is in Tamil.

## 15. Enhancements / Later phases

- From VIMS sheet: multi-language registration (Tamil/Hindi/English) — Phase 1 partial (labels), full transliteration Phase 2; Aadhaar e-KYC instant verification (Phase 2, needs AUA/KUA); emergency contact auto-capture (Phase 1); insurance card OCR scan (AI-003, Phase 12); AI photo-match for return visits (AI, Phase 12, consent-based); geo-fenced auto check-in for regulars (OP-020 Phase 13).
- (market) QR poster self-registration & mobile queue tracking (SmartHospital) — Phase 1/10; reception "Cost estimation for care" (MocDoc) via RC-008; referral SMS to referring doctor on registration (Prodoc); patient barcode card (Prodoc) Phase 1; bed-status enquiry at front desk (Prodoc) read-only Phase 7; family accounts; loyalty (PE-005); IVR booking (EN-033); WhatsApp bot booking (AI-001).

## 16. Open Questions for the Hospital

1. UHID format (prefix per branch? year? check digit?) and whether legacy UHIDs must be preserved as aliases (migration via EN-036).
2. Is Aadhaar e-KYC licensed (AUA/KUA/Sub-AUA)? If not, offline Aadhaar QR/XML or skip?
3. Which fields are mandatory at registration (photo? address? email? emergency contact?) and different for emergency quick-reg?
4. Consultation fee collection: before consult (default) or after? Free follow-up window per doctor/department?
5. Appointment rules: slot lengths per specialty, online booking window, walk-in reserve %, overbook policy, advance amount for online booking and cancellation refund policy.
6. Do you want tokens per doctor or per department/room? Priority categories (senior citizens, staff, VIP)?
7. Multi-branch: single group MPI (shared UHID) or per-branch UHIDs with group linkage?
8. Registration charge (one-time/annual validity)? Card type (PVC/paper) and printer models?
9. SMS/WhatsApp sender IDs, DLT template IDs, languages for notifications.
10. Kiosk count/locations; biometric devices? IVR vendor?
11. Data retention and DPDP notice text approved by DPO; marketing consent capture policy.
12. Any state-specific registers (e.g. Clinical Establishment OP register format) to be printed?
