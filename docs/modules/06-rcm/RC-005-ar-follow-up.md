# RC-005 — AR Follow-Up (Payer & Patient Aging, Priority Worklists, Follow-Up Logs, Promise-to-Pay, Payment Plans/EMI, Dunning Ladder, Bad Debt & Write-off, Collection Agency, Cash-Flow Forecast)

| Field | Value |
|---|---|
| Domain | Revenue Cycle Management |
| Module ID | RC-005 |
| Phase | 9 (patient AR & dunning can ship with Phase 5 billing; full payer AR, forecasting and agency handoff in Phase 9) |
| Priority | P1 |
| Complexity | Medium-High |
| Depends on | **NC-009 (Accounts & Finance — owns the AR sub-ledger, receipts, journals, bad-debt provision and write-off postings; RC-005 owns the *operational* follow-up layer on top of it)**, RC-001 (claims — payer receivables, expected settlement dates, claim status), RC-004 (denied/short-paid balances), EN-002 (payer master, credit days, settlement matching, disputes), NC-012 (corporate invoices & SOA — RC-005 provides the follow-up engine for corporate AR too), OP-005/IP-005 (patient balances, credit notes, advances, refunds), NC-001 (cash counter collections against follow-up), EN-010 (payment links, UPI, e-NACH/UPI AutoPay for instalments), RC-007 (scheme receivables — state/NHA settlement cycles are their own beast), RC-006 (leakage: unbilled work never becomes AR), EN-038 (write-off & payment-plan approvals), EN-009/EN-032 (SMS/WhatsApp/email dunning with DLT templates), EN-033 (IVR/call centre dialling & call logging), EN-037 (task escalation), PE-001/OP-020 (patient statement & pay online), PE-006 (corporate portal SOA), NC-023 (legal recovery), NC-011/EN-001 (analytics), EN-024 (audit) |
| Feature flag | `module.ar_followup.enabled` (sub: `ar.payment_plans`, `ar.emi_autopay`, `ar.collection_agency`, `ar.cashflow_forecast`, `ar.predictive_priority`, `ar.dunning_auto`) |
| Primary roles | AR Executive / Collections Officer (46 family), Insurance/TPA Desk (28 — payer AR), Corporate Billing (29 — corporate AR), Accountant (46) |
| Secondary roles | Finance Manager (46 — write-offs, provisions, targets), Billing Executive (27), Cashier (26 — collects against a follow-up), Call Centre Agent (25 — patient follow-up calls), Hospital Admin (2), Medical Superintendent (4 — where clinical goodwill decisions are involved), Patient (59 — statement, plan, pay), Corporate HR client (61 — PE-006), Auditor (58) |
| Regulatory | **RBI Fair Practices for recovery** (no harassment, calling hours 08:00–19:00, dignity of the debtor — applied by analogy to hospital collections and mandatory where a regulated lender/BNPL partner is involved), **RBI Digital Lending Guidelines 2022** (if EMI is financed by an NBFC/bank partner: KYC, key fact statement, cooling-off, no automatic debit without e-mandate), **NPCI e-NACH / UPI AutoPay** mandate rules (pre-debit notification 24 h), **TRAI TCCCPR 2018** (DLT-registered templates; payment reminders are *service* messages, not promotional; DND does not block transactional messages but headers must be registered), **DPDP Act 2023 & Rules 2025** (financial + health data; no disclosure of diagnosis to a collection agency; consent and purpose limitation; processors under contract), **Limitation Act 1963** (3 years for a debt claim — the write-off/legal decision clock), **Income-tax Act §36(1)(vii)** (bad debt write-off conditions) & **Ind AS 109 / ECL** (expected credit loss provisioning), **Consumer Protection Act 2019** (no coercive retention of patients or records for dues; medical records must be provided regardless of dues — NABH/MCI position), **NABH ROM/PRE** (transparent billing, no withholding of the body or of records for payment), **IRDAI** (payer settlement timelines feed the expected-date model) |

## 1. Purpose
RC-005 is the hospital's collections cockpit. It converts every open balance — payer claims awaiting settlement, denied and short-paid balances, corporate invoices, scheme receivables, and patient self-pay dues — into an **aged, prioritised worklist** with owners, next actions and outcomes. It logs every call, email and WhatsApp, records **promises to pay**, offers structured **payment plans and EMIs** with mandates, runs a configurable **dunning ladder**, escalates to legal or a collection agency, controls **bad-debt provisioning and write-off** with approvals, and forecasts cash inflow so finance knows what will actually arrive next month rather than what was billed.

## 2. Users & Jobs-to-be-done
- **AR executive / collections officer** (desktop + softphone/IVR, all day): work a prioritised worklist, call payers and patients, log outcomes, record promises, escalate stalled accounts, hit a monthly collection target. 60–120 contacts/day.
- **Insurance desk**: chase payers whose claims are past their expected settlement date, with the claim reference and the payer's escalation contact one click away.
- **Corporate billing executive**: chase corporate invoices with an SOA attached, handle disputed line items, manage credit-limit consequences.
- **Cashier / billing**: sees a patient's outstanding and any active payment plan at the counter; collects an instalment and the plan updates instantly.
- **Finance manager**: aging by payer/corporate/patient, DSO, collection efficiency, provision and write-off decisions, forecast vs actual, agency performance.
- **Call centre agent**: dial the day's list from a script, log dispositions, send a payment link during the call.
- **Patient**: sees a plain-language statement, can pay online in full or set up an instalment plan without visiting the hospital.
- **Auditor**: full trail of who chased what, what was promised, what was written off and who approved it.

## 3. Core Workflows

### 3.1 AR ingestion & bucket computation
1. Receivables enter RC-005 from: `claim.submitted` (payer AR opens with an expected settlement date = submitted + credit days), `claim.partially_approved` / `denial.recorded` (short/denied balance), `bill.finalized` with an unpaid patient balance (OP-005/IP-005), `corporate.invoice.issued` (NC-012), `scheme.claim.submitted` (RC-007), and manual entries (rare, e.g. legacy migration via EN-036).
2. A nightly job (plus event-driven updates) recomputes **aging buckets** per account: 0–30, 31–60, 61–90, 91–120, 121–180, 180+ days, measured from the **aging basis** (configurable per AR type: claim submission date for payers, invoice date for corporates, discharge/bill date for patients). Both *calendar* aging and *aging since last payer response* are kept — a claim that has been "under process" for 90 days is a different problem from one queried yesterday.
3. Each account carries: outstanding, original amount, payments received, adjustments (credit notes, TDS, disallowances), disputed amount, promised amount, next action date, owner, last contact date/outcome, escalation level, and a **priority score**.

### 3.2 Priority scoring & worklist generation
- Score (rules-based, weights configurable; `ar.predictive_priority` adds an AI-005 model later) combines: amount, days outstanding, recoverability (payer historical realisation %, patient payment history), imminence of a limitation or contractual deadline, whether a promise is broken, whether the account is disputed or under appeal (deprioritised until the appeal is decided), effort already spent, and account type. The result orders a daily worklist per owner, capped to a workable size (e.g. top 60), so executives work the money rather than the alphabet.
- Worklists are also generated by **campaign**: "all patients discharged 30–60 days ago with a balance under ₹25,000" for an SMS+link sweep; "top 20 payer claims over ₹5 lakh past due" for the desk lead.

### 3.3 Follow-up execution & logging
1. The executive opens an account → 360 view (bills, claim status, denial/appeal state, contact history, promises, plan) → chooses a channel: **call** (click-to-dial via EN-033; recording reference and disposition), **WhatsApp/SMS** (EN-009 DLT service templates with a payment link), **email** (EN-032 with the SOA/statement attached), **portal message** (PE-001/PE-006), or **visit/letter** for large corporate accounts.
2. Every interaction is logged: channel, contact person and designation, outcome enum(no_answer/wrong_number/promised/partial_paid/disputed/refused/needs_documents/escalated/callback_requested), notes, next action date, attachments, and — where relevant — the **payer/corporate reference** obtained. Calls made outside the permitted window (08:00–19:00) are blocked by policy for patient accounts.
3. **Promise-to-pay**: amount and date recorded; the system schedules a check on the promise date, marks it kept/broken automatically from payments, and a broken promise raises the priority score and advances the dunning ladder. Promise-keeping rate per patient/corporate becomes a reliability signal.

### 3.4 Dunning ladder (`ar.dunning_auto`)
- A configurable sequence per AR type and amount band, with day offsets from the aging basis, e.g. for patient self-pay: D+7 gentle SMS with a link → D+15 WhatsApp with the itemised statement → D+30 call by an executive → D+45 formal email/letter with the statement and a payment-plan offer → D+60 final notice referencing legal recourse → D+90 committee review (write-off / agency / legal). For payers: expected date +3 reminder email with the claim list → +10 call to the claims desk → +20 escalation to the payer's escalation contact from the empanelment → +30 grievance route (RC-004 rungs) → +45 finance-head-to-payer-head letter. For corporates: statement on invoice date → reminder at credit-term −3 → overdue notice → credit-limit hold → account manager visit → legal.
- Every automated step is a *service* message (TRAI), templated (DLT/WhatsApp-approved), suppressed for accounts that are disputed, under appeal, in an active payment plan in good standing, deceased-patient accounts (special handling with dignity rules), or where the patient has an open grievance (NC-032). Automation can be paused per account with a reason.

### 3.5 Payment plans, EMI and mandates (`ar.payment_plans`, `ar.emi_autopay`)
1. Eligibility rules (amount ≥ threshold, no prior broken plan, approval level by amount) → the executive builds a plan: down payment, number of instalments, dates, per-instalment amount, interest (usually zero; if financed by a partner, the partner's terms and RBI digital-lending disclosures apply), late-payment handling, and the consequence of default.
2. Approval per EN-038 slab → patient signs (e-sign EN-016 or counter signature) → mandate: **UPI AutoPay** or **e-NACH** via EN-010 (with the NPCI pre-debit notification 24 h before each debit), or manual instalments with reminders.
3. The plan generates scheduled receivables; each instalment collected through EN-010/NC-001 posts against the bill and updates the plan; a missed instalment triggers a grace period, then a reminder, then plan default → the balance returns to the normal ladder with a "broken plan" flag.
4. Staff and dependants may have payroll-deduction plans (NC-010) instead of gateway mandates.

### 3.6 Disputes, holds and adjustments
- An account can be placed on **hold** (dispute under investigation, appeal in progress, awaiting insurer, patient grievance, goodwill review, deceased-patient courtesy period) with a reason, an owner and an expiry — holds suppress dunning but never hide the balance from aging. Adjustments (credit notes, discounts approved post-facto, TDS, disallowances accepted) flow from OP-005/IP-005/NC-009 and reduce the outstanding with full traceability.

### 3.7 Bad-debt provisioning & write-off
1. **Provisioning**: a policy matrix maps aging buckets and AR types to provision percentages (e.g. patient self-pay 90+ days 25 %, 180+ 50 %, 365+ 100 %; payer claims under active appeal provisioned lower) → a monthly job computes the provision, posts it to NC-009 (Ind AS 109 expected-credit-loss style), and produces the schedule finance signs.
2. **Write-off**: requested with a reason category enum(uneconomic_to_pursue/time_barred/untraceable/deceased_no_estate/goodwill/legal_advice/payer_disallowance_accepted/scheme_shortfall), evidence of pursuit (the follow-up log is the evidence — a write-off with no contact history is flagged), amount, and approval per EN-038 slab (executive none → AR lead ≤ ₹10k → Finance Manager ≤ ₹1 lakh → Admin/Board above; configurable). Approved write-offs post to NC-009 with the reason so the P&L distinguishes *contractual* from *avoidable* losses. Later recovery of a written-off amount reverses the entry with a reference.
3. The **Limitation Act** 3-year clock is displayed on every account; accounts approaching it are surfaced for a decide-now list (pursue legally or write off).

### 3.8 Collection agency & legal (`ar.collection_agency`)
- Eligible accounts (patient self-pay, above threshold, past ladder exhaustion, not disputed, not deceased/hardship) are batched for handoff to an empanelled agency: a **DPDP-safe extract** (name, contact, amount, bill references, dates — **never** diagnosis, treatment details or any clinical data), a data-processing agreement on file, agreed commission, recall rules and a conduct clause (RBI fair-practices analogy: calling hours, no harassment, escalation of complaints back to the hospital). Agency updates (contacted/promised/paid/untraceable/returned) are imported or entered; commission is computed on realised amounts only and approved before payment. Any complaint about agency conduct is a recordable incident (NC-015/NC-032) and can trigger recall of the whole portfolio.
- Legal recovery (NC-023) for large corporate/institutional dues: notice, case reference, hearings, outcome.

### 3.9 Cash-flow forecast (`ar.cashflow_forecast`)
- Expected inflow by week/month = Σ (open receivable × probability of collection × expected timing), where probability and timing come from historical realisation by payer/corporate/patient segment and aging bucket, adjusted for known events (settlement advice received, promise dates, plan schedules, appeals likely to conclude). Presented as a 13-week rolling forecast with confidence bands, compared against actual, with variance explained by the biggest movers. This is the number the CFO actually wants and no surveyed competitor produces.

### 3.10 Exceptions
- **Deceased patient**: dunning stops immediately; a dignified, delayed process is followed (family contact only after a configurable courtesy period, never automated messages to the deceased's number); write-off path is explicitly available.
- **Hardship / charity**: routed to the relief-fund or charity workflow (OP-005 charity ledger head) rather than collections.
- Records and body release are **never** withheld for dues (hard rule in the system: no AR flag can block IP-002 discharge documentation, IP-017 body handover or NC-003 record issue; only elective future services can be gated by a credit-block flag).
- Patient contactability lost → skip-tracing limited to the contacts already on file (no third-party data purchase), then untraceable status.
- Payer insolvency/de-empanelment → portfolio review, bulk provisioning decision.

## 4. Data Model (schema `billing`/`finance`, prefix `ar_`)
- **ar_accounts** — id, hospital_id, branch_id, ar_type enum(payer_claim/scheme_claim/corporate_invoice/patient_self_pay/staff/other), party_type enum(payer/tpa/corporate/scheme/patient/employee), party_id, patient_id?, encounter_id?, claim_id?, invoice_id?, bill_ids uuid[], original_amount, adjustments_amount, received_amount, outstanding_amount, disputed_amount, promised_amount, aging_basis_date date, expected_settlement_date date?, bucket enum(b0_30/b31_60/b61_90/b91_120/b121_180/b180_plus), days_outstanding int, days_since_last_response int, priority_score numeric(6,2), owner_user_id, status enum(open/on_hold/in_plan/promised/escalated/with_agency/legal/written_off/settled/closed), hold_reason?, hold_until?, escalation_level smallint, limitation_expiry date, last_contact_at, last_outcome, next_action_at, provision_amount, currency, audit cols, version. Indexes (hospital_id, status, priority_score desc), (hospital_id, party_type, party_id, bucket), (owner_user_id, next_action_at), (claim_id), (patient_id).
- **ar_followups** — id, hospital_id, account_id, channel enum(call/sms/whatsapp/email/portal/letter/visit/agency), direction enum(outbound/inbound), contacted_person, designation, phone_masked, at, duration_seconds?, call_recording_ref? (EN-033), outcome enum(no_answer/wrong_number/promised/partial_paid/disputed/refused/needs_documents/escalated/callback/left_message), notes, attachments jsonb, template_id?, message_id (EN-009/EN-032), next_action_at, by_user_id, script_id?. Partitioned by month. Index (account_id, at desc).
- **ar_promises** — id, account_id, promised_amount, promised_date, mode?, made_by (contact name), recorded_by, status enum(open/kept/partially_kept/broken/cancelled), evaluated_at, actual_payment_ids uuid[], notes.
- **ar_payment_plans** — id, hospital_id, account_id, patient_id, plan_no, total_amount, down_payment, instalments smallint, frequency enum(weekly/fortnightly/monthly), start_date, interest_pct, late_fee_rule jsonb, mandate_type enum(none/upi_autopay/enach/payroll/pdc), mandate_ref, mandate_status, agreement_file_id, signed_at, approval_id (EN-038), status enum(draft/approved/active/completed/defaulted/cancelled), default_count smallint, created_by, audit cols.
- **ar_plan_instalments** — plan_id, seq, due_date, amount, status enum(scheduled/notified/paid/partially_paid/missed/waived), paid_amount, payment_id (OP-005), notified_at (NPCI pre-debit), debit_attempt_ref, failure_reason.
- **ar_dunning_policies** — id, hospital_id, ar_type, amount_band_min, amount_band_max, steps jsonb [{day_offset, channel, template_id, owner_role, escalate_to, requires_human}], suppression_rules jsonb, active, effective range, approved_by.
- **ar_dunning_runs** — account_id, policy_id, step_index, scheduled_for, executed_at, channel, message_id, status enum(scheduled/sent/skipped/failed/paused), skip_reason.
- **ar_holds** — account_id, reason enum(dispute/appeal/awaiting_payer/grievance/goodwill_review/deceased/hardship/legal/other), reason_note, placed_by, placed_at, until, released_by, released_at.
- **ar_write_offs** — id, account_id, amount, reason_category enum(uneconomic/time_barred/untraceable/deceased/goodwill/legal_advice/payer_disallowance/scheme_shortfall), evidence_summary, contact_attempts_count, requested_by, approval_id, approved_by, approved_at, journal_id (NC-009), reversed_by_recovery_id?, at.
- **ar_provisions** — period, ar_type, bucket, base_amount, provision_pct, provision_amount, policy_version, computed_at, journal_id, approved_by.
- **ar_agency_assignments** — id, agency_id (vendor NC-021), account_ids uuid[], batch_no, assigned_at, commission_pct, dpa_file_id, recall_by date, status enum(active/recalled/closed), extract_file_id (DPDP-safe), realised_amount, commission_amount, commission_approval_id.
- **ar_agency_updates** — assignment_id, account_id, at, status enum(contacted/promised/paid/untraceable/refused/returned), amount?, notes, imported_from_file_id?.
- **ar_forecast_runs** — id, hospital_id, run_at, horizon_weeks, method enum(rules/historical/model), buckets jsonb (week → expected_amount, low, high), assumptions jsonb, actual_backfill jsonb, mape numeric(5,2)?.
- **ar_targets** — period, owner_user_id?, team?, target_amount, achieved_amount (for collection-efficiency reporting).
- Read models: `analytics.mv_ar_aging` (party × bucket × amount), `mv_ar_dso`, `mv_ar_collection_efficiency`, `mv_ar_promise_reliability`, `mv_ar_forecast_vs_actual`. Partitioning on `ar_followups` and `ar_dunning_runs` by month. RLS on `hospital_id`; agency extracts are generated documents with their own access audit. Retention: follow-up logs 8 years (financial evidence).

## 5. Business Rules & Validations
- `outstanding = original − received − adjustments` at all times; RC-005 never holds a balance that disagrees with NC-009's AR sub-ledger — a nightly reconciliation asserts equality and raises a control exception on any mismatch (this is the module's single most important integrity check).
- Aging basis per AR type is configuration, not code; changing it re-buckets prospectively and is an audited configuration change.
- Dunning is **suppressed** automatically when: an account is on hold, an appeal is in progress (RC-004), a payment plan is in good standing, the patient is deceased, a grievance is open (NC-032), or the balance is below the configured de-minimis (chasing ₹120 costs more than ₹120).
- Patient contact only within 08:00–19:00 local time; no more than the configured maximum contacts per week (default 2 automated + 1 human); every message is a DLT-registered *service* template; opt-out of promotional channels never blocks statutory/service billing communication but tone and frequency respect the fair-practices standard.
- **Never** disclose clinical information in any collections communication or agency extract; the extract schema is whitelisted at the field level and validated before export (DPDP).
- **Hard rule**: no AR status may block discharge documentation, medical-record issue, or body handover. Credit blocks may only gate *future elective* services and require a documented policy.
- Promise dates in the past cannot be created; a promise supersedes the ladder until its date + grace, then the ladder resumes at an advanced step.
- Payment plans: minimum instalment and maximum tenure by policy; approval by amount slab; a patient with a previously defaulted plan needs a higher approval; mandates require the NPCI pre-debit notification 24 h before each debit; the agreement PDF is retained.
- Write-off requires (a) approval per slab, (b) requester ≠ approver, (c) contact evidence — a write-off request on an account with zero follow-up attempts is blocked unless the reason is `deceased`, `time_barred` or `payer_disallowance`. Recovery after write-off reverses the original journal with a reference.
- Provisioning runs monthly at period close, is idempotent per period, and is approved before posting.
- Agency handoff requires an active data-processing agreement, an executed commission agreement, an approved recall date, and the DPDP-safe extract; accounts under dispute, grievance, hardship or deceased status can never be assigned.
- Limitation: accounts within 90 days of the 3-year limitation expiry appear on a mandatory decide-now list for finance.
- Segregation of duties: the user who logs a follow-up may not approve a write-off on that account; provision poster ≠ approver.

## 6. API Surface (`/api/v1/ar`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /accounts?type=&party=&bucket=&owner=&status=&minAmount= | AR list | ar.account.list | – | cursor |
| GET | /accounts/{id} | 360 view (bills, claim, denial, contacts, promises, plan) | ar.account.read | – | – |
| GET | /worklist?owner=&limit= | prioritised daily worklist | ar.worklist.read | – | – |
| POST | /accounts/{id}/assign | assign owner | ar.account.assign | Y | – |
| POST | /accounts/{id}/followups | log a contact | ar.followup.create | Y | – |
| POST | /accounts/{id}/promises ; PATCH /promises/{id} | promise to pay | ar.promise.manage | Y | – |
| POST | /accounts/{id}/hold ; POST /accounts/{id}/release-hold | hold with reason | ar.hold.manage | Y | – |
| POST | /accounts/{id}/payment-link | send pay link (EN-010) | ar.payment_link.send | Y | – |
| POST | /plans ; GET/PATCH /plans/{id} ; POST /plans/{id}/approve | payment plan lifecycle | ar.plan.create/read/update / ar.plan.approve | Y | cursor |
| POST | /plans/{id}/mandate | create UPI AutoPay / e-NACH mandate | ar.plan.mandate | Y | – |
| POST | /plans/{id}/instalments/{seq}/collect | record instalment | ar.plan.collect | Y | – |
| GET/POST/PATCH | /dunning-policies | ladder configuration | ar.dunning.configure | Y | cursor |
| POST | /dunning/run?dryRun=true | execute/preview ladder batch | ar.dunning.run | Y | – |
| POST | /accounts/{id}/dunning/pause | pause automation with reason | ar.dunning.pause | Y | – |
| POST | /write-offs ; POST /write-offs/{id}/approve | write-off request & approval | ar.writeoff.request / ar.writeoff.approve | Y | cursor |
| POST | /provisions/run?period= | compute bad-debt provision | ar.provision.run | Y | – |
| POST | /provisions/{id}/post | post to NC-009 | ar.provision.post | Y | – |
| POST | /agency/assignments ; POST /assignments/{id}/recall ; POST /assignments/{id}/updates | agency handoff | ar.agency.manage | Y | cursor |
| GET | /agency/assignments/{id}/extract | DPDP-safe extract (audited) | ar.agency.export | – | – |
| GET | /reports/aging?by=payer\|corporate\|patient\|scheme&as_of= | aging | ar.report.read | – | cursor |
| GET | /reports/dso ; /reports/collection-efficiency ; /reports/promise-reliability | KPIs | ar.report.read | – | – |
| GET | /forecast?weeks=13 ; POST /forecast/run | cash-flow forecast | ar.forecast.read / ar.forecast.run | Y | – |
| GET | /patients/{id}/statement ; POST /patients/{id}/statement/send | patient SOA | ar.statement.read / .send | Y | – |
| GET | /parties/{id}/soa (payer/corporate) | statement of account | ar.statement.read | – | cursor |
| POST | /reconcile/ledger?period= | assert RC-005 vs NC-009 AR equality | ar.reconcile.run | Y | – |

## 7. Domain Events (outbox)
- `ar.account.opened|updated|closed` {ar_type, party, outstanding, bucket} → NC-009, EN-001, PE-001/PE-006 (patient/corporate visibility).
- `ar.followup.logged` {channel, outcome} → analytics, agent productivity.
- `ar.promise.made|kept|broken` {amount, date} → priority rescore, ladder advance, forecast input.
- `ar.dunning.step.sent|skipped` {step, channel, template} → EN-009/EN-032 delivery tracking, compliance log.
- `ar.plan.created|approved|activated|instalment_due|instalment_paid|instalment_missed|defaulted|completed` → EN-010 mandate/debit, NC-001 collection, patient notifications.
- `ar.hold.placed|released` {reason}.
- `ar.writeoff.requested|approved|rejected|reversed` {amount, reason_category, approval_id} → NC-009 journals, RC-001/RC-004 (claim closure), leakage report.
- `ar.provision.computed|posted` {period, amount} → NC-009, finance dashboard.
- `ar.agency.assigned|recalled|update_received` {batch, accounts, realised} → NC-021 vendor performance, NC-009 commission payable.
- `ar.forecast.published` {horizon, expected_by_week} → NC-022 (budget/treasury), EN-001.
- `ar.reconciliation.mismatch` {period, difference} → **control exception** to Finance Manager and IT.
- `ar.limitation.approaching` {account_id, days_left} → decide-now list.
- Consumes: `claim.submitted|approved|partially_approved|rejected|settled|closed` (RC-001), `denial.recorded|appeal.decided` (RC-004), `insurance.settlement.matched` (EN-002), `bill.finalized`, `payment.received`, `credit_note.issued` (OP-005/IP-005), `corporate.invoice.issued|paid` (NC-012), `scheme.claim.settled` (RC-007), `patient.deceased` (IP-017 → immediate dunning stop), `grievance.opened` (NC-032 → suppression).

## 8. Screens
- **AR Cockpit / Worklist** (desktop, agent's home): left = filters (type, party, bucket, owner, amount band, promise status, hold); centre = prioritised account list with score, amount, days, last outcome, next action, and inline quick actions (call, WhatsApp, link, promise, hold); right = the selected account's mini-360 so the agent never leaves the list. Shortcuts: `C` call, `W` WhatsApp, `L` send link, `P` promise, `H` hold, `N` log note, `↓/↑` next/previous account, `Ctrl+K` palette. Click-to-dial through EN-033 with screen-pop on inbound calls. Empty state: "Worklist clear — well done" with the day's collected total.
- **Account 360** (desktop): header (party, outstanding, bucket, limitation clock, priority score); tabs — *Bills & lines*, *Claim & denial status* (live from RC-001/RC-004 with the exact reason a payer has not paid), *Contacts* (timeline of every call/message with recordings and attachments), *Promises*, *Plan*, *Adjustments*, *Documents* (SOA, agreement, agency extract). Right rail: recommended next action from the ladder, one-click templates.
- **Payer AR board** (desktop, insurance desk): claims past expected settlement grouped by payer with the payer's escalation contact, total exposure, average delay vs contract credit days, and a bulk "send reminder with claim list" action. This is a different job from patient collections and gets its own screen.
- **Corporate AR** (desktop, NC-012 embedded): invoices, SOA generation and dispatch, disputed lines, credit-limit consequence, account-manager notes; the corporate can see the same SOA on PE-006.
- **Payment Plan builder** (desktop + phone for approval): amount, down payment, tenure slider with live instalment amount, mandate selection, agreement preview, approval status, patient e-sign, schedule table.
- **Dunning Policy editor** (desktop): ladder steps as a timeline (day offset, channel, template, owner, escalate-to), suppression rules, amount bands, dry-run preview ("this policy would message 412 accounts tomorrow — sample list").
- **Write-off & Provision workspace** (desktop): write-off queue with evidence summary and contact-attempt count, approval actions with slab display; provision run with the aging matrix, computed amounts, comparison to last period, and post-to-GL control.
- **Agency console** (desktop): batches, accounts, extract download (audited), agency updates import, realisation and commission computation, recall control, conduct-complaint log.
- **Cash-flow Forecast** (desktop/TV admin dark theme): 13-week bar chart of expected inflow with confidence bands, split by payer/corporate/patient/scheme; forecast vs actual accuracy (MAPE) trend; biggest movers list; assumptions panel.
- **Aging dashboard**: aging pyramid by party type, DSO trend, collection efficiency vs target by executive/team, promise reliability, write-off and provision trend.
- **Patient statement** (phone, PE-001/OP-020): plain-language "what you owe and why", itemised, insurance status explained ("your insurer paid ₹1,20,000; ₹18,400 is your co-pay and non-covered items"), pay now / set up instalments, download PDF, raise a query (NC-032).
- All screens: WCAG 2.2 AA; amounts right-aligned; the worklist is fully keyboard-operable for high-volume agents; multilingual patient-facing content.

## 9. Integrations
- **NC-009** (AR sub-ledger — the source of truth for balances; RC-005 posts nothing directly except through NC-009 APIs; nightly two-way reconciliation), **EN-010** (payment links, UPI AutoPay/e-NACH mandates and debits, refunds, settlement files), **NC-001** (counter collections), **EN-033** (click-to-dial, call recording reference, IVR reminder campaigns, screen-pop), **EN-009/EN-032** (DLT-registered SMS/WhatsApp templates, email with SOA attachment, delivery status), **RC-001/RC-004** (claim and denial status shown inline — an agent must never chase a payer for a claim that was rejected three weeks ago), **NC-012/PE-006** (corporate invoices and portal SOA), **RC-007** (scheme settlement cycles, which have their own rhythm and reason codes), **NC-021** (agency as a vendor with performance tracking), **NC-023** (legal cases), **NC-022** (treasury/budget consumes the forecast), **EN-038** (approvals), **EN-024** (audit).
- Fallbacks: gateway down → agent records a manual commitment and sends a UPI QR; IVR/dialler down → manual dialling with logging; agency file import failures produce a row-level error report.

## 10. Reports & Analytics
- **Aging**: by payer/TPA, corporate, scheme, patient; by branch; by bucket and amount; aged trial balance tying to NC-009.
- **DSO** overall and per payer (and "days since submission" for claims specifically, which is the actionable one); average days from discharge to payer payment, broken into our submission delay vs payer processing delay — this single split settles most internal arguments.
- **Collection efficiency**: collected ÷ collectible for the period, by executive, team, branch and AR type; against targets.
- **Follow-up productivity**: contacts per agent per day, connect rate, outcome mix, promise conversion rate, rupees recovered per contact.
- **Promise reliability** by party; **broken-promise** register.
- **Plans**: active plans, adherence rate, default rate, recovered through plans.
- **Bad debt**: provision trend and coverage ratio, write-offs by reason category (avoidable vs contractual), write-off recovery, agency realisation and commission cost per rupee recovered.
- **Forecast accuracy** (MAPE) and forecast vs actual by week.
- **Control**: RC-005 vs NC-009 reconciliation status, accounts with no contact in 30 days, de-minimis balances, accounts approaching limitation.
- Read models as listed in §4, refreshed every 15 minutes (aging) and nightly (forecast, provisions).

## 11. Notifications
- **Patient** (service category, DLT templates, 08:00–19:00): statement ready with balance, gentle reminder with a pay link, instalment due in 3 days and NPCI pre-debit notice 24 h before, instalment received, plan defaulted, final notice, receipt on payment.
- **Payer/corporate contacts**: reminder email with the claim/invoice list and SOA attached, escalation letter to the named escalation contact, promise-follow-up mail.
- **Executive**: today's worklist ready, promise due today, broken promise, account escalated to you, target progress at mid-month.
- **Finance**: daily collection summary vs target, weekly aging movement, write-off approvals pending, provision run ready, **reconciliation mismatch (critical)**, limitation decide-now list, agency batch due for recall.
- **Admin**: monthly DSO and forecast pack; agency conduct complaint (immediate).

## 12. Permissions (RBAC keys)
`ar.account.list|read|assign` (AR executive, Insurance desk, Corporate billing, Finance) · `ar.worklist.read` (own worklist; team view for leads) · `ar.followup.create` (AR executive, Call centre agent, Insurance desk) · `ar.promise.manage` · `ar.hold.manage` (AR lead) · `ar.payment_link.send` (AR executive, Cashier, Billing) · `ar.plan.create|read|update` (AR executive) / `ar.plan.approve` (AR lead/Finance Manager, slabbed) / `ar.plan.mandate|collect` · `ar.dunning.configure` (Finance Manager + Admin approval) / `ar.dunning.run` (system + AR lead) / `ar.dunning.pause` (AR lead) · `ar.writeoff.request` (AR executive) / `ar.writeoff.approve` (Finance Manager/Admin, slabbed, requester ≠ approver) · `ar.provision.run` (Accountant) / `ar.provision.post` (Finance Manager; poster ≠ approver) · `ar.agency.manage` (Finance Manager) / `ar.agency.export` (Finance Manager only — audited, DPDP-safe schema enforced) · `ar.statement.read|send` (AR, Billing, Corporate billing; patient self via PE-001) · `ar.report.read|export` (Finance, Admin, Auditor) · `ar.forecast.read|run` (Finance, Admin) · `ar.reconcile.run` (Accountant, IT service account).

## 13. Non-functional
- **Volumes** (2000 beds): open AR of ₹40–80 crore across ~15,000 open accounts (≈2,500 payer claims, ~150 corporates, ~12,000 patient balances); 100–200 automated dunning messages/day; 60–120 human contacts/day/executive team; nightly aging recompute over 15,000 accounts.
- **Performance**: worklist p95 < 200 ms for the top 60 of 15,000 accounts (priority score stored and indexed, recomputed by job, not per request); account 360 with 200 follow-up rows < 300 ms (partitioned table, cursor); aging dashboard < 500 ms from read models; nightly aging + scoring job over 15,000 accounts < 5 min; dunning batch of 500 messages dispatched < 2 min through EN-009 throttling.
- **Correctness**: the RC-005↔NC-009 reconciliation runs nightly and must be zero-difference; any mismatch is a P2 incident with an alert, because a collections system that disagrees with the ledger destroys trust immediately.
- **Offline**: none (back-office); the patient statement in PE-001 is PWA-cached read-only.
- **Printing**: statement of account (A4, itemised, with payment instructions and QR), payment-plan agreement, formal notice letters, aging reports, agency extract (PDF/XLSX, watermarked).
- **Accessibility/i18n**: patient statements and reminders in the patient's language; amounts in `en-IN` (lakh/crore) formatting; WCAG 2.2 AA; call scripts available in local languages for agents.
- **Security**: financial + health context = sensitive; no clinical detail in any outbound collections content or agency extract (schema-enforced); call recordings referenced, not stored, in this module; every export audited with user, time and row count; agency extract downloads require re-authentication.

## 14. Acceptance Criteria
1. Given a claim submitted with 30 credit days, then an AR account opens with an expected settlement date 30 days out, aging basis = submission date, and it appears in the payer AR board.
2. Given a patient bill finalised with a ₹18,400 balance, then a patient AR account opens, the patient sees a plain-language statement on the portal, and the D+7 dunning step is scheduled.
3. Given an account under active appeal (RC-004), when the dunning batch runs, then that account is skipped with `skip_reason = appeal_in_progress` and the skip is logged.
4. Given a patient is recorded as deceased, then all scheduled dunning for their accounts is cancelled immediately, no automated message is sent, and the account is routed to the courtesy/write-off path.
5. Given a promise to pay ₹10,000 on the 15th, when no payment arrives by the 15th + grace, then the promise is marked broken, the priority score increases, and the ladder advances one step.
6. Given a payment plan of ₹60,000 over 6 monthly instalments with UPI AutoPay, then the agreement is generated and signed, a mandate is created via EN-010, each debit is preceded by an NPCI pre-debit notification 24 h earlier, and a missed instalment moves the plan to grace then default.
7. Given a write-off request on an account with zero logged contact attempts and reason `uneconomic`, then the request is blocked with "contact evidence required".
8. Given an approved write-off of ₹45,000, then it posts to NC-009 with the reason category, the requester could not approve it, and the account status becomes `written_off`.
9. Given a written-off amount is later recovered, then the original journal is reversed with a reference and the recovery is posted; the account's history shows both.
10. Given the nightly reconciliation finds a ₹1,240 difference between RC-005 outstanding and the NC-009 AR sub-ledger, then `ar.reconciliation.mismatch` is emitted and the Finance Manager and IT are alerted with the account-level difference list.
11. Given an agency extract is generated, then it contains only name, contact, amount, bill reference and dates — a schema test asserts that no diagnosis, procedure or clinical field can be present — and the download is audited.
12. Given an account under dispute, deceased, hardship or with an open grievance, when an agency batch is created, then those accounts are excluded automatically.
13. Given a patient with an outstanding balance requests their medical records or a discharge summary, then the system never blocks issue on the basis of dues (verified by test on IP-002/NC-003 paths).
14. Given a collections call is attempted at 20:30, then the click-to-dial action is blocked for patient accounts with the permitted-hours message.
15. Given 13-week forecasting is run, then expected inflow is produced per week with confidence bands, and the following month's forecast-vs-actual MAPE is recorded and displayed.
16. Given an account reaches 2 years 9 months since the aging basis, then it appears on the limitation decide-now list with days remaining, and Finance is notified.
17. Given 15,000 open accounts, then the prioritised worklist returns the top 60 in p95 < 200 ms and the ordering matches a recomputation of the scoring rules.
18. Given a user without `ar.agency.export`, when downloading an extract, then 403 and an audit entry are recorded.

## 15. Enhancements / Later phases
- From the VIMS sheet (row 137): aging report, payer-wise outstanding, auto reminder, write-off — all core above; extended here with promises, plans, agency, provisioning and forecasting.
- Later: **AI-assisted prioritisation** (AI-005 — probability of collection and best next channel/time per account), payment-propensity segmentation, best-time-to-call model from historical connect data, **speech analytics** on collection calls for compliance and coaching, automated payer-portal status scraping where APIs are absent, ERA/remittance auto-posting, dynamic discount-for-immediate-settlement offers within an approved policy, patient financial counselling at admission (the cheapest collection is the one done before discharge — links to RC-008 estimates and IP-001 deposits), digital-lending partner integration for larger EMIs with full RBI disclosure flow, and a self-service hardship application on the portal routed to the charity committee.
- (market) credit-party billing with aging analysis and receipt generation (PCS Prodoc); supplier & patient credit settlement (MocDoc); advance/pay-due lifecycle tracking (SmartHospital); corporate SOA & payment follow-up (VIMS NC-012) — RC-005 unifies these into one follow-up engine rather than three disconnected screens.

## 16. Open Questions for the Hospital
1. Current AR position by type (payer, corporate, scheme, patient) and DSO — and which report finance trusts today.
2. Aging basis you use for payer claims: submission date, discharge date or invoice date? Same question for corporates and patients.
3. Credit days per payer/corporate (from the contracts) and how you currently know a claim is "overdue".
4. Who follows up today — insurance desk, accounts, or a dedicated collections team? How many people, and what is the daily contact volume?
5. Your dunning practice for patients: how soon after discharge, how many contacts, what tone, and any legal/ethical constraints your management insists on.
6. Do you offer payment plans or EMIs today? What tenure, what approval level, and do you use e-NACH/UPI AutoPay or post-dated cheques?
7. Bad-debt provisioning policy (percentages by bucket) and who signs it; write-off approval slabs and reason categories used in the P&L.
8. Do you use a collection agency? Which one, at what commission, and is a data-processing agreement in place? What data do you share today?
9. Do you ever withhold records, reports or discharge for dues? (We will hard-block this in the system; please confirm the policy.)
10. Hardship/charity route: who decides, what evidence, and which ledger head?
11. Do you want a 13-week cash-flow forecast, and who consumes it (CFO, treasury, board pack)?
12. Call recording and IVR: which system, and are collection calls recorded today with the required consent announcement?
