# EN-037 — Notification Centre (Unified Model across In-App Bell, Web Push/FCM, SMS/WhatsApp, Email, TV; Severity Levels, Role & On-Call Routing, Escalation Ladders with Acknowledgement & Timeout, Quiet Hours & DND for Staff, Deduplication & Coalescing, Per-User Preference Centre, Critical-Alert Guarantee, Delivery Tracking, Alert-Fatigue Metrics)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-037 |
| Phase | 0 |
| Priority | P0 |
| Complexity | High |
| Depends on | EN-007 (users, roles, sessions, device registry), EN-009 (SMS & WhatsApp delivery), EN-032 (email delivery), EN-018 (TV/digital signage surface), EN-024 (audit), EN-027 (department/ward masters for routing scope), NC-030 (Duty Roster — who is on call right now), EN-041 (branch scoping of routing rules), EN-017 (push provider connectors), EN-040 (per-plan notification quotas), EN-039 (notification card/template rendering) |
| Consumed by | **Every module.** Notably EN-029 (critical values, deterioration, sepsis — the must-acknowledge path), OP-004/OP-008 (results & critical findings), IP-003/IP-009 (nursing & ICU alerts), OP-006/TR-001 (ER & trauma activation), IP-007 (blood availability), EN-038 (approval requests & SLA breaches), NC-005/NC-006 (indent approvals, stock-outs, expiry), NC-028 (helpdesk), EN-017/EN-023/EN-022 (IT & security alerts), EN-030 (feedback low-score alerts), RC-001/EN-002 (claim & pre-auth events), NC-013 (ambulance dispatch), EN-034/EN-042 (device faults) |
| Feature flag | `module.notifications.enabled` (always on; sub-flags `notify.web_push`, `notify.fcm`, `notify.escalation`, `notify.digest`, `notify.tv`) |
| Primary roles | Every authenticated staff role (bell + preferences); Nurse (17/18/19), Doctor (6/7/8), Intensivist (11), Pharmacist (30/31), Lab (33/35), IT Admin (56) |
| Secondary roles | Hospital Admin (2 — routing policy), Nurse Supervisor (22 — escalation targets), Medical Superintendent (4 — final escalation tier & alert-fatigue governance), Quality (54), Auditor (58), DPO (57 — content minimisation on external channels) |
| Regulatory | **NABH 6th edn COP/MOM** — critical result and deterioration communication must be timely, closed-loop and documented; **NABL 112** critical-value read-back; **DPDP Act 2023 & Rules 2025** — notification content sent outside the application (SMS/WhatsApp/email/push preview) is a disclosure: PHI minimisation, purpose limitation, and no clinical detail on lock-screen previews; **TRAI DLT** for the SMS leg (EN-009); labour/working-time considerations for off-duty staff contact (quiet hours are a policy, not a nicety); CERT-In log retention for delivery logs |

## 1. Purpose
EN-037 is the one place where "somebody needs to know something" is turned into a delivered, tracked and — where it matters clinically — **acknowledged** message. It defines a single notification model (event → audience → severity → channels → escalation), resolves audiences by role, ward, care team and live on-call roster, respects each person's channel preferences and quiet hours *except* for critical clinical alerts, deduplicates and coalesces noise, guarantees delivery of must-acknowledge alerts through an escalation ladder, and measures alert fatigue so the system can be tuned rather than ignored.

## 2. Users & Jobs-to-be-done
- **Nurse (17/18/19, tablet/phone at the bedside)**: see a short, prioritised task-like bell list; get a loud, unmissable alert when a patient deteriorates or a critical result lands; acknowledge with one tap; not be woken at 03:00 for a stock-reorder notice.
- **Doctor (6/7/8, phone + desktop)**: receive critical results and deterioration alerts for *their* patients wherever they are; choose to receive routine notifications as a twice-daily digest; hand over their alerts when off duty so nothing lands in a void.
- **On-call consultant / intensivist (11)**: be the second rung of the escalation ladder and be reachable by push, then SMS, then voice — automatically, without anyone hunting for a phone number.
- **Pharmacist / Lab / Store (30/33/44)**: get work-queue notifications (verification pending, QC due, stock below reorder) batched sensibly.
- **Approver (HOD, Admin, Finance)**: get approval requests with enough context to decide on a phone, and be reminded before the SLA expires (EN-038).
- **IT Admin (56)**: get infrastructure and integration alerts with an on-call rotation and a paging escalation, and see the delivery health of the notification system itself.
- **Hospital Admin / Medical Superintendent (2/4)**: configure routing and escalation policy per severity, review the alert-fatigue report, and retire notification types nobody acts on.
- **Every user**: one **preference centre** where they choose channels per category, set quiet hours, and see everything they were sent.

## 3. Core Workflows

### 3.1 The unified notification model
Every notification is produced by a **notification type** (`notif_types`) — a registered, versioned definition rather than an ad-hoc call, so the catalogue is governable:
```
type: lab.critical_value
category: clinical_safety
severity: critical            # info | low | normal | high | critical
must_acknowledge: true
ack_window_sec: 600
audience: [ordering_doctor, ward_nurse_incharge(patient.ward), oncall(role=physician, unit=patient.unit)]
channels_by_severity: critical -> [inapp, push, sms, voice_escalation]
quiet_hours_override: true    # critical bypasses DND
dedupe_key: patient_id + test_id
coalesce: none                # critical alerts are never batched
escalation_ladder: L1 ordering_doctor (0 min) -> L2 ward nurse + duty doctor (10 min) -> L3 intensivist (20 min) -> L4 Medical Superintendent (30 min)
payload_fields: [patient_banner, test_name, value, unit, reference, prior_value, order_ref]
external_content_policy: minimal   # SMS/push preview carries no value or diagnosis
retention_days: 3650
```
- **Severity** drives defaults for channel set, quiet-hour behaviour, dedupe, TTL and escalation. Five levels:
  | Severity | Example | Channels (default) | Quiet hours | Ack |
  |---|---|---|---|---|
  | `critical` | critical lab value, NEWS2 ≥7, code blue, blood reaction, fire/security | in-app + push + SMS + voice escalation + TV | **overridden** | mandatory, escalates |
  | `high` | pre-auth rejected, OT case cancelled, stock-out of an emergency drug, integration circuit open | in-app + push (+ SMS if unread 15 min) | overridden for on-duty only | optional ack |
  | `normal` | approval request, report ready for verification, indent raised | in-app + push | respected | no |
  | `low` | routine reminders, roster published, document expiring in 30 days | in-app (+ digest) | respected | no |
  | `info` | system announcements, marketing to staff | in-app digest only | respected | no |
- A notification instance is **one logical fact with many deliveries**: `notif_notifications` (the fact) → `notif_recipients` (who) → `notif_deliveries` (per channel attempt). Read/ack state lives on the recipient row, so the same fact can be read on the phone and appear read on the desktop within a second.

### 3.2 Audience resolution & routing
1. A module raises `Notify.publish({type, context, refs})` — it never names channels or people. EN-037 resolves the audience from **audience expressions** in the type definition:
   - **Static role in scope**: `role:nurse_incharge @ ward(patient.ward_id)`, `role:pharmacist @ branch`.
   - **Care-team relation**: `ordering_doctor`, `attending_doctor`, `primary_nurse`, `consultant_of_record`, `referring_doctor`.
   - **On-call**: `oncall(speciality=cardiology, branch, at=now)` resolved live from **NC-030** duty roster; if no one is rostered, the fallback chain (department head → duty medical officer → Medical Superintendent) is used and the gap is reported as a roster defect.
   - **Explicit users/groups**, **subscribers** (users who opted in to a topic, e.g. "all discharges in Ward 4B"), and **device audiences** (a TV in the ICU corridor, a kiosk cluster).
2. **Routing rules** (`notif_routing_rules`) can override or extend per hospital/branch/department: "send stock-out alerts to the store in-charge and CC the purchase officer during month-end", "route ER activations to the trauma group chat device". Rules are ordered, effective-dated, and simulate-able.
3. **Deduplication**: identical `(type, dedupe_key, recipient)` within the type's dedupe window collapses into the existing notification with an occurrence counter (`×3`) and a bumped timestamp rather than a new row — this alone removes most alert spam.
4. **Coalescing/digest**: `low`/`info` types can be coalesced into a per-user digest (immediate / hourly / twice daily / daily at HH:MM) rendered as one grouped notification ("7 documents expiring this week").
5. **Suppression windows**: a recipient may snooze a *type* for a bounded period (max 8 h, never for `critical`); a hospital may suppress a type entirely (retiring it from the catalogue with an audit entry).

### 3.3 Channel fan-out & delivery
1. For each recipient, the effective channel set = type defaults ∩ user preferences ∪ severity overrides, filtered by what the user actually has (registered push device, verified mobile, verified email).
2. **In-app** is always written (the bell is the system of record for "you were told"), even when other channels are chosen — an alert never exists only as an SMS.
3. **Web Push / FCM**: browser push (VAPID) for the PWA on desktop/tablet, FCM/APNs for the future native apps (Phase 13). Payloads are **content-minimised**: title "Critical result — Ward 4B, Bed 12", body "Tap to view" — never the value, never the diagnosis, because lock screens are public. Deep link opens the exact record.
4. **SMS/WhatsApp** (EN-009) for high/critical when push is unacknowledged or the user is offline; DLT-registered templates; content minimised identically.
5. **Email** (EN-032) for digests, approvals with attachments, and non-urgent staff communications.
6. **Voice escalation** (EN-033) as the last rung for `critical`: an automated call reading a minimal script ("Critical alert for a patient in ICU-2. Please open the HMS.") with DTMF acknowledgement.
7. **TV/board** (EN-018) for area-level awareness (code blue, ER activation, mass-casualty) — never patient-identifying beyond the bed/ward.
8. **Delivery tracking**: each attempt records queued/sent/delivered/failed with provider ids; failure on one channel promotes to the next channel in the ladder immediately for `critical`, or after the type's `promote_after` for others.

### 3.4 Escalation ladders with acknowledgement & timeout (the critical-alert guarantee)
1. A `must_acknowledge` notification starts an **escalation instance** with the ladder from the type (overridable per hospital/ward).
2. **L1** targets fire immediately across their channels. A visible countdown to the next rung is shown in the app.
3. If no acknowledgement within `ack_window` (default 10 min for critical labs, 15 min for deterioration, configurable), **L2** fires *in addition to* L1 (never instead of — the original recipient stays informed), then L3, then L4.
4. **Acknowledgement** is an explicit action carrying identity, time, channel and (where the type requires) a **structured response**: for critical values, the read-back/call-back record (who was called, at what time, read-back confirmed); for deterioration, the intended action ("attending now", "orders placed", "escalating to ICU").
5. **Acknowledging stops the ladder** for everyone and notifies the already-escalated rungs that it is handled ("Dr Rao acknowledged at 14:22"), so nobody duplicates effort.
6. **No acknowledgement at the final rung** raises `notification.escalation.exhausted` — a distinct, loud event that appears on the nursing command centre and the Medical Superintendent's dashboard and is a reportable quality incident. The system never gives up silently.
7. **Ladder integrity checks**: at publish time, a ladder whose rungs resolve to zero users (empty roster, vacant role) is rejected; at runtime, an unresolvable rung immediately promotes to the next and logs a roster defect.
8. **Handover**: when a user goes off duty (roster transition or explicit "hand over my alerts"), their unacknowledged notifications transfer to the incoming shift holder with a visible handover note — unacknowledged critical alerts are never orphaned by a shift change.

### 3.5 Quiet hours, DND & the override rules
- Each user sets **quiet hours** (e.g. 22:00–07:00) and per-category channel preferences. Quiet hours suppress push/SMS for `info`/`low`/`normal`; the in-app bell still accumulates.
- **`high`** respects quiet hours only for staff who are **off duty** per the roster; on-duty staff receive high alerts regardless (being on duty *is* the consent).
- **`critical` always overrides** quiet hours, DND and preferences on every channel — this is non-configurable and is stated plainly in the preference UI ("Critical patient-safety alerts always reach you").
- **Off-duty protection**: a member of staff who is not rostered is not targeted for ward-scoped operational alerts at all (their alerts route to the on-duty holder), preventing the common failure where the doctor who set up a patient two weeks ago is paged at midnight.
- **Do-not-disturb for procedures**: a surgeon in an OT session (from IP-006 status) or a doctor in a consultation can enable a bounded focus mode; critical alerts still land, everything else queues and is delivered on exit.
- **Fatigue guardrail**: if a single recipient would receive more than N notifications in a rolling window (default 25/hour for non-critical), further non-critical notifications auto-coalesce into a digest and a `notification.flood_detected` event is raised for governance.

### 3.6 Preference centre & subscriptions
- A per-user page lists **categories** (clinical safety, my patients, orders & results, approvals, roster & HR, inventory, IT & system, quality, announcements) × **channels** (bell, push, SMS, WhatsApp, email) as a matrix with sensible role-based defaults pre-set, plus quiet hours, digest schedule, language, and device management (registered push devices with last-seen and a revoke button).
- Categories that cannot be switched off are shown locked with the reason ("patient safety — always on").
- **Topic subscriptions**: a user can subscribe to specific scopes (a ward, a doctor's list, a store, a project) and unsubscribe just as easily; subscriptions are audited so nobody quietly subscribes to another department's clinical feed (permission-checked at subscribe time and re-checked at delivery).
- **Delegation**: "while I'm on leave, send my approvals to X" (shared with EN-038's delegation model) — clinical safety alerts are **not** delegable, they follow the roster.

### 3.7 Exceptions & failure modes
- **All channels fail for a critical alert** → the escalation continues to the next rung immediately, the nursing command centre and the TV board show the unreachable alert, and `notification.delivery.total_failure` pages IT. Silence is treated as a failure, never as success.
- **User has no push device and no verified mobile** → they are flagged as "unreachable off-site" in the roster view; ladders skip them with a logged defect so a ward is never protected only on paper.
- **Push token expired/unregistered** → token pruned, user notified in-app to re-enable notifications; if the user is a critical-ladder target, an admin task is raised.
- **Provider outage (FCM/SMS)** → circuit breaker (EN-017) plus automatic channel substitution for critical; a system banner tells staff which channels are degraded.
- **Notification storm from a misbehaving module** (e.g. an integration loop) → per-type rate limiter trips at a configured ceiling, the type auto-downgrades to digest, and the owning module is alerted — the bell must never become unusable.
- **Patient-facing content leakage** → external channel payloads pass a content-minimisation filter; a type whose external template contains clinical placeholders fails publication.

## 4. Data Model (schema `core`, prefix `notif_`)
- `notif_types` — id, hospital_id (null = system catalogue), key citext, name, category enum(clinical_safety/my_patients/orders_results/approvals/roster_hr/inventory/finance/it_system/quality/announcement), severity enum(info/low/normal/high/critical), must_acknowledge bool, ack_window_sec, audience_expr jsonb, channels_by_severity jsonb, quiet_hours_override bool, dedupe_key_expr, dedupe_window_sec, coalesce_policy enum(none/digest_hourly/digest_daily/custom), escalation_ladder_id?, external_content_policy enum(minimal/standard), payload_schema jsonb, retention_days, owner_module, status enum(active/deprecated/suppressed), version, created…; UNIQUE(hospital_id, key).
- `notif_escalation_ladders` — id, hospital_id, key, name, scope jsonb (ward/department/branch overrides), rungs jsonb[] (level, delay_sec, audience_expr, channels, repeat_every_sec, max_repeats), exhausted_action jsonb, active, version.
- `notif_routing_rules` — id, hospital_id, branch_id?, type_key?, category?, condition jsonb, action jsonb (add/remove audience, force channels, override severity, suppress), priority int, effective_from, effective_to, created_by, active.
- `notif_notifications` — id uuidv7, hospital_id, branch_id?, type_key, type_version, severity, title, body_short, body_rich jsonb, payload jsonb (typed context; PHI-classified fields marked), ref_type, ref_id, patient_id?, encounter_id?, dedupe_key, occurrence_count int default 1, first_at, last_at, expires_at, source_module, correlation_id, escalation_instance_id?, status enum(open/acknowledged/resolved/expired/suppressed), created…; **partitioned monthly**; indexes (hospital_id, created_at desc), (dedupe_key, status), (patient_id, created_at desc), (ref_type, ref_id).
- `notif_recipients` — id, notification_id, user_id?, device_id?, audience_reason enum(role/careteam/oncall/subscription/explicit/rule), scope jsonb (ward/dept), read_at, acknowledged_at, ack_channel, ack_response jsonb (read-back record, action taken), dismissed_at, snoozed_until, escalation_level int, delivered_any bool; UNIQUE(notification_id, user_id); index (user_id, read_at, created_at desc) — the bell query.
- `notif_deliveries` — id, recipient_id, channel enum(inapp/web_push/fcm/apns/sms/whatsapp/email/voice/tv), attempt int, status enum(queued/sent/delivered/failed/suppressed/skipped), provider_ref (EN-009/EN-032/EN-033 message id), error_class, queued_at, sent_at, delivered_at, latency_ms, cost_units; partitioned monthly; index (recipient_id), (status, queued_at).
- `notif_escalation_instances` — id, notification_id, ladder_id, current_level, started_at, next_fire_at, acknowledged_at, acknowledged_by, exhausted_at, stopped_reason enum(acknowledged/resolved/cancelled/expired/exhausted), level_log jsonb[].
- `notif_user_preferences` — user_id, hospital_id, category, channel, enabled, digest_schedule, quiet_hours jsonb (start, end, timezone, days), language, focus_mode jsonb (enabled_until, reason), updated_at; UNIQUE(user_id, category, channel).
- `notif_devices` — id, user_id, kind enum(web_push/fcm/apns), token/endpoint (encrypted), p256dh/auth (web push), user_agent, platform, last_seen_at, last_success_at, failure_count, revoked_at; UNIQUE(user_id, token_hash).
- `notif_subscriptions` — id, user_id, topic_kind enum(ward/department/doctor_list/store/project/patient), topic_id, granted_by_permission, created_at, revoked_at.
- `notif_snoozes` — id, user_id, type_key?, category?, until, reason, created_at (never permitted for `critical`).
- `notif_metrics` (read model, 15-min refresh) — hospital_id, type_key, day, sent, delivered, read, acknowledged, median_time_to_read_sec, median_time_to_ack_sec, escalated_l2, escalated_l3, exhausted, dismissed_without_action_pct, per_recipient_p95.
- Retention: notifications per type (`retention_days`; clinical safety 10 years, operational 1 year, info 90 days); deliveries 180 days (CERT-In); acknowledgement records follow the clinical record.

## 5. Business Rules & Validations
- **Every notification is written in-app first.** No notification exists only on an external channel; the bell is the record of "you were told".
- **`critical` severity always overrides** quiet hours, DND, focus mode and user channel preferences; this is non-configurable, and the preference UI states it.
- **Must-acknowledge notifications never expire silently.** They escalate through the ladder and, if unacknowledged at the final rung, raise `notification.escalation.exhausted`, which is a quality incident, not a log line.
- **Acknowledgement requires identity and, where the type demands it, a structured response** (read-back record for critical values, intended action for deterioration). A tap that only dismisses is not an acknowledgement.
- **Ladders must resolve to real people**: a ladder with an unresolvable rung cannot be published; at runtime an empty rung promotes immediately and logs a roster defect.
- **Off-duty staff are not targeted** for ward-scoped operational alerts; the on-call roster (NC-030) is the source of truth and a roster gap is surfaced, never silently absorbed.
- **External-channel content minimisation is mandatory**: SMS/WhatsApp/push/email previews for clinical types carry location and urgency only — never values, diagnoses, drug names or test names that reveal a condition. A template violating this fails publication.
- **Deduplication and coalescing may never apply to `critical`**; occurrence counting is allowed (the same critical value re-verified) but each occurrence restarts the ack requirement if the previous was unacknowledged.
- **Snooze is bounded** (≤8 h), never available for `critical`, and is counted as a "display" in fatigue metrics.
- **Subscriptions are permission-checked at subscribe time and re-checked at delivery**; a user who loses access to a ward stops receiving its notifications immediately.
- **Rate limiting per recipient** (default 25 non-critical/hour) auto-coalesces overflow and raises a flood event; per-type tenant ceilings auto-downgrade a misbehaving type to digest and alert its owning module.
- Notification rows are **append-only**; state transitions (read, acknowledged, dismissed) are recorded with timestamps and never deleted.
- Delegation of approvals is allowed; **delegation of clinical-safety alerts is not** — those follow the roster.
- Every notification carries `correlation_id` so the full chain (source event → notification → deliveries → acknowledgement → clinical action) is traceable in EN-024.

## 6. API Surface (`/api/v1/notifications`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| POST | /publish | raise a notification (module → centre) | service token, `notify.publish` | typed payload validated against the type schema; idempotent by (type, dedupe_key, source event id) |
| GET | /me?status&category&cursor | my bell list | authenticated | cursor, unread-first, p95 <150 ms |
| GET | /me/count | unread + must-ack counts | authenticated | cached, WS-pushed |
| POST | /me/:id/read \| /dismiss \| /snooze | per-notification actions | authenticated | snooze bounded, never for critical |
| POST | /me/:id/acknowledge | acknowledge (with structured response) | authenticated | stops the ladder; response schema per type |
| GET | /me/preferences ; PUT /me/preferences | preference centre | authenticated | locked categories read-only |
| GET/POST/DELETE | /me/devices | push device registration | authenticated | VAPID/FCM tokens encrypted |
| GET/POST/DELETE | /me/subscriptions | topic subscriptions | authenticated + scope permission | re-checked at delivery |
| POST | /me/handover {toUserId, until, note} | hand over unacknowledged alerts | authenticated (roster-validated) | audited |
| GET | /notifications?type&severity&status&user&from&to | admin/ops search | `notify.admin.read` | PHI-audited |
| GET | /notifications/:id | detail incl. recipients & deliveries | `notify.admin.read` | |
| POST | /notifications/:id/cancel \| /resolve | stop an in-flight escalation | `notify.admin.manage` | reason mandatory |
| GET/POST/PATCH | /types ; /types/:key | notification catalogue | `notify.type.manage` | publish gated by content lint |
| POST | /types/:key/simulate {context} | preview audience, channels & ladder | `notify.type.manage` | resolves live roster; sends nothing |
| POST | /types/:key/test-send | send to self only | `notify.type.manage` | |
| GET/POST/PATCH | /ladders ; /routing-rules | escalation & routing config | `notify.policy.manage` (Admin/MS) | effective-dated, simulate-able |
| GET | /escalations/active | live escalation board | `notify.escalation.read` (nursing command centre) | WS |
| GET | /metrics/fatigue ; /metrics/delivery ; /metrics/escalations | governance reports | `notify.report.read` | read models |
| GET | /health/channels | channel/provider health | `notify.admin.read` | degraded-channel banner source |

## 7. Domain Events (outbox)
- `notification.published` → EN-024, analytics.
- `notification.delivered` / `notification.delivery.failed` / `notification.delivery.total_failure` → channel health, IT paging.
- `notification.read` / `notification.acknowledged` (with response payload) → source module callback (EN-029 closes the critical-value loop, EN-038 records approver seen), clinical record where applicable.
- `notification.escalated` (level) / `notification.escalation.exhausted` → nursing command centre, Medical Superintendent dashboard, quality incident register (NC-015).
- `notification.roster_gap_detected` → NC-030, Nurse Supervisor.
- `notification.flood_detected` / `notification.type.auto_downgraded` → owning module owner + Admin.
- `notification.preferences_changed` / `notification.device_registered|revoked` → EN-024.
- Consumes: essentially every domain event in the system via type definitions; and `roster.shift.changed` (handover), `user.deactivated` (audience pruning), `patient.transferred` (re-scope open ward notifications).

## 8. Screens (UI)
- **Bell / Notification drawer** (all devices, in the app shell): unread badge with a separate **must-acknowledge** count in red; list grouped by "Needs action" → "Today" → "Earlier"; each row shows a severity stripe, title, one-line context, relative time, occurrence badge (`×3`) and inline actions (Acknowledge, Open, Snooze, Dismiss). Real-time via WebSocket (<1 s). Keyboard: `N` open bell, `J/K` navigate, `Enter` open, `A` acknowledge, `S` snooze, `Esc` close. Empty state: "Nothing needs your attention".
- **Critical Alert overlay** (tablet/phone/desktop): a full-attention card that cannot be dismissed without acting — patient banner, the alert, the required response form (read-back fields or action selection), a visible countdown to the next escalation rung and who it will reach. Audible alert tone (respecting device volume policy, with a ward-configurable tone), repeats until acknowledged. Never covers an active resuscitation screen — it docks instead.
- **Notification Centre page** (desktop): full history with filters (category, severity, status, date, patient, ref), search, and per-item delivery detail (which channels, when, delivered/failed) so a nurse can prove she was never told.
- **Preference Centre** (desktop/phone): category × channel matrix with toggles, locked rows explained, quiet-hours picker with timezone, digest schedule, language, device list with last-seen and revoke, and a live "what would reach me at 02:00?" preview.
- **Escalation Board** (nursing command centre desktop + TV EN-018): live table of open must-acknowledge alerts — patient/location, type, age of alert, current rung, who is being paged, countdown to next rung; exhausted alerts pinned at top in red. This is the screen that makes the guarantee visible.
- **Notification Type Catalogue** (desktop, Admin/MS): all types with severity, category, owning module, 30-day volume, acknowledgement rate, median time-to-ack, dismissed-without-action %, status chips; actions to adjust severity, channels, dedupe and coalescing, or deprecate; a **simulate** panel that shows exactly who would be notified for a sample context (resolving the live roster) without sending anything.
- **Ladder Designer** (desktop): rungs with delay, audience expression (with a live "resolves to 3 users right now" indicator), channels per rung, repeat policy, and exhausted-action; validation blocks unresolvable rungs.
- **Alert-Fatigue Dashboard** (desktop, MS/Quality): notifications per user per shift (p50/p95), types with the highest volume and the lowest action rate, dismissed-without-action leaderboard by type, snooze usage, flood events, and a "candidates for downgrade/retirement" list.
- **Channel Health strip** (in-app banner + IT dashboard): "SMS delivery degraded — critical alerts are being sent by push and voice".
- Empty/error states: "Push notifications are blocked in this browser — critical alerts will reach you by SMS. Enable push", "You are not on the duty roster today; ward alerts are routing to the on-call team", "This alert escalated to the Medical Superintendent at 14:41 without acknowledgement".

## 9. Integrations
- **Web Push** (VAPID, service worker in the PWA) and **FCM/APNs** for native apps (Phase 13) via an EN-017 connector; token lifecycle managed here.
- **EN-009** (SMS/WhatsApp with DLT templates and the shared opt-out ledger — staff opt-outs may not disable critical alerts, which is stated at onboarding), **EN-032** (email & digests), **EN-033** (voice escalation with DTMF acknowledgement), **EN-018** (TV boards for area alerts), **EN-006** (queue calls are a distinct display path, not notifications).
- **NC-030** duty roster for on-call resolution and handover; **EN-007** for user/session/device identity; **EN-038** for approval notifications and SLA reminders; **EN-029** as the biggest clinical producer with the strictest contract.
- **Observability**: OpenTelemetry spans from source event → publish → fan-out → delivery → acknowledgement, with `correlation_id` propagated; Prometheus metrics per type and channel.

## 10. Reports & Analytics
- **Delivery**: volume by type/category/severity/channel/hour; delivery success rate per channel; median and p95 latency publish→delivered; failures by error class; unreachable-user report.
- **Responsiveness**: median and p95 time-to-read and time-to-acknowledge by type, ward, shift and role; acknowledgement rate; escalation rate by rung; **exhausted-ladder count** (the headline safety metric); handover completeness.
- **Alert fatigue**: notifications per user per shift (p50/p95), types by volume vs action rate, dismissed-without-action %, snooze rate, flood events, and the tuning recommendations list.
- **Roster quality**: on-call resolution failures, rungs that resolved to nobody, time-to-fill gaps.
- **Compliance**: critical-value acknowledgement within SLA % (NABH/NABL indicator), deterioration-alert response times, evidence pack for an assessor showing the closed loop for a sampled alert.
- Read models: `analytics.mv_notif_type_daily`, `analytics.mv_notif_user_load_daily`, `analytics.mv_notif_escalation_daily`.

## 11. Notifications (about the system itself)
- To **IT**: channel provider degraded/down, push token failure spike, publish backlog above threshold, flood detected, delivery total failure for a critical alert.
- To **Nurse Supervisor / Medical Superintendent**: escalation exhausted (immediate), roster gap detected, ward with abnormal alert volume.
- To **module owners**: your type was auto-downgraded due to volume; your type has a 0 % action rate over 90 days.
- To **users**: "push is blocked — enable it", "your alerts were handed over to X", monthly personal summary (optional).

## 12. Permissions (RBAC keys)
`notify.publish` (service accounts; modules only) · `notify.type.manage` (IT Admin 56 + module owners; clinical types require Medical Superintendent 4 co-approval) · `notify.policy.manage` (Hospital Admin 2, Medical Superintendent 4 — ladders, routing, severity) · `notify.admin.read` (IT, Admin, Quality — searching others' notifications is PHI-audited) · `notify.admin.manage` (cancel/resolve an escalation — Nurse Supervisor 22, Medical Superintendent 4, with reason) · `notify.escalation.read` (nursing command centre, ICU, ER) · `notify.report.read` (Admin, MS, Quality 54, Auditor 58) · self-service (`/me/*`) is available to every authenticated user without an explicit key, scoped to their own data.

## 13. Non-functional
- **Volumes (2000-bed enterprise)**: ~**150 000–250 000 notifications/day** (clinical results, orders, tasks, approvals, operational) fanning out to ~350 000 deliveries; peak 600 publishes/minute during the 08:00–11:00 window and during a mass-casualty activation.
- **Latency**: publish → in-app bell visible p95 **< 1 s**; publish → push delivered p95 < 3 s; publish → SMS queued < 2 s; critical alert publish → first channel delivered p95 **< 5 s**. Bell list query p95 < 150 ms (indexed on `user_id, read_at, created_at desc`, unread counts cached in Redis).
- **Real-time**: Socket.IO with Redis pub/sub; a user with 4 open tabs receives one logical update; read state syncs across devices within 1 s.
- **Reliability**: publish is transactional with the source module's write (outbox); fan-out is at-least-once with per-recipient idempotency; escalation timers are durable (persisted `next_fire_at` polled every 5 s, not in-memory `setTimeout`) and survive worker restarts — a missed escalation is a patient-safety failure, not a glitch.
- **Storage**: ~90 M notification rows/year with recipients and deliveries; monthly partitions with per-type retention; partition detach in < 1 s.
- **Degradation**: if push and SMS providers are both down, in-app + TV + voice remain; the escalation board shows undeliverable alerts explicitly; the system never reports success it cannot prove.
- **Accessibility**: severity is conveyed by icon + label + colour (never colour alone); critical overlay is screen-reader announced with `role="alertdialog"` and is fully keyboard-operable; audible alerts have a visual equivalent for hearing-impaired staff (persistent flashing badge + wearable/pager integration path).
- **i18n**: titles, bodies and action labels translated per type and language (`en-IN, hi, ta, te, ml, kn, mr, bn`, RTL-ready); external templates localised per recipient preference; clinical terms may remain in English by policy.
- **Security/privacy**: payload fields are PHI-classified; external channels receive only minimised content; notification search by admins is audited as PHI access; push endpoints and tokens encrypted at rest.

## 14. Acceptance Criteria
1. **Given** a critical lab value is published, **when** fan-out runs, **then** the in-app notification exists within 1 second, push and SMS are dispatched within 5 seconds, and an escalation instance starts with a visible countdown.
2. **Given** a must-acknowledge alert is unacknowledged after its window, **when** the timer fires, **then** level 2 targets are notified **in addition to** level 1, the escalation board shows the new rung, and the original recipient still sees the alert.
3. **Given** a doctor acknowledges a critical alert with a read-back record, **when** the acknowledgement is saved, **then** the ladder stops for all rungs, already-escalated recipients are told who acknowledged and when, and the structured response is persisted with the clinical record.
4. **Given** an alert reaches the final rung unacknowledged, **when** the ladder is exhausted, **then** `notification.escalation.exhausted` fires, the alert is pinned on the escalation board and the Medical Superintendent dashboard, and a quality incident is recorded.
5. **Given** a user has quiet hours 22:00–07:00, **when** a `normal` notification is published at 02:00, **then** no push or SMS is sent, the in-app bell still records it, and it is delivered on their next session; **when** a `critical` notification is published at 02:00, **then** all channels fire regardless of quiet hours.
6. **Given** a nurse is not on the duty roster today, **when** a ward-scoped operational alert is published, **then** she is not targeted and the on-duty holder is, and no alert is lost.
7. **Given** an on-call rung resolves to nobody because the roster is empty, **when** the rung fires, **then** it promotes immediately to the next rung and a roster-gap defect is raised to the Nurse Supervisor.
8. **Given** the same non-critical notification type fires 5 times for the same patient within the dedupe window, **when** the bell is viewed, **then** one row is shown with an occurrence badge `×5` and a single push was sent.
9. **Given** a push payload for a clinical alert, **when** it is inspected on a locked phone, **then** it contains location and urgency only, with no test name, value, diagnosis or drug name.
10. **Given** a user reads a notification on their phone, **when** their desktop session is open, **then** the desktop bell reflects the read state within 1 second without a page refresh.
11. **Given** the SMS provider is down, **when** a critical alert is published, **then** the failure is recorded, the next channel and next rung proceed immediately, a degraded-channel banner appears, and IT is paged.
12. **Given** a user attempts to snooze a critical alert, **when** they tap snooze, **then** the action is unavailable with an explanation; snoozing a `low` type is capped at 8 hours.
13. **Given** an escalation is in flight and the worker process restarts, **when** the worker recovers, **then** the escalation fires at its persisted `next_fire_at` with no missed or duplicated rung.
14. **Given** a notification type with a 0 % action rate over 90 days, **when** the fatigue report is generated, **then** it appears as a retirement candidate with its volume and dismissal statistics.
15. **Given** a recipient would receive more than 25 non-critical notifications in an hour, **when** the ceiling is reached, **then** further non-critical notifications coalesce into a digest, a flood event is raised, and critical alerts continue to be delivered individually.
16. **Given** an administrator uses the simulate function on a clinical type, **when** they supply a sample context, **then** the exact audience, channels and ladder are shown resolving the live roster, and no message is sent to anyone.
17. **Given** a shift change, **when** an outgoing nurse hands over, **then** her unacknowledged notifications transfer to the incoming holder with a handover note, and unacknowledged critical alerts are never left without an owner.
18. **Given** a user loses access to a ward, **when** a notification for that ward is delivered, **then** the delivery is suppressed by the permission re-check and the subscription is revoked.

## 15. Enhancements / Later phases
- **Native mobile apps** (Phase 13) with FCM/APNs, critical-alert channels that bypass silent mode (Android notification channels / iOS critical alerts entitlement), and wearable/smartwatch delivery for nurses.
- **Pager/DECT/nurse-call integration** for hospitals with legacy paging and bedside call systems (an EN-042/EN-017 connector), so EN-037 becomes the single escalation brain.
- **Presence-aware routing**: route to the device the user is actively using, and to the ward workstation when a nurse is at the station rather than her phone.
- **Smart bundling & prioritisation** (AI-005): learn which notification types a role acts on and reorder the bell accordingly, with full transparency and an off switch; predicted-irrelevance suppression only ever for `low`/`info`.
- **Two-way actionable notifications**: approve/reject, acknowledge with a canned action, or reply from the push notification and from WhatsApp.
- **Broadcast & emergency mass notification** (code blue, fire, mass casualty, disaster) with geo/ward targeting, roll-call acknowledgement and a "who is available" muster.
- **Patient-facing convergence**: a unified preference centre shared with EN-009/EN-032 so a patient's channel choices and a staff member's are governed by one model.
- **SLA-linked notification** for service-level automation across EN-038, NC-028 and RC-001, with predictive "this will breach in 20 minutes" pre-alerts.

## 16. Open Questions for the Hospital
1. What are the **escalation ladders** per critical type — who is L1/L2/L3/L4 for critical labs, deterioration, code blue, blood reaction — and what are the acknowledgement windows at each rung?
2. Is the **duty roster (NC-030)** accurate and maintained in real time? If not, what is the interim source of truth for "who is on call right now"?
3. What are the hospital's **quiet-hours** expectations for staff, and does management accept that `critical` alerts override them unconditionally?
4. Which staff have **smartphones with push**, and which will rely on SMS or voice? Are there wards with no reliable mobile coverage (which changes the channel strategy)?
5. Is **voice escalation** (automated call) acceptable as a final rung, and from which number?
6. What is the acceptable **notification load per nurse per shift**, and which categories should be digests rather than interruptions?
7. Should `high`-severity alerts wake **off-duty** staff, or route only to on-duty holders?
8. Who owns the **notification catalogue governance** — who may create a type, raise a severity, or retire a type?
9. What **content is permitted on external channels** (SMS/push previews) — is "Critical result, Ward 4B Bed 12" acceptable, or must it be even more minimal?
10. Are there existing **pager, DECT or nurse-call systems** that must be integrated rather than replaced?
11. What is the escalation path when a ladder is **exhausted** — who is accountable, and is it treated as a reportable quality incident?
12. Which **languages** must notification content support, and do clinical terms stay in English?
13. What retention does the hospital require for **notification and acknowledgement records** (default: clinical safety 10 years, operational 1 year)?
