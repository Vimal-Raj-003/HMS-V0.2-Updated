# OP-030 — Pulmonology Console (PFT/Spirometry with device import & GLI predicted values, DLCO/Body box, 6MWT, Sleep study scheduling & scoring import, Bronchoscopy scheduling, Asthma/COPD/TB programme, Oxygen/CPAP clinic)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-030 |
| Phase | 8 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | **OP-025 §0 (shared specialty console framework)**, OP-002, OP-007 (SpO2, peak flow at vitals), OP-022/EN-042 (spirometer/PFT/PSG/oximetry device import), OP-008/EN-008 (CXR/HRCT via PACS), OP-004 (sputum AFB/CBNAAT/culture, ABG, IgE, eosinophils), OP-010 (bronchoscopy, thoracentesis, pleural biopsy, EBUS — procedure record, consent, sedation), OP-006/IP-001 (day-care for bronchoscopy/sleep lab bed), IP-024 (sedation/anaesthesia for bronchoscopy), OP-003/EN-029 (inhaler technique, steroid taper, drug-TB interactions), OP-013 (influenza/pneumococcal vaccination), OP-015 (pulmonary rehab), OP-028 (OSA — ENT), OP-029 (cardiac evaluation), OP-011 (nutrition), OP-023/OP-005 (packages, tariffs), NC-006 (CPAP/oxygen concentrator rental/sale), NC-020 (device calibration), EN-028, EN-039, PE-002 (recall), EN-009, EN-017 (Ni-kshay TB portal connector), NC-016 (BMW) |
| Feature flag | `module.pulmonology.enabled` (sub: `pulmo.pft_lab`, `pulmo.sleep_lab`, `pulmo.bronchoscopy`, `pulmo.tb_programme`, `pulmo.home_devices`) |
| Primary roles | Pulmonologist (6), PFT technician / Respiratory therapist (36/40 family: `respiratory_therapist`), Sleep technologist, Bronchoscopy nurse (16/20), Resident (14) |
| Secondary roles | ENT (OSA), Cardiologist, Physio (rehab), TB health visitor/DOTS provider, Pharmacist, Radiologist, Billing/reception, Quality, Patient |
| Regulatory | NABH, NTEP/Ni-kshay TB notification (mandatory notification within 3 days; NIKSHAY ID; DBT), Air quality/occupational lung disease reporting (Silicosis registry where applicable), AERB (CT/fluoro via OP-008), CDSCO (CPAP/oxygen devices), NDPS n/a, ATS/ERS spirometry standards 2019 & GLI-2012 predicted equations (India options), AASM sleep scoring rules, DPDP |

## 1. Purpose
OP-030 supports respiratory medicine: consult with symptom scores (mMRC, CAT, ACT/ACQ, Epworth, STOP-BANG), **PFT lab** (spirometry pre/post bronchodilator with ATS/ERS quality grading & GLI predicted/LLN/z-scores, DLCO, lung volumes/body box, FeNO, 6MWT, peak-flow diaries) with device import and pulmonologist interpretation, **sleep lab** (PSG/HST scheduling, bed & tech roster, AASM-scored report import, AHI/ODI capture, CPAP titration, device prescription & compliance downloads), **bronchoscopy scheduling & record** (via OP-010 with sedation, BAL/biopsy specimens to OP-004), TB programme (notification, DOTS/regimen tracking, Ni-kshay), asthma/COPD action plans and inhaler education, home oxygen/CPAP device management and pulmonary rehab linkage. Framework per OP-025 §0.

## 2. Users & Jobs-to-be-done
- **Pulmonologist** (desktop/tablet; 40–60 pts/day): consult, interpret PFT/PSG, diagnose (ICD-10 J00–J99, A15–A19, G47.3), plan therapy/action plans, schedule bronchoscopy/sleep study, notify TB, follow chronic cohorts.
- **PFT technician/RT**: perform spirometry/DLCO/6MWT with quality control, import device data, coach patients, maintain calibration log; run bronchodilator reversibility.
- **Sleep technologist**: schedule sleep beds, hook-up, monitor overnight, score/import report, CPAP titration; manage HST devices.
- **Bronchoscopy nurse**: pre-procedure checklist, sedation monitoring (with IP-024), specimen labelling, scope reprocessing log (EN-003 flexible scope), recovery (Aldrete).
- **TB health visitor**: notification, treatment adherence, contact screening, DBT.
- **Patient**: action plan, inhaler videos (OP-038), peak-flow diary, CPAP compliance, TB reminders.

## 3. Core Workflows
### 3.1 Consult
1. Console tabs: Consult · PFT · Sleep · Bronchoscopy · TB · Chronic care (Asthma/COPD/ILD/OSA) · Devices/Rehab.
2. History (smoking pack-years auto-calc, biomass exposure, occupation, TB history), symptom scores (mMRC 0–4, CAT 0–40, ACT, ACQ, Epworth, STOP-BANG, SGRQ optional), exam, SpO2/peak flow from OP-007, imaging review (CXR/HRCT with structured findings), labs; diagnosis; **GOLD staging** (post-BD FEV1 % + exacerbation history + symptoms → group A/B/E) and **GINA step** auto-suggested; plan: inhaler Rx (device type, technique check flag, spacer, education video), steroid courses, oxygen Rx, referrals, tests, action plan (§3.5), vaccination (OP-013), rehab (OP-015).
### 3.2 PFT lab (`pulmo.pft_lab`)
1. Order (spirometry ± BD, DLCO, lung volumes, FeNO, 6MWT, MIP/MEP) → technician worklist → pre-test checklist (bronchodilator withheld hours, contraindications: recent MI/pneumothorax/surgery, TB infectious → last slot & filters), demographics for prediction (age, sex, height measured today, ethnicity per GLI) → **spirometry**: import from device (EN-042: MIR/Vitalograph/CareFusion/Cosmed exports XML/CSV/PDF; else manual FVC/FEV1/FEV1%/PEF/FEF25-75) for ≥ 3 acceptable trials → best values, ATS/ERS 2019 acceptability/repeatability grade (A–F) → predicted/LLN/z-score (GLI-2012; option local Indian equations) → post-BD repeat after 15 min → reversibility (Δ ≥ 12 % and 200 mL / GLI Δz) → DLCO (Hb-corrected), TLC/RV/FRC → automated interpretation suggestion (obstruction/restriction/mixed, severity by FEV1 z/%) → technician comments → pulmonologist interprets/signs → PDF with flow-volume & volume-time curves (device images/data) → §0.3 review states. Event `pulmo.pft.signed`.
2. 6MWT: distance, SpO2 nadir, HR, Borg, stops, predicted % (Enright); FeNO ppb; peak-flow diary (app) with personal best & zone calc.
### 3.3 Sleep lab (`pulmo.sleep_lab`)
1. Order PSG (level 1) / HST (level 3) / CPAP titration / split-night → **scheduler** (sleep beds as resources, tech roster, patient prep instructions) → hook-up checklist → overnight monitoring notes → scoring (device software; import report PDF/XML with AHI, RDI, ODI, T90, arousal index, sleep efficiency, stages %, position/REM AHI, PLM index) → pulmonologist interpretation (OSA severity mild/moderate/severe; central/mixed; hypoventilation) → CPAP/APAP/BiPAP prescription (pressure, mask, humidifier) → device dispensing/rental (NC-006, `pulmo.home_devices`) → compliance downloads (SD card/cloud PDF: usage h/night, %≥4 h, residual AHI, leak) at 1/3/12 months → recall. HST devices pool: issue/return tracking (like Holter).
### 3.4 Bronchoscopy (`pulmo.bronchoscopy`, via OP-010)
- Order (diagnostic FOB, BAL, TBLB, EBUS-TBNA, therapeutic, rigid) → scheduling (bronchoscopy suite calendar; day-care bed OP-006/IP-001; anaesthetist IP-024 if deep sedation) → pre-checklist (consent EN-028, coagulation, platelets, NPO, anticoag hold, ECG/spirometry, HIV/HBsAg, airway assessment, TB isolation) → procedure record template (route, sedation drugs/doses, topical LA dose, findings per lobe/segment map, samples: BAL volume/site, biopsies count, brushings, TBNA nodes (stations), specimens labelled EN-013 → OP-004 (AFB, CBNAAT, cytology, histopath, culture)), complications (desaturation, bleeding, pneumothorax → CXR), recovery (Aldrete), scope ID & reprocessing log (EN-003), report PDF with images (OP-022 capture) → results tracking with pathology callback; charge intents.
### 3.5 Chronic disease programmes
- **Asthma/COPD registry**: action plan (green/yellow/red zones with peak-flow thresholds & meds), exacerbation log (OP-006/IP admissions auto-linked), inhaler technique checklist (each visit), adherence, spirometry trend, GOLD/GINA step-up/down, oxygen assessment (rest/exertion SpO2, ABG) → home O2 Rx (flow, hours, device) & concentrator rental log; **ILD**: MDT discussion record, antifibrotic monitoring; **OSA**: CPAP compliance cohort; **pulmonary rehab** episodes (OP-015).
### 3.6 TB programme (`pulmo.tb_programme`)
- Presumptive TB → tests (sputum/CBNAAT) → diagnosis (microbiologically/clinically confirmed, site, DR status) → **mandatory notification** to Ni-kshay (EN-017 connector/API where enabled; else export & manual ID entry) within 3 days → regimen (2HRZE/4HR fixed-dose by weight band; DR-TB regimens) → treatment card, adherence (DOT/99DOTS/family), follow-up sputum at 2/5/6 months, adverse drug reactions (hepatotoxicity monitoring), contact screening list, outcome (cured/completed/failed/LTFU/died), Nikshay Poshan DBT bank fields, private-provider incentives; monthly NTEP reports.
### 3.7 Exceptions
- Poor-quality spirometry (grade D–F) → repeat/limit interpretation; device offline → manual; sleep study cancelled (patient no-show) → bed release; bronchoscopy complication → NC-015; TB not notified within 3 days → escalation to HOD/quality; oxygen concentrator returned faulty → NC-020.

## 4. Data Model (schema `specialty`)
- **pulmo_consults**: id, hospital_id, branch_id, patient_id, encounter_id, smoking jsonb (status, pack_years), exposures jsonb, scores jsonb (mmrc, cat, act, acq, epworth, stop_bang), gold_group, gina_step, dx_codes, plan jsonb, action_plan_id?, signed_by/at, version.
- **pft_studies**: id, hospital_id, patient_id, encounter_id, order_id, tests text[] (spiro/bd/dlco/volumes/feno/6mwt/mip_mep), device_id?, source enum(device/manual), tech_id, performed_at, demographics jsonb (age, sex, height_cm, weight_kg, ethnicity, hb), quality_grade char(1), pre jsonb (fvc, fev1, ratio, pef, fef2575, best_trials), post jsonb, predicted jsonb (values, lln, z), reversibility jsonb, dlco jsonb (dlco, kco, va, hb_corr), volumes jsonb (tlc, rv, frc), feno_ppb, sixmwt jsonb, interpretation_auto text, interpretation text, curves_key (S3 image/data), status enum(ordered/performed/interpreted/reviewed), signed_by/at, pdf_key; index (hospital_id, patient_id, performed_at desc).
- **sleep_studies**: id, patient_id, type enum(psg/hst/titration/split), bed_id?, scheduled_at, tech_id, hookup_checklist jsonb, device_serial? (HST), report_key, scored jsonb (ahi, rdi, odi, t90, arousal_idx, efficiency, stages, rem_ahi, supine_ahi, plmi), severity enum(none/mild/moderate/severe), interpretation, signed_by/at, status enum(scheduled/in_progress/scored/reported/no_show/cancelled).
- **pap_prescriptions**: id, patient_id, mode enum(cpap/apap/bipap/asv), pressure_min/max, epap/ipap, mask, humidifier, device_item_id?, serial, ownership enum(rental/purchase/own), start_date; **pap_compliance**: id, rx_id, period_from/to, usage_hours_avg, pct_nights_ge4h, residual_ahi, leak, source enum(sd/cloud/manual), report_key, reviewed_by.
- **bronchoscopies**: id, patient_id, encounter_id, procedure_id (OP-010), type, suite_slot, sedation jsonb, findings jsonb (segment map), samples jsonb ([{type, site, lab_order_id, specimen_no}]), complications jsonb, scope_id, reprocessing_log_id (EN-003), aldrete_discharge, report_key, signed_at.
- **resp_action_plans**: id, patient_id, condition enum(asthma/copd), zones jsonb (green/yellow/red thresholds & meds), personal_best_pef, version, issued_at, pdf_key.
- **resp_registry_entries**: patient_id, condition enum(asthma/copd/ild/osa/bronchiectasis), stage jsonb, exacerbations jsonb ([{at, severity, setting}]), oxygen_rx jsonb, inhaler_technique_last jsonb, next_review_at, status.
- **peak_flow_entries** (partitioned): patient_id, at, pef, zone, symptoms, source(app/manual).
- **tb_cases**: id, hospital_id, patient_id, nikshay_id, type enum(presumptive/confirmed_micro/confirmed_clinical), site enum(pulmonary/extrapulmonary), dr_status enum(ds/mono_h/rr_mdr/pre_xdr/xdr), diagnosis_date, notified_at, notification_status enum(pending/sent/ack/failed), regimen jsonb (drugs, weight_band, phase, start/end), dot_type, followups jsonb (sputum months, results), adr jsonb, contacts jsonb, outcome enum, outcome_date, dbt jsonb (bank fields status); index (hospital_id, notification_status), (hospital_id, outcome).
- **home_devices** (`pulmo.home_devices`): id, patient_id, type enum(o2_concentrator/cylinder/cpap/bipap/nebuliser/hst), item_id, serial, ownership, issued_at, return_due, returned_at, rental_bill_ids, service_log jsonb, status.
- Enums: `pft_quality_grade`, `sleep_type`, `osa_severity`, `tb_dr_status`, `tb_outcome`.

## 5. Business Rules & Validations
- Spirometry: predicted via GLI-2012 (sex/age/height/ethnicity: "other/mixed" default for India unless local equations configured); LLN = z −1.645; obstruction if FEV1/FVC < LLN (or < 0.70 fixed ratio per hospital setting — both stored); severity by FEV1 z-score bands (ATS/ERS 2022) with legacy % predicted also shown; reversibility per ATS/ERS 2019 (Δ > 10 % of predicted) with legacy 12 %/200 mL displayed; quality grade < C → interpretation caveat mandatory; height must be measured same day (else warning); Hb for DLCO correction ≤ 30 days old.
- Bronchodilator withhold checklist (SABA 4–6 h, LABA 24 h, LAMA 36–48 h) recorded; TB-infectious patients scheduled last with filter change log.
- Sleep: severity thresholds AHI 5/15/30 (adult) & paediatric rules (AHI ≥ 1); PAP Rx requires signed study; compliance target ≥ 4 h on ≥ 70 % nights → non-adherent flag → tech call task; HST device return overdue > 48 h → escalation.
- Bronchoscopy: platelets ≥ 50k & INR ≤ 1.5 (config) for biopsy or override; consent + time-out; scope reprocessing log mandatory before next use (EN-003 gate); specimens must be barcoded before leaving suite; pathology callback tasks.
- TB: notification within 3 days of diagnosis (timer/escalation); Nikshay ID mandatory to close case; regimen weight-band FDC auto-suggest; drug-drug/hepatotoxicity monitoring (LFT prompts) via EN-029; follow-up sputum tasks; outcome mandatory at end; privacy: TB status visible to care team only (ABAC), no disclosure in queue displays.
- Oxygen: home O2 Rx requires qualifying SpO2/PaO2 documented; concentrator rental billing monthly (OP-005 recurring) until return.
- Action plan versioned; peak-flow zones = 80/50 % personal best (config).
- Reports immutable after sign; device raw files retained; calibration (3-L syringe daily) log required for PFT lab (NC-020) — missing calibration blocks device import unless override.

## 6. API Surface (`/api/v1/pulmo`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /worklist, /pft/worklist, /sleep/schedule, /bronch/schedule | worklists | pulmo.visit.read / pulmo.pft.read / pulmo.sleep.read / pulmo.bronch.read | – | cursor |
| PUT | /encounters/{id}/consult | consult/scores/staging | pulmo.consult.record | Y | – |
| POST/PUT | /pft, /pft/{id}, POST /pft/{id}/interpret, /sign | PFT lifecycle | pulmo.pft.record/interpret/sign | Y | – |
| POST | /pft/predict (calc) | GLI predicted/LLN | pulmo.pft.read | – | – |
| POST | /devices/ingest | spirometer/PSG/PAP payload (EN-042) | device token | Y | – |
| POST/PATCH | /sleep/studies, /sleep/studies/{id}/score, /sign | sleep lab | pulmo.sleep.schedule/record/sign | Y | cursor |
| POST/GET | /pap/rx, /pap/compliance | PAP | pulmo.pap.manage | Y | cursor |
| POST/PATCH | /bronch/bookings, /bronch/{id}/record, /sign | bronchoscopy | pulmo.bronch.schedule/record/sign | Y | – |
| POST/GET | /action-plans, /registry, /peak-flow (patient scope) | chronic care | pulmo.chronic.manage / patient | Y | cursor |
| POST/PATCH/GET | /tb/cases, /tb/cases/{id}/notify, /followup, /outcome | TB programme | pulmo.tb.manage / pulmo.tb.notify | Y | cursor |
| POST/GET/PATCH | /home-devices | O2/CPAP devices | pulmo.device.manage | Y | cursor |
| GET | /reports/ntep?month=, /reports/kpis | reports | pulmo.report.read | – | – |

## 7. Domain Events (outbox)
- `pulmo.consult.signed`, `pulmo.pft.performed|signed` {fev1_z, pattern}, `pulmo.sleep.scheduled|scored|signed`, `pulmo.pap.prescribed|non_adherent`, `pulmo.bronch.booked|completed|specimen_sent`, `pulmo.tb.diagnosed|notified|notification_overdue|outcome`, `pulmo.exacerbation.logged`, `pulmo.device.issued|overdue|returned`, `pulmo.action_plan.issued`, `pulmo.pft.calibration_missing`.
- Consumes: `vitals.recorded` (SpO2/PEF), `lab.result.final` (AFB/CBNAAT → TB case suggestion; ABG; Hb), `op22.result.attached`, `procedure.completed`, `admission.created` (exacerbation link), `er.visit.created` (asthma/COPD codes), `cssd.scope.reprocessed`, `asset.calibration.recorded`.

## 8. Screens (UI)
1. **Pulmo worklist** (desktop) with PFT/sleep/bronch pending chips and TB notification timer badges.
2. **PFT station** (desktop): patient demographics/height entry, device import, trial table with acceptability flags, best-value selection, flow-volume/volume-time curves (device image or plotted from data), pre/post columns, predicted/LLN/z table, auto-interpretation, comments; `Ctrl+I` import, `Ctrl+Enter` send for interpretation.
3. **PFT interpretation** (desktop, pulmonologist): side-by-side prior study, edit interpretation, sign, PDF.
4. **Sleep lab scheduler & night board** (desktop; tablet in lab): beds × nights, hook-up checklist, notes, score import, PAP Rx form; HST device pool.
5. **Bronchoscopy scheduler & record** (desktop/tablet): calendar, readiness gate, segment map for findings, sample list with barcode print, sedation grid (IP-024), Aldrete.
6. **Chronic care dashboard** (desktop): asthma/COPD/OSA cohorts, overdue reviews, non-adherent PAP list, exacerbation heatmap; **Action plan composer** with patient-language PDF.
7. **TB desk** (desktop): case list with notification status/timer, treatment card, follow-up sputum tracker, contacts, outcomes, Ni-kshay sync log.
8. **Patient app**: peak-flow diary with zone colours, action plan, inhaler videos (OP-038), CPAP compliance tips, TB medication reminders.
- Empty/error: import parse failure → manual mode; calibration missing banner.

## 9. Integrations
- EN-042: spirometers/PFT systems (MIR Spirobank/Winspiro, Vitalograph, Cosmed, Vyaire — XML/CSV/PDF), FeNO analyzers, PSG systems (Philips Alice/Natus/Compumedics/ResMed — scored report PDF/XML/EDF metadata), HST devices, PAP compliance (ResMed AirView/Philips DreamMapper PDF; SD card CSV), pulse oximetry overnight (CSV), bronchoscope video capture (OP-022). Ni-kshay API (EN-017 connector; fallback CSV/manual), PACS (HRCT), OP-004 (specimen accession), EN-003 scope reprocessing, NC-006 device rentals, EN-011 FHIR (Observation LOINC 19926-5 FEV1, 19868-9 FVC, 69990-0 AHI).

## 10. Reports & Analytics
- PFT volumes, quality grades, TAT (perform→sign), pattern distribution; sleep lab occupancy, no-show, OSA severity mix, PAP adherence %; bronchoscopy volumes, diagnostic yield, complications; asthma/COPD registry: exacerbations/patient-year, ED visits, inhaler technique compliance, action-plan coverage; TB: NTEP monthly (notifications, DR-TB, outcomes, DBT), notification timeliness %; home devices rental revenue & overdue; pulmonary rehab completion. Read models `analytics.pulmo_pft_daily`, `analytics.tb_cohort`, `analytics.sleep_lab`.

## 11. Notifications
- Patient: PFT/sleep prep instructions (withhold inhalers, sleep hygiene), report ready, PAP compliance review due, device return, TB medication/follow-up sputum reminders (privacy-safe wording), action-plan red-zone advice, rehab sessions. Staff: TB notification overdue, PAP non-adherence, bronch specimen result callbacks, calibration missing, HST device overdue, exacerbation admissions of registry patients.

## 12. Permissions (RBAC keys)
`pulmo.visit.read`, `pulmo.consult.record|sign`, `pulmo.pft.record|interpret|sign|read`, `pulmo.sleep.schedule|record|sign|read`, `pulmo.pap.manage`, `pulmo.bronch.schedule|record|sign|read`, `pulmo.chronic.manage`, `pulmo.tb.manage|notify|read`, `pulmo.device.manage`, `pulmo.report.read`, `pulmo.configure`. Defaults: Pulmonologist — all; PFT tech/RT — pft.record, sleep.record, pap.manage (compliance), device.manage; Sleep tech — sleep.*, pap.manage; Bronch nurse — bronch.record; TB health visitor — tb.manage/read; Resident — record no sign; Physio — chronic read.

## 13. Non-functional
- Volumes: 200 pulmo visits/day, 80 PFTs, 8 sleep beds/night, 15 bronchoscopies/day, TB cohort 2 000 active; PFT import→display < 2 s; predicted calc < 20 ms; peak-flow diary 5k entries/day (partitioned). Offline: consult/PFT manual forms cached. Print: PFT report with curves, sleep report, PAP Rx, action plan (regional languages, pictorial zones), TB treatment card (NTEP format). Privacy: TB/HIV status ABAC restricted.

## 14. Acceptance Criteria (plus OP-025 §0.9)
1. Given a 45-y male, 170 cm, FEV1 2.10 L, FVC 3.60 L, then GLI predicted/LLN/z-scores compute and pattern "obstruction" flags when FEV1/FVC z < −1.645; report shows both z-based and % predicted severity.
2. Given post-BD FEV1 increases 14 % and 250 mL, then reversibility "significant" under both ATS/ERS 2019 and legacy criteria and the report states both.
3. Given only 2 acceptable trials with grade D, then interpretation requires a quality caveat and the report watermark "limited quality".
4. Given no 3-L syringe calibration recorded today, when importing spirometry, then a block appears requiring calibration entry or supervisor override.
5. Given a PSG scored AHI 32, then severity "severe", PAP Rx form enabled; a PAP compliance upload of 3.1 h/night on 55 % nights flags non-adherent and creates a tech call task.
6. Given a bronchoscopy booking with platelets 40k and TBLB planned, then readiness blocked until override; scope reuse without reprocessing log is blocked.
7. Given CBNAAT positive from OP-004, then a presumptive TB case is auto-suggested; on confirmation, a 3-day notification timer starts and overdue escalates to HOD.
8. Given TB case notified via connector, then Nikshay ID stored and treatment card generated with weight-band FDC regimen.
9. Given an asthma action plan with personal best 450 L/min, then zones are 360/225 and the patient app colours diary entries accordingly; red-zone entry triggers advice + nurse alert.
10. Given a home oxygen concentrator issued on rental, then monthly rental bill lines post until return and overdue return alerts fire.
11. Given a technician tries to sign a PFT interpretation, then 403 and audit.
12. Given an HST device not returned 3 days after issue, then escalation & patient reminder occur.

## 15. Enhancements / Later phases
- Sheet row 67 (PFT, Spirometry, Sleep study, Bronchoscopy scheduling) — core. Market: TB programme/Ni-kshay, asthma/COPD registry & action plans, PAP compliance, home devices.
- Later: EDF raw PSG storage/viewer, AI-007 CXR/HRCT assist, tele-spirometry kits for camps (NC-035), smart inhaler adherence APIs, occupational lung disease registry, air-quality alerts to patients (AQI feed), pulmonary rehab home programme (PE-001).

## 16. Open Questions for the Hospital
1. PFT devices & export formats; predicted equations preference (GLI vs Indian); fixed-ratio vs LLN policy?
2. Sleep lab beds/HST devices; PAP vendor & compliance download method; rental vs sale?
3. Bronchoscopy suite location (endoscopy/OT), sedation practice, scope reprocessing tracking?
4. TB notification via Ni-kshay API access (private notification credentials)? DOTS provider model?
5. Home oxygen/CPAP inventory & billing policy?
