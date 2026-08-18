# OP-025 — Ophthalmology Console (Vision/VA, Refraction, Slit lamp, IOP, Fundus, OCT/imaging, Spectacle Rx, Optical shop link) + **Shared Specialty Console Framework**

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-025 |
| Phase | 8 |
| Priority | P2 |
| Complexity | Medium-High |
| Depends on | OP-002 (consultation workspace — every specialty console is an overlay/tab set on the OP-002 encounter), OP-001 (visits, sub-queues), OP-007 (vitals, VA/IOP captured by optometrist as pre-consult), EN-039 (dynamic forms/templates), OP-022 (device result/attachment console), OP-008/EN-008 (fundus photo/OCT/FFA/B-scan as DICOM via PACS), OP-010 (minor procedures: FB removal, chalazion, laser YAG/PRP, intravitreal injection), IP-006 (cataract/vitreoretinal OT booking, IOL as implant via TR-003), NC-007 (IOL consignment), OP-003 (eye drops Rx), OP-005/RC-003 (billing, tariff), OP-023 (cataract packages), EN-029 (steroid-drop IOP alerts, drug allergy), EN-028 (consent), OP-033 (paediatric ROP/amblyopia), OP-013 (none), OP-021 (referral), PE-002 (recall: glaucoma review, DR screening), EN-009, EN-042 (device gateway for autorefractor/NCT/lensmeter), NC-006 (optical inventory if in-house shop), AI-007 (DR grading assist later) |
| Feature flag | `module.ophthalmology.enabled` (sub: `ophtha.optical_shop`, `ophtha.device_gateway`, `ophtha.dr_screening`) |
| Primary roles | Ophthalmologist (6), Optometrist / Refractionist (new sub-role of 16 "Nurse — OPD/Vitals" family: `optometrist`), Resident (14), Ophthalmic technician (imaging: 36 family), Ophthalmic nurse (16) |
| Secondary roles | Optical shop counter (26/27 with `optical.*`), Anaesthetist (10, cataract lists), Receptionist (24), Billing (27), Paediatrician (OP-033 ROP), Physician/Endocrinologist (DR screening referrals), Quality (54), Patient |
| Regulatory | NABH COP/AAC (specialty assessment, consent, implant traceability for IOL), CDSCO UDI for IOLs (Class C), NPCBVI (National Programme for Control of Blindness & Visual Impairment) monthly reporting formats (cataract surgeries, DR/glaucoma screening), Rights of Persons with Disabilities Act 2016 (visual disability certification support: BCVA/field criteria), Motor Vehicles Act medical fitness (Form 1A vision), DPDP, AERB not applicable |

## 1. Purpose
OP-025 turns a generic OPD encounter into an eye clinic record: optometry pre-consult (uncorrected/best-corrected VA, autorefraction, subjective refraction, keratometry, IOP by NCT/applanation, pupils, colour vision), ophthalmologist examination (slit lamp anterior segment, gonioscopy, dilated fundus with drawings, OCT/fundus photo/FFA/B-scan/perimetry attachment via OP-022/PACS), OD/OS-structured findings, diagnosis (ICD-10 H00–H59), spectacle/contact-lens prescription with print & optical-shop hand-off, eye-drop e-Rx, laser/injection/minor procedure orders (OP-010) and cataract/VR surgery planning (IOL power calc entry, biometry attachment, IP-006 booking, IOL consignment). It also defines the **shared specialty console framework (§0)** reused by OP-026…OP-040.

---
## 0. SHARED SPECIALTY CONSOLE FRAMEWORK (normative for OP-025 … OP-040; other consoles reference "§0 of OP-025")
### 0.1 Architecture
- A specialty console is **not** a separate encounter type. It is a **console overlay** registered against OP-002's consultation workspace: `mdm.specialty_consoles` (id, hospital_id, code e.g. `OPHTHA`, name, module_key, department_ids uuid[], tabs jsonb ordered [{key, label, component, form_template_key?, roles}], worklist_config jsonb, billing_links jsonb, is_active). When an encounter's department/doctor maps to a console (or the doctor toggles it), OP-002 renders the console tabs (left tab strip) instead of the generic SOAP tabs; generic tabs (history, Rx, orders, timeline, notes) remain reachable.
- Storage: structured specialty findings live in **schema `specialty`** tables owned by each module (defined in each spec §4) **plus** flexible sections captured by **EN-039 dynamic forms** (`clinical.form_responses` with `template_key`, `data jsonb`, `schema_version`, `encounter_id`, `patient_id`, `signed_*`). Rule: anything queried in WHERE/reports/alerts is a typed column; free-form clinical narrative and hospital-configurable extra fields go to form JSON with expression indexes only if needed.
- All specialty documents are **clinical documents** (append-only versions, sign → immutable → amend with reason, hash chain per docs/03).
- **Laterality & side-aware structures**: reusable Zod/DB pattern `sided<T> = {od/right: T, os/left: T, ou/bilateral?: T}`; ophthalmology (OD/OS), ENT (R/L ear/nostril), ortho, derm lesions, dental quadrants use it.
### 0.2 Specialty worklist (shared component `SpecialtyWorklist`)
- Reads OP-001 visits + EN-006 queue for the console's departments/rooms; columns configurable; standard chips: token, wait time, pre-consult status (e.g. "refraction done"), pending device results (OP-022), pending consent, follow-up type, payer. Sub-queues (e.g. "Refraction room", "Dilation waiting", "Imaging") are EN-006 **service points**; moving a patient between them fires `queue.moved`. Real-time via Socket.IO `hms:queue:<dept>`. Keyboard: `↑/↓` select, `Enter` open, `Ctrl+Shift+D` mark done, `/` filter.
- Multi-stage visits (optometrist → dilation → doctor → counsellor) modelled as `clinical.encounter_stages` (encounter_id, stage_key, station_id, started_at, ended_at, by) — TAT per stage reported.
### 0.3 Device result & attachment (via OP-022 + EN-042 + EN-008)
- Every console declares its **device result types** in `mdm.device_result_types` (code e.g. `OCT_MACULA`, `ECG_12L`, `SPIRO`, `AUDIO_PTA`, `OPG`, `NST`), each mapped to: an OP-022 report console template, MIME/DICOM handling (DICOM → Orthanc/PACS EN-008 with MWL order; PDF/JPG/CSV/XML → S3 via OP-022), optional **structured parser** (EN-042 adapter, e.g. spirometry XML, ECG HL7 aECG/SCP-ECG, autorefractor RS-232) that fills typed columns, and the billing service code. Attachment lifecycle: ordered (from console) → performed (technician) → attached/parsed → reviewed by doctor (`reviewed_by/at`) → included in visit summary. Unreviewed results older than X hours appear in the doctor's rail.
- Manual capture always allowed (photo from tablet camera; scanned paper); results appear on the patient timeline (OP-002) tagged with the console code.
### 0.4 Specialty billing links
- Console actions raise **charge intents** (`billing.charge_intent`: service_code, qty, side, package_eligibility, source console) consumed by OP-005 (OP) or IP-005 (IP), respecting OP-023 packages, RC-003 payer tariffs and pre-auth (RC-002). Zero-priced "documentation" services still create line for MIS. Every console spec lists its billable triggers in §5/§9.
### 0.5 Recall/follow-up, referral, education
- Consoles set **recall rules** (PE-002): e.g. glaucoma 3-monthly IOP, DR annual, dental 6-monthly, ANC per GA; patient education material (OP-038/PE-003) attachable to visit summary and sent via EN-009; referrals via OP-021.
### 0.6 Print & summary
- Every console produces a **specialty visit summary** print/PDF template (EN-039 print templates, `packages/print-templates/specialty/<code>`) plus specialty-specific prints (spectacle Rx, dental treatment estimate, ECG strip report, chemo cycle sheet, ANC card, growth chart). All include hospital letterhead, doctor signature/e-sign (EN-016), QR to portal (PE-001), ABDM FHIR bundle export (EN-011: OPConsultRecord/DiagnosticReport/Prescription).
### 0.7 Permissions & roles pattern
- Keys `<console>.<resource>.<action>`; each console adds sub-roles via RBAC templates (optometrist, audiologist, dental assistant, chemo nurse, ANC counsellor…) — hospital admin maps them (EN-007). Sensitive consoles (OP-032 psychiatry, OP-036 second opinion, OP-040 MTP data) add **ABAC visibility rules** on top.
### 0.8 Non-functional defaults
- Console tab first render < 1 s with cached forms; save p95 < 300 ms; device attachment upload resumable (tus-style multipart) up to 500 MB (video/DICOM through PACS); offline: EN-039 forms & worklist cached in IndexedDB, mutations queued with server-wins conflict on signed docs, client-wins on drafts; i18n for patient-facing prints (en-IN + regional); WCAG 2.2 AA; tablet 2-pane.
### 0.9 Framework acceptance criteria (tested once, in OP-025, reused by all)
- F1: Registering a console in `mdm.specialty_consoles` makes its tabs appear in OP-002 for the mapped departments without code deploy (tabs referencing existing components/templates).
- F2: A device result attached via OP-022 for an ordered `device_result_type` shows in the console tab and on the timeline within 2 s (socket) and is unreviewed until the doctor marks it.
- F3: A console action producing a charge intent creates the OP-005 bill line honouring package/payer tariff, and cancelling the action before billing voids the intent.
- F4: Signed specialty documents are immutable; amend creates version 2 with reason; hash chain verified.
- F5: Worklist stage moves update EN-006 boards in real time and stage TATs are reportable.

---
## 2. Users & Jobs-to-be-done
- **Optometrist** (desktop in refraction room, 60–120 patients/day per lane): capture VA (Snellen/logMAR/ETDRS, near N-notation), pinhole, autorefraction (device or manual), retinoscopy, subjective refraction (sphere/cyl/axis/add, prism), keratometry, IOP (NCT), pupils, colour vision (Ishihara), contrast, lensmeter of current glasses; mark stage done; print spectacle Rx when doctor delegates.
- **Ophthalmologist** (desktop/tablet, 40–80 patients/day): review optometry data, slit lamp/gonio/fundus with schematic drawings, dilate & re-queue, order/attach OCT/photos/perimetry, diagnose, treat (drops, laser, injection, surgery plan with IOL selection), counsel, sign, recall.
- **Ophthalmic technician**: perform OCT/fundus/FFA/B-scan/perimetry/biometry, attach results (OP-022/PACS), keep imaging sub-queue.
- **Counsellor/optical shop counter**: surgery/package counselling (OP-023, RC-008 estimate), spectacle order from signed Rx, frame/lens SKU, delivery/collection.
- **Patient**: spectacle Rx PDF, images in portal, recall reminders.

## 3. Core Workflows
### 3.1 Optometry pre-consult
1. Patient checks in (OP-001) → auto-routed to "Refraction" service point (EN-006) → optometrist opens **Refraction workspace** (§8.2) → enters VA (UCVA/BCVA/PH per eye, distance & near, notation switch logMAR⇄Snellen auto-convert), old glasses power via lensmeter (device or manual), autorefraction (EN-042 pull from autorefractor/keratometer, e.g. Topcon/Nidek RS-232/USB → structured `refraction_readings.auto`), retinoscopy, subjective refraction (sph −30…+30 in 0.25 steps, cyl ±, axis 0–180, add, VA achieved, PD, vertex), IOP NCT (3 readings avg, time), pupil (size, RAPD), colour vision, cover test/EOM (paeds), dry retinoscopy vs cycloplegic (flag cycloplegic drops given: drug/time → allergy check EN-029) → save → stage "refraction_done" → queue to doctor. Event `ophtha.refraction.recorded`.
2. Exceptions: uncooperative child → mark "unable/CSM/fix&follow"; VA <6/60 → count fingers/HM/PL/PR ladder; device offline → manual entry flagged `source=manual`.
### 3.2 Ophthalmologist examination
1. Open encounter (console tabs: Optometry · Anterior segment · Posterior segment · Investigations · Diagnosis/Plan · Rx/Spectacles · Surgery) → **Anterior segment** OD/OS grid: lids/adnexa, conjunctiva, cornea (with drawing canvas + presets: KP, epithelial defect with fluorescein size mm), AC depth/cells/flare (SUN grading), iris, pupil, lens (LOCS III NO/NC/C/P grades or pseudophakia/IOL position/PCO), gonioscopy (Shaffer per quadrant), applanation IOP (Goldmann, with CCT-corrected note), pachymetry.
2. Dilate → patient re-queued to "Dilation waiting" (timer 20–30 min shown) → **Posterior segment**: media, disc (CDR vertical/horizontal, NRR ISNT, pallor, notching), macula (foveal reflex, oedema, drusen, haemorrhages), vessels, periphery (drawing with standard fundus colours: red haemorrhage, blue veins/detachment, green opacities, yellow exudates, brown pigment), DR grading (ICDR: none/mild/moderate/severe NPDR/PDR + DME), ARMD (AREDS), glaucoma stage, RD map (clock hours, breaks).
3. **Investigations tab**: order OCT macula/RNFL/GCC, fundus photo, FFA/ICG (consent + allergy check for fluorescein), B-scan, UBM, perimetry (HFA 24-2/30-2/10-2 → parse GHT/MD/PSD/VFI if XML available), specular microscopy, biometry (IOL Master/A-scan: AL, K1/K2, ACD, IOL formulas SRK/T, Barrett, Hoffer Q — power table attached as PDF; chosen IOL power/model recorded), corneal topography; results via OP-022/PACS shown side-by-side OD/OS with prior comparison slider; doctor marks reviewed.
4. **Diagnosis/Plan**: ICD-10 per eye (H25.1 nuclear cataract OD, H40.11 POAG OU, E11.3x DR mapped to endocrinology problem list…), SNOMED optional; plan items → e-Rx (drops with eye + frequency + duration; taper schedules e.g. pred acetate 6/5/4/3/2/1 auto-generate calendar; steroid-drop IOP recall rule), laser (YAG capsulotomy/PI, PRP, focal, SLT) & intravitreal injections (anti-VEGF drug/lot, eye, consent, aseptic checklist, post-inj IOP) via OP-010, minor procedures (FB removal, chalazion I&C, punctal plug), **surgery plan** (§3.4), referral, recall (glaucoma 3 mo, DR 6/12 mo, post-op day1/7/30), education (OP-038 cataract/glaucoma leaflets), disability/driving fitness certificate templates.
5. Sign → visit summary print + spectacle Rx (if any) → `ophtha.exam.signed`.
### 3.3 Spectacle / contact-lens prescription & optical shop
1. Doctor finalises Rx from subjective refraction (edit allowed): distance/near/bifocal/progressive, sph/cyl/axis/add/prism/base per eye, PD (mono/binocular), lens advice (material, coating, photochromic), validity (default 12 mo), CL Rx (BC, dia, power, brand, wear schedule) → print (bilingual) + PDF to portal → `ophtha.spectacle_rx.signed`.
2. If `ophtha.optical_shop`: counter creates **optical order** from Rx (frame SKU, lens SKU/lab order, price, advance, delivery date), stock via NC-006, billing via OP-005 (separate GST 12%/18% for frames/lenses HSN 9003/9001 as configured), status booked→lab→ready→delivered, SMS on ready. Vendor lab order export CSV/API (EN-017).
### 3.4 Surgery planning (cataract/VR/glaucoma/oculoplasty)
1. Doctor selects procedure (phaco+IOL, SICS, trab, VR, pterygium…), eye, anaesthesia (topical/peribulbar/GA), IOL from biometry (model, power, formula, target refraction, backup power), pre-op checklist (BP/sugar, syringing/lacrimal patency, ECG/physician fitness link OP-002/IP-024 PAC), counselling & estimate (RC-008/OP-023 packages: standard/premium IOL variants), consent (EN-028 template per procedure, in patient language) → **OT booking request** to IP-006 (day-care/IP-001 admission) with IOL consignment reservation (NC-007/TR-003 UDI); marked eye + IOL details flow to WHO checklist. Post-op day 1/7/30 visits auto-scheduled with post-op template (VA, IOP, AC reaction, wound, IOL position). NPCBVI cataract register line auto-generated. Event `ophtha.surgery.planned`.
### 3.5 DR / glaucoma screening programmes (`ophtha.dr_screening`)
- Bulk worklist for diabetics (from OP-002 problem list/lab HbA1c) → fundus photo by technician → doctor/AI-007 grading → referral tiers → recall; NPCBVI reporting.

## 4. Data Model (schema `specialty`)
- **ophtha_visits**: id, hospital_id, branch_id, patient_id, encounter_id (unique), stage enum(registered/refraction/dilating/doctor/imaging/counselling/done), dilated_at, dilating_drug, cycloplegic bool, chief_complaint_codes text[], status, signed_by/at, version.
- **ophtha_visual_acuity**: id, visit_id, eye enum(od/os), context enum(ucva/bcva/pinhole/with_glasses/near/post_op), notation enum(snellen_6/snellen_20/logmar/etdrs/n_notation/cf/hm/pl/nlp/csm), value text, logmar numeric(4,2) (normalised), distance_m, at, by; index (visit_id).
- **ophtha_refractions**: id, visit_id, eye, kind enum(auto/retinoscopy/subjective/cycloplegic/old_glasses/final_rx/contact_lens), sph numeric(5,2), cyl numeric(5,2), axis smallint (0–180), add numeric(4,2), prism numeric(4,2), base enum, va_achieved, pd_mono, pd_bino, vertex_mm, k1, k1_axis, k2, k2_axis (keratometry), device_id?, source enum(device/manual), at, by; check axis range, cyl sign convention setting (minus default).
- **ophtha_iop_readings**: id, visit_id, eye, method enum(nct/goldmann/icare/tonopen/schiotz), value_mmhg numeric(4,1), cct_um?, corrected_mmhg?, at, by, post_dilation bool; index (patient_id via visit, at) for trend.
- **ophtha_exam_findings**: id, visit_id, segment enum(anterior/posterior/adnexa/motility), eye, findings jsonb (typed per segment: e.g. {cornea:{clarity, kp, defect_mm}, ac:{depth, cells, flare}, lens:{locs_no, locs_nc, locs_c, locs_p, status}, disc:{cdr_v, cdr_h, notch}, macula:{...}, dr_grade enum, dme bool, gonio:{sup,inf,nas,temp}}), drawing_svg_key (S3), form_response_id?, by, at.
- **ophtha_diagnoses**: visit_id, eye enum(od/os/ou), icd10, snomed?, is_primary, status; (also mirrored to clinical.diagnoses with laterality extension).
- **ophtha_spectacle_rx**: id, hospital_id, patient_id, visit_id, rx_no (numbering `SPEC_RX`), type enum(spectacle/contact_lens), lines jsonb (per eye/distance/near), pd, lens_advice jsonb, valid_until, signed_by, printed_at, pdf_key; index (hospital_id, patient_id, created_at desc).
- **ophtha_investigation_orders**: id, visit_id, eye, device_result_type_code, status enum(ordered/performed/attached/reviewed/cancelled), op22_result_id?, pacs_study_uid?, parsed jsonb (e.g. OCT CST µm, RNFL avg, HFA MD/PSD/VFI/GHT), reviewed_by/at.
- **ophtha_procedures_link**: visit_id, procedure_order_id (OP-010), eye, kind enum(laser_yag/laser_prp/laser_focal/slt/ivt_injection/minor), drug_lot?, post_iop.
- **ophtha_surgery_plans**: id, hospital_id, patient_id, visit_id, procedure_code, eye, anaesthesia, iol_model, iol_power numeric(4,2), iol_formula, target_ref, backup_power, biometry jsonb (al, k1, k2, acd), preop_checklist jsonb, consent_id, estimate_id (RC-008), ot_booking_id (IP-006), status enum(planned/counselled/booked/done/cancelled), npcbvi_flag; index (hospital_id, status).
- **optical_orders** (if shop): id, hospital_id, branch_id, patient_id, spectacle_rx_id, frame_item_id, lens_item_id, lab_vendor_id?, price jsonb, advance_receipt_id, bill_id, status enum(booked/sent_to_lab/ready/delivered/cancelled), promised_at, delivered_at.
- Enums: `eye`, `va_notation`, `refraction_kind`, `iop_method`, `dr_grade`(none/mild_npdr/moderate_npdr/severe_npdr/pdr), `ophtha_stage`.

## 5. Business Rules & Validations
- Every value carries eye; OU allowed only for diagnoses/plans. Sphere/cyl 0.25 steps; axis 1–180 (0≡180); add 0.75–4.00 typical (warn outside); transposition helper (plus⇄minus cyl) never changes stored canonical (minus-cyl) form.
- logMAR normalisation for trends (6/6=0.0, 6/60=1.0, CF=1.7/2.0 config, HM 2.3, PL 2.6, NLP 3.0 per hospital setting).
- IOP ≥ 22 mmHg (config) or asymmetry > 5 → amber banner; ≥ 30 → red + doctor alert; steroid drops prescribed → recall IOP check at 2–4 weeks; on-treatment glaucoma → IOP trend chart mandatory.
- Cycloplegic/dilating drops: allergy & angle-closure risk (shallow AC/gonio closed) warning before dilation order; dilation logged as medication administration (nurse) with time.
- Fluorescein angiography: consent + allergy/asthma/pregnancy check; adverse reaction → NC-015.
- Anti-VEGF: drug, lot, expiry, eye, injection count per eye, interval rules (e.g. ≥ 4 weeks) → warning; bilateral same-day requires separate lots & consent; post-injection IOP/perfusion check mandatory field.
- Cataract: IOL power must be from biometry within 6 months (else warn); target refraction recorded; IOL UDI scanned at OT (TR-003) must match planned model — mismatch hard-stop with override reason; NPCBVI reporting fields (age, VA pre/post, IOL type, complications).
- Spectacle Rx signature: doctor or delegated optometrist (permission `ophtha.spectacle_rx.sign_delegated`); validity default 12 months; re-print watermark "Duplicate".
- Driving/disability certificate: BCVA & fields per RPwD guidelines; certificate documents via EN-039 with e-sign.
- Numbering: `SPEC_RX`, `OPTICAL_ORDER`; documents immutable after sign; VA/IOP retention as clinical.

## 6. API Surface (`/api/v1/ophtha`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /worklist?dept=&stage= | specialty worklist | ophtha.visit.read | – | cursor |
| POST/GET/PATCH | /visits, /visits/{id} | visit shell/stage | ophtha.visit.create/read/update | Y | – |
| POST | /visits/{id}/va | VA rows (batch per eye/context) | ophtha.optometry.record | Y | – |
| POST | /visits/{id}/refractions | refraction rows | ophtha.optometry.record | Y | – |
| POST | /visits/{id}/iop | IOP readings | ophtha.optometry.record | Y | – |
| GET | /patients/{id}/trends?metric=iop|logmar|cdr | series | ophtha.visit.read | – | – |
| PUT | /visits/{id}/exam/{segment} | exam findings + drawing | ophtha.exam.record | Y | – |
| POST | /visits/{id}/investigations | order device results (→ OP-022/MWL) | ophtha.investigation.order | Y | – |
| PATCH | /investigations/{id}/review | mark reviewed | ophtha.investigation.review | Y | – |
| POST | /visits/{id}/spectacle-rx, GET /spectacle-rx/{id}/pdf | Rx | ophtha.spectacle_rx.sign | Y | – |
| POST | /visits/{id}/surgery-plans, PATCH /surgery-plans/{id} | plan/booking | ophtha.surgery.plan | Y | – |
| POST | /visits/{id}/sign | sign visit summary | ophtha.exam.sign | Y | – |
| POST/GET/PATCH | /optical/orders | optical shop | optical.order.* | Y | cursor |
| GET | /reports/npcbvi?month= | programme report | ophtha.report.read | – | – |
| POST | /devices/ingest (EN-042 callback) | autorefractor/NCT/lensmeter payload | device token | Y | – |

## 7. Domain Events (outbox)
- `ophtha.refraction.recorded`, `ophtha.iop.high` {eye, value} → doctor rail; `ophtha.exam.signed` → OP-002 timeline, EN-011 FHIR bundle, PE-001; `ophtha.spectacle_rx.signed` → optical shop queue, patient PDF (EN-009); `ophtha.investigation.ordered|attached|reviewed` (OP-022 bridge); `ophtha.surgery.planned|booked` → IP-006, NC-007 IOL reservation, RC-008; `ophtha.injection.performed` → OP-010/pharmacy lot consumption; `ophtha.recall.due` → PE-002; `optical.order.status_changed`.
- Consumes: `visit.checked_in`, `queue.moved`, `op22.result.attached`, `pacs.study.available`, `procedure.completed`, `ot.case.completed` (post-op template).

## 8. Screens (UI)
1. **Eye clinic worklist** (desktop, §0.2) with stage lanes (Refraction / Dilating with countdown / Doctor / Imaging / Counselling); real-time.
2. **Refraction workspace** (desktop, keyboard-first): OD|OS split, VA ladder buttons, refraction grid with numeric stepper (`+`/`-` 0.25, `Tab` across sph→cyl→axis→add, `Ctrl+T` transpose, `Ctrl+P` print trial), device "Pull" button (autorefractor/NCT/lensmeter, EN-042), IOP triple entry, `Ctrl+S` save, `Ctrl+Enter` mark done.
3. **Examination workspace** (desktop/tablet): tabs per segment, OD/OS side-by-side canvases (slit lamp, fundus, disc templates), preset "Normal exam" fill (`F2`), stamps palette, LOCS/CDR pickers, DR grade selector; investigations pane with OP-022 viewer/OHIF comparison (prior vs current, `[`/`]` toggle); diagnosis & plan panel; `Ctrl+Enter` sign.
4. **Spectacle Rx composer & print preview** (desktop) — bilingual, QR, validity.
5. **Surgery planner** (desktop): biometry table, IOL formula outputs, target/backup, checklist, estimate & consent status, OT slot picker (IP-006).
6. **Optical shop counter** (desktop/tablet): Rx lookup by rx_no/UHID/QR, frame/lens picker, quote, order status board.
7. **DR screening board** (desktop dark): pending grading queue, AI suggestions (later), referral tiers.
8. **Patient portal**: spectacle Rx, images (thumbnails), post-op instructions (OP-038), recall dates.
- Empty states: "No refraction yet — pull from device or enter"; device offline banner; unsaved-changes guard.

## 9. Integrations
- EN-042 device gateway: autorefractor/keratometer, NCT, lensmeter, HFA (XML/DICOM), OCT/fundus camera/FFA (DICOM via EN-008; JPG fallback), biometry (PDF/CSV), specular microscope; PACS MWL orders per investigation; OP-022 for non-DICOM PDFs; TR-003/NC-007 IOL UDI; OP-010 procedure engine; IP-006 OT; OP-023/RC-008 packages/estimates; EN-011 FHIR (Observation for VA/IOP with LOINC 79880-1 VA, 56844-4 IOP); NPCBVI portal — CSV/manual (no public API; EN-017 placeholder).

## 10. Reports & Analytics
- Refraction lane throughput & TAT per stage; VA/IOP distribution; cataract conversion (advised→booked→done), IOL usage by model/vendor, NPCBVI monthly form, DR screening yield & referral tiers, glaucoma follow-up compliance, anti-VEGF injections per eye/drug, laser volumes, spectacle Rx→optical order conversion & revenue, post-op VA outcomes (6/12 or better at day 30 %), complications. Read models `analytics.ophtha_daily`, `analytics.cataract_outcomes`.

## 11. Notifications
- Patient: spectacle Rx PDF (WhatsApp/portal), dilation advisory ("do not drive 4–6 h"), post-op instructions & day-1/7/30 reminders, drop taper calendar, recall (glaucoma/DR), optical order ready. Staff: IOP ≥ 30 alert, unreviewed OCT > 2 h, IOL consignment not reserved 24 h before OT, FFA reaction (NC-015). TV: refraction/doctor sub-queues via EN-018.

## 12. Permissions (RBAC keys)
`ophtha.visit.create|read|update`, `ophtha.optometry.record`, `ophtha.exam.record|sign`, `ophtha.investigation.order|attach|review`, `ophtha.spectacle_rx.sign|sign_delegated|print`, `ophtha.surgery.plan|book`, `ophtha.injection.record`, `ophtha.report.read`, `ophtha.configure`, `optical.order.create|read|update|deliver`. Defaults: Ophthalmologist — all clinical; Optometrist — optometry.record, spectacle_rx.sign_delegated (if granted), visit.read; Technician — investigation.attach; Resident — record without sign; Optical counter — optical.*; Counsellor — surgery.plan read + estimate.

## 13. Non-functional
- Volumes: 400 eye visits/day enterprise (2–4 refraction lanes), 150 imaging studies/day (OCT ~20 MB DICOM), 40 surgeries/day; refraction save p95 < 200 ms; OD/OS image compare loads < 2 s (PACS thumbnails). Offline: refraction/exam forms cached, drawings stored locally until sync. Print: spectacle Rx A5/thermal, visit summary A4, certificates. i18n prints. Drawing canvas touch/pen support on tablets.

## 14. Acceptance Criteria (in addition to §0.9 F1–F5)
1. Given a subjective refraction OD −2.00/−1.00×90 add +2.00, when the doctor signs the spectacle Rx, then a `SPEC_RX` numbered PDF (bilingual) is generated with PD and validity 12 months and appears in the optical shop queue.
2. Given the autorefractor pushes readings via EN-042 for token 42, then the values pre-fill the refraction grid with source=device and the optometrist can accept or override (override logged).
3. Given NCT IOP OS 34 mmHg, then the visit shows a red banner, the doctor receives an alert, and the trend chart plots prior readings.
4. Given prednisolone acetate drops are prescribed with a taper, then a patient calendar is generated and a 3-week IOP recall task is created (PE-002).
5. Given a shallow AC/closed angles documented, when dilation is ordered, then an angle-closure warning requires acknowledgement.
6. Given an OCT macula ordered, when the technician attaches the DICOM (PACS) then the study appears in the Investigations pane with prior comparison and remains "unreviewed" until the doctor marks reviewed.
7. Given a cataract plan with IOL power +21.5 D from biometry 7 months old, then a stale-biometry warning shows; at OT, scanning a UDI of a different IOL model hard-stops with override reason.
8. Given an anti-VEGF injection OD 3 weeks after the last, then an interval warning appears; the record requires lot number and post-injection IOP.
9. Given the month closes, then the NPCBVI report lists cataract surgeries with pre/post VA and IOL type matching signed records.
10. Given an optometrist without `spectacle_rx.sign_delegated`, when signing a spectacle Rx, then 403 and audit entry.
11. Given VA entered as 6/18 Snellen, then logMAR 0.48 is stored and trend across visits renders in logMAR.
12. Given a paediatric patient (OP-033) with amblyopia, then the visit summary flags occlusion therapy plan and follow-up appears in the paediatric timeline.

## 15. Enhancements / Later phases
- Sheet row 61 (Vision test, Refraction, Slit lamp, IOP, Fundus, Rx) — core. Market gaps folded: optical shop & lab order (market), DR screening programme (market), NPCBVI reporting.
- Later: AI-007 DR/glaucoma grading, teleophthalmology camps (NC-035) with fundus camera upload, low-vision aids inventory, contact-lens trial inventory, ROP screening register (IP-015), corneal donation/eye bank link (IP-019), progressive-lens design integration APIs.

## 16. Open Questions for the Hospital
1. Which devices exist (autorefractor/NCT/lensmeter/OCT/HFA/biometry brands & connectivity)? DICOM-capable?
2. VA notation default (6/x vs logMAR) and CF/HM logMAR mapping? Cyl convention (minus)?
3. In-house optical shop? Frame/lens SKUs, lab vendor, GST treatment?
4. Optometrist may sign spectacle Rx? Which certificate templates (driving, disability, fitness)?
5. Cataract packages/IOL tiers and consignment vendors? NPCBVI reporting required?
6. DR screening programme volume & whether AI grading pilot desired?
