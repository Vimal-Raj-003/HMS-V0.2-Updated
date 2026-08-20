# NC-017 — Laundry & Linen Management (Linen Tracking, Wash Cycles, Ward-Wise Demand, Quality Check)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain          | Non-Clinical / ERP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Module ID       | NC-017                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Phase           | 9                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Complexity      | Low–Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Depends on      | NC-006 (linen as inventory items — par stock per ward, condemnation write-off, new linen purchase via NC-005), NC-018 (housekeeping collects soiled linen, delivers clean; task engine), IP-001/IP-025 (bed turnover → linen change triggers, census-based demand), IP-006 (OT linen/drapes; sterile linen via EN-003 CSSD), IP-012 (infection control: infected linen handling, isolation), NC-016 (contaminated/condemned linen disposal — yellow (g)), EN-013 (barcode/RFID tags for linen & carts), EN-042 (RFID readers, washer telemetry optional), NC-002/NC-020 (washers/dryers/ironers as assets, PM), NC-021 (outsourced laundry vendor, portal), NC-005/NC-009 (vendor billing per kg/piece), NC-008 (linen cost per ward/cost centre), NC-015 (linen quality indicators), NC-011, EN-024, EN-037 |
| Feature flag    | `module.laundry.enabled` (sub: `laundry.rfid`, `laundry.outsourced`, `laundry.washer_telemetry`, `laundry.uniforms`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Primary roles   | Laundry In-charge / Supervisor, Laundry staff (washing/ironing/QC), Linen room keeper                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Secondary roles | Ward in-charge nurses (17, indents/receipts), Housekeeping (50, transport), OT/CSSD (20/38), Infection Control Nurse (21), Stores (44), Facility (49), Finance (46), Vendor (63), Quality (54), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Regulatory      | NABH HIC/FMS (linen & laundry processes: segregation of soiled/infected linen, transport in covered carts, wash temperatures/disinfectant per infection control policy, separate clean/dirty flow), CDC/WHO laundry guidance (≥ 71 °C for 25 min or chemical disinfection at lower temps), BMW 2016 (yellow (g) contaminated linen discard), Water/Effluent consent (ETP for laundry effluent — NC-023), Fire/boiler safety (steam boilers — Boilers Act if applicable), Contract Labour Act (outsourced staff), Legal Metrology (weighing for vendor billing)                                                                                                                                                                                                                                               |

## 1. Purpose

NC-017 tracks the hospital's **linen lifecycle**: linen master & par levels per ward, tagged items (barcode/RFID) or counted bundles, soiled linen collection by category (general/infected/OT), wash cycles with process parameters (temperature, chemicals, time) and machine logs, drying/ironing/folding, quality check & rejection (stains/damage → rewash/repair/condemn), clean linen issue against ward demand (par top-up), ward-wise consumption and loss/damage accounting, condemnation and replacement, outsourced laundry vendor management (kg/piece billing, turnaround, quality) and linen KPIs (loss %, turnaround, cost per patient-day).

## 2. Users & Jobs-to-be-done

- **Ward nurse in-charge** (tablet/phone): daily soiled linen hand-over (counts/weight, infected bags flagged), receive clean linen against par, raise ad-hoc demand, report shortages/quality issues.
- **Housekeeping** (phone): collect soiled carts on rounds, deliver clean carts (scan cart barcodes).
- **Laundry staff** (desktop/tablet at laundry): receive & sort soiled by category, weigh, load washers with wash programme, log cycles, dry/iron/fold, QC, pack per ward, dispatch.
- **Laundry in-charge**: manage machines, chemicals stock (NC-006), staffing/shifts, vendor (if outsourced), condemnation approvals, reports.
- **ICN**: infected linen protocol compliance audits, wash parameter verification.
- **Finance/stores**: linen inventory value, loss write-offs, vendor invoices, cost per ward.

## 3. Core Workflows

### 3.1 Linen master, tagging & par levels

1. **In-charge** defines linen items (bed sheet, draw sheet, pillow cover, blanket, patient gown, towel, OT gown/drape (non-sterile side), scrub suits, curtains, uniforms (`laundry.uniforms`)) as NC-006 items with size/colour/material, expected life (wash cycles), unit cost; **tagging** (`laundry.rfid`): UHF RFID/barcode per piece (or bundle tags for low-value) via EN-013 → item registry (tag, item type, purchase batch, wash count, status) → **par levels** per ward/OT (based on beds × changes/day × safety factor; census-driven adjustments IP-001) → Event `laundry.item.registered`.

### 3.2 Soiled linen collection

1. Ward bags soiled linen by category: general (blue/white per policy), **infected** (yellow/red-lined water-soluble bag per HIC policy from isolation/infectious cases IP-012), OT (drapes/gowns), heavily soiled → count/weigh at ward or laundry (ward hand-over sheet on tablet or cart scan) → housekeeping collects in covered carts (scan cart) → laundry receives: verify counts (RFID portal read for tagged) → discrepancy vs ward sheet flagged → Event `laundry.soiled.received`.

### 3.3 Washing, drying, finishing

1. **Sorting** by category/colour/temperature class → **washer load**: machine (asset), programme (temperature ≥ 71 °C/25 min or thermal-chemical per policy; infected linen: pre-disinfection/soak or high-temp programme, washed separately), chemicals dosing (detergent, bleach/peroxide, softener — consumption to NC-006/NC-008), load weight (≤ capacity), start/end (manual or telemetry `laundry.washer_telemetry`), operator → **cycle log** with parameter verification (deviation → rewash) → drying/ironing (calendar/press) → folding/packing per ward → Event `laundry.cycle.completed`.
2. **Quality check**: sample/every item — stains, tears, missing buttons/ties, colour → pass / rewash / repair (tailoring log) / **condemn** (beyond repair or exceeded wash cycles) → condemnation list with approvals → NC-006 write-off + NC-016 disposal (if contaminated) or rag sale → replacement request (NC-005) → Event `laundry.item.condemned`.

### 3.4 Clean linen issue & ward demand

1. **Demand**: par top-up auto (par − ward clean stock) or ward request; census/occupancy adjustments; OT schedule-based (IP-006 cases) → **pack & dispatch** per ward (counts/RFID cart read) → housekeeping delivers → ward receives (scan/count acknowledge; discrepancy note) → ward clean stock updated → Event `laundry.clean.issued|received`.
2. Emergency requests (mass casualty, spill) → priority.
3. **Ward-wise consumption**: soiled sent vs clean received vs par → loss/unaccounted per ward per month; charge-back cost per ward (NC-008 cost centre) at cost per kg/piece.

### 3.5 Outsourced laundry (`laundry.outsourced`)

- Vendor (NC-021) contract: rate per kg/piece by category, TAT (e.g. 24 h), quality SLA, infected linen handling, transport; dispatch challan (weights/counts, category) → vendor receipt ack (portal) → return receipt with counts → shortages/damage claims → monthly reconciliation & invoice verification (NC-005/NC-009) → vendor performance (TAT, quality rejects, losses).

### 3.6 Machines, chemicals & safety

- Washers/dryers/ironers as assets (NC-002/NC-020): PM, breakdown; utility consumption (water/steam/electricity per kg — meters via EN-042 optional); chemical stock (NC-006 laundry store) & MSDS; effluent handling (ETP consent NC-023); staff PPE & Hep B (with NC-016/NC-010).

## 4. Data Model (schema `ops`, prefix `lin_`)

- **lin_items** (view over NC-006 items with `category=linen`): item_id, linen_type, size, colour, material, expected_wash_cycles, unit_cost, is_infected_capable, sterile_route bool (CSSD).
- **lin_pieces** (tagged): id, hospital_id, tag_code, item_id, purchase_batch_id, registered_at, wash_count, status enum(in_stock_clean/issued_ward/soiled/in_wash/in_finishing/qc_hold/repair/condemned/lost), current_location_id, last_seen_at, ward_id?, condemned_reason?, condemned_at. UNIQUE (hospital_id, tag_code); INDEX (status), (ward_id).
- **lin_par_levels**: ward_id, item_id, par_qty, min_qty, changes_per_day, census_factor, effective_from.
- **lin_ward_stock** (read model): ward_id, item_id, clean_qty, soiled_pending_qty, last_issue_at.
- **lin_soiled_handovers**: id, ward_id, at, by_user_id, category enum(general/infected/ot/heavily_soiled), lines jsonb [{item_id, qty}], weight_kg?, cart_id, received_at_laundry, received_by, discrepancy jsonb.
- **lin_carts**: id, cart_code, type enum(soiled/clean), status, last_scan.
- **lin_wash_cycles**: id, hospital_id, branch_id, machine_asset_id, programme_code, category, load_kg, temp_c, duration_min, chemicals jsonb [{item_id, qty}], started_at, ended_at, operator_id, source enum(manual/telemetry), params_ok bool, deviation_note, pieces uuid[]?/counts jsonb, status enum(running/completed/aborted/rewash).
- **lin_finishing_logs** (drying/ironing/folding: at, machine, qty/kg, operator).
- **lin_qc_records**: id, cycle_id?, piece_id?/item_id, qty, result enum(pass/rewash/repair/condemn), defect enum(stain/tear/damage/colour/missing_part), inspector_id, at, photo_file_id.
- **lin_repairs** (piece_id, defect, repaired_by, at, cost); **lin_condemnations** (id, list jsonb, reason, approved_by, at, writeoff_ref (NC-006), disposal_ref (NC-016), sale_ref?).
- **lin_issues**: id, ward_id, issue_no, lines jsonb, dispatched_at, dispatched_by, cart_id, delivered_at, received_by, discrepancy jsonb, request_type enum(par_topup/adhoc/emergency/ot_schedule).
- **lin_vendor_dispatches** / **lin_vendor_returns** (vendor_id, challan_no, category, kg, counts, at, ack_at, shortages jsonb, damages jsonb); **lin_vendor_reconciliations** (vendor_id, period, kg_by_cat, invoice_ref, variances, status).
- **lin_utility_readings** (machine_asset_id, at, water_l, steam_kg, kwh).
- **analytics.linen_daily**: branch, date, ward, item, soiled_qty, clean_issued_qty, kg_washed, cycles, rejects, condemned, loss_qty, cost.
- RLS; RFID reads partitioned (shared `rfid_reads` in NC-006 or own).

## 5. Business Rules & Validations

- Infected linen: separate bagging at source (water-soluble/alginate bag inside colour bag), no sorting before wash, separate high-temp/disinfection programme; ward hand-over must flag infected; laundry cannot combine infected with general in a cycle (validation on load).
- Wash cycle: load ≤ machine capacity; temperature/time per programme; deviations → mandatory rewash or ICN override; chemical dosing recorded (consumption to NC-006).
- QC: condemn when wash_count ≥ expected or irreparable; condemnation requires approval and creates NC-006 write-off + disposal record; repairs logged with cost.
- Issue: par top-up computed daily from ward stock (updated by soiled hand-over and clean receipt); discrepancies at receipt > tolerance flagged and investigated; loss % per ward monthly (soiled + clean stock − par baseline).
- Tagged pieces cannot be issued if status ≠ clean; lost pieces after 30 days unseen → `lost` write-off proposal.
- Vendor: dispatch weights via calibrated scale; return TAT breach & shortages → claims before invoice approval; infected linen vendor capability required.
- Sterile OT linen: laundry supplies clean to CSSD; sterilisation & tray tracking in EN-003.
- Retention: cycle logs 3 years (ICN audits), financial 8 years.

## 6. API Surface (`/api/v1/laundry`)

| Method         | Path                                                                                           | Purpose       | Permission                                              | Idem                                                | Pag                                           |
| -------------- | ---------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------- |
| GET/POST/PATCH | /pieces ; POST /pieces/register (bulk tags) ; GET /pieces/{tag}                                | tagged linen  | laundry.piece.manage / .read                            | Y                                                   | cursor                                        |
| GET/PUT        | /par-levels?ward=                                                                              | par           | laundry.par.manage                                      | Y                                                   | –                                             |
| POST           | /soiled/handovers (ward) ; POST /soiled/handovers/{id}/receive (laundry)                       | soiled flow   | laundry.soiled.handover (ward) / laundry.soiled.receive | Y                                                   | cursor                                        |
| POST           | /carts/{code}/scan                                                                             | cart tracking | laundry.cart.scan (housekeeping)                        | Y                                                   | –                                             |
| POST           | /cycles ; POST /cycles/{id}/(complete                                                          | abort         | rewash) ; POST /cycles/telemetry (device)               | washing                                             | laundry.cycle.log / integration.washer.ingest | Y            | cursor             |
| POST           | /finishing ; POST /qc ; POST /repairs ; POST /condemnations ; POST /condemnations/{id}/approve | finishing/QC  | laundry.qc / laundry.condemn.approve                    | Y                                                   | cursor                                        |
| GET            | /demand?date= (par top-up + OT schedule) ; POST /issues ; POST /issues/{id}/(dispatch          | receive)      | issue flow                                              | laundry.issue.manage / laundry.issue.receive (ward) | Y                                             | cursor       |
| GET            | /wards/{id}/stock ; GET /wards/{id}/consumption?month=                                         | ward views    | laundry.ward.read                                       | –                                                   | –                                             |
| POST           | /vendor/dispatches, /vendor/returns ; POST /vendor/reconciliations ; vendor portal ack         | outsourced    | laundry.vendor.manage / vendor.laundry.ack              | Y                                                   | cursor                                        |
| POST           | /utility-readings                                                                              | utilities     | laundry.machine.log                                     | Y                                                   | –                                             |
| GET            | /reports/(ward-consumption                                                                     | loss          | turnaround                                              | cycle-compliance                                    | qc-rejects                                    | condemnation | vendor-performance | cost-per-patient-day) | reports | laundry.report.read | –   | –   |

## 7. Domain Events (outbox)

- `laundry.soiled.received` {ward, category, qty/kg} → ward stock, NC-018 tasks, NC-011.
- `laundry.cycle.completed|deviation` {machine, programme, temp, kg} → ICN (deviation), NC-006 chemicals consumption, NC-020 (machine hours).
- `laundry.item.condemned` {items, qty} → NC-006 write-off, NC-016 disposal, NC-005 replacement indent.
- `laundry.clean.issued|received|discrepancy` {ward, lines} → ward stock, NC-008 cost, dashboards.
- `laundry.vendor.dispatched|returned|shortage` → NC-021, NC-005/NC-009.
- `laundry.piece.lost` → NC-006 write-off proposal.
- Consumes: `bed.released|admission.created` (IP-001 census demand), `ot.schedule.published` (IP-006 linen demand), `isolation.started` (IP-012 infected linen flag), `housekeeping.task.completed` (NC-018 transport), `iot.rfid.read|washer.telemetry` (EN-042), `asset.workorder.completed` (machine back), `purchase.grn.accepted` (new linen → tag registration prompt).

## 8. Screens (UI)

- **Ward linen panel** (in nursing station/IP-003 or standalone tablet): today's soiled hand-over form (counts by item, infected toggle, weight), clean receipt confirm (scan cart/list), stock vs par, request ad-hoc; offline queue.
- **Laundry receiving** — tablet/desktop with RFID portal/scanner: expected carts, counts vs ward sheet, discrepancy.
- **Wash floor console** — desktop/tablet: machines status tiles, start cycle (programme, load kg, chemicals), running timers, telemetry, complete/deviation; `S` start, `C` complete.
- **QC & finishing** — tablet: pass/rewash/repair/condemn quick buttons with photo; condemnation approvals list.
- **Dispatch board** — desktop: demand by ward (par gaps, OT schedule), pack lists, cart assignment, dispatch; housekeeping delivery status.
- **Vendor console** — desktop: challans, returns, claims, reconciliation; vendor portal pages.
- **Dashboards** — desktop: kg/day, cycles, TAT (soiled→clean), rejects %, loss % by ward, cost per patient-day, machine utilisation.
- Empty/error states; large tap targets; i18n; WCAG 2.2 AA.

## 9. Integrations

- EN-013 barcode/RFID tags & readers (UHF portals at laundry doors, handheld), EN-042 washer telemetry (Modbus/vendor API — optional) & utility meters, NC-006 items/stock/write-offs, NC-018 tasks, IP-001/IP-006/IP-012 demand & infection flags, NC-002/NC-020 machines, NC-021 vendor portal, NC-005/NC-009 billing, NC-016 disposal, NC-008 cost centres, EN-003 CSSD (sterile route), NC-015 indicators.

## 10. Reports & Analytics

- Ward-wise consumption (soiled/clean/par/loss), linen loss & condemnation (by item/ward, value), turnaround time (soiled hand-over → clean receipt), wash cycle compliance (temperature/time deviations, infected separation), QC reject rate, machine utilisation & downtime, chemical & utility consumption per kg, cost per kg / per patient-day, vendor performance (TAT, shortages, quality), stock of clean linen vs par (shortage risk), piece life (wash counts) analytics. Read model `analytics.linen_daily`.

## 11. Notifications

- Ward: clean linen dispatched/delivered, shortage/discrepancy; Laundry: soiled carts pending receipt, machine cycle complete/deviation, QC backlog, par gaps unmet, vendor return overdue; ICN: cycle deviations, infected linen handling non-conformance; Finance/stores: condemnation approvals, vendor variances; Facility: machine breakdown (NC-020).

## 12. Permissions (RBAC keys)

`laundry.piece.manage/read`, `laundry.par.manage`, `laundry.soiled.handover` (ward nurses), `laundry.soiled.receive`, `laundry.cart.scan` (housekeeping), `laundry.cycle.log`, `laundry.qc`, `laundry.condemn.approve` (in-charge/stores), `laundry.issue.manage`, `laundry.issue.receive` (ward), `laundry.ward.read`, `laundry.vendor.manage`, `laundry.machine.log`, `laundry.report.read`, `laundry.configure`; vendor: `vendor.laundry.ack`. ABAC: ward scope for nurses; branch scope.

## 13. Non-functional

- Volumes: 2000 beds × ~3–5 kg/bed/day ≈ 6–10 tonnes/day, 30–60 wash cycles/day, 200k tagged pieces (RFID), 100+ ward hand-overs/day; RFID batch reads (500 tags) processed < 3 s; console updates realtime.
- Offline: ward hand-over/receipt and handheld scans queue.
- Printing: pack lists, challans, condemnation lists, tag labels; i18n; accessibility.
- Security: RLS; no PHI (isolation flag by ward/bed only, not patient identity).

## 14. Acceptance Criteria

1. Given Ward 5 hands over 40 sheets (5 infected) at 07:00, then laundry receiving shows expected counts; RFID read of 39 raises a discrepancy of 1 to the ward and laundry.
2. Given an operator loads infected and general linen into one cycle, then the system blocks the cycle start with an infection-control message.
3. Given a wash cycle logged at 60 °C for a programme requiring ≥ 71 °C/25 min, then the cycle is flagged deviation, ICN notified, and items require rewash before QC pass.
4. Given a piece reaching its expected wash count with tears at QC, then it is condemned upon approval, NC-006 write-off and NC-016 disposal record are created, and a replacement indent is suggested.
5. Given par 60 sheets and ward clean stock 35, then the daily demand lists 25 sheets for Ward 5; dispatch and ward receipt update stock; a receipt of 23 flags discrepancy of 2.
6. Given an outsourced dispatch of 500 kg with 24 h TAT and return after 30 h with 480 kg, then TAT breach and 20 kg shortage claims are recorded and the vendor invoice cannot be approved until resolved.
7. Given monthly ward consumption, then loss % per ward is computed and the top-loss wards appear on the dashboard with cost charge-back to NC-008.
8. Given a tagged piece not seen for 30 days, then it is proposed as lost for write-off approval.
9. Given OT schedule for tomorrow with 12 cases, then linen demand adds OT gowns/drapes per case template.
10. Given a ward nurse offline, then hand-over entries queue and sync; duplicates are prevented by idempotency.

## 15. Enhancements / Later phases

- From VIMS sheet: linen tracking, wash cycles, ward-wise demand, quality check (Phase 9 core).
- (market) Linen receipt/dispatch from ward (PCS-style), RFID chute/portal automation, uniform management with lockers (`laundry.uniforms`), predictive demand from census (AI-005), sustainability metrics (water/energy per kg), vendor portal with e-challans, patient-owned linen handling in private wards, integration with bed turnover for automatic linen kits.

## 16. Open Questions for the Hospital

1. In-house laundry, outsourced, or hybrid? Machines list and telemetry availability; vendor contracts (rate basis)?
2. Linen item catalogue, colours per category, infected linen policy (bag types, wash programme)?
3. Tagging approach (RFID per piece vs counts) and budget; existing tags?
4. Par levels per ward/OT and changes per day policy; census-based adjustments?
5. Ward hand-over process today (sheets/registers) and housekeeping round timings?
6. Charge-back of linen cost to departments required?
7. Uniform/scrub suit management in scope?
