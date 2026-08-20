# EN-032 — Email Integration (SMTP / Amazon SES / SendGrid Adapters, DKIM-SPF-DMARC, Shared Template Engine, PHI Attachment Policy, Bounce & Complaint Handling, Suppression List, Delivery Tracking, Transactional vs Bulk Separation)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Module ID       | EN-032                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Phase           | 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Depends on      | EN-017 (connector registry, credentials vault, retry/DLQ, webhook ingestion), EN-009 (shared template master, trigger catalogue, opt-in/opt-out ledger — email is a channel of the same messaging fabric), EN-039 (template designer & HTML/PDF rendering pipeline), EN-007 (settings, secrets, service accounts), EN-024 (audit), EN-037 (Notification Centre routes email as one delivery channel), EN-028 (consent for marketing/bulk email), EN-023 (secret rotation, TLS policy), EN-040 (per-tenant sending quota entitlement)                                                                                                                                                                                 |
| Consumed by     | EN-037 (notification channel), EN-030 (survey invitations), OP-004/OP-008 (lab & radiology report delivery), OP-005/IP-005/NC-012 (bill, receipt, statement of account), IP-002 (discharge summary), NC-011/EN-001 (scheduled report distribution), NC-005 (purchase orders to vendors), NC-010 (payslips, offer letters), EN-002/RC-001 (TPA claim correspondence), PE-001/PE-006/PE-007/PE-008 (portal invitations, password resets), NC-028 (helpdesk ticket mail), EN-012 (website enquiry replies)                                                                                                                                                                                                              |
| Feature flag    | `module.email.enabled` (sub: `email.bulk`, `email.inbound`, `email.attachments_phi`, `email.tracking_pixel`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Primary roles   | System/service accounts (automated sending), IT Admin (56 — provider config, deliverability), Marketing/CRM (55 — bulk campaigns)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Secondary roles | Hospital Admin (2 — sender identities & policy), MRD (43 — report dispatch), Accounts (46 — statements), HR (47 — payslips), DPO (57 — PHI-by-email policy), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Regulatory      | **DPDP Act 2023 & Rules 2025** — email of health data is a disclosure requiring lawful basis, purpose limitation and reasonable security; **IT Act §43A / SPDI Rules** (reasonable security practices, encryption of sensitive personal data in transit and, for PHI attachments, at rest); **CERT-In 2022 directions** (log retention 180 days, NTP sync, incident reporting); Indian Contract Act/GST — invoices emailed must carry the tax invoice format (NC-009); DPDP consent for **promotional** email (transactional is exempt but must remain genuinely transactional); global-ready: CAN-SPAM/GDPR-compatible unsubscribe, list-unsubscribe headers, and data-residency selection for the sending provider |

## 1. Purpose

EN-032 is the hospital's single outbound (and optionally inbound) email service: provider adapters with failover, verified sender identities with DKIM/SPF/DMARC, one shared template engine with EN-009, a strict policy for how PHI may (and may not) leave by email, and full lifecycle tracking — queued, sent, delivered, opened, bounced, complained, suppressed. Transactional mail (reports, receipts, OTPs, alerts) and bulk mail (campaigns, newsletters) are deliberately separated onto different identities and IP pools so that a marketing complaint can never damage the deliverability of a lab report.

## 2. Users & Jobs-to-be-done

- **IT Admin (56, desktop)**: configure providers and sender domains, verify DNS records, watch bounce/complaint rates and the deliverability dashboard, rotate credentials, and triage failed sends from the DLQ.
- **Patient (59)**: receive a lab report as a password-protected PDF (or a secure link with OTP), a GST-compliant bill, an appointment confirmation and a portal invitation — and be able to unsubscribe from anything non-essential.
- **Marketing/CRM (55)**: send a segmented health-camp campaign to consented recipients only, with unsubscribe honoured and per-campaign metrics.
- **Accounts / HR / Purchase (46/47/45)**: email statements, payslips (password-protected) and purchase orders with delivery evidence attached to the source record.
- **MRD / Lab / Radiology (43/33/36)**: dispatch a report to a referring doctor or patient with the delivery status visible next to the report.
- **DPO (57)**: prove what health information left the hospital by email, to whom, under what basis, and with what protection.

## 3. Core Workflows

### 3.1 Provider & sender identity setup

1. IT Admin registers an **email provider** as an EN-017 connector: adapter `smtp` (generic, e.g. hospital Exchange/Zimbra/Google Workspace relay), `ses` (Amazon SES with region choice for data residency — `ap-south-1` default), `sendgrid`, `postmark`, `mailgun`, or `msgraph` (Microsoft 365 Graph sendMail). Credentials (SMTP user/pass, API key, IAM role, OAuth2 client) go to the vault; TLS is enforced (STARTTLS required, TLS 1.2+; opportunistic TLS is rejected for PHI-bearing mail).
2. **Sender identities** (`email_senders`) are created per purpose: `no-reply@`, `reports@`, `billing@`, `appointments@`, `hr@`, `marketing@`, plus per-branch variants. Each identity declares: display name, reply-to, category (**transactional | bulk | system**), provider binding, branch scope, footer/letterhead template, and whether it may carry attachments.
3. **DNS authentication wizard** shows the exact records to publish and verifies them live:
   - **SPF**: `v=spf1 include:<provider> ~all` (with a warning if the domain exceeds the 10 DNS-lookup limit).
   - **DKIM**: provider-generated selector(s), 2048-bit, with rotation reminders; the wizard polls DNS until the CNAME/TXT resolves.
   - **DMARC**: `v=DMARC1; p=none → quarantine → reject` staged rollout with `rua`/`ruf` aggregate reports ingested and charted.
   - **Return-Path/MAIL FROM** custom subdomain for alignment; **BIMI** optional later.
     A sender identity cannot be activated for production until SPF+DKIM verify and DMARC is at least `p=none` with reporting on.
4. **Transactional vs bulk separation** is enforced: bulk-category identities must use a different subdomain (e.g. `mail.hospital.in` vs `news.hospital.in`) and, where the provider supports it, a different IP pool/sub-account. A campaign may not be sent from a transactional identity, and a transactional message may not be sent from a bulk identity (hard validation).
5. **Warm-up**: for a new domain/IP, a warm-up schedule caps daily volume with a ramp; exceeding it queues rather than sends.
6. Provider **failover**: identities may declare a primary and a secondary provider; on circuit-open (EN-017) transactional mail fails over automatically, bulk does not (to protect reputation).

### 3.2 Templates (shared with EN-009)

- Templates live in the **shared template master** (EN-009 `msg_templates` family) with a channel dimension; email adds `subject`, `preheader`, `html_body`, `text_body` (mandatory plain-text alternative), `attachments[]` policy, `category`, `language`, and a `sender_identity_id`.
- Rendering uses EN-039's engine: MJML-derived responsive HTML compiled at publish time into inlined-CSS HTML (dark-mode safe, table-based, ≤102 KB to avoid Gmail clipping), variables via a typed context (`{{patient.first_name}}`, `{{bill.no}}`, `{{report.link}}`) validated against the trigger's payload schema at publish.
- **Seeded catalogue**: appointment confirmed / rescheduled / cancelled / reminder, OTP & password reset (no PHI), portal invitation, lab report ready + report attached, radiology report ready, discharge summary, bill/receipt/GST invoice, statement of account, insurance pre-auth correspondence, payslip, purchase order, vendor RFQ, helpdesk ticket updates, scheduled MIS report, survey invitation (EN-030), health-camp campaign (bulk), subscription/licence notices (EN-040).
- Every template declares its **PHI class** (`none` / `identifier_only` / `clinical`) which drives the attachment and link policy in §3.4; a template's PHI class cannot be lowered without DPO approval.
- Multi-language variants per template with a completeness meter; fallback to `en-IN`.

### 3.3 Send pipeline

1. A module calls `POST /api/v1/email/send` (or EN-037 routes a notification to the email channel) with `{templateKey, to[], cc[], bcc[], context, attachments[], idempotencyKey, priority, refType, refId}`.
2. **Pre-flight checks** in order: valid template & active version → recipient address syntax + MX/disposable-domain check → **suppression list** (hard bounce, complaint, unsubscribe, manual block) → consent check for bulk category (EN-028/EN-009 opt-in ledger) → per-tenant and per-recipient rate limits (default max 10 emails/recipient/day, configurable; OTP capped at 5/hour) → quota entitlement (EN-040) → PHI policy (§3.4) → warm-up cap.
3. **Render** subject/HTML/text with the context; generate/attach documents through the worker (Playwright PDF from EN-039 templates); compute size (hard cap 10 MB total, provider-dependent; above that, switch to a secure link automatically).
4. **Queue** to BullMQ per identity with priority lanes (`critical` OTP/alerts → `transactional` → `bulk`), then dispatch via the provider adapter with `Message-ID`, `List-Unsubscribe` + `List-Unsubscribe-Post` (bulk and non-essential transactional), `Auto-Submitted: auto-generated`, and a per-message tracking id.
5. **Status lifecycle**: `queued → rendering → sent → delivered → opened? → clicked?` or `→ deferred → bounced (soft/hard) → complained → suppressed`. Provider webhooks (SES SNS, SendGrid Event Webhook, Postmark, Mailgun) are ingested through EN-017 with signature verification and update the message row idempotently.
6. **Retries**: transport errors and soft bounces retry with exponential backoff (5 min, 30 min, 2 h, 6 h; max 4 attempts within 24 h). Hard bounces never retry. `4xx` provider validation errors go straight to the DLQ.
7. The source record (bill, report, PO) receives a **delivery evidence** back-link: status, timestamp, provider id — visible next to the document so a receptionist can answer "did the patient get the report?".

### 3.4 PHI attachment & link policy

- **Default posture: no clinical attachment in plain email.** Three modes are configurable per template (subject to the template's PHI class):
  1. **Secure link + OTP (recommended default for `clinical`)**: the email contains a signed, single-use, expiring (default 72 h) link to the patient portal/report viewer; opening it requires an OTP to the registered mobile or a portal login. No PHI in the email body beyond the patient's first name and the document type.
  2. **Password-protected PDF attachment**: AES-256 encrypted PDF whose password is a documented, per-patient formula (e.g. DDMMYYYY of date of birth, or UHID last 6) communicated out-of-band via SMS (EN-009); the password is never in the same email. Used for bills, payslips, and reports where the recipient has no portal.
  3. **Plain attachment**: permitted only for `none`/`identifier_only` PHI class (e.g. an appointment confirmation, a purchase order) or where an explicit, recorded patient instruction accepts the risk (EN-028 consent artefact with a plain-language risk statement).
- Subject lines and preheaders may **never** contain diagnosis, test names that reveal condition (e.g. "HIV Western Blot"), or clinical values; a lint rule blocks a configurable sensitive-term list at template publish.
- Recipient verification: patient email addresses must be verified (double opt-in or portal-confirmed) before any `clinical`-class mail is sent to them; unverified addresses fall back to SMS/WhatsApp notification with a portal link.
- Every send of a `clinical`-class message writes a **PHI disclosure record** (who, what document, to which address, basis, mode) surfaced in the DPO's data-flow and DSAR views.
- Third-party providers (SES/SendGrid) are **processors**: DPA reference, region and retention are recorded on the connector (EN-017 DPDP metadata); providers must be configured to not retain message bodies beyond the minimum, and PHI attachments are preferentially replaced by links to avoid content residing with the processor at all.

### 3.5 Bounce, complaint & suppression handling

- **Hard bounce** (5.x.x, invalid mailbox/domain) → address added to `email_suppressions` (`reason=hard_bounce`, permanent) → the patient/vendor record is flagged "email invalid" so front office can correct it → future sends to that address are blocked pre-flight and reported as `suppressed`.
- **Soft bounce** (mailbox full, greylisting, 4.x.x) → retry per policy; 5 soft bounces in 30 days promote to suppression with reason `repeated_soft_bounce`.
- **Spam complaint** (FBL/provider complaint event) → immediate permanent suppression for **all categories** (not just bulk), plus an alert to Marketing; complaint rate is tracked per identity/campaign.
- **Unsubscribe**: one-click `List-Unsubscribe-Post` and a footer link; unsubscribe is category-scoped (marketing vs all-non-essential) and writes to the same opt-out ledger EN-009 uses, so opting out of email also flags the preference centre (EN-037). **Essential transactional mail (OTP, bill, report, appointment, legal notices) is never unsubscribable** and says so in the footer.
- Suppression list is manually manageable (add/remove with reason and audit); removing a hard-bounce suppression requires a re-verification send.
- **Deliverability guardrails**: if bounce rate > 5 % or complaint rate > 0.1 % over a rolling 1000 messages on an identity, bulk sending on that identity auto-pauses and alerts IT + Marketing (transactional continues); DMARC aggregate reports are parsed into a pass/fail chart by source.

### 3.6 Inbound email (optional, `email.inbound`)

- Inbound addresses can be routed to modules: `helpdesk@` → NC-028 ticket create/reply threading (by `In-Reply-To`/ticket token), `claims@` → EN-002 document intake, `careers@` → NC-010, `reports@` → bounce processing.
- Ingestion via provider inbound parse webhook or IMAP polling (EN-017); attachments are virus-scanned (ClamAV) and size-capped; sender is matched to a known patient/vendor where possible; unmatched mail goes to a triage queue.
- Auto-responders are suppressed on `Auto-Submitted` headers to prevent mail loops; a loop detector caps 3 automated exchanges per thread.

### 3.7 Exceptions

- **Provider outage** → circuit opens (EN-017); transactional mail fails over to the secondary provider or, if none, queues (durable) and alerts IT; critical notifications (EN-037) fall back to SMS/WhatsApp automatically.
- **Attachment generation failure** (PDF render error) → message is not sent; the source record shows "report could not be attached" and a DLQ item is raised — an email must never go out with a missing or wrong attachment.
- **Wrong-recipient risk**: shared family email addresses are detected (same address on multiple patient records) and `clinical`-class mail to such an address requires the secure-link mode.
- **Quota exhausted** (EN-040 plan limit) → non-critical bulk is paused first, transactional continues with an admin alert; hard exhaustion queues rather than drops.

## 4. Data Model (schema `engage`, prefix `email_`)

- `email_providers` — id, hospital_id, connector_id (EN-017), adapter enum(smtp/ses/sendgrid/postmark/mailgun/msgraph), region, credentials_ref, tls_policy, daily_quota, ip_pool, warmup jsonb, status enum(draft/verifying/active/paused/failed), is_primary, failover_provider_id?, created…
- `email_senders` — id, hospital_id, branch_id?, address citext, display_name, reply_to, category enum(transactional/bulk/system), provider_id, subdomain, spf_status, dkim_status, dkim_selectors text[], dmarc_policy enum(none/quarantine/reject), dmarc_rua, verified_at, allow_attachments bool, footer_template_id, status; UNIQUE(hospital_id, address).
- `email_messages` — id uuidv7, hospital_id, branch_id?, sender_id, template_key, template_version, category, priority enum(critical/transactional/bulk), to_hash (sha256 of address for indexing), to_encrypted, cc_count, subject_redacted, phi_class enum(none/identifier_only/clinical), attachment_mode enum(none/plain/password_pdf/secure_link), attachment_refs jsonb, ref_type, ref_id, idempotency_key, provider_message_id, status enum(queued/rendering/sent/delivered/deferred/bounced/complained/failed/suppressed/cancelled), bounce_type enum(hard/soft)?, bounce_code, error_class, attempts, size_bytes, queued_at, sent_at, delivered_at, first_opened_at, open_count, click_count, complained_at, cost_units, campaign_id?; **partitioned monthly**; indexes (hospital_id, queued_at desc), (status, queued_at), (ref_type, ref_id), UNIQUE(hospital_id, idempotency_key).
- `email_events` — id, message_id, event enum(queued/sent/delivered/deferred/bounce/complaint/open/click/unsubscribe/dropped), provider_event_id, occurred_at, payload_redacted jsonb, user_agent_class, ip_class (never full IP for opens); partitioned monthly.
- `email_suppressions` — id, hospital_id, address_hash, address_encrypted, reason enum(hard_bounce/repeated_soft_bounce/complaint/unsubscribe/manual/invalid_domain/dpdp_request), scope enum(all/bulk_only), suppressed_at, expires_at?, source, note, removed_at, removed_by; UNIQUE(hospital_id, address_hash, scope).
- `email_verifications` — id, hospital_id, patient_id?/employee_id?/vendor_id?, address_encrypted, token_hash, sent_at, verified_at, expires_at, attempts.
- `email_campaigns` (bulk) — id, hospital_id, name, sender_id, template_key, segment jsonb, consent_basis, scheduled_at, started_at, completed_at, recipients, sent, delivered, opened, clicked, bounced, complained, unsubscribed, status enum(draft/approved/scheduled/sending/paused/completed/cancelled), approved_by (Marketing + DPO for health-related content).
- `email_phi_disclosures` — id, message_id, patient_id, document_type, mode, legal_basis, recipient_relationship enum(self/family_consented/referring_doctor/payer/other), consent_ref?, disclosed_at; feeds the DPO register and DSAR responses.
- `email_dmarc_reports` — id, hospital_id, domain, provider_org, date_range, source_ip_class, count, spf_result, dkim_result, disposition, parsed_at.
- `email_inbound` — id, hospital_id, to_address, from_encrypted, subject_redacted, thread_ref, matched_entity jsonb, attachments jsonb (scanned, stored refs), routed_module, status enum(received/routed/triage/rejected), received_at.
- Retention: message metadata **180 days online** (CERT-In) then archived 2 years; rendered bodies/attachments **not stored** (regenerated from template + context) except where legally required (invoices — keep the exact PDF); events 180 days; suppressions permanent; PHI disclosure records 10 years.

## 5. Business Rules & Validations

- **Transactional and bulk are never mixed**: a bulk-category template cannot be sent from a transactional identity or vice versa; bulk requires recorded consent and honours unsubscribe; transactional-essential mail is exempt from unsubscribe but must be genuinely essential (an admin cannot flip a marketing template to transactional without DPO approval).
- **No PHI in subject or preheader**; a publish-time lint blocks the sensitive-term list. Clinical attachments follow §3.4 (secure link or password-protected PDF); plain clinical attachments require an explicit, recorded patient instruction.
- **Password for a protected PDF is never sent in the same email** — it goes by SMS (EN-009) or is a documented patient-known value; the email states which.
- **Idempotency is mandatory** on every send (`Idempotency-Key`); a duplicate key returns the original message id and does not send twice.
- **Suppression is checked pre-flight and is absolute** for bulk; for critical transactional mail to a suppressed address the send is blocked and the calling module is told to use an alternative channel (never silently dropped).
- A sender identity may not send in production until **SPF and DKIM verify and DMARC reporting is on**; `p=reject` is the target state and the dashboard nags until reached.
- Rate limits: default 10 messages/recipient/day, 5 OTP/hour/recipient, per-tenant hourly cap from EN-040; bulk respects the warm-up ramp.
- **Open tracking** (pixel) is disabled by default for `clinical` templates and for tenants that switch it off; click tracking never rewrites links in a way that leaks PHI in the URL, and tracking domains are the hospital's own (CNAME), not the provider's.
- All mail is sent over **TLS 1.2+**; a provider or relay that cannot negotiate TLS is refused for anything above `none` PHI class.
- Attachment total ≤10 MB; above that the system automatically switches to secure-link mode rather than failing.
- Every message row stores a **redacted subject** and hashed recipient; full recipient addresses are encrypted at rest and revealing them requires `email.recipient.read` with an audit entry.
- Bulk campaigns with health-related content require dual approval (Marketing + DPO) and must state the sender's postal address and an unsubscribe link.
- Bounce rate > 5 % or complaint rate > 0.1 % on an identity auto-pauses **bulk** on that identity and alerts; it never pauses transactional.

## 6. API Surface (`/api/v1/email`)

| Method          | Path                                                                       | Purpose                                            | Permission                               | Notes                                          |
| --------------- | -------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| GET/POST/PATCH  | /providers ; /providers/:id                                                | provider config                                    | `email.provider.manage`                  | secrets write-only                             |
| POST            | /providers/:id/test                                                        | send a test message                                | `email.provider.manage`                  | to a verified staff address only               |
| GET/POST/PATCH  | /senders ; /senders/:id                                                    | sender identities                                  | `email.sender.manage`                    |                                                |
| POST            | /senders/:id/verify-dns ; GET /senders/:id/dns-records                     | SPF/DKIM/DMARC wizard                              | `email.sender.manage`                    | live DNS check                                 |
| POST            | /send                                                                      | send a templated email                             | `email.send` (service + role-scoped)     | Idempotency-Key required                       |
| POST            | /send/bulk                                                                 | enqueue a campaign batch                           | `email.campaign.send`                    | consent + approval gated                       |
| GET             | /messages?status&sender&ref&from&to&q                                      | message log (redacted)                             | `email.message.read`                     | cursor, partition-aware                        |
| GET             | /messages/:id                                                              | message detail + event timeline                    | `email.message.read`                     | recipient masked unless `email.recipient.read` |
| POST            | /messages/:id/resend \| /cancel                                            | resend (new idempotency key) / cancel while queued | `email.message.resend`                   | audited, reason                                |
| GET/POST/DELETE | /suppressions                                                              | suppression list management                        | `email.suppression.manage`               | removal requires re-verification               |
| POST            | /verifications/send ; GET /verifications/:token                            | double opt-in address verification                 | `email.verify.send` / public token       | 7-day expiry                                   |
| GET/POST/PATCH  | /campaigns ; POST /campaigns/:id/approve \| /schedule \| /pause \| /cancel | bulk campaigns                                     | `email.campaign.manage` (+ DPO approval) |                                                |
| GET             | /campaigns/:id/metrics                                                     | opens, clicks, bounces, unsubscribes               | `email.report.read`                      |                                                |
| POST            | /webhooks/:provider                                                        | provider delivery/bounce/complaint events          | signature-verified public                | idempotent, via EN-017                         |
| POST            | /inbound/:address                                                          | inbound parse webhook                              | signature-verified public                | virus-scanned                                  |
| GET             | /deliverability                                                            | bounce/complaint rates, DMARC pass %, reputation   | `email.report.read`                      | per identity                                   |
| GET             | /phi-disclosures?patient&from&to                                           | PHI-by-email register                              | `email.phi.read` (DPO, Auditor)          | DSAR support                                   |
| GET             | /templates?channel=email                                                   | email templates (shared master)                    | `msg.template.read` (EN-009)             | authoring lives in EN-009/EN-039               |

## 7. Domain Events (outbox)

- `email.message.queued|sent|delivered|deferred|bounced|complained|failed|suppressed` → source module callbacks (attach delivery evidence to the bill/report/PO), EN-001 analytics.
- `email.address.hard_bounced` → patient/vendor/employee record flagged "email invalid", front-office task to correct.
- `email.recipient.unsubscribed` → EN-009/EN-037 preference centre, campaign segment refresh.
- `email.identity.dns_verified|dns_failed|deliverability_degraded|bulk_auto_paused` → EN-037 alert to IT & Marketing.
- `email.provider.circuit_opened|failover_activated` → IT on-call.
- `email.phi.disclosed` → DPO register, EN-024 audit.
- `email.inbound.received|routed|unmatched` → NC-028, EN-002.
- Consumes: `lab.report.released`, `rad.report.finalised`, `bill.finalized`, `receipt.issued`, `appointment.confirmed|reminder_due`, `ip.discharge.completed`, `payroll.payslip.generated`, `po.approved`, `report.schedule.due`, `ticket.updated`, `feedback.invitation.due`, `licence.expiry.warning`.

## 8. Screens (UI)

- **Email Settings / Providers** (desktop, IT Admin): provider cards with status, region, daily quota used vs limit, failover chain, "Send test" action; credential fields write-only with a rotate action.
- **Sender Identity & DNS Wizard** (desktop): per-identity card with three status chips (SPF / DKIM / DMARC), copy-to-clipboard DNS records with a "check now" button that polls and turns green, DMARC policy stepper (`none → quarantine → reject`) with a readiness check and the aggregate-report pass chart, warm-up progress bar for new domains.
- **Message Log** (desktop): virtualised table (time, template, sender identity, recipient masked, subject redacted, status chip, opens, ref link), filter bar (status, identity, template, date, ref), row drawer with the event timeline, provider ids, error text, `Resend`, `Cancel`, and a "reveal recipient" action behind step-up auth. Shortcuts `F` filter, `R` resend, `Ctrl+K` jump to a ref.
- **Deliverability Dashboard** (desktop): per-identity delivery %, bounce % (hard/soft split), complaint %, open/click rate for bulk, DMARC pass/fail by source with unknown-source highlighting, reputation trend, and the auto-pause banner when a threshold is crossed.
- **Suppression List** (desktop): searchable, reason chips, added-by/when, bulk import/export, remove with reason (forces a re-verification send).
- **Campaign Composer** (desktop, Marketing): template picker, segment builder with consented-recipient count and an "excluded: N suppressed, M no-consent" breakdown, test send, schedule, approval status (Marketing + DPO), live sending progress with pause.
- **Delivery evidence chip** (embedded in OP-004/OP-005/IP-002/NC-005 screens): a small status pill next to the document — "Emailed to p•••@gmail.com, delivered 10:42" with hover detail and a resend action.
- **PHI Disclosure Register** (desktop, DPO): what clinical documents were emailed, to whom (masked), under what mode and basis; export for DSAR.
- Empty/error states: "DKIM not verified — production sending is disabled for reports@hospital.in", "This address hard-bounced on 12-Mar — correct it in the patient record to resume email", "Attachment could not be generated — email withheld (no partial sends)".

## 9. Integrations

- **Providers**: Amazon SES (ap-south-1 for Indian data residency; SNS webhooks for bounce/complaint/delivery), SendGrid (Event Webhook), Postmark, Mailgun, Microsoft 365 Graph, and generic SMTP relays (hospital Exchange/Zimbra/Google Workspace) — all registered as EN-017 connectors with vault credentials, retry and circuit breakers.
- **EN-009** shares the template master, trigger catalogue, opt-in/opt-out ledger and the preference centre so a patient's "stop contacting me" applies across SMS, WhatsApp and email.
- **EN-039** renders HTML and generates PDF attachments (Playwright) with letterhead/watermark/QR verification; **EN-016** signs clinical PDFs before dispatch; **EN-013** supplies QR codes for report verification links.
- **EN-037** treats email as one delivery channel with per-user preferences and quiet hours; **EN-030** sends survey invitations; **EN-040** enforces the plan's monthly email quota.
- Inbound: provider parse webhooks or IMAP polling into NC-028 (helpdesk) and EN-002 (claims documents), with ClamAV scanning.

## 10. Reports & Analytics

- Volume by template, module, identity, branch and day; delivery rate, bounce rate (hard/soft), complaint rate, open/click rate (bulk only by default); median time queued→delivered.
- Failure taxonomy (top bounce codes and their trend), DLQ ageing, resend counts.
- Deliverability posture: DMARC pass % by source, unauthenticated senders detected (shadow IT), DKIM key age, TLS negotiation success %.
- Cost/quota: messages vs plan entitlement (EN-040), provider cost per 1000, campaign cost per engaged recipient.
- Compliance: PHI-by-email count by mode (secure link vs password PDF vs plain), unverified-recipient blocks, unsubscribe rate by category.
- Read models: `analytics.mv_email_daily`, `analytics.mv_email_identity_health`.

## 11. Notifications

- **To IT/on-call**: DNS verification failure, DKIM key expiring, provider circuit opened, failover activated, bounce/complaint threshold breached, bulk auto-paused, quota at 80/95/100 %.
- **To Marketing**: campaign completed with metrics, complaint spike, high unsubscribe rate.
- **To front office / MRD**: "patient email invalid — please correct" task on hard bounce; "report could not be emailed" with a suggested alternative channel.
- **To DPO**: monthly PHI-by-email summary; any plain-attachment clinical send (should be rare and is flagged).
- **To patient**: address verification email; unsubscribe confirmation; nothing else that is itself unsolicited.

## 12. Permissions (RBAC keys)

`email.provider.manage` (IT Admin 56) · `email.sender.manage` (IT Admin, Hospital Admin 2) · `email.send` (service accounts + roles scoped by template category) · `email.campaign.manage` / `email.campaign.send` (Marketing 55, with DPO 57 approval for health content) · `email.message.read` (IT, module owners scoped by ref via ABAC) · `email.recipient.read` (IT lead, DPO — step-up auth, audited) · `email.message.resend` (IT, MRD 43, Billing 27 for own refs) · `email.suppression.manage` (IT, Marketing) · `email.verify.send` (Front Office 24, Portal service) · `email.phi.read` (DPO 57, Auditor 58) · `email.report.read` (Admin, IT, Marketing).

## 13. Non-functional

- **Volumes (2000-bed enterprise)**: ~8000–12 000 transactional emails/day (reports, bills, appointments, portal, HR, procurement) plus periodic campaigns of 20 000–50 000; peak burst 3000 messages in 10 minutes after the morning report release. Sustained throughput target ≥ 50 msg/s per identity, bounded by provider limits.
- Latency: enqueue-to-provider p95 < 5 s for `critical` (OTP), < 60 s for `transactional`; PDF-attachment generation p95 < 4 s (async, never blocks the caller); webhook status update applied < 10 s after provider event.
- Rendered bodies are **not persisted** (regenerated on demand from template version + context) to minimise PHI at rest; invoices are the exception and are stored as signed PDFs in object storage with lifecycle rules.
- Storage: ~4 M message rows/year, monthly partitions, 180-day online retention, partition detach for archival in < 1 s.
- Availability: durable queue survives provider and worker outages; no message loss on crash (outbox + BullMQ ack); graceful drain on deploy; on-prem deployments work with an internal SMTP relay and no internet.
- Security: TLS 1.2+ enforced, DKIM 2048-bit with annual rotation reminders, secrets in vault with rotation audit, no PHI in logs or metrics, tracking domain owned by the hospital, attachments virus-scanned on inbound.
- Accessibility & i18n: HTML templates meet WCAG 2.2 AA contrast, are readable with images off (plain-text alternative always present), support `hi/ta/te/ml/kn/mr/bn` and RTL for `ar`, and use system-safe fonts; every email includes a plain-text part.

## 14. Acceptance Criteria

1. **Given** a new sender identity `reports@hospital.in`, **when** SPF and DKIM records are not yet verified, **then** production sending from that identity is blocked and the wizard shows the exact records with a live re-check button.
2. **Given** a lab report is released for a patient with a verified email, **when** the report email is sent with the default policy, **then** the email contains a secure single-use link expiring in 72 hours (not the PDF), the subject contains no test name that reveals the condition, and a PHI disclosure record is written.
3. **Given** password-protected-PDF mode is configured for bills, **when** the bill is emailed, **then** the PDF is AES-256 encrypted, the password is delivered by SMS in a separate message, and the email body states which value opens the file.
4. **Given** an address hard-bounces, **when** the provider webhook is processed, **then** the address is permanently suppressed, the patient record is flagged "email invalid", a front-office task is created, and subsequent sends to that address are blocked pre-flight with status `suppressed`.
5. **Given** the same send request is submitted twice with the same Idempotency-Key, **when** the second request arrives, **then** no second email is sent and the original message id is returned.
6. **Given** a recipient clicks one-click unsubscribe on a campaign, **when** the `List-Unsubscribe-Post` is received, **then** the recipient is suppressed for bulk within 10 seconds, the preference is written to the shared opt-out ledger, and essential transactional email continues.
7. **Given** a marketing user attempts to send a campaign from the transactional identity, **when** they submit, **then** validation blocks it with an explanation of the transactional/bulk separation policy.
8. **Given** the complaint rate on an identity exceeds 0.1 % over the last 1000 messages, **when** the threshold check runs, **then** bulk sending on that identity auto-pauses, IT and Marketing are alerted, and transactional sending continues unaffected.
9. **Given** the primary provider returns 5xx repeatedly, **when** the circuit opens, **then** transactional mail fails over to the secondary provider automatically, bulk remains paused, and IT is alerted.
10. **Given** a PDF attachment fails to render, **when** the send job runs, **then** no email is sent, the source record shows "attachment could not be generated", and a DLQ item is created for triage.
11. **Given** a template with PHI class `clinical`, **when** an author puts `{{diagnosis}}` in the subject line, **then** publishing is blocked by the sensitive-content lint.
12. **Given** a user without `email.recipient.read` opens the message log, **when** they view a message, **then** the recipient address is masked and the subject shown is the redacted form.
13. **Given** an unverified patient email address, **when** a clinical-class message is requested, **then** the send is blocked and the caller is instructed to use SMS/WhatsApp with a portal link, and a verification email is offered.
14. **Given** the tenant's monthly email quota is exhausted, **when** a bulk campaign runs, **then** bulk is paused with an admin alert while transactional messages continue to send.
15. **Given** message retention of 180 days, **when** the retention job runs, **then** older message metadata is archived, no rendered bodies exist for non-invoice messages at any point, and PHI disclosure records are retained for 10 years.
16. **Given** an inbound email to `helpdesk@`, **when** it is parsed, **then** attachments are virus-scanned, a ticket is created or threaded in NC-028, and auto-submitted mail does not trigger an auto-reply loop.

## 15. Enhancements / Later phases

- **BIMI** with a VMC certificate for the hospital logo in inboxes; MTA-STS and TLS-RPT policies; ARC for forwarded mail.
- **Send-time optimisation** and per-recipient engagement scoring for campaigns; A/B subject testing.
- **AMP for Email / interactive** appointment confirm-reschedule directly in the inbox.
- Encrypted email at rest for the recipient via **S/MIME or PGP** for referring-doctor and payer correspondence.
- Multi-region provider selection per branch for global deployments (data residency by country, EN-041).
- Deeper **DMARC forensic (ruf)** analysis and automated shadow-IT sender discovery.
- Self-service **preference centre** page shared with EN-009/EN-037 where a patient chooses channels and topics.
- Provider-agnostic **deliverability seed testing** (inbox placement checks) before large campaigns.

## 16. Open Questions for the Hospital

1. Which **email provider** will be used (existing Microsoft 365/Google Workspace relay, or a dedicated SES/SendGrid account), and who controls the sending domain's DNS?
2. What **sending domain and subdomains** should be used for transactional versus bulk, and is the hospital willing to move DMARC to `p=reject`?
3. What is the hospital's policy for **emailing clinical documents** — secure link with OTP (recommended), password-protected PDF, or plain attachment on patient request? Who signs off on exceptions?
4. If password-protected PDFs are used, what is the **password convention** (DOB, UHID last 6, custom) and who communicates it to patients?
5. Which documents **must** be emailed at go-live (lab reports, radiology, discharge summary, bills, receipts, statements, payslips, POs), and to which recipient types (patient, referring doctor, payer, vendor, employee)?
6. Is **open/click tracking** acceptable, and should it be disabled for clinical messages?
7. Do patients' email addresses need **double opt-in verification** before clinical mail, and how should unverified patients be handled?
8. Is **inbound email** required (helpdesk, claims, careers), and which mailboxes should route into the HMS?
9. What are the expected **monthly volumes** (transactional and campaigns) so quotas, warm-up and provider tier can be sized?
10. Which **languages** must email templates support at go-live, and who supplies the translations and the letterhead/branding assets?
11. Is there an existing hospital mail server that must remain the relay (on-prem, no internet), and what are its TLS capabilities and rate limits?
12. What retention does legal require for **emailed invoices** (the exact PDF) versus other message metadata?
