# PHASE 10 — ENGAGEMENT & PORTALS

Phases 0–9 complete: everything works for staff. This phase opens the system to people who are not staff —
patients, families, corporates, TPAs and referring doctors — which means it is the first phase where the internet
gets a login.

## Read first

`CLAUDE.md`, `docs/PROGRESS.md`, then: **PE-001** (patient portal), **OP-020** (patient app, PWA stage),
**PE-002** (follow-up & recall), **PE-003** (health education library), **OP-038** (patient education portal),
**PE-004** (patient community), **PE-005** (loyalty & wellness), **PE-006** (corporate client portal),
**PE-007** (referring doctor portal), **PE-008** (TPA/payer portal), **OP-036** (second opinion),
**EN-030** (feedback & survey), **NC-032/EN-014** (grievance engine — built in Phase 9, consumed here),
**EN-012** (website integration), **EN-034** (kiosk), **EN-033** (IVR & call centre), **NC-026** (CRM — extend),
**EN-016** (e-sign), plus **EN-028** (consent ledger), **EN-011** (ABHA linking & health locker),
**EN-026** (API gateway), **EN-009/EN-032/EN-037** (messaging and notifications), and
`docs/04-security-compliance.md` (all of it — DPDP Act 2023, DPDP Rules 2025, TRAI-DLT, NMC ethics) and
`docs/07-performance-scalability.md` §edge/caching.

Plan first; wait for "go". **Build order: threat model → PE-001 identity & records → PE-002 → EN-030/NC-032
surfaces → OP-020 → EN-012 → EN-034 → EN-033 → PE-006 → PE-008 → PE-007 → PE-003/OP-038 → OP-036 → PE-005 →
PE-004.**

## Goal

A patient can log in from their phone, see their reports, bills, prescriptions and appointments, book the next
visit, share records with another hospital through ABHA, tell the hospital what went wrong, and export or erase
their own data without emailing anybody — while a corporate HR manager sees utilisation without ever seeing an
employee's diagnosis, a TPA sees only its own cases, and a referring doctor sees only the patients they referred
and only what the patient consented to share.

## Deliverables

### 10.0 Threat model — do this before writing a line of portal code

**The patient portal is the most externally-attacked surface in this system.** Produce a written threat model in
`docs/adr/` covering, at minimum: credential stuffing and OTP brute force; OTP interception and SIM swap; account
takeover via password/mobile reset; **IDOR on every record, report, bill and file URL**; enumeration of UHIDs,
mobiles and appointment ids; forced browsing to another patient's PDF; abuse of the family/dependant link to reach
an adult's records; abuse of the DSAR export to exfiltrate someone else's data; session fixation and token replay;
file-upload malware; SSRF from any URL the portal fetches; scraping of doctor and slot data; payment tampering on
the pay-a-bill flow; and denial of service on OTP and booking endpoints (which costs real money in SMS).
For each: the control, the test that proves it, and the alert that fires. Portal endpoints get their own rate-limit
tier, their own WAF rules, their own audit stream and their own alert thresholds. **Every portal data access is
logged as a PHI read.**

### 10.1 Patient portal core (PE-001 + OP-020)

- **Identity**: mobile OTP and ABHA login, optional password with WebAuthn/biometric on device, account linking to
  the UHID with a verified match (never by name similarity), device sessions, and step-up verification for
  sensitive actions (record download, family link, DSAR).
- Dashboard, upcoming and past appointments with book/reschedule/cancel from the portal's own booking API,
  **health-records timeline** (visits, prescriptions, lab and radiology reports, discharge summaries, immunisation)
  with download and share, bills/estimates/receipts with online payment via EN-010, insurance and claim status,
  documents and uploads, and support/feedback entry points.
- **Sensitive-record controls**: psychiatry (OP-032), HIV/STI, genetic, MTP and MLC records follow the spec's
  restricted-visibility rules — they are excluded from the default portal view and from bulk export unless
  explicitly released, and the release itself is audited.
- OP-020 is the same product as an installable PWA with push, offline record viewing and a queue-position live view.

### 10.2 Family, minors and consent (PE-001 §3.7 + EN-028)

Family and dependant linking with a **verification step and an explicit consent artefact per relationship**;
**guardian access for minors that automatically lapses at the age of majority** (configurable), with a documented
re-consent path; caregiver delegation with scope and expiry; and revocation that takes effect immediately across
sessions, tokens and cached pages. Every grant and revocation is in the EN-028 consent ledger.

### 10.3 DPDP self-service: consent centre and DSAR (PE-001 §3.9)

A consent centre showing every purpose the patient has consented to, with granular withdraw, and **self-service
Data Subject Access Requests**: access/copy, correction, nominee designation, and erasure. Requests are ticketed,
identity-verified, tracked against the **90-day statutory SLA** with escalation at 60 and 80 days, fulfilled by an
export job that assembles the patient's data in a machine-readable form, and answered with a reasoned rejection
where retention law overrides erasure (clinical records, MLC, tax) — **the rejection reason is itself a stored,
auditable artefact**. Grievance escalation path to the Data Protection Officer is visible in the UI.

### 10.4 ABHA and health-locker sharing (PE-001 §3.8 + EN-011)

From the portal the patient can link their ABHA, see linked care contexts, and **share records to their health
locker or to another provider**, driven by consent artefacts. The wiring to the ABDM M2/M3 pipes is completed in
Phase 11 — here, build the patient-facing surface, the consent capture and the queueing so Phase 11 only connects
the transport.

### 10.5 Follow-up, recall and re-engagement (PE-002)

The follow-up rule engine (by diagnosis, procedure, drug, result, discharge, chronic cohort), recall list
generation, multi-channel cadence (WhatsApp → SMS → IVR → call) with **quiet hours and per-patient frequency
caps**, post-discharge call scripts with outcome capture, medication-adherence check-ins, chronic-care cohorts,
**no-show tracking and re-engagement** (why they did not come, an offer of the next slot, conversion measured),
and conversion analytics that attribute a booking back to the exact reminder that produced it.

### 10.6 Feedback, grievance and reputation (EN-030 + NC-032 + NC-026)

Survey builder (NPS, department-specific, post-discharge, post-report), triggering rules, capture on WhatsApp,
SMS link, kiosk, portal and IVR, and **star-threshold routing: a high score invites a public review, a low score is
routed privately into the NC-032 grievance workflow with an SLA and a service-recovery task — never to a public
channel.** Closing-the-loop tracking, department and doctor scorecards, and reputation management in NC-026 with
review aggregation. The complaint engine itself was built in Phase 9; this phase adds the patient-facing surfaces
and the routing rules.

### 10.7 Website and public surfaces (EN-012)

Embeddable **booking widget** (iframe and JS SDK) with slot search, payment link and confirmation, doctor and
department directory pages, health-package pages with payment, report download with OTP, lead forms, chatbot mount
point (AI-001 lands in Phase 12 — deterministic FAQ now), consent banner and analytics with **consent-gated
tracking**, and **SEO**: server-rendered doctor/department/package/location pages, structured data
(`Physician`, `MedicalOrganization`, `MedicalWebPage`), sitemap, canonical URLs, and Core Web Vitals budgets.
Public pages must be fast and cacheable at the edge and must never require a session.

### 10.8 Kiosk (EN-034)

Provisioning and device management by pairing code, **session and identity as the safety core** — short sessions,
automatic timeout, screen wipe on idle, no residual PHI after a session — self check-in and token, payment kiosk,
report print and download, feedback capture, and queue status. **Accessibility is a hard requirement**: wheelchair
reach, large targets and text, high contrast, audio prompts, multilingual with a language picker on the first
screen, and an operable path for a low-literacy user (icons plus speech). Offline degradation: check-in and token
issue continue from a local sequence block when the network is down.

### 10.9 IVR and call centre (EN-033)

Telephony connector and numbers, IVR flow builder with inbound self-service (appointment status, report ready,
token position, bill balance), agent console with screen-pop and click-to-call, outbound campaigns for PE-002
recalls, and **recording with consent, purpose and retention** recorded per call.

### 10.10 Corporate portal (PE-006)

Client onboarding, employee roster upload and eligibility, bulk health-check scheduling, invoices/SOA/payment, and
**aggregate wellness dashboards with k-anonymity ≥ 10 enforced in the query layer** — any cell, filter combination
or drill-down that would resolve to fewer than ten employees is suppressed, and suppression must survive
differencing attacks (two queries that differ by one employee must not reveal that employee). The corporate user
never sees an individual's diagnosis, report or prescription — only eligibility, utilisation and invoices.

### 10.11 TPA/payer portal (PE-008)

Payer onboarding and user management with **strict scoping: a payer user can only ever see cases where that payer
is the payer on the episode**, enforced by RLS and proven by test. Pre-authorisation queue, claim queue, document
exchange, query-and-response loop, bulk settlement upload, and SLA dashboards shown to both sides.

### 10.12 Referring doctor portal (PE-007) — with the structural compliance guard

Referrer onboarding with **NMC registration verification**, referral submission, status tracking, and
**consent-gated outcome summaries and report access** (the referring doctor sees the outcome only if the patient
consented to that referrer, for that episode, with an expiry).
**The NMC anti-kickback guard is structural, as in Phase 5 (NC-034): there must be no schema, no API and no screen
capable of representing a payment per referral to a registered medical practitioner.** `referrer.payouts` ships
default-OFF, is limited to the non-practitioner categories the spec allows, requires a documented legal basis, and
a test asserts that no referral row can be joined to a payout row for a practitioner. CME and engagement features
are the compliant alternative — build those well.

### 10.13 Education, second opinion, loyalty, community (PE-003/OP-038, OP-036, PE-005, PE-004)

Education library with authoring, translation workflow, approval lifecycle, **auto-share on diagnosis, discharge
and dispensing**, read receipts, and website sync. OP-036 second opinion: case bundling with the patient's
explicit consent, expert panel routing, opinion document and fee handling. PE-005 loyalty and wellness with an
earn/burn ledger, tiers, health goals and a **liability account posted to NC-009** — points are money.
PE-004 community with moderation, crisis escalation from self-harm language to a human within minutes, and
pseudonymous identity that cannot be reversed by other members.

### 10.14 E-sign (EN-016)

Aadhaar eSign and DSC integration for consents, discharge documents, claim forms and portal-signed forms, with
document stamping and public verification of a signed PDF.

## Constraints & watch-outs

- **Every portal is a separate audience with a separate identity realm and a separate permission surface.** Do not
  reuse a staff role for an external user. Patient, family member, corporate HR, TPA user and referring doctor are
  distinct principal types with their own rate limits, session lifetimes and MFA policy.
- **Test IDOR exhaustively and automatically.** A generated test must walk every external-facing GET that takes an
  id and attempt it as the wrong principal, expecting 404 (not 403 — do not confirm existence). No file, report or
  invoice is served from a guessable URL; all object storage access is via short-lived signed URLs bound to the
  requesting session.
- **No PHI in any outbound message body, ever** — messages carry a link, the link requires authentication, and the
  template registry enforces it. Respect DND, opt-out, quiet hours and DLT template approval on every channel.
- **k-anonymity and payer scoping are enforced in the data layer, not the UI.** A raw API call must not be able to
  bypass what the screen hides.
- Public pages: TTI < 2.5 s on 3G-class mobile, Lighthouse ≥ 90 including accessibility, edge-cacheable, no
  session required, no third-party script before consent.
- Portal availability is independent of the internal network: a hospital LAN outage must not take the patient
  portal down, and portal load must never be able to degrade clinical screens (separate rate-limit pools and, where
  deployed, separate ingress).
- Accessibility is not optional on patient-facing surfaces: WCAG 2.2 AA, keyboard operable, screen-reader tested,
  and localised into at least English plus two Indian languages including all patient-facing prints and IVR audio.
- Do not build the AI chatbot here. EN-012's chat mount point is deterministic FAQ plus human hand-off; AI-001 is
  Phase 12.

## Exit gate

1. The written threat model exists, each threat has a control and a test, and the automated IDOR sweep across every
   external GET passes with 404s for the wrong principal.
2. A patient logs in by OTP, sees their reports, bills and prescriptions, downloads a report, pays a bill, books a
   follow-up, and every one of those actions appears in the PHI-access audit.
3. OTP brute force, credential stuffing and booking-endpoint flooding are rate-limited, alerted, and cannot exhaust
   the SMS budget; a replayed session token is rejected.
4. A guardian sees a minor's records; on the majority birthday access lapses automatically; a revoked family link
   is effective within seconds across all active sessions.
5. A DSAR export completes within SLA with a complete, machine-readable bundle; an erasure request is partially
   refused with a stored, reasoned, auditable justification; the 90-day clock escalates when deliberately stalled.
6. A 2-star feedback goes privately into the grievance workflow with an SLA and a recovery task; a 5-star feedback
   offers a public review link; neither path can be mis-routed.
7. A no-show is detected, re-engaged through the cadence with quiet hours respected, and the resulting booking is
   attributed to the exact message.
8. The website widget books an appointment and takes payment from a third-party domain; doctor and package pages
   score ≥ 90 on Lighthouse and render correct structured data. A kiosk checks in a patient, prints a token and a
   report after OTP, leaves **no PHI on screen or in storage** after the session, and issues tokens offline.
9. A corporate dashboard suppresses every cell below 10 employees, including via differencing across two filter
   combinations, and no API call can retrieve an individual's clinical data.
10. A TPA user cannot see a single case belonging to another payer, at API level and at SQL level (RLS negative
    test, same rigour as the Phase 0 tenant-isolation test).
11. A referring doctor sees an outcome summary only for a patient who consented, with expiry honoured; a test
    proves no schema path exists that pays a registered practitioner per referral.
12. Previous gates green; `docs/PROGRESS.md` updated.
