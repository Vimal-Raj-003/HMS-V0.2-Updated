# PROGRESS

> Claude Code updates this file at the end of **every** working session. Newest entry on top.
> Format: date · phase · what was built · what was tested · what is stubbed · open questions · next step.

## Current state

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current phase          | **Phases 0–7 complete; Phase 8 in progress.** The specialty console framework (OP-025 §0) and the ophthalmology console are done and proved; roughly 33 consoles remain. **Phases 0–7 complete.** Phase 7 (Inpatient) finished on 2026-09-08 with step 7G — discharge, the versioned summary and the mortuary — and all ten of its provable exit gates pass. Gate 11 (the load test) has not been run: k6 is not installed here. Phase 8 (specialty consoles) is next and has no code.                                                                                                                                                                                                                                                                  |
| Repo status (previous) | **423 application tables** across ten tenant schemas (`core` 141, `clinical` 67, `mdm` 49, `lab` 41, `rad` 36, `integration` 29, `patient` 19, `billing` 18, `engage` 13, `queue` 10) — 667 relations once the 244 monthly partitions are counted. **14 migrations**, all applied to a real container. 4 idempotent seed tiers. **125 API route handlers across 33 controllers**; **24 Next.js pages**.                                                                                                                                                                                                                                                                                                                                                 |
| Repo status            | **714 non-partition tables** outside the system schemas across fourteen tenant schemas (`clinical` 174, `core` 124, `billing` 96, `inventory` 82, `mdm` 66, `lab` 38, `rad` 34, `integration` 26, `patient` 18, `pharmacy` 17, `ops` 12, `engage` 11, `queue` 8, `finance` 2) — **0 business tables without RLS**; the only four without it are pg_partman's own `ext.part_config`, `ext.part_config_sub`, `ext.db_capabilities` and `public._prisma_migrations`. Read out of a live container, not copied from a commit. **46 migrations. 742 API routes. 88 Next.js screens.** Permission catalogue **1,144 keys**; event registry **773**.                                                                                                           |
| Last green CI          | **Green on this machine, 2026-09-08.** `pnpm lint` and `pnpm typecheck` 20/20; `pnpm test` **3,062 unit tests, 20/20 packages**; `pnpm test:integration` **489 tests, 18/18 files** — including the Phase-1 scheduling flake fixed this session, which failed only at certain times of day. **Never run: both k6 scripts** (k6 is not installed here) and no Playwright golden path exists for any Phase 5–7 module.                                                                                                                                                                                                                                                                                                                                    |
| Modules complete       | **0 / 177** to `CLAUDE.md` §7's Definition of Done — no module has both its k6 script and its e2e golden path, and that is now the largest outstanding debt in the build. Against `docs/12` by _coverage_ rather than by DoD: every module in phases 0–7 has schema, contracts, API, screens and its rules proved live in both directions; phases 8–13 have none. **The system can register, queue, consult, prescribe, order and report diagnostics, dispense, hold stock, price and bill, take money, triage and resuscitate, run a theatre and an ICU, transfuse, admit, nurse, discharge with a signed summary, and release a body lawfully. It cannot yet run a specialty console, the ERP back office, a patient portal or the analytics layer.** |
| Blocking questions     | **O-1** blocks Phase 2's exit gate 9, **O-2** blocks Phase 1 gate 3, **O-4** blocks Phase 1 gate 6, **O-12** (analyzer and PACS vendor inventory) blocks every Phase 3 gate that touches a device, and the new **O-14** asks whether JWT signing stays on HS256 shared secrets or moves to the RS256/EdDSA that `EN-007 §Security` names. See `docs/DECISIONS.md` → "Open" for O-1…O-14.                                                                                                                                                                                                                                                                                                                                                                |
| Project path           | `~/Desktop/Test/HMS/vims-hms-build-kit` (renamed — see D-19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

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
| 7   | Analyzer disconnected 30 minutes → messages buffer and replay with zero loss; unmatched queue works                           | 🟩 **met against a simulator.** HL7 v2/MLLP and ASTM E1381/E1394, store-and-forward, and `exit-gate-7.integration.spec.ts` drives forty frames through a thirty-minute outage: every one acknowledged, none delivered during it, all forty applied exactly once and in order on recovery, and an unknown specimen queued rather than dropped. Falsified three ways, including answering before the durable write, which fails 4 of 6. **O-12 still applies** — no real device has been on the wire.                                                                                                                                                                                    |
| 8   | 20 000 results/day load test within the `docs/07` budgets; report PDF < 3 s p95                                               | ⬜ **never run.** No k6 script for it, and no PDF pipeline for a lab or radiology report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 9   | Previous gates green; PROGRESS updated with the analyzer inventory still to be interfaced                                     | 🟨 **partial.** This file is updated; previous gates are not all green. **The analyzer inventory itself is not recorded because nobody has supplied it — that is O-12.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

---

## Session log

### 2026-09-06 · Phase 5 begins · The tariff, the bill and the money that arrives

**Built — RC-003 (tariff engine), complete.** The pricing authority `phase-05`
builds first because every bill line calls it. 12 tables in `mdm`, 23 permission
keys, 14 domain events, a seeded self-pay plan pricing all 10 services and a
corporate plan **derived** from it at −10 %. Six database guarantees, each proven
against the running database rather than asserted: two published versions of one
plan cannot overlap (exclusion constraint), a published version is immutable
(trigger, on INSERT as well as UPDATE), one rate per service/class/band
(coalesced unique index — a plain UNIQUE lets NULLs duplicate), a package split
must total 100, a taxable item must carry a GST rate and an HSN, and base must
sit inside its guard rails. `resolveRate` returns `MISSING_RATE` with the full
attempted chain and **never** a zero; a miss writes a worklist row and raises
`tariff.rate.missing`.

**Built — OP-005 (OP billing), complete.** 8 tables, 18 keys, 10 events. Proven
over HTTP end to end: a visit with a consult, an ECG and a UHID card produced one
bill of ₹918 with the GST split correct on a **mixed exempt/taxable** bill
(consult and ECG exempt, card taxable at 18 % as CGST 9 + SGST 9). **Exit gate 2
passes** — every charge replayed three times _at a different price_ left the bill
byte-identical, because the idempotency lives in a UNIQUE index on
(bill_id, source_module, source_ref_id) rather than in a service check. A
deferred constraint trigger refuses a header that disagrees with its lines, which
is exit gate 10's "Σ bill lines = bill total" made unfalsifiable. Finalisation
issues the GST document; a finalised bill refuses new lines and is corrected by
credit note.

**Built — EN-010 (payment gateway), complete.** 14 tables, 16 keys, 8 events.
**Exit gate 3 passes** — one webhook delivered three times produced exactly one
₹693 payment. A forged delivery (signature unverified) is stored as evidence,
raises `pay.webhook.rejected` and credits nothing. A capture matching no intent
becomes an `unapplied` reconciliation exception rather than an error somebody
swallows, because the patient's money arrived either way.

**Three maker-checker pairs, enforced by the catalogue rather than by
convention** — `tariff.version.submit`/`publish`, `bill.discount.request`/
`approve`, `pay.refund.request`/`approve`. Each is two keys held by two roles
with a `block` segregation rule, and each was tested by having the requester try
to approve their own: 403 every time.

**Defects found and fixed while building**

- `upsert()` takes its column list from the **first** row, so a key present only
  on a later row is silently dropped. The corporate plan's derivation vanished
  and it resolved as self-pay. Worth knowing about — it is a live footgun in the
  shared seed helper.
- The tariff immutability trigger refused the second seed run, because
  `BEFORE INSERT` fires before `ON CONFLICT` is evaluated. The database was
  right; the seed now skips an already-published version, which is what
  idempotence means for an immutable table.
- Invoices were taking numbers from the `BILL_OP` series, interleaving bill and
  invoice numbers in one counter so the invoice register would show gaps. They
  now have `TAX_INVOICE` and `BILL_SUPPLY` series of their own — gapless per
  series per FY is only true if the series is not shared.
- `getBill` inner-joined `patient.patients`, and patients are branch-scoped by
  RLS, so a patient registered at one branch and billed at another made the bill
  invisible. Now a LEFT JOIN that degrades to "Registered at another branch".
- `registry.spec.ts` used `bill.finalized` as its example of an _unregistered_
  event. Phase 5 registered it for real, so the fixture is now nonsense by
  construction.

**Built — OP-023 (packages), complete.** 9 tables, 14 keys, 7 events. A package
is a fixed-price _promise_, so the module's whole job is deciding what happens
when delivery exceeds it. `evaluateCharge` returns one of covered / capped /
excluded / excess_pending, and a component the package does not name comes back
`excluded` rather than being silently absorbed — the two failure modes are a
family surprised at discharge and a hospital quietly eating revenue, and only an
explicit verdict avoids both. Cap alerts fire at 80% and 100%. An activation
cannot be closed while a variance is pending.

**Built — EN-002 + RC-002 (insurance and pre-authorisation), complete.** 15
tables, 22 keys, 11 events. Every state change is written to
`preauth_status_history` with an `actor_type` of `staff`, `payer` or `system`,
behind a `BEFORE UPDATE OR DELETE` trigger that refuses both. That trigger holds
through the FK cascade as well: a `DELETE` of the request itself is refused by
the history rows hanging off it, so once a pre-auth has a trail it cannot be
erased at all. When a payer disputes what was sent and when, evidence that could
have been edited is not evidence.

All 11 constraints were proven against the live database, not asserted in prose:
duplicate open case per payer/encounter, approval without amount _and_ validity,
denial without a reason code, `partially_approved` at the full requested amount,
approval above the request, an enhancement with no parent, history UPDATE,
history DELETE, a query marked replied while still open, co-pay above 100%, and
the cascade refusal above.

The lifecycle was driven end to end over HTTP twice, once through each decision
path — `submitted → decision` and `submitted → query_raised → query_replied →
decision`. The second one matters because it is the branch a real claim takes:
₹120,000 requested, payer queries the choice of hemi over total arthroplasty,
desk answers with the Garden grade and the NICE reference, finance records
₹95,000 partially approved for 6 days valid to 31 Dec against payer ref
SH/AUTH/71204, and the credit limit propagates. The trail comes back five rows
deep with the right actor on each.

**Five maker-checker pairs, enforced by the catalogue rather than by
convention** — `tariff.version.submit`/`publish`, `bill.discount.request`/
`approve`, `pay.refund.request`/`approve`, `pkg.variance.request`/`approve`, and
`preauth.submit`/`preauth.decision.record`. Each is two keys held by two roles
with a `block` segregation rule, and each was tested by having the requester try
to approve their own: 403 every time. The last one is the sharpest — a recorded
approval becomes a credit limit that billing honours and a ward acts on, so the
person waiting on the payer must not be able to type in what the payer said.

**Gates** — 20/20 packages typecheck, lint and test (2,762 → 2,835 tests
passing); 431 routes across 49 controllers all authorised; hex-literal,
chart-palette, gate-script, alert-runbook, permission-key and prettier clean.
Catalogue 755 → 854 keys.

**Built — RC-007 (government schemes), complete.** 13 tables, 24 keys, 11 events,
and **exit gate 6 passes**: a scheme beneficiary cannot be charged cash anywhere.

The block is a trigger on `billing.payment_lines` rather than a check in a
service, because that table is the one every collection point must write to — the
cash counter, the pharmacy window, an OPD advance, an IP deposit, a forex tender.
A module built in Phase 7 or Phase 9 that collects money and has never heard of
RC-007 is refused by Postgres. It was proven at all five of those points and
again in raw SQL bypassing the API, with UPI and card as controls to show the
block is precise rather than blanket. ADR-0012 records the reasoning, including
why the default scope is the episode rather than the person: applied to the
person it refuses a PMJAY cardholder buying paracetamol at the retail window, and
a cashier who meets a rule they know is wrong routes around it.

The refusal is recorded _before_ it is refused. A raised exception takes its
transaction with it, so the trigger cannot write the evidence of its own firing;
`checkCash` writes an append-only `scheme_cash_attempts` row first and then lets
the tender fail. An NHA audit does not ask whether you take cash from scheme
patients — it asks what happened when somebody tried.

**Two defects the live drive found that the constraint proofs had missed**

Both were the same mistake: "has a decision been made?" encoded as a list of
statuses, which then drifts from what the statuses mean.

- `scheme_claim_line_balances` required `approved + disallowed = claimed` on
  every row. That is right about a decided line and wrong about a fresh one —
  ₹90,000 claimed, nothing approved, nothing disallowed — so **no claim could be
  assembled at all**. The original proof happened to test a row that already
  carried a decision, which is exactly the row it was correct about. The line now
  carries `decided_at`, written by the decision and by nothing else, and the rule
  is gated on it (migration `…150000`).
- `scheme_claim_shortfall_is_the_difference` listed `closed` among the decided
  statuses. A claim assembled in error and retired from `draft` reaches `closed`
  without ever having been decided, so it too was refused — and a draft claim
  could be neither submitted (no documents) nor discarded (the same checklist
  trigger), pinning its case open for good. The checklist now gates the
  transition into `submitted` only, and the shortfall rule asks `decided_at`
  (migrations `…160000`, `…170000`).

A third, smaller one: the module's triggers raise a custom SQLSTATE, and nothing
mapped it — so a cashier refused ₹500 saw "Something went wrong on our side",
which is both untrue and useless. `schemes.errors.ts` now passes each trigger's
own wording through as a 409.

**Seven maker-checker pairs across Phase 5**, each two keys held by two roles with
a `block` segregation rule, each tested by having the requester try to approve
their own work: `tariff.version.submit`/`publish`, `bill.discount.request`/
`approve`, `pay.refund.request`/`approve`, `pkg.variance.request`/`approve`,
`preauth.submit`/`preauth.decision.record`, `scheme.claim.submit`/
`scheme.claim.decision.record`, and `scheme.shortfall.appeal`/
`scheme.shortfall.writeoff.approve`. 403 every time.

**Built — RC-008 (cost estimator), complete.** 8 tables, 11 keys, 7 events, and
**exit gate 8 passes**: an estimate was issued at ₹86,400, converted, and
reconciled against a ₹1,01,000 bill — **+16.90%**, which is past the 10%
threshold and so raised `estimate.variance.breached` rather than waiting for a
monthly report. The point of noticing is to tell the family before discharge.

Every line prices through `TariffService`, the same resolver every bill line
calls: an estimate and a bill priced by two different authorities will eventually
disagree, and the family is who finds out. An issued estimate is immutable at the
database level and is revised by superseding it, so both numbers survive — a
family told ₹83,600 and later ₹86,400 can be shown exactly what changed and when.

Two things that turned out to matter more than expected:

- **Confidence belongs on the line, not the estimate.** A total made of firm
  lines and one made of indicative lines are different promises even when the
  number is identical. Marking each `firm` / `capped` / `indicative` /
  `contingent` is what lets a desk say "the surgery is fixed, the ICU days are
  not" instead of reading out the whole sheet.
- **A per-day line multiplies by the stay.** Dressings and injections at 1 and 3
  a day over 5 days are 5 and 15, and getting that wrong is where most real
  estimate variance comes from. It is arithmetic in the module rather than
  something the desk has to remember.

**Four defects the live drive found**

- `est_shares_sum_to_payable` and its neighbours were right, but the module could
  not issue anything: a template line the tariff cannot price sat at ₹0 and the
  desk's manually priced line was _added_ next to it rather than replacing it,
  doubling that part of the quote. Caller lines now match template lines by
  service and description.
- An estimate with a ₹0 line that was not marked `contingent` could still be
  issued — a quote silently too low, which is the exact failure the module exists
  to prevent. Issuing now refuses and names the lines.
- `RETURN NEW` on the allowed path of a `BEFORE DELETE` trigger returns NULL,
  which **silently cancels the delete**. A draft estimate reported deletion and
  stayed. Worse, `status` was outside the frozen column list, so an issued
  estimate could be set back to `draft`, repriced and reissued with the trigger
  satisfied at every step (migration `…190000`).
- A room-class scenario was written even when no line could be repriced for that
  class, showing a family a priced comparison that was never priced. It is now
  omitted, which correctly says "we cannot answer for that class".

`est.share` is an `export` action, and the catalogue requires every export to
carry a reason. Rather than carve an exception for a new module, sharing a quote
now takes one — a costing for a named person going to a hand-typed phone number
is worth being able to trace.

**Built — RC-006 (revenue leakage audit), complete.** 6 tables, 12 keys, 7
events, 4 reconcilers, and **exit gate 9 passes**: two lab tests were delivered
on one encounter, one was billed and one deliberately was not, and the
pre-discharge check found the ₹480 electrolytes, ignored the billed CBC, and
refused to clear the discharge.

The rule the whole module is built around is §5.7's "Never auto-post — propose to
a human", and it is a trigger rather than a convention. A finding cannot reach
`recovered` without an `accepted` action in the append-only trail carrying a real
user id — the trigger reads the **trail**, not a column, because a column set in
the same statement as the status would just be the service attesting to its own
behaviour. Proven four ways: straight to recovered (refused), accepted with
nobody named (refused), dismissed with no reason (refused), and an `accepted`
action with a null actor (refused). The legitimate path — a person accepts, then
the recovery is recorded — works.

One property that emerged and is worth keeping: **recording a recovery does not
make the charge exist.** During the drive a recovery was recorded before the bill
line was actually raised, and the next scan found the same unbilled row and
raised it again. The reconciler checks the ledger, not the claim, so this audit
cannot be closed out by asserting the money came back — only by the charge
actually being there.

The four reconcilers are code rather than configuration, and the comment says
why: each is a join between two schemas with its own notion of "delivered" — an
order is `completed`, a dispense is `dispensed`, an implant is `used` and
specifically not `wasted` or `reversed`. What _is_ configuration is the threshold
each stays quiet below, because a worklist full of ₹5 gaps is one nobody opens
and the ₹40,000 implant is buried in it. The consignment threshold is ₹1: an
implant is never noise.

**Built — NC-034 (doctor payouts), complete.** 8 tables, 12 keys, 7 events, and
the NMC anti-kickback guard made **structural rather than validated**.

§5.7 asks that no per-referral payment be _representable_. Three things together
deliver that: `PayoutBasis` has no `per_referral` member, `PayoutSourceType` has
no `referral` member, and a trigger refuses any payout line whose bill item names
the earning doctor as the **referrer** while somebody else performed the work.
The third is the one that matters — the first two only stop somebody being honest
about it, and a hospital wanting to pay for referrals would simply write the
commission as a flat fee. Proven exactly that way:

- Dr A earns 40% of a consultation Dr A performed → ₹360 ✅
- The same rule against a ₹45,000 arthroscopy Dr A only referred → **refused**
- The identical thing relabelled a "co-ordination fee" → **refused**
- A doctor who both referred _and_ performed → earns normally, because they did
  the work

The compute run reports `referralsRefused` rather than swallowing it: a rule that
keeps reaching for services the doctor did not perform is a compliance problem,
and a silent skip would hide it.

Section 194J is cumulative rather than per-payment — the ₹30,000 annual threshold
and section 206AA's 20% no-PAN rate both depend on the year to date, and a figure
recomputed from a sum each month drifts from the one that gets filed. Sixteen
constraints proven live, including 20% deducted where a PAN exists (refused),
10% where none does (refused), and any deduction below the threshold (refused).

`payout.statement.compute` / `payout.statement.approve` is the eighth
maker-checker pair: finance computes and pays, the hospital admin releases, and a
statement with an open dispute cannot be approved at all. The doctor holds
`payout.dispute.raise` on their own statement — a payout system where the earner
cannot query the figure is one they argue about by email.

**Two defects the live drive found**

- Doctors had no way to dispute their own statement — the key existed but was
  granted to nobody, even though the consultant role's own description says "own
  earnings". Now a `PAYOUT_EARNER` bundle on all seven clinical templates.
- An upheld dispute adjusted the statement and left the period's totals stale, so
  the screen showed ₹360 above a statement reading ₹1,080. The period is now
  recomputed from its statements rather than incremented — an aggregate
  maintained by arithmetic drifts the first time a path forgets it, and this one
  is rendered directly above the rows it claims to total.

---

### 2026-09-06 · Phase 6 begins · The front door at 3 a.m.

**Built — OP-006 (ER intake, board and dispositions), complete.** 5 tables, 9
keys, 6 events, and **exit gates 1 and 2 pass**.

Gate 1: an ambulance pre-alerted with an 8-minute ETA, the board showed the
inbound patient, resus bay R1 was held before arrival, and the handover carried
the complaint and the MLC suspicion into the ER record with nothing re-keyed —
because it is the same record.

Gate 2: an unknown patient brought in by police was registered in **54 ms**
sending nothing but `arrivalMode`. They got `ER-TAG-00002`, a bay, and treatment.
Two hours later the tag was reconciled to a real UHID and the ER number, the bay,
the movement history and the door-to-doctor timestamp all survived — the visit
gains a patient rather than being recreated, which is the whole of the gate.

**The Katara rule is a shape, not a check.** `er_visits.patient_id` is nullable
and a CHECK requires _either_ a patient or a tag — never a registered patient.
And no column in any of the five tables references a bill, a payer or a balance,
so there is nowhere for a "pay first" gate to be added later by somebody who did
not read the header. That is stronger than skipping the check.

Fourteen constraints proven live, including a bay holding two patients, a patient
in two bays, a LAMA with no witness, a referral with no destination, a death with
no time, and a bay reassigned after the patient was discharged.

Two smaller things worth recording:

- A vacated bay goes to `cleaning`, never straight to `free`. NC-018 arrives in
  Phase 7; until then the bay sits visibly dirty on the board. A bay that
  silently became free is how the next patient is put on an unwiped trolley.
- `ER_TAG` was first written as a daily-reset series. The platform refused it —
  daily series are issued from `queue.queue_token_series` — and the refusal was
  right for a second reason: a tag recycled daily means two patients called
  `ER-TAG-0007` a week apart, and if either is still unidentified that is exactly
  the confusion the tag exists to prevent. It is now never-reset.

Also fixed here: the e2e suite had never been in any TypeScript project, so it
was neither typechecked nor lintable and the pre-commit hook could not handle a
commit that touched it. It is in the project now, with two real defects it had
been hiding.

**Gates** — 20/20 packages typecheck, lint and test (2,849 tests); 506 routes
across 54 controllers; catalogue 922 keys; event registry 677.

### 2026-09-09 (later) · Phase 8 · OP-025 the eye clinic — and the licence gate that was never wired

**Built — OP-025, the first console on the framework, complete.** 8 tables, 11
permission keys, 5 events, 1 new role template, 4 screens, 22 integration
tests. Plus the cross-cutting fix below, which Phase 8's own exit gate 11
forced into the open.

**Four rules, proved in both directions**

| Attempt                                          | What happened                                                   |
| ------------------------------------------------ | --------------------------------------------------------------- |
| An acuity of both eyes at once                   | Refused — two eyes that measure the same are two measurements   |
| 6/18 entered with a made-up logMAR of 9.99       | Stored as 0.48; the trigger owns the conversion, not the caller |
| CF, HM, NLP                                      | 1.90, 2.30, 3.00 — the ladder below the chart has fixed values  |
| A child who fixes and follows                    | No number at all; an invented point is worse than a gap         |
| A Snellen value of "good"                        | Refused, in words that say what a Snellen acuity looks like     |
| A sphere of −2.13                                | Refused — no lens is ground to it                               |
| An axis of 0; a cylinder with no axis            | Both refused                                                    |
| A pressure of 140 mmHg; a cup-disc ratio of 1.4  | Both refused                                                    |
| Dilation with no drug named                      | Refused — the drops are a medication with a hazard attached     |
| The nurse examining; the resident signing        | 403 both times                                                  |
| Editing a signed spectacle prescription          | Refused — an optical shop may already be grinding to it         |
| An optometrist signing without the delegated key | 403; with it, signed and recorded as delegated                  |
| A lens power with no biometry; with no formula   | Both refused — the eye is not adjustable afterwards             |
| Biometry eight months old                        | Planned with, labelled `biometryStale` — the surgeon's call     |
| A second live plan for the same eye              | Refused; the other eye is a different plan                      |
| Cancelling a plan with no reason                 | Refused — the patient was told it was happening                 |

**What the console does not have**

No worklist, no upload path, no print pipeline. `SpecialtyWorklist` and
`InvestigationsPane` are imported from the framework unchanged, and an OCT is a
`specialty.device_orders` row like every other console's scan — which is why
there is no `ophtha_investigation_orders` table and no route to order one.

**A defect gate 11 uncovered, older than this phase**

Gate 11 asks that a console toggled off leave "no nav item, no route, no search
result". None of that was possible:

- **Ten module entitlement keys named by screens since Phase 1 existed
  nowhere.** `module.inpatient.enabled` and nine others were declared on screen
  catalogues and defined in no enforcement point, so the seed wrote no licence
  row and no hospital could enable those modules.
- **The `entitlement` field was never read.** Not by the navigation, not by the
  gates, not by anything. It was documentation.
- **The ⌘K palette indexed `ADMIN_SCREENS` alone** — by Phase 8 it could not
  find the bed board, the ER board or the eye clinic.

All three are fixed: the session carries the hospital's licensed modules, the
navigation and the palette filter on them, every screen gate refuses with the
licence's own plain-language message rather than "ask your administrator", and
`apps/web/src/lib/entitlements.spec.ts` fails if a screen ever again names a key
the catalogue does not define. `entitlements.ts` records the same defect being
fixed once before, for phases 1–4; the reason it came back is that nothing
failed, and that is now the part that changed.

**Two smaller things found on the way**

A malformed identifier in a URL answered 500 — the server blaming itself for a
truncated link, and burying real 500s. It answers 404 now, narrowed to uuid
casts so a bad numeric cast in our own SQL still surfaces. And the licence flag
grid sorted with `localeCompare`, which is not stable across ICU builds however
much the test guarding it is named "stable"; it sorts by code point now.

**Tested** — 22 OP-025 integration tests and 6 new entitlement tests, plus every
rule proved live over HTTP and in raw SQL in both directions. The ophthalmology
console is seeded for both demo hospitals with five device result types, so a
fresh database has a working console rather than an empty registry.

**Gates** — 20/20 packages typecheck, lint and test (**3,073 unit tests**);
**531 API integration tests**, up from 509; 48 migrations; 727 non-partition
tables with RLS on every business one; catalogue **1,164 keys**; event registry
**783**; entitlements **45**; roles **65**; 90 screens.

**Not built in OP-025, and tracked** — the optical shop (`optical_orders`,
§3.3), which is gated behind a hospital setting and is a counter workflow of its
own with stock and GST treatment. Half of it would be worse than none.

**Next:** OP-010 and OP-039, the procedure and OPD-nursing spine that most other
consoles call into.

### 2026-09-09 · Phase 8 · The framework thirty consoles are built on — OP-025 §0

**Built — the shared specialty console framework, complete and proved.** 5
tables, 9 permission keys, 5 events, 3 shared components, 1 admin screen, 20
integration tests. **F1–F5 all pass, tested once here and never re-tested per
console.**

**F1 — a console is data, and it cannot outrun the build**

| Attempt                                             | What happened                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| A tab naming a component nobody wrote               | Refused, naming it                                                     |
| A tab naming a deprecated component                 | Refused — existing consoles still resolve it, new registrations do not |
| A tab naming both a component and a form            | Refused — two things claiming one pane, and no way to say which wins   |
| A tab naming neither                                | Refused — that is a blank panel                                        |
| A console with no tabs                              | Refused                                                                |
| A console with no licence key to switch it off with | Refused — gate 11 needs every console to be switchable                 |
| A doctor composing one                              | 403 — it changes what a department sees on its next patient            |
| Composed only of what the build ships               | Registered, and visible to the department immediately, with no deploy  |

The mechanism is `mdm.console_components`: a catalogue synced from code at boot
exactly as `core.permissions` is, read-only to the application, with a trigger
checking every tab against it. Configuration stays free; it just cannot invent.

**F2 — a result is unreviewed until somebody says otherwise**

The technician performs and attaches; the doctor reviews. Neither can do the
other's half, in the keys or in the database, and `review` takes no request body
at all — a `reviewedBy` field would let the person who uploaded the scan record
the doctor as having read it, and the rail of unlooked-at results would be
empty forever. Reviewing before anything is attached is refused; so is
un-reviewing; so is reviving a cancelled order.

**F3 — the charge intent, and the half of the rule everybody forgets**

An order raises its intent in the same transaction. Cancelling before billing
voids it. Cancelling _after_ it has reached a bill line is refused outright —
that is a reversal with a reason, because the pair is what a credit note is made
of. The trigger sits on `billing.charge_intents`, not in the console, since
every module raises intents and only one of them would have remembered.

**F4 — signed documents** ride the existing `clinical.documents` chain rather
than a per-console copy: version 1 signed and immutable, version 2 carrying its
reason, and the digest of version 1 computed by the database and stored as
version 2's predecessor.

**F5 — one clock per leg.** Moving a patient closes the open leg and opens the
next in one call, because that is one fact and two calls would let a dropped
connection leave somebody in neither queue. A partial unique index refuses a
second open leg of the same stage.

**A defect this work found in its own fixture**

The worklist inner-joins `patient.patients`, and a cross-branch fixture made it
return nothing — correctly, because row-level security hides a patient the
reader may not see. The join stays inner on purpose: an outer one would leave
the stage on the list with a blank name, and somebody would click it.

**Tested** — 20 integration tests against a real PostgreSQL 17, plus every rule
proved live over HTTP and in raw SQL in both directions.

**Gates** — 20/20 packages typecheck, lint and test (**3,067 unit tests**);
**509 API integration tests**, up from 489; 48 migrations. The new boot guard
initially failed all sixteen existing integration suites — which is the guard
working — and is now satisfied once, in `createTenantFixture`, rather than
sixteen times.

**Next:** OP-025 the ophthalmology console, which is what proves the framework
carries a real specialty.

### 2026-09-08 (later) · Phase 7G · The discharge summary, and the four facts before a body leaves — **Phase 7 complete**

**Built — IP-002 + IP-017 (step 7G of seven), complete.** 4 tables, 16
permission keys, 8 events, 2 screens, 1 integration suite. **Exit gate 10
passes, and Phase 7 is finished.**

**Gate 10a: the summary is signed on reconciled medicines**

| Attempt                                                          | What happened                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Sign with two ward medicines undecided                           | Refused, naming the first one                                       |
| Sign with `force`, `skipReconciliation`, `override`, `emergency` | Refused — identically, five times; the trigger cannot be addressed  |
| Sign as a second, more senior login                              | Refused                                                             |
| Stop a medicine with no reason                                   | Refused                                                             |
| Stop it with a reason, continue the other                        | Both recorded, owned and timestamped                                |
| Sign                                                             | Signed, hashed, `ip.discharge.summary.signed` emitted               |
| Edit the signed summary through the draft route                  | Refused — the back door is the same trigger                         |
| Countersign as the person who signed                             | Refused — "a second check by the same person is not a second check" |
| Countersign as the second consultant                             | Accepted — the one change a signed summary takes                    |
| Amend with a reason                                              | Version 2, `supersedes_id` set, version 1 untouched                 |
| Leave against advice with four characters of explanation         | Refused                                                             |
| Leave against advice, risks and witness recorded                 | Accepted                                                            |
| The doctor marking the patient left                              | 403 — that is the ward's key                                        |
| The ward nurse marking the patient left                          | Accepted; bed released, bill locked                                 |

**Gate 10b: the mortuary**

Four facts, removed one at a time, same refusal each time:

```
  release with no certificate      → "The death certificate has not been issued for TAG-31357"
  release with the NOK unverified  → "...not to whoever came to the door"
  release with the MLC open        → "...destroys evidence that cannot be recovered"
  release with the PM outstanding  → "A post-mortem is required and has not been performed"
  certificate · NOK · MLC closed · PM done → released
```

The tag is compared at the door in both directions — receiving and releasing —
and a mismatch stops the handover naming both numbers. A resident asking for
the certificate gets 403; the ward asking for the release gets 403. Releasing
twice is refused.

**The checklist agrees with the trigger, item for item**

`GET /mortuary/cases/:id/release-checklist` reads the same four facts the
trigger reads and reports all of them at once, so the custodian can tell a
family what is outstanding. It authorises nothing. A checklist that could
disagree is worse than none: the custodian would promise a release the database
then refuses, in front of the family.

**The half of the rule that makes the other half real**

The signing gate counts unresolved rows — so if nothing ever created one, the
count would always be zero and the gate would be decoration. `POST
/ip/discharge/:id/reconciliation/prefill` assembles the three lists from the
active MAR orders and the patient's last signed prescription, every row
`unresolved`. Re-running it never reopens a medicine somebody has already
decided (D-114). A follow-up migration adds the unique index the upsert needs:
one decision per medicine per discharge, on `lower(btrim(drug_name))`, because
"metformin" from the round and "Metformin" from the chart are one drug.

**A defect this work surfaced, in Phase 1**

`scheduling.integration.spec.ts` creates slots by marching a shared counter
twenty minutes at a time, so by mid-suite two consecutive slots can be hours
apart — and when the gap straddles 18:30 UTC they land on different Asia/Kolkata
dates. The one-appointment-per-patient-per-doctor-per-day test then failed for a
reason unrelated to the rule, at certain times of day only. Both slots are now
anchored to tomorrow morning, and the clock is out of the test.

**Tested** — 23 integration tests against a real PostgreSQL 17
(`discharge.integration.spec.ts`), covering every row of both tables above plus
the bypass hunt, cross-role checks, one audit row and the registered outbox
event per mutation. Every rule was additionally proved live over HTTP and in
raw SQL, in both directions.

**Gates** — 20/20 packages typecheck, lint and test (**3,062 unit tests**);
**489 API integration tests, all passing**, up from 466 and with the Phase-1
flake fixed; **742 routes**; catalogue **1,144 keys**; event registry **773**;
714 non-partition tables outside the system schemas, the only four without RLS
being pg_partman's own `ext.part_config`, `ext.part_config_sub`,
`ext.db_capabilities` and `public._prisma_migrations`; 46 migrations; 88 screens.

**Still open, and carried forward honestly** — no Playwright golden path and no
k6 script for any Phase 6 or Phase 7 module, so none of them meets
`CLAUDE.md` §7's Definition of Done in full. Phase 7 exit gate 11 (the load
test) has not been run. This is now the largest outstanding debt in the build
and it is not shrinking on its own.

**Next:** Phase 8 — the specialty consoles.

### 2026-09-08 · Phase 7E + 7F · Intensive care, a code with a real clock, and the two-person check before the first drop

**Built — IP-009, IP-016, IP-013, IP-007, TR-006 (steps 7E and 7F of seven),
complete.** 12 tables, 17 permission keys, 6 events, 2 screens. **Exit gates 8
and 9 pass.**

**Gate 8: blood**

| Attempt                                       | What happened                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| A unit released with the screening incomplete | Refused, naming all five outstanding screens                           |
| Released with HCV still reactive              | Refused, naming HCV                                                    |
| Issued on one group sample                    | Refused — one sample cannot detect itself being mislabelled            |
| Issued on two samples that disagree           | Refused — "do not issue, re-draw both"                                 |
| Both samples drawn by the same person         | Refused — "the point of the second is that a different person drew it" |
| Issued by one person checking themselves      | Refused                                                                |
| Transfusion started with no bedside check     | Refused                                                                |
| One nurse and both scans                      | Refused                                                                |
| Two nurses but no bag scan                    | Refused                                                                |
| The same nurse recorded twice                 | Refused                                                                |
| Two nurses, wristband and bag both scanned    | The transfusion starts                                                 |

`phase-07`: the bedside check "cannot be skipped, deferred or configured away."
There is no column in the schema that could express doing so, no field in the
request, and no flag anywhere. The one deliberate exception is the massive
transfusion protocol, which issues group O negative before any of it — refusing
there would kill the patient the rule exists to protect, and that exception is
in the trigger where it can be read.

**Gate 9: the code**

A code called nine minutes ago, eight flowsheet lines written as they happened,
and the milestones derived by triggers with nobody typing a duration:

```
  to CPR   20 s
  to first shock   80 s
  to first drug   180 s
  to ROSC         420 s
```

A shock line with no joules and a drug line with no dose are refused. The code
cannot close without an outcome, and cannot close at all while the cart it used
is unrestocked — the next arrest is the reason.

**Four of five is not eighty per cent**

`icu_bundles.complete` is set by a trigger from the elements, and a VAP bundle
with four of five done comes back `false`. The literature on care bundles is
unambiguous, and a bundle scored partially is a bundle nobody completes. The
exceptions field carries _why_ an element was omitted, because a missed element
with a stated reason and one with none are different problems.

**Tested** — every rule above proved live in both directions, plus one bag
issued to two patients (refused), a reaction with no management recorded
(refused), a RASS outside the scale, and two flowsheet rows for one hour.

**Gates** — 20/20 packages typecheck, lint and test (2,953 → **2,956 tests**);
**723 routes across 65 controllers**; catalogue **1,128 keys**; event registry
**765**; 745 base tables, 0 without RLS; 45 migrations; 86 screens.

**Next:** 7G — discharge, the summary, the mortuary, and Phase 7 complete.

### 2026-09-07 (night) · Phase 7D · The theatre, a checklist that is a gate, and a load that failed

**Built — IP-006, IP-024, EN-003, TR-004 (step 7D of seven), complete.** 6
tables, 17 permission keys, 6 events, 2 screens. **Exit gates 6 and 7 pass.**

**Gate 6: the WHO checklist**

| Attempt                                     | What happened                                |
| ------------------------------------------- | -------------------------------------------- |
| Incision with no sign-in                    | Refused — the three phases run in order      |
| Incision after sign-in, before the time-out | Refused — "there is no override"             |
| A time-out with nobody's name on it         | Refused                                      |
| Incision after a named time-out             | Accepted                                     |
| Closing with no sign-out                    | Refused                                      |
| Closing with the counts not recorded        | Refused — "a retained swab is a never event" |
| Closing with a swab unaccounted for         | Refused, naming the gap                      |
| The same, with a recorded resolution        | Accepted, discrepancy flag still true        |
| Counts reconciling                          | Accepted, discrepancy false                  |

The three phases are columns, not rows in a configurable list. `phase-07`:
"Configuration may add items but may never remove or bypass the three phases" —
and a configurable list can be configured to nothing. Extra items live in the
JSON beside the timestamps and can be added freely; the floor is in the shape.
There is no `ot.checklist.bypass` permission, and a test fails if one is ever
added.

An emergency case bumps an elective one with a recorded reason on both rows. It
does not get a shorter checklist, because the whole point of the checklist is
that it applies at 2 a.m.

**Gate 7: a load that failed its biological indicator**

Bowie-Dick tests the vacuum. The chemical strip says the pack was exposed. Only
the biological indicator says the spores died, and it takes hours — which is why
a load sits in quarantine. Issuing from a quarantined load was refused; releasing
with the BI pending was refused; after a pass, three sets went to a case. The BI
was re-read at 24 hours as a fail, a fourth issue was refused, and the recall
query returned the three sets, the case and the patient.

That query is why the issue table records the case and the patient rather than
"issued to theatre 1". It is the list somebody needs at 6 a.m. and cannot
reconstruct from paper.

**Tested** — every rule above proved live in both directions, including one tray
in two theatres at once (refused by a partial unique index, because the recall
list would otherwise name the wrong patient) and a recall with no note.

**Gates** — 20/20 packages typecheck, lint and test (2,950 → **2,953 tests**);
**702 routes across 64 controllers**; catalogue **1,111 keys**; event registry
**759**; 733 base tables, 0 without RLS; 44 migrations; 82 screens.

**Next:** 7E — ICU, HDU, the crash cart and code blue.

### 2026-09-07 (evening) · Phase 7C · IP billing, and the job you can run three times

**Built — IP-005 (step 7C of seven), complete.** 4 tables, 7 permission keys, 4
events, 1 screen. **Exit gate 3 passes.**

**The single line the whole step turns on**

```sql
CREATE UNIQUE INDEX uq_room_charge_idempotency
  ON ip_room_charges (admission_id, charge_date, charge_code,
                      COALESCE(occupancy_id, '00000000-…'))
  WHERE superseded_at IS NULL;
```

`phase-07` calls duplicate room rent "the single most common source of billing
disputes in Indian hospitals; test it like money depends on it, because it
does." A job that is _careful_ not to duplicate is a job that duplicates the
night somebody restarts it mid-run, or two workers overlap, or a retry fires
after a timeout that had actually succeeded. A unique index cannot. The job's
`ON CONFLICT DO NOTHING` makes a re-run cheap; the index makes it correct.

**Gate 3, driven twice — in SQL and over HTTP**

Three runs against the same admission: `posted 0, skipped 4` every time, bill
identical at ₹33,000. Then the harder half. A back-dated transfer moved the
patient to ICU at 23:50 on the 5th, discovered after the charges were posted.
The job superseded the charge the timeline had moved out from under, posted the
two ICU nights, and three further re-runs produced the same ₹33,000 — with the
superseded line still in the table.

That retention is deliberate. "What did you charge me on Tuesday" must have an
answer even when the answer was wrong, and deleting the row to make room for the
correction destroys exactly the record a dispute needs. A posted charge is
immutable: the trigger permits being superseded and nothing else.

**GST as arithmetic the database checks**

ICU, HDU, NICU and PICU are exempt by statute; a room at or below the configured
threshold is exempt by threshold; anything above is taxed at 5% on the room line
only. Three CHECKs hold it: an exempt line states its ground, an exempt line
bears no tax, and the tax equals the rate applied to the amount within two
paise. That last one catches the error that survives a hundred bills and then
arrives as an assessment.

**The discharge gate recomputes before it clears**

Four checks — outstanding doses, live lines and catheters, open escalations, the
bill — each a query run now. Clearing against a snapshot from a minute ago is how
somebody leaves over a test billed while they were putting their shoes on. The
override exists, takes an `x-reason` _and_ a written acknowledgement of what the
family were told, and is audited with the reasons it bypassed: a patient who
insists on leaving is leaving, and the question is whether the hospital wrote
down that it knew.

**Tested** — three identical runs and three more after a back-dated transfer,
both in SQL and over HTTP; the immutability trigger, both GST CHECKs and the
clearance constraints proved in both directions; the gate driven blocked →
refused clear → refused override without a reason → overridden with one.

**Gates** — 20/20 packages typecheck, lint and test; **686 routes across 63
controllers**; catalogue **1,094 keys**; event registry **753**; 727 base tables,
0 without RLS; 43 migrations; 80 screens.

**Next:** 7D — operation theatre, the WHO checklist as a hard gate, anaesthesia
and CSSD.

### 2026-09-07 (later) · Phase 7B · The nursing station, the five rights, and a near miss that survived its own refusal

**Built — IP-003, IP-004, IP-014, IP-012, EN-029, EN-039 (step 7B of seven),
complete.** 12 tables, 21 permission keys, 10 events, 2 screens. **Exit gates 4
and 5 pass.**

**Gate 4: the five rights, driven over HTTP**

| Attempt                                  | What happened                                                       |
| ---------------------------------------- | ------------------------------------------------------------------- |
| Given before pharmacy verified the order | Refused — the verification stands between the order and the ward    |
| Wrong patient's wristband scanned        | Refused, and recorded as a near miss                                |
| Wrong drug barcode scanned               | Refused, naming the expected barcode and the one read               |
| Insulin with no second nurse             | Refused — "there is no override for this"                           |
| Insulin witnessed by the nurse giving it | Refused — "a second check by the same person is not a second check" |
| Both scans, a genuine second nurse       | Given                                                               |

Every one of those is refused twice: once by the service, with a message naming
what was expected, and once by the database, which will not accept a `given` row
without both scan payloads, without a witness on a high-alert drug, with a
witness who is the administering nurse, or against an unverified order. There is
no column in the schema that could express a bypass, no flag in the API and no
field in the request that stands in for a scan.

**The near miss that was being erased by the refusal that caused it**

Recording a wrong-drug scan inside the administering transaction meant the
refusal rolled it back. The safety record was lost precisely _because_ the
control worked, which is the worst possible failure of a near-miss register. The
mismatch now throws out of that transaction and is written in one of its own
before the refusal is returned. Two mismatches, driven over HTTP, both present
in the outbox and the audit log afterwards.

**Gate 5: escalation climbs with no browser open**

`ip_news2_escalations` holds its own `due_at` and its own rung. One statement
walks overdue, unanswered rows and climbs: nurse → senior nurse → RMO →
consultant → rapid response, each rung recorded in the row's own ladder with the
time it went unanswered. Proved by raising an escalation an hour in the past and
running the worker's statement four times with nothing open anywhere.

One live escalation per admission, enforced by a partial unique index: a second
ladder on one patient means both climb slowly and the second resets the clock
the first had earned.

**The band is a function of the score**

`risk_band_follows_the_score` computes what the band should be and refuses
anything else. Braden runs backwards — lower is worse — and that inversion is
what gets miscoded: a Braden of 12 filed as "low risk" is a pressure sore in
five days. A high band with no interventions is refused too, because an
assessment nobody acted on is a form.

**Tested** — every constraint proved live in both directions; the drug round
driven end to end over HTTP through all six attempts above; the ladder climbed
four rungs; near misses confirmed present after the refusals that produced them.

**Gates** — 20/20 packages typecheck, lint and test (2,945 → **2,948 tests**);
**679 routes across 62 controllers**; catalogue **1,087 keys**; event registry
**749**; 723 base tables, 0 without RLS; 42 migrations; 79 screens.

**Still missing:** no e2e golden path and no k6 script; the nursing PWA's offline
queue (IP-004) is specified but not built; exit gates 3 and 6–12 belong to steps
7C–7G.

**Next:** 7C — IP billing, the midnight room-charge job, and the discharge
clearance gate.

### 2026-09-07 · Phase 7A · Beds, admissions, turnover — and the board that is a query

**Built — IP-001, IP-018, NC-018, IP-025 (step 7A of seven), complete.** 10
tables, 26 permission keys, 9 events, 3 screens. **Exit gates 1 and 2 pass.**

**Gate 1: fifty concurrent claims on one bed produce exactly one admission**

Fifty psql processes fired the same allocating transaction at the same bed. One
occupancy, one admission, bed occupied. The lock does the work —
`SELECT … FOR UPDATE SKIP LOCKED`, and `SKIP LOCKED` is the important half:
two admissions happening at once each get _a_ bed rather than queueing for the
same one and having the loser fail. Behind it sits a GiST exclusion constraint
on `(bed_id, tstzrange(from_at, to_at, '[)'))`, proved separately by inserting
straight into the table with no lock taken and again with a back-dated
overlapping range. Both refused.

The range is half-open on purpose. A patient leaving at 14:00 and another
arriving at 14:00 is a normal turnover; closed-closed would refuse it and send
somebody looking for a bug that is not there. Tested, and accepted.

**Gate 2: the board is a query, so rebuilding it is a tautology**

There is no `beds_free` column anywhere in this phase and there will not be
one. `clinical.v_bed_board` reads `ip_bed_occupancies` on every request, and the
census is a `count(*) FILTER` over that view. A counter drifts the first time a
transaction rolls back after incrementing it, and the drift is invisible until
somebody is sent to a bed with a patient in it.

Occupancy divides by _usable_ beds. A twenty-bed ward with four blocked for
maintenance is at 16/16, not 16/20 — reporting the second makes a full ward look
like it has room, at exactly the moment somebody is trying to find a bed.

**The cleaning gate, and why it has an exception**

A bed cannot go from `occupied` to `available` without a completed clean; the
trigger refuses it. Returning to `available` from `reserved` or `blocked` is
allowed, because nobody has been in the bed. The override — a bed vacated for
ten minutes for a portable X-ray — costs a stated reason recorded on the bed
row, and is held by the nurse supervisor alone. Without the exception the rule
gets worked around by marking a fake clean, which is worse, because it looks
like a clean.

**Six rules, all proved live in both directions**

| Rule                                            | The failure it prevents                                  |
| ----------------------------------------------- | -------------------------------------------------------- |
| One patient per bed per moment                  | Two patients sent to one bed                             |
| A bed is not available until it is cleaned      | The next patient put into an unmade bed                  |
| An occupancy ends after it starts, and says why | A census that cannot distinguish transfer from discharge |
| A discharged admission holds no open occupancy  | A patient who went home still counted in the ward        |
| A hold expires, and only one is live per bed    | Two people each told the bed is theirs                   |
| A blocked bed states its reason                 | A bed missing from the estate with no explanation        |

**Deposits and paperwork are recorded, never enforced.** There is no pay-first
gate anywhere (Parmanand Katara). A shortfall raises
`admission.deposit.short` for the cash desk; an ER fast-track admission carries
`registration_complete = false` and is treated regardless. Both are shown on the
admitted list as prompts, not barriers.

**Gates** — 20/20 packages typecheck, lint and test (2,929 → **2,945 tests**);
**656 routes across 61 controllers**; catalogue **1,066 keys**; event registry
**739**; 711 base tables, 0 without RLS; 41 migrations; 77 screens.

**Still missing:** no e2e golden path and no k6 script; exit gates 3–12 belong to
steps 7B–7G and are not yet built.

**Next:** 7B — nursing station, MAR with the 5 Rights, assessments, NEWS2
escalation, nursing mobile, infection control.

## Phase 6 complete — 2026-09-06

Nine modules: OP-006 ER intake, TR-001 triage and trauma activation, TR-008 MLC
and forensic, TR-009 + NC-013 pre-hospital and ambulance fleet, TR-002 + OP-009
fracture registry and orthopaedic OPD, TR-003 implant traceability, TR-005 cast
and traction, TR-007 the polytrauma coordination board.

**Gates** — 20/20 packages typecheck, lint and test (**2,929 tests**); **637
routes across 60 controllers**; catalogue **1,040 keys**; event registry **730**;
**701 base tables, 0 without RLS**; 40 migrations; 74 screens. Hex-literal,
chart-palette, gate-script, alert-runbook, permission-key and prettier clean.

**Still missing across the whole phase:** no e2e golden path and no k6 script
for any of the nine modules, so none meets `CLAUDE.md` §7's full Definition of
Done — the same gap every module in this repo currently has. Exit gates 1–10
were driven by hand against the live database and over real HTTP; gate 11
(500 visits/day and a 100-casualty surge under the stated budgets, k6 committed)
has not been run.

### 2026-09-06 (night, later) · Phase 6 · TR-007 the polytrauma board — and four roles that could not call anything

**Built — TR-007, complete.** 9 tables, 17 permission keys, 8 events, 2 screens.
**Exit gate 10 passes**: three competing procedures sequenced, consent tracked
per procedure, blood reconciled against what the bank has actually reserved, and
an SLA-breached consult escalating.

**One rule, and everything else defends it**

A polytrauma patient has six problems and six owners. What kills them is usually
not any single injury: it is that neurosurgery, orthopaedics and general surgery
each have a correct plan and nobody sequenced the three. So life-saving before
limb-saving before definitive is a deferred constraint trigger, not a sort
order. A femoral nail scheduled ahead of a laparotomy for a bleeding spleen is a
patient who dies with a beautifully fixed femur.

| Rule                                             | What it prevents                                           |
| ------------------------------------------------ | ---------------------------------------------------------- |
| Life-saving before limb-saving before definitive | Two correct lists merged by whoever reached the whiteboard |
| Theatre needs a _settled_ consent                | Wheeling in on "consent sought", which is nobody's answer  |
| A waiver covers only a life-saving procedure     | "Nobody could be asked" stretched over an elective plate   |
| Reserved units, not cross-matched ones           | A laparotomy that stops halfway                            |
| `due_at` is the database's arithmetic            | An SLA the client can be wrong about                       |
| An escalation names who it went to               | "We escalated it", which cannot be checked                 |
| A board cannot close over unfinished work        | A closed board with three procedures nobody picked up      |

All seven proved live in both directions, and again over HTTP.

**The deferred trigger had to read the table, not the row**

First attempt judged each `NEW` image as the statement produced it. Reordering a
list means updating every row, and the intermediate states are legitimately out
of order — a shift-by-ten before placing each row is a normal way to move under
a unique index. An `AFTER` trigger's `NEW` is frozen at its statement, so the
final, correct arrangement was refused while the stale image was judged. It now
checks the whole case at COMMIT by reading the table.

**And adding a procedure had to place it, not append it**

Appending made the obvious thing impossible: a board with a definitive nail on
it, then somebody adds the laparotomy — the append lands behind the nail and the
ordering trigger refuses it. Where a _class_ sits is not a surgical judgement, so
the queue arranges that itself; which of two laparotomies goes first is, and
that is what `resequence` is for.

**A permission that could be reached by sending a different field**

`polytrauma.consent.waive` is `high` risk and held by three consultant roles. A
resident holding only `polytrauma.consent.record` recorded a waiver by sending
`state: "emergency_waiver"` to the ordinary consent route — the narrow key was
reachable through the wide one. The waiver now has its own route, its own
schema and no `state` field at all: reaching the route _is_ the state.

**Four roles could not call a single endpoint, and had not been able to for two phases**

Driving TR-007 as a blood bank officer returned 403 on `GET /polytrauma` — a
plain read. `pharmacist_op`, `pharmacist_ip`, `pharmacy_incharge` and
`blood_bank_officer` all carried `abacDefaults: { requiresSecondPerson: true }`,
added in Phase 4 meaning "this pharmacist is a valid co-signer". That is not
what the flag does. `evaluateConditions` reads it as "this actor must supply a
co-signer for **every** request", and `PolicyGuard` never supplies one — so
`GET /inventory/items` returned 403 for a pharmacist and 200 for a nurse. The
entire Phase 4 pharmacy module was uncallable by pharmacists, and every test
stayed green because no test drove a route as one of them.

Two-person verification is a property of an action, not of a person. The flag is
gone from all four templates; `requiresSecondPerson` on the _permission_ already
expresses it, and `Permission()` has refused to let such a key become a route
decorator since Phase 4 for the same underlying reason. Two existing tests
asserted the mistaken belief and now assert what actually holds; a third
(`registry.spec.ts`) fails if anybody puts it back on a role.

**Tested** — every constraint above live in both directions; the board driven
end to end over HTTP (opened → three procedures self-ordering by class → the
nail moved to the front and refused → reorder without a reason refused → waiver
bypass refused → consent without a name refused → consent with no risks refused
→ theatre refused on 2 of 6 units → the bank reserves 6 → theatre → consult
escalated early with grounds, and a breached one escalated without) and both
screens driven in a real browser, the only console error being the expected 409.

**Next:** Phase 7 — inpatient.

### 2026-09-06 (night) · Phase 6 · TR-003 + TR-005 — the recall list, and the limb inside the plaster

**Built — TR-003 and TR-005, complete.** 9 tables, 19 permission keys, 9 events,
3 screens. **Exit gate 8 passes**: given a lot number, the register returns the
exact patients carrying that device — by device, side, surgeon and date — and
says how many of those records were typed rather than scanned.

**The whole module is one query, and everything else defends it**

`phase-06` calls the trace "the single most important test in this deliverable".
A hip-stem recall with an incomplete list is people still walking on a withdrawn
device. So each rule below exists because it is a way the list comes back short:

| Rule                                                          | The short list it prevents                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| A device is booked in with a serial **or** a lot              | A device with neither can never be found by a notice                  |
| A catalogue entry carries a UDI **or** a catalogue number     | An entry nobody can look up                                           |
| One catalogue row per UDI-DI per hospital                     | Two rows for one device → the notice matches one and misses the other |
| Scanned means a payload; unscanned means stated grounds       | A serial typed from memory, unexplained and unmatchable               |
| An implanted device cannot return to `available`              | One device given to two patients                                      |
| An implant record is never deleted, its patient never changed | The only evidence of what is inside somebody                          |
| A recall names a device or a list of lots                     | A notice that cannot produce a patient list at all                    |
| `unreachable` needs two recorded attempts                     | A phone call nobody made twice                                        |
| A recall cannot close while anybody is `pending`              | A notice closed with people uninformed                                |

All nine are triggers, CHECKs or partial unique indexes, proved in both
directions against the live database and again over HTTP.

**The number that is never hidden.** The trace reports `2 patients, 2 still
carrying it, 1 entered by hand — those serials were typed, not scanned`. "11
patients" reads as a finished answer; the unscanned count is the confidence
interval on it, and a recall desk that cannot see it will treat a short list as
a complete one.

**TR-005 — the database decides what a red flag is.** `cast_checks.red_flag` is
computed by a `BEFORE INSERT` trigger from the findings, and a check that raises
one and records no action is refused. Submitting `red_flag: false` alongside
pain on passive stretch and paraesthesia still stores `true` — the form does not
get a vote. The screen predicts the same rule so the question "what did you do
about it?" appears the moment a finding is ticked, before the submit rather than
after the refusal; that is the explanation, not the enforcement.

A clear check buys twenty-four hours. **A red flag brings the next look forward
to one hour** — bivalving a cast is a measure whose effect has to be looked at
again while there is still time to act, and leaving the limb on tomorrow's list
is how the second look does not happen.

**Six defects found by driving it, five of them in this module's own schema**

1. `cast_requests.weight_bearing` was `VarChar(16)`, too narrow for
   `non_weight_bearing` — and wrong in kind. TR-002 already has a `WeightBearing`
   enum. A cast recording "PWB" while the plan says `nwb` is two instructions for
   one leg, so it is now the same enum, not a string beside it.
2. The laterality trigger printed `<NULL> <NULL>` when the request row did not
   exist. It now returns early and lets the foreign key speak, which states the
   actual problem.
3. `implant_catalogue.catalogue_no` was `NOT NULL`, forcing a local number to be
   invented for an imported device that carries only a UDI. Now nullable, with a
   CHECK that one of the two is present.
4. No unique index on `(hospital_id, udi_di)` — the exact way a recall list
   splits in half. Added, partial, because most local consumables have no UDI.
5. `implant_usages.side` was optional in the request schema and `NOT NULL` in the
   table. Required now: `not_applicable` is a statement, a blank is an omission,
   and laterality is the one field this module will not let go unstated.
6. Three Postgres parameter-type failures (`$3` compared against a literal and
   cast to an enum; `$12` in a bare `CASE WHEN … IS NULL`) that surfaced only as
   500s under real traffic.

**A seventh defect, outside this module.** `inSituOnly` was declared
`z.boolean()` on a query schema, so `?inSituOnly=false` arrived as the string
`"false"` and was rejected. Swept the repo: three more query schemas had it —
`leakage.isActive`, `vitals.patientInformed`, and `inventory.carriesBatchExpiry`
/`isPrimary`, the last two of which were `z.coerce.boolean()`, which is worse
because it coerces `"false"` to `true`. All four now use the `queryFlag()`
helper.

**Tested** — every constraint above proved live in both directions; the recall
driven end to end over HTTP (opened → 2 patients identified → close refused with
both pending → one unreachable refused on the first attempt, accepted on the
second → one reviewed → closed); the cast flow driven likewise (wrong-side
request refused, wrong-side application refused, red flag with no action
refused, red flag submitted as `false` stored as `true`, early removal by the
surgeon with grounds, ward nurse refused the removal key); and all three screens
driven in a real browser with zero console errors.

**Gates** — 20/20 packages typecheck, lint and test (2,919 → **2,925 tests**);
**618 routes across 59 controllers**; catalogue 1,004 → **1,023 keys**; event
registry → **722**; hex-literal, chart-palette, gate-script, alert-runbook and
permission-key all clean.

**Still missing, same as every module here:** no e2e golden path and no k6 script
for TR-003 or TR-005, so neither meets `CLAUDE.md` §7's Definition of Done.

**Next:** TR-007 (polytrauma coordination board), which completes Phase 6.

### 2026-09-06 (late) · Phase 6 · TR-002 + OP-009 — the fracture registry, and the wrong-site rule

**Built — TR-002 and OP-009, complete.** 12 tables, 16 permission keys, 6
events, 2 screens. **Exit gate 7 passes**: an open right tibial shaft
registered from the ER as `42-B2.1`, Gustilo IIIA, with the antibiotic clock
deliberately breached at 82 minutes and the breach appearing as a recorded fact
rather than a computed opinion.

**The module has one real database opinion, and it is laterality.** Wrong-site
surgery in orthopaedics is almost always a side error that survived four
handoffs — the note says left, the imaging order says right, the consent says
left, the theatre list says right, and each of four people assumed one of the
others had checked. Every one of those documents is written by a different
module.

So `side` is NOT NULL, **`bilateral` is not a value** (two limbs are two
entries, because a plan, a cast and an implant each belong to one of them), and
a plan carries its _own_ side so the database can compare the two. Storing it
once and joining would make the mismatch unrepresentable **and unnoticeable**,
and unnoticeable is the failure. Proven over HTTP: a left-sided nail on a
right-sided fracture comes back 409 naming both sides and the bone.

The screen does the cheap half: side is a badge, in colour _and_ in words, in
the same position on every row and at the top of every record. And the plan
form makes you _choose_ the side rather than pre-filling it — pre-filling would
make the two agree by construction and remove the only check that catches the
surgeon looking at the wrong patient's film.

**The antibiotic clock runs from arrival, and the breach is stored.** Measuring
from diagnosis would make a four-hour wait for an X-ray invisible, which is
exactly the delay the indicator exists to find. `fx_open_bundle.arrived_at` is
recorded at registration so the breach cannot be argued away later by re-dating
the diagnosis, and a trigger recomputes the breach list on every write — this
service gets no say in whether the hour was met.

**Constraints proven live**, both directions where it matters: a left plan on a
right fracture (refused) and the right one (accepted); confirming an open
fracture with no Gustilo grade; a Gustilo grade on a closed one; an AO type
outside A/B/C; a subgroup with no group; confirming a fracture classified only
to segment; Salter-Harris on an adult skeleton; a bundle attached to a closed
fracture; non-union with no grounds; union with no date; a union dated before
the injury; editing a version snapshot; a film dated before the injury; and a
RUST score of 15 on a scale that stops at 12.

**Two things the build got wrong and the repo caught.**

`fracture.union.declare` was written `requiresReason`, so _every_ union
declaration demanded a written justification — including a fracture that healed
at fourteen weeks. That teaches people to type "healed" into a reason box,
which then means nothing on the declaration that genuinely needs grounds. The
reason is now asked for where the six-month rule actually applies, and the
screen spec asserts the absence.

And an existing repo-wide invariant — "never grant a `.read` whose sibling
`.list` is withheld, because the role has no way to obtain the id" — failed on
the radiologist and the therapist. A test written for Phase 4 caught a Phase 6
grant, which is the whole point of writing it against every template rather
than against its own phase.

**A third mis-anchored grant, and a general guard for it.** For the second
time, a scripted edit anchoring on `permissions: [` skipped a role whose array
is on one line and landed orthopaedic keys on a **dialysis technician**.
`phase6-grants.spec.ts` now declares every Phase 6 permission prefix against
the roles allowed to hold it, so a grant that lands anywhere else fails the
build — and a prefix with no entry fails too, which is how it immediately
flagged that OP-006's `er.*` keys had never been reviewed against a list.

**Gates** — 20/20 packages typecheck, lint and test (**2,919 tests**); 596
routes across 72 controllers; catalogue **1,004 keys**; event registry **713**;
688 tables, **0 without RLS**; 36 migrations; 72 screens.

**Still missing:** no e2e golden path and no k6 script; no AO/OTA catalogue
table, so the code is range-checked rather than validated against the published
group and subgroup list; imaging auto-attach is a flag on the row rather than a
matcher, because OP-008's study metadata is not wired to it yet.

**Next:** TR-003 (implant traceability), TR-005 (cast and splint), TR-007
(polytrauma board).

### 2026-09-06 (evening) · Phase 6 · TR-009 + NC-013 — the ambulance, and exit gate 1

**Built — TR-009 and NC-013, complete.** 20 tables (13 in a new `ops` schema,
7 in `clinical`), 25 permission keys, 8 events, 2 screens. **Exit gate 1
passes**, and it passes as a database fact rather than a demo: the crew's last
road observations — HR 126, SBP 86, RR 32, SpO₂ 91, GCS 9 — arrived in the ER's
first triage record _identically_, with nothing retyped, and the handover row
records which triage record it made.

**Three design decisions worth the words.**

_One trip table, not two._ TR-009 §4 specifies `ph_trips` beside NC-013's
`fleet_trips`, sharing about twenty fields. Both modules report on the same
milestone timestamps — NC-013 for the response-time SLA, TR-009 for the offload
interval — and two rows holding those times is two answers to "when did it
arrive", decided by whichever screen the user happened to open. There is one
`ops.fleet_trips`; the clinical record hangs off it. A trip carrying nobody (a
mortuary standby, an event cover) simply has no PCR, which the spec's shape
cannot express.

_A new `ops` schema._ The first non-clinical operations schema, and Phase 9's
housekeeping, laundry, canteen, gate and biomedical belong in it too. The split
is where the data class changes: a vehicle's insurance expiry is not PHI, a
patient's road blood pressure is.

_No PostGIS._ It is not on `CLAUDE.md` §2's locked list and not in the on-prem
image. Coordinates are `numeric(9,6)` and distance is `ops.haversine_km()` —
Bengaluru to Mysuru comes out at 128.017 km against a 128 km straight line, and
that is orders of magnitude better than the GPS fix it is fed.

**The carry needed a third triage state, and finding that out was the
interesting part.** Writing the road observations as a triage record hit
TR-001's `triage_has_a_category`, whose own comment reads "a record with neither
[a level nor a tag] is not a triage". Both rules were right. The crew cannot
assign an ESI level — its decision points are a resource count and a "would I
give them my last bed?" judgement, neither of which is a roadside observation —
and having the server guess them is precisely the failure
`packages/contracts/scores` exists to prevent. Discarding the observations and
asking the nurse to retype them is the transposed digit exit gate 1 exists to
eliminate. So `source = 'prehospital_handover'` names the honest third state:
observations in, category pending. The nurse's triage arrives as sequence 2 and
**both survive**, which is what TR-001 already does with every re-triage.
`er_visits.esi_level` and `triaged_at` stay null — the patient is not triaged
until somebody triages them, and the board still shows them waiting.

**Eight constraint groups proven live**, including: dispatching an ambulance
whose fitness certificate lapsed three weeks ago (refused, naming the document
and its date); a trip that arrived before it left; an odometer that ran
backwards; billing a 108 trip to the patient (refused) and the same trip left
`pending` (silently made `not_billable`); posting a bill on a flagged distance;
a diversion with no reason; a handover to nobody, signed by one side only, and
with morphine unreconciled; correcting or deleting a road observation; a verbal
GCS on an intubated patient; rewriting an ATMIST after the patient arrived
(refused) versus appending an update (allowed); and completing a trip on an
unsigned record — while a trip carrying nobody completes freely.

**Two gaps found by driving it.** The receiving team held
`prehospital.prealert.read` and had no endpoint to list what was inbound — only
the fleet board carried it, behind a fleet key, so seeing who was coming would
have meant giving a triage nurse the dispatch console. `GET
/prehospital/inbound` now serves the ER on its own key. And a raised pre-alert
could only be closed by arrival or diversion, so a cancelled crew left an
inbound patient on the ER board holding a bay for ever; there is a stand-down
now, and it releases the bay.

**A defect that would have stopped a fresh clone.** `apps/web`'s server routes
default `API_ORIGIN` to `http://127.0.0.1:3001` — written out three times —
while `infra/env.example` sets `API_PORT=4000` and never mentions `API_ORIGIN`.
Following the documented setup produced a login page returning 500 with
`ECONNREFUSED 127.0.0.1:3001`, a message that says nothing about the actual
mistake and appears only when the environment is _correct_. One module now
derives the default from `API_PORT`, and `infra/env.example` documents the
override.

**Gates** — 20/20 packages typecheck, lint and test (**2,909 tests**); 579
routes across 71 controllers; catalogue **988 keys**; event registry **707**;
676 tables, **0 without RLS and 0 without a tenant policy**; 35 migrations.

**Still missing:** no e2e golden path and no k6 script. GPS positions are
recorded and partitioned monthly but no telematics provider is wired, so the
breadcrumb trail is whatever the tablet reports — which is why the demo trip
closed with `distance_flagged`, correctly, on a 2.56 km GPS track against a
27 km odometer. Trip billing emits the event NC-013 prices from; the RC-003
tariff join is Phase 9's.

**Next:** TR-002 + OP-009 (fracture registry and orthopaedic OPD), then TR-003,
TR-005, TR-007.

### 2026-09-06 (later still) · Phase 6 · TR-008 the MLC register, and three defects it found

**Built — TR-008, complete.** 12 tables, 22 permission keys, 12 events, 2 screens.
**Exit gate 6 passes**: an assault case auto-suggested from the mechanism, the
police intimation generated, carried and signed for by HC Ramesh Kumar
(KA-4471) 56 minutes inside the one-hour target, evidence sealed with a
verifiable hash chain, the wound certificate signed with a DSC and corrected by
addendum, a certified copy issued into the numbered register — and **discharge
blocked** until the set was complete, with an MS override that is recorded on
the case rather than only in an audit row.

**The evidence chain is a chain.** `mlc_custody_log` is append-only with
`prev_hash` → `hash` computed **by the database** from the row's own content.
The proof that matters: an insert supplying `seq = 99`, `prev_hash = 000…` and
`hash = fff…` was stored as `seq = 4` with the real predecessor's hash and a
digest Postgres computed itself. An application that never supplies a hash
cannot forge a link, which is a different claim from "our service is
consistent with itself" — and it is the one a court asks about. UPDATE and
DELETE are refused by trigger _and_ revoked from `hms_app`.

**Three findings that cannot be recorded.** The sexual-assault proforma has no
field for a two-finger test, for "virginity", or for "habituated", and a trigger
refuses a proforma whose JSON carries those keys under any spelling — including
"per vaginum finger". The two-finger test was held unconstitutional in
_Lillu v. State of Haryana_ (2013) and its practice criminalised in
_State of Jharkhand v. Shailendra Kumar Rai_ (2022). A validation warning would
leave a field somebody can still fill in and a warning somebody can dismiss.

**Twenty-four constraints proven live.** Reopening a cancelled MLC, changing an
MLC number, deleting a case, cancelling one that already has a final report, a
sexual-assault case not flagged sensitive, an MLC attached to nobody, editing or
deleting a custody entry, a transfer with nobody on the receiving end, a
handover to the police naming no officer, a broken seal with no note, rewriting
a photograph's hash, replacing the file it names, re-sealing without a custody
entry, a photograph with no digest, editing a signed certificate, a final report
signed by nobody, a DSC-final with no certificate reference, an addendum with no
reason, a POCSO case where the police were not informed, one with no SJPU/CWC
intimation, billing a sexual-assault survivor, issuing an MCCD before the
post-mortem decision, releasing a body with no police NOC, and releasing the
chart with no court order.

**And three defects TR-008 found in code that was already green.**

1. **The seeder never withdrew a grant.** `core.role_permissions` was upserted
   and never pruned, so a permission removed from a system role template stayed
   granted in every seeded database for ever, silently. It surfaced because a
   scripted edit anchored on `permissions: [` skipped a role whose array is
   written on one line, and `MLC_SECURITY` — which carries
   `mlc.evidence.handover` — landed on **kitchen staff**. Nothing failed: lint
   passed, types were fine, the seed wrote the rows. Moving it in code fixed the
   template and left the database exactly as wrong. The seeder now deletes
   grants no template names, scoped hard to system roles, and says so in the
   log. `phase6-grants.spec.ts` is the general form of the check: a PHI-classed
   medico-legal key on a non-clinical role fails the build, with a named
   allowance list for the two legitimate exceptions.

2. **A cross-module trigger refusal came back as HTTP 500.** TR-008's discharge
   gate fires on `er_dispositions`, inside **OP-006's** service, whose error
   mapper had never heard of SQLSTATE `TR008`. The rule worked perfectly and the
   person at the desk saw "Something went wrong on our side" instead of the
   sentence naming exactly what was outstanding. There is now one shared
   `MODULE_SQLSTATES` set that all seven module mappers consult, because a
   trigger fires where the write happens and not where the rule lives.

3. **`mlc.sensitive.write` without `read` made the examiner work blind.** The
   emergency physician could record the MoHFW protocol and then not read it
   back — which would mean re-taking a history the survivor had already given
   once. Both halves now, for the roles that examine; the restriction that
   matters is that it is a separate, reason-required, two-approver key the rest
   of the floor does not hold. The ER nurse and MRD still get a **404** for a
   restricted case — deliberately the same answer as for a case that does not
   exist, because confirming that a sexual-assault case exists for this patient
   is itself the disclosure.

**Nothing here can gate treatment**, and not by policy: no table in TR-008
references an order, a prescription, a procedure or a bill, so there is nowhere
to attach a clinical block. _Parmanand Katara v. Union of India_ (1989) is
honoured by construction. The one gate sits on the ER **disposition** — the way
out of the department, never the way in — and death and abscondment are exempt
from it, because a body and a patient who has already left are not held by
paperwork.

**Gates** — 20/20 packages typecheck, lint and test (**2,905 tests**); 550
routes across 70 controllers; catalogue **963 keys**; event registry **699**;
656 tables, **0 without RLS and 0 without a tenant policy**; 33 migrations.

**Still missing:** no e2e golden path and no k6 script for TR-008. Photographs
are registered with a client-computed digest and a WORM object key, but the
upload itself and the S3 object-lock bucket are not wired — the module records
the hash and the chain, not the bytes.

**Next:** TR-009 + NC-013 (pre-hospital and ambulance), then TR-002 + OP-009,
TR-003, TR-005, TR-007.

### 2026-09-06 (later) · Phase 6 · TR-001 triage, the trauma team and the golden hour

**Built — TR-001, complete.** 8 tables, 19 permission keys, 10 events, 3 screens.
The scoring itself went into `packages/contracts/src/scores/` rather than the
service, so the tablet and the server run the same function: `scoreGcs`,
`scoreEsi`, `scoreRts`, `scoreIss` (with NISS), `shockIndex`, `scoreMgap` and
`scoreTriss`, 37 tests against published worked examples. The triage screen
renders a level as the observations are typed and then replaces it with what the
server computed. Nothing computed is ever accepted from a client — `phase-06`'s
"never let a UI compute a score the server does not agree with", enforced by
there being no field to send one in.

**Driven end to end over real HTTP.** A motorcyclist ejected at speed: triaged
ESI 1 at decision point A, level-1 team called, 7 roles paged, orthopaedics
answered in 17 s with a 6-minute ETA, primary survey with a tourniquet at 95
minutes (warning at 90, critical at 120), 5 injuries coded, and the scores came
back **RTS 5.8806 · ISS 34 · NISS 34 · shock index 1.56 · MGAP 21 · GAP 17 ·
TRISS 85.3% on MTOS blunt** — every figure matching the hand calculation.

**Twelve constraints proven live**, in both directions where that matters:

| Refused                                           | Because                                                       |
| ------------------------------------------------- | ------------------------------------------------------------- |
| Rewriting or deleting a triage record             | The first triage is the only evidence the wait was reasonable |
| A second triage at a new level                    | _Accepted_ — re-triage is a new record, and both stay         |
| An ESI record carrying a START tag                | One ladder's answer per record, or the board is a coin toss   |
| A verbal GCS on an intubated patient              | A GCS one point out is a level-2 called as a level-1          |
| Creating a level-1 page suppressed                | §6.3, and no configuration reaches it                         |
| Suppressing a level-1 page afterwards             | The same rule, from the other direction                       |
| Silencing a **level-2** page                      | _Accepted_ — the rule is about level 1 only                   |
| An activation with neither criteria nor judgement | Both are legitimate; recording neither is not                 |
| A stand-down with no reason                       | A silent stand-down is how the next page gets ignored         |
| Editing, unlocking or deleting a locked score     | Mortality review has to be able to ask, either way            |
| An amendment with no reason                       | Two numbers and no account of the difference                  |
| A NISS below its ISS                              | Arithmetic, not policy                                        |

**A defect TR-001 found in OP-006.** `er_visit_triage_is_complete` was written as
`(esi_level IS NULL) = (triaged_at IS NULL)` — correct for a module that knows
only ESI, and wrong the moment a START triage exists. Those patients _are_
triaged and have no level, so the constraint refused to record when they were
seen. Fixed by saying what triaged means: the visit carries a level **or** a tag.
`triage_tag` is now denormalised beside `esi_level` with a companion CHECK that
only one may be set, and the ER board's acuity sort maps red→1, yellow→3,
green→5 and **black→10, below the un-triaged**. Expectant means expectant, and it
belongs in the `ORDER BY` rather than in somebody's head at 2 a.m.

**A defect in eight other files.** `z.coerce.boolean()` is `Boolean(value)`, and
`Boolean("false")` is `true` — so `?includeDeparted=false` meant _true_ on every
boolean query flag in the codebase. The default masked it: correct when the
client omits the parameter, inverted the moment a checkbox sends it. It surfaced
as an ER board showing departed patients with "show departed" unticked. Replaced
all 20 occurrences with a `queryFlag()` primitive that reads the spellings a URL
actually carries and **rejects** an unrecognised one, so `?deniedOnly=treu` is a
400 rather than the denied-only audit view.

Two smaller consistency fixes, both the same shape: a TRISS that read 85.2% when
computed and 85.3% on reload, and an ISS band badge that appeared on compute and
vanished on refresh. Both now derive from the stored value alone. A survival
probability that moves on a page refresh is one nobody can quote at a mortality
review.

Also removed: `ErService.applyTriage`, a second UPDATE of the same denormalised
columns with no callers, which would have violated the new one-ladder CHECK; and
OP-006's private copy of the ESI target table, now the one in
`@vims/contracts/scores` next to the function that produces the level.

**Gates** — 20/20 packages typecheck, lint and test (**2,896 tests**); 525 routes
across 69 controllers; catalogue **941 keys**; event registry **687**; 639
monitored tables, **0 without RLS and 0 without a tenant policy**; 644 tables
across 15 schemas; 32 migrations, all applied to a real container.

**Still missing, same as every module here:** no e2e golden path and no k6 script
for TR-001, so it does not meet `CLAUDE.md` §7's Definition of Done.

**Next:** TR-008 (MLC and forensic), then TR-009 + NC-013 (ambulance), TR-002 +
OP-009, TR-003, TR-005, TR-007.

## Phase 5 complete — 2026-09-06

Nine modules: RC-003 tariff, OP-005 OP billing, EN-010 payments, OP-023 packages,
EN-002 + RC-002 insurance and pre-auth, RC-007 government schemes, RC-008 cost
estimator, RC-006 revenue leakage, NC-034 doctor payouts.

**Exit gates proven against the live database and over real HTTP:**

| Gate | What was proven                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | Every charge event replayed 3× at a different price → the bill is byte-identical                                                                            |
| 3    | One webhook delivered three times → exactly one ₹693 payment                                                                                                |
| 6    | A scheme beneficiary refused cash at the counter, the pharmacy, an advance, an IP deposit and a forex tender — and again in raw SQL bypassing the API       |
| 7    | Pre-auth submitted, queried, answered and partially approved → ₹60,000 credit limit propagated                                                              |
| 8    | An estimate issued at ₹86,400, converted, reconciled against a ₹1,01,000 bill → +16.90%, past the 10% threshold, so it raised an alert rather than a report |
| 9    | Two tests delivered, one billed, one not → the pre-discharge check found the ₹480 and refused clearance                                                     |
| 10   | An unbalanced bill refused at COMMIT by a deferred constraint trigger                                                                                       |

Gates 1, 4 and 5 are covered by the same machinery but were not driven end to end
this session; 11 is this document.

**Eight maker-checker pairs**, each two keys held by two roles with a `block`
segregation rule, each tested by having the requester try to approve their own
work — 403 every time:
`tariff.version.submit`/`publish` · `bill.discount.request`/`approve` ·
`pay.refund.request`/`approve` · `pkg.variance.request`/`approve` ·
`preauth.submit`/`preauth.decision.record` ·
`scheme.claim.submit`/`scheme.claim.decision.record` ·
`scheme.shortfall.appeal`/`writeoff.approve` ·
`payout.statement.compute`/`approve`.

**Gates** — 20/20 packages typecheck, lint and test (2,762 → **2,841 tests**);
**493 routes across 53 controllers**; catalogue 755 → **913 keys**; event registry
→ **671**; hex-literal, chart-palette, gate-script, alert-runbook, permission-key
and prettier all clean.

**What Phase 5 still does not have.** No e2e golden path and no k6 script for any
of the nine modules, so none meets `CLAUDE.md` §7's full Definition of Done — the
same gap every module in this repo currently has. The uncommitted working tree is
large; the work is on disk and green but not yet in git history.

### 2026-09-02 (later) · Design system · The chart palette that failed its own validator, and the story harness that never existed

Second session of the day, on the front end. Scope was set by the user after the
audit: deepen the 43 modules that work rather than scaffold the 134 that have no API.

**The documented chart ramps were not colourblind-safe, and now they are**

`docs/06` §3.7 tells you to consult the `dataviz` skill before writing a chart. Doing
that means running its validator, and the three ramps §3.7 itself specifies do not pass:

- **light** — `#0E7A88` and `#8A97A8` under the chroma floor (they read as grey rather
  than as an identity), and `#B42318` directly beside `#027A48`: red next to green at
  ΔE 6.2 under deuteranopia, the one pair the commonest dichromacy collapses.
- **dark** — four of five checks failed. The worst was `#D6BBFB` against `#B3BDCA` at
  **ΔE 9.0 under _normal_ vision** — a pair full-colour readers cannot separate either.
  All eight steps sat at OKLCH L 0.78–0.86, far above the 0.48–0.67 a dark plot ground
  wants, which is what crowded the hues together.
- **high contrast** — three steps under the chroma floor and red against green at ΔE 5.4,
  in the theme whose entire purpose is keeping things apart.

All three are re-derived by search over the steps the scales in §3.1–3.3 already own —
nothing invented — under two constraints the validator cannot express: **the VIMS teal
leads every chart**, and **red is never adjacent to green**. Light and high contrast now
pass every check; dark passes with CVD in the 6–8 floor band, which the skill permits
only alongside secondary encoding, which is why the components carry glyphs and shapes.

`scripts/check-chart-palette.mjs` is the reason this cannot drift back. It reads the
ramps out of `theme.generated.css` (the artefact the browser loads, not the intent),
vendors the OKLab/Machado maths rather than importing from a plugin cache CI does not
have, and was falsified: restoring the old dark ramp reproduces the ΔE 9.0 finding
exactly. It runs in CI beside the other four gate scripts.

**The story requirement in §5.2 had never been implemented at all**

"Every clinical component ships with: Storybook story (light + dark + high-contrast +
200 % zoom + RTL), `axe` test, keyboard-only test, and a 'degraded data' story." There
was no Storybook, no story and no per-component scan.

There is now a gallery at `/design`, and it is **not** Storybook (D-51). All five
variants are properties of the real document, so rendering them inside `apps/web` puts
the specimens through the application's own tokens, Tailwind build and fonts, and behind
its authentication — `/design` is not in the middleware's `PUBLIC_PATHS`, and a test
asserts an unauthenticated visit is redirected. Storybook would have added several
hundred transitive packages to a system that has to pass a supply-chain audit, and would
have rendered everything in its own shell instead.

The catalogue is one list read by both the gallery and `design-system.spec.ts`, so a
component cannot appear in the gallery without being scanned. `catalogue.spec.ts` fails
when a clinical component has neither a story nor a recorded reason for not having one,
and refuses to let that reason outlive the story that replaces it — the outstanding list
is 24 entries and can only shrink.

**Seven components, and the harness immediately found two defects in them**

New in `packages/ui`, all to their §5.2 contracts: `ResultFlag` (#6), `EwsBadge` (#5),
`VitalsSparkline` (#3), `InteractionPanel` (#17), `DoseCalculator` (#18),
`SignatureSeal` (#40), `TaskList` (#31). Each encodes its safety rule in its types
rather than its prose — `EwsBadge` will not compile without the required-action
sentence; `DoseCalculator`'s weight is a union whose "not recorded" arm has no dose to
render; `EwsScore` makes "incomplete" a state rather than a null total that falls
through to a green badge.

The first full run of the new suite failed 11 tests, and both causes were mine:

1. **Contrast.** `SignatureSeal` and `DoseCalculator` faded text with `opacity-70/80/90`
   on their own coloured surfaces, which drops `text-*-on-surface` under 4.5:1. The
   token layer ships `-surface`/`-on-surface` as a _pair_ precisely so hierarchy is
   carried by size and weight instead. Removed; the scans pass.
2. **The keyboard test itself.** It keyed what it reached on `story:variant:tagName`,
   which collapses the two buttons a `TaskList` row renders — Skip and Done are both
   BUTTON in the same specimen — so the reached set could never match the control count
   and perfectly operable components failed. Now stamped per element.

A third finding was **not** ours: on `webkit-ipad` the same test reached 0 of 10
controls while Chromium reached all of them. macOS ships "Press Tab to highlight each
item on a webpage" **off**, so WebKit Tabs between form fields and skips buttons and
links. There is no Playwright switch for that preference, so the property is asserted on
the engines that honour it and skipped on WebKit with the reason recorded in the test.

**Duplication found and resolved rather than left**

Building `VitalsSparkline` and `EwsBadge` in the design system exposed that
`apps/web/src/features/clinical/components` already held local versions — the
architectural divergence the earlier audit noted, where §5.2 components live inside one
feature. The vitals room now uses the design-system components through a small
`news2-presentation` adapter, and the two local files are deleted. The screen gained
what it did not have: a **reference band** behind each trend, **ringed markers on
out-of-range readings**, and a downsampler that keeps peaks. It kept what the local
version did better — the **visually-hidden data table** of every reading, which is the
`dataviz` skill's "a table view exists" and is better than a summary sentence alone.

**Tested**

- `pnpm test` — 20/20 packages. `@vims/ui` 21 files / 217 tests, including new
  assertions that `InteractionPanel` sorts contraindicated first however it is handed
  the list (alphabetically 'contraindicated' < 'major', so a sort on the label would
  pass a naive test and bury the worst row) and that `TaskList` treats exactly-due as
  due-now rather than overdue.
- `pnpm typecheck` · `pnpm lint` · `prettier --check` — clean.
- `tokens:contrast` — all three themes AA.
- Five gate scripts pass, `charts:check` among them.

**Stubbed / deferred**

- 24 of the 31 clinical components still have no story; the list is enforced, not
  forgotten.
- ~19 of the 44 §5.2 components remain unbuilt. The ones skipped deliberately are those
  whose modules do not exist — `BedBoard`, `MARGrid`, `PartographChart`, `ChargeSheet`,
  `PaymentSplitter` belong to phases 5–7.
- The screen-level visual pass covered the vitals room only, as a consequence of the
  migration. The dashboard was deliberately left spare: Phase 0 exit gate 3 asks that
  each role sees a **correct, empty** workspace, and filling it with tiles would make
  that gate unfalsifiable.

### 2026-09-02 · Audit against `docs/12` · The gates that were red, and the six defects that kept them there

No new module was built this session. The task was to check the codebase against the
documents, fix what was broken, and run the system end to end. Every number below was
read out of a live container or a live process at this session's HEAD.

**Where the build actually stood**

`pnpm typecheck` and `pnpm lint` were green. Five things were not, and each is fixed:

1. **`pnpm test` was red on two wall-clock flakes** (D-46). `poll-loop` asserted ">1 tick
   in a 60 ms window" and the coalescing emitter drove a real 10 ms ticker for 2.6 s
   expecting ~260 fires; under twenty packages' vitest workers the event loop starves and
   both report 1. They now settle on the signal itself — a deferred on the third tick, and
   vitest fake timers — and **both were re-falsified**: reverting the emitter to a
   leading-edge throttle still fails the fake-timer test on `expected 1 to be greater
than 50`.
2. **`pnpm test:integration` exited non-zero with all 466 assertions passing** (D-48).
   `DatabaseService` never attached an `error` listener to its `pg.Pool`, so ten idle
   clients terminated by the Testcontainers shutdown (57P01) became unhandled errors.
   This is a production defect, not a test artifact: a Postgres failover would have killed
   the API process for a connection nobody was using.
3. **`services/api` could not boot at all** (D-47). `idempotency.interceptor.ts` imported
   `@nestjs/common/constants` without `.js`; that resolves under
   `moduleResolution: "Bundler"` and throws `ERR_MODULE_NOT_FOUND` under Node's ESM
   loader. `pnpm build` was green while `node dist/main.js` died. A sweep found no other
   offender — every other bare deep import is a package root with an `exports` map.
4. **`pnpm dev` started no service** (D-49). `turbo.json`'s `globalEnv` is a
   cache-invalidation list, not a loader, and nothing read the repo-root `.env`, so the
   API died on `DATABASE_URL: undefined`. Worse, `.env` and `infra/env.example` carried
   `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` while the code requires `JWT_ACCESS_SECRET`/
   `JWT_REFRESH_SECRET` — **the services had never been run against the repo's own env
   file.** Each `dev` script now loads `.env` through `dotenv-cli` and pins its own port.
5. **Two of the four CI gate scripts were broken, in opposite directions.**
   `check-alert-runbooks.mjs` failed CI on a parsing bug. Its regex stripped
   only double quotes; the YAML is single-quoted, so the closing `'` landed in the slug
   and all sixteen runbooks — every one of which exists — were reported missing. Fixed and
   re-falsified: a genuinely missing runbook still fails, now with the right slug. And
   `check-hex-literals.mjs` skipped `.next` by exact name, so once the browser suite built
   into `.next-e2e` it scanned the compiled Tailwind stylesheet — which legitimately
   contains every token as a hex literal, because that is what a token compiles _to_ — and
   failed on its own output. It now skips every `.next*` directory, and still reports a
   real `#ABCDEF` added to `globals.css`.

**Also fixed**

- **The browser suite failed the same four tests twice** — on `tablet` and `webkit-ipad`,
  passing on `desktop-chromium`. Not a responsive defect: `uniqueMobile()` varied the
  phone but the surname and DOB were constants, and OP-001 §5's duplicate rule scores on
  `name_trgm_gender_dob` and never looks at the phone. All three projects share one
  seeded stack, so desktop's "Ramesh Sharma / 1981-04-12" made the _first_ registration of
  the other two projects — the step that must succeed — trip the hard stop. Varying the
  surname alone was not enough, and the next run proved it: the rule is a **trigram**
  comparison, so `Candidate8416166` still scored 85% against `Candidate2909431` on the
  shared stem. The date of birth is what makes two identities genuinely disjoint — the rule
  only matches a date within a year — so each run now derives both a surname and a birth
  year from its token.
- **`apps/web/e2e/.stack.json`** (the stack handoff, written at run time) was untracked and
  unignored, so it dirtied the tree and broke CI's `prettier --check` after any e2e run.
- **The browser suite could not be run reliably at all, and the reason was not in the
  tests** (D-50). `next dev` and `next start` both own `apps/web/.next`, and the dev server
  rewrites it continuously — so `pnpm dev` running anywhere (in this case a _second agent
  session_ that kept restarting it) replaced the production build underneath the suite
  mid-run. Every client chunk then served **400**: the page rendered server-side, nothing
  hydrated, the login form fell back to a native GET, and every authenticated test failed
  as "still on `/login?`" — which reads exactly like an authentication bug and is not one.
  `distDir` is now overridable and `stack.mts` builds into `.next-e2e` itself, so the suite
  no longer shares a directory with anything. The stack also pointed at the **shared dev
  Redis**, leaking auth rate-limit windows between runs; it now uses database 15, and the
  harness lifts `RATE_LIMIT_AUTH_MAX`, which at its production value of 10/min is tripped
  by a suite that signs in on nearly every test.

**Tested — every suite run this session, not quoted from a commit**

- `pnpm lint` · `pnpm typecheck` — 20/20 packages green.
- `pnpm test` — **2,809 unit tests, 20/20 packages green.**
- `pnpm test:integration` — **648 tests, 12/12 packages green** (was red).
- `pnpm test:safety` — 9/9 green; `@vims/flags` 40/40.
- `pnpm build` — 13/13. `prettier --check` — clean.
- `pnpm test:e2e` — **182 passed, 1 skipped, 0 failed** across all three Playwright
  projects (desktop-chromium, tablet, webkit-ipad). It was **174 passed / 8 failed** at the
  start of the session, and could not be run repeatably at all until D-50.
- All four gate scripts pass: 374 routes across 44 controllers authorised, no hex literals,
  every package declares its gate scripts, every alert has a runbook.
- **RLS re-verified in the live database, not assumed:** `core.v_rls_coverage` reports
  **533 tables monitored, 0 without RLS, 0 without a policy, 0 without a write check**;
  the only open policies remain the two global catalogues (D-17).
- **Audit hash chain verified:** `core.verify_audit_chain()` returns **zero findings** over
  14,182 rows, and `core.v_audit_seal_backlog` is empty.

**Run end to end, against the live stack**

Seeded (`seed:demo`, 169 tables), booted the API, and drove real HTTP with per-role logins.
Working: login for all 64 seeded roles · register patient (UHID from the numbering series,
FY-aware: `BLR-Main/OP/2026-27/000001`) · idempotent replay returning the _same_ patient ·
the duplicate hard stop (422 `clinical-hard-stop`) · search by UHID · **cross-tenant read
refused** · OP visit with queue token `D1001` issued and linked · vitals recorded, with
NEWS2 correctly left null because not every component was supplied · cash counters, lab
catalogue, inventory and pharmacy reads. The web app serves `/login` and redirects
unauthenticated traffic off protected routes.

**The answer to "is everything in `docs/12` built": no, and not nearly.**

`docs/12` lists **177 modules**. **43** sit in phases 0–4 and have code; **134** sit in
phases 5–13 and have **none** — no controller, no screen, verified by search rather than
inferred. Of the 50 **P0** ("must for go-live") modules, **22 have no code at all**,
including OP-005 billing, EN-002 insurance/TPA, RC-003 tariff, EN-010 payments, IP-001
admission & beds, IP-002 discharge, IP-003 nursing station, IP-005 IP billing, IP-006 OT,
IP-007 blood bank, IP-009 ICU, OP-006/TR-001…TR-008 emergency & trauma, EN-003 CSSD and
NC-011 reporting. **The system today can register, queue, consult, prescribe, order
diagnostics, dispense and hold stock. It cannot admit a patient, cannot raise a bill, and
cannot process an insurance claim.** `CLAUDE.md` §7's Definition of Done is still met by
**0 of 177** — no module has both its k6 script and its e2e golden path.

**Open questions raised**

- **O-14 (new): JWT signing.** `token.service.ts` signs and verifies with **HS256** over a
  shared `JWT_ACCESS_SECRET`, and `services/realtime` verifies with the same secret.
  `EN-007 §Security` specifies **"JWT RS256/EdDSA"**. Symmetric signing means every service
  that can verify a token can also mint one — a compromise of the WebSocket-facing realtime
  service yields forged access tokens for any role, break-glass included. `env.example`
  already carries the keypair and `keys:generate` already exists; nothing reads them.
- Unchanged and still blocking: O-1, O-2, O-4, O-12.

**Next step**

1. Decide **O-14** before `services/realtime` is terminated on a different trust boundary.
2. Phase 5 (billing/RCM) is the largest single unblocker: 13 modules, and the four P0s in it
   are what stand between this and a hospital that can take money.
3. The two k6 scripts (Phase 1 gate 7, Phase 3 gate 8) still have never been run; k6 is not
   installed on this machine.
4. `scripts/check-table-ownership.mjs` is still unwritten — 533 tables, nothing checks that
   each belongs to a module spec.

### 2026-08-25 · Phase 3 completed, Phase 4 schema · Wiring, the event stream nobody read, and four agents verified

**Built**

- **Phase 3 wired.** Lab and radiology were written, tested and never mounted — every route served 404. Both are now spread into `AppModule` and the wiring guard covers 25 more routes. Removing `...LAB_CONTROLLERS` fails it with all 13 lab routes reported missing.
- **The laboratory information system** (OP-004/EN-031): order → sample → result → verify → authorise → report, Westgard QC gating release, and a critical-value path with no refusal branch at all — `enter()` contains zero `throw`s, so a critical result is stored, flagged and announced unconditionally, and only authorisation is gated, by a database trigger rather than a service check.
- **The analyzer interface** (EN-004): HL7 v2/MLLP, ASTM E1381/E1394, store-and-forward, unmatched queue, a fake analyzer speaking both protocols — and the first real test of exit gate 7.
- **Diagnostic report documents**: lab, cumulative and radiology, on a shared shell that cannot express a document which looks final but is not, with a QR carrying an opaque token and an encoder written here rather than depended on.
- **The diagnostics console**: nine screens over the Phase 3 API.
- **The critical-value ladder** (OP-004 §3, EN-037): the database raises the alert in the same transaction as the value, but nothing ever read `due_by`. Now a `critical`-class job climbs 10 min → HOD/on-call, 20 min → medical superintendent, for both lab alerts and radiology findings, on one code path.
- **The Phase 4 schema**: 112 tables, `inventory` and `pharmacy`, RLS everywhere, an append-only stock ledger enforced twice over.
- **`services/realtime` now reads the event stream.** See below.

**Tested**

Every gate below was run, and each safety property was falsified by breaking it and watching the named test fail, then restored. Counts: 626 web, 464 contracts, 299+49 integration-hub, 178 print-templates, 141 db, 57 worker, 26 realtime, 56 testing.

**Three things that were not what they looked like**

1. **The event → screen path did not exist.** `services/worker` has relayed committed outbox rows to `hms:events:<hospital>` since Phase 0 and **nothing read them**. The gateway had rooms, authorisation, presence and a coalescing emitter, and no domain event ever reached any of them — every board in `docs/01 §6` and every budget in `docs/07 §2.3` described a path that was not connected. Building the consumer surfaced two more: the group was created at `'$'`, silently losing anything written before a pod discovered the stream, and the relay wrote with no `MAXLEN`, so streams grew without bound on the same Redis that holds sessions and queues. Both fixed; pending entries are now reclaimed with `XAUTOCLAIM`, without which acknowledging after delivery bought nothing.

2. **The PC-PNDT guard never ran.** `pcpndt.spec.ts` is the fourth of four statements that no field anywhere captures foetal sex. It threw at module scope — `import.meta.url` is not a `file:` URL under jsdom — so vitest reported `(0 test)` and the run read `1 failed | 52 passed` with `610 passed`. Fixed, and it then correctly failed on the _enforcement_ code, which must name what it refuses; the allowance is three exact identifiers, proved narrow by `patientFoetalSex` still being caught.

3. **Three `*:check` scripts ran files that do not exist.** CI calls its checks by path and never called them, so nothing was red while `package.json` read as enforcement. `permissions:check` is now real (213 routes, 37 controllers, TypeScript AST not regex, and it fails rather than passing vacuously); the other two are removed; and `check-gate-scripts.mjs` now refuses a manifest naming a script that is absent.

**Stubbed / deferred**

- **Phase 4 has no contracts, no seeds and no API.** The schema exists and nothing can be built on it until `packages/contracts` has the events, permission keys and role templates.
- Exit gate 8 has a k6 script (`perf/lab-throughput.k6.js`, 20 000 result lines compressed into ten minutes, every endpoint gated against its own `docs/07 §2.1` class) that **has never been run** — it needs the API up against a volume-seeded database.
- Report PDF render time is unmeasured; the templates are tested, the Chromium path is not.
- The analyzer is tested through `accept()` and `drain()`, not over a socket: MLLP framing and ASTM handshaking are covered only by their own unit specs.
- `scripts/check-table-ownership.mjs` was never written. Every table should belong to a module spec in `docs/12`; nothing checks it.

**Open questions raised**

- None new. **O-12** (analyzer and PACS vendor inventory) still blocks Phase 3 gates 5 and 9 and qualifies gate 7 — the outage test runs against a simulator this repo wrote, so every vendor quirk remains unknown until a real device is on the wire.

**Next step**

1. Phase 4 contracts and seeds, then the Phase 4 API.
2. Run the two k6 scripts against a seeded database — Phase 1 gate 7 and Phase 3 gate 8 are both "never run" rather than "failing".
3. Phases 5–13.

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
