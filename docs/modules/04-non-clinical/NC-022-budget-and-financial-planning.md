# NC-022 — Budget & Financial Planning (Department Budgets, Capex/Opex Tracking, Commitment Control, Variance Analysis, Forecasting)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-022 |
| Phase | 9 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | NC-009 (chart of accounts, cost centres, actuals from GL, budget-vs-actual reports, FY calendar), NC-008 (cost centres & department consumption actuals), NC-005 (indent/PO commitment control against budget lines; capex requests), NC-002/NC-020 (capex asset requests, replacement planning, AMC costs), NC-010 (manpower budget: headcount × CTC, increments), NC-021/NC-031 (contract values → committed opex), OP-005/IP-005/EN-002 (revenue actuals & mix for revenue budgets), NC-011/EN-001 (analytics, forecasting read models), AI-005 (demand/revenue forecast inputs, later), EN-038 (approval matrices for budget submission/revision/virement), EN-039 (templates), NC-004 (budget documents), EN-041 (group consolidation), NC-023 (statutory/CSR obligations budgeting), EN-024 |
| Feature flag | `module.budget.enabled` (sub: `budget.commitment_control`, `budget.forecast`, `budget.zero_based`, `budget.group_consolidation`) |
| Primary roles | Finance Manager / CFO, Budget Controller (Accounts), HODs / Department managers (budget owners) |
| Secondary roles | Hospital Admin/Director (2/4; approvals), Purchase (45; commitment checks), HR (47; manpower budget), BME/Asset (48; capex), Group finance (EN-041), Auditor (58) |
| Regulatory | Companies Act 2013 (board-approved budgets for companies; CSR §135 spend 2 % where applicable), Trust/Society acts (AGM-approved budgets for charitable hospitals; 12A/80G utilisation), Income-tax (capex vs revenue classification for depreciation §32), GST (ITC on capex — budgeting net of ITC), Ind AS/AS (capitalisation criteria), NABH FMS/ROM (resource planning evidence), Government grant utilisation certificates (PMJAY/State schemes/CSR donors), Internal audit / IFC (budgetary control as an internal financial control) |

## 1. Purpose
NC-022 lets the hospital plan and control money: annual **operating budgets** per department/cost centre (revenue, staff, consumables, drugs, utilities, AMC, outsourced services), **capital budgets** (equipment, civil, IT) with project lines and approvals, **commitment control** so indents/POs/contracts are checked against available budget (soft/hard stops), monthly **budget-vs-actual variance** with drill-down to GL/consumption/POs, in-year revisions/virements, **rolling forecasts** (run-rate, driver-based: patient volumes × yield; seasonality), scenario planning, and group consolidation — giving CFO/HODs a live view instead of spreadsheets.

## 2. Users & Jobs-to-be-done
- **HOD/budget owner** (desktop; mobile view of own budget): prepare next-year budget from templates & last-year actuals with drivers (beds, OP visits, procedures, headcount), justify capex requests, monitor monthly variance, request virement/supplementary, approve indents against budget.
- **Budget controller/Finance**: set calendar & guidelines (inflation %, growth assumptions), consolidate submissions, review/negotiate, lock approved budget, allocate monthly phasing, run variance & forecast, respond to PO budget checks, manage revisions.
- **CFO/Director/Board**: approve budgets, view dashboards, scenarios, capex committee decisions.
- **Purchase/HR/BME**: see available balance before commitment; capex requests linked to NC-002/NC-020 replacement lists.
- **Group finance**: consolidated multi-branch budgets, inter-branch allocations.

## 3. Core Workflows
### 3.1 Budget cycle setup
1. **Controller** creates budget cycle for FY (Apr–Mar default; configurable) with calendar (submission window, review, approval, lock), guidelines (inflation %, salary increment %, volume growth by department, capex ceiling), templates (line categories mapped to GL accounts/cost centres/NC-008), drivers master (beds, OP visits, IP admissions, OT cases, lab tests, patient-days by ward, FTEs), method enum(incremental/zero_based `budget.zero_based`/driver_based) → publishes to budget owners → Event `budget.cycle.opened`.

### 3.2 Operating budget preparation
1. **HOD** opens department budget workbook: revenue lines (by service group × payer mix — from OP-005/IP-005 actuals; volumes × average yield), staff cost (NC-010 headcount plan × CTC, proposed hires), drugs/consumables (NC-008 consumption run-rate × volume growth × price inflation), utilities/facility share (NC-025 allocations), AMC/CMC (NC-002 contracts), outsourced services (NC-031 contract values), training (NC-027), marketing (NC-026), other → monthly **phasing** (equal/seasonal profile/custom) → justification notes/attachments → submit → **Controller** reviews (comments, adjustments with reason, versioning) → negotiation rounds → approval (EN-038: Finance → Director/Board) → **locked v1** → Event `budget.approved`.
2. Zero-based option: each line requires activity/driver justification; unfilled lines default zero.

### 3.3 Capital budget & capex requests
1. **Requester** (HOD/BME/IT/Facility) raises capex request: item/project, category enum(medical_equipment/it/civil_infra/furniture/vehicles/software/other), justification (replacement (BER NC-020 ref)/new service/expansion/compliance (NC-023)/safety), quantity, estimated cost (net of ITC), quotations, expected life, ROI/payback (revenue uplift, cost saving), utilisation projections, funding (own/loan/grant/CSR/lease), priority → **capex committee** scoring & ranking within ceiling → approved lines become **capex budget** with phasing → linked NC-005 PO(s) & NC-002 capitalisation track actual spend, CWIP → project milestones (civil) → post-implementation review (actual vs projected utilisation) → Event `budget.capex.approved|spent`.

### 3.4 Commitment control (`budget.commitment_control`)
1. On NC-005 indent/PO/contract (NC-031) creation → **System** finds budget line (cost centre × category/GL × period) → available = budget − actuals (GL/GRN) − open commitments (POs not yet received) → if request > available: **soft** (warn + note) or **hard** stop (needs virement/supplementary approval) per policy & category; emergency override (Director) audited → commitment recorded; released on GRN/invoice/cancel → Event `budget.commitment.recorded|released|exceeded`.

### 3.5 Variance analysis & monitoring
1. Monthly close (NC-009) → **System** loads actuals per line (GL postings, NC-008 consumption, payroll NC-010, revenue OP-005/IP-005), computes variance (amount, %), YTD, flags beyond thresholds (e.g. > 10 % & > ₹1 L), price vs volume variance for driver-based lines (volume variance = (actual vol − budget vol) × budget rate; price/yield variance) → HOD explanations required for flagged lines (comment workflow) → variance pack for management → Event `budget.variance.published`.

### 3.6 Revisions, virements & supplementary
- Virement between lines within department (limits e.g. ≤ 10 % without director), across departments (director), supplementary budget (board) → new version; history retained; commitments re-checked.

### 3.7 Forecasting & scenarios (`budget.forecast`)
- Rolling forecast (actual YTD + forecast remaining months) methods: run-rate, seasonal (last 2–3 yrs), driver-based (projected volumes from EN-001/AI-005 × yield), manual overrides; scenarios (base/optimistic/pessimistic; e.g. new OT, tariff revision +8 %, payer mix shift); cash-flow projection hand-off to NC-009 treasury; break-even by service line; group consolidation (`budget.group_consolidation`) with eliminations of inter-branch transfers.

## 4. Data Model (schema `finance`, prefix `bud_`)
- **bud_cycles**: id, hospital_id, fy_code, name, method enum, calendar jsonb {submission_from, submission_to, review_to, approval_to}, guidelines jsonb {inflation_pct, increment_pct, growth_by_dept, capex_ceiling}, status enum(draft/open/review/approved/locked/closed), version int.
- **bud_templates** (cycle_id, department_type, lines jsonb [{category_code, gl_account_id, cost_centre_rule, driver_code?, formula?}]).
- **bud_drivers** (code, name, unit, source enum(manual/opd_visits/ip_admissions/patient_days/ot_cases/lab_tests/fte/beds), by_department bool), **bud_driver_values** (cycle_id, department_id, driver_code, month, budget_value, actual_value).
- **bud_budgets**: id, hospital_id, branch_id, cycle_id, department_id, cost_centre_id (NC-008), kind enum(operating/capital), version int, status enum(draft/submitted/under_review/returned/approved/locked/revised), owner_user_id, submitted_at, approved_by, approved_at, total_amount, notes. UNIQUE (cycle_id, cost_centre_id, kind, version).
- **bud_lines**: id, budget_id, line_no, category_code, gl_account_id, item_group_id?, driver_code?, driver_qty?, rate?, annual_amount numeric(14,2), phasing jsonb {m1..m12}, justification, attachments uuid[], is_revenue bool, computed_from jsonb (basis: last_year_actual, run_rate…). INDEX (budget_id), (gl_account_id, cost_centre via budget).
- **bud_capex_requests**: id, hospital_id, branch_id, cycle_id, request_no, department_id, title, category enum, justification_type enum, description, qty, est_cost, itc_amount, net_cost, quotations jsonb, expected_life_years, roi jsonb {revenue_uplift, cost_saving, payback_months, npv?}, funding enum, priority smallint, ber_ref? (NC-020), licence_ref? (NC-023), committee_score, rank, status enum(draft/submitted/screened/approved/rejected/deferred/ordered/received/capitalised/closed), approved_amount, po_ids uuid[], asset_ids uuid[], spent_amount, pir jsonb (post-implementation review), version. INDEX (hospital_id, cycle_id, status), (department_id).
- **bud_commitments**: id, hospital_id, budget_line_id, source enum(indent/po/contract/manual), source_id, amount, period_month, status enum(open/partially_released/released/cancelled), created_at, released_amount, override_by?, override_reason. INDEX (budget_line_id, status).
- **bud_actuals** (materialised monthly: budget_line_id/cost_centre+gl+month, actual_amount, source_breakdown jsonb) refreshed from NC-009 GL & NC-008.
- **bud_variances** (line_id, month, budget, actual, commitment, variance_amt, variance_pct, ytd_*, volume_var, price_var, flagged bool, explanation, explained_by, explained_at).
- **bud_revisions** (budget_id, from_version, to_version, type enum(virement_intra/virement_inter/supplementary/correction), lines_delta jsonb, reason, approvals jsonb, effective_month).
- **bud_forecasts** (cycle_id, as_of_month, method, scenario_id?, lines jsonb {line_id: {m..}}, assumptions jsonb, created_by), **bud_scenarios** (name, assumptions jsonb, base_forecast_id).
- **analytics.budget_vs_actual** (branch, department, cost_centre, gl, month: budget, actual, commitment, forecast).
- RLS; department-scoped read (ABAC) for HODs; group consolidation via `app.hospital_ids`.

## 5. Business Rules & Validations
- Budget line must map to a GL account & cost centre; sum of phasing = annual amount; revenue lines positive, cost lines positive with sign handled in reports.
- Submission only within calendar; approvals via EN-038 (Finance review → Director; capex above ceiling → Board); approved budgets locked; changes only via revisions with approvals; every version immutable and diffable.
- Commitment check: available = budget(YTD or annual per policy) − actuals − open commitments; hard-stop categories configurable (default: capex hard, opex soft with 10 % tolerance); emergency override requires Director & reason; overrides reported monthly.
- Capex request needs ≥ 2 quotations above threshold (config) or justification for single source (proprietary/OEM); ROI mandatory above ₹X; replacement requires NC-020 BER/age evidence; approved capex expires end of FY unless carried forward by approval.
- Variance flag thresholds by line type; explanations mandatory for flagged lines within 10 days of month close; unexplained → escalate.
- Virement limits by role/amount; cannot move capex ↔ opex; cannot virement into salary lines without HR concurrence.
- Forecast never overwrites budget; scenarios labelled; group consolidation eliminates inter-branch recharge lines.
- Retention 8 years; audit on all approvals/overrides.

## 6. API Surface (`/api/v1/budget`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | /cycles ; POST /cycles/{id}/(open|close-submission|lock) ; GET/PUT /cycles/{id}/templates ; /drivers ; /driver-values | setup | budget.cycle.manage / .read | Y | – |
| GET/POST/PATCH | /budgets?cycle=&dept= ; GET /budgets/{id} ; POST /budgets/{id}/(submit|return|approve|lock) ; POST /budgets/{id}/copy-from-last-year | operating budgets | budget.budget.edit (owner) / .review / .approve | Y | cursor |
| PUT | /budgets/{id}/lines (bulk) ; POST /budgets/{id}/lines/import (xlsx) | lines | budget.budget.edit | Y | – |
| GET/POST/PATCH | /capex ; POST /capex/{id}/(submit|screen|score|approve|reject|defer|close) ; POST /capex/{id}/pir | capex | budget.capex.request / .review / .approve | Y | cursor |
| POST | /check {cost_centre, gl/category, amount, month, source} → {available, decision soft/hard, line_id} ; POST /commitments ; POST /commitments/{id}/release ; POST /commitments/{id}/override | commitment control (NC-005/NC-031 call) | budget.commitment.check / .override (director) | Y | – |
| GET | /variance?cycle=&month=&dept= ; POST /variance/{id}/explain ; POST /variance/publish?month= | variance | budget.variance.read / .explain / .manage | Y | cursor |
| POST/GET | /revisions ; POST /revisions/{id}/approve | virement/supplementary | budget.revision.request / .approve | Y | cursor |
| POST/GET | /forecasts ; /scenarios ; POST /forecasts/generate?method= | forecasting | budget.forecast.manage / .read | Y | cursor |
| GET | /dashboard ; /reports/(bva|capex-status|commitments|forecast|variance-pack|group-consolidated) ; GET /export?fmt=xlsx | analytics | budget.report.read | – | – |

## 7. Domain Events (outbox)
- `budget.cycle.opened|closed`, `budget.submitted|returned|approved|locked|revised` {budget_id, dept, version, totals} → EN-037 (owners/finance), NC-009 (budget figures for BvA), NC-011.
- `budget.capex.submitted|approved|rejected|spent|closed` {request_id, amount, asset_ids} → NC-005 (PO allowed), NC-002 (capitalisation link), NC-020, EN-037.
- `budget.commitment.recorded|released|exceeded|overridden` {line_id, amount, source} → NC-005 (indent/PO status), finance alerts, audit.
- `budget.variance.published|flagged|explained` → HODs, management pack, NC-011.
- `budget.forecast.published` → NC-009 treasury/cash-flow, EN-001 dashboards.
- Consumes: `finance.period.closed|journal.posted` (NC-009 actuals), `consumption.posted` (NC-008), `payroll.posted` (NC-010), `bill.finalized|ip.bill.finalized` (revenue actuals via analytics), `purchase.indent.created|po.issued|po.cancelled|grn.accepted` (NC-005 commitments), `contract.activated` (NC-031), `asset.capitalised` (NC-002), `bme.ber.approved` (NC-020 replacement), `licence.compliance.capex_needed` (NC-023), `analytics.forecast.updated` (EN-001/AI-005 volumes).

## 8. Screens (UI)
- **Budget Workbook** (desktop, spreadsheet-like grid via TanStack Table with virtualised rows): lines × months, formulas (driver × rate), copy last year/run-rate buttons, inline comments, attachments; keyboard: arrow navigation, `Ctrl+D` fill down, `Ctrl+Enter` submit; autosave; version compare side-by-side.
- **Capex Request Form & Committee Board** (desktop): request wizard (justification, quotes, ROI calculator), committee ranking board (drag to rank within ceiling, score matrix), status pipeline (Requested→Screened→Approved→Ordered→Received→Capitalised→PIR).
- **Commitment Check Widget** (embedded in NC-005 indent/PO & NC-031): shows budget line, available, decision, override request.
- **Variance Dashboard** (desktop; mobile summary for HOD): waterfall/heatmap by department, flagged lines with explain drawer, drill-down to GL/PO/consumption; export pack PDF.
- **Forecast & Scenario Studio** (desktop): assumptions panel, forecast grid, scenario compare charts (Recharts), cash-flow projection view.
- **Group Consolidation** (desktop): branch tree, eliminations, consolidated BvA.
- **Approvals Inbox** (EN-038). Empty/error states; WCAG 2.2 AA; i18n; xlsx import/export.

## 9. Integrations
- NC-009 GL/cost centres/period close & BvA reports (single source of actuals), NC-008 consumption, NC-010 payroll & headcount plan, NC-005/NC-031 commitment API, NC-002/NC-020 capex lifecycle, EN-001/NC-011 read models, AI-005 forecasts (later), EN-038 approvals, EN-039 templates, NC-004 documents, xlsx import/export, Tally/ERP budget export (CSV) via NC-009, EN-041 group.

## 10. Reports & Analytics
- Budget vs actual (dept/cost centre/GL/month/YTD; amount & %), commitments & available balance, capex status & utilisation (approved/ordered/received/capitalised), variance pack with explanations, price/volume variance, revenue budget vs actual by service line/payer, staff cost vs budget (FTE & CTC), forecast vs budget vs actual, scenario comparison, capex ROI post-implementation, group consolidated BvA, override & exception register (audit). Read model `analytics.budget_vs_actual` refreshed after NC-009 close and nightly.

## 11. Notifications
- Owners: cycle opened/deadline reminders (T-7/T-1), returned with comments, approved, variance flags needing explanation, commitment exceeded; Finance: submissions received, overrides used, capex requests pending screening; Director/Board: approvals pending, monthly variance pack ready; Purchase: capex approved (PO allowed), budget line exhausted.

## 12. Permissions (RBAC keys)
`budget.cycle.manage|read`, `budget.budget.edit` (owner; ABAC own department), `budget.budget.review` (finance), `budget.budget.approve` (director/board), `budget.capex.request|review|approve`, `budget.commitment.check` (system/purchase), `budget.commitment.override` (director), `budget.variance.read|explain|manage`, `budget.revision.request|approve`, `budget.forecast.manage|read`, `budget.report.read`, `budget.export`, `budget.group.read` (group finance). Defaults: Finance Manager (46) manage/review; HOD (5) edit own & explain; Hospital Admin/MS (2/4) approve; Purchase (45) check; Auditor (58) read.

## 13. Non-functional
- Volumes: 100 cost centres × 60 lines × 12 months × versions; commitment check API p95 < 100 ms (cached available balances in Redis, invalidated on events); variance refresh for full hospital < 2 min after close; workbook loads < 1.5 s for 1,000 lines (virtualised).
- Offline: not required; xlsx round-trip supported.
- Security: department scoping; financial data class; audit; RLS.
- i18n (INR lakh/crore formatting; multi-currency for global tenants), WCAG 2.2 AA; printing of variance pack/capex forms.

## 14. Acceptance Criteria
1. Given cycle FY26-27 open with inflation 6 %, when HOD clicks "copy last year actuals × guidelines", then lines pre-fill with last-year actuals × 1.06 and monthly phasing follows last year's seasonal profile.
2. Given a budget submitted after the submission window, then submission is blocked unless controller extends the window (audited).
3. Given approved opex line "Ward consumables – Ward 5" ₹12 L (₹1 L/month) with soft control 10 %, when a PO of ₹1.5 L is raised in April with no actuals, then the check returns soft warning (available ₹1 L, tolerance to ₹1.1 L exceeded) and requires a note; with hard control it blocks pending virement.
4. Given a capex request of ₹40 L with one quotation and threshold requiring 2, then submission is blocked until a second quote or single-source justification is added.
5. Given capex approved ₹40 L and PO ₹38 L issued, then commitment ₹38 L shows against the line; on GRN & capitalisation the actual replaces commitment and status becomes `capitalised`.
6. Given month close for June, then variance for all lines is computed within 2 min, lines with > 10 % and > ₹1 L flagged, and HODs notified to explain within 10 days.
7. Given HOD requests virement of ₹2 L from "training" to "consumables" (≤ 10 %), then finance approval suffices; a ₹5 L cross-department virement routes to Director.
8. Given a Director override on a hard-stop, then the commitment is recorded with override reason and appears in the monthly exception register.
9. Given a forecast generated by run-rate as of September, then remaining months = average of last 3 months actuals per line, editable, and budget values remain unchanged.
10. Given a user from Department A, then they cannot view Department B's budget (403) unless finance role.
11. Given group consolidation, then inter-branch recharge lines are eliminated and totals reconcile with branch-level sums minus eliminations.

## 15. Enhancements / Later phases
- From VIMS sheet: dept budget, capex/opex tracking, variance analysis, forecast (Phase 9 core above).
- (market) Driver-based rolling forecasts with AI volume prediction (AI-005), service-line profitability & activity-based costing (with NC-008), what-if tariff simulations (RC-003), cash-flow forecasting/treasury (NC-009), grant/CSR fund utilisation tracking & UC generation, board pack automation, benchmarking across group branches (EN-041), Excel add-in/Google Sheets sync, workforce planning integration (NC-010/NC-030), ESG/energy budgets (NC-025).

## 16. Open Questions for the Hospital
1. Budget cycle & FY, method (incremental/zero-based/driver-based), levels (department vs cost centre), approval hierarchy (finance → director → board/trust)?
2. Commitment control policy: which categories hard-stop, tolerance %, override authority?
3. Capex process: committee composition, scoring criteria, quotation rules, ceiling; carry-forward policy?
4. Variance thresholds and explanation SLA; management pack format?
5. Drivers to use for revenue/cost budgeting; availability of last 2–3 years' actuals for import?
6. Multi-branch consolidation & inter-branch recharges?
7. Currency/format preferences (lakh/crore vs million) for global tenants?

