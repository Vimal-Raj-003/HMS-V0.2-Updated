# EN-031 — NABL Integration / Lab Quality (ISO 15189 & NABL 112 Checklist Mapping, IQC Setup & Levey-Jennings, Westgard Multi-Rules, Corrective Action Log, EQA/PT Enrolment & Scoring, Instrument Validation & Calibration, Method Validation/Verification, TAT & Rejection Indicators, Competency Records, Audit-Readiness Pack)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Module ID       | EN-031                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase           | 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Priority        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Depends on      | OP-004 (LIS — orders, samples, results, reference ranges, report release), EN-004 (analyzer interface — QC results arrive over HL7/ASTM), EN-027 (test master, analyte, method, units UCUM, LOINC, reference intervals), NC-020 (Biomedical Engineering — equipment registry, calibration & service records), NC-004 (Document Management — SOPs, version control), NC-015 (Quality/NABH — CAPA, internal audit), EN-039 (form templates for validation protocols & competency checklists), EN-037 (QC failure alerts), EN-024 (audit), EN-036 (historical QC import), NC-010 (HR — staff records for competency)                                                                                                                                               |
| Consumed by     | OP-004 (auto-release gating: results cannot be released when the run's QC is out of control), IP-007 (blood bank QC of reagents/equipment), OP-008 (imaging QC where applicable — AERB records live in NC-020), EN-001 (quality dashboards), EN-029 (critical/panic value table is authored here jointly with EN-029)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Feature flag    | `module.lab_quality.enabled` (sub: `labqc.westgard`, `labqc.eqa`, `labqc.method_validation`, `labqc.competency`, `labqc.six_sigma`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Primary roles   | Lab Quality Manager (35), Pathologist / Lab Director (13), Lab Technician (33)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Secondary roles | Biomedical Engineer (48 — calibration/service), Quality Manager NABH (54), Hospital Admin (2), Microbiologist/Section heads, IT Admin (56 — analyzer QC feed), Auditor (58 — external NABL assessor read-only view), HR (47 — competency & training records)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Regulatory      | **NABL 112** (Specific Criteria for Medical Testing Laboratories) and **ISO 15189:2022** — management & technical requirements, QC, EQA, traceability, measurement uncertainty, competence; **NABL 163** (measurement uncertainty), **NABL 126/216** (PT/EQA participation policy — participation is mandatory for every discipline in scope), **NABL 133** (accreditation document requirements); CLSI guidance (EP05 precision, EP06 linearity, EP09 method comparison, EP15 verification, EP28 reference intervals, C24 statistical QC); **Clinical Establishments Act** and state licensing; **AERB** for radiology QA (NC-020), **CDSCO/Drugs & Cosmetics** for reagent/kit registration and lot traceability; NABH 6th edn chapter on diagnostic services |

## 1. Purpose

EN-031 turns NABL/ISO 15189 compliance from a binder exercise into live system data: it holds the accreditation scope, maps every NABL 112 clause to evidence produced elsewhere in the HMS, runs the daily internal quality control programme (levels, lots, targets, Levey-Jennings charts, Westgard multi-rules) with hard gating of result release, manages EQA/PT programme enrolment and scoring, records instrument calibration/validation and method validation, tracks TAT and sample-rejection indicators, holds staff competency records, and produces a one-click **audit-readiness pack** for an assessor. OP-004 owns testing; EN-031 owns proof that the testing is trustworthy.

## 2. Users & Jobs-to-be-done

- **Lab Technician (33, desktop at the bench, daily)**: run QC at shift start, see instantly whether the run passed or which Westgard rule broke, record the corrective action, and re-run — all before a single patient result is released.
- **Lab Quality Manager (35, desktop, daily/weekly/monthly)**: set up QC lots and targets, review LJ charts and monthly CV/bias/Six-Sigma, register EQA cycles, enter/upload EQA results before the deadline, analyse Z-scores, drive CAPAs, and keep the accreditation scope current.
- **Pathologist / Lab Director (13)**: approve method validation and reference-interval changes, sign off monthly QC review, authorise release of results after a QC deviation, and own the competency programme.
- **Biomedical Engineer (48)**: log preventive maintenance, calibration certificates with traceability to national standards, and breakdown/repair records that must precede re-validation.
- **Assessor / Auditor (58, read-only)**: open the audit-readiness pack — scope, SOPs with versions, QC record for any date, EQA performance, calibration certificates, competency matrix, non-conformity and CAPA log — and trace any released report back to the QC that supported it.
- **Section head (Biochemistry/Haematology/Micro/Serology/Histopath)**: manage section-specific rules, run charts and staff competencies.

## 3. Core Workflows

### 3.1 Accreditation scope & NABL 112 clause mapping

1. Quality Manager records the **accreditation scope**: laboratory identity (NABL certificate no., validity, disciplines — Clinical Biochemistry, Clinical Pathology, Haematology & Immunohaematology, Microbiology & Serology, Histopathology, Cytopathology, Molecular), and per-test scope rows (test, method/principle, equipment, measurement range, measurement uncertainty, CRM/traceability).
2. Each **NABL 112 / ISO 15189 clause** is a row in `labq_checklist_items` with: clause no., requirement text, responsible role, **evidence source** (auto-linked: SOP document in NC-004, QC records here, EQA cycle here, calibration in NC-020, competency here, TAT report from OP-004, complaint log NC-032, internal audit NC-015), compliance status (compliant / partial / non-compliant / not applicable), last verified date, gap note, target date.
3. A **gap dashboard** shows readiness % per clause group, with the top gaps and their owners; the pack export is refreshed on demand and pre-assessment.
4. Scope changes (new test added to accreditation) require method validation (§3.5) + EQA enrolment (§3.4) + competency before the test can be flagged `in_scope` and printed with the NABL symbol on the report.

### 3.2 IQC setup (levels, lots, targets)

1. Quality Manager defines a **QC material**: manufacturer, product, lot no., level (L1 normal / L2 abnormal-high / L3 abnormal-low or assay-specific), expiry, storage, open/in-use date and stability, analyte list with **manufacturer assigned mean & SD** (package insert) and units.
2. For each analyte × instrument × method, a **QC target** is established: initial from the insert, then **laboratory-derived** after 20 runs over ≥20 days (NABL expectation) — the system computes mean, SD, CV and prompts "cumulative mean/SD available — adopt as target?" with Director approval. Targets are effective-dated; old targets remain for historical chart integrity.
3. **QC schedule**: per instrument/analyte — how many levels, at what frequency (per shift, per run, every N samples, after calibration, after maintenance), and which shifts. A missed scheduled QC raises a task and, after the grace window, blocks result release for that analyte.
4. **Lot changeover**: parallel testing of old and new lot for ≥10 runs, comparison report, Director approval, then activation with an effective date — LJ charts show the lot boundary as a vertical marker (never merged silently).

### 3.3 Running QC, Levey-Jennings & Westgard multi-rules

1. **Technician** runs the QC materials on the analyzer → results arrive automatically over HL7/ASTM through EN-004 (matched by QC sample id/lot) or are entered manually with a reason.
2. The engine computes **z-score** = (value − target mean)/target SD and evaluates **Westgard multi-rules** across the configured rule set:
   - `1-3s` (reject), `1-2s` (warning only — never auto-reject), `2-2s` (within-run across levels, or across-run same level), `R-4s` (range across levels in a run), `4-1s`, `10-x` (or `8-x`/`12-x` per configuration), `7-T` (trend), `2-of-3-2s`, `3-1s`, `6-x`, `9-x` — each rule individually enabled per analyte with its N (number of controls) and R (runs) parameters. Configuration follows a **Six-Sigma-based rule selection**: high-sigma analytes get `1-3s` only (fewer false rejections), low-sigma analytes get the full multi-rule set with N=4.
   - Rules may be `reject` or `warning`; a `reject` sets the run **out of control**.
3. **Out-of-control consequence** (the gate): the analyte on that instrument is placed in `qc_blocked` state → OP-004 **cannot auto-release or manually release** patient results for that analyte produced in the affected window (from the last in-control QC to the next accepted QC) → affected pending results are listed → Event `labq.qc.out_of_control`.
4. **Corrective action**: technician records the investigation from a coded cause list (control degraded/expired, reagent lot change, calibration drift, instrument fault, pipetting error, temperature excursion, operator error, random error) + action taken (repeat QC, new control vial, recalibrate, reagent change, maintenance, engineer call) + outcome; repeat QC in control → run released with a **release decision** (who authorised, whether patient results in the window need re-testing) → Event `labq.qc.corrective_action_recorded`.
5. **Patient result impact**: for the affected window the system offers `retest all`, `retest selected`, or `release with Director authorisation + comment` — the third path is audited, requires `labq.qc.release_override`, and stamps the report with an internal (not patient-visible) flag.
6. **Levey-Jennings chart**: per analyte × level × lot × instrument, with ±1/2/3 SD zones, target mean line, rule-violation markers, lot/target change vertical lines, hover detail (value, z, operator, reagent lot, calibration id), and month/quarter views. Multi-level overlay and a **Youden plot** for two-level comparison.
7. **Monthly QC review**: mean, SD, CV%, bias vs peer/target, **Six-Sigma metric** σ = (TEa% − |bias%|)/CV% using an allowable-total-error source (CLIA/ Ricos biological variation/ NABL-accepted), total error, number of rule violations, downtime; Director signs the review → stored as evidence.

### 3.4 EQA / PT (proficiency testing) programme

1. **Enrolment**: Quality Manager registers the lab in EQA programmes per discipline with provider, cycle calendar, participant/lab code, analyte panel and fee — Indian providers commonly used: **CMC Vellore EQAS** (clinical biochemistry, haematology, microbiology, immunoassay), **AIIMS EQAS**, **BioRad EQAS (Unity)**, **Randox RIQAS**, **NABL-approved national PT providers**, **NEQAS** for specific disciplines. NABL requires participation for _every_ discipline/analyte in the accreditation scope; the system flags in-scope analytes with **no EQA enrolment** as a compliance gap.
2. **Cycle lifecycle**: sample received (date, condition, lot) → tested **as a routine patient sample by a routine operator** (NABL requirement — no special treatment; the system records the operator and instrument used) → results entered/uploaded → submitted to provider before the deadline (deadline reminders at 7/3/1 days) → provider report received → **Z-score / SDI / % deviation** entered or parsed → performance classified (satisfactory / questionable |Z|>2 / unsatisfactory |Z|>3).
3. **Unsatisfactory or two consecutive questionable results mandate a documented root-cause investigation and CAPA** (NC-015), with re-verification of the method and, where indicated, re-testing of stored patient samples from the period. Event `labq.eqa.unsatisfactory`.
4. **Trend analysis**: Z-score run charts per analyte across cycles, bias trend, comparison with the peer group and with the lab's own IQC bias — persistent same-direction bias triggers a calibration/traceability review.
5. **Alternative assessment** where no PT programme exists for an analyte (NABL-permitted): inter-laboratory comparison with a named partner lab, split-sample analysis, or CRM re-testing — recorded with the same rigour and the justification for the alternative.

### 3.5 Method validation / verification & instrument validation

1. **New test or new method** → a validation plan is created from a template (EN-039): purpose (validation for in-house/modified methods, verification for standard commercial methods), acceptance criteria, and the studies to run.
2. Studies, each with structured data capture, computation and pass/fail against criteria:
   - **Precision** (CLSI EP05/EP15): within-run and between-day CV over ≥5 days × ≥2 replicates × ≥2 levels; compare to manufacturer/desirable CV.
   - **Trueness/bias** via CRM or method comparison (**EP09**: ≥40 patient samples across the range, Passing-Bablok/Deming regression + Bland-Altman plot, slope/intercept/r with confidence intervals).
   - **Linearity / reportable range** (EP06): dilution series, recovery %, upper/lower limits of the analytical measurement range and the clinically reportable range with dilution factors.
   - **LoB/LoD/LoQ** (EP17) for low-level analytes.
   - **Analytical specificity/interference** (haemolysis, icterus, lipaemia indices; documented HIL thresholds that auto-comment on reports).
   - **Carryover**, **stability** (sample, on-board reagent, calibrator).
   - **Reference interval verification** (EP28): adopt the manufacturer/literature interval after verifying with ≥20 healthy reference individuals, or establish locally; results by age/sex/pregnancy write back to EN-027 with effective dating and Director approval.
   - **Measurement uncertainty** (NABL 163): computed from IQC long-term SD + calibrator uncertainty + bias, expressed with k=2, stored per test and printable on request.
3. **Validation report** is generated (PDF with charts), reviewed and **signed by the Lab Director** (EN-016 e-sign) → the test becomes `validated` with an effective date; only then can it be added to the accreditation scope and made orderable in OP-004.
4. **Instrument validation**: installation qualification (IQ), operational qualification (OQ) and performance qualification (PQ) records at commissioning; after any major repair, relocation or software upgrade, a **re-qualification checklist** must pass before the instrument returns to service — the system blocks result acceptance from an instrument in `out_of_service`/`requalification_pending` state.
5. **Calibration**: calibration events (calibrator lot, expiry, date, operator, result, acceptance), calibration verification frequency per analyte, and **traceability records** to certified reference materials/standards; external calibration certificates for pipettes, balances, thermometers, centrifuges and temperature-monitoring devices are held in NC-020 with expiry alerts surfaced here.

### 3.6 Environmental & equipment monitoring

- Daily temperature logs for refrigerators, freezers (−20 °C/−80 °C), incubators, room temperature and humidity — entered manually or ingested automatically from IoT sensors (EN-042), with configured limits, excursion alerts, duration-of-excursion computation and a mandated corrective action + impact assessment on stored reagents/samples.
- Autoclave/biosafety cabinet certification, water quality (conductivity, microbial), eyewash and safety checks — schedules with due/overdue status.
- Every excursion links to affected reagent lots and, where relevant, to a QC re-run requirement.

### 3.7 TAT, rejection & quality indicators

- **TAT** is measured by OP-004 events but _governed_ here: targets per test/priority (stat/urgent/routine) across segments — collection→receipt, receipt→analysis, analysis→verification, verification→report delivery — with % within target, median and 90th percentile, outlier drill-down and reasons.
- **Sample rejection** indicators: rejection rate by reason (haemolysed, clotted, insufficient, wrong container, unlabelled/mislabelled, delayed transport, wrong patient), by collection area and by phlebotomist — with a mandatory monthly review and CAPA when above threshold.
- **Other NABL indicators** tracked with numerator/denominator definitions and monthly targets: % of critical values reported within the defined time (with read-back), % of reports amended/corrected after release (with reason categories), % stat tests within TAT, EQA participation & performance, uptime/downtime per analyzer, repeat-test rate, contamination rate (blood culture), % of requests with incomplete clinical information, staff competency completion %, complaint rate.

### 3.8 Competency & training records

- Per staff member × procedure/instrument: initial training, direct observation of performance, monitoring of results/worksheets, blind sample/unknown testing, problem-solving assessment — the six CLIA-style elements NABL assessors look for; **twice in the first year, annually thereafter**.
- Records hold assessor, date, outcome, retraining actions, and authorisation to perform (which tests on which instruments) — OP-004 **enforces** this: a technician not authorised for an analyte cannot enter/verify its results.
- Continuing education, internal audit training, biosafety and phlebotomy competency; expiry alerts 60/30/7 days.

### 3.9 Non-conformity, CAPA & internal audit

- Non-conformities from any source (QC failure trend, EQA unsatisfactory, internal audit, complaint NC-032, incident, assessor finding) are logged with severity, immediate correction, root-cause analysis (5-why/fishbone template), corrective action, effectiveness verification date and closure — mirrored to NC-015 so the hospital-wide quality system holds one CAPA register.
- **Internal audit** schedule against NABL 112 clauses, auditor assignment (independent of the audited area), findings, and a management review input pack (ISO 15189 §8.9 topics).

### 3.10 Audit-readiness pack

- One click produces a dated, indexed bundle: accreditation scope and certificate, SOP list with current versions and review dates (NC-004), QC records for a chosen period with LJ charts and corrective actions, monthly QC review sign-offs, EQA enrolment and all cycle results with Z-scores and CAPAs, calibration & maintenance certificates with traceability, method validation reports with Director signatures, reference intervals and their basis, measurement uncertainty statements, TAT & rejection indicator trends, competency matrix, non-conformity/CAPA log, internal audit reports, management review minutes, and the clause-by-clause compliance status with evidence hyperlinks. Delivered as an indexed PDF + a read-only assessor login (time-boxed, audited).

## 4. Data Model (schema `lab`, prefix `labq_`)

- `labq_accreditation` — id, hospital_id, branch_id, body enum(nabl/cap/jci_lab/other), certificate_no, disciplines text[], valid_from, valid_to, scope_status, surveillance_due, contact_person, documents jsonb.
- `labq_scope_tests` — id, accreditation_id, test_id (EN-027), method, equipment_id, measurement_range, uncertainty jsonb (u, k, U), traceability_ref, in_scope bool, added_on, removed_on, validation_id.
- `labq_checklist_items` — id, hospital_id, standard enum(nabl112/iso15189_2022/nabh), clause_no, requirement_text, responsible_role, evidence_refs jsonb (module + record ids), status enum(compliant/partial/non_compliant/na), last_verified_at, verified_by, gap_note, target_date; index (hospital_id, status).
- `labq_qc_materials` — id, hospital_id, branch_id, manufacturer, product, lot_no, level enum(l1/l2/l3/other), matrix, received_on, expiry_date, opened_on, open_stability_days, storage_temp, status enum(active/quarantine/expired/exhausted), coa_ref; UNIQUE(hospital_id, product, lot_no, level).
- `labq_qc_targets` — id, qc_material_id, analyte_test_id, instrument_id, unit, source enum(insert/lab_derived/peer_group), mean numeric, sd numeric, cv_pct numeric, n_runs, effective_from, effective_to, approved_by, approved_at; index (analyte_test_id, instrument_id, effective_from desc).
- `labq_qc_schedules` — id, instrument_id, analyte_test_id, levels int, frequency enum(per_shift/per_run/every_n_samples/daily/after_calibration/after_maintenance), n_samples?, shifts text[], grace_minutes, block_release_on_miss bool, active.
- `labq_qc_runs` — id uuidv7, hospital_id, branch_id, instrument_id, analyte_test_id, qc_material_id, level, target_id, value numeric, unit, z_score numeric, run_at, shift, operator_id, entry_mode enum(interface/manual), reagent_lot, calibration_id?, status enum(in_control/warning/out_of_control/void), violated_rules text[], sequence_no, comment, created…; **partitioned monthly**; indexes (hospital_id, analyte_test_id, instrument_id, run_at desc), (status, run_at).
- `labq_westgard_config` — id, hospital_id, analyte_test_id?, instrument_id?, rule_code enum(1_2s/1_3s/2_2s/R_4s/4_1s/10x/8x/12x/7T/2of3_2s/3_1s/6x/9x), n, r, action enum(warning/reject), enabled, sigma_basis jsonb (tea_pct, source), effective_from.
- `labq_qc_actions` — id, qc_run_id, out_of_control_group_id, cause_code, cause_note, action_code, action_note, repeat_run_id?, patient_impact enum(none/retest_all/retest_selected/released_with_authorisation), affected_result_count, authorised_by, authorised_at, closed_at.
- `labq_eqa_programmes` — id, hospital_id, provider enum(cmc_vellore/aiims/biorad_unity/randox_riqas/neqas/other), provider_name, discipline, participant_code, analytes jsonb, cycle_calendar jsonb, fee, enrolled_from, enrolled_to, status.
- `labq_eqa_cycles` — id, programme_id, cycle_code, sample_received_on, sample_condition, test_due_date, submission_deadline, tested_on, operator_id, instrument_id, submitted_on, submitted_by, report_received_on, status enum(pending/tested/submitted/reported/missed).
- `labq_eqa_results` — id, cycle_id, analyte_test_id, our_value, unit, peer_mean, peer_sd, z_score, sdi, deviation_pct, performance enum(satisfactory/questionable/unsatisfactory), provider_comment, capa_ref?; index (cycle_id).
- `labq_method_validations` — id, hospital_id, test_id, instrument_id, type enum(validation/verification/revalidation), plan jsonb (studies, acceptance criteria), studies jsonb (precision, bias, linearity, lod, interference, carryover, stability, reference_interval, uncertainty — each with raw data ref, computed statistics, pass/fail), status enum(draft/in_progress/completed/approved/rejected), report_ref, approved_by, approved_at, effective_from.
- `labq_instrument_qualifications` — id, instrument_id (NC-020 asset), type enum(iq/oq/pq/requalification), trigger enum(commissioning/major_repair/relocation/software_upgrade/scheduled), checklist jsonb, result enum(pass/fail/conditional), performed_by, verified_by, performed_at, next_due_at, certificate_ref.
- `labq_calibrations` — id, instrument_id, analyte_test_id, calibrator_lot, calibrator_expiry, calibrated_at, operator_id, result enum(pass/fail), values jsonb, verification_run_id?, next_due_at, traceability_ref, certificate_ref.
- `labq_environment_logs` — id, hospital_id, branch_id, location_id, device_ref (EN-042 sensor?), parameter enum(temp/humidity/co2/conductivity), value numeric, unit, recorded_at, source enum(manual/iot), limit_low, limit_high, excursion bool, excursion_minutes, action_note, actioned_by; **partitioned monthly**.
- `labq_competencies` — id, hospital_id, employee_id (NC-010), procedure_or_test_ref, instrument_id?, element enum(training/direct_observation/result_monitoring/blind_sample/problem_solving/maintenance_troubleshooting), assessed_on, assessor_id, outcome enum(competent/needs_retraining), evidence_ref, valid_until, authorised bool; index (employee_id, valid_until).
- `labq_indicators` — id, hospital_id, branch_id, indicator_code, period_month, numerator, denominator, value numeric, target, direction enum(higher_better/lower_better), status enum(met/not_met), note, reviewed_by, reviewed_at.
- `labq_nonconformities` — id, hospital_id, source enum(qc/eqa/audit/complaint/incident/assessor), severity, description, detected_on, immediate_correction, root_cause jsonb, corrective_action, owner_id, due_date, effectiveness_verified_on, status enum(open/in_progress/verifying/closed), capa_ref (NC-015).
- Retention: QC runs and EQA records **5 years minimum** (NABL/ISO 15189, and longer if the accreditation body requires); validation reports for the life of the method + 5 years; competency records for employment + 3 years; environment logs 3 years.

## 5. Business Rules & Validations

- **Result-release gating is absolute**: when an analyte×instrument is `out_of_control` or has a missed scheduled QC beyond the grace window, OP-004 must block auto-verification and manual release of patient results for that analyte in the affected window. The only exception is an explicit Director authorisation recorded in `labq_qc_actions` with `patient_impact = released_with_authorisation` and a reason — this is audited and reported monthly.
- **`1-2s` is a warning, never a rejection** (using it as a rejection rule is a classic false-rejection error); rule sets must be chosen per analyte, with the Six-Sigma calculation shown to the configurer.
- QC targets from the manufacturer insert are provisional; **laboratory-derived mean/SD from ≥20 runs over ≥20 days must replace them** and require Director approval. Targets are effective-dated and never edited in place.
- **Lot changeover requires parallel testing** (≥10 paired runs) with a documented comparison before the new lot becomes active; LJ charts show lot boundaries.
- QC results **cannot be deleted**; a mistaken entry is voided with a reason and remains visible on the chart as a voided point.
- **EQA is mandatory for every in-scope analyte**; an in-scope analyte with no active enrolment (or no NABL-accepted alternative assessment) is a blocking compliance gap on the readiness dashboard. EQA samples must be run by routine staff on routine runs — the system records operator/instrument and flags a mismatch if a non-routine operator is used.
- **Unsatisfactory EQA (|Z|>3) or two consecutive questionable results (|Z|>2) force a non-conformity with root cause, CAPA and effectiveness verification**; the test may be suspended from reporting at the Director's decision, which is recorded.
- A test cannot be made orderable in OP-004 as an accredited test until it has: an approved method validation/verification, a current calibration, an active QC schedule with targets, at least one competent authorised operator, and an EQA enrolment (or approved alternative).
- **Competency gates work**: a technician whose competency for an analyte/instrument has expired cannot enter or verify results for it; supervisors receive expiry alerts at 60/30/7 days.
- An instrument in `out_of_service` or `requalification_pending` (after major repair, relocation or software upgrade) cannot contribute results; EN-004 messages from it are quarantined.
- **Measurement uncertainty** must exist for every quantitative in-scope test and be recomputed at least annually or after any method/calibrator change.
- Environmental excursions require a recorded impact assessment on stored materials before the log can be closed; excursions exceeding the reagent's stability window auto-quarantine the affected lots in NC-006.
- Every monthly QC review, indicator review and management review requires a signed sign-off (EN-016) — an unsigned month is a gap.
- The assessor read-only account is time-boxed (default 14 days), scoped to quality data (no patient identifiers beyond what a record requires), and every access is audited.

## 6. API Surface (`/api/v1/lab-quality`)

| Method         | Path                                                        | Purpose                                     | Permission                                                             | Notes                                   |
| -------------- | ----------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| GET/PUT        | /accreditation ; /accreditation/scope                       | scope & certificate                         | `labq.accreditation.manage`                                            |                                         |
| GET/PATCH      | /checklist ; /checklist/:id                                 | NABL 112 clause mapping & status            | `labq.checklist.manage`                                                | evidence auto-links                     |
| GET            | /checklist/readiness                                        | readiness % and gap list                    | `labq.report.read`                                                     |                                         |
| GET/POST/PATCH | /qc/materials ; /qc/materials/:id                           | QC lots                                     | `labq.qc.manage`                                                       | expiry validated                        |
| GET/POST       | /qc/targets ; POST /qc/targets/:id/approve                  | targets & lab-derived adoption              | `labq.qc.manage` / `labq.qc.approve` (Director)                        | effective-dated                         |
| GET/POST/PATCH | /qc/schedules                                               | QC schedule per instrument/analyte          | `labq.qc.manage`                                                       |                                         |
| POST           | /qc/runs                                                    | record a QC result (manual)                 | `labq.qc.enter`                                                        | interface path via EN-004 service token |
| GET            | /qc/runs?analyte&instrument&level&lot&from&to               | QC data                                     | `labq.qc.read`                                                         | cursor, partition-aware                 |
| GET            | /qc/chart?analyte&instrument&level&lot&period               | Levey-Jennings series + violations          | `labq.qc.read`                                                         | includes Youden data                    |
| POST           | /qc/runs/:id/void                                           | void an erroneous entry                     | `labq.qc.void`                                                         | reason mandatory                        |
| GET            | /qc/status?analyte&instrument                               | current control state (used by OP-004 gate) | `labq.qc.read` (service)                                               | cached, <20 ms                          |
| POST           | /qc/actions                                                 | corrective action & release decision        | `labq.qc.action` (+ `labq.qc.release_override` for authorised release) | audited                                 |
| GET/PUT        | /qc/westgard-config                                         | rule set per analyte                        | `labq.qc.manage`                                                       | shows sigma                             |
| GET            | /qc/monthly-review?month ; POST /qc/monthly-review/:id/sign | CV/bias/sigma review & sign-off             | `labq.qc.read` / `labq.review.sign`                                    | e-sign                                  |
| GET/POST/PATCH | /eqa/programmes ; /eqa/cycles ; /eqa/results                | EQA lifecycle                               | `labq.eqa.manage`                                                      | deadline reminders                      |
| POST           | /eqa/cycles/:id/submit ; POST /eqa/results/import           | submit & parse provider report              | `labq.eqa.manage`                                                      | CSV/PDF import                          |
| GET            | /eqa/trends?analyte&from&to                                 | Z-score trends                              | `labq.report.read`                                                     |                                         |
| GET/POST/PATCH | /validations ; POST /validations/:id/approve                | method validation/verification              | `labq.validation.manage` / `.approve` (Director)                       | generates signed PDF                    |
| GET/POST       | /qualifications ; /calibrations                             | IQ/OQ/PQ & calibration records              | `labq.equipment.manage` (BME + Lab)                                    | links NC-020                            |
| GET/POST       | /environment/logs ; GET /environment/excursions             | temperature & environment                   | `labq.environment.manage`                                              | IoT ingest via EN-042                   |
| GET/POST/PATCH | /competencies ; GET /competencies/matrix                    | competency records                          | `labq.competency.manage` (Director/HR)                                 | authorisation gates OP-004              |
| GET            | /indicators?period ; POST /indicators/:id/review            | quality indicators                          | `labq.report.read` / `labq.indicator.review`                           | TAT & rejection from OP-004             |
| GET/POST/PATCH | /nonconformities ; POST /:id/close                          | NC & CAPA                                   | `labq.nc.manage`                                                       | mirrors NC-015                          |
| POST           | /audit-pack/generate ; GET /audit-pack/:id                  | audit-readiness bundle                      | `labq.auditpack.generate`                                              | indexed PDF + evidence links            |
| POST           | /assessor-access                                            | time-boxed assessor read-only login         | `labq.assessor.grant` (Admin)                                          | audited, auto-expiring                  |

## 7. Domain Events (outbox)

- `labq.qc.recorded` → LJ chart cache, dashboards.
- `labq.qc.out_of_control` → OP-004 release gate, EN-037 alert to bench + Quality Manager + section head, EN-018 lab board.
- `labq.qc.corrective_action_recorded` / `labq.qc.released_with_authorisation` → audit, monthly review, quality indicator.
- `labq.qc.missed_schedule` → task + release gate after grace.
- `labq.eqa.cycle_due` (7/3/1 days) / `labq.eqa.submitted` / `labq.eqa.unsatisfactory` → NC-015 CAPA creation, Director alert.
- `labq.validation.approved` → OP-004 makes the test orderable; EN-027 receives reference intervals & uncertainty.
- `labq.calibration.due|overdue` / `labq.instrument.requalification_required` → NC-020, EN-004 quarantine.
- `labq.environment.excursion` → NC-006 reagent quarantine, EN-037 alert.
- `labq.competency.expiring|expired` → OP-004 authorisation revoke, HR notification.
- `labq.nonconformity.raised|closed` → NC-015 register.
- `labq.auditpack.generated` → audit trail.
- Consumes: `lab.qc.result.received` (EN-004), `lab.result.verified` / `lab.sample.rejected` / `lab.tat.computed` (OP-004), `asset.calibration.recorded` / `asset.breakdown.closed` (NC-020), `document.published` (NC-004 SOPs), `iot.sensor.reading` (EN-042).

## 8. Screens (UI)

- **QC Bench Board** (desktop at the bench, high contrast, tablet-capable): today's scheduled QC by instrument × analyte with status chips (pending / in control / warning / **out of control**); one-click "Enter QC" and "View chart"; a red banner listing analytes currently blocking release with the count of held patient results. Real-time via WS (<2 s from analyzer). Shortcuts `N` new QC entry, `C` chart, `A` corrective action.
- **Levey-Jennings Chart** (desktop): ±1/2/3 SD zones, target line, points coloured by rule outcome, violation markers with rule labels, lot/target-change vertical lines, voided points shown hollow, hover detail, range selector (30/60/90/365 days), overlay of L1/L2/L3, Youden plot toggle, export PNG/CSV for the audit pack.
- **Corrective Action dialog** (desktop): out-of-control group summary, coded cause + action pickers, repeat-QC link, patient-impact decision (retest all / retest selected — with the affected result list / release with authorisation), authoriser signature.
- **QC Configuration** (desktop, Quality Manager): materials & lots, targets with "adopt lab-derived mean/SD" prompt, schedules, Westgard rule matrix per analyte with computed sigma and a plain-language explanation of the selected rule set.
- **EQA Console** (desktop): programme cards with next deadline countdown; cycle workflow stepper (received → tested → submitted → reported); result entry grid; Z-score trend chart per analyte; unsatisfactory items with CAPA links; missed-deadline red state.
- **Method Validation Workspace** (desktop): study tabs (precision, comparison with Passing-Bablok/Bland-Altman plots, linearity with recovery table, LoD, interference, stability, reference interval), acceptance criteria vs computed values with pass/fail chips, raw-data import (CSV/analyzer), report preview and Director e-sign.
- **NABL Readiness Dashboard** (desktop, Quality + Director): clause-group readiness rings, open gaps with owners and due dates, expiring items (calibrations, competencies, SOP reviews, EQA enrolments, certificate validity), and the "Generate audit pack" action.
- **Indicators** (desktop + TV EN-018 in the lab): TAT % within target by priority and section, rejection rate by reason and area, critical-value reporting compliance, amended-report rate, analyzer uptime — monthly with targets and RAG.
- **Competency Matrix** (desktop): staff × test/instrument grid with valid/expiring/expired colouring, drill-down to elements and evidence, bulk scheduling of assessments.
- **Environment Monitoring** (desktop + phone alerts): live sensor tiles, excursion timeline, action log.
- **Assessor View** (desktop, read-only, time-boxed): the audit pack as a navigable site with clause → evidence links.
- Empty/error states: "QC not run for Sodium on ARCHITECT-1 this shift — patient results will be held after 08:30", "This lot expires in 6 days — plan changeover with parallel testing", "No EQA programme covers HbA1c — accreditation gap".

## 9. Integrations

- **EN-004 / analyzers**: QC results delivered on the same HL7/ASTM channel as patient results (QC sample identification by control lot/level or a QC flag); bidirectional analyzers may also receive the QC schedule. Middleware (e.g. instrument vendor QC software, BioRad Unity) can be a source via EN-017 file/API adapter.
- **EQA providers**: CMC Vellore EQAS, AIIMS, BioRad Unity Real Time, Randox RIQAS, NEQAS — result submission is usually via the provider's web portal (manual submit recorded here) with report import as CSV/PDF; where a provider API exists it is an EN-017 connector.
- **NC-020** for the equipment registry, AMC/CMC, breakdown history and external calibration certificates; **NC-004** for SOP documents with version control and review dates; **NC-015** for the hospital CAPA register and internal audits; **NC-010** for employee records behind competency.
- **EN-042** for automated temperature/humidity sensor ingestion; **EN-016** for Director e-signatures on reviews and validation reports; **EN-036** to import historical QC and EQA data at go-live so trends are not lost.

## 10. Reports & Analytics

- Daily QC summary (runs, violations, blocked analytes, open corrective actions); monthly QC review per analyte (mean, SD, CV%, bias, TEa, **Six-Sigma**, violations, downtime) with peer comparison where available; lot-to-lot comparison report.
- EQA performance report per programme/cycle/analyte with Z-score trends, participation compliance and CAPA status.
- TAT report by test, priority, section, shift and phase; sample rejection analysis by reason/area/collector; critical-value reporting compliance; amended/corrected report analysis.
- Instrument performance: uptime, breakdowns, calibration frequency, QC failure rate per instrument.
- Competency completion %, training due list; SOP review-due list.
- Accreditation readiness score with trend, open gaps by clause group, days to certificate expiry/surveillance.
- Read models: `analytics.mv_labq_qc_monthly`, `analytics.mv_labq_indicators_monthly`, `analytics.mv_labq_tat_daily`.

## 11. Notifications

- **Immediate**: QC out of control (bench technician, section head, Quality Manager) with the list of held results; environment excursion; instrument requalification required.
- **Scheduled**: QC not run by cutoff (per shift); EQA deadline at 7/3/1 days and on the due date; calibration due/overdue; competency expiring 60/30/7 days; SOP review due; QC lot expiring in 14 days; accreditation certificate expiring 90/60/30 days; monthly QC review awaiting sign-off.
- **Escalation** (EN-037): out-of-control unresolved for 2 hours → section head → Lab Director; missed EQA submission → Director + Hospital Admin.
- **Digest**: weekly lab quality summary to Director and Quality Manager; monthly indicator pack to the quality committee.

## 12. Permissions (RBAC keys)

`labq.qc.read` (lab staff) · `labq.qc.enter` (Lab Technician 33) · `labq.qc.manage` (Lab Quality Manager 35) · `labq.qc.approve` (Pathologist/Lab Director 13) · `labq.qc.void` (Quality Manager, audited) · `labq.qc.action` (technician + supervisor) · `labq.qc.release_override` (Lab Director only, audited & monthly-reported) · `labq.eqa.manage` (Quality Manager) · `labq.validation.manage` / `labq.validation.approve` (Director) · `labq.equipment.manage` (Biomedical Engineer 48 + Lab) · `labq.environment.manage` · `labq.competency.manage` (Director, HR 47) · `labq.checklist.manage` / `labq.accreditation.manage` (Quality Manager 35, Quality Manager NABH 54) · `labq.indicator.review` · `labq.nc.manage` · `labq.review.sign` (Director) · `labq.auditpack.generate` · `labq.assessor.grant` (Hospital Admin 2) · `labq.report.read`.

## 13. Non-functional

- **Volumes (2000-bed, 20 000 tests/day, 30 analyzers)**: ~250 analytes × 2–3 levels × 2–3 runs/day ⇒ **1500–2000 QC results/day**, ~600 000/year; 8–12 EQA programmes with ~40 cycles/year; ~200 lab staff competency records × 6 elements.
- QC gate lookup (`/qc/status`) must answer in **< 20 ms** (Redis-cached control state) because it sits in the result-verification path for every one of 20 000 daily results.
- LJ chart for 365 days × 3 levels renders in < 800 ms (server-side downsampling above 2000 points); audit-pack generation for a 12-month period completes in < 3 minutes as a background job with progress and email delivery.
- QC runs and environment logs partitioned monthly; 5-year online retention with cold archive thereafter; all quality records included in EN-022 backup scope with the same RPO/RTO as clinical data.
- Offline: the bench board caches the day's schedule and allows manual QC entry offline for up to 8 hours, syncing with conflict detection; the release gate **fails closed** (blocks release) when QC status cannot be determined.
- Accessibility: charts have data-table equivalents and are not colour-only (violation markers use shape + label); high-contrast bench theme; keyboard-first QC entry (numeric pad flow, `Enter` to next analyte).
- i18n: technical/quality UI may remain English (assessor language), but alerts surfaced to non-lab staff are localised.

## 14. Acceptance Criteria

1. **Given** a QC result with z = −3.4 on level 2, **when** the Westgard engine evaluates it, **then** the `1-3s` rule rejects the run, the analyte×instrument enters `out_of_control`, an alert reaches the bench and Quality Manager within 60 seconds, and the affected patient results are listed as held.
2. **Given** an analyte is out of control, **when** a technician attempts to verify or release a patient result for that analyte in the affected window, **then** OP-004 blocks the action with the reason and the QC run reference, and only a Lab Director authorisation with a recorded reason can release it.
3. **Given** `1-2s` is configured, **when** a single control falls at z = 2.3, **then** the run is flagged as a **warning** only and results are not blocked.
4. **Given** two levels in one run at +2.1 and +2.2 SD, **when** the `2-2s` rule is enabled, **then** the run is rejected and both violating points are marked on the LJ chart.
5. **Given** 20 QC runs over 22 days on a new lot, **when** the Quality Manager opens targets, **then** the system offers the laboratory-derived mean/SD/CV and requires Director approval before they become the effective target, with the previous target retained and effective-dated.
6. **Given** a new QC lot is activated without parallel testing, **when** activation is attempted, **then** it is blocked until at least 10 paired runs and a documented comparison exist.
7. **Given** an in-scope analyte with no active EQA enrolment, **when** the readiness dashboard is computed, **then** it appears as a blocking accreditation gap with the responsible owner.
8. **Given** an EQA result with |Z| = 3.6, **when** it is recorded, **then** the performance is classified unsatisfactory, a non-conformity with root-cause and CAPA is created automatically in NC-015, and the Director is notified.
9. **Given** an EQA submission deadline in 3 days with no submission, **when** the scheduler runs, **then** reminders are sent to the Quality Manager and Director, and a missed deadline creates a non-conformity.
10. **Given** a method validation with precision CV exceeding the acceptance criterion, **when** the report is compiled, **then** the study is marked failed, the validation cannot be approved, and the test cannot be made orderable as accredited.
11. **Given** an analyzer undergoes a major repair, **when** it is returned to service, **then** it stays in `requalification_pending`, EN-004 quarantines its messages, and results are accepted only after a passed re-qualification checklist.
12. **Given** a technician's competency for haematology on the XN-1000 expired yesterday, **when** they attempt to enter results for that analyte, **then** the action is refused with a competency message and the supervisor is notified.
13. **Given** a −80 °C freezer records −62 °C for 45 minutes, **when** the excursion closes, **then** an alert was raised at the threshold, the excursion duration is computed, and the log cannot be closed without an impact assessment on the stored reagents/samples.
14. **Given** a QC result was entered with a typing error, **when** it is voided with a reason, **then** it remains visible on the chart as a voided point, is excluded from statistics, and the void is audited — deletion is not possible.
15. **Given** an assessor visit, **when** the audit pack is generated for the last 12 months, **then** it contains the scope, SOP versions, QC records with LJ charts and corrective actions, EQA results with Z-scores, calibration and validation records, competency matrix, indicators and the clause-by-clause status with working evidence links, and its generation is audited.
16. **Given** a released report is later amended, **when** the monthly indicators are computed, **then** the amended-report rate reflects it with the reason category, and the trend is available to the quality committee.
17. **Given** the QC status service is unreachable, **when** OP-004 checks the gate, **then** the gate fails closed (release blocked) with a clear operational message rather than silently allowing release.

## 15. Enhancements / Later phases

- **Patient-based real-time QC (PBRTQC / moving averages, Bull's algorithm for haematology)** to catch drift between QC runs.
- **Peer-group / inter-laboratory comparison** feeds (BioRad Unity, provider peer data) auto-imported with monthly peer bias reports.
- **Auto-verification rule engine tuning** driven by QC and delta-check performance data (works with OP-004 and EN-029).
- **Six-Sigma-driven automatic Westgard rule selection** with periodic re-evaluation as CV/bias change.
- Direct **EQA provider APIs** for submission and result retrieval, eliminating manual portal entry.
- **NABL/CAP paperless assessment portal** with assessor annotations and finding responses tracked in-system.
- Predictive maintenance from QC drift + instrument telemetry (EN-042/AI-005); reagent lot performance analytics across branches (EN-041) to detect a bad lot group-wide.
- Extension of the same framework to **blood bank, radiology (AERB QA), CSSD (BI/Bowie-Dick trending)** and point-of-care testing (POCT) device QC.

## 16. Open Questions for the Hospital

1. Which **disciplines and tests are in the NABL scope** today, and which are planned to be added in the next 12 months?
2. Which **EQA/PT programmes** is the lab enrolled in (provider, participant code, analyte panel, cycle calendar), and are there in-scope analytes without a programme (what alternative assessment is used)?
3. What **QC materials and lots** are in use per analyzer, and are manufacturer inserts or lab-derived targets currently used?
4. Which **Westgard rules** does the lab run today per section, and is the lab willing to move to Six-Sigma-based rule selection?
5. What is the policy on **releasing patient results after a QC failure** — who authorises, and is retesting mandatory for the affected window?
6. Which **allowable total error (TEa)** source should drive sigma metrics — CLIA, Ricos biological variation, RCPA, or a local specification?
7. Are **temperature and humidity logs** manual or from data loggers/IoT sensors (make/model, protocol), and what are the configured limits and excursion actions?
8. How are **competency assessments** currently documented, what is the assessment calendar, and should the system hard-block uncertified staff from result entry from day one?
9. Which **historical QC/EQA data** must be migrated (how many years, in what format) so trends and audit evidence are continuous?
10. Who signs monthly QC reviews and validation reports, and is **digital signature (EN-016)** acceptable to the assessor?
11. Is there existing **QC middleware** (BioRad Unity, instrument vendor software) that should remain the system of record, with EN-031 consuming it — or will EN-031 replace it?
12. What **measurement uncertainty** approach is currently documented, and is NABL 163 methodology already in use?
13. What is the certificate validity window and the **next surveillance/renewal assessment date**, so readiness milestones can be scheduled?
