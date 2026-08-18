# OP-029 — Cardiology Console (ECG, Echo, TMT/Stress, Holter/ABPM, Device integration, Cath lab scheduling, Risk scores, Cardiac rehab & anticoagulation clinic)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-029 |
| Phase | 8 |
| Priority | P2 |
| Complexity | High |
| Depends on | **OP-025 §0 (shared specialty console framework)**, OP-002, OP-007 (vitals, ECG at vitals room), OP-022/EN-042 (ECG/TMT/Holter/ABPM device import; PDF/XML/HL7 aECG), OP-008/EN-008 (Echo/cath/CT coronary/nuclear via PACS-DICOM; structured echo report), OP-006 (chest-pain pathway/ER STEMI, code STEMI), OP-010 (procedures: cardioversion, pericardiocentesis, pacemaker check), IP-006/IP-001 (cath lab as OT-type resource; day-care angio), TR-003/NC-007 (stents/pacemakers/ICD/valves UDI, consignment), IP-009 (CCU), OP-003/EN-029 (anticoagulant/antiplatelet rules, QT-prolonging drugs, renal dosing), OP-004 (troponin, INR, lipids, BNP; critical values), OP-015 (cardiac rehab with physio), OP-011 (diet), OP-030 (sleep/PFT), OP-023/RC-002/RC-007 (packages, pre-auth, PMJAY cardiac packages), EN-028 (consent), EN-039, PE-002 (device follow-up, INR clinic), EN-009, IP-013 (code blue), NC-020 (device calibration), AI-002 (later) |
| Feature flag | `module.cardiology.enabled` (sub: `cardio.cath_lab`, `cardio.device_clinic`, `cardio.anticoag_clinic`, `cardio.rehab`, `cardio.holter_abpm`) |
| Primary roles | Cardiologist (6), Interventional cardiologist (9), Cardiac technician / ECG-Echo tech (36 family: `cardiac_technician`), Cath lab nurse/tech (20/36), Resident (14), Cardiac nurse (16) |
| Secondary roles | ER physician (8), Anaesthetist (10), Physio (40, rehab), Pharmacist (30, anticoag), Radiologist (12, CT), Billing/insurance (27/28), Stores (44 consignment), Quality (54), Patient |
| Regulatory | NABH (cardiac cath lab standards), AERB (cath lab X-ray licence, dose logging, TLD badges), CDSCO UDI (stents/pacemakers Class C/D; NPPA stent price cap compliance in billing), PMJAY cardiac packages (RC-007), Clinical Establishments Act, DPDP, ICMR STEMI guidelines (door-to-balloon/needle KPIs), NDPS n/a |

## 1. Purpose
OP-029 provides the cardiology outpatient and non-invasive lab record: cardiovascular consult with risk scores (ASCVD/QRISK-adapted, CHA₂DS₂-VASc, HAS-BLED, TIMI/GRACE, NYHA/CCS class), **non-invasive test orders & results** — 12-lead ECG (device import with measurements/interpretation), **echocardiography structured report** (chambers, LVEF, valves, Doppler, wall motion 17-segment, GLS), **TMT/stress test** (Bruce protocol stages, METs, ST changes, Duke score), **Holter/event/ABPM** (device upload, summary), stress echo/nuclear/CT coronary attach — all via OP-022/EN-042/PACS with review & sign; **cath lab scheduling** (angio/PCI/pacing/EP/structural) with pre-procedure checklist, consent, pre-auth, implant reservation, and post-procedure follow-up; **device clinic** (pacemaker/ICD/CRT interrogation logs), **anticoagulation clinic** (INR/dose nomogram, DOAC monitoring), and cardiac rehab. Framework per OP-025 §0.

## 2. Users & Jobs-to-be-done
- **Cardiologist** (desktop/tablet; 40–70 pts/day): consult, review ECG/echo/TMT/Holter, score risk, plan meds/interventions, schedule cath, sign reports, follow-up devices/anticoag.
- **Cardiac technician** (desktop at ECG/echo/TMT rooms; 100 ECGs, 40 echos, 20 TMTs, 10 Holters/day): perform tests, import/enter data, attach media, hand off for reporting.
- **Interventional team/cath lab coordinator**: schedule slots, checklists, consent, implants/consignment, pre-auth, day-care bed, post-procedure notes and follow-up.
- **Cardiac nurse/pharmacist**: anticoag clinic (INR, dose), heart-failure clinic (weights, symptoms), rehab enrolment.
- **Patient**: reports/PDFs, INR/dose calendar, rehab schedule, device follow-up reminders.

## 3. Core Workflows
### 3.1 Cardiology consult & risk scoring
1. Console tabs: Consult · ECG · Echo · Stress/TMT · Holter/ABPM · Cath lab · Devices · Anticoag/HF clinic · Rehab.
2. Structured CV history (angina CCS, dyspnoea NYHA, palpitations, syncope, risk factors, family history), exam (JVP, murmurs sided/site, oedema), problem list ICD-10 (I10–I52, I20–I25, I48…), **scores** (EN-039 auto-calc): CHA₂DS₂-VASc & HAS-BLED (AF), ASCVD 10-yr risk (pooled cohort with ethnicity note; QRISK-style option), GRACE/TIMI (ACS from ER), Framingham HF, NYHA/CCS, HEART score (chest pain), Wells (PE); score-driven CDSS prompts (e.g. CHA₂DS₂-VASc ≥ 2 → anticoag consideration prompt).
3. Plan: e-Rx (EN-029: dual antiplatelet duration tracker after PCI, DOAC renal dosing, QT-prolonging combos, statin intensity), orders for tests (§3.2), imaging (CT coronary/calcium score, cardiac MRI via OP-008), labs (troponin/BNP/lipids/INR — critical values from OP-004), referrals, cath lab (§3.3), device clinic, anticoag clinic enrol, rehab, education (OP-038), recall (e.g. HF 4-weekly).
### 3.2 Non-invasive lab
1. **ECG**: order (or ER/vitals room ECG) → device (12-lead machines via EN-042: HL7 aECG/SCP-ECG/DICOM-ECG/PDF; GE MUSE/Philips/BPL/Schiller connectors) → auto-populated measurements (HR, PR, QRS, QT/QTc, axis, machine interpretation) → technician confirms lead quality → cardiologist reads/overrides interpretation (SNOMED/MUSE codes: NSR, AF, LBBB, STEMI territory…) → sign → PDF with waveform; **critical ECG** (STEMI pattern, VT, complete heart block) → immediate alert to cardiologist/ER (code STEMI OP-006, door-to-ECG timer). Serial ECG comparison viewer.
2. **Echo**: MWL to echo machine (DICOM via EN-008), structured report template (2D: LVIDd/s, IVS, PW, LA, Ao, EF Simpson/Teichholz, RV, TAPSE; Doppler: E/A, E/e′, valves gradients/areas/regurg grades, PASP; wall motion 17-segment map WMSI; pericardium; GLS; conclusions macros), measurements imported from DICOM SR where available (else typed), key images attached, sign, PDF; TEE/stress echo/foetal echo templates; paediatric Z-scores (OP-033).
3. **TMT/stress**: protocol (Bruce/modified/Naughton), stage table (time, speed/grade, HR, BP, METs, symptoms, ST change per lead, arrhythmia), target HR (220−age × 85 %), termination reason, Duke treadmill score, conclusion (positive/negative/inconclusive), pre-test checklist (contraindications, meds held), consent, physician present, emergency kit check; device import (PDF/XML).
4. **Holter/event/ABPM** (`cardio.holter_abpm`): device issue (serial from pool, hook-up time, return due) → download/report import (PDF/XML: total beats, min/avg/max HR, pauses, VE/SVE burden, AF burden; ABPM: day/night means, dipping) → cardiologist summary/sign; device return tracking & lost-device escalation.
5. Review states per §0.3; unsigned reports > 24 h escalate; results to OP-002 timeline, portal, FHIR DiagnosticReport.
### 3.3 Cath lab scheduling & interventions (`cardio.cath_lab`)
1. Order (angio/PCI/PTCA, pacemaker/ICD/CRT, EP study/ablation, TAVI/BMV/ASD closure, peripheral) → **cath lab calendar** (labs as resources; slots; emergency override for STEMI) → pre-procedure checklist (consent EN-028, labs: creatinine/eGFR, INR/aPTT, HIV/HBsAg/HCV, blood group; NPO; anticoagulant hold; contrast allergy premed; metformin hold; pregnancy; radial/femoral plan; day-care/IP-001 admission; pre-auth RC-002/PMJAY package RC-007; implant reservation TR-003/NC-007 by size list) → readiness score → **procedure day**: cath lab worklist, time-out (WHO), procedure record (access, contrast volume, fluoro time/dose AERB, lesions per vessel segment (SYNTAX/AHA segments), stents (UDI/lot/size, NPPA price), balloons/wires consumables, complications, TIMI flow), post-procedure orders (sheath removal, ambulation, IP-009 CCU if needed), discharge (IP-002) & follow-up (DAPT plan, 1-week/1-month) → billing (package variance, consignment consumption) → `cardio.cath.completed`.
2. STEMI pathway: ER activation → cath lab team paging (EN-037) → door-to-balloon timer; ICMR/registry fields.
### 3.4 Device clinic (`cardio.device_clinic`)
- Implanted device registry (type, model, serial/UDI, leads, implant date, MRI-conditional), interrogation visits (battery ERI, thresholds, impedances, % pacing, arrhythmia episodes, remote-monitoring uploads PDF), advisories/recalls (TR-003), follow-up schedule (1/3/6/12 mo), device card print.
### 3.5 Anticoagulation & HF clinic (`cardio.anticoag_clinic`)
- Warfarin: target INR range, POC/lab INR entry, dose nomogram suggestion, weekly dose calendar (mg/day grid), TTR calc, next INR date, bleeding/thrombosis events; DOAC: renal function/CrCl checks, dose appropriateness, adherence; HF clinic: weight/symptom diary (app), NYHA trend, GDMT titration checklist (ARNI/BB/MRA/SGLT2), diuretic self-titration plan, decompensation alerts.
### 3.6 Cardiac rehab (`cardio.rehab`)
- Enrolment post-MI/PCI/CABG/HF → phase II sessions (OP-015 co-managed): exercise prescription (METs/HR zones), session vitals, ECG telemetry attach, education, risk-factor goals, 6MWT/functional outcomes.
### 3.7 Exceptions
- Critical ECG at vitals room without cardiologist on-site → tele-review (OP-018) & ER; contrast reaction/complication → NC-015; implant not available → reschedule; device offline → manual entry flagged; patient on warfarin with INR 5 → urgent nurse protocol.

## 4. Data Model (schema `specialty`)
- **cardio_consults**: id, hospital_id, branch_id, patient_id, encounter_id, cv_history jsonb, exam jsonb, nyha smallint, ccs smallint, scores jsonb ({cha2ds2vasc, hasbled, ascvd_pct, grace, timi, heart}), problem_codes text[], plan jsonb, signed_by/at, version.
- **ecg_records**: id, hospital_id, branch_id, patient_id, encounter_id?, order_id?, source enum(device/upload/manual), device_id?, acquired_at, hr, pr_ms, qrs_ms, qt_ms, qtc_ms, axis_deg, machine_interp text[], waveform_key (S3: aECG XML/DICOM/PDF), lead_quality, tech_id, critical bool, critical_ack_by/at, read_interp text[], read_by/at, status enum(acquired/preliminary/final), pdf_key; index (hospital_id, patient_id, acquired_at desc), (hospital_id, status).
- **echo_reports**: id, hospital_id, patient_id, encounter_id, order_id, type enum(tte/tee/stress/fetal/paeds), study_uid (PACS), measurements jsonb (typed keys: lvidd, lvids, ivs, pw, ef_pct, la, ao, e_a, e_eprime, tapse, pasp, valves{mv,av,tv,pv:{gradient, area, regurg_grade}}, gls), wall_motion jsonb (17 segments), conclusions text, key_images uuid[], tech_id, reported_by, signed_at, status, pdf_key, version.
- **stress_tests**: id, patient_id, encounter_id, protocol enum(bruce/mod_bruce/naughton/pharm), stages jsonb ([{stage, min, speed, grade, hr, bp, mets, symptoms, st_changes}]), target_hr, max_hr_pct, duke_score, termination_reason, result enum(positive/negative/inconclusive/equivocal), physician_id, consent_id, checklist jsonb, report_key, signed_at.
- **ambulatory_monitor_studies**: id, patient_id, type enum(holter24/holter48/holter7d/event/abpm), device_serial, hooked_at, return_due, returned_at, report_key, summary jsonb (hr_min/avg/max, pauses, ve_burden, af_burden, abpm_day/night means, dipping), interpreted_by, signed_at, status enum(issued/returned/reported/lost).
- **cath_lab_bookings**: id, hospital_id, branch_id, patient_id, procedure_code, lab_id, slot_start/end, urgency enum(elective/urgent/emergency_stemi), admission_id?, checklist jsonb (labs, npo, consent_id, anticoag_hold, contrast_allergy, preauth_id, implant_reservation_ids), readiness enum(pending/ready/blocked), status enum(requested/scheduled/in_lab/completed/cancelled/postponed), cancelled_reason.
- **cath_procedures**: id, booking_id, patient_id, operator_id, access enum(radial/femoral/brachial), contrast_ml, fluoro_min, dose_mgy (DAP), lesions jsonb ([{segment, stenosis_pct, timi_pre/post, treatment}]), implants jsonb ([{udi, type, size, lot, tr003_id}]), consumables jsonb, complications jsonb, syntax_score?, door_to_balloon_min? (STEMI), notes doc_id, signed_at.
- **cardiac_devices**: id, patient_id, type enum(ppm/icd/crt_p/crt_d/ilr/leadless), model, serial (unique), udi, leads jsonb, implant_date, mri_conditional bool, status enum(active/explanted/eri), next_check_at; **device_checks**: id, device_id, at, battery, thresholds jsonb, impedances jsonb, pacing_pct, episodes jsonb, remote bool, report_key, by.
- **anticoag_enrolments**: id, patient_id, drug enum(warfarin/acenocoumarol/doac), indication, target_inr_low/high, start_date, status; **inr_visits**: id, enrolment_id, at, inr numeric(4,2), source enum(poc/lab), weekly_dose_mg, dose_grid jsonb (7 days), next_at, events jsonb, ttr_pct (rolling), by.
- **hf_clinic_entries**: patient_id, at, weight_kg, nyha, symptoms jsonb, gdmt jsonb, action, source enum(clinic/app).
- **cardiac_rehab_episodes** & **rehab_sessions** (link OP-015): exercise_rx jsonb, session vitals, 6mwt_m, status.
- Enums: `ecg_status`, `echo_type`, `stress_result`, `cath_urgency`, `device_type`.

## 5. Business Rules & Validations
- QTc computed (Bazett default; Fridericia option); QTc > 500 ms or machine "acute MI"/VT/CHB → `critical=true` → alert cardiologist & ER within 60 s; acknowledgment mandatory (audited); door-to-ECG ≤ 10 min KPI for chest pain (OP-006).
- Echo: EF range 5–85; regurg grades enumerated; report cannot sign without EF & conclusion; paediatric Z-scores by BSA (Haycock); prior-study comparison auto-suggested.
- TMT: contraindication checklist (recent MI < 2 d, unstable angina, severe AS…) blocks start without override; physician presence recorded; emergency cart check daily (IP-013).
- Holter device pool: serial tracked; return overdue > 24 h → SMS + escalation; lost → billing rule.
- Cath lab: booking cannot become "ready" until consent, eGFR (contrast dose max = 3.7×eGFR mL rule warn), INR/anticoag hold, pre-auth (if payer), implant reservation (size range) satisfied; STEMI emergency bypasses with post-hoc completion; AERB dose per procedure logged; stents billed at ≤ NPPA ceiling (RC-003 check); implants consumed via TR-003 UDI scan; DAPT plan mandatory at PCI completion (creates EN-029 duration tracker & PE-002 reminders).
- Anticoag: INR ≥ 5 or ≤ 1.5 in high-risk → urgent protocol prompt; dose grid total = weekly dose; TTR (Rosendaal) computed; DOAC dose vs CrCl (Cockcroft-Gault) check.
- Device clinic: ERI → replacement task; recall from TR-003 → patient list & notification.
- Reports immutable after sign; amendments versioned; ECG waveform files retained ≥ record retention; AERB dose retention.

## 6. API Surface (`/api/v1/cardio`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /worklist, /lab/worklist?type= | consult & non-invasive lab worklists | cardio.visit.read / cardio.lab.read | – | cursor |
| PUT | /encounters/{id}/consult | consult + scores | cardio.consult.record | Y | – |
| POST | /ecg (multipart or device ingest), PATCH /ecg/{id}/read, /ack-critical | ECG lifecycle | cardio.ecg.acquire/read/sign | Y | – |
| GET | /ecg?patient=&compare= | serial ECGs | cardio.ecg.read | – | cursor |
| POST/PUT | /echo, /echo/{id}, POST /echo/{id}/sign | echo report | cardio.echo.record/sign | Y | – |
| POST/PUT | /stress, /stress/{id}/sign | TMT | cardio.stress.record/sign | Y | – |
| POST/PATCH | /ambulatory, /ambulatory/{id}/return, /report | Holter/ABPM | cardio.ambulatory.manage | Y | cursor |
| POST/PATCH/GET | /cath/bookings, /cath/bookings/{id}/checklist | scheduling | cardio.cath.schedule | Y | cursor |
| POST/PUT | /cath/procedures | procedure record | cardio.cath.record/sign | Y | – |
| POST/GET/PATCH | /devices, /devices/{id}/checks | device clinic | cardio.device.manage | Y | cursor |
| POST/GET | /anticoag/enrolments, /anticoag/{id}/inr | anticoag | cardio.anticoag.manage | Y | cursor |
| POST/GET | /hf, /rehab | HF & rehab | cardio.hf.record / cardio.rehab.manage | Y | cursor |
| GET | /reports/kpis, /reports/stemi, /reports/aerb | KPIs | cardio.report.read | – | – |

## 7. Domain Events (outbox)
- `cardio.ecg.acquired|critical|signed`, `cardio.echo.signed`, `cardio.stress.signed`, `cardio.ambulatory.issued|overdue|reported`, `cardio.cath.requested|ready|blocked|completed` → IP-006 board, TR-003, RC-002, OP-005/IP-005, `cardio.stemi.activated` → EN-037 paging, `cardio.device.eri|recall`, `cardio.anticoag.inr_critical`, `cardio.hf.decompensation_alert`, `cardio.consult.signed`.
- Consumes: `vitals.recorded` (ECG at OP-007), `er.chest_pain.triaged`, `op22.result.attached`, `pacs.study.available`, `lab.result.critical` (troponin, INR), `implant.recall` (TR-003), `preauth.approved`, `procedure.completed`.

## 8. Screens (UI)
1. **Cardio worklist** (desktop): unread ECG count badge, pending echo reports, cath readiness column; real-time.
2. **ECG reader** (desktop): waveform viewer (12-lead grid, 25/50 mm/s, gain, calipers), measurements panel, machine vs read interpretation, serial compare (`[`/`]`), `C` critical ack, `Ctrl+Enter` sign.
3. **Echo report editor** (desktop at echo room): measurement grid with normal-range colouring, 17-segment bull's-eye clickable, valve tables, conclusion macros (`/`), key image picker from PACS, PDF preview.
4. **TMT console** (desktop): stage table live entry with timer, HR/BP plot, ST change grid, Duke calc, checklist gate.
5. **Holter/ABPM desk** (desktop/tablet): device pool board (issued/due/overdue), report import & summary form.
6. **Cath lab scheduler** (desktop): calendar per lab, readiness traffic-light, checklist drawer, implant reservation, STEMI emergency button; **Cath procedure record** (tablet in lab): coronary tree diagram (segment click), stent UDI scan, contrast/dose counters.
7. **Device clinic & anticoag clinic boards** (desktop/tablet): due lists, INR entry with dose grid & calendar print.
8. **HF/rehab patient app views** (phone): weight/symptom diary, INR/dose calendar, rehab schedule.
- Empty/error: device import failed → manual entry with flag; PACS unavailable → cached thumbnails.

## 9. Integrations
- EN-042 ECG connectors (HL7 aECG XML, SCP-ECG, DICOM waveform, PDF; GE MUSE HL7 ORU, Philips TraceMaster, Schiller/BPL exports), TMT systems (XML/PDF), Holter/ABPM software (PDF/XML/CSV), remote device monitoring portals (PDF import; Medtronic/Boston/Abbott later), POC INR meters (CoaguChek CSV/serial); PACS/EN-008 for echo/cath DICOM (MWL, SR measurements), hemodynamic recording systems (PDF); TR-003/NC-007 implants; RC-007 PMJAY packages; EN-011 FHIR (DiagnosticReport ECG/Echo, Observation LOINC 8867-4 HR, 10230-1 LVEF); AERB dose registry.

## 10. Reports & Analytics
- Non-invasive lab volumes/TAT (acquire→sign), critical ECG response time, door-to-ECG/door-to-balloon (STEMI), cath lab utilisation & cancellations, PCI outcomes/complications, stent usage & NPPA compliance, contrast/dose per procedure, device clinic follow-up compliance, anticoag TTR & adverse events, HF readmissions, rehab completion, revenue by service/package. Read models `analytics.cardio_lab_daily`, `analytics.cath_lab_kpis`, `analytics.stemi_registry`.

## 11. Notifications
- Patient: report ready, Holter return reminder, cath prep instructions (NPO, meds), INR/dose calendar, device follow-up due, rehab sessions, HF weight-gain alert advice. Staff: critical ECG (push+call escalation), STEMI activation, cath readiness blocked, implant not reserved 24 h prior, unsigned reports > 24 h, INR critical, device ERI/recall, contrast reaction incident.

## 12. Permissions (RBAC keys)
`cardio.visit.read`, `cardio.consult.record|sign`, `cardio.ecg.acquire|read|sign|ack_critical`, `cardio.echo.record|sign`, `cardio.stress.record|sign`, `cardio.ambulatory.manage|sign`, `cardio.cath.schedule|record|sign`, `cardio.device.manage`, `cardio.anticoag.manage`, `cardio.hf.record`, `cardio.rehab.manage`, `cardio.report.read`, `cardio.configure`. Defaults: Cardiologist — all clinical; Interventionalist — + cath.*; Technician — acquire/record (no sign); Cath nurse — cath.record (consumables/implants), schedule read; Cardiac nurse/pharmacist — anticoag.manage, hf.record; ER physician — ecg.read, ack_critical; Resident — record no sign.

## 13. Non-functional
- Volumes (enterprise): 800 ECGs/day (also from OP-007/ER/wards), 150 echos, 60 TMTs, 30 Holters, 25 cath procedures/day; ECG ingest→available < 5 s; waveform render < 300 ms; critical alert delivery < 60 s; echo report save p95 < 300 ms. Offline: consult/echo forms cached; ECG devices buffer locally. Print: ECG A4 with grid, echo/TMT reports, INR calendar, device card. AERB dose logs retained ≥ 5 years (config).

## 14. Acceptance Criteria (plus OP-025 §0.9)
1. Given a 12-lead ECG imported with QTc 520 ms, then the record is critical, cardiologist and ER receive alerts within 60 s, and sign requires acknowledgment.
2. Given an echo report with EF blank, then sign is blocked; with EF 35 % and conclusions, sign generates PDF and FHIR DiagnosticReport; timeline shows it within 2 s.
3. Given TMT stage 3 Bruce reached with 2 mm ST depression and angina at 7 METs, then Duke score computes (7 − 5×2 − 4×2 = −11, high risk) and result "positive" is suggested.
4. Given a Holter issued 3 days ago (24 h study), then it appears overdue, the patient got a reminder and coordinator an escalation.
5. Given a PCI booking with eGFR 28 and no consent, then readiness is "blocked" listing both items; after consent and nephro-protection note/override, readiness turns "ready".
6. Given STEMI activation from ER, then a cath booking is created with emergency urgency bypassing checklist gates, cath team paged, and door-to-balloon timer runs until "balloon" timestamp.
7. Given a stent UDI scanned in the cath record, then TR-003 traces it to the patient, consignment decrements, and the bill line is capped at NPPA price with variance flag if tariff higher.
8. Given PCI completion without DAPT plan, then sign is blocked; with plan (12 months) reminders and EN-029 duration tracker exist.
9. Given warfarin patient INR 5.2, then the anticoag board flags urgent, nurse protocol prompt appears, and dose calendar can be re-issued.
10. Given the device registry receives a recall for model X (TR-003), then affected patients list is produced with notification tasks.
11. Given a technician attempts to sign an echo, then 403 and audit.
12. Given serial ECGs exist, then compare view aligns leads and shows measurement deltas.

## 15. Enhancements / Later phases
- Sheet row 66 (ECG, Echo, TMT, Holter, Cath lab scheduling) — core. Market: device clinic, anticoag/HF clinics, cardiac rehab, STEMI KPIs, NPPA compliance.
- Later: AI-002/AI-007 ECG interpretation assist & echo auto-measurements, remote device monitoring APIs, wearables (ECG watches) import into patient app, tele-cardiology hub-and-spoke for ECG reads (OP-018), national ACS registry export, cath lab inventory RFID.

## 16. Open Questions for the Hospital
1. ECG machine brands/connectivity; echo machines DICOM SR capable; TMT/Holter software exports?
2. Cath labs count, day-care vs IP flows, PMJAY/insurance package rules, consignment vendors for stents/pacemakers?
3. Which risk scores/protocols standard? STEMI network participation and KPIs required?
4. Anticoag clinic run by nurse/pharmacist? POC INR meters?
5. Device clinic remote monitoring vendors? Cardiac rehab availability with physio?
