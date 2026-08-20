# PHASE 2 — OPD CLINICAL CORE

Phases 0–1 complete. Now the clinical heart of the system. **This phase is patient-safety critical — the rules in
`docs/04-security-compliance.md` §7 are not negotiable.**

## Read first

`CLAUDE.md`, `docs/PROGRESS.md`, then: **OP-002** (OPD/CPOE), **OP-007** (vital room), **EN-029** (CDSS rules
engine), **EN-039** (forms & templates), **OP-019** (doctor PWA), **NC-003** (MRD basics), **EN-027** (clinical
masters), **OP-038** (patient education — hooks only), `docs/06-ui-ux-design-system.md` (patient chart + order
entry archetypes), `docs/04-security-compliance.md` §7.

Plan first; wait for "go".

## Goal

A doctor sees the live queue, opens a patient, reviews history, examines, diagnoses with ICD-10, prescribes safely
(allergy + interaction + dose checks that cannot be bypassed silently), orders investigations, and finishes — in
under three minutes for a routine follow-up, with everything signed, versioned and auditable.

## Deliverables

### 2.1 Clinical masters & terminology (EN-027)

ICD-10 (+ ICD-11 ready), SNOMED CT India subset loader, LOINC (for Phase 3), drug master (generic + brand,
strength, form, route, schedule H/H1/X flags, DPCO ceiling price, HSN, GST), allergen master, symptom/complaint
master, examination templates, diagnosis favourites, order catalogue, dose reference tables (adult/paediatric
weight-based, renal/hepatic adjustment), instruction/advice library, clinical form templates via EN-039.

### 2.2 Vital room (OP-007)

Nurse worklist from the queue, structured vitals (BP, pulse, temp, RR, SpO₂, height, weight, BMI, GRBS, pain
score, LMP), paediatric growth percentile, device capture stub (EN-042 later), abnormal-value flagging with
configurable thresholds by age, **auto-alert to the doctor for red-flag vitals**, allergy & current-medication
reconciliation, triage note, and hand-back to the queue. Tablet-first UI, ≤ 45 seconds per patient.

### 2.3 Encounter & consultation (OP-002)

- Encounter lifecycle (start/pause/resume/complete/cancel) with a hard link to the queue and to billing charges.
- Doctor dashboard: live queue cards showing token, name, age/sex, vitals with abnormal flags, wait time, visit
  type, payer, alerts; keyboard navigation; one-key "start consultation".
- Consultation workspace: chief complaints (quick-pick + free text), history (past/family/personal/medication/
  allergy), examination (structured per specialty via EN-039 + free text), **diagnosis with ICD-10 search**
  (primary/secondary, provisional/final, severity, laterality), treatment plan, advice, follow-up scheduling,
  certificates (fitness, sick leave, referral letter) from print templates.
- **Clinical notes are versioned and signed** (hash chain per `docs/03` §Table rules); amendments create versions
  with reason; nothing is overwritten.
- Patient timeline: every past visit, diagnosis, prescription, result, document — filterable, fast, lazy-loaded.
- Templates & favourites: doctor-level consultation templates, order sets, Rx combos; one-click apply; sharing
  within a department with approval.
- Co-sign workflow for residents/interns.

### 2.4 e-Prescription with real safety (OP-002 + EN-029)

- Drug search (generic/brand, ≤ 100 ms), structured Rx lines (drug, strength, dose, route, frequency, duration,
  quantity, instructions, PRN, taper), auto-quantity calculation, substitution policy, favourites.
- **CDSS rules engine (EN-029) built properly now — deterministic, not AI:** allergy match (ingredient + class),
  drug–drug interaction with severity, duplicate therapy, dose range incl. paediatric mg/kg and renal adjustment,
  max daily dose, pregnancy/lactation category, geriatric (Beers) cautions, Schedule H1/NDPS guardrails,
  drug–disease contraindication, drug–lab (e.g. potassium with renal impairment).
- **Alert presentation:** hard-stop (cannot proceed — the list in `docs/04` §7 that config can never disable),
  soft-stop (override with mandatory reason from a coded list), passive (inline). Every fired and overridden alert
  is stored with the reason. Alert-fatigue metrics (alerts per 1000 orders, override rate) on day one.
- Rx output: printable letterhead PDF, digital signature, push to pharmacy queue (Phase 4 consumes it; emit the
  event now), patient copy via WhatsApp/portal, ABDM Prescription bundle shape prepared (sent in Phase 11).

### 2.5 Order entry (CPOE)

Lab, radiology, procedure, therapy, diet and nursing orders with priority (routine/urgent/STAT), clinical
indication, fasting/prep instructions, order sets, standing orders, cancellation with reason, and status tracking
back on the doctor's screen. Orders create **charge intents** (Phase 5 turns them into bill lines) and emit
`order.placed`.

### 2.6 Doctor PWA (OP-019, PWA stage)

Installable, offline-tolerant view of queue + patient summary + results; quick Rx from phone with the same CDSS
running server-side; push notifications for critical results and escalations; biometric unlock (WebAuthn);
consultation drafts sync with conflict rules from the spec.

### 2.7 MRD foundation (NC-003)

Every encounter creates a medical record entry; document attachment (scan/upload) with OCR text index; coding
queue for MRD staff; deficiency checks (missing diagnosis, unsigned notes); retention policy config; medico-legal
flag that blocks deletion and requires dual approval.

## Constraints & watch-outs

- **A doctor must never be forced to wait for the system.** Every screen in the consultation loop is prefetched
  when the token is called. Measure and prove it.
- CDSS evaluation runs inside the prescribe transaction and must complete in < 100 ms p95; if the rules service
  fails, **fail closed on hard-stop categories** (block and tell the user) and log.
- Do not build any AI here. Rules only. AI-002 layers on this in Phase 12.
- Clinical text fields: no truncation, no silent loss, autosave drafts every 5 s to local + server.

## Exit gate

1. Full consultation for a follow-up patient in ≤ 3 minutes with keyboard only; for a new patient in ≤ 6 minutes.
2. Prescribe a drug the patient is allergic to → **hard stop**; prove in a test that no configuration flag can
   disable it. Prescribe an interacting pair → soft stop with mandatory coded reason, recorded and reportable.
3. Paediatric dose check catches a 10× overdose; missing weight blocks paediatric dosing.
4. Amend a signed note → new version, old version intact, reason captured, audit chain valid.
5. Order a lab + radiology test; `order.placed` events land; charge intents created (verify in the DB).
6. Patient timeline loads 5 years of history in < 1 s p95 (k6 committed).
7. Doctor PWA works offline for viewing, queues a draft note, and syncs cleanly with a simulated conflict.
8. Alert-fatigue dashboard shows override rate; a deliberately noisy rule can be tuned without a code change.
9. All previous gates still green; `docs/PROGRESS.md` + `docs/DECISIONS.md` updated (especially the drug-knowledge-
   base licensing decision from EN-029 §16).
