# EN-013 — Barcode / QR Module (GS1 Identifiers, Wristbands, Labels, Verification, Scanner Input Handling, Camera Scan in PWA)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-013 |
| Phase | 0/1 |
| Priority | P0 |
| Complexity | Low–Medium |
| Depends on | EN-005 (label/wristband printers, ZPL), EN-039 (label templates), EN-007 (numbering series, devices), EN-024 (audit), consumers: OP-001 (patient cards, wristbands), OP-004 (sample labels), OP-003/IP-014 (medication labels, batch scan), IP-003/IP-004 (bedside 5-Rights verification), IP-007 (blood bag ISBT 128), TR-003 (implant UDI), NC-006/NC-005 (item/batch/GRN scan), NC-002 (asset tags), EN-003 (CSSD packs), EN-006 (token QR), NC-003 (MRD file barcodes), OP-005 (receipt QR), EN-015 (visitor pass QR), EN-034 (kiosk scan), EN-012 (report verify QR) |
| Feature flag | `module.barcode.enabled` (sub: `barcode.gs1`, `barcode.camera_scan`, `barcode.rfid`) |
| Primary roles | Nurse (17), Phlebotomist (34), Lab Technician (33), Pharmacist (30/31), Stores Keeper (44), CSSD Technician (38), Receptionist (24), Biomedical (48), MRD (43) |
| Secondary roles | IT Admin (symbology/label config), Doctor (scan patient to open chart), Security (pass scan), Patient (report QR) |
| Regulatory | NABH PSQ/patient identification (≥ 2 identifiers on wristband: name + UHID/DOB; colour-coded alert bands: red allergy, yellow fall risk, purple DNR per policy), GS1 standards (GTIN, GS1-128 AIs: (01) GTIN, (10) batch, (17) expiry, (21) serial, (240) additional id; GS1 DataMatrix), CDSCO UDI (implants/devices) & DAVA drug track-and-trace (GTIN+batch+expiry+serial 2D on packs), ISBT 128 (blood components), CLSI AUTO02/AUTO12 (specimen labels), DPDP (minimal PHI on labels/QR), Drugs & Cosmetics Rules (dispensing label content) |

## 1. Purpose
EN-013 standardises identification and machine-readable labels across the HMS: identifier schemes (UHID, visit, sample accession, medication dispense, item/batch, asset, pack, blood bag, token, document) encoded as Code128/GS1-128/GS1 DataMatrix/QR with a uniform **scan resolver** that decodes any scan (USB HID wedge, Bluetooth, camera in PWA, RFID later) into an HMS entity and routes to the correct action; wristband generation and bedside verification (patient ↔ medication/sample/blood/transfusion), label templates and printing (via EN-005), external barcode ingestion (GS1 drug packs, UDI implants, ISBT 128 blood, vendor GTIN), and verification/authenticity QRs on documents.

## 2. Users & Jobs-to-be-done
- **Nurse** (tablet/phone + scanner or camera): scan wristband → scan medication → 5-Rights confirmation; scan sample label at bedside; scan blood bag + wristband two-person check.
- **Phlebotomist/lab tech**: print sample labels, scan to collect/receive/rack, scan analyzer racks.
- **Pharmacist/stores**: scan GS1 2D on drug packs to auto-fill GTIN/batch/expiry at GRN and dispense; FEFO pick verification; item bin labels.
- **Receptionist**: print patient card/wristband; scan card/QR/ABHA to open patient; token QR.
- **CSSD/OT**: pack labels and point-of-use scan (EN-003); implant UDI scan (TR-003).
- **Biomedical/assets**: asset tag print/scan for audits.
- **IT Admin**: symbology & label templates, scanner profiles, prefix/suffix config, camera scan settings.

## 3. Core Workflows

### 3.1 Identifier scheme & encoding
1. Each entity type has an **ID scheme** (`bc_schemes`): prefix/AI, payload format, symbology, check digit, label template. Defaults: UHID → Code128 `P` + UHID (and QR with JSON `{t:"pt",u:UHID}`); visit/token → QR deep link; sample container → Code128 `accession-seq` (CLSI: ≤ 16 chars, quiet zones) + optional DataMatrix; medication dispense → GS1 DataMatrix (01)(10)(17)(21) or internal `RX-<id>`; item/batch bin → GS1-128 (01)(10)(17); asset → Code128/QR `AS-<tag>`; CSSD pack → GS1 DataMatrix (240) pack no + (17) expiry; blood → ISBT 128 native (DIN, product code, expiry, ABO/Rh); document → QR to verify URL with hash; visitor pass → QR signed token.
2. QR payloads for public use are **signed short tokens** resolving server-side (no PHI); internal labels may carry UHID (2-identifier rule) but never diagnosis.

### 3.2 Label & wristband generation
1. Trigger (registration/admission, order collection, dispense, GRN, pack) → template (EN-039: size, fields, symbology, font, colour band) → rendered ZPL/PDF via EN-005 to mapped printer; **wristband**: name, UHID, age/sex, DOB, ward/bed, admitting doctor, barcode+QR, allergy band colour indicator, MRN photo optional; sizes adult/paediatric/neonatal (mother–baby linked bands with matching ids); reprint with reason (audited) → `bc_labels_issued` → Event `barcode.label.printed`.
2. Patient card (PVC/paper) with UHID barcode & QR; family cards; ABHA card (EN-011).

### 3.3 Scan resolver & input handling
1. **Input**: USB/Bluetooth HID scanners (keyboard wedge with configurable prefix/suffix e.g. `~` … `Enter`, inter-character timing detection to distinguish typing), serial/COM scanners via print agent, **camera scanning** in PWA (`BarcodeDetector` API/ZXing fallback; formats QR/DataMatrix/Code128/EAN/ITF; torch/zoom; continuous mode), RFID readers (`barcode.rfid`, later).
2. **Global scan listener** (`packages/ui` hook): captures scans anywhere → posts to `/scan/resolve` (or offline local resolver for known schemes) → returns `{entityType, id, actions[]}` → context-aware routing: on nursing MAR screen → verify; on patient search → open chart; on GRN → add line; unknown → toast "Unrecognised code" with option to register; every scan logged (`bc_scan_events`, sampled for volume) → Event `barcode.scanned` (with entity).
3. **GS1 parsing**: element strings with FNC1/GS separators, fixed/variable AIs, date `YYMMDD`, GTIN check digit; **UDI** (GS1/HIBCC/ICCBBA issuers) parse DI/PI; **ISBT 128** data structures (DIN with flag chars, product code, expiry, ABO/Rh); vendor GTIN → item master lookup (NC-006 `item_gtins`) with "map new GTIN" flow.
4. Ambiguity/collision: same code in two schemes → resolver uses screen context + scheme priority; checks tenant (codes from other hospitals rejected).

### 3.4 Verification flows (patient safety)
1. **Medication administration (IP-003/IP-004)**: scan wristband → patient context locked → scan medication (dispense label/GS1 pack) → validate against active MAR order (right patient, drug, dose, route, time window ± policy, expiry, allergy) → hard-stop on mismatch with reason override (audited) → administer → Event `mar.dose.verified` (owner IP-003).
2. **Sample collection**: scan wristband → scan label(s) → link; mismatch blocks (OP-004).
3. **Blood transfusion (IP-007)**: two-person: scan bag ISBT 128 → scan wristband → scan issue slip → compatibility check → both users authenticate.
4. **Implant (TR-003)**: scan UDI → auto-capture DI/PI to implant log; **CSSD pack** (EN-003) at point-of-use.
5. **Baby–mother** band match at handover; **discharge** scan closes band.
6. **Document/report verification**: QR → public verify page (EN-012) → issue date/validity, no content.

### 3.5 Scanner & device management
- Scanner profiles (`bc_scanner_profiles`): make/model, prefix/suffix, symbologies enabled, min length; configuration barcodes (printable sheets to program scanners: add prefix, enable DataMatrix, GS1 mode); device inventory per location (EN-007 devices); camera-scan enablement per role/screen; test scan page.

### 3.6 Exceptions & offline
- Unreadable/damaged label → reprint; manual entry with second identifier check (2 fields) and audit; offline PWA: local resolver for UHID/sample/med schemes (regex + cached maps), verification cached MAR (IP-004) with sync; camera unavailable → manual.

## 4. Data Model (schema `core`, prefix `bc_`)
- `bc_schemes` — id, hospital_id (null=system), entity_type, key, symbology (code128/gs1_128/gs1_datamatrix/qr/ean13/itf/isbt128/pdf417), payload_format (template), prefix, ai_map jsonb, check_digit, label_template_id (EN-039), signed (bool), version, active.
- `bc_labels_issued` — id, hospital_id, branch_id, scheme_key, entity_type, entity_id, code_value, printer_id, printed_by, printed_at, copies, is_reprint, reprint_reason, template_version; index (entity_type, entity_id).
- `bc_wristbands` — id, hospital_id, patient_id, encounter_id, band_type (adult/paed/neonate/mother/baby), code_value, colour_flags jsonb (allergy/fall/dnr/isolation), issued_at/by, deactivated_at (discharge/replace), reason.
- `bc_scan_events` — id, hospital_id, branch_id, user_id, device_id?, screen_context, raw_value (hashed if PHI), scheme_key, entity_type, entity_id, resolved (bool), action_taken, at; partitioned monthly (sampled: verification scans 100 %, navigation scans 10 %).
- `bc_scanner_profiles` — id, hospital_id, name, make_model, prefix, suffix, symbologies[], notes; `bc_devices` link to EN-007 `devices`.
- `bc_gtin_map` (mirror of NC-006 `item_gtins`) — gtin, item_id, pack_level, uom, source (vendor/DAVA/manual), verified.
- `bc_udi_cache` — udi_di, issuer, device_name, manufacturer, gmdn, lookup_source (GUDID/CDSCO), fetched_at.
- `bc_verifications` — id, hospital_id, type (mar/sample/blood/implant/cssd/mother_baby), patient_id, encounter_id, scanned jsonb (codes), result (match/mismatch/override), override_reason, user_ids[] (two-person), at; index (patient_id, at).
- `bc_signed_tokens` — code, entity_type, entity_id, expires_at, scopes, revoked (for public QRs).

### 4.1 Standard label catalogue (seeded templates in EN-039 / `packages/print-templates`)
| Label | Size (default) | Symbology | Content (human-readable) | Printer |
|---|---|---|---|---|
| Adult wristband | 25×279 mm thermal band | Code128 (UHID) + QR (signed) | Name, UHID, DOB/age-sex, ward/bed, admitting doctor, allergy colour block, hospital logo | Zebra HC100/ZD510 |
| Paediatric / neonate band | 19×… mm | Code128 + QR | Baby of <mother name>, mother UHID, baby UHID, sex, DOB/time, birth weight | same |
| Patient card | 86×54 mm PVC / paper | Code128 + QR | Name, UHID, DOB, blood group (opt), photo (opt), branch, ABHA (opt) | card/laser |
| Lab sample | 50×25 mm | Code128 (accession-seq) + DataMatrix (opt) | Name, UHID, age/sex, tests short codes, tube colour, collection time placeholder, container n/N | Zebra ZD421 / TSC |
| Medication dispense | 50×30 mm | GS1 DataMatrix / `RX-id` | Patient name, UHID, drug, strength, dose/route/frequency, qty, batch/expiry, pharmacist, warnings, hospital | pharmacy label |
| IV / infusion additive | 50×30 mm | QR (order id) | Patient, additive, base fluid, rate, prepared by/at, expiry time | ward label |
| Item bin / batch (stores) | 50×25 mm | GS1-128 (01)(10)(17) | Item name, code, batch, expiry, MRP, storage | stores label |
| Asset tag | 40×20 mm polyester | Code128 / QR | Asset tag no, name, department, PM due, hospital | durable label |
| CSSD pack | 50×25 mm autoclave-safe | GS1 DataMatrix (240)(17) | Pack no, tray name, packed by/date, expiry, cycle no placeholder | CSSD label |
| Token slip | 58/80 mm receipt | QR (live position link) | Token, doctor/room, ETA, instructions | thermal |
| MRD file / document | 50×25 mm | Code128 (file no) | UHID, name, volume, year | MRD |
| Visitor / bystander pass | 80 mm receipt / card | QR (signed, 24 h) | Visitor name, patient ward/bed, valid hours, photo (opt) | gate |
| Report / receipt footer | inline | QR (verify token) | "Scan to verify" | A4 |

## 5. Business Rules & Validations
- Wristband/labels carry ≥ 2 identifiers (name + UHID; DOB where space); no diagnosis/PHI beyond need; neonate bands include mother's UHID; alert colours per hospital policy table.
- Wristband reissue deactivates previous code (old code scans → "band replaced" warning); discharged encounter bands invalid for MAR.
- Verification hard-stops: patient mismatch, drug/dose/route mismatch, expired batch, recalled batch, allergy conflict; override requires reason + supervisor for high-alert drugs; all logged.
- Scan resolver rejects codes not belonging to tenant/branch (encoded hospital prefix or DB lookup); signed public tokens expire (default 90 days for report verify; 24 h for passes).
- GS1: validate GTIN check digit; expiry `YYMM00` → last day of month; batch case-sensitive; unknown GTIN → prompt mapping (permission `inventory.item.gtin.map`).
- Label reprint reasons mandatory; sample labels never reprinted after collection without relabel workflow (OP-004).
- Camera scan allowed only over HTTPS and for permitted roles/screens; images never stored.
- Retention: scan events 1 year (verification 5 years), labels issued 3 years.

## 6. API Surface (`/api/v1/barcode`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET/POST/PATCH | /schemes ; /schemes/:id ; POST /schemes/:id/preview | schemes | barcode.scheme.configure (IT Admin) | |
| POST | /labels {entityType, entityId, template?, copies, printerId?} ; POST /labels/:id/reprint {reason} ; GET /labels?entity | print labels | barcode.label.print (role-scoped per entity) / barcode.label.reprint | → EN-005 |
| POST | /wristbands {patientId, encounterId, bandType} ; POST /wristbands/:id/deactivate ; GET /wristbands?patient | wristbands | barcode.wristband.issue (Nurse, Reception) | |
| POST | /scan/resolve {raw, context, deviceId?} | resolve scan | barcode.scan (all staff) | < 100 ms; logs event |
| POST | /scan/parse-gs1 {raw} ; POST /scan/parse-udi ; POST /scan/parse-isbt | parsers (utility) | barcode.scan | |
| POST | /verify {type, codes[], encounterId, orderId?, secondUserToken?} | verification | barcode.verify.* (mar/sample/blood/implant/cssd) | returns match/mismatch details |
| GET/POST/PATCH | /scanner-profiles ; GET /scanner-profiles/:id/config-sheet.pdf | scanners | barcode.device.configure | |
| GET/POST | /gtin-map ; POST /gtin-map/lookup {gtin} | GTIN mapping | inventory.item.gtin.map / read | |
| GET | /udi/:di | UDI lookup (cache/GUDID) | barcode.scan | |
| POST | /tokens {entityType, entityId, ttl, scopes} ; GET /public/resolve/:code | signed public QR | barcode.token.issue (system) / public | rate-limited |
| GET | /events?user&entity&from ; /reports/verification ; /reports/labels | audit/reports | barcode.report.read | MV |
| GET | /test-scan (page) | scanner test | barcode.scan | |

## 7. Domain Events (outbox)
- `barcode.label.printed|reprinted`, `barcode.wristband.issued|deactivated` → EN-024, IP-001 (band status), EN-005.
- `barcode.scanned` (sampled) → analytics; `barcode.scan.unresolved` → IT hygiene report.
- `barcode.verification.passed|failed|overridden` → owning module (IP-003 MAR, OP-004, IP-007, TR-003, EN-003), NC-015 (overrides as indicator), EN-037 (supervisor alert on high-alert override).
- `barcode.gtin.mapped`, `barcode.token.issued|revoked`.

## 8. Screens
- **Global scan overlay** (all devices): scan indicator, resolved entity chip with actions ("Open chart", "Verify", "Add to GRN"), unrecognised toast; keyboard: scan = prefix-triggered, `Alt+S` open camera scanner.
- **Camera Scanner** (phone/tablet PWA): full-screen viewfinder, torch, continuous mode, haptic/audio feedback, offline resolver banner.
- **Label/Wristband print dialog** (desktop/tablet): template preview, copies, printer (mapped default), band type/colour flags, reprint reason.
- **Bedside Verification** (IP-004 phone/tablet): step prompts (Scan patient → Scan item), big green/red result, mismatch reasons, override with reason & supervisor PIN, two-person auth for blood.
- **Barcode Admin** (desktop): schemes, templates preview, scanner profiles + config sheets, GTIN/UDI mapping queue, camera-scan policy, test-scan page with decoded AIs.
- **Verification & label reports** (desktop): overrides, mismatch trends, labels per department, unresolved scans.
- Empty/error: printer offline → EN-005 fallback; camera denied → instructions.

## 9. Integrations
- Scanners: Zebra/Honeywell/Datalogic/Newland (HID/BT/serial), ring scanners; camera via `BarcodeDetector`/ZXing-js; label printers via EN-005 (ZPL `^BC`, `^BX`, `^BQ`); GS1 India/DAVA GTIN datasets, GUDID/CDSCO UDI lookups, ISBT 128 (ICCBBA product code tables), EN-039 templates, EN-007 devices, RFID readers (UHF for assets/linen, `barcode.rfid`), EN-012 verify page, EN-015 pass QR, EN-006 token QR, EN-011 ABHA QR parsing (offline JSON payload).

## 10. Reports & Analytics
- Labels/wristbands issued & reprints (by reason/department), scan volume by context/device, unresolved scans, verification pass/mismatch/override rates (NABH medication safety indicator), scanner device health, GTIN mapping coverage of purchased items, camera vs hardware scan share. MV `analytics.mv_barcode_daily`.

## 11. Notifications
- Supervisor: verification override on high-alert drug/blood; IT: unresolved scan spikes, printer/scanner offline (via EN-005), GTIN mapping queue > N; Nurse: wristband replacement needed (damaged flag).

## 12. Permissions (RBAC keys)
`barcode.scheme.configure` (IT Admin) · `barcode.label.print` (Reception, Nurse, Lab, Pharmacy, Stores, CSSD; entity-scoped) · `barcode.label.reprint` (same + reason) · `barcode.wristband.issue` (Reception, Nurse) · `barcode.scan` (all staff; patient scope for own QR) · `barcode.verify.mar` (Nurse) · `barcode.verify.sample` (Nurse, Phlebotomist) · `barcode.verify.blood` (Nurse + second person) · `barcode.verify.implant` (OT nurse) · `barcode.verify.cssd` (OT/CSSD) · `barcode.verify.override` (Nurse in-charge; audited) · `barcode.device.configure` (IT) · `inventory.item.gtin.map` (Pharmacy/Stores in-charge) · `barcode.token.issue` (system) · `barcode.report.read` (Admin, Quality).

## 13. Non-functional
- 2000 beds: ~60k scans/day (MAR 25k, lab 20k, pharmacy/stores 10k, other); resolve p95 < 100 ms (Redis-cached scheme maps), verification p95 < 200 ms; label render < 100 ms.
- Offline resolver in PWA for core schemes; camera scan works on mid-range Android (Chrome) at ≥ 15 fps decode; HID scanners with 20 ms inter-key detection.
- Label print quality: 203/300 dpi, quiet zones, Code128 min X-dim 0.25 mm; wristband material/thermal durability guidance; contrast for scanners.
- Security: signed public tokens, no PHI in QR beyond policy, audit of overrides; accessibility: audio + haptic feedback, colour + icon result states; i18n label lines.

## 14. Acceptance Criteria
1. Given an admission, when the wristband prints, then it shows name, UHID, DOB/age-sex, ward/bed, barcode + QR and allergy colour flag, and scanning it opens the correct patient in < 1 s.
2. Given a nurse scans wristband A then a medication dispensed for patient B, when verified, then the system hard-stops "Wrong patient" and logs a mismatch; override requires reason and supervisor.
3. Given a GS1 DataMatrix drug pack `(01)…(10)…(17)…(21)…`, when scanned at GRN, then GTIN, batch, expiry (month-end normalisation) and serial auto-fill; unknown GTIN prompts mapping.
4. Given an ISBT 128 blood bag scanned with a wristband by two authenticated users, when compatible per IP-007, then verification passes; a single user cannot complete it.
5. Given a UDI on an implant sticker, when scanned in TR-003, then DI/PI parse and device details populate from cache/GUDID.
6. Given a HID scanner with prefix `~`, when a code is scanned on any screen, then the global listener captures it (not typed into a field) and routes by context.
7. Given a phone without a hardware scanner, when the nurse taps camera scan, then QR/DataMatrix/Code128 decode within 1 s in normal lighting and no image is stored.
8. Given a wristband reissued, when the old band is scanned, then a "band replaced" warning appears and MAR verification is blocked.
9. Given a code from another tenant/branch, when scanned, then it resolves as unrecognised and is logged.
10. Given a report QR, when a member of the public opens the verify link, then only issue date and validity display, and the token expires per policy.
11. Given a sample label reprint request after collection, when attempted, then it is blocked and the relabel workflow (OP-004) is offered.
12. Given the PWA offline, when a wristband and cached MAR item are scanned, then verification uses the local resolver and syncs the verification event on reconnect.
13. Given the scanner config sheet printed for a Zebra DS2208, when scanned in order, then the scanner emits the configured prefix/suffix and GS1 mode (verified on the test-scan page).

## 15. Enhancements / Later phases
- RFID/UHF for assets/linen/patients (`barcode.rfid`), NFC wristbands, DAVA/track-and-trace API verification of drug authenticity, GUDID/CDSCO UDI live lookups, mobile label printers (EN-005), specimen tube RFID racks, computer-vision pill/label recognition (AI-003), patient self-check-in via card QR (EN-034), asset audit by bulk RFID sweep (NC-002), voice-guided verification for hands-free nursing.

## 16. Open Questions for the Hospital
1. Current UHID/sample/asset code formats to preserve; existing printed cards/wristbands in circulation?
2. Wristband printer models & consumables (adult/paediatric/neonate); alert colour policy?
3. Scanner inventory (models, USB/Bluetooth), phone/tablet availability for camera scan; Wi-Fi coverage in wards?
4. Do pharmacy/stores receive GS1-barcoded packs from vendors today? DAVA compliance status?
5. Blood bank ISBT 128 labelling in place? Implants with UDI labels?
6. Verification policy: mandatory scan for all IP medications or high-alert only initially? Override approver?
7. Public QR on reports/receipts acceptable; token expiry?
