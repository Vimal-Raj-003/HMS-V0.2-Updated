# IP-025 — Bed Management Command Centre / Patient Flow (enterprise bed board & occupancy, demand–capacity forecasting, predicted discharge & discharge-before-noon programme, transfer/step-down queues, ED boarding & OT/ICU pressure, housekeeping turnover dispatch to NC-018, transport dispatch, escalation playbooks, surge/mass-casualty mode)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-025 |
| Phase | 7 |
| Priority | P1 |
| Complexity | High |
| Depends on | IP-001 (ADT, bed hierarchy/status/holds/reservations, transfer requests, transport tasks, waitlist, bed board read model — IP-025 is the enterprise control layer on top), IP-002 (discharge planning, expected discharge, readiness checklist, discharge TAT), IP-003 (nursing readiness, NEWS2 for acuity), IP-009/IP-016 (ICU/HDU occupancy, step-down candidates), IP-006 (OT schedule → post-op bed/ICU demand), IP-018 (transfer queues, temporary-away, inbound requests), OP-006/TR-001 (ED census, boarding, admission requests, mass casualty), OP-001 (elective admission schedule/pre-admissions), IP-020 (pathway day → predicted discharge), IP-005 (billing clearance status for discharge), NC-018 (housekeeping tasks/turnover SLA, staff location), NC-030 (nurse ratios/roster capacity), NC-013 (ambulance inbound ETA), EN-018 (command centre wall & ward TVs), EN-037 (escalations), EN-038 (approval for bed blocks/overrides), EN-001/NC-011 (analytics), AI-005 (forecasting: LOS, discharge, demand — rules-based first), EN-041 (multi-branch group view), EN-042 (RTLS/IoT optional), EN-024, EN-009 (family messages) |
| Feature flag | `module.bed_command_centre.enabled` (sub-flags: `bcc.forecasting`, `bcc.dbn_programme`, `bcc.auto_housekeeping_dispatch`, `bcc.transport_dispatch`, `bcc.surge_mode`, `bcc.group_view`, `bcc.rtls`) |
| Primary roles | Bed manager / Patient-flow coordinator (custom role under 22/24 "Bed Manager"), Nurse Supervisor / Matron (22), Housekeeping Supervisor (50), Ward Boy/Transport (23), Admission desk (24), ED charge nurse (19), MS/Duty medical officer (4) |
| Secondary roles | Ward in-charge (17/18), Intensivist (11), Surgeon (9), Doctor IP (7), Billing (27), Branch Admin (3), Quality (54), Group admin (2), Security (51), Auditor (58) |
| Regulatory | NABH 5th ed. AAC.1/AAC.2 (bed availability, admission process, waiting/transfer policy), AAC.7 (transfers), ROM/PSQ (efficiency indicators: bed occupancy, ALOS, bed turnover interval, discharge TAT), Disaster/mass casualty preparedness (FMS/NABH: surge plan, hospital disaster plan), State/municipal bed-availability reporting mandates (e.g., COVID-era public dashboards, DHS bed portals), Clinical Establishments Act (bed strength & indoor register), DPDP (no PHI on public/TV displays), Fire/occupancy norms (bed capacity limits) |

## 1. Purpose
IP-025 is the hospital's air-traffic control for patients: a live enterprise view of every bed (status, patient acuity, expected discharge, blockers), the demand queue (ED boarders, OT post-op needs, elective pre-admissions, ICU/HDU step-downs, inbound transfers) and the supply pipeline (discharges predicted/confirmed, beds in cleaning, blocked beds). It predicts discharges, orchestrates the discharge-before-noon programme, assigns beds with rules, auto-dispatches housekeeping turnover and transport, tracks turnaround SLAs, escalates bottlenecks with playbooks, forecasts occupancy by ward/class for the next 24–72 h, and runs surge/mass-casualty bed expansion — reducing ED boarding, LOS and lost admissions.

## 2. Users & Jobs-to-be-done
- **Bed manager / patient-flow coordinator** (desktop 3-monitor + EN-018 wall; phone): 24×7 view of occupancy, queue, predicted discharges; assign/prioritise beds; chase blockers (billing clearance, transport, summary pending, cleaning); run bed huddles (08:30/14:00) with ward-wise expected discharges; manage surge; report daily census.
- **Ward in-charge** (desktop/tablet): confirm expected discharge date/time (EDD/EDT) daily, flag blockers, mark bed ready/cleaning, request transfers, accept incoming.
- **Housekeeping supervisor/staff** (phone): receive turnover dispatch on bed release, accept/start/complete with photo/QR, SLA timers; supervisor rebalance.
- **Transport/ward boys** (phone): dispatch for admits/transfers/discharges, start/complete, location; auto-assignment by zone.
- **ED charge nurse / physician**: see boarding list with wait time, bed offers, accept; escalate; predicted ED-to-bed time.
- **Surgeon/OT coordinator**: post-op bed/ICU confirmations for tomorrow's list; conflicts.
- **Admission desk**: elective admission arrivals vs bed readiness; waitlist; deposit/pre-auth status.
- **MS/duty officer**: escalations (occupancy > 90 %, ICU full, ED boarding > 4 h), surge decisions, diversion advisories.
- **Group admin (`bcc.group_view`)**: cross-branch occupancy & transfer options.
- **Family**: bed readiness/discharge time messages (EN-009) & lounge guidance.

## 3. Core Workflows

### 3.1 Enterprise bed board & census (read model)
1. **System** maintains `analytics.bed_board` (IP-001) enriched into `flow.bed_state` per bed: status (available/assigned/occupied/discharge_pending/cleaning/blocked/reserved/away), patient acuity (NEWS2 band, ICU/HDU flag, isolation), payer, LOS, EDD/EDT & confidence, discharge readiness stage (planned → summary signed → billing cleared → transport → left), blockers, housekeeping task state & SLA, transport task, class/ward/speciality; refreshed on events (< 2 s) with periodic reconciliation job (5 min).
2. Views: hospital → block → floor → ward → bed; heat-map by occupancy; filters (class, speciality, isolation, sex, ventilator-capable); counts: total, occupied, available-clean, available-dirty, cleaning (with SLA countdown), blocked (reason), reserved (for whom/when), expected discharges today (by hour), predicted discharges (model), ED boarders, waitlist, ICU/HDU pressure, OT cases needing beds today/tomorrow; midnight census & bed-days for indoor register/statistics; state bed-availability report export.

### 3.2 Predicted discharge & discharge-before-noon (DBN) programme (`bcc.forecasting`, `bcc.dbn_programme`)
1. **EDD/EDT** sources: doctor's expected discharge (IP-002 `ip.discharge.expected`), pathway target (IP-020), admission expected LOS (IP-001), package LOS (IP-008); **prediction** (rules-based first: speciality/diagnosis/procedure median LOS from history × adjustments for age/ICU stay/complications; AI-005 later) gives `predicted_discharge_at` with confidence; conflicts shown (doctor says Thu, model says Fri).
2. **Daily EDD confirmation task** to ward in-charge/doctor by 10:00 (rounds) — confirm/adjust; unconfirmed > 24 h flagged; family informed of tentative date (EN-009 opt-in).
3. **DBN programme**: for patients with EDD = today: checklist progress from IP-002 (summary signed by 09:00, pharmacy take-home ready, billing pre-final by 10:00, TPA final approval requested previous evening, transport booked) with owner & timer; **discharge lounge** (`flow.discharge_lounge`) allocation to free the bed early (patient waits for bill/medicines in lounge with nurse) → bed released at lounge move; DBN % KPI by ward; blockers escalate to bed manager (e.g., TPA approval > 2 h → TPA desk lead).

### 3.3 Demand queue & bed assignment
1. **Demand sources** into `flow.bed_requests` (unified queue): ED admission requests (OP-006; boarding clock starts at decision-to-admit), OT post-op needs (IP-006 schedule: ward/HDU/ICU by case), elective pre-admissions (OP-001/IP-001 scheduled), ICU→HDU→ward step-downs (IP-009/IP-016), inter-ward transfers (IP-001), inbound transfers (IP-018), direct admissions; each with required class, ward/speciality preference, sex, isolation, equipment (ventilator/monitor/bariatric), payer class eligibility, priority (emergency > ICU step-down freeing critical bed > OT post-op time-bound > urgent > elective by scheduled time), requested-at, target time (SLA: ED ≤ 2 h; post-op by PACU discharge; step-down ≤ 4 h).
2. **Assignment**: bed manager (or auto-suggest, IP-001 `adt.auto_bed_suggest`) matches requests to beds (available-clean first, then cleaning with ETA, then predicted discharges with high confidence as "soft assignment"), rules: sex policy, isolation compatibility, class ↔ payer eligibility (RC-002 room-rent limits warn), speciality cohorting, nurse ratio capacity (NC-030) → **assign** → IP-001 reservation/hold with expiry (default 60 min ward / 30 min ED) → notifies ward (accept/prepare), transport dispatch when bed clean; **conflicts** (two requests one bed) resolved by priority with override log; unassigned requests age with colour; ED boarders > threshold trigger escalation playbook (§3.6).
3. **Waitlist** (no bed): request status `waitlisted` with position & ETA estimate (from predicted discharges); patient/family communication (admission desk); auto-offer when bed frees; elective postponement suggestions when forecast shows shortage.

### 3.4 Turnover: housekeeping & transport dispatch (`bcc.auto_housekeeping_dispatch`, `bcc.transport_dispatch`)
1. On `ip.discharge.completed`/`ip.transferred`/`bed.released` → bed status `cleaning` → **NC-018 housekeeping task auto-created** with type (routine/terminal/isolation), priority (from waiting demand: bed with a pending request = urgent), zone assignment to nearest available staff (roster NC-030 + last-known location; `bcc.rtls` optional), SLA (ward 45 min / ICU 60 min / isolation terminal 90 min; configurable) → staff accepts (push), starts (scans bed QR), completes (checklist, photo optional) → supervisor spot-inspection sample % → bed `available` → Event `bed.turnover.completed` {minutes} → auto-triggers pending assignment & transport; SLA breach → escalate supervisor → bed manager; dashboard: beds in cleaning with countdown, staff load.
2. **Transport dispatch** (IP-001 `transport_tasks` orchestrated here): auto-create for admit (ED→ward), transfer, discharge (bed→exit/lounge), procedure trips; assign by zone/queue; timers (request→pickup, pickup→arrival); equipment (wheelchair/stretcher/O2); ED boarder transports prioritised; delayed pickups escalate.

### 3.5 Occupancy forecasting & capacity planning (`bcc.forecasting`)
- **24/48/72-h forecast** per ward/class: expected admissions (elective schedule + OT list + ED average by hour/day-of-week from history + inbound transfers) − expected discharges (EDD confirmed + predicted) ± transfers → projected occupancy & shortfall/surplus with confidence bands; alerts when projected > 95 % (ward) or ICU full; suggestions: open flex beds, expedite step-downs, reschedule electives, activate discharge lounge; weekly capacity view for elective scheduling (OP-001/IP-006 can read "bed availability score" for date picking); seasonal patterns (dengue season) surfaced; AI-005 model swap-in later with same interface.

### 3.6 Escalation playbooks, huddles & surge/mass-casualty (`bcc.surge_mode`)
1. **Playbooks** (configurable EN-038/EN-037): triggers (ED boarding > 4 h for any patient, > N boarders, ward occupancy > 90 %, ICU 0 beds, cleaning SLA breaches > X/h, discharge lounge full, transport backlog) → actions (notify roles, open flex ward, call extra housekeeping, MS approval for private-to-general downgrade offers, elective deferral list, inter-branch transfer options `bcc.group_view`, ambulance diversion advisory to TR-009 (informational)) with acknowledgement & resolution log.
2. **Bed huddle mode**: screen for 08:30/14:00 huddles: per ward expected discharges (confirmed/predicted), blockers, incoming demand, actions assigned with owners; minutes auto-saved.
3. **Surge/mass casualty** (from OP-006 code yellow/TR-001): one-click surge plan: convert day-care/OPD observation/recovery/private rooms to flex beds (pre-configured `flow.surge_plans` with bed lists & staffing), cancel elective admissions list, expedite discharges (list of "could go home today"), ICU expansion (HDU→ICU capable), family info desk; capacity counters live on wall board; de-escalation restores config; audit.

### 3.7 Exceptions
- Bed board disagrees with reality (patient in wrong bed) → ward corrects via IP-001 with reason; reconciliation job flags orphan/duplicate occupancies.
- Housekeeping staff shortage → tasks queue; supervisor manual reassign; SLA paused with reason (audited).
- Predicted discharge wrong → feedback loop stored (actual vs predicted) for tuning; no clinical decisions from predictions.
- Payer class mismatch at assignment → warning + billing acknowledgement (IP-001 rule).
- Wall board network loss → last state cached with "stale" banner.

## 4. Data Model (schema `flow`)
- **flow.bed_state** (hospital_id, branch_id, bed_id PK, ward_id, class_id, status, sub_status, patient_id?, admission_id?, acuity jsonb {news2_band, icu, isolation}, payer_class, los_hours, edd_at?, edt_at?, edd_confirmed_at?, predicted_discharge_at?, prediction_confidence?, discharge_stage enum(none/planned/summary_signed/billing_cleared/transport/lounge/left), blockers jsonb [{code, since, owner}], housekeeping_task_id?, cleaning_started_at?, cleaning_sla_due_at?, transport_task_id?, hold jsonb?, reservation jsonb?, away jsonb?, updated_at) — Redis mirror for board; index (branch_id, ward_id), (status), (edd_at).
- **flow.bed_requests** (id, hospital_id, branch_id, request_no, source enum(ed/ot_postop/elective/step_down/step_up/transfer_intra/transfer_in/direct/other), source_ref jsonb {er_visit_id?, ot_case_id?, admission_id?, transfer_episode_id?, admission_request_id?}, patient_id?, required_class_id, ward_pref_id?, speciality_id?, sex, isolation_type?, equipment jsonb, payer_class, priority int, priority_reason, requested_at, target_by_at, boarding_started_at?, status enum(open/waitlisted/soft_assigned/assigned/accepted/in_transit/completed/cancelled/expired), assigned_bed_id?, assigned_at, assigned_by, hold_expires_at, ward_ack_at?, transport_task_id?, completed_at, cancel_reason?, escalations jsonb) — index (branch_id, status, priority desc, requested_at), (source_ref gin).
- **flow.discharge_predictions** (admission_id, computed_at, predicted_at, confidence, method enum(rules/model), features jsonb, doctor_edd_at?, actual_discharge_at?, error_hours?) — partition monthly.
- **flow.edd_confirmations** (admission_id, date, confirmed_by, edd_at, edt_at, blockers jsonb, notes, at).
- **flow.discharge_lounge** (branch_id, capacity, chairs jsonb) ; **flow.lounge_stays** (admission_id, in_at, out_at, reason, nurse_id, bed_released_at).
- **flow.turnover_tasks** view over NC-018 tasks with `bed_id`, type, priority, dispatched_at, accepted_at, started_at, completed_at, sla_due_at, breached bool, staff_id, inspection jsonb — plus **flow.turnover_metrics** (bed_id, released_at, clean_at, next_occupied_at, cleaning_min, idle_min, turnover_interval_min).
- **flow.forecasts** (branch_id, ward_id?, class_id?, horizon_h, computed_at, expected_admissions, expected_discharges, projected_occupancy, projected_pct, lower, upper, shortfall, drivers jsonb) — index (branch_id, computed_at desc).
- **flow.playbooks** (hospital_id, code, trigger jsonb, actions jsonb, roles jsonb, active) ; **flow.playbook_runs** (playbook_id, triggered_at, trigger_values jsonb, actions_log jsonb, acknowledged_by, resolved_at, outcome).
- **flow.huddles** (branch_id, at, type, attendees jsonb, ward_summaries jsonb, actions jsonb, minutes_file_id).
- **flow.surge_plans** (branch_id, code, name, flex_beds jsonb [{location, count, class, staffing}], elective_policy, staffing_plan, activation_roles) ; **flow.surge_activations** (plan_id, activated_at, by, reason, deactivated_at, beds_opened, patients_placed).
- **flow.state_reports** (branch_id, date, payload jsonb (state bed portal format), submitted_at, ref).
- Read models: `analytics.mv_flow_kpis_daily` (occupancy %, ALOS, bed turnover interval, ED boarding median/90th, decision-to-bed, DBN %, cleaning SLA %, transport TAT, forecast accuracy MAE, lost admissions), `analytics.mv_ward_flow_board`.

## 5. Business Rules & Validations
- Bed state is derived; only IP-001 mutations change occupancy (IP-025 issues holds/reservations/tasks through IP-001 APIs) — no direct writes to ADT tables.
- Request priority ladder configurable; emergency & ICU-freeing step-downs cannot be outranked by electives; overrides need reason (audited).
- Holds expire (ward 60 / ED 30 min default) → request back to queue with alert; a bed cannot hold two active requests.
- Housekeeping auto-dispatch on release within 10 s; SLA per ward type; breach → supervisor at 0, bed manager at +15 min; terminal clean mandatory for isolation/death.
- EDD confirmation daily by 10:00 (task); prediction never overrides doctor's EDD; discharge lounge move requires nurse assessment (mobile, stable) and doctor OK.
- ED boarding clock from decision-to-admit; target ≤ 2 h (configurable); > 4 h auto-playbook.
- Payer/class eligibility warning; downgrade/upgrade offers require patient consent (IP-001 rules) & billing note.
- Wall/TV boards show no full names (initials/bed only) unless in secure areas (EN-018 policy); family messages only via EN-009 with consent.
- Forecast recomputed hourly (or on major events); accuracy tracked; if MAE > threshold, show low-confidence badge.
- Surge activation requires MS/duty officer role; all changes reversible & audited; elective cancellations flow to OP-001/IP-006 with patient notifications.
- Retention: request/turnover metrics 5 y; predictions 2 y; state reports 3 y.

## 6. API Surface (`/api/v1/flow`)
| Method | Path | Purpose | Permission |
|---|---|---|---|
| GET | `/board` (?branch,ward,class,status; live snapshot) ; WS `flow:board:{branch}` | enterprise board | `flow.board.read` |
| GET | `/census?date=` ; GET `/state-report?date=` ; POST `/state-report/submit` | census/state reports | `flow.census.read` / `flow.report.manage` |
| GET | `/requests` (?status,source,class; cursor) ; POST `/requests` (manual) ; PATCH `/requests/{id}` (priority/notes) ; POST `/requests/{id}/assign` (bed) ; POST `/requests/{id}/soft-assign` ; POST `/requests/{id}/release|cancel|escalate` | demand queue | `flow.request.read` / `flow.request.manage` |
| GET | `/suggest-beds?requestId=` | ranked bed suggestions | `flow.request.manage` |
| POST | `/requests/{id}/ward-ack` | ward accepts incoming | `flow.request.ack` |
| GET | `/discharges/today` , `/discharges/predicted?horizon=` ; POST `/edd/confirm` ; POST `/lounge/admit|release` | discharge programme | `flow.discharge.read` / `flow.discharge.manage` |
| GET | `/turnover` (?status) ; POST `/turnover/{taskId}/reassign|pause|resume` ; POST `/turnover/{taskId}/inspect` | housekeeping orchestration (proxies NC-018) | `flow.turnover.manage` |
| GET/POST | `/transport` , `/transport/{id}/reassign` | transport dispatch (proxies IP-001) | `flow.transport.manage` |
| GET | `/forecast?horizon=24|48|72&ward=` ; POST `/forecast/recompute` | forecasting | `flow.forecast.read` |
| GET/POST/PATCH | `/playbooks` ; GET `/playbook-runs` ; POST `/playbook-runs/{id}/ack|resolve` | escalations | `flow.playbook.manage` / `.ack` |
| POST/GET | `/huddles` | huddle records | `flow.huddle.write` |
| GET/POST/PATCH | `/surge-plans` ; POST `/surge/activate|deactivate` | surge | `flow.surge.manage` / `flow.surge.activate` |
| GET | `/group/board` (`bcc.group_view`) | cross-branch | `flow.group.read` |
| GET | `/reports/kpis` | | `flow.report.read` |

## 7. Domain Events (outbox)
- `flow.request.created|prioritised|assigned|soft_assigned|hold_expired|accepted|completed|cancelled|escalated` {request_id, source, bed?, boarding_min} → IP-001 (hold/reservation), ward push, ED board (OP-006), IP-018, EN-018.
- `flow.edd.confirmed|overdue` {admission_id, edd_at} → IP-002, EN-009 (family tentative date), ward board.
- `flow.discharge.predicted` {admission_id, predicted_at, confidence} → IP-002 (planning), NC-018 (pre-plan), OP-001 (elective date scoring).
- `flow.discharge.blocked` {admission_id, blocker, owner} → owner role (billing/TPA/pharmacy/transport), bed manager.
- `flow.lounge.admitted|released` → IP-001 (bed release), IP-003.
- `flow.turnover.dispatched|accepted|started|completed|sla_breached|inspected` {bed_id, minutes} → NC-018 (task), IP-001 (bed available), assignment engine, supervisor.
- `flow.transport.dispatched|delayed|completed` → IP-001, ward, ED.
- `flow.forecast.updated` {ward, projected_pct, shortfall} / `flow.capacity.alert` {level} → MS, bed manager, OP-001 scheduling.
- `flow.playbook.triggered|acknowledged|resolved` → EN-037/EN-038 chains.
- `flow.surge.activated|deactivated` {plan, beds_opened} → IP-001 (flex beds), OP-001/IP-006 (elective deferrals), NC-030 (staffing), EN-018 banners, TR-009 (diversion advisory).
- Consumed: `ip.admitted|transferred|discharge.expected|discharge.initiated|discharge.completed|admission.closed`, `bed.status.changed|blocked|reserved|released` (IP-001), `housekeeping.task.*` (NC-018), `er.disposition.admit|er.census` (OP-006), `ot.case.scheduled|pacu.discharged` (IP-006/IP-024), `hdu.review.recorded|icu.discharge.ready` (IP-016/IP-009), `transfer.*` (IP-018), `bill.clearance.ready` (IP-005), `pathway.phase.advanced` (IP-020), `roster.published` (NC-030), `ambulance.inbound.eta` (NC-013/TR-009), `code.activated` (mass casualty, IP-013/OP-006).

## 8. Screens (UI)
- **Command Centre Wall** (EN-018 4K/multi-TV; dark theme): tiles — occupancy by ward heat-map, ED boarders (count, longest wait), ICU/HDU free, beds cleaning with SLA rings, expected/predicted discharges by hour, transport queue, forecast 24 h sparkline, active playbooks/surge banner; auto-rotating detail panels; no full names.
- **Bed Manager Console** (desktop 3-pane): left demand queue (sortable by priority/age; drag onto bed), centre bed board (grid/floor plan toggle; bed cards with acuity/EDD/stage/blocker icons), right detail/actions (suggest beds `S`, assign `Enter`, hold `H`, escalate `E`, message ward `M`); real-time; command palette for patient/bed jump (`Ctrl+K`); keyboard filters `1–9` wards.
- **Ward Flow Panel** (nursing station desktop/tablet): incoming assignments (accept), today's expected discharges with checklist stage & blockers, EDD confirm buttons (`Y/N/date`), beds cleaning status, lounge candidates.
- **Discharge Programme Board** (desktop/TV in ward): DBN progress bars per patient with owners/timers.
- **Housekeeping Dispatch** (phone; NC-018 app surface): task cards with SLA countdown, accept/start/complete via bed QR, checklist, photo; supervisor map/list with rebalancing.
- **Transport Dispatch** (phone/desktop): queue by zone, accept/pickup/deliver timestamps.
- **Forecast & Capacity** (desktop): charts per ward/class 24/48/72 h with drivers; elective load calendar; scenario toggle (defer N electives).
- **Playbooks & Surge Console** (desktop): triggers, active runs, surge plan activation with checklist & live counters.
- **Huddle Mode** (large screen): ward-by-ward table with actions/owners; save minutes.
- **Group View** (desktop): branches side by side, transfer options.

## 9. Integrations
- IP-001 ADT APIs (holds/reservations/status/transport), NC-018 housekeeping tasks/app, NC-030 roster, EN-018 displays, OP-006 ED board, IP-006 schedule, IP-002 discharge stages, IP-005 clearance flags, EN-009 family messages, TR-009/NC-013 inbound ETA & diversion advisory, state bed-availability portals (CSV/API via EN-017), RTLS/BLE (EN-042 optional) for staff/asset location, AI-005 forecasting service interface (`/forecast` provider adapter).

## 10. Reports & Analytics
- Occupancy % (midnight/peak) by ward/class/speciality/payer; ALOS & LOS distribution; bed turnover interval (release→next occupancy) & cleaning minutes & SLA %; ED decision-to-bed & boarding hours; DBN % and discharge time-of-day histogram; discharge blockers pareto (billing/TPA/summary/pharmacy/transport/family); waitlist & lost admissions (left without bed/diverted); ICU/HDU pressure hours; transport TAT; forecast accuracy (MAE by ward); playbook triggers & resolution time; surge activations; census/state reports; NABH ROM indicators.
- MVs: `analytics.mv_flow_kpis_daily`, `analytics.mv_ward_flow_board`; NC-011/EN-001 dashboards.

## 11. Notifications
- Push: bed assigned/incoming (ward), hold expiring, EDD confirmation due, discharge blocker (owner), cleaning SLA breach (supervisor), transport delay, ED boarding threshold (MS/bed manager), forecast shortfall, playbook triggered/ack needed, surge activated (all staff banner via EN-018/EN-037).
- SMS/WhatsApp (EN-009, opt-in): family — tentative discharge date, "bed ready/please proceed", discharge lounge instructions; elective patients — admission date reschedule (surge).
- Email: daily census & flow KPI digest (MS/branch admin), weekly forecast.

## 12. Permissions (RBAC keys)
`flow.board.read` (bed manager, 22, 17–19, 24, 4, 3, 11, 9, 7, 27, 54, 58, TV tokens 64 limited), `flow.census.read` (bed manager, 4, 3, 43, 58), `flow.report.manage` (bed manager, 3), `flow.request.read` (as board), `flow.request.manage` (bed manager, 22, 24 for electives, 19 ED create), `flow.request.ack` (17, 18, 22), `flow.discharge.read` (clinical, 27), `flow.discharge.manage` (bed manager, 22, 17 in-charge, 7 for EDD), `flow.turnover.manage` (bed manager, 50 supervisor), `flow.transport.manage` (bed manager, 22, 23 self-tasks), `flow.forecast.read` (bed manager, 4, 3, 24, 9, 22), `flow.playbook.manage` (3, 4, bed manager lead), `flow.playbook.ack` (roles per playbook), `flow.huddle.write` (bed manager, 22, 4), `flow.surge.manage` (3, 4), `flow.surge.activate` (4, duty officer), `flow.group.read` (2, 4), `flow.report.read` (4, 3, 54, 58, bed manager).

## 13. Non-functional
- 2000 beds, ~400 ADT events/day peak, ~500 turnover tasks/day, ~1500 transport tasks/day; board snapshot API p95 < 300 ms (Redis-backed), WS updates < 2 s; queue assignment suggestion < 500 ms; forecast job < 60 s hourly; wall board renders at 4K 30 fps with ≤ 5 % CPU on TV player.
- Resilience: read model rebuild from IP-001 in < 5 min; stale banner on wall if > 60 s without heartbeat; offline phone apps queue task state changes.
- Privacy: PHI minimisation on displays; access audit; DPDP for family messages.
- i18n: labels; housekeeping app in local languages with icons.

## 14. Acceptance Criteria
1. Given a discharge completed at 11:02 on W3-B12, then within 10 s a housekeeping task is dispatched to the nearest available staff with SLA 45 min, the bed shows `cleaning` with countdown on the board, and on completion (QR scan) the bed becomes `available` and any pending request for that class is auto-suggested.
2. Given ED decision-to-admit at 14:00 for a general-class male patient, then a bed request appears with boarding clock; if unassigned at 16:00, ED boarding playbook triggers (MS + bed manager notified); at assignment, the ward gets an accept push and transport is dispatched when the bed is clean.
3. Given two requests (ICU step-down and elective) competing for one clean HDU bed, then the step-down ranks higher; overriding to elective requires reason and is audited.
4. Given a doctor sets EDD Thursday and the model predicts Friday, then both are shown with confidence; ward confirmation on Thursday morning is required by 10:00 or the EDD-overdue flag appears.
5. Given a patient with EDD today whose summary is signed and TPA approval pending > 2 h, then a discharge blocker `tpa_approval` is shown with owner TPA desk and an escalation push is sent.
6. Given the discharge lounge move approved, then the bed is released immediately (turnover starts) while the patient's billing continues, and the DBN metric counts the discharge at lounge time (configurable).
7. Given the 24-h forecast for Ward 5 projects 97 % occupancy, then a capacity alert is created and the OP-001 elective date picker shows low availability for that ward tomorrow.
8. Given surge plan "Mass casualty A" activated by MS, then 40 flex beds appear as available in IP-001 under the configured wards, elective admissions for tomorrow are listed for deferral with one-click notifications, and the wall shows the surge banner and live counters; deactivation restores configuration.
9. Given the wall board loses connectivity for 90 s, then a "stale" banner appears and data refreshes on reconnect without manual reload.
10. Given a hold expires after 60 min without ward acknowledgement, then the request returns to the queue and the bed manager is alerted.
11. Given the daily census job at 00:05, then midnight occupancy per ward matches IP-001 occupancies and the state bed-availability report can be exported.
12. Given a housekeeping user, when calling POST /requests/{id}/assign, then 403 and audit.

## 15. Enhancements / Later phases
- ML discharge & demand forecasting (AI-005) with continuous learning from actuals; RTLS for patients/staff/equipment (EN-042); automated bed-cleaning robots/UV integration; patient-facing "bed ready" app flow with wayfinding (PE-001/EN-034); dynamic pricing/room-upgrade offers at check-in (IP-005/CRM); regional bed exchange with partner hospitals & 108 (EN-017/TR-009); digital twin simulation of flow changes; virtual-ward/hospital-at-home capacity in the same board.

## 16. Open Questions for the Hospital
1. Who runs bed management today (roles, hours, location) and what are the huddle times? Is a physical command centre/wall planned?
2. Turnover SLAs per ward type; housekeeping staffing by zone; QR codes on beds available (EN-013)?
3. ED boarding targets and escalation ladder; MS/duty officer authority for downgrades/diversion?
4. Discharge-before-noon target %, discharge lounge availability (capacity, nurse), family messaging consent policy?
5. Elective scheduling policy vs forecast (can OP-001/IP-006 be constrained by capacity scores)?
6. Surge plans in place (disaster manual): flex bed locations, staffing, elective cancellation rules?
7. State/municipal bed-availability reporting requirements and formats?
8. Multi-branch: should the group view allow cross-branch bed offers and who approves?
9. Any RTLS/IoT for staff/asset location; TV hardware for wall board?
