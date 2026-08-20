# OP-012 — Dialysis (OP) (Session scheduling, Machine assignment, Vitals monitoring, Consumables, Water quality, Billing)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Module ID       | OP-012                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Phase           | 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Priority        | P2 (P1 if hospital has a dialysis unit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Depends on      | OP-001 (patient, recurring appointments), OP-006 (day-care beds/emergency dialysis, ER), OP-007/IP-003 (shared `clinical.vitals`), OP-002 (nephrologist orders/Rx, dialysis prescription), OP-004 (labs: pre/post BUN for URR/Kt/V, Hb, K, viral markers), OP-005 (per-session billing, packages OP-023), EN-002 (pre-auth), RC-007 (PMJAY/PMNDP scheme packages), NC-006/NC-008 (dialyser/tubing/consumables, reuse), NC-020 (machine assets, PM, RO plant), EN-042 (IoT machine & water sensors), IP-022 (IP dialysis shares session model), IP-012 (infection control: HBsAg/HCV isolation machines), IP-007 (blood transfusion during HD), OP-011 (renal diet), OP-018 (tele follow-up), EN-009, EN-037, EN-018 (unit board), NC-013 (patient transport) |
| Feature flag    | `module.dialysis.enabled` (sub: `dialysis.iot`, `dialysis.reuse`, `dialysis.pd`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Primary roles   | Dialysis Technician (41), Nurse — Dialysis (17/41), Nephrologist (6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Secondary roles | Receptionist (24, recurring booking), Billing/TPA (27/28), Biomedical (48, machines/RO), Infection control nurse (21), Dietician (39), Ambulance/transport (52), Patient (portal schedule), Quality (54)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Regulatory      | NABH 5th ed. (dialysis unit standards: water quality AAMI/ISO 23500, reuse policy, isolation for HBV/HCV), Pradhan Mantri National Dialysis Programme (PMNDP) reporting, PMJAY HD package (RC-007), KDOQI adequacy (spKt/V ≥ 1.2, URR ≥ 65 %), ISO 23500-3 dialysis water (bacteria < 100 CFU/mL, endotoxin < 0.25 EU/mL; ultrapure < 0.1 CFU/mL & < 0.03 EU/mL), chemical analysis 6-monthly, BMW 2016 (used dialysers/tubing), CDSCO (dialysers reuse labelling), DPDP                                                                                                                                                                                                                                                                                     |

## 1. Purpose

OP-012 runs an outpatient/day-care haemodialysis unit: chronic patient registration with a standing dialysis prescription and recurring slot pattern (e.g. MWF morning), machine/chair assignment respecting isolation, pre-dialysis assessment against dry weight, intra-session vitals and machine parameters every 30 minutes with complication logging and nephrologist alerts, post-dialysis summary with actual UF and adequacy (URR/Kt/V), consumable and dialyser-reuse tracking, machine and RO water-quality logs, per-session/package/scheme billing and monthly unit reports.

## 2. Users & Jobs-to-be-done

- **Dialysis technician/nurse** (tablet at chair / desktop at station; 20–60 chairs, 2–4 shifts/day, 1 tech per 3–4 patients): start shift board, connect patient, record pre-weights, prime machine, log parameters q30 min (or auto via IoT), handle alarms/complications, disconnect, post-assessment, consumables, reuse log.
- **Nephrologist** (desktop/phone): review dialysis prescription, rounds during sessions, respond to complication alerts, adequacy review monthly, labs/erythropoietin/iron orders.
- **Receptionist**: register chronic patient, book recurring pattern, manage waitlist, emergency slots.
- **Biomedical**: machine service due, disinfection cycles, RO plant readings, water culture/endotoxin results.
- **Billing/TPA**: per-session invoice, package/scheme (PMJAY) claims, consumables.

## 3. Core Workflows

### 3.1 Registration & scheduling

1. Nephrologist enrols patient in **dialysis programme**: modality (HD/HDF/SLED/PD-CAPD/APD), aetiology (ICD-10 N18.x), vascular access (AVF/AVG/tunnelled or non-tunnelled catheter, site, creation date), dry weight, viral status (HBsAg/HCV/HIV with date; re-test schedule 6-monthly), blood group, **dialysis prescription** (frequency/week, duration hrs, dialyser type/size, blood flow Qb, dialysate flow Qd, dialysate composition K/Ca/Na/HCO3, temperature, UF target rule, heparin regimen (bolus/infusion/heparin-free), EPO/iron plan) — versioned.
2. Receptionist/coordinator books **recurring pattern** (days of week × shift) → system generates sessions 4–8 weeks ahead, assigns **machine/chair** by availability and isolation zone (HBsAg+ machines dedicated; HCV per policy) → conflicts/waitlist; patient gets schedule on portal/WhatsApp; transport request (NC-013) optional.
3. Emergency/acute dialysis (ER/ICU/IP request): priority slot from reserved capacity or bump policy; IP-022 handles bedside CRRT/SLED.
4. Reschedule/holiday, missed sessions → recall call; long-term missed → nephrologist alert.

### 3.2 Pre-dialysis

1. Patient check-in (scan) → chair assigned board → nurse records: pre-weight (vs dry weight → interdialytic weight gain, IDWG %; > 4 % flag), BP sitting/standing, pulse, temp, SpO2, access inspection (thrill/bruit, redness, bleeding, catheter exit site), symptoms (dyspnoea/oedema), consent (first session/annual, EN-028), machine disinfection verified, dialyser (new or reuse # with volume test result), lines/needle sizes → system computes **UF goal** = pre-weight − dry weight (+ intake) capped by max UF rate (13 mL/kg/h default) → flags concerns (fever, hypotension, hyperkalaemia symptoms, access problem) → nephrologist alert if red.

### 3.3 Intra-session monitoring

1. Connect time; parameters q30 min (configurable q15/q60): BP, pulse, temp, Qb, Qd, arterial/venous pressure, TMP, UF rate, cumulative UF, conductivity, dialysate temp, heparin given → auto-plotted trends; IoT: machines (Fresenius 4008/5008/6008, Nikkiso, B.Braun Dialog+, Nipro) push data via serial/HL7/proprietary gateway (EN-042) → auto-fill with device stamp; alarms mirrored.
2. **Complications**: hypotension (SBP < 90 or drop > 30), cramps, nausea/vomiting, chest pain, fever/rigors (dialyser reaction/sepsis), bleeding, access issue, clotting, air embolism (never event), arrhythmia → intervention log (saline bolus, UF reduce, stop, O2, meds) → **alert nephrologist** (push/call escalation EN-037) for red events; medications given during HD (EPO, iron sucrose, antibiotics) recorded (MAR-lite → billing).
3. Blood transfusion during HD via IP-007 issue.

### 3.4 Post-dialysis

1. Disconnect time; post-weight, BP, pulse; **actual UF** (machine) vs goal; access haemostasis time/complications; dialyser reuse: rinse/reprocess (if `dialysis.reuse`: reprocessing log, total cell volume ≥ 80 % rule, max reuse count, patient-specific labelling); machine disinfection cycle started; **adequacy**: URR = (pre−post BUN)/pre×100 when labs ordered; spKt/V (Daugirdas II) auto-calc; monthly adequacy review list.
2. Session summary PDF (patient copy optional), education notes (fluid/diet, access care), next session shown → Event `dialysis.session.completed`.
3. Billing: per-session charge (payer tariff), consumables (dialyser, tubing, needles, heparin, saline, EPO/iron), doctor fee, package (e.g. 12 sessions/month prepaid, OP-023) auto-consumed, PMJAY/state scheme package codes (RC-007), pre-auth (EN-002) — auto-post on completion (OP-005).

### 3.5 Machine & water quality

- Machine master (asset NC-020): id, model, serial, install, hours run, last/next service, disinfection log per session (heat/citric/chemical), breakdown → auto-reassign patients; utilisation dashboard (sessions/machine/day, downtime).
- **Water quality log**: RO plant readings per shift (product water conductivity, hardness, chlorine/chloramine, pressure), monthly bacteriology (dialysate & water CFU), quarterly endotoxin (LAL), 6-monthly chemical analysis (AAMI/ISO 23500 limits) → out-of-limit → alert biomedical + medical director; sensor feed via EN-042.

### 3.6 Exceptions

- Patient arrives with fever/K > 6.5 → nephrologist decision; session abort with reason; machine failure mid-session → transfer to spare machine (session continues, machine change logged); offline: chair tablet caches session, parameters queue and sync (timestamps preserved).

## 4. Data Model (schema `specialty`)

- **dialysis_programs**: id, hospital_id, branch_id, patient_id, modality enum(hd/hdf/sled/pd_capd/pd_apd), aetiology_icd10, start_date, status enum(active/on_hold/transferred/transplanted/expired/discontinued), dry_weight_kg, dry_weight_updated_at, viral_status jsonb ({hbsag, hcv, hiv, tested_at}), isolation_zone enum(general/hbv/hcv), blood_group, nephrologist_id, transport_needed, notes.
- **vascular_accesses**: id, program_id, type enum(avf/avg/tunnelled_cath/non_tunnelled_cath/pd_catheter), site, side, created_at, created_by_surgeon, status enum(maturing/active/failed/removed), complications jsonb[], last_assessed.
- **dialysis_prescriptions** (versioned): id, program_id, version, frequency_per_week, duration_min, dialyser_id (item), qb, qd, dialysate jsonb (k, ca, na, hco3, temp), uf_max_rate, heparin jsonb, anticoag_mode, epo_plan jsonb, iron_plan jsonb, target_ktv, effective_from, prescribed_by.
- **dialysis_machines**: id, hospital_id, branch_id, asset_id (NC-020), code, model, serial, zone enum, status enum(available/in_use/disinfecting/maintenance/breakdown), hours_run, last_service_at, next_service_due, last_disinfection jsonb.
- **dialysis_slots** / **dialysis_sessions**: id, hospital_id, branch_id, program_id, patient_id, scheduled_at, shift, machine_id, chair_no, type enum(chronic/acute/emergency/pd_review), status enum(scheduled/checked_in/on_machine/completed/aborted/no_show/cancelled), pre jsonb (weight, bp, pulse, temp, spo2, access_check, symptoms, uf_goal), connect_at, disconnect_at, post jsonb (weight, bp, actual_uf, haemostasis_min), dialyser_use enum(new/reuse), reuse_no, prescription_version, complications jsonb[], meds_given jsonb[], urr, ktv, adequacy_labs jsonb, summary_doc_id, technician_id, nurse_id, billed_bill_id?, package_id?, transport_trip_id?; index (hospital_id, branch_id, scheduled_at), (program_id, scheduled_at desc); exclusion (machine_id, tstzrange) via btree_gist.
- **dialysis_observations** (partitioned monthly): id, session_id, at, bp_sys/dia, pulse, temp, qb, qd, ap, vp, tmp, uf_rate, uf_cum, conductivity, dialysate_temp, heparin_ml, source enum(manual/iot), device_id, alarms jsonb.
- **dialyser_reuse_log**: id, program_id, dialyser_serial/label, item_id, use_no, reprocessed_at, tcv_pct, integrity_ok, chemical, reprocessed_by, discarded_at, reason.
- **water_quality_logs**: id, hospital_id, branch_id, at, kind enum(shift_reading/bacteriology/endotoxin/chemical), values jsonb, within_limits bool, recorded_by, lab_report_ref, action.
- **dialysis_recurrences**: program_id, days_of_week int[], shift, machine_pref, valid_from/to; generation cursor.

## 5. Business Rules & Validations

- Isolation: HBsAg+ patients only on HBV zone machines (hard block); HCV per hospital policy (default dedicated); viral markers older than 6 months → warning & re-test order prompt; new/transfer-in patient must have markers before first chronic session.
- UF goal ≤ (pre − dry weight) and UF rate ≤ 13 mL/kg/h (configurable) → override with nephrologist reason; IDWG > 4 % or > 3 kg → counselling flag (dietician OP-011).
- Session cannot start without: prescription active, consent on file, machine disinfection since last use logged, dialyser identity (new or reuse ≤ max uses & TCV ≥ 80 %), pre-vitals.
- Complication red list (SBP < 80, chest pain, air embolism, anaphylaxis, arrest) → nephrologist alert mandatory + escalation to on-call in 5 min; air embolism/wrong-patient dialyser → NC-015 incident (never event).
- Adequacy: spKt/V computed via Daugirdas II = −ln(R − 0.008t) + (4 − 3.5R)×UF/W; flag < 1.2 (thrice weekly) → prescription review task; URR < 65 % flagged.
- Reuse: patient-specific labelling (name/UHID/date/use #), max reuse count (default 8–10 per policy), never across patients; discarded per BMW.
- Water: shift readings mandatory before first session (block board until entered — config); bacteriology monthly, endotoxin quarterly, chemical 6-monthly reminders; breach → unit alert & log corrective action.
- Billing: session posts once (idempotent) on completion; aborted < 30 min → policy (no charge/consumables only); package consumption decrements sessions; scheme patients need pre-auth number before session (warn/block per payer).
- Numbering `HD_SESSION`; session record versioned; retention as clinical (≥ 10 y).

## 6. API Surface (`/api/v1/dialysis`)

| Method         | Path                                                                                                      | Purpose                                             | Permission                          | Idem | Pag    |
| -------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- | ---- | ------ |
| POST/GET/PATCH | /programs, /programs/{id}                                                                                 | enrol/read/update programme, accesses, viral status | dialysis.program.create/read/update | Y    | cursor |
| POST           | /programs/{id}/prescriptions                                                                              | new prescription version                            | dialysis.prescription.create        | Y    | –      |
| POST           | /programs/{id}/recurrence                                                                                 | set pattern → generate sessions                     | dialysis.schedule.manage            | Y    | –      |
| GET            | /board?date=&shift=                                                                                       | unit board (machines × slots) socket                | dialysis.session.read               | –    | –      |
| POST           | /sessions (acute/emergency), PATCH /sessions/{id} (reschedule/cancel/no-show)                             | schedule ops                                        | dialysis.schedule.manage            | Y    | –      |
| POST           | /sessions/{id}/check-in, /pre, /connect, /observations, /complications, /meds, /disconnect, /post, /abort | session lifecycle                                   | dialysis.session.record             | Y    | –      |
| POST           | /sessions/{id}/machine-change                                                                             | mid-session transfer                                | dialysis.session.record             | Y    | –      |
| GET            | /sessions/{id}, /programs/{id}/sessions                                                                   | history                                             | dialysis.session.read               | –    | cursor |
| POST           | /sessions/{id}/complete                                                                                   | summary, adequacy calc, billing post                | dialysis.session.complete           | Y    | –      |
| POST/GET       | /reuse-log                                                                                                | dialyser reprocessing                               | dialysis.reuse.record               | Y    | cursor |
| GET/POST/PATCH | /machines                                                                                                 | machine status/disinfection                         | dialysis.machine.manage             | Y    | –      |
| POST/GET       | /water-quality                                                                                            | logs                                                | dialysis.water.record/read          | Y    | cursor |
| POST           | /iot/observations                                                                                         | gateway push (device token)                         | integration.dialysis.ingest         | Y    | –      |
| GET            | /adequacy/review?month=                                                                                   | Kt/V/URR list                                       | dialysis.report.read                | –    | cursor |
| GET            | /stats/dashboard, /reports/monthly                                                                        | KPIs, PMNDP report                                  | dialysis.report.read                | –    | –      |

## 7. Domain Events (outbox)

- `dialysis.program.enrolled|updated`, `dialysis.session.scheduled|checked_in|started|completed|aborted|no_show` {session_id, patient_id, machine_id, uf, complications} → OP-005 billing, OP-023 package, RC-007 scheme, analytics, PE-002 recall, NC-013 transport.
- `dialysis.complication.red` {session_id, type} → EN-037 escalation to nephrologist/on-call; `dialysis.adequacy.low` → nephrologist task; `dialysis.water.out_of_limits` → biomedical/MS; `dialysis.machine.breakdown` → NC-020, auto reassign.
- Consumes: `lab.result.final` (BUN/K/Hb/viral), `asset.status.changed` (NC-020), `payment.received`, `preauth.approved`, `iot.reading` (EN-042), `blood.issued` (IP-007).

## 8. Screens (UI)

1. **Unit board** (desktop/TV dark theme): grid machines × shifts with patient chips (status colour, zone badge, alarms), drag to reassign; `N` acute session; real-time via socket; empty state per shift.
2. **Chair tablet — session sheet**: big pre/intra/post tabs, q30 timer with due badge, quick vitals keypad, IoT auto-fill indicator, complication quick buttons (hypotension/cramps/…), intervention log, `Ctrl+S` save; offline queue indicator.
3. **Nephrologist rounds view** (desktop/phone): all on-machine patients with trends & alerts; prescription editor; adequacy review list.
4. **Programme registry** (desktop): patient list with dry weight, access, viral status, next markers due, package balance, missed sessions.
5. **Scheduler** (desktop): recurring pattern editor, generated calendar, waitlist, holidays.
6. **Machine & water console** (desktop biomedical): machine cards (status, hours, service), disinfection log, water readings entry (`Ctrl+N` new), limits chart.
7. **Reuse log** (tablet): scan dialyser label, TCV entry, pass/fail.

## 9. Integrations

- Machine data: EN-042 gateway (serial RS-232/USB, HL7 v2 ORU or vendor protocols e.g. Fresenius "Therapy Data", Nikkiso, B.Braun Nexadia if licensed); water sensors (conductivity/chlorine) via Modbus/MQTT to EN-042; NC-020 assets/PM; OP-004 labs; OP-005/RC-007 billing & PMJAY TMS; EN-018 TV board; NC-013 transport; OP-018 tele follow-up; PMNDP monthly reporting export (CSV/portal format).
- Fallback: manual entry when IoT down; billing retried by outbox.

## 10. Reports & Analytics

- Daily/monthly dialysis register (PMNDP format), sessions per machine/shift, machine utilisation & downtime, complications rate per 100 sessions, hypotension rate, adequacy (% spKt/V ≥ 1.2, URR ≥ 65), IDWG trends, access complication/infection rate, viral marker compliance, water quality log/trends, reuse counts, consumables cost per session, revenue by payer/scheme, missed/no-show rate, patient outcomes (transplant/expired/transferred). Read models `analytics.dialysis_sessions_daily`, `analytics.dialysis_adequacy`.

## 11. Notifications

- Patient: schedule confirmation, D-1 reminder with fasting/med guidance, transport pickup, missed session recall, package balance low, viral test due.
- Staff: red complications (nephrologist push + call escalation), machine breakdown, water out-of-limit, adequacy review due, viral markers overdue, session unbilled > 24 h.
- TV: unit board.

## 12. Permissions (RBAC keys)

`dialysis.program.create|read|update`, `dialysis.prescription.create`, `dialysis.schedule.manage`, `dialysis.session.read|record|complete`, `dialysis.reuse.record`, `dialysis.machine.manage`, `dialysis.water.record|read`, `dialysis.report.read`, `dialysis.export`. Defaults: Technician — session.record/read, reuse, machine status; Dialysis nurse — same + complete; Nephrologist — all clinical + prescription; Receptionist — schedule; Biomedical — machine/water; Billing — read; ICN — program.read (viral status).

## 13. Non-functional

- Enterprise: 60 chairs × 3 shifts = 180 sessions/day/branch; observations 12–16 per session (≈ 3k rows/day/branch; IoT q1 min → 200k/day → partitioned); board p95 < 200 ms; observation write < 100 ms.
- Offline: chair tablets fully offline-capable for a session (IndexedDB), sync with server-side timestamp preservation, conflict = append (observations never overwrite).
- Print: session summary A4, dialyser reuse label (ZPL), monthly register.
- Safety: hard-blocks (isolation, missing disinfection) cannot be bypassed without nephrologist role + reason; audit all.

## 14. Acceptance Criteria

1. Given a patient with HBsAg positive, when scheduling onto a general-zone machine, then the system blocks with an isolation error and offers HBV-zone slots.
2. Given pre-weight 62 kg and dry weight 59 kg, then UF goal auto-fills 3.0 L, and if duration is 4 h and weight 62 kg the max UF check (13 mL/kg/h → 3.22 L) passes; entering 3.5 L requires nephrologist override.
3. Given IoT machine data arriving q1 min, then observations render on the chair sheet within 5 s with a device badge and are not editable manually (only annotated).
4. Given SBP falls from 130 to 85 during a session, when recorded, then a red hypotension complication is auto-suggested, the nephrologist receives a push within 5 s, and if unacknowledged in 5 min the on-call is escalated.
5. Given a dialyser reuse count at the configured max (10), when reuse is scanned, then start is blocked and a new dialyser must be recorded.
6. Given pre-BUN 90 and post-BUN 28 with t=4 h, UF 3 L, post-weight 59 kg, then URR = 68.9 % and spKt/V ≈ 1.4 are computed and shown; a Kt/V < 1.2 would create a review task.
7. Given a session completes, then exactly one billing post occurs (idempotent) with session + consumables + meds lines and package balance decrements by one.
8. Given shift water readings not entered, then the unit board shows a blocking banner (config) until entered; bacteriology > 100 CFU/mL logs out-of-limit and alerts biomedical.
9. Given a machine breakdown mid-session, when machine-change is recorded, then observations continue under the same session with machine history and NC-020 receives a breakdown ticket.
10. Given the tablet is offline for 40 min, then all q30 entries sync later with original timestamps and no duplicates.
11. Given a recurring MWF pattern, then sessions generate for 8 weeks and skip configured holidays; changing pattern regenerates only future unstarted sessions.
12. Given a technician without `dialysis.prescription.create`, when they attempt to change Qb in the prescription, then 403 (session-level parameter entry remains allowed).

## 15. Enhancements / Later phases

- Sheet row 8 enhancements: IoT machine vitals (pump RPM, conductivity) — Phase 8 flag `dialysis.iot`/EN-042; automated water quality sensors (EN-042, Phase 8/12); patient transport coordination (NC-013, Phase 9); telemedicine follow-up for chronic patients (OP-018, Phase 8); vascular access management module (Phase 8 core `vascular_accesses` + surveillance later); Kt/V adequacy auto-calculation (core).
- Costed proposal line 1567 (scheduling, machine assignment, vitals, consumables, water quality, billing) — core.
- (market) PCS Prodoc dialysis treatment record & inventory; SMART HMIS dialysis — covered. Later: PD (CAPD/APD) module (`dialysis.pd`), home HD remote monitoring, AI-005 hypotension prediction, transplant waitlist link (IP-019), EPO dosing protocol CDSS (EN-029).

## 16. Open Questions for the Hospital

1. Unit size: machines, shifts, chairs; isolation machines for HBV/HCV/HIV? Reuse policy (allowed? max uses)?
2. Machine makes/models and whether data ports/gateway licences exist; RO plant sensors?
3. Payers: PMJAY/state scheme HD packages, corporate/TPA rates, prepaid packages (sessions/month)?
4. Observation frequency (q15/q30/q60) and adequacy testing frequency (monthly?).
5. Do you provide patient transport? Should transport auto-book with sessions?
6. Water testing lab (in-house/outsourced) and limits standard (AAMI vs ISO 23500 ultrapure)?
7. Consent frequency (per session vs annual) and template language.
