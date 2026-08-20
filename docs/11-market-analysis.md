# 11 — Market & Competitive Analysis

> Written for **VIMS ENTERPRISE as the vendor of Vim's HMS**. The purpose is not to reassure ourselves; it is to
> decide what to build, what to charge, whom to sell to, and what could kill this product.
> Companion docs: `12-module-index.md` (the 177 module IDs used throughout), `02-tech-stack-decision.md`,
> `04-security-compliance.md` (regulatory), `13-data-migration-and-golive.md` (implementation reality).

## 0. How to read this document — evidence vs inference

Three kinds of statements appear here and are labelled:

- **[Cited]** — taken from a source document in this kit: the VIMS 151-module master sheet and its costed
  proposal (`docs/_source-vims-master-sheet.txt`), or one of the five competitor brochures reviewed
  (Aosta BackBone HIMS, MocDoc, SMART HMIS corporate profile, SmartHospital India 2026 brochure, PCS Prodoc HIMS).
- **[Research]** — from the regulatory and market research gathered for this kit (ABDM V3 scope and certification
  path, DPDP Rules 2025 timelines, the 2026 Indian HMS buyer-expectation set, the list of named 2026 players).
- **[Inference]** — our judgement. Market sizing, price points, effort multipliers and competitor _gaps_ are
  inferences from what a brochure shows and, more tellingly, what it does not show. **A gap inferred from a
  brochure is a hypothesis to test in a sales conversation, not a fact.** Brochures are marketing artefacts;
  a vendor may well have a feature it chose not to print.

No number in this document should be quoted to a customer without the assumption line attached to it.

---

## 1. The Indian HMS market in 2026

### 1.1 Segments

| Segment                             | Beds       | Est. India count _(inference)_            | What they actually buy                                                                        | Typical annual software spend _(inference)_ | Decision-maker                                       |
| ----------------------------------- | ---------- | ----------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| **Clinics & polyclinics**           | < 20       | very large, highly fragmented             | appointments, e-Rx, billing, WhatsApp, GST                                                    | ₹15k–₹1.5 L                                 | owner-doctor                                         |
| **Nursing homes / small hospitals** | 20–50      | tens of thousands                         | + IP, pharmacy, basic lab, discharge                                                          | ₹1–4 L                                      | owner-doctor + admin                                 |
| **Mid-market**                      | 50–300     | the volume segment for a vendor like VIMS | full OP+IP, LIS/RIS, insurance, inventory, accounts, NABH aspiration                          | ₹4–25 L                                     | Managing Director / Medical Superintendent + IT head |
| **Enterprise / tertiary**           | 300–2,000+ | a few hundred                             | everything above + OT/ICU/blood bank/CSSD, RCM depth, BI, integrations, HA/DR                 | ₹25 L–₹2 Cr+                                | CIO/IT head, CFO, committee, formal tender           |
| **Chains & groups**                 | multi-site | growing fastest (PE-backed roll-ups)      | branch architecture, shared MPI, consolidated MIS, 24-hour branch onboarding, standardisation | ₹1–10 Cr                                    | group CIO + CFO                                      |
| **Government / PSU**                | any        | large, procurement-driven                 | e-Hospital compatibility, ABDM, scheme integration, lowest-cost-technically-qualified tenders | varies wildly                               | tender committee                                     |

The competitor set confirms this shape: SmartHospital India explicitly targets "a 1-doctor clinic to a 200-bed
multi-branch hospital" **[Cited]**; Aosta claims "50 to 2000+ beds handled" and 200+ clients **[Cited]**;
SMART HMIS's case studies are 200–750 beds and multi-branch groups **[Cited]**; PCS Prodoc's are 200–800 beds
with turnkey hardware **[Cited]**.

### 1.2 Buying triggers (why a hospital starts looking)

1. **The incumbent vendor failed or vanished.** PCS's Maldives case study is exactly this: "the vendor closed
   business operations… end of application support" **[Cited]**. Its Kolkata case study cites an in-house system
   "in old technology where support is withdrawn" **[Cited]**. This is the single most common trigger.
2. **Expansion.** A new branch, a new block, PE funding, a chain roll-up. SMART HMIS's Sabine case (200 beds → 4
   branches / 650 beds, PE-funded, IPO plans) and IQRAA (3 → 18 branches) are the archetype **[Cited]**.
3. **Accreditation.** NABH entry-level or full, or JCI, forces documentation the legacy system cannot produce.
4. **Regulatory pressure.** ABDM linkage expectations, DPDP Rules 2025 (full substantive compliance ~14 May 2027,
   72-hour breach reporting, ≥1-year security logs, 90-day DSAR, penalties to ₹250 crore) **[Research]**, GST changes,
   scheme empanelment requirements.
5. **Money leaking visibly.** Pharmacy stock that "never tallied" **[Cited, PCS]**, unbilled services, rising
   insurance denials, AR ageing out.
6. **A new CEO/CFO/CIO** who wants dashboards and will not accept "the report takes three days".
7. **Doctor or patient revolt** against a slow, ugly system — usually the trigger that unlocks budget, but rarely
   the one written in the RFP.

### 1.3 Procurement patterns

- **CapEx / perpetual + AMC** still dominates >300-bed and government buyers: a one-time licence (or a bespoke
  development contract) plus 15–20 % annual maintenance. The FAMI CARE proposal is precisely this shape —
  ₹343.75 L development + ₹51.6 L/year AMC = 15 % **[Cited]**.
- **SaaS subscription** dominates < 100 beds and is winning 100–300 beds, driven by MocDoc/Practo/KareXpert-style
  cloud vendors **[Research]**. Hospitals like the absence of a capital committee.
- **Turnkey** (hardware + software + resident engineer) is a real and defensible niche — PCS HISTURN sells
  hardware sizing with a 5-year plan, licences, SRS, customisation, training, go-live support, a resident engineer
  and quarterly audits **[Cited]**. Many mid-market Indian hospitals want one throat to choke.
- **Payment milestones** are near-standard: 30 % advance / 30 % UAT / 30 % go-live / 10 % post-stabilisation
  **[Cited, FAMI CARE terms]**. Expect this shape; it means cash arrives late and implementation capacity is the
  binding constraint on growth.
- **Evaluation** is a scripted demo (they will bring their own trickiest patient scenario), a reference call,
  and a site visit. **Reference accounts decide deals in this market far more than feature lists** _(inference,
  strongly supported by every competitor brochure leading with case studies)_.

### 1.4 Why replacements happen — and why they are so painful

Migration risk is the incumbent's moat. Every competitor that has broken it advertises the fact: SMART HMIS leads
with "successful migration of 10 years of clinical and non-clinical data" and "system went live without rollbacks"
**[Cited]**. That is not an engineering boast; it is the objection-handler for the only question that matters to a
hospital board. **Our migration story (`13`) and EN-036 are therefore a sales asset, not a delivery cost centre.**

---

## 2. Competitor deep-dive

### 2.1 The five source brochures, feature by feature

Legend: ● strong / documented · ◐ partial or claimed without detail · ○ not evidenced in the source · — not applicable.
**Every ○ is "absent from the brochure", not "proven missing".**

| Dimension                              | **Aosta BackBone**                                                                       | **MocDoc**                                                                 | **SMART HMIS**                                                                              | **SmartHospital India**                                            | **PCS Prodoc**                                                         | **Vim's HMS (target)**                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Positioning **[Cited]**                | patient-centric ERP, 25+ modules, 2 decades, 200+ clients, 98 % retention, 50–2000+ beds | cloud HMS, 1500+ clients, 12+ countries                                    | full-stack HIS, 8 yrs, 100 staff, India/UAE/Qatar/Malaysia/Africa, 6 M patients/yr          | 49+/53 modules, "2026 edition", clinic → 200 beds                  | enterprise HIMS since 1983, ISO 20000/27001/9001, 230+ implementations | 177 modules, 50–2000+ beds, cloud **and** on-prem               |
| Module breadth                         | ~25 named                                                                                | ~45 incl. add-ons                                                          | ~55 across 4 domains                                                                        | 53                                                                 | ~25 + turnkey services                                                 | **177**                                                         |
| Clinical depth (EMR/CPOE)              | ● EMR, ICD/CIMS/SNOMED                                                                   | ● case sheets, EMR prompts, e-Rx                                           | ● "100 % CPOE adoption" case studies                                                        | ◐ prescriptions, ICU tracking, MAR                                 | ◐ clinical profile, electronic patient folder                          | ● OP-002 CPOE + 20 specialty consoles                           |
| **Trauma / orthopaedics**              | ○                                                                                        | ○                                                                          | ○                                                                                           | ○ (emergency mgmt only)                                            | ○                                                                      | ● **11 TR modules + OP-009**                                    |
| Lab (LIS)                              | ● uni/bi-directional                                                                     | ● deep: accessioning, delta check, TAT/STAT, QC add-on, collection centres | ● 30 lab machines integrated (case study)                                                   | ◐ pathology reporting                                              | ● bi-directional interface                                             | ● OP-004 + EN-004 + EN-031                                      |
| Radiology / PACS                       | ● PACS/RIS integration                                                                   | ○                                                                          | ● PACS integration                                                                          | ◐ X-ray/USG reporting with PDF                                     | ○                                                                      | ● OP-008 + EN-008 (Orthanc/OHIF)                                |
| Blood bank / CSSD / BMW                | ●/●/○                                                                                    | ◐ add-ons /◐ add-on /○                                                     | ●/●/○                                                                                       | ○/○/○                                                              | ◐/◐/○                                                                  | ● IP-007 / EN-003 / NC-016                                      |
| **ABDM maturity**                      | ◐ "ABHA" listed                                                                          | ◐ ABHA create/verify + consent lists → **M1 + consent surface**            | ● claims "top position in records linked to ABHA"                                           | ○                                                                  | ○                                                                      | ● **M1+M2+M3+M4** (EN-011, EN-019, RC-001)                      |
| Interoperability (HL7/FHIR/DICOM)      | ◐ "HL7 compliant", PACS                                                                  | ◐ "3rd-party APIs"                                                         | ● devices, kiosks, token, TV, PACS, QHIE hub (Qatar)                                        | ○                                                                  | ◐ lab interface, EPABX                                                 | ● HL7 v2 MLLP, FHIR R4, DICOM MWL, ASTM (EN-017/EN-019)         |
| AI                                     | ◐ **"ava" voice assistant — "doctors just speak"**, voice recognition, digital notes     | ○                                                                          | ● ADHICS-compliant AI model, 100 k occupational-health certificates                         | ◐ logo background removal (Gemini), TTS announcements              | ○                                                                      | ◐ deterministic CDSS first (EN-029), AI-001…AI-008 in Phase 12  |
| Mobility                               | ◐ cloud & mobile ready                                                                   | ● doctor, patient, home-collection/runner apps                             | ● doctor (iOS+Android), nursing, customer apps, 100 k downloads                             | ● installable PWA                                                  | ○                                                                      | ● PWA-first (offline-tolerant), RN in Phase 13                  |
| Multi-branch                           | ○                                                                                        | ◐ multi-store, cross-timezone, multi-currency                              | ● **branch architecture; new branch live in 24 h**                                          | ◐ `parent_clinic_id`, shared patient pool                          | ◐ distributed/central appointments                                     | ● EN-041 group→hospital→branch, shared MPI                      |
| ERP depth (GL, HR, purchase, assets)   | ● HR, doctor fee accounting, supply chain, Tally, asset                                  | ◐ inventory/purchase; ○ GL & payroll                                       | ● accounts, HR & payroll, purchase, stores, consignment                                     | ◐ HR & payroll, inventory; ○ GL                                    | ● material, finance & budgeting, HR                                    | ● NC-005…NC-010, NC-002, NC-022                                 |
| **RCM depth** (pre-auth → denial → AR) | ◐ insurance module                                                                       | ● smart insurance panel, secondary coverage, auto co-pay                   | ● "advanced insurance workflow with RCM innovation", EMR-driven claims to reduce rejections | ◐ PMJAY, quotation engine                                          | ◐ TPA/corporate billing                                                | ● RC-001…RC-008 incl. denial mgmt, AR, leakage audit, estimator |
| Government schemes                     | ○                                                                                        | ○                                                                          | ○                                                                                           | ● Ayushman Bharat/PMJAY                                            | ○                                                                      | ● RC-007 (PMJAY/CGHS/ECHS/ESIC/state)                           |
| Deployment model                       | ◐ web/cloud                                                                              | ● cloud only                                                               | ◐ cloud + hyper-converged on-prem (case study)                                              | ● cloud only (Postgres RLS, PWA, edge functions)                   | ● on-prem/turnkey incl. hardware                                       | ● **cloud SaaS and on-prem/hybrid at parity**                   |
| Compliance claims                      | HIPAA, HL7                                                                               | HIPAA, ISO, GDPR, SOC II                                                   | NABH digital excellence, ADHICS                                                             | GST 2.0 registers, audit logs (**7-day retention**), video consent | ISO 20000-1 / 27001 / 9001                                             | DPDP + ABDM + NABH/NABL + AERB + PC-PNDT + NDPS + BMW (`04`)    |
| RBAC granularity                       | not stated                                                                               | not stated                                                                 | not stated                                                                                  | **8 roles [Cited]**                                                | rights-based                                                           | **60+ role templates, RBAC+ABAC (`05`)**                        |
| Pricing model                          | not published                                                                            | not published                                                              | not published                                                                               | "one subscription"                                                 | project/turnkey                                                        | published module bundles (§6)                                   |
| Target segment                         | 50–2000+ beds                                                                            | clinics → mid-market, intl                                                 | mid → enterprise, multi-country                                                             | clinics → 200 beds                                                 | mid → enterprise, turnkey                                              | 100–2000 beds, trauma/ortho-led                                 |

### 2.2 Reading each competitor honestly

**Aosta BackBone (Coimbatore) [Cited].** Two decades, 200+ clients, 98 % retention, and an unusually credible
integration list (uni/bi-directional lab, PACS/RIS, barcode/passive RFID, biometric, Tally, POS, kiosk, token,
digital signature, ICD/CIMS/SNOMED). The **"ava" AI voice assistant — "Doctors Just Speak, ava handles the rest"**
is exactly the 2026 buyer expectation for ambient documentation **[Research]** and is a genuine competitive threat
in demos. _Inferred gaps:_ no trauma/ortho, no visible ABDM depth beyond "ABHA", no accounts/GL, no quality/NABH
module, no BMW, no stated on-prem/cloud parity, no published RCM denial/AR workflow. **Threat level: high in Tamil
Nadu / South India; they are the incumbent VIMS will most often displace or lose to.**

**MocDoc (Chennai) [Cited].** The best-executed _cloud mid-market_ product of the five. Notably strong on the two
things mid-market hospitals feel daily: **lab operations** (accessioning, delta checks, cross-department
verification, TAT/STAT, collection centres, omni-channel reporting) and **insurance mechanics** (secondary
coverage, automated co-payment, billing threshold control, smart insurance panel). Also ships **cost estimation
for care** at reception — a feature Indian patients ask for and most vendors do not have (we answer with RC-008).
ABDM is present at the ABHA/consent level **[Cited]** — i.e. M1 plus a consent surface, not evidenced M2/M3 HIP/HIU
depth _(inference)_. _Inferred gaps:_ no GL/payroll, no trauma/ortho, no PACS, no on-prem, thin ERP.
**Threat level: high for 50–200-bed cloud buyers.**

**SMART HMIS [Cited].** The most strategically important document in the folder, for two reasons. First, its
module taxonomy — _Core OP Clinical / Core IP / Core Non-Clinical / Enabler_ — is **the same taxonomy as the VIMS
151-module master sheet**, down to module names like DIU Utility, TV Output Integration, Gate Pass & Bystander Pass
and Consignment _(inference, but a very strong one)_. The VIMS sheet appears to be built against SMART HMIS as the
functional benchmark. Second, its case studies are the competitive bar: 10 years of data migrated with **no
rollback**; 18 branches with **a new branch live within 24 hours**; 750-bed fully paperless with 30 lab machines
and hyper-converged infrastructure; Qatar's largest outpatient network (3,000+ OP/day, 8 branches) with **QHIE hub
integration**; an ADHICS-compliant AI model in Abu Dhabi. _Inferred gaps:_ no trauma/ortho specialisation, no
published pricing, no public ABDM M2/M3/M4 certification evidence, and — the usual consequence of heavy
customisation — likely long implementation cycles. **Threat level: highest in enterprise and multi-country deals.**

**SmartHospital India 2026 [Cited].** A modern, well-packaged, Postgres-RLS + PWA + edge-function product for
clinics to ~200 beds. Its engineering choices validate ours (RLS tenancy, PWA, versioned records, QR report
verification, GST 2.0 registers with a health score). But the brochure also states the limits plainly: **8 RBAC
roles**, **7-day audit-log retention**, hard-coded "18 % GST mandatory", Google Drive backups, no ABDM, no
HL7/FHIR/DICOM/analyzer integration, no blood bank/CSSD/BMW, no GL. **7-day audit retention alone fails DPDP Rules
2025 (security logs ≥ 1 year) and NABH/MRD expectations** **[Research]**. **Threat level: low above 100 beds; a
price anchor we must answer, not a functional competitor.**

**PCS Prodoc [Cited].** The enterprise-services incumbent: since 1983, ISO 20000-1/27001/9001, 230+ healthcare
implementations, 20+ offices and 30 service centres, and **HISTURN** — a turnkey wrap of hardware sizing with a
5-year plan, licences, SRS, customisation, training, go-live support, a **resident engineer**, quarterly audits and
"automated notifications for any new changes in statutory requirements". Their case studies quantify what
hospitals actually buy: **2 % of inventory recovered from pilferage, 20 % reduction in expiry, ROI within 6 months,
6-week and 4-month implementations, train-the-trainer** **[Cited]**. _Inferred gaps:_ the profile shows no cloud,
mobile, ABDM, FHIR, AI or analytics-era capability; it reads as a 2010s product with an excellent service wrapper.
**Threat level: moderate — they win on trust and service, not on product; they are also the best template for our
services model.**

### 2.3 The named 2026 field **[Research]**

Beyond the brochures, the comparison lists a 2026 Indian buyer will encounter: **Insta by Practo** and **Practo
Ray** (cloud, brand strength, clinic→mid-market), **Napier** and **Attune** (enterprise, hospital-chain and lab
depth, international), **KareXpert** (cloud, Jio-backed, ABDM-forward), **eHospital Systems**, **Medixcel**,
**BestDoc** (patient experience/front-office layer), **HealthPlix** (doctor-first EMR with strong AI-assisted
prescribing), **Adrine**, **NuvertOS**, **Cliniqwise**. Two structural observations: (1) the market is
**barbelled** — cheap cloud clinic products at one end, expensive enterprise HIS at the other, with the 100–400-bed
hospital genuinely underserved by both; (2) **nobody in the visible field leads with trauma and orthopaedics**
_(inference — this is the wedge, §4)_.

---

## 3. Table stakes vs genuine differentiation in 2026

**Table stakes — you lose the deal without them, and win nothing by having them:**
OP/IP registration, appointments, queue/token with TV display, EMR/e-prescription, LIS with barcode and analyzer
interfacing, radiology reporting, pharmacy with batch/expiry/GST, inventory and purchase, OP/IP billing with GST
and multi-payment, insurance/TPA billing, MIS dashboards, WhatsApp/SMS notifications, patient and doctor mobile
access, multi-branch, role-based access, cloud availability, PMJAY/Ayushman handling, ABHA creation and
verification (M1), a patient portal, and a credible data-migration story. **[Research + Cited across all five
brochures]**

**Weak differentiation — nice, easily copied, worth a demo moment but not a moat:**
Cost estimation at reception, QR self-registration, patient feedback with Google-review routing, TTS token calling,
loyalty points, website builders, incentive/commission management, multi-currency, bulk report download.

**Genuine differentiation in 2026 — hard to build, hard to copy, and buyers pay for it:**

1. **Depth in a specialty the buyer identifies with** (trauma/ortho, oncology, fertility, nephrology) — the
   difference between "we support orthopaedics" and an AO/OTA fracture registry with implant UDI traceability.
2. **ABDM M1–M4 completeness with certification artefacts** — sandbox exit plus STQC/CERT-In audit; 6–9 months
   from scratch, 4–6 months layered on an existing HMS **[Research]**. Most competitors show M1; few can show M2 HIP
   with FHIR R4 NRCeS profiles and Fidelius encryption, M3 HIU, and M4/NHCX claims.
3. **On-prem and cloud at true parity** — one codebase, one feature set. Cloud-only vendors cannot serve government
   tenders, Gulf data-residency rules, or a hospital with a hostile WAN link.
4. **Safety engineering you can evidence** — hard-stops that provably cannot be configured away, an evidence pack
   for an assessor, clinical change control. This is invisible on a feature grid and decisive in a clinical
   committee.
5. **Sub-second operational speed at real volume** — a worklist that opens in 200 ms on a five-year-old hospital PC
   at 2,500 OP/day. Demos hide this; go-lives do not.
6. **Offline tolerance at the bedside** — the ward Wi-Fi _will_ drop.
7. **RCM outcomes, not RCM screens** — measured denial-rate and AR-days improvement, with the analytics to prove it.
8. **NABH/NABL evidence automation** — indicators, CAPA, MRD completeness and audit packs generated, not assembled
   by a quality officer at 2 a.m.
9. **Implementation velocity** — SMART HMIS's "new branch live in 24 hours" **[Cited]** is the benchmark; hospitals
   buy time-to-value.
10. **Transparent, predictable commercials** — in a market where nobody publishes prices, publishing them is itself
    a differentiator _(inference)_.

---

## 4. The ten differentiation bets for Vim's HMS

Each bet names the modules that must be excellent for it to be true, and how we would know it failed.

| #   | Bet                                                                                                                                                                                                                                                                                                        | Modules                                   | Why it wins                                                                                                                                                                                                            | Falsified if                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | **Trauma & orthopaedics as the wedge** — the only Indian HMS with a real trauma stack: START/JumpSTART + ISS/RTS/TRISS scoring, AO/OTA fracture registry, implant UDI traceability and recall, emergency OT override, polytrauma coordination, MLC/forensic chain of custody, trauma registry & M&M review | TR-001…TR-011, OP-009, IP-024, NC-007     | no visible competitor leads here **[Cited: absent from all five brochures]**; trauma centres and ortho hospitals are a large, under-served, high-acuity buyer with acute compliance needs                              | orthopaedic hospitals tell us generic OT + implant fields are sufficient                        |
| 2   | **On-prem + cloud parity** — identical feature set, one codebase, a signed offline bundle a hospital IT team can operate                                                                                                                                                                                   | `10` §3, EN-022, EN-023                   | opens government, Gulf and connectivity-poor buyers that cloud-only vendors structurally cannot serve                                                                                                                  | on-prem deals fall below ~20 % of pipeline and support cost per on-prem tenant exceeds 2× cloud |
| 3   | **Deterministic CDSS before AI** — rules-based allergy/interaction/dose/critical-value safety that is testable, explainable and uncensorable by config; AI arrives later as advisory only                                                                                                                  | EN-029, then AI-002/AI-004                | in a market where every brochure now says "AI-powered", the honest safety story is the differentiator with clinicians and the defensible one with regulators **[Research: AI is advisory, not a medical device]**      | buyers reward AI claims over safety evidence in three consecutive competitive losses            |
| 4   | **Sub-second worklists** — p95 < 200 ms on class A–D endpoints at 5,000 OP/day, proven in a load test the customer can witness                                                                                                                                                                             | `07` budgets, read models, EN-006, IP-003 | speed is the most-felt and least-demonstrated attribute; it converts doctors, who are the real veto                                                                                                                    | measured p95 in production exceeds budget on any P0 module                                      |
| 5   | **Offline-tolerant bedside PWA** — vitals, MAR and notes queue in IndexedDB and sync with explicit conflict resolution, never silent overwrite                                                                                                                                                             | IP-004, OP-019, `01` §7                   | ward Wi-Fi is unreliable everywhere; competitors' apps assume connectivity                                                                                                                                             | nurses report < 1 offline episode/week and the feature goes unused                              |
| 6   | **ABDM M1–M4 completeness** with certification artefacts, FHIR R4 NRCeS profiles, Fidelius encryption and NHCX claims                                                                                                                                                                                      | EN-011, EN-019, RC-001                    | becomes a procurement checkbox as government linkage tightens; a 4–9-month lead time means late starters cannot catch up quickly **[Research]**                                                                        | NHA de-prioritises HIP/HIU enforcement and buyers stop asking beyond ABHA creation              |
| 7   | **Revenue-leakage recovery as a measured product outcome** — charge-capture reconciliation, unbilled-service alerts, denial root-cause analytics, AR ageing with worklists                                                                                                                                 | RC-004, RC-005, RC-006, RC-008, EN-001    | this is the only differentiator that pays for the system in the CFO's own numbers (§5); PCS already sells the anecdote (2 % inventory recovered, 20 % expiry reduction **[Cited]**) — we sell the instrumented version | pilot hospitals cannot measure a leakage reduction after 90 days                                |
| 8   | **NABH/NABL evidence automation** — indicators, incident/CAPA, MRD completeness, credentialing, SOP versions and audit packs produced by the system                                                                                                                                                        | NC-015, NC-003, NC-027, EN-024, EN-031    | accreditation is a board-level deadline with a real budget; quality officers become internal champions                                                                                                                 | hospitals continue to prefer consultants + spreadsheets after seeing the module                 |
| 9   | **24-hour branch onboarding** — a new branch of an existing group live in a day: masters cloned, numbering series issued, staff provisioned, tariffs inherited with local overrides                                                                                                                        | EN-041, EN-027, EN-036, EN-040            | matches the published benchmark **[Cited, SMART HMIS]** and is exactly what PE-backed roll-ups buy                                                                                                                     | first three group customers take > 1 week per branch                                            |
| 10  | **Transparent, module-level licensing** — published bundles, per-module add-ons, entitlement enforced in software (EN-040), no surprise "that's an add-on" mid-implementation                                                                                                                              | EN-040, §6                                | trust is scarce in this market; transparency shortens sales cycles and reduces implementation disputes                                                                                                                 | discounting destroys the published price integrity within a year                                |

Bets 1, 3 and 7 are the ones to lead with. Bets 2 and 6 are qualifiers that keep us in enterprise and government
deals. Bets 4, 5 and 9 are felt after purchase and drive references — which, per §1.3, is how deals are actually won.

---

## 5. ROI — a worked example for a 300-bed hospital

**All figures are assumptions, marked as such. This is a model to be re-run with the customer's own numbers, not a
claim. Present the assumption column to the customer alongside every result.**

### 5.1 Baseline assumptions (the hospital)

| Assumption                                 | Value                    | Basis                                            |
| ------------------------------------------ | ------------------------ | ------------------------------------------------ |
| Beds / occupancy / ALOS                    | 300 / 70 % / 4.5 days    | _assumption_, typical Indian mid-market tertiary |
| Annual revenue                             | **₹100 Cr**              | _assumption_ (≈ ₹33 L per bed per year)          |
| IP : OP+diagnostics revenue split          | 72 % : 28 %              | _assumption_                                     |
| Payer mix (insurance/TPA/corporate/scheme) | 45 % of revenue = ₹45 Cr | _assumption_                                     |
| Annual discharges                          | ≈ 17,000                 | derived: 300 × 0.70 × 365 ÷ 4.5                  |
| Pharmacy + consumables purchases           | 22 % of revenue = ₹22 Cr | _assumption_                                     |
| Cost of working capital                    | 11 % p.a.                | _assumption_                                     |
| Variable cost per bed-day                  | ₹3,500                   | _assumption_                                     |

### 5.2 Benefit model

| Lever                                                                                          | Assumed baseline                                                   | Assumed post-HMS                                                         | Calculation                                          | Annual value                            | Confidence                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Revenue leakage** (unbilled services, missed consumables, unposted charges)                  | 3.0 % of revenue                                                   | 1.2 %                                                                    | 1.8 % × ₹100 Cr                                      | **₹1.80 Cr**                            | Medium-high — the most consistently observed HMS benefit; RC-006 makes it measurable                                                                                                |
| **Denial & short-payment write-off**                                                           | 12 % of claim value denied/short-paid, 40 % ultimately written off | 7 % denied, same write-off rate                                          | (12 %−7 %) × ₹45 Cr × 40 %                           | **₹0.90 Cr**                            | Medium — depends on payer mix and the hospital's appeal discipline                                                                                                                  |
| **AR days**                                                                                    | 95 days on ₹45 Cr                                                  | 60 days                                                                  | 35/365 × ₹45 Cr = ₹4.32 Cr released, valued at 11 %  | **₹0.48 Cr** (+ ₹4.32 Cr one-time cash) | Medium                                                                                                                                                                              |
| **LOS reduction** (faster discharge, results TAT, bed turnover)                                | ALOS 4.5 d                                                         | 4.3 d                                                                    | 17,000 × 0.2 = 3,400 bed-days × ₹3,500 variable cost | **₹1.19 Cr** _(cost avoided)_           | **Low-medium — honest caveat: at 70 % occupancy this is cost saved, not revenue gained. It converts to revenue only above ~85 % occupancy.** Use ₹0.6 Cr as the conservative figure |
| **OP throughput** (shorter wait, faster billing → more visits handled with the same footprint) | —                                                                  | +2 % OP volume                                                           | 2 % × ₹28 Cr × 50 % contribution                     | **₹0.28 Cr**                            | Low — only real if demand exceeds capacity                                                                                                                                          |
| **Inventory: expiry write-off**                                                                | 2.0 % of purchases                                                 | 0.8 %                                                                    | 1.2 % × ₹22 Cr                                       | **₹0.26 Cr**                            | Medium-high — batch/FEFO and expiry alerts are mechanical; PCS reports 20 % expiry reduction **[Cited]**                                                                            |
| **Inventory: pilferage/shrinkage**                                                             | 0.6 % of purchases                                                 | 0.3 %                                                                    | 0.3 % × ₹22 Cr                                       | **₹0.07 Cr**                            | Medium — PCS reports 2 % of inventory traced from pilferage **[Cited]**                                                                                                             |
| **Inventory holding**                                                                          | 45 days of purchases                                               | 35 days                                                                  | 10/365 × ₹22 Cr = ₹0.60 Cr released, at 11 %         | **₹0.07 Cr** (+ ₹0.60 Cr one-time)      | Medium                                                                                                                                                                              |
| **Staff time (cashable)**                                                                      | —                                                                  | net redeployment of ~6 FTE across front office, billing, records, stores | 6 × ₹3.6 L fully loaded                              | **₹0.22 Cr**                            | Low-medium — realised only if the hospital actually redeploys rather than "absorbs"                                                                                                 |
| **Staff time (non-cashable)**                                                                  | nursing documentation ≈ 45 min/nurse/shift                         | ≈ 25 min                                                                 | ~28,000 nurse-hours/year returned to care            | **not monetised**                       | Report it; do not put it in the ROI                                                                                                                                                 |
| **Gross annual benefit (conservative variant)**                                                |                                                                    |                                                                          |                                                      | **≈ ₹4.08 Cr**                          |                                                                                                                                                                                     |
| **Gross annual benefit (optimistic variant)**                                                  |                                                                    |                                                                          |                                                      | ≈ ₹5.27 Cr                              |                                                                                                                                                                                     |
| **One-time working-capital release**                                                           |                                                                    |                                                                          | AR ₹4.32 Cr + inventory ₹0.60 Cr                     | **≈ ₹4.92 Cr**                          |                                                                                                                                                                                     |

### 5.3 Cost and net position

| Item                                                                           | Year 1      | Year 2+         |
| ------------------------------------------------------------------------------ | ----------- | --------------- |
| Subscription (300 beds, Enterprise bundle, §6 list ₹1,200/bed/month)           | ₹43.2 L     | ₹43.2 L (+ CPI) |
| Implementation, migration, training (one-time, §6)                             | ₹35.0 L     | —               |
| Hospital-side effort (project team, super-users, floor-walkers, ~1.5 FTE-year) | ₹12.0 L     | ₹4.0 L          |
| Infrastructure (cloud) or hardware amortisation (on-prem)                      | ₹6.0 L      | ₹6.0 L          |
| **Total cost**                                                                 | **₹96.2 L** | **₹53.2 L**     |

**Realisation haircut — the honesty adjustment.** Benefits do not start on day one. Assume **35 % realisation in
year 1** (ramp, hypercare, behaviour change) and **80 % in steady state** _(assumption)_:

|                                               | Year 1        | Year 2        | Year 3        |
| --------------------------------------------- | ------------- | ------------- | ------------- |
| Realised benefit (conservative ₹4.08 Cr base) | ₹1.43 Cr      | ₹3.26 Cr      | ₹3.26 Cr      |
| Cost                                          | ₹0.96 Cr      | ₹0.53 Cr      | ₹0.53 Cr      |
| **Net**                                       | **+₹0.47 Cr** | **+₹2.73 Cr** | **+₹2.73 Cr** |
| Cumulative net                                | ₹0.47 Cr      | ₹3.20 Cr      | ₹5.93 Cr      |

**Payback ≈ 9–11 months** on the conservative model; **3-year net ≈ ₹5.9 Cr plus ~₹4.9 Cr of one-time working
capital released** _(all figures model outputs, not promises)_.

**What would make this wrong:** if the hospital's leakage is already below 1.5 % (well-run finance function), if
payer mix is < 20 % (cash hospital), if occupancy is low and stays low, if the hospital will not redeploy freed
staff, or if adoption stalls below 90 % — in which case the leakage, denial and LOS levers all under-deliver
together. Say this out loud in the sales conversation; a CFO who has been oversold before will trust the model
_because_ it names its failure modes. Measure the baseline **before** cutover (`13` §12) or none of this is provable.

---

## 6. Pricing and packaging recommendation

### 6.1 What the FAMI CARE proposal tells us **[Cited]**

86 modules · **2,713 man-days** · **₹343.75 L development** · **₹51.6 L/year AMC** (15 %) · ₹12,000–14,000 per
man-day blended · cloud infra, third-party licences and hardware excluded · 30/30/30/10 payment terms.

Three consequences _(inference)_:

1. **Implied build economics.** At ~₹12,670/man-day, the _full_ 177-module kit is roughly **4,800–5,600 man-days**
   — the extra 91 modules are on average smaller and more reusable than the costed 86, but the platform work
   (EN-037…EN-041, EN-027, EN-039) is heavy. That is **≈ ₹6.0–7.1 Cr of build cost, or 12–16 engineer-years.**
2. **A bespoke build sold once recovers cost and creates a services company.** ₹343.75 L against ~2,713 man-days is
   roughly cost-plus. Every subsequent customer of a _productised_ Vim's HMS costs implementation only.
3. **The break-even fleet.** At the list prices below, a 300-bed customer is ≈ ₹43 L ARR. Covering ₹6.5 Cr of build
   plus ~₹3.5 Cr/year of product, support and infrastructure needs roughly **18–25 mid-market customers** (or a
   blend including a few enterprise accounts) within three years. **That number — not the feature list — is the
   business plan.**

### 6.2 Recommended packaging

**Bundles** (each a set of module IDs, entitlement-enforced by EN-040):

| Bundle                                | Contents                                                                                                                                                                         | Target                 | List price _(recommendation)_                                                                      |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------- |
| **Clinic**                            | OP-001, OP-002, OP-005, OP-003 (retail), EN-006, EN-009, EN-013, EN-018, NC-011, PE-001                                                                                          | < 20 beds / polyclinic | **₹4,500/provider/month**, min 2 providers                                                         |
| **Hospital Essentials**               | Clinic + OP-004, OP-007, OP-008 (reporting), IP-001…IP-003, IP-005, NC-001, NC-005, NC-006, EN-002, EN-005, EN-007, EN-011 (M1), EN-024, EN-027, EN-028, EN-036, EN-037…EN-041   | 20–150 beds            | **₹700/bed/month** (min ₹35,000/month)                                                             |
| **Hospital Advanced**                 | Essentials + IP-006, IP-007, IP-009, IP-012…IP-014, EN-003, EN-004, EN-008, EN-019, EN-029, OP-010, OP-015…OP-017, NC-002, NC-003, NC-009, NC-010, NC-016, RC-001…RC-006, EN-001 | 150–400 beds           | **₹1,200/bed/month** (min ₹1.4 L/month)                                                            |
| **Enterprise**                        | everything except specialty consoles and AI; HA/DR, read replicas, API gateway (EN-026), SSO (EN-025), sandbox tenant, 24×7 P1                                                   | 400+ beds, groups      | **₹1,600/bed/month**, tiered down above 800 beds (₹1,200 for beds 801–1,500, ₹900 beyond)          |
| **Trauma & Ortho pack** _(the wedge)_ | TR-001…TR-011, OP-009, IP-024, NC-007                                                                                                                                            | any bundle             | **+₹250/bed/month** or ₹60,000/month flat, whichever is lower                                      |
| **Specialty consoles**                | OP-024…OP-037, IP-011, IP-015, IP-019…IP-023                                                                                                                                     | à la carte             | **₹8,000–₹25,000/module/month** by complexity                                                      |
| **AI pack** (Phase 12)                | AI-001…AI-008                                                                                                                                                                    | à la carte             | **usage-based** (per ambient-scribe minute, per document extracted) + platform fee — never per bed |
| **Portals**                           | PE-001…PE-008, EN-012, EN-034                                                                                                                                                    | add-on                 | **₹20,000–₹60,000/month**                                                                          |

**Metric choice — use all three, deliberately:**

- **Per bed** for IP-centric bundles: the number correlates with value, the hospital already reports it, and it
  cannot be gamed by adding user accounts (which we _want_ them to do — adoption is the goal).
- **Per provider** for clinic/OP-only: beds are meaningless there.
- **Per branch platform fee** (₹25,000–₹75,000/month) on top for multi-branch groups, covering group MPI,
  consolidated reporting and the 24-hour branch onboarding promise — this is what EN-041 is worth.
- **Never per named user** for clinical staff. Per-user pricing suppresses adoption, and low adoption is the single
  biggest cause of implementation failure.

**One-time and recurring services:**

| Service                                                        | Basis                                            | Indicative                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Implementation (config, masters, training, go-live, hypercare) | by size and scope                                | ₹8 L (50 beds) · ₹20 L (150) · ₹35 L (300) · ₹75 L–₹1.5 Cr (500–1,000+)                            |
| Data migration (EN-036)                                        | by entity count, years, and legacy accessibility | ₹4–25 L; screen-scraping or PDF-only sources priced separately                                     |
| Interfaces                                                     | per analyzer/modality/device beyond the first 5  | ₹40,000–₹1.2 L each                                                                                |
| Custom development                                             | man-day                                          | ₹14,000–₹18,000 (above the FAMI CARE blended rate — this is product-integrated work, not staffing) |
| Additional training                                            | per day                                          | ₹15,000 **[Cited, FAMI CARE terms — keep consistent]**                                             |
| On-prem perpetual licence (where SaaS is refused)              | 3.0× annual subscription                         | **AMC 18 %/year**, mandatory; includes updates, not new bundles                                    |

**Discipline:** publish the list; discount by **term** (2–3-year commitment) and **reference commitment**, never
silently by feature. If a discount exceeds 20 %, remove a bundle rather than devalue the price. Annual uplift
CPI + 3 %, capped, stated in the contract.

### 6.3 Positioning against the observed field _(inference)_

SmartHospital India anchors the low end and cannot follow us above ~150 beds (8 roles, 7-day audit retention, no
integrations) **[Cited]**. MocDoc and Aosta compete squarely in Hospital Essentials/Advanced — we must be within
±20 % of them on price and clearly ahead on trauma/ortho, ABDM depth, RCM analytics and on-prem. SMART HMIS and
PCS compete at Enterprise, typically on a project basis — there we should offer **both** a subscription and a
CapEx/perpetual option, because their buyers' procurement is built for CapEx.

---

## 7. Go-to-market

**ICP (first 20 customers).** 100–500-bed multi-specialty hospitals with an **active trauma/emergency and
orthopaedic practice**, in tier-2/tier-3 cities, single-site or 2–5 branches, NABH-accredited or pursuing it,
40 %+ insurance/scheme revenue, and a live pain: an unsupported incumbent, an expansion, or an accreditation
deadline. Secondary ICP: dedicated orthopaedic and trauma hospitals of 50–150 beds — smaller deals, but they close
faster and produce the reference stories that unlock the primary ICP.

**Reference-account strategy.** Every brochure in the folder leads with case studies **[Cited]** — that is the
market telling us how it buys. Deliberately buy the first three references: heavily discounted, contractually
committed to a published case study, a reference call quota and a site visit, with a named VIMS executive
accountable. Instrument them from day one so the case study contains **numbers** (registration time, TAT, denial
rate, leakage recovered) rather than adjectives. One flagship per segment: one trauma centre, one multi-branch
group, one on-prem/government-adjacent site.

**The trauma/ortho niche as the entry.** Lead the pitch with the fracture registry, implant UDI traceability and
recall, MLC/forensic chain of custody, polytrauma coordination and the trauma registry — then reveal that the
same system runs the whole hospital. This inverts the usual sale: instead of being one more general HMS in a
five-vendor bake-off, we are _the_ system for the thing the hospital is proudest of. It also earns the clinical
champion, who is the person who actually changes a hospital's mind.

**Accreditation partnerships.** NABH/NABL consultants advise hundreds of hospitals and are trusted at exactly the
moment budget appears. Build a partner programme: co-branded readiness assessments, our NC-015/NC-003/EN-024
evidence automation mapped to their checklists, referral fees, and joint webinars. Same play with hospital
architects and medical-equipment dealers, who are present at greenfield projects 12–18 months before the HMS
decision.

**Government schemes as a wedge.** PMJAY/Ayushman, CGHS, ECHS, ESIC and state schemes (RC-007) are painful,
low-margin and badly served — empanelled hospitals bleed on package selection, blocking, claim documentation and
TMS reconciliation. Solving that specific pain is a cheap, sharp entry into hospitals that are otherwise happy
with their incumbent, and it builds the claim/denial muscle we need for RC-004 anyway. It also aligns with the
ABDM/NHCX direction of travel **[Research]**.

**International expansion path** _(inference, modelled on SMART HMIS's published footprint — India, UAE, Qatar,
Malaysia, Africa **[Cited]**)_. Sequence: **(1)** prove multi-branch and multi-currency in India; **(2)** GCC via
Indian-diaspora-managed hospitals in **UAE (ADHICS, Malaffi) and Qatar (QHIE — SMART HMIS integrated with the QHIE
hub in a January 2026 go-live **[Cited]**)**, where the buying culture and clinical workflows are familiar and
insurance/RCM sophistication is _higher_ than India — which suits our RCM depth; **(3)** East Africa
(Kenya, Tanzania, Nigeria) where on-prem tolerance, price sensitivity and English-language operations match our
profile; **(4)** SEA (Malaysia, Sri Lanka, Nepal, Bangladesh) opportunistically. Prerequisites before any of it:
multi-currency, multi-timezone, i18n/RTL, configurable claim formats and code systems, and data residency —
all already architected (`CLAUDE.md` §1, `04` §1). **Do not open a second country before ten reference-quality
Indian accounts exist.**

**Channel.** Direct sales for enterprise; implementation partners (the regional IT firms who already sell hardware
and networking to these hospitals) for mid-market, with certification and margin on implementation rather than
licence. Beware the PCS lesson **[Cited]** — a strong service network is a genuine moat, but it takes decades and
capital to build; partner rather than replicate.

---

## 8. Risks and mitigations

| #   | Risk                                                                                                                                                                                                                            | Likelihood × Impact _(inference)_ | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **DPDP full compliance by ~May 2027** — consent manager registration from Nov 2026, 72-h breach reporting, 90-day DSAR, ≥1-year security logs, SDF duties (DPO, annual DPIA, annual audit), penalties to ₹250 Cr **[Research]** | High × High                       | Build it into the product now: EN-028 consent ledger, PE-001 DSAR self-service, EN-024 retention and audit, breach runbook (`10` §12). Then **sell it** — most competitors will be scrambling in 2027; we arrive with it done. Appoint our own DPO and run the DPIA on our own processing before we ask customers to trust us.                                                                                                                   |
| 2   | **Clinical liability** — a defect contributes to patient harm                                                                                                                                                                   | Low × Catastrophic                | The whole of `04` §7 and `09` §10: hard-stops that cannot be configured away, safety test suite on every PR, clinical change control with named sign-off, immutable records, downtime protocol, "advisory only" boundary for AI. Plus professional-indemnity/tech-E&O insurance, contractual limitation of liability, and an incident process that preserves evidence. **Never ship a clinical module to a hospital without its evidence pack.** |
| 3   | **Competitor consolidation** — a Practo/Napier/Attune-scale player or a PE roll-up acquires distribution and undercuts on price                                                                                                 | Medium × High                     | Do not compete on breadth alone. Own trauma/ortho, on-prem and ABDM depth — three things a horizontal consolidator will not prioritise. Sign multi-year terms with the first cohort. Keep the module architecture so a niche can be productised fast.                                                                                                                                                                                            |
| 4   | **AI commoditisation** — ambient scribing and coding assist become a ₹0 feature bundled by every vendor (Aosta already ships "ava" **[Cited]**)                                                                                 | High × Medium                     | Do not build a business on AI features. Build on the **system of record** — data, workflow, safety, integrations — where AI is a layer we can swap. Price AI by usage, not per bed, so commoditisation compresses a small line rather than the core. Our differentiator is that our AI is _governed_: every suggestion traceable, confirmable and auditable.                                                                                     |
| 5   | **Implementation capacity is the growth ceiling**                                                                                                                                                                               | High × High                       | This is the most likely thing to actually limit VIMS. Productise implementation (`13`): templated masters, EN-036 auto-mapping, one-click branch cloning, self-service training. Target ≤ 6 implementation-weeks per 100 beds and measure it. Build the partner channel early. **Refuse deals that exceed capacity** — a failed go-live costs more than the revenue it earns, and in this market the story travels.                              |
| 6   | **Key-person risk** — a small team where one architect holds the design                                                                                                                                                         | High × High                       | Everything in `docs/` exists for this reason: specs, ADRs, module contracts, runbooks, the DoD. Enforce pairing on P0 modules, a documented bus-factor ≥ 2 per domain, no undocumented production access, escrow the source for enterprise/on-prem contracts, and record clinical sign-offs by role, not by person.                                                                                                                              |
| 7   | **Scope creep from bespoke customer demands** (the mechanism that turned several competitors into services companies)                                                                                                           | High × Medium                     | Configuration over code (`CLAUDE.md` §3). Every customer-specific request must become a _configurable capability_ or a priced custom module behind a flag — never a fork. Track "% of revenue from bespoke work" as a leading indicator of drift; above 25 %, stop selling and fix the product.                                                                                                                                                  |
| 8   | **ABDM/NHA specification churn** and certification delay (STQC/CERT-In audit, 4–9 months **[Research]**)                                                                                                                        | Medium × Medium                   | Isolate ABDM behind EN-011/EN-017 adapters so a spec change is a connector change. Start certification early against a real customer's go-live, and budget the audit as a fixed cost, not a surprise.                                                                                                                                                                                                                                            |
| 9   | **Data-migration failure at a flagship account**                                                                                                                                                                                | Medium × High                     | `13` in full: three dry runs, reconciliation to ₹0, written abort criteria, rehearsed rollback. Never compress the dry-run schedule to hit a marketing date.                                                                                                                                                                                                                                                                                     |
| 10  | **Cash-flow shape** — 30/30/30/10 terms **[Cited]** with long implementations                                                                                                                                                   | High × Medium                     | Prefer subscription with quarterly-advance billing; charge implementation with a larger front-loaded share; keep a rolling 9-month runway; do not fund a customer's project with our working capital.                                                                                                                                                                                                                                            |
| 11  | **Hospital-side infrastructure failure blamed on us** (Wi-Fi, power, old PCs)                                                                                                                                                   | High × Medium                     | Contract the hospital's obligations explicitly (`10` §5, §13), validate them before go-live, monitor them (UPS SNMP, Wi-Fi survey, latency from the furthest ward), and report them in the daily hypercare pack so the conversation is factual.                                                                                                                                                                                                  |
| 12  | **Security incident / ransomware** at a customer                                                                                                                                                                                | Medium × Catastrophic             | `04` end to end; immutable off-site backups with separate credentials (`10` §8), tested restores, network segmentation, least privilege, CERT-In 6-hour and DPDP 72-hour runbooks pre-written, and a rehearsed ransomware response.                                                                                                                                                                                                              |

---

## 9. What the source documents reveal — and where this kit extends them

Five observations about the client's own thinking, from the master sheet and the costed proposal:

1. **The client is benchmarking against SMART HMIS.** The 151-module sheet's taxonomy (Core OP Clinical / Core IP /
   Core Non-Clinical / Enabler) and several module names — DIU Utility, TV Output Integration, Gate Pass &
   Bystander Pass, Consignment, Vital Room — match the SMART HMIS profile almost exactly _(inference, but the
   correspondence is too close to be coincidence)_. **[Cited]** for both documents' contents. This tells us the
   ambition (full-stack, multi-branch, enterprise) and the yardstick.
2. **The client already thinks like a product company, not a project shop.** The sheet records that it grew from
   **60 original modules to 151** by deliberately adding 19 OPD, 13 IP, 20 non-clinical, 22 enabler modules and
   three entirely new categories — **Revenue Cycle Management (6), Patient Engagement (5), AI & Advanced Tech (6)**
   **[Cited]**. Creating an RCM category before a customer asked for it is a product instinct.
3. **The trauma/ortho wedge was the client's own insight, and it is the right one.** The "Added Modules
   (Trauma+Ortho)" sheet adds 19 modules with explicit justifications — _"no triage module in original RFQ —
   critical for trauma center accreditation and golden hour compliance"_, _"mandatory for orthopaedic hospitals per
   CDSCO implant traceability guidelines"_, _"original ICU module was basic — enhanced for trauma-grade critical
   care"_ **[Cited]**. This kit takes that instinct and makes it the primary go-to-market wedge (§4, bet 1).
4. **The costing is realistic about effort and honest about exclusions**, which is rare: 2,713 man-days,
   ₹12,000–14,000/day blended, AMC at 15 %, and cloud infrastructure, third-party licences and hardware explicitly
   excluded, with a 5-day-per-batch training allowance **[Cited]**. It is, however, a **build** price for one
   client — §6.1 argues why the same asset must be priced as a product to be a business.
5. **The gaps in the source are platform gaps, not feature gaps.** The 151-list is rich in end-user modules and
   thin on the machinery that makes 151 modules operable by one team: notifications and escalation, a workflow and
   approval engine, a forms/template builder, licence and entitlement enforcement, and group/branch architecture.
   Those are exactly what this kit added.

### 9.1 Cross-walk: 151 → 177

| Source                                                       | IDs in this kit                                                    | Notes                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| VIMS 151-module master sheet                                 | **150 IDs** (origin `X` or `X,C` or `X,M` in `12-module-index.md`) | 1:1 except one source duplication (complaint management appears twice; it is one shared engine exposed as **EN-014** and **NC-032**), and **EN-035** (RIS) which is retained as an ID but merged functionally into **OP-008** + **EN-008** |
| Costed proposal's trauma/ortho additions not in the 151-list | **11 IDs** (origin `C`): **OP-009**, **TR-001**…**TR-010**         | the client's own trauma/ortho extension                                                                                                                                                                                                    |
| Architect additions from this market review                  | **18 IDs** (origin `M` / `Xe,M`) + 1 extension (`X,M`)             | listed below — the count is 18, not 16: `AI-008` and `EN-042` were promoted from the sheet's _enhancement_ column, not from a numbered module. See `docs/14-source-coverage-crosswalk.md` §4.3                                             |
| **Total**                                                    | **177**                                                            | 40 OPD + 11 Trauma/Ortho + 25 IP + 35 Non-clinical + 42 Enablers + 8 RCM + 8 Engagement + 8 AI                                                                                                                                             |

**The 18 additions and why each was added:**

| ID                       | Module                                                       | Why added                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EN-037**               | Notification Centre (push, escalation, on-call routing)      | 151 modules generate alerts; nothing in the source owned delivery, escalation or acknowledgement — and critical-value acknowledgement is a NABH/NABL requirement      |
| **EN-038**               | Workflow & Approval Engine                                   | discounts, refunds, POs, payroll, migrations and blood issue all need maker-checker; without one engine it is reimplemented 20 times inconsistently                   |
| **EN-039**               | Forms & Template Builder                                     | every specialty wants its own form and letterhead; without this, each becomes a code change                                                                           |
| **EN-040**               | Licence & Subscription Management                            | required to sell modules as a product (§6) rather than deliver a bespoke build                                                                                        |
| **EN-041**               | Multi-branch / Group Architecture                            | the source assumed multi-branch but did not own shared MPI, consolidated reporting or branch onboarding — the capability behind the 24-hour branch promise            |
| **RC-007**               | Government Schemes (PMJAY/CGHS/ECHS/ESIC/state)              | a distinct workflow from commercial insurance and a go-to-market wedge (§7); SmartHospital India ships PMJAY **[Cited]**, the source did not                          |
| **RC-008**               | Patient Cost Estimator & Quotation Engine                    | competitor parity (MocDoc's "cost estimation for care" **[Cited]**), a Clinical Establishments Act rate-transparency obligation, and a genuine patient-experience win |
| **NC-034**               | Doctor Fee / Payout & Incentive Management                   | Aosta ships "doctor fee accounting", MocDoc ships "incentive management" **[Cited]**; consultant payouts are a top-three source of hospital admin pain                |
| **NC-035**               | Camp Management                                              | outreach camps are a major mid-market acquisition channel; MocDoc ships it **[Cited]**                                                                                |
| **OP-039**               | OPD Nursing / Injection & Dressing room, Minor OT            | a real, busy, revenue-bearing OPD area with no home in the source                                                                                                     |
| **OP-040**               | Obstetrics & Gynaecology antenatal clinic                    | ANC/EDD/high-risk flags — a large OP volume in most Indian hospitals; the source had labour room (IP-011) but no antenatal clinic                                     |
| **TR-011**               | Trauma Registry & Quality (NTDB-style, M&M, TQIP indicators) | completes the trauma wedge: registry and outcome review are what a trauma-centre designation actually requires                                                        |
| **IP-024**               | Anaesthesia Information System (PAC, intra-op record, PACU)  | the source's OT module stopped at the surgeon; anaesthesia is a separate record with its own legal standing                                                           |
| **PE-006**               | Corporate Client Portal                                      | corporate/B2B is a revenue line the source billed for (NC-012) but gave no self-service surface                                                                       |
| **PE-007**               | Referring Doctor Portal                                      | referral relationships drive mid-market volume; PCS ships referral SMS at registration **[Cited]** — a portal is the strategic version                                |
| **PE-008**               | TPA / Payer Portal                                           | reduces the pre-auth and document-exchange phone traffic that consumes the insurance desk                                                                             |
| **IP-025** _(extension)_ | Bed Management Command Centre / Patient Flow                 | the source had bed management; this adds predicted discharge, housekeeping dispatch and the flow command centre that a 500+-bed hospital actually runs on             |

**What we did not add, deliberately:** blockchain, 3D reconstruction, a separate BI tool, native mobile before the
PWA is proven, and any LLM-first clinical feature ahead of the deterministic rules engine (`CLAUDE.md` §1
non-goals, `02` §6). Each was considered and rejected on the grounds that it adds surface area without adding a
reason to buy.
