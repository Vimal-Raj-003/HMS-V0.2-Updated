# AI-006 — AI-Assisted Coding (ICD-10 Diagnosis Coding from Notes with ICD-11 Readiness, Procedure Coding, DRG / PMJAY-HBP Package Grouping, Coder Review Workflow, Coding Audit & Anti-Upcoding Guardrails, Accuracy KPIs & Feedback Loop)

| Field | Value |
|---|---|
| Domain | AI & Advanced Tech |
| Module ID | AI-006 |
| Phase | 12 |
| Priority | P2 |
| Complexity | High |
| Depends on | **AI-001 §0 (AI Platform Foundation — mandatory)**, EN-027 (ICD-10/ICD-11/SNOMED CT/CPT-equivalent procedure & PMJAY-HBP masters, code validity dates), NC-003 (Digital MRD — the coding queue and deficiency workflow owner), OP-002 (consultation notes, diagnoses), IP-002 (discharge summary — the primary coding source), IP-006 (operative notes, procedures), RC-007 (PMJAY/CGHS/ECHS/ESIC package grouping), RC-001/RC-002 (claims & pre-auth), RC-004 (denial reasons feed back), EN-002 (payer rules), EN-024 (audit), EN-038 (approval), AI-002 (note understanding), AI-003 (external summaries), AI-004 (scribe-drafted notes) |
| Consumed by | NC-003 (coder worklist), RC-001/RC-002 (claim coding), RC-007 (scheme packages), EN-001 (case-mix analytics), NC-015 (quality indicators), IP-002 (discharge completion), NC-011 (MIS) |
| Feature flag | `module.ai_coding.enabled` (sub: `coding.icd10`, `coding.icd11_dual`, `coding.procedures`, `coding.drg_grouper`, `coding.hbp_packages`, `coding.audit`, `coding.realtime_hints`) |
| Primary roles | MRD Officer / Coder (43), Insurance/TPA Desk (28) |
| Secondary roles | Doctor (6/7/9 — query responses and confirmation), Medical Superintendent (4), Billing Executive (27), Finance Manager (46), Quality Manager (54), Auditor (58), Compliance/Legal |
| Regulatory | **ICD-10 (WHO, India adaptation) mandated for ABDM/NHCX claims and NABH/HMIS reporting; ICD-11 readiness (India has adopted ICD-11 for phased use — dual coding must be supportable)**; **NHA/PMJAY Health Benefit Package (HBP 2.2+) grouping rules and PMJAY anti-fraud guidelines (NAFU) — upcoding is a punishable offence with de-empanelment risk**; IRDAI claim documentation norms; NABH 6th edn IMS (medical record completeness & coding accuracy), MRD retention rules; DPDP (clinical text processing purpose-limited); CDSCO — coding assistance is administrative, explicitly not SaMD (AI-001 §0.8); Companies Act/GST for the financial consequences of coding |

## 1. Purpose
AI-006 reads the clinical documentation of a completed episode and proposes the codes a human coder would assign:
principal and secondary ICD-10 diagnoses (with ICD-11 dual-coding readiness), procedures, present-on-admission flags,
the DRG-style/HBP package grouping used by PMJAY and other schemes, and the documentation queries needed where the
note does not support a code. A qualified coder reviews every suggestion before it becomes the coded record. Its
guardrails are deliberately asymmetric: it is designed to be **conservative about anything that increases
reimbursement** and vocal about documentation gaps.

## 2. Users & Jobs-to-be-done
- **Coder / MRD officer (43, desktop, all day)**: open an episode, see suggested codes with the exact supporting text
  quoted from the record, accept in bulk what is obvious, focus their expertise on the 20 % that is hard, and clear
  the coding backlog within the discharge-to-code TAT the hospital promises payers.
- **Insurance desk (28)**: get claim-ready codes and the scheme package early enough to file within the payer's
  submission window, with denial-risk-relevant coding issues flagged (AI-005 §3.4).
- **Doctor (6/7/9)**: answer a short, specific documentation query ("was the pneumonia present on admission?",
  "specify the laterality of the fracture") from their worklist in seconds, rather than being chased by MRD a week
  later.
- **Coding auditor / Quality (54/58)**: sample coded episodes, compare AI suggestion vs coder decision vs audit
  verdict, and evidence coding accuracy for NABH and for payer audits.
- **Medical Superintendent / Compliance (4)**: prove the hospital's coding is defensible — that no code was assigned
  without documentation, and that the system actively resists upcoding.

## 3. Core Workflows

### 3.1 Episode intake and coding readiness
1. On `patient.discharged` (IP) or `encounter.closed` (OP day-care/procedure), NC-003 creates the coding task.
   AI-006 first runs a **documentation-completeness check**: is the discharge summary signed? Are operative notes
   present for every scheduled procedure? Are pathology/imaging reports finalised? → incomplete episodes are held with
   a deficiency list (NC-003's existing mechanism) rather than coded from partial records → Event
   `coding.episode.not_ready`.
2. When ready, the coding job assembles the source bundle: discharge summary, admission note, daily progress notes,
   operative and anaesthesia notes, pathology/microbiology/radiology reports, medication list, and — flagged
   separately — any **external** documents (AI-003) which may inform but never solely justify a code.
3. Text is redacted (AI-001 §0.5) and chunked; retrieval brings in the hospital's own coding guidance (coding manual,
   payer-specific rules, previously audited exemplars) → Event `coding.suggestion.requested`.

### 3.2 Diagnosis coding (ICD-10, ICD-11-ready)
1. The model proposes a **schema-validated** set: `principal_diagnosis` (one), `secondary_diagnoses[]`, each with
   `icd10_code`, `icd10_title`, `evidence_quotes[]` (verbatim spans with document id + offset), `confidence`,
   `poa_flag` enum(present_on_admission/hospital_acquired/unknown/not_applicable), `chronic_vs_acute`, `laterality`,
   and `specificity_gap` when only an unspecified code is supported.
2. **Every code must exist and be valid on the discharge date** in EN-027's ICD master (codes are effective-dated;
   an ICD-10 code retired before the episode is rejected). Unresolvable codes are dropped, never shown.
3. **Every code must have at least one evidence quote from an internal, signed document.** A code with no quote is
   not proposed; a code supported only by an external document is proposed with an explicit "external evidence only —
   requires clinician confirmation" flag.
4. **Principal-diagnosis selection follows the coding rules the hospital uses** ("the condition established after
   study to be chiefly responsible for the admission"), and the model must state *why* it chose it. Where two
   candidates are close, both are presented for the coder to choose — the system does not silently pick the
   higher-weighted one (this is an anti-upcoding control, §5).
5. **ICD-11 dual coding**: when `coding.icd11_dual` is on, the ICD-11 stem code + any postcoordination cluster is
   proposed alongside ICD-10 using EN-027's ICD-10↔ICD-11 concept map; disagreements between the mapped and the
   independently-suggested ICD-11 code are flagged for the coder. ICD-10 remains the billing code until the payer
   ecosystem moves; ICD-11 is stored in parallel so the switch is a configuration change, not a re-coding project.
6. Symptom codes (R-chapter) are suppressed when a definitive diagnosis is documented; conversely, the model may not
   promote a symptom to a diagnosis.

### 3.3 Procedure coding
1. Procedures are extracted from operative notes, OT records (IP-006), procedure console entries (OP-010) and the
   billed service lines — **and cross-checked**: a procedure code proposed with no corresponding OT/procedure record
   is flagged as a documentation discrepancy, and a performed procedure with no code is flagged as a missed code
   (revenue integrity, RC-006).
2. Each procedure carries date/time, laterality, approach, anaesthesia type, surgeon, implants used (TR-003 UDI
   linkage), and evidence quotes.
3. The hospital's procedure code system is configurable (ICD-10-PCS, a CPT-equivalent local set, or the hospital's
   own service master mapped to scheme package codes) — EN-027 owns the master; AI-006 only proposes within it.

### 3.4 DRG-style / scheme package grouping
1. Once diagnoses and procedures are proposed, the **grouper** runs. The grouper itself is **deterministic**, not
   generative: it is a rules table (`coding_grouper_rules`) mapping (principal dx, secondary dx set, procedures, age,
   sex, discharge status, LOS, comorbidity/complication level) → package/DRG. The model's role is only to supply the
   codes and to *explain* the grouping in plain language.
2. For **PMJAY**, grouping targets the current HBP version (RC-007), respecting package hierarchy, exclusions,
   stratification (e.g. ICU days), pre-defined implant add-ons, and the "unbundling is prohibited" rules. For CGHS/
   ECHS/ESIC and private payers, their own package masters apply (RC-003/EN-002).
3. The grouper output shows: matched package(s), the rate, the alternative packages considered and **why each was
   rejected**, and any rule that would make the claim suspicious to the payer (LOS below package norm, package
   combination flagged by NAFU-style rules).
4. **Anti-unbundling and anti-upcoding checks run here** (§5) and can downgrade or block a package suggestion.

### 3.5 Coder review workflow (NC-003)
1. The coder opens the episode in a split view: documents left (with evidence quotes highlighted in situ), suggestions
   right. Each suggested code has Accept / Edit / Reject with a reason, and a keyboard-first flow.
2. **Bulk-accept is permitted only for high-confidence codes that carry internal evidence quotes**, and never for the
   principal diagnosis or for any code that changes the package/DRG — those always require an individual decision.
3. **Documentation queries**: where the note is ambiguous or non-specific, AI-006 drafts a **non-leading** query to the
   clinician (a compliance requirement — a query may not suggest the answer or mention reimbursement impact). The
   coder edits and sends it; it lands in the doctor's worklist with the quoted text and a 48-hour SLA. Responses are
   appended to the record as an addendum (never an edit of a signed note) → Events `coding.query.raised|answered`.
4. The coder finalises → codes are written to NC-003's coding record by the coder's action, with per-code provenance
   (`source = ai_assisted | coder | query_response`) → Event `coding.episode.coded` → RC-001/RC-002 pick them up.
5. **Second-level review** is mandatory for: episodes above a value threshold, all scheme (PMJAY/CGHS) claims,
   any episode where the coder's decision increased the package rate versus the AI suggestion, and a random 5 %
   sample. Reviewer is a different person (four-eyes).
6. Exceptions: contradictory documentation → the episode is returned to the clinician; missing operative note → held;
   coder disagrees fundamentally → reject-all with reason, which becomes a golden-dataset case.

### 3.6 Real-time coding hints (optional, opt-in)
- While the doctor writes the discharge summary (or during an AI-004 scribe review), AI-006 can show passive hints:
  "documenting the organism would support a more specific code", "laterality not stated". Hints are **documentation
  prompts only** — they never name a reimbursement amount, never suggest adding a diagnosis the patient does not have,
  and are suppressed entirely if the hospital does not enable them. This boundary is the difference between clinical
  documentation improvement and inducement.

### 3.7 Coding audit & the feedback loop
1. Every episode stores the triple: AI suggestion → coder decision → (if sampled) auditor verdict. From this the
   system computes AI precision/recall per code chapter, coder agreement, and audit-confirmed accuracy.
2. **Denial feedback**: RC-004 denial reasons that are coding-related (invalid code, code–procedure mismatch,
   documentation insufficient, package not payable) are joined back to the episode and become training/eval cases.
3. Systematic patterns (a chapter where AI recall is poor, a payer that consistently rejects a package) raise
   improvement tasks rather than silent drift.
4. Monthly coding-quality pack to Quality/MS: accuracy, TAT, query volume and turnaround, case-mix index trend with
   an explicit check that CMI drift is explained by case mix and not by coding behaviour.

## 4. Data Model (schema `ai`, prefix `coding_`; coded record of truth stays in NC-003)
- `coding_episodes` — id uuidv7, hospital_id, branch_id, encounter_id, patient_id, episode_type enum(ip/op/daycare/
  procedure/er), discharge_at, documents_ref jsonb (document ids + types + signed flags), readiness
  enum(not_ready/ready/held), deficiency_list jsonb, status enum(pending/suggested/in_review/coded/queried/
  second_review/finalised/rejected), assigned_coder_id, coded_at, tat_hours, payer_id?, scheme enum(none/pmjay/cghs/
  echs/esic/private/corporate), value_band; indexes (hospital_id, status, discharge_at), (assigned_coder_id, status).
- `coding_suggestions` — id, episode_id, request_id (→ `ai_requests`), prompt_version_id, model_id, generated_at,
  payload jsonb (full schema-validated set), overall_confidence, latency_ms, cost_amount, superseded_by?.
- `coding_suggestion_lines` — id, suggestion_id, line_type enum(principal_dx/secondary_dx/procedure/poa/icd11_dual),
  code_system enum(icd10/icd11/procedure/hbp), code, title, confidence, evidence jsonb (document_id, quote, offset),
  evidence_internal bool, specificity_gap bool, laterality, poa_flag, rank, rationale,
  status enum(proposed/accepted/edited/rejected), decided_by, decided_at, final_code, reject_reason_code.
- `coding_grouper_rules` — id, hospital_id?, scheme, package_version (e.g. HBP 2.2), rule_order, condition jsonb
  (dx/proc/age/sex/los/discharge_status predicates), package_code, package_name, rate_ref (RC-003), exclusions jsonb,
  unbundling_group, effective_from/to — deterministic, versioned, effective-dated, never model-generated.
- `coding_grouper_results` — id, episode_id, scheme, package_code, package_version, rate, matched_rule_id,
  alternatives jsonb (considered packages + rejection reasons), warnings jsonb (los_below_norm, unbundling_suspected,
  package_combination_flagged), status, confirmed_by, confirmed_at.
- `coding_queries` — id, episode_id, raised_by, clinician_user_id, question_text, quoted_text, document_ref,
  leading_check_passed bool, raised_at, sla_due_at, answered_at, answer_text, addendum_ref, status
  enum(open/answered/expired/withdrawn), outcome enum(code_added/code_changed/no_change).
- `coding_audits` — id, episode_id, sample_reason enum(random/high_value/scheme/rate_increase/denial), auditor_id,
  audited_at, verdict enum(agree/minor_variance/major_variance/upcoding_suspected/undercoding),
  corrected_codes jsonb, financial_impact numeric, notes, capa_ref (NC-015).
- `coding_upcoding_flags` — id, episode_id, flag_type enum(cc_without_evidence/principal_switch_raises_rate/
  unbundling/procedure_without_record/package_jump_vs_peer/coder_pattern), detail jsonb, severity, raised_at,
  reviewed_by, resolution enum(justified/corrected/escalated), escalation_ref.
- `coding_accuracy_daily` (read model) — hospital_id, day, chapter, ai_precision, ai_recall, coder_agreement_pct,
  audit_accuracy_pct, episodes, queries_raised, median_tat_hours, cmi.
- Retention: suggestions and decisions with the medical record (per NC-003 retention, typically 10 years for adults);
  audits and upcoding flags 10 years (payer audit defence).

## 5. Business Rules & Validations
- **A coder, not the model, assigns codes.** The coded record is written by the coder's action; suggestions never
  auto-post, even at maximum confidence, and never post to a claim directly.
- **No code without internal documented evidence.** Every proposed code carries a verbatim quote from a signed
  internal document; external-only evidence is flagged and requires clinician confirmation.
- **Anti-upcoding guardrails (the module's defining constraint):**
  1. The model is **not given package rates or reimbursement values** in its context — it cannot optimise for money
     because it cannot see money.
  2. When two principal-diagnosis candidates are clinically close, both are surfaced; the system never auto-selects
     the higher-paying one, and if the coder selects the higher-paying option a justification is mandatory and the
     episode routes to second-level review.
  3. A comorbidity/complication code that changes the package or DRG tier requires an **explicit, quoted clinical
     statement** — not an inference from a lab value or a drug (e.g. a potassium of 5.6 does not code hyperkalaemia;
     the clinician must have documented it).
  4. **Unbundling detection**: procedure combinations that the scheme requires to be billed as a single package are
     blocked from being split, with the rule cited.
  5. **Peer/pattern monitoring**: an episode whose package is materially higher than the hospital's own distribution
     for similar cases raises `coding.upcoding.flagged`; a coder whose rate-increasing edits are statistical outliers
     is reviewed by MRD leadership (never automated punishment).
  6. **Undercoding is also flagged** — the guardrail is accuracy, not timidity; missed documented codes are surfaced
     as revenue-integrity findings (RC-006).
- **Documentation queries must be non-leading**: an automated check rejects a drafted query containing a suggested
  answer, a reimbursement reference, or a yes/no framing that implies the desired response.
- Codes are validated against EN-027 for existence, effective date, sex/age applicability, and code-pair rules
  (e.g. manifestation codes requiring an underlying-condition code, unacceptable-as-principal codes).
- **A signed clinical note is never edited** by this module; clarifications become addenda.
- Scheme claims (PMJAY/CGHS) always require second-level review before submission, regardless of confidence.
- ICD-11 codes are stored in parallel and are never submitted to a payer until the hospital flips the billing code
  system, which is an EN-038-approved configuration change.
- The whole module is auditable end to end: for any code on any claim, one query returns the suggestion, the evidence
  quote, the coder, the reviewer and any query raised.

## 6. API Surface (`/api/v1/coding`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET | /episodes?status&coder&scheme&from&to | coding worklist | `coding.episode.read` (43, 28) | cursor; sorted by payer deadline |
| POST | /episodes/:id/suggest | run/re-run suggestion | `coding.suggest.run` | async; blocked if not ready |
| GET | /episodes/:id/suggestions | suggestion set with evidence | `coding.episode.read` | quotes + offsets |
| POST | /episodes/:id/lines/:lineId/accept \| /edit \| /reject | per-code decision | `coding.line.decide` (43) | reason on reject/edit |
| POST | /episodes/:id/bulk-accept | accept high-confidence non-principal lines | `coding.line.decide` | principal & rate-changing excluded |
| POST | /episodes/:id/group | run the deterministic grouper | `coding.group.run` | shows alternatives & rejections |
| POST | /episodes/:id/finalise | write the coded record to NC-003 | `coding.episode.finalise` (43) | triggers second review where required |
| POST | /episodes/:id/second-review | four-eyes review | `coding.episode.review` (43 senior, 4) | different user enforced |
| POST | /queries ; POST /queries/:id/answer ; GET /queries?clinician&status | documentation queries | `coding.query.raise` (43) / `coding.query.answer` (6/7/9) | non-leading check |
| GET/POST | /grouper-rules ; POST /grouper-rules/import | package rule maintenance | `coding.grouper.manage` (28, 46 + EN-038) | versioned, effective-dated |
| GET | /audits ; POST /audits/:episodeId | coding audit | `coding.audit.perform` (54, 58, 43 senior) | sampling engine |
| GET | /upcoding-flags ; POST /upcoding-flags/:id/resolve | compliance review | `coding.compliance.read|manage` (4, 54) | |
| GET | /metrics/accuracy ; /metrics/tat ; /metrics/cmi | KPIs | `coding.report.read` | read models |
| POST | /hints/note | real-time documentation hints (opt-in) | `coding.hint.use` (6/7/9) | no rate/value in output |

## 7. Domain Events (outbox)
- `coding.episode.not_ready` → NC-003 deficiency workflow, clinician task.
- `coding.suggestion.generated` → coder worklist.
- `coding.line.accepted|edited|rejected` → `ai.suggestion.*` spine, accuracy read model.
- `coding.query.raised|answered|expired` → clinician worklist, NC-003 documentation-timeliness indicator.
- `coding.episode.coded|finalised` → RC-001/RC-002 (claim build), RC-007 (scheme package), EN-001 case-mix analytics,
  IP-002 completion.
- `coding.package.grouped` → RC-007, billing reconciliation (IP-005/IP-008 package variance).
- **`coding.upcoding.flagged`** → MS + Quality + Compliance immediately; NC-015 if confirmed.
- `coding.undercoding.detected` → RC-006 revenue-leakage worklist.
- `coding.audit.completed` → quality pack; `coding.denial.linked` → eval dataset.
- Consumes: `patient.discharged`, `encounter.closed`, `note.signed`, `ot.note.finalised`, `lab.report.finalised`,
  `claim.denied` (RC-004 reasons), `mdm.icd.version_published`.

## 8. Screens (UI)
- **Coder Worklist** (desktop, MRD): episodes with age since discharge, payer submission deadline countdown, scheme
  chip, suggestion-ready badge, deficiency indicator, value band, assigned coder; filters and saved views; sorted by
  deadline risk. Shortcuts: `J/K` navigate, `Enter` open, `A` assign to me.
- **Coding Workspace** (desktop, the core screen, keyboard-first): **left** = document viewer (discharge summary,
  op note, reports as tabs) with evidence quotes highlighted and clickable; **right** = suggestion list grouped by
  principal / secondary / procedures / POA / ICD-11 dual, each row showing code, title, confidence chip, evidence
  snippet, and specificity-gap badge. Shortcuts: `A` accept line, `E` edit (opens code search with EN-027 lookup),
  `R` reject with reason, `Space` jump to evidence, `Q` raise a query, `Ctrl+G` run grouper, `Ctrl+Enter` finalise.
  A persistent banner shows "principal diagnosis requires an individual decision".
- **Grouper panel**: matched package with rate, the alternatives considered with rejection reasons, warning chips
  (LOS below norm, unbundling suspected), and the scheme's rule text on hover. Confirm is a separate deliberate action.
- **Documentation Query composer**: quoted text, drafted non-leading question with a live compliance check ("this
  question suggests an answer — rewrite"), recipient, SLA, and a preview of what the clinician will see.
- **Clinician Query worklist** (desktop/phone, doctor): short queries with the quoted note text, one-tap common
  answers plus free text, SLA countdown; answering creates an addendum, never an edit.
- **Second Review screen**: side-by-side AI suggestion vs coder's final codes vs the resulting package, with every
  difference highlighted and rate-increasing changes badged; reviewer must act on each difference.
- **Coding Audit workspace** (Quality/Auditor): sampled episodes, verdict capture, financial impact, CAPA link,
  and the AI-vs-coder-vs-audit agreement matrix.
- **Coding Compliance dashboard** (MS/Compliance): upcoding flags by type and coder, CMI trend with case-mix
  explanation, package distribution vs peer benchmark, scheme rejection reasons, second-review coverage.
- **Coding KPI dashboard** (MRD lead): discharge-to-code TAT (median/p90), backlog age, AI acceptance rate, AI
  precision/recall by ICD chapter, query volume and turnaround, coder productivity (coded episodes/day) and accuracy.
- Empty/error states: "Episode not ready — operative note for 12 Jun is unsigned", "No suggestion: discharge summary
  missing", "Code E11.9 retired on 01 Jan — choose a valid alternative", "AI assist unavailable — code manually
  (masters and search work normally)".

## 9. Integrations
- **EN-027** for ICD-10 / ICD-11 / procedure / HBP masters with effective dating and the ICD-10↔ICD-11 concept map;
  a new master version publishes an event that invalidates cached suggestions for un-finalised episodes.
- **NC-003** owns the coded record, the deficiency workflow and retention; AI-006 writes only through its API.
- **RC-007** for PMJAY HBP package versions and NHA rules; **RC-003/EN-002** for private payer packages and rates;
  **RC-001/RC-002** consume final codes; **RC-004** denials feed back.
- **AI-004** scribe-drafted notes and **AI-003** external summaries are inputs (external evidence flagged);
  **AI-002** shares the note-understanding layer; **AI-005** consumes coding features for denial risk.
- Optional third-party **licensed encoder/grouper** (3M-class) may be plugged in behind the grouper interface for
  hospitals that already licence one — the rules table is then read-only and sourced from the vendor.

## 10. Reports & Analytics
- **AI quality**: precision/recall/F1 per ICD chapter and per procedure family, top-1 principal-diagnosis agreement,
  POA accuracy, evidence-quote validity rate (does the quote actually support the code, sampled), acceptance rate
  and edit distance, all sliced by model/prompt version.
- **Coding operations**: discharge-to-code TAT median/p90, backlog by age, episodes held for deficiency, query volume
  per 100 episodes and query turnaround, coder productivity and accuracy.
- **Financial & compliance**: case-mix index trend, package distribution, rate-increasing edits per coder, upcoding
  flags raised/confirmed, undercoding recovered (RC-006), coding-related denial rate before vs after AI-006, second
  review coverage and findings.
- **Impact**: coding cost per episode, claims filed within the payer window %, denial rate attributable to coding.
- Read models: `analytics.mv_coding_accuracy_daily`, `mv_coding_tat_daily`, `mv_coding_cmi_monthly`,
  `mv_coding_compliance_monthly`.

## 11. Notifications
- Coder: new episodes assigned, deadline at risk (payer submission window), suggestion re-run needed after a master
  version change.
- Clinician: documentation query raised (in-app + one reminder at 24 h), query expiring, unsigned operative note
  blocking coding.
- MRD lead: backlog above threshold, TAT breach, coder accuracy outlier.
- **MS/Compliance: `coding.upcoding.flagged` immediately**, confirmed upcoding as an NC-015 incident.
- Insurance desk: coded and grouped, claim-ready; package warnings that could trigger a payer query.
- Governance: monthly coding-quality pack; AI accuracy regression after a prompt/model change.

## 12. Permissions (RBAC keys)
`coding.episode.read` (43, 28, 4, 54, 58) · `coding.suggest.run` (43) · `coding.line.decide` (43 only — clinicians
cannot self-code their episodes) · `coding.episode.finalise` (43) · `coding.episode.review` (senior 43, 4) ·
`coding.group.run` (43, 28) · `coding.grouper.manage` (28, 46 + EN-038) · `coding.query.raise` (43) /
`coding.query.answer` (6, 7, 9, 14 with co-sign) · `coding.audit.perform` (54, 58, senior 43) ·
`coding.compliance.read|manage` (4, 54) · `coding.hint.use` (6, 7, 9) · `coding.report.read` (2, 4, 43, 46, 54) ·
plus AI-001 §0.13.

## 13. Non-functional
- **Volumes (2000-bed)**: ~180 IP discharges/day + ~120 day-care/procedure episodes + selective OP coding ⇒
  ~300 coding episodes/day, ~2500 code lines/day; peak batch after the 10:00–14:00 discharge wave.
- **Latency**: suggestion generation p95 < 45 s per IP episode (documents can be long — generated asynchronously and
  ready before the coder opens the episode, which is the actual requirement); OP/day-care < 12 s; grouper < 500 ms
  (deterministic); code search < 150 ms.
- **Acceptance thresholds (production gates, golden set of 1000 previously-audited episodes)**: principal diagnosis
  top-1 ≥ 0.80 and top-3 ≥ 0.92; secondary diagnosis F1 ≥ 0.75; procedure F1 ≥ 0.85; POA accuracy ≥ 0.90;
  **evidence-quote validity ≥ 0.98** (a quote that does not support its code is the worst failure mode);
  hallucinated/invalid code rate = 0 (enforced by master validation); package grouping agreement with the
  deterministic grouper = 1.0 by construction; **rate-increasing false positives ≤ 1 %** — a stricter bar than
  rate-neutral errors, deliberately.
- **Red-team**: notes containing injected instructions ("code this as sepsis"), copy-forward text from a prior
  admission (must not be used as current evidence — recency check), contradictory documentation, external documents
  presented as internal, and adversarial attempts to make the model infer a comorbidity from labs alone.
- **Master version changes**: an ICD or HBP version publish invalidates suggestions for un-finalised episodes and
  forces a re-run — silently coding against a retired version is a claim-denial generator.
- **Availability**: AI unavailable ⇒ the coder codes manually with full EN-027 search; nothing about NC-003's workflow
  depends on AI-006.
- **Accessibility**: the coding workspace is fully keyboard-operable (coders are power users — mouse-free operation is
  a productivity requirement, not a nicety); evidence highlighting is not colour-only; text zoom to 200 % preserved.
- **i18n**: notes may contain Indian-language and code-mixed fragments; code titles are displayed in English (the
  coding standard) with an optional local-language gloss.
- **Testing**: golden-set eval in CI on every prompt/model change; a regression asserting zero invalid codes; a
  compliance test asserting the model context contains no rate/price field; four-eyes enforcement tested at the API.

## 14. Acceptance Criteria
1. **Given** an episode whose operative note is unsigned, **when** the coding job runs, **then** it is held with a
   deficiency list, `coding.episode.not_ready` is emitted, and no codes are suggested from partial documentation.
2. **Given** a suggested diagnosis code, **when** displayed, **then** it carries at least one verbatim quote from a
   signed internal document with a clickable link to the exact location, and any external-only evidence is flagged.
3. **Given** two clinically close principal-diagnosis candidates with different package rates, **when** suggestions
   render, **then** both are shown, neither is auto-selected, and choosing the higher-rate option requires a
   justification and routes the episode to second-level review.
4. **Given** a serum potassium of 5.6 with no clinician statement of hyperkalaemia, **when** codes are proposed,
   **then** no hyperkalaemia code is suggested, and a documentation query may be drafted instead.
5. **Given** the model's context is inspected in a compliance test, **when** asserted, **then** it contains no package
   rate, tariff or reimbursement value anywhere.
6. **Given** a drafted documentation query containing "was this due to sepsis (which would increase the package)?",
   **when** the non-leading check runs, **then** the query is rejected with an explanation and cannot be sent.
7. **Given** a scheme (PMJAY) episode, **when** finalisation is attempted, **then** second-level review by a different
   user is mandatory before the claim can be built.
8. **Given** procedures billed with no operative record, **when** coding runs, **then** a documentation discrepancy is
   raised, and a performed procedure with no code is raised as a missed-code finding to RC-006.
9. **Given** the grouper runs, **when** results render, **then** the matched package, the alternatives considered and
   the reason each was rejected are shown, and any unbundling attempt is blocked with the scheme rule cited.
10. **Given** an ICD-10 code retired before the discharge date, **when** suggested or manually entered, **then** it is
    rejected by master validation with a valid-alternative prompt.
11. **Given** ICD-11 dual coding is enabled, **when** codes are finalised, **then** both ICD-10 and ICD-11 are stored,
    only ICD-10 is submitted to the payer, and mapping disagreements are flagged for the coder.
12. **Given** an episode's package is materially higher than the hospital's distribution for similar cases, **when**
    finalised, **then** `coding.upcoding.flagged` is emitted, compliance is notified, and the flag must be resolved
    as justified or corrected.
13. **Given** a coding-related denial from RC-004, **when** processed, **then** the episode is linked, the reason is
    stored, and the case is added to the evaluation dataset.
14. **Given** an ICD master version publish, **when** it occurs, **then** suggestions for un-finalised episodes are
    invalidated and re-run before coding can complete.
15. **Given** the AI service is unavailable, **when** a coder opens an episode, **then** manual coding with full
    EN-027 search works normally and the TAT clock is unaffected.
16. **Given** any code on a submitted claim, **when** audited, **then** one query returns the AI suggestion, the
    evidence quote, the coder's decision, the reviewer, any query raised and the model/prompt versions.

## 15. Enhancements / Later phases
- **Computer-assisted CDI (clinical documentation improvement) programme**: concurrent (during admission) queries
  rather than post-discharge, which is where the real documentation quality gain is — sequenced after query fatigue
  is measured.
- **Payer-specific coding rules engine**: learn from RC-004 denial patterns which code combinations a given payer
  rejects, and warn before submission.
- **Auto-suggested claim narrative** for pre-auth and appeals (RC-002/RC-004), drafted from the same evidence quotes.
- **ICD-11 primary cutover kit**: dual-coding accuracy report, coder training set and a switchover checklist.
- **SNOMED CT problem-list normalisation** feeding ABDM FHIR Condition resources with proper coding.
- **Case-mix benchmarking** against anonymised peer hospitals (k-anonymity ≥ 5) for CMI credibility.
- **Coder assist for OP high-volume coding** (day-care, dialysis, chemo cycles) where the marginal minute matters most.
- **Continuous fine-tuning** on the hospital's own audited coding decisions (on-prem, consented, de-identified).

## 16. Open Questions for the Hospital
1. Which coding standards are in use today — ICD-10 only, or is ICD-11 dual coding required, and which procedure code
   system (ICD-10-PCS, a CPT-equivalent, or the hospital's service master)?
2. Which schemes does the hospital participate in (PMJAY/CGHS/ECHS/ESIC/state), and which HBP/package version is
   current? Who maintains the package rules today?
3. What is the promised discharge-to-code TAT, and what are the payer submission windows that drive it?
4. How many qualified coders are there, and what is today's backlog? (This decides whether AI-006 is a productivity
   tool or a backlog rescue.)
5. Does the hospital have historical audited coded episodes we can use as the golden dataset, and who owns coding
   audit today?
6. What is the hospital's documentation-query policy — who may raise queries, what SLA, and does the medical staff
   accept the non-leading query format?
7. Which episodes must go to second-level review (value threshold, schemes, rate-increasing edits), and who performs it?
8. Does the hospital already licence a commercial encoder/grouper that should be integrated instead of our rules table?
9. Are real-time coding hints to doctors acceptable, or is that seen as pressuring clinical documentation?
10. Who is accountable for coding compliance (upcoding flags, NAFU exposure), and what is the escalation path?
11. May clinical notes be processed by a cloud model for coding, or must this run on-prem?
12. What retention and audit-trail depth does the hospital's payer-audit experience require (how far back have payers
    actually asked)?
