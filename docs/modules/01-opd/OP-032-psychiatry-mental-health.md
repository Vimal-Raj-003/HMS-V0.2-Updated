# OP-032 — Psychiatry / Mental Health (Screening tools PHQ-9/GAD-7/MMSE/others, Session notes with restricted visibility, MHCA 2017 compliance, Risk assessment & safety plans, Follow-up, Psychology/counselling, De-addiction)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-032 |
| Phase | 8 |
| Priority | P2 |
| Complexity | Medium-High |
| Depends on | **OP-025 §0 (shared specialty console framework)**, OP-002 (encounter, e-Rx), OP-003/EN-029 (psychotropic rules: clozapine ANC monitoring, lithium levels, QTc, MAOI interactions, benzodiazepine H1/NDPS schedules), OP-004 (lithium/valproate levels, CBC, LFT/TFT, UDS), OP-029 (ECG QTc), OP-034 (geriatric cognition), OP-033 (child & adolescent), OP-016 (chronic pain co-morbidity), OP-018 (tele-psychiatry, MHCA telemedicine guidelines), IP-001/IP-003 (psychiatric admissions: MHCA independent/supported admission forms), IP-006/IP-024 (ECT under anaesthesia), OP-010 (ECT/rTMS as procedures), EN-028 (consent, advance directive, nominated representative), EN-039 (scales/forms), EN-030 (patient-completed scales), EN-024/EN-007 (restricted-record ABAC & break-glass), PE-002 (follow-up/relapse recall), EN-009 (privacy-safe messages), NC-015 (incidents: self-harm, restraint), OP-021, OP-038, NC-003 (MRD legal holds) |
| Feature flag | `module.psychiatry.enabled` (sub: `psy.counselling`, `psy.deaddiction`, `psy.ect_rtms`, `psy.child_adolescent`, `psy.mhca_ip`) |
| Primary roles | Psychiatrist (6), Clinical psychologist / Counsellor (42), Psychiatric social worker (42 family), Psychiatric nurse (16/17), Resident (14) |
| Secondary roles | Neurologist/geriatrician/paediatrician (referrers), ER physician (8, self-harm), Anaesthetist (ECT), Pharmacist (30), MRD (43), Medical Superintendent (4, MHCA/legal), Privacy Officer (57), Patient / Nominated Representative |
| Regulatory | **Mental Healthcare Act 2017** (rights, capacity, advance directive, nominated representative, admission categories §86/§89/§90, minors §87, Mental Health Review Board reporting, prohibition of unmodified ECT, ECT for minors only with MHRB permission, restraint/seclusion documentation, confidentiality §23, non-disclosure of records except as permitted, register of admissions), Narcotic Drugs and Psychotropic Substances Act (benzodiazepines/methylphenidate H1/X registers), Section 309 IPC decriminalised attempts (MHCA §115) — MLC handling for self-harm per state, POCSO/JJ Act for minors, Telemedicine Practice Guidelines 2020 (Schedule X not via tele), NABH, DPDP (mental health = sensitive personal data), Rights of Persons with Disabilities Act 2016 (mental illness disability certification IDEAS scale) |

## 1. Purpose
OP-032 provides a confidential mental-health record: **standardised screening & outcome scales** (PHQ-9, GAD-7, MMSE/MoCA, HAM-D/HAM-A, YMRS, PANSS/BPRS, MADRS, Y-BOCS, PCL-5, AUDIT/ASSIST, Edinburgh PDS, Vanderbilt/CBCL, IDEAS disability, C-SSRS risk) with auto-scoring/trends and patient self-completion, **structured psychiatric assessment & MSE**, **session/therapy notes with restricted visibility** (psychotherapy notes segregated from the general chart), **risk assessment & safety planning** with escalation, psychotropic prescribing safeguards, follow-up/relapse-prevention, counselling/psychology sessions, de-addiction programme (withdrawal scales CIWA-Ar/COWS, opioid substitution registers), ECT/rTMS documentation, and **MHCA 2017 compliance** (capacity, advance directives, nominated representative, admission category forms & MHRB reporting for IP, restraint/seclusion registers). Framework per OP-025 §0 with stricter ABAC.

## 2. Users & Jobs-to-be-done
- **Psychiatrist** (desktop/tablet; 30–50 pts/day): assess (history/MSE), score scales, diagnose (ICD-10 F00–F99; ICD-11 6A–6E optional), assess risk, prescribe with safeguards, plan therapy/ECT/admission, MHCA documentation, tele-consults.
- **Psychologist/counsellor**: psychometric assessments (IQ/neuropsych batteries as attachments), therapy sessions (CBT/DBT/family) with session notes and homework, outcome scales; notes private by default.
- **Psychiatric social worker**: psychosocial assessment, family/community follow-up, disability certification support, rehabilitation linkages, MHRB liaison.
- **Nurse**: vitals, self-completed scales on tablet, injectable depot administration & schedule, ECT prep/recovery, restraint monitoring (IP).
- **Patient/NR**: self-scales via app/tablet, safety plan card, appointments; advance directive; access to own records per MHCA §25.

## 3. Core Workflows
### 3.1 Intake, screening & assessment
1. Console tabs: Screening · Assessment/MSE · Risk & safety · Session notes (restricted) · Rx & monitoring · Therapy/Counselling · De-addiction · ECT/rTMS · MHCA/Legal · Follow-up.
2. Pre-visit / waiting-room self-scales (tablet kiosk or app link; EN-030): PHQ-9, GAD-7, others per clinic config → auto-score, severity bands (PHQ-9: 0–4/5–9/10–14/15–19/20–27), **PHQ-9 item 9 > 0 or C-SSRS positive → immediate risk alert** to psychiatrist/nurse before consult (task in rail; patient not left unattended per protocol).
3. Psychiatric assessment (EN-039 structured): presenting complaints, HPI, past psychiatric/medical, substance history (AUDIT/ASSIST), family/personal/developmental history, premorbid personality, **MSE** (appearance, behaviour, speech, mood/affect, thought form/content incl. delusions, perception, cognition — MMSE/MoCA embedded, insight, judgement), physical/neurological, capacity assessment (MHCA §4 criteria), diagnosis (ICD-10 with multi-axial notes), formulation, plan; child/adolescent variant (`psy.child_adolescent`: developmental, school, Vanderbilt/CBCL, POCSO/JJ flags, guardian consent).
### 3.2 Risk assessment & safety planning
- Structured risk (suicide/self-harm C-SSRS, harm to others, neglect, absconding, vulnerability), protective factors, risk level (low/moderate/high) → **safety plan** (warning signs, coping, contacts, means restriction, crisis lines e.g. Tele-MANAS 14416/KIRAN) printed/app card; high risk → escalation options (same-day admission IP-001 with MHCA category, family involvement with consent/necessity, ER OP-006 if medical), follow-up call within 24–72 h (PE-002); every risk change logged; self-harm presentation → MLC per state policy (TR-008 link) without criminalising language.
### 3.3 Session notes (restricted visibility)
- Two note classes: **clinical summary** (visible to care team per normal ABAC: diagnosis, meds, plan, risk level) and **psychotherapy/session notes** (visible only to author, supervising consultant, and explicitly shared clinicians; excluded from discharge summaries, referral letters, portal exports, and ABDM sharing unless patient explicitly consents per note-class); break-glass READ_PHI audited & Privacy Officer notified; session note fields: modality (CBT/DBT/IPT/family/group), goals, interventions, homework, outcome scale, duration, next session; group therapy attendance without cross-patient linkage in individual charts.
### 3.4 Prescribing & monitoring
- Psychotropic e-Rx via OP-002 with **EN-029 psychiatry rule set**: clozapine (registration, baseline & weekly/fortnightly/monthly ANC schedule; dispensing blocked if ANC overdue/low), lithium (levels 5–7 days after change, 3–6 monthly; renal/thyroid yearly; toxicity alerts), valproate (LFT/levels; pregnancy hard-stop for females of child-bearing potential without justification), carbamazepine (HLA-B*1502 note), antipsychotics (metabolic monitoring: weight/BMI/waist/BP/FBS/lipids baseline-3 mo-yearly; QTc for haloperidol/ziprasidone/citalopram doses), MAOI interactions, benzodiazepine (H1 register, duration warnings, dependence flag), stimulants (Schedule X; not via tele-Rx), depot injections schedule (nurse task list, missed-depot alert), polypharmacy > 3 psychotropics warning; monitoring calendar per patient with overdue flags.
### 3.5 Counselling/psychology (`psy.counselling`) & de-addiction (`psy.deaddiction`)
- Psychology referrals, psychometric test scheduling (IQ, personality, neuropsych) with report upload (OP-022), therapy course (n sessions, package OP-023), outcome tracking (PHQ-9/GAD-7/CORE-OM); de-addiction: substance profile, withdrawal scales (CIWA-Ar, COWS) with scoring & symptom-triggered protocols, detox plan (OP vs IP), OST/ buprenorphine/naltrexone registers (NDPS dispensing rules, daily observed dosing log), relapse-prevention sessions, family programme, urine drug screens (OP-004), rehab centre referral.
### 3.6 ECT/rTMS (`psy.ect_rtms`, via OP-010 + IP-024)
- ECT course: indication, capacity/consent (patient; if lacking capacity, NR consent per MHCA §94 rules; **minors require MHRB permission — hard-stop**), anaesthesia PAC, pre-ECT checklist, session record (electrode placement, stimulus dose/charge, seizure duration EEG/motor, anaesthetic agents, complications, recovery Aldrete), cognitive monitoring (MMSE pre/post course), max sessions/course; rTMS: protocol (site, frequency, intensity % MT, pulses, sessions), session log, adverse effects.
### 3.7 MHCA 2017 compliance (`psy.mhca_ip` for IP; OP parts always on)
- **Advance directive** & **nominated representative** registration (EN-028 documents, validity, MHRB registration ref); **capacity assessment** template; IP admission categories (independent §86, supported §89 (30 days) / §90 (90 days+), minors §87, emergency §94) with mandatory forms, timelines & MHRB intimation (7 days for §89/§90 supported, minors, etc.), review/extension timers, discharge & leave documentation, **restraint/seclusion register** (order, reason, duration, monitoring q15 min, NR informed, MHRB monthly report), **register of admissions**, complaint route to MHRB; DPDP: sensitive data flags, patient's right to access records (MHCA §25) with clinician-flagged exceptions.
### 3.8 Follow-up & relapse prevention
- Follow-up scheduling by risk/diagnosis; missed appointment → recall (PE-002) with privacy-safe messaging (no diagnosis in SMS); relapse signature plan; caregiver education (OP-038); disability certificate (IDEAS scale) workflow; tele-psychiatry (OP-018) with MHCA telemedicine constraints.
### 3.9 Exceptions
- Patient refuses scales; caregiver reports risk; break-glass by ER; note-class change (summary ↔ session) requires author action with audit; record request by court/police handled through MRD legal (NC-003) with MS approval; offline: scales/assessment cached encrypted.

## 4. Data Model (schema `specialty`; ABAC-restricted)
- **psy_episodes**: id, hospital_id, branch_id, patient_id, opened_at, primary_dx_icd10, dx_history jsonb, risk_level enum(low/moderate/high), lead_clinician_id, care_team uuid[], status enum(active/remission/discharged/transferred/lost), sensitivity enum(standard/high), version; index (hospital_id, patient_id, status).
- **psy_scales**: id, episode_id?, patient_id, encounter_id?, scale enum(phq9/gad7/mmse/moca/hamd/hama/ymrs/panss/bprs/madrs/ybocs/pcl5/audit/assist/epds/vanderbilt/cbcl/ideas/cssrs/ciwa/cows/core_om/other), items jsonb, total numeric, severity_band, item9_flag bool, completed_by enum(patient/clinician/caregiver), form_response_id, at; index (patient_id, scale, at).
- **psy_assessments**: id, episode_id, encounter_id, type enum(initial/followup/child/capacity), content jsonb (structured history, MSE), capacity jsonb (criteria, outcome), formulation, note_class enum(summary), signed_by/at, version.
- **psy_risk_assessments**: id, episode_id, encounter_id?, at, cssrs jsonb, domains jsonb (suicide/violence/neglect/absconding/vulnerability with levels), protective jsonb, overall enum(low/moderate/high), actions jsonb, escalated_to uuid[], by; **psy_safety_plans**: id, episode_id, version, content jsonb, shared_with jsonb, printed_at, pdf_key.
- **psy_session_notes**: id, episode_id, encounter_id?, author_id, note_class enum(session_restricted), modality enum, duration_min, goals, interventions, homework, outcome_scale_id?, next_at, visibility jsonb ({shared_with: uuid[], patient_consent_share: bool}), signed_at, version; RLS + ABAC policy: author/supervisor/shared only. Partition none; index (episode_id, at).
- **psy_med_monitoring**: id, patient_id, drug enum(clozapine/lithium/valproate/carbamazepine/antipsychotic_metabolic/benzo/stimulant/depot), schedule jsonb, last_result jsonb, next_due, status enum(ok/due/overdue/blocked); **psy_depot_schedule**: patient_id, drug, dose, interval_days, next_due, administered jsonb[].
- **psy_therapy_courses**: id, episode_id, therapist_id, modality, planned_sessions, done_sessions, package_booking_id?, outcome jsonb; **psy_group_sessions**: id, group_id, at, facilitator, attendee_count (attendees stored in separate restricted link table).
- **psy_deaddiction**: id, episode_id, substances jsonb, withdrawal_scores jsonb[], detox_plan, ost jsonb (drug, dose, dispensing_log[], register_no), uds jsonb, relapse_log jsonb, status.
- **psy_ect_courses**/**psy_ect_sessions**: course (indication, consent_id, nr_consent_id?, mhrb_permission_ref?, capacity_id, max_sessions), session (seq, placement, charge_mc, seizure_sec, anaesthesia jsonb, complications, aldrete, cognition_pre/post); **psy_rtms_courses/sessions** analogous.
- **mhca_documents**: id, patient_id, type enum(advance_directive/nominated_representative/capacity/admission_86/admission_89/admission_90/minor_87/emergency_94/leave/discharge/restraint_order/seclusion/mhrb_intimation/mhrb_report), refs jsonb, valid_from/to, mhrb_ref, deadline_at, submitted_at, status enum(draft/signed/submitted/ack/expired), signed_by, doc_id (EN-028/NC-004); **restraint_events**: admission_id, started_at, ended_at, type enum(physical/chemical/seclusion), reason, ordered_by, monitoring jsonb (q15), nr_informed_at, reported_at.
- **psy_followups**: episode_id, due_at, kind enum(visit/call/tele), status, outcome.
- Enums: `psy_scale`, `risk_level`, `note_class`, `mhca_doc_type`, `restraint_type`.

## 5. Business Rules & Validations
- Scales auto-scored with validated algorithms; PHQ-9 item 9 ≥ 1 or C-SSRS ideation with plan/intent → `psy.risk.alert` within 60 s to psychiatrist & clinic nurse; alert acknowledgement mandatory; unacknowledged 15 min → HOD escalation.
- Session notes: default visibility author + supervising consultant; sharing explicit per clinician; excluded from summaries/exports/ABDM unless patient consent flag; break-glass requires reason & notifies Privacy Officer; printing session notes watermarked and audited.
- Prescribing safeguards (EN-029): clozapine dispensing blocked without in-window ANC (weekly first 18 wk, then fortnightly, then monthly — config); lithium level > 1.2 → alert; valproate in female 12–50 → hard-stop unless documented justification + contraception; stimulants not via tele; benzodiazepines > 4 weeks → dependence review prompt; QTc check when combined risk; metabolic monitoring overdue → banner.
- ECT: consent (patient/NR per MHCA), anaesthesia PAC & modified ECT only (unmodified prohibited hard-stop), minors need MHRB permission reference before session 1; max sessions/course configurable; cognitive test pre/post course mandatory.
- MHCA IP: admission category selection drives mandatory forms & timers (e.g. §89 MHRB intimation within 7 days; 30-day limit → review/§90 conversion prompt); restraint requires psychiatrist order within 1 h & q15-min monitoring entries; monthly MHRB restraint report auto-compiled; register of admissions maintained.
- Privacy: no diagnosis/drug names in SMS/WhatsApp; queue/TV boards show token only (EN-006 setting for psychiatry counters); records tagged sensitive for DPDP; MRD legal disclosure only via MS approval workflow (NC-003).
- Minors: guardian consent; POCSO mandatory reporting workflow prompt when abuse disclosed (task to MS/social worker; audit).
- Follow-up: high-risk episodes must have follow-up ≤ 7 days; missed → nurse call task within 24 h.
- Documents immutable after sign; note-class immutable after sign (new note if reclassifying); retention per MHCA/clinical policy.

## 6. API Surface (`/api/v1/psy`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /worklist | clinic worklist (risk chips) | psy.visit.read | – | cursor |
| POST/GET/PATCH | /episodes, /episodes/{id} | episode | psy.episode.create/read/update | Y | cursor |
| POST/GET | /scales, /patients/{id}/scales?scale= | scoring/trends | psy.scale.record/read (+ patient self) | Y | cursor |
| POST/PUT | /episodes/{id}/assessments | assessment/MSE/capacity | psy.assessment.record/sign | Y | – |
| POST/GET | /episodes/{id}/risk, /safety-plans | risk & safety | psy.risk.record/read | Y | – |
| POST/GET/PATCH | /episodes/{id}/session-notes, /session-notes/{id}/share | restricted notes | psy.session_note.create/read_own/read_shared/share | Y | cursor |
| POST | /session-notes/{id}/break-glass | emergency read | psy.session_note.break_glass | Y | – |
| GET/POST | /monitoring, /depots | med monitoring/depot | psy.monitoring.manage | Y | cursor |
| POST/GET | /therapy/courses, /groups | counselling | psy.therapy.manage | Y | cursor |
| POST/GET | /deaddiction, /deaddiction/{id}/ost-dispense | de-addiction/OST | psy.deaddiction.manage / psy.ost.dispense | Y | cursor |
| POST/GET | /ect/courses, /ect/sessions, /rtms | ECT/rTMS | psy.ect.manage/record | Y | cursor |
| POST/GET/PATCH | /mhca/documents, /mhca/restraints | MHCA | psy.mhca.manage / psy.restraint.record | Y | cursor |
| GET | /mhca/reports/mhrb?month= | MHRB report | psy.mhca.report | – | – |
| POST/GET | /followups | follow-up | psy.followup.manage | Y | cursor |
| GET | /reports/kpis | KPIs (aggregate only) | psy.report.read | – | – |

## 7. Domain Events (outbox)
- `psy.scale.recorded` {scale, total, band}, `psy.risk.alert` {level, source} → EN-037 (push/call), `psy.risk.updated`, `psy.assessment.signed`, `psy.session_note.created` (no content), `psy.session_note.break_glass` → Privacy Officer, `psy.monitoring.due|blocked` (clozapine), `psy.depot.due|missed`, `psy.ect.session.recorded`, `psy.mhca.deadline_due|breached`, `psy.restraint.started|ended`, `psy.followup.missed`, `psy.ost.dispensed` (NDPS register OP-003).
- Consumes: `lab.result.final` (ANC/lithium/UDS), `rx.created` (safeguard hooks), `admission.created` (MHCA forms), `er.selfharm.flagged` (OP-006), `visit.no_show`, `consent.recorded` (EN-028 AD/NR).

## 8. Screens (UI)
1. **Psychiatry worklist** (desktop): token-only names option, risk chip (red), scales completed chip, monitoring overdue.
2. **Self-assessment kiosk/tablet & app** (patient): scale wizard (large text, regional languages, audio option), submit → clinician alert if flagged; no score shown to patient unless configured.
3. **Assessment & MSE workspace** (desktop): structured sections with quick-phrase pickers, embedded MMSE/MoCA with drawing capture, capacity checklist, `Ctrl+Enter` sign.
4. **Risk & safety plan** (desktop/tablet): C-SSRS flow, risk matrix, action buttons (admit/ER/family/follow-up call), safety plan builder with print/app card.
5. **Session notes** (desktop): lock icon, visibility panel (shared_with), timer, homework list; break-glass dialog with reason.
6. **Rx & monitoring board**: patients on clozapine/lithium/depots with due/overdue, block status.
7. **De-addiction desk**: withdrawal scale entry with protocol prompts, OST daily dispensing log (barcode/photo/thumb optional), UDS results.
8. **ECT suite** (tablet): checklist, session record with anaesthesia (IP-024), recovery.
9. **MHCA/legal console** (desktop): AD/NR registry, admission category forms, timers & MHRB submissions, restraint register, monthly report.
10. **Follow-up board**, **Tele-psychiatry** (OP-018 embedded).
- Empty/error: unacknowledged risk alert banner cannot be dismissed without action.

## 9. Integrations
- EN-030 self-scales (tablet/app/WhatsApp flow), EN-029 psychiatry rule set, OP-003 H1/X/NDPS registers & OST dispensing, OP-004 levels/ANC, OP-029 ECG QTc, OP-018 tele (MHCA/Telemedicine guideline constraints), EN-028 AD/NR/consent with e-sign, NC-003 legal disclosure workflow, EN-024 audit/break-glass, MHRB portal (state; manual/CSV via EN-017), Tele-MANAS/KIRAN helpline numbers in safety plan, EN-011 ABDM (share only summary class with consent), RPwD disability certificate (IDEAS).

## 10. Reports & Analytics
- Aggregate only (no line-level exports without `psy.report.export` + Privacy Officer): visits by diagnosis group, scale outcome change (PHQ-9 response/remission), risk alerts & response times, follow-up adherence, clozapine/lithium monitoring compliance, depot adherence, therapy course completion, de-addiction retention/relapse, ECT sessions & complications, MHCA timers compliance, restraint hours/1000 patient-days, MHRB reports, tele-psychiatry share. Read model `analytics.psy_monthly` (k-anonymised).

## 11. Notifications
- Patient (privacy-safe: no diagnosis): appointment/scale reminders, safety plan card, medication/lab reminders ("your review test is due"), depot due, follow-up call scheduling. Staff: risk alert (push + escalation), monitoring blocks, MHCA deadlines, missed high-risk follow-up, break-glass notification to Privacy Officer, restraint > 4 h review.

## 12. Permissions (RBAC keys)
`psy.visit.read`, `psy.episode.create|read|update`, `psy.scale.record|read`, `psy.assessment.record|sign`, `psy.risk.record|read|ack`, `psy.session_note.create|read_own|read_shared|share|break_glass`, `psy.monitoring.manage`, `psy.therapy.manage`, `psy.deaddiction.manage`, `psy.ost.dispense`, `psy.ect.manage|record`, `psy.mhca.manage|report`, `psy.restraint.record`, `psy.followup.manage`, `psy.report.read|export`, `psy.configure`. Defaults: Psychiatrist — all clinical, mhca.manage; Psychologist/counsellor — scales, session_note.create/read_own, therapy.manage, risk.record; PSW — followup, mhca docs (draft), deaddiction (non-Rx); Nurse — scale.record, monitoring (entry), depot admin, restraint.record, ost.dispense (2-person); Resident — record no sign; ER physician — risk.read + break_glass; MS — mhca.report; Privacy Officer — audit views; Patient — own scales/safety plan; other doctors — summary class only via ABAC.

## 13. Non-functional
- Volumes: 150 psychiatry visits/day, 400 scales/day, 60 therapy sessions/day, OST 100 dispensings/day; risk alert delivery < 60 s; scale scoring client + server; session-note storage encrypted at rest with separate key scope; RLS + ABAC policies unit-tested; offline: scales & assessments cached encrypted (device PIN required); print: safety plan card (wallet size, regional), MHCA forms (statutory formats), MHRB reports; TV/queue displays token-only; accessibility: audio-assisted scales.

## 14. Acceptance Criteria (plus OP-025 §0.9)
1. Given a patient completes PHQ-9 on the kiosk with item 9 = 2, then the psychiatrist and clinic nurse receive an alert within 60 s and the worklist shows a red risk chip; the alert cannot be cleared without an acknowledgement action.
2. Given a psychologist's session note, when another consultant not in shared_with opens the episode, then session notes are hidden and the summary is visible; break-glass shows the note, records reason, and notifies the Privacy Officer.
3. Given a discharge summary/referral letter is generated, then session-restricted notes are never included; the summary class content is.
4. Given clozapine prescribed and last ANC 3 weeks ago in the weekly phase, then pharmacy dispensing is blocked with reason and the monitoring board shows "blocked".
5. Given valproate ordered for a 28-year-old female without justification, then hard-stop; with justification + contraception documented, Rx proceeds and audit records it.
6. Given a supported admission §89 recorded, then MHRB intimation deadline (7 days) timer starts and breach escalates to the Medical Superintendent; 30-day limit prompts review.
7. Given a restraint event started, then a psychiatrist order within 1 h and q15-min monitoring entries are required; missing entries raise alerts; monthly MHRB report includes the event.
8. Given ECT planned for a 16-year-old without MHRB permission reference, then session recording is blocked.
9. Given a high-risk episode with no follow-up booked within 7 days, then a nurse call task is created.
10. Given SMS reminders are sent to psychiatry patients, then message templates contain no diagnosis or drug names (template lint test).
11. Given a resident tries to sign an assessment, then 403 and audit; consultant co-sign works.
12. Given a KPI report is exported, then it contains aggregate counts only, and line-level export requires `psy.report.export`.

## 15. Enhancements / Later phases
- Sheet row 69 (Screening tools, Session notes, PHQ-9, GAD-7, Follow-up) — core. Market: MHCA compliance console, restricted note classes, de-addiction/OST, ECT/rTMS, tele-psychiatry, patient self-scales.
- Later: AI-004 ambient scribe with consent (restricted class), AI-005 relapse/no-show prediction (aggregate), digital therapeutics/CBT modules in app (PE-001), community mental-health outreach (NC-035), school mental-health programmes, MHRB portal API when available, wearable sleep/activity import.

## 16. Open Questions for the Hospital
1. Services offered: OP only or psychiatric IP beds (MHCA registration as mental health establishment)? ECT/rTMS available?
2. Which scales are standard per clinic; languages; self-completion via kiosk/app?
3. Session-note visibility policy (supervisor access, sharing rules) and printing policy?
4. De-addiction/OST centre licence & NDPS registers? Which drugs?
5. State MHRB reporting formats & MLC policy for self-harm; POCSO reporting workflow owner?
6. Clozapine/lithium monitoring schedules and metabolic monitoring policy?
