# PHASE 7 — INPATIENT

Phases 0–6 complete: the ER can admit but there is nowhere to admit to. This is the largest phase in the build —
beds, nurses, theatres, intensive care, blood and a correct final bill.

## Read first
`CLAUDE.md`, `docs/PROGRESS.md`, then, per step: **IP-001** (admission & beds), **IP-025** (bed command centre),
**NC-018** (housekeeping), **NC-030** (roster), **IP-018** (transfer), **IP-003** (nursing station),
**IP-004** (nursing mobile), **IP-014** (ward stock & unit dose), **IP-012** (infection control),
**IP-005** (IP billing), **IP-008** (IP packages), **IP-006** (OT), **IP-024** (anaesthesia), **EN-003** (CSSD),
**TR-004** (trauma OT), **IP-009** (ICU), **IP-016** (HDU), **TR-006** (trauma ICU), **IP-013** (crash cart & code
blue), **IP-007** (blood bank), **IP-002** (discharge & summary), **IP-017** (mortuary), plus **EN-029** (NEWS2,
sepsis, MAR checks), **EN-037** (escalation), **EN-038** (approvals), **EN-039** (assessment forms),
**EN-013** (wristband and drug barcodes), **RC-002/EN-002** (credit limits), and
`docs/04-security-compliance.md` §7, `docs/07-performance-scalability.md`, `docs/09-quality-gates-and-testing.md` §10.

Plan first; wait for "go".

**This phase is deliberately split into seven steps. It is fine — and recommended — to paste one step at a time,
finishing each step's slice of the exit gate before moving on.** Build order is 7A → 7B → 7C → 7D → 7E → 7F → 7G;
7F (blood bank) may be built in parallel with 7D/7E if you have a second pair of hands.

## Goal

A patient admitted from ER or OPD gets a bed that genuinely exists, a nurse who sees every due task on one screen,
medications given against the 5 Rights with a barcode, an operation that cannot start until the WHO checklist is
signed, intensive care with hourly flowsheets and escalation that reaches a human, blood that is checked twice at
the bedside, and finally a discharge summary and a final bill that reconcile to the rupee — with the bed released,
cleaned and back on the board within minutes.

## Deliverables

### Step 7A — Admission, beds, ADT, housekeeping and the command centre

#### 7A.1 Ward/bed configuration and admission (IP-001)
Buildings, floors, wards, ward types, room and bed classes with tariff linkage (RC-003), bed attributes (isolation
capable, oxygen point, monitor, ventilator point, attendant bed), sex/age policies, and a bed status machine
(available / occupied / reserved / cleaning / blocked / retired).
Admission advice from OP-002 or the ER disposition → admission request → admission with consent (EN-028),
**deposit suggestion** (class rule vs package rule minus existing credit, short/waived needs EN-038 approval),
payer capture with automatic pre-auth case creation (EN-002/RC-002) and room-class eligibility check with the
proportionate-deduction warning, IP number from the `IP_NO` series, wristband, and admission kit prints.
ER fast-track admission uses the same series with `registration_complete = false`. Statutory registers, MRD
linkage (NC-003), day-care and observation admissions.

#### 7A.2 Bed allocation, transfers and holds (IP-001 + IP-018)
Allocation is **transactional** (`SELECT … FOR UPDATE SKIP LOCKED` on the bed row) with an exclusion constraint as
the last line of defence. Bed transfers record exact timestamps and show a **proration preview before confirmation**
(IP-005 applies the policy). Bed holds with TTL (2 h ER, 6 h elective, 24 h OT/ICU return) that expire and notify.
Temporary leave, blocking with approval beyond 24 h. IP-018 covers intra-facility transfer with SBAR handover
(lines, tubes, drips, pending results), inter-facility transfer-out with stability note and documents pack,
inter-branch transfer (EN-041), and transfer-in.

#### 7A.3 Housekeeping, turnover and the command centre (NC-018 + IP-025)
Cleaning tasks auto-dispatched on vacate with ward-type SLAs, mobile acceptance and completion, inspection/QC,
breach escalation, and the rule that **a bed cannot become `available` without a cleaning confirmation** (manual
override with reason only); plus NC-018's routine schedules, checklists and consumables. IP-025 adds the
enterprise bed board and census as a **read model**, demand queue and assignment, expected-discharge maintenance
with a discharge-before-noon programme, transport dispatch, occupancy forecasting, escalation playbooks, huddles,
and surge mode wired to the Phase 6 MCI declaration.

### Step 7B — Nursing station, MAR, assessments, mobile

#### 7B.1 Ward dashboard and assignment (IP-003)
Patient assignment per shift from the NC-030 roster with nurse-patient ratio checks, a single ward screen showing
every patient's due tasks, vitals status, MAR due/overdue, pending orders, alerts, isolation and fall/pressure-risk
flags, and nurse-call response times.

#### 7B.2 Assessments and care plans (IP-003 + EN-039)
Nursing admission assessment, care plans with goals and interventions, and the risk scales — falls (Morse),
pressure injury (Braden), pain, restraint, nutrition screening, DVT — each with a scheduled reassessment cadence and
a due/overdue state that is visible on the ward dashboard.

#### 7B.3 Vitals, NEWS2 and escalation (IP-003 + EN-029)
Scheduled vitals per acuity, **NEWS2/PEWS computed server-side on every save**, and a documented escalation ladder
(nurse → senior nurse → RMO → consultant → rapid response/code) with acknowledgement, timers and audit. Escalation
must fire even if the nurse closes the tab. Deterioration also prompts re-triage/step-up.

#### 7B.4 MAR with 5 Rights (IP-003 §3.4 + IP-014 + EN-013)
Order → **pharmacist verification (IP-014) → MAR release**. Administration requires **scan patient wristband +
scan drug barcode**; the system verifies right patient, drug, dose, route and time, and refuses silently-wrong
combinations. **High-alert drugs (insulin, heparin, concentrated electrolytes, chemotherapy, opioids) require a
second-nurse witness with a separate authenticated sign-off.** Missed/refused/held doses carry a coded reason;
PRN doses record indication and effect; narcotics use the double-check and running-balance path from IP-014.
Unit-dose and patient-specific dispensing, ward indents, floor-stock par levels, returns with credit notes,
ADR capture (PvPI) and medication-error reporting.

#### 7B.5 I/O, notes, handover and nursing mobile (IP-003 + IP-004)
Intake/output with running fluid balance, SBAR nursing notes, wound and drain charting, the nursing task engine,
and **shift handover** that composes automatically from the shift's events and is signed by both nurses.
IP-004 as an installable PWA (native is Phase 13): wristband-first bedside identification, bedside vitals, barcode
medication verification, push alerts with escalation, wound photo capture, task completion, and **offline mode**
with the per-entity conflict rules from the spec.

#### 7B.6 Infection control (IP-012)
Automatic device-days and denominators from IP-009/IP-003 data, HAI candidate detection and adjudication (CLABSI,
CAUTI, VAP, SSI), isolation management, the microbiology/antibiogram feed from OP-004, hand-hygiene audits,
outbreak detection, environmental and sterilisation surveillance (with EN-003), staff exposures, and stewardship
hooks.

### Step 7C — IP billing

#### 7C.1 Bill lifecycle and automatic room rent (IP-005 §3.1–3.2)
One open bill per admission opened at admission with payer setup; lines immutable after posting; corrections by
reversal lines only. Then the room-rent engine: a scheduled job at the hospital cut-off, and on every
`ip.transferred` / `ip.discharge.completed`, reads the bed occupancy timeline and posts room rent, nursing, RMO,
ICU/HDU monitoring, per-day equipment, diet and attendant-bed lines with rate snapshots. Three configurable
policies (day-boundary, higher-class, hourly proration) plus admission/discharge grace rules, minimum one day and
day-care flat charge. GST: ICU/CCU/NICU/HDU exempt, room over
the configured threshold taxable at 5 % on the room line only. **Every auto line is idempotent on
(admission_id, charge_date, charge_code, occupancy_id) — reruns never duplicate.**

#### 7C.2 Event-driven posting, deposits and credit limits (IP-005 §3.3–3.4)
Consumers for pharmacy issues and returns, lab and radiology, OT (theatre time slabs, anaesthesia, surgeon and
assistant fees by grade, equipment, scanned consumables, implants with UDI from TR-003/NC-007), blood, procedures
and doctor visits (auto-visit only from a signed rounds note). Deposits, top-ups, **TPA credit limits with alerts
at 70/85/95 %**, above-limit flagging and an auto-drafted enhancement request with the interim bill.

#### 7C.3 Interim bills, packages, family view (IP-005 + IP-008)
Interim bills, holds and disputes; package versus itemised billing with IP-008 (versioned package definitions,
utilisation alerts, conversion and settlement, variance and profitability); a family-facing running-cost view and
bill explainer; estimate-variance notification above 20 %.

#### 7C.4 Discharge clearance (IP-005 §3.7)
Final bill on gapless numbering per branch per financial year, requiring zero held items, no `rate_pending` line
and an authorised TPA amount (or an audited "settle as self" override). 269ST cash cap and PAN capture enforced.
Late charges after clearance become a supplementary bill with approval — never an edit.

### Step 7D — Operation theatre, anaesthesia, CSSD, implants

#### 7D.1 OT configuration, scheduling and pre-op readiness (IP-006 + IP-024)
Theatres, sessions, surgeon blocks, equipment sets and staffing; booking request with procedure, duration estimate,
anaesthesia type, implants and special equipment; scheduling board with conflict detection, elective list
publication, and **emergency override (TR-004)** that bumps an elective case with a recorded reason and notifies
everyone affected. **Pre-op readiness (§3.3 + IP-024)** — D-1 checks: consent (procedure-specific and
side-marked), fasting, PAC clearance, fitness, cross-match, implants confirmed, equipment and CSSD sets available,
pre-op antibiotics ordered. **Site marking** with the patient
involved. IP-024 PAC clinic with ASA grade, airway assessment, investigations and optimisation plan.

#### 7D.2 WHO Surgical Safety Checklist (IP-006 §3.4) — a hard gate
Sign-in, **time-out** and sign-out, each timestamped and attributed to the named person who performed it.
**Incision cannot be recorded before the time-out is complete; the case cannot be closed before sign-out
(including instrument, swab and sharps counts reconciling).** Configuration may add items but may never remove or
bypass the three phases. Count discrepancy triggers a mandatory imaging/reconciliation workflow.

#### 7D.3 Intra-op and post-op (IP-006 §3.5–3.8 + IP-024 + TR-004)
Intra-op record (team, times, findings, procedure performed vs planned, specimens to histopath, blood loss,
consumables scanned, implants scanned via TR-003), **anaesthesia record with device feed** (IP-024), C-arm dose log
(TR-004), operative note and post-op orders, PACU scoring and discharge criteria, turnover and cleaning, CSSD
set return.

#### 7D.4 CSSD (EN-003)
Instrument sets and trays with barcodes, the full cycle (receipt → decontamination → inspection/assembly →
sterilisation → cool/quarantine → store → issue → return), load records with **Bowie-Dick, biological and chemical
indicator results**, parameter capture from the autoclave, expiry by pack type, **a load that fails BI cannot be
released** and triggers **recall of every set issued from that load with the list of patients they touched**,
issue/return traceability to the OT case, and turnaround/rework analytics.

### Step 7E — ICU, HDU, crash cart, code blue

#### 7E.1 ICU/CCU (IP-009) and HDU (IP-016)
Admission criteria and baseline scores (APACHE II, SOFA), **hourly flowsheet** with device integration
(monitors, ventilators, syringe pumps — EN-042 adapters, manual entry always available), ventilator tracking and
weaning, haemodynamics and infusion protocols, bundles (VAP, CLABSI, CAUTI, sedation, DVT, stress ulcer, glycaemic),
line/device days, alert cascade, rounds and the multi-organ dashboard, procedures, restraints and sedation scoring,
end-of-life documentation, step-down and step-up flows with HDU. **TR-006** overlays the trauma ICU: tertiary
survey, trauma-specific bundles, the multi-organ trauma board, and the Phase 6 hand-off carrying scores and the
injury list forward.

#### 7E.2 Crash cart and code blue (IP-013)
Cart register with sealed-lot contents, **shift/daily seal checks and full open-checks with expiry verification**,
code blue activation and broadcast (EN-037 + EN-018 + overhead), the **resuscitation flowsheet** recording rhythm,
shocks, drugs, CPR cycles and ROSC with a running clock, post-code restock/re-seal, debrief and review, and
code-to-first-shock/first-drug time metrics.

### Step 7F — Blood bank

#### 7F.1 Donor to component (IP-007 §3.1–3.5)
Donor registration, screening, deferral rules, collection and donor adverse events, TTI and grouping tests,
component preparation and labelling, inventory with **storage temperature monitoring and excursion handling**,
expiry management.

#### 7F.2 Request to transfusion (IP-007 §3.6–3.9)
Request with clinical indication, sample with a **separate, independently-drawn group-check sample rule**,
cross-match, **two-person issue** and **two-person bedside verification against the wristband before the first
drop** — this check is a hard gate that cannot be skipped, deferred or configured away. Transfusion observations,
reaction reporting and haemovigilance, and the **massive transfusion protocol** with cooler tracking, wired to the
Phase 6 activation path. Statutory and external (§3.10–3.11): SBTC/NACO registers and returns, look-back
procedures, autologous and directed donation, and external units received from another blood bank.

### Step 7G — Discharge, summary, mortuary, transfer-out

#### 7G.1 Planning, initiation and medication reconciliation (IP-002 §3.1–3.3)
Expected discharge date from admission, discharge planning tasks, doctor-initiated discharge with the clinical
summary skeleton pre-composed from the episode. Then reconciliation: home meds → inpatient meds → discharge meds
compared line by line, each with continue / stop / change / new and a reason; unresolved discrepancies **block** the
summary from being signed; the discharge Rx runs the full EN-029
checks and flows to IP-014 take-home dispensing.

#### 7G.2 Discharge summary (IP-002 §3.5)
Versioned, signed, immutable clinical document assembled from diagnoses, procedures, course, investigations,
medications, condition on discharge, follow-up plan and red-flag advice; resident-drafted with consultant co-sign;
patient copy in the patient's language; ABDM DischargeSummaryRecord bundle prepared for Phase 11.

#### 7G.3 Clearance and physical discharge (IP-002 §3.6–3.7)
**Clearance blocks on: pending orders or unreported results, unreturned ward stock and unreconciled narcotics,
unreturned equipment, incomplete MLC set (TR-008), unsigned summary, and an unsettled patient share or unapproved
credit.** Once cleared: gate pass, bed release, housekeeping dispatch, follow-up appointment booked, transport,
documents pack, and the discharge-lounge flow.

#### 7G.4 Other exits (IP-002 §3.8 + IP-017 + IP-018)
DAMA/LAMA with witnessed consent and risk explanation, absconded, referred out, and death — declaration, MLC check,
last office, body tag, **IP-017 mortuary receipt, cold-storage allocation, MCCD Form 4/4A and Registrar report,
post-mortem coordination, embalming, NOK verification and body release with clearance**.

## Constraints & watch-outs
- **The bed board is derived, never denormalised into a second source of truth.** Occupancy comes from the
  admissions/occupancy tables through a read model that can be rebuilt from scratch at any time; write a test that
  rebuilds it and asserts it matches. Any code that keeps a hand-maintained `beds_free` counter will drift and
  will be rejected.
- **The midnight room-charge job is idempotent and re-runnable.** Run it three times, run it after a back-dated
  transfer, run it after a clock change — the bill must be identical. This is the single most common source of
  billing disputes in Indian hospitals; test it like money depends on it, because it does.
- **The MAR barcode path and the blood bedside check are hard gates.** No feature flag, no configuration value and
  no "emergency mode" may bypass the 5 Rights scan, the second-nurse witness on high-alert drugs, or the two-person
  blood check. Emergencies get a documented, audited, alerting override — not a silent one.
- **The WHO checklist is a gate, not a form.** Incision timestamps and case closure are blocked by it.
- NEWS2 escalation must survive the browser: it is a server-side rule with server-side timers, delivered through
  EN-037, escalating on non-acknowledgement.
- **The nurse tab must survive a 12-hour shift.** Memory budget: no unbounded lists, virtualised tables, socket
  payload coalescing at 1 push/sec, purge of stale cache; measure heap after a simulated 12-hour session and prove
  it is flat. Ward dashboard load < 1 s p95 for a 60-bed ward; MAR administration round-trip < 300 ms p95.
- Offline: nursing mobile queues vitals, MAR administrations and tasks with idempotency keys and the spec's
  conflict rules; a queued MAR entry that fails a server-side safety check surfaces as an alert, never as a silent
  success.
- Everything financial in 7C posts through the RC-003 tariff resolver; `rate_pending` holds the line and raises a
  task rather than billing zero.

## Exit gate
1. Admit from ER and from OPD: bed allocated transactionally, deposit and consent captured, pre-auth case created,
   wristband printed. Run 50 concurrent allocation attempts on one bed — exactly one succeeds.
2. Rebuild the bed-board read model from the admissions tables and assert it matches the live board exactly.
3. Transfer a patient from general to ICU at 23:50 and discharge at 11:00 two days later; the room-rent lines match
   the configured policy under all three rules; the job re-run three times changes nothing.
4. A nurse gives a scheduled dose with barcode scanning; a wrong-drug scan is refused; insulin requires a second
   nurse; a missed dose demands a coded reason; the whole round is auditable.
5. NEWS2 rises to 7 → escalation fires, is unacknowledged, escalates again, and appears in the audit with timings
   even though the nurse's browser was closed.
6. An elective case cannot record incision without a completed time-out, cannot close without sign-out and a
   reconciled swab count; a trauma case bumps it with an audited emergency override.
7. A CSSD load fails its biological indicator: the load is quarantined, every set issued from it is recalled with
   the affected patient list; an implant scanned in OT appears on the IP bill at the consignment rate, on the
   patient's implant card and in the vendor reconciliation.
8. Two units of blood are issued with two-person checks at issue and at the bedside; skipping either is impossible;
   a simulated reaction is reported and reaches haemovigilance.
9. A code blue is called: broadcast reaches the team, the resuscitation flowsheet records the timeline, the cart is
   restocked and re-sealed, and time-to-first-shock is reported.
10. Discharge: medication reconciliation with an unresolved discrepancy blocks the summary; once resolved, the
    summary is signed, clearance blocks on a deliberately unbilled test (RC-006) and an unreturned narcotic, then
    passes; the final bill is gapless and reconciles line-by-line to the episode. A death produces MCCD Form 4,
    mortuary allocation and an NOK-verified body release with the MLC check enforced.
11. Load test: 500-bed hospital, 200 admissions/day, 3000 MAR administrations/day, 40 OT cases/day within the
    `docs/07` budgets; nurse-tab heap flat after a simulated 12-hour shift.
12. Previous gates green; `docs/PROGRESS.md` updated.
