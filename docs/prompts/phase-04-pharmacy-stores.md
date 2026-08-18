# PHASE 4 — PHARMACY, STORES & SUPPLY CHAIN

Phases 0–3 complete. Prescriptions are being written but nothing is dispensed and no stock exists.

## Read first
`CLAUDE.md`, `docs/PROGRESS.md`, then: **OP-003** (pharmacy), **NC-006** (stores/inventory), **NC-005** (purchase),
**NC-007** (consignment), **NC-008** (consumption & cost centres), **NC-021** (vendors), **EN-013** (barcode),
**EN-038** (approvals), **EN-029** (dispensing-side checks), plus `docs/04-security-compliance.md` §1 rows on
CDSCO/NDPS and §7 medication safety.

Plan first; wait for "go".

## Goal

Money and medicine move correctly: every unit received, issued, dispensed, returned, expired or wasted is
traceable to a batch, a person, a cost centre and a document — and the pharmacy counter is fast enough for a
morning rush.

## Deliverables

### 4.1 Item & vendor masters (NC-006, NC-021)
Item master (drugs, consumables, implants, reagents, stationery, assets-consumables) with generic mapping, UoM and
**conversion factors (strip ↔ box ↔ case)**, HSN/SAC + GST rate, DPCO ceiling price, storage conditions,
schedule flags, reorder/min/max/safety stock, ABC-VED-FSN classification, substitute mapping, barcode/GTIN.
Vendor master with GSTIN/PAN validation, rate contracts, lead times, performance score, blacklist.

### 4.2 Stores & stock ledger (NC-006)
Multi-store/sub-store hierarchy (main store, pharmacy, ward stock, OT store, lab store, CSSD), **an append-only
stock ledger** as the single source of truth (every movement: GRN, issue, return, transfer, adjustment,
consumption, wastage, expiry write-off), batch + expiry tracking with **FEFO** enforcement, bin/rack locations,
valuation (FIFO / weighted average — configurable), physical/cycle counting with variance approval, inter-store
transfers with in-transit state, dead-stock and slow-mover reports, temperature-zone items with excursion logging
(cold chain, links EN-042 later), narcotics stored and reconciled separately.

### 4.3 Purchase to pay (NC-005)
Indent (department → HOD approval → purchase), auto-indent from reorder levels, RFQ to vendors, quotation entry,
comparative statement with scoring, PO with terms and approval matrix (EN-038), PO amendment with versions,
**GRN with quality check, partial/rejected receipt, batch & expiry capture**, purchase return, **3-way match
(PO ↔ GRN ↔ invoice)** with tolerance rules and exception queue, rate contract auto-pricing, emergency purchase
fast-track with post-facto approval, budget check (NC-022 later — leave the hook), vendor portal stub.

### 4.4 Pharmacy dispensing (OP-003)
- **Rx queue** fed by `rx.created` events from Phase 2, priority-sorted, with patient identity verification.
- Dispensing workflow: scan patient → scan each item (batch/expiry validated at scan) → quantity → partial fill
  with reason → **generic substitution under policy with prescriber approval when required** → label print
  (dosage instructions in the patient's language) → bill line creation (Phase 5 finalises; record charge intents
  now) → dispensed event back to the doctor and patient.
- Counter sales (OTC) with Schedule-H refusal rules, walk-in patient quick-create.
- **Schedule H/H1/X registers** auto-generated; **NDPS narcotic register with dual authorisation, running balance
  and physical reconciliation**; controlled-substance wastage witness workflow.
- Returns (patient return, ward return, vendor return), near-expiry management with discount/return decisions,
  expiry write-off with approval, recall handling (batch → patients dispensed → notification).
- Drug-interaction/allergy re-check at dispensing (EN-029) — the pharmacist is the second safety net.
- Pharmacy day-close: cash/credit reconciliation, stock reconciliation, exception report.

### 4.5 Consignment & implants (NC-007)
Consignment vendor agreements, stock held on consignment kept separate from owned stock, **implant items with
serial/UDI capture**, usage-triggered auto-PO and invoice reconciliation, expiry return to vendor, patient-implant
traceability handshake with TR-003 (Phase 6), monthly vendor reconciliation statement.

### 4.6 Consumption & cost centres (NC-008)
Department/ward consumption from issues and auto-deduction on billing, cost-centre mapping, budget variance alerts,
per-bed and per-procedure consumption benchmarking, wastage analytics.

## Constraints & watch-outs
- **The stock ledger never gets an UPDATE.** Corrections are new compensating entries with reason. Any code that
  mutates a ledger row fails review.
- Dispensing must work when the network is flaky: local queue, but **never** dispense without a successful batch
  validation — fail closed on stock integrity.
- Counter speed target: ≤ 45 seconds for a 4-item prescription including payment hand-off. Prove it.
- Every quantity has a UoM. Any arithmetic mixing UoMs without conversion is a bug — write property-based tests.
- GST/HSN on every item; price changes are effective-dated, never retroactive.

## Exit gate
1. Purchase cycle: indent → RFQ → comparative → PO (with approval) → GRN with batches → 3-way match → payment
   voucher stub. A quantity mismatch is caught by the match and queued as an exception.
2. Dispense a 4-item prescription in ≤ 45 seconds with barcode scanning; labels print in English + one Indian
   language; stock reduces by exact batches (FEFO respected); the doctor sees "dispensed".
3. Attempt to dispense an expired batch → blocked. Attempt to sell a Schedule H drug OTC → blocked with reason.
4. Narcotic issue requires two users; the register balances against physical count; a deliberate mismatch raises
   an alert and cannot be silently adjusted.
5. Recall a batch → the list of affected patients is produced and notifications go out.
6. Inter-store transfer, ward return, expiry write-off and a cycle count with variance all reconcile: run the
   stock-integrity test (`sum(ledger) == on_hand` for every item/batch/store) and it passes.
7. Consignment implant used → auto-PO raised → vendor reconciliation statement correct.
8. Load test: 2000 dispensing transactions/day + 500 store movements/day within `docs/07` budgets.
9. Previous gates green; `docs/PROGRESS.md` updated.
