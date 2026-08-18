# IP-003 — Nursing Station (ward dashboard, scheduled vitals with NEWS2/PEWS/MEWS, MAR with 5 Rights, I/O, SBAR notes, assessments, care plans, handover, nurse call, restraints)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-003 |
| Phase | 7 |
| Priority | P0 |
| Complexity | Very High |
| Depends on | IP-001 (admissions/beds/census), OP-002 (CPOE: medication, lab, imaging, diet, nursing orders), OP-007 (vitals device patterns), EN-029 (CDSS: NEWS2/PEWS/MEWS, sepsis, allergy/interaction, dose range), EN-013 (wristband & drug barcodes), IP-014 (ward stock/unit dose, narcotic double-check), OP-003 (pharmacy), OP-004/OP-008 (results), IP-004 (nursing mobile), IP-010 (doctor mobile), IP-005 (nursing/consumable charge posting), IP-002 (discharge checklist), IP-006 (pre-op checklist), IP-007 (transfusion bedside), IP-009 (ICU flowsheet extends this), IP-012 (isolation, HAI), IP-013 (code blue), OP-011 (diet), OP-015 (physio), NC-030 (roster, ratios, workload), NC-018 (housekeeping), EN-018 (ward TV), EN-037 (alerts/escalation), EN-039 (forms), EN-042 (device gateway: monitors, nurse call), EN-024 (audit), NC-015 (quality indicators, incidents) |
| Feature flag | `module.nursing_station.enabled` (sub: `nursing.barcode_mar`, `nursing.news2`, `nursing.pews`, `nursing.mews`, `nursing.sepsis_screen`, `nursing.nurse_call`, `nursing.workload`, `nursing.restraints`, `nursing.care_plans`) |
| Primary roles | Nurse — Ward (17), Nurse — ICU (18, via IP-009), Nurse Supervisor/Matron (22), Ward in-charge |
| Secondary roles | Doctor — IP (7), Resident (14), Surgeon (9), Intensivist (11), Pharmacist IP (31), Dietician (39), Physio (40), Ward boy (23), Infection control nurse (21), Quality (54), Patient/Family (60, nurse call/education), Auditor (58) |
| Regulatory | NABH 5th ed. COP.2 (initial assessment ≤ 24 h, reassessment), COP.4 (nursing care plan), COP.5 (high-risk patients), COP.7 (restraints), COP.11/12 (pain, falls, pressure injury), MOM.5–MOM.7 (medication administration, high-alert drugs, verbal orders read-back, self-medication), PSQ (indicators: medication errors, falls, pressure injuries, NEWS2 escalation), NABH nursing indicators, INC (Indian Nursing Council) documentation norms, RCP NEWS2 (2017), PEWS (Brighton/Bedside), Modified Early Obstetric Warning Score, ISMP high-alert medication list, WHO 5 Rights/9 Rights, NDPS Act (narcotic administration record), DPDP, BMW 2016 (sharps) |

## 1. Purpose
IP-003 is the nurse's operating system for the ward: a live ward dashboard (acuity, alerts, tasks), scheduled vitals with automatic early-warning scores and escalation, an electronic Medication Administration Record generated from CPOE with barcode 5-Rights verification and second-nurse checks for high-alert/narcotic drugs, intake/output balance, structured SBAR nursing notes and risk assessments (Morse, Braden, pain, GCS, nutrition MUST, VTE), nursing care plans, shift handover with digital sign-off, nurse call with response-time tracking, restraint documentation and a task engine that turns every doctor order into a timed nursing task. It replaces paper TPR charts, MAR sheets and handover books, and is the data source for nursing quality indicators.

## 2. Users & Jobs-to-be-done
- **Ward nurse** (nursing-station desktop + bedside tablet + phone IP-004; 1:6–1:8 ratio, 30–40 beds/ward): start the shift with a clear task list; chart vitals q4h (or per order) in < 30 s per patient; administer 60–120 doses/shift with scan verification; document I/O, notes (SBAR), assessments on schedule; escalate NEWS2 ≥ 5 within minutes; hand over 30 patients in ≤ 15 min.
- **Ward in-charge / supervisor** (desktop/TV): see whole ward acuity, overdue tasks, staffing vs workload, incidents; audit MAR compliance; reassign patients.
- **Doctor** (desktop/phone): see vitals trends, MAR (given/held/refused), notes; receive escalations; enter orders (OP-002) that become nursing tasks; acknowledge alerts.
- **Pharmacist** (desktop): see MAR schedule to plan unit-dose supply (IP-014); verify held/refused doses returned.
- **Dietician / physio**: see nutrition/mobility assessments; tasks routed.
- **Family/patient**: nurse call button (bedside device/app), education content, visible care plan summary (portal, later).
- **Quality/ICN**: falls, pressure injuries, medication errors, restraint use, hand hygiene (IP-012), NEWS2 escalation compliance.

## 3. Core Workflows

### 3.1 Ward dashboard & patient assignment
1. `ip.admitted`/`ip.transferred` events place the patient on the ward board; **In-charge** assigns nurses to beds per shift (from NC-030 roster; ratio check `nursing.workload`); assignments drive task routing and push notifications.
2. Board tile per bed: patient (photo, name/initials, age/sex, UHID/IP no.), diagnosis, day of admission (LOS), consultant, **acuity** (auto: latest NEWS2 band + doctor-set level 1–4), colour alert (red critical/orange attention/green stable), isolation, allergy, fall/pressure risk badges, DNR/code status, pending tasks count, overdue tasks (blink), next vitals due, IV lines/catheters days, diet, NPO, expected discharge; sorted by acuity or bed.
3. Right rail: alerts (critical results, NEWS2 escalations, nurse calls, new orders), tasks due now, handover pending. TV variant (EN-018) shows bed/initials/acuity/tasks only.

### 3.2 Nursing admission assessment & care plan (`nursing.care_plans`)
1. On arrival (IP-001 "Received"): **Nurse** completes **initial nursing assessment** ≤ 24 h (NABH COP.2; template EN-039): history, allergies (verified → patient banner), home medications (feeds IP-002 reconciliation), vitals + NEWS2, pain, **Morse Fall Scale**, **Braden**, nutrition (MUST/NRS-2002), VTE risk (Padua/Caprini per order), functional status, skin inspection with body map, lines/tubes inventory, belongings, education needs, language, spiritual/cultural needs, abuse screening (where policy) → Event `nursing.assessment.completed`.
2. Assessment scores drive **care-plan** suggestions (NANDA-style nursing diagnoses → goals → interventions with frequencies): e.g. Morse ≥ 45 → falls bundle (bed low, rails, call bell in reach, hourly rounding, yellow band, non-slip); Braden ≤ 18 → pressure-injury bundle (turn q2h, support surface, skin check q shift, nutrition referral); pain ≥ 4 → reassess 30–60 min post-analgesia; VTE risk → prophylaxis prompt to doctor. Nurse accepts/edits; interventions become scheduled tasks; **reassessment schedule** auto (Morse daily/after fall, Braden daily/on change, pain q shift & PRN, GCS per order).
3. Doctor-set vitals/monitoring frequency (Q1H/Q2H/Q4H/Q6H/Q8H/BD/OD or "per NEWS2 protocol") comes from CPOE nursing orders; default per ward type.

### 3.3 Scheduled vitals, early-warning scores, escalation
1. Vitals task due → **Nurse** enters (bedside tablet/phone with wristband scan or station desktop): temperature (°C/°F), pulse, RR, BP (sys/dia, MAP auto), SpO2 (+ O2 device/flow → NEWS2 scale 1/2), consciousness (ACVPU), pain (NRS/Wong-Baker/FLACC/CPOT), blood glucose (if ordered), weight (daily where ordered), urine output summary; device auto-fill (EN-042 monitor/vitals cart via HL7 ORU) with confirm.
2. **System** computes **NEWS2** (adult; scale 2 for hypercapnic COPD flag set by doctor), **PEWS** (paediatric age bands), **MEWS/MEOWS** (obstetric admissions), stores components; abnormal ranges per age/pregnancy → flags; **escalation ladder** (configurable, RCP default): NEWS2 0 → q12h; 1–4 → q4–6h, inform nurse in-charge; 3 in single parameter → urgent review; 5–6 → urgent (doctor review ≤ 30 min, monitoring q1h); ≥ 7 → emergency (rapid response/ICU registrar, continuous monitoring) → tasks & push (EN-037) with acknowledgement tracking and auto-escalation to next tier if not acknowledged (default 10 min).
3. **Sepsis screen** (`nursing.sepsis_screen`, EN-029): NEWS2 ≥ 5 + suspected infection (or qSOFA ≥ 2 / SIRS) → prompt sepsis screening form → "Sepsis Six" bundle timers (O2, cultures, IV antibiotics ≤ 1 h, fluids, lactate, urine output) → doctor alert.
4. Vitals trend graphs per parameter (24 h/72 h/stay); abnormal cells coloured; manual re-entry with reason within 15 min, otherwise correction creates a new row and marks the old one `corrected` (append-only, monthly partitioned table).
5. Missed vitals (> 15 min past due) → overdue task; > 60 min → in-charge alert; missed-vitals KPI.

### 3.4 Medication Administration Record (MAR) & barcode 5 Rights (`nursing.barcode_mar`)
1. **CPOE order** (OP-002/IP-010: drug, dose, route, frequency, start/stop, PRN with indication & max/24 h, infusion rate/duration, taper schedule, "stat/now", conditional e.g. SOS) → pharmacist verification (IP-014, if configured) → **System** generates MAR schedule per hospital's standard administration times (e.g. OD 08:00, BD 08/20, TDS 08/14/20, QID 06/12/18/22, Q6H 00/06/12/18, HS 21:00; configurable per ward; first dose "now" rounding rules) → tasks per dose.
2. **Administration**: nurse opens due dose → scans wristband (Right Patient) → scans drug barcode/unit-dose label (Right Drug — GTIN/batch via EN-013 or IP-014 label) → system checks Right Dose (matches order; dose-range EN-029; weight-based paeds), Right Route, Right Time (window ± 30 min default; early/late needs reason), plus allergy re-check, duplicate therapy, latest relevant lab (e.g. K⁺ for KCl, INR for warfarin, glucose for insulin — configurable "check before give" rules), vitals gate (hold if HR < 50 for beta-blocker, SBP < 90 for antihypertensive — order-level parameters), fasting/NPO conflict → green ✓ or red ✗ with reason.
3. **High-alert drugs** (ISMP list + hospital list: insulin, heparin/anticoagulants, KCl/concentrated electrolytes, opioids, chemo, neuromuscular blockers, paediatric IV meds) and **narcotics** (NDPS) require **second-nurse witness**: second nurse authenticates (PIN/2FA on same device or their phone) → both recorded; narcotic administration also writes to IP-014 register with wastage witness.
4. Outcomes: **Given** (time, by, witness, site for injections, pump rate for infusions, batch/expiry captured), **Held** (reason from list: NPO, vitals parameter, patient off ward, doctor advice, drug not available), **Refused** (reason, patient counselled, doctor informed), **Omitted/Missed** (auto after window + grace with reason mandatory), **Self-administered** (policy), **Not given — drug unavailable** (triggers IP-014 indent). Held/refused doses → doctor notified (push) if flagged critical; three consecutive refusals → doctor task.
5. **PRN**: indication check, last given time & 24 h count vs max, effect reassessment task (e.g. pain re-score in 30–60 min). **Infusions**: start/stop, rate changes, bag changes, volume infused → feeds I/O; titration orders with parameters (ICU deeper in IP-009).
6. **Verbal/telephone orders**: nurse enters as `verbal_order` with read-back documentation → doctor must co-sign within 24 h (NABH MOM); alerts until signed.
7. Order changes (dose/frequency/stop) regenerate future MAR rows only; administered history immutable. Discharge/transfer moves MAR with patient (times unchanged); patient off ward (OT) → doses auto-flagged "patient in OT" for held-with-reason.
8. Charge capture: given doses post consumption to IP-005 via IP-014 issue records (unit dose) or ward-stock consumption (`nursing.consumable.used`); returns credited.

### 3.5 Intake / Output & fluid balance
- Intake: IV fluids (from infusion records + manual), oral, enteral (RT/PEG), blood products (IP-007 transfusion volumes), IV medications volume; Output: urine (catheter/void with volumes or counts), drains by site, emesis, stool (count/volume), NG aspirate, insensible (optional calc) → per-shift and 24 h balance auto; daily weight; targets from doctor (e.g. fluid restriction 1.5 L, UO ≥ 0.5 mL/kg/h) → alerts on breach; catheter days for CAUTI (IP-012).

### 3.6 Nursing notes (SBAR) & other documentation
- **SBAR** structured note (Situation, Background, Assessment, Recommendation) with free-text option, quick phrases, voice-to-text (later AI-004); note types: shift note, event note (fall, transfusion reaction, code), doctor-communication note (SBAR call log with time/doctor/response), education note, wound care note (with photo IP-004/OP-017), pre-op checklist (IP-006), transfer note, discharge note (IP-002).
- Notes append-only, signed by nurse; late entries labelled; co-sign for students.
- **Wound/pressure injury** register: site body-map, stage (NPIAP 1–4/unstageable/DTI), size, exudate, dressing, photos, present-on-admission flag; hospital-acquired → incident (NC-015) + IP-012.
- **Lines & tubes**: peripheral IV (site, gauge, insertion date, VIP score q shift, removal), central lines, urinary catheter (indication, insertion, daily necessity), NG/PEG, drains — days count & reminders (PIV 72–96 h, catheter necessity daily).
- **Falls**: post-fall assessment form + incident auto-created; Morse reassess.
- **Restraints** (`nursing.restraints`, NABH COP.7): doctor order (type physical/chemical, indication, duration ≤ 24 h), consent/family info, monitoring q2h (circulation, skin, position, needs), release attempts, renewal reminders; register for quality.
- **Diabetic chart / glucose**: sliding-scale insulin orders → capillary glucose task → insulin dose from scale (nurse confirms) with second check.
- **Blood transfusion bedside**: IP-007 provides two-person verification screen and vitals at 0/15/30 min/hourly/end; reaction workflow.
- **Pre-op / pre-procedure checklist** (IP-006 template): NPO time, consent verified, site marked, jewellery/dentures, prophylactic antibiotic time, blood availability, implants ready.
- **Patient education**: topics with materials (OP-038), teach-back documented.

### 3.7 Nursing tasks engine
- Every order → tasks (medication doses, vitals, samples to collect for OP-004 with label print, send-to-imaging with transport request, diet change, physio, dressing, position change q2h, hourly rounding, care-plan interventions, discharge checklist); task states: due/overdue/done/skipped(reason)/cancelled(order stopped); assignment by bed → nurse; workload heat-map (`nursing.workload`) per nurse for balancing; TV/board counters.
- Sample collection: order → task → scan wristband + print barcode label (EN-013/EN-005) at bedside → collected time → OP-004 accession.

### 3.8 Shift handover
1. At shift end, **outgoing nurse** opens handover: **System** pre-populates per patient (I-PASS/SBAR): identity & code status, illness severity (NEWS2, acuity), summary/active issues, pending orders/results, meds due next hours (incl. held/refused), lines/tubes, I/O balance, alerts (allergy, isolation, fall/pressure), family concerns, to-do; nurse adds free text; **incoming nurse** reviews at bedside (optional walk-round mode with wristband scan), asks questions, **acknowledges** each patient → digital sign-off both parties → immutable handover document → Event `nursing.handover.completed`.
2. Ward-level handover: staffing, equipment issues, crash cart check (IP-013), narcotic count (IP-014 double count with keys handover), incidents.
3. Unacknowledged patients after shift start + 30 min → supervisor alert.

### 3.9 Nurse call & response time (`nursing.nurse_call`)
- Bedside call unit / patient app button (EN-042 gateway or app) → call appears on board & assigned nurse phone (priority: normal/bathroom/pain/emergency) → accept/attend/complete → response time & attend time logged; escalation to any nurse after N min; family "code blue" button (IP-013). KPI: median response time by ward/shift.

### 3.10 Exceptions & offline
1. **Barcode unreadable/missing** → manual override with reason + second nurse verify (KPI: scan compliance %).
2. **Wrong-patient scan** → hard stop; near-miss auto-logged to NC-015 (anonymous option).
3. **Order stopped after dose prepared** → task cancelled with banner; if already given, doctor notified.
4. **Device vitals stream stops** → manual entry; back-fill flagged.
5. **Offline** (tablet/phone; IP-004): vitals/I/O/notes queue locally with local timestamps. **MAR offline is bounded by drug risk, not by a warning:** verification uses the cached order snapshot; if the snapshot is ≤ 2 h old the dose may be given normally; if it is older than 2 h the nurse sees a hard warning and must confirm the order verbally with the doctor/in-charge (reason recorded). **High-alert drugs, narcotics, chemotherapy, insulin, anticoagulants, concentrated electrolytes and any titrated infusion can never be administered offline against a snapshot older than 30 minutes** — the dialog blocks and instructs the nurse to use the nursing-station desktop or obtain a written order; this is deliberate, because these are exactly the orders most likely to have been stopped or changed. Conflicts (order changed or stopped while offline) → the administration is flagged `requires_review`, the doctor and in-charge are notified on sync, and it is counted in the medication-safety KPI; sync order preserved.
6. **Patient off ward** (OT/CT): tasks paused with location tag; resumed on return; missed doses reconciled with reason.
7. **Nurse reassignment mid-shift** → tasks move; handover-lite required.

## 4. Data Model (schema `ip`/`clinical`)
- **ip.ward_shifts** (id, hospital_id, branch_id, ward_id, shift_code (M/E/N/custom), starts_at, ends_at, in_charge_id, staffing jsonb, notes).
- **ip.nurse_assignments** (shift_id, nurse_id, bed_id/admission_id, role enum(primary/secondary/float), from, to).
- **clinical.vitals** (existing; monthly partitioned): + admission_id, ward_id, scheduled_task_id, source enum(manual/device/backfill), device_id, o2_device, o2_flow, acvpu, pain_scale, pain_score, glucose, weight, corrected_of?, entered_by, entered_at, verified bool.
- **clinical.early_warning_scores** (vitals_id, admission_id, type enum(news2/pews/mews/meows/qsofa/sirs), scale int, total, components jsonb, band enum(low/low_medium/medium/high), escalation_level, escalated_to, acknowledged_by, acknowledged_at, at) — index (admission_id, at desc), (hospital_id, band, acknowledged_at null).
- **ip.monitoring_orders** (admission_id, order_id, vitals_frequency, params jsonb (glucose freq, weight daily, neuro obs), start, stop).
- **ip.mar_schedule** (id, hospital_id, admission_id, order_id (CPOE), drug_id, drug_name, dose, unit, route, scheduled_at, window_start, window_end, is_prn, is_high_alert, is_narcotic, requires_witness, check_rules jsonb, status enum(due/given/held/refused/omitted/cancelled/self_admin/unavailable), infusion jsonb?, task_id, version) — partitioned monthly, index (admission_id, scheduled_at), (hospital_id, status, scheduled_at).
- **ip.mar_administrations** (id, schedule_id, admission_id, order_id, given_at, given_by, witness_id?, patient_scan_ok bool, drug_scan_ok bool, override_reason?, batch_no, expiry, site, rate, volume_ml, dose_given, unit, outcome enum(given/held/refused/omitted/unavailable/self_admin), reason_code, reason_text, doctor_notified bool, prn_indication, prn_effect_score?, prn_effect_at?, device_id?, offline_captured bool, created_at) — append-only, monthly partition.
- **ip.verbal_orders** (order_id, taken_by, from_doctor_id, read_back bool, at, cosigned_at?, cosigned_by?).
- **ip.intake_output** (admission_id, at, category enum(intake/output), type (iv_fluid/oral/enteral/blood/iv_med/urine/drain/emesis/stool/ng/insensible/other), site?, volume_ml, count?, source enum(manual/infusion/transfusion), by) — partitioned; **ip.fluid_targets** (admission_id, restriction_ml, uo_target, from, to, ordered_by).
- **clinical.nursing_notes** (id, admission_id, type enum(sbar/event/doctor_comm/education/wound/transfer/preop/other), s,b,a,r text, free_text, structured jsonb, late_entry bool, author_id, cosigned_by?, signed_at, sha256) — append-only.
- **clinical.assessments** (admission_id, type enum(morse/braden/pain/gcs/must/nrs2002/padua/caprini/vip/nutrition/functional/skin/other), at, score, components jsonb, by, triggered_by enum(schedule/event/manual)).
- **ip.care_plans** (admission_id, diagnoses jsonb [{code, label, goals, interventions:[{code, freq, task_template}]}], status, created_by, version); **ip.care_plan_reviews**.
- **ip.nursing_tasks** (id, hospital_id, admission_id, ward_id, type enum(vitals/med/sample/transport/dressing/position/rounding/assessment/care_plan/other), source_order_id?, due_at, window_min, assigned_to, status enum(due/overdue/done/skipped/cancelled), done_at, done_by, skip_reason, priority) — partitioned; index (ward_id, status, due_at), (assigned_to, status, due_at).
- **ip.wounds** (admission_id, patient_id, site, body_map jsonb, type enum(pressure/surgical/traumatic/diabetic/other), stage, poa bool, measurements jsonb, photos file ids, status), **ip.wound_reviews**.
- **ip.lines_tubes** (admission_id, type, site, gauge, inserted_at, by, removed_at, reason, vip_scores jsonb, necessity_reviews jsonb).
- **ip.restraint_orders** (admission_id, order_id, type, indication, ordered_by, from, to, consent_id, status), **ip.restraint_monitoring** (restraint_id, at, circulation, skin, position, needs_met, release_attempt, by).
- **ip.handovers** (shift_id, ward_id, admission_id, outgoing_id, incoming_id, content jsonb, outgoing_signed_at, incoming_ack_at, bedside_verified bool, sha256); **ip.ward_handovers** (shift_id, staffing, equipment, narcotic_count_ok, crash_cart_ok, incidents, signed).
- **ip.nurse_calls** (bed_id, admission_id, priority, raised_at, source enum(bedside/app/family), accepted_by, accepted_at, attended_at, completed_at, escalations jsonb).
- **ip.falls** (admission_id, at, location, injury, morse_before, post_fall_assessment jsonb, incident_id).
- Read models: `analytics.mv_ward_board` (Redis + table), `analytics.mv_mar_compliance_daily`, `analytics.mv_ews_escalations`, `analytics.mv_nursing_indicators`.

## 5. Business Rules & Validations
- Initial nursing assessment due ≤ 24 h of admission (configurable, ICU ≤ 1 h) → overdue task; reassessment schedule per score thresholds; Morse ≥ 45 & Braden ≤ 18 auto-activate bundles.
- NEWS2 computed on every complete vitals set (missing parameter → score marked incomplete, no escalation suppression); scale 2 only when doctor sets `hypercapnic_copd`; PEWS for age < 16 (age-banded thresholds), MEOWS for obstetric admissions; escalation tiers configurable, defaults RCP; acknowledgement SLA 10 min then auto-escalate; all escalations audited.
- MAR generation strictly from verified orders (pharmacist verification step configurable per drug class); standard times configurable per ward; ± 30 min window default (± 60 for OD non-critical), early/late administration requires reason; PRN respects max/24 h and min interval; STAT due immediately, must be given ≤ 30 min else escalates.
- Barcode scan mandatory when `nursing.barcode_mar` on; override needs reason + (for high-alert) second nurse; wrong-patient scan hard-stops.
- High-alert/narcotic doses require witness (different user, authenticated); narcotic wastage witnessed; NDPS register in IP-014.
- Verbal orders only in emergencies/permitted contexts, read-back mandatory, co-sign ≤ 24 h; no verbal orders for chemo/high-alert (configurable).
- Held/refused/omitted require reason codes; three refusals or held critical drug → doctor task; omitted doses reported daily to pharmacy & in-charge.
- I/O balance per shift & 24 h; targets breach → alert; catheter necessity review daily; PIV site check q shift with VIP score, replace ≥ 2.
- Notes/administrations/vitals append-only; corrections create new rows referencing old; late entries flagged; all signed by author (system signature) with hash chain per admission.
- Restraint order ≤ 24 h, monitoring q2h, renewal by doctor; missing monitoring → alert; register for NABH.
- Handover: incoming acknowledgement per patient required; unacknowledged after 30 min → supervisor; handover doc immutable.
- Nurse call SLA configurable (default 3 min accept, 5 min attend); breaches to in-charge.
- Ratio breach (NC-030) shows warning; supervisor override logged.
- Ward TV shows no full names unless configured; PHI-free push notifications (deep links).

## 6. API Surface (`/api/v1/nursing`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /wards/{wardId}/board | ward board read model | nursing.board.read | – | – |
| POST/GET | /wards/{wardId}/shifts, /assignments | shifts & nurse-bed assignments | nursing.assignment.manage | Y | cursor |
| GET | /tasks?ward=&nurse=&status=&due_before= | task list | nursing.task.read | – | cursor |
| POST | /tasks/{id}/complete|skip|reassign | task actions | nursing.task.update | Y | – |
| POST | /admissions/{id}/vitals | record vitals (returns EWS) | nursing.vitals.write | Y | – |
| GET | /admissions/{id}/vitals?from=&to= | vitals + trends | nursing.vitals.read | – | cursor |
| POST | /ews/{id}/acknowledge | acknowledge escalation | nursing.ews.acknowledge | Y | – |
| GET | /admissions/{id}/mar?date= | MAR grid | nursing.mar.read | – | – |
| POST | /mar/{scheduleId}/verify-scan | patient/drug scan check (5R) | nursing.mar.administer | Y | – |
| POST | /mar/{scheduleId}/administer | given/held/refused/omitted (+ witness token) | nursing.mar.administer | Y | – |
| POST | /mar/{scheduleId}/witness | second-nurse witness auth | nursing.mar.witness | Y | – |
| POST | /admissions/{id}/mar/prn | PRN administration | nursing.mar.administer | Y | – |
| POST | /admissions/{id}/verbal-orders | record verbal order | nursing.verbal_order.record | Y | – |
| POST | /verbal-orders/{id}/cosign | doctor co-sign | opd.order.sign (OP-002) | Y | – |
| POST/GET | /admissions/{id}/io | intake/output entries & balance | nursing.io.write / read | Y | cursor |
| POST/GET | /admissions/{id}/notes | SBAR & other notes | nursing.note.write / read | Y | cursor |
| POST/GET | /admissions/{id}/assessments | Morse/Braden/pain/GCS/… | nursing.assessment.write / read | Y | cursor |
| POST/GET/PATCH | /admissions/{id}/care-plan | care plan | nursing.careplan.write | Y | – |
| POST/GET | /admissions/{id}/wounds, /lines, /falls | registers | nursing.register.write | Y | cursor |
| POST/GET | /admissions/{id}/restraints, /restraints/{id}/monitoring | restraints | nursing.restraint.write | Y | cursor |
| POST/GET | /wards/{wardId}/handover, /handover/{id}/ack, /sign | handover | nursing.handover.write / ack | Y | – |
| POST | /nurse-calls, /nurse-calls/{id}/accept|attend|complete | nurse call | nursing.call.handle | Y | – |
| POST | /sync/batch | offline batch (vitals/MAR/IO/notes) with client ids | nursing.* (per item) | Y | – |
| GET | /reports/indicators?ward=&from= | nursing KPIs | nursing.report.read | – | – |
| GET/PUT | /config/admin-times, /config/ews-ladder, /config/high-alert-list, /config/task-templates | configuration | nursing.configure | Y | – |
| Consumes | `order.created|updated|cancelled` (OP-002), `ip.admitted|transferred|discharge.initiated|completed`, `lab.result.critical`, `pharmacy.unit_dose.issued` (IP-014), `device.vitals.received` (EN-042), `roster.published` (NC-030) | | | | |

## 7. Domain Events (outbox)
- `nursing.assessment.completed` {type, score} → care plan, IP-002, IP-012, NC-015.
- `nursing.vitals.recorded` {admission_id, vitals_id, ews} → IP-010, EN-018, IP-009, IP-002 readiness.
- `nursing.ews.escalated` {type, total, band, tier, to} / `nursing.ews.acknowledged` / `nursing.ews.escalation_breached` → EN-037, IP-010, IP-013 (≥ 7 optional rapid response), NC-015.
- `nursing.sepsis.screened` {positive} → EN-029, IP-009.
- `nursing.mar.administered` {schedule_id, outcome, high_alert, witness} → IP-014 (stock/narcotic register), IP-005 (charges), OP-003, IP-010 (held/refused critical).
- `nursing.mar.omitted|unavailable` → IP-014 indent, in-charge.
- `nursing.verbal_order.recorded|cosign_overdue` → OP-002/doctor.
- `nursing.io.recorded`, `nursing.fluid_target.breached`.
- `nursing.note.signed`, `nursing.wound.recorded` {hospital_acquired}, `nursing.fall.recorded` → NC-015 incident, IP-012.
- `nursing.line.inserted|removed|overdue_review` → IP-012 device days.
- `nursing.restraint.started|monitored|ended|renewal_due`.
- `nursing.task.created|completed|overdue`.
- `nursing.handover.completed` {shift, ward, patients}, `nursing.handover.unacknowledged`.
- `nursing.call.raised|accepted|attended|completed|sla_breached`.
- `nursing.consumable.used` {item, qty} → IP-005/NC-006.

## 8. Screens (UI)
- **Ward Board** (desktop 3-pane; wall TV via EN-018): bed grid/list toggle, tile design as §3.1, filters (my patients/all, acuity, overdue), right rail alerts/tasks; real-time (Socket.IO); shortcuts `1–9` jump to bed n, `/` search, `V` vitals, `M` MAR, `N` note, `H` handover, `T` tasks; empty "No patients in ward"; stale-connection banner.
- **Patient Nursing Chart** (desktop tabs / tablet): Overview (banner, alerts, care plan summary), Vitals (grid + trends, NEWS2 badge, add), MAR (day grid: rows drugs × columns times; status icons; click cell → administer dialog with scan prompt; PRN panel; infusion panel), I/O (grid + balance), Notes (SBAR composer, timeline), Assessments (due list, forms), Care plan, Lines/tubes/wounds (body map), Orders (read-only from CPOE), Results, Tasks, Handover.
- **Administer Dialog** (tablet/phone/desktop with scanner): step 1 scan patient (camera/USB scanner; manual override), step 2 scan drug, checks panel (5R + labs/vitals gates), outcome buttons, witness prompt (second nurse PIN/2FA), site/rate fields, save; keyboard `G` given, `H` held, `R` refused; big tap targets.
- **Vitals Entry** (tablet/phone/desktop): numeric pads, device auto-fill, instant NEWS2 with colour band and required action text; `Enter` next field, `Ctrl+Enter` save.
- **Task List / My Patients** (phone IP-004 & desktop): due/overdue grouped by time; swipe to complete; scan-to-open patient.
- **Handover Screen** (desktop/tablet): patient list with I-PASS cards, edit, walk-round mode, ack per patient, sign; print/PDF.
- **Nurse Call Console** (desktop + phone): active calls by priority with timers; accept/attend.
- **In-charge Dashboard** (desktop/TV): staffing vs workload heat-map, overdue tasks, EWS escalations open, MAR compliance today, falls/pressure injuries this month, restraint count, nurse-call SLA.
- **Config** (desktop admin): admin times, EWS ladder, high-alert list, task templates, checklist templates.
- Offline: vitals/MAR/I/O/notes/tasks usable on tablet/phone with local queue and clear "pending sync" badges (details in IP-004).

## 9. Integrations
- OP-002 CPOE (orders → MAR/tasks), IP-014 (unit dose, narcotics register), OP-003 pharmacy, OP-004 (sample labels, results/critical), OP-008, EN-029 CDSS rules, EN-013 barcode (wristband GS1/QR, drug GTIN/internal), EN-005 label printers, EN-042 device gateway (vitals monitors HL7 ORU^R01, spot-check devices, nurse-call systems, smart beds), EN-037 push/escalation, EN-018 TV, NC-030 roster, NC-015 incidents, IP-012, IP-013, IP-007, IP-009 (extends), IP-004/IP-010 mobile, OP-011 diet, OP-015 physio.
- Fallbacks: scanner failure → camera/manual with reason; device gateway down → manual; push down → in-app + TV + SMS for critical (EN-009).

## 10. Reports & Analytics
- Nursing indicators (NABH): medication error rate (per 1000 patient-days), MAR compliance (on-time %, scan %), omitted doses, falls rate, hospital-acquired pressure injuries, restraint use, NEWS2 escalation compliance (time to doctor review), initial assessment ≤ 24 h %, handover completion, nurse-call response, catheter/PIV days, sepsis bundle timeliness, verbal-order co-sign compliance, workload per nurse.
- Read models: `analytics.mv_nursing_indicators_daily`, `analytics.mv_mar_compliance_daily`, `analytics.mv_ews_escalations`, `analytics.mv_nurse_call_sla`.

## 11. Notifications
- Nurse (push/in-app/phone): task due/overdue, new/changed orders, STAT medication, EWS escalation, nurse call, critical result for own patient, witness request, handover unacknowledged; Doctor: EWS ≥ 5 (tier), held/refused critical dose, sepsis screen positive, verbal order co-sign due, restraint renewal; In-charge/supervisor: escalation breach, overdue vitals > 60 min, ratio breach, fall/pressure injury; Pharmacy: unavailable drug, omitted doses summary; Family: nurse-call acknowledgement (bedside display), education links.
- TV: ward board, tasks overdue count, EWS alerts (bed only).

## 12. Permissions (RBAC keys)
`nursing.board.read`, `nursing.assignment.manage`, `nursing.task.read|update`, `nursing.vitals.read|write`, `nursing.ews.acknowledge`, `nursing.mar.read|administer|witness|override`, `nursing.verbal_order.record`, `nursing.io.read|write`, `nursing.note.read|write`, `nursing.assessment.read|write`, `nursing.careplan.write`, `nursing.register.write`, `nursing.restraint.write`, `nursing.handover.write|ack`, `nursing.call.handle`, `nursing.report.read|export`, `nursing.configure`.
Defaults: Ward nurse (17): all read/write except assignment.manage & configure (ABAC `assigned_ward_only`; `mar.witness` requires different user); ICU nurse (18): same + IP-009; Nurse supervisor (22): assignment.manage, reports, override; Doctors (6–11,14): board.read, vitals.read, mar.read, note.read, assessment.read, ews.acknowledge, cosign; Pharmacist IP (31): mar.read; Ward boy (23): task.read/update (transport only); Quality (54)/ICN (21): reports, registers read; Admin (2/3): configure; Family device: call raise only.

## 13. Non-functional
- Volumes: 2000 beds → ~12k vitals sets/day, ~40k MAR administrations/day (peak 8k/h at 08:00 & 20:00), 30k tasks/day, 3k notes/day, 5k nurse calls/day; monthly partitions; 10-y retention (vitals raw device 1 y then aggregated).
- p95: board < 200 ms (read model), MAR grid < 250 ms, scan verify < 150 ms, vitals save + EWS < 200 ms, push dispatch < 3 s.
- Offline: tablets/phones ≥ 4 h queued operations; conflict rules §3.10.
- Printing: MAR sheet/day, vitals chart, I/O chart, handover PDF, sample labels (ZPL), wristband reprint.
- Accessibility: large tap targets ≥ 44 px, high-contrast clinical theme, colour + icon + text; screen-reader labels; i18n UI strings; local-language education material.
- Security: witness auth is a distinct authentication (PIN/2FA) — no shared logins; audit on every administration/override; PHI-free notifications; device tokens for TVs/call units.

## 14. Acceptance Criteria
1. Given a patient admitted at 10:00, then a nursing initial assessment task is due by 10:00 next day and appears overdue after that; ICU wards default to 1 h.
2. Given vitals RR 24, SpO2 93 % on room air, temp 38.6, SBP 105, HR 112, alert, then NEWS2 = 8 (RR 2, SpO2 2, air 0, temp 1, SBP 1, HR 2, ACVPU 0) with band "high", an emergency escalation task and push are created, and if unacknowledged in 10 min it escalates to the next tier.
3. Given a doctor sets `hypercapnic_copd`, then SpO2 scoring uses NEWS2 scale 2 and the badge shows "Scale 2".
4. Given a 4-year-old with age-banded PEWS thresholds, then PEWS (not NEWS2) is computed and the ladder for paediatrics applies.
5. Given a CPOE order "Amoxicillin 500 mg PO TDS × 5 days" verified at 11:20, then MAR rows are generated at 14:00, 20:00 today and 08/14/20 for the following days per ward standard times, with the first dose per the "now vs next slot" rule.
6. Given nurse scans wristband of bed 12 while opening bed 11's dose, then a hard stop "Wrong patient" is shown and a near-miss is logged.
7. Given a scan of a drug whose GTIN maps to a different strength than ordered, then the check fails "Right Dose/Drug" and cannot proceed without override reason + second nurse.
8. Given insulin (high-alert), then administration requires a second nurse's authenticated witness; the same user cannot witness their own administration (403).
9. Given a beta-blocker order with parameter "hold if HR < 50" and latest HR 46, then the dialog defaults to Held with reason "vitals parameter" and notifies the doctor.
10. Given a PRN paracetamol with max 4 g/24 h and 3.5 g given, when a 1 g dose is attempted, then it is blocked with the 24-h total shown.
11. Given a dose window 08:00 ± 30 min not actioned by 09:00 (grace 30 min), then the row becomes `omitted` requiring a reason and appears in the omitted-dose report.
12. Given a verbal order recorded with read-back, then the doctor receives a co-sign task; unsigned at 24 h raises `nursing.verbal_order.cosign_overdue`.
13. Given I/O entries (IV 2000 mL, oral 500 mL, urine 1200 mL, drain 150 mL), then 24-h balance = +1150 mL and a fluid restriction of 2000 mL triggers a breach alert.
14. Given Morse score 55, then the falls bundle interventions (hourly rounding tasks, low bed, yellow band print) are added to the care plan and tasks generated.
15. Given a restraint order at 08:00, then monitoring tasks q2h are created; renewal reminder at 07:00 next day; missing two monitoring entries alerts the in-charge.
16. Given the outgoing nurse signs handover for 30 patients and the incoming nurse acknowledges 28, then the two unacknowledged patients raise a supervisor alert 30 min after shift start.
17. Given a nurse call from bed 7 not accepted in 3 min, then it escalates to all nurses of the ward and the SLA breach is recorded.
18. Given the tablet is offline for 90 min, when three vitals sets and five MAR administrations are captured, then on reconnect all sync in order with original timestamps and any order changed meanwhile flags the affected administration for review.
19. Given a hospital-acquired pressure injury stage 2 recorded, then an incident is auto-created in NC-015 and IP-012 is notified.
20. Given a nurse assigned to Ward A opens a patient in Ward B, then read is allowed only via break-glass with reason (READ_PHI audit) and write is denied.

## 15. Enhancements / Later phases
- From VIMS sheet row 22: nurse call bell with response-time tracking (here), NEWS2 auto-calc (here), sepsis screening protocol (here), restraint documentation (here), nursing workload balancing algorithm (heat-map here; auto-balancing later with NC-030).
- From row 14: bedside vitals with auto-trend & abnormal push (here), I/O (here), fall detection IoT (EN-042).
- (market) second-nurse confirmation, mandatory skip reasons, auto-scheduling BD/TDS/QID, SBAR handover, M/A/N vitals (all here); PCS: TPR/BP charting, diabetic charting, physical examination, SOAP notes (here). Later: smart-pump interoperability (auto-programming), RTLS nurse location, voice-to-text notes (AI-004), predictive deterioration (AI-005), smart-bed integration (weight/exit alarms), family app care-plan view (PE-001), nurse rounding checklists with tablets at bedside (hourly rounding here), acuity-based staffing (NC-030).

## 16. Open Questions for the Hospital
1. Standard medication administration times per ward; dose window tolerance; grace before "omitted"?
2. Barcode readiness: do drug packs have GTIN barcodes or will IP-014 print unit-dose labels? Wristband printers per ward?
3. High-alert drug list and witness policy (all high-alert or only narcotics/insulin/anticoagulants/chemo/paeds)?
4. Pharmacist verification before MAR release for all drugs or specific classes?
5. NEWS2 ladder tiers, who is called at each tier (registrar, RRT, ICU), acknowledgement SLA; PEWS/MEOWS variants in use?
6. Vitals frequency defaults per ward type; monitors/spot-check devices models for integration?
7. Nursing assessment forms in use (Morse vs Hendrich, Braden vs Waterlow, MUST vs NRS-2002), care-plan taxonomy?
8. Handover format (I-PASS/SBAR) and whether bedside walk-round is mandated?
9. Nurse-call system vendor/protocol; SLA targets?
10. Restraint policy and consent form; verbal-order policy limits?
11. Ward TV privacy (initials vs names); tablet/phone availability per nurse (BYOD?).
12. Which nursing indicators are reported monthly to NABH/quality and their exact definitions?
