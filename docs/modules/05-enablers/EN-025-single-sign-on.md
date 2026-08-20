# EN-025 — Single Sign-On (OIDC / SAML 2.0 / LDAP / Active Directory, JIT Provisioning, Group→Role Mapping, SCIM Sync, Session Lifecycle, Step-Up Authentication, Break-Glass Local Accounts)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Module ID       | EN-025                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase           | 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Priority        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Depends on      | EN-007 (System Admin & RBAC — users, roles, sessions, auth policy; EN-025 is the federation adapter behind it), EN-024 (audit of every authentication event), EN-023 (security monitoring, IdP anomalies, certificate rotation), NC-010 (HR employee master — the authoritative joiner/mover/leaver source), EN-037 (notifications), EN-026 (API Gateway — token validation for machine clients), EN-019 (SMART-on-FHIR relies on this authorisation server), PE-001/OP-020 (patient identity is **not** SSO — OTP/ABHA via EN-011), EN-041 (multi-branch/group tenancy in claims) |
| Feature flag    | `module.sso.enabled` (sub: `sso.oidc`, `sso.saml`, `sso.ldap`, `sso.scim`, `sso.step_up`, `sso.multi_idp`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Primary roles   | IT Admin (56 — configure & operate), Hospital Admin (2 — policy: force SSO, break-glass accounts), Super Admin (SaaS — per-tenant IdP onboarding)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Secondary roles | HR Executive (47 — attribute/group source of truth), every staff user (logs in through it), Privacy Officer (57 — authentication evidence), Auditor (58), Vendor/partner users (federated where the hospital allows)                                                                                                                                                                                                                                                                                                                                                               |
| Regulatory      | DPDP Act 2023 & Rules 2025 (access control, minimal attribute sharing with the IdP, logging), CERT-In Directions 2022 (auth log retention 180 days in India, NTP sync), NABH IMS (unique user identification, access control, timely revocation on exit), ISO 27001 A.5.15–A.5.18 (access control, identity management, authentication information), HIPAA-compatible technical safeguards (unique user id, automatic logoff, emergency access procedure) for global readiness, ABDM HPR (clinician identity assertion where used), IT Act §43A                                    |

## 1. Purpose

EN-025 lets hospital staff sign in with the identity their organisation already manages — Microsoft Entra ID (Azure AD), Google Workspace, Okta, Keycloak, ADFS, or on-prem Active Directory/LDAP — instead of another password. It implements OIDC (authorization-code + PKCE), SAML 2.0 (SP-initiated and IdP-initiated), direct LDAP/AD bind for on-prem hospitals with no modern IdP, just-in-time user provisioning, group→role mapping into EN-007's RBAC model, SCIM 2.0 inbound synchronisation for joiner/mover/leaver automation, session lifecycle including single logout, step-up re-authentication for sensitive clinical and financial actions, and — critically for a hospital — **break-glass local accounts** that keep working when the IdP is down at 3 a.m.

## 2. Users & Jobs-to-be-done

- **Clinical & administrative staff**: click "Sign in with hospital account", land on their role home in under 5 seconds, and never manage a second password.
- **IT Admin** (desktop): configure the IdP connection (metadata import, certificates, claim mapping), test a login before enabling it, map AD groups to HMS roles, watch failed logins, rotate signing certificates before they expire.
- **HR Executive**: know that a leaver loses access the same day because SCIM/HR events drive deactivation, not a manual ticket.
- **Hospital Admin**: decide whether SSO is mandatory for staff, which accounts remain local break-glass, and approve group→role mappings that grant sensitive permissions.
- **On-call doctor at 03:00 during an IdP outage**: still get in — via a break-glass local account with MFA, with the event loudly audited.
- **Auditor/Privacy Officer**: prove that every login is attributable, that leavers were revoked promptly, and that emergency access was reviewed.

## 3. Core Workflows

### 3.1 IdP configuration & onboarding

1. IT Admin adds an **identity provider**: display name, protocol (OIDC / SAML 2.0 / LDAP / AD), scope (whole hospital, specific branch, or a user segment such as "doctors only"), and login-button label/icon.
   - **OIDC**: issuer URL → discovery document auto-fetch (`/.well-known/openid-configuration`), client id/secret (or private-key JWT), scopes (`openid profile email groups`), PKCE required, response mode, JWKS URL with automatic key rotation, optional `acr_values` for MFA enforcement.
   - **SAML 2.0**: IdP metadata XML import (or URL), entity id, SSO/SLO endpoints, signing/encryption certificates, NameID format, signed authn requests, assertion encryption, clock-skew tolerance; our SP metadata is generated for the IdP administrator to import.
   - **LDAP/AD**: host(s) with failover, LDAPS/StartTLS (plain LDAP refused unless explicitly overridden on an isolated network), bind DN (service account in Vault), base DN, user filter, group filter, attribute map, connection pool, referral handling.
2. **Attribute/claim mapping**: IdP claim → HMS user field (`email`, `username`, `employee_id`, `name`, `mobile`, `department`, `designation`, `branch`, `npi/registration_no`, `hpr_id`) with transforms (lowercase, strip domain, regex extract).
3. **Test login** in a sandbox mode: run a real authentication that shows the raw claims/assertion received, the mapped user object and the roles that would be granted — **without** creating or modifying anything. This is the single most useful screen in the module and prevents the classic "SSO enabled, nobody can log in" incident.
4. Enable → the provider appears on `/login`. Multiple providers can coexist (`sso.multi_idp`): e.g. Entra ID for employees, a different IdP for a partner group, plus local accounts.
5. **Home-realm discovery**: by email domain (`@hospital.org` → Entra ID), by a branch/subdomain hint, or by explicit button choice. Unknown domains fall back to the local login form (never leaking which domains exist).

### 3.2 Login flows

1. **OIDC (SP-initiated)**: user clicks the provider → authorization-code request with PKCE, `state`, `nonce` → IdP authenticates (and enforces its own MFA/conditional access) → callback → code exchange → ID token validated (signature via JWKS, `iss`, `aud`, `exp`, `nonce`, `azp`, clock skew ≤ 120 s) → user resolved/provisioned → HMS session created (EN-007) → branch selection if multiple → role home. Target: **< 5 s end-to-end**.
2. **SAML 2.0**: SP-initiated `AuthnRequest` (signed) or IdP-initiated with `RelayState` validation; assertion validated (signature, conditions, `NotBefore/NotOnOrAfter`, audience restriction, recipient, InResponseTo, one-time-use replay cache), attributes mapped, session created.
3. **LDAP/AD direct bind**: the login form posts to us, we bind against the directory (never storing the password), read attributes and group memberships, then create the session. Used where there is no modern IdP; it is the weakest option (password crosses our app) so it requires TLS and is discouraged in the UI with a clear note.
4. **Session issued** by EN-007: access JWT 15 min, rotating refresh token, device binding, idle timeout 15 min for clinical screens with PIN re-auth, absolute lifetime 12 h.
5. **Failures** produce user-safe messages ("we couldn't sign you in with your hospital account") plus a support reference id, while the detailed reason (assertion expired, audience mismatch, unmapped group, disabled account) is logged for IT — never shown to the user, and never used to enumerate accounts.

### 3.3 JIT provisioning & group→role mapping

1. On first successful federated login, if no matching user exists, **JIT provisioning** creates one when the provider allows it: identity fields from claims, `type=staff`, `sso_subject` = the IdP's stable subject (never the email, which changes), status active, and roles derived from group mapping.
2. **Group→role mapping rules** (`sso_role_mappings`): ordered rules matching on group/claim value (exact, prefix, regex) → grant role X with scope (branch, department, ward) and optional ABAC conditions; a default role for users matching no rule (usually a minimal "staff" role, or **deny** if the hospital prefers explicit provisioning).
3. **Sensitive roles are never JIT-granted.** Roles flagged sensitive in EN-007 (admin, narcotics, blood issue, discount approver, finance posting, impersonation) require an explicit human grant with approval, even if an IdP group claims them — because whoever controls AD groups would otherwise control clinical privileges without a hospital approval trail.
4. On **every** login, group claims are re-evaluated: roles gained are added, roles lost are removed (unless locally pinned with `source=manual`), and the change is audited. This is what makes "moved to another department" actually take effect.
5. Attribute updates (name, department, mobile) sync on login; conflicts with the HR record (NC-010) surface in a reconciliation queue rather than silently overwriting.

### 3.4 SCIM 2.0 provisioning (`sso.scim`)

- We expose a **SCIM 2.0 service provider** (`/scim/v2/Users`, `/Groups`, `/ServiceProviderConfig`, `/Schemas`, `/ResourceTypes`) secured by a long-lived bearer token (rotatable, IP-restricted) so Entra ID/Okta can push create/update/deactivate and group membership in near real time.
- Mapping: SCIM `userName` → username, `externalId` → sso_subject, `active=false` → deactivate (sessions revoked, API keys revoked, approvals reassigned — the full EN-007 leaver path), `enterprise:employeeNumber` → employee_id, group membership → role mapping rules.
- **Reconciliation job** (nightly): compare the IdP's directory (SCIM or LDAP query) with HMS users; report orphans (in HMS, not in IdP — potential stale access), missing (in IdP, not in HMS), and attribute drift; the report is actionable, not just informational, with bulk fix actions.
- Deprovisioning SLA is measured and reported: time from IdP deactivation to HMS session revocation (target **< 5 minutes** via SCIM, ≤ 24 h via nightly reconciliation as a backstop).

### 3.5 Session lifecycle & logout

- **Single logout (SLO)**: OIDC RP-initiated logout (`end_session_endpoint`) and back-channel logout (`backchannel_logout_uri` receiving logout tokens); SAML SLO (front- and back-channel). Receiving a logout token revokes all HMS sessions for that subject within seconds.
- **Local logout** always works even if the IdP's SLO fails (the user must be able to end their own session on a shared clinical workstation regardless of federation health).
- **Session inactivity/absolute limits** and concurrent-session caps are EN-007 policy; EN-025 records the authentication method and `acr/amr` claims on the session so downstream step-up decisions can tell "password only" from "phishing-resistant MFA".
- **Shared clinical workstations**: fast user switching with a short-lived session and aggressive idle timeout; "sign out everyone on this device" button; kiosk/TV devices never use SSO (device tokens, EN-007).

### 3.6 Step-up authentication (`sso.step_up`)

- Certain actions demand fresh, stronger authentication regardless of session age: narcotic dispensing, blood component issue, refunds/discounts above threshold, PHI bulk export, role grants, impersonation start, e-signature (EN-016), consent withdrawal on behalf of a patient, security configuration changes.
- Implementation: the action's policy declares `required_acr` (e.g. `mfa`, `phishing_resistant`) and `max_age_sec` (e.g. 300). If the current session's `acr/amr` and `auth_time` do not satisfy it, the user is sent through an OIDC re-authentication with `prompt=login` + `acr_values`, or challenged locally (TOTP/passkey/PIN) when the IdP cannot assert the required level.
- The result is recorded on the action's audit entry (`auth_context`), so an auditor can see _how strongly_ the person was authenticated when they approved a ₹2 lakh write-off.

### 3.7 Break-glass local accounts

1. Every tenant must maintain **at least two** break-glass local accounts (not federated): named, individually owned (never shared credentials), MFA-enrolled, with strong unique passwords stored in the hospital's password vault/sealed envelope procedure.
2. Break-glass accounts are exempt from "force SSO", are restricted to hospital IP ranges where feasible, and their use triggers **immediate high-priority alerts** to the Hospital Admin, ISO and Super Admin — using one is an event, not a routine.
3. Quarterly validation: an automated task requires each break-glass account to be tested (log in, confirm access, rotate password) with the result recorded; overdue validation is a compliance finding.
4. During an IdP outage, an admin can activate **fallback mode** for a bounded window (default 4 h, max 24 h) allowing designated users to use local passwords + MFA; every fallback login is flagged and reviewed afterwards.

### 3.8 Exceptions

- **IdP certificate expiry** → alerts at 60/30/7 days; on expiry, logins fail — the module pre-stages the next certificate where the IdP publishes multiple keys (JWKS rotation is automatic; SAML certificate rollover supports two active certificates).
- **Clock skew** between IdP and HMS → assertions rejected; NTP monitoring (EN-023) and a tolerant-but-bounded skew window (120 s) with a clear diagnostic message in the test screen.
- **Unmapped group** → user authenticates but has no role: they see a friendly "your account isn't set up yet — request access" screen (EN-007 access request), not a raw error, and IT gets a notification.
- **Duplicate/changed email** at the IdP → matching is on the stable `sso_subject`, so an email change does not create a second account; email conflicts route to reconciliation.
- **IdP compromise suspicion** → one-click "suspend this IdP": all federated logins stop, existing sessions can be mass-revoked, break-glass remains available.

## 4. Data Model (schema `core`, prefix `sso_`)

- `sso_providers` — id, hospital_id, key, display_name, protocol enum(oidc/saml2/ldap/ad), enabled, order, scope jsonb (branches[], user_segments), config jsonb (protocol-specific: issuer, authorization/token/userinfo/jwks/end_session endpoints, client_id, response_mode, scopes, acr_values, prompt; SAML: entity_id, sso_url, slo_url, nameid_format, want_assertions_signed, sign_authn_requests; LDAP: hosts, base_dn, user_filter, group_filter, tls_mode), secrets_ref (Vault: client_secret, private key, bind password), certificates jsonb (current + next, thumbprints, not_after), jit_enabled bool, jit_default_role, deny_if_unmapped bool, home_realm jsonb (email_domains[], subdomain), slo_enabled bool, force_reauth_max_age_sec, health jsonb, created…; UNIQUE(hospital_id, key).
- `sso_attribute_mappings` — id, provider_id, source_claim, target_field, transform jsonb, required bool, order.
- `sso_role_mappings` — id, provider_id, hospital_id, match_type enum(exact/prefix/regex), claim_name (default `groups`), match_value, role_id, branch_id?, scope jsonb (departments, wards), conditions jsonb (ABAC), priority int, enabled, is_sensitive_blocked bool (computed from role), created_by, created_at.
- `sso_identities` — id, hospital_id, user_id, provider_id, subject (IdP stable id), email_at_idp citext, last_login_at, last_claims_hash, linked_at, linked_by, status enum(active/orphaned/disabled); UNIQUE(provider_id, subject).
- `sso_login_attempts` — id, hospital_id, provider_id?, username_attempted, subject?, result enum(success/failed/denied_unmapped/denied_disabled/assertion_invalid/replay/expired/network_error/idp_error), reason_code, acr, amr text[], ip, user_agent, device_id?, latency_ms, correlation_id, at; partitioned monthly; retention ≥ 180 days (CERT-In).
- `sso_sessions_link` — session_id (EN-007 `core.sessions`), provider_id, subject, id_token_sub, sid (IdP session id for back-channel logout), auth_time, acr, amr, expires_at.
- `sso_scim_clients` — id, hospital_id, provider_id, name, token_hash, ip_allowlist inet[], scopes, last_used_at, created_by, rotated_at, status.
- `sso_scim_operations` — id, client_id, op enum(create/replace/patch/delete/group_add/group_remove), resource_type, external_id, hms_user_id?, payload_redacted jsonb, result, error, at; partitioned monthly.
- `sso_reconciliation_runs` — id, hospital_id, provider_id, run_at, idp_user_count, hms_user_count, orphans int, missing int, drift int, findings jsonb, actions_taken jsonb, status.
- `sso_break_glass_accounts` — id, hospital_id, user_id, owner_name, purpose, ip_restriction inet[], last_validated_at, next_validation_due, last_used_at, use_count, status; every use raises `sso.break_glass.used`.
- `sso_fallback_windows` — id, hospital_id, opened_by, reason, opened_at, expires_at, closed_at, logins_during int, reviewed_by, review_note.
- `sso_step_up_policies` — id, hospital_id, action_key (e.g. `pharmacy.narcotic.dispense`, `billing.refund.approve`, `admin.role.assign`, `esign.sign`), required_acr, required_amr text[], max_age_sec, fallback_method enum(totp/passkey/pin/none), enabled.
- `sso_step_up_events` — id, user_id, action_key, session_id, satisfied_by enum(existing_session/reauth_idp/local_totp/passkey/pin), acr, at, reference (audit entry id).

## 5. Business Rules & Validations

- **Matching is by stable subject**, never by email alone; an email change at the IdP must not create a duplicate user or orphan the old one.
- **Sensitive roles are never granted by group mapping alone**; the mapping engine drops them with an explicit audit entry and notifies the admin so the gap is visible rather than silent.
- Every login attempt — success or failure, federated or local — is logged with method, `acr/amr`, IP and device, retained ≥ 180 days in India (CERT-In).
- Force-SSO policy still permits break-glass accounts and the bounded fallback window; a configuration that would leave a tenant with **zero** working local accounts is rejected at save time (a lockout is worse than a marginal risk).
- Assertions/tokens are validated in full: signature, issuer, audience, expiry, nonce/InResponseTo, one-time use (replay cache keyed on assertion id for the assertion lifetime + skew), and clock skew ≤ 120 s.
- LDAP/AD direct bind requires TLS; plain LDAP is refused unless an admin explicitly overrides it with a documented reason on an isolated network.
- Passwords are **never stored** for federated users; local password hashes exist only for break-glass and explicitly local accounts.
- Deactivation propagates: SCIM `active=false`, a leaver event from HR (NC-010), or an admin action revokes all sessions and refresh tokens within 5 minutes and runs the full EN-007 leaver routine.
- Role changes derived from group claims take effect on the next login **and** on the next token refresh; users do not keep removed privileges for the rest of a 12-hour session.
- Step-up requirements cannot be bypassed by session age; if the required `acr` cannot be satisfied (IdP does not support it and no local factor is enrolled), the action is blocked with a clear remediation message.
- Break-glass use is always alerted and always reviewed; unreviewed break-glass usage older than 7 days is a compliance finding.
- Multi-branch claims: the branch attribute constrains which branches a user may select at login; a user with no valid branch cannot proceed and is routed to the access-request flow.
- IdP secrets and bind passwords live in Vault, are write-only in the UI, and are rotated on a schedule tracked by EN-023.

## 6. API Surface (`/api/v1/sso` and `/auth`)

| Method                | Path                                                                                                                 | Purpose                                 | Permission                                            | Notes                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------- | -------------------------------- |
| GET                   | /auth/providers                                                                                                      | login-page provider list (public)       | public                                                | no account enumeration           |
| GET                   | /auth/sso/:provider/start ; GET/POST /auth/sso/:provider/callback                                                    | OIDC/SAML login                         | public                                                | PKCE, state, nonce, replay cache |
| POST                  | /auth/sso/:provider/logout ; POST /auth/sso/:provider/backchannel-logout                                             | single logout                           | public (token-verified)                               | revokes sessions                 |
| POST                  | /auth/ldap/login                                                                                                     | LDAP/AD direct bind                     | public                                                | TLS required, rate-limited       |
| POST                  | /auth/step-up {actionKey} ; POST /auth/step-up/verify                                                                | step-up challenge                       | authenticated                                         | returns satisfied/required       |
| GET/POST/PATCH        | /sso/providers ; /providers/:id                                                                                      | IdP configuration                       | `sso.provider.manage` (IT Admin)                      | secrets write-only               |
| POST                  | /sso/providers/:id/import-metadata ; GET /sso/providers/:id/sp-metadata                                              | SAML metadata exchange                  | `sso.provider.manage`                                 | XML                              |
| POST                  | /sso/providers/:id/test-login                                                                                        | sandbox authentication with claim trace | `sso.provider.manage`                                 | creates nothing                  |
| POST                  | /sso/providers/:id/enable \| /disable \| /suspend                                                                    | lifecycle                               | `sso.provider.manage` (+ Hospital Admin to force SSO) | audited                          |
| GET/POST/PATCH/DELETE | /sso/attribute-mappings ; /sso/role-mappings ; POST /role-mappings/simulate {claims}                                 | mapping rules                           | `sso.mapping.manage`                                  | simulation shows resulting roles |
| GET                   | /sso/identities?user&provider ; POST /sso/identities/:id/unlink                                                      | identity links                          | `sso.identity.manage`                                 |                                  |
| GET                   | /sso/login-attempts?provider&result&from&to                                                                          | auth log                                | `sso.log.read` (IT, DPO, Auditor)                     | 180-day retention                |
| GET/POST              | /scim/v2/Users ; /Groups ; GET /ServiceProviderConfig ; /Schemas                                                     | SCIM 2.0 endpoints                      | SCIM bearer token                                     | IP-restricted, rate-limited      |
| GET/POST/PATCH        | /sso/scim-clients ; POST /:id/rotate-token                                                                           | SCIM client management                  | `sso.scim.manage`                                     | token shown once                 |
| GET/POST              | /sso/reconciliation ; POST /reconciliation/run ; POST /reconciliation/:id/apply                                      | directory reconciliation                | `sso.reconcile`                                       | bulk fixes                       |
| GET/POST/PATCH        | /sso/break-glass ; POST /break-glass/:id/validate                                                                    | emergency accounts                      | `sso.breakglass.manage` (Hospital Admin)              | quarterly validation             |
| POST                  | /sso/fallback-window {reason, hours} ; POST /fallback-window/:id/close                                               | IdP outage fallback                     | `sso.breakglass.manage`                               | bounded, alerted                 |
| GET/PUT               | /sso/step-up-policies                                                                                                | step-up rules                           | `sso.stepup.configure` (Hospital Admin + ISO)         |                                  |
| GET                   | /sso/health ; /reports/login-methods ; /reports/deprovisioning-sla ; /reports/break-glass ; /reports/unmapped-groups | monitoring & reports                    | `sso.report.read`                                     |                                  |

## 7. Domain Events (outbox)

- `sso.login.succeeded|failed|denied_unmapped` → EN-024 audit, EN-023 (brute force, impossible travel), EN-037 (new-device alert to the user).
- `sso.user.provisioned|updated|deprovisioned` → EN-007 user record, NC-010 reconciliation, EN-024.
- `sso.roles.synced` (added/removed with the driving claim) → EN-007 permission cache invalidation, audit.
- `sso.sensitive_role.blocked` → Hospital Admin notification (a group claims a privilege the hospital must grant deliberately).
- `sso.provider.enabled|disabled|suspended|certificate_expiring|health_degraded` → IT alert, EN-023.
- `sso.scim.operation_failed`, `sso.reconciliation.completed` (with orphan/missing counts) → IT, HR.
- `sso.break_glass.used|validation_overdue`, `sso.fallback.opened|closed` → **high-priority** alert to Hospital Admin, ISO, Super Admin; DPO review queue.
- `sso.step_up.satisfied|failed` → attached to the protected action's audit entry.
- Consumes: `hr.employee.joined|moved|exited` (NC-010), `admin.user.deactivated` (EN-007), `security.incident.opened` (may trigger provider suspension).

## 8. Screens (UI)

- **Login page** (`/login`, all devices): hospital branding, provider buttons ("Sign in with hospital account") above the local form, home-realm email box that routes to the right provider, "Trouble signing in?" help, and — when force-SSO is on — a discreet "emergency access" link for break-glass accounts. No account enumeration in any message.
- **IdP Configuration** (desktop, IT): provider list with health chips and certificate-expiry countdowns; configuration form per protocol with metadata import/export, secrets masked, and a prominent **"Test login"** button.
- **Claim Inspector / Test Login Result** (desktop): three columns — raw claims or decoded assertion, mapped user object, resulting roles with the rule that produced each — plus warnings ("group `HMS-Pharmacy-Narcotics` maps to a sensitive role and was not auto-granted"). This screen is the difference between a smooth rollout and a support queue.
- **Role Mapping Editor** (desktop): ordered rule list with drag-to-reorder, match preview against a pasted claim set, sensitive-role badges, scope pickers (branch/department), and a simulator that answers "if Dr Rao logs in tomorrow, what will she get?".
- **Identities & Reconciliation** (desktop): users with their linked identities, orphans/missing/drift tabs from the nightly run, bulk actions (deactivate orphans, invite missing), deprovisioning-SLA chart.
- **Authentication Log** (desktop, IT/DPO): attempts with method, result, `acr/amr`, IP, device, latency; filters for failures, unmapped, replay; correlation id to trace one login end-to-end.
- **Break-Glass & Fallback** (desktop, Hospital Admin): the (short) list of emergency accounts with owner, last validation, last use; "open fallback window" with reason and duration, live countdown while open, and a mandatory post-review panel afterwards.
- **Step-Up Policies** (desktop): action-key table with required assurance level and freshness, plus a live list of which roles can satisfy them (so a policy requiring phishing-resistant MFA for narcotics isn't set before anyone has a passkey).
- **My Sign-in Methods** (all devices, phone-friendly): which providers are linked, active sessions with device/location, sign-out actions, MFA enrolment, PIN setup.
- Empty/error states: "We couldn't sign you in with your hospital account (ref: A7F3) — try again or use emergency access", "Your account isn't set up in the HMS yet — request access", "Identity provider certificate expires in 6 days".

## 9. Integrations

- **IdPs**: Microsoft Entra ID (Azure AD) incl. conditional access and SCIM, Google Workspace, Okta, Keycloak, ADFS, Ping, and any spec-compliant OIDC/SAML provider; on-prem **Active Directory / OpenLDAP** via LDAPS with failover hosts.
- **SCIM 2.0** inbound from Entra ID/Okta; **LDAP sync** as the fallback for directories without SCIM.
- **EN-007** owns users, roles, sessions and policy — EN-025 is the federation adapter, not a parallel identity store; **EN-019** uses this authorisation server for SMART-on-FHIR; **EN-026** validates machine tokens issued here; **EN-024** records every event; **EN-023** consumes auth anomalies; **NC-010** is the HR source of truth for employment status.
- **WebAuthn/passkeys** and TOTP are local factors (EN-007) used for step-up when the IdP cannot assert the required assurance.
- Patient identity deliberately does **not** use SSO: patients authenticate by mobile OTP or ABHA (EN-011/PE-001).

## 10. Reports & Analytics

- Login method mix (SSO vs local vs OTP) and trend, SSO adoption per department, login success/failure rates by provider with top failure reasons, average login latency, **deprovisioning SLA** (IdP deactivation → HMS revocation, p50/p95 and breaches), orphaned accounts over time, unmapped-group report (groups seen in claims with no mapping — the backlog that causes access requests), sensitive-role block events, break-glass usage and review completion, step-up satisfaction rates and failures by action, certificate expiry calendar, MFA/`acr` coverage. MV `analytics.mv_sso_daily`.

## 11. Notifications

- User: new-device sign-in, sign-in from a new country, account linked to a new provider, "your access isn't configured yet — request submitted", session revoked by admin.
- IT Admin: provider health degraded, certificate expiring 60/30/7 days, SCIM failures, spike in failed logins, unmapped groups appearing, reconciliation findings.
- Hospital Admin + ISO + Super Admin: **break-glass account used**, fallback window opened/extended, sensitive-role mapping blocked, provider suspended.
- HR: leavers not deprovisioned within SLA, joiners without HMS accounts after N days.
- DPO/Auditor: monthly authentication evidence summary, break-glass reviews pending.

## 12. Permissions (RBAC keys)

`sso.provider.manage` (IT Admin; enabling force-SSO additionally requires Hospital Admin) · `sso.mapping.manage` (IT Admin; sensitive-role mappings require Hospital Admin) · `sso.identity.manage` (IT Admin) · `sso.log.read` (IT Admin, DPO, Auditor) · `sso.scim.manage` (IT Admin) · `sso.reconcile` (IT Admin, HR Executive) · `sso.breakglass.manage` (Hospital Admin only) · `sso.stepup.configure` (Hospital Admin + Information Security Officer, dual control) · `sso.report.read` (Admin, IT, Auditor, DPO). Every user implicitly manages their own linked methods and sessions.

## 13. Non-functional

- Scale: ~6000 staff, 5000 concurrent sessions, ~12 000 logins/day (shift changes create sharp peaks — 08:00, 14:00, 20:00 produce ~1500 logins in 15 minutes). SSO round trip p95 **< 5 s** including the IdP; our own processing (token validation, mapping, session creation) p95 **< 250 ms**.
- JWKS and IdP metadata cached with a 6-hour TTL and background refresh; a cold JWKS fetch must never block a login beyond 2 s (stale-while-revalidate).
- Availability: an IdP outage must not take the hospital down — break-glass and fallback windows exist for exactly this, and the login page clearly offers them. LDAP configurations use multiple hosts with health-checked failover.
- Security: PKCE mandatory for OIDC, signed AuthnRequests and encrypted assertions for SAML where the IdP supports it, replay caches, strict redirect-URI allow-lists, secrets in Vault, rate limiting (5 login attempts/min per IP+identifier), no account enumeration, no PHI in any token or claim, tokens never in URLs or logs.
- Compliance: auth logs ≥ 180 days in India; NTP-synced clocks; all configuration changes dual-controlled and audited.
- Accessibility & i18n: login page WCAG 2.2 AA, keyboard-navigable, works at 200 % zoom on a ward tablet, localised in `en, hi, ta, te, ml, kn, mr, bn`, and error text is plain language rather than protocol jargon.

## 14. Acceptance Criteria

1. Given an OIDC provider is configured, when an admin runs "Test login", then the raw claims, the mapped user object and the roles that would be granted are displayed, and no user record is created or modified.
2. Given a staff member with a valid IdP account and a mapped group, when they sign in through SSO for the first time, then a user is JIT-provisioned with the mapped role and scope, and they land on their role home in under 5 seconds.
3. Given an IdP group maps to a sensitive role (narcotics dispensing), when a user with that group logs in, then the sensitive role is **not** granted automatically, an audit entry records the block, and the Hospital Admin is notified.
4. Given a user is removed from a department group at the IdP, when they next log in or refresh their token, then the corresponding HMS role is removed and the change is audited.
5. Given SCIM is configured and the IdP sets a user `active=false`, when the SCIM request is processed, then the HMS user is deactivated and all their sessions and refresh tokens are revoked within 5 minutes.
6. Given a SAML assertion is replayed, when it is presented a second time, then it is rejected by the replay cache and the attempt is logged as `replay`.
7. Given an assertion with a clock skew of 4 minutes, when validated, then it is rejected with a precise diagnostic in the IT log while the user sees a generic message with a reference id.
8. Given force-SSO is enabled, when an admin attempts a configuration that would leave no working local break-glass account, then the change is rejected.
9. Given the IdP is unreachable, when an admin opens a 4-hour fallback window with a reason, then designated users can sign in locally with MFA, every such login is flagged, and the window closes automatically at expiry.
10. Given a break-glass account is used, when the login succeeds, then Hospital Admin, ISO and Super Admin are alerted immediately and a review item is created.
11. Given a break-glass account has not been validated for over a quarter, when the compliance check runs, then it is reported as overdue and appears on the security posture.
12. Given a pharmacist attempts a narcotic dispense with a session authenticated 3 hours ago by password only, when the step-up policy requires MFA within 5 minutes, then they are challenged, and the action's audit entry records how the challenge was satisfied.
13. Given a user authenticates successfully but matches no role-mapping rule, when the session is created, then they see a "request access" screen rather than an error, an access request is pre-filled, and IT is notified of the unmapped group.
14. Given back-channel logout is configured, when the IdP sends a logout token, then all HMS sessions for that subject are revoked within 10 seconds.
15. Given the nightly reconciliation runs, when a user exists in HMS but not in the IdP, then they appear as an orphan with a one-click deactivate action, and the deprovisioning-SLA report reflects the finding.
16. Given an IdP signing certificate expires in 30 days, when the daily check runs, then IT is alerted, and where the IdP publishes a next certificate, it is staged so rollover does not interrupt logins.
17. Given a login attempt for a non-existent user, when it fails, then the response and timing are indistinguishable from a wrong-password attempt (no account enumeration).

## 15. Enhancements / Later phases

- **Passwordless-first**: passkeys (WebAuthn) as the primary local factor and as the phishing-resistant assurance level for step-up, reducing dependence on the IdP for MFA.
- Continuous access evaluation / risk-based authentication: consume IdP risk signals (impossible travel, unfamiliar device) and re-challenge mid-session rather than only at login.
- Device-bound sessions with posture checks from EN-023 (encrypted disk, EDR present) as a condition of PHI access — the practical core of zero trust.
- Outbound federation: acting as an **identity provider** for partner systems (referring-doctor portals, TPA portals) so partners use hospital identities instead of separate accounts.
- SCIM **outbound** push to downstream systems the hospital owns (PACS, LIS, biometric terminals) so one joiner/leaver event provisions everywhere.
- ABDM **HPR-verified clinician identity** at login, asserting registration status into the session for prescriptions and reports (with EN-011).
- Delegated administration per branch/department for identity operations in large groups (EN-041).
- Just-in-time privileged access: time-boxed elevation with approval and automatic expiry, replacing standing admin roles.
- Smart-card / PIV-style login for high-security areas, and proximity-badge tap-to-unlock on shared clinical workstations (a genuine workflow win at nursing stations).
- Self-service IdP onboarding wizard for SaaS tenants with automated metadata validation and guided test.

## 16. Open Questions for the Hospital

1. Which identity provider is in use today (Entra ID, Google Workspace, Okta, ADFS, on-prem AD only), and who administers it?
2. Should SSO be mandatory for all staff, or optional alongside local passwords during a transition period? For how long?
3. Does the IdP already enforce MFA, and can it assert the assurance level (`acr`) we need for step-up on narcotics/refunds/exports?
4. Which AD/IdP groups exist and how should they map to HMS roles, branches and departments? Who signs off mappings that grant sensitive privileges?
5. Is SCIM available on your IdP licence tier? If not, is a nightly LDAP reconciliation acceptable as the deprovisioning backstop?
6. Who will own the break-glass accounts, where will their credentials be stored (password vault, sealed envelope), and who validates them quarterly?
7. What is the expected behaviour during an IdP outage — fallback window with local passwords, or wait it out with break-glass only?
8. Are there external users (visiting consultants, TPA staff, vendors) who should federate from their own organisations, or should they always use local accounts?
9. Shared clinical workstations: is fast user switching with badge tap desirable, and are badges/readers available?
10. Session policy per role: idle timeout, absolute lifetime, concurrent sessions — any clinical area that needs longer or shorter than the defaults?
11. Does the hospital want HMS to act as an IdP for other internal systems later, or remain purely a relying party?
