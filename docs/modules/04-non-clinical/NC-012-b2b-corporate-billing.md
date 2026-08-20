# NC-012 — B2B / Corporate Billing (Credit, Invoices, SOA, Ageing, TDS Certificates)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Non-Clinical / ERP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Module ID       | NC-012                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Phase           | 9 (corporate master & credit flag needed with OP-005 in Phase 5; consolidated invoicing/SOA/dunning in Phase 9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Depends on      | OP-005/IP-005 (credit bills, patient share, GST engine, e-invoice), RC-003 (corporate tariff plans/discounts), EN-002 (TPA linkage when corporate uses TPA), OP-014 (corporate health check-up packages), NC-009 (AR sub-ledger, receipts, TDS receivable, dunning journals), RC-005 (AR follow-up engine), PE-006 (Corporate client portal), NC-031 (contracts/MoUs), EN-016 (e-sign), EN-032/EN-009 (delivery), EN-038 (approvals), NC-011, EN-024                                                                                                                                                           |
| Feature flag    | `module.b2b_billing.enabled` (sub: `b2b.portal`, `b2b.dynamic_pricing`, `b2b.satisfaction_survey`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Primary roles   | Corporate / B2B Billing Executive (29), Finance Manager/Accountant (46)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Secondary roles | Billing Executive (27, credit bill creation), Front office (24, corporate employee identification), Marketing/CRM (55, corporate acquisition), Corporate HR client (61, portal), Hospital Admin (2), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                              |
| Regulatory      | GST (B2B tax invoice with recipient GSTIN, place of supply, e-invoice IRN above threshold, credit notes §34, exempt healthcare SAC 9993 vs taxable services — health check-ups for employers are generally exempt healthcare; occupational health/wellness may be taxable — configurable), Income-tax TDS §194J/194C deducted by corporates (Form 16A reconciliation, 26AS), MSMED (if hospital MSME registered — payment terms), Contract Act (MoUs), DPDP (employee health data shared with employer only per consent/contract; utilisation reports de-identified unless consented), IRDAI (when TPA-routed) |

## 1. Purpose

NC-012 manages **credit customers** — corporates, PSUs, government departments, schools, insurers' non-cashless arrangements, referral institutions and other B2B payers — with client master (GST, contract terms, credit limit, discount plan, TPA linkage, employee eligibility), real-time **credit-limit checks** at billing, periodic **consolidated invoices** (GST-compliant, e-invoice), statement of account, ageing & payment follow-up with escalation, receipt allocation, **TDS certificate** reconciliation, revenue reconciliation and profitability per corporate, plus a corporate portal (PE-006). Patient-level bills remain in OP-005/IP-005; NC-012 aggregates them per payer.

## 2. Users & Jobs-to-be-done

- **B2B billing executive** (desktop): maintain corporate master & eligibility lists, monitor credit usage, run periodic invoice cycles, send invoices/SOA, follow up payments, allocate receipts, record TDS certificates, resolve disputes/credit notes.
- **Billing/front office**: identify corporate employee (ID/employee code/eligibility upload), bill under corporate credit with patient co-pay per plan; see limit status.
- **Finance**: AR sub-ledger, TDS receivable matching, write-offs, contract renewals; revenue reports by corporate.
- **Corporate HR (portal)**: view invoices/SOA, employee utilisation (de-identified or per consent), download TDS confirmations, raise queries, approve pre-authorised procedures (if contract).

## 3. Core Workflows

### 3.1 Corporate client master

1. **Executive** creates client: legal name, GSTIN(s)/state (place of supply), PAN, address, contacts (finance/HR), contract (NC-031: start/end, auto-renewal, notice), **credit limit** (per period & outstanding cap), **payment terms** (net 30/45/60), invoicing cycle enum(per_visit/weekly/fortnightly/monthly), tariff plan/discount % (RC-003 payer plan), covered services & exclusions (OPD/IP/health check/pharmacy caps, dependants coverage, annual limit per employee), co-pay %, pre-auth rules, TPA linkage (EN-002) if any, e-invoice applicability, TDS section expected (194J), documents (MoU, rate list, GST certificate), status → approval → Event `corporate.client.activated`.
2. **Employee eligibility**: upload roster (employee id, name, DOB, dependants, validity) or portal maintenance by corporate HR; ID card/QR; matching at registration (OP-001) via employee id/phone → patient record tagged corporate membership with validity.

### 3.2 Credit billing & limit check

1. Patient visit under corporate → OP-005/IP-005 sets payer = corporate (membership validated: active, coverage, annual limit remaining) → items priced per corporate plan → **credit check**: outstanding + unbilled ≥ credit limit → block/warn per config (warn billing + notify corporate HR; override with approval) → patient share (co-pay/exclusions) collected at counter; corporate share posted as credit bill (status `credit_pending_invoice`) → Event `corporate.credit.used`.
2. Pre-authorisation (if required): request via portal/email → approval reference recorded on bill.

### 3.3 Periodic invoice generation

1. Cycle job (or manual "generate now"): gather credit bills for client in period (by branch/GSTIN) → **consolidated invoice** (`INV_B2B` gapless per branch/FY): annexure of employee-wise/visit-wise lines (service, date, amount, patient share deducted), GST computation by SAC/HSN (exempt vs taxable lines), place of supply/IGST logic, e-invoice IRN (OP-005 engine) if applicable, e-sign → PDF + annexure Excel → send (email/portal/WhatsApp) → AR entry (NC-009) → Event `corporate.invoice.issued`. Bulk invoice run across clients with review screen (VIMS: bulk invoice).
2. Disputes: line queries from corporate → hold line → credit note (linked to invoice) or re-invoice; partial acceptance.

### 3.4 Statement of account & payment follow-up

1. SOA per client: opening + invoices − receipts − credit notes − TDS = outstanding; ageing 0-30/31-60/61-90/90+ (from due date) → auto-reminders at thresholds (T+0 due, +15, +30 with escalation matrix: executive → finance manager → admin call; contact roles at client) via EN-032/EN-009 templates; promise-to-pay logging; disputes tracked; credit block when 90+ overdue beyond tolerance (config) → OP-005 refuses new credit bills (cash only) with override → Event `corporate.overdue.escalated|credit.blocked`.
2. Receipts: NEFT/cheque/UPI recorded (NC-009 AR receipt) → allocate to invoices (auto by invoice ref in remittance advice; manual otherwise); short payment → reason (TDS/dispute/discount) → **TDS**: expected TDS per invoice (rate) vs certificate (Form 16A) uploaded/portal → reconcile with 26AS quarterly → TDS receivable cleared (NC-009) → Event `corporate.tds.reconciled`.

### 3.5 Revenue reconciliation & analytics

- Corporate collections vs outstanding, department-wise corporate revenue, employee utilisation per corporate (visits, spend, top services), profitability per client (revenue − discounts − cost proxies from NC-008/NC-009), contract renewal pipeline (60/30-day alerts), volume-based dynamic pricing suggestions (`b2b.dynamic_pricing`, slabs in contract auto-applied), corporate satisfaction survey (`b2b.satisfaction_survey`, EN-030 to HR contacts).

## 4. Data Model (schema `billing`, prefix `b2b_`)

- **b2b_clients**: id, hospital_id, legal_name, trade_name, pan, gstins jsonb [{gstin, state, address, branch_id?}], contacts jsonb, contract_id (NC-031), contract_start, contract_end, auto_renew, credit_limit, credit_period_limit?, outstanding_cache, unbilled_cache, payment_terms_days, invoicing_cycle enum, tariff_plan_id (RC-003), discount_pct, coverage jsonb {services, exclusions, dependants, annual_limit_per_employee, copay_pct, preauth_required_for}, tpa_id?, einvoice_applicable bool, tds_section, tds_rate_expected, status enum(draft/active/suspended/blocked/expired), block_reason, documents uuid[], version. UNIQUE (hospital_id, pan?), INDEX (hospital_id, status).
- **b2b_memberships**: id, client_id, employee_code, name, dob, relationship enum(self/spouse/child/parent), patient_id? (linked at first visit), valid_from, valid_to, annual_limit_used, status. UNIQUE (client_id, employee_code, relationship, name).
- **b2b_credit_bills** (read model of OP-005/IP-005 bills with payer=corporate): bill_id, client_id, membership_id, branch_id, visit/admission ref, service_date, department_id, gross, discount, patient_share, corporate_share, gst jsonb, status enum(credit_pending_invoice/invoiced/disputed/credited/written_off), invoice_id?, preauth_ref?.
- **b2b_invoices**: id, hospital_id, branch_id, client_id, invoice_no, invoice_date, period_from, period_to, gstin_recipient, place_of_supply, doc_type enum(tax_invoice/bill_of_supply), taxable_value, exempt_value, cgst, sgst, igst, total, tds_expected, due_date, irn?, einvoice_status, esign_id, pdf_file_id, annexure_file_id, status enum(draft/issued/sent/partially_paid/paid/disputed/cancelled), sent_at, ar_invoice_id (NC-009), lines_count. UNIQUE (hospital_id, invoice_no).
- **b2b_invoice_lines**: invoice_id, credit_bill_id, employee_code, patient_name (masked per contract), service_summary, amount, gst jsonb, status enum(billed/disputed/credited).
- **b2b_credit_notes**: id, invoice_id, cn_no, reason, lines, amount, gst, issued_at, ar_ref.
- **b2b_receipts** (mirror of NC-009 AR receipts): receipt_id, client_id, amount, mode, utr, date, allocations jsonb [{invoice_id, amount, tds_amount, short_reason}].
- **b2b_tds_certificates**: id, client_id, fy, quarter, certificate_no, amount, file_id, invoices_covered jsonb, matched_26as bool, status.
- **b2b_followups**: client_id, invoice_id?, level, channel, sent_at, response, promise_date, promised_amount, next_action_at, owner_user_id.
- **b2b_disputes**: invoice_line_id, raised_by, reason, status, resolution enum(credit_note/reinvoice/rejected), resolved_by.
- **b2b_preauths**: client_id, membership_id, service, estimate, requested_at, approved_by (portal user), reference, valid_till, status.
- **b2b_pricing_slabs** (dynamic pricing): client_id, metric enum(monthly_volume/annual_spend), from, to, discount_pct, effective.
- RLS; invoices immutable after issue; credit notes for corrections; AR balances authoritative in NC-009.

## 5. Business Rules & Validations

- Credit bills only for active clients & valid memberships within coverage; credit limit check at bill time (outstanding + unbilled + current); block/warn per client config; override requires `billing.credit.override` and is audited; annual per-employee limits enforced.
- Invoice numbering gapless per branch/FY; GST per line: exempt healthcare (SAC 9993) as bill-of-supply lines, taxable lines (e.g. wellness/occupational programmes if configured, pharmacy HSN) with GST; place of supply from client's GSTIN state (IGST if inter-state); e-invoice IRN mandatory when applicable before send; invoice period cannot overlap previous invoices for the same client/branch; credit bills belong to exactly one invoice.
- Corrections only via credit notes linked to invoice (GST §34) or line-level dispute hold before issue.
- Receipt allocation ≤ invoice balance; TDS short-payment recorded as TDS receivable only up to expected rate (excess = dispute); certificate reconciliation required before writing off TDS receivable; 26AS match quarterly.
- Dunning schedule per client with escalation; auto credit block at configured overdue days/amount; unblock by finance manager.
- Portal shows employee-level detail only if contract & DPDP consent permit; otherwise aggregated; patient clinical details never shared.
- Contract expiry → new credit bills blocked after grace (config); renewal reminders 60/30 days.
- Retention: 8 years.

## 6. API Surface (`/api/v1/b2b`)

| Method          | Path                                                                                                                   | Purpose               | Permission                                               | Idem      | Pag                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------- | --------- | ----------------------------------------- |
| GET/POST/PATCH  | /clients, /clients/{id} ; POST /clients/{id}/(activate                                                                 | suspend               | block                                                    | unblock)  | master                                    | billing.corporate.manage / .approve | Y       | cursor                   |
| POST            | /clients/{id}/memberships/import ; GET/POST/PATCH /memberships                                                         | eligibility           | billing.corporate.membership.manage                      | Y         | cursor                                    |
| GET             | /clients/{id}/credit-status ; POST /credit-check (bill preview)                                                        | limit check           | billing.corporate.credit.read                            | –         | –                                         |
| GET             | /credit-bills?client=&status=&period=                                                                                  | pending credit bills  | billing.corporate.read                                   | –         | cursor                                    |
| POST            | /invoices/generate (client/period or bulk) ; POST /invoices/{id}/(issue                                                | send                  | cancel) ; GET /invoices                                  | invoicing | billing.corporate.invoice.create / .issue | Y                                   | cursor  |
| POST            | /invoices/{id}/credit-notes ; POST /disputes ; POST /disputes/{id}/resolve                                             | corrections           | billing.corporate.creditnote / billing.corporate.dispute | Y         | –                                         |
| GET             | /clients/{id}/soa?from=&to= ; GET /ageing?client=                                                                      | SOA/ageing            | billing.corporate.read                                   | –         | –                                         |
| POST            | /receipts ; POST /receipts/{id}/allocate                                                                               | receipts (via NC-009) | finance.ar.receipt                                       | Y         | –                                         |
| POST            | /tds-certificates ; POST /tds-certificates/{id}/reconcile                                                              | TDS                   | billing.corporate.tds.manage                             | Y         | cursor                                    |
| POST            | /followups ; POST /dunning/run                                                                                         | follow-up             | billing.corporate.followup                               | Y         | cursor                                    |
| GET/POST        | /preauths ; POST /preauths/{id}/decide (portal)                                                                        | pre-auth              | billing.corporate.preauth / corporate.portal.preauth     | Y         | cursor                                    |
| GET             | /reports/(revenue-by-client                                                                                            | utilisation           | profitability                                            | ageing    | tds-recon                                 | renewals)                           | reports | billing.corporate.report | –   | –   |
| Portal (PE-006) | GET /portal/invoices, /portal/soa, /portal/utilisation, /portal/memberships ; POST /portal/queries, /portal/tds-upload |                       | corporate.portal.*                                       | Y         | cursor                                    |

## 7. Domain Events (outbox)

- `corporate.client.activated|suspended|blocked|expiring` → OP-005/IP-005 (payer availability), RC-003, EN-037, NC-031.
- `corporate.credit.used|limit.warning|limit.exceeded` {client, bill, outstanding} → billing desk, corporate HR (portal/email).
- `corporate.invoice.issued|sent|cancelled` {invoice_id, client, total, gst} → NC-009 AR, PE-006, EN-032, NC-011.
- `corporate.creditnote.issued`, `corporate.dispute.raised|resolved` → NC-009.
- `corporate.receipt.allocated`, `corporate.tds.reconciled` → NC-009, RC-005.
- `corporate.overdue.escalated`, `corporate.credit.blocked|unblocked` → OP-005 (credit gate), finance, admin.
- Consumes: `bill.finalized` (payer=corporate), `credit_note.issued` (OP-005), `finance.receipt.applied`, `finance.tds.receivable.matched` (NC-009), `contract.expiring|renewed` (NC-031), `patient.registered` (membership link), `feedback.received` (EN-030 survey).

## 8. Screens (UI)

- **Corporate desk** — desktop: clients grid (outstanding, unbilled, limit %, overdue, contract end), alerts; `N` new client.
- **Client 360°** — desktop: tabs profile/contract/coverage/memberships/credit bills/invoices/SOA/receipts/TDS/follow-ups/disputes/utilisation.
- **Invoice run** — desktop: select cycle/clients → preview lines & GST → issue → send; bulk mode with progress; annexure preview.
- **Credit check widget** (embedded in OP-005/IP-005 payer selection): membership validity, limit bar, co-pay, pre-auth requirement.
- **Ageing & follow-up board** — desktop: buckets, promises, escalation, one-click reminder; phone view for finance manager.
- **TDS reconciliation** — desktop: expected vs certificates vs 26AS.
- **Portal (PE-006)** — web: invoices/SOA download, utilisation charts, membership upload, queries, pre-auth approvals.

## 9. Integrations

- OP-005/IP-005 billing & GST/e-invoice engine, RC-003 plans, EN-002 TPA, NC-009 AR/receipts/TDS, RC-005 follow-up engine (shared dunning), NC-031 contracts, PE-006 portal, EN-016 e-sign, EN-032/EN-009 delivery, EN-030 surveys, EN-036 membership imports.

## 10. Reports & Analytics

- Revenue by corporate (department/service/branch), utilisation per corporate/employee (visits, spend, top services; de-identified), outstanding & ageing, DSO per client, collections vs outstanding, TDS reconciliation status, disputes/credit notes, contract renewals pipeline, profitability per client, credit-limit utilisation, corporate satisfaction (EN-030). Read models: `analytics.b2b_revenue_monthly`, `analytics.b2b_ageing`.

## 11. Notifications

- Corporate HR/finance contacts: invoice issued (email with PDF/annexure), SOA monthly, reminders at due/+15/+30, credit-limit warnings (80 %/100 %), pre-auth requests, contract renewal notices; hospital: overdue escalations, disputes, TDS certificate pending, renewals.

## 12. Permissions (RBAC keys)

`billing.corporate.manage/approve/read`, `billing.corporate.membership.manage`, `billing.corporate.credit.read`, `billing.credit.override`, `billing.corporate.invoice.create/issue`, `billing.corporate.creditnote`, `billing.corporate.dispute`, `billing.corporate.tds.manage`, `billing.corporate.followup`, `billing.corporate.preauth`, `billing.corporate.report`, `billing.corporate.export`; portal: `corporate.portal.read/query/preauth/membership`. SoD: invoice issuer ≠ credit-note approver above threshold.

## 13. Non-functional

- Volumes: 300–800 corporate clients, 50k memberships, 1,500 credit bills/day, monthly invoice run 800 invoices with 40k lines < 10 min; credit check p95 < 100 ms (cached outstanding); SOA generation < 2 s.
- Printing: invoices/annexures PDF, SOA; Excel annexure; e-invoice QR.
- Security: portal scoped per client; PHI minimisation; audit exports; RLS.

## 14. Acceptance Criteria

1. Given an active client with credit limit ₹5,00,000 and outstanding+unbilled ₹4,90,000, when a ₹15,000 credit bill is attempted, then billing shows limit exceeded and blocks (block mode) or warns and notifies corporate HR (warn mode); override requires permission and is audited.
2. Given 120 credit bills in March for a client with GSTIN in another state, then the monthly invoice consolidates them, applies IGST on taxable lines, exempt lines as bill-of-supply, generates IRN when applicable, and posts AR to NC-009.
3. Given a corporate disputes 3 lines after issue, then a credit note linked to the invoice is issued and SOA reflects it; the invoice itself is unchanged.
4. Given a receipt of ₹9,00,000 against invoice ₹10,00,000 with TDS 10 %, then allocation records ₹1,00,000 TDS receivable; certificate upload matched to 26AS clears it.
5. Given an invoice 45 days overdue with net-30 terms, then reminders have been sent at due and +15 and the escalation reaches finance manager; at 90+ days credit is auto-blocked and OP-005 refuses new credit bills.
6. Given a membership expired yesterday, then registration under corporate credit is refused with reason.
7. Given portal user of Client A, when requesting Client B's SOA, then 403.
8. Given contract end in 60 days, then renewal alert reaches executive and client contact; after expiry + grace, credit bills are blocked.

## 15. Enhancements / Later phases

- From VIMS sheet: corporate employee health dashboard (PE-006, de-identified aggregates; Phase 10), contract auto-renewal reminders (Phase 9 core), employee utilisation per corporate (Phase 9 reports), volume-based dynamic pricing (`b2b.dynamic_pricing`, Phase 11), corporate satisfaction survey (`b2b.satisfaction_survey`, EN-030 Phase 10).
- (market) Corporate & insurance combined dashboards, employer wellness programmes (OP-014/PE-005), API for corporate HRMS eligibility sync, self-service pre-auth, auto-dunning via WhatsApp, credit insurance flags.

## 16. Open Questions for the Hospital

1. Current corporate clients list, contract terms, discount plans, and invoicing cycles?
2. Credit limit policy (block vs warn) and who can override?
3. Employee eligibility source (rosters, ID cards, portal) and dependants coverage rules?
4. Are any corporate services taxable (wellness/occupational health) or all exempt healthcare?
5. TDS handling practice and 26AS reconciliation ownership?
6. Portal for corporate HR desired at go-live; level of employee detail permitted by contracts/consent?
7. Dunning schedule and escalation contacts?
