# IP-023 — IP Chemotherapy (inpatient regimen/cycle orders with BSA/AUC dosing, pre-chemo verification & double-check, hazardous drug compounding & chain of custody, infusion tracking with pump link, extravasation & hypersensitivity management, toxicity grading CTCAE, neutropenic isolation & precautions, supportive care, hospital-stay oncology bundle)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-023 |
| Phase | 8 |
| Priority | P2 |
| Complexity | High |
| Depends on | OP-031 (Oncology / chemotherapy day care: regimen library, cycle planning, BSA/AUC calculators, toxicity — IP-023 reuses the engine for admitted patients & multi-day inpatient regimens), OP-002 (CPOE oncology order sets, pre-meds, hydration, supportive drugs), IP-014 (pharmacist verification, hazardous compounding worksheet & label, unit issue, returns/wastage), OP-003 (drug master with hazardous/vesicant flags, stability), IP-003 (MAR with dual-nurse verification, infusion documentation, vitals, tasks), IP-004 (bedside barcode scans), IP-009 (ICU for tumour-lysis/sepsis), IP-012 (neutropenic isolation, protective environment, febrile neutropenia sepsis screen), IP-001 (isolation/oncology beds; HEPA rooms), OP-004 (CBC/renal/hepatic/electrolytes gating labs, tumour markers), IP-007 (irradiated/leukodepleted products for immunocompromised), OP-011 (neutropenic diet), IP-005/IP-008 (high-cost drug charges, packages, scheme rates RC-007 e.g., PMJAY oncology packages), EN-029 (dose range/cumulative dose limits e.g., anthracycline lifetime, interaction, renal/hepatic adjustment), EN-013 (drug/patient barcodes), EN-042 (smart infusion pumps), EN-028 (chemo consent per regimen), NC-016 (cytotoxic waste yellow/purple bags), NC-015 (chemo errors, extravasation incidents), PE-001/PE-002 (patient diaries, follow-up), EN-037, EN-024, IP-002 (discharge with next cycle date → OP-031) |
| Feature flag | `module.ip_chemo.enabled` (sub-flags: `ipchemo.pump_link`, `ipchemo.compounding_camera`, `ipchemo.protective_env`, `ipchemo.oral_chemo`) |
| Primary roles | Medical oncologist / Haemato-oncologist (6/7), Oncology nurse (17/18, chemo-certified), Oncology pharmacist (31/32), Resident (14) |
| Secondary roles | Intensivist (11), Infection control (21), Dietician (39), Radiation oncologist (6), Palliative/pain (OP-016), Billing/TPA (27/28), Pharmacy in-charge (32), Quality (54), Patient/Family (59/60), Auditor (58) |
| Regulatory | NABH 5th ed. MOM.7/MOM.8 (high-risk medications, chemotherapy: written protocol, dose verification by two, safe handling), COP.19-style oncology care standards, ASCO/ONS chemotherapy administration safety standards (independent double check, verification elements), NIOSH/USP <800> hazardous drug handling (BSC/CACI, PPE, closed-system transfer devices, spill kits), CTCAE v5 toxicity grading, BSA (Mosteller/DuBois) & Calvert AUC (carboplatin) formulae, cumulative dose limits (doxorubicin 450–550 mg/m², bleomycin 400 U…), Drugs & Cosmetics Act (narcotics for pain via IP-014), BMW Rules 2016 (cytotoxic waste), CDSCO (biologics), NCG (National Cancer Grid) protocols, DPDP |

## 1. Purpose
IP-023 makes inpatient chemotherapy safe and traceable: regimen-based multi-day cycle orders with automated dose calculations and gating labs, oncologist–pharmacist–nurse triple verification, hazardous compounding chain of custody, barcode-verified administration with infusion tracking (rate, sequence, hydration, pre-meds, pump link), real-time management of extravasation and hypersensitivity, CTCAE toxicity grading, neutropenic isolation and precautions (protective environment), supportive-care and febrile-neutropenia protocols, cytotoxic waste and spill management, and clean hand-off to the day-care programme (OP-031) for outpatient cycles.

## 2. Users & Jobs-to-be-done
- **Oncologist** (desktop/IP-010): select regimen & cycle from library (OP-031), confirm BSA/weight/creatinine clearance, dose modifications (% with reason: toxicity, organ function), gating criteria (ANC ≥ 1.5, platelets ≥ 100, bilirubin/creatinine limits, ejection fraction for anthracyclines), pre-meds/hydration/antiemetics (per emetogenicity), sign; manage toxicity & complications; discharge with next cycle date.
- **Oncology pharmacist** (desktop; compounding room tablet): independent dose recalculation, cumulative-dose check, verify, compounding worksheet, BSC/CACI preparation with two-person check (and camera capture `ipchemo.compounding_camera`), label with beyond-use time, transport in sealed hazardous container with custody log, wastage record.
- **Oncology nurse** (tablet/desktop): pre-chemo checklist (consent, labs, vitals, allergies, access — port/PICC patency, extravasation risk), two-nurse bedside verification (patient, drug, dose, route, rate, sequence, expiry) with barcode, infusion documentation start/stop/rate changes/pump link, monitoring schedule (vitals q15 min for first hour of certain drugs), reactions/extravasation management, toxicity assessment, isolation precautions, education.
- **Infection control**: neutropenic isolation flags, protective environment audits, febrile neutropenia sepsis path.
- **Billing**: high-cost drug charges (per vial with wastage policy), day-wise packages/scheme claims.
- **Patient/family** (PE-001): cycle calendar, symptom diary, when-to-call rules.

## 3. Core Workflows

### 3.1 Cycle order & verification
1. **Oncologist** creates inpatient cycle from `regimen library` (OP-031: drugs, day schedule D1–Dn, doses/m² or mg/kg or AUC, routes, sequence, infusion durations, pre/post-meds, hydration, emetogenicity class, monitoring, gating criteria, cumulative limits, expected nadir) → **System** computes BSA (Mosteller default; DuBois option; capping policy e.g., BSA ≤ 2.0 or actual per hospital), CrCl (Cockcroft-Gault), carboplatin AUC (Calvert with GFR cap 125), doses per drug per day, rounding rules (to vial size %); shows gating labs (latest, age) & flags; oncologist enters **dose modifications** (% and reason coded), confirms; **cumulative dose** check across all prior cycles (OP-031 history + external history entered) → EN-029 warnings/hard-stop at lifetime limits (override by two oncologists) → consent verified (EN-028 regimen-specific) → **signs** (`chemo_cycles` `status=ordered`, MAR entries created per day/time in IP-003 with `chemo=true`).
2. **Pharmacist verification** (IP-014 worklist priority `chemo`): independent recalculation (BSA, doses), regimen match, gating labs, interactions, dose modification rationale, cumulative dose, stability/diluent/volume, sequence → verify/query; two-pharmacist check for high-risk (configurable) → `verified` → Event `chemo.cycle.verified`.
3. **Day-of gating**: on each treatment day, system re-checks labs (CBC ≤ 24–48 h old per policy), vitals, weight change > 10 % (recompute prompt) → "OK to prepare" flag → pharmacist notified to compound (just-in-time to reduce waste); hold if gating fails → oncologist decision (delay/dose reduce/GCSF).

### 3.2 Hazardous compounding & chain of custody
1. **Worksheet** (IP-014 compounding with `hazardous=true`): drug vials (lot/expiry scanned, UDI), diluent, final concentration/volume, container (bag/syringe/cassette), light protection, stability/beyond-use, preparer + checker sign; gravimetric/volumetric check optional; camera capture per step (`ipchemo.compounding_camera`); **label** (patient name/UHID/IP no./ward-bed, drug, dose, volume, route, rate/duration, sequence no., prepared/beyond-use time, "CYTOTOXIC" hazard, barcode) printed (EN-005).
2. **Custody**: sealed hazardous transport container id → dispatch (pharmacist) → receipt (nurse) with scan; temperature/light conditions; unused/returned bags → wastage record with witness; vial wastage tracked for billing (per vial vs per mg policy) → IP-005; spills → spill kit use, incident (NC-015), exposure log for staff (occupational health).

### 3.3 Administration & infusion tracking
1. **Pre-chemo checklist** (nurse tablet): identity (two identifiers + wristband scan), consent, labs OK, vitals baseline, allergies/prior reactions, access (peripheral vs central; vesicant → central preferred; peripheral placement rules: forearm, new cannula, blood return check), pre-meds given (antiemetics, steroids, antihistamine — MAR), hydration started per protocol (urine output/pH for high-dose MTX/cisplatin), emergency drugs & extravasation kit/antidotes at bedside (dexrazoxane, hyaluronidase, DMSO, cold/warm packs), spill kit, PPE.
2. **Two-nurse independent verification** at bedside (both authenticated; barcode scan of patient + bag; verify drug, dose (mg & mg/m²), volume, route, rate/duration, sequence, expiry/beyond-use, pump programming) → start; **infusion record** (`chemo_infusions`): start/stop, rate changes, pump id & programme (`ipchemo.pump_link` via EN-042: rate/volume infused/alerts auto), interruptions with reason, flush, site checks q30 min (vesicants q15 min: blood return, pain, swelling), vitals per drug schedule (e.g., rituximab/paclitaxel q15 min ×1 h), sequence enforcement (e.g., paclitaxel before carboplatin), total time; **oral chemo** (`ipchemo.oral_chemo`) via MAR with hazardous handling flag.
3. **Events**: **hypersensitivity/infusion reaction** → one-tap protocol (stop, maintain IV, vitals, grade CTCAE, drugs given (adrenaline/antihistamine/steroid), doctor call, rechallenge decision & desensitisation plan) → recorded, allergy/reaction added to patient profile (EN-029) → IP-014 ADR report; **extravasation** → protocol by drug class (vesicant/irritant): stop, aspirate, do not flush, mark area & photo, antidote (dexrazoxane within 6 h for anthracyclines; hyaluronidase; DMSO), cold/warm compress per drug, elevate, plastic surgery consult, incident (NC-015), follow-up review schedule (24 h/48 h/1 wk photos) → `chemo_extravasations`.
4. Post-infusion: line care/lock, waste disposal (yellow/purple bags NC-016), patient education, next-day plan; MAR marks given with both verifiers; charge posting (IP-005: drug per vial/mg policy, compounding fee, infusion charges, pump).

### 3.4 Toxicity, supportive care & isolation
1. **Toxicity assessment** daily/on event: CTCAE v5 items (nausea, vomiting, mucositis, diarrhoea, neuropathy, fatigue, febrile neutropenia, anaemia, thrombocytopenia, hepatic/renal, cardiac, skin) grade 0–5 with actions (dose modification recommendations from regimen library, supportive orders: antiemetic escalation, GCSF, transfusion IP-007 (irradiated), electrolyte replacement, mucositis care); tumour lysis monitoring (uric acid/K/PO4/Ca, rasburicase/allopurinol, hydration) via order set; **nadir predictions** and CBC schedule.
2. **Neutropenic isolation** (`ipchemo.protective_env`): ANC < 500 (or per policy) → auto-flag isolation type `protective` (IP-012/IP-001: HEPA/positive-pressure room preference; single room; visitor restriction; neutropenic diet OP-011; no fresh flowers/plants; strict hand hygiene; mask for staff/visitors; daily temperature vigilance) → banner + tasks; **febrile neutropenia** (temp ≥ 38.3 once or ≥ 38 for 1 h with ANC < 500) → sepsis pathway (IP-020/EN-029): cultures & antibiotics ≤ 60 min timer, MASCC score, ICU criteria (IP-009); isolation lifted when ANC recovers.
3. Supportive: pain (opioids via IP-014 narcotics), nutrition (OP-011), psycho-oncology (42), palliative referral (OP-016), central line care bundle (IP-012), blood products with irradiation requirement flag (IP-007).

### 3.5 Discharge & continuity
- Discharge summary oncology section (regimen/cycle/day, doses given, cumulative totals, toxicities, growth factors, next cycle date, nadir advice, when to return: fever ≥ 38 °C, bleeding, severe vomiting), next cycle scheduled in OP-031 day care or inpatient re-admission plan (IP-001 pre-admission), PE-001 diary & alerts (temperature logging), PE-002 follow-up calls (nadir day check).

### 3.6 Exceptions
- Gating fails on day → hold, oncologist decision, pharmacist prep cancelled before compounding (waste avoided; if compounded → wastage record & billing policy).
- Patient refuses cycle/day → documented, oncologist informed.
- Pump alarm/occlusion → pause, troubleshoot, log; pump feed loss → manual documentation.
- Wrong-bag scan → hard-stop, incident; near-miss recorded.
- Drug stock-out (high-cost/biologic) → IP-014/NC-005 urgent procurement; scheme approval pending (RC-007) → billing hold flag but never delays emergency treatment per policy.

## 4. Data Model (schema `clinical`; shares OP-031 tables)
- **clinical.chemo_cycles** (id, hospital_id, branch_id, admission_id, patient_id, regimen_id (OP-031), regimen_version, cycle_no, day_count, intent enum(curative/adjuvant/neoadjuvant/palliative), diagnosis_icd10, stage, protocol_ref, height_cm, weight_kg, bsa_m2, bsa_formula, bsa_cap_applied bool, crcl_ml_min, gating jsonb [{param, required, value, at, ok}], consent_id, ordered_by, ordered_at, verified_by jsonb [{pharmacist_id, at}], status enum(draft/ordered/verified/in_progress/held/completed/cancelled), hold_reason?, next_cycle_due_at, notes, version) — index (patient_id, cycle_no), (hospital_id, status).
- **clinical.chemo_cycle_drugs** (cycle_id, day int, seq int, drug_id, dose_basis enum(mg_m2/mg_kg/auc/flat/units), basis_value, calculated_dose, modification_pct, modification_reason, final_dose, unit, route, diluent, volume_ml, duration_min, rate, vesicant_class enum(vesicant/irritant/non), premeds jsonb, monitoring_schedule jsonb, cumulative_before, cumulative_after, cumulative_limit?, mar_schedule_id?, status enum(planned/verified/prepared/administered/held/omitted)) — index (cycle_id, day, seq).
- **clinical.chemo_preparations** (id, cycle_drug_id, worksheet_id (IP-014 compounding), prepared_by, checked_by, prepared_at, beyond_use_at, container_type, label_barcode unique, camera_media_ids jsonb, custody jsonb [{event(dispatched/received/returned/wasted), by, at, container_id}], wastage jsonb {qty, reason, witness}, status enum(prepared/dispatched/received/administered/returned/wasted)).
- **clinical.chemo_infusions** (id, cycle_drug_id, preparation_id, admission_id, verifier1_id, verifier2_id, verified_at, patient_scan_ok, bag_scan_ok, pump_id?, pump_programme jsonb, started_at, ended_at, rate_changes jsonb, interruptions jsonb, site_checks jsonb [{at, blood_return, pain, swelling, ok}], vitals_refs jsonb, total_volume_ml, status enum(running/paused/completed/stopped_reaction/stopped_extravasation/aborted), stopped_reason?, signed_by, sha256) — partition monthly; index (admission_id, started_at).
- **clinical.chemo_reactions** (infusion_id, at, type enum(hypersensitivity/infusion_reaction/anaphylaxis/other), ctcae_grade, symptoms jsonb, actions jsonb, drugs_given jsonb, doctor_notified_at, outcome, rechallenge_decision, desensitisation_plan?, adr_report_id (IP-014), incident_id?).
- **clinical.chemo_extravasations** (infusion_id, at, drug_id, site, volume_est_ml, symptoms, photos jsonb, antidote jsonb {drug, dose, at}, compress enum(cold/warm/none), consults jsonb, incident_id, follow_ups jsonb [{due, done_at, photo_id, notes}], outcome).
- **clinical.chemo_toxicity_assessments** (cycle_id, at, by, items jsonb [{ctcae_term, grade, action}], anc, platelets, hb, notes, isolation_flag bool).
- **clinical.neutropenic_isolations** (admission_id, started_at, ended_at, trigger_anc, room_type enum(hepa/single/cohort), precautions jsonb, lifted_reason).
- Cumulative dose ledger in OP-031 **clinical.chemo_cumulative_doses** (patient_id, drug_id, total, unit, updated_at, sources jsonb).
- Read models: `analytics.mv_ip_chemo_kpis` (cycles, verification TAT, day-of holds, wastage value, reactions/extravasations per 1000 infusions, FN episodes & antibiotic ≤ 60 min %, isolation days, LOS by regimen, cost/revenue by regimen & scheme).

## 5. Business Rules & Validations
- No chemo administered without: signed order, pharmacist verification (two for high-risk), gating OK for the day (or documented oncologist override), consent, two-nurse bedside verification with barcode (both authenticated; different users), matching label barcode ↔ MAR schedule ↔ patient.
- Dose calc reproducibility: BSA formula & cap policy fixed per hospital; weight change > 10 % or > 7 days old → recompute prompt; carboplatin GFR cap; rounding to vial policy; cumulative lifetime limits hard-stop with two-oncologist override; anthracycline requires EF within 3–6 months.
- Vesicants: central access preferred; peripheral only with documented site rules and q15 min checks; extravasation protocol mandatory record on suspicion; dexrazoxane window timer.
- Sequence and infusion durations enforced (warn on deviation); pump link discrepancies (programmed vs order) block start.
- Reactions → automatic allergy/reaction record & IP-014 ADR; grade ≥ 3 → incident.
- Neutropenic isolation auto-flag on ANC threshold; FN sepsis timer (antibiotics ≤ 60 min) with variance if breached (IP-020).
- Hazardous handling: preparation only by trained staff (competency flag NC-027), BSC/CACI required, custody scans mandatory; wastage witnessed; cytotoxic waste stream coded (NC-016).
- Charging: drug billed per vial or per mg per policy; wastage billing per payer contract; scheme package rules (RC-007) applied; compounding/infusion/pump charges.
- Append-only, hash chain; media consent for extravasation photos (clinical necessity clause).

## 6. API Surface (`/api/v1/ip-chemo`)
| Method | Path | Purpose | Permission |
|---|---|---|---|
| POST/GET/PATCH | `/cycles` , `/cycles/{id}` ; POST `/cycles/{id}/calculate` ; POST `/cycles/{id}/sign` ; POST `/cycles/{id}/hold|resume|cancel` | cycle orders | `ipchemo.cycle.write` / `.read` |
| POST | `/cycles/{id}/verify` (pharmacist) ; POST `/cycles/{id}/day-gating/{day}` | verification/gating | `ipchemo.verify` |
| POST/GET | `/preparations` ; POST `/preparations/{id}/custody` ; POST `/preparations/{id}/wastage` | compounding & custody | `ipchemo.prepare` |
| POST | `/infusions/verify` (two-nurse payload, scans) ; POST `/infusions/{id}/start|pause|resume|rate|stop|complete` ; POST `/infusions/{id}/site-check` | administration | `ipchemo.administer` |
| POST | `/infusions/{id}/reaction` ; POST `/infusions/{id}/extravasation` ; POST `/extravasations/{id}/follow-up` | events | `ipchemo.administer` |
| POST/GET | `/cycles/{id}/toxicity` ; POST `/admissions/{id}/neutropenic-isolation/start|end` | toxicity/isolation | `ipchemo.toxicity.write` |
| GET | `/board?ward=` ; GET `/admissions/{id}/chemo-summary` | ward chemo board / summary | `ipchemo.cycle.read` |
| POST | `/cycles/{id}/handoff-daycare` | next cycle to OP-031 | `ipchemo.cycle.write` |
| GET | `/reports/kpis` | | `ipchemo.report.read` |

## 7. Domain Events (outbox)
- `chemo.cycle.ordered|verified|held|cancelled|completed` {cycle_id, regimen, day_count} → IP-014 (verification/compounding), IP-003 (MAR), IP-005/RC-007 (pre-auth for high-cost), OP-031 (history), PE-001 (calendar).
- `chemo.day.gating_ok|gating_failed` {day, params} → pharmacist (prepare), oncologist.
- `chemo.preparation.ready|dispatched|received|wasted` {label} → nurse, IP-005 (wastage billing), NC-016.
- `chemo.infusion.started|completed|stopped` {drug, volume, duration} → IP-003 MAR, IP-005 charges, cumulative ledger (OP-031).
- `chemo.reaction.recorded` {grade} / `chemo.extravasation.recorded` {drug, antidote} → doctor push, IP-014 ADR, NC-015 incident, EN-029 allergy.
- `chemo.toxicity.recorded` {grades} → oncologist, dietician; `chemo.neutropenic_isolation.started|ended` → IP-012, IP-001 (room), OP-011 (diet), EN-018 banner, visitors (EN-015).
- `chemo.febrile_neutropenia.detected` → IP-020 sepsis pathway/EN-029, IP-013 (RRT optional).
- Consumed: `lab.result.final` (CBC/renal/hepatic/uric acid), `nursing.vitals.recorded` (temp), `device.pump.event` (EN-042), `rx.ip.verified` (IP-014), `pharmacy.compounded.prepared` (IP-014), `ip.discharge.initiated`.

## 8. Screens (UI)
- **Cycle Order Composer** (oncologist desktop): regimen picker with version, patient parameters (height/weight/BSA/CrCl auto), drug grid by day (dose calc, modification %, cumulative bar), gating panel (labs with age colour), pre-meds/hydration/antiemetic auto-set by emetogenicity, consent status, sign; `Ctrl+Enter` sign.
- **Pharmacist Chemo Verification** (desktop; IP-014 worklist filter): side-by-side recalculation, discrepancy highlights, stability/diluent, verify/query.
- **Compounding Console** (compounding room tablet; gloves-friendly): worksheet steps with scans, checker sign, camera capture, label print, custody dispatch.
- **Bedside Chemo Administration** (tablet; IP-004 flow): pre-checklist, two-nurse verify screen (both scan badges/PIN), infusion timer & rate panel with pump status, site-check reminders (q15/q30), reaction/extravasation red buttons (protocol wizard), vitals capture; offline-capable for documentation, verification requires online.
- **Ward Chemo Board** (desktop/TV): patients on chemo today (drug/day/status/timers), isolation flags, FN alerts.
- **Toxicity & Isolation Panel** (desktop/tablet): CTCAE grid, trend of counts, isolation status/tasks.
- **Patient view** (PE-001): cycle calendar, symptom diary, temperature log, when-to-call.

## 9. Integrations
- OP-031 regimen library & cumulative ledger; IP-014/OP-003 compounding & drug master; EN-042 smart pumps (drug library match, rate/volume events); OP-004 labs; IP-007 irradiated products; IP-012 isolation & FN surveillance; EN-013/EN-005 labels; NC-016 waste; RC-007/EN-002 approvals for high-cost drugs; PE-001 diary; NC-027 competency records.

## 10. Reports & Analytics
- Cycles by regimen/intent, verification TAT & discrepancies caught, day-of holds & reasons, dose modifications %, drug wastage value & vial optimisation, infusion reactions & extravasations per 1000 infusions (grade distribution), FN episodes & antibiotic ≤ 60 min %, isolation days, LOS by regimen, chemo errors/near misses (NC-015), revenue/margin per regimen & scheme; NABH MOM indicators.
- MV: `analytics.mv_ip_chemo_kpis`.

## 11. Notifications
- Push: verification pending/queried (oncologist), gating failed (oncologist), preparation ready (nurse), infusion site check due, reaction/extravasation (oncologist + in-charge), ANC below threshold → isolation (nurse/ICN), FN detected (oncologist/on-call), next cycle due (OP-031/PE-002).
- Patient (PE-001/WhatsApp opt-in): cycle schedule, nadir advice, fever hotline; no drug names/doses in SMS.

## 12. Permissions (RBAC keys)
`ipchemo.cycle.write` (oncologist 6/7, 14 draft), `ipchemo.cycle.read` (clinical, 27, 28, 58), `ipchemo.verify` (oncology pharmacist 31/32), `ipchemo.prepare` (31 with hazardous competency), `ipchemo.administer` (17/18 chemo-certified; second verifier same), `ipchemo.toxicity.write` (6/7, 14, 17/18), `ipchemo.report.read` (oncology HOD, 32, 54, 4, 58).

## 13. Non-functional
- 2000-bed site: 60–150 inpatient chemo infusions/day; verification worklist p95 < 200 ms; barcode verify < 100 ms; pump event ingestion ≤ 5 s; timers accurate to seconds.
- Offline: infusion documentation & site checks queue; two-nurse verification requires online (or cached credentials ≤ 15 min per policy).
- Print: cytotoxic labels (EN-005, hazard symbol), worksheet, cycle sheet, patient calendar (multilingual). Accessibility: high-contrast red action buttons; glove-friendly targets.

## 14. Acceptance Criteria
1. Given FOLFOX cycle 3 ordered for 1.78 m² patient, then per-drug doses compute from mg/m², oxaliplatin cumulative shows prior cycles, and gating displays ANC/platelets with lab age; if ANC 1.1, day-1 gating fails and the order cannot be released for compounding without oncologist override.
2. Given carboplatin AUC 5 with CrCl 140 ml/min, then GFR is capped at 125 in Calvert and the dose shows the cap note.
3. Given cumulative doxorubicin would exceed 550 mg/m², then a hard-stop requires two oncologist authorisations.
4. Given pharmacist recalculation differs from order by > 5 %, then discrepancy is highlighted and verification is blocked until resolved.
5. Given a prepared bag dispatched, when the nurse receives without custody scan, then start is blocked; after receipt scan and two-nurse verification with patient & bag barcodes, the infusion starts and the pump programme is checked against the order (mismatch blocks).
6. Given a vesicant peripheral infusion, then site-check tasks are generated q15 min; suspected extravasation opens the protocol wizard, records antidote timing (dexrazoxane window countdown), creates an incident and follow-up photo tasks at 24 h/48 h/1 wk.
7. Given a grade 3 hypersensitivity reaction, then the infusion is marked stopped, a reaction record with drugs given is created, allergy profile updated, ADR report generated in IP-014, and the oncologist is paged.
8. Given ANC result 380, then protective isolation auto-flags with room/diet/visitor tasks; temperature 38.4 °C recorded later triggers FN detection with antibiotic ≤ 60 min timer.
9. Given a bag compounded but cycle held due to gating, then wastage record with witness is created and billing follows the wastage policy.
10. Given a nurse without chemo certification, when attempting bedside verification, then 403 and audit.
11. Given cycle completed and discharge initiated, then next cycle date is scheduled in OP-031 and appears in PE-001 calendar.

## 15. Enhancements / Later phases
- Gravimetric compounding & robotic IV preparation, closed-loop pump programming (auto-programming from order) (EN-042), AI toxicity prediction & FN risk (AI-005), oral chemo adherence app (PE-001), clinical trials module linkage, tumour board scheduling (OP-031), NCG protocol library sync, patient-reported outcomes (PRO-CTCAE), scheme portal auto-claims for oncology packages (RC-007/RC-001).

## 16. Open Questions for the Hospital
1. Inpatient chemo volumes/regimens (haemato-oncology, high-dose MTX, multi-day protocols)? HEPA/positive-pressure rooms available?
2. BSA formula & cap policy; rounding to vial policy; wastage billing rules per payer/scheme?
3. Compounding facility (BSC/CACI, closed-system devices), staffing/competency records; camera capture acceptable?
4. Verification policy: two pharmacists for which drugs; two-nurse verification for all chemo incl. oral?
5. Smart pump models & drug library integration availability?
6. Extravasation kit/antidote stock locations; plastic surgery on-call?
7. FN protocol (MASCC, antibiotic ≤ 60 min) and isolation thresholds (ANC < 500 or < 1000)?
8. Consent per regimen/cycle; patient education/diary language preferences?
