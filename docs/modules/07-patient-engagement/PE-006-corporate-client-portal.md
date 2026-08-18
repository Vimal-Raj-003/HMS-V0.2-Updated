# PE-006 — Corporate Client Portal (Company Admin Login, Employee Roster & Eligibility, Bulk Health Check-Up Scheduling, Aggregate Wellness Dashboards with k-Anonymity, Invoices & SOA, Utilisation Reports, Support Tickets)

| Field | Value |
|---|---|
| Domain | Patient Engagement |
| Module ID | PE-006 |
| Phase | 10 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | **NC-012 (B2B / Corporate Billing — owns the corporate master, credit terms, consolidated invoices, SOA, TDS; PE-006 is its external self-service surface)**, OP-014 (Health Check-Up Packages & Corporate Wellness — the operational engine for camps, packages and consolidated reports), RC-003 (corporate rate plans and package pricing), RC-005 (AR follow-up — the corporate sees the same SOA the collections team works from), OP-001 (employee identification at registration, eligibility check), OP-005/IP-005 (credit bills against the corporate), EN-002 (where the corporate uses a TPA), EN-010 (online payment of invoices), EN-025 (SSO for large corporates — OIDC/SAML), EN-028 (consent — the employee's, not just the employer's), EN-032/EN-009 (invitations, statements, reminders), EN-038 (approvals for eligibility overrides and credit changes), NC-031 (contracts/MoUs), NC-026 (corporate acquisition and account management), NC-028 (support ticket engine), PE-005 (`loyalty.corporate_tieup` employer-funded wellness incentives), PE-002 (employee follow-up on abnormal findings — clinically owned, not employer-visible), EN-024 (audit), NC-011/EN-001 (analytics) |
| Feature flag | `module.corporate_portal.enabled` (sub: `corp.roster_upload`, `corp.bulk_scheduling`, `corp.wellness_dashboard`, `corp.online_payment`, `corp.sso`, `corp.tickets`) |
| Primary roles | **Corporate HR Client (61)** — company admin and sub-users (HR executive, finance executive, site coordinator), Corporate / B2B Billing Executive (29), Health Check-up Coordinator (OP-014) |
| Secondary roles | Finance Manager (46), Marketing/BD (55 — account management), Front office (24 — employee identification), Occupational-health physician where the hospital provides one, Privacy Officer / DPO (57 — the employer-data boundary is the sharpest privacy line in the product), Hospital Admin (2), Auditor (58) |
| Regulatory | **DPDP Act 2023 & Rules 2025** — an employee's health data belongs to the employee, not the employer: individual results may be disclosed to an employer **only** with the employee's specific consent (or where a statute requires it, e.g. a fitness certificate); aggregate reporting must be non-identifiable, which the system enforces through **k-anonymity ≥ 10** and small-cell suppression; the employer is a separate data fiduciary for the roster it uploads, governed by a data-processing/sharing agreement; **Occupational Safety, Health and Working Conditions Code 2020 & Factories Act 1948 §41C** — statutory pre-employment and periodic medical examinations for hazardous processes, where a **fitness/unfitness statement** (not the clinical detail) may be shared with the employer; **ESI Act** where employees are ESIC-covered (RC-007); **Contract Act / MSMED** (payment terms); **GST** (B2B tax invoice with the corporate's GSTIN, place of supply, e-invoice above threshold; corporate health check-ups are generally exempt healthcare under SAC 9993, but occupational-health and wellness services may be taxable — configurable per NC-012); **Income-tax TDS §194J/194C** deducted by corporates with Form 16A/26AS reconciliation; **NABH** (health check-up processes, report turnaround); **IT Act** (portal security); **PC-PNDT** (no sex-determination content in any package) |

## 1. Purpose
PE-006 gives the hospital's corporate clients a self-service portal: their people, their money and their aggregate health picture. HR uploads and maintains the **employee roster** with eligibility rules, schedules **bulk health check-ups** and on-site camps, tracks completion, downloads **invoices, statements of account and TDS-relevant documents**, pays online, sees **utilisation and aggregate wellness dashboards that can never identify an individual**, and raises support tickets — while every individual clinical result stays with the employee unless they personally consent to share it.

## 2. Users & Jobs-to-be-done
- **Corporate HR admin** (desktop, monthly cadence with an annual peak): upload and correct the roster, add joiners and remove leavers, schedule the annual check-up drive for 800 employees across three sites, chase completion, get the aggregate report for the leadership deck, reconcile invoices.
- **Corporate finance user**: download invoices and the SOA, dispute a line, pay online, get TDS-reconciliation data.
- **Site coordinator**: manage one location's slots, attendance and camp logistics.
- **Hospital corporate-billing executive**: onboard the client, configure eligibility and packages, resolve disputes, monitor credit and collections (with RC-005).
- **Health check-up coordinator (OP-014)**: convert the schedule into actual slots, manage camp day operations, ensure reports are delivered to employees (not to HR).
- **Privacy Officer**: prove that the employer never saw an individual's clinical data without that individual's consent.
- **Employee (indirectly)**: gets their own report in PE-001, and is asked — clearly and separately — whether anything may be shared with the employer.

## 3. Core Workflows

### 3.1 Onboarding a corporate client
1. NC-012 creates the corporate master (legal name, GSTIN, PAN, addresses, sites, credit limit, credit days, rate plan (RC-003), package list, TPA linkage if any, MoU/contract via NC-031, TDS rate, billing cycle). PE-006 adds the **portal profile**: allowed modules, sites, branding, notification recipients, and the **data-sharing agreement** — which specifies exactly what the employer may see (aggregate only, by default), retention, and the employee-consent mechanism. The portal cannot be activated until the agreement is on file.
2. **Users**: a company admin is invited by email (EN-032, single-use expiring link), sets up MFA, and can then create sub-users with roles enum(company_admin/hr_executive/finance/site_coordinator/read_only) scoped to sites and modules. Large corporates may use **SSO** (`corp.sso`, OIDC/SAML via EN-025) with just-in-time provisioning mapped to those roles. Sessions are short, device-listed, and every login is audited.

### 3.2 Employee roster & eligibility (`corp.roster_upload`)
1. HR uploads a roster (XLSX/CSV template, or API/SFTP for large clients; SCIM-style sync later): employee code, name, DOB, sex, mobile, email, designation/grade, location/site, department, date of joining, entitlement band, dependants (spouse/children/parents) with relationship and DOB, and effective dates. A column mapper is saved per client.
2. Validation and **matching**: rows are validated (mandatory fields, DOB plausibility, duplicate employee codes, mobile format) and matched against the hospital MPI (OP-001) by mobile/name/DOB — matches are *suggestions* only; a roster upload never creates or merges a clinical record, and no clinical data is returned to the uploader. Errors are returned as a row-level report.
3. **Eligibility rules** per client: which packages/entitlement band applies to which grade, dependant coverage, annual frequency (one check per employee per financial year), age/sex-appropriate package variants, and the credit ceiling per employee per year. Eligibility is checked at OP-001 registration and at billing: an employee arriving at the desk is identified as covered, the right package and rate plan apply, and anything outside entitlement is payable by the employee (shown clearly before service).
4. Joiners/leavers: HR adds or deactivates rows; a leaver's future eligibility ends on the effective date while **their clinical records remain the employee's own** and remain visible to them in PE-001 forever.

### 3.3 Bulk health check-up scheduling (`corp.bulk_scheduling`)
1. HR creates a **drive**: package(s), site(s), date range, expected headcount, on-site camp vs at-hospital, fasting instructions, and preferred slots. The hospital (OP-014) confirms capacity and publishes slot blocks.
2. Employees are invited directly by the hospital (SMS/WhatsApp/email with a self-booking link into PE-001) — HR sees **completion status only** (invited / booked / attended / pending / declined), never the clinical outcome. HR can nudge non-responders through the portal, which triggers hospital-sent reminders rather than exposing employee contact behaviour.
3. Camp-day operations (registration, station routing, sample collection, report generation) run in OP-014/NC-035; the portal shows live progress on the drive (attended vs planned) and a downloadable attendance sheet.
4. **Report delivery**: each employee receives their own report in PE-001/WhatsApp. HR receives **no individual reports**. Where a statutory fitness certificate is required (Factories Act §41C, food handlers, drivers), the system issues a **fitness statement only** (fit / fit with restrictions / temporarily unfit / unfit for the specified role) with no diagnosis, and only for roles the contract lists — and the employee is told what is being shared and why.
5. Abnormal findings are followed up **clinically** through PE-002 with the employee, never through HR.

### 3.4 Aggregate wellness dashboards (`corp.wellness_dashboard`, k-anonymity ≥ 10)
- The employer sees only aggregate, non-identifiable analytics: participation rate, age/sex distribution of participants, prevalence bands (BMI categories, blood pressure categories, blood sugar categories, lipid categories, anaemia, vision, dental), lifestyle-risk summary from the questionnaire, top risk categories, year-on-year trend, and site comparisons.
- **Suppression rules, enforced server-side and untoggleable by the client**: any cell with fewer than **k = 10** individuals is suppressed (shown as "insufficient data"); complementary suppression prevents back-calculation from row/column totals; a **minimum drive size of 30** before any dashboard is produced; no drill-down below the suppression threshold; no export of row-level data of any kind; percentages rounded and small denominators hidden. Combinations of filters that would reduce a cell below k are blocked rather than silently narrowed.
- Every dashboard view and export is audited with the user, the filter set and the timestamp, and the export carries a footer stating the k-anonymity threshold and the date.

### 3.5 Invoices, SOA and payment
- Invoices generated by NC-012 (consolidated per cycle, GST-compliant, e-invoice where applicable) are published to the portal with supporting detail at the **service level, not the clinical level** (e.g. "Executive Health Check — Male 40+ × 214", "OP consultations × 96"); where the contract permits employee-wise billing detail, only name/employee code/date/service/amount appear — never a diagnosis, a prescription or a result.
- **SOA** with ageing (the same view RC-005 works from), dispute a line (raises a ticket and flags the line in NC-012), download TDS-relevant summaries for Form 16A reconciliation, and **pay online** (`corp.online_payment`, EN-010 — NEFT/RTGS references can also be recorded). Payment status and credit-limit utilisation are visible so HR knows before a service is refused at the counter.

### 3.6 Utilisation reports
- Service utilisation by category and site (consultations, diagnostics, IP admissions counts and value, pharmacy), spend against budget, entitlement consumption per band (aggregate), average cost per employee, and — with the same k-anonymity rules — utilisation patterns. No individual's utilisation is ever shown, because a single admission in a small department identifies a person.

### 3.7 Support tickets (`corp.tickets`)
- HR raises tickets (roster error, invoice dispute, appointment issue, report not received by an employee, camp logistics, contract query) with categories, SLAs, assignment to the corporate-billing executive or coordinator, threaded replies with attachments, and satisfaction rating on closure. Backed by NC-028's engine so the hospital's helpdesk sees one queue.

### 3.8 Exceptions
- Roster row cannot be matched → eligibility still applies (identification at the desk by employee code/ID card); a mismatch never blocks care.
- Employee objects to their data being in the roster → the employer remains responsible for the roster's lawfulness; the hospital records the objection, honours the employee's DPDP rights over the hospital's own records, and notifies the corporate contact.
- Contract expiry or credit block → new credit services are refused at the counter with a clear message and an HR notification; emergency care is **never** refused for a credit reason.
- Drive under-subscribed (< 30 participants) → no aggregate dashboard is produced; the portal explains the privacy reason rather than showing a thin, identifying report.
- A statutory fitness certificate is required but the employee declines the examination → recorded as declined; the hospital does not disclose clinical reasons to the employer.

## 4. Data Model (schema `engage`, prefix `corp_`; corporate master and invoices in NC-012)
- **corp_portal_profiles** — id, hospital_id, corporate_id (NC-012), status enum(pending/active/suspended/closed), modules_enabled text[], sites jsonb, branding jsonb, data_sharing_agreement_file_id, agreement_signed_at, aggregate_only bool default true, k_threshold smallint default 10, min_drive_size smallint default 30, employee_wise_billing_detail bool default false, statutory_fitness_roles text[], notification_recipients jsonb, sso_config jsonb?, audit cols.
- **corp_users** — id, portal_profile_id, corporate_id, email citext, name, phone, role enum(company_admin/hr_executive/finance/site_coordinator/read_only), site_scope uuid[], status enum(invited/active/disabled), mfa_enabled, sso_subject?, invited_by, invited_at, last_login_at, disabled_at. UNIQUE(portal_profile_id, email).
- **corp_roster_uploads** — id, corporate_id, file_id, template_id, uploaded_by (corp_user), uploaded_at, rows_total, rows_valid, rows_error, rows_matched, error_report_file_id, status enum(uploaded/validating/review/applied/rejected), applied_at, applied_by.
- **corp_employees** — id, hospital_id, corporate_id, employee_code, name, dob, sex, mobile_hash, email_hash, grade, designation, site_id, department, doj, dol?, entitlement_band, status enum(active/inactive), patient_id? (**suggested match only**, confirmed at the desk), source_upload_id, effective_from, effective_to, audit cols. UNIQUE(corporate_id, employee_code). **No clinical column exists on this table by design.**
- **corp_dependants** — employee_id, name, relationship enum(spouse/child/parent/other), dob, sex, entitlement_band, patient_id?, active.
- **corp_eligibility_rules** — corporate_id, grade/band, package_ids uuid[], dependant_coverage jsonb, frequency_per_fy smallint, annual_credit_cap?, age_sex_variants jsonb, effective range, approved_by.
- **corp_drives** — id, corporate_id, name, package_ids uuid[], sites uuid[], mode enum(at_hospital/onsite_camp/hybrid), date_from, date_to, expected_headcount, capacity_confirmed_by (OP-014), slot_blocks jsonb, instructions, status enum(draft/requested/confirmed/in_progress/completed/cancelled), invited_count, booked_count, attended_count, completed_at.
- **corp_drive_participants** — drive_id, employee_id, dependant_id?, invited_at, booked_appointment_id?, attended_encounter_id?, status enum(invited/booked/attended/pending/declined/no_show), reminder_count, **no clinical fields**; HR-visible view exposes only status.
- **corp_fitness_statements** — id, corporate_id, employee_id, encounter_id, role_context, statement enum(fit/fit_with_restrictions/temporarily_unfit/unfit), restrictions_text?, valid_till, issued_by (physician), issued_at, employee_informed_at, consent_id (EN-028), file_id. (The only individual-level artefact an employer may receive, and only for contracted statutory roles.)
- **corp_aggregate_snapshots** — id, corporate_id, drive_id?, period, dimension_set jsonb, metrics jsonb (bands and counts **after suppression**), k_threshold_applied, cells_suppressed int, population_n, generated_at, generated_by, export_file_id?. (Snapshots are computed once and served, so a client cannot iterate filters to triangulate.)
- **corp_dashboard_access_log** — corporate_id, corp_user_id, viewed_at, view_type, filters jsonb, cells_returned, cells_suppressed, exported bool, ip_hash. (Privacy evidence.)
- **corp_invoice_publications** — corporate_id, invoice_id (NC-012), published_at, detail_level enum(service_summary/employee_wise), file_id, downloaded_at, downloaded_by.
- **corp_disputes** — invoice_id, line_ref, raised_by, raised_at, reason, amount, status enum(open/under_review/accepted/rejected/credited), resolution_note, credit_note_id?, ticket_id.
- **corp_tickets** — id, corporate_id, corp_user_id, category enum(roster/invoice/appointment/report/camp/contract/technical/other), subject, description, priority, status, sla_due_at, assigned_to, messages jsonb, attachments jsonb, closed_at, satisfaction_rating?, helpdesk_ticket_id (NC-028).
- RLS on `hospital_id` **and** `corporate_id` — a portal user's every query is bound to their corporate and site scope, verified by test. Roster PII is encrypted at rest; mobile/email stored as hashes plus encrypted values for messaging. Retention: roster and drives per contract (default 3 years after contract end), fitness statements per statute, aggregate snapshots 7 years, access log 3 years.

## 5. Business Rules & Validations
- **The employer never sees individual clinical data.** There is no API path, report or export in PE-006 that returns a diagnosis, result value, prescription, or admission reason for a named person — enforced by schema (no clinical columns on corporate tables), by authorisation (corporate users hold no clinical permissions), and by a contract test that asserts it.
- The **only** individual-level clinical artefact an employer may receive is a **fitness statement** for a contracted statutory role, issued by a physician, with the employee informed and consent recorded, and containing no diagnosis.
- **k-anonymity ≥ 10** with complementary suppression on every aggregate cell; minimum drive size 30 before any dashboard exists; filter combinations that would breach k are refused, not silently widened; no row-level export ever. The threshold is configurable upward, never downward.
- Employee-wise **billing** detail is permitted only if the contract enables it, and even then it carries service names and amounts, never clinical content.
- A roster upload never creates, merges or modifies a clinical record; matching is advisory and confirmed at the desk by human identification.
- Eligibility governs *billing*, never *care*: an ineligible or credit-blocked employee is still treated; only the payment route changes, and **emergency care is never refused** for a corporate credit reason.
- Portal activation requires a signed data-sharing agreement on file; suspension of the agreement suspends the portal.
- Corporate users are external: MFA mandatory, short sessions, IP-allowlist optional, invitation links single-use and expiring, and every login, view and export audited.
- Consent: the employee's consent (EN-028) governs any individual disclosure; the employer's instruction is never sufficient.
- Disputes freeze only the disputed line for collections purposes (RC-005), not the whole invoice.
- Segregation: the corporate-billing executive who publishes an invoice cannot approve a credit note for it (NC-012/EN-038).
- Data minimisation on the roster: only the fields the contract needs; the client is warned when uploading columns beyond the template.

## 6. API Surface (`/api/v1/corporate-portal`) — all endpoints corporate-scoped by ABAC
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /auth/invite-accept ; /auth/login ; /auth/sso/callback | external user auth (MFA) | public / corp.self | Y | – |
| GET/POST/PATCH | /users | sub-user management | corp.user.manage | Y | cursor |
| GET | /profile | corporate profile, sites, agreement status | corp.profile.read | – | – |
| POST | /roster/uploads ; GET /roster/uploads/{id} | roster upload & validation report | corp.roster.upload | Y | – |
| POST | /roster/uploads/{id}/apply | apply after review | corp.roster.upload | Y | – |
| GET | /employees?site=&status=&q= | roster view (no clinical fields) | corp.roster.read | – | cursor |
| POST/PATCH | /employees ; /employees/{id} ; DELETE (deactivate) | joiner/leaver maintenance | corp.roster.manage | Y | – |
| GET | /eligibility?employeeCode= | entitlement check | corp.eligibility.read | – | – |
| GET/POST/PATCH | /drives ; /drives/{id} | health-check drives | corp.drive.manage | Y | cursor |
| POST | /drives/{id}/invite | trigger hospital-sent invitations | corp.drive.manage | Y | – |
| GET | /drives/{id}/participants | **status only** (invited/booked/attended/pending) | corp.drive.read | – | cursor |
| POST | /drives/{id}/nudge | request reminders to non-responders | corp.drive.manage | Y | – |
| GET | /drives/{id}/attendance-sheet | attendance export (no clinical data) | corp.drive.read | – | – |
| GET | /wellness/dashboard?drive=&period=&site=&dimension= | aggregate metrics (k-anonymised) | corp.wellness.read | – | – |
| GET | /wellness/export?snapshotId= | aggregate export with k-footer (audited) | corp.wellness.export | – | – |
| GET | /fitness-statements?role=&period= | statutory fitness statements (contracted roles only) | corp.fitness.read | – | cursor |
| GET | /invoices ; GET /invoices/{id}/pdf | invoices (NC-012) | corp.invoice.read | – | cursor |
| GET | /soa?asOf= ; GET /soa/export | statement of account & ageing | corp.soa.read | – | cursor |
| POST | /invoices/{id}/dispute | raise a dispute on a line | corp.dispute.raise | Y | – |
| POST | /payments | pay online (EN-010) / record NEFT reference | corp.payment.create | Y | – |
| GET | /reports/utilisation?period=&site= | utilisation (k-anonymised) | corp.report.read | – | – |
| GET/POST | /tickets ; POST /tickets/{id}/reply | support | corp.ticket.manage | Y | cursor |
| GET | /audit/my-activity | the client's own access log (transparency) | corp.self | – | cursor |

Hospital-side (`/api/v1/corporate-admin/...`): profile & agreement management, k-threshold configuration (upward only), eligibility rules, drive capacity confirmation, invoice publication, dispute resolution, and the **privacy audit report** showing exactly what each client accessed.

## 7. Domain Events (outbox)
- `corporate.portal.activated|suspended` {corporate, agreement_ref} → NC-012, notifications.
- `corporate.user.invited|activated|disabled` → audit, security monitoring.
- `corporate.roster.uploaded|applied` {rows, matched, errors} → eligibility cache refresh, OP-001 desk lookup.
- `corporate.eligibility.changed` {employee, band, effective} → OP-005/IP-005 billing routing.
- `corporate.drive.requested|confirmed|started|completed` {headcount, attended} → OP-014, NC-035, capacity planning.
- `corporate.drive.participant.status_changed` {status only} → HR dashboard (never clinical).
- `corporate.wellness.snapshot.generated` {population_n, cells_suppressed} → privacy evidence, HR notification.
- `corporate.wellness.viewed|exported` {user, filters} → **privacy audit log**.
- `corporate.fitness_statement.issued` {employee, statement, consent_ref} → employee notification (they are told what was shared).
- `corporate.invoice.published|downloaded`, `corporate.dispute.raised|resolved` → NC-012, RC-005.
- `corporate.payment.received` → NC-012/NC-009, RC-005 ageing.
- `corporate.ticket.created|replied|closed` → NC-028.
- Consumes: `corporate.invoice.issued` (NC-012), `healthcheck.completed` (OP-014 → drive progress, aggregate snapshot inputs), `appointment.booked|attended` (drive status), `credit_limit.breached` (NC-012 → HR alert), `contract.expiring` (NC-031).

## 8. Screens (external, responsive; hospital-branded per client)
- **Corporate dashboard** (desktop-first, HR's monthly view): tiles — active employees, current drive progress (invited/booked/attended with a completion ring), outstanding invoice amount and ageing, credit utilisation, open tickets, contract expiry countdown. No clinical content anywhere.
- **Roster** (desktop): upload with drag-drop and a saved column mapper, validation report with row-level errors and a downloadable correction file, roster grid with filters (site, grade, status), joiner/leaver actions, dependant management, eligibility preview per employee ("Executive Health Check, ₹0 payable; spouse covered"). Shortcuts: `U` upload, `/` search, `E` edit row.
- **Health check drives** (desktop): create a drive (packages, sites, dates, headcount, mode), capacity confirmation status from the hospital, live progress bar, participant **status** list (never results), nudge action, attendance sheet download, camp-day logistics notes and contacts.
- **Wellness dashboard** (desktop, the screen most likely to be misused, therefore the most constrained): participation, age/sex distribution, and risk-category bands (BMI, BP, glucose, lipids, anaemia, vision, dental) as bar/donut charts with **"insufficient data" tiles wherever k < 10**, a persistent banner — "All figures are aggregate and anonymised (minimum group size 10). Individual results are available only to the employee." — year-on-year trend, site comparison, and an export that carries the k-footer. Filters that would breach k are disabled with an explanatory tooltip rather than silently returning nothing.
- **Invoices & SOA** (desktop): invoice list with status and download, SOA with ageing buckets matching RC-005, dispute a line with reason and attachment, pay online (EN-010) or record an NEFT reference, TDS summary download, credit-limit gauge.
- **Utilisation reports**: service-category mix, spend vs budget, cost per employee, site comparison — all aggregate, all k-anonymised.
- **Support**: ticket list with SLA status, new ticket with category, threaded replies with attachments, satisfaction rating on closure.
- **Users & security**: sub-user management with roles and site scope, MFA status, SSO configuration (for large clients), and **"my company's access log"** — showing HR exactly what their own users viewed and exported (transparency both ways).
- **Employee-facing** (PE-001, not this portal): their own reports, their own consent decision about any employer disclosure, and their follow-up appointments.
- WCAG 2.2 AA, responsive down to tablet, multilingual where clients need it, print-friendly invoices and dashboards.

## 9. Integrations
- **NC-012** (corporate master, invoices, SOA, credit, TDS — PE-006 never computes money, it publishes it), **OP-014** (health-check packages, camp operations, consolidated reports to employees), **NC-035** (on-site camps), **RC-003** (corporate rate plans), **RC-005** (ageing shown to the client is the same ageing the collections team works from — one truth), **OP-001** (eligibility at registration), **OP-005/IP-005** (credit routing at billing), **EN-010** (online payment), **EN-025** (SSO for large corporates), **EN-032/EN-009** (invitations, statements, drive reminders — reminders to employees are sent by the hospital, not by HR), **EN-028** (employee consent for any individual disclosure), **NC-028** (ticket engine), **NC-031** (contract and agreement documents), **PE-005** (`loyalty.corporate_tieup` employer-funded wellness incentives), **PE-002** (clinical follow-up of abnormal findings — employee-directed only), **EN-024** (audit).
- Enterprise integration options for large clients: SFTP roster drop with PGP, REST roster API, SCIM-style user provisioning, and IP-allowlisting.
- Fallbacks: roster API failure → manual upload; payment gateway down → NEFT reference capture; dashboard snapshot unavailable → honest "being prepared" state rather than a partial, identifying view.

## 10. Reports & Analytics
- **For the corporate**: participation and completion, aggregate risk profile with trend, utilisation and spend, invoice ageing and payment history, ticket SLA performance — all k-anonymised.
- **For the hospital**: revenue and margin per corporate, drive conversion (planned vs attended — the number that decides next year's contract), package mix, no-show rate on corporate slots, DSO per corporate (with RC-005), ticket volume and causes, portal adoption per client, contract renewal pipeline (NC-026), and the **privacy audit report** (who accessed what, cells suppressed, exports made) that the DPO reviews quarterly.
- Read models: `analytics.mv_corp_utilisation`, `mv_corp_drive_conversion`, `mv_corp_ar_ageing`, `mv_corp_portal_adoption`.

## 11. Notifications
- **Corporate users**: portal invitation and MFA setup, roster validation completed (with error count), drive confirmed with dates and capacity, drive progress at 50 %/90 %/close, invoice published with due date, payment received, SOA at cycle close, dispute status, credit limit at 80 %/100 %, contract expiring at 90/60/30 days, ticket updates, wellness snapshot ready.
- **Employees** (from the hospital, never from HR): health-check invitation with self-booking link, appointment and fasting reminders, report ready in the portal, follow-up needed (clinical, via PE-002), and — where applicable — a clear notice of what fitness information is being shared with the employer and why.
- **Hospital**: new drive request awaiting capacity confirmation, roster errors needing help, dispute raised, credit breach, client ticket SLA at risk, unusual dashboard access pattern (privacy monitoring).

## 12. Permissions (RBAC keys)
External (role 61, ABAC scoped to `corporate_id` and site): `corp.self`, `corp.profile.read`, `corp.user.manage` (company_admin only), `corp.roster.read|upload|manage`, `corp.eligibility.read`, `corp.drive.read|manage`, `corp.wellness.read|export`, `corp.fitness.read` (only if the contract lists statutory roles), `corp.invoice.read`, `corp.soa.read`, `corp.dispute.raise`, `corp.payment.create`, `corp.report.read`, `corp.ticket.manage`.
**No corporate role ever holds any `patient.*`, `lab.*`, `rad.*`, `clinical.*` or `billing.item.*` permission** — asserted by a permission-catalogue test.
Hospital-side: `corporate.portal.configure` (Corporate billing lead + DPO for the data-sharing agreement and k-threshold), `corporate.drive.confirm` (Health check-up coordinator), `corporate.invoice.publish` (Corporate billing), `corporate.dispute.resolve` (Corporate billing lead; credit notes via NC-012/EN-038), `corporate.privacy_audit.read` (**DPO, Admin, Auditor**).

## 13. Non-functional
- **Volumes**: 50–300 corporate clients per hospital group; rosters of 100–20,000 employees (largest upload ~50k rows); 20–60 drives per year with 200–2,000 participants each; invoice cycles monthly.
- **Performance**: roster upload of 20,000 rows validated and matched in < 3 min async with progress and a downloadable error report; roster grid p95 < 300 ms with cursor pagination; wellness dashboard served from a precomputed snapshot in < 500 ms (never computed live, both for speed and to prevent filter-iteration attacks); invoice list < 200 ms.
- **Security** (external-facing surface): mandatory MFA, short sessions with device list, optional IP allowlist, single-use expiring invitations, rate limits and bot protection at EN-026, strict `corporate_id` row filtering verified by automated cross-tenant tests, PII encrypted at rest, no clinical data in any response schema, annual penetration test.
- **Privacy engineering**: k-anonymity and complementary suppression implemented in the snapshot generator (not in the UI), snapshots immutable once generated, every view and export logged with the filter set, quarterly DPO review of the access log, and a documented threat model for re-identification.
- **Offline**: not required (B2B desktop tool); exports are downloadable.
- **Accessibility/i18n**: WCAG 2.2 AA; English default with client-language options; print-friendly invoices, SOA and dashboards.
- **Availability**: portal outage must not affect employee care or hospital billing; the portal is a read/publish surface over NC-012 and OP-014.

## 14. Acceptance Criteria
1. Given a corporate without a signed data-sharing agreement on file, when portal activation is attempted, then it is blocked with the reason.
2. Given a corporate user, when they call any API, then every response is filtered to their `corporate_id` and site scope, and a crafted request for another corporate's data returns 404 (cross-tenant test).
3. Given a corporate user with every permission the portal offers, then no endpoint returns any diagnosis, result value, prescription or admission reason for a named individual (schema and contract test).
4. Given a roster upload of 20,000 rows with 43 errors, then validation completes asynchronously with progress, a row-level error report is downloadable, and nothing is applied until the client reviews and confirms.
5. Given a roster row that matches an existing patient by mobile and DOB, then the match is stored as a suggestion only and no clinical record is created, merged or modified.
6. Given a health-check drive, then employees receive hospital-sent invitations with self-booking links, and HR sees only invited/booked/attended/pending status — never results.
7. Given a drive with 24 participants, then no aggregate wellness dashboard is generated, and the portal explains the minimum-group-size privacy rule.
8. Given a wellness dashboard filtered to "site B, female, age 50+" where only 6 individuals match, then the cell is suppressed as "insufficient data", complementary cells are suppressed so the value cannot be derived from totals, and the filter combination is disabled with a tooltip.
9. Given any wellness export, then it carries the k-threshold footer and generation date, and the export is recorded in the privacy access log with the user and filter set.
10. Given a statutory role listed in the contract, when a fitness statement is issued, then it contains only fit/fit-with-restrictions/temporarily-unfit/unfit with restrictions text, the employee is informed and consent is recorded, and no diagnosis is present.
11. Given an employee not listed for a statutory role, then no fitness statement can be issued to the employer for them.
12. Given an employee who leaves the company, then their future eligibility ends on the effective date while their own records remain fully available to them in PE-001.
13. Given a credit-blocked corporate, when an employee presents for emergency care, then care proceeds and only the payment route changes; a test asserts that no corporate credit state can block emergency treatment.
14. Given an invoice line dispute, then only that line is flagged for collections in RC-005 and the rest of the invoice continues to age normally.
15. Given a corporate finance user pays online, then the payment posts to NC-012/NC-009, the SOA updates, and RC-005 ageing reflects it within the refresh interval.
16. Given the DPO opens the privacy audit report, then it shows, per client and per user, every dashboard view and export with filters, cells returned and cells suppressed.
17. Given a corporate user without MFA enrolled, then login cannot complete.
18. Given an employee objects to their inclusion in the roster, then the objection is recorded, the corporate contact is notified, and the employee's rights over the hospital's own records are honoured through PE-001 DSAR.

## 15. Enhancements / Later phases
- Origin: architect-added (M); the VIMS sheet has corporate billing (NC-012) and corporate wellness (OP-014) but no client-facing portal. Competitors advertise "Corporate & Insurance Invoice Management" (MocDoc) and corporate health check-up handling (SmartHospital/PCS), but none offers a privacy-engineered employer dashboard — which is precisely the feature that keeps a hospital out of trouble under the DPDP Act.
- Later: SCIM/HRMS connectors (SAP SuccessFactors, Darwinbox, Zoho People, Keka) for automatic roster sync; employer-funded wellness incentives through PE-005 (`loyalty.corporate_tieup`); occupational-health module (job-role-based hazard exposure, statutory periodic examinations, audiometry/spirometry surveillance under the OSH Code, exposure registers) as a proper clinical module rather than an employer report; on-site clinic management for large campuses; predictive risk modelling for the employer at aggregate level only (AI-005) with differential-privacy noise in addition to k-anonymity; ESG/health-and-safety reporting packs; multi-year cohort trends; e-invoice and payment-gateway auto-reconciliation; contract renewal workflow with utilisation-based repricing (RC-003); a mobile view for HR to track drive-day progress.

## 16. Open Questions for the Hospital
1. Which corporate clients would use a portal, and how many HR users each? Do any require SSO or SFTP roster drops?
2. What does your data-sharing agreement with corporates say today about individual results — is anything individual shared, and on what basis?
3. Do any contracts require **statutory fitness certificates** (Factories Act, food handlers, drivers)? For which roles, and who signs them?
4. Is a k-anonymity threshold of 10 acceptable to your clients, or do some demand finer breakdowns? (We will not go below 10; we need to know who will push.)
5. Should invoices show employee-wise detail (name, date, service, amount) or only service summaries? What does each contract permit?
6. Who invites employees for health-check drives today — HR or the hospital? (We recommend the hospital, so HR never learns who declined for health reasons.)
7. What eligibility structures exist (grades, bands, dependant coverage, annual frequency, caps), and who approves an exception?
8. Do you want corporates to pay online, and which payment modes do they actually use (NEFT is common)?
9. What are your current corporate support pain points (roster errors, invoice disputes, report delivery)? These become the ticket categories.
10. What happens today when a corporate exceeds its credit limit — and can we confirm emergency care is never affected?
11. Who is your DPO and who will review the corporate privacy access log quarterly?
12. Do any clients want an on-site clinic or occupational-health surveillance, which would need a separate clinical module rather than this portal?
