# OP-002 — OPD / CPOE Doctor Dashboard (Consultation, ICD-10, e-Rx, Orders, History, Templates)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Module ID       | OP-002                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Phase           | 2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Depends on      | OP-001 (visits/queue), OP-007 (vitals), EN-027 (drug/ICD/SNOMED/LOINC/service masters), EN-029 (CDSS rules), EN-039 (forms/templates), EN-006 (queue), EN-028 (consent), OP-003 (pharmacy), OP-004 (lab), OP-008 (radiology), OP-005 (billing hooks), NC-003 (MRD), EN-016 (e-sign), EN-011 (ABDM M2 care contexts), EN-009 (SMS/WhatsApp), EN-037 (notifications)                                                                                                                                                |
| Feature flag    | `module.opd_cpoe.enabled` (sub: `opd.erx`, `opd.voice_notes`, `opd.smart_rx`, `opd.pathways`)                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Primary roles   | Doctor — Consultant OPD (6), Resident/Junior (14, co-sign), HOD (5)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Secondary roles | Nurse OPD (16, view/assist), Pharmacist (receives Rx), Lab/Radiology (orders), MRD/Coder (ICD), Billing (auto-post orders), Auditor, Patient (portal copies)                                                                                                                                                                                                                                                                                                                                                      |
| Regulatory      | NABH 5th ed. COP/MOM/IMS (prescription legibility, generic names, allergy check, abbreviations list), MCI/NMC Code 2002 reg. 1.5 (generic name prescription, legible caps), Schedule H/H1/X (Rx marking, register in OP-003), Telemedicine Practice Guidelines 2020 (tele-Rx categories), ABDM HIP (OP consultation record FHIR bundle: OPConsultRecord, Prescription), DPDP (PHI access, break-glass), IT Act §5/e-sign for signed documents, ICD-10 (WHO) & ICD-11 ready, SNOMED CT (India free licence), LOINC |

## 1. Purpose

OP-002 is the doctor's daily workspace: live queue with pre-captured vitals, structured consultation (complaint → examination → diagnosis → plan), electronic prescription with rules-based CDSS (allergy, interaction, dose range, duplicate therapy, renal/hepatic/pregnancy/paediatric flags), CPOE for lab/radiology/procedures/referrals/admission, patient timeline across all modules, personal and departmental templates, and signed clinical documents pushed in real time to pharmacy, lab, radiology, billing, MRD and the patient. It must support 60–100 patients/doctor/day at ≤ 90 seconds of documentation for a routine follow-up.

## 2. Users & Jobs-to-be-done

- **OPD consultant** (desktop 3-pane, tablet 2-pane, phone via OP-019): call next patient, review vitals/history, document, prescribe, order, refer, follow-up, sign, print — ≤ 3 clicks per action, keyboard-first, ≤ 90 s for follow-up.
- **Resident/JR**: draft notes/orders; consultant co-signs; unsigned Rx not released to pharmacy (config: release with "provisional" watermark).
- **HOD**: department queue view, template governance, redistribute patients between doctors, audit prescriptions (generic %, antibiotic %).
- **OPD nurse**: view queue, prepare patient, execute injection/dressing orders (OP-039), print Rx on doctor's behalf.
- **Pharmacist / Lab / Radiology**: consume orders (OP-003/004/008).
- **Patient**: gets Rx PDF, advice, follow-up date, education content on WhatsApp/portal (PE-001, OP-020).

## 3. Core Workflows

### 3.1 Queue & start consultation

1. **Doctor** logs in → home shows today's clinic(s) with live queue (socket topic `queue:doctor:<id>`) — cards: token, name, age/sex, photo, visit type (new/FU/free review), vitals summary with abnormal chips (from OP-007), wait time, flags (allergy, MLC, VIP, insurance pre-auth pending), source (appointment/walk-in/referral/ER).
2. `Space`/"Call next" → EN-006 announces token on TV; card status `called`; no-show after N calls → `skipped` (re-queue by nurse).
3. `Enter`/"Start consultation" → visit status `in_consult` (`visit.consult.started`), workspace opens with patient banner + timeline rail; nurse notes and vitals visible; previous visit summary auto-expanded for follow-ups.

### 3.2 Consultation documentation

1. **Chief complaint**: free text + quick-pick chips (specialty-specific list, learnable "my frequent"), duration/onset; SNOMED-coded when picked (`snomed_id`).
2. **History**: HPI, past history, drug history/current medications (med reconciliation incl. patient-reported), allergies (add/verify → EN-029 store, hard-stop banner), family, social (tobacco/alcohol), obstetric (if female 12–55), immunisation link (OP-013), Review of systems — all via EN-039 dynamic forms per specialty (defaults seeded: General medicine, Ortho, Paeds, OBG, ENT, Ophthal, Derm, Cardio, Surgery).
3. **Examination**: general + system-wise structured fields, body-map annotations (SVG), photo capture (wound/lesion) with consent, growth chart for paeds (OP-033 later), pain NRS.
4. **Diagnosis**: search box (ICD-10 with synonyms and Indian colloquial aliases + SNOMED problem list; trigram + FTS; favourites; department top-50) → mark Primary/Secondary, type (provisional/confirmed/rule-out/chronic), severity, onset date, laterality → problem list persisted across visits (`clinical.problems`, active/resolved).
5. **Plan/Advice**: treatment plan notes, patient instructions (multilingual phrasebook, e.g. "take after food" in Tamil/Hindi), diet/lifestyle chips, work-fitness note, follow-up (date/interval → auto-creates OP-001 follow-up appointment or reminder), education material auto-suggested by diagnosis (PE-003) with one-click WhatsApp share.
6. **Certificates & forms**: medical/fitness/sick-leave certificate, referral letter, MLC intimation (OP-006/TR-008), consent forms (EN-028), disability/insurance forms via EN-039 templates.
7. Autosave every 5 s (draft, IndexedDB + server); `Ctrl+S` save; `Ctrl+Enter` sign & complete.

### 3.3 e-Prescription (e-Rx)

1. `Alt+R` → Rx grid; drug search (brand ↔ generic mapping from EN-027 drug master: molecule(s), strength, form, route, schedule H/H1/X, price, stock at OP pharmacy of this branch shown live, formulary flag/insurance-scheme formulary) → select → dose, unit, frequency (OD/BD/TDS/QID/HS/SOS/stat/weekly + custom, with timing meal relation), duration (days/weeks/"continue"), quantity auto-computed (dose×freq×days, rounded to pack), route, instructions (multilingual codes), refills, tapering builder, PRN reason.
2. On each add, **EN-029 CDSS** runs synchronously (< 100 ms cached): (a) allergy match (molecule/class) → hard stop requiring override reason; (b) drug–drug interaction with severity (contraindicated/major/moderate/minor) → contraindicated = hard stop with reason, major = acknowledge; (c) duplicate therapy (same molecule/class); (d) dose range check by age/weight/renal (eGFR from last creatinine) → warning; (e) pregnancy/lactation category (from OBG flag), paediatric weight-based dose calculator (mg/kg with max), geriatric Beers list flag; (f) Schedule X/narcotic → requires reason and shows dispensing constraints; (g) diagnosis–drug appropriateness (Smart Rx suggestions per diagnosis from hospital pathway lists; suggestions only).
3. Generic-name rule: prescription print shows generic (INN) in CAPITALS with brand in brackets (NMC), configurable per hospital; "do not substitute" flag by doctor.
4. Templates: personal & department Rx sets ("Viral fever adult", "Post-op ortho pack") → one-click apply then edit; "repeat last Rx" for chronic; favourite drugs; keyboard: `↓/↑` rows, `Tab` cells, `Ctrl+D` duplicate row, `Del` remove.
5. External/OTC recommendation lines flagged `not_dispensed_here`.
6. Sign (`Ctrl+Enter`) → e-Rx document version 1 final (hash chain, doctor e-sign via EN-016 optional DSC/Aadhaar eSign; system signature with NMC reg no by default) → PDF (letterhead, QR verify link, ABHA prescription FHIR bundle) → Event `rx.created` → OP-003 pending queue live (WebSocket), patient WhatsApp PDF, portal.
7. Amend after sign → new version with reason (`rx.amended`), pharmacy sees delta if not yet dispensed; if dispensed, creates new Rx.

### 3.4 CPOE — orders

1. `Alt+L` labs, `Alt+I` imaging, `Alt+P` procedures, `Alt+F` referral, `Alt+A` admission advice.
2. Lab: catalogue search (test/panel/profile, LOINC, sample type, TAT, price, fasting flag) → priority Routine/Urgent/STAT → clinical notes → order set/pathway bundles → System validates duplicates within X hours (warn), insurance pre-auth need (EN-002), patient prep instructions auto-messaged → Event `order.lab.created` → OP-004 & OP-005 (charge posted, payable before sample unless credit).
3. Radiology: modality/body part/laterality/contrast/clinical indication (mandatory, radiation justification for CT), pregnancy check prompt for females 12–55 (LMP), prior study alert → `order.rad.created` → OP-008 (scheduling/MWL).
4. Procedures/injections/dressings/nebulisation → OP-039/OP-010 worklist; consumables auto-charge.
5. Referral: internal (specialty/doctor, urgency, shared note) → creates cross-consult visit/appointment (OP-001) with notes visible; external → letter PDF, OP-021 tracking.
6. Admission advice → IP-001 pre-admission request with provisional diagnosis, ward class, expected LOS, surgery flag (TR/IP-006), estimate (RC-008).
7. Order cancellation before execution: reason → `order.cancelled` → billing reversal (OP-005) if unpaid/paid.

### 3.5 Results review & inbox

1. Doctor inbox: new lab/rad results for own patients (unread), critical values requiring acknowledgement (hard modal with call-back note; OP-004/OP-008), co-sign requests, referral replies, pending drafts, pre-auth queries.
2. Result view: tabular with flags, cumulative/trend graph, prior comparison, image link (OHIF EN-008); "acknowledge"/"discussed with patient" → `result.acknowledged`.

### 3.6 Patient timeline / history

- Unified timeline (visits, diagnoses, Rx, labs, imaging, procedures, admissions, vitals trends, documents/uploads, ABDM-fetched external records via EN-011 M3) filterable by date/specialty/type; search within record; problem list; medication list (active/stopped); allergy list; growth/vitals graphs; scanned old records (NC-003). PHI access outside care team → break-glass reason (`READ_PHI`).

### 3.7 Complete visit

- `Ctrl+Enter` "Complete" → validates: ≥1 diagnosis (or "no diagnosis" reason), Rx signed or none, follow-up captured or "none" → visit `consult_done` → prints Rx/advice (auto-print policy) → `visit.consult.completed` → OP-005 (post-consult items, e.g. procedure done), OP-001 (follow-up appointment), EN-011 (OPConsultRecord care context), NC-003 (record file), PE-002 (follow-up reminders), EN-030 (feedback survey trigger).
- Exceptions: patient left before completion → nurse marks `left`; doctor may complete later with note; consult "reopened" within 24 h creates addendum version.

### 3.8 Offline / degraded

- PWA caches drug/ICD/test masters (delta sync); consultation drafts and Rx queue in IndexedDB; on reconnect, sync with conflict rule "latest signed wins, drafts merged as new version". CDSS runs client-side with cached rule set (subset: allergy, interactions, dose) and re-validated on server at sign.

## 4. Data Model (schema `clinical`)

- **encounters** (OP visit link): id, hospital_id, branch_id, visit_id (op_visits), patient_id, doctor_id, department_id, type enum(opd/tele/er/ip_consult), status enum(draft/in_progress/completed/amended), started_at, completed_at, chief_complaint_text, notes jsonb (form responses by EN-039 form_id/version), template_id, signed_document_id, version.
- **encounter_diagnoses**: encounter_id, patient_id, icd10_code, icd_version, snomed_id?, description, rank enum(primary/secondary), certainty enum(provisional/confirmed/rule_out), severity, laterality, onset_date, is_chronic, problem_id (→ problems), coded_by, coding_status (doctor/mrd_verified).
- **problems**: patient_id, code, description, status enum(active/resolved/inactive), onset, resolved_at, source_encounter_id.
- **allergies** (owned by EN-029 but written here): patient_id, substance_type enum(drug/food/environment/other), substance_code (molecule/class), reaction, severity enum(mild/moderate/severe/anaphylaxis), verified_by, status(active/inactive), noted_at.
- **medication_lists**: patient_id, drug_id/free_text, dose, frequency, source enum(rx/patient_reported/reconciled), started_at, stopped_at, stop_reason.
- **prescriptions**: id, hospital_id, branch_id, encounter_id, patient_id, doctor_id, rx_no (series `RX`), status enum(draft/signed/amended/cancelled/dispensed/partially_dispensed), version, signed_at, signed_by, sign_method, document_id, pdf_file_id, fhir_bundle_id, is_provisional (unsigned resident), pharmacy_store_id (target), notes.
- **prescription_items**: prescription_id, line_no, drug_id (mdm.drugs), generic_name, brand_name, strength, form, route, dose_qty, dose_unit, frequency_code, frequency_custom jsonb, timing (before/after food), duration_value, duration_unit, quantity, quantity_unit, is_prn, prn_reason, instructions_code[], instructions_text, taper jsonb, refills, do_not_substitute bool, schedule_class enum(none/H/H1/X/narcotic), cdss_alerts jsonb (rule_id, severity, override_reason, overridden_by), status (active/discontinued/dispensed), external_only bool.
- **orders** (generic CPOE header): id, hospital_id, branch_id, encounter_id, patient_id, ordering_doctor_id, order_no (series `ORD`), category enum(lab/radiology/procedure/nursing/referral/admission/diet/physio/other), priority enum(routine/urgent/stat), status enum(draft/placed/acknowledged/in_progress/completed/cancelled/rejected), clinical_notes, diagnosis_codes[], is_billable, billing_status enum(pending/posted/paid/credit/waived), placed_at, cancelled_reason, source enum(opd/er/ip/portal/health_checkup).
- **order_items**: order_id, service_id (mdm.services), test_id/procedure_id/modality_code, qty, laterality, contrast bool, prep_instructions_id, status per item, executed_by_module ref (lab_order_id / rad_order_id), price_snapshot.
- **referrals**: encounter_id, from_doctor_id, to_department_id/to_doctor_id/external_facility, urgency, reason, shared_note, status enum(sent/accepted/seen/replied/closed), reply_text, target_visit_id.
- **clinical_templates**: owner_type enum(personal/department/hospital), owner_id, kind enum(complaint/exam/diagnosis_set/rx_set/order_set/advice/pathway/certificate), specialty_id, name, payload jsonb, is_shared, usage_count, version.
- **clinical_documents** (per 03 conventions): document_id, version, type enum(consult_note/prescription/certificate/referral/order_summary), status(draft/final/amended/cancelled), content jsonb, rendered_pdf_file_id, sha256, prev_sha256, signed_by, signed_at, sign_method.
- **result_acknowledgements**: doctor_id, result_ref (lab_result_id/rad_report_id), critical bool, acknowledged_at, note, patient_informed bool.
- **doctor_preferences**: user_id, default_form_ids, favourite_drugs[], favourite_tests[], hotkeys jsonb, auto_print flags, generic_first bool.
- **cdss_alert_log** (EN-029 owned): encounter_id, rule_id, severity, shown_at, action enum(accepted/overridden/ignored), reason.
  Indexes: (hospital_id, patient_id, started_at desc) on encounters; (hospital_id, doctor_id, started_at desc); prescriptions (hospital_id, status, created_at) for pharmacy queue; orders (hospital_id, category, status, placed_at). Encounter notes jsonb with GIN for template keys. RLS all. Partition `cdss_alert_log` monthly.

## 5. Business Rules & Validations

- Consultation may start only for visits in `waiting_doctor` (or `waiting_vitals` if doctor overrides "see without vitals" — logged). Doctor may only open visits assigned to self/department unless HOD/break-glass.
- Diagnosis mandatory before completion (or reason "symptomatic/undiagnosed"); primary diagnosis exactly one.
- Rx: signed by a doctor with valid registration (NMC/state reg no stored in profile, expiry checked); residents' Rx requires co-sign unless dept config `resident_can_sign` (then flagged); Schedule H1/X and narcotics require diagnosis + max duration (H1: 30 days default; narcotic per state rules) + reason; contraindicated interactions and documented-allergy matches cannot be saved without override reason + second warning; max quantity per line configurable; abbreviations blocklist (NABH: no "U", "QD", trailing zeros) enforced in free-text instruction.
- Paediatric (< 12 y or weight-based flag) requires weight in vitals for weight-based drugs; dose > max mg/kg → block unless override.
- Duplicate lab test within 24 h (same test) → warning; within 1 h → block unless STAT/reason.
- Radiology CT/X-ray on female 12–55: LMP/pregnancy status prompt mandatory (AERB/ALARA justification), stored on order.
- Free-text notes autosaved; final documents immutable; amendments as new versions with reason; printing after amendment shows "Amended v2".
- Timeline access outside care team (not ordering/attending, not same department in last 90 days) → break-glass reason, `READ_PHI` audit.
- Follow-up creation cannot exceed doctor's published schedule horizon; else creates reminder only.
- ICD version per hospital setting (ICD-10 2019 default; ICD-11 mapping table ready); MRD may add/verify codes (`coding_status`) without altering doctor's text.
- Numbering: `RX`, `ORD` per hospital/branch/FY (non-gapless).
- Retention: clinical documents ≥ 10 y adult (NABH/MCI guidance), paediatric until 21 y+; MLC permanent.

## 6. API Surface (`/api/v1`)

| Method       | Path                                              | Purpose                                          | Permission                                                   | Idem | Pag    |
| ------------ | ------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------ | ---- | ------ |
| GET          | /opd/queue?doctor=&date=                          | live queue (read model + socket)                 | opd.queue.read                                               | –    | –      |
| POST         | /opd/queue/{visit}/call, /skip, /requeue          | queue actions                                    | opd.queue.manage                                             | Y    | –      |
| POST         | /encounters                                       | start consult (visit_id)                         | opd.encounter.create                                         | Y    | –      |
| GET          | /encounters/{id}                                  | full encounter                                   | opd.encounter.read                                           | –    | –      |
| PATCH        | /encounters/{id}                                  | autosave notes/forms                             | opd.encounter.update                                         | –    | –      |
| POST         | /encounters/{id}/diagnoses                        | add/replace diagnoses                            | opd.diagnosis.update                                         | Y    | –      |
| POST         | /encounters/{id}/complete                         | complete + sign note                             | opd.encounter.sign                                           | Y    | –      |
| POST         | /encounters/{id}/reopen                           | addendum                                         | opd.encounter.amend                                          | Y    | –      |
| GET          | /patients/{id}/timeline?types=&from=&to=          | timeline                                         | patient.record.read (care team/break-glass)                  | –    | cursor |
| GET          | /patients/{id}/problems, /allergies, /medications | lists                                            | patient.record.read                                          | –    | –      |
| POST         | /patients/{id}/allergies                          | add allergy                                      | opd.allergy.update                                           | Y    | –      |
| GET          | /drugs/search?q=&store=                           | drug search w/ stock                             | rx.drug.search                                               | –    | –      |
| POST         | /prescriptions                                    | create/update draft                              | rx.create                                                    | Y    | –      |
| POST         | /prescriptions/{id}/cdss-check                    | run rules for line set                           | rx.create                                                    | –    | –      |
| POST         | /prescriptions/{id}/sign                          | sign → pharmacy                                  | rx.sign                                                      | Y    | –      |
| POST         | /prescriptions/{id}/amend, /cancel                | new version / cancel                             | rx.amend / rx.cancel                                         | Y    | –      |
| GET          | /prescriptions/{id}/pdf                           | rendered PDF                                     | rx.print                                                     | –    | –      |
| POST         | /orders                                           | place order(s) (lab/rad/proc/referral/admission) | order.create                                                 | Y    | –      |
| PATCH        | /orders/{id}/cancel                               | cancel with reason                               | order.cancel                                                 | Y    | –      |
| GET          | /orders?patient=&category=&status=                | list                                             | order.list                                                   | –    | cursor |
| GET          | /doctor/inbox                                     | results/critical/co-sign/referrals               | opd.inbox.read                                               | –    | cursor |
| POST         | /results/{ref}/acknowledge                        | ack critical/normal                              | opd.result.acknowledge                                       | Y    | –      |
| GET/POST/PUT | /clinical-templates                               | manage templates                                 | opd.template.manage (personal) / opd.template.publish (dept) | Y    | cursor |
| GET          | /icd/search?q=, /snomed/search?q=                 | terminology                                      | terminology.read                                             | –    | –      |
| POST         | /encounters/{id}/certificates                     | generate certificate doc                         | opd.certificate.create                                       | Y    | –      |
| GET/PUT      | /doctor/preferences                               | prefs                                            | opd.preferences.manage                                       | –    | –      |

## 7. Domain Events

- `visit.consult.started` {visit_id, doctor_id} → OP-001 status, EN-018 TV ("In consultation").
- `visit.consult.completed` {visit_id, encounter_id, diagnoses[], follow_up} → OP-005 (post-consult charges), OP-001 (follow-up appointment), NC-003, EN-011 (care context OPConsultRecord), PE-002, EN-030.
- `rx.created` / `rx.amended` / `rx.cancelled` {rx_id, patient_id, items[], target_store} → OP-003 queue, OP-020 patient app, EN-009 WhatsApp PDF, EN-011 (Prescription bundle).
- `order.lab.created`, `order.rad.created`, `order.procedure.created`, `order.referral.created`, `order.admission.requested`, `order.cancelled` → OP-004/OP-008/OP-039/OP-010/OP-021/IP-001, OP-005 (charge post/reverse), EN-002 (pre-auth need).
- `diagnosis.recorded` {patient_id, codes[]} → analytics (morbidity), NC-015 (notifiable disease flag → IDSP register), PE-003 (education).
- `allergy.recorded` → EN-029 cache, patient banner (all modules).
- `result.acknowledged` → OP-004/OP-008 closure of critical loop.
- `encounter.break_glass` → EN-024 privacy report.

## 8. Screens

- **Doctor home / live queue** (desktop, tablet): left queue list (filters: my rooms, waiting/called/in-consult/completed), centre patient card preview with vitals chips, right inbox counts. Hotkeys: `Space` call next, `Enter` start, `S` skip, `/` search patient. Real-time socket; empty state "No patients waiting — next appointment 10:30".
- **Consultation workspace** (desktop 3-pane: timeline rail | note editor tabs [Complaint · History · Exam · Dx · Plan · Rx · Orders] | context rail [vitals graph, allergies, active meds, last labs, alerts]; tablet 2-pane; phone: stacked tabs). Hotkeys: `Alt+1..7` tabs, `Alt+R` Rx, `Alt+L` lab, `Alt+I` imaging, `Alt+D` diagnosis search, `Ctrl+S` save, `Ctrl+Enter` complete/sign, `Ctrl+P` print, `Ctrl+T` template picker, `Ctrl+K` command palette. Voice dictation button (Phase 12 AI-004). Autosave indicator; offline banner with queued state.
- **e-Rx grid**: spreadsheet-like rows; inline CDSS chips (red/orange/yellow) with click-to-explain; stock/price column; generic/brand toggle; template apply modal.
- **Order composer**: catalogue tree + search; cart with priority, prep flags, estimated cost (RC-008), insurance coverage hint.
- **Doctor inbox**: tabs Critical (blocking until acknowledged, red), Results, Co-sign, Referrals, Drafts.
- **Timeline** (desktop/tablet/phone): vertical timeline with type filters, trend graphs (Recharts), document viewer, image thumbnails → OHIF.
- **Template manager**: personal/department; JSON-free editor; share/publish (HOD).
- **HOD department view**: all doctors' queues, wait heatmap, redistribute drag-drop, prescribing quality widgets.
- **Print/PDF**: Rx (A5/A4, letterhead, generic caps, QR verify, NMC reg), advice sheet in patient language, certificates, referral letter, order requisition with barcode.
  Empty/error states everywhere; skeletons; TTI < 2.5 s on tablet.

## 9. Integrations

- EN-027 masters: drug master (CIMS/own, molecule↔brand, HSN, schedule), ICD-10/11, SNOMED CT (India NRC licence), LOINC (lab), service catalogue; nightly delta sync to PWA cache.
- EN-029 rules engine (interaction DB source: hospital-licensed e.g. CIMS/Medscape/DrugBank open subset — vendor decided in Q16), dose ranges, allergy classes.
- OP-003 stock lookup (Redis cache of `stock_on_hand` per store), OP-004/OP-008 order APIs (internal events), OP-005 charge posting, EN-011 (OPConsultRecord/Prescription FHIR R4 bundles per ABDM HI types), EN-016 e-sign, EN-009 WhatsApp PDF, EN-018 TV token call, EN-039 forms, PE-003 education library, AI-004 voice (later), OP-018 telemedicine (same workspace in video mode).
- Fallbacks: **the allergy hard-stop and the contraindicated-interaction hard-stop never degrade.** Both evaluate against locally-cached data (the patient's `clinical.allergies` list and the offline interaction subset of §3.8), so if the EN-029 service or the licensed interaction database is unreachable, those two checks still run and still block; only the _vendor-database-dependent_ checks (full interaction severity grading, dose-range tables, Beers/pregnancy categories) degrade to a banner "CDSS partially offline — manual check required for dose/interaction" plus an audit flag and a `cdss_degraded=true` marker on every Rx signed in that window (surfaced to the pharmacist in OP-003 and re-validated on the server at the next sync). If the cached allergy list itself cannot be read, signing is blocked. Pharmacy socket down → Rx still visible via polling queue.

## 10. Reports & Analytics

- Doctor productivity (patients/hour, avg consult time, documentation completeness), diagnosis mix (ICD top-N, morbidity register, notifiable diseases), prescribing audit (generic %, antibiotic %, injections %, avg drugs/Rx — WHO/INRUD indicators, H1 drug register), CDSS override rate by rule/doctor, order patterns (tests per visit, high-cost imaging justification), referral TAT, follow-up adherence, template usage, unsigned drafts aging, critical value acknowledgement time.
- Read models: `analytics.mv_opd_encounter_daily`, `analytics.mv_prescribing_indicators`, `analytics.mv_dx_morbidity` (refresh 15 min / nightly).

## 11. Notifications

- Patient: e-Rx PDF + advice + follow-up date via WhatsApp/SMS (DLT template), education links, "your test order & prep instructions"; portal push.
- Doctor: critical result push (EN-037: in-app + push + SMS escalation to on-call if unacknowledged 15 min), co-sign requests, referral received, pre-auth query, unsigned drafts at day end.
- Pharmacy/Lab/Radiology: new order/rx via socket + bell.
- HOD: queue wait > threshold, doctor idle/no-show alerts.

## 12. Permissions

`opd.queue.read|manage`, `opd.encounter.create|read|update|sign|amend`, `opd.diagnosis.update`, `opd.allergy.update`, `rx.drug.search`, `rx.create|sign|amend|cancel|print|cosign`, `rx.schedule_x.prescribe`, `order.create|list|cancel`, `order.admission.request`, `opd.inbox.read`, `opd.result.acknowledge`, `opd.template.manage|publish`, `opd.certificate.create`, `opd.preferences.manage`, `terminology.read`, `patient.record.read` (+ABAC `care_team_only`, break-glass), `opd.department.view` (HOD), `opd.audit.read`.
Defaults: Consultant: all except template.publish (HOD) & department.view; Resident: create/update/rx.create (sign per config), no schedule_x unless granted; Nurse OPD: queue.read/manage, encounter.read, rx.print; MRD: encounter.read, diagnosis.update (coding); Pharmacist: rx read via OP-003; Auditor: read.

## 13. Non-functional

- Volumes: 5000 consults/day, 300 concurrent doctors, 20k Rx lines/day, 15k orders/day; peak 400 consults/hour.
- p95: queue load < 150 ms, drug search < 120 ms (Redis + trgm), CDSS check < 100 ms per line, sign+PDF enqueue < 300 ms (PDF async ≤ 3 s), timeline first page < 250 ms.
- Offline: drafts + Rx queue in IndexedDB; masters cached (drug ≈ 40k rows, ICD ≈ 14k, tests ≈ 2k) with versioned delta; conflict rules as §3.8.
- Printing: A4/A5 laser via browser/PDF; auto-print on complete (per doctor pref); ESC/POS not used here.
- Accessibility: full keyboard operation, ARIA live regions for CDSS alerts, colour + icon (not colour alone) for severity; font scaling.
- i18n: UI in en/hi/ta/te/ml/kn/mr/bn; patient-facing advice phrasebook multilingual; Rx clinical content stays English + patient-language instruction lines.
- Security: PHI never in URL query beyond opaque ids; break-glass; documents hash-chained; PDF QR verify endpoint public but returns only validity + doctor + date.

## 14. Acceptance Criteria

1. Given a checked-in visit with vitals captured, when the doctor opens the queue, then the card shows vitals with abnormal chips and clicking Start sets visit `in_consult` and emits `visit.consult.started` within 200 ms.
2. Given a patient with documented penicillin allergy, when Amoxicillin is added to Rx, then a hard-stop modal appears; saving without override reason is impossible; with reason, `cdss_alert_log` records override and the Rx line stores the alert.
3. Given Warfarin on active med list, when Aspirin is added, then a major interaction warning requires acknowledgement; contraindicated pairs (e.g. Sildenafil + Nitrates) block unless override with reason by consultant (residents cannot override).
4. Given paediatric patient 12 kg, when Paracetamol 500 mg TDS is entered, then dose-per-kg warning shows and suggests 15 mg/kg.
5. Given a resident signs an Rx in a department with `resident_can_sign=false`, then Rx remains `provisional`, pharmacy sees it as "awaiting co-sign" and cannot dispense; consultant co-sign releases it and emits `rx.created`.
6. Given Rx signed, then PDF prints generic name in caps with brand in brackets, doctor reg no, QR; pharmacy queue shows the Rx within 1 s (socket) and patient receives WhatsApp PDF within 60 s.
7. Given a lab order for CBC placed 30 min ago, when CBC is ordered again non-STAT, then the system blocks with reason prompt.
8. Given a CT order on a 30-year-old female, then LMP/pregnancy status prompt is mandatory before placing.
9. Given a completed encounter, when the doctor edits, then a new version is created with reason; original remains retrievable and PDF shows "Amended".
10. Given a doctor from another department opens a patient not in care team, then a break-glass reason modal appears and `READ_PHI` audit is written.
11. Given a critical lab result arrives, then it appears in the doctor inbox as blocking modal on next action; if not acknowledged in 15 min, escalation notification goes to on-call/HOD; acknowledgement stores time and closes loop in OP-004.
12. Given offline mode for 10 minutes, when doctor writes notes and Rx for 3 patients, then on reconnect all sync, server CDSS re-validates, and any new hard-stops are surfaced before final sign.
13. Given a follow-up in 7 days selected, then an appointment is created in the doctor's published schedule (or reminder if beyond horizon) and the advice sheet prints the date.
14. Given a template "Viral fever adult" applied, then Rx lines and advice populate; the doctor edits a dose; template itself unchanged; usage_count increments.
15. Given HOD view, then all department doctors' queues and average waits render from the read model in < 300 ms with live updates.
16. Given completion without any diagnosis, then completion is blocked until a diagnosis or a "no diagnosis" reason is provided.
17. Given prescribing indicators report for a month, then generic %, antibiotic %, avg drugs/Rx match a manual sample of 50 prescriptions.
18. Given `Alt+R`, `Alt+L`, `Ctrl+Enter` are pressed, then the corresponding panels/actions occur without mouse use (Playwright keyboard test).

## 15. Enhancements / Later phases

- From VIMS sheet: AI clinical decision support (drug–diagnosis) → AI-002 (Phase 12); voice-to-text clinical notes → AI-004; Smart Rx auto-suggest per diagnosis (rules-based lists Phase 2, AI Phase 12); clinical pathway templates per diagnosis (IP-020 + order sets Phase 2 basic); patient education auto-share post-diagnosis (PE-003, Phase 10; WhatsApp link Phase 2 basic); multi-specialty referral with shared notes (Phase 2 internal, OP-021 Phase 8 external).
- (market) Automatic EMR prompts/"docket" (MocDoc) → context rail reminders (due vaccinations, chronic follow-ups); charts & certificates library (MocDoc); AI background-removed doctor signature images (SmartHospital) → signature asset upload; 500-drug autocomplete → full drug master with stock; review & reminder management (MocDoc) → PE-002; ICD/CIMS/SNOMED integration (Aosta); digital notes/voice recognition (Aosta) → AI-004; scribe mode; growth charts (OP-033); telemedicine mode (OP-018).

## 16. Open Questions for the Hospital

1. Drug interaction/dose database licence (CIMS/Medscape/DrugBank/other) — which vendor, or start with hospital-curated list?
2. Generic-first printing policy: generic caps mandatory (NMC) with brand in bracket, or brand primary?
3. Can residents sign prescriptions/orders without co-sign? Per department?
4. Specialty form sets needed at go-live (list departments) and existing paper case-sheet formats to replicate via EN-039.
5. Consultation completion rules: is diagnosis mandatory for every visit? Any mandatory fields for NABH audits (e.g. pain score, allergy verified)?
6. Auto-print behaviour: Rx print at doctor room, nurse station, or only WhatsApp/portal?
7. Follow-up policy: free review days per doctor/department; auto-appointment vs reminder.
8. Order payment policy: lab/radiology orders payable before execution for self-pay? Exceptions (ER, IP, credit)?
9. Which specialties need photo capture/body map at go-live (derm, wound, ortho)?
10. Break-glass policy: who counts as care team (department-wide? last N days?) and reporting cadence to DPO.
11. ICD-10 vs ICD-11 preference; SNOMED CT licence status; MRD coding workflow (post-visit verification)?
12. e-Sign: system signature with reg no sufficient, or DSC/Aadhaar eSign for prescriptions/certificates?
