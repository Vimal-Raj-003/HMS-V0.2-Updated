# OP-007 — Vital Room / Nursing Pre-Consult (Vitals, Device Integration, Abnormal Alerts, Queue Link)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Module ID       | OP-007                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Phase           | 2                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on      | OP-001 (visits/tokens), EN-006 (queue), OP-002 (doctor dashboard consumes vitals), EN-029 (abnormal/NEWS2/PEWS rules), EN-042 (device gateway; Phase 2 uses direct BLE/USB/serial adapters), EN-013 (barcode), EN-018 (TV boards), EN-037 (alerts), OP-006 (ER triage reuses vitals capture), IP-003 (ward vitals share the same `clinical.vitals` table), OP-014 (health check-up routing), OP-039 (OPD nursing procedures), EN-039 (assessment forms) |
| Feature flag    | `module.vitals_room.enabled` (sub: `vitals.devices`, `vitals.self_service_kiosk`)                                                                                                                                                                                                                                                                                                                                                                       |
| Primary roles   | Nurse — OPD/Vitals (16)                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Secondary roles | Doctor (views/acknowledges alerts), Receptionist (routing), Nurse supervisor (KPIs), Health check-up coordinator (OP-014), Biomedical (device calibration NC-020), Patient (self-service kiosk, later), Auditor                                                                                                                                                                                                                                         |
| Regulatory      | NABH 5th ed. COP.2/AAC.4 (initial nursing assessment, vitals before consult, pain as 5th vital sign, fall risk), IAP/WHO growth standards (paeds BMI/percentiles), NEWS2 (RCP) & PEWS for deterioration, ISO/IEEE 11073 & HL7 v2 ORU for device data, BIS/CDSCO device registration (BP monitors, pulse oximeters, glucometers), Metrology (calibration logs), DPDP                                                                                     |

## 1. Purpose

OP-007 standardises pre-consultation nursing capture: every checked-in OP patient (where the department requires it) passes through a vitals station where a nurse records BP, pulse, SpO2, temperature, respiratory rate, random/fasting glucose, height/weight/BMI (with paediatric percentiles), pain score, allergies verification, fall-risk and brief nursing screening — ideally auto-read from connected devices — with immediate abnormal-value alerts to the doctor and automatic transfer of the token to the doctor's queue. It feeds the doctor dashboard, patient timeline trends, and health-check-up routing.

## 2. Users & Jobs-to-be-done

- **Vitals nurse** (tablet on stand / desktop with devices; ~150–250 patients per station per day, ≤ 60 s per patient): call next token, verify identity by scan, capture vitals (device auto-fill), record allergies/pain/fall-risk, flag abnormal, forward to doctor queue; handle skipped/returned patients; re-check requests from doctors.
- **Doctor**: sees vitals on queue card & workspace, receives abnormal/critical alerts, requests repeat vitals.
- **Receptionist**: routes tokens (vitals-required departments), sees vitals-room queue length.
- **Nurse supervisor**: station load, throughput, abnormal rate, device status.
- **Health check-up coordinator**: vitals as first station of package routing (OP-014).
- **Biomedical engineer**: device registry/calibration status (NC-020).

## 3. Core Workflows

### 3.1 Queue intake

1. `visit.checked_in` with `route=vitals` (department/doctor config `vitals_required=true`, or all patients per hospital policy) → token appears in **vitals room queue** (per station group; multiple stations share one queue with "call next" locking) → TV shows "Vitals room: token 23 → Station 2".
2. Nurse presses `Space` "Call next" → announces via EN-018/EN-006 → patient arrives → **scan OP slip/UHID** (`F3`) or select card → identity check (name + UHID/age) → status `in_vitals`.
3. No-show after 2 calls → `skipped` (re-queue when patient appears; receptionist can re-route). Priority patients (ESI from ER, wheelchair, elderly) bubble per EN-006 weights.
4. Bypass: doctor may pull patient without vitals ("see without vitals", logged); nurse may forward with "not done – reason" (e.g. patient refused, tele-consult).

### 3.2 Vitals capture

1. Form (large controls, tablet-friendly): **BP** systolic/diastolic (position, arm, cuff size), **Pulse** (rate, rhythm regular/irregular), **SpO2** (room air/O2), **Temperature** (°C/°F, site), **RR**, **Glucose** (RBS/FBS/PPBS, mg/dL, glucometer), **Height/Weight** → BMI auto (adult categories WHO Asian cut-offs configurable; paeds: weight-for-age, height-for-age, BMI-for-age percentiles/z-scores IAP/WHO; head circumference < 2 y), **Waist** (optional), **Pain** NRS 0–10 (Wong-Baker faces for children), **LMP** (female 12–55, pregnancy status), **Allergy verification** (confirm existing list, add new → `allergy.recorded`), **Fall risk** quick screen (Morse short / STRATIFY? OPD: 3-question screen), **Smoking/alcohol** quick capture, **Nursing remarks**, **Chief complaint** free text (optional, helps doctor), specialty add-ons via EN-039 (e.g. visual acuity for ophthalmology, peak flow for pulmo, urine dipstick for ANC/OP-040, ECG done flag).
2. **Device auto-fill**: BP monitor / pulse oximeter / thermometer / glucometer / weighing scale / stadiometer / multi-parameter spot-check monitor (e.g. Mindray VS-9, Philips SureSigns, Omron HBP-1300, Contec) connected via **BLE (GATT Blood Pressure/Health Thermometer/Weight Scale/Pulse Oximeter profiles), USB-serial (ASCII/HL7), or Wi-Fi HL7 v2 ORU^R01 / IEEE 11073** through a local **device agent** (Electron/PWA WebBluetooth/WebSerial or EN-042 gateway) → reading appears in field with device icon + timestamp; nurse accepts (`Enter`) or overrides (reason); device id/serial stored; readings older than 2 min not auto-accepted; unpaired device → manual entry.
3. On save (`Ctrl+S`): EN-029 evaluates ranges by **age/sex/pregnancy** (adult, paeds age bands, neonate) → flags: normal / abnormal (amber) / critical (red) e.g. SBP ≥ 180 or ≤ 90, SpO2 < 92 %, HR > 120 or < 50, Temp ≥ 39.5, RBS < 70 or > 300, RR > 24, pain ≥ 7, BMI ≥ 30 → **NEWS2** (adults; O2 supplementation, consciousness AVPU optional) / **PEWS** (paeds) score computed and stored → Event `vitals.recorded` (+ `vitals.abnormal` / `vitals.critical`).
4. **Critical** → mandatory action prompt: repeat measurement (auto re-check after 5 min), notify doctor immediately (push + on-screen banner in OP-002; escalate to ER physician if doctor not acknowledged in 5 min or if red-flag e.g. SpO2 < 85 %/SBP < 80 → "send to ER" one-click creating ER visit OP-006 with vitals attached), nurse notes action taken; hard-stop cannot forward without doctor ack for critical (configurable) — abnormal (amber) forwards with flag.
5. Forward → token moves to **doctor queue** (EN-006 `queue.transfer` preserving priority/wait credit) → status `waiting_doctor` → doctor card shows vitals chips.
6. Repeat vitals request from doctor (`vitals.recheck.requested`) → patient re-enters vitals queue with priority; second reading linked (`repeat_of_id`).
7. Corrections: within 30 min by same nurse with reason (versioned); later corrections by supervisor; never delete.
8. Offline: PWA caches queue; vitals saved locally with device readings; sync on reconnect (server re-runs rules; alerts fire on sync with "delayed" tag).

### 3.3 Trends & downstream

- Every reading lands in shared `clinical.vitals` (also used by IP-003/IP-009/OP-006) → patient timeline graphs (BP/weight/BMI/glucose/HbA1c overlays), growth charts, pre-consult summary card in OP-002; health-check-up status board (OP-014) marks Vitals station done; chronic disease registries (BP/diabetes) fed for PE-002 recall.

### 3.4 Self-service vitals kiosk (later, flag)

- Kiosk with integrated BP/weight/height/SpO2 devices: patient scans token → guided capture → results reviewed by nurse before forwarding.

## 4. Data Model (schema `clinical`)

- **vitals** (shared, partitioned monthly): id, hospital_id, branch_id, patient_id, visit_id?, admission_id?, er_visit_id?, context enum(opd_vitals_room/er_triage/ward/icu/daycare/home/kiosk/telemed_self), recorded_at, recorded_by, station_id?, systolic, diastolic, bp_position enum(sitting/standing/supine), bp_arm, cuff_size, pulse, pulse_rhythm enum(regular/irregular), spo2, on_oxygen bool, o2_flow_lpm, temperature_c, temp_site enum(oral/axillary/tympanic/temporal/rectal/skin), resp_rate, glucose_mgdl, glucose_type enum(rbs/fbs/ppbs/hba1c_poc), height_cm, weight_kg, bmi (generated), bmi_category, waist_cm, head_circ_cm, pain_score, pain_scale enum(nrs/wong_baker/flacc), avpu enum, gcs_total?, lmp_date, pregnancy_status enum(unknown/no/yes/possible), news2_score, news2_band, pews_score, flags jsonb ({field: normal|abnormal|critical}), overall_flag enum(normal/abnormal/critical), device_readings jsonb[] ({field, device_id, serial, raw, at}), source enum(manual/device/mixed/kiosk), notes, repeat_of_id, version, corrected_reason. Indexes: (hospital_id, patient_id, recorded_at desc), (visit_id), (hospital_id, branch_id, recorded_at) for station KPIs; RLS.
- **vitals_queue** (read model / EN-006 queue kind `vitals`): visit_id, station_group_id, token_no, priority, status enum(waiting/called/in_vitals/done/skipped/bypassed), called_at, started_at, done_at, station_id, nurse_id.
- **vitals_stations**: id, branch_id, name, location, station_group_id, devices[] (device_id refs), printer_id, is_active.
- **vitals_devices**: id, hospital_id, branch_id, type enum(bp/spo2/thermometer/glucometer/scale/stadiometer/multi_spot/ecg), make, model, serial, connection enum(ble/usb_serial/wifi_hl7/gateway), address (MAC/port), asset_id (NC-020), calibration_due, status enum(active/inactive/faulty), last_seen_at.
- **vitals_reference_ranges** (EN-029 owned; hospital-configurable): parameter, age_min/max, sex, pregnancy, low_abnormal, high_abnormal, low_critical, high_critical, effective_from/to.
- **vitals_alerts**: vitals_id, level enum(abnormal/critical), parameters[], notified_doctor_id, notified_at, acknowledged_at, escalated_to, action_taken enum(repeat/doctor_informed/sent_to_er/none), note.
- **nursing_pre_consult_assessments**: vitals_id, visit_id, allergies_verified bool, new_allergies[], fall_risk_score, fall_risk_flag, smoking, alcohol, chief_complaint_text, specialty_form_response_id (EN-039), remarks.
- **growth_measurements** (paeds derived): patient_id, at, weight_z, height_z, bmi_z, hc_z, standard enum(who/iap).
- **department_vitals_policy**: department_id/doctor_id, vitals_required bool, mandatory_fields[], paeds_rules, repeat_threshold.

## 5. Business Rules & Validations

- Identity: scan or 2-identifier confirmation before entry; vitals attach to the active visit only (no orphan readings unless `context=kiosk` pending link).
- Plausibility ranges block impossible values (SBP 40–300, DBP < SBP, SpO2 0–100, temp 30–45 °C, HR 20–300, RR 4–80, weight 0.3–400 kg, height 30–250 cm; paeds ranges); unit conversion (°F↔°C, lb↔kg) at input; BMI auto, not editable.
- Mandatory field set per department policy (default adult: BP, pulse, SpO2, temp, weight; paeds: + height, head circ < 2 y; ANC: + LMP/urine dipstick); missing mandatory → forward blocked unless reason.
- Device readings accepted only if device is registered/active and reading ≤ 2 min old; calibration overdue → warning banner (NC-020) but allowed (config); manual override of device value requires reason.
- Abnormal/critical thresholds by age/sex/pregnancy from EN-029 effective-dated ranges; NEWS2 per RCP 2017 (Scale 1/2 for hypercapnic COPD flag), PEWS per hospital chart; critical → doctor notification mandatory; hard-stop forwarding for critical until ack or "sent to ER" (config).
- Repeat measurements linked; doctor sees latest + prior; averages not auto-computed except BP "average of 2" option (per NABH/hypertension protocol).
- Corrections versioned; readings never deleted; audit on all.
- Queue transfer preserves waiting-time credit (patient not penalised); station "call next" locking prevents double-call.
- Growth percentiles: WHO 0–5 y, IAP 5–18 y (configurable); flag < 3rd / > 97th percentile.
- Retention: with clinical record (≥ 10 y); partition drop only after archival to cold storage.

### 5.1 Default adult abnormal/critical thresholds (seed for EN-029 `vitals_reference_ranges`; hospital-editable)

| Parameter                                                                                                                                                                                        | Abnormal (amber)                    | Critical (red)                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------- |
| Systolic BP (mmHg)                                                                                                                                                                               | < 100 or ≥ 140                      | ≤ 90 or ≥ 180                    |
| Diastolic BP (mmHg)                                                                                                                                                                              | ≥ 90                                | ≥ 110 or ≤ 50                    |
| Pulse (bpm)                                                                                                                                                                                      | < 60 or > 100                       | < 50 or > 120                    |
| SpO2 (%)                                                                                                                                                                                         | 92–94                               | < 92 (< 88 on COPD scale 2 flag) |
| Temperature (°C)                                                                                                                                                                                 | 37.6–38.9 or 35.1–36.0              | ≥ 39.0 or ≤ 35.0                 |
| Respiratory rate (/min)                                                                                                                                                                          | 21–24 or 9–11                       | ≥ 25 or ≤ 8                      |
| Glucose RBS (mg/dL)                                                                                                                                                                              | 141–250                             | < 70 or > 300                    |
| Glucose FBS (mg/dL)                                                                                                                                                                              | 100–125                             | < 60 or ≥ 200                    |
| Pain NRS                                                                                                                                                                                         | 4–6                                 | ≥ 7                              |
| BMI (kg/m², Asian cut-offs)                                                                                                                                                                      | 23–24.9 overweight, 25–29.9 obese I | ≥ 30 or < 16                     |
| Paediatric bands (neonate, 1–12 m, 1–5 y, 6–12 y, 13–17 y) seeded from APLS/PEWS normal ranges; pregnancy: SBP ≥ 140 or DBP ≥ 90 flagged abnormal (pre-eclampsia screen) and ≥ 160/110 critical. |

### 5.2 NEWS2 (RCP 2017) scoring seeded in EN-029

| Parameter                                                                                                                                                                                     | 3      | 2      | 1         | 0         | 1         | 2       | 3     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ | --------- | --------- | --------- | ------- | ----- |
| RR                                                                                                                                                                                            | ≤ 8    |        | 9–11      | 12–20     |           | 21–24   | ≥ 25  |
| SpO2 scale 1                                                                                                                                                                                  | ≤ 91   | 92–93  | 94–95     | ≥ 96      |           |         |       |
| Air/O2                                                                                                                                                                                        |        | O2     |           | Air       |           |         |       |
| SBP                                                                                                                                                                                           | ≤ 90   | 91–100 | 101–110   | 111–219   |           |         | ≥ 220 |
| Pulse                                                                                                                                                                                         | ≤ 40   |        | 41–50     | 51–90     | 91–110    | 111–130 | ≥ 131 |
| Consciousness                                                                                                                                                                                 |        |        |           | Alert     |           |         | CVPU  |
| Temp                                                                                                                                                                                          | ≤ 35.0 |        | 35.1–36.0 | 36.1–38.0 | 38.1–39.0 | ≥ 39.1  |       |
| Bands: 0–4 low (routine), 5–6 or any single 3 = medium (urgent doctor review), ≥ 7 high (emergency response / send to ER). Scale 2 SpO2 used only when hypercapnic-COPD flag set by a doctor. |

## 6. API Surface (`/api/v1/vitals`)

| Method       | Path                                                     | Purpose                                       | Permission                               | Idem | Pag    |
| ------------ | -------------------------------------------------------- | --------------------------------------------- | ---------------------------------------- | ---- | ------ |
| GET          | /queue?station_group=                                    | vitals queue (read model + socket)            | vitals.queue.read                        | –    | –      |
| POST         | /queue/call-next, /queue/{visit}/skip, /requeue, /bypass | queue ops                                     | vitals.queue.manage                      | Y    | –      |
| POST         | /records                                                 | save vitals (+ pre-consult assessment)        | vitals.record.create                     | Y    | –      |
| PATCH        | /records/{id}                                            | correction (reason, versioned)                | vitals.record.correct                    | Y    | –      |
| GET          | /records?patient=&from=&to=&context=                     | history/trends                                | vitals.record.read                       | –    | cursor |
| GET          | /records/{id}                                            | single                                        | vitals.record.read                       | –    | –      |
| POST         | /records/{id}/forward                                    | transfer token to doctor queue                | vitals.queue.manage                      | Y    | –      |
| POST         | /records/{id}/alerts/{alert}/ack                         | doctor ack                                    | vitals.alert.acknowledge                 | Y    | –      |
| POST         | /records/{id}/send-to-er                                 | create ER visit with vitals                   | vitals.escalate.er                       | Y    | –      |
| POST         | /recheck-requests                                        | doctor requests repeat                        | vitals.recheck.request                   | Y    | –      |
| POST         | /devices/readings                                        | device agent push (station, device, readings) | integration.vitals.ingest (device token) | Y    | –      |
| GET/POST/PUT | /devices, /stations, /policies, /reference-ranges        | config                                        | vitals.configure                         | Y    | cursor |
| GET          | /patients/{id}/growth-chart                              | z-scores/percentiles series                   | vitals.record.read                       | –    | –      |
| GET          | /stats/dashboard                                         | throughput/abnormal rate/device status        | vitals.report.read                       | –    | –      |

## 7. Domain Events

- `vitals.recorded` {vitals_id, patient_id, visit_id, summary, flags, news2} → OP-002 queue card/workspace, timeline, OP-014 station status, analytics, EN-011 (optional vitals in OPConsultRecord).
- `vitals.abnormal` / `vitals.critical` {parameters, values, doctor_id} → EN-037 (doctor push/banner; escalation to ER physician/HOD), OP-002 blocking modal for critical.
- `vitals.alert.acknowledged` → close loop.
- `vitals.recheck.requested` → queue re-entry with priority.
- `vitals.escalated.er` → OP-006 (`er.patient.arrived` with source opd_vitals).
- `queue.transferred` (EN-006) {from vitals → doctor}.
- `allergy.recorded` (via OP-002 allergy store) when nurse adds allergy.
- `vitals.device.offline|calibration_due` → IT/biomedical (NC-020).
- Consumes: `visit.checked_in` (route=vitals), `visit.cancelled`, `queue.priority.changed`.

## 8. Screens

- **Vitals station** (tablet 10–12" landscape on stand, or desktop): left queue (tokens with wait time, priority icons), centre capture form with big numeric keypad, device auto-fill indicators (green pulse when reading arrives), flags colouring live, NEWS2 chip; right rail: patient banner (photo, UHID, age/sex, allergies red), last 3 vitals mini-trend, doctor/room. Hotkeys: `Space` call next, `F3` scan, `Tab` field order (BP→pulse→SpO2→temp→RR→glucose→height→weight→pain), `Ctrl+S` save & forward, `Ctrl+R` repeat, `Ctrl+E` send to ER, `Esc` cancel. Real-time: queue via socket; device readings via local agent WebSocket. Offline: banner, local save, sync indicator. Empty: "Queue empty — 0 waiting"; error: device connection lost toast + manual entry.
- **Doctor alert banner/modal** (in OP-002): critical vitals with values, ack button, "call patient now" (jump queue).
- **Vitals trend view** (desktop/tablet/phone): line charts BP/HR/SpO2/weight/BMI/glucose; growth chart with percentiles (paeds); export PDF.
- **Supervisor dashboard** (desktop/TV): stations active, waiting count, avg time in vitals, abnormal/critical rates, device health, nurse throughput.
- **Device & station config** (desktop): pair BLE devices (WebBluetooth), test reading, calibration dates, station-device mapping.
- **Health check-up mode**: station board integration (OP-014) marking Vitals done.
- Print: optional vitals slip (thermal) for patient/doctor; growth chart PDF.
  Accessibility: high-contrast, large touch targets (≥ 48 px), numeric keypad, screen-reader labels; i18n UI in 8 languages; units per hospital.

## 9. Integrations

- Devices: BLE GATT profiles (Blood Pressure 0x1810, Health Thermometer 0x1809, Weight Scale 0x181D, Pulse Oximeter 0x1822, Glucose 0x1808), vendor SDK bridges (Omron, Contec, Mindray, Philips, Masimo, Accu-Chek/OneTouch via cable), HL7 v2 ORU^R01 from spot-check monitors over Wi-Fi/LAN (MLLP listener in integration hub), IEEE 11073 PHD via gateway (EN-042 Phase 8+); local device agent (Electron/PWA) with auto-reconnect; device token auth; readings mapped to fields with unit normalisation.
- EN-006 queue transfer & TV call (EN-018), EN-029 rules, EN-037 notifications, OP-006 ER handoff, OP-014 routing, NC-020 asset/calibration, EN-039 specialty forms.
- Fallbacks: agent down → manual; rules engine down → local thresholds cached (client) + server re-evaluation on sync; queue service down → local list from cached check-ins.

## 10. Reports & Analytics

- Station throughput (patients/hour/nurse), time in vitals (call→forward), queue wait before vitals, % vitals completed before consult (NABH), abnormal & critical rates by parameter/department, critical alert ack time & escalations, device vs manual ratio, device errors/offline time, calibration compliance, BMI/BP/glucose population distributions (screening insights, PE-005 wellness), paeds growth flags, repeat-measurement rates, patients bypassed without vitals (with reasons).
- Read models: `analytics.mv_vitals_station_daily`, `analytics.mv_vitals_abnormal_rates`, `analytics.mv_population_vitals` (monthly).

## 11. Notifications

- Doctor: critical vitals (push + in-app modal + SMS on no-ack 5 min), abnormal chip (in-app only), recheck completed.
- ER physician/HOD: escalation on unacknowledged critical or "sent to ER".
- Nurse: recheck requested by doctor (bell), device calibration due, agent disconnected.
- Patient: none by default; optional vitals summary in visit summary WhatsApp (config); TV: token calls to station.
- Biomedical/IT: device offline > 15 min, faulty flag.

## 12. Permissions

`vitals.queue.read|manage`, `vitals.record.create|read|correct`, `vitals.alert.acknowledge` (doctor), `vitals.recheck.request` (doctor), `vitals.escalate.er`, `vitals.configure`, `vitals.report.read`, `integration.vitals.ingest` (device token).
Defaults: Nurse OPD/Vitals: queue.*, record.create/read/correct (own, 30 min), escalate.er; Doctor: record.read, alert.acknowledge, recheck.request; Nurse supervisor: record.correct (any), report.read, configure stations; Biomedical/IT: configure devices; Receptionist: queue.read; Auditor: read.

## 13. Non-functional

- Volumes: 5000 OP visits/day → ~4000 vitals records/day per branch, 30 stations, 60 devices; peak 600/hour; shared `clinical.vitals` table also carries ward/ICU (hourly) data → ~50M rows/yr group-wide (partitioned monthly).
- p95: queue call/forward < 150 ms; save < 200 ms incl. rules; device reading → screen < 1 s; trend query (2 yrs) < 300 ms.
- Offline: full capture offline; queue snapshot; sync with server rule re-evaluation; conflict: append-only (no conflicts, duplicates de-duped by client uuid).
- Printing: optional thermal slip; PDF trends.
- Accessibility/i18n as §8; units configurable (°C/°F, kg/lb, mg/dL/mmol/L).
- Security: device tokens scoped to station; audit on corrections; no PHI to device agent logs.

## 14. Acceptance Criteria

1. Given a visit checked-in for a department with `vitals_required=true`, then the token appears in the vitals queue within 1 s and not yet in the doctor queue.
2. Given nurse presses Space, then the next token by priority is called once (no double-call across two stations sharing the group), TV announces station, and card status becomes `called`.
3. Given a paired BLE BP monitor sends 168/102, then the BP fields auto-fill with device icon within 1 s; nurse accepts; record stores device serial and raw reading.
4. Given SBP 190 saved for an adult, then flag = critical, `vitals.critical` emitted, doctor receives push and OP-002 shows a blocking modal; forwarding is blocked until ack (default) and nurse must record action taken.
5. Given SpO2 84 % and no doctor ack in 5 min, then escalation notifies ER physician and "Send to ER" one-click creates an ER visit with the vitals attached.
6. Given a 3-year-old weight 11 kg height 92 cm, then WHO z-scores compute and are shown on the growth chart; weight-for-age < 3rd percentile flags abnormal.
7. Given a nurse enters SBP 80 and DBP 95, then save is rejected (DBP < SBP plausibility rule).
8. Given mandatory fields missing (no temperature), then forward is blocked with a reason prompt; with reason "thermometer faulty" it forwards and reason is stored.
9. Given the tablet is offline for 15 min while 12 patients are processed, then all records sync on reconnect, server re-evaluates flags, delayed critical alerts are tagged "delayed", and no duplicates exist.
10. Given doctor requests a recheck, then the token re-enters the vitals queue with priority and the second reading links to the first via `repeat_of_id`.
11. Given a correction 10 min after save by the same nurse with reason, then version 2 is created and version 1 remains retrievable; a correction after 30 min by the same nurse is rejected but allowed for supervisor.
12. Given a device with calibration overdue, then a warning banner shows on the station and biomedical is notified; readings still accepted (config on).
13. Given 600 records/hour load, save p95 < 200 ms and queue updates < 1 s.
14. Given the doctor opens the queue card, then vitals chips show latest values with abnormal ones highlighted and NEWS2 score.
15. Given a health-check-up patient completes vitals, then OP-014 station board marks Vitals done and routes to next station.
16. Given a female aged 30, then LMP/pregnancy field is required by ANC/radiology-bound departments and its value is available to OP-002 CT/X-ray prompts.

## 15. Enhancements / Later phases

- From VIMS sheet row 14 (Nurse vitals interface: bedside vital entry, auto-chart trend graph, abnormal push to attending doctor; I/O chart) — OPD portion here, ward/ICU portion in IP-003/IP-009 using the same `clinical.vitals` tables; row 14 bed map / bed transfer with auto room-charge update / occupancy dashboard and its enhancements (predictive bed demand ML → AI-005, auto housekeeping dispatch → IP-025/NC-018, IoT fall detection → EN-042, family visit scheduling → PE-001/EN-015, ward satisfaction survey → EN-030) are specified in IP-001/IP-003/IP-025, not here.
- VIMS sheet row 13 is titled "Vital Room" but its content (package configuration, booking with advance, activation on admission, variance/excess approval, utilisation & profitability reports; enhancements: dynamic pricing by occupancy, patient-facing comparison, insurance auto-mapped packages, profitability dashboard, co-pay estimator, package validity/expiry) is package management — routed to OP-023 (OP packages), IP-008 (IP packages) and RC-008 (co-pay estimator); OP-007 only consumes package routing (OP-014 health check-up first station).
- Costed proposal OP-007 (line 1554): BP, SpO2, glucose, temp, pulse, height/weight/BMI, abnormal alert, device integration, queue link — all Phase 2 core above; IP-003 line 1583 vital charting Q1H/Q4H and pain scale share this data model.
- (market) structured vitals → complaints → Rx flow (SmartHospital), vital & I/O chart monitoring (MocDoc) → IP-003; self-service vitals kiosk (EN-034, Phase 10); wearable/IoT streaming (EN-042, Phase 8/12); AI early-warning (AI-005); voice entry (AI-004); ECG spot capture at vitals station (OP-029); patient-reported outcome forms pre-consult (PE-001).

## 16. Open Questions for the Hospital

1. Which departments require vitals before consult (all vs selected) and mandatory field sets per department (adult/paeds/ANC)?
2. Existing vitals devices (make/model/connectivity) — BLE/USB/Wi-Fi? Multi-parameter spot-check monitors or standalone devices? Budget for device agents/tablets per station?
3. Abnormal/critical thresholds — adopt defaults (NEWS2 + listed thresholds) or hospital-specific? Paeds PEWS chart in use?
4. Critical handling: hard-stop forwarding until doctor ack, or forward with flag? Escalation timings and who is escalated to?
5. Growth standards preference (WHO/IAP), BMI cut-offs (Asian vs WHO).
6. Number of stations per branch and shared queue groups; TV displays at vitals area?
7. Should nurses capture chief complaint/allergy verification/fall risk (extra 20–30 s) or vitals only?
8. Units (°C/°F, mg/dL vs mmol/L) and languages for the station UI.
9. Self-service kiosk vitals desired later? Health-check-up flow uses same station?
