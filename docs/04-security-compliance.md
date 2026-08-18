# 04 — Security, Privacy & Regulatory Compliance

> India-first, global-ready. Every control below is either implemented in code or evidenced as a documented process.
> Claude Code must treat this file as a checklist: no module ships without ticking the relevant rows.

## 1. Regulatory map (what applies, and what it forces us to build)

| Regulation | Applies to | Concrete product obligations |
|---|---|---|
| **DPDP Act 2023 + DPDP Rules 2025** (notified 14 Nov 2025; consent-manager registration from ~Nov 2026; full compliance by ~14 May 2027) | all personal data | standalone plain-language consent notice per purpose; itemised consent, no pre-ticked boxes; easy withdrawal; **breach notice to affected persons without delay and to the Data Protection Board within 72 hours of discovery**; retention limited to purpose; **security logs retained ≥1 year**; verifiable guardian consent for under-18s and no tracking/targeted ads for children; DSAR (access/correction/erasure) answered within **90 days**; grievance officer published; likely **Significant Data Fiduciary** duties for large hospitals → DPO, annual DPIA, annual independent audit. Penalties up to ₹250 crore. → build EN-028 consent ledger, PE-001 DSAR self-service, EN-024 audit, retention jobs, breach runbook. |
| **ABDM (NHA)** | ABHA-linked records | ABHA creation/verification (M1), HIP data sharing on consent (M2) with **FHIR R4 NRCeS-profiled bundles** (OPConsultNote, DischargeSummary, DiagnosticReport, Prescription, ImagingStudy, ImmunizationRecord, WellnessRecord, HealthDocumentRecord) encrypted with **Fidelius/ECDH**, HIU consent requests (M3), NHCX claims (M4); HFR facility + HPR practitioner registration; V3 APIs, synchronous discovery, linking-token persistence; sandbox → **STQC / CERT-In security audit** → production. → EN-011, EN-019, RC-001. |
| **NABH (5th/6th ed.)** | accredited hospitals | patient rights & informed consent, medication safety incl. high-alert drugs & look-alike/sound-alike, correct patient identification (2 identifiers), surgical safety checklist, HIC/HAI surveillance, incident reporting & CAPA, quality indicators with monthly review, MRD completeness & retention, credentialing/privileging of clinicians, patient satisfaction, discharge summary content & timeliness. → IP-003, IP-006, IP-012, NC-003, NC-015, EN-030. |
| **NABL 112 / ISO 15189** | laboratory | request/sample identification, rejection criteria, IQC (Levey-Jennings, Westgard), EQA/PT, TAT monitoring, critical value **read-back and documented call-back**, result amendment traceability, personnel competency, method validation, equipment calibration. → OP-004, EN-004, EN-031. |
| **AERB** | radiology | equipment registration/licence (eLORA), radiation dose records & DRLs, personnel TLD badges, QA tests, pregnancy check before imaging. → OP-008, NC-020, NC-023. |
| **PC-PNDT Act** | ultrasound/imaging | Form F for every obstetric ultrasound, no sex determination or disclosure (product-level block), machine & doctor registration, monthly returns. → OP-008, OP-040, AI-007. |
| **CDSCO / Drugs & Cosmetics Act; NDPS Act** | pharmacy | Schedule H/H1 register (H1 register with prescriber details retained 3 years), Schedule X, **NDPS narcotic register with dual authorisation and physical stock reconciliation**, drug licence tracking, batch/expiry traceability, recall. Implant **UDI/GS1 traceability** and Materiovigilance (MvPI) reporting. → OP-003, IP-014, TR-003, NC-007. |
| **Drugs & Clinical Trials / ART Act 2021, MTP Act, MHCA 2017, POCSO, Transplantation of Human Organs Act** | specialty | ART registry & consent (OP-024), MTP confidentiality (OP-040), mental-health advance directives & restricted notes (OP-032), POCSO reporting & minor protection (TR-008), NOTTO donor/recipient records (IP-019). |
| **Blood: Drugs & Cosmetics Rules Part XII-B, NBTC/SBTC, e-RaktKosh** | blood bank | donor eligibility & deferral, mandatory TTI testing (HIV, HBV, HCV, syphilis, malaria), component labelling, cross-match records, transfusion reaction reporting, statutory registers & returns. → IP-007. |
| **BMW Rules 2016 (as amended)** | whole hospital | colour-coded segregation, barcoded bags, daily quantity log, 48-hour storage limit, authorised operator manifests, **Form IV annual report** to SPCB. → NC-016. |
| **GST Act; Income Tax (TDS, §269ST); Companies Act** | finance | tax invoice vs bill of supply, HSN/SAC, e-invoicing threshold awareness, GSTR-1/3B data, TDS (194J/194C/194R), **cash receipt cap ₹2,00,000 per person per day (§269ST)**, depreciation schedules. → OP-005, NC-009, NC-002. |
| **TRAI TCCCPR / DLT** | SMS | registered header & template, consent & preference (DND) scrubbing, transactional vs promotional classification, audit trail. → EN-009. |
| **Telemedicine Practice Guidelines 2020 (NMC)** | teleconsults | identity verification, consent record, prescription limitations by consultation mode, record retention. → OP-018. |
| **IT Act 2000 §3A/§65B; BSA 2023 §63** | e-signatures & evidence | valid e-sign types, certificate for electronic evidence in court (MLC/forensic). → EN-016, TR-008. |
| **CERT-In Directions (2022)** | cyber incidents | report specified incidents **within 6 hours**, maintain logs in India for 180 days, synchronise clocks to NIC/NPL NTP. → EN-023. |
| **Clinical Establishments Act / state rules** | registration | licence tracking, display of rates (cost transparency → RC-008), record retention (adult 3 yr from last contact per MCI; NABH & medico-legal longer — configure per state). → NC-023, NC-003. |
| **Global (when deployed abroad)** | | HIPAA Security/Privacy (US-style controls already met by our design), GDPR (DSAR, DPO, transfers), UAE ADHICS / Qatar QHIE, Saudi NPHIES — handled by config: data residency, consent text, code systems, claim formats. |

## 2. Identity, authentication, session

- Passwords: Argon2id (memory ≥ 64 MB, t=3), policy configurable (default: min 12 chars, complexity, 90-day
  rotation for privileged roles, last-5 history, lockout 5 attempts / 15 min, breach-password blocklist).
- MFA: TOTP mandatory for Admin, Finance, Pharmacy-narcotics, Blood bank, MRD-export, Privacy Officer; WebAuthn
  supported; SMS OTP only for patients.
- SSO: OIDC/SAML/LDAP with group→role mapping and SCIM provisioning (EN-025); local break-glass accounts kept
  sealed and alerted on use.
- Tokens: access JWT 15 min (tenant, branch, roles, session id), refresh token rotating + reuse detection, httpOnly
  SameSite=Strict cookies; device binding; concurrent-session cap; idle timeout 15 min with PIN quick-unlock on
  clinical screens; absolute session 12 h.
- Patient auth: mobile OTP (rate-limited, 5/hour), ABHA login; family access requires explicit consent artefacts;
  minors' accounts controlled by guardian with age-out at 18.

## 3. Authorisation

RBAC + ABAC as specified in `05-rbac-roles-and-logins.md`. Deny by default. Every endpoint declares a permission key;
CI fails on any route without one. Segregation of duties enforced (maker ≠ checker for discounts, refunds, POs,
payroll, result validation, blood issue, narcotics).

## 4. Data protection

| Control | Implementation |
|---|---|
| In transit | TLS 1.3 everywhere incl. internal service-to-service (mTLS on-prem); HSTS; no TLS < 1.2 |
| At rest | full-disk/volume encryption + Postgres TDE where available; **column encryption (`pgcrypto`, keys in KMS/Vault) for**: Aadhaar (store masked last-4 + hash only, never full number unless legally required and consented), ABHA tokens, bank accounts, biometric templates, recorded consult media keys |
| Object storage | server-side encryption, private buckets, **presigned URLs ≤ 5 min**, no public objects, virus scan on upload |
| Tenancy | RLS on every business table + application tenant guard (belt and braces); cross-tenant test in CI |
| PHI minimisation | no PHI in URLs, logs, error messages, analytics events, Sentry payloads (scrubbers configured), or AI prompts unless explicitly consented and redacted |
| Masking | patient identifiers masked by default in non-care roles; full reveal is an audited action |
| De-identification | research/export pipeline with k-anonymity ≥ 10 and date shifting (EN-036, PE-006) |
| Backups | encrypted, immutable/object-locked copies, tested restores, off-site/cross-region |
| Data residency | per-tenant configuration; on-prem tenants never egress PHI; AI endpoints region-pinned or on-prem model |

## 5. Audit & accountability (EN-024)

- Every create/update/delete of clinical, financial, inventory, HR and configuration data → `core.audit_log`
  with actor, role, IP, device, timestamp, before/after diff, reason (where required).
- **PHI reads are logged** for: opening a chart outside the care team (break-glass, reason mandatory), bulk exports,
  report downloads containing patient identifiers, MRD retrievals.
- Hash-chained rows + daily anchor digest; tamper detection job; audit is append-only (no UPDATE/DELETE grants).
- **Retention (authoritative — `07` §1.3/§5 implements this):** `core.audit_log` keeps **12 months of hot,
  monthly-partitioned rows online in Postgres**; older partitions are detached and exported to an **encrypted
  Parquet archive on S3 (SSE-KMS, object-lock/WORM), recorded in `core.archive_manifest` and queryable for the
  full statutory retention period** (≥ 3 years, longer where a state Clinical Establishments rule, an open claim
  or a court order demands it) via single-partition restore into a scratch schema or the auditor export tool.
  "Online" therefore means *retrievable within the archive SLA (≤ 4 h)*, not *resident in the hot tables*.
  **Medico-legal records are exempt from archival compaction**: rows under legal hold (MLC/TR-008, forensic,
  open insurance dispute, litigation hold, consumer-court case) stay in hot partitions indefinitely; the
  retention job checks the legal-hold flag row-by-row before detaching a partition and skips held rows.
  Security/authentication logs ≥ 1 year online (DPDP Rules); DPDP breach evidence ≥ 3 years.
- Privacy Officer dashboard: daily break-glass report, unusual access patterns, consent withdrawals, DSAR queue.

## 6. Application security (OWASP ASVS L2 target)

Input validation (Zod) on every boundary · parameterised queries only (no string SQL) · output encoding & CSP with
nonces · CSRF tokens on cookie-auth mutations · file upload allow-list + magic-byte check + AV scan + rendered in
sandboxed viewer · SSRF guard on any URL fetch · rate limits (login 5/min, OTP 5/h, API tiers) · IDOR tests in CI
(every resource fetch asserts tenant + ownership) · dependency scanning (`pnpm audit`, Renovate, Trivy) · SAST
(Semgrep) + secret scanning (gitleaks) in CI · signed container images · least-privilege DB roles (app role cannot
DDL; separate migration role; read-only analytics role) · no debug endpoints in production · security headers.

## 7. Clinical safety engineering (this is a safety-critical system)

- **Patient identification:** two identifiers on every clinical action; barcode wristband scan for medication,
  specimen, blood, imaging; mother–baby linkage; duplicate/merge governed workflow with full traceability.
- **Medication safety:** allergy and interaction hard-stops that cannot be configured away (documented anaphylaxis,
  pregnancy category X, statutory NDPS caps, missing paediatric weight, >200 % dose ceiling); high-alert drug
  double-check; look-alike/sound-alike flags; MAR 5-Rights; narcotic dual authorisation.
- **Critical results:** critical lab/radiology values raise a must-acknowledge alert with escalation, and the
  call-back is documented (who, whom, when, read-back).
- **No silent failures:** any failed write, failed interface message or failed alert delivery surfaces to a human
  queue. Never swallow an exception in a clinical path.
- **Immutability:** finalised clinical documents are versioned and signed; amendments create a new version with
  reason; nothing clinical is hard-deleted.
- **Downtime protocol:** documented paper fallback + catch-up entry with flagged back-dated timestamps.
- **Change control:** clinical logic changes (CDSS rules, order sets, dose rules) require clinical sign-off recorded
  in the rule version; releases affecting clinical modules need a documented test evidence pack (NABH will ask).
- **Regulatory boundary:** the system is a clinical *information and decision-support* system, not a diagnostic
  medical device; AI features are advisory with mandatory human confirmation (see AI-001 §0 governance).

## 8. Incident response

Severity matrix (S1 patient-safety impacting / S2 data breach / S3 major outage / S4 degraded).
On-call rota, paging via EN-037, war-room runbook, forensic preservation, **CERT-In notification within 6 hours**,
**DPDP Board notification within 72 hours** with the prescribed particulars, affected-person notification without
delay, root-cause analysis within 7 days, CAPA tracked in NC-015. Runbooks live in `infra/runbooks/`.

## 9. Compliance evidence pack (what an assessor/auditor will ask for)

RBAC matrix export · audit log samples · backup & restore drill records · DR drill (`core.dr_drills`) ·
pen-test report & closure · vulnerability scan history · consent artefacts & notice text · DPIA · breach register ·
retention & deletion job logs · training records (NC-027) · SOP versions (NC-004) · quality indicators (NC-015) ·
uptime & incident history · ABDM certification artefacts · licence register (NC-023).

## 10. Per-module security checklist (tick before "done")

- [ ] Every endpoint: permission key + tenant guard + validation + rate limit + idempotency where money/orders.
- [ ] RLS policy on every new table; cross-tenant negative test written.
- [ ] Audit events for all mutations; PHI-read logging where applicable; reason capture where required.
- [ ] No PHI in logs/metrics/traces/AI prompts; Sentry scrubbing verified.
- [ ] Consent checked where the data is shared externally (ABDM, corporate, research, AI).
- [ ] Retention/deletion behaviour defined; legal hold respected (medico-legal records never auto-deleted).
- [ ] Segregation of duties for approvals; maker-checker where money moves.
- [ ] Safety hard-stops implemented and covered by tests that assert they cannot be disabled by config.
