# EN-002 — Insurance / TPA Module (Payer Master, Empanelment, Tariff Mapping, Eligibility, Pre-Auth, Claims, Rejections, Settlement, ROHINI, IRDAI, NHCX hooks)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-002 |
| Phase | 5 (pre-auth/claim pack), 11 (NHCX/IRDAI automation) |
| Priority | P0 |
| Complexity | High |
| Depends on | RC-003 (tariff engine — payer-wise rates), RC-002 (Pre-Authorisation Engine — state machine & forms; EN-002 owns payer/policy master and desk workflow), RC-001 (Claims Management — NHCX submission/tracking), RC-004 (Denial Management), RC-005 (AR follow-up), RC-007 (Government schemes — PMJAY/CGHS/ECHS handled there, EN-002 provides payer master), RC-008 (Cost estimator), OP-005/IP-005 (bills), IP-001 (admission → pre-auth trigger), IP-002 (discharge summary for claim pack), NC-003 (MRD documents), NC-009 (AR ledger), NC-004 (document store), EN-016 (e-sign), EN-032/EN-009 (email/WhatsApp to TPA/patient), PE-008 (TPA portal), EN-011 (ABDM/NHCX identity), EN-038 (approvals), EN-039 (form templates), EN-024 (audit) |
| Feature flag | `module.insurance.enabled` (sub: `insurance.eligibility_api`, `insurance.nhcx`, `insurance.irdai_reports`, `insurance.multi_payer_split`) |
| Primary roles | Insurance / TPA Desk (28), Billing Executive (27), Corporate/B2B Billing (29) |
| Secondary roles | Doctor (treating — pre-auth clinical justification, discharge summary), Nurse (ward — documents), MRD (43), Accountant (46 — settlement recon), Hospital Admin, Patient (portal status), TPA/Insurer User (62 — PE-008), Auditor |
| Regulatory | IRDAI (Health Insurance Regulations 2016 & Master Circular 2024: cashless authorisation ≤ 1 h, final discharge authorisation ≤ 3 h, standard claim forms, 100 % cashless intent), ROHINI (Registry of Hospitals in Network of Insurance) hospital ID, IIB claim data formats, NHCX (National Health Claims Exchange — FHIR R4 claim bundles, HCX protocol) via RC-001, PMJAY/TMS (RC-007), GST on hospital services (exempt healthcare vs taxable), DPDP (policy & medical documents = PHI; consent for sharing with payer), Income-tax TDS u/s 194J on TPA payments (NC-009), NABH AAC/ROM (billing transparency, estimate disclosure) |

## 1. Purpose
EN-002 runs the insurance desk end-to-end: payer/TPA/plan/corporate master with empanelment and contract terms; payer-wise tariff & package mapping (RC-003) with ROHINI/IIB coding; policy capture and eligibility verification at registration/admission; cashless pre-authorisation (RC-002 engine) with queries/enhancements; claim pack generation and submission (portal/email/NHCX via RC-001); rejection & short-payment handling (RC-004); settlement reconciliation against receivables (NC-009); IRDAI/IIB reporting; and denial analytics. It is revenue-critical for the ~40–60 % of IP revenue that flows through payers.

## 2. Users & Jobs-to-be-done
- **Insurance/TPA desk** (desktop, dual monitor, scanner): verify policy at admission, raise pre-auth within 30 min of admission, chase queries, raise enhancements, assemble claim pack at discharge, submit, track, reconcile settlements. 50–200 active cases/day at 2000 beds.
- **Billing executive**: apply payer tariff & non-payable exclusions to the bill, patient co-pay/deductible/non-medical items split, interim bills to TPA.
- **Treating doctor**: sign pre-auth clinical section, discharge summary (IP-002), respond to medical queries (phone/tablet).
- **Ward nurse / MRD**: upload documents (ID, policy card, investigations, OT notes, implant stickers, pharmacy bills).
- **Accountant**: settlement recon, TDS, write-off approvals, TPA-wise outstanding.
- **Admin / Finance head**: denial trends, TPA performance, empanelment renewals.
- **Patient/family**: status on portal/WhatsApp; reimbursement claim pack download.
- **TPA user (PE-008)**: view pre-auth requests, raise queries, upload approvals.

## 3. Core Workflows

### 3.1 Payer, TPA, plan & empanelment master
1. Insurance desk creates **payer** (insurer) → optional **TPA** (administrator servicing that insurer) → **plans/products** (sum insured bands, room-rent caps/proportionate deduction rules, co-pay %, deductibles, exclusions/waiting periods, non-payable list per IRDAI Annexure/standard non-payables) → **corporate** (for group policies; also feeds NC-012) → Event `insurance.payer.created`.
2. **Empanelment**: contract no, valid from/to, MoU document, empanelment type (cashless/reimbursement-only/PPN), agreed tariff sheet ref (RC-003 payer tariff), package list, discount %, credit period days, TDS %, contact matrix (pre-auth desk phone/email/portal URL, claims, grievance), escalation SLA; renewal alerts 90/60/30 days (EN-037) → `insurance.empanelment.expiring`.
3. **ROHINI**: hospital's ROHINI ID stored per branch (`core.branches.rohini_id`); payer-specific hospital IDs stored per empanelment; **ROHINI/IIB code mapping** of services (procedure/package codes) maintained in RC-003 mapping table.
4. Tariff mapping: upload payer tariff sheet (XLSX) → RC-003 mapping wizard: hospital service → payer code/rate → discount % → variance report → effective-dated version; unmapped services flagged for desk (bill items unmapped fall to "self-pay" bucket by rule).

### 3.2 Policy capture & eligibility
1. At OP-001 registration / IP-001 admission, patient selects payer → captures policy no, member id, plan, sum insured, validity, relationship, corporate/employee id, TPA card scan (AI-003 OCR later), consent for sharing PHI with payer (EN-028 ledger).
2. **Eligibility verification**: manual (call/portal, record outcome) or API where available (NHCX coverage-eligibility request in RC-001, insurer/TPA APIs via EN-017 adapters) → status verified/unverified/invalid, remaining SI, room eligibility, waiting-period flags → Event `insurance.eligibility.checked`.
3. Encounter is tagged `payer_type=insurance|corporate|scheme|self`; bill (OP-005/IP-005) switches to payer tariff and credit mode; patient banner shows payer chip + pre-auth status.
4. Multi-payer: primary/secondary payer split (corporate + insurer, insurer + patient) with configurable order-of-benefit and caps (`insurance.multi_payer_split`).

### 3.3 Cashless pre-authorisation (desk view over RC-002)
1. Admission event `ip.admission.created` with insurance payer → **auto-create pre-auth case** with SLA timer (target: submit ≤ 30 min from admission; emergency ≤ 24 h) → desk worklist.
2. Desk opens case → **pre-auth form auto-generated** (IRDAI standard cashless request form / payer-specific template EN-039) pre-filled: demographics, policy, admitting doctor, provisional diagnosis (ICD-10), planned procedure (ROHINI/payer code, package), estimated cost from RC-008 estimator (room rent, ICU days, OT, implants, pharmacy, consumables, professional fees), expected LOS, past history/date of first symptom, MLC flag → doctor signs clinical section (EN-016/eSign or PIN) → documents attached (ID, policy card, investigations, admission note, photo for accident) → **submit** via channel: TPA portal (manual, record ref no), email (EN-032, PDF pack), API/NHCX (RC-001 pre-auth `Claim` use=preauthorization) → status `submitted` → Event `insurance.preauth.submitted`.
3. Status tracking (RC-002 states): `draft → submitted → query_raised → query_replied → approved(amount, validity, room class, remarks) → enhancement_requested → enhancement_approved/partial → denied → cancelled → expired`. Every state change stores payer reference no, actor, timestamp, letter/document; approved amount vs running bill visible on IP-005 & bed board.
4. **Query handling**: query text/attachments logged; assigned to doctor/desk; reply with documents; SLA per query (payer default 24 h; IRDAI 1 h reference for payer decision shown as timer) → `insurance.preauth.query_raised|replied`.
5. **Enhancement**: triggered when running bill reaches configurable % (default 80 %) of approved amount, LOS extension, change of procedure/ICU transfer, implant addition → enhancement request with interim bill and updated clinical notes → `insurance.preauth.enhancement_requested`.
6. **Denial of pre-auth**: reason (RC-004 taxonomy) → options: convert to self-pay (patient counselled, deposit collected NC-001), reimbursement route, appeal; patient notified with estimate.
7. Emergency: treatment starts before approval; case marked emergency; deposit rules per hospital policy; pre-auth submitted within 24 h.

### 3.4 Discharge & final authorisation (cashless)
1. `ip.discharge.initiated` → desk gets **discharge checklist**: final bill draft (payer tariff, non-payables separated), discharge summary (IP-002, signed), all investigation reports, OT notes, implant invoices/stickers (TR-003), pharmacy & consumable bills, pre-auth approval letters, ID proofs, patient-signed claim form & consent, feedback form → **final authorisation request** sent (portal/email/NHCX) with SLA timer (IRDAI: payer decision ≤ 3 h; escalate at 2 h) → `insurance.final_auth.requested`.
2. Payer approves final amount → bill split computed: **payer share** (approved amount), **patient share** (co-pay, non-payables, room-rent proportionate deduction, exclusions, amount above approval, deposit adjustment) → patient pays balance (NC-001) → discharge released → Event `insurance.final_auth.approved`.
3. Discharge held only for patient-share settlement, never for payer delay beyond configured grace (NABH/IRDAI patient-rights rule) — configurable "release on hospital risk" with approval (EN-038).

### 3.5 Claim submission & tracking
1. On discharge with payer share > 0 → **claim** created (RC-001) linked to pre-auth, bill(s), documents → **claim pack generation**: cover letter, claim form (IRDAI Part A/B or payer template), itemised bill with payer codes, discharge summary, reports, prescriptions, implant/pharmacy invoices, pre-auth letters, KYC → single indexed PDF + individual files, ZIP; checksum stored → `insurance.claim.pack_generated`.
2. Submission channel: physical courier (AWB no), portal upload (ref no), email, NHCX (FHIR ClaimBundle via RC-001) → status `submitted`; acknowledgement recorded; **claim TAT clock** starts; credit period per empanelment drives expected settlement date (RC-005 aging).
3. **Reimbursement route**: patient pays full bill (self-pay tariff or payer tariff per policy) → hospital generates reimbursement claim pack (bill, receipts, discharge summary, reports, doctor certificate) → patient submits; hospital tracks optional status; pack downloadable from PE-001.
4. Corporate/credit patients: employer letter/guarantee → bill to corporate account (NC-012); same pack workflow.
5. Claim queries/deficiencies (documents missing, coding clarification) → task to desk/doctor/MRD with SLA → resubmit → `insurance.claim.query_raised|resubmitted`.

### 3.6 Rejection, short-payment & appeals (with RC-004)
1. Payer response: approved full / partial (short payment with deduction reasons per line: non-payable consumables, tariff excess, room-rent proportionate deduction, policy exclusion, documentation) / rejected (coding error, document missing, not covered, pre-existing, fraud suspicion).
2. Desk records reason codes (RC-004 taxonomy mapped to payer wording) → analysis category → action: **resubmission** (fix docs/coding), **appeal/representation** (letter template, doctor certificate), **write-off** (approval matrix by amount, EN-038), **recover from patient** (only where policy permits, patient consent form).
3. Resubmission cycles tracked with limits (payer allows N); appeal escalation to insurer grievance cell / ombudsman reference stored.

### 3.7 Settlement reconciliation
1. Payment received (bank/NEFT/cheque) → advice/UTR captured (or emailed statement parsed via upload template) → **match** to claims by claim no/policy no/amount (auto-match ≥ 95 % confidence, manual otherwise) → per-claim: settled amount, TDS deducted, disallowance, short payment → `insurance.settlement.matched`.
2. Short payment → dispute raised (reason, follow-up date, contact) → resolution: recovered / accepted (write-off with approval) / patient recovery.
3. Posting: NC-009 receives receipt against payer AR, TDS receivable entry (Form 26AS reconciliation), disallowance write-off journals; RC-005 aging updated.
4. Bulk settlement statements (100+ claims per advice) reconciled via grid with auto-suggest; unmatched amounts parked in suspense.

### 3.8 IRDAI / IIB / regulatory reporting
- Data extracts in IIB (Insurance Information Bureau) hospital claim format; IRDAI cashless TAT report (request → decision times), grievance log; NHCX metrics; ROHINI details verification annual reminder. Configurable exports (CSV/XLSX) with signature.

### 3.9 Exceptions
- Policy found invalid post-admission → convert to self-pay with counselling record; pre-auth cancelled.
- Patient upgrades room above eligibility → proportionate deduction estimate shown & consent captured.
- Death/DAMA → claim pack variants (death summary/DAMA form).
- Offline: desk screens require connectivity (payer channels); document capture from tablet queues uploads.

## 4. Data Model (schema `billing`, prefix `ins_`; ROHINI/tariff maps in `mdm`)
- `ins_payers` — id, hospital_id, code, name, type (insurer/tpa/corporate/government_scheme/embassy/other), irdai_reg_no, gstin, pan, address, contacts jsonb, portal_url, api_adapter_key, active.
- `ins_tpas` — id, hospital_id, name, irdai_tpa_licence, contacts, portal_url; `ins_payer_tpa_links` (payer_id, tpa_id, effective range).
- `ins_plans` — id, payer_id, name, product_uin (IRDAI UIN), sum_insured_bands jsonb, room_rent_cap_rule (pct_of_si/fixed/none), icu_cap_rule, copay_pct, deductible, waiting_periods jsonb, exclusions jsonb, non_payable_list_id, network_type (cashless/reimbursement/ppn), effective_from/to.
- `ins_empanelments` — id, hospital_id, branch_id, payer_id, tpa_id, contract_no, valid_from, valid_to, hospital_code_at_payer, rohini_id, tariff_version_id (RC-003), package_list_id, discount_pct, credit_days, tds_pct, contacts_matrix jsonb, sla jsonb (preauth_hours, final_auth_hours, settlement_days), documents[], status (active/expiring/expired/suspended/blacklisted). UNIQUE(hospital_id, branch_id, payer_id, tpa_id, contract_no).
- `ins_non_payable_items` — id, hospital_id/null, list_name (IRDAI standard/payer specific), item_code/service_id, category (consumable/administrative/non_medical), rule.
- `ins_patient_policies` — id, hospital_id, patient_id, payer_id, tpa_id, plan_id, policy_no, member_id, holder_name, relationship, sum_insured, valid_from/to, corporate_id, employee_id, card_file_id, consent_id (EN-028), verified_status, verified_at/by, verification_source, remaining_si, notes. Index (hospital_id, patient_id), (policy_no).
- `ins_eligibility_checks` — policy_id, encounter_id, channel (manual/api/nhcx), request jsonb, response jsonb, result, checked_at/by.
- `ins_cases` — id, hospital_id, branch_id, encounter_id (visit/admission), patient_id, policy_id, payer_id, tpa_id, mode (cashless/reimbursement/corporate_credit/scheme), status, sla_deadlines jsonb, assigned_to, estimate_id (RC-008), approved_amount_total, notes; one per encounter per payer (multi-payer → multiple with priority order).
- `ins_preauths` (RC-002 owns state machine; view here) — case_id, preauth_no (series `PREAUTH`), type (initial/enhancement/final), requested_amount, approved_amount, room_class_approved, valid_till, payer_ref_no, channel, submitted_at, decided_at, status, form_file_id, letter_file_id, doctor_signed_by/at.
- `ins_preauth_queries` — preauth_id, query_no, raised_at, text, attachments[], assigned_to, replied_at, reply_text, reply_attachments[], sla_due_at.
- `ins_claims` (RC-001 owns lifecycle; desk fields) — case_id, claim_no (series `CLAIM`), bill_ids[], claimed_amount, patient_share_amount, submitted_at, channel, courier_awb, payer_ref_no, expected_settlement_date, status (draft/pack_ready/submitted/query/resubmitted/approved/partially_settled/settled/rejected/appealed/written_off/closed), pack_file_id, pack_checksum, resubmission_count.
- `ins_claim_documents` — claim_id/preauth_id, doc_type (enum: id_proof/policy_card/claim_form/discharge_summary/final_bill/investigations/ot_notes/implant_invoice/pharmacy_bill/preauth_letter/consent/other), file_id, source_module, uploaded_by, required (bool), verified (bool).
- `ins_claim_lines` — claim_id, bill_item_id, service_code, payer_code (ROHINI/IIB/package), claimed, approved, disallowed, disallowance_reason_code (RC-004), remarks.
- `ins_settlements` — id, hospital_id, payer_id, advice_no, utr, received_at, gross_amount, tds_amount, net_amount, bank_account_id, statement_file_id, status (unmatched/partially_matched/matched); `ins_settlement_allocations` — settlement_id, claim_id, allocated, tds, disallowed, short_payment, dispute_id, posted_journal_id (NC-009).
- `ins_disputes` — claim_id, amount, reason, raised_at, contact, follow_up_at, status (open/recovered/accepted/patient_recovery/closed), approval_id.
- `ins_rejection_reasons` (RC-004 shared taxonomy) — code, category (coding/documentation/not_covered/tariff/policy/fraud/other), payer_text_map jsonb.
- `ins_regulatory_exports` — type (iib/irdai_tat/nhcx_metrics), period, file_id, generated_by, signed_hash.
- Status history child tables for cases/preauths/claims (actor, from, to, at, reason). All PHI documents in S3 with presigned URLs; audit on read.

## 5. Business Rules & Validations
- A payer bill line uses the effective payer tariff (RC-003) at service date; unmapped services fall to hospital tariff and are flagged `unmapped_for_payer` on the desk worklist (must be resolved before final auth).
- Non-payable items auto-move to patient share; room-rent cap → proportionate deduction estimate = (billed − eligible)/billed applied to configured heads (as per policy rule); shown to patient at admission and discharge (NABH transparency).
- Pre-auth SLA timers: create ≤ 30 min from admission (elective) or ≤ 24 h (emergency); enhancement auto-suggested at 80 % consumption; final auth ≤ 2 h from bill finalisation; overdue → escalation ladder (EN-038: desk lead → finance head).
- Doctor signature (e-sign/PIN + audit) mandatory on clinical section of pre-auth and on discharge summary before pack generation; documents marked `required` per payer template must be present (checklist hard-stop, override with reason by desk lead).
- Claim amount = payer share of finalised bill; cannot exceed approved amount + configurable tolerance without enhancement; claim number series `CLAIM/{BR}/{FY}/{SEQ:6}` gapless.
- Settlement allocation: sum(allocations) ≤ net + tds; TDS % from empanelment; write-off needs approval per amount slab (EN-038); disputes must have follow-up date; patient recovery requires signed consent doc.
- Segregation: claim submitter ≠ write-off approver; settlement poster ≠ recon approver.
- Consent: policy documents shared with payer only with `insurance_sharing` consent purpose recorded (EN-028); DPDP retention: claim docs 8 years (or as per payer contract), then archival.
- Multi-payer: primary must reach decision (approved/denied) before secondary claim; total payer share ≤ bill.
- Immutability: submitted pre-auth/claim forms are versioned; resubmission creates new version referencing prior.

## 6. API Surface (`/api/v1/insurance`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET/POST/PATCH | /payers, /payers/:id ; /tpas ; /plans | masters | insurance.payer.configure | paginated, versioned |
| GET/POST/PATCH | /empanelments, /empanelments/:id ; POST /:id/documents | empanelment | insurance.empanelment.configure | |
| POST | /empanelments/:id/tariff-upload | XLSX → RC-003 mapping job | insurance.tariff.map | async job |
| GET/POST/PATCH | /patients/:patientId/policies | policy capture | insurance.policy.create/update | consent id required |
| POST | /policies/:id/eligibility | run eligibility (manual/API) | insurance.eligibility.check | idempotent per encounter/day |
| GET | /cases?status&payer&ward&sla=overdue | desk worklist | insurance.case.list | cursor |
| POST | /cases | create case (auto from admission) | insurance.case.create | idempotent (encounter, payer) |
| GET/PATCH | /cases/:id ; POST /cases/:id/assign | case detail/assign | insurance.case.read/update | |
| POST | /cases/:id/preauths | create pre-auth (initial/enhancement/final) | insurance.preauth.create | draft |
| POST | /preauths/:id/generate-form | render payer form PDF | insurance.preauth.create | |
| POST | /preauths/:id/sign | doctor sign clinical section | insurance.preauth.sign | e-sign |
| POST | /preauths/:id/submit | submit via channel | insurance.preauth.submit | Idempotency-Key |
| POST | /preauths/:id/status | record payer decision (approve/partial/deny/query) | insurance.preauth.update | |
| POST | /preauths/:id/queries ; POST /queries/:qid/reply | queries | insurance.preauth.update | |
| GET | /encounters/:id/coverage-summary | approved vs running bill, patient share | insurance.case.read | used by IP-005/bed board |
| POST | /claims (from case) ; POST /claims/:id/pack ; GET /claims/:id/pack/download | claim + pack | insurance.claim.create / insurance.claim.export | pack async |
| POST | /claims/:id/submit ; /claims/:id/queries ; /claims/:id/resubmit ; /claims/:id/appeal | lifecycle | insurance.claim.submit / update / appeal | |
| POST | /claims/:id/decision | record approval/partial/rejection lines | insurance.claim.update | |
| POST | /claims/:id/write-off | request write-off | insurance.claim.writeoff.request → EN-038 approve | |
| GET/POST | /settlements ; POST /settlements/:id/allocate ; POST /settlements/:id/post | settlement recon & posting to NC-009 | insurance.settlement.create / allocate / post | post idempotent |
| GET/POST/PATCH | /disputes | short-payment disputes | insurance.dispute.manage | |
| GET | /reimbursement/:encounterId/pack | patient reimbursement pack | insurance.claim.export (staff) / patient self via PE-001 | |
| GET | /reports/denials?by=payer|reason|doctor ; /reports/tat ; /reports/outstanding ; /reports/payer-revenue | analytics | insurance.report.read | MV-backed |
| POST | /regulatory/exports?type=iib|irdai_tat | generate export | insurance.report.export | audited |
| GET | /portal/… (PE-008 scoped endpoints) | TPA user views | insurance.portal.* | payer scope only |

## 7. Domain Events (outbox)
- `insurance.payer.created|updated`, `insurance.empanelment.created|expiring|expired` → EN-037 (renewal), RC-003 (tariff link).
- `insurance.policy.captured|verified`, `insurance.eligibility.checked` → OP-001/IP-001 banner, OP-005/IP-005 tariff switch.
- `insurance.case.created|assigned|closed`.
- `insurance.preauth.created|submitted|query_raised|query_replied|approved|partially_approved|denied|enhancement_requested|expired` → IP-005 (approved amount), IP-001 bed board chip, PE-001 patient status, EN-009 patient WhatsApp, RC-002 mirror.
- `insurance.final_auth.requested|approved|denied` → IP-002 discharge gate, NC-001 patient share collection.
- `insurance.claim.created|pack_generated|submitted|query_raised|resubmitted|approved|partially_approved|rejected|appealed|written_off|closed` → RC-001, RC-004, RC-005, NC-009 AR.
- `insurance.settlement.received|matched|posted`, `insurance.dispute.opened|resolved` → NC-009 journals, RC-005.
- `insurance.sla.breached` → {case, stage, minutes_over} → EN-037 escalation.

## 8. Screens
- **Insurance Desk Worklist** (desktop, dual monitor): tabs Pre-auth pending / Queries / Enhancements due / Final auth / Claims to pack / Submitted / Rejections / Settlements; SLA countdown chips (red < 0), filters payer/ward/doctor; row actions. Shortcuts: `N` new case, `S` submit, `Q` reply query, `U` upload docs, `/` search UHID/policy, `Ctrl+K` palette. Real-time worklist updates via Socket.IO; empty state per tab.
- **Case 360** (desktop): patient banner (payer chip, approved vs consumed gauge), timeline of pre-auth/queries/enhancements, document checklist (drag-drop upload, camera capture from tablet), bill preview split (payer/patient), estimate vs actual, notes, contact log (call/email with timestamps).
- **Pre-auth form editor**: payer template render (EN-039), auto-filled fields, ICD/procedure pickers, estimate builder (RC-008), doctor sign panel, submit channel chooser; `Ctrl+P` PDF.
- **Policy capture** (in OP-001/IP-001 registration; desktop/tablet): payer/TPA/plan pickers, policy no scan (OCR later), consent checkbox, eligibility check button with result card.
- **Claim pack builder**: ordered document list, include/exclude, page count, generate; preview PDF; submission form (channel, ref no, AWB).
- **Rejection & appeal workspace**: line-wise deductions grid, reason coding, action buttons (resubmit/appeal/write-off/patient recovery), letter templates.
- **Settlement reconciliation** (desktop): advice header, upload statement, auto-match grid (claim no, expected, received, TDS, short), bulk accept, dispute creation, post to accounts; `Ctrl+M` auto-match.
- **Payer/Empanelment master** (desktop): payer tree, contract & documents, SLA, contacts, tariff version link, renewal calendar.
- **Denial analytics dashboard** (EN-001 widgets): denial rate by payer, reasons Pareto, doctor-wise success rate, revenue impact, TAT trends.
- **Patient portal/WhatsApp status** (phone): pre-auth status timeline, expected patient share, reimbursement pack download (PE-001).
- **TPA portal** (PE-008): payer-scoped pre-auth/claims list, query raise, approval letter upload.

## 9. Integrations
- Payer channels: manual portal (record refs), email (EN-032 with PDF pack, DPDP-safe encrypted ZIP option), **NHCX/HCX** FHIR bundles (RC-001, EN-011 credentials/gateway), payer/TPA APIs through EN-017 adapters (retry with backoff, DLQ, message log).
- RC-003 tariff mapping & ROHINI/IIB code sets (mdm), RC-008 estimates, RC-004 reason taxonomy, RC-005 aging, NC-009 AR/TDS journals, NC-012 corporate invoicing, EN-016 e-sign, EN-039 form templates (IRDAI standard forms seeded), NC-003 MRD scans, TR-003 implant invoices/UDI stickers, IP-002 discharge summary PDF.
- Bank statement upload (CSV/XLSX templates per bank) for settlement advices; email inbox parsing later (AI-003).

## 10. Reports & Analytics
- Pre-auth TAT (admission→submission, submission→decision), approval ratio, average approved vs requested; claim TAT & aging by payer; denial rate/reasons/doctor-wise; short-payment %, disallowance heads; TPA-wise revenue, outstanding & DSO; empanelment expiry calendar; IIB/IRDAI extracts; reimbursement packs issued. MVs: `analytics.mv_ins_case_tat`, `mv_ins_claims_aging`, `mv_ins_denials`.

## 11. Notifications
- Patient WhatsApp/SMS (EN-009): "Pre-auth submitted", "Approved ₹X", "Query – documents needed", "Final approval; balance payable ₹Y", "Reimbursement pack ready".
- Desk/doctor push (EN-037): SLA due/breach, query assigned, enhancement threshold reached, final auth pending.
- Finance: settlement received unmatched > 3 days, dispute follow-up due, write-off approvals.
- Admin: empanelment expiring 90/60/30 days, payer SLA breach trend.

## 12. Permissions (RBAC keys)
`insurance.payer.configure`, `insurance.empanelment.configure`, `insurance.tariff.map` (Admin, Insurance lead) · `insurance.policy.create/update/read` (Front office, Insurance desk, Billing) · `insurance.eligibility.check` · `insurance.case.list/read/create/update/assign` (Insurance desk; doctors read own patients) · `insurance.preauth.create/submit/update` (Insurance desk) · `insurance.preauth.sign` (Doctor) · `insurance.claim.create/submit/update/appeal/export` (Insurance desk) · `insurance.claim.writeoff.request` (desk) / `insurance.claim.writeoff.approve` (Finance head, amount-slabbed) · `insurance.settlement.create/allocate/post` (Accountant; post ≠ allocate user) · `insurance.dispute.manage` · `insurance.report.read/export` (Admin, Finance, Insurance lead) · `insurance.portal.*` (TPA user, payer-scoped ABAC) · `insurance.document.read` (audited PHI).

## 13. Non-functional
- Volumes: 2000 beds → ~150 admissions/day, ~60 % insured → 90 pre-auths/day, ~300 open cases, 2000 claims/month, settlement advices with up to 500 lines; worklist query p95 < 200 ms; claim pack (60–200 pages) generation < 60 s async with progress.
- Documents: S3 presigned upload direct from browser/tablet camera, virus scan, PDF/A conversion for packs; retention 8 years.
- Availability: desk works during payer channel outages (queue submissions); NHCX retries with DLQ.
- Accessibility/i18n: forms in English (payer requirement) with UI in local languages; currency INR default, multi-currency for embassy/international payers.
- Printing: pre-auth forms, claim cover letters, patient-share estimates (EN-005 laser).

## 14. Acceptance Criteria
1. Given an admission with an insurance payer, when the admission is saved, then an insurance case with pre-auth SLA timer appears in the desk worklist within 5 s.
2. Given a pre-auth form generated, when the doctor has not signed the clinical section, then Submit is disabled and the reason is shown.
3. Given a payer template requiring ID proof and policy card, when either is missing, then pack generation is blocked (override only by desk lead with reason, audited).
4. Given an approved pre-auth of ₹1,00,000, when running bill reaches ₹80,000, then an enhancement task and notification are created automatically.
5. Given a final bill with non-payable consumables and room upgrade, when coverage summary is computed, then patient share = non-payables + proportionate deduction + co-pay + amount above approval, and the split matches the IP-005 bill totals to the paisa.
6. Given final authorisation pending beyond configured grace, when discharge is initiated, then discharge is not blocked by payer delay; only patient share settlement gates it (or hospital-risk release with approval).
7. Given a claim pack generated, when downloaded, then the PDF is indexed, contains all checked documents, and its checksum matches `ins_claims.pack_checksum`.
8. Given a partial approval with line-wise disallowances, when recorded, then each line's disallowance reason maps to an RC-004 code and the denial dashboard updates.
9. Given a settlement advice with 120 lines, when auto-match runs, then lines with unique claim no + amount within ₹1 tolerance are matched automatically and the remainder are listed for manual matching.
10. Given a settlement allocation, when posted, then NC-009 receives receipt, TDS receivable and disallowance journals exactly once (idempotent on re-post).
11. Given a write-off above the desk user's slab, when requested, then it routes to Finance head via EN-038 and cannot be approved by the requester.
12. Given a policy shared with a payer, when no `insurance_sharing` consent exists, then submission is blocked with a prompt to capture consent.
13. Given an empanelment expiring in 30 days, when the nightly job runs, then Admin and Insurance lead receive a notification and the payer shows "expiring" chip.
14. Given a TPA portal user, when listing cases, then only cases of their payer are visible; direct API access to another payer's case returns 404.
15. Given a patient on the portal, when pre-auth is approved, then a WhatsApp status message is sent within 2 min and the portal timeline shows the approval.
16. Given an eligibility API adapter timeout, when checking eligibility, then the desk can record a manual verification and the API attempt is logged with error.

## 15. Enhancements / Later phases
- IRDAI regulatory reporting automation (auto-filed extracts), insurance eligibility verification API (NHCX coverage eligibility, insurer APIs), pre-admission patient cost estimator (RC-008 integration on portal), multi-insurer claim splitting (rules engine), fraud detection analytics (AI-005: outlier LOS/billing patterns), empanelment management portal for payers (PE-008), OCR of policy cards/TPA letters (AI-003), auto-coding assistance (AI-006), settlement email parsing, e-NACH for patient EMI (EN-010), NHCX end-to-end cashless (RC-001) with payer-side status webhooks, IIB data submission API, WhatsApp document collection from patient (market).

## 16. Open Questions for the Hospital
1. List of empanelled insurers/TPAs/corporates with contract documents, tariff sheets, ROHINI ID and payer-specific hospital codes.
2. Which payers accept email/portal vs API/NHCX today? Do you have NHCX participant credentials?
3. Hospital policy on emergency admissions before pre-auth: deposit amount, time to submit, who approves treatment on hospital risk?
4. Non-payable list: IRDAI standard only or payer-specific lists? Who maintains?
5. Discharge policy when final approval is delayed: release on hospital risk after how many hours; approver?
6. Write-off approval slabs and who signs disputes/appeals; TDS rates per payer; bank accounts for settlements.
7. Standard forms in use (IRDAI Part A/B, payer templates) — samples for EN-039.
8. Do you bill insured patients at payer tariff or hospital tariff with payer discount? Room-rent proportionate deduction heads?
9. Reimbursement patients: pack contents and any charge for the pack; patient portal download allowed?
10. Existing denial reason codes and TPA performance reports used by finance today (to seed RC-004 taxonomy and EN-001 KPIs).
