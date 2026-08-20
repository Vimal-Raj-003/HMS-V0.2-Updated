# PHASE 6 — EMERGENCY, TRAUMA & ORTHOPAEDICS

Phases 0–5 complete: a patient can be registered, seen, investigated, dispensed and billed. Now the hospital's
front door at 3 a.m. — where the patient cannot wait, cannot pay first, and sometimes cannot tell you their name.

## Read first

`CLAUDE.md`, `docs/PROGRESS.md`, then: **OP-006** (ER intake, ER board, day care), **TR-001** (triage & scoring),
**TR-008** (MLC & forensic), **TR-009** (pre-hospital), **NC-013** (ambulance & fleet), **TR-002** (fracture
registry), **OP-009** (orthopaedic OPD), **TR-003** (implants & prosthetics), **TR-005** (cast & splint),
**TR-007** (polytrauma board), **TR-004** §3.1–3.2 (emergency OT request — only the _request and hold_ side; the OT
itself is Phase 7), **EN-037** (paging, escalation, on-call routing), plus **EN-013** (tags/wristbands),
**EN-018** (trauma bay and ER boards), **EN-029** (activation criteria and score rules), **EN-039** (survey forms),
**NC-030** (on-call roster — read-only consumer here), and `docs/04-security-compliance.md` §7,
`docs/07-performance-scalability.md` §offline/edge.
**Not in this phase:** TR-006 (trauma ICU, Phase 7), TR-010 (rehab pathway, Phase 8), TR-011 (registry, Phase 11).

Plan first; wait for "go". **Build order inside the phase: OP-006 → TR-001 → TR-008 → TR-009 + NC-013 →
TR-002 + OP-009 → TR-003 → TR-005 → TR-007.**

## Goal

An ambulance pre-alerts the ER before it arrives; the patient is on a trolley with a wristband within 30 seconds of
the door, triaged within five minutes, and — if the criteria fire — a trauma team is paged, on the clock, with
timers running from the moment of injury. Every injury is documented on a body map, every fracture is classified,
every implant is traceable to the patient and back to the vendor, and every medico-legal case is registered,
intimated to the police and sealed with an evidence chain no one can quietly alter. When 40 casualties arrive at
once, the same tablets switch to tag-based triage and keep working with the network down.

## Deliverables

### 6.1 ER intake, quick registration and the ER board (OP-006)

Arrival modes (walk-in, ambulance with TR-009 pre-arrival record, police-brought, referred, MCI). **Quick reg
(`F1`)**: name-or-"Unknown Male ~40", gender, approximate age, complaint, brought-by, MLC suspicion — UHID or
**`ER-TAG-<seq>` temporary identity** with photo, wristband printed, ER visit on the `ER_NO` series, all in under
30 seconds. Full registration completed later by the desk (ID, ABHA, insurance, MV Act golden-hour cashless, PMJAY
emergency) and reconciled into the UHID through the OP-001 merge flow **without losing a single ER record**.
ER layout config: zones (Resus, Acute, Fast-track, Observation, Paeds, Isolation, Decontamination), bays,
trolleys, wheelchairs. **ER board** sorted strictly by ESI then waiting time, with per-level target timers going
amber at 80 % and red at 100 %, bay occupancy colours, pending orders, boarding-for-IP-bed state, ER LOS. Bay
assign/move by drag or bay-barcode scan; vacate raises a cleaning request (NC-018 arrives in Phase 7 — emit the
event now). Dispositions: admit (one-click into the IP-001 request, pre-filled — Phase 7 consumes it), discharge
with ER summary, refer out, LAMA/DAMA with witnessed consent, absconded, death, observation.

### 6.2 Triage engines (TR-001)

**ESI 5-level** computed server-side from a shared pure function in `packages/contracts/scores`: decision points
A (immediate life-saving intervention), B (high risk / new confusion / severe pain), C (resource count),
D (danger-zone vitals by age band, including the paediatric tables). Nurse confirms or overrides with a
permission and a reason; colour tag 1 Red … 5 Blue printed on wristband; target times ESI-1 immediate, 2 ≤ 10 min,
3 ≤ 30 min, 4 ≤ 60 min, 5 ≤ 120 min (configurable, NABH indicator). Re-triage creates a new record and keeps the
old one. **GCS** E/V/M with the paediatric verbal scale under 5 years and the `1T` intubated flag.
Special pathways from triage: stroke (door-to-CT), STEMI (ECG ≤ 10 min), sepsis (qSOFA bundle timers),
paediatric (PEWS/JumpSTART), obstetric, poisoning (antidote stock check), psychiatric/violent (security alert),
infectious (isolation flag).

### 6.3 Trauma team activation and paging (TR-001 §3.3 + EN-037 + NC-030)

Tiered activation criteria as an EN-029 rule set, seeded from ACS-COT defaults and hospital-editable:
**Level 1** (SBP < 90 age-adjusted, GCS ≤ 8 with mechanism, RR < 10 or > 29, field intubation, penetrating torso/
neck/head injury, gunshot, flail chest, ≥ 2 long-bone fractures, suspected pelvic fracture, paralysis, proximal
amputation, burns > 20 % TBSA with trauma, transfer receiving blood); **Level 2** (fall > 6 m adult / > 3 m child,
high-risk crash, auto vs pedestrian, motorcycle > 30 km/h, age > 55 or < 5, anticoagulants, pregnancy > 20 weeks,
dialysis, EMS judgement). Activation pages trauma surgeon, EM physician, anaesthetist, ortho, neurosurgery,
radiology tech, blood bank (MTP standby, uncross-matched O-negative), OT coordinator (TR-004 emergency slot hold)
and ICU (bed hold) through EN-037 using the NC-030 roster, with acknowledgement, ETA and arrival tracked.
**A Level 1 page cannot be silenced.** Stand-down needs the team leader plus a reason. Pages carry no PHI.
Under-/over-triage (activation tier vs final ISS, Cribari matrix) is captured now for TR-011 in Phase 11.

### 6.4 Golden-hour primary survey and score auto-calculation (TR-001 §3.4–3.5)

Tablet ATLS **primary survey** (A/B/C/D/E) where every intervention writes a timestamped row: airway and collar
time, needle decompression and ICD, **tourniquet on-time with alarms at 90 and 120 minutes**, pelvic binder, IV/IO
access, fluid and blood volumes, FAST result, MTP activation, pupils, glucose, exposure and log-roll.
Live timers: time since injury, door time, **door-to-CT target ≤ 30 min for Level 1**, **door-to-OT ≤ 60 min for
damage control**, MTP cooler out-time. One-tap trauma order set (ABG, lactate, Hb, coagulation, group & cross-match,
eFAST, portable chest and pelvis films, CT trauma series) with prompts for tetanus, **TXA within 3 hours** and
**antibiotics within 1 hour of an open fracture**. **Secondary survey** with AMPLE history, structured mechanism,
and a head-to-toe **body diagram** (adult and paediatric SVG, front/back/lateral) producing an injury list.
Auto-calculated and versioned: **RTS** from coded GCS/SBP/RR bands, **AIS → ISS** (sum of squares of the three
highest AIS in different regions; any AIS 6 → ISS 75) and **NISS**, shock index, MGAP/GAP, and **TRISS**
(blunt/penetrating coefficient sets, MTOS default, local coefficient set loadable and versioned). Arrival values
are frozen for TRISS. Scores are _provisional_ until locked by a coder or EM consultant; post-lock edits create a
new version with reason.

### 6.5 Mass-casualty mode (TR-001 §3.2 + OP-006 §3.2.4)

Declaring an MCI (locally or from the 108 control room) switches ER tablets to a single-screen **START/JumpSTART**
wizard: scan a pre-printed four-colour tag (`MCI-<incident>-<seq>`, batch-printed via EN-013), answer the walk/
breathing/RR/perfusion/mental-status ladder, store category with timestamp, triage officer, optional GPS and photo,
and create a **tag-based temporary ER visit**. No registration, no payment, no external call anywhere in the path.
Re-triage at every zone with full category history. MCI capacity board (counters by category, casualties per zone,
O-negative stock, free OT rooms, ICU beds, ventilators) on TV. Family information desk list shows tag number,
photo and description only until identity is confirmed. **Identity reconciliation** afterwards: tag → UHID merge
that preserves every TR-001, TR-008 and OP-006 record and re-points billing. Stand-down produces an after-action
report (casualties by category, time to triage, over/under-triage against final ISS).

### 6.6 MLC register, police intimation and chain of custody (TR-008)

Auto-suggest MLC from the structured mechanism (RTA, assault, burns, self-harm, firearm, industrial, fall from
height, animal attack, unknown patient); the doctor accepts or declines with a reason. **Gapless `MLC` numbering.**
Police intimation form generated, dispatched and acknowledged with the receiving officer's name, number and time.
Injury documentation on the forensic body map with measurements and photographs. **Evidence chain of custody:
every item (clothing, projectile, swab, sample) is sealed, labelled, hashed on capture, and every handover records
giver, receiver, time and a signature; the hash chain is verifiable and any break is visible.** Court report and
certificate generation; sexual-assault/POCSO protocol with restricted visibility; brought-dead and inquest flow.
Rules that must hold: once flagged MLC it cannot be un-flagged except by the Medical Superintendent with a reason;
discharge, transfer and body release are **blocked** until the minimum MLC set is complete or an audited override
is given; police receive the intimation form only, never the clinical record, unless a court summons is recorded;
MLC visits are excluded from routine WhatsApp report pushes; MLC records are retained permanently.

### 6.7 Fracture registry and orthopaedic OPD (TR-002 + OP-009)

Fracture entry creatable from any care setting (ER, OPD, ward, OT): bone and segment, side (mandatory),
**AO/OTA classification** with a guided picker, open vs closed, **Gustilo-Anderson grade for open fractures**
(which starts the antibiotic-within-an-hour clock), mechanism, associated injuries, neurovascular status.
X-ray timeline with side-by-side prior comparison from EN-008, treatment plan (conservative, cast, traction, ORIF,
external fixation) with events, union assessment, **non-union watch**, complications, and PROM/outcome capture.
Dislocations, pelvis/acetabulum, spine and multiple-fracture handling; paediatric fracture types (Salter-Harris).
OP-009 layers the ortho OPD on OP-002: "X-ray first" routing, ROM/power exam grid with normal-reference hints,
seeded ortho order sets, seeded follow-up protocols with offsets from an anchor date, rehab referral (OP-015 and
TR-010 land later — emit the referral), and PROMs.

### 6.8 Implant and prosthetics traceability (TR-003)

Implant catalogue with **UDI/GTIN**, serial or lot, manufacturer, size/laterality, MRI conditionality and shelf
life. Receipt from owned stock or **consignment (NC-007 handshake)**. Pre-op planning with availability check and
size-range hold. **Intra-op scan-to-patient**: each implant scanned, bound to the patient, the surgeon and the
procedure; **an implant may never be recorded against a patient without a successful scan or an audited manual
entry with reason**; usage triggers the consignment auto-PO and the NC-007 invoice reconciliation, and posts a
charge intent to IP-005/OP-005 at the consignment price. Patient implant record and printed/QR **implant card**.
**Recall / field safety notice**: given a UDI or lot, produce the exact list of patients implanted, notify them and
their surgeons, and track the response — this is the single most important test in this deliverable.

### 6.9 Cast, splint, brace and traction (TR-005)

Immobilisation request → application (plaster room, ER, ward or OT) with material, position, limb and applier →
**complication watch** (compartment syndrome red flags, pressure areas, cast-related pain) with patient-facing
warning instructions in the patient's language → scheduled checks and changes → removal with follow-through to the
fracture record. Plaster room operations and consumables, traction and external-fixator **pin-site care
schedules**, braces and orthoses, and optional patient photo self-report for tele-checks.

### 6.10 Polytrauma coordination board (TR-007)

One card per polytrauma patient composed from TR-001 scores, TR-002 injuries, orders, imaging, blood and consent
state. Multi-specialty consult requests with SLA timers and escalation. **Surgical priority queue and sequencing**
(life-saving before limb-saving before definitive), blood requirement tracking against IP-007 (Phase 7 — model the
requirement now), consent tracking per planned procedure, team assignment and tasks, insurance/cost coordination,
a family-communication view, MDT huddle notes, and case closure.

### 6.11 Pre-hospital, ambulance fleet, observation and day care (TR-009 + NC-013 + OP-006 §3.7–3.8)

Trip intake from 108/112, internal and private requests; dispatch and crew assignment; **GPS tracking with live ETA**;
the pre-hospital **patient care record** with vitals relay; **ER pre-alert** that creates the pre-arrival record,
pre-assigns a bay and can pre-fire team activation; digital handover on arrival that carries pre-hospital vitals
into TR-001 with no re-keying; inter-facility transfer; MCI field operations. NC-013 supplies the fleet register
with statutory compliance dates, per-trip equipment and drug checklists, trip sheets, fuel/maintenance/breakdown,
response-time SLA reporting, ambulance billing and event/mortuary standby.
Observation slabs from the RC-003 tariff with conversion prompts at threshold; **ER charges migrate to the IP bill
on admission by re-pointing bill ids with audit — never by re-creating them, never double-billed**. Day-care unit:
list-restricted procedures mapped to insurer day-care lists, discharge only on a met criteria score with a doctor
signature, midnight-crossing policy flag, package variance approvals via OP-023.

## Constraints & watch-outs

- **No triage, resuscitation or MCI screen may block on an external service.** ABHA, payment gateway, SMS, the
  fleet GPS provider and even the central API may be down; triage, tags, wristbands, primary survey and orders
  must still work. Registration is never a precondition for care and there is no "pay first" gate anywhere in ER
  (Parmanand Katara). Prove this by pulling the network cable during the demo.
- **Offline is a first-class mode in the resus bay.** Triage, START, primary survey and vitals forms are cached in
  IndexedDB with idempotency keys, device clock plus monotonic sequence, and sync within 10 seconds of reconnect.
  MCI records de-duplicate by tag number, keeping every version. On-prem edge API node is the recommended
  deployment for trauma centres — document it.
- **Tablet-first, glove-friendly.** 48 px targets, one-hand reach, colour _plus_ numeral _plus_ icon for every
  triage category, high-contrast board, audible alarms mutable per bay, bilingual tags.
- Performance budgets: ESI suggestion < 50 ms (pure function), triage save < 200 ms p95, START record < 150 ms
  server and < 20 ms offline, score recompute < 100 ms, board load < 150 ms, board socket update < 1 s, activation
  page dispatch < 5 s to the first channel, quick reg end-to-end < 300 ms. MCI surge: 100 casualties in 60 minutes
  across 6 tablets.
- **Scores are code, not opinion.** RTS/ISS/NISS/TRISS/GCS live as pure functions in `packages/contracts/scores`
  with property-based tests and worked examples from the literature; the same function runs on client and server.
  Never let a UI compute a score the server does not agree with.
- **Forensic data is different data.** MLC media routes through the TR-008 custody service (hashed, sealed, access
  by ABAC `mlc_access`), never through the ordinary clinical media store; all access is audited; MLC and MCI
  records are retained permanently.
- Nothing in this phase may hard-depend on Phase 7. TR-004 gets a request-and-hold stub, IP-007 a requirement
  model, IP-001 a pre-filled admission request, NC-018 an event. Do not start building the OT.
- No AI. Activation criteria, triage suggestions and deterioration alerts are EN-029 rules.

## Exit gate

1. An ambulance pre-alerts, the ER board shows the inbound patient with ETA and pre-hospital vitals, a bay is
   pre-assigned, and on arrival the handover carries the vitals into triage with zero re-keying.
2. An unknown unconscious patient is tagged, wristbanded and treated in under 30 seconds; two hours later the tag
   is merged into a real UHID and every ER, MLC and imaging record follows, with billing re-pointed and audited.
3. A Level 1 activation fires from triage: the whole team is paged within 5 seconds, acknowledgements and arrival
   times are recorded, the golden-hour timers run, and no configuration can silence the Level 1 page (prove it in
   a test).
4. GCS, RTS, ISS, NISS and TRISS auto-calculate and match the worked examples in the test fixtures; locking a score
   then amending it produces a new version with reason and an intact audit chain.
5. Declare an MCI, triage 30 casualties on tags with the network disconnected, reconnect, and every record syncs
   with no duplicates and no lost category history; the capacity board and after-action report are correct.
6. An RTA case auto-suggests MLC, the police intimation is generated and acknowledged, evidence is sealed with a
   verifiable hash chain, and **discharge is blocked** until the minimum MLC set is complete; an MS override is
   possible and fully audited.
7. An open tibia fracture is registered with AO/OTA and Gustilo grade, the antibiotic clock is breached
   deliberately, and the breach appears as a KPI; the X-ray timeline compares a prior study.
8. An implant is scanned to a patient in a procedure, appears on the implant card, raises the consignment auto-PO,
   and a simulated recall on that lot produces the exact patient list with notifications sent.
9. A cast is applied with complication instructions in a second language, a pin-site schedule generates tasks, and
   a removal closes the loop on the fracture record.
10. The polytrauma board sequences three competing procedures, tracks consents and blood requirement, and shows an
    SLA-breached consult escalating.
11. Performance: 500 ER visits/day and a 100-casualty surge pass the budgets above; k6 scripts committed.
12. Previous gates green; `docs/PROGRESS.md` updated.
