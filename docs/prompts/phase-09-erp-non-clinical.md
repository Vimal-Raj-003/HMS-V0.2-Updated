# PHASE 9 — ERP & NON-CLINICAL

Phases 0–8 complete: the hospital treats patients well but still runs its money, its people, its equipment and its
compliance on spreadsheets. This phase is the back office — the half of a hospital nobody sees until it fails.

## Read first
`CLAUDE.md`, `docs/PROGRESS.md`, then, per step: **NC-009** (accounts & finance), **NC-012** (B2B/corporate
billing), **RC-005** (AR follow-up), **NC-022** (budget & financial planning); **NC-010** (HR & payroll),
**NC-029** (attendance & biometric), **EN-020** (biometric devices), **NC-030** (duty roster — extend from Phase 7),
**NC-027** (training), **NC-014** (staff utility mobile, PWA stage); **NC-002** (assets), **NC-020** (biomedical
engineering), **NC-025** (facility management), **NC-031** (contracts), **NC-021** (vendors — extend from Phase 4),
**NC-023** (legal & compliance), **NC-024** (transport/fleet); **NC-018** (housekeeping — extend from Phase 7),
**NC-017** (laundry & linen), **NC-019** (security), **EN-021** (CCTV), **EN-015** (gate pass, visitor & bystander),
**NC-016** (bio-medical waste); **NC-015** (quality NABH/JCI), **NC-004** (document management), **NC-028**
(help desk), **NC-032** (grievance/complaint engine), **EN-014** (complaint engine — shared with NC-032),
**NC-026** (marketing & CRM), **NC-035** (camps), **EN-023** (cybersecurity).
Also `docs/04-security-compliance.md` §1 (GST, TDS, PF/ESI, BMW 2016, AERB, DPDP), `docs/03-database-conventions.md`
(money and effective dating) and `docs/09-quality-gates-and-testing.md` §9 (data-integrity invariants).

Plan first; wait for "go". **This phase is split into five steps (9A–9E); paste one step at a time.
Build order: 9A → 9B → 9C → 9D → 9E.** 9C and 9D can overlap if you have a second pair of hands; 9A must be first
because everything else posts into it.

## Goal

Every rupee that moved in Phases 4–7 lands in a ledger that balances; every employee is paid correctly with the
right statutory deductions; every asset, ventilator and licence has an owner and a due date that raises itself
before it expires; waste leaves the building with a manifest; and the NABH assessor's evidence pack is generated,
not assembled the week before the audit.

---

## Deliverables

### Step 9A — Finance

#### 9A.1 Books, chart of accounts, mappings and automatic journals (NC-009 §3.1–3.2)
Legal entities and books per hospital/branch, financial-year calendars, a seeded Indian hospital **chart of
accounts**, cost centres tied to NC-008, and the **mapping table that converts domain events into journals**
(service revenue by department, pharmacy sales, discounts, refunds, deposits as liabilities, inventory, GRN
accruals, payroll, depreciation). Event-driven posting from `bill.finalized`, `payment.received`, `refund.issued`,
`grn.posted`, `invoice.matched`,
`stock.consumed`, `payroll.finalized`, `asset.depreciated` and the rest — each journal carrying the source module,
document id and an idempotency key. **Double-entry is enforced in the database**: a journal that does not balance
cannot be committed (constraint plus a service-level guard), and every posting is reversible only by a
counter-entry.

#### 9A.2 AP, AR, banking and tax (NC-009 §3.3–3.7)
Manual and recurring journals with approval; **accounts payable** (vendor invoice booking against the Phase 4
3-way match, payment runs, advances, debit notes, ageing); **accounts receivable** (patient, corporate, TPA and
scheme receivables); cash and bank books with **bank reconciliation** (statement import, auto-match rules,
unmatched queue); tax: **GST (GSTR-1/3B workings, HSN summary, RCM, ITC register), TDS (194J, 194C, 194I, …) with
challans and Form 16A, TCS and professional tax** — each with the returns-ready extract.

#### 9A.3 Close, statements and exports (NC-009 §3.8–3.10)
Period-close checklist with sub-ledger locking, **trial balance, P&L, balance sheet, cash flow**, budget-vs-actual,
internal-audit controls and exception reports, and **exports to Tally (XML) and SAP/other ERP (configurable
mapping)**.
**Deployment choice, made explicit and configurable:** the hospital either runs Vim's HMS as its **full general
ledger**, or runs it as a **sub-ledger** that reconciles and exports to an incumbent Tally/SAP installation. Both
paths must work end-to-end; the sub-ledger path must still produce a self-consistent, balancing set of books
internally so that reconciliation differences are detectable.

#### 9A.4 Corporate billing and receivables (NC-012 + RC-005)
NC-012: corporate credit accounts, consolidated invoices from patient episodes, statements of account, ageing,
TDS certificates received, credit limits and holds, dispute lines.
RC-005: AR ingestion and bucket computation (0–30/31–60/61–90/90+ by payer and by patient), **priority scoring and
worklists**, follow-up logging, the **dunning ladder**, payment plans and EMI mandates, disputes and holds,
bad-debt provisioning and write-off with approval, collection-agency and legal escalation, and a cash-flow forecast.

#### 9A.5 Budget (NC-022)
Budget cycle setup, operating and capital budgets, capex requests, **commitment control that checks an indent or PO
against the remaining budget line** (this is the hook left open in Phase 4 — close it now), variance analysis,
revisions and virements, and forecasting.

---

### Step 9B — People

#### 9B.1 Employee master and onboarding (NC-010 §3.1)
Employee master with personal, statutory (PAN, Aadhaar masked, UAN, ESIC, bank), employment (grade, department,
cost centre, reporting), and document records; onboarding checklist; **linkage to the `core.users` identity so that
one person is one record** across HR, roster, clinical roles and payouts.

#### 9B.2 Credentialing, licences and privileging (NC-010 §3.2)
Registration numbers (NMC/state council, NABL signatory, AERB RSO), qualifications, **privileges granted per
procedure/specialty**, insurance/indemnity, and **expiry tracking that warns at 90/60/30 days and, on expiry,
blocks the role's clinical privileges** with an audited override path. This is a NABH requirement and a real
patient-safety control — treat it as such.

#### 9B.3 Attendance, roster and leave (NC-029 + EN-020 + NC-030 + NC-010 §3.3–3.4)
Biometric and card device fleet registration, enrolment, punch ingestion with offline buffering and de-duplication,
shift and grace rules, regularisation with approval, overtime; **NC-030 roster** extended from Phase 7 with shift
planning, auto-assign, swaps with approval, **nurse-patient ratio validation** and on-call rosters consumed by
EN-037; leave types, accrual, encashment, holiday calendars and leave-vs-roster conflict detection.

#### 9B.4 Payroll, statutory correctness and training (NC-010 §3.5–3.7 + NC-027)
Salary structures and components (earnings, deductions, reimbursements, arrears, LOP), attendance and leave input,
payroll run with a **preview-and-lock cycle**, and the statutory engine: **PF (with EPS split and wage ceiling),
ESI (with the eligibility threshold and contribution period rules), professional tax by state slab, labour welfare
fund, income-tax TDS under old and new regimes with declarations, proofs and Form 16 generation**, plus gratuity,
bonus, loans and advances, full-and-final settlement, payslips, bank transfer files, and the ECR/ESIC return
extracts. Employee self-service and NC-014 staff mobile (PWA stage — native is Phase 13): directory, attendance,
leave, payslip, announcements, roster and swaps, helpdesk, cafeteria, SOS.

**Training and competency (NC-027)**: training calendar, mandatory-training matrix by role (fire, BLS, infection
control, BMW, POSH), attendance,
assessments, certificates with expiry, competency records feeding NC-020 equipment training and NC-015 evidence.

---

### Step 9C — Assets and facilities

#### 9C.1 Asset management (NC-002)
Capitalisation from the Phase 4 GRN, asset register with tags (barcode/QR/RFID), location and custody tracking,
**AMC/CMC contracts with service calls**, **dual-book depreciation (Companies Act and Income Tax)**, transfers,
preventive-maintenance schedules, physical verification, insurance and claims, disposal and write-off with
approval, and utilisation analytics.

#### 9C.2 Biomedical engineering (NC-020)
Equipment registry with risk classification, preventive maintenance, **calibration and QA with certificates and due
dates (including AERB obligations for radiation equipment)**, breakdown and repair with downtime tracking and
impact on clinical scheduling, AMC/CMC and cost per equipment, **medical-device recalls and field safety notices**,
telemetry via EN-042, training and competency linkage, and a risk-based scheduling engine.

#### 9C.3 Facility, contracts, vendors, legal and licences (NC-025, NC-031, NC-021, NC-024, NC-023)
Facility management: room and hall booking, maintenance requests with SLA, utilities and energy logging, AMC for
building services. Contract management: repository, milestones, renewal alerts, obligations and penalties.
Vendor management extended from Phase 4 with performance scorecards, blacklisting and the vendor portal.
NC-024 non-ambulance transport and fleet. NC-023 licence register (drug licence, AERB, PCB consent, fire NOC, lift,
boiler, biomedical waste authorisation, blood
bank, PC-PNDT, NABH/NABL certificates) with owners, documents and **renewal alerts at 90/60/30/7 days that
escalate**; the compliance calendar; inspections and regulatory notices; legal case log with hearings and
documents; RTI handling for public hospitals; and evidence packs.

---

### Step 9D — Support services

#### 9D.1 Housekeeping and laundry (NC-018 extended, NC-017)
NC-018 beyond the Phase 7 bed-turnover slice: zone-based schedules, checklists, inspection scoring, deep-clean
cycles, consumables and staff productivity. NC-017 laundry and linen: linen master and par levels per ward,
soiled collection with weight, wash cycles (in-house or outsourced vendor), issue and return, loss and condemnation,
and **infectious-linen handling that connects to IP-012**.

#### 9D.2 Security, CCTV and gate control (NC-019, EN-021, EN-015)
Security posts, patrols and incident logging; EN-021 CCTV dashboard with event tagging and **strictly time-limited,
audited footage access** (never bulk export); EN-015 visitor, attendant/bystander pass with photo and pass printing,
vehicle in/out log, **material gate pass with approval that reconciles against stores movements**, contractor and
delivery management, and the security shift handover.

#### 9D.3 Bio-medical waste (NC-016)
BMW Rules 2016 implementation: category and colour-code masters, **barcoded bag labelling at source with generator
department**, collection rounds and internal transport, central storage with weighing, hand-over to the CBWTF with
**e-manifest and reconciliation of generated vs handed-over weight**, spills and accidents, needle-stick injury
linkage to IP-012 staff health, training and immunisation records, and the annual/monthly SPCB report formats.

---

### Step 9E — Governance, service and growth

#### 9E.1 Quality management (NC-015)
Indicator library mapped to **NABH 6th edition and JCI** chapters with automatic data collection from the modules
built in Phases 1–8 wherever the data already exists (do not ask a human to re-key what the system knows);
SOP repository with versioning and acknowledgement; internal audits and gap analysis; **incident and near-miss
reporting (including anonymous), RCA, sentinel-event handling**; **CAPA with owners, due dates and effectiveness
checks**; committees and mock drills; and the assessment evidence pack export.

#### 9E.2 Documents and service desk (NC-004, NC-028, NC-032/EN-014)
NC-004 DMS: repository with versions, approval workflow, OCR full-text search, controlled-copy distribution,
expiry and review dates, retention. NC-028 IT help desk: tickets, categories, SLA timers, escalation, asset linkage,
knowledge base. NC-032/EN-014 **one complaint/grievance engine**: multi-channel registration, auto-assignment,
escalation matrix with SLA timers, investigation and resolution, grievance committee, service recovery and NABH
analytics. Phase 10 puts patient-facing surfaces on this engine — build the engine once, here.

#### 9E.3 Marketing, CRM and camps (NC-026, NC-035)
Lead capture and qualification, referral-source master and attribution, segments and campaigns with **DPDP consent
and TRAI-DLT compliance on every outbound message**, coupons, reputation management, corporate and doctor relations,
and NC-035 camps: planning and approvals, pre-camp logistics, an **offline-first camp-day app** that registers,
screens and captures results with no connectivity, post-camp sync into the MPI with de-duplication, and
follow-up conversion tracking.

#### 9E.4 Cybersecurity operations (EN-023)
Vulnerability scanning and patch tracking, threat and anomaly monitoring on the audit stream, security incident
register with severity and timelines, SIEM export, access-review campaigns, and the **CERT-In incident reporting
workflow (6-hour obligation)** with a rehearsed runbook.

## Constraints & watch-outs
- **The trial balance must balance in an automated test.** Post a full simulated month — admissions, bills,
  payments, refunds, GRNs, consumption, payroll, depreciation — then assert Σ debits = Σ credits, sub-ledger
  control accounts equal their sub-ledgers, and no orphan journal exists. This test is not optional and not a
  "later".
- **Payroll statutory correctness is tested against worked examples, not eyeballed.** Fixture employees covering
  the PF wage ceiling, the ESI threshold crossing mid-period, multiple state PT slabs, both tax regimes, mid-month
  joiners and leavers, LOP, arrears and F&F — each with an expected net pay computed by hand and asserted.
- Money rules from `docs/03` apply everywhere: `numeric(14,2)`, one rounding policy, server-side totals, effective
  dating on rates, no floating point anywhere near a rupee.
- **Nothing in this phase may block clinical work.** Budget commitment control, licence expiry, credit limits and
  gate passes all have documented, audited override paths; the `clinical_safety_exempt` list from EN-040 still
  holds. A finance module must never be able to stop a patient being treated.
- Approvals go through EN-038 (never bespoke), documents through NC-004, notifications and escalations through
  EN-037, and every module's KPIs through the NC-011 dataset contract so Phase 11 can consume them without rework.
- PHI boundary: HR, finance and facilities users must not gain patient access through an ERP screen. Corporate
  invoices and utilisation reports carry episode-level financials, not diagnoses, unless explicitly consented.
- CCTV footage, biometric templates and payroll data are each their own sensitivity class with their own retention
  and access-review rules — do not lump them into "admin data".

## Exit gate
1. Post a simulated month end-to-end; the **trial balance balances**, P&L and balance sheet generate, and every
   control account agrees with its sub-ledger. Break one mapping deliberately and the test fails loudly.
2. Bank statement import reconciles 95 % automatically; the unmatched queue works; a duplicate import creates no
   duplicate entries.
3. GST workings tie to the Phase 5 invoices; a TDS deduction produces a challan line and a Form 16A; the Tally XML
   export imports cleanly into a real Tally company, and the sub-ledger-only mode also reconciles.
4. Run payroll for 500 employees including every fixture edge case; net pay matches the hand-computed expectations
   to the rupee; PF/ESI/PT/TDS returns extract; Form 16 generates; the bank file is accepted by a validator.
5. A doctor's medical-registration expiry blocks their clinical privileges at the configured date, warns from 90
   days, and the override is audited.
6. Roster: a shift that breaches nurse-patient ratio is refused; a swap flows through approval; on-call routing
   from Phase 6 still pages the right person.
7. An asset moves GRN → capitalisation → tag → PM schedule → breakdown → repair → depreciation (both books) →
   disposal and reconciles with the ledger; a ventilator's calibration falls due, escalates, and the equipment
   shows as unavailable to OT/ICU scheduling until cleared.
8. A licence 30 days from expiry escalates to its owner and the Medical Superintendent; the compliance calendar
   shows the next 12 months correctly.
9. BMW: bags labelled at source, weighed at central storage, handed over with an e-manifest, and the generated-vs-
   handed-over reconciliation catches a deliberate 3 kg discrepancy; the SPCB report generates.
10. An incident is reported anonymously, an RCA is run, a CAPA is raised with an owner and due date, effectiveness
    is verified, and the NABH evidence pack exports with indicator data drawn automatically from Phases 1–8.
11. A camp runs fully offline for 200 registrations and syncs into the MPI with duplicates caught and conversions
    tracked; every outbound campaign message respects consent and DLT.
12. Previous gates green; `docs/PROGRESS.md` and `docs/DECISIONS.md` updated (record the GL-versus-sub-ledger
    decision and the payroll statutory assumptions).
