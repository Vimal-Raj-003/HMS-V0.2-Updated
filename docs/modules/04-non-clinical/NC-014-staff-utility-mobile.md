# NC-014 — Staff Utility Mobile (Directory, Attendance, Leave, Payslip, Announcements, Helpdesk, SOS)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Non-Clinical / ERP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Module ID       | NC-014                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Phase           | 9 (PWA) / 13 (React Native app)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Depends on      | NC-010 (ESS APIs: profile, leave, payslip, IT declaration, documents, loans, F&F), NC-029 (mobile geo-fenced attendance punch), NC-030 (roster, shift swap requests, team calendar), NC-028 (helpdesk tickets IT/maintenance/admin), NC-004 (policies/circulars), NC-033 (cafeteria meal booking), NC-027 (training calendar/e-learning links), NC-010 recruitment (internal job postings), EN-007 (auth/SSO, device sessions), EN-037 (push notifications: Web Push/FCM), EN-009 (SMS fallback), NC-019/EN-015 (SOS → security), EN-039 (forms), NC-015 (incident reporting shortcut), NC-032 (feedback), OP-019/IP-010 (doctor/nurse clinical apps are separate; NC-014 is the non-clinical utility app for all staff), EN-024 |
| Feature flag    | `module.staff_app.enabled` (sub: `staff_app.geo_attendance`, `staff_app.sos`, `staff_app.cafeteria`, `staff_app.jobs`, `staff_app.shift_swap`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Primary roles   | All employees (every role template 2–58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Secondary roles | Managers/HODs (approvals on the go), HR (announcements, broadcast), Security (SOS console), IT helpdesk (ticket triage), Admin (feature config)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Regulatory      | DPDP Act (employee data, location consent for geo-attendance — purpose-limited, on-duty only), IT Act (electronic records/consent), Shops & Establishments (attendance records), Payment of Wages (payslip access), POSH (confidential complaint channel), NABH (staff communication/incident reporting culture), accessibility (RPwD Act — accessible apps)                                                                                                                                                                                                                                                                                                                                                                     |

## 1. Purpose

NC-014 is the **one staff app** (installable PWA now, React Native later, sharing contracts) for every hospital employee: staff directory with quick call/message, geo-fenced attendance punch and monthly summary with regularisation, leave apply/approve, payslips & YTD, IT declarations & document uploads (reimbursements/certificates/licences), announcements with read receipts, helpdesk tickets, roster/team calendar & shift swaps, cafeteria booking, internal job postings, training calendar, incident/feedback quick links and an **emergency SOS button**. It is a thin, offline-tolerant front-end over NC-010/NC-029/NC-030/NC-028/NC-004/NC-033 APIs with role-aware modules and push notifications.

## 2. Users & Jobs-to-be-done

- **Employee** (phone, 30-second interactions): punch in/out at allowed sites, apply leave, check balance/roster, view payslip, submit declarations/claims, read announcements, raise/track tickets, book cafeteria meal, request shift swap, apply for internal jobs, trigger SOS.
- **Manager/HOD** (phone): approve leave/regularisation/OT/swaps with one tap (PIN), see team on-duty/absent today, broadcast to team.
- **HR/Admin**: publish announcements (hospital/branch/department/role targeting; mandatory read; attachments), surveys/polls, manage app modules & geo-fences.
- **Security control room**: receive SOS with live location & callback; acknowledge, dispatch (EN-015/NC-019).
- **IT/Facility helpdesk**: tickets from app land in NC-028 queues.

## 3. Core Workflows

### 3.1 Login, device & home

1. Staff logs in (EN-007: employee id/email + password/SSO + optional biometric unlock; device registered; push token) → role-aware home: quick actions (Punch, Leave, Payslip, Tickets, Announcements), today's shift (NC-030), pending approvals count (managers), unread announcements, SOS button (persistent) → offline shell cached (`@serwist/next`), reference data (holidays, directory) cached with TTL.
2. Session: idle timeout per policy; remote wipe of cached PHI-free data on device revoke.

### 3.2 Staff directory

- Search by name/department/designation/extension; profile card (photo, department, designation, extension, official mobile/email if shared, on-duty status from roster); actions: call/WhatsApp/Teams-like in-app message (EN-037 direct message) — personal numbers hidden unless employee opts in; on-call directory (per department, from NC-030); favourites.

### 3.3 Attendance (`staff_app.geo_attendance`, with NC-029)

1. **Punch**: app checks geo-fence (site polygons/radius per branch/site, GPS accuracy threshold), optional selfie/liveness (config), Wi-Fi/BLE beacon corroboration (optional) → posts punch to NC-029 with device id, timestamp, location, accuracy → confirmation; outside geofence → "field duty" punch requires reason & manager approval; offline punch queued with device time & later sync (flagged `offline_punch` for HR review) → Event `attendance.punch.recorded` (NC-029).
2. **Monthly summary**: days present/absent/late/leave/OT (from NC-010 attendance_days); **regularisation** request (missed punch, official duty) → manager approval → status.

### 3.4 Leave & approvals

- Apply (type, dates, half-day, reason, handover, attachment camera), balance & holiday calendar shown; manager gets push → approve/reject with comment (PIN/biometric confirm) → instant balance update (NC-010); cancel; team leave calendar for managers; escalation reminders.

### 3.5 Payslip, YTD & documents

- Payslip list (NC-010 payslips), PDF download (watermarked, protected by app auth), YTD earnings/deductions, Form 16; IT declaration (12BB) form & proof uploads with status; reimbursement claims (bills camera → NC-010); certificates/licence renewal uploads (NC-010 credentials) → approval tracking.

### 3.6 Announcements & communication

- HR/admin compose (title, body rich text, attachments, targeting: all/branch/department/role/custom list, schedule, expiry, `mandatory_read`, `allow_comments`, `pin`) → push + feed; **read receipts** (who read/when; % per department); acknowledgements for policies (NC-004 link); polls/surveys (NC-010 engagement); emergency broadcast (code announcements e.g. Code Red/Blue drills → also EN-018/EN-037) with high-priority push.

### 3.7 Helpdesk tickets (NC-028)

- Raise ticket (category IT/maintenance/biomedical/housekeeping/admin/HR; location via QR scan of room/asset tag EN-013; photo; priority) → routed to NC-028/NC-025/NC-020 queues → status timeline & chat → resolution notification & rating.

### 3.8 Roster, shift swap & team calendar (`staff_app.shift_swap`, NC-030)

- My roster (week/month), team calendar (manager), shift swap request to a colleague (same skill/ratio rules) → colleague accepts → supervisor approves → roster updated (NC-030) → notifications.

### 3.9 Cafeteria booking (`staff_app.cafeteria`, NC-033), Jobs (`staff_app.jobs`, NC-010 recruitment), Training (NC-027)

- Meal booking/menu/subsidy balance & QR redemption; internal job postings & apply with profile; training calendar/e-learning links & certificates.

### 3.10 Emergency SOS (`staff_app.sos`)

- Persistent SOS button (long-press 2 s to avoid false triggers) → sends alert to security control room (NC-019 console + EN-037 push/SMS to on-duty security & supervisor) with employee, live location (in-campus zone from geofence/beacon; GPS), optional silent mode, callback; security acknowledges → resolution logged; false alarm cancel within 10 s with PIN; POSH/harassment confidential report channel separately (routes to ICC members only) → Event `staff.sos.raised|acknowledged|resolved`.

## 4. Data Model (schema `engage`, prefix `staffapp_`; most data lives in source modules)

- **staffapp_devices**: id, hospital_id, user_id, employee_id, platform enum(pwa/android/ios), device_id, push_token, app_version, last_seen_at, biometric_unlock bool, status enum(active/revoked).
- **staffapp_announcements**: id, hospital_id, title, body, attachments uuid[], audience jsonb {branches, departments, roles, users}, priority enum(normal/high/emergency), mandatory_read bool, allow_comments bool, pinned bool, publish_at, expires_at, created_by, status enum(draft/scheduled/published/expired/withdrawn); **staffapp_announcement_reads** (announcement_id, user_id, read_at, acknowledged_at?); **staffapp_comments**; **staffapp_polls** (options, anonymous, responses).
- **staffapp_geofences**: id, hospital_id, branch_id, name, kind enum(campus/site/field), geom (polygon/circle), accuracy_threshold_m, requires_selfie bool, beacon_ids text[], active. (Consumed by NC-029.)
- **staffapp_sos_alerts**: id, hospital_id, branch_id, employee_id, raised_at, location geom?, zone?, silent bool, status enum(raised/acknowledged/resolved/false_alarm), acknowledged_by, acknowledged_at, resolved_at, notes, security_incident_id? (NC-019).
- **staffapp_quick_links** (config per role), **staffapp_feature_flags** per hospital.
- Directory read from NC-010 employees (fields whitelisted, `share_personal_mobile` opt-in flag on employee profile).
- RLS; announcements retained 2 years; SOS records permanent (security).

## 5. Business Rules & Validations

- App exposes only the logged-in employee's data (`self_only`) plus manager/team scopes from NC-010; no PHI in this app.
- Geo-attendance: punch accepted only inside an active geofence with GPS accuracy ≤ threshold (default 50 m) or with beacon corroboration; mock-location detection (Android) → reject & flag; offline punches flagged for HR review; location captured only at punch time (and during SOS), never continuous; consent recorded at first use (DPDP).
- Approvals via app require re-auth (PIN/biometric) and are idempotent; escalation per NC-010 rules.
- Announcements: emergency priority limited to authorised roles; mandatory-read tracked; read receipts visible to authors/HR only.
- Payslip PDFs served via short-lived signed URLs, watermarked with employee id; downloads audited; screenshots not preventable — policy notice.
- SOS: cannot be disabled by user; long-press; false-alarm cancel window; alerts routed to on-duty security roster (NC-030) with fallback to fixed numbers; acknowledgement SLA 60 s → escalate.
- Directory personal numbers hidden by default; call/message actions logged (count only, not content).
- Ticket creation requires category & location; QR scan pre-fills asset/room.
- Feature modules toggle per hospital; app version enforcement (min supported version).

## 6. API Surface (`/api/v1/staff-app` — thin aggregators over source modules)

| Method     | Path                                                                                                                               | Purpose                                                     | Permission                             | Idem                                                           | Pag                        |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------- | -------------------------- |
| POST       | /devices/register ; DELETE /devices/{id}                                                                                           | push tokens/devices                                         | staffapp.self                          | Y                                                              | –                          |
| GET        | /home                                                                                                                              | aggregated home (shift, counts, announcements, quick links) | staffapp.self                          | –                                                              | –                          |
| GET        | /directory?q=&dept= ; GET /directory/{employeeId} ; GET /directory/on-call?dept=                                                   | directory                                                   | staffapp.directory.read                | –                                                              | cursor                     |
| POST       | /attendance/punch (geo, selfie?, device) → NC-029 ; GET /attendance/summary?month= ; POST /attendance/regularise                   | attendance                                                  | hr.attendance.regularise (self)        | Y                                                              | –                          |
| GET        | /leave/balances ; POST /leave/apply ; GET /leave/mine ; POST /leave/{id}/cancel                                                    | leave (→ NC-010)                                            | hr.leave.apply (self)                  | Y                                                              | cursor                     |
| GET        | /approvals ; POST /approvals/{type}/{id}/(approve                                                                                  | reject)                                                     | manager inbox                          | hr.leave.approve / hr.attendance.approve / roster.swap.approve | Y                          | cursor |
| GET        | /payslips ; GET /payslips/{id}/pdf ; GET /ytd ; GET /form16/{fy}                                                                   | payslips (→ NC-010)                                         | hr.payslip.read (self)                 | –                                                              | cursor                     |
| GET/POST   | /it-declaration/{fy} ; POST /documents (type, file) ; GET /documents                                                               | declarations/uploads                                        | hr.tds.declare / hr.employee.self.docs | Y                                                              | cursor                     |
| GET        | /announcements ; POST /announcements/{id}/(read                                                                                    | ack                                                         | comment) ; POST /polls/{id}/respond    | feed                                                           | staffapp.announcement.read | Y      | cursor |
| POST/PATCH | /announcements (HR)                                                                                                                | publish                                                     | staffapp.announcement.manage           | Y                                                              | –                          |
| POST       | /tickets → NC-028 ; GET /tickets/mine ; POST /tickets/{id}/comment                                                                 | helpdesk                                                    | ticket.create (self)                   | Y                                                              | cursor                     |
| GET        | /roster/mine?from=&to= ; GET /roster/team ; POST /roster/swap-requests ; POST /swap-requests/{id}/(accept                          | decline)                                                    | roster (→ NC-030)                      | roster.self / roster.swap.request                              | Y                          | –      |
| GET/POST   | /cafeteria/menu, /cafeteria/bookings (→ NC-033) ; GET /jobs ; POST /jobs/{id}/apply (→ NC-010) ; GET /training/calendar (→ NC-027) | utilities                                                   | respective module keys (self)          | Y                                                              | cursor                     |
| POST       | /sos ; POST /sos/{id}/cancel ; POST /sos/{id}/(ack                                                                                 | resolve) (security)                                         | SOS                                    | staffapp.sos.raise (all) / security.sos.handle                 | Y                          | –      |
| GET/PUT    | /admin/geofences, /admin/features, /admin/quick-links                                                                              | config                                                      | staffapp.configure                     | Y                                                              | –                          |

## 7. Domain Events (outbox)

- `staffapp.device.registered|revoked` → EN-037 push routing, EN-007 sessions.
- `staffapp.announcement.published|read|acknowledged` → HR dashboards, NC-004 (policy acks), NC-015 (awareness indicators).
- `staff.sos.raised|acknowledged|resolved|false_alarm` {employee, location} → NC-019 security console, EN-037/EN-009 alerts, NC-015 incident (if resolved as incident).
- `staffapp.punch.submitted` (→ NC-029 `attendance.punch.recorded`), `staffapp.ticket.created` (→ NC-028), swap/leave events are emitted by NC-030/NC-010.
- Consumes: `hr.leave.approved|rejected`, `payroll.posted` (payslip ready push), `roster.published|shift.swapped`, `ticket.status_changed`, `hr.licence.expiring`, `announcement.emergency` (EN-037), `training.scheduled` (NC-027), `cafeteria.menu.published` (NC-033), `hr.employee.exited` (revoke devices).

## 8. Screens (UI)

- **Home** — phone (single pane, bottom nav: Home / Attendance / Leave / Pay / More): shift card, quick actions grid, pending approvals badge, announcements carousel, SOS floating button; offline banner; skeletons.
- **Directory** — phone: search-as-you-type, profile sheet with call/message; on-call tab.
- **Attendance** — phone: big Punch In/Out button with geofence status & map snippet, selfie capture (if required), monthly calendar heat map, regularise form; offline queue indicator.
- **Leave** — phone: balances tiles, calendar picker with holidays/roster overlay, apply form, history; **Approvals** — manager list with swipe approve/reject + PIN.
- **Pay** — phone: payslip list, PDF viewer, YTD chart (Recharts), IT declaration wizard, claims camera upload.
- **Announcements** — phone: feed with pinned/mandatory badges, read/ack buttons, comments/polls; **Compose** — desktop/phone (HR) with audience picker & preview.
- **Tickets** — phone: raise (category, QR scan, photo), list, chat.
- **Roster & swaps** — phone: my week/month, swap request flow; team calendar (manager).
- **Cafeteria / Jobs / Training** — phone lists & actions.
- **SOS** — long-press → confirmation haptic → status screen with security callback; **Security SOS console** (NC-019) — desktop/TV with map & acknowledge.
- Accessibility: large targets, dynamic type, screen reader labels, high contrast; i18n (en/hi/regional); RTL-ready. Tablet/desktop responsive for ESS web (NC-010).

## 9. Integrations

- EN-007 auth (SSO/2FA, device sessions), EN-037 push (Web Push/FCM/APNs via RN later), EN-009 SMS fallback, NC-029 punch API & geofence rules, NC-010 ESS APIs, NC-030 roster, NC-028 tickets, NC-004 policies, NC-033 cafeteria, NC-027 training, NC-019/EN-015 security console, EN-013 QR, maps SDK for geofence display, device APIs (camera, geolocation, biometrics), app stores (Phase 13).

## 10. Reports & Analytics

- App adoption (installs/active users by dept), punch mode mix (biometric vs mobile), geofence rejections/mock-location flags, leave requests via app & approval TAT, announcement reach/read %, ticket volumes by category from app, SOS incidents (count, ack time), swap requests, cafeteria bookings. Read model `analytics.staffapp_usage_daily`.

## 11. Notifications

- Push: approvals pending/decided, payslip ready, announcement (normal/high/emergency), ticket updates, roster changes/swap responses, licence/document expiries, training reminders, cafeteria confirmations; SMS fallback for emergency broadcast & SOS to security; badge counts.

## 12. Permissions (RBAC keys)

`staffapp.self` (all employees), `staffapp.directory.read`, `staffapp.announcement.read/manage`, `staffapp.sos.raise` (all), `security.sos.handle` (security roles), `staffapp.configure` (admin); reuses `hr.*`, `roster.*`, `ticket.*`, `cafeteria.*`, `training.*` self-scoped keys. ABAC: `self_only`, `own_team_only` for managers.

## 13. Non-functional

- 10k users; home aggregate p95 < 400 ms; punch round-trip < 1.5 s on 3G; push delivery < 5 s; PWA install < 3 MB shell; offline: shell, directory cache (24 h), roster/holidays, queued punches/leave/tickets; background sync on reconnect.
- Battery: location only on demand; no background tracking.
- Security: device binding, biometric unlock, short-lived tokens, signed URLs for payslips, jailbreak/root & mock-location detection (best-effort), no PHI, audit of approvals/downloads; app min-version enforcement.
- Accessibility WCAG 2.2 AA; i18n; RN app shares Zod contracts & design tokens (Phase 13).

## 14. Acceptance Criteria

1. Given an employee inside the campus geofence with GPS accuracy 20 m, when punching in, then NC-029 records the punch with location and the app shows confirmation; outside geofence, the app requires a field-duty reason and marks it pending manager approval.
2. Given mock-location detected, then the punch is rejected and flagged to HR.
3. Given a manager receives a leave request push, when approving with PIN, then NC-010 updates the balance and the employee gets a push within 5 s; a duplicate tap does not double-approve.
4. Given payroll posted, then employees receive "payslip ready" push and can open the watermarked PDF via signed URL; the download is audited.
5. Given HR publishes a mandatory-read announcement to ICU nurses, then only ICU nurses see it, read receipts populate, and department read % is visible to HR after 24 h.
6. Given an employee long-presses SOS for 2 s, then security console shows the alert with location within 5 s, on-duty guards get push/SMS, and acknowledgement within 60 s is recorded; a cancel within 10 s with PIN marks false alarm.
7. Given a ticket raised by scanning a room QR, then category/location pre-fill and NC-028 routes it to the facility queue; status updates push to the employee.
8. Given a shift swap request accepted by a colleague of the same skill, then supervisor approval updates NC-030 roster and both employees are notified; a swap violating ratio rules is rejected with reason.
9. Given the phone is offline, then punch/leave/ticket actions queue and sync on reconnect with idempotency; queued items show pending state.
10. Given an exited employee, then devices are revoked and the app logs out with cached data cleared.

## 15. Enhancements / Later phases

- From VIMS sheet: geo-fenced attendance verification (`staff_app.geo_attendance`, Phase 9), emergency SOS button (`staff_app.sos`, Phase 9), cafeteria meal booking (`staff_app.cafeteria`, Phase 9 with NC-033), internal job posting & application (`staff_app.jobs`, Phase 9), team calendar & shift swap request (`staff_app.shift_swap`, Phase 9 with NC-030).
- (market) Face-recognition attendance (NC-029), in-app chat with groups (EN-037), digital ID card with QR for gate/canteen, wellness/steps challenges (PE-005 for staff), voice assistant for HR queries (AI-001), native RN app with offline-first sync (Phase 13), NFC punch, learning micro-modules (NC-027).

## 16. Open Questions for the Hospital

1. Devices policy: BYOD allowed? Android/iOS mix; PWA acceptable initially?
2. Sites/geofences for mobile attendance (campus, satellite clinics, field staff) and selfie requirement?
3. Which modules to enable at launch (attendance, leave, payslip, announcements, tickets, SOS…)?
4. Security control room availability 24×7 for SOS; escalation numbers?
5. Directory visibility rules (personal mobiles, extensions) and DPDP consent text?
6. Cafeteria subsidy/booking model; internal job posting policy?
7. Emergency broadcast codes and who can send them?
