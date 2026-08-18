# EN-040 — Licence & Subscription Management (SaaS Plans & Module Bundles, Per-Module Feature Flags, User Seats & Concurrent Sessions, Bed-Band & Branch Pricing, Trials & Grace Periods, Expiry Warnings & Graceful Degradation, Usage Metering, Invoicing & Razorpay Recurring, On-Prem Signed Licence Keys with Offline Validation, Entitlement API)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-040 |
| Phase | 0 |
| Priority | P0 |
| Complexity | High |
| Depends on | EN-007 (tenants, branches, users, roles, sessions, settings), EN-024 (audit of every entitlement change), EN-010 (Razorpay — recurring mandates, payment links, webhooks), EN-032/EN-009 (expiry and invoice notifications), EN-037 (in-app warnings and admin alerts), EN-041 (branch hierarchy — what a "branch" costs and how group plans roll up), EN-023 (key material protection, HSM/vault for the licence signing key), EN-017 (usage export to the vendor's billing back office), NC-009 (revenue recognition for the SaaS operator's own books) |
| Consumed by | **Every module** — the entitlement API is the single gate for `module.<key>.enabled` (CLAUDE.md §4 feature-flag rule); notably EN-007 (login & seat enforcement), EN-026 (API rate tiers), EN-001 (report/BI tiers), EN-029 (knowledge-base licensing), EN-009/EN-032 (message quotas), EN-036 (import row limits), EN-034/EN-018 (device counts), OP-019/OP-020/IP-004/IP-010 (mobile-app entitlements) |
| Feature flag | `module.licensing.enabled` (always on — it is the flag authority itself; sub-flags `lic.saas_billing`, `lic.onprem_keys`, `lic.metering`, `lic.self_service_upgrade`) |
| Primary roles | Super Admin (SaaS operator, 1), Hospital Admin (2 — views plan, usage, invoices; requests upgrades) |
| Secondary roles | Branch Admin (3 — branch-scoped usage), Accountant/Finance (46 — invoices, GST), IT Admin (56 — on-prem key installation, concurrent-session policy), Auditor (58), Sales/Customer Success (operator-side role) |
| Regulatory | **GST** on SaaS supply (SAC 998314 IT services; place-of-supply rules, CGST/SGST vs IGST, e-invoicing/IRN above threshold, GSTIN of both parties on the invoice), **TDS §194J/194C** deduction by the hospital on service payments and its reconciliation, **RBI e-mandate / recurring-payment rules** (AFA for e-mandates, pre-debit notification ≥24 h, ₹15 000 per-transaction AFA threshold — handled by EN-010/Razorpay), **DPDP Act 2023** (usage metering must not process patient personal data; counts only), **Companies Act** revenue recognition for the operator, **software licensing law / IT Act §65B** for on-prem licence terms and evidence, and the explicit clinical-safety principle below: no commercial control may block emergency clinical care |

## 1. Purpose
EN-040 is the commercial control plane. It defines what a tenant has bought (plan, module bundle, seats, beds, branches, quotas), turns that into a **single authoritative entitlement decision** consumed by every module, meters actual usage, handles trials, renewals, dunning and graceful degradation, bills SaaS tenants (invoice + Razorpay recurring), and issues cryptographically signed **offline-validatable licence keys** for on-prem deployments. Its most important rule is a safety rule: commercial state may restrict *administrative and convenience* functions, but it must **never** block clinical care, patient safety functions, or a hospital's access to its own data.

## 2. Users & Jobs-to-be-done
- **Super Admin / SaaS operator (1, desktop)**: define plans and module bundles, onboard a tenant with a trial, see live usage vs entitlement across all tenants, handle upgrades/downgrades mid-cycle with proration, chase overdue accounts through a dunning ladder, and generate a signed on-prem key for a hospital that runs its own servers.
- **Hospital Admin (2, desktop)**: see exactly what the hospital has bought, how many seats are used, which modules are off and what they would cost, when the subscription expires, download GST invoices, and request an upgrade without a phone call.
- **IT Admin (56)**: install or renew an on-prem licence key file, verify it validates offline, set the concurrent-session policy, and understand which functions degrade if the licence lapses.
- **Finance / Accountant (46)**: reconcile SaaS invoices, TDS deducted, GST input credit, and the recurring mandate status.
- **Every module (service)**: ask one question — "is `module.pharmacy.enabled` true for this hospital/branch right now, and what are its limits?" — and get an answer in under a millisecond.
- **Auditor (58)**: see who changed an entitlement, when, and on what commercial basis.

## 3. Core Workflows

### 3.1 Plans, bundles & the entitlement model
1. The operator defines **plans** (`lic_plans`): e.g. `Clinic Starter`, `Hospital Standard`, `Hospital Advanced`, `Enterprise Group`, plus `Trial` and `Community/On-Prem Perpetual`. Each plan declares:
   - **Module bundle** — the set of module keys enabled (OPD core, IP, pharmacy, lab, RIS/PACS, ERP/finance, HR, RCM, patient engagement, AI) with optional per-module add-ons.
   - **Capacity dimensions**: named user **seats** (by role class: clinical / front-office / admin / read-only), **concurrent sessions**, **bed band** (≤50, 51–100, 101–250, 251–500, 501–1000, 1000+), **branch count**, **OP visits/month**, **stores/counters**, **devices** (kiosks, TV boards, analyzers, printers).
   - **Metered quotas**: SMS/WhatsApp units, email volume, storage GB (documents, DICOM handled separately), API calls (EN-026 tier), report/BI seats, import rows (EN-036), teleconsult minutes.
   - **Commercials**: base price, per-bed or per-branch price, per-seat price, overage rates, billing frequency (monthly/quarterly/annual), currency, tax class (SAC, GST rate), minimum commitment, and discount rules.
2. A **subscription** (`lic_subscriptions`) binds a tenant to a plan version for a term, with **overrides** (a specific module switched on for this customer, a negotiated seat count, a custom quota) recorded as an explicit, audited amendment rather than a plan fork.
3. The **effective entitlement** for a tenant/branch at a moment in time = plan bundle ⊕ add-ons ⊕ overrides ⊖ suspensions, evaluated with effective dating. It is materialised into a compact **entitlement document** (signed, versioned) cached in Redis and in each service's memory, refreshed on change within 30 s.
4. **Branch scoping** (EN-041): entitlements can be group-wide or per branch (a small satellite branch may have OPD only). Adding a branch is a billable event; the entitlement engine enforces the branch count.

### 3.2 The entitlement API (how every module asks)
- One call: `entitlements.check(hospitalId, branchId?, key, {quantity?})` → `{ allowed: boolean, reason, limit, used, remaining, degradeMode, expiresAt }`.
- Three key families:
  - **Feature keys** — `module.pharmacy.enabled`, `feature.abdm.m2`, `feature.cdss.vendor_kb`, `feature.multi_branch`.
  - **Capacity keys** — `capacity.seats.clinical`, `capacity.concurrent_sessions`, `capacity.branches`, `capacity.beds`.
  - **Quota keys** — `quota.sms.monthly`, `quota.email.monthly`, `quota.storage_gb`, `quota.api_calls.daily`, `quota.import_rows.monthly`.
- **Enforcement points** are declared once per key (`lic_enforcement_points`) so behaviour is consistent: route guard (module not licensed → the nav item is hidden and the route returns 402-style problem+json with an upgrade CTA), action guard (create blocked, read still allowed), quota guard (soft warn at 80 %, hard stop or overage-billing at 100 % per plan), and seat guard (at login).
- The check is **fail-safe by direction**: if the entitlement service is unreachable, cached entitlements (signed, valid up to 72 h) are used; if none exist, the system **fails open for clinical modules and fails closed for administrative/commercial features** — never the reverse.

### 3.3 Seats & concurrent sessions
1. **Named seats** are consumed by active user accounts by role class; deactivating a user releases a seat immediately, and a "seat reclaim" report lists accounts with no login in 60 days.
2. **Concurrent sessions** are counted live from EN-007 sessions per role class. On exceeding the limit, the policy is configurable: `block_new` (with a clear message naming the policy, not a cryptic error), `queue`, or `evict_oldest_idle` (never evicts a session with unsaved clinical work — the client reports dirty state; the oldest *idle* session is chosen).
3. **Shared/device accounts** (kiosk, TV, ward station, analyzer) are counted separately and do not consume clinical seats.
4. **Emergency headroom**: a configurable overflow (default +10 % or 5 sessions, whichever is greater) is always available for clinical roles so a mass-casualty surge cannot be locked out by a seat limit; the overflow is billed as overage and reported, not blocked.
5. Seat and session enforcement never applies to **break-glass emergency access** (EN-023/EN-007) or to patient-portal accounts.

### 3.4 Trials, activation, renewal & grace
1. **Trial**: a tenant is created with `plan = Trial`, full or curated module set, hard row/user caps, a visible countdown in the admin header, and an automatic conversion prompt at T-7, T-3, T-1. Trial data is never deleted at expiry — the tenant moves to `expired` and retains **read-only + export** rights for 90 days (DPDP: the hospital's data is the hospital's).
2. **Activation**: signing a plan creates a subscription with `starts_at`, `term`, `renewal_mode` (auto/manual), payment instrument (Razorpay mandate for auto), and the first invoice.
3. **Renewal**: for auto-renew, a **pre-debit notification** is sent ≥24 h before the charge (RBI requirement, executed via EN-010) and the mandate is debited on the due date; for manual, an invoice and a payment link are issued 30/15/7 days ahead.
4. **Expiry & grace**: at term end without payment the subscription enters **grace** (default 15 days, per contract) — everything works, with an escalating in-app banner and admin notifications. After grace, **graceful degradation** begins (§3.5). At grace + 90 days the tenant is `suspended`: no interactive access, data retained; at contract-defined `terminate_after` (default 180 days), an export bundle is produced and delivered before any deletion, with written confirmation.
5. **Dunning ladder** (SaaS): D-7 reminder → D0 invoice due → D+3 first notice → D+7 second notice + Hospital Admin + Finance → D+15 grace end warning → D+16 degradation begins → D+30 operator account-manager task → suspension per contract. Every step is recorded; a payment at any point restores full entitlement within 60 s.

### 3.5 Graceful degradation (the safety-critical part)
Degradation is a **declared ladder**, never an abrupt shutdown, and it is governed by one inviolable rule: **clinical safety and patient care functions never degrade.**

| Tier | State | What still works | What is restricted |
|---|---|---|---|
| 0 | Active | everything | — |
| 1 | Grace | everything | persistent banner; new branch/seat additions blocked |
| 2 | Soft-degraded (grace + 1) | **all clinical**: registration, triage, orders, e-Rx, results, MAR, vitals, CDSS alerts, discharge, emergency & OT, pharmacy dispensing, lab reporting, billing & receipts (a hospital must be able to collect money and treat patients) | analytics/BI dashboards, report builder, bulk exports, campaigns/marketing, new template & rule authoring, non-clinical integrations, mobile app new logins, API partner access |
| 3 | Hard-degraded (grace + 30) | clinical **read + emergency write** (register an emergency patient, place orders, record vitals, dispense, generate a discharge summary), full **data export** | routine scheduling, new elective registrations, non-clinical modules (HR, procurement, accounts), all admin configuration |
| 4 | Suspended (per contract) | **export only** via a time-boxed admin session; a printed/emailed notice explains how to retrieve data | interactive use |
- **Never degraded at any tier**: allergy and interaction alerts, critical-value alerts and escalation (EN-029/EN-037), MAR safety checks, blood-bank cross-match, emergency/ER and OT modules, audit logging, backup jobs (EN-022), and the ability to export the hospital's own data.
- Degradation state is visible to every user as a banner with a plain explanation and a "contact your administrator" action; the *reason* shown to a clinician is never a cryptic licence error mid-procedure.
- **On-prem** hospitals degrade identically, driven by the licence key's dates rather than by a server call.

### 3.6 Usage metering
- Meters are **counts, never content**: active users by role class, peak concurrent sessions, OP visits, IP admissions, occupied-bed-days, lab tests, imaging studies, prescriptions, bills, SMS/WhatsApp/email units, storage GB by class, API calls, import rows, teleconsult minutes, kiosk/TV device counts, branches.
- Collected by event subscription and hourly rollups into `lic_usage_daily` (no PHI, no identifiers beyond counts), aggregated to `lic_usage_periods` at cycle close, and made visible to the hospital *before* it is billed (transparency prevents disputes).
- **Overage** handling per meter: `warn_only`, `bill_overage` (rate per unit), or `hard_stop` (only permitted for non-clinical meters such as marketing campaigns). Warnings at 80 %/95 %/100 % go to the Hospital Admin.
- Meters reconcile to the invoice line items; a hospital can drill from an invoice line to the daily counts that produced it.

### 3.7 SaaS invoicing & Razorpay recurring
1. At cycle close the engine produces an **invoice**: base plan + per-bed/per-branch/per-seat charges + metered overages − credits/discounts, with **GST** computed on the SAC code and place-of-supply (intra-state CGST+SGST, inter-state IGST), the operator's and the hospital's GSTIN, HSN/SAC, and an IRN/QR where e-invoicing applies.
2. **Payment**: Razorpay Subscriptions/e-mandate for auto-renew (UPI Autopay / card / e-NACH), with the RBI pre-debit notification sent ≥24 h prior; or a payment link/NEFT reference for manual payers. Webhooks (via EN-010) reconcile payments, failures and mandate revocations.
3. **Failure handling**: a failed mandate debit retries per policy (D+1, D+3, D+7), each with a notification; three failures move to manual invoicing and the dunning ladder.
4. **TDS**: hospitals commonly deduct TDS; the system records expected vs received amounts, flags short payments as TDS, and tracks the Form 16A certificate so the operator's AR reconciles.
5. **Proration** on mid-cycle upgrades (immediate access, prorated charge) and downgrades (effective at next cycle by default, with an explicit "immediate with credit note" option).
6. Credit notes, refunds and write-offs follow the same approval discipline as any financial document (EN-038).

### 3.8 On-prem licence keys (signed, offline-validatable)
1. The operator generates a **licence key** for a deployment: a compact document (tenant id, deployment id, plan, module bundle, capacity limits, quotas, issue date, valid-from/valid-to, grace days, support level, optional **hardware binding** = hash of machine id / MAC / CPU id / K8s cluster UID, and a nonce) **signed with the vendor's Ed25519 private key** held in an HSM/vault; the public key is compiled into the product.
2. Delivery as a `.lic` file (base64url of the signed document) or a paste-in string. Installation verifies signature, expiry, hardware binding and clock sanity — **fully offline**, no phone-home required.
3. **Clock-tamper resistance**: the system records a monotonic high-water mark of observed time (in the database and, where present, a signed timestamp from the last online contact); if the system clock jumps backwards past the high-water mark, the licence is treated as invalid-for-extension (it cannot be extended by turning the clock back) but **clinical functions continue** and an alert is raised.
4. **Hardware binding is optional and soft by default**: a mismatch produces a 14-day reconciliation window with loud warnings (hardware fails; VMs migrate) rather than an immediate lockout. Strict binding is available for customers who request it contractually.
5. **Renewal** is a new key file; the product accepts overlapping keys and uses the most favourable valid one. Expiry warnings at 90/60/30/15/7/1 days appear for IT and Hospital Admin, in-app and by email, and a **key expiring inside the grace period never blocks clinical use**.
6. **Optional online activation/heartbeat** (if the deployment has internet and the customer consents) reports usage counts back for support and true-up; refusing it changes nothing about functionality — it is a convenience, not a control.
7. **Anti-abuse without hostility**: duplicate deployment ids on the same key are reported to the operator; the product never disables itself in retaliation, because a disabled hospital system is a patient-safety event.

### 3.9 Exceptions
- **Entitlement service unreachable** → last signed entitlement cache (≤72 h) is used; beyond that, clinical modules fail open, commercial features fail closed, and an alert fires.
- **Payment succeeded but webhook lost** → reconciliation job compares Razorpay settlements to invoices and restores entitlement automatically; support can force-restore with an audited reason.
- **Seat limit hit during a mass-casualty event** → emergency headroom applies, overage is billed, nobody is blocked.
- **Downgrade below current usage** (e.g. plan allows 3 branches, tenant has 5) → the downgrade is accepted but existing branches continue to operate; new creation is blocked and the excess is billed as overage until resolved. Data is never made inaccessible.
- **Disputed invoice** → the account can be placed on `billing_hold` by the operator: dunning pauses, entitlement stays active, and the dispute is tracked.

## 4. Data Model (schema `core`, prefix `lic_`; operator-scoped tables live in the control plane)
- `lic_plans` / `lic_plan_versions` — id, key, name, tier, currency, billing_frequency, base_price, per_bed_price jsonb (band → price), per_branch_price, per_seat_price jsonb (role class → price), module_bundle text[], capacity jsonb, quotas jsonb, overage_rates jsonb, tax jsonb (sac, gst_rate), min_commitment, trial_days, grace_days, degrade_ladder_ref, status, effective_from; versions immutable.
- `lic_subscriptions` — id, hospital_id, plan_version_id, status enum(trial/active/grace/soft_degraded/hard_degraded/suspended/terminated/billing_hold), starts_at, ends_at, renewal_mode enum(auto/manual), term_months, currency, contract_ref, sales_owner, po_ref, degrade_tier int, grace_until, suspend_at, terminate_at, notes, created…; index (status, ends_at).
- `lic_subscription_items` — id, subscription_id, kind enum(module/addon/seat_pack/bed_band/branch/device/quota), key, quantity, unit_price, discount_pct, effective_from, effective_to, amendment_ref.
- `lic_overrides` — id, subscription_id, entitlement_key, value jsonb, reason, approved_by, effective_from, effective_to, ticket_ref; every deviation from the plan is explicit and audited.
- `lic_entitlements` (materialised, per tenant/branch) — hospital_id, branch_id?, key, allowed bool, limit numeric?, degrade_mode, source enum(plan/addon/override/trial), effective_from, effective_to, document_version, signature; cached in Redis with a 30 s propagation SLA.
- `lic_enforcement_points` — key, kind enum(feature/capacity/quota), guard enum(route/action/quota/seat/device), fail_open bool, clinical_safety_exempt bool, message_i18n jsonb, upgrade_cta; the single registry that makes behaviour consistent.
- `lic_usage_daily` — hospital_id, branch_id?, meter_key, date, value numeric, peak numeric?, source, computed_at; **partitioned monthly**; contains counts only, never PHI.
- `lic_usage_periods` — hospital_id, subscription_id, period_start, period_end, meter_key, included, used, overage, rate, amount, status enum(open/closed/invoiced), closed_at.
- `lic_invoices` — id, hospital_id, subscription_id, invoice_no (gapless series), period_start, period_end, issue_date, due_date, currency, subtotal, discount, taxable_value, cgst, sgst, igst, total, place_of_supply, buyer_gstin, seller_gstin, irn, qr_ref, status enum(draft/issued/sent/part_paid/paid/overdue/void/written_off), pdf_ref, sent_at, paid_at; UNIQUE(invoice_no).
- `lic_invoice_lines` — invoice_id, kind, description, hsn_sac, qty, unit, rate, amount, tax_rate, meter_key?, period.
- `lic_payments` — id, invoice_id, gateway enum(razorpay/neft/cheque/manual), gateway_ref, mandate_id?, amount, tds_amount, tds_certificate_ref, received_at, status enum(pending/success/failed/refunded), failure_reason, retry_no.
- `lic_mandates` — id, hospital_id, gateway, mandate_id, method enum(upi_autopay/card/enach), max_amount, status enum(pending/active/paused/revoked/expired), created_at, revoked_at, pre_debit_notified_at.
- `lic_dunning_events` — subscription_id, step, channel, sent_at, acknowledged_at, outcome.
- `lic_keys` (on-prem) — id, hospital_id, deployment_id, plan_version_id, issued_at, valid_from, valid_to, grace_days, capacity jsonb, quotas jsonb, module_bundle text[], hardware_binding jsonb?, binding_mode enum(none/soft/strict), nonce, signature (Ed25519), issued_by, revoked_at, revoke_reason, delivered_to, installed_at, install_fingerprint.
- `lic_key_installs` — key_id, deployment_id, installed_at, machine_fingerprint, app_version, validation_result, clock_highwater_at.
- `lic_audit` — actor, action enum(plan_created/subscription_created/amended/upgraded/downgraded/override_added/suspended/restored/key_issued/key_revoked/degrade_tier_changed/billing_hold_set), before jsonb, after jsonb, reason, at; append-only (also mirrored to EN-024).
- Retention: invoices and payments **8 years** (tax), usage 3 years, entitlement history for the life of the tenant + 3 years, keys permanent.

## 5. Business Rules & Validations
- **Clinical safety is never gated.** Allergy/interaction alerts, critical-value alerts and escalation, MAR safety checks, blood-bank cross-match, emergency/ER, OT and the ability to record and retrieve clinical data are exempt from every licence check. Any enforcement point that would touch them must set `clinical_safety_exempt = true`, and a test asserts this for the exempt list.
- **A hospital always owns and can export its data**, in every state including suspension and termination; export is never gated by payment.
- **Degradation is laddered and announced**, never abrupt: banners and notifications precede each tier by at least 7 days, and the tier is visible to admins with the exact date of the next step.
- **Entitlement decisions are cached and signed**; a service that cannot reach the entitlement store uses its cache (≤72 h) and then fails open for clinical, closed for commercial.
- **Seat and concurrency limits include emergency headroom** for clinical roles; a limit may bill an overage but may not lock clinical staff out during a surge.
- **Every deviation from the plan is an audited override** with an approver and an expiry — no silent per-customer forks of a plan.
- **Trials never auto-charge**; conversion requires an explicit action and a mandate created with RBI-compliant AFA and pre-debit notification.
- **Invoices are gapless and immutable once issued**; corrections are credit notes, and GST fields (place of supply, GSTIN, SAC, tax split) are validated before issue.
- **On-prem keys validate fully offline**; no functionality may depend on reaching the vendor. Clock rollback cannot extend a licence, but clock anomalies never disable clinical use.
- **Hardware binding defaults to soft** with a 14-day reconciliation window; strict binding requires a contractual flag.
- **Metering records counts only** — never patient identifiers or clinical content — and usage is visible to the hospital before it is billed.
- **Downgrades never destroy data or make it inaccessible**; they block new creation of the exceeded resource.
- Super Admin actions on a live tenant (suspend, degrade, override) require a reason and are visible in the tenant's own audit log — the customer can always see what the operator did to their entitlement.

## 6. API Surface (`/api/v1/licensing`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET | /entitlements ; GET /entitlements/check?key&qty | current entitlement document / single check | authenticated service or `lic.entitlement.read` | p99 < 1 ms from cache; ETag |
| GET | /me/subscription | plan, status, expiry, degrade tier | `lic.subscription.read` (Hospital Admin) | customer-facing |
| GET | /me/usage?period&meter | usage vs entitlement | `lic.usage.read` | drill to daily |
| GET | /me/invoices ; GET /me/invoices/:id/pdf | invoices & GST PDFs | `lic.invoice.read` (Admin, Finance 46) | |
| POST | /me/upgrade-request {planKey, seats, addons} | self-service upgrade request | `lic.subscription.request` | creates operator task or self-serve checkout |
| POST | /me/payments/link | pay an invoice now | `lic.invoice.pay` | EN-010 payment link |
| GET/POST/PATCH | /plans ; /plans/:id/versions | plan catalogue (operator) | `lic.plan.manage` (Super Admin 1) | versions immutable |
| GET/POST/PATCH | /subscriptions ; /subscriptions/:id | tenant subscriptions | `lic.subscription.manage` (Super Admin) | reason required |
| POST | /subscriptions/:id/upgrade \| /downgrade \| /renew \| /suspend \| /restore \| /billing-hold | lifecycle | `lic.subscription.manage` | proration computed & shown |
| POST | /subscriptions/:id/overrides | per-customer entitlement override | `lic.override.manage` (Super Admin + approval) | reason, expiry mandatory |
| POST | /subscriptions/:id/degrade-tier | force a degradation tier | `lic.subscription.manage` | audited, visible to tenant |
| GET | /usage?hospital&meter&from&to | operator usage view | `lic.usage.admin` | cross-tenant |
| POST | /billing/close-period ; POST /invoices/:id/issue \| /void \| /credit-note | billing run | `lic.billing.manage` (operator Finance) | gapless numbering |
| POST | /webhooks/razorpay | payment & mandate events | signature-verified public | idempotent, via EN-010 |
| POST | /keys/issue {hospitalId, deploymentId, planVersion, validity, binding} | generate a signed on-prem key | `lic.key.issue` (Super Admin, HSM-backed) | Ed25519, audited |
| POST | /keys/:id/revoke | revoke a key | `lic.key.issue` | reason; does not disable clinical use |
| POST | /keys/install {licenceText} | install/renew a key on-prem | `lic.key.install` (IT Admin 56) | offline validation, no network |
| GET | /keys/status | current key, validity, binding, warnings | `lic.key.install` | shown in the admin console |
| GET | /degradation/preview | what would stop working at each tier | `lic.subscription.read` | transparency screen |
| GET | /reports/mrr ; /reports/churn ; /reports/usage-vs-plan | operator analytics | `lic.report.admin` | control plane |

## 7. Domain Events (outbox)
- `licence.entitlement.changed` → **every service invalidates its cache within 30 s**; nav and route guards refresh.
- `licence.subscription.created|activated|upgraded|downgraded|renewed|expired|suspended|restored|billing_hold_set` → EN-024, EN-037 admin alerts, operator CRM.
- `licence.trial.started|expiring|converted|expired` → in-app countdown, sales task.
- `licence.degradation.tier_changed` → in-app banner for all users, admin notification, TV/status board note.
- `licence.quota.threshold_reached` (80/95/100 %) → Hospital Admin; `licence.quota.exceeded` → module-specific behaviour (queue, warn, bill).
- `licence.seat.limit_reached` / `licence.session.limit_reached` → admin alert with the seat-reclaim report link.
- `licence.invoice.issued|sent|paid|overdue|written_off` ; `licence.payment.failed` ; `licence.mandate.revoked` → Finance (both sides), dunning engine.
- `licence.key.issued|installed|expiring|expired|revoked|binding_mismatch|clock_anomaly` → IT Admin, operator support.
- Consumes: `user.activated|deactivated` (seats), `session.started|ended` (concurrency), `branch.created` (branch count), `bed.count.changed` (bed band), and the meter-source events from messaging, storage, API gateway and imports.

## 8. Screens (UI)
- **Subscription & Usage (Hospital Admin, desktop)**: plan card (name, term, renewal date, status chip with degrade tier if any), module grid showing enabled/disabled with a padlock and "included in Advanced" hint, capacity meters (seats used/total by role class, peak concurrent sessions, beds, branches, devices) as progress bars that turn amber at 80 % and red at 100 %, quota meters for the current cycle, and a plain-language "what happens if we don't renew" link opening the **degradation preview**.
- **Degradation Preview** (desktop): the ladder as a table — for each tier, what continues (with clinical functions prominently marked "always available") and what stops, with the dates each tier would begin. This screen is deliberately reassuring and honest; it is the antidote to renewal anxiety.
- **Invoices & Payments** (desktop, Admin/Finance): invoice list with status, GST breakup, download PDF, pay-now link, mandate status, TDS reconciliation column, and a drill-through from any metered line to the daily usage that produced it.
- **Seat Management** (desktop, Admin): users by role class with last-login, seat consumption, "reclaim" suggestions (no login in 60 days), and the concurrent-session policy selector with an explanation of each option.
- **On-Prem Licence** (desktop, IT Admin): current key details (plan, validity with a countdown, capacity, binding mode, deployment id), install/renew by file upload or paste with immediate offline validation feedback, warnings (expiring, binding mismatch, clock anomaly), and a copy-able deployment fingerprint to send to the vendor.
- **Global banner** (all users, all devices): appears only in grace/degraded states — amber for grace ("Subscription renews on 12 Aug — please contact administration"), red for degraded, with an admin-only "details" link. Never blocks a clinical screen, never a modal.
- **Operator Console — Tenants** (desktop, Super Admin): tenant grid with plan, status, MRR, usage vs entitlement heat, next renewal, overdue amount, degrade tier; row actions (upgrade, override, hold, suspend, restore) each requiring a reason; bulk renewal run.
- **Operator Console — Plan Designer** (desktop): module bundle picker, capacity and quota editors, pricing matrix by bed band, overage rates, tax class, trial and grace settings, and an impact simulation ("42 tenants are on this plan; this change affects 12").
- **Operator Console — Licence Key Issuer** (desktop, Super Admin): tenant/deployment selection, validity and binding options, HSM-backed signing, download `.lic`, and an issued-keys register with revocation.
- **Operator Billing Run** (desktop): period close, draft invoices with variance vs last period, issue in bulk, dunning queue with the ladder state per account.
- Empty/error states: "Pharmacy is not included in your plan — ask your administrator about Hospital Standard" (with no dead-end), "Seat limit reached; 3 accounts have not logged in for over 60 days — reclaim?", "Licence key valid but the hardware fingerprint changed — you have 14 days to reconcile; nothing is blocked".

## 9. Integrations
- **EN-010 / Razorpay**: Subscriptions & e-mandates (UPI Autopay, cards, e-NACH), payment links, webhooks for charge/failure/mandate lifecycle, refunds; RBI pre-debit notification orchestrated through EN-009/EN-032.
- **GST e-invoicing (IRP)** for the operator's invoices above the notified turnover threshold — IRN and signed QR embedded in the invoice PDF (rendered by EN-039).
- **EN-007** for tenants, branches, users, sessions and the feature-flag catalogue; **EN-023/HSM or Vault** for the Ed25519 signing key; **EN-026** for API tier enforcement; **EN-017** for pushing usage snapshots to the operator's back office/CRM.
- **Accounting**: the operator's own revenue postings to NC-009 or an external ERP; TDS certificate tracking.
- **On-prem**: no external dependency at all — signature verification uses an embedded public key, and the entire licence lifecycle works air-gapped.

## 10. Reports & Analytics
- **Customer-facing**: usage vs entitlement by meter and month, seat utilisation trend, cost drivers (which meters generate overage), invoice history with GST and TDS, projected next invoice.
- **Operator-facing**: MRR/ARR, ARPU by plan and bed band, expansion vs contraction, churn and its reasons, trial→paid conversion by cohort, overdue AR ageing, dunning funnel effectiveness, mandate success rate by method, module attach rates (which modules drive upgrades), usage-vs-plan outliers (customers paying for capacity they don't use — a churn signal — and customers persistently over-limit — an upsell signal), on-prem key expiry calendar, and degradation incidents (how many customers hit tier 2+, and how long they stayed).
- **Compliance**: GST register (outward supplies), e-invoicing status, TDS reconciliation, and an audit report of every entitlement override with justification.
- Read models: `analytics.mv_lic_usage_monthly`, `analytics.mv_lic_revenue_monthly`, `analytics.mv_lic_tenant_health`.

## 11. Notifications
- **To Hospital Admin/Finance**: renewal at 30/15/7/1 days; invoice issued and due; payment received/failed; quota at 80/95/100 %; seat limit reached; grace started with the exact degradation dates; each degradation tier change; suspension warning; export-ready notice on termination.
- **To IT Admin (on-prem)**: key expiring at 90/60/30/15/7/1 days; key installed successfully; binding mismatch; clock anomaly; key revoked.
- **To end users**: only the global banner in grace/degraded states — never a per-action licence popup during clinical work.
- **To the operator**: payment failed, mandate revoked, tenant entered grace/degraded, unusual usage spike, trial expiring, key installed on a new fingerprint, tenant requested an upgrade.

## 12. Permissions (RBAC keys)
`lic.entitlement.read` (all services; admins for the UI) · `lic.subscription.read` (Hospital Admin 2, Finance 46, Auditor 58) · `lic.subscription.request` (Hospital Admin) · `lic.usage.read` (Hospital Admin, Branch Admin 3 scoped) · `lic.invoice.read` / `lic.invoice.pay` (Hospital Admin, Finance) · `lic.key.install` (IT Admin 56) · **operator-only**: `lic.plan.manage`, `lic.subscription.manage`, `lic.override.manage`, `lic.billing.manage`, `lic.key.issue`, `lic.usage.admin`, `lic.report.admin` (Super Admin 1 and delegated operator roles, all actions audited and visible to the tenant).

## 13. Non-functional
- **Entitlement check latency p99 < 1 ms** (in-process cache backed by Redis, refreshed on `licence.entitlement.changed` within 30 s) — it is called on every route render and many API calls, so it must be effectively free.
- **Volumes**: a SaaS operator with 200 tenants × ~2000 users each; ~50 M entitlement checks/day (almost all cache hits); metering events ~5 M/day rolled up hourly; billing run for 200 tenants completes in < 10 minutes.
- **Availability**: the entitlement path must be more available than the app itself — cached, signed, valid ≤72 h offline, and fail-open for clinical. A licensing outage may never become a clinical outage.
- **On-prem**: zero external calls required; signature verification < 5 ms; the product must boot and serve clinical traffic even with an expired key (in the appropriate degradation tier).
- **Security**: the Ed25519 private key lives only in an HSM/Vault with dual control; keys are non-transferable and revocation is recorded, but revocation never triggers a hard clinical stop; entitlement documents are signed so a tampered cache is detected.
- **Storage**: usage tables partitioned monthly, 3-year retention; invoices immutable with PDF artefacts retained 8 years.
- **Accessibility & i18n**: banners and licence screens are WCAG 2.2 AA, never colour-only; all customer-facing licence, invoice and degradation text is localisable and written in plain language (a nurse should understand a banner without knowing what a "SKU" is); currency and tax formatting per locale for global deployments.
- **Testing**: an automated test asserts that every `clinical_safety_exempt` enforcement point remains exempt (a regression here is a patient-safety bug); a suite simulates the full ladder trial → active → grace → tier 2 → tier 3 → suspension → restore and verifies clinical functions at each tier.

## 14. Acceptance Criteria
1. **Given** a module is not in the tenant's bundle, **when** a user navigates to it, **then** the nav item is hidden, the route returns a clear "not included in your plan" page with an upgrade path, and no cryptic error is shown.
2. **Given** an entitlement is changed by the operator, **when** the change is saved, **then** every service reflects it within 30 seconds without a restart, and the change is visible in the tenant's own audit log with the operator's reason.
3. **Given** the entitlement service is unreachable, **when** a clinician opens the e-prescription screen, **then** the cached entitlement is used, and if no cache exists clinical modules fail open while analytics and configuration fail closed.
4. **Given** a subscription enters grace, **when** any user logs in, **then** an amber banner states the renewal date and the exact date degradation would begin, and nothing is restricted yet.
5. **Given** a subscription reaches soft-degraded (tier 2), **when** clinicians work, **then** registration, orders, e-Rx, results, MAR, vitals, CDSS alerts, dispensing, billing and discharge all function normally, while BI dashboards, bulk exports and campaigns are restricted.
6. **Given** any degradation tier including suspension, **when** an administrator requests a data export, **then** the export is permitted and completes — data access is never gated by payment.
7. **Given** the seat limit is reached during a mass-casualty activation, **when** additional clinical users log in, **then** the emergency headroom admits them, an overage is recorded and billed, and no clinician is blocked.
8. **Given** a concurrent-session limit with `evict_oldest_idle`, **when** the limit is exceeded, **then** a session with unsaved clinical work is never evicted and the affected user receives a clear message.
9. **Given** an auto-renewing subscription, **when** the debit date approaches, **then** a pre-debit notification is sent at least 24 hours in advance and the mandate is charged only after it.
10. **Given** a mandate debit fails three times, **when** the retry policy is exhausted, **then** the account moves to manual invoicing, the dunning ladder starts, and entitlement remains active through grace.
11. **Given** a payment is received, **when** the webhook or the reconciliation job processes it, **then** full entitlement is restored within 60 seconds and all banners clear.
12. **Given** an on-prem deployment with no internet, **when** a licence key is installed, **then** its Ed25519 signature, validity dates and binding are verified entirely offline and the entitlement takes effect immediately.
13. **Given** an on-prem system clock is set backwards past the recorded high-water mark, **when** the licence is evaluated, **then** the rollback cannot extend validity, an alert is raised, and clinical functions continue to operate.
14. **Given** soft hardware binding and a changed machine fingerprint, **when** the key is validated, **then** a 14-day reconciliation window opens with loud warnings and nothing is blocked during it.
15. **Given** a mid-cycle upgrade, **when** it is applied, **then** access is immediate, the prorated charge is computed and displayed before confirmation, and the invoice line shows the proration basis.
16. **Given** a downgrade below current usage (5 branches on a 3-branch plan), **when** it takes effect, **then** existing branches keep operating, new branch creation is blocked, and the excess is billed as overage — no branch is disabled.
17. **Given** a metered invoice line, **when** the admin drills into it, **then** the daily usage counts that produced it are shown, and those counts contain no patient identifiers.
18. **Given** an invoice is issued, **when** it is inspected, **then** it has a gapless number, correct GST split by place of supply, both GSTINs, the SAC code, and an IRN/QR where e-invoicing applies; corrections are only possible via a credit note.
19. **Given** the trial expires without conversion, **when** the tenant logs in, **then** the account is read-only with export enabled for 90 days and no data has been deleted.
20. **Given** the automated safety test suite runs, **when** it evaluates enforcement points, **then** every clinical-safety-exempt key is confirmed exempt at every degradation tier, and the build fails if one is not.

## 15. Enhancements / Later phases
- **Self-service checkout and instant provisioning** (plan selection → mandate → entitlement live in minutes) for smaller clinics, with in-product upgrade paywalls that explain value rather than merely blocking.
- **Usage-based (consumption) pricing** models — per OP visit, per bed-day, per test — with real-time cost visibility for the hospital, alongside the current subscription model.
- **Marketplace & partner modules**: third-party modules licensed through the same entitlement fabric with revenue share.
- **Customer health scoring** combining usage depth, module adoption, support tickets and payment behaviour to predict churn and drive customer success.
- **Multi-currency and multi-entity billing** for global deployments (UAE VAT, Qatar, African markets) with local tax engines.
- **Reseller/partner portal** with sub-tenancy, partner pricing and their own dunning.
- **Automated true-up** for on-prem: an optional signed usage report generated locally and emailed, so annual true-ups need no auditor visit.
- **Entitlement-aware onboarding**: the setup wizard adapts to the plan, and unpurchased modules appear as guided previews with sample data rather than locked doors.

## 16. Open Questions for the Hospital / Operator
1. What are the **plans and price points** at launch (module bundles, bed bands, seat pricing, branch pricing), and which modules are core versus add-on?
2. Is pricing **per named user, per concurrent session, per bed, per branch, or a blend**, and what is the intended emergency headroom?
3. What are the **trial length, grace period and suspension timelines** contractually, and who signs off a suspension for a live hospital?
4. Which functions may the operator and the hospital agree to degrade at each tier — please confirm the clinical-exempt list is acceptable and complete.
5. For **on-prem** customers: is a signed offline key acceptable, is hardware binding required (soft or strict), and what happens contractually if the key expires (the product will not stop clinical care)?
6. Which **payment methods** are expected — Razorpay e-mandate (UPI Autopay/e-NACH), card, or NEFT against invoice? Who is the merchant of record?
7. Does the hospital **deduct TDS**, at what rate and section, and who reconciles Form 16A?
8. Is **e-invoicing (IRN/QR)** applicable to the operator, and what is the place-of-supply for each customer?
9. What **usage meters** are commercially relevant (visits, tests, storage, messages, API calls), and what should happen at 100 % — warn, bill overage, or stop (non-clinical only)?
10. Who at the hospital receives **renewal, invoice and degradation notifications**, and through which channels?
11. Should the hospital be able to **self-serve upgrades**, or must every change go through the operator's sales process?
12. For a **multi-branch group** (EN-041): is the subscription at group level with branch add-ons, or per branch, and who pays?
13. What is the **data-retention and export commitment** on termination (default: full export delivered before any deletion, 180 days), and does the contract state it explicitly?
