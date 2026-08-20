# OP-026 — Dental Console (FDI tooth charting, Perio chart, Treatment plans & estimates, Dental X-ray/OPG/CBCT, Procedure notes, Lab work, Multi-visit courses)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Module ID       | OP-026                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase           | 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Complexity      | Medium-High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Depends on      | **OP-025 §0 (shared specialty console framework)**, OP-002 (encounter/e-Rx/orders), OP-001 (chair/dentist slots, multi-visit appointments), OP-010 (procedure record: extractions, RCT, implants, minor oral surgery, consent, consumables), OP-022/OP-008/EN-008 (IOPA/OPG/CBCT via PACS or image upload), OP-005/RC-003/OP-023 (billing, dental tariff, orthodontic/implant packages, instalment plans), RC-008 (estimates/quotations), NC-006/NC-007 (implants, consumables, dental materials; implant UDI via TR-003), EN-003 (CSSD dental instrument sets), EN-028 (consent), EN-039 (forms), EN-029 (anticoagulant/bisphosphonate/allergy alerts before extraction), IP-006 (OMFS under GA), OP-033 (paediatric dentistry), OP-013 (none), PE-002 (6-monthly recall, ortho reviews), EN-009, NC-021 (dental lab vendors), AI-007 (caries detection later) |
| Feature flag    | `module.dental.enabled` (sub: `dental.perio_chart`, `dental.ortho`, `dental.implants`, `dental.lab_work`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Primary roles   | Dentist / Dental surgeon (6), Specialists (endodontist, periodontist, orthodontist, prosthodontist, OMFS, paedodontist — sub-roles of 6), Dental assistant/hygienist (16 family: `dental_assistant`, `hygienist`), Resident/intern (14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Secondary roles | Receptionist (24: chair scheduling), Billing (27: estimates/instalments), Radiology tech (36: OPG/CBCT), Stores (44), Lab vendor (63), Patient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Regulatory      | NABH, Dental Council of India record-keeping, AERB (dental X-ray/OPG/CBCT registration, dose), CDSCO (implants Class C, UDI), BMW 2016 (amalgam/sharps), NDPS/H1 (analgesic/antibiotic Rx), GST on cosmetic vs therapeutic dental (config), DPDP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 1. Purpose

OP-026 provides a chairside dental record: interactive **FDI (ISO 3950) tooth chart** (permanent/primary/mixed dentition) with per-surface conditions and treatments, **periodontal chart** (6-point PD/CAL/BOP/mobility/furcation), radiograph attachment & annotation (IOPA/bitewing/OPG/CBCT), problem list → **treatment plan with phased estimates** (accept/decline per item, instalments, insurance/package), multi-visit **course tracking** (e.g. RCT 3 visits, ortho monthly), procedure notes with materials/implants/lab work, dental Rx, recalls, and dental-lab work orders. Framework behaviours (worklist, device attachment, billing links, print, offline) follow OP-025 §0.

## 2. Users & Jobs-to-be-done

- **Dentist** (chairside desktop/tablet with pen; 20–40 patients/day/chair): chart findings fast (click tooth/surface → condition), plan & quote, perform & note procedures, prescribe, order lab work, schedule next sitting.
- **Hygienist/assistant**: perio charting (voice-free 6-point entry), scaling notes, materials, sterilisation tray scan (EN-003), chair turnover.
- **Orthodontist**: ortho records (photos, models/STL, cephalometrics), monthly adjustment notes, appliance tracking, instalment plan.
- **Reception/billing**: chair booking, estimate to bill conversion per sitting, instalment collection.
- **Patient**: estimate/consent PDFs, post-extraction instructions, recall reminders.

## 3. Core Workflows

### 3.1 Examination & charting

1. Open encounter with Dental console → **Tooth chart** (permanent 11–48, primary 51–85, mixed auto by age; Universal/Palmer display toggle, storage always FDI) → click tooth or surface (M/O/D/B/L, incisal, root) → pick condition from palette: caries (ICDAS 0–6), restoration existing (amalgam/composite/GIC/crown type), missing, impacted, mobile, fracture, attrition/abrasion/erosion, RCT done, implant, pontic, supernumerary, unerupted → chart renders symbols/colours (red = to-do, blue = existing/done). Extra-oral/intra-oral soft tissue findings (lesion map for oral mucosa incl. OPMD/leukoplakia → biopsy via OP-010 & OP-004 histopath), TMJ, occlusion (Angle class, overjet/overbite), oral hygiene index (OHI-S), DMFT/dmft auto-computed. Event `dental.chart.updated`.
2. **Perio chart** (`dental.perio_chart`): 6 sites/tooth PD, recession → CAL auto, BOP, plaque, suppuration, mobility (Miller 0–3), furcation (Glickman I–IV); keyboard entry runs sextant order (`Space` next site, `B` BOP toggle); staging/grading (AAP 2017) suggested; comparison with previous chart (delta colours).
3. Radiographs: order IOPA/bitewing/OPG/CBCT (charge intent, AERB dose logged in OP-008), images via PACS/OP-022 shown against chart tooth numbers; annotations (caries, PA lesion, bone loss %) saved; RVG sensor direct capture via EN-042 (TWAIN/SDK) where available.

### 3.2 Treatment plan & estimate

1. Findings → **plan items** (tooth/teeth, surfaces, procedure code from dental catalogue: restoration class, RCT (anterior/premolar/molar), post & core, crown (PFM/zirconia/e-max), extraction (simple/surgical/impaction), scaling/root planing per quadrant, implant (fixture+abutment+crown), denture (CD/RPD/flexible), ortho (metal/ceramic/aligner course), whitening, sealants/fluoride, splinting; priority (urgent/phase 1 disease control/phase 2 restorative/phase 3 maintenance), sittings estimated, dentist) → **estimate** (RC-008) with tariff/payer/package, discounts (approval EN-038), taxes; patient accepts/declines per item (e-sign EN-028 or portal accept), instalment schedule (ortho/implant) with due dates → plan status `accepted/partial/declined`; alternative options (e.g. crown material tiers) presented side by side.
2. Consent per procedure category (extraction, RCT, implant, GA) with tooth numbers pre-filled.

### 3.3 Sitting execution & procedure notes

1. Each sitting: dentist selects plan items being done today → OP-010 record with dental template: anaesthesia (LA agent, cartridges, technique), isolation, materials (composite shade, GIC batch, gutta-percha, sealer, implant fixture UDI/lot via TR-003, crown lab), working length/canals for RCT (per canal MB/DB/P mm, reference point, MAF, obturation), extraction details (elevator/forceps, socket, sutures, complications: dry socket follow-up), perio (SRP quadrants), ortho (archwire, elastics, brackets replaced), photos (intra-oral camera) → completes item or marks "in progress (sitting 2/3)" → charge intent per completed step (config: bill per sitting vs on completion) → chart updated (planned→done, colour blue) → next sitting appointment (OP-001) with interval rules → post-op instructions (OP-038) via WhatsApp → `dental.sitting.completed`.
2. Dental Rx (analgesics/antibiotics/mouthwash; allergy & anticoagulant/bisphosphonate (MRONJ) alerts EN-029 before extraction/implant), medical history flags (diabetes, cardiac — SBE prophylaxis prompt per hospital policy, pregnancy).

### 3.4 Lab work (`dental.lab_work`)

- Create **lab work order** (crown/bridge/denture/aligner/night guard: shade, material, impression type/STL upload, due date, vendor NC-021) → status sent → received → try-in → cemented/delivered; vendor invoice matched (NC-005); remake tracking; STL files stored (S3, OP-022 attachment).

### 3.5 Recall & maintenance

- Auto recall: 6-monthly check-up/scaling, perio maintenance 3-monthly, ortho monthly, implant review 1/3/6/12 months (PE-002); no-show follow-up; unaccepted-plan reminders (config).

### 3.6 Exceptions

- Emergency dental (pain/trauma; avulsed tooth → time-critical replantation note; MLC dental trauma → TR-008 link); plan item cancelled after partial work → partial billing rule; instalment default → block elective continuation (config); offline chart entry cached (§0.8).

## 4. Data Model (schema `specialty`)

- **dental_charts**: id, hospital_id, branch_id, patient_id, encounter_id, dentition enum(permanent/primary/mixed), state jsonb (current tooth×surface conditions snapshot, keyed by FDI), dmft numeric, ohis, occlusion jsonb, soft_tissue jsonb, version, by, at; index (hospital_id, patient_id, at desc). Snapshot table + event log below (chart is materialised from log).
- **dental_tooth_events** (append-only): id, patient_id, encounter_id, tooth_fdi smallint (11–48, 51–85), surfaces text[] (M/O/D/B/L/I/R), condition_code, status enum(existing/planned/done/cancelled), plan_item_id?, procedure_id?, notes, by, at; index (patient_id, tooth_fdi, at).
- **dental_perio_charts**: id, patient_id, encounter_id, entries jsonb ([{tooth, site(1–6), pd, rec, cal, bop, plaque, supp}]), mobility jsonb, furcation jsonb, stage, grade, by, at.
- **dental_treatment_plans**: id, hospital_id, branch_id, patient_id, encounter_id, plan_no (numbering `DENT_PLAN`), status enum(draft/presented/accepted/partial/declined/completed/cancelled), estimate_id (RC-008), consent_id?, total, accepted_total, instalment_schedule jsonb, presented_by, accepted_at, accepted_via enum(esign/portal/verbal_witness), version.
- **dental_plan_items**: id, plan_id, seq, procedure_code, description, teeth smallint[], surfaces jsonb, phase smallint, priority enum(urgent/phase1/phase2/phase3), quantity, sittings_planned smallint, sittings_done smallint, unit_price, discount, tax, payer_share, patient_share, status enum(proposed/accepted/declined/in_progress/completed/cancelled), alt_group?, dentist_id, completed_at; index (plan_id), (hospital_id, status).
- **dental_sittings**: id, plan_id, encounter_id, procedure_id (OP-010), items jsonb ([{plan_item_id, step, done_pct}]), la jsonb, materials jsonb ([{item_id, batch, qty}]), implant_udi?, rct_detail jsonb (canals, WL, MAF, obturation), extraction_detail jsonb, ortho_detail jsonb (archwire, elastics), photos jsonb, next_visit_days, by, at.
- **dental_lab_orders**: id, hospital_id, patient_id, plan_item_id, vendor_id, work_type, shade, material, impressions jsonb (stl_keys), sent_at, due_at, received_at, status enum(draft/sent/received/tryin/delivered/remake/cancelled), cost, invoice_ref.
- **dental_radiograph_links**: encounter_id, type enum(iopa/bitewing/opg/cbct/lateral_ceph/photo), teeth smallint[], op22_result_id?/pacs_uid?, annotations jsonb, dose_ref (OP-008).
- **dental_ortho_cases** (`dental.ortho`): id, patient_id, start_date, appliance enum(metal/ceramic/lingual/aligner/functional), malocclusion class, records jsonb (photos, ceph analysis, models/STL), planned_months, instalments jsonb, retention_phase, status.
- Enums: `dentition`, `tooth_status`, `plan_item_status`, `lab_status`.

## 5. Business Rules & Validations

- FDI validity: quadrant/tooth digits legal; primary teeth only when dentition primary/mixed; surfaces valid per tooth class (no incisal on molars); a "missing" tooth blocks restorative planning unless implant/pontic.
- Plan → bill: charge intents (§0.4) per completed sitting or completion (config per procedure); insurance/package mapping (OP-023) & pre-auth (RC-002) for implants/OMFS; discounts by approval matrix; instalment overdue → warning banner and optional block.
- Safety: before extraction/implant/surgical: allergy, anticoagulant (INR check prompt), bisphosphonate/antiresorptive (MRONJ), uncontrolled diabetes/HbA1c, cardiac SBE prophylaxis prompt, pregnancy trimester → EN-029 alerts must be acknowledged; LA max dose calc by weight (lignocaine 4.4/7 mg/kg with adrenaline) warns on cartridge count.
- Implants: fixture UDI/lot mandatory (TR-003), consignment consumption (NC-007), implant passport print for patient.
- Radiographs: AERB dose recorded (OP-008), pregnancy check for females; CBCT justification note.
- Perio: CAL = PD + recession; stage/grade suggestion only, dentist confirms; comparison requires same dentition.
- Chart is derived from append-only tooth events; correction = new event with reason; charts, plans, notes immutable after sign; DMFT computed excluding third molars (config).
- Numbering: `DENT_PLAN`, `DENT_LAB`. Records retention clinical.

## 6. API Surface (`/api/v1/dental`)

| Method         | Path                                                       | Purpose                                   | Permission                     | Idem | Pag    |
| -------------- | ---------------------------------------------------------- | ----------------------------------------- | ------------------------------ | ---- | ------ |
| GET            | /worklist?chair=&dentist=                                  | chairside worklist                        | dental.visit.read              | –    | cursor |
| GET            | /patients/{id}/chart                                       | current chart snapshot + history          | dental.chart.read              | –    | –      |
| POST           | /patients/{id}/chart/events                                | batch tooth events                        | dental.chart.record            | Y    | –      |
| POST/GET       | /patients/{id}/perio                                       | perio chart                               | dental.perio.record/read       | Y    | cursor |
| POST/PATCH/GET | /plans, /plans/{id}, /plans/{id}/items                     | plan & items                              | dental.plan.create/update/read | Y    | cursor |
| POST           | /plans/{id}/present, /accept (portal/esign), /estimate/pdf | presentation/acceptance                   | dental.plan.present            | Y    | –      |
| POST           | /plans/{id}/sittings                                       | sitting record (creates OP-010 procedure) | dental.sitting.record          | Y    | –      |
| POST/PATCH/GET | /lab-orders                                                | lab work                                  | dental.lab.manage              | Y    | cursor |
| POST/GET       | /radiographs                                               | order/link images                         | dental.radiograph.order/read   | Y    | –      |
| POST/GET/PATCH | /ortho/cases                                               | ortho case                                | dental.ortho.manage            | Y    | cursor |
| GET            | /reports/productivity, /reports/plan-conversion            | KPIs                                      | dental.report.read             | –    | –      |

## 7. Domain Events (outbox)

- `dental.chart.updated` → timeline; `dental.plan.presented|accepted|declined` → RC-008, PE-002 reminders; `dental.sitting.completed` {items, charge intents} → OP-005, NC-008 consumption, TR-003 implant usage; `dental.lab.order.sent|received|delivered` → NC-021/NC-005; `dental.recall.due` → PE-002; `dental.alert.mronj|anticoag` → audit.
- Consumes: `visit.checked_in`, `op22.result.attached`, `procedure.completed`, `bill.paid` (instalment), `pacs.study.available`.

## 8. Screens (UI)

1. **Chairside worklist** (desktop/tablet): per chair/dentist, sitting n/N chip, plan balance due, sterilisation tray status; `Enter` open.
2. **Tooth chart workspace** (desktop/tablet pen): odontogram (upper/lower arches, primary toggle), condition palette (`1–9` hotkeys), surface picker, findings list, DMFT tile, radiograph strip mapped to teeth, `Ctrl+Z` undo (creates reversal event), `Ctrl+S`.
3. **Perio chart** (desktop): grid entry with auto-advance, voice-free numeric keypad, delta view vs last, stage/grade suggestion.
4. **Treatment plan & estimate builder**: items grid grouped by phase, alt-options columns, price/payer/discount, instalment scheduler, present mode (patient-facing full-screen with tooth images), accept via signature pad; PDF.
5. **Sitting note** (OP-010 template): RCT canal table, LA calculator, materials scanner, implant UDI scan, photos, next visit.
6. **Lab work board** (kanban: sent/received/try-in/delivered), vendor filters.
7. **Ortho case view**: timeline of adjustments, photos grid (T0/T6/T12), instalments.
8. **Patient portal**: plan/estimate acceptance, instructions, recall.

- Real-time: chart edits by assistant & dentist on same patient merge (event-sourced); empty state "No chart — start exam".

## 9. Integrations

- PACS/EN-008 for OPG/CBCT/ceph DICOM; RVG sensor capture (EN-042/TWAIN); OP-022 for photos/STL/PDF; OP-010 procedure engine; TR-003/NC-007 implants; EN-003 tray traceability; RC-008 estimates; EN-028 consent; NC-021 lab vendors; EN-011 FHIR (Condition with tooth-site SNOMED body-site codes); intra-oral scanner STL export.

## 10. Reports & Analytics

- Chair utilisation & productivity per dentist, plan conversion (presented→accepted→completed), revenue per procedure family, sittings/plan, lab TAT & remake rate, implant register, DMFT/OHI-S population stats, recall compliance, AERB dose per unit, materials consumption. Read model `analytics.dental_daily`.

## 11. Notifications

- Patient: estimate/plan PDF, acceptance link, appointment & sitting reminders, post-op instructions (extraction/RCT/implant/ortho), instalment due, recall. Staff: lab work due/overdue, tray not sterilised alert (EN-003), instalment default, MRONJ/anticoag acknowledgement pending.

## 12. Permissions (RBAC keys)

`dental.visit.read`, `dental.chart.record|read`, `dental.perio.record|read`, `dental.plan.create|update|present|read|discount`, `dental.sitting.record|sign`, `dental.radiograph.order|read`, `dental.lab.manage`, `dental.ortho.manage`, `dental.report.read`, `dental.configure`. Defaults: Dentist — all clinical (discount per matrix); Hygienist/assistant — perio.record, chart.record (assist, no sign), sitting materials; Reception — plan.read, appointments; Billing — plan.read, estimate; Resident — record without sign.

## 13. Non-functional

- Volumes: 300 dental visits/day enterprise (10–15 chairs), 150 radiographs/day; chart render < 500 ms from snapshot; event batch save p95 < 250 ms; STL up to 200 MB. Offline: chart events queue with vector-clock ordering per patient. Print: plan/estimate A4, implant passport, post-op leaflets (regional languages). Accessibility: keyboard hotkeys for palette; large tap targets on tablet.

## 14. Acceptance Criteria (plus OP-025 §0.9)

1. Given tooth 36 marked with occlusal caries (planned composite), when the sitting completes the restoration, then the tooth event becomes "done", chart colour changes, and a charge intent for the composite code posts to OP-005.
2. Given a mixed-dentition 8-year-old, then the chart shows primary teeth 51–85 alongside erupted permanent teeth and rejects condition entry on non-existent teeth.
3. Given a plan with alternative crown options (PFM ₹X vs zirconia ₹Y), when the patient accepts zirconia via signature pad, then the plan status is partial/accepted with the alt item declined and the estimate PDF regenerated.
4. Given a patient on warfarin, when an extraction plan item is scheduled, then an anticoagulant alert requires INR entry/acknowledgement before the sitting can start.
5. Given an implant fixture is placed, then UDI/lot is mandatory, TR-003 records patient-implant trace, and consignment stock decrements.
6. Given a perio chart with PD 6 mm and recession 2 mm at 16-MB, then CAL 8 mm is stored and the delta view highlights vs prior chart.
7. Given RCT planned as 3 sittings, then the worklist shows "sitting 2/3" and completion of sitting 3 marks the item completed and triggers crown reminder.
8. Given a lab order for a zirconia crown due in 7 days, when overdue, then the lab board flags it and the coordinator is notified.
9. Given an ortho case with monthly instalments, when an instalment is overdue by > 15 days, then the chairside worklist shows a due chip and (if configured) blocks new adjustment booking.
10. Given a hygienist tries to sign a treatment plan, then 403 and audit.
11. Given a signed sitting note, when a correction is needed, then amendment creates a new version with reason; the original remains viewable.
12. Given an OPG performed, then the dose entry exists in OP-008 and the image is linked to the chart within 2 s of PACS availability.

## 15. Enhancements / Later phases

- Sheet row 62 (Dental charting, Treatment plans, X-ray, Procedure notes) — core. Market: perio charting, lab work orders, ortho instalments, implant passport, patient-facing presentation mode.
- Later: AI-007 caries/bone-loss detection on IOPA/OPG, intra-oral scanner direct integration, aligner vendor APIs, membership/dental plans (PE-005), voice perio charting (AI-004), CAD/CAM in-house milling queue.

## 16. Open Questions for the Hospital

1. Dental chairs count, specialities present (OMFS/ortho/implant)? Bill per sitting or on completion?
2. Radiograph equipment (RVG sensor brand, OPG/CBCT DICOM?) and AERB registration numbers?
3. Dental lab vendors and material tiers; instalment policy; insurance coverage for dental?
4. Tooth numbering display preference for staff (FDI vs Universal)? Consent templates per procedure?
5. Paediatric dentistry & GA cases through OT (IP-006)?
