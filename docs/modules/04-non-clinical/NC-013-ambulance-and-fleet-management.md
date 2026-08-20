# NC-013 — Ambulance & Fleet Management (Fleet Master, Trips, GPS, Dispatch, Drivers, Fuel/Maintenance, Billing)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Non-Clinical / ERP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Module ID       | NC-013                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Phase           | 6 (dispatch, trips, GPS, billing — with TR-009 for trauma) / 9 (fuel, maintenance, permits, analytics)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Priority        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Depends on      | TR-009 (clinical pre-hospital layer: PCR, vitals relay, ER pre-alert, 108/112 feeds — TR-009 rides on NC-013 trips), OP-006 (ER pre-arrival), IP-018 (inter-facility transfer requests), OP-005/IP-005 (trip billing to patient bill or standalone receipt via NC-001), RC-003 (ambulance tariffs), NC-002 (vehicles as assets, depreciation, insurance), NC-006 (ambulance store consumables/O2), NC-010 (drivers/EMTs employee, licences NC-010 credentials), NC-030 (crew roster), NC-024 (non-ambulance transport — shared fleet tables), NC-023 (permits/fitness/PUC/insurance licence tracker), EN-042 (telematics/GPS devices via EN-017), EN-009/EN-037 (SMS/push), EN-018 (dispatch board TV), OP-020/PE-001 (patient booking/tracking), NC-011, EN-024, NC-021 (fuel/maintenance vendors)                                                                                               |
| Feature flag    | `module.ambulance.enabled` (sub: `ambulance.gps`, `ambulance.public_tracking`, `ambulance.fuel_cards`, `ambulance.equipment_checklist`, `ambulance.permits`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Primary roles   | Ambulance Dispatcher (52), Driver / EMT (52, trip app), Fleet Manager (Facility 49 / dedicated), Ambulance in-charge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Secondary roles | ER receptionist/nurse (19/24), Billing (27), Biomedical (48, on-board equipment), Finance (46), Security/gate (51), Patient/relative (59/60 booking & tracking), Call centre (25), Quality (54, response KPIs), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Regulatory      | Motor Vehicles Act & CMVR (registration, fitness certificate, permit — ambulance category, PUC, insurance, speed governor), AIS-125 ambulance construction/equipment standards (Type A/B/C/D — BLS/ALS/patient transport), National Ambulance Code, state EMS (108/102/112) protocols & MoUs, Drug licences for on-board drugs (Schedule H/NDPS register for ALS), medical gas cylinder rules (O2 — Gas Cylinder Rules 2016/PESO), BMW 2016 (on-board waste), Consumer Protection (transparent tariff display per km), NABH (ambulance services standards ACC/COP), driver licences (transport badge), working hours (Motor Transport Workers Act), GST (ambulance services exempt under healthcare when by clinical establishment — SAC 9993/ notification 12/2017; standalone patient transport may differ — configurable), road-tax/toll (FASTag) reconciliation, DPDP (location data of crew) |

## 1. Purpose

NC-013 runs the hospital's **ambulance and vehicle fleet**: vehicle register (type ALS/BLS/PTV/neonatal/mortuary van/staff vehicles), statutory documents & renewals, drivers/EMTs with licences and shifts, **request → dispatch → trip sheet** (start/end KM & time, pickup, arrival, handover) with GPS tracking, ETA and route history, nearest-available auto-selection for emergencies, response-time SLA logging, per-trip billing (distance/flat/ALS/waiting/escort) into the patient bill or standalone receipt, fuel logs and cards, maintenance schedules & breakdowns, on-board equipment/drug checklists and restocking, permits/insurance/fitness tracking, and fleet utilisation analytics. Clinical care during transport (PCR, vitals relay, pre-alert) is TR-009 on the same trip.

## 2. Users & Jobs-to-be-done

- **Dispatcher** (desktop dispatch console + TV board): receive requests (ER/ward/108/patient app/call centre/inter-facility), see live map & availability, assign vehicle + crew (or accept auto-suggestion), monitor trip milestones, handle diversions/cancellations, close trips, escalate delays.
- **Driver/EMT** (phone PWA, offline-tolerant): shift on/off with vehicle & pre-trip checklist, accept trip, navigate, mark milestones (en route/at scene/departed/arrived/handover/available), enter KM/fuel/tolls, capture patient signature/relative consent, report breakdown, restock request.
- **Fleet manager**: vehicle documents & renewals, PM schedules/service, breakdown log, fuel/tyre/battery analytics, driver performance (speeding/harsh events from telematics), permits, insurance claims (NC-002), vendor bills (NC-005/NC-009).
- **Billing**: trip charges auto-posted (patient bill or receipt), payer rules (insurance/PMJAY ambulance benefit), waivers approvals.
- **Patient/relative** (app/web): request ambulance, share location, track ETA (`ambulance.public_tracking`), pay online.
- **Quality**: response time & SLA compliance, equipment readiness, incident reporting.

## 3. Core Workflows

### 3.1 Fleet register & compliance

1. **Fleet manager** registers vehicle: fleet id, registration no., make/model/year, type enum(ALS/BLS/PTV/neonatal/hearse/mortuary_van/staff_car/bus/utility), base station/branch, capacity/stretcher, on-board equipment list (ventilator, monitor/defib, suction, O2 cylinders with capacity — link NC-002/NC-020 assets), GPS device id (IMEI), fuel type & tank, FASTag id, fuel card no., insurance (policy, expiry), fitness certificate expiry, permit (type/expiry), PUC expiry, road tax, speed governor cert, ownership (owned/leased/outsourced vendor NC-021), asset id (NC-002), status enum(available/on_trip/out_of_service/maintenance/decommissioned) → **document expiry tracker** (`ambulance.permits`, with NC-023): alerts 60/30/7 days; expired mandatory docs → vehicle auto `out_of_service` unless override → Event `fleet.vehicle.registered|document.expiring`.
2. **Drivers/EMTs**: employee link (NC-010), driving licence (class, transport badge, expiry — NC-010 credentials), medical fitness, training (BLS/ALS/defensive driving — NC-027), shift roster (NC-030), performance score (on-time %, incidents, telematics events).

### 3.2 Request intake

1. Sources: ER/ward staff (patient transfer, discharge drop, inter-facility IP-018), 108/112/state EMS feed (TR-009 connector), patient/relative (app/portal/IVR EN-033/call centre), corporate/event standby, non-patient (staff transport → NC-024, blood/sample courier) → **request** with: type enum(emergency_pickup/scheduled_pickup/discharge_drop/inter_facility_transfer/return_trip/event_standby/mortuary/other), priority (emergency/urgent/scheduled), pickup & drop locations (map pin/address/geocode), patient (UHID or new pre-registration OP-006), clinical need (ALS/BLS/neonatal/ventilator/escort doctor/nurse — from requester or TR-009 triage), requested time, contact, payer info, special (bariatric, isolation) → **System** validates, creates `fleet_requests` → Event `fleet.request.created`.

### 3.3 Dispatch & assignment

1. **Dispatcher** (or auto for emergencies): **nearest suitable available vehicle** ranking (GPS distance/ETA via routing provider, capability match, crew on shift, fuel level, equipment checklist passed) → assign vehicle + crew (driver + EMT/nurse/doctor per need) → crew app push (accept within 60 s else re-assign/escalate) → trip created (`AMB_TRIP` series) → status timeline: assigned → en_route → at_scene → patient_onboard/departed → arrived_hospital → handover_complete → available (or return trip) — each with server timestamp + device timestamp + GPS point; geofence auto-transitions (arrived at hospital) → **ER pre-alert** via TR-009 → Event `fleet.trip.dispatched|status_changed`.
2. Exceptions: no vehicle available → queue with ETA estimate, suggest outsourced/108, escalate to ambulance in-charge; cancellation (by requester/patient) → reason, cancellation charge rule; diversion to another hospital → destination change logged; breakdown mid-trip → replacement dispatch, incident.
3. Scheduled trips (discharges, dialysis pickups, health-check pickups): planning board by time slots; route batching (multiple pickups) for PTV.

### 3.4 Trip sheet & GPS tracking (`ambulance.gps`)

1. Trip sheet auto-filled: start time/odometer (driver enters or telematics), pickup arrival, patient onboard, hospital arrival, end odometer/time, distance (GPS-computed vs odometer; discrepancy > 10 % flagged), waiting time, tolls (FASTag import), crew, escorts, patient/relative signature (touch), remarks → **GPS**: device positions every 5–10 s (EN-042 gateway: NMEA/vendor API/MQTT) or crew phone geolocation fallback → live map (dispatcher/ER/family link), ETA recompute, route history (postgis linestring per trip), speed monitoring (alerts > limit; harsh braking if telematics supports), idle time, geofence events → Event `fleet.gps.position` (stream, not outbox), `fleet.trip.completed`.
2. Public tracking link (`ambulance.public_tracking`): tokenised URL/app screen with vehicle position & ETA, no PHI; expires at trip end.

### 3.5 Equipment & drug checklist per trip (`ambulance.equipment_checklist`) (VIMS enhancement)

- Shift-start and post-trip checklists on crew app: equipment (defib/monitor battery, suction, O2 cylinder pressure/level, stretcher, splints, PPE), drugs (expiry, counts incl. NDPS with two-person count and register), consumables → failures block "available" until resolved or supervisor override; consumables used per trip → restock list to ambulance store (NC-006 sub-store) → NDPS register (with OP-003 rules) → NC-020 for equipment faults.

### 3.6 Billing

1. On `handover_complete`/trip close: tariff (RC-003 `ambulance` service group): base by vehicle type (ALS/BLS/PTV), per-km beyond included km (GPS distance or odometer per config, rounded), waiting charges, night surcharge, escort (doctor/nurse), oxygen/consumables (from checklist usage), tolls at actuals, outstation/inter-city slabs, cancellation fee → **post to patient bill** (OP-005 OP visit/ER visit or IP-005 admission) or **standalone receipt** (non-patient/relative pays at NC-001 counter/online link) or credit (corporate/insurer/PMJAY ambulance benefit; 108 trips = no charge) → estimate shown to relative at booking (RC-008); waiver/discount approvals (EN-038) → Event `fleet.trip.billed`.
2. Outsourced vendor ambulances: vendor bill per trip (NC-005/NC-009) with hospital markup config.

### 3.7 Fuel, maintenance & breakdown

1. **Fuel log**: per fill (vehicle, driver, date, litres, amount, odometer, station, receipt photo; fuel card import `ambulance.fuel_cards`) → km/l trend, anomaly (fill > tank capacity, mileage drop > 20 %) → alerts; FASTag/toll statements import; tyre/battery replacements.
2. **Maintenance**: PM schedule by km/time (service intervals), work orders (NC-002/NC-025 shared work-order model), vendor garage (NC-021), cost tracking, downtime; **breakdown log** (during trip or otherwise) → incident, replacement, repair, root cause; recall/insurance claims (NC-002).
3. Vehicle out-of-service planning to maintain minimum ALS/BLS availability (config e.g. ≥ 2 ALS available 24×7 → alert when breached).

### 3.8 Response time & SLA

- Milestone timestamps → metrics: call-to-dispatch, dispatch-to-scene, scene time, scene-to-hospital, hospital offload/handover, total; targets per priority/zone (urban 15 min to scene, etc.); SLA compliance % dashboards; delays > threshold auto-notify in-charge; monthly report to quality (NC-015 indicator "ambulance response time").

### 3.9 Mass casualty / event standby & mortuary transport

- MCI (OP-006 `er.mci.declared`) → dispatch console enters MCI mode: recall off-duty crews (NC-030), stage vehicles, batch trips from scene, coordinate with 108; **event standby** (camps NC-035, sports events) → standby trip with hourly billing; **mortuary van** trips (IP-017 body handover) → separate tariff & documentation (release form ref), no PHI to tracking link.

### 3.10 Exceptions & edge cases

1. GPS device offline → fallback to crew phone geolocation; if both absent, milestones manual with `no_gps` flag; ETA shown as estimate.
2. Patient not found at scene / refused transport → trip `aborted` with reason; cancellation/attendance charge per tariff (config); TR-009 refusal documentation.
3. Two requests for one vehicle (return trip while at destination) → dispatcher chains trips; odometer continuity enforced.
4. Vehicle breakdown with patient onboard → emergency re-dispatch nearest; incident auto-created; billing single trip.
5. Crew shift ends mid-trip → shift auto-extended until `available`; OT flag to NC-010.
6. Toll/fuel entries after trip close → allowed within 48 h with reference; billing adjustments via credit/debit rules.
7. Inter-state trips → permit validity check for destination state; outstation slab billing; driver rest rules (Motor Transport Workers Act) warning for > 8 h continuous.
8. Patient app request outside service radius → decline with nearest partner suggestion (config).

### 3.11 Configuration defaults (seed)

- Acceptance timeout 60 s; distance discrepancy tolerance 10 %; document alerts 60/30/7; availability minimum per branch (1 ALS + 1 BLS); checklist templates BLS/ALS per AIS-125; tariff template (base/included km/per km/waiting per 15 min/night 20 %/escort charges); GPS interval 10 s; public tracking token expiry at trip end; series `AMB_REQ`, `AMB_TRIP`.

## 4. Data Model (schema `ops`, prefix `fleet_`; GPS with postgis)

- **fleet_vehicles**: id, hospital_id, branch_id, fleet_code, registration_no, type enum, make, model, year, capacity jsonb, equipment jsonb [{asset_id, name, mandatory}], gps_device_id, gps_provider, fastag_id, fuel_type, tank_capacity_l, fuel_card_no, ownership enum(owned/leased/outsourced), vendor_id?, asset_id? (NC-002), base_station_id, status enum, status_reason, current_odometer, last_position geometry(Point,4326), last_position_at, current_trip_id?, is_active. UNIQUE (hospital_id, registration_no).
- **fleet_vehicle_documents**: vehicle_id, type enum(rc/insurance/fitness/permit/puc/road_tax/speed_governor/ambulance_licence/other), number, issued_on, expiry_on, file_id, status enum(valid/expiring/expired), mandatory bool.
- **fleet_stations**: id, branch_id, name, location geometry, geofence_radius_m.
- **fleet_crew**: id, employee_id (NC-010), role enum(driver/emt/nurse/doctor/attendant), licence_ref (credential id), badge_no, status, performance_score; **fleet_crew_shifts**: crew_id, vehicle_id?, shift_start, shift_end, roster_ref (NC-030), checklist_passed bool, status enum(on_duty/on_trip/break/off).
- **fleet_requests**: id, hospital_id, branch_id, request_no, source enum(er/ward/ip_transfer/discharge/ems_108/ems_112/patient_app/call_centre/corporate/event/internal), type enum, priority enum(emergency/urgent/scheduled), patient_id?, prehospital_trip_id? (TR-009), pickup jsonb {address, geom, contact}, drop jsonb, requested_at, required_at, clinical_need enum(als/bls/ptv/neonatal/ventilator/isolation), escorts jsonb, payer jsonb, requester_user_id?, requester_contact, status enum(new/queued/assigned/cancelled/converted), cancel_reason, estimate_amount.
- **fleet_trips**: id, hospital_id, branch_id, trip_no, request_id, vehicle_id, crew jsonb [{crew_id, role}], status enum(assigned/en_route/at_scene/patient_onboard/arrived_hospital/handover_complete/return/completed/cancelled/aborted), milestones jsonb [{status, at_server, at_device, geom}], start_odometer, end_odometer, gps_distance_km, odometer_distance_km, distance_flagged bool, waiting_minutes, tolls jsonb, route geometry(LineString,4326)?, patient_id?, destination_hospital? (for transfers), destination_changed_reason?, signature_file_id, remarks, billing_status enum(not_billable/pending/posted/credit/waived/failed), bill_item_ids uuid[], receipt_id?, vendor_bill_id?, sla jsonb {targets, actuals, met bool}, incident_id?, closed_by, closed_at. INDEX (hospital_id, branch_id, created_at desc), (vehicle_id, status), (patient_id).
- **fleet_positions** (partitioned daily/monthly, postgis): vehicle_id, at, geom, speed_kmh, heading, ignition bool, source enum(device/phone), trip_id?. INDEX (vehicle_id, at desc), GIST(geom).
- **fleet_geofence_events**: vehicle_id, trip_id?, geofence enum(station/hospital/pickup/custom), event enum(enter/exit), at.
- **fleet_checklists**: id, vehicle_id, crew_shift_id?, trip_id?, kind enum(shift_start/post_trip/weekly), template_id, responses jsonb, failed_items jsonb, passed bool, override_by?, at; **fleet_restock_requests** (vehicle_id, items jsonb, store_indent_id NC-006, status).
- **fleet_ndps_register** (or link OP-003 controlled_drug_register with location=vehicle).
- **fleet_fuel_logs**: vehicle_id, driver_id, at, litres, amount, odometer, station, source enum(manual/card_import), receipt_file_id, km_per_l_computed, anomaly_flags text[]; **fleet_toll_logs** (vehicle_id, at, plaza, amount, source fastag/manual, trip_id?).
- **fleet_maintenance_plans**: vehicle_id, interval_km, interval_days, last_service_km/date, next_due; **fleet_work_orders** → NC-002 `asset_work_orders` (asset_id = vehicle asset) with `fleet_vehicle_id`; **fleet_breakdowns**: vehicle_id, trip_id?, at, location geom, description, replacement_vehicle_id?, resolved_at, cost, root_cause.
- **fleet_tariffs** (RC-003 view): vehicle_type, base_charge, included_km, per_km, waiting_per_15min, night_surcharge_pct, escort_charges jsonb, outstation_slabs jsonb, cancellation_fee, effective dates.
- **fleet_incidents**: trip_id?, vehicle_id, type enum(accident/speeding/complaint/equipment_failure/delay/other), severity, description, reported_by, actions, status (links NC-015 incident).
- **fleet_kpis_daily** (analytics): branch, date, trips by type, response times percentiles, sla_met_pct, utilisation, km, fuel cost.
- RLS; trips immutable after close except billing/incident links; positions retention 1 year hot then aggregated.

## 5. Business Rules & Validations

- Vehicle dispatchable only if status available, mandatory documents valid (or override with reason), shift-start checklist passed, crew on duty with valid licences (NC-010 credentials); ALS trips need ALS vehicle + qualified crew.
- Emergency requests: auto-suggest nearest by ETA; dispatcher confirmation within 60 s else auto-assign (config); acceptance timeout re-assign; every status transition timestamped; geofence auto-transitions can be corrected by dispatcher with audit.
- Odometer end ≥ start; GPS vs odometer discrepancy > 10 % flags trip for review before billing; distance basis per tariff config.
- Billing after `handover_complete`/`completed`; charges idempotent per trip; waivers per approval matrix; 108/state EMS trips non-billable to patient; credit rules for insurers/PMJAY (ambulance benefit caps); cancellation fee only after vehicle dispatched (config).
- Checklist failures on mandatory items block availability; NDPS counts two-person; consumables restock via NC-006 sub-store; O2 level below threshold blocks ALS/BLS availability.
- Fuel anomalies flagged; fuel entry requires odometer ≥ last; maintenance due (km/date) → warning, overdue by > X → out_of_service (config).
- Minimum availability rule per branch (e.g. ≥ 1 ALS + 1 BLS) → alert when breached; planned maintenance scheduling respects it.
- Public tracking links no PHI; crew location tracked only on duty (DPDP notice to crew).
- Retention: trips/billing 8 years; GPS raw 1 year; documents per NC-023.

## 6. API Surface (`/api/v1/fleet`)

| Method         | Path                                                                                 | Purpose         | Permission                                                       | Idem                                | Pag                                           |
| -------------- | ------------------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------- | ----------------------------------- | --------------------------------------------- |
| GET/POST/PATCH | /vehicles, /vehicles/{id} ; POST /vehicles/{id}/status ; /vehicles/{id}/documents    | fleet register  | fleet.vehicle.manage / .read                                     | Y                                   | cursor                                        |
| GET/POST       | /crew, /crew/shifts ; POST /crew/shifts/{id}/(start                                  | end)            | crew                                                             | fleet.crew.manage / fleet.crew.self | Y                                             | cursor           |
| POST           | /requests ; GET /requests?status=&priority= ; POST /requests/{id}/cancel             | intake          | fleet.request.create (ER/ward/call centre/patient scope) / .read | Y                                   | cursor                                        |
| GET            | /dispatch/suggest?request= ; POST /dispatch/assign ; POST /trips/{id}/reassign       | dispatch        | fleet.dispatch                                                   | Y                                   | –                                             |
| POST           | /trips/{id}/status (crew) ; POST /trips/{id}/(divert                                 | abort           | close) ; PATCH /trips/{id}/sheet                                 | trip lifecycle                      | fleet.trip.update (crew own) / fleet.dispatch | Y                | –       |
| GET            | /trips?vehicle=&status=&from=&to=&patient= ; GET /trips/{id}                         | trips           | fleet.trip.read                                                  | –                                   | cursor                                        |
| POST           | /positions (device/phone ingest, batch) ; GET /vehicles/live ; GET /trips/{id}/route | GPS             | integration.gps.ingest / fleet.map.read                          | Y                                   | –                                             |
| GET            | /public/track/{token}                                                                | public tracking | public (token)                                                   | –                                   | –                                             |
| POST           | /checklists ; GET /checklists/templates                                              | checklists      | fleet.checklist.submit / .manage                                 | Y                                   | cursor                                        |
| POST           | /restock ; POST /ndps/entries                                                        | restock/NDPS    | fleet.restock / fleet.ndps (2-person)                            | Y                                   | –                                             |
| POST           | /trips/{id}/bill ; POST /trips/{id}/waive                                            | billing         | fleet.trip.bill / fleet.trip.waive.approve                       | Y                                   | –                                             |
| GET/POST       | /fuel-logs ; POST /fuel/import ; GET/POST /toll-logs ; POST /toll/import             | fuel & tolls    | fleet.fuel.manage                                                | Y                                   | cursor                                        |
| GET/POST       | /maintenance/plans ; POST /breakdowns ; POST /breakdowns/{id}/resolve                | maintenance     | fleet.maintenance.manage                                         | Y                                   | cursor                                        |
| GET/POST       | /incidents                                                                           | incidents       | fleet.incident.manage                                            | Y                                   | cursor                                        |
| GET            | /reports/(trip-sheet/{id}                                                            | response-times  | utilisation                                                      | fuel                                | maintenance                                   | documents-expiry | billing | crew-performance) | reports | fleet.report.read | –   | –   |
| Patient app    | POST /me/ambulance-requests ; GET /me/ambulance-requests/{id}/track                  | booking         | patient.ambulance.request                                        | Y                                   | –                                             |

## 7. Domain Events (outbox)

- `fleet.request.created|cancelled` {request_id, priority, need} → dispatcher console, TR-009 (emergency), OP-006 pre-arrival.
- `fleet.trip.dispatched|assigned` {trip_id, vehicle, crew, eta} → TR-009 (clinical trip), crew app push, requester notification, EN-018 board.
- `fleet.trip.status_changed` {trip_id, status, at, geom} → TR-009 (pre-alert timing), ER board, patient tracking, SLA engine.
- `fleet.trip.completed|aborted` {trip_id, distance, times, sla} → billing (3.6), NC-011, NC-015 KPIs, crew availability, restock.
- `fleet.trip.billed` {trip_id, bill_item_ids/receipt_id, amount, payer} → OP-005/IP-005 (already posted), NC-009 (standalone/credit), RC-006.
- `fleet.vehicle.status_changed|document.expiring|expired` → fleet manager, NC-023, availability rule check.
- `fleet.checklist.failed` {vehicle, items} → in-charge, NC-020 (equipment), NC-006 (restock).
- `fleet.fuel.anomaly`, `fleet.maintenance.due|overdue`, `fleet.breakdown.reported` → fleet manager, NC-002 work order.
- `fleet.availability.breached` {branch, als_available, bls_available} → admin/ER.
- Consumes: `prehospital.trip.created` (TR-009 108 feed → request), `transfer.requested` (IP-018), `patient.discharge.ready` (IP-002 → scheduled drop offer), `roster.published` (NC-030 crew shifts), `hr.licence.expired` (NC-010 → crew unavailable), `iot.gps.position` (EN-042), `bill.finalized|payment.received` (billing status), `asset.workorder.completed` (NC-002 → vehicle back in service).

## 8. Screens (UI)

- **Dispatch console** — desktop (dark) + TV (EN-018): left request queue (priority colours, SLA timers), centre live map (vehicles with status colours, ETA, geofences), right assignment panel (suggestions ranked, crew, capability); `A` assign, `R` reassign, `C` cancel, `Space` focus map on selected; realtime Socket.IO; degraded mode without map tiles shows list.
- **Crew trip app** — phone PWA (offline-tolerant): shift start (vehicle, checklist), trip card (navigate via maps app deep link, milestone buttons big-tap, KM/odometer entry, signature, consumables used, notes), incident/breakdown button, restock; queues status updates offline with device timestamps.
- **Trip sheet** — desktop/tablet: full sheet, map route, timings, billing panel, print PDF.
- **Fleet manager workspace** — desktop: vehicles grid (status, docs expiry heat), documents, maintenance plans/work orders, fuel & toll logs with anomaly flags, breakdowns, minimum-availability gauge.
- **Scheduled trips planner** — desktop: day/time grid, batching.
- **Patient/relative booking & tracking** — app/web (OP-020/PE-001): request form with map pin, estimate, tracking screen.
- **Reports/dashboards** — desktop: response times, utilisation, SLA, fuel efficiency, crew scores.
- Empty/error states; loading skeletons; large tap targets on crew app; i18n.

### 8.1 Screen behaviours (detail)

- **Dispatch console**: request cards colour by priority with SLA countdown; map clusters at low zoom; vehicle pins show type/status/crew initials; hover shows last position age (grey > 60 s stale); assignment panel ranks by ETA with reasons for exclusion (checklist failed, docs expired, off-shift); keyboard-only assignment path; TV mode strips PHI (case id only).
- **Crew app**: single-screen trip card; milestone buttons in sequence (next enabled only), long-press to confirm; automatic geofence suggestions ("Looks like you arrived — confirm?"); odometer photo capture optional; signature pad; SOS/breakdown always visible; low-battery mode reduces GPS interval.
- **Trip sheet**: timeline with device/server timestamps side-by-side, GPS route replay, distance basis selection with justification, billing panel with tariff breakdown & payer rules, print.

### 8.2 Seeded reports (NC-011 catalogue)

`fleet.trip_register`, `fleet.response_times`, `fleet.sla_compliance`, `fleet.utilisation`, `fleet.revenue_by_type`, `fleet.waivers`, `fleet.fuel_efficiency`, `fleet.maintenance_cost_per_km`, `fleet.documents_expiry`, `fleet.checklist_compliance`, `fleet.incidents`, `fleet.crew_performance`, `fleet.gps_odometer_discrepancy`, `fleet.outsourced_trips`.

## 9. Integrations

- GPS/telematics vendors (device APIs/MQTT/NMEA over GPRS) via EN-042/EN-017; routing/ETA (Google/Mapbox/OSRM self-hosted on-prem) with straight-line fallback; maps tiles; FASTag/toll statements (CSV/API); fuel card providers (CSV/API); TR-009 (108/112 state EMS APIs); OP-006/IP-018; OP-005/IP-005/NC-001/RC-003 billing; NC-002 assets/work orders; NC-006 ambulance store; NC-010/NC-030 crew; NC-023 documents; EN-009 SMS (tracking link), EN-037 push, EN-033 IVR; NC-021 outsourced ambulance vendors; NC-015 incidents.

## 10. Reports & Analytics

- Trip register & trip sheets, response-time distribution (call→dispatch→scene→hospital) by priority/zone/vehicle/crew, SLA compliance %, fleet utilisation (trips/km/hours per vehicle, idle %), availability breaches, revenue per trip type & payer, waivers, fuel efficiency (km/l per vehicle/driver), maintenance cost per km, downtime, document expiry compliance, checklist compliance, incidents (accidents/speeding), crew performance, outsourced trips & cost, GPS vs odometer discrepancies. Read models: `analytics.fleet_kpis_daily`, `analytics.fleet_vehicle_monthly`.

## 11. Notifications

- Crew: trip assignment (push + SMS fallback), acceptance timeout, checklist due, licence expiry (NC-010).
- Dispatcher/in-charge: no vehicle available, acceptance timeout, delays vs SLA, breakdown, availability breach, document expiries.
- Requester/ER: assigned/ETA/arrived; family: tracking link SMS/WhatsApp (non-PHI), completion & payment link.
- Fleet manager: maintenance due, fuel anomaly, permits expiring 60/30/7; Finance: standalone billing/waivers; Quality: monthly response report.

## 12. Permissions (RBAC keys)

`fleet.vehicle.manage/read`, `fleet.crew.manage`, `fleet.crew.self`, `fleet.request.create/read`, `fleet.dispatch`, `fleet.trip.update` (own trip), `fleet.trip.read`, `fleet.map.read`, `fleet.checklist.submit/manage`, `fleet.restock`, `fleet.ndps` (requires_second_person), `fleet.trip.bill`, `fleet.trip.waive.approve`, `fleet.fuel.manage`, `fleet.maintenance.manage`, `fleet.incident.manage`, `fleet.report.read`, `fleet.configure`, `patient.ambulance.request` (patients), `integration.gps.ingest` (device tokens). ABAC: crew sees own trips; branch scope; amount limits on waivers.

## 13. Non-functional

- Volumes: 30–60 vehicles per group, 200–400 trips/day, GPS 5–10 s → up to 500k positions/day (partitioned, GIST); dispatch suggestion < 1 s; status update propagation < 2 s to boards; map with 60 vehicles smooth on 1080p TV.
- Offline crew app: milestones/KM/checklists queued with device time; sync idempotent; SMS fallback for assignment.
- Printing: trip sheet PDF, receipts (NC-001), checklists.
- Security: public tracking tokens short-lived; crew location only on duty; PHI minimal in fleet tables (patient_id link only); RLS; audit on manual timestamp corrections and waivers.
- i18n/accessibility: crew app large buttons, regional languages, voice prompts optional; WCAG 2.2 AA.

## 14. Acceptance Criteria

1. Given an emergency request from ER with ALS need, then the console lists available ALS vehicles ranked by ETA excluding vehicles with failed checklists or expired fitness; assigning pushes to crew and creates a TR-009 clinical trip.
2. Given crew does not accept within 60 s, then the trip is offered to the next vehicle and the dispatcher is alerted.
3. Given the vehicle enters the hospital geofence, then status auto-changes to `arrived_hospital` with GPS point and ER board updates within 2 s.
4. Given trip closed with GPS distance 18.2 km and odometer 22 km (> 10 % discrepancy), then billing is held for review; after dispatcher confirms basis, charges post to the IP bill per tariff (base + per-km beyond included + night surcharge).
5. Given a 108-sourced trip, then billing_status = `not_billable` and no patient charge is created.
6. Given a shift-start checklist with O2 cylinder below threshold, then the vehicle cannot be set available until restocked or overridden by in-charge with reason (audited).
7. Given insurance expiry tomorrow, then alerts were sent at 60/30/7 days; on expiry without renewal the vehicle becomes `out_of_service` and dispatch excludes it.
8. Given fuel log 70 L on a 60 L tank, then an anomaly is flagged to the fleet manager.
9. Given only one ALS vehicle available against a minimum of two, then availability breach alert fires to admin/ER and planned maintenance scheduling warns.
10. Given the crew app offline during a trip, then milestone taps queue with device timestamps and sync on reconnect preserving order; SLA computations use device times with server receipt noted.
11. Given a relative receives the tracking link, then the page shows vehicle position/ETA without patient details and stops at trip end.
12. Given a scheduled discharge drop for tomorrow 10:00, then it appears in the planner and reminder to crew at 09:30; cancellation after dispatch applies cancellation fee per rule.
13. Given an outsourced vendor trip, then a vendor bill draft is created in NC-005/NC-009 and the patient charge uses hospital tariff.
14. Given a patient refuses transport at scene, then the trip is aborted with reason, an attendance charge applies only if configured, and TR-009 records the refusal.
15. Given a vehicle breakdown with patient onboard, then re-dispatch of the nearest suitable vehicle is one click, an incident is auto-created, and the patient is billed for a single trip.
16. Given MCI declared, then the console switches to MCI mode showing staged vehicles, off-duty crew recall list and batch trip creation from the scene.
17. Given a driver on duty 8.5 h continuous, then the dispatcher sees a rest-rule warning before assigning a new trip.

## 15. Enhancements / Later phases

- From VIMS sheet: equipment checklist per trip (`ambulance.equipment_checklist`, Phase 9), patient monitoring during transport (TR-009 Phase 6), inter-hospital transfer coordination (TR-009/IP-018), insurance/permit management (`ambulance.permits` with NC-023, Phase 9), 108/112 emergency integration (TR-009 connectors, Phase 6/11).
- (market) Route optimisation & batching for PTV, driver behaviour scoring from telematics, dash-cam integration, automated toll/fuel reconciliation, dynamic pricing (surge) — not recommended for healthcare, air ambulance coordination, drone/blood courier tracking (NC-024), predictive maintenance (AI-005), patient app payments & ratings (EN-030).

## 16. Open Questions for the Hospital

1. Fleet size/types per branch, ownership (owned/outsourced), existing GPS devices/vendors and data access?
2. Dispatch model: dedicated dispatcher 24×7 or ER reception; 108/state EMS integration availability?
3. Ambulance tariff structure (base/km/waiting/escort/night/outstation), payer rules, 108/free-trip policies?
4. Crew composition (driver/EMT/nurse/doctor) and roster ownership; licences/training tracking already in HR?
5. Checklist templates (BLS/ALS per AIS-125), NDPS drugs carried, restock store?
6. Maintenance & fuel practices (cards, vendors, in-house garage)?
7. Minimum availability rule per branch and escalation contacts?
8. Public tracking link and patient app booking desired at go-live?
