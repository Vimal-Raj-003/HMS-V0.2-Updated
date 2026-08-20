# OP-027 — Dermatology Console (Skin/lesion mapping, Clinical photography & comparison, Procedure log, Biopsy tracking, Phototherapy, Cosmetic/laser sessions)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Module ID       | OP-027                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase           | 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Depends on      | **OP-025 §0 (shared specialty console framework)**, OP-002 (encounter, e-Rx incl. topical compounding), OP-010 (procedures: biopsy, excision, cryo, electrocautery, chemical peel, laser, PRP, microneedling, intralesional injections), OP-004 (histopathology/KOH/culture, immunofluorescence), OP-022 (photo/dermoscopy attachments), OP-017 (chronic wound overlap), OP-003 (compounded topicals, isotretinoin/methotrexate monitoring), EN-029 (isotretinoin pregnancy rule, methotrexate LFT/CBC monitoring, allergy), EN-028 (photo consent, procedure consent, cosmetic consent), EN-039 (forms/scores), OP-023/OP-005 (cosmetic packages/sessions, GST on cosmetic), PE-002 (session recalls), NC-006 (laser consumables/tips), NC-020 (laser/phototherapy device maintenance), EN-009, AI-007 (lesion analysis later) |
| Feature flag    | `module.dermatology.enabled` (sub: `derm.cosmetic`, `derm.phototherapy`, `derm.dermoscopy`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Primary roles   | Dermatologist (6), Resident (14), Derm nurse/procedure nurse (16), Cosmetologist/aesthetician (16 family sub-role), Phototherapy technician                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Secondary roles | Pathologist (13, biopsy results), Pharmacist (30, compounding), Reception/billing (24/27 sessions & packages), Quality (54), Patient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Regulatory      | NABH, DPDP (clinical photographs = sensitive PHI; consent per use), Drugs & Cosmetics Act (isotretinoin Schedule H, iPLEDGE-like local pregnancy prevention policy), AERB not applicable (lasers: BIS/IEC 60825 laser safety, laser safety officer), BMW 2016, GST 18% on cosmetic procedures vs exempt therapeutic (config), MTP/PC-PNDT n/a, Clinical Establishments Act record retention                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 1. Purpose

OP-027 supports dermatology/venereology/leprology and cosmetic dermatology: body-map based **lesion mapping** with morphology descriptors, standardised severity scores (PASI, SCORAD/EASI, DLQI, IGA acne, SALT, VASI, mSWAT, urticaria UAS7), **standardised clinical photography** with consent, side-by-side/overlay comparison across visits, dermoscopy image capture, **procedure log** (biopsies with histopath tracking, cryo/cautery/excision, peels, lasers, PRP, injectables) via OP-010, **phototherapy** (NB-UVB/PUVA dose escalation schedules & cumulative dose), systemic-drug monitoring (isotretinoin, methotrexate, biologics), STI/leprosy programme fields (NACO/NLEP), and cosmetic session packages. Framework behaviours per OP-025 §0.

## 2. Users & Jobs-to-be-done

- **Dermatologist** (desktop/tablet with camera; 40–80 pts/day): map lesions, score severity, photograph, diagnose (ICD-10 L00–L99, A50–A64, A30), prescribe topical/systemic with monitoring, order biopsy/tests, plan procedures/sessions, compare photos over time.
- **Derm nurse/technician**: standardised photo capture (poses/angles), phototherapy dosing & MED tests, prep for procedures, session logs, consumables.
- **Cosmetologist**: session-based treatments (laser hair removal areas/fluence, peels, microneedling), package session countdown, before/after photos.
- **Patient**: view before/after (own), session schedule & payments, education (OP-038: sun protection, isotretinoin precautions).

## 3. Core Workflows

### 3.1 Consultation with lesion map & scores

1. Console tabs: Lesion map · Photos · Scores · Diagnosis/Plan · Procedures · Phototherapy · Sessions.
2. **Lesion map**: front/back/side body silhouettes (adult/child, incl. scalp, palms/soles, nails, mucosa, genital map with restricted visibility) → tap region → lesion record: morphology (macule/papule/plaque/nodule/vesicle/bulla/pustule/wheal/ulcer/scar), size mm, colour, border, distribution, count, symptoms (itch NRS), duration; SNOMED body-site coded; each lesion gets stable `lesion_id` for longitudinal tracking (photos & biopsies link to it).
3. **Scores** (EN-039 templates with auto-calc): PASI (regions × erythema/induration/scaling × area), BSA %, EASI/SCORAD, DLQI, IGA (acne/rosacea), SALT (alopecia), VASI/VES (vitiligo), UAS7 (patient diary), mSWAT, HS Hurley/IHS4, Leprosy WHO grade/disability grade & VMT/ST; trend charts; treatment response thresholds (PASI-75/90).
4. Diagnosis (ICD-10 + SNOMED), plan: topical Rx (with compounding instructions to OP-003: e.g. "salicylic 6 % in white soft paraffin 100 g", finger-tip units guidance), systemic Rx with **monitoring protocol** auto-created (isotretinoin: pregnancy test/consent monthly, lipids/LFT baseline+3 mo; methotrexate: CBC/LFT/RFT baseline, 2 wk, monthly, cumulative dose tracker; cyclosporine BP/creatinine; biologics TB screening/HBV; hydroxychloroquine annual eye check → OP-025 referral), procedures (§3.3), phototherapy (§3.4), cosmetic sessions (§3.5), education, recall.

### 3.2 Clinical photography & comparison

1. **Photo consent** (EN-028: clinical record use / teaching / marketing tiers; revocable) captured before first photo; genital/face photos flagged high-sensitivity (blur thumbnails, break-glass READ_PHI audit).
2. Capture via tablet/phone camera in-app (OP-022 uploader) with **pose guides** (overlay silhouettes: face frontal/45°/90°, trunk, limbs, scalp, dermoscopy), auto-tag body region & lesion_id, colour card/scale bar optional, EXIF stripped, stored encrypted S3; DSLR/dermatoscope import (USB/Wi-Fi via EN-042 or manual upload).
3. **Comparison viewer**: pick same region/pose across dates → side-by-side, slider, ghost overlay (opacity), zoom-locked; annotate; export to visit summary (with consent tier check). Event `derm.photo.captured`.

### 3.3 Procedures & biopsy tracking (via OP-010)

1. Order: punch/shave/excision/incisional biopsy (site = lesion_id, size, suture), cryotherapy (agent, cycles, freeze-time), electrocautery/RF, chemical peel (agent %, layers, frost, neutralisation), intralesional steroid (mg, sites), PRP, microneedling, laser (device, wavelength, spot, fluence, pulse, passes, cooling, test patch), comedone extraction, milia, wart/molluscum, nail procedures, hair transplant planning (graft count) — each with consent template, LA record, consumables, photos pre/post, complications (burn/PIH/scar → 30-day tracker).
2. **Biopsy tracking**: specimen labelled (EN-013) → OP-004 histopath order (site, clinical dx, DIF Y/N) → status pending → result signed → dermatologist alert → result linked to lesion → follow-up plan (malignancy pathway → onco referral OP-031/OP-021, margin status, re-excision task); overdue result (> TAT) escalation.

### 3.4 Phototherapy (`derm.phototherapy`)

- Course: modality (NB-UVB/PUVA/excimer/UVA1), skin type (Fitzpatrick), MED/starting dose, increment % rules, max dose, frequency (2–3/week), body areas/shielding (genitals/eyes), psoralen dose & timing for PUVA; per session: dose given (mJ/cm²), erythema grade, adverse effects, technician; **cumulative dose & session count** with alerts (e.g. NB-UVB > 200 sessions or PUVA > 1000 J/cm² → review), device maintenance/lamp hours (NC-020); missed-session dose-reduction rules; billing per session or package.

### 3.5 Cosmetic sessions & packages (`derm.cosmetic`)

- Package (OP-023) e.g. laser hair removal ×6 areas → **session tracker** (n/N, interval reminders, area map, parameters per session, photos), advance/instalment, GST 18% cosmetic classification, session no-show/expiry rules, before/after gallery (marketing use only with tier-3 consent).

### 3.6 Programme/legal

- STI (NACO syndromic codes, partner notification counselling, HIV testing consent), leprosy (NLEP MDT register: PB/MB, disability grade, RFT), MLC for assault/burns (TR-008), occupational dermatoses.

### 3.7 Exceptions

- Isotretinoin Rx for female of child-bearing age without negative pregnancy test/consent → hard-stop (override by consultant with reason); biopsy result critical (melanoma) → critical alert path; photo consent revoked → images restricted (retained legally, hidden from teaching/marketing exports); offline: lesion map/scores cached, photos queued.

## 4. Data Model (schema `specialty`)

- **derm_lesions**: id, hospital_id, patient_id, lesion_no (per patient), body_site_snomed, region_key (map region), side, morphology enum, size_mm, colour, descriptors jsonb, first_seen_encounter_id, status enum(active/resolved/excised/monitor), sensitive bool; index (hospital_id, patient_id, status).
- **derm_lesion_observations**: id, lesion_id, encounter_id, findings jsonb, itch_nrs, photos uuid[], by, at.
- **derm_scores**: id, patient_id, encounter_id, score_type enum(pasi/bsa/easi/scorad/dlqi/iga_acne/salt/vasi/uas7/mswat/hurley/ihs4/leprosy_grade/other), components jsonb, value numeric(6,2), form_response_id, by, at; index (patient_id, score_type, at).
- **derm_photos** (extends OP-022 attachments): id, hospital_id, patient_id, encounter_id, lesion_id?, region_key, pose_key, s3_key (encrypted), thumb_key (blurred if sensitive), captured_at, device, colour_card bool, consent_id, consent_tier enum(clinical/teaching/marketing), sensitive bool, annotations jsonb; index (patient_id, region_key, pose_key, captured_at).
- **derm_procedures_link**: encounter_id, procedure_id (OP-010), lesion_ids uuid[], kind enum(biopsy/excision/cryo/cautery/peel/laser/prp/microneedling/injection/other), params jsonb (laser fluence etc.), pre_photo_ids, post_photo_ids.
- **derm_biopsies**: id, hospital_id, patient_id, procedure_id, lesion_id, specimen_no (OP-004 accession), type enum(punch/shave/excision/incisional), size_mm, dif bool, clinical_dx, lab_order_id, status enum(sent/received/reported/reviewed/action_planned), result_summary, malignancy_flag, margins, reviewed_by/at, followup_task_id; index (hospital_id, status).
- **derm_systemic_monitoring**: id, patient_id, drug enum(isotretinoin/methotrexate/cyclosporine/azathioprine/biologic/hcq/acitretin/other), protocol jsonb (tests, intervals), cumulative_dose numeric, start_date, next_due, pregnancy_prevention jsonb (consent_id, last_test_at, contraception), status.
- **derm_phototherapy_courses**: id, patient_id, modality enum(nbuvb/puva/excimer/uva1), skin_type, med_mj, start_dose, increment_pct, max_dose, freq_per_week, shielding jsonb, psoralen jsonb, device_id, cumulative_dose numeric, sessions_count int, status; **derm_phototherapy_sessions**: id, course_id, seq, dose_mj, erythema_grade, adverse jsonb, technician_id, at, charge_intent_id.
- **derm_cosmetic_sessions**: id, patient_id, package_booking_id (OP-023), treatment_code, area_keys text[], seq, total, params jsonb, photos, at, by, status enum(done/no_show/expired).
- Enums: `morphology`, `derm_score_type`, `photo_consent_tier`, `phototherapy_modality`.

## 5. Business Rules & Validations

- Photo requires active consent; sensitive regions blur by default; export/teaching/marketing only for tier ≥ required; consent revocation cascades to `derm_photos.consent_tier` downgrade & export block; EXIF stripped; watermark with UHID on clinical export.
- Isotretinoin: female 12–50 → negative pregnancy test ≤ 7 days & signed pregnancy-prevention consent & two contraception methods documented before each monthly Rx (EN-029 rule `derm.isotretinoin.ppp`); max cumulative 120–150 mg/kg tracker; lipids/LFT reminders. Methotrexate: weekly dosing safeguard (daily dosing hard-stop), folic acid co-Rx prompt, cumulative g tracker, monitoring labs overdue → Rx warning. Biologics: TB/HBV screen recorded before first dose.
- Scores computed by canonical formulas (PASI 0–72 etc.); PASI-75 response computed vs baseline; DLQI patient-completed via portal/tablet.
- Phototherapy: dose escalation within course rules; skip > 1 week → dose reduction prompt; cumulative dose thresholds → consultant review; eye protection & shielding checklist per session; device lamp-hour link (NC-020).
- Biopsy: specimen must be labelled/scanned before leaving room; TAT breach (config 7 days) → escalation; malignant result requires dermatologist acknowledgment within 24 h; margin positive → re-excision task.
- Cosmetic vs therapeutic classification per service code drives GST & package rules; sessions expire per package validity; no-show consumes session only if policy says so.
- Genital/STI records: ABAC restricted visibility (treating team + patient); partner records never linked without consent.
- Documents immutable after sign; lesion IDs stable; retention clinical; photos retention per policy (min as medical record).

## 6. API Surface (`/api/v1/derm`)

| Method         | Path                                                              | Purpose                           | Permission                      | Idem | Pag    |
| -------------- | ----------------------------------------------------------------- | --------------------------------- | ------------------------------- | ---- | ------ |
| GET            | /worklist                                                         | derm worklist                     | derm.visit.read                 | –    | cursor |
| POST/GET/PATCH | /patients/{id}/lesions, /lesions/{id}                             | lesion registry                   | derm.lesion.record/read         | Y    | cursor |
| POST           | /encounters/{id}/lesion-observations                              | per-visit findings                | derm.lesion.record              | Y    | –      |
| POST/GET       | /encounters/{id}/scores, /patients/{id}/scores?type=              | scores/trends                     | derm.score.record/read          | Y    | cursor |
| POST           | /photos (multipart/resumable), GET /photos?patient=&region=&pose= | capture/list                      | derm.photo.capture/read         | Y    | cursor |
| GET            | /photos/compare?ids=                                              | comparison manifest (signed URLs) | derm.photo.read                 | –    | –      |
| POST/PATCH     | /biopsies, /biopsies/{id}/review                                  | biopsy tracking                   | derm.biopsy.manage              | Y    | cursor |
| POST/PATCH     | /monitoring, /monitoring/{id}                                     | systemic drug monitoring          | derm.monitoring.manage          | Y    | –      |
| POST/GET/PATCH | /phototherapy/courses, /courses/{id}/sessions                     | phototherapy                      | derm.phototherapy.manage/record | Y    | cursor |
| POST/GET       | /cosmetic/sessions                                                | session tracker                   | derm.cosmetic.record            | Y    | cursor |
| POST           | /encounters/{id}/sign                                             | visit sign                        | derm.visit.sign                 | Y    | –      |
| GET            | /reports/*                                                        | KPIs/programme (NLEP/NACO)        | derm.report.read                | –    | –      |

## 7. Domain Events (outbox)

- `derm.lesion.created|updated`, `derm.score.recorded` {type, value, delta}, `derm.photo.captured` (sensitive flag), `derm.photo.consent.revoked`, `derm.biopsy.sent|reported|critical|overdue`, `derm.monitoring.due|blocked` (isotretinoin PPP), `derm.phototherapy.session.recorded|threshold`, `derm.cosmetic.session.done|expiring`, `derm.visit.signed`.
- Consumes: `lab.result.final` (histopath, monitoring labs), `procedure.completed`, `consent.revoked` (EN-028), `package.session.consumed` (OP-023), `rx.created` (systemic monitoring hook).

## 8. Screens (UI)

1. **Derm worklist** (desktop): chips for pending biopsy results, monitoring labs due, session n/N.
2. **Lesion map & exam** (desktop/tablet): body silhouettes with zoom, lesion pins list, morphology quick-pick (`M/P/N/V/U` hotkeys), score calculators inline (PASI grid), sensitive-region toggle.
3. **Photo studio** (tablet/phone camera): pose overlay guide, region auto-tag, consent banner, burst compare with last photo ghost; upload queue indicator (offline).
4. **Compare viewer** (desktop): side-by-side/slider/overlay, timeline strip, annotation, export with consent tier check.
5. **Procedure & laser log** (OP-010 template): device/params presets per area, test patch record, pre/post photos, complications.
6. **Phototherapy station** (desktop/tablet at cabin): today's list, dose calc suggestion, erythema entry, shielding checklist, cumulative dose gauge, `Enter` record.
7. **Systemic drug monitoring board**: patients on isotretinoin/MTX/biologics with due/overdue labs & PPP status.
8. **Cosmetic session board & before/after gallery** (consent-tier filtered).

- Empty/error: consent missing → capture disabled with one-click consent flow.

## 9. Integrations

- OP-022 uploader/encryption; dermatoscope (USB/Wi-Fi image import), DSLR tethering (later); OP-010; OP-004 histopath (accession barcode, DIF); OP-003 compounding; EN-029 rules; NC-020 laser/phototherapy device registry & lamp hours; OP-023 packages; EN-011 FHIR (Observation for scores; Media for photos on consent); NLEP/NACO reporting formats (CSV/manual, EN-017 placeholder).

## 10. Reports & Analytics

- Diagnosis mix, PASI/EASI response rates (PASI-75 at 12/16 wk), biopsy TAT & malignancy yield, monitoring compliance (isotretinoin PPP 100 %), phototherapy sessions/cumulative dose, laser/cosmetic session revenue & package utilisation, complications by procedure/device, photo consent audit (exports by tier), NLEP register, STI syndromic counts. Read model `analytics.derm_monthly`.

## 11. Notifications

- Patient: monitoring lab reminders, isotretinoin monthly test reminder, phototherapy/session schedule, post-procedure care (OP-038), biopsy result ready (portal), package expiry. Staff: biopsy critical/overdue, PPP block, phototherapy threshold, laser device service due (NC-020), consent revocation.

## 12. Permissions (RBAC keys)

`derm.visit.read|sign`, `derm.lesion.record|read`, `derm.score.record|read`, `derm.photo.capture|read|read_sensitive|export`, `derm.biopsy.manage`, `derm.monitoring.manage`, `derm.phototherapy.manage|record`, `derm.cosmetic.record|manage`, `derm.report.read`, `derm.configure`. Defaults: Dermatologist — all; Resident — record without sign/export; Nurse/technician — photo.capture, phototherapy.record, cosmetic.record; Cosmetologist — cosmetic.record, photo.capture; Pathologist — biopsy read; Marketing — nothing by default (export only with tier-3 consent and `photo.export`).

## 13. Non-functional

- Volumes: 250 derm visits/day, 600 photos/day (avg 3 MB), 80 phototherapy sessions/day; photo upload resumable, thumbnails generated in worker < 5 s; compare viewer loads two 12 MP images < 2 s (progressive JPEG). Offline: lesion map/scores/photos queued (IndexedDB, encrypted). Print: visit summary with selected photos (consent), phototherapy card, isotretinoin consent. Accessibility: high-contrast body maps.

## 14. Acceptance Criteria (plus OP-025 §0.9)

1. Given no photo consent on file, when the nurse opens the photo studio, then capture is disabled until consent (tier) is signed; after signing, capture proceeds and each photo stores consent_id.
2. Given a female patient aged 25 prescribed isotretinoin without a pregnancy test in 7 days, then Rx sign is blocked with a hard-stop; consultant override records reason and audit.
3. Given PASI components entered, then PASI computes correctly (e.g. head E2 I2 S1 area 3 → contributes 0.1×5×3=1.5) and PASI-75 status shows vs baseline.
4. Given a punch biopsy from lesion #3, then the specimen barcode links to OP-004, status "sent", and after 8 days without result an escalation is raised.
5. Given the histopath returns melanoma, then a critical alert requires dermatologist acknowledgment within 24 h and an oncology referral task appears.
6. Given NB-UVB course at 300 mJ increment 10 %, when the patient missed 10 days, then the next dose suggestion is reduced per rule and shielding checklist must be ticked before recording.
7. Given a laser hair removal package of 6, when session 6 completes, then the tracker shows 6/6 completed and package status closes; a 7th session requires new package.
8. Given photos exist for face-frontal on 3 dates, then the compare viewer shows slider/overlay and exports only if consent tier permits.
9. Given a genital lesion record, then a doctor outside the care team opening it triggers break-glass READ_PHI audit and thumbnails are blurred by default.
10. Given methotrexate prescribed daily by mistake, then hard-stop (weekly-only rule) fires.
11. Given consent revoked for teaching, then previously exported teaching sets are flagged and new exports blocked.
12. Given a resident signs a visit, then 403; consultant co-sign flow works.

## 15. Enhancements / Later phases

- Sheet row 64 (Skin mapping, Procedure log, Photo comparison, Biopsy) — core. Market: phototherapy dosing, cosmetic packages/sessions, systemic-drug safety.
- Later: AI-007 lesion classification/dermoscopy assist & auto-PASI from photos, 3D total-body photography import, tele-dermatology store-and-forward (OP-018), hair-transplant graft planning tool, patient photo self-upload for follow-up (PE-001).

## 16. Open Questions for the Hospital

1. Cosmetic services offered & GST classification? Package rules (validity, no-show)?
2. Phototherapy units and PUVA use? Laser devices (models) & safety officer?
3. Photo policy: consent tiers, retention, who may export; camera hardware (tablet vs DSLR/dermatoscope)?
4. Isotretinoin PPP policy specifics; monitoring intervals for MTX/biologics?
5. NLEP/NACO reporting obligations for this facility?
