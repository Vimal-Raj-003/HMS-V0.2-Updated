# OP-023 — Package Configuration & Booking (Service packages, Inclusions/exclusions, Booking with advance, Activation, Variance & excess approval, Validity, Reports)

| Field | Value |
|---|---|
| Domain | OPD Clinical (billing-adjacent; schema `billing`) |
| Module ID | OP-023 |
| Phase | 5 |
| Priority | P1 |
| Complexity | Medium–High |
| Depends on | RC-003 (tariff engine — package price is a tariff object; payer-wise), OP-005 (OP billing posts package lines & variance), IP-005/IP-008 (IP billing consumes package activation; IP-008 owns surgery-bundle specifics & insurance mapping; OP-023 is the shared package engine/master), EN-027 (service catalogue), OP-001 (booking/appointments), IP-001 (admission triggers activation), NC-001 (advance receipts), EN-010 (online advance), EN-038 (approval matrix for variance/excess), EN-002/RC-007 (insurer/scheme package mapping, PMJAY HBP packages), RC-008 (cost estimator/co-pay), OP-014 (health check-up packages), OP-012/OP-015/OP-031/OP-024 (session/cycle packages), OP-006 (day-care packages), OP-010 (procedure packages), NC-006/NC-008 (consumable inclusions), NC-012 (corporate packages), NC-034 (doctor fee inclusions/payouts), EN-009 (confirmations/pre-op instructions), PE-001/OP-020 (patient-facing comparison), EN-012 (website), NC-011/EN-001 (analytics), EN-024 (audit) |
| Feature flag | `module.packages.enabled` (sub: `packages.dynamic_pricing`, `packages.patient_compare`, `packages.insurance_automap`) |
| Primary roles | Billing Executive (27), Hospital/Branch Admin (2/3, configuration), Receptionist (24, booking), Insurance/TPA desk (28) |
| Secondary roles | Doctor/Surgeon (9, selects package/estimate), Finance (46), Corporate billing (29), Patient (portal comparison/booking), Marketing (55), Auditor, Quality (54: variance) |
| Regulatory | GST (composite vs mixed supply for packages: healthcare services exempt (Notification 12/2017) — non-healthcare inclusions (cosmetics, deluxe room > ₹5000/day taxable at 5 % w/o ITC per 2022 amendment) must be split; HSN/SAC on lines), IRDAI/GIPSA & PMJAY HBP 2022 package codes and rates, NABH (transparent tariff display, estimate to patient, billing accuracy), Consumer Protection Act (advertised package inclusions binding), Clinical Establishments Act (rate display), Income-tax (advance receipts), DPDP |

## 1. Purpose
OP-023 is the enterprise **package engine**: define service packages (surgery bundles, health check-ups, procedure/day-care packages, dialysis/physio/chemo session packs, IVF cycle packages, maternity, wellness) as versioned, effective-dated master data with components (services, consumables, bed/room class & days, doctor fees, drugs caps), inclusion/exclusion rules and per-item caps, payer-wise pricing (retail, corporate, insurer/scheme codes) with savings vs à-la-carte; support booking with advance and instructions, activation at visit/admission with auto-authorisation of included services, real-time variance tracking (actual vs package), excess-charge flagging with approval before billing beyond limits, validity/expiry, patient-facing comparison, insurance auto-mapping and profitability analytics. IP-008 extends this engine for surgery-bundle clinical specifics; OP-014 for health-check routing.

## 2. Users & Jobs-to-be-done
- **Admin/tariff manager** (desktop): create/version packages, components, rules, pricing per payer, validity, publish; simulate a bill; compare with PMJAY/insurer package codes.
- **Receptionist/billing** (desktop): sell/book package (walk-in, phone, portal), collect advance, print confirmation & instructions, activate on arrival/admission, watch variance, seek approvals, close package at bill.
- **Doctor/surgeon**: choose package for planned surgery/procedure (estimate to patient), request non-included items with justification.
- **Insurance desk**: map package to insurer/scheme code, pre-auth on package amount, handle exclusions/co-pay.
- **Finance/management**: utilisation, variance, profitability, leakage (RC-006).
- **Patient**: compare packages, book & pay advance online, see inclusions and estimate.

## 3. Core Workflows
### 3.1 Package configuration
1. Create package (`package_kind`: surgery/procedure/day_care/health_check/session_pack/cycle/maternity/wellness/other) → header (code, name, description, department, specialty, applicable to OP/IP/day-care, gender/age limits, LOS/room class assumptions, validity days after purchase, max sessions/cycles) → **components**: services from catalogue (consult, OT, anaesthesia, investigations, procedures, physio sessions, dialysis sessions…) with qty/caps; consumables/implant classes with caps (e.g. "implant up to ₹40,000 or standard implant X"); pharmacy cap (amount or formulary list); bed/room class & days (upgrade rules & differential); doctor fees (surgeon/anaesthetist/assistant — payout mapping NC-034); nursing/other charges; **exclusions** explicit list (blood products, ICU beyond N days, higher implants, comorbidity management, extra days) → **rules**: what is covered, per-item caps, "beyond cap → chargeable at tariff/discounted %", extra-day charge, room upgrade differential, complication handling (convert to itemised with approval), inclusion of pre-op work-up window (e.g. 7 days before), post-discharge follow-ups (e.g. 2 free consults within 30 days).
2. **Pricing** (RC-003 tariff objects, effective-dated, per payer plan: retail, corporate contract, TPA/insurer, PMJAY/state scheme (HBP code & rate), international); auto-compute à-la-carte total (from current tariffs) → **savings display**; GST split (exempt healthcare vs taxable components); optional dynamic pricing rules (`packages.dynamic_pricing`: occupancy-based or seasonal % adjustments with approval); cost basis (standard cost of components from NC-006/NC-008 & fee shares) → margin.
3. Approval (EN-038: finance + medical director) → publish → visible in booking channels & estimator (RC-008); versioning: changes create new version effective from date; bookings pin the version.
### 3.2 Booking & advance
1. Booking (front office/portal/app/website/call centre/corporate): patient → package version → payer plan → date (surgery/admission/check-up) → **estimate** (package price + expected exclusions/co-pay via RC-008) → **advance** (policy %; NC-001 receipt or EN-010 link) → confirmation SMS/WhatsApp with inclusions summary, **pre-op/pre-procedure instructions** (fasting, tests to bring, admission time) → booking no. (series `PKG_BK`); insurer: pre-auth request auto-drafted with package code (EN-002).
2. Reschedule/cancel with refund rules; validity/expiry management (session packs: N sessions within X days; expiry reminders; extension approval).
### 3.3 Activation & auto-authorisation
1. On visit/admission/day-care check-in (IP-001/OP-001/OP-006 events) with booking → **activate** package on the encounter/admission → included services **auto-authorised**: orders for included items post at ₹0 marginal (covered) inside package line; bed charges within class/days covered; pharmacy/consumables within caps covered; doctor fees included; anything outside → flagged as **exclusion/excess** in real time (billing engine OP-005/IP-005 evaluates every charge event against package rules: covered / capped (partial) / excluded).
2. Package dashboard per patient: covered amount used, caps consumed (implant, pharmacy, days), exclusions accrued, projected excess; alerts at 80 %/100 % of caps.
### 3.4 Variance & excess approval
1. Charge beyond package limit (extra day, higher implant, ICU, extra investigation not in package) → **flag** → requires **approval** (EN-038 matrix: billing supervisor for < ₹X, medical director/finance beyond; clinical justification captured from doctor) before it is billed to patient/insurer; options: absorb (write-off to package variance), bill patient (with consent/estimate revision), bill insurer (pre-auth enhancement), convert package to itemised (complications; approval).
2. **Variance tracking**: actual cost/charges vs package price per component; variance summary at closure; reasons coded (clinical complication/patient choice/error/upgrade); feeds profitability & RC-006 leakage.
3. Closure at final bill: package line + approved excess lines + exclusions; GST split; receipts adjust advance; unused sessions (session packs) → refund/forfeit per policy; post-discharge free follow-ups tracked.
### 3.5 Insurance/scheme mapping (`packages.insurance_automap`)
- Package ↔ insurer/TPA package codes & PMJAY HBP codes; on booking with payer, system suggests mapped package & rate, pre-auth amount, patient co-pay estimate (RC-008); differences (hospital package vs scheme rate) shown; scheme rules (PMJAY: implants incl./excl., stay days) validated.
### 3.6 Patient-facing comparison (`packages.patient_compare`)
- Portal/app/website: side-by-side inclusions/exclusions, price, savings, room class, LOS, doctor, FAQs; estimate co-pay by insurance; book & pay advance.
### 3.7 Exceptions
- Booking without advance (policy) → hold; package version retired before activation → auto-migrate to current with price protection rule (config); patient upgrades room → differential rules; conversion to itemised; refunds; offline: none (billing online) except read-only package cards.

## 4. Data Model (schema `billing`)
- **packages**: id, hospital_id, branch_id? (null = all), code, name, kind enum, department_id, specialty, scope enum(op/ip/day_care/any), gender, age_min/max, los_days_included, room_class_id, validity_days, max_units (sessions/cycles), description, terms, is_public, status enum(draft/pending_approval/active/retired), current_version, created_*; unique (hospital_id, code).
- **package_versions**: id, package_id, version, effective_from, effective_to, components jsonb ([{type: service|consumable_class|implant_class|pharmacy_cap|bed|doctor_fee|other, ref_id, qty, cap_amount, cap_qty, notes}]), exclusions jsonb, rules jsonb ({beyond_cap: tariff|discount_pct, extra_day_charge, upgrade_rule, preop_window_days, post_followups: {count, days}, complication_policy}), a_la_carte_total numeric, cost_basis numeric, gst_split jsonb, approved_by, approved_at, sha256; unique (package_id, version).
- **package_prices** (RC-003 linked): package_version_id, payer_plan_id (retail/corporate/insurer/scheme), price numeric, currency, savings numeric, scheme_code?, dynamic_rule_id?, effective_from/to.
- **package_scheme_maps**: package_id, payer_id, scheme enum(pmjay/cghs/echs/esic/state/tpa), external_code, external_rate, inclusions_note, effective_from/to.
- **package_bookings**: id, hospital_id, branch_id, booking_no, patient_id, package_version_id, payer_plan_id, doctor_id?, planned_date, channel, estimate_id (RC-008), advance_required numeric, advance_paid numeric, advance_receipt_ids uuid[], status enum(booked/confirmed/activated/completed/cancelled/expired/converted), valid_until, instructions_sent_at, preauth_id?, cancel_reason, refund_id?, created_*; index (hospital_id, status, planned_date), (patient_id).
- **package_activations**: id, booking_id?, package_version_id, patient_id, encounter_id?/admission_id?/daycare_id?, activated_at, activated_by, status enum(active/closed/converted_itemised), units_total, units_used, caps_state jsonb ({implant_used, pharmacy_used, days_used}), covered_amount, excess_amount, exclusions_amount, closed_at, closure_bill_id, variance_summary jsonb; index (admission_id), (encounter_id).
- **package_charge_evaluations** (partitioned): activation_id, charge_event_id (bill item), service_id, amount, decision enum(covered/capped/excluded/excess_pending/excess_approved/excess_absorbed), covered_amount, patient_amount, rule_ref, evaluated_at.
- **package_variance_requests**: id, activation_id, item_ref, amount, reason_code enum(complication/patient_choice/upgrade/clinical_need/error/other), justification, requested_by, approver_chain jsonb, status enum(pending/approved/rejected/absorbed), decision_by, decided_at, bill_action enum(bill_patient/bill_insurer/absorb/convert).
- **package_followup_entitlements**: activation_id, kind, count_total, count_used, valid_until.
- **package_utilisation_daily** (read model), **package_profitability_monthly** (read model).

## 5. Business Rules & Validations
- Package components must reference active catalogue items; caps in amount or qty; à-la-carte total recomputed nightly (tariff changes) for savings display; price < à-la-carte enforced unless flagged "premium bundle".
- Versioning: any component/price/rule change → new version; bookings/activations pin version; retired versions cannot be booked; price protection for confirmed bookings (config days).
- Advance: default 100 % for health-check, 25–50 % for surgery (config); non-refundable portion policy; refunds via OP-005/NC-001 rules; expiry of unactivated booking after validity → notify → cancel with refund policy.
- Activation: only one active package per admission unless additive (e.g. maternity + newborn); pre-op window covers included work-up ordered ≤ N days before; included services post as covered lines (₹0 patient share) — bill shows package line + covered items (for transparency/insurer) or collapsed per payer requirement.
- Charge evaluation on every charge event (idempotent per bill item); exclusions billed at tariff; capped items split covered/patient; excess needs approval before appearing on patient's payable (shown as pending); approvals segregated (requester ≠ approver); absorb → variance write-off account (NC-009).
- Session packs: unit decrement on completed session events (OP-012/OP-015/OP-031); expiry & extension approvals; unused units refund/forfeit per T&C shown at sale.
- GST: exempt healthcare vs taxable lines split by component classification (room > ₹5000/day, cosmetic, non-clinical); HSN/SAC per line; invoice per OP-005/IP-005 numbering.
- Insurance: pre-auth amount = mapped scheme rate; differences displayed; scheme validations (PMJAY HBP: implants included, package can't be split without rules).
- Dynamic pricing changes require approval and cannot apply to confirmed bookings.
- Audit all config & approvals; profitability uses cost basis (standard cost) — refreshed monthly.

## 6. API Surface (`/api/v1/packages`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST/GET/PATCH | /packages, /packages/{id} | header CRUD | package.configure | Y | cursor |
| POST | /packages/{id}/versions, /versions/{id}/submit, /approve, /retire | versioning & approval | package.configure / package.approve | Y | – |
| GET | /packages/{id}/versions/{v} | detail | package.read | – | – |
| POST/GET | /versions/{id}/prices, /scheme-maps | pricing/mapping | package.price.configure | Y | – |
| POST | /simulate (version, payer, scenario) | simulate bill/savings/co-pay | package.read | – | – |
| GET | /catalog?scope=&payer=&department=&public= | booking catalogue (also public for website/app) | package.read / public | – | cursor |
| POST | /bookings | book (+ estimate + advance intent) | package.booking.create | Y | – |
| GET/PATCH | /bookings/{id} | read/reschedule/cancel | package.booking.read/update | Y | – |
| POST | /bookings/{id}/advance (receipt link) | record advance (NC-001/EN-010) | package.booking.update | Y | – |
| POST | /activations (booking or ad-hoc on encounter/admission) | activate | package.activation.create | Y | – |
| GET | /activations/{id} | dashboard (caps, covered, excess) | package.activation.read | – | – |
| POST | /activations/{id}/evaluate (charge event) — internal from billing | decision | system | Y | – |
| POST | /activations/{id}/variance-requests, /variance-requests/{id}/decide | excess approvals | package.variance.request / package.variance.approve | Y | – |
| POST | /activations/{id}/convert-itemised, /close | lifecycle | package.activation.manage | Y | – |
| GET | /activations/{id}/followups; POST /followups/{id}/consume | entitlements | package.activation.read/manage | Y | – |
| GET | /reports/utilisation, /reports/variance, /reports/profitability | analytics | package.report.read | – | – |

## 7. Domain Events (outbox)
- `package.version.published|retired`, `package.price.changed` → RC-003 cache, RC-008, EN-012/OP-020 catalogue; `package.booked|rescheduled|cancelled|expired` → EN-009 (confirmation/instructions), NC-001/EN-010 (advance), EN-002 (pre-auth draft), OP-001/IP-001 (planned admission); `package.activated` {activation_id, admission/encounter, version} → OP-005/IP-005 (billing mode), OP-002/IP-003 (auto-authorised orders), OP-014 (routing); `package.cap.threshold` {cap, pct} → billing/doctor alerts; `package.excess.flagged|approved|absorbed|rejected` → OP-005/IP-005, EN-038, RC-006; `package.converted_itemised`, `package.closed` {variance_summary} → NC-009 (variance GL), analytics, NC-034 (fee shares).
- Consumes: `bill.item.posted` (evaluate), `ip.admitted|discharged`, `visit.checked_in`, `session.completed` (OP-012/OP-015/OP-031), `payment.received|refunded`, `preauth.approved|queried`, `tariff.changed` (RC-003), `bed.transferred` (room upgrade).

## 8. Screens (UI)
1. **Package designer** (desktop admin): header form, component grid (search catalogue, qty/caps), exclusions list, rules panel with plain-language preview ("Includes 3 days General ward; extra day ₹3,500"), pricing tab per payer with savings & GST split, cost/margin, simulate bill, version diff, submit/approve; `Ctrl+S` save, `Ctrl+Shift+P` publish.
2. **Package catalogue & booking** (desktop reception; portal/app/website): cards with price/savings/inclusions, compare (up to 3), payer selector → estimate & co-pay, book wizard (patient, date, doctor, advance payment), print/send confirmation & instructions.
3. **Package dashboard on patient bill** (OP-005/IP-005 desktop; tablet ward view read-only): coverage bar, caps gauges, excess pending list with approve/justify actions, exclusions, projected excess, convert-to-itemised; real-time via billing events.
4. **Variance approval queue** (desktop billing supervisor/MD): pending excess requests with justification, amounts, decision buttons; SLA timers.
5. **Insurance mapping** (desktop TPA desk): package ↔ scheme code grid, rate differences, pre-auth amount preview.
6. **Package analytics** (desktop dark): utilisation, revenue per package, variance analysis, profitability per package/doctor, expiry/unused sessions, conversion rate from bookings.
7. **Patient portal/app comparison** (`packages.patient_compare`): plain-language inclusions/exclusions, co-pay estimator (RC-008), book & pay.

## 9. Integrations
- RC-003 tariff objects & payer plans; OP-005/IP-005 billing engine hooks (charge evaluation API in-process); NC-001/EN-010 advances & refunds; EN-038 approvals; EN-002/RC-007 pre-auth & PMJAY HBP master import (CSV/API); RC-008 estimator; NC-009 GL (variance write-off, advance liability); NC-034 fee shares; EN-009 templates; EN-012/OP-020 catalogue; NC-006/NC-008 cost basis; EN-001 analytics.

## 10. Reports & Analytics
- Package utilisation (bookings, activations, conversion, cancellations, expiries), revenue per package type/version/payer, savings offered, variance analysis (by reason code, department, doctor), excess approved/absorbed/rejected amounts, profitability per package (price − standard cost − fees), cap breach frequency (implants/pharmacy/LOS), insurer/scheme rate gaps, unused sessions liability, advance liability aging, dynamic pricing impact. Read models `analytics.package_utilisation_daily`, `analytics.package_profitability_monthly`.

## 11. Notifications
- Patient: booking confirmation with inclusions/exclusions summary & instructions, advance receipt, reminders (D-3/D-1), expiry warnings for session packs, excess charge consent/estimate revision, package closure summary.
- Staff: excess pending approval (approver chain, SLA), cap thresholds 80/100 % (billing + treating doctor), booking without advance > 48 h, package version retiring with open bookings, insurer rate gap on booking, price change approvals; Finance: monthly variance/profitability report.

## 12. Permissions (RBAC keys)
`package.read`, `package.configure`, `package.approve`, `package.price.configure`, `package.booking.create|read|update`, `package.activation.create|read|manage`, `package.variance.request|approve` (ABAC amount_limit), `package.report.read`, `package.export`. Defaults: Admin/tariff manager — configure/price; Finance head/MD — approve; Reception/billing — booking, activation create/read, variance request; Billing supervisor — variance approve ≤ limit; MD/Finance — approve above; Doctor — read, variance request (justification); TPA desk — read, scheme maps; Patient — public catalogue/own bookings; Auditor — read/export.

## 13. Non-functional
- Volumes: 500 active packages × versions, 300 bookings/day, 2000 activations concurrent, 50k charge evaluations/day (< 20 ms each, in-process with cached rules; Redis cache of active versions); catalogue p95 < 150 ms; simulate < 300 ms.
- Consistency: charge evaluation in same transaction as bill item posting (idempotent per item); approvals via EN-038 with audit; version pinning guarantees reproducible bills.
- Availability: package engine unavailable → billing falls back to itemised with flag & later reconciliation (never blocks clinical orders).
- Print: booking confirmation/estimate (A4), inclusions leaflet (patient language), closure variance summary.
- Security/audit: all config & price changes audited with before/after; export audited; DPDP for patient-facing estimates.
- i18n: patient-facing inclusion text multilingual; currency multi (global-ready).

## 14. Acceptance Criteria
1. Given a TKR package version with 5 days General ward, implant cap ₹60,000 and pharmacy cap ₹15,000, when activated on admission, then included OT/anaesthesia/consult orders post as covered lines and the dashboard shows caps at 0 %.
2. Given implant used ₹75,000, then ₹60,000 is covered, ₹15,000 shows as excess pending approval; billing to patient is blocked until a supervisor approves (or absorbs), with the surgeon's justification captured.
3. Given stay extends to day 7, then extra-day charges apply per rule (₹3,500/day) as exclusions and a cap-threshold alert fired at day 5 (100 %).
4. Given a package version retired after a confirmed booking, then the booking retains its version and price (price protection) and activates normally.
5. Given payer = PMJAY with mapped HBP code, when booking, then pre-auth draft amount equals scheme rate and the rate gap vs hospital price is displayed to the TPA desk.
6. Given a physio 10-session pack valid 60 days, when 10 sessions complete, then units_used = 10 and further sessions bill itemised; at day 55 with 3 unused, an expiry reminder is sent; extension requires approval.
7. Given a package includes 2 free follow-up consults within 30 days, then the 3rd consult or a consult on day 31 bills at tariff.
8. Given a room upgrade from General to Private, then the differential posts per rule as patient-payable exclusion with consent captured.
9. Given complications convert the package to itemised (approved), then covered lines are re-rated at tariff, the package line is reversed, and the variance summary records reason "complication".
10. Given a booking with 50 % advance policy, when advance is unpaid at 48 h, then reception is alerted; at validity expiry the booking cancels with refund policy applied.
11. Given GST rules, when a package includes a deluxe room > ₹5,000/day, then the closure bill shows the taxable room component with SAC and 5 % GST separately from exempt healthcare lines.
12. Given a requester who is also the approver for a variance, then approval is blocked (segregation of duties) and audited.
13. Given the profitability report for last month, then it computes price − standard cost − fees per package from read models in < 1 s.
14. Given the patient app comparison of Basic vs Advanced health-check packages, then inclusions/exclusions/savings render from the published version and booking pins that version.

## 15. Enhancements / Later phases
- Sheet row 13 ("Vital Room" — actually package config) core: define packages (surgery bundles, health check-ups, procedure packages), components (services + consumables + bed + doctor fees), inclusion/exclusion & caps, booking with advance & pre-op instructions, activation on admission with auto-authorisation, variance tracking, excess flag & approval, utilisation/revenue/variance/profitability reports; enhancements: dynamic pricing by occupancy (`packages.dynamic_pricing`, Phase 9/11 with IP-025 occupancy feed), patient-facing comparison tool (Phase 10, `packages.patient_compare`), insurance auto-mapped package selection (Phase 5/11, `packages.insurance_automap`), package profitability dashboard (Phase 11 EN-001), patient co-pay estimator (RC-008 Phase 5), package validity/expiry management (core).
- Later: AI-005 variance prediction (LOS/implant), bundled-payment analytics, NHCX package claims (RC-001), marketplace publishing (EN-012), corporate wellness bundles (NC-012/PE-006).
- (market) SmartHospital package vs itemised split & auto-detection, Ayushman formats; MocDoc packages; PCS health-check plan allocation — covered.

## 16. Open Questions for the Hospital
1. Current package list (surgery/health-check/session packs) with inclusions/exclusions/caps and payer-wise prices; PMJAY/insurer package codes used?
2. Advance % policies per package kind; refund/cancellation rules; price protection days?
3. Approval matrix for excess (amount bands, roles); absorb (write-off) policy & GL account?
4. Bill presentation: collapsed package line vs itemised covered lines for patients/insurers?
5. Room upgrade differential rules; extra-day charges; complication conversion policy?
6. GST classification of components (deluxe rooms, cosmetics, non-clinical); SAC codes?
7. Dynamic pricing appetite and governance; patient-facing comparison on website/app at go-live?
