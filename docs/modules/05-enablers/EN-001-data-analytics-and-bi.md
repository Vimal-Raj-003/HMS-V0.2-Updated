# EN-001 — Data Analytics & BI (Real-time KPIs, Drill-down, Benchmarking, Custom Widgets, Scheduled Reports)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-001 |
| Phase | 11 (KPI read-models seeded from Phase 1; dashboards incrementally per phase) |
| Priority | P1 |
| Complexity | High |
| Depends on | NC-011 (Reports & Analytics Engine — report builder/export; EN-001 is the dashboard/semantic layer on top), EN-007 (roles/ABAC scope), EN-041 (multi-branch consolidated reads), EN-024 (audit of PHI-level drill-down), EN-032/EN-009 (scheduled delivery), EN-037 (in-app alerts), NC-015 (NABH indicators), all transactional modules as event sources (OP-001, OP-002, OP-004, OP-005, IP-001, IP-005, NC-006, NC-009, EN-002, EN-006) |
| Feature flag | `module.bi.enabled` (sub: `bi.custom_widgets`, `bi.benchmarking`, `bi.scheduled_reports`, `bi.embedded`) |
| Primary roles | Hospital Admin / Group Admin (2), Medical Superintendent (4), HOD (5), Finance Manager (46), Quality Manager (54), Branch Admin (3) |
| Secondary roles | Doctor (own metrics), Nurse Supervisor, Pharmacy In-charge, Lab Quality Manager, Auditor (read-only), Super Admin (cross-tenant anonymised) |
| Regulatory | NABH 5th ed. quality indicators (KPI library), NABL TAT indicators, DPDP (aggregation-only for non-care roles; PHI drill-down audited), DPDP Rules 2025 (purpose limitation for analytics), GST MIS |

## 1. Purpose
EN-001 is the semantic layer and dashboard engine over the `analytics` schema: a governed KPI library (operational, clinical, financial, quality/NABH), role-based real-time dashboards, hospital → department → doctor → patient drill-down, benchmarking (dept-vs-dept, MoM, YoY, industry), a drag-drop custom widget builder, and scheduled report delivery. It never queries transactional tables live; every widget reads materialised views / summary tables refreshed by events and jobs. NC-011 owns the tabular report builder and exports; EN-001 owns KPIs, dashboards and widgets and reuses NC-011's dataset registry.

## 2. Users & Jobs-to-be-done
- **Hospital/Group Admin** (desktop, TV in boardroom): morning MIS at a glance (OPD count, IP census, revenue, collections, occupancy, lab TAT), branch comparison, drill to root cause. Daily.
- **HOD** (desktop/tablet): own department throughput, doctor productivity, TAT, revenue share, cancellations. Daily/weekly.
- **Doctor** (phone/tablet): own patients seen, avg consult time, revenue, follow-up conversion, prescriptions per visit. Weekly.
- **Finance Manager**: revenue by payer/service/dept, collection efficiency, AR aging (RC-005), discount leakage (RC-006), cost-per-patient. Daily.
- **Quality Manager (NABH)**: indicator scorecard vs threshold, monthly trend, CAPA linkage. Monthly + live.
- **Nurse Supervisor / Bed Manager**: census, ALOS, bed turnover, pending discharges, nurse:patient ratio.
- **Auditor**: read-only, exports audited.
- **Super Admin**: anonymised cross-tenant benchmarks (opt-in tenants only).

## 3. Core Workflows

### 3.1 KPI computation pipeline
1. Transactional module emits domain event (e.g. `bill.finalized`, `bed.released`, `lab.result.final`) → outbox → Redis Stream → **analytics worker** upserts into event-derived summary tables (`analytics.fact_*`, grain = 15 min buckets per hospital/branch/department/doctor) → Event `analytics.fact.updated`.
2. `pg_cron` refreshes materialised views (`analytics.mv_kpi_daily`, `mv_kpi_hourly`) every 5 min (concurrently); heavy month-end views nightly at 01:00 hospital TZ.
3. Real-time tiles (OPD count today, current census, collections today) read from Redis hash `bi:live:<hospital>:<kpi>` maintained by the worker (write-through), fallback to MV; auto-refresh every 30 s (per source requirement) via Socket.IO channel `bi:<hospital>:<dashboard>`.
4. Freshness stamp displayed on every widget ("as of 09:42:10"); stale > 10 min → amber badge; refresh failure → Event `analytics.refresh.failed` → IT Admin alert.

### 3.2 Role-based dashboard resolution
1. User opens `/analytics` → System resolves role templates → default dashboard (Admin: hospital overview; HOD: department; Doctor: personal) → applies ABAC scope filter (`own_department_only`, `own_patients_only`, branch list) as mandatory SQL predicate on every dataset → renders.
2. Users may clone the default and personalise (add/remove widgets, layout) → saved as `bi_dashboards` (owner_user_id); admin may publish dashboards to roles.

### 3.3 Drill-down
1. Click a KPI tile → level 1 breakdown (hospital → branch → department) → level 2 (doctor/unit) → level 3 (patient-level list: UHID, visit no, amount) → level 4 (open source record in owning module).
2. Patient-level drill for non-care roles requires `report.phi.read` and is logged `READ_PHI` (EN-024) with dashboard id and filter context; date-range and dimension filters persist across levels; breadcrumb back-navigation.

### 3.4 Benchmarking
1. Department-vs-department (same KPI, same period), Month-over-Month, Year-over-Year, branch-vs-branch (EN-041), doctor-vs-department-average.
2. Industry benchmark: seeded reference table (`bi_benchmarks`: NABH indicator thresholds, published Indian private hospital medians; editable) → variance shown as ▲/▼ with colour semantics; opt-in anonymised cross-tenant peer benchmark computed by Super Admin job (k-anonymity ≥ 5 hospitals).

### 3.5 Custom widget builder
1. User picks dataset (from NC-011 registry, e.g. `ds_op_visits`, `ds_revenue_lines`) → drags dimensions (date, dept, doctor, payer, service group) & measures (count, sum, avg, p95) → chart type (bar, line, area, pie/donut, heatmap, stat tile, table, funnel, gauge) → filters → preview (query limited to 50k rows, 5 s timeout) → save to personal dashboard or submit for publishing → Event `analytics.widget.created`.
2. Widget query stored as JSON spec (not raw SQL); compiled by server to Kysely over MVs; validated against allowed columns per role.

### 3.6 Scheduled reports
1. Admin configures: dashboard/report + frequency (cron, hospital TZ, e.g. daily 08:00 MIS) + recipients (users/roles/emails/WhatsApp numbers) + format (PDF snapshot, XLSX, CSV, inline HTML) → `bi_schedules`.
2. Worker renders (Playwright PDF of dashboard at 1280 px, dark or light theme per setting) → sends via EN-032 email / EN-009 WhatsApp document → `bi_schedule_runs` with status; failure retried 3× then IT alert. Recipients outside the tenant require `bi.schedule.external` and PHI-free datasets only.

### 3.7 Alerts on metrics
1. Threshold rules on KPIs (e.g. ICU occupancy > 90 %, collections < 80 % of billing, lab TAT breach > 10 %) → evaluated on refresh → EN-037 notification to role → Event `analytics.kpi.threshold_breached`.

### 3.8 Embedded charts
- Other modules embed widgets by id (`<BiWidget id=… scope=…>`) with the same scope enforcement (e.g. HOD dashboard in OP-002, cash counter summary in NC-001).

## 4. Data Model (schema `analytics`)
- `bi_kpi_definitions` — id, hospital_id (null = system), key (`opd_visits`, `ip_census`, `revenue_gross`, `collection_net`, `bed_occupancy_pct`, `alos_days`, `lab_tat_p90_min`, `nabh_*`), name, category (operational/clinical/financial/quality/hr/inventory), unit, aggregation (sum/avg/count/pct/p90), numerator_sql_ref, denominator_sql_ref, source_mv, dimensions_allowed[], phi_level (none/aggregate/patient), direction (higher_better/lower_better), default_target, nabh_indicator_code, version, effective_from. UNIQUE(hospital_id, key, version).
- `bi_kpi_targets` — hospital_id, branch_id, department_id, kpi_key, period (month/quarter/year), target_value, threshold_warn, threshold_crit.
- `bi_dashboards` — id, hospital_id, owner_user_id (null = system/published), name, role_keys[], layout jsonb (grid 12-col), theme, is_default_for_roles, version.
- `bi_widgets` — id, hospital_id, dashboard_id, type, title, dataset_key, spec jsonb (dimensions, measures, filters, chart, drill_path), position jsonb, refresh_sec, phi_level.
- `bi_datasets` — key, name, source_mv/table, columns jsonb (name, type, role_visibility), row_scope_columns (branch_id, department_id, doctor_id, patient_id), owner_module.
- `bi_schedules` — id, hospital_id, dashboard_id/report_id, cron, tz, format, recipients jsonb, filters jsonb, active, last_run_at, next_run_at.
- `bi_schedule_runs` — schedule_id, started_at, finished_at, status, file_id, error.
- `bi_benchmarks` — id, hospital_id (null=global), kpi_key, source (nabh/industry/peer/internal), value, period, notes.
- `bi_alert_rules` / `bi_alert_events` — kpi_key, scope, operator, threshold, window, notify_roles[]; fired_at, value, acknowledged_by.
- `fact_visits_15m`, `fact_revenue_15m`, `fact_beds_daily`, `fact_lab_tat_daily`, `fact_pharmacy_daily`, `fact_ot_daily`, `fact_er_daily`, `fact_claims_daily`, `fact_queue_15m` — grain columns (hospital_id, branch_id, bucket_ts, department_id, doctor_id, payer_id …) + measures; partitioned monthly (pg_partman); indexes (hospital_id, bucket_ts desc, department_id).
- MVs: `mv_kpi_hourly`, `mv_kpi_daily`, `mv_kpi_monthly`, `mv_doctor_productivity`, `mv_payer_mix`, `mv_nabh_indicators_monthly`, `mv_cost_per_patient` (later).
- Row-level scope enforced by SQL predicate injection (not RLS on MVs) using `app.hospital_ids`, `app.branch_ids`, `app.department_ids`, `app.user_id`.

## 5. Business Rules & Validations
- No widget may reference a transactional schema table; dataset registry validates `source` ∈ analytics.*.
- Query guardrails: max 50k rows, statement_timeout 5 s (interactive), 60 s (scheduled); auto-downgrade granularity when range > 92 days (hour → day).
- KPI definitions are versioned/effective-dated; changing a formula creates a new version; historical values are not recomputed unless admin triggers backfill (audited).
- Doctor-level dashboards show only the doctor's own metrics unless HOD/Admin; comparative views show peers anonymised ("Dept average") unless `bi.doctor_compare.read`.
- Patient-level drill: `phi_level=patient` datasets require `report.phi.read`; export requires `report.export` and is audited with row count.
- Financial KPIs use finalised bills only (`bill.status in ('final','settled')`); cancelled/credit-noted amounts netted; currency per hospital; multi-branch consolidation converts at month-average rate if currencies differ.
- NABH indicators computed per NABH 5th ed. definitions (numerator/denominator stored explicitly, e.g. medication errors per 1000 patient-days, return to OT within 48 h, TAT for reports, % criticals communicated in 30 min); manual-entry indicators fed by NC-015.
- Scheduled reports with PHI datasets can only be sent to authenticated internal users (link to portal), never as attachment to external email.
- Retention: fact tables 5 years, MV history 3 years hot, older archived to S3 Parquet (export job).

## 6. API Surface (`/api/v1/bi`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET | /dashboards | list dashboards for user | report.dashboard.read | paginated |
| GET/POST/PATCH/DELETE | /dashboards/:id | CRUD; POST /dashboards/:id/publish | report.dashboard.configure | version check |
| GET | /widgets/:id/data?from&to&filters | widget data (scoped) | report.dashboard.read | cached 30 s |
| POST | /widgets/preview | preview custom widget spec | report.widget.create | 5 s timeout |
| GET | /kpis | KPI catalogue | report.kpi.read | |
| GET | /kpis/:key/series?grain&from&to&dims | time series | report.kpi.read | |
| GET | /kpis/:key/drill?level&parent | drill-down | report.kpi.read (+report.phi.read for patient level) | cursor |
| PUT | /kpis/:key/targets | set targets/thresholds | report.kpi.configure | |
| GET | /benchmarks?kpi | benchmark values | report.kpi.read | |
| GET/POST/PATCH | /schedules, /schedules/:id, POST /schedules/:id/run-now | scheduled reports | report.schedule.configure | idempotent run-now |
| GET | /schedules/:id/runs | run history | report.schedule.read | |
| GET/POST | /alerts/rules ; POST /alerts/:id/ack | KPI alerts | report.alert.configure/read | |
| GET | /datasets ; /datasets/:key/columns | dataset registry (from NC-011) | report.widget.create | |
| GET | /live/:dashboardId (WebSocket upgrade info) | subscribe to live tiles | report.dashboard.read | |
| POST | /admin/refresh?mv= | force MV refresh | admin.bi.refresh | audited |
| GET | /export?widgetId&format=xlsx|csv|png | export widget | report.export | audited |

## 7. Domain Events (outbox)
- `analytics.fact.updated` → {fact, hospital_id, bucket} → live tile cache invalidation.
- `analytics.refresh.failed` → {mv, error} → EN-037 IT alert.
- `analytics.kpi.threshold_breached` → {kpi_key, scope, value, threshold} → EN-037 to roles, NC-015 (if NABH indicator).
- `analytics.widget.created|published`, `analytics.dashboard.published` → audit.
- `analytics.schedule.sent|failed` → {schedule_id, recipients_count, file_id}.
- `analytics.export.performed` → {user, dataset, rows, phi_level} → EN-024.

## 8. Screens
- **Hospital Overview dashboard** (desktop, TV 1080p dark theme; auto-rotates pages on TV): stat tiles (OPD today, IP census, ER waiting, OT running, revenue MTD vs target, collections today, occupancy %, lab TAT p90), sparklines, department heatmap, payer mix donut, revenue trend (Recharts; ECharts for heatmap/large series). Shortcuts: `F` fullscreen, `R` refresh, `D` date-range picker, `1-9` switch dashboard tabs. Real-time via Socket.IO; freshness badge; empty state "No data for period"; error tile with retry.
- **Department dashboard (HOD)** (desktop/tablet): doctor productivity table (TanStack, virtualised), TAT, cancellations, revenue share, drill.
- **Doctor "My Metrics"** (phone/tablet, single pane): patients seen, avg consult time, follow-up conversion, top diagnoses, earnings (if permitted).
- **Finance dashboard**: revenue by service group/payer/dept, collection efficiency, discount %, AR aging (RC-005 feed), cash vs digital, GST summary.
- **NABH Quality Scorecard**: indicator grid with RAG vs threshold, monthly trend, CAPA links (NC-015).
- **Custom widget builder** (desktop): left dataset/field tree, drag-drop shelves (X, Y, colour, filter), chart picker, preview, save; `Ctrl+Enter` preview, `Ctrl+S` save.
- **Drill-down explorer**: breadcrumb, pivot table, patient list (masked until `report.phi.read`).
- **Scheduled reports admin**: list, cron builder (human-readable), recipient picker, last/next run, run history with file links.
- **KPI catalogue admin**: definitions, targets, thresholds, benchmarks, versions.
- Offline: dashboards read-only cached (last snapshot) in PWA; no editing offline.

## 9. Integrations
- NC-011 dataset registry & report builder (shared datasets, exports).
- EN-032 SMTP/SES for schedules; EN-009 WhatsApp document messages (PHI-free only).
- EN-018 TV signage renders published dashboards via device token.
- Optional external BI: read-only Postgres role on `analytics` schema for Metabase/Power BI/Superset (feature `bi.external_readonly`), Parquet exports to S3.
- AI-008 Conversational BI consumes the same dataset registry (later).

## 10. Reports & Analytics
- Daily MIS pack (PDF): OPD/IP/ER volumes, revenue & collections, occupancy, ALOS, OT utilisation, lab/rad TAT, pharmacy sales, top 10 procedures, payer mix, discounts, outstanding.
- Doctor productivity, department benchmarking, MoM/YoY variance, NABH indicator monthly report, cost-per-patient (Phase 12 with NC-008 cost centres), refresh health report (MV durations, staleness).

## 11. Notifications
- KPI threshold breach → in-app/push to configured roles (EN-037); daily MIS email/WhatsApp at configured time; refresh failure → IT Admin; scheduled report failure → owner.

## 12. Permissions (RBAC keys)
`report.dashboard.read` (all staff, scoped) · `report.dashboard.configure` (Admin, HOD for own dept) · `report.kpi.read` · `report.kpi.configure` (Admin, Quality Manager) · `report.widget.create` (Admin, HOD, Finance, Quality) · `report.widget.publish` (Admin) · `report.schedule.configure` / `report.schedule.read` · `report.alert.configure` · `report.phi.read` (MS, Quality Manager, Finance for billing rows; audited) · `report.export` · `report.benchmark.read` · `bi.doctor_compare.read` (Admin, MS, HOD) · `admin.bi.refresh` (IT Admin) · `bi.schedule.external` (Admin).

## 13. Non-functional
- Volumes: 2000-bed group, 5000 OP visits/day, 20k lab tests/day, ~2M outbox events/day → fact upserts ≤ 200 ms lag p95; MV refresh (hourly view) < 30 s; widget query p95 < 800 ms from MV, live tiles < 100 ms from Redis.
- Dashboard TTI < 2.5 s on tablet with 12 widgets (parallel fetch, skeletons, no waterfall); TV mode 1080p, contrast ≥ 4.5:1, dark theme.
- Read replica (`DATABASE_URL_RO`) for all BI reads; PgBouncer; statement timeouts.
- Accessibility: chart data available as table toggle; colour-blind-safe palette (packages/ui tokens); i18n numbers/currency (`en-IN` lakh/crore grouping toggle).
- Printing: dashboard PDF snapshot A4 landscape with hospital letterhead (EN-039).

## 14. Acceptance Criteria
1. Given a finalised OP bill event, when 60 s pass, then the "Revenue today" tile reflects the amount without page reload.
2. Given an HOD of Orthopaedics, when opening the department dashboard, then only Orthopaedics rows are returned even if the API filter is tampered (server-side scope).
3. Given a Doctor role, when viewing productivity comparison, then peer doctors are shown as "Dept average" only, unless `bi.doctor_compare.read`.
4. Given a KPI tile, when clicked through hospital → department → doctor → patient, then the patient level requires `report.phi.read` and writes a `READ_PHI` audit row with dashboard/filters.
5. Given a custom widget spec referencing a non-registered column, when previewed, then the API rejects with 400 and no SQL is executed.
6. Given a widget query exceeding 5 s, when run, then it is cancelled and the widget shows a "narrow your filters" error.
7. Given a scheduled daily MIS at 08:00 IST, when the job runs, then a PDF is emailed to recipients by 08:05 and a run row records success; on SMTP failure it retries 3× and alerts the owner.
8. Given a PHI-level dataset, when a schedule targets an external email, then save is blocked with an explanatory error.
9. Given ICU occupancy crossing 90 %, when the MV refreshes, then a threshold breach notification reaches the Bed Manager and Medical Superintendent within 5 min.
10. Given a KPI formula change, when saved, then a new version is created and previous months are unchanged until backfill is explicitly run (audited).
11. Given a TV device token, when the overview dashboard is displayed, then it auto-refreshes every 30 s and shows a freshness stamp; if refresh fails 3× the tile turns amber.
12. Given a multi-branch group admin, when comparing branches, then per-branch KPIs align to each branch's timezone day boundaries.
13. Given an export of a patient-level drill list, when downloaded, then `analytics.export.performed` is emitted with row count and the file has a footer "Confidential – exported by <user> at <time>".
14. Given the NABH scorecard, when a month has a manual indicator not yet entered in NC-015, then the tile shows "Pending entry" rather than 0.

## 15. Enhancements / Later phases
- Conversational BI (NLP queries) → AI-008; AI anomaly detection on ops metrics, predictive models (patient volume, revenue projection, inventory demand, staffing forecast) → AI-005 surfaced as widgets.
- Cost-per-patient analytics (activity-based costing with NC-008), population health & social determinants dashboards, protocol-wise outcome analytics (IP-020), peer benchmarking marketplace (opt-in), Excel add-in / ODBC endpoint (market), auto-generated executive summary narrative (LLM), Chromecast/TV rotation of dashboards (market).

## 16. Open Questions for the Hospital
1. Which 15–20 KPIs must be on the CEO/MS overview on day one, and what are the targets per month?
2. Fiscal calendar (April–March) and hospital day boundary (00:00 or shift-based 08:00) for "today" metrics?
3. Do doctors see their own revenue/earnings? Do HODs see doctor-wise revenue? Any board-restricted metrics?
4. Which NABH indicators are currently tracked manually, in what format (numerator/denominator sheets)?
5. Preferred delivery of daily MIS (email PDF, WhatsApp, both) and recipients; time of day?
6. Existing BI tools (Power BI/Tableau) needing read-only access to the analytics schema?
7. Multi-branch: consolidated currency and whether branch admins may see sibling branch KPIs?
8. Retention period for granular fact data and whether de-identified data may be used for peer benchmarking?
