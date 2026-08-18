# PHASE 5 — BILLING, TARIFFS & REVENUE CYCLE FOUNDATION

Phases 0–4 complete. Charges have been accumulating as "intents". Now they become money — correctly, once, with tax.

## Read first
`CLAUDE.md`, `docs/PROGRESS.md`, then: **RC-003** (tariff — build this FIRST), **OP-005** (OP billing),
**EN-010** (payment gateway), **OP-023** (packages), **EN-002** (insurance/TPA), **RC-002** (pre-auth),
**RC-007** (government schemes), **RC-008** (estimator), **RC-006** (leakage), **NC-034** (doctor payouts),
**NC-001** (cash counter — extend), **EN-016** (e-sign, optional), plus `docs/04-security-compliance.md` §1 tax rows.

Plan first; wait for "go". **Build order inside the phase: RC-003 → OP-005 → EN-010 → OP-023 → EN-002/RC-002 →
RC-007 → RC-008 → RC-006 → NC-034.**

## Goal

Every service delivered is priced by exactly one authority, billed once, taxed correctly, collectible by any
payment method, refundable with control, claimable from any payer, and auditable to the rupee.

## Deliverables

### 5.1 Tariff engine (RC-003) — the pricing authority
Service master link (EN-027), **rate plans**: self-pay, corporate (per company), TPA/insurer (per payer per plan),
government scheme (PMJAY/CGHS/ECHS/ESIC/state), staff/concession, camp. Bed-class differential pricing. Effective-
dated versions with approval (EN-038) and **no overlapping published versions** (enforce with a DB exclusion
constraint). Package rates. Negotiated discount rules. Bulk revision tooling with preview and rollback.
A single `resolve(service, payer, class, date, branch)` API that **every** bill line calls — and which returns
`MISSING_RATE` (blocking) rather than zero when a rate is absent.

### 5.2 OP billing (OP-005)
Charge capture from all Phase 1–4 events (consultation, vitals-room procedures, lab, radiology, pharmacy,
procedures, day care), consolidated visit bill, itemised and grouped views, **GST handling** (tax invoice vs bill
of supply, exempt healthcare services vs taxable items like pharmacy retail and cosmetic procedures, HSN/SAC,
CGST/SGST/IGST split, e-invoice threshold awareness), discount slabs with approval matrix and mandatory coded
reasons, concession/charity billing, advance adjustment, **credit notes and refunds with maker-checker**,
bill cancellation with reversal accounting (never delete), reprint with watermark, day-end revenue MIS by
department/doctor/service/payer.

### 5.3 Payments (EN-010 + NC-001 extension)
Cash, card (POS integration), **UPI dynamic QR**, net banking, wallets, payment links (WhatsApp/SMS), cheque with
clearing status, corporate credit, insurance credit. Razorpay primary with an adapter interface for PayU/PhonePe/
Cashfree/Stripe. Webhook-driven confirmation with idempotency, auto-reconciliation against settlement files,
mismatch queue, refunds through the original instrument, ledger sync hooks for NC-009 (Phase 9).
Enforce **§269ST** cash limits. Every payment is idempotent — prove it with a replayed webhook test.

### 5.4 Packages (OP-023)
Package definition (inclusions, exclusions, caps, validity, room class), booking with advance, activation and
consumption tracking against limits, **variance tracking (actual vs package)** with alerts at 80 %/100 %,
excess-charge approval before billing beyond the package, package profitability report.

### 5.5 Insurance & TPA (EN-002 + RC-002)
Payer/TPA/insurer master, empanelment records, plan and tariff mapping, ROHINI codes, policy capture and
eligibility check, **pre-authorisation**: request assembly with clinical justification templates, document
checklist, submission (portal/email/API), status tracking, query and enhancement rounds, approved amount →
credit limit that flows into billing, emergency/retrospective pre-auth, expiry. Cashless vs reimbursement paths.
Claim-pack assembly is prepared here and completed in Phase 11 with NHCX.

### 5.6 Government schemes (RC-007)
PMJAY/Ayushman package master (HBP), beneficiary verification, scheme-specific workflow and blocking rules
(**no cash collection from a scheme beneficiary — hard block at every collection point**), CGHS/ECHS/ESIC and
state schemes, scheme claim formats, reconciliation and shortfall tracking.

### 5.7 Estimator, leakage, payouts (RC-008, RC-006, NC-034)
- **Cost estimator**: procedure/package-based estimate with payer awareness, co-pay calculation, room-class
  scenarios, printable/shareable with validity, conversion tracking, estimate-vs-actual learning. (NABH cost
  transparency requirement.)
- **Revenue leakage audit**: reconcile orders vs charges (tests performed vs billed, consumables issued vs billed,
  doctor visits, procedure charges), unbilled/underbilled detection, **pre-discharge missed-charge check**,
  discount and refund audit, recovered-amount dashboard. Never auto-post — propose to a human.
- **Doctor payouts**: fee-share rules by service/payer/slab, retainer/visiting models, TDS (194J), payout
  statements with dispute workflow, and the **NMC anti-kickback guard** (no per-referral payment to registered
  practitioners is representable in the schema).

## Constraints & watch-outs
- **One charge, one bill line, once.** Charge intents carry an idempotency key from the source event; a replayed
  event must never double-bill. Write the test first.
- Money is `numeric(14,2)`; rounding rules stated once and applied everywhere; totals recomputed server-side and
  never trusted from the client.
- Bills, receipts and credit notes use **gapless numbering** per branch per financial year.
- Reversals are entries, not deletions. The audit must explain every rupee.
- A blocked rate (`MISSING_RATE`) stops the bill and raises a task — silence here becomes revenue leakage.

## Exit gate
1. A full OP visit (consult + 3 lab tests + X-ray + 4 drugs) produces one correct bill; every line traces to its
   clinical event; GST is correct for a mixed exempt/taxable bill; the invoice prints and passes a GST review.
2. Replay every charge event 3× → the bill is unchanged (idempotency proven).
3. Pay by split cash + UPI + card; a webhook replay does not double-credit; settlement reconciliation matches.
4. Apply a 25 % discount → approval required, reason coded, audit shows requester and approver.
5. Refund a paid bill → maker-checker, credit note, money returned by the original instrument, ledger balanced.
6. A scheme beneficiary cannot be charged cash anywhere in the system (test all collection points).
7. Pre-auth submitted, queried, enhanced and approved → credit limit visible on the patient's account.
8. Estimator produces an estimate; after the visit, estimate-vs-actual variance is reported.
9. Leakage audit finds a deliberately unbilled test before discharge clearance.
10. Financial integrity test suite passes: Σ bill lines = bill total; Σ receipts − refunds = collections;
    no orphan charges; no bill without a payer; numbering has no gaps under 50 concurrent requests.
11. Previous gates green; `docs/PROGRESS.md` and `docs/DECISIONS.md` updated (tax and rounding decisions recorded).
