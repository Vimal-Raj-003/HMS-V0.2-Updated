# RC-003 — Tariff Management (Rate Master, Payer-Wise Rate Plans, Bed-Class Differentials, Effective-Dated Revisions, Packages, Scheme Rate Imports, Comparison & Profitability)

| Field | Value |
|---|---|
| Domain | Revenue Cycle Management |
| Module ID | RC-003 |
| Phase | 5 (a minimal self-pay rate plan is seeded in Phase 1 so NC-001/OP-005 can charge consultation fees) |
| Priority | P0 |
| Complexity | High |
| Depends on | EN-027 (Master Data Management — owns the **service catalogue**, drug master, ICD/SNOMED/LOINC, bed classes; RC-003 owns **pricing** on top of it), EN-041 (group vs branch price lists), EN-038 (approval matrix for rate revisions), EN-002 (payer/TPA/empanelment master, payer tariff sheets), RC-007 (government scheme package masters — PMJAY HBP, CGHS, ECHS, ESIC, state schemes), OP-023/IP-008 (package definitions — RC-003 prices them), RC-008 (estimator consumes rates), OP-005/IP-005 (bill lines resolve rates here), OP-003 (drug MRP/sale price — pharmacy pricing is drug-master driven, RC-003 prices *services*), NC-007/TR-003 (implant/consignment price lists), NC-008 (cost centres for costing), NC-009 (revenue heads / GL mapping), NC-012 (corporate discount plans), NC-034 (doctor share basis uses rate components), EN-036 (bulk import), EN-024 (audit), EN-001 (rate & margin analytics) |
| Feature flag | `module.tariff.enabled` (sub: `tariff.bed_class_differential`, `tariff.time_based`, `tariff.scheme_imports`, `tariff.cost_and_margin`, `tariff.multi_currency`, `tariff.group_price_lists`) |
| Primary roles | Billing Steward / Tariff Administrator (custom role from Branch Admin 3 family), Finance Manager (46), Insurance/TPA desk lead (28, payer mapping) |
| Secondary roles | Hospital Admin / Group Admin (2, approvals), Medical Superintendent (4, clinical service pricing sign-off), HOD (5, department rate proposals), Billing Executive (27, read), Cashier (26, read), Doctor (read own consult fee), Auditor (58), Corporate billing (29) |
| Regulatory | **Clinical Establishments (Central Government) Rules 2012 Rule 9(ii)** — display rates charged for each service at a conspicuous place in local and English languages, and charge rates within the range determined by government; **NABH 6th edition ROM/PRE & FMS** — documented tariff, tariff available to patients, estimate before admission; **CGHS rate list** (NABH vs non-NABH accredited differential rates, city classification A/B/C); **ECHS/ESIC** (follow CGHS-linked rate lists; ESIC has its own tie-up rates); **PMJAY HBP 2022** (Health Benefit Package master: package code, procedure name, specialty, stratification, NABH/non-NABH & aspirational-district incentives, pre/post-hospitalisation days); state scheme rate lists (CMCHIS Tamil Nadu, MJPJAY Maharashtra, Aarogyasri Telangana/AP, Ayushman variants); **IRDAI/ROHINI** procedure code alignment for payer claims; **GST** (SAC 9993 exempt healthcare, room > ₹5,000/day @5 % without ITC excluding ICU/CCU/ICCU/NICU per Notification 03/2022, taxable cosmetic/wellness, HSN for consumables/implants) — every rate row carries HSN/SAC and tax treatment; **DPDP** (no PHI in tariff data — this is master data); Competition/anti-profiteering considerations on price revisions |

## 1. Purpose
RC-003 is the single pricing authority for Vim's HMS. Every rupee that any module bills — consultation, lab, radiology, procedure, room, nursing, OT, implant, blood, therapy, package — resolves its price here, for the right **payer plan**, **bed class**, **branch**, **time band** and **service date**, from an **effective-dated, versioned, approved** rate structure. It holds hospital rate plans (self-pay, corporate, TPA, scheme, staff, camp, international), payer- and scheme-specific rate sheets with ROHINI/PMJAY/CGHS code mapping, package prices with inclusion lists, negotiated discounts, bulk revision tooling with impact simulation, cost & margin comparison, and a complete audit of every rate change. No module is permitted to compute a price locally; a missing rate is an exception, never a guess.

## 2. Users & Jobs-to-be-done
- **Tariff administrator / billing steward** (desktop, spreadsheet-heavy): maintain the rate matrix (≈4,000 services × 12 plans × 8 bed classes), run annual/ad-hoc revisions, upload payer sheets, resolve unmapped services, publish versions. Weekly; heavy at FY start and payer renewal.
- **Finance manager**: approve revisions, review margin vs cost (NC-008), compare our rates against payer/scheme rates, monitor discount leakage, sign off price lists.
- **Insurance desk lead**: map hospital services → payer codes/rates from uploaded tariff sheets, keep ROHINI/PMJAY/CGHS codes current, flag payer rate below cost.
- **HOD / Medical Superintendent**: propose department rates for new services, sign off clinical service pricing.
- **Billing executive / cashier**: read-only rate lookup, "why this price?" explain panel on a bill line.
- **Group admin**: publish group-default price lists that branches adopt or override (EN-041).
- **Patient-facing**: the public rate card (Clinical Establishments Act display) and RC-008 estimates are generated from published rates.

## 3. Core Workflows

### 3.1 Rate plan & version setup
1. **Tariff admin** creates a **rate plan**: code, name, plan_type enum(self_pay/corporate/tpa_insurance/government_scheme/staff/camp/international/research/charity/package_only), currency, branch scope (branch / all-branches / group-default), payer link (for tpa_insurance → `ins_payers`/empanelment; for scheme → RC-007 scheme id), rounding rule (nearest ₹1/₹5/₹10, up/down/nearest), priority (used in resolution, §5), effective window → Event `tariff.plan.created`.
2. Each plan holds **versions**: `version_no`, `effective_from`, `effective_to` (null = open), `status` enum(draft/pending_approval/approved/published/superseded/withdrawn), `basis` (fresh / clone of version X / derivative of another plan with formula "Self-pay − 12 %"), change note, approver chain. Only one **published** version may be effective for a plan at any instant (enforced by an exclusion constraint on the date range).
3. Admin builds the **rate grid** inside the draft version: for every service (EN-027 `mdm.services`) a row per applicable **bed class** (`tariff.bed_class_differential`: general/semi-private/private/deluxe/suite/ICU/HDU/day-care/OP) and optional **time band** (`tariff.time_based`: normal / after-hours / night 22:00–06:00 / Sunday & public holiday / emergency) — each row carries base_rate, min_rate, max_rate (guard rails), hsn_sac, tax_treatment enum(exempt/taxable/nil_rated), gst_rate, is_negotiable, doctor_share_basis ref (NC-034), cost_estimate (NC-008), revenue_head (NC-009).
4. **Simulation before approval**: system replays the last 30/90 days of billed volume against the draft version → projected revenue delta by department/service/payer, top 20 movers, count of services whose new rate falls below cost, count of payer rates that would exceed our list price → attached to the approval request.
5. **Approval** via EN-038 (default: tariff admin submits → Finance Manager → Hospital Admin above configured Δ%; MS co-approval for clinical services) → on approval, `publish` sets effective_from (never retroactive unless `retroactive_publish` approval with reason — triggers re-pricing job, §3.7) → Event `tariff.version.published` → Redis cache invalidated → all modules pick up the new rate for service dates ≥ effective_from.

### 3.2 Payer tariff sheet ingestion (from EN-002)
1. Insurance desk uploads a payer's XLSX/CSV tariff (or receives it via EN-036) → **column mapper** (payer code, payer service description, rate, bed-class column set, package flag, remarks) saved as a reusable **payer sheet template** per payer.
2. **Auto-match** hospital services: exact code match → ROHINI code match → trigram fuzzy name match (`pg_trgm`, score shown) → previous-version mapping carried forward. Unmatched rows go to a **mapping worklist** (assign to desk; can create a new service request into EN-027 governance).
3. Review grid shows: hospital service, our self-pay rate, payer rate, Δ%, cost, margin flag (red if payer rate < cost), previous payer rate, Δ vs previous. Desk accepts/edits/rejects rows → submit → approval (Finance) → published as a rate plan version for that payer with the contract's effective dates from `ins_empanelments` → Event `tariff.payer_sheet.published`.
4. Services present in our catalogue but absent from the payer sheet are recorded as `unmapped_for_payer` and surface on the EN-002 desk worklist and in RC-006; billing falls back per §5 rule (hospital rate flagged, never silently zero).

### 3.3 Government scheme rate imports (`tariff.scheme_imports`, with RC-007)
- Seeded importers for: **PMJAY HBP 2022** (package code, procedure, specialty, stratification, base rate, NABH/non-NABH multiplier, aspirational-district incentive, pre/post-hosp days, implant carve-outs), **CGHS** (city class A/B/C, NABH & non-NABH columns, ward entitlement mapping), **ECHS**, **ESIC**, and state schemes (**CMCHIS**, **MJPJAY**, **Aarogyasri**, others via a generic CSV profile). Each import produces a scheme rate plan version with the scheme's package master mirrored into `tariff_packages`; a diff report vs the previous circular is generated (added/removed/re-priced packages) and mailed to finance.
- Scheme rates are **read-only** (rate is set by the payer): editing is blocked; only mapping to hospital services/packages is editable.

### 3.4 Package pricing
1. Package definitions (inclusion list of services & quantities) live in OP-023 (OP packages), IP-008 (surgery bundles), OP-014 (health check-ups), RC-007 (scheme packages). RC-003 prices them per plan and per bed class: package_rate, inclusion cap rules (e.g. "up to 4 days room, 2 units blood, implants excluded"), exclusion list, excess-charge rule (itemise beyond cap / absorb / cap-and-alert), and the **notional split** of the package price across component revenue heads for GL and doctor payout (must sum to 100 %).
2. **Package profitability**: package rate vs the sum of component list rates vs component cost (NC-008) → margin % per package per plan, shown on the comparison dashboard and refreshed when either side changes.

### 3.5 Negotiated discounts & concession schemes
- Plan-level discount rules: flat % off a base plan, head-wise % (e.g. investigations −20 %, room −0 %), tiered by volume (corporate MoU), capped amounts, and exclusions (implants/pharmacy/consumables typically excluded). Category concessions (staff & dependants, senior citizen, hospital-empanelled institution, camp, charity/relief fund) are modelled as rate plans, not as ad-hoc bill discounts, so they are audited and reportable. Ad-hoc bill discounts remain OP-005/IP-005 with the EN-038 matrix; RC-003 only supplies the *contracted* price.

### 3.6 Bulk revision tooling
1. Admin selects a scope (plan + department/service group/tag + bed class) → operation: **uplift %**, absolute delta, set-to-formula (e.g. `CGHS_rate × 1.15`, `self_pay × 0.88`), copy-from-plan, round-to rule → **preview grid** with old/new/Δ and guard-rail violations (rate outside min/max, below cost, above payer ceiling) → simulation (§3.1.4) → submit for approval → publish.
2. **Copy plan to plan** (PCS/market pattern: transfer thousands of service values from one tariff scheme to another in one action) with a mapping report of services present in source but not target.
3. Import/export via XLSX with the same validation pipeline (EN-036); every import stores the source file, row-level errors and a rollback point.

### 3.7 Effective dating, back-dating & re-pricing
- Price is always resolved by **service performed date** (`performed_at`), not bill date. A published version is immutable; corrections create a new version.
- **Retroactive publish** (rare, e.g. payer contract signed late with a back-dated effective date) requires Finance + Admin approval and a reason; the system then runs a **re-pricing job** listing affected open (unfinalised) bill lines with old vs new value and posts adjustments; **finalised invoices are never re-priced** — differences are handled as credit/debit notes in OP-005/IP-005 with a variance report.

### 3.8 Rate comparison & profitability (`tariff.cost_and_margin`)
- Side-by-side matrix for a chosen service or department: self-pay, each corporate/TPA plan, CGHS, ECHS, ESIC, PMJAY, state scheme, plus cost (NC-008 activity cost or standard cost), margin ₹ and %, and last-revision date. Highlights: payer rate < cost (loss-making), payer rate > self-pay (over-recovery risk), rates unchanged > 24 months (stale), services with zero volume (dead SKUs), top-20 revenue services with thinnest margin.
- Benchmark import (optional): peer/market rate CSV for comparison only, never used for billing.

### 3.9 Exceptions
- **Rate not found** at billing time → billing posts the line with `rate_pending=true` (IP-005) / `price_status=missing` (OP-005), raises `tariff.rate.missing` and it appears in the tariff admin's **missing-rate worklist**; bill finalisation is blocked. Never default to zero.
- **Plan expired** (contract lapsed) → resolution falls back per §5 with a hard warning banner on the bill and an alert to the insurance desk.
- **Currency** (`tariff.multi_currency`): international plans priced in USD/AED etc.; bills still post in INR with an FX snapshot (rate source configured in NC-009) — the FX rate used is stored on the bill line.
- **Offline**: rate cache is warm in Redis and mirrored to the API pod's in-memory LRU; on cache miss with DB unreachable, billing refuses to price rather than guessing.

## 4. Data Model (schema `mdm`, prefix `tariff_`)
- **tariff_plans** — id, hospital_id, branch_id?, code, name, plan_type enum, currency char(3), payer_id?, scheme_id?, corporate_id?, scope enum(branch/hospital/group), derived_from_plan_id?, derivation_formula jsonb?, rounding_rule jsonb, priority smallint, is_default_self_pay bool, status enum(active/inactive), audit cols. UNIQUE(hospital_id, branch_id, code).
- **tariff_versions** — id, hospital_id, plan_id, version_no int, effective_from date, effective_to date?, status enum(draft/pending_approval/approved/published/superseded/withdrawn), basis jsonb, change_note, simulation_result jsonb, approval_id (EN-038), published_by, published_at, source_file_id?, audit cols. UNIQUE(plan_id, version_no); `EXCLUDE USING gist (plan_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&) WHERE (status = 'published')` — guarantees non-overlapping published windows.
- **tariff_items** — id, hospital_id, version_id, service_id (EN-027), bed_class_id?, time_band enum(normal/after_hours/night/holiday/emergency)?, unit, base_rate numeric(14,2), min_rate, max_rate, hsn_sac, tax_treatment enum(exempt/taxable/nil_rated), gst_rate numeric(5,2), payer_code (ROHINI/CGHS/PMJAY/payer-specific), payer_service_name, cost_amount numeric(14,2)?, revenue_head_id, doctor_share_rule_id?, is_negotiable bool, notes. UNIQUE(version_id, service_id, coalesce(bed_class_id,'0'), coalesce(time_band,'normal')). Index (hospital_id, version_id, service_id) — covering index for resolution.
- **tariff_packages** — id, hospital_id, version_id, package_id (OP-023/IP-008/OP-014/RC-007), bed_class_id?, package_rate, cap_rules jsonb (los_days, room_class, blood_units, implant_included bool, investigations_cap), exclusions jsonb, excess_rule enum(itemise/absorb/cap_alert), component_split jsonb (revenue_head → %; must total 100), pre_hosp_days, post_hosp_days, scheme_package_code, nabh_multiplier numeric(5,3)?, notes.
- **tariff_discount_rules** — id, plan_id/version_id, scope enum(all/department/service_group/service), target_id, discount_type enum(pct/amount/formula), value, applies_to enum(gross/taxable), excluded_item_types text[], volume_tiers jsonb?, cap_amount?, effective range.
- **tariff_payer_sheets** — id, hospital_id, payer_id, empanelment_id, file_id, template_id, uploaded_by, rows_total, rows_matched, rows_unmatched, status enum(uploaded/mapping/review/approved/published/rejected), version_id?, diff_report_file_id.
- **tariff_sheet_rows** — sheet_id, row_no, payer_code, payer_description, payer_rate, bed_class_col, match_service_id?, match_method enum(code/rohini/fuzzy/prior/manual), match_score, decision enum(accept/edit/reject/pending), edited_rate, remarks.
- **tariff_scheme_imports** — id, hospital_id, scheme_id (RC-007), circular_ref, circular_date, source enum(pmjay_hbp/cghs/echs/esic/state/custom), file_id, packages_added, packages_removed, packages_repriced, version_id, imported_by, diff_file_id.
- **tariff_change_log** (append-only, partitioned by month) — id, hospital_id, version_id, item_id?, package_id?, service_id?, field, old_value, new_value, changed_by, changed_at, reason, approval_id, source enum(manual/bulk/import/formula/scheme_import). Never updated, never deleted — this is the "audit of every rate change" of record.
- **tariff_missing_rates** (worklist read model) — hospital_id, branch_id, service_id, plan_id, bed_class_id, first_seen_at, last_seen_at, occurrences, sample_bill_line_ids[], status enum(open/priced/waived), resolved_by, resolved_at.
- **tariff_rate_cards** (published public display, Clinical Establishments Act) — hospital_id, branch_id, version_id, language, file_id (PDF/HTML), published_at, display_locations text[].
- **tariff_benchmarks** — service_id, source_name, peer_rate, city, as_of, file_id (comparison only, `is_billable=false`).
- Indexes: `tariff_items (hospital_id, service_id, version_id)`, `(version_id, bed_class_id)`; `tariff_versions (hospital_id, plan_id, effective_from desc)`; GIN trigram on `tariff_sheet_rows.payer_description`. All tables RLS on `hospital_id`; `tariff_change_log` partitioned by `changed_at` month via `pg_partman`.

## 5. Business Rules & Validations
- **Resolution algorithm** (`resolveRate(service_id, payer_context, bed_class, performed_at, branch)`), deterministic and pure:
  1. Candidate plans = plans matching the encounter's payer context (scheme > tpa/insurer > corporate > staff/category > self-pay), scoped to branch (branch plan beats group plan), ordered by `priority` then specificity.
  2. Within the winning plan, pick the **published version** whose `[effective_from, effective_to)` contains `performed_at`.
  3. Within the version, pick the item by (service, bed_class, time_band) with fallback ladder: exact → service+bed_class → service+time_band → service only. If the plan has a `derivation_formula`, compute from the base plan's resolved rate and apply the rounding rule.
  4. Apply plan discount rules (§3.5) and guard rails (clamp to min/max only if `clamp_enabled`, else raise a validation error).
  5. If nothing resolves → return `MISSING_RATE` with the full attempted chain (the "explain" payload shown in the UI); billing must hold the line. **Never** fall back to ₹0 and never invent a rate.
- One published version per plan per instant (DB exclusion constraint). Draft/pending versions never price anything.
- A published version is **immutable**: no updates to `tariff_items` of a published version; changes require a new version (enforced by trigger).
- `component_split` percentages of a package must sum to 100.00 ± 0.01; package rate ≥ 0; cap rules must reference valid bed classes.
- Rate cannot be below `min_rate` or above `max_rate`; if `cost_amount` is present and `base_rate < cost_amount`, publishing requires an explicit "loss-making rate accepted" reason (common and legitimate for scheme plans).
- Government scheme plans are `is_editable=false` for rates; only mapping and NABH/non-NABH selection are editable. The hospital's NABH accreditation status per branch drives the CGHS/PMJAY column selection and is validated against NC-015's accreditation record (with an expiry alarm — an expired certificate silently downgrading rates is a known revenue leak).
- Approval matrix (EN-038 default): Δ ≤ 5 % → Finance Manager; Δ > 5 % or new plan or scheme mapping change → Finance Manager + Hospital Admin; clinical service rates → MS informed/co-approves. Requester ≠ approver, always.
- HSN/SAC and tax treatment are mandatory on every item; a taxable item with `gst_rate = 0` is rejected. Room rates carry the > ₹5,000/day rule metadata so OP-005/IP-005 can apply GST correctly (ICU/CCU/ICCU/NICU excluded).
- Publishing a version emits cache invalidation; the effective cache TTL is ≤ 60 s so a mis-publish is recoverable quickly; `withdraw` of a published version is allowed only if no bill line has referenced it (else supersede with a corrective version).
- Every bill line stores `tariff_version_id` + `tariff_item_id` + resolved rate (rate snapshot), so a historical bill can always be explained even after 10 revisions.
- Retention: tariff versions and change log retained for 8 years (GST/contract audit) minimum; rate cards retained as published.

## 6. API Surface (`/api/v1/tariff`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /plans?type=&payer=&branch= | list plans | tariff.plan.list | – | cursor |
| POST/PATCH | /plans, /plans/{id} | create/update plan | tariff.plan.configure | Y | – |
| GET | /plans/{id}/versions | version history | tariff.version.list | – | cursor |
| POST | /plans/{id}/versions | create draft (fresh/clone/derive) | tariff.version.create | Y | – |
| GET/PATCH | /versions/{id} | draft header | tariff.version.read/update | Y | – |
| GET | /versions/{id}/items?service=&dept=&bedClass= | rate grid | tariff.item.list | – | cursor |
| PUT | /versions/{id}/items | upsert rows (bulk, ≤5000/req) | tariff.item.update | Y | – |
| POST | /versions/{id}/bulk-revise | uplift/formula/copy op with preview token | tariff.bulk.revise | Y | – |
| POST | /versions/{id}/simulate | revenue impact simulation (async job) | tariff.version.simulate | Y | – |
| POST | /versions/{id}/submit | submit for approval (EN-038) | tariff.version.submit | Y | – |
| POST | /versions/{id}/publish | publish (approved only) | tariff.version.publish | Y | – |
| POST | /versions/{id}/withdraw | withdraw unused published version | tariff.version.withdraw | Y | – |
| POST | /payer-sheets | upload payer XLSX | tariff.payer_sheet.upload | Y | – |
| GET/PATCH | /payer-sheets/{id}/rows | mapping worklist | tariff.payer_sheet.map | Y | cursor |
| POST | /payer-sheets/{id}/publish | create payer plan version | tariff.payer_sheet.publish | Y | – |
| POST | /scheme-imports | import PMJAY/CGHS/ECHS/ESIC/state list | tariff.scheme.import | Y | – |
| GET | /packages?plan=&bedClass= ; PUT /packages/{id} | package pricing | tariff.package.read/update | Y | cursor |
| **GET** | **/resolve?serviceId=&payerContext=&bedClass=&at=&branchId=** | **rate resolution (hot path, used by OP-005/IP-005/RC-008)** | tariff.rate.resolve | – | – |
| POST | /resolve/batch | batch resolve (estimator, ≤500 items) | tariff.rate.resolve | – | – |
| GET | /explain?billLineId= | why-this-price chain | tariff.rate.explain | – | – |
| GET | /comparison?service=&dept= | plan-vs-plan + cost/margin | tariff.report.compare | – | cursor |
| GET | /missing-rates ; POST /missing-rates/{id}/resolve | worklist | tariff.missing.read/resolve | Y | cursor |
| GET | /change-log?from=&to=&service= | audit of rate changes | tariff.audit.read | – | cursor |
| POST | /rate-cards/publish ; GET /public/rate-card?branch=&lang= | statutory rate display | tariff.ratecard.publish / public | – | – |
| GET | /export?versionId=&format=xlsx | export price list | tariff.export | – | – |

## 7. Domain Events (outbox)
- `tariff.plan.created|updated` → EN-002 (payer link), NC-012 (corporate plan), RC-007.
- `tariff.version.created|submitted|approved|published|superseded|withdrawn` {plan_id, version_id, effective_from, items_changed} → OP-005, IP-005, RC-008 (estimate re-basing), Redis cache invalidation, EN-001, PE-001 (public rate card refresh).
- `tariff.payer_sheet.published` {payer_id, version_id, unmapped_count} → EN-002 desk, RC-006.
- `tariff.scheme.imported` {scheme_id, packages_added, removed, repriced} → RC-007, finance digest.
- `tariff.rate.missing` {service_id, plan_id, bed_class_id, branch_id, sample_line_id} → tariff worklist, RC-006 leakage, EN-037 alert to tariff admin.
- `tariff.rate.below_cost` {service_id, plan_id, rate, cost} → finance dashboard.
- `tariff.package.repriced` → OP-023/IP-008/OP-014/RC-008.
- `tariff.ratecard.published` → EN-012 (website), EN-018 (lobby display), PE-001.
- Consumes: `service.created` (EN-027 → prompts pricing for every plan), `bedclass.created`, `insurance.empanelment.created|expiring` (payer plan window), `nabh.accreditation.updated` (NC-015 → CGHS column), `package.defined` (OP-023/IP-008).

## 8. Screens
- **Tariff Workbench** (desktop, ≥1600 px, virtualised grid, spreadsheet ergonomics): left tree = departments → service groups → services; centre = editable rate matrix (columns: bed classes / time bands; rows: services) for the selected draft version, with paste-from-Excel, fill-down, multi-cell edit, per-cell change badge and inline validation; right rail = version header, status, approval trail, simulation summary. Shortcuts: `Ctrl+S` save draft, `Ctrl+D` fill down, `Ctrl+Shift+U` bulk uplift dialog, `Ctrl+F` find service, `Ctrl+Enter` submit for approval, `Alt+C` compare with another plan side-by-side. Real-time: another admin editing the same version shows presence chips and per-cell locks (Socket.IO). Empty state: "No draft version — clone the published one to start a revision."
- **Version & Approval panel** (desktop + phone for approvers): diff view (old → new) grouped by department, top movers, count of below-cost rows, simulation chart (projected monthly revenue delta), approve/reject with reason (one-tap + PIN on phone).
- **Payer Sheet Mapping** (desktop): three-pane — uploaded rows | match candidates with score | decision; bulk accept above score threshold; "create service request" for genuinely new services; progress bar (matched/unmatched). Shortcuts `A` accept, `R` reject, `E` edit rate, `↓/↑` navigate.
- **Scheme Import Console** (desktop): circular metadata, uploaded file, parsed package count, diff vs previous circular (added/removed/re-priced), NABH column selector, publish.
- **Package Pricing** (desktop): package, inclusions with list value, package rate per plan/bed class, computed margin, cap rules editor, component split (must total 100 %, live sum indicator).
- **Rate Comparison & Margin dashboard** (desktop/TV admin dark theme): service or department picker → bar of rates across plans with cost line overlaid; filters (loss-making only, stale > 24 months, high volume); drill to volume × margin; export.
- **Missing Rates worklist** (desktop): service, plan, branch, occurrences, first/last seen, sample bill; inline "price now" opens a mini draft; badge count in the left nav so it is never ignored.
- **Rate Lookup / Explain** (desktop, embedded in OP-005/IP-005 bill line context menu and available standalone): enter service + payer + bed class + date → resolved rate with the full decision chain (plan chosen, version, item, discount rule, rounding) — this is the answer to "why is this ₹X?" at the counter.
- **Public Rate Card** (kiosk/TV/web/print, EN-018/EN-012/PE-001): department-wise list of commonly used services and room categories in English + local language, "rates effective from", printable A4 — satisfies Clinical Establishments Act display and NABH transparency.
- All screens: WCAG 2.2 AA, keyboard-first grid navigation, i18n labels; the grid is desktop-only by design (read-only summary on tablet, no phone editing).

## 9. Integrations
- **EN-027** for the service catalogue (RC-003 never creates services; it requests them through MDM governance), bed classes, units, drug master link.
- **EN-002** payer/empanelment (contract effective dates drive plan windows), ROHINI/IIB code sets.
- **RC-007** scheme masters and package codes; NHA/CGHS/state circular files stored in NC-004.
- **NC-008** cost per service (activity-based or standard) for margin; **NC-009** revenue head mapping; **NC-034** doctor share basis per rate component.
- **EN-036** bulk import pipeline (validation, dry-run, rollback point); **EN-038** approvals; **EN-024** audit.
- **Redis** hot cache: key `tariff:{hospital}:{branch}:{plan}:{service}:{bedclass}:{band}:{yyyymmdd}` with event-based invalidation on publish; in-process LRU (60 s) in front of Redis.
- Fallbacks: import file malformed → row-level error report, nothing published; cost service unavailable → margin columns show "—", publishing still allowed; benchmark source optional.

## 10. Reports & Analytics
- Price list (any plan/version, XLSX/PDF) with effective dates; rate revision history per service (sparkline of price over time); revision impact realised vs simulated (post-publish, 30 days); payer rate vs our rate variance report; **loss-making services by payer**; margin by department/service/package; discount plan utilisation (how much revenue flows through each plan); stale rate report (> 24 months unchanged); services with no rate in an active plan (coverage %, target 100 %); scheme circular diff archive; rate-change audit extract for statutory/internal audit.
- Read models: `analytics.mv_tariff_coverage` (plan × department coverage %), `mv_tariff_margin` (service × plan margin), `mv_rate_revision_impact`, `mv_payer_rate_variance` — refreshed nightly and on `tariff.version.published`.

## 11. Notifications
- Tariff admin: missing-rate worklist digest (hourly during working hours, count-based), new service created in EN-027 without a rate in the default plan, payer sheet mapping pending > 3 days.
- Finance/Admin: revision awaiting approval (push + email with the simulation summary), publish confirmation, below-cost publish alert, scheme circular imported (diff summary), NABH accreditation expiring (affects CGHS/PMJAY rate column).
- Insurance desk: payer plan expiring with the empanelment (90/60/30 days), payer rate below cost for high-volume services.
- Billing desk (in-app toast): "Rates updated, effective today" when a version publishes during a shift.
- No patient-facing notifications from this module (rate card publication is a passive display).

## 12. Permissions (RBAC keys)
`tariff.plan.list|configure` (Tariff admin, Finance Manager, Hospital Admin) · `tariff.version.list|read|create|update|simulate|submit` (Tariff admin) · `tariff.version.publish|withdraw` (Finance Manager +; ABAC `amount_limit` on Δ%) · `tariff.item.list|update` (Tariff admin) · `tariff.bulk.revise` (Tariff admin, requires approval to publish) · `tariff.payer_sheet.upload|map|publish` (Insurance desk lead, Tariff admin) · `tariff.scheme.import` (Tariff admin, Scheme coordinator RC-007) · `tariff.package.read|update` (Tariff admin, Finance) · `tariff.rate.resolve` (all billing/clinical service accounts — machine-to-machine and UI lookup) · `tariff.rate.explain` (Billing executive, Cashier, Insurance desk, Doctor for own consult fee) · `tariff.report.compare` (Finance, Admin, Insurance lead) · `tariff.missing.read|resolve` (Tariff admin, Billing supervisor) · `tariff.audit.read` (Auditor, Admin, Finance) · `tariff.ratecard.publish` (Admin) · `tariff.export` (Finance, Admin — audited PHI-free export).
Segregation of duties: `tariff.version.submit` and `tariff.version.publish` must be different users (policy-enforced, not just UI).

## 13. Non-functional
- **Volumes** (2000-bed enterprise, multi-branch): ~4,000 billable services × ~12 active plans × up to 8 bed classes ≈ 250k–400k `tariff_items` rows per published generation; 30–60 published versions per year; payer sheets of 2,000–6,000 rows; PMJAY HBP ≈ 1,900 packages.
- **Performance**: `GET /resolve` p95 < 15 ms warm (Redis), < 60 ms cold (DB, covering index); batch resolve of 500 items < 200 ms; rate grid loads 5,000 rows in < 1.5 s (virtualised, server-paged); bulk uplift preview of 50,000 rows < 10 s (async with progress); simulation over 90 days of billing < 60 s async. Rate resolution is on the critical path of **every** bill line at 60k lines/day — it must never touch more than one index.
- **Caching**: Redis with 60 s TTL + explicit invalidation on publish; stale-while-revalidate is **not** allowed for money — on invalidation the cache is purged, not soft-expired.
- **Offline**: none (master-data admin function). Billing pods keep the warm in-memory LRU so a brief Redis outage does not stop the counter.
- **Printing**: price list PDF (A4, landscape, department-wise), public rate card (A3 lobby poster + A4), payer sheet mapping report.
- **Accessibility/i18n**: rate card in English + hospital's local language(s) (`hi`, `ta`, `te`, `ml`, `kn`, `mr`, `bn`); currency formatting `en-IN`; grid fully keyboard-navigable; numbers right-aligned monospace.
- **Security**: rate data is commercially sensitive — export is permissioned and audited; payer sheets stored encrypted in S3; no PHI anywhere in this module (tariff data is not patient data), so RLS is tenant-only.

## 14. Acceptance Criteria
1. Given a published self-pay version effective 01-Apr and a new version effective 01-Jul, when a service performed on 15-Jun is billed on 05-Jul, then the April rate is used and the bill line stores that version id.
2. Given two published versions of the same plan with overlapping date ranges are attempted, then the second publish is rejected by the database exclusion constraint and the API returns a 409 with a clear message.
3. Given a service with no rate in the resolved plan, when a bill line is posted, then the line is created with `rate_pending`, `tariff.rate.missing` is emitted, the item appears in the missing-rate worklist within 5 s, and bill finalisation is blocked.
4. Given a TPA plan derived as "self-pay − 12 %, round to nearest ₹10", when the self-pay rate is ₹1,234, then the resolved TPA rate is ₹1,090 and the explain panel shows the base rate, formula and rounding step.
5. Given a private-room rate of ₹6,000/day and an ICU rate of ₹15,000/day, then the room item carries `taxable` with GST 5 % and the ICU item carries `exempt`, and IP-005 bills them accordingly.
6. Given a bulk uplift of 8 % on the Radiology department, when previewed, then the grid shows old/new/Δ for every affected row, flags rows breaching `max_rate`, and nothing is priced differently until the version is approved and published.
7. Given a draft version submitted by the tariff admin, when the same user attempts to publish it, then the request is denied on segregation-of-duties and an audit entry is written.
8. Given a payer XLSX with 3,000 rows, when uploaded, then ≥ 80 % auto-match by code/ROHINI/prior mapping, unmatched rows appear in the mapping worklist, and no rate is active until the sheet is approved and published.
9. Given the PMJAY HBP circular is imported, then a diff report lists added/removed/re-priced packages against the previous circular, scheme rates are read-only, and the NABH multiplier applied matches the branch's current accreditation status.
10. Given a package priced at ₹85,000 with a component split, when the split percentages do not total 100, then save is rejected with the running total shown.
11. Given a published version, when any user attempts to edit one of its `tariff_items`, then the update is blocked by trigger and the UI directs the user to create a new version.
12. Given a rate is changed, then `tariff_change_log` records old value, new value, actor, timestamp, reason and approval id, and the entry can never be updated or deleted.
13. Given a version is published, then Redis cache keys for that plan are purged and the next `/resolve` for an affected service returns the new rate within 60 s across all API pods.
14. Given a payer rate below the recorded cost, when publishing, then an explicit "loss-making accepted" reason is required and the service appears in the loss-making report.
15. Given the branch's NABH certificate has expired, then the CGHS/PMJAY plan shows a blocking warning and the non-NABH rate column is used, with an alert to Finance and Quality.
16. Given `GET /resolve` under a k6 load of 500 rps, then p95 < 15 ms warm and there are zero `MISSING_RATE` responses for services that have a published rate.
17. Given a user without `tariff.export`, when exporting a price list, then 403 and an audit entry are recorded.
18. Given a public rate card is published, then it renders on the lobby display (EN-018), the website (EN-012) and the patient portal (PE-001) in English and the configured local language with the effective date visible.

## 15. Enhancements / Later phases
- From the VIMS sheet (row 140): rate master, payer-wise tariff, rate revision and comparison dashboard — all core above.
- (market) **Multi-level rate plan management** and **bulk discount** (MocDoc); **three-tier pricing grid** and JSONB-normalised service rates (SmartHospital); **tariff scheme / service tariff sheet / post tariff sheet / bed billing class differential charges / effective-date concept for future price increases / one-click transfer of thousands of service values between tariff schemes** (PCS Prodoc) — modelled as plans, versions, bed-class rows, derivation formulas and copy-plan; **cross time-zone & multi-currency support** (MocDoc) → `tariff.multi_currency`.
- Later: dynamic/occupancy-based room pricing (rules first, ML in AI-005); payer contract modelling with escalation clauses (auto-uplift on contract anniversary); rate negotiation workspace with margin targets; automatic ROHINI/PMJAY code suggestion via AI-006; competitor/peer benchmark subscription feed; bundled-payment & DRG-style pricing (AI-006 grouper); price transparency machine-readable file (US-style, useful for global deployments); what-if payer-mix optimiser; cost accounting integration (activity-based costing from NC-008) to compute true margin per package.

## 16. Open Questions for the Hospital
1. How many rate plans do you run today (self-pay, each corporate, each TPA, CGHS/ECHS/ESIC, PMJAY, state scheme, staff, camp, international) and can we have the current price lists as files?
2. Do rates differ by **bed class** for services (not just room rent)? Which service groups? Do you charge after-hours/night/holiday/emergency differentials, and at what %?
3. Are prices set at group level or per branch? If a group price list exists, which branches may override it and who approves an override?
4. Who approves a rate revision today, at what Δ% thresholds, and does the Medical Superintendent need to co-approve clinical service rates?
5. What is your annual revision cycle (FY start? contract anniversary?) and have you ever needed a **back-dated** rate change — what did you do about already-finalised bills?
6. Is your branch NABH accredited (certificate & validity) — which CGHS/PMJAY rate column applies? Who tracks the renewal?
7. Do you have cost per service (or per department) available for margin analysis, and from which system?
8. For packages: which are fixed-price, what is included, and what happens on excess (itemise / absorb / stop-and-alert)? Are implants inside or outside package rates?
9. Which payer tariff sheets arrive as files vs are negotiated line-by-line? Sample sheets please, so we can build the column templates.
10. Do you display a rate card in the lobby today (Clinical Establishments Act) — in which languages, and which services are listed?
11. Should staff/dependant and senior-citizen concessions be rate plans (contracted price) or bill discounts (approval-based)? Current practice?
12. Any international/foreign-currency pricing needed at launch, and which FX rate source is acceptable to your auditors?
