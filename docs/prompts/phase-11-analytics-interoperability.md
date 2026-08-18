# PHASE 11 — ANALYTICS & INTEROPERABILITY

Phases 0–10 complete: the hospital runs on the system and every module has been quietly publishing read models and
events. This phase turns that into answers the management trusts and data the rest of the health system can read.

## Read first
`CLAUDE.md`, `docs/PROGRESS.md`, then: **NC-011** (reports & analytics engine — build its schema and dataset
registry FIRST), **EN-001** (BI, KPIs, dashboards, benchmarking), **EN-019** (HL7/FHIR API layer),
**EN-011** (ABDM M2 HIP and M3 HIU), **RC-001** (claims management incl. NHCX/M4), **RC-004** (denial management),
**TR-011** (trauma registry & quality), **EN-036** (data import/migration utility — the migration side now),
**EN-026** (API gateway), plus **EN-017** (integration hub), **EN-028** (consent), **EN-016** (e-sign for signed
bundles), **EN-024** (audit), and `docs/07-performance-scalability.md` §read replicas and §materialised views,
`docs/08-integration-catalogue.md` (FHIR, ABDM, NHCX rows), `docs/13-data-migration-and-golive.md`.

Plan first; wait for "go". **Build order: NC-011 analytics schema & semantic layer → EN-001 dashboards →
report builder → scheduled & government reports → EN-019 FHIR façade → EN-011 M2 → EN-011 M3 → RC-001 NHCX (M4) →
RC-004 → TR-011 → EN-026 hardening & audit prep.** EN-036 migration work can run in parallel.

## Goal

Two people asking "what was our revenue last month?" get the same number, and can click it down to the invoice.
A dashboard that used to be a nightly spreadsheet is live and costs the transactional database nothing. And the
hospital can register as an ABDM HIP and HIU, answer a health-locker request with a valid, encrypted FHIR bundle,
and submit an insurance claim over NHCX — with certification evidence produced as a by-product.

## Deliverables

### 11.1 Analytics schema and the semantic layer (NC-011 §3.1, §3.9)
- Schema `analytics` with **conformed dimensions** — `dim_date` (with FY, quarter, week, holiday), `dim_branch`,
  `dim_department`, `dim_doctor`, `dim_payer`, `dim_service`, `dim_item`, `dim_ward_bed`, `dim_employee` — modelled
  **SCD2** where mappings change, so last year's numbers do not silently move when a doctor changes department.
- Facts fed two ways, declared per dataset: **event-projected summary tables** updated by worker consumers within
  seconds (`revenue_daily`, `opd_visits_hourly`, `bed_census_snapshot`, …) and **materialised views** refreshed on
  a stated cadence (`pg_cron` at 5 / 15 / 60 minutes or nightly). Each dataset registers its **refresh policy,
  grain, owner, permission key, PHI flags and freshness SLA** in `rpt_datasets`, and every dashboard shows
  "data as of HH:MM" from the freshness monitor.
- **The semantic layer is the point of this deliverable.** One versioned definition per metric, in code, with the
  SQL, the grain, the filters and the exclusions written down: **revenue** (billed vs collected vs accrued; gross
  vs net of discounts and refunds; whose revenue when a package spans months), **occupancy** (midnight census vs
  bed-days vs including or excluding day-care, blocked and cleaning beds), **LOS** (calendar days vs 24-hour
  blocks; how transfers, leave and same-day discharges count), plus ALOS, ARPOB, TAT, no-show rate, denial rate,
  collection efficiency and the NABH indicator set. Every report, dashboard, export and (later) AI-008 answer
  resolves metrics **only** through this layer — no ad-hoc SQL redefining a number.
- **All report queries run on a read replica** through a routing helper, with a query governor (statement timeout,
  row cap, cost estimate) so no report can hurt the transactional system.

### 11.2 Dashboards and KPI operations (EN-001 + NC-011 §3.2–3.3)
Role-resolved dashboards (MD/CEO, medical superintendent, department head, finance, nursing, quality, branch admin,
doctor), the real-time MIS tile set (OPD footfall, IP census, ER mix, revenue and collection, outstanding, OT
cases, lab tests and TAT, radiology, pharmacy sales, no-show %, average wait, pending critical alerts) refreshed
by socket push or 60-second poll, **drill-down from any tile to department → doctor/service → date → detail list
with permission-scoped PHI**, comparison chips (yesterday, same day last week, MTD, target), multi-branch roll-up
and ranking normalised per bed (EN-041), the canned report catalogue, KPI targets, alerts and anomaly detection.

### 11.3 Report builder with RLS enforcement (NC-011 §3.4)
A drag-and-drop builder over the registered datasets: fields, filters, groupings, calculated columns from the
semantic layer, sorting, formatting, charts, saved reports, sharing with role scoping, and versioning.
**Row-level security is enforced at the database session for every builder query — the builder generates SQL that
runs under the requesting user's tenant, branch and department scope, never under a service account.** A user must
not be able to construct a report that returns rows they cannot see in the source module, and a report shared to a
wider audience re-evaluates RLS per viewer rather than caching the author's result set. PHI-flagged fields require
a specific permission and log a PHI read on execution.

### 11.4 Scheduling, exports and government formats (NC-011 §3.5–3.7)
Scheduled reports (cron per report, recipients by role or address, format PDF/XLSX/CSV, delivery by email, portal
or WhatsApp link, skip-if-empty, failure alerting, and a run log), export size caps and async generation for large
extracts, embeddable charts with signed short-lived tokens, and the **government/statutory formats**: NRHM/HMIS
monthly returns, IDSP notifiable-disease reporting, birth and death reporting extracts, PC-PNDT and BMW returns,
state health-department formats, NABH indicator returns, and the trauma and cancer registry submissions — each as
a mapped, versioned format definition so a format change is configuration, not a release.

### 11.5 FHIR R4 façade and HL7 v2 breadth (EN-019)
- **FHIR R4 read path** across the resource set the spec lists (Patient, Encounter, Condition, AllergyIntolerance,
  MedicationRequest, Observation, DiagnosticReport, ServiceRequest, Procedure, Immunization, DocumentReference,
  Composition, Coverage, Claim, Organization, Practitioner, PractitionerRole, Location, Appointment, Specimen,
  ImagingStudy, Invoice/ChargeItem), search parameters, `_include`, paging and `$everything` where scoped.
- **Write path** (`fhir.write`) for the resources the spec allows, with profile validation and provenance.
- **India-first conformance: NRCeS profiles**, ABDM terminology bindings (SNOMED CT India, LOINC, ICD-10), a
  published `CapabilityStatement`, and **automated validation of every generated bundle against the profiles in
  CI** — a bundle that fails validation must fail the build, not the certification appointment.
- SMART-on-FHIR app registration and scopes, HL7 v2 inbound and outbound breadth beyond the Phase 3 lab set
  (ADT A01/A02/A03/A08, ORM, ORU, SIU, DFT), and a conformance/sandbox mode with bulk export.

### 11.6 ABDM M2 (HIP) — care contexts, consent, encrypted transfer (EN-011 §3.4–3.5, §3.7)
- **Care-context creation and linking correctness is the heart of this deliverable.** Every OPD visit, IP admission,
  diagnostic order and discharge creates a care context with a stable reference number and a human-readable
  display; HIP-initiated linking uses the V3 link-token per patient (persisted from Phase 1); manual OTP linking is
  available at the desk; discovery matches on **verified identifiers only — ABHA exact, else mobile + name + YOB
  fuzzy — and never over-discloses**; context notify fires when new health information becomes available.
  A care context that points at the wrong patient is the worst bug this phase can ship: test discovery, linking,
  re-linking, merged patients and cancelled encounters explicitly.
- Consent notification from the CM validated by signature, stored, mirrored into the EN-028 ledger, honoured for
  HI types, date ranges, care contexts and expiry, and **halted immediately on revocation including in-flight
  transfers**.
- Health-information transfer: worker builds FHIR bundles per care context and HI type (OPConsultRecord,
  PrescriptionRecord, DiagnosticReportRecord, DischargeSummaryRecord, ImmunizationRecord, WellnessRecord,
  HealthDocumentRecord), validates them, **encrypts with Fidelius (X25519 ECDH + HKDF + AES-GCM, sender public key
  and nonce in keyMaterial)**, pushes in pages to the HIU data-push URL with checksums, and notifies the gateway
  with per-care-context transfer status. Retries, DLQ and a transfer log; bundles cached and versioned, regenerated
  on amendment.

### 11.7 ABDM M3 (HIU) — fetch, decrypt, render, import (EN-011 §3.6)
Doctor-initiated consent request from the chart with purpose code, HI types, date range and expiry, requester
mapped to the HPR id; consent status tracking; per-request key pair; fetch, **decrypt, validate FHIR and store**;
an "ABDM Records" tab that renders bundles as readable cards (diagnoses, medications, reports, attachments);
selective **import into the local record with explicit provenance** ("imported from ABDM — HIP X — consent Y");
revocation, auto-expiry and a **purge job honouring `dataEraseAt`**.

### 11.8 NHCX / M4 claims and denials (RC-001 §3.5 + RC-004)
Complete the Phase 5 claim-pack assembly into full claim lifecycle: coding and completeness checks, the **claim
scrubber** with payer-specific rules, pack assembly, and channel routing (portal, email, courier, payer API,
**NHCX**). NHCX as a provider participant with keys in the vault and signed JWS/JWE payloads:
`CoverageEligibilityRequest/Response`, `Claim {use=preauthorization}` → `ClaimResponse`,
`Claim {use=claim}` with the full FHIR bundle (Patient, Coverage, Encounter, Organization with ROHINI id,
Practitioner, Condition, Procedure, Claim.item lines, DocumentReference), adjudication parsed back into claim
lines, `Communication` for queries, `PaymentNotice`/`PaymentReconciliation` for settlement, correlation ids,
**idempotent retries on the correlation id** and a DLQ operator screen. Then RC-004: reason taxonomy with payer
wording mapping, denial capture, decision and action, appeals with deadlines, root-cause analytics, and the
**preventive-rules loop that feeds denial patterns back into the scrubber and into pre-auth**.

### 11.9 Trauma registry and quality (TR-011)
Registry inclusion rules and automatic record assembly from Phase 6 data (mechanism, pre-hospital, triage, scores,
interventions with times, operations, ICU, outcome), NTDS/ICMR-NTR aligned dataset, **TQIP-style risk-adjusted
indicators**, the Cribari under/over-triage matrix, mortality and morbidity review workflow with case selection
(Ps < 0.5 survivors, Ps > 0.5 deaths), external registry export, research cohorts with a de-identification path,
and registry data governance.

### 11.10 Migration and the API gateway (EN-036 + EN-026)
EN-036 as a full migration toolkit now: source profiling, mapping configuration for non-template sources,
staging → validate → error report → commit, deterministic and fuzzy de-duplication, batch tracking and rollback,
scheduled imports/exports, data-quality scoring, and the legacy-system migration playbook from
`docs/13-data-migration-and-golive.md`. EN-026 hardened for external consumers: API registry and products, client
onboarding and credentials, the request pipeline, rate limits and quotas by tier, versioning and deprecation
policy, developer portal, and webhook subscriptions with signature verification and replay protection.

### 11.11 Certification and audit preparation
Assemble, as artefacts in the repo rather than a scramble later: the **ABDM sandbox test-run evidence** (M1–M4
scenarios executed against the NHA sandbox with request/response logs, PHI redacted), the FHIR conformance report,
the **STQC/ABDM milestone checklist** with the code or config that satisfies each item, the **CERT-In requirements**
(log retention with synchronised NTP, the 180-day log window, the 6-hour incident-reporting runbook from EN-023),
a data-flow and data-residency map, and the DPDP records of processing. Anything a certifier will ask for should be
generatable by a command.

## Constraints & watch-outs
- **One definition per metric, in one place.** If a number appears on a dashboard, in a scheduled report and in an
  export, it comes from the same semantic-layer definition. A test asserts that revenue, occupancy and LOS computed
  three ways agree for a seeded month; a changed definition bumps its version and is recorded in `docs/DECISIONS.md`.
- **Analytics never queries the OLTP primary.** Read replica plus governor, always. If a materialised view refresh
  starts hurting the primary, use `CONCURRENTLY`, partition it, or project it from events instead — do not accept
  a slower ward screen for a faster dashboard.
- **Freshness is part of correctness.** Every number carries its as-of timestamp, and a stale dataset is visibly
  stale rather than quietly wrong. Alert on refresh lag beyond the declared SLA.
- Interop is **fail-safe, not fail-open**: a failed ABDM transfer, an expired consent or an unvalidatable bundle
  results in a logged failure and an operator task, never a partial or unencrypted send. Consent state is checked
  at transfer time, not at request time.
- **No PHI in integration logs**; message logs redact by field policy, keep checksums and correlation ids, and are
  retained per policy. ABDM and NHCX keys live in the vault and are rotatable.
- The FHIR façade is a projection, not a second database: no clinical write path may bypass the owning module's
  service and its rules.
- Do not build conversational analytics here — AI-008 is Phase 12 and must consume this semantic layer, which is
  precisely why the semantic layer has to be right now.

## Exit gate
1. The metric-consistency test passes: revenue, occupancy and LOS for a seeded month agree across dashboard,
   scheduled report and export, and each metric's definition is versioned in code.
2. A management dashboard loads in < 2 s p95 against a year of seeded data, drills down to an invoice, and shows a
   correct "data as of" stamp; refresh lag beyond SLA raises an alert.
3. A user builds a report in the builder; a second user with narrower scope opens the same shared report and sees
   strictly fewer rows; an attempt to reach out-of-scope rows through a crafted filter returns nothing (RLS proven
   at SQL level).
4. A scheduled report is emailed on cron, skips when empty, retries on failure and logs its run; one government
   format (NRHM/HMIS monthly) generates and matches a hand-checked control sheet.
5. Every generated FHIR bundle validates against the NRCeS profiles in CI; an intentionally malformed bundle fails
   the build.
6. ABDM M2 in the NHA sandbox: care contexts created and linked, discovery matched without over-disclosure,
   consent received and honoured, a Fidelius-encrypted bundle transferred and acknowledged, and a revocation stops
   an in-flight transfer. Evidence logs committed.
7. ABDM M3 in the sandbox: consent requested, granted, records fetched, decrypted, rendered, selectively imported
   with provenance, and purged on `dataEraseAt`; a merged patient (Phase 1) keeps care-context linkage correct
   with no orphaned or misdirected context.
8. NHCX: eligibility check, pre-auth and a full claim submitted and adjudicated in the sandbox; a replayed
   submission is idempotent on the correlation id; a denial is captured, mapped to a reason code, appealed, and
   feeds a preventive rule into the scrubber.
9. The trauma registry assembles cases automatically, computes risk-adjusted indicators and the Cribari matrix,
    and exports the external registry format.
10. A legacy migration dry-run loads patients, visits and balances into staging, reports errors, commits, and rolls
    back cleanly; de-duplication statistics are reported.
11. The certification pack (ABDM sandbox evidence, FHIR conformance, STQC checklist, CERT-In runbook, data-flow and
    residency map) is generated by a documented command.
12. Previous gates green; `docs/PROGRESS.md` and `docs/DECISIONS.md` updated (record every metric definition
    decision and the read-replica topology).
