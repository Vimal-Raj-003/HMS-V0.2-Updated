# OP-009 — Orthopaedic OPD (Fracture registry link, Implant log, Casting/Splint, X-ray comparison, Post-op follow-up, Rehab referral)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-009 |
| Phase | 6 |
| Priority | P0 |
| Complexity | High |
| Depends on | OP-002 (consultation workspace, ICD-10, e-Rx, orders — OP-009 is a specialty overlay on OP-002, not a second EMR), OP-001 (patient/visit/appointments), OP-007 (vitals), TR-002 (Orthopaedic Fracture Registry — AO/OTA, bone map, X-ray timeline; OP-009 reads/writes registry entries), TR-003 (Implant & Prosthetics — UDI/serial, patient trace; OP-009 logs implants for OP procedures and reads implant history), TR-005 (Cast & Splint Tracking — OP-009 is the primary OP consumer), TR-004/IP-006 (OT booking for surgery from OPD), TR-010 (trauma rehab pathway), OP-015 (physiotherapy referral), OP-016 (pain clinic), OP-017 (wound care), OP-008/EN-008 (X-ray/CT/MRI orders, OHIF viewer, prior comparison), OP-010 (procedure console: injections, aspirations, minor procedures), OP-039 (plaster room / injection room nursing), OP-006 (ER hand-off, MLC), TR-008 (MLC flag), NC-007 (consignment implants), OP-005 (billing: cast material, braces, injections), IP-001 (admission for surgery), EN-028 (consent), EN-039 (forms), EN-029 (CDSS: NSAID/renal, anticoagulant, VTE prophylaxis prompts), EN-009 (SMS/WhatsApp), PE-002 (follow-up recall), EN-011 (ABDM OPConsultRecord), NC-003 (MRD) |
| Feature flag | `module.ortho_opd.enabled` (sub: `ortho.bone_map`, `ortho.proms`, `ortho.brace_inventory`) |
| Primary roles | Doctor — Consultant (Orthopaedic surgeon, OPD) (6), Resident/Junior doctor (14, co-sign), Nurse — OPD/Plaster technician (16), Physiotherapist (40, receives referrals) |
| Secondary roles | Surgeon (9, OT booking), Receptionist (24, follow-up booking), Billing (27), MRD coder (43), Quality (54, fracture/implant registry KPIs), Radiologist (12), Auditor (58) |
| Regulatory | NABH 5th ed. COP (initial assessment, informed consent, safe surgery pathway from OPD), CDSCO Medical Devices Rules 2017 & UDI (implants), Consumer Protection/medico-legal record keeping (implant traceability ≥ 10–15 yrs), MLC (CrPC/BNSS) for RTA/assault fractures via TR-008, ABDM V3 (OPConsultRecord/DiagnosticReport), DPDP Rules 2025, ICD-10 (S-codes with 7th char equivalents mapped in ICD-10-CM style where hospital opts, M-codes for degenerative disease), SNOMED CT (procedures/body sites), AO/OTA 2018 classification, Gustilo-Anderson (open fractures), Salter-Harris (paeds), Garden/Neer/Schatzker/Weber (site classifications), Radiation safety AERB (repeat X-ray governance) |

## 1. Purpose
OP-009 gives orthopaedic surgeons a specialty-tuned OPD console layered over the generic OP-002 workspace: structured musculoskeletal examination, a clickable **bone map** that opens/updates the fracture registry entry (TR-002), side-by-side serial X-ray comparison with healing assessment (RUST/RUSH scores), cast/splint application & removal orchestration with the plaster room (TR-005), implant history and OP implant logging (TR-003), joint injection/aspiration procedures (OP-010), a post-operative follow-up protocol engine (suture removal → X-ray → weight bearing → hardware review), rehab/physio referral (OP-015/TR-010) and outcome scores (PROMs). It is the "P0 – ORTHO SPECIALTY CORE" of the costed proposal and the OP front-end of the trauma & ortho domain.

## 2. Users & Jobs-to-be-done
- **Orthopaedic consultant** (desktop 3-pane, 60–120 patients/day in a trauma-ortho centre; ≤ 90 s for a routine follow-up): review vitals + last visit + X-ray timeline in one glance, document exam by body region, classify fracture on bone map, order X-ray with view protocol, compare with prior films, decide cast/brace/surgery/injection, book OT or plaster room, prescribe (analgesic ladder, DVT prophylaxis, calcium/vit D), refer to physio, schedule protocolised follow-ups, sign.
- **Resident** (same, co-sign): pre-fill exam, drafts orders; consultant co-signs.
- **Plaster technician / OPD nurse** (tablet in plaster room): worklist of cast/splint jobs, record material/type/technique, cast-care instructions, removal, saw safety check; bill items.
- **Physiotherapist**: receive structured referral with precautions (weight-bearing status, ROM limits) and start OP-015 plan.
- **Receptionist**: book protocol follow-ups (auto-suggested dates), plaster room slots, X-ray before consult ("X-ray first" flow).
- **Billing**: cast material/brace/injection charges auto-posted.
- **Quality/HOD**: fracture registry completeness, non-union rate, cast complication rate, follow-up compliance, implant traceability KPIs.

## 3. Core Workflows

### 3.1 Ortho visit intake & "X-ray first" routing
1. Patient checked in (OP-001) with department = Orthopaedics → OP-007 vitals (weight is mandatory — dosing & implant load) → doctor queue. Follow-up visits flagged `visit_type=post_op_followup|fracture_followup|chronic` with the linked **care episode** (fracture registry entry or surgery) shown on the queue card (e.g. "R distal radius #, POD 14, X-ray due").
2. **Pre-consult imaging protocol**: if the follow-up protocol step says "X-ray before review" (or standing order by doctor), the receptionist/nurse triggers the pre-authorised radiology order (OP-008) at check-in → token routed vitals → radiology → doctor (EN-006 multi-stop routing) → doctor sees "X-ray done, images available" chip. Prevents the "see doctor twice" loop. Event `ortho.preconsult_imaging.ordered`.
3. ER/trauma hand-offs (OP-006/TR-001): ER-created fracture registry entries, splints applied in ER (TR-005) and MLC flags (TR-008) appear on the banner; MLC visits show red MLC ribbon and enforce TR-008 documentation rules.

### 3.2 Orthopaedic consultation (overlay on OP-002)
1. Doctor opens patient (`Enter` from queue) → OP-002 workspace with **Ortho tab set** pinned: Summary | Exam | Bone map | Imaging | Cast/Splint | Implants | Procedures | Follow-up | PROMs.
2. **Chief complaint & history** (OP-002 templates + ortho macros: mechanism of injury (fall/RTA/sports/assault/twisting/crush), date-time of injury, hand dominance, occupation/functional demand, prior fractures/surgeries, comorbidities affecting bone (osteoporosis, DM, steroids, smoking), anticoagulants, allergies incl. nickel/metal, tetanus status for open injuries).
3. **Structured MSK exam** per region (EN-039 forms seeded: spine, shoulder, elbow, wrist/hand, hip, knee, ankle/foot, paediatric hip): Look (deformity, swelling, wounds/Gustilo grade, scars), Feel (tenderness map, crepitus, temperature), Move (active/passive **ROM in degrees** per joint with normal reference; goniometer or manual), Neuro-vascular status (distal pulses, cap refill, sensation by dermatome, motor grade MRC 0–5; compartment syndrome red flags → hard alert), special tests (Lachman/McMurray/anterior drawer, Neer/Hawkins/Jobe, Phalen/Tinel, SLR, FABER/FADIR, Thomas, Ortolani/Barlow, Trendelenburg…) with positive/negative/not done, limb length discrepancy, gait. Values are discrete (queryable) → serial ROM trends.
4. **Bone map** (SVG skeleton, anterior/posterior/lateral, adult/paediatric, left/right explicit): click bone → segment → opens **TR-002 fracture registry** create/edit drawer: AO/OTA 2018 code picker (bone → segment → type → group → subgroup, e.g. 2R3A2.2), site-specific classification (Garden, Neer, Schatzker, Weber/Lauge-Hansen, Salter-Harris, Gartland, Sanders, Denis, Frykman, Mason, Colton…), open/closed (Gustilo I/II/IIIA/B/C), displacement/angulation/shortening, articular involvement, associated injuries, pathological fracture flag, date of injury, mechanism, MLC link. Existing registry entries render as coloured markers (red active, amber healing, green united, grey old). Non-fracture problems (OA, tendinopathy, deformity, tumour, infection) marked as **conditions** on the same map with ICD-10 (M-codes) and side; both feed the OP-002 diagnosis list. Event `ortho.problem.recorded` / TR-002 `fracture.registered|updated`.
5. **Diagnosis**: OP-002 ICD-10 picker pre-filtered to S/M/T codes by mapped bone/side; laterality mandatory for paired bones; hospital option for ICD-10-CM 7th-character style encounter qualifier (A initial/D subsequent/G delayed union/K non-union/P malunion/S sequela) stored as `encounter_qualifier` for registries/insurers.
6. **Imaging**: one-click order sets by region ("Wrist PA/lateral/oblique", "Knee AP/lat/skyline", "Pelvis AP + frog lateral", "C-spine series", "Scanogram") → OP-008; contrast/CT/MRI with indication templates; repeat-X-ray governance (AERB): if same view within 7 days show prior with reason prompt.
7. **X-ray comparison panel**: thumbnails from EN-008 for the episode ordered by date; select 2–4 → synchronised OHIF viewer (side-by-side hanging protocol, same window/level, flip/rotate for laterality) or embedded lightweight viewer; doctor records **healing assessment** per follow-up: alignment maintained Y/N, callus (RUST 4–12 tibia / RUSH for radius), implant position (intact/loosening/broken/backed-out), union status enum(not_united/partial/united/delayed_union/non_union/malunion) → written to TR-002 X-ray timeline; annotations (angles: Cobb, Baumann, radial inclination/tilt, neck-shaft) via OHIF measurement tools saved as DICOM SR/JSON `annotation` linked to study.
8. **Plan** (structured, drives downstream automation): conservative (cast/splint/brace/sling, analgesia, RICE, weight-bearing status NWB/TTWB/PWB/WBAT/FWB, ROM restrictions), procedure in OPD (injection/aspiration/manipulation/K-wire removal/suture removal → OP-010), surgery (→ OT booking TR-004/IP-006 with proposed implants → TR-003/NC-007 consignment reservation, pre-op work-up order set, PAC referral IP-024, admission request IP-001, estimate RC-008, pre-auth EN-002), referrals (physio OP-015 with precautions, pain clinic OP-016, wound care OP-017, plastic surgery/vascular via OP-021), medications (OP-002 e-Rx with ortho favourites: NSAID+PPI, tramadol/paracetamol ladder, calcium/vitamin D, bisphosphonates, DVT prophylaxis LMWH/DOAC — EN-029 checks renal function/anticoagulant interaction/paeds dosing), work/fitness certificate (sick leave days, restrictions), medical devices (walker/crutches/collar/brace → brace inventory & billing).
9. **Follow-up protocol**: choose protocol template (e.g. "Distal radius cast — 1w check X-ray, 2w, 6w cast off + X-ray, 12w", "ORIF ankle — 2w suture removal, 6w X-ray + PWB, 12w FWB, 6m, 1y hardware review", "THR — 6w, 3m, 1y, then annual") → system generates dated follow-up plan with per-visit tasks (X-ray views, suture removal, cast change, physio start, PROM questionnaire) → appointment slots pre-booked (OP-001) → reminders (PE-002). Overrides allowed with reason.
10. Sign (`Ctrl+Enter`, resident → consultant co-sign queue) → OP-002 finalises encounter (immutable version, hash chain) → prescription/instructions PDF with **cast care instructions**, weight-bearing status, red-flag symptoms, next visit dates in patient language → WhatsApp/portal (EN-009/PE-001) → ABDM OPConsultRecord (EN-011). Event `ortho.visit.signed`.

### 3.3 Cast / splint / brace orchestration (with TR-005)
1. Plan "apply cast/splint" → **plaster room job** created (TR-005 `cast_events` + OP-039 worklist): type (POP/fibreglass/thermoplastic; short/long arm, below/above knee, cylinder, hip spica, U-slab, thumb spica, back slab, sugar-tong, buddy strapping, cervical collar, functional brace…), side, position instructions, padding, window/bivalve flags, planned duration.
2. Plaster technician (tablet): scan patient wristband/OP slip → apply → record materials (rolls/size, batch), technique, neurovascular check post-application, patient education given (checklist), photo optional → items auto-billed (OP-005) and stock deducted (NC-006 sub-store) → cast label QR (EN-013) printed with apply date, planned removal date, doctor, emergency number → Event `cast.applied` (TR-005).
3. Cast check visits (24–48 h for circumferential casts, per protocol): tightness, swelling, colour, sensation, pain out of proportion → any red flag → immediate doctor alert / split cast; complications logged (pressure sore, skin maceration, compartment syndrome, DVT, cast breakage) → TR-005 complication register + NC-015 incident if harm.
4. Removal/change: due list per day; saw safety checklist; post-removal skin check; new cast/brace or physio referral; Event `cast.removed`.
5. Overdue casts (planned removal passed, no removal event) appear on doctor & plaster room "Overdue" tab and trigger patient reminder.

### 3.4 Implants (with TR-003)
1. Banner chip "Implants: 2" → Implants tab lists patient's implants (TR-003 trace: device, UDI-DI/PI, lot/serial, manufacturer, site, date, surgeon, status in-situ/removed/revised) with recall alerts (TR-003 `implant.recall`) and MRI-conditional flag.
2. OPD implant use (e.g. K-wire, external fixator pin, injectables classified as devices) → log via TR-003 mini-form (scan UDI/GS1 barcode) → consignment/consumption (NC-007/NC-008) → bill.
3. Hardware review at protocol follow-ups: implant position assessment (3.2.7) auto-links to implant record; "implant removal" plan → OT booking; patient **implant card** printable/portal (device, UDI, date, surgeon, hospital contact — CDSCO patient info requirement).

### 3.5 OP procedures (with OP-010)
- Intra-articular/peri-articular injections (steroid/HA/PRP), aspiration (with cell count/culture orders), closed reduction & manipulation (with sedation → OP-006 day care/procedure room), K-wire removal, suture/staple removal, wound dressing (OP-017), nerve blocks (with OP-016). OP-009 pre-populates OP-010 with site/side/laterality, consent template (EN-028: joint injection consent incl. infection/flare/skin change risks), drug/dose (triamcinolone 40 mg etc. — EN-029 checks DM/anticoagulants, max steroid injections per joint per year rule configurable ≤ 3–4), image guidance flag (USG/fluoro → OP-008/AERB dose), post-procedure instructions; complications recorded to OP-010 30-day tracker.

### 3.6 Rehab referral & return-to-function (with OP-015 / TR-010)
- Structured referral: diagnosis/procedure, POD/weeks since injury, weight-bearing status, ROM limits, precautions (posterior hip precautions, no resisted flexion 6w…), goals (ROM/strength/gait/ADL/return to work or sport), frequency/duration, home exercise programme (OP-015 library) → physio accepts (TAT tracked OP-021 style) → progress notes visible in Ortho tab; discharge summary from physio returns to surgeon.
- Trauma patients: TR-010 pathway (FIM/Barthel milestones, return-to-work certificate).

### 3.7 PROMs & outcome tracking
- Protocol-triggered questionnaires (pre-op baseline, 6w/3m/6m/1y): Oxford Hip/Knee/Shoulder, DASH/QuickDASH, KOOS/HOOS, WOMAC, ODI/NDI, Lysholm/IKDC, AOFAS, Constant, VAS pain, EQ-5D-5L, Harris Hip (clinician) — delivered by WhatsApp link/portal (PE-001, EN-030 survey engine) or tablet in clinic; scores computed & trended; non-responders reminded ×2; results in analytics (surgeon-wise outcome dashboards, TR-011).

### 3.8 Exceptions
- **Compartment syndrome / open fracture / neurovascular deficit / suspected septic arthritis / cauda equina** flagged in exam → red banner, "Send to ER/OT" one-click (OP-006 ER visit or TR-004 emergency OT), notification to on-call (EN-037), MLC prompt where applicable.
- Wrong-side safety: laterality mismatch between diagnosis, imaging order, plaster job, OT booking → hard-stop with reconcile dialog.
- Cancel/rollback: plaster job cancelled before application → no charge; after application → charge stays, removal documented; orders follow OP-002 cancel rules.
- Offline (PWA): exam forms and follow-up planning queue locally; bone map edits queue with `client_version`; on conflict (another user edited registry entry) → server keeps both versions and shows merge prompt to doctor (registry entries are versioned in TR-002).

## 4. Data Model (schema `ortho`; registry/implant/cast tables owned by TR-002/TR-003/TR-005 and referenced by FK)
- **ortho_episodes**: id, hospital_id, branch_id, patient_id, type enum(fracture/post_operative/degenerative/sports/paediatric/spine/tumour/infection/other), fracture_id? (TR-002), surgery_id? (IP-006/TR-004), primary_icd10, side enum(left/right/bilateral/midline/na), started_at, closed_at, closure_reason enum(united/recovered/transferred/lost_to_follow_up/died/other), lead_doctor_id, protocol_id?, status enum(active/closed), version. Index (hospital_id, patient_id, status), (hospital_id, lead_doctor_id, status).
- **ortho_exams**: id, hospital_id, encounter_id (clinical.encounters), episode_id?, region enum(spine_c/spine_t/spine_l/shoulder/elbow/wrist_hand/hip/knee/ankle_foot/pelvis/other), side, form_response_id (EN-039), rom jsonb ({joint, movement, active_deg, passive_deg, pain bool}[]), neurovascular jsonb, special_tests jsonb, red_flags text[], gait, llq_cm, recorded_by, recorded_at, version. Index (encounter_id), (hospital_id, patient_id via encounter, recorded_at).
- **ortho_bone_map_marks**: id, hospital_id, patient_id, episode_id?, bone_code (SNOMED body structure), segment, side, mark_type enum(fracture/condition/implant/prior_surgery/amputation), fracture_id? (TR-002), icd10?, status enum(active/healing/resolved/historic), x_pct/y_pct/view (svg coords), created_by, created_at. Index (hospital_id, patient_id).
- **ortho_healing_assessments**: id, hospital_id, episode_id, fracture_id (TR-002), study_uid (EN-008), assessed_at, weeks_since_injury, alignment_maintained bool, rust_score int?, rush_score int?, callus_grade, implant_status enum(na/intact/loosening/broken/backed_out/migrated), union_status enum(not_united/partial/united/delayed_union/non_union/malunion), angles jsonb, comparison_study_uids text[], notes, assessed_by. Index (fracture_id, assessed_at).
- **ortho_plans**: id, hospital_id, encounter_id, episode_id, treatment_intent enum(conservative/procedure_opd/surgery/observation/referral_only), weight_bearing enum(nwb/ttwb/pwb/wbat/fwb), rom_restrictions text, immobilisation_request_id? (TR-005 cast job), surgery_request_id? (ot booking), physio_referral_id? (OP-015), other_referral_ids uuid[], devices jsonb ({item_id, qty}), fitness_cert jsonb, plan_text, signed_by, signed_at, version.
- **ortho_followup_protocols** (hospital-configurable, versioned): id, hospital_id, name, applies_to (icd/procedure/AO patterns), steps jsonb ([{offset_days, window_days, tasks:[xray views, suture_removal, cast_change, cast_off, physio_start, prom:oxford_knee, hardware_review], notes}]), is_active, version.
- **ortho_followup_plans**: id, hospital_id, episode_id, protocol_id, protocol_version, anchor_date (injury/surgery date), created_by; **ortho_followup_steps**: id, plan_id, seq, due_date, window_days, tasks jsonb, appointment_id? (OP-001), status enum(pending/booked/done/missed/skipped), done_encounter_id?, skipped_reason. Index (hospital_id, due_date, status) for recall lists.
- **ortho_prom_responses**: id, hospital_id, patient_id, episode_id, instrument enum(oxford_hip/oxford_knee/oxford_shoulder/dash/quickdash/koos/hoos/womac/odi/ndi/lysholm/ikdc/aofas/constant/harris_hip/vas/eq5d5l), timepoint enum(baseline/6w/3m/6m/1y/2y/adhoc), answers jsonb, score numeric, subscores jsonb, channel enum(whatsapp/portal/tablet/clinician), responded_at, sent_at, reminders int. Index (episode_id, instrument, timepoint).
- **ortho_order_sets** (hospital-configurable): id, hospital_id, name, region, imaging jsonb, labs jsonb, rx_template_id (OP-002), procedure_template_id (OP-010), consent_template_id (EN-028), is_active.
- **ortho_devices_dispensed** (braces/aids): id, hospital_id, encounter_id, item_id (NC-006), size, side, qty, fitted_by, instructions_given bool, bill_item_id.
- Referenced (not owned): TR-002 `trauma.fractures`, `fracture_xray_timeline`; TR-003 `trauma.implants`, `implant_usage`; TR-005 `trauma.cast_events`, `cast_complications`; OP-010 `clinical.procedures`; OP-015 `specialty.physio_referrals`.
- All tables: hospital_id, branch_id where relevant, created_*/updated_*, version, RLS. Retention: clinical (≥ 10 y; implant-linked ≥ 15 y or device lifetime + 2 y).

## 5. Business Rules & Validations
- Laterality is mandatory for paired structures on diagnosis, imaging orders, plaster jobs, procedures and OT bookings; mismatch across artefacts of the same episode → hard-stop reconcile (wrong-site prevention, NABH safe surgery).
- Every fracture diagnosis (ICD-10 S02–S92, T02, T08, T10, T12, M80.x, M84.3/4) must have a TR-002 registry entry with at least AO/OTA bone+segment+type; sign blocked otherwise (config: warn vs block; default block for trauma-ortho centres).
- Open fracture → tetanus status & antibiotic timing prompts; Gustilo ≥ IIIB → vascular/plastics referral prompt; compartment syndrome red flags → cannot be dismissed without documented action.
- Weight-bearing status and ROM restrictions must be present in the plan whenever a cast/brace/surgery/physio referral exists; printed on patient instructions and passed to OP-015.
- Repeat X-ray of same region within 7 days requires reason (AERB justification); cumulative dose visible from OP-008.
- Steroid joint injection frequency guard: > N per joint per 12 months (default 3) → override with reason; anticoagulated/DM patients → CDSS advisory.
- Follow-up protocol steps missed by > window → `missed` → recall list (PE-002) → after 2 unanswered contacts, episode flagged `lost_to_follow_up` candidate (not auto-closed; doctor closes).
- Cast: planned removal date mandatory; circumferential cast → 24–48 h check step auto-added; overdue casts escalate at +7 days to doctor and +14 days to HOD.
- Implants: any implant used/recorded must carry UDI or manufacturer+lot; recall notice → all patients with matching UDI-DI/lot listed for contact (TR-003 owns).
- Resident notes require consultant co-sign within 24 h; unsigned notes block finalisation & billing of consultant fee (config).
- Fitness/sick-leave certificate: numbered series `MED_CERT`, doctor e-sign (EN-016), copy in NC-003; editable only by issuing doctor via new version.
- Numbering: episode uses `ORTHO_EP` series `{BR}/{FY}/{SEQ:6}`; PROM links single-use tokens expiring 14 days.
- Immutability: signed exams/plans/healing assessments versioned; corrections create new version with reason.

### 5.1 Seeded follow-up protocols (`ortho_followup_protocols`, hospital-editable; offsets from anchor date)
| Protocol | Anchor | Steps (day offset → tasks) |
|---|---|---|
| Distal radius — cast | injury/reduction | 7 (X-ray wrist PA/lat, cast check), 14 (review), 42 (cast off, X-ray, physio start, QuickDASH), 84 (X-ray, QuickDASH), 180 (QuickDASH) |
| Paediatric forearm both-bone — cast | reduction | 7 (X-ray), 21 (X-ray), 42 (cast off, X-ray), 84 (review) |
| Ankle ORIF | surgery | 14 (suture removal, wound check), 42 (X-ray AP/lat/mortise, PWB, physio), 84 (X-ray, FWB, AOFAS), 180 (AOFAS), 365 (hardware review, X-ray) |
| Tibia IM nail | surgery | 14 (sutures), 42 (X-ray, PWB→WBAT), 84 (X-ray, RUST), 180 (X-ray, RUST — non-union screen if RUST < 10), 365 (X-ray) |
| Hip fracture (DHS/hemiarthroplasty) | surgery | 14 (sutures), 42 (X-ray, mobilisation review, Harris Hip), 90 (X-ray), 180 (Harris Hip), 365 (X-ray, Harris Hip) |
| Total knee / hip arthroplasty | surgery | 14 (sutures), 42 (X-ray, Oxford), 90 (Oxford), 365 (X-ray, Oxford), then yearly ×5 |
| ACL reconstruction | surgery | 14 (sutures), 42 (physio phase 2, ROM), 90 (Lysholm/IKDC), 180 (return-to-sport tests), 365 (IKDC) |
| Clavicle — conservative | injury | 14 (X-ray), 42 (X-ray, sling off), 84 (X-ray, Constant) |
| Spine — conservative LBP | visit | 14 (review, ODI), 42 (ODI, physio review), 90 (ODI) |
| Joint injection | procedure | 14 (phone review, VAS), 42 (review, VAS) |
Each step has a default window (±3 days ≤ 6 weeks; ±7 days after) and auto-book flag; hospital may add protocols per doctor.

### 5.2 Normal ROM reference (degrees; seeded, used for exam grid hints and % of normal in reports)
| Joint | Movement | Normal |
|---|---|---|
| Shoulder | Flexion / Abduction / ER / IR | 180 / 180 / 90 / 70 |
| Elbow | Flexion / Extension / Pronation / Supination | 145 / 0 / 80 / 80 |
| Wrist | Flexion / Extension / Radial dev / Ulnar dev | 80 / 70 / 20 / 30 |
| Hip | Flexion / Extension / Abduction / Adduction / IR / ER | 120 / 30 / 45 / 30 / 45 / 45 |
| Knee | Flexion / Extension | 135 / 0 (hyperextension recorded as −) |
| Ankle | Dorsiflexion / Plantarflexion / Inversion / Eversion | 20 / 50 / 35 / 15 |
| Cervical spine | Flexion / Extension / Rotation / Lateral flexion | 50 / 60 / 80 / 45 |
| Lumbar spine | Flexion / Extension / Lateral flexion | 60 / 25 / 25 |

### 5.3 Seeded ortho order sets (`ortho_order_sets`)
| Name | Imaging | Labs / other | Rx template | Consent |
|---|---|---|---|---|
| Wrist injury | X-ray wrist PA, lateral, oblique (± scaphoid series) | — | Analgesic ladder adult | — |
| Knee injury / effusion | X-ray knee AP, lateral, skyline; MRI knee if ligament suspected | Aspirate: cell count, Gram, culture, crystals | NSAID+PPI | Aspiration consent |
| Hip pain elderly | X-ray pelvis AP + lateral hip | Vit D, Ca, ALP, RFT | Ca + Vit D, analgesic | — |
| Pre-op work-up (elective) | Chest X-ray, ECG | CBC, RFT, LFT, RBS/HbA1c, PT/INR, HIV/HBsAg/HCV, blood group, urine R/M | Stop anticoagulants per EN-029 rules | Surgery consent (EN-028) |
| Open fracture (from ER) | X-ray involved bone 2 views incl. joints above/below | CBC, RFT, blood group, tetanus status | IV antibiotics per open-fracture protocol, TT/TIG | — |
| Back pain red-flag screen | X-ray LS spine AP/lat; MRI if red flags | ESR/CRP, CBC | Analgesic, muscle relaxant | — |
| Paediatric limp | X-ray pelvis AP + frog lateral, USG hip (effusion) | CBC, ESR, CRP | — | — |

## 6. API Surface (`/api/v1/ortho`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /worklist?doctor=&date=&type= | ortho queue with episode/protocol chips | ortho.worklist.read | – | cursor |
| POST | /episodes | create episode (from encounter/fracture/surgery) | ortho.episode.create | Y | – |
| GET/PATCH | /episodes/{id} | read/update (close with reason) | ortho.episode.read/update | Y | – |
| GET | /patients/{id}/episodes | list | ortho.episode.read | – | cursor |
| POST | /encounters/{id}/exams | save regional exam (form response + discrete ROM/NV) | ortho.exam.create | Y | – |
| GET | /patients/{id}/exams?region= | serial exams / ROM trend | ortho.exam.read | – | cursor |
| GET | /patients/{id}/bone-map | marks + registry summary | ortho.bonemap.read | – | – |
| POST/PATCH | /patients/{id}/bone-map/marks | add/update mark (creates TR-002 entry when fracture) | ortho.bonemap.update | Y | – |
| POST | /episodes/{id}/healing-assessments | record healing/implant status vs studies | ortho.healing.create | Y | – |
| GET | /episodes/{id}/imaging-timeline | studies + assessments for comparison | ortho.imaging.read | – | – |
| POST | /encounters/{id}/plans | save plan (fans out: cast job, OT request, referrals, devices) | ortho.plan.create | Y | – |
| POST | /episodes/{id}/followup-plans | apply protocol → steps + appointments | ortho.followup.create | Y | – |
| PATCH | /followup-steps/{id} | reschedule/skip/mark done | ortho.followup.update | Y | – |
| GET | /followups/due?from=&to=&status= | recall list | ortho.followup.read | – | cursor |
| POST | /episodes/{id}/proms/send | issue PROM link(s) | ortho.prom.send | Y | – |
| POST | /proms/{token} | patient submission (public, token) | – | Y | – |
| GET | /episodes/{id}/proms | scores/trend | ortho.prom.read | – | – |
| POST | /encounters/{id}/preconsult-imaging | trigger standing X-ray order at check-in | ortho.preconsult_imaging.create | Y | – |
| GET | /order-sets, /protocols; POST/PUT same | config | ortho.configure | Y | cursor |
| POST | /encounters/{id}/certificates/fitness | issue fitness/sick-leave certificate | ortho.certificate.issue | Y | – |
| GET | /stats/dashboard?doctor=&range= | KPIs (read model) | ortho.report.read | – | – |
Cast/implant/procedure endpoints are called on TR-005/TR-003/OP-010 APIs; OP-009 UI composes them.

## 7. Domain Events (outbox)
- `ortho.episode.opened|closed` {episode_id, patient_id, type, fracture_id?} → analytics, PE-002, TR-011.
- `ortho.problem.recorded` {mark, icd10, side, fracture_id?} → OP-002 diagnosis list, TR-002.
- `ortho.exam.recorded` {encounter_id, region, red_flags[]} → CDSS/EN-037 (red flags), timeline.
- `ortho.healing.assessed` {fracture_id, union_status, implant_status, study_uid} → TR-002 timeline, TR-003 (implant status), analytics (non-union rate).
- `ortho.plan.signed` {encounter_id, intent, weight_bearing, requests[]} → TR-005 (cast job), TR-004/IP-006 (OT request), OP-015 (referral), OP-010, OP-005 (device charges), PE-001 (instructions).
- `ortho.followup.planned|step.due|step.missed` → OP-001 (booking), PE-002 (reminders/recall), EN-009.
- `ortho.prom.sent|prom.completed` {episode_id, instrument, score} → analytics, doctor inbox.
- `ortho.preconsult_imaging.ordered` → OP-008, EN-006 routing.
- Consumes: `fracture.registered|updated` (TR-002), `cast.applied|removed|complication` (TR-005), `implant.recorded|recall` (TR-003), `rad.report.final` & `rad.study.available` (OP-008/EN-008), `procedure.completed` (OP-010), `physio.plan.discharged` (OP-015), `visit.checked_in` (OP-001), `ot.case.completed` (IP-006).

## 8. Screens (UI)
1. **Ortho worklist** (desktop/tablet): OP-002 queue with ortho chips (episode, POD/weeks, "X-ray due/done", cast overdue, PROM pending); filters new/follow-up/post-op; `Space` call next, `Enter` open, `X` order pre-consult X-ray, `F` open follow-up recall list. Real-time via socket (queue, image-available). Empty: "No patients waiting"; error: retry banner.
2. **Ortho consultation workspace** (desktop 3-pane: left patient banner+episode timeline, centre tabs, right imaging rail): tabs `1..9`; `Ctrl+B` bone map, `Ctrl+I` imaging compare, `Ctrl+P` plan, `Ctrl+F` follow-up protocol, `Ctrl+Enter` sign; ROM entry grid with `Tab`; special-test toggles `+/-/0`; red-flag banner sticky. Right rail shows latest study thumbnails, prior comparison button, cast status card, implant card, PROM latest scores. Offline: exam/plan queued (banner "offline — 2 pending").
3. **Bone map** (desktop/tablet touch): SVG skeleton with view toggle (A/P/lateral, paeds), zoom, side lock; click bone → segment → AO/OTA wizard (3 clicks) + site classification; markers legend; history slider (marks over time).
4. **X-ray comparison** (desktop, dual monitor aware): 2×2 grid, sync zoom/pan/WL, flip for laterality, measurement tools (angle/length/Cobb), healing-assessment form docked; `←/→` step studies; `S` sync toggle; opens full OHIF (EN-008) in new window.
5. **Plaster room worklist** (tablet/desktop in plaster room; also OP-039 nursing): jobs due today (apply/check/change/remove), scan-to-open, materials picker with batch, NV check form, patient education checklist, print cast label; overdue tab; `Ctrl+S` save.
6. **Follow-up planner** (desktop): protocol picker, generated timeline (Gantt-like) with editable dates, auto-book toggle, per-step tasks, patient-friendly print (dates in local language).
7. **Ortho recall / follow-up compliance list** (desktop, receptionist & doctor): due/missed steps, contact status, one-click WhatsApp/call log (PE-002).
8. **PROM capture** (patient phone via link; clinic tablet kiosk mode): large touch controls, one question per screen, progress bar, multilingual (en/hi/regional), offline-tolerant submit.
9. **Ortho HOD dashboard** (desktop, dark analytics theme): volumes, fracture mix, non-union/complication rates, cast complications, follow-up compliance, PROM improvement, implant traceability completeness, TAT X-ray→consult.

## 9. Integrations
- EN-008/OP-008: study availability, OHIF viewer with hanging protocol URL params, DICOM SR/JSON annotations; MWL for pre-consult orders.
- TR-002/TR-003/TR-005: internal module APIs/events (same monolith), no direct table writes.
- NC-007 consignment implant reservation for planned surgery; NC-006 plaster-room sub-store; OP-005 charge posting.
- EN-009 WhatsApp for instructions/PROM links (DLT templates), EN-011 ABDM OPConsultRecord/WellnessRecord (PROMs optional), EN-016 e-sign for certificates, EN-028 consent, EN-030 survey engine for PROMs.
- External registries (later): hospital-level export of fracture/arthroplasty registry data (ISHKS/Indian Arthroplasty Registry, NTDB-style via TR-011) as CSV/FHIR Bundle.
- Retries via outbox; if PACS unavailable, comparison panel shows "images pending" and doctor may proceed with report text.

## 10. Reports & Analytics
- Ortho OPD census (new/follow-up/post-op by doctor/day), fracture registry completeness (% fractures with AO code), union/non-union/malunion rates by fracture type & treatment, cast register & complication rate, overdue casts, follow-up compliance (% steps done within window), lost-to-follow-up, PROM response rate & mean improvement (Oxford/DASH/KOOS), injection register (joint/drug/complications), implant utilisation & traceability, X-ray-before-consult TAT, revenue per episode (via OP-005), surgeon-wise dashboards.
- Read models: `analytics.ortho_episode_daily`, `analytics.ortho_followup_compliance`, `analytics.ortho_outcomes` (mat views refreshed hourly/nightly).

## 11. Notifications
- Patient (WhatsApp/SMS/push, DLT templates): cast-care instructions + emergency number; follow-up due (D-3, D-1); missed follow-up recall; PROM questionnaire link + 2 reminders; cast removal due; implant card available on portal.
- Doctor/team (push/in-app): pre-consult X-ray available; red-flag exam recorded by resident; cast complication reported by plaster room; overdue cast escalation; implant recall affecting own patients; co-sign pending > 12 h; PROM completed with worsening score.
- TV (EN-018): plaster room queue tokens.

## 12. Permissions (RBAC keys)
`ortho.worklist.read`, `ortho.episode.create|read|update|close`, `ortho.exam.create|read`, `ortho.bonemap.read|update`, `ortho.healing.create|read`, `ortho.imaging.read`, `ortho.plan.create|read|sign`, `ortho.followup.create|update|read`, `ortho.prom.send|read`, `ortho.preconsult_imaging.create`, `ortho.certificate.issue`, `ortho.configure`, `ortho.report.read`, `ortho.export`.
Defaults: Ortho consultant/surgeon — all clinical keys incl. sign; Resident — create/read (sign requires co-sign policy `requires_cosign`); Plaster tech/OPD nurse — worklist.read, followup.read, plus TR-005 cast keys; Physio — episode.read, plan.read; Receptionist — followup.read/update (booking), preconsult_imaging.create; HOD/Quality — report.read, export; Billing — read of plan devices only via OP-005.

## 13. Non-functional
- Volumes: 2000-bed trauma-ortho enterprise: 800–1500 ortho OP visits/day across branches, 40 % follow-ups, 200 casts/day, 100k active episodes; bone map/exam save p95 < 200 ms; imaging timeline (metadata) < 300 ms (thumbnails from EN-008 cache); comparison viewer first image < 2 s on LAN.
- Offline: PWA caches protocols/order sets/forms; exam & plan mutations queued (IndexedDB) with idempotency keys; conflict → server-side version keep-both + doctor merge; plaster room tablet works offline for job completion (sync ≤ 5 min).
- Printing: A4 instructions/certificates (Playwright PDF), cast QR labels (ZPL 50×25 mm), implant card (A6/PDF).
- Accessibility/i18n: keyboard-first, high-contrast red-flag banners, SVG bone map with ARIA labels and list fallback; patient documents in en/hi + regional; units metric (degrees, cm, kg); RTL-ready.
- Security: PROM public endpoints token-scoped & rate-limited; MLC episodes restricted per TR-008; audit on all writes; break-glass READ_PHI logging.

## 14. Acceptance Criteria
1. Given a doctor diagnoses ICD-10 S52.5 (distal radius fracture) without a registry entry, when they try to sign, then the system blocks (default policy) with a one-click bone-map drawer that creates the TR-002 entry with AO/OTA 2R3 code and side.
2. Given a bone-map mark on the left tibia and an imaging order for right tibia in the same encounter, when the doctor signs, then a laterality mismatch hard-stop appears and signing is prevented until reconciled.
3. Given a follow-up protocol "ORIF ankle" applied on surgery date D, when saved, then steps at D+14 (suture removal), D+42 (X-ray + PWB), D+84 (FWB), D+180, D+365 exist with appointments booked in OP-001 and reminders scheduled in PE-002.
4. Given a step's due date passes by more than its window without completion, when the nightly job runs, then the step is `missed`, appears on the recall list and a WhatsApp recall is sent (DLT template) once, logged in PE-002.
5. Given a plan requests a below-knee POP cast, when signed, then a plaster room job appears in TR-005/OP-039 worklist within 2 s (socket), and after application, cast material charges post to the OP bill and stock is deducted from the plaster sub-store.
6. Given a circumferential cast applied today, then a 24–48 h cast-check step is auto-added and appears in the plaster room "due" list tomorrow.
7. Given a cast planned removal date passed 8 days ago with no removal event, then the doctor sees it in "Overdue casts" and an escalation notification exists; at +14 days the HOD is notified.
8. Given two X-ray studies of the same episode, when the doctor opens comparison, then both render side-by-side with synced window/level within 2 s and a healing assessment (RUST score, union status) can be saved and appears in the TR-002 X-ray timeline.
9. Given a resident saves an exam with "pain out of proportion + tense compartment" red flags, then a red banner appears, the consultant on duty is push-notified within 5 s and the note cannot be signed without a documented action.
10. Given a joint has 3 steroid injections in the past 12 months, when a 4th is planned, then a guard prompts for override reason and CDSS advisory is logged.
11. Given a signed encounter, when the doctor edits the plan, then a new version is created with reason; the original remains retrievable and the hash chain validates.
12. Given a patient with an implant whose UDI-DI is under recall (TR-003 event), when the ortho worklist loads, then the patient card shows a recall chip and the implants tab shows recall details.
13. Given a physio referral with WBAT and "no flexion > 90°" restrictions, when the physiotherapist opens OP-015, then the precautions display prominently and are copied into the plan header.
14. Given a PROM link sent by WhatsApp, when the patient completes Oxford Knee Score, then the score is computed (0–48), stored with timepoint and visible on the episode within 5 s; the link cannot be reused.
15. Given the tablet is offline in the plaster room, when a technician completes a cast application, then it saves locally and syncs within 5 min of reconnect with the original timestamps and no duplicate job.
16. Given a user without `ortho.plan.sign`, when they call POST /plans with sign=true, then 403 with RFC 9457 body and an audit entry.
17. Given a repeat X-ray order of the same region within 7 days, then the order requires a justification reason before submission (AERB) and the prior study is displayed.
18. Given the HOD dashboard, then it loads from `analytics.ortho_*` read models in < 1 s for a 12-month range and never queries live transactional tables.

## 15. Enhancements / Later phases
- Costed proposal OP-009 line 1564: fracture registry, implant log, casting/splint tracking, X-ray comparison, post-op follow-up, rehab referral — all Phase 6 core above.
- Phase 8: PROM automation via EN-030; brace inventory (`ortho.brace_inventory`); TR-010 return-to-work; OP-016 pain pathway integration.
- Phase 11: registry exports (arthroplasty/fracture registries), TR-011 quality indicators, FHIR `Procedure`/`Device`/`Condition` resources.
- Phase 12: AI (AI-007) fracture detection prioritisation on X-ray, AI-002 non-union risk prediction, AI-004 voice exam dictation, AI-006 ICD-10-CM/PCS coding assist; 3D CT reconstruction & pre-op planning/templating (digital templating for arthroplasty) as integration with vendor tools.
- (market) MocDoc/SmartHospital: procedure photo capture per visit, WhatsApp report send, service-isolated queues — covered via OP-010/EN-009/EN-006. Gait analysis / wearable ROM sensors (EN-042) later.

## 16. Open Questions for the Hospital
1. Is fracture registry entry mandatory (block sign) for every fracture ICD code, or warn only? Which specialties besides ortho record fractures (ER, paeds)?
2. Which fracture classification systems must be seeded beyond AO/OTA (Garden, Neer, Schatzker, Weber, Salter-Harris, Gartland, others)? Do you want ICD-10-CM-style encounter qualifiers (A/D/G/K/P/S)?
3. Provide your standard follow-up protocols per injury/procedure (dates, X-ray views, weight-bearing milestones) and default cast durations.
4. Which PROMs do you use today (Oxford, DASH, KOOS, WOMAC, ODI, Harris)? Timepoints? Do you have licences where required?
5. Plaster room: is it staffed by technicians or nurses? Do you bill cast material by roll/batch or as a flat procedure charge? Is there a separate plaster sub-store?
6. Steroid injection frequency limit per joint (default 3/12 months)? Which injectables (triamcinolone, methylprednisolone, HA, PRP) and image-guidance availability?
7. Should the "X-ray before consult" standing-order flow be enabled for all ortho follow-ups, and who authorises (doctor standing order vs receptionist rule)?
8. Implant patient card format and CDSCO/UDI capture method (GS1 barcode scanner at OT/OPD)? Consignment vendors and recall communication owner?
9. Do you participate in any arthroplasty/fracture registry needing export? Format?
10. Resident co-sign SLA (default 24 h) and whether unsigned notes block consultant fee billing?
11. Fitness/sick-leave certificate template, numbering and signatory rules; is Aadhaar eSign (EN-016) required?
12. Wrong-side prevention: should the hard-stop also apply to plaster jobs and injections (default yes)?
