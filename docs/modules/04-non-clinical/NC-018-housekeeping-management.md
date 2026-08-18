# NC-018 — Housekeeping Management (Task Scheduling, Bed/Room Turnover, Checklists & Inspections, Complaint Log, Mobile App, BMW Link)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-018 |
| Phase | 7 (turnover engine with IP-001/IP-025) / 9 (full scheduling, inspections, contracts) |
| Priority | P1 |
| Complexity | Medium |
| Depends on | IP-001 (bed status `cleaning`→`available`, bed hierarchy, isolation flags), IP-025 (turnover dispatch priorities, SLA, predicted discharge pre-planning; IP-025 orchestrates, NC-018 executes), IP-012 (isolation/terminal cleaning protocols, hand-hygiene & environmental swab audits, outbreak deep clean), IP-006 (OT cleaning between cases/terminal cleaning; OT-turnover tasks), OP-006 (ER bay cleaning), NC-016 (BMW bag collection rounds, colour-code checks at source, spill kits), NC-017 (soiled linen collection / clean delivery transport tasks), NC-006 (housekeeping consumables: disinfectants, mops, bags — issue & consumption; NC-008 cost centre), NC-025 (facility work orders raised from housekeeping findings — leaks, broken fixtures; shared work-order tables), NC-030/NC-029 (housekeeping roster & attendance → available staff per zone/shift), NC-021 (outsourced housekeeping contractor, manpower SLA, penalties; NC-031 contract), NC-032 (cleanliness complaints from patients → tasks), NC-015 (NABH FMS/HIC indicators: cleaning compliance, inspection scores), EN-013 (QR codes on beds/rooms/toilets/carts), EN-037 (push), EN-038 (SLA/escalation), EN-039 (checklist templates), NC-011, EN-024 |
| Feature flag | `module.housekeeping.enabled` (sub: `housekeeping.turnover`, `housekeeping.inspections`, `housekeeping.public_toilet_qr`, `housekeeping.contractor`, `housekeeping.iot_feedback`) |
| Primary roles | Housekeeping Supervisor, Housekeeping Staff (GDA/attendant), Housekeeping Manager / Facility Head |
| Secondary roles | Ward nurse in-charge (17; request cleaning, verify bed ready), Bed manager (IP-025), Infection Control Nurse (21; terminal-clean audits), OT in-charge (20), Quality (54), Contractor supervisor (vendor 63), Patient/family (60; QR feedback), Auditor (58) |
| Regulatory | NABH 6th ed. FMS.1–FMS.3 (safe, clean environment; cleaning schedules & records), HIC.7/HIC.8 (environmental cleaning, disinfectant dilution, terminal cleaning of isolation rooms, spill management), Kayakalp / Swachh Bharat scoring (public hospitals), BMW Rules 2016 (bag collection, colour codes at source — NC-016), Contract Labour (R&A) Act 1970 (outsourced staff records), Hazard communication (chemical MSDS, dilution charts), CDC/WHO environmental cleaning guidance (high-touch surface frequency, three-bucket/colour-coded mop system) |

## 1. Purpose
NC-018 runs the hospital's cleaning operation as a **task engine**: scheduled cleaning of every space (wards, ICUs, OTs, toilets, corridors, OPD, public areas) by frequency and standard, **event-driven bed/room turnover** created automatically when IP-001/IP-025 release a bed (routine / terminal / isolation clean with SLA), OT between-case & terminal cleaning, spill/blood response, BMW and linen transport rounds, staff dispatch to a **mobile app** (QR scan of bed/room, checklist, photo, timer), supervisor **inspections** with scored checklists (NABH/Kayakalp style), complaint intake (patient/staff/QR toilet feedback) → tasks, consumables & chemical dilution control, contractor manpower/SLA management, and KPIs (turnover time, SLA compliance, inspection scores, complaints/1000 patient-days). It closes the loop back to IP-001 so a bed becomes `available` only after cleaning (and inspection where required).

## 2. Users & Jobs-to-be-done
- **Housekeeping staff** (phone/PWA, offline-tolerant): see my task list for my zone/shift ordered by priority & SLA; accept → scan bed/room QR → follow checklist → photo → complete; report obstacles (patient still in bed, family present, maintenance needed); log spill response; BMW/linen rounds.
- **Supervisor** (phone + desktop): live board of tasks per zone, staff on duty (from NC-030), reassign/rebalance, inspect completed beds (random or mandatory for isolation/ICU/OT), score checklists, raise NC-025 work orders, close complaints, manage chemical stock & dilution logs, daily/weekly schedules.
- **Ward nurse in-charge** (nursing station IP-003 widget/tablet): request cleaning (spill, discharge, ad-hoc), see bed-turnover ETA, confirm bed ready (optional double-check), rate service.
- **Bed manager (IP-025)**: dispatch priority overrides, SLA dashboards; escalate.
- **ICN**: verify terminal/isolation cleaning records, disinfectant contact times, environmental swab schedule after outbreak clean.
- **Manager/Facility head/Quality**: schedule compliance, inspection trends, contractor SLA & penalties, NABH evidence.

## 3. Core Workflows
### 3.1 Space master, standards & schedules
1. **Manager** defines **spaces** (link to IP-001 wards/rooms/beds; plus non-bed spaces: toilets, corridors, lifts, OPD rooms, OTs, labs, kitchen, public areas) with **risk class** enum(very_high: OT/ICU/isolation/CSSD; high: wards/ER/labs/dialysis; moderate: OPD/corridors; low: offices/stores) → per class a **cleaning standard**: frequency (e.g. OT: between every case + terminal daily; ICU: high-touch 3-hourly, floor 2× shift; toilets: every 2 h + on demand; wards: 2× day + spot), method (colour-coded mops/cloths: red = toilets, yellow = wards/general, blue = OPD/public, green = kitchen — configurable), disinfectant (hypochlorite 1 %/0.5 %, QAC, H2O2 fogging), contact time, checklist template (EN-039) → **schedules** generate recurring tasks per shift with zone assignment → Event `housekeeping.schedule.published`.
2. QR labels (EN-013) on beds/rooms/toilets/carts; toilets optionally get public "Rate this washroom" QR (`housekeeping.public_toilet_qr`).

### 3.2 Bed/room turnover (event-driven; Phase 7)
1. **System** consumes `bed.released` / `ip.discharge.completed` / `ip.transferred` / `flow.turnover.dispatched` (IP-025 sets priority: urgent when a pending admission/ER boarder waits; type routine/terminal/isolation from IP-012 isolation flag or death/infectious diagnosis) → creates task {bed_id, type, priority, sla_due_at (config: routine 30 min, terminal 60 min, isolation 90 min), zone, checklist} → **auto-assign** to the on-duty staff in that zone with least open tasks (NC-030 roster + NC-029 attendance; skill flags e.g. `terminal_clean_certified`) → push (EN-037) + task appears on staff phone → Event `housekeeping.task.created|assigned`.
2. **Staff** accepts (or supervisor reassigns after `accept_timeout` 5 min) → travels → **scans bed QR** (validates right bed; mismatch → warn) → `started` (bed status in IP-001 = `cleaning_in_progress`) → checklist (strip linen → soiled bag (NC-017 handover), BMW bags (NC-016 colour check), high-touch surfaces, mattress/pillow disinfection, floor, curtains change flag for terminal/isolation, bed rails/IV stand/monitor cables, restock, make bed) with mandatory items → photo (bed made) → **complete** → Event `housekeeping.task.completed` (payload minutes, checklist compliance).
3. **Inspection rule**: if type ∈ (terminal, isolation) or random sample % (config) or ICU/OT → task goes to `awaiting_inspection`; supervisor/nurse in-charge scans QR, scores; **pass** → IP-001 bed `available` (event `bed.turnover.completed` consumed by IP-025); **fail** → re-clean task with reason (deducted from staff/contractor score). Otherwise completion directly releases bed.
4. Exceptions: patient still occupying → `blocked` with reason (IP-001 shows discrepancy to ward); family belongings; maintenance issue found (leak, broken bed) → creates NC-025 work order and marks bed `maintenance` via IP-001 block; SLA breach → EN-038 escalation supervisor → manager → bed manager, event `bed.housekeeping.sla_breached`.
5. **Pre-planning**: `flow.discharge.predicted` from IP-025 → next-shift staffing suggestion per zone.

### 3.3 OT, ER & special cleaning
- IP-006 events `ot.case.completed` → between-case clean task (SLA 15–20 min, checklist), end-of-list → terminal clean; `ot.case.infected` → enhanced protocol. OP-006 bay released → task. Isolation room discharge (IP-012 `isolation.ended`) → terminal clean + fogging/UV log + optional environmental swab request (IP-012). Spill/blood/body-fluid: nurse taps "Spill" → urgent task with spill-kit checklist; mercury spill protocol. Post-construction/outbreak deep clean campaigns (multi-space project task).

### 3.4 Routine scheduled tasks & rounds
- Shift start: generated tasks by zone (toilets 2-hourly, corridors, wards) shown as a **round**; staff scans each space QR to check-in/out with checklist; missed rounds after grace → supervisor alert. BMW collection rounds (NC-016 bag scan/weigh at source), linen cart transport (NC-017), water cooler/dispenser cleaning logs, pest control coordination (NC-025 vendor).

### 3.5 Complaint log & feedback → task
1. Sources: NC-032 grievance (category cleanliness), IP-003 nurse request, staff (NC-014 app), public toilet QR rating (1–5 + issue tags: dirty/no water/no soap/smell/broken) → **System** creates task with priority (rating ≤ 2 → urgent 15 min) → assignment → resolution → complainant notified (if identified) → linked back to NC-032 ticket for closure and SLA.

### 3.6 Inspections & audits (Phase 9)
1. **Supervisor/ICN/Quality** schedules inspections (daily supervisor round, weekly ICN, monthly Quality/Kayakalp) per area with scored checklist (each item 0/1/2 or pass/fail, weight; photo evidence; ATP swab RLU reading optional) → score % → below threshold → corrective task + CAPA (NC-015) → trend per zone/contractor → Event `housekeeping.inspection.recorded`.

### 3.7 Consumables, chemicals & equipment
- Housekeeping store (NC-006) issues per zone/shift; **dilution log** (chemical, concentration, prepared_at, by, expiry hours); MSDS links (NC-004); equipment (scrubbers, vacuum, fogger — NC-002 assets, PM); consumption per patient-day KPI; PPE issue.

### 3.8 Contractor management (`housekeeping.contractor`)
- Contract (NC-031/NC-021): manpower per shift/zone, SLA (turnover minutes, inspection score ≥ 85 %, complaint TAT), penalties matrix; daily manpower attendance vs contract (NC-029 device or supervisor headcount) → shortfall & penalty computation → monthly SLA report → invoice check (NC-005/NC-009).

### 3.9 Task state machine & exceptions
- States: `created → assigned → accepted → in_progress → completed → (awaiting_inspection → passed | failed → re-clean task) | blocked (→ assigned/in_progress after unblock) | cancelled`. Transitions guarded: only assignee (or supervisor) may accept/start/complete; `start`/`complete` require QR match (or audited override); `blocked` needs reason enum(patient_in_bed/family_belongings/maintenance_required/access_denied/equipment_unavailable/other) and auto-notifies the responsible party (ward nurse for patient/belongings, NC-025 for maintenance); `cancelled` only by supervisor/bed manager with reason (e.g. bed re-occupied by same patient after transfer reversal).
- Priority re-evaluation: IP-025 may raise priority while task is open (e.g. ER boarder appears) → push "priority raised" to assignee; supervisor board re-sorts; SLA due recomputed only when policy says (default: keep original SLA, add `urgent` flag).
- Reassignment while in progress: allowed only with reason; partial checklist retained; both staff records show split minutes.
- Mass discharge windows (10:00–14:00): engine batches turnovers per zone, suggests staff rebalancing (borrow from low-load zone) with one-tap accept by supervisor; IP-025 discharge-before-noon predictions pre-warn zones at 08:00.
- Isolation precautions matrix (from IP-012): airborne (fogging + 1 h settle before entry without N95), droplet/contact (enhanced surface protocol), C. difficile (sporicidal agent, no QAC) → protocol id stored on task; checklist template swaps automatically.
- Discrepancies: staff completes but nurse reports bed dirty (via IP-003 "not clean" button) → auto `failed` + re-clean + supervisor review; repeated failures per staff → training flag (NC-027).
- Public holidays/night: reduced schedules; night supervisor role; emergency-only rounds; escalation ladder differs by shift (config).

## 4. Data Model (schema `ops`, prefix `hk_`)
- **hk_spaces**: id, hospital_id, branch_id, space_code, name, type enum(bed/room/ward_common/toilet/corridor/lift/ot/er_bay/opd_room/lab/kitchen/office/public/external), bed_id?/room_id?/ward_id? (IP-001), floor, zone_id, risk_class enum(very_high/high/moderate/low), qr_code, is_public_feedback bool, area_sqm?, active. UNIQUE (hospital_id, space_code); INDEX (hospital_id, zone_id), (bed_id).
- **hk_zones**: id, branch_id, name, floors, supervisor_user_id, contractor_id?, staffing_plan jsonb {shift: headcount}.
- **hk_standards**: id, hospital_id, risk_class/space_type, frequency_rules jsonb [{shift, times, interval_min}], method jsonb (mop colour, disinfectant, dilution, contact_min), checklist_template_id (EN-039), inspection_required bool, sample_pct, sla_minutes by task_type jsonb, version, effective_from.
- **hk_schedules**: id, space_id/zone_id, standard_id, rrule text, shift, generated_until date, active.
- **hk_tasks** (partitioned monthly): id, hospital_id, branch_id, task_no, space_id, bed_id?, type enum(routine/turnover_routine/turnover_terminal/turnover_isolation/ot_between_case/ot_terminal/spill/deep_clean/round/complaint/transport_bmw/transport_linen/adhoc), source enum(schedule/bed_event/ot_event/nurse_request/complaint/qr_feedback/inspection_fail/supervisor), source_ref_id?, priority enum(urgent/high/normal/low), sla_due_at, assigned_user_id?, assigned_by, dispatched_at, accepted_at, started_at, completed_at, inspected_at, status enum(created/assigned/accepted/in_progress/blocked/completed/awaiting_inspection/passed/failed/cancelled), block_reason?, checklist_response jsonb, photos uuid[], minutes_taken int, sla_breached bool, escalation_level int, reclean_of_task_id?, notes. INDEX (hospital_id, branch_id, status, sla_due_at), (assigned_user_id, status), (bed_id, created_at desc), (zone via space).
- **hk_task_events** (status history: task_id, at, by, from, to, meta jsonb, geo?).
- **hk_rounds**: id, zone_id, shift, date, staff_user_id, planned_spaces uuid[], checkins jsonb [{space_id, at, checklist_ok}], missed_count, status.
- **hk_inspections**: id, hospital_id, branch_id, space_id/task_id?, inspector_user_id, kind enum(supervisor/icn/quality/kayakalp/contractor_joint), template_id, items jsonb [{item, score, max, remark, photo}], score_pct, atp_rlu?, result enum(pass/fail), corrective_task_id?, capa_ref? (NC-015), at.
- **hk_complaints** (thin; canonical ticket in NC-032): id, source enum(patient/staff/nurse/qr_public), space_id, rating?, tags text[], description, reporter_contact?, task_id, nc032_ticket_id?, status.
- **hk_chemical_dilutions**: id, branch_id, zone_id, chemical_item_id (NC-006), target_concentration, volume_l, prepared_by, prepared_at, expires_at, used_for_task_ids uuid[].
- **hk_consumption** (zone/shift/item/qty → NC-008), **hk_contractor_attendance** (contract_id, date, shift, zone, planned, present, source enum(biometric/headcount), shortfall, penalty_amount).
- **analytics.hk_daily**: branch, date, zone, task_type, tasks, completed, avg_minutes, p90_minutes, sla_breaches, inspections, avg_score, complaints, recleans, consumables_cost.
- RLS on all; task partitions retained 3 years (NABH evidence), inspections 5 years.

## 5. Business Rules & Validations
- A turnover task must exist for every `bed.released`; duplicate creation prevented (idempotency key = bed_id + release_event_id). Bed cannot become `available` in IP-001 until task `completed` (and `passed` when inspection required); IP-025 may force-release with reason (audited).
- Auto-assignment: only staff clocked-in (NC-029) and rostered (NC-030) for the zone; isolation/terminal tasks only to staff with `terminal_clean_certified` competency (NC-027); max concurrent tasks per staff (config 3); load-balanced; supervisor can override.
- SLA defaults: turnover routine 30 min, terminal 60, isolation 90, spill 15, OT between-case 20, complaint urgent 15/normal 60; escalate at 80 % elapsed (warn) and breach (supervisor), +15 min (manager/bed manager).
- Checklist mandatory items must be ticked; QR scan mandatory to start/complete (override with reason if scanner fails; audited). Photo mandatory for terminal/isolation/OT terminal.
- Inspection scoring: pass ≥ 85 % (config); fail → re-clean task auto-created & original task marked failed; contractor penalty per contract.
- Dilution: chemicals prepared beyond expiry hours cannot be linked to a task; concentration per IP-012 policy (e.g. 1 % hypochlorite for blood spills, 0.5 % routine).
- Numbering `HK_TASK` per branch/day; tasks immutable after completion (corrections via re-clean/annotation).
- Retention: task/inspection evidence 3–5 years; PHI: tasks reference bed not patient (patient identity only via IP-001 with permission).

## 6. API Surface (`/api/v1/housekeeping`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | /spaces ; POST /spaces/import ; GET /spaces/{qr} | space master & QR resolve | housekeeping.space.manage / .read | Y | cursor |
| GET/POST/PATCH | /zones ; /standards ; /schedules ; POST /schedules/generate?date= | config | housekeeping.configure | Y | – |
| GET | /tasks?status=&zone=&type=&assignee=&bed= | task lists (board) | housekeeping.task.read | – | cursor |
| POST | /tasks | ad-hoc/nurse request/spill | housekeeping.task.create (nurses, supervisors) | Y | – |
| POST | /tasks/{id}/(assign|accept|start|block|unblock|complete|cancel|reassign) | lifecycle (start/complete need `qr_code`) | housekeeping.task.execute (staff, own) / .manage (supervisor) | Y | – |
| POST | /tasks/{id}/inspect | pass/fail with scores | housekeeping.inspection.record | Y | – |
| GET | /me/tasks ; GET /me/round ; POST /rounds/{id}/checkin | staff app | housekeeping.task.execute | Y | – |
| POST | /inspections ; GET /inspections?zone=&kind= | audits | housekeeping.inspection.record / .read | Y | cursor |
| POST | /feedback/public/{qr} (unauth, rate-limited) | toilet QR rating | – (captcha) | Y | – |
| POST/GET | /complaints | complaint log | housekeeping.complaint.manage | Y | cursor |
| POST/GET | /dilutions ; /consumption ; /contractor-attendance | ops logs | housekeeping.ops.log | Y | cursor |
| GET | /dashboard ; GET /reports/(turnover|sla|inspection|complaints|rounds|consumption|contractor-sla) | analytics | housekeeping.report.read | – | – |
| WS | `hk:board:<branch>` | live tasks | housekeeping.task.read | – | – |

## 7. Domain Events (outbox)
- `housekeeping.task.created|assigned|accepted|started|blocked|completed|failed|cancelled` {task_id, bed_id?, space_id, type, priority, minutes, sla_breached} → IP-001 (bed status), IP-025 (turnover metrics), NC-030 (workload), NC-021 (contractor score), NC-011.
- `housekeeping.task.sla_breached` {task_id, level} → EN-037/EN-038 escalation, IP-025 (`bed.housekeeping.sla_breached`).
- `housekeeping.turnover.completed` {bed_id, minutes, inspected} → IP-001 sets `available`; IP-025 `bed.turnover.completed`.
- `housekeeping.inspection.recorded` {space_id, score, result} → NC-015 indicators, NC-021 contractor score, IP-012 (ICN kind).
- `housekeeping.complaint.logged|resolved` → NC-032 ticket sync, NC-011.
- `housekeeping.spill.responded` {space_id, minutes} → IP-012.
- Consumes: `bed.released|bed.status.changed|bed.blocked` (IP-001), `flow.turnover.dispatched|discharge.predicted` (IP-025), `ip.discharge.completed|ip.transferred`, `isolation.started|ended` (IP-012), `ot.case.completed|ot.list.ended` (IP-006), `er.bay.released` (OP-006), `grievance.ticket.created` (NC-032 category cleanliness), `roster.published|attendance.punch.recorded` (NC-030/NC-029), `bmw.pickup.scheduled` (NC-016), `laundry.clean.issued` (NC-017), `facility.workorder.completed` (NC-025 → unblock).

## 8. Screens (UI)
- **Staff Task App** (phone PWA, offline queue): bottom nav Tasks / Round / Scan / Me; task cards colour by priority with SLA countdown; big Accept/Start/Complete buttons; QR scan (camera) validates space; checklist with tick-all-mandatory guard, photo capture (compressed), block reasons; haptic/vibration on new urgent task; works offline (queued events sync with server ordering; SLA computed server-side); low-literacy mode: icons + local language + voice prompt.
- **Supervisor Board** (desktop/tablet, realtime WS): kanban/list by zone (Created/Assigned/In progress/Awaiting inspection/Blocked/Breached), staff panel (on duty, current load, location last scan), drag to reassign, bulk assign; floor map heat of pending tasks; shortcuts `A` assign, `I` inspect, `F` filter breached.
- **Inspection screen** (tablet/phone): template items with 0/1/2 chips, photo, ATP value, auto score, submit; history per space.
- **Nurse widget** (in IP-003/IP-025): bed turnover status & ETA, "Request cleaning" (spill/discharge/ad-hoc), rate.
- **Bed manager view** (IP-025 owns; NC-018 provides turnover data).
- **Config** (desktop): spaces import (CSV/from IP-001), standards & checklists, schedules calendar, zones/contractors, SLA matrix.
- **Public washroom feedback page** (phone, no login): smiley 1–5, issue chips, optional comment; thank-you; rate-limited by device/IP.
- **Dashboards** (desktop/TV in housekeeping office): turnover median/p90 by ward, SLA compliance %, open tasks, inspection score trend, complaints, contractor manpower vs plan.
- Empty/error states, WCAG 2.2 AA, i18n (hi/ta/te/kn/ml/mr/bn), large tap targets.

## 9. Integrations
- IP-001/IP-025 bed events & status API (bidirectional), IP-006/OP-006/IP-012 events, NC-016 BMW rounds, NC-017 linen transport, NC-006 consumables & NC-008 costing, NC-025 shared work orders, NC-029/NC-030 staff availability, NC-021/NC-031 contractor SLA & invoices, NC-032 complaint tickets, NC-015 indicators/CAPA, EN-013 QR generation/printing, EN-037 push, EN-038 escalations, EN-039 checklists; optional IoT (`housekeeping.iot_feedback`): washroom feedback panels, occupancy/odour sensors, soap/paper level sensors via EN-042; ATP luminometer CSV import.

## 10. Reports & Analytics
- Bed turnover time (release→available) median/p90 by ward/shift/staff, SLA compliance %, tasks per staff per shift (productivity), re-clean rate, inspection scores by zone/inspector/contractor with trend, complaints per 1000 patient-days & TAT, spill response time, round compliance % (missed check-ins), OT between-case cleaning time, isolation terminal-clean compliance (ICN), consumables & chemical cost per patient-day, contractor manpower shortfall & penalties, NABH FMS/HIC evidence pack export. Read model `analytics.hk_daily`; live board from Redis.

## 11. Notifications
- Staff push: new task (urgent = repeat every 2 min until accepted), SLA warning; Supervisor: unaccepted > 5 min, breach, blocked task, failed inspection, missed rounds, low chemical stock; Nurse: bed ready, task blocked (needs ward action); Bed manager: breach on urgent bed; ICN: isolation clean completed/inspection due; Manager: daily summary, contractor shortfall; Patient (QR feedback with contact): resolution message via EN-009 template.

## 12. Permissions (RBAC keys)
`housekeeping.space.manage|read`, `housekeeping.configure`, `housekeeping.task.read`, `housekeeping.task.create` (nurses/staff/supervisor), `housekeeping.task.execute` (staff, own tasks; ABAC zone), `housekeeping.task.manage` (supervisor: assign/reassign/cancel/override), `housekeeping.inspection.record|read` (supervisor/ICN/quality), `housekeeping.complaint.manage`, `housekeeping.ops.log`, `housekeeping.report.read`, `housekeeping.export`; contractor supervisor (vendor role 63) limited to own zones read/assign. Defaults: Housekeeping Supervisor/Staff (50) as above; Nurse ward (17) create/read; ICN (21) inspection; Quality (54) inspection/report; Bed manager task.read/manage limited to priority.

## 13. Non-functional
- Volumes: 2000 beds → ~600–800 turnovers/day, 3,000+ scheduled tasks/day, 300 staff on 3 shifts, 20k tasks/week; push delivery < 3 s; board updates < 1 s; task list API p95 < 150 ms; QR resolve < 100 ms (Redis).
- Offline: staff app queues accept/start/complete/checklist for ≥ 8 h; conflict rule: server timestamps from device clock adjusted by drift; if reassigned while offline, completion still recorded with note.
- Devices: low-cost Android phones (2 GB RAM) — lightweight bundle, camera QR; TV dashboard.
- Printing: QR labels (EN-013 ZPL), inspection reports PDF, daily task sheets fallback.
- Security: RLS; no PHI in tasks (bed only); public feedback endpoint rate-limited/captcha; audit on overrides.
- i18n & accessibility as CLAUDE.md; iconography for low literacy.

## 14. Acceptance Criteria
1. Given bed W5-12 released at 10:00 with an ER boarder waiting, when IP-025 dispatches, then a `turnover_routine` task with priority urgent and SLA 10:30 is auto-assigned to a clocked-in zone staff within 5 s and a push is delivered.
2. Given the assigned staff does not accept within 5 min, then the supervisor is alerted and can reassign; the task shows escalation level 1.
3. Given staff scans a different bed's QR at start, then the app blocks start with "wrong bed" and offers to look up the correct task.
4. Given an isolation discharge, then task type is `turnover_isolation`, only certified staff are eligible, photo + fogging log are mandatory, task moves to `awaiting_inspection`, and the bed remains `cleaning` until inspection passes.
5. Given an inspection score of 70 % (< 85 %), then a re-clean task is created, original marked failed, and contractor penalty line recorded.
6. Given a task completes at 10:27 for SLA 10:30, then IP-001 shows bed available at 10:27 and IP-025 turnover metric = 27 min.
7. Given a public toilet QR rating of 1 with tag "no water", then an urgent task (SLA 15 min) is created for that space and NC-025 work order suggested; supervisor sees it on the board.
8. Given a staff phone offline for 40 min during which two tasks were completed, then on reconnect events sync in order, SLA is computed from device-adjusted timestamps, and no duplicate tasks are created.
9. Given `ot.case.completed` in OT-3, then a between-case clean task with SLA 20 min is created and OT board (IP-006) shows cleaning status.
10. Given a chemical dilution prepared 26 h ago with 24 h expiry, when staff links it to a task, then the system rejects with expiry message.
11. Given a NC-032 grievance category "cleanliness" for Ward 7 toilet, then a housekeeping task is created and its completion updates the grievance ticket timeline.
12. Given the month-end contractor report, then manpower shortfall days and SLA breaches compute penalties per contract matrix and export to NC-005 invoice verification.
13. Given a user without `housekeeping.task.manage` tries to reassign, then 403 and audit entry.
14. Given a nurse presses "not clean" on a bed marked available 5 minutes ago, then the original task is marked failed, a re-clean task with priority urgent is created, and the bed returns to `cleaning` in IP-001.
15. Given a C. difficile isolation discharge, then the task uses the sporicidal protocol checklist and blocks selection of QAC-based dilutions.
16. Given IP-025 raises priority of an open task, then the assignee's phone shows "priority raised" within 3 s and the supervisor board re-sorts without changing the original SLA due time.
17. Given a mass discharge window with 25 turnovers in Zone A and 3 in Zone B, then the supervisor receives a rebalancing suggestion to borrow 2 staff from Zone B; accepting reassigns pending tasks and logs the borrow.
18. Given a scheduled toilet round with 12 spaces and only 10 QR check-ins by end of window, then the round shows missed_count 2 and the supervisor is alerted with the missed spaces.

### 14.1 Test data & golden path (for e2e)
- Seed: 3 zones, 40 spaces (20 beds, 6 toilets, OT-1, ER bays), 2 standards (routine/isolation), 6 staff (2 certified), 1 supervisor; simulate `bed.released` × 5 (1 isolation) → verify auto-assign, QR start, checklist, photo, inspection pass, IP-001 available, analytics row.

## 15. Enhancements / Later phases
- From VIMS sheet: task scheduling, room turnover, inspection, complaint log (all Phase 7/9 core above).
- (market) Bed-turnover ETA to bed board (IP-025), Kayakalp scoring templates, RTLS/BLE staff location for nearest-staff dispatch (EN-042), robotic/UV-C device logs, predictive staffing from admissions forecast (AI-005), gamified staff scorecards, WhatsApp bot for contractor supervisors, computer-vision cleanliness scoring from photos (AI-007-like, later), integration with washroom IoT sensors, patient-facing "room cleaned at hh:mm" card in PE-001.

## 16. Open Questions for the Hospital
1. In-house vs outsourced housekeeping (contract SLAs, manpower plan per shift/zone, penalty matrix)?
2. Turnover SLA targets per bed class (routine/terminal/isolation) and whether nurse in-charge must confirm bed-ready in addition to housekeeping?
3. Colour-coded mop/cloth scheme and disinfectant policy (chemicals, dilutions, contact times) — from ICN manual?
4. Inspection sampling %, mandatory inspection areas, scoring template (NABH/Kayakalp)?
5. Zones/floor plan and current staff-to-zone mapping; shift timings; do staff have smartphones or will the hospital provide shared devices?
6. Public washroom feedback QR desired? Languages for staff app?
7. Should turnover tasks pre-plan from predicted discharges (IP-025) and are OT between-case cleaning SLAs defined?

