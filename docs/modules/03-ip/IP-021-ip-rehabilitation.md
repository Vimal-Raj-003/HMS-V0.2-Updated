# IP-021 — IP Rehabilitation (inpatient rehab referral & triage, multidisciplinary rehab plan & goals, bedside/gym session scheduling, daily progress notes, functional scores (FIM/Barthel/Berg/MMT/ROM/6MWT/mRS), discharge goals & home programme, equipment/orthosis, rehab charging)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | IP / Inpatient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Module ID       | IP-021                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase           | 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Depends on      | OP-015 (Physiotherapy/Rehabilitation OPD engine: therapists, modalities, exercise library, session documentation — IP-021 reuses it inpatient), TR-010 (Trauma rehab pathway: FIM/Barthel, return-to-work — shares scoring & goal engine), OP-035 (speech therapy), OP-002 (rehab referral/consult orders), IP-003 (nursing mobilisation tasks, falls risk, pressure care, positioning; therapist notes in patient chart), IP-020 (pathway milestones: mobilise POD1 etc.), IP-002 (discharge planning: home programme, equipment, follow-up OP-015 booking), IP-009/IP-016 (ICU early mobilisation, ventilated patient rehab, HDU), IP-006 (post-op protocols/weight-bearing orders from surgeon), TR-002/TR-005 (fracture/cast constraints), OP-011 (dietician for dysphagia diets with speech), OP-033 (paediatric rehab), IP-005 (session/modality charges, package inclusions IP-008), NC-030 (therapist roster), NC-002/NC-020 (rehab equipment assets, gym), NC-006 (orthosis/consumables), PE-001/PE-003 (home exercise videos), EN-037, EN-024, NC-015 (rehab indicators) |
| Feature flag    | `module.ip_rehab.enabled` (sub-flags: `iprehab.icu_early_mobility`, `iprehab.gym_scheduling`, `iprehab.home_programme_app`, `iprehab.ot_speech`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Primary roles   | Physiotherapist / Occupational therapist / Speech therapist (40), Rehab physician / Physiatrist (6/7), Nurse — Ward/ICU (17/18), Resident (14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Secondary roles | Surgeon/Orthopaedician (9), Intensivist (11), Dietician (39), Counsellor/psychologist (42), Prosthetist-orthotist (custom under 40), Billing (27), Nurse Supervisor (22), Quality (54), Patient/Family (59/60), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Regulatory      | NABH 5th ed. COP.1/COP.2 (multidisciplinary care plan, rehabilitation services), COP.10/COP.16 (rehabilitation & pain: assessment, plan, reassessment, documentation), RPwD Act 2016 (disability certification support/assistive devices), RCI (Rehabilitation Council of India) practitioner registration, IAP/WCPT documentation standards, ICF framework (WHO) for functional goals, DPDP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

## 1. Purpose

IP-021 delivers inpatient rehabilitation as a coordinated service: consult/referral from treating teams, therapist assessment with standardised functional scores, a multidisciplinary rehab plan (PT/OT/speech/psychology) with SMART goals tied to discharge, daily bedside/gym sessions scheduled around ward routines and OT/dialysis, progress notes with objective measures, weight-bearing/precaution enforcement, early mobility in ICU, discharge goals with home programme, equipment/orthosis provisioning and OP-015 follow-up — with automatic charging and outcome metrics (functional gain per day, LOS-efficiency).

## 2. Users & Jobs-to-be-done

- **Physiotherapist/OT/speech therapist** (tablet at bedside/gym; desktop): triage referrals, assess (FIM/Barthel/Berg/MMT/ROM/pain/6MWT/TUG/mRS/GMFCS/dysphagia screens), plan goals, schedule & document sessions (SOAP, exercises, dosage, response), score weekly, prepare home programme, book follow-up.
- **Rehab physician / treating doctor** (desktop/IP-010): order rehab consult with precautions (weight-bearing status, spinal, cardiac limits, ROM limits), review plan, co-sign, adjust; discharge destination decision (home/rehab centre).
- **Nurse**: view precautions and mobility level on banner/handover, carry out mobilisation tasks between sessions, report falls/pain, coordinate session timing.
- **Billing**: session charges by type/duration/modality; package inclusions.
- **Patient/family**: view daily goals, home exercise videos (PE-003), attendant training checklist.

## 3. Core Workflows

### 3.1 Referral, triage & assessment

1. **Doctor** orders rehab consult (OP-002 order type `rehab_referral`: disciplines PT/OT/speech/psychology, diagnosis, urgency (ICU early mobility same day; post-op day 0/1; routine 24 h), **precautions** structured: weight-bearing (NWB/TTWB/PWB %/WBAT/FWB per limb), spinal precautions, ROM limits, cardiac (HR/BP limits), respiratory (SpO2 floor), lines/drains, cognitive/behavioural, isolation, falls risk (Morse from IP-003)) → Event `rehab.referral.created` → therapist queue by ward/discipline (SLA per urgency).
2. **Therapist** initial assessment (template per condition: ortho, neuro/stroke, cardio-pulmonary, ICU, paediatric, geriatric, amputee, spinal cord injury, burns): history, pain (NRS), ROM/MMT grid (joint × movement, side), tone/spasticity (MAS), balance (Berg/TUG), gait (speed, aid), transfers, ADLs (Barthel/FIM 18-item), respiratory (chest assessment, cough, spirometry values), swallowing (speech: GUSS/MASA, diet texture IDDSI recommendation → OP-011), cognition (MoCA/MMSE via OP-034/psych), ICF problem list → **problem list & baseline scores** stored (`rehab_assessments`), risk of falls/dislocation flagged to IP-003.

### 3.2 Multidisciplinary rehab plan & goals

1. **Plan** (`rehab_plans`): disciplines, frequency (e.g., PT BID, OT daily, speech daily), session type (bedside/gym/ICU), interventions library (OP-015 exercise/modality catalogue), **SMART goals** (short-term weekly; discharge goals: e.g., "independent transfers bed→chair by day 5", "walk 50 m with walker by discharge", "safe oral diet IDDSI 5", "Barthel ≥ 70"), precautions carry-over, expected discharge functional level & destination (home/inpatient rehab/SNF), equipment needs (walker, wheelchair, commode, AFO, splints — NC-006 issue/purchase or rental), attendant training plan; co-sign by rehab physician/treating doctor (configurable); reviewed weekly (team conference note) → Event `rehab.plan.created|reviewed`; goals feed IP-020 pathway milestones and IP-002 discharge planning.
2. **ICU early mobility** (`iprehab.icu_early_mobility`): safety screen (haemodynamic/respiratory/neuro criteria per protocol) each session; mobility level scale (ICU Mobility Scale 0–10) charted; ventilated patient sessions with RT/nurse; adverse events (desaturation, line dislodgement) recorded.

### 3.3 Session scheduling & delivery

1. **Scheduling** (`rehab_sessions`): therapist worklist per ward with auto-proposed slots respecting ward routines (meal/med times from IP-003), OT/dialysis/imaging trips (IP-018 temporary-away, IP-022), patient consent/refusal, gym capacity (`iprehab.gym_scheduling`: gym rooms/equipment slots) and transport (IP-001 transport task for gym); therapist roster (NC-030); family attendance option.
2. **Delivery** (tablet, offline-capable): pre-session vitals check vs limits (auto-pull IP-003; block if breach → reschedule with reason), precautions banner, interventions performed (exercise sets/reps/resistance, modalities with dose/duration, gait distance/aid, stairs, ADL training, swallow therapy, chest physio), patient response (RPE/Borg, pain, SpO2/HR post), progress note SOAP, education given, **objective measures** (distance, ROM degrees, MMT grade), photos/videos (consent), time in/out → charge posting (IP-005 by session type/duration/modality; package inclusion IP-008) → Event `rehab.session.completed`; missed session reasons (patient unwell/refused/unavailable/OT/staff) tracked as variance (IP-020).
3. **Nursing coordination**: mobility level & precautions surface on IP-003 banner/handover ("assist ×2 with walker; NWB left"), nursing mobilisation tasks between sessions ("sit out of bed 30 min TID") created from plan; falls (IP-003) auto-notify therapist.

### 3.4 Progress, scores & team conference

- Weekly (or per protocol) **re-scoring** (FIM/Barthel/Berg/6MWT/mRS/ROM) → trend charts, functional gain/day (FIM efficiency), goal attainment (met/partially/not) with plan updates; multidisciplinary conference note (attendees, decisions, discharge date/destination); flags: no improvement 2 weeks → physician review; family meeting.

### 3.5 Discharge & continuity

- **Discharge goals** checklist (IP-002 readiness item "rehab clearance"): mobility level safe for home layout (stairs?), attendant trained (checklist signed), equipment issued/rented (NC-006 issue with charge or vendor), orthosis fitted, **home exercise programme** (OP-015 library → printed multilingual PDF + PE-003 videos, `iprehab.home_programme_app` with adherence log), precautions handout, OP-015 follow-up appointments (auto-book), referral to rehab centre (OP-021/IP-018) where applicable, disability certificate support docs (RPwD) if needed → summary section in discharge summary (IP-002) auto-drafted; Event `rehab.discharge_cleared`.

### 3.6 Exceptions

- Precaution conflict (surgeon changes weight-bearing) → plan auto-flags for revision; sessions blocked until therapist acknowledges.
- Patient refuses ≥ 2 sessions → doctor informed; documented.
- Adverse event during session (fall, desaturation, line issue) → NC-015 incident + doctor notify.
- Therapist shortage → unmet sessions report; supervisor reallocation.

## 4. Data Model (schema `clinical`; shares OP-015 tables where noted)

- **clinical.rehab_referrals** (id, hospital_id, branch_id, admission_id, patient_id, order_id, disciplines jsonb, diagnosis jsonb, urgency enum(icu_same_day/post_op/routine), precautions jsonb {wb: {left, right}, spinal, rom_limits[], cardiac{hr_max,bp_max}, resp{spo2_min}, other[]}, status enum(new/triaged/assessed/active/on_hold/completed/cancelled), assigned_to jsonb {pt, ot, st}, sla_due_at, created_by, created_at) — index (hospital_id, status), (admission_id).
- **clinical.rehab_assessments** (id, referral_id, discipline, type enum(initial/weekly/discharge/adhoc), template_code, at, by, findings jsonb (ROM/MMT grid, tone, balance, gait, ADL items, respiratory, swallow, cognition), scores jsonb [{code(fim/barthel/berg/tug/6mwt/mrs/mas/ims/guss/nrs/gmfcs…), value, components}], icf_problems jsonb, risks jsonb, signed_at, sha256) — append-only.
- **clinical.rehab_plans** (id, referral_id, version, disciplines jsonb, frequency jsonb, session_type, interventions jsonb [{code, params}], goals jsonb [{id, text, measure, target, due, status(open/met/partial/not_met), discipline}], precautions_snapshot jsonb, expected_discharge_level, destination enum(home/rehab_centre/snf/other), equipment jsonb [{item, action(issue/rent/purchase), status}], attendant_training jsonb, cosigned_by?, reviewed_at, next_review_at, status enum(active/superseded/closed)).
- **clinical.rehab_sessions** (id, referral_id, plan_id, discipline, therapist_id, scheduled_at, location enum(bedside/gym/icu/other), gym_slot_id?, transport_task_id?, status enum(scheduled/in_progress/completed/missed/cancelled/blocked), missed_reason?, started_at, ended_at, pre_vitals jsonb, precaution_ack bool, interventions jsonb, response jsonb {borg, pain_post, spo2_post, hr_post}, measures jsonb, note jsonb {s,b?,o,a,p}, education jsonb, media_ids jsonb, adverse_event_id?, charge_line_id?, offline_captured bool, signed_at) — partition monthly; index (therapist_id, scheduled_at), (referral_id, scheduled_at).
- **clinical.rehab_conferences** (referral_id, at, attendees jsonb, summary, decisions jsonb, discharge_date_planned, destination).
- **clinical.rehab_home_programmes** (referral_id, exercises jsonb [{library_id, sets, reps, freq, video_id}], precautions_text, languages jsonb, pdf_file_id, app_enabled bool, adherence jsonb).
- **clinical.rehab_gym_slots** (branch_id, room_id, equipment_id?, starts_at, ends_at, capacity, booked int).
- Reuse OP-015 **clinical.therapy_exercise_library**, **clinical.therapy_modalities**; scores registry shared with TR-010.
- Read models: `analytics.mv_rehab_kpis` (referral→assessment TAT, sessions planned vs delivered, missed reasons, FIM gain & efficiency, Barthel change, LOS by rehab category, discharge destination, falls during therapy).

## 5. Business Rules & Validations

- Referral SLA: ICU/early mobility same day, post-op ≤ 24 h, routine ≤ 48 h; breach → supervisor.
- Precautions are mandatory in referral (structured, not free text only); sessions display and require acknowledgement; changes to precautions (order update) put plan `needs_revision` and block sessions until acknowledged.
- Pre-session vitals must be within limits (from precautions/defaults) — otherwise session `blocked` with reason; ICU sessions require safety screen pass.
- Goals must be measurable (measure + target + due); weekly re-scoring mandatory for active plans; FIM/Barthel at admission & discharge required for outcome reporting.
- Charges post only on `completed` sessions with duration/type; package inclusion checks (IP-008); refused/missed sessions never charged.
- Rehab clearance in IP-002 checklist required when a plan is active (override with reason by treating doctor).
- Documentation append-only, signed by therapist (RCI reg no. on printouts), co-sign rules configurable.
- Media requires consent (EN-028); retention as clinical record.

## 6. API Surface (`/api/v1/ip-rehab`)

| Method         | Path                                                                                                                   | Purpose                | Permission                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------- |
| GET            | `/referrals` (?ward,discipline,status; cursor) ; POST `/referrals` (from CPOE) ; PATCH `/referrals/{id}` (assign/hold) | queue                  | `iprehab.referral.read` / `.manage` |
| POST/GET       | `/referrals/{id}/assessments`                                                                                          | assess/score           | `iprehab.assessment.write`          |
| POST/PATCH/GET | `/referrals/{id}/plans` ; POST `/plans/{id}/cosign` ; POST `/plans/{id}/goals/{gid}/status`                            | plan/goals             | `iprehab.plan.write` / `.cosign`    |
| POST           | `/sessions/schedule` (bulk propose) ; PATCH `/sessions/{id}` ; POST `/sessions/{id}/start                              | complete               | miss                                | block` | sessions | `iprehab.session.write` |
| GET            | `/worklist?therapist=&date=` ; GET `/ward-view?ward=`                                                                  | therapist & ward views | `iprehab.session.read`              |
| GET/POST       | `/gym-slots`                                                                                                           | gym scheduling         | `iprehab.gym.manage`                |
| POST/GET       | `/referrals/{id}/conferences` ; POST/GET `/referrals/{id}/home-programme` ; POST `/referrals/{id}/discharge-clear`     | continuity             | `iprehab.plan.write`                |
| GET            | `/referrals/{id}/scores/trend` ; GET `/reports/kpis`                                                                   | outcomes               | `iprehab.report.read`               |

## 7. Domain Events (outbox)

- `rehab.referral.created|assigned|sla_breached` → therapist queue, supervisor.
- `rehab.assessment.completed` {scores} → IP-003 (falls/mobility banner), IP-020 (goals), TR-010.
- `rehab.plan.created|reviewed|needs_revision` {goals, precautions, equipment} → IP-003 tasks (mobilisation), IP-002 planning, IP-020, NC-006 (equipment), doctor.
- `rehab.session.scheduled|completed|missed|blocked` {duration, type} → IP-005 (charge), IP-020 (variance on missed), IP-001 (transport), NC-015 (adverse).
- `rehab.goal.met|not_met` → IP-020, IP-002 expected discharge.
- `rehab.discharge_cleared` {home_programme_id, equipment, follow_up} → IP-002 checklist, OP-015 booking, PE-001/PE-003.
- Consumed: `rx.order.created` (rehab referral), `ip.transferred`, `ot.case.completed` (post-op day 0 trigger), `nursing.fall.recorded`, `orders.precaution.updated` (OP-002), `ip.discharge.initiated|completed`, `patient.consent.*`.

## 8. Screens (UI)

- **Therapist Worklist** (tablet/desktop; phone summary): today's sessions by ward/time with precaution chips, vitals check button, start/complete; offline documentation queue; `N` next patient, `C` complete.
- **Rehab Chart** (desktop/tablet within patient chart): tabs Referral & Precautions | Assessments (ROM/MMT grid entry with body map, score calculators) | Plan & Goals (goal cards, status) | Sessions timeline | Scores trend charts | Conference notes | Discharge & Home programme (PDF preview, video picker).
- **Ward Rehab View** (nursing station panel): mobility level/precautions per bed, next session, missed sessions.
- **Gym Scheduler** (desktop): rooms/equipment slots grid, drag sessions, transport requests.
- **Family/Patient view** (PE-001): today's goals, exercise videos, attendant training checklist.
- **KPI Dashboard** (desktop).

## 9. Integrations

- OP-015 engine (library, modalities, follow-up booking), TR-010 scores/pathway, OP-002 orders/precautions, IP-003 tasks/banner, IP-020 pathway milestones, IP-005/IP-008 charges/packages, NC-006 equipment issue/rental, NC-030 roster, PE-003 videos, EN-028 media consent, wearable/step-count integration optional (EN-042).

## 10. Reports & Analytics

- Referral TAT & SLA compliance; sessions planned/delivered/missed (reasons); therapist productivity (sessions/units per day); functional gain (FIM/Barthel change, FIM efficiency = gain/LOS days); goal attainment %; ICU early-mobility rate & adverse events; discharge destination; equipment issued; revenue by session type; NABH indicators (rehab assessment ≤ 24/48 h).
- MV: `analytics.mv_rehab_kpis`.

## 11. Notifications

- Push: new referral (discipline queue), SLA breach, precaution change (therapist ack), session blocked (doctor/nurse), no-improvement flag (physician), discharge clearance pending (IP-002), home programme published (patient PE-001).
- No SMS clinical content; follow-up appointment reminders via OP-015/PE-002.

## 12. Permissions (RBAC keys)

`iprehab.referral.read` (40, 7–14, 17, 18, 22), `iprehab.referral.manage` (40 lead, 22), `iprehab.assessment.write` (40), `iprehab.plan.write` (40), `iprehab.plan.cosign` (6/7 rehab physician, 9, 11), `iprehab.session.write` (40), `iprehab.session.read` (clinical, 27), `iprehab.gym.manage` (40 lead, 3), `iprehab.report.read` (40 lead, 22, 54, 4, 58).

## 13. Non-functional

- 2000-bed site: 400–700 active rehab referrals, 1200 sessions/day, 60–100 therapists; worklist p95 < 200 ms; offline session documentation with sync; media uploads background.
- Print: home programme PDF (multilingual, pictograms), assessment forms; accessibility: large controls for tablet at bedside; ROM grid keyboard entry.

## 14. Acceptance Criteria

1. Given a surgeon orders PT referral post-TKR with WBAT right and ROM limit 0–90°, then the referral appears in the PT queue with SLA ≤ 24 h, and precautions display on the therapist worklist and IP-003 banner.
2. Given the surgeon later changes to NWB right, then active plan becomes `needs_revision`, sessions are blocked until the therapist acknowledges, and a push is sent.
3. Given pre-session vitals HR 128 with cardiac limit HR ≤ 120, when starting a session, then the system blocks with reason and offers reschedule; the block is logged.
4. Given a completed 30-min gym session, then a charge posts to IP-005 per tariff and the session appears in the ward view; a missed session with reason "OT" is not charged and creates an IP-020 variance if enrolled.
5. Given weekly re-scoring, then FIM trend chart shows admission vs current and FIM efficiency is computed at discharge.
6. Given discharge initiated with an active plan, then IP-002 checklist shows "rehab clearance" pending until the therapist completes home programme, equipment status and follow-up booking.
7. Given ICU early mobility session, then safety screen must pass and IMS level recorded; an adverse event creates NC-015 incident and notifies intensivist.
8. Given a therapist without `iprehab.plan.cosign`, when co-signing, then 403 and audit.

## 15. Enhancements / Later phases

- Wearable/step-count & robotic device integration (EN-042), tele-rehab (OP-018), AI gait analysis (AI-007), outcome benchmarking (UDSMR-style) across branches (EN-041), disability certificate workflow (RPwD/UDID portal), prosthetics workshop inventory, cardiac/pulmonary rehab programmes with phase tracking (OP-029/OP-030).

## 16. Open Questions for the Hospital

1. Disciplines available inpatient (PT/OT/speech/psychology/prosthetics), staffing per ward, gym facilities?
2. Referral urgency SLAs and whether all post-op/ICU patients get automatic referral (pathway-driven)?
3. Scoring instruments preferred (FIM licence? Barthel, Berg, IMS) and reassessment frequency?
4. Session charging model (per session/duration/modality; package inclusions) and equipment rental practice?
5. Co-sign requirement for plans; RCI registration numbers on documents?
6. Home programme delivery: printed multilingual PDF, app videos, WhatsApp?
