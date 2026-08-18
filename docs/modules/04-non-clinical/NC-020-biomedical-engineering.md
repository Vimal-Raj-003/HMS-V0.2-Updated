# NC-020 — Biomedical Engineering (Medical Equipment Registry, Calibration, Preventive Maintenance, Breakdown & Downtime, AMC/CMC, AERB/Regulatory, Uptime KPIs)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-020 |
| Phase | 9 (registry seed with NC-002 in Phase 4/7 for OT/ICU equipment) |
| Priority | P1 |
| Complexity | High |
| Depends on | NC-002 (financial asset register — every medical equipment row references `asset_id`; AMC/CMC contracts, service calls, PM work orders and disposal share tables; NC-020 adds the engineering layer), NC-005/NC-006 (spare parts, consumables, PO for repairs; GRN → equipment onboarding), NC-021 (OEM/service vendors, performance), NC-023 (AERB licences/eLORA, PNDT registration, radiation safety; PCB), NC-025 (facility utilities: medical gas, UPS, HVAC affecting equipment), IP-009/IP-006/OP-008/OP-004/OP-012/IP-007 (equipment-using departments: ventilators, anaesthesia machines, imaging, analyzers, dialysis machines, blood-bank fridges — usage & downtime impact), EN-042 (device gateway: telemetry, error codes, usage hours, temperature loggers), EN-004 (analyzer maintenance logs), OP-004/EN-031 (NABL ISO 15189 equipment calibration/verification records), IP-013 (crash-cart defibrillator checks), NC-015 (NABH FMS.6 equipment management indicators, incidents involving equipment → CAPA), NC-027 (user training on equipment; competency), NC-016 (e-waste/decommissioning), NC-002/NC-022 (replacement capex), EN-013 (QR tags), EN-037/EN-038, EN-039 (checklists), NC-011, EN-024 |
| Feature flag | `module.biomedical.enabled` (sub: `bme.calibration`, `bme.aerb`, `bme.telemetry`, `bme.mdi_recall`, `bme.loaner_pool`) |
| Primary roles | Biomedical Engineer / BME In-charge, BME Technician |
| Secondary roles | Department in-charges/nurses (17/18/20; report breakdown, daily checks), Radiology (36/12; AERB QA), Lab quality (35), Anaesthetist (10; machine check), ICU (11/18), Purchase (45), Asset manager/Finance (46), Quality (54), Vendor engineers (63), Radiation Safety Officer (RSO), Auditor (58) |
| Regulatory | NABH 6th ed. FMS.6 (medical equipment inventory, PM, calibration, breakdown response, user training, condemnation), NABL ISO 15189:2022 §6.4 (equipment calibration/verification traceable to SI; NC-020 stores certificates), AERB Safety Code (radiation equipment licensing via eLORA, QA tests periodicity — Radiography every 2 yrs, CT/Interventional annually per AERB; RSO, TLD badges, area survey; decommissioning intimation), PC-PNDT Act (ultrasound registration, Form F link OP-008), Medical Devices Rules 2017 (CDSCO device class A–D, UDI, MvPI adverse-event reporting to IPC), Materiovigilance Programme of India (MvPI), Legal Metrology (weighing scales, BP apparatus verification), IEC 60601-1 electrical safety testing (leakage current), IEC 62353 recurrent tests, ISO 13485 (vendor), Boilers/Pressure vessels (autoclaves — EN-003), Gas Cylinder Rules (medical gas — NC-025), E-Waste Rules 2022 (disposal via NC-002), BIS/ISI where applicable |

## 1. Purpose
NC-020 is the **engineering brain for medical equipment**: a registry per device (class, criticality, UDI/serial, location, department, OEM/service vendor, contract cover) linked to the NC-002 asset; **preventive maintenance** per manufacturer schedule and NABH, **calibration** with traceable certificates and due dates, **daily user checks** (ventilators, defibrillators, monitors), **breakdown management** with severity, response/repair, downtime and backup arrangement, spare-part usage and cost, **AMC/CMC & warranty** coverage checks, **AERB/PNDT/CDSCO** compliance (QA tests, licences, TLD, recalls/field-safety notices), electrical safety tests, condemnation/BER certificates, and KPIs (uptime %, MTBF, MTTR, PM/calibration compliance %, cost of ownership) — with telemetry hooks (EN-042) for usage hours and error codes.

## 2. Users & Jobs-to-be-done
- **BME engineer** (desktop + tablet on rounds): today's PM/calibration/QA due list, open breakdowns by severity, vendor call follow-ups, certificate uploads, spare-part requests, BER certificates, AERB tasks; scan QR at bedside to open history.
- **BME technician** (phone/tablet): execute PM checklists, electrical safety tests with readings, first-line breakdown attendance, photos, part usage, close with user sign-off.
- **Nurse / department user** (IP-003, OT, ICU, lab): report breakdown by scanning tag ("Report fault"), daily equipment checks (ventilator/defib/monitor checklist per shift), see equipment status and loaner availability.
- **Radiology / RSO**: AERB licence & QA test schedule, TLD badge results, area survey; PNDT registration validity per ultrasound machine.
- **Lab quality**: analyzer calibration/verification records for NABL audit; temperature logs (fridges/incubators via EN-042).
- **Purchase/Asset/Finance**: coverage decisions, chargeable repair approvals, replacement planning; **Quality**: FMS.6 indicators, incident-linked equipment failures.

## 3. Core Workflows
### 3.1 Equipment onboarding & registry
1. On `asset.capitalised` (NC-002) with `asset_class=medical` (or manual/import) → **BME** completes equipment record: device category (GMDN/UMDNS-like internal taxonomy, e.g. ventilator, syringe pump, defibrillator, patient monitor, anaesthesia workstation, C-arm, CT, USG, analyzer, dialysis machine, infant warmer, blood-bank refrigerator, autoclave (with EN-003), ECG, OT table, suction), make/model, serial, UDI-DI/PI (CDSCO), CDSCO risk class A–D, **criticality** enum(life_support/high_risk/medium/low) (NABH risk-based PM), department/location (ward/bed/room), custodian, OEM & service vendor (NC-021), warranty end, AMC/CMC contract (NC-002), installation date, **acceptance test/commissioning report** (checklist: physical, electrical safety IEC 60601, functional, calibration, user training done NC-027, manuals uploaded NC-004), PM frequency & checklist template (from manufacturer/NABH; e.g. ventilator quarterly, defibrillator monthly + daily user check, monitors half-yearly, infusion pumps half-yearly + flow accuracy annually), calibration frequency (e.g. annually; analyzers per NABL), electrical safety test frequency (annual/after repair), AERB flag & licence, PNDT flag, telemetry id → QR/asset tag (EN-013) → Event `bme.equipment.registered`.
2. Loaner/pool devices (`bme.loaner_pool`): infusion pumps/monitors central pool with issue/return to wards; demo/trial equipment register; **hired/rented equipment** with rental period.

### 3.2 Preventive maintenance (PM)
1. **System** generates PM work orders (shared `asset_work_orders` NC-002) from schedule with lead time; assign in-house/vendor; **Technician** executes checklist (EN-039 template per category: visual, mechanical, electrical safety readings (earth leakage µA, insulation MΩ, patient leakage), functional tests, performance verification (e.g. ventilator tidal volume ±10 %, defib energy delivered, pump flow accuracy ±5 %, SpO2 simulator, NIBP simulator, ECG simulator), cleaning, battery test, software version) with pass/fail per item, readings, parts, duration, photos → PM sticker (next due) printed (EN-013) → user in-charge sign-off → Event `bme.pm.completed`; failed items → breakdown/repair order; overdue PM → escalate (BME head, HOD; NABH indicator).
2. **Daily/shift user checks** for critical equipment (defibrillator: battery, pads, self-test; ventilator pre-use check; anaesthesia machine check per IP-024; infant warmer alarms; crash cart via IP-013): nurse completes on IP-003/IP-004 with equipment QR; missed checks flagged.

### 3.3 Calibration & QA (`bme.calibration`)
1. Calibration schedule per equipment (internal with reference standards or external NABL-accredited lab/OEM) → work order → result: certificate (file), certificate no., calibrating agency, traceability (NABL/NPL), as-found/as-left readings, tolerance, uncertainty, pass/fail, valid_until → calibration label → **Test equipment/reference standards register** (analyzers, simulators — themselves calibrated) → NABL/NABH evidence export → Event `bme.calibration.recorded`; out-of-tolerance → equipment quarantined + impact assessment (lab: EN-031 review of results since last cal).
2. **AERB QA** (`bme.aerb`): per radiation equipment — licence (eLORA), QA test periodicity per type (radiography 2 yrs, CT/fluoroscopy/interventional/mammography annual, dental per code), QA report upload, TLD badge service (personnel monitoring results quarterly; dose above investigation level → RSO action), area radiation survey, lead apron integrity checks (annual fluoroscopy), warning lights/signage checklist, decommissioning/disposal intimation; PNDT registration validity for USG machines and machine-wise Form F link (OP-008); Radiology equipment cannot be marked in-service without valid licence & QA (hard-stop configurable, RSO override).

### 3.4 Breakdown & repair
1. **User** scans tag → "Report fault" (symptom, severity: critical (life-support/no backup), high, medium, low; patient impact; photo) → **System** creates breakdown (also NC-002 service call), sets equipment status `down`, checks coverage (warranty/AMC/CMC/chargeable), auto-notifies BME (critical: call + push) & vendor (portal/email/WhatsApp) with SLA from contract, and for life-support triggers **backup arrangement** (pool loaner issue or transfer from another ward; nurse informed) → Event `bme.breakdown.logged`.
2. **BME first response** (target ≤ 30 min critical): diagnosis; in-house fix or vendor escalation; parts (NC-006 spares issue / vendor quote → NC-005 PO for chargeable), repair record, **post-repair safety test** (electrical safety/functional/calibration if affected — mandatory before return to service), user acceptance sign-off → `in_service` → downtime minutes computed (report → in-service, minus waiting-for-user), MTTR; recurring faults (≥ 3 in 90 days) → reliability review/replacement recommendation → Event `bme.breakdown.closed`.
3. **Beyond Economic Repair (BER)**: cost estimate > x % of replacement value or obsolescence/no spares → BER certificate (BME + HOD + committee via EN-038) → NC-002 disposal workflow; radiology → AERB decommissioning; e-waste via NC-002/NC-016 → Event `bme.equipment.condemned`.
4. Equipment-related **patient incident** (shock, burn, malfunction causing harm) → NC-015 incident + **MvPI adverse event report** (Form to IPC/CDSCO Materiovigilance) generated; device quarantined for investigation; OEM notified.

### 3.5 AMC/CMC, vendors & costs
- Contract cover from NC-002; SLA (response/resolution/uptime guarantee %, PM visits count) tracked per call; vendor PM visits scheduled & verified; uptime guarantee shortfall → penalty/credit note claim; cost of ownership per equipment (purchase + AMC + repairs + parts + downtime cost) → replacement planning to NC-022 capex; vendor performance to NC-021.

### 3.6 Recalls & field safety notices (`bme.mdi_recall`)
- Register FSN/recall (source: OEM, CDSCO alerts) → match by make/model/serial/UDI → affected equipment list → actions (quarantine/upgrade/replace) with evidence → close.

### 3.7 Telemetry (`bme.telemetry`, EN-042)
- Usage hours/cycles (for meter-based PM), error codes (auto-create breakdown for critical codes), temperature/humidity loggers for blood-bank fridges/vaccine fridges/lab incubators (alarm thresholds; IP-007/OP-013 evidence), UPS/battery health, medical-gas alarms (NC-025).

### 3.8 Training & competency link
- Equipment onboarding requires user training session (NC-027) recorded; new users flagged; competency per critical device category; training records evidence for NABH FMS.6.

### 3.9 Equipment status machine & risk-based scheduling
- Statuses: `to_onboard → in_service ↔ down → under_repair → testing → in_service`; `in_service → quarantined` (cal failure/recall/incident) `→ in_service` (after clearance); `in_service → pool_available ↔ issued` (pool devices); `→ condemned → disposed` (via NC-002); `on_loan/rented_out` for inter-branch loans (EN-041) with return due.
- Risk-based PM frequency (NABH FMS.6 acceptable practice): score = function(criticality, physical risk, maintenance requirement, incident history) → suggested interval (life-support quarterly; high-risk half-yearly; medium annual; low as needed) → engineer confirms per equipment; system recalculates on incident/breakdown history changes and proposes interval tightening (≥ 3 breakdowns/yr → next tier).
- Warranty period: PM by OEM per contract; breakdown call routed to OEM first; parts under warranty tracked to avoid chargeable POs; warranty expiry 60 days → AMC/CMC decision task to purchase (NC-005/NC-002).
- Software/firmware: version registry per equipment; cybersecurity patches for networked devices coordinated with EN-023 (medical device security), change record via NC-028 for networked modalities/analyzers.
- Loan between branches/departments: request → approval → transfer with condition check-out/in photos → NC-002 location update; overdue loan reminders.
- Spare parts: critical spares list per model (min stock in NC-006 BME store), consumption per repair; obsolete model spares watch.
- Decommissioning checklist: data wipe (patient data on ultrasound/ECG/monitors), radiation source handling (AERB), refrigerant/battery/e-waste (NC-002/NC-016), tag deactivation, department notification, replacement linkage (NC-022 capex).

## 4. Data Model (schema `inventory`/`ops`, prefix `bme_`)
- **bme_equipment**: id, hospital_id, branch_id, asset_id (NC-002, unique), equipment_no, category_id (bme_categories: name, gmdn_code?, default_pm_freq, default_cal_freq, checklist_template_ids, criticality_default, cdsco_class), make, model, serial_no, udi_di, udi_pi?, cdsco_class enum(A/B/C/D), criticality enum(life_support/high_risk/medium/low), department_id, location_space_id/ward_id/bed_id?, custodian_user_id, oem_vendor_id, service_vendor_id, warranty_end, contract_id? (NC-002), coverage enum(warranty/amc/cmc/none) (derived), installation_date, commissioning_report_id, acceptance_status enum(pending/accepted/rejected), pm_frequency_days, cal_frequency_days?, est_frequency_days (electrical safety), next_pm_due, next_cal_due, next_est_due, next_qa_due?, is_radiation bool, aerb_licence_id? (NC-023), aerb_equipment_ref?, is_pndt bool, pndt_reg_id?, telemetry_device_id?, software_version, manuals jsonb (file ids), status enum(in_service/down/under_repair/quarantined/pool_available/issued/condemned/disposed/rented_out/on_loan), pool_id?, is_rented bool, rental jsonb, replacement_value, expected_life_years, photo_file_ids, version. UNIQUE (hospital_id, equipment_no), (asset_id); INDEX (hospital_id, branch_id, department_id, status), (next_pm_due), (next_cal_due), (serial_no), (make, model).
- **bme_checklist_templates** (EN-039 refs by category & kind enum(acceptance/pm/user_daily/electrical_safety/calibration/qa)).
- **bme_pm_orders** (view/extension of NC-002 `asset_work_orders` kind=pm): equipment_id, due_at, scheduled_at, assignee (in-house/vendor), checklist_response jsonb, readings jsonb, parts jsonb, duration_min, result enum(pass/fail/pass_with_remarks), next_due, sticker_printed, signed_by_user, completed_at, overdue bool.
- **bme_user_checks** (partitioned monthly): equipment_id, shift, date, by_user_id, checklist jsonb, result, at. INDEX (equipment_id, date desc).
- **bme_calibrations**: id, equipment_id, kind enum(calibration/verification/qa_aerb/electrical_safety), performed_at, performed_by (internal user/vendor), agency_name, agency_accreditation_no?, certificate_no, certificate_file_id, traceability, as_found jsonb, as_left jsonb, tolerance, uncertainty, result enum(pass/fail/conditional), valid_until, reference_standards uuid[] (bme_reference_standards), notes. INDEX (equipment_id, valid_until).
- **bme_reference_standards** (id, name, serial, calibrated_until, certificate_file_id).
- **bme_breakdowns**: id, hospital_id, branch_id, equipment_id, breakdown_no, service_call_id (NC-002), reported_by, reported_at, symptom, severity enum(critical/high/medium/low), patient_impact bool, incident_id? (NC-015), coverage, vendor_id?, vendor_call_ref, vendor_notified_at, bme_responded_at, diagnosis, cause enum(user_error/wear/electrical/mechanical/software/accessory/environment/unknown), repair_actions, parts jsonb [{item_id, qty, cost}], labour_cost, vendor_cost, po_id?, backup_equipment_id?, backup_issued_at, waiting_user_minutes, post_repair_test_id? (bme_calibrations kind est/functional), user_accepted_by, accepted_at, restored_at, downtime_minutes, sla_response_met, sla_resolution_met, status enum(open/attended/vendor_pending/parts_pending/repaired/testing/closed/ber/cancelled), ber_id?. INDEX (hospital_id, branch_id, status, severity), (equipment_id, reported_at desc).
- **bme_ber_certificates** (equipment_id, reason, repair_estimate, replacement_value, ratio, recommendation, approvers jsonb, status, disposal_id? NC-002).
- **bme_pool_issues** (equipment_id, pool_id, issued_to_ward, patient_id?, issued_at, returned_at, condition_on_return).
- **bme_recalls** (id, source, ref_no, make, model, serials/udi pattern, description, action_required, received_at, affected_equipment jsonb, actions jsonb, closed_at).
- **bme_mvpi_reports** (breakdown_id/incident_id, form_data jsonb, submitted_at, ref_no).
- **bme_aerb_records** (equipment_id, licence_no, elora_ref, licence_valid_until, qa_due, qa_reports jsonb, tld_results jsonb [{person, period, dose_msv}], survey_reports jsonb, apron_checks jsonb, decommission jsonb).
- **bme_telemetry_readings** (partitioned; equipment_id, at, metric, value, alarm bool) — or via EN-042 tables.
- **analytics.bme_equipment_kpis** (equipment/category/department/month: uptime_pct, downtime_min, breakdowns, mtbf_hours, mttr_min, pm_due, pm_done_on_time, cal_due, cal_done, cost).
- RLS; certificates in S3; retention: equipment life + 5 years (NABH/AERB), MvPI 10 years.

## 5. Business Rules & Validations
- Every medical asset (NC-002 class medical) must have a bme_equipment record before `in_service`; acceptance test required for new equipment; life-support/high-risk require user training record before first use.
- PM/calibration due dates: computed from last completion (not from due) unless policy says fixed calendar; grace 7 days then overdue; overdue life-support equipment → status `pm_overdue` flag visible on ward equipment list and NABH indicator; hard-stop (configurable) preventing pool issue of overdue devices.
- Calibration failure/out-of-tolerance → status `quarantined`; return to service only after successful re-calibration; impact assessment task created (labs via EN-031).
- Breakdown: critical severity → BME response target 30 min (config); vendor SLA from contract; downtime clock excludes `waiting_user` state; post-repair electrical safety/functional test mandatory for classes C/D & life-support before `in_service`; user acceptance sign-off required.
- BER: ratio = repair_estimate / replacement_value; ≥ threshold (default 40 %) or age > expected life & obsolete → BER allowed; approvals via EN-038; radiation equipment BER → AERB decommissioning steps.
- AERB: radiation equipment without valid licence or overdue QA cannot be `in_service` (RSO override with reason, audited); TLD dose above investigation level triggers RSO task; PNDT USG requires valid registration.
- Recall matches auto-quarantine when action_required = stop_use.
- Numbering: `BME_EQ`, `BME_BD`, `BME_PM`; immutability of completed PM/calibration records (amend via new record).
- Cost allocation: repair costs to department cost centre (NC-008); AMC amortised (NC-009).

## 6. API Surface (`/api/v1/biomedical`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | /equipment ; GET /equipment/{id|qr} ; POST /equipment/import ; POST /equipment/{id}/accept | registry | bme.equipment.manage / .read | Y | cursor |
| GET | /equipment/{id}/history (pm/cal/breakdowns/moves/costs) | 360 view | bme.equipment.read | – | cursor |
| GET | /due?kind=pm|cal|est|qa&from=&to=&dept= | due lists | bme.schedule.read | – | cursor |
| POST | /pm ; POST /pm/{id}/(start|complete|fail) ; GET /pm | PM orders | bme.pm.execute / .manage | Y | cursor |
| POST | /user-checks (equipment_qr, checklist) ; GET /user-checks?ward=&date= | daily checks | bme.usercheck.record (nurses) / .read | Y | cursor |
| POST/GET | /calibrations ; POST /calibrations/{id}/certificate ; GET/POST /reference-standards | calibration | bme.calibration.record / .read | Y | cursor |
| POST | /breakdowns (from tag) ; POST /breakdowns/{id}/(respond|diagnose|parts|vendor|backup|repair|test|accept|close|ber) ; GET /breakdowns | breakdown lifecycle | bme.breakdown.report (all staff) / bme.breakdown.manage | Y | cursor |
| POST/GET | /pool/issue|return ; GET /pool/availability | loaner pool | bme.pool.manage / .read | Y | cursor |
| POST/GET | /aerb/(licences|qa|tld|surveys) ; /pndt | radiation compliance | bme.aerb.manage / .read (RSO) | Y | cursor |
| POST/GET | /recalls ; POST /recalls/{id}/(match|action|close) | FSN/recalls | bme.recall.manage | Y | cursor |
| POST | /mvpi-reports | adverse event report | bme.mvpi.create | Y | – |
| POST/GET | /ber ; POST /ber/{id}/approve | condemnation | bme.ber.manage / .approve | Y | cursor |
| POST | /telemetry (device ingest) | EN-042 | integration.bme.ingest | Y | – |
| GET | /dashboard ; /reports/(uptime|mtbf-mttr|pm-compliance|cal-compliance|breakdowns|cost-of-ownership|aerb-status|user-checks|recalls) | analytics | bme.report.read | – | – |

## 7. Domain Events (outbox)
- `bme.equipment.registered|accepted|status.changed|moved|condemned` {equipment_id, asset_id, status, dept} → NC-002 (asset status/location), wards (equipment lists), NC-023 (AERB), NC-011.
- `bme.pm.due|completed|overdue`, `bme.calibration.recorded|due|overdue|failed` → EN-037, NC-015 indicators (PM/cal compliance), EN-031/OP-004 (lab impact), NC-002.
- `bme.breakdown.logged|responded|vendor_notified|repaired|closed` {equipment_id, severity, downtime_min, sla_met, cost} → NC-002 service call sync, NC-021 vendor score, NC-015 (downtime indicator), NC-008 cost, wards (status), IP-009/IP-006 boards (equipment down).
- `bme.backup.issued` {equipment_id, ward} → IP-003 notice.
- `bme.recall.matched` {equipment_ids, action} → wards, NC-015, NC-005.
- `bme.mvpi.reported` → NC-015, Quality.
- `bme.aerb.licence.expiring|qa.overdue|tld.exceeded` → RSO, NC-023, OP-008.
- Consumes: `asset.capitalised|transferred|contract.expiring|service_call.closed|disposed` (NC-002), `purchase.grn.accepted` (NC-005 spares/new eq), `iot.telemetry|alarm` (EN-042), `training.completed` (NC-027), `incident.reported` (NC-015 equipment tag), `licence.expiring` (NC-023 AERB/PNDT), `crashcart.check.completed` (IP-013 defib), `anaesthesia.machine.check` (IP-024), `lab.instrument.maintenance` (EN-004).

## 8. Screens (UI)
- **BME Dashboard** (desktop): tiles — down critical equipment, open breakdowns by severity, PM/cal due this week/overdue, AERB/PNDT expiring, uptime % by department, vendor SLA breaches; realtime WS updates.
- **Equipment 360** (desktop/tablet; opened by QR): header (name, dept, status, coverage), tabs History/PM/Calibration/Breakdowns/Docs/Telemetry/Costs; actions Report fault, Schedule PM, Move, Issue from pool; `Ctrl+K` search by tag/serial.
- **PM/Calibration Execution** (tablet/phone; offline): checklist with readings validation (ranges), photo, part scan, sticker print, user sign-off pad; `Enter` next item.
- **Breakdown Board** (desktop kanban): Open → Attended → Vendor/Parts pending → Repaired → Testing → Closed; severity colours; timers vs SLA; quick vendor notify; backup issue button.
- **Report Fault** (nurse; IP-003/IP-004/NC-014): scan tag → symptom chips → severity → photo → submit; shows ETA & backup status.
- **Ward Equipment Panel** (IP-003 widget): equipment in ward with status/PM due badges; daily check entry per shift.
- **AERB/RSO Console**: licences, QA calendar, TLD results table with thresholds, surveys, decommission checklist.
- **Pool Desk** (tablet): available/issued devices, issue by scan to ward/patient, return condition.
- **Recall Manager**, **BER approvals**, **Config** (categories, templates, frequencies, thresholds).
- Empty/error states; WCAG 2.2 AA; i18n.

## 9. Integrations
- NC-002 shared work orders/service calls/contracts/disposal; NC-005/NC-006 spares & PO; NC-021 vendor portal (calls, PM visits, uptime reports); EN-042 telemetry (Modbus/BLE/HL7 device data via vendor gateways; temperature loggers); EN-013 QR/PM stickers (ZPL); NC-023 AERB eLORA/PNDT licence records (eLORA is a portal — record refs, no public API); CDSCO/MvPI forms (PDF/portal); NC-015 incidents; NC-027 training; EN-031/OP-004 lab equipment; IP-013 crash-cart; IP-024 anaesthesia checks; NC-025 utilities alarms; NC-011 analytics; EN-036 bulk import of legacy registers (Excel).

## 10. Reports & Analytics
- Equipment inventory by department/category/criticality/age; PM compliance % (planned vs done on time) by department/category (NABH FMS.6), calibration compliance & expiring certificates, electrical safety test status, uptime % (life-support ≥ 98 % target), downtime hours by equipment/department, MTBF/MTTR, breakdown Pareto (cause, model), vendor SLA & AMC value vs repair cost, cost of ownership & replacement candidates (age > life, cost ratio, recurring faults), AERB status (licences, QA due, TLD doses), PNDT registration status, user daily-check compliance, pool utilisation, recalls status, MvPI reports; read model `analytics.bme_equipment_kpis`.

## 11. Notifications
- BME: new breakdown (critical → call/push repeat), vendor SLA nearing, PM/cal due digest, telemetry alarms, recall alerts; Ward in-charge: equipment down/backup issued/restored, PM visit scheduled, overdue daily checks; Vendor: call details, PM visit due (portal/email/WhatsApp); RSO: TLD exceed, licence expiry (90/60/30 d), QA due; HOD/MS: life-support down > 2 h, uptime below target; Purchase/Finance: chargeable repair approvals, BER approvals; Quality: incidents/MvPI.

## 12. Permissions (RBAC keys)
`bme.equipment.manage|read`, `bme.schedule.read`, `bme.pm.execute|manage`, `bme.usercheck.record|read` (nurses/technicians), `bme.calibration.record|read`, `bme.breakdown.report` (all clinical/ops staff), `bme.breakdown.manage`, `bme.pool.manage|read`, `bme.aerb.manage|read` (RSO/radiology in-charge), `bme.recall.manage`, `bme.mvpi.create`, `bme.ber.manage|approve` (BME head/HOD/committee), `bme.report.read`, `bme.export`, `bme.configure`; `integration.bme.ingest`; vendor portal `vendor.bme.call.update`. Defaults: Biomedical Engineer (48) all; nurses (17/18/20) report/usercheck/read; Radiologist/Radiology tech (12/36) AERB read; Lab Quality (35) calibration read; Facility (49) read; Finance (46) BER approve/report; Quality (54) report.

## 13. Non-functional
- Volumes: 2000-bed hospital → 8–12k medical equipment items, 1,500 PM orders/month, 300 calibrations/month, 400 breakdowns/month, 5k daily user checks/day, telemetry 1M readings/day (partitioned); due-list queries p95 < 200 ms; breakdown creation from tag < 2 s end-to-end incl. notifications.
- Offline: PM/cal execution & user checks on tablets queue; breakdown reporting queues with local timestamp.
- Printing: PM/cal stickers (ZPL), certificates, BER certificate, AERB forms; PDF exports for NABH/NABL/AERB audits.
- Security: RLS; vendor portal scoped to own contracts; audit on overrides (RSO, PM hard-stop).
- i18n; accessibility; large tap targets for tablets on rounds.

## 14. Acceptance Criteria
1. Given a medical asset capitalised in NC-002, then a draft bme_equipment record appears in BME "to onboard" list and cannot be set `in_service` until acceptance test, PM schedule and user-training record exist (life-support).
2. Given a ventilator with quarterly PM last done 1 Jan, then PM due 1 Apr appears in the due list from 25 Mar (lead 7 d), overdue on 8 Apr with escalation to BME head and NABH indicator update.
3. Given a nurse scans a syringe pump tag and reports "not infusing" with severity critical, then a breakdown is created within 2 s, equipment status `down`, BME receives push+call, and a pool pump is proposed for issue to that ward.
4. Given repair completed on a class C device, then closing is blocked until a post-repair electrical safety/functional test record with pass exists and the user in-charge signs acceptance.
5. Given a breakdown reported 09:00, BME responded 09:20, waiting-for-user 60 min, restored 12:00, then downtime = 120 min, response met (≤ 30 min), MTTR updated.
6. Given a calibration certificate with as-found out of tolerance, then the equipment is `quarantined`, an impact-assessment task is created (lab equipment → EN-031), and return to service requires a passing re-calibration.
7. Given a CT with AERB QA overdue, then status cannot be `in_service` (RSO override with reason only), OP-008 shows the equipment unavailable for scheduling.
8. Given a TLD result 5.5 mSv/quarter for a technologist above investigation level, then RSO gets a task and the record is flagged.
9. Given a repair estimate ₹4.5 L on a device with replacement value ₹10 L (45 % > 40 %), then BER can be raised; approval via EN-038 creates NC-002 disposal request.
10. Given an OEM recall for model X serials 100–200, then matching equipment are listed, `stop_use` action quarantines them and wards are notified.
11. Given a defibrillator with no daily user check for the morning shift by 10:00, then ward in-charge and BME see the miss on their dashboards.
12. Given a vendor under CMC with 4 h response SLA responds after 6 h, then the call shows SLA response breach and NC-021 vendor score decreases.
13. Given a user with only `bme.breakdown.report`, then they cannot close breakdowns (403) and audit logs the attempt.
14. Given a monitor with 3 breakdowns in the last 12 months on annual PM, then the risk score proposes tightening to half-yearly and the engineer must accept/decline with reason.
15. Given a warranty ending in 60 days on a CT, then a task "decide AMC/CMC" is created for purchase with the equipment's downtime/cost history attached.
16. Given an inter-branch loan of 5 infusion pumps due back in 14 days and not returned on day 15, then reminders go to both BME teams and the pool availability shows the deficit.
17. Given a decommissioning of an ultrasound machine, then the checklist blocks completion until data-wipe confirmation and PNDT deregistration intimation are recorded.
18. Given a temperature logger on a blood-bank refrigerator reports 7 °C for 20 min (limit 2–6 °C), then an alarm reaches blood bank & BME, an event is logged for IP-007 evidence, and a breakdown draft is created if not acknowledged in 15 min.

### 14.1 Test data & golden path (for e2e)
- Seed 25 equipment across ICU/OT/Radiology/Lab (2 life-support, 1 CT with AERB, 1 USG with PNDT, 5 pool pumps), PM/cal schedules; simulate breakdown from tag → backup issue → repair → safety test → close; calibration failure → quarantine → re-cal; AERB QA overdue → OP-008 unavailable; verify KPIs.

## 15. Enhancements / Later phases
- From VIMS sheet: equipment registry, AMC tracking, breakdown log, calibration (Phase 9 core; registry earlier for OT/ICU).
- (market) Equipment utilisation analytics from telemetry (idle vs used hours), predictive failure from error-code patterns (AI-005), CMMS-style mobile vendor engineer app, IoT temperature compliance dashboards for blood bank/vaccine fridges (EN-042), RTLS location of pool devices, benchmarking uptime across group branches (EN-041), automatic AERB eLORA reminders, digital equipment manuals & QR-linked user videos (NC-027), integration with OEM remote-service portals (Philips/GE/Siemens) via EN-017, energy consumption per equipment (NC-025).

## 16. Open Questions for the Hospital
1. Current equipment inventory format (Excel/legacy CMMS) for import; number of items and departments; existing tag scheme?
2. Criticality classification and PM/calibration frequencies per category (manufacturer vs internal policy) — provide the BME SOP; NABH/NABL checklist templates?
3. In-house BME team size and vendor coverage split; SLA targets by severity; BER threshold %?
4. Radiation equipment list, RSO, AERB eLORA licence details, TLD service provider; PNDT-registered USG machines?
5. Do you run a central pool for pumps/monitors? Rental equipment usage?
6. Telemetry sources available (device gateways, temperature loggers) and desired alarms?
7. Who approves chargeable repairs by value band and BER (committee composition)?

