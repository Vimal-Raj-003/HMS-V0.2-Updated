# TR-004 — Trauma OT Coordination (Emergency OT override, WHO checklist, C-arm/fluoro dose log, intra-op implant documentation)

| Field | Value |
|---|---|
| Domain | Trauma & Orthopaedics |
| Module ID | TR-004 |
| Phase | 6/7 |
| Priority | P0 |
| Complexity | Very High |
| Depends on | IP-006 (Operation Theatre Management — the general OT scheduling/records engine; TR-004 is the **emergency/trauma overlay**: override booking, priority queue, trauma checklists, C-arm log, damage-control flows; all cases still live in IP-006 tables), IP-024 (anaesthesia record/PAC), TR-001 (activation → OT hold; scores), TR-007 (polytrauma priority queue & sequencing), TR-002 (fracture plan → OT request), TR-003 (implant scan/reservation), IP-007 (blood availability/MTP), EN-003 (CSSD trays/loaner sets), OP-008/EN-008 (C-arm DICOM images, dose), NC-020 (C-arm asset, AERB), NC-030 (on-call OT staff roster), EN-028 (consent incl. emergency consent), EN-037 (paging), EN-018 (OT board TV), IP-001 (bed/ICU hold), TR-006 (post-op ICU), IP-005 (OT charges), NC-008 (consumables), IP-012 (SSI), NC-015 (incidents), EN-039 (checklists), EN-024 |
| Feature flag | `module.trauma_ot.enabled` (sub: `trauma_ot.override_booking`, `trauma_ot.carm_dose_log`, `trauma_ot.damage_control`, `trauma_ot.hybrid_room`) |
| Primary roles | OT Coordinator / OT In-charge nurse (20/22), Surgeon — trauma/ortho/neuro/general (9), Anaesthetist (10), Nurse — OT/Scrub (20), Radiology technician (36, C-arm) |
| Secondary roles | Emergency physician (8, request), Intensivist (11), Blood bank (37), CSSD (38), Housekeeping (50, turnover), Biomedical (48, C-arm), Billing (27), Quality (54, WHO checklist compliance, SSI), MS (4, override approvals), Patient/attendant (consent), Auditor (58) |
| Regulatory | NABH 5th ed. COP.14–COP.16 (safe surgery: WHO Surgical Safety Checklist, site marking, consent, anaesthesia standards), WHO Surgical Safety Checklist 2009 (Sign In / Time Out / Sign Out), AERB radiation safety for C-arm (licence, TLD badges, dose records, lead aprons, QA), AERB e-LORA registration of C-arm units, PC-PNDT n/a, ATLS/damage-control surgery principles, NPPMTBI trauma centre OT availability norms (dedicated emergency OT 24×7 for Level I/II), Clinical Establishments Act (emergency care), consent law (emergency doctrine documented), BMW 2016 (OT waste), NDPS (OT narcotics), Fire/electrical safety, DPDP |

## 1. Purpose
TR-004 makes the operating theatre respond to trauma physiology rather than the elective calendar: an **emergency OT request** from ER/ICU/ward triggers a priority-classed override (bump/insert into elective schedule, open the dedicated emergency/hybrid room, page on-call OT team), a trauma-tuned readiness checklist (blood, implants/loaner sets, C-arm, cell saver, tourniquet, warming, ICU bed), WHO Surgical Safety Checklist with trauma additions (tourniquet time, MTP, c-spine precautions), damage-control vs definitive decision support, **C-arm/fluoroscopy dose logging** per case (AERB), scan-based intra-op implant documentation (TR-003), turnover and cascading re-scheduling of bumped elective cases. IP-006 remains the system of record for OT cases; TR-004 adds the emergency queue, override rules, trauma checklists, C-arm log and coordination boards.

## 2. Users & Jobs-to-be-done
- **OT coordinator** (desktop OT control room + tablet; 24×7): receive emergency requests, classify urgency, choose room/team, bump electives with least harm, notify all, keep the OT board honest in real time, manage turnover.
- **Trauma/ortho surgeon** (phone/tablet): raise emergency OT request in ≤ 30 s from ER/TR-007 board with urgency class, procedure, side, implants, blood; see slot/room confirmation and readiness; run Time Out; document op-note with implants scanned; decide damage-control vs definitive.
- **Anaesthetist** (tablet): emergency PAC (abbreviated), ASA-E, airway plan, blood/MTP readiness, warming; Sign In; intra-op record (IP-024); ICU hand-off.
- **Scrub/circulating nurse** (OT wall PC/tablet + scanner): readiness checklist, counts, implant scans (TR-003), consumables (NC-008), specimen labels, WHO Sign Out, C-arm log entry with technician.
- **Radiology technician / C-arm operator** (tablet): log C-arm use per case (kV/mA/time/DAP), staff in room with badges, images to PACS (EN-008).
- **Blood bank/CSSD/housekeeping/ICU**: receive readiness tasks (blood units, trays/loaner sets sterile, room turnover, ICU bed).
- **Quality/MS**: WHO checklist compliance, override justification review, start-time compliance, cancellations, C-arm dose outliers, SSI (IP-012).

## 3. Core Workflows

### 3.1 Emergency OT request & urgency classification
1. **Surgeon/EM physician** taps *Emergency OT* on ER visit / TR-007 card / fracture plan (TR-002) → form pre-filled (patient, diagnosis, side/site, planned procedure(s), surgeon, anaesthesia type, position, estimated duration, implants (TR-003 family/loaner), blood requirement (units/components/MTP), special equipment (C-arm, microscope, tourniquet, cell saver, traction table, navigation), infection status, MLC flag, consent status, NPO time, anticoagulants) → **urgency class** (NCEPOD-style, hospital-configurable): **1 Immediate** (life/limb-saving, ≤ 1 h: exsanguination, compartment syndrome, open fracture with vascular injury, extradural), **2 Urgent** (≤ 6 h: open fractures, hip dislocation, perforation), **3 Expedited** (≤ 24–48 h: hip fracture, closed long-bone), **4 Elective** → **System** validates consent/pre-op minimums (or emergency doctrine flag) → creates OT request in IP-006 with `is_emergency=true`, priority score (class + physiology from TR-006/TR-001 + waiting time) → Event `trauma_ot.request.created` → OT coordinator & anaesthetist on-call paged (EN-037).
2. **Coordinator** triages request (accept/clarify/decline with reason and MS escalation option); Class 1 auto-accepts and opens the emergency room hold if `override_booking` enabled.

### 3.2 Emergency override & scheduling
1. **System** proposes slots: (a) dedicated emergency/hybrid room if free; (b) next finishing room (based on live case status/turnover ETA); (c) **bump** an elective — ranked by least harm (not yet in OT, no anaesthesia induced, non-oncology, no pre-auth expiry, no long fasting, lowest surgeon disruption) → coordinator picks → **System** re-schedules bumped case (next available slot, same surgeon window), sets `bumped_by_request_id`, notifies surgeon/patient (EN-009 apology template with new time), records override justification (mandatory) → Event `trauma_ot.override.applied`.
2. **Team assembly**: on-call roster (NC-030) → page anaesthetist, scrub/circulating nurse, technician, C-arm tech, ward boy; acks/ETAs on board; if ack missing in 10 min → escalate (backup, HOD, MS).
3. **Readiness checklist** (trauma-tuned; each item task-routed): blood cross-matched/uncross-matched ready (IP-007), MTP cooler, implants reserved/loaner sterile (TR-003/EN-003), C-arm available & QA (NC-020), tourniquet, warming, cell saver, traction table, ICU/HDU bed hold (IP-001/TR-006), consent (EN-028 — emergency consent form when patient incapable: two doctors + attendant/witness; MS approval for unknown patient per policy), site marking, antibiotics timing plan, NPO/aspiration risk plan, MLC evidence protocol (bullet retrieval → TR-008 custody), infection precautions → all green or documented waivers before Sign In → Event `trauma_ot.ready`.
4. **Board**: OT control room screen + EN-018 TV shows every room: state (free/cleaning/prep/case/closing), emergency queue with countdown to class target, bumped cases, team acks, readiness traffic lights.

### 3.3 WHO Surgical Safety Checklist (trauma edition)
1. **Sign In** (before induction; anaesthetist + nurse): identity (wristband scan), site/side marked (photo), consent/emergency consent, allergy, airway/aspiration risk (unfasted trauma → RSI plan), blood loss risk > 500 mL/7 mL/kg → access & blood, anaesthesia machine check, pulse oximeter on; **trauma adds**: c-spine precautions, tourniquet on since (from TR-001), MTP status, temperature, tetanus/antibiotic given, pregnancy → each item ticked by named user, timestamp; hard-stop unless all yes/NA.
2. **Time Out** (before incision; all team): introductions, patient/procedure/site confirm (matches TR-002 laterality), anticipated critical events (surgeon: steps, duration, blood loss, damage-control plan; anaesthetist: concerns; nurse: sterility indicators, implants/loaner set present, equipment), antibiotics within 60 min, imaging displayed (EN-008 hanging), C-arm/lead aprons → incision time captured → Event `ot.case.incision` (consumed by TR-001 KPI door-to-OT).
3. **Sign Out** (before leaving): procedure recorded, counts (instruments/sponges/needles) correct — mismatch → X-ray in room via C-arm log, specimen labels (patient/site/MLC custody), equipment issues, key recovery concerns, implants list matches TR-003 log, drains/lines, ICU hand-off plan → Event `ot.case.signed_out`.
4. Checklist versions per hospital (EN-039), audio-guided prompts option, compliance % to Quality; each phase can be signed on tablet by role with PIN quick re-auth.

### 3.4 Intra-op documentation (trauma specifics on IP-006 op record)
- Findings, procedure(s) with CPT/SNOMED/hospital codes, **damage-control** flag (temporary ex-fix, packing, shunt) with planned relook date, tourniquet times (auto from TR-001/ manual), blood/products given (IP-007 issue scans), fluids, cell-saver volume, **implants scanned** (TR-003 panel: UDI/lot/serial/side/position — hard-stop on expiry/recall/side mismatch), consumables (NC-008 scan → auto-charge), specimens (MLC → TR-008 chain-of-custody), bone graft, wound closure/VAC, drains, complications, post-op instructions (weight-bearing → TR-002 plan, DVT, antibiotics), disposition (PACU/ICU/ward), surgeon sign (resident co-sign) — append-only versions with hash.
- Anaesthesia record in IP-024 (emergency PAC, ASA-E, RSI, blood, temperature, complications).

### 3.5 C-arm / fluoroscopy dose log (`trauma_ot.carm_dose_log`)
1. **C-arm operator/nurse** starts C-arm log for the case (device from NC-020 asset list; AERB licence & last QA date shown; TLD-badged staff in room selected from team) → per exposure set or auto from device (DICOM RDSR / MPPS via EN-008 where supported): mode (fluoro/pulsed/cine/DSA), kV, mA, fluoro time (s), DAP/KAP (Gy·cm²), cumulative air kerma, images acquired, magnification, collimation, protective measures (lead aprons/thyroid shields/lead glasses, distance), pregnancy status of patient/staff check → **System** totals per case, per patient (cumulative across cases; ties to OP-008 dose registry), per staff (monthly load), flags outliers (> P95 for procedure) → images saved to PACS under the case (EN-008) → Event `trauma_ot.carm.logged`.
2. AERB reports: equipment usage register, staff dose linkage (badge service results uploaded in NC-020), QA due alerts; C-arm breakdown → NC-020 ticket + board flag.

### 3.6 Mass-casualty & multi-room surge (with OP-006 MCI)
1. On `er.mci.declared`, **System** switches OT board to **surge mode**: all elective cases from the next N hours listed for hold/cancel decision by OT in-charge (bulk action with reason), rooms shown with "available in X min", on-call OT teams called in (NC-030 call-tree via EN-009/EN-033), implant/blood/CSSD stock snapshot on the board.
2. Casualties triaged Immediate/Red with surgical need appear in the emergency queue directly from TR-001/TR-007 with tag IDs (registration may still be pending); Class assignment by trauma surgeon; **room allocation grid** allows parallel damage-control cases; running tally (cases done/in progress/waiting) on EN-018.
3. Stand-down → surge report (cases, times, cancellations, staff called) → NC-015/TR-011.

### 3.7 Anaesthesia coordination for trauma (IP-024 overlay)
- Abbreviated emergency PAC (AMPLE, airway, c-spine, ASA-E, blood, last meal), RSI plan, warming, TXA/antibiotic timing prompts, MTP coordination (IP-007), intra-op events with timestamps, post-op destination decision (PACU vs direct ICU with TR-006 bed hold), hand-off SBAR to ICU/PACU with wristband scan acknowledgement.

### 3.8 Exceptions & edge cases
1. **Request for unknown/tag patient**: allowed (MCI or unidentified) with tag id; consent path = emergency doctrine/MS; billing to unknown head; identity linkage later re-points case (OP-001 merge).
2. **Patient deteriorates before OT** (ICU readiness worsens): case auto-flagged; team leader (TR-007) decides proceed (DCO) or hold; hold releases room and re-queues; timers continue.
3. **Two Class 1 requests, one room**: coordinator sees both; sequencing hint from TR-007 (life > limb); second request escalates to open a second room (call-in team) — decision logged with reason.
4. **Blood unavailable at Sign In**: readiness blocker; options: uncross-matched O-neg protocol (IP-007, 2-person), postpone with reason, proceed with MS-level acknowledgement for exsanguinating patients (audited).
5. **Implant not available** (size mismatch discovered intra-op): TR-003 emergency loaner request; case paused time logged; alternative construct documented.
6. **C-arm failure mid-case**: NC-020 breakdown ticket; alternate device; dose log continues on new asset; incident if delay > 15 min.
7. **Bumped patient refuses new date**: rebooking workflow with counselling note; refund/adjustment rules (IP-005/OP-005) if advance paid; complaint link (NC-032).
8. **Network outage in OT**: checklist/C-arm/implant capture continue offline; incision timestamp taken from device clock with server correction on sync (drift recorded).
9. **Death on table**: case closed with outcome death, MLC (TR-008) inquest flow, IP-017; WHO Sign Out replaced by death documentation; C-arm/implants still logged.

### 3.9 Post-op flow, turnover & cascading
- Case end → PACU/ICU hand-off (SBAR + implants + blood + tourniquet times), Aldrete in PACU (IP-006), ICU bed hold consumed (TR-006), housekeeping turnover task (NC-018) with terminal clean flag for infected cases, CSSD tray return (EN-003), C-arm release; bumped cases re-confirmed; emergency queue recomputes; **damage-control relook** auto-scheduled as Class 2/3 request with reminder at planned time.
- Cancellations/postponements (patient unfit, physiology worsened, blood unavailable) logged with reason categories → KPI; MLC cases: police informed of surgery when required (TR-008).
- Billing: OT charges by time bands, emergency OT surcharge (tariff RC-003), anaesthesia, C-arm usage, implants, consumables, blood → IP-005; package variance (IP-008) for trauma packages/PMJAY.

## 4. Data Model (schema `ot`, extending IP-006; trauma-specific tables prefixed `trauma_ot_`)
- **ot_cases** (IP-006 owned) — TR-004 adds columns: is_emergency bool, urgency_class enum(immediate/urgent/expedited/elective), class_target_minutes int, priority_score numeric, requested_at, request_source enum(er/icu/ward/opd/tr007), trauma_episode_id? (TR-001), fracture_ids uuid[] (TR-002), damage_control bool, relook_case_id?, bumped_by_request_id?, override_justification text, emergency_consent_type enum(patient/relative/emergency_doctrine/ms_approved), readiness_status enum(pending/ready/waived), incision_at, closure_at, mlc bool.
- **trauma_ot_requests**: id, hospital_id, branch_id, patient_id, encounter_id, requested_by, requested_at, urgency_class, procedures jsonb, side, site_snomed, surgeon_id, anaesthesia_type, est_duration_min, position, implants jsonb (family/loaner/reserved ids), blood_req jsonb (units, components, mtp), equipment text[], infection_status, mlc bool, consent_status, npo_since, anticoagulants jsonb, physiology_snapshot jsonb (from TR-006/TR-001), status enum(submitted/accepted/clarify/declined/scheduled/in_ot/completed/cancelled), decision_by, decision_at, decline_reason, ot_case_id?, room_id?, scheduled_start.
- **trauma_ot_overrides**: id, request_id, bumped_case_id, room_id, original_start, new_start, harm_score jsonb, justification, applied_by, applied_at, patient_notified_at, surgeon_ack_at.
- **trauma_ot_readiness**: case_id, item enum(blood/mtp/implants/loaner_sterile/carm/tourniquet/warming/cell_saver/traction_table/icu_bed/consent/site_marking/antibiotics_plan/npo_plan/mlc_protocol/infection_precautions/equipment_other), status enum(pending/done/waived/na), owner_role, task_id (EN-038), done_by, done_at, waiver_reason.
- **trauma_ot_team_pages**: case_id, role, user_id, sent_at, ack_at, eta_min, arrived_at, escalation_level.
- **who_checklists** (IP-006 owned; TR-004 adds trauma items): case_id, phase enum(sign_in/time_out/sign_out), version_id, items jsonb ({code, answer, by, at}), completed_at, completed_by, all_clear bool, hard_stop_overrides jsonb.
- **trauma_ot_carm_logs**: id, case_id, asset_id (NC-020), operator_id, started_at, ended_at, exposures jsonb[] ({at, mode, kv, ma, fluoro_s, dap_gycm2, kerma_mgy, images}), total_fluoro_s, total_dap, total_kerma, images_count, staff_in_room uuid[] (badge ids), protective_measures text[], patient_pregnancy_checked bool, source enum(manual/rdsr/mpps), outlier_flag bool, pacs_study_uid?.
- **trauma_ot_cancellations**: case_id, at, by, reason_code enum(patient_unfit/physiology/blood_unavailable/implant_unavailable/team_unavailable/room_unavailable/consent/other), notes, rescheduled_case_id?.
- Views: **ot_emergency_queue** (materialised every 30 s or event-driven cache in Redis): open requests ordered by priority_score, countdown to class target.
- Indexes: trauma_ot_requests (hospital_id, status, urgency_class, requested_at), (patient_id); trauma_ot_carm_logs (case_id), (asset_id, started_at); ot_cases (branch_id, is_emergency, scheduled_start). RLS; op records append-only; retention ≥ 10 y (C-arm logs per AERB ≥ 5 y; permanent if MLC).

## 5. Business Rules & Validations
- Urgency classes and targets configurable (defaults: Immediate ≤ 60 min, Urgent ≤ 6 h, Expedited ≤ 24 h/48 h for hip fracture); countdown from request time; breach → `trauma_ot.class_breached` to Quality/MS.
- Class 1 requests cannot be declined by coordinator (only MS/HOD with reason); override justification mandatory for any bump; a bumped case may not be bumped twice without MS approval; oncology/transplant cases require HOD consent to bump.
- WHO checklist phases are hard-stops in sequence: incision time cannot be recorded without Time Out complete; case cannot close without Sign Out; overrides only via `ot.checklist.override` (MS/HOD) with reason — reported.
- Laterality: request side must equal TR-002 fracture side and site-marking photo; mismatch → hard-stop.
- Emergency consent: patient capacity assessment recorded; relative consent with relationship & ID; emergency doctrine requires two doctors' signatures (surgeon + anaesthetist/EM) and MS notification; unknown patients per policy (MS approval); MLC surgeries note police-informed status.
- Antibiotic prophylaxis timing recorded (≤ 60 min before incision, 120 min for vancomycin) → SSI bundle (IP-012).
- Implants: op-note sign blocked when TR-003 log ≠ surgeon list; expired/recalled scan blocked.
- C-arm: log mandatory when C-arm booked/used (case cannot close if C-arm reserved and no log or explicit "not used"); operator must hold radiation-safety training record (NC-027) — warn; pregnancy check for females 10–55; per-case DAP outlier flag; device QA overdue → warn at booking, block if licence expired (NC-020).
- Counts mismatch at Sign Out → mandatory imaging/incident (NC-015) before closure.
- Damage-control: relook request auto-created with planned date; overdue → surgeon + TR-007 alert.
- Emergency surcharge & time-band billing per tariff; C-arm usage charge per minutes/procedure; cancellations after patient in OT still charge per policy (config).
- Numbering: OT case number from IP-006 (`OT_NO`), emergency requests `OT_EMG`.
- Immutability: op-note/anaesthesia/checklists append-only versions with hash chain; C-arm logs editable only by operator within 24 h then versioned.

## 6. API Surface (`/api/v1/ot/emergency`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /requests | create emergency OT request | ot.emergency.request | Y | – |
| GET | /requests?status=&class=&from= | queue/list | ot.emergency.read | – | cursor |
| GET | /queue | prioritised live queue read model | ot.emergency.read | – | – |
| POST | /requests/{id}/decide | accept/clarify/decline | ot.emergency.coordinate | Y | – |
| GET | /requests/{id}/slot-options | proposed rooms/bumps with harm score | ot.emergency.coordinate | – | – |
| POST | /requests/{id}/schedule | choose slot; apply override | ot.emergency.coordinate | Y | – |
| POST | /overrides/{id}/notify | notify bumped patient/surgeon | ot.emergency.coordinate | Y | – |
| POST | /cases/{caseId}/team/page, /ack, /arrive | team paging | ot.emergency.coordinate / ot.team.respond | Y | – |
| GET/PATCH | /cases/{caseId}/readiness | checklist items | ot.readiness.update | Y | – |
| POST | /cases/{caseId}/checklist/{phase} | WHO phase submit | ot.checklist.sign | Y | – |
| POST | /cases/{caseId}/checklist/{phase}/override | MS override | ot.checklist.override | Y | – |
| POST | /cases/{caseId}/carm/start, /exposures, /end | C-arm log | ot.carm.log | Y | – |
| GET | /cases/{caseId}/carm | log & totals | ot.carm.read | – | – |
| POST | /cases/{caseId}/damage-control | flag & schedule relook | ot.case.update (IP-006) | Y | – |
| POST | /cases/{caseId}/cancel | cancellation with reason | ot.emergency.coordinate | Y | – |
| GET | /board | rooms/queue/readiness read model | ot.board.read | – | – |
| GET | /reports/kpi?from=&to= | class compliance, WHO %, bumps, C-arm | ot.report.read | – | – |
| GET/PUT | /config/urgency-classes, /config/readiness-items, /config/checklist-versions, /config/harm-weights | config | ot.configure | Y | – |
(IP-006 endpoints for cases, op-notes, PACU; TR-003 for implant scans; IP-024 anaesthesia.)

## 7. Domain Events (outbox)
- `trauma_ot.request.created` {request_id, class, patient_id, procedures, blood_req} → OT coordinator, anaesthesia on-call (EN-037), IP-007 (blood readiness), TR-003 (reservation), TR-007 board.
- `trauma_ot.request.decided` {accepted/declined} → requester; `trauma_ot.class_breached`.
- `trauma_ot.override.applied` {bumped_case_id, new_start} → surgeon/patient notifications, IP-006 schedule, IP-005 (no double charge), EN-018 board.
- `trauma_ot.team.paged|acknowledged|arrived`.
- `trauma_ot.ready` {case_id} / `trauma_ot.readiness.blocked` {items}.
- `ot.checklist.sign_in|time_out|sign_out.completed`, `ot.case.incision` {at} → TR-001 KPI, TR-007; `ot.checklist.overridden` → Quality.
- `trauma_ot.carm.logged` {case_id, dap, fluoro_s, staff} → OP-008 dose registry, NC-020 usage, IP-005 charge.
- `ot.case.completed|signed` (IP-006) with trauma payload {damage_control, relook_at, implants[]} → TR-002, TR-006, TR-003, IP-012.
- `trauma_ot.relook.due|overdue`; `trauma_ot.cancelled` {reason}.
- Consumes: `trauma.team.activated` (TR-001 → soft hold on emergency room), `trauma.priority.updated` (TR-007), `blood.issue.ready|unavailable` (IP-007), `implant.reserved|reservation.released` (TR-003), `cssd.set.sterile` (EN-003), `bed.icu.hold.confirmed` (IP-001/TR-006), `roster.published` (NC-030), `asset.status.changed` (NC-020 C-arm), `housekeeping.task.completed` (NC-018).

## 8. Screens (UI)
- **Emergency OT request** (phone/tablet/desktop; from ER, ICU, TR-007, fracture plan): pre-filled form, urgency class chips with target, blood/implant/equipment pickers, consent status, submit; `Ctrl+Enter` submit; offline: draft cached, sends on reconnect (warns that Class 1 needs phone call fallback).
- **OT control room board** (desktop 2×monitor + EN-018 TV): rooms timeline (Gantt) with live case status, emergency queue rail (countdown colour amber/red), bumped cases, team ack chips, readiness lights, C-arm availability; drag request to room/slot; `E` new request, `S` schedule, `P` page team, `R` readiness; real-time via Socket.IO; error: roster missing → manual pick.
- **Slot options dialog**: candidate rooms/bumps with harm score breakdown, justification text mandatory.
- **Readiness checklist** (tablet in OT/coordinator desktop): items with owner, status, waiver; blood/implant/CSSD live status from events.
- **WHO checklist** (OT wall tablet, large touch, PIN sign per phase): phase tabs, hard-stop indicator, wristband scan, site photo, timers (antibiotic, tourniquet), audio prompt toggle; `1/2/3` phase switch, `Space` next item.
- **C-arm log** (tablet near C-arm): device select with QA/licence status, exposure quick-add (presets per procedure), totals gauge vs P95, staff-in-room chips, pregnancy check, PACS push status.
- **Op-record trauma tab** (IP-006 workspace): damage-control toggle & relook date, tourniquet times, implants (TR-003 panel), blood, specimens (MLC custody), post-op orders → TR-002 plan; append-only sign.
- **Emergency OT KPI dashboard** (desktop): class compliance, decision-to-incision, WHO %, bumps & cancellations, night-time cases, C-arm dose distribution, SSI link.
- Print: OT list (emergency section), WHO checklist PDF, C-arm dose sheet, emergency consent forms (bilingual), op-note.

## 9. Integrations
- IP-006 scheduling core; IP-024 anaesthesia; TR-003 scanners; IP-007 blood; EN-003 CSSD; NC-020 assets/AERB (C-arm licence, QA, badge dose upload); EN-008/OP-008 C-arm DICOM (MPPS/RDSR where available; else manual) & image push; NC-030 roster; EN-037/EN-009 paging; EN-018 boards; NC-018 housekeeping; IP-001/TR-006 bed holds; IP-005 charges; EN-028 consent (e-sign, witness); TR-008 evidence custody for specimens/bullets; IP-012 SSI bundle; NC-015 incidents; RC-003 tariff (emergency surcharge).
- Fallbacks: paging failure → IVR call (EN-033) + phone list; board offline → printed list; RDSR unavailable → manual dose entry; C-arm down → alternate device or postpone with reason.

## 10. Reports & Analytics
- Emergency OT KPIs: request-to-decision, decision-to-incision by class & compliance %, night/weekend share, bumps per week & elective cancellation impact, team ack times, readiness blockers (blood/implant/CSSD), WHO checklist compliance (phase-level, hard-stop overrides), antibiotic timing, count discrepancies, C-arm fluoro time/DAP by procedure/surgeon (outliers), staff cumulative fluoro exposure proxy, C-arm utilisation & downtime, damage-control relook timeliness, cancellations by reason, emergency OT utilisation, cost per emergency case, SSI (with IP-012).
- Read models: `analytics.mv_ot_emergency_kpi`, `analytics.mv_who_checklist_compliance`, `analytics.mv_carm_dose`, `analytics.mv_ot_bumps`.

## 11. Notifications
- Team pages (role-based, no full names), escalations; coordinator: new Class 1/2 request (sound); surgeon: slot confirmed/changed; bumped patient & surgeon (SMS/WhatsApp/call script); blood bank/CSSD/implant store: readiness tasks; ICU: incoming post-op; housekeeping: turnover; Quality/MS: overrides, checklist overrides, class breaches, count mismatch, C-arm outliers; relook due reminders; AERB QA/licence due (NC-020).

## 12. Permissions (RBAC keys)
`ot.emergency.request|read|coordinate`, `ot.team.respond`, `ot.readiness.update`, `ot.checklist.sign|override`, `ot.carm.log|read`, `ot.board.read`, `ot.report.read|export`, `ot.configure` (+ IP-006 `ot.case.*`, TR-003 `implant.usage.*`).
Defaults: Surgeon/EM physician: emergency.request/read, checklist.sign, board.read; OT coordinator/in-charge (20/22): coordinate, readiness.update, board, report; Anaesthetist: request read, checklist.sign, readiness (anaesthesia items); Scrub/circulating nurse: readiness.update, checklist.sign, carm.log; Radiology tech: carm.log/read; Blood bank/CSSD/housekeeping: readiness.update (own items) via tasks; MS/HOD: checklist.override, decline Class 1, reports; Quality/Biomedical: carm.read, report.export; Admin: configure; Auditor: read.

## 13. Non-functional
- Volumes: 12–20 OTs, 25–40 emergency cases/day, 120–180 total cases/day; queue recompute < 200 ms on each event; board updates < 1 s to all clients (≥ 50 concurrent boards/tablets).
- p95: request create < 300 ms incl. paging enqueue; slot options < 500 ms; checklist phase save < 200 ms; C-arm exposure add < 100 ms.
- Offline: WHO checklist and C-arm log tablets tolerate 30-min outages (local queue, PIN sign cached); request drafts cached; board read-only cache with staleness banner.
- Printing: A4 checklists/consents; label printer for specimens (EN-013).
- Accessibility: large touch targets in OT (gloves), audio prompts, high-contrast board; i18n bilingual consents.
- Security: PHI-free pages; checklist overrides audited; C-arm logs immutable after 24 h; radiation data access limited to OT/radiology/biomedical/quality.

## 14. Acceptance Criteria
1. Given surgeon submits a Class 1 request from the TR-007 board at 10:00, then the request is auto-accepted, emergency room hold appears on the board, anaesthetist/scrub/C-arm tech are paged within 5 s, and a 60-min countdown starts.
2. Given no free room, when coordinator opens slot options, then bump candidates are ranked by harm score with justification field; applying a bump reschedules the elective, notifies its surgeon and patient, and records `trauma_ot.override.applied`.
3. Given a bumped case already bumped once, when selected again, then MS approval is required before applying.
4. Given readiness shows blood "pending" from IP-007, then Sign In is blocked with the blocker listed; when `blood.issue.ready` arrives, item turns green automatically.
5. Given Time Out not completed, when nurse tries to record incision time, then it is rejected with hard-stop; MS override with reason permits and emits `ot.checklist.overridden`.
6. Given request side "left" and TR-002 fracture side "right", then request submission is blocked until reconciled.
7. Given emergency doctrine consent chosen, then two doctor signatures and MS notification are required before Sign In.
8. Given C-arm reserved and case closing without log, then closure is blocked until a log or "not used" is recorded.
9. Given exposures totalling 4.2 min fluoro and DAP above P95 for IM nailing, then the log is flagged outlier, and Quality receives a weekly digest; the DAP is written to the patient's OP-008 dose registry.
10. Given a female patient aged 30 with pregnancy status unknown, then the C-arm log requires the pregnancy check before first exposure.
11. Given surgeon marks damage-control with relook in 48 h, then a Class 2 relook request is auto-created for that time and an overdue alert fires if not scheduled by then.
12. Given Sign Out counts mismatch, then closure requires an in-room imaging record and an NC-015 incident before completion.
13. Given implants scanned (TR-003) differ from surgeon's confirmed list, then op-note sign is blocked until reconciled.
14. Given class Urgent target 6 h and incision at 6 h 40 min, then `trauma_ot.class_breached` is emitted and shows in the KPI report with breach reason capture.
15. Given a page with no acknowledgement in 10 min, then backup on-call is paged and HOD notified at 20 min; ack/ETA/arrival timestamps appear on the board.
16. Given a WHO checklist tablet offline for 10 min during Sign In, then items are captured locally with PIN signatures and sync in order without loss; incision cannot be recorded until sync confirms Time Out.
17. Given MCI declared at 21:00, then the OT board enters surge mode listing electives in the next 12 h for hold/cancel, on-call OT teams receive call-in messages, and casualties with tag IDs can be scheduled without UHID; stand-down produces the surge report.
18. Given post-op destination "direct ICU" chosen at anaesthesia sign-out, then the TR-006 bed hold is consumed, ICU nurse receives SBAR hand-off, and PACU is skipped in the case timeline with reason.
19. Given a case cancelled after patient arrival in OT for physiology, then the cancellation reason is mandatory, charges follow the configured policy, and TR-007 board shows the case back in the queue with a re-plan flag.
20. Given C-arm licence expired in NC-020, then booking that C-arm for a case is blocked and an alternate device is suggested.
21. Given two Class 1 requests within 5 min and one free room, then the coordinator sees TR-007's life-over-limb hint, opening a second room triggers call-in pages, and both decisions are logged with reasons.
22. Given a death on table, then the case closes with outcome death, TR-008 inquest intimation and IP-017 mortuary hand-off are created, and the C-arm/implant logs remain complete and immutable.
23. Given a request created for an unidentified MCI tag patient, then the case proceeds with emergency-doctrine consent, and after identity merge the OT case shows the UHID with the merge in audit.

## 15. Enhancements / Later phases
- From VIMS sheet row 25 (OT enhancements): SSI surveillance (IP-012, Phase 7), implant recall & patient notification (TR-003), robot-assisted surgery documentation (IP-006 Phase 8+), OT environment monitoring temp/humidity (EN-042 Phase 12), surgeon fatigue tracking (NC-030 hours-worked rule, Phase 9), cost-per-surgery analytics (EN-001/NC-011).
- (market) SmartHospital: surgical notes with auto-duration & signature spaces (covered in IP-006); add: hybrid OR/angio suite scheduling, RFID sponge counting integration, video recording of procedures (EN-042), OT capacity prediction for emergency demand (AI-005), navigation/robotics logs, tele-mentoring (OP-018), automated AERB e-LORA dose submissions (EN-017).

## 16. Open Questions for the Hospital
1. Number of OTs, dedicated emergency/hybrid room 24×7? Night staffing model and on-call roster source.
2. Urgency classification to adopt (NCEPOD 4-class default) and targets; who may bump electives and approval chain; patient communication policy for bumps.
3. WHO checklist version/customisation (trauma additions), audio prompts, PIN signing acceptable?
4. Emergency consent policy (two-doctor rule, MS approval for unknown patients), forms & languages.
5. C-arm units (count, models, RDSR/MPPS capable?), AERB licence details, TLD badge provider, dose thresholds for outliers.
6. Damage-control protocols and relook scheduling norms; hip fracture ≤ 48 h target?
7. Emergency OT surcharge/time-band billing rules; C-arm charging basis.
8. Specimen/MLC evidence handling in OT (bullets, clothing) — police coordination.
9. Housekeeping turnover targets and terminal clean protocol for infected cases.
10. Which KPIs feed NABH indicators (start-time compliance, cancellations, WHO compliance)?
11. Two-Class-1-collision policy: who authorises opening a second room at night and which call-in team?
12. Should bumped-patient notifications include automatic rebooking links (PE-001) or always a phone call?
13. Uncross-matched O-neg protocol acknowledgement level (MS vs surgeon+anaesthetist)?
14. Offline tolerance expected in OT (network reliability) — is a local edge API node planned?
15. Preferred surge-mode horizon (hold electives for next 12 h vs 24 h) and communication templates.
16. Which OT boards/tablets exist per room; PIN vs badge-tap for checklist signatures?
17. Cost-per-emergency-case reporting requirements for management (feeds NC-011)?
