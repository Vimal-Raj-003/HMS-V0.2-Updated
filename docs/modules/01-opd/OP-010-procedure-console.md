# OP-010 — Procedure Console (Scheduling, Pre-procedure checklist, Consent, Documentation, Consumables, Photo/Video, Billing)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-010 |
| Phase | 8 (core procedure record used from Phase 6 by OP-009/OP-006; full console Phase 8) |
| Priority | P1 |
| Complexity | Medium |
| Depends on | OP-002 (procedure orders from consultation), OP-001 (appointments, procedure-room slots), OP-005 (billing), OP-003/NC-006/NC-008 (consumables, kits, sub-store consumption), EN-028 (consent templates, e-sign, witness), EN-039 (procedure note templates), EN-013 (barcode: patient wristband/OP slip, consumable scan), OP-039 (OPD nursing/minor OT room execution), OP-006 (day-care beds when sedation/observation needed), IP-024 (anaesthesia record if anaesthetist involved), OP-008/EN-008 (image-guided procedures, dose), OP-004 (specimens to lab: biopsy/aspirate), OP-009/OP-016/OP-017/OP-025..OP-031 (specialty procedures reuse this console), EN-009 (SMS/WhatsApp), EN-037 (alerts), NC-003 (MRD filing), NC-015 (incidents), EN-016 (e-sign), EN-030 (PROMs surveys), EN-042 (device capture) |
| Feature flag | `module.procedure_console.enabled` (sub: `procedure.video_recording`, `procedure.proms`, `procedure.complication_tracker`) |
| Primary roles | Doctor — Consultant / Surgeon (6/9), Resident (14), Nurse — OPD / Procedure room (16), OT/Scrub nurse for minor OT (20) |
| Secondary roles | Receptionist (24, slot booking), Billing (27), Anaesthetist (10), Lab tech (33, specimen receipt), MRD (43), Quality (54), Biomedical (48, equipment downtime), Patient (portal: instructions, consent copy) |
| Regulatory | NABH 5th ed. COP.9/PRE (informed consent: procedure, risks, alternatives, in patient language, witness; sedation policy; time-out/site marking for invasive procedures), WHO Safe Surgery checklist adapted for minor procedures, BMW Rules 2016 (sharps/anatomical waste from procedure room), IT Act/DPDP (photo/video PHI, encryption, consent for recording), CDSCO (device UDI), AERB (fluoro/C-arm guided procedures dose), IRDAI day-care procedure lists (billing/insurance), Clinical Establishments Act record retention |

## 1. Purpose
OP-010 is the shared engine for every OPD/day-care procedure that is not a full OT case: scheduling into procedure rooms, pre-procedure checklist (allergies, fasting, anticoagulants, consent, site marking, time-out), digital informed consent with witness, structured procedure notes with photo/video capture, consumables and kit consumption that auto-bill and auto-deduct stock, post-procedure recovery/discharge instructions, follow-up and 30-day complication tracking. Specialty consoles (ortho injections OP-009, pain blocks OP-016, wound debridement OP-017, derm OP-027, ENT OP-028, cardio TMT/Echo bookings OP-029, bronchoscopy OP-030, dental OP-026, ophthalmology OP-025, fertility IUI OP-024) call this module rather than re-implementing it.

## 2. Users & Jobs-to-be-done
- **Doctor** (desktop/tablet; 5–30 procedures/day): order/schedule procedure from consultation, take consent, do time-out, document notes/findings/complications with photos, dictate follow-up; sign.
- **Procedure-room nurse** (tablet on wall mount/desktop): run today's worklist, prepare room/kit, verify checklist, scan consumables, record vitals pre/post (OP-007 vitals shared table), recovery observations, give instructions, book follow-up.
- **Receptionist**: book procedure slots by room/doctor/equipment, send prep instructions, collect advance/estimate (RC-008).
- **Billing**: consolidated procedure charge (fee + consumables + anaesthesia + room + drugs) posted automatically; package handling (OP-023).
- **Anaesthetist** (if sedation): pre-sedation assessment (IP-024 mini PAC), sedation record, Aldrete discharge score.
- **Quality**: consent completeness, complication rate, time-out compliance, TAT.

## 3. Core Workflows

### 3.1 Ordering & scheduling
1. Doctor in OP-002 (or specialty console) selects **procedure** from procedure master (EN-027 service catalogue: SNOMED/ICD-9-CM/CPT-like code, category (minor surgical/injection/aspiration/endoscopy/biopsy/dressing/diagnostic e.g. TMT, PFT/therapeutic), default room type, duration, requires_consent, requires_sedation, requires_fasting_hours, requires_imaging_guidance, day_care_eligible (IRDAI list), default kit_id, default consent_template_id, default note_template_id, follow-up protocol) → side/site, indication (ICD-10), urgency (routine/urgent/same-day), preferred date, sedation Y/N, anaesthetist needed Y/N.
2. System checks: duplicate active order same procedure/site; allergy to listed drugs/latex; anticoagulant flag (EN-029: warfarin/DOAC/antiplatelet with bleed-risk procedure → advisory "hold X days / INR check"); pregnancy for radiation-guided; consent template exists.
3. **Scheduling**: slot picker filtered by room type + doctor availability + equipment (e.g. USG, C-arm, endoscope) + sedation slots; day-care bed reserve (OP-006) if observation needed; multi-resource booking (`procedure_bookings` holds room, doctor, equipment, anaesthetist). Estimate (RC-008) → advance (OP-005/NC-001) if policy; insurance pre-auth (EN-002) if payer requires. Confirmation + **prep instructions** (fasting from time, stop meds, bring reports, attendant required after sedation) via WhatsApp/SMS/portal (EN-009/PE-001). Event `procedure.scheduled`.
4. Same-day/inline: doctor performs immediately in OPD room ("do now") — booking auto-created for current time & room.
5. Reschedule/cancel with reason (patient/doctor/equipment down NC-020 → auto-notify affected bookings and offer slots); no-show marking; waitlist auto-fill.

### 3.2 Pre-procedure
1. Patient arrives → check-in (scan) → nurse opens **pre-procedure checklist** (configurable per procedure; seeded): identity 2-point, allergies verified, fasting status (hours), current meds incl. anticoagulants/antidiabetics, relevant labs (INR/platelets/HbsAg per procedure rule) present, vitals recorded (OP-007 shared), pregnancy status (female 12–55) where relevant, implants/pacemaker (diathermy), site marked (Y/N/NA), consent signed, valuables/attendant, sedation pre-assessment (ASA class, airway, Aldrete baseline) if sedation, equipment check & sterile kit CSSD tray scanned (EN-003 tray ID → expiry & sterility indicator OK), BMW bins ready.
2. Missing mandatory item → cannot mark "ready" (override by doctor with reason logged).
3. **Consent** (EN-028): template auto-selected (procedure + language) with procedure-specific risks (editable clinical content by doctor), alternatives, anaesthesia/sedation consent (separate), photo/video recording consent (separate, optional), financial consent/estimate; patient (or LAR if minor/incapacitated with relationship) signs on tablet/signature pad, witness signs, doctor counter-signs; optional Aadhaar eSign; **video consent** option (market: record the explanation, stored encrypted); PDF stamped with timestamp/IP/device, hash-chained, filed to NC-003 and patient portal. Event `consent.signed`.
4. **Time-out** (invasive procedures): doctor+nurse confirm patient, procedure, side/site, consent, allergies, antibiotics/equipment; recorded with both user IDs; Event `procedure.timeout.done`.

### 3.3 Procedure execution & documentation
1. Start (`Ctrl+B` begin) → status `in_progress`, start time; room status board updates (EN-018 optional).
2. **Procedure note** (EN-039 template per procedure, structured + free text): indication, anaesthesia/sedation used (local drug/dose, sedation drugs, monitoring), technique/steps, findings, specimens (auto-creates OP-004 lab order + label; chain of custody), implants/devices used (TR-003 if implant), image guidance (OP-008 study link, fluoro time/dose), estimated blood loss, complications intra-op (bleeding, vasovagal, allergic reaction, wrong site (never event → NC-015)), photos/videos (camera on tablet or USB/HDMI capture via EN-042; stored S3 encrypted; annotate; before/after pairing), assistants.
3. **Consumables & kit**: default kit lines pre-populated (from procedure master), nurse scans additional items (barcode) → quantities → on completion → NC-008 consumption from procedure-room sub-store (batch/FEFO) → chargeable items auto-added to bill (OP-005) with tariff/payer mapping; non-chargeable (included in procedure fee) flagged; high-value items require scan (no manual add) per config.
4. **Vitals during** (sedation): shared `clinical.vitals` context `procedure` q5–15 min; SpO2/BP alerts (EN-029).
5. Complete (`Ctrl+E`) → end time, duration; doctor signs note (resident → co-sign); Event `procedure.completed`.

### 3.4 Post-procedure
1. Recovery (if sedation/observation): observation notes, Aldrete score ≥ 9 (or PADSS) to discharge, responsible adult present; day-care bed release (OP-006).
2. **Discharge instructions** (template per procedure: wound care, activity, diet, meds, warning signs, emergency number) → printed + WhatsApp + portal (patient language); post-procedure Rx via OP-002.
3. Follow-up: protocol (e.g. dressing at 48 h, suture removal day 7–10, histopath review) → appointments (OP-001) + reminders (PE-002).
4. **30-day complication tracking**: automated WhatsApp/IVR check-ins at day 2, 7, 30 ("any fever/bleeding/pain?") → responses to nurse queue; complications recorded (Clavien-Dindo grade for surgical; type; management; readmission) → complication register; PROMs (EN-030) where configured.
5. Billing: consolidated procedure invoice lines (procedure fee — doctor share to NC-034, room, consumables, drugs, anaesthesia, imaging guidance) → OP-005; package (OP-023) inclusion & variance; insurance day-care claim docs (consent, note, discharge summary) bundle to EN-002.

### 3.5 Exceptions
- Cancel after start (patient intolerance) → status `abandoned` with reason; consumables used are still consumed/billed per policy; partial fee rule configurable.
- Consent refused → procedure blocked; documented.
- Equipment failure mid-procedure → incident (NC-015), biomedical ticket (NC-020), rebook.
- Wrong patient scan → hard-stop.
- Offline: checklist/notes/photos cached on tablet; consumable scans queued; sync with idempotency; billing posts on sync.

## 4. Data Model (schema `clinical`)
- **procedure_master** (mdm; EN-027 owned, extended here): id, hospital_id, code, name, snomed_ct?, category enum, default_duration_min, room_type, requires_consent, consent_template_id, requires_sedation_option, fasting_hours, requires_imaging_guidance, day_care_eligible, irdai_daycare_code?, kit_id?, note_template_id (EN-039), instruction_template_id, followup_protocol jsonb, checklist_template_id, mandatory_labs jsonb, price/service_id (RC-003), is_active, version.
- **procedure_orders**: id, hospital_id, branch_id, patient_id, encounter_id, ordered_by, procedure_id, side enum(left/right/bilateral/na), site_text, snomed_site?, indication_icd10, urgency, sedation_requested, anaesthetist_required, status enum(ordered/scheduled/checked_in/ready/in_progress/completed/abandoned/cancelled/no_show), cancel_reason, package_id?, preauth_id?, estimate_id?, source_module (op_002/op_009/…), created_*; index (hospital_id, patient_id), (hospital_id, status, created_at).
- **procedure_bookings**: id, hospital_id, branch_id, order_id, room_id, doctor_id, anaesthetist_id?, equipment_ids uuid[], start_at, end_at, daycare_bed_id?, status enum(booked/confirmed/checked_in/done/cancelled/no_show/rescheduled), rescheduled_from_id?, instructions_sent_at; exclusion constraint (room_id, tstzrange(start_at,end_at)) via btree_gist; index (hospital_id, branch_id, start_at).
- **procedure_rooms**: id, hospital_id, branch_id, name, type enum(minor_ot/procedure_room/injection_room/endoscopy/cath_lab_prep/dressing/dialysis/derm/eye_laser/…), equipment_ids, capacity, open_hours jsonb, sub_store_id (NC-006), is_active.
- **procedure_checklists**: id, hospital_id, order_id, template_id, items jsonb ([{key,label,required,value,by,at}]), ready bool, ready_by, ready_at, override_reason.
- **procedure_timeouts**: id, order_id, confirmed_by uuid[], patient_ok, procedure_ok, side_ok, consent_ok, allergy_ok, equipment_ok, at.
- **procedures** (the record): id, hospital_id, branch_id, order_id, patient_id, encounter_id, performed_by, assistants uuid[], anaesthetist_id?, started_at, ended_at, anaesthesia_type enum(none/local/regional/sedation/ga), sedation_record jsonb, note_form_response_id (EN-039), findings text, technique text, ebl_ml, specimens jsonb ([{label, lab_order_id, container}]), imaging_guidance jsonb ({modality, study_uid, fluoro_sec, dose}), implants jsonb (TR-003 refs), complications jsonb ([{type, grade, mgmt}]), outcome enum(completed/abandoned), signed_by, signed_at, cosigned_by?, document_id (clinical.documents version), version.
- **procedure_media**: id, hospital_id, procedure_id, patient_id, type enum(photo/video/document), stage enum(pre/intra/post), s3_key (encrypted), thumb_key, mime, size, captured_by, captured_at, device_id?, annotations jsonb, consent_ref (recording consent id), retention_until; index (procedure_id).
- **procedure_consumables**: id, hospital_id, procedure_id, item_id, batch_id?, qty, uom, source enum(kit/scanned/manual), chargeable bool, bill_item_id?, consumption_id (NC-008), scanned_by; index (procedure_id).
- **procedure_kits**: id, hospital_id, name, procedure_id?, lines jsonb ([{item_id, qty, chargeable}]), cssd_tray_type_id?, is_active, version.
- **procedure_recovery**: id, procedure_id, observations jsonb[], aldrete_scores jsonb[], discharge_criteria_met_at, discharged_by, escort_name, instructions_doc_id.
- **procedure_followups**: id, procedure_id, day_offset, kind enum(check_in_msg/visit/dressing/suture_removal/histopath_review/prom), due_at, status enum(pending/sent/responded/done/missed), response jsonb, appointment_id?.
- **procedure_complications** (register): id, hospital_id, procedure_id, patient_id, detected_at, days_post, type, clavien_dindo enum(I/II/IIIa/IIIb/IVa/IVb/V)?, severity, management, readmitted bool, incident_id? (NC-015), reported_by.
- Consent rows live in EN-028 (`consents`) with `context_type='procedure', context_id`.
- All tables carry hospital_id/branch_id, audit columns, version, RLS; media keys never in logs.

## 5. Business Rules & Validations
- Procedure cannot start unless: checklist `ready` (or doctor override with reason), consent signed for `requires_consent` procedures (no override), time-out done for invasive category, identity scanned.
- Consent must be in patient's chosen language, list risks/alternatives, be signed by patient/LAR + witness + doctor, timestamped; consent older than 30 days or for a different side/procedure is invalid → new consent. Minors (< 18) → guardian; separate consents for sedation and recording.
- Recording (photo/video) requires recording consent; media encrypted at rest (SSE-KMS/MinIO KMS), presigned URLs ≤ 5 min, watermark UHID on export, export audited (`*.export`).
- Sedation procedures require anaesthetist or credentialed doctor per policy, monitoring vitals q5 min, Aldrete ≥ 9 for discharge, escort documented; without → discharge blocked.
- Consumables: kit lines default; high-value/implant items must be scanned; consumption posts on completion (or on abandon per policy); billing lines follow payer tariff; items marked "included in fee" not billed; stock negative → block with supervisor override.
- Specimen creates lab order + label before patient leaves; unlabelled specimen = incident.
- Anticoagulant/bleeding-risk rules from EN-029 (e.g. warfarin INR ≤ 1.5 for high-risk, hold DOAC 48 h) advisory; doctor may proceed with reason.
- Fasting rules for sedation: solids 6 h, clear fluids 2 h (ASA); breach → warn/block per config.
- Complications logged within 30 days linked to procedure; Clavien-Dindo ≥ III → NC-015 incident auto-draft; never events (wrong site/patient/procedure) → mandatory incident + MS notification.
- Numbering: `PROC` series per branch/FY; note document versioned & signed (hash chain); media retention as clinical record (≥ 10 y; derm/cosmetic photos same).
- Rooms cannot be double-booked (exclusion constraint); equipment under breakdown/PM (NC-020) blocks booking.
- Doctor share for procedure fee via NC-034 rules; day-care eligible procedures tagged for insurer claim (IRDAI list mapping).

## 6. API Surface (`/api/v1/procedures`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PUT | /master, /kits, /rooms, /checklist-templates | configuration | procedure.configure | Y | cursor |
| POST | /orders | order procedure (from encounter/console) | procedure.order.create | Y | – |
| GET | /orders?patient=&status=&doctor= | list | procedure.order.read | – | cursor |
| POST | /orders/{id}/cancel | cancel with reason | procedure.order.cancel | Y | – |
| GET | /slots?room_type=&doctor=&equipment=&date= | availability | procedure.booking.read | – | – |
| POST | /orders/{id}/bookings | book resources | procedure.booking.create | Y | – |
| PATCH | /bookings/{id} | reschedule/cancel/no-show | procedure.booking.update | Y | – |
| POST | /bookings/{id}/send-instructions | prep instructions | procedure.booking.update | Y | – |
| GET | /worklist?room=&date=&doctor= | today's list (socket updates) | procedure.worklist.read | – | cursor |
| POST | /orders/{id}/check-in | scan check-in | procedure.worklist.manage | Y | – |
| GET/PUT | /orders/{id}/checklist | checklist | procedure.checklist.update | Y | – |
| POST | /orders/{id}/consent | create consent from template (delegates EN-028) | consent.create | Y | – |
| POST | /orders/{id}/timeout | record time-out | procedure.timeout.create | Y | – |
| POST | /orders/{id}/start, /complete, /abandon | state transitions | procedure.record.create | Y | – |
| PUT | /records/{id}/note | save note (draft), sign, cosign | procedure.record.update / sign / cosign | Y | – |
| POST | /records/{id}/media (multipart / presigned) | upload photo/video | procedure.media.create | Y | – |
| GET | /records/{id}/media/{mid}/url | presigned view | procedure.media.read | – | – |
| POST/DELETE | /records/{id}/consumables | add/scan/remove lines | procedure.consumable.update | Y | – |
| POST | /records/{id}/specimens | create lab order + label | procedure.record.update | Y | – |
| PUT | /records/{id}/recovery | observations/Aldrete/discharge | procedure.recovery.update | Y | – |
| POST | /records/{id}/followups/generate | from protocol | procedure.followup.create | Y | – |
| POST | /records/{id}/complications | log complication | procedure.complication.create | Y | – |
| GET | /registers/complications?from=&to= | register | procedure.report.read | – | cursor |
| GET | /stats/dashboard | KPIs | procedure.report.read | – | – |

## 7. Domain Events (outbox)
- `procedure.ordered` {order_id, patient_id, procedure, side, urgency} → scheduling worklist, EN-002 pre-auth trigger, RC-008.
- `procedure.scheduled|rescheduled|cancelled|no_show` → OP-001 calendar, EN-009 notifications, OP-006 day-care bed hold, NC-020 equipment link.
- `procedure.checked_in|ready` → room board, doctor push.
- `consent.signed` (EN-028) {context procedure} → NC-003 filing, PE-001.
- `procedure.timeout.done`, `procedure.started`, `procedure.completed|abandoned` {record_id, duration, consumables, specimens, complications} → OP-005 billing lines, NC-008 consumption, OP-004 specimen orders, NC-034 doctor share, PE-002 follow-ups, analytics.
- `procedure.media.added` → patient timeline; `procedure.complication.recorded` {grade} → NC-015 (≥ III), quality dashboard.
- Consumes: `visit.checked_in`, `asset.breakdown` (NC-020), `stock.level.low` (NC-006), `lab.result.final` (histopath → follow-up), `payment.received` (advance).

## 8. Screens (UI)
1. **Procedure scheduler** (desktop; receptionist/doctor): calendar by room/doctor/equipment (day/week), drag to reschedule, conflict highlighting, waitlist panel; `N` new booking, `R` reschedule; live updates via socket; empty "no bookings today".
2. **Procedure worklist** (tablet/desktop in room): today's cards with status chips (booked→checked-in→ready→in progress→recovery→done), scan-to-open (`F3`), room filter; real-time.
3. **Pre-procedure checklist & consent** (tablet): large toggles, mandatory highlighted, consent flow with signature pad, language switch, video consent record button, witness capture, print/preview PDF; offline-tolerant.
4. **Procedure record** (desktop/tablet): header patient banner + side/site big badge; sections note/findings/consumables/media/specimens/complications; `Ctrl+B` start, `Ctrl+E` complete, `Ctrl+S` save, `Ctrl+Enter` sign, `F9` add consumable (scanner focus), `F10` camera; timer visible; kit lines pre-filled; media grid with before/after compare.
5. **Recovery board** (tablet in recovery bay): patients with Aldrete trend, discharge criteria, escort; alerts.
6. **Complication & follow-up queue** (desktop, nurse): check-in responses, overdue follow-ups, log complication.
7. **Procedure master/kit/checklist configuration** (desktop, admin).
8. **Procedure KPI dashboard** (desktop dark theme): volumes, utilisation per room, consent compliance, time-out compliance, complication rate, TAT booking→done, revenue.

## 9. Integrations
- EN-028 consent service (templates, e-sign, Aadhaar eSign EN-016), EN-013 barcode (patients, consumables GS1), EN-003 CSSD tray scan, NC-006/NC-008 stock, OP-005 billing, OP-004 lab specimen order (HL7 ORM internally), OP-008/EN-008 for image guidance (study link, dose), EN-042 device capture (USB/HDMI capture cards → WebRTC getUserMedia in PWA), EN-009 WhatsApp/SMS (DLT templates: prep, instructions, check-ins), EN-033 IVR for check-ins (later), S3/MinIO encrypted media, EN-030 PROMs, EN-002 pre-auth/claim docs.
- Failures: media upload retried from device queue; billing post retried via outbox; consent service down → cannot start (safety) except emergency override with reason.

## 10. Reports & Analytics
- Procedure register (statutory-style: date, patient, procedure, doctor, anaesthesia, complications), room utilisation, doctor productivity, consent & time-out compliance %, complication rate by procedure/doctor (Clavien-Dindo), 30-day check-in response rate, consumable cost per procedure vs fee (margin), day-care claim bundle completeness, cancellations/no-shows with reasons, TAT order→booking→done.
- Read models: `analytics.procedure_daily`, `analytics.procedure_complications`, `analytics.procedure_room_utilisation`.

## 11. Notifications
- Patient: booking confirmation with prep instructions (fasting time, meds, escort), reminder D-1 & 2 h, reschedule/cancel notice, post-procedure instructions PDF, day 2/7/30 check-in questions (WhatsApp interactive buttons), follow-up due, histopath report ready.
- Staff: patient checked-in/ready (doctor push), equipment breakdown affecting bookings, consent missing 30 min before slot, complication reported by patient (nurse queue), co-sign pending, kit stock low.
- TV (EN-018): procedure room queue tokens (optional).

## 12. Permissions (RBAC keys)
`procedure.configure`, `procedure.order.create|read|cancel`, `procedure.booking.create|read|update`, `procedure.worklist.read|manage`, `procedure.checklist.update`, `procedure.timeout.create`, `procedure.record.create|update|read|sign|cosign`, `procedure.media.create|read|export`, `procedure.consumable.update`, `procedure.recovery.update`, `procedure.followup.create|update`, `procedure.complication.create|read`, `procedure.report.read`, plus `consent.create|read` (EN-028).
Defaults: Doctor/Surgeon — order, record create/update/sign, media, complication; Resident — same minus sign (cosign required); Procedure nurse — worklist manage, checklist, consumables, recovery, media create, followup; Receptionist — booking; Billing — read; Quality — report/complication read; Admin — configure.

## 13. Non-functional
- Volumes: 300–600 OPD procedures/day enterprise-wide, 20 procedure rooms, 5–10 photos per procedure (≈ 3 GB/day media); worklist p95 < 200 ms; media upload background with resumable multipart; presigned URL issue < 100 ms.
- Offline: tablet PWA caches worklist, checklist templates, kits; photos captured offline stored in IndexedDB/OPFS (cap 500 MB) and uploaded on reconnect; notes queued; conflict rule: server rejects sign if a newer version exists → user re-reviews.
- Printing: consent PDF (A4, patient language + English), instructions, specimen labels (ZPL), procedure report.
- Accessibility/i18n: consent & instruction templates multilingual; large touch targets; screen-reader labels for checklist.
- Security: media SSE, no PHI in S3 keys, watermarking on export, DPDP purpose tagging for recording consent; audit on view of media (READ_PHI when outside care team).

## 14. Acceptance Criteria
1. Given a procedure marked requires_consent, when the nurse taps Start without a signed consent, then start is blocked with a link to consent flow; after patient+witness+doctor sign, start succeeds and the PDF is filed to MRD.
2. Given a booking for Room A 10:00–10:30, when another booking overlaps the same room, then the API returns 409 (exclusion constraint) and the UI shows the conflict.
3. Given a kit with 5 default lines and 2 scanned extras, when the procedure completes, then NC-008 consumption is posted for 7 lines from the room sub-store (FEFO batches) and OP-005 receives billable lines only for chargeable items.
4. Given a sedation procedure, when discharge is attempted with Aldrete 7, then discharge is blocked; at ≥ 9 with escort recorded it succeeds.
5. Given the tablet is offline, when nurse completes checklist and captures 3 photos, then they persist locally and upload within 2 min of reconnect, with original timestamps and no duplicates (idempotency keys).
6. Given a resident signs a note, then status is `awaiting_cosign`; billing of consultant fee is held until cosign (config on) and consultant sees it in co-sign queue.
7. Given a photo/video captured without recording consent, then capture is disabled and the UI explains why; with consent, media is stored encrypted and its presigned URL expires in ≤ 5 min.
8. Given day-30 check-in response "fever + discharge", then a complication task appears in the nurse queue within 1 min and the doctor is notified.
9. Given a complication graded Clavien-Dindo IIIb, when saved, then an NC-015 incident draft is created and linked.
10. Given a specimen recorded during biopsy, then an OP-004 lab order and label are generated before completion can be saved without a specimen-label override.
11. Given equipment E1 goes to breakdown in NC-020, then future bookings using E1 are flagged and receptionist receives a re-book task list.
12. Given a user with only `procedure.worklist.read`, when they PUT a note, then 403 and audit entry.
13. Given a completed procedure, then the OP bill shows procedure fee, consumables, sedation and room lines grouped, and NC-034 doctor share is computed on the fee only.
14. Given a wrong-patient scan at check-in (booking UHID ≠ scanned UHID), then a hard-stop dialog appears and no state change occurs.

## 15. Enhancements / Later phases
- From sheet row 17 enhancements: risk scoring & informed-consent auto-generation from patient risk factors (Phase 12 AI-002 with EN-028), real-time procedure video recording (Phase 8 flag `procedure.video_recording` via EN-042 capture; streaming later), 30-day complication tracking (Phase 8 core above), evidence-linked procedure templates (EN-039 with citations, Phase 8), PROMs (EN-030, Phase 10).
- Costed proposal line 1565: scheduling, pre-procedure checklist, consent capture, documentation, consumables, photo/video, billing — all core.
- (market) SmartHospital video consent, per-procedure linking; MocDoc service procedure management; PCS Prodoc procedure two-level authorisation — folded in (co-sign, video consent).
- Later: IVR check-ins (EN-033), voice dictation (AI-004), OT-lite integration for minor OT with WHO checklist reuse (IP-006), telemedicine follow-up (OP-018).

## 16. Open Questions for the Hospital
1. List of OPD/day-care procedures with fees, default kits, durations, rooms, and which require consent/sedation/fasting/labs.
2. Consent policy: languages, witness rules, LAR rules for minors, validity period (default 30 days), Aadhaar eSign needed? Video consent wanted?
3. Sedation: who may sedate in OPD (anaesthetist only?), monitoring standard, discharge scoring (Aldrete vs PADSS)?
4. Consumable billing: itemised vs included in fee; high-value scan-only threshold; separate sub-store per room?
5. Photo/video: which specialties record; retention; watermarking/export rules; capture hardware (tablet camera vs capture card)?
6. 30-day check-in channels (WhatsApp/IVR/call centre) and question sets; who triages responses?
7. Day-care/insurance: which procedures billed as day-care packages; document bundle required by TPAs?
8. Doctor share rules for procedure fees (NC-034) and resident co-sign policy.
