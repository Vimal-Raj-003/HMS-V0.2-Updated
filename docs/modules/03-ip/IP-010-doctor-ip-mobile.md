# IP-010 — Doctor IP Mobile (ward rounds, IP chart, IP orders, push alerts & acknowledgement, discharge initiation, dictation, secure chat)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-010 |
| Phase | 7 (PWA) / 13 (React Native) |
| Priority | P1 |
| Complexity | High |
| Depends on | OP-019 (Doctor Mobile App shell — OPD; IP-010 is the inpatient workspace inside the same app), OP-002 (CPOE order engine, e-Rx, order sets, CDSS via EN-029), IP-001 (census, transfers), IP-002 (discharge initiation/summary), IP-003 (vitals/MAR/notes/EWS escalations), IP-005 (visit charges, package alerts), IP-006 (OT list), IP-009 (ICU board), OP-004/OP-008 (results, critical values), IP-007 (blood requests), OP-011 (diet), EN-037 (push/escalation), EN-039 (note templates), EN-016 (e-sign), EN-024 (audit), EN-007 (device sessions), AI-004 (dictation later), NC-034 (visit-based payouts) |
| Feature flag | `module.doctor_ip_mobile.enabled` (sub: `dmobile.orders`, `dmobile.discharge`, `dmobile.dictation`, `dmobile.chat`, `dmobile.offline_rx`, `dmobile.photos`) |
| Primary roles | Doctor — IP (7), Surgeon (9), Intensivist (11), Resident (14, co-sign), HOD (5) |
| Secondary roles | Anaesthetist (10), Consultants on cross-referral (6), MS (4, read), Nurse (view acknowledgements) |
| Regulatory | NABH COP (rounds documentation, orders authentication), MOM (electronic orders, verbal-order limits), IMC/NMC telemedicine & e-prescription norms (e-Rx format), NDPS (narcotic orders), DPDP (PHI on personal devices — encryption, remote wipe), IT Act (device security), Schedule H/H1/X drugs |

## 1. Purpose
IP-010 gives doctors a phone/tablet workspace for inpatients: an assigned-patient list (bed-wise, acuity-sorted) with cards showing diagnosis, day of stay, latest vitals/NEWS2, active medications and pending results; a full IP chart (notes, orders, MAR, results, imaging, I/O, flowsheet summary); mobile CPOE (medications add/modify/stop, labs, imaging, diet, nursing instructions, consults, blood) pushed instantly to departments; push alerts (critical results, nurse escalations, package/credit alerts) with acknowledgement and "respond with order"; discharge initiation with pre-filled summary; rounds notes with dictation; and secure inter-doctor chat tied to patient context. All rules run in OP-002/IP-002/IP-003 services; the app is a client with an offline order draft queue.

## 2. Users & Jobs-to-be-done
- **Consultant** (phone, 20–40 IP patients, 2 rounds/day): triage the list by acuity, review overnight vitals/labs in 30 s per patient, write rounds note (template/dictation), modify orders at bedside, acknowledge critical alerts within minutes, initiate discharge the evening before, approve resident orders, communicate with team.
- **Resident** (phone/tablet): pre-round data collection, draft orders/notes for co-sign, respond to nurse escalations, discharge summary drafting.
- **Surgeon**: post-op patients board, OT list for the day (IP-006), wound photos (`dmobile.photos`), implant info.
- **Intensivist**: ICU board (IP-009) mobile view, alerts, quick titration orders.
- **HOD/MS**: department census, LOS outliers, pending discharges, unsigned notes.

## 3. Core Workflows

### 3.1 Login, patient lists & rounds view
1. Same login as OP-019 (password + 2FA/PIN unlock; device registered) → **IP workspace**: tabs *My patients* (primary/secondary consultant, resident's team), *Ward* (choose ward), *ICU*, *Consults requested to me*, *Discharges pending*; each **card**: bed, name/age/sex, photo, diagnosis, day of stay (LOS), payer/package chip, latest vitals + NEWS2 band (colour), new results badge (critical red), active meds count, pending tasks (co-sign, unsigned notes), isolation/allergy/DNR icons; sort by acuity/bed/new results; search; swipe actions (note, orders, results).
2. **Rounds mode**: sequential walk through list; per patient one-screen "rounds summary" (24-h vitals trend sparklines, I/O balance, MAR held/refused, new results delta vs previous, imaging impressions, nursing SBAR concerns, pending orders/consults, expected discharge) → add note → next; time per patient tracked (KPI: rounds completion by 11:00).

### 3.2 IP chart (read)
- Tabs: Overview/timeline; Notes (all disciplines); Orders (active/completed/stopped); MAR (given/held/refused with reasons); Vitals & EWS charts; Results (labs with trends & deltas, micro, radiology reports with OHIF viewer link EN-008); I/O; Assessments; Procedures/OT notes; Blood; Documents/consents; Billing summary & package utilisation (IP-005/IP-008); Discharge status. Break-glass for non-care-team patients with reason (READ_PHI audit).

### 3.3 Mobile IP orders (`dmobile.orders`)
1. **Medications**: search (generic/brand, favourites, order sets/protocols e.g. post-op, DVT prophylaxis), dose/route/frequency/duration/PRN with indication & max, infusion builder (drug/diluent/rate or dose-based), taper; **CDSS** (EN-029): allergy, interaction, duplicate, dose range (weight/renal), pregnancy, high-alert flag → hard-stop/override with reason; **modify** (dose/frequency) and **stop** (reason) existing orders; hold/resume; narcotic orders require 2FA re-auth & Schedule X rules; e-Rx signed → OP-002 → MAR (IP-003) regenerated → nurse push "New/changed order".
2. **Investigations**: lab panels/tests (with clinical indication, urgency STAT/routine, timed e.g. tomorrow 06:00), imaging (modality/protocol, transport/contrast questions), micro (site) → orders → departments via WebSocket/queues (OP-004/OP-008 worklists) instantly.
3. **Others**: diet order (OP-011: type, texture, restrictions, NPO from/to), nursing instructions (monitoring frequency, position, mobilisation, catheter removal, wound care, restraints (with EN-028 rules), oxygen), physio/dietician/other referrals & consults (to doctor with question; SLA), blood request (IP-007: component/units/indication/consent status), OT request (IP-006), transfer request (ICU/ward class IP-001), code status (with policy), discharge medication drafting.
4. **Co-sign**: resident orders → consultant queue (push) → approve/edit/reject; verbal-order co-sign list from IP-003.
5. **Offline order drafts** (`dmobile.offline_rx`): drafts saved locally when offline; on reconnect CDSS re-runs before submission (no auto-submit); banner shows pending drafts.

### 3.4 Notes & dictation
- Rounds/progress note (SOAP/department template EN-039; auto-inserts latest vitals/labs), consult note, procedure note, family communication note; **dictation** (`dmobile.dictation`: device STT now, AI-004 ambient scribe later — always doctor-reviewed before signing); templates & smart phrases; sign (system signature/e-sign) → immutable version; addendum; resident notes → co-sign; signed rounds note → `doctor.visit.recorded` (IP-005 visit charge per rules).
- Photos (`dmobile.photos`): wound/clinical photos through the same in-app camera pipeline as IP-004 (consent, encryption, tagging).

### 3.5 Push alerts & responses
- Types: **critical lab/imaging** (OP-004/OP-008 critical value protocol — must acknowledge; read-back note; "order action" shortcut), **nurse escalation** (NEWS2 tiers, SBAR call log — respond with order/note/"seen"), held/refused critical meds, culture positive/antibiogram (IP-012), package 80/100 % & credit limit (IP-005/IP-008), pre-auth query (RC-002), consult requests, co-sign pending, discharge summary pending, code blue in own ward (IP-013), OT changes (IP-006), transfer completed. Delivered PHI-free (bed/UHID last 4) via EN-037; acknowledgement recorded with latency; unacknowledged critical → escalation to backup/HOD after 10 min (configurable); **smart filtering** (mute non-critical during OT, digest mode) never applies to critical tier.
- Alert centre with filters; per-patient alert history visible to nurses (ack log).

### 3.6 Discharge initiation from phone (`dmobile.discharge`)
- From card → *Initiate discharge* (IP-002 modal: type, condition, expected time, gate checks with fix links) → summary **pre-filled** draft opened in mobile editor (sectioned; dictation; auto tables) → save draft; sign on phone allowed for consultants (policy) or hand to desktop; medication reconciliation quick view with continue/stop decisions; follow-up plan quick-add → IP-002 events; family notified by IP-002.

### 3.7 Secure chat & team (`dmobile.chat`)
- Patient-context threads (care team auto-membership; consult threads), 1:1 and group, read receipts, attach chart snapshot/result/image link (no PHI leaves platform), on-call directory (NC-030 roster), escalation call button; retention per policy; audit; no forwarding outside app; messages are not orders (banner: "Place orders via Orders tab").

### 3.8 Exceptions
1. Order CDSS hard-stop (e.g. anaphylaxis allergy) → cannot override on mobile; must use desktop with second signature (policy).
2. Device lost → EN-007 wipe; sessions revoked.
3. Push unavailable → in-app polling + SMS for critical (EN-009) fallback per hospital.
4. Patient transferred to another consultant → list updates in real time; open drafts preserved with warning.
5. Offline chart view: last-synced snapshot with timestamp; orders as drafts only.

## 4. Data Model (mobile-specific; core in OP-002/IP-002/IP-003)
- **core.device_sessions** (app=doctor, push_token, platform, last_sync_at, wiped_at).
- **clinical.doctor_visits** (id, hospital_id, admission_id, doctor_id, visit_type enum(rounds/consult/cross_consult/procedure/emergency), at, note_document_id, source enum(mobile/desktop/nurse_entry), charge_line_id?, ward_id) — index (admission_id, at).
- **clinical.alert_acknowledgements** (alert_id, user_id, device_id, acknowledged_at, latency_ms, action enum(seen/ordered/called/escalated), note).
- **clinical.order_drafts** (id, doctor_id, admission_id, payload jsonb, created_offline bool, created_at, submitted_order_id?, discarded_at) — client-mirrored.
- **clinical.cosign_queue** (item_type enum(order/note/verbal_order/discharge_summary), item_id, resident_id, consultant_id, created_at, actioned_at, action).
- **engage.chat_threads** (id, hospital_id, context_type enum(patient/team/consult), context_id, members uuid[], created_at, retention_until), **engage.chat_messages** (thread_id, sender_id, body (encrypted), attachments jsonb (refs only), sent_at, read_by jsonb) — partitioned.
- **clinical.rounds_sessions** (doctor_id, date, started_at, ended_at, patients_seen int, avg_seconds).
- Client store (IndexedDB/SQLite): patient snapshots for assigned patients (banner, latest vitals/labs, active orders), order drafts, note drafts, alerts cache — encrypted.

## 5. Business Rules & Validations
- Orders authenticated by the ordering doctor's session; narcotics/high-alert orders require step-up auth (PIN/2FA); residents' orders flagged `requires_cosign` per policy (some hospitals allow immediate execution with retrospective co-sign ≤ 24 h — configurable per order class).
- CDSS hard-stops enforced server-side; override reasons stored; no CDSS bypass offline (drafts only).
- Signed rounds note → one visit charge/day/doctor per IP-005 rules; multiple notes do not duplicate charges.
- Critical alerts must be acknowledged; SLA 10 min then escalate to backup (roster) → HOD; ack log visible to nurses & quality.
- Discharge initiation via mobile follows IP-002 gate checks; summary signing on mobile allowed for consultants only (config).
- Chat: PHI stays in platform; messages retained per policy (default 1 y); not a substitute for orders; audit access.
- Break-glass reads audited; screenshots blocked (RN); PIN lock 2 min; remote wipe.
- Offline chart snapshot ≤ 24 h; drafts require re-validation.

## 6. API Surface (mobile-specific; others in OP-002/IP-002/IP-003)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /api/v1/doctor/ip/patients?scope=my|ward|icu|consults&sort= | patient cards read model | ip.admission.read (care team) | – | cursor |
| GET | /api/v1/doctor/ip/patients/{admissionId}/rounds-summary | one-screen summary | ip.admission.read | – | – |
| GET | /api/v1/doctor/ip/bootstrap, /delta?since= | offline snapshots | ip.admission.read | – | – |
| POST | /api/v1/orders (OP-002) with `channel=mobile` | orders | opd.order.create / rx.create | Y | – |
| POST/GET | /api/v1/doctor/order-drafts | drafts | rx.create | Y | cursor |
| POST | /api/v1/doctor/cosign/{itemId}/approve|reject | co-sign | opd.order.sign | Y | – |
| POST | /api/v1/clinical/notes (rounds/consult) → sign | notes (EN-039 templates) | clinical.note.write / sign | Y | – |
| POST | /api/v1/alerts/{id}/ack | acknowledge with action | clinical.alert.ack | Y | – |
| GET | /api/v1/alerts?mine=&open= | alert centre | clinical.alert.read | – | cursor |
| POST | /api/v1/ip/discharge/admissions/{id}/initiate (IP-002) | discharge | ip.discharge.initiate | Y | – |
| POST/GET | /api/v1/chat/threads, /threads/{id}/messages | secure chat | chat.use | Y | cursor |
| POST | /api/v1/clinical/photos (IP-004 pipeline) | photos | clinical.photo.capture | Y | – |
| POST | /api/v1/devices/register | push token | auth.session | Y | – |
| GET | /api/v1/doctor/ip/kpi | rounds completion, ack latency, unsigned notes | clinical.report.read | – | – |

## 7. Domain Events (outbox)
- Emits via OP-002/IP-002/IP-003 (`order.created|updated|cancelled`, `note.signed`, `ip.discharge.initiated`) with `channel=mobile`.
- `doctor.visit.recorded` {admission_id, doctor_id, visit_type, at} → IP-005, NC-034.
- `alert.acknowledged` {alert_id, latency, action}; `alert.escalated` (EN-037).
- `doctor.cosign.approved|rejected`; `doctor.rounds.completed` {patients, duration}.
- `chat.message.sent` (metadata only).
- Consumes: `lab.result.critical`, `rad.critical`, `nursing.ews.escalated`, `nursing.mar.administered{held/refused critical}`, `package.threshold_reached`, `ip.bill.credit_threshold`, `preauth.query`, `consult.requested`, `code_blue.called`, `ot.case.*`, `ip.transferred`.

## 8. Screens (UI — phone single-pane, tablet 2-pane; bottom nav Patients · Alerts · Orders · Chat · More)
- **Patient list**: cards (see §3.1), filters, acuity sort, pull-to-refresh, real-time badges; `Rounds mode` FAB.
- **Rounds summary**: sparklines, deltas, MAR exceptions, nursing concerns, pending items; actions bar (Note · Orders · Results · Discharge · Call nurse).
- **Chart tabs** (swipe): Notes, Orders, MAR, Vitals, Results (trend & delta, critical highlight), Imaging (viewer link), I/O, Docs, Billing/package gauge.
- **Order composer**: search-as-you-type, favourites/order sets, structured fields with smart defaults, CDSS panel (blocking vs warning), review & sign (biometric/PIN), submit; modify/stop from active list; offline draft badge.
- **Note editor**: template picker, auto-insert data, dictation button with live transcript, sign; co-sign queue.
- **Alerts**: grouped by severity with timers; ack sheet with quick actions (Order / Call / Note / Escalate); history.
- **Discharge modal** & mobile summary editor (sectioned, dictation).
- **Chat**: threads by patient/team; attach chart snapshot; on-call directory; call buttons.
- **More**: OT list today (IP-006), ICU board (IP-009), department census (HOD), KPIs, settings (PIN, notifications profile), device wipe.
- Accessibility/i18n: large text mode, dark mode, RTL-ready.

## 9. Integrations
- EN-037 push (Web Push/FCM/APNs) with escalation; OP-002 CPOE & EN-029 CDSS; OP-004/OP-008/EN-008 results & viewer; IP-003 nursing data & escalations; IP-002; IP-005/IP-008; IP-006/IP-009; NC-030 roster/on-call; EN-016 e-sign; EN-007 device management; STT device/AI-004; EN-009 SMS fallback for critical.
- Fallbacks: push down → polling + SMS; offline → drafts; viewer heavy → thumbnails/report text.

## 10. Reports & Analytics
- Rounds completion time (% patients seen by 11:00), note signing latency, orders per channel, CDSS override rate, critical alert acknowledgement latency & escalations, co-sign turnaround, discharge initiation time-of-day (evening-before %), mobile share of orders/discharges, chat volume (metadata), device health.
- Read models: `analytics.mv_doctor_ip_activity`, `analytics.mv_alert_ack_latency` (shared).

## 11. Notifications
- Doctor push: critical results, escalations, held/refused critical meds, consults, co-sign, package/credit alerts, pre-auth queries, discharge summary pending, code blue (own ward), OT changes; digest for non-critical (configurable); backup/HOD on escalation; nurse: order acknowledgements & doctor's response ("seen/ordered").

## 12. Permissions (RBAC keys)
Reuses OP-002 (`opd.order.*`, `rx.*`), IP-002, IP-003 read keys; adds `clinical.alert.read|ack`, `clinical.note.write|sign`, `chat.use`, `doctor.mobile.use`, `clinical.report.read`, `clinical.photo.capture`.
Defaults: Consultants (7/9/11/6): all incl. note.sign, discharge.initiate, alert.ack; Resident (14): order.create (cosign flag), note.write, alert.ack; HOD (5): + department census/KPI; MS (4): read/KPI; Nurses: view ack log via IP-003.

## 13. Non-functional
- 1,500 concurrent doctor devices; patient list read model < 200 ms; rounds summary < 300 ms; order submit < 400 ms incl. CDSS; push < 3 s.
- Offline snapshots ≤ 24 h; drafts encrypted; IndexedDB ≤ 100 MB.
- Security: PIN/biometric unlock, FLAG_SECURE (RN), cert pinning (RN), remote wipe, no PHI in notifications, audit all reads/writes with device id, break-glass logging.
- Battery/network: delta sync, image thumbnails, lazy loading.

## 14. Acceptance Criteria
1. Given a consultant with 25 assigned patients, then the list renders in < 1 s with NEWS2 bands and new-result badges, sorted by acuity, updating in real time when a nurse charts new vitals.
2. Given a rounds summary, then it shows 24-h vitals sparklines, lab deltas vs previous, MAR held/refused with reasons and nursing SBAR concerns without navigating away.
3. Given a new medication order on mobile with a documented penicillin allergy for amoxicillin, then the CDSS hard-stop blocks submission and the override path is unavailable on mobile (policy), with guidance to desktop second-signature flow.
4. Given a resident submits an order with `requires_cosign`, then the consultant receives a push, approves in-app, and the order proceeds; rejection returns to the resident with reason.
5. Given a lab order marked STAT from mobile, then it appears in the OP-004 worklist within 2 s and the assigned nurse gets a "new order" push.
6. Given a critical potassium result, then the doctor gets a push; acknowledgement records latency and the "Order action" shortcut opens the composer prefilled with patient context; unacknowledged after 10 min escalates to the backup doctor.
7. Given a nurse NEWS2 ≥ 5 escalation, then the doctor can respond "seen"/place order/call; the response is visible to the nurse in the ack log.
8. Given a signed rounds note at 09:10 and another at 17:30 by the same consultant, then only one visit charge posts for the day per IP-005 rules (second requires override).
9. Given "Initiate discharge" from the card, then IP-002 gate checks run and blockers are shown; on success the pre-filled summary opens in the mobile editor and can be signed by a consultant.
10. Given the phone is offline, when the doctor drafts two orders, then they are stored locally as drafts; on reconnect CDSS re-runs and the doctor must confirm before submission (no auto-submit).
11. Given a doctor opens a patient outside their care team, then a break-glass reason is required and a READ_PHI audit is written.
12. Given a chat message with a result attachment, then only a link to the platform resource is shared; forwarding outside the app is not possible and the message shows "not an order" banner.
13. Given the OT list for today, then the surgeon sees case order/status from IP-006 with live updates.
14. Given a lost device reported, then remote wipe clears app data and revokes sessions; subsequent API calls from that device fail.
15. Given digest mode enabled during OT, then non-critical alerts batch every 30 min while critical alerts still push immediately.

## 15. Enhancements / Later phases
- From VIMS sheet row 29: dictation mode for ward rounds (here; AI-004 ambient later), wound progress photo capture (here via IP-004 pipeline), inter-doctor secure chat (here), smart notification filtering (here), offline prescription with sync (drafts here; full offline CDSS later).
- Later: React Native app with native STT/biometrics, voice commands, AI summarisation of overnight events (AI-002), predictive deterioration cards (AI-005), tele-rounds video (OP-018), smartwatch alerts, patient-family messaging relay (PE-001).

## 16. Open Questions for the Hospital
1. Resident order policy: immediate execution with retrospective co-sign or pre-approval? Which order classes?
2. Narcotic/high-alert order rules on mobile (step-up auth, desktop only?)
3. Visit charge rules tied to notes; cross-consult charging?
4. Critical alert acknowledgement SLA and backup/escalation roster source (NC-030)?
5. Discharge summary signing on mobile allowed? For whom?
6. Chat retention & policy; is external messaging (WhatsApp) to be replaced fully?
7. BYOD vs hospital devices; MDM; SMS fallback for critical alerts?
8. Dictation: on-device only or cloud STT (data residency)?
