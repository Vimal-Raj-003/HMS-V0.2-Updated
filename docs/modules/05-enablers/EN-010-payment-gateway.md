# EN-010 — Payment Gateway (Razorpay + Adapters, UPI Dynamic QR, Payment Links, POS Terminals, Refunds, Webhooks, Reconciliation, Ledger Sync, EMI)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-010 |
| Phase | 5 (UPI QR/links from Phase 1 with NC-001 cash counter) |
| Priority | P0 |
| Complexity | Medium |
| Depends on | NC-001 (Cash Counter — receipts, shift reconciliation), OP-005/IP-005 (bills), NC-009 (Accounts — ledger sync, bank recon), EN-009 (payment link delivery), PE-001/OP-020 (portal/app payments), EN-012 (website payment links), EN-034 (kiosk payments), EN-017 (hub, webhooks/DLQ), EN-007 (secrets/settings), EN-024 (audit), EN-038 (refund approvals), NC-012 (corporate invoices), EN-002 (patient share collection), NC-033 (canteen POS) |
| Feature flag | `module.payments.enabled` (sub: `payments.links`, `payments.pos`, `payments.emi`, `payments.international`, `payments.autopay`) |
| Primary roles | Cashier (26), Billing Executive (27), Accountant (46), IT Admin (56) |
| Secondary roles | Front office (links/QR at desk), Patient (payer), Corporate client (portal payments), Hospital Admin (refund approvals), Auditor |
| Regulatory | RBI Payment Aggregator/PG guidelines (no card storage; tokenisation via network tokens), PCI-DSS SAQ-A (hosted checkout only), RBI card-on-file tokenisation, NPCI UPI rules (dynamic QR, intent, mandates/AutoPay), RBI refund timelines (T+? per instrument; failed transaction TAT & compensation circular), GST (receipts, convenience fee treatment), Income-tax (Rule 114B PAN for cash > ₹2 lakh — cash side NC-001), DPDP (payer data), IT Act (webhook signature integrity), NABH (billing transparency, e-receipts) |

## 1. Purpose
EN-010 abstracts online/digital collections behind a gateway adapter interface: Razorpay as default (Orders, Checkout, UPI dynamic QR, Payment Links, POS/EDC terminals, Refunds, Webhooks, Settlements API), with adapters for PhonePe, PayU, Cashfree, HDFC/ICICI bank PGs and Stripe (international). It issues dynamic UPI QR at every counter/kiosk/bedside, sends payment links via WhatsApp/SMS/portal, integrates POS card terminals (Razorpay POS/Pine Labs/Ezetap) so amounts push from the bill to the device, receives webhooks to auto-post receipts (NC-001), manages refunds with approvals, reconciles gateway settlements against receipts and bank credits (NC-009), and supports EMI/BNPL offers — with idempotent, auditable money movement.

## 2. Users & Jobs-to-be-done
- **Cashier** (desktop + QR display/POS terminal): collect bill via UPI QR (patient scans), card on EDC (amount pushed), or link; see instant confirmation without asking the patient for screenshots; issue receipt automatically; process refunds to source with approval.
- **Billing/insurance desk**: send payment links for advances/deposits/patient share; track pending links.
- **Patient** (phone): pay from portal/app/website/WhatsApp link, deposit before admission, pay pharmacy/lab online, save UPI AutoPay for instalments (optional).
- **Accountant**: daily settlement reconciliation (gateway → bank), fee/GST on charges, unmatched items, refunds/chargebacks, ledger sync to NC-009.
- **IT Admin**: gateway credentials per branch/legal entity, webhooks, terminal pairing, sandbox/live switch.
- **Kiosk** (EN-034): self-pay for OPD/lab.

## 3. Core Workflows

### 3.1 Gateway & terminal setup
1. IT configures **merchant accounts** per legal entity/branch (key id/secret encrypted, webhook secret, settlement bank account (NC-009), MDR/fee schedule, supported methods (UPI/cards/netbanking/wallets/EMI/international), convenience-fee policy) → `pay_gateway_accounts`; sandbox → live promotion checklist; webhook URL registration; health ping.
2. **POS terminals** (`payments.pos`): register device (serial/TID, provider, counter/workstation, mode: push-from-bill via cloud API vs standalone with manual entry) → `pay_terminals`; pairing test.
3. **QR displays**: dynamic QR shown on cashier second screen/customer-facing display or printed on receipt for pending amount; static QR (branch VPA) as fallback with manual matching.

### 3.2 Collect at counter (UPI QR / card / link)
1. Cashier finalises bill (OP-005) or takes advance (NC-001) → chooses **Digital**: System creates gateway **Order** (amount, currency, receipt ref, notes: hospital, bill no, patient hash) → `pay_intents` (status `created`) → options:
   - **UPI dynamic QR** (Razorpay QR Codes API `usage=single_use`, amount fixed, `close_by` 15 min) rendered on customer display/receipt; patient scans → **webhook `qr_code.credited`/`payment.captured`** → intent `paid` → auto-create receipt (NC-001) with method UPI, UTR/RRN, payer VPA → receipt printed/WhatsApp e-receipt → Event `payment.captured`. Cashier screen updates in < 3 s (Socket.IO); no screenshot verification needed.
   - **Card via POS**: amount pushed to terminal (provider cloud API/SDK) → customer taps → terminal callback → intent `paid` (card network, last4, auth code, RRN) → receipt.
   - **Payment link**: generate (Razorpay Payment Links; expiry, partial allowed?, reminder) → send via EN-009 WhatsApp/SMS/email → patient pays remotely → webhook → receipt.
   - **Checkout (portal/app/website/kiosk)**: hosted checkout/Standard Checkout with order id → success callback + webhook (webhook is source of truth) → receipt.
2. **Idempotency**: every intent keyed by (bill/advance ref + attempt); webhooks idempotent by payment id; late/duplicate webhooks ignored; if payment captured after intent expired → auto-match to bill outstanding or park in `unapplied` for cashier resolution.
3. Timeout/failure: intent `expired/failed` with reason (bank decline, user cancelled) → cashier retries or switches method; partial payments allowed for advances only.
4. Split by payer: single bill may collect patient share via gateway and payer share via credit (EN-002).

### 3.3 Refunds
1. Refund request from OP-005/NC-001 (cancellation, excess deposit, discount post-payment) → refund to **source instrument** by default (RBI-friendly; card/UPI original), amount ≤ captured − prior refunds; approval per matrix (EN-038: cashier ≤ ₹2000 self, else supervisor; > ₹25k Finance) → gateway refund API (normal/instant) → `pay_refunds` status `initiated → processed/failed` via webhook (`refund.processed`) → credit note/receipt reversal (NC-001) → patient notified with ARN → Event `payment.refunded`.
2. Refund of cash-paid bills goes via NC-001 cash/bank transfer (not EN-010) but recorded for recon; cross-instrument refunds (to bank account via payout) only with Finance approval (`payments.payouts` adapter).
3. Chargebacks/disputes: webhook → `pay_disputes` → evidence upload (bill, consent) → outcome → ledger.

### 3.4 Reconciliation & ledger sync
1. **Daily**: fetch settlements (Razorpay Settlements/Reports API or file) → `pay_settlements` (settlement id, UTR, amount, fees, tax, date) with line items (payment/refund ids) → **3-way match**: gateway payment ↔ HMS receipt (NC-001) ↔ settlement line; then settlement UTR ↔ bank statement credit (NC-009 bank recon) → exceptions: captured-no-receipt (auto-create/park), receipt-no-payment (cashier fraud check), amount mismatch, fee variance vs MDR contract, missing settlement (T+1/T+2 SLA breach), refunds pending → `pay_recon_exceptions` with owner & status.
2. **Ledger sync** to NC-009: receipts posted at capture (Dr Gateway Receivable / Cr Patient AR or Advance); on settlement: Dr Bank, Dr Gateway Fees, Dr GST on fees, Cr Gateway Receivable; refunds mirror; convenience fee revenue if charged; journals idempotent by settlement id; period lock respected.
3. Cashier shift closure (NC-001) shows digital collections by method with gateway-verified totals; variance flagged.

### 3.5 EMI / BNPL (`payments.emi`) & AutoPay
- Offer card EMI/cardless EMI/BNPL (via gateway offers/affordability APIs) for large bills (IP deposits, packages) with disclosed interest/subvention (hospital-borne subvention config); **UPI AutoPay/mandates** (`payments.autopay`) for instalment plans (RC-008 quotation → schedule) with pre-debit notifications; NC-009 accounting for subvention cost.

### 3.6 International (`payments.international`)
- Stripe/Razorpay international for medical tourism (multi-currency presentment, FX at settlement, GST/LRS notes), passport-based KYC per PG rules, SWIFT/TT recorded manually.

### 3.7 Exceptions & offline
- Gateway outage: fallback to static QR (manual UTR entry with later matching), cash/card standalone; intents queued; IT alert.
- Webhook delayed > 5 min: cashier "verify status" pulls payment status via API (poll); never marks paid without gateway confirmation.
- Duplicate payment (patient scanned twice/paid link and cash): auto-detect → refund workflow prompt.
- Wrong amount received on static QR: park as unapplied → apply/refund.

## 4. Data Model (schema `billing`, prefix `pay_`)
- `pay_gateway_accounts` — id, hospital_id, branch_id?, legal_entity_id, provider (razorpay/phonepe/payu/cashfree/stripe/bank_pg), mode (sandbox/live), key_id, secret_ref (Vault), webhook_secret_ref, settlement_bank_account_id (NC-009), methods jsonb, mdr_schedule jsonb, convenience_fee_policy jsonb, currency_default, active.
- `pay_terminals` — id, hospital_id, branch_id, provider, tid, serial, counter_id, workstation_id, mode (cloud_push/standalone), status, last_seen.
- `pay_intents` — id, hospital_id, branch_id, gateway_account_id, provider_order_id, kind (bill/advance/deposit/link/kiosk/portal/website/mandate), ref_type (bill/advance/quotation/invoice), ref_id, patient_id?, payer_name/phone (masked), amount, currency, method_hint (upi_qr/pos/link/checkout/any), status (created/pending/paid/partially_paid/expired/failed/cancelled/unapplied), qr_id, qr_image_url, link_id, link_url, terminal_id, expires_at, created_by, attempts, meta jsonb; UNIQUE(gateway_account_id, provider_order_id); index (hospital_id, status, created_at desc), (ref_type, ref_id).
- `pay_payments` — id, intent_id, provider_payment_id UNIQUE, method (upi/card/netbanking/wallet/emi/bnpl/international), instrument jsonb (vpa/bank/card_network/last4/issuer masked), amount, fee, tax, captured_at, rrn/utr, status (authorized/captured/failed/refunded/partially_refunded/disputed), receipt_id (NC-001), error_code/desc, raw_ref.
- `pay_refunds` — id, payment_id, amount, reason_code, requested_by, approval_id, provider_refund_id, speed (normal/instant), status (requested/approved/initiated/processed/failed), arn, processed_at, credit_note_id/receipt_reversal_id.
- `pay_links` — id, intent_id, provider_link_id, short_url, expires_at, reminders jsonb, sent_via (whatsapp/sms/email), status.
- `pay_webhook_events` — id, provider, event_id UNIQUE, type, payload jsonb, signature_ok, received_at, processed_at, status, error; partitioned monthly.
- `pay_settlements` — id, gateway_account_id, provider_settlement_id UNIQUE, utr, amount, fees, tax, settled_at, status (fetched/matched/posted/exception), journal_id; `pay_settlement_lines` (settlement_id, entity_type payment/refund/adjustment, provider_entity_id, amount, fee, tax, matched_receipt_id, status).
- `pay_recon_exceptions` — id, type (captured_no_receipt/receipt_no_payment/amount_mismatch/fee_variance/missing_settlement/refund_pending/unapplied/duplicate), refs jsonb, amount, owner_id, status, notes, resolved_at.
- `pay_disputes` — payment_id, provider_dispute_id, amount, reason, phase, evidence_files[], due_at, outcome.
- `pay_mandates` — patient_id, provider_token/mandate_id, max_amount, frequency, schedule jsonb, status; `pay_mandate_debits`.
- `pay_ledger_postings` — entity (payment/refund/settlement/fee), entity_id, journal_id (NC-009), posted_at, idempotency_key UNIQUE.

### 4.1 Adapter interface (`packages/payments`)
| Method | Purpose | Razorpay mapping | Notes |
|---|---|---|---|
| `createOrder(intent)` | server order for checkout/QR/POS | Orders API | returns provider order id |
| `createQr(intent)` | dynamic single-use UPI QR | QR Codes API (`usage=single_use`, `fixed_amount`, `close_by`) | image URL/payload for local render |
| `createLink(intent, opts)` | payment link with expiry/reminders | Payment Links API | short URL, notify via EN-009 not provider |
| `pushToTerminal(intent, tid)` | POS amount push | Razorpay POS / Ezetap / Pine Labs cloud API | callback or poll |
| `getPayment(id)` / `capture(id)` | status pull / capture (auto-capture default) | Payments API | used by "verify" |
| `refund(paymentId, amount, speed)` | refunds | Refunds API | normal/instant |
| `listSettlements(date)` / `settlementRecon(id)` | settlement lines | Settlements + Reports API | daily job |
| `verifyWebhook(headers, body)` | signature | HMAC-SHA256 with webhook secret | mandatory |
| `normaliseEvent(payload)` | map to internal event set (`payment.captured|failed|refund.processed|dispute.created|settlement.processed|qr.credited|link.paid`) | | provider-agnostic |
| `createMandate()` / `debitMandate()` | UPI AutoPay | Subscriptions/Mandates | `payments.autopay` |
| `createDisputeEvidence()` | chargebacks | Disputes API | |
Adapters: `razorpay`, `phonepe`, `payu`, `cashfree`, `stripe`, `bank_pg_hdfc`, `bank_pg_icici`, `pos_pinelabs`, `pos_ezetap`; conformance test-suite (sandbox) required before enabling an adapter for a tenant.

### 4.2 Intent state machine
`created → pending (QR shown / link sent / POS pushed) → paid | partially_paid (advances only) | failed | expired | cancelled`; `paid` after intent expiry or without intent → `unapplied` until cashier applies/refunds. Payment: `authorized → captured → (partially_)refunded | disputed`. Refund: `requested → approved → initiated → processed | failed`.

## 5. Business Rules & Validations
- Amount for a bill intent = outstanding (or advance amount); intent expiry 15 min (QR) / configurable for links (default 72 h with reminders at 24 h/1 h); one open QR/POS intent per bill at a time (cancel to create new).
- Payment marked paid only on verified webhook or authenticated API status pull; UI callbacks are hints; signature verification mandatory (HMAC SHA256); replay window 5 min; event ids unique.
- Receipt auto-creation is atomic with payment record (same transaction) and uses NC-001 numbering (gapless); receipt method/instrument fields populated from gateway data; no manual editing of gateway-sourced amounts.
- Refund ≤ captured − refunded; approvals by amount slabs; refund to source only unless Finance override; refund of settled-but-disputed payment blocked; refund SLA tracking (RBI: failed transaction auto-reversal T+1 for UPI/cards; hospital-initiated refunds processed within 5–7 working days) with alerts.
- Convenience fee only where policy allows (never on cash-equivalent categories per hospital rule; GST applied); disclosed before checkout.
- No card data touches HMS servers (hosted/iframe/POS only); tokens (network) stored only as provider references.
- Recon: settlement must match sum(lines) − fees − tax; period-locked journals cannot be reposted; exceptions older than 3 days escalate to Finance head.
- Sandbox intents flagged and never create real receipts (separate test hospital or `mode` guard).
- Retention: payment metadata 8 years (financial), webhook payloads 1 year; PII masked (last4 only).

## 6. API Surface (`/api/v1/payments`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET/POST/PATCH | /gateway-accounts ; POST /:id/test ; POST /:id/promote-live | config | payments.gateway.configure (IT + Finance dual) | secrets masked |
| GET/POST/PATCH | /terminals ; POST /terminals/:id/ping | POS | payments.terminal.configure | |
| POST | /intents {refType, refId, amount, method, channel} | create order/intent (+QR/link/POS push) | payments.intent.create (Cashier/Billing/Front office; system for portal) | Idempotency-Key |
| GET | /intents/:id ; POST /intents/:id/cancel ; POST /intents/:id/verify (pull status) ; POST /intents/:id/resend-link | intent ops | payments.intent.read/create | |
| GET | /intents?status&counter&from&to | pending/paid list | payments.intent.read | cursor |
| POST | /pos/:terminalId/push {intentId} ; POST /pos/callback (provider) | terminal | payments.intent.create ; provider auth | |
| POST | /webhooks/:provider | webhooks | signature | idempotent |
| GET | /payments?from&to&method&status ; GET /payments/:id | payments | payments.payment.read | |
| POST | /payments/:id/refunds {amount, reason} ; POST /refunds/:id/approve ; GET /refunds | refunds | payments.refund.request / payments.refund.approve (slabbed) | |
| POST | /apply-unapplied {paymentId, refType, refId} | resolve unapplied | payments.recon.manage | |
| POST | /settlements/fetch?date ; GET /settlements ; GET /settlements/:id/lines ; POST /settlements/:id/post | recon & posting | payments.recon.manage / payments.ledger.post | idempotent |
| GET/PATCH | /recon/exceptions | exceptions | payments.recon.manage | |
| GET/POST | /disputes ; POST /disputes/:id/evidence | disputes | payments.dispute.manage | |
| POST | /mandates ; GET /mandates/:id ; POST /mandates/:id/debit | AutoPay | payments.mandate.manage | |
| GET | /public/checkout/:intentToken (portal/website/kiosk hosted page) | pay page | public signed | |
| GET | /reports/collections?by=method|counter|branch ; /reports/refunds ; /reports/fees ; /reports/recon-status | reports | payments.report.read | MV |

## 7. Domain Events (outbox)
- `payment.intent.created|expired|cancelled|link_sent`.
- `payment.captured` → NC-001 (receipt), OP-005/IP-005 (bill status), EN-009 (e-receipt), EN-006 (queue payment gate), EN-002 (patient share), PE-001.
- `payment.failed` → cashier UI, patient notice (link).
- `payment.unapplied` → cashier task.
- `payment.refund.requested|approved|initiated|processed|failed` → NC-001 (reversal/credit note), EN-009 (patient ARN), NC-009.
- `payment.settlement.fetched|matched|posted|exception` → NC-009 bank recon, Finance alerts.
- `payment.dispute.opened|resolved`, `payment.mandate.created|debited|failed`.
- `payment.gateway.down|recovered` → IT, cashier banner.

## 8. Screens
- **Cashier Collect panel** (in NC-001/OP-005; desktop + customer display): method tabs (UPI QR / Card POS / Link / Cash), big QR with countdown & amount, live status ("waiting… / paid ✓ UTR"), POS push button with terminal status, "verify" pull, switch method; shortcuts `F7` QR, `F8` POS, `F6` link, `Esc` cancel intent. Real-time WS; offline: static QR + manual UTR entry (marked pending verification).
- **Customer-facing display / kiosk pay screen** (second monitor/tablet/kiosk): amount, QR, instructions in local language, success animation, e-receipt QR.
- **Payment Links desk** (desktop): create/send/track links (advances, patient share), reminders, expiry, resend; filters.
- **Refunds workspace** (desktop): requests queue with approvals, source instrument, ARN, SLA timers.
- **Reconciliation console** (desktop, Finance): settlements list, 3-way match grid (green/amber/red), exceptions with owners, fee variance, post-to-ledger button; `Ctrl+M` auto-match; export.
- **Gateway Admin** (desktop): accounts (sandbox/live), webhooks health, terminals map, MDR schedules, convenience fee policy, EMI offers config.
- **Patient pay page** (phone): hosted checkout, methods, receipt download; portal payment history (PE-001).
- Empty/error states: "gateway unavailable — use static QR/cash" banner; retry.

## 9. Integrations
- Razorpay (Orders, Payments, QR Codes, Payment Links, Refunds, Settlements, Disputes, Payouts (optional), POS via Razorpay POS/Ezetap API), PhonePe PG, PayU, Cashfree, HDFC SmartGateway/ICICI Eazypay, Stripe (intl), Pine Labs Plutus cloud POS; UPI intent/deep links for app; EN-009 for link delivery; NC-001 receipts; NC-009 journals & bank statements; EN-012 website checkout; EN-034 kiosk; PE-001 portal; RC-008 instalment schedules; Vault secrets; webhook via EN-017 with DLQ.

## 10. Reports & Analytics
- Collections by method/counter/branch/day, digital share %, success/failure rates & reasons, average QR pay time, refunds (count/amount/SLA), fees & MDR variance, settlement ageing (T+n), recon exception ageing, unapplied balances, chargebacks, EMI/subvention cost, link conversion (sent → paid), kiosk/portal collections. MVs `analytics.mv_pay_daily`.

## 11. Notifications
- Patient: e-receipt (WhatsApp/SMS with PDF link), payment link (with reminders), refund initiated/processed (ARN), mandate pre-debit notice, payment failed.
- Cashier: paid confirmation (UI + chime), unapplied payment tasks; Finance: settlement missing/exception ageing, fee variance, disputes due; IT: gateway/webhook down, signature failures.

## 12. Permissions (RBAC keys)
`payments.gateway.configure` (IT Admin + Finance dual) · `payments.terminal.configure` (IT, Branch Admin) · `payments.intent.create` (Cashier, Billing, Front office, Insurance desk; system) · `payments.intent.read` · `payments.payment.read` (Cashier own counter; Finance all) · `payments.refund.request` (Cashier, Billing) · `payments.refund.approve` (Supervisor ≤ ₹25k; Finance head above; requester ≠ approver) · `payments.recon.manage` (Accountant) · `payments.ledger.post` (Accountant; ≠ recon manager optional) · `payments.dispute.manage` (Finance) · `payments.mandate.manage` (Billing lead) · `payments.report.read` (Finance, Admin).

## 13. Non-functional
- 2000 beds: ~8000 digital transactions/day, peaks 20/s at OPD start; intent creation p95 < 400 ms (incl. gateway call), webhook → receipt → UI < 3 s; recon job for 10k lines < 2 min.
- Idempotent everywhere (intents, webhooks, postings); exactly-once receipt creation under retries (unique provider payment id + tx).
- Security: secrets in Vault, webhook signatures, TLS, no card data, PII masked, audit on refunds/config; PCI SAQ-A scope maintained.
- Availability: gateway outage fallback path; queues durable; multi-provider failover manual (policy).
- Accessibility: QR with amount text and audio confirmation option at counters; i18n pay pages.

## 14. Acceptance Criteria
1. Given a finalised OP bill of ₹1,250, when the cashier selects UPI QR, then a single-use dynamic QR for exactly ₹1,250 is displayed within 1 s and expires in 15 min.
2. Given the patient pays the QR, when the `payment.captured` webhook arrives, then a receipt is created once (idempotent on payment id), the bill shows paid, and the cashier UI updates within 3 s without manual verification.
3. Given a duplicate webhook for the same payment, when processed, then no second receipt is created and the event is logged as duplicate.
4. Given a webhook with an invalid signature, when received, then it is rejected (401), logged, and IT is alerted after 5 failures.
5. Given a POS terminal push of ₹5,000, when the card is approved, then payment shows card network/last4/RRN and the receipt is auto-generated.
6. Given a payment link sent for ₹20,000 deposit, when paid remotely, then the advance receipt is created and the patient gets an e-receipt; unpaid links get reminders at configured intervals and expire.
7. Given a refund request of ₹3,000 by a cashier with limit ₹2,000, when submitted, then it routes to supervisor approval; on approval the refund goes to the source instrument and the ARN is sent to the patient.
8. Given a captured payment with no matching intent (static QR), when detected, then it is parked as unapplied and a cashier task allows applying it to a bill or refunding.
9. Given the daily settlement fetch, when 500 payments settle, then lines match receipts, fees are posted to NC-009 with GST, and unmatched items appear as exceptions with owners.
10. Given a settlement already posted, when re-posted, then no duplicate journal is created (idempotency key).
11. Given the gateway is down, when the cashier opens the collect panel, then a banner offers static QR/cash with manual UTR entry marked pending verification, and later matching resolves it.
12. Given a sandbox account, when a payment is captured, then no live receipt or journal is created and the intent is flagged test.
13. Given a dispute webhook, when received, then a dispute record with due date is created and Finance is notified to upload evidence.
14. Given an EMI offer configured with hospital-borne subvention, when a patient chooses EMI, then the disclosed schedule is shown and subvention cost is recorded for NC-009.

## 15. Enhancements / Later phases
- UPI AutoPay/mandates for instalment plans (`payments.autopay`), international multi-currency (`payments.international`), payouts (refund to bank account, doctor payouts NC-034), Bharat QR/static-QR auto-matching via bank APIs, soundbox integration for audio confirmation, tap-to-phone (SoftPOS) on Android for bedside collections, WhatsApp Pay/UPI in-chat (EN-009), BNPL partners, tokenised card-on-file for portal, cash-recycler/ATM integration at kiosk, dynamic MDR optimisation across providers, fee reconciliation automation with provider invoices.

## 16. Open Questions for the Hospital
1. Gateway account(s) in use (Razorpay/others), legal entities per branch, settlement bank accounts, MDR contracts?
2. POS terminals brand/model per counter; cloud-integrated or standalone; count?
3. Convenience fee policy (who bears MDR); is fee shown to patient?
4. Refund policy: to source only? approval slabs; instant refund allowed?
5. Payment links: expiry, reminders, partial payments for deposits?
6. EMI/BNPL offerings desired? Subvention borne by hospital?
7. Kiosk/portal payments in Phase 1 or later; international patients volume?
8. Accounting mapping for gateway receivable, fees, GST on fees, and period-lock policy (NC-009).
