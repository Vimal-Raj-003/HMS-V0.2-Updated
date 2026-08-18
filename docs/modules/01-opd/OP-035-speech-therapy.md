# OP-035 — Speech-Language & Swallow Therapy (Swallow/dysphagia assessment, Articulation/language/voice/fluency assessment, Session notes, Home programme, Progress tracking, AAC)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-035 |
| Phase | 8 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | **OP-025 §0 (shared specialty console framework)**, OP-002 (referral orders), OP-015 (shared therapy scheduling/session engine, therapist calendar, packages), TR-010 (trauma/TBI rehab pathway; FIM communication/swallow items), OP-028 (ENT: laryngoscopy/FEES, hearing), OP-033 (paediatric developmental delay, autism, cleft), OP-034 (dementia dysphagia), IP-003/IP-009 (inpatient dysphagia screening post-stroke, NPO orders, diet texture orders), OP-011/NC-033 (IDDSI texture-modified diets to kitchen), OP-008 (VFSS/MBS fluoroscopy scheduling & dose), OP-010 (FEES as procedure), OP-032 (psychology), OP-021 (referrals), EN-039 (assessment forms), EN-030 (PROMs: VHI, EAT-10, SWAL-QOL), OP-023/OP-005 (therapy packages/sessions billing), OP-018 (tele-therapy), OP-020 (home programme app), OP-038 (education videos), PE-002 (recall), NC-006 (AAC devices/consumables) |
| Feature flag | `module.speech_therapy.enabled` (sub: `slp.dysphagia`, `slp.paeds`, `slp.voice_lab`, `slp.tele`) |
| Primary roles | Speech-Language Pathologist / Audiologist-SLP (40: `speech_therapist`), Therapy assistant, Resident/intern |
| Secondary roles | ENT (6), Neurologist/physiatrist, Paediatrician, Dietician (39), Ward nurse (17, IP swallow screen), Reception (24, session booking), Billing (27), Patient/caregiver |
| Regulatory | RCI registration (SLPs), NABH (rehab services, dysphagia safety), IDDSI framework 2019 (diet/fluid levels), AERB (VFSS via OP-008), RPwD Act (speech & language disability certification), RBSK/DEIC (paediatric), DPDP |

## 1. Purpose
OP-035 provides the SLP record: referral triage, **standardised assessments** — swallowing (clinical bedside swallow evaluation, water swallow tests, GUSS/MASA, EAT-10, IDDSI trial levels; instrumental FEES/VFSS results with Penetration-Aspiration Scale, DOSS/FOIS), articulation/phonology, language (aphasia — WAB/BDAE-style, paediatric language milestones, ELDS/REELS), voice (GRBAS/CAPE-V, acoustic measures import, VHI), fluency (SSI, %SS), motor speech (dysarthria/apraxia), cognitive-communication, AAC needs — **goal-based therapy plans**, session documentation with progress metrics, home programmes (app/printed), IDDSI diet recommendations to kitchen/ward, tele-therapy, and outcome tracking. Scheduling, packages and session billing reuse OP-015's therapy engine; console behaviours per OP-025 §0.

## 2. Users & Jobs-to-be-done
- **SLP** (desktop/tablet; 12–20 sessions/day + 4–6 assessments): assess, set SMART goals, run sessions with data collection (trials/accuracy), update plans, recommend diet textures, counsel caregivers, report outcomes, discharge.
- **Therapy assistant**: session set-up, materials, home-programme printing, attendance.
- **Ward nurse**: bedside swallow screen (post-stroke) → SLP referral; execute IDDSI orders.
- **Caregiver/patient**: home exercises with video, practice logs, tele-sessions.

## 3. Core Workflows
### 3.1 Referral & assessment
1. Referral (OP-021/OP-002/IP order) with reason (dysphagia, aphasia, delay, voice…) → SLP triage (urgent for dysphagia/NPO decisions ≤ 24 h IP) → appointment via OP-015 scheduler.
2. Console tabs: Assessment · Goals & Plan · Sessions · Swallow/Diet · Home programme · Outcomes.
3. **Swallow assessment** (`slp.dysphagia`): history, oral-motor exam (cranial nerves), clinical trials by IDDSI level (0 thin → 7 regular; each: signs of aspiration — cough, wet voice, SpO2 drop, delayed swallow), water swallow test (3-oz/GUSS), EAT-10, recommendation (IDDSI food/fluid levels, postures/manoeuvres, feeding strategies, NPO/alternative nutrition → dietician), instrumental need (FEES via OP-010/OP-028, VFSS via OP-008 with structured report: PAS 1–8, residue, timing) → **IDDSI diet order** transmitted to kitchen/ward (NC-033/IP-003) & FOIS score → `slp.swallow.assessed`.
4. **Speech/language/voice/fluency assessment**: age-appropriate tool selection (paediatric: milestones/REELS/ELDS, articulation test with phoneme inventory & error patterns; adult: aphasia battery, dysarthria profile, apraxia; voice: perceptual GRBAS/CAPE-V, MPT s/z ratio, acoustic F0/jitter/shimmer import (`slp.voice_lab` software CSV), VHI; fluency: %SS, SSI-4, OASES), cognitive-communication, hearing status (OP-028), AAC candidacy → severity ratings, diagnosis (ICD-10 R13 dysphagia, R47/F80 speech-language, R49 voice, F98.5 stuttering, R48.2 apraxia), report PDF.
### 3.2 Goals & therapy plan
- SMART goals per domain (baseline, target, criteria e.g. "produce /k/ in initial position with 80 % accuracy across 3 sessions"), frequency/duration, planned sessions (package OP-023), techniques (e.g. Shaker, Mendelsohn, LSVT-style loudness, PROMPT, melodic intonation, fluency shaping), caregiver training, home programme, discharge criteria; plan signed → sessions scheduled (OP-015 engine).
### 3.3 Sessions & data
- Session note (SOAP-lite): attendance, activities, **trial data** (targets × attempts × correct → % accuracy auto), cueing level, patient response, homework, caregiver present, duration/units, next focus → progress charts per goal (accuracy over sessions); missed sessions and reasons; group sessions (aphasia/fluency groups); tele-sessions (OP-018) with same note; billing per session/package via OP-015.
### 3.4 Home programme & tele
- Assign exercises from library (video/pictures OP-038, IDDSI recipes), frequency; patient/caregiver app logs practice (adherence %), uploads videos for review; reminders; SLP feedback.
### 3.5 Outcomes & discharge
- Re-assessment at intervals (goal review every N sessions), outcome measures (FOIS, IDDSI level change, PAS, VHI change, %SS, language scores, TR-010 FIM communication/swallow items), discharge summary with maintenance programme, referral back; disability certificate support (RPwD speech/language).
### 3.6 Exceptions
- Aspiration signs during trial → stop, SpO2 monitor, NPO recommendation & doctor alert (IP); patient with tracheostomy → specific protocol; child non-compliant → play-based re-book; tele quality poor → convert to in-person; offline: assessment/session forms cached.

## 4. Data Model (schema `specialty`)
- **slp_episodes**: id, hospital_id, branch_id, patient_id, referral_id?, domains text[] (swallow/artic/language/voice/fluency/motor_speech/cognitive_comm/aac), setting enum(op/ip/tele/home), lead_therapist_id, status enum(triaged/assessing/active/on_hold/discharged), package_booking_id?, opened_at, closed_at; index (hospital_id, patient_id, status).
- **slp_assessments**: id, episode_id, encounter_id, type enum(swallow_clinical/fees/vfss/artic/language/voice/fluency/motor_speech/cog_comm/aac/reassess), tools jsonb ([{tool, raw, standard_score, percentile}]), swallow jsonb (oral_motor, trials [{iddsi_level, signs[]}], gugs/masa, eat10, recommendation {food_level, fluid_level, strategies, npo}, fois, pas), voice jsonb (grbas, cape_v, mpt, sz_ratio, acoustics{f0, jitter, shimmer}, vhi), fluency jsonb (pct_ss, ssi, oases), language jsonb, artic jsonb (phoneme_inventory, error_patterns), severity, dx_codes text[], report_doc_id, form_response_id, signed_by/at, version; index (episode_id, at).
- **slp_diet_orders**: id, patient_id, episode_id, admission_id?, food_level smallint (3–7), fluid_level smallint (0–4), strategies jsonb, npo bool, effective_from, ended_at, ordered_by, ack_by_kitchen_at, ack_by_ward_at; index (patient_id, effective_from desc).
- **slp_goals**: id, episode_id, domain, description, baseline, target, criteria, status enum(active/met/modified/discontinued), start_at, met_at.
- **slp_plans**: id, episode_id, version, goals uuid[], frequency, planned_sessions, techniques jsonb, home_programme_id, discharge_criteria, signed_by/at.
- **slp_sessions** (uses OP-015 `therapy_sessions` shell + extension): session_id, episode_id, goals_worked jsonb ([{goal_id, trials, correct, accuracy_pct, cue_level}]), activities, response, homework, caregiver_present bool, tele bool, duration_min, units, note, by, at; index (episode_id, at).
- **slp_home_programmes**: id, episode_id, items jsonb ([{exercise_id, freq, notes}]), version; **slp_home_logs** (patient scope): programme_id, at, item, done bool, video_key?, comment.
- **slp_outcomes**: episode_id, at, measures jsonb (fois, iddsi_food, iddsi_fluid, pas, vhi, pct_ss, language_score, fim_comm, fim_swallow), by.
- **slp_exercise_library** (mdm): id, hospital_id?, code, name, domain, media refs (OP-038), instructions (i18n).
- Enums: `slp_domain`, `slp_assessment_type`, `goal_status`.

## 5. Business Rules & Validations
- IDDSI levels validated (food 3–7, fluids 0–4; transitional foods flag); diet order changes require SLP or physician; kitchen/ward acknowledgement tracked; NPO recommendation triggers dietician & physician notification; discrepancy between diet order and kitchen dispatch → NC-033 alert.
- Aspiration signs in ≥ 1 trial → recommendation cannot be "regular thin" without instrumental evidence/override reason.
- Trial accuracy = correct/trials; goal met when criteria satisfied across configured sessions (auto-suggest).
- Sessions billed by units (15-min) or per session per OP-015 policy; package session decrement; no-show policy.
- Paediatric assessments require caregiver consent; standard scores require age (months) & test norms version.
- Voice acoustic import requires calibrated device (config); values outside physiological range flagged.
- Reports/plans immutable after sign; re-assessment creates new version; retention clinical; disability certificate only by authorised SLP/ENT.

## 6. API Surface (`/api/v1/slp`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /worklist, /referrals | SLP worklist/triage | slp.episode.read | – | cursor |
| POST/GET/PATCH | /episodes, /episodes/{id} | episode | slp.episode.create/read/update | Y | cursor |
| POST/PUT/GET | /episodes/{id}/assessments, /assessments/{id}/sign | assessments | slp.assessment.record/sign/read | Y | cursor |
| POST/GET/PATCH | /diet-orders, /diet-orders/{id}/ack | IDDSI orders | slp.diet.order / kitchen.ack | Y | cursor |
| POST/PATCH/GET | /episodes/{id}/goals, /plans, /plans/{id}/sign | goals & plan | slp.plan.manage/sign | Y | – |
| POST/GET | /episodes/{id}/sessions | session data (via OP-015 shell) | slp.session.record/read | Y | cursor |
| POST/GET | /episodes/{id}/home-programme, /home-logs (patient scope) | home programme | slp.home.manage / patient | Y | cursor |
| POST/GET | /episodes/{id}/outcomes, /discharge | outcomes | slp.outcome.record | Y | – |
| GET | /library/exercises | exercise library | slp.episode.read | – | cursor |
| GET | /reports/kpis | KPIs | slp.report.read | – | – |

## 7. Domain Events (outbox)
- `slp.referral.triaged`, `slp.swallow.assessed` {fois, levels, npo}, `slp.diet_order.created|changed` → NC-033/IP-003, OP-011; `slp.aspiration.risk` → ward/physician; `slp.plan.signed`, `slp.session.recorded` {accuracy}, `slp.goal.met`, `slp.home.adherence_low`, `slp.outcome.recorded`, `slp.episode.discharged` → TR-010/OP-021 feedback.
- Consumes: `referral.created`, `nursing.swallow_screen.failed` (IP-003), `procedure.completed` (FEES), `rad.report.final` (VFSS), `therapy.session.completed` (OP-015 shell), `package.session.consumed`.

## 8. Screens (UI)
1. **SLP worklist** (desktop): referrals by urgency (IP dysphagia red), today's sessions, adherence chips.
2. **Swallow assessment** (tablet at bedside/clinic): IDDSI trial grid with sign toggles, SpO2 field, recommendation builder → diet order send; FEES/VFSS results panel (PAS picker, images from OP-022/PACS).
3. **Speech/language/voice assessment forms** (desktop/tablet): tool pickers, score calculators, phoneme inventory grid, acoustic import, report preview.
4. **Goal & plan builder** (desktop): SMART goal templates, criteria, session count, home programme picker.
5. **Session data collector** (tablet): per-goal tally counters (`+`/`−` keys), cue level, timer, quick note; progress sparkline; `Ctrl+Enter` sign.
6. **Home programme & caregiver app** (phone): videos, daily tick, upload video, reminders.
7. **Outcomes dashboard**: goal accuracy trends, FOIS/IDDSI/VHI change, discharge summary.
- Real-time: IP diet order acknowledgement status; empty states with templates.

## 9. Integrations
- OP-015 therapy engine (scheduling, sessions, packages, billing), NC-033 kitchen (IDDSI order feed & dispatch reconciliation), IP-003 nursing (swallow screen, diet order display, NPO), OP-008 VFSS (fluoro study, dose), OP-010/OP-028 FEES, voice-lab software CSV import (Praat/CSL exports), OP-018 tele, OP-038 media library, TR-010 FIM, EN-011 FHIR (NutritionOrder for IDDSI; Observation for scores), RPwD certificate.

## 10. Reports & Analytics
- Referral-to-assessment TAT (IP dysphagia ≤ 24 h %), sessions delivered/planned, attendance & no-show, goal attainment rate, outcome change (FOIS/IDDSI/VHI/%SS), aspiration pneumonia in dysphagia cohort (IP-012 link), home adherence, tele share, therapist productivity/units, package utilisation & revenue. Read model `analytics.slp_monthly`.

## 11. Notifications
- Patient/caregiver: session reminders, home practice reminders, tele links, diet texture instructions (pictorial). Staff: urgent IP referrals, aspiration risk alerts, diet order unacknowledged 2 h, low adherence, goal review due, package sessions ending.

## 12. Permissions (RBAC keys)
`slp.episode.create|read|update`, `slp.assessment.record|sign|read`, `slp.diet.order`, `slp.plan.manage|sign`, `slp.session.record|read`, `slp.home.manage`, `slp.outcome.record`, `slp.report.read`, `slp.configure`, `kitchen.ack` (NC-033 role). Defaults: SLP — all; Assistant — session.record (assist), home.manage; Ward nurse — diet order read/ack, screen entry; ENT/physician — read + diet.order (physician override); Patient/caregiver — home logs.

## 13. Non-functional
- Volumes: 150 sessions/day enterprise, 30 assessments/day, IP dysphagia consults 20/day; tally counters offline-capable; diet order propagation to kitchen < 5 s; video uploads resumable; print: assessment report, IDDSI diet card (pictorial, regional languages), home programme sheets; accessibility: large controls; i18n.

## 14. Acceptance Criteria (plus OP-025 §0.9)
1. Given a clinical swallow trial at IDDSI level 0 shows cough and wet voice, then recommending "level 0 thin" requires instrumental evidence or override reason; recommending level 2 fluids/level 5 food creates a diet order sent to kitchen/ward.
2. Given an IP diet order created, then IP-003 shows the IDDSI card on the nursing board and kitchen must acknowledge; no ack in 2 h → alert.
3. Given a goal "80 % accuracy across 3 sessions", when three consecutive sessions log ≥ 80 %, then the goal is auto-suggested as met and progress chart shows the trend.
4. Given a session recorded via tele (OP-018), then it decrements the package and bills per tele policy.
5. Given VFSS reported PAS 6 by radiology, then the assessment panel displays it and the SLP recommendation form pre-fills instrumental evidence.
6. Given a paediatric assessment without caregiver consent, then sign is blocked.
7. Given a home programme with daily items, when adherence < 50 % over 2 weeks, then the SLP receives a low-adherence flag.
8. Given a therapy assistant tries to sign an assessment, then 403 and audit.
9. Given an IP referral flagged urgent, when not assessed in 24 h, then escalation to SLP lead.
10. Given episode discharge, then outcomes summary (FOIS 3 → 6, VHI change) is generated and referral feedback sent to referrer (OP-021).

## 15. Enhancements / Later phases
- Sheet row 75 (Swallow assessment, Articulation, Session notes, Progress) — core. Market: IDDSI kitchen integration, home programme app, tele-therapy, voice acoustic import.
- Later: AI-004 speech analysis (articulation/fluency scoring from audio), AAC device management & vocabulary boards, aphasia apps integration, group tele-therapy, cleft team MDT board (with OP-026/OP-028), school-based programmes (OP-033).

## 16. Open Questions for the Hospital
1. SLP staffing, IP dysphagia service hours; instrumental capabilities (FEES/VFSS)?
2. Kitchen IDDSI capability & dispatch process (NC-033)?
3. Assessment tools/norms licensed (WAB, REELS, SSI); voice lab software?
4. Session billing (units vs session), packages, tele-therapy policy?
5. Disability certification role?
