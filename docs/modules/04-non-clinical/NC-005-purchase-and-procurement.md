# NC-005 — Purchase & Procurement (Indent → RFQ → Comparative → PO → GRN → 3-Way Match, Rate Contracts)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Non-Clinical / ERP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Module ID       | NC-005                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Phase           | 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Priority        | P1 (indent/PO/GRN core needed with Phase 4 stores; RFQ/comparative/rate contracts complete in Phase 4; vendor portal Phase 9/10)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Depends on      | NC-006 (item master, stores, GRN stock posting, reorder suggestions), NC-021 (vendor master, ratings, blacklist, vendor portal), NC-022 (budget check capex/opex), EN-038 (approval matrix, SLA, escalation), NC-009 (AP invoice, 3-way match posting, TDS, payments), NC-002 (capital asset capitalisation from GRN), NC-007 (consignment auto-PO), OP-003/IP-014 (pharmacy indents), EN-032/EN-009 (RFQ/PO dispatch), EN-016 (PO e-sign), EN-024 (audit), NC-011 (reports), AI-005 (demand forecasting later), EN-027 (HSN/GST masters), NC-031 (contracts)                                                                                                                                      |
| Feature flag    | `module.purchase.enabled` (sub: `purchase.rfq`, `purchase.rate_contract`, `purchase.vendor_portal`, `purchase.emergency_fast_track`, `purchase.import_po`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Primary roles   | Purchase Officer (45), Purchase Manager/Head, Stores In-charge (44, GRN), Pharmacy In-charge (32, drug purchase), Accounts Payable (46)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Secondary roles | HOD/Indenter (5, indents & approvals), Hospital/Branch Admin (2/3, PO approvals), Biomedical (48, technical evaluation of equipment quotes), Quality (54, QC on receipt), Finance Manager (46, budget), Vendor (63, portal), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Regulatory      | GST (input tax credit, HSN, RCM on unregistered supply, e-way bill for inter-state receipts, TDS u/s 194Q above ₹50 lakh/vendor/yr, TCS 206C(1H)), Income-tax TDS on services (194C/194J via NC-009), Drugs & Cosmetics Act (purchase only from licensed suppliers — Form 20/21 licence copies; Schedule H1/X/NDPS supplier compliance), CDSCO (UDI/import licences for devices), Legal Metrology (MRP), Customs (import PO: BoE, IGST), Companies Act (procurement policy, related-party), NABH (MMS/FMS material management SOPs, quality checks on receipt), Public procurement norms if government/PSU hospital (GeM/GFR-style comparative & tender), Cold-chain (temperature logs at receipt) |

## 1. Purpose

NC-005 runs the hospital's **procure-to-pay** front half: department indents (manual, auto-reorder, consignment), approval matrix, RFQ to vendors, quotation capture and automated comparative statement (price, delivery, quality, past performance), PO creation with terms/amendments/versions and rate-contract auto-pricing, GRN with quality check and cold-chain/expiry validation, invoice capture and **3-way match** (PO–GRN–invoice) feeding AP in NC-009, plus emergency purchase fast-track, purchase returns, budget check and vendor performance feedback. Stock posting is NC-006; payment is NC-009; vendors are NC-021.

## 2. Users & Jobs-to-be-done

- **Indenter/HOD** (desktop/phone): raise indents (item, qty, urgency, justification, budget head), track status; approve subordinate indents.
- **Purchase officer** (desktop): consolidate indents, float RFQ, enter quotations (or receive via vendor portal), generate comparative, negotiate, create PO (regular/rate-contract/blanket/emergency/import/service/capital), send to vendor, follow up deliveries, handle amendments/cancellations, returns.
- **Purchase head / admin / finance** (desktop/phone): approve POs per matrix (value bands, categories), review comparative justification when L1 not chosen, approve emergency purchases post-facto.
- **Stores/pharmacy in-charge** (desktop + scanner): GRN against PO (or without PO for emergency), QC, batch/expiry/MRP capture, accept/reject/partial, debit notes.
- **Accounts payable** (desktop): capture vendor invoice (or portal upload), 3-way match tolerance review, approve for payment, TDS/GST checks.
- **Vendor** (portal, NC-021): view RFQs, submit quotes, acknowledge POs, upload ASN/invoices, track payments.

## 3. Core Workflows

### 3.1 Purchase indent

1. **Indenter** creates indent: store/department, items (from NC-006 item master; new-item request routes to item master workflow), qty (UoM), required-by date, urgency enum(routine/urgent/emergency), justification, budget head/cost centre (NC-008), attachments (specs for capital items) → **System** shows current stock in requesting store & central store, pending POs, last purchase price/vendor, consumption avg (helps rationalise) → **budget check** (NC-022: available vs estimated value; over-budget → needs finance approval flag) → submit → approval chain (EN-038: HOD → (Medical Superintendent for clinical capital) → Purchase) → status `approved` → Event `purchase.indent.approved`.
2. **Auto-indents**: NC-006 reorder engine (`inventory.reorder.suggested`) creates draft indents (min/max/ROL/ROQ or consumption-based) for purchase review; NC-007 auto-PO for consignment usage bypasses indent.
3. **Store-fulfilment first**: if central store has stock, indent becomes a stock issue/transfer (NC-006) not a purchase; partial split.
4. Exceptions: reject with reason; amend qty by approver (audit); indent cancellation by indenter before PO.

### 3.2 RFQ & quotation (`purchase.rfq`)

1. **Purchase officer** groups approved indent lines (by category/vendor class) → RFQ (`RFQ` series): items, qty, specs, delivery location/date, terms (payment, warranty, validity), due date → sent to selected vendors (NC-021 filtered by category, active, not blacklisted; min 3 for value > threshold) via email/WhatsApp/vendor portal PDF → vendors quote: portal entry or manual entry by purchase (price/unit, GST, discount, delivery days, validity, brand/make, MOQ, freight, remarks, attachments) → sealed until due date (config) → Event `purchase.rfq.sent|quote.received`.
2. Technical evaluation for equipment/implants: Biomedical/user department scores technical compliance (spec sheet) before commercial opening (two-envelope, config).

### 3.3 Comparative statement & selection

1. **System** auto-generates comparative: per item, vendor columns with landed unit cost (price − discount + GST (ITC-aware net cost option) + freight), delivery days, warranty, past performance score (NC-021: on-time %, rejection %, rating), quality score (technical eval), rate-contract reference price, last purchase price → highlights **L1** per line and best-value → **Purchase officer** selects vendor per line (may split) with justification mandatory if not L1 → approval per matrix → Event `purchase.comparative.approved`.
2. Negotiation rounds recorded (revised quotes as versions); vendor rating algorithm inputs (VIMS enhancement) shown.

### 3.4 Purchase order

1. **Create PO** from selected quotes / rate contract / direct (within limits) / repeat order (copy previous PO with price validity check) → PO types enum(regular/rate_contract_call_off/blanket_release/emergency/capital/service/import/consignment_auto/return_replacement) → lines: item, qty, UoM, rate, discount, GST (HSN, rate; RCM flag), delivery schedule (multiple dates), tolerance %, warranty; header: vendor, ship-to store, bill-to (branch GSTIN), payment terms, freight/insurance terms, penalty/LD clause, T&C template, expected delivery, budget line → approval matrix by value/type (e.g. ≤ ₹50k purchase head; ≤ ₹5 lakh admin; > ₹5 lakh MD/committee; capital always finance) with SLA/escalation → e-sign (EN-016) → PDF → send to vendor (email/portal/WhatsApp) + acknowledgement request → Event `purchase.po.approved|sent|acknowledged`.
2. **Amendment**: qty/rate/date/terms change → new PO version (`v2`, reason, approval if value increases beyond tolerance) → vendor re-acknowledgement; **short-close** remaining qty; **cancel** (before GRN) with reason → Event `purchase.po.amended|cancelled`.
3. **Import PO** (`purchase.import_po`): currency, incoterms, LC/advance, customs (BoE, IGST, duty) added at GRN landed cost.
4. Delivery follow-up: expected vs overdue list; vendor reminders; ASN (advance shipping notice) from portal.

### 3.5 Goods receipt (GRN) & quality check

1. **Stores** selects PO (scan PO barcode/QR from vendor invoice or search) → items arriving: qty received (UoM conversion), batch, expiry, MRP, mfg date, serial/UDI (implants/equipment via GS1 parse), pack size, invoice ref/date, e-way bill, temperature log for cold-chain (accept only within range), free/bonus qty, price variance vs PO → **QC**: visual/pack integrity/expiry ≥ min shelf life (config e.g. 6 months or 75 % remaining), certificate of analysis for reagents/drugs (attach), sample check for equipment (installation → NC-002 commissioning) → decision per line accept/partial/reject (reason: damaged/short/expiry/wrong item/quality) → GRN (`GRN` series) posted → **NC-006 stock in** to receiving/quarantine location (quarantine until QC pass for drugs if config) → rejected qty → **return note/debit note** to vendor → Event `purchase.grn.accepted|rejected|partial` (payload used by NC-006 stock, NC-002 capitalisation, NC-021 vendor score, NC-009 GRN-IR accrual).
2. **GRN without PO** (emergency/consignment/free samples/returns) allowed with permission and post-facto PO/regularisation task; **over-receipt** beyond tolerance blocked unless approver override.
3. Direct delivery to department (equipment) → GRN by stores with department acknowledgement.

### 3.6 Invoice capture & 3-way match

1. Vendor invoice (portal upload/email OCR AI-003 later/manual): invoice no/date, GSTIN, lines with HSN/GST, totals, IRN/QR (e-invoice validation for B2B) → **System** matches PO ↔ GRN ↔ invoice per line: qty (invoice ≤ GRN accepted), rate (= PO ± tolerance %), tax (rate & GSTIN state logic), totals → status enum(matched/qty_mismatch/price_mismatch/tax_mismatch/no_grn/duplicate) → mismatches routed to purchase/vendor for debit note or PO amendment; matched → **approved for payment** → posted to NC-009 AP (vendor bill with due date per terms, TDS 194Q/194C flags, GST ITC eligibility, RCM) → Event `purchase.invoice.matched|disputed`.
2. Duplicate invoice detection (vendor+invoice no+FY); credit/debit notes linked; partial invoices against partial GRNs; service POs matched with service completion certificate (2-way + acceptance).

### 3.7 Rate contracts (`purchase.rate_contract`)

1. Long-term agreement: vendor, items (rate/UoM/GST, MOQ, price validity, escalation clause), period, max qty/value, delivery SLA, penalty → approval → **auto-applied** on PO for those items (call-off POs need no fresh quotes; approval matrix lighter within contract) → rate revision creates new version with effective dates; utilisation vs cap tracked; expiry alerts 60/30 days; competitive re-bid reminder → Event `purchase.rate_contract.created|revised|expiring`.

### 3.8 Emergency purchase fast-track (`purchase.emergency_fast_track`)

1. ER/OT/ICU/pharmacy raises **emergency indent** (life-saving drug/implant/oxygen) → simplified path: single approver (on-call admin via phone push) within SLA 30 min, or auto-approve up to cap (config e.g. ₹25k) → **local purchase** authority: purchase/pharmacy buys from approved local vendor (or petty cash NC-001) → GRN without PO → post-facto PO & justification within 48 h → weekly emergency purchase report to management (frequency triggers reorder-level review in NC-006) → Event `purchase.emergency.raised|regularised`.

### 3.9 Purchase returns & vendor performance

- Return to vendor (expiry, damage, recall (TR-003/OP-003), excess): return note → debit note → stock out (NC-006) → replacement PO or credit; **vendor scorecard** (NC-021 algorithm inputs from NC-005: on-time delivery %, fill rate, rejection %, price competitiveness, invoice accuracy, responsiveness) updated per GRN/invoice event.

### 3.10 Budget vs actual & analytics

- Every indent/PO/GRN carries budget line (NC-022) → committed (PO) vs actual (GRN/invoice) vs budget → over-commit alerts; purchase spend by category/vendor/department; savings vs last price; AI demand forecasting (AI-005) suggested quantities in indents (later).

### 3.11 Service & works procurement

- Service POs (AMC/CMC via NC-002, housekeeping/security contracts NC-031, consultants) with milestones/period lines; acceptance = service completion certificate/timesheet by user department; matching 2-way + acceptance; retention money & performance bank guarantees tracked; works (civil/electrical) with measurement sheets (NC-025).

### 3.12 Capital equipment procurement (with NC-002/NC-020/NC-022)

- Capex requisition (budget line NC-022, justification, utilisation projection, biomedical technical spec sheet NC-020) → technical committee evaluation (two-envelope) → demo/site-visit records → PO with installation/commissioning/training/warranty/AMC clauses & payment milestones (advance/delivery/installation) → GRN + installation report + acceptance test → NC-002 capitalisation; AERB/licence prerequisites (NC-023) checked before PO for radiology equipment.

### 3.13 Exceptions & edge cases

1. Vendor GSTIN inactive/cancelled at PO time (GSP validation) → block or RCM/unregistered path with approval.
2. Partial GRN with price different from PO (vendor revised) → GRN at PO price; invoice mismatch handled in 3-way (never silently accept new price); PO amendment if agreed.
3. Free/bonus quantities → cost spread option (unit cost reduced) or zero-cost batch (config, GST implications noted).
4. Returns after invoice posted → debit note flows to NC-009 AP against vendor ledger.
5. Indent for a non-stock/new item → item request → EN-027 governance → temporary "pending item" line until code created.
6. RFQ with no responses → extend due date or single-source with justification; repeated non-response lowers vendor score.
7. Multi-currency import invoice → exchange difference posted by NC-009 at payment; landed cost recomputed after BoE.
8. Duplicate GRN for same vendor challan → warning by challan no.; supervisor override.
9. Emergency purchase without item master → temporary generic item with post-facto mapping.

### 3.14 Configuration defaults (seed)

- Approval bands (indent: HOD; PO: ≤ ₹50k purchase head, ≤ ₹5 lakh admin, > ₹5 lakh MD/committee; capital: always finance + committee); min vendors 3 above ₹1 lakh; over-receipt tolerance 0 %; price match tolerance 2 %; min shelf life 6 months (drugs); emergency cap ₹25k; regularisation 48 h; rate-contract expiry alerts 60/30; PO validity 90 days; series `IND`, `RFQ`, `PO`, `GRN`, `PRN` (return), `VINV` per branch/FY.

## 4. Data Model (schema `inventory`, prefix `pur_`)

- **pur_indents**: id, hospital_id, branch_id, indent_no, store_id (requesting), department_id, cost_centre_id, budget_line_id?, requested_by, urgency enum(routine/urgent/emergency), required_by, justification, status enum(draft/submitted/approved/partially_approved/rejected/converted/cancelled/fulfilled_from_stock), source enum(manual/auto_reorder/consignment/project), approval_instance_id (EN-038), created_at. INDEX (hospital_id, branch_id, status, created_at desc).
- **pur_indent_lines**: indent_id, item_id, uom, qty_requested, qty_approved, qty_ordered, qty_received, stock_on_hand_snapshot, avg_consumption_snapshot, last_price, specs, status enum(pending/approved/rejected/ordered/closed).
- **pur_rfqs**: id, hospital_id, branch_id, rfq_no, title, due_at, terms jsonb, status enum(draft/sent/closed/awarded/cancelled), sealed bool, two_envelope bool, created_by; **pur_rfq_lines** (rfq_id, item_id, qty, specs, indent_line_ids[]); **pur_rfq_vendors** (rfq_id, vendor_id, sent_at, channel, viewed_at, responded_at).
- **pur_quotations**: id, rfq_id, vendor_id, quote_no, quote_date, valid_till, currency, delivery_days, payment_terms, freight, warranty, remarks, attachments, status enum(received/revised/rejected/selected/expired), version, entered_by, source enum(portal/manual); **pur_quotation_lines** (quotation_id, rfq_line_id, brand, unit_price, discount_pct, gst_rate, moq, landed_unit_cost, tech_score?, is_l1 bool, selected bool, selection_justification).
- **pur_comparatives**: id, rfq_id, generated_at, matrix jsonb (snapshot), approved_by, approved_at, status.
- **pur_rate_contracts**: id, hospital_id, vendor_id, contract_no, start_date, end_date, max_value, max_qty_rules jsonb, delivery_sla_days, penalty_terms, status enum(draft/active/expiring/expired/terminated), version, previous_id?, document_id (NC-004/NC-031); **pur_rate_contract_items** (contract_id, item_id, uom, rate, gst_rate, moq, valid_from, valid_to, utilised_qty, utilised_value).
- **pur_purchase_orders**: id, hospital_id, branch_id, po_no, version, po_type enum, vendor_id, vendor_gstin, bill_to_gstin, ship_to_store_id, currency, exchange_rate?, subtotal, discount, taxable, cgst, sgst, igst, cess, freight, other_charges, total, payment_terms, delivery_terms, incoterms?, expected_delivery, tolerance_pct, terms_template_id, rate_contract_id?, indent_ids[], rfq_id?, budget_line_id?, status enum(draft/pending_approval/approved/sent/acknowledged/partially_received/received/short_closed/cancelled/amended), approval_instance_id, esign_id, pdf_file_id, sent_at, acknowledged_at, created_by, approved_by[]. UNIQUE (hospital_id, po_no, version). INDEX (vendor_id, status), (hospital_id, branch_id, status, created_at desc).
- **pur_po_lines**: po_id, line_no, item_id, description, uom, qty, rate, discount_pct, hsn, gst_rate, taxable, tax_amount, total, delivery_schedule jsonb, qty_received, qty_rejected, qty_invoiced, tolerance_pct, warranty_months, status enum(open/partially_received/received/short_closed/cancelled), indent_line_id?, quotation_line_id?, rate_contract_item_id?, asset_capital bool.
- **pur_po_amendments**: po_id, from_version, to_version, changed_fields jsonb, reason, requested_by, approved_by, at.
- **pur_grns**: id, hospital_id, branch_id, grn_no, po_id?, po_version, vendor_id, store_id, invoice_no, invoice_date, eway_bill_no?, dc_no?, received_at, received_by, qc_by, qc_at, status enum(draft/qc_pending/accepted/partially_accepted/rejected/cancelled), landed_cost_extras jsonb (freight/customs/insurance), remarks, without_po bool, regularisation_task_id?, temperature_log_id?, attachments. INDEX (hospital_id, branch_id, received_at desc), (po_id).
- **pur_grn_lines**: grn_id, po_line_id?, item_id, uom, qty_received, qty_accepted, qty_rejected, reject_reason enum(damaged/short/expiry/wrong_item/quality/excess/other), free_qty, batch_no, mfg_date, expiry_date, mrp, unit_cost, gst_rate, serials jsonb, udi jsonb, coa_file_id?, min_shelf_life_ok bool, quarantine bool, stock_ledger_ref (NC-006), asset_ids uuid[] (NC-002).
- **pur_returns** (to vendor): id, hospital_id, return_no, vendor_id, grn_id?, reason, lines (item, batch, qty, value), debit_note_no, status enum(draft/approved/dispatched/credited/replaced), stock_ledger_ref.
- **pur_vendor_invoices**: id, hospital_id, branch_id, vendor_id, invoice_no, invoice_date, gstin, irn?, irn_verified bool, currency, subtotal, tax jsonb, total, tds_section?, rcm bool, po_id?, grn_ids[], match_status enum(pending/matched/qty_mismatch/price_mismatch/tax_mismatch/no_grn/duplicate/disputed/approved_for_payment/posted), tolerance_applied jsonb, approved_by, ap_bill_id (NC-009), file_id, source enum(portal/manual/ocr). UNIQUE (hospital_id, vendor_id, invoice_no, fy).
- **pur_invoice_match_lines**: invoice_id, po_line_id, grn_line_id, inv_qty, inv_rate, inv_tax, grn_qty, po_rate, po_tax, qty_diff, rate_diff, tax_diff, status.
- **pur_emergency_purchases**: id, hospital_id, branch_id, indent_id?, raised_by, reason, approver_id, approved_at, cap_amount, vendor_id, amount, grn_id?, po_id? (post-facto), regularised_at, status.
- **pur_terms_templates**, **pur_approval_matrix** (via EN-038 config: type, value bands, roles), **pur_settings** (tolerances, min vendors for RFQ, thresholds).
- RLS everywhere; PO/GRN/invoice never hard-deleted; PO versions immutable; `pur_grn_lines.batch_no` links to `inventory.item_batches`.

## 5. Business Rules & Validations

- Indent lines only for active items; qty in item's purchase UoM (conversion shown); over-budget indents need finance approval; duplicate indents (same item/store open) warned.
- RFQ: minimum vendors per value band (config; e.g. ≥ 3 above ₹1 lakh) or single-source justification; blacklisted/expired-licence vendors (drug licence, GST status) excluded; sealed quotes hidden until due; L1 deviation requires justification + approver.
- PO: approval matrix by value/type; approver ≠ creator; PO to vendor with valid GSTIN (or RCM/unregistered flag); HSN/GST from item master (override audited); rate contract price auto-applied and locked unless amended contract; PO number gapless per branch/FY; PO to blacklisted vendor blocked; capital POs require capex budget line.
- Amendments create versions; value increase > tolerance re-approves; cancellation only before any GRN; short-close closes open qty.
- GRN: only against approved/sent PO (or without-PO permission); qty ≤ ordered + tolerance; expiry ≥ min shelf-life else reject/override; batch/expiry/MRP mandatory for drugs & consumables; serial/UDI mandatory for implants/equipment; cold-chain temperature within range mandatory for flagged items; QC pass before stock available (quarantine); GRN posts stock in NC-006 in the same transaction; GRN cannot be edited after posting (reversal GRN with reason).
- 3-way match tolerances: qty 0 %, price ± 2 % or ₹X (config), tax exact; invoice date ≥ GRN date (config); e-invoice IRN validation for vendors above threshold; duplicate invoice blocked; approved-for-payment requires match or documented deviation approval; posting to AP idempotent.
- Emergency purchases: cap per instance/day; post-facto regularisation within 48 h; monthly count reported; recurrent emergencies for same item trigger reorder review.
- Vendor score updated on every GRN (on-time = received ≤ expected + grace), rejection, invoice mismatch.
- TDS 194Q/TCS 206C flags derived from vendor annual turnover with hospital (NC-009 computes); MSME vendor payment-due (45 days MSMED Act) flag from NC-021 passed to AP.
- Retention: PO/GRN/invoices 8 years (GST/IT).

## 6. API Surface (`/api/v1/purchase`)

| Method                       | Path                                                                                                      | Purpose                    | Permission                            | Idem                                    | Pag                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------- | --------------------------------------- | ----------------------------------------- |
| GET/POST                     | /indents ; GET /indents/{id} ; POST /indents/{id}/(submit                                                 | approve                    | reject                                | cancel                                  | amend)                                    | indents                                       | inventory.indent.create/.approve/.read | Y         | cursor            |
| POST                         | /indents/consolidate                                                                                      | group lines → RFQ/PO draft | inventory.purchase.rfq                | Y                                       | –                                         |
| GET/POST                     | /rfqs ; POST /rfqs/{id}/(send                                                                             | close                      | cancel)                               | RFQ                                     | inventory.purchase.rfq                    | Y                                             | cursor                                 |
| POST                         | /rfqs/{id}/quotations ; PATCH /quotations/{id} ; POST /quotations/{id}/tech-score                         | quotes                     | inventory.purchase.quote / .tech_eval | Y                                       | –                                         |
| GET                          | /rfqs/{id}/comparative ; POST /rfqs/{id}/comparative/select, /approve                                     | comparative                | inventory.purchase.compare / .approve | Y                                       | –                                         |
| GET/POST                     | /rate-contracts ; POST /rate-contracts/{id}/(approve                                                      | revise                     | terminate)                            | rate contracts                          | inventory.rate_contract.manage / .approve | Y                                             | cursor                                 |
| GET/POST                     | /pos ; GET /pos/{id} ; POST /pos/{id}/(submit                                                             | approve                    | reject                                | send                                    | acknowledge                               | amend                                         | short-close                            | cancel)   | PO lifecycle      | inventory.po.create / .approve / .send / .amend / .cancel | Y                         | cursor |
| GET                          | /pos/{id}/pdf, /pos/{id}/versions                                                                         | documents                  | inventory.po.read                     | –                                       | –                                         |
| GET                          | /pos/pending-delivery?vendor=&overdue=true                                                                | follow-up                  | inventory.po.read                     | –                                       | cursor                                    |
| POST                         | /grns ; POST /grns/{id}/(qc                                                                               | post                       | reverse) ; GET /grns                  | receipts                                | inventory.grn.create / .qc / .post        | Y                                             | cursor                                 |
| POST                         | /returns ; POST /returns/{id}/(approve                                                                    | dispatch)                  | vendor returns                        | inventory.purchase_return.manage        | Y                                         | cursor                                        |
| POST                         | /invoices ; GET /invoices?match_status= ; POST /invoices/{id}/(match                                      | resolve                    | approve-payment                       | dispute)                                | 3-way match                               | inventory.invoice.capture / .match / .approve | Y                                      | cursor    |
| POST                         | /emergency ; POST /emergency/{id}/(approve                                                                | regularise)                | fast-track                            | inventory.purchase.emergency / .approve | Y                                         | cursor                                        |
| GET                          | /budget-check?item=&qty=&budget_line=                                                                     | NC-022 proxy               | inventory.indent.create               | –                                       | –                                         |
| GET                          | /reports/(spend                                                                                           | vendor-performance         | price-history                         | pending-indents                         | po-status                                 | grn-register                                  | match-exceptions                       | emergency | budget-vs-actual) | reports                                                   | inventory.purchase.report | –      | –   |
| Vendor portal (NC-021 scope) | GET /vendor/rfqs, POST /vendor/quotes, POST /vendor/pos/{id}/ack, POST /vendor/asn, POST /vendor/invoices |                            | vendor.*                              | Y                                       | cursor                                    |

## 7. Domain Events (outbox)

- `purchase.indent.submitted|approved|rejected|cancelled` → EN-037 approvers, NC-006 (reserve/fulfil from stock), NC-022 (soft commit).
- `purchase.rfq.sent`, `purchase.quote.received`, `purchase.comparative.approved` → vendor notifications (NC-021), audit.
- `purchase.po.approved|sent|acknowledged|amended|short_closed|cancelled` {po_id, vendor, lines, value, budget_line} → NC-022 (commitment), NC-006 (expected receipts), NC-021 portal, NC-009 (commitments report), EN-032/EN-009.
- `purchase.grn.accepted|partial|rejected` {grn_id, po_id, lines with batch/expiry/cost/qty} → NC-006 (stock in, quarantine), NC-002 (capital assets), NC-009 (GRN-IR accrual), NC-021 (delivery score), NC-007 (consignment stock-in when type consignment).
- `purchase.return.dispatched` → NC-006 stock out, NC-009 debit note.
- `purchase.invoice.matched|disputed|approved_for_payment` {invoice_id, ap_bill} → NC-009 AP, NC-021 (invoice accuracy score), vendor portal.
- `purchase.rate_contract.expiring|revised` → EN-037, NC-021.
- `purchase.emergency.raised|regularised` → admin dashboards, NC-006 reorder review.
- Consumes: `inventory.reorder.suggested` (NC-006), `consignment.usage.recorded` (NC-007 → auto-PO), `vendor.blacklisted|licence.expired` (NC-021 → block), `budget.revised` (NC-022), `asset.commissioned` (NC-002 → close capital PO line), `finance.payment.made` (NC-009 → portal status).

## 8. Screens (UI)

- **Indent form & my indents** — desktop/phone: item search with stock/last price panel, urgency, justification, budget widget; `Ctrl+Enter` submit; offline draft on phone.
- **Purchase workbench** — desktop: tabs (pending indents, RFQs, quotes, POs awaiting approval/ack, deliveries overdue, GRN QC pending, invoice mismatches, emergency); realtime counts.
- **Comparative statement** — desktop: item × vendor grid, landed cost, L1 highlight, score badges, per-line select, justification; export PDF for approval.
- **PO editor** — desktop: header/terms, lines grid (keyboard entry, HSN/GST auto), version diff, approvals timeline, send/ack status; `Ctrl+S` save, `Ctrl+Shift+A` submit.
- **GRN screen** — desktop + barcode scanner: PO pick, scan GS1 to fill batch/expiry/serial, per-line accept/reject, temperature log, QC checklist, print GRN & shelf labels (EN-013); works on tablet at receiving dock.
- **3-way match console** — desktop: invoice vs PO vs GRN side-by-side, diff highlights, tolerance indicators, resolve actions.
- **Rate contract manager**, **Emergency purchase log**, **Approval inbox** (phone: approve with PIN), **Vendor portal** pages (NC-021).
- Empty/error states; loading skeletons; all tables server-paginated.

## 9. Integrations

- NC-006 stock posting (same transaction via service call), NC-009 AP/GL/TDS, NC-022 budget API, NC-021 vendor master/portal/scores, NC-002 asset capitalisation, NC-007 consignment, EN-038 approvals, EN-016 e-sign, EN-032/EN-009 dispatch (PO/RFQ PDFs), GST e-invoice IRN verification API (GSP via EN-017), e-way bill lookup, GS1 barcode parsing (EN-013), OCR invoice capture (AI-003 later), GeM/tender portals (manual attachment), bank/UPI vendor payments in NC-009.

## 10. Reports & Analytics

- Pending indents ageing, indent-to-PO cycle time, RFQ response rate, comparative savings (L1 vs awarded, vs last price), PO register/status, delivery performance (on-time %), GRN register & rejections, price history per item, vendor performance scorecard, rate contract utilisation, invoice match exceptions & AP ageing (with NC-009), emergency purchase frequency/value, budget vs committed vs actual by department, spend cube (category/vendor/branch/month), ITC summary. Read models: `analytics.purchase_spend_monthly`, `analytics.vendor_performance`, `analytics.po_cycle_times`.

## 11. Notifications

- Approvers: indent/PO/comparative pending (push/email, SLA reminders, escalation); indenters: status changes; vendors: RFQ, PO, amendment, payment advice (email/WhatsApp/portal); stores: expected deliveries today, overdue; AP: invoices to match; management: emergency purchases weekly, rate contracts expiring, over-budget alerts.

## 12. Permissions (RBAC keys)

`inventory.indent.create/read/approve/cancel`, `inventory.purchase.rfq/quote/tech_eval/compare/approve`, `inventory.rate_contract.manage/approve`, `inventory.po.create/read/approve/send/amend/cancel/short_close`, `inventory.grn.create/qc/post/reverse`, `inventory.grn.without_po`, `inventory.purchase_return.manage`, `inventory.invoice.capture/match/approve`, `inventory.purchase.emergency/approve`, `inventory.purchase.report`, `inventory.purchase.configure`, `inventory.purchase.export`. ABAC: `amount_limit` on approvals; `own_department_only` for indenters/HOD; SoD creator ≠ approver, GRN poster ≠ PO creator (config), invoice approver ≠ GRN poster.

## 13. Non-functional

- Volumes: 3,000 indents/month, 1,500 POs/month, 4,000 GRNs/month, 5,000 invoices/month, 2,500 vendors, 40k items; comparative generation < 2 s for 200 lines × 8 vendors; GRN post < 300 ms per 50 lines incl. stock posting.
- Offline: indent drafts and approvals cached on phone; GRN requires online (stock consistency).
- Printing: PO/RFQ/GRN PDFs (A4), shelf/batch labels (ZPL), comparative statement.
- Security: e-signed POs, tamper-evident PDFs (sha256, QR verify), vendor portal isolated scope, audit of every approval; no PHI involved.
- i18n: INR default, multi-currency import POs; WCAG 2.2 AA; keyboard-first grids.

## 14. Acceptance Criteria

1. Given an approved indent for 100 syringes with 500 in central store, then the system offers stock issue instead of purchase and marks the line fulfilled from stock when issued.
2. Given an RFQ above ₹1 lakh sent to only 2 vendors, when closing, then the system requires a third vendor or a single-source justification approved by purchase head.
3. Given quotes from 3 vendors, then the comparative shows landed cost per line, marks L1, and selecting a non-L1 vendor without justification is blocked.
4. Given a PO of ₹6 lakh, when submitted, then it routes to MD-level approval per matrix and the creator cannot approve it; on approval a versioned, e-signed PDF is emailed to the vendor and status becomes `sent`.
5. Given a PO amendment increasing value by 8 % (tolerance 5 %), then a new version is created and re-approval is required; vendor is asked to re-acknowledge.
6. Given GRN for a drug with expiry 4 months away and min shelf life 6 months, then the line is auto-rejected unless overridden by store in-charge with reason.
7. Given a rate-contract item on a PO, then the rate auto-fills and manual change is blocked without contract amendment.
8. Given GRN accepted, then NC-006 stock increases in the receiving store (or quarantine), NC-009 receives GRN-IR accrual, and vendor on-time score updates.
9. Given an invoice with rate ₹105 vs PO ₹100 (tolerance 2 %), then match status `price_mismatch`, AP posting blocked until debit note or approved deviation.
10. Given the same vendor invoice number entered twice in a FY, then the second is rejected as duplicate.
11. Given an emergency purchase of ₹20k below cap approved by on-call admin, then GRN without PO is allowed and a regularisation task is due in 48 h; unregularised items appear in the weekly report.
12. Given a blacklisted vendor, when creating PO/RFQ, then vendor is not selectable and API returns 422.
13. Given a capital PO line received, then NC-002 draft assets are created and the PO line closes only after commissioning event.
14. Given the purchase officer opens the vendor's quote before RFQ due date on a sealed RFQ, then access is denied and audited.
15. Given a service PO for a quarterly AMC, then invoice matching requires a service completion certificate from the user department instead of a GRN, and payment approval follows the 2-way + acceptance rule.
16. Given a capital PO for a CT scanner without an AERB pre-requisite record in NC-023, then PO approval is blocked with the missing licence reason.
17. Given a vendor delivers 100 units against PO 100 with 10 free units, then GRN records free qty and either spreads cost (unit cost 100/110 of PO price) or creates a zero-cost batch per configuration, and stock shows 110.
18. Given an import PO in USD, when GRN is posted with BoE and IGST, then landed cost per unit includes duties/freight and NC-009 later posts exchange difference at payment.

## 15. Enhancements / Later phases

- From VIMS sheet: vendor rating algorithm (NC-021 scoring; Phase 4 inputs, Phase 9 full), emergency purchase fast-track (Phase 4 flag), budget vs actual tracking (NC-022 integration Phase 9), vendor self-service portal (NC-021 Phase 9/10), AI demand forecasting for procurement (AI-005 Phase 12).
- (market) Purchase return & debit-note automation, e-tendering/GeM connectors, punch-out catalogues, contract compliance alerts (maverick spend), OCR invoice capture (AI-003), auto-PO from consumption trends, supplier managed inventory (VMI) for consumables, landed-cost engine for imports, approval via WhatsApp quick actions.

## 16. Open Questions for the Hospital

1. Approval matrix (value bands, roles) for indents, POs, comparatives, emergency purchases; committee thresholds?
2. Minimum vendors per RFQ band; sealed/two-envelope required (trust/government hospitals)?
3. Tolerances: over-receipt %, price match %, min shelf life at receipt; quarantine before QC for drugs?
4. Rate contracts in force (count, items) for import; who maintains?
5. Vendor invoice channels (portal/email/paper); e-invoice IRN validation needed for which vendors?
6. Import purchases (equipment/implants) and incoterms/customs handling process?
7. Emergency purchase policy: caps, approvers, local vendors list?
8. Budget control strictness: block or warn on over-budget?
9. PO/GRN numbering formats and whether pharmacy runs a separate purchase desk?
10. Existing purchase data (open POs, rate contracts, vendor master) for migration?
