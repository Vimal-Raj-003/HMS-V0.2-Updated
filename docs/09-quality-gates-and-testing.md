# 09 — Quality Gates & Testing

> Vim's HMS is **safety-critical software**. A defect here does not lose a shopping cart — it gives the wrong drug,
> merges two patients, drops a critical potassium result, or bills a family for a surgery that never happened.
> This file defines what "tested" means, what CI refuses to merge, and what "done" means for every module.
> Companion docs: `04-security-compliance.md` §7 (clinical safety engineering), `07-performance-scalability.md` §7
> (load/chaos scenarios and the perf gate), `06-ui-ux-design-system.md` §11 (design-system gates),
> `13-data-migration-and-golive.md` (UAT during a real go-live).

---

## 1. The pyramid, shaped for a hospital

```
                      ┌───────────────────────────────┐
                      │  Clinical safety suite (~120) │  ← never skipped, never quarantined
                      ├───────────────────────────────┤
                      │  E2E golden paths (~30 × N)   │  Playwright, real Postgres, seeded hospital
                      ├───────────────────────────────┤
                      │  API integration (~2,500)     │  Testcontainers PG17 + RLS + Redis + MinIO
                      ├───────────────────────────────┤
                      │  Contract tests (~400)        │  packages/contracts ↔ API ↔ UI ↔ partners
                      ├───────────────────────────────┤
                      │  Unit tests (~8,000)          │  Vitest, pure services, no I/O
                      └───────────────────────────────┘
   Cross-cutting, run on their own cadence: a11y (axe) · visual regression · k6 perf gate ·
   security (SAST/DAST/IDOR/secrets/deps) · data-integrity invariants · chaos drills · UAT
```

Deliberate deviations from the classic pyramid:
- **The integration layer is unusually fat.** Almost every real defect in an HMS lives in the seam between
  business rule, RLS policy, permission check and SQL. A service unit-tested with a mocked repository proves
  very little about whether a nurse in Branch B can read Branch A's chart.
- **The clinical safety suite sits above e2e and is not a coverage number.** It is a named, enumerated list of
  behaviours that must hold, each traceable to a regulation or an incident class (`04` §7).
- **No flaky test is ever quarantined in a clinical or money path.** Flake in those areas is treated as a defect
  in the system under test until proven otherwise; the test is fixed or the feature does not ship.

---

## 2. Unit tests (Vitest)

**Scope.** Pure functions and service logic with repositories, clocks, ID generators, queues and HTTP clients
injected. `services/api/src/modules/<domain>/<module>/__tests__/*.spec.ts`, `packages/*/src/**/*.spec.ts`.

**Rules**
- One behaviour per test; the name states the rule (`refuses to dispense a Schedule X drug without a prescriber DEA-equivalent registration`), not the method.
- No network, no filesystem, no real DB, no `setTimeout` — time comes from an injected `Clock`, randomness from an injected `IdGen`. A test that needs a DB is an integration test; move it.
- Money is asserted with the `Money` type, never floats. Doses are asserted with unit + value, never a bare number.
- Table-driven tests for anything with a matrix (tariff selection, tax slabs, triage scoring, dose-by-weight bands, leave accrual).
- Property-based tests (`fast-check`) are mandatory for: numbering-series gaplessness, rounding and tax splitting, FEFO batch selection, date/timezone arithmetic across DST-free `Asia/Kolkata` and a DST zone, age computation, and cursor-pagination stability.
- Snapshot tests only for printed/rendered templates, and only with human-reviewed snapshots.

**Coverage gates (enforced in CI per package, not globally averaged)**

| Area | Statements | Branches | Notes |
|---|---|---|---|
| `services/api/src/modules/**/*.service.ts` | **≥ 80 %** | ≥ 75 % | per-module, not repo-wide — a well-covered OP-001 cannot subsidise an untested IP-005 |
| **Money, dose and safety calculators** | **100 %** | **100 %** | see the enumerated list below |
| `packages/contracts` | ≥ 90 % | ≥ 85 % | schemas + refinements |
| `packages/ui` clinical components | ≥ 70 % | — | behaviour contracts from `06` §5.2 |
| Controllers, repositories, DTOs | not counted | — | covered by integration tests instead; excluded from the denominator so nobody games the number |

**The 100 % list** (`packages/*/src/**/critical/**` and files tagged `@critical`): tariff resolution and bill-total
computation (OP-005, IP-005, RC-003), GST/CGST/SGST/IGST splitting and rounding, discount and approval ceilings,
refund and credit-note computation, doctor-share/payout rules (NC-034), package inclusion/variance (OP-023, IP-008),
insurance co-pay/deductible and payer-tariff mapping (EN-002, RC-002), dose calculators (mg/kg, BSA, renal
adjustment, paediatric weight bands — OP-002, OP-031, OP-033), infusion rate and dilution maths, MAR schedule
generation, early-warning scores (NEWS2, PEWS, qSOFA, APACHE II, SOFA — EN-029, IP-009, TR-006), trauma scores
(GCS, RTS, ISS, TRISS — TR-001), blood cross-match compatibility matrix (IP-007), stock ledger arithmetic and
FEFO selection (NC-006), and numbering-series allocation (`core`).

---

## 3. Integration tests (Testcontainers)

**Harness.** `packages/testing` starts PostgreSQL 17 (with our extensions and the *real* migration set applied,
never a hand-rolled schema), Redis, MinIO and a WireMock for outbound partners. Each test file gets a fresh
database from a cached template (`CREATE DATABASE ... TEMPLATE hms_test_tpl`) so setup is ~200 ms, not 30 s.
Requests go through the real Nest pipeline: guards, interceptors, Zod validation, policy check, `SET LOCAL
app.hospital_id`, transaction, audit, outbox. **Tests that bypass guards are forbidden** — an `@SkipAuth` in a
test is a CI failure.

**Every endpoint gets, at minimum:** happy path, validation failure (RFC 9457 shape asserted), missing-permission
403, cross-tenant 404/403, idempotent replay (for money/order endpoints), and the audit + outbox rows it must write.

### 3.1 Tenant-isolation negative tests (non-negotiable)
Generated for **every table with `hospital_id`** by a suite that reads the Prisma schema, so a new table cannot be
added without one:
1. Seed hospital A and hospital B with identical-looking data.
2. As a user of B, attempt `GET/PATCH/DELETE` on every A resource id → must be 404 (not 403 — do not leak existence).
3. Attempt list endpoints as B → A's rows must never appear, including via search, export, report, FHIR read and analytics endpoints.
4. Attempt to *create* a child row referencing an A parent → rejected.
5. Run a raw repository query without `SET LOCAL app.hospital_id` → RLS must return zero rows (proves the policy, not the app guard, is doing the work).
6. Branch scoping: a Branch-1 user must not see Branch-2 billing, inventory, cash, queue or roster rows; a group-admin must, and only through the explicit group role (EN-041).
7. `patient.merged` fan-out must not re-point a row across tenants.

### 3.2 Permission-matrix tests
`packages/contracts` publishes the permission catalogue (`05-rbac-roles-and-logins.md`). CI generates a matrix of
**every route × every system role template** and asserts the expected allow/deny from a checked-in fixture
(`permission-matrix.json`). Adding a route or changing a default role therefore forces a reviewed diff of who can
now do what. Additional assertions: deny-by-default (a route with no permission key fails the build), ABAC
conditions (own-patient, own-branch, own-department, care-team membership), segregation of duties (maker ≠ checker
on discounts, refunds, POs, payroll, result validation, blood issue, narcotics), and break-glass (allowed, but
writes a `READ_PHI` audit row with a mandatory reason).

### 3.3 Other integration coverage
Numbering series under concurrency (100 parallel invoice allocations → gapless, no duplicates); optimistic-locking
conflicts; outbox-to-Redis relay with consumer idempotency (same event twice → one effect); scheduled jobs
(room-charge posting, expiry sweep, retention purge) run against a frozen clock; file upload (magic-byte rejection,
AV stub, presigned-URL expiry); partition pre-creation; and every migration's forward + documented rollback path
applied to a database seeded with the previous release's data.

---

## 4. Contract tests (`packages/contracts`)

The Zod schemas are the single source of truth shared by the web app, the API, the workers and the mobile app.
- **Schema ↔ API**: OpenAPI 3.1 is generated from the DTOs; a test asserts the generated document matches the committed snapshot. Any change produces a reviewable diff, and a **breaking** change (removed field, narrowed type, new required input) fails CI unless the PR adds a new API version or a documented deprecation window.
- **API ↔ UI**: TanStack Query hooks are typed from the same schemas; `tsc` failure is the test. A generated MSW handler set is validated against the schemas so UI tests cannot mock a shape the server would never send.
- **Events**: every event type in `01` §5 has a schema; producers validate before writing to the outbox, consumers validate on read, and a round-trip test covers every registered event.
- **External partners** (EN-017, `08` §T1): recorded fixtures from ABDM V3, NHCX, Razorpay, MSG91/WhatsApp, HL7 v2 ORU/ORM/ADT, ASTM, DICOM MWL and payer portals are replayed against our parsers/mappers on every push. Partner sandbox tests run nightly and never gate a PR (their outages are not our regressions) but do page the integration owner.
- **Print/PDF templates**: golden-file tests on rendered HTML → PDF text layer for prescriptions, invoices, discharge summaries, lab reports and MLC forms — asserting mandatory statutory fields exist (GSTIN, HSN/SAC, drug schedule, doctor registration number, NABH-required discharge sections).

---

## 5. End-to-end (Playwright) — the golden-path catalogue

Run against a full stack in Docker seeded with **"Vim's Demo Hospital"** (2 branches, 120 beds, 60 staff across all
role templates, 3 years of synthetic history). Each journey runs on desktop Chrome and one tablet viewport;
**one journey per module is additionally run keyboard-only** (`06` §11).

| # | Journey | Modules | Key assertions |
|---|---|---|---|
| 1 | Register → consult → e-Rx → dispense → bill → receipt | OP-001, OP-002, OP-003, OP-005 | UHID issued, Rx signed, stock decremented by batch, bill totals, GST lines, receipt printed |
| 2 | Returning patient, ABHA scan-&-share → token → vitals → consult | OP-001, EN-011, EN-006, OP-007 | ABHA linked, token priority order, vitals routed before doctor |
| 3 | Appointment booked online → reminder → check-in → no-show handling | OP-001, EN-009, PE-002 | slot capacity, refund policy, no-show status |
| 4 | Lab order → sample collect (barcode) → analyzer result → validate → report → critical alert → acknowledge | OP-004, EN-004, EN-029, EN-037 | accession match, delta check, critical value hard-stop, documented call-back with read-back |
| 5 | Radiology order → MWL → study → structured report → critical finding alert | OP-008, EN-008, EN-037 | worklist entry, prior comparison, dose recorded, alert acknowledged |
| 6 | Admit → bed assign → deposit → MAR round → transfer ward → discharge → final bill | IP-001, IP-003, IP-005, IP-002 | room charges auto-posted per night, transfer keeps orders, final bill reconciles interim |
| 7 | MAR 5-Rights with wristband scan, incl. wrong-patient attempt | IP-003, EN-013 | scan mismatch blocks administration; override requires reason + second nurse |
| 8 | OT scheduling → WHO surgical safety checklist → implant scan → recovery → OT notes | IP-006, TR-003, EN-003 | checklist cannot be bypassed, implant UDI captured, CSSD tray linkage |
| 9 | Blood request → cross-match → issue with two-person verify → transfusion → reaction report | IP-007 | incompatible unit blocked, dual sign-off, reaction workflow |
| 10 | Trauma activation → START triage → polytrauma board → emergency OT override → ICU | TR-001, TR-007, TR-004, TR-006 | activation pages the team, priority queue order, OT override audited |
| 11 | MLC registration → police intimation → body map → chain of custody → court report | TR-008 | MLC number series, immutable evidence log |
| 12 | Fracture registry entry → AO/OTA classification → cast application → follow-up X-ray | TR-002, TR-005, OP-009 | registry linkage, removal schedule, comparison view |
| 13 | Pre-auth → approval → claim submission → query → settlement → short-payment posting | RC-002, RC-001, EN-002, RC-004 | document pack completeness, denial reason captured, AR aging updated |
| 14 | PMJAY package selection → blocking → claim → TMS status | RC-007 | package rules, scheme tariff overrides hospital tariff |
| 15 | Cost estimate → admission against estimate → variance alert at 80 % of estimate | RC-008, IP-005 | estimate versioning, patient-facing variance notice |
| 16 | Cash counter: shift open → collections → refunds → denomination sheet → shift close | NC-001 | reconciliation to the rupee, §269ST cash cap enforced |
| 17 | Indent → PO → GRN → 3-way match → consumption → stock ledger reconciliation | NC-005, NC-006, NC-008 | quantity/valuation invariants, rate-contract price check |
| 18 | Consignment implant used in OT → auto-billing → auto-PO → vendor reconciliation | NC-007, TR-003 | no unbilled implant possible |
| 19 | Narcotic issue with dual authorisation → register → physical reconciliation | OP-003, IP-014 | second authoriser mandatory, register printable |
| 20 | Duplicate-patient prevention at registration → dedupe queue → merge → unmerge | OP-001, EN-036 | ≥0.85 score blocks, merge re-points records, unmerge restores |
| 21 | Discharge summary drafting → clinical sign → amendment with reason → version history | IP-002, NC-003 | finalised version immutable, hash chain intact |
| 22 | Nurse tablet goes offline mid-round → queued vitals/MAR → reconnect → sync + conflict | IP-004 | no duplicate administration, conflicts surfaced not auto-merged |
| 23 | Code blue activation → team page → crash-cart usage → event documentation | IP-013, EN-037 | escalation timers, cart replenishment task |
| 24 | Dialysis session: scheduling → machine assign → intra-session vitals → consumables → billing | OP-012, IP-022 | machine double-booking blocked |
| 25 | Health check-up package: booking → multi-department routing → consolidated report | OP-014 | status board, all components complete before report release |
| 26 | Patient portal: login → view report → pay bill → download invoice → withdraw consent | PE-001, EN-010, EN-028 | consent withdrawal propagates to ABDM sharing |
| 27 | Corporate/TPA credit billing → SOA → TDS certificate → payment posting | NC-012, RC-005 | aging buckets, credit-limit block |
| 28 | Queue + TV board + kiosk self check-in end-to-end | EN-006, EN-018, EN-034 | board updates < 500 ms, no PHI beyond name/token on the board |
| 29 | Break-glass chart access by a non-care-team doctor | EN-024, `04` §5 | reason mandatory, `READ_PHI` audit row, privacy-officer alert |
| 30 | Bio-medical waste: segregation log → bag barcode → manifest → SPCB Form IV | NC-016 | 48-hour storage rule, weights reconcile |
| 31 | Mass-casualty surge: 40 trauma activations in 15 min | TR-001, OP-006 | triage queue ordering holds, no lost registrations |
| 32 | Multi-branch: patient registered at Branch A, treated at Branch B | EN-041 | shared MPI, branch-scoped billing, consent-gated cross-branch clinical view |

Rules: journeys assert **user-visible outcomes plus the database and audit consequences**; no `sleep`, only
web-first assertions; each journey is tagged `@p0` / `@p1` and `@safety`; `@p0` runs on every PR that touches its
modules and the full catalogue runs nightly and on every release candidate.

---

## 6. Accessibility, visual and localisation gates

- **axe-core** runs in three places: Storybook (every P0 component, zero violations), Playwright (every e2e journey scans each page state it reaches), and a nightly crawl of every route in the seeded hospital. Serious/critical violations fail the build; moderate violations become tickets with an owner and a due date.
- **Keyboard-only** runs of the OPD, billing, lab, pharmacy and nursing journeys — every action reachable without a pointer, focus never trapped, visible focus ring, documented hotkeys behave as documented (`06` §6.1).
- **Visual regression** (Playwright screenshots, per-component and per-screen) across light / dark / high-contrast / RTL / 200 % zoom / compact-touch density. Diffs over 0.1 % require human approval in the PR. Clinical status colours are additionally asserted by a contrast unit test over the token map — a colour that stops meeting 4.5:1 fails, it does not merely look different.
- **i18n**: key-coverage check (no hard-coded user-facing string, every key present in `en-IN` and `hi`), pseudo-localisation run to catch truncation, and a render test for Devanagari/Tamil/Malayalam names and printed privacy notices.

---

## 7. Performance regression gate

Defined in `07-performance-scalability.md` §7 and enforced here as a merge gate. Summary of the fail conditions:
any endpoint class budget (`07` §2.1) exceeded; p95 regression > 15 % against the 7-day baseline; frontend bundle
budget exceeded; an `EXPLAIN` gate violation (seq scan on a table > 100k rows in a hot path, or a plan-cost
regression > 30 % on a registered query); memory slope > 5 MB/h in the nightly soak. Baselines move only with a
written justification in the PR. The 3-minute per-PR k6 smoke runs against the seeded 3-year dataset — **never
against an empty database**, which is the classic way to ship a missing index.

---

## 8. Security testing

| Gate | Tool / method | Fails the build when |
|---|---|---|
| Secret scanning | gitleaks (pre-commit + CI, full history on `main`) | any credential-shaped string outside the fixtures allow-list |
| SAST | Semgrep (OWASP + custom rules) | raw SQL string concatenation, `any`, missing permission decorator, PHI in a log call, `dangerouslySetInnerHTML`, unbounded query without pagination |
| Dependency audit | `pnpm audit`, Renovate, Trivy on the image | new high/critical with a fix available; any critical regardless of fix after a 7-day grace |
| Container/IaC scan | Trivy + Checkov | privileged container, root user, missing resource limits, public bucket, open security group |
| IDOR / authz | generated suite (§3.1, §3.2) | any cross-tenant or cross-role leak |
| Injection | integration tests with SQLi/XSS/XXE/SSRF/path-traversal payload corpora on every text input, upload and URL-fetch field | any payload reaching the database or reflected unescaped |
| Auth hardening | tests for lockout, OTP rate limits, refresh-token reuse detection, session fixation, JWT `alg=none`/tampering, idle & absolute timeout | any bypass |
| Headers & CSP | ZAP baseline against staging | missing CSP nonce, HSTS, frame-ancestors, or a permissive CORS origin |
| PHI leakage | log/metric/trace scrubber test: run a journey, grep the emitted telemetry for seeded PHI markers | any UHID, name, phone, Aadhaar fragment or diagnosis in logs, URLs, metric labels, Sentry payloads or AI prompts |
| Penetration test | external, annually and before any major release | open findings above medium unremediated past their SLA |

---

## 9. Data-integrity tests (invariants that must never break)

Run as an integration suite after every module's tests **and** as a nightly job against staging and every production
tenant (results into `analytics` and the ops dashboard; a production breach pages, per `10` §7):

1. **Double-entry accounting** (NC-009): for every posting period, ΣDr = ΣCr; every sub-ledger (AR, AP, cash, bank) reconciles to its control account; no journal without a source document reference.
2. **Bill totals**: `bill.total = Σ(bill_items.net) + Σ(taxes) − Σ(discounts)`; `Σ(receipts) − Σ(refunds) = Σ(payments applied)`; no bill finalised with an unpriced item; no negative net line without an approved credit note.
3. **No orphan charges**: every `bill_item` traces to a service/order/administration event, and every completed clinical event that is billable has either a charge or a documented non-billable reason (this is RC-006's leakage check, asserted as a test).
4. **Stock ledger**: for every item × batch × store, `Σ(ledger movements) = on-hand quantity`; valuation matches the movement ledger; no negative on-hand at any point in time (checked over the full history, not just now); FEFO order respected on issues unless overridden with a reason.
5. **Bed/ADT**: no bed occupied by two patients over overlapping intervals (`btree_gist` exclusion asserted); no admission without a discharge or an open episode; census by hour reconciles to ADT events.
6. **MAR**: no administration without a scheduled or PRN order; no administration after order discontinuation; scheduled doses either administered, held with reason, or missed with reason — never simply absent.
7. **Clinical document chain**: `sha256`/`prev_sha256` chain verifies for every finalised document; no gaps, no rewrites; amendments always create a new version.
8. **Numbering**: gapless series (invoices, receipts, MLC, blood bag) have no holes and no duplicates per hospital/branch/FY; non-gapless series have no duplicates.
9. **Audit completeness**: every mutation of a clinical/financial table in the test run produced exactly one audit row with a resolvable actor; the audit hash chain verifies.
10. **Outbox**: no event published without a committed source row; no source row of a registered event type without an event (the classic dual-write bug).
11. **Referential/tenant sanity**: no row whose FK points at a different `hospital_id`; no soft-deleted parent with live children in a clinical path.

---

## 10. Clinical safety test suite

A named suite (`pnpm test:safety`) that runs on **every** PR regardless of touched paths, and whose results form
the evidence pack a NABH assessor asks for (`04` §9). Each test cites its rule.

- **Hard-stops cannot be disabled.** For every hard-stop in `04` §7 (documented anaphylaxis allergy, pregnancy category X, statutory NDPS cap, missing paediatric weight, >200 % dose ceiling, incompatible blood unit, unacknowledged critical value), a test attempts to disable it via every configuration surface — feature flag, hospital setting, role permission, rule-engine toggle, API parameter — and asserts the stop still fires. New settings keys are diffed against an allow-list so a future "make it configurable" PR is caught.
- **Allergy / interaction / duplicate-therapy** checks fire on prescribe, on dispense and on administer — three independent gates, tested independently, because one of them will be bypassed by some workflow eventually.
- **Dose limits**: dose-range checks by age, weight, BSA and renal function; paediatric doses blocked without a recorded weight; infusion rates bounded; look-alike/sound-alike and high-alert drugs require the double-check.
- **Correct patient identification**: two identifiers enforced on every clinical action; barcode mismatch blocks medication, specimen, blood and imaging; mother–baby linkage verified; a wrong-patient e2e attempt (journey 7) must fail closed.
- **Duplicate patient prevention**: score ≥ 0.85 blocks registration without an override permission and a reason; the pair lands in the dedupe queue; merges are reversible.
- **Critical results**: unacknowledged critical values escalate on the timer, page the next tier, and cannot be silently closed; the call-back record (who, whom, when, read-back) is mandatory before closure.
- **No silent failures**: fault injection on every clinical write path (DB error, queue down, printer down, interface down, alert-delivery failure) asserts the failure reaches a human queue and the UI, and that nothing reports success.
- **Immutability**: attempts to hard-delete or in-place-edit a finalised clinical document, an audit row, or a posted financial entry are rejected at the database grant level, not only in the service.
- **Downtime protocol**: the read-only/degraded mode banner appears, the reserved offline numbering block is honoured, and catch-up entries are flagged as back-dated and audited.
- **CDSS-before-AI**: any AI-derived suggestion is rendered as advisory, requires explicit human confirmation, and cannot itself sign, order or administer (`04` §7 regulatory boundary).

---

## 11. Test data strategy

- **No production PHI in any lower environment. Ever.** There is no approval path for it. Staging, UAT, dev and demo run on synthetic or irreversibly anonymised data (EN-036 §3.8). CI asserts this by scanning lower-environment databases for known production identifier patterns and by requiring the `data_provenance` marker on every non-production tenant.
- **Synthetic Indian patient generator** (`packages/testing/src/generators`): names drawn from a weighted multi-regional corpus with realistic transliteration variants (Sanjeev/Sanjiv, Lakshmi/Laxmi, Mohd/Mohammad) so dedupe and search are tested honestly; mobile numbers in reserved test ranges; addresses from real PIN-code/district data with fictitious house numbers; age distribution matched to Indian OP/IP case mix; deliberate dirt — 8 % missing PIN, 5 % age-only DOB, 3 % shared family mobile, 2 % planted near-duplicates, a scattering of Devanagari/Tamil/Malayalam names; clinically coherent episodes (diagnoses → orders → results in plausible ranges → drugs appropriate to the diagnosis) so CDSS, analytics and ML fixtures are not nonsense.
- **Seed tiers**: `seed:minimal` (masters + 20 patients, for unit/integration), `seed:demo` (the 2-branch demo hospital, for e2e/UAT/sales), `seed:volume` (3 years at the `07` §1.3 volumes, for the perf gate and EXPLAIN checks). All idempotent, all versioned with the schema.
- **Masking pipeline** for the rare case where a production-shaped dataset is genuinely needed to reproduce a defect: an approved, logged job that runs **inside the production boundary**, applies EN-036's suppression/pseudonymisation/generalisation/date-shifting, verifies k-anonymity, and emits only the masked artefact. The unmasked data never leaves. Every run is recorded in the disclosure register with a destruction date.
- **Fixtures for partners**: recorded (and PHI-scrubbed) HL7, ASTM, DICOM, ABDM and payer payloads live in `packages/testing/fixtures`, each with a provenance note.

---

## 12. UAT with hospital staff

UAT is not "show the users the system". It is a scripted, signed, role-by-role acceptance run — and it is the
single best predictor of whether a go-live succeeds.

- **Scripts.** One script per role per module, in `docs/templates/uat-script.md` format: precondition, numbered steps in the user's own vocabulary, expected result, actual result, pass/fail, defect id, tester name, date. Scripts are written from the module's acceptance criteria (§14 of each module spec) so nothing is tested that was not specified and nothing specified goes untested.
- **Environment.** A dedicated UAT tenant loaded with the hospital's **own** masters (their tariffs, doctors, drugs, wards, letterheads) and synthetic patients. Real hospital data appears only after migration dry-run 2 (`13` §5) and only as migrated records, never as a copy of a live production database from elsewhere.
- **Sign-off matrix.** Each module requires two signatures: the **process owner** (HOD/department in-charge) and the **IT/project owner**; clinical modules additionally require the **Medical Superintendent or nominated clinician**, and money modules the **Finance head**. A module is UAT-complete when every P0 script passes, every P1 defect has an agreed fix date, and the matrix is signed. The matrix lives in the project cockpit (EN-036 §8) and is part of the go-live readiness pack.
- **Defect classification during UAT**: **Blocker** (safety, money, cannot proceed) → fix before go-live, no exceptions; **Major** (workaround exists, hurts daily work) → fix before go-live or with an accepted, documented workaround; **Minor** → next release train; **Change request** → out of UAT, into the backlog with commercial impact assessed. Reclassification requires the process owner's agreement, not the vendor's.
- **Parallel run.** Where the hospital is replacing a live system, UAT is followed by a parallel run (`13` §8) — the same transactions entered in both systems for an agreed window, with a daily reconciliation report. Parallel run failures are UAT failures.
- **Training linkage**: UAT testers become the trainers (train-the-trainer, `13` §10) — their scripts become the quick-reference cards.

---

## 13. Regression suite maintenance

- **Every production defect gets a failing test first**, at the lowest level that reproduces it, merged in the same PR as the fix. A fix without a test is not merged.
- The e2e catalogue is capped by **runtime budget** (full suite ≤ 45 min on the CI matrix), not by test count: adding a journey means justifying it or retiring one. Retirement requires the module owner's approval and a note in the PR.
- **Flake policy**: a test that fails twice in 20 runs without a code change is investigated within 48 h. Non-clinical, non-money tests may be quarantined for at most one sprint with a named owner; clinical and money tests are never quarantined. Flake rate is a tracked metric (target < 0.5 %).
- Test code is reviewed to the same standard as product code; shared factories and page objects live in `packages/testing` so a schema change updates one place.
- Quarterly: prune duplicate coverage, refresh partner fixtures against current sandboxes, re-baseline perf, re-record visual snapshots after an intentional design change (never silently — snapshot updates need a reviewer).

---

## 14. Definition of Done (expanded from CLAUDE.md §7)

A module is **done** when every box is ticked. "Mostly done" is not a state; report honestly what is missing.

**Specification & design**
- [ ] `docs/modules/**` spec satisfied section by section; every deviation recorded in the spec and in `docs/DECISIONS.md`.
- [ ] Open questions from spec §16 either answered by the hospital or carrying an explicit, recorded default.
- [ ] ADR written for any non-obvious technical choice.

**Data**
- [ ] Prisma migration + hand-written SQL (RLS, partitions, indexes, triggers, MVs) + idempotent seed + `-- ROLLBACK:` block.
- [ ] RLS policy on every new table; every FK indexed; `EXPLAIN` checked for each hot query and registered in the EXPLAIN gate.
- [ ] Retention/partition/archival behaviour defined and scheduled; legal hold respected.

**API & contracts**
- [ ] Every endpoint: Zod DTO → permission key → policy check → service → repository; RFC 9457 errors; rate limit; `Idempotency-Key` on money/order endpoints.
- [ ] OpenAPI regenerated; contracts published in `packages/contracts`; permissions registered in the RBAC catalogue and reflected in `permission-matrix.json`.
- [ ] Domain events emitted via the outbox, documented in the spec §7, schema-validated, consumers idempotent.

**UI**
- [ ] Screens responsive on desktop / tablet / phone (and TV/kiosk where applicable); empty, loading, error and offline states; skeletons not spinners.
- [ ] Keyboard shortcuts implemented and documented; axe clean; contrast verified in light, dark and high-contrast; i18n keys for every string with `en-IN` + `hi` populated.
- [ ] Patient banner, hard-stops and confirmation friction match `06` §5.2 behaviour contracts.

**Operations**
- [ ] Audit rows on every mutation; `READ_PHI` where applicable; no PHI in logs/metrics/traces.
- [ ] Notifications wired (in-app, push, SMS/WhatsApp templates registered where needed); escalation paths set.
- [ ] Feature flag + licence entitlement gate; default state documented.
- [ ] Metrics, SLO and dashboard panel added; alert rules with a runbook link (an alert without a runbook fails CI).

**Tests**
- [ ] Unit ≥ 80 % on services (100 % on the money/dose/safety list); integration test for every endpoint incl. tenant and permission negatives; contract tests; ≥ 1 e2e golden path; k6 smoke for list/write endpoints; safety-suite entries for any new hard-stop; data-integrity invariants extended if the module owns money or stock.
- [ ] Every acceptance criterion in spec §14 mapped to a named test (traceability table in the module README).

**Compliance & docs**
- [ ] `04` §10 per-module security checklist ticked; consent checked where data leaves the system; DPDP metadata recorded for any new external flow.
- [ ] `docs/PROGRESS.md`, `docs/DECISIONS.md`, module README updated; demo data in `seed:demo`; walkthrough notes recorded.
- [ ] Clinical change control: if the module changes CDSS rules, order sets, dose logic or a safety signal, a named clinician has signed off and the sign-off is attached to the release.

---

## 15. CI pipeline

`.github/workflows/ci.yml` — stages run in order; a stage's failure stops the pipeline.

| # | Stage | Runs | Fails when |
|---|---|---|---|
| 0 | **Pre-commit** (local, husky) | format, lint-staged, gitleaks, typecheck on changed packages, affected unit tests | any of the above |
| 1 | **Setup & affected graph** | pnpm install (frozen lockfile), Turborepo affected-project detection, cache restore | lockfile drift, cycle in the dependency graph |
| 2 | **Static** | ESLint (incl. module-boundary `no-restricted-imports`), `tsc --noEmit` strict, Prettier check, module-contract boundary test, permission-key presence check, hex-literal check (`06` §11) | any error; any `any`, `console.log`, TODO-without-issue in changed files |
| 3 | **Unit** | Vitest with coverage per package | test failure or coverage below the §2 gates |
| 4 | **Contracts** | OpenAPI snapshot diff, event-schema round-trip, MSW handler validation, print golden files | breaking API change without a version bump; snapshot drift without review |
| 5 | **Integration** | Testcontainers: migrations forward+rollback, endpoint suite, tenant-isolation matrix, permission matrix, jobs, data-integrity invariants | any failure; a new table without an RLS test; a new route without a matrix entry |
| 6 | **Build** | Next.js build, Nest build, Docker images (multi-arch), SBOM (Syft), image signing (cosign) | build error; bundle budget exceeded |
| 7 | **Security** | Semgrep, Trivy (image + IaC), `pnpm audit`, PHI-leakage scrubber test, ZAP baseline (staging only) | new high/critical; any PHI leak; any authz finding |
| 8 | **E2E** | Playwright `@p0` for affected modules (full catalogue nightly + on RC), axe scans, visual regression | journey failure; serious a11y violation; visual diff > 0.1 % unapproved |
| 9 | **Safety** | `pnpm test:safety` — always, every PR | any hard-stop bypassable; any safety assertion failing |
| 10 | **Performance** | k6 smoke on the volume seed; EXPLAIN gate | budget breach or > 15 % p95 regression (`07` §7) |
| 11 | **Publish** | push signed images to the registry, attach SBOM + test-evidence pack to the build | signing or provenance failure |

Nightly (on `main`): full e2e catalogue, `soak` 1 h, `opd-morning-rush`, partner-sandbox contract tests, dependency
audit, data-integrity invariants against staging, backup-restore verification (`10` §8), full-history secret scan.
Weekly: DAST authenticated scan, licence-compliance scan, dead-code and unused-index reports.

**Merge requirements on `main`:** all gates green, one reviewer (two for `@critical`, clinical or money paths),
conventional-commit title, linked issue, and — for clinical-logic changes — a recorded clinical sign-off.

---

## 16. Release process

**Versioning.** SemVer on the product (`vims-hms@MAJOR.MINOR.PATCH`) and independently on `packages/contracts`
(the API contract). MAJOR = breaking API/data change or a workflow change requiring retraining; MINOR = new module
or capability behind a flag; PATCH = fixes. Every deployable image is tagged with the version, the git SHA and the
build date; the running version is visible in the UI footer and in `/healthz`.

**Changelog.** Generated from conventional commits into three audiences: *engineering* (full), *hospital IT*
(operational impact, config changes, downtime), *clinical & billing users* (what changes on your screen, in plain
language, with screenshots). The clinical changelog is mandatory for any release touching a clinical module.

**Release train.** Fortnightly minor releases; patches any time; emergency fixes via a hotfix branch cut from the
production tag. Freeze windows: no non-emergency production release during a hospital's month-end close (last 2
and first 2 working days), during a go-live's hypercare, or on the eve of an accreditation audit.

**Staged rollout.** `RC on staging (24 h, full e2e + soak)` → `pre-prod / one internal tenant (24 h)` →
**canary**: one small hospital or one branch of a group (48 h, error budget and SLO burn watched, `07` §8) →
**wave 1** (25 % of tenants) → **wave 2** (100 %). On-prem customers receive the build only after wave 1 is clean,
via a signed bundle and a scheduled maintenance window (`10` §11).

**Feature flags.** Every new module and every behaviour-changing feature ships dark behind `module.<key>.enabled`
or `feature.<key>.enabled` (`packages/flags`), enabled per hospital. Flags are inventoried; a flag older than two
release trains must be removed or justified. **Safety hard-stops are never behind a flag** (§10).

**Rollback plan.** Every release records, before deployment: the previous image tag, whether the migration set is
backward-compatible (it must be — expand/contract, `10` §6), the flag states to revert, and the rollback decision
owner. Application rollback is redeploying the previous tag (target < 10 min). Because migrations are additive
within a release, rollback never requires a database restore; if a release genuinely cannot be rolled back, that
fact must be stated in the release note and approved in advance.

**Clinical change control.** A release touching clinical logic (CDSS rules, order sets, dose rules, scores,
allergy/interaction behaviour, MAR, blood, safety signals in the UI) requires, attached to the release record:
the rule version diff, the safety-suite evidence pack, UAT evidence where the workflow changed, a named clinician's
sign-off, and a user-facing note. These records are what an assessor asks for and what a court would ask for.

**Post-release.** 24-hour heightened monitoring (SLO burn, error rate, DLQ, failed clinical writes), a release
retro on any rollback or Sev-1/2, and the release note archived with its evidence pack for the compliance file
(`04` §9).
