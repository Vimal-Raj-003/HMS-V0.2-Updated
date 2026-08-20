# EN-017 — Integration Hub / ESB (Connector Registry, Protocol Adapters, Field-Mapping DSL, Transformation, Sync Scheduling, Retry/Backoff, Dead-Letter Queue, Replay, Circuit Breakers, Health Dashboard, Message Log with PHI Redaction, Connector SDK)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Module ID       | EN-017                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase           | 0/3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Priority        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Complexity      | Very High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Depends on      | EN-007 (settings, secrets, device/service accounts), EN-024 (audit), EN-026 (API Gateway — inbound edge; EN-017 is the outbound/mediation edge), EN-019 (HL7/FHIR message semantics), EN-027 (MDM — code systems used by mapping/value-set translation), EN-037 (alerting), EN-023 (SIEM, secret rotation), EN-022 (message-log backup/retention)                                                                                                                                                                                                  |
| Used by         | EN-004 (lab analyzers HL7/ASTM), EN-008 (PACS/DICOM MWL), EN-011 (ABDM), EN-009 (SMS/WhatsApp), EN-010 (payment gateway), EN-032 (email), EN-002/RC-001 (TPA/NHCX), NC-009 (Tally/ERP export), NC-010 (biometric attendance NC-029/EN-020), EN-021 (CCTV/ONVIF), EN-042 (IoT device gateway), EN-036 (data migration), EN-012 (website), EN-033 (IVR), OP-013 (U-WIN/CoWIN), RC-007 (PMJAY/CGHS/ESIC), e-Hospital (NIC) push                                                                                                                       |
| Feature flag    | `module.integration_hub.enabled` (sub: `ihub.soap`, `ihub.sftp`, `ihub.mllp`, `ihub.kafka`, `ihub.custom_connectors`, `ihub.replay`)                                                                                                                                                                                                                                                                                                                                                                                                               |
| Primary roles   | IT Admin / Helpdesk (56 — connector config & monitoring), Integration Engineer (custom role cloned from IT Admin), Super Admin (SaaS — global connector catalogue)                                                                                                                                                                                                                                                                                                                                                                                 |
| Secondary roles | Lab Manager / Radiology Manager (see own device connectors), Accounts (ERP export status), Hospital Admin (approve new external connections), Auditor (58), DPO (57 — data-flow register for DPDP)                                                                                                                                                                                                                                                                                                                                                 |
| Regulatory      | DPDP Act 2023 & Rules 2025 (data-processing agreements with each external processor, purpose limitation, cross-border transfer rules, breach notification, **record of processing / data-flow register**), CERT-In 2022 directions (log retention 180 days, incident reporting 6 h, NTP sync), ABDM technical/security standards (EN-011), NABH IMS (interface validation, downtime procedures), HL7 v2.x / FHIR R4 conformance (EN-019), ISO 27001 A.5.19–A.5.23 (supplier & cloud service security), IT Act §43A (reasonable security practices) |

## 1. Purpose

EN-017 is the middleware backbone: one place where every external system connection is registered, configured, secured, scheduled, mapped, monitored and replayed. It provides protocol adapters (REST, SOAP, HL7 v2 MLLP, ASTM, FHIR, SFTP/file, JDBC, SMPP, MQTT, WebSocket, webhook), a declarative field-mapping and transformation DSL, sync scheduling (real-time, near-real-time, batch), resilient delivery (idempotency, retry with exponential backoff, circuit breakers, dead-letter queue with manual review and replay), a searchable message log with automatic PHI redaction, and a connector SDK so new integrations are configuration + a thin adapter rather than bespoke code scattered across modules.

## 2. Users & Jobs-to-be-done

- **IT Admin / Integration Engineer** (desktop): register a connector, paste credentials, map fields, test with a sample payload, enable, then live-monitor health; triage the DLQ every morning; replay failed messages after fixing a mapping.
- **Lab / Radiology Manager**: see whether analyzer #7 or the PACS worklist is green; know when the last result arrived; raise a ticket with an error id.
- **Accounts**: confirm the nightly Tally/ERP journal export succeeded and download the exception file.
- **Hospital Admin**: approve a new external data flow (DPDP purpose + processor agreement), review the data-flow register.
- **DPO**: export the record of processing activities showing what personal data leaves the hospital, to whom, why, and with what safeguards.
- **Developer (partner)**: build a custom connector using the SDK and register it against the hospital tenant.
- **On-call engineer** (phone): receive a circuit-breaker alert, see the failing connector, pause/resume it from mobile.

## 3. Core Workflows

### 3.1 Connector registration & lifecycle

1. IT Admin picks a template from the **connector catalogue** (pre-built: Razorpay, MSG91/Gupshup/Twilio, WhatsApp Cloud API, SMTP/SES, ABDM, NHCX, CoWIN/U-WIN, Orthanc/DICOM, lab analyzers by vendor, Tally, e-Hospital NIC, biometric devices eSSL/Matrix, ONVIF NVR, PMJAY TMS, LIS/RIS/EMR of another hospital, generic REST/SOAP/SFTP) or **Custom** → names the instance, selects branch scope → `ihub_connectors` (status `draft`).
2. **Endpoint & auth**: base URL/host/port, protocol adapter, auth type (none / api_key / basic / OAuth2 client-credentials with token cache / OAuth2 authorization-code / JWT bearer / mTLS client cert / HMAC request signing / SFTP key), credentials written to **Vault/pgcrypto**, never displayed after save; TLS options (pinning, custom CA for on-prem devices); proxy/egress IP.
3. **Direction & operations**: inbound (they call us / we listen), outbound (we call them), or bidirectional; define **operations** (e.g. `createOrder`, `getStatus`, `pushADT`, `pullResults`) each with method/path/SOAP action/message type, request & response schema refs, timeout, idempotency strategy.
4. **Mapping** (§3.3) and **schedule** (§3.4) are attached, then **Test** in sandbox mode with a sample payload → response viewer with mapping trace → `ready`.
5. **Approval**: connectors that transmit personal data require Hospital Admin approval with DPDP fields (purpose, data categories, retention at processor, cross-border?, DPA reference) → status `active` → Event `integration.connector.activated`.
6. **Versioning**: any change to endpoint/mapping/auth creates a new connector version; the previous version stays for message-log interpretation; rollback in one click.
7. **Decommission**: `paused` → `retired`; queued messages must be drained or explicitly discarded with reason; credentials revoked; data-flow register updated.

### 3.2 Message flow (outbound)

1. A module emits a domain event or calls `IntegrationHub.dispatch({connector, operation, payload, refType, refId, idempotencyKey, priority})` → hub validates against the operation's **input contract** (Zod/JSON-Schema) → creates `ihub_messages` row (`queued`) with a redacted preview.
2. **Transformation**: source → canonical → target (§3.3), producing the wire payload; canonicalisation failures fail fast into the DLQ with a mapping-error code (never a silent drop).
3. **Delivery** by a BullMQ worker in the connector's own queue (per-connector concurrency & rate limit): adapter call with timeout, TLS, auth token from cache, **Idempotency-Key** propagated where the partner supports it → response captured → status `sent`/`acknowledged`/`failed`.
4. **Retry policy** per connector: max attempts (default 5), backoff `base * 2^n` with jitter (default 5 s → 10 s → 40 s → 3 min → 15 min), retry only on retryable classes (network, 5xx, 429 with Retry-After, timeout); non-retryable (400/401/403/422 semantic) go straight to DLQ.
5. **Circuit breaker** per connector+operation: opens after N consecutive failures or an error rate > X % in a rolling window → all further messages are parked in `blocked` state, an alert fires, and a half-open probe runs every `cool_down` (default 60 s) until success closes it → Events `integration.circuit.opened|closed`.
6. **Ordering**: optional FIFO per partition key (e.g. per patient, per analyzer) so ADT A01 precedes A08; out-of-order arrivals are held briefly and re-sequenced.

### 3.3 Field mapping & transformation DSL

- Mappings are **data, not code**: `ihub_mappings` holds a declarative document — `source_path` (JSONPath / HL7 segment-field-component `PID-5.1` / XPath / CSV column) → `target_path`, with `transform` steps chained: `trim`, `upper`, `date_format(from,to,tz)`, `split/join`, `concat(template)`, `lookup(value_set)`, `code_translate(system_from, system_to)` (delegated to EN-027 concept maps: ICD-10 ↔ ICD-11, local test code ↔ LOINC, drug code ↔ SNOMED), `default(value)`, `conditional(when, then, else)`, `mask(phi_rule)`, `unit_convert(from,to)`, `regex_extract`, `pad`, `checksum`, `custom(js_snippet)` (sandboxed QuickJS, 50 ms CPU cap, no I/O).
- **Canonical model**: every connector maps to/from the HMS canonical objects (Patient, Encounter, Order, Result, Document, Charge, Payment, Item, StockMove, Employee, Attendance) so N connectors need N mappings, not N².
- **Validation rules** per field (required, regex, enum from value set, range) with `on_error` = `fail | default | drop_field | quarantine`.
- **Mapping tester**: paste a sample source payload → see field-by-field trace (source value → each transform step → target value) with errors highlighted; sample library stored per connector for regression tests; a mapping cannot be activated until its stored samples all pass.

### 3.4 Sync scheduling & polling

- Modes: **event-driven** (outbox subscription with a filter expression), **webhook inbound** (signature verified, replay-protected), **scheduled pull** (cron per connector, e.g. `*/15 * * * *` for TPA claim status, `0 2 * * *` for the nightly ERP export), **file drop** (SFTP/local folder watcher with archive & error folders, PGP decryption optional), **streaming listener** (MLLP socket, ASTM serial/TCP, MQTT topic, WebSocket).
- **Watermarks** for incremental pulls (`last_synced_at`, `last_cursor`) with overlap window to avoid gaps; back-fill run with a date range on demand.
- **Windows & throttles**: allowed time window (e.g. no ERP export during month-end close), max messages/minute, max concurrent, quiet hours.

### 3.5 Inbound handling

1. Inbound webhook/listener → **authenticate** (HMAC signature, mTLS, API key, IP allowlist — shared with EN-026), **deduplicate** by provider message id, persist raw message (`ihub_messages` direction `in`, raw stored encrypted with PHI redaction applied to the searchable copy), **acknowledge fast** (HTTP 200 / MLLP ACK) then process asynchronously.
2. Transform → canonical → dispatch to the owning module's handler (`lab.result.received`, `payment.webhook.received`, `abdm.consent.notification`, `attendance.punch.received`) with at-least-once semantics; handler idempotency keyed on provider message id.
3. Processing failure → NACK/retry, then DLQ; malformed message → `parse_error` bucket with the raw payload preserved for vendor escalation.

### 3.6 Dead-letter queue, triage & replay

- DLQ entries carry: connector, operation, direction, error class & message, attempt history, redacted payload, correlation id, first/last seen, occurrence count (grouped by fingerprint so 500 identical failures are one triage item).
- Actions: **Retry now**, **Retry with edited payload** (audited, requires `ihub.message.edit`), **Replay range** (all messages for connector X between T1 and T2 — with a dry-run count first), **Discard with reason**, **Create ticket** (NC-028), **Suppress fingerprint** (temporarily, with expiry).
- Replay is idempotent by design: replayed messages reuse the original idempotency key unless the operator explicitly chooses "force new".

### 3.7 Health monitoring & dashboard

- Per connector: RAG status (green/yellow/red) from success rate, latency p95, queue depth, circuit state, last success time, last error; **uptime %** over 24 h/7 d/30 d; message volume sparkline; SLA thresholds configurable per connector.
- Synthetic **health checks** (ping/echo operation) on a cron so a silent connector is still known to be alive; "no message received in N minutes" alarms for expected-traffic connectors (e.g. an analyzer that always sends results in working hours).
- **Data-flow diagram**: auto-generated graph of modules → connectors → external systems, with direction, data categories and PHI flags — exported as the DPDP data-flow register (source requirement: "data flow diagram").

### 3.8 Connector SDK (`ihub.custom_connectors`)

- A connector package is `manifest.json` (id, version, protocols, operations, config schema, required secrets, health check, capability flags) + adapter implementing `connect/dispatch/receive/healthCheck/close` in TypeScript, plus default mappings and sample payloads.
- Packages are signed and installed per tenant; run inside the worker with resource limits and no direct DB access (they receive/return canonical objects only); a `sandbox` mode records all outbound calls without sending.
- Versioning/compat matrix; SDK docs and a `create-vims-connector` scaffold; certification checklist before publishing to the shared catalogue.

### 3.9 Exceptions

- **Partner credential expiry** (OAuth refresh fails, cert expiring) → detected by health check → alert 30/7/1 days ahead; connector auto-pauses on hard auth failure rather than hammering.
- **Schema drift** (partner adds/renames a field) → validation error class `schema_drift` grouped separately with a diff view of received vs expected.
- **Hospital network outage / on-prem device offline** → messages queue locally (durable Redis + Postgres outbox), analyzers buffer; on restore, ordered drain with a rate cap.
- **Poison message** (repeatedly crashes the handler) → auto-quarantine after 3 crashes, never blocks the queue.

## 4. Data Model (schema `integration`, prefix `ihub_`)

- `ihub_connectors` — id, hospital_id, branch_id?, key citext, name, category enum(clinical/diagnostic/financial/messaging/government/erp/device/security/other), template_id?, adapter (package id + version), protocol enum(rest/soap/hl7v2_mllp/astm/fhir/sftp/file/jdbc/smpp/mqtt/websocket/webhook/dicom), direction enum(in/out/both), environment enum(sandbox/production), endpoint jsonb (url/host/port/path/soap_action/topic), auth_type, credentials_ref (Vault path), tls jsonb (verify, ca_ref, client_cert_ref, pinned_sha256), egress jsonb (proxy, ip), status enum(draft/ready/active/paused/failing/retired), version int, owner_user_id, vendor_contact jsonb, dpdp jsonb (purpose, data_categories[], contains_phi bool, cross_border bool, dpa_ref, retention_at_processor), sla jsonb (success_pct, latency_p95_ms, max_queue), created…; UNIQUE(hospital_id, key, version).
- `ihub_operations` — id, connector_id, key, name, method/message_type, path/segment, request_schema_ref, response_schema_ref, timeout_ms, idempotency (none/key_header/natural_key), partition_key_expr, retry_policy jsonb, circuit_policy jsonb, rate_limit jsonb, active.
- `ihub_mappings` — id, connector_id, operation_id?, direction, name, version, spec jsonb (rules[]: source_path, target_path, transforms[], validate, on_error), canonical_type, value_set_refs jsonb (EN-027 concept maps), status (draft/active/retired), activated_by/at; `ihub_mapping_samples` (mapping_id, name, source_payload jsonb, expected_target jsonb, last_run_status).
- `ihub_schedules` — id, connector_id, operation_id, mode enum(event/webhook/cron/file_watch/listener), event_filter jsonb, cron, timezone, window jsonb (allowed hours/days), watermark jsonb (last_synced_at, cursor), overlap_sec, throttle jsonb, next_run_at, last_run_at, last_run_status, enabled.
- `ihub_messages` — id (uuidv7), hospital_id, connector_id, connector_version, operation_id, direction, correlation_id, parent_message_id?, ref_type, ref_id, idempotency_key, partition_key, priority, status enum(queued/in_flight/sent/acknowledged/failed/dead_lettered/blocked/discarded/replayed), attempts int, next_attempt_at, http_status/ack_code, latency_ms, error_class, error_code, error_text, payload_redacted jsonb, payload_ref (encrypted object-store key for full payload), response_redacted jsonb, size_bytes, contains_phi bool, created_at, sent_at, completed_at; **partitioned monthly** (pg_partman); indexes (hospital_id, connector_id, created_at desc), (status, next_attempt_at), (correlation_id), (idempotency_key) unique-per-connector where not null.
- `ihub_dlq` — id, hospital_id, connector_id, operation_id, fingerprint (hash of error_class+code+mapping path), first_seen_at, last_seen_at, occurrences, sample_message_id, status enum(open/retrying/resolved/discarded/suppressed), assigned_to, ticket_ref, resolution_note, suppressed_until.
- `ihub_circuit_state` — connector_id, operation_id, state enum(closed/open/half_open), consecutive_failures, error_rate, opened_at, next_probe_at, last_transition_reason.
- `ihub_health_checks` — id, connector_id, kind (ping/echo/expect_traffic), config jsonb, last_run_at, last_status, consecutive_failures, uptime_24h, uptime_7d, uptime_30d, latency_p95_ms.
- `ihub_credentials_audit` — connector_id, action (created/rotated/revoked/viewed_masked), actor, at (values never stored).
- `ihub_connector_packages` — id, package_key, version, publisher, signature, manifest jsonb, capabilities, installed_for_hospitals uuid[], status.
- `ihub_data_flows` (materialised) — hospital_id, source_module, connector_id, external_system, direction, data_categories, contains_phi, cross_border, legal_basis, refreshed_at.
- Retention: message metadata 180 days online (CERT-In) then archived 2 years; **full payloads 30 days** (encrypted, PHI-bearing) unless the connector is marked `retain_payload_days` higher for legal reasons; DLQ items retained 1 year.

## 5. Business Rules & Validations

- No connector may go `active` without: credentials stored in the secret store, at least one activated mapping with all samples passing, a health check defined, an owner, and (for PHI-carrying connectors) Hospital Admin approval with DPDP metadata.
- Credentials are write-only from the UI (masked forever after save); rotation is a first-class action with an audit entry; secrets never appear in message logs, exports or errors.
- **PHI redaction is mandatory on the searchable copy** of every message: name, address, phone, email, Aadhaar/ABHA, UHID (last 4 kept), DOB (year kept), free-text clinical notes → replaced with typed tokens (`«name»`, `«phone:9876»`); the full payload is stored encrypted with access requiring `ihub.payload.read` and is itself audited as a PHI read.
- Idempotency: every outbound message carries a key derived from `(connector, operation, refType, refId, version)` unless the caller supplies one; duplicate dispatch within the retention window returns the original message id rather than sending twice.
- Retries never apply to non-idempotent operations without a partner-supported idempotency key — such operations fail to DLQ for human decision instead.
- Circuit breaker state is per connector+operation and shared across worker instances (Redis); a manual `force_close` requires `ihub.connector.manage` and a reason.
- Replay of more than 1000 messages requires a dry-run and a second confirmation; replay never re-triggers patient-facing notifications unless explicitly ticked (`suppress_side_effects` default true).
- Mapping `custom(js)` snippets are sandboxed, time-boxed (50 ms), have no network/DB access, and are code-reviewed before activation (flagged in the approval).
- Cross-border connectors (data leaving India) must record the DPDP legal basis and are listed separately in the data-flow register; blocked by default until Admin approves.
- On-prem deployments: every connector must be able to run without internet except those explicitly marked `requires_internet`; the hub reports which functions are degraded when the WAN is down.
- Message log rows are append-only; status transitions are recorded, never overwritten by deletion.

## 6. API Surface (`/api/v1/integration`)

| Method         | Path                                                                                     | Purpose                          | Permission                                         | Notes                         |
| -------------- | ---------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------- | ----------------------------- |
| GET            | /catalogue                                                                               | pre-built connector templates    | `ihub.connector.read`                              |                               |
| GET/POST/PATCH | /connectors ; /connectors/:id                                                            | registry CRUD                    | `ihub.connector.manage`                            | versioned; secrets write-only |
| POST           | /connectors/:id/activate \| /pause \| /resume \| /retire \| /rotate-credentials \| /test | lifecycle                        | `ihub.connector.manage` (+ Admin approval for PHI) | audited                       |
| GET/POST/PATCH | /connectors/:id/operations                                                               | operations                       | `ihub.connector.manage`                            |                               |
| GET/POST/PATCH | /mappings ; /mappings/:id/activate ; POST /mappings/:id/test                             | mapping DSL                      | `ihub.mapping.manage`                              | sample-gated activation       |
| GET/POST/PATCH | /schedules ; POST /schedules/:id/run-now ; POST /schedules/:id/backfill                  | scheduling                       | `ihub.schedule.manage`                             | backfill needs date range     |
| POST           | /dispatch                                                                                | internal dispatch (module → hub) | service token, `ihub.message.dispatch`             | Idempotency-Key               |
| GET            | /messages?connector&status&from&to&ref&correlation&q                                     | message log (redacted)           | `ihub.message.read`                                | cursor, partition-aware       |
| GET            | /messages/:id ; GET /messages/:id/payload                                                | detail / full payload            | `ihub.message.read` / `ihub.payload.read`          | payload read audited as PHI   |
| POST           | /messages/:id/retry \| /discard \| /edit-retry                                           | single message actions           | `ihub.message.retry` / `ihub.message.edit`         | reason                        |
| GET            | /dlq?connector&fingerprint&status ; POST /dlq/:id/resolve \| /suppress \| /assign        | DLQ triage                       | `ihub.dlq.manage`                                  | grouped by fingerprint        |
| POST           | /replay {connector, from, to, filter, dryRun, suppressSideEffects}                       | bulk replay                      | `ihub.message.replay`                              | dry-run first > 1000          |
| GET            | /health ; /health/:connectorId ; POST /health/:connectorId/check                         | health                           | `ihub.health.read`                                 | WS `ihub:health`              |
| GET            | /circuits ; POST /circuits/:id/close                                                     | circuit breakers                 | `ihub.connector.manage`                            | reason                        |
| GET            | /data-flows ; GET /data-flows/export                                                     | DPDP register + diagram          | `ihub.dataflow.read` (DPO, Admin, Auditor)         | CSV/PNG/Mermaid               |
| GET/POST       | /packages ; POST /packages/:id/install \| /uninstall                                     | connector SDK packages           | `ihub.package.manage` (Super Admin)                | signature verified            |
| POST           | /webhooks/:connectorKey                                                                  | inbound webhook endpoint         | signature-verified public                          | dedupe, fast-ack              |
| GET            | /reports/volume ; /reports/errors ; /reports/latency ; /reports/uptime                   | reports                          | `ihub.report.read`                                 |                               |

## 7. Domain Events (outbox)

- `integration.connector.created|activated|paused|retired|credentials_rotated` → EN-024, EN-023 (SIEM), DPO register refresh.
- `integration.message.dispatched|sent|failed|dead_lettered|replayed|discarded` → module callbacks, EN-001 analytics.
- `integration.circuit.opened|closed` → EN-037 (on-call page), NC-028 ticket auto-create, EN-018 (IT status board).
- `integration.dlq.item_opened|resolved` → IT dashboard.
- `integration.health.degraded|restored` (per connector, RAG transition) → EN-037, EN-007 status panel.
- `integration.schema.drift_detected` → connector owner + vendor contact.
- `integration.credential.expiring` (30/7/1 days) → IT Admin.
- Consumes: any module event subscribed via `ihub_schedules.event_filter` (e.g. `bill.finalized` → ERP export, `lab.order.created` → analyzer download, `patient.registered` → HL7 ADT^A04).

## 8. Screens (UI)

- **Integration Dashboard** (desktop + wall TV for the IT room): grid of connector cards with RAG status, last success, queue depth, error rate sparkline, circuit chips; filters by category/branch; red cards float to the top; auto-refresh via WS (< 2 s); click → connector detail.
- **Connector Detail** (desktop): tabs — Overview (health, SLA, uptime, volume charts), Configuration (endpoint, auth with masked secrets, TLS), Operations, Mappings, Schedules, Messages, DLQ, Audit; actions bar (Test, Pause, Rotate, Retire) with confirmation modals.
- **Connector Wizard** (desktop, 5 steps): template → connection & auth (with "Test connection" button) → operations → mapping (visual mapper) → schedule & activate. Inline validation, "Save as draft" at every step.
- **Visual Field Mapper** (desktop, wide): left = source schema tree (from a sample payload or imported schema), right = canonical/target tree, centre = drag-to-map lines with a transform chip per line; bottom = live sample trace showing value at each transform step; keyboard: `/` search field, `T` add transform, `Ctrl+R` run sample.
- **Message Log** (desktop): virtualised table (time, connector, operation, direction, ref, status, latency, attempts), advanced filter bar, correlation-id trace view showing the full chain across connectors and modules; row drawer with redacted payload, "reveal full payload" button (step-up auth + audit), response, error stack, retry/discard actions. Shortcuts `F` filter, `R` retry, `C` copy correlation id.
- **DLQ Triage** (desktop): grouped by fingerprint with occurrence counts, sample payload, suggested cause, bulk actions, assign to engineer, link to ticket.
- **Replay Console** (desktop): connector + time range + filter → dry-run count and preview → confirm → progress bar with success/failure tallies.
- **Data-Flow Register** (desktop, DPO): table of flows with PHI/cross-border chips + auto-generated diagram (Mermaid/graph) + export for the DPDP record of processing.
- **Mobile IT view** (phone): red connectors only, pause/resume, ack alert.
- Empty/error states: "No connectors yet — start from a template", "Connector paused since 14:02 by A. Kumar (reason: vendor maintenance)", "Payload purged after 30-day retention — metadata retained".

## 9. Integrations

Adapters shipped in Phase 0–3: **REST** (JSON/XML, OAuth2/HMAC/mTLS), **SOAP 1.1/1.2** (WSDL import, WS-Security UsernameToken/X.509), **HL7 v2.x over MLLP** (framing, ACK/NACK, Z-segments — semantics in EN-019), **ASTM E1381/E1394** (serial/TCP for analyzers, EN-004), **FHIR R4** (client & server facade, EN-019), **DICOM** (C-FIND/C-STORE/MWL via Orthanc, EN-008), **SFTP/FTPS/file-watch** (CSV/fixed-width/XML/Excel, PGP), **JDBC** (read-only pulls from legacy HIS during migration EN-036), **SMPP/HTTP SMS**, **MQTT** (IoT/EN-042), **WebSocket**, **webhooks**. Government/enterprise: ABDM (EN-011), NHCX (RC-001), PMJAY TMS (RC-007), CoWIN/U-WIN (OP-013), e-Hospital NIC push, Tally XML / SAP IDoc / Oracle Financials (NC-009), state health-department reporting. Infrastructure: Redis Streams + BullMQ, Vault/SSM, OpenTelemetry traces propagated with W3C `traceparent` so a message can be traced end-to-end.

## 10. Reports & Analytics

- Connector health report (uptime %, MTTR, incidents), message volume by connector/day/hour with peaks, error taxonomy (top error codes and their trend), latency distribution p50/p95/p99 per operation, DLQ ageing and resolution time, replay history, credential/certificate expiry calendar, cost/quota consumption where partners meter (SMS units, payment API calls), schema-drift log, DPDP data-flow register. Read-models `analytics.mv_ihub_hourly` (counts, errors, latency per connector) and `analytics.mv_ihub_daily`.

## 11. Notifications

- IT/on-call: circuit opened, connector red > 5 min, DLQ new fingerprint, DLQ depth threshold, health check failing, credential expiring, cross-border connector activated, poison message quarantined. Escalation ladder via EN-037 (in-app → SMS → phone call) with quiet-hour rules for non-critical connectors.
- Module owners: "your nightly ERP export failed", "3 lab results could not be filed".
- Admin/DPO: monthly integration health summary, new external data flow awaiting approval.
- TV (EN-018): IT operations board showing red connectors.

## 12. Permissions (RBAC keys)

`ihub.connector.read` (IT, Admin, dept managers for own connectors via ABAC) · `ihub.connector.manage` (IT Admin, Integration Engineer) · `ihub.mapping.manage` (Integration Engineer) · `ihub.schedule.manage` (IT Admin) · `ihub.message.dispatch` (service accounts/modules) · `ihub.message.read` (IT, dept manager scoped) · `ihub.payload.read` (IT lead + DPO; step-up auth, audited as PHI read) · `ihub.message.retry` (IT Admin) · `ihub.message.edit` (Integration Engineer, audited) · `ihub.message.replay` (IT Admin, dual confirm) · `ihub.dlq.manage` (IT) · `ihub.health.read` (IT, Admin, HODs) · `ihub.dataflow.read` (DPO, Admin, Auditor) · `ihub.package.manage` (Super Admin) · `ihub.report.read`.

## 13. Non-functional

- Enterprise volumes: 2000-bed hospital ≈ **1.5–2 M messages/day** (30 analyzers × 20k tests, PACS worklist/status, 30k SMS/WhatsApp, ADT feeds, payment webhooks, IoT vitals). Target throughput ≥ 3000 msg/s aggregate across workers; per-connector concurrency configurable (default 8).
- Dispatch overhead (validate + map + enqueue) p95 < 15 ms; end-to-end hub latency (excluding partner) p95 < 100 ms; MLLP ACK < 200 ms.
- Message-log writes are batched and partitioned monthly; a month of logs must be droppable in < 1 s (partition detach). Storage budget ≈ 60 GB/month metadata + payload objects in S3 with lifecycle to cold storage at 30 days.
- Resilience: at-least-once delivery with idempotency; no message loss on worker crash (Postgres outbox + Redis ack); graceful drain on deploy; connectors isolated so one bad partner cannot starve others (separate queues + bulkheads).
- On-prem: the hub runs fully offline for LAN devices (analyzers, PACS, biometric); internet-dependent connectors show a distinct `waiting_for_wan` state instead of failing.
- Observability: OpenTelemetry spans per message, correlation id in every log line, RED metrics per connector exported to Prometheus, no PHI in traces/metrics.
- Accessibility & i18n: dashboard WCAG 2.2 AA, colour-blind-safe RAG (icon + text), English-only technical UI acceptable but error messages surfaced to clinical users are localised.

## 14. Acceptance Criteria

1. Given a new REST connector is configured with OAuth2 client credentials, when "Test connection" is pressed, then a token is fetched, a sample operation runs in sandbox mode, and the credentials are never returned to the browser in clear text.
2. Given a mapping with a stored sample, when an engineer edits a transform that breaks the sample, then activation is blocked with the failing field, source value and step highlighted.
3. Given an outbound message receives HTTP 503, when the retry policy allows 5 attempts, then the message is retried with exponential backoff and jitter, and each attempt is recorded with its own latency and error.
4. Given 10 consecutive failures on a connector operation, when the threshold is reached, then the circuit opens, subsequent messages are parked as `blocked` rather than attempted, an alert reaches the on-call engineer within 60 s, and a half-open probe closes the circuit automatically once the partner recovers.
5. Given a message fails with HTTP 422 (semantic error), when the failure is processed, then it is not retried and lands in the DLQ grouped under its fingerprint with the sample payload attached.
6. Given 500 identical DLQ failures caused by one bad mapping, when the engineer fixes the mapping and replays that fingerprint, then all 500 are re-processed with the original idempotency keys, patient-facing notifications are suppressed by default, and the resulting successes close the DLQ item.
7. Given a message log search, when any user views a message, then names, phone numbers and clinical text appear as redaction tokens, and revealing the full payload requires step-up auth and writes a PHI-read audit entry.
8. Given the same event is dispatched twice with the same idempotency key, when the second dispatch arrives, then no second outbound call is made and the original message id is returned.
9. Given the WAN is down for 30 minutes, when connectivity returns, then queued cloud-bound messages drain in order at the configured rate cap without duplicates, and LAN connectors (analyzers, PACS) show no interruption.
10. Given an analyzer sends results out of order, when FIFO partitioning by accession is enabled, then results are delivered to the LIS in the correct sequence.
11. Given a connector transmits personal data outside India, when an admin tries to activate it, then activation requires DPDP metadata (purpose, categories, legal basis, DPA reference) and Hospital Admin approval, and the flow appears flagged in the data-flow register.
12. Given a partner adds an unexpected field, when the inbound message is validated, then the message still processes (unknown fields ignored) but a `schema.drift_detected` event is raised with a diff for the connector owner.
13. Given a custom mapping snippet contains an infinite loop, when it executes, then the sandbox aborts at 50 ms, the message goes to DLQ with `mapping_timeout`, and no worker thread is blocked.
14. Given message retention is 30 days for payloads, when the retention job runs, then payload objects older than 30 days are deleted while message metadata remains searchable for 180 days.
15. Given the health dashboard, when a connector has had no traffic for longer than its `expect_traffic` window during working hours, then it turns yellow and an alert is raised even though no error occurred.
16. Given an operator initiates a replay of 5000 messages, when they confirm, then a dry-run count is shown first, a second confirmation is required, and progress is reported with per-message outcomes.

## 15. Enhancements / Later phases

- Visual **flow builder** (multi-step orchestration: fan-out, aggregation, enrichment, conditional routing) beyond one-hop mappings.
- Kafka/Redpanda transport option for very high-volume tenants and a change-data-capture (Debezium) source for analytics replication.
- Contract testing against partner sandboxes in CI; auto-generated connector docs from manifests.
- ABDM Health Information Exchange breadth (EN-011 M2/M3) and NHCX claims exchange as first-class catalogued flows; e-Hospital (NIC) push; PMJAY/CGHS/ESIC scheme connectors (source enhancements).
- IoT device gateway convergence with EN-042 (MQTT topic registry, device provisioning, cold-chain sensors).
- Blockchain/hash anchoring of the consent and message audit trail (source enhancement) via EN-016 anchoring.
- AI-assisted mapping suggestion (given a sample payload, propose field mappings and value-set translations) and anomaly detection on message volume/latency (AI-005).
- Self-service partner portal where a vendor can view their own connector's health and errors (extends EN-026 developer portal).
- Multi-region active-active hub with message affinity for group hospitals.

## 16. Open Questions for the Hospital

1. Full inventory of external systems to integrate at go-live (name, vendor, version, protocol, contact, sandbox availability) — especially legacy HIS/LIS/RIS being replaced or run in parallel.
2. Which analyzers and modalities are on the LAN, their exact HL7/ASTM versions, and whether bidirectional (order download) is supported by each.
3. Accounting/ERP system (Tally? SAP? Oracle?) and the required export format, frequency and cut-off.
4. Which partners support idempotency keys and webhook signatures? What are their rate limits and support SLAs?
5. Data residency: does any integration send personal data outside India? Are DPAs in place with each processor?
6. Retention required for message payloads (30 days default) — any legal/vendor-dispute reason to keep longer?
7. Who is the on-call owner per connector class (lab, PACS, payments, government), and what is the escalation path outside working hours?
8. Is there an existing enterprise ESB/iPaaS (MuleSoft, Boomi, WSO2) the hospital wants EN-017 to sit behind rather than replace?
9. Network topology: outbound proxy/egress IPs, firewall change process, VPN/leased line to government endpoints (ABDM/NHCX), NTP source (CERT-In requirement).
10. Change-control expectations for mapping edits in production (who approves, is a maintenance window required)?
