# OP-005 — OP Billing & Revenue (Master Bill, Multi-Payment, Receipts, GST, Discounts, Refunds, MIS)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-005 |
| Phase | 5 (skeleton "consultation fee + receipt" already needed in Phase 1 via NC-001) |
| Priority | P0 |
| Complexity | High |
| Depends on | RC-003 (tariff engine), NC-001 (cash counter/shifts), EN-010 (payment gateway/UPI/links), EN-002 (insurance/TPA credit), RC-007 (schemes), OP-023 (packages), OP-001 (patient/visit), OP-002/003/004/008/010/039 (charge sources), EN-038 (approval matrix), NC-009 (GL posting), NC-012 (B2B invoices), NC-034 (doctor payout), RC-006 (revenue leakage), RC-008 (estimates), EN-009 (SMS/WhatsApp), EN-032 (email), EN-005 (printers), EN-016 (e-sign, e-invoice signing), EN-024 (audit) |
| Feature flag | `module.op_billing.enabled` (sub: `billing.gst_einvoice`, `billing.wallet`, `billing.emi`, `billing.pay_after_consult`) |
| Primary roles | Cashier (26), Billing Executive OP (27), Insurance/TPA desk (28), Corporate billing (29), Pharmacy/Lab counters (bill creation), Branch Admin (config), Accountant (46) |
| Secondary roles | Receptionist (fee collection), Doctor (view own earnings), Hospital Admin (discount approvals), Auditor, Patient (digital receipts, portal payments), Corporate HR (PE-006) |
| Regulatory | CGST/SGST/IGST Acts & Rules (Rule 46 tax invoice contents, Rule 49 bill of supply for exempt services, Rule 48(4) e-invoice IRN for B2B above turnover threshold, Rule 54(2) consolidated invoice, HSN/SAC on invoices — SAC 9993 healthcare services exempt (Notification 12/2017 entry 74) except room > ₹5000/day (5 %) & cosmetic; HSN 30xx medicines 5/12/18 %; SAC 998xx/999xx for taxable services), GSTR-1/3B registers, TDS u/s 194J on doctor payouts (NC-034), Income-tax §269ST cash receipt cap ₹2 lakh/transaction, §40A(3), Clinical Establishments Act (rate display), NABH PRE/ROM (transparent billing, estimate), Consumer Protection (itemised bill), RBI PA/PG guidelines & UPI (EN-010), IT Act (digital receipts, QR), DPDP (billing data), Companies Act/IndAS revenue recognition (accounting) |

## 1. Purpose
OP-005 is the outpatient revenue engine: it consolidates every OP charge (consultation, pharmacy, lab, radiology, procedures, packages, consumables) into a single visit-level master bill and per-department invoices with correct GST/HSN/SAC treatment, collects money through cash/card/UPI/gateway/wallet/split/advance/credit, prints & delivers verifiable digital receipts, enforces discount and refund approval matrices, posts to GL, and produces revenue MIS with department/doctor/payer splits, doctor payout hooks and revenue-leakage checks. Financial numbering is gapless and every rupee is auditable.

## 2. Users & Jobs-to-be-done
- **Cashier / billing executive** (desktop + thermal printer + card POS + UPI QR): create/settle bills in < 60 s, apply discounts within limit, split payments, print/send receipts, handle refunds/cancellations, close shift (NC-001).
- **Departmental counters** (pharmacy/lab/radiology): create department invoices auto-populated from orders/dispenses; collect if allowed.
- **Insurance/TPA desk**: mark credit bills, attach pre-auth, patient co-pay collection, claim hand-off (EN-002/RC-001).
- **Corporate billing**: credit patients under corporate accounts, monthly consolidated B2B invoices with GSTIN (NC-012).
- **Doctor**: view own consultations/earnings (NC-034 read).
- **Branch admin/finance**: configure counters, series, GST profiles, discount matrix, payment modes, GL mapping, approve discounts/refunds; day-end.
- **Patient**: pay at counter/portal/link, receive receipt PDF, verify by QR, wallet balance.

## 3. Core Workflows

### 3.1 Charge capture (auto-posting)
1. Events from modules (`visit.checked_in` consult fee, `order.lab.created`, `order.rad.created`, `rx.dispensed`/`pharmacy.dispense.billed`, `procedure.completed`, `package.booked`, `er.charge.posted`) → **billing service** resolves price via RC-003 tariff (payer plan: self-pay/insurer/corporate/scheme; branch; doctor-specific consult fee; category (staff/senior) discounts; time-based (night/holiday) rates; package inclusion) → creates `bill_items` on the visit's **draft master bill** (one per visit, `bill_type=OP`) with `department`, `service`, `hsn_sac`, `gst_rate`, `taxable/exempt`, `source_ref` (order id) → Event `billing.charge.posted`.
2. Unpriced service (no tariff) → item posted with `price_status=missing`, alert to billing (RC-006 leakage list); cannot finalise until priced.
3. Cancellations upstream (`order.cancelled` before execution) → auto-reverse item if unpaid; if paid → refund/credit note workflow (3.6).
4. Manual add of items (billing executive) with reason; consumables from OP procedure rooms (OP-039) captured by nurse.

### 3.2 Master bill & departmental invoices
1. **Master bill view** per visit: all items grouped by department; status per item (unpaid/paid/credit/waived/cancelled); totals: gross, discounts, taxable, CGST/SGST/IGST, net, paid, balance; payer split (patient share vs insurer/corporate share with co-pay %, deductibles from EN-002 rules).
2. Invoicing model (config): (a) **single consolidated OP invoice** on finalisation, or (b) **department-wise invoices** (consult invoice at check-in, pharmacy invoice at dispense, lab invoice at order) all linked to master bill — default (b) because Indian OP flows pay per counter; master bill remains a visit-level ledger/summary. Each invoice gets gapless number from series (`BILL_OP`, `BILL_PH`, `BILL_LAB`, `BILL_RAD` per branch/FY; GST requires unique consecutive series per FY).
3. **Bill of supply vs tax invoice**: exempt healthcare services (SAC 9993) → "Bill of Supply"; taxable items (medicines HSN 30xx, cosmetic procedures, taxable consumables, room > ₹5000 in IP) → "Tax Invoice"; mixed → tax invoice with exempt lines marked; place of supply = branch state (B2C); patient GSTIN captured for B2B (corporates, employers, insurers where applicable) → IGST when inter-state.
4. **e-Invoice (IRN)**: if hospital aggregate turnover ≥ current threshold (₹5 crore) and invoice is B2B (recipient GSTIN) → generate IRN/QR via IRP (GSP/API in EN-017) before print; B2C exempt from IRN but dynamic UPI QR on B2C invoices mandatory for turnover > ₹500 crore (config flag). Failure → hold print with retry; never issue duplicate IRN (idempotent by invoice no).
5. Estimates/quotations (RC-008) convertible to bill; package (OP-023) items post at package price with inclusion tracking and variance flags.

### 3.3 Payment collection
1. Cashier opens bill/invoice → `F9` collect → choose modes: **cash** (denominations optional, §269ST cap check ₹2 lakh aggregate per patient per day → block/alert), **card POS** (integrated PineLabs/Razorpay POS: amount pushed, response captured with RRN/auth code; manual entry fallback with approval code), **UPI** (dynamic QR via EN-010 shown on counter display; webhook confirms → auto-mark paid; manual UTR fallback with verification job), **payment link** (SMS/WhatsApp; Razorpay/others), **net banking/wallet**, **cheque/DD** (realisation tracking), **patient wallet/prepaid** (deduct), **advance** (adjust deposit), **credit** (insurer/corporate/scheme up to limit with pre-auth ref; patient pays co-pay/non-payables), **staff credit** (payroll deduction, NC-010), **split** across any combination.
2. On full settlement → invoice `paid`, **receipt** generated (series `RECEIPT` gapless per branch/FY): hospital logo/GSTIN/address, patient, itemised charges, discounts, GST breakup (HSN/SAC-wise), payment modes with references, cashier, counter, QR (verify URL + UPI QR where applicable), signature block → print (thermal 80 mm/A4/A5) + WhatsApp + email + portal → Events `bill.finalized`, `payment.received`, `receipt.issued`.
3. Partial payment allowed (config) → balance outstanding on patient ledger; **advance/deposit** collection (`ADVANCE` receipt) adjustable across visits; unadjusted advance refundable.
4. Pay-after-consult policy: consult fee posted at check-in, collected after doctor completes (queue gate configurable).
5. Kiosk/portal/app payments (EN-034/PE-001) via EN-010 → same receipt pipeline.
6. Exceptions: gateway timeout → payment `pending_confirmation`, reconciliation job matches webhook/settlement file; duplicate webhook idempotent; POS declined → retry/other mode; printer down → reprint queue, digital receipt sent anyway.

### 3.4 Discounts & concessions
1. Types: **auto** (category: staff/dependant, senior citizen, scheme/corporate plan, camp, package), **manual line/bill discount** (% or amount) with reason code (mandatory) from list (financial hardship, doctor request, service issue, promo, VIP), **doctor-authorised waiver** (consult fee) with doctor's OTP/approval, **charity/relief fund** (separate ledger head), **round-off**.
2. Approval matrix (EN-038): cashier ≤ 5 %, billing supervisor ≤ 10 %, admin/MS > 10 % (or amount thresholds); doctor waiver of own fee allowed; requests routed with SLA (5 min) → approver acts on phone (push) → audit trail (who requested/approved, reason, before/after). Segregation: requester ≠ approver.
3. Discount never on GST-payable amount incorrectly: discount applied to taxable value before GST (Section 15(3)); discounts on medicines cannot breach cost floor (OP-003 rule) — pharmacy discount limits separate.
4. Discount analytics & leakage watch (RC-006): high-discount users, repeated reasons.

### 3.5 Refunds & cancellations
1. **Bill/invoice cancellation** (wrong patient/duplicate) before service delivery, same day, by supervisor with reason → invoice `cancelled` (number retained, printed "CANCELLED", GST: same-day cancellation allowed; after filing period → credit note); linked receipt refunded.
2. **Refund** (service not availed, appointment cancelled, excess payment, sample rejected & patient declines, advance return): initiate → reason → amount (≤ paid, ≤ item value) → approval matrix (cashier ≤ ₹500 same-day own-shift, supervisor ≤ ₹5000, finance above) → mode: original mode preferred (card/UPI reversal via EN-010, cash from counter float, cheque/NEFT for large/late), never cash refund of digital payment above ₹10k (config) → **credit note** (series `CN`, GST-linked to original invoice: Section 34) → refund receipt (`REFUND` series) → Events `billing.refund.approved`, `payment.refunded`, `credit_note.issued`.
3. Partial refunds & re-issue; refund status tracking for gateway (T+5 days); patient notification.

### 3.6 Credit, insurance & corporate (OP)
- Bill payer set to insurer/TPA/corporate/scheme with policy/employee ref, coverage rules (covered services list, caps, co-pay %) from EN-002/RC-007; pre-auth reference for OP procedures if payer requires; **patient share** computed line-wise; **credit invoice** to payer (B2B, GSTIN, e-invoice if applicable) generated per visit or consolidated monthly (NC-012) with supporting docs (Rx, reports); denials/short payments handled by RC-004/RC-005; TDS by payer recorded on settlement.
- Credit limit per corporate/patient; blocked patients (`credit_block` alert) → cash only.

### 3.7 Doctor payout hooks (NC-034)
- Each bill item carries `performing_doctor_id`, `referring_doctor_id`, `department_id`, `payer_type`, `net_after_discount`, `collected_amount`, `collection_date`; NC-034 computes shares (fixed/percentage/slab, on billed vs collected, discount-borne rules, TDS 194J) → payout sheets; OP-005 exposes `GET /billing/items?doctor=&period=` and emits `bill.finalized` with item-level payload; doctor's earnings widget (own only).

### 3.8 Day-end & accounting
- Shift/day close (NC-001): counter collections by mode vs system, denominations, variances, hand-over; **GL posting** (NC-009): revenue by department/service head, GST output liability by rate, receivables (credit), discounts, refunds, advances liability, wallet liability, cash/bank/clearing accounts (card/UPI settlement clearing with T+1 reconciliation from EN-010 settlement files); Tally/ERP export.
- GST registers: outward supplies (B2C small/large, B2B), HSN summary, credit/debit notes, exempt supplies → GSTR-1/3B extracts (NC-009); e-invoice register.

### 3.9 Revenue leakage hooks (RC-006)
- Nightly checks: services executed without bill item (lab results without charge, dispenses without invoice, procedures done unbilled), unpriced items, cancelled orders with paid items not refunded, bills open > 24 h, discounts above matrix, receipts without bill, gateway payments unmatched → exception worklist and alerts.

## 4. Data Model (schema `billing`)
- **bills** (master, per visit/encounter): id, hospital_id, branch_id, bill_no (`BILL_MASTER`, non-gapless), patient_id, visit_id/admission_id?, bill_type enum(op/ip/er/daycare/pharmacy_otc/lab_walkin/package/misc), status enum(draft/open/finalized/partially_paid/paid/cancelled/void), payer_type enum(self/insurance/corporate/scheme/staff/charity), payer_id, policy_ref, preauth_ref, currency, gross_amount, discount_amount, taxable_amount, cgst, sgst, igst, cess, round_off, net_amount, paid_amount, balance_amount, patient_share, payer_share, estimate_id, package_id, finalized_at, finalized_by, remarks, version.
- **invoices** (GST documents): id, hospital_id, branch_id, invoice_no (gapless per series/FY), series_key, bill_id, doc_type enum(tax_invoice/bill_of_supply/credit_note/debit_note/advance_receipt_voucher), is_b2b, recipient_name, recipient_gstin, place_of_supply_state, reverse_charge bool, irn, irn_ack_no, irn_ack_date, signed_qr, einvoice_status enum(na/pending/generated/failed/cancelled), status enum(issued/cancelled), issued_at, cancelled_reason, original_invoice_id (for CN), pdf_file_id, sha256.
- **bill_items**: id, bill_id, invoice_id?, department_id, service_id, item_type enum(consult/lab/rad/pharmacy/procedure/consumable/package/room/other), description, hsn_sac, qty, unit_price, mrp?, tariff_version_id, gross, discount_amount, discount_reason_id, discount_approved_by, taxable_value, gst_rate, cgst, sgst, igst, cess, is_exempt, net, status enum(unpaid/paid/credit/waived/cancelled/refunded), performing_doctor_id, referring_doctor_id, ordering_doctor_id, source_module, source_ref_id, package_component bool, payer_covered bool, patient_share, payer_share, price_status enum(priced/missing/manual), performed_at, posted_at.
- **payments**: id, hospital_id, branch_id, receipt_no (`RECEIPT` gapless), bill_id?, invoice_ids[], patient_id, amount, currency, kind enum(payment/advance/refund/adjustment/wallet_topup), status enum(pending/confirmed/failed/reversed), counter_id, shift_id, cashier_id, paid_at, remarks, idempotency_key.
- **payment_lines** (split): payment_id, mode enum(cash/card/upi/netbanking/wallet/cheque/dd/gateway_link/advance_adjust/patient_wallet/credit/staff_credit/emi), amount, reference (RRN/UTR/cheque no/txn id), gateway_txn_id, card_last4, bank, status, settled_at, settlement_batch_id.
- **advances**: patient_id, receipt_id, amount, balance, purpose, status, adjustments[] (bill_id, amount, at).
- **patient_wallets** (flag): patient_id, balance, ledger entries.
- **discount_requests**: bill_id/item_id, requested_by, pct/amount, reason_code, justification, approver_role, approved_by, decided_at, status, before/after snapshot.
- **refunds**: refund_no, bill_id, payment_id, amount, reason_code, requested_by, approved_by, mode, gateway_refund_id, status enum(requested/approved/processed/failed/rejected), credit_note_invoice_id, processed_at.
- **credit_accounts** (payer/corporate credit limits) → EN-002/NC-012 masters; **payer_bill_splits** (bill_id, payer_id, covered_amount, copay, deductible, preauth_id, claim_id).
- **billing_series_config**, **gst_profiles** (branch GSTIN, legal name, address, turnover flags einvoice_enabled, dynamic_qr), **hsn_sac_master** (code, description, rate, effective dates, exempt flag), **discount_matrix** (role, max_pct, max_amount, needs_approval_from), **payment_modes_config** (per counter), **gl_mappings** (service head/department/GST/mode → ledger codes).
- **billing_exceptions** (RC-006 read model): type, ref, amount, detected_at, status.
- Indexes: bills (hospital_id, branch_id, status, created_at desc), (patient_id, created_at desc), (visit_id) unique for OP; invoices (hospital_id, series_key, invoice_no) unique; payments (hospital_id, branch_id, paid_at), (shift_id); bill_items (bill_id), (performing_doctor_id, performed_at), (source_module, source_ref_id) unique to prevent double posting. RLS all; financial rows never hard-deleted.

## 5. Business Rules & Validations
- One master bill per OP visit; items idempotent by (source_module, source_ref_id).
- Invoice/receipt/credit note numbers gapless per series/FY (row-locked); numbers assigned only at issue; cancelled documents keep number and appear in registers as cancelled.
- GST computation: rate from HSN/SAC master effective on `performed_at`; intra-state → CGST+SGST split equally; inter-state (recipient state ≠ branch state, B2B) → IGST; exempt healthcare (SAC 9993) zero with "exempt" marking; rounding per invoice to nearest rupee (Section 170) recorded as round_off; inclusive/exclusive pricing configurable per item type (medicines MRP inclusive).
- e-Invoice for B2B when `einvoice_enabled`; IRN before print; cancellation of IRN within 24 h else credit note.
- Cash cap: aggregate cash from one person per day ≥ ₹2,00,000 blocked (§269ST); PAN capture for cash > ₹50,000 configurable (Rule 114B not directly, but hospital policy).
- Discount only on taxable value pre-tax; approval matrix mandatory; reason codes; requester ≠ approver; discounts on credit (insurance) bills need payer rules.
- Refund ≤ collected; mode rules; approval matrix; credit note references original invoice; refund of gateway payments through gateway API only.
- Payment confirmation only on gateway webhook/POS response (never on client claim); pending timeout 15 min → auto-check status.
- Bill finalisation requires: no `price_status=missing`, patient identity confirmed, payer eligibility valid; IP/ER bills excluded (IP-005) but ER OP-type visits included.
- Credit patients: co-pay collected upfront; credit limit checks; blocked if `credit_block`.
- Doctor payout attributes immutable after finalisation (changes via reversal + repost).
- Immutability: finalized invoices/receipts immutable; corrections through credit/debit notes; audit trail on every state change with before/after.
- Retention: 8 years (GST) minimum, invoices PDFs archived (S3, WORM optional).
- Multi-currency ready: `currency` on all money rows; FX table for foreign patients (rare in India, needed globally); GST module pluggable per country (`tax_engine` interface: India GST, UAE VAT 5 %, none).

## 6. API Surface (`/api/v1/billing`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /bills?patient=&visit=&status=&date= | list | billing.bill.list | – | cursor |
| GET | /bills/{id} | master bill with items/invoices/payments | billing.bill.read | – | – |
| POST | /bills | create manual/misc bill | billing.bill.create | Y | – |
| POST | /bills/{id}/items | add manual item | billing.item.add | Y | – |
| PATCH | /bills/{id}/items/{i} | edit/cancel unpaid item (reason) | billing.item.update | Y | – |
| POST | /bills/{id}/payer | set/change payer & split | billing.payer.set | Y | – |
| POST | /bills/{id}/discounts | request/apply discount | billing.discount.apply | Y | – |
| POST | /discount-requests/{id}/decide | approve/reject | billing.discount.approve | Y | – |
| POST | /bills/{id}/finalize | issue invoice(s) | billing.bill.finalize | Y | – |
| POST | /invoices/{id}/einvoice | generate/cancel IRN | billing.einvoice.manage | Y | – |
| POST | /payments | collect (split lines) | billing.payment.collect | Y | – |
| POST | /payments/upi-qr, /payments/link, /payments/pos | initiate device/gateway | billing.payment.collect | Y | – |
| POST | /payments/{id}/confirm | webhook/POS confirm (internal) | integration.payment.confirm | Y | – |
| POST | /advances, /advances/{id}/adjust, /advances/{id}/refund | deposits | billing.advance.manage | Y | – |
| POST | /refunds, /refunds/{id}/approve, /refunds/{id}/process | refund workflow | billing.refund.request/approve/process | Y | – |
| POST | /invoices/{id}/cancel | cancel with reason | billing.invoice.cancel | Y | – |
| GET | /receipts/{id}/pdf, POST /receipts/{id}/send | receipt delivery | billing.receipt.print / .send | – | – |
| GET | /patients/{id}/ledger | statement (bills, payments, advances, wallet) | billing.ledger.read | – | cursor |
| GET | /estimates → RC-008 | | | | |
| GET | /items?doctor=&period= | payout feed | billing.payout.read (NC-034) | – | cursor |
| GET | /reports/revenue?by=dept|doctor|payer|mode&from= | MIS | billing.report.read | – | – |
| GET | /reports/gst?type=gstr1|hsn|cn&period= | GST registers | billing.gst.read | – | – |
| GET | /exceptions | leakage worklist | billing.exception.read | – | cursor |
| GET/PUT | /config/series, /config/gst-profile, /config/discount-matrix, /config/modes, /config/gl-map | admin | billing.configure | Y | – |
| GET | /public/verify/{code} | receipt/invoice QR verify | public | – | – |

## 7. Domain Events
- `billing.charge.posted` {bill_id, item} → RC-006, dashboards.
- `bill.finalized` {bill_id, invoices[], items[] with doctor/dept/payer} → NC-009 GL, NC-034 payout, EN-002 claim (credit), analytics, PE-001.
- `payment.received` {payment_id, lines[], bill_id} → NC-001 shift totals, OP-001/OP-004 gates (paid → allow collection/consult), receipts, EN-030 feedback trigger (after OP billing).
- `receipt.issued` → EN-009 WhatsApp/SMS, EN-032 email, portal.
- `payment.pending|failed` → cashier UI.
- `billing.discount.requested|approved|rejected` → EN-037 approver push.
- `billing.refund.requested|approved|processed|failed` → EN-010, patient notification, NC-009.
- `credit_note.issued`, `invoice.cancelled`, `einvoice.generated|failed`.
- `billing.exception.detected` → RC-006 worklist.
- `advance.received|adjusted|refunded`; `wallet.credited|debited`.
- Consumes: `visit.checked_in`, `visit.consult.completed`, `order.*`, `rx.dispensed`, `pharmacy.return.completed`, `lab.order.cancelled`, `procedure.completed`, `appointment.cancelled` (refund), `package.booked`.

## 8. Screens
- **Billing desk / Cashier console** (desktop, dual display optional: customer-facing display shows items + UPI QR): left patient/visit search (`F3`), centre master bill grid (dept groups, item status chips, GST columns toggle), right payment pane. Hotkeys: `F2` new misc bill, `F3` find, `F5` refresh charges, `F7` discount, `F8` payer/insurance, `F9` collect, `F10` finalize+print, `Ctrl+P` reprint receipt, `Ctrl+R` refund, `Esc` cancel. Real-time: charges appear as modules post; UPI payment auto-confirms (socket). Offline: read-only view of cached bills; cash receipts allowed in "offline receipt" mode with provisional numbers (config, printed "provisional") synced later — default OFF for gapless compliance.
- **Payment modal**: split lines, cash denomination calculator, POS status, UPI QR countdown, link send, advance adjust, wallet.
- **Discount request & approval** (desktop + phone for approvers): request card, one-tap approve with PIN.
- **Refund desk**: eligible items, mode selection, approval status tracker.
- **Patient ledger/statement**: bills, receipts, advances, refunds, credit notes; print statement.
- **Corporate/insurance OP credit queue** (EN-002 link): eligibility, co-pay, docs.
- **Day-end / shift close** (NC-001 screen embedded): mode-wise totals, variance, handover.
- **Revenue MIS dashboard** (desktop/TV admin dark theme): daily/weekly/monthly revenue, department split, doctor-wise, payer-wise, mode-wise, discounts, refunds, outstanding, collections vs billed, forecast from appointment pipeline; drill-down; export.
- **Config**: series, GST profile, HSN/SAC master, discount matrix, modes/counters, GL map.
- Print: thermal 80 mm receipt (ESC/POS), A4/A5 tax invoice/bill of supply (PDF with IRN QR when applicable), credit note, statement, day-end summary.

## 9. Integrations
- EN-010: Razorpay (UPI dynamic QR, links, cards), POS terminals (PineLabs/Razorpay POS/Ezetap SDK/cloud API), refunds API, webhooks (idempotent), settlement files → reconciliation; EN-017 GSP for e-invoice IRP (NIC API via GSP e.g. ClearTax/MasterGST — pick in Q16) & GST rate master updates; NC-009 GL/Tally export (XML/CSV); NC-001 cash counter; EN-002/RC-007 payer eligibility & claim hand-off; NC-034 payouts; RC-006/RC-008; EN-009/EN-032 receipts; EN-005 printers; EN-016 signature on invoices; PE-001/EN-034 portal & kiosk payments; SMS/WhatsApp payment links.
- Fallbacks: gateway down → manual UTR entry with pending status & later verification; IRP down → invoice held (or issued for B2C) with retry queue; printer down → digital receipt + reprint later.

## 10. Reports & Analytics
- Daily collection register (counter/shift/mode/user), revenue by department/service/doctor/payer/branch, billed vs collected vs outstanding, discount register (user/reason/approver), refund & credit note register, cancelled bills, advances outstanding, wallet liabilities, GST outward register (B2C/B2B, HSN/SAC summary, rate-wise, exempt), e-invoice register, credit (insurance/corporate) receivables aging (RC-005), doctor payout base (NC-034), average revenue per visit, conversion (orders billed vs executed), leakage exceptions (RC-006), forecast from booked appointments × avg ticket, TDS on payer settlements, cash > threshold report (§269ST), day-book, audit trail extracts.
- Read models: `analytics.mv_revenue_daily` (dept/doctor/payer/mode), `analytics.mv_collections_shift`, `analytics.mv_gst_outward_monthly`, `analytics.mv_discounts`, `analytics.mv_ar_open_op` — refreshed 5–15 min; dashboards never query `bill_items` live.

## 11. Notifications
- Patient: receipt PDF (WhatsApp/email/portal), payment link, refund initiated/processed, outstanding balance reminder, advance balance, wallet credit.
- Approvers: discount/refund approval requests (push, SMS if > 5 min), high-value cash alert.
- Cashier: UPI/POS confirmation, pending payment timeout, printer/IRP errors.
- Finance/admin: day-end summary email, variance alert, e-invoice failures, leakage digest (RC-006), GST register ready.
- Doctor: daily earnings summary (opt-in, NC-034).

## 12. Permissions
`billing.bill.create|read|list|finalize|cancel`, `billing.item.add|update`, `billing.payer.set`, `billing.discount.apply` (ABAC amount_limit), `billing.discount.approve` (level), `billing.payment.collect`, `billing.payment.reverse`, `billing.advance.manage`, `billing.refund.request|approve|process`, `billing.invoice.cancel`, `billing.einvoice.manage`, `billing.receipt.print|send|reprint`, `billing.ledger.read`, `billing.report.read|export`, `billing.gst.read`, `billing.exception.read|resolve`, `billing.payout.read` (own doctor / NC-034), `billing.configure`, `integration.payment.confirm`.
Defaults: Cashier: bill.read/list, payment.collect, receipt.*, discount.apply ≤ limit, refund.request; Billing executive: + bill.create/item.*, payer.set, finalize, invoice.cancel (same day); Billing supervisor: discount.approve L2, refund.approve L2; Admin/MS: L3 approvals; Accountant: reports, gst, einvoice, refund.process, configure (series/GL); Doctor: payout.read own; TPA desk: payer.set, credit; Auditor: read/export.

## 13. Non-functional
- Volumes: 5000 visits/day → ~12k invoices/day, 15k payments/day, 60k bill items/day, 300 counters group-wide; peak 600 payments/hour/branch.
- p95: bill load < 200 ms; payment post < 250 ms (incl. gapless number lock); receipt PDF ≤ 2 s (thermal print immediate via ESC/POS text template); revenue dashboard < 500 ms (read models).
- Gapless numbering under concurrency: per-series row lock; throughput ≥ 50 receipts/s per branch series (short transactions).
- Offline: default read-only; optional provisional cash receipts (see §8) with strict reconciliation.
- Printing: ESC/POS 80 mm, A4 PDF; QR on every receipt; duplicate copies watermarked.
- Accessibility/i18n: keyboard-first; receipts in English + hospital language line; currency formatting `en-IN` (lakh/crore), multi-currency for global.
- Security: 2FA for billing roles; amounts never editable client-side (server computes); PCI: no card data stored (tokens/last4 only); audit on all; PHI minimal on receipts (name, UHID); rate limits on payment endpoints; webhook signature verification.

## 14. Acceptance Criteria
1. Given `visit.checked_in` for a self-pay new patient with consult fee ₹500 (exempt SAC 9993), then a master bill exists with one unpaid item and finalising issues a "Bill of Supply" with gapless number and no GST lines.
2. Given pharmacy dispense of items with 5 % and 12 % HSN, then the pharmacy invoice shows HSN-wise taxable value, CGST/SGST split, MRP-inclusive computation, and totals match to the paisa with round-off recorded.
3. Given a corporate patient with GSTIN in another state, then invoice is B2B tax invoice with IGST and, if e-invoice enabled, an IRN & signed QR are obtained before print; retry on IRP failure with no duplicate IRN.
4. Given split payment ₹1000 cash + ₹1500 UPI, when UPI webhook confirms, then payment status `confirmed`, one receipt with two lines prints, `payment.received` emitted; if webhook never arrives, payment stays `pending` and cashier is alerted at 15 min.
5. Given cashier applies 8 % discount with limit 5 %, then a discount request is routed to supervisor; bill cannot finalise until decided; approval records approver ≠ requester with reason.
6. Given a paid lab order cancelled before collection, then a refund request auto-creates with amount = item net, approval per matrix, credit note referencing the original invoice, and gateway refund via EN-010 for UPI payments.
7. Given attempted cash collection of ₹1,50,000 after ₹60,000 already paid in cash today by the same patient, then the system blocks (§269ST) and suggests digital modes.
8. Given item without tariff price posted, then it appears in billing exceptions, bill finalisation is blocked, and pricing it clears the exception.
9. Given a finalized invoice, then any attempt to edit items returns 409; correction only via credit note; the audit log shows before/after.
10. Given day-end for counter C1, then mode-wise totals equal the sum of confirmed payment lines for that shift and GL posting entries balance (debits = credits).
11. Given `bill.finalized`, then NC-034 receives item-level doctor/department/payer/net/collected attributes and doctor's own-earnings widget shows the visit within 1 min.
12. Given a receipt QR scanned publicly, then verify page shows validity, amount, date, hospital — no PHI beyond patient first name/UHID masked.
13. Given advance ₹5000 collected, when a ₹1200 bill is finalised, then advance auto-adjusts (with prompt), balance ₹3800 shown on ledger and refundable with approval.
14. Given insurance OP payer with 20 % co-pay, then patient share and payer share are computed line-wise, patient pays co-pay only, and a credit invoice is queued to EN-002.
15. Given 600 payments/hour load with gapless series, no duplicate or skipped receipt numbers occur (k6 + DB check).
16. Given revenue MIS for a month, then department totals equal the sum of finalized invoices' net for that period (reconciliation test).
17. Given user without `billing.report.export`, when exporting, then 403 and audit.
18. Given a duplicate `rx.dispensed` event replay, then no duplicate bill item is created (idempotency on source_ref).

## 15. Enhancements / Later phases
- From VIMS sheet: QR code digital receipt verification (Phase 5 core); auto-GST with HSN mapping (core); revenue forecast from appointment pipeline (Phase 5 read model, AI-005 later); bad-debt provisioning & write-off (RC-005, NC-009 Phase 9); patient wallet/prepaid balance (flag Phase 5/10); EMI/instalment option (gateway EMI/BNPL via EN-010, Phase 10).
- (market) Multi-workflow billing, cost estimation, bulk discount, multi-level rate plans, cross time-zone/multi-currency, corporate & insurance invoice management, secondary insurance & automated co-pay, billing threshold control (MocDoc); three-tier pricing grid, quotation engine, walk-in quick billing with inline patient creation, GSTR-1/2A/3B registers, commission/agent-wise reports (SmartHospital) → NC-034/PE-007; credit-party billing, refunds against bill/advance, relief-fund billing (Prodoc); doctor fee accounting & loyalty (Aosta); dynamic pricing (OP-023); kiosk/self-pay; UPI AutoPay for instalments.

## 16. Open Questions for the Hospital
1. GSTIN(s) per branch, aggregate turnover (e-invoice applicability), current invoice series and whether department-wise invoices or a single OP invoice is preferred; FY start.
2. Which services are taxable (cosmetic, health check-up packages sold to corporates, canteen, room > ₹5000) — confirm with CA; HSN/SAC master source.
3. Discount approval matrix (roles, % / amount thresholds), reason codes, doctor self-waiver policy.
4. Refund policy (timelines, modes, approval levels, cash refund cap) and appointment cancellation refund rules.
5. Payment devices: POS vendor/model, UPI QR provider (Razorpay/PhonePe/bank), payment link provider; settlement reconciliation source files.
6. Pay-before vs pay-after consultation; are lab/radiology payable before service for self-pay?
7. Corporate/insurance OP credit: list of payers, co-pay rules, monthly consolidated invoicing, TDS handling.
8. Cash policy: PAN capture threshold, §269ST enforcement mode (block vs warn).
9. GL/Tally chart of accounts mapping and posting frequency (real-time vs day-end).
10. Receipt formats (thermal vs A5), languages, letterhead per branch; customer display availability.
11. Doctor payout rules to be modelled in NC-034 (needed to size item attributes): on billed or collected? discount-borne by whom?
12. Global deployments: which tax engine (VAT) and currencies to support at launch?
