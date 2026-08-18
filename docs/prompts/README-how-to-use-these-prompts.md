# How to use the phase prompts

## The loop

1. Open Claude Code in the repo root (with `CLAUDE.md` and `docs/` present).
2. Paste the **entire contents** of the next `phase-NN-*.md` file as your message. Nothing else.
3. Claude Code will read the referenced specs, plan, and build. Answer its questions from §16 of the module specs
   ("Open Questions for the Hospital") — if you do not know an answer, tell it to use the stated default and record
   the assumption in `docs/DECISIONS.md`.
4. When it reports the phase complete, run the **Exit gate** at the bottom of that prompt yourself:
   `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build`, then click through the demo script.
5. Only then move to the next phase. Never run two phases in one session.

## Rules that make this work

- **One phase per session.** Context stays clean; the model can hold the whole phase.
- **If a session gets long or confused, stop.** Ask Claude Code to update `docs/PROGRESS.md` with exactly where it
  is, then start a fresh session with: *"Read CLAUDE.md and docs/PROGRESS.md. Continue phase N from where it stopped."*
- **Never let it skip tests or the Definition of Done** (`docs/09-quality-gates-and-testing.md`). If it says
  "tests can be added later", reply: *"No. Definition of Done applies. Write the tests now."*
- **Big phases are split into steps** inside the prompt. It is fine — and often better — to paste one step at a time
  for the largest phases (7 has steps 7A–7G, 9 has steps 9A–9E).
- **Feature flags:** every module ships behind `module.<key>.enabled`. A half-built module must never be reachable
  by a real user.
- **Before Phase 6+, seed real hospital data** (departments, doctors, tariffs, drug master) via `pnpm seed:hospital`
  so what you demo looks real to clinicians.

## Sequencing at a glance

| Phase | Prompt file | Typical span for 1–3 devs + Claude Code | Gate to next phase |
|---|---|---|---|
| 0 | `phase-00-foundation.md` | 2–3 weeks | login works, tenant isolation proven, CI green |
| 1 | `phase-01-patient-front-office.md` | 3–4 weeks | a patient can be registered, booked, tokened, paid, messaged |
| 2 | `phase-02-opd-clinical-core.md` | 4–5 weeks | a doctor can run a full consultation with e-Rx and orders |
| 3 | `phase-03-diagnostics.md` | 4–6 weeks | lab order → result → validated report → critical alert; PACS viewing |
| 4 | `phase-04-pharmacy-stores.md` | 4–5 weeks | Rx dispensed with batch/expiry; stock moves and reconciles |
| 5 | `phase-05-billing-rcm.md` | 4–6 weeks | tariff-driven bill, GST invoice, payment, refund, pre-auth |
| 6 | `phase-06-emergency-trauma-ortho.md` | 4–6 weeks | triage → trauma activation → MLC → fracture/implant traceability |
| 7 | `phase-07-inpatient.md` | 8–10 weeks | admit → nurse → OT → ICU → discharge with correct final bill |
| 8 | `phase-08-specialty-consoles.md` | 6–8 weeks | specialty consoles live behind flags |
| 9 | `phase-09-erp-non-clinical.md` | 8–10 weeks | purchase-to-pay, HR/payroll, assets, support services |
| 10 | `phase-10-engagement-portals.md` | 4–6 weeks | patient portal, feedback, follow-up, website, kiosk |
| 11 | `phase-11-analytics-interoperability.md` | 6–8 weeks | MIS, report builder, FHIR APIs, ABDM M2/M3, NHCX |
| 12 | `phase-12-ai-advanced.md` | 6–8 weeks | AI features behind evals + human-in-the-loop |
| 13 | `phase-13-native-mobile.md` | 6–8 weeks | Expo apps for doctor, nurse, patient, staff |

Spans assume the specs are followed, not re-litigated. A hospital can go live for OPD after Phase 5 and for
full IP after Phase 7 — Phases 8–13 are release trains on a running system.

## Minimum viable go-live (if you need a date)

**OPD-only go-live:** Phases 0–5 + EN-006/EN-018 (queue + displays) + NC-001 (cash) + EN-009 (SMS/WhatsApp).
**Full hospital go-live:** add Phases 6–7 and EN-002/RC-002 (insurance), NC-005/NC-006 (purchase/stores),
NC-003 (MRD), NC-016 (BMW), EN-022 (backup/DR), EN-024 (audit).
Everything else can follow the hospital live, module by module, behind flags.
