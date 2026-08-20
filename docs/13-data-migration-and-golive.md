# 13 — Data Migration & Go-Live

> The software is rarely what kills a hospital implementation. **Data and people** are. This file is the playbook
> for moving a hospital from whatever it runs today onto Vim's HMS without losing money, records or trust.
> The tooling that executes all of this is **EN-036 (DIU — Data Import & Migration Utility)**; this document is
> the _method_, EN-036 is the _machine_. Companion docs: `09-quality-gates-and-testing.md` §12 (UAT),
> `10-deployment-devops.md` §13 (onboarding checklist), `08-integration-catalogue.md` §T5 (parallel run).

---

## 1. Methodology

```
Discovery → Profiling → Mapping → Cleansing → Dry run 1 → Dry run 2 → Dry run 3 (rehearsal)
     → Freeze → Cutover → Reconcile → Parallel run → Hypercare (14 d) → Stabilisation → Benefits review
```

Each phase is a phase object in `diu_migration_projects` (EN-036 §4) with an owner, dates, entry/exit criteria and
a sign-off. **A phase does not start until the previous one's exit criteria are signed** — by a named person from
the hospital, not from VIMS.

| Phase                 | Duration (500-bed, 10 y history) | Exit criteria                                                                                        |
| --------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Discovery             | 2 weeks                          | scope document signed: what migrates / archives / is abandoned                                       |
| Profiling             | 1 week                           | data-quality report per entity, duplicate-rate estimate, volume counts agreed with the legacy vendor |
| Mapping               | 2–3 weeks                        | mapping workbook approved per entity; code translations (test→LOINC, dx→ICD-10) complete or queued   |
| Cleansing             | 3–4 weeks (runs in parallel)     | hospital-side corrections done in the legacy system; quality score above the gate                    |
| Dry run 1             | 1 week                           | masters + patients load; error rate < 5 %; reconciliation variances itemised                         |
| Dry run 2             | 1 week                           | full scope loads; UAT tenant populated; clinical sample verification starts                          |
| Dry run 3 (rehearsal) | 2 days                           | **timed** full cutover rehearsal; every step's actual duration recorded                              |
| Cutover               | 1 weekend                        | reconciliation passes; go/no-go signed                                                               |
| Parallel run          | 2–4 weeks                        | daily reconciliation drift within tolerance                                                          |
| Hypercare             | 2 weeks                          | open blockers = 0; P2s with owners and dates                                                         |

**Non-negotiables:** nothing is loaded by raw SQL (everything goes through the owning module's service layer, so
audit, numbering and events fire); every migrated row keeps its provenance (`source_system`, `source_batch_id`,
`source_row_number`, `legacy_id`); clinical records keep their **original dates and retention clock**; every
extract file is encrypted, access-logged and destroyed at project close with a certificate (a DPDP obligation
routinely forgotten — EN-036 §5).

---

## 2. What to migrate, what to archive, what to abandon

The default answer to "can we bring everything?" is **no** — and that must be a _decision_, not an accident.
Migrating ten years of free-text notes into structured fields costs more than it returns and imports ten years of
someone else's data-quality problems.

| Data class                                                      | Decision                                                                       | Depth                                                                                       | Why                                                              | Effort (500-bed)                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------ |
| **Patient master (MPI)**                                        | **Migrate**                                                                    | all patients with any activity in the last 5–7 years; older → archive                       | identity continuity is the whole point; UHID must resolve        | 8–15 person-days incl. dedupe adjudication |
| Patient allergies, blood group, chronic problems, implants      | **Migrate, 100 % verified**                                                    | all active patients                                                                         | safety-critical; wrong here = harm                               | 3–5 d + clinical verification time         |
| **Active IP episodes**                                          | **Migrate**                                                                    | every currently admitted patient, in full (orders, MAR schedule, charges to date, deposits) | they are physically in a bed at cutover                          | 2–3 d + manual re-entry contingency        |
| Active OP episodes with pending results/reports                 | **Migrate**                                                                    | open orders only                                                                            | otherwise results arrive with nowhere to land                    | 1–2 d                                      |
| **Outstanding bills / AR**                                      | **Migrate**                                                                    | every open item with ageing, payer, invoice ref                                             | you cannot collect what you cannot see                           | 4–6 d, must reconcile to the rupee         |
| Closed/settled bills                                            | **Archive**                                                                    | read-only extract + PDF                                                                     | no operational use; audit needs readability, not queryability    | 1–2 d                                      |
| **Inventory opening stock**                                     | **Migrate**                                                                    | item × batch × expiry × store × quantity × rate                                             | FEFO and expiry alerts need batches from day one                 | 3–5 d + physical count                     |
| Historical purchase/consumption                                 | **Archive** (import 6–12 months if reorder analytics matter)                   | summary only                                                                                | ABC/VED can be rebuilt in a quarter                              | 1–2 d                                      |
| **Accounts opening balances**                                   | **Migrate**                                                                    | trial balance, AR/AP open items, bank balances at cutover date                              | statutory continuity                                             | 3–5 d, Finance sign-off mandatory          |
| Historical GL transactions                                      | **Archive**                                                                    | legacy system read-only + exports                                                           | auditors accept the legacy archive                               | 0–2 d                                      |
| **Employee master**                                             | **Migrate**                                                                    | active employees, leave balances, salary structure, statutory ids                           | payroll must run in the first month                              | 3–4 d                                      |
| Historical payroll                                              | **Archive**                                                                    | Form 16 / payslip PDFs retained                                                             | statutory retention satisfied by archive                         | 1 d                                        |
| **Tariffs & service master**                                    | **Migrate**                                                                    | current effective-dated rates, per payer/scheme                                             | billing cannot start without it                                  | 5–8 d — usually the messiest master        |
| **Doctor master**                                               | **Migrate**                                                                    | active doctors, specialties, fees, share rules, NMC/HPR ids                                 | scheduling + payouts                                             | 2–3 d                                      |
| Drug & item master                                              | **Migrate**                                                                    | active items with HSN/GST, schedule flags, DPCO ceiling                                     | dispensing and GST correctness                                   | 4–6 d                                      |
| **Historical clinical records** (visits, diagnoses, results)    | **Migrate structured summary** for 3–5 years; full detail 1–2 years            | visit header + ICD + result values + report PDFs                                            | doctors want "last visit, last labs"; nobody re-reads 2014 notes | 6–12 d                                     |
| Scanned documents / old charts                                  | **Archive with an OCR index**                                                  | linked to UHID + date + type                                                                | retrievable in seconds without migrating structure               | 3–6 d + storage                            |
| DICOM images                                                    | **Migrate at storage level** (EN-008 owns this) or archive with a query bridge | priors for 2–3 years hot                                                                    | image migration is a copy job, not an ETL                        | 2–5 d + transfer window                    |
| Free-text notes, appointment history, audit logs, legacy config | **Abandon** (with signed acknowledgement)                                      | —                                                                                           | cost ≫ value                                                     | 0                                          |

**Rule of thumb:** operational data migrates; historical data is archived in a readable, searchable form; the
legacy system stays available read-only for its statutory retention period with a named owner and a licence that
permits it (check the contract — some vendors switch it off).

---

## 3. Legacy extraction patterns

| Pattern                                            | When                                                     | How                                                                                                              | Risks                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Direct DB read** (best)                          | vendor grants read-only credentials or a restored backup | EN-017 JDBC connector (MSSQL/MySQL/Oracle/PG; ODBC for Access/FoxPro) → EN-036 staging; incremental by watermark | undocumented schema, business logic hidden in the app not the DB, encrypted columns           |
| **Database backup restored to a staging instance** | vendor will hand over a `.bak`/dump but not live access  | restore in a locked-down VM, extract, destroy at close                                                           | licence/version compatibility; treat as PHI throughout                                        |
| **Vendor-provided export** (CSV/Excel)             | vendor cooperates but restricts access                   | agree the exact column list and a re-extract SLA (you _will_ need a second extract)                              | encoding damage, Excel mangling long numbers and leading zeros, truncation, silent row limits |
| **API extraction**                                 | modern SaaS incumbent                                    | paged pulls with rate limiting, checkpointed                                                                     | pagination drift during the pull; take a consistent snapshot or pull during a quiet window    |
| **Report scraping** (PDF/print exports)            | vendor is uncooperative or defunct                       | parse standard reports; only viable for masters and balances                                                     | brittle; use only with reconciliation totals from the same reports                            |
| **Screen scraping / RPA**                          | genuine last resort                                      | scripted UI walk, rate-limited, out of hours                                                                     | slow, fragile, may violate the licence — get written permission and record the decision       |
| **PDF/scan archive with OCR index**                | historical charts, old reports                           | bulk ingest to object storage, OCR, index on UHID/date/type/doctor, attach to the patient timeline (NC-004)      | OCR quality on old carbon copies; index on the reliable fields only                           |
| **Manual re-entry**                                | small volumes, active IP episodes, allergies             | double-entry by two people or entry + 100 % verification                                                         | costly but sometimes correct — budget it explicitly                                           |

Whatever the pattern: extract **once per dry run** (not continuously), record the extract timestamp and file
hashes, keep the raw extract immutable, and do all transformation downstream so a re-run is reproducible.

---

## 4. Mapping workbook

One workbook per entity, versioned in the project folder and mirrored as an EN-036 mapping profile. Columns:

| Source table.column | Sample values               | Target entity.field                 | Transform                      | Value map                           | Mandatory | Default if null       | Owner   | Decision / notes                                 |
| ------------------- | --------------------------- | ----------------------------------- | ------------------------------ | ----------------------------------- | --------- | --------------------- | ------- | ------------------------------------------------ |
| `PATIENT.PT_SEX`    | `M`,`F`,`1`,`2`,``          | `patients.gender`                   | `lookup(gender_map)`           | M/1→male, F/2→female, blank→unknown | Y         | `unknown`             | MRD     | 412 blanks; MRD accepts `unknown`                |
| `PATIENT.DOB`       | `01/01/1980` (34 % of rows) | `patients.dob` + `dob_is_estimated` | `date_parse(dd/MM/yyyy)`       | —                                   | Y         | derive from age       | MRD     | 1-Jan default = age-only record → flag estimated |
| `BILL_DTL.RATE`     | `1250.00`                   | `bill_items.rate`                   | `numeric_scale(2)`             | —                                   | Y         | reject                | Finance | must tie to tariff or be flagged legacy-rate     |
| `TEST_MST.CODE`     | `HB`,`TLC`                  | `lab_tests.loinc`                   | `code_translate(legacy→LOINC)` | concept map v3                      | N         | leave uncoded + queue | Lab     | 61 of 480 unmapped → manual queue                |

Each workbook also carries: the **control totals** the source must reconcile to, the load order dependencies, the
rejection policy per rule, and a sign-off line for the data owner. Unmapped source columns are preserved in
`legacy_data` JSONB so nothing is silently lost (EN-036 §3.3).

---

## 5. De-duplication and merge governance

Duplicate rates of **8–20 %** in a legacy Indian patient master are normal (multiple registrations per family
mobile, name spelling variants, age-derived DOBs). Plan for it as a workstream, not a surprise.

1. **Measure first** during profiling: run EN-036's scorer read-only over the extract and report the candidate
   distribution by score band. This number goes into the project plan as adjudication hours (≈ **40–60 adjudications
   per person-hour** with the side-by-side UI and keyboard flow).
2. **Deterministic merges** (same ABHA, same verified Aadhaar hash, identical mobile+DOB+name) may auto-merge
   _before_ clinical records are attached — i.e. during the master load, never after.
3. **Everything in the 60–84 band goes to a human**, always. The MRD officer sees the score breakdown and each
   record's clinical footprint (visits, labs, bills, documents) before deciding.
4. **Governance:** a standing merge committee (MRD head + one clinician + one billing lead) for contested cases;
   negative decisions ("not a duplicate") are recorded so the pair is never re-proposed; every merge is reversible
   for 30 days; merges execute through OP-001's merge service so bills, orders, PACS (ADT A40) and ABHA links
   re-point consistently.
5. **Post-go-live**, the same scorer runs at registration (OP-001 §5: score ≥ 0.85 blocks without override) so the
   cleaned master stays clean — otherwise you re-earn the duplicate rate within two years.

---

## 6. Reconciliation — the reports that must balance

No cutover is approved until every line is **matched** or **explained with a named owner** (EN-036 §5).

| Report                           | Must balance                                                                  | Tolerance                                | Signed by                   |
| -------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------- | --------------------------- |
| Patient counts                   | legacy active patients = migrated patients + merged-away + excluded (by rule) | **0**                                    | MRD head                    |
| Patient sample verification      | 150–200 patients checked field-by-field against legacy screens                | 0 discrepancies on safety fields         | MRD + clinician             |
| Active IP census                 | legacy occupied beds = HMS admitted patients, bed by bed                      | **0**                                    | Nursing superintendent      |
| AR / outstanding                 | legacy AR total and ageing buckets = HMS open items, per payer                | **₹0**                                   | Finance head                |
| Trial balance                    | legacy TB at cutover = HMS opening balances; ΣDr = ΣCr                        | **₹0**                                   | Finance head + auditor      |
| Advances/deposits                | patient advances and refundable deposits                                      | **₹0**                                   | Finance head                |
| Stock valuation                  | item × batch quantity and value = physical count sheet                        | 0 qty variance; value variance explained | Stores + Pharmacy in-charge |
| Expiry integrity                 | no batch with a past expiry loaded as sellable                                | 0                                        | Pharmacy in-charge          |
| Tariff spot-check                | 50 highest-volume services priced identically in both systems for 3 payers    | 0                                        | Billing head                |
| Doctor master                    | count, specialties, share rules                                               | 0                                        | Medical superintendent      |
| Employee master & leave balances | headcount, leave days                                                         | 0                                        | HR head                     |
| Historical clinical              | visits, results and documents per year: count + earliest/latest date          | < 0.1 %, itemised                        | MRD head                    |
| Data-quality gate                | mandatory-field completeness, duplicate rate, uncoded rate                    | above the agreed thresholds              | Project sponsor             |

Variances are never averaged away. "₹4,200 unexplained" blocks cutover exactly as "₹4.2 lakh unexplained" does —
because an unexplained small number is a symptom, not a rounding error.

---

## 7. Cutover — a 500-bed go-live weekend

Assumptions: Friday-night freeze, Monday 06:00 live; masters, historical data and closed financials already loaded
in dry run 3; only deltas, active episodes, balances and stock move this weekend. **Every timing below came from
the rehearsal**, and the rehearsal's actuals replace these estimates in the real plan.

| Time                | Step                                                                                                                                                                                                                                   | Owner                             | Go/no-go        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------- |
| **Fri 18:00**       | Final go/no-go meeting: readiness checklist (§9), open blockers, staffing, weather/festival risk                                                                                                                                       | Sponsor + PM                      | **GO/NO-GO #1** |
| Fri 20:00           | Communication: SMS/notice to staff, referring doctors and (where relevant) patients; downtime protocol packs placed in every department                                                                                                | PM                                |                 |
| Fri 22:00           | **Freeze the legacy system for masters and finance** (no new tariffs, items, doctors, employees); OP/IP operations continue on paper-plus-legacy                                                                                       | Hospital IT                       |                 |
| Fri 22:30           | Full backup of the legacy database; hash recorded                                                                                                                                                                                      | Legacy vendor                     |                 |
| **Sat 00:00**       | Final delta extract (masters, patients, transactions since dry run 3)                                                                                                                                                                  | Migration lead                    |                 |
| Sat 00:30–04:00     | Load deltas: masters → patients → historical → dedupe re-run on new arrivals                                                                                                                                                           | Migration lead                    |                 |
| Sat 04:00–06:00     | Reconciliation batch 1 (patients, masters, historical)                                                                                                                                                                                 | Migration + MRD                   | **checkpoint**  |
| **Sat 06:00–14:00** | **Physical stock count**, all stores and ward stocks, counting sheets signed                                                                                                                                                           | Stores/Pharmacy                   |                 |
| Sat 08:00–16:00     | **Active IP episode transfer**: for each occupied bed — demographics, admission, bed, consultant, diagnoses, active orders, MAR schedule, deposits, charges to date. Nurse + implementation consultant per ward, checklist per patient | Nursing + consultants             |                 |
| Sat 14:00–18:00     | Opening stock load from the signed count; batch/expiry verified; reconciliation batch 2 (stock)                                                                                                                                        | Stores + migration                | **checkpoint**  |
| **Sat 18:00–22:00** | Finance cutoff: legacy AR/AP/TB extracted at the freeze instant; opening balances loaded                                                                                                                                               | Finance + migration               |                 |
| Sat 22:00–Sun 02:00 | Reconciliation batch 3 (AR, TB, advances, deposits) — **must be ₹0**                                                                                                                                                                   | Finance head                      | **checkpoint**  |
| **Sun 02:00**       | **GO/NO-GO #2** — the abort point. Criteria in §7.1                                                                                                                                                                                    | Sponsor + Finance + MRD + Nursing | **decision**    |
| Sun 02:00–06:00     | Production configuration lock: numbering series set to continue or restart (decided in discovery), printers/labels test-printed, TV boards live, kiosks live, interfaces enabled (analyzers, PACS, ABDM, payment, SMS)                 | Platform + integration            |                 |
| Sun 06:00–12:00     | **Interface verification**: one real order/result cycle per analyzer, one modality worklist + store, one test payment, one SMS/WhatsApp template, one ABDM ABHA verify                                                                 | Integration lead                  | **checkpoint**  |
| Sun 12:00–18:00     | End-to-end smoke by hospital super-users: register → consult → Rx → dispense → bill → receipt; admit → MAR → discharge → final bill; lab order → result → report                                                                       | Super-users                       | **checkpoint**  |
| Sun 18:00–20:00     | Legacy system set **read-only**; access confirmed for reference; final backup archived                                                                                                                                                 | Hospital IT + vendor              |                 |
| Sun 20:00           | **GO/NO-GO #3** — final. Announce to all staff                                                                                                                                                                                         | Sponsor                           | **decision**    |
| Sun 20:00–23:00     | Floor-walker briefing, shift-wise; command centre set up (war room with a big screen showing the ops dashboard)                                                                                                                        | PM                                |                 |
| **Mon 06:00**       | **LIVE.** OPD counters open with 2× staffing and 1 floor-walker per 2 counters                                                                                                                                                         | All                               |                 |
| Mon 06:00–20:00     | Command centre: 2-hourly checkpoint (registrations, bills, errors, queue lengths, open tickets), issue triage every 2 h                                                                                                                | PM                                |                 |
| Mon 20:00           | Day-1 review: transaction counts vs a normal Monday, cash reconciliation, top 10 issues, plan for day 2                                                                                                                                | All                               |                 |

### 7.1 Abort criteria (written before, not during)

Abort and revert to the legacy system if **any** of: financial reconciliation cannot reach ₹0 by 02:00 Sunday and
Finance will not sign an explained variance; the active-IP transfer is < 100 % complete or any admitted patient's
allergies/active orders are unverified; a P1 defect exists in registration, billing, dispensing, MAR or lab result
filing; interfaces to analyzers or PACS are non-functional at 12:00 Sunday; the legacy system cannot be kept
read-only-available as a fallback; or key personnel (Finance head, MRD head, nursing superintendent, migration lead)
are unavailable. **The abort decision belongs to the hospital sponsor**, is made at a defined time, and reverting
is rehearsed too — an abort plan nobody has practised is a hope, not a plan.

Smaller hospitals compress this: a 50–150-bed hospital typically runs a **single-night cutover** (freeze 20:00,
live 08:00) because stock and AR are small; a 1000–2000-bed group runs **branch by branch over consecutive
weekends** with the group masters loaded once (EN-036 §15 multi-branch orchestration; SMART HMIS's published
precedent of a new branch live within 24 hours is the bar to beat once the group masters exist).

---

## 8. Parallel run

Run only where it genuinely reduces risk — **finance and billing almost always; full clinical rarely** (double
clinical entry is unsafe: staff will treat one system as the "real" one and the other will drift).

- **Scope and duration:** billing, receipts, AR and stock issues entered in both systems for 2–4 weeks; clinical
  work happens **only** in Vim's HMS from day one (paper is the fallback, not the legacy HMS).
- **Daily reconciliation** by 10:00 for the previous day: bill count, collection total by tender, discounts,
  refunds, stock issues, AR movement. Drift tolerance ₹0 on totals; every difference is investigated same-day and
  assigned an owner.
- **A single source of truth is declared from day one** — Vim's HMS. The legacy entry is a control, not an
  alternative. If staff start "fixing" things only in the legacy system, the parallel run has failed and should be
  stopped rather than continued.
- **Exit criteria:** 5 consecutive days of ₹0 drift and no open blockers → stop parallel entry, keep the legacy
  system read-only, and start the decommission checklist (EN-036 §3.5 step 10).

---

## 9. Training plan

| Role                                          | Hours                                                     | Format                                         | Competency sign-off                                                                                                           |
| --------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Front office / call centre                    | 8 (2 × 4 h) + 2 h refresher                               | hands-on in the UAT tenant, scripted scenarios | register 5 patients incl. a duplicate and a minor, book/reschedule/cancel, check-in, print card, handle an offline kiosk      |
| Cashier / billing                             | 10                                                        | hands-on + finance scenarios                   | shift open/close with a ₹0 reconciliation, mixed-tender bill, discount within limit, refund, corporate credit bill            |
| Nurse (ward/ICU/OT/ER)                        | 12 (3 × 4 h) + bedside shadowing                          | tablet in hand, on the ward                    | vitals + NEWS2, MAR with wristband scan incl. a deliberate mismatch, handover note, I/O chart, escalation of a critical value |
| Doctor (OPD)                                  | 4 (2 × 2 h, scheduled around clinics) + 1:1 elbow support | short, ruthless, template-driven               | consult with templates, e-Rx with a CDSS alert, order labs/imaging, view results, discharge order                             |
| Surgeon / anaesthetist                        | 3                                                         | OT-focused                                     | WHO checklist, implant scan, OT notes, PAC                                                                                    |
| Lab                                           | 8                                                         | at the bench with analyzers                    | accession, run, validate, critical value call-back with read-back, QC entry, amendment                                        |
| Radiology                                     | 6                                                         | at the modality                                | worklist, study, structured report, critical finding alert                                                                    |
| Pharmacy                                      | 10                                                        | at the counter                                 | dispense against e-Rx, batch/FEFO, substitution, narcotic dual authorisation, return, stock adjustment                        |
| Stores / purchase                             | 8                                                         | —                                              | indent → PO → GRN → 3-way match, physical count                                                                               |
| MRD                                           | 8                                                         | —                                              | coding, deficiency, retrieval, dedupe adjudication, merge/unmerge                                                             |
| Accounts / HR                                 | 8                                                         | —                                              | opening balances, day-end posting, payroll cycle                                                                              |
| Hospital / branch admin                       | 12                                                        | —                                              | masters, tariffs, roles, numbering, approvals, reports, downtime protocol                                                     |
| Housekeeping / dietary / security / transport | 2                                                         | on-device, task-based                          | their single screen, nothing else                                                                                             |
| **Super-users (2–3 per department)**          | +8 on top of their role                                   | train-the-trainer                              | must teach one session back and pass the L1 triage quiz                                                                       |

Principles: train **as late as possible before go-live** (knowledge decays in 3 weeks) but leave time for a
refresher; train on the hospital's **own** masters and letterheads, never a generic demo; every session ends with a
short competency check, and the sign-off is recorded per person in NC-027 (training records — an NABH artefact).
Night-shift and weekend staff get their own sessions, not a summary email.

**Quick-reference cards:** one laminated A5 per role — the 8 things they do daily, the hotkeys, the "what if it
breaks" line, and the helpdesk number. Placed at every counter, nursing station and bench.

**Floor-walking roster (hypercare):** week 1 — 1 walker per OPD counter block, 1 per ward floor, 1 in pharmacy,
1 in lab, 1 in billing, on every shift including nights; week 2 — halved, concentrated on the morning peak and the
discharge window. Walkers carry a tablet, log every question into the issue tracker (questions are the best defect
signal you will ever get), and escalate rather than improvise fixes.

---

## 10. Go-live readiness checklist

Assessed at GO/NO-GO #1. Anything red is either fixed or becomes a written, owned, dated exception approved by the
sponsor.

**Technical** — production environment provisioned and hardened (`10` §10); backup configured **and restore-drilled**;
monitoring and alerts routed to both parties; performance verified on the hospital's own hardware/network at peak
simulated load; downtime protocol tested; rollback/abort plan written and rehearsed.
**Data** — every reconciliation line matched or explained and signed (§6); duplicate rate within threshold;
data-quality score above the gate; provenance recorded on every migrated row; extract files inventoried with a
destruction date.
**Training** — every role trained with competency sign-off ≥ 90 % of rostered staff; super-users certified;
quick-reference cards distributed; night-shift covered.
**Hardware** — every workstation, tablet, printer (A4, thermal, label, PVC card), scanner, kiosk, TV board,
biometric device and wristband printer installed, mapped and **test-printed**; spares on site (≥ 10 % of scanners
and thermal printers, plus consumables for 2 weeks).
**Network** — Wi-Fi survey passed in every clinical area; VLAN segmentation verified; egress allow-list open;
NTP synced; latency measured from the furthest ward.
**Integrations** — every analyzer, modality, payment gateway, SMS/WhatsApp template (DLT-approved), ABDM M1
credential, TPA/scheme connection tested end-to-end in production with a real transaction, each with a documented
fallback (`08` §0 checklist).
**Compliance** — DPDP notice and consent text approved by the DPO and printed in the local language; retention
policy configured; audit and break-glass verified; licences and registrations current (NC-023); UAT sign-off matrix
complete; clinical change-control records attached to the release.
**Support** — hypercare roster published; escalation matrix agreed with names and numbers; command centre set up;
issue tracker configured with the triage SLA; legacy system confirmed read-only-available as the fallback.

---

## 11. Hypercare (14 days)

- **Daily standup, 08:30, 15 minutes**, hospital + VIMS: yesterday's volumes vs baseline, open blockers, top 5
  issues, today's risks, staffing. Chaired by the hospital PM, not the vendor.
- **Issue triage SLA during hypercare** (tighter than the standard `10` §12 tiers): **P1** — patient safety,
  cannot bill, cannot dispense, cannot admit → respond 15 min, workaround 1 h, fix 4 h, 24×7 on site;
  **P2** — department blocked or a report wrong → respond 1 h, fix same day; **P3** — single-user or cosmetic →
  respond 4 h, fix within the hypercare window; **CR** — change request → logged, assessed, scheduled, never
  fixed silently mid-hypercare.
- **Defect classification** matches `09` §12 (Blocker / Major / Minor / Change request) and is agreed jointly —
  the hospital classifies impact, VIMS classifies cause. Disputes go to the sponsor, same day.
- **Daily reports** to the sponsor: transaction volumes by module vs the legacy baseline, adoption % by role
  (logins and actual transactions, not just logins), open issues by severity and age, reconciliation status,
  and the top 3 things that will hurt tomorrow.
- **Exit criteria (day 14):** zero blockers; every major has an owner and a date; adoption ≥ 90 % of expected
  transactions in every P0 module; daily financial reconciliation clean for 5 consecutive days; floor-walkers
  withdrawn without a spike in tickets. If any fails, hypercare extends — it does not simply end on schedule.

---

## 12. Stabilisation and benefits realisation

Weeks 3–12: fortnightly review, backlog grooming into the release train, configuration tuning (templates, order
sets, approval matrices, report layouts) — most "the system doesn't do X" tickets at this stage are configuration,
and fixing them properly is what converts users into advocates. Phase-2 modules go live in waves, not all at once.

**KPIs — measure the baseline _before_ cutover, or the benefit case is unprovable.**

| KPI                                                                | Typical legacy baseline | 90-day target              | 12-month target                        | Source                 |
| ------------------------------------------------------------------ | ----------------------- | -------------------------- | -------------------------------------- | ---------------------- |
| New-patient registration time                                      | 4–6 min                 | 3 min                      | **< 90 s**                             | OP-001 timestamps      |
| Returning-patient check-in                                         | 2 min                   | 45 s                       | **< 20 s**                             | OP-001                 |
| OPD wait: check-in → consult start                                 | 45–70 min               | 40 min                     | **< 30 min**                           | OP-001/EN-006          |
| Discharge: order → patient leaves                                  | 3–5 h                   | 2.5 h                      | **< 2 h**                              | IP-002                 |
| Final-bill preparation                                             | 45–90 min               | 30 min                     | **< 15 min**                           | IP-005                 |
| Lab TAT (routine, order → report)                                  | 4–6 h                   | 3 h                        | **< 2 h**; STAT < 45 min               | OP-004                 |
| Radiology report TAT                                               | 24–48 h                 | 12 h                       | **< 8 h**                              | OP-008                 |
| Claim denial rate                                                  | 12–18 %                 | 10 %                       | **< 7 %**                              | RC-004                 |
| Pre-auth turnaround                                                | 24–48 h                 | 12 h                       | **< 6 h**                              | RC-002                 |
| AR days outstanding                                                | 75–110                  | 70                         | **< 55**                               | RC-005                 |
| Revenue leakage (unbilled/missed charges)                          | 3–6 % of revenue        | 2 %                        | **< 1 %**                              | RC-006                 |
| Stock-out incidents (critical items)/month                         | 15–30                   | 8                          | **< 3**                                | NC-006                 |
| Expiry write-off as % of pharmacy purchases                        | 1.5–3 %                 | 1.2 %                      | **< 0.8 %**                            | NC-006/OP-003          |
| Medication administration recorded within 15 min of scheduled time | not measurable          | 85 %                       | **> 95 %**                             | IP-003                 |
| Critical result acknowledged within 30 min                         | not measurable          | 90 %                       | **> 98 %**                             | EN-029/EN-037          |
| Duplicate patient creation rate                                    | 8–20 % legacy stock     | < 1 % of new registrations | **< 0.3 %**                            | OP-001/EN-036          |
| Digital adoption (transactions performed in-system vs on paper)    | —                       | 90 %                       | **> 98 %**                             | usage analytics        |
| ABHA linkage of eligible patients                                  | 0                       | 40 %                       | **> 70 %**                             | EN-011                 |
| Staff time saved (front office + billing + nursing documentation)  | —                       | —                          | quantified in the ROI review (`11` §5) | time-and-motion sample |

Publish these monthly to the sponsor with the raw numerator/denominator, not just the percentage. The 90-day
review is also when the benefits case in the business plan is honestly re-tested — including the parts that did
not land, and why.
