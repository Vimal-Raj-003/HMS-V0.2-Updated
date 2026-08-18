# OP-016 — Pain Management Clinic (Pain scoring NRS/VAS, Block log, Medication titration, Multimodal therapy, Outcome tracking)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-016 |
| Phase | 8 (block log & pain scores usable with Phase 6 trauma pathway) |
| Priority | P1 |
| Complexity | Medium |
| Depends on | OP-002 (consultation, e-Rx), OP-010 (procedure console for blocks/RF/injections), OP-009 (ortho referrals), TR-010 (trauma rehab), OP-015 (physio), OP-032 (psychology/CBT for chronic pain), OP-031 (cancer pain), IP-024 (anaesthesia — pain physicians are often anaesthetists; acute pain service for IP), IP-003 (IP pain rounds), OP-003 (narcotic register, Schedule H1/X, NDPS), EN-029 (opioid dose/MME rules, interactions), OP-008 (fluoro/USG guidance, dose), EN-028 (consent), EN-039 (forms), EN-030 (PROMs), OP-005 (billing), NC-006 (consumables/implants: SCS, pumps via TR-003), EN-009, PE-001/OP-020 (pain diary), OP-018 (tele follow-up), NC-015 (incidents) |
| Feature flag | `module.pain_clinic.enabled` (sub: `pain.acute_service`, `pain.diary_app`) |
| Primary roles | Pain physician / Anaesthetist (10/6), Pain nurse (16), Resident (14) |
| Secondary roles | Physiotherapist (40), Psychologist (42), Pharmacist (30, opioids), Ortho/Onco/Neuro referrers, Receptionist (24), Billing (27), Quality (54), Patient (diary) |
| Regulatory | NDPS Act 1985 & 2014 amendment (Essential Narcotic Drugs — morphine/fentanyl/methadone: RMI registration, Form 3 stock, prescriptions in duplicate, ENDs register), Schedule H1/X (Drugs & Cosmetics Rules) records, NABH COP (pain assessment as 5th vital sign, pain management policy, sedation), CDC/WHO opioid stewardship (MME thresholds), AERB (fluoroscopy dose for interventional pain), Medical Council/NMC guidance on chronic opioid therapy, DPDP |

## 1. Purpose
OP-016 supports a multidisciplinary pain clinic: standardised pain assessment (NRS/VAS, Wong-Baker, FLACC, BPI, DN4/LANSS neuropathic screens, PainDETECT, PHQ-9/GAD-7 co-screens, PCS/TSK), problem-based pain diagnoses, multimodal treatment plans (medications with opioid stewardship and titration schedules, interventional blocks/RF/injections via OP-010, physio, psychology, TENS/acupuncture, neuromodulation), a structured **block log** with image-guidance and complications, and longitudinal outcome tracking (pain scores, function, opioid dose MME, sleep, satisfaction) — including the trauma pain pathway (acute → sub-acute → chronic) and an acute pain service (APS) for IP.

## 2. Users & Jobs-to-be-done
- **Pain physician** (desktop/tablet; 25–40 OP visits + 5–15 interventions/day): assess, classify pain, plan multimodal therapy, prescribe (incl. narcotics with NDPS compliance), perform/document blocks, titrate meds, review outcomes, tele follow-up.
- **Pain nurse**: pre-visit questionnaires (tablet/WhatsApp), pain scores, patient education, opioid agreements, block prep/recovery, follow-up calls, diary review.
- **Pharmacist**: END dispensing/records, opioid quantity limits, PMP-style duplicate check within hospital.
- **Physio/Psychologist**: receive referrals, contribute plan components/outcomes.
- **Patient**: pain diary in app, PROMs, med adherence, flare protocol.
- **Quality**: opioid stewardship KPIs, block complications, NABH pain audits.

## 3. Core Workflows
### 3.1 Referral/intake & assessment
1. Referral (OP-021 from ortho/onco/neuro/spine/palliative/IP APS) or direct booking → pre-visit questionnaire link (BPI, DN4, PHQ-9, GAD-7, PCS, sleep, prior treatments, current meds incl. opioids) → nurse verifies vitals/pain score (OP-007).
2. Physician assessment (EN-039 "Pain initial assessment"): pain history (onset, site on **body map with laterality**, character, temporal, intensity NRS now/worst/least/average, aggravating/relieving, radiation), mechanism classification (nociceptive/neuropathic/nociplastic/mixed; acute/sub-acute/chronic > 3 months; cancer/non-cancer), functional impact (BPI interference, ODI/NDI, WOMAC etc.), psychosocial (yellow flags), red flags (cauda equina, infection, malignancy, fracture → escalate), exam (neuro, provocative tests, tender points), prior interventions & response, imaging review (OP-008), risk assessment for opioids (ORT/SOAPP, substance history, sedative co-prescription) → **pain diagnosis** (ICD-10 G89.x/M54/M79.7/G56/G57/R52 etc., ICD-11 MG30 optional) → sign. Event `pain.assessment.recorded`.
### 3.2 Multimodal plan
1. Plan components: **pharmacological** (WHO ladder step, adjuvants: gabapentinoids, TCAs/SNRIs, topical, NSAIDs, muscle relaxants; opioids with agent, dose, MME auto-calc, max daily, duration, PRN rules, naloxone co-prescription rule; titration schedule e.g. "increase gabapentin 300 mg q3d to 900 TID if tolerated" → auto-generated dose calendar & patient instructions), **interventional** (see 3.3), **physical** (OP-015 referral: exercise, TENS, manual), **psychological** (OP-032: CBT, ACT, relaxation, sleep hygiene), **lifestyle/education** (PE-003), **acupuncture/AYUSH** (OP-037), neuromodulation (SCS trial/implant → TR-003 implant registry, OT IP-006), intrathecal pump refills.
2. **Opioid stewardship** (EN-029 rules): MME ≥ 50 warning, ≥ 90 requires justification & second physician review (config), benzodiazepine + opioid interaction alert, opioid agreement/consent (EN-028) required for chronic therapy, urine drug screen frequency, refill interval enforcement, quantity limits per NDPS (e.g. ≤ 30 days morphine for RMI), duplicate opioid Rx check across hospital doctors (`rx.opioid.duplicate`), naloxone advice ≥ 50 MME; every opioid Rx logged with END register link (OP-003).
3. Titration follow-ups: phone/tele (OP-018) at scheduled dates with pain score & side effects → dose adjust; taper plans (10 %/week templates) with monitoring.
### 3.3 Interventional procedures — block log (via OP-010)
1. Order block/injection from catalogue: nerve blocks (ilioinguinal, TAP, femoral, sciatic, ISB, stellate ganglion, occipital, genicular), spinal (epidural steroid interlaminar/transforaminal/caudal, facet MBB, RF ablation, SI joint), sympathetic (lumbar sympathetic, coeliac plexus, hypogastric), trigger point/Botox, PRP, vertebroplasty (OT), SCS trial; laterality/level(s) (e.g. L4-5 right TF), guidance (fluoro/USG/CT/landmark), sedation Y/N, anticoagulant hold plan (ASRA guidelines: e.g. clopidogrel 7 d, warfarin INR ≤ 1.2 for neuraxial, DOACs 72 h — EN-029 seeded), diabetic steroid advisory, consent (EN-028 pain-block templates), pre-block checklist & time-out via OP-010.
2. Documentation (OP-010 template "pain intervention"): position, prep, needle type/gauge, approach, levels, contrast spread pattern (fluoro image saved OP-008/OP-022), drug/dose/volume (steroid type & mg with cumulative steroid dose per year tracker), RF parameters (temp/time per lesion), sedation record, immediate response (NRS pre/post, sensory block), fluoro time/dose (AERB), complications (vasovagal, dural puncture, intravascular, paraesthesia, bleeding, infection later) → **block log** entry auto-created; post-procedure instructions & 30-day complication tracker (OP-010) → outcome check at 2 and 6 weeks (NRS, % relief, duration, function).
### 3.4 Outcome tracking
- Every visit/procedure captures NRS (now/avg/worst), BPI interference, condition-specific scores, sleep, mood (PHQ-9), opioid MME, work status, patient global impression of change (PGIC), satisfaction; charts trend; **pain diary** (app: 1–3× daily NRS, meds taken, flares, activity) feeds; response definitions (≥ 30 % / ≥ 50 % reduction) drive protocol next steps; non-responders flagged for MDT review; analytics per procedure/diagnosis/physician.
### 3.5 Acute pain service (IP, flag `pain.acute_service`)
- Post-op/trauma pain rounds list (IP-003 pain scores ≥ 4 or PCA/epidural running) → APS notes, PCA/epidural infusion parameters & safety checks (sedation score, RR, motor block), rescue analgesia orders, catheter site checks, transition to oral → discharge analgesic plan; shared `clinical.vitals` pain field.
### 3.6 Exceptions
- Opioid diversion/aberrant behaviour → flag, agreement review; lost Rx policy; block cancelled for INR/anticoagulant → reschedule with hold plan; adverse event → NC-015; offline: assessment forms/diary cached.

## 4. Data Model (schema `specialty`)
- **pain_episodes**: id, hospital_id, branch_id, patient_id, referral_id?, type enum(acute/subacute/chronic/cancer/aps_ip), primary_dx_icd10, mechanism enum(nociceptive/neuropathic/nociplastic/mixed), onset_date, sites jsonb (body map: region, side), lead_physician_id, status enum(active/discharged/lost/transferred), opioid_therapy bool, agreement_id?, risk_tool jsonb (ort/soapp scores), created_*; index (hospital_id, patient_id, status).
- **pain_assessments**: id, episode_id, encounter_id, type enum(initial/followup/pre_proc/post_proc/tele/diary_summary), nrs_now/avg/worst/least, vas, scale enum(nrs/vas/wong_baker/flacc/painad), bpi jsonb, dn4, lanss, paindetect, phq9, gad7, pcs, tsk, odi, ndi, other_scores jsonb, sleep, pgic, work_status, side_effects jsonb, form_response_id, recorded_by, at; index (episode_id, at).
- **pain_plans** (versioned): id, episode_id, encounter_id, components jsonb ([{type: drug|intervention|physio|psych|education|ayush|neuromod, ref, details}]), titration_schedule jsonb ([{drug, step_no, from_date, dose, instructions}]), taper_plan jsonb?, goals jsonb, review_date, signed_by, version.
- **opioid_prescriptions_log** (links OP-002 rx + OP-003 END register): id, hospital_id, patient_id, episode_id, rx_id, drug, form, strength, daily_dose, mme numeric, days_supply, quantity, agreement_ok bool, uds_last_at, duplicate_check jsonb, justification (if ≥ 90 MME), second_reviewer_id?, naloxone_prescribed bool; index (hospital_id, patient_id, created_at).
- **opioid_agreements**: id, patient_id, episode_id, consent_id (EN-028), signed_at, valid_to, terms_version, revoked_at, reason.
- **pain_interventions** (block log; 1:1 with OP-010 `procedures`): id, hospital_id, episode_id, procedure_id, patient_id, intervention_code, name, levels jsonb, side, guidance enum(fluoro/usg/ct/landmark), sedation bool, anticoag_hold jsonb, drugs jsonb ([{drug, dose_mg, volume_ml}]), steroid_mg_equiv, rf_params jsonb, contrast_pattern, images jsonb (OP-022/OP-008 refs), fluoro_sec, dose_mgy, nrs_pre, nrs_post_30min, sensory_block, complications jsonb, immediate_outcome enum(good/partial/none), followup_2w jsonb, followup_6w jsonb (nrs, relief_pct, duration_days, function), performed_by, at; index (episode_id, at), (hospital_id, intervention_code, at).
- **steroid_exposure** (derived): patient_id, year, cumulative_mg (triamcinolone equiv), last_at.
- **pain_diary_entries** (partitioned): patient_id, episode_id, at, nrs, meds_taken jsonb, flare bool, activity, sleep_hrs, notes, source enum(app/whatsapp/ivr).
- **aps_rounds** (if enabled): admission_id, at, pain_scores, modality enum(pca/epidural/nerve_catheter/oral/iv), pump_params jsonb, safety jsonb (sedation_score, rr, motor_block, site), actions, by.
- **pain_outcomes_snapshots** (read model): episode_id, month, mean_nrs, mme, function_score, responder bool.

## 5. Business Rules & Validations
- Pain score mandatory each visit (NABH 5th vital); scale by age/cognition (FLACC < 4 y, Wong-Baker 4–12, NRS adults, PAINAD dementia).
- Opioids: MME computed with standard conversion factors (morphine 1, tramadol 0.1/0.2 per policy, tapentadol 0.4, oxycodone 1.5, hydromorphone 4, fentanyl patch mcg/h × 2.4, methadone tiered, buprenorphine excluded/flagged); ≥ 50 MME warning + naloxone prompt; ≥ 90 MME → justification + second physician approval (EN-038); chronic (> 90 days) opioid therapy requires signed agreement, UDS at start & per policy, refill interval ≥ days_supply − 3; duplicate opioid Rx within 30 days by another prescriber → hard alert; NDPS: END drugs only by registered RMI, quantity caps, duplicate prescription form printing, END register entry via OP-003 (2-person dispensing).
- Interventions: consent + checklist + time-out (OP-010) mandatory; anticoagulant hold verification for neuraxial/deep blocks (ASRA table seeded; override with reason); steroid cumulative dose > policy (e.g. 3 epidurals/6 months or > 200 mg triamcinolone-equiv/yr) → warning; diabetic → glucose advice; fluoro dose recorded; complications feed OP-010 register; RF repeat interval rules.
- Outcome capture required at 2 & 6 weeks post-intervention (task); non-response twice → MDT flag.
- Taper plans generate patient calendar; missed titration follow-up → nurse task.
- Psych/psychology notes visibility restricted (OP-032 rules) — pain physician sees summary only unless shared.
- Records versioned; body map sites SNOMED-coded; retention clinical.

## 6. API Surface (`/api/v1/pain`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST/GET/PATCH | /episodes, /episodes/{id} | episode | pain.episode.create/read/update | Y | cursor |
| POST | /episodes/{id}/assessments | assessment (any type) | pain.assessment.create | Y | – |
| GET | /episodes/{id}/assessments, /outcomes | series/charts | pain.assessment.read | – | cursor |
| POST | /questionnaires/send, POST /public/questionnaires/{token} | pre-visit PROMs | pain.assessment.create / public | Y | – |
| POST/PATCH | /episodes/{id}/plans | plan + titration/taper | pain.plan.create/update | Y | – |
| GET | /episodes/{id}/plans/{v}/calendar | titration calendar (patient PDF) | pain.plan.read | – | – |
| POST | /opioids/check | MME/duplicate/agreement checks (called by OP-002 rx) | pain.opioid.check | – | – |
| POST/GET | /opioids/agreements | agreements | pain.opioid.manage | Y | cursor |
| POST | /episodes/{id}/interventions (creates OP-010 order+record) | block order/log | pain.intervention.create | Y | – |
| PUT | /interventions/{id} | log details/outcomes 2w/6w | pain.intervention.update | Y | – |
| GET | /interventions?code=&from= | block register | pain.intervention.read | – | cursor |
| POST/GET | /diary (patient scope), GET /episodes/{id}/diary | diary | patient scope / pain.assessment.read | Y | cursor |
| POST/GET | /aps/rounds?ward= | acute pain service | pain.aps.record/read | Y | cursor |
| GET | /stats/dashboard, /reports/opioid-stewardship | KPIs | pain.report.read | – | – |

## 7. Domain Events (outbox)
- `pain.episode.opened|discharged`, `pain.assessment.recorded` {nrs, scores}, `pain.plan.signed` {components} → OP-015/OP-032/OP-037 referrals, OP-002 rx, EN-009 calendar; `pain.opioid.threshold` {mme, level} → EN-038 approval, pharmacist; `pain.opioid.duplicate` → prescriber alert; `pain.intervention.logged|outcome.recorded|complication` → OP-010 register, NC-015, analytics; `pain.titration.due|missed` → nurse tasks/PE-002; `pain.diary.flare` → nurse queue; `pain.aps.alert` (sedation/RR) → IP-003.
- Consumes: `referral.created`, `procedure.completed` (OP-010), `rx.created` (opioid check), `pharmacy.dispensed` (END), `vitals.recorded` (pain), `lab.result.final` (UDS), `ip.pain_score.high` (IP-003).

## 8. Screens (UI)
1. **Pain clinic worklist** (desktop): visits with pre-visit questionnaire status, MME chip, next titration; `Enter` open.
2. **Assessment workspace** (desktop/tablet): body map (front/back, click sites, laterality), NRS sliders (now/avg/worst), questionnaire scores panel with auto-calc, red-flag banner, mechanism classifier; `Ctrl+S`, `Ctrl+Enter`.
3. **Plan builder**: multimodal component tiles, opioid calculator (MME live), titration/taper schedule generator with calendar preview & patient PDF, referrals; stewardship warnings inline.
4. **Block log / intervention record** (desktop/tablet in procedure room, via OP-010 template): level/side picker on spine diagram, drug/volume grid, fluoro image attach, NRS pre/post, complications; `F10` image, `Ctrl+Enter` sign.
5. **Outcome dashboard per patient**: NRS/BPI/MME/function/sleep trends with intervention markers; diary heatmap; PGIC.
6. **Patient app pain diary** (phone; OP-020): quick NRS + meds + flare; reminders; offline.
7. **APS rounds list** (tablet ward): patients with pumps/high scores, safety checks.
8. **Opioid stewardship dashboard** (desktop dark): MME distribution, high-dose patients, agreements/UDS compliance, duplicate alerts, END reconciliation (OP-003).

## 9. Integrations
- OP-010 procedure engine (consent/checklist/consumables/billing/media), OP-003 END/narcotic register (Form 3 stock, dispensing), EN-029 rules (MME/ASRA/interactions), OP-008/OP-022 imaging (fluoro spot images, dose), TR-003 (SCS/pump implants), OP-018 tele titration, EN-030/EN-009 questionnaires & diary via WhatsApp flows, EN-038 approvals, EN-028 agreements/consents; state PMP-like external registries (none national yet — placeholder connector EN-017).

## 10. Reports & Analytics
- Pain register (episodes by type/dx), NRS improvement (mean change, % responders ≥ 30/50 %), block register & complication rates by procedure/physician, repeat-intervention intervals, steroid exposure, opioid stewardship (patients by MME band, ≥ 90 MME with justification, agreement/UDS compliance, naloxone rate, duplicate alerts, taper success), NDPS/END consumption reconciliation (with OP-003), APS metrics (time to pain relief, % IP pain scores > 4 addressed within 60 min), diary engagement, revenue per intervention. Read models `analytics.pain_outcomes_monthly`, `analytics.opioid_stewardship`.

## 11. Notifications
- Patient: pre-visit questionnaire link, titration step reminders/calendar, diary prompts, post-block instructions & 2w/6w outcome links, agreement renewal, taper check-ins.
- Physician/nurse: red flags in questionnaires (PHQ-9 item 9 suicidality → immediate alert to physician + OP-032 pathway), high MME approvals, duplicate opioid alert, non-response flags, missed titration follow-up, diary flare, block complications; Pharmacist: END Rx issued/quantity anomalies.

## 12. Permissions (RBAC keys)
`pain.episode.create|read|update`, `pain.assessment.create|read`, `pain.plan.create|update|read|sign`, `pain.opioid.check|manage|approve_high_dose`, `pain.intervention.create|update|read`, `pain.aps.record|read`, `pain.report.read`, `pain.configure`, `pain.export`. Defaults: Pain physician — all clinical (approve_high_dose only for designated second reviewers/HOD); Resident — create/read, no sign; Pain nurse — assessment create, plan read, diary/questionnaire manage, aps.record; Pharmacist — opioid.check/read stewardship; Physio/Psych — episode read, plan read; Patient — diary/questionnaires.

## 13. Non-functional
- Volumes: 150 pain visits/day enterprise, 40 interventions/day, diary entries 3k/day (partitioned); MME check p95 < 50 ms (in-memory conversion table); body-map save < 200 ms.
- Offline: assessment forms & block log templates cached; diary offline; sync idempotent; questionnaire public endpoints tokenised & rate-limited.
- Print: titration calendar (patient language), NDPS duplicate prescription format, block report, agreement.
- Privacy: psych scores (PHQ-9/GAD-7) tagged sensitive; suicidality alert path audited.

## 14. Acceptance Criteria
1. Given a plan with morphine SR 30 mg BID + tramadol 50 mg TID, then MME = 60 + 15 = 75 → warning displayed and naloxone advice prompt; at 95 MME the plan requires justification and second-physician approval before sign.
2. Given another hospital doctor prescribed tramadol 10 days ago, when the pain physician prescribes an opioid, then a duplicate alert shows the prior Rx and requires acknowledgement.
3. Given a chronic opioid patient without a signed agreement, then opioid Rx sign is blocked with a one-click agreement flow (EN-028).
4. Given a lumbar TF epidural ordered for a patient on clopidogrel stopped 3 days ago, then the ASRA hold check flags "7 days required" and requires override reason to proceed.
5. Given a block completed with NRS 8 → 2 at 30 min, then the block log entry exists, 2-week and 6-week outcome tasks are created and patient links are scheduled.
6. Given 3 epidural steroid injections in 6 months, when a 4th is ordered, then a cumulative-steroid warning appears and is logged.
7. Given a pre-visit PHQ-9 with item 9 > 0, then the physician receives an immediate alert and the assessment shows a red banner with the OP-032 pathway button.
8. Given a titration schedule (gabapentin 300 → 900 TID over 9 days), then the patient receives a calendar PDF and daily WhatsApp reminders (opt-in) and the nurse sees a follow-up task on day 10.
9. Given diary entries showing NRS ≥ 8 for 3 consecutive days, then a flare alert reaches the pain nurse queue.
10. Given an END drug Rx, then OP-003 END register linkage is created and the printed prescription follows the duplicate NDPS format with RMI number.
11. Given the outcome dashboard, then it plots NRS/MME/function with intervention markers and computes responder status (≥ 30 % reduction) per month.
12. Given a nurse without `pain.plan.sign`, then sign returns 403 and is audited.

## 15. Enhancements / Later phases
- Costed proposal line 1571 (NRS/VAS scoring, block log, medication titration, multimodal therapy, outcome tracking) — core.
- Later: WhatsApp/IVR diary (EN-033), AI-002 opioid risk prediction & non-response prediction, VR/biofeedback devices (EN-042), neuromodulation device telemetry, palliative care home visits (NC-024), national PMP connector when available, ICD-11 chronic pain coding (MG30) via AI-006, group pain-education programmes (PE-003/PE-004).

## 16. Open Questions for the Hospital
1. Is the hospital an RMI under NDPS for essential narcotics? Which END drugs stocked; who are authorised prescribers?
2. MME thresholds & approval policy (default warn 50 / approve 90)? Opioid agreement template & UDS policy?
3. Intervention catalogue, guidance equipment (C-arm/USG in pain suite vs OT), sedation practice?
4. Steroid cumulative limits and repeat-interval policies?
5. Do you run an acute pain service for IP (PCA/epidural)? Ward rounds workflow?
6. Which questionnaires (BPI, DN4, PHQ-9, ODI…) and languages? Patient diary via app/WhatsApp?
