# OP-039 — OPD Nursing / Injection & Dressing Room / Nebulisation / Minor OT (Order execution worklist, Medication administration in OPD, Dressings & suture removal, Plaster room, Sample/IV support, Minor OT coordination, Consumables & billing)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-039 |
| Phase | 8 (worklist & injection/dressing execution needed from Phase 2 by OP-002; minor OT full flow Phase 8) |
| Priority | P1 |
| Complexity | Medium |
| Depends on | OP-002 (orders: injections, IV, nebulisation, dressings, ear syringing, catheterisation, ECG etc.), OP-007 (vitals room / nurse roles, pre-consult), OP-010 (procedure engine — OP-039 rooms are OP-010 `procedure_rooms` types injection_room/dressing/plaster/minor_ot; minor OT uses OP-010 record with checklist/consent/consumables), OP-005 (charge intents), OP-003 (drug issue to OPD sub-store, batch/expiry, high-alert drugs, narcotic register), NC-006/NC-008 (OPD sub-store consumables, kits, consumption), EN-013 (barcode: OP slip/wristband, drug batch scan), EN-029 (allergy, dose, IV compatibility, test-dose rules), EN-028 (procedure consent), EN-039 (nursing forms), EN-006 (injection room sub-queue/token, TV), OP-009/TR-005 (plaster room jobs from ortho), OP-017 (wound care dressing protocols), OP-016 (blocks in procedure room), OP-013 (vaccines executed by vaccination nurse — separate), OP-006 (observation/day-care beds for post-injection watch, anaphylaxis to ER), IP-013 (crash cart/anaphylaxis kit checks), OP-004 (sample collection support / IV cannula for contrast OP-008), EN-003 (CSSD sets for minor OT), NC-016 (sharps/BMW), NC-015 (incidents: needle-stick, reactions), NC-030 (nurse roster), EN-009, IP-003 (shared MAR component/5-rights) |
| Feature flag | `module.opd_nursing.enabled` (sub: `opdn.injection_room`, `opdn.dressing_room`, `opdn.plaster_room`, `opdn.minor_ot`, `opdn.observation_bay`) |
| Primary roles | Nurse — OPD (16), OPD nurse in-charge (22), Plaster technician (16/36 family), Minor OT nurse/scrub (20), Doctor performing minor procedures (6/9), Resident (14) |
| Secondary roles | Pharmacist (30, sub-store issue), Stores (44), Cashier/billing (26/27), CSSD (38), Housekeeping (50), Quality (54), Reception (24, tokens), Patient |
| Regulatory | NABH MOM (medication administration 5/7 rights, high-alert drugs, verbal orders policy), NABH COP (procedural sedation, anaphylaxis readiness), Nursing Council standards, BMW 2016 (sharps), NDPS (opioid injections register), Schedule H1 register, IV fluid/blood administration policies, Needle-stick injury PEP protocol (NACO), Consent for procedures, DPDP |

## 1. Purpose
OP-039 is the execution console for OPD nursing orders (market gap: most HMS stop at the doctor's order): a **unified worklist** of injections/IM/IV/SC, IV fluids/infusions, nebulisation, dressings & wound care, suture/staple removal, plaster application/removal (with OP-009/TR-005), catheterisation, ear syringing, ECG/nebuliser device tasks, sample/IV support, minor OT prep and turnover — with **5-rights medication administration** (barcode-verified drug/batch/patient, allergy & test-dose checks, dual verification for high-alert), post-administration observation & reaction handling (anaphylaxis pathway), consumables/kits auto-charging (charge intents to OP-005), room/token sub-queues (EN-006), sub-store stock, sterile-set tracking (EN-003), documentation printed/attached to the visit, and minor OT coordination (via OP-010) with checklists, consent, time-out, sedation observation and discharge criteria. IP MAR is IP-003; OP-039 is OP-only.

## 2. Users & Jobs-to-be-done
- **OPD nurse** (tablet/desktop in injection/dressing room; 150–400 tasks/day/room): see queue, verify patient & order, prepare drug (batch scan), administer/document, watch reactions, dress wounds with photos, remove sutures, nebulise, cannulate, bill consumables, close task.
- **Plaster technician**: plaster room jobs (apply/check/remove/bivalve/window) with materials & instructions (from OP-009).
- **Minor OT nurse**: pre-op checklist, consent, set (CSSD tray) readiness, time-out with doctor, count, consumables/implants scan, recovery observations, room turnover.
- **Doctor**: order from OP-002 → performs minor OT/procedure documented in OP-010; sees execution status/complications on timeline.
- **In-charge**: room load, staffing, stock/expiry, incident follow-up, KPIs.
- **Patient**: token/queue status, instructions (post-injection wait 30 min, dressing follow-up), consent.

## 3. Core Workflows
### 3.1 Order → worklist → token
1. Doctor orders (OP-002: drug + dose + route + frequency (STAT/once/course e.g. injection ×5 days), nebulisation (drug/dose/duration), IV fluid (type/volume/rate), dressing (type/site/frequency), suture removal (date), plaster job (from OP-009), minor procedure (OP-010 order)) → billing rule: pre-paid (cash) → payment (OP-005) → task **released** to worklist; credit/insurance → released with pre-auth check → **task** appears in the room's worklist (EN-006 sub-queue "Injection room" with token; TV display) → SMS "proceed to Injection Room 2".
2. Multi-day courses (e.g. IM ceftriaxone ×5) → daily tasks generated with day n/N; patient returns with OP slip QR; missed days flagged.
### 3.2 Medication administration in OPD (5/7 rights)
1. Nurse selects task → **patient identity** (scan OP slip QR/wristband or 2 identifiers) → **allergy banner** (red) & EN-029 checks (allergy, dose range/adult max, route, interaction with today's other injections, IV compatibility, test-dose requirement e.g. certain antibiotics per hospital policy, contrast, sedation) → drug issued from OPD sub-store: **scan batch barcode** (EN-013 → batch/expiry validation, high-alert flag e.g. insulin/KCl/heparin/opioids/chemo → **second nurse verification** PIN/scan) → prepare (diluent/volume) → administer (site for IM/SC with body-map, IV cannula gauge/site, infusion start rate/pump) → document time, batch, site, dose given, given-by (+ verifier) → **observation** timer (e.g. 15–30 min post first-dose antibiotic/biologic; vitals at end) → discharge from room / next-day slot → charge intent (drug if not already billed + administration fee + consumables) → `opdn.med.administered`.
2. Reactions: anaphylaxis quick-action (adrenaline IM 0.5 mg auto-suggest by weight, call ER, oxygen, crash cart IP-013), incident (NC-015), allergy record update (patient master), pharmacovigilance ADR form (OP-003 PvPI).
3. Nebulisation: device/mask, drug/dose, duration timer, SpO2 pre/post (device link OP-007), reuse/cleaning log; oxygen therapy log.
4. IV therapy: cannulation record (site, gauge, attempts, date/time; VIP score), fluid/infusion chart (start/stop/volume infused), medication via IV push/infusion, removal & site condition; long infusion → observation bay (`opdn.observation_bay` beds/recliners with basic charting; > 4 h → suggest day-care OP-006).
### 3.3 Dressing room & suture removal
- Task shows wound details from OP-017/OP-002 (site, type, protocol) → nurse documents dressing: wound assessment quick fields (size, exudate, infection signs → alert doctor), cleaning solution, dressing materials (barcode/kit e.g. "dressing kit small/medium/large" or itemised), photo (OP-022; consent), pain score, next dressing date/frequency (auto-create tasks) → suture/staple removal (count removed/retained, wound status) → charge intent (dressing fee tier + materials); complex/chronic wounds → OP-017 referral; burns dressing protocol; abscess dressing after I&D.
### 3.4 Plaster room (`opdn.plaster_room`, with OP-009/TR-005)
- Jobs: apply cast/slab (type, material POP/fibreglass, limb/side, padding), check (neurovascular status, tightness → bivalve), remove/window (saw safety), reinforce; materials scanned; instructions & cast-care leaflet (OP-038); complications (pressure, tightness → doctor alert); TR-005 record updated.
### 3.5 Minor OT (`opdn.minor_ot`, via OP-010)
- Board: today's minor procedures (I&D, excision biopsy, FB removal, suturing, circumcision, hydrocele, ingrown nail, cyst, chalazion, dental OMFS minor, ENT minor…) with readiness (consent, payment/pre-auth, NPO if sedation, investigations, sterile set from CSSD scanned EN-003, kit/consumables staged, doctor present) → time-out (OP-010) → procedure by doctor (OP-010 record) with nurse role: counts (if applicable), specimen labelling → OP-004, consumables & implants scan (TR-003 for implants), LA/sedation observation (IP-024 if anaesthetist), **recovery** (Aldrete/observations, discharge criteria, escort, instructions) → room turnover (housekeeping NC-018, set return to CSSD, sharps/BMW) → charges.
### 3.6 Sub-store, stock & sets
- OPD sub-store (NC-006 location): indent from main pharmacy/stores, receipt, batch/expiry, par levels & auto-indent, consumption on task close (NC-008 to cost centre), narcotics/H1 registers for injections (OP-003 rules; two-person for opioids), emergency drug tray & crash cart checklist (IP-013 daily), refrigerator temperature log (insulin/vaccines/biologics; EN-042 sensor optional), sterile set/tray tracking (EN-003 barcodes, expiry of sterilisation), device checks (nebulisers, pumps, ECG) via NC-020.
### 3.7 Exceptions
- Payment pending → task held with "awaiting payment" (cashier alert); drug out of stock → substitute per pharmacist/doctor approval, or patient purchase outside (document); patient leaves before observation end → LAMA-style note; needle-stick → NC-015 + PEP protocol task; verbal order (emergency only) → read-back & doctor countersign within X hours; offline: worklist cached, administration documentation queued (barcode validation uses cached batch data with sync check).

## 4. Data Model (schema `clinical` / `pharmacy` where noted)
- **opd_nursing_tasks**: id, hospital_id, branch_id, patient_id, encounter_id, order_id (OP-002 order / OP-010 procedure order / TR-005 job), type enum(injection/iv_fluid/infusion/nebulisation/oxygen/dressing/suture_removal/plaster_apply/plaster_check/plaster_remove/catheter/ear_syringing/ecg/cannulation/sample_support/minor_ot_prep/observation/other), room_type, room_id?, day_no smallint, day_total smallint, scheduled_at, token_no?, priority enum(routine/urgent/stat), status enum(ordered/awaiting_payment/released/queued/in_progress/observation/completed/missed/cancelled/held), hold_reason, assigned_nurse_id?, started_at, completed_at, charge_intent_ids uuid[], notes; index (hospital_id, branch_id, room_type, status, scheduled_at), (patient_id, status), (order_id).
- **opd_med_administrations**: id, task_id, patient_id, encounter_id, drug_id, ordered_dose, given_dose, unit, route enum(im/iv_push/iv_infusion/sc/id/inhalation/topical/other), site (body-map code), batch_id, batch_no, expiry, barcode_verified bool, identity_method enum(qr/wristband/two_identifiers), high_alert bool, verifier_id?, test_dose jsonb?, diluent, volume_ml, rate?, started_at, ended_at, given_by, allergy_checked bool, cdss_overrides jsonb, observation_until, observation_outcome enum(uneventful/reaction/left_early), reaction jsonb?, adr_form_id?; index (patient_id, started_at desc), (batch_id).
- **opd_iv_lines**: id, patient_id, encounter_id, inserted_at, site, gauge, attempts, by, removed_at, vip_score_last, complications; **opd_infusion_log**: line_id, fluid/drug, volume_ml, rate, start/stop, infused_ml, by.
- **opd_dressings**: id, task_id, patient_id, wound_ref (OP-017 wound_id?), site, assessment jsonb (size, exudate, infection_signs, pain), materials jsonb ([{item_id, batch?, qty}]), kit_id?, photos uuid[], next_due_at, frequency, sutures_removed int?, sutures_retained int?, by, at; index (patient_id, at desc).
- **opd_plaster_jobs** (mirror/extension of TR-005 cast_events): task_id, cast_event_id, materials jsonb, nv_check jsonb, complications, by, at.
- **opd_nebulisations**: task_id, drug, dose, device_id, duration_min, spo2_pre, spo2_post, by, at.
- **opd_observation_stays**: id, patient_id, encounter_id, bay_id/recliner, from, to, vitals jsonb[], outcome, escalated_to_daycare bool.
- **opd_rooms** (reuse OP-010 `procedure_rooms` with types injection_room/dressing/plaster/minor_ot/observation_bay/nebulisation) & **opd_room_shifts**: room_id, date, shift, nurse_ids, open bool.
- **opd_substore_stock** (view over NC-006 location) & **opd_registers**: type enum(narcotic/h1/emergency_tray/fridge_temp/crash_cart/needle_stick), entries jsonb, by, at.
- **opd_minor_ot_board** (view over OP-010 bookings with readiness) & **opd_recovery_records** (OP-010 `procedure_recovery` reuse).
- Enums: `opdn_task_type`, `opdn_task_status`, `admin_route`, `identity_method`, `observation_outcome`.

## 5. Business Rules & Validations
- Task release requires payment/credit approval per billing policy (config: STAT injections may bypass with post-billing flag); tasks expire if not executed within order validity (e.g. STAT 2 h, routine same day/course days) → missed with reason.
- Identity verification mandatory (QR/wristband or two identifiers) before administration; allergy banner acknowledgement; EN-029 hard-stops (documented allergy to drug class → block unless doctor override recorded); high-alert list (hospital config; default ISMP-style: insulin, heparin, KCl/concentrated electrolytes, opioids, neuromuscular blockers, chemo, oxytocin, magnesium) → second-person verification (PIN/scan) mandatory; barcode batch scan mandatory when barcode exists (manual entry requires reason); expired batch → hard-stop; test-dose rules per drug policy; dose given ≠ ordered → reason + doctor notify.
- Post-administration observation minimum per drug class (config: 30 min for first-dose parenteral antibiotics/biologics/vaccines analog; 15 min others); leaving early documented; reaction → NC-015 + allergy master update + ADR (PvPI) form task.
- Narcotic injections: two-person, register entry, ampoule wastage witnessed; H1 register auto from administrations.
- Dressings: photo requires consent flag; infection signs → doctor alert & possible OP-017; suture removal count must reconcile with insertion record if available; materials billed via kit or itemised per policy; next-due auto-tasks.
- Plaster: neurovascular check documented for apply/check; complaint of tightness → urgent doctor task; saw safety checklist for removal.
- Minor OT readiness gate: consent, payment/pre-auth, sterile set scanned & within sterility expiry (EN-003), NPO if sedation, doctor identified; time-out via OP-010; recovery discharge criteria (Aldrete ≥ 9 or equivalent) before release; escort for sedated patients.
- Sub-store: FEFO issue, par-level auto-indent, fridge temp out of range (2–8 °C) → alert & quarantine, crash cart daily checklist (IP-013), sharps container tracking (BMW).
- Documentation immutable after completion; corrections via addendum; retention clinical; charge intents voided when task cancelled before execution.

## 6. API Surface (`/api/v1/opd-nursing`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /tasks?room_type=&status=&date= | worklist | opdn.task.read | – | cursor |
| POST | /tasks (from orders — internal), PATCH /tasks/{id}/assign|start|hold|cancel|complete | lifecycle | opdn.task.execute | Y | – |
| POST | /tasks/{id}/verify-identity, /verify-drug (scan payload) | verification | opdn.med.administer | Y | – |
| POST | /tasks/{id}/administrations, PATCH /administrations/{id}/observation|reaction | med admin | opdn.med.administer / opdn.med.verify (2nd) | Y | – |
| POST | /tasks/{id}/dressing, /nebulisation, /plaster, /iv-lines, /infusions | documentation | opdn.dressing.record / opdn.neb.record / opdn.plaster.record / opdn.iv.record | Y | – |
| POST/GET | /observation-stays | observation bay | opdn.observation.manage | Y | cursor |
| GET | /minor-ot/board?date= | readiness board (OP-010) | opdn.minor_ot.read | – | – |
| POST/GET | /registers/{type} | narcotic/H1/fridge/crash-cart | opdn.register.record/read | Y | cursor |
| GET | /substore/stock, POST /substore/indent | stock/indent (NC-006 proxy) | opdn.stock.read / opdn.stock.indent | Y | cursor |
| GET | /rooms, PUT /rooms/{id}/shift | room staffing | opdn.room.manage | Y | – |
| GET | /reports/kpis | KPIs | opdn.report.read | – | – |

## 7. Domain Events (outbox)
- `opdn.task.created|released|queued|started|completed|missed|held|cancelled` (→ EN-006 queue, OP-002 timeline, OP-005 charge intents), `opdn.med.administered` {drug, batch, high_alert, verifier}, `opdn.med.reaction` (→ NC-015, patient allergy update, OP-003 ADR), `opdn.dressing.recorded` (→ OP-017), `opdn.wound.infection_signs`, `opdn.plaster.complication` (→ OP-009 doctor), `opdn.iv.inserted|removed`, `opdn.observation.escalated` (→ OP-006), `opdn.stock.low|expired|fridge_alarm`, `opdn.needle_stick` (→ NC-015/PEP), `opdn.minor_ot.ready|not_ready`.
- Consumes: `order.procedure.created`/`order.injection.created` (OP-002), `bill.paid` (release), `preauth.approved`, `cast.job.created` (TR-005), `procedure.booked|completed` (OP-010), `cssd.set.issued`, `queue.called`, `pharmacy.issue.completed` (sub-store), `device.reading` (fridge sensor EN-042).

## 8. Screens (UI)
1. **Room worklist** (tablet/desktop; large tiles): tokens with type icons, day n/N, payment chip, allergy red dot, timers (observation), filters; `Enter` open, `Space` call next (EN-006), `Ctrl+F` find token.
2. **Administration wizard** (tablet): step 1 identity scan → 2 order & allergy/CDSS banner → 3 drug batch scan (camera/scanner) with expiry check → 4 second-nurse PIN if high-alert → 5 site body-map & details → 6 start observation timer → 7 complete & print slip; big buttons, offline-tolerant.
3. **Dressing/wound form** (tablet): protocol from wound clinic, materials picker/kit scan, photo capture, next-due picker, suture counter.
4. **Plaster room job card** (tablet), **Nebulisation panel** with SpO2 device read.
5. **Observation bay board** (desktop/TV): recliners with timers/vitals, escalation button.
6. **Minor OT board** (desktop/TV): cases with readiness traffic lights, set scan, time-out status, recovery timers.
7. **In-charge dashboard** (desktop dark): room loads, wait times, tasks missed, stock/expiry, registers due (crash cart/fridge), incidents.
8. **Sub-store screen** (desktop): stock by batch, indent, FEFO issue, register entries.
- Empty/error: scanner failure → manual with reason; payment pending banner with "notify cashier".

## 9. Integrations
- EN-006 tokens/TV, EN-013 barcode (OP slip QR, drug 2D GS1 barcodes with batch/expiry parsing, wristbands), OP-003 sub-store & registers, NC-006/NC-008 stock & consumption, EN-003 sets, OP-010 procedure engine (minor OT, recovery, media), TR-005 plaster, OP-017 wounds, OP-007 device vitals (SpO2/BP), EN-042 fridge sensors/pumps, IP-013 crash cart, NC-015 incidents, OP-005 charge intents, EN-009 patient messages, NC-018 room turnover, NC-030 roster.

## 10. Reports & Analytics
- Tasks by type/room, TAT (order→execute, wait in queue), missed/held reasons (payment), administrations with barcode compliance %, high-alert dual-verification compliance %, reactions/anaphylaxis events, needle-stick incidents, dressing volumes & materials cost, plaster jobs, IV cannula dwell/complications, observation bay utilisation & escalations, minor OT readiness delays & turnover time, sub-store consumption/expiry/wastage, register compliance (crash cart/fridge), revenue from nursing services & consumables (leakage vs orders). Read models `analytics.opd_nursing_daily`, `analytics.med_admin_safety`.

## 11. Notifications
- Patient: token/room call, wait/observation instructions, next-day injection reminders (course), dressing follow-up date, post-minor-OT instructions. Staff: STAT task, awaiting payment > 15 min (cashier), high-alert verification request (second nurse), reaction alert (doctor/ER), fridge alarm, expiry/low stock, crash-cart checklist due, minor OT not ready 30 min before, missed course doses (doctor).

## 12. Permissions (RBAC keys)
`opdn.task.read|execute`, `opdn.med.administer|verify|override_document`, `opdn.dressing.record`, `opdn.neb.record`, `opdn.plaster.record`, `opdn.iv.record`, `opdn.observation.manage`, `opdn.minor_ot.read|prepare`, `opdn.register.record|read`, `opdn.stock.read|indent|issue`, `opdn.room.manage`, `opdn.report.read`, `opdn.configure`. Defaults: OPD nurse — task.execute, med.administer/verify, dressing/neb/iv/observation, register.record, stock.read/indent; Plaster tech — plaster.record, task.execute (plaster); Minor OT nurse — minor_ot.prepare, register (sets), med.administer; In-charge — + room.manage, report, stock.issue; Doctor — task.read, override documentation; Pharmacist — stock.issue; Cashier — task.read (payment holds).

## 13. Non-functional
- Volumes: 1 500 nursing tasks/day enterprise (600 injections, 300 dressings, 150 nebulisations, 100 plaster, 60 minor OT), peak 200 tasks/hour; worklist real-time (socket) < 1 s; barcode verify p95 < 200 ms (cached batch index); administration doc save < 300 ms; offline: worklist & batch cache with sync guard (no administration completion offline for high-alert unless emergency mode). Print: administration slip, dressing follow-up card, cast-care leaflet, minor OT discharge instructions (regional). Accessibility: large targets, colour-blind-safe status; i18n.

## 14. Acceptance Criteria
1. Given a doctor orders IM ceftriaxone 1 g STAT (cash patient), then the task appears "awaiting payment"; on receipt it releases with a token to the injection room queue and the TV/SMS call the token.
2. Given the nurse scans a batch expiring yesterday, then hard-stop; scanning a valid batch records batch/expiry with barcode_verified=true.
3. Given the patient has a documented penicillin allergy and the order is amoxicillin-clavulanate IV, then a hard-stop appears; only a doctor override recorded in the order allows continuation, and it is audited.
4. Given an insulin injection (high-alert), then completion requires a second nurse PIN/scan; without it the task cannot complete.
5. Given first-dose IV antibiotic administered, then a 30-minute observation timer starts; completing before timer end requires "left early" documentation; a reaction entry triggers ER alert, NC-015 incident and allergy master update prompt.
6. Given a 5-day IM course, then five daily tasks exist (day n/5); a missed day flags the doctor and the patient gets a reminder.
7. Given a dressing documented with infection signs, then the treating doctor is alerted and OP-017 referral suggested; materials via "medium dressing kit" post a single charge intent per policy.
8. Given a plaster check with tight cast reported, then an urgent doctor task is raised and TR-005 record updated.
9. Given a minor OT case without a scanned sterile set (EN-003) 30 min before slot, then readiness shows red and the in-charge is notified; with set scanned within sterility expiry, consent and payment, it turns green.
10. Given a sedated minor OT patient with Aldrete 7, then discharge from recovery is blocked until ≥ 9 (config) and escort recorded.
11. Given fridge sensor reads 10 °C for 15 min, then alarm to in-charge and stock in that fridge is flagged quarantine until reviewed.
12. Given a cashier user, then they can view awaiting-payment tasks but cannot execute (403 audited).
13. Given a task cancelled by the doctor before execution, then charge intents are voided and the token removed from the queue.

## 15. Enhancements / Later phases
- New module (M): market-gap execution layer requested by OP-002/OP-005/OP-009/OP-017 specs. Later: smart infusion pump integration & drug library (EN-042), RFID consumable cabinets, automated dispensing cabinet in OPD, wound photo AI (AI-007), patient self-check-in for injection courses via kiosk (EN-034), nurse-led clinics (immunisation OP-013, dressing clinics), home-nursing tasks (NC-024).

## 16. Open Questions for the Hospital
1. Rooms & staffing per branch (injection/dressing/plaster/minor OT/observation bay); operating hours?
2. Billing policy: pre-pay before injections/dressings? Kit vs itemised consumables? Administration fees?
3. High-alert drug list, dual-verification method (PIN vs scan), observation times, test-dose policy?
4. Sub-store model (pharmacy-managed vs nursing-managed), narcotics in OPD?
5. Barcodes on drug packs (GS1 2D availability) and wristband/OP-slip QR practice?
6. Minor OT: which procedures, sedation practice, CSSD set tracking readiness?
