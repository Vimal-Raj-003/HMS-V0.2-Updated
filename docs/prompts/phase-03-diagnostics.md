# PHASE 3 — DIAGNOSTICS (LAB, RADIOLOGY, PACS)

Phases 0–2 complete. Orders exist but nothing fulfils them. This phase closes the loop.

## Read first

`CLAUDE.md`, `docs/PROGRESS.md`, then: **OP-004** (LIS), **EN-004** (analyzer integration), **EN-031** (NABL/QC),
**OP-008** (radiology), **EN-008** (PACS/DICOM), **EN-035** (RIS ownership map), **OP-022** (investigation console),
**EN-019** (HL7/FHIR — HL7 v2 side only in this phase), **EN-013** (barcode), **EN-017** (integration hub),
`docs/08-integration-catalogue.md` §lab analyzers and §DICOM.

Plan first; wait for "go".

## Goal

An ordered test becomes a collected sample, a validated result, a signed report in the patient's hands and the
doctor's timeline — with critical values reaching a human within minutes, and NABL/AERB evidence generated as a
by-product rather than as paperwork.

## Deliverables

### 3.1 Lab masters & configuration (OP-004)

Test catalogue with LOINC mapping, panels/profiles, sample types & containers, reference ranges by age/sex/
pregnancy/method, critical (panic) limits, delta-check rules, method/instrument mapping, TAT targets per test and
priority, sub-departments (biochem, haematology, micro, histopath, serology, molecular), outsourced/referral test
routing with partner lab config, price link to tariff (Phase 5), report templates (EN-039).

### 3.2 Pre-analytical (OP-004)

Order reception worklist; **barcode sample labels** (EN-013) with container colour guidance; phlebotomy worklist
and collection confirmation (scan patient wristband + scan tube = two-identifier check); home/ward collection
rounds; sample receipt/accessioning at the lab; **rejection with coded reasons** and automatic notification for
recollection; chain-of-custody for medico-legal samples (links TR-008); fasting/prep verification.

### 3.3 Analytical (OP-004 + EN-004)

- Bench worklists by sub-department and instrument; manual result entry with unit validation and previous-value
  display; batch entry.
- **Analyzer interfacing (EN-004):** HL7 v2 ORM^O01 outbound worklist / ORU^R01 inbound results over MLLP, and
  ASTM E1394/LIS2-A2 over serial/TCP; per-instrument driver config; message log with replay; unmatched-result
  queue; downtime buffering; instrument status dashboard. Include a simulator so this can be tested without hardware.
- **Auto-validation rules:** in-range + delta pass + QC in control + no instrument flag → auto-verify; everything
  else goes to a human. Configurable per test. Every auto-validation is logged as such.
- **QC (EN-031):** control lots and targets, Levey-Jennings charts, Westgard multi-rules, run rejection and
  corrective-action log, instrument lockout on repeated violation, EQA/PT programme records.
- Microbiology workflow: culture, growth, organism identification, sensitivity panel, antibiogram feed to IP-012.
- Histopathology/cytology: gross description, blocks/slides, staining, sign-out with images.

### 3.4 Post-analytical (OP-004)

Two-level validation (technician → pathologist) with e-sign; **critical value workflow: alert the ordering doctor
within the configured minutes, require acknowledgement, and record the call-back (who called whom, when, read-back
confirmed)** — this is a NABL requirement and the single most important safety loop in this phase; amended results
with reason and re-notification; cumulative/serial reports; branded PDF with QR verification; delivery to portal,
WhatsApp, print, and doctor timeline; TAT dashboards with SLA breach alerts; NABL evidence pack export.

### 3.5 Radiology (OP-008)

Modality worklist by scanner, appointment slots with prep instructions, arrival/check-in, technologist workflow
(exam started/completed, retakes with reason, contrast administered), **radiation dose capture (RDSR where
available, manual otherwise) with cumulative per-patient dose and DRL comparison**, pregnancy check hard-stop for
applicable exams, contrast allergy pre-medication protocol, **PC-PNDT Form F capture for obstetric ultrasound with
a product-level block on any sex-determination field**, structured reporting templates by modality, radiologist
worklist with priority, prior-study comparison, critical-finding alert (same acknowledgement loop as lab),
report sign-off, peer review/QA sampling.

### 3.6 PACS & viewer (EN-008)

Orthanc as the DICOM archive (C-STORE, C-FIND, MWL, MPPS, WADO-RS), storage tiering to S3/MinIO with retention by
modality, OHIF viewer embedded in the chart with window/level, zoom, measure, annotate, MPR for CT/MR, hanging
protocols, prior comparison; study share links with expiry and CD/DVD burn export; tele-radiology access for
external radiologists with scoped permissions; image access fully audited.

### 3.7 Investigation console (OP-022)

For everything that is neither a lab analyzer nor DICOM: ECG strips, endoscopy images, PFT reports, external
reports — upload, template report, co-sign (resident → consultant), attach to timeline.

## Constraints & watch-outs

- **Never let a result exist without a patient identity check.** Unmatched analyzer results go to a queue, never
  auto-assigned by name similarity.
- Manual entry must always remain available — a dead analyzer cannot stop the lab.
- Result values are typed (numeric with units, coded, text) — do not store everything as strings.
- Radiology images can be gigabytes: stream, never buffer; thumbnails for lists; measure viewer load time.
- Do not build AI reading here (AI-007 is Phase 12).

## Exit gate

1. Order → label printed → collected with double identity scan → accessioned → analyzer result received via the
   simulator → auto-validated → report PDF with QR → visible in the doctor's timeline and the patient's portal stub.
2. A critical potassium triggers an alert to the ordering doctor, escalates when unacknowledged, and the call-back
   is documented; the whole chain is reportable for a NABL audit.
3. A hemolysed sample is rejected with reason; the doctor and patient are notified; recollection is tracked.
4. Westgard 1-3s violation blocks the run and requires corrective action before results release.
5. A CT study reaches Orthanc, appears on the modality worklist first (MWL), is viewed in OHIF with a prior
   comparison, dose is recorded, and the report is signed.
6. Obstetric ultrasound cannot be saved without Form F fields; no sex-determination field exists anywhere.
7. Analyzer disconnected for 30 minutes → messages buffer and replay with zero loss; unmatched queue works.
8. 20 000 results/day load test passes within the budgets in `docs/07`; report PDF generation < 3 s p95.
9. Previous gates green; `docs/PROGRESS.md` updated with the analyzer inventory still to be interfaced.
