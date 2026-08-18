# EN-035 — RIS (Radiology Information System) — Integration Contract Map

> **This is deliberately a thin specification.** Vim's HMS does **not** build a separate Radiology Information System. Every classical RIS responsibility is delivered by modules that already exist: **OP-008** (radiology ordering, scheduling, technologist workflow, structured reporting, critical findings, dose), **EN-008** (PACS, DICOM store/retrieve, MWL/MPPS, viewer, teleradiology, archive), **EN-019** (HL7 v2 / FHIR message semantics) and **EN-017** (transport, retries, DLQ). EN-035 exists as the **contract map**: it states which system owns which RIS function, defines the message contracts between them, and gives the migration path when a third-party RIS is already installed. Build nothing under `EN-035`; build to this map.

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-035 |
| Phase | 3 |
| Priority | P0 (as an architectural contract; **zero net-new application code**) |
| Complexity | Low (documentation & conformance), High if a third-party RIS must be integrated or replaced |
| Depends on | OP-008 (Radiology & Imaging — the functional owner), EN-008 (PACS Integration & DICOM Viewer), EN-019 (HL7 v2 / FHIR API Layer), EN-017 (Integration Hub — transport), EN-027 (radiology procedure master, modality, body part, laterality, contrast), EN-005 (label/report printing), EN-013 (accession barcodes), EN-029 (imaging appropriateness & critical-finding alerting), EN-036 (historical RIS data migration), EN-011 (ABDM linking of imaging documents), EN-002/RC-003 (billing of imaging services) |
| Consumed by | Anyone asking "where is the RIS?" — this file is the answer. Also used by integration partners and assessors needing a single view of imaging data flow. |
| Feature flag | none of its own; behaviour is governed by `module.radiology.enabled` (OP-008) and `module.pacs.enabled` (EN-008) |
| Primary roles | Radiologist (12), Radiology Technician (36), Radiology Manager, IT Admin / Integration Engineer (56) |
| Secondary roles | Ordering clinicians (6/7/8/9), MRD (43), Billing (27), Biomedical/AERB officer (48), Auditor (58) |
| Regulatory | **AERB** (radiation safety, equipment registration/e-LORA, dose records, QA — records live in NC-020/OP-008), **PC-PNDT Act** for obstetric ultrasound (Form F, machine-and-operator registration, no sex determination — enforced in OP-008), DICOM PS3 conformance (EN-008), HL7 v2.x ORM/ORU/ADT & FHIR `ImagingStudy`/`DiagnosticReport`/`ServiceRequest` (EN-019), NABH diagnostic-services chapter, ABDM (imaging report as an FHIR document, EN-011), DPDP (imaging is health data; teleradiology is a cross-boundary disclosure) |

## 1. Purpose
The VIMS master sheet lists "RIS (Radiology Info System) — Worklist, Modality Integration, Report Dictation, DICOM" as a module. Building it as a separate module would duplicate OP-008 and EN-008 and create two competing sources of truth for the imaging order and the report. EN-035 therefore records the **decision** (RIS = OP-008 + EN-008 + EN-019), the **ownership matrix**, the **integration contracts** (which message, which direction, which identifiers), and the **migration notes** for hospitals that already own a third-party RIS. It is the file an architect or an external vendor reads to know exactly where to plug in.

## 2. Ownership Matrix — who owns which RIS function

| Classic RIS function | Owned by | Notes / where the data lives |
|---|---|---|
| Order entry (CPOE), clinical indication, priority (stat/urgent/routine), pregnancy & contrast screening | **OP-002 → OP-008** | `rad_orders`; safety checks fire in EN-029 (repeat-CT, pregnancy + ionising radiation, eGFR/metformin + contrast) |
| Order approval / protocolling by radiologist | **OP-008** | protocol assignment, contrast decision, sequence selection |
| Patient scheduling & modality slot booking | **OP-008** | `rad_appointments`; resource calendar per modality/room; prep instructions to the patient (EN-009) |
| **Accession number** generation | **OP-008** (via EN-007 numbering series `RAD_ACC`) | the single join key across HMS, MWL and PACS |
| **Modality Worklist (MWL)** publication | **EN-008** (sourced from OP-008) | DICOM C-FIND MWL SCP served by Orthanc/dcm4che; OP-008 pushes/exposes the scheduled procedure step |
| MPPS (Modality Performed Procedure Step) in-progress/completed | **EN-008** → status back to OP-008 | drives "exam started/completed" without manual technologist entry |
| Technologist workflow: patient arrival, ID verification, exam start/complete, repeats/rejects, exposure parameters, contrast administered, adverse reaction | **OP-008** | `rad_exams`, `rad_repeat_reject_log`, `rad_contrast_events` |
| Image acquisition, storage, compression, archive, prior fetch, CD/USB burn, share links | **EN-008** | DICOM C-STORE/C-MOVE/WADO-RS, S3/on-prem archive, lifecycle |
| Image viewing (diagnostic & clinical), hanging protocols, measurements, key images | **EN-008** (OHIF/vendor viewer) | non-diagnostic clinical viewer embedded in OP-002/IP-003 |
| **Reading worklist** (unread, by modality/priority/subspecialty, assigned/unassigned) | **OP-008** | driven by exam status from EN-008 MPPS + order data |
| **Report dictation** (voice recorder, speech-to-text, templates, macros, structured reporting) | **OP-008** | `rad_reports` versions; template engine from EN-039; STT vendor is an EN-017 connector; AI-004 later |
| Report verification, sign, amend, addendum, co-sign for residents | **OP-008** + **EN-016** (digital signature) | append-only versions, hash chain per CLAUDE.md |
| **Critical / significant finding** communication with acknowledgement & call-back | **EN-029** (alert & escalation) + **OP-008** (finding capture) | mirrors the lab critical-value contract |
| Report distribution: portal, WhatsApp/SMS link, email, print, referring-doctor portal | **PE-001**, **EN-009**, **EN-032**, **EN-005**, **PE-007** | delivery evidence attached to the report |
| Radiation **dose recording** (DLP/CTDIvol/DAP), dose registry, AERB reporting | **OP-008** (from DICOM RDSR via EN-008) | `rad_dose_records`; equipment/AERB licences in NC-020 |
| Equipment QA, calibration, AERB licence, service history | **NC-020** (+ EN-031 pattern for QC records) | not a RIS function in this architecture |
| **Billing** of imaging services, package/tariff, TPA | **OP-005 / IP-005 / RC-003 / EN-002** | charge posted on exam completion or on order, per branch policy |
| Film/consumable inventory, contrast stock | **NC-006** | |
| **Teleradiology** outsourcing, external radiologist worklist, turnaround SLA | **EN-008** (image sharing) + **OP-008** (report ingest, attribution) | outsourced reads come back as ORU/FHIR and are attributed to the external radiologist |
| **TAT measurement** (order→schedule→exam→report→sign→delivery) | **OP-008** (metrics) + **EN-001** (BI) | NABH indicator |
| Interfacing (HL7/FHIR/DICOM semantics) | **EN-019** (semantics) + **EN-017** (transport) | see §3 |
| Terminology: procedure master, modality, body part, laterality, LOINC/RadLex | **EN-027** | |
| Consent (contrast, invasive procedures), PC-PNDT Form F | **EN-028** + **OP-008** | Form F register is an OP-008 statutory register |

**Rule of thumb for builders:** if it touches an *order, a schedule, a worklist, a report or a dose*, it belongs to **OP-008**. If it touches *pixels, DICOM objects, archives or viewers*, it belongs to **EN-008**. If it touches *message format*, it belongs to **EN-019**; *message delivery* belongs to **EN-017**.

## 3. Integration Contracts (the actual wiring)

### 3.1 Identifiers (must be consistent everywhere)
| Identifier | Source | Used in |
|---|---|---|
| `UHID` (patient id) | OP-001 numbering series | HL7 PID-3, DICOM `PatientID` (0010,0020) |
| `accession_number` | OP-008 series `RAD_ACC` | HL7 OBR-18/ORC-2/OBR-3, DICOM `AccessionNumber` (0008,0050), MWL query key |
| `study_instance_uid` | generated by OP-008 at scheduling (preferred) or by the modality | DICOM (0020,000D), FHIR `ImagingStudy.identifier` |
| `scheduled_procedure_step_id` | OP-008 | DICOM MWL (0040,0009) |
| `order_id` / `placer_order_number` | OP-008 | HL7 ORC-2, FHIR `ServiceRequest.id` |
| `filler_order_number` | OP-008 (self-filled) or third-party RIS | HL7 ORC-3 |

Generating `study_instance_uid` at scheduling time is the recommended posture: it makes reconciliation deterministic when a modality mis-types a patient name.

### 3.2 Message flows
| # | Flow | Direction | Format | Owner | Notes |
|---|---|---|---|---|---|
| 1 | Patient demographics & encounter | HMS → PACS/modality | HL7 ADT A04/A08/A28/A31 (or FHIR `Patient`) | EN-019 semantics, EN-017 transport | keeps PACS patient records in step; A40 merge propagates patient merges |
| 2 | Imaging order placed | OP-008 → EN-008 (MWL) | internal event `rad.order.scheduled` → MWL entry; HL7 ORM^O01 / OMI^O23 if an external RIS/PACS requires it | OP-008 | order status `scheduled` is the trigger |
| 3 | Modality Worklist query | Modality → EN-008 | DICOM C-FIND (MWL) | EN-008 | filtered by modality AE title, date, station |
| 4 | Exam started / completed | Modality → EN-008 → OP-008 | DICOM MPPS N-CREATE/N-SET | EN-008 | auto-updates `rad_exams.status`; no manual technologist click needed |
| 5 | Images stored | Modality → EN-008 | DICOM C-STORE / STOW-RS | EN-008 | duplicate/UID collision handling in EN-008 |
| 6 | Study available for reading | EN-008 → OP-008 | internal event `pacs.study.received` | EN-008 | populates the reading worklist |
| 7 | Report finalised & signed | OP-008 → downstream | internal event `rad.report.finalised`; HL7 **ORU^R01** to external subscribers; FHIR `DiagnosticReport` + `ImagingStudy` for ABDM/EN-019 | OP-008 | PDF rendered by EN-039, signed by EN-016 |
| 8 | Report available in viewer/portal | OP-008 → EN-008/PE-001 | DICOM SR or encapsulated PDF push to PACS (optional), portal link | both | keeps the report next to the images for external viewers |
| 9 | Critical finding | OP-008 → EN-029 → EN-037 | internal events | EN-029 | must-acknowledge + call-back record |
| 10 | Dose record | Modality → EN-008 → OP-008 | DICOM **RDSR** (X-Ray Radiation Dose SR), or MPPS dose fields, or OCR of dose screens as a last resort | OP-008 | feeds the dose registry and AERB reporting |
| 11 | Order cancelled / changed | OP-008 → EN-008 | ORC-1 = CA/XO, MWL entry withdrawn | OP-008 | a cancelled order must disappear from the modality worklist within 60 s |
| 12 | Billing charge | OP-008 → OP-005/IP-005 | internal event `rad.exam.completed` (or `rad.order.placed`, per policy) | OP-008 | avoids double-charging on repeats |
| 13 | Teleradiology dispatch & return | EN-008 (share) → external; external → OP-008 (report) | DICOM share/link out; ORU^R01 or FHIR `DiagnosticReport` in | EN-008 / OP-008 | external radiologist identity and licence recorded on the report |

### 3.3 Conformance obligations
- **EN-008** must publish a DICOM Conformance Statement (SOP classes supported: MWL SCP, MPPS SCP, Storage SCP, Query/Retrieve SCU/SCP, Storage Commitment, WADO-RS/QIDO-RS/STOW-RS) — every modality vendor will ask for it.
- **EN-019** must publish HL7 v2 message profiles (ADT, ORM/OMI, ORU, ACK) with segment/field tables and Z-segment definitions, plus FHIR R4 capability statements for `ServiceRequest`, `ImagingStudy`, `DiagnosticReport`, `Media`, `Endpoint`.
- **EN-017** owns MLLP framing, retries, DLQ, ordering (ADT before ORM for the same patient), circuit breaking and replay — no module implements its own socket handling.

## 4. Data Model
**EN-035 owns no tables.** For reference, the imaging data lives in:
- `rad_orders`, `rad_appointments`, `rad_exams`, `rad_reports` (+ versions), `rad_dose_records`, `rad_repeat_reject_log`, `rad_contrast_events`, `rad_critical_findings`, `rad_form_f` (PC-PNDT) — **OP-008** (schema `rad`).
- `pacs_studies`, `pacs_series`, `pacs_instances`, `pacs_mwl_entries`, `pacs_mpps`, `pacs_shares`, `pacs_archive_policies` — **EN-008**.
- `hl7_messages`, `fhir_resources` — **EN-019**; `ihub_messages` — **EN-017**.
- `mdm_rad_procedures` (modality, body part, laterality, contrast, dose reference, LOINC/RadLex) — **EN-027**.

If a future ADR reverses this decision and a standalone RIS is built, it must first migrate these tables — that is the cost the decision avoids.

## 5. Business Rules (architectural, binding on OP-008/EN-008)
- **One source of truth per fact.** The order and the report belong to OP-008; the pixels and the study metadata belong to EN-008. Neither writes the other's tables; they exchange domain events.
- **Accession number is generated by the HMS**, never by the modality or the PACS, and is present on every MWL entry, every DICOM object and every report.
- **No order → no worklist entry.** A modality may not acquire against an ad-hoc patient except in a declared emergency ("trauma unknown" workflow), which creates a placeholder order that **must** be reconciled to a real patient within 24 hours; unreconciled studies are listed daily.
- **MPPS drives status**; manual status changes are the exception and are audited with a reason.
- A report may not be finalised for a study whose images are not in the archive (except for outside-study reads, which are explicitly flagged).
- **Dose must be captured** for every ionising exam where the modality supports RDSR; a modality without RDSR requires a documented manual-entry procedure (AERB expectation).
- **Cancelled or rescheduled orders must be withdrawn from MWL within 60 seconds** so a patient is never scanned against a cancelled order.
- Patient merges (OP-001) must propagate to PACS via ADT A40; the merge is not complete until PACS acknowledges.
- Teleradiology reads leave the hospital's boundary: the external provider is a DPDP processor with a DPA, the share is time-boxed and audited, and the reporting radiologist's identity and registration number appear on the signed report.
- **No parallel RIS.** If a third-party RIS remains in production (see §9), exactly one system is the *master of the order* and the other is a subscriber; the master is declared per-tenant in configuration and cannot be ambiguous.

## 6. API Surface
EN-035 exposes **no endpoints of its own**. The relevant surfaces are:
- `/api/v1/radiology/*` — orders, scheduling, worklist, exams, reports, dose (OP-008).
- `/api/v1/pacs/*` — studies, MWL, viewer tokens, shares, archive (EN-008).
- `/api/v1/hl7/*`, `/api/v1/fhir/*` — message and resource endpoints (EN-019).
- `/api/v1/integration/*` — connector health, message log, replay for imaging interfaces (EN-017).

For partners integrating "with the RIS", the published contract is: **HL7 v2 ORM/ORU + DICOM MWL/MPPS/Storage**, or **FHIR `ServiceRequest`/`ImagingStudy`/`DiagnosticReport`** — both served by EN-019/EN-008.

## 7. Domain Events (outbox)
EN-035 publishes none of its own. The imaging event vocabulary (owned by OP-008/EN-008) is listed here so integrators and new engineers use the right names and subscribe to the right module:
`rad.order.placed` · `rad.order.protocolled` · `rad.order.scheduled` · `rad.order.cancelled` · `rad.exam.started` · `rad.exam.completed` · `rad.exam.repeated` · `pacs.study.received` · `pacs.study.reconciled` · `rad.report.drafted` · `rad.report.finalised` · `rad.report.amended` · `rad.critical_finding.raised` · `rad.dose.recorded` · `rad.study.shared_external`.
Consumers to be aware of: EN-029 (critical findings, imaging appropriateness), EN-037 (notification/escalation), OP-005/IP-005 (charge posting on `rad.exam.completed`), EN-011 (ABDM document linking on `rad.report.finalised`), EN-001 (TAT and utilisation analytics), NC-020 (dose/equipment usage).

## 8. Screens (UI)
EN-035 contributes **no screens**. The screens a user would call "the RIS" are:
- **Radiology Worklist / Reading Worklist** (desktop, radiologist) — OP-008.
- **Technologist Modality Console** (desktop/tablet in the scan room) — OP-008.
- **Scheduling Board** (desktop) — OP-008.
- **DICOM Viewer** (desktop, dual-monitor diagnostic) — EN-008.
- **Report Editor with dictation** (desktop) — OP-008 + EN-039 templates.
- **Imaging Interface Health** (desktop, IT) — EN-017 connector dashboard filtered to modality connectors.
One documentation screen is worth building: an **Imaging Data-Flow Map** page in the admin console rendering §2 and §3.2 as a live diagram with per-link health from EN-017 — so an assessor or a new engineer can see the whole imaging chain on one screen. It reads from EN-017's data-flow register and adds no new storage.

## 9. Integrations & Migration Notes (when a third-party RIS already exists)
**Integrations** are exactly those in §3.2 — DICOM (MWL/MPPS/Storage/Q-R) via EN-008/Orthanc, HL7 v2 (ADT/ORM/OMI/ORU over MLLP) and FHIR R4 via EN-019, all transported by EN-017. No additional external system is owned here.

**Migration.** Many hospitals arrive with an installed RIS (vendor-supplied with the CT/MRI, or a standalone product). Three supported postures:

**A. Replace (target state).** OP-008 + EN-008 take over completely.
1. **Inventory**: modalities (make, model, AE title, DICOM conformance, MWL support, RDSR support), the RIS database (schema, volumes, years), report formats, dictation system, and every downstream consumer of its ORU feed.
2. **Migrate** (EN-036): patients & identifiers, historical orders and accessions, historical reports (as PDFs plus structured text where available), dose records, and — with EN-008 — the DICOM archive (bulk C-MOVE/STOW or storage-level copy with UID preservation). Reports migrate as **read-only historical documents**, never as editable versions.
3. **Reconcile**: accession-number collisions between the legacy series and the new `RAD_ACC` series are resolved by prefixing legacy accessions (e.g. `L-`), never by renumbering studies already in PACS.
4. **Parallel run**: 2–4 weeks with orders placed in both systems for one modality, comparing worklist, MPPS, report delivery and billing; a daily reconciliation report lists mismatches.
5. **Cutover** by modality (start with X-ray/ultrasound, finish with CT/MRI), each with a rollback plan (re-point the modality's MWL AE back to the legacy RIS).
6. **Decommission**: legacy RIS to read-only, then archive per the retention policy; the decommission checklist (EN-036) records who verified each data class.

**B. Coexist (RIS master, HMS subscriber).** The legacy RIS stays master of imaging orders (common where it is bundled with a modality contract).
- HMS sends ADT + order requests; the RIS returns filler order numbers and ORU reports; HMS displays reports and bills from them.
- **Constraints to make explicit to the hospital**: no CPOE-level safety checking (EN-029) on imaging orders placed in the RIS, duplicated patient masters, and TAT metrics limited to what the ORU feed carries. This posture is a temporary state, not a design goal.

**C. Coexist (HMS master, RIS as a reporting workstation).** HMS owns orders and worklist; the third-party product is used only for dictation/reporting and returns ORU. This is the cheapest interim posture and is usually preferred over B.

For every posture, record in the tenant's ADR: who is master, which identifiers are authoritative, what the reconciliation job checks, and the target date to reach posture A.

## 10. Reports & Analytics
Owned by OP-008/EN-001. The RIS-equivalent metrics an administrator expects, and where they come from:
- **TAT by segment** (order→schedule, schedule→exam, exam→report draft, draft→sign, sign→delivery) by modality and priority — OP-008 events.
- **Modality utilisation** (slots offered vs used, exams/hour, idle windows, after-hours usage) — OP-008 scheduling.
- **Repeat/reject rate** by modality, technologist and reason — an AERB/NABH quality indicator, OP-008.
- **Unreported study ageing** and unreconciled "unknown patient" studies — OP-008 + EN-008.
- **Dose metrics** (mean DLP/CTDIvol per protocol vs national DRLs) — OP-008 dose registry.
- **Interface health** (MWL query failures, MPPS gaps, storage failures, ORU delivery failures) — EN-017.
- **Teleradiology**: outsourced volume, external TAT, cost per read — OP-008/EN-008.

## 11. Notifications
None owned here. Imaging notifications are: critical finding (EN-029 → EN-037), report ready (EN-009/EN-032/PE-001), modality interface down (EN-017 → EN-037), unreported study SLA breach (OP-008 → EN-037), unreconciled study daily digest (EN-008), dose above alert level (OP-008 → radiation safety officer).

## 12. Permissions (RBAC keys)
No new keys. Relevant keys live in their owning modules: `rad.order.create`, `rad.exam.perform`, `rad.report.draft`, `rad.report.sign`, `rad.report.amend`, `rad.dose.read` (OP-008); `pacs.study.view`, `pacs.study.share`, `pacs.mwl.manage`, `pacs.archive.manage` (EN-008); `ihub.connector.manage`, `ihub.message.read` (EN-017); `fhir.imagingstudy.read` (EN-019).

## 13. Non-functional (targets these modules must meet for imaging)
- **Volumes (2000-bed enterprise)**: ~600–900 imaging exams/day (X-ray 55 %, USG 20 %, CT 15 %, MRI 7 %, others 3 %); ~250 GB/day of DICOM at typical CT/MRI mixes; 10–20 modalities and 6–10 reading workstations.
- **MWL query response < 1 s** at the modality (a slow worklist is the single most common cause of technologists abandoning MWL and typing patient details by hand — which breaks reconciliation).
- MWL entry available **within 30 s** of scheduling; cancellation withdrawn **within 60 s**.
- MPPS status reflected in the HMS worklist within 5 s; `pacs.study.received` to reading-worklist appearance < 10 s.
- Report finalisation to portal/WhatsApp delivery < 2 min; ORU delivery to subscribers p95 < 30 s.
- Prior-study retrieval for comparison: on-line archive < 5 s, nearline < 60 s (EN-008 tiering).
- Interfaces must survive a modality being offline for a shift: MWL is pull-based (no loss), MPPS/storage gaps are reconciled by a nightly job comparing scheduled exams to received studies.

## 14. Acceptance Criteria (conformance tests for the RIS contract)
1. **Given** an imaging order is scheduled in OP-008, **when** a modality issues a DICOM C-FIND MWL query within 30 seconds, **then** the entry appears with the correct patient name, UHID, accession number, scheduled procedure step and study instance UID.
2. **Given** a scheduled order is cancelled, **when** the modality queries MWL 60 seconds later, **then** the entry is absent.
3. **Given** a technologist starts an exam, **when** the modality sends MPPS N-CREATE, **then** the exam status in OP-008 becomes `in_progress` without any manual entry, and N-SET `COMPLETED` moves it to `completed`.
4. **Given** images are stored to PACS, **when** `pacs.study.received` fires, **then** the study appears on the radiologist's reading worklist within 10 seconds, joined to the order by accession number.
5. **Given** a report is finalised and signed, **when** the ORU^R01 is dispatched, **then** subscribers receive it within 30 seconds, the FHIR `DiagnosticReport` is available, and the PDF is signed via EN-016 and delivered to the patient channel configured.
6. **Given** a study arrives with a patient name typed at the modality that does not match any order, **when** reconciliation runs, **then** the study is quarantined as unreconciled, appears on the daily list, and cannot be reported until it is linked to an order.
7. **Given** a CT exam with RDSR support, **when** the study completes, **then** CTDIvol and DLP are recorded against the exam and appear in the dose registry.
8. **Given** a patient merge in OP-001, **when** ADT A40 is sent, **then** PACS acknowledges and the merged patient's priors are retrievable under the surviving UHID.
9. **Given** a third-party RIS is master (posture B), **when** an order is created there, **then** the HMS receives it, does not create a duplicate order, and clearly labels the order's source system in the UI.
10. **Given** the migration from a legacy RIS, **when** historical reports are imported, **then** they are read-only, carry their original accession prefixed to avoid collision, and are searchable alongside new reports.
11. **Given** an integration engineer opens the Imaging Data-Flow Map, **when** a modality's MWL connector is failing, **then** that link renders red with the last error from EN-017 and a click leads to the connector detail.
12. **Given** any auditor asks "where is the RIS?", **when** they open this document, **then** the ownership matrix (§2) answers for every classical RIS function without ambiguity.

## 15. Enhancements / Later phases
- **AI-004 radiology assist** (triage of critical findings, auto-measurement, prior comparison) plugging into the OP-008 reading worklist as a *suggestion* layer.
- **Speech-to-text dictation** with radiology-tuned vocabulary and voice macros (OP-008 + an EN-017 STT connector), then automatic structured-report population.
- **Structured reporting** to RSNA templates / DICOM SR with codified findings enabling searchable, comparable reports and registry contribution.
- **Dose registry benchmarking** against national DRLs with automatic protocol-optimisation suggestions.
- **Zero-footprint enterprise viewer** and cross-branch prior fetching for group hospitals (EN-041).
- **XDS-I / IHE profile conformance** (SWF, PIR, RAD-TF) if the hospital joins a regional health information exchange.
- If a hospital genuinely requires a standalone RIS product (e.g. to sell to imaging-only centres), the ADR path is to package OP-008 + EN-008 as a deployable subset — not to write a new RIS.

## 16. Open Questions for the Hospital
1. Is there an **existing RIS** today? Vendor, version, database, how many years of orders and reports, and is it bundled with a modality purchase contract (which may constrain replacement)?
2. Which posture is intended at go-live — **replace (A), RIS-master coexist (B), or HMS-master with RIS as a reporting workstation (C)** — and by what date should posture A be reached?
3. Full **modality inventory**: make, model, AE title, IP, DICOM conformance statement, MWL support (yes/no), MPPS support, RDSR support, and whether any modality requires HL7 rather than DICOM MWL.
4. Who currently generates the **accession number**, and can it be moved to the HMS numbering series without breaking existing workflows or the PACS archive?
5. Is **dictation** required at go-live (which vendor, foot pedal, microphone), or is typed/templated reporting acceptable initially?
6. Is **teleradiology** in use — which provider, what SLA, and what is the data-sharing agreement (DPDP processor terms)?
7. What is the **prior-study retention and archive tiering** requirement (on-line/nearline/off-line years), and where is the archive physically located?
8. How are **dose records** captured today for modalities without RDSR, and what does the AERB submission currently require?
9. For obstetric ultrasound, how is **PC-PNDT Form F** maintained today, and which register/format must be reproduced exactly?
10. Which downstream systems currently consume the RIS **ORU feed** (EMR, portal, referring-doctor system, billing) and must continue to receive it during and after migration?
11. What is the **historical DICOM volume** to migrate (TB, study count), and is a storage-level copy possible or must it be a DICOM-level transfer?
12. Which modality should be the **pilot for cutover**, and who signs off the parallel-run reconciliation report?
