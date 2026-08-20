# EN-006 — Queue Management System (Tokens, Multi-department & Doctor Queues, Priority, Calling, Display Feed, SMS/WhatsApp, Virtual Queue, Walk-in vs Appointment, Analytics)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Module ID       | EN-006                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Phase           | 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Depends on      | OP-001 (registration, appointments, doctor schedules/rooms), OP-007 (vitals room stage), OP-002 (doctor call-next/complete), OP-004/OP-008/OP-003/NC-001 (service queues: lab collection, radiology, pharmacy, cash), EN-018 (TV token boards — display feed & TTS), EN-009 (SMS/WhatsApp), EN-005/EN-013 (token slip print with QR), EN-034 (kiosk), PE-001/OP-020 (virtual queue, live position), EN-007 (counters, rooms, settings), EN-037 (alerts), EN-001 (analytics), OP-006 (ER triage priority) |
| Feature flag    | `module.queue.enabled` (sub: `queue.virtual`, `queue.sms_position`, `queue.multi_stage`, `queue.ml_wait`)                                                                                                                                                                                                                                                                                                                                                                                                |
| Primary roles   | Receptionist / Front Office (24), Doctor (6), Nurse — OPD/Vitals (16), Cashier (26), Lab Technician/Phlebotomist (33/34), Radiology Technician (36), Pharmacist (30), Branch Admin (3)                                                                                                                                                                                                                                                                                                                   |
| Secondary roles | Hospital Admin (analytics), Patient (portal/kiosk/WhatsApp), Call Centre (25), Kiosk/TV devices (64)                                                                                                                                                                                                                                                                                                                                                                                                     |
| Regulatory      | NABH AAC/PRE (patient wait-time indicators, priority for elderly/disabled/pregnant/emergency), Rights of Persons with Disabilities Act 2016 (priority access), Senior Citizens Act (priority), TRAI DLT (SMS templates), DPDP (no full names on public displays — configurable masking)                                                                                                                                                                                                                  |

## 1. Purpose

EN-006 issues and orchestrates tokens for every service point — doctor consultation (per doctor/room), vitals room, cash counters, lab sample collection, radiology, pharmacy, registration desks — with priority classes, appointment-vs-walk-in interleaving, multi-stage journeys (registration → vitals → doctor → pharmacy), calling/recall/skip/transfer, real-time feeds to TV boards (EN-018) and patient phones (WhatsApp/SMS/portal), virtual queue join from home, and wait-time/throughput analytics. It is the operational heartbeat of a 5000-visit/day OPD.

## 2. Users & Jobs-to-be-done

- **Receptionist** (desktop + thermal printer): issue token on check-in (walk-in or appointment arrival), print slip with QR + estimated wait, transfer/re-issue, manage counters. Peak 400 tokens/hour hospital-wide.
- **Doctor** (desktop/tablet in OP-002): see own live queue, call next (`F9`), recall, skip, mark no-show, hold, complete; see waiting count/avg wait.
- **Vitals nurse** (OP-007): call next for vitals stage, forward to doctor queue.
- **Cashier / lab / radiology / pharmacy staff**: counter-based queues with call-next on their consoles.
- **Patient**: token slip/WhatsApp with live position, "your turn" ping; virtual join from app; kiosk self token; TV board.
- **Branch Admin**: configure series, priority rules, ratios, hours, display layouts; monitor all queues; rebalance.
- **Hospital Admin**: analytics — wait time, peak hours, throughput, no-show.

## 3. Core Workflows

### 3.1 Queue configuration

1. Admin defines **queues** per branch: type (doctor/room, department pool, counter pool, service stage), members (doctors/rooms/counters), **token series** (prefix e.g. `A`, `C`, `L`, `P`, `EM`, per doctor `D12-`; daily reset time; numeric width), operating hours from schedules (OP-001), calling mode (staff call-next / auto-assign to free counter), max queue length, avg service time seed (min), **priority classes** (emergency, senior ≥ 60, pregnant, disabled, infant, staff, VIP, appointment-on-time) with rules (jump ahead N, or absolute front), **appointment vs walk-in ratio** (e.g. 2:1 or slot-anchored: appointment served at slot time ± tolerance, walk-ins fill gaps), display config (masking: initials/first name/UHID last 4, language rotation, TTS voice) → `queue_definitions` → Event `queue.definition.updated` (TV boards refresh).
2. Multi-stage journey templates (`queue.multi_stage`): OPD standard = Registration → Vitals → Doctor → (Lab/Rx/Cash); token carries across stages with per-stage sub-queues; auto-forward on completion.

### 3.2 Token issue

1. **Check-in**: receptionist confirms arrival (appointment) or registers walk-in (OP-001) → System issues token from the doctor's/queue's series (`queue_tokens`): number, class, stage, issue time, **estimated wait** = (position × EWMA service time of that queue) adjusted for doctor status → prints slip (EN-005): hospital, token, doctor/room, queue position, est. time, QR (deep-link to live position page/WhatsApp), instructions → WhatsApp/SMS "Token A-23 for Dr X, ~25 min" (EN-009 template) → Event `queue.token.issued`.
2. Sources: reception desk, kiosk (EN-034: UHID/phone/QR scan of appointment), patient app virtual join (`queue.virtual` — token issued remotely with "arrive by" time; auto-activates on geo/QR check-in at hospital, else demoted), call centre, ER triage (OP-006 pushes priority `EM` tokens), IP wards for OP services (lab/rad) with ward priority.
3. Appointment holders: token pre-assigned at booking (optional) and activated on arrival; late arrival beyond tolerance → converted to walk-in class (configurable).
4. Payment gate: doctor queue token becomes `waiting` only after consultation fee paid (OP-005) unless credit/free/follow-up-within-validity; otherwise `awaiting_payment` (visible to cashier queue).

### 3.3 Calling & serving

1. Staff console **Call next** → System picks next by ordering: (1) recalled/held-return, (2) priority class rank & age, (3) appointment slot due, (4) walk-in by issue time with ratio interleave; marks token `called` with counter/room → **display feed** to EN-018 (token + room + TTS announcement in configured languages) + patient WhatsApp "Your turn: Room 3" + in-app push → Event `queue.token.called`.
2. **No response**: staff `Recall` (repeat announcement, max N), then `Skip` → token `skipped` (returns to queue at back or after K tokens per config; after M skips → `no_show`); patient can re-activate at desk.
3. `Start service` (auto when doctor opens the consult in OP-002 or vitals nurse begins) → `in_service`; `Complete` (consult finished / bill paid / sample collected) → `served` → auto-forward to next stage queue if journey template → Event `queue.token.served`; **Hold** (patient stepped out for a test) → `held` with return priority; **Transfer** to another doctor/queue with reason (referral, doctor left) preserving priority; **Cancel** with reason.
4. Doctor status (consulting/break/in OT/left/telemedicine) from OP-001 schedule & OP-002 → shown on boards; break pauses estimates; when doctor absent > threshold → reception alert & suggested redistribution (load balancing).
5. Counter auto-assign mode (cash/lab): counters mark `free` → system assigns next token → board shows "Token C-45 → Counter 2".

### 3.4 Patient live position

- Slip QR / WhatsApp link → public page (no PHI beyond token & doctor) with position, ETA, doctor status; portal/app shows same with push at N-away (configurable, e.g. 3 tokens away: "please return to waiting area"). Hospital Wi-Fi captive-portal deep link (enhancement) opens the page.

### 3.5 Priority handling

- Priority class captured at registration (age auto, pregnancy/disability flags on patient record, ER triage) or by desk override with reason (audited); board shows priority tokens distinctly (e.g. `EM` red pinned top per market practice); fairness cap: priority jump limited so ordinary wait doesn't exceed configured max (e.g. after 3 consecutive priority calls serve 1 regular).

### 3.6 Exceptions & offline

- Reception offline (PWA): local token issuance from a reserved offline block per counter (e.g. numbers 900+), slips print locally; sync merges with server order by issue time; boards show "offline mode" banner.
- TV/board disconnected → console shows warning; audio announcements continue from console speaker fallback.
- Doctor changes room → tokens follow queue (room shown updates on boards).
- End of day: unserved tokens auto-closed `expired` at series reset; report of no-shows.

## 4. Data Model (schema `queue`)

- `queue_definitions` — id, hospital_id, branch_id, code, name, type (doctor/department_pool/counter_pool/stage), stage_key, member_refs jsonb (doctor_ids/room_ids/counter_ids), series_prefix, series_scope (per_queue/per_doctor/per_branch), reset_time, number_width, calling_mode (call_next/auto_assign), avg_service_sec_seed, max_length, priority_rules jsonb, appt_walkin_ratio, appt_tolerance_min, skip_policy jsonb (return_after, max_skips), display_config jsonb (mask_mode, languages[], tts_voice, template_id), hours_source (schedule/fixed), active, version.
- `queue_journeys` — id, hospital_id, name, stages jsonb [{stage_key, queue_selector, auto_forward}], applies_to (department/visit_type).
- `queue_tokens` — id, hospital_id, branch_id, queue_id, journey_id?, token_no (int), token_display (text e.g. `A-023`), series_date, patient_id, visit_id, appointment_id?, source (desk/kiosk/app/callcentre/er/ward), class (regular/appointment/priority_*), priority_rank, stage_key, status enum (issued/awaiting_payment/waiting/called/recalled/in_service/held/skipped/no_show/served/transferred/cancelled/expired), issued_at, activated_at, called_at, service_start_at, service_end_at, counter_id/room_id, called_by, est_wait_sec_at_issue, skip_count, recall_count, transfer_from_token_id, notes, offline_origin (bool). UNIQUE(queue_id, series_date, token_no). Index (hospital_id, queue_id, series_date, status), (patient_id, issued_at desc). Partition monthly.
- `queue_events` — token_id, event (issued/called/recalled/skipped/held/resumed/served/transferred/cancelled/no_show/forwarded), at, by, counter_id, meta jsonb; partitioned monthly (high write); source for analytics.
- `queue_counters` — id, hospital_id, branch_id, queue_id, code, name, location, workstation_id, status (free/busy/closed), current_user_id, current_token_id.
- `queue_doctor_status` — doctor_id, branch_id, status (consulting/break/in_ot/away/tele/offline), since, room_id, source.
- `queue_wait_stats` (rolling) — queue_id, bucket_15m, tokens_issued, served, avg_wait_sec, p90_wait_sec, avg_service_sec, no_show; feeds EN-001 `fact_queue_15m`.
- `queue_display_feeds` — queue_id/board_id, payload jsonb (now serving, next 3, doctor status), updated_at (Redis-first, DB snapshot).
- Redis: `queue:<hospital>:<queue>:state` sorted sets by effective priority key; pub/sub `queue:<hospital>:<queue>` for boards/consoles.

### 4.1 Token state machine

| From                          | Event                                   | To                                        | Notes                                 |
| ----------------------------- | --------------------------------------- | ----------------------------------------- | ------------------------------------- |
| —                             | issue (paid/credit)                     | waiting                                   | series number allocated               |
| —                             | issue (unpaid, doctor queue)            | awaiting_payment                          | cashier queue sees it                 |
| awaiting_payment              | payment.captured / credit ok            | waiting                                   | activated_at set                      |
| issued (virtual/pre-assigned) | check-in (QR/geo/desk)                  | waiting                                   | late → class demoted                  |
| waiting                       | call-next                               | called                                    | counter/room, board + WhatsApp        |
| called                        | recall (≤ N)                            | recalled                                  | announcement repeated                 |
| called/recalled               | start service (auto from OP-002/OP-007) | in_service                                |                                       |
| called/recalled               | skip                                    | skipped                                   | back after K tokens; skip_count++     |
| skipped                       | skip_count ≥ M                          | no_show                                   | patient notified; revivable at desk   |
| in_service                    | hold                                    | held                                      | returns with priority on resume       |
| held                          | resume                                  | waiting                                   | front-of-queue flag                   |
| in_service                    | complete                                | served                                    | auto-forward to next stage if journey |
| waiting/called/held           | transfer                                | transferred (+ new token in target queue) | priority preserved                    |
| any active                    | cancel                                  | cancelled                                 | reason mandatory                      |
| any active                    | series reset                            | expired                                   | analytics no-show/expired             |

## 5. Business Rules & Validations

- Effective ordering key = (priority_rank desc, appointment_due_at asc if appointment within tolerance, issued_at asc) with ratio interleave and fairness cap; served in DB transaction with `SELECT … FOR UPDATE SKIP LOCKED` on the queue head to avoid double-call across consoles.
- One active token per patient per queue per day (re-issue cancels previous); a patient may hold tokens in multiple stage queues only via journey forwarding.
- Doctor queue token requires payment/credit status unless `queue.allow_unpaid`; follow-up validity from OP-001 rules.
- Priority override by desk requires reason; ER `EM` class always front (safety).
- Series reset daily at configured time; numbers never reused within a day; offline block reserved per counter (configurable size).
- Estimated wait: EWMA (α=0.3) of last 20 service times per queue/doctor × position, +break time; shown as range (±20 %); ML model later (`queue.ml_wait`, AI-005).
- Skip → back of queue after K=3 tokens; after 2 skips → no_show (configurable); no_show tokens can be revived at desk within the day.
- Display privacy: default shows token + first name initial + room; full-name mode requires admin confirmation (DPDP).
- Announcement/notification throttles: max 1 position SMS per token (at issue), WhatsApp updates at N-away and called; SMS fallback only for called (cost).
- Retention: tokens/events 2 years (analytics), aggregated forever.

## 6. API Surface (`/api/v1/queue`)

| Method         | Path                                                                                                                                                        | Purpose                                             | Permission                                                    | Notes             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- | ----------------- |
| GET/POST/PATCH | /definitions ; /definitions/:id ; /journeys                                                                                                                 | config                                              | queue.config.manage                                           | versioned         |
| GET/POST/PATCH | /counters ; POST /counters/:id/open                                                                                                                         | close                                               | free                                                          | counters          | queue.counter.manage                  |     |
| POST           | /tokens                                                                                                                                                     | issue token {queueId                                | doctorId, patientId, visitId, appointmentId?, class?, source} | queue.token.issue | Idempotency-Key; returns slip payload |
| GET            | /tokens?queue&date&status ; GET /tokens/:id                                                                                                                 | list/detail                                         | queue.token.read                                              | cursor            |
| POST           | /tokens/:id/activate                                                                                                                                        | virtual/pre-issued → waiting                        | queue.token.issue / patient (self via portal)                 |                   |
| POST           | /queues/:id/call-next {counterId                                                                                                                            | roomId}                                             | call next                                                     | queue.token.call  | SKIP LOCKED                           |
| POST           | /tokens/:id/recall ; /skip ; /hold ; /resume ; /start ; /complete ; /transfer {toQueueId, reason} ; /cancel {reason} ; /no-show ; /priority {class, reason} | token ops                                           | queue.token.call / queue.token.manage (transfer/priority)     |                   |
| GET            | /queues/:id/live                                                                                                                                            | live board state (now serving, next N, counts, ETA) | queue.board.read (device/staff)                               | WS `queue:<id>`   |
| GET            | /public/tokens/:publicToken                                                                                                                                 | patient live position (no PHI)                      | public (signed token)                                         | rate-limited      |
| GET            | /doctors/:id/status ; PUT /doctors/:id/status                                                                                                               | doctor status                                       | queue.doctor.status                                           | from OP-002       |
| GET            | /overview?branch                                                                                                                                            | admin all-queues view                               | queue.overview.read                                           |                   |
| POST           | /kiosk/tokens                                                                                                                                               | kiosk issue (device token)                          | queue.token.issue (device)                                    |                   |
| POST           | /virtual/join                                                                                                                                               | patient joins from app                              | patient scope                                                 | `queue.virtual`   |
| GET            | /analytics/wait?queue&from&to ; /analytics/throughput ; /analytics/no-show ; /analytics/peak                                                                | analytics                                           | queue.analytics.read                                          | MV                |

## 7. Domain Events (outbox)

- `queue.token.issued|activated|called|recalled|skipped|held|resumed|started|served|transferred|cancelled|no_show|expired|forwarded` → EN-018 boards, EN-009 messages, OP-002/OP-007 consoles, EN-001 facts, OP-001 (visit status).
- `queue.definition.updated`, `queue.counter.opened|closed`, `queue.doctor.status_changed` → boards.
- `queue.alert.long_wait` (wait > threshold), `queue.alert.doctor_absent`, `queue.alert.length_exceeded` → EN-037 to reception/HOD.

## 8. Screens

- **Reception Queue Console** (desktop): today's tokens per doctor/queue tabs, issue token (search patient / scan appointment QR), print/reprint slip, transfer, priority, revive no-show; live counts & ETA; shortcuts `F2` issue, `F4` reprint, `T` transfer, `P` priority, `/` search. Real-time; offline banner + offline block issuance.
- **Doctor Live Queue panel** (in OP-002, desktop/tablet): now serving, next 5, waiting count, avg wait, buttons Call next (`F9`), Recall (`F10`), Skip (`F11`), Hold, Complete (auto on consult close); patient banner preview; break toggle.
- **Counter Console** (cash/lab/rad/pharmacy; desktop): call next/auto-assign, current token, mark free; `F9` call.
- **Vitals stage console** (OP-007) same controls; forward to doctor.
- **Admin Queue Overview** (desktop/TV): heatmap of all queues (waiting, avg wait, longest wait, doctor status), alerts, rebalance suggestions, open/close counters.
- **Queue Config** (desktop): definitions, series, priority rules, ratios, journey builder, display settings with board preview.
- **Patient Live Position** (phone web/app; via slip QR/WhatsApp link): token, position, ETA, doctor status, map hint; auto-refresh; multilingual; "notify me 3 tokens before" toggle.
- **Kiosk token screen** (EN-034): large buttons, UHID/phone/QR, print slip.
- **TV Token Board** (EN-018): now serving/next 3 per doctor with room, TTS; emergency banner overlay.

## 9. Integrations

- EN-018 (Socket.IO feed per board; TTS text with language rotation, Chromecast-ready boards (market)), EN-009 (DLT templates: token issued, called, N-away; WhatsApp interactive "I'm here"), EN-005/EN-013 (slip QR), EN-034 kiosk, PE-001/OP-020 virtual queue & push, OP-001 schedules/appointments/rooms, OP-002 consult events, OP-006 ER priority tokens, IP-003 ward tokens for OP services, AI-005 ML wait estimates later.

## 10. Reports & Analytics

- Average/p90 wait per doctor/queue/hour, service time, throughput per doctor, peak-hour identification (heatmap day×hour), no-show rate (appointments vs walk-in), skip/recall counts, priority usage & overrides, appointment vs walk-in mix and adherence to ratio, counter utilisation, virtual queue conversion, longest waits (NABH indicator: OPD waiting time). MVs: `analytics.mv_queue_hourly`, `fact_queue_15m`.

## 11. Notifications

- Patient: token issued (SMS/WhatsApp with link), N-away reminder (WhatsApp/push), called (WhatsApp/push; SMS fallback), no-show notice with re-activate instructions.
- Staff: long wait threshold breach, doctor absent with waiting patients, queue length exceeded, board offline.
- TV: call announcements with chime + TTS.

## 12. Permissions (RBAC keys)

`queue.config.manage` (Branch/Hospital Admin) · `queue.counter.manage` (Reception lead, Cashier lead) · `queue.token.issue` (Reception, Kiosk device, Call centre, ER, Ward) · `queue.token.read` · `queue.token.call` (Doctor, Nurse, Cashier, Lab, Rad, Pharmacy — scoped to own queues via ABAC `own_queue_only`) · `queue.token.manage` (transfer/priority/cancel — Reception, Nurse in-charge) · `queue.board.read` (device tokens, staff) · `queue.doctor.status` (Doctor, Reception) · `queue.overview.read` (Admin, Reception lead) · `queue.analytics.read` (Admin, HOD) · `queue.virtual.join` (patient scope).

## 13. Non-functional

- 5000 visits/day → ~15k tokens/day across stages, peaks 400/hour; issue p95 < 150 ms; call-next p95 < 100 ms; board fan-out < 500 ms to 200 TV boards; Redis-backed state with DB as source of truth (write-through, recover on restart).
- Console works on 3G tablets; PWA offline block for reception; boards auto-reconnect.
- Accessibility: high-contrast boards, TTS in `en, hi, ta, te, ml, kn, mr, bn`, large fonts; patient page WCAG AA.
- Privacy: no full names by default on public screens; public position page tokenised & rate-limited.

## 14. Acceptance Criteria

1. Given a walk-in registered for Dr X, when the receptionist checks in, then a token in Dr X's series prints with QR and estimated wait, and a WhatsApp/SMS is sent within 30 s.
2. Given two consoles pressing Call Next simultaneously on the same queue, when processed, then two different tokens are called (no double call) — verified with concurrency test.
3. Given an appointment holder arriving within tolerance and 5 walk-ins waiting, when call-next runs with ratio 2:1, then the appointment token is served at its slot and walk-ins interleave per ratio.
4. Given a senior citizen priority token, when issued, then it jumps ahead per rule but the fairness cap prevents more than 3 consecutive priority calls.
5. Given an ER `EM` token pushed by triage, when issued to a doctor queue, then it appears pinned at top in red on the board and is called first.
6. Given a token skipped twice, when skipped again, then it becomes no-show, the patient is notified, and the desk can revive it.
7. Given a doctor sets Break, when the board renders, then status shows "On break" and ETA for waiting tokens increases accordingly.
8. Given the reception PWA loses connectivity, when a walk-in arrives, then a token from the offline block is issued and printed, and on reconnection it syncs without collision.
9. Given a token called, when the TV board is connected, then it updates within 500 ms with TTS announcement in configured languages.
10. Given a patient scanning the slip QR, when opening the public page, then only token, doctor/room, position and ETA are visible (no name/UHID).
11. Given a doctor completes a consult in OP-002, when the visit closes, then the token auto-marks served and forwards to the pharmacy/lab stage queue if orders exist (journey template).
12. Given a virtual join from the app, when the patient does not check in by the arrive-by time, then the token is demoted to walk-in class at arrival or expired per config.
13. Given a wait > 45 min on any doctor queue, when detected, then reception lead and HOD receive an alert with the queue snapshot.
14. Given end of day, when the series resets, then unserved tokens are marked expired and the analytics MV includes them as no-show/expired.
15. Given a user with `queue.token.call` scoped to own queue, when calling next on another doctor's queue, then the API returns 403.

## 15. Enhancements / Later phases

- Virtual queue join from home via app (delivered under `queue.virtual`), queue position via hospital Wi-Fi captive portal, ML-based dynamic wait time estimate (AI-005, `queue.ml_wait`), load balancing across departments/doctors (auto-suggest transfer), exit feedback kiosk (EN-030/EN-034), QR self-registration posters (market), voice/TTS announcements in 7+ Indian languages (market), WhatsApp interactive "I'm here"/"running late" replies, mobile queue tracking widget (market), appointment-slot-anchored dynamic ETA, wearable pager integration.

## 16. Open Questions for the Hospital

1. Token series style: per doctor (`D12-001`) or per department (`A-001`)? Daily reset time?
2. Priority classes recognised and jump rules; fairness cap; VIP handling policy?
3. Appointment vs walk-in policy: slot-anchored or ratio; late tolerance minutes?
4. Is consultation fee payment required before joining the doctor queue? Follow-up validity days?
5. Which stages have queues (registration, vitals, doctor, cash, lab, radiology, pharmacy)? Counters per stage?
6. TV boards per doctor room vs department boards; TTS languages; name masking preference?
7. SMS vs WhatsApp for called/N-away notifications; budget for SMS?
8. Kiosk/self-token and virtual queue in Phase 1 or later?
