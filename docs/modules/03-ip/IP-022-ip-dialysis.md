# IP-022 — IP Dialysis (inpatient HD/SLED/CRRT/PD orders, session scheduling with machine & slot assignment incl. bedside ICU dialysis, pre/intra/post-session vitals & fluid balance, dialyser/tubing reuse & isolation-machine control, anticoagulation, complications, water/RO quality, charging)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-022 |
| Phase | 8 |
| Priority | P2 |
| Complexity | Medium–High |
| Depends on | OP-012 (Dialysis OP: unit/machine master, dialysis prescription engine, session flowsheet, reuse log, water treatment log — IP-022 extends for admitted patients), IP-001 (dialysis unit beds/chairs as temporary-away locations or dialysis ward beds; transport), IP-003 (ward vitals/I-O integration, MAR heparin/EPO/iron, tasks), IP-009 (ICU: CRRT/SLED bedside; hourly flowsheet; fluid balance targets), OP-002 (CPOE dialysis orders), OP-004 (labs: pre/post urea (URR/Kt/V), K+, Hb, HBsAg/HCV/HIV markers), IP-007 (blood transfusion during dialysis), IP-014 (heparin, dialysate, EPO stock; consumables per session), NC-006 (dialysers, tubing, bicarbonate cartridges — batch/lot), NC-020/EN-042 (dialysis machines: asset PM, disinfection logs, machine data via HL7/serial; RO plant sensors), IP-012 (isolation machines for HBV/HCV/HIV; infection control; BSI surveillance for catheters), IP-005/IP-008 (session charges, packages, scheme rates PMJAY/state dialysis programmes RC-007), IP-018 (transport to unit), IP-020 (AKI/CKD pathways), IP-002 (discharge with maintenance HD schedule to OP-012), EN-037, EN-024, EN-018 (unit board), NC-015 (indicators) |
| Feature flag | `module.ip_dialysis.enabled` (sub-flags: `ipdial.crrt`, `ipdial.pd`, `ipdial.machine_feed`, `ipdial.reuse`) |
| Primary roles | Dialysis Technician (41), Nurse — dialysis/ICU (17/18), Nephrologist (6/7), Intensivist (11), Resident (14) |
| Secondary roles | Biomedical (48), Infection control (21), Pharmacist (31), Billing (27/28), Ward boy/transport (23), Bed manager (IP-025), Quality (54), Patient/Family (59/60), Auditor (58) |
| Regulatory | NABH 5th ed. COP.17-style dialysis standards (safety, water quality, reuse policy, infection control), AAMI/ISO 23500 (dialysis water & dialysate quality: chemical/microbial/endotoxin limits, RO monitoring), ISN/KDOQI/KDIGO (adequacy targets Kt/V ≥ 1.2, URR ≥ 65 %; AKI RRT indications), CDC/NACO guidelines for HBV/HCV/HIV segregation & dedicated machines, Drugs & Cosmetics (dialysate/heparin), BMW Rules 2016 (dialysers, tubing), CDSCO UDI (dialysers, catheters), PMDP/state free dialysis schemes reporting (RC-007), DPDP |

## 1. Purpose
IP-022 manages renal replacement therapy for admitted patients: nephrologist/intensivist orders (intermittent HD, SLED, CRRT modalities CVVH/CVVHD/CVVHDF, PD), scheduling on unit machines/slots or bedside ICU machines with strict isolation-machine rules for seropositive patients, technician-led session flowsheet (pre/intra/post vitals, UF targets, blood flow, dialysate, anticoagulation, alarms, complications), fluid balance integrated with the ward/ICU I-O chart, dialyser reuse control, machine disinfection and RO/water quality logs, adequacy tracking, consumables/charging per session, and hand-off to maintenance dialysis (OP-012) at discharge.

## 2. Users & Jobs-to-be-done
- **Nephrologist/intensivist** (desktop/IP-010): prescribe RRT (modality, duration, UF goal, dialysate composition K/Ca/HCO3, dialyser, blood flow, anticoagulation, access, target weight, meds during HD), review session outcomes, adjust CRRT doses hourly in ICU (with IP-009 flowsheet), decide frequency and discharge plan.
- **Dialysis technician/nurse** (tablet at machine/desktop): daily schedule per shift, machine allocation (isolation), pre-session checks (weight, vitals, access assessment, machine self-test, dialysate conductivity/temperature), intra-session monitoring q30 min (BP/HR/QB/QD/TMP/venous & arterial pressures/UF rate/alarms), medication administration during HD (IP-003 MAR), complications & interventions, post-session (weight, vitals, UF achieved, access haemostasis, dialyser reuse processing), machine disinfection log.
- **Ward/ICU nurse**: transport prep, hold pre-dialysis meds, I/O sync, post-dialysis monitoring; ICU nurse charts CRRT hourly (fluid removal, filter pressures, circuit changes, citrate/calcium).
- **Biomedical**: machine PM/calibration, RO plant maintenance & water tests; breakdown swaps.
- **Billing/TPA**: per-session charges (modality, dialyser new/reuse, consumables, meds), packages/schemes.
- **Bed manager**: dialysis unit chair/slot capacity, ICU bedside machine availability.

## 3. Core Workflows

### 3.1 Prescription & scheduling
1. **Doctor** orders RRT (`dialysis_prescriptions` linked to CPOE order): modality (HD/SLED/CRRT-CVVH/CVVHD/CVVHDF/PD-CAPD/APD), indication (AKI/CKD5D maintenance/overload/hyperkalaemia/toxin), frequency/schedule (e.g., alternate days ×3, daily SLED 8 h, CRRT continuous), duration, dry/target weight, UF goal (or "as tolerated with max"), blood flow (QB), dialysate flow (QD), dialysate composition (K 2/3/4, Ca 1.25/1.5/1.75, HCO3, Na, glucose), temperature, dialyser type/size (KUF), reuse allowed, **anticoagulation** (heparin bolus/infusion, LMWH, citrate regional (CRRT), none/saline flushes with reason e.g., bleeding), access (AV fistula/graft/tunnelled catheter/temporary catheter — site, insertion date), meds during HD (EPO, iron, vitamin D, antibiotics post-HD), CRRT dose (ml/kg/h effluent), replacement fluid pre/post, seropositivity status (HBsAg/HCV/HIV from OP-004 or manual → isolation), special (blood transfusion planned, ICU bedside) → Event `dialysis.ip.prescribed`.
2. **Scheduling**: unit coordinator/technician assigns sessions to **slots** (unit shifts e.g., 3 shifts × 4–5 h) and **machines** (`dialysis_machines` from OP-012 master: id, type, HBV/HCV/HIV-dedicated flags, location unit/ICU-portable, status available/in-use/disinfecting/maintenance/quarantine) with rules: seropositive → dedicated machine & isolated bay; ICU patient → bedside portable machine + RO/water supply check; emergency (hyperkalaemia) → next available slot with priority; transport task (IP-001) 30 min before; conflicts with OT/imaging (IP-018 temporary away) shown; patient/family informed; Event `dialysis.ip.scheduled`.
3. **Pre-dialysis ward prep** tasks (IP-003): hold antihypertensives per order, weight, labs drawn (pre-HD K+/urea if ordered), access dressing check, consent (first session; EN-028), NPO not required; catheter lock removal note.

### 3.2 Session execution (HD/SLED)
1. **Pre-session** (technician tablet): patient identity (wristband scan), machine self-test pass, dialysate conductivity/temperature/pH within range, dialyser (new: lot/UDI scan; reused: reuse no. & volume test result), tubing lot, access assessment (thrill/bruit; catheter site score), pre-weight (bed scale/chair scale), vitals, target UF computed = pre-weight − dry weight (+ intake during session) capped by max UF rate (ml/kg/h — warns > 13), anticoagulation dose confirmation (two-person for heparin bolus per policy), needle gauge/cannulation record; start time; Event `dialysis.session.started`.
2. **Intra-session** q30 min (or `ipdial.machine_feed` auto from machine every 1–5 min): BP/HR/temp, QB, QD, arterial/venous pressure, TMP, UF rate/cumulative, conductivity, heparin rate, alarms; **complications** with interventions (hypotension → saline/UF pause/Trendelenburg; cramps; chills/rigor → blood cultures, stop; chest pain; arrhythmia; air/blood leak; clotting; access bleeding; needle dislodgement) → EN-029 rules alert nurse/doctor (SBP < 90, drop > 30 %); intradialytic meds (MAR); blood transfusion (IP-007) with volumes added to UF plan; ICU vitals also flow to IP-009 flowsheet.
3. **Post-session**: end time, total UF achieved, post-weight, vitals, access haemostasis time, catheter lock (heparin/citrate/antibiotic lock), post-HD labs (post-urea → URR, Kt/V (Daugirdas single-pool) auto-computed when pre/post urea available), machine disinfection started (cycle type: heat/chemical; log), dialyser reuse processing (§3.4) or BMW disposal, consumables consumption (NC-006 lot-tracked), charge lines (IP-005), summary note signed by technician + nurse/doctor; ward handover note (IP-003 SBAR) with post-dialysis instructions; Event `dialysis.session.completed`.

### 3.3 CRRT / SLED bedside in ICU (`ipdial.crrt`)
- CRRT episode (`crrt_episodes`) with hourly charting in IP-009 flowsheet columns: mode, blood flow, dialysate/replacement rates, effluent dose (ml/kg/h actual vs prescribed), net fluid removal per hour vs target (IP-009 fluid balance), filter pressures (access/return/filter/effluent/TMP), citrate rate & post-filter ionised Ca / systemic Ca (with protocol targets & alerts), heparin, filter life (start/end, clotting), circuit changes (kit lot), downtime minutes, electrolytes q6h (K/Ca/Mg/PO4/HCO3), complications; daily dose delivered %; termination criteria; charges per day/circuit; PD (`ipdial.pd`): exchange log (fill/dwell/drain volumes, effluent appearance, peritonitis screen).

### 3.4 Dialyser reuse, machine hygiene, water quality
1. **Reuse** (`ipdial.reuse`, per hospital policy; not for HBV/HCV/HIV): dialyser labelled with patient id barcode; each reprocess: rinse, clean, TCV (total cell volume) test ≥ 80 % of baseline, pressure/leak test, disinfectant (formalin/peracetic) concentration & contact time, storage, max reuse count (e.g., 5–10; policy) → next session verifies patient-dialyser match by scan and residual disinfectant test negative before use (hard-stop otherwise).
2. **Machine disinfection** log after each session (type, duration, done_by), weekly descaling; monthly maintenance (NC-020); machine quarantine on breakdown; isolation machines audit (no seronegative patient ever assigned — hard rule).
3. **Water/RO**: daily RO parameters (conductivity, hardness, chlorine/chloramine, pressure), sensors via EN-042; monthly microbial & endotoxin cultures, chemical analysis (per AAMI/ISO 23500) with results & action; out-of-range → dialysis hold decision by nephrologist + BME alert.

### 3.5 Discharge & continuity
- Discharge with maintenance HD → OP-012 schedule created (slots, dry weight, prescription copy), scheme enrolment (RC-007), access follow-up; AKI recovered → renal follow-up (PE-002); summary section in IP-002 discharge summary.

### 3.6 Exceptions
- Machine breakdown mid-session → swap machine, log downtime, incident if patient harm; power/RO failure → session abort protocol.
- Patient unstable pre-session → doctor decision (proceed with modified UF/defer) recorded.
- Seropositive result arrives after sessions on general machine → IP-012 alert, machine quarantine & disinfection protocol, exposure list.
- Missed/rescheduled sessions with reasons; no-show from ward (transport failure) → supervisor.

## 4. Data Model (schema `clinical`; extends OP-012 tables)
- **clinical.dialysis_prescriptions** (id, hospital_id, branch_id, admission_id, patient_id, order_id, modality enum(hd/sled/crrt_cvvh/crrt_cvvhd/crrt_cvvhdf/pd_capd/pd_apd), indication, schedule jsonb, duration_min, dry_weight_kg, uf_goal_ml?, uf_max_rate_ml_kg_h, qb, qd, dialysate jsonb {k, ca, hco3, na, glucose, temp}, dialyser jsonb {type, kuf, reuse_allowed}, anticoagulation jsonb {type, bolus, infusion, citrate_protocol?}, access jsonb {type, site, inserted_at, catheter_id?}, meds_during jsonb, crrt jsonb {dose_ml_kg_h, replacement_pre_post, effluent_target}, seropositive jsonb {hbv, hcv, hiv, verified_at}, bedside bool, ordered_by, ordered_at, status enum(active/completed/cancelled), version) — index (admission_id).
- **clinical.dialysis_sessions** (id, prescription_id, admission_id, patient_id, unit_id?, bay_id?, machine_id, slot jsonb, scheduled_at, status enum(scheduled/prepared/in_progress/completed/aborted/missed/cancelled), transport_task_id?, technician_id, nurse_id, pre jsonb {weight, vitals, access_assessment, machine_selftest, conductivity, temp, dialyser_lot/reuse_no, tubing_lot, uf_target, anticoag_dose, needles}, started_at, ended_at, intra_count int, post jsonb {weight, vitals, uf_achieved, haemostasis_min, lock, complications_summary}, urr, ktv, adequacy_ok bool, disinfection_log_id?, consumables jsonb, charge_lines jsonb, complications jsonb, aborted_reason?, note_signed_by, sha256) — index (machine_id, scheduled_at), (admission_id, scheduled_at) — partition monthly.
- **clinical.dialysis_session_obs** (session_id, at, source enum(manual/machine), bp_sys, bp_dia, hr, temp, qb, qd, ap, vp, tmp, uf_rate, uf_cum, conductivity, heparin_rate, alarms jsonb, notes) — partition monthly.
- **clinical.crrt_episodes** (id, prescription_id, icu_stay_id, started_at, ended_at, machine_id, circuits jsonb [{kit_lot, started_at, ended_at, reason}], filter_life_h, downtime_min, dose_delivered_pct_daily jsonb, citrate_protocol jsonb, complications jsonb) + hourly values in **ip.icu_flowsheet_hours** (IP-009) `crrt` jsonb block.
- **clinical.pd_exchanges** (prescription_id, at, fill_ml, dwell_min, drain_ml, net_uf, effluent_appearance, dialysate_strength, by).
- **clinical.dialysis_machines** (OP-012 shared: id, asset_id, unit_id, portable bool, dedicated_for enum(none/hbv/hcv/hiv), status, last_disinfection_at, next_pm_at) ; **clinical.dialysis_machine_logs** (machine_id, type enum(disinfection/descale/selftest/breakdown/quarantine/pm), at, by, details).
- **clinical.dialyser_reuse** (OP-012 shared: dialyser_id (barcode), patient_id, baseline_tcv, reuse_count, last_reprocess jsonb {tcv, pct, leak_ok, disinfectant, conc, contact_min, by, at}, status enum(in_use/stored/discarded), max_reuse).
- **clinical.dialysis_water_logs** (unit_id, at, type enum(daily_ro/microbial/endotoxin/chemical), values jsonb, within_limits bool, action, by, file_id?).
- Read models: `analytics.mv_ip_dialysis_kpis` (sessions by modality, adequacy %, complications rate, UF achieved %, machine utilisation, reuse counts, water compliance, CRRT filter life, missed sessions).

## 5. Business Rules & Validations
- Machine assignment hard rules: seropositive patient → only matching dedicated machine; seronegative never on dedicated machine; unknown serology (> 3 months old or missing) → treat as pending: allowed only on general machine with fresh markers ordered (configurable stricter: block).
- Dialyser reuse: patient-dialyser barcode match; reuse ≤ max; TCV ≥ 80 %; residual disinfectant test negative — all hard-stops; no reuse for seropositive.
- UF target ≤ (pre-weight − dry weight + intake) and rate ≤ max ml/kg/h unless doctor override with reason.
- Intra-session obs interval ≤ 30 min (manual) — overdue → alert; SBP < 90 or drop > 30 % → nurse/doctor alert (EN-029) & complication prompt.
- Anticoagulation bolus two-person verify when heparin ≥ configured units; contraindication check vs bleeding flag/platelets (EN-029).
- URR/Kt/V computed when pre & post urea present; adequacy below target 2 consecutive sessions → nephrologist task.
- Machine cannot be assigned if disinfection not logged since last session or PM overdue (BME override).
- Water out-of-limits → sessions on that RO loop require nephrologist acknowledgement; microbial > action level → CAPA (NC-015).
- Charges: session base by modality + dialyser (new/reuse pricing) + consumables + meds; scheme rates (RC-007) override; aborted sessions charged per policy (pro-rata/none).
- Records append-only, signed; consumables lot traceability retained 10 y (device vigilance).

## 6. API Surface (`/api/v1/ip-dialysis`)
| Method | Path | Purpose | Permission |
|---|---|---|---|
| POST/GET/PATCH | `/prescriptions` , `/prescriptions/{id}` | RRT orders | `ipdial.prescription.write` / `.read` |
| GET | `/schedule?date=&unit=` ; POST `/sessions` (schedule) ; PATCH `/sessions/{id}/reschedule|assign-machine|cancel` | scheduling | `ipdial.schedule.manage` |
| POST | `/sessions/{id}/pre` , `/start` , `/obs` (batch/machine) , `/complication` , `/post` , `/abort` , `/sign` | session flow | `ipdial.session.write` |
| GET | `/sessions/{id}` , `/sessions?admissionId=` , `/board?unit=` | detail/board | `ipdial.session.read` |
| POST/GET | `/crrt` , `/crrt/{id}/hourly` , `/crrt/{id}/circuit-change` , `/crrt/{id}/end` | CRRT | `ipdial.crrt.write` |
| POST/GET | `/pd/exchanges` | PD | `ipdial.session.write` |
| GET/POST | `/machines` , `/machines/{id}/logs` , `/machines/{id}/status` | machines | `ipdial.machine.manage` |
| POST/GET | `/reuse` , `/reuse/{dialyserId}/reprocess` , `/reuse/{dialyserId}/verify?patientId=` | reuse | `ipdial.reuse.write` |
| POST/GET | `/water-logs` | RO/water | `ipdial.water.write` |
| POST | `/discharge/{admissionId}/handoff-op` | create OP-012 schedule | `ipdial.prescription.write` |
| GET | `/reports/kpis` | | `ipdial.report.read` |

## 7. Domain Events (outbox)
- `dialysis.ip.prescribed|updated|cancelled` → scheduling queue, IP-003 prep tasks, IP-014 (meds), consent task.
- `dialysis.ip.scheduled|rescheduled|missed` {session_id, machine, slot} → IP-001 transport, ward nurse, IP-025 (away), patient info.
- `dialysis.session.started|completed|aborted` {uf, complications, adequacy} → IP-003 (I/O entry −UF), IP-009 flowsheet, IP-005 (charges), NC-006 (consumables), IP-002 (summary), NC-015.
- `dialysis.session.alert` {type: hypotension/alarm/obs_overdue} → nurse/doctor push.
- `dialysis.crrt.hourly_recorded|filter_clotted|dose_below_target` → IP-009 alerts.
- `dialysis.machine.assigned|disinfected|quarantined|pm_overdue` → BME (NC-020), IP-012.
- `dialysis.reuse.reprocessed|failed|max_reached` ; `dialysis.reuse.mismatch` (incident) → NC-015.
- `dialysis.water.out_of_limits` → nephrologist, BME, IP-012.
- `dialysis.seropositive.detected_post_exposure` → IP-012 exposure workflow, machine quarantine.
- Consumed: `lab.result.final` (urea/K/markers), `ip.transferred|discharge.initiated`, `nursing.mar.administered` (intradialytic), `device.dialysis.data` (EN-042), `asset.pm.overdue|breakdown` (NC-020), `bloodbank.issued` (IP-007).

## 8. Screens (UI)
- **Dialysis Unit Board** (desktop / EN-018 TV): shifts × bays/machines grid with patient chips (ward/ICU, seropositive colour-coded bay, status timers), machine status (disinfecting/PM), portable machines at ICU beds; drag to reschedule; live.
- **Session Console** (tablet at machine; desktop): pre-checks checklist with scans (wristband, dialyser, tubing), UF calculator, intra-obs grid with q30 timer, complication quick buttons, meds (MAR), post-section, sign; keyboard `O` new obs, `X` complication, `E` end; offline capture with sync; machine feed auto-populates when enabled.
- **CRRT Panel** (ICU desktop/tablet within IP-009 flowsheet): hourly columns, dose delivered gauge, filter pressures trend, citrate/Ca protocol helper, circuit timer.
- **Prescription Form** (doctor desktop/IP-010): structured with defaults per modality; serology banner; access details; schedule builder.
- **Reuse & Machine Hygiene** (technician desktop/tablet): reprocess form with TCV calc, label print (EN-005), machine disinfection log; water log entry with limits.
- **Reports** (desktop).

## 9. Integrations
- Dialysis machines (Fresenius/Nipro/B. Braun) via EN-042 (serial/HL7) for obs; RO plant sensors; OP-004 labs; IP-009 flowsheet; IP-003 MAR/I-O; NC-006 lot consumption & UDI; NC-020 assets; IP-005/RC-007 charges & schemes; OP-012 shared masters & OP schedule hand-off; EN-005 dialyser labels; BMW (NC-016).

## 10. Reports & Analytics
- Sessions by modality/unit/ICU-bedside; adequacy (URR/Kt/V) %; UF target achievement; intradialytic hypotension & other complication rates; aborted/missed sessions & reasons; machine utilisation & downtime; reuse counts & failures; water quality compliance; CRRT filter life & dose delivered; catheter-related BSI (with IP-012); revenue & scheme sessions (RC-007 returns).
- MV: `analytics.mv_ip_dialysis_kpis`.

## 11. Notifications
- Push: session scheduled/transport due (ward nurse), pre-HD labs pending, obs overdue, hypotension/alarm (nurse/doctor), machine disinfection pending, PM overdue, water out-of-limits, reuse max reached, adequacy low.
- Family/patient (EN-009 optional): session time information (no clinical values).

## 12. Permissions (RBAC keys)
`ipdial.prescription.write` (6/7 nephrologist, 11, 14 co-sign), `ipdial.prescription.read` (clinical, 27), `ipdial.schedule.manage` (41 lead, 22, 17 dialysis nurse), `ipdial.session.write` (41, 17, 18), `ipdial.session.read` (clinical, 27, 58), `ipdial.crrt.write` (18, 11, 41), `ipdial.machine.manage` (41 lead, 48), `ipdial.reuse.write` (41), `ipdial.water.write` (41, 48), `ipdial.report.read` (nephrology HOD, 22, 54, 48, 4, 58).

## 13. Non-functional
- 2000-bed site: 20–40 unit machines + 8–15 ICU portable; 80–150 sessions/day; obs 3k/day manual or 50k/day machine-fed (batched); board ≤ 2 s; session console offline-capable.
- Print: session sheet, prescription, reuse label (EN-005), water logs; i18n as IP-003.

## 14. Acceptance Criteria
1. Given an HCV-positive admitted patient, when scheduling, then only HCV-dedicated machines are selectable and reuse is disabled; assigning a general machine returns 422.
2. Given pre-weight 62.4 kg, dry weight 60 kg, planned intake 300 ml, then UF target 2.7 L is proposed; if UF rate exceeds 13 ml/kg/h for the ordered duration, a warning requires doctor override.
3. Given a reused dialyser scanned for patient B that belongs to patient A, then hard-stop and incident created.
4. Given intra-session SBP falls from 140 to 92, then an alert fires to nurse/doctor and the complication prompt opens; the intervention is logged.
5. Given pre and post urea results, then URR and Kt/V compute automatically and adequacy status shows on the session summary and KPI report.
6. Given session completed with UF 2.6 L, then IP-003 I/O chart receives −2600 ml output entry, IP-005 receives session + consumable charges (lot-tracked), and machine status becomes `disinfecting` until log entry.
7. Given a CRRT episode with prescribed dose 25 ml/kg/h and delivered 18 ml/kg/h over the day, then the dose-delivered gauge shows < 80 % and IP-009 alert is raised.
8. Given daily RO chlorine reading above limit, then sessions on that loop show a nephrologist acknowledgement requirement and BME is notified.
9. Given discharge with maintenance HD, then an OP-012 schedule is created with prescription copy and scheme enrolment task.
10. Given a technician without `ipdial.prescription.write`, when editing prescription, then 403 and audit.

## 15. Enhancements / Later phases
- Full machine bidirectional integration (prescription download to machine), AI intradialytic hypotension prediction (AI-005), home dialysis/PD remote monitoring app (PE-001), vascular access surveillance programme (access flow trends), scheme portal API returns (RC-007), telemetry-based RO monitoring dashboards (EN-042).

## 16. Open Questions for the Hospital
1. Unit size (machines/bays/shifts), portable ICU machines, CRRT/SLED/PD availability and machine models (data ports)?
2. Reuse policy (allowed? max count, disinfectant) and seropositive segregation practice/dedicated machines?
3. Anticoagulation two-person verification threshold; citrate protocol used for CRRT?
4. Water testing schedule/labs (in-house/external) and limits (AAMI/ISO 23500)?
5. Charging: per session components, package/scheme (PMJAY/state dialysis programme) rates and reporting formats?
6. Consent per session vs once per admission; transport arrangements to unit?
