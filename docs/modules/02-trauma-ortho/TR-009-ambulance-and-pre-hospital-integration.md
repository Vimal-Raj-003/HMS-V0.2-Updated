# TR-009 — Ambulance & Pre-Hospital Integration (108/112 link, GPS, pre-hospital vitals relay, ETA, ER pre-alert, handover)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Trauma & Orthopaedics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Module ID       | TR-009                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Phase           | 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Priority        | P1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Depends on      | NC-013 (Ambulance & Fleet Management — vehicle register, trip sheets, drivers, dispatch, fuel/maintenance, per-trip billing; TR-009 is the **clinical pre-hospital layer** on NC-013 trips: patient care record, vitals relay, pre-alert, handover), OP-006 (ER pre-arrival record, bay pre-assignment, board), TR-001 (field START/JumpSTART, activation criteria from pre-hospital data, KPI timestamps), TR-007 (case card), IP-018 (inter-facility transfer clinical docs), OP-007/EN-042 (portable monitor vitals capture in ambulance), EN-013 (MCI tags, wristbands), EN-017 (108/112/state EMS APIs, integration hub), EN-019 (FHIR/HL7 for external EMS/hospital exchange), EN-037/EN-009/EN-033 (alerts, SMS, IVR), EN-018 (inbound board), EN-028 (consent), TR-008 (MLC from scene), IP-007 (blood pre-alert), OP-008 (CT standby), OP-005/IP-005 (ambulance charges via NC-013), PE-001/OP-020 (patient-requested ambulance & tracking), NC-030 (crew roster), NC-020 (ambulance equipment), EN-024 |
| Feature flag    | `module.prehospital.enabled` (sub: `prehospital.emergency_108_link`, `prehospital.gps_live`, `prehospital.vitals_relay`, `prehospital.public_tracking`, `prehospital.interfacility`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Primary roles   | Ambulance Dispatcher (52), EMT / Paramedic (52), Ambulance Driver (52), Nurse — ER/Triage (19), Emergency physician (8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Secondary roles | Trauma team leader (9), ER receptionist (24), Billing (27), Fleet manager (NC-013), Biomedical (48, ambulance devices), Call centre (25), Patient/relative (59/60, booking & tracking), Referring hospital (external), 108/112 control room (external), Quality (54, response times), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Regulatory      | MoRTH ambulance standards (AIS-125 Part 1: Type A/B/C/D — BLS/ALS), MoHFW National Ambulance Service (108) & ERSS-112 integration norms, NPPMTBI pre-hospital care, MV Act §134/§162 golden-hour cashless treatment & Good Samaritan Guidelines (2016 & MV (Amendment) Act 2019 §134A), Clinical Establishments Act (transfer standards), NABH 5th ed. AAC.7/COP (transfer of patients, ambulance standards, hand-over), Telecom/TRAI DLT (SMS), IT/DPDP (GPS/location data as PHI when linked), state EMS protocols (e.g. GVK EMRI/Ziqitza) & their PCR formats, ISO 3166/GS1 vehicle IDs optional, Fire/AERB n/a, BMW 2016 (ambulance waste), NDPS (ambulance controlled drugs)                                                                                                                                                                                                                                                                                                                                |

## 1. Purpose

TR-009 connects the road to the resuscitation bay: it receives or creates emergency trips (108/112/state EMS feed, hospital ambulances via NC-013, private/referring ambulances), tracks **GPS location and ETA** live, lets the EMT capture a **pre-hospital patient care record** (mechanism, START tag, vitals series, GCS, interventions, drugs, times) on a phone that works offline, **relays vitals and images** to the ER, raises a structured **ER pre-alert** (pathway: trauma/STEMI/stroke/paeds/obstetric/burns/MCI) that pre-assigns a bay, pages teams (TR-001 activation criteria on field data), and completes a **digital handover** (IMIST-AMBO/ATMIST) with wristband scan and time stamps that seed OP-006/TR-001 KPI clocks. Inter-facility transfers (in/out) get the same tooling with IP-018 documents. NC-013 keeps fleet, dispatch logistics and billing; TR-009 owns the clinical journey.

## 2. Users & Jobs-to-be-done

- **EMT/paramedic** (rugged phone/tablet in ambulance, gloves, moving vehicle, patchy network): one-hand PCR: scene time stamps, START tag, vitals (manual or from portable monitor via Bluetooth/EN-042), GCS, interventions (airway, IV, splint, tourniquet, CPR, drugs), photos of scene/injury (optional, MLC-aware), select destination hospital, send pre-alert in ≤ 20 s, talk to ER (call button), hand over with scan.
- **Driver** (phone): trip navigation, status buttons (en route/at scene/departed/arrived), GPS auto, incident/breakdown.
- **Dispatcher** (desktop, NC-013 console with TR-009 clinical panel): see requests from 108/112 & internal, assign nearest suitable ambulance (ALS/BLS, equipment), monitor live map, ETAs, crew, communicate; escalate to ER for pre-alert; manage MCI staging.
- **ER triage nurse / EM physician** (ER wall board + tablet): inbound list with ETA countdown, pre-alert details, vitals trend, decide bay/team, acknowledge, pre-register (OP-006 pre-arrival), receive handover, verify times.
- **Trauma team**: activation from pre-alert (TR-001) — pre-arrive at bay.
- **Referring hospital** (external portal/e-mail/phone) & **receiving hospital** for transfer-out: exchange transfer packet (IP-018), ETA, acceptance.
- **Patient/relative** (app/web): request hospital ambulance, track ETA (`prehospital.public_tracking`), see arrival status; billing (NC-013).
- **Quality/fleet**: response-time SLA (call→dispatch→scene→hospital), pre-alert lead time, handover completeness, device usage.

## 3. Core Workflows

### 3.1 Trip intake (108/112, internal, private)

1. **Sources**: (a) **108/112/state EMS API** (`prehospital.emergency_108_link` via EN-017 connector; formats vary by state operator — JSON/REST or HL7/FHIR or e-mail/SMS parsing fallback): incoming "patient being brought" message with case id, location, chief complaint, ETA, crew phone → **System** creates `prehospital_trips` (external) + OP-006 pre-arrival; (b) **hospital ambulance dispatch** (NC-013 trip → TR-009 clinical trip auto-linked); (c) **patient/relative request** (portal/app/call centre → NC-013 dispatch); (d) **referring hospital transfer-in** (portal form/e-mail: patient summary, vitals, ventilated?, drips, ETA) → pre-arrival with IP-018 packet; (e) **walk-in ambulance without notice** → ER nurse creates trip on arrival (retro).
2. Dispatcher/EMT assignment (NC-013) → crew app receives trip; **status timeline** auto/GPS-driven: call received, dispatched, en route, at scene, patient contact, departed scene, arrived hospital, handover complete, available — each with timestamp (device + server) → response-time KPIs (NC-013 SLA) & TR-001 KPI seeds.

### 3.2 GPS tracking & ETA (`prehospital.gps_live`)

- Crew phone (background geolocation via PWA when foreground; native app Phase 13) and/or vehicle GPS device (NC-013 telematics: NMEA/GPRS to server via EN-017/postgis) send positions every 5–10 s → **ETA** computed (routing provider or straight-line fallback with average speed) → live map for dispatcher/ER, ETA countdown on ER board; geofence at hospital → auto "arrived"; route history stored (postgis) for audit; speed alerts to fleet.

### 3.3 Pre-hospital patient care record (PCR) & vitals relay (`prehospital.vitals_relay`)

1. **EMT** opens PCR on trip: patient (name/unknown, sex, approx age, tag ID from MCI or wristband pre-printed in ambulance kit), **mechanism/complaint** (structured like TR-001: RTA/fall/assault/burn/medical), scene safety, MLC suspicion, bystander/police details, **START/JumpSTART** (if MCI) → **primary survey** quick buttons (airway/breathing/circulation/disability), **vitals series** (time-stamped: HR, BP, RR, SpO2, temp, GRBS, GCS E/V/M, pupils, pain) manual or from portable monitor (Bluetooth LE / EN-042 gateway; e.g. Zoll, Philips Tempus, Schiller, BPL) with 1-min auto capture, 12-lead ECG image/PDF (STEMI), **interventions** with times (airway adjunct/ETT/i-gel, O2, CPR start/stop & shocks (AED data), IV/IO, fluids mL, tourniquet on-time, pelvic binder, splints, c-collar, dressings, needle decompression), **drugs** given (name/dose/route/time — from ambulance formulary incl. controlled drugs register), allergies/meds known, photos (scene/injury — hash-tagged; MLC-aware) → **relay**: PCR deltas sync to ER in near real time (offline queue when no network; sends when back) → ER sees trend before arrival → Event `ambulance.vitals.relayed`.
2. **Destination selection**: EMT/dispatcher picks hospital (self or another in group EN-041); capability check (trauma level, CT, cath lab, NICU, burns bed availability from IP-001 read model) → **pre-alert** (§3.4).
3. **Consent/refusal**: patient refusal of transport/treatment (signature/photo, witness), Good Samaritan bystander details (not compelled), police at scene.

### 3.4 ER pre-alert & team activation

1. **EMT/dispatcher** taps _Pre-alert_ → structured **ATMIST/IMIST-AMBO** message (Age/sex, Time of incident, Mechanism, Injuries suspected, Signs (latest vitals), Treatment given, ETA, special: ventilated, unstable, MCI, paediatric, obstetric, burns %, STEMI/stroke suspicion, MLC, infectious) → **System** creates/updates OP-006 pre-arrival with pathway suggestion, **evaluates TR-001 activation criteria** on field data (SBP, GCS, mechanism) → proposes Level 1/2 activation → ER physician confirms (or auto-activate policy) → pages team (EN-037), pre-assigns bay (OP-006), notifies CT (OP-008 standby), blood bank (IP-007: MTP standby if haemorrhagic shock), OT (TR-004 hold if Class 1 likely), ICU bed check → ER board card shows ETA countdown + vitals sparkline → **ER acknowledges** pre-alert (nurse tap; time stamp) → Event `ambulance.prealert.raised|acknowledged`.
2. Voice: one-tap call to ER hotline (click-to-call; IVR bridge EN-033) & optional push-to-talk later; ETA updates auto; diversion (hospital full / capability) → dispatcher re-routes with reason; hospital-side "divert status" (ER saturation flag from OP-006) visible to dispatchers/108.

### 3.5 Arrival & digital handover

1. Geofence/driver tap "arrived" → ER board flashes; **handover**: EMT and ER nurse/doctor at bay: EMT presents ATMIST verbally; **System** links pre-arrival → ER visit (OP-006 quick reg or MCI tag) by scanning wristband/tag or selecting the pre-arrival card; PCR imported into ER record (vitals into OP-007 series flagged `prehospital`, interventions into TR-001 (tourniquet time!), drugs into MAR history, ECG to OP-008/OP-029, photos to evidence (TR-008 if MLC)) → **handover checklist** (identity, belongings, lines/tubes, drugs given, allergies, NOK, police/MLC, equipment exchanged e.g. hospital collar swap) → both sign (PIN/e-sign) → time stamps: arrival, handover start/end (**ambulance offload time** KPI) → Event `ambulance.handover.completed`; TR-001 door time set from arrival stamp.
2. Crew **available** status → NC-013; equipment/consumables used → NC-013 restock list; controlled drugs reconciliation.
3. Exceptions: patient died en route/on arrival → brought-dead flow (OP-006/TR-008); patient refuses hospital → refusal record; wrong hospital/diversion after arrival → transfer-out; MCI → bulk arrivals by tag with abbreviated handover.

### 3.6 Inter-facility transfer (`prehospital.interfacility`)

- **Transfer-out** (from IP-018 request): TR-009 books ambulance (NC-013: ALS/BLS/neonatal/ventilator), crew & escort (doctor/nurse per acuity), pre-departure checklist (stability, consent, documents packet, drugs/O2 calculation for trip, equipment), receiving hospital pre-alert (e-mail/FHIR/portal via EN-019/EN-017 with acceptance name/time), en-route monitoring PCR (vitals relay to sending & receiving), arrival & handover receipt → IP-018 closes; **Transfer-in**: referral packet intake, acceptance decision (bed/capability), pre-arrival with ETA, arrival handover as §3.5 with referral docs attached.

### 3.7 MCI & field operations

- On MCI (OP-006/TR-001), TR-009 shows staging area, ambulance cycles (scene↔hospital), field START tags feed TR-001; dispatch coordination with 108 control room; hospital capacity broadcast (beds/OT/ICU) to EMS; sequence casualties by category; crew safety.
- Multi-casualty transport: one trip carries several tagged casualties (`ph_trip_casualties` child rows) each with own mini-PCR (tag, START, vitals); pre-alert lists all; handover per tag; hospital-side distribution to zones (OP-006 MCI board).

### 3.8 Ambulance clinical readiness & crew (with NC-013)

- Pre-trip **clinical equipment/drug checklist** (defibrillator, suction, O2 level, monitor battery, airway kit, splints, drugs incl. controlled — expiry & counts) captured on crew app at shift start and after each trip; failures block "available" status until resolved or supervisor override; monitor/AED self-test logs (EN-042); consumables used per trip → restock list (NC-013); controlled-drug register (issue/use/return with 2 signatures) per NDPS; crew certifications (BLS/ACLS/PHTLS validity from NC-027) shown at dispatch — expired → warning.

### 3.9 Exceptions & edge cases

1. **Duplicate EMS messages / late updates**: idempotent by operator + external id; updates append; ETA changes throttle notifications.
2. **Destination change en route** (patient/family insists on other hospital): dispatcher/EMT records reason; pre-alert cancelled at previous ER (with notice), raised at new one if in group; billing per NC-013 rules.
3. **Patient refuses transport at scene**: refusal record with signature/photo & witness; trip closed as `refused`; PCR retained; 108 informed.
4. **Death en route**: CPR log, time of death (declared on arrival by ER doctor unless protocol allows), brought-dead flow at ER (OP-006/TR-008); crew debrief task.
5. **Crew phone dead / no device**: dispatcher logs status by phone; PCR paper form later scanned to OP-022 & minimal structured entry by ER nurse (`paper_pcr=true`).
6. **Wrong patient linked at handover**: unlink within 30 min by ER in-charge with reason (audit); imported vitals/drugs reversed via versioned events (no silent deletes).
7. **Transfer-in without prior notice**: retro pre-arrival; referral packet requested; ER treats as walk-in ambulance.
8. **GPS spoofing/inaccurate points** (accuracy > 200 m): discarded for ETA, kept flagged; ETA falls back to last good position or manual.
9. **Cross-border/other-state ambulance formats**: PCR import via photo/PDF; structured minimal fields captured.

## 4. Data Model (schema `trauma`, prefix `ph_`; fleet tables in NC-013)

- **ph_trips**: id, hospital_id, branch_id, fleet_trip_id? (NC-013), source enum(ems_108/ems_112/state_ems/hospital_dispatch/patient_request/referral_in/private_walkin/transfer_out), external_case_id?, external_operator?, requested_at, dispatched_at, en_route_at, at_scene_at, patient_contact_at, departed_scene_at, arrived_hospital_at, handover_started_at, handover_completed_at, available_at, status enum(requested/dispatched/en_route/at_scene/transporting/arrived/handed_over/completed/cancelled/diverted), vehicle_id?, vehicle_type enum(bls/als/neonatal/ventilator/patient_transport/private/other), crew jsonb (emt, driver, doctor, nurse), origin jsonb (lat/lng, address, scene_type), destination_branch_id, destination_external?, diversion_reason?, prearrival_id? (OP-006), er_visit_id?, mci_incident_id?, mci_tag_no?, transfer_request_id? (IP-018), cancel_reason, notes.
- **ph_positions** (postgis, partitioned monthly, retention 1 y): trip_id, vehicle_id, at, geom point, speed_kmh, heading, source enum(phone/telematics), accuracy_m.
- **ph_eta_snapshots**: trip_id, at, eta_at, distance_km, method enum(routing/straight_line/manual).
- **ph_pcr**: id, trip_id, patient_temp jsonb (name/unknown, sex, age_band, id marks), mechanism jsonb (as TR-001), complaint, scene jsonb (safety, bystanders, police, mlc_suspected), start_category?, start_algorithm?, primary_survey jsonb, allergies, meds, history, refusal jsonb?, destination_reason, consent jsonb, offline_captured bool, device_id, created_by, signed_by_emt_at, version.
- **ph_vitals**: pcr_id, at, hr, sbp, dbp, rr, spo2, temp, grbs, gcs_e, gcs_v, gcs_m, pupils jsonb, pain, source enum(manual/monitor), device_id?, seq. Index (pcr_id, at).
- **ph_interventions**: pcr_id, at, type enum(airway_adjunct/supraglottic/ett/o2/bvm/cpr_start/cpr_stop/defib_shock/iv/io/fluids/tourniquet_on/tourniquet_off/pelvic_binder/splint/c_collar/dressing/needle_decompression/nebulisation/glucose/other), details jsonb (size, site, volume_ml, joules), performed_by.
- **ph_drugs**: pcr_id, at, drug_id (ambulance formulary), dose, unit, route, given_by, is_controlled bool, register_ref? (NC-013 controlled drug log).
- **ph_media**: pcr_id, type enum(photo/ecg/video/document), file_id, sha256, captured_at, mlc_relevant bool, evidence_id? (TR-008 after handover).
- **ph_prealerts**: id, trip_id, raised_at, raised_by, atmist jsonb, pathway enum(trauma/stemi/stroke/sepsis/paeds/obstetric/burns/mci/medical/other), suggested_activation enum(none/level_2/level_1), confirmed_activation?, confirmed_by?, bay_id?, acknowledged_by?, acknowledged_at, eta_at, updates jsonb[], diverted bool.
- **ph_handovers**: trip_id, er_visit_id, started_at, completed_at, checklist jsonb, emt_sign, receiver_sign, offload_minutes, discrepancies text, equipment_exchanged jsonb, controlled_drug_reconciled bool.
- **ph_transfers**: trip_id, direction enum(in/out), transfer_request_id (IP-018), packet_doc_ids uuid[], receiving_facility jsonb, acceptance jsonb (by, at, bed), escort jsonb, pre_departure_checklist jsonb, o2_calc jsonb, arrival_receipt_file_id.
- **ph_trip_casualties** (MCI multi-casualty trips): trip_id, mci_tag_no, start_category, mini_pcr jsonb, er_visit_id?, handed_over_at.
- **ph_readiness_checks**: vehicle_id, at, by, checklist jsonb ({item, ok, qty, expiry}), failures text[], override_by?, status enum(pass/fail/overridden); **ph_controlled_drug_log**: vehicle_id, drug_id, at, action enum(issue/use/return/waste), qty, trip_id?, by, witness_id.
- **ph_ems_messages** (integration log): operator, direction, external_case_id, payload jsonb, received_at, parsed_ok, trip_id?, error.
- **ph_capability_broadcast** (read model): branch_id, at, er_divert bool, beds jsonb (icu, ward, burns, nicu), ot_free, ct_status.
- Indexes: ph_trips (hospital_id, status, requested_at desc), (destination_branch_id, status), (external_case_id); ph_prealerts (trip_id), (acknowledged_at); ph_vitals (pcr_id, at). RLS; PCR versioned; retention ≥ 10 y (permanent if MLC); positions 1 y.

## 5. Business Rules & Validations

- Every emergency trip with a patient must have a PCR with ≥ 1 vitals set (or "unable" reason) and scene/departure/arrival times before completion; times can be corrected within 24 h with reason (audit).
- Pre-alert mandatory for pathway cases (trauma activation criteria, STEMI, stroke, unstable, ventilated, paeds critical, obstetric emergency, burns > 10 %); ER acknowledgment required within 2 min → escalate to ER in-charge phone/IVR; ETA updates auto-refresh; pre-alert data cannot be edited after handover (append updates).
- TR-001 activation criteria evaluated on field values (SBP < 90, GCS ≤ 8, penetrating torso, etc.); auto vs confirm policy configurable; false-alert rate tracked (over-triage from field).
- Handover: cannot complete without identity link (ER visit or MCI tag), both signatures, and controlled drug reconciliation if any given; **offload time** > 15 min flagged (ER boarding).
- Field tourniquet time flows to TR-001 timer (alarm continues in ER); field drugs appear in MAR history as "pre-hospital" (no double dosing warnings via EN-029).
- MLC suspicion from scene → TR-008 case suggested at ER; scene photos become evidence only after ER doctor confirms MLC (hash preserved from capture).
- Diversion only by dispatcher/ER in-charge with reason; hospital divert status auto-set by OP-006 saturation rules and requires manual clear.
- Transfer-out cannot depart without receiving acceptance recorded, escort per acuity policy, O2 sufficiency (calc: cylinder litres / flow ≥ 1.5 × trip time), documents packet; transfer-in acceptance requires bed availability check.
- Patient/relative tracking link shows ETA & vehicle only (no crew personal phone); expires at arrival.
- Data minimisation: 108/112 payloads stored raw in integration log (retention 90 d), parsed into trip; unknown patients as temp; GPS positions treated as PHI once linked to patient.
- Billing: trip charges via NC-013 (distance/flat/ALS surcharge) — clinical module never posts charges directly except flags (ALS interventions) that NC-013 prices.
- Numbering: `PH_TRIP` (or NC-013 `AMB_TRIP`), `PCR` per trip.

## 6. API Surface (`/api/v1/prehospital`)

| Method     | Path                                                                                  | Purpose                                            | Permission                                 | Idem            | Pag    |
| ---------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------ | --------------- | ------ |
| POST       | /ems/inbound (webhook)                                                                | 108/112/state EMS message                          | integration.ems.ingest                     | Y (external id) | –      |
| POST       | /trips                                                                                | create clinical trip (from NC-013/manual/referral) | prehospital.trip.create                    | Y               | –      |
| GET        | /trips?status=&branch=&from=                                                          | list                                               | prehospital.trip.list                      | –               | cursor |
| GET        | /trips/{id}                                                                           | trip + PCR + prealert + handover                   | prehospital.trip.read                      | –               | –      |
| POST       | /trips/{id}/status                                                                    | status transition (with timestamp)                 | prehospital.trip.update (crew)             | Y               | –      |
| POST       | /trips/{id}/positions (batch)                                                         | GPS points                                         | prehospital.gps.write                      | Y               | –      |
| GET        | /trips/{id}/eta, /live-map?branch=                                                    | ETA/live map                                       | prehospital.trip.read                      | –               | –      |
| POST/PATCH | /trips/{id}/pcr                                                                       | PCR create/update (offline-merge)                  | prehospital.pcr.write                      | Y               | –      |
| POST       | /trips/{id}/pcr/vitals (batch), /interventions, /drugs, /media                        | PCR entries                                        | prehospital.pcr.write                      | Y               | –      |
| POST       | /trips/{id}/prealert, PATCH /prealerts/{id}                                           | raise/update pre-alert                             | prehospital.prealert.raise                 | Y               | –      |
| POST       | /prealerts/{id}/ack, /activate, /divert                                               | ER responses                                       | prehospital.prealert.respond               | Y               | –      |
| POST       | /trips/{id}/handover/start, /complete                                                 | handover                                           | prehospital.handover.write                 | Y               | –      |
| POST       | /trips/{id}/link-visit                                                                | link ER visit/tag                                  | prehospital.handover.write                 | Y               | –      |
| POST       | /transfers, PATCH /transfers/{id}                                                     | inter-facility (with IP-018)                       | prehospital.transfer.manage                | Y               | –      |
| GET        | /capability?branch=                                                                   | capacity/divert broadcast                          | prehospital.trip.read / public token (EMS) | –               | –      |
| GET        | /public/track/{token}                                                                 | patient tracking (ETA only)                        | – (token)                                  | –               | –      |
| GET        | /reports/kpi?from=&to=                                                                | response, pre-alert lead, offload times            | prehospital.report.read                    | –               | –      |
| GET/PUT    | /config/ems-connectors, /config/prealert-rules, /config/formulary, /config/checklists | config                                             | prehospital.configure                      | Y               | –      |

## 7. Domain Events (outbox)

- `ambulance.trip.created|status_changed` {trip_id, status, at} → NC-013, OP-006 pre-arrival, EN-018 inbound board.
- `ambulance.position.updated` (throttled 10 s; Redis pub/sub not outbox) → live maps; `ambulance.eta.updated` → ER board.
- `ambulance.vitals.relayed` {trip_id, latest_vitals} → OP-006 card, TR-001 (criteria), TR-007.
- `ambulance.prealert.raised|updated|acknowledged|diverted` {atmist, pathway, suggested_activation} → OP-006 (bay pre-assign), TR-001 (activation proposal), OP-008 (CT standby), IP-007 (MTP standby), TR-004 (OT hold), EN-037 pages, EN-018.
- `ambulance.arrived` {trip_id, at} → OP-006 door time (on link), board flash.
- `ambulance.handover.completed` {trip_id, er_visit_id, offload_minutes, pcr_summary} → OP-006/TR-001 (import), OP-007 (vitals), IP-003 MAR history, TR-008 (media if MLC), NC-013 (available/restock), OP-005/IP-005 via NC-013 billing.
- `ambulance.transfer.departed|arrived` → IP-018.
- `ambulance.capability.broadcast` → EMS partners (EN-017), TR-009 dispatchers.
- Consumes: `fleet.trip.dispatched|assigned|completed` (NC-013), `er.mci.declared|stand_down` (OP-006), `er.divert.set|cleared` (OP-006), `transfer.requested|accepted` (IP-018), `bed.availability.updated` (IP-001), `trauma.team.activated` (TR-001 → crew informed).

## 8. Screens (UI)

- **Crew app (EMT)** — phone/rugged tablet PWA (native Phase 13): trip card with big status buttons, PCR tabs (Patient / Vitals / Interventions / Drugs / Media / Pre-alert), vitals quick-pad and monitor pairing (BLE), START wizard (MCI), pre-alert composer (ATMIST auto-filled, one tap send), call ER, handover checklist & signatures, controlled-drug reconciliation; **offline-first** (all forms; queue with sync indicator; conflict-free append logs), night mode, glove-friendly 56 px targets, voice notes; battery/GPS status.
- **Driver app** — phone: navigation deep link, status buttons, geofence auto-arrive, breakdown/incident.
- **Dispatcher console** — desktop (NC-013 + TR-009 panel): request list (108/internal/transfer), live map with ETAs, ambulance capability filter, assign, pre-alert status, ER divert flags, MCI staging; `A` assign, `P` pre-alert, `D` divert.
- **ER inbound board** — ER wall/TV (EN-018) + tablet: inbound cards with ETA countdown, pathway colour, latest vitals sparkline, suggested activation, ack button, bay assignment; sound on new pre-alert; `Enter` ack, `B` bay, `T` activate trauma; real-time.
- **Handover screen** — ER tablet: pre-arrival ↔ visit link (scan), imported PCR summary, checklist, dual sign, offload timer.
- **Transfer console** — desktop/tablet: checklist, O2 calculator, packet, receiving acceptance, en-route monitoring.
- **Patient tracking page** — phone (token): map/ETA/vehicle no; **Referral portal page** for external hospitals: submit transfer-in with vitals & docs (PE-007/portal).
- **KPI dashboard** — desktop: response times, pre-alert lead time & accuracy, offload times, activation from field precision, transfer compliance.
- Print: PCR PDF (with vitals table & interventions), handover sheet, transfer packet cover, refusal form.

## 9. Integrations

- 108/112/state EMS operators (GVK EMRI, Ziqitza, state ERSS-112 dashboards): connectors in EN-017 (REST/JSON, HL7 v2 ADT-A04/ORU, FHIR R4 Encounter/Observation Bundles via EN-019, e-mail/SMS parsers as last resort) with retries/DLQ, mapping per operator; hospital capability broadcast API/feeds.
- Telematics/GPS (NC-013 vendor devices; NMEA over GPRS/MQTT) → EN-017 → postgis; routing/ETA provider (Google/Mapbox/OSRM self-hosted on-prem) with fallback; phone geolocation.
- Portable monitors/defibrillators (Zoll X-series, Philips Tempus/HeartStart, Schiller, Mindray BeneHeart) via BLE/Wi-Fi/EN-042 gateway; ECG PDF/XML.
- EN-037/EN-009/EN-033 alerts (push, SMS, IVR bridge/click-to-call), EN-018 boards, OP-006/TR-001/TR-004/TR-007/TR-008, IP-018/IP-001/IP-007/OP-008, NC-013 billing/fleet, PE-001/OP-020 booking & tracking, EN-041 multi-branch destination selection.
- Fallbacks: EMS API down → manual trip entry from phone call; GPS lost → manual ETA; monitor unpaired → manual vitals; no network in ambulance → SMS pre-alert (structured keyword) to ER number parsed by EN-009 inbound; ER board down → phone hotline log.

## 10. Reports & Analytics

- Response-time chain (call→dispatch→scene→depart→hospital) vs SLA by vehicle/crew/zone (with NC-013); pre-alert coverage (% eligible trips with pre-alert), lead time (pre-alert → arrival), ack time, activation precision (field-suggested vs final ISS), offload time distribution, handover completeness, transfer-out compliance (acceptance/escort/O2), en-route deteriorations, drugs/interventions per trip, EMS-source mix (108/112/private), MCI cycles, GPS coverage gaps, patient tracking usage, complaints.
- Read models: `analytics.mv_prehospital_trips`, `analytics.mv_prealert_kpi`, `analytics.mv_offload_times`, `analytics.mv_transfer_compliance`.

## 11. Notifications

- ER: new/updated pre-alert (sound + push), ETA < 5 min, arrival, unacknowledged pre-alert escalation (in-charge phone/IVR); Trauma team: activation pages (TR-001); CT/blood bank/OT/ICU: standby notices per pathway; Dispatcher: trip status, ER divert, crew SOS; Crew: assignment, destination change, ER instructions (text), traffic; Patient/relative: booking confirmation, tracking link, arrival; Referring/receiving hospital: acceptance/ETA/arrival (e-mail/SMS/portal); Fleet/biomedical: monitor faults, GPS offline; Quality: SLA breaches.

## 12. Permissions (RBAC keys)

`prehospital.trip.create|list|read|update`, `prehospital.gps.write`, `prehospital.pcr.write|read`, `prehospital.prealert.raise|respond`, `prehospital.handover.write`, `prehospital.transfer.manage`, `prehospital.report.read|export`, `prehospital.configure`, `integration.ems.ingest` (system).
Defaults: EMT/paramedic (52): trip.read/update (own trips), pcr.write, prealert.raise, gps.write, handover.write (EMT side); Driver (52): trip.update (status), gps.write; Dispatcher (52): trip.*, prealert.raise, transfer.manage, report; ER nurse (19)/EM physician (8): trip.read, prealert.respond, handover.write, pcr.read; Trauma team: trip.read; Call centre (25)/receptionist (24): trip.create (requests); Billing (27): trip.read; Fleet manager: report; Quality: report.export; Referring hospital user (portal): transfer submit; Patient: tracking token; Admin: configure; Auditor: read.

## 13. Non-functional

- Volumes: 150–300 ambulance arrivals/day (of which ~40 % pre-alerted), 30–60 hospital ambulances (NC-013), GPS 5–10 s intervals ≈ 500k points/day; PCR sync payloads small (< 50 KB) with media separately.
- p95: pre-alert raise → ER board < 3 s; ETA recompute < 1 s; PCR sync < 500 ms per batch; live map load < 300 ms; EMS webhook ack < 200 ms.
- Offline: crew app fully offline for PCR/vitals/interventions/prealert-draft (queue); prealert requires any channel (data or SMS fallback); positions buffered; conflict handling append-only.
- Devices: rugged Android phones/tablets, vehicle mounts, BLE monitors, GPS units; low-bandwidth mode (no images).
- Availability: EMS ingestion endpoint highly available (edge/on-prem replica), DLQ for parse errors; ER board resilient (local cache).
- Accessibility/i18n: crew UI in local language + English; large controls; dark mode; TTS for pre-alert read-out in ER (optional).
- Security: crew device tokens; patient tracking token short-lived; positions PHI-linked; no PHI in SMS pre-alert beyond ATMIST essentials without name (configurable); audit handover signatures.

- Seed data: ATMIST/IMIST-AMBO templates, pathway list, pre-alert mandatory rules, ambulance formulary (BLS/ALS incl. controlled list), readiness checklist items per vehicle type (AIS-125), geofence radius, ETA method config, DLT SMS templates (tracking link, pre-alert keyword fallback), sample EMS connector mappings (generic JSON, HL7 ORU, e-mail parser).
- Test fixtures: simulated 108 feed (20 trips/h), GPS replay files (with poor-accuracy points), offline crew scenario scripts, MCI multi-casualty trip, transfer-out with O2 calc; k6 smoke on `/ems/inbound` (200 rps burst) and `/live-map`.
- Observability: EMS ingest success/failure rates, DLQ depth, pre-alert→board latency, ack times, GPS point lag, crew app sync backlog; alerts on DLQ growth or board latency > 3 s.
- Feature-flag defaults: `prehospital.gps_live=true`, `prehospital.vitals_relay=true` (manual vitals until monitors integrated), `prehospital.public_tracking=false` until policy, `prehospital.emergency_108_link=false` until operator connector configured.

## 14. Acceptance Criteria

1. Given a 108 inbound message (case id X, RTA, ETA 12 min), then a trip and OP-006 pre-arrival card appear on the ER inbound board within 3 s with ETA countdown; a duplicate message with the same case id updates rather than duplicates.
2. Given crew app offline in a tunnel, when EMT records 3 vitals sets and a tourniquet at 10:12, then entries queue locally and sync in order on reconnect; ER trend shows all sets with original timestamps.
3. Given field vitals SBP 84, GCS 7 in the pre-alert, then TR-001 activation Level 1 is suggested on the ER board; physician confirm pages the team, pre-assigns Resus bay, and CT/blood bank standby notices are sent.
4. Given a pre-alert not acknowledged in 2 min, then ER in-charge receives push + IVR call and the escalation is logged; ack records nurse and time.
5. Given the ambulance enters the hospital geofence, then status auto-sets arrived with timestamp; on wristband scan at handover, pre-arrival links to the ER visit and TR-001 door time equals arrival timestamp.
6. Given handover completed at 12 min after arrival, then offload_minutes = 12; if > 15 min, an ER boarding flag is raised; completion is blocked without both signatures and controlled-drug reconciliation (morphine given).
7. Given PCR interventions include tourniquet on at 09:50, then TR-001 shows tourniquet timer running from 09:50 with alarms at 90/120 min.
8. Given field drugs (fentanyl 50 µg 10:05) imported, then IP-003 MAR history lists them as pre-hospital and EN-029 warns on repeat dose within interval.
9. Given transfer-out with 90-min trip on 6 L/min O2 and a cylinder with 680 L, then O2 calculator shows insufficient (needs ≥ 810 L incl. 1.5× margin) and departure is blocked until a second cylinder is recorded.
10. Given receiving hospital acceptance not recorded, then transfer cannot be marked departed; on acceptance via portal, packet is sent and ETA shared.
11. Given a patient tracking link, then it shows ETA and vehicle number only, and expires on arrival.
12. Given ER divert set by OP-006 saturation rule, then dispatcher console and capability broadcast show divert; a pre-alert to that branch prompts alternative destination.
13. Given a private ambulance walk-in without notice, then ER nurse creates a retro trip in < 30 s from the arrival card and KPI counts it as non-pre-alerted.
14. Given MCI declared, then crew app switches to START tag mode; casualties tagged in the field appear in TR-001/OP-006 MCI counters as "inbound" with ETA.
15. Given the KPI report, then pre-alert lead time median equals recomputation from `ph_prealerts.raised_at` vs `ph_trips.arrived_hospital_at` on test data.
16. Given an EMS webhook payload that fails parsing, then it is stored in `ph_ems_messages` with error, dead-lettered, and IT/dispatcher alerted; manual trip creation from it is possible.
17. Given a shift-start readiness check with defibrillator self-test failed, then the vehicle cannot be set available until resolved or a supervisor override is recorded with reason.
18. Given an ER nurse links the wrong pre-arrival to a visit, then unlinking within 30 min by the ER in-charge reverses imported vitals/drugs via versioned events and the audit shows both actions.
19. Given a multi-casualty trip with 3 tagged patients, then the pre-alert lists all three with START categories, and handover is completed per tag with separate ER visits created.
20. Given GPS points with accuracy 500 m, then they are excluded from ETA computation, kept flagged in `ph_positions`, and ETA uses the last accurate position.

## 15. Enhancements / Later phases

- From VIMS sheet row 43 (ambulance enhancements): equipment checklist per trip (NC-013 Phase 9 with TR-009 clinical kit check), patient monitoring during transport (here), inter-hospital transfer coordination (here/IP-018), insurance/permit management (NC-013), 108/112 emergency integration (here — connectors per state operator, Phase 6/11).
- (market) MocDoc/SMART HMIS list ambulance management as fleet only; TR-009 adds later: native crew app with background GPS & BLE (Phase 13), tele-consultation from ambulance (OP-018 video/ECG streaming), AI ETA & demand prediction (AI-005), drone/first-responder integration, community first-responder app, automatic crash notification (vehicle eCall) intake, regional trauma system dashboards (EN-019 FHIR), push-to-talk radio bridge, hospital capacity marketplace among group branches (EN-041).

## 16. Open Questions for the Hospital

1. Which EMS operators serve the catchment (108/112/state) and what integration is available (API/e-mail/phone)? Any MoU for data exchange?
2. Hospital ambulance fleet size/types (NC-013), telematics vendor, crew devices (phones/tablets), monitors with connectivity?
3. Pre-alert policy: which pathways mandatory; auto vs confirmed trauma activation from field data; ER hotline number/IVR.
4. Handover standard (ATMIST/IMIST-AMBO), signature method (PIN vs e-sign), offload-time target.
5. Transfer policy: escort by acuity, O2 margin rule, acceptance documentation; referral network hospitals and portal use.
6. Patient/relative ambulance booking channels (app/call centre) and public tracking acceptable?
7. Divert criteria and who can set/clear; capability broadcast to EMS allowed?
8. Controlled drugs carried in ambulances and reconciliation process (NDPS register in NC-013).
9. GPS data retention (1 y default) and privacy notice for crews; map provider (cloud vs self-hosted OSRM on-prem).
10. MCI field operations plan with EMS and police; staging areas.
11. Multi-casualty transport practice (how many per ambulance in MCI) and tag stock in vehicles.
12. Shift-start readiness checklist contents and supervisor override policy; controlled-drug carriage list.
13. Crew certification tracking source (NC-027) and expiry policy at dispatch.
14. Public tracking and booking via app: default on or opt-in; language support for crews.
