# RC-006 — Revenue Leakage Audit (Charge-Capture Reconciliation, Unbilled/Underbilled Detection, Missed-Charge Alerts Before Discharge, Discount & Refund Audit, Recovered-Amount Dashboard, Sampling Audits)

| Field | Value |
|---|---|
| Domain | Revenue Cycle Management |
| Module ID | RC-006 |
| Phase | 5 (core rules with billing) → 9/11 (sampling audits, cost-of-leakage analytics, ML anomaly detection) |
| Priority | P1 |
| Complexity | High |
| Depends on | OP-005 (OP bills, discounts, refunds, credit notes, billing exceptions table), IP-005 (IP running bill, room/nursing auto-posting, held items, package excess), RC-003 (missing/expired rates, unmapped payer services), OP-004 (lab orders vs results vs charges), OP-008 (imaging orders vs studies vs charges), OP-003/IP-014 (pharmacy dispenses, ward stock issues, returns), NC-006/NC-008 (stores issues, consumption entries, cost centres), NC-007/TR-003 (consignment implants — usage vs billing vs vendor invoice), IP-006 (OT: procedures performed, consumables, implants, OT time), IP-007 (blood components issued), IP-009/TR-006 (ICU: ventilator hours, monitoring, procedures), IP-003 (nursing procedures, oxygen, infusions), IP-001 (bed occupancy timeline = room-day source of truth), IP-002 (discharge clearance gate), OP-002/OP-010/OP-039 (procedures performed in OPD), OP-023/IP-008 (package inclusions vs extras), EN-042 (device/IoT hours where available), RC-001 (claim readiness — leakage blocks claims), RC-004 (documentation defects that cause denials overlap leakage), RC-005 (uncollected ≠ unbilled — kept distinct), NC-009 (revenue recognition impact), NC-015 (CAPA), EN-038 (waiver approvals), EN-037 (alerts), NC-011/EN-001 (dashboards), EN-024 (audit) |
| Feature flag | `module.leakage.enabled` (sub: `leakage.pre_discharge_gate`, `leakage.sampling_audit`, `leakage.anomaly_ml`, `leakage.implant_recon`, `leakage.device_hours`) |
| Primary roles | Revenue Integrity / Billing Audit Officer (27/46 family), Billing Supervisor (27), Insurance desk (28, pre-claim completeness) |
| Secondary roles | Ward Nurse in-charge (17 — resolves ward-level missed charges), OT in-charge (20), ICU in-charge (18), Pharmacy in-charge (32), Stores in-charge (44), Lab/Radiology in-charge (33/36), Finance Manager (46), Internal Auditor (58), Medical Superintendent (4 — clinical documentation), Hospital Admin (2), HOD (5) |
| Regulatory | **NABH ROM (Responsibilities of Management) & FMS** — accurate and transparent billing, itemised bills, documented tariff; **NABH AAC/COP** — services documented in the record (an undocumented service is both a clinical and a billing defect); **Clinical Establishments Act** (charges as displayed); **GST** (unbilled supplies are still supplies — under-billing creates tax exposure; credit-note discipline under §34), **Companies Act / Ind AS 115** (revenue recognised when performance obligation is satisfied — charge capture is the operational implementation of this), **Income-tax** (§40A(3), documentation of discounts and write-offs), **IRDAI/payer contracts** (billing above the agreed tariff is a contractual breach; billing items not delivered is fraud), **PMJAY/NHA anti-fraud rules** (RC-007 — up-coding and phantom billing carry penalties and de-empanelment), **DPDP** (audit views contain PHI), internal-control expectations for statutory audit |

## 1. Purpose
RC-006 answers a question most hospitals cannot answer: *did we bill for everything we actually did, at the right price, and not for anything we did not do?* It reconciles what the clinical and supply-chain systems say happened (orders executed, drugs issued, implants used, room-days occupied, ventilator hours, OT minutes, doctor visits) against what billing charged, detects **unbilled**, **underbilled** and **over-billed** events with rules, raises **missed-charge alerts before discharge clearance** while the money is still collectable, audits discounts, waivers, refunds and cancellations for abuse, runs periodic **sampling audits** with a formal methodology, and reports the rupees actually recovered — the only leakage metric that means anything.

## 2. Users & Jobs-to-be-done
- **Revenue integrity officer** (desktop, daily): work the exception queue, confirm or dismiss each with a reason, chase the owning department, measure recovery. 100–300 exceptions/day at a 2000-bed hospital.
- **Billing supervisor**: clear pre-discharge exceptions before the bill is finalised — that is where 80 % of recoverable leakage is caught.
- **Ward / OT / ICU in-charge** (tablet at the station): resolve their unit's missed charges in minutes ("was this dressing done? yes → post the charge; no → dismiss with reason"), because only they know the truth.
- **Pharmacy / stores in-charge**: reconcile issues vs charges vs returns; consignment implant usage vs billing vs vendor invoice.
- **Insurance desk**: ensure completeness before a claim is packed (an unbilled implant discovered after submission is unrecoverable).
- **Finance manager**: leakage rate, recovered amount, top causes, department accountability, discount/refund abuse patterns.
- **Internal auditor**: run a sampled audit with a documented sample frame, record findings, track CAPA.
- **Medical Superintendent / HOD**: documentation defects surfaced as leakage (a procedure performed but not documented is invisible to billing).

## 3. Core Workflows

### 3.1 Charge-capture reconciliation engine
A scheduled reconciler (near-real-time for admitted patients, hourly for OP, nightly full sweep) compares **execution evidence** against **billed lines**, per encounter, using the source-of-truth pairs below. Each mismatch becomes an **exception** with type, amount estimate, owning department, evidence links and a suggested action.

| # | Domain | Execution evidence (source) | Expected charge | Typical leak |
|---|---|---|---|---|
| 1 | Laboratory | `lab.result.validated` / sample accessioned (OP-004) | lab test charge per test/profile | add-on tests done on the same sample, repeat tests, STAT surcharge, outside-referral tests |
| 2 | Radiology | study completed / report signed (OP-008, PACS study count EN-008) | imaging charge, contrast, extra views, portable surcharge | extra series, contrast media, C-arm time in OT |
| 3 | Pharmacy & consumables | dispense/issue (OP-003, IP-014, NC-006 ward issue) | pharmacy line at MRP/tariff | ward floor-stock consumption, emergency-trolley drugs, IV fluids, syringes |
| 4 | Pharmacy returns | `pharmacy.return.completed` | credit note / reversal | returns never credited (over-billing), returns credited twice |
| 5 | OT | OT record: procedure performed, start/end time, staff (IP-006) | procedure charge, OT time slab, anaesthesia, recovery | second procedure in the same sitting, extended OT time, conversion (lap → open), anaesthesia type upgrade |
| 6 | OT consumables & implants | scrub nurse count sheet (IP-006), consignment usage (NC-007), implant log (TR-003, UDI) | consumable + implant charge at the right tariff | **implants used but not billed** (the single largest rupee leak in ortho/trauma), sutures, disposables, cement, external fixators |
| 7 | Room & bed | occupancy timeline (IP-001) | room rent per class per day/hour with proration, nursing charge, RMO charge | transfer-day double/zero charge, late checkout, ICU→ward same-day, attendant bed |
| 8 | Oxygen / ventilator / devices | device order + hours (IP-009/TR-006; EN-042 IoT where available) | O₂ per hour/cylinder, ventilator per day, monitor, syringe pump, BiPAP, HFNC | ventilator hours under-recorded, oxygen never charged, devices left on the patient after weaning |
| 9 | Doctor visits | round/visit note signed (IP-003/IP-010), consultation (OP-002) | visit fee per doctor per day, cross-consultation | cross-specialty consults, second visits, night calls, procedure-in-ward by consultant |
| 10 | Nursing procedures | nursing chart (IP-003): dressing, catheterisation, NG tube, ryles, nebulisation, physio | procedure charge | routinely done, rarely billed |
| 11 | Blood bank | component issued & transfused (IP-007) | processing/cross-match/component charge | components issued and not billed, wastage misattributed |
| 12 | Dialysis / chemo / physio / other therapy | session completed (OP-012/IP-022, OP-031/IP-023, OP-015) | session charge, consumables | extra sessions, dialyser reuse policy |
| 13 | Packages | package inclusions (OP-023/IP-008/RC-007) vs actual services | package price + excess items | items inside the package billed again (over-billing), excess items not billed (under-billing) |
| 14 | Diet / other | diet orders (OP-011/NC-033) | diet charge if chargeable | special feeds |

- Every rule states: evidence query, matching key (encounter + service + date window + quantity), tolerance (time window, quantity), severity, estimated value (from RC-003), and owner. Rules are data (`leak_rules`), effective-dated, versioned, and individually enable-able per branch, because every hospital's practice differs.

### 3.2 Unbilled / underbilled / overbilled detection
- **Unbilled**: evidence exists, no charge line. Value = expected tariff × quantity.
- **Underbilled**: charge exists but quantity or rate is lower than evidence (e.g. 3 X-ray views performed, 1 billed; ventilator 72 h, 48 h billed; implant billed at a lower category).
- **Overbilled / phantom**: charge exists with no execution evidence (order cancelled but billed, test billed but sample rejected, drug billed but returned, implant billed but not in the log) — equally important, both ethically and because payers audit exactly this.
- **Pricing defects**: `rate_pending`/`price_status=missing` lines (RC-003), lines priced from an expired plan, payer-unmapped services, discounts applied above the matrix, package items double-charged.
- **Process defects**: bill open > 24 h after discharge, receipt without a bill line, gateway payment unmatched, cancelled order with a paid item and no refund, credit note without an approver, refund without a reason code.

### 3.3 Pre-discharge missed-charge gate (`leakage.pre_discharge_gate`)
1. On `ip.discharge.initiated`, RC-006 runs a **focused reconciliation** for that admission and produces a **discharge charge-capture checklist**: unbilled items by department with values, unreturned consumables, unresolved held/rate-pending lines, package excess not posted, pharmacy returns pending credit, implant log vs implant billing.
2. The checklist appears in the IP-002 discharge clearance panel and on ward tablets. Items above a configurable value threshold (default ₹500 individually or ₹2,000 in aggregate) **block final bill finalisation** until each is either posted or dismissed with a reason by an authorised user; below-threshold items warn only. The gate has a hard override (Billing supervisor) that is audited and reported weekly, because discharge must never be held hostage to a ₹40 dispute.
3. Ward/OT/ICU staff resolve their own lines from a tablet in a single tap ("Done → post charge" / "Not done → dismiss"), which is why this catches money the back office never could.

### 3.4 Exception lifecycle
`detected → assigned → under_review → (charge_posted | dismissed_valid | waived | escalated) → closed`, with a reason mandatory on dismissal and waiver, an owner and an SLA (default: pre-discharge exceptions 4 h; post-discharge 48 h; pre-claim exceptions block RC-001). Each exception stores the estimated value, the actual recovered value when a charge is posted, and the resolution path — so the dashboard can report **recovered ₹**, not just "issues found".

### 3.5 Discount, waiver, refund and cancellation audit
- Continuous checks over OP-005/IP-005: discounts above the user's matrix limit or without an approver, unusual concentration by user/doctor/reason code, repeated round-figure discounts, discounts on already-discounted payer bills, self-approval attempts, waivers without a documented reason, refunds without an original payment or beyond the paid amount, refunds in cash against digital payments above the cap, credit notes issued after the GST filing period, cancelled invoices re-created for the same service, and same-patient repeat cancellations (a classic front-desk fraud pattern).
- Each finding is an exception routed to the Finance Manager/Auditor queue rather than the ward; patterns (not single events) drive the investigation view.

### 3.6 Implant & consignment reconciliation (`leakage.implant_recon`)
- Three-way match per implant: **used** (TR-003 implant log with UDI/serial, attached to the surgery) ↔ **billed** (bill line at the right tariff/payer rate) ↔ **vendor invoice/consignment consumption** (NC-007). Any leg missing is an exception; a used-and-unbilled implant is escalated immediately (high value, and unrecoverable after claim submission). Vendor-billed-but-not-used triggers a return/credit check with the vendor.

### 3.7 Sampling audit workflow (`leakage.sampling_audit`)
1. The auditor defines an audit: scope (period, department, payer, doctor, bill value band), sampling method enum(random/stratified/risk_based/census) with sample size and seed (reproducible), and a checklist of assertions (documentation supports every line; every documented service is billed; tariff correct for payer; discounts approved; package inclusions correct; GST treatment correct; refund/credit note valid).
2. The system draws the sample, generates worksheets (one per bill, with the clinical record links), auditors record findings per assertion (pass/fail/observation) with the rupee impact, and the run produces an audit report with an **error rate**, a **projected leakage** (sample error rate extrapolated to the population, with a confidence interval), findings by cause, and CAPA items pushed to NC-015. Repeat audits track whether the error rate improved.

### 3.8 Anomaly detection (`leakage.anomaly_ml`, Phase 11+ with AI-005)
- Statistical baselines per service and per department: charges per bed-day, consumables per procedure type, drugs per ICU day, imaging per LOS, doctor visits per admission. Encounters more than *n* standard deviations below the peer baseline are flagged as probable under-billing; above the baseline as probable over-billing or genuine complexity (the review distinguishes). This surfaces leakage that no explicit rule anticipated. Every AI flag is a *suggestion* requiring human confirmation, per the house rule.

### 3.9 Exceptions & guardrails
- RC-006 **never** posts a charge by itself. It proposes; a human with `billing.item.add` posts. Auto-posting billing lines from a reconciler is how hospitals end up billing patients for things that did not happen.
- Post-discharge, post-claim discoveries are recorded with a `recoverability` classification (recoverable from patient / recoverable via claim revision / unrecoverable) so the dashboard is honest about what was actually saved.
- Deceased, MLC, scheme (no-cash) and charity encounters follow special handling: exceptions are still recorded (for accuracy and analytics) but collection actions differ or are prohibited.
- Offline: ward tablets cache their unit's checklist and queue resolutions.

## 4. Data Model (schema `billing`, prefix `leak_`)
- **leak_rules** — id, hospital_id, branch_id?, code, name, domain enum(lab/radiology/pharmacy/consumable/ot/implant/room/device/doctor_visit/nursing/blood/therapy/package/pricing/process/discount/refund), rule_kind enum(unbilled/underbilled/overbilled/pricing/process/pattern), evidence_source, match_key jsonb, tolerance jsonb (time_window_hours, qty_tolerance, amount_tolerance), severity enum(critical/high/medium/low), value_basis enum(tariff/mrp/fixed/estimated), owner_role, blocks_discharge bool, blocks_claim bool, enabled bool, version, effective_from, effective_to, author, approval_id, notes. Seeded with the §3.1 rule set.
- **leak_runs** — id, hospital_id, run_type enum(realtime/hourly/nightly/pre_discharge/pre_claim/adhoc), scope jsonb, rule_set_version, started_at, finished_at, encounters_scanned, exceptions_created, estimated_value_total, status.
- **leak_exceptions** — id, hospital_id, branch_id, run_id, rule_id, encounter_id, patient_id, admission_id?, bill_id?, department_id, unit_id (ward/OT/ICU/lab), exception_type enum(unbilled/underbilled/overbilled/pricing/process/discount/refund/pattern), service_id?, evidence_ref jsonb (source module, record id, timestamp, quantity), expected_qty, billed_qty, expected_amount, billed_amount, variance_amount, severity, status enum(detected/assigned/under_review/charge_posted/dismissed_valid/waived/escalated/closed), assigned_to, assigned_role, sla_due_at, resolution_reason_code?, resolution_note, resolved_by, resolved_at, recovered_amount, recoverability enum(pre_discharge/post_discharge_patient/claim_revision/unrecoverable), posted_bill_item_id?, blocks_discharge bool, blocks_claim bool, audit cols. Indexes (hospital_id, status, sla_due_at), (encounter_id), (department_id, detected_at), (rule_id, detected_at). Partitioned by month.
- **leak_exception_comments** — exception_id, at, by, text, attachments (the ward's "we did it, here's the chart page" evidence).
- **leak_discharge_checklists** — admission_id, generated_at, items jsonb (exception ids with values), blocking_count, blocking_value, cleared_at, cleared_by, override_by?, override_reason?, final_bill_id.
- **leak_implant_recon** — id, hospital_id, surgery_id, implant_id (TR-003), udi, used bool, used_evidence_ref, billed bool, bill_item_id?, billed_amount, vendor_invoice_ref? (NC-007), vendor_amount, status enum(matched/used_not_billed/billed_not_used/vendor_mismatch/resolved), variance_amount, resolved_by, resolved_at.
- **leak_discount_findings** — id, hospital_id, finding_type enum(above_matrix/no_approver/self_approved/pattern_user/pattern_reason/round_figure/post_period_credit_note/refund_no_original/cash_refund_of_digital/repeat_cancellation), bill_id?, invoice_id?, payment_id?, user_id, doctor_id?, amount, detected_at, period_window, occurrences, status enum(open/investigating/explained/action_taken/closed), investigation_note, action_ref (HR/CAPA/legal), reviewed_by.
- **leak_audits** (sampling) — id, hospital_id, title, scope jsonb, method enum(random/stratified/risk_based/census), population_size, sample_size, seed, drawn_at, checklist_id, status enum(draft/sampling/fieldwork/review/final), error_rate numeric(6,3), projected_leakage numeric(14,2), confidence_pct, report_file_id, auditor_id, approved_by.
- **leak_audit_items** — audit_id, bill_id, encounter_id, assertion_results jsonb, findings jsonb, impact_amount, auditor_note, capa_id (NC-015).
- **leak_baselines** (anomaly) — service_or_metric, department_id, payer_type, period, mean, stddev, p10, p90, sample_n, computed_at.
- **leak_recovery_ledger** — exception_id/audit_id, recovered_amount, recovered_at, method enum(charge_posted/claim_revised/vendor_credit/patient_billed/refund_reversed), reference_id, verified_by (the ledger behind the "recovered ₹" headline; reconciled against OP-005/IP-005 postings).
- Read models: `analytics.mv_leak_summary` (department × type × value × recovered), `mv_leak_trend`, `mv_leak_top_rules`, `mv_leak_recovery_rate`, `mv_implant_recon_gap`. RLS on `hospital_id`; exception views contain PHI (patient, encounter) and are read-audited.

## 5. Business Rules & Validations
- **RC-006 never mutates a bill.** It creates exceptions and proposals; posting requires a human with `billing.item.add` and produces a normal, audited bill line with its own reason and source reference. (Non-negotiable: an automatic charge-posting reconciler is a patient-safety and consumer-protection hazard.)
- Every exception must be resolved with one of the terminal states and a reason code; "dismissed_valid" requires a free-text justification of at least the configured length; bulk-dismiss is limited (default 20 per action) and audited.
- Discharge blocking applies only to exceptions whose rule has `blocks_discharge = true` **and** whose value exceeds the threshold; the aggregate threshold is evaluated per admission. Override requires `leakage.gate.override` (Billing supervisor+) with a reason, and appears in a weekly override report.
- Claim blocking: RC-001 may not create a claim while any `blocks_claim` exception is open for that encounter (or the exception is explicitly waived by an authorised user).
- Over-billing exceptions have priority over under-billing in the queue ordering: charging for something not done is a compliance event, not a revenue opportunity.
- Estimated value uses RC-003 at the encounter's payer context; for scheme/package encounters, the "value" is the marginal effect on the package (often zero) — the rule engine must not create phantom recovery for items already inside a package price.
- Duplicate suppression: one open exception per (encounter, rule, service, evidence_ref); re-runs update rather than multiply.
- Discount/refund findings are **patterns**, not accusations: an individual finding is informational; escalation to investigation requires a threshold of occurrences or value, and any HR consequence is handled outside the system with due process.
- Sampling audits must record the seed and method so a regulator or auditor can reproduce the sample.
- Recovered amount may only be counted when a corresponding posted bill line, claim revision, vendor credit or refund reversal exists (`leak_recovery_ledger` reconciles to billing) — no self-reported recovery.
- PHI: exception lists show the minimum patient identifiers needed; opening an encounter's detail is a `READ_PHI` audit event for users outside the care/billing team.
- Retention: exceptions and audits 8 years (financial audit evidence).

## 6. API Surface (`/api/v1/leakage`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /exceptions?status=&type=&dept=&unit=&severity=&encounter=&minValue= | queue | leakage.exception.list | – | cursor |
| GET | /exceptions/{id} | detail with evidence links | leakage.exception.read | – | – |
| POST | /exceptions/{id}/assign | assign to user/role | leakage.exception.assign | Y | – |
| POST | /exceptions/{id}/post-charge | create the proposed bill line (via OP-005/IP-005) | billing.item.add + leakage.exception.resolve | Y | – |
| POST | /exceptions/{id}/dismiss | dismiss with reason | leakage.exception.resolve | Y | – |
| POST | /exceptions/{id}/waive | waive (value-slabbed, EN-038) | leakage.exception.waive | Y | – |
| POST | /exceptions/bulk-resolve | bulk dismiss (≤20) with reason | leakage.exception.resolve | Y | – |
| POST | /exceptions/{id}/comments | evidence/discussion | leakage.exception.read | Y | cursor |
| GET | /admissions/{id}/discharge-checklist | pre-discharge gate list | leakage.checklist.read | – | – |
| POST | /admissions/{id}/discharge-checklist/clear | clear/override the gate | leakage.gate.clear / leakage.gate.override | Y | – |
| GET | /encounters/{id}/claim-readiness | blocking exceptions for RC-001 | leakage.exception.read | – | – |
| POST | /runs | trigger a reconciliation run (scope) | leakage.run.execute | Y | – |
| GET | /runs?type=&from= | run history & yield | leakage.run.read | – | cursor |
| GET/POST/PATCH | /rules | rule administration | leakage.rule.configure | Y | cursor |
| POST | /rules/{id}/simulate | replay a rule over a past period (yield & false positives) | leakage.rule.configure | Y | – |
| GET | /implant-recon?status= ; POST /implant-recon/{id}/resolve | three-way implant match | leakage.implant.read/resolve | Y | cursor |
| GET | /discount-findings?type=&user=&period= ; POST /{id}/investigate | discount/refund audit | leakage.discount.read / .investigate | Y | cursor |
| POST | /audits ; GET /audits/{id} ; POST /audits/{id}/draw-sample ; POST /audits/{id}/finalise | sampling audit | leakage.audit.manage | Y | cursor |
| GET/POST | /audits/{id}/items | fieldwork findings | leakage.audit.manage | Y | cursor |
| GET | /dashboard?from=&to=&dept= | leakage & recovery dashboard | leakage.report.read | – | – |
| GET | /reports/recovery ; /reports/top-causes ; /reports/department-scorecard | analytics | leakage.report.read | – | – |
| GET | /export?type=exceptions\|audit&period= | export (audited) | leakage.report.export | – | – |

## 7. Domain Events (outbox)
- `leakage.exception.detected` {rule, encounter, type, value, department} → EN-037 alert to the owning unit, dashboards.
- `leakage.exception.assigned|resolved|dismissed|waived|escalated` {resolution, recovered_amount}.
- `leakage.charge.proposed` {encounter, service, qty, value} → billing UI proposal (never an auto-post).
- `leakage.discharge.blocked` {admission_id, blocking_count, blocking_value} → IP-002 clearance panel, ward notification.
- `leakage.discharge.override` {admission_id, by, reason, value} → weekly finance report.
- `leakage.claim.blocked` {encounter, exceptions[]} → RC-001.
- `leakage.implant.gap` {surgery_id, udi, gap_type, value} → OT in-charge, stores, finance (high severity).
- `leakage.discount.finding` {type, user, occurrences, value} → Finance/Auditor queue.
- `leakage.audit.finalised` {audit_id, error_rate, projected_leakage} → NC-015 CAPA, finance pack.
- `leakage.recovered` {exception_id, amount, method} → recovery ledger, dashboard, NC-009 (informational).
- `leakage.baseline.updated` (anomaly module).
- Consumes: `lab.result.validated`, `lab.order.cancelled`, `rad.study.completed`, `rx.dispensed`, `pharmacy.return.completed`, `inventory.issue.posted`, `ot.record.closed`, `implant.used` (TR-003), `blood.component.issued`, `ip.bed.occupancy.changed`, `ip.round.recorded`, `nursing.procedure.recorded`, `device.hours.recorded` (EN-042/IP-009), `bill.finalized`, `billing.charge.posted`, `billing.discount.approved`, `billing.refund.processed`, `credit_note.issued`, `ip.discharge.initiated`, `claim.created`, `tariff.rate.missing` (RC-003).

## 8. Screens
- **Leakage Exception Queue** (desktop): tabs *Blocking discharge*, *Blocking claim*, *Over-billing (priority)*, *Unbilled*, *Underbilled*, *Pricing*, *Process*, *My unit*. Columns: patient/encounter, department/unit, rule, evidence summary, expected vs billed, variance ₹, severity, SLA. Group-by department with rolled-up values; bulk actions with reason. Shortcuts: `P` post charge, `D` dismiss, `W` waive, `A` assign, `E` evidence, `/` search, `Ctrl+K`. Real-time: new exceptions stream in; a live counter of "₹ at risk in-house right now" (open exceptions on not-yet-discharged patients) — the number that motivates ward staff.
- **Exception Detail** (desktop/tablet): left = evidence panel (the lab result, the OT note line, the implant sticker photo, the occupancy row) with a deep link into the source module; centre = expected vs billed comparison with the tariff used and the RC-003 explain chain; right = actions with reason picker and comment thread.
- **Ward / OT / ICU Missed-Charge card** (tablet, at the station): "3 items to confirm for Bed 12 — Dressing (₹350), Nebulisation ×2 (₹240), Oxygen 6 h (₹480)" with Done/Not-done single-tap resolution and an optional note; offline-capable, syncs on reconnect; unit-scoped so nurses see only their beds. This screen is the difference between a report nobody reads and money actually recovered.
- **Discharge Charge-Capture Checklist** (desktop, embedded in IP-002 clearance): blocking items in red with values, non-blocking in amber, "post all confirmed" bulk action, override control with reason (supervisor only), and the resulting change to the final bill total shown live.
- **Implant Reconciliation** (desktop): three-column match (used | billed | vendor invoice) per surgery with UDI, photos of the sticker, gap type and value; filters by surgeon, vendor, period; escalation button.
- **Discount & Refund Audit** (desktop, finance/auditor): pattern cards (user, reason code, frequency, value) with drill-down to transactions; trend charts; investigation notes and outcomes; separate, restricted access.
- **Sampling Audit workspace** (desktop): audit setup (scope, method, sample size, seed), drawn sample list, per-bill worksheet with assertions and rupee impact, running error rate, report generation with projected leakage and confidence interval, CAPA links.
- **Leakage Dashboard** (desktop/TV admin dark theme): detected ₹ vs **recovered ₹** (the headline pair) by month; recovery rate; leakage as % of gross revenue; Pareto of causes; department scorecard (detected, recovered, resolution SLA, dismissal rate); top rules by yield; false-positive rate per rule (a rule that cries wolf gets tuned or retired); "at risk in-house" live figure; override register.
- **Rule Admin** (desktop): rule list with yield and false-positive statistics, editor (evidence source, match key, tolerances, severity, blocking flags), simulate-over-past-period control showing how many exceptions and how much value the rule would have produced, enable/disable per branch with approval.
- All screens WCAG 2.2 AA; ward cards are large-tap-target and glove-friendly; i18n for ward-facing text.

## 9. Integrations
- Consumes events and read APIs from every charge-generating module (§7); writes nothing into them except through their own audited APIs (`POST /bills/{id}/items` on OP-005/IP-005).
- **RC-003** for expected value and for pricing-defect detection; **RC-001** for claim gating; **RC-004** where a leakage cause and a denial cause coincide (missing documentation); **RC-005** to keep "unbilled" and "uncollected" separate — conflating them is the classic reporting error; **NC-007/TR-003** for consignment and UDI; **NC-006/NC-008** for issues and consumption; **EN-042** for device hours where IoT exists (else manual entry from IP-009); **NC-015** for CAPA; **EN-038** for waivers and gate overrides; **EN-037** for unit alerts; **NC-009** for the financial impact view; **EN-001/NC-011** for dashboards.
- Fallbacks: if a source module's evidence feed is delayed, the reconciler marks the run partial and re-scans rather than raising false over-billing exceptions (a missing feed must never be read as "not done").

## 10. Reports & Analytics
- **Detected vs recovered** by month, department, unit, rule and recoverability class — with recovery rate; cumulative recovered ₹ since go-live (the ROI slide for the module).
- Leakage as a percentage of gross revenue, trended; benchmark against the internal target (typical hospital leakage is 2–5 % of revenue; the goal is to make it visible, then small).
- Top causes Pareto; department scorecard (detected value, recovery %, average resolution time, dismissal rate — a high dismissal rate with low evidence is itself a signal); unit-level leaderboards for wards (used positively).
- Rule performance: yield ₹ per rule, false-positive rate (dismissed_valid ÷ detected), SLA compliance; retired-rule log.
- Implant gap report (used-not-billed by surgeon/vendor/month) — usually the largest single line.
- Pre-discharge catch rate: value caught before discharge ÷ total detected (the operational quality metric — post-discharge catches are worth far less).
- Discount/refund audit: exceptions by user and reason, override register, credit notes after period close.
- Sampling audit history: error rates over time, projected leakage vs measured recovery, CAPA closure.
- Read models per §4; refreshed every 15 min for the queue counters and nightly for trends.

## 11. Notifications
- **Ward/OT/ICU in-charge**: "4 unconfirmed charges on your unit (₹2,340)" at shift change (not continuously — alert fatigue kills this module); high-value single items (implant, blood, ventilator) alert immediately.
- **Billing supervisor**: discharge blocked with value, gate override used, pre-claim blocking exceptions, unpriced-service backlog.
- **Insurance desk**: claim blocked by open exceptions.
- **Finance manager**: daily digest (detected/recovered/at-risk), weekly override and dismissal report, discount-pattern alerts, monthly leakage pack.
- **Stores/OT**: implant used-not-billed (immediate, high severity), vendor invoice mismatch.
- **Auditor/Quality**: sampling audit due, audit finalised, CAPA overdue.
- **MS/HOD**: documentation-defect trends for their department (monthly, educational framing).

## 12. Permissions (RBAC keys)
`leakage.exception.list|read` (Revenue integrity, Billing supervisor, unit in-charges scoped to their unit by ABAC, Insurance desk, Finance, Auditor) · `leakage.exception.assign` (Revenue integrity, supervisors) · `leakage.exception.resolve` (Revenue integrity, Billing, unit in-charge for their unit — posting a charge additionally requires `billing.item.add`) · `leakage.exception.waive` (Billing supervisor/Finance, value-slabbed via EN-038) · `leakage.checklist.read` (Billing, ward, discharge desk) · `leakage.gate.clear` (Billing executive) / `leakage.gate.override` (Billing supervisor+, audited & reported) · `leakage.run.execute|read` (Revenue integrity, IT) · `leakage.rule.configure` (Revenue integrity lead + Finance approval) · `leakage.implant.read|resolve` (OT in-charge, Stores, Revenue integrity, Finance) · `leakage.discount.read|investigate` (Finance Manager, Internal Auditor, Admin **only** — not visible to billing staff) · `leakage.audit.manage` (Internal Auditor, Quality) · `leakage.report.read` (Finance, Admin, MS, HOD for own department) · `leakage.report.export` (Finance, Admin, Auditor — audited).

## 13. Non-functional
- **Volumes** (2000 beds): ~60k bill items/day and ~40k execution events/day reconciled; 150–400 exceptions/day after tuning (an untuned first month may produce thousands — the rule simulator exists precisely to prevent launching in that state); 150 discharges/day each generating a checklist.
- **Performance**: pre-discharge focused reconciliation for one admission < 3 s (this runs while a nurse waits); hourly OP sweep over 5,000 visits < 2 min; nightly full sweep over the day's encounters < 15 min; exception queue p95 < 200 ms over 20,000 open rows; ward card load < 500 ms on a tablet over hospital Wi-Fi.
- **Correctness over recall**: the design bias is to under-report rather than to raise false over-billing claims; every rule ships with a measured false-positive rate and can be disabled per branch in one click.
- **Offline**: ward/OT tablet cards cache the unit's list and queue resolutions in IndexedDB; conflicts resolved by last-writer with both entries retained in the comment thread.
- **Printing**: discharge charge-capture checklist (for units that still work on paper), audit report, department scorecard, implant gap report.
- **Accessibility/i18n**: ward-facing text in the local language with plain wording ("Was this dressing done?"), large tap targets, WCAG 2.2 AA.
- **Security**: exception details are PHI — role- and unit-scoped, read-audited; discount/refund audit data is restricted from the staff being audited (a billing executive must never see the pattern report about themselves); exports watermarked and audited.

## 14. Acceptance Criteria
1. Given a validated lab result with no corresponding bill line, then an `unbilled` exception is created within 15 minutes with the expected tariff value, the ordering doctor and a link to the result.
2. Given 3 X-ray views were performed and 1 was billed, then an `underbilled` exception is created with expected qty 3, billed qty 1 and the variance value.
3. Given a lab order was cancelled before collection but a charge exists, then an `overbilled` exception is created, ranked above unbilled items in the queue, and the suggested action is reversal/refund.
4. Given an implant recorded in the TR-003 log with a UDI and no matching bill line, then a critical `used_not_billed` implant exception is raised, the OT in-charge and Finance are notified immediately, and it blocks claim creation.
5. Given a discharge is initiated with two blocking exceptions totalling ₹4,200, then the IP-002 clearance panel shows the checklist, final bill finalisation is blocked, and a supervisor override requires a reason and is written to the weekly override report.
6. Given a ward nurse taps "Done" on a nebulisation item, then a charge-proposal is created and posting still requires a user with `billing.item.add`; the exception then records the recovered amount equal to the posted line's net.
7. Given RC-006 proposes a charge, then no bill is ever mutated by RC-006 itself (verified by an integration test asserting no direct writes to `billing.*` tables from this module).
8. Given a bill line with `price_status = missing`, then a pricing exception exists, bill finalisation is blocked (OP-005 rule), and pricing the service in RC-003 auto-closes the exception.
9. Given a package encounter where an included item was billed separately, then an `overbilled` package exception is raised with the package inclusion reference.
10. Given a user applies a 12 % discount with a 5 % limit and it is approved by themselves, then a discount finding of type `self_approved` is created and routed to the Finance/Auditor queue, invisible to billing staff.
11. Given a pharmacy return is completed with no credit note within the tolerance window, then an exception is created and resolving it produces the credit note reference.
12. Given a rule is simulated over the previous month, then the system reports how many exceptions and what value it would have produced and the estimated false-positive rate, before the rule is enabled.
13. Given a sampling audit with method `stratified`, sample size 60 and a stored seed, then re-drawing with the same seed produces the identical sample, and the final report shows error rate, projected leakage and a confidence interval.
14. Given an exception is dismissed as valid, then a justification of at least the configured length is mandatory, bulk dismissal beyond 20 rows is blocked, and every dismissal is audited with the user.
15. Given recovered amounts are reported on the dashboard, then each rupee traces to a posted bill line, claim revision, vendor credit or refund reversal in `leak_recovery_ledger` (reconciliation test against OP-005/IP-005).
16. Given a source module's event feed is delayed by 2 hours, then the run is marked partial and no `overbilled` exceptions are raised from the missing evidence.
17. Given 20,000 open exceptions, then the queue loads p95 < 200 ms and the department roll-ups match a SQL recomputation.
18. Given a ward in-charge, when they open the exception queue, then only their unit's exceptions are visible (ABAC), and the discount/refund audit tab is not available to them at all.
19. Given a scheme (PMJAY) encounter where the item is inside the package price, then the exception's expected value is ₹0 and it is not counted as recoverable revenue.
20. Given an exception detail is opened by a user outside the care/billing team, then a `READ_PHI` audit entry is written.

## 15. Enhancements / Later phases
- From the VIMS sheet (row 139): charge-capture check, unbilled services, variance alert — all core above; extended here with over-billing detection, pre-discharge gating, implant three-way match, discount/refund audit, sampling methodology and a recovery ledger.
- Later: **ML anomaly detection** (AI-005) on charges-per-bed-day and consumables-per-procedure baselines; **NLP over clinical notes** (AI-003/AI-004) to detect documented-but-unbilled procedures ("wound debridement done at bedside") — the largest untapped source; automatic charge suggestion from OT dictation; IoT-driven oxygen and ventilator hour capture (EN-042) replacing manual entry; predictive "this admission is likely under-billed" scoring at day 2 rather than at discharge; peer benchmarking of leakage rates; cost-of-care overlay so leakage is expressed as margin lost, not just revenue lost; auto-generated CAPA with training assignment (NC-027) for repeat defects; vendor-side reconciliation portal for consignment (PE-00x/NC-021).
- (market) billing threshold control and automated billing notifications (MocDoc); staff attribution on every invoice and audit logs with old-vs-new diffs (SmartHospital); 3-way match discipline borrowed from procurement (NC-005) applied to implants — none of the surveyed products offers a genuine charge-capture reconciliation engine, which makes this a differentiator.

## 16. Open Questions for the Hospital
1. Which leaks do you already know about — implants, oxygen, ward consumables, doctor visits, OT time? Rank your top five so we enable those rules first.
2. Do ward nurses record procedures (dressings, nebulisation, catheterisation) in the system today, or only on paper? Without the evidence event, the rule cannot fire.
3. How are oxygen and ventilator hours recorded — manually by nursing, or from device data? Is any IoT integration available (EN-042)?
4. Are floor-stock/ward-stock consumables charged to patients, or absorbed as overhead? This decides whether an issue-without-charge is a leak or normal.
5. Should missed charges **block** discharge? At what individual and aggregate value thresholds, and who may override?
6. Should the same gate block claim submission (recommended — an unbilled implant found after submission is usually lost)?
7. Who owns revenue integrity today — billing, finance, internal audit, or nobody? Who will work the exception queue daily?
8. Do you want ward-level scorecards, and should they be shown to the wards (positive framing) or only to management?
9. Discount and refund audit: who may see it, and what patterns worry you most today?
10. Do you run internal billing audits already? What sample size and method, and what error rate do you find?
11. For consignment implants — do you reconcile used vs billed vs vendor invoice today, and how often does a mismatch arise?
12. What leakage target should the dashboard show (e.g. reduce from 3 % to 1 % of revenue in 12 months), and who reports it to the board?
