# IP-008 — IP Package Management (surgery bundles, package billing, utilisation & thresholds, variance tracking, insurance/scheme mapping, profitability)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | IP / Inpatient                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Module ID       | IP-008                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Phase           | 7                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Priority        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Depends on      | OP-023 (package configuration engine & booking — shared package master; IP-008 adds surgical/IP bundle semantics), RC-003 (tariffs, effective dates), IP-005 (posting against packages, excess billing), IP-001 (admission under package), IP-006 (OT case ↔ package), OP-010 (procedure catalogue), EN-002/RC-002 (payer mapping, pre-auth amount), RC-007 (PMJAY/CGHS/ECHS package codes), RC-008 (estimator/quotation), NC-006/TR-003 (consumables/implants cost), NC-034 (surgeon share), NC-009 (costing/GL), EN-038 (approvals), EN-001/NC-011 (analytics), EN-024 (audit), IP-020 (clinical pathways, later) |
| Feature flag    | `module.ip_packages.enabled` (sub: `pkg.variance_analytics`, `pkg.insurer_mapping`, `pkg.oop_estimator`, `pkg.pathway_alerts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Primary roles   | Billing Manager / Finance (46), Billing Executive IP (27), Insurance/TPA desk (28), Package/Tariff administrator (Branch Admin 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Secondary roles | Surgeons/Doctors (9/7, package selection & exhaustion alerts), Receptionist/Admission desk (24, booking), Cashier (26), MS/HOD (4/5, approvals), Patient/Family (59/60, estimator), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Regulatory      | GST (composite supply treatment of packages; room-rent component > ₹5,000 rule), NABH ROM (transparent pricing, estimate), Clinical Establishments (rate display), IRDAI/TPA package agreements, PMJAY HBP 2022 package codes & rules, CGHS/ECHS rate lists, Consumer Protection (package inclusions/exclusions disclosure), DPDP                                                                                                                                                                                                                                                                                   |

## 1. Purpose

IP-008 defines surgical/medical/maternity IP packages as bundles of components (OT time, surgeon/anaesthetist fees by grade, room class × days, ICU days, drugs & consumables (list or cap), investigations list, implants (included/excluded), physio, follow-up visits) with a fixed price and payer-specific variants (self, each TPA/insurer, PMJAY/CGHS/ECHS codes), attaches packages to admissions, tells IP-005 what is covered vs excess, tracks utilisation with 80 %/100 % alerts to doctors and billing, and produces variance and profitability analytics (actual cost/standard price vs package price, component-wise root cause) so management can renegotiate rates and clinicians can see cost trajectories.

## 2. Users & Jobs-to-be-done

- **Package admin / finance** (desktop): create/version packages (effective-dated), map to procedures & payers, set inclusion rules and caps, approve price revisions, review variance & margins monthly.
- **Admission desk / billing** (desktop): attach package at admission/booking (or convert mid-stay), quote out-of-pocket (`pkg.oop_estimator`), monitor utilisation, handle exclusions and conversions, settle package + excess at discharge.
- **TPA desk**: map hospital package ↔ insurer package/tariff codes, auto-fill pre-auth amount, handle package-based approvals & queries.
- **Surgeon/doctor** (desktop/phone): choose package for planned surgery, see live consumption vs cap, receive threshold alerts, justify exclusions/extra days.
- **Patient/family**: package quote with inclusions/exclusions, running utilisation on portal.
- **Management**: profitability by package/surgeon/payer, benchmarking across periods, loss alerts.

## 3. Core Workflows

### 3.1 Package definition (versioned)

1. **Admin** creates package (code, name, category surgical/medical/maternity/day-care/health-checkup(OP-023), speciality, procedures mapped (OP-010 codes, ICD-10 links), default LOS & room class, `price` per payer plan (self base + payer variants via RC-003 effective-dated), validity dates, GST treatment (composite/mixed; component-wise HSN for insurer formats)).
2. **Components** with inclusion rules: type (room/icu/ot_time/surgeon_fee/anaesthesia/assistant/nursing/pharmacy/consumables/investigations/implants/blood/physio/diet/followup_opd) with `mode` = included_unlimited / included_list (specific service codes) / included_cap (amount or quantity cap) / excluded / optional_addon (priced), standard cost & standard price (for variance), quantity (e.g. room 3 days Semi-Private, ICU 1 day, OT 120 min, 2 follow-up visits within 30 days), grade rules (surgeon fee by grade), class differential rules (upgrade → differential on room + class-linked services), extra-day rate, conversion rules (package → itemised triggers: LOS > X, ICU > Y, complications list, patient request).
3. **Exclusions** text & codes (implants above ceiling, blood, high-end antibiotics, co-morbidity treatment, ventilator beyond N days), **fine print** shown to patient; **insurer mapping** (`pkg.insurer_mapping`): payer package code, agreed rate, room-rent limits, sub-limits, PMJAY HBP code/price & mandatory documentation; approval workflow (EN-038) → published version → Event `package.published`.
4. Simulation: admin can run "what-if" against last 6 months cases to see margin impact before publishing (`pkg.variance_analytics`).

### 3.2 Booking / attach to admission

- From OPD advice, RC-008 quote, admission desk or OT scheduling: select package (search by procedure/surgeon/payer) → **quote** (package price + expected excess e.g. implants estimate + class upgrade + OOP for insurance co-pay; multilingual PDF) → attach to admission (`billing.ip_bills.package_id`, version pinned) → IP-005 sets coverage rules; deposit per package rule; pre-auth amount auto-filled (RC-002) with insurer code → Event `package.attached`.
- Multiple packages (e.g. bilateral or two procedures) with combination discounts; add-ons selected.

### 3.3 Utilisation tracking & alerts

- IP-005 line events (`ip.bill.line.posted`) evaluated against components: matching service → `covered_by_package` (patient not charged; standard price accumulates in utilisation), cap components accumulate amount/qty; non-matching → excess (billed itemised) with reason tag (exclusion/over-cap/extra-day/class-differential/non-listed).
- Thresholds: 80 % of any capped component (or overall standard-cost budget) → alert to treating doctor & billing (`package.threshold_reached`); 100 % → "package exhausted" alert + excess starts, patient/family notification of expected extra (configurable), TPA enhancement draft if insured; LOS beyond included days → alert day before (predicted from expected discharge).
- Clinical pathway deviation (`pkg.pathway_alerts`, with IP-020 later): unusual orders (e.g. CT not in list, ICU transfer) prompt justification code (complication/comorbidity/patient request) captured for variance root cause.

### 3.4 Conversion & settlement

- **Conversion** package → itemised (or vice versa) with approval (billing manager; reasons: complications, LOS breach, patient request, insurer instruction) → IP-005 re-rates: covered lines become chargeable at tariff (or itemised lines collapse into package) from admission (or from conversion date per policy) → audit; **partial package** for cancelled surgery (pre-op only) → defined cancellation charge rules.
- **Settlement** at final bill: package line(s) + excess lines + add-ons − discounts; insurer format (component split as agreed); scheme (PMJAY) → package price only, extras per RC-007 rules; surgeon share from package fee component (NC-034).

### 3.5 Variance & profitability analytics (`pkg.variance_analytics`)

- Per case: package price vs (a) standard price of consumed services (revenue foregone) and (b) actual cost (drug/consumable/implant landed cost from NC-006/NC-007, room cost per day from NC-009 cost centres, OT minute cost, fee payouts) → margin; component-wise variance & root cause tags; positive/negative; loss alert if margin < threshold → Event `package.margin_alert`.
- Aggregate: by package/surgeon/payer/period; LOS variance; top excess drivers; benchmarking across periods/branches; suggested price revision; export.

### 3.6 Exceptions

1. Package version retired mid-stay → pinned version stays; new admissions use new version.
2. Payer changes mid-stay → package variant re-mapped with approval; excess re-computed.
3. Surgery cancelled after admission → partial/cancellation rules; package detached.
4. Component list missing a commonly used item → billing marks "treat as covered" with approval; feedback loop to admin (suggested list update).

## 4. Data Model (schema `billing`; shares `mdm.packages` with OP-023)

- **mdm.packages** (id, hospital_id, code, name, category enum, speciality_id, procedure_codes text[], icd_codes text[], default_los, default_class_id, validity_from/to, gst_treatment, status enum(draft/published/retired), version, approved_by) — versioned rows (package_id + version unique).
- **mdm.package_prices** (package_id, version, payer_plan_id/null (self), price, currency, effective_from, effective_to, insurer_code, insurer_room_limit, sub_limits jsonb).
- **mdm.package_components** (package_id, version, component_type enum, mode enum(unlimited/list/cap/excluded/addon), service_codes text[], cap_amount, cap_qty, qty, unit, std_cost, std_price, class_id?, grade_rules jsonb, extra_unit_rate, notes).
- **mdm.package_rules** (package_id, version, rule enum(conversion_trigger/cancellation/class_upgrade/combination_discount/deposit), params jsonb).
- **billing.admission_packages** (id, hospital_id, admission_id, package_id, version, payer_plan_id, price_snapshot, addons jsonb, attached_at, attached_by, quote_id?, status enum(active/converted/detached/settled), converted_at, conversion_reason, approver_id).
- **billing.package_utilisation** (admission_package_id, component_type, service_code?, qty_used, std_price_used, cost_used, cap_amount, cap_qty, pct, last_alert_pct, updated_at) — updated by line events.
- **billing.package_excess_lines** (admission_package_id, bill_line_id, reason enum(exclusion/over_cap/extra_day/class_diff/non_listed/addon), justification_code?, amount).
- **billing.package_variance** (admission_package_id, package_price, std_price_total, actual_cost_total, margin, component_breakdown jsonb, root_causes jsonb, computed_at) — recomputed at final bill.
- **billing.package_quotes** (patient_id, package_id, version, payer, expected_excess jsonb, oop_estimate, pdf_file_id, valid_till, created_by).
- Read models: `analytics.mv_package_profitability` (period × package × surgeon × payer), `analytics.mv_package_utilisation_live`.

## 5. Business Rules & Validations

- Packages effective-dated & versioned; admissions pin version; price changes need approval (EN-038); published packages immutable (new version to change).
- Component matching order: explicit service list → category cap → excluded → non-listed (excess); one line matches one component; implants over ceiling → excess with implant reason.
- Threshold alerts at 80/100 % (configurable), once per threshold per component; LOS alert D-1.
- Conversion needs approval & reason; conversion effect date policy configurable (from admission by default).
- Insurer variants: only mapped payer plans selectable for insured patients; pre-auth amount = insurer package price + expected excluded items estimate.
- PMJAY: package price fixed; unauthorised extras blocked unless RC-007 permits (patient cannot be charged for covered services).
- GST: package as composite supply (principal healthcare exempt) unless configured otherwise; taxable components shown separately for insurer formats.
- Variance computed at final bill; costs from latest costing snapshots; margin threshold alert.
- Audit: package attach/detach/convert, price approvals, "treat as covered" overrides.

## 6. API Surface (`/api/v1/billing/packages`)

| Method         | Path                                                     | Purpose                                                                       | Permission                                                          | Idem            | Pag    |
| -------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------- | ------ |
| GET/POST/PATCH | /packages, /packages/{id}/versions                       | package master (with OP-023)                                                  | package.manage / read                                               | Y               | cursor |
| POST           | /packages/{id}/versions/{v}/publish                      | retire                                                                        | lifecycle (approval)                                                | package.approve | Y      | –   |
| GET            | /packages/search?procedure=&payer=&surgeon=              | selection                                                                     | package.read                                                        | –               | cursor |
| POST           | /quotes                                                  | package quote (OOP estimator)                                                 | package.quote                                                       | Y               | –      |
| POST           | /admissions/{id}/package (attach), DELETE, POST /convert | attach/detach/convert                                                         | package.attach / package.convert                                    | Y               | –      |
| GET            | /admissions/{id}/package/utilisation                     | live utilisation & excess                                                     | package.read                                                        | –               | –      |
| POST           | /admissions/{id}/package/excess/{lineId}/justify         | justification code                                                            | package.attach                                                      | Y               | –      |
| POST           | /admissions/{id}/package/treat-as-covered/{lineId}       | override (approval)                                                           | package.override                                                    | Y               | –      |
| GET            | /variance?package=&surgeon=&payer=&from=                 | analytics                                                                     | package.report.read                                                 | –               | cursor |
| POST           | /packages/{id}/simulate                                  | what-if margin                                                                | package.manage                                                      | –               | –      |
| GET/PUT        | /insurer-mappings                                        | payer/scheme codes                                                            | package.manage                                                      | Y               | cursor |
| Consumes       | `ip.bill.line.posted                                     | reversed`(IP-005),`ip.admitted`, `ip.discharge.completed`, `ot.case.scheduled | completed`, `preauth.approved`, `costing.snapshot.updated` (NC-009) |                 |        |     |     |

## 7. Domain Events (outbox)

- `package.published|retired` → RC-003, RC-008, PE-001 price display.
- `package.attached|detached|converted` {admission_id, package_id, version, payer} → IP-005, RC-002, IP-006.
- `package.utilisation.updated` {component, pct}; `package.threshold_reached` {pct 80/100, component} → doctor (IP-010), billing, family (config), RC-002 enhancement draft.
- `package.los_exceeding` {days_over} → doctor, bed manager.
- `package.excess.recorded` {reason, amount}.
- `package.variance.computed` {margin}; `package.margin_alert` → finance.

## 8. Screens (UI)

- **Package Builder** (desktop): header, payer price grid, components table (type/mode/list picker/caps/qty/std cost/price), rules, exclusions text, insurer mapping tab, versions/diff, simulate, approve/publish; `Ctrl+S`, `Ctrl+D` duplicate version.
- **Package Selector & Quote** (desktop admission/OPD; phone for doctors): search, compare up to 3 packages, inclusions/exclusions, OOP estimate, print/WhatsApp quote.
- **Utilisation Panel** (in IP-005 running bill & IP-010 doctor mobile): component gauges (used/cap), excess list with reasons, LOS bar, alerts; family portal card.
- **Variance Dashboard** (desktop): margin by package/surgeon/payer, waterfall of components, root-cause pareto, period benchmark, drill to case; export.
- **Conversion Dialog**: reason, effect date, preview of bill impact, approval routing.

## 9. Integrations

- RC-003 (prices), RC-002/EN-002 (pre-auth amounts, insurer codes), RC-007 (PMJAY HBP list import), RC-008 (estimator), IP-005 (posting), IP-006 (case link), NC-009/NC-006/NC-007 (costs), NC-034 (surgeon share), PE-001 (portal quotes/utilisation), EN-001 (BI).

## 10. Reports & Analytics

- Package sales & mix, utilisation vs cap, excess by reason, conversion rate & reasons, LOS variance, margin/profitability, insurer-wise realisation vs list price, PMJAY package performance, top loss-making packages, price revision suggestions, quote-to-admission conversion.

## 11. Notifications

- Doctor: 80 %/100 % thresholds, LOS D-1, conversion approved; Billing: exhaustion, non-listed excess growing, conversion requests; TPA: enhancement drafts; Family: package quote, exhaustion/expected extra (if enabled); Finance: margin alerts, monthly variance digest.

## 12. Permissions (RBAC keys)

`package.read|manage|approve|quote|attach|convert|override|report.read|export`.
Defaults: Package admin/Finance (46/3): manage, approve (SoD creator ≠ approver), report; Billing exec (27): quote, attach, read; Billing manager: convert, override; TPA desk (28): read, quote, mappings read; Doctors: read, quote; Reception (24): quote, attach at booking; Patient: own quote/utilisation via portal.

## 13. Non-functional

- Utilisation evaluation per line event < 50 ms; supports 200 active packaged admissions per branch; variance recompute nightly + at final bill; package search < 150 ms (Redis).
- Versioned masters cached with event invalidation; printing: quote PDF (multilingual), package summary sheet.
- Audit & retention as billing (8 y).

## 14. Acceptance Criteria

1. Given package "TKR unilateral" v2 published with room 4 days Semi-Private, OT 150 min, implant excluded, consumables cap ₹25,000, when attached to an admission, then IP-005 marks matching lines covered and bills the implant as excess with reason `exclusion`.
2. Given consumables consumed reach ₹20,000 (80 %), then the surgeon and billing receive a threshold alert once; at ₹25,000 an "exhausted" alert fires and further consumables bill as `over_cap` excess.
3. Given the patient stays 5 days, then day 5 bills as `extra_day` at the configured extra rate and an LOS alert was sent on day 4.
4. Given a Private room upgrade, then the class differential and class-linked service differentials bill as `class_diff` excess with the daily preview shown at transfer.
5. Given an insured patient with a mapped insurer package code, then RC-002 pre-auth amount pre-fills with insurer package price + expected exclusions and the bill uses the insurer variant price.
6. Given a PMJAY package, then covered services cannot generate patient charges and unauthorised extras are blocked pending RC-007 rules.
7. Given conversion to itemised approved with effect from admission, then covered lines are re-rated at tariff, package line removed, and the audit shows approver and reason.
8. Given final bill, then variance shows package price ₹1,80,000, standard price ₹2,05,000, actual cost ₹1,32,000, margin ₹48,000 with component breakdown and root-cause tags.
9. Given a retired version, then existing admissions retain v2 pricing while new attachments use v3.
10. Given a quote for a self-pay patient, then the PDF lists inclusions/exclusions, OOP estimate, validity, and appears in the patient portal.
11. Given a billing exec attempts "treat as covered" for a ₹9,000 non-listed drug, then approval routes to the billing manager and, once approved, the line is covered with the override audited and a suggestion logged for the package admin.
12. Given monthly analytics, then packages with margin below threshold appear in the loss list with top drivers.

## 15. Enhancements / Later phases

- From VIMS sheet row 28: ML package pricing optimisation (AI-005), real-time cost trajectory prediction (AI-005), clinical-path deviation auto-alert (`pkg.pathway_alerts` with IP-020), patient out-of-pocket estimator (here), package benchmarking across periods (here).
- (market) package vs daily charge auto-detection, cost estimation (RC-008). Later: DRG-style grouping (AI-006), bundled-payment contracts with outcome clauses, dynamic package pricing by surgeon/occupancy (RC-003), family-facing live cost trajectory.

## 16. Open Questions for the Hospital

1. Existing package list (self & payer variants), inclusion/exclusion conventions, LOS/room class per package?
2. Conversion policy (when, approver, effect date), cancellation charges?
3. Costing data availability (drug/consumable landed cost, room cost/day, OT minute cost, fee payouts) for margin analytics?
4. Insurer/TPA package codes and PMJAY empanelment specialities; who maintains mappings?
5. Threshold percentages and who is alerted; family notification on exhaustion allowed?
6. GST treatment adopted for packages; insurer bill formats requiring component split?
7. Surgeon share rules inside package fees (NC-034)?
