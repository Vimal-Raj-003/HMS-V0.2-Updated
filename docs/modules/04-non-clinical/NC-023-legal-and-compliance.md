# NC-023 — Legal & Compliance (Statutory Licence & Registration Tracker, Renewals, Inspections, Legal Case Log, Notices/RTI/Summons, Compliance Calendar & Audit Trail)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-023 |
| Phase | 9 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | NC-004 (licence documents, versions, OCR search), NC-020 (AERB radiation equipment licences/QA, PNDT machine registration), OP-008 (PC-PNDT Form F, USG registration), IP-007 (blood bank licence Form 27C/28C, SBTC), OP-003/IP-014 (drug licences 20/21/20B/21B, Schedule X/NDPS registers), NC-016 (SPCB BMW authorisation, annual report Form IV, consent to operate), NC-025 (fire NOC, lift licence, DG set consent, boiler, electrical inspectorate, building occupancy), NC-019 (PSARA, security incidents/FIR), TR-008 (MLC/court summons for medico-legal cases), NC-032 (grievances escalating to consumer forum/legal), NC-010 (labour licences: Contract Labour, Shops & Establishment, PF/ESI codes, POSH committee), NC-021/NC-031 (vendor/contract legal review, disputes), NC-009 (legal fees, penalties, GST/TDS compliance dates), NC-015 (NABH/NABL accreditation certificates & surveillance dates), NC-011, NC-022 (compliance capex), EN-004 (Privacy/DPDP obligations shared with EN-024/EN-028), EN-038 (approvals), EN-037/EN-032 (alerts), EN-024 (audit trail viewer), NC-002 (assets needing licence), EN-016 (e-sign) |
| Feature flag | `module.legal.enabled` (sub: `legal.cases`, `legal.rti`, `legal.compliance_calendar`, `legal.inspections`) |
| Primary roles | Legal & Compliance Officer / Company Secretary, Hospital Administrator, Medical Superintendent |
| Secondary roles | Department owners of licences (Radiology/RSO, Blood bank officer, Pharmacy in-charge, Facility, HR, Quality, IT/DPO), Finance (46), MRD (43; court record requests), Director/Board, External counsel (invite-based limited portal), Auditor (58) |
| Regulatory (tracked licences/registrations — non-exhaustive, configurable) | Clinical Establishments (Registration & Regulation) Act 2010 / state nursing-home acts (registration & renewal, display of rates), NABH/NABL certificates, Drugs & Cosmetics Act licences (Form 20/21/20B/21B, Schedule X, Form 20-F/G blood bank), NDPS Act registers & state permits, Blood Bank licence (Form 27C/28C; SBTC/NACO), AERB licences (eLORA per equipment; RSO approval; TLD), PC-PNDT registration (per USG machine/centre; Form A/B/F), Biomedical Waste authorisation (SPCB; Form II/IV annual report), Consent to Establish/Operate (Air/Water Acts; ETP/STP), Hazardous waste, Fire NOC (state fire services; annual/periodic), Lift licence (state Lifts Act), DG set (PCB noise/emission consent), Boiler (Indian Boilers Act — autoclaves/laundry), Electrical inspectorate (HT installation), Building occupancy/completion certificate, Shops & Establishment, Contract Labour (Principal employer registration), PF/ESI codes, Professional Tax, GST registration, FSSAI (kitchen/canteen), Legal Metrology (weights/scales), PSARA (security agency), Trade licence (municipal), Signage licence, Water connection/borewell NOC (CGWA), Ambulance permits (RTO/108), Organ transplant (THOTA registration), MTP Act approval, Narcotics (state excise for spirit), Cyber-café/telecom (if applicable), Radiology/PET (BARC), Insurance (public liability, professional indemnity, fire), Medical Council registrations of doctors (NMC/State) & nurses (INC/State council) — via NC-010 credentialing, POSH committee constitution, DPDP Act 2023/Rules 2025 (consent, breach notification 72 h to DPB, DPO appointment for SDF), RTI Act 2005 (public hospitals), Consumer Protection Act 2019 (patient complaints → forums), Medicare Persons Act (violence), Epidemic Diseases Act notifications, IDSP notifiable disease reporting (with clinical modules), Births & Deaths Registration (IP-011/IP-017), Mental Healthcare Act 2017 registration (OP-032), Transplantation (NOTTO) |

## 1. Purpose
NC-023 keeps the hospital continuously **licensed and defensible**: a master **licence/registration/certificate tracker** with owners, validity, renewal lead times, evidence documents and inspection records; a **compliance calendar** of recurring statutory filings/returns (BMW annual report, PNDT monthly Form F submission, AERB QA, GST/TDS dates via NC-009, PF/ESI, Fire drill records, IDSP reporting), **regulatory inspections & notices** with response tracking; a **legal case log** (consumer forum, civil/criminal, labour, MLC-driven summons, vendor disputes, RTI applications) with counsel, hearings, documents, costs and outcomes; and dashboards for management (red/amber/green compliance status by department/branch). It links to the operational modules that hold the underlying evidence and enforces hard-stops where the law does (e.g. AERB/PNDT equipment, blood bank).

## 2. Users & Jobs-to-be-done
- **Compliance officer** (desktop): maintain the licence register, assign owners, chase renewals, upload certificates, log inspections/notices, prepare compliance status for board/NABH, RTI responses (public hospitals).
- **Licence owners** (RSO, pharmacy, blood bank, facility, HR, kitchen…): receive renewal tasks, upload applications/receipts/certificates, record inspections, mark completion.
- **Legal officer/counsel**: case log, hearing calendar, document bundle, MRD record requests, court summons handling with TR-008/MRD, settlement approvals, fee tracking.
- **MS/Admin/Director**: RAG dashboard, approve responses/settlements, sign filings.
- **DPO**: DPDP compliance items (breach notification timers, consent audits — with EN-024/EN-028).
- **Auditor**: evidence packs.

## 3. Core Workflows
### 3.1 Licence register & renewal
1. **Compliance officer** creates licence record from **catalogue** (seeded list above with authority, typical validity, lead time, renewal steps checklist, fee, forms) → fields: number, issuing authority & office, scope (branch/equipment/person), issue/valid dates, owner user/department, linked entities (equipment NC-020, ambulance NC-013, blood bank IP-007, kitchen NC-033…), documents (certificate, application, fee receipts — NC-004), conditions/obligations (e.g. display board, monthly returns), renewal_lead_days (default per catalogue e.g. Fire NOC 90, AERB 120, PNDT 90, drug licence 90, BMW 120), status → Event `licence.registered`.
2. **Renewal**: at lead time → task to owner (checklist steps: application filed → fee paid → inspection → certificate received) with sub-dates; escalation to admin at 60/30/7 days; expired → `expired` status + **operational hard-stops** where configured (AERB → NC-020 equipment out of service; PNDT → OP-008 USG scheduling block; blood bank → IP-007 issue block; drug licence → OP-003 purchase/dispense warnings; fire NOC → admin alert only) → renewed certificate uploaded → validity extended, history retained → Event `licence.renewed|expired|expiring`.
3. Bulk import of existing licences (EN-036); duplicate/overlap detection.

### 3.2 Compliance calendar (`legal.compliance_calendar`)
- Recurring obligations from catalogue: filings (BMW annual report Form IV by 30 Jun; PNDT Form F monthly by 5th; AERB QA/TLD; GST/TDS (mirrored from NC-009); PF/ESI monthly; PT; POSH annual report; Clinical Establishment returns; IDSP weekly; fire drill quarterly (NC-019); mock drills; NABH self-assessment; DPDP consent audit), each with owner, due rule (RRULE), evidence required → tasks generated → completion with evidence → missed → escalation → compliance % per department → Event `compliance.task.due|completed|missed`.

### 3.3 Inspections & regulatory notices (`legal.inspections`)
1. Inspection visit (Fire, SPCB, Drug inspector, AERB, PNDT appropriate authority, labour, health dept, NABH assessors) → record: date, authority, officers, areas, observations/deficiencies, documents demanded, outcome → deficiencies → CAPA tasks (NC-015 link) with due dates → compliance report submission → closure.
2. **Notice/show-cause** received (email/paper scan) → register (authority, subject, received date, response due) → assign owner/counsel → draft response (NC-004 versions) → approvals (EN-038) → dispatched (proof) → follow-up → closure; penalties → NC-009.

### 3.4 Legal case log (`legal.cases`)
1. **Legal officer** opens case: type enum(consumer_forum/civil/criminal/labour_court/high_court_writ/arbitration/vendor_dispute/insurance_dispute/mlc_summons/police_matter/property/ip_trademark/employment/other), forum & case no., parties, subject (patient UHID linkage optional; MLC id TR-008; grievance NC-032; incident NC-015; vendor NC-021; employee NC-010), our role (petitioner/respondent/witness), counsel (empanelled advocates master with fees), risk (claim amount, exposure rating), status → **hearings** calendar (date, purpose, outcome, next date), documents bundle (pleadings, evidence, medical records requested via MRD NC-003 with legal hold), tasks (affidavit, expert opinion), **legal hold** on records/CCTV (NC-019)/data (EN-024 retention override), expenses (fees, court fees → NC-009), settlement/judgment, appeal, closure & learnings (CAPA) → Event `legal.case.opened|hearing.scheduled|closed`.
2. **Court summons/record requests** (medico-legal): intake → verify authenticity → MRD certified copies (NC-003) → doctor witness scheduling → track.
3. **Legal opinion/contract review** requests from departments (NC-031 contracts, consent forms EN-028 templates, policies NC-004) → queue → opinion doc → closure.

### 3.5 RTI (`legal.rti`, public hospitals)
- Application register (received date, applicant, subject, fee), PIO assignment, 30-day timer (48 h life/liberty), information gathering tasks to departments, response/denial with section, first appeal, second appeal (SIC), quarterly returns → dashboard.

### 3.6 Audit trail & evidence packs
- Compliance officer can generate **evidence packs** per authority/NABH chapter: licences + certificates + calendar completions + inspection reports; leverage EN-024 audit viewer for who changed what; immutable history of licence versions.

## 4. Data Model (schema `ops`, prefix `lc_`)
- **lc_licence_catalogue** (seeded, editable): code, name, authority_type, jurisdiction enum(central/state/municipal/accreditation/insurance), typical_validity_months, lead_days, checklist jsonb, forms jsonb, hard_stop_hook enum(none/aerb_equipment/pndt_usg/blood_bank/drug_licence/fire/kitchen/ambulance/lift/dg…), obligations jsonb (recurring rules).
- **lc_licences**: id, hospital_id, branch_id, catalogue_code, licence_no, authority_name, authority_office, scope_type enum(branch/equipment/person/vehicle/facility_area/department), scope_ref_id?, owner_user_id, owner_department_id, issue_date, valid_from, valid_until (null = perpetual), lead_days, status enum(active/expiring/renewal_in_progress/expired/suspended/surrendered/not_applicable), conditions text, fee numeric, documents jsonb [{type, file_id, version}], hard_stop_enabled bool, last_inspection_id?, notes, version. UNIQUE (hospital_id, catalogue_code, licence_no); INDEX (hospital_id, branch_id, status, valid_until), (owner_user_id).
- **lc_licence_history** (licence_id, action enum(created/renewed/amended/suspended/expired/surrendered), from, to, file_id, by, at).
- **lc_renewals** (licence_id, cycle_no, started_at, steps jsonb [{step, done_at, by, file_id}], expected_completion, status, escalations jsonb).
- **lc_obligations** (id, licence_id?/catalogue_code, name, rrule, owner_user_id, evidence_type, grace_days, active), **lc_compliance_tasks** (obligation_id, due_at, completed_at, completed_by, evidence_file_ids, status enum(due/completed/late/missed/waived), waiver_reason). INDEX (hospital_id, due_at, status).
- **lc_inspections** (id, branch_id, authority, kind, licence_id?, visited_at, officers jsonb, areas text[], observations jsonb [{text, severity, capa_task_id, due, status}], documents_demanded jsonb, outcome enum(satisfactory/deficiencies/notice/closure), report_file_id, closed_at).
- **lc_notices** (id, branch_id, authority, subject, received_at, response_due_at, owner_user_id, counsel_id?, category, drafts jsonb, approvals jsonb, dispatched_at, proof_file_id, penalty_amount?, status enum(open/drafting/awaiting_approval/responded/closed/escalated_to_case), case_id?).
- **lc_cases**: id, hospital_id, branch_id, case_no_internal, type enum, forum, court_case_no, filed_on, parties jsonb, our_role, subject, patient_id?, mlc_id?, grievance_id?, incident_id?, vendor_id?, employee_id?, counsel_id, claim_amount, exposure enum(low/medium/high/critical), provision_amount (NC-009), status enum(open/hearing/reserved/decided/appealed/settled/closed/withdrawn), outcome jsonb, legal_hold jsonb [{system, ref, until}], confidentiality enum(normal/restricted), created_by, closed_at. INDEX (hospital_id, status, type), (patient_id).
- **lc_hearings** (case_id, at, purpose, attended_by, outcome, next_at, order_file_id), **lc_case_tasks**, **lc_case_documents** (NC-004 refs, privilege flag), **lc_case_expenses** (type, amount, invoice, gl_ref), **lc_counsels** (name, bar_no, firm, empanelled bool, fee_terms, contacts, rating).
- **lc_record_requests** (source enum(court/police/insurer/patient_lawyer), case_id?, received_at, records_requested, mrd_request_id (NC-003), certified_copies_issued_at, custodian).
- **lc_rti_applications** (app_no, applicant (masked), received_at, subject, fee, pio_user_id, due_at (30 d / 48 h), department_tasks jsonb, response jsonb, status, appeals jsonb).
- **lc_opinion_requests** (from_dept, subject, doc_refs, assigned_to, opinion_file_id, status).
- **analytics.compliance_status** (branch, department, month: licences_active/expiring/expired, tasks_due/done/missed, inspections_open, cases_open, exposure_sum).
- RLS; cases with `confidentiality=restricted` visible only to legal role + named users; PHI minimal (patient linkage by id with `READ_PHI` logging).

## 5. Business Rules & Validations
- Every licence must have an owner and (unless perpetual) valid_until; status auto-derives: expiring when now ≥ valid_until − lead_days; expired after valid_until (grace configurable per catalogue only if law allows e.g. renewal applied before expiry keeps operating for some licences — capture `deemed_valid_until_decision` flag).
- Hard-stops fire via events to owning modules only when `hard_stop_enabled` (default true for AERB, PNDT, blood bank; false/warn for others); overrides only in the operational module by designated role with reason.
- Renewal tasks cannot be closed without certificate document & new validity; history immutable.
- Compliance task completion requires evidence when `evidence_type` set; missed tasks need waiver reason by admin.
- Notices: response due date mandatory; approvals per EN-038 (Admin/MS; Director for penalties/high risk); dispatch proof required to close.
- Cases: restricted confidentiality default for MLC/consumer cases; legal hold prevents record purge (EN-024 retention engine consults `lc_cases.legal_hold`); provision amounts pushed to NC-009 on approval; closure requires outcome & learnings.
- RTI: 30-day SLA (48 h life & liberty), fee capture, appeal timelines (30/90 days) enforced with reminders.
- Numbering: `LIC`, `CASE`, `NOTICE`, `RTI` per hospital/FY. Retention: licences permanent (history), cases 10 years post closure, RTI 5 years.

## 6. API Surface (`/api/v1/legal`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /catalogue ; PATCH /catalogue/{code} | licence catalogue | legal.catalogue.read / .manage | Y | – |
| GET/POST/PATCH | /licences ; GET /licences/{id} ; POST /licences/import ; POST /licences/{id}/(renew-start|renew-step|renew-complete|suspend|surrender) | licence register | legal.licence.read / .manage (owner for own) | Y | cursor |
| GET | /licences/status?scope=equipment&ref= (used by NC-020/OP-008/IP-007 hard-stop) | validity check | legal.licence.read (service) | – | – |
| GET/POST/PATCH | /obligations ; GET /tasks?due= ; POST /tasks/{id}/(complete|waive) | compliance calendar | legal.compliance.manage / .complete (owners) | Y | cursor |
| POST/GET/PATCH | /inspections ; POST /inspections/{id}/close | inspections | legal.inspection.manage | Y | cursor |
| POST/GET/PATCH | /notices ; POST /notices/{id}/(assign|draft|submit-approval|dispatch|close|escalate) | notices | legal.notice.manage / .approve | Y | cursor |
| POST/GET/PATCH | /cases ; POST /cases/{id}/(hearing|task|document|expense|hold|close) ; GET /cases/calendar | case log | legal.case.manage / .read (restricted) | Y | cursor |
| POST/GET | /record-requests | summons/record requests | legal.records.manage (with MRD) | Y | cursor |
| POST/GET/PATCH | /rti ; POST /rti/{id}/(assign|respond|appeal) | RTI | legal.rti.manage | Y | cursor |
| POST/GET | /opinions | opinion requests | legal.opinion.request / .manage | Y | cursor |
| GET | /dashboard ; /evidence-pack?authority=&chapter= ; /reports/(licence-status|expiry-calendar|compliance-score|inspections|notices|cases|exposure|rti) | analytics | legal.report.read | – | – |

## 7. Domain Events (outbox)
- `licence.registered|renewed|amended|suspended|surrendered` {licence_id, code, scope, valid_until} → NC-020/OP-008/IP-007/OP-003/NC-013/NC-025/NC-033 (status caches), NC-011.
- `licence.expiring` {licence_id, days_left} / `licence.expired` {licence_id, hard_stop} → EN-037 owner/admin escalation ladder; hard-stop consumers set equipment/service unavailable.
- `compliance.task.due|completed|missed|waived` → owners, dashboards, NC-015 (indicators).
- `legal.inspection.recorded|deficiency.raised|closed` → NC-015 CAPA, department owners.
- `legal.notice.received|responded|closed`, `legal.case.opened|hearing.scheduled|hearing.outcome|closed`, `legal.hold.placed|released` {system refs} → EN-024 retention engine, NC-003 MRD, NC-019 CCTV retention, NC-009 provisions/expenses, MS/Admin.
- `legal.rti.received|due_soon|responded` → PIO/department tasks.
- Consumes: `bme.aerb.licence.expiring|equipment.registered` (NC-020), `bloodbank.licence.*` (IP-007), `bmw.annual_report.due` (NC-016), `facility.fire_noc.*|lift.inspection.*` (NC-025), `grievance.escalated_legal` (NC-032), `mlc.court_summons.received` (TR-008), `hr.licence.expiring` (NC-010 credentialing → surfaced, not duplicated), `vendor.blacklisted` (NC-021), `contract.dispute.raised` (NC-031), `finance.statutory.due` (NC-009 mirrors GST/TDS), `privacy.breach.detected` (EN-024/EN-023 → 72 h DPB notification task).

## 8. Screens (UI)
- **Compliance Dashboard** (desktop; TV-friendly RAG board for admin office): licences by status (active/expiring/expired) per department/branch, upcoming 90-day expiry timeline, compliance calendar completion %, open inspections/notices, cases by type/exposure; drill-down.
- **Licence Register** (desktop): table with filters (authority, department, status, branch), licence detail drawer (documents, history, obligations, linked entities, renewal progress stepper); `N` new, `R` start renewal, `U` upload certificate.
- **Renewal Task** (desktop/mobile for owners): checklist steps with dates/files, authority contacts, escalation status.
- **Compliance Calendar** (desktop): month/agenda views, tasks with evidence upload; owner "My obligations" list (mobile).
- **Inspection & Notice Console**: forms, observation table with CAPA links, response drafting (NC-004 editor/attach), approvals, dispatch proof.
- **Case Management** (desktop, restricted): case list, case file (parties, hearings timeline, documents bundle with privilege flag, tasks, expenses, legal hold panel), hearing calendar (month view, next-hearing alerts), counsel directory; export bundle PDF.
- **RTI Desk** (public hospitals): register, timers, department info requests, appeals.
- **Evidence Pack Generator**: pick authority/NABH chapter → zip/PDF index.
- Empty/error states; WCAG 2.2 AA; i18n (state language forms links).

## 9. Integrations
- NC-004 documents/OCR (auto-read validity dates from scanned certificates via AI-003 later), NC-020 (AERB/PNDT), OP-008, IP-007, OP-003, NC-016, NC-025, NC-013, NC-033, NC-010 (credential expiries surfaced), NC-019, TR-008, NC-032, NC-021/NC-031, NC-009 (fees, penalties, provisions; statutory calendar), NC-015 (CAPA/accreditation dates), EN-024 (legal hold/retention), EN-028/DPO (DPDP), EN-038 approvals, EN-037/EN-032 notifications, EN-036 import; external portals (eLORA, PNDT state portals, SPCB OCMMS, e-Courts case status API/scraper for hearing dates (optional), RTI online portal) — reference links & manual entry, API where available via EN-017.

## 10. Reports & Analytics
- Licence status register (by department/branch/authority), expiry calendar (30/60/90/180 days), renewal cycle time & delays, compliance calendar adherence % by department, inspection deficiencies & closure ageing, notices register & penalties paid, legal case register (type, forum, stage, exposure, provision), hearing calendar, counsel spend & outcomes, legal hold register, RTI register & SLA compliance, DPDP breach/notification log (with EN-024), board compliance certificate pack, NABH evidence pack (relevant chapters). Read model `analytics.compliance_status`.

## 11. Notifications
- Owners: renewal start (lead), step reminders, expiring 60/30/15/7/1 days, obligation due T-7/T-1, missed; Admin/MS: expired licences (daily digest + immediate for hard-stop items), notices received, hearings tomorrow, high-exposure case updates; Finance: penalties/provisions; Department heads: inspection deficiencies; PIO: RTI timers; DPO: breach notification 72 h countdown; Counsel (email): hearing reminders/bundles.

## 12. Permissions (RBAC keys)
`legal.catalogue.read|manage`, `legal.licence.read|manage` (owners ABAC own licences; officer all), `legal.compliance.manage|complete`, `legal.inspection.manage`, `legal.notice.manage|approve`, `legal.case.read|manage` (restricted; named-user access lists), `legal.records.manage`, `legal.rti.manage`, `legal.opinion.request|manage`, `legal.hold.manage`, `legal.report.read`, `legal.export`. Defaults: Compliance/Legal officer all; Hospital Admin (2)/MS (4) read/approve; department owners (RSO 12/36, Blood bank 37, Pharmacy 32, Facility 49, HR 47, Canteen 53, Quality 54, IT 56/DPO 57) own-licence manage; Auditor (58) read.

## 13. Non-functional
- Volumes: 150–400 licences per branch, 2k obligations/year, 100 cases open, 50 notices/year; status API for hard-stops p95 < 50 ms (Redis cache invalidated on events); daily expiry job < 1 min.
- Security: restricted case confidentiality; documents encrypted; audit on all; RLS; PHI minimal.
- Offline: n/a; mobile task completion with photo evidence.
- Printing/exports: registers, evidence packs (PDF/zip), case bundles with index & page numbers; i18n; WCAG 2.2 AA.

## 14. Acceptance Criteria
1. Given the AERB licence for CT-1 valid till 30 Sep with lead 120 days, then on 2 Jun the licence turns `expiring`, RSO gets a renewal task with steps, and admin escalations occur at 60/30/7 days.
2. Given the AERB licence expires with no renewal recorded and hard-stop enabled, then NC-020 sets CT-1 out of service and OP-008 blocks scheduling; an RSO override in NC-020 with reason is audited.
3. Given a PNDT monthly Form F obligation due on the 5th, when not completed by the 5th, then it is `late`, owner & admin notified, and compliance % for radiology drops.
4. Given a fire inspection with 3 deficiencies, then 3 CAPA tasks with due dates are created (NC-015 links) and the inspection cannot close until all are completed.
5. Given a show-cause notice from SPCB with 15-day response, then the notice shows a countdown, the drafted response requires MS approval, and closure requires dispatch proof.
6. Given a consumer forum case linked to UHID X, then a legal hold is placed on the patient's records (NC-003) and related CCTV (NC-019); attempts to purge under retention are blocked until the hold is released.
7. Given a hearing on 12 Aug with outcome "adjourned to 20 Sep", then the next hearing auto-creates and counsel/legal get reminders T-3/T-1.
8. Given a user without `legal.case.read` for restricted cases, then case details are hidden (404-like) and access attempts audited.
9. Given an RTI received on 1 Jul, then due date 31 Jul appears; department information requests are tracked; response after due shows breach.
10. Given a renewed drug licence certificate uploaded with new validity, then status returns to `active`, history keeps the previous certificate, and OP-003 warning clears.
11. Given evidence pack generation for NABH FMS, then a PDF/zip with index of licences (fire, lift, DG, AERB, BMW…) and their certificates is produced.

## 15. Enhancements / Later phases
- From VIMS sheet: licence tracker, AERB/PCB/Fire, legal case log, audit trail (Phase 9 core above).
- (market) OCR/AI extraction of certificate dates & numbers (AI-003), e-Courts API for automatic hearing updates, integration with government portals (eLORA, OCMMS, PNDT), contract lifecycle legal review integration (NC-031), policy management & attestation (NC-004), regulatory-change feed & impact assessment, board compliance certificate automation, DPDP DSAR/consent audit workflows (with EN-024/EN-028), insurance policy & claims tracker (with NC-002), group-level compliance heat map (EN-041), litigation cost prediction.

## 16. Open Questions for the Hospital
1. Full list of current licences/registrations per branch with numbers, validity and owners (for import); state-specific acts (nursing home act, fire rules)?
2. Public/government hospital (RTI applicable) or private/trust; CVC/vigilance requirements?
3. Which licences should trigger operational hard-stops on expiry, and who may override?
4. Legal team structure (in-house/company secretary/empanelled counsel), confidentiality expectations, case volume?
5. Compliance obligations calendar (filings/returns) & owners; existing tracker format?
6. DPO appointed? DPDP breach process owners? Insurance policies to track?
7. Preferred evidence-pack formats for NABH/board?

