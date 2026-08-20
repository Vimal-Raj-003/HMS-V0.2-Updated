# NC-001 — Cash Counter (Multi-Counter, Shifts, Reconciliation, Denominations, Advances, Refunds)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Non-Clinical / ERP                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Module ID       | NC-001                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Phase           | 1 (counter/shift/receipt core needed for consultation fee collection); full reconciliation & forex in Phase 5 with OP-005                                                                                                                                                                                                                                                                                                                                                                |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Depends on      | EN-007 (users/RBAC), EN-041 (branches), OP-005 (bills/receipts/refunds — money documents live there), IP-005 (IP deposits/interim bills), EN-010 (UPI dynamic QR, POS, payment links, settlement files), EN-005 (thermal receipt printers, cash drawer kick), EN-038 (refund/variance approval matrix), NC-009 (GL posting of cash/bank/clearing, petty cash), EN-009/EN-032 (digital receipts), EN-024 (audit), EN-013 (receipt QR), NC-010 (cashier employee link, shortage recovery)  |
| Feature flag    | `module.cash_counter.enabled` (sub-flags: `cash_counter.forex`, `cash_counter.cash_drawer`, `cash_counter.night_emergency`, `cash_counter.petty_cash`)                                                                                                                                                                                                                                                                                                                                   |
| Primary roles   | Cashier (26), Billing Executive (27), Pharmacy/Lab/Radiology counter staff (30/33/36 with `receipt.collect`), Night duty cashier / ER receptionist (24)                                                                                                                                                                                                                                                                                                                                  |
| Secondary roles | Branch Admin (3, counter config), Finance Manager / Accountant (46, day close, variance approval, GL), Hospital Admin (2), Auditor (58, read-only), Patient (59, receipt copy)                                                                                                                                                                                                                                                                                                           |
| Regulatory      | Income-tax §269ST (cash ≥ ₹2 lakh/person/day prohibited), §40A(3), Rule 114B PAN for cash > ₹50,000 (hospital policy), GST Rule 46/49 receipt & invoice content (via OP-005), RBI/NPCI UPI QR & PA/PG norms (EN-010), FEMA/RBI FFMC rules for forex acceptance (Authorised Dealer/FFMC licence, encashment certificate), NABH PRE/ROM (transparent billing, receipts), DPDP (receipt delivery contact data), Companies Act books of account (cash book), IT Act digital receipt validity |

## 1. Purpose

NC-001 is the physical/virtual **money-handling layer** under every billing module: it defines cash counters and their devices, opens/closes cashier shifts with opening float, records every collection/refund/advance by mode against a shift, produces the denomination sheet, computes system-vs-actual variance, enforces cash-handling controls (drawer, cap, dual custody for handover) and hands the reconciled day book to Accounts. Bills, invoices, receipts and refunds themselves are OP-005/IP-005 documents; NC-001 owns counters, shifts, cash custody, denominations, day-end and forex.

## 2. Users & Jobs-to-be-done

- **Cashier** (desktop + 80 mm thermal printer + cash drawer + card POS + UPI counter display; occasionally tablet at bedside/IP desk): open shift with float in < 30 s, collect payments in any mode/split, issue advances/deposits, process approved refunds, print/reprint/send receipts, close shift with denomination count, hand over cash to next shift or to main cash.
- **Night duty cashier / ER receptionist**: emergency collections at ER/IP desk during off-hours on a "night emergency counter" with reduced permissions, deferred reconciliation to morning main cashier.
- **Departmental counter staff** (pharmacy, lab, radiology): same collect/refund UI embedded in their module; their shift belongs to a department counter.
- **Head cashier / Finance**: view all open shifts live, approve variances, consolidate day book, deposit cash to bank (deposit slip), petty cash imprest, forex reconciliation, post to GL (NC-009).
- **Branch admin**: configure counters, allowed modes per counter, float limits, printers/drawers, series, cash cap policies.
- **Auditor**: read shift reports, variance history, drawer-open log, void/reprint log.

## 3. Core Workflows

### 3.1 Counter setup

1. **Branch admin** creates counter: code (`CC-OP-01`), name, location (OP block/pharmacy/IP desk/ER), type enum(general/pharmacy/lab/radiology/ip_deposit/er_night/forex/kiosk_virtual/online_virtual), allowed payment modes, allowed doc types (OP receipt, IP deposit, refund, advance, misc receipt), float limit, max cash-in-drawer alert threshold, printer profile (EN-005), cash-drawer profile (ESC/POS pulse pin/USB drawer), UPI QR display device, POS terminal id (EN-010), receipt series key per counter or shared per branch → **System** validates unique code per branch, registers devices → Event `cash.counter.configured`.
2. Staff assignment: roster (NC-030) or manual: cashier ↔ counter ↔ shift window; a cashier may only open a shift on counters assigned (ABAC `assigned_counter_only`) unless `receipt.shift.open_any`.
3. Virtual counters: `online_virtual` (gateway/portal/link payments — EN-010 webhooks) and `kiosk_virtual` (EN-034) auto-open a system shift per day; reconciled against settlement files, not denominations.

### 3.2 Shift open

1. **Cashier** logs in → home shows assigned counters → "Open shift" → enters opening float by denomination (or accepts handed-over float from previous shift record) → **System** checks: no other open shift for this user on this branch (config allows 1), counter not occupied (else prompt takeover with supervisor PIN), float ≤ float limit → creates `cash_shifts` (status `open`, opened_at, opening_float, float_source enum(main_cash/previous_shift/none)) → prints "shift open slip" (optional) → Event `cash.shift.opened`.
2. Exceptions: previous shift on this counter not closed → block until closed or force-closed by supervisor (`receipt.shift.force_close`) with reason; float mismatch with handover slip → variance recorded against previous shift.

### 3.3 Collection (called from OP-005/IP-005/OP-003 collect dialogs)

1. Bill/invoice/deposit request arrives at counter (patient banner + amount) → **Cashier** presses `F9` collect → mode picker: **Cash** (denomination calculator optional; auto-computes change to return; §269ST aggregate check per patient/payer per day → block ≥ ₹2,00,000; PAN prompt > ₹50,000 if policy on), **Card** (POS push via EN-010, capture RRN/auth code/last4; manual entry fallback with approval code + supervisor flag), **UPI** (dynamic QR per bill from EN-010 shown on customer display/printed slip; webhook auto-confirms; timeout 3 min → "awaiting confirmation" bucket; manual UTR fallback verified by reconciliation job), **Cheque/DD** (bank, number, date; realisation status; receipt marked "subject to realisation"), **Net banking/wallet/link**, **Advance adjustment**, **Patient wallet**, **Staff credit** (payroll deduction, NC-010), **Forex** (3.7), **Split** — any combination; total must equal payable → **System** creates OP-005 `payments` + `payment_lines` with `counter_id`, `shift_id`, `cashier_id`; increments shift running totals per mode (Redis + DB); receipt (gapless `RECEIPT` series) printed & delivered (WhatsApp/SMS/email/portal) → cash-drawer kick on cash/cheque → Event `payment.received` (OP-005) and `cash.shift.totals.updated`.
2. Idempotency: `Idempotency-Key` per collect attempt; duplicate submissions return same receipt.
3. Reprint: `Ctrl+P` reprint receipt → watermark "DUPLICATE", reprint counter, logged (`receipt.reprinted`), limit N per receipt (config, default 3) then supervisor.
4. Void (before shift close, same cashier, only if no downstream service consumed and within X min): supervisor PIN → receipt `void` (number retained), amount reversed from shift totals, drawer opened for cash return, reason mandatory → Event `receipt.voided`. After close → refund workflow (3.5).
5. Offline: if API unreachable, counter PWA queues collections in IndexedDB with provisional receipt number (`TEMP-<counter>-<seq>`, printed as "provisional receipt — final number will be sent by SMS"), max offline amount/count per shift (config), cash mode only (no UPI/card without confirmation); on reconnect → replay with idempotency keys → real receipt numbers issued and SMS sent; conflicts (bill already paid elsewhere) → exception list for supervisor.

### 3.4 Advance / deposit

1. **Cashier** collects advance (OP procedure advance, IP admission deposit, package advance, health-check advance) → receipt kind `advance` (series `ADV` or shared `RECEIPT` per config), purpose, linked admission/visit/package, mode(s) → **System** creates OP-005/IP-005 `advances` (balance tracked) → Event `advance.collected` → IP-005 auto-adjusts against interim/final bill; unadjusted balance refundable via 3.5 with approval; advance ledger per patient visible on banner.
2. IP-005 deposit-top-up alerts (deposit < X % of running bill) create a **collection task** at IP counter/bedside tablet.

### 3.5 Refund processing (money-out at counter)

1. Refund request created in OP-005/IP-005 (reason, amount, mode preference) → approval matrix (EN-038: cashier ≤ ₹500 own shift same day; supervisor ≤ ₹5,000; finance above; segregation requester ≠ approver) → approved refund appears in **counter refund queue** → **Cashier** selects, verifies patient identity (UHID + phone OTP or ID for > ₹5,000 config), pays: cash from drawer (only if drawer cash ≥ amount, else route to main cash), UPI/card reversal via EN-010 (never cash for digital payments > ₹10,000, config), NEFT (bank details captured, processed by finance in NC-009 payment run) → refund receipt (`REFUND` series) printed/sent, credit note per OP-005 → shift totals decremented → Event `payment.refunded` (OP-005) / `cash.refund.paid`.
2. Advance refund: same path with `advance_id`; excess-payment refund; cancelled-service refund.

### 3.6 Shift close & reconciliation

1. **Cashier** → "Close shift" → **System** shows system totals: opening float + cash collections − cash refunds − cash paid out (petty/expenses) = expected cash; per-mode totals (card, UPI, cheque, wallet, forex), receipts count, voids, refunds, advances, pending UPI/POS confirmations (must be resolved or moved to "unconfirmed" bucket by supervisor) → **Cashier** enters **denomination sheet** (₹500, ₹200, ₹100, ₹50, ₹20, ₹10, coins ₹20/10/5/2/1; configurable list incl. ₹2000 legacy) → actual cash computed → variance = actual − expected → if |variance| > tolerance (₹0 default; config e.g. ₹10) → reason mandatory + supervisor approval (`receipt.shift.variance.approve`); shortage may be tagged for salary recovery (NC-010 hook, needs HR approval) or "excess to suspense" → card/UPI mode counts vs POS/gateway batch totals (EN-010 settlement report/POS batch print) with mismatch flag → cheque list attached → **hand-over**: to main cash (cash bag/seal no., receiver signs with PIN) or to next shift as float → status `closed` (locked; no further receipts on shift) → shift report PDF (Z-report) printed → Event `cash.shift.closed` (payload: totals by mode, variance, cashier).
2. Force close by supervisor when cashier absent: totals frozen, denominations entered by two persons (dual custody), flagged `force_closed`.
3. Reopen: not allowed; corrections via adjustment vouchers on the next shift with reference and finance approval (audited).

### 3.7 Forex counter (international patients) (`cash_counter.forex`)

1. Only counters of type `forex` (hospital must hold RBI FFMC/AD-II licence or route via authorised money changer) → **Cashier** selects currency (USD/EUR/GBP/AED/SAR/OMR/… from `fx_rates` daily card rate set by finance, source: bank/manual, with buy/sell spread) → amount in foreign currency → INR equivalent computed and shown → passport/visa details captured (mandatory: name, passport no., nationality, visa type; FEMA/KYC) → receipt shows FC amount, rate, INR, and prints **encashment certificate** → foreign notes tracked as separate denomination sheets per currency in shift close → daily FX gain/loss posted to NC-009 → Event `cash.forex.accepted`.
2. Card payments in foreign currency (DCC) via EN-010 gateway; not part of forex cash.

### 3.8 Night shift emergency collection (`cash_counter.night_emergency`)

1. Counter type `er_night` (ER/IP desk); staff with `receipt.collect.night` (ER receptionist/nurse in-charge) can collect **cash/UPI only**, up to per-receipt and per-shift limits (config e.g. ₹50,000/₹2,00,000), for ER visits/IP deposits/pharmacy emergencies; receipts printed normally; **no refunds/voids** at night counter → cash locked in drop safe with envelope number recorded → next morning **main cashier** performs "night reconciliation": counts envelopes, matches to night shift totals, closes the night shift on behalf (dual custody), variances escalated → Event `cash.shift.closed` (`night=true`).

### 3.9 Day close & accounting hand-off

1. **Head cashier / finance** → **Day book** (branch, business date; business day cut-off configurable e.g. 00:00 or 08:00): list of shifts (open/closed/force-closed), totals by counter/cashier/mode, variances, refunds, advances, unconfirmed digital payments, cheques received, cash on hand at main cash → **bank deposit**: deposit slip generation (denominations, bank, account) → deposit reference/CDM slip number captured; cash-in-transit posting → **card/UPI settlement**: match EN-010 settlement files (T+1) with counter mode totals → **Day close** (all shifts closed, all deposits/pending items either resolved or carried forward with reason) → **System** builds journal batch (NC-009 mapping): Dr Cash-in-hand / Card clearing / UPI clearing / Bank (deposits) / Cheques-in-hand; Cr Patient receipts control (per revenue module) & advances liability; refunds reversed; FX gain/loss; shortage/excess to suspense → Event `cash.day.closed` → NC-009 posts, Tally export.
2. Petty cash imprest (`cash_counter.petty_cash`): finance issues float to petty cash holder; vouchers with heads/receipts/photos; replenishment; posted to NC-009 expense heads.

### 3.10 Exceptions & edge cases (all counters)

1. **Cashier leaves without closing** (shift open > configured max hours, default 10 h): reminder push at 9 h; supervisor force-close path (3.6.2); collections after the max are blocked until acknowledged.
2. **Wrong mode recorded** (cash entered as UPI): same-shift void + re-collect (supervisor PIN) if no receipt left the counter; if receipt already delivered → refund + re-receipt (numbers retained, cross-referenced).
3. **Cheque bounce** (post-close): NC-009 records bounce → OP-005 reverses receipt applicability → patient outstanding restored → alert to counter/billing; bounce charges bill line.
4. **Card POS declined but bill marked paid** (manual entry error): reconciliation job compares POS batch (EN-010) with counter card lines nightly → mismatch → shift variance ticket to head cashier.
5. **Duplicate patient advance** (two counters collect for same admission): allowed (multiple deposits) but banner shows total advance; IP-005 adjusts all.
6. **Power/printer failure mid-receipt**: receipt already numbered → reprint path (copy 1) without a second number; digital receipt always sent.
7. **Counter takeover** by supervisor for a cashier's break: temporary "relief" mode records relief user on receipts while shift ownership remains; relief limited to 60 min (config).
8. **Multi-branch cashier**: shift is per branch; a user with roles in two branches cannot hold two open shifts unless flag `allow_multi_branch_shift`.
9. **Currency rounding**: cash rounding to nearest ₹1 (config) recorded as round-off line in OP-005; UPI/card exact.
10. **Fraud watch**: > N voids or reprints per shift, drawer opens without sale > threshold, frequent same-amount cash refunds → flag to head cashier & internal audit (NC-009 sampling).

### 3.11 Configuration defaults (seed)

- Denominations: ₹500, ₹200, ₹100, ₹50, ₹20, ₹10, ₹5, ₹2, ₹1 (+ ₹2000 legacy, disabled by default).
- Variance tolerance ₹0; refund payout caps cashier ₹500 / supervisor ₹5,000 / finance above; night counter caps ₹50,000 per receipt / ₹2,00,000 per shift; reprint limit 3; shift max 10 h; UPI pending timeout 15 min; §269ST cap ₹2,00,000; PAN threshold ₹50,000 (off by default).
- Business-day cut-off 00:00; float limit ₹10,000; drawer alert ₹1,00,000; provisional offline receipts max 20 per shift / ₹50,000.
- Series: `RECEIPT`, `ADV`, `REFUND`, `ENC` per branch per FY, gapless.
- Payment modes per counter type: general (all), pharmacy (cash/card/UPI/wallet/credit), er_night (cash/UPI), forex (forex/cash), online_virtual (gateway modes only).

## 4. Data Model (schema `billing`, prefix `cash_`)

- **cash_counters**: id, hospital_id, branch_id, code, name, location, counter_type enum(general/pharmacy/lab/radiology/ip_deposit/er_night/forex/kiosk_virtual/online_virtual/petty_cash), allowed_modes text[], allowed_doc_types text[], float_limit numeric(14,2), drawer_alert_limit numeric(14,2), receipt_series_key, printer_profile_id, drawer_profile jsonb, upi_display_device_id, pos_terminal_id, department_id?, is_active, version. UNIQUE (hospital_id, branch_id, code).
- **cash_counter_assignments**: id, counter_id, user_id, valid_from, valid_to, shift_template_id? (NC-030), assigned_by.
- **cash_shifts**: id, hospital_id, branch_id, counter_id, cashier_user_id, business_date date, opened_at, closed_at, status enum(open/closing/closed/force_closed), opening_float, float_source enum(main_cash/previous_shift/none), previous_shift_id?, expected_cash, counted_cash, variance, variance_reason, variance_approved_by, handover_to enum(main_cash/next_shift), handover_bag_no, handover_received_by, receipts_count, voids_count, refunds_count, is_night bool, closed_by (may differ from cashier for force/night close), z_report_file_id, version. INDEX (hospital_id, branch_id, business_date), (counter_id, status) — partial unique on (counter_id) WHERE status='open'.
- **cash_shift_totals** (read model, upserted per event): shift_id, mode enum(cash/card/upi/netbanking/wallet/cheque/dd/gateway_link/advance_adjust/patient_wallet/staff_credit/forex/emi), collections, refunds, count, pending_confirmation_amount. UNIQUE (shift_id, mode).
- **cash_denomination_sheets**: id, shift_id, kind enum(opening/closing/handover/deposit/night_envelope), currency char(3), lines jsonb [{denom numeric, count int, amount}], total, counted_by, witnessed_by?, created_at.
- **cash_drawer_events**: id, shift_id, counter_id, opened_at, reason enum(sale/refund/no_sale/change/float/count), triggered_by, receipt_id?. Partitioned monthly.
- **cash_receipt_reprints**: receipt_id, shift_id, reprinted_by, reason, at, copy_no.
- **cash_receipt_voids**: receipt_id, shift_id, voided_by, approved_by, reason, at.
- **cash_night_envelopes**: id, shift_id, envelope_no, declared_amount, counted_amount, counted_by, counted_at, variance.
- **cash_handovers**: id, from_shift_id, to_shift_id? / to_main_cash bool, amount, bag_no, given_by, received_by, given_at, received_at, status enum(pending/accepted/disputed).
- **cash_day_books**: id, hospital_id, branch_id, business_date, status enum(open/closed), total_by_mode jsonb, total_variance, deposits_total, closed_by, closed_at, journal_batch_id (NC-009). UNIQUE (hospital_id, branch_id, business_date).
- **cash_bank_deposits**: id, day_book_id, bank_account_id (NC-009), amount, denomination_sheet_id, deposit_slip_no, cdm_ref, deposited_by, deposited_at, status enum(prepared/deposited/confirmed), bank_stmt_match_id?.
- **cash_settlement_matches**: id, day_book_id, mode, provider (EN-010), settlement_batch_id, provider_total, counter_total, difference, status.
- **cash_petty_cash_books**: id, branch_id, holder_user_id, imprest_amount, balance; **cash_petty_vouchers**: id, book_id, voucher_no, date, head (GL account), amount, description, receipt_file_id, approved_by, status.
- **cash_fx_rates**: id, hospital_id, currency char(3), rate_date, buy_rate, sell_rate, source enum(bank/manual/api), set_by. UNIQUE (hospital_id, currency, rate_date).
- **cash_forex_receipts**: id, payment_line_id (OP-005), currency, fc_amount, rate, inr_amount, passport_no, nationality, visa_type, encashment_cert_no, doc_file_id.
- **cash_adjustment_vouchers**: id, shift_id, kind enum(shortage_recovery/excess_suspense/correction/petty_issue), amount, reason, approved_by, journal_ref.
- Payment/receipt/refund/advance rows are OP-005 `payments`, `payment_lines`, `advances`, `refunds` — NC-001 adds `counter_id`, `shift_id`, `cashier_id` FKs and enforces them NOT NULL for counter-originated payments. RLS on all; no hard delete; `version` optimistic locking on shifts.

## 5. Business Rules & Validations

- A payment can only be recorded against an **open** shift owned by the requesting user on an allowed counter/mode; virtual counters use system shifts.
- One open shift per user per branch (config); one open shift per counter; takeover requires supervisor PIN and is logged.
- Receipt numbers gapless per series/FY (OP-005 rule); shift totals derived from payment events (event-sourced), never edited by hand; corrections only via voids (same shift) or refunds/adjustment vouchers.
- Cash cap: aggregate cash ≥ ₹2,00,000 from one payer per day blocked (§269ST); split across bills/receipts does not evade (aggregation by patient/payer per business date); PAN capture threshold configurable.
- Change computation: cash tendered ≥ amount; drawer alert when cash-in-drawer > threshold → prompt "drop to main cash" (interim drop recorded as handover).
- Denomination sheet mandatory at close (unless counter type virtual); total must equal counted cash; variance tolerance and approval matrix from config; unresolved variance blocks day close.
- Pending digital confirmations older than 15 min are auto-queried (EN-010 status API); at close they must be confirmed, failed (bill returns to unpaid) or parked as `unconfirmed` by supervisor.
- Refunds at counter require approved refund record and identity verification; refund mode rules follow OP-005; refund never exceeds drawer cash for cash mode.
- Night counter: modes cash/UPI only, caps, no voids/refunds; must be reconciled by main cashier before that day's day-close.
- Forex: only licensed counters, currencies from active rate card of that date, KYC mandatory, encashment certificate numbered gaplessly (`ENC` series).
- Business date cut-off configurable; shifts spanning cut-off are attributed to the opening business date.
- Segregation of duties: cashier ≠ variance approver ≠ day-close closer (except single-cashier small hospitals: config `allow_self_close_small_site` with auditor flag).
- Retention: shift/day-book records 8 years (GST/IT); drawer/reprint logs 3 years.
- Multi-currency ready: `currency` on all amount rows; INR default; per-branch base currency (global deployments).

## 6. API Surface (`/api/v1/cash`)

| Method                                                                                                                     | Path                                                                           | Purpose                                 | Permission                     | Idem    | Pag                 |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------ | ------- | ------------------- |
| GET/POST/PATCH                                                                                                             | /counters, /counters/{id}                                                      | counter config                          | receipt.counter.configure      | Y       | cursor              |
| POST                                                                                                                       | /counters/{id}/assignments                                                     | assign cashiers                         | receipt.counter.configure      | Y       | –                   |
| GET                                                                                                                        | /shifts?branch=&date=&status=&counter=                                         | list shifts (live)                      | receipt.shift.list             | –       | cursor              |
| POST                                                                                                                       | /shifts/open                                                                   | open shift with float                   | receipt.shift.open             | Y       | –                   |
| GET                                                                                                                        | /shifts/{id}                                                                   | shift detail + totals + denominations   | receipt.shift.read             | –       | –                   |
| POST                                                                                                                       | /shifts/{id}/drawer-open                                                       | no-sale drawer open with reason         | receipt.drawer.open            | Y       | –                   |
| POST                                                                                                                       | /shifts/{id}/close/preview                                                     | expected totals for close               | receipt.shift.close            | –       | –                   |
| POST                                                                                                                       | /shifts/{id}/close                                                             | denominations + variance + handover     | receipt.shift.close            | Y       | –                   |
| POST                                                                                                                       | /shifts/{id}/force-close                                                       | supervisor close                        | receipt.shift.force_close      | Y       | –                   |
| POST                                                                                                                       | /shifts/{id}/variance/approve                                                  | approve variance                        | receipt.shift.variance.approve | Y       | –                   |
| POST                                                                                                                       | /handovers/{id}/accept                                                         | receiver confirms cash                  | receipt.handover.accept        | Y       | –                   |
| GET                                                                                                                        | /refund-queue?counter=                                                         | approved refunds awaiting payout        | receipt.refund.pay             | –       | cursor              |
| POST                                                                                                                       | /refunds/{id}/pay                                                              | pay out refund at counter               | receipt.refund.pay             | Y       | –                   |
| POST                                                                                                                       | /receipts/{id}/reprint, /receipts/{id}/void                                    | reprint / void                          | receipt.reprint / receipt.void | Y       | –                   |
| GET                                                                                                                        | /night-shifts?date= ; POST /night-shifts/{id}/reconcile                        | morning reconciliation                  | receipt.night.reconcile        | Y       | –                   |
| GET                                                                                                                        | /day-book?branch=&date=                                                        | day book                                | receipt.daybook.read           | –       | –                   |
| POST                                                                                                                       | /day-book/{id}/deposits, /day-book/{id}/settlement-match, /day-book/{id}/close | day close                               | receipt.daybook.close          | Y       | –                   |
| GET/POST                                                                                                                   | /petty-cash/books, /petty-cash/vouchers                                        | petty cash                              | receipt.petty.manage           | Y       | cursor              |
| GET/PUT                                                                                                                    | /fx-rates?date=                                                                | forex card rates                        | receipt.forex.configure        | Y       | –                   |
| POST                                                                                                                       | /forex/receipts                                                                | forex acceptance details (with payment) | receipt.forex.collect          | Y       | –                   |
| GET                                                                                                                        | /reports/shift/{id}/z-report.pdf, /reports/collections?by=counter              | cashier                                 | mode&from=&to=                 | reports | receipt.report.read | –   | –   |
| POST                                                                                                                       | /offline/replay                                                                | replay queued offline receipts          | receipt.collect                | Y       | –                   |
| Collect/advances endpoints are OP-005 (`POST /billing/payments`, `/billing/advances`) with `counter_id/shift_id` required. |

## 7. Domain Events (outbox)

- `cash.counter.configured` {counter_id} → EN-005 printer registry, RBAC scope cache.
- `cash.shift.opened` {shift_id, counter_id, cashier_id, opening_float} → live cash dashboard, audit.
- `cash.shift.totals.updated` {shift_id, mode, delta} (from `payment.received`/`payment.refunded`/`receipt.voided`) → dashboard read model.
- `cash.shift.closed` {shift_id, totals_by_mode, variance, handover, is_night, force_closed} → NC-009 (day book staging), finance dashboard, NC-010 (shortage recovery task if flagged).
- `cash.refund.paid` {refund_id, shift_id, mode, amount} → OP-005/IP-005 status, patient notification.
- `cash.forex.accepted` {payment_line_id, currency, fc_amount, rate} → NC-009 FX ledger.
- `cash.day.closed` {day_book_id, journal_batch} → NC-009 posting, NC-011 MIS, Tally export job.
- `receipt.reprinted`, `receipt.voided`, `cash.drawer.opened` → EN-024 audit, fraud analytics.
- Consumes: `payment.received`, `payment.refunded`, `advance.collected` (OP-005/IP-005), `payment.settlement.imported` (EN-010), `roster.published` (NC-030), `user.deactivated` (EN-007 → force close prompt).

## 8. Screens (UI)

- **Cashier home / Open shift** — desktop; counter cards (assigned, status), float denomination grid with auto-total, "accept handover" panel; `Enter` open; empty state "No counter assigned — contact branch admin".
- **Collect dialog** (embedded in OP-005/IP-005/OP-003) — desktop/tablet; amount, mode tabs (`F2` cash, `F3` card, `F4` UPI, `F5` cheque, `F6` split, `F7` advance adjust, `F8` wallet), denomination calculator with change due, UPI QR pane with live status (Socket.IO webhook push), POS status; `F9` confirm & print, `Ctrl+P` reprint, `Esc` cancel; offline banner + provisional receipt mode.
- **Shift dashboard (my shift)** — desktop; running totals by mode, receipts list (search by receipt/patient), pending confirmations, refund queue, drawer events; `Ctrl+Shift+C` start close.
- **Shift close wizard** — desktop; expected vs counted, denomination grid (keyboard-first, tab through counts), variance reason, card/UPI batch reconciliation, cheque list, handover (bag no., receiver PIN), Z-report print.
- **Refund payout** — desktop; approved refunds list, identity verify (OTP), mode, print refund receipt.
- **Head cashier live board** — desktop/TV(optional): all counters, open shifts, cash-in-drawer, alerts (drawer above limit, unconfirmed UPI > 15 min, shift open > 10 h), night envelopes pending; realtime via Socket.IO.
- **Day book & bank deposit** — desktop; shifts grid, deposits, settlement match, close button (disabled with reasons listed), journal preview.
- **Forex acceptance** — desktop; currency picker, rate card, KYC form, encashment certificate print.
- **Petty cash book** — desktop/tablet; vouchers with photo capture.
- **Counter config** — desktop admin.
- All screens: light theme, WCAG 2.2 AA, i18n; error states show retry and offline queue count.

## 9. Integrations

- EN-010: dynamic UPI QR, POS push (PineLabs/Razorpay/Paytm/Ezetap), payment links, refunds API, settlement files (CSV/API T+1) → matches; status polling on timeout; DLQ for webhooks.
- EN-005: ESC/POS thermal receipts (80 mm), cash-drawer kick pulse via printer, customer-facing display (optional serial/USB), A4/A5 fallback; print queue with reprint watermark.
- NC-009: journal batches for day close, bank accounts, petty cash heads, FX ledger; Tally XML/CSV export.
- NC-010: cashier ↔ employee, shortage recovery entries (approval), NC-030 roster.
- EN-009/EN-032/PE-001: receipt delivery.
- Bank CDM/deposit: manual slip; optional bank statement match through NC-009 recon.

## 10. Reports & Analytics

- Shift report (Z-report): mode-wise, receipts/voids/refunds, denominations, variance, handover.
- Daily collection summary: counter-wise, cashier-wise, mode-wise, department/revenue-module-wise; sent to Accounts automatically at day close (email PDF/Excel).
- Variance history per cashier (trend, repeated shortages), reprint/void frequency (fraud indicators), drawer opens without sale, unconfirmed digital payments ageing, cheque realisation register, advance outstanding, forex register (RBI FLM-style summary), petty cash ledger.
- Read models: `analytics.cash_shift_daily` (branch, date, counter, cashier, mode, collections, refunds, variance), `analytics.cash_mode_hourly` (for staffing). Refresh by events + nightly.

## 11. Notifications

- Cashier push/in-app: refund approved for payout, UPI confirmed, shift open > 10 h reminder, drawer cash above limit.
- Supervisor: variance approval request (push + in-app), force-close needed, unconfirmed digital payments at close, night envelope pending.
- Finance: day close done (email with PDF summary), settlement mismatch, deposit not confirmed T+1.
- Patient (via OP-005 templates): receipt/refund receipt WhatsApp/SMS; provisional receipt → final number SMS after offline replay.

## 12. Permissions (RBAC keys)

`receipt.counter.configure` (Branch Admin), `receipt.shift.open` / `.read` / `.list` / `.close` (Cashier; list-all for Head Cashier/Finance), `receipt.shift.open_any`, `receipt.shift.force_close`, `receipt.shift.variance.approve` (Head Cashier/Finance), `receipt.collect` (Cashier/Billing/dept counters), `receipt.collect.night` (ER reception/nurse in-charge, time-window ABAC), `receipt.reprint`, `receipt.void` (supervisor PIN), `receipt.drawer.open`, `receipt.refund.pay`, `receipt.handover.accept`, `receipt.night.reconcile`, `receipt.daybook.read` / `.close` (Finance), `receipt.petty.manage`, `receipt.forex.configure` / `.collect`, `receipt.report.read` (Finance/Auditor/Admin), `receipt.export` (audited). ABAC: `assigned_counter_only`, `amount_limit` (night caps, refund payout caps), `time_window` (night).

## 13. Non-functional

- Volumes (2000-bed): 40–60 counters, 150 shifts/day, 8,000–12,000 receipts/day, peaks 20 receipts/s across counters at 9–11 am; collect API p95 < 200 ms excluding printer; UPI webhook → UI push < 2 s.
- Offline: counter PWA queues cash receipts (limits), replays with idempotency; shift close disabled offline.
- Printing: ESC/POS 80 mm; receipt < 1.5 s; drawer kick; reprint watermark; A4 for day book/Z-report (Playwright PDF).
- Accessibility: keyboard-only collection flow; large numeric keypad on tablet; high-contrast; i18n incl. denomination labels; RTL ready.
- Security: 2FA for supervisor overrides (PIN + session), all money mutations audited with before/after, no PHI in logs, rate limit on reprint/void.

## 14. Acceptance Criteria

1. Given a cashier assigned to counter CC-OP-01, when she opens a shift with float ₹5,000 by denominations, then a shift is created `open`, a second open attempt on the same counter by another user is blocked with takeover prompt.
2. Given an open shift, when a ₹1,500 bill is paid ₹500 cash + ₹1,000 UPI and the UPI webhook confirms, then one receipt is issued, shift totals show cash 500/UPI 1000, drawer event logged, and the receipt is delivered by WhatsApp.
3. Given UPI QR shown and no webhook within 3 min, when cashier attempts to close, then the payment is listed as pending and close is blocked until confirmed/failed/parked by supervisor.
4. Given a patient who paid ₹1,95,000 cash today, when a further ₹10,000 cash is attempted, then the system blocks with §269ST message and offers digital modes.
5. Given shift close with expected cash ₹52,300 and counted ₹52,000, then variance −300 requires reason and supervisor approval; approval recorded with approver ≠ cashier; Z-report shows variance.
6. Given a supervisor force-closes an abandoned shift, then denominations require two user PINs and shift is marked `force_closed` with audit.
7. Given an approved refund of ₹800 (cash original), when cashier pays it out after OTP verification, then refund receipt prints, shift cash total reduces, and OP-005 refund status becomes `processed`.
8. Given a receipt reprinted a 4th time, then the system requires supervisor authorisation and logs each reprint with copy number and "DUPLICATE" watermark.
9. Given a night counter, when ER receptionist collects ₹60,000 cash exceeding per-receipt cap ₹50,000, then collection is refused; when she attempts a refund, then action is unavailable.
10. Given night envelopes declared ₹1,20,000 and counted ₹1,19,500 next morning, then night shift closes with variance −500 escalated to finance.
11. Given network loss, when 5 cash receipts are taken offline, then provisional numbers print, and on reconnect real gapless numbers are assigned in order and SMS sent; a duplicate replay does not create duplicate receipts.
12. Given all shifts closed and deposits recorded, when finance closes the day, then a balanced journal batch is created in NC-009 (Dr cash/clearing/bank = Cr receipts control/advances ± refunds/variance) and event `cash.day.closed` emitted; with one shift open, close is refused listing the shift.
13. Given a USD 200 forex receipt at rate 83.20, then INR 16,640 is receipted, KYC stored, encashment certificate numbered, and FX register updated.
14. Given a cashier without `receipt.void`, when she attempts void, then 403 and audit entry; with supervisor PIN, void succeeds only within same open shift.
15. Given card settlement file shows ₹2,10,000 vs counter card total ₹2,12,000, then day book shows mismatch ₹2,000 with drill-down to unmatched receipts.
16. Given a supervisor takes over a counter for a 30-minute relief, then receipts issued during relief carry the relief user id while shift totals accrue to the original shift; relief beyond 60 minutes prompts formal handover.
17. Given a cheque receipt bounces after day close, then the patient's outstanding is restored, bounce charge is posted, and the original receipt shows "cheque returned" without altering the closed shift.
18. Given a shift with 6 voids (threshold 5), then a fraud-watch flag is raised to the head cashier and internal audit sample includes the shift.
19. Given a pharmacy counter type, when the cashier tries the forex mode, then the mode is not offered (allowed modes per counter type).

## 15. Enhancements / Later phases

- From VIMS sheet: UPI QR per bill (Phase 5 core), cash drawer integration (Phase 1/5), forex counter (Phase 9), denomination calculator (Phase 1), night emergency collection (Phase 5).
- (market) Cash manager dashboard with cash-position forecasting; smart safe / cash recycler integration; NFC/tap-to-pay on tablet; cashier performance scorecards; automatic detection of shortage patterns (AI-005); patient-facing customer display with itemised bill & QR; multi-currency float for global sites.

## 16. Open Questions for the Hospital

1. Number and location of counters per branch, which departments collect independently (pharmacy/lab/radiology) vs central counters?
2. Business-day cut-off time and shift pattern (2 or 3 shifts; night counter locations)?
3. Variance tolerance and approval matrix amounts; policy for shortage recovery from salary?
4. Cash cap policy: enforce ₹2 lakh strictly by patient or by payer; PAN capture threshold?
5. Refund payout limits per role and mode rules (cash refunds max, NEFT above)?
6. Which POS/UPI providers and whether counters have customer displays and cash drawers (models)?
7. Forex: does the hospital hold FFMC/AD licence or use an external money changer? Currencies to accept?
8. Petty cash: holders, imprest amounts, GL heads?
9. Bank accounts for deposits per branch, CDM usage, cheque acceptance policy?
10. Receipt series: per counter or per branch; FY start (April) confirmed; Tally or other accounting export format?
