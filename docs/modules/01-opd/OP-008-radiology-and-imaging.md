# OP-008 — Radiology & Imaging (Orders, Scheduling, DICOM MWL, Structured Reports, Critical Alerts, Dose)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Module ID       | OP-008                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Phase           | 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Complexity      | Very High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on      | EN-008 (PACS Orthanc/OHIF, MWL SCP, storage), OP-002 (orders), OP-001 (patient/visit), OP-006 (ER STAT), IP-003 (IP orders/portable), EN-027 (procedure master, RadLex/LOINC-RSNA Playbook, SNOMED body parts), OP-005 (billing), EN-002 (pre-auth for CT/MRI), EN-009 (SMS/WhatsApp), EN-037 (critical escalation), EN-016 (e-sign), NC-020 (modality assets/AERB), NC-023 (AERB licences), EN-028 (consent), NC-006 (contrast/film stock), OP-022 (non-DICOM image console for smaller units), PE-001 (portal), EN-011 (ABDM DiagnosticReport), EN-039 (report templates), TR-002 (X-ray timeline for fractures), OP-003 (contrast/pre-med drugs)                                                                                                                        |
| Feature flag    | `module.radiology.enabled` (sub: `rad.mwl`, `rad.dose_tracking`, `rad.voice_dictation`, `rad.peer_review`, `rad.teleradiology`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Primary roles   | Radiology Technician (36), Radiologist (12), Radiology receptionist/scheduler (24 with rad scope)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Secondary roles | Referring doctors (OP-002/IP), ER physician (STAT), Nurses (contrast/prep), Anaesthetist (sedation MRI/CT paeds), Biomedical/RSO (dose, QA), Billing, MRD, Auditor, Patient (portal images/reports), Referring external doctors (PE-007)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Regulatory      | AERB Safety Code AERB/RF-MED/SC-3 (Rev.1) (X-ray equipment licensing via e-LORA, RSO, TLD badges, room layout approval, QA tests, dose records), Atomic Energy (Radiation Protection) Rules 2004, PC-PNDT Act 1994 (USG: Form F for every obstetric scan, registered machines, no sex determination, records 2 yrs, monthly reports), NABH IMS/COP (critical results, contrast safety, patient identification, radiation safety), ACR/ESUR contrast guidelines (eGFR screening, allergy premedication), DICOM (MWL C-FIND, MPPS, Storage, SR, RDSR dose objects), HL7 v2 ORM/ORU & FHIR ImagingStudy/DiagnosticReport, IHE SWF/RAD profiles, ABDM DiagnosticReport HI type, DPDP, BIS/CDSCO for contrast media, NABH indicators (TAT, repeat rate, critical communication) |

## 1. Purpose

OP-008 is the RIS (radiology information system) tightly coupled to EN-008 PACS: it takes imaging orders from OPD/ER/IP, checks safety (pregnancy, contrast/renal, allergy, implants for MRI, sedation), schedules modality slots and patient prep, pushes demographics to modalities via DICOM Modality Worklist, tracks acquisition (MPPS), routes studies to a radiologist reading worklist with prior comparison, produces structured, e-signed reports with critical-finding alerts, logs radiation dose per study and cumulative per patient (AERB), and monitors TAT — for a trauma centre where X-ray/CT turnaround is life-critical.

## 2. Users & Jobs-to-be-done

- **Rad receptionist/scheduler** (desktop): register walk-in/external requests, schedule slots per modality, prep instructions, consent forms, billing hand-off, pre-auth for CT/MRI, patient arrival/check-in.
- **Technician/technologist** (modality console desktop/tablet): worklist per modality, verify identity & safety checklist, MWL query on modality, perform, MPPS/complete, repeat/reject logging, dose entry when RDSR unavailable, contrast administration record, portable/bedside imaging in ER/ICU.
- **Radiologist** (reading workstation 2–3 monitors + OHIF; tablet for review): reading worklist by priority, priors, structured/templated reporting, voice dictation (later), sign, addenda, critical result communication, peer review, teaching files.
- **Referring doctor**: order with indication, view images/report, acknowledge critical.
- **Nurse**: contrast prep, IV, allergy premedication, post-contrast observation, sedation recovery.
- **RSO/biomedical**: dose audits, QA tests, TLD, AERB licences (NC-020/NC-023).
- **Patient**: prep SMS, appointment, report/images via portal, CD/link.

## 3. Core Workflows

### 3.1 Order intake

1. `order.rad.created` (OP-002/OP-006/IP) or walk-in registration (external Rx: scan, referring doctor name) → **imaging order** with accession no (`RAD_ACC`), procedure code (hospital catalogue mapped to RadLex Playbook/LOINC, modality, body part, laterality, contrast Y/N, views), priority (routine/urgent/STAT/portable), clinical indication (mandatory; ICD codes), questions to answer, transport needs (wheelchair/stretcher/O2), isolation, MLC flag.
2. **Safety screen** at order/scheduling: pregnancy status (female 10–55; LMP; for X-ray/CT: 10-day/28-day rule prompt, consent if proceeding; USG obstetric → PC-PNDT Form F mandatory), contrast studies: eGFR/creatinine within 30 days (auto-pull from OP-004; if missing → order creatinine or POC), metformin hold advice, previous contrast reaction/allergy → **premedication protocol** (e.g. prednisolone 50 mg at 13/7/1 h + diphenhydramine 50 mg 1 h; or emergency 200 mg hydrocortisone IV) suggested and ordered to OP-003/nurse; MRI safety questionnaire (pacemaker, implants (TR-003 registry lookup), aneurysm clips, cochlear, metal fragments, claustrophobia, weight limit); paediatric sedation/anaesthesia needs (IP-024); duplicate study within 30 days warning with prior link; **radiation justification** note for CT (ALARA) required.
3. Pre-auth (EN-002) for insured CT/MRI/PET; self-pay payment (OP-005) before scan per policy (ER/IP exempt); estimate (RC-008).
4. Order appears on **radiology worklist** (per modality/room) → Event `rad.order.received`.

### 3.2 Scheduling & preparation

1. Slot booking by modality/room (calendar with slot templates per modality: X-ray walk-in queue, USG 15 min, CT 20 min (contrast 30), MRI 30–45 min, mammography, DEXA, fluoroscopy, interventional), priority overrides (STAT bumps), portable requests routed to mobile unit queue; radiologist availability for USG/procedures.
2. Confirmation + **prep instructions** SMS/WhatsApp (fasting for contrast CT/USG abdomen, full bladder, remove jewellery, bring priors, arrival time, consent link) → reminders; reschedule/cancel with slot release; no-show tracking.
3. Check-in on arrival (scan slip) → token to modality waiting (EN-006/EN-018) → nurse prep (IV cannula, consent EN-028 for contrast/sedation/interventional, checklist).

### 3.3 Acquisition & MWL/MPPS

1. On schedule/arrival, RIS publishes the order to **DICOM MWL** (EN-008 Orthanc worklist plugin / dedicated MWL SCP): Patient Name (DICOM PN format), Patient ID = UHID, DOB, Sex, Accession Number, Requested Procedure ID/Description, Scheduled Procedure Step (station AE title, start date/time, modality), Referring Physician, Study Instance UID (pre-generated by RIS) → modality queries by AE/date/modality → technician selects patient (no manual typing) → **MPPS** N-CREATE (in progress) / N-SET (completed/discontinued) received → status `in_progress`/`acquired`; images stored to PACS (C-STORE) → Orthanc event → RIS matches by Study UID/accession → `rad.study.available` (image count, series).
2. Technician console: safety checklist confirmation (identity 2-check, pregnancy, contrast consent), protocol used, contrast (agent, volume, lot no, route, injector, reaction observed → adverse event NC-015 + allergy record), repeat/reject reason (positioning/exposure/motion) for repeat-rate KPI, dose capture (from **RDSR** DICOM object or MPPS/DICOM header DLP/CTDIvol/DAP/mAs-kVp; manual entry fallback), technologist notes → mark **complete** (`rad.study.completed`) → order status `awaiting_report`; unmatched studies (no MWL used) → reconciliation queue (patient/accession fix, DICOM tag update via Orthanc modify) before reading.
3. Portable X-ray/USG in ER/ICU: worklist on tablet, MWL to portable unit via Wi-Fi, bedside barcode identity.
4. Non-DICOM captures (USG stills from older machines, clinical photos, ECG) → upload console (OP-022) attach to order.

### 3.4 Reporting

1. **Reading worklist** (per radiologist/subspecialty/modality; STAT/ER first, then urgent, then routine by age; unassigned pool + assignment/claim; teleradiology pool for night) → open study → OHIF viewer (EN-008) launches with priors auto-loaded (same body part/modality; hanging protocols); RIS side panel: order, indication, history (OP-002 timeline snippets, labs eGFR, prior reports), technologist notes, dose.
2. **Structured report**: templates per procedure (EN-039: e.g. CT head trauma, CT abdomen, chest X-ray, USG abdomen, obstetric USG (with PC-PNDT fields), MRI knee, mammography BI-RADS, thyroid TI-RADS, liver LI-RADS, lung nodule Fleischner, spine, fracture reporting linking TR-002 AO/OTA), sections: Technique, Comparison, Findings (structured fields + free text), Impression, Recommendations, Critical/Incidental flags, key images (from viewer), measurements auto-import (DICOM SR); macros/canned phrases; **voice dictation** (later AI-004/Whisper) with speech-to-text; **resident draft → consultant co-sign** workflow (OP-022 requirement) with tracked changes.
3. **Sign** (`Ctrl+Enter`) → e-sign (EN-016), PDF with key images, hash chain, version 1 final → `rad.report.final` → distribution: ordering doctor inbox (OP-002/IP), portal/WhatsApp (non-sensitive), print counter, ABDM DiagnosticReport + FHIR ImagingStudy link, DICOM SR/Encapsulated PDF stored to PACS for external viewers, referring external doctor portal (PE-007).
4. **Addendum/amendment**: new version with reason (`rad.report.amended`), re-notify; original retained.
5. **Preliminary/wet read** by resident/ER physician for STAT (e.g. trauma CT) → flagged "Preliminary" with final to follow; discrepancy tracking (prelim vs final) → peer review/quality (RADPEER-style scoring 1–3) → NC-015.
6. Verification of pending "unreported > TAT" list; auto-assign rules; night teleradiology (external radiologist accounts, VPN/portal, DICOM routing, report ingest).

### 3.5 Critical / urgent findings communication

1. Radiologist marks finding severity: **Critical** (e.g. tension pneumothorax, intracranial haemorrhage, aortic dissection, ectopic pregnancy, free air) → immediate call to referring doctor + record: person informed, role, time, method, **read-back confirmed**, escalation if unreachable (EN-037 ladder: 10 min → ER physician/HOD, 20 min → MS); **Urgent/Significant unexpected** (e.g. new mass) → within 24 h; **Incidental** (e.g. lung nodule) → follow-up recommendation tracking list (Fleischner) → PE-002.
2. Referring doctor acknowledges in inbox → loop closed; KPI % criticals communicated ≤ 60 min (NABH).

### 3.6 Radiation dose tracking (AERB/ALARA)

1. Per study: modality, protocol, CTDIvol, DLP (mGy·cm), DAP (Gy·cm²), kVp/mAs, fluoroscopy time, effective dose estimate (k-factors by body region; paediatric factors), contrast dose; source RDSR preferred (Orthanc → parse), else header/manual.
2. **Cumulative dose per patient** (lifetime, 12-month) with thresholds (e.g. > 100 mSv/12 months alert to radiologist/RSO); shown on order screen when ordering new CT ("this patient had 4 CTs in 6 months, cumulative X mSv"); diagnostic reference levels (DRL) per protocol (national/local) → outlier alerts; dose report per patient (portal on request); AERB compliance: equipment licence (e-LORA) validity, QA test due dates, RSO details, TLD badge periodic reports for staff (NC-020/NC-023 links), room shielding cert.
3. Pregnancy exposure incidents → NC-015 incident + foetal dose estimation task.

### 3.7 TAT & progress tracking

- Timestamps: ordered → scheduled → arrived → started → completed → preliminary → final → delivered/acknowledged; targets by priority/modality (STAT CT report ≤ 30 min, ER X-ray ≤ 60 min, routine ≤ 24 h); SLA dashboard + TV; unreported list; equipment downtime affecting slots (NC-020 breakdown → auto block slots & reschedule alerts — market enhancement).

### 3.8 Consumables & billing

- Contrast, films, CDs, catheters (interventional) consumed per study → NC-006 deduction; billing items posted at order (OP-005) with modifiers (contrast, portable surcharge, films/CD, sedation); cancellation before acquisition → reversal; post-acquisition cancellations approval only.

## 4. Data Model (schema `rad`)

- **rad_procedures** (mdm): id, hospital_id, code, name, modality enum(CR/DX/CT/MR/US/MG/XA/RF/NM/PT/DXA/OT), body_part (SNOMED), laterality_required, contrast_default, radlex_playbook_id, loinc_code, duration_min, prep_instructions_id, consent_required, requires_pregnancy_check, requires_creatinine, requires_mri_safety, sedation_option, default_report_template_id, drl_ctdivol, drl_dlp, price ref, tat_routine/urgent/stat_min, is_pnpdt (obstetric USG), effective dates.
- **rad_orders**: id, hospital_id, branch_id, accession_no, patient_id, visit_id/admission_id/er_visit_id, encounter_id, source enum(opd/er/ip/walkin/external/health_checkup/portal), ordering_doctor_id, external_referrer, priority enum(routine/urgent/stat/portable_stat), status enum(placed/on_hold_payment/on_hold_preauth/scheduled/arrived/in_progress/acquired/awaiting_report/preliminary/reported/amended/cancelled/rejected), clinical_indication, questions, icd_codes[], is_mlc, transport_mode, isolation, safety_screen jsonb (pregnancy_status, lmp, egfr, egfr_date, contrast_allergy, premed_ordered, mri_checklist, sedation), consent_doc_ids[], preauth_id, billing_status, ordered_at, tat_due_at.
- **rad_order_items** (one per procedure): order_id, procedure_id, laterality, contrast bool, status, study_instance_uid, scheduled_step_id, cancel_reason.
- **modality_rooms** (station): id, branch_id, name, modality, ae_title, host/port, asset_id (NC-020), aerb_licence_no, licence_valid_to, qa_due_at, is_portable, slot_template_id, status enum(active/down/maintenance).
- **rad_slots / rad_appointments**: room_id, start/end, order_item_id, status, prep_sent_at, reminder_sent_at, no_show.
- **mwl_entries**: order_item_id, station_ae, scheduled_at, patient_name_dicom, patient_id, dob, sex, accession, requested_procedure_id, sps_id, modality, study_uid, status enum(scheduled/started/completed/discontinued/removed), published_at.
- **mpps_events**: sps_id, mpps_uid, status, at, performed_series[] jsonb, raw ref.
- **studies**: id, order_item_id, study_uid, pacs_study_id (Orthanc), patient_id, modality, study_date, series_count, instance_count, is_reconciled bool, matched_by enum(mwl/accession/manual), technician_id, room_id, protocol, repeat_count, reject_reasons jsonb[], contrast_admin jsonb (agent, volume_ml, lot, route, injector, reaction), technologist_notes, completed_at, key_image_refs[].
- **dose_records**: study_id, patient_id, modality, protocol, ctdivol_mgy, dlp_mgycm, dap_gycm2, kvp, mas, fluoro_time_s, effective_dose_msv (estimated, k_factor_id), source enum(rdsr/header/mpps/manual), rdsr_instance_uid, drl_exceeded bool, recorded_at. Index (patient_id, recorded_at). **patient_dose_summary** (read model: patient_id, cumulative_msv_lifetime, msv_12m, ct_count_12m, updated_at).
- **rad_reports**: id, order_item_id, study_id, version, status enum(draft/preliminary/final/amended/cancelled), template_id, content jsonb (structured sections), impression_text, findings_text, birads/tirads/lirads/etc coded fields, critical_level enum(none/incidental/urgent/critical), key_images[], measurements jsonb (from SR), author_id (resident), signer_id, signed_at, sign_method, pdf_file_id, sr_instance_uid, sha256, prev_sha256, dictation_audio_file_id?, ai_assist_flag.
- **critical_findings_log**: report_id, level, detected_at, notified_to_name/role/id, notified_by, at, method, read_back bool, escalation_level, acknowledged_by/at, follow_up_recommendation, followup_due_at, remarks.
- **follow_up_recommendations**: patient_id, report_id, recommendation, due_at, status (PE-002 tracked).
- **peer_reviews**: report_id, reviewer_id, score (1–3), comment, discrepancy_type, at; **prelim_final_discrepancies**.
- **teleradiology_assignments**: study_id, external_radiologist_id/vendor, sent_at, due_at, received_at, status.
- **pnpdt_form_f**: order_item_id, patient details, referring doctor, indication (from Form F list), procedures, declaration signed doc, machine reg no, radiologist reg no, month; **pnpdt_monthly_reports**.
- **rad_kpi_timestamps**: order_item_id, event, at.
- **rad_templates** → EN-039 with radiology fields; **prep_instruction_sets**; **contrast_agents** (item link, iodine conc., gadolinium class), **premed_protocols**.
- Indexes: rad_orders (hospital_id, branch_id, status, priority, ordered_at), (patient_id, ordered_at desc), accession unique; studies (study_uid) unique; rad_reports (order_item_id, version); reading worklist read model `rad_reading_worklist` (status awaiting_report/preliminary, priority, age). RLS all.

## 5. Business Rules & Validations

- Clinical indication mandatory; CT/X-ray on potentially pregnant → pregnancy status + justification/consent; obstetric USG → PC-PNDT Form F completed & signed before study is marked complete; no fields anywhere capture foetal sex; USG rooms must be PC-PNDT registered (machine reg no on report).
- Contrast: eGFR ≥ 30 (or per protocol) else radiologist approval; documented iodinated-contrast allergy → premedication protocol or non-contrast/alternative — override by radiologist only; contrast lot recorded; reaction → allergy record + incident.
- MRI: safety checklist mandatory; implant registry (TR-003) auto-check for MR-conditional; blocked if unsafe device without radiologist override.
- MWL is the only source of demographics on modalities (policy); unmatched/manual studies must be reconciled before reporting; DICOM patient ID = UHID (or ER tag until identified; re-map on merge via Orthanc modify + audit).
- Reports signed only by radiologists with valid registration (and PC-PNDT reg for USG); residents create drafts; preliminary reads flagged; final overrides prelim; amendments new versions; PDF & SR immutable; QR verify.
- Critical findings require documented communication with read-back before (or within 60 min after) sign; escalation ladder configurable; report cannot be marked "communicated" without a name.
- Dose: every ionising study must have a dose record (RDSR/header/manual) before order closes (config warn/block); DRL exceed → flag; cumulative alert thresholds; paediatric protocols enforced (weight-based).
- Repeat exposures logged with reason (AERB QA); repeat rate KPI by technician/room.
- Equipment with expired AERB licence or QA overdue → room blocked for scheduling (override by RSO with reason).
- Payment/pre-auth gates: self-pay before acquisition unless ER/IP/credit; cancellations after acquisition need approval; portable surcharge rules.
- TAT clocks per priority; STAT ER studies auto-top of reading list; unreported > TAT escalates to HOD.
- Numbering: `RAD_ACC` per branch/FY; Study UID root per hospital (OID) — generated by RIS.
- Retention: images per PACS policy (≥ 5–10 y; paeds longer; MLC permanent), reports ≥ 10 y, PC-PNDT Form F 2 y (keep 5), dose records lifetime.

## 6. API Surface (`/api/v1/rad`)

| Method  | Path                                                                    | Purpose                                          | Permission                                                  | Idem | Pag    |
| ------- | ----------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------- | ---- | ------ |
| POST    | /orders                                                                 | create (walk-in / from CPOE)                     | rad.order.create                                            | Y    | –      |
| GET     | /orders?status=&modality=&priority=&from=                               | worklists                                        | rad.order.list                                              | –    | cursor |
| GET     | /orders/{id}                                                            | full order                                       | rad.order.read                                              | –    | –      |
| PATCH   | /orders/{id}/safety-screen                                              | pregnancy/contrast/MRI answers                   | rad.order.update                                            | Y    | –      |
| POST    | /orders/{id}/cancel                                                     | cancel with reason                               | rad.order.cancel                                            | Y    | –      |
| GET     | /rooms/{id}/slots?date= ; POST /appointments ; PATCH /appointments/{id} | scheduling                                       | rad.schedule.manage                                         | Y    | –      |
| POST    | /orders/{id}/check-in                                                   | arrival                                          | rad.schedule.manage                                         | Y    | –      |
| POST    | /orders/{id}/mwl/publish, /mwl/remove                                   | worklist push                                    | rad.mwl.manage                                              | Y    | –      |
| POST    | /mpps                                                                   | MPPS ingest (EN-008 internal)                    | integration.rad.mpps                                        | Y    | –      |
| POST    | /studies/ingest                                                         | PACS study arrived (Orthanc webhook)             | integration.rad.study                                       | Y    | –      |
| GET     | /studies/unmatched ; POST /studies/{id}/reconcile                       | reconciliation                                   | rad.study.reconcile                                         | Y    | cursor |
| POST    | /studies/{id}/complete                                                  | technician completion (contrast, repeats, notes) | rad.study.complete                                          | Y    | –      |
| POST    | /studies/{id}/dose                                                      | dose entry/ingest                                | rad.dose.record                                             | Y    | –      |
| GET     | /patients/{id}/dose-summary                                             | cumulative                                       | rad.dose.read                                               | –    | –      |
| GET     | /reading-worklist?radiologist=&modality=&priority=                      | reading list                                     | rad.report.create                                           | –    | cursor |
| POST    | /reports                                                                | create draft                                     | rad.report.create                                           | Y    | –      |
| PATCH   | /reports/{id}                                                           | edit draft (autosave)                            | rad.report.create                                           | –    | –      |
| POST    | /reports/{id}/preliminary, /sign, /addendum                             | lifecycle                                        | rad.report.preliminary / rad.report.sign / rad.report.amend | Y    | –      |
| POST    | /reports/{id}/critical                                                  | log critical communication                       | rad.critical.notify                                         | Y    | –      |
| GET     | /critical?open=true                                                     | open criticals                                   | rad.critical.read                                           | –    | cursor |
| POST    | /reports/{id}/deliver, GET /reports/{id}/pdf                            | delivery                                         | rad.report.deliver / rad.report.print                       | –    | –      |
| POST    | /reports/{id}/peer-review                                               | RADPEER                                          | rad.peer_review.create                                      | Y    | –      |
| POST    | /pnpdt/form-f, GET /pnpdt/monthly-report                                | PC-PNDT                                          | rad.pnpdt.manage                                            | Y    | cursor |
| POST    | /teleradiology/assign, /teleradiology/{id}/ingest-report                | external reads                                   | rad.telerad.manage                                          | Y    | –      |
| GET     | /tat/dashboard, /reports/kpi/*                                          | KPIs                                             | rad.report.read                                             | –    | –      |
| GET/PUT | /procedures, /rooms, /templates, /prep-sets, /premed-protocols, /drl    | masters                                          | rad.configure                                               | Y    | cursor |
| GET     | /viewer/launch/{study}                                                  | OHIF URL with token                              | rad.image.view                                              | –    | –      |
| GET     | /public/verify/{code}                                                   | QR verify report                                 | public                                                      | –    | –      |

## 7. Domain Events

- `rad.order.received|scheduled|arrived|cancelled` → OP-005 (charge/reverse), OP-002 status, EN-009 prep SMS, EN-018.
- `rad.mwl.published|removed` → EN-008 MWL SCP.
- `rad.study.started|available|completed` → reading worklist, OP-002 ("images available"), TR-002 X-ray timeline, IP-003.
- `rad.study.unmatched` → reconciliation queue alert.
- `rad.report.preliminary|final|amended` → OP-002/IP inbox, PE-001, EN-009 (non-sensitive), EN-011 DiagnosticReport, PACS SR/PDF store, PE-007, MRD.
- `rad.result.critical` {report_id, level, doctor_id} → EN-037 escalation, OP-002 modal, OP-006 board flag; `rad.critical.acknowledged`.
- `rad.followup.recommended` → PE-002 recall list.
- `rad.dose.recorded` / `rad.dose.threshold_exceeded` / `rad.drl.exceeded` → RSO/radiologist, patient dose summary.
- `rad.contrast.reaction` → EN-029 allergy, NC-015 incident.
- `rad.tat.breached`, `rad.room.blocked` (licence/QA), `rad.repeat.logged`.
- Consumes: `order.rad.created`, `order.cancelled`, `payment.received`, `preauth.approved`, `lab.result.final` (creatinine/eGFR), `patient.merged` (DICOM re-map), `asset.breakdown` (NC-020 → slot block).

## 8. Screens

- **Radiology front desk** (desktop): orders inbox, walk-in registration, scheduler calendar per room (drag/drop, STAT overlay), check-in scan, consent/prep status, payment/pre-auth flags. Hotkeys: `F2` new, `F3` find, `F4` schedule, `F5` check-in, `Ctrl+P` prep print.
- **Technician modality console** (desktop near console / tablet portable): worklist for room, safety checklist (blocking), MWL publish status, MPPS live status, contrast form, repeat/reject log, dose entry, complete button; `Enter` complete, `Ctrl+R` repeat log, `Ctrl+D` dose. Real-time image arrival badge. Offline (portable Wi-Fi gaps): checklist/notes cached; MWL requires connectivity (fallback: manual entry flagged for reconciliation).
- **Reconciliation queue** (desktop): unmatched studies with thumbnails, patient search, merge/fix (Orthanc modify) with audit.
- **Radiologist reading workstation** (desktop multi-monitor; RIS panel + OHIF viewer via EN-008): worklist (STAT red), study context (indication, priors list, labs, dose, technologist notes), structured report editor (template sections, pick-lists, measurements import, macros, key images), sign/prelim/addendum, critical-communication modal, peer review, dictation (later). Hotkeys: `Ctrl+Enter` sign, `Ctrl+Shift+P` preliminary, `Alt+C` critical, `Alt+K` key image, `F7` next study, `Ctrl+M` macro. Real-time: new STAT arrival toast.
- **Critical findings console**: open items with timers, escalation, ack status.
- **Dose dashboard** (RSO/radiologist): per patient cumulative, per protocol vs DRL, per room, outliers, paediatric, monthly AERB pack; QA/licence calendar (NC-020).
- **PC-PNDT console**: Form F per obstetric scan, monthly report export (state format), machine registry.
- **TAT / SLA dashboard + TV** (dept), **Report centre** (search/print/deliver/CD burn request), **Teleradiology board**, **Config** (procedures, templates, rooms/AE titles, prep sets, premed protocols, DRLs).
- **Patient/portal**: report PDF + image link (OHIF viewer, time-limited token) via PE-001.
- Print: A4 report with key images, Form F, prep sheets, consent forms; CD/DVD label (EN-008 media export).

## 9. Integrations

- EN-008 PACS (Orthanc): MWL SCP (worklist plugin, entries generated by RIS as .wl or DB-backed), C-STORE receiver, MPPS SCP (or Orthanc-lua/py plugin), RDSR parsing (dose SR TID 10011/10001), webhook `NewStudy/StableStudy` → RIS, DICOM modify for reconciliation, OHIF viewer with RIS-issued JWT, DICOMweb (QIDO/WADO), study routing (teleradiology), media export; modality AE configuration; IHE SWF conformance.
- Modalities: CR/DR (Siemens, GE, Philips, Fuji, Carestream, Allengers), CT/MRI (Siemens/GE/Philips/Canon), USG (Samsung/GE/Mindray/Philips), mammography, C-arm (TR-004 intra-op) — via DICOM MWL/MPPS/Storage; older non-DICOM USG via frame grabber/OP-022 upload.
- HL7 v2 ORM/ORU or FHIR ImagingStudy/DiagnosticReport via EN-019 for external RIS/teleradiology vendors; EN-011 ABDM; EN-009 SMS/WhatsApp; EN-016 e-sign; EN-002 pre-auth; OP-005 billing; OP-004 eGFR pull; TR-003 implant lookup (MRI safety); NC-020/NC-023 AERB licences (e-LORA data manual), TLD vendor reports upload; NC-006 contrast stock; AI-007 radiology assist (later: priority flag, draft report).
- Fallbacks: MWL down → manual entry on modality + reconciliation; PACS down → modality local storage & later push; viewer down → DICOM download; SMS down → phone list.

## 10. Reports & Analytics

- Volume by modality/room/technician/referrer/source; TAT by priority (order→scan, scan→report, report→ack); unreported backlog aging; STAT ER compliance; critical findings communication time & %; prelim–final discrepancy rate; peer review scores; repeat/reject rate (AERB QA); dose per protocol vs DRL, cumulative high-dose patients, paediatric dose; contrast usage & reactions; room utilisation/downtime, no-show rate; revenue per modality (OP-005), unbilled studies (RC-006); PC-PNDT monthly report; MRI safety incidents; teleradiology TAT/cost; NABH imaging indicators pack.
- Read models: `analytics.mv_rad_tat`, `analytics.mv_rad_volume_daily`, `analytics.mv_rad_dose_summary`, `analytics.mv_rad_criticals`.

## 11. Notifications

- Patient: appointment + prep instructions (fasting/contrast/MRI safety), reminders, arrival token, report ready (portal/WhatsApp; not for restricted/PNDT), follow-up recommendations (PE-002).
- Referring doctor: images available, report final (inbox), critical (push + SMS + escalation), addendum.
- Radiologist: STAT study arrived (sound), unreported > TAT, critical follow-up, peer review assigned.
- Technician/RSO: MWL publish failures, unmatched study, QA/licence due, DRL exceed, contrast reaction incident.
- Admin: TAT breach, room down/blocked, teleradiology overdue.

## 12. Permissions

`rad.order.create|read|list|update|cancel`, `rad.schedule.manage`, `rad.mwl.manage`, `rad.study.complete|reconcile`, `rad.dose.record|read`, `rad.report.create|preliminary|sign|amend|deliver|print|read`, `rad.critical.notify|read`, `rad.image.view` (+care team/break-glass), `rad.peer_review.create|read`, `rad.pnpdt.manage`, `rad.telerad.manage`, `rad.configure`, `rad.report.read` (KPIs), `integration.rad.mpps|study`.
Defaults: Rad receptionist: order.create/read/list, schedule.manage; Technician: study.complete/reconcile, dose.record, mwl.manage, order.update (safety); Radiologist: report._, critical._, image.view, peer_review, pnpdt (signing), dose.read; Resident: report.create/preliminary (no sign); Referring doctor: order.create (via OP-002), image.view, report.read; RSO/Biomedical: dose.read, configure rooms; Auditor: read.

## 13. Non-functional

- Volumes: 1500 studies/day (600 X-ray, 250 CT, 120 MRI, 400 USG, 130 others), 25 modalities/rooms, 20 radiologists, 100 GB images/day; MWL queries 5k/day; reading worklist refresh real-time.
- p95: worklist < 200 ms; MWL entry publish < 500 ms after scheduling/arrival; study ingest → worklist < 5 s after StableStudy; report sign + PDF ≤ 3 s; OHIF launch < 2 s to first image (PACS/network dependent); dose summary < 200 ms.
- Offline: technician console cached checklists; reporting online-only (viewer); portable units need Wi-Fi coverage (note in Q16).
- Printing: A4 reports auto-print at counter option; Form F; CD label.
- Accessibility/i18n: keyboard-first reporting; templates in English (patient-facing summary optional local language); dark theme for reading rooms.
- Security: images via short-lived tokens; PHI in DICOM tags managed; teleradiology via VPN/DICOM TLS; audit image views (`READ_PHI`); PC-PNDT data restricted; hash-chained reports; no PHI in SMS beyond initials.

## 14. Acceptance Criteria

1. Given `order.rad.created` for CT head STAT from ER, then a rad order with accession appears on CT worklist within 1 s, MWL entry is queryable by the CT scanner AE within 2 s, and reading worklist shows STAT red once images arrive.
2. Given a female aged 25 ordered for pelvic X-ray without pregnancy status, then scheduling is blocked until LMP/pregnancy status is recorded; "possible pregnancy" requires radiologist justification + consent.
3. Given contrast CT ordered for patient with eGFR 25 (from OP-004), then a hard-stop requires radiologist approval; with documented iodinated contrast allergy, the premedication protocol is proposed and an order sent to OP-003/nurse.
4. Given the modality sends MPPS COMPLETED and images to Orthanc with the RIS Study UID, then the study auto-matches, technician sees "images available", and no manual reconciliation is needed; a study without MWL lands in the unmatched queue.
5. Given technician logs 2 repeats (motion), then repeat rate report reflects them by room/technician; dose record from RDSR shows CTDIvol/DLP and effective dose estimate.
6. Given cumulative 12-month dose crosses the configured threshold, then ordering a new CT displays the warning and RSO gets a notification.
7. Given radiologist signs a structured CT head report with "intracranial haemorrhage" marked critical, then the report cannot be closed without a communication log (name, time, read-back), the ER physician gets push+SMS, and unacknowledged alerts escalate at 10/20 min.
8. Given a resident drafts and marks preliminary, then referring doctor sees "Preliminary" watermark; consultant sign creates final v1 and discrepancy (if any) is captured for peer review.
9. Given an obstetric USG order, then Form F must be completed and signed before completion; the report prints machine registration and radiologist registration numbers and never contains foetal sex fields.
10. Given MRI order for patient with pacemaker in TR-003 registry, then MRI safety checklist flags and blocks unless radiologist override with MR-conditional documentation.
11. Given room AERB licence expired, then no new slots can be scheduled in that room; RSO override records reason.
12. Given a report addendum, then version 2 with reason is created, PDF marked "Addendum", referrer re-notified, SR/PDF re-stored to PACS, and v1 retrievable.
13. Given a paid self-pay walk-in X-ray cancelled before acquisition, then charge reversal/refund request is emitted; after acquisition cancellation requires approval.
14. Given 1500 studies/day load, worklist p95 < 200 ms and ingest-to-worklist < 5 s.
15. Given prep SMS configured, then a contrast CT booking triggers fasting/creatinine instructions and reminders; no-show marks after grace and slot frees.
16. Given patient portal opens report, then image link launches OHIF with a token that expires (config 24 h) and view is audited.
17. Given TAT target STAT CT 30 min and unreported at 31 min, then `rad.tat.breached` fires and HOD is notified; TV shows red.
18. Given `patient.merged`, then DICOM PatientID for the victim's studies is re-mapped in Orthanc and reports re-linked with audit.

## 15. Enhancements / Later phases

- From VIMS sheet: AI-assisted image annotation (AI-007, Phase 12); 3D reconstruction CT/MRI (out of Phase-1 scope; OHIF MPR/3D extension later); voice dictation for reports (AI-004/Whisper, Phase 12; template macros Phase 3); cumulative radiation dose tracking (Phase 3 core); contrast allergy pre-med protocol (Phase 3 core); peer review/quality audit (Phase 3 basic RADPEER, Phase 9 QMS link).
- From row 12 (Packages/Investigation console → OP-022): priority queue, equipment maintenance downtime alerts (NC-020 hook Phase 9), patient prep SMS (Phase 3), report co-signing resident→consultant (Phase 3), urgent investigation fast-track (Phase 3 STAT), image upload/viewer for non-DICOM (OP-022).
- (market) Cardiology imaging (Echo/Cath) merging with OP-029; USG sub-type templates, dedicated U/X tokens (SmartHospital) → EN-006 per-modality queues; non-DICOM images/clips storage & standard prefixed reports (Prodoc); teleradiology & CD/share (EN-008); mammography screening recall programme; radiology inventory (films/contrast) analytics; structured reporting export to registries (TR-002/TR-011).

## 16. Open Questions for the Hospital

1. Modality inventory per branch: make/model, DICOM conformance (MWL/MPPS/RDSR support), AE titles/IPs, portable units; any non-DICOM USG needing frame grabbers.
2. Existing PACS/RIS? Migration of prior images (DICOM import) and reports.
3. AERB: e-LORA licence numbers/validity per equipment, RSO name, QA vendor schedule, TLD service; DRL values (national/local) to configure.
4. PC-PNDT: registered USG machines & radiologists, state Form F/monthly report format, submission channel.
5. Reporting practice: subspecialty assignment, resident/consultant co-sign, preliminary reads by ER doctors allowed?, night coverage (in-house vs teleradiology vendor — DICOM routing details).
6. Report templates required at go-live per modality/procedure; BI-RADS/TI-RADS/LI-RADS usage; report letterhead/signature (DSC?).
7. Critical findings list, communication protocol & escalation timings; who receives for IP vs OP vs ER.
8. Contrast protocols: agents used, eGFR thresholds, premedication regimen, metformin policy, post-contrast observation time; MRI safety questionnaire version.
9. Payment/pre-auth gates for CT/MRI; portable surcharge; film/CD charges.
10. Slot templates per room, working hours, walk-in X-ray queue vs appointments; prep instruction texts and languages.
11. Image retention policy, patient image access (portal link vs CD), teleradiology security (VPN).
12. Wi-Fi coverage for portable units in ER/ICU/wards; reading room monitors availability.
