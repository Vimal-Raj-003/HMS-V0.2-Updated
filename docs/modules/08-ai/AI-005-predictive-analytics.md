# AI-005 — Predictive Analytics (30-Day Readmission, No-Show & Overbooking, Length of Stay, Bed Demand & Staffing Forecast, Inventory Demand, Revenue Forecast, Deterioration/Sepsis Early Warning, Claim-Denial Risk — with Feature Store, Model Registry, Drift & Fairness Monitoring, SHAP Explainability)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | AI & Advanced Tech                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Module ID       | AI-005                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Phase           | 12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Complexity      | Very High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Depends on      | **AI-001 §0 (AI Platform Foundation — mandatory)**, EN-001 (analytics schema & semantic layer — the feature source), NC-011 (dataset registry), EN-029 (deterministic scores NEWS2/qSOFA remain authoritative), IP-001/IP-025 (admissions, bed board, patient flow), IP-002 (discharge), OP-001 (appointments/slots), NC-006 (stock ledger, item master), NC-005 (purchase lead times), NC-030 (duty roster), RC-004 (denials), RC-001/EN-002 (claims), OP-005/IP-005 (billing), EN-037 (alert routing), EN-024 (audit), EN-041 (multi-branch scope)                                                                                                                         |
| Consumed by     | IP-025 (bed command centre), IP-001/IP-003/IP-009 (ward & ICU), OP-001 (overbooking policy), PE-002 (recall & post-discharge calls), NC-006/NC-005 (replenishment), NC-030 (rostering), NC-009/NC-022 (finance & budget), RC-002/RC-004 (pre-auth & denial prevention), AI-002 (cites risk scores), EN-001 (dashboards)                                                                                                                                                                                                                                                                                                                                                      |
| Feature flag    | `module.ai_predict.enabled` (sub: `predict.readmission`, `predict.noshow`, `predict.los`, `predict.bed_demand`, `predict.staffing`, `predict.inventory`, `predict.revenue`, `predict.deterioration`, `predict.denial`)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Primary roles   | Bed Manager / Patient Flow (IP-025 operator), Nurse Supervisor / Matron (22), Hospital Admin (2), Finance Manager (46), Stores In-charge (44), Insurance Desk (28), Front Office lead (24)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Secondary roles | Medical Superintendent (4 — clinical model governance), Intensivist (11), Quality Manager (54), Data steward / analyst, DPO (57 — profiling governance), Auditor (58)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Regulatory      | DPDP Act 2023 & Rules 2025 (**automated profiling of patients requires a lawful purpose, transparency and human review; §9 prohibits behavioural profiling of children**), CDSCO/India MDR — clinical risk models are **decision-support outputs presented to clinicians, never autonomous clinical action** (AI-001 §0.8); NABH 6th edn (readmission, ALOS, occupancy are declared quality indicators — model outputs must never be used to restate an actual indicator); IRDAI (no denial or care-limiting decision may be made by a model); NMC (clinical accountability rests with the practitioner); fairness expectations for scheme vs self-pay patients (PMJAY/CGHS) |

## 1. Purpose

AI-005 is the hospital's supervised-ML layer: a governed feature store over EN-001's analytics schema, a training and
registry pipeline, and nine production models whose outputs drive concrete operational decisions — who gets a
post-discharge call, which slots to overbook, when to open the surge ward, how many nurses to roster, what to
reorder, what revenue to expect, which patient is deteriorating, and which claim will be denied. Every prediction is
explainable (SHAP), calibrated, monitored for drift and fairness, and routed to a human who decides. It never
diagnoses, never denies care, and never overrides a deterministic score.

## 2. Users & Jobs-to-be-done

- **Bed manager / patient flow (IP-025, desktop + TV, hourly)**: a 72-hour bed-demand forecast by ward class and a
  ranked list of predicted discharges so housekeeping and admissions can be sequenced instead of firefought.
- **Nurse supervisor (22, weekly)**: a census and acuity forecast that turns into a roster proposal in NC-030,
  respecting nurse-patient ratios.
- **Front office lead (24, daily)**: which of tomorrow's appointments are likely no-shows, so reminders are targeted
  and a bounded overbooking policy is applied to the right slots.
- **Discharge planner / PE-002 team (daily)**: the 30-day readmission risk of every patient being discharged today,
  with the modifiable drivers, so the post-discharge call list is the right 40 patients, not a random 200.
- **Intensivist / ward nurse (11/18, continuous)**: a deterioration early-warning that fires earlier than NEWS2 by
  combining trends, labs and meds — presented **alongside** NEWS2, never instead of it.
- **Stores in-charge (44, weekly)**: demand forecast per item with lead-time-aware reorder proposals, so FEFO-managed
  drugs neither expire nor stock out.
- **Finance manager (46, monthly)**: revenue and collections forecast by payer and service line, with variance
  explanation, feeding NC-022 budgeting.
- **Insurance desk (28, per claim)**: denial risk before submission with the specific missing evidence, so RC-004
  becomes prevention rather than appeal.
- **Data steward / MS / DPO**: govern models — approve deployment, watch drift and fairness, retire what decays.

## 3. Core Workflows

### 3.1 Feature store

1. **Source of truth is EN-001's `analytics` schema** — AI-005 never reads transactional tables live. Features are
   defined declaratively (`predict_features`): key, description, entity (`patient` / `encounter` / `appointment` /
   `slot` / `ward` / `item` / `claim` / `branch`), SQL/Kysely expression over analytics facts, data type, refresh
   cadence, PHI level, and an explicit `allowed_for_models[]`.
2. Two serving paths, one definition (this is what prevents training/serving skew):
   **offline** materialised point-in-time-correct feature snapshots for training (`predict_feature_values`, keyed by
   entity + `as_of_ts`), and **online** a Redis hash refreshed by the same job for scoring.
3. **Point-in-time correctness is enforced**: a training row for a discharge on day D may only use feature values
   observable at or before D. The pipeline rejects any feature whose expression references a future-dated fact —
   leakage checks run in CI on every feature definition change.
4. **Forbidden features are declared and blocked at definition time**: caste, religion, exact address beyond PIN
   district, insurance-scheme membership _as a predictor of clinical need_, and any free-text field that could
   re-introduce a protected attribute. Payer class may be used for _financial_ models (denial, revenue) but never for
   _clinical_ models (readmission, deterioration, LOS).
5. Feature lineage is recorded: which analytics facts, which modules produced them, last refresh, null rate,
   distribution baseline (for PSI drift).

### 3.2 Training pipeline & model registry

1. A training run is declared as a versioned job (`predict_training_runs`): model key, algorithm, feature set version,
   label definition, **temporal split** (train on the older window, validate on the recent window — never a random
   split, which leaks time), hyperparameters, class balance handling, and the cohort filter.
2. Algorithms are deliberately boring and explainable-by-default: gradient-boosted trees (XGBoost/LightGBM) for
   tabular models, quantile regression / Prophet-class or SARIMAX for time series, logistic regression as the
   always-trained baseline (a model that cannot beat regularised logistic regression is not deployed).
3. Training runs on **de-identified** data inside the hospital's boundary (on-prem or the tenant's own cloud);
   patient identifiers are replaced by surrogate keys, and training data never leaves the tenant. Cross-tenant model
   training is prohibited without a written, per-tenant contractual opt-in.
4. Outputs: metrics (AUROC, AUPRC, calibration/Brier, ECE, MAE/MAPE for regressions, coverage for intervals),
   **fairness slices** (age band, sex, payer class, branch, urban/rural PIN cluster, language), SHAP global
   importances, a **model card** (AI-001 §0.8) and the serialised artefact with a checksum.
5. **Registry & promotion**: `predict_models` holds versions with stage `draft → shadow → champion → retired`.
   Promotion to champion requires: metric thresholds met (§13), calibration acceptable, no fairness gap > 5 pp on the
   primary metric, a signed model card, a shadow period (≥ 4 weeks for clinical models, ≥ 2 for operational), and
   Governance Committee approval (EN-038). Champion/challenger runs in parallel with automatic comparison.
6. **Rollback is one click** and takes effect within 30 s; the previous champion is always retained.
7. Retraining cadence per model (monthly for operational, quarterly for clinical) plus event-triggered retraining on
   drift alerts; every retrain re-runs the whole gate.

### 3.3 Scoring & operational integration

1. **Batch scoring** (nightly 02:00 hospital TZ, plus intra-day where stated) writes to `predict_scores`, never
   directly into a clinical or financial table.
2. Each score carries: model key + version, value, calibrated probability or interval, **risk band** (the operational
   unit, not the raw number), top-5 SHAP contributions in plain language, the modifiable subset of those drivers, and
   an expiry.
3. **Routing is the point** — a score with no owner and no action is dead weight. Each model declares its
   integration:

| Model                 | Cadence                        | Lands where                                        | Human decision                                                   |
| --------------------- | ------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------- |
| 30-day readmission    | at discharge + daily for IP    | IP-002 discharge checklist, PE-002 call list       | discharge planner enrols the patient in a follow-up pathway      |
| No-show               | T-72 h, T-24 h per appointment | OP-001 slot board, EN-009 reminder tiering         | front office applies the overbooking policy & targeted reminders |
| Length of stay        | on admission + daily           | IP-001/IP-025 bed board, RC-002 pre-auth extension | bed manager plans; case manager extends pre-auth early           |
| Bed demand (72 h/7 d) | hourly                         | IP-025 command centre, TV board                    | open/close surge beds, defer elective admissions                 |
| Staffing/acuity       | daily for the next 14 days     | NC-030 roster planner                              | supervisor approves the roster proposal                          |
| Inventory demand      | weekly + on stock event        | NC-006 reorder proposals, NC-005 indents           | stores raises the indent                                         |
| Revenue/collections   | monthly + rolling 90 d         | NC-009/NC-022, EN-001 dashboard                    | finance adjusts budget/AR focus                                  |
| Deterioration/sepsis  | every vitals/lab event         | IP-003/IP-009 patient rail **beside NEWS2**        | nurse escalates per policy                                       |
| Claim denial risk     | pre-submission                 | RC-001 claim workbench, RC-004                     | insurance desk fixes documentation before submitting             |

4. **Alert routing** goes through EN-037 with per-model priority; clinical models are capped at _informational_
   priority (EN-029 owns must-acknowledge escalation). Alert volume budgets apply exactly as in EN-029 §3.7 — a
   predictive alert that is ignored 90 % of the time is retired.
5. Every human action on a score (enrolled / dismissed / overbooked / reordered / documentation fixed) is captured as
   an outcome, closing the loop for the next evaluation.

### 3.4 Model-by-model definitions (labels & guardrails)

- **30-day readmission**: label = unplanned inpatient readmission to any branch within 30 days of discharge
  (planned/chemo/dialysis cycles excluded). Features: prior admissions, comorbidity burden, LOS, discharge
  disposition, med count/high-risk meds, key labs at discharge, follow-up booked, distance from hospital (district
  level), age. Output: risk band + modifiable drivers ("follow-up not booked", "no discharge medication counselling").
  **Guardrail**: never used to refuse admission, discharge or insurance; never shown to a payer.
- **No-show**: label = appointment not attended and not cancelled ≥ 2 h before. Features: prior no-show rate, lead
  time, slot time of day, weather-season proxy, department, first-visit vs follow-up, payment status, distance.
  **Overbooking policy is deterministic and bounded**: overbook only slots with predicted no-show ≥ threshold, cap at
  N per doctor per session (default 2), never for procedures/elderly/paediatric/scheme patients unless configured,
  and monitor realised wait time — if the wait-time KPI degrades, overbooking auto-suspends.
- **Length of stay**: predicted remaining LOS with an 80 % interval, updated daily. Used for bed planning and early
  pre-auth extension; **never** to pressure a clinical discharge decision, and the model card says so explicitly.
- **Bed demand & staffing**: time-series over admissions, ER arrivals, elective OT schedule, seasonality (dengue,
  festivals, exam season), and known events; outputs per ward class with intervals. Staffing translates the census +
  acuity forecast into required nurses by ratio (NC-030 constraints, ICU 1:1/1:2, ward 1:6 etc.).
- **Inventory demand**: per item, per store, weekly demand with lead time from NC-005 vendor history → suggested
  reorder point and quantity, ABC/VED-aware, expiry-aware (never suggest a quantity that cannot be consumed before
  shelf life), narcotic/Schedule X items excluded from auto-suggestion.
- **Revenue forecast**: by payer and service line, from booked volumes, case mix, tariff (RC-003), historical
  realisation and AR ageing; presented with intervals; never used to set clinical targets for doctors (an explicit
  policy statement in the model card).
- **Deterioration / sepsis early warning**: continuous, complementary to NEWS2/qSOFA. Rendered **beside** the
  deterministic score with the label "model-based, complementary". It may raise an informational nudge ("consider a
  fresh set of vitals") but the escalation ladder, the must-acknowledge behaviour and the rapid-response trigger
  belong exclusively to EN-029. If the model and NEWS2 disagree, NEWS2's band is what drives policy.
- **Claim denial risk**: label = denial or query on the submitted claim (RC-004 reasons). Features: payer, package,
  document completeness, coding pattern, LOS vs package norm, pre-auth deviation, past denial rate for that
  payer/package. Output: risk band + **specific missing evidence**, which is the actionable part.

### 3.5 Monitoring, drift & fairness

1. Daily: prediction volume, score distribution, null-feature rate, serving latency, feature freshness.
2. **Input drift** — PSI per feature vs the training baseline; PSI > 0.2 flags, > 0.25 on a top-5 feature triggers
   retraining review. **Output drift** — score distribution shift, calibration decay (Brier/ECE recomputed as labels
   mature).
3. **Label maturation** is handled honestly: readmission labels arrive 30 days later, denial labels weeks later, so
   the performance dashboard shows both "matured" metrics and "provisional" ones with the observation window stated.
4. **Fairness**: the primary metric is recomputed per cohort (age band, sex, payer class incl. PMJAY/CGHS/self-pay,
   branch, urban/rural). A gap > 5 pp raises `ai.model.bias_flagged` and the model is reviewed; a gap > 10 pp on a
   clinical model auto-demotes it to shadow.
5. **Adverse-impact review** for any model whose output could reduce a patient's access to a service (overbooking,
   scheduling priority): the committee must explicitly confirm no scheme-patient disadvantage.
6. Incidents (a model that misled an operational decision) are logged in NC-015 with the score id.

### 3.6 Exceptions

- **Model unavailable / stale features** → the score is not shown at all rather than shown stale; the UI falls back to
  the heuristic (AI-001 §0.7) with a "heuristic" badge.
- **Cold start** (new hospital, new branch, < 6 months of data) → ship the heuristic baselines and a clearly-labelled
  "insufficient local data" state; a model may not be trained on fewer than the minimum sample sizes in §13.
- **Data quality break** (an upstream module changes its event schema) → feature freshness alert, model paused, not
  silently degraded.
- **Withdrawn AI-processing consent** → the patient is excluded from patient-level clinical predictions; aggregate
  forecasts (beds, staffing, inventory, revenue) are unaffected as they are non-identifying.

## 4. Data Model (schema `ai`, prefix `predict_`; shared tables per AI-001 §0.10)

- `predict_features` — id, hospital_id?, key, entity enum(patient/encounter/appointment/slot/ward/item/claim/branch),
  description, expression_ref (analytics SQL/Kysely fragment), dtype, refresh_cadence, phi_level, allowed_models[],
  forbidden bool, baseline_stats jsonb, owner, version, effective_from; UNIQUE(hospital_id, key, version).
- `predict_feature_values` — entity_type, entity_id, hospital_id, as_of_ts, feature_key, value_num/value_txt/value_bool,
  computed_at; **partitioned monthly**; PK (entity_type, entity_id, feature_key, as_of_ts) — the point-in-time store.
- `predict_models` — id, hospital_id?, key (`readmission_30d`, `noshow`, `los`, `bed_demand`, `staffing`,
  `inventory_demand`, `revenue_forecast`, `deterioration`, `denial_risk`), version, algorithm, feature_set_version,
  label_definition_md, training_run_id, artefact_ref, checksum, stage enum(draft/shadow/champion/retired),
  metrics jsonb, calibration jsonb, fairness jsonb, shap_global jsonb, model_card_md, approved_by, approved_at,
  promoted_at, retired_at; UNIQUE(hospital_id, key, version).
- `predict_training_runs` — id, model_key, started_at, finished_at, data_window_from/to, split_strategy, rows_train,
  rows_val, hyperparameters jsonb, metrics jsonb, baseline_metrics jsonb (logistic/naive), leakage_checks jsonb,
  status, triggered_by enum(schedule/drift/manual), artefacts_ref, cost.
- `predict_scores` — id uuidv7, hospital_id, branch_id?, model_key, model_version, entity_type, entity_id,
  patient_id?, scored_at, value numeric, probability numeric?, interval_low, interval_high, risk_band
  enum(low/medium/high/very_high)?, drivers jsonb (top-5 SHAP with plain-language text), modifiable_drivers jsonb,
  expires_at, shadow bool; **partitioned monthly**; indexes (hospital_id, model_key, scored_at desc),
  (entity_type, entity_id, model_key, scored_at desc).
- `predict_outcomes` — score_id, label_value, label_observed_at, matured bool, human_action enum(enrolled/dismissed/
  overbooked/reordered/documentation_fixed/escalated/none), action_by, action_at, action_note — the closed loop.
- `predict_drift` — model_key, model_version, day, feature_key?, psi, distribution jsonb, calibration_ece,
  metric_provisional, metric_matured, cohort jsonb, alert_raised.
- `predict_alert_policies` — model_key, band, notify_roles[], channel, priority (capped at informational for clinical
  models), max_per_day, suppression_hours, active.
- `predict_overbooking_policy` — hospital_id, branch_id?, department_id?, doctor_id?, min_noshow_probability,
  max_overbook_per_session, excluded_patient_classes[], excluded_slot_types[], wait_time_guard_minutes,
  auto_suspend bool, effective_from, approved_by.
- `predict_forecasts` — model_key, hospital_id, branch_id, dimension jsonb (ward_class/item_id/payer/service_line),
  horizon_ts, value, interval_low, interval_high, generated_at, model_version — the time-series output store.
- Retention: scores 3 years (clinical scores 10 years with the record), feature values 24 months, training artefacts
  for the life of any model version + 2 years, drift metrics 3 years.

## 5. Business Rules & Validations

- **No model output ever takes an action by itself.** Every integration point is a proposal to a named human role
  with an accept/dismiss action that is recorded.
- **A model may never be used to deny, delay or ration clinical care**, to refuse admission, to shorten a clinically
  indicated stay, or to justify a claim denial to a patient. This is stated in every relevant model card and enforced
  by the absence of any such write path.
- **Deterministic scores win**: EN-029's NEWS2/qSOFA/critical values are authoritative; AI-005's deterioration model
  is complementary, capped at informational priority, and displayed beside — never instead of — the deterministic band.
- **Point-in-time correctness and leakage checks are CI gates**, not review conventions.
- **Forbidden features** (§3.1) are blocked at definition time; payer class is blocked for clinical models.
- **DPDP profiling rules**: patient-level predictions require the declared analytics purpose in the consent notice;
  children's data is excluded from any non-clinical profiling; a patient may request the reasoning behind a
  prediction that affected them (the SHAP drivers, in plain language, are the answer, and DSAR export includes them).
- **Calibration is a release requirement**, not a nicety: a risk band must mean what it says (observed rate within the
  band's stated range ±20 % relative), because operations will act on the band.
- Overbooking is bounded, excludes vulnerable classes by default, and **auto-suspends** if the realised wait-time KPI
  degrades beyond the guard.
- Inventory suggestions may never exceed consumable-before-expiry quantities and never cover narcotics/Schedule X.
- Revenue and productivity forecasts may not be turned into individual doctor targets (policy statement in the model
  card; the API does not expose per-doctor revenue prediction).
- A model with no human actions recorded against it for 60 days is flagged for retirement (dead-weight rule).
- Champion promotion, demotion and rollback are audited with the metrics that justified them.

## 6. API Surface (`/api/v1/predict`)

| Method   | Path                                                                | Purpose                                 | Permission                                   | Notes                              |
| -------- | ------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------- | ---------------------------------- |
| GET/POST | /features ; /features/:key/versions                                 | feature definitions                     | `predict.feature.read                        | manage` (data steward)             | leakage check on save |
| POST     | /features/backfill                                                  | rebuild point-in-time snapshots         | `predict.feature.manage`                     | long-running job                   |
| GET/POST | /models ; GET /models/:key/versions                                 | registry                                | `predict.model.read                          | manage`                            |                       |
| POST     | /models/:key/train                                                  | launch a training run                   | `predict.model.train`                        | async; returns run id              |
| POST     | /models/:key/versions/:v/promote \| /shadow \| /rollback \| /retire | lifecycle                               | `predict.model.promote` (+ EN-038)           | thresholds + model card enforced   |
| GET      | /models/:key/versions/:v/card ; /metrics ; /fairness ; /shap        | transparency                            | `predict.model.read`                         |                                    |
| POST     | /score                                                              | on-demand scoring for an entity         | `predict.score.request`                      | rate-limited; returns drivers      |
| GET      | /scores?model&entity&band&from&to                                   | score lists (worklists)                 | `predict.score.read` (role-scoped)           | cursor pagination                  |
| POST     | /scores/:id/action                                                  | record the human decision               | `predict.score.act`                          | closes the loop                    |
| GET      | /forecasts?model&dimension&horizon                                  | time-series outputs                     | `predict.forecast.read`                      | beds, staffing, inventory, revenue |
| GET/PUT  | /overbooking-policy                                                 | bounded overbooking configuration       | `predict.overbooking.manage` (2, 24 lead, 5) | approval required                  |
| GET      | /drift?model&from&to ; GET /monitoring                              | drift, calibration, fairness dashboards | `predict.monitor.read`                       |                                    |
| GET      | /explain/:scoreId                                                   | SHAP drivers in plain language          | `predict.score.read`                         | also the DSAR answer               |

## 7. Domain Events (outbox)

- `predict.score.created` (batched) → routing to the owning module's worklist.
- `predict.readmission.high_risk` → IP-002 discharge checklist, PE-002 enrolment task.
- `predict.noshow.flagged` → OP-001 slot board, EN-009 reminder tiering.
- `predict.los.updated` → IP-025 bed board, RC-002 pre-auth extension prompt.
- `predict.bed_demand.forecast_updated` / `predict.staffing.forecast_updated` → IP-025, NC-030.
- `predict.inventory.reorder_suggested` → NC-006 proposal queue (never an auto-PO).
- `predict.revenue.forecast_updated` → NC-009/NC-022, EN-001 dashboard.
- `predict.deterioration.signal` → IP-003/IP-009 rail at **informational** priority only.
- `predict.denial.risk_flagged` → RC-001 claim workbench with the missing-evidence list.
- `predict.model.promoted|demoted|rolled_back|retired` · `predict.drift.detected` · `predict.fairness.gap_detected`
  · `predict.overbooking.auto_suspended` → governance, EN-037, EN-024.
- Consumes: `patient.discharged`, `patient.admitted`, `appointment.booked|cancelled|attended|no_show`,
  `bed.occupied|released`, `vitals.recorded`, `lab.result.verified`, `stock.issued|received`, `claim.submitted`,
  `claim.denied`, `bill.finalized`, `roster.published`.

## 8. Screens (UI)

- **Discharge Risk panel** (IP-002 discharge checklist, desktop): risk band chip with the calibration statement
  ("in this band, ~1 in 4 patients returns within 30 days"), the top modifiable drivers as actionable checkboxes
  (book follow-up, medication counselling, home-care referral), and an Enrol-in-follow-up button creating the PE-002
  pathway. Dismiss requires a reason.
- **No-Show & Overbooking board** (OP-001, desktop): tomorrow's slots with no-show probability chips, reminder tier
  applied, overbooked slots marked, live realised-wait-time guard with an auto-suspend banner when tripped, and a
  per-session cap indicator. Front office can override any individual flag.
- **Bed Demand Command view** (IP-025, desktop + TV 1080p): 72-hour forecast by ward class with confidence bands
  against current census and confirmed discharges, predicted-discharge list ranked with LOS intervals, surge
  thresholds, and "what changed since the last run" annotations.
- **Staffing forecast** (NC-030 planner, desktop): 14-day census/acuity forecast → required nurses by shift and ward
  vs the current roster, gaps highlighted, "generate roster proposal" (which the supervisor edits and approves).
- **Inventory Reorder proposals** (NC-006, desktop): item, forecast demand with interval, lead time, current stock,
  suggested reorder qty, expiry-feasibility flag, ABC/VED class; batch-approve into an NC-005 indent, never an auto-PO.
- **Revenue Forecast** (EN-001 dashboard tile + NC-022, desktop): payer and service-line forecast with intervals,
  variance vs last forecast with driver attribution, AR ageing overlay.
- **Deterioration signal chip** (IP-003/IP-009 patient rail, tablet): displayed **beside** the NEWS2 band, visually
  subordinate, labelled "model-based (complementary)", with the trend drivers and a "record vitals now" action.
  Never colour-competes with the deterministic alert; never blocks; never pages.
- **Claim Denial Risk** (RC-001 workbench, desktop): band, the specific missing documents/coding issues, "fix now"
  deep links, and the historical denial rate for that payer/package for context.
- **Model Registry & Monitoring console** (desktop, data steward/MS/Quality): model list with stage, champion metrics,
  calibration plot, SHAP global importance, fairness slice table with the 5 pp guard, drift (PSI) heatmap, action-rate
  ("is anyone using this?"), promote/rollback/retire controls, model card viewer, and the training-run history.
- **Score explanation drawer** (anywhere a score appears): plain-language drivers, "what would change this",
  model version, calibration statement, and the standing note that this is a suggestion for a human decision.
- Empty/error states: "Not enough local data yet — showing the heuristic baseline", "Features stale (last refresh
  06:00) — prediction hidden", "Model in shadow — not shown to operations".

## 9. Integrations

- **EN-001/NC-011** analytics schema and dataset registry as the only feature source; a feature referencing a
  transactional table is rejected at definition time.
- **IP-025, IP-001, IP-002, OP-001, NC-030, NC-006, NC-005, NC-009, NC-022, RC-001, RC-002, RC-004, PE-002** as
  consumers of scores through their own worklists.
- **EN-037** for routing with per-model priority caps; **EN-018** for the bed-forecast TV board.
- **Training infrastructure**: Python worker container (scikit-learn/XGBoost/LightGBM/statsmodels) invoked by BullMQ,
  artefacts in S3/MinIO with checksums; serving via a lightweight ONNX/native runtime inside `services/ai` so scoring
  needs no Python at request time. Everything runs inside the tenant boundary.
- **AI-002** may cite an AI-005 score in an explanation but never recomputes it; **EN-029** is unaffected by any of it.

## 10. Reports & Analytics

- **Model performance**: AUROC/AUPRC, calibration (reliability curve, ECE, Brier), MAE/MAPE and interval coverage for
  forecasts — split provisional vs matured.
- **Business impact** (the only metrics that justify the module): readmission rate in the intervened cohort vs
  matched control; no-show rate and realised idle-slot minutes before/after; average bed-turnaround time and
  elective-deferral count; nurse overtime hours; stock-out days and expiry write-offs; forecast vs actual revenue
  variance; denial rate for claims where the flag was actioned vs ignored.
- **Adoption & usefulness**: action rate per model, dismiss reasons, alerts per user per day (fatigue guard),
  models with zero actions in 60 days.
- **Fairness**: metric by cohort with the gap and the trend; adverse-impact review status.
- **Governance**: promotions/rollbacks, drift alerts, incidents linked in NC-015, cost of training and scoring.
- Read models: `analytics.mv_predict_performance_daily`, `mv_predict_action_rate`, `mv_predict_fairness_monthly`,
  `mv_predict_business_impact_monthly`.

## 11. Notifications

- Daily digests (not per-score alerts) for readmission, no-show and denial-risk worklists to their owning desks.
- Bed-demand surge threshold crossed → IP-025 + Nursing Superintendent + Admin (EN-037, operational priority).
- Inventory reorder proposals ready → Stores In-charge weekly; stock-out risk within lead time → immediate.
- Deterioration signal → ward tray at informational priority only, subject to a per-ward daily cap.
- Drift/fairness/calibration breach → data steward, MS (clinical models), Governance Committee.
- Overbooking auto-suspended → Front office lead + Admin, with the wait-time evidence.
- Champion promotion/rollback → Governance Committee and the affected role owners.

## 12. Permissions (RBAC keys)

`predict.feature.read|manage` (data steward, 56) · `predict.model.read` (2, 4, 54, 58) · `predict.model.manage|train`
(data steward) · `predict.model.promote` (4 for clinical, 2 for operational, + EN-038) · `predict.score.read`
(role-scoped: 22/IP-025 for beds, 24 for no-show, 28 for denial, 44 for inventory, 46 for revenue, 7/11/17/18 for
deterioration) · `predict.score.request` · `predict.score.act` · `predict.forecast.read` · `predict.overbooking.manage`
(2, 5, 24 lead) · `predict.monitor.read` (2, 4, 54, 57, 58) · plus AI-001 §0.13.

## 13. Non-functional

- **Volumes (2000-bed)**: ~1200 IP patients scored daily (readmission, LOS, deterioration on every vitals event ≈
  35 000 scoring events/day), ~6000 appointments scored daily, ~20 000 inventory item-store pairs weekly, ~800 claims
  scored daily, hourly bed forecasts for ~12 ward classes × 72 horizons.
- **Latency**: online scoring p95 < 150 ms (features from Redis, tree model in-process); on-demand explanation
  < 500 ms; nightly batch for the whole hospital completes within 45 minutes; hourly bed forecast < 3 minutes.
- **Minimum data for training** (cold-start guard): readmission ≥ 5000 discharges with ≥ 250 positive labels;
  no-show ≥ 20 000 appointments; LOS ≥ 5000 admissions; time-series ≥ 24 months of daily history (or 12 with an
  explicit caveat); denial ≥ 2000 claims with ≥ 150 denials. Below these, only heuristics ship.
- **Acceptance thresholds (production gates)**: readmission AUROC ≥ 0.70 and AUPRC ≥ 2× prevalence, calibration ECE
  ≤ 0.05; no-show AUROC ≥ 0.75; LOS MAE ≤ 1.5 days with ≥ 80 % interval coverage; bed demand MAPE ≤ 12 % at 24 h and
  ≤ 20 % at 72 h; inventory demand MAPE ≤ 20 % for A-class items; revenue MAPE ≤ 8 % monthly; deterioration model
  must beat NEWS2's AUROC by ≥ 0.05 **and** show earlier median detection, or it is not deployed at all; denial risk
  AUROC ≥ 0.72. Every model must beat its logistic/naive baseline by a stated margin.
- **Fairness gate**: ≤ 5 pp gap on the primary metric across age band, sex, payer class, branch and urban/rural.
- **Reproducibility**: a training run is reproducible from the run id (data window, feature versions, seed,
  hyperparameters, code commit); artefacts are checksummed.
- **Multi-branch**: models are trained per hospital by default, with an optional group-level model when a branch has
  insufficient data — the branch's local performance must still meet the gate, measured separately (EN-041 scoping).
- **Availability**: scoring failure hides the score; no operational screen breaks. Batch failures alert and retry.
- **Testing**: leakage unit tests per feature, temporal-split integration tests, a backtest harness replaying the last
  12 months, fairness tests in CI, k6 for the scoring endpoint at 100 rps, and a nightly "no future data" assertion.

## 14. Acceptance Criteria

1. **Given** a feature definition that references a fact timestamped after the prediction point, **when** saved,
   **then** the leakage check fails in CI and the definition is rejected.
2. **Given** a clinical model, **when** a feature set including payer class or a protected attribute is proposed,
   **then** training is blocked with an explicit forbidden-feature error.
3. **Given** a trained readmission model, **when** promotion to champion is attempted, **then** it is blocked unless
   AUROC ≥ 0.70, ECE ≤ 0.05, no fairness gap > 5 pp, a signed model card exists, a ≥ 4-week shadow period has run and
   EN-038 approval is recorded.
4. **Given** a patient being discharged with a high readmission band, **when** the discharge checklist renders,
   **then** the band, its calibration statement and the modifiable drivers are shown, enrolment in PE-002 is one
   click, dismissal requires a reason, and **no discharge action is blocked or forced**.
5. **Given** the deterioration model disagrees with NEWS2, **when** both render, **then** the NEWS2 band drives the
   escalation policy, the model signal is displayed beside it as complementary at informational priority, and no
   page or must-acknowledge alert originates from AI-005.
6. **Given** an overbooking policy is active, **when** realised waiting time exceeds the configured guard, **then**
   overbooking auto-suspends, the front office lead and admin are notified with the evidence, and existing bookings
   are untouched.
7. **Given** an inventory reorder proposal, **when** the suggested quantity could not be consumed before the item's
   shelf life, **then** the quantity is capped and the reason is shown; narcotics and Schedule X items never appear
   in proposals.
8. **Given** any score, **when** the explanation is opened, **then** the top-5 SHAP drivers are shown in plain
   language with the modifiable subset highlighted, along with the model version and calibration statement.
9. **Given** a patient exercises a DSAR, **when** the export is produced, **then** it includes the predictions made
   about them, the model versions and the plain-language drivers.
10. **Given** feature freshness exceeds its cadence SLA, **when** a screen requests a score, **then** the score is
    hidden with a "features stale" state rather than shown from stale inputs.
11. **Given** PSI on a top-5 feature exceeds 0.25, **when** the daily monitor runs, **then** `predict.drift.detected`
    is emitted, a retraining review task is created, and the model's dashboard shows the drifting feature.
12. **Given** a fairness gap > 10 pp on a clinical model, **when** detected, **then** the model is automatically
    demoted to shadow and the Governance Committee is notified.
13. **Given** a model has recorded zero human actions in 60 days, **when** the monthly governance pack is generated,
    **then** it is listed as a retirement candidate with its alert volume and dismiss reasons.
14. **Given** a new hospital with 3 months of data, **when** predictive features are enabled, **then** heuristic
    baselines are served with an "insufficient local data" badge and no model is trained.
15. **Given** a champion rollback, **when** executed, **then** the previous champion serves within 30 seconds,
    the change is audited with the justifying metrics, and scores produced under the rolled-back version remain
    identifiable by model version.
16. **Given** any predicted output, **when** audited, **then** the record shows model key/version, feature set
    version, input freshness, the human action taken and the matured outcome once observed.

## 15. Enhancements / Later phases

- **Causal / uplift modelling** for interventions: not "who will be readmitted" but "who benefits from a follow-up
  call" — the correct question, requiring a randomised holdout the hospital must agree to.
- **Real-time surgical scheduling optimisation** (OT utilisation, case-duration prediction feeding IP-006/TR-004).
- **ER arrival forecasting** at hourly granularity with weather, festival and traffic-incident signals (TR-009).
- **Cash-flow and payer-realisation forecasting** with NHCX settlement telemetry (RC-001).
- **Patient-level cost prediction** for RC-008 estimates and package profitability (NC-008).
- **Equipment failure prediction** from EN-042 IoT telemetry feeding NC-020 preventive maintenance.
- **Federated/group learning** across branches without moving PHI, once EN-041 group governance is mature.
- **What-if simulator** in IP-025: "if we defer 8 elective admissions, what happens to Tuesday's ICU demand?"
- **AutoML-assisted feature discovery** with mandatory human review before any feature enters the registry.

## 16. Open Questions for the Hospital

1. How much clean historical data exists per domain (discharges, appointments, claims, stock), and from which date is
   it trustworthy? This single answer determines which models can exist at go-live.
2. What is the hospital's own definition of a **readmission** for its NABH indicator (any admission vs unplanned,
   same branch vs group, which exclusions), so the model's label matches the indicator the committee already tracks?
3. Is overbooking acceptable at all? If yes, what cap per session, which patient classes are excluded, and what
   waiting-time degradation would trigger auto-suspension?
4. Who owns each model operationally (a named role per model) and who acts on its output daily? A model with no owner
   will not be built.
5. Is the medical staff comfortable with a model-based deterioration signal shown beside NEWS2, and who validates it
   locally before it is displayed?
6. May payer class (PMJAY/CGHS/self-pay) be used in financial models, and does the hospital accept the prohibition on
   using it in clinical models?
7. What fairness slices matter most to this hospital's population, and who reviews the adverse-impact analysis?
8. Can model training run on the hospital's own infrastructure, and is a GPU/large-CPU node available for periodic
   retraining?
9. What is the acceptable alert volume per role per day for predictive nudges, and who retires a noisy model?
10. Does the hospital agree that predictions must never be shown to payers, used in denial correspondence, or used to
    set individual doctor revenue targets?
11. For inventory: what are the actual vendor lead times per category, and is the item master clean enough to forecast
    at item-store grain?
12. Will the hospital allow a randomised holdout (a small control group receiving no intervention) so business impact
    can be measured honestly rather than assumed?
