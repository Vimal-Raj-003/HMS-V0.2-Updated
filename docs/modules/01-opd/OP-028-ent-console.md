# OP-028 — ENT Console (Otoscopy/Rhinoscopy/Laryngoscopy findings, Audiometry PTA/Tympanometry/OAE/BERA, Endoscopy image capture, Allergy testing, Vertigo, Procedure notes, Hearing-aid link)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Module ID       | OP-028                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Phase           | 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Depends on      | **OP-025 §0 (shared specialty console framework)**, OP-002, OP-010 (procedures: nasal endoscopy, FOL, ear micro-suction, foreign body removal, cautery, biopsy, intratympanic injection, minor OT), OP-022/EN-042 (audiometer/tympanometer/OAE/BERA result import, endoscope video capture), OP-008/EN-008 (CT temporal bone/PNS, PACS), OP-004 (culture, biopsy, allergy IgE), OP-035 (speech therapy referral), OP-033 (paediatric hearing screening/OAE, adenotonsillar), OP-013 (none), IP-006 (ENT surgeries: FESS, tonsillectomy, tympanoplasty, cochlear implant via TR-003), OP-003, EN-029 (ototoxic drug alerts), EN-028, EN-039, OP-005/OP-023 (audiology tariffs, hearing-aid packages), NC-006 (hearing aids/consumables inventory), NC-020 (audiometer calibration), PE-002 (recall), OP-021, EN-009, EN-030 (patient questionnaires THI/DHI/SNOT-22) |
| Feature flag    | `module.ent.enabled` (sub: `ent.audiology`, `ent.hearing_aid_dispensing`, `ent.allergy_testing`, `ent.vertigo_lab`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Primary roles   | ENT surgeon (6/9), Audiologist (new sub-role in 40 family: `audiologist`), Resident (14), ENT nurse/technician (16/36)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Secondary roles | Speech therapist (40), Paediatrician (OP-033), Radiologist (12), Reception/billing (24/27), Hearing-aid dispenser/counter, Quality (54), Patient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Regulatory      | NABH, RCI (Rehabilitation Council of India — audiologist registration), RPwD Act 2016 (hearing disability certification: PTA average criteria), Newborn hearing screening (RBSK/NPPCD — National Programme for Prevention & Control of Deafness reporting), CDSCO (cochlear implants Class D UDI), Motor Vehicles Act hearing fitness, AERB (CT via OP-008), DPDP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 1. Purpose

OP-028 provides ENT-specific documentation: side-aware ear/nose/throat/neck examination with schematic drawings (tympanic membrane, nasal cavity, larynx), **audiology suite** (pure-tone audiogram AC/BC with masking, speech audiometry SRT/SDS, tympanometry types A/As/Ad/B/C, reflexes, OAE, BERA/ASSR, free-field for children) with device import and standard audiogram rendering & PTA averages, endoscopy (nasal/laryngeal/otoendoscopy) image/video capture with structured findings, allergy skin-prick/IgE testing panels, vertigo assessment (Dix-Hallpike, HINTS, VNG/caloric attachments), procedure notes (OP-010), hearing-aid trial/dispensing & cochlear implant candidacy, disability certification data and NPPCD reporting. Framework behaviours per OP-025 §0.

## 2. Users & Jobs-to-be-done

- **ENT surgeon** (desktop/tablet; 40–70 pts/day): exam by subsite with drawings, review audiograms/endoscopy, diagnose (ICD-10 H60–H95, J30–J39), plan medical/surgical treatment, book OT, certify.
- **Audiologist** (desktop in sound-proof booth; 30–50 tests/day): perform PTA/speech/tymp/OAE/BERA, import from device or enter thresholds, interpret (type/degree/configuration), hearing-aid trial & fitting, counselling, newborn screening.
- **ENT technician/nurse**: endoscopy setup & capture, micro-suction assist, allergy testing, vertigo tests, instrument tracking (EN-003).
- **Reception/billing**: audiology slots, hearing-aid packages/warranty, disability certificate appointments.
- **Patient**: audiogram PDF, hearing-aid instructions, recall.

## 3. Core Workflows

### 3.1 ENT examination

1. Console tabs: Ear · Nose · Throat/Neck · Audiology · Endoscopy · Allergy/Vertigo · Diagnosis/Plan.
2. **Ear (R/L)**: pinna, EAC (wax/discharge/otomycosis/FB), TM drawing (quadrants: perforation size/site central/marginal, retraction, cholesteatoma, myringosclerosis, grommet), tuning forks (Rinne/Weber/ABC), facial nerve HB grade, fistula test; **Nose**: external, septum (deviation side/type), turbinates, polyps (grade), discharge, DNS/PNS, nasal patency (cold spatula/PNIF); **Throat/Neck**: oral cavity, tonsils (Brodsky 0–4), pharynx, indirect laryngoscopy, neck nodes (level map I–VI), thyroid, salivary glands; voice (GRBAS), swallow screen (→ OP-035), OSA screen (STOP-BANG, Epworth → sleep study OP-030).
3. Diagnosis + plan: e-Rx (ototoxicity alerts for aminoglycosides in existing SNHL; ear-drops with perforation warning), procedures (§3.4), audiology orders (§3.2), imaging (CT temporal bone/PNS via OP-008 with checklist), allergy testing, speech referral (OP-035), surgery planning (IP-006: FESS/septoplasty/tonsillectomy/tympanoplasty/mastoidectomy/CI with implant TR-003), education (OP-038), recall.

### 3.2 Audiology suite (`ent.audiology`)

1. Order (charge intent) → audiologist worklist → **PTA**: AC/BC thresholds R/L 250–8000 Hz (masked flags), no-response symbols, PTA average (500/1k/2k(/4k) config), degree (WHO/ASHA scale), type (conductive/SNHL/mixed) & configuration auto-derived; **speech**: SRT, SDS %, MCL/UCL; **tympanometry**: type, ECV, peak pressure, compliance, reflexes; **OAE** (TEOAE/DPOAE pass/refer per ear/frequency); **BERA/ASSR** (waves I/III/V latencies, threshold), **free-field/BOA/VRA/play audiometry** for children; import via EN-042 (audiometer XML/CSV/GDT/NOAH export where available; else manual grid entry with keyboard); render standard audiogram (red O right AC, blue X left AC, < > BC, masked symbols) → audiologist signs interpretation → ENT reviews (§0.3) → PDF (bilingual). Event `ent.audiogram.signed`.
2. **Newborn/child hearing screening**: OAE two-stage protocol (screen → rescreen 2–4 wk → BERA), refer tracking with follow-up tasks; NPPCD/RBSK register lines; links to IP-011/IP-015 newborn record & OP-033.
3. **Hearing-aid pathway** (`ent.hearing_aid_dispensing`): candidacy → trial (device model/serial from NC-006 loan stock, fitting parameters, REM/aided thresholds), counselling, purchase (OP-005 with warranty/serial), follow-up/servicing log, battery/mould reminders; **cochlear implant** candidacy checklist (BERA, imaging, speech, vaccination — meningococcal/pneumococcal via OP-013), ADIP/government scheme fields (RC-007).
4. **Disability certification support**: PTA averages per RPwD formula (better-ear % from 500/1k/2k/4k), certificate template (EN-039), Board workflow if applicable.

### 3.3 Endoscopy & imaging capture

- Diagnostic nasal endoscopy (DNE), flexible laryngoscopy (FOL), otoendoscopy, stroboscopy: procedure via OP-010 (consent, LA spray, findings template by subsite: Lund-Kennedy score for polyps, VC mobility, RSI/reflux finding score, mass description) + **video/still capture** (capture card/USB endoscope via EN-042 or tablet camera adapter → OP-022; key frames annotated; video ≤ 500 MB) → report PDF with images; comparison across visits.

### 3.4 Procedures & minor OT (via OP-010/OP-039)

- Ear micro-suction/wax removal, FB removal (ear/nose/throat), nasal cautery/anterior packing (epistaxis; pack removal follow-up), I&D quinsy/abscess, ear-lobe repair, biopsy (→ OP-004), intratympanic steroid, grommet under LA (adult), nasal packing removal, tracheostomy tube change (IP link), swab for culture; consumables & billing per OP-010; complications tracker.

### 3.5 Allergy testing & vertigo lab (`ent.allergy_testing`, `ent.vertigo_lab`)

- Skin-prick test panel (aeroallergens/food, positive/negative controls, wheal mm at 15–20 min, grading), specific IgE (OP-004), anaphylaxis readiness checklist & adrenaline record, immunotherapy schedule (SLIT/SCIT dose calendar with reaction log); vertigo: DHI questionnaire, Dix-Hallpike/roll test (side/nystagmus), Epley/BBQ manoeuvre log, HINTS, VNG/caloric/vHIT/VEMP result attachment (OP-022), Meniere criteria (AAO-HNS), vestibular rehab referral (OP-015).

### 3.6 Exceptions

- Sudden SNHL → urgent pathway (steroids/intratympanic within 72 h task); airway emergency → OP-006; device offline → manual audiogram entry flagged; child uncooperative → "CNT" (could not test) with re-book; audiometer calibration overdue (NC-020) → warning banner on results.

## 4. Data Model (schema `specialty`)

- **ent_exams**: id, hospital_id, branch_id, patient_id, encounter_id, ear jsonb (sided: eac, tm{perf, site, size, retraction, chole, grommet}, tuning_forks, hb_grade), nose jsonb (septum, turbinates, polyps_grade sided, discharge, pnif), throat jsonb (tonsil_grade, il_findings, grbas), neck jsonb (nodes by level sided, thyroid), drawings jsonb (svg keys), stop_bang, epworth, form_response_id?, signed_by/at, version.
- **audiology_tests**: id, hospital_id, patient_id, encounter_id, test_type enum(pta/speech/tymp/oae/bera/assr/freefield/vra/play/rem), device_id?, source enum(device/manual), booth_id?, audiologist_id, performed_at, calibration_ok bool, status enum(ordered/in_progress/signed/reviewed/cnt), pdf_key, charge_intent_id; index (hospital_id, patient_id, performed_at desc).
- **audiogram_thresholds**: test_id, ear enum(r/l), conduction enum(ac/bc), freq_hz smallint, threshold_db smallint (−10..120), masked bool, no_response bool; unique (test_id, ear, conduction, freq_hz).
- **audiology_results**: test_id, ear, pta_avg numeric(5,1), degree enum(normal/slight/mild/moderate/mod_severe/severe/profound), type enum(conductive/snhl/mixed/normal), configuration, srt, sds_pct, mcl, ucl, tymp_type enum(A/As/Ad/B/C), ecv_ml, peak_dapa, compliance_ml, reflexes jsonb, oae jsonb (per freq pass/refer), abr jsonb (waves, threshold), interpretation text, signed_by/at.
- **hearing_screening_episodes**: id, patient_id (newborn/child), stage enum(screen1/rescreen/diagnostic), result enum(pass/refer/cnt), due_at, done_at, outcome, nppcd_reported bool.
- **hearing_aids**: id, hospital_id, patient_id, ear, model, serial (unique), item_id (NC-006), status enum(trial/dispensed/returned/serviced), fitting jsonb (gain, REM, aided thresholds), dispensed_at, warranty_until, bill_id, service_log jsonb.
- **ent_endoscopies**: id, encounter_id, procedure_id (OP-010), type enum(dne/fol/oto/strobo), findings jsonb (lund_kennedy sided, vc_mobility, rfs, mass), media uuid[] (OP-022), report_pdf_key.
- **ent_allergy_tests**: id, patient_id, encounter_id, panel jsonb ([{allergen, wheal_mm, flare_mm, grade}]), controls jsonb, adverse jsonb, ige_lab_order_id?; **ent_immunotherapy**: id, patient_id, route enum(slit/scit), allergens, schedule jsonb, doses jsonb, reactions jsonb, status.
- **ent_vertigo_assessments**: id, patient_id, encounter_id, dhi, tests jsonb (dix_hallpike sided, roll, hints, romberg, fukuda), manoeuvres jsonb, attachments uuid[] (vng/vhit/vemp), diagnosis enum(bppv/menieres/vn/vm/other).
- Enums: `ear_side`, `audio_test_type`, `hl_degree`, `hl_type`, `tymp_type`.

## 5. Business Rules & Validations

- Thresholds in 5 dB steps −10..120; BC ≤ AC per frequency (warn if BC > AC by >10 → check masking); no-response stored with symbol; PTA average formula configurable (3- or 4-frequency); WHO 2021 grades default; type derived from air-bone gap ≥ 15 dB (config).
- Audiometer calibration date (NC-020) must be within 12 months; else result marked "calibration overdue" and needs supervisor override.
- Newborn screening: refer at screen1 → rescreen task by 4 weeks; refer at rescreen → BERA by 3 months (1-3-6 rule); overdue → escalation; NPPCD line generated monthly.
- Ototoxic drugs (aminoglycosides, cisplatin, loop diuretics high dose) → EN-029 alert if SNHL on record; topical aminoglycoside drops with TM perforation → warning.
- Hearing aids: serial unique; trial max days (config) → auto reminder to return/purchase; dispensing creates bill with serial/warranty; government scheme (ADIP) fields when applicable.
- Disability %: computed per RPwD guidelines from better-ear PTA (500/1k/2k/4k) — certificate only by authorised doctor; audiogram must be < 6 months.
- Sudden SNHL protocol: PTA within 24 h and steroid decision documented; task auto-created.
- Allergy testing: emergency kit checklist ticked before session; anaphylaxis → NC-015 incident; immunotherapy dose escalation cannot skip steps; missed-dose adjustments prompt.
- Endoscopy videos: consent recorded; storage lifecycle (key frames permanent, full video per policy e.g. 1 year); documents immutable after sign; retention clinical.

## 6. API Surface (`/api/v1/ent`)

| Method         | Path                                                                  | Purpose                     | Permission                                | Idem | Pag    |
| -------------- | --------------------------------------------------------------------- | --------------------------- | ----------------------------------------- | ---- | ------ |
| GET            | /worklist, /audiology/worklist                                        | worklists                   | ent.visit.read / ent.audiology.read       | –    | cursor |
| PUT            | /encounters/{id}/exam                                                 | ENT exam save               | ent.exam.record                           | Y    | –      |
| POST           | /audiology/tests, PUT /tests/{id}/thresholds, PUT /tests/{id}/results | audiology capture           | ent.audiology.record                      | Y    | –      |
| POST           | /audiology/tests/{id}/sign, /review                                   | sign/review                 | ent.audiology.sign / ent.audiology.review | Y    | –      |
| GET            | /audiology/tests/{id}/pdf, /patients/{id}/audiograms                  | outputs/history             | ent.audiology.read                        | –    | cursor |
| POST           | /devices/ingest (EN-042)                                              | audiometer/tymp/OAE payload | device token                              | Y    | –      |
| POST/PATCH/GET | /hearing-screening                                                    | newborn/child screening     | ent.screening.manage                      | Y    | cursor |
| POST/PATCH/GET | /hearing-aids                                                         | trial/dispense/service      | ent.hearing_aid.manage                    | Y    | cursor |
| POST/GET       | /endoscopies (+media via OP-022)                                      | endoscopy record            | ent.endoscopy.record/read                 | Y    | –      |
| POST/GET       | /allergy-tests, /immunotherapy                                        | allergy                     | ent.allergy.record                        | Y    | cursor |
| POST/GET       | /vertigo                                                              | vertigo                     | ent.vertigo.record                        | Y    | –      |
| POST           | /encounters/{id}/sign                                                 | visit sign                  | ent.exam.sign                             | Y    | –      |
| GET            | /reports/nppcd?month=, /reports/kpis                                  | reports                     | ent.report.read                           | –    | –      |

## 7. Domain Events (outbox)

- `ent.exam.signed`, `ent.audiogram.signed|reviewed` {pta_r, pta_l, degree}, `ent.screening.refer|overdue`, `ent.hearing_aid.trial_started|dispensed|trial_overdue`, `ent.endoscopy.reported`, `ent.allergy.reaction`, `ent.sudden_snhl.flagged`, `ent.surgery.planned` → IP-006/TR-003.
- Consumes: `op22.result.attached`, `procedure.completed`, `newborn.registered` (IP-011) → screening episode, `lab.result.final` (IgE, culture), `asset.calibration.overdue` (NC-020).

## 8. Screens (UI)

1. **ENT worklist** (desktop) with audiology-pending / endoscopy-pending chips.
2. **ENT exam workspace** (desktop/tablet): R/L split panels, TM/nose/larynx drawing canvases with stamps, node level map, `F2` normal fill, `Ctrl+Enter` sign.
3. **Audiogram entry & viewer** (desktop in booth): grid with arrow-key navigation (freq columns × AC/BC rows, `M` toggle masked, `N` no-response), live standard audiogram plot, speech/tymp panels, device "Import", interpretation auto-text, sign; `Ctrl+P` PDF.
4. **Hearing screening tracker** (desktop): stage kanban, overdue list, NPPCD export.
5. **Hearing-aid counter** (desktop/tablet): trial stock, fitting form, dispensing with serial scan, service log.
6. **Endoscopy capture** (desktop with capture card / tablet): live preview, snapshot key frames, findings template, report; comparison strip.
7. **Allergy/vertigo forms** (tablet), immunotherapy calendar.
8. **Patient portal**: audiogram PDF, hearing-aid care, recall.

- Real-time: audiology completion pushes to ENT rail; empty state "No audiogram — order or import".

## 9. Integrations

- EN-042: audiometers (Interacoustics/GSI/Maico via XML/NOAH export), tympanometers, OAE/ABR systems (PDF/XML), endoscope capture (UVC/HDMI card), VNG/vHIT (PDF); NOAH-format import (optional adapter); OP-022 for PDFs/media; PACS (CT temporal bone/PNS); TR-003 cochlear implants UDI; NC-006 hearing-aid stock; NC-020 calibration; OP-013 CI vaccination; NPPCD/RBSK reporting (CSV/manual); EN-011 FHIR (Observation LOINC 89024-4 audiometry panel).

## 10. Reports & Analytics

- Audiology volumes/TAT, hearing loss distribution by degree/type/age, newborn screening coverage & refer/lost-to-follow-up rates (1-3-6 compliance), hearing-aid conversion & returns, endoscopy volumes, surgery pipeline (advised→booked), sudden SNHL treatment within 72 h %, allergy test yields, immunotherapy adherence, disability certificates issued, revenue by service. Read model `analytics.ent_monthly`, `analytics.hearing_screening`.

## 11. Notifications

- Patient: audiogram ready, screening rescreen/BERA appointments, hearing-aid trial return/servicing/battery reminders, immunotherapy dose reminders, post-procedure (epistaxis pack removal) instructions. Staff: refer results overdue, calibration overdue, sudden SNHL task, anaphylaxis incident, CI implant reservation.

## 12. Permissions (RBAC keys)

`ent.visit.read`, `ent.exam.record|sign`, `ent.audiology.record|sign|review|read`, `ent.screening.manage`, `ent.hearing_aid.manage|dispense`, `ent.endoscopy.record|read`, `ent.allergy.record`, `ent.vertigo.record`, `ent.certificate.issue`, `ent.report.read`, `ent.configure`. Defaults: ENT surgeon — all except audiology.sign (review only unless also audiologist); Audiologist — audiology.*, screening, hearing_aid.manage; Technician — audiology.record (no sign), endoscopy capture; Counter — hearing_aid.dispense; Resident — record without sign.

## 13. Non-functional

- Volumes: 200 ENT visits/day, 120 audiology tests/day, 40 endoscopies/day (video 200 MB avg); audiogram render < 100 ms client-side SVG; device import parse < 2 s; video upload resumable, transcode to H.264 720p in worker. Offline: exam/audiogram grid entry cached. Print: audiogram A4 with standard symbols legend, certificates. Accessibility: audiogram grid fully keyboard-driven, colour-blind-safe symbols.

## 14. Acceptance Criteria (plus OP-025 §0.9)

1. Given AC thresholds R 40/45/50/55 at 500/1k/2k/4k, then PTA-4 = 47.5 dB, degree "moderate" (WHO), and the audiogram plots red circles; BC entries plot with correct symbols and masked variants.
2. Given BC 60 dB and AC 45 dB at 1 kHz on the same ear, then a masking/validity warning is shown before sign.
3. Given the audiometer exports XML for the test, when imported, then thresholds populate with source=device and the audiologist can only edit with reason.
4. Given a newborn refers on OAE screen1, then a rescreen task at ≤ 4 weeks is created; if refer again, BERA task by 3 months; overdue tasks escalate.
5. Given a hearing-aid trial started 20 days ago with 14-day policy, then the counter sees an overdue chip and the patient received a reminder.
6. Given a patient with documented SNHL, when gentamicin is prescribed, then EN-029 raises an ototoxicity alert requiring acknowledgement.
7. Given DNE performed with key frames captured, then the report PDF includes images and Lund-Kennedy score and appears on the timeline.
8. Given audiometer calibration is 13 months old, then new tests show a "calibration overdue" flag and require supervisor override to sign.
9. Given a sudden SNHL diagnosis, then an urgent task ensures PTA within 24 h and steroid decision documented; dashboard tracks 72-h compliance.
10. Given a technician tries to sign an audiogram, then 403 and audit.
11. Given a disability certificate request with an audiogram 8 months old, then the system requires a fresh audiogram before certificate generation.
12. Given cochlear implant surgery planned, then TR-003 reservation and OP-013 vaccination checklist are required before OT booking confirmation.

## 15. Enhancements / Later phases

- Sheet row 65 (Audiometry, Endoscopy, Allergy test, Procedure notes) — core. Market: newborn hearing screening programme, hearing-aid dispensing, vertigo lab, immunotherapy.
- Later: NOAH full integration, tele-audiology (OP-018), AI-007 endoscopy lesion flags, voice analysis (acoustic parameters) import, sleep-apnoea pathway with OP-030 (DISE scheduling), CI programming session logs.

## 16. Open Questions for the Hospital

1. Audiology equipment brands/export formats; sound-proof booths count; audiologist RCI registration?
2. Newborn hearing screening programme in place (universal vs targeted)? Reporting to NPPCD/RBSK?
3. Hearing-aid dispensing in-house? Vendors, trial policy, warranty handling, government schemes?
4. Endoscopy capture hardware; video retention policy?
5. Allergy testing & immunotherapy offered? Vertigo lab devices?
6. Disability certificate authority within hospital?
