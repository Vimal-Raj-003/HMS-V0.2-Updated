# NC-003 — Digital MRD (Record Lifecycle, ICD Coding, Scan/OCR, Deficiency, Retrieval, Retention, Medico-Legal, ROI, ABDM Export)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-003 |
| Phase | 2 (basics: record shell, scan/upload, retrieval) / 9 (coding QA, deficiency engine, retention, ROI, analytics) |
| Priority | P1 |
| Complexity | Medium |
| Depends on | OP-001 (patient MPI/UHID, merges), OP-002 (consult notes, diagnoses), IP-001/IP-002 (admission, discharge summary — primary coding trigger), IP-003/IP-006/IP-009 (nursing, OT, ICU records), OP-004/OP-008 (reports), TR-008 (MLC/forensic — medico-legal flag source), EN-027 (ICD-10/ICD-11/SNOMED/procedure code masters), EN-028 (consent forms, DPDP consent ledger), EN-011 (ABDM M2 HIP record export, FHIR bundles), EN-019 (FHIR), EN-016 (e-sign), EN-013 (file barcodes), EN-039 (forms), EN-024 (audit/READ_PHI), NC-004 (DMS engine for non-patient docs; MRD uses same storage/OCR services), NC-015 (medical record audit indicators), AI-006 (coding assist, later), AI-003 (doc extraction, later), PE-001 (patient record requests), EN-002/RC-001 (claim document packs), NC-011 |
| Feature flag | `module.mrd.enabled` (sub: `mrd.physical_file_tracking`, `mrd.drg_grouping`, `mrd.roi_portal`, `mrd.ocr`) |
| Primary roles | MRD Officer / Coder (43), MRD In-charge, Scanning operator (MRD staff) |
| Secondary roles | Doctors (7/6, deficiency completion, sign), Nurses (17), Medical Superintendent (4, ML approvals, statistics), Quality (54, record audit), Insurance desk (28, document packs), Legal (NC-023), Privacy Officer/DPO (57, ROI approvals), Auditor (58), Patient (59, ROI requests via PE-001) |
| Regulatory | NMC (erstwhile MCI) Code of Ethics Reg 1.3.1 (IP records ≥ 3 yrs; NABH/practice → 7 yrs adults; minors till 18 + 7; medico-legal indefinite/till case closure), Clinical Establishments Act & state rules (record maintenance), NABH 6th ed. IMS (Information Management System) & PRE (access to records within 72 h; MRD statistics; ICD coding), DPDP Act 2023/Rules 2025 (patient right to access/erasure limits for legal retention; consent for disclosure), IT Act §7/§65B (electronic records evidentiary), Indian Evidence Act/BSA 2023 §63 electronic record certificate, ABDM HIP/HIU (FHIR R4 record export, consent artefacts), ICD-10 (WHO) / ICD-11 transition, MoHFW ICD coding guidelines, Birth & Death registration (MCCD Form 4/4A ICD-coded cause), IRDAI/TPA document requirements, Court/police summons handling (TR-008), NABH RCA/incident linkages |

## 1. Purpose
NC-003 turns every patient encounter into a complete, coded, retention-managed **medical record**: it auto-assembles the digital file from all clinical modules, tracks completeness (deficiency checks with doctor/nurse tasks), runs the ICD-10/ICD-11 & procedure **coding queue** with quality review and DRG grouping, scans/OCRs paper documents into the record, controls every disclosure (release of information with consent/legal basis, audit of every access), tracks physical file movement, enforces retention/archival/destruction rules, protects medico-legal records, and exports records to ABDM/FHIR and portals. It is the hospital's legal custodian layer over the append-only clinical store.

## 2. Users & Jobs-to-be-done
- **MRD coder** (desktop, dual monitor): work the coding queue (discharges, day-care, deaths, OP procedures), review discharge summary/op notes, assign/verify ICD-10 principal & secondary diagnoses, external causes, procedure codes (ICD-10-PCS/ICHI or hospital procedure master), DRG (if enabled), flag documentation queries to doctors; ~60–120 records/day per coder.
- **MRD officer** (desktop + scanner + barcode): assemble/close records post-discharge, run deficiency checks, chase incomplete records (72 h/7 d/30 d), scan paper (consents, external reports, ICU charts) with OCR & tagging, handle retrieval/ROI requests (insurance, legal, patient, research), physical file issue/return, retention & destruction runs, MRD statistics.
- **Doctor/nurse** (desktop/phone): receive deficiency tasks (unsigned notes, missing discharge summary, missing op note, cause of death), complete & sign; answer coding queries.
- **Medical Superintendent / MRD committee**: approve medico-legal record actions, destruction lists, ROI for legal/police, monthly MRD statistics (admissions, deaths, MLC, disease index).
- **Insurance desk / legal**: request certified copies/document packs.
- **Privacy officer/DPO**: approve sensitive disclosures, review PHI access reports, DSAR from patients (DPDP).
- **Patient**: request copies via portal (PE-001) with OTP/consent; receive within NABH 72 h target.

## 3. Core Workflows

### 3.1 Record lifecycle (auto-assembly)
1. Event `patient.registered`/`visit.created`/`admission.created` → **System** creates/opens `mrd_records` per encounter (OP visit record light; IP/day-care/ER/MLC full) under the patient's master file (UHID-level folder) with MRD number (`MRD` series per branch/FY optional; UHID remains key) → all clinical documents (OP-002 notes, orders, results OP-004/OP-008, IP-003 nursing, IP-006 OT, IP-009 ICU, IP-002 discharge summary, consents EN-028, TR-008 MLC docs, bills OP-005/IP-005 links) attach automatically by `encounter_id` (references to `clinical.documents` versions — MRD never copies) → **record index** (table of contents by section, chronological) → status `open`.
2. On `admission.discharged`/`visit.completed` → status `pending_completion` → deficiency check (3.2) → when complete & coded → `closed` (locked, hash of index; new documents allowed only as "late entry/addendum" with reason & audit) → archived per retention (3.7).
3. Patient merge (OP-001 `patient.merged`) → records re-pointed, MRD numbers retained, merge note in index; unmerge supported by audit trail.

### 3.2 Deficiency check (completeness)
1. Rule set per encounter type (config, seeded with NABH/MCI expectations): admission note within 24 h, consent for procedures, pre-anaesthesia check, op note within 24 h of surgery, daily progress notes, nursing assessment, MAR complete, discharge summary within 24 h of discharge (NABH), death certificate & MCCD cause-of-death for deaths, MLC form for MLC, signatures/co-signs (resident notes co-signed), ICD coded, referral/transfer notes, DAMA form → **System** evaluates on status change and nightly → creates `mrd_deficiencies` (type, responsible user/role, due) → tasks in doctor/nurse inbox (EN-037), escalation ladder 3 d → HOD, 7 d → MS, 30 d → delinquency list (privilege hold flag configurable) → completion re-evaluated automatically → Event `mrd.deficiency.raised|resolved`.
2. **Qualitative audit** (Quality/MRD reviewer): sampled records scored against checklist (legibility N/A, completeness, timeliness, abbreviations, signatures) → NC-015 indicator "medical record completeness %".

### 3.3 ICD coding queue & quality
1. Queue populated on discharge/death/day-care/ER MLC/OP procedures (config) → prioritised (insurance claims pending EN-002, deaths, MLC, LOS) → **Coder** opens record: left pane documents (discharge summary, op notes, path reports), right pane coding form: **principal diagnosis** (ICD-10 code with search by term/SNOMED map/EN-027 master, ICD-11 dual coding optional), secondary diagnoses/comorbidities, complications, external cause (V–Y codes) & place of occurrence for injuries (trauma centre), morphology for neoplasms, procedures (ICD-10-PCS/ICHI/hospital procedure master with laterality/date/surgeon), MCCD underlying cause for deaths, POA (present on admission) flags, injury severity link (TR-001 ISS read-only) → validation (age/sex conflicts, unacceptable principal codes, dagger/asterisk pairs, E-code required for injury S/T codes, manifestation codes not principal, ICD version effective date) → save → **DRG grouping** (`mrd.drg_grouping`: pluggable grouper — IR-DRG/AR-DRG/custom PMJAY package mapper) → coding status `coded` → **QA sampling** (10 % or rules: high-value, deaths, DRG outliers) by senior coder → agree/disagree with correction → accuracy % → Event `mrd.record.coded`.
2. **Coding query** to doctor (specificity/conflict/missing documentation) → doctor answers/amends summary (new version) → coder finalises. Doctor-entered diagnoses (OP-002/IP-002) are pre-filled as suggestions, never final without coder review for IP (OP visits may auto-accept doctor's ICD when configured).
3. AI assist (AI-006, later): suggested codes with evidence highlights; coder confirms.

### 3.4 Scan & upload (paper to digital) (`mrd.ocr`)
1. **Scanning operator** at scan station (TWAIN/scanner-to-folder watch or web upload) → batch with cover sheet barcode (UHID/encounter/section) or manual select → **System** splits by separator sheets, deskews, OCR (Tesseract/cloud OCR via worker; multilingual en/hi/regional) → auto-classification suggestion (consent/insurance/external report/referral letter/old records/ICU chart/police intimation/other) → operator tags category, document date, source, pages, MLC/sensitive flag → QA (second look for legibility) → stored in S3 (encrypted, `clinical.documents` type `scanned`, sha256) → attached to record section → full-text index (Postgres FTS + trigram; optional OpenSearch) → Event `mrd.document.scanned`.
2. Rejections: blurry/incomplete → rescan task; duplicates detected by hash; wrong-patient correction (move with reason, audited, original placement recorded).
3. External documents by patient portal upload (PE-001) land in "unverified inbox" until MRD accepts.

### 3.5 Retrieval, physical file tracking & ROI (release of information)
1. **Internal retrieval** (doctor viewing chart) is EN-024 audited (`READ_PHI`) — break-glass outside care team.
2. **Request-based retrieval/ROI**: request from doctor (research/M&M), insurance/TPA (claim), legal (court/police via TR-008), patient/relative (portal/counter), other hospital (transfer/ABDM), employer/corporate (with consent) → `mrd_requests` (requester, purpose, documents/sections, format: view/print/certified copy/PDF/FHIR bundle, urgency) → **legal basis check**: patient consent (EN-028 template "Authorisation for release", OTP e-sign for portal) or statutory (court order/police requisition ref, DPDP legitimate use) → approver by rule (MRD in-charge; MS/DPO for MLC/sensitive (HIV, psychiatry, sexual assault) categories) → fulfilment: PDF pack with watermark ("Released to X on date, request no."), page numbering, certified copy stamp & e-sign (EN-016), §65B/BSA §63 certificate template for legal, delivery (portal/secure link expiring/print at counter with ID verification/email to insurer) → fee (if applicable) via OP-005 misc bill → `mrd_disclosure_log` (what, whom, when, basis) → SLA: patient copies within 72 h (NABH), insurance packs 24 h → Event `mrd.record.released`.
3. **Physical file tracking** (`mrd.physical_file_tracking`; hybrid hospitals): file barcodes; issue to ward/OPD/doctor with due date; movement log (location, holder, time); overdue reminders; return & shelf location (rack/bay/box); missing file escalation.

### 3.6 Medico-legal flag & protection
1. Sources: TR-008 (MLC register), death under investigation, complaints/legal notices (NC-023/NC-032), police requisition → record `is_medico_legal=true`, `ml_reason`, `legal_hold_until` → **System** enforces: no destruction while flagged; any addendum/version creation requires **dual approval** (author + MS/MRD in-charge) with reason; ROI only via legal route; access alerts (every open logged and reported daily to MS/DPO); export watermark "MEDICO-LEGAL". Removal of flag needs MS approval and case-closure reference → Event `mrd.record.legal_hold.set|released`.

### 3.7 Retention, archival & destruction
1. Policy engine (config, seeded): OP adult 3 yrs (min) → hospital policy 5–7 yrs; IP adult 7 yrs from last discharge; minors until 18 + 7 (or 25th birthday whichever later, config); death records 7 yrs; MLC/legal-hold indefinite until release; mental health (MHCA 2017) per rules; research consented data per protocol; scanned originals retention same as record; billing docs 8 yrs (GST) — all as `mrd_retention_policies` (record_type, condition, duration, action) → nightly job flags records approaching retention end (90 days) → review list → **archive** (move to cold storage tier, S3 Glacier/on-prem archive bucket, still retrievable with delay) → **destruction proposal** (never auto): list → MRD committee/MS approval (dual) → destruction certificate (what, method, witnesses) → data erased/crypto-shredded (keys destroyed) except index stub & disclosure log retained → Event `mrd.record.destroyed`. Legal hold or open litigation blocks destruction; DPDP erasure requests honoured only beyond statutory retention (else refused with reason recorded).

### 3.8 ABDM / interoperability export
1. HIP data push (EN-011): on consent artefact fetch, MRD builds FHIR R4 bundles per ABDM HI types (OPConsultation, Prescription, DiagnosticReport, DischargeSummary, ImmunizationRecord, HealthDocumentRecord (scanned PDFs), WellnessRecord) from record sections → EN-011 encrypts/transmits; export log entry in disclosure log (basis: ABDM consent) ; patient "scan & share"/portal PDF; inter-hospital sharing (VIMS enhancement) via ABDM HIU/FHIR or secure link with consent.

### 3.9 MRD statistics & MCCD
- Monthly MRD statistics: admissions/discharges/deaths (gross/net death rate, < 48 h/> 48 h), MLC count, autopsy rate, bed occupancy, ALOS, top ICD groups (disease index), operations index, coding turnaround, record completion rate; MCCD Form 4/4A generated from death record with ICD-coded underlying cause (IP-017 death certificate feed; state CRS export); NRHM/HMIS morbidity formats via NC-011.

### 3.10 Research & de-identified data requests
- Research/academic requests (IEC/IRB approval no. mandatory) → dataset spec → de-identification (remove direct identifiers, date shifting, age bands per DPDP/ICMR guidelines) → export via NC-011 with approval by MRD committee/DPO → disclosure log entry (basis `research_consent/ethics_approval`).

### 3.11 Exceptions & edge cases
1. Doctor leaves the hospital with pending deficiencies → tasks reassigned to HOD; F&F hold flag to NC-010 (config).
2. Discharge summary amended after coding → coding re-review task; if claim submitted → EN-002 informed.
3. Record for a merged patient with two MRD numbers → both retained as aliases; searches resolve either.
4. Scan of a document belonging to an old paper era (pre-HMS) → "legacy record" shell per encounter date range with minimal metadata; retention computed from document dates.
5. Court summons for original paper record → physical file issue with legal custody chain (TR-008), certified copy retained.
6. Patient deceased — ROI to legal heir requires death certificate + heirship/relationship proof; disputes → MS/legal.
7. Retention hold conflicts (record due for destruction but patient re-visits) → last-visit resets retention start (policy `from=last_visit`).
8. Bulk export requests (insurer audits) → rate-limited, batched, DPO-approved template.

### 3.12 Configuration defaults (seed)
- Retention: OP 5 yrs, IP 7 yrs from discharge, minors till 25th birthday, deaths 7 yrs, MLC indefinite; ROI SLA 72 h (patient)/24 h (insurer); QA sample 10 %; deficiency rules seeded (admission note 24 h, op note 24 h, discharge summary 24 h, consent before procedure, MCCD for deaths, MLC form for MLC, co-sign for residents); escalation 3/7/30 days; scan 300 dpi PDF/A; secure link 72 h/3 downloads; series `MRD`, `MRD_REQ`, `MRD_CERT`.

## 4. Data Model (schema `clinical`, prefix `mrd_`)
- **mrd_records**: id, hospital_id, branch_id, patient_id, mrd_no?, encounter_type enum(op/ip/daycare/er/mlc_op/dialysis/chemo/other), encounter_id (visit/admission), opened_at, closed_at, status enum(open/pending_completion/deficient/complete/closed/archived/destroyed), completeness_pct, is_medico_legal bool, ml_reason, ml_source_ref (TR-008 mlc_id/case id), legal_hold_until, sensitivity enum(normal/restricted) (HIV/psychiatry/SA per policy), retention_policy_id, retention_until date, archived_at, archive_tier, destroyed_at, destruction_cert_id, index_hash sha256, physical_file_id?, coding_status enum(not_required/pending/in_progress/queried/coded/qa_passed/qa_failed), coded_by, coded_at, drg_code, drg_version, version. UNIQUE (encounter_type, encounter_id); INDEX (hospital_id, status), (patient_id), (retention_until), (coding_status, opened_at).
- **mrd_record_sections**: record_id, section enum(admission/consents/history_exam/progress_notes/orders/nursing/mar/ot/anaesthesia/icu/lab/radiology/discharge/death/mlc/billing/scanned/correspondence/other), sort_order; **mrd_record_documents**: record_id, section, document_id (clinical.documents), document_version, added_at, added_by, source enum(auto/scan/upload/late_entry), late_entry_reason, moved_from_record_id?.
- **mrd_deficiency_rules**: id, hospital_id, encounter_type, code, description, check_type enum(document_exists/document_signed/within_hours_of/field_present/coded), params jsonb, responsible_role, due_hours, escalation jsonb, active.
- **mrd_deficiencies**: id, hospital_id, record_id, rule_id, responsible_user_id?, responsible_role, raised_at, due_at, status enum(open/escalated/resolved/waived), resolved_at, resolved_by, waived_reason, escalation_level. INDEX (responsible_user_id, status).
- **mrd_coding**: id, record_id, version, principal_dx_code, principal_dx_system enum(icd10/icd11), poa_principal, secondary_dx jsonb [{code, system, poa, type enum(comorbidity/complication)}], external_cause_codes text[], place_of_occurrence, morphology_codes text[], procedures jsonb [{code, system, date, surgeon_id, laterality}], mccd jsonb {immediate, antecedent[], underlying, other_significant, manner}, drg_code, drg_weight, coded_by, coded_at, source enum(coder/doctor_prefill/ai_suggested), status, notes. History kept by version.
- **mrd_coding_queries**: coding_id, to_user_id, question, asked_at, answered_at, answer, resulted_in_amendment bool.
- **mrd_coding_qa**: coding_id, reviewer_id, sampled_reason, agree bool, corrections jsonb, score, reviewed_at.
- **mrd_scan_batches**: id, hospital_id, branch_id, station_id, operator_id, started_at, pages, status enum(uploaded/processing/tagging/qa/completed/rejected); **mrd_scan_documents**: batch_id, record_id?, patient_id?, category enum(consent/insurance/external_report/referral/old_record/icu_chart/police/discharge_paper/other), document_date, source, pages, file_id, ocr_text_file_id, ocr_confidence, classification_suggested, tagged_by, qa_by, status, sha256 UNIQUE per hospital (dup detect), fts tsvector (GIN).
- **mrd_requests** (retrieval/ROI): id, hospital_id, branch_id, request_no, requester_type enum(doctor/insurance/legal/police/patient/relative/other_hospital/corporate/research/internal_audit), requester_id?/name/contact, patient_id, record_ids uuid[], sections/document filters jsonb, purpose, format enum(view/print/certified_copy/pdf/fhir_bundle/physical_file), urgency, legal_basis enum(patient_consent/court_order/police_requisition/statutory/abdm_consent/internal_care/legitimate_use), basis_ref (consent_id/order no.), status enum(submitted/awaiting_consent/awaiting_approval/approved/rejected/fulfilled/delivered/closed), approved_by, approved_at, sla_due_at, fulfilled_at, delivered_via, delivery_ref, fee_bill_id?, rejection_reason.
- **mrd_disclosure_log** (append-only): id, hospital_id, patient_id, record_id, request_id?, disclosed_to, purpose, basis, documents jsonb, format, disclosed_by, disclosed_at, watermark_text, certificate_no?, hash. INDEX (patient_id, disclosed_at).
- **mrd_physical_files**: id, hospital_id, branch_id, patient_id, record_id?, file_barcode, shelf_location (rack/bay/box), status enum(in_shelf/issued/in_transit/missing/archived/destroyed); **mrd_file_movements**: file_id, from_location, to_location/holder_user_id, purpose, issued_at, due_at, returned_at, issued_by, received_by, status.
- **mrd_retention_policies**: id, hospital_id, record_type/encounter_type, condition jsonb (age_at_encounter<18, is_death, is_ml, sensitivity), retain_years, from enum(closure/last_visit/age18), action enum(review/archive/destroy), active; **mrd_destruction_runs**: id, hospital_id, proposed_at, record_ids[], approved_by[] (2), certificate_file_id, method enum(crypto_shred/delete/physical_shred), executed_at, executed_by, status.
- **mrd_statistics_monthly** (analytics): branch, month, admissions, discharges, deaths, deaths_lt48h, mlc, autopsies, alos, occupancy, records_completed_pct, coding_tat_hrs, coding_accuracy_pct, top_icd jsonb.
- RLS everywhere; records/coding/disclosure logs never hard-deleted (destruction leaves stub); `mrd_disclosure_log` append-only (trigger blocks UPDATE/DELETE).

## 5. Business Rules & Validations
- One record per encounter; all documents referenced by version — MRD closure freezes the index (hash) and later additions are `late_entry` with reason, visible as such.
- Deficiency rules evaluated on events + nightly; discharge summary due ≤ 24 h post discharge (NABH); death records must have MCCD before closure; MLC records must have TR-008 linkage.
- Coding: principal diagnosis mandatory for IP/day-care/death; injury codes (S00–T88) require external cause (V01–Y98) and place; codes validated against EN-027 ICD version effective at encounter date; ICD-11 dual coding stored separately; QA sample ≥ 10 % (config); coder ≠ QA reviewer; recoding after claim submission creates version and notifies EN-002.
- Scan: min 200 dpi (300 for legal), PDF/A output, sha256 dedupe, OCR confidence < 60 % flags QA; wrong-patient move retains provenance; scanned consents must carry consent form template id when recognisable.
- ROI: legal basis mandatory; consent template & identity verification for patient/relative (relationship proof for deceased NOK); sensitive categories need DPO/MS approval; every release watermarked and logged; secure links expire (default 72 h, max 3 downloads); certified copies numbered (`MRD_CERT` gapless); SLA 72 h patient / 24 h insurance (config); refusal reasons recorded (DPDP).
- Medico-legal: no destruction; addenda dual approval; access report daily; flag removal needs MS + case ref.
- Retention: computed on closure (and recomputed if minor/ML flags change); destruction only via approved run with two approvers; index stub, disclosure log & destruction certificate retained permanently; DPDP erasure requests evaluated against statutory retention.
- Physical files: barcode unique; overdue issue > 7 days reminder, > 30 days escalation; file cannot be marked destroyed unless linked digital record archived/destroyed per policy.
- READ_PHI audit for every record open outside care team; exports need `mrd.record.export` and are audited.

## 6. API Surface (`/api/v1/mrd`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /records?patient=&status=&type=&coding_status=&from=&to= | list | mrd.record.list | – | cursor |
| GET | /records/{id} | record index (sections, documents, deficiencies, coding, holds) | mrd.record.read (READ_PHI audited) | – | – |
| POST | /records/{id}/close, /reopen (late-entry mode), /late-entry | lifecycle | mrd.record.close / .reopen | Y | – |
| GET | /deficiencies?assignee=me&status= ; POST /deficiencies/{id}/(resolve|waive|escalate) | deficiency tasks | mrd.deficiency.read / .resolve / .waive | Y | cursor |
| GET/PUT | /deficiency-rules | config | mrd.configure | Y | – |
| GET | /coding/queue?priority=&assigned= ; POST /coding/{recordId}/assign | queue | mrd.coding.list / .assign | Y | cursor |
| POST/PUT | /coding/{recordId} | save coding (versioned) | mrd.coding.code | Y | – |
| POST | /coding/{recordId}/validate, /group (DRG), /queries, /queries/{id}/answer, /qa | coding ops | mrd.coding.code / mrd.coding.qa / (doctor) mrd.coding.query.answer | Y | – |
| GET | /icd/search?q=&system=&asOf= (proxy EN-027) | code search | mrd.coding.code | – | – |
| POST | /scan/batches, /scan/batches/{id}/upload, /scan/documents/{id}/tag, /qa, /move | scanning | mrd.scan.operate / mrd.scan.qa | Y | cursor |
| GET | /search?q=&type=&from=&to= | full-text (OCR + metadata) | mrd.search | – | cursor |
| POST | /requests ; GET /requests?status= ; POST /requests/{id}/(approve|reject|fulfil|deliver) | ROI | mrd.request.create / .approve / .fulfil | Y | cursor |
| POST | /records/{id}/export?format=pdf|fhir | export (watermarked) | mrd.record.export | Y | – |
| GET | /disclosures?patient= | disclosure log | mrd.disclosure.read | – | cursor |
| POST | /records/{id}/legal-hold, DELETE /records/{id}/legal-hold | ML flag | mrd.legal_hold.set / .release (MS) | Y | – |
| GET/POST | /files, /files/{id}/issue, /return, /movements | physical files | mrd.file.manage | Y | cursor |
| GET/PUT | /retention/policies ; GET /retention/due ; POST /retention/archive, /retention/destruction-runs, /destruction-runs/{id}/approve, /execute | retention | mrd.retention.manage / mrd.destruction.approve | Y | cursor |
| GET | /statistics?month= ; /reports/coding-accuracy, /completion, /retrieval-log, /retention-compliance | reports | mrd.report.read | – | – |
| POST | /mccd/{recordId} ; GET /mccd/{recordId}/pdf | cause of death form | mrd.mccd.manage | Y | – |
| GET | /abdm/bundle/{recordId}?hiType= (internal for EN-011) | FHIR export | integration.abdm.export | – | – |

## 7. Domain Events (outbox)
- `mrd.record.opened|closed|reopened` {record_id, encounter} → NC-011, EN-011 (closed → HI available), NC-015.
- `mrd.deficiency.raised|escalated|resolved` {record_id, rule, assignee} → EN-037 tasks, HOD/MS dashboards, NC-015 indicator.
- `mrd.record.coded` {record_id, principal_dx, secondary[], procedures[], drg} → EN-002/RC-001 (claims), NC-011 disease index, TR-011 registry, AI-006 feedback loop, IP-002 (summary codes sync).
- `mrd.coding.query.raised|answered` → doctor inbox.
- `mrd.document.scanned` {document_id, record_id, category} → clinical timeline (OP-002), EN-002 (insurance docs), PE-001 (if patient-visible).
- `mrd.request.created|approved|fulfilled` / `mrd.record.released` {request_id, basis, to} → EN-037, DPO report, PE-001 status, OP-005 (fee).
- `mrd.record.legal_hold.set|released` → EN-024 alerts, TR-008, NC-023.
- `mrd.record.archived|destroyed` {record_id, cert} → EN-024, storage lifecycle worker.
- `mrd.file.issued|returned|overdue|missing` → ward/doctor notifications.
- Consumes: `patient.registered|merged`, `visit.created|completed`, `admission.created|discharged`, `patient.died` (IP-017), `mlc.registered|closed` (TR-008), `document.signed|amended` (clinical), `consent.granted|revoked` (EN-028), `abdm.consent.received` (EN-011), `claim.documents.requested` (EN-002), `complaint.legal_notice` (NC-032/NC-023).

## 8. Screens (UI)
- **MRD dashboard** — desktop: pending completion count by ward/doctor, coding backlog & TAT, ROI SLA, scan queue, files overdue, retention due; realtime counters.
- **Record viewer** — desktop (dual-pane): section tree, document viewer (PDF/images/structured notes), timeline, deficiency panel, coding panel, holds & disclosures; `J/K` navigate docs, `C` open coding, `D` deficiencies, `Ctrl+E` export (permission); READ_PHI banner when outside care team.
- **Coding workbench** — desktop: queue (priority, LOS, payer), record docs left, coding form right with ICD search (type-ahead, code hierarchy, favourites, SNOMED→ICD map), validation messages, DRG result, query composer; shortcuts `Alt+P` principal, `Alt+S` add secondary, `Alt+E` external cause, `Alt+Q` query, `Ctrl+Enter` finalise; keyboard-only operation.
- **Deficiency inbox** (doctor/nurse) — desktop/phone: my incomplete records with due & escalation, one-click open document editor to complete/sign.
- **Scan station** — desktop: batch import (folder watch/upload/TWAIN via local agent), thumbnail split/merge/rotate, auto-classify suggestions, tagging form, QA; barcode cover-sheet printing.
- **ROI request desk** — desktop: request form, consent capture (EN-028 e-sign/OTP), approval routing, pack builder (select docs, watermark preview), delivery, fee; SLA timers.
- **Physical file tracker** — desktop + handheld: issue/return by scan, shelf map, overdue list.
- **Retention console** — desktop: due lists, archive/destroy proposals, approvals, certificates.
- **Statistics & MCCD** — desktop: monthly stats, MCCD form 4/4A editor & print.
- Empty/error states explicit; offline: scan station queues uploads; deficiency inbox read-only offline.

## 9. Integrations
- Storage: S3/MinIO with SSE, lifecycle to cold tier; OCR worker (Tesseract; optional cloud OCR) via BullMQ; scanner agent (TWAIN/SANE local service posting to API) or folder watch.
- EN-027 code masters (ICD-10 WHO 2019, ICD-11 MMS, SNOMED CT (India licence), procedure master), DRG grouper adapter (pluggable; PMJAY HBP mapper).
- EN-011 ABDM HIP (FHIR bundles per HI type), EN-019 FHIR DocumentReference/Bundle, EN-016 e-sign for certified copies, EN-028 consent, EN-013 barcodes, EN-009/EN-032 delivery, PE-001 patient requests/uploads, EN-002/RC-001 claim packs, TR-008 legal, IP-017 death → MCCD, state CRS export (CSV/API), NC-004 shared OCR/full-text services, AI-006/AI-003 later.

## 10. Reports & Analytics
- Record completion within 24 h/72 h/7 d (%), delinquent doctors list, deficiency by type, coding TAT & backlog, coding accuracy (QA), DRG mix/case-mix index, disease index (ICD chapter/block), operations index, mortality statistics (gross/net, < 48 h), MLC statistics, ROI SLA compliance & disclosure register, physical file movement/overdue/missing, retention compliance (due/archived/destroyed), PHI access audit summary (with EN-024), scan productivity (pages/operator), NRHM/HMIS morbidity formats (via NC-011).
- Read models: `analytics.mrd_completion_daily`, `analytics.mrd_coding_daily`, `analytics.disease_index_monthly`, `analytics.mrd_disclosures_monthly`.

## 11. Notifications
- Doctor/nurse: deficiency task (in-app/push), escalation copies to HOD/MS (email digest), coding query (push).
- MRD: new discharge in queue, ROI request awaiting approval, SLA nearing (72 h), scan QA rejects, file overdue.
- Patient (EN-009/PE-001 templates): request received, ready for pickup/download (secure link), fee due.
- DPO/MS: sensitive disclosure approvals, ML record access daily report, destruction approvals.

## 12. Permissions (RBAC keys)
`mrd.record.list/read/close/reopen/export`, `mrd.deficiency.read/resolve/waive`, `mrd.coding.list/assign/code/qa`, `mrd.coding.query.answer` (doctors), `mrd.scan.operate/qa`, `mrd.search`, `mrd.request.create/approve/fulfil`, `mrd.disclosure.read`, `mrd.legal_hold.set/release` (MS/MRD in-charge), `mrd.file.manage`, `mrd.retention.manage`, `mrd.destruction.approve` (two distinct approvers), `mrd.mccd.manage`, `mrd.report.read`, `mrd.configure`. ABAC: `care_team_only` on record.read for clinicians (break-glass otherwise), `sensitivity=restricted` requires elevated permission, `own_department_only` for HOD views. Patients: `mrd.request.create` scope self via PE-001.

## 13. Non-functional
- Volumes: 5,000 OP visits/day + 400 discharges/day + 30 deaths/day → 5.5k records/day; coding 500/day; scanning 20k pages/day; ROI 150 requests/day; documents 50M+ pages over retention → object storage with cold tiering; FTS index on OCR text (partitioned by year).
- Coding workbench: ICD search p95 < 100 ms (Redis + trigram); record index load < 500 ms for 1,000-document IP record (paginated sections).
- Offline: scan station queue; deficiency inbox cached read-only.
- Printing: certified copy packs (Playwright PDF, watermark, page X of Y, QR verify), MCCD forms, cover sheets/barcodes.
- Security: PHI encrypted at rest; presigned URLs short-lived; watermarking; export rate limits; append-only disclosure log; SoD coder ≠ QA, approver ≠ requester.
- i18n: OCR languages; ROI templates multilingual; WCAG 2.2 AA.

## 14. Acceptance Criteria
1. Given an IP admission, when created, then an MRD record opens automatically and all subsequent signed documents appear in the record index without copy.
2. Given discharge at 10:00 and no discharge summary by next day 10:00, then a deficiency task is assigned to the treating consultant; unresolved for 3 days escalates to HOD with audit.
3. Given a coder assigns principal S72.0 without external cause, when saving, then validation blocks with "external cause (V01–Y98) required for injury".
4. Given a coder codes a record, when QA sample selects it and reviewer disagrees, then a correction version is created, accuracy metric updated, and coder notified; reviewer cannot be the coder.
5. Given a claim already submitted, when coding is amended, then EN-002 receives `mrd.record.coded` with version increment.
6. Given a scanned batch with a barcode cover sheet, then pages are split, OCR text is searchable within 5 minutes, and a duplicate upload of the same PDF is rejected by hash.
7. Given a scanned document tagged to the wrong patient, when moved, then provenance shows original placement, both records log the move, and the document is removed from the wrong record view.
8. Given a patient portal request for discharge summary with OTP consent, then the request is fulfilled with a watermarked PDF via expiring link within SLA and the disclosure log records it.
9. Given a police requisition for an MLC record without court order/requisition reference, then approval cannot proceed; with reference and MS approval, a certified copy with §63 BSA certificate is issued and logged.
10. Given a record flagged medico-legal, when a doctor attempts an addendum, then it requires second approval; when retention job runs, the record is excluded from destruction proposals.
11. Given a minor (age 10 at encounter), then retention_until = 18th birthday + 7 years per policy, and appears in due list only then.
12. Given a destruction run approved by two authorised users, when executed, then documents are crypto-shredded, index stub and destruction certificate remain, and event emitted; with one approver, execution is refused.
13. Given a physical file issued to Ward 5 with due 7 days, when overdue, then reminder to holder and MRD; scanning barcode on return updates status and shelf.
14. Given a clinician outside care team opens a closed record, then a break-glass reason is required and a `READ_PHI` audit entry appears in the DPO daily report.
15. Given a death record, then closure is blocked until MCCD underlying cause is ICD-coded and death certificate exists.
16. Given ABDM consent for DischargeSummary, then EN-011 obtains a FHIR bundle from the record and the disclosure log shows basis `abdm_consent`.
17. Given a research request without an IEC approval number, then it cannot be approved; with approval and DPO sign-off, the de-identified export excludes direct identifiers and shifts dates.
18. Given a discharge summary amended after coding, then a coding re-review task is created and the coding version increments upon re-finalisation.
19. Given a legal heir requests a deceased patient's record without a death certificate/relationship proof, then the request stays `awaiting_consent` with the missing documents listed.

## 15. Enhancements / Later phases
- From VIMS sheet: AI auto-coding from discharge summaries (AI-006, Phase 12); NLP clinical data extraction for research (AI-003/AI-008, de-identified datasets); HIPAA/DISHA(now DPDP) compliance checker (Phase 11: automated PHI access anomaly rules, consent coverage audit); inter-hospital record sharing (ABDM HIU/FHIR, Phase 11); patient portal record access request (PE-001, Phase 10 — ROI portal flag).
- (market) File movement automation with barcode (in `mrd.physical_file_tracking`); permanent non-editable note closure with time stamps (core append-only); DRG/case-mix analytics; e-signature certified copies (EN-016); auto-generated legal-request packs; research registry export with de-identification; voice-to-text summaries feed (AI-004).

## 16. Open Questions for the Hospital
1. Retention periods adopted (OP/IP/minor/death/MLC) and archive location (cloud cold tier vs on-prem)? Existing paper archive size to digitise?
2. Which encounters are coded (IP only, or day-care/ER/OP procedures)? Coder headcount and target TAT? DRG grouper required (which)?
3. ICD version(s): ICD-10 (which edition) and whether ICD-11 dual coding starts now; SNOMED licence available?
4. Deficiency rules and escalation ladder; is privilege hold for delinquent records policy acceptable?
5. ROI fees, formats, and approval authorities; who is DPO; sensitive categories list?
6. Physical file tracking still needed (hybrid), rack/shelf structure, barcodes on existing files?
7. Scanner hardware/agents at stations; OCR languages; volume per day?
8. Medico-legal flag governance: who sets/releases; interplay with legal department (NC-023)?
9. State CRS/MCCD submission mode (portal/API/paper) and NRHM/HMIS morbidity reporting formats?
10. NABH edition targeted and MRD committee composition for destruction approvals?
