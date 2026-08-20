# IP-011 — Labour Room & Newborn (labour admission, digital partograph WHO/LCG, FHR, delivery record, complications/PPH protocol, newborn registration & baby UHID, APGAR, newborn exam, mother-baby linking, birth certificate/CRS, breastfeeding)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | IP / Inpatient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Module ID       | IP-011                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase           | 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Priority        | P2 (P0 where a maternity unit exists)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Depends on      | OP-040 (antenatal clinic: ANC record, EDD, risk flags), OP-001 (patient MPI: mother, newborn UHID creation), IP-001 (labour room beds, mother & newborn admissions), IP-003 (nursing, MEOWS vitals, MAR), IP-006 (LSCS as OT case), IP-024 (obstetric anaesthesia), IP-007 (blood/MTP for PPH), IP-009/IP-015 (maternal ICU / NICU), OP-004 (labs, cord blood, newborn screening), OP-013 (BCG/OPV/HepB birth doses, U-WIN), OP-033 (paediatrics follow-up), EN-013 (mother-baby wristbands), EN-042 (CTG/FHR monitors), EN-028 (consents), EN-039 (forms), IP-002 (discharge), IP-005/IP-008 (maternity packages), IP-012 (infection control), EN-009 (family messages), NC-003 (MRD), EN-024 (audit), NC-015 (maternal/neonatal death review) |
| Feature flag    | `module.labour_room.enabled` (sub: `lr.lcg_partograph`, `lr.ctg_integration`, `lr.crs_integration`, `lr.pph_protocol`, `lr.kangaroo_care`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Primary roles   | Obstetrician (6/7), Labour room nurse/midwife (17), Paediatrician/Neonatologist (7), Anaesthetist (10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Secondary roles | Resident (14), Ward nurse (17), Lactation counsellor, MRD (43, birth reporting), Front office (24, birth certificate), Blood bank (37), Quality (54), Family (60), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Regulatory      | Registration of Births & Deaths Act 1969 & Rules (birth report Form 1 within 21 days to Registrar; CRS portal), PCPNDT Act 1994 (no sex disclosure; records), MTP Act 2021 (where applicable), NABH COP (obstetric care, newborn identification, MEOWS), WHO Labour Care Guide 2020 (LCG partograph; alert/action lines in classic WHO partograph), FIGO/WHO PPH guidelines (MTP, TXA, uterotonics), LaQshya (labour room quality — MoHFW), JSSK/JSY scheme documentation, IMNCI/FBNC newborn care, NBSU/SNCU norms, National Newborn Screening (state), U-WIN birth-dose vaccination, DPDP                                                                                                                                                     |

## 1. Purpose

IP-011 manages the intrapartum and immediate postpartum episode: quick labour admission with obstetric history, a digital partograph (WHO classic alert/action lines or WHO Labour Care Guide 2020) with FHR/contractions/cervical dilatation/descent/maternal vitals (MEOWS) and automatic alerts on crossing lines, delivery documentation (mode, timings, third stage, perineum, blood loss, complications with PPH protocol and MTP hook), newborn auto-registration with its own UHID linked to the mother ("Baby of <mother>", later renamed), APGAR at 1/5/10 min, resuscitation record, newborn examination and screening (hearing, metabolic, congenital anomaly, hypoglycaemia), mother–baby wristband pairing to prevent mix-ups, breastfeeding/skin-to-skin documentation, birth-dose vaccinations, and statutory birth reporting (Form 1 → Civil Registration System) plus hospital birth certificate.

## 2. Users & Jobs-to-be-done

- **Midwife/labour nurse** (tablet at bedside): admit in labour in < 3 min, plot partograph every 30 min/4-hourly per stage, capture FHR (auscultation/CTG), maternal vitals (MEOWS), respond to alerts, document delivery & newborn care, pair wristbands, breastfeeding initiation.
- **Obstetrician**: review partograph remotely (phone), decide augmentation/instrumental/LSCS (IP-006 emergency case), document delivery/complications, PPH management, sign records.
- **Paediatrician**: attend delivery when flagged, APGAR/resuscitation, newborn exam, NICU admission decision (IP-015), discharge exam, birth-dose vaccines.
- **Anaesthetist**: labour analgesia/epidural record (IP-024).
- **Front office/MRD**: birth certificate issue, CRS Form 1 filing, JSY/JSSK documentation.
- **Family**: birth notification (no sex disclosure pre-birth; post-birth per consent), visiting.

## 3. Core Workflows

### 3.1 Labour admission

1. **Nurse/doctor** admits (IP-001 admission type `maternity`; ANC record pulled from OP-040 or entered: LMP/EDD/USG-EDD, gestational age auto, gravida/para/abortions/living (G-P-A-L), blood group/Rh & antibody, high-risk flags (PIH, GDM, previous LSCS, malpresentation, multiple, anaemia, placenta praevia, Rh-neg, HIV/HBsAg/VDRL status), allergies) → **labour assessment**: onset time, membrane status (intact/SROM/ARM; liquor colour), contractions (frequency/duration/strength), cervical exam (dilatation, effacement, station, position, consistency), presentation, FHR, maternal vitals → **stage of labour** & partograph start criteria (active phase ≥ 4–5 cm per chosen standard) → consents (EN-028: delivery/LSCS/anaesthesia/blood/newborn procedures) → Event `lr.admitted` → paediatrician alert if high-risk; blood group & save/cross-match request (IP-007) per policy.

### 3.2 Digital partograph & monitoring (`lr.lcg_partograph`)

- Configurable standard: **WHO classic** (alert line from 4 cm at 1 cm/h, action line 4 h right) or **WHO Labour Care Guide 2020** (reference thresholds per parameter, first stage from 5 cm, second stage sections, supportive care columns) → grid entries: cervical dilatation (4-hourly or per exam), descent (fifths palpable), contractions per 10 min & duration bands, FHR q30 min (q15 second stage; CTG traces via EN-042 `lr.ctg_integration` with baseline/variability/decelerations classification NICE/FIGO), liquor, moulding, caput, maternal pulse/BP/temp/RR/urine (protein/ketones/volume), oxytocin dose/rate, drugs/fluids given (MAR IP-003), pain relief, position/mobility, oral intake, companion presence (LaQshya) → **alerts**: crossing alert line → obstetrician notified; crossing action line → escalation & decision documentation required (augmentation/instrumental/LSCS/refer); FHR < 110/> 160 or abnormal CTG → immediate alert; MEOWS triggers (IP-003) → maternal escalation; prolonged second stage timers (nulli/multi, epidural adjustments); Event `lr.partograph.alert`.
- Remote view for obstetrician (IP-010) with live updates; print/PDF of partograph for records.

### 3.3 Delivery documentation

- **Delivery record**: mode (spontaneous vaginal / assisted vacuum / forceps / LSCS elective / emergency (IP-006 case link, indication, decision-to-delivery interval) / breech / twins order), time of delivery per baby, place (LR/OT/other), attendant(s), episiotomy/tears (degree) & repair, third stage (active management: uterotonic drug/dose/time, cord traction, placenta time/completeness/weight, cord blood samples), estimated blood loss (measured drapes/gravimetric), perineal care, urine passed, uterus tone, **complications** (PPH, shoulder dystocia with manoeuvres & timings, cord prolapse, uterine rupture, retained placenta, eclampsia, sepsis, obstructed labour) → **PPH protocol** (`lr.pph_protocol`): trigger at EBL ≥ 500 mL vaginal/≥ 1000 mL LSCS or haemodynamic signs → checklist timers (call for help, uterotonics sequence, TXA ≤ 3 h, bimanual compression, balloon tamponade, IP-007 MTP button, OT), documentation of each step → Event `lr.pph.activated`; maternal death → NC-015 maternal death review (MDSR).
- Postpartum: fourth-stage monitoring q15 min × 2 h (vitals, fundus, bleeding), analgesia, catheter, VTE risk, Rh-neg → anti-D order, breastfeeding initiation within 1 h & skin-to-skin timer (`lr.kangaroo_care`), family notification (EN-009 template without sex where policy demands; PCPNDT compliance — sex disclosed only after birth and recorded).

### 3.4 Newborn registration & care

1. At birth **System** auto-creates newborn patient (OP-001: temporary name "Baby of <mother name>", sex, DOB/time, `mother_patient_id` link, own **UHID**) and admission (IP-001 `newborn`, `mother_admission_id`, rooming-in bed/bassinet or NICU IP-015) → **wristbands** (EN-013) for baby (two bands: ankle + wrist) & mother with matching pair code; **pairing verification** by scanning both at every handover/feed pickup → mismatch hard-stop → Event `lr.newborn.registered`.
2. **Immediate care**: APGAR 1/5 (10 if < 7) with components, resuscitation record (steps per NRP/NALS: drying, stimulation, PPV start time, chest compressions, intubation, drugs, times), birth weight/length/head circumference (percentiles WHO/Fenton), temperature, vitamin K, eye care, cord care, first breastfeed time, delayed cord clamping recorded, cord blood gas if taken; hypoglycaemia screening for at-risk; identification footprints (optional scan).
3. **Newborn examination** (within 24 h; discharge exam): head-to-toe with congenital anomaly checklist, hip (Ortolani/Barlow), red reflex, heart (murmur, pulse-ox CCHD screen), genitalia, spine; **screening**: hearing (OAE/AABR result & follow-up), metabolic (state panel: TSH, G6PD, CAH, etc. — OP-004 orders with sample time ≥ 24–48 h), bilirubin (TcB/serum with hour-specific nomogram & phototherapy threshold alerts), jaundice; **birth-dose vaccines** (BCG, OPV-0, Hep B birth dose) via OP-013 with U-WIN entry; feeding record (breast/expressed/formula with reason), stools/urine, weight trend; NICU transfer (IP-015) with SBAR.
4. Naming: temporary name replaced with legal name (front office/MRD) — UHID unchanged; identifiers updated everywhere via OP-001 events.

### 3.5 Birth reporting & certificate (`lr.crs_integration`)

- **Form 1 (birth report)** auto-populated (place, date/time, sex, weight, mother/father names, address, religion (optional), mother's age/education/occupation, birth order, gestation, delivery type, attendant, informant) → MRD verifies → submitted to Registrar (CRS portal upload/API where available; else printed) within 21 days → registration number captured; **hospital birth certificate/notification** printed with hospital seal (not the statutory certificate) & digital copy to parents (portal/WhatsApp); JSY/JSSK/state scheme forms; stillbirth (Form 3) & neonatal death (Form 2) paths with review (NC-015).

### 3.6 Exceptions

1. Born before arrival (BBA) → admission with delivery details as reported; newborn registered.
2. Stillbirth/IUD → no live newborn record; stillbirth register; bereavement support; Form 3.
3. Multiple births → per-baby records; delivery order; wristband pairs unique.
4. Mother unconscious/eclampsia → consent path (next of kin/emergency); ICU (IP-009).
5. Baby abduction/mismatch attempt → wristband mismatch alarms security (NC-019).
6. CTG device offline → manual FHR entries; traces uploaded later.

## 4. Data Model (schema `specialty.obstetrics` → `obs`)

- **obs.labour_episodes** (id, hospital_id, branch_id, admission_id, patient_id, anc_record_id?, lmp, edd, ga_weeks_days, gpal jsonb, risk_flags text[], blood_group, rh, onset_at, membrane_status, membrane_rupture_at, liquor, presentation, stage_at_admission, partograph_standard enum(who_classic/lcg), companion_present bool, consents jsonb, outcome enum(vaginal/assisted/lscs/referred/undelivered), completed_at, version).
- **obs.partograph_entries** (episode_id, at, param enum(dilatation/descent/contractions/fhr/liquor/moulding/caput/pulse/bp/temp/rr/urine/oxytocin/drug/fluid/pain_relief/position/intake), value jsonb, entered_by, source enum(manual/ctg)) — index (episode_id, at); **obs.partograph_alerts** (episode_id, at, type enum(alert_line/action_line/fhr_abnormal/meows/second_stage_prolonged/other), details, notified uuid[], acknowledged_by, decision).
- **obs.ctg_traces** (episode_id, started_at, ended_at, file_id, classification, reviewed_by).
- **obs.deliveries** (episode_id, baby_seq, mode enum, delivered_at, place, attendants jsonb, indication, ot_case_id?, decision_to_delivery_min?, episiotomy bool, tear_degree, repair_by, third_stage jsonb, placenta jsonb, ebl_ml, ebl_method, complications jsonb, pph_activation_id?, notes, signed_by, signed_at).
- **obs.pph_activations** (delivery_id, at, trigger, steps jsonb [{step, at, by}], mtp_activation_id?, ot_case_id?, outcome, deactivated_at).
- **obs.postpartum_monitoring** (episode_id, at, vitals jsonb, fundus, bleeding, by) (or IP-003 vitals with tag).
- **obs.newborns** (id, hospital_id, patient_id (baby UHID), mother_patient_id, mother_admission_id, admission_id, delivery_id, birth_at, sex, birth_weight_g, length_cm, hc_cm, ga_weeks, apgar_1, apgar_5, apgar_10?, apgar_components jsonb, resuscitation jsonb, vitamin_k_at, cord_clamp_delayed bool, first_feed_at, skin_to_skin_min, wristband_pair_code, nicu_admitted bool, temp_name bool, status).
- **obs.newborn_exams** (newborn_id, type enum(initial/24h/discharge), at, by, findings jsonb, anomalies jsonb, cchd_screen jsonb, hip, red_reflex, weight); **obs.newborn_screenings** (newborn_id, type enum(hearing/metabolic/bilirubin/glucose/other), at, result, follow_up_due, order_id?); **obs.feeding_log** (newborn_id, at, type, duration_min, issues, by).
- **obs.identity_checks** (newborn_id, at, mother_band_scan, baby_band_scan, match bool, by, context).
- **obs.birth_reports** (newborn_id, form1 jsonb, verified_by, submitted_at, crs_reg_no, file_id, hospital_cert_no, issued_at); **obs.stillbirths** (episode_id, at, weight, ga, form3 jsonb); **obs.maternal_deaths** (episode_id, at, cause, mdsr_ref).
- Read models: `analytics.mv_obstetric_kpis`.

## 5. Business Rules & Validations

- Partograph entries per standard cadence; alert-line crossing → obstetrician alert; action-line crossing → decision mandatory before further plotting; abnormal FHR → immediate alert; second-stage limits (nullipara 3 h with epidural/2 h without; multipara 2 h/1 h) timers.
- Sex of foetus never displayed/recorded before birth (PCPNDT); post-birth sex recorded and disclosed per policy; USG reports masked (OP-008).
- Newborn UHID auto-created within the delivery save; mother–baby link mandatory; wristband pair codes unique; identity check required at every handover/discharge (mismatch hard-stop + security alert).
- APGAR 1 & 5 mandatory; 10 min if 5-min < 7; resuscitation timeline required when PPV given.
- PPH activation thresholds configurable; TXA within 3 h prompt; MTP link; EBL measured method recorded.
- Rh-negative mother → anti-D order prompt within 72 h if baby Rh-positive.
- Metabolic screening sample timing 24–72 h; hearing screen before discharge or follow-up appointment; bilirubin nomogram alerts.
- Birth-dose vaccines before discharge (BCG/OPV-0/HepB-0) with U-WIN entry (OP-013).
- Form 1 within 21 days; stillbirth/neonatal/maternal deaths → statutory forms + reviews.
- Records signed by attending clinician; append-only; retention per state (≥ 10 y; birth records permanent).

## 6. API Surface (`/api/v1/obs`)

| Method    | Path                                                                                                                                   | Purpose                           | Permission               | Idem         | Pag            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------ | ------------ | -------------- |
| POST      | /labour-episodes                                                                                                                       | admit in labour                   | obs.labour.create        | Y            | –              |
| GET/PATCH | /labour-episodes/{id}                                                                                                                  | episode                           | obs.labour.read / update | Y            | –              |
| POST      | /labour-episodes/{id}/partograph                                                                                                       | add entries (batch)               | obs.partograph.write     | Y            | –              |
| GET       | /labour-episodes/{id}/partograph                                                                                                       | grid + alerts                     | obs.partograph.read      | –            | –              |
| POST      | /partograph-alerts/{id}/ack                                                                                                            | acknowledge + decision            | obs.partograph.ack       | Y            | –              |
| POST      | /labour-episodes/{id}/ctg                                                                                                              | trace upload/classification       | obs.partograph.write     | Y            | –              |
| POST      | /labour-episodes/{id}/deliveries                                                                                                       | delivery record (creates newborn) | obs.delivery.write       | Y            | –              |
| POST      | /deliveries/{id}/pph/activate                                                                                                          | step                              | deactivate               | PPH protocol | obs.pph.manage | Y   | –   |
| POST      | /labour-episodes/{id}/postpartum                                                                                                       | monitoring entries                | obs.postpartum.write     | Y            | –              |
| GET/PATCH | /newborns/{id}                                                                                                                         | newborn record                    | obs.newborn.read / write | Y            | –              |
| POST      | /newborns/{id}/exams, /screenings, /feeding                                                                                            | newborn care                      | obs.newborn.write        | Y            | cursor         |
| POST      | /newborns/{id}/identity-check                                                                                                          | scan mother+baby bands            | obs.identity.verify      | –            | –              |
| POST      | /newborns/{id}/wristbands/print                                                                                                        | pair print                        | obs.newborn.write        | Y            | –              |
| POST      | /newborns/{id}/birth-report (draft/verify/submit)                                                                                      | Form 1 / CRS                      | obs.birth.report         | Y            | –              |
| GET       | /newborns/{id}/birth-certificate/pdf                                                                                                   | hospital certificate              | obs.birth.print          | –            | –              |
| POST      | /stillbirths, /maternal-deaths                                                                                                         | statutory records                 | obs.delivery.write       | Y            | –              |
| GET       | /reports/kpi?from=                                                                                                                     | obstetric KPIs                    | obs.report.read          | –            | –              |
| Consumes  | `ip.admitted{maternity}`, `ot.case.completed{lscs}`, `lab.result.available`, `device.ctg.trace` (EN-042), `vaccination.given` (OP-013) |                                   |                          |              |                |

## 7. Domain Events (outbox)

- `lr.admitted` {episode_id, risk_flags} → paediatrics on-call, IP-007 (group & save), IP-003.
- `lr.partograph.alert` {type} / `lr.partograph.alert_acknowledged` → obstetrician (IP-010), EN-037.
- `lr.delivered` {mode, babies[]} → IP-001 (newborn admission), OP-001 (baby UHID), IP-005 (delivery charges/package), EN-009 (family), NC-003.
- `lr.pph.activated|deactivated` → IP-007 (MTP), IP-006, IP-009, NC-015.
- `lr.newborn.registered` {baby_patient_id, mother_patient_id, pair_code} → EN-013 bands, OP-013 (birth doses), OP-033, IP-015 if NICU.
- `lr.newborn.identity_mismatch` → NC-019 security, nurse supervisor.
- `lr.newborn.screening.recorded|followup_due`; `lr.birth.reported` {crs_reg_no}; `lr.stillbirth.recorded`, `lr.maternal_death.recorded` → NC-015 MDSR.

## 8. Screens (UI)

- **Labour Room Board** (desktop/TV): beds with stage, dilatation, time in stage, last FHR, alerts, MEOWS, obstetrician; real-time.
- **Labour Admission** (tablet): obstetric history quick form, risk flags auto, exam entry, consents; `Ctrl+S`.
- **Digital Partograph** (tablet landscape/desktop): WHO/LCG grid with plotted lines (alert/action), FHR/contraction rows, vitals rows, oxytocin row, drug/fluid row; tap-to-plot; alert banners; CTG panel; obstetrician remote view (phone) with live update; print PDF.
- **Delivery Record** (tablet): mode, timings (big time buttons), third stage, EBL, tears/repair, complications; PPH protocol drawer with timers/step ticks and MTP button; sign.
- **Newborn Card** (tablet): APGAR entry with components, resuscitation timeline, measurements with percentiles, vitamin K/feeds/skin-to-skin timer, wristband print & pair check (scan both), exam checklist, screenings, vaccines status.
- **Birth Reporting** (desktop MRD/front office): Form 1 draft, verify, submit/print, certificate print, register.
- **Family notification** (WhatsApp/SMS templates) per consent; portal newborn card.

## 9. Integrations

- EN-042 CTG/FHR monitors (vendor export/HL7), EN-013 wristband printers (pair codes), OP-004 (cord blood, TSH/G6PD, bilirubin), OP-013/U-WIN, CRS portal (state; API/upload), IP-007 (MTP), IP-006 (LSCS), IP-024, IP-015 (NICU), OP-040 (ANC), EN-009 (family), JSY/JSSK/state scheme portals (file export).

## 10. Reports & Analytics

- Deliveries by mode (LSCS rate, Robson classification), partograph completion & action-line compliance, decision-to-delivery interval for emergency LSCS, PPH incidence & MTP, third/fourth-degree tears, episiotomy rate, APGAR < 7 at 5 min, birth weights/LBW %, NICU admissions, breastfeeding within 1 h %, skin-to-skin, birth-dose vaccination coverage, screening completion & follow-up, stillbirths/neonatal/maternal deaths (MDSR), Form 1 timeliness, LaQshya indicators.
- Read model `analytics.mv_obstetric_kpis`.

## 11. Notifications

- Obstetrician: alert/action line, abnormal FHR, MEOWS, PPH; Paediatrician: high-risk delivery imminent, resuscitation, abnormal screening; Blood bank: PPH/MTP; Family: birth notification (consented), certificate ready; MRD: Form 1 due; Nurse: screening due, vaccine due, feeding reminders; Security: identity mismatch.

## 12. Permissions (RBAC keys)

`obs.labour.create|read|update`, `obs.partograph.read|write|ack`, `obs.delivery.write`, `obs.pph.manage`, `obs.postpartum.write`, `obs.newborn.read|write`, `obs.identity.verify`, `obs.birth.report|print`, `obs.report.read|export`.
Defaults: Labour nurse/midwife (17): labour.create/update, partograph.write, delivery.write (assisted by doctor sign), postpartum, newborn.write, identity.verify; Obstetrician: all incl. ack, pph.manage, sign; Paediatrician: newborn.*; MRD/Front office: birth.report/print; Quality: reports; Family: portal read of newborn card.

## 13. Non-functional

- Volumes: 20–40 deliveries/day; partograph entries q30 min per active labour (~1.5k/day); CTG trace files ≤ 20 MB; alerts < 3 s.
- Offline: bedside tablet queues partograph/delivery/newborn entries (IP-004 layer); alerts computed on sync + locally for line crossing.
- Printing: partograph PDF, delivery record, APGAR card, wristband pairs, hospital birth certificate (A4 with seal/QR), Form 1.
- Security/PCPNDT: sex masking pre-birth; PHI-free family messages; audit; permanent retention of birth records.

## 14. Acceptance Criteria

1. Given a labour admission at 5 cm with WHO classic standard, then the partograph starts with the alert line at 1 cm/h and the action line 4 h to the right; a plot of 6 cm at +3 h (below alert line) triggers an obstetrician alert.
2. Given dilatation crosses the action line, then further plotting requires an acknowledged decision (augment/instrumental/LSCS/refer) recorded with time.
3. Given FHR entered as 100 bpm, then an immediate abnormal-FHR alert reaches the obstetrician and the nurse; with CTG integration, a pathological classification does the same.
4. Given a delivery saved at 03:12 (vaginal, female baby, 3.1 kg), then a newborn patient with its own UHID and temporary name "Baby of <mother>" is created, linked to the mother, admitted as `newborn`, and two wristband pairs print with the same pair code.
5. Given a mother's band scanned with a different baby's band, then the identity check fails with a hard-stop, and security and the supervisor are alerted.
6. Given APGAR 5-min = 6, then the 10-min APGAR becomes mandatory and the paediatrician is notified; PPV documented starts a resuscitation timeline.
7. Given EBL 650 mL vaginal, then the PPH protocol activates with timers (uterotonics, TXA ≤ 3 h, MTP button); each step's time and person are recorded; MTP activation reaches IP-007 within 5 s.
8. Given twins, then two newborn records with delivery order 1 and 2 and distinct pair codes are created.
9. Given the mother is Rh-negative and baby Rh-positive, then an anti-D order prompt appears within the 72-h window.
10. Given a metabolic screening sample at 12 h of life, then the system warns of early sampling (24–72 h) and schedules a repeat.
11. Given birth-dose vaccines not given before discharge initiation, then IP-002 gate check warns and OP-013 task is created; given vaccines recorded, U-WIN entry is queued.
12. Given Form 1 drafted from the record, then all mandatory fields validate, MRD verification is required before submission, and CRS registration number is stored; the hospital certificate PDF renders with QR.
13. Given a USG report during pregnancy, then foetal sex fields are masked everywhere in IP-011 (PCPNDT) and no notification contains sex before birth.
14. Given a stillbirth, then no newborn admission is created, a stillbirth record with Form 3 data is stored and a review task is created.
15. Given the labour room tablet is offline for 20 minutes, then partograph entries queue and, on sync, line-crossing alerts are evaluated with the original timestamps.

## 15. Enhancements / Later phases

- From VIMS sheet row 26: high-risk pregnancy alert system (flags here; predictive AI-005 later), MEOWS (via IP-003 here), PPH protocol trigger (here), skin-to-skin timer (here), breastfeeding initiation documentation (here), neonatal sepsis screening (risk calculator later with IP-015).
- (market) obstetric case record antepartum/intrapartum/postnatal/outcomes with billing integration (here + OP-040/IP-005). Later: CTG AI interpretation (AI-007-like), Robson auto-classification dashboards, LaQshya certification pack, breastfeeding app support (PE-001), newborn growth follow-up (OP-033).

## 16. Open Questions for the Hospital

1. Maternity unit size, deliveries/month, NICU/SNCU level; partograph standard (WHO classic vs LCG)?
2. CTG monitor models & export capability; central monitoring?
3. Wristband printer availability in LR; pair-code policy; footprint capture?
4. PPH protocol/MTP composition; TXA policy; blood availability agreements?
5. Newborn screening panel per state; hearing screening equipment; bilirubin devices?
6. Birth registration process (CRS portal access, registrar office, hospital certificate format), JSY/JSSK reporting?
7. Family notification policy (timing, sex disclosure, channels)?
8. Maternity packages and charge composition (IP-005/IP-008)?
