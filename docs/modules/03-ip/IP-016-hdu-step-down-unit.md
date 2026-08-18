# IP-016 — HDU / Step-Down Unit (step-down & step-up criteria, intermediate-care monitoring frequency, NEWS2-driven escalation protocols, HDU board, ICU-return prevention, HDU charging)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-016 |
| Phase | 7 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | IP-009 (ICU engine: discharge criteria checklist, step-down decision, flowsheet at reduced frequency, device pairing), IP-003 (nursing engine: vitals schedule, NEWS2/PEWS/MEOWS, tasks, MAR, handover — HDU runs on IP-003 with HDU profile), IP-001 (HDU bed class, transfers ICU↔HDU↔ward, bed holds), IP-025 (command centre: HDU occupancy, step-down queue, ICU pressure), IP-013 (rapid response / code), IP-005 (HDU per-day charges, monitoring/oxygen/NIV charges), RC-002/EN-002 (HDU room-rent eligibility, insurer step-down justification), OP-002 (CPOE order sets on step-down: monitoring frequency, oxygen, mobilisation), IP-012 (device days, isolation), OP-015 (early mobilisation/physio), NC-030 (nurse ratio 1:2–1:4), EN-042 (central monitoring / telemetry), EN-018 (HDU board), EN-029 (rules), EN-037, EN-024, IP-010 (doctor mobile), NC-015 (indicators: ICU readmission ≤ 48 h) |
| Feature flag | `module.hdu.enabled` (sub-flags: `hdu.telemetry`, `hdu.step_up_auto_suggest`, `hdu.surgical_step_down`) |
| Primary roles | Intensivist (11), Doctor — IP (7), Nurse — ICU (18, HDU-trained), Nurse — Ward (17), Resident (14), Nurse Supervisor (22) |
| Secondary roles | Surgeon (9: post-op HDU), Anaesthetist (10: PACU→HDU), Physiotherapist (40), Bed manager (IP-025), Billing/TPA (27, 28), Infection control (21), Quality (54), MS (4), Family (60), Auditor (58) |
| Regulatory | NABH 5th ed. COP.9 (intensive/high-dependency care: admission & discharge criteria defined, monitoring, staffing, equipment), AAC.7 (transfer within organisation with documented handover), ISCCM guidelines for HDU/level-2 care (patient:nurse 1:2–1:3, monitoring standards), Insurance/IRDAI room-rent category definitions (HDU vs ICU vs ward), Clinical Establishments Act minimum standards, DPDP |

## 1. Purpose
IP-016 defines and runs the intermediate ("level 2") care layer between ICU and ward: objective step-down criteria (from ICU) and step-up criteria (from ward), a monitoring profile between ICU hourly flowsheets and ward 4–6-hourly vitals, NEWS2/PEWS-driven escalation protocols with named responders, an HDU board with early deterioration flags, and correct HDU charging and insurer justification. It reuses IP-009 (ICU) and IP-003 (nursing) engines through an HDU profile rather than duplicating them, and feeds bed flow to IP-025 so ICU beds are freed safely and returns to ICU within 48 h are minimised.

## 2. Users & Jobs-to-be-done
- **Intensivist / consultant** (desktop/IP-010): decide step-down against criteria, write step-down order set (monitoring q2h/q4h, oxygen target, NIV/HFNC continuation, drains, mobilisation, DVT prophylaxis, diet), review HDU patients twice daily, decide step-up (return to ICU) or discharge to ward.
- **HDU nurse** (tablet/desktop; ratio 1:2–1:4): vitals q1–4h (monitor auto-capture with `hdu.telemetry`), NEWS2 with HDU thresholds, NIV/HFNC/O2 titration within orders, drains/lines care, I/O, mobilisation, early-warning escalation, family updates.
- **Ward doctor / nurse**: request step-up (worried, NEWS2 ≥ 5, new O2 requirement) → HDU acceptance; receive step-down patients from HDU with handover.
- **Surgeon/anaesthetist**: post-op elective HDU booking (major surgery, ASA ≥ 3) from IP-006/IP-024 (`hdu.surgical_step_down`).
- **Bed manager**: HDU occupancy, pending step-downs/step-ups, ICU pressure relief.
- **Billing/TPA**: HDU day charges, justification note for insurer (criteria met), room-rent capping alerts.

## 3. Core Workflows

### 3.1 HDU configuration
1. Admin defines HDU units (IP-001 wards with type `hdu`, bed class `HDU`, features: monitor, O2, NIV-capable, suction), nurse ratio target (NC-030), monitoring profile defaults (vitals q2h first 12 h then q4h; continuous SpO2/ECG when telemetry), **step-down criteria set** and **step-up criteria set** (configurable rule lists in EN-029, seeded from ISCCM/hospital SOP): e.g., step-down from ICU: FiO2 ≤ 0.4 with SpO2 ≥ 92 %, no vasopressor ≥ 12 h (or low fixed dose per policy), no invasive ventilation ≥ 24 h (NIV/HFNC allowed), stable rhythm, GCS ≥ 13 or baseline, no active bleeding, lactate normalising, no RRT (or intermittent HD arranged), pain controlled; step-up to ICU: NEWS2 ≥ 7 or ≥ 3 in one parameter, FiO2 > 0.6 need, hypotension needing vasopressor, GCS drop ≥ 2, new arrhythmia with instability, RR > 30, urine output < 0.5 ml/kg/h × 4 h, staff concern.
2. Escalation ladder per NEWS2 band for HDU (tighter than ward): score 3–4 → HDU nurse in-charge + resident review ≤ 30 min; 5–6 → registrar/intensivist ≤ 15 min, consider step-up; ≥ 7 → intensivist immediate + rapid response (IP-013 RRT); acknowledgement SLAs; auto-escalate on no ack.

### 3.2 Step-down (ICU → HDU)
1. **Intensivist** opens IP-009 discharge checklist → **System** evaluates step-down criteria from live data (flowsheet, vent settings, infusions, labs) → shows criteria met/unmet with values; unmet items require override reason (audited) → selects destination `HDU` → IP-001 transfer request `to_class=HDU` (bed suggestion by proximity/isolation/sex policy) → **step-down order set** (OP-002 template): monitoring frequency, O2 device & target, NIV/HFNC settings, infusions to continue (converted from ICU pumps), lines/drains, mobilisation level, diet, DVT prophylaxis, escalation contact (named consultant/on-call), review time; medication reconciliation (ICU infusions → enteral/IV intermittent) via IP-014.
2. **Handover** (IP-003 SBAR transfer note + IP-009 ICU summary auto-draft: course, organ support history, lines, pending results, code status) → HDU nurse acknowledges at bedside (wristband scan) → **System** switches the admission's care profile to `hdu` (vitals schedule, NEWS2 HDU ladder, ratio) → Event `hdu.admitted` {from=icu} → IP-005 changes daily charge class from ICU to HDU from `received_at` (pro-rata policy per IP-005), RC-002 informed (room-rent category change), IP-025 board.
3. Optional **ICU bed hold** for 12–24 h (configurable) for high-risk step-downs (`hold_reason=step_down_watch`), released automatically if stable.

### 3.3 Step-up (ward → HDU) and HDU → ICU
1. **Ward nurse/doctor** raises step-up request from IP-003 (auto-suggested when NEWS2 ≥ 5, `hdu.step_up_auto_suggest`) with reason & current vitals → HDU in-charge/intensivist accepts (criteria check) or redirects to ICU/keeps ward with advice (recorded); IP-001 transfer; ward → HDU handover; care profile → `hdu`; Event `hdu.admitted` {from=ward}.
2. **HDU → ICU** when step-up criteria met: intensivist informed via escalation; ICU acceptance (IP-009 admission decision); transfer; Event `hdu.stepped_up` → NC-015 indicator (ICU readmission ≤ 48 h flagged separately if the patient came from ICU < 48 h earlier).
3. **Post-op elective HDU** (`hdu.surgical_step_down`): IP-006 case booking may reserve HDU bed (IP-001 reservation) → PACU (IP-024) discharge to HDU with Aldrete/PACU handover → profile `hdu`.

### 3.4 HDU monitoring & daily management
1. Vitals per profile (IP-003 schedule; telemetry auto-capture via EN-042 into `clinical.vitals` with `source=device` and NEWS2 recompute each capture; nurse verifies alarms/artefacts); HDU flowsheet view = IP-009 flowsheet at reduced density (q2h columns) with I/O, O2/NIV settings, drains, pain, mobilisation, glucose; lines/tubes days (IP-012 bundles), pressure injury/falls assessments (IP-003).
2. **Escalation**: NEWS2 ladder as configured; every escalation logs notified/ack/arrival; step-up decision recorded (`hdu_escalations.decision enum(observe/step_up_icu/rrt/other)`).
3. **Twice-daily review** note (doctor): status vs step-down goals, plan (continue HDU / ready for ward / step-up), expected HDU LOS (feeds IP-025 predicted discharge/step-down); order set changes; family update.
4. **HDU → ward discharge**: **ward-readiness criteria** (NEWS2 ≤ 2 for 12 h, O2 ≤ 4 L/min or room air, no NIV/HFNC ≥ 12–24 h, oral/enteral, mobilising, no continuous infusions requiring pumps beyond ward capability) → transfer request to ward class; profile → `ward`; Event `hdu.discharged` {to=ward}; charges class change.

### 3.5 Exceptions
- No HDU bed available: keep in ICU with `hdu_ready_waiting` flag (IP-025 shows step-down blocked count) or ward with enhanced monitoring order (q2h + telemetry if portable) with intensivist advice; charge class stays as physical bed class (policy note).
- Deterioration during transfer: escalation from transporter (IP-013 activation).
- Insurer refuses HDU class: billing desk records `class_dispute` (IP-005) with criteria-met justification PDF auto-generated (criteria values at admission).
- Telemetry offline: fallback to manual vitals schedule with alert to in-charge.

## 4. Data Model (schema `ip`)
- **ip.hdu_units** (id, hospital_id, branch_id, ward_id (IP-001), name, level enum(surgical/medical/mixed/cardiac/neuro), nurse_ratio_target, monitoring_profile jsonb {vitals_freq_first_12h_min, vitals_freq_min, telemetry bool}, escalation_ladder jsonb, active).
- **ip.hdu_criteria_sets** (id, hospital_id, type enum(step_down_from_icu/step_up_from_ward/step_up_to_icu/ward_ready), version, rules jsonb [{code, label, expression (EN-029 rule ref), mandatory bool}], effective_from, active).
- **ip.hdu_stays** (id, hospital_id, branch_id, admission_id, hdu_unit_id, bed_id, source enum(icu/ward/pacu/er/ot_direct/other), icu_stay_id?, admitted_at, admitted_by, accepted_by, criteria_eval jsonb [{code, met bool, value, override_reason?}], order_set_id?, expected_los_h, status enum(active/discharged_ward/stepped_up_icu/died/dama/transferred), ended_at, outcome_reason, ended_by, readmit_to_icu_within_48h bool, handover_note_id) — index (hospital_id, status), (admission_id).
- **ip.hdu_reviews** (stay_id, at, by, type enum(am/pm/adhoc), status_text, plan enum(continue/ready_ward/step_up/other), expected_los_h, note_id).
- **ip.hdu_escalations** (id, stay_id, at, trigger enum(news2/pews/meows/staff_concern/parameter/telemetry_alarm), score, band, ladder_step, notified jsonb [{user, at, channel}], acked_by, acked_at, arrived_at, decision enum(observe/step_up_icu/rrt/other), decision_by, note) — index (stay_id, at desc), (hospital_id, acked_at null).
- **ip.hdu_step_requests** (id, admission_id, from_location, to enum(hdu/icu/ward), reason, vitals_snapshot jsonb, requested_by, requested_at, decision enum(accepted/redirected_icu/kept_ward_with_advice/declined), decided_by, decided_at, advice_text, transfer_request_id?).
- Vitals/scores in **clinical.vitals**/**clinical.early_warning_scores** (IP-003) with `care_profile='hdu'`; flowsheet in **ip.icu_flowsheet_hours** (IP-009) with `density=hdu`; charges via IP-005 recurring charge class.
- Read models: `analytics.mv_hdu_board`, `analytics.mv_hdu_indicators_monthly` (occupancy, ALOS, step-up %, ICU readmission ≤ 48 h %, escalation ack times, criteria override %).

## 5. Business Rules & Validations
- Step-down/step-up decisions must reference a criteria evaluation snapshot; unmet mandatory criteria require override reason by consultant-level user (not resident).
- HDU care profile activates only on HDU-nurse bedside acknowledgement (`received_at`); until then ICU/ward profile continues (no monitoring gap).
- Vitals overdue in HDU > 30 min beyond schedule → in-charge alert; telemetry gap > 10 min → task.
- Escalation ack SLAs: band medium 15 min, high 5 min; unacked → next ladder step automatically; RRT/Code via IP-013.
- ICU readmission ≤ 48 h auto-flag → NC-015 indicator + review task for intensivist.
- Charge class change effective from `received_at` per IP-005 pro-rata rule; insurer justification document generated from criteria snapshot on demand.
- HDU LOS > 5 days without review note in 24 h → supervisor alert; expected LOS updates propagate to IP-025.
- Ratio breach (NC-030) > 1:4 → supervisor warning; new HDU admission with breach requires supervisor override.

## 6. API Surface (`/api/v1/hdu`)
| Method | Path | Purpose | Permission |
|---|---|---|---|
| GET/POST/PATCH | `/units` , `/criteria-sets` | config | `hdu.config.manage` |
| POST | `/evaluate?admissionId=&type=` | evaluate criteria set against live data | `hdu.stay.write` |
| POST | `/step-requests` ; POST `/step-requests/{id}/decide` | ward step-up / ICU step-down requests | `hdu.step.request` / `hdu.step.decide` |
| POST | `/stays` (from accepted request; links IP-001 transfer) ; PATCH `/stays/{id}` ; POST `/stays/{id}/receive` | admit/receive | `hdu.stay.write` / `hdu.stay.receive` |
| GET | `/stays` (?unit,status; cursor) ; GET `/stays/{id}` | list/detail | `hdu.stay.read` |
| POST/GET | `/stays/{id}/reviews` | doctor reviews | `hdu.review.write` |
| GET/POST | `/stays/{id}/escalations` ; POST `/escalations/{id}/ack|decide` | escalation log | `hdu.escalation.write` |
| POST | `/stays/{id}/discharge` (to ward/icu/other) | end HDU stay | `hdu.stay.write` |
| GET | `/board?unit=` | live board | `hdu.board.read` |
| GET | `/stays/{id}/insurer-justification.pdf` | criteria snapshot document | `hdu.stay.read` |
| GET | `/reports/indicators` | KPIs | `hdu.report.read` |

## 7. Domain Events (outbox)
- `hdu.step_request.created|decided` {admission_id, to, decision} → EN-037 (in-charge/intensivist), IP-025.
- `hdu.admitted` {stay_id, admission_id, from, unit, criteria_met_pct} → IP-005 (charge class), RC-002 (room category), IP-003 (care profile switch), IP-025, EN-018, NC-030.
- `hdu.escalation.raised|acknowledged|breached` {band, step} → EN-037, IP-013 (RRT/Code), IP-010.
- `hdu.review.recorded` {plan, expected_los_h} → IP-025 predicted step-down.
- `hdu.stepped_up` {stay_id, to_icu, within_48h_of_icu bool} → IP-009, NC-015, IP-025.
- `hdu.discharged` {to, los_h} → IP-005, IP-001, IP-025, IP-003 (ward profile).
- Consumed: `nursing.ews.escalated` (IP-003), `icu.discharge.ready` (IP-009), `ot.pacu.discharged` (IP-024/IP-006), `ip.transferred|discharge.completed` (IP-001/IP-002), `device.vitals.received` (EN-042).

## 8. Screens (UI)
- **HDU Board** (desktop / EN-018 TV): bed tiles with NEWS2 trend sparkline, O2/NIV, hours in HDU vs expected, next review, escalation open (red pulse), step-down/step-up candidates list; live via Socket.IO.
- **Step-Down/Step-Up Decision Panel** (desktop/tablet within IP-009 or IP-003 patient chart): criteria checklist with live values (green/red), override reason fields, destination bed picker, order-set builder, handover note preview; hotkeys `Ctrl+Enter` accept.
- **HDU Flowsheet** (desktop/tablet): IP-009 grid at q2h density + escalation strip; `V` new vitals, `E` escalate.
- **Escalation Inbox** (phone via IP-010/IP-004): ack/arrive/decide buttons; deep link to chart.
- **Step Request Queue** (desktop, HDU in-charge): pending requests with vitals snapshot; accept/redirect/keep-with-advice.
- **Reports** (desktop).

## 9. Integrations
- EN-042 telemetry/central station (HL7 ORU or vendor API) → vitals; IP-009/IP-003 engines; IP-001 transfers; IP-005/RC-002 charge class; EN-018 board; NC-030 ratios; IP-013 RRT.

## 10. Reports & Analytics
- Occupancy & ALOS, source mix (ICU/ward/PACU), step-up % (to ICU) and ICU readmission ≤ 48 h %, escalation counts & ack times by band, criteria override %, NEWS2 distribution at admission/discharge, HDU-day revenue & insurer disputes (with IP-005), nurse ratio compliance, mortality in HDU.
- MVs: `analytics.mv_hdu_board`, `analytics.mv_hdu_indicators_monthly` → NC-011/NC-015.

## 11. Notifications
- Push: step request pending (HDU in-charge/intensivist), escalation (ladder), review due, vitals overdue, telemetry gap, ICU readmission flag (intensivist/quality).
- Family (EN-009 optional): "moved to HDU/ward" informational message without clinical values.

## 12. Permissions (RBAC keys)
`hdu.config.manage` (3, 11 HOD), `hdu.stay.write` (11, 7, 14 co-sign), `hdu.stay.receive` (18, 17 HDU-trained), `hdu.stay.read` (clinical, 27, 28, 58), `hdu.step.request` (7, 14, 17, 18, 9, 10), `hdu.step.decide` (11, 7 consultant), `hdu.review.write` (11, 7, 14), `hdu.escalation.write` (17, 18, 22, 7, 11, 14), `hdu.board.read` (11, 18, 22, 4, IP-025 bed manager), `hdu.report.read` (11, 22, 54, 4, 58).

## 13. Non-functional
- 2000-bed site: 60–100 HDU beds, ~40 step moves/day, ~150 escalations/day; criteria evaluation < 500 ms (reads latest flowsheet/labs from read model); board ≤ 2 s refresh.
- Offline: vitals entry via IP-004 queue; escalation requires connectivity (fallback phone tree printed per unit).
- Print: step-down order set, handover, insurer justification (A4). i18n as IP-003.

## 14. Acceptance Criteria
1. Given an ICU patient on FiO2 0.35, no vasopressor for 14 h, extubated 26 h ago, GCS 15, when the intensivist evaluates step-down criteria, then all mandatory criteria show met with values and the transfer to HDU can proceed without override.
2. Given lactate still 3.5 (unmet mandatory criterion), when a resident tries to accept step-down, then the override field is disabled and a consultant-level user is required.
3. Given the HDU nurse scans the wristband on arrival, then `received_at` is set, care profile switches to `hdu` (vitals q2h tasks generated), and IP-005 changes the daily charge class from that timestamp.
4. Given telemetry sends vitals giving NEWS2 = 6, then an escalation at ladder step "registrar/intensivist ≤ 15 min" is created, push sent, and if not acked in 15 min it auto-escalates to the next step.
5. Given a ward patient with NEWS2 5, when the ward nurse opens escalation, then a step-up suggestion appears; when requested, the HDU in-charge sees vitals snapshot and can accept, redirect to ICU, or keep in ward with advice (all recorded).
6. Given a patient stepped down from ICU 30 h ago is stepped back up, then `readmit_to_icu_within_48h` is true and NC-015 indicator increments with a review task.
7. Given ward-readiness criteria met and consultant marks "ready for ward", then IP-025 shows the patient in the step-down-to-ward queue with expected time.
8. Given no HDU bed available at step-down, then the ICU patient is flagged `hdu_ready_waiting` on IP-025 and counted in ICU-blocked metrics.
9. Given TPA disputes HDU class, when billing requests justification, then a PDF with the criteria snapshot (values, timestamps, accepting doctor) is generated.
10. Given a user with `hdu.stay.read` only, when calling POST /stays/{id}/discharge, then 403 and audit.

## 15. Enhancements / Later phases
- Predictive deterioration score from telemetry (AI-005) to pre-empt step-up; automatic step-down candidate identification across ICUs for IP-025; wearable continuous monitoring on wards to create "virtual HDU" (EN-042); insurer API pre-notification of level-of-care change (RC-002); ISCCM/NABH benchmarking across branches (EN-041).

## 16. Open Questions for the Hospital
1. HDU units present (medical/surgical/cardiac/neuro), bed counts, and nurse ratio? Any telemetry/central station model?
2. Hospital's written step-down/step-up criteria (or adopt ISCCM defaults)? Who may override — consultant only?
3. Monitoring frequency profile for HDU (q1h/q2h/q4h) and NEWS2 ladder with named responders?
4. HDU charge units and pro-rata rules; insurer room-rent categories used in contracts?
5. Elective post-op HDU booking practice and PACU→HDU flow?
6. ICU bed hold after step-down (hours) policy?
