# EN-009 — SMS & WhatsApp Integration (Gateway Adapters, DLT Registration, Template Master, WhatsApp Cloud API Templates, Triggers, Delivery Webhooks, DND, Opt-in Ledger, Campaigns, Cost Tracking, Fallback)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Module ID       | EN-009                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase           | 1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Depends on      | EN-037 (Notification Centre — routing/escalation; EN-009 is the SMS/WhatsApp channel provider), EN-032 (email channel sibling), EN-017 (integration hub, DLQ), EN-028 (consent ledger — DPDP), EN-007 (settings/secrets), EN-024 (audit), OP-001 (patient contacts, language), NC-026 (marketing campaigns), EN-030 (surveys), PE-002 (follow-up reminders), EN-006 (queue messages), OP-005/EN-010 (receipts/payment links), OP-004 (reports), NC-009 (cost accounting), AI-001 (chatbot inbound) |
| Feature flag    | `module.messaging.enabled` (sub: `messaging.whatsapp`, `messaging.campaigns`, `messaging.inbound`, `messaging.rcs`)                                                                                                                                                                                                                                                                                                                                                                                |
| Primary roles   | IT Admin (56 — gateways/templates), Marketing/CRM (55 — campaigns), Hospital Admin (approve templates/costs)                                                                                                                                                                                                                                                                                                                                                                                       |
| Secondary roles | Front office (send ad-hoc), Call centre, all modules (system triggers), Privacy Officer (opt-in/DND), Patient (recipient/replies), Auditor                                                                                                                                                                                                                                                                                                                                                         |
| Regulatory      | TRAI TCCCPR 2018 & DLT (entity ID, header/sender ID, content template ID, consent templates, scrubbing, promotional 9AM–9PM, DND/NCPR), TRAI 2024 traceability (URL whitelisting, message hash), Meta WhatsApp Business Platform policies (template categories utility/marketing/authentication, 24-h customer service window, opt-in, quality rating), DPDP Act/Rules 2025 (consent, purpose, opt-out, no PHI beyond need), IT Act (OTP security), NABH (patient communication records)           |

## 1. Purpose

EN-009 is the messaging channel service: pluggable SMS gateway adapters (MSG91, Twilio, Gupshup, Kaleyra, Exotel, custom HTTP), WhatsApp Cloud API (Meta) or BSP adapters (Gupshup/Twilio/MSG91), DLT-compliant template master with variables and language variants, WhatsApp template lifecycle (create/submit/approve/quality), event-driven triggers with per-hospital rules, delivery status webhooks, DND and opt-in/opt-out ledger tied to DPDP consent, campaigns with segmentation and throttling, cost tracking per message/module, and fallback rules (WhatsApp → SMS → voice/IVR EN-033) — for ~30k messages/day.

## 2. Users & Jobs-to-be-done

- **IT Admin**: configure gateway credentials (encrypted), DLT entity/headers, WhatsApp Business Account (WABA)/phone number, webhooks; monitor delivery, failures, cost; manage templates and mapping to DLT template IDs.
- **Hospital Admin/Marketing**: approve templates and campaign budgets; run campaigns (health camps, reminders); view engagement.
- **Front office/Call centre**: send ad-hoc template messages (report ready, appointment change) from patient screens; view conversation history.
- **Modules** (system): fire triggers (OTP, token, appointment, report ready, bill/receipt, payment link, discharge, follow-up, pre-auth status, feedback).
- **Patient**: receive, reply (WhatsApp buttons: confirm/cancel/"I'm here"), opt-out.
- **Privacy Officer**: opt-in evidence, DND compliance, complaint handling.

## 3. Core Workflows

### 3.1 Gateway & number setup

1. IT adds **provider account**: type (sms/whatsapp), vendor adapter, credentials (auth key/token, stored via Vault/pgcrypto), sender headers (DLT: 6-char headers per use e.g. `VIMHMS`, transactional/service-explicit/promotional), DLT entity id, PE-TM chain binding, per-route (OTP/transactional/promotional) route ids, rate limits, priority, cost per unit (SMS per segment/DLT charge; WhatsApp per conversation category/country), health check → `msg_providers` → Event `messaging.provider.configured`.
2. WhatsApp: WABA id, phone number id, display name, business verification status, quality rating polling, webhook subscription (messages, statuses, template status), Meta template namespace; multiple numbers per branch.
3. Routing policy: default provider per channel/message class per branch; failover order; cost-based routing (enhancement).

### 3.2 Template master (SMS DLT + WhatsApp)

1. Admin creates **template**: key (`otp_login`, `appointment_confirmed`, `token_issued`, `queue_called`, `report_ready`, `receipt`, `payment_link`, `discharge_summary_ready`, `followup_reminder`, `preauth_status`, `feedback_request`, `camp_invite`…), channel(s), category (authentication/utility/service/marketing), language variants (`en, hi, ta, te, ml, kn, mr, bn`), body with variables `{{1}}…` (typed: name, date, amount, url, code) with sample values, header/footer/buttons (WhatsApp: quick reply, URL, call; media header) → `msg_templates` (versioned).
2. **DLT**: paste DLT template id + registered content; system **validates** rendered text matches DLT content (variable placeholders `{#var#}` count/positions; TRAI 2024 max variable length 30 chars); URLs must be whitelisted on DLT (store whitelist); PE-TM chain check; unregistered → cannot send (hard stop) → status `dlt_registered`.
3. **WhatsApp**: submit via Cloud API (`POST /message_templates`) → status webhook (approved/rejected/paused/disabled + reason, quality) → only approved templates sendable; category changes tracked (cost); marketing templates require opt-in class `marketing`.
4. Approval workflow (EN-038): content owner → Hospital Admin approve → active from date; audit; template usage counts.

### 3.3 Send pipeline (event → message)

1. Module/EN-037 requests `Messaging.send({templateKey, to: patient/user/phone, vars, channelPreference?, hospital, branch, module, ref, class, ttl, priority})` → **policy checks**: recipient resolution (patient primary mobile, verified flag, country code E.164), language selection (patient preference → hospital default), **consent/opt-in** (EN-028 ledger: transactional always allowed unless legally opted out; service-explicit needs consent; promotional needs marketing opt-in + DND scrub + 9AM–9PM window), do-not-disturb quiet hours per hospital for non-critical, dedupe (same template+recipient+ref within window), rate limits, PHI minimisation (no diagnosis in SMS; report links tokenised) → **channel selection**: WhatsApp if number has WA opt-in and template approved (utility) else SMS; OTP always SMS (+ WhatsApp authentication template optional) → job queued (BullMQ, priority lanes: otp > critical > transactional > campaign) → adapter call → provider message id → `msg_messages` status `sent` → Event `messaging.message.sent`.
2. **Delivery webhooks** (per provider) → status `delivered/read/failed/undelivered/expired` with error codes → normalised → Event `messaging.message.delivered|failed`; **fallback**: WhatsApp failed/undelivered (not on WA, blocked) or not delivered within N min for critical → auto SMS with the SMS variant; SMS failed → retry other provider once → voice call (EN-033) for critical (e.g. critical lab value to doctor per OP-004 escalation).
3. TTL: message expired before send (e.g. queue call after served) → dropped with status `expired`.
4. Batch/scheduled sends (reminders at 08:00) via worker with throttling per provider limits.

### 3.4 Inbound & conversations (`messaging.inbound`)

- WhatsApp inbound (text/buttons/media) → webhook → `msg_conversations`/`msg_inbound` → routed: button payloads to modules (appointment confirm/cancel/reschedule → OP-001; "I'm here" → EN-006; feedback score → EN-030; STOP/UNSUBSCRIBE → opt-out ledger), free text → AI-001 chatbot (if enabled) or call-centre inbox (NC-026/EN-033) with 24-h session window tracking (free-form replies allowed only inside window; else template); media (photos of Rx/reports) saved to patient documents with consent prompt. SMS inbound (long code/short code) for STOP keywords.

### 3.5 Opt-in / opt-out & DND

- Ledger entries (`msg_optins`, mirrored in EN-028): channel, class (transactional/service/marketing), source (registration form, WhatsApp opt-in reply, portal toggle, campaign form, kiosk), timestamp, evidence (IP/UA/agent id/screenshot text), expiry; opt-out via STOP reply/portal/desk; **DND scrub** for promotional via provider DLT scrubbing (or NCPR file); block list (bounced/invalid numbers) with auto-clean; patient's communication preferences on OP-001 profile (language, preferred channel, quiet hours).

### 3.6 Campaigns (`messaging.campaigns`)

1. Marketing creates campaign: audience (segment builder over patient attributes with consent filter — e.g. diabetics due for HbA1c, camp radius, corporate employees), template (marketing WA / promotional SMS), schedule/window, throughput cap, budget cap, A/B variants, tracking links (short URL with click tracking) → approval (Admin) → send → dashboard (sent/delivered/read/clicked/replied/opt-outs) → cost.
2. Guardrails: promotional only 9AM–9PM, DND scrubbed, marketing opt-in only, frequency cap per patient (e.g. ≤ 2/week), suppression lists (deceased, do-not-contact, MLC), NC-026 lead attribution.

### 3.7 Cost tracking

- Each message computes cost (SMS segments × rate + DLT; WhatsApp conversation category pricing, first message in 24-h window opens conversation) → `msg_costs` rolled up by module/branch/campaign/day; budget alerts; provider invoice reconciliation upload; monthly cost report to NC-009.

### 3.8 Exceptions

- Provider outage → circuit breaker → failover provider; queue holds; IT alert; OTP degrade to email/voice.
- Template rejected/paused by Meta → fallback SMS variant auto-enabled; admin notified.
- Wrong number/complaint → mark number `do_not_contact`, DPO log.

## 4. Data Model (schema `engage`, prefix `msg_`)

- `msg_providers` — id, hospital_id, branch_id?, channel (sms/whatsapp/rcs), vendor, credentials_ref (encrypted), sender_ids jsonb, dlt jsonb (entity_id, headers[], pe_tm), waba jsonb (waba_id, phone_number_id, display, quality), routes jsonb, rate_limit, cost_config jsonb, priority, status, health jsonb.
- `msg_templates` — id, hospital_id, key, name, channel, category (authentication/utility/service_explicit/transactional/promotional/marketing), class (critical/transactional/service/promotional), owner_module, ttl_sec, versions → `msg_template_versions` (template_id, version, lang, body, header jsonb, footer, buttons jsonb, variables jsonb [{idx, name, type, max_len, sample}], dlt_template_id, dlt_header, dlt_content_hash, wa_template_name, wa_status, wa_quality, wa_rejection_reason, status (draft/pending_approval/active/retired), approved_by/at, effective_from). UNIQUE(hospital_id, key, version, lang).
- `msg_url_whitelist` — hospital_id, domain/url_pattern, dlt_registered bool.
- `msg_messages` — id, hospital_id, branch_id, channel, direction (out/in), template_key, template_version_id, lang, to_e164, recipient_type (patient/user/external), recipient_id, provider_id, provider_msg_id, class, module, ref_type/ref_id (visit/bill/order…), campaign_id?, body_rendered (encrypted; PHI-minimised), vars_hash, status (queued/sent/delivered/read/failed/undelivered/expired/dropped_policy), error_code, error_text, attempts, fallback_of_id, cost_amount, cost_currency, segments, conversation_id, scheduled_at, sent_at, delivered_at, read_at, created_at; partitioned monthly; index (hospital_id, created_at desc), (recipient_id, created_at desc), (provider_msg_id).
- `msg_events` — message_id, event, at, raw jsonb (webhook), provider_status; partitioned monthly.
- `msg_optins` — id, hospital_id, patient_id/phone_e164, channel, class, status (opted_in/opted_out/unknown), source, evidence jsonb, consent_id (EN-028), at, expires_at; index (phone_e164, channel, class).
- `msg_block_list` — phone_e164, reason (invalid/bounced/complaint/do_not_contact), added_by, at.
- `msg_conversations` — hospital_id, phone_e164, patient_id?, channel, window_expires_at, assigned_to (agent), status; `msg_inbound` (message_id, payload jsonb, media_file_id, intent, routed_to, handled_at).
- `msg_triggers` — id, hospital_id, event_type, template_key, condition jsonb, channel_policy (wa_then_sms/sms_only/wa_only), delay_sec, active, module.
- `msg_campaigns` — id, hospital_id, name, template_version_id, segment jsonb, schedule jsonb, window, throughput, budget_cap, status, approved_by, stats jsonb, created_by; `msg_campaign_recipients` (campaign_id, patient_id, phone, status, message_id, clicked_at, replied_at, opted_out_at).
- `msg_costs_daily` — hospital_id, branch_id, date, channel, provider_id, module, campaign_id?, count, segments, amount; `msg_provider_invoices` (period, file_id, amount, reconciled_delta).
- `msg_short_links` — code, target_url, message_id, clicks, expires_at.

### 4.1 Seeded template catalogue (system defaults; hospital registers DLT/WA equivalents)

| Key                                                                                        | Class            | Channel(s)                    | Owner module         | Trigger event                        | Variables                               |
| ------------------------------------------------------------------------------------------ | ---------------- | ----------------------------- | -------------------- | ------------------------------------ | --------------------------------------- |
| `otp_login` / `otp_portal` / `otp_report`                                                  | critical/auth    | SMS (+WA auth)                | EN-007/PE-001/EN-012 | on request                           | code, ttl                               |
| `appointment_confirmed` / `_reminder_24h` / `_reminder_2h` / `_rescheduled` / `_cancelled` | transactional    | WA→SMS                        | OP-001               | appointment.*                        | name, doctor, date, time, branch, link  |
| `token_issued` / `queue_n_away` / `queue_called`                                           | transactional    | WA→SMS (called: SMS fallback) | EN-006               | queue.token.*                        | token, doctor/room, eta, link           |
| `report_ready_lab` / `report_ready_rad`                                                    | transactional    | WA (doc/link)→SMS (link)      | OP-004/OP-008        | lab.result.final / rad.report.signed | name, link/OTP                          |
| `receipt` / `bill_summary` / `payment_link` / `refund_processed`                           | transactional    | WA→SMS                        | OP-005/NC-001/EN-010 | bill.finalized, payment.*            | amount, receipt no, link, ARN           |
| `admission_welcome` / `discharge_summary_ready` / `discharge_followup`                     | transactional    | WA→SMS                        | IP-001/IP-002/PE-002 | ip.*                                 | name, ward, date, link                  |
| `preauth_submitted` / `preauth_approved` / `preauth_query` / `final_auth_balance`          | transactional    | WA→SMS                        | EN-002               | insurance.*                          | payer, amount, docs                     |
| `followup_reminder` / `medication_reminder` / `vaccination_due`                            | service_explicit | WA→SMS                        | PE-002/OP-013        | schedules                            | name, date, doctor                      |
| `feedback_request` / `nps_survey`                                                          | service_explicit | WA (buttons)→SMS link         | EN-030               | visit closed +2 h                    | link                                    |
| `critical_alert_doctor` / `oncall_page`                                                    | critical         | SMS + WA + push               | OP-004/EN-037        | lab.result.critical                  | patient initials, test, value, callback |
| `camp_invite` / `health_package_offer` / `birthday_wish`                                   | marketing        | WA marketing / promo SMS      | NC-026               | campaigns                            | name, offer, link                       |
| `abha_card` / `abdm_consent_reminder`                                                      | transactional    | SMS/WA                        | EN-011               | abdm.*                               | link                                    |
| `visitor_pass` / `gate_pass_otp`                                                           | transactional    | SMS/WA                        | EN-015               | pass issued                          | pass no, hours                          |

## 5. Business Rules & Validations

- No send without an active template version for the channel/language (falls back to `en`); SMS body must equal DLT-registered content with variables ≤ 30 chars each; URLs only from whitelist; sender header must match template category.
- Class rules: `critical/transactional` (OTP, token, appointment, report ready, bill, discharge, critical alerts) sendable 24×7 to any verified number without marketing consent; `service_explicit` requires recorded consent (registration form default opt-in with clear notice); `promotional/marketing` requires explicit marketing opt-in + DND scrub + 9AM–9PM + frequency cap.
- WhatsApp free-form (non-template) only within 24-h window of last inbound; otherwise template.
- OTP: 6 digits, expiry 5 min, max 3 sends/10 min/number, never logged in plain, dedicated OTP route.
- PHI minimisation: templates carrying diagnosis/results content are prohibited by lint (`phi_level=none` on SMS; WhatsApp may carry document with patient consent — report PDFs sent as document only if `report_delivery_whatsapp` consent and password/OTP-protected per policy).
- Dedupe window per template (default 10 min) keyed by (template, recipient, ref).
- Fallback: WA `failed`/`undelivered` → SMS immediately; WA `sent` but not `delivered` in 5 min for critical class → SMS; cost of fallback tracked separately.
- Retention: message metadata 2 years; rendered bodies 90 days (encrypted) then purged (except legal hold); webhooks raw 30 days; opt-in evidence retained as long as relationship + 3 years.
- Number validation: E.164 with default country from hospital; invalid → blocked; landline SMS blocked; international pricing check.

## 6. API Surface (`/api/v1/messaging`)

| Method          | Path                                                                                                      | Purpose                                      | Permission                                                              | Notes                               |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------- |
| GET/POST/PATCH  | /providers ; /providers/:id ; POST /providers/:id/test                                                    | providers                                    | messaging.provider.configure                                            | secrets masked                      |
| GET/POST/PATCH  | /templates ; /templates/:id/versions ; POST /versions/:id/submit-approval                                 | approve                                      | retire ; POST /versions/:id/wa-submit ; POST /versions/:id/dlt-validate | templates                           | messaging.template.configure / messaging.template.approve |     |
| GET/PUT         | /url-whitelist                                                                                            | DLT URLs                                     | messaging.provider.configure                                            |                                     |
| POST            | /send                                                                                                     | send template message (system/staff)         | messaging.message.send (module scoped)                                  | Idempotency-Key; returns message id |
| POST            | /send/batch                                                                                               | batch (reminders)                            | messaging.message.send                                                  | throttled                           |
| GET             | /messages?recipient&template&status&from&to ; GET /messages/:id                                           | log                                          | messaging.message.read (PHI: audited)                                   | cursor                              |
| POST            | /messages/:id/resend                                                                                      | resend/fallback manual                       | messaging.message.send                                                  |                                     |
| POST            | /webhooks/:provider (statuses/inbound/template status)                                                    | provider callbacks                           | signature-verified public                                               | idempotent by provider msg id       |
| GET/POST        | /optins ; POST /optins/opt-out ; GET /optins/status?phone&class                                           | consent ledger                               | messaging.optin.manage / read                                           | mirrors EN-028                      |
| GET/POST/DELETE | /block-list                                                                                               | blocks                                       | messaging.optin.manage                                                  |                                     |
| GET/POST/PATCH  | /triggers                                                                                                 | event → template rules                       | messaging.trigger.configure                                             |                                     |
| GET             | /conversations ; GET /conversations/:id/messages ; POST /conversations/:id/reply                          | inbox                                        | messaging.inbox.read / reply                                            | 24-h window enforced                |
| GET/POST/PATCH  | /campaigns ; POST /campaigns/:id/preview-audience ; /approve ; /start ; /pause ; GET /campaigns/:id/stats | campaigns                                    | messaging.campaign.manage / approve                                     |                                     |
| GET             | /costs?by=module                                                                                          | branch                                       | campaign&from&to ; POST /invoices/reconcile                             | cost                                | messaging.cost.read                                       |     |
| GET             | /health ; /metrics                                                                                        | provider health, queue depth, delivery rates | messaging.provider.read                                                 |                                     |
| GET             | /s/:code (public short link redirect)                                                                     | click tracking                               | public                                                                  |                                     |

## 7. Domain Events (outbox)

- `messaging.provider.configured|down|recovered`.
- `messaging.template.created|approved|dlt_registered|wa_approved|wa_rejected|wa_paused|retired`.
- `messaging.message.queued|sent|delivered|read|failed|expired|dropped_policy|fallback_triggered` → source module (status chips), EN-037 (escalation), EN-001 (fact).
- `messaging.inbound.received|routed` → OP-001 (appointment replies), EN-006 ("I'm here"), EN-030 (feedback), AI-001, call-centre inbox.
- `messaging.optin.recorded|opted_out|blocked` → EN-028 ledger, NC-026.
- `messaging.campaign.approved|started|completed|paused`, `messaging.cost.budget_exceeded` → Admin.

## 8. Screens

- **Messaging Admin** (desktop): providers (health, balances/credits, quality rating), DLT settings, WhatsApp number status, routing/failover, cost dashboard (by module/branch/day), budget alerts.
- **Template Studio** (desktop): list with channel/status/quality chips, editor with variables & language tabs, live preview (phone mock), DLT id/content validator (diff highlight), WhatsApp submit & status, approval flow, usage stats; `Ctrl+S` save, `Ctrl+Enter` submit.
- **Message Log** (desktop): filters, status timeline per message (queued→sent→delivered→read), error codes, resend/fallback, per-patient history tab (in patient 360 with PHI masking); real-time updates.
- **Inbox / Conversations** (desktop/tablet for call centre): WhatsApp threads, 24-h window timer, quick replies (templates), assign, close, media viewer, link to patient/appointment; `R` reply, `A` assign.
- **Campaign Builder** (desktop): segment builder (consent-aware counts), template pick, schedule/window/throughput/budget, approval, live stats (funnel), opt-out list.
- **Opt-in & DND** (desktop, DPO/front office): patient preference panel (channels/classes/language/quiet hours), evidence view, block list.
- **Trigger Rules** (desktop): event catalogue → template mapping, conditions, delay, channel policy, test send.
- Patient side: WhatsApp/SMS receipts, buttons; portal preferences (PE-001).
- Offline: sends queue server-side; staff ad-hoc send waits for connectivity.

## 9. Integrations

- SMS: MSG91, Twilio, Gupshup, Kaleyra, Exotel, ValueFirst, custom HTTP adapter (template driven), with DLT scrubbing; WhatsApp: Meta Cloud API direct (Graph API v20+, webhooks) and BSPs (Gupshup, Twilio, MSG91, Interakt/AiSensy) via adapter interface (`sendTemplate`, `sendSession`, `uploadMedia`, `getTemplateStatus`, webhook normaliser); RCS (`messaging.rcs`) later; short-link service; EN-033 voice fallback; EN-028 consent; NC-009 cost journals; AI-001 chatbot; Vault for credentials; provider status pages for health.

## 10. Reports & Analytics

- Delivery rate by channel/provider/template, failure reasons, fallback rate, WhatsApp read rate & quality trend, OTP success rate & latency, messages per module/branch, cost per module/campaign/day and vs budget, opt-in/opt-out trends, DND blocks, campaign funnels (sent→delivered→read→click→reply→conversion), inbox response times, complaints. MVs `analytics.mv_msg_daily`.

## 11. Notifications

- IT: provider down/quality drop/credit low, webhook failures, template rejected/paused, delivery rate < 90 % in 1 h; Admin: budget 80/100 %, campaign approvals; DPO: complaints/opt-out spikes; Module owners: fallback exhausted for critical messages (escalate via EN-037).

## 12. Permissions (RBAC keys)

`messaging.provider.configure` (IT Admin) · `messaging.provider.read` · `messaging.template.configure` (IT, Marketing) · `messaging.template.approve` (Hospital Admin) · `messaging.message.send` (system modules; Front office/Call centre for ad-hoc templates; ABAC own-branch) · `messaging.message.read` (IT, Call centre; patient-level PHI audited) · `messaging.optin.manage` (Front office, DPO) · `messaging.optin.read` · `messaging.trigger.configure` (IT, Admin) · `messaging.inbox.read/reply` (Call centre, Marketing) · `messaging.campaign.manage` (Marketing) · `messaging.campaign.approve` (Hospital Admin) · `messaging.cost.read` (Admin, Finance).

## 13. Non-functional

- 30k messages/day (peaks 3k/hour at 08:00 reminders and OPD start), OTP p95 send latency < 2 s end-to-end, transactional < 10 s, campaigns throttled per provider (e.g. 80 msg/s WA tier); webhook ingestion idempotent, < 100 ms.
- Queue durability (Redis AOF), retries with backoff, DLQ, circuit breakers per provider; multi-provider failover < 1 min.
- Security: credentials encrypted, webhook signature verification (Meta X-Hub-Signature-256), IP allowlists, no PHI in logs, bodies encrypted at rest; rate limits per hospital.
- i18n: 8 languages, Unicode SMS segment counting (70 chars/segment), WhatsApp language codes; RTL for `ar`.
- On-prem: outbound HTTPS via proxy; if no internet, on-prem GSM modem adapter (SMPP/AT) as last resort (enhancement).

## 14. Acceptance Criteria

1. Given an SMS template whose rendered content differs from the DLT-registered content, when saving/sending, then it is rejected with a diff and never sent.
2. Given a patient with WhatsApp opt-in and an approved utility template, when a token is issued, then the WhatsApp message is sent within 10 s and status moves to delivered/read via webhook.
3. Given WhatsApp returns undelivered (not on WhatsApp), when received, then the SMS variant is sent automatically and both messages link via `fallback_of_id`.
4. Given a promotional template, when sent at 21:30 IST or to a DND number without marketing opt-in, then it is dropped with `dropped_policy` and reason.
5. Given 4 OTP requests within 10 min for one number, when the 4th arrives, then it is rate-limited and an audit event is written.
6. Given a patient replies STOP on WhatsApp, when received, then marketing opt-out is recorded within 1 min and subsequent campaigns exclude the number.
7. Given a campaign with a budget cap of ₹5,000, when projected cost exceeds the cap, then the send pauses at cap and Admin is notified.
8. Given a WhatsApp inbound reply "Confirm" to an appointment message, when received within the 24-h window, then OP-001 marks the appointment confirmed and the conversation shows the routed intent.
9. Given the primary SMS provider fails 5 consecutive calls, when the breaker opens, then queued messages route to the secondary provider and IT is alerted; recovery closes the breaker.
10. Given a template carrying a variable > 30 chars, when rendered, then the send is blocked (TRAI rule) with guidance to shorten.
11. Given a message log query for a patient, when opened by call centre staff, then rendered bodies show with PHI masking rules and a `READ_PHI` audit is recorded.
12. Given the month-end, when cost report runs, then costs by module/branch/campaign match provider counts within 1 % and reconciliation deltas are listed.
13. Given a Meta template paused for quality, when the webhook arrives, then the template is marked paused, SMS fallback is auto-enabled for its triggers, and Admin is notified.
14. Given a lab report PDF to be sent on WhatsApp, when the patient lacks `report_delivery_whatsapp` consent, then only a secure link (OTP) is sent instead of the document.

## 15. Enhancements / Later phases

- RCS Business Messaging, WhatsApp Flows (forms for pre-registration/feedback), WhatsApp payments (UPI) with EN-010, voice/IVR fallback (EN-033), chatbot NLU (AI-001), send-time optimisation and cost-based routing, on-prem GSM modem adapter, Truecaller/verified sender branding, WhatsApp campaign segmentation with lookalike (market), auto-language detection, "send-and-delete" media handling for privacy (market), delivery SLA dashboards per template, sentiment on inbound (AI).

## 16. Open Questions for the Hospital

1. Existing DLT entity id, registered headers and templates (export list) and current SMS vendor(s)/contracts?
2. WhatsApp: existing WABA/number or new? Business verification status; preferred BSP vs Meta direct?
3. Which events must go on WhatsApp vs SMS; SMS budget/month; OTP volume?
4. Marketing consent capture today (registration form wording); DND scrubbing approach?
5. Report/document delivery over WhatsApp allowed? Password protection policy?
6. Languages required for templates; sender name/display name.
7. Inbound handling: who monitors WhatsApp inbox (call centre hours) and escalation for medical questions?
8. On-prem tenants: internet reliability; need for GSM modem fallback?
