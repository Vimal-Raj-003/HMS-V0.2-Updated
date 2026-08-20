# EN-007 — System Admin & RBAC (Users, Roles/Permissions Catalogue, ABAC, Password Policy, 2FA/SSO, Sessions, Audit Viewer, Hospital Settings, Numbering Series, Holidays, Licences, Feature Flags, Impersonation)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Module ID       | EN-007                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Phase           | 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Depends on      | EN-024 (Audit Trail — storage/viewer data), EN-025 (SSO adapters), EN-040 (Licence & Subscription — plans/seats), EN-041 (Multi-branch/group), EN-022 (Backup & DR — status surfaced here), EN-023 (Cybersecurity — policies), EN-027 (masters governance), EN-037 (notifications), EN-032/EN-009 (OTP/email delivery), NC-010 (employee master ↔ user link), EN-038 (approval engine for sensitive changes), EN-039 (letterheads), NC-029/EN-020 (biometric login later) |
| Feature flag    | `module.admin.enabled` (always on); sub-flags `admin.impersonation`, `admin.abac_ui`, `admin.sso`, `admin.webauthn`                                                                                                                                                                                                                                                                                                                                                       |
| Primary roles   | Super Admin (1), Hospital Admin / Group Admin (2), Branch Admin (3), IT Admin / Helpdesk (56), Privacy Officer / DPO (57)                                                                                                                                                                                                                                                                                                                                                 |
| Secondary roles | HOD (5 — approve access for own dept), HR (47 — joiner/leaver feed), Auditor (58 — read-only role matrix/audit), every user (self-service profile, sessions, 2FA)                                                                                                                                                                                                                                                                                                         |
| Regulatory      | DPDP Act 2023 & Rules 2025 (access control, breach notification support, purpose limitation, consent officer role), CERT-In directions 2022 (log retention 180 days, incident reporting 6 h, NTP sync), NABH IMS/MOM (access control, confidentiality), ISO 27001 A.5/A.8 controls, HIPAA-compatible (unique user IDs, emergency access, auto logoff, audit controls), IT Act 2000 §43A, ABDM HFR/HPR identifiers, GST registration data                                  |

## 1. Purpose

EN-007 is the control plane of a tenant: user lifecycle and identity, the permission catalogue and role templates (60+), ABAC scopes (branch/department/ward/own-patients/amount/time), password and MFA policy, SSO configuration, device sessions and forced logout, the audit viewer, hospital/branch settings (identity, tax, timezone, locale, fiscal year, working hours, holidays), numbering series, feature flags and licence gating (with EN-040), notification config defaults, backup status visibility, and audited support impersonation. Every other module registers permissions and settings here.

## 2. Users & Jobs-to-be-done

- **Hospital Admin** (desktop): onboard/deactivate users, assign roles per branch/department, approve access requests, configure settings/series/holidays, review audit trails, licence usage. Daily.
- **Branch Admin**: branch-scoped user/role management, counters/rooms/wards config links, working hours.
- **IT Admin/Helpdesk**: password resets, unlock accounts, sessions, devices/workstations, SSO/2FA troubleshooting, integration health links, backup status.
- **Super Admin (SaaS)**: tenants, plans, global masters, impersonate for support (audited, consent-gated).
- **Privacy Officer**: PHI access reports, break-glass reviews, DSAR support (EN-024/EN-028), consent officer contact.
- **HOD**: request/approve access for department staff; view role matrix for own department.
- **Every user**: profile, change password, enrol 2FA, view active sessions, sign out devices, language/theme.

## 3. Core Workflows

### 3.1 Tenant, branch & hospital settings

1. Super Admin creates **tenant (hospital group)** → hospital(s) → branches (EN-041 hierarchy) with legal identity: name, logo (light/dark), address, GSTIN, PAN, TAN, CIN, registration numbers (Clinical Establishment, NABH/NABL certificate no & expiry → NC-023), ROHINI id, HFR id (EN-011), timezone, locale/languages, currency, fiscal year start, date/time formats, contact & grievance officer, DPO details (DPDP), branding (letterhead EN-039), domain/subdomain, SMTP/SMS defaults (EN-032/EN-009) → `core.hospitals`, `core.branches`.
2. **Settings registry**: typed key/value settings (`core.settings`: scope hospital/branch/department/user, key, value jsonb, schema ref, sensitivity) declared by modules in code (`packages/contracts/settings.ts`), rendered in Admin console with validation; e.g. `opd.followup_validity_days`, `billing.discount.max_pct`, `queue.default_series`, `session.idle_timeout_min`, `patient.banner.show_photo`; changes audited with before/after; some require approval (EN-038) or dual control.
3. **Working hours & holidays**: hospital/branch calendars (weekly hours, shift definitions used by HR/roster), holiday list per year (national/state/local; import IN presets), affects appointment slots (OP-001), SLA timers (EN-038), payroll (NC-010).
4. **Numbering series**: manage `core.numbering_series` (key, scope, pattern `{BR}/{FY}/{SEQ:6}`, reset policy, gapless flag, current value, prefix per branch); preview next number; FY rollover job; locked once used (pattern change creates new version effective next FY).
5. **Departments, units, locations, counters, rooms, wards** master links (owned by EN-027 mdm; edited from admin console).

### 3.2 User lifecycle

1. **Create user** (manual, CSV bulk via EN-036, HR joiner event `hr.employee.joined`, SSO JIT provisioning): identity (name, employee id, email citext, mobile, photo), type (staff/external/partner/device/service), employee link (NC-010), professional details (registration no NMC/State Council, HPR id, specialty, signature image for reports), **role assignments** per branch with department/ward/unit scope and validity dates, ABAC attributes, default workspace, language → invite (email/SMS with set-password link, expiry 48 h) → `core.users`, `core.user_roles` → Event `admin.user.created`.
2. **Access request** flow: HOD/user requests role → approver (per matrix EN-038: HOD + Admin; sensitive roles (narcotics, blood issue, discount approver, admin) require Admin + second approver) → applied with validity → audited.
3. **Modify**: role add/remove, scope change, transfer between branches, temporary elevation (time-boxed, e.g. covering pharmacist for 7 days), professional detail changes (signature change requires approval).
4. **Deactivate/leaver**: on `hr.employee.exited` or manual → immediate session revocation, API keys revoked, delegated approvals reassigned (EN-038), open tasks reported to HOD, retains audit identity; reactivation with reason; hard delete never (soft flag `deleted_at` only for erroneous creations before first login).
5. **Periodic access review** (quarterly): campaign lists users/roles per department for HOD attestation (confirm/revoke); overdue → escalate; report for NABH/ISO.

### 3.3 Permission catalogue & roles

1. Permissions registered in code (`packages/contracts/permissions.ts`: key, module, resource, action, description, data_class PHI/financial/HR/operational, risk level, default roles) → synced to `core.permissions` at boot (new keys flagged "unassigned" in Admin UI); modules cannot use unregistered keys (lint + runtime check).
2. **System role templates** (60+ per `docs/05-rbac-roles-and-logins.md`) seeded as read-only templates; hospital clones to **custom roles** (name, description, permissions, default ABAC conditions, home workspace, nav preset, quick-actions) → versioned; role diff view; role matrix export (Excel) for auditors.
3. **ABAC conditions** per assignment: `branch_ids`, `department_ids`, `ward_ids`, `unit_ids`, `own_patients_only`, `care_team_only`, `own_department_only`, `amount_limit` (per action, e.g. discount ≤ 10 %/₹5000, refund ≤ ₹2000), `time_window` (cron-like: night shift), `ip_allowlist`, `device_bound`, `requires_second_person` (blood issue, narcotics), `data_class_masks` (mask mobile/Aadhaar for role) → evaluated by policy engine `can(user, action, resource, ctx)` (server) and mirrored to UI (`packages/policies`) for hiding controls; deny-by-default; explicit deny overrides.
4. **Segregation-of-duties rules** (`core.sod_rules`): conflicting permission pairs (create bill vs approve discount; result enter vs validate; PO create vs GRN approve; payroll prepare vs approve) → warning/blocked at assignment; SoD report.
5. Effective permission simulator: pick user + context → shows allowed actions and why (rule trace).

### 3.4 Authentication policy & MFA

1. **Password policy** (per hospital, editable): min length (default 12), complexity classes, dictionary/breach check (k-anonymity HIBP optional), history 5, max age 90 days (exempt SSO), min age 1 day, lockout after 5 failures for 15 min (progressive), reset via email/SMS OTP link (15 min), admin reset forces change at next login, first-login change, no reuse of username fragments → `core.auth_policies`.
2. **MFA**: TOTP (RFC 6238) enrol with QR + recovery codes; WebAuthn/passkeys (`admin.webauthn`); SMS/email OTP as fallback (policy-controlled); mandatory for roles flagged (Admin, Billing, Pharmacy narcotics, Blood bank, Insurance, Finance, IT); remember-device 30 days optional per policy; step-up re-auth for sensitive actions (narcotics dispense, refund, role grant, export PHI, impersonation).
3. **SSO** (EN-025): OIDC (Azure AD/Entra, Google Workspace, Keycloak), SAML 2.0, LDAP/AD bind; attribute → role mapping rules; JIT provisioning; break-glass local admin retained; per-hospital toggle to force SSO for staff.
4. **Patients** authenticate via OTP/ABHA (OP-001/PE-001) — policy limits (OTP length 6, expiry 5 min, 5 attempts/hour, DLT template) configured here.
5. **Device/kiosk/TV tokens**: pairing code → scoped long-lived token bound to device fingerprint; revocation; list of devices per branch (also used by EN-005 agents, EN-018 boards, EN-034 kiosks).
6. **Quick re-auth PIN** for clinical screens (4–6 digit, hashed, per user, only unlocks existing session within 15 min idle window per policy).

### 3.5 Sessions

- Device sessions (`core.sessions`): user, device fingerprint, UA, IP, geo (coarse), branch, login method, created, last activity, refresh token family; **concurrent session limit** per role (default 3; kiosk 1); idle timeout (default 15 min; clinical screens warn at 13 min, PIN re-auth), absolute lifetime (12 h staff; 30 days remember-device refresh); **force logout** (single session/all sessions/all users of a branch — e.g. security incident) → immediate revocation via Redis denylist of refresh families + short-lived access JWTs (15 min); "you were signed out by admin" message; anomalous login alerts (new device/country) to user & IT.

### 3.6 Audit viewer (over EN-024)

- Search by user, patient, table/entity, action, date, IP; before/after diff view; PHI READ logs (break-glass) with reasons; login audit (success/fail/lockout/MFA); admin change log; export (CSV/PDF, audited); tamper-evidence status (hash chain verification job result); saved searches; DPO daily break-glass digest.

### 3.7 Feature flags & licences

- `packages/flags`: `module.<key>.enabled` and fine-grained flags per hospital/branch/role/user % rollout; UI shows licensed vs enabled vs beta; **licence gating** from EN-040 (plan → allowed modules, seat counts by role class, expiry) → attempting to enable unlicensed module shows upgrade path; seat usage meter (active users by class), expiry alerts 60/30/7 days; usage analytics (logins/day, module usage) → Super Admin.

### 3.8 Support impersonation (`admin.impersonation`)

- Super Admin/IT support requests "act as user" → requires ticket id + reason + (configurable) target user consent (push approve) or Hospital Admin approval → time-boxed (30 min) session with red banner "Impersonating X", **read-only by default**, write only if approved; every action audited with both identities; impersonation report to DPO weekly.

### 3.9 Backup/DR & security status (surface)

- Panel showing last backup time, PITR window, last restore drill (EN-022), certificate expiry (TLS auto-renew status), vulnerability scan summary (EN-023), integration health links (EN-017), SIEM forwarding status; read-only here.

### 3.10 Exceptions

- Admin locked out → break-glass procedure: second admin or Super Admin reset with dual audit; single-admin tenants require recovery codes.
- SSO IdP outage → local password fallback for designated emergency accounts only.
- HR feed conflicts (employee id mismatch) → reconciliation queue.

## 4. Data Model (schema `core`)

- `hospitals` — id, group_id, code, legal_name, display_name, logo_ids, gstin, pan, tan, cin, registrations jsonb, rohini_id, hfr_id, timezone, locale, languages[], currency, fy_start_month, address jsonb, contacts jsonb, dpo jsonb, grievance_officer jsonb, plan_id (EN-040), status.
- `branches` — id, hospital_id, code, name, address, gstin (if separate), timezone override, hfr_id, rohini_id, working_hours jsonb, active.
- `settings` — id, hospital_id, branch_id?, department_id?, user_id?, key, value jsonb, version, updated_by/at; UNIQUE(scope cols, key); `setting_definitions` (key, module, schema jsonb, default, sensitivity, requires_approval).
- `holidays` — hospital_id, branch_id?, date, name, type (national/state/local/optional), applies_to jsonb.
- `numbering_series` — hospital_id, branch_id?, key, pattern, scope (branch/hospital), fy, current_value, gapless bool, reset_policy (fy/year/day/never), version, effective_from; `numbering_allocations` (for gapless: series_id, number, allocated_at, tx ref).
- `users` — id, hospital_id (home), group_id, username citext, email citext, mobile, name jsonb, employee_id, type (staff/external/partner/device/service/patient?), status (invited/active/locked/suspended/deactivated), password_hash (argon2id), password_changed_at, must_change_password, mfa_enabled, mfa_methods jsonb, recovery_codes_hash[], pin_hash, sso_subject, professional jsonb (reg_no, council, hpr_id, specialty, signature_file_id), preferences jsonb (lang, theme, home), photo_id, last_login_at, failed_attempts, locked_until, created…; UNIQUE(group_id, username), UNIQUE(group_id, email).
- `permissions` — key PK, module, resource, action, description, data_class, risk, deprecated.
- `roles` — id, hospital_id (null=system template), key, name, description, template_key, permissions text[] (or `role_permissions` join), abac_defaults jsonb, home_workspace, nav_preset, is_system, version.
- `user_roles` — id, user_id, role_id, hospital_id, branch_id, scope jsonb (department_ids, ward_ids, unit_ids, own_patients_only…), conditions jsonb (amount_limit, time_window, ip_allowlist, requires_second_person…), valid_from, valid_to, granted_by, approval_id, active; index (user_id, active).
- `sod_rules` — hospital_id?, perm_a, perm_b, mode (warn/block), reason.
- `access_requests` — user_id, role_id, scope, justification, requested_by, status, approvals jsonb, decided_at.
- `access_reviews` / `access_review_items` — campaign, reviewer, user_role_id, decision, at.
- `auth_policies` — hospital_id, password jsonb, lockout jsonb, mfa jsonb (required_roles[], methods, remember_days), session jsonb (idle_min, absolute_h, concurrent_by_role), otp jsonb, sso jsonb (forced, providers[]), pin jsonb.
- `sessions` — id, user_id, hospital_id, branch_id, device_id, ua, ip, geo, method (password/sso/otp/device/impersonation), created_at, last_seen_at, expires_at, revoked_at, revoke_reason, refresh_family_id; partitioned monthly.
- `devices` — id, hospital_id, branch_id, type (kiosk/tv/print_agent/workstation/mobile), name, fingerprint, token_hash, scopes[], paired_by, paired_at, last_seen, revoked_at.
- `mfa_challenges`, `otp_codes` (hashed, expiry, attempts), `password_history`.
- `feature_flags` — key, hospital_id?, branch_id?, role_key?, user_id?, enabled, rollout_pct, expires_at, note.
- `impersonation_sessions` — actor_id, target_user_id, ticket_ref, reason, mode (read/write), approved_by, started/ended, session_id.
- `login_audit` (or in audit_log) — user/username attempted, result, reason, ip, ua, at.
- Licence tables in EN-040 (`licences`, `licence_seats`), audit in EN-024 (`audit_log`), outbox in `outbox_events`.

## 5. Business Rules & Validations

- Deny by default; permission keys must exist in catalogue; role edits create new version and re-evaluate sessions (permission cache invalidation via Redis pub/sub within 5 s).
- Sensitive role grants (admin, discount approver, narcotics, blood issue, insurance write-off, finance post, impersonation) require dual approval and MFA on the grantee.
- SoD `block` rules cannot be overridden except by Hospital Admin with reason (audited); `warn` rules require acknowledgment.
- Password policy defaults per docs/05; SSO users skip local password (no hash stored) unless emergency account; MFA mandatory roles cannot log in without enrolment (grace period configurable ≤ 7 days).
- Idle timeout: 15 min default; clinical role screens allow PIN re-auth within 15–60 min window; kiosk/TV never idle out but tokens scoped; concurrent limit exceeded → oldest session revoked with notice.
- Numbering series: pattern change never affects issued numbers; gapless series allocate inside the business transaction; FY rollover automatic at fiscal start (hospital TZ).
- Settings with `requires_approval` route through EN-038; sensitive settings (payment keys, SMS keys) stored encrypted (pgcrypto/Vault ref) and masked in UI/exports.
- Deactivated users: cannot be deleted; historical audit preserved; login rejected with generic message; owned records remain.
- Impersonation: read-only unless approved; never for patient accounts without DPO approval; auto-terminates at 30 min; banner cannot be hidden.
- Feature flags cannot enable modules outside licence; enabling a P0 dependency chain validates dependencies (e.g. IP-005 needs OP-005).
- Retention: sessions/login audit 180 days minimum online (CERT-In), audit per EN-024; access review evidence 3 years.

## 6. API Surface (`/api/v1/admin`, auth under `/api/v1/auth`)

| Method                | Path                                                                                                  | Purpose                             | Permission                                                                           | Notes                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| POST                  | /auth/login ; /auth/mfa/verify ; /auth/refresh ; /auth/logout ; /auth/otp/request                     | verify ; /auth/sso/:provider/start  | callback ; /auth/pin/verify ; /auth/password/forgot                                  | reset                                                         | change         | authentication | public/self                         | rate-limited, audited |
| GET/PUT               | /auth/me ; /auth/me/mfa/enrol                                                                         | confirm                             | disable ; /auth/me/sessions ; DELETE /auth/me/sessions/:id ; /auth/me/recovery-codes | self-service                                                  | self           |                |
| GET/POST/PATCH        | /hospitals ; /hospitals/:id ; /branches                                                               | tenant & branch config              | admin.hospital.configure (Super/Hospital Admin)                                      |                                                               |
| GET/PUT               | /settings?scope ; /settings/definitions                                                               | settings                            | admin.settings.read / admin.settings.configure                                       | approval-aware                                                |
| GET/POST/PATCH/DELETE | /holidays ; POST /holidays/import                                                                     | calendars                           | admin.calendar.configure                                                             |                                                               |
| GET/POST/PATCH        | /numbering-series ; GET /numbering-series/:id/preview ; POST /numbering-series/:id/rollover           | series                              | admin.numbering.configure                                                            |                                                               |
| GET                   | /users?status&role&branch&dept&q ; GET /users/:id                                                     | users                               | admin.user.read                                                                      | cursor, trigram search                                        |
| POST/PATCH            | /users ; /users/:id ; POST /users/:id/invite                                                          | resend ; POST /users/:id/deactivate | reactivate                                                                           | unlock                                                        | reset-password | force-logout   | revoke-mfa ; POST /users/bulk (CSV) | lifecycle             | admin.user.create/update/deactivate ; admin.user.reset | audited |
| GET/POST/DELETE       | /users/:id/roles ; PATCH /users/:id/roles/:urId                                                       | role assignments                    | admin.role.assign (+ approval for sensitive)                                         |                                                               |
| GET/POST/PATCH        | /roles ; /roles/:id ; POST /roles/:id/clone ; GET /roles/:id/diff/:v ; GET /roles/matrix.xlsx         | roles                               | admin.role.read / admin.role.configure                                               |                                                               |
| GET                   | /permissions ; /permissions/unassigned                                                                | catalogue                           | admin.role.read                                                                      |                                                               |
| POST                  | /policy/simulate {userId, action, resource, ctx}                                                      | effective permission trace          | admin.role.read                                                                      |                                                               |
| GET/POST/PATCH        | /sod-rules ; GET /sod-rules/violations                                                                | SoD                                 | admin.role.configure                                                                 |                                                               |
| GET/POST/PATCH        | /access-requests ; POST /:id/approve                                                                  | reject                              | access workflow                                                                      | admin.access.request (any) / admin.access.approve (HOD/Admin) | EN-038         |
| POST/GET              | /access-reviews ; /access-reviews/:id/items ; POST /items/:id/decide                                  | reviews                             | admin.access.review                                                                  |                                                               |
| GET/PUT               | /auth-policies                                                                                        | password/MFA/session policy         | admin.security.configure                                                             | dual control                                                  |
| GET/DELETE            | /sessions?user&branch ; DELETE /sessions/by-user/:id ; POST /sessions/revoke-all {branch}             | session admin                       | admin.session.manage                                                                 |                                                               |
| GET/POST/DELETE       | /devices ; POST /devices/pair ; POST /devices/:id/revoke                                              | device tokens                       | admin.device.manage                                                                  |                                                               |
| GET/PUT               | /sso/providers ; POST /sso/test                                                                       | SSO config                          | admin.security.configure                                                             | EN-025                                                        |
| GET                   | /audit?user&patient&entity&action&from&to ; GET /audit/:id ; GET /audit/export ; GET /audit/integrity | audit viewer                        | admin.audit.read / admin.audit.export (audited)                                      | EN-024                                                        |
| GET/PUT               | /flags ; /flags/:key                                                                                  | feature flags                       | admin.flags.configure                                                                | licence-checked                                               |
| GET                   | /licence ; /licence/seats ; /licence/usage                                                            | licence status                      | admin.licence.read                                                                   | EN-040                                                        |
| POST                  | /impersonate {targetUserId, ticket, reason, mode} ; POST /impersonate/:id/end                         | support                             | admin.impersonate (Super Admin/IT with approval)                                     | audited                                                       |
| GET                   | /status/backup ; /status/security ; /status/integrations                                              | dashboards                          | admin.status.read                                                                    | EN-022/23/17                                                  |
| GET                   | /reports/users ; /reports/role-matrix ; /reports/logins ; /reports/mfa-coverage ; /reports/dormant    | admin reports                       | admin.report.read                                                                    |                                                               |

## 7. Domain Events (outbox)

- `admin.user.created|updated|invited|activated|deactivated|reactivated|locked|unlocked|password_reset|mfa_enrolled|mfa_revoked` → NC-010, EN-037, EN-024.
- `admin.role.created|updated|assigned|revoked|expired` → policy cache invalidation, EN-024.
- `admin.access.requested|approved|rejected`, `admin.access_review.opened|completed`.
- `admin.session.created|revoked|forced_logout|anomalous_login` → EN-037 (user + IT), EN-023 SIEM.
- `admin.settings.changed` → module caches (tariff/queue/etc.), EN-024.
- `admin.numbering.rolled_over`, `admin.holiday.updated` → OP-001 slots, EN-038 SLAs.
- `admin.flag.changed`, `admin.licence.expiring|exceeded` → UI, EN-040.
- `admin.impersonation.started|ended` → DPO digest.
- `admin.device.paired|revoked` → EN-005/EN-018/EN-034.

## 8. Screens

- **Admin Console home** (desktop): tiles (active users, pending access requests, MFA coverage %, locked accounts, licence seats, backup status, security alerts), quick actions.
- **Users** (desktop): virtualised table (search `/`, filters), user drawer (profile, roles per branch with scope chips, sessions, devices, MFA, audit tab), actions menu; bulk import wizard; `N` new user, `E` edit, `Ctrl+K` palette.
- **Roles & Permissions** (desktop): role list (system templates vs custom), permission tree by module with search, ABAC defaults, SoD warnings inline, version diff, clone; matrix export.
- **Access Requests & Reviews** (desktop/tablet for HOD approvals): inbox with approve/reject and justification; campaign attestation grid.
- **Security Policy** (desktop): password/MFA/session/OTP/SSO forms with live policy preview; test SSO login.
- **Sessions & Devices** (desktop): live sessions table (user, device, IP, since, last seen), revoke; device pairing wizard (kiosk/TV/print agent) with code; device health.
- **Hospital & Branch Settings** (desktop): identity/legal/tax, branding, timezone/locale, fiscal, working hours, holidays calendar, DPO/grievance, notification defaults; settings explorer by module with search & history.
- **Numbering Series** (desktop): table with next-number preview, pattern editor with validation, rollover log.
- **Feature Flags & Licence** (desktop): module grid (licensed/enabled/beta/dependencies), rollout controls, seat meters, expiry.
- **Audit Viewer** (desktop): filters, timeline, diff view, PHI access reasons, export; saved searches; integrity check status.
- **Impersonation banner & log** (all screens when active; desktop log).
- **My Profile / Security** (all devices, phone-friendly): photo, language, theme, password, 2FA enrol (QR), passkeys, sessions list with sign-out, PIN set.
- Offline: admin screens require connectivity; login supports cached shell but authentication online (except kiosk device tokens with cached validity ≤ 24 h).

## 9. Integrations

- EN-025 SSO (OIDC/SAML/LDAP), EN-024 audit store, EN-040 licence service, EN-041 group hierarchy, NC-010 HR joiner/mover/leaver events, EN-032/EN-009 invitations/OTP, EN-023 SIEM export (syslog/CEF of login & admin events), EN-022 backup status API, HIBP k-anonymity (optional), NTP status (CERT-In), Vault/SSM secrets for sensitive settings, WebAuthn (FIDO2), TOTP apps.

## 10. Reports & Analytics

- User directory, role matrix (users × roles × branch), permission usage (permissions never used → hygiene), dormant accounts (no login 90 days), MFA coverage, login failures/lockouts trend, session anomalies, admin change log, access review completion, SoD violations, licence seat utilisation & module usage, impersonation log, settings change history. MV `analytics.mv_admin_daily`.

## 11. Notifications

- User: invitation, password reset, new-device login, MFA change, session revoked, access approved/rejected, password expiring in 7 days.
- Admin/IT: pending access requests, lockout spikes, SoD violation attempts, licence expiry/seat exceed, backup failure (EN-022), certificate expiry, dormant account report monthly.
- DPO: daily break-glass digest, weekly impersonation report.

## 12. Permissions (RBAC keys)

`admin.hospital.configure` (Super Admin, Hospital Admin) · `admin.settings.read/configure` (Hospital/Branch Admin; sensitive keys Admin only) · `admin.calendar.configure` · `admin.numbering.configure` (Hospital Admin) · `admin.user.read/create/update/deactivate/reset` (Hospital/Branch Admin, IT Admin for reset/unlock) · `admin.role.read` (Admin, HOD, Auditor) · `admin.role.configure` (Hospital Admin) · `admin.role.assign` (Hospital/Branch Admin; sensitive → dual) · `admin.access.request` (all) · `admin.access.approve` (HOD own dept, Admin) · `admin.access.review` (HOD, Admin) · `admin.security.configure` (Hospital Admin + IT, dual control) · `admin.session.manage` (IT Admin, Hospital Admin) · `admin.device.manage` (IT Admin, Branch Admin) · `admin.audit.read` (Admin, DPO, Auditor) · `admin.audit.export` (DPO, Auditor; audited) · `admin.flags.configure` (Hospital Admin; Super Admin for beta) · `admin.licence.read` · `admin.impersonate` (Super Admin, IT lead with approval) · `admin.status.read` (IT, Admin) · `admin.report.read`.

## 13. Non-functional

- 2000-bed group: ~6000 users, 60 roles, 1500 permission keys, 5000 concurrent sessions; login p95 < 300 ms (Argon2id tuned ~250 ms), permission check < 1 ms (in-memory cache per session, invalidated via pub/sub), user search < 150 ms (trigram).
- Security: Argon2id (m=64MB,t=3,p=1), JWT RS256/EdDSA 15 min, refresh rotation with reuse detection, httpOnly SameSite cookies, CSRF tokens for cookie flows, rate limits (5 login/min/IP+user), audit of all admin actions, secrets encrypted, no PHI in tokens.
- Availability: auth service HA; Redis denylist replicated; on-prem works without internet (except SSO IdP).
- Accessibility: WCAG 2.2 AA forms, keyboard-first tables; i18n all admin strings; RTL.

## 14. Acceptance Criteria

1. Given a new user invited, when they open the link within 48 h, then they set a policy-compliant password, are forced to enrol TOTP if their role requires MFA, and land on the role home.
2. Given 5 failed logins, when the 6th attempt occurs, then the account is locked 15 min, the user and IT are notified, and the login audit shows lockout.
3. Given a role permission removed, when saved, then users with that role lose the action within 5 s across API and UI (cache invalidation).
4. Given a Billing Executive with `amount_limit` discount ≤ 10 %, when applying 15 %, then policy denies with reason and the UI never showed the option beyond 10 %.
5. Given a request to grant "Pharmacy narcotics" role, when submitted, then it requires two approvers, the grantee must have MFA, and the assignment carries validity dates.
6. Given SoD rule "result enter vs validate = block", when assigning both to one user, then assignment is blocked unless Hospital Admin overrides with reason (audited).
7. Given HR emits `hr.employee.exited`, when processed, then the user is deactivated within 1 min, all sessions revoked, and delegated approvals reassigned.
8. Given a session idle 15 min on a clinical screen, when the user returns, then PIN re-auth restores context; after 60 min a full login is required.
9. Given concurrent session limit 3, when a 4th login occurs, then the oldest session is revoked and notified.
10. Given Super Admin starts impersonation without an approved ticket, when attempted, then it is denied; with approval it starts read-only, shows the banner, and ends at 30 min with an audit trail listing both identities.
11. Given a numbering pattern change for BILL_OP, when saved mid-FY, then it applies from next FY and current sequence continues gapless.
12. Given a holiday added, when OP-001 generates slots for that date, then no slots are produced for departments observing the holiday.
13. Given a sensitive setting (SMS API key), when viewed, then it is masked; on change it requires re-auth and is audited without revealing the value.
14. Given a module not in the licence, when an admin toggles its flag, then the toggle is blocked with an upgrade message and no event is emitted.
15. Given the audit viewer, when a DPO searches PHI reads for patient X, then all `READ_PHI` rows with reasons appear and export writes an audit event.
16. Given SSO enforced for staff, when a non-emergency account tries password login, then it is rejected with "use SSO"; emergency accounts still work.
17. Given the quarterly access review, when an HOD does not attest within 14 days, then escalation reaches Hospital Admin and the report flags overdue departments.

## 15. Enhancements / Later phases

- Zero-trust posture (device posture checks, continuous authentication, per-request risk scoring), SIEM integration for threat detection (EN-023), DLP policies (export watermarking, clipboard/print restrictions on PHI screens), automated compliance scanning (ISO 27001/NABH control mapping), DR drill scheduling & results (EN-022), SSL/TLS certificate auto-renewal (ACME) with dashboard, passwordless-first (passkeys), biometric login (EN-020), just-in-time privileged access with auto-expiry, SCIM provisioning from IdP, HPR/HFR auto-verification of professional registrations (EN-011), delegated admin per department, tenant self-service onboarding wizard (SaaS), anomaly detection on access patterns (AI).

## 16. Open Questions for the Hospital

1. Identity provider in use (Azure AD/Google/LDAP)? Should staff SSO be mandatory? Emergency local accounts?
2. Password/MFA policy specifics vs defaults (12 chars, 90-day expiry, MFA roles)? Are hardware keys/passkeys acceptable for admins?
3. HR system as source of truth for joiners/leavers? Employee id format?
4. Approval matrix for role grants (who approves clinical vs financial roles)? SoD conflicts to enforce as block vs warn?
5. Branch/department structure, timezone(s), fiscal year, holiday list, working hours/shifts.
6. Numbering formats for UHID, bills, receipts, IP no, MLC etc. (existing patterns to preserve during migration).
7. Kiosk/TV/print-agent device counts and pairing process ownership (IT vs branch admin).
8. Support impersonation policy: allowed at all? Requires patient/user consent or admin approval?
9. Log retention requirements beyond CERT-In 180 days; SIEM in place?
10. Data Protection Officer and grievance officer details for DPDP notices.
