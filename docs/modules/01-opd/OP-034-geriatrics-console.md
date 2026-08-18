# OP-034 — Geriatrics Console (Comprehensive Geriatric Assessment, Fall risk, Cognitive screening, Polypharmacy/deprescribing review, Frailty, Functional status, Caregiver & advance care planning)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-034 |
| Phase | 8 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | **OP-025 §0 (shared specialty console framework)**, OP-002 (encounter, e-Rx, medication list/reconciliation), OP-003/EN-029 (Beers/STOPP-START rule set, renal dosing, anticholinergic burden, interactions, drug-disease), OP-007 (orthostatic vitals, weight), OP-032 (depression GDS-15, cognition MMSE/MoCA shared scale engine), OP-015 (physio: balance/gait training, TUG), OP-011 (MNA nutrition), OP-016 (pain), OP-025/OP-028 (vision/hearing), OP-026 (oral health), OP-029 (CV), OP-013 (adult vaccines: influenza, pneumococcal, zoster, Td), OP-021 (referrals), IP-003/IP-025 (fall risk continuity Morse; delirium CAM), EN-028 (advance directives/living will per Supreme Court 2018/2023 guidelines, POA), EN-039 (forms), EN-030 (caregiver questionnaires), PE-002 (recall), OP-018 (tele follow-up), OP-020 (caregiver app), NC-024/NC-013 (home visits/transport later), OP-038 (education) |
| Feature flag | `module.geriatrics.enabled` (sub: `geri.memory_clinic`, `geri.falls_clinic`, `geri.home_care`) |
| Primary roles | Geriatrician / Physician (6), Geriatric nurse (16), Resident (14), Clinical pharmacist (30/32: medication review), Physiotherapist/OT (40), Psychologist (42, cognition), Social worker |
| Secondary roles | Dietician (39), Family/caregiver (60), Neurologist/psychiatrist, Palliative team (OP-016), Reception (24, longer slots), Quality (54) |
| Regulatory | NABH (vulnerable patient policy, fall prevention), National Programme for Health Care of the Elderly (NPHCE reporting), Maintenance and Welfare of Parents and Senior Citizens Act 2007 (elder abuse awareness/reporting pathway), Rights of Persons with Disabilities Act (dementia certification), Advance medical directive (Supreme Court Common Cause 2018, simplified 2023), NDPS/H1 (benzodiazepine registers), DPDP (caregiver access with consent) |

## 1. Purpose
OP-034 operationalises **Comprehensive Geriatric Assessment (CGA)** as a multidisciplinary console: functional status (Katz ADL, Lawton IADL), mobility & **fall risk** (history, TUG, gait speed, Berg, orthostatic BP, home hazards, Morse for IP continuity), **cognitive screening** (MMSE/MoCA/Mini-Cog, clock drawing capture, CDR, caregiver AD8/IQCODE), mood (GDS-15), nutrition (MNA-SF), sensory (vision/hearing), continence, sleep, pain, **frailty** (Clinical Frailty Scale, FRAIL, Fried), social/caregiver strain (Zarit), **polypharmacy review** (medication reconciliation, Beers/STOPP-START, anticholinergic burden, deprescribing plan with taper schedules), problem-based care plan with goals, advance care planning, vaccination status, and structured follow-up (memory clinic, falls clinic). Framework per OP-025 §0.

## 2. Users & Jobs-to-be-done
- **Geriatrician** (desktop/tablet; 25–40 pts/day, 30–45 min slots): run CGA, interpret domain scores, prioritise problems, deprescribe, plan MDT interventions, counsel family, ACP.
- **Geriatric nurse**: pre-consult screening battery on tablet (ADL/IADL, TUG, orthostatic vitals, MNA-SF, GDS, Mini-Cog), fall history, caregiver interview, education, follow-up calls.
- **Clinical pharmacist**: brown-bag medication reconciliation, review against Beers/STOPP-START, interactions, adherence aids (pill organiser, blister packs), deprescribing suggestions to doctor.
- **Physio/OT**: balance/gait assessment & programme, home hazard checklist, assistive devices.
- **Psychologist/social worker**: neuropsych testing, caregiver support, elder-abuse screening (EASI), social benefits.
- **Caregiver/patient**: app view of care plan, medication schedule, appointment, education; caregiver questionnaires.

## 3. Core Workflows
### 3.1 Screening & CGA
1. Console tabs: CGA summary · Function/Mobility/Falls · Cognition/Mood · Medications · Nutrition/Sensory/Continence · Frailty/Social/Caregiver · Care plan/ACP · Follow-up.
2. Nurse pre-consult battery (EN-039 forms with auto-score): Katz ADL (0–6), Lawton IADL (0–8), falls in last 12 months (count, injuries, fear of falling FES-I short), TUG seconds (video-timed optional), gait speed (4 m), orthostatic BP (lying/standing 1 & 3 min; drop ≥ 20/10 flags), MNA-SF, GDS-15, Mini-Cog (clock drawing photo/canvas), vision (Snellen near/far), whisper/hearing screen, continence questions, sleep, pain NRS, CFS 1–9 → **domain traffic-light summary** for the doctor.
3. Geriatrician: confirms/deepens (MoCA/MMSE full with education adjustment, CDR staging, AD8/IQCODE from caregiver, delirium screen CAM if acute), problem list ICD-10 (R54 senility?—prefer specific: F03 dementia, R26.8 gait, R29.6 falls, N39 incontinence, R53.81 frailty (ICD-10-CM) or hospital coding policy), **prioritised problem list & goals** (patient-centred), interventions per domain, referrals (physio falls programme, dietician, audiology, ophthalmology, dental, psychiatry/neurology memory work-up incl. labs B12/TSH/imaging OP-008), vaccination gaps (OP-013), sign → CGA summary letter (family-friendly language) → `geri.cga.signed`.
### 3.2 Fall risk & falls clinic (`geri.falls_clinic`)
- Multifactorial risk profile (history, medications sedatives/antihypertensives, orthostatic, gait/balance, vision, footwear, cognition, continence, home hazards checklist by OT/caregiver photo upload), risk level → interventions bundle: exercise (Otago via OP-015), medication changes, vitamin D/calcium, vision referral, home modifications, assistive devices, alarms; fall event log (date, circumstances, injury, ED/IP link OP-006/IP-001; injurious falls → fracture pathway OP-009/TR-002, osteoporosis work-up DEXA & FRAX score); re-assessment schedule; Morse score continuity for admissions (IP-003).
### 3.3 Cognitive/memory clinic (`geri.memory_clinic`)
- Structured dementia work-up: history from informant, cognitive tests (MMSE/MoCA/ACE-III attachments), depression exclusion, reversible causes labs, neuroimaging, functional impact (IADL), behavioural symptoms (NPI-Q), driving/safety, capacity & ACP discussion, caregiver burden (Zarit), diagnosis (Alzheimer/vascular/LBD/FTD/MCI), management (cholinesterase inhibitors with HR/ECG check EN-029, non-pharm), caregiver education & support group (PE-004), disability certificate (RPwD dementia), 6-monthly review with trend charts.
### 3.4 Polypharmacy review & deprescribing
1. **Medication reconciliation** (brown-bag: scan/enter all meds incl. OTC/AYUSH OP-037/supplements; adherence, who administers, cost) → structured med list (OP-002 source of truth) → **automated review** (EN-029 geriatrics rule set): AGS Beers 2023 & STOPP/START v3 seeds, anticholinergic burden score (ACB ≥ 3 flag), sedative load, drug-disease (e.g. NSAIDs + CKD/HF, benzodiazepines + falls), duplications, renal dosing (eGFR CKD-EPI 2021), interactions, high-risk combos, START omissions (e.g. no statin post-MI, no anticoagulant in AF with CHA₂DS₂-VASc ≥ 2 without contraindication) → pharmacist annotates recommendations (stop/taper/switch/dose-reduce/start/monitor) with evidence → doctor accepts/rejects each (reason) → **deprescribing plan** with taper schedules (e.g. benzodiazepine 10–25 % q2 wk) → patient/caregiver med schedule card (pictorial, large font, regional language) & pill-organiser/blister pack request to OP-003 → follow-up on withdrawal symptoms; every review versioned; measures: number of meds, ACB, PIMs count before/after.
### 3.5 Care plan, ACP & caregiver
- Problem-goal-intervention-owner-review-date grid; advance care planning conversation record, advance medical directive/living will documents (EN-028: templates per SC guidelines, witness/notary fields, custodian), surrogate/POA, code status preference (informational for IP), goals of care; caregiver profile (Zarit burden, training needs, respite), elder-abuse screening (EASI) → social worker/legal pathway; social benefits/pension info; home-care/tele follow-up (`geri.home_care`: visit scheduling with nurse/physio, transport NC-024).
### 3.6 Follow-up
- Domain-based recall (falls 3 mo, memory 6 mo, medication review 6–12 mo, frailty annual), telephone/tele check-ins (OP-018), caregiver questionnaires (EN-030), admissions/ED events feed (auto-flag post-discharge review within 7 days), vaccination reminders.
### 3.7 Exceptions
- Patient unable to complete tests (sensory/cognitive) → record "unable" with reason; caregiver unavailable → informant tools deferred; suspected abuse → restricted note & MS/social worker task; capacity lacking → surrogate documentation for consent; offline: nurse battery cached.

## 4. Data Model (schema `specialty`)
- **geri_cga**: id, hospital_id, branch_id, patient_id, encounter_id, type enum(initial/annual/interim/post_discharge), domains jsonb ({function:{katz, lawton}, mobility:{tug_s, gait_ms, berg, falls_12m, fes_i, orthostatic:{ly, st1, st3, drop}}, cognition:{minicog, mmse, moca, cdr, ad8, cam}, mood:{gds15}, nutrition:{mna_sf, weight, bmi}, sensory:{vision, hearing}, continence, sleep, pain, frailty:{cfs, frail, fried}, social:{living, caregiver, zarit, easi}}), problems jsonb ([{icd10, priority, goal}]), plan jsonb, summary_letter_doc_id, signed_by/at, version; index (hospital_id, patient_id, at desc).
- **geri_scale_results** (reuse `psy_scales` engine or own): patient_id, encounter_id, scale enum(katz/lawton/tug/gait/berg/fes_i/mna_sf/gds15/minicog/mmse/moca/cdr/ad8/iqcode/cam/npi_q/zarit/easi/cfs/frail/fried/frax/other), items jsonb, score numeric, at, by; index (patient_id, scale, at). (MMSE/MoCA/GDS share scoring library with OP-032.)
- **geri_fall_risk_profiles**: id, patient_id, encounter_id, factors jsonb (checklist with sources), risk enum(low/moderate/high), interventions jsonb, home_hazards jsonb (photos), morse_score?, next_review_at; **geri_fall_events**: id, patient_id, at, location enum(home/community/hospital), circumstances, injury enum(none/minor/fracture/head/other), er_visit_id?, admission_id?, by.
- **geri_med_reviews**: id, patient_id, encounter_id, version, reconciled_list jsonb ([{drug, dose, freq, indication, source, adherence, prescriber, otc bool}]), metrics jsonb (n_meds, acb, pims, sedative_load, egfr), findings jsonb ([{rule (beers/stopp/start/interaction/renal/duplicate), drug, severity, recommendation enum(stop/taper/switch/reduce/start/monitor), pharmacist_note, doctor_decision enum(accepted/rejected/deferred), reason}]), taper_plans jsonb, med_card_doc_id, pharmacist_id, doctor_id, signed_at; index (patient_id, signed_at desc).
- **geri_memory_cases**: id, patient_id, dx enum(mci/ad/vascular/lbd/ftd/mixed/other/undetermined), stage (cdr), workup jsonb (labs, imaging refs), bpsd jsonb (npi_q), driving_safety, capacity jsonb, treatment jsonb, caregiver_id, review_interval_months, status.
- **geri_care_plans**: id, patient_id, version, items jsonb ([{problem, goal, intervention, owner_role, review_at, status}]), acp jsonb ({discussion_at, directive_doc_id, surrogate, code_status_pref, goals_of_care}), caregiver jsonb ({name, relation, phone, consent_id, training, respite}), active bool.
- **geri_followups**: patient_id, kind enum(falls/memory/med_review/frailty/post_discharge/tele/home_visit), due_at, status, outcome; **geri_home_visits** (`geri.home_care`): id, patient_id, scheduled_at, staff_ids, tasks, findings, travel jsonb.
- Enums: `cga_type`, `fall_risk_level`, `med_recommendation`, `dementia_dx`.

## 5. Business Rules & Validations
- Age gate: console default for ≥ 60 y (config; ≥ 65 option); younger allowed with reason (frailty/dementia).
- Scores auto-computed; TUG ≥ 12 s, gait < 0.8 m/s, ≥ 2 falls/yr or injurious fall, orthostatic drop ≥ 20/10 → high fall risk suggestion; CFS ≥ 5 frail flag; Mini-Cog < 3 or MoCA < 26 (education-adjusted +1 if ≤ 12 y schooling) → cognitive work-up prompt; GDS-15 ≥ 5 → depression pathway (OP-032 referral; item on suicidality → risk alert like OP-032); MNA-SF ≤ 11 → dietician referral (OP-011).
- Medication review: reconciliation must precede review; rule set (Beers 2023, STOPP/START v3) versioned & hospital-approved; ACB computed from seeded table; each finding requires doctor decision before review sign; taper schedules generate patient calendar & PE-002 checks; benzodiazepine/opioid deprescribing links to OP-016 opioid rules; renal dosing uses eGFR ≤ 90 days old else prompt.
- Cholinesterase inhibitors: baseline HR/ECG (bradycardia < 50 → warn) via EN-029; antipsychotics in dementia → black-box warning acknowledgment; anticoagulation decision documented in AF with START rule.
- ACP documents: witness fields, capacity attestation, versioning; visible to IP teams (IP-001 banner: "AMD on file") but does not itself constitute an order — treating team must act per policy; caregiver access to records only with patient (or surrogate) consent (DPDP).
- Elder abuse suspicion → restricted note class (as OP-032 session notes) & mandatory task to social worker/MS; not visible to caregiver portal.
- Falls in hospital → NC-015 incident & IP-003 Morse; post-discharge CGA within 7 days for admitted patients (auto follow-up).
- Documents immutable after sign; med review versions retained; retention clinical.

## 6. API Surface (`/api/v1/geri`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /worklist | geriatric clinic worklist (frailty/falls chips) | geri.visit.read | – | cursor |
| POST/GET/PUT | /patients/{id}/cga, /cga/{id} | CGA | geri.cga.record/read/sign | Y | cursor |
| POST/GET | /patients/{id}/scales | scale results/trends | geri.scale.record/read | Y | cursor |
| POST/GET | /patients/{id}/fall-risk, /fall-events | falls | geri.falls.manage | Y | cursor |
| POST/GET/PATCH | /patients/{id}/med-reviews, /med-reviews/{id}/findings/{fid} | med review | geri.medreview.reconcile/review/decide/sign | Y | cursor |
| GET | /med-reviews/{id}/card.pdf | pictorial med schedule | geri.medreview.read | – | – |
| POST/GET/PATCH | /memory-cases | memory clinic | geri.memory.manage | Y | cursor |
| POST/GET/PUT | /patients/{id}/care-plan, /acp | care plan/ACP | geri.careplan.manage / geri.acp.manage | Y | – |
| POST/GET | /followups, /home-visits | follow-up | geri.followup.manage / geri.home.manage | Y | cursor |
| POST | /caregiver/questionnaires (token) | Zarit/AD8 by caregiver | public token / geri.scale.record | Y | – |
| GET | /reports/kpis, /reports/nphce | reports | geri.report.read | – | – |

## 7. Domain Events (outbox)
- `geri.cga.signed` {frailty, fall_risk, cognition_flag}, `geri.fall_risk.high`, `geri.fall_event.recorded` (→ NC-015 if in hospital, OP-009 if fracture), `geri.cognition.flag`, `geri.mood.risk` (→ OP-032 alert path), `geri.medreview.findings_ready` (→ doctor), `geri.medreview.signed` {n_meds_before/after, pims}, `geri.taper.step_due`, `geri.acp.recorded` (→ IP-001 banner), `geri.abuse.flag` (restricted), `geri.followup.due|missed`, `geri.home_visit.scheduled`.
- Consumes: `admission.discharged` (post-discharge review), `er.visit.created` (fall codes), `rx.created` (review trigger if new PIM), `lab.result.final` (eGFR/B12/TSH), `vaccine.due` (OP-013), `visit.no_show`.

## 8. Screens (UI)
1. **Geriatric worklist** (desktop): frailty CFS chip, fall-risk colour, meds count, ACP-on-file icon.
2. **Nurse screening battery** (tablet): stepper through domains with big buttons, TUG timer, orthostatic BP timer prompts, clock-drawing canvas/camera, auto-score tiles; offline.
3. **CGA dashboard** (desktop): domain traffic-light wheel, trends (TUG, MoCA, weight, meds count), problem-goal grid, letter preview; `Ctrl+Enter` sign.
4. **Medication review workspace** (desktop, pharmacist/doctor split): reconciled list table (source badges), findings panel grouped by rule with severity, decision buttons (`A` accept/`R` reject), taper builder, med card preview (pictorial, large font).
5. **Falls clinic** (desktop/tablet): risk factor checklist, interventions bundle, event timeline, home hazard photos.
6. **Memory clinic** (desktop): work-up checklist, cognitive trend chart, caregiver tools inbox, disability certificate.
7. **Care plan & ACP** (desktop): grid, directive document wizard (EN-028), caregiver panel.
8. **Caregiver app** (phone; OP-020): med schedule with reminders & tick-off, appointments, questionnaires, education, emergency contacts.
- Empty states: "No CGA yet — start nurse battery"; unable-to-test markers.

## 9. Integrations
- EN-029 geriatrics rule set (Beers/STOPP-START/ACB seeds — versioned masters via EN-027), OP-002 medication list & OP-003 blister packaging, EN-030 caregiver questionnaires (WhatsApp/tokenised links), OP-015 falls programme, OP-013 adult vaccination, EN-028 advance directive templates, OP-018 tele, IP-003 Morse continuity, DEXA/FRAX (OP-008), NPHCE reporting (CSV/manual), EN-011 FHIR (Observation for scales; Consent/AdvanceDirective as DocumentReference), OP-020 caregiver app scope.

## 10. Reports & Analytics
- CGA coverage of ≥ 60 y visitors, frailty distribution, fall-risk levels & fall events (community/in-hospital), injurious falls & fractures, cognitive screening yield & memory clinic diagnoses, med review metrics (mean meds, PIMs, ACB before/after; acceptance rate of pharmacist recommendations), deprescribing success at 3 mo, depression screening positives, vaccination coverage, ACP completion rate, caregiver burden distribution, follow-up compliance, post-discharge review within 7 days %, home visits, NPHCE returns. Read models `analytics.geri_monthly`, `analytics.geri_medreview`.

## 11. Notifications
- Patient/caregiver (large-font, regional): appointment & tele reminders, medication schedule/taper steps, falls-programme sessions, vaccine due, questionnaire links, post-discharge review. Staff: high fall risk, mood risk alert, med review findings ready, taper follow-up due, abuse flag task, missed follow-up, in-hospital fall.

## 12. Permissions (RBAC keys)
`geri.visit.read`, `geri.cga.record|read|sign`, `geri.scale.record|read`, `geri.falls.manage`, `geri.medreview.reconcile|review|decide|sign|read`, `geri.memory.manage`, `geri.careplan.manage`, `geri.acp.manage`, `geri.followup.manage`, `geri.home.manage`, `geri.abuse.flag|manage`, `geri.report.read`, `geri.configure`. Defaults: Geriatrician — all (medreview.decide/sign); Nurse — scales/cga.record, falls entry, followup; Pharmacist — medreview.reconcile/review; Physio/OT — falls.manage (assessment/interventions), scales (TUG/Berg); Psychologist — cognition scales, memory work-up entries; Social worker — careplan (social), abuse.manage, home.manage; Caregiver — app scope with consent.

## 13. Non-functional
- Volumes: 120 geriatric visits/day enterprise, 60 med reviews/day, caregiver questionnaires 200/day; rule-engine review over 20 meds < 300 ms; battery form load < 1 s; offline nurse battery; print: CGA family letter, pictorial medication card (A4, ≥ 14 pt), taper calendar, ACP documents; accessibility: large-font mode, high contrast, screen-reader labels; i18n regional languages for patient artefacts.

## 14. Acceptance Criteria (plus OP-025 §0.9)
1. Given a 72-y patient with TUG 15 s, 2 falls last year and orthostatic drop 25 mmHg, then fall risk = high, and the interventions bundle (physio Otago referral, med review flag, vision check) is proposed.
2. Given Mini-Cog score 2 in the nurse battery, then the CGA dashboard shows a cognition red flag and a memory clinic work-up checklist is offered.
3. Given a reconciled list containing diazepam 5 mg HS, amitriptyline 25 mg, and glibenclamide in an 80-y-old with eGFR 40, then Beers/STOPP findings for all three and ACB score are displayed with pharmacist recommendation slots.
4. Given the doctor accepts "taper diazepam 25 % every 2 weeks", then a taper calendar is generated, patient card printed with steps, and PE-002 follow-ups created at each step.
5. Given the doctor rejects a recommendation without a reason, then the review cannot be signed.
6. Given a signed med review, then metrics show meds 11 → 8, PIMs 3 → 0 on the dashboard and analytics read model.
7. Given GDS-15 = 7 with positive suicidality item, then an immediate alert follows the OP-032 pathway and the worklist chip turns red.
8. Given an ACP directive uploaded and signed with witnesses, then IP-001 admissions display an "AMD on file" banner with link (no order created).
9. Given a fall event recorded as in-hospital, then an NC-015 incident is created and Morse reassessment task fires for the ward.
10. Given a suspected elder abuse flag, then the note is restricted and hidden from caregiver app, and a social-worker task exists.
11. Given a caregiver without patient consent, when opening the app, then only appointment reminders (no clinical data) are shown.
12. Given a nurse attempts to sign a CGA, then 403 and audit.

## 15. Enhancements / Later phases
- Sheet row 72 (Fall risk, Cognitive screen, Polypharmacy review) — core. Market: frailty/CGA MDT, deprescribing engine, ACP, caregiver app.
- Later: wearable fall detection & gait sensors (EN-042), AI-005 frailty/readmission prediction, home-care route optimisation (NC-024), day-care/respite booking, dementia-friendly ward flags (IP-001), voice-based cognitive tests, national elder-care registries.

## 16. Open Questions for the Hospital
1. Age threshold and slot length for geriatric clinic; MDT members available (pharmacist, OT, social worker)?
2. Which cognitive/functional tools standard; Beers vs STOPP/START preference; hospital-approved deprescribing protocols?
3. ACP/advance directive templates & custodian; policy for IP visibility?
4. Home-care services offered? Caregiver app scope & consent capture?
5. NPHCE reporting obligations?
