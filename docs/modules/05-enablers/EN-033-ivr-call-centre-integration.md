# EN-033 — IVR / Call Centre Integration (SIP & Cloud Telephony Adapters, IVR Flow Builder, Appointment Booking & Report Status by Phone, Click-to-Call, Recording with Consent & Retention, Agent Console with Patient-360 Popup, Call Disposition, TRAI/DoT Compliance, Queue & SLA Analytics)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Module ID       | EN-033                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Phase           | 10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Depends on      | EN-017 (telephony connectors, webhooks, retry/DLQ), EN-009 (SMS confirmations & DLT templates, opt-out ledger), EN-007 (users, roles, device/service accounts), EN-024 (audit), EN-037 (agent alerts & escalation), EN-006 (queue/token status for "where am I in the queue"), OP-001 (appointment slots, patient search, registration), OP-004/OP-008 (report readiness status), OP-005/IP-005 (bill/dues status), EN-028 (recording & data-processing consent), EN-030 (IVR survey channel), NC-032 (complaints raised by phone), NC-030 (on-call roster for after-hours routing)                                                                                                                                                                                                                                                                                                       |
| Consumed by     | OP-001 (appointments created by phone), PE-002 (follow-up & recall calling lists), EN-030 (outbound IVR surveys), NC-013 (ambulance emergency line), NC-032 (grievance intake), EN-012 (website click-to-call widget), EN-001 (call analytics), TR-009 (108/112 pre-hospital coordination — voice leg only; clinical handover stays in TR-009)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Feature flag    | `module.ivr.enabled` (sub: `ivr.inbound`, `ivr.outbound`, `ivr.recording`, `ivr.click_to_call`, `ivr.agent_console`, `ivr.speech`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Primary roles   | Call Centre Agent (25), Receptionist / Front Office (24), Marketing/CRM Executive (55 — outbound campaigns)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Secondary roles | Hospital Admin (2), Branch Admin (3), IT Admin (56 — connector & number config), Quality Manager (54 — call QA & complaint calls), Doctor (6/7 — click-to-call to a patient with number masking), Ambulance Dispatcher (52), Nurse Supervisor (22 — after-hours routing), DPO (57 — recording retention & consent), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Regulatory      | **TRAI TCCCPR 2018 & DLT framework** (registered headers/templates for the SMS leg; commercial voice calls only from registered 140-series/1600-series numbers; DND/NCPR scrubbing for promotional calls; transactional/service calls exempt but must be genuinely service-related); **DoT licensing** — cloud telephony must be delivered through a licensed provider; **no unauthorised OTT-PSTN bridging or toll bypass**; call recording requires disclosure and, for personal data, a lawful basis under the **DPDP Act 2023 & Rules 2025** (notice at call start, purpose limitation, retention limit, erasure on request); **Indian Telegraph Act** interception rules (recordings are business records, not lawful-intercept); **CERT-In** log retention 180 days; NABH PRE (patient access to information, grievance channel), Consumer Protection (no misleading claims on IVR) |

## 1. Purpose

EN-033 gives the hospital a phone channel that is a first-class part of the HMS rather than a separate call-centre island: inbound IVR that can answer "is my report ready?", "what is my token number?", "book/cancel my appointment" without an agent; overflow to a live agent whose console pops the caller's patient-360 and writes back a disposition; outbound dialling for follow-ups, recalls and surveys; click-to-call from any patient record with number masking; and full call logging, recording (with consent), queue/SLA analytics and TRAI/DoT compliance.

## 2. Users & Jobs-to-be-done

- **Patient / caller (phone)**: reach the hospital, self-serve in their own language for report status, appointment booking/cancellation, token position, bill dues and ambulance, and reach a human quickly when self-service fails.
- **Call Centre Agent (25, desktop with headset, all day)**: answer a ringing call with the patient's record already on screen, book/reschedule an appointment in under 90 seconds, log a disposition, and schedule a callback — without ever alt-tabbing to a separate CRM.
- **Front Office (24)**: take overflow calls at the desk, transfer to the right department, and see missed calls that need a call-back.
- **Doctor / Nurse (6/7/17)**: click-to-call a patient from the chart with the hospital's number displayed and the doctor's personal number masked; the call is logged against the encounter.
- **Marketing/CRM (55)**: run an outbound campaign (health camp, vaccination drive) with DND scrubbing and consent enforcement, measure connect and conversion rates.
- **Ambulance Dispatcher (52)**: receive the emergency line with priority routing, location capture and automatic pre-alert to ER.
- **Supervisor / Quality (25 lead / 54)**: watch live queue depth and agent states, listen to or score recorded calls, and act on abandoned-call and SLA breaches.
- **DPO (57)**: prove that recording consent was captured, that retention is enforced, and satisfy an erasure request for a specific call.

## 3. Core Workflows

### 3.1 Telephony connector & number setup

1. IT Admin registers a **telephony connector** (EN-017): **Exotel**, **Knowlarity/Ozonetel**, **Twilio**, **MyOperator**, **Servetel/Acefone**, **Kaleyra**, or an **on-prem SIP PBX** (Asterisk/FreePBX/FreeSWITCH/3CX/Avaya/Cisco) reached over SIP trunk with SRTP. Credentials to vault; webhook URLs and signature secrets registered.
2. **Numbers** (`ivr_numbers`) are provisioned and mapped: main hospital line, appointment line, lab-report line, emergency/ambulance line, per-branch DIDs, toll-free (1800), and an outbound caller-ID pool. Each number declares branch, purpose, business hours, after-hours behaviour, language set and the flow it entry-points into.
3. **Compliance registration** is recorded per number: DoT-licensed provider reference, TRAI header/template registration for the SMS leg, and whether the number is used for promotional calls (which then requires DND/NCPR scrubbing and 140/1600-series usage).
4. **Capacity** is configured: concurrent channels, queue size, ring strategy, and the recording policy (all / agent-only / off) per number.

### 3.2 IVR flow builder & inbound self-service

1. Flows are authored in a **visual flow builder** (nodes: Play prompt, Collect DTMF, Menu, Say (TTS), Condition, Lookup (HMS API), Transfer to queue/agent/external, Voicemail, Send SMS, Callback request, Hang up, Sub-flow), with per-node language variants and a versioned, testable definition.
2. **Language selection** first (`1 English, 2 हिन्दी, 3 தமிழ், …`), cached against the caller's number for future calls; prompts are pre-recorded audio (preferred, professional voice) with TTS fallback for dynamic values (dates, token numbers, amounts) — never TTS for clinical text.
3. **Caller identification**: ANI (calling number) is matched against patient records. One match → proceed; multiple matches (family sharing a number) → "press 1 for Ramesh, 2 for Sunita" using masked first names only; no match → collect UHID or offer registration/agent.
4. **Authentication before any personal data**: a 4-digit OTP sent by SMS to the same number, or DOB verification (DDMM), configurable per flow. Report _content_ is never read out; only status and, if permitted, "your report is ready — collect at the lab or check the portal, link sent by SMS".
5. **Self-service transactions**:
   - **Report status**: "Your blood test report is ready" / "in progress, expected by 4 PM" (from OP-004/OP-008 status only) → SMS with the portal link.
   - **Appointment booking**: department → doctor → next available slots read out (max 3) → confirm → booking created in OP-001 with source `ivr` → SMS confirmation (DLT template).
   - **Reschedule / cancel**: list the caller's upcoming appointments → confirm action → cancellation policy applied (OP-001).
   - **Token / queue position**: "You are number 14; approximately 35 minutes" from EN-006.
   - **Bill dues & payment link**: outstanding amount → SMS payment link (EN-010).
   - **Pharmacy refill request**, **ambulance request** (immediate transfer with location capture), **complaint** (voicemail + NC-032 ticket).
6. **Fallback to agent**: any node can escalate; DTMF `0` always reaches a human during business hours; after three failed inputs, transfer automatically. After hours → on-call routing (NC-030), voicemail, or callback scheduling.
7. Every call writes an `ivr_calls` row with the full node path (`ivr_call_steps`) so a "the IVR didn't work" complaint can be replayed.

### 3.3 Agent console & live call handling

1. Agent logs in and sets state (`available / on-call / after-call-work / break / offline`); the console registers a WebRTC softphone or an agent-leg call to their extension/mobile.
2. **Inbound call arrives** → skills-based routing (language, department, branch, VIP/priority, previous agent stickiness) → **screen pop within 1 s**: patient banner (name, UHID, age/sex, photo, allergies flag), last 3 visits, upcoming appointments, pending reports, outstanding bills, open complaints, previous call history with dispositions, and the reason the IVR escalated (node path).
3. Agent acts inside the console: book/reschedule appointment, register a new patient, answer report status, raise a complaint (NC-032), create a follow-up task (PE-002), send an SMS/WhatsApp from an approved template, or transfer (warm/cold) to a department, doctor or supervisor.
4. **Wrap-up**: mandatory **disposition** (coded: appointment booked / rescheduled / cancelled / enquiry answered / report status / complaint registered / follow-up scheduled / wrong number / no requirement / call dropped / abusive / language barrier / transferred), plus notes, outcome tags and an optional callback schedule. After-call-work timer is capped (default 90 s) and configurable.
5. **Call ends** → `ivr_calls` finalised with durations (ring, talk, hold, wrap), recording ref, transfers, disposition → Event `ivr.call.completed`.
6. **Supervisor tools**: live wallboard (waiting, longest wait, agents by state, service level), silent monitor / whisper / barge (each announced in the recording notice and audited), and forced logout.

### 3.4 Outbound calling & click-to-call

- **Click-to-call**: from any patient record, appointment list or recall list, a user clicks the phone icon → the platform calls the **staff leg first**, then bridges the patient leg → the patient sees the hospital's number, the staff member's personal number is never revealed (number masking), and the call is logged against the patient/encounter. Doctors may use this from mobile.
- **Campaign / list dialling** (`ivr.outbound`): preview or progressive dialling from a list (recall list PE-002, no-show follow-up, health-camp invite, vaccination due OP-013, feedback IVR EN-030). **Predictive dialling is deliberately not offered in Phase 1** (abandoned-call risk and regulatory exposure).
- **DND/NCPR scrubbing**: any list whose purpose is promotional is scrubbed against the DND registry via the provider before dialling; service/transactional calls (appointment reminder for a booked appointment, report ready, follow-up for an existing patient) are exempt but must be tied to a real prior relationship, and the reason is recorded per campaign.
- **Calling window**: outbound restricted to 09:00–20:00 local by default (promotional), 08:00–21:00 for service calls; never on configured holidays; per-patient frequency cap (max 2 outbound attempts/day, 4/week, shared with EN-009 fatigue rules).
- **Outbound IVR survey** (EN-030): plays the survey, collects DTMF, maps keypress → score, writes a `feedback_response` with channel `ivr`.

### 3.5 Recording, consent & retention

1. Recording policy per number/flow: `off`, `agent_leg_only`, `full_call`; when on, the **first prompt of the call states the recording notice** in the selected language ("This call may be recorded for quality and training purposes") — this notice is non-removable when recording is enabled.
2. For flows where recording is optional, the caller may decline (`press 9 to continue without recording`), in which case recording stops and the call proceeds; the decline is recorded as a consent artefact (EN-028).
3. Recordings are stored **encrypted** in object storage (SSE-KMS), referenced by `ivr_recordings`, never in the message log; access requires `ivr.recording.play`, is time-boxed via presigned URL (5 min), and every playback/download is audited as a PHI access.
4. **Retention** default 90 days for routine calls, 1 year for complaint/grievance calls, and case-linked retention for medico-legal calls (flagged, retained with the MRD record); auto-purge job with a pre-purge report. DPDP erasure requests delete the recording and keep the metadata with a tombstone.
5. **Redaction**: agents can mark a segment (e.g. where a card number was spoken) for muting; PCI-sensitive collection is never done on a recorded leg (payment is always by SMS link, EN-010).
6. Transcription (Phase 2, `ivr.speech`) is opt-in per tenant with the same access controls; transcripts inherit the recording's retention.

### 3.6 Exceptions

- **Provider outage / SIP trunk down** → EN-017 circuit opens → the number is failed over to a secondary provider or to a configured mobile hunt group; a banner appears on the agent console and IT is paged. Emergency/ambulance numbers always have a secondary path.
- **All agents busy** → queue with position and estimated wait announcements every 30 s, offer of callback ("keep your place in queue"), then voicemail after the max wait; abandoned calls are auto-listed for call-back with the original ANI.
- **Abandoned/dropped mid-transaction** (e.g. appointment half-booked) → nothing is committed; a partial-transaction record allows an agent to resume ("you were booking a Cardiology slot").
- **Fraud / repeat nuisance caller** → blocklist per number with reason and expiry; blocklisted callers hear a polite message and are not queued.
- **Wrong-number PHI risk** → no personal data is disclosed before authentication; a failed authentication after 3 attempts routes to an agent who must re-verify manually.

## 4. Data Model (schema `engage`, prefix `ivr_`)

- `ivr_providers` — id, hospital_id, connector_id (EN-017), vendor enum(exotel/knowlarity/ozonetel/twilio/myoperator/acefone/kaleyra/sip_pbx), sip_config jsonb, webhook_secret_ref, concurrency_limit, recording_supported, dnd_scrub_supported, status, is_primary, failover_provider_id?.
- `ivr_numbers` — id, hospital_id, branch_id?, e164 citext, label, purpose enum(main/appointments/reports/emergency/billing/marketing/outbound_cid/tollfree), provider_id, entry_flow_id, business_hours jsonb, after_hours enum(voicemail/oncall/callback/close), languages text[], recording_policy enum(off/agent_leg/full), promotional bool, dot_registration_ref, trai_header_ref, concurrency, status; UNIQUE(hospital_id, e164).
- `ivr_flows` / `ivr_flow_versions` — id, hospital_id, key, name, type enum(inbound/outbound_survey/outbound_notice), current_version, status; version: definition jsonb (nodes, edges, prompts per language, API bindings, timeouts, max_retries), published_by/at, immutable, test_report jsonb.
- `ivr_prompts` — id, hospital_id, key, language, mode enum(audio/tts), audio_ref, text, voice, duration_ms, approved_by, active; UNIQUE(hospital_id, key, language, version).
- `ivr_calls` — id uuidv7, hospital_id, branch_id?, direction enum(inbound/outbound/click_to_call/internal), provider_call_id, from_number_masked, from_number_encrypted, to_number_masked, number_id, patient_id?, encounter_id?, matched_by enum(ani/uhid/manual/none), authenticated bool, auth_method enum(otp/dob/none), language, flow_version_id?, queue_id?, agent_user_id?, started_at, answered_at, ended_at, ring_sec, talk_sec, hold_sec, wrap_sec, queue_wait_sec, outcome enum(self_served/agent_handled/abandoned_in_queue/abandoned_in_ivr/voicemail/callback_requested/transferred_external/failed), disposition_code, disposition_note, transfers jsonb, recording_id?, cost, sentiment?, created…; **partitioned monthly**; indexes (hospital_id, started_at desc), (agent_user_id, started_at), (patient_id, started_at desc), (outcome, started_at).
- `ivr_call_steps` — id, call_id, seq, node_key, node_type, input_dtmf, api_call jsonb (endpoint, status, latency), duration_ms, at; used for flow analytics and complaint replay.
- `ivr_recordings` — id, call_id, storage_ref (encrypted), format, duration_sec, size_bytes, consent enum(notice_given/explicit_consent/declined/not_required), legal_hold bool, category enum(routine/complaint/medico_legal), retention_until, purged_at, transcript_ref?, redactions jsonb.
- `ivr_queues` — id, hospital_id, branch_id?, name, skills text[], languages text[], strategy enum(longest_idle/round_robin/skill_priority/sticky_agent), max_wait_sec, sla_target_sec (default 20), overflow_target, callback_enabled, music_ref, active.
- `ivr_agents` — id, user_id, hospital_id, extension, sip_uri?, skills text[], languages text[], max_concurrent, wrap_up_sec, status enum(offline/available/on_call/acw/break), status_since, last_call_id.
- `ivr_agent_state_log` — agent_id, state, from_at, to_at, reason; feeds occupancy/adherence analytics; partitioned monthly.
- `ivr_dispositions` — code, label, category, requires_note, creates enum(none/appointment/complaint/followup/callback), active, sort.
- `ivr_callbacks` — id, call_id?, hospital_id, patient_id?, number_encrypted, requested_at, preferred_window, priority, assigned_agent_id?, attempts, status enum(pending/in_progress/completed/failed/cancelled), outcome_call_id?.
- `ivr_campaigns` — id, hospital_id, name, purpose enum(recall/no_show/health_camp/vaccination/survey/collection), promotional bool, list_ref, dnd_scrubbed_at, scrub_removed_count, flow_version_id?, dial_mode enum(preview/progressive/ivr_broadcast), window jsonb, attempts_policy jsonb, status, connected, answered, completed, opted_out, approved_by.
- `ivr_blocklist` — id, hospital_id, number_hash, reason, added_by, expires_at.
- Retention: call metadata 180 days online (CERT-In) then archived 2 years; recordings per §3.5; agent state logs 1 year; step logs 90 days.

## 5. Business Rules & Validations

- **No personal or clinical data is disclosed before authentication** (OTP to the calling number or DOB match). Report _content_, diagnoses and values are never read out by IVR — status only, with a portal link by SMS.
- **Recording requires a spoken notice** in the caller's language at the start of the call; the notice cannot be disabled while recording is on. Where the flow allows declining, declining must actually stop the recording.
- Recording playback/download requires `ivr.recording.play`, uses a 5-minute presigned URL, and is audited as a PHI access; bulk download is blocked.
- **Retention is enforced by job, not by habit**: routine 90 days, complaint 1 year, medico-legal on legal hold; purge produces a report, and DPDP erasure removes audio while retaining a metadata tombstone.
- **Promotional outbound calls** must be DND/NCPR-scrubbed through the provider before dialling, use a registered promotional number, and stay inside the 09:00–20:00 window; service calls are exempt from DND but must be tied to an existing appointment/visit relationship, and the justification is stored on the campaign.
- **Frequency caps are shared with EN-009**: max 2 outbound attempts/day and 4/week per patient across voice+SMS+WhatsApp; a patient who has opted out of contact is never dialled for non-clinical reasons.
- **Number masking is mandatory** on click-to-call: staff personal numbers are never presented to patients, and patient numbers are masked in the agent UI unless `ivr.number.read` is held.
- Dispositions are mandatory; a call cannot be closed without one, and after-call-work is time-capped. Missing dispositions block the agent from receiving the next call after a grace period.
- **Emergency/ambulance flows never gate on authentication**, never queue behind non-emergency calls, and always have a failover path (secondary provider or mobile hunt group).
- Payment card details must never be collected on a call; payment is always by SMS link (EN-010) — there is no DTMF card-capture node in the builder.
- Flow versions are immutable once published; a change creates a new version, and every call stores the version it ran so behaviour can be reconstructed.
- Blocklisting a number requires a reason and an expiry; emergency numbers cannot be blocklisted.
- Barge/whisper/monitor by a supervisor is audited and, where recording is on, is audible in the recording.

## 6. API Surface (`/api/v1/ivr`)

| Method          | Path                                                                             | Purpose                                   | Permission                            | Notes                             |
| --------------- | -------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------- | --------------------------------- |
| GET/POST/PATCH  | /providers ; /numbers                                                            | telephony config                          | `ivr.config.manage` (IT Admin)        | secrets write-only                |
| GET/POST/PATCH  | /flows ; /flows/:id/versions                                                     | flow builder CRUD                         | `ivr.flow.manage`                     | draft until publish               |
| POST            | /flows/:id/publish \| /test-call                                                 | publish / place a test call               | `ivr.flow.publish`                    | version pinned                    |
| GET/POST        | /prompts ; POST /prompts/:id/approve                                             | prompt audio per language                 | `ivr.prompt.manage`                   | approval before use               |
| POST            | /webhooks/:provider/voice \| /status \| /recording                               | provider callbacks (call control, events) | signature-verified public             | idempotent, via EN-017            |
| POST            | /calls/:id/authenticate                                                          | OTP/DOB verification inside a flow        | service token                         | rate-limited, 3 attempts          |
| GET             | /calls?direction&agent&disposition&from&to&patient                               | call log                                  | `ivr.call.read`                       | cursor; numbers masked            |
| GET             | /calls/:id                                                                       | detail incl. node path & transfers        | `ivr.call.read`                       |                                   |
| POST            | /calls/:id/disposition                                                           | wrap-up                                   | `ivr.call.handle`                     | mandatory code                    |
| GET             | /calls/:id/recording-url                                                         | time-boxed playback URL                   | `ivr.recording.play`                  | audited, 5-min presign            |
| POST            | /calls/:id/recording/redact                                                      | mute a segment                            | `ivr.recording.manage`                | audited                           |
| POST            | /click-to-call {patientId, staffUserId, refType, refId}                          | masked bridged call                       | `ivr.clicktocall`                     | staff leg first                   |
| GET/POST        | /agents ; POST /agents/me/state                                                  | agent registry & state                    | `ivr.agent.manage` / `ivr.agent.self` | WS `ivr:agent`                    |
| GET             | /queues ; GET /queues/live                                                       | queue config & live stats                 | `ivr.queue.read`                      | WS `ivr:queue` <1 s               |
| POST            | /queues/:id/monitor \| /whisper \| /barge                                        | supervisor tools                          | `ivr.supervisor`                      | audited                           |
| GET/POST        | /callbacks ; POST /callbacks/:id/claim \| /complete                              | callback list                             | `ivr.call.handle`                     |                                   |
| GET/POST/PATCH  | /campaigns ; POST /campaigns/:id/scrub \| /start \| /pause                       | outbound campaigns                        | `ivr.campaign.manage` (+ approval)    | DND scrub required if promotional |
| GET/POST/DELETE | /blocklist                                                                       | nuisance numbers                          | `ivr.blocklist.manage`                | reason + expiry                   |
| GET             | /analytics/queue ; /analytics/agents ; /analytics/flows ; /analytics/abandonment | reports                                   | `ivr.report.read`                     | read models                       |
| POST            | /ivr/survey/response                                                             | DTMF survey result → EN-030               | service token                         | maps keypress to score            |

## 7. Domain Events (outbox)

- `ivr.call.started|answered|queued|abandoned|completed` → EN-001 analytics, agent wallboard, PE-002 (missed-call follow-up).
- `ivr.call.self_served` (with transaction type) → OP-001/OP-004/EN-006 to attribute the channel.
- `ivr.appointment.booked|rescheduled|cancelled` → OP-001, SMS confirmation via EN-009.
- `ivr.callback.requested|completed` → agent task list, EN-037.
- `ivr.complaint.raised` → NC-032 with the recording reference.
- `ivr.recording.created|played|purged|legal_hold_set` → EN-024 audit, DPO register.
- `ivr.agent.state_changed` → wallboard, workforce analytics.
- `ivr.queue.sla_breached` / `ivr.abandonment.threshold_exceeded` → supervisor alert (EN-037).
- `ivr.provider.circuit_opened|failover_activated` → IT on-call.
- `ivr.campaign.completed` → marketing analytics, EN-030 for survey campaigns.
- Consumes: `appointment.created|cancelled|reminder_due`, `lab.report.released`, `rad.report.finalised`, `queue.token.called`, `bill.finalized`, `patient.no_show`, `feedback.invitation.due`, `ambulance.request.created`.

## 8. Screens (UI)

- **Agent Console** (desktop, dual-pane, headset): left = softphone strip (state selector, incoming call card with ANI/queue/language/IVR path, answer/hold/transfer/conference/hangup, mute, timer); centre = **patient-360 pop** (banner with photo/UHID/age/allergies, tabs: Appointments, Reports, Bills, Complaints, Call history with previous dispositions); right = action rail (Book appointment, Reschedule, Register patient, Raise complaint, Send SMS template, Schedule callback, Add note). Wrap-up panel with disposition picker appears on hangup and blocks the next call until submitted. Shortcuts: `F1` answer, `F2` hangup, `F3` hold, `F4` transfer, `Ctrl+B` book, `Ctrl+D` disposition, `Ctrl+/` search patient. Screen pop must render < 1 s from ring.
- **Supervisor Wallboard** (desktop + TV EN-018): calls waiting, longest wait, service level (% answered < 20 s), abandonment %, agents by state with timers, live call list with monitor/whisper/barge, alerts when SLA breaches. Dark theme for wall display, auto-refresh via WS.
- **IVR Flow Builder** (desktop, canvas): drag nodes, connect edges, per-node properties (prompt per language, timeout, retries, API binding with a response mapper), validation panel (unreachable nodes, missing translations, no `0` escape, no path without hang-up), version history with diff, `Test call to my mobile` button. Shortcuts `Ctrl+S` save, `Ctrl+T` test, `Ctrl+P` publish request.
- **Prompt Library** (desktop): key, language matrix with recorded/missing status, upload/record, TTS preview, approval workflow.
- **Call Log** (desktop): virtualised table (time, direction, number masked, patient, queue, agent, duration, outcome, disposition, recording icon), filters, row drawer with the IVR node path timeline, transfers, and a player with waveform and speed control (permission-gated); export is metadata-only.
- **Callback List** (desktop/phone): pending callbacks with priority, preferred window, attempts, claim/complete actions.
- **Campaign Console** (desktop, Marketing): list upload/segment, DND-scrub summary ("2,341 loaded, 187 removed as DND"), dial window, progress with connect/answer rates, pause/stop.
- **Number & Compliance Settings** (desktop, IT/Admin): numbers with purpose, business hours, after-hours behaviour, recording policy, promotional flag with the compliance checklist.
- **Click-to-call widget** (embedded in patient chart, appointment list, recall list — desktop/tablet/phone): one icon, confirmation modal showing "your number stays hidden", call state inline.
- Empty/error states: "Telephony provider unreachable — calls are being routed to the front-desk hunt group", "No agents available — callers are being offered a callback", "This flow has no `0` escape to an agent and cannot be published".

## 9. Integrations

- **Cloud telephony**: Exotel, Knowlarity/Ozonetel, MyOperator, Acefone/Servetel, Kaleyra (India, DoT-licensed) and Twilio (global) — REST call-control APIs + webhooks (call started/answered/DTMF/recording ready/status) through EN-017 with signature verification and DLQ.
- **On-prem SIP**: Asterisk/FreeSWITCH/FreePBX/3CX/Avaya/Cisco via SIP trunk with SRTP and AMI/ARI or ESL event bridges; WebRTC softphone in the console via the provider's JS SDK or a SIP.js gateway.
- **EN-009** for the SMS legs (OTP, appointment confirmation, report link, payment link) using DLT-registered templates; **EN-010** for payment links (never DTMF card capture).
- **OP-001** appointments API (slot search, hold, book, reschedule, cancel), **OP-004/OP-008** report-status API (status only), **EN-006** queue position, **OP-005/IP-005** dues, **NC-032** complaints, **PE-002** recall lists, **EN-030** IVR surveys, **NC-013/TR-009** ambulance dispatch.
- **DND/NCPR scrubbing** through the provider's TRAI-integrated API; **EN-042** not involved; **EN-021** (CCTV) unrelated but shares the incident timeline for security calls.

## 10. Reports & Analytics

- **Volume & service level**: calls by hour/day/number/branch, answered vs abandoned, service level (% answered within 20 s), average speed of answer, average handle time (talk + hold + wrap), longest wait, repeat-caller rate.
- **Self-service effectiveness**: containment rate (% resolved in IVR without an agent), per-transaction success (appointments booked by IVR vs attempted), node-level drop-off funnel, language distribution, average IVR duration, "pressed 0 immediately" rate (a signal the menu is wrong).
- **Agent performance**: calls handled, AHT, occupancy, adherence, wrap time, disposition mix, quality scores from call reviews, callbacks completed.
- **Outcome value**: appointments booked/rescheduled/cancelled by phone, no-shows recovered, complaints registered, revenue attributable to phone-booked appointments, campaign connect and conversion rates.
- **Abandonment analysis** by queue, hour and wait band with the call-back recovery rate; missed-call follow-up compliance.
- **Compliance**: recording consent captured %, recordings past retention, DND-scrub counts, calls outside permitted windows (should be zero), supervisor barge log.
- Read models: `analytics.mv_ivr_hourly`, `analytics.mv_ivr_agent_daily`, `analytics.mv_ivr_flow_funnel`.

## 11. Notifications

- **Agents/supervisors**: SLA breach, queue depth threshold, agent stuck in ACW, callback overdue, abandoned-call spike.
- **IT**: provider circuit open, SIP trunk registration failure, recording storage failure, webhook signature failures.
- **Patients (SMS/WhatsApp via EN-009)**: appointment confirmation/cancellation after an IVR transaction, report-ready link, payment link, "we missed your call — reply or we'll call back", callback confirmation.
- **Marketing**: campaign completed with connect/conversion summary; DND-scrub removal count.
- **DPO**: monthly recording retention/purge report; any legal hold placed.

## 12. Permissions (RBAC keys)

`ivr.config.manage` (IT Admin 56) · `ivr.flow.manage` / `ivr.flow.publish` (IT Admin + Hospital Admin 2) · `ivr.prompt.manage` (Marketing 55, Admin) · `ivr.call.read` (Agents 25 own + Front Office 24 branch, Supervisors all) · `ivr.call.handle` (Call Centre Agent 25, Front Office 24) · `ivr.number.read` (reveal masked numbers — Front Office lead, audited) · `ivr.recording.play` (Supervisor, Quality 54, DPO 57 — audited) · `ivr.recording.manage` (redaction, legal hold — Quality, DPO) · `ivr.clicktocall` (clinical + front-office roles) · `ivr.agent.manage` (Supervisor) · `ivr.agent.self` (agents) · `ivr.queue.read` · `ivr.supervisor` (monitor/whisper/barge — Call Centre Lead, Quality) · `ivr.campaign.manage` (Marketing 55, Admin approval) · `ivr.blocklist.manage` (Admin, Security) · `ivr.report.read` (Admin, Supervisor, Quality, Auditor 58).

## 13. Non-functional

- **Volumes (2000-bed, 5000 OP/day)**: 1500–2500 inbound calls/day with a 10:00–12:00 peak of ~250 calls/hour; 20–40 concurrent channels; 25–40 agents at peak; 500–1500 outbound calls/day for recalls and campaigns.
- **Latency**: screen pop < 1 s from ring; IVR API lookups (report status, token, slots) p95 < 300 ms so the caller hears no dead air; DTMF response < 200 ms; call-event webhook to log write < 2 s.
- **Availability**: telephony is a patient-safety-adjacent channel — the emergency number must have a secondary provider or PSTN failover with < 30 s switchover; the agent console degrades to "log calls manually" if call control fails but call logging continues.
- **Storage**: recordings ≈ 0.5 MB/min (Opus/mono 8 kHz) ⇒ ~2500 calls/day × 3 min ≈ 3.7 GB/day at full recording; lifecycle to cold storage at 30 days and purge per retention; call metadata ≈ 1 M rows/year, partitioned monthly.
- **Security**: SRTP for media, TLS for SIP signalling, recordings encrypted with SSE-KMS, presigned playback URLs expiring in 5 minutes, no phone numbers in logs or URLs (hashed), webhook signature verification, per-number rate limits against toll fraud, and an anomaly alert on unusual international/premium-rate dialling.
- **Accessibility & i18n**: prompts in `en/hi/ta/te/ml/kn/mr/bn` (professionally recorded, TTS only for dynamic values), slower-speech option (`press *` to repeat), DTMF-only navigation (no speech required), TTY/relay-friendly transfer path, and agent console fully keyboard-operable with WCAG 2.2 AA contrast.
- **Offline/on-prem**: with an on-prem SIP PBX, inbound routing, queues and recording continue during a WAN outage; HMS lookups degrade to "an agent will assist you" and the agent console shows cached patient search only.

## 14. Acceptance Criteria

1. **Given** a patient calls the main number from a registered mobile, **when** the IVR identifies the ANI and the caller selects report status, **then** an OTP is sent to that number and no personal data is disclosed until the OTP is verified.
2. **Given** an authenticated caller with a completed lab report, **when** they select report status, **then** the IVR announces only that the report is ready (never values or diagnoses) and sends a portal link by SMS using a DLT-registered template.
3. **Given** a caller books an appointment through the IVR, **when** they confirm the slot, **then** an appointment is created in OP-001 with source `ivr`, an SMS confirmation is sent, and the call log links to the appointment.
4. **Given** recording is enabled on a number, **when** any call connects, **then** the recording notice is played in the caller's selected language before any other prompt, and the notice cannot be disabled while recording is on.
5. **Given** a caller declines recording where the flow permits, **when** they press the decline key, **then** recording stops immediately, the call continues, and the decline is stored as a consent artefact.
6. **Given** an agent receives a queued call, **when** the phone rings, **then** the patient-360 screen pop renders within 1 second showing the IVR path that led to the escalation.
7. **Given** an agent ends a call, **when** they attempt to go available again, **then** the system requires a coded disposition first, and after-call-work is capped at the configured duration.
8. **Given** a doctor uses click-to-call from a patient chart, **when** the call bridges, **then** the patient's phone displays the hospital number, the doctor's personal number is never revealed, and the call is logged against the patient and encounter.
9. **Given** a promotional outbound campaign, **when** the list is loaded, **then** DND/NCPR scrubbing runs before any dialling, the removed count is displayed, and dialling is blocked outside the 09:00–20:00 window.
10. **Given** a caller waits beyond the queue's maximum wait, **when** the threshold is reached, **then** they are offered a callback that preserves their place, and if they hang up first the abandoned call appears on the call-back list with the original number.
11. **Given** the telephony provider's circuit opens, **when** a call arrives on the emergency number, **then** it fails over to the secondary path within 30 seconds and IT is paged.
12. **Given** a user without `ivr.recording.play`, **when** they open a call record, **then** metadata is visible but no player or download link is rendered.
13. **Given** a routine recording older than 90 days, **when** the retention job runs, **then** the audio is purged, the metadata remains with a purge timestamp, and complaint/medico-legal recordings under legal hold are not purged.
14. **Given** a flow version is published, **when** a call runs, **then** the call row stores that exact version, and a later flow change does not alter how the historical call is reconstructed.
15. **Given** a flow with no `0`-to-agent escape or with a language variant missing a prompt, **when** publish is attempted, **then** validation blocks it and lists the offending nodes.
16. **Given** a supervisor barges into a live call, **when** the action occurs, **then** it is audited with actor and timestamp and, where recording is on, is captured in the recording.
17. **Given** an abandoned mid-transaction appointment booking, **when** the caller hangs up, **then** no partial appointment is committed and a resumable partial-transaction record is available to an agent.

## 15. Enhancements / Later phases

- **Speech recognition & natural-language IVR** (ASR in Indian languages) replacing deep DTMF menus; speech-to-text transcripts with keyword search and automatic disposition suggestion (AI-003).
- **Omnichannel console**: voice + WhatsApp + web chat + email in one agent inbox with a unified interaction history (converges with EN-009/EN-032/AI-001).
- **Real-time agent assist**: live transcription with next-best-action, policy prompts, and automatic call summarisation into the disposition note.
- **Sentiment & quality auto-scoring** of recordings, replacing manual sampling for call QA.
- **Voicebot for outbound reminders** with confirm/cancel by voice, and appointment no-show prediction-driven calling priority.
- **Workforce management**: forecast-based agent scheduling with adherence tracking (links to NC-030).
- **CTI for on-prem PBX** with unified presence across desk phones and softphones; video escalation to OP-018 telemedicine from a phone call.
- **Video IVR / WhatsApp voice** for smartphone callers, and callback via the patient app (OP-020).

## 16. Open Questions for the Hospital

1. Which **telephony provider** is in use or preferred (Exotel / Knowlarity / Ozonetel / Twilio / on-prem PBX), and is the DoT licensing and number inventory already in place?
2. What **numbers** exist today (main, appointments, emergency, toll-free, per-branch), and which should become IVR entry points?
3. Is **call recording** wanted, on which numbers, and what retention does legal/DPO require (routine vs complaint vs medico-legal)?
4. Which **self-service transactions** must the IVR support at go-live (report status, appointment booking, token position, dues, ambulance, complaints), and which are deliberately agent-only?
5. What **authentication** is acceptable before disclosing appointment or report status — OTP to the calling number, DOB, or agent verification only?
6. How many **agents**, in which shifts and languages, and what is the target service level (default: 80 % answered within 20 s)?
7. What are the **business hours** per number and the after-hours behaviour (voicemail, on-call transfer, callback)?
8. Which **languages** must prompts be recorded in, and who provides the professional voice recordings?
9. Are **outbound campaigns** required (recalls, health camps, vaccination), are they promotional or service in nature, and who approves them?
10. What **disposition codes** does the hospital want, and should any disposition automatically create a complaint or follow-up task?
11. Should click-to-call be available to **doctors and nurses** from clinical screens, and is number masking a hard requirement (assumed yes)?
12. Is there an existing CRM/call-centre system whose **call history must be migrated** (EN-036), and does it need to run in parallel during cutover?
13. What is the escalation path for the **emergency/ambulance line** if the primary provider fails, and who must be notified within how many minutes?
