# EN-003 — CSSD (Central Sterile Supply Department: Trays, Packing, Sterilisation Cycles, Bowie-Dick/BI, Load Release, Barcode Tracking, Issue/Return, Recall, Endoscope Reprocessing, Instrument Lifecycle)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-003 |
| Phase | 7 |
| Priority | P0 |
| Complexity | Medium |
| Depends on | IP-006 (OT scheduling — tray demand, usage), TR-004 (trauma OT), IP-003 (ward requests), OP-039 (minor OT/dressing room), OP-028/OP-030 (endoscopes ENT/pulmo), NC-006 (consumables: wraps, indicators, pouches), NC-002/NC-020 (autoclave/washer assets, PM, validation), EN-013 (barcodes/labels), EN-005 (label printers), EN-042 (autoclave data-logger IoT, later), IP-012 (infection control — recall, HAI link), NC-016 (BMW), EN-037 (alerts), EN-024 (audit), NC-015 (NABH indicators), NC-005 (repair/vendor POs), NC-021 (loan instrument vendors) |
| Feature flag | `module.cssd.enabled` (sub: `cssd.endoscope`, `cssd.flash`, `cssd.loaner`, `cssd.instrument_lifecycle`, `cssd.iot`) |
| Primary roles | CSSD Technician / In-charge (38) |
| Secondary roles | Nurse — OT/Scrub (20), Nurse — Ward (17), Infection Control Nurse (21), Biomedical Engineer (48), Stores (44), Quality Manager (54), Auditor |
| Regulatory | NABH 5th ed. HIC (sterilisation monitoring: physical/chemical/biological indicators, load release, recall), CDC/AAMI ST79 practices, ISO 17665 (moist heat), ISO 11140 (chemical indicator classes 1–6), ISO 11138 (BI), EN 285 Bowie-Dick, ISO 15883 (washer-disinfectors), Spaulding classification (critical/semi-critical/non-critical), endoscope reprocessing (SGNA/ESGE, HLD logs), BMW 2016 (sharps/waste), AERB n/a, ETO safety (OSHA/factory rules) |

## 1. Purpose
EN-003 makes every sterile tray traceable from decontamination → inspection/packing (with indicators) → sterilisation cycle (steam/ETO/plasma/flash) with physical/chemical/biological monitoring → load release → sterile store → issue to OT/ward → use on a specific patient → return for reprocessing, with automatic recall of all items from a failed load and full NABH-grade sterilisation records. It also tracks autoclave validation/maintenance, Bowie-Dick and BI logs, endoscope high-level disinfection, instrument lifecycle (sharpen/repair/retire), loaner instruments and CSSD KPIs.

## 2. Users & Jobs-to-be-done
- **CSSD technician** (desktop at packing/loading benches + handheld scanner + label printer; tablet in sterile store): receive & scan soiled trays, run washer cycle, inspect/count instruments, pack with indicators, print tray label, load autoclave, record cycle & indicators, release load, store, issue on request, handle returns. ~300–600 trays/day at 2000 beds.
- **CSSD in-charge**: BI/Bowie-Dick daily logs, machine validation, recall management, staff competency, KPIs, stock of wraps/indicators.
- **OT scrub nurse** (tablet/scanner): request trays for scheduled cases, scan tray at opening (patient link), report missing/damaged instruments, return.
- **Ward nurse**: request dressing/procedure sets, receive/return.
- **Infection control nurse**: review BI failures/recalls, HAI/SSI correlation, audits.
- **Biomedical engineer**: autoclave PM/validation calendar, breakdown.
- **Quality manager**: NABH indicators (sterilisation failures, recall events, TAT).

## 3. Core Workflows

### 3.1 Masters
1. **Instrument master**: code, name, category, manufacturer, UDI/serial (optional per instrument marking: laser/DataMatrix), Spaulding class, reprocessing method (steam/ETO/plasma/HLD), max cycles (lifecycle), cost, purchase date, image → `cssd_instruments`.
2. **Tray (set) master**: tray code, name, specialty, composition (instrument × qty), packaging (wrap/container/pouch), sterilisation method & cycle programme, chemical indicator class, shelf-life days (event-related sterility rule), owner (CSSD/OT/loaner vendor), photo of standard layout, count sheet template → `cssd_tray_types`; physical trays are `cssd_trays` (tray_type_id, tray_no, barcode, status, cycle_count, location).
3. **Machine master**: autoclave/ETO/plasma/washer-disinfector/ultrasonic — id, type, make/model, chamber volume, programmes (temp/pressure/hold time, e.g. 134 °C/3.5 min/2.1 bar; 121 °C/15 min), asset link (NC-002), last validation, next validation, cycle counter, PM schedule, data-logger port (EN-042) → `cssd_machines`.

### 3.2 Decontamination & receipt (dirty zone)
1. Used tray arrives from OT/ward → tech scans tray barcode → status `received_soiled` (from `issued`/`in_use`), records source location, patient case link (from usage scan), condition (complete/missing/damaged), pre-cleaning done → Event `cssd.tray.received`.
2. Washer-disinfector cycle: load id, machine, programme, start/end, result (temp/A0 value/pass-fail from printout or IoT) → items move to `cleaned`; failed → rewash.
3. Missing/damaged instruments → discrepancy note to OT/ward (task), replacement from spare pool; instrument lifecycle event.

### 3.3 Inspection, assembly & packing (clean zone)
1. Tech selects tray → count sheet displayed with photo → verifies each instrument (scan if marked or tick), function check (sharpness, hinges, lumens) → flags for repair/sharpen (`cssd_instrument_events`) → substitutes from spares.
2. Packing: choose wrap/container/pouch, insert **chemical indicator** (class 4/5/6 internal; class 1 external tape), optional **BI vial** for implant loads, seal → **print label** (EN-013 GS1-style barcode: tray no + pack id, tray name, packed by, pack date, expiry, method, cycle placeholder) → status `packed` → Event `cssd.tray.packed`.
3. Consumables (wraps, indicators, pouches) decremented from CSSD sub-store (NC-006) per pack template.

### 3.4 Sterilisation cycle & monitoring
1. **Load creation**: tech scans machine + all pack barcodes into load (`cssd_loads`), selects programme, records **daily prerequisites**: Bowie-Dick (porous-load steam autoclaves, daily first cycle) result logged with test-sheet photo, leak test; if Bowie-Dick failed/missing → machine locked (`cssd_machines.status=locked_qc`), loading blocked.
2. Cycle run: start time, operator; physical parameters captured (manual entry from printout: temp, pressure, exposure time, drying; or IoT auto-capture); end time; printout photo attached; **cycle no** = machine counter → status `cycle_completed`.
3. **Chemical indicator check** at unload: external CI class 1 changed for every pack; internal CI (class 5/6) recorded when tray opened at point of use (3.6) — record here for load-level integrator packs (PCD/challenge pack).
4. **Biological indicator**: BI vial from load incubated (rapid 1–3 h / 24 h / 48 h per product) → result entered (negative/positive) with incubator id, lot, incubation start/end, control BI result → `cssd_bi_results`; **implant loads quarantined until BI negative** (except documented emergency release with surgeon sign-off).
5. **Load release**: parametric release requires physical params within programme tolerance + external CI pass + Bowie-Dick pass that day (+ BI negative for implant loads or where policy requires per load) → CSSD in-charge/authorised tech releases → packs `sterile`, expiry computed (shelf-life; event-related sterility if configured), label re-print with cycle no if needed → Event `cssd.load.released`. Failure → load `failed` → all packs `reprocess` → Event `cssd.load.failed`.
6. **Flash / immediate-use steam sterilisation (IUSS)** (`cssd.flash`): recorded in OT with reason (dropped instrument, no spare), item, patient case, cycle params, indicator; flagged as quality indicator; monthly count reported (NABH discourages routine flash).
7. ETO/plasma: aeration time enforced (ETO release only after aeration hours), gas cartridge lot recorded; ETO exposure log for staff safety.

### 3.5 Sterile store, requests & issue
1. Released packs shelved: location bin scanned → `sterile_stored`; FEFO by expiry; stock view by tray type.
2. **Requests**: OT schedule (IP-006) auto-generates tray demand per procedure (preference card → tray types) for next day; ad-hoc requests from OT/ward/ER (`cssd_requests`) with priority (routine/urgent/emergency) → CSSD picks → **issue**: scan pack(s) + destination + receiver → status `issued` → Event `cssd.tray.issued`; dispatch note printed; transport in closed trolley (recorded).
3. Receipt at OT/ward: nurse scans on receipt (`received_at_location`); discrepancy → task.
4. Emergency issue outside hours: on-call tech, same scan flow; expired pack scan → hard block "EXPIRED — return to CSSD".

### 3.6 Point-of-use & patient linkage
1. Scrub nurse opens pack in OT: scans pack barcode into OT case (IP-006 checklist "sterility verified": external CI ok, internal CI result, pack integrity, expiry) → `in_use` linked to patient/case → Event `cssd.tray.used` (implant loads: BI status shown; if BI pending, warning per policy).
2. Failed internal CI/wet pack/breach → reject pack, quarantine, incident (NC-015), request replacement (urgent).
3. Ward/dressing sets same flow with patient MRN scan (IP-004 mobile).

### 3.7 Return & reprocessing loop
- After use, tray/pack returned to CSSD → 3.2. Unused sterile packs returned before expiry → back to store (if integrity intact) or reprocess if opened; TAT (return → available) tracked.

### 3.8 Recall
1. Trigger: **BI positive**, failed physical parameters found post-release, Bowie-Dick failure discovered, wet pack pattern, machine fault, expired indicator lot → in-charge opens **recall** for load(s) since last negative BI (auto-computed range) → System lists all packs from affected loads with current status/location and, for `in_use`/`used`, the patient/case → recall notifications to locations (EN-037 push + phone list) → nurses scan/confirm each pack quarantined or returned → used-on-patient list to infection control (IP-012) and surgeon for clinical review → machine locked pending re-validation → CAPA (NC-015) → close recall when all packs accounted → Event `cssd.recall.opened|closed`.

### 3.9 Endoscope reprocessing (`cssd.endoscope`)
- Scope master (serial, channels, HLD method: AER/manual, disinfectant), per-use record: pre-clean at bedside (time), leak test, manual clean, HLD (disinfectant lot, MRC test strip result, temperature/contact time, AER cycle no), rinse/dry/alcohol flush, storage cabinet (hang time limit), patient linkage; culture surveillance schedule; repair events; scope traceability report per patient.

### 3.10 Instrument lifecycle & loaners
- Instrument events: sharpen, repair (vendor, cost via NC-005), replace, retire at max cycles; cycle_count increments per sterilisation; utilisation & failure rate per instrument.
- **Loaner sets** (vendor implants/instruments, TR-003): receipt with vendor, count, condition, sterilisation before use, return with sterilisation certificate; vendor performance (NC-021).

### 3.11 Exceptions & offline
- Scanner offline (PWA): scans queued with timestamps and synced; conflicting status transitions rejected with alert. Machine data-logger down → manual entry with printout photo mandatory.

## 4. Data Model (schema `cssd`)
- `cssd_instruments` — id, hospital_id, branch_id, code, name, category, manufacturer, serial/udi, spaulding_class, method, max_cycles, cycle_count, status (active/repair/retired/lost), cost, images[], notes.
- `cssd_tray_types` — id, hospital_id, code, name, specialty_id, packaging (wrap/rigid_container/pouch), method (steam/eto/plasma/hld), programme_id, ci_class, bi_required (bool), shelf_life_days, event_related (bool), image_id, count_sheet jsonb [{instrument_id, qty, critical}], version, effective_from.
- `cssd_trays` — id, hospital_id, tray_type_id, tray_no, barcode (GS1 AI 240/serial), owner (cssd/ot/loaner), vendor_id, status enum (received_soiled/cleaned/packed/in_load/quarantine/sterile_stored/issued/received_at_location/in_use/used/expired/recalled/reprocess/retired), current_location_id, current_pack_id, cycle_count, created_at…; UNIQUE(hospital_id, tray_no).
- `cssd_packs` — id, hospital_id, tray_id (or single_item), pack_no, packed_by, packed_at, wrap_type, ci_internal_class, bi_included, label_printed_at, load_id, sterile_at, expiry_at, released_by, status, integrity_notes; index (hospital_id, status, expiry_at).
- `cssd_machines` — id, hospital_id, branch_id, asset_id (NC-002), type (steam_autoclave/eto/plasma/washer_disinfector/ultrasonic/aer/dry_heat), make, model, chamber_l, programmes jsonb, cycle_counter, last_validation_at, next_validation_at, pm_due_at, status (available/in_cycle/locked_qc/breakdown/maintenance), iot_endpoint.
- `cssd_bowie_dick_tests` — machine_id, test_date, cycle_no, result (pass/fail), sheet_image_id, performed_by, remarks; UNIQUE(machine_id, test_date, cycle_no).
- `cssd_loads` — id, hospital_id, machine_id, load_no (series `CSSD_LOAD` per machine/day), programme, operator_id, started_at, ended_at, params jsonb (temp_max, pressure, hold_time, dry_time, source manual/iot), printout_image_id, external_ci_result, pcd_ci_result, bi_result_id, status (loading/running/cycle_completed/pending_bi/released/failed/recalled), released_by/at, release_type (parametric/bi_confirmed/emergency_release), notes.
- `cssd_load_items` — load_id, pack_id, position; UNIQUE(load_id, pack_id).
- `cssd_bi_results` — id, load_id, machine_id, bi_lot, incubator_id, incubation_start/end, read_time_h, result (negative/positive/invalid), control_result, read_by, remarks.
- `cssd_requests` — id, hospital_id, branch_id, requester_location_id, requester_id, ot_case_id, priority, needed_at, lines jsonb [{tray_type_id, qty}], status (open/partially_issued/issued/cancelled), notes.
- `cssd_issues` — id, request_id, issued_by, issued_at, destination_location_id, receiver_id, received_at, transport_note; `cssd_issue_items` (issue_id, pack_id, returned_at, return_condition).
- `cssd_usage` — pack_id, patient_id, encounter_id, ot_case_id, opened_by, opened_at, external_ci_ok, internal_ci_ok, integrity_ok, expiry_ok, notes.
- `cssd_flash_cycles` — ot_room_id, machine_id, item description/instrument_id, patient_id/ot_case_id, reason, params, ci_result, performed_by, approved_by.
- `cssd_recalls` — id, hospital_id, reason, trigger_ref (bi_result_id/load_id), load_ids[], opened_by/at, status, closed_at, capa_id; `cssd_recall_items` (recall_id, pack_id, status_at_recall, location, patient_id?, action, confirmed_by/at).
- `cssd_endoscopes`, `cssd_endoscope_reprocessing` — scope_id, patient_id/procedure_id, bedside_preclean_at, leak_test, manual_clean_by, hld_method, disinfectant_lot, mrc_strip_result, aer_cycle_no, temp, contact_min, rinse/dry, cabinet_id, stored_at, hang_time_expires_at, performed_by, status.
- `cssd_instrument_events` — instrument_id, type (sharpen/repair/replace/retire/lost/loan_out/loan_in), vendor_id, cost, po_id, notes, at, by.
- `cssd_loaner_sets` — vendor_id, description, received_at, count_sheet, sterilised_load_id, returned_at, certificate_file_id, ot_case_id.
- `cssd_locations` — CSSD zones (dirty/clean/sterile store bins), OTs, wards (link to mdm locations).
- Status history table for trays/packs/loads; audit on all mutations; pack rows partitioned yearly (optional).

## 5. Business Rules & Validations
- Status machine strictly enforced (e.g. `packed → in_load` only via load scan; `sterile_stored → issued` only via issue; `issued/received → in_use` only via point-of-use scan); invalid transitions rejected with reason.
- Machine `locked_qc` if: no Bowie-Dick pass today (porous-load steam), last BI positive not cleared, validation overdue, PM overdue (configurable warn vs block); breakdown blocks loading.
- Load release requires: params within programme tolerance (± configurable), external CI pass, Bowie-Dick pass same day; BI negative required for implant loads (`bi_required` on tray type) unless `emergency_release` with surgeon + in-charge sign & reason (audited, quality indicator).
- Expiry = sterile_at + shelf_life_days (or event-related: no date but integrity checks); expired packs cannot be issued/used (hard stop, scan beep + red).
- Point-of-use scan mandatory for OT trays (IP-006 checklist gate); allows patient-level traceability for recall.
- Recall range auto = loads from that machine after last negative BI up to trigger; in-charge may widen.
- Instrument at max_cycles → warning at 90 %, retire prompt at 100 %.
- Consumable decrement rules per pack template; indicator lots must be within expiry (lot master).
- Numbering: pack no `{TRAY}-{YYMMDD}-{SEQ}`; load no per machine per day.
- Retention: sterilisation records ≥ 5 years (NABH/legal), recall records permanent; BI/Bowie-Dick images retained.
- Segregation: load release by authorised user ≠ operator where staffing allows (configurable, default enforce for BI-required loads).

## 6. API Surface (`/api/v1/cssd`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET/POST/PATCH | /instruments, /tray-types, /trays, /machines, /locations | masters | cssd.master.configure | paginated |
| POST | /trays/:id/scan | generic scan transition {action, location, meta} | cssd.tray.update | idempotent per (barcode, action, ts) |
| POST | /receipts | receive soiled trays (bulk scan) | cssd.tray.receive | |
| POST | /washer-cycles | record washer cycle | cssd.cycle.record | |
| POST | /packs ; POST /packs/:id/label | pack tray & print label | cssd.pack.create / cssd.pack.print | label → EN-005 |
| POST | /machines/:id/bowie-dick | daily test | cssd.qc.record | |
| POST | /loads ; POST /loads/:id/items ; POST /loads/:id/start ; POST /loads/:id/complete ; POST /loads/:id/release ; POST /loads/:id/fail | load lifecycle | cssd.load.create/update ; cssd.load.release (release) | release checks rules |
| POST | /loads/:id/bi | BI result | cssd.qc.record | positive → suggests recall |
| GET/POST/PATCH | /requests ; POST /requests/:id/issue | requests & issue | cssd.request.create (OT/ward) / cssd.issue.create | |
| POST | /issues/:id/receive | receiver confirms | cssd.issue.receive | |
| POST | /usage | point-of-use scan (from IP-006/IP-004) | cssd.usage.record | |
| POST | /returns | return packs | cssd.tray.receive | |
| POST | /flash-cycles | IUSS record | cssd.flash.record | |
| POST | /recalls ; PATCH /recalls/:id ; POST /recalls/:id/items/:pid/confirm ; POST /recalls/:id/close | recall | cssd.recall.manage / cssd.recall.confirm (nurses) | |
| GET/POST | /endoscopes ; /endoscopes/:id/reprocessing | scope HLD | cssd.endoscope.record | |
| POST | /instruments/:id/events | lifecycle events | cssd.instrument.update | |
| GET/POST | /loaners | loaner sets | cssd.loaner.manage | |
| GET | /stock?trayType&location ; /dashboard ; /reports/… | stock, KPIs, registers | cssd.report.read | MV-backed |
| GET | /trace/pack/:packNo ; /trace/patient/:patientId | traceability | cssd.trace.read (audited PHI) | |

## 7. Domain Events (outbox)
- `cssd.tray.received|packed|issued|received_at_location|used|returned|expired|retired`
- `cssd.load.created|started|completed|released|failed` → IP-006 (tray availability), NC-006 (consumables), NC-015 (indicators)
- `cssd.qc.bowie_dick.failed`, `cssd.qc.bi.positive` → machine lock, recall suggestion, IP-012, EN-037
- `cssd.recall.opened|item_confirmed|closed` → IP-006/IP-003 (locations), IP-012, NC-015 CAPA
- `cssd.request.created|issued` → OT/ward task lists
- `cssd.machine.locked|unlocked|breakdown` → NC-020 biomedical
- `cssd.flash.recorded` → NC-015 quality indicator
- `cssd.instrument.event` → NC-005 (repair PO), TR-003 (loaner implants)

## 8. Screens
- **CSSD Dashboard** (desktop/TV dark): trays by status (soiled/packing/in cycle/pending BI/sterile/issued), machines status tiles (cycle timer, locked reasons), today's Bowie-Dick/BI status, urgent requests, expiring stock, TAT gauge, open recalls. Real-time via Socket.IO.
- **Receiving & Washing** (desktop + scanner, dirty zone): scan list, condition/discrepancy entry, washer cycle form; `Enter` accepts scan; audible feedback.
- **Packing Station** (desktop + scanner + label printer): tray count sheet with photo, tick/scan instruments, flag repair, packaging & indicator selection, print label (`Ctrl+P`), pack queue.
- **Load Console** (desktop/tablet by autoclave): create load, scan packs, programme, prerequisites checklist (Bowie-Dick), start/complete with param entry (or IoT auto-fill), printout photo capture, indicator results, BI incubation timers, release button with rule status.
- **Sterile Store & Issue** (tablet + scanner): request queue (OT schedule demand for tomorrow), pick list, scan-issue, dispatch note print, returns.
- **OT/Ward Point-of-Use** (tablet, inside IP-006 checklist / IP-004): scan pack → sterility checks → linked to patient; red block on expired/recalled.
- **Recall Workspace**: affected loads/packs grid grouped by location, patient exposure list, confirm buttons, notification log, CAPA link, close.
- **Endoscope Reprocessing Log** (tablet): step-by-step timed form, disinfectant/MRC entry, cabinet hang-time countdown.
- **Machines & QC** (desktop): Bowie-Dick calendar, BI log, validation & PM due, cycle history, lock/unlock (in-charge).
- **Instrument Lifecycle & Loaners**: instrument events, cost, utilisation, retire; loaner receipt/return.
- Offline: scanner PWA queues scans; packing/load screens need connectivity (server rule checks).

## 9. Integrations
- EN-013/EN-005: GS1 DataMatrix/Code128 pack labels (ZPL), instrument marking scans; EN-042: autoclave/washer data-loggers (RS-232/Ethernet, Modbus/OPC-UA or vendor CSV) auto-capturing params & cycle numbers; NC-002/NC-020 asset & PM; NC-006 consumables & indicator lots; IP-006 preference cards → tray demand, checklist gate; IP-012 recall exposure; NC-015 indicators/CAPA; NC-005/NC-021 repair & loaner vendors; TR-003 implant loaner sets.

## 10. Reports & Analytics
- Sterilisation cycle log (per machine/day with params & indicators), Bowie-Dick register, BI register, load release register, tray tracking register (movement history), issue/return register by location, recall report with patient exposure, flash sterilisation register, endoscope reprocessing log per scope/patient, instrument repair/retire report, consumable usage, machine utilisation & downtime, TAT (return → sterile), missing/damaged instrument trend, expiry write-offs; NABH indicators (sterilisation failures per 100 loads, BI positives, recall count). MVs: `analytics.mv_cssd_daily`.

## 11. Notifications
- Push/in-app: urgent request, load ready for release, BI read due, BI positive/Bowie-Dick failed (in-charge, ICN, OT in-charge), recall issued (all affected locations), machine validation/PM due, expiring sterile stock, loaner return due, hang-time expiry for scopes.
- TV (CSSD/OT corridor): machine status and tray readiness for today's cases (EN-018 feed).

## 12. Permissions (RBAC keys)
`cssd.master.configure` (CSSD in-charge, Admin) · `cssd.tray.receive/update` · `cssd.pack.create/print` · `cssd.cycle.record` · `cssd.load.create/update` (technician) · `cssd.load.release` (in-charge/authorised tech; ≠ operator for BI loads) · `cssd.qc.record` · `cssd.request.create` (OT/ward nurses) · `cssd.issue.create` · `cssd.issue.receive` (nurses) · `cssd.usage.record` (scrub/ward nurse) · `cssd.flash.record` (OT nurse) + `cssd.flash.approve` (surgeon/in-charge) · `cssd.recall.manage` (in-charge, ICN) · `cssd.recall.confirm` (nurses) · `cssd.endoscope.record` · `cssd.instrument.update` · `cssd.loaner.manage` · `cssd.machine.lock` (in-charge, BME) · `cssd.report.read` · `cssd.trace.read` (audited).

## 13. Non-functional
- Volumes: 600 packs/day, 40 loads/day across 8 autoclaves, 20 OTs; scan API p95 < 150 ms; label print < 2 s; recall computation over 12 months of loads < 3 s.
- Scanner-first UX (USB HID keyboard-wedge & camera scan in PWA), large tap targets for gloved hands, high-contrast; audible/visual feedback on scan; works on tablets in sterile store.
- Records immutable after load release (amend with reason → new version); retention 5+ years; images to S3.
- i18n labels English (label content fixed) + local UI; printing ZPL 2×1 inch labels with GS1 DataMatrix.

## 14. Acceptance Criteria
1. Given a porous-load autoclave without a Bowie-Dick pass recorded today, when a technician tries to create a load, then the system blocks with "Bowie-Dick pending/failed" and the machine shows `locked_qc`.
2. Given a completed load with a temperature below programme tolerance, when release is attempted, then release is refused and the load can only be marked failed (packs → reprocess).
3. Given an implant tray type with `bi_required`, when BI is not yet negative, then packs stay `pending_bi`/quarantine and issue is blocked unless emergency release with surgeon + in-charge sign and reason (audited, indicator increments).
4. Given a BI positive result entered, when saved, then the machine locks, a recall suggestion lists all loads since last negative BI, and ICN + in-charge receive alerts.
5. Given a recall opened, when a pack from an affected load was scanned in OT for patient X, then X appears in the exposure list and the recall cannot close until every item is confirmed.
6. Given an expired pack scanned at OT point-of-use, when the nurse scans it, then the system shows a red hard-stop and offers "request urgent replacement".
7. Given a pack scanned at point-of-use, when saved, then `cssd_usage` links pack → patient/case and the pack status is `in_use`; the OT checklist item "sterility verified" is satisfied.
8. Given a tray returned with one missing instrument, when receipt is recorded with discrepancy, then a task is created for the source location and the instrument shows a `lost` event pending resolution.
9. Given tomorrow's OT list with 12 cases, when the nightly job runs, then a consolidated tray demand appears in the CSSD request queue with shortages highlighted vs sterile stock.
10. Given a technician who operated the load, when they attempt to release a BI-required load, then release is denied by segregation rule (configurable) and an in-charge must release.
11. Given the packing screen, when a pack is created, then wrap and indicator consumables are decremented from the CSSD sub-store and the label prints with pack no, expiry and DataMatrix.
12. Given a scanner offline for 10 min, when connectivity returns, then queued scans sync in order and any conflicting transition is surfaced for manual resolution.
13. Given a flash cycle recorded in OT, when month-end runs, then it appears in the flash register and NABH indicator count.
14. Given a scope reprocessing record with hang time exceeded, when the scope is selected for a procedure, then the system warns "reprocess before use".
15. Given a pack number entered in traceability search, when queried, then full history (packed → load → release → issue → use → return) with actors/timestamps is shown and a `READ_PHI` audit is written for the patient link.

## 15. Enhancements / Later phases
- Flash sterilisation tracking (delivered as `cssd.flash`), instrument lifecycle (sharpen/repair/retire) & per-instrument marking with DataMatrix scanning, endoscope reprocessing tracking (`cssd.endoscope`), loan instrument vendor management (`cssd.loaner`), staff competency assessment & training records (NC-027 link), IoT auto-capture of autoclave/washer parameters (EN-042), RFID tray tracking, AI vision count of instruments (AI), cost per tray/procedure (NC-008), CSSD receipt/dispatch notes for wards (market), sterile stock forecasting from OT schedule (AI-005).

## 16. Open Questions for the Hospital
1. Inventory of sterilisers/washers (make/model, porous vs non-porous, ETO/plasma), whether they have data-logger/printer ports.
2. Current tray list with count sheets and photos; preference cards per surgeon/procedure (for auto demand).
3. BI policy: every load, daily, or implant loads only? Rapid-read BI product in use? Emergency release policy and signatories.
4. Shelf-life policy (time-based days per packaging vs event-related sterility)?
5. Do OTs already scan packs at point of use? Availability of scanners/label printers per zone?
6. Flash/IUSS policy and who approves; endoscopy units in scope (ENT, pulmo, GI) and their AERs.
7. Recall notification tree (phone list) and ICN involvement; CAPA process (NC-015).
8. Loaner instrument volumes (ortho vendors) and required sterilisation certificates.
9. Instrument marking (laser DataMatrix) present or planned? Repair vendors and budget approval flow.
