# NC-008 — Consumption Entry & Cost Centres

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-008 |
| Phase | 4 |
| Priority | P1 |
| Complexity | Low–Medium |
| Depends on | NC-006 (ledger, ward/sub-store stock, item billable flags), IP-014 (ward stock/unit dose), IP-003 (nursing consumables at bedside), IP-006/TR-004 (OT consumables), OP-010/OP-039 (procedure consumables), OP-004/OP-008 (reagent/film consumption per test/study), EN-003 (CSSD tray consumables), OP-005/IP-005 (auto-charge billable consumables), RC-003 (consumable tariffs), NC-009 (cost-centre expense posting, department P&L), NC-022 (department budgets), NC-005 (indent-to-consumption chain), NC-010 (staff cost allocation to cost centres), NC-011, AI-005 (anomaly detection later) |
| Feature flag | `module.consumption.enabled` (sub: `consumption.auto_charge`, `consumption.kits`, `consumption.variance_alerts`) |
| Primary roles | Ward Nurse in-charge (17), OT/ICU/ER nurses (18/19/20), Lab/Radiology techs (33/36), Sub-store custodians, Stores In-charge (44) |
| Secondary roles | HOD (5, variance review), Accountant/Finance Manager (46, cost centre P&L), Hospital Admin (2), Billing (27, charge review), Quality (54), Auditor (58) |
| Regulatory | GST (consumables billed to patients with HSN; non-billable consumption = expense), NABH (MMS; billing transparency — patients charged only for items used), IRDAI/TPA (consumable billing rules, non-payables list), PMJAY package inclusions (consumables inside package not separately billable), Companies Act (cost records — Cost Accounting Records rules for hospitals above turnover thresholds: CRA-1 hospital cost centre structure), IndAS 2 (consumption expense recognition) |

## 1. Purpose
NC-008 records **where stock is actually consumed** — by department, ward, OT case, procedure, test, patient — maps every consumption to a **cost centre and budget head**, auto-charges billable items to the patient bill at the moment of consumption (no manual stock adjustments), monitors actual vs budget with variance alerts, and produces item-wise trends and department/cost-centre consumption and profitability views for NC-009/NC-011. It is the bridge between the stock ledger (NC-006) and finance (NC-009).

## 2. Users & Jobs-to-be-done
- **Ward/ICU/OT/ER nurse** (tablet/phone at bedside or desk with scanner): record consumables used for a patient (scan item → patient) or as ward general consumption; return unused; kit-based entry for procedures (e.g. dressing kit, central line kit) with one tap.
- **Lab/radiology tech**: consumption auto-derived per test/study (reagent mapping) plus manual entries (calibrators, spills).
- **Sub-store custodian**: daily/weekly ward consumption summary, par top-up, variance explanations.
- **HOD**: review department consumption vs budget monthly, approve explanations, request budget revisions.
- **Finance**: cost centre master, allocation rules (shared services), budget vs actual, department P&L feed to NC-009.
- **Billing/insurance**: ensure billable consumables charged, non-payables separated per payer rules; audit patient-level consumption vs bill (RC-006).

## 3. Core Workflows

### 3.1 Cost centre master & mapping
1. **Finance** defines cost centre tree (Revenue centres: OPD-Ortho, IP-Ward 3, ICU, OT-1, Lab, Radiology, Pharmacy…; Service/support centres: CSSD, housekeeping, laundry, biomedical, IT, admin, HR, security, kitchen; Overhead pools) with codes, type, GL expense mapping (NC-009), budget owner (HOD), allocation basis for support centres (bed-days, sq ft, headcount, tests, kg linen) → every store/sub-store, department, ward, OT, machine and employee maps to a default cost centre; items map to expense heads (drugs, surgical consumables, reagents, linen, stationery, engineering spares…) → Event `costcentre.updated`.
2. Budget heads (NC-022): consumables budget per cost centre per month/quarter (VIMS enhancement: allocation per dept per quarter).

### 3.2 Consumption capture (paperless indent → consumption)
1. **Patient-linked consumption**: nurse opens patient (IP-003 bedside or OT case) → "Consumables" → scan item barcode (or pick from ward par list/favourites/kits) → qty → **System** posts NC-006 `CONSUMPTION` from ward store (FEFO batch auto or scanned), tags patient/encounter/cost centre/performing dept, and if `is_billable` and payer rules allow → **auto-charge** bill line (OP-005/IP-005 via RC-003 tariff; package inclusion check → if inside package/non-payable → marked `included/non_billable` but still consumed) → Event `consumption.recorded` (with `bill_item_id?`).
2. **Department general consumption** (not patient-specific: gloves, sanitiser, stationery): custodian records daily/shift usage (bulk entry from par sheet; scan) → cost centre expense.
3. **Derived consumption**: lab test resulted → reagent/consumable mapping (OP-004 test-consumable BOM) posts consumption from lab store; radiology study → film/contrast; dialysis session → dialyser/lines; CSSD cycle → indicators/wraps; OT case → standard kit BOM per procedure (`consumption.kits`) with variance edit by scrub nurse; housekeeping → chemicals per task (NC-018).
4. **Ward stock issue** (NC-006 issue to ward) is not consumption — it becomes ward stock; consumption deducts ward stock; wards without stock tracking (config "expense on issue") treat issue as consumption at cost centre level (simple mode).
5. **Returns**: patient-returned unopened items → `PATIENT_RETURN` (ward stock +) and bill line reversal (credit) if already billed; ward → main store returns via NC-006.
6. Corrections: wrong patient/qty → reversal + re-entry within 24 h by same role; later via supervisor with reason; billed items follow OP-005 credit rules.

### 3.3 Auto deduction on billing (alternate direction)
- Where billing precedes consumption (OP procedures billed from a package/service that carries a consumable BOM), `bill.finalized`/`procedure.completed` events post consumption from the department store automatically (BOM per service in RC-003/OP-010) so stock and charge never diverge; missing stock → negative-stock policy (NC-006) and exception list.

### 3.4 Variance monitoring (`consumption.variance_alerts`)
- Monthly (and rolling MTD) actual consumption value per cost centre vs budget → deviation > threshold (default 10 %, per cost centre) → alert to HOD & finance; HOD enters explanation; management variance report; per-item variance vs prior 3-month average (spikes) → anomaly list; benchmark per bed/per patient-day/per OT case (VIMS: benchmarking against bed capacity) → Event `consumption.variance.alert`.

### 3.5 Trend & forecasting
- Item-wise daily/weekly/monthly consumption series per store/cost centre → seasonality view → feeds NC-006 reorder (avg daily consumption) and NC-005 planning; AI-005 anomaly detection & forecasts later; waste reduction analytics (expired vs consumed, opened-not-used).

### 3.6 Cost allocation & department P&L feed
- Month-end: direct consumption expense per cost centre + allocated support-centre costs (allocation bases) + staff cost (NC-010 payroll by cost centre) + depreciation (NC-002) + AMC → cost per cost centre → with revenue (OP-005/IP-005 by department) → **department/cost-centre P&L** in NC-009/NC-011; cost per patient-day, cost per OT hour, cost per test.

### 3.7 Ward stock issue → consumption chain (detailed)
1. Ward nurse raises par top-up (NC-006) → main store issues → nurse acknowledges (ward stock +) → during shift, consumables used per patient are scanned (ward stock −, patient charge) → shift-end: unscanned usage reconciled via "ward general consumption" entry (bulk) → weekly ward count (NC-006 cycle count) reveals discrepancy → adjustment with reason (pilferage/unrecorded use) → variance report per ward (feeds 3.4).
2. **Simple mode wards** (no par tracking): NC-006 issue to ward = consumption at ward cost centre; patient charges still via scan or service BOM.

### 3.8 High-value & controlled item consumption
- Implants → NC-007/TR-003 (not NC-008); narcotics/controlled → OP-003/IP-014 MAR-based consumption with register; blood components → IP-007; high-cost drugs (oncology, biologics) → administration-based consumption (IP-003 MAR) with vial-sharing/wastage rules and billing per payer policy (bill full vial vs dose, config).

### 3.9 Exceptions & edge cases
1. Consumption for a patient without active encounter (walk-in dressing at nursing room) → OP-039 creates a visit first; NC-008 requires encounter.
2. Auto-charge fails (tariff missing) → consumption posts (stock truth) with `billing_status=pending`; exception queue for billing to price; RC-006 lists as leakage until resolved.
3. Reversal after patient bill paid → credit note approval path; stock returned only if item unopened.
4. BOM references inactive item → job posts other lines and raises exception for the missing item.
5. Cost centre remapped mid-month → new entries use new mapping; historical entries unchanged; allocation run uses effective-dated mapping.
6. Negative ward stock due to unrecorded receipt → allowed per NC-006 policy with flag; consumption cost uses last known avg cost.
7. Kits with partial usage (opened kit, 3 of 12 items used) → nurse edits quantities; unused sterile items may be returned to ward stock or marked wasted per policy.

### 3.10 Configuration defaults (seed)
- Variance threshold 10 %; explanation SLA 7 days; reversal window 24 h; consumption entry types & expense heads seeded; allocation bases seeded (bed-days, sq ft, headcount, tests, patient-days); management book default for allocations; kit templates for common procedures (dressing, IV cannulation, catheterisation, central line, intubation, lumbar puncture, suturing) as starting BOMs.

## 4. Data Model (schema `inventory`, prefix `cons_` / `finance.cost_centres`)
- **cost_centres** (schema finance): id, hospital_id, branch_id, code, name, parent_id, type enum(revenue/service/overhead), department_id?, owner_user_id, gl_expense_map jsonb {expense_head → ledger}, allocation_basis enum(none/bed_days/sqft/headcount/tests/kg/patient_days/manual), is_active. UNIQUE (hospital_id, code).
- **cost_centre_mappings**: entity_type enum(store/department/ward/ot/machine/employee/service), entity_id, cost_centre_id, effective_from, effective_to.
- **item_expense_heads**: item_category_id/item_id, expense_head enum(drugs/surgical/implants/reagents/linen/stationery/housekeeping/engineering/it/food/other), gl_account_id.
- **cons_entries**: id, hospital_id, branch_id, entry_no, store_id, cost_centre_id, department_id, entry_type enum(patient/department_general/derived/kit/bom_on_billing/return), patient_id?, encounter_id?, case_ref (ot_case/procedure/test/study/session)?, performed_by, recorded_by, recorded_at, source enum(manual_scan/manual_pick/kit/lab_bom/rad_bom/ot_bom/service_bom/api), status enum(posted/reversed), reversal_of?, reversal_reason. INDEX (hospital_id, cost_centre_id, recorded_at), (patient_id, encounter_id), (store_id, recorded_at).
- **cons_entry_lines**: entry_id, item_id, batch_id, qty_base, uom_entered, qty_entered, unit_cost, value, is_billable, billing_status enum(billed/included_in_package/non_payable/not_billable/pending/reversed), bill_item_id?, tariff_snapshot, ledger_ref, kit_id?.
- **cons_kits**: id, hospital_id, name, procedure/service_id?, lines jsonb [{item_id, qty}], store_scope, is_active; **service_boms** (RC-003 service_id ↔ items/qty for auto deduction on billing).
- **cons_budgets** (mirror of NC-022 lines): cost_centre_id, period, expense_head, budget_value, revised_value; **cons_variance_alerts**: cost_centre_id, period, actual, budget, deviation_pct, threshold, status enum(open/explained/closed), explanation, explained_by.
- **cons_allocation_runs**: period, basis snapshot jsonb, results (from_cc, to_cc, amount), posted_journal_id (NC-009), status.
- **analytics.consumption_daily** (read model): date, branch, store, cost_centre, item, qty, value, patient_linked bool, billed_value; **analytics.consumption_kpis** (per bed, per patient-day, per case).
- RLS; entries reversible not editable; ledger authoritative in NC-006.

## 5. Business Rules & Validations
- Every consumption line must resolve to a cost centre (from store/department default; override with permission) and expense head; consumption from a store requires stock (or negative-stock policy).
- Patient-linked consumption requires active encounter (admitted/visit open/OT case open); after discharge/close, entries only via supervisor with reason (and billing follows credit/late-charge rules).
- Auto-charge only for `is_billable` items with valid tariff; payer rules: non-payables/package inclusions recorded with `billing_status` (never silently dropped); tariff snapshot stored; charge posting idempotent (entry line id as source_ref in OP-005).
- Kits/BOMs deduct default quantities; nurse may edit quantities used (audit); zero-use lines removed with reason.
- Derived consumption jobs are idempotent per source event; failures land in exception queue (not silent).
- Reversal within 24 h by recorder; else supervisor; billed lines reverse through OP-005 credit rules; ward stock returned only for unopened items.
- Variance threshold configurable per cost centre; alerts monthly + rolling; HOD explanation required within 7 days.
- Allocation runs at month-end after NC-006 period close; posted to NC-009 as memo/management journals (config: statutory vs management ledger).
- Cost centre codes immutable once postings exist; deactivation only when no open budgets.

## 6. API Surface (`/api/v1/consumption`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | /cost-centres, /cost-centres/{id} ; /cost-centre-mappings ; /expense-heads | masters | finance.costcentre.manage | Y | cursor |
| POST | /entries (lines[], patient?, case?) | record consumption (+auto-charge) | inventory.consumption.record | Y | – |
| POST | /entries/{id}/reverse | reversal | inventory.consumption.reverse (own ≤24 h) / .supervise | Y | – |
| POST | /entries/kit (kit_id, patient, edits) | kit consumption | inventory.consumption.record | Y | – |
| GET | /entries?store=&cost_centre=&patient=&from=&to=&source= | list | inventory.consumption.read | – | cursor |
| GET | /patients/{id}/consumption?encounter= | patient view (vs bill) | inventory.consumption.read | – | cursor |
| GET/POST | /kits, /service-boms | templates | inventory.consumption.configure | Y | cursor |
| GET | /exceptions | failed derived/auto-charge | inventory.consumption.supervise | – | cursor |
| GET | /variance?period=&cost_centre= ; POST /variance/{id}/explain | variance | inventory.consumption.variance.read / (HOD) .explain | Y | cursor |
| POST | /allocations/run?period= ; POST /allocations/{id}/post | month-end allocation | finance.allocation.run / .post | Y | – |
| GET | /reports/(department|cost-centre|item-trend|budget-vs-actual|patient-vs-bill|per-bed-benchmark|waste) | reports | inventory.consumption.report | – | – |
| GET | /trend/{itemId}?store=&granularity= | series | inventory.consumption.read | – | – |

## 7. Domain Events (outbox)
- `consumption.recorded` {entry_id, lines[{item, batch, qty, value, cost_centre, billing_status, bill_item_id}], patient?, encounter?} → NC-006 (ledger done in-tx), OP-005/IP-005 (charge in-tx; event for RC-006), NC-009 (expense by cost centre), NC-011, AI-005.
- `consumption.reversed` → billing credit, ledger.
- `consumption.autocharge.failed` {entry_line, reason} → exception queue, billing supervisor.
- `consumption.variance.alert` {cost_centre, period, deviation} → HOD, finance (EN-037).
- `consumption.allocation.posted` {period} → NC-009, NC-011 department P&L.
- `costcentre.updated` → NC-009, NC-022, NC-010 mappings.
- Consumes: `lab.result.final` (OP-004 BOM), `rad.study.completed` (OP-008), `ot.case.closed` (IP-006/TR-004 kit BOM prompt), `procedure.completed` (OP-010), `dialysis.session.completed`, `cssd.cycle.completed` (EN-003), `bill.finalized` (service BOM), `patient.discharged` (lock), `budget.published` (NC-022), `payroll.posted` (NC-010 cost by centre), `asset.depreciation.posted` (NC-002).

## 8. Screens (UI)
- **Bedside consumables** (embedded in IP-003/IP-004 patient chart & OT case) — tablet/phone: scan or pick from par list/favourites/kits, qty stepper, billable indicator (billed/included/non-payable), running list for encounter; offline queue with sync; `Enter` scan focus, `K` kit picker.
- **Ward daily consumption sheet** — tablet/desktop: par items grid with used qty per shift, bulk post; barcode.
- **Consumption ledger** — desktop: filters, drill to ledger/bill line; reversal action.
- **Exceptions queue** — desktop (billing supervisor/stores).
- **Cost centre manager & mappings** — desktop (finance).
- **Variance dashboard** — desktop (HOD/finance): budget vs actual gauges by cost centre, spikes, explanations inbox.
- **Trend explorer** — desktop: item/store/cost centre series, seasonality, export.
- **Month-end allocation** — desktop: bases, preview, post.

### 8.1 Screen behaviours (detail)
- **Bedside consumables**: patient banner (allergies irrelevant here but isolation flag shown for PPE); scan → item card with billable badge (green billed / grey included / amber pending price / red non-payable); qty stepper defaults 1; favourites per ward auto-learned from usage; kit picker shows BOM with editable qty; offline indicator with queued count; sync conflicts (encounter closed) surface as red items with "send to supervisor".
- **Ward daily sheet**: par grid with previous day's used qty as placeholder; bulk post with confirmation of totals; shift filter; supervisor lock after posting.
- **Variance dashboard**: gauge per cost centre (actual/budget), sparkline 6 months, drill to item spikes; explanation inbox with due timers; export to management pack (NC-011).

### 8.2 Seeded reports (registered in NC-011 catalogue)
`consumption.dept_monthly`, `consumption.costcentre_expense_head`, `consumption.patient_vs_bill`, `consumption.unbilled_billables`, `consumption.non_payables_by_payer`, `consumption.item_trend`, `consumption.top_items_by_centre`, `consumption.per_bed_benchmark`, `consumption.waste`, `consumption.kit_adherence`, `consumption.budget_variance`, `consumption.allocation_summary`.

## 9. Integrations
- NC-006 ledger service (in-tx), OP-005/IP-005 charge API (in-tx via billing service), RC-003 tariff & BOM, OP-004/OP-008/EN-003/OP-012 derived events, NC-009 journals, NC-022 budgets, NC-010 payroll cost, NC-002 depreciation, EN-013 scanning, AI-005.

## 10. Reports & Analytics
- Department/cost-centre consumption (value/qty by expense head), patient-level consumption vs bill (leakage/over-billing), unbilled billable consumables, non-payables by payer, budget vs actual & variance explanations, item trend/seasonality, top consuming items per centre, per-bed/per-patient-day/per-case benchmarks across wards & branches, waste (expired/wasted vs consumed), kit adherence (BOM vs actual), department P&L inputs, cost per test/study/OT hour. Read models above; refreshed by events + nightly.

## 11. Notifications
- HOD/finance: variance > threshold (email/in-app), explanation due; billing supervisor: auto-charge failures; ward in-charge: daily sheet not posted by shift end; stores: negative-stock consumption on wards; management: monthly consumption digest.

## 12. Permissions (RBAC keys)
`inventory.consumption.record` (nurses/techs/custodians; ABAC own ward/store), `inventory.consumption.read`, `inventory.consumption.reverse` (own ≤ 24 h), `inventory.consumption.supervise`, `inventory.consumption.configure` (kits/BOMs), `inventory.consumption.variance.read/explain` (HOD own centres), `inventory.consumption.report`, `finance.costcentre.manage`, `finance.allocation.run/post` (SoD run ≠ post), `inventory.consumption.export`.

## 13. Non-functional
- Volumes: 30k consumption lines/day (wards/OT/lab/rad derived), 300 cost centres; post p95 < 250 ms including auto-charge; derived jobs within 1 min of source event; variance job monthly < 2 min; trend queries from read models < 500 ms.
- Offline bedside entries queued (IndexedDB), conflict rule: if encounter closed on sync → exception queue.
- Scanner-first, keyboard fallback; WCAG 2.2 AA; i18n; RLS; audit on reversals/overrides.

## 14. Acceptance Criteria
1. Given a nurse scans a billable dressing pack for an admitted patient, then ward stock reduces by 1 (FEFO batch), a bill line at tariff appears on the IP bill, and the entry shows `billed` with cost centre = ward.
2. Given the same item for a PMJAY package patient where consumables are included, then stock reduces, bill line is not created, and billing_status = `included_in_package`.
3. Given a lab test finalised with a reagent BOM, then consumption posts from the lab store within 1 minute; a duplicate event does not double-post.
4. Given an OT case closed with a kit BOM of 12 items, then the scrub nurse is prompted to confirm/edit quantities; edited lines are audited and stock/charges reflect final quantities.
5. Given a wrong-patient entry reversed within 24 h by the same nurse, then stock is restored, bill line reversed (if unpaid) or credit-note flow initiated, and both entries linked.
6. Given ward budget ₹5,00,000 for the month and actual ₹5,60,000 (12 % > 10 % threshold), then HOD and finance receive alerts and an explanation task with 7-day due date.
7. Given month-end allocation of housekeeping cost by sq ft, then support-centre cost is distributed and a management journal is posted to NC-009 by a user other than the runner.
8. Given a patient's consumption report vs bill, then unbilled billable items are listed as leakage for RC-006.
9. Given a consumption attempted for a discharged patient by a staff nurse, then blocked; supervisor with reason can post and billing applies late-charge rules.
10. Given trend explorer for gloves in ICU, then daily/weekly/monthly series render with seasonality and feed avg daily consumption to NC-006 reorder.
11. Given a billable item scanned but no tariff exists for the payer plan, then consumption posts with `billing_status=pending`, the billing exception queue lists it, and RC-006 counts it as potential leakage until priced.
12. Given a weekly ward count showing 20 units short of ledger for a scanned item, then the variance is posted as adjustment with reason and the ward variance dashboard reflects unrecorded consumption.
13. Given a cost centre remapped from Ward 3 to Ward 3A effective the 16th, then entries before the 16th stay with the old centre and the month-end allocation splits accordingly.
14. Given a high-cost biologic administered from a 400 mg vial for a 300 mg dose with policy "bill full vial", then consumption records the vial with 100 mg wastage and the bill line reflects the full vial per payer rule.

## 15. Enhancements / Later phases
- From VIMS sheet: budget allocation per dept per quarter (with NC-022, Phase 9), AI consumption anomaly detection (AI-005, Phase 12), paperless indent-to-consumption (Phase 4 core with NC-006 tablet flows), benchmarking against bed capacity (Phase 11 read models), waste reduction analytics (Phase 11).
- (market) Activity-based costing per procedure/DRG, cost-per-patient dashboards, RFID smart cabinets auto-consumption, nurse-friendly voice entry (AI-004), sustainability (carbon/waste) reporting.

## 16. Open Questions for the Hospital
1. Cost centre structure (list) and owners; support-centre allocation bases in use?
2. Which wards track stock (par) vs expense-on-issue simple mode?
3. Billable consumable policy per payer (non-payables lists, package inclusions) and current charge practice?
4. Kits/BOMs per procedure/test available? Lab reagent BOMs maintained by lab?
5. Variance thresholds and reporting cadence to management?
6. Do bedside nurses have tablets/scanners; expected adoption for patient-linked entry?
7. Should management accounting (allocations) post to statutory books or a separate management ledger?
