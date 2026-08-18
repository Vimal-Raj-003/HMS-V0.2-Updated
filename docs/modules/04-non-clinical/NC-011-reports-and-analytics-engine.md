# NC-011 — Reports & Analytics Engine (MIS Dashboards, Custom Report Builder, Scheduling, Export, Govt Formats)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-011 |
| Phase | 11 (engine); operational report catalogue delivered incrementally from Phase 1 with each module (each module spec §10 lists its reports, which are registered in this engine's catalogue) |
| Priority | P0 |
| Complexity | High |
| Depends on | All source modules (their `analytics.*` read models), EN-001 (Data Analytics & BI — advanced KPI scorecards, benchmarking, predictive; NC-011 is the operational reporting/MIS engine and report builder; EN-001 layers executive BI on the same analytics schema), EN-007 (RBAC/data classes), EN-041 (multi-branch), EN-032/EN-009/EN-037 (delivery), EN-018 (TV dashboards), EN-024 (audit of exports), EN-026 (API for embedding), EN-019 (FHIR export where applicable), NC-009 (finance read models), NC-003 (MRD statistics), AI-008 (conversational BI later), AI-005 (anomaly detection later) |
| Feature flag | `module.reports.enabled` (sub: `reports.builder`, `reports.scheduler`, `reports.govt_formats`, `reports.embedding`, `reports.multi_branch`) |
| Primary roles | Hospital/Branch Admin (2/3), Medical Superintendent (4), Finance Manager (46), HODs (5), MIS/Analytics analyst (custom role), Quality (54) |
| Secondary roles | Every operational role for their module reports (with permission scoping), Auditor (58), Group Admin (EN-041), Management/Board (dashboards), Government reporting officer (HMIS/IDSP nodal) |
| Regulatory | HMIS/NRHM (MoHFW HMIS monthly facility formats), IDSP (weekly S/P/L forms — disease surveillance), NABH (indicator reporting — via NC-015), Clinical Establishments Act (statistics returns), state health department returns, MCCD/CRS (via NC-003/IP-017), NHCX/PMJAY reports (RC-007), DPDP (aggregation/de-identification for analytics, PHI export controls), Companies Act (financial MIS derived from posted books only) |

## 1. Purpose
NC-011 is the hospital's **reporting backbone**: a governed analytics schema (materialised views/summary tables refreshed by events and jobs), a **report catalogue** (every module's operational reports registered with parameters, permissions and formats), real-time **MIS dashboards** (OPD footfall, IP census, revenue, collections, outstanding, TAT, occupancy) with drill-down to detail, a **custom report builder** (drag-and-drop fields from curated datasets, filters, group-by, aggregates, charts, save/share/schedule), scheduled delivery (email/WhatsApp/portal/SFTP), export (PDF/Excel/CSV/JSON), embedding of widgets in role homes and TV boards, and **government/statutory formats** (HMIS, IDSP, NRHM). It never aggregates live transactional tables; it reads `analytics.*` and read replicas.

## 2. Users & Jobs-to-be-done
- **Management/admin** (desktop, dark analytics theme; TV in boardroom): daily MIS at a glance, drill-down by department/doctor/date, month-to-date vs target, multi-branch comparison.
- **HOD/department heads**: department dashboards (OPD count, revenue, TAT, occupancy, procedure volumes), doctor-wise performance (own dept only).
- **Finance**: revenue by department/doctor/payer/service, collection by mode/counter, outstanding ageing, discounts, refunds, GST summaries (from NC-009/OP-005 read models).
- **Clinical leadership/quality**: disease statistics (ICD), lab TAT, OT utilisation, ALOS, readmission, mortality, infection rates (feeds NC-015 indicators).
- **Operations**: bed occupancy, ER volumes/wait times, pharmacy sales, lab volumes, appointment no-show, queue waits.
- **MIS analyst**: build custom reports/datasets, schedule distributions, maintain catalogue and definitions.
- **Government reporting officer**: generate HMIS/IDSP files monthly/weekly, review, submit.
- **Any role**: run permitted catalogue reports with parameters, export, subscribe.

## 3. Core Workflows

### 3.1 Analytics schema & refresh
1. Each module publishes read models into schema `analytics` (per module spec §10) — either **event-projected summary tables** (updated by worker consumers within seconds: e.g. `analytics.revenue_daily`, `analytics.opd_visits_hourly`, `analytics.bed_census_snapshot`) or **materialised views** refreshed on schedule (`pg_cron` every 5/15/60 min or nightly) → **dataset registry** (`rpt_datasets`) describes each table/view: fields (name, type, label, description, PHI flag, aggregation defaults), joins/dimensions (date, branch, department, doctor, payer, service, item), grain, refresh policy, owner, permission required, freshness SLA → freshness monitor (last refresh, lag) visible on dashboards ("data as of 10:42").
2. Star-schema conformed dimensions: `dim_date` (FY, quarter, month, week, holiday), `dim_branch`, `dim_department`, `dim_doctor`, `dim_payer`, `dim_service`, `dim_item`, `dim_ward_bed`, `dim_employee` (SCD2 where names/mappings change).
3. Read replica connection for all report queries; query governor (timeouts, row caps, cost estimate) prevents runaway reports.

### 3.2 MIS dashboard (real-time)
1. Role home widgets & the **MIS dashboard**: tiles — OPD footfall today (new/follow-up, by dept), IP census (occupied/available by ward, admissions/discharges/deaths today), ER visits & triage mix, revenue today (billed) & collection today (by mode), outstanding (patient/payer/corporate), OT cases today, lab tests & TAT %, radiology studies, pharmacy sales, appointment no-show %, avg wait time (EN-006), critical alerts pending; auto-refresh via Socket.IO (event push) or 60 s poll → **drill-down**: click metric → department → doctor/service → date → detail list (permission-scoped; detail with PHI only for roles allowed) → export.
2. Comparison chips: vs yesterday/same day last week/MTD vs last month/target (targets configured per KPI per branch).
3. Multi-branch view (`reports.multi_branch`, EN-041): branch comparison table, group roll-up, ranking, normalised per bed.

### 3.3 Report catalogue (canned reports)
1. Registry of reports (`rpt_reports`): code, name, module, description, dataset(s)/SQL template (Kysely-typed, parameterised, no string interpolation), parameters (date range, branch, department, doctor, payer, status… with defaults & validation), output columns, sorting, grouping, totals, chart spec, formats (screen/PDF/Excel/CSV), permission key, PHI level, row-limit, cache TTL → users run with parameters → results table (virtualised) + charts → export → **saved views** (parameter presets, personal/shared) → subscribe (3.5).
2. Seeded catalogue (examples; each module adds its own): Revenue — department-wise, doctor-wise collection, service-wise, payer-wise (self/insurance/corporate/scheme), mode-wise collection, discount register, refund register, outstanding ageing, GST summary; Clinical — disease-wise stats (ICD chapter/block/code, age/sex), top diagnoses, lab TAT (order→result by test/priority), critical value TAT, OT utilisation (cases/hours/room), ALOS by dept/DRG, readmission (7/30 day), mortality (gross/net/<48 h), infection rates (IP-012), C-section rate; Operational — bed occupancy % (ward/day), ER volume & door-to-doctor, pharmacy sales/stock, lab/radiology volumes, appointment no-show, queue wait times, ambulance response (NC-013), turnaround for discharge (IP-002); HR/ERP — headcount/attrition, attendance, purchase spend, inventory value/expiry, AMC due (from their read models).
3. Report versioning: SQL/definitions versioned; changes reviewed (maker-checker for finance/statutory reports); test fixtures per report.

### 3.4 Custom report builder (`reports.builder`)
1. **Analyst/user** picks a **dataset** (curated, permission-filtered) → drag fields to columns/rows/values (dimensions & measures), filters (equals/in/range/relative dates "last 30 days"/parameters), group by, aggregates (sum/avg/count/distinct/min/max/percentile), calculated fields (safe expression language: arithmetic, if/else, date functions — compiled to SQL, no raw SQL for end users), sorting, top-N, pivot, totals → chart (bar/line/area/pie/table/KPI tile/heatmap) → live preview (row cap 5k in builder; full on run) → **save** as report (personal/department/hospital), share with roles/users, add to a **dashboard** (grid layout of widgets), schedule → engine compiles to parameterised SQL against replica with governor → Event `report.custom.created`.
2. Advanced (analyst permission): SQL mode against analytics schema only (read-only role, allow-list of schemas, EXPLAIN cost limit), publish to catalogue after review.
3. Data governance: PHI columns hidden unless role has `report.phi.read`; row-level filters applied automatically (branch scope, own department, own patients for doctors); export of PHI audited (EN-024) with watermark & row counts.

### 3.5 Scheduling & delivery (`reports.scheduler`)
1. Schedule any report/dashboard: cron-like (daily 07:00, weekly Mon, monthly 1st, FY-quarter), parameters (relative), recipients (users/roles/external emails/WhatsApp numbers with opt-in/SFTP/portal folder), format (PDF/Excel/CSV/inline HTML), conditions (send only if rows > 0 or KPI breaches threshold → **alert reports**), timezone → BullMQ jobs render (Playwright PDF for dashboards; ExcelJS/CSV streams) → deliver (EN-032/EN-009) → delivery log with retries; failure alerts to owner; unsubscribe link for non-mandatory → Event `report.scheduled.delivered|failed`.
2. Daily MIS email pack to management (PDF + Excel), month-end pack, department packs to HODs.

### 3.6 Export & embedding
- Export PDF (letterhead, parameters, "generated by/at", page numbers), Excel (typed columns, frozen headers, totals, multiple sheets), CSV, JSON API (`reports.embedding`, EN-026 keys) for external BI (Power BI/Metabase) with same permission model; embed widgets in EN-018 TV boards & role homes; deep links with parameters.

### 3.7 Government / statutory formats (`reports.govt_formats`)
- **HMIS (MoHFW) monthly facility report**: mapped indicators (OPD/IPD counts, deliveries, immunisation (OP-013), lab tests, deaths, surgeries, ANC (OP-040)…) auto-populated from datasets with manual override & remarks → Excel/CSV/portal-upload format (state variants) → sign-off → submission log; **IDSP weekly** (S/P/L forms: syndromic/presumptive/lab-confirmed counts by disease from ICD/lab results) → generation & nodal officer review; **NRHM/state returns**, Clinical Establishments statistics; notifiable disease line lists (with NC-015/IP-012); export/submit via portal upload (manual) or API where states provide (EN-017) → Event `report.govt.generated|submitted`.

### 3.8 KPI targets, alerts & anomalies
- KPI registry (definition, formula, dataset, owner, target/threshold per branch/dept/period, direction) → dashboards show RAG; threshold breach → alert (EN-037) to owner (e.g. lab TAT < 90 %, occupancy > 95 %, collection efficiency < target); anomaly detection (AI-005 later): sudden drops in OPD/revenue, spikes in discounts/refunds; NLP query (AI-008 later) — "show me last month OPD revenue" → maps to dataset & filters.

### 3.9 Seeded datasets (initial `analytics.*` contract — each owning module maintains its projection)
| Dataset | Grain | Owner | Key measures/dimensions | Refresh |
|---|---|---|---|---|
| `opd_visits_fact` | visit | OP-001/OP-002 | new/follow-up, dept, doctor, payer, wait minutes, consult minutes, no-show | event |
| `revenue_daily` / `bill_items_fact` | day × dept × doctor × payer × service / bill item | OP-005/IP-005 | gross, discount, tax, net, collected, refunds | event |
| `collections_fact` | receipt line | OP-005/NC-001 | mode, counter, cashier, shift, amount | event |
| `ar_ageing_snapshot` | day × party | NC-009/RC-005 | buckets, DSO | nightly |
| `ip_census_snapshot` | day × ward × bed | IP-001 | occupied/available/blocked, admissions/discharges/deaths/transfers | 15 m |
| `admissions_fact` | admission | IP-001/IP-002 | LOS, dept, DRG/ICD, outcome, readmission flag, discharge TAT | event |
| `er_visits_fact` | ER visit | OP-006/TR-001 | triage level, door-to-doctor, LWBS, disposition, ISS | event |
| `lab_orders_fact` | test | OP-004 | order→collect→result→verify timestamps, TAT, critical flag, analyzer | event |
| `rad_studies_fact` | study | OP-008 | modality, scheduled→acquired→reported TAT, dose | event |
| `ot_cases_fact` | case | IP-006/TR-004 | room, surgeon, planned vs actual times, utilisation, cancellations, implants | event |
| `pharmacy_sales_fact` | dispense line | OP-003 | drug, qty, value, margin, store | event |
| `stock_daily_snapshot` | day × store × item | NC-006 | qty, value, expiry days | nightly |
| `purchase_spend_monthly` | month × vendor × category | NC-005 | PO value, GRN value, cycle time | nightly |
| `hr_headcount_daily`, `hr_attendance_monthly`, `hr_payroll_monthly` | per NC-010 | NC-010 | headcount, attrition, absenteeism, cost | nightly |
| `quality_indicators_monthly` | month × indicator × branch | NC-015 | value, target | monthly |
| `fleet_kpis_daily` | day × branch | NC-013 | trips, response percentiles | event/nightly |
| `bmw_daily` | day × category | NC-016 | kg, bags | nightly |
| `patient_feedback_fact` | response | EN-030 | NPS, scores | event |
| `claims_fact` | claim | EN-002/RC-001 | submitted, settled, denied amounts, TAT | event |

### 3.10 Seeded MIS KPI definitions (examples)
- OPD footfall = count(visits) by day; new-patient ratio; average wait = P50/P90 of (consult_start − check_in).
- Bed occupancy % = occupied bed-days / available bed-days; ALOS = Σ LOS / discharges; BTR (bed turnover rate).
- Revenue = Σ net bill items by service date; collection efficiency = collected / billed (period); outstanding = AR snapshot; discount % = discounts / gross.
- Lab TAT compliance = tests within target / total (by priority); critical value notification TAT.
- OT utilisation = in-room minutes / available minutes; first-case on-time start %; cancellation rate.
- ER: door-to-doctor P50/P90, LWBS %, ESI mix; readmission rate 30-day; mortality gross/net.
- Pharmacy: sales, margin %, stock-outs; Inventory: days on hand, expiry value at risk.
- HR: attrition %, absenteeism %, nurse-bed ratio; Finance: EBITDA, ARPOB, DSO/DPO.

### 3.11 Exceptions & data-quality handling
- Late-arriving facts (back-dated bills, corrected results) → projections upsert by natural key; daily "restatement" job re-aggregates affected days; dashboards mark restated periods.
- Cancelled/voided documents → negative rows or status flags, never deletes; reports default to exclude cancelled with toggle.
- Patient merges (OP-001) → dimension re-pointing job; historical counts unaffected.
- Timezone: facts stored UTC, aggregated by hospital-local day; DST-free India but multi-region ready.
- Slow-dimension changes (doctor moves department) → SCD2 effective-dated; "as-was" vs "as-is" reporting toggle.

## 4. Data Model (schema `analytics` for data; `core` prefix `rpt_` for metadata)
- **rpt_datasets**: id, hospital_id? (null = system), code, name, source_type enum(table/mview/summary), source_name, grain, description, refresh_policy enum(event/5m/15m/hourly/nightly), last_refreshed_at, freshness_sla_minutes, owner_module, permission_key, phi_level enum(none/limited/full), is_active; **rpt_dataset_fields** (dataset_id, name, label, type enum(string/number/date/timestamp/boolean/money/duration), role enum(dimension/measure/attribute), default_agg, is_phi, description, lookup_dim?).
- **rpt_dimensions**: dim_date, dim_branch, dim_department, dim_doctor (SCD2), dim_payer, dim_service, dim_item, dim_ward_bed, dim_employee — physical tables in `analytics`.
- **rpt_reports**: id, hospital_id? (system/custom), code, name, module, description, kind enum(canned/custom/sql/govt), definition jsonb (dataset, fields, filters, groups, aggregates, calc fields, sort, chart, pivot) | sql_template (canned/sql kinds), parameters jsonb [{name, type, required, default, options_source}], permission_key, phi_level, row_limit, cache_ttl_seconds, version, status enum(draft/published/deprecated), owner_user_id, visibility enum(private/department/hospital/system), reviewed_by, created_at. UNIQUE (hospital_id, code, version).
- **rpt_saved_views**: report_id, user_id, name, parameters jsonb, shared_with jsonb.
- **rpt_dashboards**: id, hospital_id, name, owner_user_id, visibility, layout jsonb (widgets: report_id/kpi_id, params, size, position, refresh), role_home_binding?, tv_binding? (EN-018); **rpt_widgets** optional normalisation.
- **rpt_kpis**: id, hospital_id, code, name, dataset_id, formula, unit, direction enum(higher_better/lower_better), owner_role, phi_level; **rpt_kpi_targets** (kpi_id, branch_id, department_id?, period_type, target, warn_threshold, critical_threshold, effective_from); **rpt_kpi_values** (kpi_id, branch_id, department_id?, period, value, computed_at) — read model.
- **rpt_schedules**: id, hospital_id, report_id/dashboard_id, cron, timezone, parameters jsonb, recipients jsonb [{type: user/role/email/whatsapp/sftp/portal, value}], format enum(pdf/xlsx/csv/html/json), condition jsonb (rows>0, kpi breach), owner_user_id, is_active, next_run_at, last_run_at; **rpt_schedule_runs** (schedule_id, started_at, finished_at, status enum(success/failed/skipped_condition), file_id, rows, error, deliveries jsonb [{recipient, status, provider_ref}]).
- **rpt_runs** (ad-hoc executions log): report_id, user_id, parameters, started_at, duration_ms, rows, exported_format?, phi_exported bool, ip. Partitioned monthly.
- **rpt_govt_submissions**: id, hospital_id, branch_id, format enum(hmis_monthly/idsp_weekly/nrhm/state_return/ce_stats), period, generated_file_id, data jsonb (indicator values with source/override), overrides jsonb, reviewed_by, submitted_by, submitted_at, ack_ref, status enum(draft/reviewed/submitted/acknowledged/rejected).
- **rpt_govt_mappings**: format, indicator_code, label, dataset_id, expression, unit, notes.
- **rpt_query_governor** (config): max_rows, timeout_ms, max_cost, concurrency per role; **rpt_cache** (Redis keys with TTL per report+params+scope hash).
- Analytics tables partitioned by month where large (visit facts, revenue facts, lab TAT facts); indexes on (hospital_id, date, branch_id, department_id); RLS on analytics tables (hospital) with group policies for EN-041.

## 5. Business Rules & Validations
- Reports read only from `analytics.*` (or explicitly whitelisted read models) via read replica; no live OLTP aggregation; query governor enforced (timeout default 30 s, rows 100k on export, 5k on screen page virtualised).
- Every report/dataset has a permission key; row-level scoping (branch, department, own patients) applied server-side from the user's ABAC context — never trusted from client parameters; PHI columns require `report.phi.read`; PHI exports audited with watermark and row count; bulk export limits per role/day.
- Financial reports must reconcile to posted books: revenue/collection reports built from OP-005/IP-005/NC-001/NC-009 read models with reconciliation checks (daily job compares MIS revenue vs GL revenue; discrepancies flagged on the dashboard as "unreconciled").
- Freshness displayed on every widget; stale beyond SLA → grey badge and alert to owner.
- Custom reports: expression language sandboxed; no raw SQL for non-analyst roles; analyst SQL restricted to `analytics` schema read-only role with cost cap; publishing to hospital catalogue requires review (maker-checker) for finance/PHI datasets.
- Schedules deliver only to recipients allowed to see the report (role check at send time; external emails require `report.external.share` and no PHI unless DPO-approved template); WhatsApp delivery only with opt-in and non-PHI summaries; SFTP with key auth.
- Government submissions: generated values traceable to datasets; overrides require reason; submitted versions immutable; resubmission creates new version.
- Report definitions versioned; deprecated reports remain runnable for history with banner; catalogue codes unique.
- Retention: run logs 2 years; scheduled outputs 90 days (configurable), government submissions permanent.

## 6. API Surface (`/api/v1/reports`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /catalogue?module=&q= ; GET /catalogue/{code} | list/describe reports | report.catalogue.read (+ report-specific key) | – | cursor |
| POST | /run/{code} (params) → job or sync | execute | report.run + report key | Y | cursor (result pages) |
| GET | /runs/{id}, /runs/{id}/export?format= | results/export | report.run / report.export | – | – |
| GET | /datasets ; GET /datasets/{id}/fields ; GET /datasets/{id}/preview | builder metadata | report.builder.use | – | – |
| POST/PUT/DELETE | /custom ; POST /custom/{id}/(preview|publish|share) | custom reports | report.builder.use / report.custom.publish | Y | cursor |
| POST | /sql/preview, /sql/publish (analyst) | SQL mode | report.sql.use / report.custom.publish | Y | – |
| GET/POST/PUT | /dashboards ; GET /dashboards/{id}/data | dashboards | report.dashboard.read / .manage | Y | – |
| GET | /mis/summary?branch=&date= ; GET /mis/drill?metric=&by=&filters= | MIS dashboard | report.mis.read | – | cursor |
| GET/POST/PUT | /kpis, /kpis/{id}/targets ; GET /kpis/values?period= | KPI registry | report.kpi.manage / .read | Y | – |
| GET/POST/PUT/DELETE | /schedules ; POST /schedules/{id}/(run-now|pause|resume) ; GET /schedules/{id}/runs | scheduling | report.schedule.manage (own) / report.schedule.admin | Y | cursor |
| POST | /saved-views ; GET /saved-views?report= | presets | report.run | Y | – |
| GET | /freshness | dataset freshness | report.catalogue.read | – | – |
| POST | /govt/{format}/generate?period= ; POST /govt/{id}/(override|review|submit) ; GET /govt?format= | statutory | report.govt.generate / .submit | Y | cursor |
| GET | /embed/{widgetId}?token= (EN-026 key) | embedding | report.embed.read | – | – |
| GET | /admin/runs?user=&phi=true ; GET /admin/governor | audit/admin | report.admin | – | cursor |
| POST | /nlq (AI-008 later) | natural-language query | report.nlq.use | – | – |

## 7. Domain Events (outbox)
- `report.custom.created|published|deprecated` {report_id, owner} → catalogue cache, audit.
- `report.scheduled.delivered|failed` {schedule_id, run_id, recipients} → owner notifications, EN-037.
- `report.phi.exported` {user, report, rows} → EN-024, DPO daily digest.
- `report.kpi.breached` {kpi, branch, value, threshold} → EN-037 (owner), NC-015 (quality indicators), EN-018 (TV banner optional).
- `report.dataset.stale` {dataset, lag} → module owner, IT.
- `report.govt.generated|submitted` → compliance calendar (NC-023).
- `report.reconciliation.mismatch` {date, mis_revenue, gl_revenue} → finance.
- Consumes: all `analytics`-relevant events (revenue, visits, admissions, lab, OT, HR, inventory, finance) via worker projections; `finance.period.closed` (mark month final), `mrd.statistics.published` (NC-003), `quality.indicator.computed` (NC-015), `branch.created` (EN-041 dims), `user.role.changed` (EN-007 → invalidate scoped caches).

## 8. Screens (UI)
- **MIS dashboard** — desktop (dark analytics theme) & TV (EN-018 1080p full-screen rotating pages): KPI tiles with sparklines & comparison chips, department/doctor drill panels, branch switcher/compare, date picker (today/MTD/custom), freshness badges; realtime push; `D` drill, `E` export, `F` fullscreen; loading skeletons; "no data for range" empty state.
- **Report catalogue & runner** — desktop/tablet: search/filter by module, favourites, parameter form (validated), results grid (virtualised, column chooser, totals), chart toggle, export menu, save view, subscribe; `Ctrl+Enter` run, `Ctrl+E` export.
- **Report builder** — desktop: left dataset/fields tree (PHI badges), canvas (rows/columns/values/filters), calc field editor with validation, chart config, preview, save/share/schedule; keyboard drag alternatives (accessibility).
- **Dashboard designer** — desktop: grid layout, widget picker, per-widget params, publish to role home/TV.
- **Schedule manager** — desktop: list, run history, delivery status, retry.
- **KPI registry & targets** — desktop (admin/quality).
- **Government reporting** — desktop: format picker, period, auto values with source links, override with reason, review, generate file, mark submitted with ack.
- **Admin** — datasets/freshness, governor, run audit (PHI exports).
- Phone: MIS summary cards & scheduled report viewer (read-only), KPI alerts.
- Offline: last-loaded MIS snapshot cached read-only with "as of" stamp.

## 9. Integrations
- Read replica (`DATABASE_URL_RO`), Redis cache, BullMQ scheduler, Playwright PDF, ExcelJS/CSV streaming, S3 for outputs; EN-032 email, EN-009 WhatsApp (templates), SFTP client, EN-026 API keys for external BI (Power BI/Metabase/Superset via JSON/CSV endpoints or direct read-only DB user to `analytics` schema on replica — optional), EN-018 TV boards, EN-041 group scope, AI-008/AI-005 later; government portals (HMIS/IDSP) — file upload manual, API where available via EN-017.

## 10. Reports & Analytics (about the engine itself)
- Report usage (runs by report/user), slow queries, cache hit ratio, schedule success/failure, PHI export audit, dataset freshness SLA compliance, KPI breach history, government submission calendar; read models: `analytics.rpt_usage_daily`, `analytics.rpt_freshness`.

## 11. Notifications
- Scheduled report deliveries (email/WhatsApp/portal), failure alerts to owners, KPI threshold breaches (push/email to KPI owners), stale dataset alerts (IT/module owners), government submission reminders (T-5/T-1 days), PHI export digest to DPO, reconciliation mismatch to finance.

## 12. Permissions (RBAC keys)
`report.catalogue.read`, `report.run` (+ per-report keys e.g. `report.revenue.read`, `report.clinical.read`, `report.operational.read`, `report.hr.read`, `report.inventory.read`, `report.finance.read`), `report.export`, `report.phi.read`, `report.external.share`, `report.builder.use`, `report.sql.use` (analyst), `report.custom.publish` (reviewer), `report.dashboard.read/manage`, `report.mis.read`, `report.kpi.read/manage`, `report.schedule.manage/admin`, `report.govt.generate/submit`, `report.embed.read` (device/API keys), `report.nlq.use`, `report.admin`. ABAC: branch scope, `own_department_only` (HOD), `own_patients_only`/`self_only` (doctor earnings), group scope for EN-041 roles; auditor read-only with export audit.

## 13. Non-functional
- Volumes: 5,000 OP visits/day, 400 admissions/day, 20k lab tests/day, 12k receipts/day → analytics facts ~150k rows/day; MIS dashboard p95 < 800 ms from summary tables; catalogue report p95 < 3 s for 1-month ranges (indexes/partitions), heavy reports async with progress; concurrent report users 300; scheduled jobs 2,000/day; export 100k rows Excel < 60 s streaming.
- Refresh: event projections < 10 s lag; mviews per policy; nightly rebuilds partitioned; replica lag monitored (< 5 s).
- Availability: engine failures never affect OLTP; governor kills runaway queries; cache invalidation by events.
- Security: RLS on analytics, PHI masking, watermark, export audit, API keys scoped, rate limits; DPDP de-identification for external sharing.
- Accessibility: charts with data tables & ARIA descriptions, colour-blind safe palettes, keyboard builder; i18n numbers/dates (Indian grouping), RTL; printing A4 landscape PDFs with letterhead.

## 14. Acceptance Criteria
1. Given a receipt is confirmed at a counter, then within 10 s the MIS "collection today" tile updates and drill-down shows the receipt in the mode/counter breakdown.
2. Given an HOD of Orthopaedics opens doctor-wise collection, then only Ortho doctors are listed (row scoping) and the export is watermarked and audited.
3. Given a user without `report.phi.read` builds a custom report on visits dataset, then PHI fields (name, phone) are not selectable and API rejects them if injected.
4. Given a custom report with calc field `net/gross*100` grouped by department for last 30 days, then preview returns within 5 s and saved report can be scheduled daily 07:00 to two roles as Excel; recipients without permission are skipped and logged.
5. Given a report whose query exceeds 30 s or 100k rows, then the governor cancels it with a helpful message suggesting narrower filters or async run.
6. Given day-end, when the reconciliation job finds MIS revenue ₹1,00,000 ≠ GL revenue ₹98,500, then the dashboard shows an "unreconciled" flag and finance is alerted with the difference.
7. Given the HMIS monthly format for a branch, then indicators auto-populate from datasets with source links; an override requires a reason; the generated file matches the state template and submission is logged as immutable version 1.
8. Given a KPI "lab TAT within target ≥ 90 %" set for a branch, when the day's value is 84 %, then a breach alert reaches the lab head and the KPI tile shows red.
9. Given a scheduled WhatsApp summary containing PHI, then scheduling is blocked unless the template is DPO-approved non-PHI.
10. Given a dataset last refreshed 3 hours ago with SLA 15 min, then widgets show a stale badge and the dataset owner is alerted.
11. Given a multi-branch group admin, then MIS shows branch comparison normalised per bed and each branch's data isolation is preserved for branch-scoped users.
12. Given a TV token bound to the MIS dashboard, then the board renders full-screen rotating pages without login and without PHI.
13. Given the report catalogue exposes JSON via EN-026 key, then external BI fetches revenue_daily with the key's scope only and rate limits apply.
14. Given a report definition changed (v2), then prior scheduled runs remain reproducible with v1 and users see the version banner.
15. Given a bill back-dated to yesterday is finalised today, then yesterday's revenue_daily is restated by the next projection run and the MIS marks yesterday as restated with the delta visible in drill-down.
16. Given a doctor moved from Ortho to Trauma on the 15th, then "as-was" reporting attributes visits before the 15th to Ortho and after to Trauma, while "as-is" attributes all to Trauma; both toggles are available.
17. Given the IDSP weekly S-form generation, then syndromic counts derive from ICD/lab result datasets by week and the nodal officer can review before export; the exported file matches the IDSP template.
18. Given 300 concurrent users on the MIS dashboard, then p95 remains < 800 ms because widgets read summary tables via cached batched endpoint.

## 15. Enhancements / Later phases
- From VIMS sheet: NLP query (AI-008, Phase 12), automated anomaly detection in metrics (AI-005, Phase 12), board-level presentation auto-generation (Phase 12: PPTX/PDF pack from dashboards with narrative), regulatory auto-submission NRHM/HMIS (`reports.govt_formats`, Phase 11 files; API submission where states provide), multi-branch comparative analytics (`reports.multi_branch`, Phase 11).
- (market) Promise.all-style parallel widget loading (implemented via batched dashboard data endpoint), doctor–patient analytics, peak-hour analysis, "Advanced MIS analytics" packs, benchmarking against peer hospitals (EN-001), predictive tiles (AI-005), embedded Power BI/Metabase connectors, self-service data marts export, scheduled TV rotation packs, voice/NLQ on mobile.

## 16. Open Questions for the Hospital
1. Priority list of daily MIS metrics and management pack contents; who receives what, when (time zone)?
2. KPI targets per branch/department and owners for alerts?
3. Which government returns apply (HMIS facility type, IDSP reporting unit, state formats) and current submission mode?
4. Departments/roles that need self-service builder vs canned reports; is there an MIS analyst?
5. External BI tools in use (Power BI/Tableau) needing data access; on-prem replica availability?
6. PHI export policy and DPO approval process for external sharing?
7. Multi-branch reporting structure (group roll-ups, comparison normalisations)?
8. Retention for generated report files and run logs?
