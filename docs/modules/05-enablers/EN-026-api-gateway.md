# EN-026 — API Gateway (API Registry, Key & JWT Authentication, Scopes, Rate Limits & Quotas per Tenant, Versioning & Deprecation, Request Signing, IP Allowlists, Developer Portal, Usage Analytics, Webhook Subscriptions with HMAC)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-026 |
| Phase | 0/11 |
| Priority | P1 |
| Complexity | High |
| Depends on | EN-025 (SSO/OAuth2 authorisation server — token issuance for user/app contexts), EN-007 (users, permissions, settings, service accounts), EN-024 (audit of API access, PHI reads), EN-023 (WAF, rate-limit anomalies, key compromise response), EN-017 (Integration Hub — the *outbound* counterpart; EN-026 governs *inbound*), EN-019 (HL7/FHIR endpoints published through the gateway), EN-011 (ABDM callbacks), EN-010 (payment webhooks inbound), EN-009 (messaging delivery webhooks), EN-012 (website widgets), PE-006/PE-007/PE-008 (corporate/referrer/TPA portals as API consumers), EN-028 (consent gating on PHI-bearing APIs), EN-040 (licence/plan → quota tiers), EN-041 (tenant/branch scoping in tokens) |
| Feature flag | `module.api_gateway.enabled` (sub: `gateway.dev_portal`, `gateway.webhooks`, `gateway.request_signing`, `gateway.mtls`, `gateway.usage_billing`) |
| Primary roles | IT Admin (56 — configure, monitor), Integration Engineer, Super Admin (SaaS — global API catalogue, plan quotas) |
| Secondary roles | Hospital Admin (2 — approve partner access, PHI scopes), Privacy Officer (57 — data-flow register, consent gating), partner **developer** (external, via the developer portal), Auditor (58), Finance (usage-based billing where applicable) |
| Regulatory | DPDP Act 2023 & Rules 2025 (purpose limitation and consent for every external data flow, processor agreements, breach notification, cross-border transfer records), CERT-In Directions 2022 (API access logs 180 days in India, incident reporting), ABDM API security requirements (EN-011), NABH IMS (controlled external access to clinical data), ISO 27001 A.8.9/A.8.21 (configuration and network-services security), OWASP **API Security Top 10** (BOLA/broken object-level authorisation, broken authentication, unrestricted resource consumption, SSRF), PCI-DSS SAQ-A boundary (no card data traverses our APIs — EN-010 tokenises), IT Act §43A |

## 1. Purpose
EN-026 is the front door for everything that calls Vim's HMS from outside a browser session: partner systems, the patient/corporate/TPA portals, website widgets, FHIR/HL7 consumers (EN-019), mobile apps, payment and messaging webhooks, and the hospital's own scripts. It provides a governed **API registry**, authentication by API key or OAuth2/JWT with fine-grained scopes, per-tenant and per-app rate limits and quotas, versioning with an enforced deprecation policy, optional request signing and mTLS, IP allowlists, a self-service **developer portal** with sandbox, usage analytics, and outbound **webhook subscriptions** signed with HMAC so partners can receive events instead of polling.

## 2. Users & Jobs-to-be-done
- **Integration Engineer / IT Admin** (desktop): register an API product, issue credentials to a partner, set quotas, watch latency and error rates, revoke a leaked key in seconds.
- **Partner developer** (developer portal, external): read the docs, get a sandbox key, try endpoints in the browser, subscribe to webhooks, see their own usage and errors without raising a ticket.
- **Hospital Admin**: approve a partner's access to PHI-bearing APIs with a stated purpose and DPA reference; see who can reach what.
- **Privacy Officer**: view the external data-flow register (with EN-017), confirm consent gating on every PHI endpoint, and pull the access report for a DSAR.
- **Super Admin (SaaS)**: define plan-based quota tiers, spot a tenant whose partner is hammering the API, publish a global API catalogue and deprecation calendar.
- **On-call engineer**: identify in one screen whether a latency spike is one abusive client or a real backend problem — and throttle that client without a deploy.

## 3. Core Workflows

### 3.1 API registry & product definition
1. Every externally reachable endpoint must be registered in the **API registry** — an endpoint that is not registered is not routable from outside (deny-by-default at the edge). Registration is generated from the OpenAPI 3.1 spec that NestJS already produces, then curated.
2. APIs are grouped into **API products**: `patient-booking` (slots, appointments), `reports-download`, `fhir-clinical` (EN-019), `hl7-ingest`, `billing-and-payments`, `insurance-preauth` (TPA), `corporate-employee-health`, `referrer-portal`, `website-widgets`, `admin-automation`, `webhooks-outbound`. Each product carries: description, version, scopes, data classes (PHI/financial/operational), default quota tier, consent requirement, docs, sandbox availability and support contact.
3. Each endpoint entry: method, path, version, product, required scopes, permission mapping (into EN-007's RBAC), PHI flag, idempotency support, pagination style, timeout, cache policy, rate-limit class, deprecation status.
4. **Publication states**: draft → sandbox → published → deprecated → sunset. Only `published` endpoints appear in the partner-facing catalogue.

### 3.2 Client (app) onboarding & credentials
1. A partner requests access through the developer portal or an IT Admin creates the client: name, organisation, contacts, purpose, requested products/scopes, environments (sandbox/production), redirect URIs (for user-context OAuth flows), IP allowlist, webhook endpoints.
2. **Approval**: sandbox access is self-service; **production access to PHI-bearing products requires Hospital Admin approval** with DPDP fields (purpose, data categories, retention at the partner, cross-border?, DPA reference) — the same metadata EN-017 records for outbound flows, so the DPO sees one complete register.
3. **Credential types**:
   - **API key** (`vh_live_…` / `vh_test_…`): shown once, stored hashed (Argon2id/HMAC-SHA256 with a pepper), prefix + last 4 visible for identification; suitable for server-to-server, non-PHI or narrowly scoped access.
   - **OAuth2 client credentials** (confidential client, secret or **private-key JWT** per RFC 7523): issues short-lived access tokens (15 min) with scopes — preferred for PHI access because credentials rotate automatically and tokens are bounded.
   - **OAuth2 authorization code + PKCE** for user-context apps (SMART-on-FHIR via EN-025/EN-019, patient-authorised apps).
   - **mTLS** (`gateway.mtls`) for high-assurance partners (government, payer networks): client certificate pinned to the app.
4. **Key hygiene**: multiple active keys per app to allow zero-downtime rotation, expiry dates (default 12 months), last-used timestamp, automatic disable after 90 days unused, one-click revoke with immediate effect (denylist propagated to all edge nodes within 5 s).
5. Secrets are shown exactly once at creation; the portal nags until the partner confirms they have stored it.

### 3.3 Request pipeline (what happens to every call)
1. **Edge**: TLS 1.2+ termination, WAF rules (EN-023), DDoS/bot controls, request-size and header limits, JSON depth/size limits (a cheap defence against parser abuse).
2. **Route match** against the registry → unregistered path → `404` (never reveal internal routes).
3. **Authenticate**: API key (header `X-API-Key`) or `Authorization: Bearer <JWT>` (validated against EN-025's JWKS: signature, `iss`, `aud`, `exp`, `nbf`) or mTLS client cert. Anonymous endpoints (public doctor list, health check) are explicitly flagged as such.
4. **Verify request signature** (`gateway.request_signing`, required for money-moving and order-creating APIs): HMAC-SHA256 over `timestamp + method + path + sha256(body)` in `X-Signature`, with a ±5-minute timestamp window and a nonce replay cache. This is the same primitive we *verify* on inbound webhooks from Razorpay/Meta and *produce* on our outbound webhooks — one implementation, both directions.
5. **Authorise**: scope check → tenant resolution (subdomain, `X-Hospital-Id`, or the token's `hospital_id` claim) → RBAC/ABAC via EN-007 → **consent gate** (EN-028) for PHI-bearing endpoints → **object-level authorisation** (the OWASP API #1 failure: every object id in the path/body is re-checked against the caller's tenant and scope, never trusted because it was guessed).
6. **Rate limit & quota**: sliding-window limiter in Redis keyed by (app, endpoint class) and (tenant), plus a burst bucket; quota counters per day/month; `429` with `Retry-After`, `X-RateLimit-Limit/Remaining/Reset` headers on every response.
7. **Idempotency**: for POSTs that create money or orders, `Idempotency-Key` is required; the gateway stores the first response for 24 h and replays it verbatim on retry.
8. **Proxy** to the internal service with a propagated `traceparent`, `X-Request-Id`, tenant context and the resolved principal; response headers stripped of internals; errors normalised to **RFC 9457 problem+json** with stable `type` URIs.
9. **Log**: `api_access_log` entry (redacted), metrics (RED: rate/errors/duration) to Prometheus, PHI reads mirrored into EN-024 audit, security-relevant events to EN-023.

### 3.4 Rate limits, quotas & tiers
- **Tiers** (`free/sandbox`, `standard`, `partner`, `internal`) define: requests/second burst, requests/minute sustained, daily and monthly quotas, max concurrent connections, max page size, max bulk-export jobs. Plan/licence (EN-040) sets the tenant's ceiling; per-app limits sit under it.
- Endpoint classes carry their own multipliers: `search` and `export` endpoints are far more expensive than a single-resource read and are limited separately (unrestricted resource consumption is an explicit OWASP API risk).
- **Fair-use protection for clinical traffic**: internal, staff-facing traffic has a reserved capacity pool so no partner integration can degrade the OPD at 10 a.m. Partner traffic is shed first under pressure (documented, not silent).
- Soft limits warn at 80 % of quota (email + portal banner); hard limits return `429`; sustained abuse triggers automatic throttling with an alert and an optional temporary block.
- Quota resets are tenant-timezone aware (a daily quota resetting at 00:00 UTC surprises Indian partners at 05:30 IST).

### 3.5 Versioning & deprecation
- URI versioning `/api/v1/...`, `/fhir/R4/...`; breaking changes require a new major version. Additive changes (new optional fields, new endpoints) never break a version.
- **Deprecation policy is contractual**: on marking an API deprecated, the system sets a **sunset date ≥ 12 months** out (configurable minimum, never shorter for PHI APIs), adds `Deprecation: true`, `Sunset: <http-date>` and `Link: <docs>; rel="deprecation"` headers to every response, emails all affected app owners at 180/90/30/7 days, and shows a migration guide in the portal.
- The dashboard shows **who is still calling a deprecated version** by app and volume, so nobody is switched off blind. Sunset requires explicit confirmation listing the remaining callers.
- Sandbox always runs the newest version so partners can test migration before it is enforced.

### 3.6 Developer portal (`gateway.dev_portal`)
- Public/partner-facing site (branded per tenant): API catalogue by product, OpenAPI reference with **try-it** console against the sandbox, quick-start guides, authentication how-tos, code samples (curl/TypeScript/Python/Java), postman/insomnia collections, webhook documentation with signature-verification snippets, changelog and deprecation calendar, status page and incident history, support contact.
- Self-service: register an app, get sandbox credentials instantly, request production promotion (routes to approval), rotate keys, configure webhook endpoints and see delivery attempts, view own usage/quota/error breakdown, download invoices where usage billing applies.
- Sandbox uses synthetic data only (shared with EN-019's sandbox tenant), auto-reset nightly, and is hard-separated from production by issuer/audience — a sandbox token can never touch real patients.

### 3.7 Webhook subscriptions (`gateway.webhooks`)
1. A partner subscribes an endpoint to event topics (`appointment.booked`, `lab.result.final`, `bill.finalized`, `payment.captured`, `preauth.status_changed`, `patient.registered` — each with an explicit PHI classification and consent requirement).
2. Delivery: `POST` with headers `X-Vims-Event`, `X-Vims-Delivery-Id`, `X-Vims-Timestamp`, `X-Vims-Signature` (HMAC-SHA256 over timestamp + body, with **dual secrets** supported during rotation so partners can roll without downtime).
3. **Reliability**: at-least-once with exponential backoff (10 s, 1 min, 5 min, 30 min, 2 h, 6 h — 6 attempts over ~9 h), per-subscription circuit breaker after sustained failures, dead-letter list in the portal with manual redelivery, and an explicit statement in the docs that consumers must be idempotent on `delivery_id`.
4. **Payload minimisation**: webhooks carry identifiers and status, not clinical content — the partner calls back through the API (authenticated, consent-checked, audited) to fetch details. This keeps PHI out of partner logs and reduces breach blast radius.
5. Partners can replay the last 7 days of deliveries themselves from the portal, and see per-endpoint success rate and latency.

### 3.8 Exceptions & incident handling
- **Leaked key** → one-click revoke, all edge nodes updated within 5 s, affected app owner notified, EN-023 incident opened, usage in the preceding 30 days reviewed for anomalies.
- **Partner abuse/runaway loop** → automatic throttle → temporary block with a clear problem+json body pointing to the portal; manual override to unblock.
- **Backend degradation** → gateway sheds partner traffic first (priority classes), returns `503` with `Retry-After`, and the status page updates automatically.
- **Consent revoked mid-flight** → subsequent calls for that patient return `403` immediately (consent cache TTL ≤ 60 s and event-invalidated), and the partner's webhook subscription for that patient's events is suppressed.

## 4. Data Model (schema `core`, prefix `api_`)
- `api_products` — id, hospital_id? (null = global catalogue), key, name, description, version, data_classes text[], contains_phi bool, consent_required bool, default_tier, docs_url, sandbox_available bool, status enum(draft/sandbox/published/deprecated/sunset), support_contact, created…
- `api_endpoints` — id, product_id, method, path_pattern, version, operation_id, summary, required_scopes text[], permission_keys text[], phi bool, idempotent bool, pagination enum(none/cursor/page), rate_class enum(read/search/write/export/bulk), timeout_ms, cache_policy, deprecated bool, sunset_at, replaced_by_endpoint_id?, openapi_ref, status; UNIQUE(method, path_pattern, version).
- `api_clients` (apps) — id, hospital_id, name, organisation, owner_contact jsonb, purpose, environment enum(sandbox/production), auth_methods text[] (api_key/client_credentials/auth_code/mtls), redirect_uris text[], jwks_url?, mtls_cert_thumbprint?, ip_allowlist inet[], approved_products uuid[], approved_scopes text[], tier, quota_overrides jsonb, dpdp jsonb (purpose, data_categories, retention, cross_border, dpa_ref), status enum(pending/active/suspended/revoked), approved_by, approved_at, created_by, created_at; index (hospital_id, status).
- `api_credentials` — id, client_id, kind enum(api_key/client_secret/public_key/mtls_cert), key_prefix, last4, hash (Argon2id/HMAC), created_at, expires_at, last_used_at, use_count, revoked_at, revoked_by, revoke_reason, rotation_of_id?; **the secret value is never stored**.
- `api_scopes` (seed) — key (`patient.read`, `appointment.write`, `report.download`, `fhir.patient.rs`, `billing.read`, `preauth.write`, `webhook.subscribe`), description, phi bool, requires_consent bool, requires_admin_approval bool, maps_to_permissions text[].
- `api_rate_policies` — id, hospital_id?, tier, rate_class, burst_rps, sustained_rpm, daily_quota, monthly_quota, max_concurrent, max_page_size, effective_from, version.
- `api_usage_counters` (Redis primary; Postgres rollup) — client_id, endpoint_id?, window (minute/hour/day/month), bucket_start, count, error_count, bytes_out, p95_ms.
- `api_access_log` — id, hospital_id, client_id?, user_id?, endpoint_id, method, path, version, status_code, latency_ms, request_bytes, response_bytes, ip, user_agent, api_key_prefix, scopes text[], tenant_resolved, consent_id?, phi bool, patient_id?, idempotency_key?, request_id, trace_id, error_code, rate_limited bool, at; **partitioned monthly**, retention ≥ 180 days in India; PHI reads mirrored into `core.audit_log` (EN-024).
- `api_webhook_subscriptions` — id, hospital_id, client_id, url, topics text[], secret_ref (current + previous during rotation), active, filters jsonb (branch, department, patient-scope), phi_payload bool default false, circuit_state, consecutive_failures, disabled_at, disabled_reason, created_at.
- `api_webhook_deliveries` — id, subscription_id, delivery_id uuid, topic, event_ref, attempt int, status enum(pending/delivered/failed/dead_lettered/replayed), request_headers_redacted jsonb, payload_redacted jsonb, response_status, response_ms, error, next_attempt_at, delivered_at, created_at; partitioned monthly.
- `api_deprecations` — id, endpoint_id/product_id, announced_at, sunset_at, migration_guide_url, notified_at jsonb (180/90/30/7), remaining_callers jsonb (refreshed daily), confirmed_by, sunset_executed_at.
- `api_incidents` (status page) — id, title, severity, affected_products uuid[], started_at, resolved_at, updates jsonb, public bool.
- `api_developer_accounts` — id, email citext, name, organisation, client_ids uuid[], verified_at, portal_role, last_login_at.

## 5. Business Rules & Validations
- **Deny by default at the edge**: only endpoints present in the registry with status `published` (or `sandbox` in the sandbox environment) are routable; everything else is `404`.
- **Object-level authorisation is re-checked on every request** against the caller's tenant and scope. Guessing an id must never return another tenant's or another patient's data (OWASP API1 — the single most common and most damaging API defect in healthcare).
- PHI-bearing production access requires: an approved client with DPDP metadata, the correct scopes, an **active consent** (EN-028) or a documented statutory basis, and audit logging as a PHI read.
- API keys are hashed at rest, shown once, expire by default in 12 months, auto-disable after 90 days of non-use, and can be revoked with effect within 5 seconds across all nodes.
- Request signing is mandatory for money-moving and order-creating endpoints; timestamp window ±5 minutes; nonce replay cache for the window; unsigned or stale requests are rejected before reaching business logic.
- Idempotency keys are mandatory on payment, order and appointment-creation endpoints; the first response is stored for 24 h and replayed byte-identically on retry.
- Rate limits always return `429` with `Retry-After` and rate headers — never a silent drop or a generic 500. Internal clinical traffic has reserved capacity and is shed last.
- Deprecation requires a sunset date ≥ 12 months out for PHI APIs, deprecation headers on every response, notifications at 180/90/30/7 days, and an explicit confirmation naming remaining callers before sunset.
- Webhooks never carry clinical content by default (`phi_payload=false`); enabling PHI payloads requires Hospital Admin + DPO approval and is recorded in the data-flow register.
- Webhook signatures use HMAC-SHA256 with rotation support (two valid secrets during a rotation window); replay protection is the consumer's responsibility via `delivery_id`, and this is stated in the docs.
- Every response includes `X-Request-Id`; every error is RFC 9457 problem+json with a stable `type`, human-readable `title`, and **no internal stack traces, SQL, or hostnames**.
- Cross-border clients are flagged and require explicit approval; the data-flow register (shared with EN-017) is the single DPDP record of processing.
- API access logs are retained ≥ 180 days within India; PHI-bearing accesses additionally live in the audit store for ≥ 3 years.

## 6. API Surface (`/api/v1/gateway` — management plane)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET/POST/PATCH | /products ; /products/:id ; POST /products/:id/publish\|deprecate\|sunset | API product lifecycle | `gateway.product.manage` | sunset requires caller confirmation |
| GET/POST/PATCH | /endpoints ; POST /endpoints/sync-openapi | endpoint registry | `gateway.product.manage` | generated from OpenAPI |
| GET/POST/PATCH | /clients ; /clients/:id ; POST /clients/:id/approve\|suspend\|revoke | app registry | `gateway.client.manage` (Hospital Admin approval for PHI) | DPDP metadata required |
| POST | /clients/:id/credentials ; POST /credentials/:id/revoke ; POST /credentials/:id/rotate | credential lifecycle | `gateway.client.manage` | secret shown once |
| GET/PUT | /rate-policies ; /clients/:id/quota-override | limits & quotas | `gateway.policy.manage` | plan ceiling from EN-040 |
| GET | /usage?client&product&from&to&granularity | usage analytics | `gateway.usage.read` (IT, Admin, client sees own) | |
| GET | /access-log?client&endpoint&status&from&to&q | request log (redacted) | `gateway.log.read` (IT, DPO, Auditor) | PHI fields masked |
| GET/POST/PATCH | /webhooks/subscriptions ; POST /subscriptions/:id/test\|disable\|rotate-secret | webhook management | `gateway.webhook.manage` (client owns its own) | dual-secret rotation |
| GET | /webhooks/deliveries?subscription&status&from&to ; POST /deliveries/:id/redeliver | delivery log & replay | `gateway.webhook.manage` | 7-day self-service replay |
| GET/POST | /deprecations ; GET /deprecations/:id/callers | deprecation tracking | `gateway.product.manage` | who still calls v1 |
| GET/POST | /incidents ; PATCH /incidents/:id | status page | `gateway.status.manage` | public feed |
| GET | /health ; /metrics | gateway health | `gateway.status.read` / internal | Prometheus |
| GET | /data-flows | external inbound data-flow register | `gateway.dataflow.read` (DPO) | merges with EN-017 |
**Developer-portal APIs** (`/api/v1/devportal`, partner-authenticated): `GET /catalogue`, `POST /apps`, `GET /apps/:id/usage`, `POST /apps/:id/keys`, `POST /apps/:id/promote`, `GET/POST /apps/:id/webhooks`, `GET /apps/:id/deliveries`, `GET /changelog`, `GET /status`.

## 7. Domain Events (outbox)
- `gateway.client.created|approved|suspended|revoked` → EN-024, DPO register, partner notification.
- `gateway.credential.created|rotated|revoked|expiring|unused_disabled` → app owner, EN-023.
- `gateway.rate_limit.exceeded` (aggregated per app/window) → EN-023 anomaly detection, partner warning at 80 % quota.
- `gateway.abuse.detected|throttled|blocked` → EN-023 incident, IT alert.
- `gateway.api.deprecated|sunset_scheduled|sunset_executed` → all affected app owners, portal changelog.
- `gateway.webhook.delivered|failed|circuit_opened|dead_lettered` → partner portal, IT alert on sustained failure.
- `gateway.phi.accessed` → EN-024 audit (READ_PHI), EN-028 consent ledger usage record.
- `gateway.incident.opened|updated|resolved` → status page, subscribed partners.
- Consumes: domain events from every module (to fan out as webhooks), `consent.revoked` (invalidate consent cache, suppress subscriptions), `admin.licence.changed` (adjust tenant ceilings), `security.incident.opened` (may auto-suspend a client).

## 8. Screens (UI)
- **Gateway Dashboard** (desktop, IT): traffic (req/s), error rate by class (4xx vs 5xx separated — they mean different things), p50/p95/p99 latency, top clients by volume, top endpoints, current throttles, quota-breach list, webhook health, open incidents. Auto-refresh 10 s; a spike is one click from "which client caused it".
- **API Registry** (desktop): products and endpoints with status chips, PHI badges, scope requirements, deprecation banners, OpenAPI sync button, and a diff view when the spec changes (so an accidental breaking change is caught before publication).
- **Client Manager** (desktop): app cards with organisation, environment, status, tier, PHI badge, last-used, credential list with expiry countdowns, IP allowlist editor, DPDP panel, approve/suspend/revoke with reason. Revoke is deliberately prominent — the action you need at 2 a.m.
- **Usage Analytics** (desktop; a partner-scoped version in the portal): per-client charts (calls, errors, latency, bytes, quota consumption), endpoint breakdown, error taxonomy, downloadable CSV, cost/usage-billing view where enabled.
- **Access Log Explorer** (desktop): virtualised table (time, client, endpoint, status, latency, request id), filters, correlation to internal traces, drawer with redacted request/response metadata and the consent decision; "reveal PHI context" requires step-up and is audited.
- **Webhook Console** (desktop + portal): subscriptions with health chips, recent deliveries with response codes and timings, failed-delivery list with one-click redelivery, secret rotation wizard, signature-verification sample code.
- **Deprecation Manager** (desktop): deprecated endpoints with sunset dates, remaining callers by app and volume, notification history, and a sunset action that lists exactly who will break.
- **Developer Portal** (external, responsive; branded per tenant): catalogue, reference with try-it console, guides, code samples, changelog, status page, app self-service, keys, webhooks, usage. Designed to be usable by a partner developer without ever contacting hospital IT.
- Empty/error states: "No production apps yet — sandbox apps: 3", "This key hasn't been used in 87 days and will auto-disable in 3 days", "12 apps still call /api/v1/appointments (sunset 14-Mar) — notify or postpone".

## 9. Integrations
- **Edge**: Cloudflare (WAF, DDoS, bot management, rate limiting) in cloud; Nginx/Traefik (+ ModSecurity, fail2ban) on-prem; both driven by the same registry configuration so behaviour is identical in either deployment.
- **EN-025** as the OAuth2/OIDC authorisation server (token issuance, JWKS, scopes); **EN-007** for permissions and service accounts; **EN-019** publishes FHIR/HL7 endpoints through this gateway; **EN-017** handles the outbound mirror image (and shares the DPDP data-flow register); **EN-023** consumes rate-limit and abuse signals and owns WAF rule tuning; **EN-024** stores PHI access audit.
- **Inbound webhooks** from Razorpay (EN-010), Meta/WhatsApp and SMS providers (EN-009), ABDM (EN-011), NHCX (RC-001) are themselves registered endpoints with signature verification, dedupe and fast-ack.
- **Observability**: OpenTelemetry traces propagated end-to-end, Prometheus RED metrics per endpoint/client, Grafana dashboards, Sentry for gateway errors.
- **Redis** for rate limiting, quota counters, idempotency store, nonce replay cache and credential denylist.

## 10. Reports & Analytics
- Traffic and error trends by product/endpoint/client; p95/p99 latency per endpoint with SLO burn-down; quota consumption and breach frequency per tenant and app; top talkers and anomalous-usage detection; deprecation adoption curves; webhook delivery success rate, retry distribution and dead-letter counts; credential hygiene (age, unused keys, expiring soon, never-rotated); PHI-access-by-partner report for the DPO; cross-border flow inventory; usage-based billing report (`gateway.usage_billing`) per tenant/app; status-page uptime by product. MV `analytics.mv_api_hourly` and `mv_api_daily`.

## 11. Notifications
- Partner/app owner: credentials created/expiring/revoked, 80 % quota warning and breach, deprecation notices at 180/90/30/7 days, webhook endpoint failing/circuit opened, sandbox reset, incident updates.
- IT Admin: abuse detected, error-rate or latency SLO breach, backend shedding partner traffic, webhook dead-letter growth, key leaked/suspicious usage pattern, spec diff introducing a breaking change.
- Hospital Admin/DPO: new production PHI access request awaiting approval, cross-border client activated, consent-denial spike for a partner.
- Status page subscribers: incident opened/updated/resolved, planned maintenance (coordinated with EN-022 windows).

## 12. Permissions (RBAC keys)
`gateway.product.manage` (IT Admin, Integration Engineer; Super Admin for the global catalogue) · `gateway.client.manage` (IT Admin; production PHI approval requires Hospital Admin) · `gateway.policy.manage` (IT Admin; ceilings from EN-040) · `gateway.usage.read` (IT, Hospital Admin, Finance; partners see only their own) · `gateway.log.read` (IT Admin, DPO, Auditor) · `gateway.webhook.manage` (IT Admin; partners manage their own subscriptions in the portal) · `gateway.status.manage` (IT Admin) · `gateway.status.read` (all staff, public status page) · `gateway.dataflow.read` (DPO, Auditor) · `gateway.devportal.admin` (IT Admin — approve developer accounts).

## 13. Non-functional
- Scale: 2000-bed enterprise with active partner integrations ≈ **2–5 M API calls/day** (FHIR/HL7 via EN-019, portals, website widgets, payment/messaging webhooks), peaks of ~200 req/s. Gateway overhead (auth + rate limit + registry lookup + logging) p95 **< 15 ms**; total added latency budget < 25 ms.
- Rate limiter must be accurate under distribution (Redis sliding window with Lua atomicity), and must fail **open for internal clinical traffic** and **closed for external partners** if Redis is unavailable — an explicit, documented trade-off that protects patient care without opening the perimeter.
- Credential denylist propagation < 5 s across all edge nodes; JWKS cached 6 h with background refresh and stale-while-revalidate so a JWKS outage never blocks logins/API calls.
- Access-log writes are batched (≤ 2 s flush) with a durable buffer; log volume ≈ 3–6 M rows/day → monthly partitions, ~15 GB/month, archived after 180 days.
- Availability target 99.9 % for the gateway itself; it must add no single point of failure beyond the API it fronts (stateless nodes, health-checked, rolling deploys with connection draining).
- Security: TLS 1.2+ (1.3 preferred), HSTS, strict CORS allow-lists per client, request-size caps, JSON depth limits, SSRF protection on any URL the caller supplies (webhook endpoints validated against private-IP ranges), no internal errors leaked, all secrets in Vault.
- On-prem: the gateway runs without internet for LAN partners; cloud-only features (Cloudflare WAF, hosted status page) degrade to the local equivalents with clear indicators.
- Accessibility & i18n: developer portal WCAG 2.2 AA, works on mobile, English-first technical content with localisable UI chrome; error `title` strings are stable and machine-parseable.

## 14. Acceptance Criteria
1. Given an endpoint that is not in the registry, when it is called from outside, then the gateway returns 404 without revealing whether an internal route exists.
2. Given a partner presents a valid API key for a product they are not approved for, when the call is made, then it returns 403 with a problem+json body naming the missing scope, and the attempt is logged.
3. Given a client attempts to read a patient belonging to another tenant by guessing an id, when the request is authorised, then object-level authorisation denies it with 404 (not 403, to avoid confirming existence) and a security event is raised.
4. Given a PHI-bearing endpoint and a patient with no active data-sharing consent, when a partner calls it, then it returns 403 and the consent-denial is recorded and visible in the DPO's report.
5. Given an app exceeds its sustained rate limit, when the next request arrives, then it receives 429 with `Retry-After` and accurate `X-RateLimit-*` headers, and internal clinical traffic is unaffected.
6. Given a payment endpoint requiring request signing, when a request arrives with a timestamp 10 minutes old, then it is rejected before reaching business logic and logged as `stale_signature`.
7. Given the same `Idempotency-Key` is submitted twice for an appointment creation, when the second request arrives within 24 hours, then the original response is replayed and only one appointment exists.
8. Given a credential is revoked, when the partner uses it 5 seconds later, then it is rejected on every edge node and the app owner is notified.
9. Given an API version is deprecated, when any call to it succeeds, then the response carries `Deprecation`, `Sunset` and `Link` headers, and the deprecation dashboard lists that caller.
10. Given a sunset is attempted while 12 apps still call the endpoint, when the admin confirms, then the confirmation screen lists all 12 apps with their last-call times and requires explicit acknowledgement.
11. Given a webhook endpoint returns 500 six times, when the retry schedule is exhausted, then the delivery is dead-lettered, the circuit opens after sustained failures, the partner is notified, and the delivery is redeliverable from the portal.
12. Given a webhook is delivered, when the partner verifies `X-Vims-Signature`, then the HMAC computed over timestamp + body matches, and during a secret rotation both the old and new secrets validate for the rotation window.
13. Given a partner subscribes to `lab.result.final`, when the event fires, then the webhook payload contains identifiers and status only — no clinical values — unless PHI payloads were explicitly approved.
14. Given a developer registers in the portal, when they create a sandbox app, then credentials are issued immediately, the sandbox contains only synthetic patients, and a sandbox token presented to production is rejected with `invalid_audience`.
15. Given Redis is unavailable, when internal clinical requests arrive, then they proceed (fail-open) while external partner requests are rejected (fail-closed), and the condition is alerted.
16. Given a DPO requests the external access report for a patient, when it is generated, then every partner API read of that patient's data appears with client, purpose, consent reference and timestamp.
17. Given the OpenAPI spec changes in a way that removes a field, when the registry syncs, then the diff view flags a breaking change and publication is blocked until a new version is created.

## 15. Enhancements / Later phases
- GraphQL façade for portal/mobile clients with per-field authorisation and query-cost limiting (depth/complexity budgets to prevent expensive queries).
- gRPC support for high-volume internal/partner traffic; server-sent events and WebSocket subscriptions as an alternative to webhooks for near-real-time partners.
- Usage-based billing and partner invoicing (`gateway.usage_billing`) with plan upgrades self-served in the portal.
- API monetisation catalogue for the SaaS operator (per-call pricing for third-party developers building on the platform).
- Adaptive rate limiting driven by backend health signals, and per-tenant SLO-aware traffic shaping.
- Automated contract testing and consumer-driven contracts in CI so a breaking change fails the build, not the partner.
- Anomaly detection on API behaviour (sudden shift in endpoint mix, enumeration patterns, off-hours bulk reads) feeding EN-023 — the main defence against a compromised partner credential.
- mTLS by default for government/payer integrations, plus certificate-bound access tokens (RFC 8705).
- Regional gateway nodes for group hospitals and multi-country deployments with tenant-affinity routing (EN-041).
- Public status page with subscription (email/RSS/webhook) and automatic incident creation from SLO breaches.

## 16. Open Questions for the Hospital
1. Which external parties will call the APIs at go-live (TPAs, corporates, referring hospitals, website, mobile apps, government), and what data does each genuinely need?
2. Should the API be reachable from the public internet, or only over VPN/private links to named partners?
3. Who approves production access to PHI-bearing APIs, and is a signed data-processing agreement a prerequisite in every case?
4. Expected call volumes and acceptable quotas per partner; is there any partner whose failure would disrupt clinical operations (and therefore needs reserved capacity)?
5. Is a self-service developer portal desirable, or should all onboarding stay manual through IT?
6. Deprecation policy: is a 12-month sunset window acceptable to partners, and who owns partner communication?
7. Webhooks vs polling: do partners have publicly reachable HTTPS endpoints, and can they verify HMAC signatures?
8. Should any webhook ever carry clinical content, or is the identifier-plus-callback model acceptable to all partners?
9. Existing API gateway/edge infrastructure (Cloudflare, F5, Apigee, Kong) to integrate with or replace?
10. Usage-based billing for partner API access — in scope commercially, or free for empanelled partners?
11. Data-residency and cross-border constraints for any overseas partner or SaaS consumer.
