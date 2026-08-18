# AI-007 — AI Radiology Assist (Worklist Prioritisation by Suspected Criticality, Abnormality Flagging via Cleared Third-Party Engines, Preliminary Report Drafting for Radiologist Review, Technical Quality Checks, PACS/RIS Integration, CDSCO/SaMD Boundary & Audit of AI-Influenced Reports)

| Field | Value |
|---|---|
| Domain | AI & Advanced Tech |
| Module ID | AI-007 |
| Phase | 12 |
| Priority | P2 |
| Complexity | Very High |
| Depends on | **AI-001 §0 (AI Platform Foundation — mandatory)**, EN-008 (PACS/Orthanc, DICOM, OHIF viewer, MWL), OP-008 (Radiology & Imaging — orders, worklist, structured reporting, critical findings), EN-017 (Integration Hub — DICOM routing, retries, DLQ), EN-029 (critical-result alerting & escalation — unchanged), TR-002 (fracture registry), OP-006/TR-001 (ER context), EN-027 (RadLex/body-part/procedure masters), EN-024 (audit), EN-038 (approval), AI-004 (dictation into the report), NC-020 (AERB/biomedical equipment context) |
| Consumed by | OP-008 (reading worklist & report), EN-008 (viewer overlays), TR-002 (fracture cases), IP-009/OP-006 (critical findings context), NC-015 (quality), EN-001 (analytics) |
| Feature flag | `module.ai_radiology.enabled` (sub: `rad.worklist_priority`, `rad.abnormality_flag`, `rad.report_draft`, `rad.quality_checks`, `rad.prior_comparison`, `rad.vendor_<key>`) |
| Primary roles | Radiologist (12), Radiology Technician (36) |
| Secondary roles | Emergency Physician (8), Intensivist (11), Surgeon/Orthopaedic (9), Medical Superintendent (4), Quality Manager (54), Biomedical Engineer (48), IT Admin (56), Auditor (58) |
| Regulatory | **CDSCO / Medical Devices Rules 2017 — image-analysis software that detects or characterises disease is Software as a Medical Device. Vim's HMS does NOT build such models. Only third-party engines holding a valid CDSCO import/manufacture licence and/or CE-MDR / US-FDA 510(k) clearance are integrated, via an adapter, with the clearance reference recorded per study (AI-001 §0.8)**; AERB (radiation safety, dose — unchanged by AI); NABH 6th edn (reporting TAT, critical-result communication); NMC (the reporting radiologist is solely responsible for the report); PC-PNDT Act (**no AI feature may be used for foetal sex determination — obstetric ultrasound is excluded from all AI processing by design**); DPDP + DICOM de-identification for any egress; ABDM/EHR Standards (final report as FHIR DiagnosticReport) |

## 1. Purpose
AI-007 makes the radiology reading queue smarter and safer without ever making a diagnostic claim of its own: it
orders the worklist so that a suspected intracranial haemorrhage is read before a routine follow-up, surfaces
abnormality flags produced by **cleared third-party engines**, drafts the technical/descriptive scaffolding of a
report for the radiologist to complete, and runs deterministic quality checks (laterality mismatch, missing prior
comparison, incomplete study). Every report remains authored and signed by a radiologist, and every study whose
report was influenced by AI is auditable as such.

## 2. Users & Jobs-to-be-done
- **Radiologist (12, reading room, dual/triple monitor, 150–250 studies/day)**: read the sickest patient first; see a
  vendor flag with its heat-map overlay and confidence; start from a draft that already contains technique, comparison
  and normal-template scaffolding; dictate findings and impression; sign. The job is minutes saved per study and
  fewer misses on the queue tail.
- **ER physician / intensivist (8/11)**: get a faster read on the studies that matter — measured as time-to-report for
  AI-flagged critical studies versus baseline.
- **Radiology technician (36, modality console)**: be told immediately that the laterality marker contradicts the
  order, that the study is incomplete, or that positioning failed quality — while the patient is still on the table,
  when a repeat costs nothing but a minute.
- **Orthopaedic surgeon (9) / trauma team**: fracture flags on trauma X-rays routed alongside TR-002's registry.
- **Quality / MS (54/4)**: evidence that AI flags are monitored — sensitivity/specificity in local practice,
  discrepancy rate, and the audit trail of AI-influenced reports for any medico-legal review.
- **IT/Biomedical (56/48)**: keep the DICOM routing, vendor connectivity and licence/clearance validity healthy.

## 3. Core Workflows

### 3.1 Vendor engine integration (the architectural decision)
1. **Vim's HMS builds no diagnostic imaging models.** It builds an **adapter layer**. Each engine is registered in
   `rad_ai_engines` with: vendor, product name and version, modality, body part, indications, **regulatory clearance
   references** (CDSCO licence number, CE-MDR certificate, FDA 510(k)/De Novo number, with expiry dates), intended-use
   statement, contraindications and known limitations, deployment mode (on-prem appliance / hospital VPC / vendor
   cloud), data-handling terms, and the licence/entitlement (EN-040).
2. **An engine cannot be enabled without a valid, unexpired clearance reference on file.** The platform blocks
   enablement, and an expiring clearance raises alerts at 90/60/30 days and auto-disables the engine on expiry
   (fail-safe: the worklist simply reverts to standard ordering).
3. Supported integration patterns, all behind one adapter interface (`analyse(studyRef) → findings[]`):
   **(a) DICOM push/pull** — the engine is a DICOM node; studies are routed by rule from Orthanc (EN-008), results
   return as DICOM SC/SR/GSPS overlays; **(b) REST/FHIR ImagingStudy + async callback**; **(c) vendor SDK on an
   on-prem appliance** for tenants with no egress.
4. **Routing rules** (`rad_ai_routing`) decide which studies go to which engine: modality + body part + procedure code
   + patient age + ordering location + priority. Everything else is never sent — minimising both cost and exposure.
5. **De-identification before egress**: for any engine outside the hospital boundary, DICOM headers are
   de-identified per DICOM PS3.15 Basic Application Level Confidentiality (patient name/ID/DOB/accession replaced with
   a reversible pseudonym held only inside the hospital), burned-in annotations detected and blocked (a study with
   suspected burned-in PHI is not sent), and the mapping is stored locally.
6. **PC-PNDT hard exclusion**: obstetric/foetal ultrasound studies are excluded from every AI routing rule at the
   platform level and cannot be enabled by configuration. This is a legal red line, not a preference.

### 3.2 Worklist prioritisation
1. On `study.available` (EN-008), routing sends eligible studies to the configured engine(s). Results return as
   findings with vendor confidence and, where supported, localisation overlays.
2. AI-007 computes a **priority score** from: vendor criticality flags (e.g. suspected intracranial haemorrhage,
   pneumothorax, pulmonary embolism, free air, aortic dissection where the engine covers it), the clinical order
   priority (STAT/urgent/routine), the ordering location (ER/ICU weight), patient context (trauma activation, ESI
   level), and study age relative to the TAT target.
3. The reading worklist re-orders **within priority class** — an AI flag can escalate a study's position and can
   **never** demote a study below its clinically-ordered priority. A STAT study stays STAT even with no AI flag.
   This asymmetry is the safety property: AI can only accelerate, never delay.
4. Flagged-critical studies additionally raise a worklist banner and, if unread past a configurable threshold
   (default 20 min for suspected haemorrhage/pneumothorax), notify the on-duty radiologist and the ordering unit via
   EN-037 — **as a workflow nudge, not as a clinical critical-result alert** (that pathway belongs to the radiologist
   via OP-008/EN-029 once they have actually read the study).
5. No AI flag is ever communicated to the ordering clinician as a finding before a radiologist has read the study.
   The ER sees "prioritised", never "AI suspects a bleed".

### 3.3 Abnormality flagging in the viewer
1. In the OHIF/PACS viewer (EN-008), vendor findings render as a **separate, toggleable overlay layer** (heat map,
   bounding box or GSPS), off by default per radiologist preference, with the vendor name, product version,
   confidence and clearance reference visible on the layer's info panel.
2. The radiologist marks each flag as **agree / disagree / indeterminate** — a two-second interaction that produces
   the local performance dataset (§3.7). This is optional but strongly encouraged and is tracked as a coverage metric.
3. Flags never annotate the diagnostic image itself, never persist into the DICOM the hospital archives as the record
   (they are a separate series clearly labelled "AI — not for primary diagnosis"), and never appear in a patient-facing
   copy of the study.
4. Where an engine returns quantitative output (e.g. haemorrhage volume, nodule size, cardiothoracic ratio, bone age),
   it is shown as a measurement with the vendor's stated error bounds, and the radiologist may accept it into the
   report as a cited measurement.

### 3.4 Preliminary report drafting
1. The draft that AI-007 produces is deliberately **scaffolding, not interpretation**:
   - `clinical_indication` (from the OP-008 order),
   - `technique` (from DICOM metadata: modality, sequences/phases, contrast agent and volume, kVp/mAs, slice
     thickness, reconstruction),
   - `comparison` (prior studies located by EN-008 with dates and modality),
   - `findings` — **template scaffolding only** (the structured section headings for that study type, pre-populated
     with the hospital's own normal-statement template where the radiologist's macro is configured), plus any
     **vendor-reported findings quoted as attributions**: *"AI (Vendor X v2.3) flags a possible right frontal
     hyperdensity, confidence 0.86 — radiologist to verify"*,
   - `impression` — **always empty**.
2. **The impression is never generated.** This is the module's bright line between a documentation aid and a
   diagnostic claim, and it is what keeps the feature outside SaMD classification (AI-001 §0.8).
3. The radiologist completes the report by dictation (AI-004) or typing, edits everything freely, and signs. Signing
   creates the OP-008 report version with `ai_influenced = true`, the engine(s) and versions used, which flags were
   agreed/disagreed, and the draft's edit distance.
4. If the radiologist deletes every AI-attributed sentence, the report is still marked `ai_influenced` (the fact that
   AI output was displayed is the auditable event, not whether text survived).
5. **Critical findings**: only the radiologist's own reading triggers OP-008's critical-result communication and
   EN-029's acknowledgement ladder. An AI flag alone never starts that clock.

### 3.5 Technical quality checks (deterministic, not ML)
Run at acquisition and again before reading; these are rule checks and are the most reliably valuable part of the
module:
1. **Laterality mismatch** — DICOM laterality/marker vs the order's laterality vs the body-part tag; mismatch blocks
   the study from the reading queue until the technician resolves it (a wrong-side report is a sentinel event).
2. **Missing prior comparison** — a follow-up study with an available prior not loaded; flags for the radiologist.
3. **Study completeness** — expected series/sequences for the protocol are absent (e.g. no post-contrast phase on a
   contrast-ordered CT).
4. **Patient/order mismatch** — accession, patient ID, age/sex inconsistent with the order or the images.
5. **Repeat/reject tracking** — repeated exposures for the same body part within a session, feeding the AERB/quality
   repeat-rate indicator and the technician's coaching data (NC-015).
6. **Dose outliers** — DLP/CTDIvol beyond the protocol's diagnostic reference level (AERB), flagged to the
   radiographer and Biomedical (this is a rule against the hospital's DRL table, not a prediction).
7. **Pregnancy + ionising radiation** — if the pregnancy flag is set without a documented justification, the study is
   flagged (EN-029 owns the ordering-time hard-stop; this is the acquisition-side backstop).

### 3.6 Exceptions
- **Engine unavailable / timeout / licence expired** → studies flow through the normal worklist unchanged with a
  visible "AI assist unavailable" badge; nothing queues up waiting for AI.
- **Engine returns a flag on a study type outside its intended use** → the flag is discarded and logged (an
  out-of-indication result is a vendor-integration defect, not a finding).
- **Burned-in PHI detected** → the study is not sent to any external engine; local engines may still process it.
- **Discrepancy** (radiologist disagrees with a high-confidence critical flag, or a later addendum contradicts the
  original) → recorded in the discrepancy register and reviewed at the radiology quality meeting.
- **Vendor changes model version** → treated as a new engine version: local performance monitoring resets its
  baseline, the Governance Committee is notified, and a shadow period may be required by policy.

## 4. Data Model (schema `ai`, prefix `rad_`; images stay in PACS, reports in OP-008)
- `rad_ai_engines` — id, hospital_id?, vendor, product, version, modality[], body_parts[], indications_md,
  intended_use_md, limitations_md, clearance jsonb (cdsco_licence_no, ce_mdr_ref, fda_510k, issued_at, expires_at),
  deployment enum(onprem_appliance/hospital_vpc/vendor_cloud), data_handling_terms, deid_required bool,
  licence_ref (EN-040), status enum(registered/enabled/disabled/expired), enabled_by, enabled_at,
  performance_baseline jsonb (vendor-published sens/spec), created…; **enablement blocked when clearance is absent or
  expired**.
- `rad_ai_routing` — id, hospital_id, branch_id?, engine_id, modality, body_part, procedure_codes[], min_age,
  max_age, ordering_locations[], priority_filter, active, excluded bool, exclusion_reason (e.g. `pcpndt_obstetric`),
  effective_from; UNIQUE partial index preventing any rule that includes obstetric/foetal ultrasound.
- `rad_ai_jobs` — id uuidv7, hospital_id, study_instance_uid, accession_no, order_id (OP-008), engine_id,
  engine_version, sent_at, deid_profile, deid_map_ref, returned_at, latency_ms, status enum(queued/sent/returned/
  failed/timeout/discarded_out_of_indication/blocked_burned_in_phi), error_code, cost_amount; index
  (hospital_id, sent_at desc), (study_instance_uid).
- `rad_ai_findings` — id, job_id, finding_code (vendor + RadLex where mapped), label, criticality
  enum(critical/significant/incidental/normal), confidence, localisation jsonb (series/instance/coordinates or
  GSPS ref), quantitative jsonb (value, unit, error_bounds), overlay_series_uid?, radiologist_verdict
  enum(agree/disagree/indeterminate/not_reviewed), verdict_by, verdict_at; index (job_id), (criticality, created_at).
- `rad_worklist_priority` — study_instance_uid, hospital_id, base_priority enum(stat/urgent/routine), ai_boost int,
  final_rank_score numeric, factors jsonb (ai flags, location weight, TAT pressure, trauma flag), computed_at,
  unread_alert_sent_at?; **rule: final priority may never be lower than base_priority**.
- `rad_report_drafts` — id, study_instance_uid, order_id, template_id (OP-008), payload jsonb (indication, technique,
  comparison, findings_scaffold, ai_attributions[], impression = null enforced), generated_at, prompt_version_id,
  model_id, status enum(draft/used/discarded/expired), radiologist_id, edit_distance_pct, signed_report_ref.
- `rad_quality_checks` — id, study_instance_uid, check_type enum(laterality_mismatch/missing_prior/incomplete_study/
  patient_order_mismatch/repeat_exposure/dose_outlier/pregnancy_radiation), severity enum(block/warn/info), detail
  jsonb, raised_at, resolved_by, resolved_at, resolution enum(repeated/corrected/justified/dismissed), blocked_read bool.
- `rad_discrepancies` — id, study_instance_uid, type enum(ai_flag_disagreed/missed_by_ai/addendum_contradiction/
  peer_review_variance), ai_finding_id?, original_report_ref, corrected_report_ref?, severity, clinical_impact
  enum(none/minor/major), reviewed_at, review_forum, capa_ref (NC-015).
- `rad_ai_performance_daily` (read model) — hospital_id, engine_id, engine_version, day, modality, body_part,
  studies_processed, flags_raised, agree, disagree, indeterminate, local_ppv, critical_flag_time_to_read_median_min,
  turnaround_flagged_vs_unflagged, cost.
- Retention: jobs & findings with the study (per PACS/NABH retention, typically 3–8 years for images, reports longer);
  discrepancies 10 years; engine registry and clearance records for the life of the deployment + 5 years.

## 5. Business Rules & Validations
- **No self-built diagnostic models.** Any abnormality detection, characterisation or measurement that could
  constitute a diagnostic claim must come from a registered, cleared third-party engine. A configuration attempting
  to enable an engine without a valid clearance reference is rejected.
- **An engine auto-disables on clearance expiry**, and the worklist reverts to standard ordering without any
  clinical disruption.
- **AI can only raise priority, never lower it.** The final worklist rank is `max(base_priority, ai_adjusted)`.
- **The impression is never AI-generated**, and AI-attributed findings text is always quoted with the vendor name,
  version and confidence — never written as the radiologist's own voice.
- **Only a radiologist's read triggers critical-result communication.** AI flags never reach the ordering clinician
  as findings, never appear in the patient portal, and never enter the discharge summary.
- **PC-PNDT**: obstetric/foetal ultrasound is excluded from AI processing at the routing layer, cannot be enabled,
  and any attempt is logged as a compliance event.
- **De-identification is fail-closed**: if the de-identification profile cannot be applied, or burned-in PHI is
  suspected, the study is not sent externally.
- **Every report where AI output was displayed is marked `ai_influenced`** with the engines, versions, flags shown and
  the radiologist's verdicts — regardless of whether AI text survived into the final report. This is the medico-legal
  requirement that makes the feature defensible.
- **Laterality mismatch blocks reading** until resolved; the system may not let a study with contradictory laterality
  reach a reporting radiologist unflagged.
- **Local performance monitoring is mandatory**, not optional: an engine whose local PPV falls below the threshold
  agreed with the vendor (or whose disagree rate exceeds it) is auto-demoted to shadow and reviewed. Vendor-published
  sensitivity is treated as a claim to be verified locally, not a fact.
- Radiologist verdict capture may never be made a blocking step (it must not slow reading), but coverage below 30 %
  triggers a governance conversation because the monitoring depends on it.
- No AI output influences billing, dose reporting or AERB submissions.

## 6. API Surface (`/api/v1/rad-ai`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET/POST/PATCH | /engines ; /engines/:id | vendor engine registry | `radai.engine.manage` (56 + 4 approval) | clearance validation enforced |
| POST | /engines/:id/enable \| /disable \| /shadow | lifecycle | `radai.engine.manage` (+ EN-038) | blocked without valid clearance |
| GET | /engines/:id/health ; POST /engines/:id/test | connectivity & round-trip test | `radai.engine.manage` | uses a phantom/test study |
| GET/POST | /routing ; PATCH /routing/:id | study routing rules | `radai.routing.manage` (12 lead, 56) | obstetric US rule rejected |
| GET | /jobs?study&engine&status&from&to | processing log | `radai.job.read` (12, 56, 58) | |
| GET | /studies/:uid/findings | vendor findings for a study | `radai.finding.read` (12, 36 limited) | overlay refs |
| POST | /findings/:id/verdict | agree / disagree / indeterminate | `radai.finding.verdict` (12) | 2-second interaction |
| POST | /studies/:uid/draft | generate the report scaffold | `radai.draft.generate` (12) | impression always null |
| GET/PATCH | /drafts/:id | review/edit before signing | `radai.draft.use` (12) | signing happens in OP-008 |
| GET | /quality-checks?status&type ; POST /quality-checks/:id/resolve | technical QC worklist | `radai.qc.read|resolve` (36, 12) | laterality blocks reading |
| GET | /worklist-priority?branch | computed reading order + factors | `radai.worklist.read` (12) | explains why a study is ranked |
| GET/POST | /discrepancies ; POST /discrepancies/:id/review | discrepancy register | `radai.discrepancy.manage` (12 lead, 54) | feeds quality meeting |
| GET | /metrics/performance ; /metrics/turnaround | local engine performance & TAT | `radai.report.read` (4, 12, 54) | read models |

## 7. Domain Events (outbox)
- `radai.study.routed` / `radai.job.completed|failed|blocked` → integration monitoring (EN-017), cost metering.
- `radai.finding.critical_flagged` → **worklist prioritisation and radiologist nudge only** (never the ordering
  clinician).
- `radai.finding.verdict_recorded` → local performance read model, vendor feedback pack.
- `radai.draft.generated|used|discarded` → radiologist productivity metrics.
- `radai.quality.laterality_mismatch` (blocks read) / `radai.quality.dose_outlier` / `radai.quality.repeat_detected`
  → technician, Biomedical (48), AERB quality indicator (NC-015/NC-020).
- `radai.report.ai_influenced` → OP-008 report metadata, audit, medico-legal register.
- `radai.engine.clearance_expiring|expired|auto_disabled` → IT, MS, Quality (90/60/30-day ladder).
- `radai.engine.performance_degraded` → auto-demote to shadow + Governance Committee.
- `radai.discrepancy.recorded` → radiology quality meeting agenda, NC-015 CAPA when major.
- `radai.compliance.pcpndt_attempt_blocked` → compliance alert (should never fire).
- Consumes: `study.available`, `order.imaging.created`, `report.signed`, `report.addendum.created`,
  `trauma.activation.declared`, `patient.pregnancy.flagged`.

## 8. Screens (UI)
- **Reading Worklist** (desktop, dual/triple monitor, radiologist): studies with priority chip (STAT/urgent/routine),
  an **AI boost badge** showing *why* a study moved up ("AI flag: suspected ICH, ER, unread 14 min"), TAT countdown,
  prior-available indicator, QC block markers. Sorting is explainable — hovering any rank shows the factor breakdown.
  Shortcuts: `Enter` open, `P` toggle AI-priority view, `F` filter flagged, `N` next unread critical.
- **Viewer overlay controls** (OHIF, EN-008): AI layer toggle (`A`), opacity slider, per-finding chips in a side rail
  with confidence and vendor/version, agree/disagree/indeterminate buttons (`1/2/3`), and a permanent watermark on the
  AI series: "AI overlay — not for primary diagnosis". Overlay off by default.
- **Report draft panel** (reporting screen, desktop): indication, technique and comparison pre-filled and clearly
  marked as auto-populated from DICOM/order; findings scaffold with the hospital's normal-statement macros; AI
  attributions rendered as quoted, dismissible blocks; **an empty impression box with the label "impression must be
  authored by the reporting radiologist"**. Dictation (AI-004) binds here. `Ctrl+Enter` sign (in OP-008).
- **Technician QC console** (modality console/tablet, radiographer): live check results after acquisition —
  laterality mismatch in red with the order's laterality quoted, missing series, dose vs DRL, repeat count; actions:
  repeat, correct the order, add justification. Designed to be actionable **before the patient leaves**.
- **Engine Registry & Compliance** (desktop, IT/MS): engines with clearance references and expiry countdowns,
  intended-use and limitations text, deployment mode, de-identification profile, licence entitlement, enable/disable
  with approval trail, connectivity health and last test round-trip.
- **Local Performance dashboard** (desktop, radiology lead/Quality): per engine and version — flags raised, agree/
  disagree rates, local PPV, verdict coverage, time-to-read for flagged vs unflagged criticals, TAT impact,
  discrepancy links, and vendor-claimed vs locally-observed performance side by side.
- **Discrepancy register** (desktop, radiology lead/Quality): AI-disagreed criticals, misses found on addendum or
  peer review, clinical impact grading, forum decisions, CAPA links.
- Empty/error states: "AI assist unavailable — worklist in standard order", "Engine licence expired — disabled on
  12 Aug", "Study not sent: possible burned-in patient identifiers", "Obstetric ultrasound — AI processing is
  disabled by law (PC-PNDT)".

## 9. Integrations
- **EN-008 / Orthanc**: DICOM routing rules, storage of AI result series (SC/SR/GSPS) as a clearly-labelled separate
  series, prior-study retrieval, OHIF overlay rendering, and the de-identification pipeline.
- **OP-008**: order context, structured report templates, report signing, critical-result workflow, TAT measurement.
- **EN-017**: connector health, retries with backoff, dead-letter queue for engine callbacks, and rate limiting to the
  vendor.
- **Vendor engines** (examples of the class of product integrated, subject to clearance verification per deployment):
  chest X-ray triage, CT head haemorrhage triage, fracture detection, TB screening, mammography CAD, LVO/stroke
  triage. Each is registered, licence-gated (EN-040) and independently enable-able.
- **AI-004** for dictation into the draft; **TR-002** for fracture-flagged trauma studies; **NC-020/AERB** for dose
  and equipment context; **EN-029** for the pregnancy/contrast ordering-time rules (unchanged).
- **Network**: on-prem appliances sit on the imaging VLAN; cloud engines require an explicit egress policy, a signed
  DPA and DICOM de-identification.

## 10. Reports & Analytics
- **Turnaround**: report TAT for AI-flagged critical studies vs baseline vs unflagged (the primary business case);
  time from study available to first read; unread-critical breaches.
- **Local engine performance**: agree/disagree/indeterminate rates, local PPV by finding type, verdict coverage,
  drift after a vendor version change, vendor-claimed vs observed.
- **Quality/safety**: laterality mismatches caught (and how many led to a repeat rather than a wrong-side report),
  incomplete studies caught, repeat rate by technician and equipment, dose outliers vs DRL, discrepancy rate and
  clinical impact grading.
- **Adoption**: draft usage rate, draft edit distance, overlay toggle usage, radiologists opted in.
- **Compliance**: engines with valid clearance (must be 100 % of enabled), expiry ladder status, studies sent
  externally with de-identification confirmed, PC-PNDT block attempts (must be 0).
- **Cost**: ₹ per study analysed by engine, ₹ per critical flag confirmed.
- Read models: `analytics.mv_radai_performance_daily`, `mv_radai_turnaround_daily`, `mv_rad_quality_checks_daily`.

## 11. Notifications
- Radiologist: critical-flagged study unread past threshold (workflow nudge, escalating to the on-duty lead);
  QC block requiring resolution.
- Technician (36): laterality mismatch, incomplete study, dose outlier — immediately at the console.
- Biomedical (48): repeated dose outliers on a specific unit (possible calibration issue → NC-020 work order).
- IT/MS: engine connectivity failure, callback DLQ growth, **clearance expiring at 90/60/30 days and auto-disable on
  expiry**.
- Quality/MS: engine performance degradation, discrepancy with major clinical impact, monthly performance pack.
- Never: an AI flag to the ordering clinician or the patient.

## 12. Permissions (RBAC keys)
`radai.engine.manage` (56 with MS 4 approval) · `radai.routing.manage` (12 lead, 56) · `radai.job.read` (12, 56, 58) ·
`radai.finding.read` (12; 36 limited to QC-relevant) · `radai.finding.verdict` (12 only) · `radai.draft.generate|use`
(12) · `radai.qc.read` (36, 12) / `radai.qc.resolve` (36, 12) · `radai.worklist.read` (12) ·
`radai.discrepancy.manage` (12 lead, 54) · `radai.report.read` (4, 12, 54, 48) · plus AI-001 §0.13.

## 13. Non-functional
- **Volumes (2000-bed)**: ~1200 imaging studies/day (700 X-ray, 250 CT, 120 US, 80 MRI, 50 other); ~450 eligible for
  AI routing under typical rules; peak 90 studies/hour in the 09:00–13:00 window; ~800 reports/day.
- **Latency**: study available → engine result p95 < 3 min for CT head/chest X-ray triage (the whole point is
  pre-read triage); worklist re-rank < 10 s after a result; draft generation < 8 s; QC checks < 2 s at acquisition
  (they must land while the patient is still positioned).
- **Throughput & resilience**: engine queues are bounded; if an engine backs up beyond 15 minutes, routing to it is
  paused and the worklist proceeds normally — AI must never become a bottleneck in the imaging chain.
- **Acceptance thresholds (production gates)**: local PPV for critical flags ≥ the vendor's claimed value minus 10 %
  relative on ≥ 200 local studies before leaving shadow; laterality-mismatch detection recall = 1.0 on the
  deterministic test set (it is a rule check, so anything less is a bug); draft technique/comparison field accuracy
  ≥ 0.98 (DICOM-derived); **impression non-empty rate = 0**; time-to-read for flagged criticals must improve by
  ≥ 20 % versus the pre-deployment baseline or the feature's value is unproven and reviewed.
- **Shadow period**: minimum 4 weeks per engine per site, with radiologist verdicts collected but no worklist
  re-ranking, before enablement.
- **Security/privacy**: DICOM de-identification verified by an automated conformance test per engine; burned-in PHI
  detection on modalities known for it (US, older CR); TLS/VPN to any external engine; no images in logs; overlays
  stored in the hospital's PACS, never only at the vendor.
- **Availability**: 99 % for the routing service; failure is invisible to the clinical workflow beyond a badge.
- **Accessibility**: overlay toggles and verdict actions are keyboard-operable; overlays never rely on colour alone
  (outline + label); reading-room dark theme with no forced light flashes.
- **Testing**: DICOM conformance tests, a phantom/test-study round trip per engine on every deploy, a regression
  asserting obstetric US routing is impossible, an assertion that AI can never lower priority, and a nightly check
  that no enabled engine has an expired clearance.

## 14. Acceptance Criteria
1. **Given** an engine with no valid clearance reference or an expired one, **when** enablement is attempted, **then**
   it is blocked with the reason, and an already-enabled engine auto-disables on the expiry date with notification.
2. **Given** a STAT-ordered study with no AI flag, **when** the worklist is ranked, **then** it is never placed below
   a routine study that carries an AI flag — AI may raise priority only.
3. **Given** a CT head with a vendor haemorrhage flag, **when** it appears on the worklist, **then** it is boosted
   with an explainable badge, the ordering clinician receives **no** finding, and only the radiologist's own read can
   start the critical-result communication clock.
4. **Given** a report draft is generated, **when** it renders, **then** indication/technique/comparison are populated
   from the order and DICOM, vendor findings appear as attributed quotes with vendor, version and confidence, and the
   impression field is empty and labelled as the radiologist's responsibility.
5. **Given** a radiologist signs a report after any AI output was displayed, **when** the report is stored, **then**
   `ai_influenced = true` with the engines, versions, flags shown and verdicts — even if no AI text remains.
6. **Given** an obstetric ultrasound, **when** any routing rule is evaluated or configured, **then** it is excluded
   from AI processing, configuration attempts are rejected, and an attempt is logged as a compliance event.
7. **Given** a study with suspected burned-in patient identifiers, **when** external routing is attempted, **then**
   the study is not sent, the job is marked blocked, and the radiologist sees no external AI result for it.
8. **Given** a chest X-ray ordered as "left" with DICOM laterality "right", **when** QC runs, **then** the study is
   blocked from the reading queue, the technician is alerted at the console, and reading is only possible after
   resolution.
9. **Given** the engine is unreachable or slow, **when** studies arrive, **then** routing pauses, the worklist
   operates in standard order with an "AI unavailable" badge, and no study is delayed waiting for AI.
10. **Given** a vendor returns a finding for a body part outside the engine's registered intended use, **when**
    processed, **then** the finding is discarded, logged, and never displayed.
11. **Given** the radiologist marks a critical flag as "disagree", **when** recorded, **then** the local performance
    model updates, and a pattern of disagreement beyond threshold auto-demotes the engine to shadow with committee
    notification.
12. **Given** a dose value beyond the protocol's DRL, **when** detected, **then** the radiographer and Biomedical are
    alerted, and the event feeds the AERB/quality repeat-and-dose indicators.
13. **Given** a medico-legal request for a study, **when** the audit is produced, **then** it shows every AI job,
    finding, overlay shown, verdict, the draft, the edit distance and the signed report — reconstructible in full.
14. **Given** a new engine, **when** enabled, **then** it must first complete a ≥ 4-week shadow period at this site
    with verdicts collected and local PPV within 10 % relative of the vendor claim.
15. **Given** an AI overlay series, **when** stored in PACS and when a patient copy of the study is produced,
    **then** the overlay is a separate labelled series and is excluded from the patient-facing export.
16. **Given** the feature is disabled entirely, **when** radiology operates, **then** worklist, reporting, QC rules
    (which are deterministic and remain on) and critical-result workflows function exactly as before.

## 15. Enhancements / Later phases
- **Local calibration**: threshold tuning per site (a vendor's operating point tuned on Western data may over-flag on
  a trauma-heavy Indian ER population) — with the vendor's blessing and documented in the model card.
- **Longitudinal lesion tracking** (nodule, tumour size across priors) with RECIST-style measurement assistance —
  measurement only, never response classification.
- **Structured report auto-population** from vendor SR output into the OP-008 template fields (currently quoted text).
- **Peer-review sampling automation** (RADPEER-style) using AI-disagreement as one sampling stratum.
- **Tele-radiology routing intelligence**: send flagged criticals to the available sub-specialist first (EN-008
  tele-radiology).
- **Protocol optimisation**: recommend the right protocol/sequence from the indication (technologist decision support,
  with the radiologist as approver).
- **Trauma pan-scan prioritisation** integrated with TR-007 polytrauma coordination.
- **Bone-age, cardiothoracic ratio and other quantitative aids** where a cleared engine exists — measurement only.

## 16. Open Questions for the Hospital
1. Which imaging AI vendors, if any, does the hospital already use or intend to procure, and can they provide their
   **CDSCO licence / CE-MDR / FDA clearance** documents for the registry?
2. Which study types are the priority — CT head triage, chest X-ray, fracture detection, TB screening — and what is
   the daily volume for each (this determines whether the licence cost is justified)?
3. Will engines be deployed on-premises, in the hospital's cloud, or as a vendor cloud service? If vendor cloud, has
   the DPA and the DICOM de-identification profile been agreed?
4. Who is the radiology lead who owns engine enablement, local performance review and the discrepancy register?
5. Is the radiology team willing to record agree/disagree verdicts on flags (a few seconds per flagged study), given
   that all local monitoring depends on it?
6. What is the current reporting TAT baseline by modality and priority, so the improvement claim can be measured
   rather than asserted?
7. Does the hospital accept that the **impression is never AI-generated** — and is there any pressure (from
   management or a vendor) to go further that we should document a position on now?
8. What is the hospital's protocol DRL table for dose outlier checks, and does Biomedical already track repeat rates?
9. How should unread AI-flagged critical studies escalate out of hours, and to whom?
10. Are there tele-radiology partners whose reads should also be marked `ai_influenced`, and does their contract
    permit AI-assisted reading?
11. What image and report retention applies, and how long must the AI audit trail (jobs, findings, overlays) be kept
    for medico-legal defence?
12. Does the hospital perform obstetric ultrasound, and is the PC-PNDT exclusion documented in its own compliance
    register so the platform-level block is visibly aligned with hospital policy?
