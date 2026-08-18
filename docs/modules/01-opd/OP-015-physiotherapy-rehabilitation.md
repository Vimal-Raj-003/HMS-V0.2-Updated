# OP-015 — Physiotherapy / Rehabilitation (Referral, Assessment, Treatment plans, Session scheduling, Exercise library, Progress tracking, Equipment log, Billing)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-015 |
| Phase | 8 (referral + session basics needed by Phase 6 ortho; full console Phase 8) |
| Priority | P1 |
| Complexity | Medium |
| Depends on | OP-009 (ortho referrals with precautions), TR-010 (trauma rehab pathway: FIM/Barthel milestones, return-to-work), OP-002 (doctor referral/orders), OP-001 (appointments/queue), OP-021 (referral tracking/TAT), IP-021 (IP rehab shares session/plan model), IP-003 (ward physio requests), IP-009 (ICU chest physio/early mobilisation), OP-016 (pain clinic), OP-017 (wound), OP-035 (speech), OP-034 (geriatric fall programme), OP-029/OP-030 (cardiac/pulmonary rehab), OP-040 (antenatal/postnatal physio), NC-020 (equipment assets/PM), NC-006 (consumables: tape, TENS pads), OP-005 (session/package billing OP-023), EN-002 (insurance for physio sessions), EN-039 (assessment forms), EN-009 (reminders/HEP), PE-001/OP-020 (home exercise programme, adherence), EN-030 (PROMs), EN-042 (device data: BTE/isokinetic, later), NC-030 (therapist roster) |
| Feature flag | `module.physio.enabled` (sub: `physio.hep_app`, `physio.equipment_log`, `physio.group_sessions`) |
| Primary roles | Physiotherapist / Occupational therapist (40), Rehab assistant |
| Secondary roles | Ortho/Neuro/Physician (6/9, refer & review), Receptionist (24), Billing (27), Nurse — Ward (17), Biomedical (48), Patient (app), Quality (54), Rehab HOD (5) |
| Regulatory | NABH 5th ed. COP (rehabilitation services: assessment, goals, documented plan & progress, informed consent for modalities), National Commission for Allied & Healthcare Professions Act 2021 (therapist registration), electrotherapy device safety (BIS/IEC 60601), AERB not applicable; DPDP; insurance (IRDAI: physio session coverage rules), ICF (WHO functional classification) coding for goals, RTW certificates (Employees' Compensation Act) |

## 1. Purpose
OP-015 runs the physiotherapy/rehabilitation department for OP and IP: intake of structured referrals with precautions, standardised assessments (pain, ROM, MMT, functional scores, balance/gait), goal-oriented treatment plans built from an exercise & modality library, session scheduling with therapist/equipment/room resources, session documentation with per-visit outcome tracking, home exercise programmes delivered to the patient app with adherence tracking, equipment usage & maintenance logs, and package/session billing — the "TRAUMA REHAB critical" P1 module feeding TR-010 milestones back to surgeons.

## 2. Users & Jobs-to-be-done
- **Physiotherapist** (tablet at plinth/desktop; 15–25 sessions/day; documentation ≤ 3 min/session): review referral & precautions, assess, set SMART goals, plan, deliver session (exercises/modalities/manual therapy), record response, prescribe HEP, discharge with outcome & summary to referrer.
- **Rehab assistant**: run modality timers (IFT/US/TENS/traction), equipment prep, log usage.
- **Receptionist**: book session series (e.g. 10 sessions, alternate days), package sales, reminders, waitlist.
- **Referring doctor**: send referral, see progress notes/outcomes, sign RTW.
- **Patient** (app): view HEP videos, log adherence/pain, book/reschedule.
- **HOD/Quality**: therapist productivity, outcome improvements, TAT, cancellations, equipment downtime.

## 3. Core Workflows
### 3.1 Referral & intake
1. Doctor refers (OP-002/OP-009/IP) with: diagnosis (ICD-10), procedure/injury date, **precautions** (weight-bearing status, ROM limits, hip precautions, spinal precautions, cardiac limits, wound status), goals, urgency, sessions suggested, IP/OP → OP-021 referral record → physio queue (`referral.created` target physio) with TAT SLA (OP ≤ 24 h, IP ≤ 4 h, ICU ≤ 2 h). Self-referral/walk-in allowed if policy (direct-access screening form).
2. Receptionist/therapist accepts, assigns therapist (specialty: ortho/neuro/cardio-pulm/paeds/women's health/sports/geriatric), books initial assessment slot; consent for treatment (EN-028) incl. electrotherapy contraindication screen (pacemaker, pregnancy, malignancy, metal implants for SWD, epilepsy).
### 3.2 Assessment
1. Forms (EN-039 seeded by domain): subjective (history, pain NRS/VAS, aggravating/easing, red flags), objective: observation/posture, ROM (goniometry per joint, degrees), MMT (MRC 0–5) per muscle group, special tests, neuro (tone, reflexes, sensation, coordination), balance (Berg, TUG, Tinetti), gait (speed, aids), function (Barthel, FIM (TR-010), Oswestry/NDI, DASH, LEFS, KOOS, Harris (shared with OP-009 PROMs), 6MWT, Borg), respiratory (RR, SpO2, auscultation, cough), paeds (GMFM), cardiac rehab (METs, risk stratification), women's health (pelvic floor grading), swelling (circumference), wound status link (OP-017).
2. Clinical impression (ICF-coded body function/activity/participation), problem list, **SMART goals** (short/long term with target metric & date), rehab potential, plan frequency/duration; reassessment schedule (every 5–6 sessions or 2 weeks) → sign. Event `physio.assessment.recorded`.
### 3.3 Treatment plan & exercise library
1. Plan builder: choose protocol template (post-TKR week 1–2, ACL phase I–IV, rotator cuff repair, stroke UL/LL, LBP McKenzie, COPD pulm rehab, post-MI cardiac rehab phase II, DDH paeds, antenatal, vestibular…) → per-session items: **exercises** from library (name, video/GIF, muscle group, position, sets×reps/hold, resistance/band colour, progression rules), **modalities** (IFT/TENS/US/LASER/SWD/hot-cold pack/traction/EMS/shockwave with parameters, duration, contraindication checks), manual therapy (Maitland grades, MET, mobilisation), gait/balance/functional training, taping, dry needling (if credentialed), education; per-item duration → session length; equipment/room requirement.
2. **Home exercise programme (HEP)**: subset of exercises with pictures/videos in patient language → PDF + patient app (OP-020/PE-001) with reminders, adherence log & pain/difficulty feedback; therapist sees adherence.
3. Precautions from referral pinned; contraindicated modality vs patient flags → block/override.
### 3.4 Scheduling
1. Session series booking (N sessions, days pattern, preferred therapist/time), resource check (therapist roster NC-030, room/cubicle, equipment e.g. CPM/treadmill/traction unit — exclusion constraint), group sessions (cardiac/pulm/antenatal classes, `physio.group_sessions`), IP bedside slots (ward rounds list), package purchase (OP-023: 10-session pack with validity) & insurance pre-auth (EN-002) → confirmation + reminders D-1/2 h; waitlist auto-fill on cancellations; no-show tracking.
### 3.5 Session documentation
1. Check-in (token EN-006 for OP; bedside for IP) → therapist opens session: pre-session pain/vitals (SpO2/HR for cardio-pulm), items delivered (tick/adjust from plan; add), parameters (modality settings, load, reps), response (pain post, tolerance, adverse events e.g. dizziness/fall/skin burn → NC-015), progression notes (SOAP), time in/out, equipment used (auto usage log), consumables (NC-006), patient education; co-treatment; sign (`Ctrl+Enter`). Event `physio.session.completed` → billing (per session/package decrement/IP charge), referrer progress feed.
2. **Reassessment** every N sessions: outcome measures re-scored → progress charts (ROM/strength/function/pain vs goals) → goals met/revised; plan adjust; referrer notified with summary.
3. **Discharge**: outcome summary (baseline vs final scores, goals achieved %, HEP continuing, RTW/return-to-sport recommendation, certificate via referrer), sent to referrer & MRD; TR-010 milestones updated; PROM follow-up at 3 months (EN-030).
### 3.6 Equipment log
- Equipment master (NC-020 assets: IFT, US, TENS, SWD, LASER, traction, CPM, treadmill, cycle ergometer, tilt table, parallel bars, shockwave, isokinetic) with location, PM/calibration schedule, daily safety check; **usage log** auto from sessions (patient, minutes, parameters) → utilisation, breakdown → NC-020 ticket, sessions auto-rescheduled/re-equipped; consumables (electrodes/gel) tracked.
### 3.7 Exceptions
- Adverse event → session aborted, incident, doctor informed; precautions violated attempt → block; package expiry → extension approval (OP-023); IP patient unavailable (in OT/radiology) → session missed with reason (not billed); offline: tablet caches today's plan & session forms; sync with idempotency.

## 4. Data Model (schema `specialty`)
- **physio_referrals** (view over OP-021 `referrals` + physio fields): id, hospital_id, branch_id, patient_id, referral_id, source enum(opd/ip/icu/er/self/external), referring_doctor_id, diagnosis_icd10, injury_or_surgery_date, precautions jsonb ({weight_bearing, rom_limits, hip/spinal precautions, cardiac_limits, wound}), goals_text, sessions_suggested, urgency, status enum(new/accepted/assessed/in_treatment/on_hold/discharged/rejected), assigned_therapist_id, sla_due_at, accepted_at; index (hospital_id, status, sla_due_at).
- **physio_assessments**: id, hospital_id, patient_id, referral_id, encounter_id?, admission_id?, type enum(initial/reassessment/discharge), form_response_id, pain jsonb, rom jsonb, mmt jsonb, balance jsonb, gait jsonb, function_scores jsonb ({instrument, score}), respiratory jsonb, icf_codes text[], problems text[], impression, rehab_potential, therapist_id, signed_at, version; index (patient_id, created_at).
- **physio_goals**: id, assessment_id, patient_id, description, icf_code?, metric, baseline, target, target_date, status enum(active/met/partially_met/not_met/revised), achieved_at.
- **exercise_library** (mdm; hospital + global seed): id, hospital_id?, code, name, local_names jsonb, body_region, category enum(strength/rom/stretch/balance/gait/cardio/neuro/breathing/pelvic/functional), position, instructions, media_keys jsonb (image/video, multilingual captions), default_dose jsonb (sets, reps, hold_s, resistance), progression jsonb, contraindications text[], is_active.
- **modality_master**: id, code, name, parameters_schema jsonb, contraindications text[], equipment_type, default_duration_min, chargeable_service_id.
- **physio_protocol_templates**: id, hospital_id, name, condition_tags, phases jsonb ([{name, from_day, to_day, items:[...]}]), frequency, sessions, version.
- **physio_plans**: id, hospital_id, patient_id, referral_id, assessment_id, template_id?, phase, items jsonb ([{type: exercise|modality|manual|functional|education, ref_id, dose, duration_min, equipment_type}]), sessions_planned, frequency, precautions_snapshot jsonb, hep_items jsonb, status enum(active/completed/on_hold), therapist_id, version.
- **physio_sessions**: id, hospital_id, branch_id, patient_id, plan_id, referral_id, appointment_id?, admission_id?, scheduled_at, therapist_id, assistant_id?, room_id?, equipment_ids uuid[], group_session_id?, status enum(scheduled/checked_in/in_progress/completed/no_show/cancelled/missed_ip), started_at, ended_at, pre jsonb (pain, vitals), items_delivered jsonb, response jsonb, adverse_event jsonb?, soap text, consumables jsonb, session_no, package_id?, bill_item_id?, signed_at; index (hospital_id, branch_id, scheduled_at), (plan_id, session_no); exclusion (therapist_id, tstzrange) & per equipment.
- **physio_hep_adherence** (patient app): plan_id, patient_id, date, items_done jsonb, pain, difficulty, comments.
- **physio_equipment_usage**: id, equipment_id (NC-020 asset), session_id, minutes, parameters jsonb, at; **physio_equipment_checks**: equipment_id, date, checked_by, ok bool, issues, ticket_id?.
- **physio_discharges**: id, referral_id, patient_id, final_assessment_id, outcomes jsonb (baseline vs final), goals_met_pct, hep_continue bool, rtw jsonb, summary_doc_id, sent_to_referrer_at.
- **physio_group_sessions**: id, name, type, schedule, capacity, therapist_id, attendees jsonb.

## 5. Business Rules & Validations
- Referral required for treatment unless direct-access policy enabled (screening form mandatory then); referral SLA timers per source; overdue → HOD alert (OP-021 engine).
- Precautions snapshot copied to plan and shown on every session; item conflicting with precautions (e.g. resisted knee flexion under "no resisted flexion 6w") → block unless override reason.
- Modality contraindication check against patient flags (pacemaker → no IFT/TENS over chest; pregnancy → no SWD/US abdomen; malignancy; metal implants → no SWD; impaired sensation → thermal caution) → hard block/override per severity.
- Initial assessment before first treatment session (except ICU/urgent chest physio protocol); reassessment due every 6 sessions/2 weeks (config) → session save warns/blocks after +2 sessions overdue.
- Session documentation must include items delivered, duration, response; sign within same day; billing posts on sign (per session tariff/payer; package decrement; IP daily physio charge or per session per policy); no-show/missed IP not billed; late cancel fee per policy.
- Package sessions valid N days (OP-023); expired → approval; insurance session caps tracked (pre-auth EN-002).
- Adverse events → NC-015 incident; falls during therapy also into IP-003 fall register if IP.
- Discharge summary mandatory to close referral; goals status recorded; outcome measures require baseline & final of the same instrument.
- Equipment: daily safety check before first use (block usage if failed), PM due → warning, breakdown → cannot be scheduled.
- Records versioned; therapist registration number (NCAHP) stored on profile and printed on summaries.

## 6. API Surface (`/api/v1/physio`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /referrals?status=&therapist=&source= | queue with SLA | physio.referral.read | – | cursor |
| POST | /referrals/{id}/accept, /assign, /reject, /hold | triage | physio.referral.manage | Y | – |
| POST | /assessments | initial/reassessment/discharge assessment | physio.assessment.create | Y | – |
| GET | /patients/{id}/assessments, /goals, /progress | history & charts | physio.assessment.read | – | cursor |
| POST/PATCH | /goals | goals | physio.plan.update | Y | – |
| GET/POST/PUT | /library/exercises, /library/modalities, /protocols | masters | physio.configure (write), physio.plan.read (read) | Y | cursor |
| POST/PATCH | /plans, /plans/{id} | plan builder | physio.plan.create/update | Y | – |
| POST | /plans/{id}/hep/publish | send HEP to app/PDF | physio.plan.update | Y | – |
| POST | /sessions/series | book N sessions (resources) | physio.schedule.manage | Y | – |
| GET | /schedule?therapist=&date=&room= | calendar | physio.schedule.read | – | – |
| PATCH | /sessions/{id} | reschedule/cancel/no-show | physio.schedule.manage | Y | – |
| POST | /sessions/{id}/check-in, /start, /complete, /abort | session lifecycle | physio.session.record | Y | – |
| PUT | /sessions/{id} | items delivered/response/SOAP | physio.session.record | Y | – |
| POST | /sessions/{id}/sign | sign → billing | physio.session.sign | Y | – |
| POST | /referrals/{id}/discharge | discharge summary | physio.discharge.create | Y | – |
| POST/GET | /hep/adherence (patient scope) | adherence logs | patient scope / physio.assessment.read | Y | cursor |
| POST/GET | /equipment/checks, /equipment/usage | equipment log | physio.equipment.manage/read | Y | cursor |
| POST/GET | /groups, /groups/{id}/attendance | group sessions | physio.schedule.manage | Y | – |
| GET | /stats/dashboard | KPIs | physio.report.read | – | – |

## 7. Domain Events (outbox)
- `physio.referral.accepted|rejected|sla_breached`, `physio.assessment.recorded`, `physio.plan.created|updated`, `physio.hep.published` → OP-020/PE-001, `physio.session.scheduled|completed|no_show|missed_ip` → OP-005/OP-023 billing, EN-009 reminders, referrer feed, TR-010; `physio.goal.met`, `physio.reassessment.due`, `physio.adverse_event` → NC-015, `physio.discharged` {outcomes} → OP-009/TR-010/OP-021, NC-003, EN-030 PROM schedule; `physio.equipment.check_failed|breakdown` → NC-020.
- Consumes: `referral.created` (OP-021), `ortho.plan.signed` (OP-009), `ip.admitted|discharged|transferred`, `ot.case.completed`, `asset.status.changed`, `payment.received`, `package.purchased`.

## 8. Screens (UI)
1. **Physio referral queue** (desktop/tablet): SLA colour, source, precautions chips; `A` accept, `Enter` open.
2. **Assessment form** (tablet, plinth-side): sectioned form with body-region ROM/MMT grids (numeric keypad), goniometer quick entry, score calculators; `Ctrl+S` save, `Ctrl+Enter` sign; offline capable.
3. **Plan builder** (desktop/tablet): template picker, library search with thumbnails (`/` search), drag items into session template, dose editor, precaution/contraindication banners, HEP selector, print/publish; `Ctrl+D` duplicate.
4. **Therapist day view** (tablet): timeline of sessions/rooms/equipment; session card open → items checklist with timers for modalities, response entry, adverse event button; `Ctrl+Enter` sign; real-time updates from reception.
5. **Scheduler** (desktop reception): therapist × time grid, series booking wizard, waitlist, package balance display, group class roster.
6. **Progress dashboard per patient**: goals vs current, ROM/strength/function/pain charts, adherence heatmap, session count; export summary.
7. **Equipment console** (tablet/desktop): daily checks, usage, PM due, breakdown reporting.
8. **Patient app HEP** (phone; OP-020): today's exercises with video, timers, done/skip, pain, reminders (offline video cache).
9. **Rehab HOD dashboard** (desktop dark): productivity, TAT, outcomes, cancellations, utilisation.

## 9. Integrations
- OP-021 referral engine, OP-009/TR-010, OP-023 packages, OP-005, EN-002 pre-auth (session caps), NC-020 assets, NC-030 roster, EN-009 reminders/HEP links, OP-020 app (HEP), EN-030 PROMs, S3 media for exercise videos (CDN), EN-042 later (isokinetic/BTE, wearable ROM sensors, treadmill data), NC-003 documents.

## 10. Reports & Analytics
- Referral TAT & acceptance rate by source; sessions/therapist/day, utilisation of therapists/rooms/equipment; cancellations/no-shows; outcome improvement (mean change in Oxford/DASH/LEFS/Barthel/FIM, % goals met), sessions-to-discharge by condition, HEP adherence %, adverse events, package sales & consumption, revenue per therapist, IP physio coverage (% ICU/ortho patients seen within SLA), equipment downtime. Read models `analytics.physio_sessions_daily`, `analytics.physio_outcomes`.

## 11. Notifications
- Patient: session confirmation, D-1/2 h reminders, HEP daily reminder (opt-in), missed session recall, package balance low/expiry, discharge summary & PROM link.
- Therapist: new referral (SLA), reassessment due, HEP low adherence, equipment failed check; Referrer: assessment done, reassessment summary, adverse event, discharge; Reception: waitlist slot opened; Biomedical: equipment breakdown.

## 12. Permissions (RBAC keys)
`physio.referral.read|manage`, `physio.assessment.create|read`, `physio.plan.create|update|read`, `physio.schedule.read|manage`, `physio.session.record|sign|read`, `physio.discharge.create`, `physio.equipment.manage|read`, `physio.configure`, `physio.report.read`, `physio.export`. Defaults: Physiotherapist/OT — all clinical; Rehab assistant — session.record (no sign), equipment; Receptionist — schedule; Doctor — referral read, assessment/plan read; Biomedical — equipment; HOD — report; Patient — own HEP/adherence.

## 13. Non-functional
- Enterprise: 40 therapists, 600–900 sessions/day (OP+IP), 5k library items with video (CDN); day view p95 < 200 ms; video start < 2 s on 3G (adaptive bitrate/thumbnails).
- Offline: tablet caches day plan/forms; sessions & assessments queued (idempotent); conflict: server-side newer version → therapist re-review; patient app HEP works offline with cached media.
- Print: HEP PDF (pictorial, multilingual), assessment/discharge summary A4, session receipt.
- Accessibility/i18n: exercise names/instructions in local languages; large controls; captions on videos.

## 14. Acceptance Criteria
1. Given an ortho referral with "NWB right leg", when the therapist adds "weight-bearing squats" to the plan, then a precaution conflict blocks save until removed or overridden with reason.
2. Given a patient flagged pacemaker, when IFT over thorax is added, then a contraindication hard-block appears; TENS on knee is allowed with caution note.
3. Given a series of 10 sessions Mon/Wed/Fri 10:00 with therapist T1 and traction unit U1, when booked, then no overlaps exist for T1 or U1 (409 on conflict) and 10 confirmations are sent.
4. Given a session signed, then a billing line posts once (idempotent) and package balance decrements; a no-show session posts nothing.
5. Given 6 sessions completed without reassessment, then the 7th session save shows "reassessment overdue" and the 9th blocks until reassessment recorded (config).
6. Given HEP published, then the patient app shows exercises with video within 1 min; adherence logged offline syncs later and appears on the therapist's dashboard.
7. Given an ICU referral created at 09:00, when not accepted by 11:00, then SLA breach alert goes to physio HOD.
8. Given discharge with baseline Oxford Knee 18 and final 36, then the summary shows improvement, goals-met %, is sent to the referring surgeon and TR-010 milestone updated.
9. Given equipment daily check failed for US unit, then it cannot be selected in sessions today and a NC-020 ticket exists.
10. Given an adverse event "dizziness, session aborted", then an NC-015 incident draft is created and referrer notified.
11. Given tablet offline, when two sessions are documented and signed, then they sync with original times and billing posts once.
12. Given a receptionist without `physio.session.sign`, then sign returns 403 and is audited.

## 15. Enhancements / Later phases
- Sheet row 63 items (assessment, exercise plans, progress, equipment log) — core; costed proposal line 1570 (referral, assessment, treatment plans, session scheduling, exercise library, progress tracking, billing) — core.
- Later: tele-rehab video sessions (OP-018) & remote monitoring (wearable ROM/step sensors EN-042), AI exercise form feedback via phone camera (AI Phase 12), robotic/VR rehab device data, cardiac/pulmonary rehab programme dashboards (OP-029/OP-030), community/home physio visits with GPS check-in (NC-024), outcome benchmarking (EN-001).
- (market) SMART/PCS physiotherapy modules — covered.

## 16. Open Questions for the Hospital
1. Direct-access physio allowed or referral mandatory? SLA per source?
2. Billing model: per session, per modality, packages, IP per-day? Insurance session caps?
3. Therapist specialties/rosters, rooms/cubicles, equipment inventory (with pacemaker/SWD rules)?
4. Which outcome measures/protocol templates do you use? Reassessment interval?
5. Do you want the patient HEP app at go-live (video library source: licensed vs in-house recorded)?
6. Group classes offered (cardiac/pulmonary/antenatal)? Home visits?
