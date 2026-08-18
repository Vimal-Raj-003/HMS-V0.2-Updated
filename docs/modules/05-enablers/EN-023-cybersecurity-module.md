# EN-023 — Cybersecurity Module (Vulnerability Scanning, Patch Tracking, CERT-In 6-Hour Incident Reporting, SIEM Export, WAF & Rate Limiting, Secret Rotation, Endpoint Compliance, Pen-Test Tracking, Phishing Drills, Security Incident Register)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-023 |
| Phase | 0/9 |
| Priority | P1 |
| Complexity | High |
| Depends on | EN-007 (users, sessions, auth policy, device registry, admin actions), EN-024 (Audit Trail — the log source of truth for security events), EN-022 (Backup & DR — ransomware resilience, restore during incidents), EN-025 (SSO/IdP signals), EN-026 (API Gateway — rate limits, WAF rules, key management), EN-017 (connector credentials & external data flows), EN-037 (alerting/escalation), NC-028 (IT helpdesk tickets), NC-015 (Quality — CAPA, incident CAPA linkage), NC-023 (Legal & Compliance — licences, regulator correspondence), NC-002/NC-020 (asset & biomedical device inventory for endpoint/medical-device security), EN-021 (camera firmware CVEs), EN-020 (biometric endpoint hardening), EN-028 (breach notification to data principals) |
| Feature flag | `module.security.enabled` (always on; sub-flags `security.vuln_scan`, `security.siem_export`, `security.phishing_drills`, `security.edr_integration`, `security.honeytokens`) |
| Primary roles | IT Admin / Security Officer (56 + a dedicated **Information Security Officer** role cloned from it), Super Admin (SaaS — fleet posture) |
| Secondary roles | Hospital Admin (2 — risk acceptance, budget, breach decisions), Privacy Officer / DPO (57 — personal-data breach assessment & notification), Quality Manager (54 — CAPA, NABH evidence), Biomedical Engineer (48 — medical-device patching), Auditor (58), Medical Superintendent (clinical impact decisions during an incident), every user (security awareness, phishing drills) |
| Regulatory | **CERT-In Directions (No. 20(3)/2022)** — mandatory incident reporting **within 6 hours** of noticing, 180-day log retention **within India**, NTP sync to NIC/NPL, point of contact registered with CERT-In, KYC/logs for specified services; **DPDP Act 2023 & Rules 2025** — personal-data breach notification to the Data Protection Board **and to each affected data principal** without delay (Rules prescribe the form and timelines), reasonable security safeguards, DPIA-adjacent obligations for significant data fiduciaries; IT Act 2000 §43A & SPDI Rules 2011 (reasonable security practices — ISO 27001 named as an acceptable standard); NABH 6th ed. **IMS** chapter (information security, access control, incident management, business continuity); ISO/IEC 27001:2022 Annex A controls (A.5 policies, A.8 technical), ISO 27799 (health informatics security); ABDM security & privacy requirements for HIP/HIU; PCI-DSS SAQ-A scope only (no card data stored — EN-010 tokenised); MDR/CDSCO & FDA-style medical-device cybersecurity guidance for connected devices (EN-042, NC-020) |

## 1. Purpose
EN-023 is the hospital's operational security console: it tracks vulnerabilities and patches across servers, endpoints, network gear and connected medical devices; enforces edge protections (WAF rules, rate limits, IP allow/deny) in partnership with EN-026; rotates secrets and certificates; monitors endpoint compliance; runs and records penetration tests and phishing drills; ships security-relevant events to a SIEM; and — most importantly — runs the **security incident register** with the workflows that make India's two hard deadlines achievable in practice: **CERT-In reporting within 6 hours** of noticing a reportable incident and **DPDP breach notification** to the Board and affected patients.

## 2. Users & Jobs-to-be-done
- **Information Security Officer / IT Admin** (desktop, daily): triage overnight alerts, review new CVEs against the asset inventory, chase patch SLAs, run the weekly scan, handle incidents, prepare the CERT-In report inside the 6-hour clock.
- **Hospital Admin**: see the security posture score, approve risk acceptances, authorise the breach notification, allocate budget for remediation.
- **Privacy Officer / DPO**: assess whether an incident is a *personal data breach*, determine the notification set, draft and dispatch DPDP notices, track the 90-day/statutory follow-ups.
- **Biomedical Engineer**: know which connected devices (ventilators, infusion pumps, analyzers, PACS modalities) run vulnerable firmware and cannot simply be patched — mitigations and network isolation instead.
- **Quality Manager**: pull security incidents and CAPA into the NABH IMS evidence pack.
- **Every staff member**: receive phishing simulations and micro-training; report a suspicious email in one click.
- **Super Admin (SaaS)**: fleet posture, cross-tenant vulnerabilities, coordinated patch campaigns.

## 3. Core Workflows

### 3.1 Asset & attack-surface inventory
1. Security assets are assembled automatically rather than hand-typed: servers/containers from the deployment inventory, workstations/tablets/kiosks/TVs from EN-007 `devices` and endpoint agent check-ins, network gear and cameras (EN-021), biometric terminals (EN-020), printers (EN-005), medical devices (NC-020/EN-042), external SaaS/connectors (EN-017), public endpoints (EN-026 API registry, web app, patient portal).
2. Each asset carries: owner, criticality (patient-safety-critical / clinical / administrative), data classification (PHI / financial / HR / operational), exposure (internet-facing / LAN / isolated VLAN), OS & version, agent status, last seen, patch baseline, EOL date.
3. **Attack-surface view**: every internet-facing endpoint with its TLS grade, WAF status, authentication method, rate limits and last scan date — the list a penetration tester would build, kept current automatically.

### 3.2 Vulnerability management (`security.vuln_scan`)
1. **Sources**: dependency scanning in CI (`pnpm audit`, Trivy for images, Semgrep SAST — already in the pipeline per CLAUDE.md), infrastructure scanning (OpenVAS/Nessus/Qualys via EN-017 connector), container/registry scanning, cloud posture checks (CIS benchmarks), and a CVE feed (NVD + CERT-In advisories + vendor bulletins) matched against the asset inventory (CPE/package match).
2. Findings normalise into `sec_vulnerabilities` with CVE id, CVSS v3.1 base/temporal score, EPSS/exploit-availability flag, affected assets, source, first/last seen, status.
3. **Risk scoring** blends CVSS with asset criticality, exposure and data classification — an internet-facing PHI system with a CVSS 7.5 outranks an isolated CVSS 9.8 lab PC, which is how remediation should actually be prioritised.
4. **SLA clock** starts at detection: Critical 7 days, High 15 days, Medium 30 days, Low 90 days (configurable). Breached SLAs escalate to Hospital Admin.
5. Outcomes per finding: **patch** (links to a patch task), **mitigate** (compensating control documented: network isolation, WAF rule, feature disabled), **risk-accept** (Hospital Admin approval, expiry date, mandatory review), **false positive** (evidence required).
6. **Medical devices** get a distinct path: many cannot be patched or are vendor-locked (CDSCO/manufacturer approval). The workflow forces a mitigation record (VLAN isolation, no internet route, restricted protocols, compensating monitoring) and notifies the Biomedical Engineer and the vendor — never a silent "won't fix".

### 3.3 Patch management
1. Patch tasks are generated from vulnerabilities or from a maintenance calendar (OS monthly, database quarterly, application per release, firmware per vendor advisory).
2. Each task: asset group, patch/version, change reference, downtime required?, rollback plan, test evidence, scheduled window (coordinated with EN-022's maintenance-window workflow so clinical impact is announced), approver.
3. Execution recorded with before/after versions and verification (re-scan confirming the CVE is gone — a patch is not done until re-scan proves it).
4. **Patch compliance report**: % of assets on the current baseline by class, ageing of outstanding patches, exemptions with expiry — the metric NABH/ISO auditors ask for.

### 3.4 Security incident management & CERT-In 6-hour reporting
1. **Detection sources**: EN-024 audit anomalies (mass export, break-glass spikes, after-hours admin actions), EN-007 auth signals (brute force, impossible travel, MFA fatigue), EN-026 gateway (rate-limit storms, key abuse), EN-022 (backup deletion attempts, ransomware indicators), EDR/AV agents, WAF blocks, user reports ("report phishing" button), external notification (CERT-In advisory, vendor, researcher, patient complaint).
2. **Incident created** (`sec_incidents`) with: detected_at (the "noticing" timestamp that starts the CERT-In clock), category (from CERT-In's Annex I list: targeted scanning, compromise of critical systems, unauthorised access to IT systems/data, defacement, malware/ransomware, identity theft/phishing, data breach/leak, DoS/DDoS, attacks on servers/network appliances, IoT/medical-device compromise, fake mobile apps, etc.), severity (P1–P4), affected assets, suspected data involvement (PHI? how many records?), initial containment actions.
3. **The 6-hour clock is a first-class UI element**: a visible countdown from `detected_at` appears on the incident and on the security dashboard for any incident flagged CERT-In-reportable. The report form is pre-filled from incident data (organisation details, registered point of contact, incident type, timeline, affected systems, impact, actions taken) and submitted via the CERT-In channel (email/portal), with the submission acknowledgement stored as evidence → Event `security.certin.reported`.
4. **DPDP assessment in parallel**: the DPO answers a structured questionnaire (was personal data involved? whose? what categories? likelihood of harm?) → if it is a personal data breach, the system generates (a) the **Data Protection Board notification** and (b) **per-data-principal notices** in the patients' preferred language and channel (EN-009/EN-032/PE-001), tracks dispatch and acknowledgement, and records the whole decision trail. Notification is not optional under DPDP Rules 2025 — the workflow reflects that.
5. **Lifecycle**: detect → triage → contain (isolate host, revoke sessions/keys, block IP, disable account, pause connector — all executable from the incident screen) → eradicate → recover (with EN-022 restore if needed) → **post-incident review** with root cause, timeline, lessons, CAPA into NC-015 → close with evidence pack.
6. **War-room mode**: a P1 opens a coordinated view — timeline, actions log, participants, communications draft, clinical impact assessment (which modules are degraded, what the downtime procedure is), and a decision log with named decision-makers.

### 3.5 Edge protection: WAF, rate limiting, IP controls
- Managed WAF rule sets (OWASP CRS via Cloudflare/Nginx/Traefik/ModSecurity) with per-route tuning; false-positive review queue so a clinical workflow is never silently blocked by an over-eager rule.
- Rate limits and quotas are defined in EN-026 but their **security thresholds and anomaly alerts** live here: login attempts, OTP requests, verification endpoints (EN-016/EN-020), search endpoints, export endpoints.
- IP allow/deny lists (admin console from hospital networks only, TPA/partner ranges, geo-blocking where the hospital has no international users), bot management, DDoS posture, TLS configuration monitoring (grade, cipher suites, HSTS, certificate expiry).
- Egress control: which outbound destinations are permitted from the application/backup networks — a ransomware exfiltration control and a DPDP data-flow control.

### 3.6 Secret & key rotation
- Registry of every secret with owner, type (DB password, API key, JWT signing key, HMAC key for QR/webhooks, encryption DEK/KEK, SSH key, TLS certificate, service account), storage location (Vault/KMS), created, last rotated, rotation period, and **rotation runbook**.
- Automated rotation where supported (database roles, JWT signing key with overlap window, S3 keys, HMAC keys with dual-key acceptance), assisted rotation elsewhere with checklists.
- Triggers: schedule, staff exit (EN-007 `hr.employee.exited` for anyone who knew a shared secret), vendor incident, suspected compromise (immediate, one-click "rotate everything in this blast radius").
- Certificate expiry monitoring (TLS, DSC — EN-016, SAML/OIDC signing — EN-025, mTLS client certs — EN-017) with 60/30/7-day alerts and auto-renewal (ACME) status.

### 3.7 Endpoint compliance & EDR
- Endpoint agent (or MDM) reports per device: OS patch level, disk encryption, AV/EDR present & updated, screen-lock timeout, admin rights, USB policy, unauthorised software, last user, location. Non-compliant devices are listed with the specific failing control and can be **conditionally restricted** (e.g. a device without disk encryption cannot access PHI screens — enforced via EN-007 device policy).
- Special handling for shared clinical workstations (fast user switching, kiosk hardening, auto-logoff — HIPAA-style "automatic logoff" control), tablets on wards, and BYOD phones running the PWA (no local PHI storage beyond the encrypted offline queue, remote wipe of the app data).

### 3.8 Penetration testing & phishing drills
- **Pen-test register**: scope, vendor, dates, methodology (OWASP ASVS/WSTG), findings with severity, remediation owner, retest date, closure evidence, executive report file. Annual external test + test after major releases is the expected cadence for a PHI system; overdue tests are a posture finding.
- **Phishing drills** (`security.phishing_drills`): campaign builder (template, target group, schedule), landing page with a teachable moment, metrics (open/click/credential-submit/report rates), automatic micro-training assignment (NC-027) for those who clicked, and a "reported by user" leaderboard that rewards reporting rather than shaming clicking. Results are aggregated for management; **individual results are not used punitively** by default (a policy setting, because it materially changes reporting culture).
- Security-awareness training compliance tracking (onboarding + annual refresher) tied to NC-027 and to role sensitivity.

### 3.9 SIEM export & log integrity (`security.siem_export`)
- Normalised security events (auth, admin changes, PHI access, exports, integration errors, WAF blocks, EDR alerts) exported in **CEF/LEEF/JSON over syslog or HTTPS** to Splunk/QRadar/Wazuh/Elastic/Sentinel, with a field map that guarantees **no PHI leaves in the payload** (patient identifiers hashed/tokenised).
- CERT-In log retention: 180 days minimum, stored in India, with integrity protection (EN-024 hash chain) and a documented access process. NTP sync to NIC/NPL is monitored and alerted (a specific CERT-In requirement that is easy to fail silently).

### 3.10 Exceptions
- A patch would break a clinical system → documented exception with compensating controls, Hospital Admin approval, expiry and review; visible on the posture dashboard as accepted risk (not hidden).
- Scanner causes instability on a medical device → scanning of that VLAN is restricted to passive discovery only, recorded as a known limitation.
- Incident during a clinical emergency → containment actions that would disrupt patient care (e.g. isolating the ward network) require Medical Superintendent concurrence, recorded in the decision log.
- Vendor/partner breach (EN-017 connector, SaaS processor) → third-party incident record, contract/DPA obligations checked (NC-031), possible DPDP notification even though the breach was at the processor.

## 4. Data Model (schema `core`, prefix `sec_`)
- `sec_assets` — id, hospital_id, branch_id?, kind enum(server/container/workstation/tablet/kiosk/tv/printer/network/camera/biometric/medical_device/mobile/saas/endpoint_api), name, hostname, ip, mac, owner_user_id, criticality enum(patient_safety/clinical/administrative/low), data_classes text[], exposure enum(internet/lan/isolated), os, os_version, agent_status, last_seen_at, patch_baseline, eol_date, vendor, model, source enum(auto_discovered/en007_device/nc020_asset/manual), notes; index (hospital_id, exposure, criticality).
- `sec_vulnerabilities` — id, hospital_id, source enum(ci_dependency/container/infra_scan/cloud_posture/cve_feed/pentest/bug_report), cve_id?, title, description, cvss_vector, cvss_score numeric, epss numeric?, exploit_known bool, package/component, fixed_version, first_seen_at, last_seen_at, status enum(open/in_progress/patched/mitigated/risk_accepted/false_positive), risk_score numeric (computed), sla_due_at, closed_at, evidence jsonb; `sec_vulnerability_assets` (vulnerability_id, asset_id, detected_at, resolved_at).
- `sec_patches` — id, hospital_id, title, asset_group jsonb, target_version, vulnerability_ids uuid[], change_ref, requires_downtime bool, window_start, window_end, rollback_plan, status enum(planned/approved/in_progress/completed/failed/rolled_back/exempted), approved_by, executed_by, verification enum(pending/rescan_pass/rescan_fail), completed_at, notes.
- `sec_incidents` — id, hospital_id, incident_no (series `SEC`), title, category (CERT-In taxonomy), severity enum(p1/p2/p3/p4), detected_at, detected_by, detection_source, reported_by, status enum(new/triage/contained/eradicated/recovering/post_review/closed), affected_assets uuid[], affected_modules text[], personal_data_involved bool, data_categories text[], records_estimate int, patient_safety_impact bool, certin_reportable bool, certin_due_at (detected_at + 6 h), certin_reported_at, certin_ref, dpdp_breach bool, dpb_notified_at, principals_notified_at, principals_count, containment jsonb, root_cause, timeline jsonb, lessons, capa_refs jsonb (NC-015), closed_at, evidence_file_id; index (hospital_id, status, detected_at desc), (certin_due_at) where certin_reportable.
- `sec_incident_actions` — id, incident_id, at, actor_id, action enum(isolate_host/revoke_sessions/rotate_secret/block_ip/disable_account/pause_connector/restore_backup/notify/decision/other), detail jsonb, approved_by?, result.
- `sec_breach_notifications` — id, incident_id, kind enum(dpb/data_principal/certin/regulator/partner/insurer), recipient_ref, channel, language, template_version, content_file_id, sent_at, delivered_at, acknowledged_at, failure_reason.
- `sec_secrets` — id, hospital_id, key_name, type enum(db_password/api_key/jwt_signing/hmac/dek/kek/ssh/tls_cert/service_account), store enum(vault/kms/env), owner_user_id, created_at, last_rotated_at, rotation_days, next_rotation_at, auto_rotatable bool, runbook_ref, blast_radius jsonb, status; **never stores the secret value**.
- `sec_certificates` — id, hospital_id, kind enum(tls/dsc/saml/oidc/mtls), subject, issuer, serial, not_before, not_after, auto_renew bool, renewal_status, asset_ref, alerted_at.
- `sec_endpoint_compliance` — id, asset_id, checked_at, disk_encrypted bool, av_present bool, av_updated_at, os_patch_current bool, screen_lock_sec int, admin_rights bool, unauthorised_software jsonb, usb_policy bool, compliant bool, failing_controls text[], action_taken.
- `sec_pentests` — id, hospital_id, scope, vendor, methodology, start_date, end_date, report_file_id, findings_count jsonb (by severity), status, retest_due, closure_evidence_file_id.
- `sec_pentest_findings` — id, pentest_id, title, severity, cvss, description, remediation, owner_user_id, due_date, status, retest_result.
- `sec_phishing_campaigns` / `sec_phishing_results` — campaign (template, audience, schedule, landing page, training assignment), results (user_id, sent, opened, clicked, submitted_credentials, reported, training_completed) — individual results access-restricted.
- `sec_siem_exports` — id, hospital_id, destination, format enum(cef/leef/json), transport enum(syslog_tls/https/kafka), event_types text[], field_map jsonb, phi_redaction jsonb, last_sent_at, backlog, status, health.
- `sec_posture_snapshot` (materialised, hourly) — hospital_id, score int, open_critical_vulns, sla_breaches, unpatched_pct, incidents_open, mfa_coverage_pct, endpoint_compliance_pct, last_pentest_at, next_drill_due, certificate_expiring_30d, backup_posture (EN-022), issues jsonb.
- `sec_risk_acceptances` — id, hospital_id, subject_type (vuln/finding/config), subject_id, justification, compensating_controls, approved_by (Hospital Admin), approved_at, expires_at, review_at, status.

## 5. Business Rules & Validations
- **The 6-hour CERT-In clock starts at `detected_at`** (when the incident was noticed), not when triage completed. `detected_at` is set once and can only be amended with a reason and audit entry. Any incident flagged reportable shows the countdown until the report is filed and the acknowledgement stored.
- The DPDP breach assessment is mandatory for every incident where `personal_data_involved` is true or unknown; it cannot be skipped or deferred past incident closure, and the DPO is the decision-maker (not IT).
- Logs and security events are retained **≥ 180 days within India** (CERT-In); retention cannot be reduced below this by configuration, and log storage location is validated against the residency setting.
- NTP synchronisation to an authorised source is monitored; drift beyond tolerance raises a compliance alert (timestamps are the backbone of both audit and incident reporting).
- Vulnerability SLAs are enforced by escalation, and a breached SLA cannot be cleared by closing the finding without one of: patch verified by re-scan, documented mitigation, or an approved, time-bounded risk acceptance.
- Risk acceptances expire (max 12 months), require Hospital Admin approval, must name compensating controls, and are shown on the posture dashboard — accepted risk is visible risk.
- Medical devices are never marked "patched" without vendor confirmation; unsupported/EOL devices must have a documented isolation control.
- Containment actions that could affect patient care (network isolation of a clinical VLAN, disabling a clinical account, taking a module offline) require a recorded decision with the Medical Superintendent's concurrence for P1 incidents.
- Secrets are never stored or displayed by this module; only metadata. Rotation on staff exit is automatic for shared secrets in that person's blast radius.
- Phishing-drill individual results are visible only to the Security Officer and are not shared with line managers unless the hospital explicitly enables punitive mode (default off) — recorded as a policy decision.
- SIEM exports must pass a PHI-redaction check; any field map that would export a name, phone, address or clinical text is rejected at configuration time.
- Every security incident record is append-only; the timeline and action log cannot be edited retrospectively (only appended with corrections).
- Posture score is computed, not hand-set, and its formula is documented and versioned so trends mean something.

## 6. API Surface (`/api/v1/security`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET | /posture ; /posture/history ; /posture/fleet | security posture | `security.posture.read` / `.fleet` (Super Admin) | hourly snapshot |
| GET/POST/PATCH | /assets ; POST /assets/sync | security asset inventory | `security.asset.manage` | auto-discovery |
| GET | /attack-surface | internet-facing endpoints & controls | `security.posture.read` | |
| GET/POST | /vulnerabilities ; PATCH /vulnerabilities/:id ; POST /vulnerabilities/import | findings | `security.vuln.manage` | scanner ingest via EN-017 |
| POST | /vulnerabilities/:id/accept-risk \| /mitigate \| /false-positive | disposition | `security.vuln.manage` (accept-risk → Hospital Admin) | expiry mandatory |
| GET/POST/PATCH | /patches ; POST /patches/:id/execute \| /verify | patch tasks | `security.patch.manage` | window ties to EN-022 |
| GET/POST/PATCH | /incidents ; GET /incidents/:id | incident register | `security.incident.manage` / `.read` | append-only timeline |
| POST | /incidents/:id/actions | containment/eradication actions | `security.incident.act` | some require approval |
| POST | /incidents/:id/certin-report ; GET /incidents/:id/certin-form | CERT-In 6-hour report | `security.certin.report` (ISO + Hospital Admin) | pre-filled, ack stored |
| POST | /incidents/:id/dpdp-assessment ; POST /incidents/:id/notify-principals | DPDP breach workflow | `security.breach.notify` (DPO) | multilingual notices |
| POST | /incidents/:id/close | post-incident review & close | `security.incident.manage` | RCA + CAPA required |
| GET/POST/PATCH | /secrets ; POST /secrets/:id/rotate ; POST /secrets/rotate-blast-radius | secret registry & rotation | `security.secret.manage` | values never returned |
| GET | /certificates ; POST /certificates/:id/renew | certificate expiry | `security.secret.manage` | ACME status |
| GET/POST | /endpoint-compliance ; POST /endpoints/:id/restrict | endpoint posture | `security.endpoint.manage` | conditional access |
| GET/POST/PATCH | /pentests ; /pentests/:id/findings ; POST /findings/:id/retest | pen-test register | `security.pentest.manage` | report files |
| GET/POST | /phishing/campaigns ; GET /phishing/results ; POST /report-phishing (any user) | drills & user reporting | `security.awareness.manage` / any user | individual results restricted |
| GET/PUT | /waf/rules ; /rate-limits ; /ip-lists ; GET /waf/blocks | edge protection | `security.edge.manage` | coordinates with EN-026 |
| GET/PUT | /siem-exports ; POST /siem-exports/:id/test | SIEM configuration | `security.siem.manage` | PHI-redaction validated |
| GET | /alerts ; POST /alerts/:id/ack \| /escalate | security alerts | `security.incident.read` | |
| GET | /reports/vuln-sla ; /reports/patch-compliance ; /reports/incidents ; /reports/awareness ; /reports/compliance-pack | reports | `security.report.read` | NABH/ISO evidence |

## 7. Domain Events (outbox)
- `security.vulnerability.detected|sla_breached|closed|risk_accepted` → EN-037, NC-028 ticket, posture recompute.
- `security.patch.scheduled|completed|failed` → EN-022 maintenance window, NC-020 (device firmware), change log.
- `security.incident.opened|escalated|contained|closed` → EN-037 (on-call), NC-015 CAPA, Hospital Admin, Medical Superintendent for P1.
- `security.certin.due_soon|reported|overdue` → **hard escalation** to ISO + Hospital Admin (overdue is a regulatory failure).
- `security.breach.assessed|dpb_notified|principals_notified` → EN-028 consent/notice ledger, DPO record, NC-023 legal file.
- `security.secret.rotated|rotation_overdue`, `security.certificate.expiring|expired` → owners, EN-017 (connector credentials), EN-016 (DSC), EN-025 (IdP signing keys).
- `security.endpoint.non_compliant|restricted` → EN-007 device policy, user notice.
- `security.phishing.campaign_completed`, `security.training.overdue` → NC-027.
- `security.anomaly.detected` (mass export, break-glass spike, impossible travel, backup deletion attempt) → incident auto-draft.
- Consumes: `admin.session.anomalous_login`, `admin.user.locked`, `audit.export.performed`, `audit.integrity.mismatch` (EN-024), `dr.ransomware.suspected` (EN-022), `integration.credential.expiring` (EN-017), `hr.employee.exited` (secret rotation), `gateway.rate_limit.exceeded` (EN-026).

## 8. Screens (UI)
- **Security Posture Dashboard** (desktop; summary tile on the EN-007 admin home): posture score with trend, open critical vulnerabilities, SLA breaches, open incidents by severity, MFA coverage, endpoint compliance %, backup posture (from EN-022), certificates expiring, last pen-test, next drill — each tile drilling into its worklist. Amber/red tiles carry the specific number and owner, never a vague warning.
- **Vulnerability Worklist** (desktop): virtualised table (risk score, CVE, title, assets, exposure, CVSS, EPSS, SLA countdown, status, owner), grouped-by-asset and grouped-by-CVE toggles, bulk disposition, filters for internet-facing/PHI/medical-device. Shortcuts `/` search, `A` assign, `R` risk-accept, `P` create patch task.
- **Patch Board** (desktop): kanban (planned → approved → in progress → verified) with maintenance-window calendar overlay and clinical-impact flags.
- **Incident Console** (desktop + phone for on-call): incident header with severity, status and — for reportable incidents — a prominent **CERT-In countdown timer**; tabs: Timeline (append-only), Actions (with one-click containment buttons and their approval state), Evidence, Data-breach assessment (DPO panel), Communications (drafts, approvals, dispatch tracking), Post-incident review (RCA, CAPA). War-room mode shows participants and a decision log.
- **CERT-In Report Composer**: pre-filled form matching CERT-In's reporting format, mandatory-field validation, preview, submit, acknowledgement upload, and the resulting audit record.
- **DPDP Breach Notification Builder** (DPO): affected-principal cohort builder with counts, notice template in 8 languages with plain-language description of the breach and mitigation advice, channel selection, dispatch progress, acknowledgement tracking, Board notification copy.
- **Secrets & Certificates** (desktop): registry with rotation status chips and countdowns, "rotate now" and "rotate blast radius" actions with confirmation, certificate expiry calendar.
- **Endpoint Compliance** (desktop): device table with failing-control chips, per-device history, restrict/allow actions.
- **Pen-test & Awareness** (desktop): pen-test register with findings burndown; phishing campaign builder and results dashboard with report-rate emphasised over click-rate.
- **Report Phishing** (every user, one click in the app header and in email footer): submits the suspicious message, thanks the user immediately, and auto-creates a triage item.
- Empty/error states: "No open critical vulnerabilities — last scan 6 h ago", "Scanner unreachable — findings may be stale since <date>", "CERT-In report due in 2 h 14 min".

## 9. Integrations
- **Scanners/CI**: `pnpm audit`, Trivy, Semgrep, Grype, OpenVAS/Nessus/Qualys, cloud posture (AWS Security Hub / Azure Defender), CIS benchmark tooling — ingested via EN-017 connectors.
- **CVE/advisory feeds**: NVD, CERT-In advisories, vendor bulletins (Microsoft, Red Hat, PostgreSQL, medical-device manufacturers), EPSS.
- **EDR/AV/MDM**: CrowdStrike/SentinelOne/Defender/Wazuh; Intune/Jamf/Scalefusion for device compliance; syslog/API ingestion.
- **SIEM**: Splunk, QRadar, Sentinel, Elastic, Wazuh via CEF/LEEF/JSON over syslog-TLS or HTTPS.
- **Edge**: Cloudflare (WAF, rate limiting, bot management, DDoS) in cloud; Nginx/Traefik + ModSecurity + fail2ban on-prem.
- **Secrets**: HashiCorp Vault, AWS SSM/KMS, Azure Key Vault; ACME/Let's Encrypt for TLS.
- **CERT-In**: reporting channel (email/portal) with the hospital's registered point of contact; **DPB** portal for DPDP notifications; NIC/NPL NTP servers.
- **NC-028** helpdesk for remediation tickets; **NC-015** CAPA; **NC-027** training assignments; **NC-020** biomedical device inventory and vendor advisories.

## 10. Reports & Analytics
- Posture score trend, vulnerability ageing and SLA compliance by severity/asset class, patch compliance %, mean time to detect / contain / recover (MTTD/MTTC/MTTR), incident counts by category and root cause, CERT-In reporting timeliness (reported within 6 h: yes/no per incident — a metric the hospital must be able to prove), DPDP notification timeliness and coverage, phishing click vs report rates over time, training completion, endpoint compliance %, MFA/SSO coverage, certificate and secret rotation hygiene, third-party/processor risk register, pen-test finding burndown. **Compliance pack** export mapping evidence to NABH IMS and ISO 27001 Annex A controls.

## 11. Notifications
- ISO/IT on-call: P1 incident (phone + push), new critical vulnerability on an internet-facing PHI asset, CERT-In deadline at T-4 h/T-2 h/T-1 h, ransomware indicators, backup deletion attempt, WAF anomaly spike, EDR alert.
- Hospital Admin: risk-acceptance requests, SLA breaches, incident escalation, breach notification authorisation, monthly posture summary.
- DPO: any incident with possible personal-data involvement (immediately), notification deadlines, principal-notification dispatch status.
- Asset owners/Biomedical: vulnerabilities on your assets with due dates; device firmware advisories.
- All users: security advisories, phishing-drill teachable moment, mandatory training due, forced password/secret changes after an incident.
- Super Admin: fleet-wide critical CVE affecting all tenants (coordinated patch campaign).

## 12. Permissions (RBAC keys)
`security.posture.read` (ISO, IT Admin, Hospital Admin, Auditor) · `security.posture.fleet` (Super Admin) · `security.asset.manage` (IT Admin) · `security.vuln.manage` (ISO, IT Admin) · `security.patch.manage` (IT Admin, Biomedical for devices) · `security.incident.read` (ISO, IT, Admin, DPO, Auditor) · `security.incident.manage` (ISO, IT Admin) · `security.incident.act` (ISO, IT Admin; care-impacting actions need Medical Superintendent concurrence) · `security.certin.report` (ISO + Hospital Admin) · `security.breach.notify` (DPO only) · `security.secret.manage` (IT Admin, dual control for KEK) · `security.endpoint.manage` (IT Admin) · `security.pentest.manage` (ISO) · `security.awareness.manage` (ISO, HR) · `security.edge.manage` (IT Admin) · `security.siem.manage` (IT Admin) · `security.report.read` (Admin, Quality, Auditor).

## 13. Non-functional
- Scale: ~2000 security assets (servers, endpoints, devices, cameras, printers, medical devices) per 2000-bed campus; ~50k security events/day exported to SIEM; vulnerability findings in the low thousands with continuous scanning.
- Detection-to-alert latency < 60 s for auth/anomaly signals; SIEM export lag < 5 min; posture snapshot hourly (on-demand refresh available).
- Incident console must be usable from a phone on a poor connection during an outage (it may be the only working screen) — lightweight, works read-only if the main app is degraded, and the CERT-In countdown is computed client-side from `detected_at`.
- Log retention ≥ 180 days online in India, hash-chained (EN-024), with a documented, audited access path.
- Security of the security module itself: MFA mandatory for all security roles, step-up for containment actions and secret rotation, all actions audited, and the module's own data included in EN-022 backups with immutable copies.
- No PHI in SIEM exports, alerts, tickets or vendor reports — identifiers are tokenised; the redaction is verified by automated tests.
- On-prem: full functionality without internet except CVE feed refresh, CERT-In submission and cloud WAF (all degrade gracefully with clear staleness indicators).

## 14. Acceptance Criteria
1. Given a security incident is created with `detected_at` and flagged CERT-In-reportable, when the incident screen is opened, then a countdown to `detected_at + 6 hours` is displayed prominently and escalations fire at T-4 h, T-2 h and T-1 h.
2. Given a CERT-In report is submitted, when the acknowledgement is uploaded, then `certin_reported_at` and the reference are stored, the countdown stops, and the timeliness report records whether the 6-hour deadline was met.
3. Given an incident involves personal data, when the DPO completes the breach assessment and confirms it is a reportable breach, then Data Protection Board notification and per-data-principal notices are generated in the patients' preferred languages, dispatched via their preferred channels, and dispatch/acknowledgement is tracked.
4. Given an incident is closed without a root-cause analysis or CAPA, when closure is attempted, then it is blocked with the missing items listed.
5. Given a new critical CVE is published affecting an internet-facing PHI server, when the feed is ingested, then a finding is created within 24 hours, risk-scored above internal-only findings of the same CVSS, assigned an SLA of 7 days, and the owner is notified.
6. Given a patch task is executed, when re-scan does not confirm remediation, then the vulnerability stays open, the patch is marked `rescan_fail`, and the SLA clock continues.
7. Given a vulnerability on a medical device that the vendor will not patch, when disposition is set, then the workflow requires a documented mitigation (isolation/compensating control) and Biomedical Engineer acknowledgement; "won't fix" alone is not accepted.
8. Given a risk acceptance is approved, when its expiry date passes, then the finding reopens automatically, the posture reflects it, and Hospital Admin is notified.
9. Given a staff member leaves, when `hr.employee.exited` is processed, then every shared secret in their blast radius is queued for rotation and overdue rotations escalate.
10. Given a TLS certificate expires in 30 days, when the daily check runs, then the owner is alerted, auto-renewal status is shown, and a failed renewal escalates at 7 days.
11. Given a SIEM field map that would export patient names, when it is saved, then configuration is rejected with the offending field identified.
12. Given an endpoint reports no disk encryption, when the compliance check runs, then the device is marked non-compliant with the failing control, the user and IT are notified, and (if conditional access is enabled) the device cannot open PHI screens.
13. Given a phishing drill runs, when a user clicks the simulated link, then they see a teachable-moment page, micro-training is assigned, and their individual result is visible only to the Security Officer.
14. Given a user clicks "Report phishing", when the report is submitted, then a triage item is created, the user gets immediate positive acknowledgement, and the report rate metric increments.
15. Given containment requires isolating a clinical ward VLAN during a P1, when the action is attempted, then it requires the Medical Superintendent's concurrence, and the decision with its clinical-impact assessment is recorded in the incident timeline.
16. Given the compliance pack is exported, when generated, then it maps current evidence (policies, scans, patch compliance, incidents, drills, training, pen-test) to NABH IMS and ISO 27001 Annex A controls in one document.
17. Given NTP synchronisation to the authorised source fails, when the check runs, then a compliance alert is raised, because accurate timestamps underpin both audit and incident reporting.

## 15. Enhancements / Later phases
- User & Entity Behaviour Analytics (UEBA) over EN-024 audit data — clinician access patterns, unusual PHI access volumes, off-hours behaviour — with tuned, low-noise alerting.
- SOAR-style playbook automation: one-click "compromise response" that revokes sessions, rotates the blast radius, blocks IPs, isolates hosts and opens the war room.
- Honeytokens and canary records (fake patient records that should never be accessed) as a high-signal insider-threat detector (`security.honeytokens`).
- Deception and dark-web monitoring for leaked hospital credentials; continuous external attack-surface monitoring.
- Zero-trust rollout: device posture as a first-class factor in every session (EN-007), micro-segmentation of clinical VLANs, per-request risk scoring.
- Medical-device security programme: SBOM ingestion for connected devices, manufacturer disclosure (MDS2-style) tracking, network behaviour baselining per device model.
- Automated ISO 27001/NABH control mapping with continuous control testing and gap dashboards; readiness scoring for certification audits.
- Third-party/processor risk management (questionnaires, DPA tracking, breach clauses) integrated with NC-021/NC-031.
- Tabletop exercise builder for cyber-incident simulations involving clinical leadership, complementing EN-022's technical drills.
- AI-assisted incident summarisation and CERT-In draft generation (human-approved before submission).

## 16. Open Questions for the Hospital
1. Is there a named Information Security Officer, and is the hospital's point of contact registered with CERT-In as required?
2. Existing security tooling: EDR/AV, MDM, SIEM, vulnerability scanner, WAF — what is in place and what should EN-023 integrate with rather than replace?
3. Patch SLAs and maintenance windows acceptable to clinical operations, especially for systems that require downtime.
4. Which connected medical devices exist, what firmware do they run, and what is the vendor's patching commitment? Are they on a segregated VLAN today?
5. Who authorises a breach notification to patients — Hospital Admin, DPO, or the board? What is the approval chain outside working hours?
6. Log retention capability: can 180+ days of logs be stored in India, and where (on-prem, cloud region)?
7. Is an annual external penetration test budgeted? Who is the vendor and what is the scope (external, internal, application, medical devices)?
8. Phishing-drill policy: is it acceptable to run simulations on clinical staff, and should individual results ever be shared with managers?
9. Cyber-insurance requirements — does the policy mandate specific controls, evidence or notification timelines?
10. Remote access model for vendors (analyzer/PACS/biomedical support): jump host, time-bounded accounts, session recording?
11. Does the hospital intend to pursue ISO 27001 certification, and by when? That materially changes evidence expectations.
12. BYOD policy for clinical staff using the PWA on personal phones, and appetite for conditional access enforcement.
