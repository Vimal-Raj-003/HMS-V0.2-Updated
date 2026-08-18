# EN-019 — HL7 / FHIR API Layer (FHIR R4 Façade, NRCeS India Profiles, SMART-on-FHIR, HL7 v2 ADT/ORM/ORU/DFT/SIU over MLLP Inbound & Outbound, Message Mapping, Conformance Statement, Developer Sandbox)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-019 |
| Phase | 3/11 |
| Priority | P1 |
| Complexity | Very High |
| Depends on | EN-017 (Integration Hub — transport adapters, MLLP listener, retries, DLQ, message log), EN-026 (API Gateway — keys, scopes, rate limits, developer portal), EN-025 (SSO/OIDC for SMART-on-FHIR authorisation), EN-027 (MDM — terminology: ICD-10/11, SNOMED CT India, LOINC, drug codes, value sets, concept maps), EN-028 (consent gating of data release), EN-024 (audit of every resource read/write), EN-016 (signed documents/bundles), EN-011 (ABDM HIP/HIU reuses these FHIR profiles), EN-004 (analyzer HL7/ASTM — device-level), EN-008 (DICOM/PACS — imaging references), OP-001 (Patient/Encounter), OP-002 (Condition/Procedure/MedicationRequest), OP-004 (Observation/DiagnosticReport/Specimen), OP-008 (ImagingStudy/DiagnosticReport), OP-005/RC-001 (Account/Charge/Claim for DFT), IP-001 (ADT source of truth), NC-003 (MRD documents) |
| Feature flag | `module.fhir.enabled` (sub: `fhir.write`, `fhir.subscriptions`, `fhir.bulk_export`, `hl7v2.inbound`, `hl7v2.outbound`, `fhir.smart_apps`, `fhir.sandbox`) |
| Primary roles | IT Admin / Integration Engineer (56), Super Admin (SaaS — profile packs), external partner developer (via EN-026 developer portal) |
| Secondary roles | MRD Officer (43 — document exchange), Lab/Radiology Managers (order/result interfaces), Privacy Officer (57 — consent gating & access reports), Hospital Admin (approve external access), Auditor (58) |
| Regulatory | HL7 FHIR R4 (4.0.1) + FHIR RESTful API & search specification; **NRCeS (National Resource Centre for EHR Standards) India FHIR Implementation Guide** and ABDM/NDHM profiles (`Patient`, `Practitioner`, `Organization`, `Encounter`, `DiagnosticReportRecord`, `OPConsultRecord`, `DischargeSummaryRecord`, `PrescriptionRecord`, `WellnessRecord`, `ImmunizationRecord`, `HealthDocumentRecord`); **EHR Standards for India 2016** (SNOMED CT as the reference clinical terminology, LOINC for lab, ICD-10 for morbidity coding, ICD-11 adoption path); HL7 v2.5.1/2.6 (ADT, ORM/OMG, ORU, DFT, SIU, MDM, ACK) and IHE profiles (PIX/PDQ, XDS-lite concepts); SMART App Launch 2.0 + OAuth 2.0 + OIDC; DPDP Act 2023 & Rules 2025 (consent, purpose limitation, DSAR export); ABDM Health Data Management Policy; NABH MOM (record exchange integrity); ISO 27001 / IT Act §43A |

## 1. Purpose
EN-019 is the standards façade of Vim's HMS: a **FHIR R4 server** exposing the hospital's clinical and administrative data as conformant resources (with India/NRCeS profiles), a **SMART-on-FHIR** authorisation layer so third-party clinical apps can launch in context, and a **HL7 v2 engine** that speaks ADT/ORM/ORU/DFT/SIU/MDM over MLLP in both directions with configurable message mapping. It is the single place where internal domain models are translated to and from interoperability standards, so ABDM (EN-011), external EMRs, national registries, lab/radiology partners and research/analytics consumers all reuse one mapping layer rather than inventing their own.

## 2. Users & Jobs-to-be-done
- **Integration Engineer** (desktop): configure an HL7 v2 interface with a partner (which segments, which triggers, which mapping, ACK mode), test with sample messages, watch the message log and fix mapping errors.
- **Partner developer** (developer portal, EN-026): read the capability statement, register an app, obtain SMART scopes, test in the sandbox against synthetic patients, go live.
- **ABDM/HIE flows** (EN-011): request a FHIR bundle for a linked care context — EN-019 assembles and signs it.
- **Lab/Radiology partner**: send ORU^R01 results into the HMS, or receive ORM^O01 orders for outsourced tests.
- **MRD Officer**: export a patient's record as a FHIR Document Bundle (DSAR, referral, insurance).
- **Privacy Officer**: verify that every external read passed a consent check and appears in the PHI access report.
- **Analytics/research team**: run a FHIR Bulk Data ($export) for a de-identified cohort.

## 3. Core Workflows

### 3.1 FHIR R4 façade — read path
1. Client calls `GET /fhir/R4/Patient?identifier=...&_count=50` with a bearer token (SMART/OAuth2 via EN-025/EN-026) → gateway validates token, scopes and tenant → EN-019 resolves the requested **profile pack** (base R4 or NRCeS-IN) for the tenant.
2. **Authorisation chain**: scope check (`patient/Observation.rs`, `user/Encounter.r`, `system/Patient.r`) → RBAC/ABAC (EN-007) → **consent gate** (EN-028: is there a valid data-sharing consent covering this requester, purpose, data category and time window?) → break-glass path requires a reason and raises a `READ_PHI` audit with alert.
3. **Mapping**: internal tables → FHIR resource via a versioned resource map (`fhir_resource_maps`), with terminology translation through EN-027 (local codes → SNOMED CT/LOINC/ICD), reference resolution (`Patient/{id}`, `Encounter/{id}`), and profile-specific must-support elements populated.
4. **Search**: supported parameters per resource (`_id, _lastUpdated, identifier, patient, subject, encounter, date, category, code, status, performer, _include, _revinclude, _sort, _count, _summary, _elements`), implemented as indexed SQL over the source tables plus a `fhir_search_index` materialisation for token/reference/date parameters; cursor-based paging using FHIR `Bundle.link[next]` with an opaque cursor.
5. Response `Bundle` (searchset) with `total` (accurate up to a cap, then `estimated`), ETag/`_lastUpdated` for caching, `OperationOutcome` for warnings.
6. Every access writes `fhir_access_log` + EN-024 audit (`READ_PHI` class) with requester app, scope, patient, resource ids returned (counted, not enumerated for large sets), consent id and purpose.

### 3.2 FHIR write path (`fhir.write`)
1. `POST/PUT /fhir/R4/<Type>` with `If-Match` for updates → **validate** against the base R4 StructureDefinition **and** the tenant's profile (`$validate` runs the same engine) → reject with a precise `OperationOutcome` (severity, expression path, code) on failure.
2. Map to internal commands (never direct table writes): e.g. `ServiceRequest` → `order.create` service call, `Observation` → `vitals.record` / `lab.result.file`, `MedicationRequest` → `rx.create` (subject to CDSS EN-029 checks), `Appointment` → OP-001 booking. Business rules, permissions and audit of the internal service always apply — the FHIR layer never bypasses them.
3. Idempotency via `Idempotency-Key` or a conditional create (`If-None-Exist`), returning 200 with the existing resource when matched.
4. `Bundle` type `transaction`/`batch` supported with all-or-nothing semantics for `transaction`.
5. Provenance: every externally-written resource stores `Provenance` (who/which app/when/why) and is flagged `source=external` in the internal record so clinicians can see data origin.

### 3.3 Supported resources (Phase 3 core → Phase 11 breadth)
| Resource | Direction | Source module | Notes / India profile |
|---|---|---|---|
| `Patient` | R/W | OP-001 | NRCeS Patient; identifiers: UHID (local), ABHA number & address, MRN, Aadhaar **never** as an identifier value |
| `Practitioner`, `PractitionerRole` | R | EN-007/NC-010 | HPR id (ABDM), NMC registration |
| `Organization`, `Location`, `HealthcareService` | R | EN-027/EN-041 | HFR id, department/ward/bed |
| `Encounter` | R/W | OP-001/IP-001 | class OP/IP/ER/day-care; hospitalization (admit/discharge disposition) |
| `Condition` | R/W | OP-002 | ICD-10/ICD-11 + SNOMED CT; clinicalStatus/verificationStatus |
| `Procedure` | R/W | IP-006/OP-010 | SNOMED CT procedure, performed period, body site (ortho laterality TR-002) |
| `Observation` | R/W | OP-007/OP-004/IP-003 | vitals (LOINC), lab results with reference ranges & interpretation, NEWS2 score as a panel |
| `DiagnosticReport` | R/W | OP-004/OP-008 | lab & radiology, `presentedForm` (PDF), `result` links, `media` for images |
| `Specimen` | R/W | OP-004 | accession identifier, collection time, container |
| `ServiceRequest` | R/W | OP-002/OP-004/OP-008 | lab/imaging/procedure orders, priority, reason, requester |
| `MedicationRequest`, `MedicationStatement`, `MedicationDispense`, `Medication` | R/W | OP-002/OP-003 | India drug codes → SNOMED/ATC mapping via EN-027 |
| `AllergyIntolerance` | R/W | OP-002 | SNOMED substance, criticality, reaction |
| `Immunization` | R/W | OP-013 | NRCeS ImmunizationRecord, U-WIN alignment |
| `Composition` + `Bundle` (document) | R/W | NC-003/IP-002/OP-002 | OPConsultRecord, DischargeSummaryRecord, PrescriptionRecord, DiagnosticReportRecord — signed (EN-016) |
| `DocumentReference` | R/W | NC-003 | scanned/uploaded documents, `content.attachment.url` presigned |
| `ImagingStudy` | R | EN-008 | study/series/instance UIDs, WADO-RS endpoint |
| `Appointment`, `Schedule`, `Slot` | R/W | OP-001 | booking APIs for partners/website |
| `Coverage`, `Claim`, `ClaimResponse`, `Account`, `ChargeItem`, `Invoice` | R | EN-002/OP-005/RC-001 | payer exchange, NHCX alignment |
| `Consent` | R/W | EN-028 | ABDM consent artefact mapping, DPDP processing consent |
| `CarePlan`, `Goal`, `RiskAssessment`, `QuestionnaireResponse`, `Flag` | R | IP-020/EN-039 | later phases |
| `Subscription` | — | EN-019 | topic-based notifications to partners (`fhir.subscriptions`) |

### 3.4 SMART-on-FHIR & app registration (`fhir.smart_apps`)
1. `/fhir/R4/.well-known/smart-configuration` publishes authorization/token endpoints, supported scopes, grant types, PKCE requirement, capabilities (`launch-ehr`, `launch-standalone`, `context-ehr-patient`, `permission-v2`).
2. **EHR launch**: a clinician opens a registered app from the patient chart → HMS issues a `launch` token carrying patient/encounter/user context → app redeems it at the authorisation endpoint (OAuth2 authorization-code + PKCE) → receives an access token with `patient` context and granted scopes.
3. **Standalone patient launch**: patient logs in via PE-001/ABHA → consents to the app's scope request on a clear consent screen (what data, what purpose, for how long) → token issued; consent recorded in EN-028.
4. **Backend services** (`system/` scopes): JWT client-credentials with an asymmetric key registered per app (RFC 7523) for server-to-server flows (analytics, registries).
5. App registry: name, publisher, redirect URIs, launch type, requested scopes, JWKS URL, status (sandbox/pending/approved/suspended), data-flow record (EN-017 DPDP register), per-app rate limits (EN-026). Approval by Hospital Admin for any app touching PHI.
6. Token lifetimes: access 15 min, refresh (with `offline_access`) rotating and revocable per app; patient can revoke an app's access at any time from the portal (immediate token revocation).

### 3.5 HL7 v2 inbound (`hl7v2.inbound`)
1. **MLLP listener** (EN-017 adapter) per interface: host/port, TLS optional, sending/receiving facility & application, character set, HL7 version, ACK mode (original/enhanced, AA/AE/AR), max message size, allow-list of sender IPs.
2. Parse → structural validation against the message profile → **map** segments to canonical objects using `hl7_message_maps` (MSH/EVN/PID/PV1/PV2/OBR/OBX/ORC/RXE/FT1/AIS/NTE/ZXX custom Z-segments) with per-field transforms (date formats, coded values via EN-027, name components, address, IDs with assigning authority) → dispatch to internal services.
3. Supported inbound triggers: **ADT** `A01` admit, `A02` transfer, `A03` discharge, `A04` register OP, `A05` pre-admit, `A06/A07` change class, `A08` update patient info, `A11/A12/A13` cancel admit/transfer/discharge, `A28/A31/A40` person add/update/merge; **ORM^O01 / OMG^O19** orders; **ORU^R01** results (lab/rad/device); **DFT^P03** charges; **SIU^S12-S26** scheduling; **MDM^T02** documents; **VXU^V04** immunisations (later).
4. **ACK** returned synchronously (AA on success, AE on application error with the error segment, AR on reject) within the configured timeout; asynchronous processing failures are queued to the DLQ **and** reported to the partner if enhanced ACK is configured.
5. Patient matching on inbound: identifier (assigning authority + id) first, then demographic matching rules (EN-027 golden-record/MPI); ambiguous matches go to a human **reconciliation queue** rather than auto-creating duplicates; `A40` merge triggers the MPI merge workflow.

### 3.6 HL7 v2 outbound (`hl7v2.outbound`)
1. Domain events → outbound triggers: `patient.registered` → ADT^A04, `ip.admission.completed` → A01, `ip.patient.transferred` → A02, `ip.discharge.completed` → A03, `patient.updated` → A08, `patient.merged` → A40, `order.created` → ORM^O01/OMG^O19, `lab.result.final` → ORU^R01, `bill.charge.posted` → DFT^P03, `appointment.booked|rescheduled|cancelled` → SIU^S12/S14/S15, `document.signed` → MDM^T02.
2. Per-interface subscription filters (which events, which departments, which order types), field mapping, segment inclusion list, MSH control id generation, sequence numbering, batch (BHS/BTS) or single-message mode.
3. Delivery via MLLP with ACK correlation; NACK/timeout → retry policy (EN-017) → DLQ; queued messages survive partner downtime and drain in order.
4. Message replay from the log after a partner outage, with duplicate suppression using MSH-10 control ids.

### 3.7 Conformance, sandbox & bulk export
- `GET /fhir/R4/metadata` returns the **CapabilityStatement** generated from the actual enabled resources, interactions, search parameters, profiles and security (SMART) declarations — never hand-maintained.
- `$validate`, `$everything` (Patient/Encounter compartment), `$document` (assemble a Composition bundle), `$export` (Bulk Data Access, NDJSON to object storage with a status endpoint) for `fhir.bulk_export`.
- **Sandbox** (`fhir.sandbox`): a separate tenant seeded with synthetic patients (never real PHI), auto-reset nightly, with the same profiles and capability statement; developer portal (EN-026) links to it. Sandbox tokens can never reach production data (separate issuer + audience).
- Terminology: `ValueSet/$expand` and `ConceptMap/$translate` proxy EN-027 so partners can resolve codes.

### 3.8 Exceptions
- Unknown/unsupported resource or interaction → `501 not-supported` with an `OperationOutcome` pointing to the capability statement.
- Profile validation failure on write → `422` with element-level issues; the partial resource is never persisted.
- Terminology gap (local code without a standard mapping) → resource still returned with the local code in `coding[0]` and a `data-absent-reason` extension; the gap is logged for EN-027 mapping backlog.
- Consent absent/expired for an external read → `403` with `OperationOutcome` code `forbidden` and a non-revealing message; the attempt is audited.
- MLLP framing errors / oversized messages → NACK with a clear error and the raw frame preserved for vendor escalation.

## 4. Data Model (schema `integration`, prefix `fhir_` / `hl7_`)
- `fhir_profile_packs` — id, hospital_id?, key (`base-r4`, `nrces-in`, `abdm-v3`, custom), version, structure_definitions jsonb/file_refs, value_sets, search_params, active_from, status.
- `fhir_resource_maps` — id, hospital_id?, resource_type, profile_pack_id, version, direction (read/write/both), spec jsonb (element ↔ source table/column/expression, terminology bindings, must-support list), status (draft/active/retired), activated_by/at; `fhir_map_samples` (map_id, sample internal payload, expected FHIR JSON, last_run_status).
- `fhir_search_index` — hospital_id, resource_type, resource_id, param_name, param_type enum(token/reference/date/string/quantity/number/uri), value_token, value_system, value_ref, value_date tstzrange, value_string (trigram), last_updated; partitioned by resource_type; indexes per param type — the workhorse for FHIR search performance.
- `fhir_resource_versions` — hospital_id, resource_type, resource_id, version_id int, last_updated, source enum(internal/external), provenance jsonb, deleted bool; supports `_history` and ETags.
- `fhir_apps` — id, hospital_id, name, publisher, contact, client_id, client_type enum(public/confidential/backend), redirect_uris text[], jwks_url, launch_types text[], requested_scopes text[], approved_scopes text[], status enum(sandbox/pending/approved/suspended/revoked), rate_limit_ref (EN-026), dpdp jsonb (purpose, categories, retention, cross_border), approved_by, approved_at.
- `fhir_app_authorizations` — id, app_id, subject_type (patient/user/system), subject_id, scopes text[], consent_id (EN-028), granted_at, expires_at, revoked_at, refresh_family_id.
- `fhir_access_log` — id, hospital_id, app_id?, user_id?, patient_id?, method, resource_type, resource_id?, search_params_redacted jsonb, result_count, status_code, consent_id?, purpose, break_glass bool, ip, latency_ms, at; partitioned monthly; mirrors into EN-024 as `READ_PHI`.
- `fhir_subscriptions` — id, hospital_id, app_id, topic (`patient-admit`, `lab-result-final`…), criteria, channel (rest-hook/websocket), endpoint, header_secret_ref, status, error_count, last_notified_at.
- `fhir_bulk_exports` — id, hospital_id, requested_by, scope (system/group/patient), types text[], since, status, output jsonb (ndjson file refs), error, requested_at, completed_at, expires_at.
- `hl7_interfaces` — id, hospital_id, branch_id?, name, partner (vendor/system), direction, transport (mllp/file/http), host, port, tls jsonb, hl7_version, sending_app/facility, receiving_app/facility, ack_mode, encoding_chars, charset, triggers text[], filters jsonb, batch_mode, sequence_no, status, connector_id (EN-017), health jsonb.
- `hl7_message_maps` — id, interface_id, message_type, trigger_event, direction, version, spec jsonb (segment/field/component ↔ canonical path, transforms, code translations, z-segments), sample_messages jsonb, status.
- `hl7_messages` — id, hospital_id, interface_id, direction, message_type, trigger_event, control_id (MSH-10), correlation_id, patient_ref?, encounter_ref?, raw_ref (encrypted object key), parsed_redacted jsonb, status enum(received/parsed/mapped/processed/ack_sent/nack/failed/dlq/replayed), ack_code, error_class, error_text, attempts, received_at, processed_at, latency_ms; **partitioned monthly**; indexes (hospital_id, interface_id, received_at desc), (control_id), (patient_ref).
- `hl7_reconciliation_queue` — id, hospital_id, message_id, reason enum(ambiguous_patient_match/unknown_order/unknown_test_code/duplicate), candidates jsonb, status, resolved_by, resolution, at.
- `fhir_terminology_gaps` — hospital_id, source_system, source_code, target_system, first_seen, occurrences, status (open/mapped/wontfix) → feeds EN-027 backlog.
- Retention: `hl7_messages` metadata 180 days online + 2 years archive (raw payloads 30 days encrypted); `fhir_access_log` per EN-024 (min 3 years for PHI access, CERT-In 180 days minimum for all logs).

## 5. Business Rules & Validations
- The FHIR layer is a **façade, not a store**: writes always execute the same internal service commands (validation, CDSS, permissions, audit) as the UI; there is no path that inserts clinical data unvalidated.
- Every external read is gated by three checks in order — token scope, RBAC/ABAC, and EN-028 consent — and is logged as a PHI access. No consent, no data (except statutory/legally-mandated flows explicitly configured, e.g. notifiable disease reporting).
- Aadhaar number is never exposed as a FHIR identifier; ABHA number/address are exposed only when the patient has an active ABDM linkage and consent.
- Profiles are versioned per tenant; changing a profile pack requires re-running mapping samples and produces a new CapabilityStatement version with a deprecation notice window (≥ 90 days) for partners.
- Search must be indexed: any search parameter without a backing index in `fhir_search_index` is either rejected (`not-supported`) or served by an explicitly allowed slow path with a lower rate limit — never an unbounded table scan.
- `_count` max 200 (default 50); `$everything` capped and paginated; bulk export runs on a read replica and is rate-limited to N concurrent jobs per tenant.
- HL7 v2 inbound patient creation is allowed only for interfaces explicitly flagged `may_create_patient`; otherwise unmatched patients go to reconciliation.
- MSH-10 control ids must be unique per interface per 30 days; duplicates are treated as retransmissions and acknowledged without reprocessing (idempotency).
- Outbound ADT ordering per patient is guaranteed (FIFO partition by patient) so an A08 cannot overtake an A01.
- Results (`ORU`/`Observation`) marked *final* are immutable; corrections arrive as `corrected` results creating a new version with `status=corrected` and never overwrite history (mirrors OP-004 rules).
- Every externally sourced resource carries `Provenance` and is visually flagged as external in the clinical UI; external data never silently merges into the hospital's authored record.
- Sandbox and production are hard-separated by issuer, audience and database; a production token presented to the sandbox (or vice versa) is rejected.
- Deprecation policy: an API version is supported for ≥ 12 months after its successor is released; partners are notified through EN-026 at 90/30/7 days.

## 6. API Surface
**FHIR base:** `/fhir/R4` (tenant-resolved by subdomain or `X-Hospital-Id` for system clients)
| Method | Path | Purpose | Permission / scope | Notes |
|---|---|---|---|---|
| GET | /fhir/R4/metadata ; /.well-known/smart-configuration | conformance | public | generated |
| GET | /fhir/R4/:type/:id ; /:type/:id/_history/:vid | read/vread | `user/:type.r`, `patient/:type.r` | ETag, consent-gated |
| GET | /fhir/R4/:type?params | search | as above | indexed params only, cursor paging |
| POST/PUT/PATCH/DELETE | /fhir/R4/:type[/:id] | create/update/patch/delete | `*.c/.u/.d` + `fhir.write` | profile-validated, maps to internal commands |
| POST | /fhir/R4 (transaction/batch Bundle) | bundle | scoped | transaction = atomic |
| POST | /fhir/R4/:type/$validate | validation | `fhir.validate` | no persistence |
| GET | /fhir/R4/Patient/:id/$everything ; /Encounter/:id/$everything | compartment export | `patient/*.r` + consent | paginated |
| POST | /fhir/R4/Composition/$document ; /DocumentReference/$generate | document bundle | `fhir.document` | signed via EN-016 |
| GET | /fhir/R4/$export ; /Group/:id/$export ; /Patient/$export ; GET /fhir/R4/$export-status/:id | bulk data | `system/*.r` + `fhir.bulk_export` | NDJSON, async |
| GET/POST | /fhir/R4/ValueSet/$expand ; /ConceptMap/$translate | terminology | `fhir.terminology.read` | proxies EN-027 |
| GET/POST/DELETE | /fhir/R4/Subscription | topic subscriptions | `fhir.subscription.manage` | rest-hook with HMAC |
**Admin:** `/api/v1/interop`
| Method | Path | Purpose | Permission |
|---|---|---|---|
| GET/POST/PATCH | /profile-packs ; /resource-maps ; POST /resource-maps/:id/test\|activate | FHIR mapping config | `interop.map.manage` |
| GET/POST/PATCH | /apps ; POST /apps/:id/approve\|suspend\|revoke ; GET /apps/:id/authorizations | SMART app registry | `interop.app.manage` (Admin approval for PHI) |
| GET/POST/PATCH | /hl7/interfaces ; POST /interfaces/:id/start\|stop\|test | HL7 v2 interfaces | `interop.hl7.manage` |
| GET/POST/PATCH | /hl7/message-maps ; POST /message-maps/:id/test | segment mapping | `interop.map.manage` |
| GET | /hl7/messages?interface&type&status&from&to&q ; GET /hl7/messages/:id ; GET /:id/raw | message log | `interop.message.read` / `interop.payload.read` (audited) |
| POST | /hl7/messages/:id/reprocess ; POST /hl7/replay {interface, from, to} | replay | `interop.message.replay` |
| GET/POST | /hl7/reconciliation ; POST /reconciliation/:id/resolve | ambiguous match queue | `interop.reconcile` (MRD, IT) |
| GET | /fhir/access-log?patient&app&from&to | external access report | `interop.access.read` (DPO, Auditor) |
| GET | /terminology-gaps | unmapped codes | `interop.map.manage` |
| GET | /sandbox/reset ; GET /sandbox/patients | developer sandbox | `interop.sandbox.manage` |
| GET | /reports/conformance ; /reports/usage ; /reports/errors | reports | `interop.report.read` |

## 7. Domain Events (outbox)
- `interop.fhir.resource_read` (aggregated, for access analytics), `interop.fhir.resource_written` → source module reconciliation, EN-024.
- `interop.app.registered|approved|suspended|revoked`, `interop.app.authorization_granted|revoked` → EN-028 consent ledger, EN-026 gateway keys.
- `interop.hl7.message_received|processed|nacked|dlq` → EN-017 DLQ triage, EN-037 alerts.
- `interop.hl7.interface_up|down` → IT alert, EN-018 IT board.
- `interop.patient.match_ambiguous` → MRD reconciliation queue (EN-027 MPI).
- `interop.terminology.gap_detected` → EN-027 mapping backlog.
- `interop.bulk_export.completed|failed` → requester notification.
- Consumes: all clinical/administrative domain events for outbound HL7 v2 and FHIR Subscriptions.

## 8. Screens (UI)
- **Interoperability Console** (desktop): tabs — FHIR (profile packs, resource maps, capability preview, search-param coverage matrix), HL7 v2 (interfaces with live up/down chips, throughput, ACK rate), Apps (SMART registry), Message Log, Reconciliation, Terminology Gaps.
- **HL7 Interface Detail** (desktop): connection settings, trigger subscription matrix (event × message type checkboxes), segment mapping editor with a **sample-message pane** (paste a real HL7 message → see parsed segments on the left, mapped canonical object on the right, errors inline), ACK simulator, start/stop, live tail of messages. Shortcuts: `Ctrl+Enter` run sample, `/` search segment.
- **FHIR Resource Map Editor** (desktop): element tree of the target profile (must-support elements flagged) ↔ source expression editor with autocomplete over internal fields, terminology binding picker (EN-027 value sets), sample round-trip test (internal → FHIR → validate).
- **Message Log** (desktop): virtualised table (time, interface, type, trigger, patient ref, status, ACK, latency), filters, correlation trace across EN-017, drawer with redacted parsed view and a "show raw HL7" toggle (step-up auth, audited), reprocess/replay actions.
- **SMART App Registry** (desktop): app cards with status, scopes requested vs approved, publisher, DPDP fields, JWKS health, per-app usage graph, approve/suspend with reason; patient-facing "connected apps" list is surfaced in PE-001 where patients can revoke.
- **Developer Sandbox Portal** (external, via EN-026): capability statement viewer, resource explorer with try-it console, synthetic patient list, token generator, sample HL7 messages to download, changelog and deprecation notices.
- **External Access Report** (DPO desktop): who (app/user) read what patient data, when, under which consent, with export.
- Empty/error states: "No HL7 interfaces configured", "Interface down since 09:14 — 42 messages queued", "Search parameter `body-site` is not supported — see capability statement".

## 9. Integrations
- **EN-017** provides MLLP/TCP listeners, file drops, retries, DLQ and the message log substrate; EN-019 owns the HL7/FHIR semantics on top.
- **EN-026** fronts the FHIR endpoints for keys/quotas/versioning; **EN-025** provides the OIDC authorisation server for SMART.
- **EN-011 (ABDM)** consumes EN-019's NRCeS-profiled bundles for HIP data push and HIU fetch; ABDM consent artefacts map to `Consent`.
- **EN-004** (analyzer ASTM/HL7 at device level) hands normalised results to EN-019 for onward ORU distribution; **EN-008** supplies `ImagingStudy`/WADO endpoints.
- External partners: referral hospitals' EMRs, outsourced lab partners (send-outs), government registries (notifiable diseases, cancer registry, NTDB-style trauma registry TR-011), insurance/NHCX (RC-001), research platforms (de-identified bulk export), national programmes (U-WIN/CoWIN via EN-017).
- Tooling: HAPI-compatible validator/StructureDefinitions, `@medplum/core` TypeScript types, IHE PIX/PDQ-style identity queries mapped onto FHIR `Patient/$match` (later).

## 10. Reports & Analytics
- API usage by app/endpoint/resource (calls, p95 latency, error rate, data volume), top search parameters, unsupported-parameter attempts, consent denials, break-glass reads via FHIR, HL7 interface uptime & ACK success rate, message volumes by type/trigger, mapping error taxonomy, reconciliation queue ageing, terminology gap counts by system, bulk export history, deprecation adoption (how many partners still call the old version). MV `analytics.mv_interop_daily`.
- Conformance report: which resources/interactions/search params are implemented vs the NRCeS IG requirement list — used as ABDM/NABH evidence.

## 11. Notifications
- IT/Integration: interface down, ACK failure rate spike, DLQ growth, JWKS unreachable for an app, certificate/token expiry, sandbox reset failures.
- Partner developers (via EN-026): deprecation notices, breaking-change advisories, quota warnings, incident status.
- DPO: unusual external access volume for a single patient, break-glass via API, new app approved with PHI scopes.
- MRD: reconciliation queue items older than 24 h.

## 12. Permissions (RBAC keys)
`interop.map.manage` (Integration Engineer, IT Admin) · `interop.app.manage` (IT Admin; approval by Hospital Admin) · `interop.hl7.manage` (Integration Engineer) · `interop.message.read` (IT, Lab/Rad managers scoped to their interfaces) · `interop.payload.read` (IT lead, DPO — step-up, audited as PHI) · `interop.message.replay` (IT Admin) · `interop.reconcile` (MRD Officer, IT Admin) · `interop.access.read` (DPO, Auditor) · `interop.sandbox.manage` (IT Admin) · `interop.report.read` (Admin, IT, Auditor) · FHIR scopes are separate: `patient/*.r`, `user/*.rs`, `system/*.rs` mapped onto internal permissions at token issue.

## 13. Non-functional
- Volumes for a 2000-bed hospital: **HL7 v2 ~250k messages/day** (20k lab results, ADT for 5000 OP + 300 admissions/discharges, orders, charges), **FHIR ~200k API calls/day** at go-live growing with partner apps.
- FHIR read p95 < 250 ms for single-resource reads, < 600 ms for indexed searches returning ≤ 50 resources; `$everything` for an average patient < 3 s; bulk export of 100k resources < 15 min on the read replica.
- HL7 v2: parse + map + ACK p95 **< 200 ms**; MLLP listener sustains ≥ 200 msg/s per interface; ordered delivery per patient partition.
- Search index maintained incrementally on write (same transaction or via outbox within 2 s); a full reindex of one resource type must be runnable online.
- Availability: FHIR façade behind the API gateway with per-app quotas so one partner cannot degrade clinical use; read traffic prefers the read replica; MLLP listeners run in a dedicated process with graceful drain on deploy.
- Security: TLS 1.2+ (mTLS for system clients), OAuth2 with PKCE, asymmetric client assertions for backend services, no PHI in URLs (search params with identifiers use POST `_search` where required), full request/response redaction in logs, per-app IP allow-lists.
- Accessibility/i18n: admin console WCAG 2.2 AA; `OperationOutcome` messages are developer-facing English with stable codes; patient-facing consent screens localised.

## 14. Acceptance Criteria
1. Given the NRCeS profile pack is active, when a partner calls `GET /fhir/R4/metadata`, then the CapabilityStatement lists exactly the enabled resources, interactions, search parameters, profiles and SMART security declarations, generated from live configuration.
2. Given a SMART app launched from the patient chart with scope `patient/Observation.rs`, when it requests observations for a different patient, then the request is rejected with 403 and the attempt is audited.
3. Given a patient has no active data-sharing consent covering an external requester, when that requester reads `DiagnosticReport`, then the API returns 403 with a non-revealing `OperationOutcome` and the denial is logged with the consent check result.
4. Given a `MedicationRequest` is POSTed by an external app, when it is processed, then it passes the same allergy/interaction checks (EN-029) as an internally created prescription and is rejected with a validation `OperationOutcome` if a hard-stop fires.
5. Given a write violates the tenant profile (missing must-support element), when `$validate` or the write is called, then the response is 422 with element-path-level issues and nothing is persisted.
6. Given an inbound ADT^A01 for an unknown patient on an interface not flagged `may_create_patient`, when it is processed, then no patient is created, the message is placed in the reconciliation queue with candidate matches, and an AE ACK explains the hold.
7. Given the same ORU^R01 is retransmitted with an identical MSH-10 within 30 days, when it arrives, then it is acknowledged AA without creating duplicate results.
8. Given a final lab result is later corrected, when the corrected ORU arrives, then a new `Observation`/`DiagnosticReport` version with `status=corrected` is created, the original remains in `_history`, and downstream subscribers are notified.
9. Given outbound ADT is configured, when a patient is admitted and their demographics are updated 2 seconds later, then the partner receives A01 before A08 (FIFO per patient), each with a unique control id.
10. Given the partner's MLLP endpoint is down for 20 minutes, when it recovers, then queued outbound messages are delivered in order with no loss and no duplicates, and the interface health returns to green.
11. Given a search on an unindexed parameter, when it is requested, then the API returns `not-supported` with a pointer to the capability statement rather than executing an unbounded query.
12. Given a local lab test code has no LOINC mapping, when the Observation is rendered, then the local code is returned in `coding[0]` with a data-absent-reason extension and a terminology gap is recorded for EN-027.
13. Given a patient revokes an app's access in the portal, when the app next calls the API, then its access and refresh tokens are rejected immediately and the revocation appears in the consent ledger.
14. Given a bulk `$export` request, when it completes, then NDJSON files are written to object storage with signed, expiring URLs, the job is recorded with row counts per resource type, and no export is possible without `system/` scopes plus explicit approval.
15. Given the sandbox, when a developer authenticates there, then only synthetic patients are returned, and presenting a sandbox token to the production endpoint fails with `invalid_audience`.
16. Given an API version is deprecated, when partners call it, then responses include deprecation headers with the sunset date and the developer portal shows the migration guide; the version remains callable for at least 12 months.

## 15. Enhancements / Later phases
- FHIR **Subscriptions R5 backport / topic-based** notifications and WebSocket channels for near-real-time partner feeds.
- `Patient/$match` (IHE PDQm-style probabilistic matching) and PIXm identity cross-reference for multi-provider networks.
- FHIR **Questionnaire/QuestionnaireResponse** driving EN-039 dynamic forms so external assessments round-trip.
- CDS Hooks support so external decision-support services can inject cards into the clinician workflow (with EN-029).
- ICD-11 as the primary morbidity coding with dual ICD-10 output during transition; SNOMED CT India national extension release management (EN-027).
- IHE XDS/MHD document sharing for regional health-information exchanges; e-Hospital (NIC) and state HIE connectors (source enhancement).
- FHIR-native analytics store (flattened SQL-on-FHIR views) for research, with de-identification pipeline and k-anonymity checks.
- Consent-aware bulk export with per-patient consent filtering for research cohorts under DPDP.
- HL7 v2 → FHIR auto-conversion library exposed to partners; message profile import from vendor conformance documents.
- Partner self-service certification suite (touchstone-style test scripts) in the sandbox.

## 16. Open Questions for the Hospital
1. Which external systems must exchange HL7 v2 at go-live, and can each provide their conformance/interface specification (message types, segments, Z-segments, sample messages)?
2. Is the hospital an ABDM HIP/HIU already, and which NRCeS IG version must be targeted?
3. Which SMART-on-FHIR apps are anticipated (imaging viewers, risk calculators, patient apps), and who approves apps that read PHI?
4. Should the FHIR API be exposed to the public internet, or only through a private network/VPN to known partners?
5. What is the policy for external writes — read-only façade at go-live, or accept orders/results/appointments from partners on day one?
6. Terminology licensing: does the hospital hold a SNOMED CT India affiliate licence and LOINC usage acknowledgement? Who maintains local-code → standard-code mappings?
7. Patient matching rules acceptable for inbound feeds (identifier-only vs demographic matching thresholds) and who staffs the reconciliation queue?
8. Are there statutory reporting flows (notifiable diseases, cancer/trauma registry, birth/death) that must be automated, and in which format?
9. Data-residency and de-identification requirements for any research/analytics bulk export.
10. Expected partner volumes and SLAs (messages/day, uptime commitment, support hours) — needed to size quotas and on-call.
11. Retention required for raw HL7 messages (30 days default) given medico-legal disputes about what a partner sent.
