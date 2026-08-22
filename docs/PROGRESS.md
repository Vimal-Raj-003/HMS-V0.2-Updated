# PROGRESS

> Claude Code updates this file at the end of **every** working session. Newest entry on top.
> Format: date · phase · what was built · what was tested · what is stubbed · open questions · next step.

## Current state

| Field              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current phase      | **Phase 3 (Diagnostics) — schema only, no API and no screens.** Phase 1 is functionally complete with gates 6, 7 and 8 unmet; Phase 2's API and screens are complete, with gates 1, 6 and 7 and the tuning half of 8 unmet and gate 9 blocked on O-1.                                                                                                                                                                                                                                 |
| Repo status        | **423 application tables** across ten tenant schemas (`core` 141, `clinical` 67, `mdm` 49, `lab` 41, `rad` 36, `integration` 29, `patient` 19, `billing` 18, `engage` 13, `queue` 10) — 667 relations once the 244 monthly partitions are counted. **14 migrations**, all applied to a real container. 4 idempotent seed tiers. **125 API route handlers across 33 controllers**; **24 Next.js pages**.                                                                               |
| Last green CI      | **Not green.** `pnpm test` — **2,240 unit tests across 13 packages**, all passing; `@vims/realtime`'s coalescing-emitter budget test is wall-clock-sensitive and flaked once under parallel load (green on its own re-run). `pnpm test:integration` is **red**: `@vims/worker`'s partition-maintenance job knows 17 of the 35 partitioned tables the migrations declare. `pnpm exec prettier --check` clean.                                                                          |
| Modules complete   | **0 / 177** to the Definition of Done in `CLAUDE.md` §7 — no module yet has its k6 script or its full e2e golden path. Functionally complete and wired end to end: **OP-001** (patient/MPI/dedupe/merge), **EN-006** (queue/token/TV board), **NC-001** (cash counter), **EN-027** read half, **OP-007** (vitals), **OP-002** (encounter/timeline/CPOE), **EN-029** evaluation half. Phase 3 is schema and seeds only for **OP-004, OP-008, EN-004, EN-008, EN-031, EN-035, OP-022**. |
| Blocking questions | **O-1 now blocks Phase 2's exit gate 9** (which names it), O-2 blocks Phase 1 gate 3, O-4 blocks Phase 1 gate 6, and the new **O-12** (analyzer and PACS vendor inventory) blocks every Phase 3 gate that touches a device. See `docs/DECISIONS.md` → "Open" for O-1…O-12.                                                                                                                                                                                                            |
| Project path       | `~/Desktop/Test/HMS/vims-hms-build-kit` (renamed — see D-19)                                                                                                                                                                                                                                                                                                                                                                                                                          |

The table counts, RLS coverage and migration state above were read out of a live container at this session's HEAD, not copied from a commit message: `core.v_rls_coverage` reports **423 monitored tables, 0 without RLS, 0 without a policy, 0 without a write check**, and the only deliberately-open policies remain the two catalogues (`core.permissions`, `core.setting_definitions` — D-17).

### Exit-gate status — Phase 1 (`docs/prompts/phase-01-patient-front-office.md`)

Phase 0's eight gates were all met on 2026-08-20 (see that session entry), but **gate 1 of Phase 0 is amber again**: `test:integration` is failing (see below).

| #   | Gate                                                                                            | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Register 3 patients end-to-end; UHID card and wristband print                                   | 🟨 **partial.** Registration, UHID allocation (proven under concurrency), the duplicate hard stop and the registration desk screen all work. The **wristband** ZPL template exists; there is **no UHID-card template**, no QR (EN-013 owns the encoding), and `POST /patients/{id}/photo` is specified but not implemented, so the card could not carry a photo either.                                                                                                                                                                                                                                                                                                                                                |
| 2   | A deliberate duplicate is caught; a merge is performed and fully audited; nothing is lost       | 🟩 **met.** The hard stop needs `patient.record.create_override` plus a reason; a blocked create leaves zero patient rows, zero audit rows and zero outbox events. Merge repoints reversibly, records the exact row ids moved, keeps the victim UHID searchable and never reissues it. 64 integration tests.                                                                                                                                                                                                                                                                                                                                                                                                           |
| 3   | Book / reschedule / cancel an appointment; patient gets all three messages; status shown        | 🟨 **partial.** All three transitions work in the API and in the appointment book. The connectors render, refuse a template carrying clinical content (D-34) and gate on consent/DND — but **no real provider is connected (O-2)** and template, consent, cost and provider-id state are all in-memory, so nothing is delivered and no delivery status is shown.                                                                                                                                                                                                                                                                                                                                                       |
| 4   | Walk-ins and appointments interleave in the queue; TV board calls with audio; room display < 1s | 🟨 **partial.** Queue API, queue console and TV board are built; audio announces English first and never disableable, then the hospital's language, only for `called` and `recalled`, with no patient identifier reaching the board (asserted three ways). The **< 1 s room-display latency has never been measured.**                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | Cashier opens a shift, takes split payment, refunds with approval, closes with zero variance    | 🟩 **met.** Money is bigint minor units end to end with no `Number()` on the client path; §269ST is enforced as `>=` ₹2,00,000 on the payer/day/event aggregate with no retry affordance; refunds and voids never restore headroom; refund and void go through the co-sign service. Mutation-checked.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | ABHA created via mobile OTP in sandbox and linked; scan & share works                           | ⬜ **not started** beyond schema. Blocked on **O-4** (sandbox credentials, HFR facility IDs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7   | 1 M-row patient search under 200 ms p95 (k6 script committed)                                   | 🟨 **partial — the script exists and has never been run; k6 is not installed on this machine.** The D-37 prefix fix landed and is measured as `hms_app` with a complete tenant context: mobile 79.5 → **0.035 ms**, UHID 80.3 → **0.042 ms**, identifier 49.4 → **0.035 ms** at 176,000 rows in-tenant, row counts identical before and after. **The trigram half of D-37 is unfixed and cannot be fixed without `LEAKPROOF`** — of the eight operators `gin_trgm_ops` serves only `=` is leakproof, so no fuzzy index is reachable under RLS at all. Name search stays at ~148 ms per 176,000 rows: inside the class-F 400 ms budget of `docs/07 §2.1`, not at OP-001 §13's 3 M patients. Never measured at 1 M rows. |
| 8   | Kill the SMS provider and the internet: registration, tokens and cash still work                | ⬜ **never exercised.** The design supports it — nothing on the queue or cash path imports a flag or an entitlement, and a test asserts that — but no run has been done, and "messages queue and flush on recovery" has no store to queue into while the messaging state is in-memory.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 9   | All Phase-0 gates still green; `docs/PROGRESS.md` updated                                       | 🟨 **partial.** This file is updated. Phase-0 gate 1 (`lint · typecheck · test · e2e · build`) is **not** green: `pnpm test:integration` fails on partition maintenance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Exit-gate status — Phase 2 (`docs/prompts/phase-02-opd-clinical-core.md`)

| #   | Gate                                                                                                                                                | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Consultation in ≤ 3 min (follow-up) / ≤ 6 min (new), keyboard only                                                                                  | ⬜ **not measured.** The screens exist and carry the mandated hotkeys; no timed run has been done, with a keyboard or otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 2   | Allergic drug → hard stop, proven undisableable by configuration; interacting pair → soft stop with mandatory coded reason, recorded and reportable | 🟨 **first half met and over-proved; second half partial.** `clinical.cdss_safety_floor` has no `active`, `status`, `effective_to` or `hospital_id` column, `hms_app` holds no INSERT/UPDATE/DELETE on it, and the migration reads `information_schema` and **fails** if that table ever acquires a switch-shaped or tenant-scoped column — so a later phase adding `cdss_safety_floor.enabled` does not ship. `cdss_rules.enforces_floor_key` closes the reimplement-and-disable hole. `evaluateSafetyFloor(input)` takes clinical facts only, so there is nowhere to pass a switch, and `applyTuning` throws if a floor alert reaches it. 26 safety tests; **23 fail under deliberate sabotage**. The soft-stop half is tested and works against the seeded rules, but a soft stop fires only where the tenant holds an active rule version and **there is no rule-catalogue API** — no route creates, versions, tunes or retires a `clinical.cdss_rules` row — so a hospital cannot reach a family the seed did not ship. |
| 3   | Paediatric dose check catches a 10× overdose; missing weight blocks paediatric dosing                                                               | 🟩 **met**, at the storage layer as well as the service: `prescription_items` cannot hold a `per_kg` line without a positive `weight_used_kg`, which also covers the offline replay path where a service-layer check would simply be absent. `encounters.dosing_weight_source` defaults to `unknown` and the weight is CHECKed ≥ 0.3 kg, so zero is unrepresentable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | Amend a signed note → new version, old version intact, reason captured, audit chain valid                                                           | 🟩 **met.** `seal_document_version()` computes the content hash from the content and takes the previous hash from the actual preceding row — neither is accepted from the caller — so the chain cannot be forged or re-linked; UPDATE after `draft` and DELETE are both refused and revoked.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 5   | Order a lab + radiology test; `order.placed` lands; charge intents created (verified in the DB)                                                     | 🟩 **met.** `charge.intent.created` carries the whole bill line (service, description, quantity, unit price, amount, currency, source row) as decimal strings, so Phase 5 billing never reads back into the clinical schema. An imaging order with no indication or pregnancy status is refused.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | Patient timeline loads 5 years of history in < 1 s p95 (k6 committed)                                                                               | 🟨 **partial.** The plan was measured as `hms_app` with the tenancy GUCs set (not as `hms_migrator`, whose ownership bypasses the policy and produces a plan the application never runs): **0.63 ms for page 1** over 5 years. **No k6 script exists** — `perf/` holds only `patient-search.k6.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 7   | Doctor PWA works offline for viewing, queues a draft note, syncs with a simulated conflict                                                          | 🟨 **partial.** Offline read is an explicit hospital+user-namespaced, age-capped local copy, read only after a network read failed and always shown behind a "From this device, captured N min ago" badge — `sw.ts` keeps every `/api/` route NetworkOnly, because stale data is indistinguishable from fresh. The draft outbox keeps the encounter version it was written against and the badge says "not on the server", never "saved". The conflict path is covered by unit tests and **has not been exercised against a running server**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 8   | Alert-fatigue dashboard shows override rate; a deliberately noisy rule can be tuned without a code change                                           | 🟨 **partial.** The dashboard is built and `GET /cdss/reports/alert-fatigue` reports the override rate by coded reason. **The tuning half is unmet:** with no rule-catalogue API, changing a rule today means a new seed or a new migration — which is exactly the code change the gate forbids.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 9   | Previous gates green; PROGRESS + DECISIONS updated, **especially the drug-knowledge-base licensing decision** (EN-029 §16)                          | ⬜ **unmet.** DECISIONS is current as of this session, but the gate names the licensing decision specifically and **O-1 is still unanswered**. It is no longer theoretical: `clinical.cdss_kb_dose_rules` holds 8 rows and **0 of them carry `max_course_days`**, so NDPS statutory caps are not seeded and a controlled drug hard-stops with "no statutory cap configured". Inventing "7 days" would be worse than the refusal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Also on the Phase 2 path, now fixed but worth recording: **Schedule X / NDPS prescribing was impossible until `e308f73`.** `rx.schedule_x.prescribe` is `requiresSecondPerson`, and `PolicyService.assert()` had no way to pass a second-person id, so the key denied every caller including the one entitled to act. The same defect blocked paying a refund, voiding a receipt and clearing a CDSS hard stop; two modules had independently built workarounds for it.

### Exit-gate status — Phase 3 (`docs/prompts/phase-03-diagnostics.md`)

Phase 3 is **schema, seeds and database-enforced safety properties only**. There is no `lab` or `rad` module in `services/api` and no diagnostics feature in `apps/web`. As of this session's HEAD (`f7ff03c`) `packages/contracts` also registers **no Phase-3 permission keys and no Phase-3 domain events** — so a Phase-3 route could not load even if one existed, because `assertRegisteredPermission` runs at module import. (An uncommitted working-tree change is adding the OP-004, OP-008, OP-022, EN-004, EN-008 and EN-031 permission groups at phase 3; nothing of it is committed, and no number in this file includes it.)

| #   | Gate                                                                                                                          | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Order → label → double-scan collection → accession → analyzer result → auto-validate → report PDF with QR → timeline + portal | ⬜ **not started.** Every table on that path exists; nothing drives it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2   | Critical potassium alerts the ordering doctor, escalates when unacknowledged, call-back documented, reportable for NABL       | 🟨 **the database half is done, and it is the strongest thing in the phase.** The alert is raised **by a trigger in the same transaction as the value**, so no code path can store a critical potassium without an outstanding alert. Authorisation — not storage, not visibility — requires a callback row whose CHECK makes both "neither" and "both" unstorable: either a read-back with a named recipient and the value repeated, or an unreachable-clinician escalation with a level and a role. An order cannot close over an open critical. That is **D-10 encoded rather than documented**. Escalation, notification and the NABL report all need the API that does not exist. |
| 3   | Hemolysed sample rejected with reason; doctor and patient notified; recollection tracked                                      | 🟨 **schema only.** Rejection reasons and recollection are modelled, and "a rejected sample can never carry a result" is enforced. No notification, no screen.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 4   | Westgard 1-3s violation blocks the run and requires corrective action before release                                          | 🟨 **schema only, but the property that matters holds.** The QC state defaults to `never_evaluated`, the release predicate is a **whitelist**, a missing row returns `never_evaluated` rather than NULL, and the migration asserts the predicate answers false for it — `unknown` is not `passed`. 12 Westgard rules seeded. No API.                                                                                                                                                                                                                                                                                                                                                   |
| 5   | CT reaches Orthanc, appears on MWL first, viewed in OHIF with a prior, dose recorded, report signed                           | ⬜ **not started.** `rad.pacs_*` is an archive index; no Orthanc, no OHIF, no MWL publisher. Blocked on **O-12**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 6   | Obstetric ultrasound cannot be saved without Form F; no sex-determination field anywhere                                      | 🟩 **met at the schema level — the one Phase-3 gate claimable today.** No obstetric ultrasound completes or signs without a complete Form F, and the migration asserts that no column or enum label anywhere matches a foetal-sex pattern, then **self-tests that the pattern still fires on `foetal_sex` and does not fire on `patient_sex_dicom`** — the first regex written matched that DICOM-mandated field and failed the migration, which is precisely the near-miss the self-test now prevents.                                                                                                                                                                                |
| 7   | Analyzer disconnected 30 minutes → messages buffer and replay with zero loss; unmatched queue works                           | ⬜ **not started.** `lab.lab_if_messages` and the unmatched queue exist; there is no listener, no simulator and no replay. Blocked on **O-12**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 8   | 20 000 results/day load test within the `docs/07` budgets; report PDF < 3 s p95                                               | ⬜ **never run.** No k6 script for it, and no PDF pipeline for a lab or radiology report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | Previous gates green; PROGRESS updated with the analyzer inventory still to be interfaced                                     | 🟨 **partial.** This file is updated; previous gates are not all green. **The analyzer inventory itself is not recorded because nobody has supplied it — that is O-12.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## Session log

### 2026-08-22 · Phases 1–3 · Front-office API and screens, OPD clinical core, and the diagnostics schema

Thirty-two commits since `9d9d57d`. Most of the work was done by agents scoped to a code directory, so none of them could touch this file or `DECISIONS.md`; this entry is that backlog, and every number in it was re-measured this session rather than copied from a commit message.

**Built — Phase 1 (completing it)**

- **Patient master / MPI** — register, search, read with banner, amend, demographic history, dedupe queue, merge and unmerge. UHID is allocated from `NumberingService` inside the registering transaction. **Aadhaar is deliberately not accepted in any form**: the schema requires `aadhaar_hash` alongside `aadhaar_last4` and specifies that hash as SHA-256 over a per-hospital pepper — but no such key exists, and an unpeppered SHA-256 of a twelve-digit number is exhaustively invertible in seconds, so computing one would be storing Aadhaar with an extra step.
- **Appointments, doctor schedules and OP visits** — slots are materialised at publish rather than computed on read, because you cannot take a row lock on arithmetic. Check-in creates the visit and issues the queue token in one transaction.
- **Queue / tokens and cash counter** — call-next takes the head with `FOR UPDATE SKIP LOCKED`; the board returns token, room and counts only. §269ST was **wrong in the brief and is corrected**: the section forbids receiving "two lakh rupees _or more_", so ₹2,00,000 is itself a breach and the comparison is `>=`.
- **Master-data listing endpoints (EN-027)** — eleven read-only cursor-paginated routes. Their absence had already shaped the UI: with no `GET /doctors`, `/queues` or `/cash/counters`, three screens had fallen back to asking a receptionist to paste a UUID.
- **Idempotency** — `core.idempotency_keys` had existed since Phase 0 with every column, RLS, grants and a retention policy, and had never been written to. A receptionist double-clicking Register created two patients.
- **Screens** — landing page, registration desk, patient 360, merge tool, appointment book, queue console, cash counter, and the TV board's audio.
- **Contracts** — `visit.transferred` and six queue-token lifecycle events (held, resumed, activated, cancelled, no_show, expired). Their absence had changed behaviour, not merely limited it: the queue module had dropped the `awaiting_payment` path entirely and refused a duplicate issue with a 409 instead of EN-006 §5's "re-issue cancels the previous one".

**Built — Phase 2**

- **Schema** — 58 tables across vitals, encounters, prescriptions, orders, CDSS and MRD. Four safety requirements are carried by the database rather than by a service that could be bypassed: the allergy hard stop has nowhere to store an off switch, a finalised note cannot be rewritten, a paediatric dose cannot be computed from a weight nobody recorded, and every override is coded and append-only.
- **Contracts** — 83 permission keys and 51 events. `cdss.evaluate`, `cdss.alert.read` and the allergy path are `clinicalSafetyExempt`: a hospital with an unpaid invoice must still get its allergy hard stop, so a licence gate there would be a patient-safety defect rather than a commercial control.
- **Vitals room and encounter API** — no threshold is compiled in; NEWS2 is scored only when all five components are present, because a partial score reading "low risk" is the dangerous failure; a correction is an insert that supersedes rather than an edit.
- **e-Prescription and CDSS** — the floor runs first and outside every `try`. A vendor knowledge-base failure degrades only vendor-dependent checks (D-9); the local formulary failing is fail-closed with a 503, never a pass. Evidence commits **before** the refusal, in its own transaction, so the alert row survives the 422 that reports it.
- **Screens** — vitals room, doctor console, e-prescription and the alert-fatigue dashboard. A hard stop is enforced by **not rendering the control**: when the CDSS blocks, the Prescribe button does not exist and a red card stands in its place, and the tests assert no button anywhere matches `/anyway|override|proceed|continue|force|ignore|bypass|dismiss/`.
- **`PolicyService.assert()` can finally carry a second person** (`e308f73`). Until then every `requiresSecondPerson` key denied every caller.

**Built — Phase 3**

- **Schema only**: 100 tables across two new schemas (`lab`, `rad`) plus additions to `mdm`, `integration` and `clinical`, in an 8,176-line migration with 26 triggers. Results are hash-chained and append-only; the QC release predicate is a whitelist; the critical-value alert is raised by a trigger in the same transaction as the value; PC-PNDT is enforced by a migration-time assertion over `information_schema`.

**Tested**

- `pnpm test`: **2,240 unit tests across 13 packages** — web 516, contracts 428, api 305, integration-hub 214, ui 203, db 141, tv-kiosk 98, i18n 71, worker 71, realtime 66, print-templates 59, flags 40, testing 28.
- `pnpm test:integration`: api 345, testing 50 (including 26 Phase-2 safety tests and 3 Phase-1), integration-hub 43, worker 38 of 39, realtime 7.
- 54 Playwright e2e declarations across 7 spec files; not re-run this session.
- Verified against a live container at HEAD: 14 migrations applied, **423 monitored tables, 0 without RLS, 0 without a policy, 0 without a write check**.

**Red, and honestly red**

- **`pnpm test:integration` fails.** `@vims/worker`'s partition-maintenance job maintains 17 tables; the migrations declare **35** partitioned. The 18 it does not know about are every partitioned table added in Phases 1–3: `billing.payments`, `billing.cash_drawer_events`, `clinical.vitals`, `clinical.cdss_alert_events`, `clinical.cdss_scores`, `core.mobile_sync_log`, `engage.msg_events`, `engage.msg_messages`, `integration.abdm_messages`, `integration.lab_if_messages`, `lab.lab_results`, `lab.lab_result_versions`, `lab.labq_qc_runs`, `patient.consent_ledger`, `queue.queue_tokens`, `queue.queue_events`, `rad.pacs_instances`, `rad.pacs_view_audit`. The test is the one that was written to catch exactly this. Nothing has broken yet because each migration premakes several months ahead; it breaks silently, later, in a running hospital.
- **`@vims/api`'s integration run exits non-zero even though all 345 tests pass** — ten unhandled `57P01` errors as the Testcontainers database is torn down under still-connected pool clients.
- **`@vims/realtime`'s coalescing-emitter budget test is wall-clock-sensitive** (`expected 176 to be greater than 176.7`) and flaked once under parallel load; green on its own re-run. A test that fails on a busy laptop will fail in CI.

**Stubbed / not done**

- **Phase 3 has no API and no screens, and at HEAD no contracts either.** Schema and seeds only. Phase-3 permission keys and events are being added in the working tree and are not committed.
- Messaging template, consent, cost and provider-id state remain **in-memory**; the `engage` tables exist and are unused by the connectors.
- ABDM M1 remains schema-only (O-4).
- `POST /patients/{id}/photo`, consent capture and the bulk legacy import (EN-036) are specified and unimplemented; the registration desk deliberately does not offer photo or consent capture rather than discarding what a clerk enters.
- **No k6 script has ever been executed** — k6 is not installed here. `perf/` holds one script, `patient-search.k6.js`; Phase 2's timeline gate and Phase 3's 20,000-results gate have none at all.
- Phase 1 exit gate 8 (kill the SMS provider and the internet) has still never been exercised.
- `pnpm boundaries:check`, `permissions:check` and `specs:check` point at three scripts that do not exist and are not in CI — dead configuration.

**Open questions**

- **O-1 (drug knowledge base) is now blocking**, not prospective: Phase 2's exit gate 9 names it, and `clinical.cdss_kb_dose_rules` carries 8 rows with 0 `max_course_days`, so every controlled drug hard-stops with "no statutory cap configured".
- **O-12 is new**: the analyzer and PACS inventory. Phase 3 gates 1, 5 and 7 cannot be attempted without it, and gate 9 asks for the inventory by name.
- **`notification.read|ack` is required by OP-019 and cannot be added.** EN-037 registers seven `notify.*` keys — admin, escalation and report — and nothing for "a user reads their own notification". It cannot be added as a Phase-2 key because `registry.spec.ts` lists EN-037 among the phase-0 modules and forces its keys to phase 0. Someone must close this inside EN-037.
- **A pre-existing SoD violation stands**: the `privacy_officer` template grants both `audit.export` and `audit.config.manage`, which the catalogue's own rule marks `mode: 'block'` ("whoever can change what the audit log records must not also be the person who produces evidence from it", EN-024 §5). The new Phase-2 assertion is scoped to Phase-2 rules precisely because a global one fails on Phase 0 today. **Either the DPO grant or the rule is wrong, and nobody has decided which.**
- `EN-009 §4.1` still contradicts `§5` (D-34) and still needs correcting. `EN-029 §4` contradicts `§5` (D-42). `EN-004 §4` and `EN-031 §4` both claim the QC tables (D-38). `OP-008 §4` and `EN-035 §4` disagree on what a study is called (D-39).
- O-3, O-5 and O-7 are unchanged. **O-2, O-4 and O-8 have had their "needed by" sharpened rather than answered**: O-2 and O-4 now block a named Phase-1 gate, and O-8 is no longer prospective — 22 of the 26 seeded diagnostics tests already carry a LOINC code.

**Next step**

Two things before any new Phase-3 code. First, fix the partition-maintenance registry — it is the only currently-red test and it degrades silently in production. Second, get an answer on O-1, because Phase 2 cannot exit without it and NDPS caps cannot be invented. Then Phase 3's contracts (permission keys and events, which must land before any route can even load), then the LIS API, then the RIS/PACS work once O-12 is answered.

### 2026-08-21 · Phase 1 · Contracts, schema, clinical components, messaging, numbering

**Built**

- **Phase 1 permission catalogue and role grants** (`packages/contracts`). +95 keys across `patient.*`, `appointment.*`, `visit.*`, `schedule.*`, `queue.*`, `receipt.*`, `messaging.*`, `abdm.*`, `consent.*`, granted across 22 of the 64 role templates. Without this every Phase 1 route would have failed _at module load_ — `assertRegisteredPermission` runs on import.
- **Phase 1 domain events** — the registry had none, and the outbox writer validates against it, so every Phase 1 publish would have been refused. 286 events registered. Money in an event payload is a decimal string, never a number: `Money` is bigint minor units and an event is JSON, so a number round-trips through IEEE-754 and ₹1,234.55 arrives as 1234.5499999999999.
- **Phase 1 schema** (`packages/db`) — 93 tables across `mdm`, `patient`, `clinical`, `queue`, `engage` plus `billing` and `integration`, one migration of 4,951 lines, 8 tables partitioned monthly. Verified against a real container: **415 tables in the business schemas, 0 without RLS or a policy**.
- **12 clinical components** (`packages/ui`) — patient search, worklist, slot picker, queue tiles and TV board, denomination sheet, consent capture, allergy editor, address form, photo capture, print preview. 74 → 203 tests.
- **Messaging connectors** (`services/integration-hub`) — MSG91, Twilio, WhatsApp Cloud, dry-run; TRAI-DLT registry; consent/DND gate. 214 unit + 43 integration tests.
- **Admin console** (`apps/web`) — 8 screens, permission matrix over 212 keys × 64 roles. 106 vitest + 34 Playwright, axe clean on all eight.
- **Numbering service** (`services/api`) — UHID, visit, appointment, bill and receipt numbers. The tables existed and were seeded in Phase 0 but nothing allocated from them, which blocked every Phase 1 write path.

**Tested**

1,429 unit tests across 13 packages, all green, plus the integration suites. `prettier --check` passes for the first time.

**Defects found by running, not by reading**

- **The RLS coverage monitor was scoped to three schemas.** 93 tables in five new schemas would have been invisible to the very view that exists to catch an unprotected table. Widened before the policies were generated, and the migration now raises if any table lacks RLS.
- **Two tests that could not fail.** The seed-idempotency check digested only `('core','mdm','integration')` and ran the `minimal` tier, which seeds no Phase 1 rows — between them, a seed rewriting 220,000 patient rows on every run would have passed. Now covers all eight tenant schemas on the `demo` tier, and asserts which tables it covered so a future narrowing fails loudly.
- **The CI static job could never have passed.** It runs `prettier --check` over `**/*.yaml`, which matches the Helm chart templates — Go templates, not YAML. Prettier reported a _parse error_ and exited non-zero regardless of formatting, so no amount of `--write` would have fixed it.
- **`@vims/i18n` shipped TypeScript** (D-36). Typechecked and passed every vitest run; only a real Node runtime failed.
- **The toast viewport had `aria-label` on a role-less `<div>`**, which ARIA prohibits — so a container carrying critical clinical alerts announced as nothing. The existing axe test rendered the toast _item_ alone; the viewport was never tested.
- **`patient.patients` had no allergy statement column**, so zero allergy rows read as "safe to prescribe" when it may mean "nobody asked". Added with three CHECKs and a trigger whose invariant is that no sequence of deletions can ever produce `none_known`.

**Stubbed / not done**

- Messaging template, consent, cost and provider-id state are in-memory. The `engage` tables now exist, so the connectors can be repointed at them, but until then none of it survives a restart.
- Patient search is benchmarked at 220,000 rows, not the 1,000,000 the exit gate specifies. Worst p95 is 1.7 ms against a 200 ms budget; the k6 script is not written.
- ABDM M1 is schema-only, blocked on O-4 (sandbox credentials).
- Exit gate 8 (kill the SMS provider and the internet) has not been exercised.

**Open questions**

- **`EN-009 §4.1` contradicts `§5`** and needs correcting — see D-34. §4.1 seeds a critical-alert SMS carrying a test name and a result value; §5, `EN-037 §135` and the phase-01 constraint all prohibit it. The implementation follows the prohibition.
- O-1…O-8 unchanged.

**Next step**

Phase 1 API modules — patient/MPI/dedupe/merge, appointments/visits/schedules, queue/tokens and cash counter — then the Phase 1 screens, then the nine exit-gate criteria.

### 2026-08-20 · Phase 0 · Admin API, service entrypoints, infrastructure, Safari and gate 7 — **Phase 0 complete**

**Exit gates — all eight now met**

| #   | Gate                                                             |                                                                                                                                                                                                          |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | lint · typecheck · test · e2e · build                            | 🟩 all green, plus `test:safety` and `test:integration`                                                                                                                                                  |
| 2   | login from a clean start                                         | 🟩                                                                                                                                                                                                       |
| 3   | eight roles, eight correct workspaces                            | 🟩                                                                                                                                                                                                       |
| 4   | isolation tests break when a policy breaks                       | 🟩 automated mutation test                                                                                                                                                                               |
| 5   | audit shows login, role change, break-glass, chain intact        | 🟩 **now complete** — the admin API's role-assign and deactivate routes are reason-required and each writes exactly one audit row with actor and trace id; asserted in the integration suite             |
| 6   | ESC/POS token + PDF letterhead                                   | 🟩                                                                                                                                                                                                       |
| 7   | Lighthouse ≥ 90, PWA installable, offline shell                  | 🟩 **now met** — service worker registers and controls; installable manifest with fetched icons; offline fallback; Lighthouse budgets in CI asserting `installable-manifest` and `service-worker` at 1.0 |
| 8   | PROGRESS lists what exists, what is stubbed, every open question | 🟩 this file                                                                                                                                                                                             |

**Built**

- **Admin console API** — 23 routes across users, roles, permission matrix, branches, settings, flags, licence and audit search. Every route carries a catalogue permission key, every mutation writes its audit row and outbox event in one transaction, and cursor pagination is used throughout (`OFFSET` is banned).
- **Service entrypoints** — `services/worker/src/main.ts` mounts the outbox relay, chain sealer, partition maintenance and print queue across the five BullMQ priority classes from `docs/07` §4, with graceful shutdown. All three back-end services now start from `node dist/main.js` (ADR-0011).
- **Infrastructure** — OTel collector with a PHI-scrubbing processor chain, Prometheus/Alertmanager/Loki/Tempo/Grafana, 16 alert rules with 16 runbooks, pgBackRest with separated credentials, a restore drill that verifies RLS and the audit chain in the _restored_ copy, on-prem compose, nginx and a Helm skeleton.
- **CI** — stages 8 (browser) and 9 (clinical safety) added; the static stage now enforces the alert-runbook and hex-literal rules.

**Six defects found by running things**

1. **The middleware silently disabled the entire PWA.** Its matcher did not exclude `/sw.js`, so the service-worker script was redirected to `/login` and served as HTML with a 200. The browser refuses a worker reached via a redirect. Nothing else complained: the file existed, the build reported success, and the app simply was not a PWA.
2. **The middleware also redirected `/offline`** — a page that exists precisely for when you cannot reach the network, and therefore cannot sign in.
3. **`Secure` was keyed to `NODE_ENV`, not to the transport** (O-10). Chromium tolerates a `Secure` cookie on loopback HTTP; WebKit discards it, so no authenticated request worked on Safari/iPadOS. Now derived from the request URL, so a deployment that loses TLS fails loudly instead of serving sessions in clear text.
4. **Every paginated admin list skipped rows from page 2.** `timestamptz` is microsecond-precision and a JS `Date` is millisecond, so a cursor minted from a parsed date pointed up to 999 µs before the row it named. The same class of bug as the outbox relay's — worth watching for wherever a timestamp is a key.
5. **Any request with a long query string returned 500**: `api_route` is `varchar(200)` and a signed cursor overflows it. Storing the path only also keeps identifiers out of the audit row.
6. **`services/integration-hub`'s entrypoint constructed the hub, logged, and exited** — nothing for a rolling deploy's readiness probe to gate on.

**Closed**

- **O-10 closed** — root cause found and fixed; a permanent `webkit-ipad` Playwright project now covers Safari, because this class of bug is invisible to Chromium-only CI.
- **O-11 closed** — gate 7 met.

**Known limitation, stated rather than hidden**
The offline navigation fallback is verified on Chromium and **unverified on Safari/iPadOS**: Playwright's offline emulation does not drive WebKit's service-worker navigation handler. The worker registers and controls the page under WebKit, and the "never cache an API response" rule is asserted there. Needs a manual check on a real iPad before an iOS rollout.

**Not done — this is Phase 1 onward**

- Admin console **screens** (the API and the permission-driven nav exist; the pages do not).
- `@vims/i18n` stays source-only (ADR-0011); no service imports it.
- Print payload sourcing is a Phase-0 stand-in until the EN-039 render cache exists, and there is no LAN print-agent transport yet, so a job raises the browser-fallback error rather than a no-op transport reporting success.
- The integration hub's mapping DSL, schedules, listeners and delivery workers.
- The 177 clinical and administrative modules: Phases 1–13.

### 2026-08-19 (final) · Phase 0 · Realtime, integration hub, TV kiosk, printing, and the browser gates

Four more agents on disjoint services, plus the end-to-end gates directly.

**Exit-gate status**

| #   | Gate                                                       | Status                                                                                                                                                                     |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | lint · typecheck · test · e2e · build green                | 🟩 all green locally; CI written, not yet run on GitHub                                                                                                                    |
| 2   | login works from a clean start                             | 🟩 proved by e2e: the suite brings up PostgreSQL, seeds, starts the API and the built web server, and signs in                                                             |
| 3   | eight roles, eight correct empty workspaces                | 🟩 all eight sign in; the admin and patient menus are asserted **different**, with the administrative items absent rather than disabled                                    |
| 4   | isolation tests pass **and** break when a policy is broken | 🟩 automated mutation test since the previous session                                                                                                                      |
| 5   | audit shows login, role change, break-glass, chain intact  | 🟨 login and PHI-read audited with actor + trace id; chain seals and verifies; role-change and break-glass paths exist in the engine but have no admin UI to exercise them |
| 6   | ESC/POS token printed, PDF with letterhead                 | 🟩 real PDF (A4 + A5, `/MediaBox` verified, hospital name extracted from the text layer) and a token slip decoded back to its token, counter and cut command               |
| 7   | Lighthouse ≥ 90, PWA installable, offline shell            | 🟥 **not met** — no service worker is registered and no Lighthouse run exists. Accessibility is gated instead (axe, WCAG 2.2 AA, zero violations on login and workspace)   |

**Built**

- `services/realtime` — Socket.IO on the Redis adapter, verifying the **same** HS256 token as the API. Room names are a branded type only a builder can mint, so a room can never be string-concatenated at a call site, and the tenant check runs against the token rather than any hospital id the client supplies. Coalescing is **trailing**: a leading-edge throttle would render the oldest state of a burst, which on a bed board is confidently wrong.
- `services/integration-hub` — adapter interface, connector registry, config validation, DLQ, circuit breaker, PHI-redacting message log, and a null/echo reference connector.
- `apps/tv-kiosk` — pairing flow, dark 1080p board, and a transport that degrades from socket to polling. A stale feed flips the panel to "Last called — not live" rather than showing old tokens as current.
- `services/worker/src/print` — Playwright PDF renderer and an ESC/POS emulator that decodes a stream back to its text _and_ its control sequences.
- `services/api` — `GET /me` behind a new `@AuthenticatedOnly()` decorator. Session introspection cannot require a permission key, because the client calls it to _learn_ which keys it holds; marking it public would be worse. Permissions are resolved per request, so a revoked role stops working immediately rather than when the token expires.
- `apps/web` — permission-driven `RoleNav`, and a Playwright suite that stands the whole stack up.

**Five defects found by running the stack end to end**

1. **Every responsive utility in the product was inert.** The Tailwind bridge emitted `--breakpoint-md: var(--bp-md)`, but Tailwind v4 reads that at build time to construct media queries and cannot resolve a custom property — `@media (min-width: var(--bp-md))` is invalid, so the browser dropped it. The `md:block` class existed and matched nothing. Now literal values.
2. **The API could not start under `tsx`.** esbuild does not emit decorator metadata, so Nest's type-based DI injected `undefined` and the failure surfaced only when something dereferenced it. Injection is now declared with explicit `@Inject(Type)` rather than inferred.
3. **A boot failure was silent.** `bufferLogs: true` holds messages until initialisation completes, so a failure _during_ initialisation was buffered and discarded — the process exited with nothing printed. Boot failures now go straight to stderr.
4. **`app.listen({ port, host })`** — the Fastify adapter takes positional arguments, so the object was coerced to a nonsense port and the server never bound.
5. **A Nest `ValidationPipe` was wired** although this codebase validates with Zod; it required `class-validator`, which is not a dependency, and killed the process at boot.

Also: the login screen's utility classes named tokens that do not exist (`text-default` rather than `text-fg-default`), so Tailwind emitted nothing and the browser inherited a near-white foreground — 1.34:1 against the canvas. axe caught it; review would not have.

**Open questions raised**

- **O-10 — Safari/iPadOS is unverified.** Under WebKit the session cookie is not retained across the navigation after sign-in, so every authenticated test times out. Weakening `SameSite` was tried and did not help, and was reverted. The tablet project runs Chromium at a tablet viewport, which covers the responsive layout but **not** Safari. iPads are a plausible ward device, so this needs isolating before any iOS rollout.
- **O-11 — gate 7 is unmet.** `@serwist/next` is a declared dependency but no service worker is registered, so the PWA is not installable and there is no offline shell; no Lighthouse budget runs in CI.

**Not done**

- Admin console screens (users, roles matrix, audit viewer, flags, licence) — the API and nav entries exist; the pages do not.
- `services/worker` has no `main.ts`; the print worker and outbox relay are ready to mount but nothing starts them.
- `services/realtime` and `services/integration-hub` cannot run from `dist/` because `@vims/contracts` ships raw `.ts`; they run under `tsx`. Giving `packages/contracts` a build output is the fix.
- The integration hub's mapping DSL, schedules, listeners and BullMQ workers; the print agent's real LAN transport.

### 2026-08-19 (later) · Phase 0 · API, front-end, worker, design system, 124 tables and seeds

Built with four parallel agents on disjoint directories plus direct work on
`services/api`, `services/worker`, `apps/web` and CI.

**`services/api` — the ten-step request lifecycle (`docs/01` §3) now runs**

- Request context (ALS) → auth guard → tenant guard → Zod pipe → policy guard →
  `SET LOCAL` transaction → audit → outbox → RFC 9457 filter. Guards are
  registered **globally in lifecycle order**, so a new route is closed until it
  says otherwise, and a non-public route with no `@Permission()` is refused as a
  programming error rather than treated as open.
- The RBAC/ABAC engine is pure functions: deny by default, **role grants are
  additive** (any single grant may permit — intersecting them would mean adding
  a role could remove access), and obligations are _returned_ rather than
  performed so a controller cannot discharge one by ignoring it.
- `PermissionRegistryService` **verifies** the catalogue at boot instead of
  writing it, because `_grants` says `REVOKE INSERT, UPDATE, DELETE ON
core.permissions FROM hms_app` — the application role must not be able to
  author the list of things it may do. Drift fails startup.

**`apps/web` — the front-end builds and runs**

- `/login` renders problem+json including its `reference`; tokens live in
  httpOnly `sameSite=strict` cookies set by a server route, so no script in the
  page can lift a session; `?next=` is validated as a same-origin absolute path
  (an open redirect on a login screen is a phishing vector); middleware routes on
  cookie _presence_ only and says so — authorisation is the API's job.

**`services/worker`** — outbox relay (`FOR UPDATE SKIP LOCKED`, at-least-once,
dead-letter on exhaustion) and the audit chain sealer.

**Agent results**

- `packages/contracts`: 85 → **388 tests**, coverage 60.62 % → **97 %** (O-9 closed).
- `packages/ui`: 330 tokens × 3 themes, **816 contrast obligations**, 19 primitives,
  the 14 first-wave clinical components, 74 tests.
- `packages/db`: **+124 tables (172 total)**, 730 partitions, one migration, and
  four idempotent seed tiers (minimal 2,344 rows → volume 29,151).
- `packages/i18n` 71 · `packages/flags` 40 (100 % coverage) · `packages/print-templates` 59.

**Six defects found by running things rather than reading them**

1. **`--sp-0.5` is an invalid CSS custom-property _name_.** `.` is not legal in a
   CSS ident, so the browser discards the whole declaration — and every utility
   built on it — in silence. Both emitters now escape to `--sp-0\.5`.
2. **The outbox relay never marked anything published.** `occurred_at` is
   `timestamptz(6)` and is half of the partitioned primary key, but a JS `Date`
   holds only milliseconds; the round-tripped value matched zero rows, so every
   event would have been redelivered forever. The row now carries
   `occurred_at::text`.
3. **12 hex values in `docs/06` fail WCAG 2.2 AA** on surfaces they are actually
   used on (e.g. `--fg-subtle` at 3.98:1 on `--bg-sunken`; ESI-4 and
   bed-vacant-clean specify white on a green reaching only 3.73:1). Each
   deviation is documented and printed by `tokens:contrast`.
4. **Login could not read `core.users`.** It has RLS, and an unscoped session
   sees nothing. Login now runs hospital-scoped with no acting user.
5. **A login could not read its own role grants.** The generated policy appends
   `(branch_id IS NULL OR branch_id = ANY(current_branch_ids()))`, and
   `current_branch_ids()` is empty when unset. Since the branch scope is derived
   _from_ the grants this is a genuine chicken-and-egg; `docs/05` resolves it by
   placing branch choice after the password step. Codified in
   `currentTenantContext()`.
6. **`scripts/check-hex-literals.mjs` did not exist** although the root
   `tokens:check` script referenced it.

**Verified**
`pnpm lint` · `typecheck` · `test` · `build` · `test:integration` all green.
**715 unit + 41 integration tests.** RLS covers 172/172 tables with `WITH CHECK`;
the unrestricted-policy allow-list is still exactly `permissions` and
`setting_definitions`; `verify-isolation.sql` passes on both a bare and a seeded
database; seeds re-run write **zero** rows with byte-identical per-table digests.
The decisive API test reads `core.users` with **no `hospital_id` predicate** and
still never crosses tenants — row-level security, not a WHERE clause, is doing
the work.

**Not done / next**

- **`test:e2e`** — Playwright is configured in the manifests but no specs exist,
  so exit gates 2, 3 and 7 (login as each of 8 roles, Lighthouse ≥ 90, PWA
  installable/offline) are not yet demonstrable end-to-end in a browser.
- **`services/realtime`, `services/integration-hub`, `apps/tv-kiosk`** — still
  manifests only.
- Admin console screens (users, roles matrix, audit viewer, flags, licence).
- ESC/POS token print and PDF letterhead render (exit gate 6) — the templates
  exist in `packages/print-templates`; the worker-side Playwright renderer does not.
- MDM domain masters (`mdm_services`, `mdm_drugs`, …) are deliberately deferred to
  Phases 1–2 with a registry row each rather than invented.
- Two ADRs are owed: the EN-018 `display_*` schema placement, and the
  global-catalogue RLS predicate `USING (cardinality(accessible_hospital_ids()) > 0)`.

### 2026-08-19 · Phase 0 · Step 0–1: git baseline + `packages/testing` harness

**Built**

_Step 0 — the work is now in version control_

- The repository had **no commits at all**: 6,719 lines of specification, 177 module specs, 48 tables and 7
  migrations existed only as untracked files. Two commits now exist — a baseline import of everything as-is,
  then the husky hooks.
- `.gitignore` verified to cover `.env` **before** the first commit (`git check-ignore`, not by reading).
- **`.husky/pre-commit` and `.husky/commit-msg` did not exist.** `package.json` declared `lint-staged` and
  commitlint and husky was installed, so both were believed to be running; neither ever had. Created, and
  confirmed working by watching them run on the second commit.

_Step 1 — `packages/testing`, the harness everything else is tested through_

- `containers/postgres.ts` — Testcontainers PostgreSQL 17 built **from `infra/docker/postgres`**, not from the
  stock image. Half of what `packages/db` asserts depends on things the stock image lacks: the `ext` schema,
  pgvector/pg_partman/pgaudit, the four least-privilege roles and their `statement_timeout`/`search_path`
  attributes. A suite green against a different image would be green while production failed. Applies the 7
  migrations in filename order as `hms_migrator`, exactly as `prisma migrate deploy` would; each file is sent as
  one statement batch because splitting on `;` would destroy the `DO $$ … $$` blocks carrying the RLS generator
  and audit guards.
- `containers/redis.ts` — Redis 7.4 with `maxmemory-policy noeviction`, matching dev compose, so the eviction
  failure mode BullMQ and the refresh-token denylist depend on is actually reproduced.
- `fixtures/database.ts` — `withRollback` (transaction rollback in a `finally`, so a failing assertion still
  leaves the database untouched) plus `asRole` / `asTenant` / `asUnscoped` / `asMigrator`. Isolation by
  transaction is not merely faster than truncation: it is the only scope in which `set_config(…, true)` has
  meaning, so it is exactly the scope production RLS runs in (`docs/01` §3 step 8).
- `factories/tenancy.ts` — one group, two structurally identical hospitals, one live branch each. Identical on
  purpose: an isolation test between a populated tenant and an empty one passes because the second is empty.
- `generators/rng.ts` + `generators/indian-patient.ts` — seeded mulberry32, so every fixture is a pure function
  of its seed and a red build replays exactly. Patients are realistic in **shape** and impossible in **identity**:
  Aadhaar-shaped numbers are generated to **fail** the Verhoeff checksum (a real Aadhaar always passes it, so
  these provably belong to nobody), mobiles sit in a 555 block inside the TRAI-assigned 6–9 range, e-mail is
  `@example.invalid`, ABHA is the real 14-digit `xx-xxxx-xxxx-xxxx` shape from a range the sandbox does not issue.
  Names span several Indian linguistic regions, and ages cover paediatric/adult/geriatric bands so age-banded
  reference ranges are genuinely exercised.
- `matchers/tenant-isolation.ts` — the probe every module will reuse. It asserts READ, WRITE (`WITH CHECK`),
  cross-tenant UPDATE and default-deny, and — the part that matters — runs each with its **control**: the owning
  tenant must see the row. Without the control, "attacker sees nothing" is equally consistent with a broken
  fixture or a malformed query, which is the usual way this class of test lies.
- `matchers/sql-isolation-suite.ts` — runs the existing `packages/db/src/rls/verify-isolation.sql` inside vitest,
  parsing its `PASS`/`FAIL case …` notices so a failure names the case. Deliberately **not** reimplemented in
  TypeScript: the SQL file is what the DBA reviews and what `EN-041 §3.9.9` runs against a live branch, and a
  second implementation would drift.
- `packages/db/src/tenancy.ts` — created because `@vims/db` declared `./client`, `./kysely` and `./tenancy`
  exports whose files did not exist, so the package could not be imported at all (D-22). Tenancy is applied with
  parameterised `set_config(name, value, true)` (D-23).

**Tested** — 57 tests, all green

| Suite                               | Tests | Notes                                                                                                                                              |
| ----------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db` unit                  | 13    | tenancy GUC construction, group-scope widening guards, UUID validation, and that an invalid context issues **no** statement at all                 |
| `packages/testing` unit             | 28    | RNG determinism, Verhoeff behaviour incl. adjacent transposition, and 2,000 generated patients asserted to contain **zero** checksum-valid Aadhaar |
| `packages/testing` integration      | 16    | container-backed; ~2.4 s warm, ~30 s cold                                                                                                          |
| `packages/contracts` (pre-existing) | 85    | still green after the two lint fixes below                                                                                                         |

The integration suite proves: server is PostgreSQL 17 · every required extension installed · all four `hms_*`
roles exist · **`hms_app` is `NOBYPASSRLS`, not superuser, cannot create databases** · migrations applied (>40
`core` tables) · `withRollback` discards writes, including when the body throws · a tenant sees its own branch
and **not** another tenant's, even by direct id · an unscoped session sees nothing · the full isolation probe
passes on `core.branches` · the probe **reports a control failure** when handed a non-existent victim row · all
cases in `verify-isolation.sql` pass.

**The negative proof is now automatic.** A new test weakens `core.branches`'s policy to `USING (true)`, asserts
the probe goes red with a `READ LEAK`, restores the policy in a `finally`, and a following test asserts green
again. Exit gate 4 asks that "deliberately breaking a policy makes them fail"; that was previously done by hand
once and could rot silently. It is now a build gate.

**Three pre-existing defects found by running the gates rather than by reading**

1. **`pnpm lint` had never been green.** `packages/contracts` carried 12 errors while `PROGRESS.md` recorded it
   as complete and verified. Causes: the ESLint rule banned the entire `Math` global — including pure
   `Math.floor`/`Math.imul` — making it unsatisfiable (fixed, D-24); `tsconfig.json` excluded `*.spec.ts`, so
   type-aware linting could not parse any spec file (fixed); an **invisible U+00A0** sat inside a character class
   in `money.ts`'s parser (replaced with the explicit `\u00A0` escape — same behaviour, but an invisible
   character in a money parser is a hazard); and `ids.ts` interpolated a value that narrows to `never`.
   All 85 contracts tests still pass after these changes.
2. **`pnpm lint` / `pnpm typecheck` could not run at all** because nine source-less packages pointed `eslint src`
   and `tsc --noEmit` at nothing (D-21). Both now pass 20/20.
3. **`pnpm test` is red on a real gate**, not a broken script: `@vims/contracts` is at 60.62 % statements against
   the 90 % floor in `docs/09` §2, and `money.ts` at 96.95 % against its 100 % floor. Ten files have zero tests.
   Raised as **O-9**. The thresholds are correct and must not be lowered.

**Not a defect, worth knowing:** `ext.db_capabilities` is readable by `hms_app`/`hms_readonly` but not by
`hms_migrator` — the application reads it at boot, the migrator has no reason to. Two harness tests were
corrected to read it as the application role, which is the grant production actually depends on.

**Stubbed / not started**

- Everything in the previous entry's list except `packages/testing`, plus: `packages/db` still has no
  `client.ts`/`kysely/`, no seeds, and none of the `notif_*`, `wf_*`, `tpl_*`, `lic_*`, `print_*`, `bc_*`,
  `sso_*`, `mdm.*`, `integration.*` tables. Those tables block the notification centre, approval engine and
  licence gating in §0.3 and are **Step 2**.
- `packages/ui`'s ESLint override replaces `no-restricted-syntax` wholesale rather than extending it, so the
  `Math.random`, `SET LOCAL` and `OFFSET` bans will not apply inside `packages/ui`. Low stakes there, but it
  should be extended rather than replaced when that package gains source.

**Open questions raised**

- **O-9** (above) — close the `packages/contracts` coverage gap before Step 2, or Phase 0 exit gate 1 cannot pass.
- Still unconfirmed from the previous session: `org.uhid_group_unique` defaults to **true**. Chosen once per
  deployment, irreversible afterwards — confirm in writing before Phase 1.

**Next step**

1. **Step 1b — close O-9**: unit tests for the ten untested `packages/contracts` files and the four uncovered
   `money.ts` branches. Pure functions and Zod schemas, no database.
2. **Step 2** — the nine missing `packages/db` table groups + seeds (demo group → 2 hospitals → 3 branches →
   64 roles → one user per role).
3. **Step 3** — `services/api`: the ten-step interceptor chain. Nothing else in Phase 0 is verifiable until a
   request can complete.

### 2026-08-17 · Phase 0 · Foundation rails: contracts + database

**Built**

_Monorepo and tooling_

- pnpm workspaces + Turborepo with the exact layout from `docs/01 §11`
  (`apps/{web,tv-kiosk}`, `services/{api,realtime,worker,integration-hub}`,
  `packages/{contracts,ui,db,print-templates,i18n,flags,testing}`, `infra/`, `.github/`).
- TypeScript 5.9.3 strict with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes` as `CLAUDE.md` §2 requires.
- ESLint flat config carrying the rules that are _not_ stylistic: no `any`, no
  `console.log`, module-boundary `no-restricted-imports` (`docs/01 §4`), a ban on
  `SET`/`SET SESSION app.*` (would leak tenancy across a PgBouncer-pooled
  connection, `docs/07 §4`), a ban on `OFFSET` in repositories, and a hex-literal
  ban outside `packages/ui/src/tokens` (`docs/06 §11`).
- Prettier, commitlint with the `docs`-mandated scope vocabulary, husky, lint-staged.

_Local infrastructure_ — `pnpm infra:up`, ~90 s from cold

- **PostgreSQL 17.7** built from our own Dockerfile so dev, CI and on-prem share one
  image. All 11 extensions from `docs/03` install and are verified:
  pgcrypto, citext, pg_trgm, btree_gist, ltree, uuid-ossp, pg_stat_statements,
  pgvector 0.8.6, pg_partman 5.5.0, pg_cron 1.6, pgaudit 17.1.
- Redis 7.4 with `maxmemory-policy noeviction` — BullMQ job data and the
  refresh-token denylist must never be silently evicted.
- MinIO with a **private, versioned** bucket (`docs/04 §4`: no public objects).
- Mailpit for invitation/OTP mail; Orthanc behind an `imaging` profile for Phase 3.
- Four least-privilege roles: `hms_migrator` (owns schema, may DDL),
  `hms_app` (**NOBYPASSRLS**, no DDL), `hms_readonly`, `hms_retention`.

_`packages/contracts`_ — 85 tests passing

- `Money`: bigint minor units, no float anywhere, Indian lakh/crore grouping,
  `allocate`/`splitEvenly` that provably never create or destroy a paisa,
  explicit rounding modes with the adjustment returned separately so a bill can
  show it as a line (`docs/06 §5.2 #24`). Property-based tests per `docs/09 §2`.
- `IdGen`/`Clock` as injected interfaces (`docs/09 §2` forbids ambient randomness
  and time in unit tests); UUIDv7 with timestamp extraction for tamper checks.
- RFC 9457 problem+json with the `docs/06 §1.1 heuristic 9` extensions —
  `clinicalImpact`, `nextAction`, `reference` — because `{"title":"Bad Request"}`
  is useless to a nurse at a bedside. `TENANT_MISMATCH` deliberately maps to 404,
  not 403 (`docs/09 §3.1`: do not leak existence).
- Signed, tenant-scoped cursor pagination; `OFFSET` has no representation.
- **Permission catalogue: 220 keys** across the 16 Phase-0 modules, each with data
  class, risk, and flags for sensitive-grant / reason-required / step-up /
  second-person / PHI-read / clinical-safety-exempt. Import-time assertions reject
  duplicates and malformed keys. A test asserts no permission exists that could
  update or delete an audit row (`EN-024 §12`: "the permission does not exist").
- **All 64 system role templates** from `docs/05`, validated at import against the
  catalogue and against `docs/05` row numbers 1–64. Tests assert residents hold no
  override or break-glass key, clinicians _do_ hold break-glass, the auditor holds
  nothing mutating, the lab technician cannot validate, and non-care roles mask
  identifiers.
- ABAC condition model (own-patient, care-team, ward, amount limit with
  `whichever_is_lower`, time window, second person, data-class masks) plus the
  policy decision/obligation types.
- **Event registry: ~190 domain events** with Zod payload schemas, PHI flags and
  per-event retention. Naming enforced as `<aggregate>.<past-tense-fact>`.
  Tests assert every payload schema rejects a wrong shape (catching a schema
  accidentally left as `z.unknown()`), and that compliance-evidence events outlive
  the 7-day outbox purge.
- Audit contract: action enum, `DEFAULT_AUDIT_FIELD_POLICIES` (secrets excluded
  outright, Aadhaar/ABHA masked, biometric templates never present even masked),
  frozen hash-chain field list, statutory retention floors with the citing regulation.
- Notification contract: five severities with `critical` non-configurably
  overriding quiet hours, dedupe/coalesce forbidden for `critical`, escalation
  rungs, and `findForbiddenExternalPlaceholders()` enforcing the
  content-minimisation rule that keeps a diagnosis off a lock screen.
- Settings registry (46 typed keys with scope, sensitivity, approval and
  dual-control flags) and the EN-040 entitlement model including the full
  degradation ladder and `CLINICAL_SAFETY_EXEMPT_KEYS`.
- Auth and admin DTOs, including the `/login` challenge union that models every
  stop in `docs/05`'s flow (MFA → branch selection → password change → authenticated
  → use-SSO) so the client never has to guess what to render next.

_`packages/db`_ — 48 tables, 7 migrations, all applied

- Prisma multi-file schema (`prisma/schema/*.prisma`) covering tenancy
  (group → hospital → branch → unit, registrations, data domains, branch access,
  cross-branch disclosure log, onboarding, residency), identity (users, roles,
  permissions, user_roles with ABAC scope, sessions, devices, auth policy, MFA/OTP
  challenges, login audit, access requests/reviews, SoD rules, impersonation),
  audit (log, chain roots, integrity runs, break-glass, retention policies,
  archives, exports, cases, field policies) and platform (settings + definitions,
  holidays, numbering series + allocations, feature flags, files, idempotency keys,
  outbox, DR drills, downtime windows).
- **Five tables partitioned monthly** — `audit_log`, `outbox_events`, `sessions`,
  `login_audit`, `org_cross_branch_access_log` — via a repeatable post-processing
  script (`scripts/apply-partitioning.mjs`) rather than a hand edit, because the
  base migration gets regenerated and a silently-missing partition would not fail
  any test until the table was 40 M rows deep.
- **RLS on all 48 tables**, generated from the catalogue so a future table cannot
  be forgotten, with `USING` _and_ `WITH CHECK` on every tenant-scoped table.
  Default-deny comes from `current_setting(..., true)` returning NULL, i.e. from
  SQL semantics rather than from remembering to write a guard.
- Append-only enforcement on `audit_log` by **both** revoked grants and a
  `BEFORE UPDATE OR DELETE` trigger (`EN-024 §14 AC-5` requires both), with one
  precisely-scoped exception: the chain sealer may stamp `seq`/`prev_hash`/
  `row_hash`/`sealed_at` onto a never-sealed row provided every other column is
  byte-identical.
- Hash chain: `core.audit_row_hash()` (jsonb-canonicalised sha256, frozen field
  list), `core.seal_audit_chain()` (advisory-locked, single-writer per tenant),
  `core.verify_audit_chain()` returning every discrepancy class — seq gap, broken
  linkage, post-seal modification, back-dated insertion.
- Least-privilege grants with each exception stated individually, plus
  `core.v_rls_coverage`, `core.v_grant_coverage`, `core.v_rls_open_policies` and
  `core.v_audit_seal_backlog` as the monitors those guarantees are checked through.
- 22 partial/trigram/covering indexes from `docs/07 §4`, `NULLS NOT DISTINCT`
  uniqueness for the nullable settings-scope tuple, and a `btree_gist` exclusion
  constraint preventing overlapping branch grants.

**Tested**

- `packages/contracts`: 85 tests green — 41 Money (incl. 6 property-based over
  500 runs each), 28 RBAC catalogue/role-template, 16 event registry/envelope.
- `packages/db/src/rls/verify-isolation.sql`: **12 SQL-level isolation cases, all
  passing**, covering `docs/09 §3.1`:
  RLS enabled everywhere · `WITH CHECK` everywhere · only the two global catalogues
  world-readable · `hms_readonly` write-free · audit tables app-immutable ·
  `hms_app` NOBYPASSRLS · no elevated role attributes · audit UPDATE rejected ·
  audit DELETE rejected · sealer seals all pending rows · chain verifies clean.
- **Negative proof done, as gate 4 demands:** replacing `core.branches`'s policy
  with `USING (true)` made the suite fail 2 cases and exit non-zero; restoring it
  returned all cases to green.

**Two real defects the verification caught (neither would have been caught by review)**

1. `core.hospitals`, `core.org_groups` and `core.role_permissions` had received
   `USING (true)` from the generator because their tenant key is `id`, not
   `hospital_id`. Any authenticated session could have read every other tenant's
   legal name, GSTIN, PAN, address and DPO contact, and enumerated their custom
   roles. Fixed with explicit policies (D-17) and now monitored by
   `core.v_rls_open_policies`.
2. `core.verify_audit_chain()` had an OUT parameter colliding with a column name,
   so it raised on every call — the integrity check the whole §65B evidence chain
   depends on had never actually completed. Fixed (D-19 migration).

**Stubbed / not started**

- `services/api` — no source. The interceptor chain (`docs/01 §3` steps 1–10),
  auth, RBAC/ABAC policy service, audit interceptor, outbox writer, numbering,
  settings, flags, licence entitlement, approvals, templates, notifications and
  the EN-017 skeleton are all still to write. **This is the critical next step.**
- `apps/web`, `apps/tv-kiosk`, `packages/ui` — no source. No login screen, so exit
  gates 2, 3 and 7 are not yet reachable.
- `services/worker`, `services/realtime`, `services/integration-hub` — manifests
  only. The chain sealer and partition maintenance exist as SQL functions but have
  no job wiring yet.
- `packages/db` schema is complete for tenancy/identity/audit/platform but **not**
  for `notif_*`, `wf_*`, `tpl_*`, `lic_*`, `print_*`, `bc_*`, `sso_*`, `mdm.*` or
  `integration.*`. Their contracts exist in `packages/contracts`; the tables do not.
- Seeds — none. No demo group/hospitals/branches, no 64 seeded roles, no per-role
  dev users. `seed:minimal|demo|hospital|volume` are declared but unimplemented.
- CI (`.github/workflows/ci.yml`), Helm chart, pgBackRest config, restore-drill
  script, OTel/Grafana compose, alert rules.
- `packages/testing` Testcontainers harness and the synthetic Indian patient
  generator — needed before the API integration suite can exist.

**Open questions raised**

- None blocking. Every `§16 Open Question` encountered so far has been answered
  with the spec's stated default and recorded in `docs/DECISIONS.md`.
- Worth confirming before Phase 1: `org.uhid_group_unique` defaults to **true**
  (group-unique UHID with a branch prefix, `EN-041 §3.4.1`). That choice is made
  once per deployment and cannot be changed afterwards, so it should be confirmed
  in writing rather than inherited from a default.

**Next step**

1. `packages/testing` — Testcontainers harness, so every subsequent piece is
   testable as it lands.
2. `services/api` — the interceptor chain first (request context → auth → tenant
   guard → rate limit → Zod → policy → idempotency → transaction with
   `SET LOCAL` → audit → outbox → problem+json), then auth, then the admin CRUD.
   Nothing else in Phase 0 can be verified until a request can complete.
3. Seeds: demo group → 2 hospitals → 3 branches → 64 roles → one user per role.
4. `packages/ui` tokens + `apps/web` `/login` and role-routed shell.
5. Wire CI, then run the full exit gate.

### YYYY-MM-DD · Phase 0 · (template — delete when the next real entry is written)

- **Built:** …
- **Tested:** … (list the tests, not "tests written")
- **Stubbed / deferred:** … (with the reason and where it is tracked)
- **Open questions raised:** …
- **Next step:** …
