# RC-008 — Patient Cost Estimator & Quotation Engine (Procedure-Based Estimates, Payer-Aware Splits, Co-Pay & Deductible, Room-Class Scenarios, Actual-vs-Estimate Learning, Shareable Quotes, Conversion Tracking)

| Field | Value |
|---|---|
| Domain | Revenue Cycle Management |
| Module ID | RC-008 |
| Phase | 5 |
| Priority | P1 |
| Complexity | Medium-High |
| Depends on | RC-003 (tariff engine — the only source of prices; payer plans, bed-class differentials, package rates), OP-023/IP-008/OP-014 (package definitions and inclusions), EN-002 (payer/plan rules: co-pay, deductible, room-rent cap, non-payables, sum insured), RC-002 (estimate feeds the pre-auth request; approved amount feeds back), RC-007 (scheme beneficiaries → ₹0 patient share), IP-001 (admission advice, deposit, room class eligibility), IP-005 (actual bill for variance learning), OP-005 (OP estimate → bill conversion, advance receipt), IP-002 (final bill vs estimate at discharge), OP-002/OP-010/IP-006 (procedure/surgery advice as the estimate trigger), TR-003/NC-007 (implant price bands), OP-003 (pharmacy estimate basis), NC-008 (cost, for margin view — internal only), EN-039 (estimate/quotation print templates), EN-016 (patient acknowledgement e-sign), EN-009/EN-032 (WhatsApp/SMS/email sharing), EN-010 (pay advance from the quote), PE-001/OP-020 (portal view & acceptance), EN-012 (website "get an estimate" widget), NC-026 (leads/CRM conversion), EN-034 (kiosk), NC-011/EN-001 (analytics), EN-024 (audit) |
| Feature flag | `module.estimator.enabled` (sub: `estimator.public_widget`, `estimator.whatsapp_share`, `estimator.learning`, `estimator.multi_scenario`, `estimator.margin_view`) |
| Primary roles | Billing Executive (27), Front Office / Admission desk (24), Insurance/TPA Desk (28), Call Centre Agent (25) |
| Secondary roles | Doctor / Surgeon (6/7/9 — advises the procedure, reviews clinical assumptions), OT scheduler (IP-006), Marketing/CRM (55 — enquiry conversion), Finance Manager (46 — accuracy and margin oversight), Hospital Admin (2), Patient/Family (59/60), Corporate HR (61 via PE-006), Auditor (58) |
| Regulatory | **NABH 6th edition — AAC (Access, Assessment & Continuity) and PRE/ROM**: the patient must be **informed of the estimated cost of treatment before admission/procedure**, of the tariff, and of any significant deviation during the stay — RC-008 is the system of record for that obligation; **Clinical Establishments (Central Government) Rules 2012 Rule 9** (rates charged as displayed; estimate consistent with the displayed rate card); **Consumer Protection Act 2019** (a materially misleading estimate is a deficiency in service — hence validity, assumptions and disclaimers are structural, not cosmetic); **IRDAI** (cashless estimate accompanies the pre-authorisation request; the patient must know their expected out-of-pocket share); **PMJAY/state schemes** (beneficiary estimate must show ₹0 payable — RC-007); **GST** (estimate must indicate which components are taxable, e.g. room > ₹5,000/day @5 %, medicines/implants at HSN rates, while healthcare services under SAC 9993 are exempt); **DPDP Act 2023 & Rules 2025** (estimates contain health inferences — the diagnosis/procedure — so sharing by WhatsApp/email needs consent and tokenised, expiring links); **TRAI DLT** (templated service messages) |

## 1. Purpose
RC-008 tells a patient, before they commit, what their treatment will cost and how much of it they will personally pay. It builds an estimate from the tariff engine for a procedure, package or admission scenario, applies the payer's rules (package vs itemised, co-pay, deductible, room-rent cap and proportionate deduction, non-payables, sum-insured balance, scheme zero-cash), presents alternative **room-class scenarios** side by side, prints or shares a validity-dated quotation the patient can act on, converts into a pre-auth (RC-002), an admission advice (IP-001) or a bill (OP-005), and then measures itself: every estimate is compared against the final bill so the next estimate is better. It is simultaneously a sales tool, a patient-rights obligation and the input that makes pre-authorisation credible.

## 2. Users & Jobs-to-be-done
- **Billing / admission-desk executive** (desktop, 3–5 minutes per estimate): produce a defensible estimate for a planned surgery or admission, explain the patient's share line by line, print and hand it over, take the acknowledgement, collect the advance.
- **Front office / call centre**: answer "how much will a knee replacement cost?" on the phone or at the counter in under two minutes, with a shareable quotation sent to WhatsApp.
- **Insurance desk**: generate the payer-aware estimate that goes into the pre-auth request, and later explain to the family why their share is what it is.
- **Surgeon / doctor**: confirm the clinical assumptions (LOS, ICU days, implant type, likely complications) that drive the number; be warned when the actual is drifting away from the estimate.
- **Patient / family**: understand the total, what insurance will cover, what they will pay, what is excluded, and how long the quote is valid; accept it digitally and pay an advance.
- **Marketing/CRM**: track quotations issued vs converted, by procedure and by source — the estimator is the top of the surgical funnel.
- **Finance**: estimate accuracy (the variance that erodes trust and causes discharge-day arguments) and, internally only, the margin implied by an estimate.

## 3. Core Workflows

### 3.1 Estimate creation
1. **Trigger**: doctor advises a procedure/admission (`ip.admission.advised`, `ot.booking.created`, `op.procedure.advised`), the front desk answers an enquiry, a lead arrives from the website widget (`estimator.public_widget`) or call centre (NC-026), a payer pre-auth needs a cost basis (RC-002), or a corporate/patient asks for a quotation.
2. **Basis selection**: (a) **package** — an OP-023/IP-008/OP-014/RC-007 package with its inclusion list and rate for the payer and bed class (the most accurate basis); (b) **procedure template** — a curated bundle of expected services with default quantities per procedure (e.g. *total knee replacement*: pre-op investigations, OT charges, anaesthesia, implant band, room × 4 days, physiotherapy × 6, pharmacy allowance, surgeon and anaesthetist fees); (c) **itemised build** — the executive picks services and quantities directly; (d) **historical** — derived from the median actual bill of the last N similar cases (same procedure, payer type, bed class), shown as a cross-check against (a)–(c).
3. **Assumptions panel** (explicit and printed, because these are the reasons an estimate later changes): expected LOS, ICU/HDU days, bed class, implant type/brand band, anaesthesia type, expected complications excluded, blood units, and whether pre-/post-hospitalisation is included.
4. Every line is priced by **RC-003** at the encounter's payer context and the chosen bed class, with GST treatment per line (exempt SAC 9993 services vs taxable room > ₹5,000/day, medicines/implants at HSN rates). No price is ever typed in free-hand; a service without a rate blocks the estimate and raises `tariff.rate.missing`.

### 3.2 Payer-aware split
1. **Self-pay**: total = sum of lines + tax − applicable concession plan (RC-003 rate plan, not an ad-hoc discount); patient pays 100 %.
2. **Insurance/TPA**: apply the plan's rules from EN-002 — room-rent cap (with the **proportionate deduction** simulation when the chosen class exceeds entitlement, shown as a distinct line because this is the single biggest surprise at discharge), co-pay %, deductible, sub-limits per head, standard **non-payable items** (IRDAI list: gloves, syringes if listed, admission kit, attendant charges, documentation charges), exclusions and waiting-period flags, and the sum-insured balance → produces **expected payer share** and **expected patient share**, with each patient-share rupee attributed to a reason (co-pay / non-payable / above-approval / proportionate deduction / exclusion).
3. **Corporate**: corporate plan rate and covered-service list (NC-012), employee eligibility limit, balance payable by the employee.
4. **Scheme (RC-007)**: patient share is **₹0** for covered packages; the estimate prints "Cashless under <scheme> — you should not pay anything", with the helpline. Non-covered add-ons appear only if a scheme-permitted override exists.
5. **Multi-payer**: primary/secondary order of benefits applied; the estimate shows each payer's expected share.

### 3.3 Room-class scenarios (`estimator.multi_scenario`)
- The estimator generates up to four side-by-side scenarios (e.g. General / Semi-private / Private / Deluxe), each recomputing not only the room rent but every bed-class-differential service (RC-003 §3.1.3) and, for insured patients, the proportionate-deduction consequence of exceeding entitlement. The family sees "Private room costs ₹22,000 more in room rent, but because your policy entitles you to semi-private, your out-of-pocket rises by ₹61,000" — which is the conversation that prevents a discharge-day dispute. Scenarios can also vary LOS (best case / expected / with one complication) as a **range**, which is more honest than a single number.

### 3.4 Quotation issue, sharing and acceptance
1. The estimate is issued as a **quotation** with: quotation number (series `QUOTE`), date, **validity** (default 30 days, configurable; tariff revisions after issue do not bind the hospital beyond validity), patient and procedure, itemised or grouped breakdown (configurable — grouped by head is friendlier), the assumptions list, inclusions and **exclusions in plain language**, payer split, expected patient share, advance payable, GST notes, the standard disclaimer ("this is an estimate based on the stated assumptions; the final bill may vary with clinical course; you will be informed of significant deviations"), hospital contact and the grievance route.
2. Delivery: print (A4/A5, EN-039 template, hospital letterhead, QR to the online copy), **WhatsApp/SMS** (`estimator.whatsapp_share` — tokenised, expiring, PHI-minimal link; DLT/WhatsApp-approved template; consent recorded), email (EN-032, PDF), patient portal (PE-001/OP-020), kiosk print (EN-034).
3. **Acceptance**: the patient may accept on the portal or sign at the desk (EN-016 or wet signature scanned) — the acknowledgement is stored because NABH asks for evidence that the patient was informed of the estimated cost. Acceptance can carry straight into an **advance payment** (EN-010 link/UPI) and an admission booking (IP-001).
4. **Revision**: any change creates a new version with a diff (what changed and why); the superseded version is retained. Sent versions are immutable.

### 3.5 Conversion and downstream linkage
- `estimate → pre-auth` (RC-002 uses the estimate as the requested amount, with the itemised basis attached to the payer form), `estimate → admission advice` (IP-001 pre-fills class, expected LOS and deposit), `estimate → bill` (OP-005 converts an OP quotation into a bill/advance receipt), `estimate → package booking` (OP-023/OP-014).
- **Conversion tracking**: each quotation records outcome enum(converted_admission/converted_op_bill/converted_package/expired/declined/lost_to_competitor/no_response) with a reason and a follow-up task (NC-026/PE-002), giving the hospital a real surgical funnel: enquiries → quotations → conversions by procedure, doctor, source and value band.

### 3.6 Actual-vs-estimate learning (`estimator.learning`)
1. On `bill.finalized`/`ip.bill.finalized` for an encounter linked to an estimate, the system computes the **variance**: total, and per head (room, OT, implants, pharmacy, investigations, professional fees), plus the driver breakdown (LOS longer than assumed, ICU used, complication, implant upgrade, extra investigations, tariff revision between quote and admission).
2. Aggregated by procedure/package/payer/bed class, this produces: median and P25–P75 actual cost, the historical basis for option (d) in §3.1, and **suggested template adjustments** ("TKR estimates under-state pharmacy by 18 % on average; LOS assumption 4 days, actual median 5") which a human reviews and applies to the procedure template. Templates carry a version and an accuracy score.
3. A **live drift alert** during the stay: when the running IP bill exceeds the estimate by a configured threshold (default 15 %), the ward/desk is prompted to counsel the family and record the conversation (NABH requires informing the patient of significant deviations) — and, if insured, RC-002 raises an enhancement.

### 3.7 Public and pre-arrival estimates (`estimator.public_widget`)
- A website/portal widget (EN-012/PE-001) offers indicative estimates for a curated list of common procedures and health-check packages: the patient picks the procedure, room class and payer type, and receives a **range** (P25–P75 of recent actuals, or the package rate) with a clear "indicative — a formal estimate requires consultation" note, and an option to request a formal quotation (becomes a CRM lead). This is a marketing asset and, done honestly, a trust asset; the ranges come from real data, not marketing.

### 3.8 Exceptions
- **No tariff** for a required service → the estimate cannot be issued; the missing rate is raised to RC-003's worklist and the desk is told which service is unpriced (never a silent zero).
- Tariff revision between quotation and admission → the quotation honours the rate at issue **within validity**; outside validity the estimate is re-generated. This rule is printed on the quotation.
- Emergency admissions: no estimate precedes care; a **retrospective indicative estimate** is provided within 24 h once the plan is known (NABH still expects the family to be informed).
- Scheme beneficiaries: the estimator never shows a patient payable for covered packages.
- Offline: quotations can be viewed from cache; issuing requires connectivity (rates and payer rules must be current).

## 4. Data Model (schema `billing`, prefix `estimate_`)
- **estimates** — id, hospital_id, branch_id, quotation_no (series `QUOTE/{BR}/{FY}/{SEQ:6}`), version int, parent_estimate_id?, patient_id?, lead_id? (NC-026, for non-registered enquiries), encounter_id?, admission_id?, requested_by, requesting_doctor_id?, basis enum(package/procedure_template/itemised/historical), package_id?, template_id?, procedure_codes text[], diagnosis_codes text[], payer_context jsonb (payer_type, payer_id, plan_id, policy_id, scheme_id, corporate_id), bed_class_id, scenario_group_id?, assumptions jsonb (los_days, icu_days, implant_band, anaesthesia_type, blood_units, complications_excluded[]), gross_amount, discount_amount, taxable_amount, tax_amount, total_amount, payer_share, patient_share, patient_share_breakup jsonb (copay/deductible/non_payable/proportionate_deduction/exclusion/above_limit), advance_payable, currency, validity_from date, validity_till date, status enum(draft/issued/sent/viewed/accepted/converted/expired/superseded/declined/cancelled), issued_at, issued_by, accepted_at, acceptance_ref (e-sign/signature file), outcome enum(converted_admission/converted_op_bill/converted_package/expired/declined/lost/no_response)?, outcome_reason, outcome_at, pdf_file_id, share_token_hash?, tariff_version_ids uuid[], margin_estimate?, audit cols, version_lock. Indexes (hospital_id, status, issued_at desc), (patient_id), (lead_id), (quotation_no) UNIQUE, (encounter_id).
- **estimate_lines** — id, estimate_id, group enum(room/nursing/ot/anaesthesia/professional_fees/investigations/imaging/pharmacy/consumables/implants/blood/therapy/diet/other), service_id?, package_component bool, description, qty numeric(10,2), unit_rate, gross, discount, taxable_value, gst_rate, tax_amount, net, hsn_sac, is_exempt, payer_covered bool, payer_share, patient_share, patient_share_reason enum(copay/deductible/non_payable/proportionate/exclusion/above_limit/self_pay)?, tariff_item_id, tariff_version_id, source enum(package/template/manual/historical), notes.
- **estimate_scenarios** — scenario_group_id, estimate_id, label (e.g. "Semi-private, 4 days"), bed_class_id, los_days, total_amount, patient_share, is_recommended bool, comparison_note (auto-generated: "₹61,000 more out-of-pocket due to proportionate deduction").
- **estimate_templates** — id, hospital_id, code, name, procedure_codes text[], specialty, default_bed_class_id, default_los_days, default_icu_days, lines jsonb (service_id, default_qty, group, optional bool), implant_band?, version, accuracy_score numeric(5,2)?, last_tuned_at, tuned_from_run_id?, author, approval_id, active, effective range.
- **estimate_variances** — estimate_id, encounter_id, bill_id, final_total, final_patient_share, variance_amount, variance_pct, head_variances jsonb (room/ot/implant/pharmacy/…), drivers jsonb (los_delta, icu_used, complication, implant_upgrade, extra_investigations, tariff_revision), computed_at.
- **estimate_benchmarks** (learning read model) — procedure_code/package_id, payer_type, bed_class_id, period, n_cases, median_total, p25, p75, median_los, median_patient_share, updated_at (feeds §3.1(d) and the public widget ranges).
- **estimate_shares** — estimate_id, channel enum(whatsapp/sms/email/portal/print/kiosk), sent_at, sent_by, recipient_masked, message_id, token_hash, token_expires_at, viewed_at, view_count, consent_ref (EN-028).
- **estimate_counselling** (NABH evidence) — encounter_id, estimate_id?, at, by, reason enum(pre_admission/deviation_15pct/room_upgrade/pre_auth_denied/package_excess), discussed_points, family_member, acknowledgement_file_id?, signature_ref?.
- **estimate_public_requests** (`estimator.public_widget`) — id, hospital_id, source enum(website/portal/kiosk/ivr), procedure_code, bed_class, payer_type, contact_masked, range_shown jsonb, converted_to_estimate_id?, lead_id (NC-026), at.
- RLS on `hospital_id`. Estimates for registered patients are PHI (they reveal a diagnosis/procedure) with read audit; public-widget requests hold no clinical identity beyond the procedure interest. Retention: 8 years with the encounter; anonymous widget requests 180 days.

## 5. Business Rules & Validations
- **Every price comes from RC-003.** Manual rate entry is not permitted anywhere in this module; a service without an effective rate blocks issuance and raises the missing-rate exception.
- An issued quotation is **immutable**; changes create a new version with a diff; the version sent to the patient is the version stored as PDF with a checksum.
- **Validity** is mandatory (default 30 days, max configurable): within validity the quoted rates are honoured even if the tariff changes; outside validity the quotation is `expired` and must be regenerated. This rule is printed on every quotation.
- Patient share must reconcile: `total = payer_share + patient_share`, and every rupee of patient share carries a reason code — a quotation with an unexplained patient share cannot be issued.
- **Scheme beneficiaries**: `patient_share = 0` is enforced; any non-zero patient share requires an RC-007 override reference; the cashless-rights text is printed.
- **Proportionate deduction** must be shown as an explicit line whenever the chosen bed class exceeds the policy entitlement, with the calculation displayed — hiding it is the most common cause of discharge-day conflict and consumer complaints.
- GST treatment per line follows the HSN/SAC on the tariff item (healthcare services exempt under SAC 9993; room > ₹5,000/day taxable at 5 % excluding ICU/CCU/ICCU/NICU; medicines/implants at HSN rates) — totals must show taxable and exempt values separately.
- The estimate is a **range-aware** document: where the template defines optional lines or LOS variability, the print shows expected and, optionally, a "with one complication" upper figure; a single false-precision number is discouraged by design.
- Sharing by WhatsApp/SMS/email requires a recorded communication consent; links are tokenised, expiring (default 14 days) and PHI-minimal (no diagnosis in the message body, only in the opened document).
- Deviation counselling: when the running bill exceeds the estimate by the configured threshold, a counselling task is created and must be closed with a record before final billing (NABH evidence); the record is required, the outcome is not dictated.
- `estimator.margin_view` (estimate vs cost from NC-008) is **internal only** — never printed, never shared, and permission-gated to Finance/Admin.
- Advance/deposit suggested by the estimate follows the hospital's deposit policy (IP-001) and never exceeds the expected patient share for insured patients.
- Conversion outcomes must be recorded within the configured window (default 45 days after validity) — an estimator with no outcome data cannot learn.
- Segregation: the executive who issues an estimate cannot approve a special concession within it; concessions are rate plans (RC-003) or approved discounts (OP-005), not estimator edits.

## 6. API Surface (`/api/v1/estimates`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /estimates?status=&patient=&doctor=&procedure=&from= | list | estimate.list | – | cursor |
| POST | /estimates | create draft (basis, payer context, assumptions) | estimate.create | Y | – |
| GET/PATCH | /estimates/{id} | detail / edit draft | estimate.read/update | Y | – |
| PUT | /estimates/{id}/lines | edit lines & quantities (repriced server-side) | estimate.update | Y | – |
| POST | /estimates/{id}/scenarios | generate room-class / LOS scenarios | estimate.update | Y | – |
| POST | /estimates/{id}/recalculate | re-price against current tariff & payer rules | estimate.update | Y | – |
| POST | /estimates/{id}/issue | issue with validity (locks version, renders PDF) | estimate.issue | Y | – |
| POST | /estimates/{id}/share | WhatsApp/SMS/email/portal share | estimate.share | Y | – |
| GET | /estimates/{id}/pdf | download/print | estimate.read | – | – |
| POST | /estimates/{id}/accept | patient acceptance (desk or portal) | estimate.accept / patient self | Y | – |
| POST | /estimates/{id}/revise | create next version | estimate.create | Y | – |
| POST | /estimates/{id}/outcome | record conversion/decline reason | estimate.outcome.record | Y | – |
| POST | /estimates/{id}/convert?target=preauth\|admission\|bill\|package | downstream conversion | estimate.convert | Y | – |
| POST | /estimates/batch-quote | quick quote for a lead (no patient record) | estimate.create | Y | – |
| GET | /templates ; POST/PATCH /templates/{id} | procedure templates | estimate.template.read / .configure | Y | cursor |
| POST | /templates/{id}/tune | apply learning suggestions (approval) | estimate.template.configure | Y | – |
| GET | /benchmarks?procedure=&payerType=&bedClass= | historical median/P25–P75 | estimate.benchmark.read | – | – |
| GET | /variances?procedure=&period= | actual-vs-estimate analysis | estimate.report.read | – | cursor |
| GET | /reports/accuracy ; /reports/conversion | KPIs | estimate.report.read | – | – |
| POST | /counselling | record deviation/pre-admission counselling | estimate.counselling.record | Y | – |
| GET | /public/quote?procedure=&bedClass=&payerType= | indicative range (widget) | public (rate-limited) | – | – |
| POST | /public/request-formal | request a formal quotation → CRM lead | public (rate-limited, captcha) | Y | – |
| GET | /share/{token} | tokenised patient view | public (token) | – | – |

## 7. Domain Events (outbox)
- `estimate.created|updated`, `estimate.issued` {quotation_no, total, patient_share, validity} → PE-001, NC-026 (funnel), analytics.
- `estimate.shared` {channel, recipient_masked} → EN-009/EN-032 delivery tracking, consent log.
- `estimate.viewed` {token, at} → conversion analytics, follow-up trigger (a viewed-but-not-accepted quote is a hot lead).
- `estimate.accepted` {by, at, acceptance_ref} → IP-001 (booking), EN-010 (advance link), RC-002.
- `estimate.converted` {target, ref_id} / `estimate.declined|expired` {reason} → NC-026, PE-002 follow-up.
- `estimate.variance.computed` {estimate_id, variance_pct, drivers} → template tuning queue, finance dashboard.
- `estimate.deviation.threshold_crossed` {encounter_id, estimate, running_total, pct} → **ward/desk counselling task**, RC-002 enhancement, family notification.
- `estimate.rate.missing` {service_id} → RC-003 worklist (mirrors `tariff.rate.missing`).
- `estimate.counselling.recorded` → NABH evidence store, IP-002 discharge checklist.
- Consumes: `ip.admission.advised`, `ot.booking.created`, `op.procedure.advised`, `preauth.approved` (approved amount vs estimate), `bill.finalized` / `ip.bill.finalized` (variance), `tariff.version.published` (re-base drafts), `insurance.policy.verified` (payer rules), `scheme.case.created` (₹0 patient share), `crm.lead.created` (quote request).

## 8. Screens
- **Estimate Builder** (desktop, 3-pane): left = patient/lead, payer context (payer, plan, policy with sum-insured balance, entitlement class) and assumptions (LOS, ICU days, implant band, anaesthesia — each a control that instantly re-prices); centre = line grid grouped by head with quantities, rates, GST and the payer/patient split per line, plus an "add service" search; right = **live totals card** (gross, tax, total, payer share, patient share with the reason breakdown, advance payable) and the scenario switcher. Shortcuts: `F2` new estimate, `F4` change payer, `F6` scenarios, `F7` recalculate, `F9` issue, `Ctrl+P` print, `Ctrl+S` save draft, `/` service search. Real-time: any tariff change during editing shows a "rates updated — recalculate" banner rather than silently changing numbers.
- **Scenario Comparison** (desktop/tablet, also print-friendly): up to four columns (General / Semi-private / Private / Deluxe or LOS variants) with total, patient share, and an auto-written plain-language note per column ("Your policy entitles you to semi-private; choosing private adds ₹61,000 to your share because of proportionate deduction"). This screen is shown *to the family*, so typography and language matter.
- **Quick Quote** (front office / call centre, single screen, < 60 s): procedure search → payer type → room class → instant range and formal-estimate button; capture name and mobile → WhatsApp the quotation and create a CRM lead.
- **Quotation Preview & Share**: rendered PDF preview (grouped or itemised toggle), validity, assumptions and exclusions in plain language, share panel (WhatsApp/SMS/email/portal/print) with consent checkbox, acceptance status.
- **Patient view** (phone, portal/tokenised link, PE-001/OP-020): friendly breakdown ("Hospital room & nursing ₹48,000 · Surgery & OT ₹1,15,000 · Implant ₹85,000 · Medicines & consumables ₹32,000"), "what your insurance is expected to pay", "what you are expected to pay and why", validity countdown, Accept, Pay advance, Ask a question (routes to the desk), Download PDF. Multilingual, large type, no jargon.
- **Estimate vs Actual** (desktop, finance/quality): per estimate — estimated vs final by head with driver chips; aggregate — accuracy distribution by procedure/doctor/payer, median absolute percentage error, over- vs under-estimation bias, top drivers of variance; template tuning suggestions with an Apply (approval-gated) control.
- **Conversion funnel** (desktop, marketing/admin): enquiries → quotations issued → viewed → accepted → converted, by procedure, doctor, source, value band and branch, with average time-to-decision and loss reasons.
- **Template Admin** (desktop): procedure templates with default lines and quantities, accuracy score, version history, tuning history; clone-and-edit for a new procedure.
- **Deviation counselling card** (ward tablet / desk): "Running bill ₹2,18,000 vs estimate ₹1,80,000 (+21 %) — reasons: 2 extra ICU days, implant upgrade. Counsel the family and record." with a short structured form and an optional signature.
- Public **estimate widget** (website/kiosk, EN-012/EN-034): procedure picker → indicative range with an honest disclaimer → request a formal estimate.
- All screens WCAG 2.2 AA, keyboard-first at the desk, multilingual patient-facing content, `en-IN` currency formatting.

## 9. Integrations
- **RC-003** (the only price source; batch resolve for speed), **EN-002** (payer plan rules, sum insured, non-payables), **RC-007** (scheme zero-cash), **RC-002** (estimate → pre-auth requested amount; approved amount back), **IP-001/IP-005/OP-005** (admission advice, deposit, conversion to bill, final bill for variance), **OP-023/IP-008/OP-014** (packages), **TR-003/NC-007** (implant price bands), **EN-039** (quotation templates and letterheads), **EN-016** (acceptance e-sign), **EN-009/EN-032** (share channels with DLT templates), **EN-010** (advance payment link from the quote), **PE-001/OP-020** (patient view and acceptance), **EN-012/EN-034** (website widget, kiosk), **NC-026** (leads and conversion attribution), **NC-008** (cost, for the internal margin view only), **EN-001/NC-011** (analytics).
- Fallbacks: tariff service unavailable → estimate cannot be issued (never guess); WhatsApp API failure → SMS fallback then print; PDF worker delay → HTML preview with a queued PDF.

## 10. Reports & Analytics
- **Accuracy**: median absolute percentage error by procedure/package/payer/bed class; bias (systematic under- or over-estimation) — under-estimation is the one that causes complaints; variance drivers ranked; accuracy trend after each template tuning.
- **Conversion**: quotations issued, viewed, accepted, converted; conversion rate and average time-to-decision by procedure, doctor, payer type, source (walk-in/phone/website/camp/referral) and value band; loss reasons; revenue attributable to the estimator funnel.
- **Patient share**: average expected vs actual patient share; frequency of proportionate-deduction exposure; cases where the actual patient share exceeded the estimate by > 20 % (the complaint predictor).
- **Compliance (NABH)**: percentage of planned admissions with an estimate issued before admission; percentage with recorded acknowledgement; deviation counselling completion rate.
- **Operational**: estimates per executive per day, time to produce, missing-rate incidents blocking estimates.
- **Internal margin** (`estimator.margin_view`, restricted): estimated contribution by procedure and payer plan.
- Read models: `analytics.mv_estimate_accuracy`, `mv_estimate_conversion`, `mv_estimate_benchmarks` (feeds the historical basis and the public widget), `mv_estimate_compliance`.

## 11. Notifications
- **Patient/family** (EN-009/EN-032, DLT service templates, consent-gated): quotation ready with a secure link, validity expiring in 3 days, "your estimate has been revised", acceptance confirmation with the advance link, deviation notice ("your bill has crossed the estimate — please speak to the billing desk").
- **Desk/executive**: quotation viewed but not accepted after 48 h (follow-up), validity expiring, missing rate blocking an estimate, conversion outcome due for recording.
- **Doctor**: estimate issued for your patient (with the assumptions you should confirm), running bill deviating > threshold on your patient.
- **Finance/Quality**: weekly accuracy and conversion digest; monthly NABH compliance (estimates issued before admission %); templates due for tuning.
- **Marketing (NC-026)**: new public estimate request/lead; funnel weekly summary.

## 12. Permissions (RBAC keys)
`estimate.list|read|create|update` (Billing executive, Front office, Insurance desk, Call centre) · `estimate.issue` (Billing executive, Insurance desk, Admission desk) · `estimate.share` (same; consent-gated) · `estimate.accept` (Desk on behalf with signature; patient self via PE-001) · `estimate.convert` (Billing, Admission desk, Insurance desk) · `estimate.outcome.record` (Desk, CRM) · `estimate.template.read` (all estimating roles) / `estimate.template.configure` (Billing manager + Finance approval via EN-038) · `estimate.benchmark.read` (Desk, Finance, Marketing) · `estimate.counselling.record` (Billing, Nurse, Doctor) · `estimate.report.read` (Finance, Admin, Quality, Marketing, HOD for own department) · `estimate.margin.read` (Finance Manager, Hospital Admin **only**; gated by `estimator.margin_view`) · public widget endpoints are unauthenticated but rate-limited, captcha-protected and return ranges only.

## 13. Non-functional
- **Volumes** (2000 beds): 60–120 estimates/day (planned admissions, surgeries, health checks, enquiries), 150 discharges/day generating variance records, 500+ public widget requests/day if the website widget is live; ~30 procedure templates at launch growing to 150.
- **Performance**: estimate build with 60 lines < 400 ms (batch rate resolution against RC-003, single round trip); scenario generation for 4 classes < 800 ms; PDF render < 3 s; quick quote < 1 s; public widget response < 300 ms (served from `mv_estimate_benchmarks`, cached, never live-priced).
- **Accuracy target**: median absolute percentage error ≤ 10 % for packaged procedures and ≤ 20 % for itemised admissions within 6 months of go-live, tracked on the dashboard as a product KPI.
- **Offline**: issued quotations are viewable from the PWA cache; issuing requires connectivity because rates and payer rules must be current.
- **Printing**: A4/A5 quotation on hospital letterhead with QR to the online copy; a one-page "your share" summary in the local language for the family; scenario comparison print.
- **Accessibility/i18n**: patient-facing content in the patient's language (en-IN, hi, ta, te, ml, kn, mr, bn), plain wording, ≥ 14 pt equivalent print, WCAG 2.2 AA; amounts in `en-IN` lakh/crore formatting.
- **Security/privacy**: the quotation reveals a diagnosis/procedure — share links are tokenised, expiring and PHI-minimal in the message body; consent recorded per share; the internal margin view is permission-gated and never rendered into any patient artefact; every issued PDF stores a checksum so "this is not what you gave me" is answerable.

## 14. Acceptance Criteria
1. Given a total knee replacement advised for a self-pay patient in a private room, when an estimate is built from the procedure template, then every line is priced from RC-003 at the private-room rate, GST is applied only to taxable lines, and the totals reconcile to the printed quotation to the paisa.
2. Given a service with no effective tariff, when building an estimate, then issuance is blocked, the unpriced service is named, and `tariff.rate.missing` is raised to RC-003's worklist.
3. Given an insured patient whose policy entitles them to a semi-private room but who chooses private, then a proportionate-deduction line appears explicitly with its calculation, and the scenario comparison shows the out-of-pocket difference in plain language.
4. Given a policy with 10 % co-pay, a ₹10,000 deductible and a non-payables list, then the patient share equals the sum of those components plus any amount above the sum insured, every rupee carries a reason code, and `total = payer_share + patient_share`.
5. Given a verified PMJAY beneficiary, then the estimate shows ₹0 patient share, prints the cashless-rights text and helpline, and any attempt to add a patient-payable line without an RC-007 override is rejected.
6. Given a quotation is issued with 30 days' validity and the tariff is revised on day 10, then a patient admitted on day 20 is billed at the quoted rates, and a patient admitted on day 40 receives a regenerated estimate.
7. Given an issued quotation, when anyone edits it, then a new version is created with a diff, and the sent PDF of the prior version remains retrievable with a matching checksum.
8. Given the patient consents and the quotation is shared by WhatsApp, then the message contains no diagnosis, the link is tokenised and expires after the configured period, the share and consent are logged, and opening it records a `viewed` event.
9. Given a patient accepts on the portal, then acceptance is recorded with a timestamp and reference, an advance payment link is offered, and the admission desk sees the accepted estimate on the booking screen.
10. Given the estimate is converted to a pre-auth, then RC-002's requested amount equals the estimate total (payer share basis) and the itemised basis is attached to the payer form.
11. Given the final bill is ₹2,18,000 against an estimate of ₹1,80,000, then a variance record is computed with per-head differences and drivers, and the case appears in the accuracy report.
12. Given the running IP bill crosses the estimate by more than 15 %, then a counselling task is created for the ward/desk, the family notification is sent, and the counselling record must be completed before final billing.
13. Given 40 completed TKR cases, then the benchmark read model reports median, P25 and P75 totals and median LOS, the template tuning suggestion is generated, and applying it requires approval and creates a new template version.
14. Given a public widget request for "cataract surgery, semi-private, self-pay", then an indicative range from real recent actuals is returned in < 300 ms with a clear disclaimer, no patient identity is stored, and requesting a formal estimate creates a CRM lead.
15. Given a user without `estimate.margin.read`, then no cost or margin figure is visible anywhere in the UI or API responses, and the printed quotation never contains one.
16. Given a planned admission proceeds without any estimate issued, then it appears in the NABH compliance report as a gap.
17. Given 120 estimates/day and 60-line estimates, then build p95 < 400 ms and the batch rate resolution makes a single call to RC-003.
18. Given a quotation is declined, then the outcome and reason are recorded and the conversion funnel updates within 5 minutes.

## 15. Enhancements / Later phases
- Origin: architect-added (M), aligned with EN-002's enhancement "patient cost estimator pre-admission" and MocDoc's "Cost Estimation for Treatment"; SmartHospital ships a basic **Quotation Engine** (subtotal → discount → GST, email quote with branding, convert to invoice) — RC-008 supersedes it with payer awareness, scenarios and learning.
- Later: **predictive cost estimation** (AI-005) using patient factors (age, comorbidities, ASA grade, prior LOS) rather than procedure averages, with prediction intervals; automatic assumption capture from the surgical booking and the anaesthetist's PAC; **what-if** counselling tool for the family (ICU day cost, extra day cost) during the stay; financial-counselling workflow at admission with plan/EMI offers (RC-005 §3.5) so the patient's ability to pay is addressed before, not after, treatment; price-transparency machine-readable file for global deployments; competitive positioning view for marketing (our range vs the city median, from published sources only); voice/IVR estimate for callers (EN-033); estimate accuracy as a published quality indicator (NC-015); multi-currency estimates for international patients with an FX disclaimer.

## 16. Open Questions for the Hospital
1. Which procedures need estimate templates first (top 20 by volume and by value), and who will curate them — billing, the surgeon, or both?
2. What is your standard quotation validity (30 days?), and do you honour quoted rates after a tariff revision within validity?
3. Should quotations be itemised or grouped by head for patients? Do you want an "expected" plus "with one complication" range, or a single figure?
4. Do you take a signed acknowledgement of the estimate today (NABH evidence)? Paper or digital?
5. Deposit policy: how is the advance derived from the estimate, and does it differ for insured, corporate and scheme patients?
6. At what deviation percentage must the family be counselled, and who does it — billing, ward nurse or the treating doctor?
7. Do you want a public "get an estimate" widget on the website, and for which procedures? Are you comfortable publishing ranges from your own historical data?
8. Should the estimator show room-class scenarios by default (recommended) and, for insured patients, the proportionate-deduction consequence explicitly?
9. Who may see the internal margin implied by an estimate — Finance only, or also department heads?
10. What accuracy target should we hold the estimator to, and who reviews template tuning suggestions?
11. Do you want quotations shared by WhatsApp, and has the DLT/WhatsApp template been approved? What consent do you capture for it?
12. How do you currently record why a quoted patient did not come (lost reason), and who follows up?
