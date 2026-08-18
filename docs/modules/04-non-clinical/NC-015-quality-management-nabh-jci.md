# NC-015 — Quality Management NABH/JCI (Indicators, SOPs, Audits, Incidents, CAPA, Committees, Mock Drills)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-015 |
| Phase | 9 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | NC-011 (indicator data from analytics read models), NC-004 (SOP/document control engine), EN-038 (workflows), EN-039 (forms/checklists builder), NC-032/EN-014 (patient complaints feed), EN-030 (feedback/NPS), IP-012 (infection control data), IP-013 (code blue), OP-004/EN-031 (lab QC/NABL), NC-003 (medical record audit), NC-002/NC-020 (equipment PM/calibration), NC-016 (BMW compliance), NC-018/NC-019 (housekeeping/security incidents), NC-010/NC-027 (credentialing/training compliance), NC-013 (ambulance response), NC-023 (licences), TR-011 (trauma registry indicators), EN-037/EN-032 (notifications), EN-024 (audit), EN-041 (multi-branch) |
| Feature flag | `module.quality.enabled` (sub: `quality.jci`, `quality.mock_drills`, `quality.committees`, `quality.patient_safety_goals`) |
| Primary roles | Quality Manager (54), Quality coordinators / NABH cell, Department quality champions |
| Secondary roles | Medical Superintendent (4), Nursing Superintendent (22), HODs (5), Infection Control Nurse (21), All staff (incident reporting), Hospital Admin (2), Committees (members), Auditor/Assessor (58, read-only) |
| Regulatory | NABH Hospital Standards 6th edition (10 chapters: AAC, COP, MOM, PRE, HIC, PSQ, ROM, FMS, HRM, IMS; 100 standards / 651 objective elements; core/commitment/achievement/excellence levels; quality indicators per PSQ), NABH Entry-level/Small Healthcare Organisation standards, JCI 8th ed. (IPSG 1–6, ACC, PFR, AOP, COP, ASC, MMU, PFE, QPS, PCI, GLD, FMS, SQE, MOI), NABL ISO 15189 (lab — via EN-031), National Patient Safety Implementation Framework, Clinical Establishments Act minimum standards, BMW/Fire/AERB compliance evidence, IPSG/NPSG, sentinel event reporting, Medical Council/State norms, DPDP (incident data with PHI) |

## 1. Purpose
NC-015 is the hospital's **quality management system**: an indicator library (NABH 6th ed. PSQ & chapter-wise indicators, JCI QPS, hospital-defined) fed automatically from HMS data with manual entry where needed, targets & trend dashboards, SOP repository (via NC-004 document control) mapped to standards/objective elements, **internal audit** planning & execution with checklists and scoring, gap analysis & accreditation readiness tracker (self-assessment per objective element with evidence links), **incident/near-miss reporting** (anonymous option) with RCA/CAPA, sentinel event handling, committee management (minutes, action tracking), mock drills (fire, code blue, disaster, spill), patient-safety rounds, and assessment/evidence packs.

## 2. Users & Jobs-to-be-done
- **Quality manager** (desktop): configure indicator library & data sources, review monthly indicators, plan/execute internal audits, run gap analysis, manage CAPA, incidents & RCA, committees & drills, prepare assessment evidence.
- **Department champions/HODs** (desktop/phone): enter manual indicator data, respond to audit non-conformities, own CAPAs, review department dashboards.
- **All staff** (phone/desktop): report incidents/near-misses (2-minute form; anonymous option), participate in drills, read SOPs (NC-004/NC-014).
- **MS/Nursing Supt/Admin**: approve RCAs, sentinel event actions, committee decisions; review readiness score.
- **Committees** (Quality & Patient Safety, Infection Control, Pharmacy & Therapeutics, Medical Records, Mortality/Morbidity, Ethics, Safety/FMS, CPR, Blood Transfusion, POSH…): agenda, minutes, actions.
- **Assessor/auditor**: read-only evidence packs.

## 3. Core Workflows
### 3.1 Indicator library & data collection
1. Seeded library: NABH 6th ed. indicators (e.g. time for initial assessment (AAC), % medication errors, % transfusion reactions, surgical site infection rate, catheter-associated UTI/central-line BSI/VAP rates per 1000 device-days (HIC), return to OT/ICU, re-admission within 72 h/30 days, patient falls, pressure ulcers, needle-stick injuries, waiting time OPD/ER/lab/radiology TAT, discharge time, bed occupancy, ALOS, mortality rates, code blue outcomes, employee attrition/absenteeism, incident reporting rate, patient satisfaction, hand hygiene compliance, equipment downtime, PM compliance, BMW compliance, drug stock-outs) with formula (numerator/denominator), unit, frequency (monthly/quarterly), target/benchmark, chapter/standard mapping, **data source** enum(auto/manual/hybrid) with dataset binding (NC-011 read models: e.g. lab TAT from `analytics.lab_tat`, falls from incident types, HAI from IP-012, TAT from queue events) → monthly job computes auto indicators → champions enter manual numerator/denominator with evidence → validation (denominator > 0, outliers) → quality manager approves → dashboards (trend, control charts, RAG vs target, benchmark) → breach → CAPA prompt → Event `quality.indicator.computed|breached`.
2. Hospital-defined indicators (department KPIs) with same engine; JCI QPS library (`quality.jci`) & IPSG measures (patient identification, effective communication/read-back, high-alert medications, safe surgery, hand hygiene, falls).

### 3.2 SOP repository & standards mapping
- SOPs/policies managed in NC-004 with `standard_tags` (chapter → standard → objective element); NC-015 shows coverage matrix (OE ↔ documents ↔ evidence ↔ audits), missing/overdue SOPs, read-acknowledgement status; document review cycle per NABH (≤ 3 years).

### 3.3 Internal audits & gap analysis
1. **Audit plan** (annual calendar: chapter/department/process audits, tracers (patient tracer/system tracer), NABH self-assessment cycles) → **checklists** (EN-039) per standard/OE with scoring (compliant/partial/non-compliant/NA, evidence upload, observations) → auditors assigned (independent of area) → conduct on tablet (offline) with photos → **non-conformities** (major/minor/observation) → auditee response → CAPA (3.5) → closure verification → audit report & score → trend across cycles.
2. **Gap analysis / readiness**: self-assessment per objective element (651 OEs) with status (compliant/partial/non/NA), evidence links (documents, indicators, audits, training records, licences NC-023), responsible owner, due date → readiness % by chapter (core OEs weighted), heat map, action list; assessment mode: pre-assessment/final/surveillance; assessor findings capture & CAPA.

### 3.4 Incident & near-miss reporting, RCA, sentinel events
1. **Anyone** reports (form: type — medication error (NCC MERP category), fall, needle-stick, transfusion reaction, wrong patient/site/procedure, equipment failure, HAI, security, fire, patient complaint escalation, staff injury, near miss; severity (no harm/minor/moderate/severe/death); patient (optional, linked UHID) / staff / visitor; location; datetime; description; immediate action; witnesses; anonymous toggle) in < 2 min (phone/desktop) → auto-classification & routing (quality + department head + specific committees e.g. medication error → pharmacy & therapeutics; HAI → infection control IP-012; equipment → NC-020; security → NC-019) → **triage** by quality (validate, severity/harm score, reportability: sentinel event → MS immediate; needle-stick → PEP protocol IP-012; notifiable) → **investigation**: RCA (5-whys/fishbone/London protocol templates), contributing factors, timeline → **CAPA** → closure with feedback to reporter (non-punitive culture) → aggregate analytics (rate per 1000 patient-days, by type/department/shift) → Event `quality.incident.reported|triaged|closed`, `quality.sentinel.declared`.
2. Sentinel events: 24 h MS notification, RCA within 45 days (JCI), board reporting, external reporting where required (state/CDSCO materiovigilance/PvPI pharmacovigilance forms for ADRs; TR-008 for MLC).
3. Patient complaints (NC-032) & feedback (EN-030) trends feed quality; grievance redressal indicators.

### 3.5 CAPA management
- CAPA record: source (audit NC/incident/indicator breach/complaint/committee/drill), problem statement, root cause, correction (immediate), corrective action, preventive action, owner, due, verification method, effectiveness check date → workflow (open → in progress → implemented → verified → closed/ineffective → reopen) → escalation on overdue → dashboard by department; links to SOP changes (NC-004 versions) and training (NC-027).

### 3.6 Committees (`quality.committees`) & mock drills (`quality.mock_drills`)
- Committee master (members, chair, frequency, ToR), meeting scheduler, agenda from open items (indicators/incidents/CAPA), attendance, **minutes** template with decisions & action items (assigned, due, tracked), documents; drills: schedule (fire, code blue, code pink, disaster/MCI, spill, evacuation), scenario, participants, observers checklist, timings (e.g. code blue response < 3 min), findings → CAPA; drill compliance % (NABH FMS.6). Patient-safety rounds/leadership walk-rounds with findings.

### 3.7 Evidence & assessment packs
- Per chapter/standard: auto-compiled evidence (documents, indicator trends, audit reports, training compliance NC-027, credentialing NC-010, PM/calibration NC-002/NC-020, licences NC-023, BMW NC-016, drills, committee minutes) → export pack (PDF/ZIP) with index; assessor read-only portal access (time-bound); action tracker for assessment findings.

## 4. Data Model (schema `quality`, prefix `q_`)
- **q_frameworks**: id, code enum(nabh6/nabh_entry/jci8/nabl/hospital), version; **q_chapters** (framework_id, code, name), **q_standards** (chapter_id, code, intent), **q_objective_elements** (standard_id, code, text, level enum(core/commitment/achievement/excellence), evidence_hint).
- **q_indicators**: id, hospital_id, code, name, chapter_id?, standard_id?, numerator_def, denominator_def, formula, unit, frequency enum(monthly/quarterly/annual), target, benchmark, direction, source enum(auto/manual/hybrid), dataset_binding jsonb (NC-011 dataset/filters), owner_role, department_scope, active; **q_indicator_values**: indicator_id, branch_id, department_id?, period, numerator, denominator, value, source enum, entered_by?, evidence_file_ids, status enum(draft/submitted/approved/rejected), approved_by, computed_at, breach bool. UNIQUE (indicator_id, branch_id, department_id, period).
- **q_sop_mappings**: objective_element_id, document_id (NC-004), status computed.
- **q_audit_plans**: id, hospital_id, year, items jsonb; **q_audits**: id, hospital_id, branch_id, audit_no, type enum(internal/tracer/self_assessment/external_pre/external_final/surveillance/department), scope (chapters/departments), checklist_template_id, auditors uuid[], auditees uuid[], scheduled_at, conducted_at, score_pct, status enum(planned/in_progress/reported/closed), report_file_id; **q_audit_findings**: audit_id, objective_element_id?, checklist_item, result enum(compliant/partial/non_compliant/na), severity enum(major/minor/observation), evidence_files, observation, auditee_response, capa_id?, status.
- **q_self_assessments**: id, hospital_id, framework_id, cycle_name, oe_statuses (child table: oe_id, status enum(compliant/partial/non_compliant/na), evidence_links jsonb, owner_user_id, due_date, notes), readiness_pct by chapter (computed), status.
- **q_incidents**: id, hospital_id, branch_id, incident_no, reported_at, occurred_at, reporter_user_id? (null if anonymous), anonymous bool, type enum(medication_error/fall/needle_stick/transfusion_reaction/wrong_patient_site_procedure/equipment_failure/hai/security/fire/patient_complaint/staff_injury/near_miss/adr/other), sub_type, merp_category?, severity enum(no_harm/minor/moderate/severe/death), harm_score, patient_id?, encounter_id?, staff_employee_id?, visitor bool, location_id, department_id, description, immediate_action, witnesses jsonb, attachments, triage_status enum(new/validated/investigating/rca/capa/closed/rejected), sentinel bool, reportable_external jsonb {pvpi, materiovigilance, mlc, state}, rca jsonb {method, timeline, contributing_factors, root_causes}, closed_at, feedback_sent_at, confidentiality enum(normal/restricted). INDEX (hospital_id, reported_at desc), (type, department_id).
- **q_capas**: id, hospital_id, capa_no, source_type enum(audit/incident/indicator/complaint/committee/drill/assessment/other), source_id, problem, root_cause, correction, corrective_action, preventive_action, owner_user_id, department_id, due_date, status enum(open/in_progress/implemented/verified/closed/ineffective/reopened), verification_method, verified_by, verified_at, effectiveness_check_at, linked_document_ids, linked_training_ids, escalation_level.
- **q_committees**: id, hospital_id, name, chair_user_id, members uuid[], frequency, tor_document_id; **q_meetings**: committee_id, scheduled_at, held_at, agenda jsonb, attendance jsonb, minutes (rich text/file), decisions jsonb; **q_action_items**: meeting_id, action, owner, due, status.
- **q_drills**: id, hospital_id, branch_id, type enum(fire/code_blue/code_pink/disaster_mci/spill/evacuation/other), scheduled_at, conducted_at, scenario, participants jsonb, observer_checklist jsonb, timings jsonb, findings, capa_ids, status; **q_rounds** (patient safety/leadership rounds: date, area, findings, actions).
- **q_evidence_packs**: framework_id, chapter/standard scope, generated_at, file_id, generated_by; **q_assessor_access** (user/token, valid_from/to, scope).
- RLS; incidents with PHI restricted; anonymous incidents store no reporter id (not even in audit log beyond IP hash by policy).

## 5. Business Rules & Validations
- Indicator values: denominator > 0; auto values immutable (recomputed on data correction with history); manual entries need evidence for approval; approvals by quality manager; late submissions flagged (due by 7th of next month, config).
- Breach → CAPA prompt (mandatory for core indicators two consecutive periods, config).
- Audits: auditors independent of audited area (SoD); non-conformities require CAPA before audit closure; findings mapped to OEs; scoring per checklist weights.
- Self-assessment: OE status requires evidence link for `compliant`; core OEs weighted for readiness; owner & due mandatory for non-compliant.
- Incidents: reportable by any authenticated staff; anonymous supported (no reporter identity stored; feedback via ticket code); severe/death → sentinel flag → MS notification within 15 min (push/SMS) → RCA due 45 days; needle-stick → IP-012 PEP workflow within 2 h; ADR → PvPI form data; medication errors → P&T committee agenda; incident closure requires CAPA (or documented no-action reason) and reporter feedback; non-punitive: incident records not linked to HR disciplinary tables.
- CAPA: owner ≠ verifier; overdue escalates weekly to HOD then MS; effectiveness check mandatory before closure for major NCs/sentinel.
- Committees: quorum tracking; action items tracked to closure; minutes locked after chair sign-off (e-sign EN-016).
- Drills: minimum frequency per type per NABH (e.g. fire drill twice/year, code blue quarterly — config); overdue drills flagged.
- Assessor access read-only, time-boxed, audited; evidence packs exclude PHI unless assessor requires (de-identified samples).
- Retention: incidents/RCA/CAPA 10 years; indicators permanent; audits 2 accreditation cycles minimum.

## 6. API Surface (`/api/v1/quality`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /frameworks, /frameworks/{id}/tree | standards | quality.framework.read | – | – |
| GET/POST/PATCH | /indicators ; POST /indicators/{id}/values ; POST /values/{id}/(submit|approve|reject) ; GET /indicators/dashboard?period=&dept= | indicators | quality.indicator.manage / .enter (champions) / .approve / .read | Y | cursor |
| POST | /indicators/compute?period= (job trigger) | auto compute | quality.indicator.manage | Y | – |
| GET | /sop-coverage?framework= | mapping | quality.sop.read | – | – |
| GET/POST | /audits ; POST /audits/{id}/(start|finding|report|close) ; GET /audits/{id}/findings | audits | quality.audit.plan / .conduct / .close | Y | cursor |
| GET/POST/PATCH | /self-assessments, /self-assessments/{id}/oe/{oeId} ; GET /self-assessments/{id}/readiness | gap analysis | quality.assessment.manage / .update (owners) | Y | – |
| POST | /incidents (auth or anonymous token) ; GET /incidents?type=&status=&dept= ; POST /incidents/{id}/(triage|investigate|rca|close|reject) ; GET /incidents/{id} | incidents | quality.incident.report (all) / .manage / .read (restricted) | Y | cursor |
| GET | /incidents/anonymous/{code} | reporter feedback lookup | public token | – | – |
| GET/POST/PATCH | /capas ; POST /capas/{id}/(implement|verify|close|reopen) | CAPA | quality.capa.manage / .own / .verify | Y | cursor |
| GET/POST | /committees, /committees/{id}/meetings ; POST /meetings/{id}/(minutes|sign) ; /action-items | committees | quality.committee.manage / .member | Y | cursor |
| GET/POST | /drills ; POST /drills/{id}/complete ; /rounds | drills/rounds | quality.drill.manage | Y | cursor |
| POST | /evidence-packs ; GET /evidence-packs/{id}/download ; POST /assessor-access | assessment | quality.evidence.generate / quality.assessor.grant | Y | – |
| GET | /reports/(indicator-trends|audit-scores|incident-analytics|capa-status|readiness|drill-compliance|committee-actions) | reports | quality.report.read | – | – |

## 7. Domain Events (outbox)
- `quality.indicator.computed|submitted|approved|breached` {indicator, period, value, target} → dashboards, NC-011 KPIs, CAPA prompt, EN-037.
- `quality.audit.scheduled|finding.raised|closed` → auditees, HOD, CAPA.
- `quality.incident.reported` {incident_id, type, severity, dept, patient?} → routing (IP-012 HAI/needle-stick, NC-020 equipment, NC-019 security, pharmacy P&T, NC-032 complaint link), MS if sentinel; `quality.incident.closed` → reporter feedback.
- `quality.sentinel.declared` → MS/admin immediate, board report task, external reporting tasks.
- `quality.capa.created|overdue|verified|closed` → owners, HOD, MS escalation, NC-004 (SOP revision), NC-027 (training).
- `quality.committee.action.assigned|overdue`, `quality.drill.completed|overdue` → members/facility.
- `quality.readiness.updated` {framework, chapter, pct} → admin dashboard.
- Consumes: analytics events (NC-011 datasets), `hai.case.confirmed|needlestick.reported` (IP-012), `code_blue.event` (IP-013), `complaint.registered|escalated` (NC-032), `feedback.received` (EN-030), `asset.pm.overdue|equipment.breakdown` (NC-020/NC-002), `bmw.noncompliance` (NC-016), `mrd.deficiency.raised` (NC-003), `hr.licence.expired|training.overdue` (NC-010/NC-027), `licence.expiring` (NC-023), `fleet.trip.completed` (NC-013 response times), `lab.qc.failure` (EN-031), `trauma.registry.case.closed` (TR-011), `dms.document.published` (NC-004).

## 8. Screens (UI)
- **Quality dashboard** — desktop (dark analytics): readiness gauge by chapter, indicators RAG grid with sparklines, incidents this month by type/severity, open CAPAs by dept & overdue, audits calendar, drills compliance; branch compare (EN-041).
- **Indicator workbench** — desktop: library, monthly entry grid (manual), approvals, trend/control charts (p-chart/u-chart), benchmark lines; export.
- **Standards & evidence explorer** — desktop: framework tree (chapter → standard → OE) with status, evidence links, SOP coverage, actions.
- **Audit console** — desktop + tablet (offline checklist execution with photos): plan calendar, checklist runner (`N` next item, `1/2/3` compliant/partial/non), findings, report.
- **Incident report form** — phone/desktop, 2-minute, anonymous toggle, patient search optional; **Incident triage/RCA board** — desktop kanban with RCA templates (fishbone diagram builder), CAPA linkage.
- **CAPA tracker** — desktop/phone (owners): my CAPAs, evidence upload, verification.
- **Committees** — desktop: schedule, agenda auto-pull, minutes editor, actions; **Drills** — tablet observer checklist with timers.
- **Evidence pack generator**, **Assessor portal** (read-only web).
- Empty states, skeletons; WCAG 2.2 AA; i18n.

## 9. Integrations
- NC-011 datasets & KPI engine, NC-004 documents, EN-039 forms/checklists, EN-038 workflows, EN-016 e-sign minutes, EN-037/EN-032/EN-009 notifications, IP-012/IP-013/EN-031/NC-020/NC-016/NC-032/EN-030/NC-003/NC-010/NC-027/NC-023/NC-013/TR-011 feeds, PvPI/materiovigilance forms (PDF/CSV; API where available via EN-017), NABH portal (manual upload of self-assessment/indicator submissions; export formats aligned).

## 10. Reports & Analytics
- Indicator trend & benchmark reports (chapter-wise, department-wise), NABH indicator submission format, audit scores by cycle/department, NC ageing, readiness by chapter/OE level, incident analytics (rate/1000 patient-days, type/severity/shift/location, reporting culture index, time-to-close), sentinel event register, CAPA status & effectiveness, committee attendance & action closure, drill compliance & response times, patient safety goals compliance (IPSG), complaint/feedback linkage. Read models: `analytics.quality_indicators_monthly`, `analytics.quality_incidents_monthly`, `analytics.quality_capa_status`.

## 11. Notifications
- Champions: indicator entry due/overdue; quality: submissions to approve, incidents to triage, audits due; MS: sentinel events (immediate push+SMS), overdue major CAPAs; owners: CAPA assigned/due/overdue; committee members: meeting reminders, action items; reporters: incident acknowledgement & closure feedback (anonymous via code); facility: drills due; assessors: access links.

## 12. Permissions (RBAC keys)
`quality.framework.read`, `quality.indicator.manage/enter/approve/read`, `quality.sop.read`, `quality.audit.plan/conduct/close`, `quality.assessment.manage/update`, `quality.incident.report` (all staff), `quality.incident.manage`, `quality.incident.read` (restricted PHI), `quality.capa.manage/own/verify`, `quality.committee.manage/member`, `quality.drill.manage`, `quality.evidence.generate`, `quality.assessor.grant`, `quality.report.read`, `quality.configure`. ABAC: department scope for champions/HOD; incidents `confidentiality=restricted` need elevated key; auditor independence enforced.

## 13. Non-functional
- Volumes: 200 indicators × 12 branches × monthly; 300–600 incidents/month; 50 audits/year; 651 OEs × cycles; incident form submit < 1 s; dashboards from read models < 1 s.
- Offline: audit checklists & incident form queue on tablet/phone.
- Security: incident PHI restricted; anonymous reporting truly anonymous (no reporter id, IP hashed with daily salt), non-punitive separation from HR; assessor access time-boxed; RLS.
- Printing/exports: evidence packs (PDF/ZIP index), minutes, audit reports, NABH indicator formats (Excel).

## 14. Acceptance Criteria
1. Given the monthly compute job, then auto indicators (e.g. lab TAT compliance, ALOS, falls per 1000 patient-days) populate from NC-011 datasets with source links and appear RAG vs target.
2. Given a manual indicator submitted without evidence, then approval is blocked; with evidence and quality approval, it locks and shows in trends.
3. Given a core indicator breaches target two consecutive months, then a CAPA prompt is created and assigned to the indicator owner.
4. Given an audit where the assigned auditor belongs to the audited department, then assignment is rejected (independence rule).
5. Given an audit finding marked major non-conformity, then audit closure is blocked until a CAPA exists and is at least `implemented`.
6. Given a nurse reports a fall with severity `severe` from her phone in under 2 minutes, then MS receives an immediate alert, the incident is flagged sentinel, RCA due date = +45 days, and the reporter receives an acknowledgement.
7. Given an anonymous incident, then no reporter identity is stored and the reporter can check status via the code.
8. Given a needle-stick incident, then IP-012 PEP workflow is triggered within the event pipeline and the incident links to it.
9. Given a CAPA verified by its own owner, then blocked (owner ≠ verifier).
10. Given self-assessment where a core OE is marked compliant without evidence link, then validation fails; readiness % recalculates on each status change and the chapter heat map updates.
11. Given fire drills configured twice a year and none conducted in 7 months, then the drills compliance widget shows overdue and facility head is notified.
12. Given committee minutes signed by the chair, then they are locked and action items appear in owners' trackers with due dates.
13. Given an assessor access token expired, then the portal denies access and all prior views are in the audit log.
14. Given an evidence pack for chapter HIC, then it includes SOPs, HAI indicators, audits, training compliance and drills with an index, excluding PHI.

## 15. Enhancements / Later phases
- From VIMS sheet: indicator tracking, SOP repository, internal audit, gap analysis (Phase 9 core); corrective action & dashboard (Phase 9).
- (market) NABH-grade compliance evidence automation, JCI tracer methodology tools (`quality.jci`), AI-assisted RCA suggestions & incident classification (AI-002/AI-003), predictive risk (AI-005), benchmarking with peer hospitals (EN-001), patient safety culture surveys (NC-010 survey engine), automated NABH portal submissions (when API exists), clinical audit module (criteria-based audits with case sampling from NC-003), M&M meeting management with case anonymisation.

## 16. Open Questions for the Hospital
1. Accreditation target (NABH entry-level/full 6th ed., JCI, NABL) and current status/cycle dates?
2. Indicator list currently tracked, data owners, and existing manual registers to migrate?
3. Incident reporting policy (anonymous allowed, non-punitive statement), sentinel event definitions, external reporting obligations (PvPI/materiovigilance/state)?
4. Committees in place (names, members, frequency) and minutes format?
5. Audit programme (internal auditors pool, frequency), tracer methodology adoption?
6. Drill frequencies and responsible teams; fire/safety officer?
7. Should quality data be shared across branches (group benchmarking)?
8. Assessor portal access acceptable; evidence pack format preferences?
