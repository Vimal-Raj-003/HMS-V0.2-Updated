# TR-003 — Implant & Prosthetics Management (UDI/serial/batch registry, consignment link, patient-implant traceability, recall, implant card)

| Field | Value |
|---|---|
| Domain | Trauma & Orthopaedics |
| Module ID | TR-003 |
| Phase | 6 |
| Priority | P0 |
| Complexity | High |
| Depends on | NC-006 (Stores/Inventory — item master, batches, stock ledger for owned implants), NC-007 (Consignment Management — vendor consignment stock, usage-based billing, auto-PO; TR-003 is the clinical traceability layer, NC-007 the commercial one), NC-005 (purchase), NC-021 (vendor master), TR-004/IP-006 (OT usage capture — implant scan in theatre), OP-010 (OPD/minor-OT implants e.g. K-wires, dental/IOL via OP-026/OP-025), TR-002 (fracture linkage), IP-005/OP-005 (implant charges, MRP/GST/HSN), EN-002/RC-007 (implant approval in pre-auth/PMJAY packages), EN-013 (barcode/2D scanners, GS1 parsing), EN-003 (CSSD tray link for loaner/instrument sets), OP-008 (MR-safety check), IP-012 (SSI/implant infection), NC-020 (biomedical/vigilance link), EN-009/EN-032 (recall communications), PE-001 (patient implant card), NC-003 (MRD), TR-011 (registry), EN-024 (audit) |
| Feature flag | `module.implants.enabled` (sub: `implants.udi_gs1`, `implants.consignment_link`, `implants.recall`, `implants.patient_card`, `implants.loaner_sets`, `implants.explant_tracking`) |
| Primary roles | Nurse — OT/Scrub (20), Surgeon (9), Stores Keeper / Implant store in-charge (44), Pharmacy/Consignment coordinator (32/44), Billing (27) |
| Secondary roles | Anaesthetist (10, view), Orthopaedic OPD doctor (6), Radiologist (12, MR-safety), Purchase (45), Vendor (63, consignment portal), Quality (54, recall/vigilance), Biomedical (48, MvPI reporting), MRD (43), Patient (59, implant card), TPA (62, implant invoice/UDI evidence), Auditor (58) |
| Regulatory | CDSCO Medical Devices Rules 2017 (as amended 2020) — Class C/D implants licensing, **UDI** requirement (Rule 44 & GSR notifications: UDI-DI + UDI-PI on labels), GS1 standards (GTIN-14, AI(01)/(10) lot/(17) expiry/(21) serial in GS1-128/DataMatrix; also HIBCC), Materiovigilance Programme of India (MvPI, IPC Ghaziabad) adverse-event reporting, CDSCO product recall/field safety notices, NABH 5th ed. COP/MOM (implant traceability, informed consent incl. implant cost), IRDAI/insurer implant invoice & sticker requirements, PMJAY implant packages (HBP), GST/HSN 9021 (implants), NPPA price caps (knee implants, coronary stents — MRP display), Consumer Protection Act (implant records ≥ 15 y / device lifetime), ISO 13485 traceability expectations, EU MDR-style implant card (adopted for global readiness), DPDP Rules 2025 |

## 1. Purpose
TR-003 gives the hospital an authoritative **implant & prosthetics registry**: every implantable device (orthopaedic plates/screws/nails/prostheses, spinal hardware, dental/ocular/cardiac/other implants) is identified by CDSCO/GS1 UDI, serial, batch and expiry from receipt (owned or consignment via NC-007) through OT/procedure use (scan-to-patient), billing, patient implant card, explant/revision, and **recall/field-safety workflows** that can list every patient with an affected lot in seconds. It enforces expiry/sterility checks at scan time, MR-safety visibility for radiology, and materiovigilance reporting, and it feeds registry/quality (TR-011) and insurer documentation.

## 2. Users & Jobs-to-be-done
- **Scrub/circulating nurse** (OT tablet or wall PC with 2D scanner; gloves): scan implant DataMatrix at time of implantation → patient/side/site linked instantly, sterile-expiry/recall check, sticker photo fallback; record wasted/opened-not-used items.
- **Surgeon** (tablet): pre-op implant plan (family/size range, loaner set request), intra-op confirmation, op-note implant list auto-populated, revision/explant documentation.
- **Implant store keeper / consignment coordinator** (desktop + handheld): receive implants (owned GRN or consignment stock-in) with UDI parsing, shelf/kit location, expiry watch, loaner set check-in/out, physical count, vendor reconciliation with NC-007.
- **Billing / TPA desk** (desktop): implant charge with MRP/sticker/invoice evidence for insurer/PMJAY, price-cap validation.
- **Radiology** (desktop): MR-safety status of implants before MRI (OP-008 checks TR-003).
- **Quality / biomedical** (desktop): recall intake (vendor notice/CDSCO alert), affected patients list, contact tasks, MvPI adverse-event form, closure.
- **Patient** (PE-001/OP-020 phone): implant card (device, UDI, date, surgeon, hospital contact) & recall notification.
- **Vendor** (portal 63): consignment stock, usage acknowledgements, recall notices upload.

## 3. Core Workflows

### 3.1 Implant catalogue & receipt
1. **Store keeper** receives implants: owned purchase → NC-006 GRN; consignment → NC-007 stock-in; in both, each unit/pack scanned → **System** parses GS1 barcode (AI 01 GTIN → device master match; AI 10 lot; AI 17 expiry; AI 21 serial; HIBCC/`+` prefix support; non-UDI legacy → manual entry with `udi_missing` flag) → creates `implant_units` (one row per serialised unit; per lot with qty for non-serialised screws) with location (implant store shelf/kit/loaner set), ownership (owned/consignment/loaner), cost, MRP, sterile expiry → Event `implant.received`.
2. **Device master** (`implant_devices`): manufacturer, brand, model, GTIN/UDI-DI, category (plate/screw/nail/prosthesis component/spinal/ex-fix/dental/ocular/cardiac/mesh/other), material, size attributes, MR-safety (safe/conditional/unsafe with conditions), CDSCO licence no/class, HSN, NPPA cap flag, single-use bool, sterilisation status (sterile/needs CSSD), lifetime years, IFU file, vendor(s), tariff link (RC-003), PMJAY package mapping.
3. **Loaner sets** (`implants.loaner_sets`): vendor brings set for a case → check-in with contents list & CSSD sterilisation (EN-003) → post-case check-out with used items reconciled → vendor invoice trigger via NC-007.
4. Expiry/near-expiry watch (90/60/30 days) → return-to-vendor (consignment) or write-off (owned) via NC-007/NC-006; FEFO pick suggestion.

### 3.2 Pre-op planning & availability
1. **Surgeon** on fracture plan (TR-002) or OT booking (TR-004/IP-006) selects **implant family/size range** and quantity estimate → **System** checks availability across owned/consignment/loaner (by size), shows expiry, reserves units (soft reservation with expiry at case end) → shortage → consignment request to vendor (NC-007 auto-indent) with case date → confirmation status on OT board.
2. Estimate/pre-auth: implant MRP + GST flows to RC-008 estimate and EN-002 pre-auth (implant invoice requirement flag), PMJAY HBP implant package check (RC-007).

### 3.3 Intra-op usage capture (scan-to-patient)
1. **Scrub/circulating nurse** in OT case (TR-004/IP-006 op-record open) scans implant pack DataMatrix → **System** validates: unit exists (or creates ad-hoc from UDI with `unregistered_receipt` alert), **not expired**, **not recalled/quarantined**, sterile, matches planned side/site (warn), not already implanted elsewhere (serialised) → records `implant_usage` (patient, case, surgeon, site SNOMED, side, position e.g. "distal locking screw 2", implanted_at, scanned_by, ownership) → deducts stock (owned: NC-006 ledger; consignment: NC-007 usage → auto-PO) → **charge intent** to IP-005/OP-005 (MRP or contract price per payer, GST/HSN, sticker image) → Event `implant.used`.
2. **Sticker photo fallback**: no scanner/damaged code → camera capture of pack label + manual UDI/lot entry, flagged `manual_entry` for audit; two-person verify for high-value prosthesis.
3. **Wasted/opened-not-used/contaminated**: recorded with reason → billing rule (chargeable? default no) → consignment vendor claim/owned write-off.
4. **Explant/revision**: scan or select existing implant in patient → mark explanted (date, reason: infection/loosening/breakage/malposition/planned removal), retained for lab/MvPI or returned to patient/disposed (BMW) → new implant linked as replacement → Event `implant.explanted`.
5. Op-note (IP-006) implant table auto-fills; surgeon confirms count matches nurse log before sign (mismatch hard-stop).
6. **Offline**: OT tablet caches device master + reservations; scans queue with local validation (expiry/recall from cached list ≤ 4 h old, else warn) and sync.

### 3.4 Patient implant record & card
- Patient banner/implant tab lists all active implants (device, UDI, site/side, date, surgeon, MR-safety, lifetime); **implant card** PDF/wallet-pass (EU-MDR style: device name, type, model, serial/lot, UDI, manufacturer, hospital, date, surgeon, helpline, QR to portal) printed at discharge and available in PE-001/OP-020; SMS/WhatsApp link (EN-009). MRI orders check this list (OP-008).

### 3.5 Recall / field safety notice
1. **Quality/store** creates recall from vendor FSN or CDSCO alert: device(s), lots/serial ranges, hazard, action (quarantine/return/monitor patients/explant advice) → **System** quarantines matching stock instantly (blocks scans), lists **affected patients** (usage rows by UDI-DI + lot/serial) with contact details, surgeon, follow-up status → creates contact tasks (call/SMS/letter templates; portal notice) → surgeon review outcome per patient (no action/monitor/imaging/revision) → vendor return/credit note (NC-007/NC-005) → closure report → Events `implant.recall.opened|patient_flagged|closed`.
2. **Adverse event / MvPI**: implant failure/infection/reaction → MvPI form (Medical Device Adverse Event Reporting Form) pre-filled from usage record → submit (email/portal via EN-032/EN-017) → track; link to NC-015 incident and TR-002 complication.

### 3.6 Reconciliation & audit
1. **Monthly consignment reconciliation** (NC-007) uses TR-003 usage rows as source of truth: vendor statement (upload/portal) matched to `implant_usage` by UDI/lot/serial → matched / hospital-only / vendor-only lists → discrepancy tasks (missing scan, wrong price, duplicate) → sign-off by store in-charge + accounts → Event `implant.reconciliation.closed`.
2. **Physical count**: handheld scan of implant store/kits → variance vs `implant_units` → adjustments with reason (owned → NC-006 stock adjustment; consignment → vendor variance note).
3. **Audits**: manual-entry usages (supervisor verify ≤ 24 h), usage-without-charge & charge-without-usage (RC-006), expired units still in stock, reservations never released, MR-safety unknowns; results in monthly implant governance pack for MS/quality.

### 3.7 OPD / minor-OT & non-ortho implants
- K-wires, external fixator pins, dental fixtures (OP-026), IOLs (OP-025), stents/pacemakers (OP-029 cath lab), meshes: same usage capture via OP-010 procedure record; category-specific card fields (IOL power, pacemaker model/mode, MR conditions); MR-safety chips per implant; billing at procedure level.

### 3.8 Exceptions & edge cases
1. **Emergency use of unregistered implant** (vendor brings unknown item at night): scan creates ad-hoc device with photo, flagged `unregistered_receipt`; usage allowed (Class C/D requires surgeon override reason); store curates next day; billing held at MRP from label until price confirmed (RC-006 flag).
2. **Barcode encodes multiple packs (kit)**: parse kit GTIN → prompt to select components used; each component logged separately with kit reference.
3. **Implant opened, then case cancelled**: opened-not-used → sterile-breach → vendor claim (consignment) or write-off (owned) with reason; not billed.
4. **Same lot both owned & consignment**: ownership chosen at scan from unit record (unit-level ownership); FEFO suggests earliest expiry regardless, but consignment preferred if policy `prefer_consignment=true`.
5. **Revision surgery with partial explant** (e.g. one screw of a plate construct): explant per unit/qty; construct integrity note; new components linked to same fracture.
6. **Patient transferred out with recall pending**: recall contact task remains with hospital; letter to receiving hospital via IP-018 packet.
7. **Bilateral procedures**: side mandatory per scan; UI shows side toggle prominently; scans without side blocked for paired sites.
8. **Deceased patient in recall list**: status `deceased` from IP-017 → no contact, documented in closure.

### 3.9 Migration & catalogue curation
- Initial load: import existing implant registers (EN-036) with UDI where present, else manufacturer/model/lot; flag `legacy` for cards; catalogue curation queue for ad-hoc devices created in OT (store keeper completes MR-safety, HSN, MRP within 48 h; unresolved > 7 days escalates).

## 4. Data Model (schema `trauma`; inventory ledgers in `inventory` via NC-006/NC-007)
- **implant_devices**: id, hospital_id?, (null = global catalogue), manufacturer, brand, model, description, gtin/udi_di text unique, issuing_agency enum(gs1/hibcc/iccbba/other), category enum(...), subcategory, material, size_attrs jsonb, mr_safety enum(safe/conditional/unsafe/unknown), mr_conditions text, cdsco_licence_no, device_class enum(A/B/C/D), hsn, is_single_use, sterile_supplied bool, lifetime_years, ifu_file_id, nppa_capped bool, mrp numeric(14,2), item_id? (NC-006), tariff_service_id? (RC-003), pmjay_package_codes text[], is_active.
- **implant_units**: id, hospital_id, branch_id, device_id, udi_pi_raw text, serial?, lot?, expiry date?, manufacture_date?, ownership enum(owned/consignment/loaner), vendor_id, consignment_stock_id? (NC-007), grn_id? (NC-006), loaner_set_id?, location_id, kit_id?, qty_available numeric (1 for serialised), cost numeric(14,2), mrp numeric(14,2), status enum(in_stock/reserved/implanted/wasted/returned/expired/quarantined/explanted_retained), reserved_for_case_id?, received_at, sterilised_at? (EN-003 cycle_id). Unique (device_id, serial) where serial not null. Index (hospital_id, device_id, lot), (expiry), (status).
- **implant_usage**: id, hospital_id, branch_id, patient_id, encounter_id, ot_case_id? (TR-004/IP-006), procedure_id? (OP-010), fracture_id? (TR-002), unit_id?, device_id, udi_di, udi_pi_raw, serial?, lot?, expiry, ownership, vendor_id, surgeon_id, scanned_by, implanted_at, body_site_snomed, side enum(left/right/bilateral/midline/na), position_label, qty numeric, entry_mode enum(scan/manual/photo), label_photo_file_id?, verified_by? (2-person), status enum(implanted/explanted/wasted/opened_not_used), explanted_at?, explant_reason?, explant_disposition enum(retained/returned_to_patient/disposed/sent_to_lab)?, replaced_by_usage_id?, charge_intent_id?, bill_item_id?, price_charged numeric(14,2), gst_rate, sticker_required bool, is_recall_affected bool, notes. Index (hospital_id, patient_id), (udi_di, lot), (serial), (ot_case_id).
- **implant_reservations**: case_id, device_id/family, size_range, qty, unit_ids uuid[], status enum(requested/reserved/vendor_requested/confirmed/released), requested_by, expires_at.
- **loaner_sets**: id, vendor_id, case_id?, set_name, contents jsonb, checked_in_at/by, cssd_cycle_id (EN-003), checked_out_at/by, used_units uuid[], discrepancies jsonb.
- **implant_recalls**: id, hospital_id?, source enum(vendor_fsn/cdsco/internal/global_feed), reference_no, device_ids uuid[], lot_patterns text[], serial_ranges jsonb, hazard, action_required enum(quarantine/return/monitor/explant_advice/info_only), opened_at, opened_by, status enum(open/in_progress/closed), closure_report_doc_id, closed_at.
- **implant_recall_patients**: recall_id, usage_id, patient_id, contact_status enum(pending/contacted/unreachable/declined), contact_log jsonb[], surgeon_review enum(pending/no_action/monitor/imaging/revision_planned/revised), reviewed_by, reviewed_at.
- **implant_adverse_events**: id, usage_id, event_type, description, mvpi_form jsonb, submitted_at, reference_no, incident_id (NC-015), complication_id (TR-002).
- **implant_cards**: patient_id, usage_ids uuid[], version, pdf_file_id, issued_at, delivered_via text[].
- Audit/append-only: `implant_usage` edits create versions (`implant_usage_versions`); retention ≥ 15 y or lifetime + 2 y (never hard-deleted).

## 5. Business Rules & Validations
- Every implant usage must carry UDI-DI (GTIN) **or** manufacturer + model + lot/serial with `udi_missing` reason; hospitals may set hard-block for Class C/D without UDI (default: block for prostheses/spinal, warn for screws/K-wires).
- Scan-time hard-stops: expired sterile date; recalled/quarantined; serialised unit already implanted; device flagged inactive. Soft warnings: side/site mismatch with plan; unregistered unit; MRP missing; NPPA cap exceeded (block charge above cap).
- Serialised prosthesis components require **two-person verification** (scrub + circulating) unless `implants.two_person_verify=false` per hospital.
- Op-note sign blocked while nurse implant log ≠ surgeon confirmed list (count/UDI); mismatch resolution recorded.
- Charge rule: chargeable at MRP (retail) or payer contract price; wasted items non-chargeable unless policy; consignment usage generates NC-007 usage → auto-PO/GRN in same transaction outbox; owned usage decrements NC-006 batch (FEFO by expiry).
- Explant requires reason & disposition; retained explants for MLC/MvPI logged with custody (TR-008 evidence service if MLC).
- Recall: quarantine applies across all branches; affected-patient list generated within 60 s; contact within SLA (default 7 days) tracked; closure requires all patients with a review outcome or MS sign-off for unreachable.
- MR-safety: implant with `unsafe/unknown` blocks MRI order in OP-008 unless radiologist override.
- Consent: implant type/brand/cost must appear on surgical consent (EN-028 template variable) — pre-op check.
- Numbering: implant card version per patient; recall reference series `RECALL`.
- Immutability: usage rows editable only via versioned correction with reason (billing re-post automatically).
- Multi-branch: device catalogue shared at group level (EN-041); units/usage per branch.

## 6. API Surface (`/api/v1/implants`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /barcode/parse | parse GS1/HIBCC → device/lot/serial/expiry | implant.unit.read | – | – |
| GET/POST/PATCH | /devices[/{id}] | device catalogue | implant.device.read / implant.device.manage | Y | cursor |
| POST | /units/receive | receive units (owned/consignment/loaner) | implant.unit.receive | Y | – |
| GET | /units?device=&lot=&status=&location=&expiring_before= | stock view | implant.unit.read | – | cursor |
| POST | /units/{id}/quarantine|release|return|writeoff | status changes | implant.unit.manage | Y | – |
| POST | /reservations | reserve for case | implant.reservation.create | Y | – |
| GET | /reservations?case= | status | implant.reservation.read | – | – |
| POST | /loaner-sets, /loaner-sets/{id}/check-out | loaner lifecycle | implant.loaner.manage | Y | – |
| POST | /usage | record usage (scan/manual/photo) | implant.usage.create | Y | – |
| POST | /usage/{id}/verify | 2nd person verify | implant.usage.verify | Y | – |
| PATCH | /usage/{id} | correction (new version, reason) | implant.usage.update | Y | – |
| POST | /usage/{id}/explant, /waste | explant / waste | implant.usage.create | Y | – |
| GET | /patients/{patientId}/implants | patient implant list (MR-safety) | implant.usage.read | – | – |
| POST | /patients/{patientId}/implant-card | generate/send card | implant.card.issue | Y | – |
| GET | /cases/{caseId}/usage | case implant log | implant.usage.read | – | – |
| POST | /recalls, PATCH /recalls/{id} | open/manage recall | implant.recall.manage | Y | – |
| GET | /recalls/{id}/patients | affected list | implant.recall.read | – | cursor |
| POST | /recalls/{id}/patients/{pid}/contact|review | contact/review | implant.recall.manage / surgeon | Y | – |
| POST | /adverse-events | MvPI report | implant.vigilance.report | Y | – |
| GET | /reports/traceability?udi=&lot=&serial= | trace lot/serial → patients | implant.trace.read | – | cursor |
| GET | /reports/usage-unbilled, /reports/manual-entries, /reports/expiry | audits | implant.report.read | – | cursor |
| Vendor portal: GET /vendor/consignment, POST /vendor/recall-notice | (63) | implant.vendor.portal | Y | cursor |

## 7. Domain Events (outbox)
- `implant.received` {unit_id, device, lot, expiry, ownership} → NC-006/NC-007 ledgers, expiry watch.
- `implant.reserved|reservation.released` → TR-004 OT board readiness.
- `implant.used` {usage_id, patient_id, case_id, udi_di, lot, serial, site, side, price, ownership} → IP-005/OP-005 charge, NC-006 deduct / NC-007 usage→auto-PO, TR-002 surgery event, IP-006 op-note table, TR-011, PE-001 card, RC-006 leakage check.
- `implant.usage.corrected` → billing re-post, audit.
- `implant.explanted` {reason, disposition} → TR-002 complication?, IP-012 (infection), MvPI prompt, PE-001 card update.
- `implant.wasted` → NC-007 vendor claim / NC-006 write-off.
- `implant.recall.opened` {device_ids, lots} → stock quarantine, TR-004 (blocked in OT), OP-008 (MRI safety), Quality; `implant.recall.patient_flagged` → contact tasks (EN-037/EN-009); `implant.recall.closed`.
- `implant.adverse_event.reported` → NC-015 incident, TR-011.
- `implant.expiring` {unit_id, days} → NC-007 return workflow.
- Consumes: `inventory.grn.posted` (NC-006), `consignment.stock_in` (NC-007), `ot.case.started|completed|signed` (TR-004/IP-006), `procedure.completed` (OP-010), `cssd.cycle.completed` (EN-003 loaner sterilisation), `bill.item.posted` (link bill_item_id).

## 8. Screens (UI)
- **OT implant capture panel** (embedded in TR-004/IP-006 op record; OT wall PC/tablet + 2D scanner): scan field always focused, big green/red validation result with reason (expired/recalled/mismatch), running implant list with position labels and side, count summary vs plan, photo fallback button, 2-person verify prompt; shortcuts `F2` focus scan, `W` waste, `X` explant, `Ctrl+Enter` confirm; offline banner & queue; audio beep on scan pass/fail.
- **Implant store console** (desktop + handheld PWA): receive (scan-parse form), stock by device/size/expiry (heat-map of near-expiry), locations/kits, loaner set check-in/out with contents, physical count mode, reservation queue for upcoming OT list, consignment vs owned toggle; `R` receive, `F` find by UDI.
- **Device catalogue admin** (desktop): device master with UDI-DI, MR-safety, HSN/MRP/NPPA cap, PMJAY mapping, IFU upload; import CSV/GUDID-like feeds.
- **Patient implant tab** (desktop/tablet; part of banner): list with MR-safety chips, explant history, print/send implant card; portal/phone view for patients.
- **Recall console** (desktop): open recall wizard (device/lot/serial), impact summary (units quarantined, patients affected), patient list with contact/review status, letters/SMS templates, closure report; real-time counters.
- **Traceability search** (desktop): enter UDI/lot/serial → units + patients + cases + bills; export (audited).
- **Vendor portal page** (web, role 63): consignment stock, usage acknowledgements, upload FSN.
- Print: implant card (A6/wallet + PDF), implant sticker sheet for insurer file, OT implant log, recall letters.
- Empty/error states: "no implants recorded", scanner not detected (manual entry), device unknown (create ad-hoc with photo).

## 9. Integrations
- Barcode: GS1-128/DataMatrix/HIBCC parsing library in `packages/barcode` (EN-013); wedge scanners (keyboard) and camera (ZXing) fallback; label printers for shelf tags.
- NC-006/NC-007/NC-005 ledgers & POs; EN-003 CSSD cycles for loaner sets; IP-005/OP-005 charges; EN-002/RC-007 pre-auth & PMJAY implant packages; OP-008 MR-safety query; TR-002/TR-004/IP-006/OP-010 usage sources; PE-001/OP-020/EN-009 implant card delivery; EN-032 e-mail MvPI/vendor; EN-017 optional GUDID/CDSCO UDI database lookup & vendor EDI; RC-006 leakage audit; TR-011 registry export (implant fields).
- Fallbacks: parse failure → manual fields; catalogue miss → ad-hoc device pending curation; network down in OT → cached master + queued usage; scanner failure → camera/photo.

## 10. Reports & Analytics
- Implant usage by device/vendor/surgeon/procedure; consignment vs owned mix and value; expiry/write-off & wasted cost; manual-entry rate (target < 2 %); usage-without-charge (leakage) & charge-without-usage; recall register & patient contact SLA; explant/revision rate by device (survivorship curves for prostheses — Kaplan-Meier at 1/2/5 y); MvPI reports; loaner set turnaround; MR-safety unknowns; PMJAY implant package variance.
- Read models: `analytics.mv_implant_usage_monthly`, `analytics.mv_implant_survivorship`, `analytics.mv_implant_stock_expiry`, `analytics.mv_recall_status`.

## 11. Notifications
- OT nurse/surgeon: scan failures (expired/recalled), count mismatch at sign; store: reservation shortages, vendor confirmations, near-expiry (90/60/30 d), loaner return due.
- Recall: quality/MS/surgeons (in-app + email), affected patients (SMS/WhatsApp/letter templates, DLT-registered), vendor acknowledgement.
- Patient: implant card link post-discharge, MRI safety reminder, revision follow-up.
- Billing/TPA: implant charge with sticker attachment; PMJAY package mismatch.

## 12. Permissions (RBAC keys)
`implant.device.read|manage`, `implant.unit.read|receive|manage`, `implant.reservation.create|read`, `implant.loaner.manage`, `implant.usage.create|read|update|verify`, `implant.card.issue`, `implant.recall.read|manage`, `implant.vigilance.report`, `implant.trace.read`, `implant.report.read|export`, `implant.vendor.portal`, `implant.configure`.
Defaults: Scrub/OT nurse (20): usage.create/verify/read, unit.read, reservation.read; Surgeon (9): usage.read/create (confirm), reservation.create, card.issue, recall.read (own patients review); Store keeper (44)/consignment coordinator: device.read, unit.*, loaner.*, reservation.*, report; Purchase (45): device.manage, unit.read; Billing (27)/TPA desk (28): usage.read, report; Radiologist (12): usage.read; Quality (54)/Biomedical (48): recall.manage, vigilance.report, trace.read, report.export; MRD (43): usage.read; Patient (59): own card; Vendor (63): vendor.portal; Admin: configure; Auditor: read.

## 13. Non-functional
- Volumes: 60–100 implant cases/day, 400–800 units scanned/day, 20k device SKUs, 500k usage rows over 5 y; recall query over 500k rows < 2 s (index on udi_di, lot, serial).
- p95: barcode parse < 20 ms, usage create incl. validations < 200 ms, patient implant list < 100 ms, recall patient list < 2 s.
- Offline: OT capture works offline ≥ 4 h with cached catalogue/recall list; sync idempotent by (case_id, udi_pi_raw, seq).
- Printing: implant card A6/PDF, sticker sheets; wallet pass optional.
- Accessibility: large scan status; audible feedback; colour + text.
- Security: PHI in recall lists restricted; vendor portal sees no patient identity (usage counts only); audit every manual entry, correction, export.
- i18n: implant card bilingual; device names as printed on label (no translation).

## 14. Acceptance Criteria
1. Given a GS1 DataMatrix `(01)08901234567893(17)270331(10)LOT77(21)SN0091`, when parsed, then GTIN, expiry 2027-03-31, lot LOT77, serial SN0091 are extracted and matched to the device master; unknown GTIN offers ad-hoc device creation.
2. Given a unit with expiry 2026-05-31 scanned in OT on 2026-08-16, then usage is blocked with "expired" and the event is audited; override is not possible.
3. Given a lot under open recall, when scanned, then usage is blocked, unit auto-quarantined, and quality is notified.
4. Given a serialised femoral stem already implanted in patient A, when scanned for patient B, then a hard-stop "already implanted" appears.
5. Given a consignment plate scanned to a patient, then `implant.used` triggers NC-007 usage → auto-PO, an IP-005 charge at contract price with HSN 9021 and GST, and TR-002 receives a surgery event with the implant.
6. Given a prosthesis component (Class D) scanned without 2nd verification, then op-note sign is blocked until verify is completed.
7. Given surgeon confirmed list has 6 screws and nurse log has 7, then op-note sign is blocked with mismatch resolution required (waste/opened-not-used or correction).
8. Given OT tablet offline for 2 h, then scans validate against cached expiry/recall data, queue locally, and sync without duplicates when online; usages created offline are flagged for review if the recall list was > 4 h old.
9. Given a recall for lots LOT77–LOT80 of a device, then within 60 s all in-stock units are quarantined across branches and the affected-patient list (with surgeon and contact) is generated; each patient gets a contact task; closure blocked until all reviewed or MS sign-off.
10. Given a patient with an "MR unsafe" implant, when MRI is ordered in OP-008, then the order is blocked pending radiologist override citing TR-003 record.
11. Given discharge of an implant patient, then the implant card PDF (device, UDI, serial/lot, date, surgeon, hospital contact, QR) is generated, printed and sent to portal/WhatsApp; the card lists all active implants only.
12. Given explant of a plate for infection, then the usage is marked explanted with reason/disposition, IP-012 infection link offered, MvPI prompt shown, and card version updated.
13. Given traceability search by lot, then all units, patients, cases and bill items are listed and the export is audited with counts.
14. Given a knee implant with NPPA cap ₹X, when billing at MRP > cap, then charge is blocked above cap.
15. Given a manual (photo) entry, then it is flagged `manual_entry`, appears in the monthly manual-entry audit report, and requires supervisor verification within 24 h.
16. Given a loaner set checked in with 40 items and CSSD cycle completed, when 3 items are used and set checked out, then discrepancy report shows 37 returned, and NC-007 vendor invoice trigger lists exactly 3 used items.
17. Given a vendor monthly statement with 52 items and hospital usage of 50 for that vendor, when reconciled, then 2 vendor-only lines appear as discrepancies, sign-off is blocked until resolved, and closure emits `implant.reconciliation.closed`.
18. Given an ad-hoc device created in OT at 22:00, then it appears in the curation queue; if MR-safety/HSN remain empty after 7 days, the store in-charge and quality receive an escalation.
19. Given a usage correction (wrong side recorded), then a new usage version is created with reason, the original is retained, billing is re-posted only if price/qty changed, and TR-002 event is updated.
20. Given the vendor portal user views consignment usage, then only counts, UDIs, lots and dates are shown; no patient identifiers are present in the response payload.
21. Given a kit GTIN scanned, then the component picker lists kit contents and each used component is logged with its own UDI-PI and kit reference; unused components remain in stock.
22. Given a bilateral TKR case, then each component scan requires side selection and the op-note implant table shows left/right groups; a scan without side is blocked.
23. Given an implant opened and the case cancelled after induction, then marking opened-not-used creates a vendor claim (consignment) and no patient charge; the audit shows reason and user.

## 15. Enhancements / Later phases
- From VIMS sheet (row 25 OT & row 36 consignment enhancements): implant recall & patient notification (Phase 6 here), implant registry with patient trace (here), vendor auto-billing on consumption (NC-007), expired item auto-return (NC-007), robot-assisted surgery documentation (IP-006 later).
- (market) Competitor HMS have consignment/implant logs but no UDI recall workflows — TR-003 adds: RFID cabinet integration for implant rooms (EN-042, Phase 12); GUDID/CDSCO UDI database auto-lookup (EN-017); vendor EDI for consignment replenishment; joint-registry submissions (e.g. Indian Society of Hip & Knee Surgeons registry) via TR-011; wallet-pass implant card; AI anomaly detection on usage vs billing (AI-005); explant analysis lab workflow; 3D-printed patient-specific implant traceability (Phase 12+).

## 16. Open Questions for the Hospital
1. Which implant categories are in scope at go-live (ortho/spinal only vs dental, ocular IOL, cardiac stents/pacemakers, mesh)?
2. Consignment vs owned share; list of consignment vendors and whether vendors bring loaner sets; CSSD process for loaners.
3. Scanners in OT (2D wedge? camera tablets?), and current UDI compliance level of vendors (legacy stickers without GS1?).
4. Two-person verification policy and which device classes require it.
5. Charging policy: MRP vs contract price per payer; wasted implant charge policy; PMJAY package inclusions.
6. Recall SLA (patient contact days), letter templates, who signs closure; MvPI reporting responsibility (biomedical vs quality).
7. Implant card format/languages and delivery channels; wallet pass needed?
8. Explant policy: return to patient / retain / dispose; MLC retention.
9. Retention period beyond 15 y? Group-level shared catalogue across branches?
10. Existing implant records to migrate (EN-036) — format and completeness (UDI available?).
11. Preferred ownership priority when both owned and consignment stock exist for the same device (`prefer_consignment`)?
