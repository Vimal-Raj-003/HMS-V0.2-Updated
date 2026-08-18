# RC-004 — Denial Management (Reason Taxonomy, Appeal Workflow with Deadlines, Root-Cause Analytics, Preventive Rules, Recovery KPIs, IRDAI Grievance Escalation)

| Field | Value |
|---|---|
| Domain | Revenue Cycle Management |
| Module ID | RC-004 |
| Phase | 5 (taxonomy, capture, appeals) → 11 (root-cause analytics, preventive rule automation) |
| Priority | P1 |
| Complexity | Medium-High |
| Depends on | RC-001 (claims — denial/short-payment events, resubmission, claim lines), RC-002 (pre-auth denials and query history), EN-002 (payer master, settlement disputes, payer wording map), RC-003 (tariff mismatch denials trace back to rate mapping), RC-005 (AR — denied balances stay in AR until recovered or written off), RC-006 (documentation/charge-capture defects that cause denials), RC-007 (scheme denials: PMJAY/NHA audit deductions, CGHS objections), NC-003 (MRD coding quality), IP-002 (discharge summary quality), OP-002 (clinical documentation), NC-034 (doctor-wise denial attribution — reporting only, never punitive automation), EN-038 (appeal & write-off approvals), EN-039 (appeal letter templates), EN-016 (doctor certificate e-sign), EN-037 (deadline alerts), EN-032/EN-009 (payer correspondence), NC-009 (write-off & recovery journals), EN-001/NC-011 (analytics), NC-015 (quality/CAPA — denials as a quality indicator), EN-024 (audit) |
| Feature flag | `module.denial.enabled` (sub: `denial.preventive_rules`, `denial.ombudsman_tracking`, `denial.auto_reason_mapping`, `denial.doctor_scorecards`) |
| Primary roles | Insurance / TPA Desk (28), Claims Executive, Denial Analyst (28 family) |
| Secondary roles | MRD Coder (43), Treating Doctor (6/7/9 — medical justification for appeals), Billing Executive (27), Finance Manager (46 — recovery & write-off), Quality Manager (54 — CAPA), Hospital Admin (2), Medical Superintendent (4 — clinical documentation governance), Auditor (58) |
| Regulatory | **IRDAI Master Circular on Health Insurance 2024** (reasons for repudiation must be communicated in writing; grievance redressal: insurer's **Grievance Redressal Officer** → response within 15 days → **Insurance Ombudsman** (Insurance Ombudsman Rules 2017, complaint within 1 year of the insurer's rejection, monetary limit ₹50 lakh) → **Bima Bharosa** (IRDAI's grievance portal)); **IRDAI standard exclusions & standard non-payable items list** (the legitimate basis for many deductions); **IRDAI Health Insurance Regulations 2016** (pre-existing disease and waiting-period definitions); **PMJAY/NHA** claim audit and deduction rules with the state's grievance and appeal mechanism (District/State Grievance Redressal Committee); **CGHS/ECHS** objection and re-submission rules; **Consumer Protection Act 2019** (patient-facing implications where the hospital recovers from the patient); DPDP (denial correspondence contains PHI); NABH ROM (billing dispute handling) |

## 1. Purpose
RC-004 turns every rupee a payer refuses into a coded fact, a decision and — where the refusal is wrong — money recovered. It maintains the hospital's **denial reason taxonomy** with a mapping from each payer's free-text wording, captures denials and line-level disallowances from RC-001/RC-002/RC-007, runs a deadline-driven **appeal workflow** (representation letters, doctor certificates, additional evidence, escalation to the insurer's grievance cell, the Insurance Ombudsman or the scheme's grievance committee), analyses **root cause** by doctor, department, payer, procedure and reason, and closes the loop by publishing **preventive rules** into the RC-001 scrubber and RC-006 checks so the same defect cannot be submitted twice.

## 2. Users & Jobs-to-be-done
- **Denial analyst / claims executive** (desktop): code every denial and disallowance line correctly, decide the action (appeal / resubmit / accept / recover from patient / write-off), draft and send appeals before the deadline, track outcomes. 20–50 denial lines/day at a 2000-bed hospital.
- **MRD coder**: fix coding defects, answer coding objections, feed coding-related root causes back into documentation training.
- **Treating doctor**: provide the medical justification and sign the certificate that turns a "not medically necessary" denial into a recovery. Wants a 2-minute mobile interaction, not a form.
- **Finance manager**: recovery rate, denial exposure, aged appeals, write-off approvals, payer scorecards for contract renegotiation.
- **Quality manager**: denial trends as a quality indicator; CAPA for documentation defects (NC-015).
- **Medical Superintendent / HOD**: department- and doctor-level denial patterns — used for education, and shown as information, never as an automated penalty.
- **Hospital admin**: the payer relationship picture — who denies most, on what, and how much we recover.

## 3. Core Workflows

### 3.1 Reason taxonomy & payer wording mapping
1. The hospital maintains a two-level taxonomy: **category** → **reason code**, seeded and extensible:
   - **Coding** — wrong/unspecified ICD-10, procedure–diagnosis mismatch, procedure code not mapped to the payer/scheme code, gender/age conflict, unbundling.
   - **Documentation** — discharge summary missing/unsigned, indoor case papers not attached, investigation report supporting the diagnosis absent, OT note missing, implant invoice/sticker missing, ID/KYC deficient, illegible scan, claim form Part B unsigned.
   - **Non-covered / exclusion** — service excluded by the policy, standard non-payable consumable (IRDAI list), cosmetic/dental/experimental, OPD not covered, non-medical items (registration, admission kit, attendant charges).
   - **Policy status** — policy lapsed or not in force on the admission date, premium unpaid, member not covered, sum insured exhausted, wrong policy quoted.
   - **Waiting period** — initial 30-day, specific-disease 2-year, maternity, pre-existing disease waiting period.
   - **Pre-existing disease** — non-disclosure alleged, PED not declared at inception.
   - **Tariff mismatch** — rate above the agreed tariff, package rate applies, room-rent cap breached (proportionate deduction), implant rate above cap, pharmacy MRP dispute.
   - **Authorisation** — no pre-auth, claimed above approved amount, approval expired, enhancement not obtained, room class above entitlement.
   - **Medical necessity** — admission not warranted (could be day-care/OPD), LOS excessive, investigation not indicated, ICU stay not justified.
   - **Timeliness** — claim submitted beyond the payer window, query reply beyond the deadline, intimation not given within 24 h.
   - **Process/other** — duplicate claim, payment already made, patient not traceable, TPA-insurer handover, fraud suspicion (handled separately with legal).
2. Each reason code carries: default action recommendation, typical recoverability (`high/medium/low/none`), whether it is **preventable by us** (the crucial flag for root cause), the owning function (coding/documentation/insurance desk/clinician/billing/tariff), and the appeal template to use.
3. **Payer wording map**: each payer's literal denial text ("as per policy clause 4.2, proportionate deduction applied") is mapped to our reason code, so analytics work across payers. `denial.auto_reason_mapping` matches new wording by trigram similarity to previously mapped strings and proposes a code, which a human confirms.

### 3.2 Denial capture
1. Sources: `claim.rejected`, `claim.partially_approved` / `claim.short_settled` (line-level disallowances) from RC-001; `preauth.denied` / `preauth.partially_approved` from RC-002; scheme deductions and NHA audit findings from RC-007; settlement short payments from EN-002 §3.7; corporate invoice deductions from NC-012.
2. A **denial record** is created per (claim or pre-auth) per reason, with the affected amount and — where the payer gave line detail — links to the specific claim lines. The payer's letter/PDF is attached and, where `denial.auto_reason_mapping` is on, parsed for candidate reasons.
3. Triage assigns the record: reason category → default owner queue (coding → MRD, documentation → desk, medical necessity → treating doctor, tariff → tariff admin) with an SLA, and computes the **appeal deadline** = payer's stated deadline, or contract default, or the regulatory reference (insurer grievance: 15 days for the insurer to respond; Ombudsman: within 1 year of rejection) → Event `denial.recorded`.

### 3.3 Decision & action
For each denial the analyst selects one action (with a mandatory justification):
- **Appeal / representation** (§3.4) — when the denial is wrong or evidence exists.
- **Resubmit** (RC-001) — when the defect is fixable (missing document, wrong code) and the payer permits resubmission.
- **Accept** — the deduction is legitimate (standard non-payable, agreed tariff, co-pay); accepted amounts are classified so the P&L distinguishes *contractual* deductions from *avoidable losses*.
- **Recover from patient** — only where the policy/contract allows and a signed patient consent exists; raises a patient bill (RC-001 §3.7).
- **Write-off** — with EN-038 approval by slab and a reason category (time-barred, uneconomic to pursue, goodwill, legal advice).
- **Dispute** (EN-002) — for settlement/short-payment discrepancies that are commercial rather than clinical.
Every action is time-stamped, attributable and reversible only by creating a new decision (append-only history).

### 3.4 Appeal workflow
1. **Draft**: the analyst opens the appeal composer — the template (EN-039) is chosen by reason code; the letter auto-fills claim references, payer references, the policy clause being contested, our counter-argument skeleton, and an evidence list. Evidence is assembled from the existing pack plus new items (additional clinical notes, comparative literature/protocol reference, tariff sheet extract proving the contracted rate, room-availability register proving no lower class was free).
2. **Medical justification**: for medical-necessity and PED denials, a task goes to the treating doctor with the payer's exact objection and a short structured form (why admission was required, what the alternative risk was, references to the recorded findings) → doctor e-signs (EN-016) → attached as a doctor's certificate.
3. **Internal approval**: appeals above a configured amount, or those alleging payer breach of contract, need finance/insurance-lead approval (EN-038) before dispatch.
4. **Dispatch & track**: sent via the payer's channel (RC-001 transmission machinery: email/portal/API/NHCX `Communication`), acknowledgement recorded, response deadline tracked with escalation → outcome enum(fully_recovered/partially_recovered/upheld_by_payer/no_response) with the recovered amount posted back to RC-001/RC-005/NC-009 → Event `denial.appeal.decided`.
5. **Escalation ladder** (`denial.ombudsman_tracking`): payer claims desk → payer **Grievance Redressal Officer** (with the IRDAI 15-day response reference) → **IRDAI Bima Bharosa** complaint → **Insurance Ombudsman** (complaint within 1 year of the insurer's final rejection; limit ₹50 lakh) → legal (NC-023). For schemes: district grievance cell → state grievance redressal committee → NHA. Each rung records the reference number, date, documents and outcome; the system warns when a rung's own limitation period is about to expire.
6. **Second-level appeal / review**: where a payer permits a review petition, a second cycle is tracked with its own deadline; the number of cycles per payer is configurable.

### 3.5 Root-cause analytics
1. Every denial is attributed along dimensions: payer/TPA, reason code and category, **preventable-by-us** flag, owning function, treating doctor, department/specialty, procedure/package, ward, claim value band, coder, insurance-desk executive, submission channel, whether a pre-auth query preceded it, and whether the scrubber had flagged (and someone overrode) a related warning.
2. Standard analyses: Pareto of reasons by amount and by count; denial rate trend by payer (denied amount ÷ claimed amount); avoidable vs contractual split; doctor-wise and department-wise denial rate normalised by claim volume and case mix (with a minimum-volume threshold before a doctor is shown, and always presented for education — `denial.doctor_scorecards` is off by default and requires MS sign-off to enable); procedure-wise denial hot spots; time-to-denial distribution; correlation between scrubber overrides and later denials (a direct measure of override cost); repeat-defect detection (same reason, same doctor/coder, three times in 90 days → CAPA in NC-015).
3. **Cost of denial**: each denial carries not only the disallowed amount but an estimate of the *work* cost (appeal effort) so finance can see when pursuing is uneconomic.

### 3.6 Preventive rules loop (`denial.preventive_rules`)
1. When a reason code crosses a threshold (default: 10 occurrences or ₹2 lakh in 90 days, configurable per code), the system generates a **preventive rule proposal**: a draft RC-001 scrub rule (predicate, severity, payer scope, message, remediation hint), or an RC-006 charge-capture check, or an RC-002 checklist item, or a documentation prompt in OP-002/IP-002.
2. The proposal is reviewed by the insurance lead (+ MS for clinical documentation prompts), simulated against the last 500 claims ("this rule would have flagged 37 claims, 34 of which were later denied"), then approved and published → Event `denial.preventive_rule.published` → RC-001 scrubber picks it up on its next rule-set version.
3. Effectiveness is measured: occurrences of that reason before vs after publication, shown on the rule's own page. Rules that never fire in 180 days are proposed for retirement.

### 3.7 Exceptions
- Payer gives a lump-sum deduction with no line detail → a "reason not stated" record is created and a **mandatory query to the payer** is raised; unstated-reason volume is itself a payer scorecard metric and a contractual talking point.
- Denial received after the claim was written off → the write-off is reversed if the appeal succeeds (journal reversal in NC-009 with the original reference).
- Fraud-suspicion denials are routed to a restricted queue (admin + MS + legal only) and never appear in doctor-facing analytics.
- Patient-facing consequences (recovery from patient) require counselling documentation; the patient's grievance, if any, is handled in NC-032 and cross-linked.

## 4. Data Model (schema `billing`, prefix `denial_`)
- **denial_reason_codes** — id, hospital_id?, code, category enum(coding/documentation/non_covered/policy_status/waiting_period/pre_existing/tariff_mismatch/authorisation/medical_necessity/timeliness/process_other/fraud), label, description, default_action enum(appeal/resubmit/accept/recover_patient/write_off/dispute), recoverability enum(high/medium/low/none), preventable_by_us bool, owning_function enum(coding/documentation/insurance_desk/clinician/billing/tariff/patient_registration), appeal_template_id (EN-039), scheme_scope text[]?, active bool, version, audit cols. UNIQUE(hospital_id, code).
- **denial_payer_wording_map** — id, hospital_id, payer_id, payer_text citext, normalised_text, reason_code_id, confidence numeric(4,3), mapped_by, mapped_at, auto_proposed bool, occurrences int. GIN trigram index on `normalised_text`.
- **denials** — id, hospital_id, branch_id, source_type enum(claim/preauth/settlement/scheme_audit/corporate_invoice), claim_id?, preauth_request_id?, settlement_allocation_id?, scheme_claim_id?, encounter_id, patient_id, payer_id, tpa_id, reason_code_id?, payer_reason_text, denied_amount numeric(14,2), claim_lines uuid[]?, denial_date, received_via enum(letter/portal/email/api/nhcx/settlement_advice), letter_file_id, is_full_rejection bool, reason_stated bool, appeal_deadline date?, status enum(new/triaged/under_review/action_selected/appeal_in_progress/escalated/recovered/partially_recovered/accepted/written_off/patient_recovered/closed), assigned_to, assigned_role, sla_due_at, recovered_amount numeric(14,2) default 0, accepted_amount, written_off_amount, patient_recovered_amount, work_cost_estimate?, closed_at, audit cols. Indexes (hospital_id, status, appeal_deadline), (hospital_id, payer_id, denial_date desc), (claim_id), (reason_code_id, denial_date).
- **denial_attributions** — denial_id, doctor_id?, department_id?, coder_id?, desk_user_id?, procedure_code?, package_id?, ward_id?, scrubber_override_id? (link to the RC-001 override that let this through), preauth_query_count, value_band. (Denormalised at capture time so analytics never re-derive history.)
- **denial_actions** — id, denial_id, action enum(appeal/resubmit/accept/recover_patient/write_off/dispute/no_action), justification, amount, decided_by, decided_at, approval_id?, superseded_by? (append-only decision history).
- **denial_appeals** — id, denial_id, appeal_no (series `APPEAL`), level smallint (1 = payer claims desk, 2 = payer GRO, 3 = IRDAI Bima Bharosa, 4 = Ombudsman, 5 = legal; scheme variants), template_id, letter_file_id, evidence_file_ids uuid[], doctor_certificate_file_id?, doctor_signed_by?, doctor_signed_at?, submitted_at, channel, payer_ref_no, response_due_at, responded_at, outcome enum(fully_recovered/partially_recovered/upheld/no_response/withdrawn)?, recovered_amount, outcome_letter_file_id, notes, audit cols.
- **denial_escalations** — appeal_id, rung enum(payer_desk/payer_gro/irdai_bima_bharosa/ombudsman/scheme_district/scheme_state/nha/legal), reference_no, filed_at, limitation_expiry date, response_at, outcome, documents jsonb.
- **denial_preventive_rules** — id, hospital_id, reason_code_id, trigger_stats jsonb (occurrences, amount, window), proposed_rule jsonb (target enum(rc001_scrub/rc006_check/rc002_checklist/clinical_prompt) + predicate + message), simulation_result jsonb, status enum(proposed/under_review/approved/published/retired/rejected), approval_id, published_rule_ref, published_at, effectiveness jsonb (before/after occurrence counts), reviewed_by.
- **denial_capa_links** — denial_id/reason_code_id, capa_id (NC-015), opened_at, status.
- Read models: `analytics.mv_denial_pareto` (reason × amount × count × payer), `mv_denial_rate_payer` (monthly denied ÷ claimed), `mv_denial_by_doctor` (volume-normalised, min-volume gated), `mv_appeal_recovery` (recovery rate & TAT by reason and level), `mv_denial_avoidable_split`.
- RLS on `hospital_id`; fraud-category denials additionally restricted by ABAC. Denial letters are PHI-bearing documents in S3 with read audit. Retention 8 years.

## 5. Business Rules & Validations
- Every denial must carry either a mapped `reason_code_id` or an explicit `reason_stated = false`; a denial cannot be closed with an unmapped reason (this is what makes the analytics trustworthy).
- The sum of `recovered + accepted + written_off + patient_recovered` on a closed denial must equal `denied_amount` (± ₹1); closure is blocked otherwise, and RC-001's claim closure equation depends on it.
- **Appeal deadlines are hard**: the system computes and displays days remaining, escalates at 50 % and 80 % of the window, and blocks the "accept/write-off" action while an appeal is still viable unless the analyst records "not worth pursuing" with the work-cost justification.
- Ombudsman route: only after the insurer's final written rejection and a GRO representation, within 1 year of the rejection, for claims within the monetary limit — the system validates these preconditions before allowing an Ombudsman filing to be recorded.
- Write-off requires EN-038 approval by slab, requester ≠ approver, and a reason category; a write-off that is later recovered reverses the original journal with a reference (never a new unlinked entry).
- Recovery from the patient requires a signed consent document on file and, for scheme beneficiaries, is **hard-blocked** (RC-007 no-cash rule).
- Doctor-wise analytics require a minimum claim volume (default 20 in the period) before a doctor is displayed, are case-mix noted, and are visible only to MS/HOD/Finance/Admin. `denial.doctor_scorecards` defaults to off; enabling it is an audited configuration change requiring MS sign-off. No automated financial consequence to a clinician may be derived in this module (NC-034 payouts must not consume denial data automatically).
- A preventive rule may be published only after simulation and approval; publication records who approved it and its effectiveness is reviewed at 90 days.
- Scrubber-override linkage is mandatory where applicable: if a denial's reason matches a warning that was overridden on that claim, the override is linked and appears in the override-cost report.
- Payer wording auto-mapping proposals above the confidence threshold still require human confirmation before first use for a given payer.
- Appeals and denial correspondence are PHI: attachments follow the minimum-necessary rule and inherit the claim's consent record.

## 6. API Surface (`/api/v1/denials`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /denials?status=&payer=&reason=&deadline=&assignee= | worklist | denial.record.list | – | cursor |
| POST | /denials | create (auto from events / manual) | denial.record.create | Y (source,claim,reason) | – |
| GET/PATCH | /denials/{id} | detail / triage & assign | denial.record.read/update | Y | – |
| POST | /denials/{id}/map-reason | set/confirm reason code | denial.reason.map | Y | – |
| POST | /denials/{id}/actions | record decision (appeal/accept/…) | denial.action.decide | Y | – |
| POST | /denials/{id}/appeals | create appeal (level n) | denial.appeal.create | Y | – |
| GET/PATCH | /appeals/{id} | appeal detail / edit draft | denial.appeal.read/update | Y | – |
| POST | /appeals/{id}/doctor-task | request medical justification | denial.appeal.update | Y | – |
| POST | /appeals/{id}/sign | doctor e-sign certificate | denial.certificate.sign | Y | – |
| POST | /appeals/{id}/submit | dispatch via channel | denial.appeal.submit | Y | – |
| POST | /appeals/{id}/outcome | record payer response & recovery | denial.appeal.outcome | Y | – |
| POST | /appeals/{id}/escalate | next rung (GRO/Bima Bharosa/Ombudsman/scheme) | denial.appeal.escalate | Y | – |
| POST | /denials/{id}/write-off | request write-off (→ EN-038) | denial.writeoff.request | Y | – |
| POST | /denials/{id}/close | close with balancing amounts | denial.record.close | Y | – |
| GET/POST/PATCH | /reason-codes | taxonomy admin | denial.taxonomy.configure | Y | cursor |
| GET/POST | /wording-map | payer wording mapping | denial.reason.map | Y | cursor |
| GET | /analytics/pareto?by=reason\|payer\|doctor\|department\|procedure&from=&to= | root cause | denial.report.read | – | – |
| GET | /analytics/rate?payer=&period= | denial rate trend | denial.report.read | – | – |
| GET | /analytics/recovery | appeal recovery rate & TAT | denial.report.read | – | – |
| GET | /analytics/override-cost | denials linked to scrub overrides | denial.report.read | – | – |
| GET/POST | /preventive-rules ; POST /preventive-rules/{id}/simulate ; /publish | rule loop | denial.rule.propose / denial.rule.publish | Y | cursor |
| GET | /exports/denial-register?from=&to= | audit/finance extract | denial.report.export | – | – |

## 7. Domain Events (outbox)
- `denial.recorded` {denial_id, claim_id, reason_code, amount, payer, preventable} → RC-005 (balance stays open), EN-001, NC-015 (if repeat defect), desk worklist.
- `denial.reason.mapped` {payer_text → code, confidence, by} → analytics, wording map learning.
- `denial.action.decided` {action, amount, by}.
- `denial.appeal.created|submitted` {level, deadline} → EN-037 deadline tracking, RC-001 transmission.
- `denial.appeal.decided` {outcome, recovered_amount} → RC-001 (claim amounts), RC-005 (AR), NC-009 (recovery receipt/journal), EN-001.
- `denial.escalated` {rung, reference_no} → compliance log, admin notification.
- `denial.written_off` {amount, reason_category, approval_id} → NC-009, leakage report.
- `denial.preventive_rule.proposed|published|retired` → **RC-001 scrubber**, RC-006 checks, RC-002 checklists, OP-002/IP-002 documentation prompts.
- `denial.repeat_defect.detected` {reason_code, owner, occurrences} → NC-015 CAPA, HOD notification.
- `denial.deadline.approaching|missed` {denial_id, days} → EN-037 escalation.
- Consumes: `claim.rejected`, `claim.partially_approved`, `claim.short_settled`, `preauth.denied|partially_approved`, `insurance.settlement.matched` (short payments), `scheme.claim.deducted` (RC-007), `claim.scrub.overridden` (RC-001, for override-cost linkage).

## 8. Screens
- **Denial Worklist** (desktop): tabs *New / unmapped*, *Action pending*, *Appeals in progress*, *Deadline < 7 days*, *Escalated*, *Recovered*, *Closed*. Columns: patient, payer, claim no, denied amount, reason (chip; red if unmapped), preventable flag, deadline countdown, owner. Filters by payer/reason/doctor/department/amount band. Shortcuts: `M` map reason, `A` appeal, `X` accept, `W` write-off, `E` escalate, `/` search, `Ctrl+K` palette. Real-time updates as RC-001 events arrive; the deadline column sorts by urgency by default. Empty state per tab; a persistent red banner when any appeal deadline is within 48 hours.
- **Denial Detail** (desktop, 3-pane): left = claim/pre-auth context (claimed, approved, disallowed lines highlighted, pre-auth chain, the scrubber's original verdict and any override with the overriding user's name); centre = payer letter viewer side-by-side with the reason mapping panel (suggested code with confidence, "map & remember for this payer"); right = action panel with recommended action from the reason code, amounts, and the decision history (append-only).
- **Appeal Composer** (desktop): template-driven letter editor with merge fields, evidence picker (existing pack documents plus new uploads), clause-citation helper (policy clause vs our counter-argument), doctor-certificate request button with status, internal approval status, dispatch panel (channel, reference), and a deadline banner.
- **Doctor justification card** (phone/tablet, ~2 minutes): "Star Health says this admission was not medically necessary — here is what they wrote. Why was admission required?" with structured prompts, the recorded vitals/labs available as one-tap inserts, and Sign & send.
- **Root-Cause Analytics** (desktop/TV admin dark theme): Pareto bar of reasons by amount with a count overlay; heat map payer × reason; trend of denial rate by payer; avoidable vs contractual split donut; doctor/department view (volume-normalised, gated); procedure hot spots; override-cost card ("₹X of denials came from claims where a scrub warning was overridden"); drill-through to the denial list; export.
- **Recovery dashboard**: appeal success rate by reason and by level, average days to recovery, recovered ₹ this month vs target, aged appeals list, ombudsman/scheme escalations register.
- **Preventive Rules** (desktop): proposals with trigger statistics, simulation results against recent claims, approve/publish controls, published-rule effectiveness charts (before/after), retirement suggestions.
- **Taxonomy & Wording Map admin** (desktop): reason code tree with defaults; payer wording list with occurrence counts and unmapped-text queue.
- All screens: WCAG 2.2 AA, keyboard-first, i18n; the payer-letter viewer supports PDF and image with zoom and rotate for poor scans.

## 9. Integrations
- **RC-001** (denial and short-payment events, claim lines, transmission machinery for appeal dispatch, scrubber rule publication), **RC-002** (pre-auth denials), **EN-002** (payer master, settlement disputes, escalation contacts), **RC-007** (scheme deductions, NHA audit findings, scheme grievance rungs), **RC-005** (denied balances in AR), **RC-006** (charge-capture and documentation defects), **NC-003** (coding), **NC-009** (recovery receipts, write-off journals, reversal on later recovery), **NC-015** (CAPA), **EN-038** (approvals), **EN-039** (appeal templates: representation letter, doctor's certificate, GRO complaint, Bima Bharosa complaint, Ombudsman complaint format), **EN-016** (e-sign), **EN-032/EN-009** (dispatch and reminders), **EN-037** (deadline escalation), **EN-001/NC-011** (analytics), **NC-023** (legal, when escalation reaches litigation).
- External references maintained as configuration: insurer GRO contact directory, IRDAI Bima Bharosa portal reference, Insurance Ombudsman office by jurisdiction, scheme grievance cells by state — with the filing formats stored as templates.

## 10. Reports & Analytics
- Denial register (period, payer, reason, amount, action, outcome) — the finance and audit workhorse export.
- Denial rate by payer (denied ÷ claimed, monthly trend) and by scheme; **avoidable vs contractual** split with rupee impact; top 10 reasons by amount and by count.
- Recovery: appeal success rate by reason/level/payer, average days to recovery, recovered amount vs denied amount (the headline **recovery rate KPI**), aged appeals, deadlines missed (with cause).
- Root cause: doctor-wise and department-wise denial rate (gated), procedure hot spots, coder-wise coding-defect rate, desk-executive-wise documentation-defect rate, repeat defects and their CAPA status.
- Override cost: denials traceable to an overridden scrub warning, by user.
- Prevention effectiveness: occurrences of each reason before and after its preventive rule was published; net rupees protected.
- Payer scorecard (also shareable with the payer via PE-008): denial rate, unstated-reason rate, average decision TAT, appeal overturn rate — the evidence base for contract renegotiation.
- Read models listed in §4; refreshed every 15 minutes and nightly for the heavier cross-tabs.

## 11. Notifications
- **Analyst**: new denial assigned, unmapped reason awaiting mapping > 24 h, appeal deadline in 7/3/1 days, payer response received, escalation limitation period approaching.
- **Doctor**: medical justification requested (push + WhatsApp fallback), certificate signature pending, "your appeal was successful — ₹X recovered" (closing the loop makes doctors respond next time).
- **MRD/coder**: coding objection assigned, repeat coding defect detected.
- **Finance**: weekly denial and recovery digest, write-off approvals pending, denial rate breach vs threshold for any payer, monthly avoidable-loss summary.
- **Quality (NC-015)**: repeat-defect CAPA opened, documentation defect trend.
- **Admin/MS**: payer scorecard monthly, escalation to Ombudsman filed, doctor-scorecard configuration change (audited).

## 12. Permissions (RBAC keys)
`denial.record.list|read|create|update|close` (Insurance desk, Denial analyst) · `denial.reason.map` (desk, MRD coder) · `denial.action.decide` (desk; ABAC amount limits for accept/write-off recommendations) · `denial.appeal.create|read|update|submit|outcome` (desk) · `denial.appeal.escalate` (Insurance lead / Finance Manager — GRO and above) · `denial.certificate.sign` (Doctor only) · `denial.writeoff.request` (desk) / `denial.writeoff.approve` (Finance Manager/Admin, slabbed, requester ≠ approver) · `denial.taxonomy.configure` (Insurance lead + Finance approval) · `denial.rule.propose` (desk, analyst) / `denial.rule.publish` (Insurance lead + MS for clinical prompts) · `denial.report.read` (Finance, Admin, Insurance lead, Quality, MS, HOD for own department) · `denial.report.doctor_view` (MS, HOD, Admin, Finance only — gated by `denial.doctor_scorecards`) · `denial.report.export` (Finance, Admin, Auditor — audited) · `denial.fraud.read` (Admin, MS, Legal only).

## 13. Non-functional
- **Volumes** (2000 beds): ~2,000 claims/month with a 10–20 % denial/short-payment rate → 200–400 denial records/month, ~1,500 denial *lines*; 60–120 appeals/month; 5,000+ mapped payer wordings after two years.
- **Performance**: worklist p95 < 200 ms over 3,000 open denials with deadline sorting (deadlines stored, not computed); Pareto/heat-map dashboards < 500 ms from read models; reason auto-mapping suggestion < 100 ms (trigram index); appeal letter render < 5 s.
- **Data quality**: unmapped-reason count is a monitored SLO (target < 5 % of open denials older than 24 h) surfaced on the desk dashboard.
- **Offline**: none required (back-office function); the doctor justification card tolerates poor connectivity and queues the signature.
- **Printing**: appeal/representation letter (hospital letterhead, EN-039), doctor's certificate, GRO/Bima Bharosa/Ombudsman complaint formats, denial register export (XLSX/PDF).
- **Accessibility/i18n**: appeal correspondence in English; UI multilingual; WCAG 2.2 AA; payer-letter viewer keyboard-navigable with zoom for poor-quality scans.
- **Security**: appeal and denial documents are PHI — encrypted, presigned, read-audited; fraud-category records restricted; doctor-attributed analytics restricted by role and gated by a feature flag whose change is audited; exports watermarked.

## 14. Acceptance Criteria
1. Given `claim.partially_approved` with three disallowed lines, when the event is consumed, then three denial records (or one per distinct reason) are created with the affected amounts and links to the specific claim lines within 5 s.
2. Given a payer's free-text denial wording never seen before, when the analyst maps it to a reason code, then future occurrences of the same wording for that payer are auto-suggested with a confidence score and require only confirmation.
3. Given a denial with no reason code, when the analyst attempts to close it, then closure is blocked with "reason must be mapped".
4. Given a denial of ₹40,000 closed with recovered ₹25,000, accepted ₹10,000 and written off ₹5,000, then closure succeeds; given the amounts do not sum to ₹40,000, closure is rejected with the difference shown.
5. Given an appeal deadline 7 days away, then the record is flagged, the analyst is notified at 7/3/1 days, and at 80 % of the window the insurance lead is notified.
6. Given an appeal is created for a medical-necessity denial, then a doctor task is generated with the payer's exact objection text, and the appeal cannot be dispatched until the doctor's certificate is e-signed.
7. Given an Ombudsman filing is attempted without a recorded final written rejection and a prior GRO representation, then the action is blocked with the precondition explained.
8. Given a write-off of ₹80,000 requested by an analyst with a ₹10,000 slab, then it routes to the Finance Manager and cannot be approved by the requester; on approval a journal is posted to NC-009 with the reason category.
9. Given a written-off denial is later recovered on appeal, then the write-off journal is reversed with a reference to the original and the recovery is posted, and the claim's closure equation still balances.
10. Given a scheme beneficiary, when "recover from patient" is selected, then the action is blocked with "scheme beneficiary — no patient recovery permitted" and a compliance entry is written.
11. Given a reason code reaching 10 occurrences in 90 days, then a preventive rule proposal is generated with trigger statistics, and simulation shows how many of the last 500 claims the rule would have flagged.
12. Given a preventive rule is approved and published, then RC-001's next scrub rule-set version includes it, and new claims with that defect fail scrubbing before submission.
13. Given a claim where a scrub warning was overridden and the claim was later denied for a matching reason, then the denial is linked to the override and appears in the override-cost report with the overriding user.
14. Given `denial.doctor_scorecards` is off, when a user opens analytics, then no doctor-level view is available; enabling the flag requires MS sign-off and writes an audit entry.
15. Given a doctor with 8 claims in the period, then the doctor is not displayed in doctor-wise analytics (minimum-volume gate).
16. Given a payer issues a lump-sum deduction with no reason, then a "reason not stated" record is created, a query to the payer is raised automatically, and the payer's unstated-reason rate updates on the scorecard.
17. Given the denial register is exported by a user without `denial.report.export`, then 403 and an audit entry are recorded.
18. Given 3,000 open denials, then the worklist loads p95 < 200 ms and the deadline ordering matches a SQL recomputation exactly.

## 15. Enhancements / Later phases
- From the VIMS sheet (row 136): denial reason log, appeal workflow, root cause, trend report — all core above.
- Later: **AI reason extraction** (AI-003) from payer denial letters and settlement advices with auto-mapping; **AI appeal drafting** (AI-002/AI-006) producing a first-draft representation from the case record and the payer's objection, always human-reviewed and doctor-signed; **denial prediction** (AI-005) scoring claims pre-submission with the specific reasons most likely to be raised; automatic evidence assembly (pull the exact lab value or X-ray finding cited in the objection); payer-behaviour analytics (which payer changes its position after a level-2 appeal — informs whether to appeal at all); benchmark against peer hospitals' denial rates (anonymised, later); direct integration with Bima Bharosa/Ombudsman filing where APIs exist; economic model recommending appeal vs write-off from expected recovery × probability minus work cost.
- (market) reduce rejections through EMR-driven claims and paperless approval workflows (SMART HMIS); rejection analysis as a first-class module (VIMS RC-001 key functions) — RC-004 deepens it into root cause and prevention, which none of the surveyed products do.

## 16. Open Questions for the Hospital
1. Your current denial reason list (even if informal) and the top 10 reasons by amount over the last 12 months — the seed for the taxonomy.
2. Which payers give line-level deduction reasons and which give lump sums? What is your recourse today for unstated reasons?
3. Appeal deadlines per payer (contractual), and whether you have ever escalated to a Grievance Redressal Officer, Bima Bharosa or the Insurance Ombudsman — with any templates you used.
4. Who writes appeals today, and who signs the medical justification — the treating doctor or a designated medical officer?
5. Internal approval thresholds for filing an appeal, accepting a deduction and writing off, and who signs each.
6. Do you ever recover a disallowed amount from the patient? Under what circumstances, and is there a consent form?
7. Should doctor-wise denial analytics be enabled, who may see them, and what minimum case volume is fair? (Default: off, MS sign-off required.)
8. Do you want denials to open CAPA in the quality module automatically (NC-015), and at what repeat threshold?
9. For PMJAY/CGHS/ESIC deductions — who handles them, what are the appeal routes and time limits in your state?
10. What denial rate and recovery rate targets does finance work to today, and which report do they use for payer renegotiation?
11. Are there payers you consider chronically unreasonable (for scorecard prioritisation and possible de-empanelment discussions)?
12. Do you want the preventive-rule loop to publish scrub rules automatically after approval, or should each rule be manually staged in RC-001 first?
