# 05 — Roles, Logins & Access Control

## Login model

- **One login URL per tenant** (`https://<hospital>.vimshms.com/login` or `/login` on-prem). The system identifies the
  user, resolves roles + branch scope, and routes to the role's **home workspace**. Users with multiple roles get a
  workspace switcher (e.g., a doctor who is also HOD; a nurse who is also infection-control officer).
- **Staff:** username/email/employee-ID + password (Argon2id, policy configurable: min 12, complexity, 90-day expiry,
  history 5, lockout after 5 fails) + optional TOTP/WebAuthn 2FA (mandatory for Admin, Billing, Pharmacy narcotics,
  Blood bank). SSO via OIDC/SAML/LDAP when configured. Device-bound sessions; idle timeout 15 min (clinical
  screens can use "quick re-auth" PIN); concurrent session limit; force logout.
- **Patients/family:** mobile OTP (no password) or ABHA login; optional email; family members linked with consent.
- **Kiosk / TV / Devices:** device tokens with scoped permissions (`display.token_board.read`), pairing code.
- **External partners (TPA, corporate HR, referring doctors, vendors):** invite-based accounts, scoped portals, 2FA.
- **Break-glass:** any clinician can open a chart outside their care team by entering a reason; logged as `READ_PHI`
  and reported to the Privacy Officer daily.

## Model: RBAC + ABAC

- **Permission key** = `<module>.<resource>.<action>` (e.g. `lab.result.validate`, `billing.bill.discount.approve`,
  `pharmacy.narcotic.dispense`, `patient.record.read`). Registered in code (`packages/contracts/permissions.ts`) and
  synced to `core.permissions` at boot.
- **Roles** = named sets of permissions, per hospital, cloneable from **system templates** below; hospital admin can
  create custom roles. Roles are assigned per **branch** with optional **department/ward/unit scope**.
- **ABAC conditions** on top: `own_patients_only`, `own_department_only`, `assigned_ward_only`, `amount_limit`
  (discount ≤ 10 %), `time_window` (night shift), `requires_second_person` (blood issue, narcotics), `care_team_only`.
- **Data classes:** PHI, financial, HR, operational. Export/print of PHI needs `*.export` permission and is audited.

## System role templates (60+) and home workspaces

| #   | Role template                             | Home workspace                   | Key permission families                                                                         |
| --- | ----------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Super Admin (SaaS operator)               | Tenant console                   | tenants, licences, plans, global masters, support impersonation (audited)                       |
| 2   | Hospital Admin / Group Admin              | Admin console                    | users, roles, settings, masters, branches, feature flags, audit viewer                          |
| 3   | Branch Admin                              | Branch admin                     | branch config, counters, wards, staff                                                           |
| 4   | Medical Superintendent / Medical Director | Clinical governance dashboard    | all clinical read, quality, MLC, mortality, approvals                                           |
| 5   | HOD (per department)                      | Department dashboard             | department scheduling, approvals, KPIs                                                          |
| 6   | Doctor — Consultant (OPD)                 | Doctor OPD dashboard             | consult, e-Rx, orders, results, referrals, own earnings                                         |
| 7   | Doctor — IP / Ward                        | IP rounds board                  | IP orders, notes, discharge, transfers                                                          |
| 8   | Doctor — Emergency Physician              | ER board                         | triage view, ER orders, MLC, admission                                                          |
| 9   | Surgeon                                   | OT schedule + surgical worklist  | OT booking, op notes, implants, consent                                                         |
| 10  | Anaesthetist                              | Anaesthesia worklist             | PAC, intra-op record, PACU                                                                      |
| 11  | Intensivist                               | ICU board                        | ICU flowsheet, ventilator, scores                                                               |
| 12  | Radiologist                               | Reading worklist                 | studies, PACS viewer, structured reports, sign                                                  |
| 13  | Pathologist / Lab Director                | Validation worklist              | result validation, QC, sign-off, EQA                                                            |
| 14  | Resident / Junior Doctor / Intern         | Same as doctor, co-sign required | draft notes/orders needing co-sign                                                              |
| 15  | Visiting / Referring Doctor               | Referral portal                  | own referred patients read                                                                      |
| 16  | Nurse — OPD / Vitals                      | Vitals room queue                | vitals, injections, dressings                                                                   |
| 17  | Nurse — Ward                              | Nursing station                  | vitals, MAR, notes, handover, indents                                                           |
| 18  | Nurse — ICU                               | ICU flowsheet                    | hourly charting, ventilator, drips                                                              |
| 19  | Nurse — ER / Triage                       | Triage board                     | triage, ER nursing                                                                              |
| 20  | Nurse — OT / Scrub                        | OT checklist                     | counts, consumables, implants                                                                   |
| 21  | Nurse — Infection Control Officer         | ICN dashboard                    | HAI surveillance, isolation                                                                     |
| 22  | Nurse Supervisor / Matron                 | Nursing command centre           | roster, ratios, audits                                                                          |
| 23  | Ward Boy / Attendant / Transport          | Task list (mobile)               | patient transport tasks, bed status                                                             |
| 24  | Receptionist / Front Office               | Registration & appointments      | patient reg, appointments, tokens, ABHA                                                         |
| 25  | Call Centre Agent                         | Call console                     | appointments, enquiries, follow-up calls                                                        |
| 26  | Cashier                                   | Cash counter                     | receipts, shift, refunds (limited)                                                              |
| 27  | Billing Executive (OP/IP)                 | Billing desk                     | bills, discounts (limited), interim bills                                                       |
| 28  | Insurance / TPA Desk                      | Insurance queue                  | pre-auth, claims, documents                                                                     |
| 29  | Corporate / B2B Billing                   | Corporate accounts               | invoices, SOA                                                                                   |
| 30  | Pharmacist (OP)                           | Rx queue                         | dispense, OTC, returns                                                                          |
| 31  | Pharmacist (IP / Ward stock)              | Ward indents                     | unit dose, returns                                                                              |
| 32  | Pharmacy In-charge                        | Pharmacy admin                   | purchase, narcotics (2-person), pricing                                                         |
| 33  | Lab Technician                            | Bench worklist                   | sample, result entry (no validation)                                                            |
| 34  | Phlebotomist / Sample Collector           | Collection list                  | collect, reject, print labels                                                                   |
| 35  | Lab Quality Manager                       | QC dashboard                     | QC, EQA, NABL docs                                                                              |
| 36  | Radiology Technician                      | Modality worklist                | scheduling, acquisition status                                                                  |
| 37  | Blood Bank Technician / Officer           | Blood bank                       | donors, components, cross-match, issue (2-person)                                               |
| 38  | CSSD Technician / In-charge               | CSSD                             | trays, cycles, issue/return                                                                     |
| 39  | Dietician                                 | Diet worklist                    | assessments, diet orders                                                                        |
| 40  | Physiotherapist / OT / Speech therapist   | Therapy schedule                 | assessments, sessions                                                                           |
| 41  | Dialysis Technician                       | Dialysis board                   | sessions, machines, dialyser log and reprocessing; not the access, the prescription or the zone |
| 42  | Counsellor / Psychologist                 | Sessions                         | notes (restricted visibility)                                                                   |
| 43  | MRD Officer / Coder                       | MRD queue                        | coding, deficiency, retrieval, retention                                                        |
| 44  | Stores Keeper / Store In-charge           | Stores                           | GRN, issues, counts                                                                             |
| 45  | Purchase Officer                          | Procurement                      | indents, RFQ, PO                                                                                |
| 46  | Accountant / Finance Manager              | Finance                          | GL, AP, AR, banking, reports                                                                    |
| 47  | HR Executive / HR Manager                 | HR                               | employees, leave, payroll                                                                       |
| 48  | Biomedical Engineer                       | BME                              | assets, calibration, breakdowns                                                                 |
| 49  | Facility / Maintenance                    | Facility                         | work orders                                                                                     |
| 50  | Housekeeping Supervisor / Staff           | Housekeeping tasks (mobile)      | room turnover, BMW                                                                              |
| 51  | Security Officer / Guard                  | Gate console                     | visitors, passes, incidents                                                                     |
| 52  | Ambulance Dispatcher / Driver / EMT       | Dispatch / trip app              | trips, GPS, pre-hospital vitals                                                                 |
| 53  | Canteen / Kitchen Staff                   | Kitchen board                    | diet dispatch, POS                                                                              |
| 54  | Quality Manager (NABH)                    | Quality                          | indicators, audits, incidents, CAPA                                                             |
| 55  | Marketing / CRM Executive                 | CRM                              | leads, campaigns                                                                                |
| 56  | IT Admin / Helpdesk                       | IT console                       | tickets, devices, printers, integrations health                                                 |
| 57  | Privacy Officer / DPO                     | Privacy dashboard                | consent ledger, PHI access reports, DSAR                                                        |
| 58  | Auditor (internal/external, read-only)    | Audit workspace                  | read-only, exports audited                                                                      |
| 59  | Patient                                   | Patient portal/app               | own records, family (with consent)                                                              |
| 60  | Family / Attendant (bystander)            | Family view                      | limited: bill, visiting pass, updates                                                           |
| 61  | Corporate HR Client                       | Corporate portal                 | employees' utilisation, invoices                                                                |
| 62  | TPA / Insurer User                        | Payer portal                     | pre-auth, claims for their payer only                                                           |
| 63  | Vendor                                    | Vendor portal                    | POs, invoices, consignment                                                                      |
| 64  | Kiosk / TV / Device                       | n/a                              | display/read-only scoped tokens                                                                 |
| 65  | Optometrist                               | Eye clinic refraction lane       | acuity, refraction, pressure; signs a spectacle Rx only where delegated                         |
| 66  | Cardio-Pulmonary Lab Technician           | Cardio-pulmonary lab             | ECG, treadmill, spirometry, sleep studies; records, never interprets                            |
| 67  | Audiologist / Speech-Language Pathologist | Audiology booth                  | runs and **signs** the audiogram; fits and verifies hearing aids                                |
| 68  | Dental Hygienist                          | Dental chair                     | charts the mouth and the periodontium; cannot price or present a plan                           |

> Rows 65–68 are the **specialty sub-roles** OP-025 §0.7 asks each console to add. They are ordinary
> templates, not a new mechanism: a console that needs a chair-side role adds one row here and one template in
> `packages/contracts/src/rbac/role-templates.ts`, and the registry test refuses to let the two drift apart.
>
> There are four of them rather than one per console, because a role is worth minting only where the **scope of
> the signature** differs. The five device-heavy consoles are held by the ordinary clinical templates and
> narrowed by the licence and the department; a hospital that has to mint a role per specialty ends up with sixty
> roles it grants by guesswork. Row 67 is the one place a technician signs — producing and interpreting the
> audiogram is the audiologist's registered scope, not a delegation from the ENT surgeon.

## Permission catalogue conventions

- Every module spec section 12 declares its keys. Naming: `patient.*`, `appointment.*`, `queue.*`, `opd.*`,
  `rx.*`, `order.*`, `lab.*`, `rad.*`, `pharmacy.*`, `inventory.*`, `billing.*`, `receipt.*`, `insurance.*`,
  `ip.*`, `bed.*`, `nursing.*`, `ot.*`, `icu.*`, `blood.*`, `cssd.*`, `er.*`, `trauma.*`, `ortho.*`, `mrd.*`,
  `finance.*`, `hr.*`, `asset.*`, `report.*`, `admin.*`, `integration.*`, `ai.*`.
- Actions: `read | list | create | update | cancel | delete | approve | validate | sign | dispense | issue | export |
print | configure | override`.
- **Segregation of duties** enforced in policy: creator ≠ approver for discounts/refunds/PO/payroll; result enterer ≠
  validator; blood cross-match ≠ issue confirm; narcotic issue needs 2 users.

## Login/UX flow (all roles)

1. `/login` → identifier → password / OTP / SSO → 2FA → choose branch (if >1) → role home.
2. Header shows: hospital + branch, user, role switcher, global search (⌘K), notification bell, help, logout.
3. Left nav generated from permissions (never show items the user cannot use).
4. Session expiry warning at 13 min; quick re-auth by PIN keeps clinical context.
