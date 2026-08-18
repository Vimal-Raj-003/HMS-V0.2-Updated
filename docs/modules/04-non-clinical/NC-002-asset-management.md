# NC-002 — Asset Management (Register, Tags, AMC/CMC, Depreciation, PM, Audit, Disposal)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-002 |
| Phase | 9 |
| Priority | P1 |
| Complexity | Medium |
| Depends on | NC-005 (PO/GRN capitalisation source), NC-006 (item master, spare parts), NC-009 (fixed-asset ledger, depreciation journals, disposal gain/loss), NC-020 (Biomedical Engineering — medical equipment technical layer: calibration, breakdown, AERB; NC-002 is the financial/lifecycle register for ALL assets and NC-020 links to it via `asset_id`), NC-021 (vendors/AMC providers), NC-025 (facility assets, work orders), NC-023 (licences e.g. AERB for X-ray assets), EN-013 (barcode/QR/RFID tags), EN-038 (approval matrix for disposal/write-off), EN-024 (audit), NC-022 (capex budget), NC-011 (reports), EN-042 (IoT/BLE tracking) |
| Feature flag | `module.asset.enabled` (sub: `asset.rfid_ble`, `asset.insurance`, `asset.sharing_booking`) |
| Primary roles | Asset Manager / Stores In-charge (44), Biomedical Engineer (48, medical equipment), Facility/Maintenance (49), Accountant (46, depreciation & capitalisation), IT Admin (56, IT assets) |
| Secondary roles | HOD (5, department asset custodian), Hospital/Branch Admin (2/3, approvals), Purchase Officer (45), Auditor (58), Quality (54, PM compliance), Housekeeping (50, furniture audit) |
| Regulatory | Companies Act 2013 Schedule II (useful lives, SLM/WDV, component accounting, residual value ≤ 5 %), Income-tax Act §32 & Rule 5 Appendix I (block-of-assets WDV rates: 15 % plant & machinery, 40 % computers/medical life-saving devices listed at 40 %, 10 % furniture, 10 % buildings; half-rate if used < 180 days), IndAS 16/36/AS 10 (impairment, revaluation), GST ITC on capital goods (Rule 43, 60-month reversal), E-Waste (Management) Rules 2022 (IT/electronic disposal via authorised recyclers, EPR), BMW/AERB for radiological asset decommissioning (NC-020/NC-023), NABH FMS (equipment inventory, PM, safety), Insurance (asset policies, claims), IT Act (barcode/RFID data) |

## 1. Purpose
NC-002 is the enterprise **fixed & movable asset register**: every asset (medical, non-medical, IT, furniture, vehicles, buildings/leasehold, software) from capitalisation at GRN to disposal, with unique barcode/QR/RFID tags, location & custodian history, AMC/CMC contracts and service calls, preventive maintenance schedules and work orders, dual depreciation books (Companies Act SLM/WDV and Income-tax block WDV), physical verification audits with discrepancy reports, insurance, transfers, revaluation/impairment and disposal/e-waste — with journals posted to NC-009. Medical-equipment-specific engineering (calibration, AERB, breakdown MTBF/MTTR) lives in NC-020 and references the same asset row.

## 2. Users & Jobs-to-be-done
- **Asset manager / stores in-charge** (desktop + label printer + handheld scanner): capitalise assets from GRN, print & affix tags, record installation/commissioning, transfers, run quarterly audits, maintain AMC contracts, raise disposal.
- **Biomedical engineer** (desktop/tablet): for medical equipment link NC-020 records (calibration, PM checklists, breakdown), log service calls under AMC/CMC, SLA tracking.
- **Facility/maintenance** (tablet/phone): PM work orders for HVAC, DG sets, lifts, medical gas plant, water plants; complete with checklist & photos.
- **Accountant** (desktop): month-end depreciation run (both books), capitalisation of CWIP, disposal gain/loss, insurance renewals, fixed-asset schedule for balance sheet, ITC reversal on capital goods.
- **HOD / custodian** (phone/desktop): view department assets, acknowledge custody, request transfer, report damage/loss.
- **IT admin**: IT asset lifecycle (laptops, servers, network), software licences, allocation to employees, return at F&F (NC-010).
- **Auditor**: verify register vs physical, depreciation computations, disposals.

## 3. Core Workflows

### 3.1 Capitalisation & registration
1. **GRN accepted** (NC-005) for an item flagged `is_capital` (or PO type capex) → **System** creates draft `assets` (one per unit quantity, or one parent + component children for composite equipment e.g. CT scanner + chiller + workstation) with cost = GRN landed cost (basic + freight + installation + duties − ITC claimed if creditable) → **Asset manager** completes: category (Medical equipment/Non-medical equipment/IT hardware/Software/Furniture & fixtures/Vehicles/Building & leasehold improvements/Plant & machinery/Electrical/Instruments), sub-category, make/model/serial, warranty end, supplier, invoice, location (building/floor/room from EN-027 location tree), department, custodian, useful life (defaults from Schedule II per category, editable), residual value, IT block, put-to-use date, funding source (own/loan/grant/CSR/lease), capex budget line (NC-022) → status `active` on commissioning date (installation report attached) → Event `asset.capitalised` → NC-009 journal Dr Fixed Asset (category ledger) / Cr CWIP or Vendor.
2. Assets under installation stay in **CWIP** (`status=cwip`) with accumulated costs (installation, civil work invoices) until commissioning; **legacy import** via EN-036 template (opening WDV per book, accumulated depreciation, tag numbers).
3. Composite/component accounting: parent-child assets with own lives (Schedule II component approach); donated assets at fair value; leased assets flagged (IndAS 116 hook, ROU asset).

### 3.2 Tagging & location tracking
1. **System** assigns asset number from `ASSET` series (`{BR}/{CAT}/{SEQ:6}`) and generates tag: QR (default; encodes asset id + verify URL), Code-128 barcode, optional RFID EPC/BLE beacon id (EN-013/EN-042) → label printed (ZPL, polyester/metal-foil per config) → **Staff** affixes and scans to confirm (`tag_verified_at`) → Event `asset.tagged`.
2. Location/custodian changes only via **transfer** (3.5) or audit correction; scan-based "asset lookup" from any device shows full history; RFID/BLE gateways (`asset.rfid_ble`) update `last_seen_location` passively; alerts if a `no_move` asset leaves geofence (e.g. infusion pumps leaving ward, `asset.movement.alert`).

### 3.3 AMC/CMC contracts & service calls
1. **Asset manager** creates contract: vendor (NC-021), type enum(AMC/CMC/warranty/extended_warranty/lease_service), coverage scope (parts/labour/consumables/PM visits count/response & resolution SLA hours/uptime guarantee %), start/end, cost, payment schedule (NC-005/NC-009 AP), assets covered (many), documents (NC-004) → renewal alerts 90/60/30 days (config) → renewal creates new version linked to previous → Event `asset.contract.expiring|renewed`.
2. **Service call**: any user reports issue on asset (scan tag → "Report breakdown") → call logged (severity, description, photos, asset down since) → **System** checks coverage (warranty/AMC/CMC/none → chargeable) → notifies vendor (email/WhatsApp/vendor portal NC-021 with call id) → engineer visit, diagnosis, parts used (from NC-006 spares or vendor), downtime, resolution, cost (if chargeable → PO/invoice via NC-005) → SLA compliance computed (response/resolution vs contract) → user acceptance → closed → Event `asset.service_call.closed`. Medical equipment breakdowns additionally feed NC-020 breakdown/MTBF and NABH indicators; critical equipment down triggers NC-020 backup arrangement.
3. Vendor performance (NC-021): SLA breach %, repeat failures, cost per contract.

### 3.4 Depreciation (dual book)
1. Config per category: **Companies Act book** — method SLM/WDV, useful life (Schedule II defaults e.g. medical equipment 13 yrs general/15 electrical installations, computers 3/6 yrs, furniture 10, vehicles 8, buildings 30/60), residual % (≤ 5 %), pro-rata from put-to-use date (daily), shift-based extra depreciation (Schedule II Note 6: double/triple shift +50 %/+100 % for plant & machinery) as flag; **Income-tax book** — block of assets, WDV rate (Appendix I: P&M 15 %, medical life-saving equipment 40 % where listed, computers/software 40 %, furniture 10 %, buildings 10 %/5 %, vehicles 15 %/30 %), half-rate rule (< 180 days use), additional depreciation hooks; **IndAS/AS revaluation & impairment** entries.
2. **Monthly job** (`pg_cron`/worker) computes depreciation per asset per book → `asset_depreciation_runs` (period, per-asset lines) → accountant reviews → **post** → NC-009 journal Dr Depreciation expense (department/cost-centre wise) / Cr Accumulated depreciation → book value updated → Event `asset.depreciation.posted`. Runs are idempotent per period; re-run reverses & re-posts with audit. Year-end: IT block computation report (opening WDV + additions − sales = closing WDV, depreciation).
3. Change of life/method (prospective, IndAS 8) with approval; fully-depreciated assets stay at residual until disposal.

### 3.5 Transfers, custody & sharing
1. Transfer request (dept → dept, branch → branch, location) → HOD approval both sides (EN-038) → physical move → receiver scans to accept → history row → Event `asset.transferred`; inter-branch transfer creates inter-branch journal in NC-009 (book value moves) and re-tags if series differs.
2. **Asset sharing/booking** (`asset.sharing_booking`): shareable mobile assets (portable ultrasound, wheelchairs, syringe pumps, video laryngoscope) booked by wards for slots; conflicts prevented; overdue return alerts (VIMS enhancement).
3. Employee allocation (IT assets, phones): custody to employee; NC-010 F&F blocks settlement until returned/no-dues.

### 3.6 Preventive maintenance
1. PM plan per asset/category: frequency (daily/weekly/monthly/quarterly/half-yearly/annual or meter-based hours/cycles), checklist template (EN-039), responsible (in-house team/vendor), estimated duration/downtime window → **System** generates work orders ahead (`lead_days`) → assignee completes on tablet with checklist, readings, parts, photos, signature → overdue → escalate (supervisor, HOD) → compliance % per department (NABH FMS.4/5) → Event `asset.pm.completed|overdue`. Medical equipment PM/calibration specifics executed in NC-020 but shown here.
2. Meter readings (DG hours, autoclave cycles, CT tube seconds) captured manually or via EN-042.

### 3.7 Physical verification (audit)
1. **Asset manager** schedules audit (scope: branch/department/category; frequency annual mandatory, quarterly for high-value/mobile) → count sheets generated → **Auditor/staff** on handheld/phone scans tags room by room (offline-capable) → confirms location, condition (good/needs repair/unusable/idle), custodian, photo → **System** compares to register: found-in-place / found-elsewhere (auto-transfer proposal) / not found / unregistered item found (create draft asset) → discrepancy report → resolution actions (transfer, write-off request, tag replacement) with approvals → sign-off → Event `asset.audit.completed`.

### 3.8 Insurance & claims (`asset.insurance`)
1. Insurance policies (insurer, policy no., sum insured, assets covered, premium, expiry) → renewal alerts; damage/loss/theft incident → claim file (FIR/photos/estimates) → claim status → settlement amount posted to NC-009; asset written down/disposed as needed.

### 3.9 Disposal / decommission / write-off
1. Trigger: end of life, beyond economical repair (BER certificate from NC-020), obsolete, lost/stolen, upgrade → **Custodian/asset manager** raises disposal request with method enum(sale/scrap/e_waste/buy_back/donation/write_off/transfer_out/return_to_lessor), reason, condition report, valuation/quotes → approval matrix (value bands; committee for high-value; EN-038) → for radiology equipment: AERB decommissioning intimation (NC-023/NC-020); for IT/electronics: **E-Waste Rules 2022** — hand-over only to authorised recycler/producer EPR, Form-6 style manifest, data-wipe certificate for storage devices (IT admin); batteries/UPS to authorised recyclers; **sale**: invoice via OP-005 misc/NC-009 with GST on sale of capital goods (ITC reversal Rule 44) → asset status `disposed`, book value removed, gain/loss journal → tag deactivated → Event `asset.disposed`.
2. Idle assets report (no PM/no movement/utilisation < X %) → redeploy suggestion before new purchase (NC-005 indent check "similar idle asset exists").

### 3.10 Utilisation analytics (VIMS enhancement)
- Utilisation per asset from usage sources: modality studies (OP-008), OT hours (IP-006), dialysis sessions, ventilator hours (IP-009), lab analyzer tests (OP-004), meter readings; cost per use = (depreciation + AMC + repairs + consumables)/uses → NC-011 dashboards; supports capex decisions (NC-022).

### 3.11 Exceptions & edge cases
1. Asset received but invoice disputed → capitalise at PO value provisional; true-up on invoice approval (adjustment record, depreciation recomputed prospectively).
2. Asset moved without transfer (found in audit) → auto transfer proposal with "unauthorised movement" flag; repeated → security/admin.
3. Warranty claim vs AMC overlap → coverage resolver prefers warranty; costs zero; vendor call logged under warranty.
4. Split of one asset into components after capitalisation (component accounting adoption) → split wizard allocating cost & accumulated depreciation; audit.
5. Asset lost/stolen → FIR/insurance claim; status `lost`; write-off after approval; if found later → reinstate with reversal journal.
6. Leased asset return at lease end → `return_to_lessor` disposal method, no gain/loss except settlement.
7. Depreciation for assets acquired mid-period from branch transfer → continue book values; no double depreciation (transfer date split).
8. IT block negative (sale > block WDV) → short-term capital gain flag to tax officer (NC-009).

### 3.12 Configuration defaults (seed)
- Categories with Schedule II lives & IT block rates seeded (medical equipment 13 yrs / 40 % block where listed else 15 %, computers 3 yrs / 40 %, furniture 10 yrs / 10 %, vehicles 8 yrs / 15 %, buildings 30/60 yrs / 10 %/5 %, electrical installations 10 yrs / 15 %); residual 5 %; capitalisation threshold ₹5,000; PM lead 7 days; contract alerts 90/60/30; audit annual (quarterly for mobile/high-value > ₹1 lakh); disposal approval bands (≤ ₹50k asset manager+finance, ≤ ₹5 lakh admin, above committee); series `ASSET`, `SVC` (service call), `WO`, `DISP`.

## 4. Data Model (schema `inventory`, prefix `asset_`)
- **assets**: id, hospital_id, branch_id, asset_no, parent_asset_id?, name, category_id, sub_category_id, asset_class enum(medical/non_medical/it_hardware/software/furniture/vehicle/building/plant_machinery/electrical/instrument/other), make, model, serial_no, udi?, item_id? (NC-006), po_id?, grn_id?, grn_line_id?, supplier_id, invoice_no, invoice_date, purchase_date, put_to_use_date, commissioning_date, warranty_end, cost_basic, cost_freight, cost_installation, cost_duties_taxes, itc_claimed, capitalised_cost, currency, funding_source enum(own/loan/grant/csr/lease/donation), lease_id?, capex_line_id? (NC-022), location_id, department_id, cost_centre_id (NC-008), custodian_user_id, custodian_employee_id?, status enum(cwip/active/under_repair/idle/in_transit/retired/disposed/lost/written_off), condition enum(good/needs_repair/unusable), is_critical bool, is_shareable bool, is_movable bool, no_move_geofence bool, tag_type enum(qr/barcode/rfid/ble/none), tag_code, rfid_epc?, ble_id?, tag_verified_at, last_seen_location_id, last_seen_at, ca_book jsonb {method, life_months, residual_pct, shift_factor}, it_block_id, insurance_policy_id?, biomedical_equipment_id? (NC-020), aerb_licence_id? (NC-023), photo_file_ids uuid[], notes, version. UNIQUE (hospital_id, asset_no); INDEX (hospital_id, branch_id, status), (hospital_id, department_id), (tag_code), (serial_no).
- **asset_categories**: id, hospital_id, code, name, class, default_life_months, default_method, default_residual_pct, it_block_id, gl_asset_account, gl_dep_account, gl_acc_dep_account, pm_template_id?.
- **asset_it_blocks**: id, hospital_id, name, wdv_rate_pct, opening_wdv per FY (child table `asset_it_block_years`: fy, opening_wdv, additions_180plus, additions_less180, deletions, depreciation, closing_wdv).
- **asset_cwip_costs**: asset_id, date, description, amount, source_ref (GRN/AP invoice), posted.
- **asset_components** (via parent_asset_id) — no separate table.
- **asset_locations_history**: id, asset_id, from_location_id, to_location_id, from_dept, to_dept, from_custodian, to_custodian, moved_at, reason enum(transfer/audit_correction/repair_out/return/disposal), transfer_id?.
- **asset_transfers**: id, hospital_id, asset_id, from_branch_id, to_branch_id, from_dept, to_dept, requested_by, approved_from_by, approved_to_by, dispatched_at, received_at, received_by, status enum(requested/approved/in_transit/received/rejected/cancelled), journal_ref?.
- **asset_contracts**: id, hospital_id, vendor_id, contract_no, type enum(warranty/amc/cmc/extended_warranty/lease_service), start_date, end_date, cost, payment_terms, coverage jsonb {parts, labour, consumables, pm_visits, response_sla_hrs, resolution_sla_hrs, uptime_pct}, status enum(draft/active/expiring/expired/renewed/terminated), previous_contract_id?, document_ids uuid[]; **asset_contract_assets** (contract_id, asset_id).
- **asset_service_calls**: id, hospital_id, branch_id, asset_id, call_no, reported_by, reported_at, severity enum(critical/high/medium/low), description, photos, coverage enum(warranty/amc/cmc/chargeable), contract_id?, vendor_id?, vendor_notified_at, engineer_name, responded_at, diagnosed, resolved_at, downtime_minutes, parts jsonb/child, cost, po_id?, sla_response_met bool, sla_resolution_met bool, accepted_by, status enum(open/vendor_notified/in_progress/waiting_parts/resolved/closed/cancelled), biomedical_breakdown_id? (NC-020).
- **asset_pm_plans**: id, asset_id | category_id, frequency enum(daily/weekly/monthly/quarterly/half_yearly/annual/meter), interval_value, meter_type?, checklist_template_id, assignee_type enum(inhouse/vendor), assignee_id, lead_days, downtime_minutes, active.
- **asset_work_orders**: id, hospital_id, branch_id, asset_id, plan_id?, type enum(pm/breakdown/inspection/calibration_link), due_date, scheduled_at, assigned_to, started_at, completed_at, checklist_response jsonb, readings jsonb, parts_used, cost, status enum(scheduled/assigned/in_progress/completed/overdue/skipped/cancelled), skip_reason, signature_file_id.
- **asset_meter_readings**: asset_id, meter_type, reading, at, source enum(manual/iot).
- **asset_depreciation_runs**: id, hospital_id, branch_id?, book enum(companies_act/income_tax), period (fy, month), status enum(draft/reviewed/posted/reversed), run_by, posted_at, journal_batch_id; **asset_depreciation_lines**: run_id, asset_id, opening_wdv, depreciation, closing_wdv, method, rate_or_life, days, cost_centre_id.
- **asset_revaluations** (asset_id, date, old_value, new_value, reason enum(revaluation/impairment), approved_by, journal_ref).
- **asset_audits**: id, hospital_id, branch_id, audit_no, scope jsonb, scheduled_from/to, status enum(planned/in_progress/reconciling/closed), signed_off_by; **asset_audit_lines**: audit_id, asset_id?, expected_location_id, found_location_id?, result enum(found/found_elsewhere/not_found/unregistered/damaged), condition, scanned_by, scanned_at, photo, resolution enum(none/transfer/write_off/retag/register), resolved.
- **asset_insurance_policies**: id, hospital_id, insurer, policy_no, type, sum_insured, premium, start, end, assets[] via link table, document_id; **asset_insurance_claims**: policy_id, asset_id, incident_date, description, fir_no?, claim_amount, status enum(intimated/documents/surveyed/settled/rejected), settled_amount, journal_ref.
- **asset_disposals**: id, hospital_id, asset_id, request_no, method enum(sale/scrap/e_waste/buy_back/donation/write_off/transfer_out/return_to_lessor), reason, ber_certificate_id?, valuation, quotes jsonb, approved_by[], approval_status, buyer/recycler_id (NC-021, e-waste authorisation no.), sale_invoice_id?, sale_amount, gst_on_sale, itc_reversal, data_wipe_cert_id?, aerb_intimation_ref?, disposed_at, gain_loss, journal_ref, status.
- **asset_bookings** (sharing): asset_id, requested_by dept/user, from, to, purpose, status; overlap exclusion via `btree_gist` on (asset_id, tstzrange).
- **asset_employee_allocations**: asset_id, employee_id, issued_at, returned_at, condition_on_return, no_dues_cleared.
- RLS on all; `assets` never hard-deleted; financial fields immutable after capitalisation except via revaluation/adjustment records.

## 5. Business Rules & Validations
- Asset number gapless per branch/category series; tag_code unique per hospital; serial_no unique per make/model warning.
- Capitalisation only from accepted GRN or approved manual/legacy entry with invoice; cost components must reconcile with AP invoice; ITC-claimed portion excluded from capitalised cost (GST rules); capitalisation threshold configurable (e.g. < ₹5,000 expensed unless policy).
- Depreciation: begins on put-to-use date (not purchase date); pro-rata daily; residual ≤ 5 % (Companies Act) unless technical justification recorded; IT half-rate if put-to-use < 180 days in FY; no depreciation on CWIP/land; disposed assets depreciate up to disposal date; run per period idempotent; posting requires review by a different user than run initiator (SoD).
- Transfers change location/custodian only on receiver acceptance; inter-branch transfers post inter-branch journals; assets under service call cannot be transferred/disposed until closed.
- AMC/CMC: contract dates cannot overlap for the same asset & type; SLA timers use contract hours; renewal alerts 90/60/30 (config).
- PM: work orders auto-generated `lead_days` ahead; skipping requires reason; critical asset PM overdue > 7 days escalates to Biomedical head/HOD; PM compliance % = completed on time / due.
- Audit: an audit cannot close with unresolved `not_found` lines unless write-off requests exist; found-elsewhere auto-proposes transfer.
- Disposal: approval matrix by book value; e-waste only to authorised recycler (registration no. mandatory); storage devices require data-wipe certificate; radiological assets require AERB decommissioning reference; sale requires invoice with GST/ITC reversal; disposal blocked while asset in active booking/service call.
- Insurance claims cannot exceed sum insured; claim settlement posts to other income.
- Employee-allocated assets block NC-010 F&F until returned or written off with approval.
- Retention: register permanent; work orders/service calls 10 years; audit records 8 years.

## 6. API Surface (`/api/v1/assets`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /assets?branch=&dept=&category=&status=&q= | list/search (tag/serial/name) | asset.asset.list | – | cursor |
| POST | /assets | create (manual/legacy) | asset.asset.create | Y | – |
| POST | /assets/from-grn/{grnId} | capitalise from GRN | asset.asset.create | Y | – |
| GET/PATCH | /assets/{id} | detail (timeline) / update non-financial | asset.asset.read / .update | Y | – |
| POST | /assets/{id}/commission | CWIP → active | asset.asset.commission | Y | – |
| POST | /assets/{id}/tag/print, /assets/{id}/tag/verify | tag | asset.tag.print / .verify | Y | – |
| GET | /assets/lookup/{tagCode} | scan lookup | asset.asset.read | – | – |
| POST | /transfers, /transfers/{id}/approve, /dispatch, /receive | transfers | asset.transfer.create/.approve/.receive | Y | cursor |
| GET/POST/PATCH | /contracts, /contracts/{id}, /contracts/{id}/renew | AMC/CMC | asset.contract.manage | Y | cursor |
| POST | /service-calls, /service-calls/{id}/(notify|update|resolve|close) | breakdown calls | asset.service_call.create / .manage | Y | cursor |
| GET/POST | /pm-plans ; GET /work-orders?due=&assignee= ; POST /work-orders/{id}/(start|complete|skip) | PM | asset.pm.manage / asset.workorder.execute | Y | cursor |
| POST | /meter-readings | readings | asset.meter.record | Y | – |
| POST | /depreciation/runs, /depreciation/runs/{id}/(review|post|reverse) ; GET /depreciation/runs | depreciation | asset.depreciation.run / .post | Y | cursor |
| POST | /revaluations | revaluation/impairment | asset.revaluation.create | Y | – |
| POST | /audits, /audits/{id}/scan, /audits/{id}/reconcile, /audits/{id}/close | physical verification | asset.audit.manage / asset.audit.scan | Y | cursor |
| GET/POST | /insurance/policies, /insurance/claims | insurance | asset.insurance.manage | Y | cursor |
| POST | /disposals, /disposals/{id}/approve, /disposals/{id}/complete | disposal | asset.disposal.request / .approve / .complete | Y | cursor |
| GET/POST | /bookings | sharing bookings | asset.booking.manage | Y | cursor |
| POST | /allocations, /allocations/{id}/return | employee allocation | asset.allocation.manage | Y | – |
| GET | /reports/register, /reports/depreciation-schedule?book=&fy=, /reports/amc-tracker, /reports/pm-compliance, /reports/audit/{id}/discrepancy, /reports/utilisation | reports | asset.report.read | – | – |
| POST | /import (EN-036) | legacy import | asset.import | Y | – |

## 7. Domain Events (outbox)
- `asset.capitalised` {asset_id, cost, category, dept} → NC-009 journal, NC-022 capex actuals, NC-020 (if medical → create equipment record), NC-011.
- `asset.tagged`, `asset.transferred` {asset_id, from, to} → NC-020, location caches, NC-009 (inter-branch).
- `asset.contract.expiring` {contract_id, days_left} / `asset.contract.renewed` → EN-037 notifications, NC-021, NC-023 licence dashboard.
- `asset.service_call.opened|closed` {call_id, asset_id, downtime, sla_met} → NC-020 breakdown stats, NC-021 vendor score, NC-015 indicators (equipment downtime).
- `asset.pm.due|completed|overdue` → EN-037, NC-015 (PM compliance indicator), NC-020.
- `asset.depreciation.posted` {run_id, book, period, total} → NC-009, NC-011.
- `asset.audit.completed` {audit_id, found, not_found, unregistered} → finance, admin.
- `asset.disposed` {asset_id, method, gain_loss} → NC-009, NC-020 (deactivate), NC-023 (AERB), NC-016 (e-waste manifest link), EN-013 tag deactivation.
- `asset.movement.alert` {asset_id, location} (RFID/BLE) → EN-037 security/ward.
- Consumes: `purchase.grn.accepted` (NC-005), `biomedical.breakdown.logged|calibration.due` (NC-020), `hr.employee.exit_initiated` (NC-010 → allocation return check), `iot.tag.seen` (EN-042), `budget.capex.approved` (NC-022).

## 8. Screens (UI)
- **Asset register** — desktop; TanStack table (virtualised) filters by class/dept/status/location; bulk tag print; `N` new, `/` search, `Ctrl+K` scan lookup; export audited.
- **Asset detail (360°)** — desktop/tablet: header (photo, tag, status, book value CA/IT), tabs: details, location & custody timeline, contracts, service calls, PM/work orders, depreciation, documents, bookings, audit history; actions transfer/report breakdown/dispose.
- **Capitalisation queue** — desktop: GRN capital lines pending; wizard for cost build-up & commissioning.
- **Scan & report** — phone/tablet PWA (camera QR): lookup, report breakdown with photo, confirm transfer receipt, audit scanning (offline queue).
- **Work-order board** — tablet/desktop: due/overdue/assigned kanban; checklist execution with signature; offline-capable.
- **AMC/CMC tracker** — desktop: contracts by expiry, SLA compliance, cost; renewal wizard.
- **Depreciation workbench** — desktop (accountant): run per period/book, preview lines, exceptions (missing put-to-use date), post/reverse; schedule export.
- **Physical audit console** — desktop + handheld: audit plan, progress by room, discrepancy reconciliation with actions.
- **Disposal workflow** — desktop: request → approvals → completion with e-waste/AERB fields.
- **Booking calendar** (shareable assets) — desktop/tablet/phone.
- **Dashboards**: asset value by category, PM compliance, downtime, contracts expiring, idle assets, utilisation.

## 9. Integrations
- EN-013 label printing (ZPL) and QR verify; RFID/BLE gateways via EN-042 (MQTT) → last-seen updates.
- NC-020 bidirectional link (equipment ↔ asset), NC-005/NC-006 GRN/spares, NC-009 journals & AP, NC-021 vendor portal service calls, NC-023 licences, NC-025 facility work orders (shared work-order tables), NC-010 employee allocations/F&F, NC-022 capex, NC-011 analytics; EN-036 import; EN-032/EN-009 vendor notifications; e-waste recycler manifests (PDF/email).

## 10. Reports & Analytics
- Fixed asset register (statutory format: cost, additions, deletions, accumulated depreciation, WDV per category), depreciation schedule (CA & IT block), CWIP ageing, AMC/CMC tracker & spend, service call log & SLA, PM compliance by dept, downtime per critical asset, audit discrepancy report, idle/underutilised assets, utilisation & cost-per-use, insurance coverage gaps, disposal register (with e-waste manifests), assets by custodian/employee.
- Read models: `analytics.asset_summary_monthly` (branch, category, count, gross, acc_dep, wdv), `analytics.asset_pm_compliance`, `analytics.asset_downtime`.

## 11. Notifications
- Renewal alerts (contract/insurance/warranty) 90/60/30 days → asset manager, finance (email/in-app); PM due/overdue → assignee/HOD (push); breakdown reported → biomedical/facility + vendor (email/WhatsApp); SLA breach → asset manager; audit scheduled → custodians; disposal approvals → approvers; movement alert (RFID) → ward/security; depreciation posted → finance.

## 12. Permissions (RBAC keys)
`asset.asset.list/read/create/update/commission`, `asset.tag.print/verify`, `asset.transfer.create/approve/receive`, `asset.contract.manage`, `asset.service_call.create` (any staff), `asset.service_call.manage`, `asset.pm.manage`, `asset.workorder.execute`, `asset.meter.record`, `asset.depreciation.run` (Accountant), `asset.depreciation.post` (Finance Manager, ≠ runner), `asset.revaluation.create`, `asset.audit.manage/scan`, `asset.insurance.manage`, `asset.disposal.request/approve/complete`, `asset.booking.manage`, `asset.allocation.manage`, `asset.report.read`, `asset.export`, `asset.import`, `asset.configure`. ABAC: `own_department_only` for HOD/custodian views; `amount_limit` for disposal approvals.

## 13. Non-functional
- Volumes: 25,000–60,000 assets for a 2000-bed group; 3,000 work orders/month; 500 service calls/month; depreciation run 60k lines < 60 s; RFID events 100k/day.
- Scan lookup p95 < 150 ms; register list virtualised; audit scanning offline (IndexedDB) with sync.
- Printing: ZPL labels (durable), audit sheets, statutory registers PDF/Excel.
- Accessibility/i18n: keyboard tables; label templates per language.

## 14. Acceptance Criteria
1. Given a capital GRN of 2 infusion pumps, when accepted, then 2 draft assets are created with GRN cost; on commissioning with put-to-use date, status becomes `active`, asset numbers assigned, tags printable and NC-009 receives capitalisation journal.
2. Given asset with cost ₹10,00,000, residual 5 %, life 13 years SLM, put-to-use 15 Oct, when the March run executes, then CA depreciation = 9,50,000/13 × 168/365 (pro-rata days) and IT block gets half-rate (40 % block → 20 %) since < 180 days.
3. Given a depreciation run reviewed by the same user who created it, when posting, then blocked by SoD rule.
4. Given an AMC ending in 60 days, then asset manager and finance receive alert and the tracker shows `expiring`.
5. Given a breakdown reported by scanning tag on an asset under CMC (response SLA 4 h), when vendor responds after 6 h, then call shows `sla_response_met=false` and NC-021 vendor score is updated.
6. Given PM plan quarterly with lead 7 days, then work orders auto-appear 7 days before due; overdue > 7 days on a critical asset escalates to HOD.
7. Given audit scan finds an asset in ICU registered to Ward 3, then line is `found_elsewhere` and a transfer proposal is created; audit cannot close while a `not_found` line lacks write-off request.
8. Given inter-branch transfer approved by both HODs and received by scan, then location/custodian change, history row and inter-branch journal exist.
9. Given disposal of a server by e-waste, when recycler lacks authorisation number or data-wipe certificate missing, then completion is blocked.
10. Given a sale of asset with WDV ₹50,000 for ₹70,000, then gain ₹20,000 journal posted, GST on sale computed, and status `disposed`, tag deactivated.
11. Given a shareable portable USG booked 10:00–12:00, then an overlapping booking is rejected.
12. Given an employee exit with an allocated laptop not returned, then NC-010 F&F shows blocking no-dues item.
13. Given RFID gateway reports a `no_move` ventilator outside ICU geofence, then movement alert is raised to ICU in-charge and security.
14. Given an auditor role, when exporting the register, then export succeeds read-only and is audited; update attempts return 403.

## 15. Enhancements / Later phases
- From VIMS sheet: IoT asset tracking (RFID/BLE) — Phase 12 with EN-042; utilisation rate analytics per asset — Phase 11; insurance claim for asset damage — Phase 9 (`asset.insurance`); green disposal/e-waste compliance — Phase 9 core; asset sharing booking — Phase 9 flag.
- (market) Fixed assets from AP/GRN auto-import & bulk file import; asset lifecycle cost (TCO) dashboards; lease accounting (IndAS 116) automation; predictive maintenance from IoT (AI-005); QR-based public "report issue" for any staff without login (kiosk mode); spare-parts min/max linked to NC-006; capex request → asset linkage in NC-022; mobile-first audits with voice notes.

## 16. Open Questions for the Hospital
1. Capitalisation threshold and asset numbering format; do branches keep separate series?
2. Which depreciation books are needed (Companies Act + Income-tax; IndAS applicability)? Existing accumulated depreciation and opening WDV per asset available for import?
3. Useful lives/rates policy per category (Schedule II defaults acceptable?), shift-based depreciation applicability?
4. Tag technology (QR only vs RFID/BLE) and label material; existing tags to be retained?
5. Ownership split between biomedical (NC-020) and asset management for medical equipment work orders?
6. Approval matrix values for transfers, disposals, write-offs; disposal committee composition?
7. Insurance policies to track and claim process; e-waste recycler contracts in place?
8. Physical audit frequency and who conducts (internal audit/department custodians)?
9. Shareable asset pools and booking rules?
10. Legacy asset data source (Excel/Tally/other) and quality for EN-036 import?
