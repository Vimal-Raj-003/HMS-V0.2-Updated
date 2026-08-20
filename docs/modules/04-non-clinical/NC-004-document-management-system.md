# NC-004 — Document Management System (Versions, Approvals, OCR Search, Expiry, Templates)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Non-Clinical / ERP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Module ID       | NC-004                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Phase           | 9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Depends on      | EN-007 (users/roles/departments), EN-038 (approval workflow engine), EN-016 (e-sign/DSC), EN-039 (template builder & merge fields), EN-032/EN-037 (email/notifications), EN-024 (audit), NC-015 (SOP repository consumer, document control for NABH), NC-023 (licence documents & expiry), NC-031 (contracts), NC-021 (vendor documents), NC-010 (HR policies/circulars, employee documents), NC-003 (shares OCR/storage services; patient records are NOT stored in DMS), NC-014 (announcements/circulars on mobile), NC-011 |
| Feature flag    | `module.dms.enabled` (sub: `dms.esign`, `dms.ocr`, `dms.compliance_checker`)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Primary roles   | Quality Manager (54, SOP/document control), Hospital/Branch Admin (2/3), HR (47, policies), Legal/Compliance officer (NC-023), Department document controllers (HOD-delegated)                                                                                                                                                                                                                                                                                                                                                |
| Secondary roles | All staff (read published docs), Auditor (58), IT admin (56), Vendors (63, contract copies via portal)                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Regulatory      | NABH 6th ed. (document control: controlled copies, versioning, review cycles ≤ 3 yrs, master list, obsolete document control), ISO 9001/15189 document control, DPDP (employee documents), IT Act (e-sign validity), Companies Act (statutory registers retention 8 yrs), licences (AERB/PCB/Fire/Drugs/Clinical Establishment — tracked with NC-023)                                                                                                                                                                         |

## 1. Purpose

NC-004 is the controlled repository for **non-patient documents**: policies, SOPs, manuals, licences, contracts, circulars, forms, training material, committee minutes. It provides upload/scan with OCR full-text search, strict version control with diff and change log, department/role-based access, review-approve-publish workflow with e-sign, controlled-copy distribution and read acknowledgements, expiry/renewal alerts with auto-created tasks, template library with auto-fill, and a digital archive with retention. NC-015 (Quality) uses it as its SOP engine; NC-023/NC-031 use it for licences and contracts.

## 2. Users & Jobs-to-be-done

- **Document controller / Quality manager** (desktop): create document masters (code, owner, review cycle), route drafts for review/approval, publish controlled versions, distribute to departments, track acknowledgements, obsolete old versions, maintain master list for NABH assessment.
- **Authors (any department)** (desktop): draft from templates, upload new versions with change summary, respond to review comments.
- **Reviewers/approvers (HOD, MS, Admin)** (desktop/phone): approve/reject/request changes with e-sign.
- **All staff** (desktop/phone via NC-014): search & read published documents; acknowledge mandatory reads; bookmark.
- **Compliance/legal**: track licence & contract expiries; bulk renewals.
- **Auditor/NABH assessor**: view master list, version history, approval trail, obsolete copies.

## 3. Core Workflows

### 3.1 Create & upload

1. **Author** creates document: title, code (`DOC` series per category, e.g. `SOP/ICU/012`), category enum(policy/sop/manual/licence/contract/circular/form/training/minutes/report/certificate/other), department, owner, confidentiality (public-internal/department/restricted/confidential), review cycle (months), effective date, related standards (NABH chapter/objective element tags), keywords → uploads file (PDF/DOCX/XLSX/images; max 100 MB) or authors in rich text from template (EN-039) → **System** stores in S3 (sha256, virus scan), OCR if scanned (`dms.ocr`), extracts text for FTS, creates version 1 `draft` → Event `dms.document.created`.
2. Bulk upload/scan with metadata CSV; folder tree per department; duplicates detected by hash.

### 3.2 Version control

1. New upload on existing document → **System** creates next version (`v2 draft`), previous published version stays `current` until new one is published; **change log** mandatory (what changed, why); **diff view** (text diff for DOCX/text/OCR; page-image side-by-side for PDF); minor vs major version (1.1 vs 2.0) config → on publish, old version → `superseded` (watermark "OBSOLETE" on download, retained read-only), controlled copies flagged for withdrawal → Event `dms.document.version.published`.

### 3.3 Access control

- Per document/folder ACL: role/department/user with `read/download/write/admin`; download may be disabled (view-only with watermark "Uncontrolled when printed — user, date"); confidential docs need explicit grants; ACL inheritance from folder; guest links (expiring) for auditors/vendors.

### 3.4 Approval workflow

1. Author submits → workflow (EN-038 matrix by category/department: e.g. SOP → HOD review → Quality review → MS approve) → reviewers comment inline (annotations), **approve/reject/request changes** → each decision e-signed (`dms.esign`: OTP/DSC/Aadhaar eSign via EN-016) → on final approval → **publish** with effective date, distribution list (departments/roles) → controlled copy numbers for printed copies (`CC-001…`) → **read acknowledgement** required (staff must confirm reading; % tracked) → Event `dms.document.published`.
2. Reject → back to author with comments; SLA timers & reminders; withdrawal/obsolete workflow (reason, approver).

### 3.5 Expiry & renewal

1. Documents with expiry (licences, contracts, certificates, calibration certs, insurance) → alerts 90/60/30/7 days (config, per category) → renewal task auto-created (assignee = owner) in EN-037/NC-023 → renewed doc uploaded as new version with new expiry → **bulk renewal** view (VIMS enhancement) for many licences at once → Event `dms.document.expiring|renewed`.
2. Review-cycle due (e.g. SOP every 2 years) → review task; if unchanged → "reviewed, no change" record with signature.

### 3.6 Search & templates

- Full-text (title/keywords/OCR text) with filters (category, department, date, author, standard tag), quick-access bookmarks, recently viewed, "my pending reads/approvals"; template library (letters, certificates, MoUs, notices) with auto-fill from HMS data where allowed (employee, vendor, hospital details; patient auto-fill only via NC-003/EN-039 clinical templates — VIMS enhancement noted).
- **Regulatory compliance checker** (`dms.compliance_checker`, VIMS enhancement): NABH/ISO chapter checklist mapped to required documents → gap list (missing/expired/overdue review) → NC-015 dashboard.

## 4. Data Model (schema `core`, prefix `dms_`)

- **dms_folders**: id, hospital_id, branch_id?, parent_id, name, path ltree, department_id?, default_acl jsonb.
- **dms_documents**: id, hospital_id, branch_id?, folder_id, doc_code, title, category enum, department_id, owner_user_id, confidentiality enum, review_cycle_months, next_review_date, effective_date, expiry_date?, standard_tags text[], keywords text[], current_version_id, status enum(draft/in_review/approved/published/superseded/obsolete/archived), retention_years, is_template bool, template_fields jsonb, version. UNIQUE (hospital_id, doc_code). INDEX (hospital_id, category, status), (expiry_date), (next_review_date); GIN on fts.
- **dms_versions**: id, document_id, version_no (major.minor), file_id, sha256, mime, pages, ocr_text_file_id, fts tsvector, change_summary, author_id, created_at, status enum(draft/in_review/approved/published/superseded/withdrawn), published_at, effective_date, approved_by[] jsonb (with esign refs), obsoleted_at, obsolete_reason.
- **dms_acl**: id, target_type enum(folder/document), target_id, principal_type enum(role/department/user/external), principal_id, rights text[] (read/download/write/admin), granted_by, expires_at.
- **dms_approvals**: id, version_id, workflow_instance_id (EN-038), step, approver_id, decision enum(pending/approved/rejected/changes_requested), comments, esign_id, decided_at, sla_due.
- **dms_annotations**: version_id, user_id, page, position jsonb, text, resolved.
- **dms_distributions**: version_id, target (dept/role/user), controlled_copy_no?, distributed_at, withdrawn_at; **dms_acknowledgements**: version_id, user_id, acknowledged_at, quiz_score?.
- **dms_expiry_tasks**: document_id, due_date, alert_stage, task_id (EN-037), status.
- **dms_access_log** (partitioned): document_id, version_id, user_id, action enum(view/download/print/share), at, ip. Append-only.
- **dms_share_links**: version_id, token, expires_at, max_downloads, created_by, purpose.
- **dms_compliance_requirements**: id, hospital_id, framework enum(nabh6/iso9001/iso15189/jci/state), chapter, requirement_code, description, required_category, document_id?, status computed.
- Files in S3 (`core.files`), encrypted; nothing hard-deleted; superseded versions retained per retention.

## 5. Business Rules & Validations

- Document code unique & immutable; version numbers monotonic; only one `published/current` version per document at a time; a superseded version cannot be edited; downloads of non-current versions watermarked "OBSOLETE".
- Publish requires all workflow approvals with e-sign (if enabled) and effective date ≥ today; approver ≠ author (SoD); rejected versions cannot be published without a new submission.
- Confidential documents: view-only by default, download requires `dms.document.download` + explicit ACL; every view/download logged; share links expire ≤ 30 days.
- Expiry-bearing categories must have `expiry_date`; alerts per config; renewal task auto-created and cannot be closed without a new version or explicit "not renewed" reason.
- Review cycle enforcement: `next_review_date` auto = published + cycle; overdue reviews shown on NC-015 dashboard.
- Read acknowledgement mandatory for categories flagged (policies/SOPs) — target % per department; new joiners auto-assigned mandatory reads (NC-010 onboarding).
- Retention: per category (default 8 yrs after obsolete; statutory registers permanent); deletion only after retention and admin approval, leaving metadata stub.
- Virus scan on upload; allowed MIME whitelist; max size; OCR language auto-detect.

## 6. API Surface (`/api/v1/dms`)

| Method    | Path                                                                             | Purpose              | Permission                                         | Idem                          | Pag    |
| --------- | -------------------------------------------------------------------------------- | -------------------- | -------------------------------------------------- | ----------------------------- | ------ |
| GET/POST  | /folders ; PATCH /folders/{id}                                                   | folder tree          | dms.folder.manage                                  | Y                             | –      |
| GET       | /documents?category=&dept=&status=&q=&expiring=                                  | list/search          | dms.document.list                                  | –                             | cursor |
| POST      | /documents                                                                       | create doc + v1      | dms.document.create                                | Y                             | –      |
| GET/PATCH | /documents/{id}                                                                  | metadata             | dms.document.read / .update                        | Y                             | –      |
| POST      | /documents/{id}/versions                                                         | upload new version   | dms.document.update                                | Y                             | –      |
| GET       | /documents/{id}/versions, /versions/{vid}/diff/{other}                           | history/diff         | dms.document.read                                  | –                             | –      |
| GET       | /versions/{vid}/file?disposition=view                                            | download             | presigned (watermark)                              | dms.document.read / .download | –      | –   |
| POST      | /versions/{vid}/submit, /approve, /reject, /request-changes, /publish, /withdraw | workflow             | dms.document.submit / .approve / .publish          | Y                             | –      |
| POST      | /versions/{vid}/annotations                                                      | review comments      | dms.document.review                                | Y                             | –      |
| POST      | /versions/{vid}/distribute, /acknowledge                                         | distribution & reads | dms.document.distribute / dms.document.acknowledge | Y                             | –      |
| GET       | /my/pending-reads, /my/approvals                                                 | inbox                | dms.document.read                                  | –                             | cursor |
| GET/POST  | /acl                                                                             | access control       | dms.acl.manage                                     | Y                             | –      |
| POST      | /share-links                                                                     | external share       | dms.document.share                                 | Y                             | –      |
| GET       | /expiries?days=90 ; POST /expiries/bulk-renew                                    | expiry dashboard     | dms.expiry.manage                                  | Y                             | cursor |
| GET       | /search?q=                                                                       | FTS across OCR       | dms.document.list                                  | –                             | cursor |
| GET       | /templates ; POST /templates/{id}/generate                                       | template fill        | dms.template.use                                   | Y                             | –      |
| GET       | /compliance?framework=nabh6                                                      | gap checker          | dms.compliance.read                                | –                             | –      |
| GET       | /reports/master-list, /reports/approval-trail/{id}, /reports/access-log          | reports              | dms.report.read                                    | –                             | –      |

## 7. Domain Events (outbox)

- `dms.document.created|version.submitted|approved|rejected` → EN-038/EN-037 tasks.
- `dms.document.published` {document_id, version, distribution} → NC-015 (SOP repository), NC-014 (announcements/mandatory reads), EN-037 push, NC-010 (onboarding reads).
- `dms.document.expiring` {document_id, days_left} / `dms.document.renewed` → NC-023 licence tracker, NC-031 contracts, NC-021 vendor docs, EN-037.
- `dms.document.obsoleted` → controlled copy withdrawal tasks.
- `dms.acknowledgement.recorded` → NC-015 training/awareness indicators.
- Consumes: `hr.employee.joined` (assign mandatory reads), `hr.employee.exited` (revoke ACL), `quality.sop.requested` (NC-015), `licence.created` (NC-023 → link document).

## 8. Screens (UI)

- **Repository browser** — desktop: folder tree + document grid (status chips, expiry badges), search bar with filters; `N` new, `/` search, `U` upload version.
- **Document viewer** — desktop/tablet/phone: PDF/DOCX render with watermark, version selector, diff toggle, annotations sidebar, approve/reject bar (for approvers), acknowledge button; offline: recently viewed published docs cached read-only on phone (NC-014).
- **Approval inbox** — desktop/phone: pending approvals with SLA, e-sign modal.
- **Expiry dashboard** — desktop: heat list by days-left, bulk renewal wizard, owner filters.
- **Master list / document control register** — desktop: NABH-style master list export; obsolete register.
- **Template generator** — desktop: pick template, fill fields (auto-fill), preview, save as document.
- **Compliance checker** — desktop: framework tree with status (present/expired/missing), links to create.
- **Admin config** — categories, workflows, alert stages, ACL defaults.

## 9. Integrations

- S3/MinIO storage, ClamAV scan, OCR worker (shared with NC-003), Postgres FTS (optional OpenSearch), EN-016 e-sign, EN-038 workflow, EN-039 templates, EN-032 email, NC-014 mobile feed, NC-023/NC-031/NC-021 links, DOCX→PDF conversion (LibreOffice headless in worker) for viewing/diff.

## 10. Reports & Analytics

- Master list of controlled documents (by department/category, version, effective, next review), overdue reviews, expiring documents (30/60/90), approval cycle time, acknowledgement compliance % by department, access log per confidential document, obsolete copies withdrawn, compliance gap summary. Read model `analytics.dms_status_daily`.

## 11. Notifications

- Approvers: pending approval (push/email), SLA reminders; authors: decisions; distribution targets: new/updated document to read (push via NC-014), reminders for unacknowledged after 7 days; owners: expiry alerts 90/60/30/7 & review due; admins: compliance gaps monthly digest.

## 12. Permissions (RBAC keys)

`dms.folder.manage`, `dms.document.list/read/create/update/download/share/submit/review/approve/publish/distribute/acknowledge`, `dms.acl.manage`, `dms.expiry.manage`, `dms.template.use/manage`, `dms.compliance.read`, `dms.report.read`, `dms.configure`. ABAC: department scoping; confidentiality tiers; approver ≠ author.

## 13. Non-functional

- Volumes: 20k documents, 100k versions, 5k active users; search p95 < 300 ms; upload 100 MB with resumable multipart; viewer first page < 1.5 s (pre-rendered thumbnails).
- Offline read cache on phone for published docs (size cap); printing with watermark; WCAG 2.2 AA; i18n metadata; multilingual documents (Hindi/regional) stored as language variants of the same document (VIMS enhancement).

## 14. Acceptance Criteria

1. Given an SOP v1 published, when the author uploads a new file, then v2 draft is created, v1 stays current until v2 is published, and change summary is mandatory.
2. Given a workflow HOD→Quality→MS, when HOD rejects, then the version returns to author with comments and cannot be published; when all approve with e-sign, publish sets v1 to superseded with OBSOLETE watermark on download.
3. Given a confidential document without download right, when user opens it, then view-only with watermark and the access log records the view; download returns 403.
4. Given a licence expiring in 60 days, then owner and compliance officer receive alerts, a renewal task exists, and the expiry dashboard lists it in amber.
5. Given a distribution to ICU nurses requiring acknowledgement, then each nurse sees a pending read on phone; after 7 days unacknowledged, reminder sent and department compliance % reflects it.
6. Given a search "hand hygiene", then results include documents whose OCR text matches, ranked with highlights, filtered by category.
7. Given a share link created for an auditor with 7-day expiry, then access after expiry is refused and each download logged.
8. Given the NABH compliance checker configured with required SOP list, then missing/expired documents appear as gaps and link to create/renew.
9. Given a new employee joins ICU, then mandatory ICU policies are auto-assigned as pending reads.
10. Given an approver who is also the author, when approving, then the system blocks (SoD).

## 15. Enhancements / Later phases

- From VIMS sheet: e-signature for approvals (`dms.esign`, Phase 9), multilingual document support (language variants, Phase 9), auto-fill templates from patient data (via EN-039 clinical templates in NC-003, not DMS), regulatory compliance checker (`dms.compliance_checker`, Phase 9/11), bulk expiry renewal (Phase 9).
- (market) Document control aligned to NABH master list; AI summarisation & Q&A over SOPs (AI-008/AI-001), automatic classification of uploads (AI-003), Office online co-authoring integration, retention automation with legal hold, QR code on controlled copies to verify currency.

## 16. Open Questions for the Hospital

1. Document categories, coding scheme, and departments acting as document controllers?
2. Approval matrices per category; e-sign method (OTP/DSC/Aadhaar)?
3. Which document types need read acknowledgements and target compliance %?
4. Existing SOP repository (Word/PDF count) to migrate; version history needed?
5. Expiry alert stages and who owns licence renewals (Legal vs Quality vs Admin)?
6. Storage location (cloud vs on-prem) and retention per category?
7. Should vendors/auditors get external access (portal/share links)?
