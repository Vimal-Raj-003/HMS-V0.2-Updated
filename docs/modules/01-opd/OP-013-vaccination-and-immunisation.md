# OP-013 — Vaccination & Immunisation (Schedules, Administration, Cold chain, Certificates, AEFI, U-WIN/CoWIN)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Module ID       | OP-013                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Phase           | 8                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Complexity      | Low–Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on      | OP-001 (patient/DOB, appointments), OP-033 (paediatrics growth/immunisation view), OP-040 (antenatal Td), IP-011 (birth-dose BCG/OPV/HepB at labour room), OP-007 (pre-vaccination vitals/temperature), OP-003/NC-006 (vaccine stock, batches, expiry, FEFO, VVM), EN-042 (cold-chain IoT sensors), NC-020 (ILR/deep freezer assets), EN-013 (barcode/QR: vial GS1, certificate QR), EN-009 (SMS/WhatsApp reminders), PE-001/PE-002 (portal, recall), OP-005 (billing), EN-028 (consent), NC-015 (AEFI incident), NC-035 (camp management — school/corporate camps), EN-011 (ABDM ImmunizationRecord), EN-017 (U-WIN/CoWIN connectors), OP-014 (corporate wellness flu drives), OP-018 (travel advice tele) |
| Feature flag    | `module.vaccination.enabled` (sub: `vaccination.cold_chain_iot`, `vaccination.uwin`, `vaccination.camps`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Primary roles   | Nurse — OPD/Immunisation (16), Paediatrician/Physician (6), Pharmacist/Store keeper for vaccine stock (30/44)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Secondary roles | Receptionist (24), Cold-chain handler/Biomedical (48), Quality (54, AEFI), Corporate HR client (61, camps), Patient/Parent (portal), Billing (27), Auditor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Regulatory      | Universal Immunisation Programme / National Immunisation Schedule (NIS) & IAP Advisory Committee on Vaccines (ACVIP) schedule 2023–24, U-WIN (MoHFW) & CoWIN (COVID-19) APIs, AEFI Surveillance & Response Operational Guidelines 2024 (MoHFW/AEFI Secretariat: FIR within 24 h serious, PIR within 7 days, CIF within 90 days; causality WHO/AEFI classification), Open Vial Policy (MoHFW), Vaccine Vial Monitor (VVM) & cold-chain norms (+2 to +8 °C ILR; −15 to −25 °C DF), Effective Vaccine Management (EVM), CDSCO (vaccine batch release), Yellow fever IHR certificate (WHO), DPDP (child data — parental consent), ABDM ImmunizationRecord                                                       |

## 1. Purpose

OP-013 manages every vaccine given in the hospital (paediatric NIS/IAP schedules auto-generated from DOB, adult and travel vaccines, antenatal Td, occupational HepB/flu, COVID), the safe administration workflow (verify due dose, scan vial barcode/batch/expiry/VVM, record site/route/dose, consent), vaccine stock and cold-chain temperature monitoring with breach alerts and multi-dose open-vial wastage tracking, QR-verifiable certificates and vaccination cards, AEFI documentation with mandatory reporting workflow, reminders/recall for due and overdue doses, coverage statistics, and government portal sync (U-WIN, CoWIN).

## 2. Users & Jobs-to-be-done

- **Immunisation nurse** (tablet/desktop; 50–200 doses/day; ≤ 90 s per dose): call patient, verify identity/age/schedule, screen contraindications, scan vial, record, print card/certificate, book next due, log wastage at session close.
- **Paediatrician/Physician**: review schedule, prescribe catch-up/travel/optional vaccines, manage AEFI clinically, sign certificates.
- **Store/pharmacist**: receive vaccine stock (batch, expiry, VVM stage, diluent), issue to ILR at clinic, stock counts, temperature log review.
- **Receptionist**: appointments for vaccination clinic, corporate/school camp bookings.
- **Parent/patient** (app/portal): see schedule, due alerts, download certificates, book.
- **Quality/AEFI nodal officer**: AEFI register, reporting to district immunisation officer, causality assessment follow-up.

## 3. Core Workflows

### 3.1 Schedule management

1. On newborn registration (IP-011) or paediatric patient creation with DOB → **schedule engine** generates due doses from selected calendar (NIS default; IAP optional/parent-choice vaccines flagged "optional"), each with due date, earliest/latest window, minimum interval rules; catch-up rules for late starters (age-based algorithm) → visible on child's immunisation timeline & OP-033.
2. Adult schedules: antenatal Td/Tdap (OP-040), HepB/flu/varicella/MMR for HCWs (NC-010 occupational health), influenza/pneumococcal/zoster ≥ 60 y (OP-034), HPV 9–14 y, rabies PEP (day 0/3/7/14/28 with RIG) and PrEP, COVID boosters.
3. **Travel vaccines**: destination-based recommendation table (WHO ITH: yellow fever (IHR certificate), meningococcal ACWY (Hajj), typhoid, HepA, JE, cholera, rabies, malaria chemoprophylaxis advice) → doctor confirms.
4. Doctor can add/modify individual plan (medical exemption with reason; contraindication flags e.g. egg allergy, immunocompromised → live vaccines blocked).

### 3.2 Administration

1. Nurse selects patient (scan card/UHID) → **due today** list + overdue + optional; verifies age/interval rules (system blocks too-early or duplicate; warns overdue) → pre-screening (fever ≥ 38 °C, acute illness, allergy to previous dose, pregnancy for live vaccines, immunosuppression, bleeding disorder) via OP-007 temp; consent (parent, EN-028 quick e-consent; once per visit).
2. **Scan vial barcode** (GS1 GTIN/batch/expiry; or select batch from ILR stock) → system validates: correct antigen, batch not expired, VVM stage ≤ 2, open-vial time within policy (BCG 4 h, OPV/measles per open-vial policy 4 h; multi-dose DPT/HepB/Td 28 days if VVM ok), diluent matched & reconstitution time; records vaccine, brand, batch, expiry, dose #, dose volume, site (L/R deltoid/anterolateral thigh/oral/intranasal), route (IM/SC/ID/oral/IN), vaccinator; multiple vaccines per visit (site plan suggestion), simultaneous live vaccine interval check (28 days).
3. Save → stock decrement (dose-level, NC-006 with open-vial tracking) → next due auto-computed → appointment offered → card/certificate print → Event `vaccination.administered`; ABDM ImmunizationRecord (EN-011) & U-WIN push (queue).
4. Observation 30 min (post-vaccination waiting; timer on nurse board) → any reaction → AEFI form.

### 3.3 AEFI

1. Any adverse event (minor: fever/local pain; serious: anaphylaxis, hospitalisation, death, cluster) → **AEFI form** (MoHFW format: patient, vaccine(s), batch, site, onset, symptoms, treatment, outcome, classification minor/severe/serious; programme error assessment) → serious → mandatory reporting: notify hospital AEFI nodal officer + district immunisation officer within 24 h (FIR generation), NC-015 incident; PIR (7 days) and CIF (90 days) tasks; causality (WHO/AEFI classification A1–D) recorded by committee; **AEFI follow-up workflow** (calls day 1/3/7 via PE-002); batch-level AEFI cluster detection (≥ 2 serious same batch → quarantine batch in stock, alert).

### 3.4 Inventory & cold chain

1. Vaccine items in NC-006 with attributes (antigen, doses/vial, VVM type, storage range, diluent link, open-vial hours/days); receipt with batch/expiry/VVM stage & temperature on arrival (data logger check); issue to clinic ILR; **daily stock** & wastage (open-vial discard, expiry, breakage, VVM change, cold-chain breach) → wastage rate per antigen.
2. **Cold chain**: ILR/DF assets (NC-020) with temperature loggers (IoT via EN-042: LoRa/Wi-Fi/BLE sensors, e.g. −25/+8 °C, log every 10–15 min; manual twice-daily reading fallback) → breach (> +8 or < +2 for ILR, DF > −15) → immediate alert (SMS/push/call escalation) to cold-chain handler & pharmacist → **breach event** with duration/peak → affected batches marked "hold" pending Shake test/VVM/manufacturer guidance → release or discard with record; power failure/door-open events; monthly temperature report.
3. Vaccine forecast: consumption × births/registrations trend + campaigns → indent suggestion (NC-005).

### 3.5 Certificates & reminders

- **Certificate/card**: per dose or complete-series certificate (hospital template; COVID via CoWIN certificate; yellow fever IHR format from AYFC-approved centres only) with QR (EN-013) verifiable at public URL (signed payload, no PHI beyond name/DOB/vaccine/dates); digital in portal + print; regenerate on correction with version.
- **Reminders** (EN-009 DLT templates): 7 days before due → 1 day before → due day → overdue +7/+30 (WhatsApp/SMS/push, parent's language); recall list for overdue; opt-out respected.

### 3.6 Camps (flag `vaccination.camps`; NC-035)

- School/corporate/community drives: roster upload (name/DOB/parent phone or employee ID) → bulk consent collection → session planning (doses needed, ILR carrier, staff) → offline tablet administration (queue sync) → certificates bulk send → coverage report per school/corporate (OP-014 corporate wellness dashboard link).

### 3.7 Exceptions

- Wrong vaccine/dose/site error → incident + AEFI programme-error path; entered in error → void with reason (stock reversal, certificate revoked with QR invalidation); patient refuses → documented refusal (counselling flag); offline: administration queued with scanned batch, stock reconciled on sync.

## 4. Data Model (schema `specialty`)

- **vaccine_master** (mdm): id, hospital_id?, antigen_code (WHO/ATC/CVX-like), name, brand, manufacturer, doses_per_vial, dose_volume_ml, route, default_site_by_age jsonb, storage enum(ilr/df), vvm_type, open_vial_hours, requires_diluent, diluent_item_id, live bool, item_id (NC-006), is_active.
- **immunisation_schedules** (calendar templates): id, hospital_id?, name (NIS/IAP/adult/travel), rules jsonb ([{antigen, dose_no, due_age_days, min_age_days, max_age_days?, min_interval_days_from_prev, optional bool, catch_up rules}]), version, effective_from.
- **patient_immunisation_plans**: id, hospital_id, patient_id, schedule_id, generated_at; **plan_doses**: id, plan_id, patient_id, antigen_code, dose_no, due_date, window_from/to, status enum(due/given/overdue/skipped/contraindicated/refused/given_elsewhere), given_record_id?, reason, next_reminder_at; index (hospital_id, due_date, status), (patient_id).
- **vaccination_records**: id, hospital_id, branch_id, patient_id, visit_id?, plan_dose_id?, vaccine_id, antigen_code, dose_no, batch_no, expiry_date, vvm_stage, vial_id (open_vials), diluent_batch?, site, route, dose_ml, administered_at, administered_by, ordered_by?, consent_id, screening jsonb (temp, contraindication answers), observation_until, camp_id?, source enum(in_house/camp/external_history/uwin_sync), external_facility?, certificate_id?, uwin_status enum(pending/synced/failed/na), abdm_pushed_at, voided bool, void_reason, version; index (hospital_id, patient_id, administered_at), (batch_no).
- **open_vials**: id, hospital_id, branch_id, item_id, batch_no, opened_at, opened_by, doses_total, doses_used, discard_due_at, discarded_at, discard_reason enum(time_expired/vvm/breach/contaminated/empty), wastage_doses.
- **cold_chain_units**: id, hospital_id, branch_id, asset_id (NC-020), type enum(ilr/deep_freezer/vaccine_carrier/cold_box/walk_in), location, min_c, max_c, sensor_id?, status; **cold_chain_readings** (partitioned): unit_id, at, temp_c, source enum(iot/manual), power bool, door_open bool; **cold_chain_breaches**: unit_id, started_at, ended_at, peak_c, duration_min, batches_affected jsonb, action enum(hold/released/discarded), decided_by, note.
- **aefi_reports**: id, hospital_id, patient_id, vaccination_record_ids uuid[], onset_at, reported_at, reporter_id, symptoms jsonb, severity enum(minor/severe/serious), category enum(vaccine_reaction/programme_error/immunisation_anxiety/coincidental/unknown), treatment, outcome enum(recovered/recovering/sequelae/hospitalised/died/unknown), fir_sent_at, pir_due/sent, cif_due/sent, causality enum, district_case_id, incident_id (NC-015), followups jsonb.
- **vaccination_certificates**: id, hospital_id, patient_id, type enum(dose/series/yellow_fever/covid/custom), record_ids uuid[], qr_token, signed_by, issued_at, version, revoked_at, pdf_key.
- **vaccination_camps** (NC-035 link): id, name, org, date, location, roster jsonb, sessions, coverage stats.
- **travel_recommendations** (mdm): country/region, vaccines[], notes, source version.

## 5. Business Rules & Validations

- Dose validity: not before min age or min interval (block); optional vaccines need doctor/parent selection; live vaccines simultaneous or ≥ 28 days apart; contraindications block (override by doctor with reason); pregnancy → live vaccine block.
- Vial validation: expiry, VVM ≤ stage 2, open-vial policy per antigen (BCG/measles/MR/JE reconstituted ≤ 4 h; OPV/DPT/Td/HepB/IPV multi-dose ≤ 28 days if VVM ok, not frozen, sterile) — hard block; batch on cold-chain hold → block.
- Stock decrement per dose from open vial; wastage auto-computed at discard (multi-dose vial wastage tracking); wastage > threshold (e.g. BCG 50 %, others 10–25 %) flagged in report.
- Cold-chain: readings every ≤ 15 min IoT or twice daily manual; breach = out of range ≥ 30 min (config) → alert; batches in unit at breach time auto-linked; release requires pharmacist + doctor decision logged.
- AEFI serious → FIR within 24 h task with escalation; PIR 7 d, CIF 90 d; batch cluster rule → auto-hold; AEFI cannot be deleted; anonymised export for DIO.
- Certificates: QR public verification returns minimal fields; revocation on void; yellow fever only if branch is authorised centre (config flag).
- Reminders follow DND/opt-in and quiet hours; language per patient.
- Consent: parental for minors; capture once per visit; refusal recorded (counselling).
- U-WIN/CoWIN: push each administered dose (beneficiary registration/verification via Aadhaar/ABHA/mobile per portal rules); failures queued/retried; manual reference entry supported when portal offline; never block clinical record on portal failure.
- Numbering `VACC_CERT`; records versioned; retention: lifetime of patient (≥ 25 y for childhood records).

## 6. API Surface (`/api/v1/vaccination`)

| Method         | Path                                                                                                 | Purpose                                         | Permission                                                       | Idem | Pag    |
| -------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- | ---- | ------ |
| GET/POST/PUT   | /masters/vaccines, /schedules, /travel-recommendations                                               | config                                          | vaccination.configure                                            | Y    | cursor |
| POST           | /patients/{id}/plan (schedule_id)                                                                    | generate/regenerate plan                        | vaccination.plan.create                                          | Y    | –      |
| GET            | /patients/{id}/plan                                                                                  | timeline (due/given/overdue)                    | vaccination.plan.read                                            | –    | –      |
| PATCH          | /plan-doses/{id}                                                                                     | skip/contraindicate/refuse/mark given elsewhere | vaccination.plan.update                                          | Y    | –      |
| GET            | /due?date=&branch=&overdue=                                                                          | worklist/recall                                 | vaccination.plan.read                                            | –    | cursor |
| POST           | /records                                                                                             | administer (scan payload)                       | vaccination.record.create                                        | Y    | –      |
| POST           | /records/{id}/void                                                                                   | void with reason                                | vaccination.record.void                                          | Y    | –      |
| GET            | /records?patient=&batch=                                                                             | history/batch trace                             | vaccination.record.read                                          | –    | cursor |
| POST/GET       | /open-vials, /open-vials/{id}/discard                                                                | vial lifecycle                                  | vaccination.stock.manage                                         | Y    | –      |
| GET            | /stock?branch=                                                                                       | vaccine stock by batch/VVM                      | vaccination.stock.read                                           | –    | –      |
| POST           | /cold-chain/readings (device token) , GET /cold-chain/units, /breaches; POST /breaches/{id}/decision | cold chain                                      | integration.coldchain.ingest / vaccination.coldchain.read/manage | Y    | cursor |
| POST/GET/PATCH | /aefi                                                                                                | AEFI reports & follow-up                        | vaccination.aefi.create/read/update                              | Y    | cursor |
| POST           | /aefi/{id}/report (fir/pir/cif)                                                                      | generate/send report                            | vaccination.aefi.report                                          | Y    | –      |
| POST           | /certificates, GET /certificates/{id}/pdf, GET /public/verify/{token}                                | certificates                                    | vaccination.certificate.issue/read; public                       | Y    | –      |
| POST           | /camps, /camps/{id}/roster, /camps/{id}/sessions                                                     | camps                                           | vaccination.camp.manage                                          | Y    | cursor |
| POST           | /uwin/sync/{record}, GET /uwin/status                                                                | portal sync ops                                 | vaccination.portal.sync                                          | Y    | –      |
| GET            | /stats/coverage?antigen=&period= , /stats/wastage, /stats/dashboard                                  | reports                                         | vaccination.report.read                                          | –    | –      |

## 7. Domain Events (outbox)

- `vaccination.plan.generated`, `vaccination.dose.due|overdue` → PE-002/EN-009 reminders; `vaccination.administered` {record_id, patient_id, antigen, dose_no, batch} → NC-006 stock, EN-011 ImmunizationRecord, U-WIN queue, OP-033 timeline, OP-005 billing, certificate; `vaccination.voided`; `vaccination.aefi.reported` {severity} → NC-015, nodal officer alert, DIO report task; `vaccination.aefi.cluster` {batch} → stock hold; `coldchain.breach.started|ended|decided` → alerts, stock hold/release; `vaccination.certificate.issued|revoked`; `vaccination.camp.completed` → OP-014/NC-035.
- Consumes: `patient.registered` (DOB), `newborn.registered` (IP-011), `iot.reading` (EN-042), `stock.batch.received` (NC-006), `visit.checked_in`.

## 8. Screens (UI)

1. **Immunisation clinic worklist** (tablet/desktop): today's appointments + walk-ins; patient card with due/overdue chips; `F3` scan patient; observation timers panel; real-time.
2. **Patient immunisation timeline** (desktop/tablet; also in OP-033 and portal): grid antigen × dose with colours (given green with batch tooltip, due blue, overdue red, optional grey, contraindicated hatched); catch-up wizard.
3. **Administer dose** (tablet): screening checklist, `F4` scan vial → auto-fill batch/expiry/VVM, site picker on body diagram, multi-vaccine batch save (`Ctrl+S`), print card/certificate (`Ctrl+P`), book next due; offline-capable.
4. **AEFI form** (tablet/desktop): MoHFW fields, severity auto-classifier hints, attach photos, report buttons (FIR/PIR/CIF), follow-up tasks.
5. **Cold-chain dashboard** (desktop/TV, dark): units with live temp gauge, sparkline 24 h, breach banners, door/power icons; breach decision dialog; monthly log print.
6. **Vaccine stock & vials** (desktop pharmacist): batches by unit with VVM/expiry, open vials with countdown, discard/wastage entry, forecast/indent suggestion.
7. **Camp console** (desktop + offline tablet): roster upload, session board, bulk certificate send, coverage.
8. **Public certificate verification page** (phone web): QR scan → minimal verified details.
9. **Coverage & wastage reports** (desktop).

## 9. Integrations

- U-WIN (MoHFW) APIs via EN-017 connector (beneficiary registration/search, session/dose recording, certificate fetch); CoWIN APIs (COVID vaccination & certificate); ABDM ImmunizationRecord (EN-011); IoT temperature loggers (EN-042: MQTT/HTTP, vendors e.g. eVIN-compatible loggers, Tempsen/Elitech/Berlinger; SMS-based loggers fallback); GS1 barcode scanning (EN-013); EN-009 reminders; NC-035 camps; NC-005/NC-006 stock; PE-001 portal.
- Portal outages: local queue with retries/backoff; manual "portal ref" field; reconciliation report.

## 10. Reports & Analytics

- Coverage by antigen/dose/age cohort (fully immunised children %, dropout rate DPT1→DPT3), due/overdue lists, doses per day/nurse, wastage per antigen (open-vial/expiry/breach), cold-chain compliance (readings %, breaches, durations), AEFI register & rates per 100k doses, batch trace (all recipients of a batch), U-WIN sync status, travel vaccine volumes, camp coverage per organisation, revenue by vaccine. Read models `analytics.vaccination_daily`, `analytics.coldchain_daily`.

## 11. Notifications

- Parent/patient: due D-7, D-1, D0, overdue +7/+30 (WhatsApp/SMS/push), certificate ready link, AEFI follow-up check-in, camp schedule.
- Staff: cold-chain breach (SMS + push + call escalation chain: handler → pharmacist → biomedical → admin), open-vial discard due, batch expiry ≤ 30 days, AEFI serious reported (nodal officer, MS), FIR/PIR/CIF due, U-WIN sync failures > 24 h, stock below reorder.

## 12. Permissions (RBAC keys)

`vaccination.configure`, `vaccination.plan.create|read|update`, `vaccination.record.create|read|void`, `vaccination.stock.read|manage`, `vaccination.coldchain.read|manage`, `vaccination.aefi.create|read|update|report`, `vaccination.certificate.issue|read`, `vaccination.camp.manage`, `vaccination.portal.sync`, `vaccination.report.read`, `vaccination.export`. Defaults: Immunisation nurse — plan read/update, record create, certificate issue, aefi create, stock read; Doctor — plan create/update (contraindications), aefi update, certificate sign; Pharmacist/store — stock manage, coldchain manage; Biomedical — coldchain read/manage; Quality — aefi read/report, report read; Receptionist — plan read (booking); Patient — own plan/certificates.

## 13. Non-functional

- Enterprise: 500–1500 doses/day across branches, 50 cold-chain units × 96 readings/day; administer save p95 < 200 ms; scan-to-validate < 150 ms (batch cache); certificate PDF < 2 s; breach alert latency < 60 s from reading.
- Offline: clinic/camp tablets queue administrations with local batch stock decrement; conflicts (vial exhausted on sync) → wastage/negative flagged for pharmacist review; cold-chain readings buffered on device.
- Print: vaccination card (A5/A6), certificate A4 with QR, vial/ILR labels.
- i18n: reminders/certificates in local languages; WCAG; large touch targets for camp mode.
- Security: public verify endpoint rate-limited, no PHI beyond minimal; child data purpose-limited (DPDP); audit on voids/breach decisions.

## 14. Acceptance Criteria

1. Given a child born on 1 Jan, when registered, then NIS plan shows BCG/OPV0/HepB0 at birth, Penta1/OPV1/Rota1/PCV1/IPV1 due at 6 weeks (12 Feb) etc., with windows.
2. Given Penta1 given on day 42, when Penta2 is attempted on day 60, then the system blocks (min interval 28 days) with the earliest date shown.
3. Given a scanned vial with VVM stage 3, then administration is blocked and the vial can be discarded with reason "vvm".
4. Given a multi-dose vial opened at 09:00 (28-day policy), when a dose is drawn on day 29, then block; when discarded at day 28 with 3 doses left, wastage = 3 and appears in wastage report.
5. Given an ILR reading of +9.5 °C for 35 minutes, then a breach opens, cold-chain handler receives SMS+push within 60 s, batches in that ILR are placed on hold and blocked for administration until a release decision is recorded.
6. Given an AEFI marked serious, then FIR task with 24 h deadline is created for the nodal officer, NC-015 incident is drafted, and PIR/CIF tasks are scheduled at 7 and 90 days.
7. Given two serious AEFIs on the same batch within 30 days, then the batch is auto-held and an alert is sent to pharmacist and quality.
8. Given a certificate QR scanned by a third party, then the public page shows name, DOB (masked day optional), vaccine, dose dates and issuer — nothing else — and shows "revoked" if voided.
9. Given U-WIN API is down, when a dose is recorded, then the clinical record saves, uwin_status = pending, retries with backoff and a reconciliation list shows pending items.
10. Given a due date in 7 days, then a WhatsApp reminder (approved DLT template, parent's language) is queued at 10:00 hospital time and not sent if the parent has opted out.
11. Given a camp tablet offline for 3 hours, when 120 doses are recorded, then all sync with correct batches and open-vial counts and no duplicate records.
12. Given a nurse without `vaccination.record.void`, when voiding, then 403; a doctor's void reverses stock and revokes the certificate.

## 15. Enhancements / Later phases

- Sheet row 9 enhancements: cold-chain IoT temperature sensors (Phase 8 flag via EN-042), vaccine forecast from birth-rate data (Phase 11 analytics/AI-005), multi-dose vial wastage reduction (core tracking + session planning suggestions), U-WIN integration (Phase 8/11 connector), school vaccination camp management (Phase 10 with NC-035), AEFI follow-up workflow (core).
- Costed proposal line 1568 (schedule generation, administration, batch/expiry, certificate, reminder SMS, AEFI, CoWIN) — core.
- (market) SMART HMIS/SmartHospital vaccination basics — covered; digital vaccination passport (PE-001), travel clinic tele-advice (OP-018), occupational health HCW immunisation dashboard (NC-010), AI dropout prediction (AI-005).

## 16. Open Questions for the Hospital

1. Which schedule is default (NIS vs IAP) and which optional vaccines are offered? Do you follow open-vial policy for multi-dose vials?
2. Cold-chain: number/type of ILRs/DFs, existing loggers/eVIN, alert escalation contacts?
3. U-WIN/CoWIN credentials & facility IDs; is the hospital an authorised yellow-fever centre?
4. AEFI nodal officer and district reporting contacts; internal AEFI committee?
5. Camps: schools/corporates served, offline requirement, certificate branding?
6. Vaccine pricing (MRP/negotiated) and whether vaccines are billed via pharmacy (OP-003) or vaccination service.
7. Certificate template/signatory; QR verification hosting domain.
