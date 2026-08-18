# TR-010 — Trauma Rehabilitation Pathway (FIM/Barthel scoring, physio/OT/speech scheduling, progress milestones, return-to-work)

| Field | Value |
|---|---|
| Domain | Trauma & Orthopaedics |
| Module ID | TR-010 |
| Phase | 8 |
| Priority | P1 |
| Complexity | Medium |
| Depends on | OP-015 (Physiotherapy/Rehabilitation — assessments, sessions, exercise library, HEP; TR-010 is the **pathway/care-coordination layer** across physio, occupational therapy, speech-language therapy, prosthetics-orthotics, psychology, social work), IP-021 (IP Rehabilitation — inpatient rehab plan/daily progress; TR-010 orchestrates), TR-001/TR-002/TR-006/TR-007 (injury, fracture, ICU stay, polytrauma phase → pathway entry), OP-009 (ortho follow-up protocols, weight-bearing), TR-005 (cast removal → rehab), OP-016 (pain clinic), OP-017 (wound clinic), OP-032 (psychiatry/psychology — PTSD, depression screening), OP-035 (speech therapy), OP-011 (nutrition), IP-002 (discharge planning), PE-001/OP-020 (patient app: HEP, milestones, PROMs), PE-002 (follow-up/recall), OP-001 (appointment scheduling; multi-discipline slots), OP-018 (tele-rehab), OP-005/IP-005 (billing/packages OP-023), EN-002/RC-007 (insurance/PMJAY rehab packages, ESIC), NC-010/HR-type external (employer certificates), NC-034 (therapist incentives), EN-039 (forms), TR-011 (registry outcomes), EN-024 |
| Feature flag | `module.trauma_rehab.enabled` (sub: `rehab.fim_licensed`, `rehab.return_to_work`, `rehab.tele_rehab`, `rehab.prosthetics`) |
| Primary roles | Physiotherapist / Occupational therapist / Speech-language therapist (40), Rehabilitation physician (PM&R) / Orthopaedic surgeon (6/9), Rehab coordinator nurse (17/22), Prosthetist-orthotist (40-type), Psychologist/counsellor (42), Medical social worker |
| Secondary roles | Intensivist (11, early mobilisation), Ward nurse (17), Dietician (39), Pain physician (OP-016), Receptionist (24, multi-discipline booking), Billing/insurance (27/28), Employer/insurer (external, RTW certificates), Patient & family (59/60), Quality (54), Auditor (58) |
| Regulatory | Rights of Persons with Disabilities Act 2016 (disability certification — UDID; hospital as certifying authority where notified; MoSJE guidelines for assessment of locomotor disability %), Rehabilitation Council of India (therapist registration), NABH 5th ed. COP (rehabilitation services, discharge planning, patient education), Employees' Compensation Act 1923 & ESI Act (injury/disability & fitness certificates), Motor Vehicles Act (compensation medical reports; MACT), Persons with Disabilities certificates format (Form IV etc.), WHO ICF framework, FIM® (licensed by UDSMR — capture only with licence; else Barthel/free instruments), Barthel Index (Mahoney & Barthel; modified), IRDAI (rehab/physio coverage rules), DPDP; clinical standards: BOAST rehab, WHO Rehabilitation 2030, ISPRM |

## 1. Purpose
TR-010 ensures every trauma survivor gets a planned, measured recovery: automatic pathway entry from ICU/ward/OT/fracture events, a multidisciplinary rehab assessment (physio, OT, speech/swallow, cognition, psychology, nutrition, social), functional scoring (**FIM** where licensed, **Barthel/Modified Barthel**, plus domain instruments — Berg, TUG, 6MWT, DASH/LEFS, MoCA, PHQ-9/PCL-5, ROM/MMT via OP-015), goal-based plans with **milestones** (sit-out, stand, walk 10 m, stairs, ADL independence, driving, work) mapped to injury protocols and weight-bearing constraints (TR-002/OP-009), **cross-discipline scheduling** of sessions (inpatient bedside, gym, OPD, home/tele-rehab), progress dashboards, prosthetic/orthotic pathway for amputees, psychosocial support, disability certification support, and a **return-to-work/return-to-sport** assessment with employer/insurer certificates. Outcomes feed TR-011.

## 2. Users & Jobs-to-be-done
- **Rehab coordinator** (desktop; ~30–60 new trauma pathways/day in a 2000-bed centre): triage pathway entries, assemble the team, run weekly MDT reviews, keep the schedule dense, chase missed sessions, prepare discharge/rehab-transfer, coordinate certificates and insurance.
- **Physiotherapist / OT / SLT** (tablet at bedside/gym; phone for home visits): assess, score, set SMART goals & milestones, deliver and document sessions (via OP-015 session engine), update HEP, mark milestones, flag barriers (pain, weight-bearing limits, wound, mood).
- **Rehab physician / surgeon** (desktop/tablet): approve plan and precautions (weight-bearing, ROM limits from TR-002), review progress at milestones, sign RTW/disability/fitness certificates, adjust pain/spasticity meds.
- **Psychologist/social worker**: PTSD/depression screening, counselling sessions, family training, financial/scheme assistance (PMJAY/ESIC/MACT), vocational referrals.
- **Prosthetist-orthotist** (`rehab.prosthetics`): stump assessment, prosthesis prescription, fitting/gait training schedule, device register (TR-003 for implanted components n/a; NC-006 for devices).
- **Ward nurse/intensivist**: early mobilisation levels & precautions on the flowsheet (TR-006), bedside sessions coordination.
- **Patient/family** (app): milestone tracker, HEP videos, session schedule, PROMs, tele-rehab join, certificates download.
- **Employer/insurer**: receive fitness/RTW/disability certificates (with consent).

## 3. Core Workflows

### 3.1 Pathway entry & triage
1. **Triggers** (events): `icu.admitted` (early mobilisation plan day 1), `polytrauma.case.phase_changed → recovery`, `ot.case.completed` (post-op protocol), `ortho.fracture.plan_set` (conservative with rehab), `cast.removed`, `ip.admitted` with trauma diagnosis, amputation event, spinal cord injury, TBI, burns > 10 % TBSA, manual referral (OP-002/IP-003) → **System** creates `rehab_pathways` (patient, index event, injury profile from TR-001/TR-002, precautions from TR-002 plans (weight-bearing, ROM), red flags) → coordinator **triage** (priority: ICU/early mobilisation same day; ward within 24 h; OPD within 72 h) → **team assignment** by discipline needs (rules: fracture lower limb → physio; hand/upper limb/ADL → OT; TBI/tracheostomy/dysphagia → SLT; amputation → P&O; screening positive → psychology; all → social work if scheme/insurance) → Event `rehab.pathway.opened`.
2. Duplicate control: one open pathway per patient per index episode; new injury during pathway → add to same pathway with new goals.

### 3.2 Multidisciplinary assessment & scoring
1. Each discipline completes assessment (EN-039 forms; physio via OP-015 assessment engine) → **functional scores**: **Barthel Index** (10 items, 0–100; or Modified BI 0–100) always; **FIM** (18 items, 1–7; motor 13 + cognitive 5; total 18–126) if `rehab.fim_licensed`; domain instruments by injury: Berg Balance, TUG, 10-m walk, 6MWT, DASH/QuickDASH, LEFS, Oxford scores (OP-009 PROMs), Harris Hip, ASIA (TR-001) for SCI, GOS-E/Rancho/MoCA for TBI, FOIS/GUSS/MASA (swallow), Boston naming (aphasia), PHQ-9/GAD-7/PCL-5 (psych), Amputee Mobility Predictor/K-level (P&O), ICF categories tagging → **baseline snapshot** → **rehab prognosis** (target discharge FIM/Barthel, expected LOS/duration) → **goals**: SMART per discipline with target dates, linked **milestones** (catalogue per injury protocol: e.g. hip fracture — sit out day 1, stand day 1–2, walk 10 m with frame day 3–5, stairs before discharge, independent ADL 6 wk, community ambulation 12 wk; SCI — bed mobility, transfers, wheelchair skills; TBI — orientation, safety awareness) → **plan** approved by rehab physician/surgeon with precautions confirmed → Event `rehab.plan.approved`.
2. Reassessment cadence: inpatient weekly (or at milestone), OPD every 4–6 weeks; discharge score; 3/6/12-month follow-up scores (PROMs via app/WhatsApp — EN-030).

### 3.3 Cross-discipline scheduling & sessions
1. **Coordinator/therapists** build the **weekly schedule**: sessions per discipline (frequency/duration/setting: ICU bedside, ward, gym, hydrotherapy, OPD, home visit, tele-rehab (OP-018)), therapist availability (NC-030 roster), equipment/room slots (gym, tilt table, parallel bars, robotics), avoiding conflicts with OT/imaging/dialysis and pain-med timing (OP-016), family training slots; **auto-suggest** slots via OP-001 scheduling engine (multi-resource) → patients/families see schedule in app → session reminders (EN-009).
2. **Session delivery** documented in OP-015 (physio) or discipline session record (OT/SLT/psych) with SOAP, exercises, dosage, tolerance, pain, vitals if needed, HEP update, **milestone achieved** ticks, barriers (weight-bearing restriction, wound, mood, fatigue, equipment) → missed/declined sessions with reason → **make-up** scheduling → billing per session/package (OP-005/IP-005; OP-023 rehab packages; insurer/PMJAY rehab codes; ESIC).
3. Precaution changes (TR-002 weight-bearing update, wound (OP-017), new fracture) → **automatic plan review** task; therapist cannot mark milestone that violates active precaution (e.g. "walk FWB" while NWB) — hard-stop with override by physician.

### 3.4 Progress tracking, MDT review & barriers
- **Progress dashboard** per patient: score trend (Barthel/FIM), milestones timeline (planned vs achieved), sessions delivered vs planned, goal attainment scaling (GAS), barriers list; **MDT weekly review** (rehab physician, therapists, nurse, psych, social work; family optional): decisions, goal revisions, discharge target date, equipment needs (wheelchair, walker, commode, hospital bed at home — issue/loan/purchase via NC-006), home modification advice, caregiver training checklist → signed note → Event `rehab.mdt.reviewed`.
- Alerts: no session in 48 h (inpatient), milestone overdue > 7 days, score decline, PHQ-9 ≥ 15 / PCL-5 positive → psych escalation, pain > 6 → OP-016, pressure injury/wound flags.

### 3.5 Discharge & transition of care
- **Rehab discharge planning** (with IP-002): destination (home / inpatient rehab unit IP-021 / step-down / other centre / home health), HEP & caregiver training complete, equipment delivered, home program with videos (OP-038/PE-001), OPD/tele-rehab schedule (PE-002), follow-up scores schedule, community resources; **rehab discharge summary** (baseline vs discharge scores, goals met %, milestones, precautions, plan) to referrer/MRD/patient; transfer packet if external rehab centre (IP-018).

### 3.6 Return-to-work / return-to-sport (`rehab.return_to_work`)
1. **RTW assessment**: occupation & job demands (physical: lifting, standing, driving, heights; cognitive), functional capacity evaluation (FCE) results, restrictions & duration, graded return plan (light duty → modified → full), work-hardening sessions (OT), driving assessment (TBI/lower limb), return-to-sport criteria (LSI, hop tests, psychological readiness) → **certificates**: fitness/unfit certificate (`MED_CERT` series, e-sign EN-016), RTW recommendation letter to employer (with patient consent), ESI/Employees' Compensation forms, MACT disability/medical report for RTA (with TR-008 linkage), **disability assessment** (locomotor % per MoSJE guidelines) → hospital-issued disability certificate/UDID support (if hospital is a notified authority; else assessment report for the board) → Event `rehab.rtw.assessed`.
2. Tracking: RTW date achieved, partial/full, days lost, recurrence; outcomes to TR-011.

### 3.7 Amputee & P&O pathway (`rehab.prosthetics`)
- Pre-prosthetic (stump care, shaping, desensitisation, contracture prevention), prosthesis prescription (K-level, components), fitting/check socket, gait training schedule, device register (NC-006 item, vendor, cost, scheme e.g. ADIP/ALIMCO), reviews & socket adjustments, phantom pain (OP-016), peer support (PE-004).

### 3.8 Psychosocial & family
- Screening at entry & 6 weeks (PHQ-9/GAD-7/PCL-5, alcohol AUDIT-C, caregiver strain), counselling sessions, family/caregiver training log, scheme assistance (PMJAY, ESIC, MV Act compensation, state disability pension), vocational rehab referrals, support groups (PE-004).

### 3.9 Special populations
- **Spinal cord injury**: ASIA-based goals, bladder/bowel programme, pressure-relief schedule, wheelchair prescription & skills, autonomic dysreflexia education, spasticity management (OP-016), sexuality/fertility counselling referral; **TBI**: cognitive rehab (attention/memory), behaviour plan, family training, driving/return-to-study assessment, post-concussion follow-up; **Burns**: scar management (pressure garments, silicone), contracture prevention splinting (with TR-005 splints), itch/pain, camouflage/psych; **Paediatric trauma**: play-based goals, school re-entry letter, growth follow-up (OP-033); **Geriatric**: falls-prevention programme, osteoporosis pathway (TR-002), delirium/frailty screens, caregiver support (OP-034).

### 3.10 Exceptions & edge cases
1. **Patient discharged before rehab assessment** (short stay): pathway auto-converts to OPD priority 72 h; if no visit booked, PE-002 recall; closure `no_show` after 3 attempts.
2. **Precaution conflict discovered mid-session** (new fracture found): therapist stops, logs barrier, plan review task; milestone marks reverted with reason.
3. **Insurer session cap reached**: system warns at cap−2; further sessions require self-pay consent or free-care policy; documented.
4. **Therapist absent** (roster change): sessions auto-reassigned or rescheduled with patient notification; productivity not penalised.
5. **Tele-rehab connectivity failure**: session logged as attempted; phone fallback; make-up scheduled.
6. **Certificate dispute** (employer requests change): addendum only; original retained; legal referral if needed (NC-023).
7. **Patient transferred to external rehab centre**: pathway `transferred` with packet; outcomes captured via follow-up PROMs if consented.
8. **Death during pathway**: closure with outcome; TR-011 updated; family bereavement support task.

## 4. Data Model (schema `trauma`, prefix `rehab_`; sessions in OP-015 `specialty.physio_*` where physio)
- **rehab_pathways**: id, hospital_id, branch_id, patient_id, index_event enum(icu_admission/polytrauma_recovery/post_op/fracture_conservative/cast_removed/amputation/sci/tbi/burns/manual), trauma_episode_id?, fracture_ids uuid[], admission_id?, opened_at, opened_by, priority enum(same_day/24h/72h/routine), coordinator_id, disciplines text[] (physio/ot/slt/po/psych/msw/nutrition), precautions jsonb (weight_bearing per limb, rom_limits, spinal, cardiac, wound, cognitive), red_flags text[], status enum(open/active/discharged/transferred/closed/lost_to_follow_up), target_discharge_date, discharge_destination?, closed_at, outcome_summary jsonb.
- **rehab_assessments**: id, pathway_id, discipline, at, by, form_response_id (EN-039/OP-015), icf_codes text[], notes, signed_at.
- **rehab_scores**: id, pathway_id, instrument enum(barthel/mbi/fim/berg/tug/10mwt/6mwt/dash/quickdash/lefs/gose/rancho/moca/fois/guss/phq9/gad7/pcl5/auditc/amp/gas/other), timepoint enum(baseline/weekly/milestone/discharge/3m/6m/12m/adhoc), at, by, items jsonb, total numeric, subscores jsonb (fim_motor, fim_cognitive), source enum(clinician/patient_app/whatsapp), licence_ack bool (FIM).
- **rehab_goals**: id, pathway_id, discipline, description, smart jsonb (specific, measure, target_value, target_date), status enum(active/achieved/revised/abandoned), gas_scale jsonb, created_by, updated_at.
- **rehab_milestone_catalogue** (config): hospital_id?, protocol_code (injury/procedure), milestones jsonb ([{code, label, expected_day_from, expected_day_to, discipline, precaution_dependency}]).
- **rehab_milestones**: id, pathway_id, code, label, planned_date, achieved_at?, achieved_by?, session_id?, overdue bool, blocked_by_precaution bool, notes.
- **rehab_plans**: id, pathway_id, version, disciplines_plan jsonb ({discipline: {frequency_per_week, duration_min, setting[], interventions[]}}), precautions_confirmed jsonb, prognosis jsonb (target_scores, expected_duration), approved_by, approved_at, status enum(draft/approved/superseded).
- **rehab_sessions** (non-physio disciplines; physio in OP-015): id, pathway_id, discipline, scheduled_at, duration_min, setting enum(icu/ward/gym/opd/home/tele), therapist_id, room_id?, equipment_ids uuid[], status enum(scheduled/done/missed/declined/cancelled/makeup), soap jsonb, tolerance, pain_nrs, barriers text[], milestones_achieved uuid[], hep_updated bool, charge_intent_id?, tele_session_id? (OP-018), signed_at.
- **rehab_schedule_slots** (read model / OP-001 resources): therapist/room/equipment calendars.
- **rehab_mdt_reviews**: id, pathway_id, at, attendees uuid[], decisions jsonb, goal_changes jsonb, discharge_target_date, equipment_needs jsonb, caregiver_training jsonb, signed_by, signed_at.
- **rehab_barriers**: pathway_id, type enum(pain/weight_bearing/wound/mood/cognition/fatigue/equipment/social/financial/transport/other), detail, raised_at, resolved_at, action.
- **rehab_equipment_issues**: pathway_id, item_id (NC-006), type enum(loan/issue/purchase_advice), issued_at, return_due?, returned_at, deposit?, scheme?.
- **rehab_rtw_assessments**: id, pathway_id, at, by, occupation, job_demands jsonb, fce jsonb, restrictions jsonb, graded_plan jsonb, driving_assessment jsonb, return_to_sport jsonb, recommendation enum(unfit/light_duty/modified/full/retrain), certificate_ids uuid[], rtw_date_planned, rtw_date_actual?, rtw_status enum(pending/partial/full/not_returned), days_lost int?.
- **rehab_certificates**: id, pathway_id, type enum(fitness/unfit/rtw_letter/esi_form/ec_form/mact_report/disability_assessment/disability_certificate/udid_support), number (`MED_CERT`), doc_id, signed_by, dsc_ref, issued_at, recipient jsonb, consent_ref, addendum_of?.
- **rehab_prosthetics**: pathway_id, amputation_level, side, k_level, prescription jsonb, device_item_id?, vendor, cost, scheme, fitting_dates jsonb, reviews jsonb, phantom_pain bool.
- **rehab_psychosocial**: pathway_id, screens jsonb (phq9, gad7, pcl5, auditc, caregiver_strain with dates), counselling_sessions uuid[], schemes jsonb, vocational_referral jsonb, support_group bool.
- **rehab_discharges**: pathway_id, at, destination, hep_doc_id, caregiver_training_done bool, equipment_delivered bool, followup_schedule jsonb, summary_doc_id, transfer_packet_id?.
- Indexes: rehab_pathways (hospital_id, status, priority, opened_at), (patient_id); rehab_sessions (therapist_id, scheduled_at), (pathway_id, status); rehab_milestones (pathway_id, planned_date, achieved_at); rehab_scores (pathway_id, instrument, at). RLS; certificates & discharge summaries versioned/immutable; retention ≥ 10 y.

## 5. Business Rules & Validations
- Pathway auto-open triggers configurable; one open pathway per patient per index episode; ICU/early-mobilisation entries must have first physio contact within 24 h (KPI), ward within 48 h, OPD within 7 days.
- Every plan requires baseline Barthel (and FIM if licensed) + at least one SMART goal per active discipline + precautions confirmed against TR-002 current plan; plan approval by rehab physician/surgeon (config: physio lead may approve for isolated limb fractures).
- FIM items captured only if `rehab.fim_licensed=true` (licence id stored); otherwise UI hides FIM and uses Barthel/MBI.
- Milestone marking blocked when it violates an active precaution (weight-bearing/ROM/spinal) — physician override with reason; precaution change from TR-002 → plan review task within 24 h.
- Sessions: missed 2 consecutive inpatient sessions → coordinator alert; OPD no-show → PE-002 recall; make-up sessions counted; billing per session/package with insurer limits (EN-002 rules: e.g. N sessions/episode) — exceeding limit prompts patient consent for self-pay.
- Score decline ≥ 10 Barthel points or FIM ≥ 8 between reviews → MDT flag; PHQ-9 ≥ 15 or suicidality item > 0 → same-day psych referral (OP-032) & safety protocol; PCL-5 ≥ 33 → PTSD pathway.
- RTW/fitness certificates numbered (`MED_CERT`), e-signed, addendum-only corrections; issued to employer/insurer only with patient consent (EN-028) — logged; disability % computed per MoSJE guideline calculators (locomotor: combined formula a + b(90−a)/90) with worksheet stored; certificate issuance only if hospital is authorised, else "assessment report".
- Discharge from pathway requires discharge score, HEP delivered, follow-up schedule; lost-to-follow-up after 3 failed contacts (PE-002) with coordinator confirmation.
- Family/caregiver training items must be ticked before inpatient rehab discharge for dependent patients (Barthel < 60).
- Equipment loans tracked with return due & deposit; scheme devices (ADIP) documented.
- Numbering: `REHAB` pathway no; `MED_CERT`.

## 6. API Surface (`/api/v1/rehab/pathways`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | / | open pathway (manual) | rehab.pathway.create | Y | – |
| GET | /?status=&priority=&discipline=&coordinator= | worklist | rehab.pathway.list | – | cursor |
| GET | /{id} | pathway detail (scores, goals, milestones, sessions, barriers) | rehab.pathway.read | – | – |
| PATCH | /{id} | triage/team/precautions/status | rehab.pathway.manage | Y | – |
| POST | /{id}/assessments | discipline assessment | rehab.assess | Y | – |
| POST | /{id}/scores | record score (any instrument) | rehab.assess / patient (PROM) | Y | – |
| POST/PATCH | /{id}/goals[/{gid}] | goals | rehab.plan.write | Y | – |
| POST | /{id}/plans, /plans/{pid}/approve | plan version & approval | rehab.plan.write / rehab.plan.approve | Y | – |
| GET | /{id}/milestones, POST /{id}/milestones/{mid}/achieve | milestones | rehab.session.write | Y | – |
| POST | /{id}/schedule/suggest, /sessions (bulk) | build schedule | rehab.schedule.manage | Y | – |
| GET | /sessions?therapist=&date=, PATCH /sessions/{sid} | therapist day list; session record/status | rehab.session.write | Y | cursor |
| POST | /{id}/barriers, PATCH /barriers/{bid} | barriers | rehab.session.write | Y | – |
| POST | /{id}/mdt-reviews, /mdt-reviews/{rid}/sign | MDT | rehab.mdt.write / sign | Y | – |
| POST | /{id}/equipment | equipment issue/loan | rehab.equipment.manage | Y | – |
| POST | /{id}/rtw, /{id}/certificates, /certificates/{cid}/sign|send | RTW & certificates | rehab.rtw.write / rehab.certificate.sign | Y | – |
| POST | /{id}/prosthetics, /psychosocial | sub-pathways | rehab.assess | Y | – |
| POST | /{id}/discharge | rehab discharge & summary | rehab.pathway.manage | Y | – |
| GET | /reports/kpi?from=&to= | outcomes/productivity | rehab.report.read | – | – |
| GET/PUT | /config/milestone-catalogue, /config/triggers, /config/instruments, /config/insurer-limits | config | rehab.configure | Y | – |
(OP-015 endpoints for physio sessions/HEP; OP-018 tele-sessions; OP-001 slot booking.)

## 7. Domain Events (outbox)
- `rehab.pathway.opened|triaged|team_assigned|status_changed|discharged|closed` → coordinator worklist, PE-001 (patient view), TR-011, IP-002 (discharge planning), TR-007 (case card).
- `rehab.assessment.recorded`, `rehab.score.recorded` {instrument, total, timepoint} → dashboards, TR-011, PE-001.
- `rehab.plan.approved|superseded` → schedule builder, IP-003 (precautions/mobility level), OP-015 (physio plan).
- `rehab.session.scheduled|completed|missed|makeup` → EN-009 reminders, OP-005/IP-005 charges, NC-034 productivity, PE-002 recall (missed OPD).
- `rehab.milestone.achieved|overdue|blocked` → dashboards, alerts.
- `rehab.barrier.raised|resolved` → OP-016 (pain), OP-017 (wound), OP-032 (mood), MSW.
- `rehab.mdt.reviewed` → tasks (EN-038), IP-002.
- `rehab.equipment.issued|returned` → NC-006.
- `rehab.rtw.assessed`, `rehab.certificate.issued|sent` → NC-003 (MRD), employer/insurer (EN-032 with consent), TR-011.
- `rehab.psych.escalated` → OP-032.
- Consumes: `icu.admitted|discharged` (TR-006), `polytrauma.case.phase_changed` (TR-007), `ot.case.completed` (TR-004/IP-006), `ortho.fracture.plan_set|united|closed` (TR-002), `cast.removed` (TR-005), `physio.session.completed|milestone.reached` (OP-015), `wound.event` (OP-017), `pain.score.recorded` (OP-016), `appointment.no_show` (OP-001), `prom.response.received` (EN-030), `ip.discharge.planned` (IP-002).

## 8. Screens (UI)
- **Rehab coordinator worklist** (desktop): new pathway entries by priority with injury summary & precautions, team assignment chips, SLA timers (first contact), filters; `T` triage, `A` assign, `S` schedule.
- **Pathway workspace** (desktop 3-pane; tablet 2-pane): header (patient, injuries, precautions badges e.g. "NWB L leg", "spinal precautions"), tabs: Assessments & Scores (trend charts Barthel/FIM), Goals & Milestones (timeline planned vs achieved, blocked indicators), Schedule (week grid across disciplines), Sessions, Barriers, MDT, RTW/Certificates, Equipment, Psychosocial, Discharge; real-time updates from OP-015 sessions.
- **Scoring forms** (tablet): Barthel/FIM item pickers with descriptors, auto totals; domain instrument forms; PROM patient-facing forms (phone, multilingual, large text).
- **Therapist day view** (tablet/phone): sessions by time/location with precaution reminders, start/complete, milestone tick, barrier quick-add; offline capture for bedside/home visits with sync.
- **Schedule builder** (desktop): multi-resource calendar (therapists/rooms/equipment), auto-suggest, conflicts, patient constraints (dialysis/imaging), publish; family view in app.
- **MDT review screen** (desktop/tablet in meeting room; TV list of patients): agenda per patient, decisions, sign.
- **RTW & certificates studio** (desktop): job-demand form, FCE entry, graded plan builder, certificate templates (bilingual), e-sign, consent check, dispatch log; disability % calculator worksheet.
- **Patient app** (PE-001/OP-020): milestone tracker with celebrations, HEP videos, schedule & reminders, PROM forms, tele-rehab join, certificates.
- **KPI dashboard** (desktop): time to first contact, sessions delivered/planned, Barthel/FIM gain & efficiency (gain/LOS), goal attainment, RTW rates, missed sessions, therapist productivity.
- Print: rehab plan, discharge summary, HEP sheet (pictorial), certificates, MACT/ESI forms.

## 9. Integrations
- OP-015 (assessments/sessions/HEP/exercise library), OP-035 (speech), OP-032 (psych), OP-016/OP-017, OP-011, IP-021, IP-002/IP-018, OP-001 multi-resource scheduling, OP-018 tele-rehab (WebRTC), EN-030 PROM surveys (WhatsApp), EN-009 reminders, EN-016 e-sign, EN-028 consent for employer/insurer sharing, EN-032 e-mail dispatch, EN-002/RC-007 insurer/PMJAY/ESIC rules, NC-006 equipment, NC-030 rosters, NC-034 payouts, TR-011 registry, PE-001/OP-020/PE-002/PE-004; optional UDID portal (EN-017) for disability certificate data if hospital authorised.
- Fallbacks: OP-018 unavailable → phone session logged; scheduling engine down → manual slots; e-sign down → wet sign scan.

## 10. Reports & Analytics
- Pathway volume by index event/injury; time to first therapy contact (ICU/ward/OPD); sessions planned vs delivered (by discipline/therapist/setting), missed reasons; Barthel/FIM gain, FIM efficiency (points/day) & effectiveness; milestone attainment vs expected windows (by protocol); goal attainment (GAS); barrier frequency; LOS to rehab discharge; discharge destination mix; RTW rate & days lost by injury/occupation; return-to-sport; disability certificates issued; PROM response rates & 3/6/12-month outcomes; psych screening positivity & follow-through; equipment loans outstanding; therapist productivity & payouts; insurer session-limit exceptions.
- Read models: `analytics.mv_rehab_pathways`, `analytics.mv_rehab_outcomes`, `analytics.mv_rehab_sessions`, `analytics.mv_rehab_rtw`.

## 11. Notifications
- Patients/family: session schedule & reminders (T-1 day, T-1 h), HEP nudges, PROM invitations, milestone congratulations, certificate ready, follow-up scores due; Therapists: new assignments, precaution changes, missed-session make-up, MDT agenda; Coordinator: first-contact SLA breaches, missed sessions, overdue milestones, score decline, lost-to-follow-up candidates; Physician: plan approval requests, precaution conflicts, certificate signing queue; Psych: positive screens; Billing/insurance: session-limit exceptions; Employer/insurer: certificates (with consent).

## 12. Permissions (RBAC keys)
`rehab.pathway.create|list|read|manage`, `rehab.assess`, `rehab.plan.write|approve`, `rehab.session.write`, `rehab.schedule.manage`, `rehab.mdt.write|sign`, `rehab.equipment.manage`, `rehab.rtw.write`, `rehab.certificate.sign|send`, `rehab.report.read|export`, `rehab.configure`.
Defaults: Rehab coordinator: pathway.*, schedule.manage, equipment.manage, report; Therapists (40): assess, plan.write, session.write, mdt.write, rtw.write (FCE), pathway.read/list; Rehab physician/surgeon: plan.approve, mdt.sign, certificate.sign, rtw.write, all read; Psychologist/MSW: assess (own domain), session.write; Ward nurse/intensivist: pathway.read, session.write (mobility level); Receptionist: schedule.manage (booking scope); Billing/insurance: pathway.read (admin), report; Quality: report.export; Patient: own view/PROMs; Admin: configure; Auditor: read.

## 13. Non-functional
- Volumes: 1,500–2,500 active pathways; 600–900 rehab sessions/day across disciplines; PROM pushes 300/day; MDT 40 patients/week per unit.
- p95: pathway detail < 300 ms; therapist day list < 150 ms; schedule suggest < 1 s for a week; score save < 150 ms.
- Offline: therapist bedside/home-visit forms & scoring offline with sync; schedule read-only cached.
- Accessibility/i18n: patient PROMs & HEP in local languages with pictograms/video; large text; screen-reader labels; certificates bilingual.
- Security: employer/insurer sharing only with consent & audit; psych notes restricted (OP-032 rules); DSC on certificates.

- Seed data: milestone catalogues (hip fracture, TKR/THR, femur/tibia nail, spine, TBI, SCI, amputation, burns, paediatric, geriatric), instrument definitions (Barthel/MBI, Berg, TUG, 6MWT, DASH/QuickDASH, LEFS, GOS-E, MoCA, FOIS, PHQ-9/GAD-7/PCL-5, AUDIT-C, K-levels), trigger rules, discipline assignment rules, insurer session-limit examples, certificate templates (fitness/unfit/RTW letter/MACT/ESI), disability % calculator worksheets.
- Test fixtures: 30 synthetic pathways across index events, precaution-conflict scenario, insurer cap scenario, RTW certificate flow with consent, prosthetics sub-pathway; k6 smoke on therapist day list and schedule suggest.
- Observability: first-contact SLA breach counts, session sync backlog (offline tablets), schedule-suggest latency, PROM response rates; alerts when trigger consumer lags > 5 min.

## 14. Acceptance Criteria
1. Given `icu.admitted` for a trauma patient, then a rehab pathway opens with priority same_day, physio assigned, precautions pulled from TR-002 (e.g. NWB right lower limb), and the coordinator worklist shows a 24-h first-contact timer.
2. Given baseline Barthel 25 recorded and no FIM licence, then FIM fields are hidden and the plan requires Barthel baseline + goals; with licence flag, FIM 18 items are available and totals/subscores compute (motor/cognitive).
3. Given hip-fracture protocol, then milestones sit-out (day 1), stand (day 1–2), walk 10 m (day 3–5), stairs (pre-discharge) are created with planned dates from surgery date; achieving "walk 10 m" while weight-bearing is NWB is blocked with precaution message; physician override records reason.
4. Given TR-002 changes weight-bearing to PWB 50 %, then a plan review task is created and the precaution badge updates across the workspace within 5 s.
5. Given weekly schedule built for physio 2×/day and OT 1×/day, then sessions avoid the patient's dialysis slot and therapist roster gaps, and family sees the schedule in the app with reminders.
6. Given two consecutive inpatient sessions missed, then the coordinator receives an alert with reasons; OPD no-show triggers PE-002 recall.
7. Given Barthel drops from 60 to 45 between reviews, then an MDT flag is raised and appears on the review agenda.
8. Given PHQ-9 = 17 with item 9 = 1, then a same-day psych referral (OP-032) and safety protocol task are created and the coordinator notified.
9. Given MDT review signed with discharge target date and equipment "walker loan", then NC-006 loan record with return due is created and IP-002 discharge plan shows rehab items.
10. Given RTW assessment recommends light duty for 4 weeks, then a fitness certificate with restrictions is generated (`MED_CERT` number, e-signed) and sent to the employer only after consent is recorded; the send is audited.
11. Given a MACT medical report requested for an RTA patient, then the report pulls injuries (TR-001/TR-002), treatment, disability assessment worksheet and MLC number (TR-008) into the template for physician sign.
12. Given locomotor disability inputs (a = 40 %, b = 30 %), then combined disability computes 40 + 30×(90−40)/90 = 56.7 % → 57 % with worksheet stored.
13. Given rehab discharge, then discharge Barthel/FIM recorded, HEP delivered to app, follow-up PROMs scheduled at 3/6/12 months, and TR-011 outcome fields update.
14. Given a below-knee amputee pathway, then P&O sub-pathway shows K-level, prescription, fitting dates and gait-training sessions; phantom pain flags OP-016 referral.
15. Given the KPI report, then FIM efficiency = (discharge − admission FIM)/rehab LOS matches recomputation on test data.
16. Given a therapist without `rehab.plan.approve` attempts approval, then it is rejected (403).
17. Given a patient discharged from ward 18 h after admission with no rehab assessment, then the pathway converts to OPD priority 72 h and an appointment task is created; after 3 failed contacts it closes as `no_show` with coordinator confirmation.
18. Given an insurer cap of 20 sessions and 18 delivered, then the coordinator sees a warning; the 21st session requires recorded self-pay consent before it can be scheduled.
19. Given an SCI pathway, then bladder/bowel programme, pressure-relief schedule and wheelchair skills milestones are seeded from the SCI protocol and ASIA grade from TR-001 is displayed on the header.
20. Given a therapist's roster changes for tomorrow, then their 8 sessions are auto-reassigned or rescheduled and each patient receives an updated reminder.

## 15. Enhancements / Later phases
- From Added-Modules sheet: FIM/Barthel, physio/OT/speech scheduling, milestones, RTW (all here); VIMS sheet rows 63/88 (physio/IP rehab) covered via OP-015/IP-021.
- (market) Competitor HMS have physiotherapy scheduling only; TR-010 adds later: wearable/step-count & ROM sensor integration (EN-042), AI progress prediction & discharge date forecasting (AI-005), gamified HEP with computer-vision form check (Phase 12+), virtual reality rehab logs, robotics (Lokomat) session data import, community rehab worker app (Phase 13), employer portal for RTW coordination (PE-006), UDID API integration, outcome benchmarking across branches (EN-041/EN-001).

## 16. Open Questions for the Hospital
1. Disciplines available in-house (physio, OT, SLT, P&O, psychology, MSW) and staffing; inpatient rehab unit exists (IP-021)?
2. FIM licence (UDSMR) available or use Barthel/MBI only? Preferred domain instruments per injury.
3. Milestone protocols per injury/procedure to seed (hip fracture, TKR/THR, spine, TBI, SCI, amputation, burns).
4. Session billing model (per session, packages, insurer/PMJAY/ESIC codes & limits) and therapist incentive rules (NC-034).
5. RTW/fitness certificate formats, MACT/ESI/EC forms used; is the hospital a notified disability certification authority (UDID)?
6. Tele-rehab appetite (OP-018) and patient app adoption; PROM channels (WhatsApp/app/paper).
7. Equipment loan policy (deposits, inventory), scheme devices (ADIP/ALIMCO) processes.
8. Psychosocial screening policy and psych/MSW capacity; support groups.
9. MDT review cadence and documentation expectations (NABH).
10. Home-visit services and geography; therapist safety/tracking.
11. Special-population protocols to seed (SCI, TBI, burns, paediatric, geriatric) and owning disciplines.
12. Session cap handling policy when insurer limits are reached (self-pay consent vs charity).
13. Certificates: employer/insurer delivery channels and consent capture practice.
