# OP-036 — Second Opinion (Case bundling, Expert panel & routing, Report/record upload, Secure communication, Opinion report, Payments & SLA)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical / Patient Engagement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Module ID       | OP-036                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Phase           | 10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Depends on      | **OP-025 §0 (shared specialty console framework — worklist, attachments, print, permissions pattern)**, OP-002 (case summary source; opinion becomes a clinical document), OP-022 (report/image upload viewer, DICOM ingest via EN-008 for external CDs), OP-018 (optional video discussion with expert), OP-021 (referral engine, external doctor directory), PE-001/OP-020 (patient request & upload portal), EN-012 (website widget: "Get a second opinion"), EN-010 (online payment/links), OP-005 (billing/receipts, GST), NC-034 (expert payout), EN-028 (consent for record sharing, DPDP purpose-limited), EN-011 (ABDM consent-based fetch of records via HIU M3), EN-016 (e-sign of opinion), EN-009/EN-032 (notifications), EN-038 (SLA/escalation), NC-003 (MRD record retrieval), OP-031 (tumour board as expert panel), AI-003 (document extraction later), EN-024 (audit) |
| Feature flag    | `module.second_opinion.enabled` (sub: `so.external_experts`, `so.panel_review`, `so.video_discussion`, `so.international`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Primary roles   | Second-opinion coordinator (24/25 family: `so_coordinator`), Expert consultant (6/9/12/13 — internal), External expert (15/63 family: `so_external_expert` portal), Patient / representative (59/60)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Secondary roles | Referring/treating doctor (15), Billing (27), MRD (43), Medical Superintendent (4, panel governance), Privacy Officer (57), Marketing (55, service promotion)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Regulatory      | Telemedicine Practice Guidelines 2020 (opinions without physical exam; RMP identity display; no Schedule X Rx), NMC Code of Ethics (second opinion is patient's right; no disparagement), DPDP Act/Rules 2025 (purpose-limited consent for sharing records with external experts; cross-border transfer rules for `so.international`), ABDM consent framework (HIU), IT Act e-sign, GST on services (18 % on paid opinions), Consumer Protection Act (service SLA & refunds), NABH (documentation)                                                                                                                                                                                                                                                                                                                                                                                       |

## 1. Purpose

OP-036 lets a patient (or treating doctor) request an expert second opinion: the coordinator **bundles the case** (structured summary auto-drafted from the HMS record + uploaded external reports/images/discharge summaries), routes it to an **expert or panel** by specialty/sub-specialty with SLA and fee, the expert reviews in a secure viewer, asks clarifications via threaded messages (optionally video), and issues a **signed opinion report** (findings, agreement/disagreement with current plan, recommendations, further tests, urgency); the patient/treating doctor receives it in the portal with e-sign, payment and feedback captured. Supports internal experts, empanelled external experts (portal), multi-expert panels (e.g. tumour board OP-031), and international opinions with cross-border consent. Framework behaviours per OP-025 §0 (worklist, attachments, print, permissions).

## 2. Users & Jobs-to-be-done

- **Patient/family** (phone/web PE-001, EN-012 widget): request opinion, choose specialty/expert or "best available", upload reports (PDF/JPG/DICOM CD), consent, pay, chat clarifications, receive report, book consultation/procedure if desired, rate.
- **Coordinator** (desktop; 20–60 cases/day enterprise): verify identity & consent, curate bundle (dedupe, label documents, ensure quality), auto-generate case summary, choose expert/panel, set SLA/fee, chase experts, handle clarifications, close & bill.
- **Expert** (desktop/tablet; internal or external portal): review bundle (viewer with DICOM/OHIF, labs trend), ask questions, dictate/write opinion using template, sign, log time; see payouts.
- **Treating doctor**: request on patient's behalf, view opinion, respond/accept, integrate into plan (OP-002 note).
- **MS/HOD**: manage expert panel, quality audit of opinions, disputes.

## 3. Core Workflows

### 3.1 Request & bundling

1. Request via portal/widget/coordinator/doctor order (`order.second_opinion`) → capture: question(s) for expert, specialty, current diagnosis/plan, urgency (routine ≤ 5 days / priority ≤ 48 h / urgent ≤ 24 h), preferred expert/language, whether existing HMS patient (UHID) or new (create patient OP-001 minimal) → **consent** (EN-028: purpose "second opinion", recipient class internal/external/international, retention, revocation) → fee quote (specialty/expert/panel/urgency; RC-003 tariff item `SECOND_OPINION_*`) → payment link (EN-010) or corporate/insurance flag → case status `bundling`.
2. **Bundle builder**: coordinator pulls from HMS (with consent): demographics (minimal), problem list, key encounters/discharge summaries, labs (trend tables), imaging (PACS studies → shared study links or DICOM export), pathology, medications, allergies; ABDM HIU fetch of outside records (EN-011) if patient links ABHA; patient uploads (OP-022 uploader; DICOM CD ingest → Orthanc EN-008 as external study), OCR/labels (AI-003 later); dedupe/quality flags (blurry, missing pages) → **structured case summary** auto-drafted (template EN-039: HPI, timeline, investigations table, treatment so far, specific questions) → coordinator edits → bundle version 1 frozen (hash) → `so.case.bundled`.

### 3.2 Routing & panel

- Expert directory: internal consultants (from HR/OP-001 doctor master with sub-specialties, opinion fee, SLA capacity, languages) & external empanelled experts (`so.external_experts`: KYC, registration no. NMC/state, specialty proof, agreement, payout terms NC-034, portal login) → coordinator or auto-routing (round-robin by specialty, load, rating; patient's choice honoured) → expert accepts/declines (24 h) → SLA timer (EN-038) → panel mode (`so.panel_review`: 2–5 experts independent opinions or chaired panel with consolidated report; tumour board OP-031 integration) → conflict-of-interest declaration (expert previously treated patient) → `so.case.assigned`.

### 3.3 Expert review & clarifications

- Expert workspace: summary, documents (tabbed viewer, PDF/image/DICOM OHIF), labs trends, timeline; **clarification thread** (secure messages to coordinator/patient/treating doctor; attachments; read receipts; SLA pause while awaiting patient) ; optional video call (OP-018 session, recorded with consent) → expert writes **opinion** in template: summary of case as understood, assessment (agree/partially/disagree with diagnosis; with plan), recommendations (tests, treatment options with pros/cons, urgency), red flags, limitations (no physical exam), suggested follow-up; e-sign (EN-016) with RMP registration number displayed → **opinion report PDF** (letterhead, disclaimer per Telemedicine guidelines) → `so.opinion.signed`.

### 3.4 Delivery, action & closure

- Report to patient portal/app + treating doctor (if requester/consented) with notification; patient may request clarification (1 round included, config), rate & feedback (EN-030); treating doctor documents response in OP-002 (accept/decline recommendations); optional conversion: book appointment/admission/procedure with the expert (OP-001/IP-001) — tracked as conversion; billing finalisation (OP-005 receipt/GST invoice; refunds if SLA breached per policy), expert payout accrual (NC-034); case closed & archived; consent expiry → external access revoked; retention per policy.

### 3.5 Exceptions

- Payment failed → hold; expert declines/no response → auto-reassign & notify; bundle incomplete → patient task with reminders; urgent red flag identified by expert (e.g. missed critical finding) → immediate alert to treating doctor/coordinator + advise ER; consent revoked mid-case → access cut, partial refund rule; dispute → MS review; international expert (`so.international`) → cross-border transfer consent & de-identification option (remove direct identifiers, keep age/sex).

## 4. Data Model (schema `engage` / `clinical` for opinion doc)

- **so_cases**: id, hospital_id, branch_id, case_no (numbering `SO_CASE`), patient_id, requester_type enum(patient/representative/treating_doctor/corporate), requester_user_id, specialty_id, sub_specialty, questions jsonb, urgency enum(routine/priority/urgent), status enum(requested/awaiting_payment/bundling/ready/assigned/in_review/clarification/opinion_signed/delivered/closed/cancelled/refunded), consent_id, consent_scope enum(internal/external/international), deidentified bool, fee numeric(12,2), currency, payment_status, bill_id, sla_due_at, sla_paused_ms, expert_ids uuid[], panel_mode enum(single/independent/chaired), rating smallint?, feedback_id?, closed_at; index (hospital_id, status, sla_due_at), (patient_id).
- **so_bundles**: id, case_id, version, summary_doc_id (EN-039 response), items jsonb ([{type (discharge_summary/lab/imaging/pathology/rx/upload/abdm), ref_id, s3_key?, study_uid?, label, source, page_count, quality_flags[]}]), frozen_at, sha256, by; unique (case_id, version).
- **so_uploads**: id, case_id, uploaded_by, kind, s3_key (encrypted), mime, size, ocr_text? (tsvector), dicom_ingest_status, virus_scan_status, created_at.
- **so_experts**: id, hospital_id, user_id?/external_profile_id, type enum(internal/external), specialties text[], languages text[], fee_default, sla_capacity_per_week, active bool, rating_avg, kyc jsonb (reg_no, council, documents), agreement_doc_id, payout_terms jsonb (NC-034), conflict_flags jsonb.
- **so_assignments**: id, case_id, expert_id, role enum(primary/panel/chair), assigned_at, accepted_at?, declined_reason?, due_at, coi_declared bool, status enum(pending/accepted/declined/completed/reassigned).
- **so_messages** (thread): id, case_id, from_party enum(patient/coordinator/expert/treating_doctor), to_parties text[], body (encrypted), attachments uuid[], read_by jsonb, at; index (case_id, at).
- **so_opinions**: id, case_id, assignment_id, template_key, content jsonb (structured sections), agreement enum(agree/partial/disagree/insufficient_info), red_flag bool, urgency_advice enum, doc_id (clinical.documents, signed/hash), esign_ref, signed_at, time_spent_min, consolidated bool (panel).
- **so_video_sessions**: case_id, op18_session_id, at, recorded bool.
- **so_sla_events**, **so_payouts** (accruals to NC-034), **so_conversions** (appointment/admission ids).
- Enums: `so_status`, `so_urgency`, `so_consent_scope`, `so_agreement`.

## 5. Business Rules & Validations

- Consent (purpose-limited) mandatory before any record is attached; external/international scope requires explicit scope; revocation cuts external access immediately (signed URLs expire ≤ 15 min; access re-validated).
- Bundle frozen (hash) before assignment; additions create version 2 & notify expert.
- Payment before assignment (except corporate/credit or hospital-waived with approval EN-038); GST 18 % on fee; SLA breach → auto partial refund per policy (config) or waiver record.
- Expert must accept within 24 h else auto-reassignment; COI declaration required; expert cannot be the treating doctor of the same episode (block) unless panel chair permits.
- Opinion must include limitations disclaimer & RMP reg no.; no prescriptions of Schedule X; opinion is advisory — treating doctor decision documented separately (OP-002).
- Red flag in opinion → notification to treating doctor/coordinator within 5 min; urgent advice → patient told to seek emergency care (template).
- Panel: independent opinions hidden from each other until all signed (config); consolidated report by chair.
- De-identification for international: remove name/UHID/phone/address/photos faces (manual check), keep age/sex; audit.
- Every access to bundle by expert logged (READ_PHI); downloads watermarked with expert name & timestamp; printing optional per policy.
- Numbering `SO_CASE`; opinion documents immutable/signed; retention per clinical policy; messages retained with case.

## 6. API Surface (`/api/v1/second-opinion`)

| Method         | Path                                                                      | Purpose              | Permission                       | Idem    | Pag                                        |
| -------------- | ------------------------------------------------------------------------- | -------------------- | -------------------------------- | ------- | ------------------------------------------ |
| POST           | /public/requests (widget/portal), POST /cases                             | create request       | public token / so.case.create    | Y       | –                                          |
| GET            | /cases?status=&sla=                                                       | coordinator worklist | so.case.read                     | –       | cursor                                     |
| POST/PATCH     | /cases/{id}/consent, /payment-link                                        | consent & pay        | so.case.manage                   | Y       | –                                          |
| POST           | /cases/{id}/uploads (resumable), /cases/{id}/bundle/items, /bundle/freeze | bundling             | so.bundle.manage / patient scope | Y       | –                                          |
| POST           | /cases/{id}/summary/draft                                                 | auto-draft summary   | so.bundle.manage                 | Y       | –                                          |
| GET/POST/PATCH | /experts, /experts/{id}                                                   | expert directory     | so.expert.manage                 | Y       | cursor                                     |
| POST           | /cases/{id}/assign, /assignments/{id}/accept                              | decline              | reassign                         | routing | so.case.assign / so.opinion.write (accept) | Y   | –   |
| GET            | /expert/cases, /expert/cases/{id}/bundle (signed URLs)                    | expert workspace     | so.opinion.write                 | –       | cursor                                     |
| POST/GET       | /cases/{id}/messages                                                      | thread               | so.message.send/read (parties)   | Y       | cursor                                     |
| POST/PUT       | /cases/{id}/opinions, /opinions/{id}/sign                                 | opinion              | so.opinion.write/sign            | Y       | –                                          |
| POST           | /cases/{id}/deliver, /close, /refund                                      | closure              | so.case.manage / so.case.refund  | Y       | –                                          |
| GET            | /patient/cases/{id}/report.pdf                                            | patient view         | patient scope                    | –       | –                                          |
| GET            | /reports/kpis, /reports/payouts                                           | analytics            | so.report.read                   | –       | –                                          |

## 7. Domain Events (outbox)

- `so.case.requested|paid|bundled|assigned|accepted|declined|clarification_requested|opinion_signed|delivered|closed|cancelled|refunded`, `so.sla.warning|breached` (EN-038), `so.opinion.red_flag` → treating doctor/coordinator, `so.consent.revoked` → access revocation, `so.payout.accrued` (NC-034), `so.conversion.recorded`.
- Consumes: `payment.received` (EN-010), `consent.revoked` (EN-028), `abdm.records.fetched` (EN-011), `op18.session.ended`, `feedback.received` (EN-030), `bill.finalized`.

## 8. Screens (UI)

1. **Patient request wizard** (phone/web): specialty → questions → uploads (camera/PDF/DICOM CD via desktop) → consent (scope explained) → pay → tracker with SLA & messages; report view/download; rate.
2. **Coordinator console** (desktop): kanban by status with SLA timers, case drawer (bundle checklist, quality flags, summary editor, expert picker with load/rating), payment/consent chips; `Ctrl+K` search.
3. **Expert workspace** (desktop/tablet; portal for external): case list with due times, split view (summary | documents viewer tabs incl. OHIF), labs trend table, thread panel, opinion editor with template & macros, time tracker, e-sign; watermark banner.
4. **Panel view** (chair): member opinions status, consolidated editor.
5. **Treating doctor view** (in OP-002 timeline): opinion card, respond action.
6. **Admin**: expert directory/KYC/fees/agreements, tariff, SLA & refund policy, templates.

- Empty/error: uploads failed virus scan → rejected with message; consent scope mismatch banner.

## 9. Integrations

- OP-022/EN-008 (uploads, DICOM CD ingest, OHIF share links), EN-011 ABDM HIU consent fetch, EN-010 payments/links & refunds, EN-016 e-sign, OP-018 video, EN-009/EN-032 notifications, EN-038 SLA engine, NC-034 payouts, EN-012 website widget, EN-030 feedback, AI-003 (OCR/summary drafting later), external expert SSO/portal (EN-025 optional), antivirus scanning service for uploads.

## 10. Reports & Analytics

- Volumes by specialty/urgency, TAT vs SLA, expert acceptance/decline & turnaround, agreement distribution (agree/partial/disagree), red-flag rate, conversion to treatment (appointments/admissions/procedures & revenue), revenue & payouts, refunds, patient ratings, consent scope mix, international share, bundle quality (missing docs rate). Read model `analytics.second_opinion_monthly`.

## 11. Notifications

- Patient: request received, payment link, missing documents, expert assigned, clarification asked, opinion ready, feedback request, consent expiry. Expert: new case, SLA reminders (50 %/80 %/breach), clarification answered, payout statement. Coordinator/treating doctor: red flag, SLA warnings, expert declines, delivered.

## 12. Permissions (RBAC keys)

`so.case.create|read|manage|assign|refund`, `so.bundle.manage`, `so.expert.manage`, `so.opinion.write|sign|read`, `so.message.send|read`, `so.report.read`, `so.configure`, plus patient portal scope `so.own`. Defaults: Coordinator — case.*, bundle.manage, message; Expert (internal) — opinion.write/sign, message, read assigned bundles only; External expert — same via portal, no directory; Treating doctor — case.create (for own patients), opinion.read; MS — expert.manage, report; Billing — refund; Patient — own.

## 13. Non-functional

- Volumes: 60 cases/day enterprise, uploads avg 40 MB (DICOM CDs up to 2 GB via desktop ingest); signed URL TTL 15 min; expert viewer loads bundle index < 1 s; all PHI access logged; encryption at rest; watermarking in worker; SLA timers accurate to minute; portal WCAG 2.2 AA; i18n patient wizard (regional + English); international: data-residency flag per tenant.

## 14. Acceptance Criteria

1. Given a patient submits a request with uploads and consent scope "internal", when the coordinator tries to assign an external expert, then assignment is blocked until consent scope is upgraded by the patient.
2. Given a bundle frozen (v1) and assigned, when the coordinator adds a new report, then bundle v2 is created with hash and the expert is notified of the update.
3. Given payment not received, then the case remains `awaiting_payment` and cannot be assigned unless a waiver approval exists.
4. Given an expert does not accept in 24 h, then the case auto-reassigns to the next expert by routing rule and the coordinator is notified.
5. Given the expert signs an opinion flagged red-flag/urgent, then the treating doctor and coordinator are alerted within 5 min and the patient receives emergency-care advice template.
6. Given the opinion PDF, then it includes RMP registration number, limitations disclaimer, e-sign, and appears in the patient portal and OP-002 timeline.
7. Given SLA of 48 h breached by 6 h, then an SLA breach event triggers the configured partial refund/credit note and analytics record.
8. Given consent revoked mid-review, then external expert access returns 403 within 1 minute and the case moves to cancelled/refund workflow.
9. Given a panel of 3 independent experts, then each cannot see the others' opinions until all sign; the chair consolidates.
10. Given an external expert downloads a document, then the PDF is watermarked with name/timestamp and a READ_PHI audit exists.
11. Given the treating doctor of the episode is chosen as expert, then the system blocks with COI message.
12. Given a de-identified international case, then exported bundle contains no name/UHID/phone and audit shows de-identification checklist completed.

## 15. Enhancements / Later phases

- Sheet row 77 (Case bundling, Expert panel, Report upload, Communication) — core. Market: paid opinion product with SLA/refunds, external expert portal, ABDM fetch, conversion tracking.
- Later: AI-003 auto-summary & document classification, AI-002 opinion quality checks, marketplace listing on website (EN-012), insurer-sponsored second opinions (RC-001), international expert network integrations, multilingual translation of reports.

## 16. Open Questions for the Hospital

1. Is second opinion a paid service? Fees by specialty/urgency; refund/SLA policy; corporate/insurer flows?
2. External experts panel & agreements/payout terms; international experts and data-residency stance?
3. Who coordinates (call centre/MRD/dedicated)? Volumes expected?
4. Templates & disclaimer wording (legal review); panel/tumour-board integration?
5. Website widget & patient app entry points; languages?
