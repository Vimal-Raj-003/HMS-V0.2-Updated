# OP-017 — Wound Care Clinic (Wound assessment BWAT, Photo documentation, Dressing protocol, Healing trajectory, Follow-up)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-017 |
| Phase | 8 (wound record & photos used from Phase 6/7 by trauma & IP nursing) |
| Priority | P1 |
| Complexity | Medium |
| Depends on | OP-002 (consult/orders), OP-039 (OPD dressing room execution), OP-010 (debridement/minor procedures, NPWT application), OP-009/TR-002 (open fractures, post-op wounds), IP-003/IP-004 (ward wound care, pressure injury Braden, wound photos from nursing mobile), IP-012 (infection control: SSI surveillance, MDRO), OP-004 (wound culture, HbA1c, albumin), OP-008 (X-ray/MRI osteomyelitis, ABI/duplex via OP-029 vascular), OP-011 (nutrition), OP-015 (offloading/physio), OP-016 (pain), OP-031 (radiation wounds), NC-006/OP-003 (dressing materials, NPWT consumables/rentals), NC-020 (NPWT pumps/assets), OP-005 (billing: dressing tariff by size/type, NPWT per day), EN-002 (insurance for NPWT/hyperbaric), EN-013 (barcode), EN-039 (forms), EN-028 (photo consent), EN-009, PE-001/OP-020 (home care instructions, patient photo upload), OP-018 (tele wound review), NC-016 (BMW), NC-015 (incidents: HAPI), EN-011 |
| Feature flag | `module.wound_care.enabled` (sub: `wound.ai_measure`, `wound.home_photo_upload`, `wound.npwt`) |
| Primary roles | Wound care nurse / Enterostomal therapist (16/17), Surgeon / Plastic surgeon / Diabetic foot physician (6/9) |
| Secondary roles | Ward nurse (17), Podiatrist, Dietician (39), Physio (40), Infection control nurse (21), Pharmacist/Stores (30/44), Billing (27), Quality (54: pressure injury rates), Patient/caregiver (home dressing), Auditor |
| Regulatory | NABH 5th ed. (pressure injury prevention & reporting as quality indicator, wound care documentation, infection control), NPIAP/EPUAP pressure injury staging 2019, IWGDF diabetic foot guidelines 2023 (Wagner/UT/WIfI/SINBAD), Bates-Jensen Wound Assessment Tool (BWAT), PUSH tool, TIME/T.I.M.E.R.S. framework, BMW Rules 2016 (dressing waste yellow bag), DPDP (clinical photos = sensitive PHI, consent), CDSCO (dressings/NPWT devices), IRDAI (NPWT coverage) |

## 1. Purpose
OP-017 gives a structured, photo-based wound record shared by the OPD wound clinic, dressing room, wards and home care: wound registry per patient with aetiology classification (diabetic foot, venous/arterial ulcer, pressure injury, traumatic, surgical/SSI, burn, malignant), standardised assessment (BWAT, PUSH, NPIAP stage, Wagner/WIfI, TIME) with measurements and calibrated photos, dressing protocols and product selection, NPWT tracking, healing-trajectory analytics (area reduction %, expected vs actual), infection/complication flags with culture and antibiotic linkage, offloading/nutrition/vascular referrals, patient/caregiver instructions with home photo upload and tele review, and dressing/NPWT billing.

## 2. Users & Jobs-to-be-done
- **Wound nurse** (tablet with camera; 30–60 dressings/day; ≤ 4 min documentation): open wound, photograph with scale marker, measure (L×W×D, undermining/tunnelling), score, select dressing per protocol, record consumables, next dressing schedule, educate.
- **Surgeon/physician**: review trajectory, debride (OP-010), order cultures/imaging/vascular studies, antibiotics, NPWT/hyperbaric/grafting decisions, sign plan.
- **Ward nurse** (IP-004 mobile): Braden risk, turning schedule compliance, HAPI reporting, wound photos at bedside — same wound record.
- **ICN**: SSI surveillance from surgical wound records; MDRO flags.
- **Patient/caregiver**: home dressing instructions, upload photos, book follow-up.
- **Quality**: pressure injury incidence/prevalence, healing rates, SSI.

## 3. Core Workflows
### 3.1 Wound registration
1. From consult/ward/ER/procedure: create **wound** on patient body map (location SNOMED, laterality), aetiology enum, onset date, cause, related episode (fracture TR-002, surgery IP-006 → SSI surveillance IP-012, admission for HAPI), comorbidities (DM, PAD, venous disease, neuropathy, immunosuppression, nutrition), baseline photo & measurements; wound ID printed on dressing chart label. Multiple wounds per patient tracked separately.
2. Risk & classification: pressure injury NPIAP stage 1–4/unstageable/DTPI (+ Braden), diabetic foot Wagner 0–5 / UT grade-stage / WIfI (wound, ischaemia (ABI/toe pressure), foot infection IDSA/IWGDF), venous (CEAP), burn %TBSA (Lund-Browder) & depth, SSI (superficial/deep/organ-space, CDC criteria), traumatic (contamination), malignant. Event `wound.registered`.
### 3.2 Assessment & photo documentation (each dressing visit)
1. Photo capture (tablet camera or IP-004 phone; consent EN-028 once per patient for clinical photography): guided overlay (same angle/distance), **calibration marker/ruler** in frame → optional AI planimetry (`wound.ai_measure`, later) else manual: length × width (cm, head-to-toe × side-to-side), depth, undermining/tunnelling (clock positions), area auto = L×W×0.785 (ellipse) or traced; photo stored encrypted (S3), linked to assessment; before/after debridement pairs.
2. **BWAT** 13 items (size, depth, edges, undermining, necrotic tissue type/amount, exudate type/amount, skin colour, oedema, induration, granulation, epithelialisation; 13–65) or **PUSH** (area, exudate, tissue type; 0–17) auto-scored; TIME: tissue (% granulation/slough/necrosis/epithelial), infection/inflammation signs (NERDS/STONEES), moisture, edge; periwound; pain (NRS); odour; temperature; exposed structures (bone/tendon → osteomyelitis suspicion → probe-to-bone).
3. Infection assessment → culture order (OP-004 swab/tissue, Levine technique) → results linked; antibiotic (OP-002 e-Rx, EN-029 antibiogram guidance from IP-012); systemic signs → ER/admission.
4. Save → **healing trajectory** update: area vs baseline (% reduction), expected trajectory (e.g. ≥ 40–50 % area reduction at 4 weeks predicts healing; stalled if < 15 % in 2 weeks) → status healing/stalled/deteriorating flags → escalate to surgeon (re-evaluate: biopsy, vascular, offloading, nutrition, advanced therapy). Event `wound.assessed`.
### 3.3 Dressing protocol & products
1. Protocol engine (hospital-configurable rules by tissue/exudate/infection/depth): recommends primary/secondary dressing class (hydrogel/hydrocolloid/foam/alginate/hydrofibre/silver/iodine/PHMB/collagen/honey/NPWT/compression system/offloading device) with products from formulary (NC-006 items with sizes) → nurse selects → frequency (daily/alternate/twice weekly), cleansing solution, debridement type (autolytic/enzymatic/sharp (OP-010 by credentialed)/mechanical), compression (ABI ≥ 0.8 required — hard check), offloading (TCC/removable walker/footwear → OP-015/orthotics), NPWT (device asset NC-020, pressure/mode, canister changes, dressing change q48–72 h, rental days billing), skin substitutes/grafts (OT).
2. Consumables scanned/selected → NC-008 consumption from dressing room/ward sub-store → billing (OP-005: dressing charge tier by size/complexity + materials; NPWT per day; IP charges to admission).
3. Next dressing scheduled (OP-001 slot/dressing-room token or ward task IP-003) → reminders; home care instructions PDF (photo-illustrated, language) + caregiver training checklist; home photo upload (`wound.home_photo_upload` via OP-020) reviewed by nurse (tele OP-018).
### 3.4 Follow-up & closure
- Visit cadence per protocol; missed → recall; healed → closure (epithelialised, date, healing days) → prevention plan (footwear, offloading, compression stockings, pressure care) & recurrence follow-up 3/6/12 months (PE-002); non-healing > 12 weeks → chronic wound MDT (vascular, plastics, endocrine, nutrition, ID) with case bundling; amputation/graft outcomes recorded.
### 3.5 Pressure injury programme (IP link)
- Braden on admission & per shift (IP-003) → high risk → prevention bundle tasks (turning q2h, surface, nutrition, moisture); any new stage ≥ 2 during stay = **HAPI** → NC-015 incident + quality indicator (NABH); wound record auto-created; monthly prevalence audit tool.
### 3.6 Exceptions
- Photo without consent → blocked; deterioration with sepsis signs → red alert; compression with ABI < 0.8 → blocked; NPWT contraindications (malignancy in wound, untreated osteomyelitis, exposed vessels) → override; offline: assessments & photos cached; sync idempotent.

## 4. Data Model (schema `specialty`)
- **wounds**: id, hospital_id, branch_id, patient_id, wound_no (per patient), location_snomed, location_text, side, aetiology enum(pressure/diabetic_foot/venous/arterial/mixed_ulcer/traumatic/surgical/ssi/burn/malignant/other), onset_date, cause, related_type/id (fracture/surgery/admission), classification jsonb ({npiap_stage, wagner, ut, wifi, ceap, tbsa, depth, ssi_type}), comorbidities jsonb, status enum(open/healing/stalled/deteriorating/healed/amputated/deceased/lost), opened_by, healed_at, healing_days, mdt_flag bool, hapi bool, incident_id?, version; index (hospital_id, patient_id, status), (hospital_id, aetiology, status).
- **wound_assessments**: id, wound_id, hospital_id, patient_id, at, context enum(opd/ward/icu/home/tele), assessed_by, length_cm, width_cm, depth_cm, area_cm2, area_method enum(ellipse/trace/ai), undermining jsonb, tunnelling jsonb, bwat jsonb (items + total), push jsonb, tissue_pct jsonb ({granulation, slough, necrotic, epithelial}), exudate jsonb ({amount, type}), infection_signs jsonb, periwound jsonb, pain_nrs, odour, exposed_structures text[], probe_to_bone bool, temperature, notes, culture_order_id?, form_response_id, area_reduction_pct (vs baseline), trajectory_flag enum(on_track/stalled/deteriorating), version; index (wound_id, at desc).
- **wound_photos**: id, wound_id, assessment_id?, patient_id, s3_key (encrypted), thumb_key, taken_at, taken_by, device, stage enum(pre_debridement/post_debridement/routine/home_upload), has_scale_marker bool, calibration jsonb, ai_measure jsonb?, consent_id, annotations jsonb; index (wound_id, taken_at).
- **wound_care_plans** (versioned): id, wound_id, protocol_rule_id?, cleansing, primary_dressing_item_id, secondary_dressing_item_id, frequency, debridement enum, compression jsonb (abi, system), offloading jsonb, npwt jsonb ({device_asset_id, mode, pressure, started_at, change_interval_h}), adjuncts jsonb, instructions_doc_id, next_due_at, prescribed_by, signed_at, version.
- **dressing_events**: id, wound_id, plan_id, at, by, location enum(dressing_room/ward/home/procedure_room), consumables jsonb ([{item_id, batch, qty}]), consumption_id, bill_item_id?, npwt_canister_changed bool, pain_pre/post, notes, next_due_at; index (wound_id, at), (hospital_id, at).
- **npwt_episodes**: id, wound_id, device_asset_id, started_at, ended_at, rental_days, settings_history jsonb, canisters int, bill_refs jsonb.
- **wound_protocol_rules**: id, hospital_id, name, conditions jsonb (tissue/exudate/infection/depth/aetiology), recommendations jsonb, evidence_ref, is_active, version.
- **wound_referrals** (via OP-021): wound_id, target enum(vascular/plastics/endocrine/nutrition/physio/id/pain/podiatry), status.
- **pressure_injury_audits**: hospital_id, branch_id, ward_id, date, patients_surveyed, pi_count by stage, hapi_count, by.
- **wound_followups**: wound_id, due_at, kind enum(dressing/review/recurrence_check/tele), status.

## 5. Business Rules & Validations
- Every wound assessment requires L×W (depth optional for superficial) and at least one photo when camera available (config); photo requires patient photography consent (one-time, revocable) — enforced before capture.
- BWAT/PUSH auto-scored; stage/grade changes must be by nurse/doctor with wound credentials (`wound.assessment.stage`); NPIAP stage cannot "reverse" (healing stage 3 documented as "healing stage 3", not stage 2).
- Trajectory: baseline area = first assessment; flags computed at each assessment: stalled if < 15 % reduction over 2 weeks after week 2; on-track if ≥ 40 % at 4 weeks; deteriorating if area ↑ > 10 % or infection signs → escalation task to surgeon.
- Compression therapy requires ABI within 6 months ≥ 0.8 (0.6–0.8 modified with doctor approval; < 0.6 block); NPWT contraindication checks; sharp debridement only by credentialed users via OP-010 with consent.
- Consumables consumed on dressing save; billing tier by wound size/complexity per tariff (RC-003) or per-item; NPWT rental per day auto-posted nightly while episode active; IP charges to admission bill.
- HAPI: stage ≥ 2 first documented > 24 h after admission (or any DTPI) → HAPI flag + incident; present-on-admission must be recorded within 24 h.
- SSI: surgical wounds auto-enrolled for 30/90-day surveillance (IP-012), assessments feed CDC criteria.
- Missed dressing > 2 days beyond due → recall; healed wounds locked (new wound if recurrence, linked `recurrence_of`).
- Photos immutable; annotations separate; export watermarked & audited; retention clinical (≥ 10 y).

## 6. API Surface (`/api/v1/wounds`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /wounds | register wound | wound.create | Y | – |
| GET | /patients/{id}/wounds, GET /wounds/{id} | list/detail (with trajectory) | wound.read | – | cursor |
| PATCH | /wounds/{id} | classification/status/close | wound.update (stage: wound.assessment.stage) | Y | – |
| POST | /wounds/{id}/assessments | assessment (+ measurements/scores) | wound.assessment.create | Y | – |
| GET | /wounds/{id}/assessments | history | wound.read | – | cursor |
| POST | /wounds/{id}/photos (multipart/presigned) | upload | wound.photo.create | Y | – |
| GET | /photos/{id}/url | presigned view | wound.photo.read | – | – |
| POST | /public/home-upload/{token} | patient/caregiver photo upload | patient scope | Y | – |
| POST/PATCH | /wounds/{id}/plans | care plan (protocol recommend endpoint: POST /protocol/recommend) | wound.plan.create/update | Y | – |
| POST | /wounds/{id}/dressings | dressing event (consumables → consumption/billing) | wound.dressing.record | Y | – |
| GET | /worklist?location=&date= | dressing due list (room/ward/home) | wound.worklist.read | – | cursor |
| POST/PATCH | /wounds/{id}/npwt | NPWT episode | wound.npwt.manage | Y | – |
| POST | /wounds/{id}/referrals | MDT/other referrals (OP-021) | wound.update | Y | – |
| POST/GET | /pressure-injury/audits | prevalence audits | wound.audit.manage | Y | cursor |
| GET | /stats/dashboard, /reports/healing, /reports/hapi | KPIs | wound.report.read | – | – |

## 7. Domain Events (outbox)
- `wound.registered` {wound_id, aetiology, classification, hapi?} → IP-012 (SSI enrol), NC-015 (HAPI), quality; `wound.assessed` {area, scores, trajectory_flag} → surgeon escalation, analytics; `wound.photo.added`; `wound.plan.signed` → OP-001/IP-003 scheduling, PE-001 instructions; `wound.dressing.recorded` {consumables} → NC-008, OP-005; `wound.npwt.started|stopped` → OP-005 rental billing, NC-020; `wound.stalled|deteriorating` → EN-037; `wound.healed` → PE-002 recurrence follow-up; `wound.home_photo.received` → nurse queue.
- Consumes: `braden.high_risk` (IP-003), `ot.case.completed` (surgical wound), `lab.result.final` (culture/HbA1c/albumin), `procedure.completed` (debridement), `visit.checked_in`, `ip.discharged` (transition to OPD/home plan).

## 8. Screens (UI)
1. **Wound worklist** (tablet/desktop; dressing room & ward): due dressings by time/location, overdue red; `F3` scan patient; real-time.
2. **Wound record** (tablet 2-pane): body map with wound markers; timeline of photos (swipe/compare slider), measurements & scores chart (area, BWAT), plan card, dressing history; `Ctrl+N` new assessment.
3. **Assessment capture** (tablet): camera with overlay & scale detection, measurement fields, BWAT/PUSH forms with pictorial helpers, tissue % sliders summing to 100, infection checklist; `Ctrl+S` save; offline.
4. **Care plan / protocol recommender** (tablet/desktop): recommendation cards with rationale, product picker (stock on hand), frequency, NPWT settings, instructions preview/print.
5. **Dressing event quick sheet**: consumables scan list, pain pre/post, next due; `Ctrl+Enter` complete.
6. **Surgeon review dashboard** (desktop): stalled/deteriorating wounds, MDT list, culture results, trajectory charts, before/after compare.
7. **Patient app** (OP-020): instructions, next dressing, upload photo, message nurse.
8. **Pressure injury audit & HAPI dashboard** (desktop dark): incidence per 1000 patient-days by ward, stage mix, bundle compliance.

## 9. Integrations
- Camera (PWA getUserMedia; IP-004 native later), S3/MinIO encrypted media, optional AI planimetry service (Phase 12: segmentation → area; adapters for third-party e.g. imitoMeasure/Tissue Analytics API via EN-017), NC-006/NC-008 stock, OP-005 tariff tiers, NC-020 NPWT assets, OP-004 cultures, IP-012 SSI/antibiogram, OP-021 referrals, EN-009 reminders/instructions, OP-018 tele review, EN-011 (WellnessRecord/OPConsult with photos optional).

## 10. Reports & Analytics
- Wound register by aetiology/status, healing rate & median days to heal by aetiology, % on-track at 4 weeks, stalled list, infection/culture positivity & MDRO, amputation rate (diabetic foot), HAPI incidence & prevalence (NABH indicator), SSI rates (with IP-012), dressing volumes & consumable cost per wound, NPWT utilisation/rental revenue, missed dressings, home photo engagement, MDT outcomes. Read models `analytics.wound_trajectory`, `analytics.pressure_injury_monthly`.

## 11. Notifications
- Patient/caregiver: next dressing reminder, home care instructions PDF, photo upload request (weekly), red-flag guidance, follow-up/recurrence checks.
- Nurse: due/overdue dressings, home photo received, culture result; Surgeon: stalled/deteriorating wound, culture MDRO, NPWT complication; ICN: SSI criteria met; Quality: HAPI reported; Stores: dressing stock low.

## 12. Permissions (RBAC keys)
`wound.create|read|update`, `wound.assessment.create|stage`, `wound.photo.create|read|export`, `wound.plan.create|update`, `wound.dressing.record`, `wound.worklist.read`, `wound.npwt.manage`, `wound.audit.manage`, `wound.report.read`, `wound.configure`. Defaults: Wound nurse — all except configure; Ward nurse — create/read, assessment.create, photo.create, dressing.record; Surgeon/physician — all clinical incl. stage & plan; ICN/Quality — read, audit, report; Stores — none (via NC-006); Patient — home upload/instructions.

## 13. Non-functional
- Volumes: 400 dressings/day enterprise (OPD + wards), 2–4 photos each (~2 GB/day); worklist p95 < 200 ms; photo upload background resumable; presigned URLs ≤ 5 min; thumbnails generated in worker < 10 s.
- Offline: full assessment + photo capture offline on tablets/phones (IndexedDB/OPFS cap 500 MB), sync with idempotency; conflict: assessments append-only, plan version conflict → re-review.
- Print: home care instructions (pictorial, language), dressing chart label, wound summary for referral.
- Accessibility/i18n: colour-blind-safe trajectory flags with icons; instructions multilingual.
- Privacy: photos encrypted, no PHI in keys, export watermark, READ_PHI audit outside care team.

## 14. Acceptance Criteria
1. Given a patient without photography consent, when the nurse taps camera, then capture is blocked with a consent flow; after consent, photos save encrypted and appear in the timeline.
2. Given baseline area 12 cm² and week-4 area 8 cm² (33 % reduction), then trajectory flag = stalled/at-risk (< 40 %) and the surgeon receives an escalation task.
3. Given a venous ulcer plan with compression and ABI 0.7 recorded, then compression requires doctor approval; with ABI 0.5 it is blocked.
4. Given a dressing event with 2 foam dressings scanned, then NC-008 consumption posts from the dressing-room sub-store and OP-005 shows the dressing tier charge + items.
5. Given NPWT started on 1st and stopped on 4th, then rental posts for 3 days nightly and stops after end; canister changes logged.
6. Given a stage 3 pressure injury first documented on day 3 of admission, then HAPI flag is set, an NC-015 incident is created and the ward HAPI indicator updates.
7. Given a surgical wound created from an OT case, then it is enrolled into IP-012 SSI surveillance and later assessments meeting CDC superficial SSI criteria trigger an ICN alert.
8. Given a home photo upload via app, then it appears in the nurse queue within 1 min with wound linkage; the nurse can request a tele review (OP-018).
9. Given the tablet is offline, when 5 assessments with photos are captured, then all sync on reconnect with correct timestamps and no duplicate photos.
10. Given a wound marked healed, then it is locked; a later wound at the same site is created as new with `recurrence_of` linkage and recurrence checks scheduled at 3/6/12 months.
11. Given a user without `wound.assessment.stage`, when changing NPIAP stage, then 403 and audit.
12. Given BWAT items entered, then total (13–65) is computed and trended; missing an item blocks the total (shows partial).

## 15. Enhancements / Later phases
- Costed proposal line 1572 (BWAT assessment, photo documentation, dressing protocol, healing trajectory, follow-up) — core.
- Later: AI planimetry & tissue segmentation (`wound.ai_measure`, Phase 12 AI-007-like service), 3D wound imaging devices (EN-042), thermal imaging for diabetic foot, hyperbaric oxygen therapy sessions (Phase 8+ if unit exists), telewound home-care programme (OP-018 + NC-024 home visits), predictive healing (AI-005), burn unit fluid resuscitation calculators (Parkland) integrated with IP-009.
- (market) MocDoc/SmartHospital photo attachments & WhatsApp — covered.

## 16. Open Questions for the Hospital
1. Wound-care staffing (dedicated clinic vs dressing room), credentialing for staging/sharp debridement?
2. Dressing tariff model (tiers by size/complexity, per item, NPWT per day) and formulary products with sizes?
3. Photo policy: consent template, retention, export rules; camera devices (tablets/phones)?
4. Which tools: BWAT vs PUSH; diabetic foot classification (Wagner/UT/WIfI/SINBAD)?
5. NPWT devices owned/rented; hyperbaric unit present?
6. Pressure injury audit frequency & NABH indicator definitions used; SSI surveillance owner (ICN)?
7. Home photo upload & tele review desired at go-live?
