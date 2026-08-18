# IP-006 — Operation Theatre Management (scheduling calendar, team, pre-op, WHO Surgical Safety Checklist, anaesthesia link, op notes, implants, consumables & counts, CSSD trays, recovery/Aldrete, utilisation, SSI hook, video consent/evidence)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-006 |
| Phase | 7 |
| Priority | P0 |
| Complexity | Very High |
| Depends on | IP-001 (admission, bed hold for return, ICU reservation), IP-003 (pre-op checklist, ward hand-off), IP-024 (Anaesthesia Information System: PAC, intra-op record, PACU — IP-006 links to it), TR-004 (trauma OT overlay/emergency override), TR-003 (implants UDI/serial), NC-007 (consignment implants), NC-006/IP-014 (OT store consumables, drugs), EN-003 (CSSD trays/sets), OP-010 (procedure catalogue), OP-002 (orders, diagnoses), EN-028/EN-016 (consents, e-sign, video consent), IP-007 (blood availability/reserve), OP-004/OP-008 (pre-op investigations, frozen section, intra-op imaging C-arm), IP-005 (OT charges), IP-008 (packages), IP-012 (SSI surveillance), IP-009 (post-op ICU), NC-002/NC-020 (OT equipment, laparoscopy towers, C-arm AERB), NC-018 (OT cleaning turnover), NC-030 (OT staff roster), EN-018 (OT status board/family board), EN-037 (alerts), EN-039 (op-note templates), EN-042 (OT environment sensors), EN-013 (barcodes), EN-024 (audit), NC-015 (incidents, mortality/morbidity), NC-034 (surgeon payouts) |
| Feature flag | `module.ot.enabled` (sub: `ot.video_evidence`, `ot.environment_monitoring`, `ot.instrument_count_barcode`, `ot.family_board`, `ot.robotic_docs`, `ot.surgeon_fatigue`) |
| Primary roles | Surgeon (9), Anaesthetist (10), Nurse — OT/Scrub/Circulating (20), OT In-charge/Manager, OT Technician, CSSD (38) |
| Secondary roles | Ward nurse (17, pre-op/post-op), Intensivist (11), Resident (14), Recovery/PACU nurse, Blood bank (37), Billing (27), Stores (44), Biomedical (48), Housekeeping (50), Quality/ICN (54/21), Patient/Family (59/60, board/consent), Auditor (58) |
| Regulatory | NABH 5th ed. COP.14 (surgical services: pre-op assessment, informed consent, site marking, WHO checklist, op notes immediately post-op, post-op monitoring, adverse events), COP.15 (anaesthesia — see IP-024), PRE.5 (informed consent incl. anaesthesia & blood), MOM (OT drugs/narcotics), HIC (SSI surveillance, OT asepsis, sterilisation), WHO Surgical Safety Checklist 2009 (Sign In / Time Out / Sign Out), CDSCO Medical Device Rules 2017 & UDI (implants), AERB (C-arm licence & dose logging), BMW 2016 (OT waste), NDPS, Transplantation of Human Organs Act (if applicable), DPDP (video evidence = PHI), IT Act (tamper-evident storage), Clinical Establishments (OT register) |

## 1. Purpose
IP-006 runs every operating theatre from request to recovery: surgeon requests a slot, the OT calendar allocates theatre/time/team/equipment (with emergency override rules shared with TR-004), pre-op readiness is verified (consent, NPO, blood, implants, CSSD trays, investigations, PAC clearance from IP-024, site marking), the WHO checklist is executed at Sign In / Time Out / Sign Out with hard stops, intra-op documentation captures procedure, findings, implants (UDI/serial → TR-003), consumables (barcode → inventory & bill), instrument/sponge/needle counts, specimens, blood, complications and timings, op notes are signed immediately, recovery (PACU) uses Aldrete/modified Aldrete for discharge criteria, and analytics measure utilisation, first-case start, turnover, cancellations and cost per surgery. Optional video consent/evidence capture and OT environment monitoring add legal and infection-control assurance.

## 2. Users & Jobs-to-be-done
- **Surgeon** (desktop/phone): request OT slot (elective list days ahead; emergency now), see own list, complete pre-op orders/consent, perform Time Out with team, write op note (template) within 30 min post-op, dictate, order post-op care, review utilisation & outcomes.
- **Anaesthetist** (desktop/tablet): PAC (IP-024), plan/ASA, Sign In participation, intra-op record (IP-024), PACU discharge sign-off.
- **OT in-charge/manager** (desktop + OT board): build daily list (sequence, theatre allocation, staff, equipment, trays), manage delays/cancellations, emergency insertions, turnover, publish list to wards/CSSD/blood bank/stores; utilisation KPIs.
- **Scrub/circulating nurse** (OT wall PC/tablet with scanner): checklist steps, counts, implants scan, consumables scan, specimen labelling, timings, cleanliness/turnover, CSSD tray issue/return.
- **OT technician / anaesthesia tech**: equipment readiness checklists, C-arm, tables, gases.
- **Ward nurse**: pre-op checklist (IP-003), send-for, receive back with hand-off.
- **PACU nurse**: Aldrete scoring, pain, PONV, vitals, discharge criteria.
- **CSSD**: tray demand from list, issue/return scan (EN-003).
- **Blood bank**: reserve requests from list (IP-007).
- **Billing**: OT charge composition (time slabs, team fees, equipment, consumables, implants) auto-posted (IP-005).
- **Family**: OT status board (`ot.family_board`: "In OT → Recovery → Ward" by token, EN-018).
- **Quality/ICN**: WHO checklist compliance, SSI follow-up (IP-012), incidents, mortality/morbidity.

## 3. Core Workflows

### 3.1 OT master configuration
- Theatres (code, speciality tags, laminar flow/HEPA, equipment fixed, session templates), sessions (per theatre per weekday: speciality/surgeon block times), procedure catalogue mapping (OP-010: standard duration, required equipment, tray sets EN-003, implant needs, blood needs, anaesthesia type, position, antibiotic prophylaxis, SSI class), team roles, cancellation reason codes, delay reason codes, turnover SLA, checklists (WHO + hospital additions), op-note templates per procedure (EN-039), charge composition rules (IP-005), OT store location (NC-006).

### 3.2 OT booking request → scheduling
1. **Surgeon** creates **OT request** from admission/OPD (planned admission): procedure(s) (catalogue + side/site), diagnosis, urgency (elective/urgent ≤ 24 h/emergency ≤ 1 h — TR-004 classes for trauma), preferred date/session, estimated duration, anaesthesia type request, special needs (C-arm, microscope, laparoscopy tower, robot, cell saver, frozen section, implants list & vendor, blood units, ICU bed post-op, isolation), team preferences (assistant, anaesthetist), consent status, PAC status → Event `ot.request.created`.
2. **OT manager** schedules on **calendar** (theatre × time; drag/drop; conflicts on theatre/surgeon/anaesthetist/equipment/tray availability/CSSD lead time; block-session rules; overbooking warning) → assigns theatre, start/end, sequence, team (surgeon, assistants, anaesthetist(s), scrub, circulating, technician), equipment reservations (NC-002), tray sets (EN-003 demand), implants pick list (TR-003/NC-007), blood reserve request (IP-007), ICU bed hold (IP-001) → status `scheduled` → Event `ot.case.scheduled` → notifications to team, ward (pre-op prep, NPO time), CSSD, stores, blood bank, billing (estimate/package), family (planned time).
3. **Elective list publication** daily (e.g. 16:00 previous day) → PDF/board; changes after publication logged with reasons.
4. **Emergency insertion / override**: emergency request → manager (or on-call surgeon per TR-004 rules) selects theatre; system proposes bump candidates (lowest-priority elective not yet sent-for) → bumped case rescheduled with reason & notifications; audit; KPI emergency-to-incision time.
5. **Reschedule/cancel**: reason codes (patient unfit, NPO breach, no bed/ICU, surgeon unavailable, equipment, consent, insurance, patient refusal, overrun) → Event `ot.case.cancelled|rescheduled`; cancellation on the day counted for KPI; ward/family notified; trays returned; blood reserve released.

### 3.3 Pre-op readiness (D-1 to send-for)
- **Readiness dashboard** per case: consent (surgical, anaesthesia, blood, HIV, photo/video — EN-028 statuses), PAC done & ASA (IP-024), NPO from time (nurse-recorded), investigations (required set per procedure/ASA: CBC, coag, RFT, ECG, X-ray etc. — results/pending), blood availability (IP-007 reserve status), implants ready (received & verified), trays ready (EN-003 sterile & BI passed), equipment ready, site marked (surgeon; laterality), antibiotic prophylaxis order (timing 60 min pre-incision), VTE prophylaxis, allergies, isolation, MLC, weight/height, pregnancy test where applicable, pre-op checklist by ward nurse (IP-003 template), bed hold for return/ICU → readiness score; blockers visible to surgeon/manager.
- **Send-for**: OT calls ward → transport task (IP-001) → patient location `ot_holding` → **Pre-op holding**: identity check (wristband scan), reconfirm checklist, pre-medication.

### 3.4 WHO Surgical Safety Checklist (hard-stopped, timestamped, attributed)
1. **Sign In** (before anaesthesia induction; anaesthetist + nurse + patient if able): identity/site/procedure/consent confirmed (wristband scan), site marked/NA, anaesthesia machine & medication check complete, pulse oximeter functioning, allergy known?, difficult airway/aspiration risk with equipment/assistance available, risk of > 500 mL blood loss (7 mL/kg children) with IV access/fluids/blood planned → each item Yes/No/NA; "No" on critical items blocks progression unless anaesthetist override with reason.
2. **Time Out** (before skin incision; whole team pause; scrub nurse leads/records): all members introduced by name & role, patient name/procedure/site verbally confirmed, anticipated critical events (surgeon: critical steps, duration, blood loss; anaesthetist: patient-specific concerns; nursing: sterility indicators confirmed, equipment issues), antibiotic prophylaxis given within last 60 min (auto-checked from MAR/IP-024 record), essential imaging displayed → **incision cannot be recorded until Time Out complete**; team attestation (badge tap/PIN of surgeon, anaesthetist, nurse).
3. **Sign Out** (before patient leaves OT): procedure name recorded, instrument/sponge/needle counts correct (from counts module), specimen labelled (patient name/ID, site — label print), equipment problems, key concerns for recovery/management by surgeon+anaesthetist+nurse → **transfer to PACU blocked until Sign Out done**.
4. Each phase stored with timestamps, participants, answers, overrides; compliance KPI (all three phases complete, on time); paper fallback scan for downtime with retrospective entry flagged.

### 3.5 Intra-op documentation
- **Timings** (OT record): patient in OT, anaesthesia start, incision, closure, anaesthesia end, patient out, PACU in/out — auto-durations (surgical time, anaesthesia time, turnover) feed utilisation & billing time slabs; delay reasons per gap.
- **Anaesthesia record** in IP-024 (vitals from monitors, drugs, airway, fluids, events); IP-006 shows link/summary.
- **Consumables & drugs**: scan every item (barcode/GTIN/internal) → auto-deduct OT store (NC-006/IP-014) → auto-post to bill (IP-005) with package awareness; kits/preference cards per surgeon-procedure pre-load expected items (confirm used/unused → returns); high-value items require confirmation; narcotics via IP-014.
- **Implants** (TR-003): scan UDI-DI/PI (GS1/HIBCC), lot/serial/expiry, manufacturer, size, side, site, quantity; consignment (NC-007) usage triggers vendor billing/replenishment; implant card printed for patient; recall traceability; explants recorded.
- **Counts** (`ot.instrument_count_barcode` optional): sponge/needle/instrument counts at baseline, before closure of cavity, at skin closure, final — by scrub + circulating (two-person), discrepancies → X-ray/protocol & incident; retained-item never-event workflow.
- **Specimens**: histopathology/frozen section/cultures/implants-for-analysis with label print (EN-013), OP-004 order created, chain of custody, frozen section result callback into OT (OP-004 critical channel).
- **Blood**: units issued/transfused (IP-007) recorded; cell saver volume; estimated blood loss.
- **Imaging**: C-arm shots count/dose (AERB log), intra-op images to PACS (EN-008).
- **Events/complications**: intra-op complications (bleeding, injury to adjacent structure, anaesthesia events, cardiac arrest → IP-013), conversions (lap→open), unplanned procedures, wrong-site prevention checks; incident auto-draft (NC-015).
- **Robotic/special** (`ot.robotic_docs`): console times, instrument usage, docking times.
- **Video/evidence** (`ot.video_evidence`, market): consent video (pre-op explanation & patient acknowledgement, recorded via tablet, stored tamper-evident with hash & retention), procedure video snippets/laparoscopy captures tagged to case (evidence section), access-controlled and audited; recording consent required.
- **Environment** (`ot.environment_monitoring`, EN-042): temp/humidity/pressure differential/air changes per theatre logged; out-of-range alerts to OT manager/biomedical.

### 3.6 Op notes & post-op orders
- **Operative note** (template per procedure EN-039; NABH: immediately after surgery, before patient leaves recovery — configurable ≤ 30 min): pre-/post-op diagnosis (ICD-10), procedure(s) with codes (ICD-9-CM/ICHI/CPT-like hospital codes), surgeon/assistants/anaesthetist, anaesthesia type, position, incision, findings, procedure detail, implants (auto-listed), specimens, EBL, fluids/blood, drains/tubes/packs (with removal plan), complications, counts status, closure, condition, post-op plan; dictation (AI-004 later); sign (EN-016/hash) → immutable version; addendum versions; copy to discharge summary (IP-002) & referring doctor.
- **Post-op orders** (OP-002 CPOE order set per procedure): analgesia, antibiotics (duration per SSI bundle), DVT prophylaxis, diet/NPO, IV fluids, monitoring frequency, position, drains care, physio, labs → nursing tasks (IP-003).
- **Brief op note** for wards when full note delayed (mandatory fields only), full note follows.

### 3.7 Recovery (PACU) & disposition
- **PACU record**: arrival vitals, airway, pain (NRS), PONV, temperature, block regression, drains, **Aldrete score** (activity, respiration, circulation, consciousness, O2 saturation; discharge ≥ 9) or **modified Aldrete/PADSS** for day-care, q15 min × 1 h then q30 min; complications; discharge criteria met → anaesthetist sign-off → destination ward/ICU/HDU/day-care discharge → hand-off (SBAR) to receiving nurse with wristband scan → IP-001 location update, bed hold consumed; PACU LOS & delayed discharge reasons.
- **Direct to ICU**: bypass PACU flag; ICU handover.

### 3.8 Turnover, cleaning, CSSD & closure
- Patient out → **turnover**: cleaning task (NC-018: between-case/terminal for infected cases IP-012), tray return to CSSD (EN-003 scan; used/unused sets), instrument decontamination, waste (BMW), theatre ready → next case; turnover time KPI vs SLA. Case `completed` → **charge composition** to IP-005 (`ot.case.completed` with timings/team/equipment/consumables/implants), surgeon payout basis (NC-034), OT register entry, SSI surveillance enrolment (IP-012: wound class clean/clean-contaminated/contaminated/dirty; ASA; duration; implant → 90-day follow-up).

### 3.9 Exceptions
1. Patient sent-for but not fit (BP high, NPO breach) → return to ward with reason; case rescheduled; KPI.
2. Time Out reveals wrong consent/side → stop, escalate to MS; incident.
3. Count discrepancy at Sign Out → recount, X-ray, surgeon decision documented; incident mandatory.
4. Implant not scanned (no barcode) → manual entry of UDI fields with photo of label; flagged.
5. Overrun → next case delay notifications; auto-suggest theatre swap.
6. Power/network outage → downtime paper WHO checklist & op note templates printed daily; retrospective entry flagged `downtime_entry`.
7. Death on table → IP-013/IP-017 flows, MLC checks (TR-008), MS notification, mortality review.

## 4. Data Model (schema `ot`)
- **ot.theatres** (id, hospital_id, branch_id, code, name, speciality_tags text[], features jsonb, sessions_template jsonb, turnover_sla_min, is_active); **ot.sessions** (theatre_id, date, start, end, block_owner (surgeon/department), status).
- **ot.requests** (id, hospital_id, branch_id, patient_id, admission_id?, requested_by, procedures jsonb [{code, name, side, site}], diagnosis_icd, urgency enum(elective/urgent/emergency), trauma_class?, preferred_date, est_duration_min, anaesthesia_type, needs jsonb, team_prefs jsonb, status enum(requested/scheduled/cancelled), created_at).
- **ot.cases** (id, hospital_id, branch_id, request_id, case_no (`OT_CASE` series), patient_id, admission_id, theatre_id, scheduled_start, scheduled_end, sequence, actual timings jsonb {in_ot, anaes_start, incision, closure, anaes_end, out_ot, pacu_in, pacu_out}, status enum(scheduled/sent_for/in_holding/in_ot/in_pacu/completed/cancelled/postponed), cancellation_reason, delay_reasons jsonb, primary_surgeon_id, team jsonb [{user_id, role}], anaesthesia_type, asa, wound_class enum(clean/clean_contaminated/contaminated/dirty), emergency bool, bumped_case_id?, package_id?, readiness jsonb, ssi_enrolled bool, version, audit) — index (hospital_id, theatre_id, scheduled_start), (hospital_id, status), (admission_id).
- **ot.checklists** (case_id, phase enum(sign_in/time_out/sign_out), items jsonb [{code, answer yes/no/na, note}], participants jsonb, started_at, completed_at, overrides jsonb, downtime_entry bool, sha256).
- **ot.readiness_items** (case_id, item enum(consent_surg/consent_anaes/consent_blood/pac/npo/investigations/blood/implants/trays/equipment/site_mark/antibiotic/vte/bed_hold/preop_checklist), status, ref_id, checked_by, at).
- **ot.consumables_used** (case_id, item_id, batch_id, qty, scanned bool, unit_cost, billed_line_id, returned bool); **ot.implants_used** (case_id, implant_registry_id (TR-003), udi_di, udi_pi, lot, serial, expiry, manufacturer, size, side, site, qty, consignment_id?, explant bool, billed_line_id).
- **ot.counts** (case_id, stage enum(baseline/cavity_closure/skin_closure/final), item_type enum(sponge/needle/instrument/other), expected, counted, correct bool, counted_by, verified_by, at, discrepancy_action).
- **ot.specimens** (case_id, type, description, site, container_label, lab_order_id, handed_to, at); **ot.blood_use** (case_id, unit_ids[], ebl_ml, cell_saver_ml); **ot.imaging_use** (case_id, c_arm_shots, dose_mgy, operator).
- **ot.events** (case_id, type, at, description, severity, incident_id?).
- **clinical.documents** type `operative_note|brief_op_note` (versioned, signed) with case_id.
- `ot.pacu_records` — **owned and defined by IP-024 (Anaesthesia Information System) §4; IP-006 does not create this table.** IP-006 reads it for the OT board and case-completion gate, and writes only `case_id` / `arrival_at` when a case leaves theatre (event `ot.case.in_pacu`). Canonical columns live in IP-024 (`aldrete_scores`, `pain`, `ponv`, `temp`, `block_regression`, `padss`, `complications`, `discharge_criteria_met`, `discharged_by`, `discharged_at`, `destination`, `pacu_los_min`, `bypass`). If IP-024 is not licensed, IP-006 ships the same table with the IP-024 column names via the shared `ot` schema migration — never a second, differently-shaped table.
- **ot.turnovers** (theatre_id, prev_case_id, next_case_id, cleaning_task_id, started_at, ready_at, type enum(between/terminal)).
- **ot.media** (case_id, kind enum(consent_video/procedure_video/image), file_id, sha256, recorded_by, consent_id, retention_until, access_log ref) — `ot.video_evidence`.
- **ot.environment_logs** (theatre_id, at, temp, humidity, pressure_pa, ach, source) — partitioned.
- **ot.preference_cards** (surgeon_id, procedure_code, items jsonb, trays jsonb, equipment jsonb, notes).
- Read models: `analytics.mv_ot_utilisation_daily`, `analytics.mv_ot_case_costs`, `analytics.mv_ot_checklist_compliance`, `analytics.ot_board` (Redis).

## 5. Business Rules & Validations
- Case cannot be `sent_for` unless critical readiness items complete: surgical & anaesthesia consents (EN-028), PAC signed (IP-024), NPO recorded, site mark (for laterality procedures), blood reserve if required, implants verified if required; manager override with reason (emergency).
- WHO phases sequential & hard-stopped: incision time cannot be saved without Time Out complete; PACU transfer blocked without Sign Out; antibiotic timing auto-verified (60 min; vancomycin 120 min) else prompt.
- Counts: two-person; final count must be "correct" or discrepancy workflow documented before Sign Out.
- Implants: UDI mandatory (manual with reason), lot/serial/expiry validated (expired blocked), TR-003 registry entry created, consignment usage posted.
- Op note ≤ 30 min post-op (configurable) — brief note acceptable interim; full note within 24 h; unsigned → surgeon reminders/HOD escalation; note immutable after sign, addenda versioned.
- Emergency override: bumping only elective cases not yet sent-for; reasons mandatory; audit; TR-004 class rules apply for trauma.
- Utilisation definitions: available session minutes vs used (in→out), first-case on-time (within 15 min), turnover ≤ SLA, cancellation on day of surgery (%), emergency-to-incision.
- Video/evidence: recording only with consent (or legal-necessity policy), tamper-evident hash, retention (default 3 y; MLC longer), access audited, no download without permission.
- SSI enrolment automatic for all cases with wound class recorded; ICN follow-up 30 d (90 d implants).
- Charges: time slabs from actual timings; team fees by grade; equipment per use; consumables/implants at scan; package rules; corrections via IP-005 reversals.
- Narcotics/anaesthetic drugs via IP-014 register; C-arm dose logged (AERB).
- Audit every checklist answer/override, count, implant, cancellation, bump.

## 6. API Surface (`/api/v1/ot`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | /theatres, /sessions | config | ot.config.manage | Y | cursor |
| POST | /requests | OT booking request | ot.request.create | Y | – |
| GET | /requests?status=&surgeon=&date= | request queue | ot.request.read | – | cursor |
| POST | /cases (from request) / PATCH /cases/{id}/schedule | schedule/reschedule (theatre, time, team, needs) | ot.case.schedule | Y | – |
| GET | /calendar?from=&to=&theatre= | calendar view | ot.case.read | – | – |
| POST | /cases/{id}/emergency-insert | insert with bump proposals | ot.case.emergency | Y | – |
| POST | /cases/{id}/cancel|postpone | with reason | ot.case.cancel | Y | – |
| GET/PATCH | /cases/{id}/readiness | readiness items | ot.readiness.update | Y | – |
| POST | /cases/{id}/send-for, /arrived-holding, /in-ot, /out-ot | status & timings | ot.case.update | Y | – |
| POST | /cases/{id}/checklist/{phase} | WHO phase submit (participants attest) | ot.checklist.record | Y | – |
| POST | /cases/{id}/timings | set timing events | ot.case.update | Y | – |
| POST | /cases/{id}/consumables (scan), /implants (scan), /counts, /specimens, /blood, /imaging, /events | intra-op records | ot.intraop.record | Y | – |
| POST | /cases/{id}/op-note (draft/sign/addendum) | operative note | ot.opnote.write / sign | Y | – |
| POST | /cases/{id}/post-op-orders | apply order set (OP-002) | opd.order.create | Y | – |
| GET | /cases/{id}/pacu | read PACU status for the OT board / case-completion gate (**write endpoints are IP-024's `/pacu*` with `ais.pacu.write` / `ais.pacu.discharge`; `ot.pacu.record|sign` is retained only as the fallback permission when IP-024 is not licensed**) | ot.pacu.read | – | – |
| POST | /cases/{id}/complete | close case → charges, SSI enrol | ot.case.complete | Y | – |
| POST | /theatres/{id}/turnover/start|ready | turnover | ot.turnover.update | Y | – |
| POST/GET | /cases/{id}/media (presign/upload/list) | video/evidence | ot.media.record / read | Y | cursor |
| GET | /board?theatre= | OT status board (staff) / family board (masked) | ot.board.read / ot.family_board.read | – | – |
| GET | /reports/utilisation, /reports/cancellations, /reports/checklist-compliance, /reports/cost-per-case | analytics | ot.report.read | – | – |
| GET/PUT | /preference-cards, /config/checklists, /config/charge-rules | config | ot.config.manage | Y | cursor |
| Consumes | `preauth.approved`, `blood.reserved|issued`, `cssd.tray.issued|returned`, `lab.result.available` (frozen), `implant.received` (NC-007), `ip.admitted`, `anaesthesia.pac.signed` (IP-024), `housekeeping.task.completed` | | | | |

## 7. Domain Events (outbox)
- `ot.request.created` → OT manager queue.
- `ot.case.scheduled|rescheduled|cancelled|bumped` {case_id, theatre, start, team, needs} → wards (IP-003 pre-op tasks), EN-003 (tray demand), NC-006 (pick list), IP-007 (reserve), IP-001 (bed hold), IP-005 (estimate/package), EN-018, EN-009 (family), NC-030.
- `ot.case.sent_for|in_holding|in_ot|incision|closure|out_ot|in_pacu|pacu_discharged` → boards, IP-001 location, family board.
- `ot.checklist.completed` {phase, overrides} / `ot.checklist.blocked` → quality.
- `ot.implant.used` {udi, serial, consignment} → TR-003, NC-007, IP-005; `ot.consumable.used` → NC-006, IP-005; `ot.count.discrepancy` → NC-015; `ot.specimen.sent` → OP-004; `ot.event.recorded` {severity}.
- `ot.opnote.signed` {document_id} → IP-002, PE-007, NC-003.
- `ot.case.completed` {timings, team, wound_class, asa, implants, consumables} → IP-005 (charges), NC-034, IP-012 (SSI enrol), TR-011, analytics.
- `ot.turnover.started|ready`, `ot.environment.out_of_range`, `ot.media.recorded`.
- `ot.utilisation.daily` (job) → EN-001.

## 8. Screens (UI)
- **OT Calendar** (desktop): theatre columns × time rows; drag/drop cases; colour by status/speciality; conflicts highlighted; side panel case details; `N` new, `E` emergency insert, `P` publish list, `Ctrl+Z` undo move; real-time.
- **Daily List / OT Board** (desktop + EN-018 TV in OT complex): per theatre sequence with live status chips (Scheduled → Sent for → Holding → In OT → PACU → Ward), timings, delays; family board variant (token/initials only).
- **Case Readiness** (desktop/tablet): checklist tiles with links to fix; blockers red; send-for button.
- **WHO Checklist** (OT wall PC/tablet; large touch): phase tabs; items with Yes/No/NA; participant attestation (badge tap/PIN); timer; hard-stop banners; downtime mode print.
- **Intra-op Console** (OT wall PC with scanner): timings buttons (big), consumables scan list with running cost (optional visibility), implants scan with UDI parse, counts grid, specimens & labels, blood/imaging, events; `F2` timing, `F3` scan mode, `F4` counts.
- **Op Note Editor** (desktop/tablet): template fields + rich text, auto-lists (implants, specimens, timings), dictation, sign; addendum.
- **PACU Board** (desktop/tablet): bays with Aldrete trend, pain/PONV, discharge readiness; sign-off dialog.
- **Turnover/CSSD panel**: cleaning status, trays in/out scan.
- **Utilisation Dashboard** (desktop): utilisation %, first-case on-time, turnover, cancellations by reason, emergency-to-incision, surgeon-wise volumes/duration variance, cost per case; drill-down.
- **Preference cards, config**.

## 9. Integrations
- IP-024 anaesthesia (shared case id), TR-003/NC-007 implants (UDI GS1 parser), NC-006/IP-014 stores, EN-003 CSSD (tray barcodes), IP-007 blood, OP-004 (frozen section/histopath), OP-008/EN-008 (intra-op images/C-arm), NC-002/NC-020 (equipment, C-arm AERB), NC-018 (cleaning), NC-030 (roster), IP-005 (charges), IP-012 (SSI), EN-018 (boards), EN-042 (environment sensors, OT integration systems), video capture (tablet/laparoscopy tower capture card via S3 upload), EN-016 e-sign, EN-013 labels.
- Fallbacks: scanner down → manual with reason; boards offline → last snapshot; video storage unavailable → local buffer & retry.

## 10. Reports & Analytics
- OT utilisation (theatre/session/surgeon), first-case start compliance, turnover time, cancellation rate & reasons (day-of-surgery), emergency-to-incision, WHO checklist compliance (phase completeness/on-time/overrides), count discrepancies, implant log & recall list, consumables cost per case & variance vs preference card, cost-per-surgery (consumables + implants + time + team), surgeon volumes/duration variance, PACU LOS & delayed discharge, unplanned returns to OT, intra-op complications, mortality within 48 h, SSI rate (with IP-012), antibiotic prophylaxis timing compliance, environment excursions, OT register (statutory).
- Read models in §4.

## 11. Notifications
- Team: case scheduled/changed/cancelled, send-for time, delays; surgeon: op-note pending, frozen section result, implant not scanned; ward: pre-op prep/NPO/send-for; CSSD/stores/blood bank: demand lists; family: planned time, "in OT/recovery/ward" (board/WhatsApp opt-in, no clinical details); manager: readiness blockers D-1, overrun, environment excursion; ICN: dirty/contaminated cases; billing: case completed.

## 12. Permissions (RBAC keys)
`ot.config.manage`, `ot.request.create|read`, `ot.case.read|schedule|emergency|cancel|update|complete`, `ot.readiness.update`, `ot.checklist.record`, `ot.intraop.record`, `ot.opnote.write|sign`, `ot.pacu.read` (PACU **writes** are `ais.pacu.write|discharge` in IP-024; `ot.pacu.record|sign` exists only as the fallback when IP-024 is unlicensed), `ot.turnover.update`, `ot.media.record|read|export`, `ot.board.read`, `ot.family_board.read`, `ot.report.read|export`.
Defaults: Surgeon (9): request.create, case.read, checklist.record, intraop.record, opnote.write/sign, media.record/read (own cases); Anaesthetist (10): checklist.record, pacu.sign, case.read; OT nurse (20): readiness.update, checklist.record, intraop.record, pacu.record, turnover.update, media.record; OT manager: schedule, emergency, cancel, complete, config, reports; Ward nurse (17): readiness.update (pre-op items), board.read; CSSD (38): board.read (tray demand); Billing (27): case.read; Quality (54): reports, checklist read; Family device: family_board.read; MS/HOD: reports, media.read.

## 13. Non-functional
- Volumes: 40 theatres, 150–200 cases/day, 6k consumable scans/day, 300 implants/day; calendar render < 500 ms; scan post < 150 ms; board update < 2 s.
- Reliability: intra-op console works on LAN with local queue if API unreachable ≤ 30 min (timings/scans/checklist answers), syncs in order; downtime paper kit printed daily.
- Video: chunked uploads, ≤ 2 GB/case default, encrypted at rest, hash chain, retention policy job.
- Printing: OT list, checklist (downtime), specimen labels (ZPL), implant card, op note PDF, PACU record.
- Accessibility: large touch targets in OT (gloved use), high contrast, audible timers; i18n.
- Security: participant attestation by PIN/badge; media access audited; TV boards masked; AERB dose logs retained.

## 14. Acceptance Criteria
1. Given a surgeon requests "Total knee replacement — left" for tomorrow with implants & 2 PRBC, when scheduled, then EN-003 tray demand, NC-007 implant pick list, IP-007 reserve request, IP-001 bed hold and ward pre-op tasks are created and the team notified.
2. Given the surgeon and anaesthetist are already booked in another theatre at the same time, then scheduling shows a conflict and requires resolution.
3. Given an emergency laparotomy request with all theatres busy, then the system proposes bump candidates (elective, not sent-for, lowest priority) and the bumped case is rescheduled with reason and notifications; audit records the override.
4. Given anaesthesia consent is missing, when send-for is attempted, then it is blocked; the OT manager override for emergency requires a reason.
5. Given Time Out is not completed, when the nurse taps "Incision", then it is refused with a hard-stop banner; after Time Out with three attestations, incision time saves.
6. Given cefazolin given at 08:10 and incision at 09:25, then Time Out flags "antibiotic > 60 min" and requires an action (re-dose/acknowledge).
7. Given final sponge count 9 vs expected 10, then Sign Out cannot complete until a discrepancy workflow (recount/X-ray/decision) is documented and an incident is created.
8. Given an implant scanned with GS1 UDI (01)…(17)expiry(10)lot(21)serial, then fields parse, an expired implant is blocked, TR-003 registry gets the entry, NC-007 consignment usage posts and IP-005 receives the implant line.
9. Given 12 consumables scanned and 2 marked unused, then OT store stock decreases by 10 and only 10 lines are billed.
10. Given the case is completed with timings in 09:00/out 11:30, then IP-005 receives OT time-slab charges of 150 min, team fees by grade and equipment lines; utilisation shows 150 min used.
11. Given a wound class "clean-contaminated" with implant, then IP-012 SSI enrolment is created with a 90-day follow-up.
12. Given Aldrete 7 at 30 min and 9 at 60 min, then PACU discharge is enabled only at 60 min and requires anaesthetist sign-off; ward handover with wristband scan updates IP-001 location.
13. Given the op note is unsigned 30 min after out-of-OT, then the surgeon is reminded; at 24 h HOD is escalated; a brief op note satisfies the interim requirement.
14. Given a consent video recorded with recording consent, then it is stored with sha256, listed in the case's evidence section, and any access is logged; download requires `ot.media.export`.
15. Given theatre humidity 72 % (limit 60 %), then an environment excursion alert reaches the OT manager and biomedical, and it appears in the excursion report.
16. Given a case cancelled on the day for "patient not NPO", then the cancellation KPI counts it, the ward is notified, trays and blood reserves are released.
17. Given a downtime paper checklist entered retrospectively, then the record is flagged `downtime_entry` and included in compliance with the flag visible.
18. Given the family board, then only token/initials and stage are displayed; no procedure names.

## 15. Enhancements / Later phases
- From VIMS sheet row 25: SSI surveillance (IP-012 hook here), implant recall & patient notification (TR-003), robot-assisted surgery documentation (flag), OT environment monitoring (flag), surgeon fatigue tracking (`ot.surgeon_fatigue`: consecutive hours from roster/case data → warning; later), cost-per-surgery analytics (here).
- (market) OT evidence capture: video consent, streamed & stored securely, patient-wise evidence, tamper-evident retention (here as `ot.video_evidence`); surgical notes with auto-duration, signature spaces on print, linked to IPD billing (here); PAC advice/scheduler/pre-intra-post op (here/IP-024); doctors' instrument charges posting (here).
- Later: AI OT scheduling optimisation & duration prediction (AI-005), RFID sponge counting, integrated OR (video routing), 3D planning links, block-time release automation, day-surgery pathway (OP-010), tele-mentoring streams (OP-018).

## 16. Open Questions for the Hospital
1. Number of theatres, session/block scheme, elective list publication time, emergency override authority?
2. Hospital additions to WHO checklist; attestation method (badge/PIN)?
3. Op-note templates per speciality; time limit policy; brief note allowed?
4. Implant vendors/consignment; barcode availability; implant card format?
5. Consumable billing approach (per-scan vs kits/packages) and preference cards existing?
6. Counts policy (which procedures require full instrument counts; barcode?).
7. PACU criteria (Aldrete threshold), day-care discharge scoring; direct-to-ICU rules?
8. Video consent/evidence: legal stance, retention, storage budget, who may view?
9. Environment sensors present (BMS)? AERB C-arm licence details and dose logging needs?
10. Charge composition (time slabs, team grades, equipment) and package handling for OT?
11. SSI surveillance follow-up process (who calls patients; 30/90 d)?
12. OT board privacy for family; WhatsApp status updates allowed?
