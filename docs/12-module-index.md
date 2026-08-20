# 12 — Module Index (single source of truth for module IDs, phases, priorities)

Legend: **P0** = must for go-live core, **P1** = must within first release train, **P2** = post go-live.
Phase numbers refer to CLAUDE.md §6. Spec file path is `docs/modules/<folder>/<ID>-<slug>.md`.
Origin: X = VIMS master sheet (151 numbered modules), **Xe = VIMS master sheet "Missing Features / Enhancements" column only (not a numbered module)**, C = VIMS costed proposal (86 modules), M = market/competitor gap added by architect.
Row-by-row evidence for every X and C claim: `docs/14-source-coverage-crosswalk.md`.

## Domain 1 — OPD Clinical (`docs/modules/01-opd/`)

| ID     | Module                                                                                              | Phase | Pri | Origin |
| ------ | --------------------------------------------------------------------------------------------------- | ----- | --- | ------ |
| OP-001 | Front Office & Registration (Patient MPI, UHID, ABHA, appointments, walk-in, staff/doctor schedule) | 1     | P0  | X,C    |
| OP-002 | OPD / CPOE Doctor Dashboard (consultation, ICD-10, e-Rx, orders, history, templates)                | 2     | P0  | X,C    |
| OP-003 | Pharmacy Management (OP dispensing, OTC, inventory, expiry, narcotic register, interactions)        | 4     | P0  | X,C    |
| OP-004 | Laboratory Information System (orders, samples, results, validation, QC, reports, TAT)              | 3     | P0  | X,C    |
| OP-005 | OP Billing & Revenue (master bill, multi-payment, receipts, GST, discounts, refunds, MIS)           | 5     | P0  | X,C    |
| OP-006 | Emergency & Trauma Intake / Day Care (quick reg, ESI triage, ER beds, MLC, on-call, day care)       | 6     | P0  | X,C    |
| OP-007 | Vital Room / Nursing Pre-Consult (vitals, device integration, abnormal alerts, queue link)          | 2     | P0  | X,C    |
| OP-008 | Radiology & Imaging (orders, scheduling, MWL, structured reports, critical alerts, dose)            | 3     | P0  | X,C    |
| OP-009 | Orthopaedic OPD (fracture registry link, implant log, casting, X-ray comparison, rehab referral)    | 6     | P0  | X,C    |
| OP-010 | Procedure Console (scheduling, consent, documentation, consumables, billing)                        | 8     | P1  | X,C    |
| OP-011 | Dietician & Nutrition                                                                               | 8     | P2  | X,C    |
| OP-012 | Dialysis (OP)                                                                                       | 8     | P2  | X,C    |
| OP-013 | Vaccination & Immunisation (schedules, cold chain, certificates, AEFI, U-WIN/CoWIN)                 | 8     | P2  | X,C    |
| OP-014 | Health Check-Up Packages & Corporate Wellness                                                       | 8     | P2  | X,C    |
| OP-015 | Physiotherapy / Rehabilitation                                                                      | 8     | P1  | X,C    |
| OP-016 | Pain Management Clinic                                                                              | 8     | P1  | X,C    |
| OP-017 | Wound Care Clinic                                                                                   | 8     | P1  | X,C    |
| OP-018 | Telemedicine (WebRTC video, waiting room, tele-Rx, consent, recording)                              | 8     | P2  | X,C    |
| OP-019 | Doctor Mobile App (PWA → RN)                                                                        | 2/13  | P1  | X,C    |
| OP-020 | Patient Mobile App (PWA → RN)                                                                       | 10/13 | P1  | X,C    |
| OP-021 | Referral Management (internal/external, TAT, feedback)                                              | 8     | P2  | X,C    |
| OP-022 | Packages / Investigation Report Console (image upload/viewer, co-sign)                              | 3     | P1  | X      |
| OP-023 | Package Configuration & Booking (service packages, inclusions, variance)                            | 5     | P1  | X      |
| OP-024 | Fertility / ART (IVF/IUI protocols, embryology, outcomes)                                           | 8     | P2  | X      |
| OP-025 | Ophthalmology console                                                                               | 8     | P2  | X      |
| OP-026 | Dental console (charting, treatment plans)                                                          | 8     | P2  | X      |
| OP-027 | Dermatology console (photo comparison, biopsy)                                                      | 8     | P2  | X      |
| OP-028 | ENT console (audiometry, endoscopy)                                                                 | 8     | P2  | X      |
| OP-029 | Cardiology console (ECG, Echo, TMT, Holter, cath lab scheduling)                                    | 8     | P2  | X      |
| OP-030 | Pulmonology console (PFT, spirometry, sleep study, bronchoscopy)                                    | 8     | P2  | X      |
| OP-031 | Oncology / Chemotherapy day care (protocols, cycles, toxicity, BSA dosing)                          | 8     | P2  | X      |
| OP-032 | Psychiatry / Mental Health (PHQ-9, GAD-7, session notes, MHCA compliance)                           | 8     | P2  | X      |
| OP-033 | Paediatrics (growth charts WHO/IAP, milestones, immunisation, NICU follow-up)                       | 8     | P2  | X      |
| OP-034 | Geriatrics (fall risk, cognitive screen, polypharmacy review)                                       | 8     | P2  | X      |
| OP-035 | Speech Therapy                                                                                      | 8     | P2  | X      |
| OP-036 | Second Opinion (case bundling, expert panel)                                                        | 10    | P2  | X      |
| OP-037 | AYUSH / Alternative Medicine                                                                        | 8     | P2  | X      |
| OP-038 | Patient Education Portal (condition guides, pre/post-op, video library)                             | 10    | P2  | X      |
| OP-039 | OPD Nursing / Injection & Dressing room, Minor OT                                                   | 8     | P1  | M      |
| OP-040 | Obstetrics & Gynaecology antenatal clinic (ANC, EDD, high-risk flags)                               | 8     | P2  | M      |

## Domain 2 — Trauma & Orthopaedics (`docs/modules/02-trauma-ortho/`)

| ID     | Module                                                                                                | Phase | Pri | Origin |
| ------ | ----------------------------------------------------------------------------------------------------- | ----- | --- | ------ |
| TR-001 | Trauma Triage & Assessment (START/JumpSTART, ESI, GCS, RTS/ISS/TRISS, mass casualty)                  | 6     | P0  | C      |
| TR-002 | Orthopaedic Fracture Registry (AO/OTA, bone map, X-ray timeline, treatment plan)                      | 6     | P0  | C      |
| TR-003 | Implant & Prosthetics Management (UDI/serial, consignment link, patient trace, recall)                | 6     | P0  | C      |
| TR-004 | Trauma OT Coordination (emergency OT override, WHO checklist, C-arm, implants)                        | 6/7   | P0  | C      |
| TR-005 | Cast & Splint Tracking                                                                                | 6     | P1  | C      |
| TR-006 | Trauma ICU Management (ventilator, APACHE II, SOFA, sedation, multi-organ board)                      | 7     | P0  | C      |
| TR-007 | Polytrauma Coordination Dashboard (multi-specialty, surgical priority, blood, consent, team)          | 6     | P0  | C      |
| TR-008 | MLC & Forensic Documentation (register, police intimation, body map, chain of custody, court reports) | 6     | P0  | C      |
| TR-009 | Ambulance & Pre-Hospital Integration (108/112, GPS, vitals relay, ER pre-alert, handover)             | 6     | P1  | C      |
| TR-010 | Trauma Rehabilitation Pathway (FIM/Barthel, physio/OT/speech scheduling, return-to-work)              | 8     | P1  | C      |
| TR-011 | Trauma Registry & Quality (NTDB-style registry, mortality/morbidity review, TQIP indicators)          | 11    | P1  | M      |

## Domain 3 — Inpatient (`docs/modules/03-ip/`)

| ID     | Module                                                                                           | Phase | Pri | Origin |
| ------ | ------------------------------------------------------------------------------------------------ | ----- | --- | ------ |
| IP-001 | Admission & Bed Management (ADT, bed board, ward config, deposits, consent, pre-auth trigger)    | 7     | P0  | X,C    |
| IP-002 | Discharge & Summary (planning, checklist, med reconciliation, final bill, follow-up, DAMA)       | 7     | P0  | X,C    |
| IP-003 | Nursing Station (ward dashboard, vitals, MAR, SBAR notes, assessments, handover, NEWS2)          | 7     | P0  | X,C    |
| IP-004 | Nursing Mobile (bedside vitals, barcode med verify, alerts, wound photos, offline)               | 7/13  | P1  | X,C    |
| IP-005 | IP Billing (auto room charges, interim bills, package billing, TPA credit limits)                | 7     | P0  | X,C    |
| IP-006 | Operation Theatre Management (scheduling, WHO checklist, anaesthesia, notes, implants, recovery) | 7     | P0  | X,C    |
| IP-007 | Blood Bank (donors, components, cross-match, issue, transfusion, SBTC/NACO)                      | 7     | P0  | X,C    |
| IP-008 | IP Package Management (surgery bundles, variance, insurance mapping)                             | 7     | P1  | X,C    |
| IP-009 | ICU / CCU Management (hourly vitals, ventilator, scores, alerts)                                 | 7     | P0  | X,C    |
| IP-010 | Doctor IP Mobile (rounds, orders, discharge initiation)                                          | 7/13  | P1  | X,C    |
| IP-011 | Labour Room & Newborn (partograph, delivery, newborn registration, birth certificate)            | 8     | P2  | X,C    |
| IP-012 | Infection Control (HAI surveillance, antibiogram, isolation, hand hygiene, SSI)                  | 7     | P1  | X,C    |
| IP-013 | Crash Cart & Code Blue                                                                           | 7     | P1  | X,C    |
| IP-014 | IP Pharmacy / Ward Stock (unit dose, returns, narcotic double-check)                             | 7     | P1  | X,C    |
| IP-015 | NICU / PICU (incubator, feeding, growth)                                                         | 8     | P2  | X      |
| IP-016 | HDU / Step-Down Unit                                                                             | 7     | P2  | X      |
| IP-017 | Mortuary & Body Handover (register, embalming, release, death certificate, NOK)                  | 7     | P1  | X      |
| IP-018 | Patient Transfer (intra/inter-facility, handover docs, consent)                                  | 7     | P1  | X      |
| IP-019 | Transplant Module (donor registry, matching, waitlist, follow-up, NOTTO)                         | 8     | P2  | X      |
| IP-020 | Clinical Pathway Management (protocol templates, variance, outcomes)                             | 8     | P2  | X      |
| IP-021 | IP Rehabilitation                                                                                | 8     | P2  | X      |
| IP-022 | IP Dialysis                                                                                      | 8     | P2  | X      |
| IP-023 | IP Chemotherapy                                                                                  | 8     | P2  | X      |
| IP-024 | Anaesthesia Information System (PAC, intra-op record, PACU)                                      | 7     | P1  | M      |
| IP-025 | Bed Management Command Centre / Patient Flow (housekeeping dispatch, predicted discharge)        | 7     | P1  | X,M    |

## Domain 4 — Non-Clinical / ERP (`docs/modules/04-non-clinical/`)

| ID     | Module                                                                                          | Phase | Pri | Origin |
| ------ | ----------------------------------------------------------------------------------------------- | ----- | --- | ------ |
| NC-001 | Cash Counter (multi-counter, shift, reconciliation, denominations, advances, refunds)           | 1     | P0  | X,C    |
| NC-002 | Asset Management (register, tags, AMC/CMC, depreciation, PM, disposal)                          | 9     | P1  | X,C    |
| NC-003 | Digital MRD (file, ICD coding, scan/upload, deficiency, retention, medico-legal flag)           | 2/9   | P1  | X,C    |
| NC-004 | Document Management System (versions, approvals, OCR search, expiry)                            | 9     | P2  | X,C    |
| NC-005 | Purchase & Procurement (indent, RFQ, comparative, PO, GRN, 3-way match, rate contracts)         | 4     | P1  | X,C    |
| NC-006 | Stores / Inventory (item master, stock ledger, batches, FEFO, ABC/VED, transfers, counts)       | 4     | P0  | X,C    |
| NC-007 | Consignment Management (implants/devices, usage billing, auto-PO, reconciliation)               | 4     | P0  | X,C    |
| NC-008 | Consumption Entry & Cost Centres                                                                | 4     | P1  | X,C    |
| NC-009 | Accounts & Finance (GL, AP, AR, bank recon, TDS/GST, TB/P&L/BS, budget vs actual, Tally export) | 9     | P1  | X,C    |
| NC-010 | HR & Payroll (employee master, attendance, leave, payroll, PF/ESI/PT/TDS, F&F, ESS)             | 9     | P1  | X,C    |
| NC-011 | Reports & Analytics Engine (MIS dashboards, custom report builder, scheduling, export)          | 11    | P0  | X,C    |
| NC-012 | B2B / Corporate Billing (credit, invoices, SOA, aging, TDS certificates)                        | 9     | P2  | X,C    |
| NC-013 | Ambulance & Fleet Management                                                                    | 6/9   | P1  | X,C    |
| NC-014 | Staff Utility Mobile (directory, attendance, leave, payslip, announcements, helpdesk)           | 9/13  | P2  | X,C    |
| NC-015 | Quality Management NABH/JCI (indicators, SOPs, audits, CAPA, incident reporting)                | 9     | P2  | X,C    |
| NC-016 | Bio-Medical Waste Management (BMW 2016 rules, colour codes, SPCB reports)                       | 9     | P1  | X,C    |
| NC-017 | Laundry & Linen Management                                                                      | 9     | P2  | X      |
| NC-018 | Housekeeping Management (task scheduling, room turnover, inspections)                           | 7/9   | P1  | X      |
| NC-019 | Security Management (visitor log, CCTV dashboard, incidents, access control)                    | 9     | P2  | X      |
| NC-020 | Biomedical Engineering (equipment registry, calibration, breakdown, AERB)                       | 9     | P1  | X      |
| NC-021 | Vendor Management (register, contracts, performance, blacklist, portal)                         | 4/9   | P1  | X      |
| NC-022 | Budget & Financial Planning (capex/opex, variance, forecast)                                    | 9     | P2  | X      |
| NC-023 | Legal & Compliance (licence tracker AERB/PCB/Fire/Drug licence, legal cases)                    | 9     | P2  | X      |
| NC-024 | Transport / Fleet (non-ambulance vehicles)                                                      | 9     | P2  | X      |
| NC-025 | Facility Management (room booking, maintenance requests, energy, AMC)                           | 9     | P2  | X      |
| NC-026 | Marketing & CRM (leads, campaigns, loyalty, referral bonus, camps)                              | 10    | P2  | X      |
| NC-027 | Training & Development (calendar, certifications, e-learning, competency)                       | 9     | P2  | X      |
| NC-028 | Help Desk / IT Support (tickets, SLA)                                                           | 9     | P2  | X      |
| NC-029 | Attendance & Biometric Integration                                                              | 9     | P1  | X      |
| NC-030 | Duty Roster Management (shift planner, swaps, auto-assign, nurse-patient ratio)                 | 7/9   | P1  | X      |
| NC-031 | Contract Management                                                                             | 9     | P2  | X      |
| NC-032 | Patient Grievance / Complaint & Feedback                                                        | 10    | P1  | X,C    |
| NC-033 | Dietary / Kitchen & Canteen (diet orders, menu, meal dispatch, POS, subsidy, waste)             | 8/9   | P2  | X      |
| NC-034 | Doctor Fee / Payout & Incentive Management (share rules, payout sheets, referral commissions)   | 5     | P1  | M      |
| NC-035 | Camp Management (outreach camps, mobile registration, follow-up conversion)                     | 10    | P2  | M      |

## Domain 5 — Enablers & Integrations (`docs/modules/05-enablers/`)

| ID     | Module                                                                                                                                                                                                                                                                                                                    | Phase  | Pri | Origin |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --- | ------ |
| EN-001 | Data Analytics & BI (real-time KPIs, drill-down, benchmarking, custom widgets, scheduled reports)                                                                                                                                                                                                                         | 11     | P1  | X,C    |
| EN-002 | Insurance / TPA Module (payer master, tariff mapping, pre-auth, claims, denials, settlement, ROHINI)                                                                                                                                                                                                                      | 5      | P0  | X,C    |
| EN-003 | CSSD (trays, sterilisation cycles, BI/Bowie-Dick, issue/return, recall)                                                                                                                                                                                                                                                   | 7      | P0  | X,C    |
| EN-004 | Lab Machine Integration (HL7 v2 / ASTM, bi-directional, auto-validation, QC Levey-Jennings)                                                                                                                                                                                                                               | 3      | P1  | X,C    |
| EN-005 | Printer Integration (thermal/laser/label, print queue, auto-print, ZPL/ESC-POS)                                                                                                                                                                                                                                           | 0/1    | P1  | X,C    |
| EN-006 | Queue Management System (tokens, multi-dept, priority, calling, analytics)                                                                                                                                                                                                                                                | 1      | P0  | X,C    |
| EN-007 | System Admin & RBAC (users, roles, permissions, password policy, sessions, audit, settings, licences)                                                                                                                                                                                                                     | 0      | P0  | X,C    |
| EN-008 | PACS Integration & DICOM Viewer (Orthanc, OHIF, MWL, prior comparison, tele-radiology, CD/share)                                                                                                                                                                                                                          | 3      | P0  | X,C    |
| EN-009 | SMS & WhatsApp (gateways, DLT templates, triggers, delivery, DND, campaigns, opt-in)                                                                                                                                                                                                                                      | 1      | P0  | X,C    |
| EN-010 | Payment Gateway (Razorpay/UPI/cards/links/QR, refunds, reconciliation, ledger sync)                                                                                                                                                                                                                                       | 5      | P0  | X,C    |
| EN-011 | ABDM / ABHA (M1 identity, M2 HIP, M3 HIU, consent manager, HFR/HPR, scan & share)                                                                                                                                                                                                                                         | 1/11   | P0  | X,C    |
| EN-012 | Website Integration (booking widget, doctor pages, report download, chatbot, payment links, SEO)                                                                                                                                                                                                                          | 10     | P2  | X,C    |
| EN-013 | Barcode / QR Module (wristbands, labels, asset tags, verification)                                                                                                                                                                                                                                                        | 0/1    | P0  | X,C    |
| EN-014 | Complaint Management (see NC-032 — shared engine)                                                                                                                                                                                                                                                                         | 10     | P2  | X,C    |
| EN-015 | Gate Pass, Visitor & Bystander Pass Management                                                                                                                                                                                                                                                                            | 9      | P2  | X,C    |
| EN-016 | E-Sign / Digital Signature (Aadhaar eSign, DSC, document stamping, verification)                                                                                                                                                                                                                                          | 5      | P2  | X,C    |
| EN-017 | Integration Hub / ESB (connectors, mapping, retries, DLQ, monitoring, API registry)                                                                                                                                                                                                                                       | 0/3    | P1  | X,C    |
| EN-018 | TV Output / Digital Signage (token boards, ward boards, OT board, lab TAT, emergency banner)                                                                                                                                                                                                                              | 1      | P0  | X      |
| EN-019 | HL7 / FHIR API Layer (FHIR R4 server facade, HL7 v2 ADT/ORM/ORU)                                                                                                                                                                                                                                                          | 3/11   | P1  | X      |
| EN-020 | Biometric Integration (staff attendance, patient identity)                                                                                                                                                                                                                                                                | 9      | P1  | X      |
| EN-021 | CCTV Integration (dashboard, event tagging)                                                                                                                                                                                                                                                                               | 9      | P2  | X      |
| EN-022 | Backup & Disaster Recovery (auto backup, PITR, DR drills, RPO/RTO)                                                                                                                                                                                                                                                        | 0      | P0  | X      |
| EN-023 | Cybersecurity Module (threat monitor, vuln scan, patching, incident log, SIEM)                                                                                                                                                                                                                                            | 0/9    | P1  | X      |
| EN-024 | Audit Trail & Logging (activity, data change history, login audit, PHI access)                                                                                                                                                                                                                                            | 0      | P0  | X      |
| EN-025 | Single Sign-On (OIDC/SAML/LDAP/AD, session mgmt)                                                                                                                                                                                                                                                                          | 0      | P1  | X      |
| EN-026 | API Gateway (registry, keys, rate limits, versioning, developer portal)                                                                                                                                                                                                                                                   | 0/11   | P1  | X      |
| EN-027 | Master Data Management (facility, service, drug, ICD/SNOMED/LOINC, sync engine, governance)                                                                                                                                                                                                                               | 0/1    | P0  | X      |
| EN-028 | Consent Management (digital consent forms, e-sign, audit, template builder, DPDP consent ledger)                                                                                                                                                                                                                          | 1      | P0  | X      |
| EN-029 | Clinical Decision Support rules engine (allergy, interaction, dose range, critical values, NEWS2, sepsis)                                                                                                                                                                                                                 | 2      | P0  | X      |
| EN-030 | Patient Feedback & Survey (NPS, post-visit, WhatsApp survey, Google routing)                                                                                                                                                                                                                                              | 10     | P1  | X      |
| EN-031 | NABL Integration / Lab Quality (QC upload, EQA, instrument validation)                                                                                                                                                                                                                                                    | 3      | P1  | X      |
| EN-032 | Email Integration (SMTP/SES, templates, delivery tracking)                                                                                                                                                                                                                                                                | 0      | P0  | X      |
| EN-033 | IVR / Call Centre Integration (IVR flows, call logging, appointment via IVR, recording)                                                                                                                                                                                                                                   | 10     | P2  | X      |
| EN-034 | Kiosk Integration (self check-in, token, payment, feedback)                                                                                                                                                                                                                                                               | 10     | P2  | X      |
| EN-035 | RIS – Radiology Information System — **ownership & integration contract map** (which module owns each classic RIS function: OP-008 order/worklist/report, EN-008 PACS/MWL/MPPS/viewer, EN-019 HL7/FHIR, EN-017 transport) + third-party-RIS replacement/coexistence path. Full spec exists; zero net-new application code | 3      | P0  | X      |
| EN-036 | DIU – Data Import / Migration Utility (bulk upload, ETL, dedupe, rollback)                                                                                                                                                                                                                                                | 1/11   | P1  | X,C    |
| EN-037 | Notification Centre (in-app bell, push (Web Push/FCM), escalation, on-call routing)                                                                                                                                                                                                                                       | 0      | P0  | M      |
| EN-038 | Workflow & Approval Engine (configurable approval matrices, SLA timers, escalations)                                                                                                                                                                                                                                      | 0      | P0  | M      |
| EN-039 | Forms & Template Builder (dynamic clinical forms, print templates, letterheads)                                                                                                                                                                                                                                           | 0/2    | P0  | M      |
| EN-040 | Licence & Subscription Management (SaaS plans, module activation, seats, billing)                                                                                                                                                                                                                                         | 0      | P0  | M      |
| EN-041 | Multi-branch / Group Architecture (parent-child, shared MPI, consolidated reporting)                                                                                                                                                                                                                                      | 0      | P0  | M      |
| EN-042 | Device Gateway / IoT (vitals monitors, cold-chain sensors, RO water, autoclaves)                                                                                                                                                                                                                                          | 7/8/12 | P2  | Xe,M   |

## Domain 6 — Revenue Cycle Management (`docs/modules/06-rcm/`)

| ID     | Module                                                                                            | Phase | Pri | Origin |
| ------ | ------------------------------------------------------------------------------------------------- | ----- | --- | ------ |
| RC-001 | Claims Management (submission, tracking, resubmission, settlement, NHCX/M4)                       | 5/11  | P1  | X,C    |
| RC-002 | Pre-Authorisation Engine                                                                          | 5     | P1  | X,C    |
| RC-003 | Tariff Management (rate master, payer-wise, effective-dated revisions, comparison)                | 5     | P0  | X,C    |
| RC-004 | Denial Management (reasons, appeals, root cause, trends)                                          | 5/11  | P1  | X      |
| RC-005 | AR Follow-Up (aging, payer outstanding, reminders, write-off)                                     | 9     | P1  | X      |
| RC-006 | Revenue Leakage Audit (charge capture check, unbilled services, variance alerts)                  | 5     | P1  | X      |
| RC-007 | Government Schemes (PMJAY/Ayushman, CGHS, ECHS, ESIC, state schemes — packages, empanelment, TMS) | 5     | P1  | M      |
| RC-008 | Patient Cost Estimator & Quotation Engine                                                         | 5     | P1  | M      |

## Domain 7 — Patient Engagement (`docs/modules/07-patient-engagement/`)

| ID     | Module                                                                                  | Phase | Pri | Origin |
| ------ | --------------------------------------------------------------------------------------- | ----- | --- | ------ |
| PE-001 | Patient Portal (web/PWA: records, reports, appointments, bills, family, feedback, ABHA) | 10    | P1  | X,C    |
| PE-002 | Follow-Up Management (reminders, recall lists, no-show, post-discharge calls)           | 10    | P1  | X,C    |
| PE-003 | Health Education Library (multilingual, video, push)                                    | 10    | P2  | X      |
| PE-004 | Patient Community (support groups, forum, Q&A, events)                                  | 10    | P2  | X      |
| PE-005 | Loyalty & Wellness Programme (points, goals, rewards, annual check-up reminders)        | 10    | P2  | X      |
| PE-006 | Corporate Client Portal (employee health, utilisation, invoices)                        | 10    | P2  | M      |
| PE-007 | Referring Doctor Portal (referral tracking, reports, payouts)                           | 10    | P2  | M      |
| PE-008 | TPA / Payer Portal (pre-auth queries, document exchange)                                | 10    | P2  | M      |

## Domain 8 — AI & Advanced Tech (`docs/modules/08-ai/`)

| ID     | Module                                                                                                | Phase | Pri | Origin |
| ------ | ----------------------------------------------------------------------------------------------------- | ----- | --- | ------ |
| AI-001 | AI Chatbot (patient queries, symptom triage, appointment bot, FAQ, human hand-off)                    | 12    | P2  | X,C    |
| AI-002 | AI Clinical Decision Support (LLM layer over EN-029: protocol suggest, drug-diagnosis, triage assist) | 12    | P2  | X,C    |
| AI-003 | AI Document Extraction (Rx OCR, lab report parsing, insurance docs, auto-fill)                        | 12    | P2  | X,C    |
| AI-004 | AI Voice Assistant / Ambient Scribe (voice-to-note in Indian languages, command parsing)              | 12    | P2  | X      |
| AI-005 | Predictive Analytics (readmission, no-show, LOS, demand, bed forecast, inventory)                     | 12    | P2  | X      |
| AI-006 | AI-Assisted Coding (ICD-10/ICD-11, procedure codes, DRG grouper, audit)                               | 12    | P2  | X      |
| AI-007 | AI Radiology Assist (annotation, abnormality flag, report draft, priority queue)                      | 12    | P2  | X      |
| AI-008 | Conversational BI (natural-language reports over analytics schema)                                    | 12    | P2  | Xe,M   |

**Totals:** 40 OPD + 11 Trauma/Ortho + 25 IP + 35 Non-clinical + 42 Enablers + 8 RCM + 8 Engagement + 8 AI = **177 modules**.
Every module from the VIMS 151-list and the 86-module costed proposal maps to at least one ID above, and every ID above has a spec file.
**The row-by-row proof is `docs/14-source-coverage-crosswalk.md`** (151 rows and 86 rows tabulated individually); `11-market-analysis.md` §9.1 gives the commercial narrative.
Breakdown: 148 IDs trace to the 151-row sheet, 11 exist only because of the costed proposal (TR-001…TR-010, AI-002), 18 are architect additions.
