# OP-004 — Laboratory Information System (Orders, Samples, Results, Validation, QC, Reports, TAT)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-004 |
| Phase | 3 |
| Priority | P0 |
| Complexity | High |
| Depends on | OP-002 (orders), OP-001 (patient/visit), EN-027 (test master, LOINC), EN-004 (analyzer HL7/ASTM), EN-031 (NABL/QC/EQA), EN-013 (barcode labels), EN-005 (printers), OP-005 (billing), EN-009 (SMS/WhatsApp), EN-037 (notifications/escalation), EN-029 (critical value rules), NC-006 (reagent inventory), IP-003/IP-009/OP-006 (IP/ICU/ER orders), PE-001 (portal), EN-011 (ABDM DiagnosticReport), EN-016 (e-sign), NC-016 (BMW) |
| Feature flag | `module.lis.enabled` (sub: `lis.qc`, `lis.outsourcing`, `lis.home_collection`, `lis.microbiology`, `lis.histopathology`) |
| Primary roles | Lab Technician (33), Phlebotomist (34), Pathologist / Lab Director (13), Lab Quality Manager (35) |
| Secondary roles | Doctor (results/critical ack), Nurse (IP sample collection), Front office/Cashier (lab billing, report handover), Referral lab coordinator, MRD, Auditor, Patient (portal) |
| Regulatory | NABL 112 (ISO 15189:2022) — pre-analytical (request, collection, transport, rejection criteria), analytical (IQC Levey-Jennings/Westgard, EQA/PT participation, calibration, method verification), post-analytical (validation, critical value communication with read-back, report content: patient ID×2, sample type, collection & report time, reference intervals, units, method, authorised signatory, page numbering, amendment history), TAT monitoring, document control; NABH LAB chapter; CEA (Clinical Establishments) report format; BMW 2016 (sharps/samples); DPDP; ABDM DiagnosticReport HI type; LOINC/SNOMED coding; IDSP notifiable disease reporting; MTP/PNDT (no sex disclosure fields) |

## 1. Purpose
OP-004 manages the laboratory lifecycle from order reception (OPD/ER/IP/health-check/walk-in/outsourced) through barcode-labelled sample collection, accessioning, analyzer interfacing, result entry with reference-range/delta/critical checks, two-level validation, cumulative and branded PDF reports with e-signature, TAT/SLA monitoring, and NABL-grade quality control — for 20k tests/day across 30 analyzers and multiple collection points, with omni-channel report delivery.

## 2. Users & Jobs-to-be-done
- **Phlebotomist / sample collector** (tablet/desktop + label printer + scanner): collection worklist by location, print labels, collect, scan-confirm, reject/recollect, home collection runs.
- **Lab technician** (bench desktop; scanner): accession samples, run analyzers, enter/verify results, handle reruns/dilutions, QC runs, reagent lots.
- **Pathologist / microbiologist / biochemist** (desktop, tablet): validate/authorise results, comment, sign, review deltas/criticals, cross-department verification, histopathology/microbiology narrative reports.
- **Lab quality manager**: IQC/EQA, Westgard violations, CAPA, TAT SLA, document control, NABL audit exports (EN-031).
- **Doctor/nurse**: order, view, acknowledge criticals, cumulative trends.
- **Front office/cashier**: lab bill (OP-005), report handover, walk-in test registration.
- **Patient**: portal/WhatsApp report, QR verification, prep instructions.

## 3. Core Workflows

### 3.1 Order reception
1. Orders arrive as `order.lab.created` from OP-002/OP-006/IP-003/health-check (OP-014) or **direct walk-in lab registration** (patient with external prescription: register in OP-001, create lab-only visit, select tests, bill) → **lab order** created per patient/visit with accession no (series `LAB_ACC`), test items expanded (panels → tests → parameters), sample requirements computed (tube type/colour, volume, container, fasting, special handling), department routing (haematology/biochemistry/microbiology/histo/serology/molecular/outsourced).
2. Payment/credit check: self-pay orders must be `paid` (OP-005) before collection unless ER/IP/credit/scheme; unpaid orders show "Awaiting payment" (`lab.order.on_hold_payment`).
3. Pending Orders dashboard by location (OPD collection room, ward, ER, ICU, home): patient, tests, priority (Routine/Urgent/STAT), ordering doctor, timestamp, sample status; STAT/ER pinned top red.
4. Duplicate/order-set validation and add-on tests on existing sample (within stability window, e.g. add HbA1c to EDTA sample < 24 h) → `lab.order.addon`.

### 3.2 Sample collection & accessioning
1. Phlebotomist selects order (scan OP slip/wristband) → System prints **barcode labels** per container (Code128/2D: accession + container seq, patient name, UHID, age/sex, test short codes, tube colour, collection time placeholder) → collects → **scans each label to confirm** (captures collector, time, site, fasting status, patient identity 2-check prompt) → status `collected` → Event `lab.sample.collected` → patient SMS "sample collected, report expected by <TAT>".
2. Transport: batch manifest per courier/pneumatic tube (`lab.sample.dispatched`) → receipt at lab: scan → `received` (time-stamped; transport time KPI; temperature for cold-chain samples) → **accessioning** assigns lab no per department (`SAMPLE`); auto-worklist by analyzer/bench.
3. **Sample rejection** (haemolysed, clotted, insufficient, wrong tube, unlabelled, lipaemic, leaked, delayed): reason (NABL list) → status `rejected` → auto-notify ordering doctor + patient + collection point for **recollection** (new labels, no re-billing, linked to original) → rejection KPI.
4. Chain of custody (medico-legal/forensic samples, drug-of-abuse, alcohol in MLC): each hand-over recorded with scan + signature (custody log), tamper-evident seal no; MLC samples flagged from OP-006/TR-008.
5. Home collection: run planner assigns phlebotomist routes; mobile app collects with GPS/time; samples received flow same.
6. IP/ICU: nurse collects on ward with bedside label print (IP-004) — same events.

### 3.3 Analytical phase & result entry
1. **Analyzer integration (EN-004)**: bidirectional — order download (host query or broadcast) by accession barcode; results uploaded (HL7 v2.x ORU^R01 / ASTM E1394) → mapped by test code/LOINC → land as `unverified` results with instrument, run id, flags, dilution factor; QC-lockout if the analyte's last IQC failed (Westgard) — results held (`qc_hold`).
2. **Manual entry** for non-interfaced tests: bench worklist → per sample or per test grid; numeric/qualitative/text/multi-select/microbiology (organism, colony count, antibiotic susceptibility panel with breakpoints CLSI/EUCAST → antibiogram) / histopathology (gross, micro, impression, SNOMED morphology/topography, synoptic templates) / semi-quantitative; unit conversion; calculated tests (eGFR CKD-EPI, LDL Friedewald, anion gap, corrected calcium, INR) auto; **auto-dilution calculation** (raw × dilution) with limits.
3. On each result: **reference range** by age/sex/pregnancy/specimen (test master effective-dated) → flags L/H/LL/HH/A; **critical value** (panic) list per test → immediate alert workflow (3.5); **delta check** vs previous (absolute/percent/time-window per test) → flag & optional hold; **implausible/absurd values** block; **rerun** request with reason; comments/interpretations from canned list.
4. Reflex testing rules (e.g. TSH abnormal → FT4; HBsAg reactive → confirmatory) → auto add-on with billing rule (bill/free/prompt).
5. Outsourced tests: order routed to referral lab (`lab.outsource.dispatched` with manifest, courier, expected TAT); results received via file upload/HL7/API → entered as outsourced with referral lab name on report; cost/margin tracked; TAT included.

### 3.4 Validation & authorisation
1. **Level 1 (technical verification)** by technician/senior technician (cannot be the person who entered manually? configurable; auto-verify rules for interfaced results within normal range, no delta/critical, QC OK — "auto-validation" with rule id logged, NABL-permitted).
2. **Level 2 (medical authorisation)** by pathologist/authorised signatory per department (signatory list per NABL scope) → review flags, add interpretation, sign (e-sign EN-016; hash) → status `final` → Event `lab.result.final` → report generation. Cross-department verification allowed by configured signatories (market: MocDoc).
3. Amendment after final: reason, new version (`lab.result.amended`), report shows "Amended – supersedes report dated …", doctor & patient re-notified; original retained.
4. Cancellation of test (not performed) → reason → billing reversal event.

### 3.5 Critical value call-back (NABL/NABH)
1. Result flagged critical → System creates **critical alert task**: notifies ordering doctor + ward nurse (in-app, push, SMS; call list) with escalation ladder (EN-037: 10 min → HOD/on-call, 20 min → medical superintendent); TV/ICU board flag.
2. Lab staff **phones** the clinician: records in `critical_value_log`: who informed, whom (name/role), time, **read-back confirmed** (checkbox mandatory), method (phone/in-person), remarks; doctor acknowledges in OP-002 inbox (`result.acknowledged`) closing loop; if unreachable → escalation notes. KPI: % criticals communicated ≤ 30 min (NABL/NABH indicator).

### 3.6 Report generation & delivery
1. On final: PDF (Playwright) with hospital letterhead, patient (name, UHID, age/sex, ref doctor), sample type, collected/received/reported times, test, result, units, bio-ref interval, flags, method, instrument (optional), comments, signatory with reg no & designation, NABL logo/scope note (only for accredited tests, per NABL rule), page x of y, QR verify, "end of report"; departmental or consolidated per order; partial (interim) reports allowed with "Interim" watermark; **cumulative report** (selected analytes across visits table/graph); microbiology and histopathology narrative formats.
2. Delivery: patient portal (PE-001), WhatsApp PDF push (EN-009, opt-in), email, print at counter (report handover log with collector identity/OTP for third-party pickup), doctor inbox (OP-002), ward (IP-003), ABDM DiagnosticReport care context (EN-011), referring doctor portal (PE-007), bulk download (market).
3. Sensitive tests (HIV, genetic, PNDT-related) → restricted delivery (counsellor/doctor only, no WhatsApp) per config.

### 3.7 Quality control (NABL 112, EN-031)
1. IQC: define control materials (lot, level, target mean/SD or lab-established), schedule per analyte/instrument (per run/shift/day); QC results from analyzer or manual → **Levey-Jennings** chart; **Westgard rules** (1-2s warn, 1-3s, 2-2s, R-4s, 4-1s, 10x reject; configurable) → violation → analyte lockout until corrective action documented (CAPA link NC-015).
2. EQA/PT (proficiency testing): programme enrolment, sample receipt, result submission, performance evaluation upload, z-score/SDI tracking, non-conformance CAPA.
3. Calibration/maintenance logs per instrument (link NC-020), reagent lot changes with lot-to-lot verification, method verification records, uncertainty of measurement per analyte, temperature logs (fridges/incubators), water quality; document control (SOP versions) via NC-004; NABL indicators dashboard: sample rejection %, TAT compliance %, critical value TAT, amended report %, QC failure rate, EQA performance.

### 3.8 TAT monitoring
- Timestamps: ordered → collected → received → resulted → verified → authorised → reported/delivered; TAT targets per test/priority (e.g. STAT CBC 60 min, routine biochem 4 h, culture 72 h); live SLA dashboard (green/amber/red), breach alerts, TV board for lab TAT (EN-018), pending-beyond-TAT worklist.

### 3.9 Consumables & reagents
- Test → reagent consumption mapping (per test/kit) → NC-006 ledger deduction on result finalisation (or per run); reagent lot/expiry blocking; kit-wise cost per test.

## 4. Data Model (schema `lab`)
- **lab_tests** (mdm): id, hospital_id, code, name, short_code, loinc_code, snomed_id, department_id, section, sample_type_id, container_id (tube colour), volume_ml, is_panel, panel_children[], parameters[] (for multi-parameter tests), result_type enum(numeric/qualitative/text/multiselect/micro/histo/calculated), unit, decimals, method, instrument_ids[], tat_routine_min, tat_urgent_min, tat_stat_min, is_outsourced_default, referral_lab_id?, is_nabl_scope, is_sensitive, price ref (RC-003), reflex_rules jsonb, calc_formula, effective_from/to, version.
- **reference_ranges**: test_id, param_id, sex, age_min/max (days), pregnancy bool, specimen, low, high, critical_low, critical_high, text_normal, effective_from/to.
- **lab_orders**: id, hospital_id, branch_id, accession_no, patient_id, visit_id/ip_admission_id, encounter_id, source enum(opd/er/ip/health_checkup/walkin/outsourced_in/portal), ordering_doctor_id, referring_facility?, priority enum(routine/urgent/stat), status enum(placed/on_hold_payment/awaiting_collection/collected/received/in_progress/partially_reported/reported/cancelled), billing_status, clinical_notes, is_mlc, ordered_at, expected_report_at.
- **lab_order_tests**: order_id, test_id, sample_id, status enum(pending/collected/received/in_progress/resulted/verified/authorised/rejected/cancelled/outsourced), priority, is_addon, is_reflex (parent_test_id), outsource_ref, cancel_reason, tat_due_at.
- **samples**: id, hospital_id, order_id, sample_no (`SAMPLE`), barcode, sample_type, container, collected_by, collected_at, collection_site enum(opd/ward/er/home/other), fasting bool, received_by, received_at, transport_batch_id, condition_on_receipt, status enum(pending/collected/dispatched/received/accessioned/rejected/consumed/stored/disposed), rejection_reason_code, rejected_by/at, storage_location, retention_until, is_chain_of_custody, seal_no, parent_sample_id (aliquots).
- **sample_custody_events**: sample_id, from_user, to_user, action, at, signature_file_id, remarks.
- **transport_batches**: manifest_no, from_location, to_location, courier, dispatched_at, received_at, temp_c.
- **results**: id, hospital_id, order_test_id, parameter_id, value_numeric, value_text, value_coded, unit, ref_low, ref_high, flag enum(N/L/H/LL/HH/A/critical), delta_flag, delta_prev_value, dilution_factor, instrument_id, run_id, raw_message_id, entered_by, entered_at, verified_by, verified_at, authorised_by, authorised_at, status enum(unverified/qc_hold/verified/authorised/amended/cancelled), version, comment, auto_validated_rule_id, is_rerun, rerun_reason.
- **micro_results**: order_test_id, organism_snomed, growth, colony_count, gram_stain, susceptibilities jsonb[{antibiotic, mic/zone, interpretation S/I/R}], report_text.
- **histo_results**: order_test_id, specimen desc, gross, micro, impression, synoptic jsonb, snomed_morphology, snomed_topography, blocks/slides count.
- **critical_value_log**: result_id, detected_at, notified_to_name, notified_to_role, notified_by, notified_at, method, read_back_confirmed bool, escalation_level, acknowledged_by, acknowledged_at, remarks.
- **lab_reports**: id, order_id, version, type enum(interim/final/amended/cumulative), pdf_file_id, sha256, prev_sha256, signed_by[], generated_at, delivered jsonb (channels/timestamps), handover_to, handover_id_proof.
- **qc_materials**, **qc_targets** (analyte, level, lot, mean, sd, source), **qc_runs** (instrument, analyte, level, lot, value, at, z_score, westgard_flags[], status accept/reject, action_by, capa_id), **eqa_programmes**, **eqa_rounds** (sample id, submitted values, evaluation, z/SDI, status).
- **instruments**: id, name, model, serial, department, interface enum(hl7/astm/none), asset_id (NC-020), status, calibration_due.
- **instrument_test_map** (EN-004): instrument code ↔ test/param, unit conversion, decimals.
- **referral_labs**: name, contact, tests offered, TAT, price, portal/API, manifest format; **outsource_dispatches**.
- **tat_config**: test/priority/source → minutes; **rejection_reasons** (NABL list, configurable).
- **reagent_maps**: test_id → item_id, qty per test.
- Indexes: lab_orders (hospital_id, branch_id, status, ordered_at desc), (patient_id, ordered_at desc); samples (barcode) unique; results (order_test_id), (patient_id via join — add patient_id denormalised, test_id, authorised_at desc) for cumulative; qc_runs (instrument_id, analyte, at). Partition results by month (20k tests × ~5 params × 365 ≈ 36M rows/yr). RLS all.

## 5. Business Rules & Validations
- Patient identity 2-identifier confirmation at collection; label must be scanned to mark collected (no manual "collected" without scan unless printer failure override, audited).
- Sample rejection triggers recollection order at zero charge; rejected samples cannot be resulted.
- Results on `qc_hold` cannot be verified until QC passes/override by pathologist with reason.
- Two-level release: enterer ≠ verifier for manual results (segregation of duty); authorisation only by signatories configured per department; auto-validation rules explicit and versioned; critical/delta/abnormal-out-of-auto-limits always manual.
- **Critical value (resolved — not configurable):** *release is never withheld* (withholding a critical result to force paperwork is itself a safety hazard). The moment a result is flagged critical, (a) the `lab.result.critical` event and the EN-037 escalation ladder fire immediately — before and independent of authorisation; (b) authorisation of that result **requires the `critical_value_log` entry with `read_back_confirmed = true`**, or an explicit "clinician unreachable — escalated to <tier>" entry, so no critical result reaches `final` without documented communication or a documented escalation attempt; (c) the lab order cannot move to `reported`/closed while any critical alert on it is unacknowledged. If the pathologist must authorise before a clinician is reached, they record the "unreachable — escalated" entry; this is a tracked exception on the NABL critical-value KPI, not a silent bypass. (NABL 112 / NABH IMS requires documented communication of critical values with read-back.)
- Reference ranges effective-dated; report prints the range used at that time; changing master does not alter historical reports.
- Reports immutable; amendments new versions; deleted never; QR verification shows validity + version.
- TAT clocks: STAT clock starts at order; routine at receipt (configurable, NABL requires define); breach alerts.
- Outsourced tests print referral lab name & their NABL status; hospital NABL logo only on accredited-scope tests; report footer disclaimer for non-accredited.
- Sensitive results (HIV etc.) restricted permissions (`lab.result.sensitive.read`); no WhatsApp/SMS for these; counselling flag; PNDT: no fields that reveal foetal sex.
- Sample retention: serum 7 days (config), histo blocks/slides 10 y, MLC samples until release order; disposal per BMW.
- Billing: order billable at placement (OP-005 event); cancellation before result → auto reversal; after result → no reversal without approval; add-on/reflex per rule; outsourced cost centre.
- Numbering: `LAB_ACC` per branch/day or FY (config), `SAMPLE` per department, report no = accession+version.
- Notifiable diseases (IDSP list: dengue NS1/IgM, malaria, TB CBNAAT, cholera, H1N1…) positive → event to NC-015/public-health register.

## 6. API Surface (`/api/v1/lab`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /orders | create lab order (walk-in / from CPOE event) | lab.order.create | Y | – |
| GET | /orders?status=&location=&priority=&from= | pending/worklists | lab.order.list | – | cursor |
| GET | /orders/{id} | full order with tests/samples/results | lab.order.read | – | – |
| POST | /orders/{id}/tests | add-on test | lab.order.addon | Y | – |
| POST | /orders/{id}/cancel-tests | cancel with reason | lab.order.cancel | Y | – |
| POST | /orders/{id}/labels | print labels | lab.sample.label | – | – |
| POST | /samples/{barcode}/collect | confirm collection | lab.sample.collect | Y | – |
| POST | /samples/{barcode}/reject | reject + recollect | lab.sample.reject | Y | – |
| POST | /samples/dispatch, /samples/{barcode}/receive, /accession | transport & accession | lab.sample.receive | Y | – |
| POST | /samples/{id}/custody | custody event | lab.sample.custody | Y | – |
| GET | /worklists/bench?dept=&instrument= | bench worklist | lab.result.enter | – | cursor |
| POST | /results | manual entry (batch) | lab.result.enter | Y | – |
| POST | /results/ingest | analyzer results (EN-004 internal) | integration.lab.ingest | Y | – |
| POST | /results/{id}/rerun | rerun request | lab.result.enter | Y | – |
| POST | /results/verify | level-1 (batch) | lab.result.verify | Y | – |
| POST | /results/authorise | level-2 sign (batch) | lab.result.validate | Y | – |
| POST | /results/{id}/amend | amend | lab.result.amend | Y | – |
| GET | /patients/{id}/results?test=&from= | cumulative | lab.result.read | – | cursor |
| POST | /critical-values/{id}/notify | log call-back | lab.critical.notify | Y | – |
| GET | /critical-values?open=true | open criticals | lab.critical.read | – | cursor |
| POST | /reports/{order}/generate?type= | interim/final/cumulative | lab.report.generate | Y | – |
| GET | /reports/{id}/pdf, POST /reports/{id}/deliver, /handover | delivery | lab.report.print / lab.report.deliver | – | – |
| POST | /outsource/dispatch, /outsource/{id}/receive-results | referral lab | lab.outsource.manage | Y | – |
| GET/POST | /qc/materials, /qc/runs, GET /qc/levey-jennings?analyte= | IQC | lab.qc.manage / lab.qc.read | Y | cursor |
| GET/POST | /eqa/programmes, /eqa/rounds | EQA | lab.qc.manage | Y | cursor |
| GET | /tat/dashboard, /reports/kpi/* | TAT/NABL KPIs | lab.report.read | – | – |
| GET/PUT | /tests, /reference-ranges, /tat-config, /instruments | masters | lab.master.configure | Y | cursor |
| GET | /public/verify/{code} | QR verify | public | – | – |

## 7. Domain Events
- `lab.order.created|cancelled|addon` → OP-005 (charge/reverse), OP-002 status, EN-018.
- `lab.sample.collected|dispatched|received|rejected|accessioned` → OP-002/IP-003 status, patient SMS (collected/rejected), TAT engine.
- `lab.result.entered|verified|final|amended` → OP-002 inbox, IP-003, EN-011 (DiagnosticReport), analytics, NC-006 reagent consumption (on final), reflex engine.
- `lab.result.critical` {result_id, patient_id, doctor_id, value} → EN-037 escalation ladder, OP-002 blocking modal, IP-009 board.
- `lab.critical.acknowledged` (loop closed).
- `lab.report.generated|delivered|handed_over` → PE-001, EN-009 WhatsApp, PE-007.
- `lab.qc.violation` {instrument, analyte, rule} → quality manager, lockout; `lab.qc.released`.
- `lab.tat.breached` → supervisor, TV.
- `lab.outsource.dispatched|received`.
- `lab.notifiable.detected` → NC-015/public-health.

## 8. Screens
- **Pending orders / collection worklist** (desktop + tablet for phlebotomy): grouped by location; scan field focused; `F2` print labels, `F4` collect (scan), `F6` reject, `F8` dispatch manifest. Real-time; empty "No pending collections at OPD".
- **Accession & receiving** (desktop): scan to receive, batch receive, condition capture, aliquot labels.
- **Bench worklist / result entry** (desktop): grid per sample or per test; instrument results incoming (live badge), flags coloured; `Enter` next cell, `F5` verify selected, `F9` authorise (signatory), `Ctrl+R` rerun, `Ctrl+D` delta view, `Ctrl+H` history/cumulative; hard-stop banner on critical requiring call-back log; offline: manual entry queued (rare; lab is online).
- **Validation worklist (Pathologist)** (desktop/tablet): filters abnormal/critical/delta/pending; batch authorise; comments; cross-department view.
- **Critical value console**: open tasks with timers, escalation status, call-back form.
- **Microbiology** (culture workflow: plating, reading days, organism, AST panel with breakpoints); **Histopathology** (grossing, blocks/slides tracking, synoptic templates, co-sign) — both Phase 3+ sub-flags.
- **QC dashboard** (desktop): Levey-Jennings charts (Recharts), Westgard violation list, lockouts, EQA tracker, instrument maintenance calendar.
- **TAT / SLA dashboard** (desktop + TV): traffic light by dept/test/priority; pending beyond TAT list.
- **Report centre**: search, view PDF, deliver, handover log, bulk download, cumulative builder.
- **Outsource desk**: manifests, expected returns, upload results.
- **Master config**: tests, ranges, TAT, reflex, instrument mapping, signatories.
- Print: labels 50×25 mm (ZPL, 2D), A4 reports (PDF), manifests.

## 9. Integrations
- EN-004 analyzers: HL7 v2.3–2.5.1 (ORM/ORU/QRY) over MLLP, ASTM E1381/E1394 serial/TCP; drivers per model (Sysmex, Mindray, Roche cobas, Beckman, Abbott, BioMérieux Vitek, Bio-Rad D-10 etc.) configured by mapping; middleware compatible (Data Innovations) optional; message log, replay, DLQ.
- POCT devices (glucometers, blood gas) via EN-004/EN-042.
- Barcode printers/scanners (EN-013/EN-005), pneumatic tube (manual manifest), referral labs (API/HL7/CSV/PDF upload), EN-011 ABDM (DiagnosticReport bundle with observations LOINC), EN-009 WhatsApp/SMS, EN-016 e-sign, PE-001 portal, NC-006 reagents, NC-020 instrument assets, NC-015 CAPA/incidents, EN-031 NABL doc exports, OP-005 billing.
- Fallbacks: analyzer link down → manual entry with instrument tag; label printer down → reprint queue; portal down → counter print.

## 10. Reports & Analytics
- Daily test volume by dept/test/source; TAT compliance by test/priority (NABL indicator); sample rejection rate by reason/collector/location; critical value communication time & %; amended reports %; QC failures/analyte, EQA performance; instrument utilisation & downtime; outsourced volume/cost/TAT; revenue per test (OP-005), unbilled tests (RC-006 hook: results without paid bill), reagent cost per test; abnormal % by test (quality signal); pending worklist aging; report delivery channel mix; NABL 112 audit pack (registers: request, rejection, critical, QC, EQA, calibration, temperature); IDSP notifiable summary; antibiogram (IP-012).
- Read models: `analytics.mv_lab_tat`, `analytics.mv_lab_volume_daily`, `analytics.mv_lab_rejections`, `analytics.mv_lab_qc_summary`.

## 11. Notifications
- Patient: prep instructions on order (fasting), sample collected + expected time, sample rejected/recollection, report ready (WhatsApp PDF/portal link; not for sensitive tests), home collection ETA.
- Doctor: critical value (push + SMS + escalation), report ready (inbox), rejection notice, amended report.
- Lab: STAT order arrived (sound + badge), TAT breach warning at 80 %, QC violation, EQA due, instrument calibration due, reagent low/expiring, outsourced overdue.
- TV: lab TAT board / sample status for patients (token-based).

## 12. Permissions
`lab.order.create|list|read|addon|cancel`, `lab.sample.label|collect|reject|receive|custody`, `lab.result.enter|verify|validate|amend|read|sensitive.read`, `lab.critical.notify|read`, `lab.report.generate|print|deliver|export`, `lab.outsource.manage`, `lab.qc.manage|read`, `lab.master.configure`, `lab.instrument.manage`, `integration.lab.ingest`, `lab.report.read`.
Defaults: Phlebotomist: sample.*; Technician: order.list/read, result.enter/verify (not own entries), qc.manage (runs); Pathologist: result.validate/amend, critical.notify, report.*, sensitive.read; Quality manager: qc.*, master.configure (ranges w/ approval), report.read; Doctor: result.read (care team), critical.read; Front office: order.create (walk-in), report.print/deliver; Auditor: read.

## 13. Non-functional
- Volumes: 20k tests/day (≈ 100k results/day), 6k orders/day, 30 analyzers, 40 collection points; peak 07:00–11:00; results table 36M rows/yr partitioned; 5-year online history for cumulative.
- p95: worklist < 200 ms; result save (batch 50) < 300 ms; analyzer message → visible < 2 s; PDF < 3 s async; cumulative query (5 yrs, 10 analytes) < 500 ms (index on patient_id,test_id,authorised_at).
- Offline: phlebotomy tablet caches worklist & prints labels offline (local print agent), collection scans queued; bench entry online.
- Printing: label agent (ZPL/TSPL) with 2D; A4 report auto-print at counters; page x of y.
- Accessibility/i18n: keyboard-only bench; flag colours + symbols; report language English (headers bilingual optional); patient SMS multilingual.
- Security: sensitive results ACL; PHI minimal on labels (name, UHID, age/sex); QR verify reveals no results; audit every result mutation with before/after; hash-chained reports.

## 14. Acceptance Criteria
1. Given `order.lab.created` for CBC+LFT (STAT), then a lab order with accession no appears in the OPD collection worklist within 1 s, pinned red, with 2 labels (lavender, gold) generated.
2. Given labels printed, when phlebotomist scans both, then samples become `collected` with collector/time, order status `collected`, and patient receives "sample collected" SMS with expected report time.
3. Given a haemolysed sample rejected, then ordering doctor and patient are notified, a recollection order is created without new charges, and the rejection appears in the rejection KPI with reason.
4. Given analyzer ORU with potassium 6.8, then result lands `unverified` with flag HH/critical, a critical alert task is created, doctor notified via push+SMS within 30 s, and authorisation requires a call-back log with read-back checkbox.
5. Given the last IQC for glucose failed 1-3s, when analyzer glucose results arrive, then they are held `qc_hold` and cannot be verified until QC passes or pathologist overrides with reason.
6. Given a manual result entered by user A, when A tries to verify it, then 403 (segregation); user B can verify; pathologist authorises → `lab.result.final` and PDF generated with reference range used, signatory, times, page numbers, QR.
7. Given normal interfaced results with no delta/critical and auto-validation rule enabled, then they become `verified` automatically with rule id logged and appear on pathologist worklist for authorisation (or auto-authorised if configured for that test).
8. Given creatinine 1.1 today vs 0.6 last month (delta > 50 %), then delta flag shows and result requires manual verification.
9. Given an amended report, then version 2 shows "Amended" and supersedes note, doctor and patient re-notified, version 1 retrievable; QR verify shows current version.
10. Given HIV test authorised, then no WhatsApp/SMS is sent, portal shows "collect from counsellor", and only users with `lab.result.sensitive.read` can view.
11. Given a test routed to referral lab, then a manifest is generated, status `outsourced`, and on results upload the report shows referral lab name and TAT includes outsourced time.
12. Given cumulative report requested for HbA1c over 2 years, then a table+graph PDF renders in < 3 s.
13. Given TAT target STAT CBC 60 min and elapsed 50 min, then amber warning shows; at 61 min `lab.tat.breached` fires and TV board shows red.
14. Given a bill unpaid for a self-pay order, then collection is blocked with "Awaiting payment" unless user has `lab.order.collect_unpaid` (ER/credit exempt).
15. Given 20k tests/day load, worklist p95 < 200 ms and analyzer ingest sustained at 50 msg/s without loss (DLQ empty).
16. Given a QC run violating 2-2s, then Levey-Jennings marks it, lockout is set, and quality manager gets an alert; release requires CAPA note.
17. Given an MLC sample, then every custody hand-over is recorded with scan and signature and the chain report can be printed.
18. Given report handover to a third party at counter, then the handover log captures name/ID/OTP and the event is auditable.

## 15. Enhancements / Later phases
- From VIMS sheet: POCT integration (Phase 3 via EN-004/EN-042); auto-dilution calculation (Phase 3); external lab order routing (Phase 3 outsourcing); cumulative patient report (Phase 3); specimen chain-of-custody medico-legal (Phase 3/6); proficiency testing/EQA tracking (Phase 3 via EN-031).
- (market) Emergency sample management, status-based order list, cross-department result verification, automated approval mechanism, delta trend chart, collection-centre management, omni-channel reporting, bulk lab report download (MocDoc); QR-verified report authenticity, multi-signature per report, reporting-doctor signature images (SmartHospital); two-level authentication, reagent consumption per test, sub-department browsing (Prodoc); home collection/runner app (MocDoc) Phase 10; digital pathology/whole-slide viewer; blood bank link (IP-007); AI abnormal-pattern flags (AI-002).

## 16. Open Questions for the Hospital
1. Analyzer inventory: make/model/interface (HL7/ASTM/serial) and whether existing middleware exists; number per branch.
2. NABL status/scope: which departments/tests are accredited; authorised signatories per department; auto-validation policy acceptable?
3. Test catalogue source (existing LIS export? standard list) with LOINC mapping; reference ranges by age/sex; critical value list; delta rules.
4. TAT targets per test/priority; when does the TAT clock start?
5. Sample rejection reason list and recollection charge policy.
6. Referral labs used, their formats (API/HL7/PDF), pricing; which tests outsourced.
7. Report format/letterhead per branch; NABL logo usage rules; languages; signature images vs DSC.
8. Critical value communication protocol (who calls, escalation timings, ward vs OPD).
9. Sensitive tests list and delivery restrictions; PNDT compliance needs (ultrasound is OP-008 but lab genetics?).
10. Home collection service? Collection centres outside hospital (satellite) — courier flow?
11. Sample retention periods; storage locations; BMW disposal vendor logs.
12. Payment policy: pay-before-collection for self-pay? credit exceptions.
13. Microbiology (AST breakpoints CLSI vs EUCAST) and histopathology workflows at go-live?
