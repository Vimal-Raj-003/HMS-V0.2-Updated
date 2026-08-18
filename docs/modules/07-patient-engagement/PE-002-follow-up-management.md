# PE-002 — Follow-Up Management (Rules per Diagnosis/Procedure, Recall Lists, Multi-Channel Reminders, No-Show Tracking & Re-Engagement, Post-Discharge Calls, Medication Adherence, Chronic-Care Cohorts, Conversion Analytics)

| Field | Value |
|---|---|
| Domain | Patient Engagement |
| Module ID | PE-002 |
| Phase | 10 (basic appointment reminders ship with OP-001/EN-009 in Phase 1; the rules engine, recall lists, post-discharge calls and cohorts here) |
| Priority | P1 |
| Complexity | Medium |
| Depends on | OP-002 (diagnosis, follow-up advice at consultation — the primary trigger), IP-002 (discharge plan, follow-up date, post-discharge call schedule), OP-001 (appointments, slots, patient MPI, contactability), EN-009 (SMS/WhatsApp with DLT templates — service category), EN-032 (email), EN-037 (push, staff tasks & escalation), EN-033 (IVR / call centre — outbound campaigns, call logging, screen-pop), PE-001/OP-020 (portal & app: follow-up card, one-tap booking), PE-003/OP-038 (education attached to a follow-up), PE-005 (annual check-up & wellness reminders), OP-013 (immunisation due — owned there, surfaced here), OP-004/OP-008 (repeat investigations due before the visit), OP-003 (prescription end-date → refill/adherence check), IP-012 (post-op infection surveillance calls), OP-015/OP-016/OP-017 (therapy session series), OP-031/IP-023 (chemo cycles), OP-012/IP-022 (dialysis schedules), OP-040 (ANC visit schedule), TR-010 (trauma rehab pathway), NC-032 (grievance if a call reveals dissatisfaction), EN-030 (post-visit feedback overlaps the post-discharge call), EN-028 (communication consent), NC-026 (marketing must not masquerade as recall), NC-011/EN-001 (analytics), EN-024 (audit) |
| Feature flag | `module.followup.enabled` (sub: `followup.post_discharge_calls`, `followup.adherence`, `followup.chronic_cohorts`, `followup.ivr_campaigns`, `followup.auto_booking`) |
| Primary roles | Call Centre Agent (25), Receptionist / Front Office (24), Nurse — ward/discharge coordinator (17), Care Coordinator (custom role in the nursing family) |
| Secondary roles | Doctor (6/7/9 — sets follow-up advice, reviews escalations from post-discharge calls), Nurse — OPD (16), Pharmacist (30 — adherence flags), Physio/therapists (40), MRD (43), Marketing/CRM (55 — reads conversion analytics only), Hospital Admin (2), Quality (54 — readmission and post-discharge indicators), Patient (59) |
| Regulatory | **TRAI TCCCPR 2018** — recall and follow-up messages are **service/transactional** category on DLT-registered headers and templates; promotional content may not be embedded in them (a recall message that advertises a package is a violation and NC-026 must not repurpose these); preferred-time and DND rules apply to promotional only, but the hospital applies 08:00–21:00 as policy for calls; **DPDP Act 2023 & Rules 2025** — follow-up communication rests on the care purpose with recorded consent; withdrawal must be honoured; no clinical detail (diagnosis) in message bodies; children's data handled under parental consent; **NABH COP/AAC** — discharge plan must include follow-up instructions, and post-discharge follow-up is an accreditation expectation for defined cohorts; **NABH quality indicators** (readmission rate, return to OPD); **Telemedicine Practice Guidelines 2020** where a follow-up becomes a tele-consult; **MCI/NMC ethics** — follow-up is care, not solicitation |

## 1. Purpose
PE-002 makes sure the patient comes back when they should. It turns clinical intent ("review after 2 weeks", "suture removal day 10", "HbA1c in 3 months") into scheduled, owned, measurable actions: rule-driven follow-up generation per diagnosis, procedure, drug and care pathway; recall worklists for the desk and call centre; multi-channel reminders that respect consent and DLT rules; **post-discharge call scripts** with clinical escalation; medication-adherence check-ins; chronic-care cohort management (diabetes, hypertension, CKD, COPD, post-MI, post-arthroplasty); no-show detection and re-engagement; and analytics that show, honestly, how many advised follow-ups actually happened.

## 2. Users & Jobs-to-be-done
- **Call centre agent / care coordinator** (desktop + softphone, all day): work today's recall and post-discharge call lists, follow the script, book the appointment during the call, log the outcome, escalate anything clinical. 60–120 calls/day.
- **Front office**: book from a recall list, answer inbound "you called me" calls with context, close the loop when a patient walks in.
- **Ward nurse / discharge coordinator**: confirm the follow-up plan at discharge, schedule the post-discharge call, and hand over the patient's cohort enrolment.
- **Doctor**: set the follow-up interval in one click at the consultation; receive escalations from post-discharge calls ("wound discharging, fever 101 °F"); see who did and did not return.
- **Pharmacist**: see adherence flags for chronic patients whose refills have lapsed.
- **Quality**: readmission and post-discharge indicator reporting for NABH.
- **Patient**: a clear reminder with a one-tap booking link and, when it suits them, a tele-consult instead of a trip.

## 3. Core Workflows

### 3.1 Follow-up rule engine
1. **Rules** are configured (data, not code) with a scope and a schedule:
   - **By diagnosis (ICD-10 code or range)** — e.g. E11 (T2DM) → review 3 months, HbA1c 2 weeks before; I10 (hypertension) → 1 month then 3 months; N18 (CKD) → per stage; J44 (COPD) → 1 month post-exacerbation.
   - **By procedure** — post-op day 3 wound check, day 10 suture removal, 6-week X-ray after fracture fixation (TR-002), 3-month and 1-year arthroplasty review, post-cataract day 1/week 1/month 1, post-PTCA 1 month.
   - **By drug/class** (OP-003) — anticoagulant INR checks, methotrexate CBC/LFT, antipsychotic metabolic monitoring, statin lipid review, and refill-due from the prescription end date.
   - **By investigation** — repeat abnormal result review, biopsy report follow-up (a patient who never returns for a biopsy result is a serious safety event and must escalate).
   - **By pathway/programme** — ANC schedule (OP-040), immunisation (OP-013), chemo cycles (OP-031), dialysis (OP-012), rehab (TR-010/OP-015), TB/DOTS style adherence.
   - **By encounter type** — every IP discharge → post-discharge call at 48 h and day 7 (configurable per department); every day-care procedure → next-day call.
   Each rule specifies: offset (days/weeks from the trigger event), window (earliest/latest acceptable date), channel plan, owner role, whether an appointment should be **auto-created** or only advised (`followup.auto_booking`), the pre-visit preparation (fasting, bring reports, get a test done first), escalation if not completed, and the education material to attach (PE-003).
2. **Doctor override**: at the consultation the doctor sees the rule's suggestion and can accept, change the interval, or cancel with a reason. Clinical intent always wins over the rule; the rule exists so intent is never lost.
3. Rules are versioned, effective-dated, department-owned, and approved by the HOD/MS before activation.

### 3.2 Follow-up generation & the recall list
1. On `visit.consult.completed`, `ip.discharge.completed`, `procedure.completed`, `rx.created`, `lab.result.validated` (abnormal), `immunisation.given` etc., matching rules produce **follow-up records** with due date, window, owner, channel plan and priority (clinical risk first, not alphabetical).
2. The **recall list** is the daily worklist: due today, overdue, due this week, by department/doctor/cohort, with the patient's contactability status, preferred language and last outcome. Agents work from it; the list is capped and prioritised so it is finishable.
3. Bulk actions: send the day's reminder batch, generate an IVR campaign (`followup.ivr_campaigns`), export a call sheet for a camp/outreach.

### 3.3 Multi-channel reminder cadence
- A default cadence per follow-up type, e.g. **T−7 days** WhatsApp/SMS with a one-tap booking link and any preparation instructions → **T−2 days** reminder if unbooked → **T-day** call by an agent if still unbooked and the follow-up is clinically important → **T+3 days** overdue message → **T+10 days** final attempt and then closure as `not_reachable`/`declined`.
- Channel selection follows the patient's preference centre (PE-001), consent state (EN-028) and reachability history (a number that has failed 3 times is deprioritised and flagged for correction at the next visit). All messages are DLT service templates with **no diagnosis in the body** ("You have a review due with Dr X on 12 Aug — tap to book"). Push and portal cards accompany the messages.
- Booking from a message uses a tokenised deep link into PE-001/OP-020 (slot picker pre-filtered to the right doctor/department) or, where the hospital permits, `followup.auto_booking` creates a provisional appointment the patient can confirm or move.

### 3.4 Post-discharge calls (`followup.post_discharge_calls`)
1. Every IP discharge (and configured day-care procedures) generates a **call task** at 48 h and day 7 (configurable), assigned to a nurse or trained coordinator, with a **structured script** per department:
   - General: how are you feeling; pain score; fever; wound status (redness, discharge, gaping); appetite and bowel/bladder; mobility; are you taking the medicines as prescribed (name-check the key ones); any new medicine started elsewhere; do you have the follow-up appointment; do you understand the danger signs.
   - Surgical/ortho: wound and dressing, weight-bearing compliance, cast/splint issues (TR-005), physiotherapy started.
   - Cardiac: chest pain, breathlessness, weight gain, BP/pulse readings at home, anticoagulant compliance and INR appointment.
   - Obstetric: bleeding, fever, breastfeeding, newborn feeding and jaundice, danger signs.
   - Paediatric: feeding, fever, activity, immunisation due.
2. **Red-flag responses trigger immediate escalation** (fever > 38 °C, wound discharge, chest pain, breathlessness, bleeding, uncontrolled pain, no urine output, confusion): the call cannot be closed as routine; a task goes to the treating doctor/on-call with the transcript summary, and the agent advises the patient to attend the ER, with the ER pre-informed if the patient agrees. This is a clinical safety pathway, not a courtesy call.
3. Outcomes recorded: reached/not reached/wrong number/refused; clinical status; adherence; issues raised (which may create a grievance NC-032 or a feedback record EN-030); actions taken; next call date.
4. Non-clinical dissatisfaction discovered on the call is routed to service recovery (NC-032) rather than being buried in a call log.

### 3.5 Medication adherence check-ins (`followup.adherence`)
- From the prescription (OP-003) the system knows the intended duration and quantity. A refill that does not happen by the expected date, or a chronic-medication gap, generates an **adherence check** — a message ("your medicine may be finishing — do you need a refill or a review?") and, for high-risk drugs (anticoagulants, antiepileptics, antituberculars, immunosuppressants, insulin, antipsychotics), a call. Responses (taking regularly / stopped due to side effects / cost / forgot / stopped on another doctor's advice) are recorded and, where the reason is clinical or cost, escalated to the doctor or to counselling. Adherence status is visible to the treating doctor at the next consultation — this is the single most useful thing a follow-up module can put in front of a clinician.

### 3.6 Chronic-care cohorts (`followup.chronic_cohorts`)
1. Cohorts are defined by clinical criteria (diagnosis codes, lab thresholds, procedures) with an enrolment step: **diabetes**, **hypertension**, **CKD (by stage)**, **COPD/asthma**, **post-MI/heart failure**, **post-arthroplasty**, **stroke rehabilitation**, **antenatal**, **oncology survivorship**, **paediatric growth follow-up**. Enrolment is clinician-approved (a patient is not enrolled into a "programme" by an algorithm alone) and consented.
2. Each cohort carries a **care calendar** (visit intervals, investigations due — HbA1c quarterly, lipid profile annually, retinal screening annually, foot examination annually, eGFR/ACR per CKD stage, spirometry annually), education drops (PE-003), and adherence checks; the coordinator's cohort board shows who is on track, who is overdue and who has fallen out entirely.
3. Cohort outcomes are tracked (control rates where the data exists, admissions and readmissions, ER visits) so the programme can prove itself rather than merely exist.

### 3.7 No-show tracking & re-engagement
- A booked follow-up that is not attended becomes a **no-show** (distinguished from *cancelled* and from *never booked*). Re-engagement: same-day call, reschedule offer, tele-consult alternative, and for repeated no-shows a review of barriers (distance, cost, transport, timing, language) captured as a reason code — because the fix is usually operational, not motivational. Patients with three consecutive no-shows on a clinically important follow-up are escalated to the treating doctor.
- **Lapsed-patient sweep**: patients with an active chronic condition and no visit for N months (configurable, e.g. 12) enter a lapsed list for a re-engagement contact — carefully worded as care, not marketing, and consent-checked.

### 3.8 Conversion analytics
- The funnel per rule/department/doctor: advised → reminder delivered → booked → attended → outcome. Conversion rate, average days late, channel effectiveness (which message actually produced a booking), agent effectiveness, and the revenue attributable to returned patients (attribution shared with NC-026 but the *purpose* stays clinical).

### 3.9 Exceptions
- **Deceased patient** → all follow-ups cancelled immediately, no messages, and the list is scrubbed (a reminder sent to a deceased patient's family is the fastest way to destroy trust).
- Patient transferred to another provider, moved city, or explicitly declines follow-up → recorded with a reason; clinically critical follow-ups (biopsy result, abnormal cancer screening) still escalate to the doctor for a decision rather than closing silently.
- Consent withdrawn for communications → no messages; the follow-up remains visible to the desk and portal so the patient can act on their own.
- Unreachable after the full cadence → `not_reachable`, with a prompt to verify contact details at the next visit and, for high-risk follow-ups, a registered-letter option.
- Offline: agents' worklists are read-only cached; outcome logging queues.

## 4. Data Model (schema `engage`, prefix `followup_`)
- **followup_rules** — id, hospital_id, branch_id?, code, name, trigger_type enum(diagnosis/procedure/drug/investigation/pathway/encounter_type/manual), trigger_criteria jsonb (icd_codes, procedure_codes, drug_ids/classes, test_codes, pathway_id, encounter_type), offset_days int, window_early_days, window_late_days, priority enum(critical/high/normal/low), owner_role, auto_create_appointment bool, department_id, doctor_scope enum(same_doctor/any_in_department/specific), channel_plan jsonb [{offset, channel, template_id}], preparation_instructions, education_content_ids uuid[], escalation_rule jsonb, cohort_id?, active bool, version, effective_from, effective_to, approved_by, audit cols.
- **followups** — id, hospital_id, branch_id, patient_id, source_encounter_id, rule_id?, created_by enum(rule/doctor/manual/pathway), type enum(review/procedure_check/investigation/refill/immunisation/therapy_session/post_discharge_call/adherence_check/cohort_visit/lapsed_outreach), clinical_priority enum(critical/high/normal/low), due_date, window_start, window_end, doctor_id?, department_id, cohort_id?, instructions, status enum(pending/reminded/booked/attended/no_show/rescheduled/overdue/not_reachable/declined/cancelled/closed), appointment_id?, attended_encounter_id?, attempts smallint, last_attempt_at, last_outcome, owner_user_id?, closed_at, closure_reason, audit cols. Indexes (hospital_id, status, due_date), (patient_id, due_date), (department_id, due_date), (cohort_id, status).
- **followup_contacts** — id, followup_id, channel enum(sms/whatsapp/email/push/call/ivr/portal/letter), direction enum(outbound/inbound), attempted_at, template_id?, message_id (EN-009/EN-032), delivery_status, agent_id?, call_duration_s?, call_recording_ref?, outcome enum(delivered/read/replied/booked/no_answer/wrong_number/refused/callback/not_interested/reached), notes, next_attempt_at. Partitioned monthly.
- **followup_call_scripts** — id, hospital_id, name, applies_to enum(post_discharge/adherence/cohort/no_show/lapsed), department_id?, procedure_group?, questions jsonb [{key, text, type(bool/scale/choice/text), red_flag_condition, help_text}], closing_instructions, version, approved_by (MS/HOD), active.
- **followup_call_records** — id, followup_id, script_id, script_version, agent_id, started_at, ended_at, answers jsonb, red_flags text[], patient_status enum(well/minor_issue/needs_review/urgent), escalated_to_user_id?, escalated_at, escalation_outcome, satisfaction_note, grievance_id? (NC-032), feedback_id? (EN-030), next_call_at.
- **followup_adherence_checks** — id, patient_id, prescription_id, drug_id, expected_refill_date, actual_refill_date?, gap_days, risk_class enum(high/medium/low), check_status enum(pending/contacted/adherent/non_adherent/stopped_advised/stopped_self/switched/unreachable), reason enum(side_effects/cost/forgot/felt_better/other_doctor/supply)?, contacted_at, escalated_to_doctor bool, notes.
- **followup_cohorts** — id, hospital_id, code, name, criteria jsonb, enrolment_requires_clinician bool default true, care_calendar jsonb [{interval, visit_type, investigations[], education_ids[]}], owner_department_id, outcome_metrics jsonb, active.
- **followup_cohort_members** — cohort_id, patient_id, enrolled_at, enrolled_by, consent_id, status enum(active/paused/graduated/exited/deceased), exit_reason, last_review_at, next_due_at, adherence_score?, control_status? (e.g. HbA1c band, BP control — populated from validated results only).
- **followup_no_shows** — followup_id, appointment_id, marked_at, reengagement_status enum(pending/contacted/rebooked/declined/unreachable), barrier_reason enum(distance/cost/transport/timing/language/felt_better/other_provider/forgot/unknown)?, rebooked_appointment_id?, consecutive_count.
- **followup_batches** (bulk sends/IVR campaigns) — id, hospital_id, type, filter jsonb, count, channel, template_id, scheduled_at, executed_at, delivered, booked, created_by, dry_run bool.
- Read models: `analytics.mv_followup_funnel` (rule × department × advised/reminded/booked/attended), `mv_followup_noshow`, `mv_cohort_adherence`, `mv_post_discharge_outcomes` (calls made %, red-flag rate, 7/30-day readmission), `mv_adherence_gaps`.
- RLS on `hospital_id`; call records and answers are PHI (read-audited). Retention: follow-up and call records 8 years with the clinical record; contact logs 3 years.

## 5. Business Rules & Validations
- A follow-up generated by a rule is a **suggestion until the clinician confirms or overrides** at the consultation/discharge; critical-priority follow-ups (biopsy result, abnormal screening, post-op day-3 check) cannot be silently cancelled — cancellation requires a clinician's reason.
- **No clinical detail in message bodies.** Templates reference "a review with Dr X" and never the diagnosis, drug or result. Deep links are tokenised and expiring.
- All recall/reminder traffic is **service category** on DLT-registered templates. Marketing content may not be appended (system-enforced template separation from NC-026); a template flagged promotional is rejected for use here.
- Consent (EN-028): communications require the `service_comms`/`followup_recall` purpose; withdrawal stops messages but the follow-up remains actionable at the desk and in the portal.
- **Deceased** patients: all pending follow-ups cancel on `patient.deceased`; no message may be dispatched (hard block at the send layer, not just the query).
- Contact windows: automated messages 08:00–21:00; calls 08:00–20:00; no more than the configured attempts per follow-up (default 4) and per week (default 2) across all follow-ups for one patient, so a multi-morbid patient is not called five times.
- Post-discharge calls with a **red flag cannot be closed as routine**: escalation to the treating doctor/on-call is mandatory, with a recorded outcome; unacknowledged escalations escalate again after the configured minutes.
- Adherence checks for high-risk drugs must be attempted by call, not message alone.
- Cohort enrolment requires a clinician's action and patient consent; automated criteria only *propose* candidates.
- `followup.auto_booking` may create only *provisional* appointments in slots the department reserves for follow-ups, never displacing a booked patient, and always cancellable by the patient in one tap.
- No-show is recorded only when the appointment date has passed without attendance and without cancellation; "never booked" is a different state and is reported separately (conflating them flatters the numbers).
- Segregation: an agent may log an outcome but cannot alter the clinical follow-up plan; only clinicians change intervals or close critical follow-ups.
- Audit: every message, call, escalation and status change is logged with actor and timestamp; call recordings are referenced (EN-033), not stored here.

## 6. API Surface (`/api/v1/followups`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /followups?status=&due=&dept=&doctor=&cohort=&priority= | recall worklist | followup.list | – | cursor |
| POST | /followups | create manually / from doctor advice | followup.create | Y | – |
| GET/PATCH | /followups/{id} | detail / reschedule / close | followup.read/update | Y | – |
| POST | /followups/{id}/contact | log a contact attempt & outcome | followup.contact.log | Y | – |
| POST | /followups/{id}/book | book the appointment (OP-001) | followup.book | Y | – |
| POST | /followups/{id}/cancel | cancel with reason (clinician for critical) | followup.cancel | Y | – |
| POST | /followups/bulk-remind?dryRun= | batch reminder / IVR campaign | followup.batch.send | Y | – |
| GET/POST/PATCH | /rules | rule engine admin | followup.rule.read / .configure | Y | cursor |
| POST | /rules/{id}/simulate | how many follow-ups would this generate | followup.rule.configure | Y | – |
| GET | /call-tasks?type=post_discharge&due= | call worklist | followup.call.list | – | cursor |
| GET | /call-tasks/{id}/script | script for this patient/department | followup.call.list | – | – |
| POST | /call-tasks/{id}/record | submit answers, flags, escalation | followup.call.record | Y | – |
| POST | /call-tasks/{id}/escalate | escalate to doctor/on-call | followup.call.escalate | Y | – |
| GET/POST/PATCH | /scripts | script authoring (MS/HOD approval) | followup.script.configure | Y | cursor |
| GET | /adherence?risk=&status= ; POST /adherence/{id}/contact | adherence worklist | followup.adherence.manage | Y | cursor |
| GET/POST | /cohorts ; POST /cohorts/{id}/enrol ; DELETE /cohorts/{id}/members/{patientId} | cohort management | followup.cohort.read / .manage | Y | cursor |
| GET | /cohorts/{id}/board | on-track / overdue / lapsed | followup.cohort.read | – | cursor |
| GET | /no-shows?period=&dept= ; POST /no-shows/{id}/reengage | no-show handling | followup.noshow.manage | Y | cursor |
| GET | /lapsed?months=&condition= | lapsed-patient sweep | followup.lapsed.read | – | cursor |
| GET | /reports/conversion ; /reports/no-show ; /reports/post-discharge ; /reports/adherence | analytics | followup.report.read | – | – |
| GET | /patients/{id}/followups | patient view (also PE-001) | followup.read / patient self | – | cursor |

## 7. Domain Events (outbox)
- `followup.created` {type, due_date, priority, rule} → recall worklist, PE-001 card.
- `followup.reminder.sent` {channel, template} → EN-009/EN-032 delivery tracking.
- `followup.booked` {appointment_id} → OP-001; `followup.attended` {encounter_id} → funnel closure.
- `followup.no_show` {appointment_id, consecutive_count} → re-engagement queue, doctor notification on repeat.
- `followup.overdue` {days_over, priority} → escalation (critical → doctor).
- `followup.not_reachable|declined|cancelled` {reason}.
- `followup.call.completed` {status, red_flags[]} → clinical record note, EN-030 (if feedback given), NC-032 (if grievance).
- **`followup.call.red_flag`** {patient, flags, agent} → **treating doctor / on-call task (high priority)**, ER pre-alert if the patient agrees.
- `followup.adherence.gap` {drug, gap_days, risk} → doctor & pharmacist view.
- `followup.cohort.enrolled|exited|overdue` → care coordinator board, quality reporting.
- `followup.lapsed.identified` → outreach list (consent-checked).
- Consumes: `visit.consult.completed`, `ip.discharge.completed`, `procedure.completed`, `rx.created`, `rx.dispensed`, `lab.result.validated`, `rad.report.signed`, `immunisation.given`, `appointment.booked|cancelled|no_show`, `patient.deceased`, `consent.withdrawn`, `patient.merged`.

## 8. Screens
- **Recall Worklist** (desktop, agent home): filters (due today / overdue / this week, department, doctor, cohort, priority, language); list with patient, type, due date, days overdue, attempts, last outcome, contactability chip; inline actions — call (click-to-dial EN-033), WhatsApp/SMS (template preview), book (opens the slot picker inline), reschedule, close with reason. Shortcuts: `C` call, `M` message, `B` book, `N` note, `X` close, `↓/↑` next patient. Prioritised by clinical priority then due date; a visible daily counter (worked / remaining / booked). Empty state celebrates a cleared list.
- **Post-Discharge Call console** (desktop/tablet, nurse or trained agent): patient banner (diagnosis, procedure, discharge date, medicines, treating doctor), the **script** rendered as a form (Yes/No, 0–10 pain scale, choice, free text) with **red-flag fields highlighted**; a red flag turns the screen banner red and forces the escalation step; summary auto-composed into a note for the record; buttons — Escalate to doctor, Advise ER, Book review, Record feedback, Raise grievance. Offline: script cached, answers queue.
- **Follow-Up Rules Admin** (desktop): rules by trigger type with a builder (ICD/procedure/drug pickers, offsets, windows, channel plan timeline, escalation), simulate ("this rule would create 340 follow-ups/month"), approval status, version history.
- **Script Authoring** (desktop, nursing/MS): question builder with red-flag conditions, department scoping, versioning and approval.
- **Cohort Board** (desktop, care coordinator): cohort selector; columns *On track*, *Due*, *Overdue*, *Lapsed*, *Exited*; per-patient card with next due item, last values (HbA1c, BP, eGFR where available), adherence chip; bulk reminder; enrolment queue of clinician-proposed candidates.
- **Adherence Worklist** (desktop, pharmacist/coordinator): high-risk drug gaps first, expected vs actual refill, gap days, contact action, reason capture, escalate to doctor.
- **No-Show & Re-engagement** (desktop): today's no-shows with a same-day call action, barrier reason capture, tele-consult offer, repeat-no-show escalation list.
- **Doctor's Follow-Up view** (in OP-002/OP-019 and IP-010): "your patients due for review", "who did not return", escalations from post-discharge calls awaiting your response; one-tap change of interval.
- **Patient view** (PE-001/OP-020, phone): "Your next review is due on 12 Aug with Dr X — Book now / Choose tele-consult / Not needed (tell us why)", preparation instructions, and the attached education material.
- **Analytics dashboard** (desktop/TV admin): conversion funnel by rule/department/doctor, no-show rate and reasons, post-discharge call completion and red-flag rate, 7/30-day readmission among called vs not-called patients, adherence rates, cohort control metrics, channel effectiveness.
- WCAG 2.2 AA throughout; agent screens keyboard-first; patient content multilingual and plain-language.

## 9. Integrations
- **EN-009/EN-032/EN-037** (message channels; DLT service templates; delivery receipts), **EN-033** (click-to-dial, IVR campaigns for large recall sweeps, call recording references, inbound screen-pop with follow-up context), **OP-001** (slots and booking, no-show marking), **OP-002/IP-002** (clinical triggers and the doctor's follow-up advice), **OP-003** (prescription duration → refill expectation), **OP-004/OP-008** (investigations due before the visit; abnormal results as triggers), **OP-013** (immunisation due), **PE-001/OP-020** (patient card and one-tap booking), **PE-003/OP-038** (education attached to a follow-up), **PE-005** (annual health-check reminders — kept distinct from clinical recall), **EN-030** (feedback captured during post-discharge calls), **NC-032** (grievance), **EN-028** (consent), **NC-026** (strictly one-way: NC-026 may read conversion analytics but may not inject content into service templates), **EN-001/NC-011** (analytics).
- Fallbacks: WhatsApp failure → SMS → call; IVR unavailable → manual list; if the appointment service is down, the reminder still goes with a call-us instruction.

## 10. Reports & Analytics
- **Conversion funnel**: advised → reminder delivered → booked → attended, by rule, department, doctor, cohort, channel and branch; average days from due date to attendance; percentage of clinically advised follow-ups actually completed (the headline number most hospitals cannot produce today).
- **No-show**: rate by department/doctor/slot time/lead time, barrier reasons, repeat offenders, revenue impact, effect of reminders (A/B where cadences differ).
- **Post-discharge**: call completion rate within 48 h, red-flag rate by department and procedure, escalations and their outcomes, correlation with **7-day and 30-day readmission** and with ER returns (NABH indicators), patient-reported issues.
- **Adherence**: gap rate by drug class, reasons, resolution, and (where lab data exists) the association with control metrics.
- **Cohorts**: enrolment, retention, on-track %, overdue %, control rates (HbA1c < 7 %, BP < 140/90, eGFR trajectory), admissions per member-year.
- **Agent productivity**: contacts per agent, connect rate, bookings per contact, average handle time.
- Read models per §4; refreshed every 15 minutes for worklists and nightly for outcomes.

## 11. Notifications
- **Patient** (service templates, consent- and preference-aware, no clinical detail): follow-up due with a booking link and preparation instructions; reminder if unbooked; appointment confirmation; overdue nudge; post-discharge "we will call you tomorrow"; adherence check; immunisation/health-check due (PE-005/OP-013); tele-consult alternative offer.
- **Agent/coordinator**: today's list ready, high-priority follow-up overdue, call task due, escalation acknowledged/not acknowledged.
- **Doctor**: post-discharge red flag on your patient (push, immediate), critical follow-up overdue (biopsy result not collected), repeated no-shows on a clinically important review, adherence gap on a high-risk drug.
- **HOD/Quality**: weekly conversion and no-show digest, post-discharge call completion vs target, readmission indicator movement.
- **Admin**: cohort programme summary, channel cost and effectiveness.

## 12. Permissions (RBAC keys)
`followup.list|read` (Call centre, Front office, Nurse, Doctor for own patients, Coordinator) · `followup.create|update` (Doctor, Nurse, Coordinator; agents may reschedule but not change clinical intent) · `followup.cancel` (Coordinator for routine; **Doctor only** for critical-priority) · `followup.contact.log` (Agent, Front office, Nurse) · `followup.book` (Agent, Front office) · `followup.batch.send` (Coordinator/Call-centre lead; dry-run required above the configured size) · `followup.rule.read` (clinical roles) / `followup.rule.configure` (Coordinator lead + HOD/MS approval) · `followup.call.list|record` (Nurse, trained agent) / `followup.call.escalate` (same) · `followup.script.configure` (Nursing lead + MS approval) · `followup.adherence.manage` (Pharmacist, Coordinator, Doctor) · `followup.cohort.read` (clinical) / `followup.cohort.manage` (Coordinator + clinician enrolment) · `followup.noshow.manage` (Front office, Coordinator) · `followup.lapsed.read` (Coordinator; consent-filtered) · `followup.report.read` (HOD, MS, Quality, Admin, Marketing for conversion only).

## 13. Non-functional
- **Volumes** (2000 beds, 5,000 OP/day): 1,200–2,000 follow-ups generated/day; 150 discharges/day → 300 post-discharge call tasks/day; 3,000–6,000 reminder messages/day; recall backlog of 20k–40k open follow-ups.
- **Performance**: recall worklist p95 < 200 ms over 40k open rows (due date and priority indexed); rule evaluation on a consultation event < 100 ms (rules pre-compiled per trigger type, not scanned); batch of 5,000 reminders dispatched < 10 min through EN-009 throttling; call script render < 300 ms on a tablet.
- **Reliability**: message dispatch is idempotent and retried; a failed channel falls back per the plan; no double-messaging on retry (dedupe key = followup_id + step).
- **Offline**: agent worklists and call scripts cached read-only; outcomes and answers queue in IndexedDB and sync with the original timestamps.
- **Printing**: call sheets for outreach/camps, cohort review lists, patient follow-up card printed with the discharge summary/visit summary (still the most reliable reminder for many patients).
- **Accessibility/i18n**: patient messages in the patient's language with plain wording; agent scripts available in the local language so the agent reads naturally; WCAG 2.2 AA.
- **Security/privacy**: no diagnosis in message bodies; call answers are PHI with read audit; agent access scoped to assigned lists; consent state checked at send time (not at generation time) so a withdrawal takes immediate effect.

## 14. Acceptance Criteria
1. Given a consultation coded E11.9 with a rule "review in 3 months, HbA1c 2 weeks prior", when the consult is completed, then two follow-ups are created with the correct due dates, and the doctor's override of the interval is recorded and honoured.
2. Given a follow-up due in 7 days, then the T−7 message is sent on the DLT service template with no diagnosis in the body and a tokenised booking link that opens the correct doctor's slot picker.
3. Given the patient books from the link, then the follow-up moves to `booked`, the reminder cadence stops, and attendance later moves it to `attended`.
4. Given a patient is recorded deceased, then all pending follow-ups are cancelled immediately and the send layer blocks any queued message for that patient (verified by test).
5. Given communication consent is withdrawn, then no messages are sent, the follow-up remains visible to the desk and in the portal, and the withdrawal takes effect on the very next send cycle.
6. Given an IP discharge, then a 48-hour post-discharge call task is created with the department's script and assigned to the configured role.
7. Given a post-discharge call where the patient reports fever and wound discharge, then the call cannot be closed as routine, an escalation task reaches the treating doctor/on-call immediately, and an unacknowledged escalation re-escalates after the configured interval.
8. Given a high-risk drug (warfarin) whose refill is 7 days overdue, then an adherence check is created requiring a call, and the reason captured is visible to the doctor at the next consultation.
9. Given a booked follow-up that is not attended and not cancelled, then it is marked `no_show` (distinct from "never booked"), a same-day re-engagement task is created, and three consecutive no-shows on a critical follow-up escalate to the doctor.
10. Given a critical follow-up (biopsy result) that is overdue by the configured days, then the treating doctor is notified and the follow-up cannot be closed by an agent.
11. Given a patient with four different follow-ups due in the same week, then the per-patient contact cap prevents more than the configured number of automated messages, and the agent sees them consolidated.
12. Given a cohort's criteria match a patient, then the patient appears as a *proposed* candidate and is enrolled only after a clinician's action and recorded consent.
13. Given a bulk reminder batch of 5,000 with `dryRun=true`, then the system reports the recipient count, channel split and suppressed records (consent withdrawn, deceased, DND-irrelevant) without sending anything.
14. Given an agent, when they attempt to change a follow-up's clinical interval, then it is denied (agents may reschedule appointments, not clinical intent).
15. Given the conversion report for a department, then advised, reminded, booked and attended counts reconcile with the underlying tables and "never booked" is reported separately from "no-show".
16. Given 40,000 open follow-ups, then the recall worklist loads p95 < 200 ms and ordering matches the priority-then-due-date rule.
17. Given a message is retried after a channel failure, then the patient does not receive a duplicate (dedupe on followup_id + cadence step).
18. Given a post-discharge call reveals dissatisfaction with the ward, then a grievance is created in NC-032 with a reference number and the patient is told the reference.

## 15. Enhancements / Later phases
- From the VIMS sheet (row 143 / proposal PE-002): auto follow-up reminder, recall list, no-show tracking, post-discharge call scheduling — all core above, extended with rules by diagnosis/procedure/drug, adherence, cohorts and conversion analytics.
- (market) WhatsApp-triggered post-visit engagement after billing/discharge (SmartHospital); omni-channel patient communication (MocDoc); mobile app + web + token calling as one reminder surface (SMART HMIS).
- Later: **no-show prediction** (AI-005) so high-risk appointments get an extra human call and over-booking is data-driven; best-time-to-contact and best-channel models; **conversational follow-up** on WhatsApp (AI-001) where the patient answers the post-discharge questions by chat and only red flags reach a human; voice-bot IVR for low-literacy cohorts in local languages (AI-004); PROM instruments (Oxford Knee Score, KCCQ, PHQ-9) collected before the review so the visit is more useful; home-monitoring integration (BP, glucose, weight via EN-042) feeding cohort control metrics; transport/appointment-clash barrier removal (offer tele-consult automatically for review-only visits); risk-stratified post-discharge intensity (daily calls for heart failure, single call for day-care); linkage to readmission-prevention pathways (IP-020); pharmacy auto-refill scheduling with home delivery.

## 16. Open Questions for the Hospital
1. Which diagnoses and procedures must have automatic follow-up rules first (top 20 by volume and by clinical risk)?
2. Do you make post-discharge calls today? For which patients, at what interval, by whom (nurse or call centre), and is there a script?
3. What are your red-flag criteria and escalation path for a post-discharge call — who is called at 22:00 on a Sunday?
4. Should the system auto-create provisional follow-up appointments, or only advise and let the patient book? If auto, are follow-up slots reserved?
5. Reminder cadence you want (T−7, T−2, T-day call?), and the maximum contacts per patient per week across all follow-ups.
6. Which chronic-care cohorts do you want to run, who owns them clinically, and what care calendar applies to each?
7. For medication adherence: which drug classes must trigger a call rather than a message?
8. Who marks a no-show today, and do you capture the reason? What is your current no-show rate by department?
9. What is your lapsed-patient definition (no visit for how many months) and are you comfortable with re-engagement outreach for chronic patients (consent-checked)?
10. Do you want to offer a tele-consult alternative automatically for review-only follow-ups?
11. Which languages must the call scripts and patient messages support, and do your agents read the local language comfortably?
12. What follow-up completion rate and 30-day readmission rate do you report today (baseline for the dashboard), and to whom?
