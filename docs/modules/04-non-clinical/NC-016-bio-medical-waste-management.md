# NC-016 — Bio-Medical Waste Management (BMW Rules 2016, Colour Codes, Barcode Bags, CBWTF Manifests, SPCB/CPCB Reporting)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-016 |
| Phase | 9 |
| Priority | P1 |
| Complexity | Low–Medium |
| Complexity note | Rules-heavy but data-light; barcode/weighing integration and CBWTF reconciliation are the main work |
| Depends on | NC-018 (housekeeping staff collect/transport waste; task engine), NC-006 (expired/damaged drug & consumable write-offs → BMW entries; bag/liner stock), EN-013 (barcode labels for bags/bins), EN-042 (weighing scale integration, optional), NC-021 (CBWTF operator vendor, recyclers), NC-005/NC-009 (CBWTF bills per kg), NC-023 (SPCB authorisation, annual report Form-IV filing tracker), NC-015 (BMW compliance indicators, audits, incidents e.g. needle-stick), IP-012 (infection control — sharps injuries, segregation audits), NC-027 (BMW training records), NC-002 (equipment: autoclave/shredder/ETP/incinerator if on-site), NC-004 (BMW SOPs), OP-003/IP-014 (cytotoxic/expired drugs), IP-007 (blood bags disposal), OP-004 (lab liquid waste, microbiology pre-treatment), OP-008 (radiographic waste), NC-011, EN-024, EN-032/EN-037 |
| Feature flag | `module.bmw.enabled` (sub: `bmw.barcode_bags`, `bmw.scale_integration`, `bmw.onsite_treatment`, `bmw.ewaste`, `bmw.liquid_waste`) |
| Primary roles | BMW Nodal Officer / Infection Control Nurse (21), Housekeeping Supervisor & Staff (50), Waste storage room in-charge |
| Secondary roles | Ward/OT/Lab in-charges (17/20/33, point-of-generation), Quality (54), Hospital Admin (2), CBWTF operator (63, portal/manifest ack), Facility (49, ETP/treatment equipment), Auditor/SPCB inspector (58, read-only) |
| Regulatory | Bio-Medical Waste Management Rules 2016 (as amended 2018/2019/2024): Schedule I colour categories — **Yellow** (anatomical, soiled, expired/discarded medicines, chemical waste, chemical liquid, discarded linen contaminated, microbiology/biotech/clinical lab waste), **Red** (contaminated recyclable plastics: tubing, bottles, IV sets, catheters, syringes without needles, gloves), **White (translucent)** (waste sharps incl. metals: needles, syringes with fixed needles, scalpels, blades), **Blue** (glassware, metallic body implants); Schedule II (standards for treatment), Rule 4 duties of occupier (segregation at source, pre-treatment of lab/microbiology/blood samples & bags by disinfection/sterilisation on-site as per WHO/NACO, phasing out chlorinated plastic bags (achieved), **bar-code system** for bags/containers (Rule 4(g)), GPS on vehicles by CBWTF, storage ≤ 48 h, hand-over to CBWTF within 48 h (Rule 8), records of generation/treatment/disposal, **daily register**, **annual report Form-IV to SPCB by 30 June**, accident reporting Form-I within 24 h, authorisation Form-II/III, training & immunisation of workers (Hep B/Tetanus), display of BMW data on website (monthly), sign boards & bio-hazard symbols), CPCB guidelines (2018 barcode & GPS, COVID-era yellow-bag guidance), SPCB conditions & CBWTF agreement (75 km radius rule), Hazardous & Other Wastes Rules 2016 (chemical waste, mercury), E-Waste Rules 2022 (link NC-002 disposal), Solid Waste Rules 2016 (general waste), Radioactive waste (AERB — NC-020/OP-008), Plastic Waste Rules, NABH HIC/FMS (BMW compliance indicators, training, audits), NACO/WHO pre-treatment SOPs, Water/Air Acts (ETP/STP consents via NC-023) |

## 1. Purpose
NC-016 digitises the hospital's **bio-medical waste chain of custody**: colour-coded segregation at each point of generation, barcode-labelled bags/containers with weight capture (manual or scale), collection rounds by housekeeping, central storage (≤ 48 h) with temperature/pest controls, hand-over to the CBWTF (Common Bio-medical Waste Treatment Facility) with e-manifests and pickup acknowledgements, on-site pre-treatment logs (autoclave/chemical disinfection for lab & blood waste, sharps mutilation), reconciliation of hospital weights vs CBWTF weights and invoices, accident/spill/needle-stick reporting (Form-I), training & immunisation compliance, and **regulatory outputs**: daily register, monthly website disclosure data, **Annual Report Form-IV** for SPCB/CPCB, authorisation tracking — plus BMW KPIs to NC-015.

## 2. Users & Jobs-to-be-done
- **Ward/OT/lab staff** (tablet/phone at bin station): tie & label bags by category (print/apply barcode), record approx/actual weight, hand over to collector; report spills.
- **Housekeeping collector** (phone/handheld with scanner): scheduled collection rounds by zone/time, scan bags at pickup, transport in covered trolleys via designated routes, deposit at central storage (scan-in); PPE compliance.
- **Storage room in-charge / BMW nodal officer** (desktop + scale): weigh & log per category, prepare hand-over to CBWTF, e-manifest, verify vehicle/driver/GPS proof, reconcile weights & invoices, maintain daily register, review segregation audits, file Form-IV, manage accidents.
- **Infection control nurse/quality**: segregation audits (bin checks), needle-stick incidents (IP-012/NC-015), training compliance.
- **CBWTF operator** (portal/email): receive manifests, acknowledge pickups with weights & vehicle, submit treatment certificates and monthly statements.
- **Admin/auditor/SPCB inspector**: reports & registers, authorisation status, website disclosure data.

## 3. Core Workflows

### 3.1 Setup
1. **Nodal officer** configures: waste categories per BMW 2016 Schedule I (yellow (a) human anatomical, (b) animal, (c) soiled, (d) expired/discarded medicines incl. cytotoxic, (e) chemical waste, (f) chemical liquid, (g) discarded linen, (h) microbiology/biotech/lab waste; red; white sharps; blue glass & metallic implants; plus non-BMW streams: general (SWM), e-waste (NC-002), hazardous (mercury, batteries), radioactive (AERB, ref only), liquid effluent (ETP)), bin/bag colours & liner specs (non-chlorinated), point-of-generation locations (wards/OT/ICU/labs/pharmacy/dialysis/blood bank/mortuary — mapped to EN-027 locations), collection zones & schedule (e.g. 3 rounds/day; OT after each list), central storage room(s), CBWTF agreement (operator NC-021, SPCB authorisation no./validity, pickup frequency, rate per kg per category, GPS/portal details), on-site treatment equipment (autoclave for lab waste, sharps mutilator, ETP) linked to NC-002/NC-020, weighing scales (EN-042), SPCB authorisation (Form-III no., validity → NC-023), training matrix (NC-027) → Event `bmw.config.updated`.

### 3.2 Segregation & bag labelling at source (`bmw.barcode_bags`)
1. When a bag/container is ¾ full or at shift end → **Ward staff** ties bag → prints/affixes **barcode label** (EN-013 ZPL: hospital name, SPCB auth no., location, category colour, date/time, bag id, approx weight, generator user) via ward label printer or pre-printed serialised roll → scans label to register bag `generated` (location, category, weight if scale at station else estimated) → sharps containers (puncture-proof, ¾ full rule; needle destroyer use logged) → cytotoxic/anatomical special handling flags → Event `bmw.bag.generated`.
2. Segregation error detected later (wrong colour) → recorded as **non-conformance** against location (feeds audits/training).

### 3.3 Collection & internal transport
1. Collection round schedule (NC-018 task) → **Collector** with covered trolley (route/time restrictions e.g. no patient corridors at visiting hours) scans each bag at pickup (`collected`, collector, trolley id, time) → PPE checklist confirmation at round start → deposit at central storage: scan-in (`stored`) → any bag missing (generated but not stored > 4 h) → alert; general waste separate → Event `bmw.bag.collected|stored`.

### 3.4 Central storage, weighing & pre-treatment
1. **Storage in-charge** weighs by category (bag-wise via scale integration `bmw.scale_integration` (RS-232/USB/Bluetooth via EN-042 or manual entry) → totals per category per day → **daily register** auto-compiled (kg by category, bags count, source locations, treatment/disposal, CBWTF hand-over) → storage limits: hand-over within 48 h of generation (timer per bag; alert at 36 h) → temperature (if refrigerated for anatomical > 48 h exception) → pest control/cleaning logs.
2. **On-site pre-treatment** (`bmw.onsite_treatment`): microbiology cultures/lab waste & blood bags autoclaved/chemically disinfected before yellow/red disposal (Rule 4 & Schedule I notes) → cycle logs (autoclave parameters, BI results with EN-003-like validation, chemical concentration/contact time), sharps mutilation/shredding logs, liquid chemical neutralisation, ETP effluent parameters (`bmw.liquid_waste`; pH/BOD/COD tests per SPCB consent) → certificates → Event `bmw.pretreatment.logged`.

### 3.5 Hand-over to CBWTF & e-manifest
1. Pickup scheduled (per agreement/daily) → **System** generates **manifest** (`BMW_MAN` series): date/time, hospital & authorisation, category-wise bags & kg (hospital scale), barcodes list, vehicle no., driver, CBWTF operator, hospital signatory → operator acknowledges (portal/app/SMS-OTP/paper sign captured as photo) with **CBWTF weights** & vehicle GPS/trip id → variance (> tolerance e.g. 5 % or 2 kg) flagged → bags status `handed_over` → CBWTF later uploads **treatment/disposal certificate** (incineration/autoclave/recycling per category) → Event `bmw.manifest.issued|acknowledged|treated`. Missed pickup > 48 h → non-compliance flag + escalation + SPCB-reportable log.

### 3.6 Reconciliation & billing
- Monthly: hospital manifests vs CBWTF statement (kg per category) → variance report → CBWTF invoice (per kg or per bed rate) verified against manifests → approved to NC-005/NC-009 AP; disputes tracked; recyclable (red/blue) sale/credit if applicable.

### 3.7 Accidents, spills & incidents
- Spill/exposure/needle-stick/vehicle accident/fire in storage → report (who, where, category, quantity, action, exposure PEP link IP-012, injuries) → **Form-I accident report** to SPCB within 24 h (PDF generated; filing tracked) → NC-015 incident/CAPA link → Event `bmw.accident.reported`.

### 3.8 Training, immunisation & audits
- BMW training (induction + annual) per staff category (NC-027 records) → compliance %; Hep B/Tetanus immunisation status of handlers (NC-010/OP-013) → alerts; **segregation audits** (checklist per location: correct bins/liners, labels, ¾ rule, sharps handling, PPE) weekly by ICN → scores → non-conformance → CAPA (NC-015).

### 3.9 Regulatory reporting
- **Daily register** (Rule 8/Schedule) printable; **monthly website disclosure** (kg by category, treatment method) export/JSON for EN-012 website; **Annual Report Form-IV** (by 30 June for previous FY: occupier details, authorisation, beds, category-wise generation kg/annum, treatment/disposal modes, CBWTF details, accidents, training) auto-filled → review → PDF/Excel/state portal format → filing tracked in NC-023; SPCB inspection pack (registers, manifests, certificates, training, audits, authorisation).

### 3.10 Category-specific handling rules (seeded, editable)
| Category | Container | Pre-treatment | Treatment (CBWTF) | Special |
|---|---|---|---|---|
| Yellow (a) anatomical | yellow non-chlorinated bag | none | incineration/plasma pyrolysis/deep burial (rural) | store ≤ 48 h, refrigerate if longer; foetal/organ consent docs (IP-011/OT) |
| Yellow (c) soiled | yellow bag | none | incineration/plasma; or autoclave/microwave then landfill | dressings, blood-soaked cotton |
| Yellow (d) expired/discarded medicines & cytotoxic | yellow container/bag | none | return to manufacturer/incineration ≥ 1200 °C | NC-006 write-off link; cytotoxic labelled; NDPS destruction per rules with witnesses |
| Yellow (e/f) chemical solid/liquid | yellow | neutralisation for liquids | incineration / ETP | lab reagents, disinfectants |
| Yellow (g) discarded linen/mattress | yellow | none | incineration/plasma | NC-017 condemned contaminated linen |
| Yellow (h) microbiology & lab | yellow | **autoclave/microwave on-site mandatory** | incineration/plasma | culture plates, blood bags (IP-007), samples |
| Red | red bag | none (disinfection optional) | autoclave/microwave → shredding → recyclers | tubing, IV sets, syringes (without needle), gloves, catheters, bottles |
| White | translucent puncture-proof | needle destroyer/mutilation optional | autoclave/dry heat → shredding/encapsulation → recycler | needles, blades, scalpels, syringes with fixed needles |
| Blue | cardboard box/blue-marked container | none | disinfection/autoclave → recycling | glass vials/ampoules, metallic implants (explants via TR-003) |
| General (SWM) | green/black per municipal | — | municipal | never mixed with BMW; audits |
| E-waste / hazardous / radioactive | per rules | — | authorised recyclers / AERB | NC-002 / NC-023 links |

### 3.11 Exceptions & edge cases
1. Bag generated in wrong category and detected at storage → re-bag & relabel with non-conformance; original label voided.
2. CBWTF fails to pick up (strike/vehicle breakdown) → 48 h breach recorded with reason "operator default"; SPCB intimation template; alternative operator if authorised.
3. Scale calibration expired → weights flagged `uncalibrated`; calibration due tracked in NC-020.
4. Anatomical waste with religious/family claim (amputated limb) → release to family per policy with consent form; recorded as `released_to_family`, not CBWTF.
5. Mass casualty/outbreak surge → temporary storage capacity plan; extra pickups requested; category volumes flagged in report.
6. Barcode label unreadable at storage → manual entry by bag serial (pre-printed) with photo; audit.
7. Bags generated but never scanned at storage within 24 h → "missing" investigation task to zone supervisor.

## 4. Data Model (schema `ops`, prefix `bmw_`)
- **bmw_categories**: id, hospital_id, code enum(Y_a…Y_h, RED, WHITE, BLUE, GENERAL, EWASTE, HAZ, RADIO, LIQUID), colour, description, container_spec, pretreatment_required bool, treatment_mode enum(incineration/deep_burial/autoclave/microwave/chemical/recycling/secured_landfill/etp), rate_per_kg?, active.
- **bmw_locations**: location_id (EN-027), zone_id, category_bins jsonb, label_printer_id?, scale_id?, active; **bmw_zones** (branch_id, name, collection_schedule jsonb, route notes).
- **bmw_bags**: id, hospital_id, branch_id, bag_code (barcode), category_id, location_id, generated_by, generated_at, est_weight_kg, weight_kg?, weighed_at?, scale_id?, status enum(generated/collected/stored/pretreated/handed_over/treated/missing/rejected), collected_by, collected_at, trolley_id, stored_at, storage_room_id, manifest_id?, hold_hours computed, flags text[] (cytotoxic/anatomical/mislabelled), nonconformance_id?. INDEX (hospital_id, status, generated_at), (bag_code) UNIQUE, (manifest_id).
- **bmw_collection_rounds**: id, zone_id, scheduled_at, collector_id, trolley_id, ppe_confirmed bool, started_at, ended_at, bags_count, missed_locations jsonb, status.
- **bmw_storage_rooms**: id, branch_id, name, capacity_kg, refrigerated bool, temp_log jsonb?, last_cleaned_at, pest_control_at.
- **bmw_daily_registers**: id, hospital_id, branch_id, date, per_category jsonb [{category, bags, kg}], handed_over_kg, pretreated_kg, remarks, generated_at, signed_by, locked bool. UNIQUE (branch_id, date).
- **bmw_pretreatment_logs**: id, equipment_asset_id, kind enum(autoclave/chemical/mutilation/shredding/neutralisation/etp), at, params jsonb (temp/pressure/time or concentration/contact), bag_ids uuid[], bi_result?, operator_id, certificate_file_id.
- **bmw_manifests**: id, hospital_id, branch_id, manifest_no, cbwtf_vendor_id, pickup_at, vehicle_no, driver_name, driver_contact, gps_trip_ref?, hospital_signatory_id, lines jsonb [{category, bags, hospital_kg, cbwtf_kg, variance}], total_hospital_kg, total_cbwtf_kg, variance_flag bool, ack_method enum(portal/otp/photo/paper), ack_at, ack_by, ack_file_id, treatment_cert_file_id?, treatment_cert_at?, status enum(draft/issued/acknowledged/disputed/treated/closed), invoice_ref?. UNIQUE (hospital_id, manifest_no).
- **bmw_reconciliations**: cbwtf_vendor_id, period, statement_file_id, hospital_kg_by_cat jsonb, cbwtf_kg_by_cat jsonb, variances jsonb, invoice_id? (NC-005), status.
- **bmw_accidents**: id, hospital_id, branch_id, at, location_id, type enum(spill/exposure/needle_stick/vehicle/fire/other), category_id?, quantity, description, persons_involved jsonb, actions, form1_file_id, spcb_submitted_at, incident_id (NC-015), pep_ref (IP-012), status.
- **bmw_audits**: id, location_id, auditor_id, at, checklist jsonb, score, nonconformances jsonb, capa_id?; **bmw_nonconformances** (location_id, bag_id?, type enum(wrong_bin/no_label/overfilled/no_liner/sharps_mishandled/ppe/other), reported_by, at, resolved).
- **bmw_training_status** (view over NC-027/NC-010): employee, category, trained_on, due, hepb_status, tetanus_status.
- **bmw_annual_reports**: fy, data jsonb (Form-IV sections), file_id, reviewed_by, filed_at, spcb_ack, status; **bmw_monthly_disclosures** (month, kg by category, published_at, url).
- **bmw_authorisations**: spcb_auth_no, form, valid_from, valid_to, conditions, document_id (NC-023 link).
- RLS; bags/manifests/registers immutable after lock; retention 5 years minimum (records per BMW rules) — configure 10.

## 5. Business Rules & Validations
- Bag category fixed at generation (correction creates non-conformance + new label); label mandatory before collection (`bmw.barcode_bags`); sharps only in white puncture-proof containers; anatomical/cytotoxic flags require yellow with special handling; general waste never in BMW bins (audit item).
- Weight: scale reading or manual (flag `estimated`); daily register uses weighed values; hospital totals must reconcile with manifests ± tolerance; CBWTF weight variance > tolerance → dispute before invoice approval.
- Storage: hand-over ≤ 48 h from generation (per bag timer; 36 h warning; > 48 h = non-compliance record with reason); anatomical waste beyond 48 h only refrigerated (exception logged); storage room access restricted, cleaning/pest logs weekly.
- Pre-treatment mandatory for lab microbiology/culture, blood/body-fluid samples & bags before hand-over (Schedule I note) — manifest line for those categories requires linked pretreatment log; autoclave cycle validation (BI weekly) else flag.
- Manifest: cannot issue without vehicle/driver; acknowledgement required within 24 h; treatment certificate expected within 30 days (config) else follow-up; missed pickup > 48 h → escalation and Form-IV accident/incident note if applicable.
- Accident Form-I within 24 h (timer, escalation to nodal officer/admin); needle-stick → IP-012 PEP within 2 h.
- Training: handlers must have induction + annual BMW training & Hep B/tetanus; non-compliant staff flagged to housekeeping supervisor (cannot be rostered to BMW rounds — NC-018/NC-030 hook).
- Authorisation validity tracked; expired → prominent alert; annual report by 30 June (reminders 60/30/7 days).
- Data locks: daily register locked next day 10:00 (nodal officer can amend with reason before month close); manifests immutable after acknowledgement (disputes as separate records).
- Retention ≥ 5 years (rules) — default 10.

## 6. API Surface (`/api/v1/bmw`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/PUT | /config/(categories|locations|zones|storage-rooms|cbwtf|scales) | setup | bmw.configure | Y | – |
| POST | /bags (generate + label) ; POST /bags/{code}/(collect|store|weigh|pretreat|flag) ; GET /bags?status=&location=&date= | bag lifecycle | bmw.bag.generate (ward staff) / bmw.bag.collect (housekeeping) / bmw.bag.store / bmw.bag.weigh | Y | cursor |
| POST | /labels/print (pre-printed roll or on-demand) | labels | bmw.label.print | Y | – |
| GET/POST | /rounds ; POST /rounds/{id}/(start|end) | collection rounds | bmw.round.manage / bmw.bag.collect | Y | cursor |
| POST | /scale/readings (device) | scale ingest | integration.scale.ingest | Y | – |
| GET | /register/daily?date= ; POST /register/daily/{date}/(sign|lock|amend) | daily register | bmw.register.read / .sign | Y | – |
| POST | /pretreatment/logs ; GET /pretreatment/logs | pre-treatment | bmw.pretreatment.log | Y | cursor |
| POST | /manifests ; POST /manifests/{id}/(issue|acknowledge|dispute|treatment-cert|close) ; GET /manifests | CBWTF | bmw.manifest.manage / vendor.bmw.acknowledge | Y | cursor |
| POST | /reconciliations ; POST /reconciliations/{id}/(match|approve-invoice) | monthly recon | bmw.reconcile | Y | cursor |
| POST | /accidents ; POST /accidents/{id}/(form1|submit) | accidents | bmw.accident.report (all) / .manage | Y | cursor |
| POST | /audits ; POST /nonconformances | audits | bmw.audit.conduct | Y | cursor |
| GET | /training/status | compliance | bmw.report.read | – | cursor |
| POST | /reports/annual/{fy}/generate ; POST /reports/annual/{fy}/file ; GET /reports/monthly-disclosure/{month} ; GET /reports/(register|manifests|variance|category-trend|storage-compliance|audit-scores|accidents) | regulatory reports | bmw.report.read / bmw.report.file | Y | – |
| Vendor portal | GET /vendor/manifests ; POST /vendor/manifests/{id}/ack ; POST /vendor/statements | CBWTF | vendor.bmw.* | Y | cursor |

## 7. Domain Events (outbox)
- `bmw.bag.generated|collected|stored|handed_over|treated|missing` {bag, category, location, kg} → dashboards, NC-018 tasks, NC-015 KPIs.
- `bmw.storage.limit.warning|breached` {bag/batch, hours} → nodal officer, admin.
- `bmw.manifest.issued|acknowledged|disputed|treated` → CBWTF portal, NC-005/NC-009 (billing basis), NC-023 (compliance).
- `bmw.pretreatment.logged|failed` → ICN, NC-020 (equipment).
- `bmw.accident.reported|form1.filed` → NC-015 incident, IP-012 (needle-stick), admin.
- `bmw.nonconformance.raised` {location, type} → ward in-charge, ICN, NC-027 (retraining), NC-015.
- `bmw.report.annual.generated|filed`, `bmw.disclosure.published` → NC-023, EN-012 website.
- `bmw.authorisation.expiring` → NC-023, admin.
- Consumes: `inventory.batch.written_off` (NC-006 expired drugs → yellow (d) entry proposal), `asset.disposed` (NC-002 e-waste link), `blood.unit.discarded` (IP-007), `training.completed` (NC-027), `vaccination.recorded` (OP-013 Hep B for staff), `housekeeping.task.completed` (NC-018 rounds), `iot.scale.reading` (EN-042), `licence.renewed` (NC-023 authorisation).

## 8. Screens (UI)
- **Bin station (ward/OT/lab)** — tablet/phone: category tiles (colour-coded), "New bag" → print/scan label, weight entry (scale auto if available), flags; today's bags list; spill report button; offline queue.
- **Collector app** — phone/handheld: my rounds, scan bags per location (beeps/colour confirm), missed locations, deposit scan-in; PPE checklist; offline.
- **Storage room console** — desktop + scale display: pending bags by category with age timers (36/48 h colours), weigh & log, pretreatment logs, manifest builder (select bags → totals → vehicle/driver → issue → ack capture), daily register preview/sign/lock.
- **BMW dashboard** — desktop (nodal officer/quality): kg by category/day, per-bed kg/day, storage compliance, manifest acks pending, variance, training & immunisation compliance, audits scores, accidents; branch compare.
- **Reconciliation & invoices** — desktop; **Accident/Form-I** — desktop/phone; **Audit checklist** — tablet; **Annual Report Form-IV** — desktop wizard with prefilled sections, edits with reasons, PDF/Excel export, filing tracker.
- **CBWTF vendor portal** — manifests, ack with weights/vehicle, statements, certificates.
- Empty/error states; colour-blind safe icons in addition to colours; i18n; WCAG 2.2 AA.

### 8.1 Screen behaviours (detail)
- **Bin station**: category tiles carry both colour and icon/text (colour-blind safe); "New bag" prints label immediately if printer configured else shows pre-printed roll prompt (scan next serial); estimated weight defaults per bag size; infected/cytotoxic toggles add pictograms to label; offline queue with local serials.
- **Collector app**: route list ordered by zone; each location shows expected bags (generated, not collected) with age; scan confirmations with vibration; missed-location must have reason (locked/no bags); PPE checklist mandatory at round start; end-of-round summary.
- **Storage console**: per-category lanes with age colour (green < 24 h, amber 24–36 h, red > 36 h); scale weight auto-fill; manifest builder shows pretreatment prerequisite badges; ack capture via OTP/photo; register preview mirrors statutory columns.
- **Form-IV wizard**: sections A–E per SPCB template with prefilled figures, per-field source tooltip, edit-with-reason; validation before export.

### 8.2 Configuration defaults (seed)
- Categories & handling rules (3.10) seeded; storage limit 48 h (warning 36 h); manifest ack SLA 24 h; treatment certificate 30 days; weight tolerance 5 %/2 kg; Form-I 24 h; annual report reminders 60/30/7 days before 30 June; training annual; audits weekly per zone; series `BMW_BAG` (or pre-printed), `BMW_MAN`, `BMW_ACC`.

## 9. Integrations
- EN-013 label printers (ZPL) & scanners; weighing scales (EN-042; serial/BLE); CBWTF operator portal/API/SMS-OTP (varies by state operator; email fallback); NC-018 housekeeping tasks; NC-023 authorisation & filing; NC-015 incidents/CAPA/indicators; IP-012 PEP; NC-027/NC-010/OP-013 training & immunisation; NC-006/NC-002/IP-007 waste sources; NC-005/NC-009 vendor invoices; EN-012 website disclosure JSON; state SPCB online portals (manual upload; API where provided via EN-017).

## 10. Reports & Analytics
- Daily register (statutory format), category-wise generation trend (kg/day, kg/bed/day, kg/patient-day), source-location contribution, storage compliance (% handed over ≤ 48 h), manifest register & CBWTF ack/treatment certificate status, weight variance hospital vs CBWTF, invoice reconciliation, pretreatment logs & equipment validation, segregation audit scores & non-conformances by location, accidents (Form-I register), training/immunisation compliance, monthly website disclosure, Annual Report Form-IV, SPCB inspection pack. Read models: `analytics.bmw_daily` (branch, date, category, kg, bags), `analytics.bmw_compliance_monthly`.

## 11. Notifications
- Ward/OT: bag not collected > 4 h, non-conformance raised at their location; Collector: rounds due; Storage/nodal officer: bags nearing 36/48 h, manifest ack pending > 24 h, treatment certificate overdue, variance disputes, scale offline; Admin/quality: 48 h breach, accidents (immediate), authorisation expiring 90/60/30, annual report due (60/30/7 days), training non-compliance; CBWTF: manifest issued, dispute; IP-012: needle-stick immediately.

## 12. Permissions (RBAC keys)
`bmw.configure`, `bmw.bag.generate` (clinical/support staff at locations), `bmw.label.print`, `bmw.bag.collect` (housekeeping), `bmw.round.manage`, `bmw.bag.store/weigh`, `bmw.register.read/sign`, `bmw.pretreatment.log`, `bmw.manifest.manage`, `bmw.reconcile`, `bmw.accident.report` (all) / `.manage`, `bmw.audit.conduct` (ICN/quality), `bmw.report.read/file`, `bmw.export`; vendor: `vendor.bmw.acknowledge/statement`. ABAC: location/zone scope for ward staff/collectors; branch scope.

## 13. Non-functional
- Volumes: 2000-bed hospital ≈ 0.5–1 kg/bed/day BMW → 1–2 tonnes/day, 1,500–3,000 bags/day, 3–4 collection rounds, 1–2 manifests/day; scans p95 < 200 ms; offline scanning on handhelds with sync; label print < 1 s.
- Register/report generation < 5 s; Form-IV compile < 30 s.
- Security: RLS; vendor portal scoped; audit on register amendments; no PHI (waste is not patient-linked except accident/exposure records).
- Printing: barcode labels (durable, non-chlorinated liner compatible), registers, manifests, Form-I/IV PDFs; i18n labels (English + local language per SPCB); accessibility incl. colour-blind cues.

## 14. Acceptance Criteria
1. Given a ward staff generates a red bag at Ward 3 and prints a label, then scanning it registers the bag with category RED, location, time and estimated weight; a collector scanning it 30 min later marks `collected` and storage scan-in marks `stored`.
2. Given a bag stored for 36 h without manifest, then the nodal officer is warned; at 48 h a non-compliance record is created automatically and admin notified.
3. Given microbiology lab yellow (h) bags without a linked autoclave pretreatment log, when building the manifest, then those bags cannot be included until pretreatment is logged.
4. Given a manifest issued with hospital 120 kg yellow and CBWTF acknowledges 110 kg (tolerance 5 %), then a variance dispute is opened and the CBWTF invoice for that day cannot be approved until resolved.
5. Given the daily register for a date, then it totals kg/bags by category from weighed bags, is signable by the nodal officer and locks next day 10:00; amendments after lock require reason and are audited.
6. Given a needle-stick reported via accident form, then IP-012 PEP workflow triggers immediately, NC-015 incident is created, and Form-I PDF is generated with a 24 h filing timer.
7. Given a housekeeping staff without annual BMW training, when assigned to a collection round, then NC-018 assignment is blocked/warned per policy and the supervisor is notified.
8. Given monthly reconciliation where CBWTF statement exceeds manifests by 8 %, then variance lines are listed for dispute before AP approval.
9. Given FY end, when generating Form-IV, then category-wise annual kg, treatment modes, CBWTF details, accidents and training summaries pre-fill from data; edits require reasons; filing date and SPCB acknowledgement are recorded in NC-023.
10. Given the monthly disclosure export, then EN-012 receives JSON with kg by category and treatment method for website publication.
11. Given a scale integrated at the storage room, when a bag is placed and scanned, then weight auto-fills within 2 s; if the scale is offline, manual entry is flagged `estimated`.
12. Given SPCB authorisation expiring in 30 days, then admin and nodal officer are alerted and the dashboard shows red until renewed in NC-023.
13. Given expired drugs written off in NC-006, then a yellow (d) BMW entry proposal appears for the pharmacy store; NDPS items require witness details before the bag can be included in a manifest.
14. Given the CBWTF operator does not pick up for 3 days, then each day's breach is logged with reason "operator default", the SPCB intimation template is generated, and admin is escalated.
15. Given a bag generated at 08:00 not scanned into storage by 08:00 next day, then a "missing bag" task is created for the zone supervisor.
16. Given a weighing scale with expired calibration, then all weights captured are flagged `uncalibrated` in the register until calibration is recorded in NC-020.

## 15. Enhancements / Later phases
- From VIMS sheet: BMW segregation, daily log, SPCB reports, vendor pickup tracking, colour-code compliance, weight tracking (Phase 9 core).
- (market) IoT smart bins (fill-level sensors) via EN-042, RFID trolleys, CBWTF GPS trip integration for pickup verification, AI image-based segregation audit (AI-007-like vision, later), waste-to-cost analytics per department (NC-008), sustainability dashboards (carbon), integration with CPCB centralised BMW tracking app where mandated, e-waste & hazardous waste manifests (Form 10 HOWM) with NC-002.

## 16. Open Questions for the Hospital
1. SPCB authorisation details, CBWTF operator(s), pickup frequency, rate model (per kg/per bed), and whether the operator offers portal/API/barcode scanning?
2. Existing barcode practice (pre-printed rolls vs on-demand printers at wards) and weighing scales available (models/interfaces)?
3. On-site pre-treatment equipment (autoclave for lab waste, sharps mutilators, ETP) and their validation routines?
4. Collection rounds schedule, zones, trolleys, storage room(s) capacity, refrigeration?
5. Who is the BMW nodal officer; ICN involvement in audits; training/immunisation records source?
6. State-specific Form-IV/online portal formats and monthly website disclosure requirement compliance today?
7. Handling of general/e-waste/hazardous/radioactive streams — in scope for tracking here or separate?
