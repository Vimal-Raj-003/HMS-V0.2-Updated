# NC-007 — Consignment Management (Implants/Devices, Usage-Based Billing, Auto-PO, Reconciliation, Expiry Return)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-007 |
| Phase | 4 (core; OT usage capture with TR-003/IP-006 in Phase 6/7) |
| Priority | P0 |
| Complexity | Medium |
| Complexity note | Ortho/trauma implants are the primary consignment class for the client (FAMI CARE trauma centre) |
| Depends on | NC-006 (ledger, batches/serials, consignment locations, quarantine), NC-005 (auto-PO, GRN type consignment, invoice 3-way match), NC-021 (consignment vendor agreements, portal), TR-003 (implant registry — patient trace, UDI, recalls, loaner sets), IP-006/TR-004 (OT usage capture), OP-010/OP-039 (procedure usage), OP-029 (cath lab stents/devices), OP-025 (IOLs), OP-005/IP-005 (patient billing of implants at tariff), RC-003 (implant tariffs, payer caps), EN-002/RC-007 (payer implant rules, PMJAY implant packages), NC-009 (liability accrual, AP), EN-013 (GS1/UDI scan), EN-038 (approvals), NC-011, EN-024 |
| Feature flag | `module.consignment.enabled` (sub: `consignment.vendor_portal`, `consignment.auto_billing`, `consignment.loaner_sets`) |
| Primary roles | Consignment Coordinator / Implant Store Keeper (44), OT Store Nurse / Scrub nurse (20, usage scan), Purchase Officer (45), Accounts Payable (46) |
| Secondary roles | Surgeon (9, selection & implant confirmation), Cath-lab/procedure staff, Billing (27), Insurance desk (28), Vendor (63, portal), Quality (54, audits/recall), Auditor (58), Hospital Admin (2) |
| Regulatory | Medical Devices Rules 2017 & CDSCO UDI (traceability of implants — GS1 GTIN/lot/serial/expiry), NABH (implant traceability, patient records), GST (consignment = supply on usage; vendor tax invoice on usage; ITC; stock held on behalf of vendor not hospital's inventory), Companies Act/IndAS 2 (consignment stock excluded from inventory; liability on use), IRDAI/PMJAY (implant billing at capped rates, MRP disclosure), Legal Metrology (MRP on implant packs), Consumer Protection (itemised implant charges), Drugs & Cosmetics Act (device licence Form MD-42 etc. of vendor) |

## 1. Purpose
NC-007 manages **vendor-owned stock held in the hospital** — orthopaedic implants (plates, screws, nails, prostheses), spinal hardware, cardiac stents/pacemakers, IOLs, staplers, high-value disposables — from agreement setup and stock-in (with UDI/serial/batch/expiry) through OT/procedure **usage scanning that simultaneously bills the patient, creates the auto-PO/GRN to the vendor and records patient traceability**, to monthly vendor reconciliation, expiry/near-expiry returns, physical counts and audits. Consignment stock stays segregated from owned inventory in NC-006, and hospital liability arises only on usage.

## 2. Users & Jobs-to-be-done
- **Consignment coordinator** (desktop + scanner in implant store): set up vendor agreements and price lists, receive consignment stock (bulk kits/sets), maintain segregated locations, run monthly reconciliation with vendor statements, process returns/replacements, count stock, resolve discrepancies.
- **OT/procedure staff** (tablet/desktop with scanner in OT store & theatre): pick sets for cases, scan implants used, return unused, log opened-not-used, ensure patient linkage.
- **Surgeon**: verify implant list on op note (TR-003/IP-006), confirm sizes.
- **Purchase/AP**: review auto-POs, match vendor invoices (3-way: usage/auto-PO ↔ auto-GRN ↔ invoice), pay per terms.
- **Billing/insurance**: patient bill lines with implant details (name, size, batch/serial, MRP, negotiated rate, payer cap), stickers/UDI on claim documents.
- **Vendor**: via portal — see stock at hospital, usage, POs, submit invoices, statements, arrange replenishment/returns.
- **Quality/auditor**: consignment audit checklist, recall handling, valuation exclusion checks.

## 3. Core Workflows

### 3.1 Vendor & agreement setup
1. **Coordinator** selects vendor (NC-021; must have device licence docs) → agreement: items on consignment (item master NC-006 with `is_consignment_allowed`, UDI-DI/GTIN mapping), **pricing terms** per item (vendor price to hospital, MRP, price validity, discounts/slabs, replacement policy, min stock/kit composition, replenishment SLA days, expiry return window (e.g. ≥ 90 days before expiry), damage/loss liability, invoicing cycle (per usage/weekly/monthly), payment terms, GST), storage locations in hospital (OT store racks/consignment cage per specialty), authorised vendor reps, audit rights → approval (EN-038) → status active → Event `consignment.agreement.activated`.
2. Hospital tariff for patient billing (RC-003): implant selling price rules (MRP / MRP−x % / cost + margin / payer-specific caps e.g. PMJAY implant rates) linked to item.

### 3.2 Consignment stock-in
1. Vendor delivers set/kit/pieces with delivery challan (not tax invoice) → **Coordinator** creates consignment receipt (`CSN_IN` series): scan each pack GS1/UDI (GTIN → item, lot, expiry, serial), qty, kit/set id, condition, sterile status; validates expiry ≥ agreed min, item in agreement, licence valid → NC-006 movement `CONSIGNMENT_IN` into consignment location, batch flagged `is_consignment=true`, `consignment_vendor_id` → challan matched; vendor portal shows stock at hospital → Event `consignment.stock.received`.
2. **Loaner sets** (`consignment.loaner_sets`, with TR-003): case-specific sets brought for a surgery: check-in (contents scan/list, sterilisation via EN-003), post-case check-out with used items reconciled → used items become usage (3.3), rest returned same visit.
3. Kit composition template per procedure (e.g. DHS set, PFN set with sizes) with min counts; shortage after usage triggers replenishment request to vendor (auto if SLA).

### 3.3 Usage capture → billing → auto-PO (single scan)
1. **Scrub/OT store nurse** on OT case (IP-006/TR-004) or procedure (OP-010/OP-029/OP-025) opens "Implants & consignment" panel → scans pack barcode → **System**: identifies consignment batch/serial, checks not expired/recalled/quarantined, matches surgeon's plan (TR-003 planned implants; warns on mismatch), captures qty, side/site, **patient link** (encounter, surgeon, procedure) → creates `consignment_usage` (status `used`) → in one transaction: (a) NC-006 movement `CONSIGNMENT_USED` (out of consignment location), (b) TR-003 `implant_usage` record (traceability, sticker capture), (c) **patient bill line** (OP-005/IP-005 via NC-008 auto-charge: item, size, batch/serial, MRP, hospital rate/payer cap, GST if applicable, implant sticker image), (d) **auto-PO** to vendor at agreement price (NC-005 `consignment_auto` PO, grouped per invoicing cycle: per-usage PO or one open PO per vendor per month accumulating lines) and **auto-GRN** (deemed receipt at usage) so 3-way match works with vendor invoice → Event `consignment.usage.recorded`.
2. **Opened-not-used / dropped / contaminated**: recorded as `wasted` with reason & responsibility (hospital pays per agreement or vendor goodwill) → auto-PO line flagged `wastage` (not billed to patient unless policy) → approvals.
3. **Explant/return-to-stock**: implant scanned but not implanted (size change) and pack unopened → reverse usage within case (audited) → back to consignment stock; opened sterile-compromised → wastage.
4. **Un-scanned usage detection**: post-case, count reconciliation of set vs pre-case list; op note implants (TR-003) without consignment usage → alert; billing leakage checks (RC-006).
5. Manual usage entry (no barcode) requires photo of sticker & supervisor approval.

### 3.4 Vendor invoicing & reconciliation
1. Vendor raises tax invoice for used items (per usage/weekly/monthly) → captured in NC-005 invoice capture (portal upload) → **3-way match**: invoice lines ↔ auto-PO/auto-GRN usage lines by UDI/lot/serial & price → matched → AP (NC-009) → payment; mismatches (price ≠ agreement, unused item invoiced, duplicate) → dispute tasks to coordinator/vendor.
2. **Monthly reconciliation** (`consignment_reconciliations`): system statement (opening consignment stock + receipts − usage − returns − wastage = closing) vs vendor statement (upload/portal) → auto-match by UDI/lot/serial → buckets: matched / hospital-only / vendor-only / price mismatch / qty mismatch → resolution (missing scan → create usage & bill if patient identifiable else hospital write-off; vendor error → vendor corrects) → sign-off both parties (portal e-sign) → Event `consignment.reconciliation.signed`.
3. **Real-time consignment value** dashboard: value of vendor stock on hand (at agreement price) per vendor/location, usage value MTD, unbilled/uninvoiced value, disputes (VIMS enhancement).

### 3.5 Physical count & discrepancy resolution
- Scheduled counts (monthly for consignment cages; per set on check-in/out) with handheld scanning; discrepancy (missing item) → investigation → outcomes: found (adjust), lost (hospital liable → PO/payment per agreement) or vendor error → adjustment movements with approvals; audit checklist (VIMS enhancement): segregation, labelling, expiry status, sterility, agreement validity, temperature (biologics) → NC-015 indicator.

### 3.6 Expiry & near-expiry return
- Nightly: consignment batches within return window (e.g. 90/60 days) → **return proposal** to vendor (list, challan) → vendor collects → NC-006 `CONSIGNMENT_RETURN` → vendor acknowledges on portal → replacement receipt; expired consignment items are vendor's loss (no financial impact) but must be quarantined and removed; auto-generation of return notes (VIMS "expired item auto-return processing") with configurable auto-approve for pure expiry returns → Event `consignment.return.dispatched|acknowledged`.

### 3.7 Recall
- TR-003/NC-006 quarantine on recall → consignment stock blocked; used items → patient list (TR-003) → vendor coordination; replacement stock.

### 3.8 Vendor portal (`consignment.vendor_portal`, NC-021)
- Vendor sees: stock at hospital by location/expiry, usage feed (de-identified: case id, item, date; no PHI beyond what invoice needs), POs, invoices & payment status, returns, reconciliation statements, replenishment requests; can upload challans/invoices/statements; notifications.

### 3.9 Cath-lab / ophthalmology / general surgery variants
- **Cath lab (OP-029)**: stents/balloons/pacemakers/ICDs — usage panel embedded in cath-lab procedure record; PMJAY/NPPA price-cap items (coronary stents ceiling price) validated against MRP ceiling master; device implant card generation for patient (TR-003 sticker/serial); loaner programmers.
- **Ophthalmology (OP-025)**: IOL power/type consignment sets; usage at case with power selection; return-to-set counts.
- **General/laparoscopic**: staplers/reloads/energy devices per case kits; hemostats.
- **Pharmacy consignment** (rare): high-cost oncology drugs on consignment (OP-031) — usage on administration record (IP-003 MAR) rather than OT scan.

### 3.10 Agreement end / vendor change
- On termination: freeze stock-in, reconcile, return all remaining stock (return note), settle wastage/loss, close auto-PO batches, archive prices; if vendor replaced for same items, kit templates re-mapped; patients' traceability unaffected.

### 3.11 Exceptions & edge cases
1. Barcode unreadable/absent (legacy packs) → manual UDI entry + sticker photo + supervisor approval (3.3.5); vendor asked to relabel via portal.
2. Same GTIN supplied by two vendors on consignment → agreement item disambiguation by location/kit; scan prompts vendor pick if ambiguous.
3. Usage scanned for a serial already marked returned to vendor → blocked; investigate return note.
4. Price valid_to lapsed at usage date → usage allowed (clinical priority) but auto-PO line flagged `price_pending`; coordinator resolves before invoicing.
5. Patient bill finalised & claim submitted, then vendor statement reveals extra usage → create usage with `late_charge` path (IP-005 supplementary bill / hospital write-off decision) — audited.
6. Recall after implantation → TR-003 patient notification workflow; consignment stock quarantined; vendor credit for unused units.
7. Kit checked out to OT for a case that gets cancelled → kit returned to cage with count; no usage.
8. Multi-branch: consignment stock per branch/agreement; inter-branch transfer of consignment stock only with vendor consent (recorded) — otherwise return & re-supply.

### 3.12 Configuration defaults (seed)
- Invoicing cycle monthly; expiry return window 90 days; count frequency monthly; variance tolerance 0 units; wastage approval threshold ₹10,000; price tolerance 0; reconciliation sign-off SLA 15 days after month end; unresolved hospital-only usage escalation 30 days; auto-return proposals enabled; loaner-set CSSD turnaround 12 h.

## 4. Data Model (schema `inventory`, prefix `csn_`)
- **csn_agreements**: id, hospital_id, branch_id?, vendor_id, agreement_no, start_date, end_date, invoicing_cycle enum(per_usage/weekly/fortnightly/monthly), payment_terms_days, expiry_return_days_before, wastage_policy enum(hospital_pays/vendor_absorbs/case_by_case), loss_policy, replenishment_sla_days, storage_location_ids uuid[], vendor_reps jsonb, document_id (NC-004/NC-031), status enum(draft/pending_approval/active/expiring/expired/terminated), approved_by, version. UNIQUE (hospital_id, agreement_no).
- **csn_agreement_items**: agreement_id, item_id, gtin/udi_di, vendor_item_code, vendor_price, currency, mrp, gst_rate, price_valid_from, price_valid_to, min_stock, kit_template_id?, replacement_policy, status. UNIQUE (agreement_id, item_id, price_valid_from).
- **csn_kit_templates**: id, hospital_id, vendor_id, name (e.g. "PFN A2 set"), specialty, lines jsonb [{item_id, size, min_qty}]; **csn_kits** (physical sets): id, kit_template_id?, vendor_id, kit_code, location_id, status enum(in_hospital/checked_out/returned/loaner_in), last_count_at.
- **csn_receipts**: id, hospital_id, branch_id, receipt_no, agreement_id, vendor_id, challan_no, challan_date, kit_id?, received_by, received_at, status enum(draft/posted/cancelled), portal_ack_at; **csn_receipt_lines** (receipt_id, item_id, batch_id (NC-006, is_consignment), serial_id?, gtin, lot, expiry, qty, vendor_price_snapshot, sterile bool, condition).
- **csn_stock_view** (materialised/read model): vendor_id, item_id, batch_id, serial_id, location_id, qty, expiry, days_to_expiry, agreement_price, value.
- **csn_usages**: id, hospital_id, branch_id, usage_no, agreement_id, vendor_id, item_id, batch_id, serial_id?, qty, patient_id, encounter_id, procedure_ref (ot_case_id/procedure_id), surgeon_id, scanned_by, scanned_at, side, site, status enum(used/wasted/reversed), waste_reason?, waste_liability enum(hospital/vendor/pending), implant_usage_id (TR-003), bill_item_id (OP-005/IP-005), billed_amount, payer_cap_applied?, auto_po_id, auto_po_line_id, auto_grn_id, vendor_price_snapshot, sticker_image_id?, manual_entry bool, approved_by?, reversed_reason?, reversal_of?. INDEX (hospital_id, vendor_id, scanned_at desc), (patient_id), (batch_id), (auto_po_id).
- **csn_auto_po_batches**: vendor_id, cycle_period, po_id (NC-005), status enum(open/closed/invoiced), lines_count, value.
- **csn_returns**: id, hospital_id, return_no, vendor_id, reason enum(near_expiry/expired/excess/recall/agreement_end/damaged), lines (item, batch, serial, qty, expiry), status enum(proposed/approved/dispatched/acknowledged/replaced/closed), auto_generated bool, dispatched_at, vendor_ack_at, replacement_receipt_id?.
- **csn_reconciliations**: id, hospital_id, vendor_id, period, system_statement jsonb {opening, receipts, usage, wastage, returns, closing}, vendor_statement_file_id, vendor_statement jsonb, status enum(draft/matching/disputed/agreed/signed), hospital_signed_by/at, vendor_signed_by/at, esign_ids; **csn_reconciliation_lines** (recon_id, item_id, batch/serial, source enum(both/hospital_only/vendor_only), system_qty, vendor_qty, system_price, vendor_price, difference, resolution enum(pending/create_usage/vendor_correct/hospital_writeoff/price_adjust/ignore), resolved_by, notes).
- **csn_counts**: id, hospital_id, vendor_id?, location_id, scheduled_at, status, lines (item, batch, serial, expected, counted, variance, resolution enum(found/lost_hospital_liable/vendor_error/adjust)), checklist jsonb (audit items), signed_by.
- **csn_disputes**: id, source enum(invoice/reconciliation/count), ref_id, vendor_id, description, amount, status, resolution.
- Ledger movements live in NC-006 `stock_ledger` (types CONSIGNMENT_IN/USED/RETURN/ADJUST) with `batch.is_consignment=true`; RLS everywhere; usages never hard-deleted (reversal rows).

## 5. Business Rules & Validations
- Consignment stock only in agreement-designated locations and batches flagged consignment; never mixed with owned batches; excluded from owned valuation, reorder and hospital insurance schedule (unless agreement says otherwise).
- Stock-in only for items in an active agreement with valid price; expiry must exceed `expiry_return_days_before` + buffer; vendor device licence & agreement documents current.
- Usage requires patient encounter and procedure context; scan mandatory (manual entry with photo + supervisor approval); item must not be expired/recalled/quarantined; duplicate serial usage blocked; qty for serialised items = 1.
- Usage transaction is atomic across ledger, TR-003 registry, bill line and auto-PO/GRN — any failure rolls back all; idempotent by scan token.
- Patient price from RC-003 rules; payer caps (PMJAY/insurer) applied with visibility of MRP and hospital rate; GST per HSN (implants 5/12 %) on patient invoice as per OP-005 tax engine; vendor price snapshot frozen at usage.
- Wastage: liability per agreement; hospital-paid wastage never billed to patient by default (config); wastage above threshold needs approval.
- Reversal allowed only same case/day before bill finalisation; later corrections via credit note (OP-005) + reversal usage + vendor credit note.
- Vendor invoice must reference usage lines (UDI/lot/serial); price must equal agreement price valid on usage date (tolerance 0); invoice for un-used items rejected; duplicate invoice blocked; invoicing cycle enforced.
- Reconciliation monthly mandatory per vendor; unresolved hospital-only usages > 30 days escalate; sign-off by both parties; period locks after sign.
- Near-expiry returns auto-proposed; expired consignment items quarantined and returned; hospital never bears expiry loss unless agreement clause.
- Counts: monthly; missing items resolved within 15 days; lost → hospital liability PO with approval.
- Retention: usage/traceability permanent (implants), financial 8 years.

## 6. API Surface (`/api/v1/consignment`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | /agreements, /agreements/{id} ; POST /agreements/{id}/(approve|terminate) ; /agreements/{id}/items | agreements & prices | inventory.consignment.agreement.manage / .approve | Y | cursor |
| GET/POST | /kit-templates, /kits ; POST /kits/{id}/(check-in|check-out) | kits & loaner sets | inventory.consignment.kit.manage | Y | cursor |
| POST | /receipts ; POST /receipts/{id}/post ; GET /receipts | stock-in | inventory.consignment.receive | Y | cursor |
| GET | /stock?vendor=&location=&item=&expiring_days= | consignment stock | inventory.consignment.stock.read | – | cursor |
| POST | /usages (scan payload: barcode, encounter, procedure, surgeon, side) | usage → bill → auto-PO | inventory.consignment.use | Y (scan token) | – |
| POST | /usages/{id}/(reverse|mark-wasted|approve-manual) | corrections | inventory.consignment.use / .approve | Y | – |
| GET | /usages?patient=&vendor=&case=&from=&to= | usage feed | inventory.consignment.usage.read | – | cursor |
| GET | /cases/{caseId}/reconcile | set vs usage check post-case | inventory.consignment.use | – | – |
| GET | /auto-pos?vendor=&period= ; POST /auto-pos/{id}/close | auto-PO batches | inventory.consignment.po.read / .close | Y | cursor |
| POST | /returns ; POST /returns/{id}/(approve|dispatch|ack) ; GET /returns | returns | inventory.consignment.return.manage | Y | cursor |
| POST | /reconciliations ; POST /reconciliations/{id}/(upload-vendor-statement|match|resolve-line|sign) ; GET /reconciliations | reconciliation | inventory.consignment.reconcile / .sign | Y | cursor |
| POST | /counts ; POST /counts/{id}/(lines|close) | counts & audit checklist | inventory.consignment.count | Y | cursor |
| GET/POST | /disputes | disputes | inventory.consignment.dispute.manage | Y | cursor |
| GET | /dashboard/value?vendor= | real-time consignment value | inventory.consignment.report | – | – |
| GET | /reports/(stock-register|usage|reconciliation|expiry-returns|wastage|auto-po|audit-checklist) | reports | inventory.consignment.report | – | – |
| Vendor portal (NC-021 scope) | GET /vendor/stock, /vendor/usages, /vendor/pos, /vendor/returns ; POST /vendor/statements, /vendor/invoices, /vendor/reconciliations/{id}/sign | portal | vendor.consignment.* | Y | cursor |

## 7. Domain Events (outbox)
- `consignment.agreement.activated|expiring|terminated` → NC-021, NC-005, EN-037.
- `consignment.stock.received` {receipt_id, vendor, lines} → NC-006 (ledger done in-tx; event for caches), TR-003 (implant units), vendor portal.
- `consignment.usage.recorded` {usage_id, patient_id, encounter, item, batch, serial, price, bill_item_id, auto_po_line} → OP-005/IP-005 (already posted in-tx; event for RC-006 leakage cross-check), TR-003, NC-009 (liability accrual), NC-011, vendor portal, EN-002 (claim documents).
- `consignment.usage.reversed|wasted` → billing credit note trigger, vendor portal.
- `consignment.auto_po.created|closed` → NC-005 (PO/GRN records), NC-021.
- `consignment.return.proposed|dispatched|acknowledged` → NC-006 movements, vendor.
- `consignment.reconciliation.disputed|signed` {vendor, period, differences} → NC-009 (accrual true-up), NC-021 vendor score, admin.
- `consignment.count.discrepancy` → coordinator, admin.
- Consumes: `implant.planned` (TR-003 → picking list), `ot.case.closed` (IP-006/TR-004 → set reconciliation), `inventory.batch.quarantined|expiring` (NC-006), `purchase.invoice.matched|disputed` (NC-005), `vendor.blacklisted` (NC-021), `bill.finalized` (OP-005 → lock usage), `claim.submitted` (EN-002).

## 8. Screens (UI)
- **Consignment dashboard** — desktop: value on hand by vendor, usage MTD, uninvoiced value, disputes, expiring in 60/90 days, kits checked out, reconciliation status; realtime.
- **Agreement & price list editor** — desktop: items grid with price validity, kit templates, documents.
- **Stock-in (receipt)** — desktop/tablet + scanner: scan-to-add lines, GS1 parse preview, kit assignment, challan capture, post.
- **OT usage panel** (embedded in IP-006/TR-004/OP-010 case screen) — tablet/desktop with scanner: planned implants list (TR-003), scan → line appears with size/expiry/price/payer cap, wasted toggle, side/site, sticker photo, running bill impact; `Enter` scan focus, `W` mark wasted, `Ctrl+Z` reverse (with reason); works offline in OT with queue (usage syncs post-case; billing/auto-PO fire on sync with idempotency).
- **Case reconciliation** — tablet: pre-case set contents vs post-case scans; unmatched → resolve.
- **Reconciliation workbench** — desktop: system vs vendor statement columns, buckets, per-line resolution, sign-off with e-sign; export.
- **Returns manager** — desktop: auto proposals, approve/dispatch/ack.
- **Count & audit checklist** — handheld/tablet: scan count, checklist items, photos; offline.
- **Vendor portal pages** (NC-021).
- Empty/error states; keyboard scanner-first.

### 8.1 Screen behaviours (detail)
- **OT usage panel**: barcode focus trap; on scan → 300 ms lookup → row with colour state (green ok / amber warning e.g. plan mismatch / red blocked); audible cue; running "vendor cost vs patient charge" hidden from patient-facing displays; batch scan mode for multiple screws (qty increment per scan of same serial-less lot); undo within 30 s without reason (pre-commit buffer), later reversal with reason.
- **Reconciliation workbench**: side-by-side grids with column-linked highlighting; keyboard `M` match, `U` unmatch, `R` resolve; bulk resolve by rule (e.g. all price mismatches ≤ ₹10 → accept); export discrepancies to vendor as Excel/portal message.
- **Stock-in**: duplicate serial detection across hospital; expiry colour bands (< 90 days red); kit template completion indicator.

## 9. Integrations
- EN-013 GS1/UDI parsing (AI 01/10/17/21; HIBCC), label printing; NC-006 ledger service (in-transaction); TR-003 registry; OP-005/IP-005 auto-charge via NC-008; RC-003 tariff & payer caps; NC-005 auto-PO/GRN/invoice match; NC-009 accrual/AP; NC-021 vendor master & portal (e-sign EN-016); EN-002 claim documents (implant stickers/invoices); EN-003 CSSD for loaner sets; AI-005 (later) consignment demand forecasting.

## 10. Reports & Analytics
- Consignment stock register (vendor/item/batch/serial/expiry/location/value), usage report (by surgeon/procedure/vendor/item; billed vs vendor cost margin), auto-PO & invoice status, uninvoiced usage ageing, reconciliation statements & discrepancy history, wastage report (reason/liability), expiry & returns register, kit utilisation, count/audit results, patient implant trace (with TR-003), payer-cap impact (PMJAY vs cost), vendor performance (fill rate, replenishment SLA, invoice accuracy). Read models: `analytics.consignment_value_daily`, `analytics.consignment_usage_monthly`.

### 10.1 KPI definitions
- Consignment value on hand = Σ qty × agreement price (by vendor/location); usage value MTD; uninvoiced ageing (days since usage without matched invoice); reconciliation match rate = matched lines / total; wastage rate = wasted units / (used + wasted); expiry return compliance = returned before window / eligible; kit fill rate = kits meeting min composition / kits; scan compliance = scanned usages / (scanned + manual); margin per implant = patient billed − vendor price (by payer).

### 10.2 Statutory/traceability outputs
- Implant traceability register (patient ↔ UDI/lot/serial ↔ vendor ↔ invoice) for CDSCO/NABH; recall impact list; PMJAY implant price compliance report; GST input register for consignment purchases (vendor tax invoices) → NC-009.

## 11. Notifications
- Coordinator: stock below kit min, near-expiry return proposals, reconciliation due/disputed, count due, invoice mismatch, kit not returned after case.
- OT staff: unmatched set items post-case, manual usage awaiting approval.
- Vendor (portal/email/WhatsApp): usage summary (per cycle), auto-PO, return pickup requests, reconciliation to sign, replenishment requests.
- Finance: monthly accrual, disputes above threshold; Admin: wastage above threshold.

## 12. Permissions (RBAC keys)
`inventory.consignment.agreement.manage/approve`, `inventory.consignment.kit.manage`, `inventory.consignment.receive`, `inventory.consignment.stock.read`, `inventory.consignment.use` (OT/procedure staff), `inventory.consignment.approve` (manual usage/wastage), `inventory.consignment.usage.read`, `inventory.consignment.po.read/close`, `inventory.consignment.return.manage`, `inventory.consignment.reconcile/sign`, `inventory.consignment.count`, `inventory.consignment.dispute.manage`, `inventory.consignment.report`, `inventory.consignment.configure`; vendor portal: `vendor.consignment.read/statement.upload/reconciliation.sign`. ABAC: `own_location_only` for OT stores; `amount_limit` for wastage approvals; SoD: usage scanner ≠ reconciliation signer for same case (config).

## 13. Non-functional
- Volumes: 60–100 consignment vendors, 8,000 SKUs, 40k units on hand, 150–300 usages/day (ortho/trauma/cardiac), monthly reconciliation lines 10k/vendor max; usage post p95 < 400 ms (atomic multi-module tx); stock view refresh event-driven; reconciliation auto-match 10k lines < 30 s.
- Offline OT panel with queue & idempotent sync; scanner-first UI; label/sticker printing (EN-013).
- Security: vendor portal shows no PHI (case reference only); all price/usage mutations audited; RLS.

## 14. Acceptance Criteria
1. Given an active agreement with PFN nail item at vendor price ₹18,000/MRP ₹32,000, when a challan with 5 nails is scanned in, then 5 serialised consignment units appear in the OT consignment location, excluded from owned valuation, and vendor portal shows them.
2. Given a scheduled trauma OT case, when the scrub nurse scans a nail's UDI, then in one transaction: NC-006 records CONSIGNMENT_USED, TR-003 links implant to patient, the IP bill shows the implant line at tariff (with payer cap if PMJAY), and an auto-PO line at ₹18,000 exists for the vendor; a second scan of the same serial is rejected.
3. Given a scanned implant that is expired or recalled, then usage is blocked with reason and quality is alerted.
4. Given a pack opened but not implanted (size change), when marked wasted with reason, then no patient charge is created (policy hospital_pays), an auto-PO wastage line is created and flagged for approval.
5. Given usage reversed within the case, then bill line, auto-PO line, TR-003 record and ledger movement are all reversed with audit; after bill finalisation reversal is refused and credit-note flow is required.
6. Given a vendor invoice for a serial not in usage records, then 3-way match flags `vendor_only` and AP posting is blocked until resolved.
7. Given the monthly reconciliation where vendor statement lists 42 usages and system has 40, then 2 vendor-only lines are shown; resolving one as "create usage" (patient identified) posts a bill line and auto-PO, and the other as "vendor error" requires vendor correction; sign-off requires both signatures.
8. Given consignment batches 75 days before expiry with return window 90 days, then a return proposal is auto-created listing them; on vendor acknowledgement stock is removed and hospital bears no cost.
9. Given a monthly count where a serialised screw set is missing, then a discrepancy is opened; resolution "lost — hospital liable" creates a PO for the vendor price after approval.
10. Given a case closed with set contents 20 pre-case and 17 post-case but only 2 usages scanned, then an unmatched-item alert requires resolution before the case reconciliation closes.
11. Given a manual usage entry without a sticker photo, then submission is blocked; with photo it awaits supervisor approval before billing.
12. Given the consignment dashboard, then value on hand equals Σ(qty × agreement price) per vendor and updates within 2 s of a usage.
13. Given a vendor blacklisted in NC-021, then new stock-in is refused while existing stock remains usable/returnable per admin decision.
14. Given a coronary stent usage for a PMJAY patient, then the patient bill line respects the NPPA ceiling/PMJAY package rule while the auto-PO uses the agreement price; both are visible to billing.
15. Given a usage on an item whose agreement price validity lapsed, then usage succeeds, the auto-PO line is flagged `price_pending`, and vendor invoicing for that line is blocked until price is set.
16. Given an agreement terminated, then further stock-in is refused, a return note for all remaining stock is generated, and reconciliation must be signed before the agreement is archived.
17. Given a kit checked out for a cancelled case, when returned with full count, then no usage exists and kit status returns to in_hospital.

## 15. Enhancements / Later phases
- From VIMS sheet: real-time consignment value tracking (Phase 4 dashboard), vendor auto-billing on consumption (`consignment.auto_billing`, auto-PO/self-billing invoice generation on behalf of vendor where agreed — Phase 9), implant registry with patient trace (TR-003, Phase 6), expired item auto-return processing (Phase 4 job), consignment audit checklist (Phase 9).
- (market) Vendor-managed kanban/2-bin for consumables, RFID cabinets for high-value stock (auto usage on removal), price benchmarking across vendors, PMJAY implant rate compliance analytics, cath-lab specific device tracking (OP-029), loaner set scheduling with vendors.

## 16. Open Questions for the Hospital
1. List of consignment vendors/specialties (ortho/trauma/spine/cardiac/ophthalmic) and existing agreements/price lists?
2. Invoicing cycle preference (per usage/monthly) and whether hospital will self-bill on behalf of vendors?
3. Patient pricing rules for implants (MRP, negotiated, payer caps) and disclosure practice on bills?
4. Wastage/loss liability policy with vendors; approval thresholds?
5. Where is consignment stock kept (OT store, cages, cath lab) and who is custodian? Barcode/UDI availability on packs?
6. Loaner set frequency and CSSD turnaround; do vendors' reps enter OT?
7. Vendor portal adoption feasibility; e-sign for reconciliations?
8. Existing consignment stock to be loaded at go-live (count and reconcile with vendors first)?
