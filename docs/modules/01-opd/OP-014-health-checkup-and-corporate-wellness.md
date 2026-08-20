# OP-014 — Health Check-Up Packages & Corporate Wellness (Package config, Booking, Workflow routing, Status board, Consolidated report, Health score, Corporate B2B)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Module ID       | OP-014                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase           | 8 (bookings/billing pieces usable from Phase 5 via OP-023)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Depends on      | OP-023 (package definition/pricing engine — OP-014 owns _health-check_ package semantics: station routing, report consolidation), OP-001 (registration/appointments/queue), EN-006 (multi-station token routing), OP-007 (vitals station), OP-004 (lab, phlebotomy), OP-008 (radiology), OP-029/OP-030/OP-025/OP-026/OP-028 (ECG/TMT/Echo, PFT, eye, dental, audiometry stations), OP-002 (physician consult & summary), OP-011 (dietician), OP-013 (flu drives), OP-005 (billing; advance), NC-012 (B2B corporate invoicing), PE-006 (corporate client portal), PE-001/OP-020 (patient report access), EN-009 (SMS/WhatsApp), EN-010 (online payment), EN-018 (status board TV), EN-011 (ABDM HealthDocumentRecord/WellnessRecord), EN-036 (bulk employee upload), NC-026 (CRM leads/renewals), PE-005 (wellness programme), NC-035 (camps), EN-030 (feedback) |
| Feature flag    | `module.health_checkup.enabled` (sub: `hc.corporate_portal`, `hc.health_score`, `hc.wellness_dashboard`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Primary roles   | Health check-up coordinator/Receptionist (24), Nurse — OPD (16), Physician (6), Lab/Radiology techs (33/36), Corporate/B2B billing (29)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Secondary roles | Corporate HR client (61, portal), Dietician (39), Marketing/CRM (55), Billing (27), Patient (portal), Quality (54, TAT), Auditor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Regulatory      | NABH (report accuracy, critical value communication even in preventive context), NABL (lab reports within consolidated PDF), PC-PNDT (no sex disclosure in USG within packages), Radiation justification (AERB: chest X-ray in packages needs indication policy), GST (packages composite supply — healthcare exempt but wellness/executive extras may be taxable; NC-012), Income-tax Sec 80D preventive health check-up receipt format, DPDP (corporate sharing of employee results only with employee consent; aggregate-only for employer), Factories Act/OSHA-style periodic medical exams (Form 32/pre-employment) for corporates                                                                                                                                                                                                                         |

## 1. Purpose

OP-014 sells and executes preventive health check-ups: admin configures tiered packages (Basic/Advanced/Executive/Corporate/Women/Senior/Cardiac/Diabetic/Pre-employment) composed of labs, radiology, cardiac tests, specialist consultations and dietician; patients or corporate HR book with online advance; on check-in the system generates a **station task sequence** (vitals → phlebotomy → radiology → ECG/TMT → consult) with a live status board; all results auto-collate into a consolidated report with a computed health score, trend comparison against previous check-ups and physician summary; corporate B2B management covers bulk employee upload, batch scheduling, employer dashboards (aggregate, consented) and consolidated invoicing (NC-012).

## 2. Users & Jobs-to-be-done

- **Coordinator** (desktop + tablet on floor; 50–300 check-ups/day in enterprise, peaks 07:00–11:00 fasting): manage bookings, check-in, print routing slip/wristband, watch station board, chase pending stations, ensure report closure same day/next day, deliver reports.
- **Nurse/technicians**: complete station tasks from their normal worklists (OP-007/OP-004/OP-008/OP-029) — check-up tasks flagged with package badge and priority.
- **Physician**: review consolidated results, add summary/advice, sign; refer abnormal findings to specialists.
- **Corporate HR** (portal PE-006): upload employees, choose package/dates, track completion %, download aggregate reports/invoices; employees book their own slots.
- **Corporate billing**: contract rates, invoices, SOA (NC-012).
- **Marketing**: annual renewal campaigns, lead conversion (NC-026).

## 3. Core Workflows

### 3.1 Package configuration (uses OP-023 engine, `package_kind=health_check`)

1. Admin defines tier (Basic/Advanced/Executive/Corporate/custom) → components: lab test profiles (OP-004 codes), radiology (OP-008), cardiac (ECG/TMT/Echo), PFT, audiometry, eye/dental checks, specialist consults (physician/gynae/cardio), dietician, vitals/BMI/body composition; gender/age variants (PSA men > 40, Pap/mammogram women, HbA1c/vit D add-ons), fasting requirements, duration estimate, station sequence template, report template & health-score model.
2. Pricing: package price vs à-la-carte total → **savings shown**; payer-specific (retail/corporate contract/insurer wellness); add-on tests menu; validity/expiry of prepaid vouchers; GST treatment per component (NC-012).
3. Publish → available in booking channels (front office, website widget EN-012, patient app OP-020, corporate portal PE-006).

### 3.2 Booking

1. Patient/HR selects package → tier → date/slot (capacity per station considered: phlebotomy chairs, TMT slots) → **advance payment** (online EN-010/Razorpay link or counter OP-005) → confirmation (SMS/WhatsApp with fasting instructions, what to bring, arrival time, map) → reminder D-1 (fasting reminder 20:00) and D0 morning.
2. Corporate: HR uploads employee list (EN-036 template: name/emp id/DOB/sex/mobile/email/package tier) → invites (SMS/email/WhatsApp) → employees self-book (or HR bulk-assigns dates) → capacity planning view; onsite camp option (NC-035: mobile registration, sample collection at office, results at hospital).
3. Reschedule/cancel policy (refund of advance per rules), no-show handling.

### 3.3 Execution routing

1. Check-in (scan/OTP) → registration merge (existing UHID) → consent → **routing slip** printed (QR + station list + order) and wristband optional → system creates orders for all included services (lab orders w/ fasting flags, radiology, ECG…) and a **task sequence** honouring dependencies (fasting sample first → breakfast → PPBS 2 h later → USG requires full bladder → TMT after ECG → consult last) and station load balancing → EN-006 tokens per station.
2. **Status board** (TV/desktop): per patient × station: Green done, Yellow in progress, Red pending, Grey NA; coordinator drags to re-sequence; station staff see check-up patients with package badge and "next station" hint; auto-progression events from OP-007/OP-004/OP-008/OP-029 (`vitals.recorded`, `lab.sample.collected`, `rad.study.completed`, `ecg.done`) mark tasks done; alerts if patient idle > 20 min or breakfast not given after fasting draw.
3. Consult: physician gets **check-up workspace** in OP-002 with results as they arrive (partial), abnormal flags, prior comparison; may add on-the-spot orders (billed as add-on with consent).
4. Day close: pending items (results awaited e.g. cultures/histopath, TMT scheduled next day) tracked; report readiness ETA.

### 3.4 Report consolidation

1. When all components final (or after cut-off with pending noted) → **consolidated report** built: cover, patient/package details, vitals & BMI, all lab results (NABL format sections, ranges, flags), radiology/ECG reports, specialist notes, **health score** (composite index: configurable weighted domains — cardiometabolic (BP/BMI/lipids/glucose/HbA1c), renal, hepatic, haematology, lifestyle (smoking/alcohol/activity), with risk calculators: ASCVD 10-yr, Framingham, IDRS/FINDRISC diabetes risk, eGFR CKD-EPI, FIB-4), **comparison table** vs previous check-ups (trend arrows improving/declining/stable per parameter), physician summary & recommendations (templated + free text), referrals, lifestyle advice (diet/exercise), follow-up plan; physician signs (EN-016) → PDF; delivered via portal/app/WhatsApp/email/print (courier log); ABDM push (EN-011) with consent.
2. Critical/abnormal values in a preventive context: OP-004/OP-008 critical alerts still fire to physician on duty; coordinator ensures patient contacted (log).
3. Corrections: addendum version.

### 3.5 Corporate management (B2B)

1. Corporate master (NC-012 customer): contract, package rates, credit terms, employee eligibility rules (dependants, annual limit), consent template for aggregate sharing, invoicing cadence.
2. Batch execution: employees scheduled across dates; HR portal (PE-006) shows completion %, no-shows, invoices; **corporate dashboard** (aggregate, k-anonymity ≥ 10, only with employee consent): common findings prevalence (hypertension, diabetes, dyslipidaemia, obesity, anaemia, vit D deficiency), risk distribution, department-wise (if provided), YoY trend, recommended wellness interventions; individual reports go only to the employee (and to employer only if pre-employment/fitness certificate consented/legally required — Form 32).
3. Billing: employee-level charge lines aggregated into corporate invoice (NC-012) with employee IDs; co-pay/add-ons billed to employee (OP-005); credit note on cancellations; SOA.
4. Wellness follow-through: employees with abnormal findings routed to PE-005 wellness programme/OP-011/specialist booking; annual auto-scheduler for renewal (NC-026 campaign, PE-002 reminders).

### 3.6 Exceptions

- Patient not fasting → reschedule fasting components (partial day) or convert to non-fasting profile with consent; equipment down → re-route; component refused → marked NA (no charge if à-la-carte config); package variance/add-ons need patient consent → OP-023 variance approvals; report held if payment pending (config).
- Offline: coordinator tablet caches board; station updates queue.

## 4. Data Model (schema `specialty` + OP-023 `billing.packages`)

- **hc_packages** (extends OP-023 `packages` with kind health_check): package_id, tier, gender enum(any/male/female), age_min/max, fasting_hours, station_sequence_template jsonb ([{station, depends_on, est_min}]), report_template_id, health_score_model_id, instructions_template_id, add_ons jsonb, valid_days, is_public, corporate_only, version.
- **hc_bookings**: id, hospital_id, branch_id, patient_id?, corporate_id?, employee_ref?, package_id, package_version, add_ons jsonb, scheduled_at, channel enum(front_office/web/app/corporate_portal/camp/call_centre), advance_bill_id?, payment_status enum(unpaid/advance/paid/corporate_credit), status enum(booked/confirmed/checked_in/in_progress/completed/report_ready/delivered/cancelled/no_show), instructions_sent_at, reminders jsonb, cancel_reason, refund_id?; index (hospital_id, branch_id, scheduled_at, status).
- **hc_episodes**: id, hospital_id, booking_id, patient_id, visit_id, checked_in_at, routing_slip_no, consent_id, orders jsonb ({lab_order_ids, rad_order_ids, ecg_order_id, consults[]}), completed_at, report_id?, physician_id, notes.
- **hc_station_tasks**: id, episode_id, station enum(registration/vitals/phlebotomy/breakfast/ppbs/radiology_xray/usg/mammo/ecg/tmt/echo/pft/audiometry/eye/dental/gynae/physician/dietician/other), seq, depends_on uuid[], status enum(pending/called/in_progress/done/skipped/na), token_id?, started_at, done_at, done_by, source_ref (vitals_id/order_id), wait_min; index (episode_id), (hospital_id, status, started_at).
- **hc_reports**: id, hospital_id, episode_id, patient_id, version, health_score numeric, domain_scores jsonb, risk_calcs jsonb (ascvd, framingham, idrs, egfr, fib4), comparison jsonb, summary text, recommendations jsonb, referrals jsonb, signed_by, signed_at, pdf_key, delivered jsonb ([{channel, at}]), status enum(draft/final/addendum), document_id.
- **hc_health_score_models**: id, hospital_id, name, domains jsonb ([{name, params:[{code, weight, scoring_bands}]}]), version.
- **hc_corporates** (NC-012 customer link): id, hospital_id, customer_id, name, contract_from/to, packages jsonb ({package_id, rate}), eligibility jsonb, consent_template_id, invoicing enum(monthly/per_batch), portal_enabled, spoc jsonb.
- **hc_corporate_batches**: id, corporate_id, name, uploaded_at, employees jsonb/rows in `hc_corporate_employees` (id, batch_id, emp_id, name, dob, sex, mobile, email, package_id, patient_id?, booking_id?, status enum(invited/booked/done/no_show/opted_out), consent_share_aggregate bool), completion stats.
- **hc_report_deliveries**: report_id, channel, recipient, at, status, courier_ref.

## 5. Business Rules & Validations

- Package components resolve to service catalogue codes; gender/age variant auto-selected; components not applicable → NA (no billing impact for package price; à-la-carte only if configured).
- Fasting components can only be marked done if fasting confirmed (or override with reason); PPBS task auto-scheduled 2 h after breakfast task.
- Station tasks complete only via source events (no manual "done" without reason) → prevents missed tests; report cannot be finalised with pending mandatory components unless physician marks "reported pending: X" (addendum later).
- Health score: computed only from finalised results; parameters missing → domain "insufficient data"; model versioned; displayed with disclaimer (not diagnostic).
- Comparison uses same LOINC/local codes across visits; unit harmonised; trend arrow direction per parameter (higher-is-worse vs better).
- Corporate aggregate dashboards: minimum cohort 10, no individual results; individual data to employer only with explicit consent or statutory fitness certificate template; DPDP purpose logged.
- Payment: retail advance ≥ configurable % (default 100 %) before check-in; corporate credit per contract; add-ons need consent & payment; report release can be held for unpaid balance (config).
- Reschedule ≥ 24 h free; < 24 h fee per policy; refund via OP-005 rules.
- Report versioning/addenda; PDF hash; delivered log immutable; 80D receipt format available.
- TAT targets: same-day report for standard packages (except cultures/histopath); tracked.

## 6. API Surface (`/api/v1/health-checkup`)

| Method       | Path                                                                        | Purpose                                     | Permission                                 | Idem | Pag    |
| ------------ | --------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------ | ---- | ------ |
| GET/POST/PUT | /packages (delegates OP-023)                                                | config incl. station template & score model | hc.package.configure                       | Y    | cursor |
| GET          | /packages/public?branch=                                                    | catalogue for web/app                       | public (rate-limited)                      | –    | –      |
| POST         | /bookings                                                                   | book (patient/corporate/web)                | hc.booking.create (or portal scope)        | Y    | –      |
| GET          | /bookings?date=&status=&corporate=                                          | list                                        | hc.booking.read                            | –    | cursor |
| PATCH        | /bookings/{id}                                                              | reschedule/cancel                           | hc.booking.update                          | Y    | –      |
| POST         | /bookings/{id}/check-in                                                     | create episode, orders, tasks, slip         | hc.episode.manage                          | Y    | –      |
| GET          | /board?date=&branch=                                                        | status board (socket)                       | hc.board.read                              | –    | –      |
| PATCH        | /tasks/{id}                                                                 | resequence/skip/na (reason)                 | hc.episode.manage                          | Y    | –      |
| GET          | /episodes/{id}                                                              | episode + results status                    | hc.episode.read                            | –    | –      |
| POST         | /episodes/{id}/report/build                                                 | consolidate + score                         | hc.report.create                           | Y    | –      |
| PUT          | /reports/{id}                                                               | summary/recommendations                     | hc.report.update                           | Y    | –      |
| POST         | /reports/{id}/sign, /deliver                                                | finalise, deliver                           | hc.report.sign / hc.report.deliver         | Y    | –      |
| GET          | /reports/{id}/pdf, /patients/{id}/comparison                                | outputs                                     | hc.report.read                             | –    | –      |
| POST/GET     | /corporates, /corporates/{id}/batches, /batches/{id}/employees (upload CSV) | corporate mgmt                              | hc.corporate.manage                        | Y    | cursor |
| POST         | /batches/{id}/invite, /batches/{id}/schedule                                | invitations, bulk assign                    | hc.corporate.manage                        | Y    | –      |
| GET          | /corporates/{id}/dashboard                                                  | aggregate (k-anon)                          | hc.corporate.dashboard.read (portal scope) | –    | –      |
| POST         | /corporates/{id}/invoice-run                                                | create NC-012 invoice for period            | hc.corporate.invoice                       | Y    | –      |
| GET          | /stats/dashboard, /reports/tat                                              | KPIs                                        | hc.report.read                             | –    | –      |

## 7. Domain Events (outbox)

- `hc.booking.created|rescheduled|cancelled|no_show` → EN-009, OP-005 advance, PE-006; `hc.episode.checked_in` {episode_id, orders} → OP-004/OP-008/OP-007/OP-029 orders + EN-006 tokens; `hc.task.done` (derived) → board; `hc.patient.idle` → coordinator alert; `hc.report.built|signed|delivered` → PE-001/OP-020, EN-011, NC-026 (renewal), PE-005 (wellness enrolment for abnormal); `hc.corporate.batch.uploaded|completed`, `hc.corporate.invoice.created` → NC-012.
- Consumes: `vitals.recorded`, `lab.sample.collected|result.final|result.critical`, `rad.study.completed|report.final`, `ecg.done`/`tmt.done` (OP-029), `consult.signed` (OP-002), `payment.received`, `package.variance.approved` (OP-023).

## 8. Screens (UI)

1. **Booking desk / web widget / app flow**: package cards with savings badge, comparison tool (patient-facing: side-by-side inclusions), slot picker with capacity, payment; `N` new booking; confirmation preview.
2. **Coordinator console** (desktop): today's list, check-in (`F3` scan/OTP), print slip (`Ctrl+P`), pending stations, idle alerts, report readiness, deliveries; real-time.
3. **Station status board** (TV 1080p dark + desktop): matrix patients × stations with colours, timers, next-station hint; auto-scroll; per-station queue view for staff.
4. **Physician check-up workspace** (desktop; within OP-002): results grid with flags & prior comparison, score preview, summary templates, referral buttons, `Ctrl+Enter` sign.
5. **Consolidated report viewer/PDF** (desktop/phone in portal): sections, trend arrows, score gauge, download.
6. **Corporate console** (desktop; hospital side) & **Corporate portal** (PE-006, HR): batch upload wizard with validation, invite tracking, completion %, invoices, aggregate dashboard (charts), fitness certificate list.
7. **Package configuration** (desktop admin) incl. station template designer and health-score model editor.

## 9. Integrations

- OP-023 pricing/inclusions; EN-006 tokens; EN-010 payment links; EN-009 templates (fasting instructions, reminders, report ready); EN-012 website widget; PE-006 corporate portal; NC-012 invoicing & GST; EN-036 CSV upload; EN-011 ABDM; EN-016 e-sign; email (EN-032) for corporate reports; NC-035 camps (mobile registration/offline).
- Failures: report build retries; delivery retries per channel with fallback (WhatsApp → SMS link → email).

## 10. Reports & Analytics

- Bookings/conversions by channel, revenue by package/tier/corporate, savings offered, station TAT & bottlenecks (avg wait per station), same-day report %, no-show rate, add-on uptake, abnormal finding prevalence (population), health-score distribution & YoY, corporate completion %, corporate AR (NC-012), renewal rate, campaign ROI (NC-026). Read models `analytics.hc_daily`, `analytics.hc_station_tat`, `analytics.hc_population_findings` (de-identified).

## 11. Notifications

- Patient/employee: booking confirmation + instructions (fasting from time, medications, bring reports), D-1 20:00 fasting reminder, D0 morning, station-next push (via OP-020), report ready link, follow-up/referral reminders, annual renewal.
- HR: invite batch status, completion summary weekly, invoice generated, dashboard ready.
- Staff: idle patient > 20 min, pending station > threshold, report pending > TAT, critical values (via OP-004/OP-008), unpaid check-in attempts.

## 12. Permissions (RBAC keys)

`hc.package.configure`, `hc.booking.create|read|update`, `hc.episode.manage|read`, `hc.board.read`, `hc.report.create|update|sign|deliver|read`, `hc.corporate.manage`, `hc.corporate.dashboard.read`, `hc.corporate.invoice`, `hc.report.read` (analytics), `hc.export`. Defaults: Coordinator/Receptionist — booking, episode manage, board, deliver; Physician — report create/update/sign; Station staff — board read; Corporate billing — corporate manage/invoice; Corporate HR (portal) — own corporate dashboard/batches; Marketing — analytics read; Patient — own reports.

## 13. Non-functional

- Enterprise: 300 check-ups/day/branch, 8–12 stations each; board updates < 2 s; consolidated PDF (30–60 pages) < 10 s in worker; CSV upload 10k employees < 60 s with validation report.
- Offline: coordinator tablet & camp registration offline (queue); board read-only cached.
- Print: routing slip (thermal 80 mm with QR), wristband (ZPL), report A4 (branded, NABL sections), 80D receipt.
- i18n: instructions/report summary in patient language; charts accessible with tables; RTL-ready.
- Privacy: employer aggregate only; individual data export audited; DPDP consent ledger entries per corporate sharing.

## 14. Acceptance Criteria

1. Given an Executive package (male, 45), when checked in, then lab (incl. PSA), chest X-ray, USG abdomen, ECG, TMT, physician and dietician tasks are created in dependency order and tokens issued; Pap smear is NA.
2. Given fasting sample not yet collected, when a nurse tries to mark breakfast done, then it is blocked; after `lab.sample.collected` for fasting profile, breakfast becomes available and PPBS auto-schedules +2 h.
3. Given all results final, when the physician signs, then the consolidated PDF includes NABL-format lab sections, radiology report, health score, trend arrows vs last year and is delivered to portal + WhatsApp within 1 min.
4. Given a previous check-up with LDL 160 and current 120, then comparison shows "improving" arrow; HbA1c 6.1 → 6.8 shows "declining".
5. Given a corporate batch upload with 500 rows including 5 invalid mobiles, then a validation report lists the 5 rows and 495 are invited; HR portal shows completion % updating live.
6. Given a corporate cohort of 8 completed employees, when HR opens the aggregate dashboard, then it shows "insufficient cohort (min 10)" and no findings.
7. Given a critical potassium result in a check-up patient, then the OP-004 critical alert reaches the physician on duty and the coordinator sees a red flag with "patient contacted" checkbox and log.
8. Given a patient idle 25 min after phlebotomy with no next station started, then the coordinator gets an alert and the board highlights the row.
9. Given advance not paid (retail), when check-in is attempted, then it is blocked with a pay-now option (payment link/counter) unless policy allows.
10. Given a monthly corporate invoice run, then NC-012 invoice lists each employee's package line, add-ons excluded (billed to employee), and GST per component rules.
11. Given a report addendum (late culture result), then a new version is created, previous PDF retained, and portal shows latest with addendum note.
12. Given a booking via the website widget, then the patient receives confirmation with fasting instructions and appears in the coordinator list for that date.

## 15. Enhancements / Later phases

- Sheet row 11 enhancements: AI health risk score from results (Phase 12 AI-002/AI-005 over the rules-based score), employer wellness dashboard (Phase 10 PE-006 — core aggregate above), lifestyle recommendation engine (Phase 10 PE-005/PE-003 templated; AI later), population norm benchmarking (Phase 11 EN-001), digital health passport (PE-001/ABDM), annual check-up auto-scheduler (Phase 10 NC-026/PE-002).
- Costed proposal line 1569 (package config, booking, routing, status board, consolidated report, health score, corporate) — core.
- (market) PCS Prodoc health check-up plan allocation/visit/service allocation, Aosta/SMART master health check-up, MocDoc corporate & insurance — covered; wearable data in reports (EN-042/OP-020) later; home sample collection for corporate (OP-004 home collection) Phase 10.

## 16. Open Questions for the Hospital

1. Current package tiers, inclusions, prices and corporate contract rates; add-on menu?
2. Station capacities/hours (phlebotomy chairs, TMT slots) and typical daily volume; do you offer breakfast (billing/inclusion)?
3. Health-score model preference (domains/weights) and risk calculators to show; disclaimer text; who signs reports?
4. Corporate sharing policy: aggregate only, or individual fitness certificates (Form 32/pre-employment) with consent?
5. Advance payment %, reschedule/cancellation fees, report hold on unpaid balance?
6. Report delivery channels & courier for printed copies; 80D receipt format?
7. Do you run onsite corporate camps requiring offline registration & sample logistics?
