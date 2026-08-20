# OP-033 — Paediatrics Console (WHO/IAP growth charts, Weight-based dosing, Developmental milestones, Immunisation link OP-013, NICU/high-risk newborn follow-up, Adolescent & school health)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Module ID       | OP-033                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Phase           | 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Complexity      | Medium-High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Depends on      | **OP-025 §0 (shared specialty console framework)**, OP-002 (encounter, e-Rx), OP-007 (paediatric vitals: weight/length/height/HC/MUAC, age-based normal ranges, PEWS), OP-013 (immunisation schedules IAP/UIP, due list, AEFI), IP-011 (birth record, newborn registration), IP-015 (NICU/PICU discharge → follow-up), EN-029 (weight/BSA-based dose ranges, paediatric max doses, formulation strengths, mL calculation), OP-003 (paediatric formulations, dose in mL), OP-004 (age-specific reference ranges, newborn screening TSH/G6PD/CH), OP-008 (paediatric imaging dose), OP-006 (PALS/emergency; PEWS triage), OP-011 (nutrition: SAM/MAM, IYCF counselling), OP-028 (hearing screening), OP-025 (ROP/vision screening), OP-035 (speech/language delay), OP-015 (developmental therapy), OP-032 (child & adolescent mental health), OP-040 (antenatal → newborn continuity), EN-039 (forms), EN-028 (guardian consent), EN-009, PE-002 (recall), OP-020/PE-001 (parent app: growth, vaccines, milestones), NC-035 (school health camps), RBSK/RKSK programme reporting (EN-017) |
| Feature flag    | `module.paediatrics.enabled` (sub: `paeds.high_risk_followup`, `paeds.adolescent`, `paeds.school_health`, `paeds.developmental_clinic`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Primary roles   | Paediatrician (6), Neonatologist (6/11), Paediatric nurse (16), Resident (14), Developmental therapist/psychologist (40/42)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Secondary roles | Dietician (39), Vaccination nurse (OP-013), Audiologist/ophthalmologist, Social worker, ASHA/ANM (camps), Reception (24), Parent/guardian (portal), School nurse (portal later)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Regulatory      | IAP immunisation schedule & UIP/U-WIN (OP-013), WHO Child Growth Standards 2006 (0–5 y) & WHO 2007 reference (5–19 y), IAP 2015 growth charts (5–18 y India), IAP/WHO IYCF & SAM guidelines, RBSK (Rashtriya Bal Swasthya Karyakram 4Ds screening: defects, deficiencies, diseases, developmental delays; DEIC referral), RKSK (adolescent health), POCSO Act 2012 & JJ Act 2015 (mandatory reporting, guardian consent), Birth registration (RBD Act) via IP-011, MTP/PC-PNDT n/a here, NABH, DPDP (children's data — verifiable parental consent under DPDP Rules 2025)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 1. Purpose

OP-033 supports child health from newborn to adolescence: **anthropometry with WHO/IAP growth charts** (weight-for-age, length/height-for-age, weight-for-length/BMI-for-age, head circumference, MUAC; z-scores & percentiles; preterm corrected age with Fenton/Intergrowth until 2 y), **weight/BSA-based prescribing** with mL conversions and safety caps, **developmental milestone screening** (age-appropriate domains; red flags; Trivandrum/ASQ-style tools; M-CHAT for autism; RBSK 4Ds), **immunisation status panel** (read from OP-013 with one-click due-vaccine order), **high-risk newborn/NICU follow-up** programme (structured visits, ROP/hearing/neurodevelopment checkpoints), nutrition (SAM/MAM classification & IYCF), adolescent health (HEADSS, Tanner staging, menstrual health, RKSK), school health/camps, and parent-facing growth/vaccine/milestone views. Framework per OP-025 §0.

## 2. Users & Jobs-to-be-done

- **Paediatrician** (desktop/tablet; 50–90 pts/day in season): quick well-baby/sick visits, plot growth, screen development, prescribe safely by weight, order vaccines, counsel, follow high-risk babies.
- **Paediatric nurse**: measure & enter anthropometry (with device link OP-007), MUAC, temp; PEWS; feeding history; vaccine due check; parent education.
- **Neonatologist**: NICU graduate follow-up schedule and outcomes.
- **Developmental therapist/psychologist**: developmental assessments (DASII/Bayley attachments), early intervention plans, DEIC linkage.
- **Parent** (app): growth curves, vaccine card & reminders, milestone checklist, sick-child advice.

## 3. Core Workflows

### 3.1 Visit & anthropometry

1. Console tabs: Growth · Development · Immunisation · Nutrition/Feeding · Newborn/High-risk · Adolescent · Sick-visit (SOAP overlay) · Parent education.
2. Nurse enters weight (g/kg precision), length (< 2 y supine) / height, HC (< 3 y), MUAC (6–59 mo), BMI auto; date-of-birth & sex → **age in days/months**, corrected age for preterm (GA < 37 wk until 24 mo) → z-scores/percentiles via WHO 2006 LMS tables (0–5), WHO 2007 (5–19) or IAP 2015 (5–18, hospital choice), Fenton/Intergrowth-21st (preterm), CDC optional → plot on charts with previous points; flags: weight-for-height z < −3 (SAM) / < −2 (MAM), MUAC < 11.5 cm, stunting HAZ < −2, overweight/obesity BMI z, HC crossing centiles (micro/macrocephaly), growth faltering (crossing 2 major centile lines) → CDSS prompts (nutrition referral OP-011, endocrine work-up). Event `paeds.anthropometry.recorded`.

### 3.2 Weight-based prescribing

- e-Rx (OP-002) with paediatric mode: dose entered as mg/kg/dose or mg/kg/day ÷ frequency → total mg (capped at adult max) → **volume in mL** by chosen formulation strength (syrup mg/5 mL, drops mg/mL) rounded to 0.1 mL; EN-029 checks: mg/kg range per drug (IAP/BNFc-style seed table), max daily, age contraindications (aspirin < 16 y Reye's, tetracyclines < 8 y, codeine < 12 y, fluoroquinolones caution), renal adjust, duplicate ingredients (paracetamol combos), antibiotic stewardship (AWaRe class prompt); weight used must be from today/≤ 7 days else prompt; printed Rx shows dose in mL with measuring-cup guidance in parent language; ORS/zinc bundles for diarrhoea; nebulisation orders → OP-039.

### 3.3 Developmental surveillance & screening

- Age-triggered milestone checklists (gross motor, fine motor, language, social/cognitive; IAP/WHO/CDC 2022 milestone ages), red flags (no social smile by 3 mo, no head control 6 mo, no babble 9 mo, no walking 18 mo, regression), screening tools at scheduled ages: M-CHAT-R/F (18/24 mo), ASQ/TDSC (Trivandrum Developmental Screening Chart), vision/hearing screens (OP-025/OP-028), RBSK 4Ds; results → risk categorisation → referrals (developmental clinic `paeds.developmental_clinic`, DEIC, speech OP-035, physio/OT OP-015, audiology, ophthalmology, psychiatry OP-032) with tracking; formal assessments (DASII, Bayley, ISAA/CARS for autism) uploaded (OP-022) with scores typed; early-intervention plan and home programme (OP-038).

### 3.4 Immunisation panel (via OP-013)

- Read-only schedule status (due/overdue/given/contraindicated) with catch-up plan; "order due vaccines" → OP-013 administration workflow (nurse), AEFI visibility; certificate print; adult-onset vaccines for adolescents (HPV, Tdap) prompts.

### 3.5 Newborn & high-risk follow-up (`paeds.high_risk_followup`)

- Newborn first visit (from IP-011 birth record: birth weight, GA, APGAR, resuscitation, screening results, BCG/OPV/HepB birth doses, mother's ANC/HIV/HBsAg status): feeding assessment, jaundice (TcB/TSB nomogram plot Bhutani), weight-loss %, danger signs (IMNCI/YICS), umbilical/eye care; **high-risk register** (preterm < 34 wk / < 1.8 kg, HIE, NICU > 7 days, sepsis/meningitis, hyperbilirubinemia needing exchange, congenital anomalies, syndromes) → structured follow-up schedule (e.g. 2 wk, 6 wk, 3/6/9/12/18/24 mo): growth (corrected), neuro exam (tone, Amiel-Tison), HINE (3–6 mo), ROP screening (OP-025: 30 days or 4 wk PMA rules), hearing (OAE/BERA OP-028), USG cranium, developmental assessments, vision, feeding/nutrition (fortification), immunisation catch-up, outcomes at 2 y (CP, hearing/vision impairment, developmental quotient); lost-to-follow-up tracking & phone recall.

### 3.6 Nutrition & feeding

- IYCF assessment (breastfeeding exclusivity, complementary feeding), SAM/MAM management (appetite test, RUTF/F-75/F-100 via OP-011, NRC referral), micronutrients (IFA/Vit A/deworming per schedule), obesity counselling; nutrition plan & follow-up.

### 3.7 Adolescent & school health (`paeds.adolescent`, `paeds.school_health`)

- HEADSS psychosocial screen (confidential section, restricted like OP-032 for sensitive disclosures), Tanner staging, menstrual history/PCOS/anaemia screening, RKSK counselling, HPV/Tdap, substance use (CRAFFT), mental health referral (OP-032); consent nuances (mature minor policy config); **school health camps** (NC-035): bulk screening forms (vision, dental OP-026, anaemia, BMI), class-wise reports, referral lists.

### 3.8 Sick visits & emergencies

- IMNCI/PEWS-based danger sign banner (from OP-007), common protocols (fever, diarrhoea/dehydration plan A/B/C, pneumonia fast breathing thresholds by age, asthma OP-030, febrile seizure) as templates; admission (IP-001/IP-015) hand-off; child protection: injury inconsistent with history → POCSO/child abuse workflow prompt (task to MS/social worker, MLC TR-008), audit.

### 3.9 Exceptions

- Unknown DOB → estimated age flag (bone age later); weight not measured today → block weight-based Rx unless override; parent app consent (DPDP verifiable parental consent) missing → no portal push; offline: anthropometry/milestone forms cached with LMS tables cached.

## 4. Data Model (schema `specialty`)

- **paeds_profiles**: id, hospital_id, patient_id (unique), birth_weight_g, ga_weeks, ga_days, birth_record_id (IP-011), delivery_mode, apgar_1/5, neonatal_events jsonb, screening jsonb (TSH, G6PD, CH, hearing, ROP), high_risk bool, risk_categories text[], corrected_age_until date, guardian jsonb ({name, relation, consent_id}), blood_group, allergies_ref, school jsonb; index (hospital_id, high_risk).
- **paeds_anthropometry**: id, hospital_id, patient_id, encounter_id, at, age_days int, corrected_age_days int?, weight_kg numeric(5,3), length_cm numeric(5,1), measured_supine bool, hc_cm numeric(4,1), muac_cm numeric(4,1), bmi numeric(5,2), z jsonb ({waz, haz, whz, bmiz, hcz, muac_z}) , pct jsonb, standard enum(who2006/who2007/iap2015/fenton/intergrowth/cdc), flags text[] (sam/mam/stunted/overweight/obese/faltering/microcephaly/macrocephaly), device_source, by; index (patient_id, at).
- **growth_reference_lms** (mdm, seeded): standard, sex, indicator, age_days_or_length, L, M, S — used for z-score computation server-side & cached client-side.
- **paeds_milestones**: id, patient_id, encounter_id, age_months numeric, domain enum(gross_motor/fine_motor/language/social_cognitive), item_code, achieved enum(yes/no/unsure), red_flag bool, by, at; **paeds_dev_screens**: id, patient_id, encounter_id, tool enum(mchat/asq/tdsc/rbsk_4d/hine/dasii/bayley/isaa/cars/other), result jsonb, score, risk enum(low/medium/high), referral_ids uuid[], attachment_ids, by, at.
- **paeds_high_risk_followups**: id, patient_id, schedule_key, due_at, visit_encounter_id?, status enum(due/done/missed/lost), findings jsonb (neuro, hine, rop, hearing, dev), outcome_2y jsonb.
- **paeds_nutrition_assessments**: id, patient_id, encounter_id, iycf jsonb, classification enum(normal/mam/sam_uncomplicated/sam_complicated/overweight/obese), appetite_test, plan jsonb, referral_id?, at.
- **paeds_adolescent_assessments**: id, patient_id, encounter_id, headss jsonb (restricted), tanner jsonb, menstrual jsonb, screens jsonb (crafft, phq_a), confidential bool, by, at (ABAC restricted when confidential).
- **paeds_school_camps** (with NC-035): camp_id, school, class, screened_count, findings jsonb, referrals.
- **paeds_neonatal_visits**: patient_id, encounter_id, day_of_life, feeding jsonb, weight_loss_pct, tcb, tsb, bhutani_zone enum(low/low_int/high_int/high), danger_signs text[], plan.
- Enums: `growth_standard`, `dev_domain`, `dev_tool`, `nutrition_class`, `bhutani_zone`.

## 5. Business Rules & Validations

- z-score computed via LMS: z = ((X/M)^L − 1)/(L·S) with WHO adjustments beyond ±3; age in days from DOB; corrected age for GA < 37 wk until 24 months (config 12–24); weight-for-length used < 2 y (or < 87 cm), BMI-for-age ≥ 2 y; charts and z-scores must agree with WHO Anthro reference implementation (test vectors).
- Flags: SAM = WHZ < −3 or MUAC < 11.5 cm or bilateral pitting oedema; MAM = WHZ −3 to −2 or MUAC 11.5–12.5; stunting HAZ < −2; overweight BMI z > +2 (WHO 5–19: > +1 overweight, > +2 obese); growth faltering = downward crossing of 2 major centile lines or weight loss on 2 consecutive visits.
- Weight-based dosing: dose range per drug per age band (mg/kg); computed dose > adult max → cap & warn; weight age ≤ 7 days else prompt; mL rounding 0.1; formulation strength required; contraindicated-by-age hard-stops (aspirin < 16 y unless Kawasaki/RHD indication documented; codeine < 12 y).
- Milestone red flags → automatic referral suggestion & DEIC/RBSK code; M-CHAT medium/high → follow-up interview/referral; assessments attach with score fields mandatory.
- Immunisation view is read-only mirror of OP-013 (single source of truth); vaccine orders go to OP-013 workflow.
- High-risk register: schedule auto-generated at enrolment; missed visit → recall (SMS/call) at +7 days; lost after 3 attempts (audit).
- Neonatal jaundice: Bhutani zone by hours of life; high-intermediate/high → phototherapy/admission prompt (IP-015).
- Consent: guardian identity & relation recorded; adolescent confidential sections restricted (ABAC: treating clinician + designated); POCSO reporting task cannot be dismissed without MS/social-worker action; DPDP verifiable parental consent before parent-app enrolment.
- Immutable signed documents; anthropometry corrections create new rows with `supersedes_id`.

## 6. API Surface (`/api/v1/paeds`)

| Method         | Path                                             | Purpose                                       | Permission                                     | Idem | Pag    |
| -------------- | ------------------------------------------------ | --------------------------------------------- | ---------------------------------------------- | ---- | ------ |
| GET            | /worklist                                        | paeds worklist (vaccine due, high-risk chips) | paeds.visit.read                               | –    | cursor |
| GET/PUT        | /patients/{id}/profile                           | profile/high-risk                             | paeds.profile.read/update                      | Y    | –      |
| POST/GET       | /patients/{id}/anthropometry                     | record/list with z                            | paeds.anthro.record/read                       | Y    | cursor |
| POST           | /growth/zscore (calc)                            | LMS calc                                      | paeds.anthro.read                              | –    | –      |
| GET            | /patients/{id}/growth-chart?indicator=&standard= | chart series + reference curves               | paeds.anthro.read                              | –    | –      |
| POST/GET       | /patients/{id}/milestones, /dev-screens          | development                                   | paeds.dev.record/read                          | Y    | cursor |
| GET            | /patients/{id}/immunisation (proxy OP-013)       | status panel                                  | vaccination.schedule.read                      | –    | –      |
| POST/GET/PATCH | /high-risk, /high-risk/{id}/visits               | follow-up programme                           | paeds.highrisk.manage                          | Y    | cursor |
| POST/GET       | /nutrition, /neonatal-visits                     | assessments                                   | paeds.nutrition.record / paeds.neonatal.record | Y    | cursor |
| POST/GET       | /adolescent                                      | adolescent (restricted)                       | paeds.adolescent.record/read_confidential      | Y    | –      |
| POST           | /rx/dose-calc                                    | mg/kg → mg/mL calc (used by OP-002)           | paeds.rx.calc                                  | –    | –      |
| POST/GET       | /school-camps                                    | camps                                         | paeds.school.manage                            | Y    | cursor |
| GET            | /reports/rbsk?month=, /reports/kpis              | reports                                       | paeds.report.read                              | –    | –      |

## 7. Domain Events (outbox)

- `paeds.anthropometry.recorded` {z, flags} → OP-011 (SAM/MAM), CDSS; `paeds.growth.faltering`, `paeds.milestone.red_flag`, `paeds.dev_screen.high_risk` → referrals; `paeds.highrisk.enrolled|visit_due|missed|lost`; `paeds.neonatal.jaundice_high`; `paeds.child_protection.flag` (restricted); `paeds.visit.signed`; consumes `newborn.registered` (IP-011) → profile, `nicu.discharged` (IP-015) → high-risk enrolment, `vaccine.administered` (OP-013), `vitals.recorded` (OP-007 anthropometry), `visit.no_show`.

## 8. Screens (UI)

1. **Paeds worklist** (desktop): age chips (days/months), vaccine due badge, high-risk star, PEWS colour.
2. **Growth workspace** (desktop/tablet): entry panel (large numeric keypad, unit toggles), instant z/percentile tiles with colour bands, WHO/IAP chart canvas (zoomable, corrected-age toggle, previous points, target height line for parents' heights), print chart for parents; `Ctrl+S`.
3. **Development screen** (tablet): age-filtered milestone checklist with pictures, M-CHAT flow, red-flag banner, referral buttons.
4. **Immunisation panel** (embedded OP-013 view): due/overdue timeline, order-due button.
5. **Newborn/High-risk tracker** (desktop): register with next-due, missed list, checkpoints matrix (ROP/hearing/HINE/dev), outcome capture.
6. **Sick-visit overlay** (desktop): danger-signs banner, protocol templates, weight-based Rx composer showing mg & mL live.
7. **Adolescent confidential section** (lock icon), HEADSS wizard.
8. **Parent app** (phone): growth curves, vaccine card & reminders, milestone tick-list, appointment, education videos; consent-gated.
9. **School camp tablet form** (offline-first).

- Empty/error: no DOB → estimated age prompt; no weight today → Rx composer warning.

## 9. Integrations

- OP-013 (immunisation source of truth, U-WIN), IP-011/IP-015 (birth/NICU records), OP-007 device scales/stadiometers, EN-029 paediatric dose tables (seed from IAP Drug Formulary/BNFc-style ranges — hospital to validate), OP-011 nutrition, OP-025/OP-028 screening, RBSK/DEIC & RKSK reporting formats (CSV/manual, EN-017), EN-011 FHIR (Observation LOINC 29463-7 weight, 8302-2 height, 8287-5 HC, growth percentile extension), parent app (OP-020) with DPDP parental consent.

## 10. Reports & Analytics

- Nutrition status distribution (SAM/MAM/stunting/overweight) by age/area, growth-faltering alerts, immunisation coverage (via OP-013), developmental screening coverage & referral outcomes, high-risk follow-up compliance & 2-y outcomes, neonatal jaundice admissions, RBSK 4D reports, adolescent screening counts, antibiotic AWaRe mix in paeds Rx, visit volumes/seasonality. Read models `analytics.paeds_growth_monthly`, `analytics.highrisk_cohort`.

## 11. Notifications

- Parents (consent-gated, regional language): vaccine due/overdue (OP-013), growth check reminders, high-risk follow-up dates, milestone check prompts, sick-child red-flag advice, camp results. Staff: SAM detected, red-flag milestones, high-risk missed visits, jaundice high zone, child-protection task, weight-based Rx overrides.

## 12. Permissions (RBAC keys)

`paeds.visit.read|sign`, `paeds.profile.read|update`, `paeds.anthro.record|read`, `paeds.dev.record|read`, `paeds.highrisk.manage`, `paeds.nutrition.record`, `paeds.neonatal.record`, `paeds.adolescent.record|read_confidential`, `paeds.rx.calc`, `paeds.school.manage`, `paeds.child_protection.flag|manage`, `paeds.report.read`, `paeds.configure`. Defaults: Paediatrician — all; Nurse — anthro/neonatal/dev.record, highrisk visit entry; Developmental therapist — dev.*; Dietician — nutrition; Social worker — child_protection.manage, highrisk recall; Resident — record no sign; Parent — own child read (portal scope).

## 13. Non-functional

- Volumes: 500 paeds visits/day enterprise (peak season 800), 2 000 anthropometry rows/day, high-risk cohort 1 500 active; z-score calc < 5 ms (server) with LMS cached in Redis and IndexedDB; chart render < 300 ms; dose calc deterministic (unit tests vs reference); offline: growth/milestone/camp forms; print: growth chart (WHO/IAP style, colour), Rx with mL, vaccine card (OP-013); accessibility: pictorial milestone items; i18n parent materials.

## 14. Acceptance Criteria (plus OP-025 §0.9)

1. Given a girl aged 14 months, weight 7.0 kg, length 72 cm, then WAZ/HAZ/WHZ match WHO Anthro reference within ±0.01 and WHZ < −3 flags SAM with nutrition referral prompt.
2. Given a preterm born at 30 weeks now 6 months chronological, then corrected age 3.5 months is used for plotting until 24 months and the chart shows the corrected toggle.
3. Given amoxicillin 45 mg/kg/day BID for a 12 kg child with 250 mg/5 mL syrup, then dose = 270 mg/dose → 5.4 mL BID printed on the Rx in the parent's language.
4. Given aspirin ordered for a 5-year-old without a Kawasaki/RHD indication, then hard-stop; with indication documented, Rx proceeds and audit records.
5. Given no weight recorded in 7 days, when a weight-based drug is prescribed, then a prompt requires today's weight or an override reason.
6. Given milestone "no babbling at 9 months" ticked, then a red-flag banner and referral suggestions (audiology, developmental clinic) appear and RBSK code is set.
7. Given M-CHAT-R score 8, then risk high, follow-up/referral tasks are created and appear in the developmental clinic worklist.
8. Given a NICU discharge event for a 1.4 kg preterm, then a high-risk profile and follow-up schedule (2 wk…24 mo) with ROP/hearing checkpoints are auto-created.
9. Given a high-risk visit missed by 7 days, then recall SMS is sent and the tracker shows "missed"; after 3 attempts status "lost" with audit.
10. Given TSB 15 mg/dL at 48 h of life, then Bhutani zone "high-intermediate/high" per nomogram and an admission/phototherapy prompt shows.
11. Given a 15-year-old's HEADSS confidential section, then a non-designated clinician cannot view it; access is audited.
12. Given a parent has not given verifiable parental consent, then no portal enrolment or WhatsApp growth updates are sent.

## 15. Enhancements / Later phases

- Sheet row 71 (Growth charts, Immunisation, Milestone tracking, NICU follow-up) — core. Market: WHO/IAP z-scores, weight-based mL dosing, developmental screening tools, adolescent & school health.
- Later: bone-age assist (AI-007), AI-005 growth-faltering prediction, wearable/IoT scales in camps (EN-042), DEIC/RBSK portal APIs, tele-paediatrics (OP-018), parent chatbot (AI-001) for sick-child triage, sibling/family linkage views, school-nurse portal.

## 16. Open Questions for the Hospital

1. Growth standard for 5–18 y (WHO 2007 vs IAP 2015)? Corrected-age cut-off?
2. Paediatric dose table source & validation owner (pharmacy/paediatrics)?
3. NICU/high-risk programme schedule & outcomes tracked; ROP/hearing services in-house?
4. Adolescent confidentiality/mature-minor policy; POCSO reporting owner?
5. RBSK/RKSK/school camp involvement; parent app enrolment & consent capture process?
