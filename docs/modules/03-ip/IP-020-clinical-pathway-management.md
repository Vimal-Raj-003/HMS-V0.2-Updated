# IP-020 — Clinical Pathway Management (protocol/pathway templates by diagnosis or procedure, day-wise/phase-wise order sets & nursing tasks, goals & milestones, variance capture & analysis, outcome metrics, ERAS bundles, pathway-driven LOS & cost benchmarking)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-020 |
| Phase | 8 |
| Priority | P2 |
| Complexity | Medium–High |
| Depends on | OP-002 (CPOE order sets: investigations, medications, diet, activity, consults, nursing orders; problem list ICD-10/SNOMED), IP-003 (nursing tasks, assessments, care plans, education tasks, vitals thresholds), IP-001/IP-002 (admission diagnosis/procedure enrolment triggers, expected LOS/predicted discharge, discharge criteria), IP-006/IP-024 (surgical/anaesthesia pathways: ERAS, pre-op/post-op phases), IP-009/IP-016 (ICU/HDU pathway phases: sepsis bundle, ventilator bundle), IP-013 (Code Stroke/STEMI timers), OP-006/TR-001 (ER pathways: stroke, STEMI, sepsis, trauma), EN-029 (rules engine: variance detection, goal evaluation, alerts), EN-039 (form/template builder), IP-005/IP-008 (package mapping, cost per pathway), NC-015 (quality indicators, CAPA), NC-011/EN-001 (analytics), OP-015 (physio milestones), OP-011 (diet steps), IP-014 (pathway medication sets/antibiotic prophylaxis timing), IP-025 (pathway day → predicted discharge), IP-010/OP-019 (mobile pathway view), PE-001 (patient-facing pathway "what to expect today"), EN-024, EN-037, EN-038 (pathway approval workflow), AI-002 (later: pathway suggestion) |
| Feature flag | `module.clinical_pathways.enabled` (sub-flags: `pathway.auto_enrol`, `pathway.patient_view`, `pathway.cost_variance`, `pathway.eras`) |
| Primary roles | Doctor — IP (7), Surgeon (9), Anaesthetist (10), Intensivist (11), Resident (14), Nurse — Ward/ICU (17/18), Nurse Supervisor (22), Quality Manager (54), HOD (5), MS (4) |
| Secondary roles | Pharmacist (31/32), Dietician (39), Physiotherapist (40), Billing/Package (27), Case manager (custom under 22/54), Patient/Family (59/60), Auditor (58) |
| Regulatory | NABH 5th ed. COP.1 (uniform care guided by evidence-based clinical practice guidelines & pathways), COP.2 (documented care plans), COP.6/7 (surgical & anaesthesia protocols — ERAS/WHO), PSQ (indicators: pathway compliance, LOS, readmission, SSI), CQI (variance analysis, CAPE/CAPA), ICMR/STG (Standard Treatment Guidelines India), NICE/ERAS Society/SSC (Surviving Sepsis) as reference bundles, DPDP (patient-facing content consent), Insurance/scheme package protocols (PMJAY packages align to pathways) |

## 1. Purpose
IP-020 turns clinical protocols into executable, measurable pathways: a hospital builds versioned pathway templates (e.g., "Total knee replacement — ERAS", "Community-acquired pneumonia", "Acute STEMI", "Laparoscopic cholecystectomy day-care", "Sepsis 1-h bundle", "Stroke thrombolysis") with phases/days, order sets, nursing tasks, goals/milestones and discharge criteria; enrols admitted patients (manually or by diagnosis/procedure rules); pushes day-wise orders and tasks into CPOE and the nursing station; captures variances (omission, delay, deviation, patient-condition, system) with reasons; evaluates goals automatically from data; and reports compliance, LOS, cost and outcome metrics per pathway and per doctor to drive standardisation and package profitability.

## 2. Users & Jobs-to-be-done
- **Doctor/surgeon** (desktop/IP-010): enrol patient (or accept auto-suggestion), review today's pathway orders (accept all/modify), record variances with reasons, mark milestones, sign off phase transitions, view compliance & outcomes for own patients.
- **Nurse** (desktop/tablet): pathway tasks integrated into worklist (IP-003), milestone documentation (mobilised day 1, catheter out day 2, drain out, oral intake), education steps, discharge-criteria checks; variance capture when tasks not done/delayed.
- **Quality / pathway committee** (desktop): author/version templates (with clinical leads), approve (EN-038), monitor compliance & variance trends, run RCA/CAPA, benchmark by unit/doctor, retire/update templates with evidence.
- **Case manager / billing**: pathway ↔ package mapping (IP-008), cost variance (`pathway.cost_variance`), LOS vs expected, insurer protocol adherence.
- **Patient/family** (PE-001, `pathway.patient_view`): "your care plan today/tomorrow" (mobilisation, diet, tests, expected discharge date) in plain language.
- **Bed manager (IP-025)**: predicted discharge from pathway day + criteria.

## 3. Core Workflows

### 3.1 Pathway template authoring & governance
1. **Author** (clinical lead + quality) creates `pathway_templates`: code, name, type (medical/surgical/ER/ICU/day-care/ERAS/bundle), applicability (ICD-10/SNOMED diagnosis codes, procedure codes (IP-006 procedure master), age band, speciality, admission type), expected LOS (median/target), phases (e.g., Pre-op / Day 0 / POD1 / POD2 / Discharge; or Hour 0–1 / 1–3 / 3–6 for bundles) with **elements** per phase: **order sets** (OP-002 order-set ids or inline: labs, imaging, meds incl. antibiotic prophylaxis timing rule "within 60 min before incision", VTE prophylaxis, analgesia ladder, IV fluids, diet steps, activity, consults, nursing orders), **nursing tasks** (IP-003 templates: mobilise, catheter removal, drain removal, wound check, education, pain reassessment), **assessments/scores** (IP-003 assessment types), **goals/milestones** (measurable: "pain ≤ 3 by POD1 evening", "ambulate 20 m POD1", "oral diet POD1", "temp < 38 for 24 h", "creatinine ≤ baseline+0.3", "SpO2 ≥ 94 % on RA") each with evaluation rule (EN-029 expression on vitals/labs/tasks/notes), **decision points/branches** (e.g., if culture positive → branch), **discharge criteria** (IP-002 readiness items), **patient education content** (PE-003 links), **variance categories** allowed, **KPIs** (compliance, LOS, readmission, SSI, complications), evidence references (guideline, version, date), owner, review cycle (12 months).
2. Draft → clinical review → approval (EN-038 committee) → `published` version with effective date; changes create new version; enrolled patients continue on their version (or migrate with confirmation); retire with reason. Import/export JSON; library seeds (ERAS colorectal/knee/hip, CAP, COPD exacerbation, ACS/STEMI, stroke, sepsis, DKA, dengue, appendicectomy, cholecystectomy, hernia, TURP, C-section, hysterectomy, PCI, dialysis access, fracture neck femur (TR link)) editable by hospital.

### 3.2 Enrolment (manual & auto)
1. **Auto-suggest** (`pathway.auto_enrol`): on `ip.admitted`, diagnosis update, OT booking (`ot.case.scheduled` with procedure code) or ER pathway activation (Code STEMI/Stroke/Sepsis screen positive) → EN-029 matches applicability → suggestion card on doctor dashboard/IP-010 ("Enrol in TKR-ERAS v3?") with exclusions checklist (e.g., contraindications, comorbidities requiring modification) → doctor accepts/declines (reason) → `pathway_enrolments` with start anchor (admission time / surgery time / symptom onset for STEMI/stroke) → phases scheduled relative to anchor; ER bundles auto-enrol with `auto=true` and doctor confirmation later (configurable).
2. **Manual enrol** from patient chart: pick template/version, anchor time, modifications (skip/replace elements with reason — recorded as `pre-planned deviations`), co-enrolment allowed (e.g., surgical pathway + diabetes management protocol) with conflict check (duplicate orders/meds warns).
3. On enrolment: phase 1 order set proposed to CPOE (doctor signs; individual items may be unticked with reason → variance type `intentional`), nursing tasks pushed to IP-003 with due times, education tasks, goals scheduled, expected discharge date computed → IP-025/IP-002 (`ip.discharge.expected` update), package linkage (IP-008) suggested; Event `pathway.enrolled`.

### 3.3 Daily execution & phase transitions
1. Each phase/day at its start (job at 06:00 or anchor-relative): **day-set** created — pending orders (proposed, need doctor sign via CPOE quick-accept "Accept pathway orders" one click, or modify), nursing tasks activated, goals evaluated on schedule/event; doctor rounds view shows pathway strip: phase, tasks done/pending, goals met/unmet, variances, next-phase criteria.
2. **Phase transition** when transition criteria met (auto-evaluated) → prompt to advance; doctor/nurse advances (or holds with reason = variance `patient_condition`); phases may loop/extend (extra days) with reason.
3. **Anchor-critical timers** for bundles: door-to-ECG 10 min, door-to-needle 60 min (stroke), door-to-balloon 90 min (STEMI), antibiotic within 1 h (sepsis), prophylactic antibiotic ≤ 60 min pre-incision, urinary catheter removal by POD1/2 (CAUTI), VTE prophylaxis within 24 h — countdowns visible (ER board/OT/ward), missed → variance auto-captured + alert.
4. **Discharge readiness** from pathway criteria feeds IP-002 checklist; predicted discharge date/time updated daily; discharge on/before target = "on-pathway".

### 3.4 Variance capture & management
1. **Sources**: automatic — task overdue/skipped (IP-003), order not signed/cancelled, goal unmet at deadline, phase delayed, LOS > target, timer breached, unplanned ICU transfer/readmission/return to OT; manual — doctor/nurse records variance with **category** (patient condition, patient/family choice, clinician decision, system/hospital: bed/OT/lab/pharmacy/equipment delay, community/discharge destination) and **sub-code** (configurable list) + free text + linked element.
2. Each variance = `pathway_variances` row (element, expected_at, actual_at/none, category, code, reason, impact enum(none/minor/delay/major), by); acknowledgment by responsible role; recurring system variances (e.g., physiotherapy not available weekends) → quality dashboard → CAPA (NC-015). Variances never block care; UI is one-tap with smart defaults.
3. **Exit pathway**: doctor exits with reason (diagnosis changed, complication, patient choice, death, transfer) → `pathway.exited`; outcomes still recorded.

### 3.5 Outcomes & metrics
1. Per enrolment at discharge (and 30 days): LOS actual vs target, compliance % (elements done on time / applicable), goal attainment %, variances by category, complications (SSI via IP-012, VTE, readmission ≤ 30 d via IP-001, return to OT, mortality), patient-reported (PE-001 PROM/NPS optional), cost actual (IP-005 charges by category) vs package/pathway standard cost (`pathway.cost_variance`) → `pathway_outcomes` snapshot; aggregate MV per template/version/unit/doctor/payer.
2. Committee review: quarterly report; template revision loop; A/B comparison of versions (LOS, complications) with statistical summary (mean/median/CI) in NC-011.

### 3.6 Exceptions
- Patient declines element (e.g., early mobilisation) → variance `patient_choice`.
- Template retired mid-stay → patients continue on their version; new enrolments blocked.
- CPOE order conflicts (allergy) → EN-029 blocks the specific item; pathway marks item `blocked_by_cdss` (variance auto, category patient condition).
- Offline: pathway tasks act like IP-003 tasks (offline capable); enrolment/variance require sync.

## 4. Data Model (schema `clinical`)
- **clinical.pathway_templates** (id, hospital_id (null = library), code, name, type enum(medical/surgical/er_bundle/icu_bundle/day_care/eras/other), speciality_id, applicability jsonb {icd10[], snomed[], procedure_codes[], age_min, age_max, admission_types[]}, expected_los_hours, target_los_hours, anchor enum(admission/surgery_start/symptom_onset/er_arrival/enrolment), version int, status enum(draft/in_review/published/retired), effective_from, retired_at, evidence jsonb [{title, source, year, url}], owner_id, review_due, kpis jsonb, package_ids jsonb (IP-008), education_ids jsonb (PE-003), created_by, approved_by, approved_at, sha256) — unique (hospital_id, code, version).
- **clinical.pathway_phases** (template_id, seq, code, name, starts_offset_hours, duration_hours?, entry_criteria jsonb, exit_criteria jsonb, allow_extend bool).
- **clinical.pathway_elements** (id, phase_id, type enum(order_set/order/nursing_task/assessment/goal/education/decision/discharge_criterion/timer), ref jsonb {order_set_id?/order_template?/task_template_id?/assessment_type?/education_id?}, label, due_offset_hours, window_hours, mandatory bool, timer_limit_min?, evaluation_rule_id? (EN-029), variance_codes_allowed jsonb, sort_order).
- **clinical.pathway_enrolments** (id, hospital_id, branch_id, admission_id, patient_id, template_id, template_version, anchor_at, enrolled_by, enrolled_at, auto_suggested bool, modifications jsonb [{element_id, action(skip/replace), reason}], current_phase_id, phase_history jsonb [{phase_id, entered_at, exited_at, by, extended_hours}], expected_discharge_at, status enum(active/completed/exited/transferred), exit_reason?, exited_at, package_id?, co_enrolments jsonb) — index (hospital_id, status), (admission_id), (template_id, template_version).
- **clinical.pathway_element_instances** (id, enrolment_id, element_id, phase_instance seq, due_at, window_end_at, status enum(pending/proposed/ordered/done/skipped/blocked_by_cdss/not_applicable/overdue), linked_ref jsonb {order_id?/task_id?/assessment_id?/goal_eval_id?}, done_at, done_by, timer_started_at?, timer_met bool?) — index (enrolment_id, due_at), (hospital_id, status, due_at) — partition monthly.
- **clinical.pathway_goal_evaluations** (element_instance_id, evaluated_at, met bool, values jsonb, source enum(auto/manual), by?).
- **clinical.pathway_variances** (id, enrolment_id, element_instance_id?, detected_at, source enum(auto/manual), category enum(patient_condition/patient_choice/clinician_decision/system_delay/community/other), code, reason_text, expected_at, actual_at?, impact enum(none/minor/delay/major), recorded_by, acknowledged_by?, acknowledged_at, capa_id?) — index (hospital_id, category, detected_at), (enrolment_id).
- **clinical.pathway_outcomes** (enrolment_id, los_hours, target_los_hours, on_target bool, compliance_pct, goals_met_pct, variance_counts jsonb, complications jsonb {ssi, vte, readmit_30d, return_ot, mortality, unplanned_icu}, cost_actual numeric(14,2), cost_standard numeric(14,2), package_variance numeric(14,2), prom jsonb?, computed_at, recomputed_30d_at?).
- Read models: `analytics.mv_pathway_kpis` (per template/version/unit/doctor/payer/month), `analytics.mv_pathway_variance_pareto`, `analytics.mv_pathway_active_board`.

## 5. Business Rules & Validations
- Only `published` versions can be enrolled; enrolment locks version; template edits → new version; retire blocks new enrolments only.
- Applicability match requires diagnosis/procedure code intersection and age band; auto-suggest never auto-orders (except ER bundles flagged `auto_start`, still requiring doctor confirmation ≤ 1 h).
- Pathway orders always pass through CPOE (allergy/interaction/dose checks) and require doctor signature; nurses cannot sign medication orders; nursing tasks activate without signature.
- Element skip/replace requires reason → recorded as variance `clinician_decision` (pre-planned) — counted separately from unplanned variances in compliance (%).
- Timers use anchor timestamps from source modules (ER arrival, incision time from IP-006, symptom onset entered); breach auto-variance + notification to owning role.
- Goals evaluated by EN-029 rules on data arrival + at deadline; manual override with reason.
- Compliance % = done-on-time mandatory elements ÷ applicable mandatory elements; excludes `not_applicable`; reported per enrolment and aggregate; doctor-level metrics visible to the doctor, HOD, quality (not peers) per governance policy.
- Expected discharge = anchor + target LOS adjusted by phase extensions; pushes to IP-025/IP-002 daily.
- Cost variance uses IP-005 posted charges by category vs template standard cost (from IP-008 package or configured); available to billing/quality only.
- Templates & instances append-only for audit; enrolment records immutable after completion (outcomes recompute allowed).
- Retention: templates permanent (versioned); enrolments as clinical record.

## 6. API Surface (`/api/v1/pathways`)
| Method | Path | Purpose | Permission |
|---|---|---|---|
| GET/POST/PATCH | `/templates` , `/templates/{id}` ; POST `/templates/{id}/submit|approve|publish|retire|clone` ; GET/POST `/templates/import|export` | authoring & governance | `pathway.template.author` / `.approve` / `.read` |
| GET | `/suggestions?admissionId=` ; POST `/suggestions/{id}/accept|decline` | auto-suggest | `pathway.enrol` |
| POST | `/enrolments` ; GET `/enrolments` (?ward,template,status; cursor) ; GET `/enrolments/{id}` | enrol/list/detail | `pathway.enrol` / `pathway.enrolment.read` |
| POST | `/enrolments/{id}/phase/advance|hold|extend` | phase control | `pathway.enrolment.write` |
| GET | `/enrolments/{id}/day-set?date=` ; POST `/enrolments/{id}/day-set/accept` (→ CPOE draft orders) | daily orders/tasks | `pathway.enrolment.write` |
| PATCH | `/element-instances/{id}` (done/skip/na with reason) | element status | `pathway.element.write` |
| POST | `/enrolments/{id}/goals/{elementInstanceId}/evaluate` (manual) | goals | `pathway.element.write` |
| POST/GET | `/enrolments/{id}/variances` ; POST `/variances/{id}/acknowledge` ; POST `/variances/{id}/capa` | variance | `pathway.variance.write` / `.review` |
| POST | `/enrolments/{id}/exit` ; POST `/enrolments/{id}/complete` (on discharge; auto) | lifecycle | `pathway.enrolment.write` |
| GET | `/enrolments/{id}/outcome` ; POST `/outcomes/recompute` | outcomes | `pathway.report.read` |
| GET | `/board` (?ward) ; GET `/reports/kpis` , `/reports/variance-pareto` , `/reports/compare?templateId&versions=` | dashboards | `pathway.report.read` |
| GET | `/patient-view/{admissionId}` (PE-001) | patient-facing plan | `pathway.patient_view.read` (patient/family scope) |

## 7. Domain Events (outbox)
- `pathway.template.published|retired` {code, version} → EN-029 rule registration, notification to speciality.
- `pathway.suggested` {admission_id, template} → doctor (IP-010/OP-002 card).
- `pathway.enrolled` {enrolment_id, admission_id, template, version, expected_discharge_at} → OP-002 (proposed orders), IP-003 (tasks), IP-002/IP-025 (expected discharge), IP-008 (package link), PE-001 (patient view), NC-015.
- `pathway.day_set.ready` {enrolment_id, phase, orders_count, tasks_count} → doctor rounds view; `pathway.orders.accepted`.
- `pathway.phase.advanced|held|extended` → IP-025 (predicted discharge), nurse.
- `pathway.timer.breached` {element, limit, actual} → owning role, quality; `pathway.goal.met|unmet`.
- `pathway.variance.recorded` {category, code, impact} → NC-015 (aggregate), in-charge for system delays.
- `pathway.exited` {reason} / `pathway.completed` {outcome summary} → NC-015, IP-005 (cost variance), analytics.
- Consumed: `ip.admitted|diagnosis.updated|discharge.expected|discharge.completed|readmitted` (IP-001/IP-002), `ot.case.scheduled|incision|completed` (IP-006), `er.code.activated|triage.completed` (OP-006/TR-001), `nursing.task.completed|overdue|skipped`, `nursing.vitals.recorded`, `nursing.assessment.completed` (IP-003), `lab.result.final` (OP-004), `rx.ip.ordered|stopped` (OP-002), `ic.ssi.confirmed` (IP-012), `bill.charges.posted` (IP-005).

## 8. Screens (UI)
- **Pathway Studio** (desktop; quality/clinical lead): template canvas — phases as columns, elements as cards (drag), element editor (order-set picker, task template, goal rule builder using EN-029 visual expressions, timers), applicability rules, evidence, versions diff, approval flow; import/export; validation panel (unresolved refs).
- **Patient Pathway Strip** (embedded in OP-002 IP chart, IP-010 mobile, IP-003 nursing patient view): phase progress bar, today's elements (accept orders `Ctrl+Enter`, mark done, skip with reason `S`), goals chips (met/unmet), variance quick-add `V`, timers with countdown, expected discharge; real-time updates.
- **Enrolment Suggestion Card** (doctor dashboard/IP-010): template, matched codes, exclusions checklist, Accept/Decline.
- **Ward Pathway Board** (desktop / EN-018 TV optional): patients by pathway & phase, overdue elements, timers, on/off target LOS.
- **Variance Review Console** (quality desktop): filters, pareto chart, drill to enrolments, CAPA link, export.
- **Outcomes & Compare** (desktop): KPIs by template/version/unit/doctor/payer; version comparison; cost variance (restricted).
- **Patient View** (PE-001 phone): "Today: physio walk, soft diet, blood test; Expected discharge: Thu" in local language.

## 9. Integrations
- OP-002 CPOE order sets (draft orders API), IP-003 tasks/assessments, EN-029 rules (goal/timer evaluation), IP-006 timestamps, OP-006/TR-001 ER anchors, IP-002/IP-025 discharge prediction, IP-008/IP-005 packages/costs, NC-015 indicators/CAPA, PE-001/PE-003 patient content, NC-011 analytics; template library import (JSON; FHIR PlanDefinition/ActivityDefinition export optional via EN-019).

## 10. Reports & Analytics
- Enrolment rate (eligible vs enrolled), compliance %, on-target LOS %, mean/median LOS vs target, goal attainment, variance pareto by category/code/unit/doctor, timer compliance (door-to-needle etc.), complications & readmissions per pathway, cost per case vs standard/package margin (IP-008), version comparison, patient-reported outcomes; NABH COP/PSQ indicator feed.
- MVs: `analytics.mv_pathway_kpis`, `analytics.mv_pathway_variance_pareto`, `analytics.mv_pathway_active_board`.

## 11. Notifications
- Push: pathway suggestion (doctor), day-set ready/orders pending signature, timer approaching/breached (owning role), goal unmet at deadline, phase criteria met (advance?), variance acknowledgement pending (in-charge), template review due (owner).
- Patient (PE-001 push/WhatsApp opt-in): daily plan & expected discharge (no clinical details beyond plan).

## 12. Permissions (RBAC keys)
`pathway.template.author` (54, 5, 4, clinical leads 6/7/9/11), `pathway.template.approve` (4, 5, 54 via EN-038), `pathway.template.read` (clinical), `pathway.enrol` (7, 9, 10, 11, 14 with co-sign, 8 for ER bundles), `pathway.enrolment.read` (clinical, 27, 54, 58), `pathway.enrolment.write` (7, 9, 10, 11, 14), `pathway.element.write` (7–14, 17, 18, 22, 39, 40), `pathway.variance.write` (7–14, 17, 18, 22, 39, 40), `pathway.variance.review` (54, 5, 4, 22), `pathway.report.read` (54, 5, 4, 27 cost, 58), `pathway.patient_view.read` (59, 60 scoped).

## 13. Non-functional
- 2000-bed site: 40–80 templates, 300–600 active enrolments, ~5k element instances/day; day-set generation for all enrolments < 60 s job; strip render p95 < 300 ms; rule evaluations event-driven (< 2 s after data).
- Offline: tasks via IP-003 offline; strip read-only cached.
- Print: pathway sheet per patient (A4), template document (PDF with evidence), variance report.
- i18n: patient view multilingual; clinical labels English with local aliases.

## 14. Acceptance Criteria
1. Given a published template "TKR-ERAS v3" applicable to procedure code X, when an OT case with that code is scheduled for an admitted patient, then the surgeon receives a suggestion card; on accept, enrolment anchors to scheduled surgery start and pre-op phase tasks appear in IP-003.
2. Given enrolment day-set POD1 with 6 orders and 5 tasks, when the doctor clicks "Accept pathway orders", then draft CPOE orders are created and signed in one step (subject to CDSS), and any CDSS-blocked item is marked `blocked_by_cdss` with an auto-variance.
3. Given goal "ambulate ≥ 20 m by POD1 18:00" and the physio task recorded 25 m at 15:00, then goal evaluates met automatically; if no record by 18:00, goal unmet + variance prompt to nurse.
4. Given sepsis bundle enrolled at ER arrival 10:00, when antibiotics are administered at 11:20 (MAR), then timer "antibiotic ≤ 60 min" breach variance is auto-created and the ER physician is notified.
5. Given a nurse skips "urinary catheter removal POD1" with reason "surgeon instruction", then variance category `clinician_decision` is stored and compliance excludes it from unplanned variances.
6. Given phase exit criteria met (pain ≤ 3, oral diet, ambulating), then the strip prompts to advance; advancing updates expected discharge and IP-025 board.
7. Given LOS exceeds target by 24 h, then an auto-variance `system_delay/other` is created pending categorisation and the enrolment appears off-target on the ward board.
8. Given discharge completed, then outcome snapshot computes compliance %, LOS vs target, cost variance (if enabled) and appears in `mv_pathway_kpis` after refresh; 30-day readmission recomputes later.
9. Given a template edited after publish, then a new version is created; existing enrolments remain on the old version and reports can compare versions.
10. Given a patient user, when opening pathway view, then only plain-language plan and expected discharge are shown, no orders or variances.
11. Given a user with `pathway.enrolment.read` only, when calling POST /enrolments, then 403 and audit.

## 15. Enhancements / Later phases
- AI pathway suggestion & personalisation and variance-risk prediction (AI-002/AI-005), FHIR PlanDefinition exchange with insurers/schemes, PROMs collection at 30/90 days (PE-001), pathway simulation for capacity planning (IP-025), cost-to-serve micro-costing (NC-009), external benchmarking library subscription (market), voice-driven variance capture (AI-004).

## 16. Open Questions for the Hospital
1. Which pathways first (top 10 by volume/cost: e.g., TKR/THR, cholecystectomy, C-section, CAP, ACS, stroke, sepsis, dengue, hernia, PCI)? Existing SOP documents to convert?
2. Governance: who authors/approves (pathway committee?), review cycle, doctor-level metric visibility policy?
3. Auto-enrolment allowed for ER bundles without doctor pre-confirmation? Anchor timestamps available (symptom onset capture in triage)?
4. Variance categories/sub-codes list preferred; who acknowledges system-delay variances?
5. Cost variance visibility (billing/quality only?) and package mapping via IP-008?
6. Patient-facing pathway view desired and languages?
7. ERAS programme in place (surgery/anaesthesia leads)? Any insurer/scheme protocol adherence reporting needed?
