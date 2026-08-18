# NC-006 — Stores / Inventory (Item Master, Stock Ledger, Batches, FEFO, ABC/VED/FSN, Transfers, Counts, Valuation)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-006 |
| Phase | 4 |
| Priority | P0 |
| Complexity | High |
| Depends on | EN-027 (drug/consumable master data, HSN/GST, UoM), NC-005 (PO/GRN inbound, indents, returns), NC-007 (consignment stock segregation), NC-008 (consumption & cost centres), OP-003 (OP pharmacy — dispensing movements), IP-014 (ward stock/unit dose), OP-004/OP-008 (reagent/film consumption), IP-006/EN-003 (OT/CSSD consumables & trays), TR-003 (implant traceability), NC-002 (capital items, spares), NC-009 (inventory valuation journals, COGS), NC-011 (analytics), NC-021 (vendors), EN-013 (barcode/GS1/labels), EN-042 (temperature sensors, RFID), EN-038 (approvals for adjustments/write-offs), EN-024 (audit), NC-016 (expired/damaged disposal to BMW), AI-005 (forecasting later) |
| Feature flag | `module.inventory.enabled` (sub: `inventory.rfid`, `inventory.temperature_zones`, `inventory.cycle_count`, `inventory.multi_uom`, `inventory.valuation_fifo`) |
| Primary roles | Stores Keeper / Store In-charge (44), Pharmacy In-charge (32, drug stores), Sub-store custodians (ward nurse in-charge 17, OT store, lab store 33, radiology store 36, CSSD 38, housekeeping 50, kitchen 53) |
| Secondary roles | Purchase Officer (45), Accountant (46, valuation), HOD (5, indents), Biomedical (48, spares), Quality (54, expiry/cold-chain audits), Auditor (58), Hospital/Branch Admin (2/3) |
| Regulatory | Drugs & Cosmetics Act & Rules (batch/expiry records, storage conditions Schedule P, Schedule H1/X/NDPS registers with OP-003, drug licence per store — Form 20/21/20B/21B), NDPS Act (narcotic stock records), GST (HSN, stock valuation for ITC, stock transfer inter-state = supply/e-way bill), Legal Metrology (MRP), CDSCO UDI for devices, Cold-chain (2–8 °C, WHO/UIP guidance, temperature logs), NABH MMS (storage, expiry, LASA, high-alert segregation, recall), Income-tax/Companies Act (inventory valuation FIFO/Weighted Avg per IndAS 2/AS 2 — lower of cost or NRV), BMW 2016 (expired drug disposal), Fire/hazmat storage (oxygen, flammables) |

## 1. Purpose
NC-006 is the single **stock ledger** of the hospital: item master with HSN/GST/UoM conversions and classifications, batch/expiry/serial tracking across a hierarchy of stores and locations (main store, pharmacy stores, wards, OT, lab, radiology, CSSD, housekeeping, kitchen, ambulances), all movements (GRN, issue, return, transfer, consumption, dispense, adjustment, write-off, quarantine, recall) with FEFO picking, min/max/reorder automation, ABC/VED/FSN analysis, cycle counts and physical stock takes, dead/slow-stock detection, temperature-zone management, RFID/barcode operations and inventory valuation (FIFO/Weighted Average) posted to NC-009. Pharmacy (OP-003/IP-014), consumption (NC-008), consignment (NC-007) and purchase (NC-005) all read/write through NC-006's ledger — no module mutates stock directly.

## 2. Users & Jobs-to-be-done
- **Store keeper** (desktop + barcode scanner + label printer; handheld/tablet in aisles): receive stock (GRN from NC-005), shelve to bins, pick & issue against indents (FEFO), transfer between stores, count stock, quarantine/expiry management, print labels, raise reorder.
- **Sub-store custodian (ward/OT/lab)** (tablet/phone): raise indents to main store, acknowledge receipts, record consumption/returns, manage par levels, count weekly.
- **Pharmacy in-charge**: drug-store specific rules (schedule classes, cold chain, LASA/high-alert bins) — dispensing itself in OP-003/IP-014.
- **Purchase officer**: reorder suggestions, stock positions, ABC/VED for planning.
- **Accountant**: valuation reports, month-end closing stock, write-off approvals, GL reconciliation.
- **Quality/auditor**: expiry & cold-chain compliance, count variance, recall traces.
- **Admin**: store hierarchy, UoM, classifications, thresholds, approval limits.

## 3. Core Workflows

### 3.1 Item master
1. **Store/pharmacy in-charge (or MDM steward EN-027)** creates item: code (`ITEM` series or manual), name, generic name (drugs) & brand mapping (generic ↔ brands, substitution groups), category tree (drug/consumable/surgical/implant/reagent/linen/stationery/housekeeping/food/engineering spare/IT/gas/other), sub-category, item type enum(stock/non_stock/service/asset), **UoM set**: base UoM (tablet/ml/each) with purchase UoM & issue UoM conversions (`inventory.multi_uom`: strip=10 tab, box=10 strips, case=20 box; loose issue allowed flag), HSN/SAC + GST rate (effective-dated), MRP-controlled flag, price (last purchase, avg cost, standard cost), storage condition enum(room/cool/cold_2_8/frozen/controlled_substance/flammable/hazmat), temperature zone requirement, tracking enum(none/batch/batch_expiry/serial/udi), min shelf life at receipt, is_lasa, is_high_alert, is_narcotic/schedule class (link EN-027 drug master), is_consignment_allowed, is_capital, is_returnable, is_billable (auto-charge item on consumption → OP-005/IP-005 via NC-008), default supplier(s), manufacturer, GTIN/barcodes (multiple per pack level), images, MSDS link, ABC/VED/FSN class (computed + manual override), status (active/inactive/blocked) → approval (new item workflow) → Event `inventory.item.created|updated`.
2. **Store-item settings** (`item_store_params` per store): min, max, ROL, ROQ, safety stock (auto-calculated from lead time × avg daily consumption × service factor — VIMS enhancement), par level (wards), bin/rack location, auto-indent flag, preferred source store, is_stocked.

### 3.2 Store hierarchy & locations
- Stores tree per branch: main/central store → sub-stores (pharmacy OP/IP/ER/OT, wards, ICU, lab, radiology, CSSD, dialysis, kitchen, housekeeping, engineering, ambulance, consignment area) with type, custodian, drug licence no./expiry (for drug stores), allowed item categories, temperature zones (fridges/freezers/rooms with sensor ids EN-042), bins/racks/shelves (`locations` ltree). Consignment locations tagged (NC-007) so owned vs consignment stock is never mixed.

### 3.3 Stock ledger (append-only)
- Every movement writes `stock_ledger` rows (item, batch, store, location, qty ± in base UoM, unit cost, value, movement type, reference doc, actor, timestamp) inside the originating transaction; `stock_balances` (item × batch × store × location: qty_on_hand, qty_reserved, qty_quarantined, avg_cost) maintained by trigger/service; negative stock blocked (config per store: hard block vs allow-with-approval for ward emergencies). Movement types: GRN_IN, GRN_REVERSAL, ISSUE, ISSUE_RETURN, TRANSFER_OUT, TRANSFER_IN, DISPENSE (OP-003), DISPENSE_RETURN, CONSUMPTION (NC-008), PATIENT_RETURN, ADJUSTMENT_PLUS/MINUS, COUNT_ADJUST, EXPIRED_WRITEOFF, DAMAGE_WRITEOFF, QUARANTINE_IN/OUT, RECALL_OUT, VENDOR_RETURN, CONSIGNMENT_IN/USED/RETURN (NC-007), OPENING_STOCK, MANUFACTURE/REPACK_IN/OUT (bulk to loose), DONATION_IN, SAMPLE_IN, LOAN_OUT/IN.

### 3.4 Receipt & shelving
1. NC-005 GRN accepted → stock in to receiving/quarantine location (per QC rule) → **put-away**: store keeper scans item/batch → suggested bin (item default; cold-chain must go to zone with matching temperature) → confirm → available. Labels: batch/expiry/bin barcodes (EN-013). Opening stock via EN-036 import (item, batch, expiry, qty, cost) with count sign-off.

### 3.5 Indent → issue → acknowledge → return
1. **Sub-store** raises **store indent** (item, qty; par-level auto-fill "top-up to par"; scheduled auto-indents e.g. ward weekly) → main store approves (edit qty by availability) → **pick list** generated FEFO (batch with earliest expiry first; override with reason; skips quarantined/expired/recalled) → picker scans batch → **issue note** (`ISSUE` series) → stock out from main, **in-transit** → receiving store scans/acknowledges (qty received; shortages flagged as discrepancy) → stock in → Event `inventory.issue.completed`. Ward stock consumption then flows via NC-008/IP-014.
2. **Return** (unused, wrong item; not opened/expired) → return note → main store inspects → accept to stock or write-off/quarantine.
3. Emergency issue outside hours by on-duty staff with permission and post-facto approval.

### 3.6 Inter-store & inter-branch transfers
1. Transfer request → approval (if configured) → dispatch (pick FEFO, pack list, gate pass EN-015 for inter-branch) → transit → receipt with variance → both balances updated → inter-branch: stock transfer note with value; if different GSTIN → tax invoice + e-way bill (via OP-005 GST engine/NC-009) → Event `inventory.transfer.completed`.

### 3.7 Batch, expiry, quarantine, recall
1. Expiry watch: nightly job flags batches expiring in 90/60/30 days (config per category) → lists per store; near-expiry actions: transfer to high-consumption store, return to vendor (NC-005 return if within vendor policy), consignment return (NC-007), mark for write-off → expired batches auto-moved to `EXPIRED` quarantine location on expiry date (blocked from issue/dispense) → write-off with approval → disposal to BMW (NC-016 yellow/blue bag entry, or vendor take-back) → Event `inventory.batch.expiring|expired|written_off`.
2. **Recall/quarantine**: notification (CDSCO alert, vendor FSN, TR-003, OP-003 quality complaint) → quarantine batch across all stores instantly (`QUARANTINE_IN`, blocks movements) → trace forward: issues/dispenses/consumption/patients from ledger + OP-003/NC-008/TR-003 → return/destroy → release or write-off → Event `inventory.batch.quarantined|released`.
3. Cold-chain: temperature zone sensors (EN-042) → excursion → auto-flag batches in zone `hold_pending_review` → pharmacist/quality decision (release/discard) → log.

### 3.8 Reorder & replenishment
- Nightly (and on-demand): for each stocked store-item, compare available (on hand − reserved + on order/in transit) with ROL/min; suggest ROQ (max − available, or EOQ/consumption-based: avg daily × (lead + review) − available); safety stock auto (μ_lead × σ or fixed days); output: purchase indent draft (NC-005) for main store or store indent for sub-stores; consolidate; consider ABC/VED priority (V-items never below safety); consignment excluded → Event `inventory.reorder.suggested`. Dead stock (no movement > N days, config 180/365) and slow-moving flagged for redeployment/return/write-off.

### 3.9 Physical count & cycle count (`inventory.cycle_count`)
1. Schedules: cycle counts by ABC (A monthly, B quarterly, C half-yearly), narcotics daily (OP-003), wards weekly par check, annual full stock take (freeze movements per store during count window or blind count with snapshot) → count sheets/handheld blind entry (scan bin → item → batch → qty; offline capable) → recount for variances beyond threshold → variance report (qty/value, reasons) → approval matrix by value (EN-038) → `COUNT_ADJUST` postings → journal to NC-009 (shortage/excess) → Event `inventory.count.completed`.

### 3.10 ABC / VED / FSN / XYZ analysis
- Monthly job: ABC by annual consumption value (A ≈ 70 %, B ≈ 20 %, C ≈ 10 % of value; cut-offs configurable), VED (manual criticality by pharmacy & therapeutics committee: vital/essential/desirable), FSN by movement frequency (fast/slow/non-moving), XYZ by demand variability; ABC-VED matrix (I: AV, AE, AD, BV, CV; II: BE, CE, BD; III: CD) → drives review frequency, count frequency, safety stock, approval strictness → stored on `item_store_params.classification` with history.

### 3.11 Valuation & accounting
- Method per hospital (`inventory.valuation_fifo` → FIFO cost layers per batch; default Weighted Average per item-store updated on receipts) → COGS on consumption/dispense; month-end closing stock report by store/category; write-offs/adjustments/expiry to expense heads; consignment excluded from owned valuation; lower-of-cost-or-NRV provision report; journals summarised to NC-009 (Dr Inventory / Cr GRN-IR on receipt; Dr Consumption expense (cost centre) / Cr Inventory on consumption; COGS for pharmacy sales) → Event `inventory.valuation.period_closed`.

### 3.12 Barcode/RFID operations (`inventory.rfid`)
- All operations scan-first: GS1-128/DataMatrix (GTIN+lot+expiry+serial), internal batch labels, bin labels; RFID (UHF tags on high-value items/implants/linen crates) portals at store doors log movements automatically and reconcile with expected transfers; handheld RFID count for cycle counts.

### 3.13 Repacking, loose issue & manufacturing (bulk → unit)
- Store repacks bulk (e.g. 5 L antiseptic → 100 ml bottles; 1000-tab jar → strips; oxygen cylinder refills tracked as cylinder assets + gas item) via `REPACK_OUT`/`REPACK_IN` movements preserving batch/expiry, cost per unit re-derived; label printed with new pack barcode; wastage in repack recorded. Loose issue allowed only where `loose_issue_allowed` and pharmacist confirms child-resistant packing rules.

### 3.14 Loans, donations, samples & returns from patients
- **Loan out/in** between hospitals (rare, high-value drugs/implants) with return due date & replacement tracking; **donations** (CSR/government supplies e.g. free drug programmes) at zero/notional cost with donor tag & separate valuation bucket; **physician samples** never billable/dispensable for sale (blocked); **patient returns** (unopened, per OP-003 rules) restock with quarantine inspection.

### 3.15 Exceptions & edge cases
1. GRN reversal after partial issue → blocked; must reverse issues first or post negative adjustment with approval.
2. Batch merge/split when vendor labels differ from internal batch (same lot) → alias mapping, never duplicate SOH.
3. Expiry date only month/year on pack → stored as last day of month; alert windows use that.
4. Item deactivation with SOH > 0 → blocked until stock zero/transferred; item merge (duplicates) via EN-027 governance with ledger re-pointing recorded.
5. Store closure/relocation → mass transfer wizard; historical ledger retains original store id.
6. Count during active issues → freeze window per store or blind count with movement reconciliation (movements between snapshot & count time auto-adjust variance).
7. Ledger replay/rebuild of `stock_balances` from ledger (admin tool) after data incidents — idempotent, audited.
8. Sensor outage in cold-chain zone > 30 min → "unknown" state → manual thermometer readings required each 2 h until restored.

### 3.16 Configuration defaults (seed)
- Movement types & reason codes seeded; expiry alerts 90/60/30; min shelf life at receipt 6 months (drugs), 3 months (consumables); dead stock 180 days; ABC cut-offs 70/20/10 %; count frequencies A monthly/B quarterly/C half-yearly; adjustment approval bands ₹5k/₹50k; negative stock: main store block, ward stores allow_with_approval; valuation Weighted Average; UoM library (each, tab, cap, ml, g, vial, amp, strip, box, case, pack, roll, pair, set, cylinder).
- Store types & default allowed categories seeded per type; temperature zones: room (15–25 °C), cool (8–15 °C), cold (2–8 °C), frozen (≤ −18 °C).

## 4. Data Model (schema `inventory`)
- **items**: id, hospital_id, code, name, generic_name, drug_id? (EN-027), category_id, sub_category_id, item_type enum, base_uom, purchase_uom, issue_uom, uom_conversions jsonb [{from, to, factor}], hsn_sac, gst_rate_id (effective-dated link), is_mrp_controlled, tracking enum(none/batch/batch_expiry/serial/udi), storage_condition enum, temp_zone_required enum(none/room/cool/cold_2_8/frozen), min_shelf_life_days, is_lasa, is_high_alert, schedule_class, is_narcotic, is_consignment_allowed, is_capital, is_returnable, is_billable, billable_service_id?, manufacturer_id, default_vendor_ids uuid[], gtins jsonb [{gtin, pack_level, qty_base}], image_file_id, msds_file_id, abc_class, ved_class, fsn_class, xyz_class, status enum(draft/active/inactive/blocked), version. UNIQUE (hospital_id, code); GIN trigram on name/generic_name; INDEX (hospital_id, category_id, status).
- **item_brands** (generic ↔ brand mapping): generic_id, item_id, is_preferred; **item_substitutes**.
- **stores**: id, hospital_id, branch_id, code, name, store_type enum(main/pharmacy/ward/icu/ot/er/lab/radiology/cssd/dialysis/kitchen/housekeeping/engineering/ambulance/consignment/quarantine/other), parent_store_id, custodian_user_id, department_id, cost_centre_id, drug_licence_no, drug_licence_expiry, allowed_categories uuid[], negative_stock_policy enum(block/allow_with_approval), is_consignment bool, is_active.
- **store_locations**: id, store_id, path ltree (rack/shelf/bin), code, temp_zone_id?, capacity?, is_quarantine, is_expired_hold, barcode.
- **temp_zones**: id, store_id, name, min_c, max_c, sensor_device_id (EN-042), last_reading, last_reading_at, status enum(ok/excursion/hold).
- **temp_readings** (partitioned): zone_id, at, value_c, source; **temp_excursions**: zone_id, from, to, min, max, decision, decided_by, affected_batches jsonb.
- **item_store_params**: id, item_id, store_id, min_qty, max_qty, rol, roq, safety_stock, safety_auto bool, lead_days, par_level, review_days, bin_location_id, auto_indent bool, preferred_source_store_id, is_stocked, abc_class, ved_class, fsn_class, classification_history jsonb, last_movement_at, dead_stock_flag. UNIQUE (item_id, store_id).
- **item_batches**: id, hospital_id, item_id, batch_no, mfg_date, expiry_date, mrp, gtin?, vendor_id, grn_line_id?, unit_cost, purchase_uom_cost, coa_file_id?, status enum(active/quarantined/recalled/expired/exhausted), quarantine_reason, is_consignment bool, consignment_vendor_id?, serials jsonb?/child table **item_serials** (batch_id, serial_no, udi, status enum(in_stock/issued/used/returned/scrapped), current_store_id, patient_usage_ref?). UNIQUE (hospital_id, item_id, batch_no, vendor_id?) (config: batch unique per item).
- **stock_ledger** (partitioned monthly by `moved_at`): id, hospital_id, branch_id, store_id, location_id, item_id, batch_id?, serial_id?, movement_type enum(...), qty_base numeric(16,4), uom_entered, qty_entered, unit_cost, value, running_balance?, ref_type enum(grn/issue/transfer/dispense/consumption/adjustment/count/writeoff/return/recall/opening/repack), ref_id, ref_line_id, counter_store_id?, patient_id?, cost_centre_id?, actor_id, moved_at, remarks. INDEX (hospital_id, store_id, item_id, moved_at desc), (batch_id), (ref_type, ref_id), (patient_id) partial.
- **stock_balances**: hospital_id, store_id, location_id, item_id, batch_id?, qty_on_hand, qty_reserved, qty_quarantined, qty_in_transit_in, avg_cost, value, updated_at. UNIQUE (store_id, location_id, item_id, batch_id) — hot table, cached in Redis per store for SOH lookups.
- **fifo_layers** (when FIFO): store_id, item_id, batch_id, received_at, qty_remaining, unit_cost.
- **store_indents**: id, hospital_id, branch_id, indent_no, from_store_id (requesting), to_store_id (supplying), type enum(regular/par_topup/emergency/scheduled), status enum(draft/submitted/approved/picking/issued/partially_issued/received/closed/rejected/cancelled), requested_by, approved_by, required_by; **store_indent_lines** (item_id, uom, qty_requested, qty_approved, qty_issued, qty_received, remarks).
- **pick_lists**: indent_id/transfer_id, lines (item, batch suggested FEFO, location, qty, picked_qty, picked_by, scanned bool, override_reason).
- **issues**: id, hospital_id, issue_no, indent_id, from_store_id, to_store_id, issued_by, issued_at, status enum(issued/in_transit/received/discrepancy/closed); **issue_lines** (item_id, batch_id, qty, unit_cost, received_qty, discrepancy_reason).
- **returns_to_store**: id, return_no, from_store_id, to_store_id, reason, lines (item, batch, qty, condition), status, inspected_by.
- **transfers**: id, hospital_id, transfer_no, from_branch_id, to_branch_id, from_store_id, to_store_id, status enum(requested/approved/dispatched/in_transit/received/closed/cancelled), gate_pass_id?, tax_invoice_id?, eway_bill_no?, lines (item, batch, qty, value, received_qty).
- **adjustments**: id, hospital_id, store_id, adj_no, type enum(plus/minus/writeoff_expiry/writeoff_damage/repack/opening/donation/sample), reason_code, lines (item, batch, qty, cost, value), requested_by, approved_by, approval_instance_id, status, journal_ref, bmw_disposal_ref? (NC-016).
- **quarantines**: id, hospital_id, batch_id, scope enum(all_stores/store), reason enum(recall/quality/excursion/expiry/complaint), source_ref, started_at, released_at, decision enum(pending/released/returned/destroyed), decided_by; **recall_traces** (quarantine_id, ledger rows, patients).
- **count_plans**: id, hospital_id, store_id, type enum(cycle/full/narcotic/par/spot), scope jsonb (abc classes/categories/locations), scheduled_for, freeze_movements bool, blind bool, status; **count_sheets** (plan_id, location_id, assigned_to, status); **count_lines** (sheet_id, item_id, batch_id, system_qty_snapshot, counted_qty, recount_qty, variance_qty, variance_value, reason, adjustment_id?, counted_by, counted_at).
- **reorder_suggestions**: run_at, store_id, item_id, available, on_order, rol, suggested_qty, method, converted_to enum(purchase_indent/store_indent/ignored), converted_ref.
- **valuation_periods**: hospital_id, branch_id, period, method, status enum(open/closed), closing_value_by_store jsonb, journal_batch_id, closed_by; **valuation_snapshots** (period, store_id, item_id, batch_id, qty, unit_cost, value).
- **rfid_reads** (partitioned): reader_id, epc, at, direction; **rfid_tags** (epc, item_id/batch_id/serial_id).
- RLS on all; ledger append-only (trigger forbids UPDATE/DELETE); balances derived; `version` on editable masters.

## 5. Business Rules & Validations
- All quantities stored in base UoM; entered UoM/qty preserved; conversion factors immutable once movements exist (new conversion version instead).
- Stock changes only through ledger movements bound to a reference document; direct balance edits impossible; negative stock policy per store; reserved qty (OT case picks TR-003/IP-006, indent approvals) reduces available.
- Batch/expiry mandatory for `batch_expiry` items; serial/UDI mandatory for `serial/udi` items; expiry ≥ today for any inbound; expired batches auto-quarantined at 00:05 hospital time; quarantined/recalled/expired batches blocked from issue/dispense/consumption/transfer (except VENDOR_RETURN/WRITEOFF/RECALL_OUT).
- FEFO default on all picks/dispenses; override requires reason and permission; LASA/high-alert items require scan confirmation; narcotic movements require 2-person + register (OP-003 rules).
- Issue only against approved indent (or emergency issue permission); receiving store must acknowledge; discrepancy > 0 opens investigation; in-transit stock belongs to sender until receipt.
- Cold-chain items cannot be put away in a non-matching zone; excursion → automatic hold; release decision recorded.
- Adjustments/write-offs: reason codes; approval matrix by value (e.g. store in-charge ≤ ₹5k, admin ≤ ₹50k, finance above); count adjustments require completed count sheet; write-off of expired drugs generates NC-016 disposal record.
- Reorder: V (VED) items must have safety stock > 0; suggestions consider on-order and in-transit; consignment excluded; auto-convert to draft indents only if `auto_indent`.
- Valuation: method chosen at go-live (change via ADR + finance approval at period boundary); receipts at landed cost (NC-005 GRN); COGS at avg/FIFO at movement time; period close locks movements dated in closed period (back-dated entries only via approved adjustment in open period with reference).
- Inter-branch transfers with different GSTIN → tax invoice & e-way bill above threshold; intra-GSTIN transfers → delivery challan.
- Consignment stock (NC-007) always in `is_consignment=true` batches/locations, excluded from owned valuation and reorder.
- Store drug licence expiry blocks receipts of scheduled drugs after grace (warn 60 days).
- Retention: ledger 8 years online/archived; batch traceability for implants permanent (TR-003).

## 6. API Surface (`/api/v1/inventory`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | /items, /items/{id} ; POST /items/{id}/(activate|block) ; GET /items/search?q=&barcode= | item master | inventory.item.read/create/update | Y | cursor |
| GET/POST/PATCH | /stores, /stores/{id}, /stores/{id}/locations, /temp-zones | hierarchy | inventory.store.configure | Y | – |
| GET/PUT | /items/{id}/store-params/{storeId} ; POST /store-params/bulk | min/max/par | inventory.item.params | Y | – |
| GET | /stock?store=&item=&batch=&location=&expiring_days=&include_consignment= | balances | inventory.stock.read | – | cursor |
| GET | /stock/{itemId}/availability?stores= | cross-store availability | inventory.stock.read | – | – |
| GET | /ledger?store=&item=&batch=&from=&to=&type= | ledger | inventory.ledger.read | – | cursor |
| POST | /putaway | shelve received stock | inventory.stock.putaway | Y | – |
| GET/POST | /indents ; POST /indents/{id}/(submit|approve|reject|cancel) | store indents | inventory.store_indent.create/approve | Y | cursor |
| POST | /indents/{id}/pick-list ; POST /pick-lists/{id}/pick | FEFO picking | inventory.issue.pick | Y | – |
| POST | /issues ; POST /issues/{id}/receive ; POST /issues/emergency | issue & acknowledge | inventory.issue.create / .receive / .emergency | Y | cursor |
| POST | /returns ; POST /returns/{id}/inspect | returns to store | inventory.return.create / .inspect | Y | cursor |
| POST | /transfers ; POST /transfers/{id}/(approve|dispatch|receive|cancel) | transfers | inventory.transfer.create/approve/dispatch/receive | Y | cursor |
| POST | /adjustments ; POST /adjustments/{id}/(approve|post) | adjustments/write-offs | inventory.adjustment.create / .approve | Y | cursor |
| POST | /batches/{id}/quarantine, /release ; GET /batches/{id}/trace | recall/quarantine | inventory.batch.quarantine / .release / .trace | Y | – |
| GET | /expiry?days=90&store= ; POST /expiry/actions | expiry mgmt | inventory.expiry.manage | Y | cursor |
| POST | /temp-zones/{id}/readings (device) ; POST /temp-excursions/{id}/decide | cold chain | integration.iot.ingest / inventory.coldchain.decide | Y | – |
| GET | /reorder/suggestions?store= ; POST /reorder/run ; POST /reorder/convert | replenishment | inventory.reorder.manage | Y | cursor |
| POST | /counts/plans ; GET /counts/sheets?assignee=me ; POST /counts/lines (batch offline) ; POST /counts/plans/{id}/(recount|approve|post) | counts | inventory.count.plan / .count / .approve | Y | cursor |
| POST | /analysis/abc-ved/run ; GET /analysis/abc-ved?store= | classification | inventory.analysis.read / .run | Y | – |
| GET | /valuation?period=&store= ; POST /valuation/periods/{p}/close | valuation | inventory.valuation.read / .close | Y | – |
| POST | /labels/print (item/batch/bin) | labels | inventory.label.print | Y | – |
| POST | /rfid/reads (reader ingest) ; GET /rfid/reconcile | RFID | integration.rfid.ingest / inventory.rfid.read | Y | – |
| GET | /reports/(stock-register|expiry|abc-ved|dead-stock|variance|transfer-log|consumption-trend|valuation|movement-summary) | reports | inventory.report.read | – | – |
| POST | /import/opening-stock (EN-036) | migration | inventory.import | Y | – |
Internal service API (not public): `postMovement(tx, movement[])` used by NC-005/OP-003/NC-007/NC-008/IP-014 inside their transactions.

## 7. Domain Events (outbox)
- `inventory.item.created|updated|blocked` → OP-003, EN-027 sync, RC-003 (billable items), caches.
- `inventory.stock.moved` {ledger rows summary: store, item, batch, type, qty, value} → SOH caches, NC-008 (consumption), NC-009 (valuation summaries), OP-003, dashboards.
- `inventory.stock.low` {store, item, available, rol} / `inventory.reorder.suggested` {suggestions[]} → NC-005 (draft indents), store in-charge.
- `inventory.issue.completed`, `inventory.transfer.dispatched|received|discrepancy` → receiving stores, EN-015 (gate pass), NC-009 (inter-branch).
- `inventory.batch.expiring` {batch, days, stores} / `inventory.batch.expired` / `inventory.batch.written_off` → OP-003, NC-007 (consignment return), NC-016 (disposal), NC-011.
- `inventory.batch.quarantined|released` {batch, reason, affected_stores, trace} → OP-003/IP-014 (block), TR-003 (implants), NC-021 vendor.
- `inventory.temp.excursion` {zone, min, max, batches} → pharmacist/quality push, EN-037.
- `inventory.count.completed` {plan, variance_value} → NC-009 journal, admin.
- `inventory.valuation.period_closed` {period, values} → NC-009, NC-011.
- Consumes: `purchase.grn.accepted|reversed`, `purchase.return.dispatched` (NC-005), `pharmacy.dispensed|returned` (OP-003/IP-014 via service call), `consumption.recorded` (NC-008), `consignment.*` (NC-007), `iot.temp.reading` (EN-042), `implant.used` (TR-003 → serial status), `patient.merged`.

## 8. Screens (UI)
- **Store dashboard** — desktop: stock value, low-stock count, expiring 30/60/90, pending indents, in-transit, cold-chain status tiles, dead stock; realtime.
- **Item master** — desktop: form with UoM conversion builder, barcodes, classifications, store params grid; `Ctrl+S`; duplicate detection by name/GTIN.
- **Stock enquiry** — desktop/tablet/phone: search item → per store/batch/expiry/location; `F3` search, scan barcode to jump; consignment toggle.
- **Indent & issue console** — desktop: pending indents, availability check, pick list with FEFO batches, scanner-driven picking (`Enter` next line), print issue note; tablet for aisle picking with offline pick buffer.
- **Receiving/put-away** — tablet/handheld: scan batch → bin suggestion → confirm.
- **Ward/sub-store app** — tablet/phone: par-level top-up indent (one tap), receive issue (scan), return, count; offline queue.
- **Transfer console**, **Adjustment/write-off form** (approval status), **Quarantine & recall board** (trace tree), **Expiry manager** (bulk actions), **Cold-chain monitor** (zone tiles, graphs, excursion tasks; TV option in pharmacy), **Cycle count handheld** (blind count, offline), **Count reconciliation** (variances, approve), **ABC/VED matrix view**, **Reorder suggestions** (edit qty, convert), **Valuation & period close** (accountant), **RFID reconciliation**.
- Keyboard: `F2` new indent, `F4` stock enquiry, `F6` issue, `F8` transfer, `Ctrl+P` print labels; barcode focus trap; empty/error/loading states.

## 9. Integrations
- EN-013 barcode/GS1 parsing & ZPL labels; RFID readers (LLRP/vendor SDK) via EN-042 gateway; temperature sensors (MQTT/HTTP) via EN-042; NC-005 GRN/returns; NC-009 journals; OP-003/IP-014 dispensing via internal service; NC-008 consumption; NC-007 consignment; TR-003 implants; EN-003 CSSD tray items; EN-015 gate pass; GST e-way bill (via NC-009/EN-017); EN-036 opening stock import; AI-005 forecasting feed.

## 10. Reports & Analytics
- Stock register (item/batch/store/location, value), stock statement per period (opening/receipts/issues/closing), expiry report (30/60/90, value at risk), dead/slow stock, ABC/VED/FSN matrices, reorder report, indent fulfilment rate & TAT, issue/transfer logs, count variance (qty/value by store/counter), quarantine/recall register with patient trace, cold-chain compliance (excursions/month), consumption trend per item/store (with NC-008), valuation & COGS by store/category, inventory turnover ratio, days of inventory on hand, stock-out incidents, LASA/high-alert stock audits, narcotic balance (OP-003), inter-branch transfer register (GST). Read models: `analytics.stock_daily_snapshot` (store, item, qty, value), `analytics.stock_movement_monthly`, `analytics.expiry_risk`, `analytics.inventory_kpis`.

## 11. Notifications
- Store in-charge: low stock/ROL breach (digest + critical push for V items), expiring batches weekly, indent submitted, transfer received/discrepancy, count due, dead stock monthly.
- Pharmacist/quality: cold-chain excursion (immediate push/SMS), quarantine/recall notices, expired items auto-quarantined.
- Ward custodian: issue dispatched/arrived, par-level top-up reminders, count reminders.
- Finance: period close, write-offs above threshold, valuation summary.
- Vendors (via NC-021): near-expiry return requests.

## 12. Permissions (RBAC keys)
`inventory.item.read/create/update/params/import`, `inventory.store.configure`, `inventory.stock.read/putaway`, `inventory.ledger.read`, `inventory.store_indent.create/approve`, `inventory.issue.pick/create/receive/emergency`, `inventory.return.create/inspect`, `inventory.transfer.create/approve/dispatch/receive`, `inventory.adjustment.create/approve`, `inventory.batch.quarantine/release/trace`, `inventory.expiry.manage`, `inventory.coldchain.decide`, `inventory.reorder.manage`, `inventory.count.plan/count/approve`, `inventory.analysis.read/run`, `inventory.valuation.read/close`, `inventory.label.print`, `inventory.rfid.read`, `inventory.report.read`, `inventory.export`, `inventory.fefo.override`, `inventory.negative_stock.override`. ABAC: `own_store_only` (custodians), `amount_limit` (adjustment approvals), `requires_second_person` (narcotics with OP-003).

## 13. Non-functional
- Volumes: 40k items, 200 stores, 1.5M ledger rows/month (pharmacy dispensing dominant), 100k balance rows; SOH lookup p95 < 50 ms (Redis) / < 150 ms DB; movement post < 100 ms per line; FEFO pick generation < 500 ms for 100 lines; nightly reorder run for 200 stores < 5 min; count sheet load 5k lines virtualised.
- Partitioning `stock_ledger` monthly (pg_partman); balances hot table with fillfactor 70; read replicas for reports.
- Offline: handheld counts and ward par indents queue in IndexedDB; issue/receive require online.
- Printing: ZPL labels (item/batch/bin), issue/transfer notes A4/A5, count sheets.
- Accessibility/i18n: scanner-first flows with keyboard fallback; UoM labels localised; WCAG 2.2 AA.
- Security: audit on all adjustments/overrides; SoD for count vs approve; RLS per hospital; store scoping.

## 14. Acceptance Criteria
1. Given an item with conversions strip=10 tab, box=10 strips, when GRN receives 5 boxes, then ledger records 500 base units and stock enquiry displays 5 box / 50 strips / 500 tabs.
2. Given batches A (exp 2026-09) and B (exp 2026-12) of the same item, when a pick list is generated, then A is suggested first; picking B first requires an override reason and is audited.
3. Given a batch expiring today, then at 00:05 it moves to expired hold and any issue/dispense attempt is refused with a clear message.
4. Given a ward indent for 20 units with only 12 available, when store approves 12 and issues, then the indent shows partial, ward acknowledges 12, and the remaining 8 stays open or is cancelled explicitly.
5. Given the receiving ward acknowledges 11 of 12 issued, then a discrepancy of 1 is raised, sender's stock is not credited back automatically, and investigation task is created.
6. Given a fridge zone reading 11 °C for 30 min, then an excursion is opened, batches in that zone are put on hold, pharmacist notified, and release requires a recorded decision.
7. Given a recall on batch X, when quarantined, then all stores' balances show quarantined qty, OP-003 cannot dispense it, and the trace lists issues/dispenses/patients touching X.
8. Given item with ROL 100 and available 80 (on hand 60 + on order 20), then nightly reorder suggests (max − available) and creates a draft purchase indent if auto_indent.
9. Given a blind cycle count where counted 95 vs system 100 (value ₹5,000), then variance requires approval per matrix, on approval a COUNT_ADJUST posting of −5 and NC-009 journal exist.
10. Given negative_stock_policy=block on main store, when an issue exceeds available, then rejected; on a ward store with allow_with_approval, an emergency issue creates a pending approval and negative balance flag.
11. Given consignment stock in the OT consignment location, then stock valuation excludes it and reorder ignores it while availability views can include it via toggle.
12. Given inter-branch transfer between different GSTINs worth ₹80,000, then a tax invoice and e-way bill reference are mandatory before dispatch.
13. Given monthly ABC/VED run, then items are reclassified, history retained, and A/V items get monthly count schedules automatically.
14. Given period March closed, when a movement dated 28 March is attempted in April, then it is refused unless posted as an approved adjustment dated in April referencing March.
15. Given a store drug licence expired 61 days ago, then GRN of Schedule H drugs to that store is blocked with message; other items unaffected.
16. Given an auditor exports the stock register, then the export is audited and no mutation endpoints are permitted.
17. Given a 5 L bulk antiseptic repacked into 50 × 100 ml, then REPACK_OUT/IN movements preserve batch/expiry, unit cost = bulk cost/50 (+ packaging), and 50 new pack labels print.
18. Given a GRN with two issues already made against its batch, when a GRN reversal is attempted, then it is blocked with a list of dependent movements.
19. Given a cold-chain sensor offline for 40 minutes, then the zone shows "unknown", manual readings are demanded every 2 h and batches are not auto-held unless a manual reading is out of range.
20. Given a physician sample batch, then dispensing for sale/billing is blocked while issue to a doctor for patient use is allowed and logged.
21. Given a blind count started at 10:00 with snapshot, when an issue occurs at 10:20 before the count line is entered, then the variance calculation adjusts for the movement and shows zero variance if physical matches.

## 15. Enhancements / Later phases
- From VIMS sheet: RFID stock movement tracking (`inventory.rfid`, Phase 9/12 with EN-042), temperature-sensitive zone management (`inventory.temperature_zones`, Phase 4 core with sensors Phase 8/12), dead stock auto-identification (Phase 4 job), multi-unit conversion strip↔box↔case (`inventory.multi_uom`, Phase 4 core), safety stock auto-calculation (Phase 4 job, refined by AI-005).
- (market) Duplicate item analyser / AI inventory clean-up (AI-003/AI-005), sub-store limits & main/sub-store closing-opening balances, stock disposal vouchers, patient replacement stock-in, VMI/consignment kanban, drone/pneumatic dispatch integration, predictive stock-out alerts, mobile RFID stock take, cost-per-patient supply analytics (with NC-008), sustainability (waste reduction) analytics.

## 16. Open Questions for the Hospital
1. Store hierarchy per branch (list of stores/sub-stores, custodians, drug licences) and which wards hold par stock?
2. Valuation method (Weighted Average vs FIFO) and go-live opening stock source/format; cut-over date and freeze plan?
3. UoM policy: allow loose issue (tablets) at wards; pack levels and barcode availability from vendors?
4. Expiry thresholds (min shelf life at receipt, alert days) and near-expiry return arrangements with vendors?
5. Negative stock policy per store; emergency issue authority at night?
6. Cycle count frequencies and approval matrix values for adjustments/write-offs?
7. Cold-chain: number of fridges/freezers, existing sensors/data loggers (brand/protocol)?
8. RFID scope (implants, linen, high-value) now or later?
9. Inter-branch transfers: same GSTIN? e-way bill practice?
10. VED classification owner (pharmacy & therapeutics committee) and initial lists?
