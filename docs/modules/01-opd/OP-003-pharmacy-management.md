# OP-003 — Pharmacy Management (OP Dispensing, OTC, Inventory, Expiry, Narcotic Register, Interactions)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-003 |
| Phase | 4 |
| Priority | P0 |
| Complexity | High |
| Depends on | OP-002 (e-Rx), OP-001 (patient/visit), EN-027 (drug master, HSN, schedule class), NC-006 (stores/stock ledger, batches, FEFO), NC-005 (purchase/GRN, auto-indent), OP-005 (billing/receipts/GST), NC-001 (cash counter), EN-013 (barcode), EN-005 (label printers), EN-029 (interaction/allergy rules), EN-009 (SMS/WhatsApp), EN-002/RC-007 (credit/scheme), EN-038 (approvals), EN-042 (cold-chain sensors, later), IP-014 (IP pharmacy shares masters/ledger) |
| Feature flag | `module.pharmacy.enabled` (sub: `pharmacy.otc`, `pharmacy.narcotics`, `pharmacy.substitution`, `pharmacy.home_delivery`) |
| Primary roles | Pharmacist OP (30), Pharmacy In-charge (32), Cashier (26, if pharmacy counter separate) |
| Secondary roles | Doctor (substitution approval, Rx status), Store keeper (NC-006 transfers), Purchase officer (indents), Accounts (GST reports), Drug inspector/Auditor (registers), Patient (Rx status, refill reminders) |
| Regulatory | Drugs & Cosmetics Act 1940 / Rules 1945 (Form 20/20B/21/21B retail & wholesale licences, Schedule H, H1 (register: name/address of prescriber & patient, drug, qty; retained 3 yrs), Schedule X (separate licence, prescription retained 2 yrs, secure storage), Schedule G/K), NDPS Act 1985 + state rules (narcotic register Form, dual custody, day-book, quarterly returns), Drugs (Prices Control) Order 2013 (MRP ceiling, sale ≤ MRP), Pharmacy Act 1948 (registered pharmacist for dispensing), GST (medicines 5 %/12 %/18 %/nil by HSN 30xx, e-invoice threshold, B2C invoice rules), CDSCO UDI/barcode on Schedule H/H1 secondary packs (2D DataMatrix GS1: GTIN, batch, expiry, serial), NABH MOM chapter (storage, LASA, high-alert drugs, expiry, recall), BMW 2016 (expired drug disposal), Cold chain 2–8 °C logs |

## 1. Purpose
OP-003 runs the outpatient pharmacy end-to-end: real-time e-Rx queue from OP-002, barcode/2D-DataMatrix guided dispensing with batch/expiry/FEFO validation, substitution and partial fulfilment with doctor approval, medication labels and counselling, integrated GST billing (via OP-005) with multiple payment modes, OTC counter sales, sales returns, store-level inventory (stock, expiry alerts, auto-indent to NC-005/NC-006), Schedule H1/X and narcotic registers with dual authorisation, and cold-chain and recall handling. Target: a 5-line Rx dispensed and billed in under 90 seconds; zero dispensing of expired/recalled batches.

## 2. Users & Jobs-to-be-done
- **Pharmacist OP** (desktop + handheld scanner + label printer): pick next Rx, verify patient, scan items, resolve stock-outs/substitutions, print labels, bill & collect, counsel; 400–800 Rx/day per counter group; keyboard-first.
- **Pharmacy In-charge** (desktop): stock control, expiry/near-expiry actions, indents/POs, price/MRP updates, narcotic custody (2-person), returns approval, supplier returns, registers/reports, licence renewals (NC-023).
- **Cashier** (if separated): collect payment for pharmacy bills at counter (NC-001).
- **Doctor**: approve substitutions, view dispense status, get stock-out feedback.
- **Store keeper** (NC-006): transfer stock from central store to pharmacy sub-store; GRN.
- **Patient**: token/status ("your medicines are ready"), digital bill, refill reminder, home delivery request (later).

## 3. Core Workflows

### 3.1 Pending prescription dashboard
1. Rx signed in OP-002 → `rx.created` → appears within 1 s on pharmacy queue of the target store (socket `pharmacy:store:<id>`) with card: patient, UHID, doctor, item count, priority (STAT/ER/normal), age of Rx, payer type, allergy flag, "awaiting co-sign" state.
2. Patient arrives (scan OP slip/UHID or mobile) → card moves to "Patient at counter" (`F3` scan); pharmacy token displayed on TV (EN-018) with "Ready" state.
3. Pharmacist `Enter` → **Dispense** workflow; concurrent lock prevents two counters picking same Rx (row lock + UI badge "being dispensed by X").
4. Un-picked Rx older than 24 h auto-archived as `not_collected` (report to doctor/patient reminder).

### 3.2 Dispensing workflow
1. **Verify Rx**: banner shows patient identity (name, UHID, age/sex, photo), allergies, doctor, diagnosis; pharmacist confirms identity (2 identifiers) → check schedule class: H/H1/X/narcotic lines require Rx reference (system Rx or scanned external Rx image + prescriber reg no + patient address for H1) — H1/X registers auto-fill.
2. **Item pick**: for each line, system suggests batch by **FEFO** (earliest expiry with stock ≥ qty, expiry ≥ dispense date + `min_shelf_life_days` default 30) and shows bin/rack location; pharmacist scans item barcode/2D DataMatrix (GS1 GTIN+batch+expiry+serial parsed) → validates GTIN↔drug, batch exists in store, not expired, not quarantined/recalled, qty available; mismatch → error beep + red row; manual batch selection allowed with reason (`pharmacy.batch.override`).
3. Quantity: Rx qty (from dose×freq×days) vs pack size → dispense units (strips/tabs/ml) with unit-of-issue conversion; loose dispensing per policy; round-up prompt.
4. **Partial fulfilment / substitution**: line short → options: (a) partial now + "balance later" (creates `dispense_backorder`, patient SMS when stock arrives) (b) **generic substitution** — same molecule/strength/form from formulary; if doctor set `do_not_substitute` or hospital policy requires approval → push approval request to doctor (in-app/phone; doctor taps Approve in OP-002/OP-019, 2-min timeout escalates to HOD) — approval stored on line; brand-to-brand switch always needs approval; therapeutic (different molecule) never without new Rx (c) mark "not available – external purchase" (line printed as external, feedback event to doctor/purchase).
5. CDSS re-check at dispense (EN-029): allergy, interaction with **currently dispensed** meds (last 90 days), duplicate therapy, dose sanity — pharmacist acknowledges/escalates to doctor (`pharmacy.intervention` log for NABH indicator "pharmacist interventions").
6. **Label print** per item (ZPL/ESC-POS): patient name, drug (generic + brand), strength, dose & timing in patient's language + pictograms (sun/moon), qty, batch, expiry, doctor, store, date, "keep away from children", storage (2–8 °C icon); Rx summary sheet optional.
7. **Bill**: system builds pharmacy invoice via OP-005 (item lines: MRP, selling price/discount as per tariff/payer, batch-wise GST rate from HSN — CGST/SGST or IGST, cess, ITC-eligible flag), applies patient category discounts, corporate/insurance credit (EN-002 credit lines need pre-approval limits), staff discounts; payment: cash/card/UPI/wallet/split (NC-001) or "pay at central counter" mode; receipt printed (thermal 80 mm) with GST breakup, HSN, drug licence no, pharmacist reg no, QR verify.
8. **Mark dispensed** → stock ledger decrement per batch (NC-006 `stock_ledger` movement `DISPENSE`), Rx line status `dispensed/partial`, `rx.dispensed` event → OP-002 status, patient notification ("collected"), medication list update (`clinical.medication_lists`).
9. **Counselling checklist** (config per drug class: inhaler technique, insulin, warfarin, antibiotics course completion) → tick + optional patient signature/OTP; printed counselling sheet.
10. Exceptions: patient refuses some items → lines `declined` (no charge); wrong item scanned after billing → return workflow (3.5); power/network loss → offline mode (§13) queues dispense with local stock cache; billing finalisation only online.

### 3.3 OTC / walk-in counter sale
1. `F2` new OTC bill → optional patient (search/quick create name+mobile; anonymous allowed for non-scheduled items only) → item search (name/brand/molecule/barcode; shows stock, MRP, expiry) → cart → Schedule H/H1/X items blocked without Rx capture (upload/scan external Rx, prescriber name/reg no; H1 register entry) → bill via OP-005 (B2C invoice) → payment → labels optional.
2. Bulk sale limits and per-customer quantity caps for controlled molecules (config, e.g. pseudoephedrine, tramadol) → warning/block.

### 3.4 Inventory management (pharmacy sub-store, on NC-006 ledger)
1. **Stock register**: item-wise SOH by batch, expiry, MRP, cost, location (rack/bin/fridge), reserved (backorders), in-transit; ABC/VED class; movement history drill-down.
2. **Receipts**: GRN against PO (NC-005) at pharmacy or transfer-in from central store (NC-006 `stock_transfer`) with barcode receiving; price disparity notice when purchase price/MRP differs from last (market: MocDoc).
3. **Auto-reorder**: rule per item per store (min/max/ROL/ROQ, lead time, consumption-based (avg daily × lead + safety)) → nightly job creates draft **indent** to central store / purchase indent to NC-005 → alert to in-charge (`inventory.reorder.suggested`); manual indent anytime; urgent indent flag.
4. **Expiry management**: dashboard widget + daily email: expiring in 30/60/90/180 days (config), value at risk; actions: mark for supplier return (within return window per supplier contract, NC-021), inter-store transfer to faster-moving store, near-expiry discount suggestion (rule: e.g. 10 % if < 90 days, needs in-charge approval, never below cost without approval), quarantine when ≤ 0 days → block dispensing; expired stock → `EXPIRED_WRITEOFF` movement, BMW yellow-bag disposal record (NC-016), credit note tracking from supplier.
5. **Stock count / cycle count** (NC-006): scheduled counts by ABC class, variance approval.
6. **Recall**: CDSCO/manufacturer recall entry (drug/batch) → instant quarantine across stores → list of patients dispensed that batch (trace) → SMS/call list → `pharmacy.recall.raised`.
7. **Cold chain**: fridge/freezer items flagged; temperature log manual (twice daily) or sensor (EN-042); excursion → quarantine batch until pharmacist decision; vaccine/insulin dispensing prints "keep refrigerated".
8. **LASA/high-alert**: item master flags; Tall-Man lettering on screen/labels; separate bins; double-check prompt on high-alert (insulin, KCl concentrate, anticoagulants).
9. Price/MRP updates from GRN batch (MRP per batch, DPCO ceiling check: selling price ≤ MRP always; alert if MRP > ceiling from NPPA list) — RC-003 tariff for non-MRP items (consumables).

### 3.5 Returns & refunds
1. Patient return (unopened, within N days, not cold-chain, not Schedule X, strips intact) → scan original bill → select lines/qty → reason code (wrong item, doctor stopped, patient expired, duplicate, discharge unused) → in-charge approval above threshold → stock back to batch (`SALE_RETURN`, restock or quarantine) → credit note + refund via OP-005 (`billing.refund`), GST reversal (credit note referencing invoice) → `pharmacy.return.completed`.
2. Supplier return (expiry/damaged/recall) → debit note via NC-005.
3. Returns analytics by reason code (enhancement from sheet).

### 3.6 Narcotic & controlled substance register (NDPS + Schedule X + H1)
1. Narcotic/psychotropic items flagged in master (`control_class` = NDPS/Schedule X/H1) with storage location (double-lock).
2. Every receipt/issue/dispense/return/destruction of NDPS items requires **dual authorisation**: pharmacist + second authorised user (in-charge/doctor) both authenticate (password/PIN/biometric) on the same transaction (`requires_second_person` ABAC); prescription image/ref, patient identity, prescriber reg no, qty in words → **NDPS register** (bound-book style, gapless serials, no delete; corrections as reversal entries) and daily balance; discrepancy → incident (NC-015) + block further issue until reconciled.
3. Schedule H1 register auto-generated (drug, qty, patient name/address, prescriber name/reg no, date), retained 3 y; Schedule X: separate register + Rx copy retained 2 y; day-book and monthly/quarterly returns exports (state format templates via EN-039).
4. Balance check at shift handover: physical count vs system → sign-off by both.

### 3.7 Shift, counter & cash
- Multi-counter with per-user session; shift open/close with cash denomination via NC-001; end-of-day: sales summary, GST summary, pending Rx, backorders, low stock. Handover notes.

## 4. Data Model (schema `pharmacy` + shared `inventory`)
- **pharmacy_stores**: id, hospital_id, branch_id, name, type enum(op_retail/ip/emergency/satellite/night), licence_no (Form 20/21…), licence_valid_to, gstin (if separate), registered_pharmacist_ids[], counters[], is_24x7, print_profiles.
- **rx_queue** (read model): rx_id, store_id, patient_id, status enum(pending/patient_arrived/in_progress/on_hold/awaiting_approval/completed/partial/not_collected/cancelled), assigned_to, priority, arrived_at, started_at, completed_at, sla_due_at.
- **dispenses**: id, hospital_id, branch_id, store_id, dispense_no (series `DISP`), rx_id?, patient_id?, encounter_id?, type enum(rx/otc/ip_issue/return/sample), bill_id (billing), status enum(draft/billed/dispensed/cancelled/returned/partially_returned), pharmacist_id, second_auth_user_id?, counselling jsonb, payer_type, total_amount, notes.
- **dispense_items**: dispense_id, rx_item_id?, drug_id, batch_id (inventory.item_batches), qty_ordered, qty_dispensed, unit, substitution jsonb (original_drug_id, approved_by, approved_at, reason), status enum(dispensed/partial/backordered/declined/external/substituted), mrp, selling_price, discount, tax_rate, hsn, cdss_alerts jsonb, label_printed_at.
- **dispense_backorders**: dispense_item_id, patient_id, drug_id, qty_pending, notified_at, fulfilled_dispense_id, expires_at.
- **substitution_requests**: rx_item_id, from_drug_id, to_drug_id, requested_by, doctor_id, status enum(pending/approved/rejected/timed_out), decided_at, note.
- **pharmacy_interventions**: dispense_id, type enum(allergy/interaction/dose/duplicate/clarification/substitution), detail, outcome, doctor_contacted bool.
- **sale_returns**: return_no (series `PHRET`), original_dispense_id, patient_id, reason_code, approved_by, refund_id, credit_note_id, status; **sale_return_items** (batch, qty, restock/quarantine).
- **controlled_drug_register** (NDPS/Schedule X/H1 unified with `register_type`): id, hospital_id, store_id, register_type enum(ndps/schedule_x/schedule_h1), serial_no (gapless per store/register/FY), drug_id, batch_id, txn_type enum(receipt/issue/dispense/return/destruction/adjustment/opening), qty_in, qty_out, balance, patient_id/name/address, prescriber_name, prescriber_reg_no, rx_ref, rx_image_file_id, first_auth_user_id, second_auth_user_id, remarks, created_at; immutable (no update/delete; trigger-enforced).
- **narcotic_custody_checks**: store_id, shift_id, drug_id, system_balance, physical_count, variance, checked_by_1, checked_by_2, incident_id.
- **expiry_actions**: batch_id, action enum(return_to_supplier/transfer/discount/quarantine/writeoff/disposal), qty, approved_by, ref_doc_id, bmw_record_id.
- **recalls**: recall_no, source enum(cdsco/manufacturer/internal), drug_id, batch_no, reason, raised_at, closed_at; **recall_traces** (dispense_item_id, patient_id, contacted_at, returned bool).
- **cold_chain_logs**: unit_id (fridge), reading_temp, recorded_at, method enum(manual/sensor), excursion bool, action.
- **reorder_rules**: store_id, drug_id, min, max, rol, roq, lead_days, method enum(fixed/consumption), auto_indent bool.
- **counselling_checklists**: drug_class, items jsonb, language variants.
- **price_lists** (pharmacy discounts by payer/category) → RC-003; MRP lives on `inventory.item_batches.mrp`.
- Shared (NC-006 `inventory`): `items` (drug master link, hsn, gst_rate, schedule_class, control_class, is_high_alert, is_lasa, storage_condition, uom conversions), `item_batches` (batch_no, expiry, mrp, cost, gtin, qty_on_hand per store), `stock_ledger` (partitioned monthly; movement types include DISPENSE, SALE_RETURN, EXPIRED_WRITEOFF, TRANSFER_IN/OUT, GRN, ADJUSTMENT, RECALL_QUARANTINE).
Indexes: rx_queue (hospital_id, store_id, status, priority desc, arrived_at); dispenses (hospital_id, store_id, created_at desc), (patient_id, created_at desc); dispense_items (batch_id) for recall trace; controlled_drug_register (store_id, register_type, serial_no) unique. RLS all.

## 5. Business Rules & Validations
- Only users with `pharmacy.dispense` and a valid registered-pharmacist profile (Pharmacy Council reg no) may complete a Rx dispense; store licence expiry blocks dispensing after grace (warn 60 days before, NC-023).
- Never dispense: expired batch, quarantined/recalled, cold-chain excursion pending, batch expiring before course end (warn) or < min shelf life (block unless override); selling price > MRP forbidden (DPCO); price below cost needs approval.
- FEFO default; override with reason; batch scan mandatory for Schedule H1/X/NDPS/high-alert; configurable "scan mandatory for all".
- Schedule H/H1/X: no sale without prescription (system Rx or captured external Rx); H1 register mandatory; X requires separate licence flag on store, prescription retained (image), qty limits; NDPS dual auth + register serials gapless; refills of H1/X limited per Rx (config; default 1); OTC screen hides scheduled items unless Rx captured.
- Substitution policy: generic ↔ generic same molecule/strength/form allowed if hospital policy `auto_generic_ok` and doctor did not mark DNS; otherwise doctor approval; therapeutic substitution forbidden; every substitution shown on bill/label and fed back to OP-002.
- Partial dispense: bill only dispensed qty; backorder expiry 7 days; if Rx amended by doctor, open backorders re-evaluated.
- Returns: within 7 days (config), unopened, not cold-chain/Schedule X/opened liquids; refund only to original payer/mode (cash refund limits per NC-001), credit note references original invoice for GST.
- GST: rate by HSN per batch (5 % most drugs, 12 % some, 18 % supplements/cosmetics, nil life-saving list); intra-state CGST+SGST, inter-state IGST (patient state from address for B2B; B2C default place of supply = store state); invoice B2C unless patient supplies GSTIN (corporate/B2B → OP-005 B2B invoice); e-invoice IRN not required for B2C but required for B2B if hospital turnover ≥ threshold (currently ₹5 crore) — hooks in OP-005; pharmacy invoice number gapless per store/FY (`BILL_PH`); composite/exempt hospital services separate from pharmacy taxable supply.
- Discounts: category/payer-based auto; manual discount ≤ pharmacist limit (e.g. 5 %) else approval (EN-038); never on NDPS below cost.
- Stock ledger is single source of truth (NC-006); pharmacy never mutates SOH except via movements; negative stock forbidden (block) — except configured "allow negative for emergency store with reconciliation".
- Reorder job nightly 02:00; urgent indents anytime; auto-indent to central store; direct purchase indent when central also below ROL.
- Immutability: dispenses after `dispensed` cannot be edited (only returned/cancelled with reversal); registers immutable; audit on all.
- Retention: sales invoices 8 y (GST), H1 register 3 y, Schedule X Rx 2 y, NDPS register as per state (≥ 2 y, keep 10), cold-chain logs 3 y.
- Numbering: `DISP`, `BILL_PH` (gapless), `PHRET`, register serials.

## 6. API Surface (`/api/v1/pharmacy`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /queue?store=&status= | Rx queue (read model + socket) | pharmacy.queue.read | – | cursor |
| POST | /queue/{rx}/arrive, /assign, /hold | queue ops | pharmacy.queue.manage | Y | – |
| POST | /dispenses | start dispense (rx or otc) | pharmacy.dispense.create | Y | – |
| POST | /dispenses/{id}/items | add/scan line (barcode payload) | pharmacy.dispense.create | Y | – |
| POST | /dispenses/{id}/items/{i}/substitute | request/apply substitution | pharmacy.substitution.request | Y | – |
| POST | /substitutions/{id}/decide | doctor approve/reject | rx.substitution.approve | Y | – |
| POST | /dispenses/{id}/cdss-check | run rules | pharmacy.dispense.create | – | – |
| POST | /dispenses/{id}/bill | create bill via OP-005 | pharmacy.dispense.bill | Y | – |
| POST | /dispenses/{id}/complete | mark dispensed (stock move) | pharmacy.dispense | Y | – |
| POST | /dispenses/{id}/labels | print labels | pharmacy.label.print | – | – |
| POST | /dispenses/{id}/cancel | cancel before completion | pharmacy.dispense.cancel | Y | – |
| GET | /dispenses?patient=&store=&from= | history | pharmacy.dispense.read | – | cursor |
| POST | /returns | sale return | pharmacy.return.create | Y | – |
| POST | /returns/{id}/approve | approve | pharmacy.return.approve | Y | – |
| GET | /stock?store=&q=&expiring_within= | SOH by batch | pharmacy.stock.read | – | cursor |
| GET | /stock/{drug}/batches?store= | FEFO batches | pharmacy.stock.read | – | – |
| POST | /indents | create indent | pharmacy.indent.create | Y | – |
| GET | /reorder/suggestions | nightly suggestions | pharmacy.indent.create | – | cursor |
| POST | /expiry-actions | act on batch | pharmacy.expiry.manage | Y | – |
| POST | /recalls, /recalls/{id}/trace | recall + trace | pharmacy.recall.manage | Y | cursor |
| POST | /controlled-register | entry (2 auth tokens) | pharmacy.narcotic.dispense (+second) | Y | – |
| GET | /controlled-register?type=&from= | register view/export | pharmacy.narcotic.read | – | cursor |
| POST | /custody-checks | shift count | pharmacy.narcotic.custody | Y | – |
| POST | /cold-chain/logs | temp entry | pharmacy.coldchain.log | Y | – |
| GET | /reports/* | sales, GST, expiry, consumption | pharmacy.report.read | – | – |
| GET/PUT | /stores/{id}/config, /reorder-rules | config | pharmacy.configure | Y | – |

## 7. Domain Events
- `pharmacy.rx.received` (on `rx.created`) → queue read model, TV.
- `rx.dispensed` / `rx.partially_dispensed` {rx_id, items[{drug, batch, qty, substitution}]} → OP-002 status + medication list, OP-020 patient, EN-011 (dispense record), analytics.
- `pharmacy.substitution.requested|approved|rejected` → doctor notification, pharmacist UI.
- `pharmacy.stockout.reported` {drug_id, store_id, rx_id} → purchase (NC-005), doctor feedback, formulary committee report.
- `inventory.stock.moved` (NC-006) consumed for SOH cache; `inventory.reorder.suggested`; `pharmacy.expiry.alert` (daily); `pharmacy.batch.quarantined`; `pharmacy.recall.raised|closed`.
- `pharmacy.return.completed` → OP-005 credit note/refund, NC-006 movement.
- `pharmacy.narcotic.transaction` → EN-024 audit + NC-015 if variance; `pharmacy.custody.variance`.
- `pharmacy.coldchain.excursion` → in-charge alert, quarantine.
- `pharmacy.bill.created` (via OP-005 `bill.finalized` with `source=pharmacy`).

## 8. Screens
- **Rx queue board** (desktop; TV variant for patient "Ready" tokens): columns Pending / At counter / In progress / Ready / Backorder; filters store, priority; hotkeys `F3` scan slip, `Enter` open, `H` hold, `A` assign to me. Real-time; empty: "No pending prescriptions".
- **Dispense workspace** (desktop, barcode-first): banner (patient, allergies red), Rx lines grid with FEFO batch suggestion, scan field always focused (audible feedback), CDSS chips, substitution drawer, stock/price columns, running total with GST, payment pane (NC-001), label print button. Hotkeys: `F4` scan item, `F6` substitute, `F7` partial, `F8` labels, `F9` bill, `F10` collect & complete, `Ctrl+Z` remove line, `Esc` back to queue. Offline: scanning & batch validation from local cache; billing disabled with banner.
- **OTC counter** (desktop/tablet): item search + cart, quick patient, Rx capture drawer for scheduled items, `F2` new bill.
- **Stock explorer** (desktop): tree by category, batch table with expiry colour bands (red < 30 d, orange < 90 d, yellow < 180 d), movement history, bin map.
- **Expiry & reorder dashboard** (desktop): widgets (value at risk, expiring lists, suggested indents), one-click actions.
- **Controlled drugs register** (desktop, 2FA-gated): bound-book view, entry modal requiring second-person auth, custody check, exports.
- **Returns desk**, **Recall console** (trace list with contact status), **Cold-chain log** (tablet near fridge; QR to open), **Store admin/config**, **End-of-day**.
- Print: labels 50×25 mm / 70×40 mm (ZPL/TSPL), thermal 80 mm invoice (ESC/POS), A4 registers.

## 9. Integrations
- Barcode: GS1 DataMatrix parsing (AI 01 GTIN, 10 batch, 17 expiry, 21 serial), EAN-13, internal item barcodes (EN-013); scanners USB-HID/Bluetooth; camera scan on tablet.
- Label/receipt printers (EN-005) ZPL/TSPL/ESC-POS via print agent; auto-print.
- NC-006 stock ledger, NC-005 PO/GRN/indent, NC-021 supplier returns, OP-005 billing/GST/credit notes, NC-001 cash, EN-010 UPI/QR at counter, EN-009 SMS/WhatsApp (ready, backorder arrived, refill reminder), EN-029 CDSS, EN-027 drug master (CIMS/own; NPPA ceiling list import), EN-042 temperature sensors (MQTT), NC-016 BMW disposal, NC-023 licence tracker, EN-011 ABDM (dispense record HI type "Prescription/DispenseRecord" optional), Tally export (NC-009).
- Fallbacks: barcode unreadable → manual batch selection with reason; printer down → queue and reprint; CDSS down → banner + manual.

## 10. Reports & Analytics
- Sales (daily/shift/counter/pharmacist; cash vs credit vs insurance), GST sales register (HSN-wise, B2C/B2B, credit notes; GSTR-1 export), item movement/consumption (ABC/VED, fast/slow/non-moving), stock valuation (FIFO/weighted), expiry report (30/60/90/180) & write-offs, near-expiry actions log, stock-out & fill-rate (Rx lines fully dispensed %), substitution rate, pharmacist interventions (NABH), TAT (Rx arrival → ready), backorder aging, returns by reason code, NDPS/H1/X registers & returns, cold-chain compliance, margin analysis (MRP vs cost), doctor-wise prescribed vs dispensed (leakage), high-alert drug dispensing, top molecules, antibiotic consumption (DDD, for IP-012), narcotic day-book.
- Read models: `analytics.mv_pharmacy_sales_daily`, `analytics.mv_stock_expiry`, `analytics.mv_pharmacy_tat`, `analytics.mv_item_consumption_30d`.

## 11. Notifications
- Patient: "Rx received / medicines ready (token)", backorder available, refill due (chronic, PE-002), recall contact, home delivery (later).
- Doctor: substitution approval request (in-app + push, 2-min escalate), stock-out of prescribed item, pharmacist intervention needing reply.
- In-charge: expiry digest (daily email), reorder suggestions, cold-chain excursion (push + SMS), narcotic variance (immediate), licence expiry (60/30/7 d), price disparity on GRN.
- TV: pharmacy ready tokens.

## 12. Permissions
`pharmacy.queue.read|manage`, `pharmacy.dispense.create|read|bill|cancel`, `pharmacy.dispense` (complete, requires pharmacist profile), `pharmacy.substitution.request`, `rx.substitution.approve` (doctor), `pharmacy.batch.override`, `pharmacy.label.print`, `pharmacy.otc.sell`, `pharmacy.return.create|approve`, `pharmacy.stock.read|adjust`, `pharmacy.indent.create|approve`, `pharmacy.expiry.manage`, `pharmacy.recall.manage`, `pharmacy.narcotic.dispense|read|custody` (+ABAC requires_second_person, 2FA), `pharmacy.coldchain.log`, `pharmacy.price.update`, `pharmacy.discount.apply` (amount_limit), `pharmacy.report.read|export`, `pharmacy.configure`.
Defaults: Pharmacist OP: queue, dispense*, otc, label, return.create, stock.read, coldchain.log, narcotic.dispense (as first person); In-charge: all incl. approve/expiry/recall/configure/price; Doctor: rx.substitution.approve; Store keeper: stock.read; Accounts/Auditor: report.read/export, narcotic.read.

## 13. Non-functional
- Volumes: 4000 Rx/day OP, 2500 OTC bills/day, 25k dispense lines/day, 12 counters per branch, 30k SKUs, 150k batches, ledger 10M rows/yr (partitioned).
- p95: queue < 150 ms; barcode validate < 80 ms (Redis SOH cache + batch lookup); bill create < 300 ms; label print enqueue < 100 ms; recall trace over 2 yrs < 2 s (index on batch_id).
- Offline: local cache of store SOH (refresh 5 min) & drug master; scanning/validation offline; completion queued; billing online-only; conflict: server stock authoritative — if insufficient at sync, line becomes backorder and pharmacist alerted.
- Printing: label/receipt agents with retry; reprint audit.
- Accessibility/i18n: label languages per patient preference (8 languages + pictograms); keyboard-only dispensing; colour+icon for expiry bands.
- Security: 2FA for narcotics/in-charge; second-person auth via re-auth token; PHI minimal on labels; audit on every mutation; registers immutable by trigger.

## 14. Acceptance Criteria
1. Given an Rx signed in OP-002 for store S, then it appears in S's queue within 1 s and nowhere else; when patient's OP slip is scanned, card moves to "At counter".
2. Given a drug with batches A (exp 2 months) and B (exp 8 months), when line is opened, then A is suggested (FEFO); scanning B without reason is rejected unless `pharmacy.batch.override`.
3. Given a scanned DataMatrix with expired date, then the line turns red, an audible alert sounds, and completion is blocked.
4. Given a line short by 5 tablets, when pharmacist chooses partial, then bill covers dispensed qty only, a backorder is created, and the patient is notified when GRN of that item arrives.
5. Given doctor marked "do not substitute", when pharmacist tries generic substitution, then a request is sent; without approval within timeout the line stays pending; approval by doctor records approver and time on the line and label shows substituted brand.
6. Given a Schedule H1 item in OTC without Rx capture, then sale is blocked; with external Rx image + prescriber reg no, sale proceeds and an H1 register row is created with patient name/address.
7. Given an NDPS dispense, when only one user authenticates, then completion is blocked; with second-person auth both user ids are stored, register serial increments gaplessly, and balance matches ledger.
8. Given a completed dispense, then `stock_ledger` shows DISPENSE movements per batch, SOH decrements, `rx.dispensed` emitted, and OP-002 shows "Dispensed".
9. Given a sale return of an unopened strip within 7 days, then stock returns to same batch, credit note references original invoice with GST reversal, and refund is routed via OP-005 to original mode.
10. Given a batch recall entered, then that batch is quarantined in all stores within 5 s and the trace lists every patient dispensed that batch with contact status.
11. Given item MRP ₹100 and attempted selling price ₹105, then save is rejected (DPCO); ₹95 with 5 % discount allowed within pharmacist limit; 15 % requires approval.
12. Given intra-state B2C sale of a 12 % HSN item ₹200, then invoice shows CGST 6 % ₹12 + SGST 6 % ₹12 (inclusive/exclusive per configuration) and HSN code, and appears in GST register.
13. Given a fridge log entry of 10 °C, then an excursion alert fires and cold-chain batches in that unit are quarantined pending pharmacist decision.
14. Given nightly reorder job with SOH below ROL, then a draft indent is created and in-charge notified; approving it creates a transfer request in NC-006 / purchase indent in NC-005.
15. Given a patient allergic to sulpha and Rx contains cotrimoxazole (missed override), then dispense CDSS blocks and creates a pharmacist intervention record; doctor is notified.
16. Given a load test of 25k lines/day with 12 concurrent counters, p95 for scan-validate stays < 80 ms and no double-dispense of the same Rx occurs.
17. Given the store licence expiry passed, then dispensing is blocked with clear message and in-charge alerted (configurable grace).
18. Given end-of-shift custody check with variance, then an incident is created and NDPS issues are blocked until reconciled by in-charge.

## 15. Enhancements / Later phases
- From VIMS sheet: drug–drug interaction severity levels (Phase 4 via EN-029); patient medication counselling checklist (Phase 4); smart dispensing bin location guidance (Phase 4 basic bin; pick-to-light later); returns analytics by reason code (Phase 4); near-expiry auto-discount suggestion (Phase 4 rule); controlled substance dual-authorisation (Phase 4 core).
- (market) Multi-store management, stock transfer, price disparity notification, supplier & patient credit settlement, short-expiry notification (MocDoc); expiry return manager with credit notes, loyalty points, udhar/credit customers, duplicate SKU analyser (SmartHospital) → NC-006 item dedupe; smart issue option to reduce expiry (Prodoc); home delivery & runner app; WhatsApp refill ordering; e-pharmacy portal; unit-dose/IP (IP-014); vending/automated dispensing cabinet integration (later); AI demand forecast (AI-005).

## 16. Open Questions for the Hospital
1. Number of pharmacy stores/counters per branch (OP retail, ER 24×7, IP), separate GSTIN/drug licences per store? Licence numbers and expiry dates.
2. Drug master source (CIMS licence? own list? import from existing system) and whether MRP is batch-wise (default) or item-wise.
3. Substitution policy: auto generic substitution allowed? doctor approval channel (app/phone)? DNS respected?
4. Scan mandatory for all items or only scheduled/high-alert? Do suppliers provide GS1 DataMatrix consistently?
5. Discount slabs by category (staff, senior citizen, corporate) and pharmacist discount limit; near-expiry discount rule.
6. Return policy (days, exclusions), refund mode rules.
7. NDPS: which drugs stocked (e.g. morphine, fentanyl, pethidine), state register format, who is second authoriser, quarterly return format.
8. Cold-chain: sensor devices available or manual log? Which fridge units?
9. Payment: pharmacy collects at its own counter or central cashier? UPI QR per counter?
10. Reorder: central store replenishment vs direct purchase; ROL basis; lead times.
11. Label language(s) and pictograms; label size/printer models.
12. Any state drug-controller reporting formats (e.g. Schedule H1 monthly) required at go-live?
