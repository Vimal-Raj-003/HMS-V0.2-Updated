# OP-006 — Emergency & Trauma Intake / Day Care (Quick Reg, ESI Triage, ER Beds, MLC, On-call, Day Care)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Module ID       | OP-006                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Phase           | 6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Complexity      | Very High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Depends on      | OP-001 (MPI/UHID), OP-007 (vitals/devices), OP-002 (ER CPOE reuse), TR-001 (trauma scores/START), TR-008 (MLC & forensic), TR-009 (ambulance pre-alert), TR-007 (polytrauma board), IP-001 (admission/beds), IP-005 (IP/daycare billing), OP-005 (OP billing), OP-003 (ER pharmacy/crash cart stock), OP-004/OP-008 (STAT diagnostics), IP-007 (blood), IP-006/TR-004 (emergency OT), IP-013 (code blue/crash cart), IP-017 (mortuary), EN-006 (queue), EN-013 (wristbands), EN-018 (TV/ER board), EN-037 (on-call routing), NC-030 (roster), EN-029 (NEWS2/sepsis rules), EN-028 (consent), NC-015 (incidents), EN-011 (ABDM), EN-009                                                                                                                   |
| Feature flag    | `module.emergency.enabled` (sub: `er.daycare`, `er.observation_billing`, `er.mass_casualty`, `er.poison_centre`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Primary roles   | Nurse — ER/Triage (19), Doctor — Emergency Physician (8), ER Receptionist (24 with ER scope), ER Ward attendant (23)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Secondary roles | On-call specialists, Surgeon/Ortho (TR), Anaesthetist, Security (MLC/police liaison), Billing (ER cashier), Ambulance dispatcher (TR-009), Blood bank, Radiology/Lab STAT, MRD (MLC records), Medical Superintendent (mortality/MLC), Police (read-only intimation copy), Patient/attendant (status board), Auditor                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Regulatory      | NABH 5th ed. AAC.6/COP.3 (triage, emergency care, initial assessment ≤ defined time), ESI v4 (Emergency Severity Index 5-level), START/JumpSTART (mass casualty), CrPC §39/§174/§176 & BNSS 2023 equivalents (police intimation, inquest, MLC register), Supreme Court Pt. Parmanand Katara (no refusal of emergency care, no payment precondition), Clinical Establishments Act (stabilisation), MTP/POCSO reporting duties, Motor Vehicles Act §162 (golden hour cashless treatment scheme 2025), PMJAY/RC-007 (emergency packages), Consumer Protection (informed consent), IPC/BNS injury classification (simple/grievous, weapon type), NDPS (ER narcotics), BMW 2016, Day-care: IRDAI day-care procedure list (insurance), NABH day care standards |

## 1. Purpose

OP-006 delivers golden-hour operations for the emergency department of a trauma-oriented hospital: sub-30-second quick registration (including unknown/unconscious patients via temporary tag IDs), ESI 5-level triage with colour-coded severity queue, ER bed/bay board with one-click admission or discharge, medico-legal case initiation handed to TR-008, on-call doctor alerting with acknowledgement/ETA tracking, ER orders and observation billing, ambulance pre-alert intake, mass-casualty START mode, and a day-care unit workflow (booking → package → procedure → observation → same-day discharge → billing). It powers TV occupancy boards and ER statistics dashboards.

## 2. Users & Jobs-to-be-done

- **ER triage nurse** (tablet at triage desk, phone in bays): triage in ≤ 2 min with vitals from OP-007 devices, assign ESI, colour tag & wristband, place in bay, re-triage on deterioration (NEWS2 auto-alerts).
- **ER receptionist** (desktop, ER-scoped): quick reg (< 30 s), tag-ID for unknown, convert to full registration later, MLC flag, insurance/scheme (MV Act cashless, PMJAY) capture, ER billing hand-offs.
- **Emergency physician** (desktop/tablet): ER board by severity, assess (SOAP/ATLS primary–secondary survey template), CPOE STAT orders (reuse OP-002 with ER templates), procedures, disposition (admit/discharge/refer/LAMA/death/observation), call on-call specialists, MLC documentation start, death declaration.
- **On-call specialist** (phone push/SMS/call): acknowledge, ETA, arrive-mark; consult note.
- **ER attendant/transport**: bed moves, shift to CT/OT/ward with tracking.
- **Day-care nurse/coordinator** (desktop/tablet): bookings, checklists, procedure execution, observation vitals, discharge criteria (Aldrete/PADSS), summary.
- **Security**: MLC police intimation dispatch, unknown-patient photo/police liaison, body handover support (IP-017).
- **Billing/cashier**: ER charge posting, observation hours, deposit/credit; treatment never delayed for payment.

## 3. Core Workflows

### 3.1 Arrival & quick registration

1. Arrival modes: walk-in, ambulance (TR-009 pre-alert creates **pre-arrival record** with ETA, pre-hospital vitals, suspected diagnosis → bay pre-assigned, team pre-alert), police brought, referred (letter scan), mass casualty.
2. **Quick reg** (`F1`): Name (or "Unknown Male/Female ~age"), age/estimated age band, gender, mobile (attendant), chief complaint, mode of arrival, brought by (self/relative/police/ambulance no), MLC suspicion checkbox, referring hospital → **UHID** generated in < 30 s (or **temporary tag ID** `ER-TAG-<seq>` for unconscious/unknown with photo + wristband barcode; later **merge** into full UHID via OP-001 merge flow keeping ER records) → ER visit created (`er_visits`, series `ER_NO`) → wristband printed (EN-013: name/tag, UHID, age/sex, allergy band colour, MLC/fall risk indicator) → Event `er.patient.arrived`.
3. Full registration completed post-stabilisation by receptionist (`F5` complete demographics, ID, ABHA, insurance/scheme incl. MV Act golden-hour cashless, PMJAY emergency; consent capture from patient/attendant with relationship, or emergency implied-consent note by doctor).
4. Repeat visitor detection (mobile/name/photo match) → link to existing UHID; frequent ER visitor flag; previous ER summary auto-shown.

### 3.2 Triage (ESI 5-level) & queue

1. Nurse opens triage form (tablet): vitals (OP-007 devices auto-populate: BP, HR, RR, SpO2, temp, GRBS, pain NRS, GCS E/V/M, AVPU, weight for paeds), chief complaint category, ESI decision points: A (immediate life-saving? → ESI-1), B (high-risk / confused / severe pain → ESI-2), C (resource count: many → 3, one → 4, none → 5) with D vitals danger zone up-triage (HR/RR/SpO2 thresholds by age) → **ESI level auto-suggested**, nurse confirms/overrides with reason → colour tag: 1 Red, 2 Orange, 3 Yellow, 4 Green, 5 Blue (VIMS mapping) → wristband/tag print → target times: ESI-1 immediate physician, ESI-2 ≤ 10 min, ESI-3 ≤ 30 min, ESI-4 ≤ 60 min, ESI-5 ≤ 120 min (configurable NABH targets) → Event `er.triaged`.
2. **Auto-queue by severity** (not arrival): ER board sorted ESI asc then waiting time; timers turn amber/red at 80 %/100 % of target; **re-triage** anytime; NEWS2 (EN-029) computed from vitals → deterioration alert → auto up-triage suggestion.
3. Special flows: paediatric (JumpSTART/PEWS), obstetric (→ IP-011 labour room), stroke (FAST → code stroke pathway timers door-to-CT), STEMI (ECG ≤ 10 min, door-to-needle/balloon), sepsis (qSOFA/SIRS bundle timers), trauma (activation criteria → TR-001 team page, TR-007 board), poisoning (poison info centre contact log, antidote stock check OP-003), psychiatric/violent (security alert), infectious (isolation flag).
4. **Mass casualty mode** (`er.mass_casualty`): START/JumpSTART rapid tags (Immediate/Delayed/Minor/Expectant), batch tag registration by scanning pre-printed MCI tags, incident record, capacity dashboard, family info desk list, MCI report → TR-001 owns scoring; OP-006 owns intake/board.

### 3.3 ER bed / bay management

1. ER layout: zones (Resus, Acute, Minor/Fast-track, Observation, Paeds, Isolation, Decontamination) with bays/trolleys/wheelchairs; board shows occupancy (colour: free/occupied/cleaning/blocked), patient card (ESI colour, timers, pending orders, doctor, nurse), LOS in ER, boarding (awaiting IP bed).
2. Assign/move (drag/scan bay barcode) → `er.bay.assigned`; cleaning request to NC-018 on vacate; equipment (ventilator/monitor) tag per bay (NC-020).
3. **ER → IP one-click admission**: doctor selects disposition Admit → IP-001 admission request pre-filled (diagnosis, ward class, isolation, surgery flag, deposit estimate RC-008, insurance pre-auth trigger EN-002) → bed board pick → transfer order with handover checklist (SBAR, lines/tubes, MAR so far, pending results) → all ER data (vitals, orders, notes, MLC) linked to IP episode (`er.disposition.admitted`) — "seamless data transfer" — ER LOS clock stops; boarding time KPI.
4. Other dispositions: discharge (ER discharge summary + Rx + follow-up + advice; OP-005 bill), refer/transfer out (IP-018: receiving hospital, ambulance, documents, EMTALA-style stability note), LAMA/DAMA (consent form EN-028, risks explained, witness), absconded, death (declaration time, cause provisional, MLC check, IP-017 mortuary/body handover, death certificate initiation, brought-dead flow), observation (3.6).

### 3.4 ER clinical documentation & orders

- ER note templates (ATLS primary survey ABCDE, secondary survey, SOAP, paediatric, obstetric), procedure notes (suturing, reduction, intubation, central line, chest tube — with consent, time-outs, consumables auto-charge), fluid/drug orders (crash cart items via IP-013), STAT lab/imaging via OP-002 CPOE (STAT priority auto, portable X-ray/bedside USG flags), blood requisition (IP-007 emergency uncrossmatched O-neg protocol with 2-person check), nursing ER chart (hourly vitals, I/O, GCS trend, MAR), reassessment reminders per ESI. Trauma-specific scoring lives in TR-001 (RTS/ISS/TRISS auto-calc) surfaced on card.
- Time-critical KPIs auto-timestamped: door-to-triage, door-to-doctor, door-to-CT, door-to-antibiotic, door-to-disposition, decision-to-admit → bed.

### 3.5 MLC hand-off (TR-008)

1. MLC criteria checklist (RTA, assault, burns, poisoning, sexual assault (POCSO/§376 duties), fall from height, industrial accident, unknown/unconscious, brought dead, suicide attempt, dog bite? per state SOP, custody, firearm) → **MLC flag** on visit → **MLC number** (`MLC` series, gapless per branch) → banner shows "MLC" everywhere → TR-008 owns register, police intimation form (auto-generated, printed/e-mailed to jurisdiction PS with acknowledgement capture), injury body-map, wound photography with chain of custody, alcohol/DOA samples (OP-004 custody), age estimation, court reports. OP-006 responsibilities: raise flag/number, capture brought-by/police details (PS, constable name/badge, GD entry), preserve clothing/belongings list (with witness signatures), block discharge until MLC docs complete (unless MS override), death → inquest hand-off. Event `er.mlc.flagged` → TR-008.
2. Belongings/valuables register (item, count, sealed bag no, handed to police/relative, signatures).

### 3.6 On-call doctor alert & escalation

1. Doctor/nurse selects specialty (or auto by pathway e.g. trauma activation → ortho + surgery + anaesthesia + blood bank) → System looks up **on-call roster** (NC-030) for date/shift → sends push (app) + SMS + WhatsApp + optional IVR call (EN-033) with case summary (no PHI in SMS beyond initials/age/ESI) → **Acknowledge** button in app/SMS reply keyword → status `acknowledged` with **ETA**; arrival marked at bedside (scan) → response-time KPI.
2. Escalation ladder (EN-037): no ack in 5 min → resend + call; 10 min → backup on-call; 15 min → HOD; 20 min → MS/duty administrator; all logged. Specialist consult note recorded in ER visit; conversion to admission under specialist.
3. Code calls: Code Blue (IP-013), Code Stroke/STEMI/Trauma/Pink/Red — broadcast to groups with location; drill logs.

### 3.7 ER observation & billing

- Observation stay (< 24 h typical): observation start/stop times → charges by hour bands/slab (RC-003: e.g. first 4 h, 4–12 h, 12–24 h) posted to bill; conversion to admission after threshold prompts (config 12/24 h) → IP-005 takes over with ER charges migrated as pre-admission items; ER consult, procedures, consumables, drugs, investigations charged to ER bill (bill_type=er via OP-005), deposit optional; **treatment never gated on payment** — bills settle at disposition; MV Act golden-hour cashless / PMJAY / scheme flags route payer (RC-007); unknown patients billed to "unknown/charity" head until identity found; police cases per state free-treatment rules configurable.

### 3.8 Day-care unit

1. **Booking** (from OPD OP-002 order/procedure list or direct): procedure (IRDAI day-care list mapping for insurance: chemo (OP-031), dialysis (OP-012), minor surgeries, endoscopy, transfusion, IV therapy, cataract (OP-025), lithotripsy…), date/slot, package (OP-023/IP-008) or itemised, estimate (RC-008), pre-auth (EN-002) if insured, prep instructions SMS (fasting, stop anticoagulants), consent template.
2. **Day of procedure**: check-in → day-care bed/chair assign (board) → pre-procedure checklist (identity, consent signed, NPO, allergy, PAC if anaesthesia IP-024, site marking) → procedure execution note (procedure console OP-010 or OT IP-006 if theatre) with consumables/implants → **post-procedure observation** vitals schedule (q15 min × 4, q30 × 2, hourly) with NEWS2 alerts → **discharge criteria** (Aldrete ≥ 9 / PADSS ≥ 9, pain controlled, tolerates oral, void, escort present) → doctor sign-off → **same-day discharge summary** (procedure, findings, medications, warning signs, follow-up, emergency contact) → bill (package variance flags, IP-005/OP-005 per config; insurer day-care claim) → Events `daycare.admitted`, `daycare.discharged`.
3. Exceptions: conversion to inpatient (complication/late recovery) → IP-001 admission with day-care charges migrated; cancellation/no-show → slot release, advance refund rules; overnight observation crossing midnight → policy (bill as day-care extended vs IP).

### 3.9 ER statistics & real-time occupancy broadcast

- TV board (EN-18): zone occupancy, waiting by ESI (counts, not names), average door-to-doctor, ambulances inbound (ETA), boarding count, code status; public waiting-area board shows token/initials only.

## 4. Data Model (schema `er`)

- **er_visits**: id, hospital_id, branch_id, er_no (`ER_NO`), patient_id (nullable until identified) , temp_tag_id, is_unknown bool, arrival_at, arrival_mode enum(walk_in/ambulance_hospital/ambulance_108/private_vehicle/police/referred/transfer_in/mci), brought_by jsonb (name, relation, phone, police PS/badge, ambulance no), referring_facility, chief_complaint, complaint_category, esi_level smallint (1–5), triage_colour, triage_at, triaged_by, re_triage_history jsonb[], zone_id, bay_id, attending_doctor_id, primary_nurse_id, is_mlc bool, mlc_no, mlc_id (TR-008), is_trauma_activation, trauma_id (TR-001), pathway enum(none/stroke/stemi/sepsis/trauma/obstetric/paeds/poison/psych/burns), isolation_flag, status enum(pre_arrival/arrived/triaged/in_treatment/awaiting_results/awaiting_specialist/observation/boarding/disposed), disposition enum(admitted/discharged/referred/transferred/lama/absconded/died/brought_dead/observation_completed), disposition_at, disposition_by, admission_id (IP), discharge_summary_doc_id, death_declared_at, death_cause_provisional, payer_type, scheme_ref (MV Act/PMJAY), bill_id, los_minutes, notes.
- **er_pre_arrivals**: ambulance_trip_id (TR-009), eta, prehospital_vitals jsonb, suspected_dx, mci_incident_id, created_at, linked_er_visit_id.
- **triage_assessments**: er_visit_id, seq, at, by, vitals jsonb (from OP-007 vitals_id ref), gcs_e/v/m, avpu, pain_score, esi_decision jsonb (A/B/C/D answers, resources), esi_suggested, esi_final, override_reason, news2, pews, allergies_confirmed, weight_kg, pregnancy_status, isolation_risk, notes.
- **er_zones**, **er_bays**: zone_id, code, type enum(resus/acute/fast_track/observation/paeds/isolation/decon/chair/trolley), status enum(free/occupied/cleaning/blocked/reserved), current_er_visit_id, equipment_tags[], last_cleaned_at.
- **er_bay_assignments**: er_visit_id, bay_id, from_at, to_at, moved_by, reason.
- **er_timestamps** (KPI): er_visit_id, event enum(door/triage/doctor_first_contact/ct_ordered/ct_done/ecg_done/antibiotic_given/thrombolysis/specialist_called/specialist_arrived/decision_to_admit/bed_assigned/left_er), at, by, source (auto/manual).
- **on_call_alerts**: er_visit_id, specialty_id, doctor_id (from roster), sent_at, channels[], acknowledged_at, eta_minutes, arrived_at, escalation_level, escalated_to[], outcome enum(attended/phone_advice/declined/no_response), note.
- **er_dispositions**: er_visit_id, type, at, by, destination (ward/bed/facility), handover_checklist jsonb, lama_consent_doc_id, transfer_docs[], death_details jsonb (time, declared_by, cause, mlc, inquest, mortuary_id).
- **belongings_register**: er_visit_id, items jsonb[], sealed_bag_no, handed_to (police/relative), witness_names, signatures (file ids), at.
- **er_observation_stays**: er_visit_id, started_at, ended_at, bay_id, hours, billing_slab_id, converted_to_admission_id.
- **er_procedures** (link to OP-010 or inline): er_visit_id, procedure_code, performed_by, at, consent_doc_id, notes, consumables[].
- **mci_incidents**: incident_no, type, location, declared_at, declared_by, casualties_expected, status, stand_down_at; **mci_tags** (tag_no pre-printed, start_category, er_visit_id).
- **er_pathway_runs**: er_visit_id, pathway, activated_at, milestones jsonb (target/actual), breached[].
- **daycare_bookings**: id, hospital_id, branch_id, booking_no (`DAYCARE`), patient_id, procedure_service_id, doctor_id, scheduled_at, slot_id, package_id?, estimate_id, preauth_id?, status enum(booked/confirmed/checked_in/in_procedure/observation/discharged/converted_ip/cancelled/no_show), prep_sent_at, consent_doc_ids[], checklist jsonb, bed_id (daycare unit), procedure_note_doc_id, observation_vitals (refs), discharge_score jsonb (aldrete/padss), discharge_criteria_met_at, discharged_at, discharge_summary_doc_id, bill_id/admission_id, cancel_reason.
- **daycare_units**, **daycare_beds** (chairs/beds, status).
- Indexes: er_visits (hospital_id, branch_id, status, esi_level, arrival_at), (patient_id, arrival_at desc), (is_mlc), (mlc_no) unique; er_timestamps (er_visit_id, event); on_call_alerts (sent_at, acknowledged_at) for KPI; daycare_bookings (branch_id, scheduled_at, status). RLS all. `er_timestamps` and `triage_assessments` high-write → monthly partitions optional.

## 5. Business Rules & Validations

- Registration cannot block care: quick reg needs only name-or-unknown, gender, approx age, complaint; UHID/tag issued immediately; payment never a precondition (Parmanand Katara) — UI has no "pay first" gate in ER; MV Act/PMJAY/charity payer flags.
- Unknown patient: mandatory photo, physical description, belongings register, police intimation (TR-008), attempts to identify logged; merge into UHID keeps ER no.
- Triage mandatory within 5 min of arrival (alert if breached; NABH indicator); ESI-1/2 bypass registration desk (registered bedside); ESI level change requires reason; nurse triage requires role 19 (or 16 with ER scope) — doctors can override.
- Board sort strictly by ESI then wait time; timers per level; ESI-1 auto-pages team.
- Bay occupancy: one active patient per bay (except MCI mode); moves logged.
- MLC: once flagged cannot be un-flagged except MS with reason; MLC number gapless; discharge/transfer/body release blocked until TR-008 minimum set complete or MS override (audited); MLC visits excluded from routine WhatsApp report pushes; police get only intimation form, not clinical record (unless court/summons via TR-008).
- On-call: roster required for every specialty per shift (NC-030 validation); alerts contain no full name/diagnosis over SMS; ack requires authenticated action; escalation timers configurable; response-time reports by doctor.
- Death: declaration by physician with time; MLC check mandatory (unnatural → MLC/inquest); brought-dead recorded as separate visit type without treatment charges except ambulance/mortuary; certificate flow via IP-017.
- Observation billing slabs from tariff; conversion prompt at threshold; ER charges migrate to IP bill on admission (no double billing — items re-pointed by bill id with audit).
- Day-care: procedure must be on hospital day-care list (mapping to insurer lists); discharge only when criteria score met and doctor signed; crossing midnight → policy flag; package variance approvals (OP-023/IP-008).
- Consent: emergency implied consent documented by doctor; procedures need consent (attendant when patient incapable, relationship recorded); LAMA requires signed form + witness.
- Numbering: `ER_NO`, `MLC` (gapless), `DAYCARE`, `ER_TAG`.
- Retention: MLC records permanent; ER records ≥ 10 y; MCI incident records permanent.

## 6. API Surface (`/api/v1/er`)

| Method  | Path                                                                                                    | Purpose                                    | Permission                                               | Idem                  | Pag    |
| ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- | --------------------- | ------ |
| POST    | /visits/quick-register                                                                                  | quick reg (UHID or tag)                    | er.visit.create                                          | Y                     | –      |
| PATCH   | /visits/{id}/identify                                                                                   | link tag → patient / complete demographics | er.visit.update                                          | Y                     | –      |
| GET     | /board?zone=&status=                                                                                    | ER board read model                        | er.board.read                                            | –                     | –      |
| POST    | /visits/{id}/triage                                                                                     | create/re-triage                           | er.triage.create                                         | Y                     | –      |
| POST    | /visits/{id}/bay                                                                                        | assign/move bay                            | er.bay.assign                                            | Y                     | –      |
| POST    | /visits/{id}/timestamps                                                                                 | KPI event                                  | er.visit.update                                          | Y                     | –      |
| POST    | /visits/{id}/mlc                                                                                        | flag MLC → TR-008                          | er.mlc.flag                                              | Y                     | –      |
| POST    | /visits/{id}/belongings                                                                                 | register                                   | er.visit.update                                          | Y                     | –      |
| POST    | /visits/{id}/on-call                                                                                    | page specialty                             | er.oncall.alert                                          | Y                     | –      |
| POST    | /on-call-alerts/{id}/ack, /arrive, /escalate                                                            | responses                                  | er.oncall.respond / er.oncall.alert                      | Y                     | –      |
| POST    | /visits/{id}/pathway                                                                                    | activate stroke/STEMI/sepsis/trauma        | er.pathway.activate                                      | Y                     | –      |
| POST    | /visits/{id}/observation/start                                                                          | stop                                       | observation billing                                      | er.observation.manage | Y      | –   |
| POST    | /visits/{id}/disposition                                                                                | admit/discharge/refer/lama/death           | er.disposition.set                                       | Y                     | –      |
| GET     | /visits/{id}                                                                                            | full ER record                             | er.visit.read                                            | –                     | –      |
| GET     | /visits?from=&status=&mlc=                                                                              | list/search                                | er.visit.list                                            | –                     | cursor |
| POST    | /pre-arrivals                                                                                           | from TR-009                                | integration.er.prearrival                                | Y                     | –      |
| POST    | /mci/incidents, /mci/incidents/{id}/tags, /stand-down                                                   | MCI mode                                   | er.mci.manage                                            | Y                     | –      |
| GET     | /stats/dashboard, /stats/kpi?from=                                                                      | ER KPIs                                    | er.report.read                                           | –                     | –      |
| POST    | /daycare/bookings                                                                                       | book                                       | daycare.booking.create                                   | Y                     | –      |
| GET     | /daycare/bookings?date=&status=                                                                         | schedule/board                             | daycare.booking.list                                     | –                     | cursor |
| POST    | /daycare/bookings/{id}/check-in, /checklist, /procedure, /observation, /discharge, /convert-ip, /cancel | lifecycle                                  | daycare.booking.update / daycare.discharge.sign (doctor) | Y                     | –      |
| GET/PUT | /config/zones, /bays, /esi-targets, /mlc-criteria, /pathways, /daycare-units                            | config                                     | er.configure                                             | Y                     | –      |

## 7. Domain Events

- `er.patient.arrived` {er_visit_id, patient_id/tag, arrival_mode, is_mlc?} → EN-018 board, OP-005 (ER bill open), analytics.
- `er.triaged` {esi_level, colour, news2} → board sort, on-call auto-page for ESI-1, EN-018.
- `er.bay.assigned|vacated` → NC-018 cleaning, board.
- `er.mlc.flagged` {er_visit_id, mlc_no, criteria} → TR-008 register/police intimation, MRD, security.
- `er.oncall.alerted|acknowledged|arrived|escalated` → EN-037, roster analytics.
- `er.pathway.activated|milestone|breached` → teams, quality (NC-015).
- `er.observation.started|ended` → OP-005/IP-005 slab charges.
- `er.disposition.admitted` {admission_request} → IP-001, IP-005 (charge migration), bed board; `er.disposition.discharged|referred|lama|died|absconded` → OP-005 close, IP-017 (died), IP-018 (referred), PE-002 follow-up, EN-011 care context.
- `er.mci.declared|stand_down` → all boards, HR call-in (NC-030), blood bank, OT.
- `daycare.booked|checked_in|procedure_done|discharged|converted|cancelled` → OP-005/IP-005, EN-002 claims, EN-009 prep/instructions, PE-002.
- Consumes: `ambulance.prealert` (TR-009), `vitals.recorded` (OP-007), `lab.result.critical`, `trauma.score.updated` (TR-001), `bed.assigned` (IP-001), `roster.published` (NC-030).

## 8. Screens

- **ER board** (desktop wall + tablet + TV variant): columns/zones with patient cards coloured by ESI, timers, icons (MLC, isolation, trauma, pending STAT, boarding), filters; drag to bay; `F1` quick reg, `T` triage, `B` bay, `O` on-call, `D` disposition, `M` MLC, `/` search. Real-time; sound for ESI-1 arrival/pre-alert. Offline (tablet): triage/vitals cached & queued; board read-only.
- **Quick registration** (desktop/tablet): 5-field form, photo capture, tag print, "Unknown" toggle; `Enter` saves; wristband auto-print.
- **Triage form** (tablet): device vitals auto-fill, ESI decision wizard (A→B→C→D) with auto level, colour preview, pathway buttons (Stroke/STEMI/Sepsis/Trauma), print tag; large touch targets; voice input later.
- **ER patient workspace** (desktop/tablet): OP-002 workspace in ER mode (ATLS templates, STAT order sets, procedure notes, nursing chart tab, timeline of KPI timestamps, MLC panel, on-call panel, disposition wizard).
- **On-call console** (desktop + phone for doctors): roster today, active pages with timers, ack/ETA buttons (phone), escalation log.
- **Disposition wizard**: admit (IP-001 pre-fill, bed pick, handover checklist), discharge (summary generator + Rx + bill), refer/transfer, LAMA (consent capture), death (declaration + IP-017).
- **MLC panel** (hand-off to TR-008): criteria checklist, police details, belongings register, intimation status.
- **MCI mode screen** (desktop/tablet): tag scanning, START category counters, capacity, family desk list.
- **Day-care schedule & board** (desktop/tablet): bookings calendar, unit board (chairs/beds), checklist, observation vitals timeline with Aldrete/PADSS calculators, discharge summary editor.
- **ER dashboard/TV**: occupancy, ESI mix, door-to-doctor, ambulances inbound, boarding, LWBS %.
- Print: wristbands (ZPL 25 mm), triage tags, MLC intimation (TR-008 template), ER discharge summary, day-care summary, belongings receipt.

## 9. Integrations

- TR-009 ambulance pre-alert (108/112, GPS ETA, vitals relay), OP-007 device vitals (monitors via EN-042/HL7), EN-013 wristband printers, EN-018 boards, EN-037 + EN-009 + EN-033 (push/SMS/WhatsApp/IVR for on-call), NC-030 roster, IP-001/IP-005/IP-018/IP-017/IP-013/IP-007/IP-006, TR-001/TR-007/TR-008, OP-002/003/004/008/005, EN-002/RC-007 (MV Act cashless portal, PMJAY TMS emergency), NC-015 incidents, poison information centre (AIIMS/NPIC phone/API contact log), police e-mail/e-FIR portals (state-specific, TR-008), EN-011 ABDM.
- Fallbacks: roster missing → alert ER in-charge + manual pick; SMS failure → IVR call; device offline → manual vitals; ABDM/insurance down → mark pending.

## 10. Reports & Analytics

- ER census (arrivals by hour/day/mode/ESI), door-to-triage/doctor/disposition, ESI-level target compliance, LWBS/absconded %, ER LOS, boarding time, admission conversion %, revisit within 72 h, mortality (ER, brought-dead), MLC register summary, on-call response times by specialty/doctor, pathway KPIs (door-to-CT/needle/balloon/antibiotic), pre-alert accuracy, bay utilisation, observation stays & conversions, MCI reports, day-care volumes, cancellation/no-show, conversion to IP, discharge criteria compliance, revenue (ER/day-care), unknown-patient identification time, police intimation TAT, NABH ER indicators pack.
- Read models: `analytics.mv_er_kpi_daily`, `analytics.mv_er_board_snapshot` (15 min), `analytics.mv_oncall_response`, `analytics.mv_daycare_daily`.

## 11. Notifications

- On-call doctors: page (push+SMS+WhatsApp+IVR), escalation; specialists' arrival reminders.
- Teams: pathway activations (code stroke/STEMI/trauma), MCI declaration/call-in.
- Attendants/patients: registration/tag SMS with ER info, status updates (config), day-care prep instructions, discharge advice, follow-up.
- Admin/MS: ESI target breaches, MLC flagged, death, LAMA, MCI, boarding > threshold, on-call no-response.
- Housekeeping: bay cleaning; Security: MLC/police, violent patient; Blood bank: massive transfusion; Radiology/lab: STAT.
- TV: occupancy/wait board.

## 12. Permissions

`er.visit.create|read|list|update`, `er.board.read`, `er.triage.create|override`, `er.bay.assign`, `er.mlc.flag|unflag(MS)`, `er.oncall.alert|respond`, `er.pathway.activate`, `er.observation.manage`, `er.disposition.set`, `er.death.declare` (doctor), `er.mci.manage`, `er.report.read|export`, `er.configure`, `daycare.booking.create|list|update|cancel`, `daycare.discharge.sign`, `daycare.configure`, `integration.er.prearrival`.
Defaults: ER nurse: visit.create/update, triage._, bay.assign, oncall.alert, observation, board; EM physician: all clinical incl. disposition, death.declare, mlc.flag, pathway; ER receptionist: visit.create/update (demographics), board.read; specialists: oncall.respond, visit.read; MS: mlc.unflag, reports; Security: mlc read (intimation), belongings; Day-care nurse/coordinator: daycare._; Auditor: read.

## 13. Non-functional

- Volumes: 300–500 ER visits/day (2000-bed trauma centre), 40 bays, 20 concurrent triage tablets, MCI surge 100 patients/hour; day-care 150 procedures/day.
- p95: quick reg < 300 ms end-to-end (UHID + wristband enqueue), board load < 150 ms, triage save < 200 ms, on-call alert dispatch < 5 s to first channel; board socket updates < 1 s.
- Availability: ER functions must work during WAN outage on-prem (local API node) — architecture note: on-prem edge deployment recommended for trauma centres; PWA offline triage/vitals queue.
- Printing: wristband/tag ZPL local agent; MLC forms A4.
- Accessibility: high-contrast board (dark theme), colour + ESI numeral + icon; large tap targets; audible alerts with mute; RTL ready.
- i18n: triage tags bilingual; attendant SMS in local language.
- Security: MLC records restricted (ABAC `mlc_access`), police view via TR-008 only; audit all; no PHI in on-call SMS.

## 14. Acceptance Criteria

1. Given an unconscious unknown male, when receptionist uses quick reg with "Unknown" toggle, then a tag ID, wristband and ER visit are created in < 30 s, photo captured, and belongings register opened; later linking to a UHID preserves the ER record.
2. Given triage vitals HR 130, SpO2 88 %, when nurse answers ESI decision points, then ESI-2 is suggested (danger-zone up-triage), nurse confirms, colour Orange, tag prints, board card shows a 10-min timer.
3. Given ESI-1 triage saved, then trauma/resus team page fires automatically and the card pins to top with red; door-to-doctor timer starts.
4. Given three waiting patients (ESI 3 arrived 09:00, ESI 2 arrived 09:10, ESI 4 arrived 08:50), then board order is ESI 2, ESI 3, ESI 4.
5. Given MLC criteria RTA ticked, then a gapless MLC number is generated, `er.mlc.flagged` reaches TR-008, police intimation draft is created, and discharge is blocked until TR-008 minimum set is complete (MS override audited).
6. Given on-call ortho paged at 10:00 with no acknowledgement, then at 10:05 resend+IVR call, 10:10 backup paged, 10:15 HOD notified; when the doctor taps Acknowledge with ETA 15 min, the card shows ETA and arrival scan closes the alert; response-time report shows 5 min ack.
7. Given disposition "Admit" selected, then IP-001 admission request is pre-filled with ER diagnosis, orders, vitals, MLC flag; on bed assignment, ER charges migrate to IP bill without duplicates and ER LOS stops.
8. Given observation started at 10:00 and ended 15:30, then slab charges per tariff post to the ER bill; at 12 h an admission-conversion prompt appears.
9. Given a day-care cataract booking with package, then prep SMS is sent, checklist blocks procedure start until consent+NPO ticked, observation vitals schedule generates, and discharge is enabled only when Aldrete ≥ 9 and doctor signs; summary PDF prints and claim data goes to EN-002.
10. Given day-care patient develops complication, when converted to IP, then day-care charges migrate to admission bill and booking status becomes `converted_ip`.
11. Given MCI declared, then board enters MCI mode, pre-printed tags scan to create visits in < 5 s each, and START categories count live on TV; stand-down generates incident report.
12. Given TR-009 pre-alert with ETA 8 min and suspected STEMI, then a pre-arrival card appears, bay reserved, cath team pre-page option shown; on arrival scan links pre-arrival to visit.
13. Given ER WAN outage (on-prem), triage tablet still saves locally and syncs; board reflects after reconnect without duplicates.
14. Given a death in ER from RTA, then MLC is mandatory, death declaration captures time/doctor, IP-017 mortuary hand-off is created, and no discharge summary WhatsApp is sent.
15. Given ER visit under MV Act golden-hour scheme, then payer flag routes billing to scheme, no payment gate appears, and cashless documentation checklist opens.
16. Given LAMA chosen, then signed LAMA consent (EN-028) with witness is required before status changes and the event triggers a follow-up call task (PE-002).
17. Given ER KPI dashboard for last 7 days, door-to-doctor median matches recomputation from `er_timestamps` (test data).
18. Given a nurse without `er.triage.override` changes ESI from 3 to 4, then it is rejected; with permission, reason is mandatory and stored in re-triage history.

## 15. Enhancements / Later phases

- From VIMS sheet: mass casualty START protocol (Phase 6 with TR-001); ER-to-IP seamless transfer (Phase 6/7 core); trauma scoring auto-calc (TR-001); poison info centre integration (Phase 8: contact log now, API later); forensic documentation templates (TR-008); real-time ER occupancy broadcast (Phase 6 TV; public web widget later); ambulance link (TR-009).
- (market) EM-priority tokens pinned red, emergency → IPD data sync, triage notes (SmartHospital); casualty visit creation & billing (Prodoc); emergency sample management (MocDoc → OP-004 STAT); ER capacity prediction (AI-005); tele-triage/tele-stroke (OP-018); bedside ultrasound image capture (OP-008/POCUS); RFID patient tracking; family status board via portal (PE-001).

## 16. Open Questions for the Hospital

1. ER layout: zones, bays/trolleys count, isolation/decon rooms, paediatric ER? Day-care unit beds/chairs and procedures list.
2. Triage protocol: ESI (default) — confirm colour mapping (Red/Orange/Yellow/Green/Blue) and target times; use of NEWS2/PEWS; who triages (nurse vs doctor)?
3. MLC SOP: criteria list, police station jurisdiction(s), intimation format & channel (email/portal/hand delivery), whether police cases are treated free (state rule), MLC number series.
4. On-call roster source (NC-030 vs existing), specialties covered, escalation timings, preferred channels (SMS/WhatsApp/IVR), backup rules.
5. Trauma activation criteria and team composition (for auto-paging); pathways to enable at go-live (stroke, STEMI, sepsis, trauma).
6. ER billing: observation slabs, ER consult fee policy, deposit policy for admissions from ER, MV Act cashless empanelment status, PMJAY emergency package usage.
7. Unknown patient policy: charity head, identification steps, media/police photo sharing rules.
8. Day-care: which procedures, package vs itemised billing, insurer day-care lists in use, discharge scoring tool (Aldrete/PADSS), midnight-crossing policy.
9. Death/brought-dead workflow: certificate signing authority, mortuary capacity, inquest coordination.
10. MCI plan: tag stock, surge capacity, call-in tree, drills frequency.
11. Wristband printer models & locations; TV boards count.
12. On-prem/edge deployment for ER resilience acceptable? Network redundancy in ER?
