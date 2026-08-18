# TR-005 — Cast & Splint Tracking (application log, materials, removal schedule, follow-up X-ray, complication watch, billing)

| Field | Value |
|---|---|
| Domain | Trauma & Orthopaedics |
| Module ID | TR-005 |
| Phase | 6 |
| Priority | P1 |
| Complexity | Medium |
| Depends on | OP-009 (Ortho OPD console — primary requester and viewer; follow-up protocol engine), TR-002 (fracture registry — every immobilisation links to a fracture/episode; timeline events), OP-006 (ER splints/backslabs), IP-003/IP-006 (ward/OT casts, post-op immobilisation), OP-039 (OPD nursing/plaster room queue), EN-006 (plaster-room token queue), NC-006/NC-008 (plaster/fibreglass stock & consumption), OP-005/IP-005 (charges), OP-008/EN-008 (check X-ray after cast/removal), OP-015/TR-010 (rehab after removal), OP-017 (skin/wound under cast), EN-009 (patient cast-care & appointment SMS), PE-001/OP-020 (cast card in portal), EN-013 (cast label/QR), EN-039 (forms), NC-015 (incidents), EN-024 |
| Feature flag | `module.cast_tracking.enabled` (sub: `cast.plaster_room_queue`, `cast.brace_inventory`, `cast.photo_documentation`) |
| Primary roles | Plaster technician / OPD ortho nurse (16, plaster room), Orthopaedic surgeon/consultant (6/9), Resident (14), ER nurse/doctor (19/8, backslabs) |
| Secondary roles | Ward nurse (17, cast checks), Physiotherapist (40, post-removal), Receptionist (24, follow-up booking), Billing (27), Stores (44, materials), Quality (54, complication rate), Patient/attendant (59/60, cast care), Auditor (58) |
| Regulatory | NABH 5th ed. COP (procedure documentation, patient education, complication monitoring), safe-site/laterality (wrong-limb prevention), consent for manipulation under sedation (EN-028), AERB (justified check X-rays), BMW 2016 (plaster waste), consumer/medico-legal record retention (≥ 10 y; permanent for MLC), DPDP; clinical standards: BOA/BOAST casting standards, compartment-syndrome recognition (5 Ps), pressure-sore prevention, cast-index for paediatric forearm fractures |

## 1. Purpose
TR-005 tracks every immobilisation device — plaster of Paris and fibreglass casts, backslabs, splints, braces, collars, traction — from prescription through application (who/what/how/materials), scheduled checks and changes, complication watch (compartment syndrome, pressure sores, tight/loose/wet/broken casts), planned removal with follow-up X-ray, and billing/consumption. It gives the plaster room its own queue and worklist, gives surgeons and wards a live "who is in what and until when" view, prevents forgotten casts and wrong-limb application, and educates patients with cast-care instructions and red-flag advice on their phone.

## 2. Users & Jobs-to-be-done
- **Plaster technician / OPD ortho nurse** (plaster room desktop + tablet; 80–150 jobs/day in a trauma-ortho centre): work the queue in order, confirm limb/side, apply per prescription, log materials (auto-charge/consume), print cast label/QR, schedule check/removal, teach cast care; log removals with saw safety and skin check.
- **Orthopaedic surgeon/resident** (OPD desktop, ER/ward tablet): prescribe immobilisation in one click from the fracture plan (type, limb, position, duration, weight-bearing), review post-cast X-ray/cast index, order change/wedge/removal, manage complications.
- **ER doctor/nurse** (tablet): apply backslab/splint after reduction, log with time and neurovascular status, hand over to ortho follow-up.
- **Ward nurse** (tablet/phone): perform scheduled cast checks (neurovascular obs, 5 Ps) after fresh casts (q1h × 4, then q4h), record findings, escalate red flags.
- **Physiotherapist**: see removal date to plan mobilisation; receive removal event.
- **Patient/attendant** (phone): cast-care instructions, red-flag symptoms, next visit/removal date, "my cast" card.
- **Stores/billing**: material consumption by job, charges by cast type, brace inventory.

## 3. Core Workflows

### 3.1 Prescription / immobilisation request
1. **Doctor** (from TR-002 fracture plan, OP-009 plan panel, ER treatment, or OT post-op orders) creates **immobilisation request**: device type (POP cast / fibreglass cast / backslab / U-slab / sugar-tong / thumb spica / cylinder / hip spica / Minerva / collar (soft/Philadelphia/Aspen) / brace (functional/CTLSO/knee) / splint (Zimmer, volar, dynamic) / skin or skeletal traction / sling / other), **limb & side** (mandatory for paired), region (above/below elbow, above/below knee, etc.), joint positions/angles, padding instructions, weight-bearing (from TR-002 plan), planned duration (weeks) → planned removal date, checks schedule (fresh circumferential cast → 24–48 h check), follow-up X-ray needed post-application (Y/N + views), sedation/manipulation needed (→ consent EN-028, OP-010 procedure), priority (ER now / today / scheduled), notes → **System** creates request (`cast_requests`) → queue token in plaster room (EN-006 sub-queue) → Event `cast.requested`.
2. Validation: fracture/episode linkage required (or "non-fracture" reason e.g. sprain/tendon/post-op); side must match fracture side (hard-stop); duplicate active device on same limb → prompt (change vs new).

### 3.2 Application (plaster room / ER / ward / OT)
1. **Technician** calls next token (`N`) → verifies patient (wristband/UHID scan or 2 identifiers) and **limb/side** against request; marks site check → applies → logs: device applied (as requested or deviation with reason), materials (item + qty from NC-006: POP rolls, fibreglass rolls by size, stockinette, padding, wool, splint metal, felt; auto-consume via NC-008 and auto-charge to OP-005/IP-005 by cast tariff + optional material itemisation), technique notes, applied_by/assisted_by, start/end time, **neurovascular status** post-application (cap refill, sensation, movement, pulses, pain NRS), photo (optional; `cast.photo_documentation`), cast **label/QR** printed (EN-013: patient, limb, applied date, planned removal, hotline) → **cast card** to patient (print/WhatsApp: care instructions in local language, red flags, removal date) → **System** creates active `cast_events` row (`applied`), schedules **checks** (per protocol) and **removal/review** appointment (OP-001 slot or OP-009 protocol step), notifies TR-002 timeline → Event `cast.applied`.
2. Post-application **check X-ray** if ordered: order pre-filled to OP-008 with views; result/link appears in job; doctor reviews alignment (TR-002 findings) and **cast index** for paediatric forearm (sagittal/coronal ratio ≥ 0.8 flag) → accept / re-manipulate / change to surgical plan.
3. Exceptions: patient refuses / cannot tolerate → documented, doctor informed; wrong-side scan → hard-stop; material stock-out → substitute logged; offline (ER/ward tablet) → job captured locally, synced.

### 3.3 Checks, changes & complication watch
1. **Scheduled checks** (ward nurse / OPD): task list from `cast_checks`: neurovascular (5 Ps: pain out of proportion, pallor, paraesthesia, paralysis, pulselessness) + swelling, cast integrity (tight/loose/wet/soft/cracked/soiled), skin at edges, odour, temperature; **red-flag** answers → immediate doctor alert (EN-037) + suggested action (split/bivalve cast, elevate, urgent review; compartment syndrome pathway with pressure measurement note) → incident (NC-015) if harm.
2. **Changes**: cast change/re-application (swelling reduced, wet/broken), wedging (angle & side), window cut (wound care with OP-017), conversion (backslab → full cast at day 3–7; cast → brace), extension of duration (doctor order with reason; new planned removal date), early removal.
3. **Complications** log: compartment syndrome (time to fasciotomy → TR-004), pressure sore (stage, site), skin maceration/dermatitis, thermal burn (from setting), cast saw injury, tight cast requiring split, loss of reduction (→ TR-002 event), joint stiffness, DVT under cast, non-attendance/lost cast → each with date, severity, management, outcome; recorded to `cast_complications` and mirrored to TR-002 complications where relevant.

### 3.4 Removal & follow-through
1. On due date (or doctor order): technician removes (saw safety checklist, skin inspection, photo), records skin condition, limb status, patient given post-removal advice; **removal X-ray** if ordered (union check via TR-002 findings); physio referral trigger (OP-015/TR-010) with ROM/strengthening plan; brace fitting if step-down (`cast.brace_inventory` item issued, size, charge) → Event `cast.removed`.
2. **Overdue removals**: planned date + 7 days without removal or extension → surgeon worklist + patient SMS; +14 days → HOD escalation; +21 days → recall (PE-002) & flagged "possibly lost to follow-up".
3. Patient no-show for change/removal → reschedule prompt + SMS; ER visits for cast problems (out-of-hours) → ER doctor logs event against the same cast (visible history) with plaster-room follow-up next morning.

### 3.5 Plaster room operations
- Queue board (EN-006 tokens: ER-priority first, then post-reduction, then scheduled), room/bench assignment, technician workload, materials stock level with reorder (NC-006 min/max), daily consumption vs charges reconciliation, cast tariff by type/size (RC-003), MCI mode (bulk splinting log by tag ID).
- Daily close: technician reconciles jobs vs consumption vs charges; unbilled jobs list to billing (RC-006 leakage rule); stock count of rolls by size.

### 3.6 Traction & external fixator pin-site care
1. **Skin/skeletal traction** (ward): request specifies type (Buck's/skin, skeletal via Steinmann/Denham pin, Thomas splint, Gallows for paeds), weight (kg), limb/side, pin site; nurse tasks: weight check & alignment q shift, skin/pin-site inspection, neurovascular obs; weight changes only by doctor order; traction removed → event; all under `cast_events` with device_type `traction`.
2. **External fixator pin-site care** (post-op, with TR-002/TR-004): pin-site protocol (cleaning frequency, solution), infection grading (Checketts-Otterburn 0–6), loosening, pin exchange, frame adjustments (Ilizarov/Taylor Spatial schedule uploaded as daily strut adjustments with patient app reminders) → complications mirror to TR-002.

### 3.7 Braces, orthoses & step-down devices
- Fitting record (item, size, side, joint angles/locking range e.g. hinged knee brace 0–90°), instruction given, wear schedule, review date; issue from stock (`brace_stock`/NC-006) or vendor consignment (NC-007) with charge; external purchase advised → prescription print; PE-001 shows wear schedule; brace-related skin complications logged like casts.

### 3.8 Exceptions & edge cases
1. **Cast applied elsewhere** (referred patient arrives with cast): record as `external_applied` event with estimated date/type; check protocol starts; removal/change planned locally.
2. **Patient removes/loses cast at home**: `lost` status via ER/OPD visit; re-application job; complication `lost_cast` for KPI.
3. **Wet/soft cast within 24 h of application** (hospital fault suspected): re-application marked `no_charge_reason=quality`; quality report counts.
4. **Paediatric patient distressed** (sedation needed for cast change): OP-010 procedure with sedation, parental consent, monitoring; scheduling in procedure room, not open plaster room.
5. **Skin condition unknown at removal** (patient leaves before inspection): removal record incomplete flag; phone follow-up task.
6. **Bilateral casts**: two events; checks per limb; labels per limb.
7. **Cast over wound requiring window** (OP-017): window event with wound-care schedule linkage; photos.
8. **MLC patient**: cast events visible in TR-008 case timeline (treatment given); photos handled via evidence service if requested.

### 3.9 Patient self-report & tele-check (`cast.photo_documentation`)
- Portal/WhatsApp flow (EN-009/PE-001): patient answers a 5-question daily/weekly cast check (numbness, colour, swelling, pain, wet/broken) and can upload a photo; red-flag answers create an ER-visit advice + a nurse call task (PE-002); technician reviews photos in a tele-check worklist; reduces unnecessary visits and catches complications early.

## 4. Data Model (schema `trauma`)
- **cast_requests**: id, hospital_id, branch_id, patient_id, encounter_id, fracture_id? (TR-002), ortho_episode_id? (OP-009), source enum(opd/er/ward/ot), requested_by, requested_at, device_type enum(pop_cast/fibreglass_cast/backslab/u_slab/sugar_tong/thumb_spica/cylinder/hip_spica/minerva/collar/brace/splint/traction/sling/other), device_subtype text, limb enum(upper/lower/spine/neck/pelvis), side enum(left/right/bilateral/na), region_code (config lookup: e.g. BEC/AEC/BKC/AKC/PTB), joint_positions jsonb, padding_notes, weight_bearing enum(nwb/ttwb/pwb/wbat/fwb), planned_duration_weeks numeric(4,1), planned_removal_date date, needs_check_xray bool, xray_views text[], needs_sedation bool, consent_doc_id?, priority enum(er_now/today/scheduled), status enum(requested/queued/in_progress/applied/cancelled), cancel_reason, queue_token_id (EN-006), non_fracture_reason?, notes.
- **cast_events** (the immobilisation record; one row per applied device, updated by change/removal): id, hospital_id, branch_id, request_id, patient_id, fracture_id?, device_type, subtype, limb, side, region_code, applied_at, applied_by, assisted_by?, location enum(plaster_room/er/ward/ot/opd_other), deviation_reason?, technique_notes, materials jsonb[] ({item_id, qty, batch?}), consumption_ids uuid[] (NC-008), charge_intent_id?, bill_item_ids uuid[], nv_status_post jsonb, photo_file_ids uuid[], label_printed_at, card_sent_at, planned_removal_date, checks_protocol_id, status enum(active/changed/removed/lost/converted), removed_at?, removed_by?, removal_reason enum(planned/early_complication/early_union/patient_request/conversion/other)?, skin_on_removal jsonb, removal_photo_ids uuid[], removal_xray_order_id?, physio_referral_id?, brace_issued_id?, replaced_by_event_id?, version.
- **cast_event_changes**: id, cast_event_id, at, by, type enum(change/wedge/window/split/bivalve/reinforce/extend/convert/note), details jsonb (angle, side, new_planned_removal_date, reason), charge_intent_id?.
- **cast_checks**: id, cast_event_id, due_at, done_at?, done_by?, location enum(ward/opd/er/phone), findings jsonb ({pain_nrs, pain_out_of_proportion, pallor, paraesthesia, paralysis, pulseless, cap_refill_s, swelling, tightness, wet, cracked, soiled, odour, skin_edges}), red_flag bool, action_taken text, escalated_to?, status enum(pending/done/missed).
- **cast_complications**: id, cast_event_id, type enum(compartment_syndrome/pressure_sore/skin_maceration/dermatitis/thermal_burn/saw_injury/tight_cast_split/loss_of_reduction/stiffness/dvt/lost_cast/other), onset_at, severity enum(minor/moderate/severe), management, outcome, incident_id? (NC-015), fracture_complication_id? (TR-002), recorded_by.
- **cast_check_protocols** (config): hospital_id, name, applies_to (device types/regions/settings), schedule jsonb ([{offset_h, window_h, location}]), red_flag_rules jsonb, is_active.
- **cast_regions** (config): code, display, limb, default_duration_weeks, default_tariff_service_id (RC-003), default_materials jsonb.
- **brace_stock** (if `cast.brace_inventory`; else NC-006 items): item_id, size, side, qty, location.
- **traction_records**: cast_event_id, traction_type enum(skin/skeletal/thomas/gallows/halo/other), weight_kg numeric(4,1), pin_site text?, pin_inserted_at?, weight_changes jsonb[] ({at, by, from_kg, to_kg, order_id}), removed_at.
- **pin_site_cares**: cast_event_id (ex-fix device), at, by, sites jsonb ({site, grade_checketts (0–6), discharge, loosening}), solution, action, next_due_at.
- **frame_adjustment_schedules**: cast_event_id, frame_type enum(ilizarov/tsf/monolateral), schedule jsonb ([{day, strut, turns}]), patient_ack jsonb[] (from PE-001), completed_at.
- **cast_self_reports**: cast_event_id, submitted_at, channel enum(portal/whatsapp/call), answers jsonb, photo_file_ids uuid[], red_flag bool, reviewed_by?, reviewed_at?, outcome enum(reassured/call/er_advised/visit_booked).
- Indexes: cast_events (hospital_id, status, planned_removal_date), (patient_id), (fracture_id); cast_checks (due_at, status); cast_requests (branch_id, status, priority, requested_at). RLS all; retention ≥ 10 y (permanent if MLC).

## 5. Business Rules & Validations
- Side mandatory for paired limbs; must equal linked fracture side; wristband/UHID scan + limb confirmation before application (`site_check` recorded) — application cannot be saved without it.
- Every applied device has a **planned removal date** (or review date for braces/collars); circumferential casts get a 24–48 h check task automatically; fresh cast in ward → neurovascular checks q1h × 4 then q4h × 24 h (protocol configurable).
- Red-flag check findings (any of pain out of proportion, pallor, paraesthesia, paralysis, pulseless, cap refill > 2 s) → immediate alert to doctor on call for ortho + ward in-charge; cannot be closed without action text; compartment-syndrome pathway timer (decision to fasciotomy target ≤ 1 h) once suspected.
- Materials logged per job → NC-008 consumption + charge; charge = tariff for cast type/region (+ materials itemised if hospital policy); ER backslab charged to ER bill (OP-005), ward casts to IP bill (IP-005); re-application due to hospital fault (e.g. cast broke within 24 h) chargeable per policy flag `no_charge_reason`.
- Manipulation under sedation requires consent + OP-010 procedure record + monitoring; paediatric sedation via anaesthesia (IP-024) if deep.
- Post-cast check X-ray must be justified (AERB) — pre-filled from request; result reviewed by doctor within 24 h (worklist).
- Overdue removal escalation ladder +7/+14/+21 days; extension requires doctor order with reason and new date (no silent extension by technician).
- Removal requires skin inspection record; saw safety checklist ticked; complication if injury.
- Duplicate active device on same limb blocked unless `change` (previous auto-marked `changed`).
- MCI mode: bulk splint log by tag with minimal fields (device, limb/side, applied_by, time); full record later.
- Immutability: applied/removed rows versioned; audit all edits.

## 6. API Surface (`/api/v1/ortho/casts`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /requests | create immobilisation request | cast.request.create | Y | – |
| GET | /requests?status=&priority=&branch= | plaster-room queue/list | cast.request.list | – | cursor |
| PATCH | /requests/{id} | edit/cancel | cast.request.update | Y | – |
| POST | /requests/{id}/call | call token (EN-006) | cast.apply | Y | – |
| POST | /requests/{id}/apply | record application (site check, materials, NV status, photos) | cast.apply | Y | – |
| GET | /events/{id} | cast record with checks/changes/complications | cast.event.read | – | – |
| GET | /events?patient=&status=&due_before= | active/overdue casts | cast.event.list | – | cursor |
| POST | /events/{id}/changes | change/wedge/window/split/extend/convert | cast.apply / cast.order (doctor for extend) | Y | – |
| POST | /events/{id}/checks/{checkId}/record | record check findings | cast.check.record | Y | – |
| POST | /events/{id}/complications | log complication | cast.complication.write | Y | – |
| POST | /events/{id}/remove | removal record | cast.apply | Y | – |
| POST | /events/{id}/card/send | send/print cast card | cast.apply | Y | – |
| GET | /worklists/checks-due, /worklists/overdue-removals, /worklists/xray-review | worklists | cast.event.list | – | cursor |
| GET | /reports/consumption?from=&to=, /reports/complications | reports | cast.report.read | – | – |
| GET/PUT | /config/regions, /config/check-protocols, /config/materials-defaults | config | cast.configure | Y | – |
| POST | /mci/bulk-apply | MCI bulk splint log | cast.apply | Y | – |
| POST | /events/{id}/traction/weight | traction weight change (doctor order) | cast.order | Y | – |
| POST | /events/{id}/pin-site-care | pin-site care record | cast.check.record | Y | – |
| POST/GET | /events/{id}/frame-schedule | strut adjustment schedule & patient acks | cast.order / cast.event.read | Y | – |
| POST | /events/{id}/brace-fit | brace/orthosis fitting & issue | cast.apply | Y | – |
| POST | /self-reports (portal), GET /worklists/tele-check | patient self-report intake & review | portal (patient) / cast.check.record | Y | cursor |

## 7. Domain Events (outbox)
- `cast.requested` {request_id, patient_id, device_type, side, priority} → EN-006 plaster queue, OP-009.
- `cast.applied` {cast_event_id, fracture_id, device, side, planned_removal_date, materials} → TR-002 timeline (`cast_applied`), NC-008 consumption, OP-005/IP-005 charge, EN-013 label, EN-009 cast card, OP-001 removal/check appointment, IP-003 check tasks (ward), PE-001.
- `cast.check.recorded` {red_flag, findings} → EN-037 doctor alert when red flag, NC-015 (harm).
- `cast.changed|wedged|split|extended|converted` → TR-002 timeline, billing.
- `cast.complication.recorded` {type, severity} → TR-002 complications, NC-015, Quality.
- `cast.removed` {reason, skin, physio_referral_id?} → TR-002 timeline (`cast_removed`), OP-015/TR-010, PE-002 (follow-up), billing (brace).
- `cast.overdue` {days} → surgeon worklist, EN-009 patient SMS, HOD escalation.
- Consumes: `ortho.fracture.plan_set` (TR-002 → auto-create request when immobilisation intent), `ot.case.completed` (post-op cast orders), `rad.study.completed` (check X-ray link), `appointment.no_show` (OP-001), `er.patient.arrived` (cast problem visits).

## 8. Screens (UI)
- **Plaster room queue** (desktop + wall TV via EN-018): tokens by priority with patient (initials on TV), device requested, side, waiting time; `N` next, `A` apply, `S` skip/hold; real-time; offline: last list cached read-only.
- **Application form** (tablet/desktop): patient banner with side badge huge (LEFT/RIGHT), wristband scan field, site-check tick, device/region pickers pre-filled from request, materials grid with defaults (qty +/−), NV status buttons, photo capture, planned removal date (auto from duration), label print, card send; `Ctrl+S` save; validation errors inline (side mismatch hard-stop banner).
- **Cast record page** (desktop/tablet): timeline (applied → checks → changes → removal), red-flag history, X-ray links (OHIF), complications, patient card preview; actions `C` change, `R` remove, `X` complication, `E` extend (doctor).
- **Ward check task** (nurse phone/tablet, IP-003 task list): 5 Ps quick form with big yes/no, cap-refill timer, red-flag auto-alert confirmation; offline capture with sync.
- **Doctor worklists** (OP-009 embedded): X-ray review post-cast (with cast index calculator for paediatric forearm), overdue removals, complications, extensions requested.
- **Patient cast card** (PE-001/OP-020 phone + printed A5): device, limb, applied date, removal date, care do's/don'ts, red flags with hotline (bilingual, pictograms).
- **Materials & tariff config** (admin desktop); **reports** (desktop).

## 9. Integrations
- EN-006 tokens/TV; EN-013 label printer (ZPL, waterproof label) & wristband scan; NC-006/NC-008 stock/consumption; OP-005/IP-005 charges (RC-003 tariff); OP-008/EN-008 X-ray order/link; TR-002 timeline/complications; OP-009 protocols; OP-015/TR-010 referrals; EN-009 SMS/WhatsApp cast card & reminders (DLT templates); PE-001/OP-020; EN-028 consent; OP-010 procedure record for MUA; NC-015 incidents; IP-003 nursing tasks.
- Fallbacks: label printer down → handwritten label with QR later; stock item missing → free-text material with stores alert; SMS failure → printed card only.

## 10. Reports & Analytics
- Casts applied by type/region/setting/technician per day; average application time; materials consumption vs charges (leakage); re-application within 7 days (quality); red-flag rate & time-to-doctor-response; compartment syndrome incidents & time to fasciotomy; pressure sore/skin injury rate; overdue removals & lost-to-follow-up; check-X-ray compliance & cast-index failures; conversion to surgery after cast; brace issue & stock; plaster room queue wait times.
- Read models: `analytics.mv_cast_daily`, `analytics.mv_cast_complications`, `analytics.mv_cast_overdue`.

## 11. Notifications
- Patient/attendant: cast card & care instructions on application (WhatsApp/SMS, local language), check/removal appointment reminders (T-1 day), overdue removal nudges, red-flag advice ("if fingers numb/blue → come to ER now").
- Doctor on call: red-flag check findings (push + SMS + escalation), post-cast X-ray review due, extension requests, overdue removals digest.
- Ward in-charge/nurse: check tasks due/missed; Stores: low stock; Billing: unbilled materials; Quality: complications; HOD: +14 day overdue escalation.

## 12. Permissions (RBAC keys)
`cast.request.create|list|update`, `cast.apply`, `cast.order` (extend/early removal orders), `cast.event.read|list`, `cast.check.record`, `cast.complication.write`, `cast.report.read|export`, `cast.configure`.
Defaults: Ortho doctors (6/9/14): request.*, order, event.*, complication.write, report; Plaster tech/OPD nurse (16): request.list, apply, event.*, check.record, complication.write; ER doctor/nurse (8/19): request.create, apply (ER), check.record; Ward nurse (17): check.record, event.read; Physio (40): event.read; Receptionist (24): request.list (booking); Billing (27): report; Stores (44): report (consumption); Quality (54): report.export; Admin: configure; Patient: own card; Auditor: read.

## 13. Non-functional
- Volumes: 100–200 applications/day, 400 active ward checks/day, 8k active casts at any time (2000-bed centre); queue board 20 concurrent viewers.
- p95: apply save < 250 ms (incl. consumption/charge outbox), queue read < 100 ms, worklists < 200 ms.
- Offline: application & check forms operate offline on tablets (materials defaults cached), sync idempotent; queue calling requires network.
- Printing: waterproof cast labels (ZPL 50×25 mm), A5 cast card (bilingual pictograms).
- Accessibility: side badge high-contrast, colour + text; large tap targets; audio for red-flag alerts.
- Security/audit: side check & every change audited; photos encrypted; MLC-linked casts follow TR-008 access rules.

- Seed data: cast regions (BEC/AEC/BKC/AKC/PTB/cylinder/thumb spica/hip spica/collar/braces) with default durations & materials, two check protocols (ward circumferential; OPD), red-flag rules, DLT SMS templates (cast card, reminders, red-flag advice), sample tariff lines.
- Test fixtures: 50 synthetic requests across ER/OPD/ward, one bilateral case, one paediatric MUA, one external fixator with pin-site protocol, one self-report red flag; k6 smoke on `/requests` queue and `/events` worklists.
- Observability: metrics for queue wait time, apply latency, red-flag alert delivery time, sync backlog per device; alerts when overdue-removal job fails.
- Print templates: waterproof label (ZPL), A5 cast card (bilingual pictograms), removal instructions — in `packages/print-templates/cast/*`.
- Feature-flag defaults: `cast.plaster_room_queue=true`, `cast.brace_inventory=false` (use NC-006), `cast.photo_documentation=false` until hospital confirms policy.
- Retention job: cast photos follow clinical retention (≥ 10 y); MLC-linked casts inherit TR-008 permanent retention.

## 14. Acceptance Criteria
1. Given a TR-002 plan with intent "closed reduction & cast" for left distal radius, then a cast request is auto-created (side left, region BEC default, duration 6 weeks) and appears in the plaster room queue as `today` priority.
2. Given the technician scans a wristband and selects "right" while the request says "left", then the application form shows a hard-stop and cannot be saved.
3. Given application saved with 3 POP rolls and 1 stockinette, then NC-008 consumption rows are created, an OP-005 charge for "Below elbow cast" posts, label prints with removal date, and the patient receives the cast card on WhatsApp within 1 min.
4. Given a fresh circumferential below-knee cast applied on the ward at 14:00, then check tasks at 15:00, 16:00, 17:00, 18:00 and then q4h for 24 h appear in IP-003 for that patient.
5. Given a ward check records "pain out of proportion = yes, cap refill 4 s", then a red-flag alert reaches the on-call ortho doctor within 30 s, the task cannot close without action text, and a compartment-syndrome pathway timer starts.
6. Given planned removal 2026-09-20 and no removal/extension by 2026-09-27, then the cast appears on the surgeon's overdue worklist and the patient receives an SMS; at +14 days HOD is notified.
7. Given the doctor extends the cast by 2 weeks with reason, then planned removal updates, the appointment reschedules, and the change is on the TR-002 timeline.
8. Given post-cast X-ray reported for an 8-year-old forearm with cast index 0.86, then the review worklist flags "cast index ≥ 0.8" for the doctor.
9. Given a removal recorded with skin "intact" and physio referral ticked, then `cast.removed` triggers an OP-015 referral pre-filled with fracture and weight-bearing status, and TR-002 timeline shows `cast_removed`.
10. Given a second cast request for the same limb while a cast is active, then the system prompts "change existing cast" and, if chosen, marks the previous event `changed` with linkage.
11. Given ER tablet offline, when a backslab is applied, then the record is captured locally and syncs with the same id and consumption without duplicates.
12. Given the plaster room TV, then it shows tokens and initials only, never full names or diagnoses.
13. Given a complication "thermal burn" logged, then an NC-015 incident is created and Quality sees it in the monthly complication report.
14. Given a nurse without `cast.order` tries to extend the removal date, then the request is rejected (403).
15. Given skeletal traction 5 kg ordered, when a nurse attempts to change weight to 7 kg without a doctor order, then the change is rejected; with an order it is recorded with before/after and time.
16. Given an external fixator with a pin-site care protocol q24h, then tasks appear daily in IP-003/OP-039; a Checketts-Otterburn grade ≥ 3 entry creates a TR-002 complication and doctor alert.
17. Given a Taylor Spatial Frame schedule uploaded, then the patient receives daily strut-turn reminders in the app and acknowledgements are visible to the surgeon; 2 missed days trigger a call task.
18. Given a patient submits a self-report with "fingers blue" and a photo, then a red flag is raised, ER-visit advice is sent immediately, and a nurse call task is created within 5 min.
19. Given daily close with 42 jobs, 40 charges and consumption for 42, then the reconciliation lists 2 unbilled jobs and creates a leakage task for billing.
20. Given a hinged knee brace issued from stock size L with 0–90° range, then the fitting record, charge and PE-001 wear schedule are created and stock decrements by one.
21. Given a referred patient arriving with a cast applied elsewhere, then an `external_applied` event is recorded with estimated date, the check protocol starts, and a removal date is set by the doctor.
22. Given a below-elbow cast that became soft within 12 h and is re-applied, then the re-application is recorded with `no_charge_reason=quality`, no second charge posts, and the quality report counts one re-application.
23. Given bilateral forearm casts, then two cast events exist with per-limb labels and check tasks, and the patient card lists both with their removal dates.

## 15. Enhancements / Later phases
- From VIMS costed sheet (TR-005 key functions): all covered — application log, materials, removal schedule, follow-up X-ray, complication monitoring, billing.
- (market) Competitor HMS have no plaster-room module; TR-005 adds later: 3D-printed/waterproof cast vendor workflows, cast-care video library (OP-038), smart-cast sensors (pressure/moisture via EN-042, Phase 12), AI cast-index measurement from DICOM (AI-007), patient photo self-check via portal with triage (AI-001), brace inventory with vendor consignment (NC-007), plaster technician productivity & skills matrix (NC-027).

## 16. Open Questions for the Hospital
1. Plaster room locations (OPD/ER/ward), technicians per shift, whether the plaster room has its own token display.
2. Cast tariff structure: per cast type/region only, or type + materials itemised? Fibreglass upcharge? Re-application charge policy.
3. Standard cast durations and check protocols per region (defaults to seed); ward NV check frequency.
4. Red-flag escalation contacts (on-call ortho, ward in-charge) and compartment-syndrome pathway details.
5. Do you use cast index for paediatric forearm fractures? Post-cast X-ray policy.
6. Braces/collars: hospital stock (NC-006) vs vendor consignment vs external purchase by patient?
7. Cast card languages/pictograms and delivery channel (print, WhatsApp, both).
8. Photo documentation policy (application/removal photos default on/off; retention).
9. MCI splinting protocol and pre-stocked splint kits.
10. External fixator/frame patients: who manages pin-site care (ward vs OPD nurse vs patient) and which protocol (e.g. Royal College of Nursing consensus)?
11. Traction practices still in use (skeletal/skin) and weights range; halo vests?
12. Do you want the tele-check self-report on WhatsApp for all casts by default or opt-in?
13. Reconciliation ownership at daily close (plaster room in-charge vs billing) and leakage tolerance.
14. Preferred label material/printer in plaster room (waterproof ZPL) and TV display availability.
15. Paediatric sedation location/policy for cast changes.
