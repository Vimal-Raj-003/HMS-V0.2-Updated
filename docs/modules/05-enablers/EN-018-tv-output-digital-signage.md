# EN-018 — TV Output / Digital Signage (Token Boards per Doctor/Room, Ward Status Board, OT Board, Lab TAT Board, Doctor Availability, Emergency Code Banner, Layout Builder, Device Pairing, Offline Resilience, Multi-language TTS Announcements)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Module ID       | EN-018                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Phase           | 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Complexity      | Medium–High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on      | EN-006 (Queue Management — token feed, doctor status, ETA), EN-007 (device tokens & pairing, branding, settings), EN-037 (alerts/emergency codes), OP-001 (doctor schedules, rooms, availability), OP-002 (consult start/complete), IP-001/IP-003 (ward/bed status, acuity, pending tasks), IP-006 (OT schedule & status), OP-004 (lab TAT & report-ready), OP-008 (radiology status), IP-013 (Code Blue), OP-006 (ER/mass-casualty status), EN-015 (visiting-hours/lockdown banner), EN-005 (device fleet management patterns), EN-039 (template/branding assets), NC-026 (campaign & health-awareness content), EN-001 (KPI widgets for management boards) |
| Feature flag    | `module.tv_display.enabled` (sub: `tv.tts`, `tv.chromecast`, `tv.signage_scheduler`, `tv.video_content`, `tv.4k`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Primary roles   | Kiosk / TV / Device (64 — the display itself), Receptionist (24 — board control), Branch Admin (3 — layouts & pairing), IT Admin (56 — device fleet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Secondary roles | Doctor (status change reflected), Nurse in-charge (ward board, OT board), Lab Manager (TAT board), Hospital Admin (content approval), Marketing (55 — awareness content), Security (51 — evacuation/lockdown display)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Regulatory      | DPDP Act 2023 & Rules 2025 (public display of patient identity is a disclosure — default masking: token + first name initial or last-4 UHID; full names only with documented hospital decision), NABH PRE/AAC (patient rights, information display, wait-time transparency, display of rates & charter where mandated), NABH FMS (emergency code display, evacuation maps), Rights of Persons with Disabilities Act 2016 (accessible information — audio + visual), Clinical Establishments Act (display of doctor availability, tariff board), state rules on display of citizen charter, Meta/Google casting device policies for Chromecast use            |

## 1. Purpose

EN-018 turns any TV, monitor or Android box into a hospital information display: OPD token boards outside consultation rooms, doctor-availability boards in reception, ward status boards at nursing stations, OT schedule boards in the OT corridor, lab TAT boards in the collection area, management KPI boards, plus hospital-wide emergency code banners. Layouts are built by admins from widgets, boards are paired to devices with a 4-digit code, content updates in real time over WebSocket, announcements are spoken via multi-language TTS, and every board keeps working (with a stale-data indicator) when the network drops.

## 2. Users & Jobs-to-be-done

- **Patients & attendants** (viewers, 3–8 m away): know their token position, which room to go to, whether the doctor is running late, when the lab report will be ready — without asking staff.
- **Receptionist**: correct a mis-called token, push a manual announcement ("Mr Sharma, please report to Counter 3"), mute/unmute audio during quiet periods.
- **Nurse in-charge**: see the ward at a glance (bed occupancy, acuity, pending tasks, discharges due) on the nursing-station TV without touching a keyboard.
- **OT coordinator**: keep surgeons and families informed of the running OT schedule and case status.
- **Branch Admin**: design layouts per screen, schedule content (peak-hour queue info, off-hour awareness videos), pair/replace devices.
- **IT Admin**: monitor the display fleet (online/offline, last heartbeat, app version, screen resolution), push remote refresh/reboot.
- **Any clinician/security**: trigger an emergency code banner that takes over every screen instantly.

## 3. Core Workflows

### 3.1 Board definition & layout builder

1. Admin creates a **board**: name, purpose type (`opd_token` / `doctor_availability` / `ward_status` / `ot_schedule` / `lab_tat` / `pharmacy_queue` / `cash_counter` / `er_status` / `management_kpi` / `signage_only`), branch, physical location, orientation (landscape/portrait), resolution profile (**1920×1080 default, 3840×2160 for `tv.4k`, 1280×720 for low-end boxes**), theme (10 seeded themes: light clinical, dark teal, deep blue, forest, cream, high-contrast, night mode, brand-primary, monochrome, festival — market parity), refresh/animation settings.
2. **Layout builder** (drag-and-drop grid, 12-column × 8-row): place **widgets** with size/position, each bound to a data source with parameters. Widget catalogue:
   - `now_serving` (per doctor/room: big token, doctor name & photo, room no, status chip), `next_tokens` (next 3–5), `queue_summary` (waiting count, avg wait, ETA), `counter_assignment` ("Token C-45 → Counter 2")
   - `doctor_availability` (grid of doctors: Available / On break / In OT / In procedure / Telemedicine / Left for the day / Expected at HH:MM), `doctor_delay_notice`
   - `ward_status` (bed grid or list: bed no, masked patient label, acuity colour, isolation icon, pending tasks count, expected discharge), `ward_census` (occupied/free/blocked, admissions/discharges today)
   - `ot_schedule` (time, OT room, surgeon, procedure, masked patient, status Scheduled/Pre-op/In progress/Closing/Recovery/Done, delay flag), `ot_utilisation`
   - `lab_tat` (test-group-wise average TAT, "your report ready by" per token, samples in progress), `report_ready_tokens`
   - `er_status` (ESI-wise counts, beds free, ambulance inbound ETA — no patient identity)
   - `kpi_tile` / `chart` (from EN-001 read models: OP footfall, occupancy %, revenue — management boards only, never public areas)
   - `announcement_ticker`, `health_tip_ticker`, `media` (image/video playlist), `web_embed` (allow-listed URLs), `clock_date`, `hospital_branding`, `qr_widget` (feedback/portal/pay QR — EN-013), `visiting_hours` (EN-015), `tariff_board`, `citizen_charter`, `evacuation_map`, `weather`, `emergency_banner` (reserved overlay).
3. **Preview** at the target resolution with live or simulated data → save as a **layout version**; layouts can be cloned across branches and assigned as a template to many boards.
4. **Content scheduling** (`tv.signage_scheduler`): per board, a day-part schedule (e.g. 08:00–20:00 queue layout, 20:00–08:00 awareness/video layout; Sunday special layout), plus playlists with per-item duration, start/end dates and approval status → conflicts resolved by priority.

### 3.2 Device pairing & fleet management

1. IT/Admin registers a **display device**: type (Android TV box, Chromecast, smart TV browser, Raspberry Pi kiosk, Windows mini-PC, tablet in kiosk mode), name, location, MAC/serial, resolution, audio-capable flag.
2. The device opens `https://<tenant>/display` → shows a **4-digit/6-digit pairing code** → admin enters the code in the console and picks a board → device receives a **scoped, device-bound long-lived token** (EN-007 `devices`, scope `display.board.read`) → Event `display.device.paired`.
3. Device subscribes to Socket.IO room `display:<boardId>` and to `display:<branch>:broadcast`; sends a **heartbeat every 30 s** with app version, uptime, memory, current layout version, last render error, network quality.
4. Fleet console: online/offline chips (offline if no heartbeat > 90 s), remote actions — **refresh**, **reassign board**, **change theme**, **reboot** (where the agent supports it), **screenshot** (privacy-gated, only non-PHI boards), **push app update**, **revoke pairing**.
5. Auto-recovery: on crash/reload the device restores the last board from local storage using the cached token; on token revocation it shows a clear "unpaired — contact IT" screen.

### 3.3 Real-time data flow

1. Source modules emit events → the display service maintains a **per-board rendered state** in Redis (`display:board:<id>:state`) and pushes deltas over Socket.IO (`board.patch`) → target end-to-end latency **< 500 ms** from `queue.token.called` to on-screen change.
2. **Fan-out** is board-scoped, not tenant-scoped, so 200 boards do not receive each other's traffic; boards with identical bindings share a computed state object.
3. Devices apply patches with a smooth transition (token flip animation, row highlight for 8 s); a full-state snapshot is sent every 60 s and on reconnect for self-healing.
4. **Polling fallback**: if WebSocket cannot be established (restrictive network, old TV browser), the device degrades to HTTP long-poll every 3 s with ETag caching, and shows a small "slow connection" indicator.

### 3.4 Token calling & announcements (TTS)

1. `queue.token.called` → board renders the token and, if the board is audio-capable and TTS is enabled, plays a **chime** followed by the announcement: template `"Token {token}, please proceed to {room}"` rendered per configured **language rotation** (`en, hi, ta, te, ml, kn, mr, bn`, ordered per branch; max 2–3 languages per call to keep it short).
2. TTS engine options: **browser SpeechSynthesis** (free, offline on Android), **pre-generated audio cache** (server-side TTS → MP3 cached by (text, language, voice) hash — preferred for consistent voice and true offline), or a cloud TTS provider. The audio cache is warmed for all doctor names/rooms at layout activation so a call never waits on synthesis.
3. Volume schedule per board (quiet hours, night wards muted), per-call repeat count (default 1, configurable 2 for large halls), and a **manual announcement** box for reception (free text → moderated word-filter → queued, max 200 characters, audited).
4. Deaf/hard-of-hearing accessibility: every announcement also flashes the token panel and shows the text large for the full announcement duration (RPwD Act).

### 3.5 Emergency code banner

1. Any authorised user (Doctor, Nurse, Security, Switchboard) triggers a code from IP-013/EN-037 or the display console: **Code Blue** (cardiac arrest, blue), **Code Red** (fire, red), **Code Pink** (infant abduction, pink), **Code Purple/Grey** (violent person), **Code Orange** (mass casualty / disaster — OP-006), **Code Yellow** (internal emergency), **Code Black** (bomb threat), **Code Brown** (evacuation), plus hospital-defined codes; payload includes location (ward/floor/room) and instruction text.
2. All boards in the configured scope (branch / floor / hospital-wide) **immediately** overlay a full-width scrolling banner with the code colour, code name, location and instruction, and (if audio enabled) an audible alert with spoken text in the configured languages; queue content continues underneath at reduced size or is fully replaced depending on code severity.
3. Banner persists until stood down (`code.cleared`) or the configured auto-expiry; a "Code cleared" banner shows for 60 s afterwards. Every trigger and clear is audited with actor and reason.
4. **Evacuation mode**: Code Brown/Red at severity high swaps the layout to the floor evacuation map + assembly-point instruction (source enhancement).

### 3.6 Offline resilience

- The display app is a PWA with a service worker caching the shell, theme assets, fonts, TTS audio cache and the **last known board state**.
- On disconnect: the board keeps showing the last state with a discreet amber "Last updated HH:MM:SS" chip; after `stale_threshold` (default 120 s) the chip turns red and token data is dimmed to prevent patients from acting on stale calls; static content (health tips, tariff board, visiting hours) continues normally.
- Reconnect → snapshot sync → chip clears. All offline gaps are recorded in `display_device_events` for the uptime report.
- Local media playlists play from cache so signage-only boards survive long outages.

### 3.7 Exceptions

- Board misconfigured (widget references a deleted doctor/queue) → widget shows an inline neutral placeholder, never a stack trace; admin is alerted.
- Two boards claiming the same device → last pairing wins, previous device forced to re-pair.
- Screen burn-in protection: subtle pixel-shift every 15 min and a dimmed clock screensaver after `idle_minutes` on boards with no queue activity.
- Power-on autostart: device agent configured as a kiosk-launcher so the board recovers unattended after a power cut.

## 4. Data Model (schema `engage`, prefix `display_`)

- `display_boards` — id, hospital_id, branch_id, code, name, purpose_type, location_text, floor, orientation, resolution_profile enum(hd/fhd/uhd), theme_key, audio_enabled bool, tts_languages text[], tts_voice, volume_schedule jsonb, stale_threshold_sec, mask_mode enum(token_only/initial/first_name/full_name), idle_minutes, active_layout_id, fallback_layout_id, emergency_scope enum(board/floor/branch/hospital), status enum(active/paused/retired), created…; UNIQUE(hospital_id, branch_id, code).
- `display_layouts` — id, hospital_id, board_id?, name, is_template bool, version int, grid jsonb (cols, rows, gap), widgets jsonb `[{id, type, x, y, w, h, params, style, refresh_sec}]`, theme_overrides jsonb, status enum(draft/active/retired), created_by, activated_at; index (hospital_id, is_template).
- `display_widgets_catalogue` (seed, code-registered) — type, name, category, data_source, params_schema jsonb, min_size, supports_audio, phi_level enum(none/masked/identifiable), allowed_purpose_types text[].
- `display_devices` — id, hospital_id, branch_id, device_id (EN-007 `core.devices` FK), board_id, name, kind enum(android_tv/chromecast/smart_tv_browser/rpi/mini_pc/tablet), serial, mac, resolution, audio_capable, app_version, last_heartbeat_at, status enum(unpaired/online/offline/revoked), pairing_code, pairing_expires_at, network jsonb (ip, ssid, rtt_ms), last_error, paired_by, paired_at.
- `display_device_events` — id, device_id, event enum(paired/online/offline/reconnected/error/refreshed/rebooted/token_revoked/render_error), detail jsonb, at; partitioned monthly.
- `display_schedules` — id, board_id, layout_id, priority int, days_of_week int[], start_time, end_time, valid_from date, valid_to date, active.
- `display_playlists` / `display_playlist_items` — id, hospital_id, name, items [{media_file_id or url, duration_sec, start_date, end_date, language, approved_by}], shuffle, active.
- `display_announcements` — id, hospital_id, branch_id, board_ids uuid[], text jsonb (per language), audio_only bool, priority, created_by, starts_at, expires_at, repeat_count, status, created_at; audited.
- `display_emergency_codes` — id, hospital_id, code_key, label jsonb (multilingual), colour, severity enum(info/high/critical), default_scope, instruction jsonb, audio_pattern, auto_expire_min, active.
- `display_code_activations` — id, hospital_id, code_key, scope, location_text, ward_id?, triggered_by, triggered_at, cleared_by, cleared_at, reason, boards_reached int, ref_event_id (IP-013/OP-006).
- `display_board_state` (Redis primary; Postgres snapshot table for recovery) — board_id, state jsonb, version int, updated_at.
- `display_tts_cache` — hash (text+lang+voice), lang, voice, audio_file_id, bytes, created_at, last_used_at.
- Retention: device events 90 days, code activations 3 years (NABH evidence), announcements 1 year.

## 5. Business Rules & Validations

- **Privacy by default**: public-area boards use `mask_mode=token_only` or `initial`; a widget with `phi_level=identifiable` cannot be placed on a board whose location is marked public; switching a board to `full_name` requires Hospital Admin confirmation with an on-screen DPDP acknowledgement, is audited, and is recorded in the data-flow register (EN-017).
- Ward status boards never show diagnosis; they show bed, masked label, acuity colour, isolation/precaution icon, and task counts only. Management KPI boards are restricted to staff-only areas (`location_privacy=staff_only`).
- A board renders only widgets allowed for its `purpose_type`; unknown/removed data sources render a neutral placeholder.
- Emergency banners override everything, ignore quiet hours for audio when severity is `critical`, and cannot be dismissed at the device — only cleared from the console by an authorised user.
- Device tokens are device-bound, scoped read-only (`display.board.read`), never carry PHI claims, and expire if unheartbeated for 30 days (must re-pair).
- Pairing codes are 6 digits, single-use, valid 10 minutes, rate-limited to 5 attempts per device.
- Token announcements are suppressed if the token was called more than `announce_ttl` (default 90 s) ago (avoids stale audio after a reconnect).
- Manual announcements pass a profanity/PHI word filter, are capped at 200 characters, require `display.announce` permission, and are audited with the author.
- Web-embed widgets accept only allow-listed URLs (per hospital) and are sandboxed (no scripts accessing the parent, CSP enforced).
- Layouts are versioned; activating a new version pushes to devices within 10 s; rollback restores the previous version without re-pairing.
- Media content must be approved (Marketing → Hospital Admin) before it can appear on a patient-facing board; video is muted by default on boards that also announce tokens.

## 6. API Surface (`/api/v1/display`)

| Method         | Path                                                                                                         | Purpose                      | Permission                                                                | Notes                        |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| GET/POST/PATCH | /boards ; /boards/:id                                                                                        | board CRUD                   | `display.board.configure`                                                 |                              |
| GET/POST/PATCH | /layouts ; /layouts/:id ; POST /layouts/:id/activate \| /clone \| /rollback                                  | layout builder               | `display.layout.configure`                                                | versioned                    |
| GET            | /widgets/catalogue                                                                                           | widget types + param schemas | `display.layout.configure`                                                |                              |
| POST           | /layouts/:id/preview                                                                                         | render preview payload       | `display.layout.configure`                                                | simulated data option        |
| GET/POST/PATCH | /devices ; POST /devices/pair {code, boardId} ; POST /devices/:id/refresh \| /reboot \| /revoke \| /reassign | fleet                        | `display.device.manage`                                                   | audited                      |
| POST           | /devices/register (device) ; POST /devices/heartbeat (device)                                                | device self-service          | device token                                                              | rate-limited                 |
| GET            | /boards/:id/state                                                                                            | full board state snapshot    | `display.board.read` (device/staff)                                       | ETag; WS `display:<boardId>` |
| GET/POST/PATCH | /schedules ; /playlists ; /playlists/:id/items                                                               | content scheduling           | `display.content.manage`                                                  | approval-gated               |
| POST           | /announcements ; DELETE /announcements/:id                                                                   | manual announcement          | `display.announce`                                                        | filtered, audited            |
| GET/POST       | /emergency-codes ; POST /codes/:key/activate {scope, location, instruction} ; POST /activations/:id/clear    | emergency banner             | `display.code.activate` (Doctor, Nurse, Security, Switchboard) / `.clear` | instant fan-out              |
| GET            | /fleet/health                                                                                                | device fleet status          | `display.device.manage`                                                   | WS                           |
| GET            | /tts/audio?text&lang&voice                                                                                   | cached TTS audio             | device token                                                              | signed URL, cache-first      |
| GET            | /reports/uptime ; /reports/announcements ; /reports/code-activations                                         | reports                      | `display.report.read`                                                     |                              |

## 7. Domain Events (outbox)

- `display.device.paired|online|offline|revoked|error` → EN-037 (IT alert on offline > 5 min), EN-007 device registry.
- `display.board.state_changed` (internal, Redis pub/sub — not persisted per change).
- `display.layout.activated|rolled_back`, `display.content.approved|scheduled`.
- `display.announcement.published` → EN-024 audit.
- `display.code.activated|cleared` → IP-013 code-blue record, EN-037 (page the response team), NC-015 (drill/incident evidence), EN-021 (CCTV bookmark at the location).
- Consumes: `queue.token.called|recalled|served`, `queue.doctor.status_changed`, `queue.definition.updated` (EN-006); `ip.bed.status_changed`, `ip.patient.admitted|discharged|transferred`, `nursing.task.pending_changed` (IP-001/IP-003); `ot.case.status_changed`, `ot.schedule.updated` (IP-006); `lab.sample.received|result.final`, `lab.tat.updated` (OP-004); `er.census.updated` (OP-006); `gatepass.lockdown.changed` (EN-015); `alert.code.raised` (EN-037/IP-013); `analytics.kpi.refreshed` (EN-001).

## 8. Screens (UI)

- **Display Runtime** (TV/Android box/Chromecast/browser kiosk, 1080p & 4K): full-screen, no chrome, no cursor; auto-scaled typography (token digits ≥ 180 px at 1080p, readable at 8 m), theme-driven colours with ≥ 7:1 contrast; regions per layout grid; transition animations ≤ 400 ms; amber/red staleness chip bottom-right; emergency overlay layer on top. No interaction expected (touch disabled) except a hidden 5-tap corner gesture to reveal the device diagnostics card (device id, board, version, last heartbeat, network).
- **Board Control Bar** (reception desktop/tablet, docked): current board picker, "Repeat announcement", "Manual announcement" text box with language toggles, mute/unmute, volume slider, "Pause queue display" (for privacy incidents). Shortcuts `Ctrl+Shift+A` announce, `M` mute.
- **Layout Builder** (desktop, wide ≥ 1440px): left widget palette grouped by category, centre 12×8 grid canvas with snap and live data preview, right property panel (data source params, style, refresh); toolbar: resolution switcher (720p/1080p/4K), theme preview, version history, "Preview on device" (pushes to a chosen device for 60 s). Shortcuts: `Del` remove widget, `Ctrl+D` duplicate, `Ctrl+S` save version, `Ctrl+Z/Y` undo/redo.
- **Device Fleet** (desktop): table (device, board, location, status chip, last heartbeat, app version, resolution, network RTT), bulk actions (refresh/update), pairing wizard with a large code display, offline devices pinned to the top with duration offline.
- **Content Scheduler** (desktop): calendar/day-part grid per board, playlist manager with media upload, approval workflow, preview thumbnails, per-item language tagging.
- **Emergency Code Console** (desktop/tablet/phone, reachable in 2 taps from any screen for authorised roles): big colour-coded code buttons, location picker (ward/floor/room), optional instruction text, confirm dialog with a 3-second hold to avoid accidental activation, active-code panel with "Clear code" and elapsed timer.
- **Board Preview / Public URL**: read-only web preview of any board for supervisors on phone/desktop.
- Empty/error states: "No tokens yet today", "Waiting for OT schedule", "Board not assigned — pair this device (code 483920)", "Connection lost — showing data from 14:32".

## 9. Integrations

- **EN-006** queue feed (primary), **EN-037** alerts and code events, **OP-001/OP-002** doctor status, **IP-001/IP-003/IP-006/OP-004/OP-006** clinical status feeds, **EN-001** KPI read-models.
- **Casting/hardware**: Chromecast (Cast Web Receiver app for the display URL — market parity), Android TV native kiosk app (WebView + autostart + volume control), browser kiosk on smart TVs (Tizen/webOS via URL launcher), Raspberry Pi/mini-PC with Chromium in kiosk mode, HDMI-over-IP distribution; wake-on-LAN/CEC power scheduling where supported.
- **Audio**: TV speakers, ceiling PA line-in from the display box, or an existing PA system via a line-out adapter; optional integration with the hospital PA/announcement system for emergency codes.
- **TTS**: browser SpeechSynthesis, self-hosted TTS (Piper/Coqui) for Indian languages, or cloud TTS — configurable per hospital; generated audio cached locally.
- **EN-013** QR widgets (feedback, portal, UPI pay), **EN-017** for any third-party signage CMS the hospital already owns.

## 10. Reports & Analytics

- Device uptime % and offline episodes per board/device, average staleness duration, announcement counts and manual announcement log, emergency code activations with response times (trigger → cleared) as NABH evidence and drill records, board content playtime (media impressions for awareness campaigns), token-call-to-display latency distribution (p50/p95/p99), boards with repeated render errors, TTS cache hit rate. MV `analytics.mv_display_daily`.

## 11. Notifications

- IT Admin: device offline > 5 min, repeated render errors, app version drift, low disk/memory on the box, pairing revoked.
- Reception/Branch Admin: board showing stale data during OPD hours, audio muted for more than N hours during working time.
- Response team: emergency code activated (paged via EN-037 to phones simultaneously with the banner).
- Marketing/Admin: content awaiting approval, playlist item expiring.

## 12. Permissions (RBAC keys)

`display.board.read` (device tokens, staff) · `display.board.configure` (Branch/Hospital Admin) · `display.layout.configure` (Branch Admin, IT Admin) · `display.device.manage` (IT Admin, Branch Admin) · `display.content.manage` (Marketing, Branch Admin) · `display.content.approve` (Hospital Admin) · `display.announce` (Receptionist, Nurse in-charge, Switchboard) · `display.code.activate` (Doctor, Nurse, Security Officer, Switchboard) · `display.code.clear` (Nurse in-charge, Security Officer, Hospital Admin) · `display.report.read` (Admin, IT) · `display.privacy.override` (Hospital Admin — enable full-name display, audited).

## 13. Non-functional

- Scale: up to **200 boards per branch / 400 per group**, 30 concurrent doctor queues, 5000 OP visits/day → ~15k token calls/day. Event-to-pixel latency p95 **< 500 ms**; announcement audio starts < 1 s after the call.
- Each board's WebSocket payload ≤ 8 KB per patch; snapshot ≤ 60 KB; server memory per board state < 200 KB.
- Display client runs on low-cost Android boxes (2 GB RAM): steady-state CPU < 20 %, memory < 400 MB, no memory growth over 7 days (leak test in CI), survives 30-day uptime without restart.
- Offline: full render from cache indefinitely; TTS audio cache ≥ 500 phrases; media playlist cache up to 2 GB.
- Rendering: 1080p default with 4K asset variants; fonts subset-loaded; all text ≥ 28 px at 1080p, token digits ≥ 180 px; ≥ 7:1 contrast; no flashing content faster than 3 Hz (photosensitive-epilepsy safety).
- Accessibility & i18n: every announcement is simultaneously visual and audible (RPwD Act); languages `en, hi, ta, te, ml, kn, mr, bn` with per-branch rotation order; RTL-capable layouts for Gulf deployments.
- Security: device tokens scoped read-only, boards never expose an API beyond their board id, screenshots disabled on PHI-bearing boards, CSP + sandboxed embeds.

## 14. Acceptance Criteria

1. Given a doctor calls the next token, when the board is online, then the "Now Serving" widget updates within 500 ms and the chime plus TTS announcement plays in the configured languages.
2. Given a board is configured for `en` + `ta`, when a token is called, then the announcement is spoken in English then Tamil, and the token text remains enlarged on screen for the full announcement duration.
3. Given the network drops, when the board has no updates for 120 seconds, then a red "Last updated HH:MM" indicator appears, token data is dimmed, and static content (health tips, visiting hours) keeps rotating.
4. Given the network is restored, when the device reconnects, then it fetches a full snapshot, clears the staleness indicator, and does not replay stale audio announcements older than 90 seconds.
5. Given a new device shows a pairing code, when an admin enters that code and selects a board, then the device renders that board within 10 seconds and appears as `online` in the fleet console.
6. Given a Code Blue is triggered for ICU-2, when the activation is confirmed, then every in-scope board displays the blue banner with location and instruction within 2 seconds, audio alerts play even during configured quiet hours, and the activation is recorded with actor and timestamp.
7. Given a code is cleared, when the operator confirms, then all boards show "Code cleared" for 60 seconds and then resume their normal layout.
8. Given a board located in a public waiting area, when an admin tries to add a widget with `phi_level=identifiable` (e.g. full patient names on a ward board), then the layout cannot be saved without an explicit Hospital Admin privacy override, which is audited.
9. Given a doctor sets status "On break", when the availability board renders, then the doctor's tile changes to "On break" with the expected return time, and waiting-token ETAs increase accordingly.
10. Given the OT board, when a case status changes to "In progress", then the row updates in real time and delayed cases are visually flagged without revealing the patient's full name.
11. Given a layout version is activated, when devices are online, then all devices bound to that board apply the new layout within 10 seconds without re-pairing; rollback restores the previous version equally fast.
12. Given a device has not sent a heartbeat for 90 seconds, when the fleet console refreshes, then the device shows offline with the duration, and after 5 minutes an alert reaches IT.
13. Given the display box is power-cycled, when it boots, then the kiosk app auto-starts, restores its board from cache, and renders within 60 seconds without human intervention.
14. Given a receptionist sends a manual announcement containing a patient's full name on a public board configured for masking, when submitted, then the word filter blocks/flags it and the announcement requires explicit confirmation, recorded in the audit log.
15. Given a 4K board, when the layout is rendered, then assets are served at 4K, text scales proportionally, and CPU usage on the device stays within the target budget.
16. Given the lab TAT board, when a sample's expected-ready time changes, then the corresponding token row updates and the test-group average TAT recalculates on the next refresh interval.

## 15. Enhancements / Later phases

- **Patient education videos during wait** with playlists per specialty and language rotation (source enhancement) — auto-mute during token announcements.
- **Digital signage content scheduler** with campaign calendars, festival themes and effectiveness reporting (source enhancement, tie to NC-026).
- **Emergency evacuation map display** per floor with dynamic assembly-point and exit-route highlighting during Code Brown/Red (source enhancement).
- **Multi-language content rotation** and health-awareness campaign scheduling by department (source enhancement).
- Personalised "your turn in ~12 min" on the patient's phone synchronised with the board (PE-001/OP-020), and QR-to-follow-my-token.
- Interactive wayfinding kiosks (EN-034 convergence) with touch floor maps and department search.
- Room-side digital door signs (e-ink) showing bed/patient status, isolation precautions and nurse assignment.
- Conference/auditorium and management war-room dashboards with EN-001 live KPIs and drill-down on a large video wall.
- Device power scheduling (HDMI-CEC on/off with OPD hours) and energy reporting.
- AI-generated wait-time forecasts on the board (AI-005) and sentiment-aware content (quiet content during high-stress periods).

## 16. Open Questions for the Hospital

1. How many screens, of what size/resolution, and in which locations (per doctor room, corridor, ward station, OT, lab, reception, management)?
2. Existing hardware: smart TVs (brand/OS), Android boxes, Chromecast, or PC-driven displays? Is there an existing digital-signage CMS to keep?
3. Audio: do the screens have speakers, or is there a central PA system? Should token calls be announced audibly in wards at night?
4. Which languages, in what order, for TTS announcements per area? Preferred voice (male/female) and speech rate?
5. Privacy decision: token only, first-name initial, or full patient name on public boards? Who signs off on this (DPO)?
6. Emergency code names and colours in use at this hospital (Code Blue/Red/Pink…), who may trigger each, and should the display integrate with the existing PA/alarm system?
7. Ward status board content: is showing acuity, isolation status and pending tasks acceptable in a corridor, or should it be nursing-station only?
8. Off-hours content: awareness videos, tariff board, citizen charter, or blank/standby to save power?
9. Network: are display devices on a segregated VLAN with internet access, and is WebSocket traffic permitted end-to-end?
10. Who owns board content approval (Marketing vs Admin), and what is the turnaround expectation?
11. Should management KPI boards be included at go-live, and which KPIs, restricted to which rooms?
