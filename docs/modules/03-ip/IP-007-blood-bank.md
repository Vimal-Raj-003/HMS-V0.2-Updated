# IP-007 — Blood Bank (donors, screening, collection, TTI testing, component separation, inventory, requests, cross-match, issue with 2-person bedside check, transfusion & reactions, MTP, SBTC/NACO/e-RaktKosh reporting)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | IP / Inpatient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Module ID       | IP-007                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Phase           | 7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Depends on      | OP-001 (patient MPI; donor identity), IP-001 (admissions/wards), IP-003 (bedside transfusion record, vitals), IP-006/TR-004/TR-007 (OT/trauma demand, MTP), IP-009 (ICU), IP-011 (obstetric/PPH), OP-004 (LIS: blood grouping/antibody screen/TTI analysers via EN-004; results), EN-013 (ISBT 128 / bag barcodes, wristband), EN-005 (label printers), IP-005/OP-005 (charges), NC-006 (reagents/consumables), EN-042 (blood-fridge/platelet-agitator temperature sensors), EN-009/EN-032 (donor SMS/e-mail), NC-035 (camps), EN-037 (alerts), NC-015 (haemovigilance incidents), EN-039 (forms), EN-024 (audit), NC-016 (BMW), NC-023 (licence tracker)                                                                                                     |
| Feature flag    | `module.blood_bank.enabled` (sub: `bb.component_prep`, `bb.eraktkosh_sync`, `bb.mtp`, `bb.autologous`, `bb.apheresis`, `bb.camps`, `bb.external_network`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Primary roles   | Blood Bank Technician / Medical Officer / In-charge (37), Blood Bank Nurse (donor area), Transfusion Medicine Specialist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Secondary roles | Ward/ICU/OT nurse (17/18/20, requests & bedside check), Doctors (7/9/10/11, requests, MTP), Phlebotomist (34), Lab quality (35), Cashier/Billing (26/27), Quality/ICN (54/21), Stores (44), Biomedical (48, fridges), Donor (external), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Regulatory      | Drugs & Cosmetics Act 1940 & Rules 1945 Schedule F Part XII-B/XII-C (blood centre licence, donor criteria, mandatory testing, storage temps, records), CDSCO/State Licensing Authority, NBTC/NACO guidelines (donor selection, TTI: HIV 1&2, HBsAg, HCV, Syphilis, Malaria; NAT where available), SBTC monthly reporting, **e-RaktKosh** (NHM) stock/donor/camp reporting, NABH 5th ed. HIC/COP.10 (transfusion services, bedside verification, haemovigilance), NABH-Blood Bank standards, ISBT 128 labelling, Haemovigilance Programme of India (HvPI — TRRF reporting), NACO PID for reactive donors, BMW 2016, DPDP (donor & recipient data), Consumer Protection (blood charges as per NBTC processing charge caps), Karnataka/State rules as applicable |

## 1. Purpose

IP-007 digitises the hospital blood centre end-to-end: donor registration and eligibility (questionnaire, Hb, vitals, deferral registry), collection with bag barcode and adverse-event log, mandatory TTI testing and grouping (LIS/analyser interface), component preparation (WB → PRBC/FFP/platelets/cryo, apheresis), inventory with storage temperature monitoring, expiry/FEFO and quarantine, transfusion requests from wards/OT/ICU, cross-match/compatibility (immediate spin/AHG/electronic where policy allows), issue with 2-person verification at issue and at bedside (wristband + bag scan), transfusion monitoring and reaction management with HvPI reporting, massive transfusion protocol activation, autologous donation, and statutory reporting (SBTC/NACO/e-RaktKosh). Every unit is traceable from donor vein to recipient vein.

## 2. Users & Jobs-to-be-done

- **Donor-area nurse/technician** (desktop/tablet): register donor (walk-in/camp/replacement/voluntary), questionnaire & consent, Hb/vitals, deferral decisions, collection (bag scan, timings, volume, adverse events), post-donation care; donor card & thanks SMS.
- **Lab technician** (desktop + analysers): grouping (forward/reverse) & antibody screen, TTI (ELISA/CLIA/NAT via EN-004), results entry/validation, discard reactive units, NACO/PID counselling referrals.
- **Component technician**: separation batches, component labels (ISBT 128), quarantine → release after TTI, storage placement, expiry management, irradiation/leucoreduction flags.
- **Issue counter technician / MO** (desktop): receive requests, grouping of patient sample, cross-match, select FEFO-compatible units, issue with 2-person check, emergency uncross-matched O-negative issue, return/re-issue rules, charges.
- **Ward/OT/ICU nurse** (tablet/phone via IP-004): raise request with sample (label print), bedside verification (2 nurses, scans), transfusion vitals & reaction reporting.
- **Doctor**: request with indication (guideline prompts), consent, MTP activation, reaction workup orders.
- **Blood bank in-charge**: inventory dashboard, temperature excursions, discards, statutory reports, audits, licence tracker (NC-023), camps (NC-035), external network requests (`bb.external_network`).
- **Quality/ICN**: haemovigilance, near-miss, TTI seroprevalence, utilisation (C:T ratio).

## 3. Core Workflows

### 3.1 Donor registration, screening & deferral

1. **Donor** arrives (walk-in / camp / replacement for patient X / apheresis) → **Nurse** registers (donor id from `DONOR` series; identity doc; photo; link to patient MPI optional; repeat donor lookup by phone/ID) → **questionnaire** (NBTC donor history: age 18–65, weight ≥ 45 kg (450 mL) / ≥ 55 kg (apheresis), Hb ≥ 12.5 g/dL, BP/pulse/temp, last donation ≥ 3 months (M)/4 months (F), medical history, medications, tattoos/piercing < 12 m, high-risk behaviour, travel (malaria), pregnancy/lactation, vaccinations, surgeries, dental) with auto-eligibility rules → **consent** (EN-028: donation, TTI testing, notification of results, use of components) → **Hb** (copper sulphate/HemoCue), vitals → decision: eligible / **temporary deferral** (reason, until date → registry, SMS reminder) / **permanent deferral** (reason; flagged for all branches) → Event `blood.donor.screened`.
2. Deferral registry checked at every registration (branch-wide + group EN-041); permanently deferred/TTI-reactive donors blocked with counsellor prompt.

### 3.2 Collection & donor adverse events

- **Collection**: bag type (single/double/triple/quad, 350/450 mL; apheresis kit `bb.apheresis`), bag/segment barcode scan (ISBT 128 donation identification number assigned by system & printed via EN-005; pre-printed bag numbers captured), phlebotomist, start/end time, volume (scale), duration (> 12–15 min flags for platelet suitability), pilot tube samples labelled with same DIN (grouping, TTI), arm check → Event `blood.unit.collected` (unit status `collected/quarantine`).
- **Adverse events**: vasovagal, haematoma, nerve injury, citrate reaction (apheresis) — severity, management, follow-up; donor deferral if needed; reported in HvPI donor vigilance.
- Post-donation: refreshments, donor card print (group after testing), certificate, thanks SMS; next eligible date; camp summary (`bb.camps` with NC-035).

### 3.3 Testing (grouping, antibody screen, TTI)

- **Grouping**: ABO forward & reverse, Rh(D) (+ weak D), antibody screen (per policy) — manual entry or analyser (EN-004: gel/column agglutination or automated) → validated by MO; discrepancy → repeat/resolve workflow; historical group check for repeat donors.
- **TTI**: HIV 1&2, HBsAg, HCV, Syphilis (RPR/TPHA), Malaria (mandatory NBTC) ± NAT (HIV/HBV/HCV `nat_enabled`) → results from OP-004/EN-004; **reactive** → unit & all components auto-flagged `discard_reactive`, repeat testing algorithm, donor **counselling & confirmatory referral** (NACO ICTC PID), donor status permanent/temporary deferral, notification per consent; **non-reactive & grouped** → components released from quarantine → Event `blood.unit.released`.
- QC of reagents/kits (lot, expiry, daily controls) with EN-031 lab quality; analyser results traceable.

### 3.4 Component preparation & labelling (`bb.component_prep`)

- Whole blood → centrifugation batch (equipment id, program, timings) → components: PRBC (SAGM, 42 d), FFP (−30 °C, 1 y), Platelet concentrate (RDP; 20–24 °C agitation, 5 d), Cryoprecipitate (1 y), Buffy coat/pooled platelets, single-donor platelets (apheresis), leucoreduced/irradiated/washed attributes; each component gets **ISBT 128** product code + same DIN + expiry computed by product & anticoagulant; label printed (barcodes: DIN, product code, ABO/Rh, expiry) → **quarantine** until TTI/grouping release; volume/yield recorded; discard of unsuitable (lipaemic, haemolysed, under/over volume, clots) with reason.
- Modification records (pooling, irradiation dose, aliquoting for paediatrics with child DINs).

### 3.5 Inventory, storage & temperature monitoring

- Locations: blood bank refrigerators (2–6 °C), plasma freezers (≤ −30 °C), platelet agitator/incubator (20–24 °C), satellite fridges (OT/ER/ICU with issue rules), transport boxes; each unit has location, status (quarantine/available/reserved/cross_matched/issued/transfused/returned/discarded/expired/transferred_out), attributes (group, product, expiry, special: irradiated, CMV-neg, leucoreduced, phenotyped antigens).
- **Temperature**: EN-042 sensors (or manual 4-hourly logs) → excursion alerts (fridge > 6 °C for > 30 min etc.) → units in that location quarantined pending MO decision; alarm log; door-open events.
- **Expiry & FEFO**: dashboard by group/product with days-to-expiry buckets; near-expiry (≤ 5 d PRBC, ≤ 24 h platelets) alerts & priority issue; **auto-expire** job moves to `expired` → discard workflow (BMW, autoclave/incinerate log); discard reasons (expired, TTI-reactive, QC fail, broken bag, returned > 30 min, temperature). Reagents/bags/kits stock via NC-006.
- Stock levels: par/min per group/product with reorder/appeal triggers (donor SMS campaigns for group shortage, e-RaktKosh availability update, external network request `bb.external_network`).

### 3.6 Transfusion request, sample & cross-match

1. **Doctor** raises **transfusion request** (from IP-003/OP-002/IP-006/OP-006): components & units, indication (Hb/platelet/INR triggers shown; guideline prompt "PRBC when Hb < 7 (< 8 cardiac)"), urgency (routine ≤ 24 h / urgent ≤ 2 h / emergency uncross-matched / MTP), special requirements (irradiated, leucoreduced, CMV-neg, phenotyped, paediatric aliquot, washed), consent (EN-028 blood transfusion consent — mandatory except emergency with two-doctor note), previous transfusion/reaction history & known antibodies (patient record), pregnancy history; **sample**: nurse prints label at bedside (EN-013: patient identifiers, DIN of request, collector, time), scans wristband → sample drawn; **two identifiers** rule; second sample for first-time ABO (policy) → Event `blood.request.created`.
2. **Blood bank** receives sample (scan; rejects unlabelled/mismatch), performs **patient grouping** (ABO/Rh, antibody screen; compare with historical group — mismatch hard-stop), selects units (FEFO, group-compatible logic: O-neg for unknown; Rh-neg for females < 50; special attributes), **cross-match** (immediate spin / full AHG / electronic cross-match if policy & two concordant groups & negative screen) → results per unit (compatible/incompatible) → **compatibility report** printed/electronic; incompatible → antibody identification workflow, alternate units.
3. **Reservation**: cross-matched units reserved for patient with hold (default 48–72 h; OT reserve until case end) → auto-release to inventory if not issued (Event `blood.reserve.released`); C:T ratio tracked.
4. **Emergency uncross-matched**: doctor's emergency release form (2 signatures/e-sign) → O-negative (or O-positive males per policy) issued immediately, retrospective cross-match continues, results appended; MTP see §3.9.

### 3.7 Issue (2-person) & bedside verification (2-person)

1. **Issue at blood bank**: technician scans unit(s) + request → checks (compatibility result present, expiry, visual inspection, patient identifiers match, special requirements met, consent present) → **second person** (another tech/MO/nurse collecting) verifies by scanning & PIN → issue slip with unit details, transport box/temperature indicator, issue time (30-min rule clock starts) → charges post to IP-005/OP-005 (processing charges per NBTC cap, cross-match, special processing) → Event `blood.unit.issued`.
2. **Bedside**: **two nurses** on IP-004/IP-003: scan patient wristband → scan unit barcode → system verifies match (patient, unit reserved for patient, ABO/Rh compatibility, expiry, issue < 30 min or returned to controlled storage) → both authenticate → pre-transfusion vitals → **start transfusion** (time, rate; PRBC over ≤ 4 h) → monitoring vitals at 15 min, 30 min, hourly, end (tasks in IP-003) → **end** (volume, time) → Event `blood.unit.transfused` → transfusion record in EMR (traceability DIN ↔ patient) & discharge summary.
3. **Return**: unissued/unused unit returned ≤ 30 min with intact seal & temperature evidence → re-inventory (MO approval); > 30 min or breached → discard; unit issued but not started documented.

### 3.8 Transfusion reactions & haemovigilance

- Nurse suspects reaction (fever ≥ 1 °C rise, chills, urticaria, dyspnoea, hypotension, back pain, haemoglobinuria) → **Stop transfusion** action → guided workflow: keep IV line, vitals, notify doctor, clerical re-check (bedside identity/bag), return bag + set + post-reaction samples (EDTA/clotted/urine) with labels, symptoms severity, management → **blood bank workup**: clerical check, repeat ABO/Rh patient & unit, DAT, visual haemolysis, culture if septic; classification (FNHTR, allergic/anaphylaxis, acute haemolytic, TRALI, TACO, septic, delayed haemolytic, TA-GVHD, PTP) & imputability → **HvPI TRRF** report generation & submission log; incident to NC-015; recipient record flagged (future units precautions e.g. leucoreduced) → Event `blood.reaction.reported`. Near-miss events (wrong sample, mislabel, wrong unit caught) logged with anonymous option.

### 3.9 Massive Transfusion Protocol (`bb.mtp`)

- Activation by ER/OT/ICU/labour room doctor (button in TR-001/TR-007/IP-006/IP-011/OP-006) → blood bank alarm; **pack sequence** configured (e.g. Pack 1: 4 PRBC + 4 FFP + 1 RDP pool/SDP; ratio 1:1:1; cryo when fibrinogen < 1.5 g/L) → uncross-matched O-neg/O-pos & AB/A plasma issued in packs with runner tracking, timers for next pack, lab reminders (CBC, coag, fibrinogen, Ca²⁺, ABG q30–60 min), TXA prompt; deactivation with summary (units used, wastage) → KPI: activation-to-first-pack time (target ≤ 10 min).

### 3.10 Statutory & external reporting

- **SBTC/NACO monthly**: donors (voluntary/replacement/camp), units collected, components prepared, TTI reactive by marker, discards by reason, issues by component/group, stock; format per state SBTC template (configurable export XLS/PDF); NACO seroprevalence.
- **e-RaktKosh** (`bb.eraktkosh_sync`): stock availability push (group/component counts) at configured intervals, camp schedules, donor registration data as per API/portal specs (upload file fallback).
- Registers (Schedule F): donor register, master register of units, TTI register, component register, issue register, discard register, adverse reaction register, temperature logs, QC logs — printable & exportable, retained ≥ 5 y (recommend 10 y; traceability records 30 y per ISBT best practice — configurable).
- Licence tracker (NC-023): blood centre licence renewal, inspections, equipment calibration (NC-020).

### 3.11 Autologous & directed donation, external units

- `bb.autologous`: pre-deposit autologous units tagged to patient, cannot be issued to others, expiry management; directed donations with same testing; **external units** received from other blood centres (bulk transfer form, DIN retained, re-check group & visual, TTI certificate on file) tracked with source; units transferred out to other centres (Schedule F transfer records).

### 3.12 Exceptions

1. Sample mislabelled/mismatch with historical group → reject & re-collect; near-miss log.
2. Analyser interface down → manual results with double entry verification.
3. Temperature excursion during power failure → quarantine + MO review; DG log.
4. Unit issued but patient deceased/transferred → return within 30 min or discard rules.
5. Offline at bedside (IP-004): verification uses cached issue data ≤ 4 h; still requires two nurses; sync flags.

## 4. Data Model (schema `blood`)

- **blood.donors** (id, hospital_id, donor_no unique, patient_id?, name, dob, sex, phone (encrypted), id_type/no (masked), photo_file_id, address, blood_group?, donation_type_default, permanent_deferral bool, deferral_reason, tti_reactive_flag, last_donated_at, donations_count, consent_id, created_at) — index (hospital_id, phone_hash), trigram name.
- **blood.donor_screenings** (donor_id, at, questionnaire jsonb, hb, weight, bp, pulse, temp, eligible bool, deferral_type enum(none/temporary/permanent), deferral_until, reason, screened_by, camp_id?).
- **blood.donations** (id, donor_id, screening_id, din unique (ISBT 128), bag_type, volume_ml, started_at, ended_at, phlebotomist_id, adverse_event jsonb?, camp_id?, apheresis jsonb?, status enum(collected/quarantine/released/discarded)).
- **blood.units** (id, hospital_id, branch_id, din, product_code (ISBT 128), component enum(wb/prbc/ffp/rdp/sdp/cryo/pooled_plt/buffy/other), abo enum, rh enum, attributes jsonb (irradiated, leucoreduced, cmv_neg, phenotype, paediatric_aliquot, autologous_patient_id, directed_patient_id), volume_ml, collected_at, expires_at, status enum(quarantine/available/reserved/cross_matched/issued/transfused/returned/discarded/expired/transferred_out), location_id, parent_unit_id?, source enum(in_house/external), external_centre?, tti_status enum(pending/non_reactive/reactive), grouping_status, version) — index (hospital_id, status, component, abo, rh, expires_at), (din).
- **blood.tti_results** (donation_id, marker enum(hiv/hbsag/hcv/syphilis/malaria/nat_hiv/nat_hbv/nat_hcv), method, kit_lot, result enum(nr/reactive/indeterminate), value, tested_at, tested_by, validated_by, repeat_of?, source enum(analyser/manual)); **blood.grouping_results** (subject enum(donor/patient), subject_id, abo_forward, abo_reverse, rh, weak_d, antibody_screen, discrepancy bool, at, by, validated_by, source).
- **blood.component_batches** (id, equipment_id, program, started_at, ended_at, by, input_dins[], outputs jsonb); **blood.unit_modifications** (unit_id, type enum(irradiation/leucoreduction/pooling/aliquot/washing), params jsonb, at, by).
- **blood.storage_locations** (id, branch_id, type enum(fridge/freezer/agitator/satellite/transport), name, temp_min, temp_max, sensor_id?), **blood.temperature_logs** (location_id, at, temp, source enum(sensor/manual), by?, excursion bool) — partitioned; **blood.excursions** (location_id, from, to, max_temp, action, mo_decision, units_affected[]).
- **blood.requests** (id, hospital_id, branch_id, patient_id, admission_id?, encounter_id?, requested_by, indication jsonb (hb, plt, inr, reason), urgency enum(routine/urgent/emergency/mtp), items jsonb [{component, units, attributes}], consent_id?, emergency_release_form jsonb?, sample_id?, status enum(created/sample_received/grouped/cross_matched/partially_issued/completed/cancelled), created_at) — index (hospital_id, status, urgency).
- **blood.patient_samples** (request_id, label_din, collected_by, collected_at, received_at, rejected_reason?, second_sample bool).
- **blood.crossmatches** (request_id, unit_id, method enum(is/ahg/electronic), result enum(compatible/incompatible/pending), performed_by, validated_by, at, notes); **blood.reservations** (request_id, unit_id, reserved_until, released_at, reason).
- **blood.issues** (id, request_id, unit_id, issued_by, verified_by (2nd person), issued_at, transport jsonb, issue_slip_no, charge_line_id, returned_at?, return_accepted bool, return_reason).
- **blood.transfusions** (issue_id, unit_id, patient_id, admission_id, bedside_nurse1, bedside_nurse2, patient_scan_ok, unit_scan_ok, started_at, ended_at, volume_ml, vitals jsonb [{at, temp, hr, bp, rr, spo2}], outcome enum(completed/stopped_reaction/stopped_other), notes).
- **blood.reactions** (transfusion_id, noticed_at, symptoms jsonb, severity, actions jsonb, samples jsonb, workup jsonb (clerical, repeat group, dat, haemolysis, culture), classification, imputability, reported_by, mo_reviewed_by, hvpi_trrf_no, incident_id).
- **blood.mtp_activations** (id, patient_id, activated_by, at, location, packs jsonb [{seq, issued_at, units[]}], labs jsonb, deactivated_at, summary jsonb).
- **blood.discards** (unit_id, reason enum, at, by, method, bmw_ref); **blood.transfers** (unit_ids[], direction in/out, centre, doc_no, at).
- **blood.camps** (id, name, date, organiser, location, target, donors_registered, units_collected, staff, eraktkosh_id) — with NC-035.
- **blood.regulatory_reports** (period, type enum(sbtc/naco/eraktkosh/hvpi), payload, file_id, submitted_at, by).
- Read models: `analytics.mv_blood_stock` (Redis), `analytics.mv_blood_utilisation` (C:T, issued/transfused, wastage), `analytics.mv_tti_prevalence`, `analytics.mv_blood_tat`.

## 5. Business Rules & Validations

- Donor eligibility per NBTC/Schedule F: age 18–65 (first-time ≤ 60), weight ≥ 45 kg (350 mL) / ≥ 55 kg (450 mL, apheresis), Hb ≥ 12.5 g/dL, interval ≥ 90 d (M) / 120 d (F) whole blood, platelet apheresis ≥ 48 h & ≤ 24/yr, temporary/permanent deferral list configurable; deferred donors blocked; consent mandatory.
- Units cannot leave quarantine until all mandatory TTI non-reactive & grouping validated; reactive → all components discarded; donor counselling task.
- Expiry auto-computed by product/anticoagulant/modification (e.g. PRBC CPDA-1 35 d, SAGM 42 d; irradiated PRBC 28 d from irradiation or original expiry whichever earlier; platelets 5 d; open system 24 h/4 h).
- Issue requires: valid compatibility result (except emergency release with two-doctor form), consent (or emergency), expiry OK, second-person verification (different user), attribute requirements met; ABO/Rh compatibility matrix enforced (e.g. plasma AB universal; PRBC O universal; Rh-neg females of childbearing age must get Rh-neg unless MO override).
- Historical group mismatch → hard stop; first-time ABO requires second sample where policy set.
- Bedside: two authenticated nurses, patient + unit scan; time from issue > 30 min without controlled storage → block/discard; PRBC transfusion ≤ 4 h from spike.
- Reservation TTL default 72 h (OT until case end + 24 h); auto-release; C:T ratio > 2.5 flagged per department.
- Temperature excursion → units quarantined; MO decision documented; sensor gaps > 15 min alert.
- Charges: per component processing charge (NBTC caps configurable), cross-match, special processing, MTP packs; discards not chargeable; charity/scheme exemptions.
- Traceability: DIN ↔ donor ↔ components ↔ recipient retained ≥ 30 y (config); registers append-only; every issue/return/discard/reaction audited.
- Two-person rules use distinct authenticated users (PIN/2FA); blood bank roles require 2FA.
- SBTC/e-RaktKosh submissions logged; overdue reminders.

## 6. API Surface (`/api/v1/blood`)

| Method         | Path                                                                                                                                                                        | Purpose                                  | Permission                             | Idem                     | Pag    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------- | ------------------------ | ------ |
| POST/GET/PATCH | /donors, /donors/{id}                                                                                                                                                       | donor registry                           | blood.donor.manage / read              | Y                        | cursor |
| POST           | /donors/{id}/screenings                                                                                                                                                     | questionnaire, Hb, vitals → eligibility  | blood.donor.screen                     | Y                        | –      |
| POST           | /donations                                                                                                                                                                  | collection (DIN, bag, times, AE)         | blood.collection.record                | Y                        | –      |
| POST           | /donations/{id}/samples                                                                                                                                                     | pilot tubes → OP-004 orders              | blood.collection.record                | Y                        | –      |
| POST/GET       | /testing/grouping, /testing/tti                                                                                                                                             | results (manual/analyser) & validation   | blood.test.enter / validate            | Y                        | cursor |
| POST           | /components/batches                                                                                                                                                         | separation batch → child units & labels  | blood.component.prepare                | Y                        | –      |
| POST           | /units/{id}/modify                                                                                                                                                          | irradiate/leucoreduce/aliquot/pool       | blood.component.prepare                | Y                        | –      |
| GET            | /units?status=&component=&abo=&rh=&expiring_in=                                                                                                                             | inventory                                | blood.inventory.read                   | –                        | cursor |
| POST           | /units/{id}/move, /quarantine, /release, /discard, /transfer                                                                                                                | inventory ops                            | blood.inventory.manage / blood.discard | Y                        | –      |
| GET            | /stock                                                                                                                                                                      | live stock by group/component            | blood.inventory.read                   | –                        | –      |
| POST/GET       | /storage/{locId}/temperature                                                                                                                                                | temp logs (sensor/manual)                | blood.temp.record                      | Y                        | cursor |
| POST           | /requests                                                                                                                                                                   | transfusion request                      | blood.request.create                   | Y                        | –      |
| GET            | /requests?status=&urgency=&ward=                                                                                                                                            | worklist                                 | blood.request.read                     | –                        | cursor |
| POST           | /requests/{id}/samples/receive                                                                                                                                              | reject                                   | sample handling                        | blood.crossmatch.perform | Y      | –   |
| POST           | /requests/{id}/crossmatch                                                                                                                                                   | select units + results                   | blood.crossmatch.perform / validate    | Y                        | –      |
| POST           | /requests/{id}/reserve, /release-reserve                                                                                                                                    | reservations                             | blood.crossmatch.perform               | Y                        | –      |
| POST           | /requests/{id}/emergency-release                                                                                                                                            | uncross-matched issue authorisation      | blood.issue.emergency                  | Y                        | –      |
| POST           | /issues                                                                                                                                                                     | issue with 2nd-person verification token | blood.issue.confirm (+ witness)        | Y                        | –      |
| POST           | /issues/{id}/return                                                                                                                                                         | return handling                          | blood.issue.confirm                    | Y                        | –      |
| POST           | /transfusions/verify                                                                                                                                                        | bedside scan check (patient+unit)        | blood.transfusion.record               | –                        | –      |
| POST           | /transfusions (start), PATCH /transfusions/{id} (vitals/end)                                                                                                                | bedside record                           | blood.transfusion.record               | Y                        | –      |
| POST           | /transfusions/{id}/reaction                                                                                                                                                 | reaction report → workup                 | blood.reaction.report / workup         | Y                        | –      |
| POST           | /mtp/activate, /mtp/{id}/pack, /mtp/{id}/deactivate                                                                                                                         | MTP                                      | blood.mtp.activate / issue             | Y                        | –      |
| GET            | /reports/sbtc?period=, /reports/naco, /reports/hvpi, /reports/utilisation                                                                                                   | statutory & KPIs                         | blood.report.read / export             | –                        | –      |
| POST           | /eraktkosh/sync                                                                                                                                                             | push stock/camps                         | blood.integration.manage               | Y                        | –      |
| POST/GET       | /camps                                                                                                                                                                      | camps                                    | blood.camp.manage                      | Y                        | cursor |
| GET/PUT        | /config/products, /config/eligibility-rules, /config/mtp-packs, /config/charges                                                                                             | config                                   | blood.configure                        | Y                        | –      |
| Consumes       | `lab.result.available` (grouping/TTI from OP-004), `device.temperature` (EN-042), `ot.case.scheduled` (reserve), `ip.discharge.completed` (release), `trauma.mtp.requested` |                                          |                                        |                          |        |

## 7. Domain Events (outbox)

- `blood.donor.registered|screened|deferred`, `blood.unit.collected`, `blood.donor.adverse_event`.
- `blood.tti.reactive` {din, marker} → discard, counselling task, NACO register; `blood.unit.released` → stock; `blood.unit.discarded|expired|transferred`.
- `blood.stock.low` {abo, component, count} → in-charge, donor campaigns (EN-009), e-RaktKosh; `blood.temperature.excursion` → EN-037, biomedical.
- `blood.request.created|sample_received|crossmatched|reserved|reserve_released|cancelled` → wards, OT (readiness), TR-007.
- `blood.unit.issued` {din, patient, request} → IP-005 charge, IP-003 tasks (bedside), IP-006.
- `blood.unit.transfused` {din, patient, volumes} → EMR/IP-002 summary, IP-003 I/O, IP-012.
- `blood.reaction.reported|classified` → NC-015, HvPI queue, patient flags.
- `blood.mtp.activated|pack_issued|deactivated` → TR-007, IP-006, ICU.
- `blood.report.generated|submitted` {type, period}.

## 8. Screens (UI)

- **Donor Desk** (desktop/tablet): search/register donor, questionnaire (checkbox groups, auto-eligibility banner), Hb/vitals, deferral, consent capture, print donor card; camp mode (offline-capable tablet with later sync, `bb.camps`).
- **Collection Bay** (tablet/desktop with scanner): bag scan → DIN, timer, volume, AE quick log; label print.
- **Testing Worklist** (desktop): pending grouping/TTI by DIN, analyser results inbox, validate, discrepancy resolution; reactive units red.
- **Component Lab** (desktop): batch builder, output components with label print, quarantine board.
- **Inventory Dashboard** (desktop + TV in blood bank): stock grid group × component with expiry buckets, temperature tiles per fridge (live), alerts; `F` filter, `E` expiring, `D` discard.
- **Request Worklist / Cross-match Bench** (desktop): requests by urgency with timers, sample receive scan, patient group & history, unit picker (FEFO/compatible), cross-match results grid, compatibility report print, reserve.
- **Issue Counter** (desktop with scanner): request → units → checks → second-person PIN → issue slip print; returns.
- **Bedside Transfusion** (IP-004 phone/tablet & IP-003 desktop): 2-nurse scan flow, vitals timeline tasks, stop/reaction button with guided steps.
- **Reaction Workup** (desktop): symptoms, samples, workup results, classification, HvPI form export.
- **MTP Console** (desktop/TV in blood bank + requester phone view): active MTPs, pack timers, runner status, labs due.
- **Regulatory Reports** (desktop): SBTC/NACO/e-RaktKosh/HvPI generation, registers print/export, submission log.
- **Config**: products/expiry rules, eligibility rules, MTP packs, charges, storage locations/sensors.

## 9. Integrations

- OP-004/EN-004 analysers (immunohaematology & TTI: HL7/ASTM), EN-013 ISBT 128 labels (Code 128 with data identifiers), EN-005 label printers, EN-042 temperature sensors/data loggers (fridges, agitators; Modbus/HTTP), e-RaktKosh API/portal upload, SBTC state formats (XLS/PDF), HvPI TRRF (form export), EN-009 donor SMS (DLT templates), NC-035 camps, IP-005 charges, NC-006 reagents, NC-023 licence, IP-004/IP-003 bedside, TR-007/IP-006/IP-009/IP-011 MTP.
- Fallbacks: analyser down → manual double entry; sensor down → manual 4-hourly logs; e-RaktKosh down → file upload; label printer down → pre-printed ISBT labels with manual capture.

## 10. Reports & Analytics

- Stock & expiry, collections by type/camp, TTI seroprevalence by marker, discards by reason (wastage %), C:T ratio by department/surgeon, issue/transfusion TAT (routine/urgent/emergency, MTP first-pack), component utilisation, reactions per 1000 units (HvPI), near-misses, temperature excursions, donor retention/deferral rates, autologous usage, statutory registers, revenue by component.
- Read models in §4.

## 11. Notifications

- Donors: thanks, next eligible date, group-specific appeals during shortage, TTI counselling call (no result via SMS); Wards/doctors: request status (sample received/cross-matched/ready/issued), reserve expiring, reaction workup results; Blood bank: new urgent/MTP requests (alarm), temperature excursions, low stock, expiring units, analyser results pending validation, statutory report due; Quality: reactions/near-miss; Billing: charges posted.

## 12. Permissions (RBAC keys)

`blood.donor.manage|read|screen`, `blood.collection.record`, `blood.test.enter|validate`, `blood.component.prepare`, `blood.inventory.read|manage`, `blood.discard`, `blood.temp.record`, `blood.request.create|read`, `blood.crossmatch.perform|validate`, `blood.issue.confirm|emergency`, `blood.transfusion.record`, `blood.reaction.report|workup`, `blood.mtp.activate|issue`, `blood.camp.manage`, `blood.report.read|export`, `blood.integration.manage`, `blood.configure`.
Defaults: BB technician (37): donor._, collection, test.enter, component.prepare, inventory._, temp, crossmatch.perform, issue.confirm, mtp.issue; BB MO/in-charge: + test.validate, crossmatch.validate, issue.emergency approval, discard, reaction.workup, reports/export, configure, integration; Ward/ICU/OT nurse (17/18/20): request.create (with doctor), transfusion.record, reaction.report; Doctors: request.create, mtp.activate, request.read; Lab quality (35): report.read; Billing: read; SoD: `crossmatch.perform` user ≠ `issue.confirm` verifier for the same unit; witness must be different user.

## 13. Non-functional

- Volumes: 60–100 donations/day, 300 units issued/day, 30 requests/h peak, 20 storage locations with sensor readings every 1–5 min (~30k rows/day, partitioned), MTP alarm delivery < 5 s.
- p95: stock query < 100 ms (Redis), cross-match save < 200 ms, issue transaction < 300 ms, bedside verify < 150 ms.
- Offline: camp tablets (donor registration/screening) offline with sync; bedside verification via IP-004 cached issue data.
- Printing: ISBT 128 labels (100×100 mm), donor card, issue slip, compatibility report, registers (A4), TRRF.
- Security: 2FA for blood bank roles; donor PHI encrypted; TTI results restricted; audit all; PHI-free notifications.
- Retention: traceability 30 y (config), registers ≥ 5 y statutory.

## 14. Acceptance Criteria

1. Given a 17-year-old donor, then screening marks ineligible with reason; a female donor who donated 100 days ago is temporarily deferred until day 120.
2. Given Hb 12.2 g/dL, then the donor is deferred (temporary) and an SMS with next-eligible date is sent after consent.
3. Given a collection, then a unique ISBT 128 DIN is assigned, labels print, and the unit is `quarantine` until TTI & grouping validated.
4. Given HBsAg reactive on a donation, then the unit and all its components move to `discard_reactive`, a counselling task is created, the donor is deferred and NACO register updated; no component can be issued.
5. Given a whole-blood unit separated into PRBC/FFP/RDP, then each child unit shares the DIN with distinct product codes and computed expiries (PRBC SAGM 42 d, FFP 1 y, RDP 5 d).
6. Given fridge temperature 7.5 °C for 35 min, then an excursion alert fires, units in that fridge become `quarantine`, and MO decision is required to release.
7. Given a transfusion request without consent for a routine case, then it is rejected; for `emergency` with two-doctor form it proceeds.
8. Given a patient's historical group A+ and current sample tests B+, then cross-match is hard-stopped and a re-collect is demanded; a near-miss is logged.
9. Given cross-match compatible units reserved at 10:00 with 72-h TTL, then at 10:00 + 72 h they auto-release with `blood.reserve.released` and appear in stock.
10. Given issue attempt by the same user for both issue and verification, then it is refused (403 SoD); with a second user's PIN it succeeds and IP-005 receives processing charges.
11. Given bedside scan where the unit's request belongs to another patient, then verification fails with a red banner and cannot start; a near-miss record is created.
12. Given issue at 09:00 and bedside start attempted at 09:40 without controlled storage evidence, then start is blocked and the unit must be returned/discarded per rule.
13. Given a transfusion started at 10:00, then vitals tasks at 10:15, 10:30, hourly and at end are created; a temperature rise of 1.2 °C triggers the reaction guided workflow, stops the transfusion, and creates the workup with samples list and TRRF draft.
14. Given MTP activated from ER at 02:10, then the blood bank alarm sounds, Pack 1 composition is shown, first pack issue at 02:17 records 7 min, and deactivation produces a summary with units used/wasted.
15. Given an emergency uncross-matched issue of O-neg, then the emergency release form with two authorisers is stored and retrospective cross-match results append to the same request.
16. Given the SBTC monthly report is generated, then totals (collections, TTI reactive by marker, discards, issues) reconcile with the registers for the same period.
17. Given e-RaktKosh sync enabled, then stock counts by group/component are pushed hourly and failures appear in the integration log with retry.
18. Given a returned unit at 25 min with intact seal and temperature indicator OK, then MO can accept it back to `available`; at 35 min it must be discarded.

## 15. Enhancements / Later phases

- From VIMS sheet row 27: component therapy guidelines (indication prompts here), MTP activation (here), near-miss event reporting (here), platelet demand forecasting (AI-005 later), external blood bank network integration (`bb.external_network` — e-RaktKosh availability & partner requests), autologous donation tracking (here).
- (market) Cell/serum grouping validation, component requisition from wards, camp management, blood search/availability (all here). Later: electronic cross-match by default with validated systems, RFID unit tracking & smart fridges with per-unit access, donor mobile app & gamified retention (PE-005), NAT lab integration expansion, plasma fractionation dispatch records, patient blood management (PBM) dashboards, AI-based demand & shortage forecasting.

## 16. Open Questions for the Hospital

1. Blood centre licence category (whole blood + components? apheresis? NAT?), state SBTC report format, e-RaktKosh credentials?
2. Bag numbering: pre-printed ISBT DIN ranges from vendor or system-generated & printed?
3. Analysers in use for grouping/TTI and interface capability; NAT outsourced?
4. Cross-match policy (IS/AHG/electronic), second-sample rule, reservation TTLs, Rh-neg policy for males in emergency?
5. MTP pack composition and activation authority; TXA protocol?
6. Bedside verification: two nurses mandatory or nurse + doctor; device availability per ward?
7. Temperature monitoring hardware present (data loggers/BMS)? Manual logging frequency?
8. Processing charges per component (NBTC caps), exemptions for schemes/replacement donors?
9. Camp workflow & partners; donor communications consent/DLT templates?
10. HvPI reporting responsibility & TRRF submission method; haemovigilance committee?
11. Retention periods chosen for traceability records; archival of paper registers?
12. External units acceptance criteria and inter-centre transfer forms?
