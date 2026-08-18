# IP-002 — Discharge & Summary (planning, readiness, checklist, medication reconciliation, versioned discharge summary, ABDM FHIR bundle, final bill hand-off, follow-up, DAMA/LAMA/death/absconded/transfer)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-002 |
| Phase | 7 |
| Priority | P0 |
| Complexity | High |
| Depends on | IP-001 (admission, bed release), IP-003 (nursing checklist, pending tasks, MAR), IP-005 (final bill/clearance), IP-010 (mobile initiation), OP-002 (CPOE orders, diagnoses, e-Rx engine for discharge medications), OP-003/IP-014 (take-home medicines, ward returns), OP-004/OP-008 (pending results), IP-006 (procedure records), IP-007 (transfusion records), IP-017 (death/mortuary), IP-018 (inter-facility transfer), EN-028 (DAMA/consents), EN-016 (digital signature), EN-039 (summary templates), EN-011 (ABDM M2 HIP push — DischargeSummary), EN-019 (FHIR/HL7 ADT^A03), EN-009/EN-032 (messages), PE-001 (portal), PE-002 (follow-up calls/reminders), OP-001 (follow-up appointment), NC-003 (MRD coding/deficiency), NC-013 (ambulance/transport at discharge), EN-030 (discharge survey), EN-038 (approvals), EN-024 (audit), NC-015 (quality indicators) |
| Feature flag | `module.ip_discharge.enabled` (sub: `discharge.readiness_score`, `discharge.abdm_push`, `discharge.transport`, `discharge.lounge`, `discharge.survey`, `discharge.remote_monitoring`) |
| Primary roles | Doctor — IP (7), Resident (14, co-sign), Nurse — Ward (17), Billing Executive IP (27), MRD Officer (43) |
| Secondary roles | Surgeon (9), Intensivist (11), Pharmacist IP (31), Insurance/TPA desk (28), Cashier (26), Dietician (39), Physiotherapist (40), Nurse Supervisor (22), Housekeeping (50), Bed manager (IP-025), Quality (54), MS (4), Patient/Family (59/60), Referring doctor (15), Auditor (58) |
| Regulatory | NABH 5th ed. AAC.13 (discharge process, summary contents: reason for admission, significant findings, diagnosis, procedures, treatment, condition at discharge, medications, follow-up, when to seek help), AAC.14 (LAMA/DAMA documentation), COP (death), MCI/NMC Code of Ethics (records within 72 h; discharge summary on request), ABDM V3 HIP — FHIR R4 **DischargeSummaryRecord** bundle (Composition + Patient + Encounter + Condition + Procedure + MedicationRequest + Observation + DocumentReference), IRDAI cashless discharge TAT (final bill/discharge authorisation within 3 h per 2024 master circular), Registration of Births & Deaths Act 1969 / CRS (Form 2 death report → IP-017), MTP/CrPC (MLC death → inquest), DPDP (summary sharing consent), GST (final invoice) |

## 1. Purpose
IP-002 takes an admitted patient from "discharge planned" to "left the hospital with documents, medicines, bill settled and follow-up booked", safely and fast. It runs discharge planning and readiness (clinical, nursing, pharmacy, billing gates), the checklist, medication reconciliation (admission vs inpatient vs discharge lists), the versioned and digitally signed discharge summary (auto-populated from the record, template per department, ABDM FHIR bundle), non-routine exits (DAMA/LAMA, absconded, death, transfer-out, referred), the hand-off to IP-005 for final bill and clearance, follow-up scheduling and post-discharge calls, and bed release to IP-001. Everything is timed so the hospital can measure discharge TAT (decision → physically out) — the KPI patients notice most.

## 2. Users & Jobs-to-be-done
- **IP doctor / consultant** (desktop rounds cart, tablet, phone via IP-010): decide "fit for discharge" (often the evening before), initiate discharge with expected time, complete/sign the summary in ≤ 5 min from a pre-filled draft, prescribe discharge medications with reconciliation, set follow-up plan; approve DAMA counselling notes; certify death.
- **Resident/junior**: draft the summary; senior co-signs.
- **Ward nurse** (nursing station desktop/tablet): nursing discharge checklist (lines/catheters removed, belongings, wound care taught, medicines handed over, wristband cut, transport), discharge education with teach-back, vitals at discharge, ward pharmacy returns, hand summary and appointment card.
- **Ward pharmacist** (desktop): reconcile discharge medications, dispense take-home pack (OP-003), unit-dose returns (IP-014).
- **Billing executive / TPA desk** (desktop): receive `discharge.initiated`, close pending charges, final bill, TPA final authorisation, settlement, clearance → gate pass.
- **MRD** (desktop): coding completeness (ICD-10 principal/secondary, procedures ICD-9-CM/ICHI), summary version final, deficiencies, indoor register, mortality data.
- **Bed manager/housekeeping**: expected discharge lists, bed release timing.
- **Patient/family** (phone/portal/kiosk): expected discharge time, bill status, summary PDF, medicines list, follow-up appointment, transport option, feedback.
- **Quality**: discharge TAT, readmissions ≤ 30 d, DAMA rate, summary completeness audit, death review.

## 3. Core Workflows

### 3.1 Discharge planning (from admission)
1. **Doctor/nurse** maintains `expected_discharge_at` (IP-001) and a **discharge plan** (destination: home/other hospital/rehab/hospice, needs: oxygen, wheelchair, home nursing, physio, dietary; caregiver identified; language) from day 1; **System** shows "Expected discharges tomorrow" list to ward, pharmacy, billing (pre-final-bill review) and bed manager (IP-025) → Event `ip.discharge.expected` (daily 18:00 job + on change).
2. **Readiness score** (`discharge.readiness_score`, rules-based): pending investigations, active IV meds, NEWS2 ≤ 2 for 12 h, afebrile 24 h, mobility, oral intake, pain controlled, pending consults, pending pre-auth/enhancement, bill status → shows traffic-light readiness on ward dashboard (IP-003) and rounds list (IP-010).

### 3.2 Discharge initiation (doctor)
1. **Doctor** clicks *Initiate discharge* (desktop/IP-010) → chooses discharge type (`routine`, `referred/transfer_out`, `dama/lama`, `absconded`, `death`, `day_care_complete`), condition (`recovered/improved/unchanged/deteriorated`), expected exit time, follow-up plan draft.
2. **System** runs **gate checks** and shows blockers/warnings: open orders (labs collected but not reported; imaging pending; pending consults), active infusion/scheduled meds beyond exit time, unsigned procedure/op notes (IP-006), pending transfusion documentation (IP-007), unresolved critical results not acknowledged, blood in cross-match reserve (release), implants not documented (TR-003), pending pre-auth/enhancement (RC-002), unbilled services (RC-006 charge capture check), MLC pending police intimation, DPDP consent for ABDM push. Blockers configurable as hard/soft per hospital.
3. Confirm → admission `status=discharge_initiated` (bed tile yellow) → Event `ip.discharge.initiated` {type, expected_at} → IP-005 (start final bill; stop future auto-postings after exit; open pending charges review), IP-003 (nursing checklist task), OP-003/IP-014 (return unused ward stock; prepare take-home), OP-011 (stop diet after exit), IP-001 (expected release), EN-018/IP-025, EN-009 (family: "discharge planned around HH:MM; billing will contact").
4. Doctor can **revoke** initiation (patient deteriorates) → status back to `admitted`, Event `ip.discharge.revoked` (IP-005 resumes postings, checklists reset).

### 3.3 Medication reconciliation & discharge prescription
1. **System** builds three columns: (a) pre-admission home medications (from OP-001/OP-002 history & admission nursing assessment), (b) current inpatient active medications (CPOE/MAR), (c) proposed discharge medications → for each item **Doctor** chooses continue / modify / stop / new with reason (mandatory for stop of a home medication and for high-alert drugs) → duplicates/interactions/allergy checks by EN-029; renal/hepatic dose flags; total pill burden count.
2. Discharge prescription = OP-002 e-Rx object (dose, route, frequency, duration, quantity, instructions in local language, timing icons for low literacy) → sent to pharmacy for take-home pack (OP-003 dispense against IP bill or separately per policy) → Event `ip.discharge.medications_reconciled`.
3. Pharmacist verifies pack, prints medication schedule card (pictorial), records counselling done; controlled substances follow NDPS rules.

### 3.4 Nursing discharge checklist & education
- Checklist template (EN-039, per ward type): IV cannula/central line/urinary catheter/drains removed or handover instructions, wound dressing & next change date, home care teaching (teach-back documented), diet advice given, activity restrictions, warning signs & helpline, medicines handed over & explained, valuables/belongings returned (IP-001 receipt), wristband removed at exit, mobility aid, transport arranged (`discharge.transport`: ambulance NC-013 / wheelchair), vitals at discharge (NEWS2), skin check (Braden), pending reports delivery method (portal/courier), consent for follow-up calls; each item done/NA/by/at; nurse signs → Event `ip.discharge.nursing_cleared`.

### 3.5 Discharge summary (versioned document)
1. **System** pre-fills template (department-specific; EN-039) from the record: patient identifiers, admission/discharge dates & times, admitting & discharging consultants/units, reason for admission/presenting complaints, history summary, significant findings (exam), diagnoses (principal + secondary ICD-10 from CPOE; SNOMED optional), comorbidities, procedures/surgeries with dates & operators (IP-006 op notes, implants with UDI/serial from TR-003), anaesthesia type, key investigations (curated: latest + abnormal + trend table for selected analytes; imaging impressions), transfusions (units/components/reactions), treatment given (major drugs/courses), hospital course (free text/dictation AI-004 later), condition at discharge, vitals at discharge, discharge medications (from 3.3), diet, activity, wound care, when to seek urgent care (red flags), follow-up plan (dates, doctor, tests to repeat), pending reports, contact numbers, MLC/insurance notes as configured; multilingual patient-instruction section.
2. **Resident** edits draft (`clinical.documents` type `discharge_summary`, status draft v1) → **Consultant** reviews → **Sign** (EN-016 e-sign/DSC or hash-based signature per hospital policy) → status `final`, immutable, PDF rendered (letterhead, QR to verify), sha256 chain → Event `ip.discharge.summary_signed` {document_id, version}.
3. **Amendment** after final: new version with reason (typo, missed result, coding correction) → `amended` marks previous as superseded; both retained; PDF re-issued and portal shows latest with version badge; ABDM bundle re-pushed as new document version.
4. **ABDM push** (`discharge.abdm_push`): on sign, if patient's ABHA is linked and consent artefact allows, EN-011 builds FHIR R4 `DischargeSummaryRecord` bundle (Composition type LOINC 18842-5, sections: chief complaints, physical exam, allergies, medical history, family history, investigations, medications, procedures, care plan, follow-up, document reference PDF) and links to the care-context.
5. Delivery: PDF to patient portal/WhatsApp (EN-009 document template with consent), email; printed copies (count logged); referring doctor copy (PE-007) with consent.

### 3.6 Final bill hand-off & clearance (with IP-005)
1. After `ip.discharge.initiated`, IP-005 shows pending charges review; ward posts last consumables; pharmacy returns credited; doctor visit charges up to exit; room rent per rule (checkout hour) → billing prepares **final bill**; TPA cases: final pre-auth/enhancement, discharge authorisation from insurer (IRDAI 3-h target timer visible), patient share collection; self-pay: settle or approve credit; refund of excess deposit (NC-001) → IP-005 emits `ip.bill.cleared` {admission_id, mode} → IP-002 shows "Billing cleared" ✓; **gate pass** (EN-015) generated for security with QR; wristband removal.
2. Configurable policy: summary release before/after bill clearance (default: summary handed with clearance; emergency/medico-legal exceptions), "discharge under protest" flow when patient disputes bill (approval by MS, credit note/legal flag).

### 3.7 Physical discharge, bed release, follow-up
1. **Nurse** marks *Patient left* (time, mode of transport, escorted by) → admission `status=discharged`, `discharged_at` → Event `ip.discharge.completed` {type, condition, discharged_at, destination} → IP-001 releases bed (housekeeping), IP-005 locks bill (no further postings; late charges only via credit-note/supplementary bill with approval), NC-003 opens coding/deficiency task (summary final? ICD coded? consent scanned?), EN-019 ADT^A03, EN-011 care-context, PE-002 schedules post-discharge call at day 3 (configurable 24 h/3 d/7 d scripts) & readmission watch 30 d, EN-030 discharge satisfaction survey (WhatsApp) after 24 h, IP-025.
2. **Follow-up**: doctor's plan auto-creates OP-001 appointment(s) (slot search by consultant, or "to be scheduled" recall list) → appointment card printed / sent; reminders per PE-002; repeat investigations pre-ordered (OP-004/OP-008 future orders).
3. **Post-discharge remote monitoring** (`discharge.remote_monitoring`, later): symptom check-ins via patient app (OP-020), vitals from home devices; escalations to PE-002 nurse.

### 3.8 DAMA / LAMA, absconded, referred, death
- **DAMA/LAMA**: doctor documents counselling (risks explained, in language, witness), patient/attendant signs DAMA consent (EN-028 template; refusal to sign documented with two witnesses), summary marked `discharge_type=dama`, medications/instructions still provided, MS/quality notified, insurer informed (claim implications), bill settled per policy; DAMA rate KPI.
- **Absconded**: nurse reports missing > configurable minutes → security search (NC-019), attendant contact attempts logged, police intimation if MLC/psychiatric/minor, MS informed; after policy time admission closed as `absconded`, bill remains open in AR (RC-005), summary "left without notice".
- **Referred/transfer-out**: IP-018 handles receiving-hospital coordination, transfer summary (interim summary version), ambulance (NC-013), documents; IP-002 closes with `transferred_out`.
- **Death**: doctor certifies time/cause (ICD-10 underlying/antecedent/immediate per WHO Form 4/4A — MCCD), brain-death path (IP-009), MLC → police, post-mortem flag; **death summary** template; IP-017 mortuary/body handover and CRS death registration; bill settlement per policy (often compassionate hold), family communication script; mortality review task to quality (NC-015).
- **Day-care complete**: short summary template; same event set.

### 3.9 Discharge lounge, transport & documents pack
1. When the bed is needed and the patient is clinically cleared but waiting for bill/medicines/transport, **Nurse** moves the patient to the **discharge lounge** (IP-001 location `discharge_lounge`; bed released early → housekeeping) with the lounge nurse accepting handover; timers show lounge waiting time (KPI) — flag `discharge.lounge` (also used by IP-025).
2. **Transport** (`discharge.transport`): family selects own vehicle / hospital ambulance (NC-013 booking with ETA & charges to IP-005) / wheelchair assistance / hearse (death); escort staff assigned; gate pass includes transport mode.
3. **Documents pack** auto-assembled as one PDF bundle for the patient: discharge summary, medication schedule card, follow-up card, final bill & receipts, key reports (as selected), consent copies on request, insurance claim acknowledgement, fitness/leave certificate (template), sick-leave certificate for employer (EN-039) — delivered to portal & printed on request; MRD copy archived (NC-003) with hash.

### 3.10 Statutory & quality outputs
- Indoor register updated with discharge/outcome (IP-001 §3.9); death register & MCCD to CRS (IP-017); MLC discharge intimation to police where required (TR-008); NABH indicators (discharge TAT, DAMA %, readmission %, mortality) computed nightly; monthly mortality & morbidity list to committee (NC-015).

### 3.11 Exceptions
1. Patient deteriorates after clearance but before leaving → revoke (bill re-opened via IP-005 "reopen" with approval, audit).
2. Late lab result after discharge → result routed to discharging doctor (OP-004 post-discharge critical value protocol) → amendment version if needed; PE-002 call.
3. Summary signed by resident only → policy may require consultant co-sign within 24 h; unsigned > 24 h after discharge → escalation to HOD/MRD deficiency.
4. Insurer discharge authorisation delayed > 3 h → timer breach alert to TPA desk lead; patient informed; option "discharge with undertaking" per policy.
5. Patient refuses take-home medications/pharmacy → documented; e-Rx still issued.
6. Offline (ward tablet): checklist entries queue; summary editing requires connectivity (documents are server-versioned) but drafts autosave locally.

## 4. Data Model (schema `ip`; documents in `clinical`)
- **ip.discharge_plans** (id, hospital_id, branch_id, admission_id unique, destination enum(home/other_hospital/rehab/hospice/other), needs jsonb, caregiver jsonb, expected_at, readiness_score int, readiness_components jsonb, updated_by, version).
- **ip.discharges** (id, hospital_id, branch_id, admission_id unique, type enum(routine/day_care/referred/transfer_out/dama/lama/absconded/death), condition enum(recovered/improved/unchanged/deteriorated/died), initiated_by, initiated_at, expected_exit_at, revoked_at?, revoke_reason, gate_check_result jsonb, nursing_cleared_at, nursing_cleared_by, pharmacy_cleared_at, billing_cleared_at, billing_mode enum(cash/credit/tpa/scheme/mixed), gate_pass_id, left_at, transport_mode enum(own/ambulance/wheelchair/hearse), escorted_by, summary_document_id, summary_version int, dama_consent_id?, death_cert_id?, mccd jsonb?, mlc bool, status enum(initiated/nursing_cleared/billing_cleared/completed/revoked), audit cols). Index (hospital_id, status, initiated_at).
- **ip.discharge_checklists** (discharge_id, template_id, items jsonb [{code, label, status done/na, by, at, note}], signed_by, signed_at, version).
- **ip.medication_reconciliations** (discharge_id, items jsonb [{source home/inpatient/new, drug_id, name, dose, route, freq, decision continue/modify/stop/new, reason, cds_flags}], reconciled_by, reconciled_at, erx_id (OP-002), pharmacist_verified_by, counselled_at).
- **clinical.documents** (existing versioned store) with `type=discharge_summary|death_summary|dama_summary|transfer_summary`, `admission_id`, `template_id`, `content jsonb` (structured sections), `rendered_pdf_file_id`, `status draft/final/amended/cancelled`, `signed_by`, `signed_at`, `signature_ref`, `sha256`, `prev_sha256`, `version`; **clinical.document_shares** (document_id, channel enum(portal/whatsapp/email/print/abdm/referrer), recipient, consent_id, sent_at, status).
- **ip.follow_up_plans** (discharge_id, items jsonb [{type appointment/test/procedure/call, when, consultant_id, order_ids, appointment_id}], created_at).
- **ip.dama_records** (discharge_id, counselled_by, counselled_at, risks_explained text, language, witness1, witness2, patient_signed bool, refused_to_sign bool, consent_id).
- **ip.absconding_records** (admission_id, noticed_at, reported_by, security_informed_at, police_informed_at?, attendant_contacts jsonb, closed_at).
- **ip.death_records** (admission_id, declared_at, declared_by, cause_immediate, cause_antecedent[], underlying_cause, icd_codes[], manner enum(natural/unnatural/undetermined), mlc bool, post_mortem bool, brain_death bool, mccd_form_no, informed_relative, mortuary_handover_id (IP-017)).
- **ip.discharge_events** (discharge_id, event, at, by) — timeline for TAT analytics.
- Read model **analytics.mv_discharge_tat** (admission_id, initiated_at, nursing_cleared_at, billing_cleared_at, left_at, durations, type, ward, payer).

## 5. Business Rules & Validations
- Only the treating consultant (or delegated resident with co-sign) can initiate/sign; death certification only by a registered doctor; DAMA requires counselling record + consent (or refusal witnessed).
- Gate checks: hard blockers by default — unacknowledged critical result, unsigned op note, active blood reserve, unresolved MLC intimation, no diagnosis coded (ICD-10 principal); soft — pending non-critical results (documented as "to follow"), unbilled items (RC-006 warns billing).
- Summary must contain NABH AAC.13 mandatory sections before signing (validation on template `required=true` sections); ICD-10 principal diagnosis mandatory; procedures with dates; discharge medications from reconciliation only (free-text meds not allowed unless "external medicine" flagged).
- Signed summary immutable; amendments create versions with reason; PDF carries version and QR verification link; ABDM re-push on amendment; retention ≥ 10 y (longer for MLC/paediatric per policy).
- Order of clearances configurable; default: nursing → pharmacy → billing → left; `left_at` cannot precede `billing_cleared_at` unless "discharge under protest/emergency" override by MS.
- Room-rent cutoff: charges stop at `left_at` or checkout hour per IP-005 rule, whichever the hospital configures; late departure beyond grace (e.g. > 2 h after clearance) may add half-day per policy — IP-005 handles, IP-002 supplies timestamps.
- Follow-up appointment auto-booked only if slot rules allow; else recall list entry; SMS/WhatsApp only with consent.
- Post-discharge call at day 3 (configurable) with script; readmission ≤ 30 d links to prior discharge and prompts root-cause form (quality).
- Death: MCCD fields validated (no "cardiac arrest" as underlying cause), MLC death blocks body release until police clearance (IP-017), brain death via IP-009 protocol.
- Absconded: closure only after policy wait (default 6 h) and security/attendant steps documented; bill stays open in AR.
- All actions audited with reason; summaries never deleted; PHI shares logged with consent id.

## 6. API Surface (`/api/v1/ip/discharge`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/PUT | /admissions/{id}/plan | discharge plan & readiness | ip.discharge.plan | Y | – |
| GET | /expected?date=&ward= | expected discharges list | ip.discharge.read | – | cursor |
| POST | /admissions/{id}/initiate | initiate (type, expected_exit_at) | ip.discharge.initiate | Y | – |
| GET | /admissions/{id}/gate-checks | blockers/warnings | ip.discharge.read | – | – |
| POST | /discharges/{id}/revoke | revoke initiation | ip.discharge.initiate | Y | – |
| GET/PUT | /discharges/{id}/reconciliation | medication reconciliation | ip.discharge.reconcile | Y | – |
| POST | /discharges/{id}/reconciliation/verify | pharmacist verification | ip.discharge.pharmacy_clear | Y | – |
| GET/PUT | /discharges/{id}/checklist | nursing checklist | ip.discharge.nursing_clear | Y | – |
| POST | /discharges/{id}/checklist/sign | nursing clearance | ip.discharge.nursing_clear | Y | – |
| GET | /discharges/{id}/summary/prefill | template + auto-populated content | ip.discharge.summary.write | – | – |
| POST/PUT | /discharges/{id}/summary (draft versions) | save draft | ip.discharge.summary.write | Y | – |
| POST | /discharges/{id}/summary/sign | finalise & sign | ip.discharge.summary.sign | Y | – |
| POST | /discharges/{id}/summary/amend | new version | ip.discharge.summary.amend | Y | – |
| GET | /discharges/{id}/summary/versions, /summary/{v}/pdf | history / PDF | ip.discharge.read | – | – |
| POST | /discharges/{id}/summary/share | portal/whatsapp/email/referrer/abdm | ip.discharge.share | Y | – |
| POST | /discharges/{id}/dama | DAMA record + consent | ip.discharge.dama | Y | – |
| POST | /discharges/{id}/death | death record/MCCD | ip.discharge.death | Y | – |
| POST | /admissions/{id}/absconded | absconding record/close | ip.discharge.absconded | Y | – |
| POST | /discharges/{id}/follow-up | create follow-up items/appointments | ip.discharge.followup | Y | – |
| POST | /discharges/{id}/left | patient physically left | ip.discharge.complete | Y | – |
| GET | /discharges?status=&ward=&type=&from= | worklist | ip.discharge.read | – | cursor |
| GET | /reports/tat, /reports/dama, /reports/readmissions | analytics | ip.report.read | – | – |
| Consumes | `ip.bill.cleared` (IP-005), `lab.result.available|critical` (OP-004), `preauth.discharge_authorised` (RC-002), `pharmacy.dispensed` (OP-003) | | | | |

## 7. Domain Events (outbox)
- `ip.discharge.expected` {admission_id, expected_at} → IP-025, IP-005, OP-003, IP-001.
- `ip.discharge.initiated` {type, expected_exit_at, initiated_by} → IP-005, IP-003, OP-003/IP-014, OP-011, IP-001, EN-018, EN-009, RC-002 (final auth), NC-003.
- `ip.discharge.revoked` → same consumers.
- `ip.discharge.medications_reconciled` {erx_id} → OP-003; `ip.discharge.pharmacy_cleared`.
- `ip.discharge.nursing_cleared` → IP-005 (billing may finalise), IP-025.
- `ip.discharge.summary_signed` {document_id, version} → EN-011 (FHIR push), PE-001, PE-007, NC-003, EN-009.
- `ip.discharge.summary_amended` {version, reason}.
- `ip.discharge.completed` {type, condition, left_at, destination, transport} → IP-001 (bed release), IP-005 (lock), NC-003, EN-019, EN-011, PE-002, EN-030, IP-025, NC-015.
- `ip.discharge.dama_recorded`, `ip.patient.absconded`, `ip.death.declared` {mlc, brain_death} → IP-017, TR-008, NC-015, MS.
- `ip.followup.created` {appointment_ids} → OP-001, PE-002.
- `ip.readmission.detected` {prior_admission_id, days} → NC-015 root-cause task.

## 8. Screens (UI)
- **Discharge Worklist** (desktop, ward/billing/pharmacy views): columns patient/bed/doctor/type/initiated at/gates (nursing, pharmacy, billing, summary) as chips/timers; filters; real-time updates; `Enter` open, `I` initiate (doctors), `L` mark left (nurses).
- **Initiate Discharge Modal** (desktop/tablet/phone IP-010): type, condition, expected time, gate check results with links to fix, follow-up quick plan; confirm.
- **Medication Reconciliation** (desktop 3-column, tablet 2-column with swipe): home | inpatient | discharge; per-row decision buttons (`C` continue, `M` modify, `S` stop, `N` new), reason field, CDS flags inline, pill burden counter, generate e-Rx; pictorial schedule preview.
- **Discharge Summary Editor** (desktop): left section nav (required sections marked), centre editor with structured fields + rich text, right rail with source data pickers (labs trend table builder, imaging impressions, procedures, transfusions), version history, sign button (e-sign modal), preview PDF; shortcuts `Ctrl+S` draft, `Ctrl+Enter` sign, `Alt+L` insert labs table, `Alt+P` insert procedures; autosave every 10 s; conflict = last-writer warning with diff (documents server-versioned).
- **Nursing Discharge Checklist** (tablet/desktop): checkbox list with teach-back notes, vitals capture, belongings return, transport request, sign; offline queue.
- **DAMA / Death / Absconded forms** (desktop/tablet): guided forms with consent capture, witnesses, MCCD cause chain with ICD picker.
- **Billing clearance panel** (IP-005 screen embedded): pending charges, TPA authorisation timer, settle, gate pass print.
- **Family view** (portal/phone/kiosk): discharge status tracker (Initiated → Nursing → Pharmacy → Billing → Ready), estimated time, bill link, summary PDF after release, follow-up card, feedback.
- **Ward TV** (EN-018): "Discharges today" list by bed with stage; no names if masked.

## 9. Integrations
- EN-011 ABDM HIP: FHIR DischargeSummaryRecord bundle push on sign/amend; consent check; retries with DLQ. EN-016 e-sign (Aadhaar eSign/DSC), EN-039 templates, EN-009/EN-032 delivery, PE-001/PE-002/EN-030, OP-001 appointments, OP-003 pharmacy, RC-002 insurer discharge authorisation (NHCX later), NC-013 ambulance booking, NC-003 MRD, EN-019 ADT^A03/FHIR facade, IP-017/IP-018 hand-offs, EN-015 gate pass.
- Fallbacks: ABDM down → queued (visible in EN-011 console); e-sign provider down → hash signature with re-sign later per policy; PDF worker down → HTML view + retry.

## 10. Reports & Analytics
- Discharge TAT (initiation → nursing → pharmacy → billing → left; median/p90 by ward/payer/day of week; NABH indicator "time for discharge"), discharges by type/condition, DAMA rate & reasons, deaths (crude, by department, within 48 h of admission, MLC), readmission ≤ 30 d rate & causes, summary completeness (signed ≤ 24 h %, amendments count), follow-up compliance (appointment booked/kept), post-discharge call outcomes, ABDM push success, discharge survey NPS.
- Read models: `analytics.mv_discharge_tat`, `analytics.mv_readmissions`, `analytics.mv_mortality`, `analytics.mv_summary_quality`.

## 11. Notifications
- Family: discharge planned (time), billing ready/settled, summary available (portal link), medicines & follow-up reminder, day-3 call scheduling, survey; ambulance ETA if booked.
- Staff: doctor — summary pending signature/co-sign, late results after discharge; nurse — checklist due, patient left overdue; pharmacy — reconciliation ready; billing/TPA — discharge initiated, authorisation timer breach; MRD — coding/deficiency; MS/quality — DAMA/death/absconded events; bed manager — expected/actual releases.
- TV: discharges today stage board.

## 12. Permissions (RBAC keys)
`ip.discharge.plan|read|initiate|reconcile|pharmacy_clear|nursing_clear|complete|dama|death|absconded|followup|share`, `ip.discharge.summary.write|sign|amend`, `ip.report.read|export`.
Defaults: Doctor IP/Surgeon/Intensivist (7/9/11): plan, initiate, reconcile, summary.write/sign/amend, dama, death, followup, share; Resident (14): summary.write, reconcile (co-sign required); Ward nurse (17): plan (nursing needs), nursing_clear, complete, absconded (report), read; Pharmacist IP (31): pharmacy_clear, reconcile (verify); Billing (27)/TPA (28): read (+ IP-005 keys); MRD (43): read, share (print), summary.amend (coding fields only via NC-003 flow); Quality (54)/MS (4): read/report; Patient (59): own summary read.

## 13. Non-functional
- Volumes: 300 discharges/day, peaks 60/h 10:00–13:00; summary prefill < 500 ms p95 (uses read models for labs/procedures), PDF render < 5 s async, worklist < 200 ms.
- Concurrency: document versioning with optimistic locking; two editors → conflict UI.
- Offline: checklist queue on tablets; summary drafts local autosave (IndexedDB) with server sync.
- Printing: A4 summary (letterhead per branch, multilingual instruction section), medication schedule card (A5, pictorial), appointment card, gate pass (thermal), death/DAMA forms.
- Accessibility: large-print patient instructions option; i18n instructions en/hi/ta/te/ml/kn/mr/bn (+ar).
- Security: PDFs via presigned URLs (15 min), share consent enforced, all shares audited; no PHI in notification bodies (links only).

## 14. Acceptance Criteria
1. Given a patient with an unacknowledged critical lab result, when the doctor initiates discharge, then the gate check blocks with the result listed; after acknowledgement, initiation succeeds and `ip.discharge.initiated` is emitted.
2. Given discharge initiated with expected exit 14:00, then IP-005 stops scheduling auto-postings after 14:00 and shows the pending-charges review; revocation resumes postings and emits `ip.discharge.revoked`.
3. Given home meds (metformin, atorvastatin), inpatient meds (insulin sliding scale, ceftriaxone IV) and a new oral antibiotic, when reconciled, then stopping atorvastatin requires a reason, ceftriaxone IV is not carried to discharge without explicit "new oral" replacement, and the e-Rx contains exactly the "continue/modify/new" items.
4. Given the summary template requires "Diagnosis (ICD-10)" and "Discharge medications", when signing without ICD code, then signing is refused with the missing section highlighted.
5. Given a summary signed as v1, when the doctor amends a lab value, then v2 is created with reason, v1 remains readable and marked superseded, PDF v2 shows "Version 2", and an ABDM re-push is queued.
6. Given ABHA linked and consent valid, when the summary is signed, then a FHIR R4 DischargeSummaryRecord bundle (Composition 18842-5 with sections) is generated and the EN-011 push log shows success or a retryable failure.
7. Given nursing checklist item "IV cannula removed" is not done, when the nurse signs, then signing is refused; marking NA requires a note.
8. Given billing not cleared, when the nurse tries "Patient left", then it is refused unless the MS "discharge under protest/emergency" override is applied and audited.
9. Given IP-005 emits `ip.bill.cleared`, then the discharge worklist shows Billing ✓ within 2 s and the gate pass QR is generated.
10. Given "Patient left" at 15:10, then `ip.discharge.completed` triggers IP-001 bed release, IP-005 lock, NC-003 deficiency task, PE-002 day-3 call task, EN-030 survey after 24 h and ADT^A03.
11. Given a DAMA discharge, then a counselling record with witness and signed (or witnessed refusal) DAMA consent is mandatory, the summary shows "Discharged against medical advice", and quality is notified.
12. Given a death, then MCCD cause chain is captured with ICD-10 codes, "cardiac arrest" as underlying cause is rejected, MLC deaths block body release until police clearance flag from IP-017, and a mortality review task is created.
13. Given a patient missing for 45 minutes and unreachable, when reported absconded, then security/attendant/police steps are recorded, and after 6 h the admission closes as `absconded` with the bill in AR.
14. Given a follow-up plan "review in 7 days with Dr X", then an OP-001 appointment is booked in an available slot (or recall entry created), and the appointment card prints with the summary.
15. Given a lab result released 2 days after discharge, then the discharging doctor is notified and can amend the summary; the patient portal shows the updated version.
16. Given a readmission 12 days after discharge, then `ip.readmission.detected` links both admissions and a root-cause form is assigned to the department.
17. Given a resident signs a summary, then consultant co-sign is required within 24 h; unsigned after 24 h escalates to HOD and appears in MRD deficiency.
18. Given a summary share to WhatsApp without documented consent, then the share is refused; with consent, the message contains a secure link, not the PDF inline, and the share is logged.
19. Given the discharge TAT report for a month, then median and p90 of initiation→left by ward match a recomputation from `ip.discharge_events` on test data.
20. Given a patient moved to the discharge lounge at 11:00 and left at 13:30, then the original bed was released at 11:00 for housekeeping, lounge waiting time = 150 min appears in the KPI, and room rent stops per IP-005 policy at the lounge move time (configurable).
21. Given an ambulance selected for transport, then an NC-013 booking is created with ETA shown to the family and the charge posted to the bill before finalisation (or as supplementary if after).
22. Given the documents pack is generated, then it contains the signed summary version, medication card, follow-up card, final bill and selected reports as one PDF, and its hash is stored with the MRD copy.

### Golden-path e2e (Playwright)
- Doctor initiates discharge (gate checks pass) → reconciliation → e-Rx → nursing checklist → pharmacy pack → billing final & clearance (IP-005) → summary sign → ABDM push → patient left → bed release → follow-up appointment → day-3 call task; asserts events, versions, PDFs and portal visibility.

## 15. Enhancements / Later phases
- From VIMS sheet row 21: automated discharge readiness score (rules here; ML AI-005 later), post-discharge remote monitoring (`discharge.remote_monitoring`, OP-020/EN-042), transport arrangement at discharge (here via NC-013), DAMA (here), 30-day readmission tracking & root cause (here + NC-015), discharge satisfaction survey (here via EN-030).
- (market) "Discharge in a click" pre-filled summary (here), auto-cleanup on discharge (here). Later: AI hospital-course narrative drafting (AI-004/AI-002 suggestion only), ICD/DRG coding assist (AI-006), NHCX-based e-discharge authorisation (RC-001), interpreter/voice summary in local language, discharge lounge management (IP-025), predicted discharge date ML (IP-025/AI-005), pharmacy home delivery of take-home meds (OP-003), e-prescription QR for external pharmacies.

## 16. Open Questions for the Hospital
1. Discharge summary templates per department (existing formats to import), mandatory sections beyond NABH, languages for patient instructions?
2. Who signs (consultant only / resident + co-sign)? E-sign method (Aadhaar eSign, DSC token, or system signature)?
3. Summary release policy relative to bill clearance; "discharge under protest" approval chain?
4. Gate checks: which are hard vs soft blockers (pending results, unbilled items, unsigned notes)?
5. Take-home medicines: dispensed against IP bill or separate OP bill? Days supply default? Pictorial schedule required?
6. Post-discharge call timing/script and who calls (nurse/call centre)? Survey channel?
7. DAMA form format and witness rules; absconding wait time & police policy?
8. Death documentation: MCCD form workflow, CRS integration availability, mortuary process (IP-017)?
9. TPA discharge authorisation timer target (IRDAI 3 h) and escalation contacts?
10. Follow-up auto-booking allowed? Which consultants' slots? Referring-doctor copy sharing rules?
11. ABDM HIP live? Consent-manager registration status; push on sign or on patient request?
12. Retention period for summaries and MLC exceptions.
