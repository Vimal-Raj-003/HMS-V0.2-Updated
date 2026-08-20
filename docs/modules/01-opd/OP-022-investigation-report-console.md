# OP-022 — Packages / Investigation Report Console (Orders worklist, Image upload/viewer, Templated reports, Co-sign, Patient access)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Module ID       | OP-022                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase           | 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Priority        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Depends on      | OP-002 (orders), OP-008/EN-008 (RIS/PACS — OP-022 is the lightweight non-DICOM/generic investigation console that complements them), OP-004 (LIS — non-numeric investigations like histopath images/ECG/PFT reports may use this console's templates), OP-029 (ECG/Echo/TMT/Holter), OP-030 (PFT/sleep study/bronchoscopy), OP-028 (audiometry/endoscopy), OP-025 (fundus/OCT), OP-026 (dental X-ray), OP-027 (derm photos), OP-024 (fertility USG/embryo images), OP-010 (procedure media), EN-039 (report templates), EN-016 (e-sign), EN-013 (barcode), EN-006 (priority queue), NC-020 (equipment downtime), EN-009 (prep SMS/report links), PE-001/OP-020 (patient portal access), OP-005 (billing/report release rules), EN-011 (ABDM DiagnosticReport), NC-003 (MRD), EN-024 (audit), OP-014 (health check-up consolidation), OP-021 (external referrer report delivery), EN-005 (printing) |
| Feature flag    | `module.investigation_console.enabled` (sub: `invest.dicom_lite_viewer`, `invest.cosign`, `invest.fast_track`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Primary roles   | Technician (radiology/cardiology/pulmonology/ENT/ophthalmology techs — 36 and specialty techs), Reporting doctor (Radiologist 12 / Cardiologist / Pulmonologist / specialty consultants 6), Resident (14, co-sign)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Secondary roles | Receptionist (24, scheduling/prep), Ordering doctor (6), Biomedical (48), Billing (27), MRD (43), Patient (portal), Quality (54: TAT, co-sign compliance), Auditor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Regulatory      | NABH 5th ed. (diagnostic reporting: authorised signatories, TAT, critical result communication, report amendments), NABL ISO 15189 (where the investigation is under lab scope), PC-PNDT (USG reports: mandatory fields Form F, no sex disclosure — for USG reports through this console), AERB (radiation investigations dose logging via OP-008), DPDP (images = PHI; consent for clinical photos), IT Act (e-sign), CDSCO device UDI for imaging devices (NC-020), Clinical Establishments Act (record retention: images/reports ≥ 3–10 y per policy)                                                                                                                                                                                                                                                                                                                                           |

## 1. Purpose

OP-022 provides a generic **investigation worklist → capture → report → sign → deliver** console for every diagnostic service that does not (or not yet) run through full RIS/PACS or LIS analyzers: non-DICOM imaging (older USG machines, endoscopy stills, fundus/OCT/slit-lamp photos, dental X-rays via sensors, dermatoscopy, clinical photos), ECG/TMT/Holter/Echo PDFs, PFT/spirometry, audiometry, EEG/NCV, biopsy/histopath gross photos, procedure images; with priority queues, patient prep messaging, upload of DICOM/JPEG/PNG/PDF/video to cloud storage, a browser viewer (zoom/pan/window-level for DICOM-lite; annotations), templated structured reports (drop-downs + free text) with auto-formatting, resident→consultant co-signing, report versions/addenda, TAT dashboards, equipment-downtime awareness and patient portal access to reports and images.

## 2. Users & Jobs-to-be-done

- **Technician** (desktop/tablet at modality; 50–150 studies/day/station): pick next order (priority), verify patient (scan), acquire/upload images or PDF from device (drag-drop/watch-folder/capture card), enter technical notes/measurements, mark done → moves to reporting queue.
- **Reporting doctor** (desktop dual-monitor or laptop; 40–120 reports/day): open worklist (unreported, urgent first), view images/PDF, dictate/type using template (structured picks + free text, macros), compare priors, sign (e-sign), handle critical findings, addenda.
- **Resident**: drafts report → sends for co-sign; consultant approves/edits/signs; discrepancy log.
- **Receptionist**: schedule investigations needing slots (TMT/Echo/EEG), send prep SMS (fasting/full bladder/stop meds), reschedule when equipment down.
- **Ordering doctor**: sees status (ordered → scheduled → done → reported), gets report/critical alerts.
- **Patient**: portal report PDF & image viewer link.

## 3. Core Workflows

### 3.1 Order intake & worklist

1. `order.created` (OP-002/IP/ER/health-check) for investigation mapped to console (service catalogue flag `console=investigation`) → appears on **worklist** per service/modality/branch with priority (STAT/urgent/routine, ER/ICU flags, health-check batch, VIP), age of order, prep status, payment/pre-auth status (OP-005/EN-002), scheduled slot if applicable (OP-001 resource calendar for TMT/Echo/EEG/PFT rooms).
2. **Prep SMS/WhatsApp** (EN-009 templates by investigation: fasting for USG abdomen, full bladder pelvis, hold beta-blocker for TMT, no caffeine, bring old reports) sent at scheduling/D-1.
3. **Priority queue** (EN-006 kind `investigation`) with **fast-track pathway** (`invest.fast_track`): STAT orders (ER/ICU/critical) auto-top with red banner, TAT target (e.g. ECG 10 min, USG 60 min, TMT report 4 h), escalation to HOD on breach.
4. Equipment status (NC-020): device under breakdown/PM → worklist banner, orders re-routed to alternate device/branch or rescheduled; patients notified.

### 3.2 Capture & upload

1. Technician scans patient/order barcode (EN-013) → identity check → status `in_progress`; capture options: (a) **upload** files (DICOM .dcm/zip, JPEG/PNG, PDF from device software (ECG/PFT/audiometry exports), MP4 (endoscopy/echo clips)) via drag-drop or presigned multipart; (b) **watch-folder agent** (Windows/Linux service watching device export folders, maps by accession/order barcode in filename or manual match); (c) **capture card/webcam** (EN-042: HDMI/USB capture → browser getUserMedia); (d) DICOM sent to Orthanc (EN-008) auto-linked by accession — console shows the study; (e) structured **measurements** entry (e.g. ECG intervals, PFT FEV1/FVC, audiogram thresholds, USG biometry) via EN-039 forms; technician notes; image QC (repeat flag).
2. Files stored S3 (encrypted, hospital/patient/order path with opaque keys), thumbnails & video transcodes generated by worker; **DICOM-lite viewer** (`invest.dicom_lite_viewer`: cornerstone-based zoom/pan/window-level/measure/annotate/cine; full OHIF via EN-008 for DICOM studies); PDF viewer; before/after compare; annotations saved separately (JSON) never altering originals.
3. Mark **done** → status `awaiting_report` → reporting queue; auto-notify reporting doctor for STAT.

### 3.3 Reporting

1. Doctor opens study: viewer left/top, report editor right/bottom; **template** auto-selected by investigation (EN-039: sections e.g. Technique, Findings (structured drop-downs/pick-lists with normal defaults e.g. "Liver: normal size & echotexture"), Measurements (auto from technician form), Impression, Recommendation), macros/phrases (`\` trigger), voice dictation (AI-004 later; browser STT interim), prior report/images side-by-side (same investigation), auto-formatted PDF preview; **critical finding** flag → mandatory notify ordering doctor (call/push, ack tracking, EN-037) and documented read-back; PC-PNDT fields enforced for obstetric USG templates (Form F link, no sex text validation).
2. **Co-sign** (`invest.cosign`): resident saves `draft_for_cosign` → consultant queue → approve as-is / edit (tracked changes shown) / return with comments; discrepancy classification (none/minor/major) for teaching QA; final sign by consultant.
3. **Sign** (`Ctrl+Enter`, EN-016 e-sign/DSC optional) → PDF generated with signatory credentials & registration no., QR verify code → status `final` → Events `investigation.report.final` → delivery (portal/app, WhatsApp link, print/auto-print EN-005, ordering doctor inbox, ABDM DiagnosticReport), billing release rules (report withheld until payment if policy).
4. **Amend**: addendum/corrected report versions with reason; original preserved; recipients re-notified.

### 3.4 Patient access

- Portal/app (PE-001/OP-020): report PDF + **image viewer link** (time-limited presigned; DICOM download optional; JPEG gallery), share with external doctor (consented link/ABDM); status tracking ("images uploaded, report awaited").

### 3.5 Exceptions

- Wrong patient upload → move/detach with reason (audit); poor-quality repeat (dose logged for radiation via OP-008); equipment down → reschedule; unpaid → policy hold; report unsigned > TAT → escalation; offline (technician tablet) → local capture queue (uploads resume); doctor offline → cannot sign (draft cached).

## 4. Data Model (schema `clinical` / `rad` shared)

- **investigation_services** (mdm flag on service catalogue): service_id, console enum(investigation/ris/lis), modality_group enum(usg_non_dicom/ecg/tmt/echo/holter/pft/audiometry/eeg/ncv/endoscopy/fundus/oct/dental_xray/derm/photo/other), template_id (EN-039), prep_template_id, tat_minutes_report, requires_slot bool, resource_type_id?, cosign_required bool, pcpndt bool, radiation bool.
- **investigation_worklist** (read model over orders): order_id, hospital_id, branch_id, patient_id, service_id, priority, status enum(ordered/scheduled/checked_in/in_progress/awaiting_report/draft/draft_for_cosign/final/amended/cancelled), scheduled_at, device_id?, technician_id?, reporter_id?, tat_due_at, payment_status, preauth_status; index (hospital_id, branch_id, status, priority, created_at).
- **investigation_studies**: id, hospital_id, order_id, patient_id, accession_no (series `ACC` shared with OP-008), device_id (NC-020), performed_at, technician_id, technique_notes, measurements_form_response_id?, repeat_flag, qc_notes, status; index (order_id), (accession_no).
- **investigation_media**: id, study_id, patient_id, kind enum(dicom/jpeg/png/pdf/video/other), s3_key, thumb_key, transcode_key?, sop_uid?, orthanc_study_id?, size, mime, uploaded_by, uploaded_at, source enum(upload/watch_folder/capture/dicom), sequence_no, deleted_at?, detach_reason?; index (study_id).
- **investigation_annotations**: media_id, by, at, data jsonb (shapes/measurements), version.
- **investigation_reports**: id, study_id, order_id, patient_id, template_id, version, status enum(draft/draft_for_cosign/final/amended/cancelled), body jsonb (structured sections), impression, critical bool, critical_notified jsonb ({to, at, method, ack_at}), author_id, cosigner_id?, cosign_changes jsonb?, discrepancy enum(none/minor/major)?, signed_by, signed_at, esign_ref?, pdf_key, sha256, prev_sha256, amend_reason, document_id (clinical.documents); index (order_id, version desc), (hospital_id, status, tat_due_at).
- **investigation_report_deliveries**: report_id, channel enum(portal/whatsapp/email/print/abdm/referrer), recipient, at, status.
- **investigation_prep_messages**: order_id, template_id, sent_at, channel, status.
- **watch_folder_agents**: id, branch_id, device_id, host, folder, last_seen_at, mapping_rule jsonb.
- Read models: `analytics.investigation_tat_daily`, `analytics.investigation_cosign_qa`.

## 5. Business Rules & Validations

- Identity verification (scan/2-identifier) before capture; media always linked to an order/study; orphan uploads quarantined for matching (24 h) then flagged.
- Originals immutable; annotations separate; detach/move requires reason & audit; deletion soft only.
- Report sign requires: at least one media or measurements (config per service), template mandatory sections filled, PC-PNDT fields for flagged services (Form F ref, indication, no sex-related text — regex/keyword validator with override by authorised doctor & reason), critical flag → notification recorded before final (or within 15 min after with ack).
- Co-sign: residents cannot finalise services with `cosign_required`; consultant edits tracked; discrepancy recorded; co-sign SLA (default 4 h STAT / 24 h routine) with escalation.
- TAT clock: order→done, done→final; STAT thresholds per service; breaches escalate.
- Signed report immutable; amendments version with reason; PDF carries version & QR verification (public verify shows minimal metadata + hash).
- Report release to portal per hospital policy (immediate/after payment/after ordering doctor review for sensitive results, e.g. oncology biopsy) — configurable; critical results never auto-released before doctor communication.
- Media retention ≥ policy (default images 5 y for non-DICOM, reports 10 y; DICOM per EN-008); presigned URLs ≤ 5 min; export watermark & audit.
- Numbering: accession `ACC` shared with OP-008; report no. `INV_RPT`.
- Radiation investigations (dental X-ray, fluoro stills) log dose via OP-008 dose register.

## 6. API Surface (`/api/v1/investigations`)

| Method      | Path                                                           | Purpose                                 | Permission                                                        | Idem      | Pag               |
| ----------- | -------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------- | --------- | ----------------- |
| GET         | /worklist?service=&modality=&status=&priority=&branch=         | technician/reporting worklists (socket) | invest.worklist.read                                              | –         | cursor            |
| POST        | /orders/{id}/schedule, /prep-message, /reschedule              | scheduling & prep                       | invest.schedule.manage                                            | Y         | –                 |
| POST        | /orders/{id}/check-in, /start (creates study), /done           | technician lifecycle                    | invest.study.manage                                               | Y         | –                 |
| POST        | /studies/{id}/media (multipart / presigned init+complete)      | upload                                  | invest.media.create                                               | Y         | –                 |
| POST        | /agents/watch-folder/ingest (agent token)                      | agent uploads with mapping              | integration.invest.ingest                                         | Y         | –                 |
| GET         | /media/{id}/url?variant=thumb                                  | full                                    | transcode                                                         | presigned | invest.media.read | –   | –   |
| POST/DELETE | /media/{id}/detach (reason), /media/{id}/annotations           | manage/annotate                         | invest.media.manage / invest.media.annotate                       | Y         | –                 |
| PUT         | /studies/{id}/measurements                                     | structured technician form              | invest.study.manage                                               | Y         | –                 |
| GET         | /studies/{id}/priors                                           | prior studies/reports same service      | invest.report.read                                                | –         | –                 |
| POST        | /studies/{id}/reports (draft), PUT /reports/{id}               | draft/edit                              | invest.report.create/update                                       | Y         | –                 |
| POST        | /reports/{id}/send-for-cosign, /cosign/approve, /cosign/return | co-sign                                 | invest.report.cosign (consultant)                                 | Y         | –                 |
| POST        | /reports/{id}/sign, /amend, /critical-notify, /critical-ack    | finalise/critical                       | invest.report.sign / invest.report.amend / invest.report.critical | Y         | –                 |
| GET         | /reports/{id}/pdf, GET /public/verify/{code}                   | outputs                                 | invest.report.read / public                                       | –         | –                 |
| POST        | /reports/{id}/deliver (channels)                               | delivery                                | invest.report.deliver                                             | Y         | –                 |
| GET         | /patients/{id}/investigations                                  | timeline (doctor/portal scope)          | invest.report.read / patient scope                                | –         | cursor            |
| GET/PUT     | /config/services, /templates, /agents                          | config                                  | invest.configure                                                  | Y         | –                 |
| GET         | /stats/tat, /stats/cosign-qa, /stats/dashboard                 | analytics                               | invest.report.read (analytics)                                    | –         | –                 |

## 7. Domain Events (outbox)

- `investigation.scheduled|checked_in|started|done` {order_id, study_id, priority} → OP-002 order status, OP-014 station board, EN-006, EN-009 prep; `investigation.media.added|detached`; `investigation.report.draft|cosign.requested|cosign.approved|final|amended` {report_id, order_id, critical} → ordering doctor inbox, PE-001/OP-020, EN-011 DiagnosticReport, OP-005 (release/billing), NC-003, OP-021 (external referrer), OP-014 consolidation; `investigation.critical.flagged|acknowledged` → EN-037 escalation; `investigation.tat.breached` → HOD; `investigation.equipment.down` (from NC-020) → reschedule tasks.
- Consumes: `order.created|cancelled`, `payment.received`, `preauth.approved`, `asset.status.changed`, `dicom.study.received` (EN-008), `visit.checked_in`.

## 8. Screens (UI)

1. **Technician worklist** (desktop/tablet): priority-sorted cards (STAT red), scan-to-open (`F3`), device selector, status chips, prep sent indicator; real-time; empty state per modality.
2. **Capture/upload screen** (desktop/tablet): drop zone + progress (resumable), capture-card preview (`F10` snapshot, `F11` record), gallery with QC flags, measurements form (`Tab` navigation), notes; `Ctrl+D` done.
3. **Reporting workspace** (desktop, dual monitor aware): viewer (zoom/pan/WL/measure/annotate/cine; `←/→` images, `W` window presets, `C` compare priors) + report editor (structured pick-lists with normal defaults, `\` macros, `F2` next field, `Ctrl+Enter` sign, `Ctrl+Shift+C` critical); template switcher; prior report panel; co-sign banner with tracked changes.
4. **Co-sign queue** (consultant desktop/phone): drafts by resident, side-by-side diff, approve/return; discrepancy tags.
5. **Ordering doctor inbox** (in OP-002/OP-019): reports final/critical with ack.
6. **Reception scheduling** (desktop): resource calendar for slot-based investigations, prep message status, equipment-down reschedule wizard.
7. **Patient portal/app view** (PE-001/OP-020): report PDF, image gallery/viewer link, share.
8. **TAT & QA dashboard** (desktop dark): TAT by service/priority, breaches, co-sign discrepancy rates, unreported > SLA, equipment downtime impact.
9. **Public verify page**: QR → report hash/version/signatory (no PHI).

## 9. Integrations

- EN-008 Orthanc/OHIF for DICOM (auto-link by accession/MWL from OP-008), cornerstone.js viewer for DICOM-lite; watch-folder agent (Node/Electron service; also handles ECG PDF/XML exports e.g. GE MUSE/Schiller/BPL, PFT exports (Vyaire/COSMED CSV/PDF), audiometer exports, endoscopy tower stills via capture card), EN-042 capture; EN-039 templates; EN-016 e-sign; EN-009/EN-032 delivery; EN-011 ABDM DiagnosticReport (PDF + structured where available); NC-020 equipment status; OP-014 consolidation; OP-021 external delivery; EN-005 auto-print; S3/MinIO with lifecycle rules; worker transcodes (FFmpeg) & thumbnails (sharp).
- Failure handling: uploads resumable; agent buffers locally when offline; delivery retries; DICOM link retries.

## 10. Reports & Analytics

- Worklist volumes by service/priority, TAT (order→done, done→final, STAT compliance), unreported backlog, co-sign turnaround & discrepancy rates (QA/teaching), critical findings & ack times, amendments rate, equipment downtime & rescheduled studies, prep message compliance vs repeat/incomplete studies, report delivery channel stats, revenue linkage (OP-005), reporter productivity. Read models `analytics.investigation_tat_daily`, `analytics.investigation_cosign_qa`.

## 11. Notifications

- Patient: prep instructions (D-1 & scheduling), appointment/slot reminder, reschedule due to equipment, report ready link (after release policy), image link expiry notice.
- Staff: STAT order arrived (technician/reporter push), study awaiting report > threshold, co-sign pending, critical finding to ordering doctor (push + call escalation until ack), TAT breach (HOD), equipment down (reception/biomedical), watch-folder agent offline (IT), unmatched uploads (technician).

## 12. Permissions (RBAC keys)

`invest.worklist.read`, `invest.schedule.manage`, `invest.study.manage`, `invest.media.create|read|manage|annotate|export`, `invest.report.create|update|read|sign|cosign|amend|critical|deliver`, `invest.configure`, `invest.report.read` (analytics scope), plus `patient` portal scope for own reports. Defaults: Technician — worklist, study manage, media create/read/annotate; Reporting doctor — report create/update/sign/amend/critical/deliver, media read/manage; Resident — report create/update (no sign where cosign_required); Consultant — cosign; Reception — schedule; Ordering doctor — report read; MRD/Quality — read/analytics; Biomedical — none (NC-020); Patient — own.

## 13. Non-functional

- Volumes: 3000 investigations/day enterprise through console (ECG 1200, USG non-DICOM 400, PFT/audio/others), 5–50 MB per study (videos up to 500 MB); worklist p95 < 200 ms; upload throughput ≥ 20 MB/s LAN; thumbnail < 10 s; PDF sign < 3 s; viewer first image < 1.5 s (LAN) / < 3 s (4G thumbnails first).
- Offline: technician tablet capture queue (OPFS up to 1 GB), agent local buffer; reporting requires online for sign (drafts cached).
- Print: A4 report with images grid, thermal slip for accession barcode; auto-print rules (EN-005).
- Security: presigned URLs, encryption, watermark on export, READ_PHI audit outside care team, PC-PNDT validators, public verify without PHI.
- Accessibility/i18n: keyboard-first reporting, high-contrast viewer UI, templates multilingual (patient-facing impression translation optional).

## 14. Acceptance Criteria

1. Given a STAT ECG order from ER, then it tops the technician worklist with red banner within 2 s and TAT clock 10 min; breach at 10 min notifies HOD.
2. Given a technician scans a wrong patient's barcode for an order, then a mismatch hard-stop prevents capture.
3. Given a 30 MB PDF + 12 JPEGs uploaded for a USG study, then all appear with thumbnails within 10 s, originals immutable and annotations stored separately.
4. Given an obstetric USG template, when the report text contains "male/female/boy/girl" (or transliterations), then sign is blocked with PC-PNDT warning unless an authorised override with reason is entered; Form F reference is mandatory.
5. Given a resident drafts an Echo report on a service with cosign_required, then sign is disabled; the consultant sees it in the co-sign queue, edits (changes tracked), approves and signs; discrepancy "minor" is recorded.
6. Given a report flagged critical, then the ordering doctor receives push/call within 1 min and the report cannot go final until notification is recorded (or within 15 min after with ack).
7. Given a signed report, then the PDF shows signatory name/reg no./QR; verifying the QR shows hash/version only; an amendment creates v2 with reason and re-notifies recipients.
8. Given release policy = after payment, then an unpaid patient's portal shows "report ready — payment pending" and releases within 5 s of payment.
9. Given the DICOM study for the accession arrives at Orthanc, then the console links it automatically and offers OHIF launch.
10. Given TMT machine marked breakdown in NC-020, then today's TMT orders show a banner and reception gets a reschedule list; patients receive reschedule messages.
11. Given a watch-folder agent drops `ACC12345_ecg.pdf`, then it attaches to accession ACC12345 within 30 s; an unmatched file lands in quarantine list.
12. Given a technician offline for 20 min captured 6 studies, then uploads resume on reconnect with correct order links and no duplicates.
13. Given a user without `invest.report.sign`, then POST /sign returns 403 and audit.
14. Given a prior USG exists, when reporting, then the prior report and images are shown side-by-side and "compare" copies prior impression as reference text.

## 15. Enhancements / Later phases

- Sheet row 12 ("Packages" — actually investigation console) core: order worklist, priority queue, technician/radiologist capture & upload, templates, DICOM/JPEG/PDF viewer, patient portal access, status dashboard; enhancements: priority queue management (core), equipment maintenance-downtime alerts (Phase 9 NC-020 hook; banner in Phase 3), patient prep SMS (core), report co-signing resident→consultant (core flag), urgent investigation fast-track (core flag).
- Later: AI-007 abnormality prioritisation (ECG/X-ray), AI-004 dictation, structured data extraction from device PDFs (AI-003), FHIR DiagnosticReport/ImagingStudy (EN-019), tele-reporting marketplace, 3D/advanced viewers (EN-008), automatic ECG interpretation import (HL7 from carts), integration of measurement XML (ECG/PFT) to discrete data.
- (market) PCS Prodoc two-level authorisation & multi-template attachment; SmartHospital USG/ECG service queues with WhatsApp send; MocDoc report delivery — covered.

## 16. Open Questions for the Hospital

1. Which investigations will run through this console vs full RIS/PACS (OP-008/EN-008) or LIS at go-live? Device list with export capabilities (PDF/XML/DICOM)?
2. Co-sign policy per service (which residents, SLA)? Discrepancy QA programme?
3. Report release policy (immediate/after payment/after ordering doctor for sensitive)?
4. PC-PNDT: which USG rooms/machines registered; Form F process; authorised signatories?
5. Prep message templates & timing; slot-based investigations (TMT/Echo/EEG/PFT) capacities?
6. Retention for non-DICOM images/videos; watermark/export rules; patient image download allowed?
7. Auto-print rules (ECG at cart? reports at reception?).
