# PHASE 12 — AI & ADVANCED

Phases 0–11 complete: a full, deterministic hospital system with a governed semantic layer. Only now is it safe to
add a model — as an assistant that can be switched off without anyone noticing a missing capability.

## Read first
`CLAUDE.md`, `docs/PROGRESS.md`, then **AI-001 SECTION 0 — the AI Platform Foundation (§0.1–§0.14), which is
normative for AI-001 … AI-008 and must be built before any feature**. Then **AI-001** (chatbot),
**AI-002** (LLM layer over EN-029 — read §3.1, the precedence contract, before writing anything),
**AI-003** (document extraction), **AI-004** (voice & ambient scribe), **AI-005** (predictive analytics),
**AI-006** (assisted coding), **AI-007** (radiology assist), **AI-008** (conversational BI).
Alongside them: **EN-029** (the deterministic engine that always wins), **NC-011/EN-001** (the semantic layer
AI-008 must use), **EN-008/OP-008** (imaging), **NC-003** (MRD/coding), **EN-028** (consent), **EN-024** (audit),
**EN-040** (licence/entitlement), **EN-023** (security), and `docs/04-security-compliance.md` (DPDP, data
residency, CDSCO SaMD boundary).

Plan first; wait for "go". **Build order: AI-001 §0 platform → eval harness and golden datasets →
AI-003 → AI-006 → AI-005 → AI-001 → AI-008 → AI-004 → AI-002 → AI-007.** Low-risk, high-verifiability features
first; the two that touch clinical judgement come last, when the guardrails have been exercised.

## Goal

Clinicians and staff get assistance that is measurably better than not having it, that they can accept, edit or
reject with one keystroke, that never overrides a deterministic safety check, that costs a known number of rupees
per tenant per month, and that degrades to the existing workflow with a visible badge the moment it is unavailable,
over budget or under-confident.

## Deliverables

### 12.1 AI platform foundation (AI-001 §0) — build alone, ship nothing on top until it is done
- **Service topology** (`services/ai`) with the shared schema `ai`, isolated from the API's request path; no AI call
  ever sits on a clinical hot path.
- **Provider abstraction and model routing** (§0.2): one adapter interface across Anthropic, Azure OpenAI, Bedrock,
  **a self-hosted/on-prem option (vLLM or equivalent)**, speech providers, and third-party vendor adapters.
  Model choice is per feature, per tenant, versioned, and swappable without a code change. **Data residency is
  configuration**: a tenant can require in-country processing or on-prem-only, and the router must refuse to route
  outside the configured boundary rather than silently falling back.
- **Retrieval over the hospital's own corpus** with `pgvector` (§0.3): tenant-scoped collections, chunking and
  embedding pipeline, corpus versioning, and **cross-tenant retrieval made structurally impossible** (tenant filter
  in the index and in the query, plus a red-team probe in CI).
- **Prompt registry with versioning** (§0.4): prompts are data, versioned, diffable, reviewable, linked to the
  model and the eval run that approved them; a prompt change is a governed change, not a hot edit.
- **Guardrails** (§0.5): input and output filters, **PHI redaction before egress with a configurable policy and a
  reversible local mapping**, prompt-injection defences on every untrusted surface (patient messages, OCR'd
  documents, note text, file names, uploaded PDFs), refusal policies, and scope limits per feature.
- **Cost and latency metering** (§0.6): per-request tokens, provider, latency, retries and rupee cost against a
  versioned price table; **per-tenant, per-feature monthly budgets** with a soft threshold at 80 % (notify) and a
  hard cap at 100 % that degrades to the deterministic path and never blocks clinical work; latency budgets
  enforced per feature.
- **Deterministic fallback for every feature** (§0.7): the fallback table is implemented, tested, and the product
  is fully usable with `module.ai_*.enabled = false`. Degradation is **visible** — a persistent
  "AI assist unavailable — using standard workflow" badge, never a silent behaviour change.
- **Governance** (§0.8): every output is a suggestion with `status ∈ {proposed, accepted, edited, rejected,
  expired}`, the accepting user, the edit diff and the timestamp captured; model cards; a governance committee
  record; an incident path.
- Shared data model (§0.10), shared API surface (§0.11), shared events (§0.12), shared permissions (§0.13) and
  shared non-functional rules (§0.14).

### 12.2 Eval harness and golden datasets (AI-001 §0.9) — before any feature is enabled for a real user
- **Golden dataset per feature**, de-identified, curated by the clinical or functional owner, versioned, at the
  minimum sizes the spec states (400 conversations including 80 red-flag cases for AI-001; 300 vignettes for
  AI-002; 500 documents per type for AI-003; 200 multi-accent, code-mixed consultations for AI-004; a held-out
  temporal split for AI-005; 1000 coded episodes for AI-006; vendor set plus 200 local studies for AI-007;
  300 question/SQL pairs for AI-008).
- **Offline eval harness running in CI on every prompt, model or routing change** and nightly against shadow
  traffic: accuracy, precision/recall/F1, calibration (ECE), citation groundedness, refusal correctness, latency
  and cost per case.
- **Acceptance thresholds gate production enablement.** A run below threshold blocks the publish. Thresholds are
  lowered only by the governance committee with a recorded rationale.
- **Red-team suite per feature**: prompt injection through every untrusted channel, PHI exfiltration attempts,
  jailbreaks toward diagnosis or prescription, cross-tenant retrieval probes, SQL escape attempts (AI-008),
  abusive input, adversarial red-flag phrasings ("I'm fine, just a bit of chest heaviness"), and multilingual and
  code-mixed variants of all of them.
- **Rollout ladder** enforced in code: `off` → `shadow` (runs, logged, never shown, minimum two weeks) →
  `internal` (named pilots) → `opt_in` → `default_on` (still individually disable-able). Promotion requires an eval
  run, a governance decision and a model-card review. **No feature skips shadow. No big-bang enablement.**
- **Continuous monitoring dashboard** per feature: accept/edit/reject rates, confidence-vs-accuracy calibration,
  guardrail blocks, escalations, latency, cost per 1000 uses, cohort slices, drift and incidents.

### 12.3 Document extraction (AI-003)
The universal capture → extract → **verify** → commit pipeline, where nothing commits without a human confirming
the extracted fields against the source image shown side by side. Prescription OCR (the highest-risk path: drug
name confusions are the failure mode — dose and drug fields require explicit confirmation and run the EN-029
checks on commit), external lab report parsing mapped to LOINC, insurance card and policy extraction, identity
documents with **Aadhaar masking applied at extraction time so the full number is never stored**, external
discharge summaries, procurement invoices and GRNs, and bulk MRD digitisation.

### 12.4 Assisted coding (AI-006)
Episode intake and coding readiness, ICD-10 diagnosis coding (ICD-11-ready), procedure coding, DRG-style and
scheme-package grouping, the **coder review workflow in NC-003 where the coder accepts, edits or rejects every
suggestion**, optional opt-in real-time hints during documentation, and a coding audit loop that feeds accepted
and rejected suggestions back into evaluation. Coding suggestions feed RC-001 claims and RC-004 denial prevention —
but a claim is never submitted on an unreviewed code.

### 12.5 Predictive analytics (AI-005)
A **feature store** built on the Phase 11 analytics schema, a training pipeline and model registry with lineage,
scoring integrated into the operational screens (readmission risk on the discharge screen, no-show probability on
the appointment book, LOS and bed-demand forecasts in IP-025, inventory demand in NC-006), and per-model guardrails
and label definitions from the spec. **Monitoring for drift and fairness across cohorts (age, sex, payer type,
language, branch) is part of the deliverable, not a follow-up** — a model whose performance diverges by cohort is
paused. Every prediction carries a confidence and a deterministic heuristic fallback.

### 12.6 Chatbot (AI-001)
Channel onboarding with the identity ladder (anonymous → mobile-verified → authenticated), the turn pipeline, a
**closed, tool-backed intent catalogue** (no free-form action invention), symptom triage with safety rails where
any red-flag phrasing routes immediately to a human and to emergency advice, hand-off to EN-033 with full context,
and the staff-helper persona. The fallback is a numbered-menu bot plus call-centre hand-off.

### 12.7 Conversational BI (AI-008)
Natural-language question → **governed SQL generated only against the Phase 11 semantic layer and dataset
registry**, executed on the read replica under the asking user's RLS session; a strict refusal list for questions
the module will not answer; chart selection with explanation; **k-anonymity guardrails on aggregates**; saved and
verified questions; and scheduled natural-language digests. Every answer shows the SQL and the metric definitions
it used.

### 12.8 Voice and ambient scribe (AI-004)
**Consent is the gate for everything ambient** — patient and clinician consent recorded per encounter, with the
recording indicator always visible and a one-tap stop. Push-to-talk dictation (no ambient recording), ambient
consultation capture producing a SOAP **draft that the doctor must edit and sign**, voice commands for navigation
and order entry with confirmation on anything that writes, radiology dictation, and nursing voice notes.
Indian-language and code-mixed support is a first-class requirement, and audio retention is short, stated and
enforced.

### 12.9 Clinical decision support layer (AI-002) — subordinate to EN-029 by construction
Implement §3.1 exactly: **EN-029 evaluates first, synchronously, on its 100 ms budget, and its alerts render
before an AI-002 call is dispatched.** AI-002 runs afterwards, asynchronously, into a visually distinct
"AI suggestions" area, and **may not** suppress, hide, collapse, delay, downgrade, re-rank or auto-acknowledge any
EN-029 alert, may not write to `cdss_alert_events`, may not publish rules, and may not raise anything above
`passive`. A suggestion contradicting an EN-029 alert is **automatically withdrawn** with reason
`contradicts_deterministic_rule` and logged for governance. AI-002 latency never blocks signing an order; an
unreturned suggestion is discarded as `expired`, never shown post-hoc. Features: differential-diagnosis
suggestions, order-set and pathway recommendations, plain-language explanation of EN-029 alerts, antimicrobial
stewardship advice, risk signals from unstructured notes, drug–diagnosis appropriateness, ER triage assist, and a
rule-drafting tool for the informaticist (which produces a **draft EN-029 rule for human review**, never a live one).

### 12.10 Radiology assist (AI-007) — integration only
**Vim's HMS builds no diagnostic imaging models. It builds an adapter layer.** Each engine is registered with
vendor, version, modality, body part, indications, intended use, limitations, deployment mode, data-handling terms
and **regulatory clearance references (CDSCO licence, CE-MDR, FDA 510(k)/De Novo) with expiry dates**.
**An engine cannot be enabled without a valid, unexpired clearance on file**; expiry warns at 90/60/30 days and
auto-disables the engine, reverting the worklist to standard ordering. One adapter interface over three patterns
(DICOM node, REST/FHIR with async callback, on-prem SDK appliance). Routing rules decide exactly which studies are
eligible; everything else is never sent. **De-identification before any egress** per DICOM PS3.15, with burned-in
annotation detection blocking suspect studies, and a locally-held reversible mapping. **PC-PNDT hard exclusion:
obstetric and foetal ultrasound studies are excluded from every routing rule at platform level and cannot be
enabled by configuration.** Outputs are worklist prioritisation, viewer overlays and preliminary report drafts —
all of which a radiologist must accept, edit or reject.

### 12.11 The CDSCO SaMD boundary — write it down and enforce it
Produce an ADR stating precisely where Vim's HMS sits relative to Software as a Medical Device: what the product
claims (workflow, documentation, decision *support* with a human always in the loop), what it explicitly does not
claim (diagnosis, treatment decision, autonomous action), which components are regulated third-party devices used
under their own clearance (AI-007 engines, connected monitors, analyzers), and the intended-use statement shown to
users. **Any feature that would cross the line into a regulatory claim is out of scope until a regulatory pathway
exists** — and the ADR names who decides that. Every AI surface carries its standing disclaimer.

## Constraints & watch-outs
- **EN-029 always wins.** Deterministic alerts take precedence over every AI output, in every feature, at every
  interruption level. Write the test that fails if an AI path can hide, delay or re-rank a deterministic alert.
- **Human-in-the-loop is absolute.** No AI output is auto-committed to a clinical, financial or legal record.
  Accept, edit and reject are all captured, with the edit diff, and they are the primary quality signal.
- **Evals before enablement, shadow before opt-in, opt-in before default.** A feature that has not passed its
  thresholds cannot be turned on for a real user, and the code must make that impossible rather than discouraged.
- **PHI leaves the boundary only under policy.** Redaction before egress, residency enforced by the router,
  de-identification for imaging, no PHI in prompts where a reference id suffices, no PHI in provider logs, and a
  documented DPA per provider.
- **Cost is a product feature.** Per-tenant metering and budgets, a soft alert and a hard cap that degrades rather
  than blocks, and a visible cost-per-1000-uses figure per feature.
- **Prompt injection is assumed, not hypothesised.** Every untrusted input path is treated as adversarial and is
  covered by the red-team suite in CI.
- Do not let AI reach into anything Phase 11 did not model: AI-008 queries only the semantic layer, AI-005 only the
  feature store. No feature gets its own private SQL.
- No AI feature may become a dependency of a clinical workflow. If deleting `services/ai` would break a ward round,
  the design is wrong.

## Exit gate
1. The platform foundation exists and is tested independently: provider routing, on-prem model option, residency
   refusal, prompt registry versioning, PHI redaction, retrieval tenant isolation, metering and budgets.
2. Golden datasets exist at the required sizes for every feature built; the eval harness runs in CI and blocks a
   deliberately degraded prompt from publishing.
3. The red-team suite passes: prompt injection through a patient message, an OCR'd document and a file name all
   fail to change behaviour; a cross-tenant retrieval probe returns nothing; an AI-008 SQL escape attempt is
   refused.
4. Every feature runs in shadow for the configured period with its dashboard populated before any user sees it;
   attempting to promote past shadow without a passing eval run is blocked by the system, not by a policy document.
5. Turn every AI flag off: the whole product still works, every fallback path is exercised, and the visible
   degradation badge appears. Delete the AI service in a test environment and no clinical workflow breaks.
6. AI-002 cannot suppress, delay, downgrade or auto-acknowledge an EN-029 alert (proven by test); a contradicting
   suggestion is auto-withdrawn and logged; a suggestion that arrives after signing is discarded as expired.
7. A prescription image is extracted, verified field-by-field by a human against the source, committed, and runs
   the full EN-029 check on commit; the Aadhaar in an ID scan is never stored unmasked. Coding suggestions are
   accepted/edited/rejected by a coder, no claim is submitted on an unreviewed code, and the audit loop feeds evals.
8. A predictive model shows cohort-level performance and a deliberately drifted cohort pauses the model; the
   chatbot escalates a red-flag symptom to a human and to emergency advice within the configured seconds, in two
   languages, including a code-mixed phrasing.
9. AI-008 answers a revenue question with the same number as the Phase 11 dashboard, shows its SQL and metric
   definitions, respects the asker's RLS, and refuses an out-of-scope question.
10. An AI-007 engine cannot be enabled without an unexpired clearance reference; an expired clearance auto-disables
    it; an obstetric ultrasound cannot be routed to any engine by any configuration.
11. Budget hard cap reached → the feature degrades to its deterministic path with the badge shown and clinical work
    unaffected; per-tenant cost reporting is accurate; the CDSCO SaMD boundary ADR is written, approved and
    reflected in the in-product intended-use statements.
12. Previous gates green; `docs/PROGRESS.md` and `docs/DECISIONS.md` updated (model choices, providers, DPAs,
    residency configuration and every governance-committee threshold decision).
