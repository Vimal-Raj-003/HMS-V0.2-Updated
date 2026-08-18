# PHASE 8 — SPECIALTY CONSOLES

Phases 0–7 complete: a general hospital works end to end. This phase turns it into a multi-specialty hospital —
about thirty consoles, all built on one framework, each behind its own flag.

## Read first
`CLAUDE.md`, `docs/PROGRESS.md`, then **OP-025 §0 first — the Shared Specialty Console Framework, normative for
OP-025 … OP-040**. Then, per cluster: **OP-010** (procedure console), **OP-039** (OPD nursing/injection/dressing/
minor OT), **OP-011** (dietician), **NC-033** (dietary/kitchen/canteen), **OP-012** (OP dialysis),
**IP-022** (IP dialysis), **OP-013** (vaccination), **OP-014** (health check-up & corporate wellness),
**OP-015** (physiotherapy/rehab), **IP-021** (IP rehab), **TR-010** (trauma rehab pathway), **OP-016** (pain),
**OP-017** (wound care), **OP-018** (telemedicine), **OP-021** (referral management), **OP-024** (fertility/ART),
**OP-025** (ophthalmology), **OP-026** (dental), **OP-027** (dermatology), **OP-028** (ENT), **OP-029** (cardiology),
**OP-030** (pulmonology), **OP-031** (oncology day care), **IP-023** (IP chemotherapy), **OP-032** (psychiatry),
**OP-033** (paediatrics), **IP-015** (NICU/PICU), **OP-034** (geriatrics), **OP-035** (speech therapy),
**OP-037** (AYUSH), **OP-040** (obstetrics & antenatal), **IP-011** (labour room & newborn),
**IP-019** (transplant), **IP-020** (clinical pathways), plus **EN-039** (dynamic forms), **OP-022** (device/report
console), **EN-042** (device gateway adapters), **EN-006** (service points), **RC-003/OP-005/IP-005** (charge
intents), **PE-002** (recalls), **EN-016** (e-sign), and `docs/04-security-compliance.md` §1 (PC-PNDT, MHCA, ART
Act, NDPS, telemedicine) and §7.
**Owned elsewhere:** OP-036 (second opinion) and OP-038 (patient education) are Phase 10 — build only the hooks
each console needs.

Plan first; wait for "go". **Build order: OP-025 §0 framework → OP-025 (proves the framework) → OP-010/OP-039 →
the device-heavy consoles (OP-029, OP-030, OP-028, OP-026, OP-027) → the therapy consoles (OP-015/IP-021/TR-010,
OP-016, OP-017, OP-035, OP-037, OP-011/NC-033) → the programme consoles (OP-013, OP-014, OP-012/IP-022) →
the regulated consoles (OP-040/IP-011, OP-031/IP-023, OP-032, OP-033/IP-015, OP-034, OP-024) →
OP-018 → OP-021 → IP-020 → IP-019.**

## Goal

An ophthalmologist, a dentist, a chemotherapy nurse and an antenatal counsellor each open the same patient chart
and see a workspace that looks like it was built for their specialty — the right tabs, the right worklist, their
devices' results already attached — while underneath it is one framework, one encounter, one billing path and one
audit trail. Adding the thirty-first specialty should be configuration and a form, not a new application.

## Deliverables

### 8.1 The shared framework (OP-025 §0) — build this first, alone, and prove it
- `mdm.specialty_consoles` registry: code, name, module key, department mapping, ordered tabs (component or EN-039
  form template key, roles), worklist config, billing links, active flag. A console is a **tab overlay on the
  OP-002 consultation workspace**, never a separate encounter type; the generic tabs (history, Rx, orders, timeline,
  notes) stay reachable at all times.
- Storage rule, stated once and enforced in review: **anything that appears in a WHERE clause, a report or an alert
  is a typed column** in schema `specialty`; narrative and hospital-configurable extras go into EN-039
  `clinical.form_responses` JSON with expression indexes only where measured.
- Reusable **laterality pattern** `sided<T>` (OD/OS/OU, R/L ear or nostril, limb side, dental quadrant) shared as a
  Zod type and a DB convention.
- `SpecialtyWorklist` component reading OP-001 visits and the EN-006 queue, with sub-queues modelled as EN-006
  **service points** (refraction room, dilation, imaging, counselling) and `clinical.encounter_stages` giving
  per-stage TAT. Keyboard: arrows to select, Enter to open, `Ctrl+Shift+D` to complete, `/` to filter.
- **Device result pipeline**: `mdm.device_result_types` (e.g. `OCT_MACULA`, `ECG_12L`, `SPIRO`, `AUDIO_PTA`, `OPG`,
  `NST`) each mapped to an OP-022 template, DICOM-to-Orthanc or file-to-S3 handling, an optional EN-042 structured
  parser filling typed columns, and a billing service code. Lifecycle ordered → performed → attached/parsed →
  reviewed. Manual capture (tablet camera, scanned paper) is always available.
- **Charge intents** from console actions honouring OP-023 packages, RC-003 payer tariffs and RC-002 pre-auth;
  zero-priced documentation services still create a line for MIS; cancelling an action before billing voids the
  intent.
- Recall/follow-up rules into PE-002, referral into OP-021, education attachment points for OP-038/PE-003.
- Specialty **visit summary print template** per console plus the console's own prints, all with letterhead,
  e-sign (EN-016), portal QR and an ABDM FHIR bundle export shape.
- Permission key pattern `<console>.<resource>.<action>`, RBAC sub-role templates (optometrist, audiologist,
  dental assistant, chemo nurse, ANC counsellor, embryologist…), and ABAC visibility hooks for sensitive consoles.
- **Framework acceptance F1–F5 from OP-025 §0.9 are tested once, here, and never re-tested per console.**

### 8.2 Procedure and OPD nursing spine (OP-010, OP-039)
OP-010: procedure catalogue, scheduling, consent, pre-procedure checks, execution documentation with time-outs,
consumables and implant capture, post-procedure instructions and billing. OP-039: injection and dressing room
worklists driven from orders, OPD medication administration with the rights check, suture removal, plaster room
(with OP-009/TR-005), minor OT via OP-010, and the room sub-store and set management.
Most other consoles call OP-010 for their procedures — build it before them.

### 8.3 Device-heavy consoles (OP-029, OP-030, OP-028, OP-026, OP-027, OP-025)
Cardiology (ECG/Echo/TMT/Holter with structured reports, cath-lab scheduling), pulmonology (PFT/spirometry with
parsed XML, sleep study, bronchoscopy), ENT (audiometry with audiogram rendering, endoscopy, vertigo battery),
dental (odontogram charting, treatment plan and estimate, OPG/RVG imaging, lab work tracking), dermatology
(lesion mapping with serial photo comparison, biopsy, phototherapy), ophthalmology (visual acuity, refraction,
IOP, slit lamp, fundus, OCT, spectacle prescription, optical-shop link). Each declares its device result types and
reuses the framework's parser/attachment path — **no console gets its own upload code**.

### 8.4 Therapy, rehabilitation and nutrition (OP-015, IP-021, TR-010, OP-016, OP-017, OP-035, OP-037, OP-011, NC-033)
Physiotherapy and rehabilitation with assessment scales, goal setting, session scheduling and attendance, and
progress scoring; IP-021 the inpatient variant with MDT conferences; TR-010 the trauma pathway with FIM/Barthel,
cross-discipline scheduling, return-to-work/sport and the amputee/prosthetics track. Pain clinic (scores, blocks
via OP-010, opioid stewardship with NDPS controls). Wound care (measurement, photo series, TIME assessment,
dressing plan, healing-rate trend). Speech therapy. AYUSH with its own prescription vocabulary and therapy
scheduling. Dietician (assessment, diet orders, therapeutic diet plans) feeding **NC-033** kitchen production,
tray-line and dispatch, canteen POS with staff subsidy, kitchen inventory and costing, HACCP records and waste
tracking.

### 8.5 Programme consoles (OP-013, OP-014, OP-012, IP-022)
Vaccination: schedules (national and IAP), due/overdue recall, **cold-chain checks before administration**, lot and
VVM capture, certificates, AEFI reporting, U-WIN/CoWIN hooks. Health check-up and corporate wellness: package
definition, appointment orchestration across stations, station board, consolidated report generation and delivery,
corporate batches. Dialysis (OP-012 outpatient, IP-022 inpatient): station and shift scheduling, prescription,
session flowsheet, dialyser reuse register, water quality and machine hygiene, CRRT/SLED at the ICU bedside, and
vascular-access surveillance.

### 8.6 Regulated consoles — where the law is the design (OP-040, IP-011, OP-031, IP-023, OP-032, OP-033, IP-015, OP-034, OP-024)
- **OP-040 obstetrics/ANC**: EDD and gestational-age engine, trimester visit schedules, USG schedule, risk
  stratification and high-risk clinic, delivery planning hand-over to IP-011, postnatal and family planning, gynae.
  **PC-PNDT: Form F capture is mandatory for every obstetric ultrasound, the register is generated as a by-product,
  and no field, free-text box, template or report anywhere in the product may capture or convey foetal sex.**
  MTP workflow with its own restricted visibility and statutory register.
- **IP-011 labour room and newborn**: digital partograph (WHO LCG) with alert and action lines and automatic
  deviation alerts, delivery documentation, **newborn identity — mother and baby banded together at birth with a
  paired barcode, and every subsequent newborn action verified against the pair**, newborn examination and
  screening, birth reporting and certificate (CRS integration).
- **OP-031 / IP-023 chemotherapy**: regimen library with versioned protocols, BSA and carboplatin AUC dosing,
  **dose bands — a prescribed dose outside the protocol band is a hard stop requiring a named consultant override
  with reason, and cumulative lifetime dose limits (e.g. anthracycline) are enforced**, cycle-day fitness check
  (counts, renal/hepatic function, performance status), pharmacist verification, hazardous compounding with chain
  of custody and spill procedure, administration with infusion tracking, toxicity grading (CTCAE) and dose
  modification, tumour board and registry.
- **OP-032 psychiatry**: PHQ-9/GAD-7 and other instruments, risk assessment and safety planning with crisis
  escalation, **session notes stored under restricted visibility (ABAC) so they do not appear in the general
  timeline, portal, or any export without an explicit, audited unlock**, prescribing and monitoring, counselling
  and de-addiction, ECT/rTMS, and **MHCA 2017 compliance** — advance directives, nominated representative,
  admission categories and review-board timelines.
- **OP-033 paediatrics / IP-015 NICU-PICU**: WHO/IAP growth charts and percentiles, developmental surveillance,
  **weight-based dosing where a missing or stale weight blocks the prescription and a mg/kg overdose is a hard
  stop**, immunisation panel via OP-013, newborn and high-risk follow-up, feeding and nutrition; NICU/PICU
  flowsheets, incubator and respiratory support logs, TPN and feeding charts, jaundice/phototherapy,
  sepsis and HIE scoring, screening, KMC and family communication.
- **OP-034 geriatrics**: fall risk, cognitive screen, frailty, and a **polypharmacy/Beers review** that surfaces
  in the prescribing loop.
- **OP-024 fertility/ART**: couple registration and **ART Act 2021 eligibility and consent gates**, cycle tracking,
  IUI and IVF/ICSI protocols, embryology lab with witness steps, cryopreservation inventory with storage-consent
  expiry, donor and bank management with anonymity rules, outcome tracking and **National ART Registry reporting**.

### 8.7 Telemedicine (OP-018)
Booking and payment, waiting room, WebRTC consultation with fallback to audio and to phone, identity verification
of both parties, prescription and orders from the call, and **compliance with the Telemedicine Practice Guidelines
2020**: explicit patient consent recorded, practitioner registration displayed, the medicine-list restrictions
(List O/A/B and the prohibited list) enforced in the tele-prescription path, and recording only with consent and a
stated retention period.

### 8.8 Care coordination (OP-021, IP-020, IP-019)
OP-021 referral management (internal and external, TAT, outcome feedback loop) — the same engine PE-007 uses in
Phase 10. IP-020 clinical pathways: template authoring and governance, auto-enrolment, daily execution and phase
transitions, variance capture, outcome metrics. IP-019 transplant: recipient listing and waitlist, living-donor
pathway with authorisation committee records, deceased-donor certification and consent, matching, retrieval and
transplant episode, post-transplant follow-up, and **NOTTO/state registry reporting**.

## Constraints & watch-outs
- **Framework first, consoles second.** If a console needs something the framework does not have, extend the
  framework and re-run F1–F5 — never fork it. A console that ships its own worklist, its own upload path or its own
  print pipeline is a defect, not a feature.
- **Every console is behind its own flag** (`module.<console>.enabled`) and its own licence entitlement, ships with
  seed masters, and is invisible — including in nav, search and the command palette — when off.
- **Regulatory blocks are structural, not configurable.** No sex-determination field can exist for PC-PNDT; MHCA
  restricted notes cannot leak into a generic export; a chemotherapy dose outside band cannot be signed by a
  non-consultant; a paediatric prescription without a current weight cannot be written; ART consents cannot be
  back-dated. Write a test per rule that fails if someone adds a bypass.
- Do not re-implement clinical safety: allergy, interaction and dose checking stay in EN-029; consoles add
  specialty rule packs to it (BSA dosing, cumulative dose, teratogenicity in ANC, MAOI interactions in psychiatry).
- Performance: console tab first render < 1 s with cached forms, save p95 < 300 ms, worklist load < 500 ms,
  device attachment uploads resumable up to 500 MB, offline caching of forms and worklists with server-wins on
  signed documents and client-wins on drafts.
- **Do not let thirty consoles become thirty migrations of chaos.** One schema (`specialty`), one naming pattern,
  one document-versioning path, one charge-intent path, reviewed as a whole before the first console after OP-025.
- Patient-facing prints and instructions are localised; growth charts, partographs and audiograms must print
  correctly to scale on A4.

## Exit gate
1. Register a new console purely as data (tabs referencing existing components and EN-039 templates) and it appears
   for the mapped department **with no code deploy** — OP-025 §0.9 F1 passes.
2. A device result (spirometry XML and an OCT DICOM) attaches, parses into typed columns, appears in the console
   tab and on the timeline within 2 seconds, and stays "unreviewed" until the doctor marks it — F2 passes.
3. A console action creates a bill line honouring package and payer tariff; cancelling before billing voids the
   intent — F3 passes. Signed specialty documents are immutable and amend to version 2 with reason — F4 passes.
   Worklist stage moves update EN-006 boards live and stage TATs report — F5 passes.
4. An obstetric ultrasound cannot be saved without Form F; a full-text search across the entire codebase and
   database schema for any sex-determination field returns nothing; the PC-PNDT register generates itself.
5. A partograph crossing the action line raises an alert; a newborn is banded to its mother and a mismatched
   scan on a newborn medication is refused.
6. A chemotherapy order 30 % above the protocol band is hard-stopped; a consultant override is recorded with
   reason; the cumulative anthracycline limit blocks a further cycle.
7. A psychiatry session note is invisible to a general physician, to the patient portal and to a data export until
   an audited unlock; the MHCA nominated-representative and review timelines are tracked.
8. A paediatric prescription without a weight recorded today is blocked; a 10× mg/kg error is hard-stopped;
   growth percentiles plot correctly against WHO and IAP references.
9. A teleconsultation completes with consent recorded, a prohibited-list drug is refused in the tele-Rx, and the
   consultation, prescription and bill land in the same encounter as an in-person visit would.
10. Diet order → kitchen production → tray dispatch → ward acknowledgement completes for one ward's lunch service,
    and canteen POS with staff subsidy reconciles.
11. Every console is toggled off: no nav item, no route, no search result, no seeded master is reachable, and the
    rest of the system is unaffected. Toggle one back on and it works without a restart.
12. Previous gates green; `docs/PROGRESS.md` updated with the console-by-console status matrix and every open
    question from each spec §16.
