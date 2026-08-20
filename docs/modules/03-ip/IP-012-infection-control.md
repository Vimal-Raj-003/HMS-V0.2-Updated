# IP-012 — Infection Control (HAI surveillance: CLABSI/CAUTI/VAP/SSI, device-days, culture & antibiogram, isolation management, hand-hygiene audits, bundle compliance, outbreak management, antimicrobial stewardship hooks)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | IP / Inpatient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Module ID       | IP-012                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Phase           | 7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Priority        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Depends on      | OP-004 (microbiology results: organisms, susceptibilities — LIS events), IP-003 (lines/tubes register, catheter days, bundles, isolation nursing), IP-009 (ventilator days, ICU bundles, central line days), IP-006 (SSI enrolment: wound class, ASA, duration, implants), IP-001 (isolation beds, terminal cleaning, bed board flags), OP-002/IP-010 (antibiotic orders — stewardship prompts), OP-003/IP-014 (antimicrobial consumption DDD), NC-018 (cleaning/terminal disinfection), NC-015 (incidents, CAPA), NC-016 (BMW), EN-003 (CSSD sterilisation failures), NC-020 (autoclave/AHU/water QC), NC-010 (staff health: needle-stick, vaccination), EN-029 (rules), EN-037 (alerts), EN-039 (audit forms), EN-018 (isolation indicators), NC-011/EN-001 (reports), EN-024 (audit), OP-017 (wound clinic follow-up), PE-002 (post-discharge SSI calls) |
| Feature flag    | `module.infection_control.enabled` (sub: `ic.antibiogram`, `ic.hand_hygiene_audit`, `ic.outbreak`, `ic.ams`, `ic.env_surveillance`, `ic.staff_health`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Primary roles   | Nurse — Infection Control Officer/ICN (21), Infection Control Officer (microbiologist/physician), HIC committee chair                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Secondary roles | Microbiology lab (33/13), Ward/ICU nurses (17/18), Doctors (7/9/11), Clinical pharmacist/AMS team (31/32), Quality (54), Housekeeping (50), CSSD (38), Biomedical (48), HR/staff health (47), MS (4), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Regulatory      | NABH 5th ed. HIC.1–HIC.8 (HIC programme, surveillance of HAI, device-associated infections, SSI, isolation, hand hygiene, sterilisation, outbreak, staff health), NABH indicators (CLABSI/CAUTI/VAP per 1000 device-days, SSI %, hand-hygiene compliance), CDC/NHSN definitions (2024) adapted, ICMR AMR surveillance network (AMRSN) formats, ICMR/NCDC Kayakalp & AMSP guidelines, WHO hand-hygiene 5 moments & HHSAF, WHO AWaRe antibiotic classification, Bio-Medical Waste Rules 2016, IDSP outbreak reporting (state), Clinical Establishments Act, DPDP                                                                                                                                                                                                                                                                                              |

## 1. Purpose

IP-012 gives the infection-control team a live surveillance workbench instead of paper line-lists: automatic candidate detection of healthcare-associated infections from LIS microbiology, device registers and clinical signals (CLABSI, CAUTI, VAP/VAE, SSI, others), case adjudication against NHSN/NABH definitions, denominators (device-days, patient-days, procedures) computed from IP-003/IP-009/IP-006 data, isolation management (orders, bed flags, PPE, terminal cleaning), hand-hygiene and bundle audits on tablets, cumulative antibiograms and MDRO tracking, outbreak detection and management, environmental surveillance results, staff health events, and antimicrobial stewardship hooks (restricted antibiotics, culture-guided de-escalation, DDD consumption). Outputs are NABH/ICMR-ready rates and dashboards.

## 2. Users & Jobs-to-be-done

- **ICN** (desktop + tablet rounds; 1 ICN per 100–150 beds): review daily HAI candidates, adjudicate, maintain isolation list, perform hand-hygiene/bundle/environment audits on tablet, follow SSI patients (30/90 d), track MDROs, prepare monthly HIC report.
- **ICO/microbiologist**: validate cases, antibiogram, outbreak investigation, policy.
- **Ward/ICU nurses**: get isolation orders/PPE, bundle checklists (IP-003/IP-009), report suspected infections/needle-sticks.
- **Doctors/AMS**: alerts on positive cultures/MDROs, de-escalation prompts, restricted antibiotic approvals (`ic.ams`).
- **Housekeeping/CSSD/biomedical**: terminal cleaning tasks, sterilisation/AHU/water results.
- **Quality/HIC committee**: KPIs, CAPA, NABH evidence.

## 3. Core Workflows

### 3.1 Denominators & device-days (automatic)

- Nightly job computes per unit/ward: patient-days (IP-001 census), central-line days, urinary-catheter days, ventilator days (IP-003 `lines_tubes`, IP-009 `ventilation_episodes`/`icu_lines_tubes`), procedures by SSI category (IP-006 completed cases with wound class/duration/ASA/implant) → `ic.denominators_daily`; gaps (missing removal dates) flagged to wards.

### 3.2 HAI candidate detection & adjudication

1. **Signals** (EN-029 rules on events): positive blood culture with central line in place ≥ 2 days (CLABSI candidate), positive urine culture ≥ 10⁵ CFU with catheter ≥ 2 days + symptoms/fever (CAUTI), ventilated ≥ 2 days with new/progressive infiltrate + fever/leucocytosis + purulent secretions/culture (VAP; VAE ventilator-associated condition from FiO2/PEEP increases via IP-009), post-op wound culture/purulent discharge/re-operation/nurse wound note within 30/90 days (SSI), other HAI (C. difficile, MDRO acquisition, hospital-onset bacteraemia) → **candidate case** created with evidence links → Event `ic.hai.candidate`.
2. **ICN adjudicates** on definition worksheet (NHSN-style criteria checklist per infection type; onset date > day 2; present-on-admission exclusion; secondary BSI attribution; MBI-LCBI) → confirmed / ruled out / under review; organism(s) & susceptibilities attached; device attribution; location attribution (unit at onset − transfer rule); notes → Event `ic.hai.confirmed`; auto-notify treating team & unit in-charge; CAPA link (NC-015) if bundle miss identified.
3. **SSI surveillance**: enrolment from IP-006; follow-up schedule (day 7/14/30, 90 with implants) via wound review (IP-003/OP-017), post-discharge calls (PE-002 script), OPD wound checks; classification superficial/deep/organ-space; surgeon-specific risk-adjusted rate (NNIS risk index: wound class, ASA ≥ 3, duration > T-time).

### 3.3 Isolation management

- Isolation **order** (doctor/ICN): type (contact/droplet/airborne/protective/combined), indication (MDRO, TB, measles, COVID/flu, neutropenia…), duration/criteria for discontinuation → IP-001 bed flag & board icon, room requirement (negative pressure/single room; move suggestion), PPE signage print, visitor restrictions (EN-015), housekeeping terminal cleaning on discharge/transfer (NC-018), transport precautions, cohorting; nurses' isolation checklist; discontinuation with criteria; **MDRO registry** (MRSA/VRE/CRE/ESBL/CRAB/C. auris) with flag on patient record across admissions (readmission alert → pre-emptive isolation) → Events `ic.isolation.started|ended`, `ic.mdro.flagged`.

### 3.4 Microbiology feed, antibiogram & alerts (`ic.antibiogram`)

- Consume `lab.micro.result` (organism, specimen, susceptibility panel MIC/zone, ESBL/carbapenemase flags): alerts for MDRO/notifiable organisms (to ICN, treating doctor, unit), blood culture positive (critical), cluster detection; **cumulative antibiogram** (CLSI M39: first isolate per patient per period, ≥ 30 isolates rule) by organism × antibiotic × unit/specimen/period → published to doctors (OP-002 empiric-therapy hints); MDRO trend; ICMR AMRSN export formats.

### 3.5 Hand hygiene & practice audits (`ic.hand_hygiene_audit`)

- Tablet forms (EN-039): WHO 5-moments direct observation (unit, session, HCW category, opportunity, action rub/wash/missed, glove use), compliance % by unit/category/moment; PPE audits; bundle audits (CLABSI insertion/maintenance, CAUTI, VAP — or pull from IP-003/IP-009 bundle records); environmental cleaning audits (fluorescent marker/ATP), sharps handling, BMW segregation spot checks (NC-016), CSSD/OT asepsis; scores with feedback & CAPA; monthly targets; anonymous observation option.

### 3.6 Outbreak detection & management (`ic.outbreak`)

- Rules: ≥ 2 cases same organism/unit within 7 days, or rate > baseline + 2 SD (statistical process control), or cluster of syndromic events (diarrhoea/rash) → **outbreak alert** to ICO → **outbreak record**: case definition, line list (auto-populated from candidates), epidemic curve, environmental/staff screening samples (OP-004 orders), control measures (cohorting, closure of unit/OT, enhanced cleaning, staff exclusion), communication log, IDSP/state notification (where required), closure & report → Event `ic.outbreak.declared|closed`.

### 3.7 Environmental & sterilisation surveillance (`ic.env_surveillance`)

- Schedules & results: OT/ICU air sampling (settle plates/active), water (dialysis RO endotoxin/culture — IP-022, drinking water), surface swabs, AHU/HEPA validation & pressure logs (EN-042/NC-020), autoclave BI/Bowie-Dick failures (EN-003 events → recall linkage), ETO/plasma cycles, endoscope reprocessing logs, linen microbiology; out-of-limit → CAPA.

### 3.8 Staff health & exposures (`ic.staff_health`)

- Needle-stick/sharps injury & body-fluid exposure reporting (source patient status, PEP start ≤ 2 h, follow-up 6 wk/3 m/6 m), staff vaccination status (Hep B titres, influenza, COVID, MMR/varicella), TB screening, staff illness exclusion (e.g. GI symptoms in kitchen), fit-testing (N95); linked to NC-010 HR with privacy controls.

### 3.9 Antimicrobial stewardship hooks (`ic.ams`)

- Restricted antibiotics list (WHO AWaRe Reserve/Watch subset) → CPOE prompt/approval workflow (EN-038: AMS physician within 24 h; provisional dose allowed), automatic **culture-guided review** at 48–72 h (culture results vs current antibiotics: mismatch/de-escalation opportunity alerts), antibiotic days of therapy & DDD/1000 patient-days from IP-014/OP-003 consumption, prophylaxis duration > 24 h post-op alert (IP-006), IV-to-oral switch prompts; AMS ward round list.

### 3.10 Exceptions

1. Missing device removal date → candidate device-days inflated → data-quality task to ward; ICN can correct with audit.
2. Culture from outside lab → manual entry of organism/susceptibility.
3. Patient transferred between units around onset → attribution rule (unit 2 days before onset) applied automatically, editable with reason.
4. Isolation bed unavailable → cohorting decision documented; IP-001 override alert.
5. Offline audit tablets → forms queue & sync.

## 4. Data Model (schema `ip` prefix `ic_`)

- **ip.ic_denominators_daily** (hospital_id, branch_id, unit_id, date, patient_days, cl_days, uc_days, vent_days, procedures jsonb by category, source_quality jsonb) — unique (unit_id, date).
- **ip.ic_hai_cases** (id, hospital_id, branch_id, patient_id, admission_id, type enum(clabsi/cauti/vap/vae/ssi/cdi/mdro_acq/ho_bsi/other), status enum(candidate/under_review/confirmed/ruled_out), onset_date, detected_at, detection_rule, unit_attributed_id, device_id?, procedure_case_id?, ssi_depth enum?, organisms jsonb [{name, specimen, susceptibility, mdro_flags}], criteria_worksheet jsonb, present_on_admission bool, secondary_bsi bool, adjudicated_by, adjudicated_at, capa_id?, notes, version) — index (hospital_id, type, status, onset_date).
- **ip.ic_ssi_followups** (case_enrolment_id (from IP-006), due_date, day, method enum(ward/opd/call/photo), result enum(no_infection/suspected/confirmed), notes, by).
- **ip.ic_isolation_orders** (id, admission_id, patient_id, type enum, indication, ordered_by, started_at, review_at, ended_at, end_criteria, room_requirement, cohort_group?, ppe jsonb, status); **ip.ic_mdro_registry** (patient_id, organism, first_detected_at, last_positive_at, cleared_at?, status active/cleared, source).
- **ip.ic_micro_isolates** (lab_result_id, patient_id, admission_id?, unit_id, specimen, collected_at, organism, susceptibilities jsonb, mdro_flags text[], first_isolate_period bool, hai_case_id?) — from OP-004 events; index (organism, collected_at).
- **ip.ic_antibiograms** (period, scope (unit/specimen/all), organism, antibiotic, n_isolates, pct_susceptible, published_at).
- **ip.ic_audits** (id, type enum(hand_hygiene/ppe/bundle/environment_cleaning/sharps/bmw/cssd_ot/other), unit_id, date, auditor_id, session jsonb, observations jsonb, score_pct, feedback_given bool, capa_id?); **ip.ic_hh_observations** (audit_id, hcw_category, moment 1–5, action enum(rub/wash/missed), gloves bool).
- **ip.ic_outbreaks** (id, declared_at, organism/syndrome, units, case_definition, status, line_list jsonb (case ids), measures jsonb, notifications jsonb, closed_at, report_file_id).
- **ip.ic_env_samples** (type, location, scheduled_at, collected_at, order_id?, result, limit, pass bool, action); **ip.ic_sterilisation_events** (source enum(cssd/eto/endoscope/ahu/water), ref, at, result, capa_id?).
- **ip.ic_staff_exposures** (staff_id, at, type, source_patient_id?, source_status jsonb, pep_started_at, followups jsonb, closed_at) — restricted access; **ip.ic_staff_immunisation** (staff_id, vaccine, date, titre, due).
- **ip.ic_ams_reviews** (admission_id, order_id, antibiotic, aware_class, day, culture_status, recommendation enum(continue/de_escalate/stop/iv_to_po/switch), reviewer_id, accepted bool); **ip.ic_restricted_approvals** (order_id, requested_by, approver_id, status, decided_at).
- Read models: `analytics.mv_hai_rates_monthly` (per unit/type: cases, denominators, rate, CI), `analytics.mv_hh_compliance`, `analytics.mv_mdro_trend`, `analytics.mv_ams_consumption`.

## 5. Business Rules & Validations

- Definitions per NHSN (configurable year) & NABH; HAI onset ≥ day 3 of admission (day 1 = admission day); device-associated requires device in place > 2 consecutive days on date of event or day before; location attribution = unit where patient was on onset date (transfer rule: unit of prior day if transferred that day/previous day).
- Rates: CLABSI/CAUTI/VAP per 1000 device-days; SSI % per procedure category with NNIS risk index; HO-BSI per 10k patient-days; published monthly after ICO validation; corrections versioned.
- Candidates must be adjudicated within 72 h (task/escalation to ICO); ruled-out requires reason.
- Isolation orders reviewed at set intervals; discontinuation criteria documented; MDRO flags persist across admissions until cleared per policy (e.g. 3 negative screens); readmission of MDRO patient → alert at admission (IP-001).
- Antibiogram: first isolate per patient per period per organism; publish only ≥ 30 isolates; annual/half-yearly per unit.
- Hand-hygiene: min observations per unit per month (config, e.g. 200 opportunities); auditors trained; feedback recorded.
- Outbreak thresholds configurable; declaration by ICO; closure with report; statutory notification logged.
- Restricted antibiotic orders need AMS approval within 24 h (provisional supply allowed); 48–72 h review mandatory (task); prophylaxis > 24 h flagged.
- Staff exposure records restricted to ICN/staff health; PEP timing tracked; anonymised reporting.
- Audit trail on adjudication, isolation, outbreak decisions; retention ≥ 10 y (staff records per HR policy).

## 6. API Surface (`/api/v1/ic`)

| Method     | Path                                                                                           | Purpose                                                                                           | Permission                      | Idem                                                                                                                                               | Pag    |
| ---------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| GET        | /denominators?unit=&from=                                                                      | device/patient days                                                                               | ic.surveillance.read            | –                                                                                                                                                  | cursor |
| POST       | /denominators/recompute                                                                        | rerun job for period                                                                              | ic.surveillance.manage          | Y                                                                                                                                                  | –      |
| GET        | /hai/cases?status=&type=&unit=                                                                 | worklist                                                                                          | ic.surveillance.read            | –                                                                                                                                                  | cursor |
| POST       | /hai/cases (manual) / PATCH /hai/cases/{id}/adjudicate                                         | create/adjudicate                                                                                 | ic.hai.adjudicate               | Y                                                                                                                                                  | –      |
| GET        | /hai/cases/{id}/evidence                                                                       | linked cultures/devices/notes                                                                     | ic.surveillance.read            | –                                                                                                                                                  | –      |
| POST/GET   | /ssi/enrolments/{id}/followups                                                                 | SSI follow-up                                                                                     | ic.ssi.followup                 | Y                                                                                                                                                  | cursor |
| POST/PATCH | /isolation-orders[/{id}]                                                                       | isolation start/review/end                                                                        | ic.isolation.order (doctor/ICN) | Y                                                                                                                                                  | cursor |
| GET        | /isolation-orders?active=&unit=                                                                | isolation list                                                                                    | ic.isolation.read               | –                                                                                                                                                  | cursor |
| POST/PATCH | /mdro-registry                                                                                 | flags & clearance                                                                                 | ic.mdro.manage                  | Y                                                                                                                                                  | cursor |
| GET        | /isolates?organism=&unit=&from=                                                                | isolates                                                                                          | ic.surveillance.read            | –                                                                                                                                                  | cursor |
| POST       | /antibiogram/compute, GET /antibiogram?period=&scope=                                          | antibiogram                                                                                       | ic.antibiogram.manage / read    | Y                                                                                                                                                  | –      |
| POST/GET   | /audits, /audits/{id}/observations                                                             | HH/practice audits                                                                                | ic.audit.write / read           | Y                                                                                                                                                  | cursor |
| POST/PATCH | /outbreaks[/{id}]                                                                              | outbreak record                                                                                   | ic.outbreak.manage              | Y                                                                                                                                                  | cursor |
| POST/GET   | /env-samples, /sterilisation-events                                                            | environmental                                                                                     | ic.env.write / read             | Y                                                                                                                                                  | cursor |
| POST/GET   | /staff-exposures, /staff-immunisation                                                          | staff health                                                                                      | ic.staff_health.write / read    | Y                                                                                                                                                  | cursor |
| POST/GET   | /ams/reviews, /ams/restricted-approvals[/{id}/decide]                                          | stewardship                                                                                       | ic.ams.review / approve         | Y                                                                                                                                                  | cursor |
| GET        | /reports/hai-rates?from=&unit=, /reports/hh, /reports/mdro, /reports/ams, /reports/icmr-export | KPIs & exports                                                                                    | ic.report.read / export         | –                                                                                                                                                  | –      |
| GET/PUT    | /config/definitions, /config/thresholds, /config/restricted-list                               | config                                                                                            | ic.configure                    | Y                                                                                                                                                  | –      |
| Consumes   | `lab.micro.result` (OP-004), `nursing.line.inserted                                            | removed`, `icu.vent._`, `icu.line._`, `ot.case.completed`, `nursing.wound.recorded`, `ip.admitted | transferred                     | discharge.completed`, `pharmacy.issued{antibiotic}`, `cssd.cycle.failed`(EN-003),`device.env.reading`(EN-042),`order.created{antibiotic}` (OP-002) |        |     |     |     |

## 7. Domain Events (outbox)

- `ic.hai.candidate` {type, patient, unit} → ICN worklist; `ic.hai.confirmed|ruled_out` → treating team, unit in-charge, NC-015 (CAPA), quality dashboards, IP-009/TR-011.
- `ic.isolation.started|reviewed|ended` {type} → IP-001 (bed flag), EN-018, NC-018 (terminal clean), EN-015 (visitor limits), IP-003 (checklists).
- `ic.mdro.flagged|cleared` → patient banner (OP-001), IP-001 admission alert.
- `ic.micro.alert` {organism, mdro, critical} → doctor (IP-010), ICN.
- `ic.antibiogram.published` → OP-002 hints.
- `ic.audit.recorded` {type, score}; `ic.outbreak.suspected|declared|closed` → MS, units, IDSP log.
- `ic.env.out_of_limit`, `ic.sterilisation.failure` → CSSD/biomedical, CAPA.
- `ic.staff.exposure_reported` → staff health; `ic.ams.review_due|recommendation|restricted_approval_decided` → doctors, pharmacy.
- `ic.rates.published` {period} → EN-001/NC-011.

## 8. Screens (UI)

- **ICN Dashboard** (desktop): today's candidates by type, isolation census, MDRO alerts, audits due, outbreaks, env/sterilisation exceptions, KPI tiles (rates vs targets), quick links.
- **HAI Case Worklist & Adjudication** (desktop): candidate list with evidence preview; case page with definition worksheet checkboxes, timeline (device days, cultures, vitals, notes), attribution, organisms, decision & CAPA; `A` adjudicate, `E` evidence, `N` next.
- **SSI Follow-up Board**: enrolled procedures with due follow-ups, wound photos (IP-004/OP-017), call outcomes (PE-002).
- **Isolation Board** (desktop + ward TV icons via EN-018): active isolations by ward with type/PPE, review dates, room status; order dialog; signage print.
- **Micro Feed & Antibiogram** (desktop): isolate stream with MDRO filters; antibiogram matrix (heat-map by % susceptible) with scope filters; publish; export ICMR format.
- **Audit Tablet Forms** (tablet/phone; offline): hand-hygiene observation tally UI (moment/action taps), PPE/bundle/environment checklists, photo evidence; unit feedback view.
- **Outbreak Console**: line list, epi curve, measures checklist, notifications, report.
- **Environmental Surveillance** calendar & results; **Staff Health** (restricted); **AMS Round List** (patients on restricted/Watch antibiotics with culture status & recommendation).
- **HIC Reports** (desktop): monthly pack (rates with denominators & CI, HH compliance, MDRO trends, audits, CAPA status), NABH indicator export.

## 9. Integrations

- OP-004 LIS micro (organism/susceptibility events; WHONET/ICMR export), IP-003/IP-009 registers & bundles, IP-006 SSI enrolment, IP-001 isolation flags & terminal cleaning, NC-018, EN-003 CSSD, NC-020/EN-042 (AHU pressure, water QC), OP-002/IP-010 (AMS prompts/approvals via EN-038), OP-003/IP-014 (consumption DDD), NC-015 (CAPA), NC-010 (staff), PE-002 (SSI calls), OP-017 (wound clinic), EN-018 (icons), state IDSP portal (manual/export).

## 10. Reports & Analytics

- Device-associated rates (CLABSI/CAUTI/VAP per 1000 device-days) & device utilisation ratios by unit/month with control charts; SSI rate by procedure/surgeon (risk-adjusted); HO-BSI; MDRO incidence & prevalence; antibiogram; hand-hygiene compliance by unit/HCW/moment; bundle compliance; isolation days; outbreak log; environmental/sterilisation exceptions; staff exposures & PEP timeliness; AMS: DDD/DOT per 1000 patient-days, restricted approvals TAT, de-escalation acceptance, prophylaxis > 24 h %; NABH HIC indicators pack; ICMR AMRSN export.
- Read models in §4.

## 11. Notifications

- ICN: new candidates, MDRO/notifiable organisms, outbreak threshold, audits due, env/sterilisation failures, isolation reviews due, staff exposure; Doctors: positive blood culture/MDRO for own patient, AMS recommendation, restricted approval outcome, isolation orders; Units: isolation start/end, HH feedback; Housekeeping: terminal cleaning; MS/quality: outbreak declared, monthly rates; HR/staff health: exposures & vaccine due.

## 12. Permissions (RBAC keys)

`ic.surveillance.read|manage`, `ic.hai.adjudicate`, `ic.ssi.followup`, `ic.isolation.order|read`, `ic.mdro.manage`, `ic.antibiogram.manage|read`, `ic.audit.write|read`, `ic.outbreak.manage`, `ic.env.write|read`, `ic.staff_health.write|read`, `ic.ams.review|approve`, `ic.report.read|export`, `ic.configure`.
Defaults: ICN (21): all surveillance/audit/isolation/env/staff_health/report; ICO/microbiologist: + adjudicate validation, antibiogram.manage, outbreak.manage, configure; Doctors: isolation.order, antibiogram.read, ams (AMS physician: approve); Nurses: isolation.read, audit.write (peer audits if allowed); Pharmacist (AMS): ams.review; Quality (54): report.read; HR: staff_health.read (limited); Housekeeping/CSSD: read tasks via own modules.

## 13. Non-functional

- Volumes: 2000 beds → ~1.2k device-days/day, 300 micro results/day, 50 candidates/day, 2k HH observations/month/ICN; nightly denominators job < 5 min; candidate detection < 10 s from lab event; antibiogram compute < 30 s per period.
- Offline audits on tablets; PHI-minimal exports (de-identified line lists for ICMR).
- Security: staff health restricted; audit trail on adjudication; retention ≥ 10 y.

## 14. Acceptance Criteria

1. Given a central line inserted day 1 and a positive blood culture (E. coli) on day 4, then a CLABSI candidate is created with evidence links within 10 s of the lab event and appears in the ICN worklist.
2. Given a positive urine culture on day 2 of admission with a catheter placed on admission, then no CAUTI candidate is created (onset < day 3 / device < 2 days) — or it is created as present-on-admission per configured definition and auto-excluded.
3. Given the ICN adjudicates a candidate as confirmed CLABSI attributed to MICU with organism & susceptibility, then `ic.hai.confirmed` notifies the treating team, the monthly rate for MICU includes the case, and a CAPA link can be created.
4. Given MICU had 310 central-line days and 2 confirmed CLABSI in a month, then the report shows 6.45 per 1000 CL-days with the denominator sourced from IP-009 line register.
5. Given a laparoscopic cholecystectomy completed (clean-contaminated, ASA 2, 70 min), then an SSI enrolment with follow-ups at day 7/14/30 exists; a wound-culture positive on day 10 creates an SSI candidate.
6. Given an isolation order (contact, CRE) placed, then the bed board shows the isolation icon, PPE signage prints, visitor limits apply, and discharge triggers a terminal-cleaning task; discontinuation requires criteria.
7. Given a patient with an active MDRO flag is readmitted 3 months later, then the admission desk sees an alert and pre-emptive isolation is suggested.
8. Given 45 first isolates of Klebsiella pneumoniae in ICU for the half-year, then the antibiogram publishes % susceptible per antibiotic; an organism with 20 isolates is not published.
9. Given three Acinetobacter isolates in SICU within 5 days, then an outbreak alert fires; declaring an outbreak auto-populates the line list and epi curve.
10. Given a hand-hygiene session with 40 opportunities and 30 actions, then compliance = 75 % by unit and moment; a unit below 70 % target shows red on the dashboard.
11. Given a Reserve-group antibiotic (e.g. colistin) ordered, then a restricted-approval task goes to the AMS physician; provisional supply is allowed for 24 h; a 72-h culture-guided review task is created.
12. Given cultures show susceptibility to a narrower agent while a broad-spectrum antibiotic continues at 72 h, then a de-escalation recommendation alert reaches the doctor and the response is recorded.
13. Given a needle-stick reported at 14:00, then the PEP timer shows time since exposure, source status fields prompt testing orders, and follow-ups at 6 weeks/3/6 months are scheduled; access is restricted to staff-health roles.
14. Given an autoclave BI failure event from EN-003, then a sterilisation event with CAPA is created and affected trays are traced.
15. Given the monthly HIC pack generation, then it includes rates with denominators, HH compliance, MDRO trends and audit results, and matches manual recomputation on test data.

## 15. Enhancements / Later phases

- From VIMS sheet row 91 / costed proposal IP-012: HAI surveillance, antibiogram, culture reports, alert triggers, hand-hygiene audit, isolation protocol (all here); from IP-006 row: SSI surveillance (here).
- (market) PCS "Infection Control" nursing entries (here via IP-003). Later: automated NHSN-style electronic surveillance with ML (AI-005), electronic hand-hygiene monitoring (RTLS/dispenser sensors EN-042), WHONET auto-export, real-time AMS decision support (AI-002), UV/robot cleaning integration logs, wastewater/environmental genomics (research), staff exposure mobile reporting (NC-014).

## 16. Open Questions for the Hospital

1. HAI definitions used (NHSN year, NABH), units under surveillance, ICN staffing?
2. LIS microbiology data completeness (structured organism/susceptibility, MDRO flags)? WHONET use?
3. Isolation room inventory & policy; MDRO clearance criteria; cohorting rules?
4. Hand-hygiene audit targets & auditors; electronic monitoring plans?
5. Antibiotic policy: restricted list, AMS team composition, approval TAT, prophylaxis rules?
6. Outbreak thresholds & notification obligations (state IDSP)?
7. Environmental sampling schedule/limits; AHU/water monitoring data sources?
8. Staff health programme owner (HR vs ICN); vaccination requirements; PEP kit locations?
9. SSI follow-up method post-discharge (calls/OPD/photos) and who performs it?
