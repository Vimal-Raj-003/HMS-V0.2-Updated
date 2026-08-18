# RC-001 — Claims Management (Claim Lifecycle, Pack Assembly, Scrubbing Engine, Multi-Channel & NHCX Submission, Short Payment & Write-off, Aging, Resubmission, Audit)

| Field | Value |
|---|---|
| Domain | Revenue Cycle Management |
| Module ID | RC-001 |
| Phase | 5 (lifecycle, pack, portal/email channels) → 11 (NHCX / ABDM M4 FHIR exchange, IIB/IRDAI automation) |
| Priority | P1 |
| Complexity | Very High |
| Depends on | **EN-002 (payer/TPA/empanelment master, insurance desk workflow, settlement reconciliation — RC-001 owns the claim *lifecycle, pack and transport*)**, RC-002 (pre-auth is the claim's parent; approved amount caps the claim), RC-003 (payer rates & ROHINI/scheme codes on claim lines), RC-004 (denial/short-payment taxonomy, appeals; scrubber rules are fed by RC-004 root causes), RC-005 (claim AR aging & follow-up), RC-006 (charge capture completeness before pack), RC-007 (scheme claim formats: PMJAY/CGHS/ECHS/ESIC/state), RC-008 (estimate vs claim variance), OP-005/IP-005 (finalised bills & bill lines), IP-002 (discharge summary), NC-003 (MRD coding & documents), TR-003 (implant invoices, UDI stickers), OP-004/OP-008 (reports), IP-006 (OT notes), EN-011 (ABDM identity/gateway patterns shared with NHCX), EN-019 (FHIR R4 resource layer), EN-017 (payer API adapters, DLQ), EN-016 (e-sign on claim forms), EN-039 (IRDAI Part A/B and payer templates), EN-032/EN-009 (email/WhatsApp), NC-004 (document store), NC-009 (AR ledger, TDS, write-off journals), EN-038 (write-off approvals), EN-024 (audit), PE-008 (payer portal), PE-001 (patient claim status) |
| Feature flag | `module.claims.enabled` (sub: `claims.nhcx`, `claims.scrubber`, `claims.api_channel`, `claims.bulk_submission`, `claims.iib_export`, `claims.ai_coding_assist`) |
| Primary roles | Insurance / TPA Desk (28), Claims Executive (28 family), MRD Coder (43) |
| Secondary roles | Billing Executive (27), Treating Doctor (6/7/9 — coding clarification, medical justification), Accountant (46 — settlement, TDS, write-off), Finance Manager (46 — write-off approval), Corporate billing (29), Hospital Admin (2), TPA/Insurer user (62 via PE-008), Patient (59 — reimbursement pack, status), Auditor (58) |
| Regulatory | **IRDAI Health Insurance Regulations 2016 & Master Circular 2024** (standard claim forms Part A/B, cashless authorisation 1 h / final 3 h, claim settlement timelines, grievance → GRO → Insurance Ombudsman), **ROHINI** hospital ID on every claim, **IIB** (Insurance Information Bureau) claim data submission formats, **NHCX — National Health Claims Exchange** (ABDM Milestone 4; HCX protocol over FHIR R4: `CoverageEligibilityRequest/Response`, `Claim`, `ClaimResponse`, `Communication`, `PaymentNotice`; JWE-encrypted payloads, participant registry, digital signatures), **ABDM V3** (linking claim to care contexts), **PMJAY/NHA** claim & audit rules (RC-007), **CGHS/ECHS/ESIC** claim formats, **GST** (claim is not a supply document — the tax invoice from OP-005/IP-005 is; credit notes on disallowance), **Income-tax TDS §194J** deducted by payers (Form 26AS reconciliation), **DPDP Act 2023 & Rules 2025** (payer sharing consent, purpose limitation, minimum-necessary documents, breach notification), **NABH ROM/MOI** (records, billing transparency), IT Act (e-records, digital signature) |

## 1. Purpose
RC-001 owns the life of a claim from the moment a payer-funded bill is finalised until the money is in the bank and the file is closed. It assembles a complete, indexed **claim pack**, runs a **scrubbing rules engine** that catches the errors payers reject for before the claim leaves the building, submits through whichever channel the payer supports (portal, email, courier, payer API, or **NHCX** FHIR exchange with per-payer routing), tracks queries, deficiencies and resubmissions, records line-level approvals, disallowances and short payments, drives appeals (RC-004) and write-offs, feeds AR aging (RC-005) and the ledger (NC-009), and keeps an immutable audit of every version of every document sent to a payer.

## 2. Users & Jobs-to-be-done
- **Claims executive** (desktop, dual monitor, scanner, high volume): work the "ready to pack" queue, fix scrubber errors, generate and submit packs, log payer acknowledgements, answer deficiency queries, resubmit. 60–120 claims/day at a 2000-bed hospital.
- **MRD coder**: confirm ICD-10 diagnosis and procedure codes on the claim, map to ROHINI/PMJAY/CGHS codes, resolve coding queries — coding errors are the single largest denial cause and are caught here.
- **Billing executive**: ensure the bill is complete and finalised (RC-006 exceptions cleared) before the claim is created.
- **Treating doctor**: sign the medical certificate / respond to clinical deficiency queries.
- **Accountant**: match settlements (EN-002 §3.7), post TDS and disallowance journals, process approved write-offs.
- **Finance manager**: claim aging by payer, submission SLA, denial and short-payment exposure, write-off approvals.
- **Patient**: reimbursement pack download and claim status on PE-001/OP-020.
- **Payer user (PE-008)**: receives the claim, raises deficiencies, uploads the settlement advice.

## 3. Core Workflows

### 3.1 Claim creation
1. Trigger: `ip.bill.finalized` / `bill.finalized` with `payer_share > 0`, or `preauth.final_authorised`, or manual creation by the desk (reimbursement, corporate credit, late claim). One claim per (encounter, payer); multi-payer encounters create claims in priority order — the secondary claim may not be submitted until the primary's decision is recorded.
2. System assembles the draft: patient & policy snapshot, pre-auth chain (initial + enhancements, with the cumulative approved amount), bill(s) and bill lines mapped to **claim lines** with payer/ROHINI/HBP codes and payer rates (RC-003), diagnosis (ICD-10 principal + secondary) and procedures from NC-003/IP-002, admission & discharge dates, room class and days, implant details (TR-003 with UDI, invoice number and value), claimed amount = payer share of the finalised bill, patient share (co-pay, deductible, non-payables, above-approval amount) → status `draft` → Event `claim.created`, claim_no from series `CLAIM/{BR}/{FY}/{SEQ:6}` (gapless).

### 3.2 Coding & clinical completeness
- MRD coder reviews: principal diagnosis consistent with the procedure and the pre-auth; ICD-10 specificity (unspecified codes flagged); procedure code ↔ package/ROHINI mapping; implant justification present for implant claims; MLC/FIR attached for RTA; date of first symptom recorded for chronic conditions. `claims.ai_coding_assist` (AI-006, later) proposes codes from the discharge summary; a human always confirms.

### 3.3 Claim scrubbing engine (`claims.scrubber`)
1. Before a pack can be generated, the claim is scrubbed against a **configurable rules engine**; each rule has severity enum(error/warning/info), a payer scope (all / specific payer / scheme), a source (seeded / hospital-authored / auto-generated from an RC-004 root cause) and an owner. Rules are versioned and effective-dated, and every scrub run stores its rule-set version.
2. Seeded rule families:
   - **Identity & policy**: policy active on the admission date; member name matches the ID proof; policy number format per payer; patient age vs plan entry age; corporate employee ID present.
   - **Authorisation**: pre-auth exists and is `approved`/`final_authorised`; claimed ≤ approved total + tolerance; approval not expired at the date of admission; room class billed ≤ approved class (else proportionate-deduction line present); LOS ≤ approved days or an extension exists.
   - **Coding**: ICD-10 present and valid; principal diagnosis ↔ procedure plausibility (rule table, e.g. cataract procedure with a fracture diagnosis); gender/age–code conflicts (e.g. obstetric code on a male); unspecified-code ratio above threshold; procedure code mapped to a payer/scheme code.
   - **Tariff & amounts**: every line priced from the payer's rate plan (no `unmapped_for_payer` line); package claims not double-billing package-inclusive items; non-payables correctly moved to patient share; arithmetic (lines total = claimed + patient share = bill net); implant value ≤ invoice value; discount/concession consistent.
   - **Documents**: every `required` document present, legible (page count > 0, not a blank scan), correctly typed; discharge summary signed; final bill signed/stamped where the payer needs it; claim form Part A (hospital) and Part B (patient) both present.
   - **Timeliness**: within the payer's/scheme's claim submission window (e.g. commonly 7–30 days from discharge; PMJAY per NHA rules) — a late claim is blocked pending finance approval.
   - **Scheme-specific** (RC-007): PMJAY package blocking rules, mandatory intra-operative photographs, beneficiary verification record, "no cash collected" declaration.
3. Result: a scrub report with per-rule status and a jump link to the offending field/document. **Errors block submission; warnings require an acknowledged reason.** Scrub score and top failing rules are tracked as a KPI (`claim.scrub.failed`).

### 3.4 Claim pack assembly
1. The pack builder produces an ordered, bookmarked, page-numbered PDF plus the individual files and a ZIP:
   cover letter (payer template, ROHINI ID, claim & pre-auth references) → IRDAI claim form Part A (hospital) and Part B (patient, signed) → pre-auth approval and enhancement letters → **discharge summary** (IP-002, signed) → **itemised final bill** with payer codes and the tax invoice → payment receipts / deposit adjustments → **investigation reports** (lab OP-004, imaging OP-008) → OT notes & anaesthesia record (IP-006/IP-024) → **implant invoices and UDI stickers** (TR-003) → pharmacy and consumable bills → indoor case papers / progress notes as required → ID proof, insurance/TPA card, KYC → consents → MLC/FIR for accidents → death summary / DAMA form where applicable.
2. Every included document is registered with its source module, file id, page count and sha256; the pack itself stores `pack_checksum`, page count and the exact document version list, so a payer's "we didn't receive X" is answerable. PHI minimisation: only checklist documents are included; sensitive categories (psychiatry, HIV, fertility, oncology genetic reports) require an explicit inclusion tick with consent.
3. Pack generation is asynchronous (Playwright/PDF worker) with progress; typical pack 60–200 pages, generated in < 60 s → Event `claim.pack.generated`.

### 3.5 Submission channels & NHCX
1. **Channel routing table** per payer/branch (from the empanelment): `portal` (desk uploads; captures portal reference and a confirmation screenshot), `email` (EN-032; PDF pack, optional password-protected ZIP; delivery/read receipts), `courier` (AWB number, dispatch register, POD scan), `payer_api` (EN-017 adapter, `claims.api_channel`), `nhcx` (`claims.nhcx`).
2. **NHCX (ABDM M4) flow**: hospital is an NHCX **provider participant** (participant code, encryption keys in Vault, signed JWS/JWE payloads).
   - `CoverageEligibilityRequest` → `CoverageEligibilityResponse` (RC-002 eligibility).
   - `Claim {use = preauthorization}` → `ClaimResponse` (pre-auth decision, RC-002).
   - `Claim {use = claim}` with a FHIR Bundle: `Patient`, `Coverage`, `Encounter`, `Organization` (with ROHINI id), `Practitioner`, `Condition` (ICD-10), `Procedure`, `ChargeItem`/`Claim.item` lines with payer codes, `DocumentReference` for each pack document (base64 or link), `Claim.total`.
   - `ClaimResponse` returns adjudication per item (`adjudication.category` = submitted/eligible/deductible/copay/benefit, `reason` codes) → mapped into claim lines and RC-004 reason codes.
   - `Communication`/`CommunicationRequest` for payer queries; `PaymentNotice`/`PaymentReconciliation` for settlement advice where the payer supports it.
   - Correlation ids, workflow ids and status callbacks are stored; retries are idempotent on the correlation id; failures go to the DLQ with an operator screen (EN-017).
3. On successful transmission: status `submitted`, submission timestamp, payer acknowledgement reference, **expected settlement date** = submitted + credit days from the empanelment (drives RC-005 aging) → Event `claim.submitted`.
4. **Bulk submission** (`claims.bulk_submission`): select N claims for one payer → single ZIP/manifest/courier batch or batched API calls, with a per-claim result grid.

### 3.6 Tracking, queries and deficiencies
- Payer states are mirrored: `submitted → acknowledged → under_process → query_raised ⇄ query_replied → approved | partially_approved | rejected → settled | short_settled → closed`, plus `resubmitted`, `appealed` (RC-004), `written_off`, `withdrawn`.
- **Deficiency/query**: text, category (document/coding/medical/policy/billing), due date, assignment (desk/MRD/doctor/billing) with SLA, reply with additional documents → `claim.query.replied`. Every query is also a data point for the scrubber (a repeated query becomes a new scrub rule proposal).
- **Aging & chase**: claims with no payer response beyond the payer's committed TAT enter the follow-up worklist (RC-005) with a chase ladder (email → call → escalation contact → grievance).

### 3.7 Decision capture: approval, short payment, rejection
1. Payer decision recorded per **claim line**: claimed, approved, disallowed, disallowance reason code (RC-004), remarks. Line-level capture is mandatory for short payments — a lump-sum deduction without reasons is itself a dispute trigger.
2. **Short payment / disallowance categories** seeded: non-payable consumables (IRDAI standard non-payables list), tariff excess over the agreed rate, room-rent proportionate deduction, policy sub-limits and caps, co-pay/deductible, exclusions and waiting period, pre-existing disease, documentation deficiency, coding mismatch, package inclusion, implant not approved, pharmacy items not related to the ailment.
3. Actions offered: **resubmit** (fix and re-send; resubmission count tracked against the payer's limit), **appeal/representation** (RC-004 with deadline, letter template, doctor's certificate), **dispute** (EN-002 settlement dispute), **recover from patient** (only where the policy/contract permits, requires a signed patient consent document), **write-off** (EN-038 approval by amount slab; posts to NC-009 with the reason code so the P&L shows *why*).
4. `claim.approved|partially_approved|rejected|short_settled` events drive RC-004 analytics, RC-005 aging and NC-009 journals.

### 3.8 Settlement & closure
- Settlement matching lives in EN-002 §3.7 (advice, UTR, allocations, TDS); RC-001 consumes `insurance.settlement.matched` to set `settled_amount`, `tds_amount`, `disallowed_amount`, `short_amount` and to move the claim to `settled`/`short_settled`. A claim closes only when `claimed = settled + tds + disallowed(accepted) + written_off + recovered_from_patient` (the closure equation is validated) → Event `claim.closed`.

### 3.9 Reimbursement & corporate variants
- **Reimbursement**: patient pays in full; RC-001 generates the patient's reimbursement pack (bill, receipts, discharge summary, reports, doctor's certificate, claim form Part A) downloadable from PE-001 and printable at the desk; hospital optionally tracks the patient's claim outcome for service quality.
- **Corporate credit**: the claim equivalent is the corporate invoice (NC-012) with supporting documents; the same pack builder and aging apply.
- **Scheme claims** (RC-007): PMJAY/CGHS/ECHS/ESIC formats and portals; RC-001 provides the lifecycle, RC-007 the format and portal specifics.

### 3.10 Exceptions
- Bill reopened after claim submission (correction) → claim moves to `withdrawn` or a revised claim is issued with an explicit cross-reference; never two live claims for the same encounter/payer.
- Payer merges/renames (TPA change mid-treatment) → claim re-targeted with an audit note and a fresh submission.
- Patient dies / DAMA → pack variant and, for schemes, mandatory intimation timelines.
- Late claim beyond the payer window → blocked pending finance approval; if submitted, flagged `late` for denial-risk reporting.
- Offline: the desk requires connectivity; pack generation is queued and resumes after an outage.

## 4. Data Model (schema `billing`, prefix `claim_`; header shared with EN-002 `ins_claims`)
- **claims** — id, hospital_id, branch_id, claim_no (gapless `CLAIM` series), case_id (EN-002), encounter_id, patient_id, payer_id, tpa_id, policy_id, scheme_id?, preauth_request_id?, claim_type enum(cashless/reimbursement/corporate_credit/scheme), bill_ids uuid[], admission_date, discharge_date, los_days, room_class_id, principal_diagnosis (ICD-10), secondary_diagnoses text[], procedure_codes text[], payer_procedure_codes text[], claimed_amount, patient_share_amount, approved_amount, disallowed_amount, settled_amount, tds_amount, written_off_amount, recovered_from_patient_amount, status enum(draft/scrubbed/pack_ready/submitted/acknowledged/under_process/query_raised/query_replied/resubmitted/approved/partially_approved/rejected/appealed/settled/short_settled/written_off/withdrawn/closed), submission_channel enum(portal/email/courier/payer_api/nhcx), submitted_at, acknowledged_at, payer_ref_no, courier_awb, expected_settlement_date, decided_at, closed_at, resubmission_count smallint, is_late bool, scrub_score numeric(5,2), pack_file_id, pack_checksum, pack_pages int, currency, audit cols, version. Indexes (hospital_id, status, submitted_at desc), (hospital_id, payer_id, expected_settlement_date), (encounter_id, payer_id) UNIQUE where status not in ('withdrawn'), (claim_no) UNIQUE.
- **claim_lines** — id, claim_id, bill_item_id, service_id, payer_code, hsn_sac, description, qty, unit_rate, claimed_amount, approved_amount, disallowed_amount, disallowance_reason_code (RC-004), package_component bool, is_implant bool, implant_id (TR-003), remarks. Index (claim_id).
- **claim_documents** — claim_id, doc_type enum (see §3.4), file_id, source_module, source_ref_id, version, page_count, sha256, required bool, included bool, verified_by, sensitive_category?, consent_ref?.
- **claim_packs** — claim_id, pack_version, file_id, zip_file_id, checksum, page_count, document_manifest jsonb, generated_by, generated_at, superseded_by.
- **claim_scrub_rules** — id, hospital_id?, code, family enum(identity/authorisation/coding/tariff/documents/timeliness/scheme), severity enum(error/warning/info), payer_scope jsonb, expression jsonb (declarative predicate over the claim projection), message, remediation_hint, source enum(seed/hospital/derived_from_denial), derived_from_reason_code?, version, effective_from, effective_to, enabled bool, author, approval_id.
- **claim_scrub_runs** — claim_id, run_at, rule_set_version, passed int, warnings int, errors int, result jsonb (per-rule outcome), run_by, overridden_by?, override_reason.
- **claim_transmissions** — claim_id, attempt_no, channel, endpoint_ref, payload_file_id?, nhcx_correlation_id?, nhcx_workflow_id?, request_body jsonb?, response_body jsonb?, http_status, sent_at, status enum(queued/sent/delivered/acknowledged/failed), error, retry_at, operator_id. (This is the evidence trail: "we sent it, here it is, at this second.")
- **claim_queries** — claim_id, query_no, category, raised_at, raised_by (payer user/system), text, attachments jsonb, assigned_to, assigned_role, sla_due_at, replied_at, reply_text, reply_attachments jsonb, replied_by, resulted_in_resubmission bool.
- **claim_status_history** — claim_id, from_status, to_status, actor_id, actor_type enum(staff/payer/system), at, payer_ref, amount_snapshot jsonb, reason, document_file_id. Append-only.
- **claim_write_offs** — claim_id, amount, reason_code, category enum(disallowance_accepted/time_barred/uneconomic_to_pursue/legal/goodwill), requested_by, approval_id (EN-038), approved_by, journal_id (NC-009), at.
- **claim_patient_recoveries** — claim_id, amount, consent_file_id, bill_id (new patient bill), status, at.
- **claim_nhcx_participants** — hospital_id, participant_code, environment enum(sandbox/prod), payer_participant_map jsonb, key_ref (Vault), registered_at, status.
- **claim_regulatory_exports** — type enum(iib/irdai_tat/nhcx_metrics/nha_audit), period, file_id, row_count, generated_by, signed_hash.
- Partitioning: `claim_status_history` and `claim_transmissions` by month (`pg_partman`). RLS on `hospital_id`; PE-008 payer users additionally filtered by `payer_id`. Financial rows are never hard-deleted; retention 8 years minimum (payer contract may require longer).

## 5. Business Rules & Validations
- A claim may be created only from a **finalised** bill with zero open RC-006 charge-capture exceptions for that encounter (or an acknowledged waiver).
- `claimed_amount` = Σ claim_lines.claimed = payer share of the finalised bill, and must be ≤ pre-auth `approved_amount_total` + tolerance (payer-configurable; 0 for schemes). Breach requires an enhancement or an explicit "claiming above approval" acknowledgement that is reported.
- **Scrub errors block** pack generation and submission. Overriding a warning requires a reason and is audited; overriding an error requires `claims.scrub.override` (desk lead) and is reported weekly to finance.
- Claim number series is **gapless** per branch per FY (row-locked); a cancelled/withdrawn claim retains its number.
- A submitted pack is **immutable**; corrections produce a new `claim_packs` version with a diff of the document manifest, and resubmission always references the prior version.
- Resubmission count may not exceed the payer's configured limit; beyond it, only appeal or write-off remain.
- Line-level decisions are mandatory for partial approvals; the sum of line approvals must equal the claim's approved amount (± ₹1 rounding tolerance).
- **Closure equation**: `claimed = settled + tds + disallowed_accepted + written_off + recovered_from_patient` (± ₹1). A claim cannot be closed unless it balances.
- Write-off requires EN-038 approval by amount slab; requester ≠ approver; every write-off carries a reason code so the leakage report can distinguish "payer disallowed" from "we lost the file".
- Patient recovery is permitted only where the policy/contract allows and a signed consent document exists.
- DPDP: submission is blocked without an `insurance_sharing` consent; sensitive-category documents need explicit inclusion consent; the pack manifest is the evidence of exactly what was disclosed.
- NHCX: payloads must be signed and encrypted per HCX spec; correlation ids make retries idempotent; a payer that is not an NHCX participant is routed by the channel table to portal/email automatically.
- Segregation of duties: claim submitter ≠ write-off approver; settlement allocator ≠ settlement poster (EN-002/NC-009).
- Timeliness: submission target = discharge + 48 h (hospital SLA, configurable) and always within the payer's window; the aging clock starts at submission.

## 6. API Surface (`/api/v1/claims`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /claims?status=&payer=&aging=&branch=&q= | worklist | claims.claim.list | – | cursor |
| POST | /claims | create from bill(s) / manual | claims.claim.create | Y (encounter,payer) | – |
| GET/PATCH | /claims/{id} | detail / edit draft | claims.claim.read/update | Y | – |
| GET/PUT | /claims/{id}/lines | claim lines & codes | claims.claim.update | Y | cursor |
| POST | /claims/{id}/scrub | run scrubber | claims.scrub.run | Y | – |
| GET | /claims/{id}/scrub-report | latest scrub result | claims.scrub.run | – | – |
| POST | /claims/{id}/scrub/override | override a warning/error with reason | claims.scrub.override | Y | – |
| GET/POST | /claims/{id}/documents | pack checklist | claims.document.manage | Y | cursor |
| POST | /claims/{id}/pack | generate pack (async job) | claims.pack.generate | Y | – |
| GET | /claims/{id}/pack/download?format=pdf\|zip | download pack | claims.pack.export | – | – |
| POST | /claims/{id}/submit | submit via routed channel | claims.claim.submit | Y | – |
| POST | /claims/bulk-submit | batch submission for one payer | claims.claim.submit | Y | – |
| POST | /claims/{id}/acknowledge | record payer ack/reference | claims.claim.update | Y | – |
| POST | /claims/{id}/queries ; POST /queries/{qid}/reply | deficiency handling | claims.query.manage | Y | cursor |
| POST | /claims/{id}/resubmit | resubmit with new pack version | claims.claim.submit | Y | – |
| POST | /claims/{id}/decision | line-level approval/disallowance | claims.decision.record | Y | – |
| POST | /claims/{id}/appeal | hand to RC-004 appeal workflow | claims.claim.appeal | Y | – |
| POST | /claims/{id}/write-off | request write-off (→ EN-038) | claims.writeoff.request | Y | – |
| POST | /claims/{id}/patient-recovery | raise patient bill for the balance | claims.recovery.create | Y | – |
| POST | /claims/{id}/withdraw | withdraw with reason | claims.claim.withdraw | Y | – |
| GET | /claims/{id}/transmissions | delivery evidence | claims.transmission.read | – | cursor |
| GET | /reports/aging?payer=&bucket= | claim aging | claims.report.read | – | cursor |
| GET | /reports/tat ; /reports/scrub ; /reports/denial-exposure | KPIs | claims.report.read | – | – |
| GET/POST/PATCH | /scrub-rules | rules engine admin | claims.scrub.configure | Y | cursor |
| POST | /nhcx/eligibility ; /nhcx/claim ; /nhcx/communication | NHCX outbound | claims.nhcx.send | Y (correlation id) | – |
| POST | /nhcx/callback | NHCX inbound (signed) | integration.nhcx.callback | Y | – |
| POST | /webhooks/payer/{adapter} | payer status webhook (signed) | integration.claim.callback | Y | – |
| POST | /exports/iib ; /exports/irdai-tat | regulatory extracts | claims.export.regulatory | Y | – |
| GET | /patients/{id}/reimbursement-pack | patient pack (also via PE-001) | claims.pack.export / patient self | – | – |
| GET | /portal/claims (PE-008) | payer-scoped list | claims.portal.read (payer ABAC) | – | cursor |

## 7. Domain Events (outbox)
- `claim.created` {claim_id, encounter, payer, claimed} → RC-005 (AR open), EN-002 desk, NC-009 (AR sub-ledger).
- `claim.scrub.completed` {errors, warnings, score}; `claim.scrub.failed` {rule_codes[]} → RC-004 preventive analytics, desk worklist.
- `claim.pack.generated` {pack_version, pages, checksum}.
- `claim.submitted` {channel, payer_ref, expected_settlement_date} → RC-005 aging clock, PE-001/PE-008, EN-009 patient message.
- `claim.acknowledged`, `claim.query.raised|replied`, `claim.resubmitted`.
- `claim.approved|partially_approved|rejected` {lines[], reason_codes[]} → RC-004, RC-005, NC-009, EN-001.
- `claim.short_settled` {short_amount, reasons[]} → RC-004 dispute/appeal, RC-005.
- `claim.written_off` {amount, reason_code, approval_id} → NC-009 journal, leakage report.
- `claim.closed` {settled, tds, disallowed, written_off}.
- `claim.nhcx.sent|acknowledged|failed` {correlation_id} → EN-017 monitoring.
- `claim.submission.overdue` {days_since_discharge} → desk escalation.
- Consumes: `bill.finalized`, `ip.bill.finalized`, `preauth.final_authorised`, `preauth.approved` (approval cap), `insurance.settlement.matched` (EN-002), `mrd.coding.completed` (NC-003), `denial.rule.published` (RC-004 → new scrub rule), `leakage.exception.open` (RC-006 → block claim creation).

## 8. Screens
- **Claims Worklist** (desktop, dual monitor): tabs *Ready to pack*, *Scrub failed*, *Submitted*, *Queries*, *Overdue (no response)*, *Partially approved*, *Rejected*, *To write-off*, *Closed*. Columns: claim no, patient, payer, discharge date, days since discharge, claimed, approved, aging bucket, channel, last event. Filters by payer/ward/doctor/aging; saved views per user. Shortcuts: `P` pack, `S` submit, `Q` reply query, `D` record decision, `R` resubmit, `W` write-off request, `/` search, `Ctrl+K` palette. Real-time updates from payer webhooks/NHCX callbacks; bulk-select for batch submission.
- **Claim Detail** (desktop, 3-pane): left = patient/policy/pre-auth chain with approved amounts; centre = tabs *Lines* (editable grid: bill item, payer code, claimed, approved, disallowed, reason — inline reason picker), *Coding* (ICD-10/procedure with validation chips), *Documents* (checklist with previews and page counts), *Timeline* (status history with payer references and letters), *Transmissions* (evidence of every send); right = scrub report (grouped by severity with jump-to-fix links) and amount reconciliation panel showing the closure equation live.
- **Scrub Report panel**: red errors first, each with the rule code, plain-language message and a "fix this" deep link (to the missing document, the unmapped line, the expired pre-auth). Override control visible only to authorised roles, with a mandatory reason box.
- **Pack Builder** (desktop): ordered document list with drag-to-reorder, include/exclude toggles, page counts, sensitive-document warnings, template chooser (payer/IRDAI/scheme), preview, Generate (progress bar), then Submit dialog with channel, reference number, AWB or NHCX status.
- **Payer Decision entry** (desktop, fast keyboard entry): paste/enter the payer's settlement letter figures line by line; reason picker with type-ahead over the RC-004 taxonomy; running totals with variance vs claimed; "same reason for all remaining lines" helper.
- **Claim Aging dashboard** (desktop/TV admin dark theme): buckets 0–30/31–60/61–90/91–180/180+ by payer, amount and count; oldest claims list; expected-vs-actual settlement; submission TAT (discharge → submission) histogram; scrub failure Pareto; denial exposure.
- **NHCX Console** (desktop, IT/desk lead): participant status, per-payer routing, message log with correlation ids, retry/DLQ actions, sandbox vs production toggle.
- **Scrub Rules Admin** (desktop): rule list with family/severity/payer scope, expression builder (field, operator, value, message, hint), test-against-recent-claims simulator showing how many of the last 500 claims would fail, enable/disable with effective dates and approval.
- **Patient claim status** (phone, PE-001/OP-020): plain-language stages, expected timeline, reimbursement pack download.
- **Payer view** (PE-008): the payer's own claim queue with document access and query raising.

## 9. Integrations
- **NHCX/HCX** (Phase 11): participant registry, JWE/JWS crypto with keys in Vault, FHIR R4 bundles built via EN-019, correlation-id idempotency, callbacks through EN-026/EN-017 with signature verification and fast-ack; sandbox environment first, with a conformance test suite.
- **Payer/TPA APIs** via EN-017 adapters (per-payer mapping, retry with exponential backoff, DLQ, message log); **payer portals** (manual with evidence capture); **email** (EN-032 with delivery/read tracking); **courier** (AWB register, POD scan).
- **Scheme portals** (RC-007): PMJAY TMS, CGHS, ECHS, ESIC, state schemes.
- **Internal**: OP-005/IP-005 bills, IP-002 discharge summary, NC-003 coding & MRD scans, TR-003 implants, OP-004/OP-008 reports, IP-006 OT notes, RC-003 payer rates, RC-002 pre-auth, RC-004 taxonomy & appeals, RC-005 aging, RC-006 completeness, NC-009 AR/TDS/write-off journals, NC-012 corporate, EN-016 e-sign, EN-039 templates, NC-004 documents.
- **IIB/IRDAI** exports (CSV/XLSX per prescribed layout, signed hash); NHA audit extracts (RC-007).
- Fallbacks: NHCX outage → route to email/portal automatically with a flag; PDF worker outage → queue with alert; payer webhook missing → nightly reconciliation job compares our `submitted` set to payer acknowledgements.

## 10. Reports & Analytics
- **Submission**: discharge → submission TAT by payer/ward/coder; claims not submitted within the hospital SLA; late claims (beyond the payer window) with amount at risk.
- **Aging**: claim aging buckets by payer and by branch, DSO for payer receivables, oldest-10 list, expected vs actual settlement date variance.
- **Quality**: scrub failure Pareto (which rule fails most), scrub override register, first-pass acceptance rate (submitted → approved with no query — the single best RCM health metric), query rate per 100 claims, resubmission rate.
- **Outcome**: approval %, short-payment % and top disallowance reasons, rejection rate by payer/doctor/procedure, recovery after appeal (RC-004), write-off analysis by category, TDS deducted vs 26AS.
- **Financial**: claimed vs approved vs settled vs written-off waterfall by month and payer; payer-wise revenue and realisation %; estimate → pre-auth → claim → settlement variance (four-way, with RC-008).
- Read models: `analytics.mv_claims_aging`, `mv_claims_tat`, `mv_claims_first_pass`, `mv_claims_scrub_pareto`, `mv_claims_realisation` — refreshed every 15 min; dashboards never query `claim_lines` live.

## 11. Notifications
- **Desk**: claim ready to pack (bill finalised), scrub failed with the top error, pack generated, submission failed (channel error), payer query received with due date, no payer response beyond TAT, claim approaching the payer's submission window (3 days left).
- **MRD/coder**: coding query assigned, unspecified-code threshold breached on a claim.
- **Doctor**: medical deficiency query, certificate needed (push, WhatsApp fallback).
- **Finance**: daily submission and aging digest, write-off approvals pending, short-payment exposure above threshold, monthly realisation summary.
- **Patient** (EN-009/EN-032, DLT templates): claim submitted to your insurer, additional documents required, claim settled — nothing payable / balance ₹X payable, reimbursement pack ready to download.
- **IT** (EN-037): NHCX/API failure rate above threshold, DLQ depth, certificate/key expiry.

## 12. Permissions (RBAC keys)
`claims.claim.list|read|create|update|submit|withdraw|appeal` (Claims/Insurance desk) · `claims.claim.update` coding fields also granted to MRD Coder · `claims.scrub.run` (desk, MRD) · `claims.scrub.override` (Desk lead only, audited & reported) · `claims.scrub.configure` (Insurance lead + Finance approval via EN-038) · `claims.document.manage` (desk, MRD, nurse upload subset) · `claims.pack.generate|export` (desk; export is an audited PHI action) · `claims.decision.record` (desk) · `claims.writeoff.request` (desk) / `claims.writeoff.approve` (Finance Manager/Admin, amount-slabbed, requester ≠ approver) · `claims.recovery.create` (desk, requires consent document) · `claims.transmission.read` (desk, IT) · `claims.nhcx.send` (service + desk lead) · `claims.report.read|export` (Finance, Admin, Insurance lead, Auditor) · `claims.export.regulatory` (Finance/Compliance) · `claims.portal.read|respond` (TPA user 62, ABAC `payer_id` scope) · `integration.claim.callback`, `integration.nhcx.callback` (service accounts only).

## 13. Non-functional
- **Volumes** (2000 beds): ~90 payer-funded discharges/day → ~2,000 claims/month, ~24,000/year; average pack 80 pages (range 20–400); 300–600 open claims at any time; settlement advices with up to 500 lines; NHCX messages ≈ 100k/year.
- **Performance**: worklist p95 < 200 ms over 5,000 open claims (aging computed in the read model, not live); claim detail with 120 lines < 300 ms; scrub run over a claim with 150 lines and 40 rules < 500 ms (rules evaluated over a pre-built projection, not by re-querying); pack generation (200 pages, 40 documents) < 60 s async with progress and resumability; bulk submission of 100 claims < 5 min.
- **Storage**: packs and documents in S3 with lifecycle to infrequent-access after 1 year; PDF/A for archival; pack checksums verified on download.
- **Reliability**: no claim may be lost — transmissions are durable, DLQ monitored, daily reconciliation between our `submitted` set and payer acknowledgements; idempotent webhooks (dedupe on payer reference + correlation id).
- **Offline**: not applicable to submission (payer channels need connectivity); document capture on tablets queues locally.
- **Printing**: claim form (payer/IRDAI template), cover letter, itemised bill for payer, courier manifest, patient reimbursement pack.
- **Accessibility/i18n**: forms in English (payer requirement); UI and patient communications multilingual; WCAG 2.2 AA; the decision-entry grid is keyboard-only operable (numeric keypad friendly).
- **Security**: claim documents are PHI — encryption at rest, presigned time-limited URLs, read-audited; NHCX keys in Vault with rotation; payer portal users strictly scoped; exports watermarked with user and timestamp; no PHI in logs or notification bodies.

## 14. Acceptance Criteria
1. Given a finalised IP bill with a payer share of ₹1,80,000, when the bill is finalised, then a draft claim is created within 5 s with a gapless claim number, lines mapped to payer codes, and the pre-auth chain attached.
2. Given an open RC-006 charge-capture exception on the encounter, when claim creation is attempted, then it is blocked with the exception listed, and clearing the exception allows creation.
3. Given a claim whose claimed amount exceeds the cumulative approved amount by more than the payer tolerance, then the scrubber raises an error and submission is blocked until an enhancement is recorded or an authorised acknowledgement is given.
4. Given a claim missing the signed discharge summary, when scrubbing, then a document error is raised with a deep link to the missing document, and pack generation is blocked.
5. Given a scrub warning is overridden, then a reason is mandatory, the override is written to `claim_scrub_runs` and the audit log, and it appears in the weekly override report to finance.
6. Given a pack is generated, when downloaded, then the PDF is bookmarked and page-numbered, contains exactly the documents in the manifest, and its sha256 matches `claims.pack_checksum`.
7. Given a payer routed to NHCX, when the claim is submitted, then a signed and encrypted FHIR `Claim` bundle is sent, a correlation id is stored, and a retry of the same submission does not create a duplicate at the payer.
8. Given the NHCX gateway returns 5xx three times, then the claim is queued to the DLQ, the desk sees "delivery failed", and switching the channel to email submits the same pack without creating a second claim.
9. Given a `ClaimResponse` with line-level adjudication, then each claim line's approved/disallowed amounts and reason codes are populated, the totals reconcile to the response, and RC-004 analytics update.
10. Given a partial approval of ₹1,50,000 against ₹1,80,000 claimed, then the ₹30,000 short payment is itemised by reason, the appeal/dispute/write-off actions are offered, and RC-005 shows the balance in the correct aging bucket.
11. Given a write-off request of ₹30,000 by a desk executive whose slab is ₹10,000, then it routes to the Finance Manager, cannot be approved by the requester, and on approval posts a journal to NC-009 with the reason code.
12. Given a claim where `settled + tds + disallowed_accepted + written_off + recovered = claimed`, when closing, then closure succeeds; given any imbalance, closure is rejected with the difference shown.
13. Given a payer's resubmission limit of 2, when a third resubmission is attempted, then it is blocked and only appeal or write-off remain available.
14. Given a claim not submitted within the payer's window, then it is flagged `late`, submission requires finance approval, and it appears in the amount-at-risk report.
15. Given no `insurance_sharing` consent, when submitting, then submission is blocked; given a psychiatry report in the pack, then explicit inclusion consent is required and recorded in the manifest.
16. Given a TPA portal user, when listing claims, then only their payer's claims are visible and a direct request for another payer's claim returns 404.
17. Given 5,000 open claims, then the worklist loads p95 < 200 ms and aging buckets match a SQL recomputation exactly.
18. Given a denial reason recurs 10 times in a month, then RC-004 proposes a scrub rule, and once approved and published, new claims with that defect fail scrubbing before submission.
19. Given a bill is reopened after submission, then the claim is withdrawn or superseded with a cross-reference, and two live claims for the same encounter/payer can never exist (DB constraint).
20. Given a user without `claims.pack.export`, when downloading a pack, then 403 and an audit entry are recorded.

## 15. Enhancements / Later phases
- From the VIMS sheet (row 135 / proposal RC-001): claim submission, tracking, rejection analysis, resubmission, settlement reconciliation — all core above (settlement matching in EN-002 §3.7).
- Later: **AI-assisted coding** (AI-006 — ICD-10/procedure suggestion from the discharge summary with a confidence score and a human confirm step), **AI document extraction** (AI-003 — read the payer's settlement letter/denial PDF and auto-populate line decisions), **denial-risk prediction** (AI-005 — score a claim before submission and route high-risk claims to a senior reviewer), auto-chase agent for silent payers, e-mail inbox parsing of payer correspondence, **IIB data submission API** when available, DRG/case-mix grouping for bundled payments, claim-level profitability (claim value vs cost of care from NC-008), payer scorecards published to the payers themselves (PE-008), electronic remittance advice (ERA) auto-posting, and blockchain-style tamper-evident pack ledger (hash chain already present via `pack_checksum`).
- (market) EMR-driven claims to reduce rejections and paperless insurance processing (SMART HMIS); claim invoice/receipt creation and payer blacklisting (PCS Prodoc); Ayushman Bharat claim formats pre-configured and empanelment-ready exports (SmartHospital) → RC-007.

## 16. Open Questions for the Hospital
1. Which payers accept portal, email, courier, API or NHCX today? Do you hold NHCX participant credentials (sandbox and production)?
2. Your claim submission SLA after discharge (48 h?), and each payer's submission window and resubmission limit.
3. Who codes the claim — MRD coder, insurance desk or the treating doctor? Do you use ICD-10 today, and to what specificity?
4. Sample claim packs for your top 5 payers (document order and any payer-specific cover formats) so we can seed the pack templates.
5. Your current top 10 denial and short-payment reasons — these become the first scrub rules and the RC-004 taxonomy seed.
6. Write-off approval slabs, reason categories your finance team uses, and how write-offs are shown in the P&L.
7. Under what circumstances do you recover a disallowed amount from the patient, and do you have a consent form for it?
8. Do you courier physical claims? If so, which vendor, and do you need an AWB/dispatch register in the system?
9. TDS: which payers deduct, at what rate, and how do you reconcile with Form 26AS today?
10. Do you submit IIB data today, and in which format? Any IRDAI TAT reporting obligations you already meet manually?
11. For reimbursement patients: what does the pack contain, is there a charge for it, and may the patient download it from the portal?
12. Should the payer's own users get portal access (PE-008), and what should they be allowed to see and do?
