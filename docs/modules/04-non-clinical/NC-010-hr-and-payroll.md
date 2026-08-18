# NC-010 — HR & Payroll (Employee Master, Attendance, Leave, Payroll, PF/ESI/PT/TDS, Loans, F&F, ESS, Credentialing)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-010 |
| Phase | 9 (employee master & credentialing basics needed from Phase 0/1 for user provisioning — EN-007 links users to employees) |
| Priority | P1 |
| Complexity | High |
| Depends on | EN-007 (users/roles provisioning from employee records), NC-029 (Attendance & Biometric — punch capture, device integration; NC-010 consumes attendance days/OT), NC-030 (Duty Roster — shifts, nurse-patient ratio; NC-010 uses shift mapping for attendance/OT), NC-027 (Training & Development — certifications/competency), NC-014 (Staff utility mobile — ESS front-end), NC-009 (payroll journals, statutory dues, TDS 24Q, payments), NC-001 (staff credit/shortage recovery), NC-002 (asset allocations at F&F), NC-004 (HR policies), NC-023 (statutory licences), NC-028 (helpdesk), EN-038 (approvals), EN-016 (e-sign letters), EN-032/EN-009/EN-037 (notifications), EN-024 (audit), NC-011, NC-034 (doctor payouts — variable pay input), EN-041 (multi-branch) |
| Feature flag | `module.hr.enabled` (sub: `hr.payroll`, `hr.ess`, `hr.recruitment`, `hr.appraisal`, `hr.credentialing`, `hr.geo_attendance`, `hr.engagement_survey`, `hr.succession`) |
| Primary roles | HR Executive / HR Manager (47), Payroll Officer (47), Department HODs (5, approvals), Employees (all roles, ESS) |
| Secondary roles | Finance (46, payroll JV/statutory), Hospital/Branch Admin (2/3), Medical Superintendent (4, doctor credentialing/privileging), Nursing Superintendent (22, nurse licences), Auditor (58), IT Admin (56, user provisioning), Security (51, ID cards) |
| Regulatory | Shops & Establishments / Factories (working hours, OT), Code on Wages 2019 & state rules (minimum wages, wage definition ≥ 50 % basic rule when notified), Payment of Wages, EPF & MP Act (12 % employee/employer on ≤ ₹15,000 wage ceiling or full basic per policy, EPS 8.33 %, ECR filing, UAN), ESI Act (0.75 %/3.25 % on gross ≤ ₹21,000; ₹25,000 disabled), Professional Tax (state slabs: e.g. TN/KA/MH/TS/AP/WB), Labour Welfare Fund, Payment of Gratuity Act (15/26 × last drawn × years, ≥ 5 yrs, cap ₹20 lakh), Payment of Bonus Act (8.33 %–20 %, ≤ ₹21,000 eligibility), Maternity Benefit Act (26 weeks), Income-tax §192 TDS (old/new regime, Form 12BB declarations, Form 16 Part A/B, 24Q), Sexual Harassment (POSH) committee records, Clinical Establishments/NABH HRM (credentialing & privileging, licence verification: NMC/State Medical Council registration for doctors, State Nursing Council/INC for nurses, Pharmacy Council, paramedical councils; NABH HRM.4/5), Contract Labour Act (contractors), DPDP (employee data), Equal Remuneration, Apprentices Act |

## 1. Purpose
NC-010 manages the hospital's people from hire to retire: employee master with documents and statutory identifiers, organisation structure, **credentialing & licence expiry tracking for doctors, nurses and allied staff**, attendance consumption (from NC-029/NC-030) with late/early/OT/exception handling, leave management (CL/EL/SL/ML/comp-off/LWP with encashment), salary structures and monthly payroll (earnings, deductions, PF/ESI/PT/LWF/TDS, loans/advances, arrears, bonus, gratuity), bank file & payslips, statutory outputs (PF ECR, ESI, PT returns, Form 16/24Q via NC-009), loans & advances, full & final settlement with no-dues, employee self-service (ESS) through web and NC-014 mobile, recruitment pipeline, appraisal & training links. It provisions users (EN-007) and posts payroll to NC-009.

## 2. Users & Jobs-to-be-done
- **HR executive** (desktop): onboard employees (profile, documents, statutory IDs, bank, structure), transfers/promotions, confirmations, letters, ID cards, licence tracking, exits.
- **Payroll officer** (desktop): maintain salary structures, process monthly payroll (attendance import → gross → deductions → net), review exceptions, generate bank file/payslips/statutory files, arrears, bonus, F&F.
- **HOD/manager** (desktop/phone): approve leave/regularisation/OT/loan requests, view team attendance & roster, appraisal inputs.
- **Employee** (ESS web/NC-014 phone): view/regularise attendance, apply leave, view payslips & YTD, submit IT declarations (12BB) & proofs, reimbursement claims, update contact/bank (approval), download Form 16, letters; doctors/nurses upload renewed licences.
- **Medical/Nursing superintendent**: credentialing review, privileging (doctors' permitted procedures — feeds EN-007 permissions/OT booking), licence expiry actions.
- **Finance**: payroll JV, statutory remittances (NC-009), cost by cost centre (NC-008).
- **Auditor**: statutory registers, payroll audit trail.

## 3. Core Workflows

### 3.1 Employee master & onboarding
1. **HR** creates employee (or converts hired candidate from recruitment) → employee code (`EMP` series), personal (name, DOB, gender, blood group, contacts, emergency contact, address), employment (branch, department, designation, grade, category enum(permanent/probation/contract/consultant/visiting/trainee/outsourced), date of joining, probation end, reporting manager, cost centre NC-008, shift pattern NC-030, weekly off), statutory (PAN, Aadhaar (masked, DPDP), UAN/PF no., ESI IP no., PT state, bank account/IFSC, nominee, previous employer PF), qualifications & experience, documents (photo, ID proofs, certificates, offer/appointment letters, background verification, medical fitness, vaccination (Hep B) for clinical staff) → **credentialing** for clinical categories (3.2) → salary structure assignment (3.5) → **user provisioning** (EN-007: creates login with role template by designation/department, licence-gated) → ID card print (EN-013) → onboarding checklist (policies to acknowledge NC-004, mandatory trainings NC-027, biometric enrolment NC-029, asset issue NC-002) → Event `hr.employee.joined`.
2. Changes (transfer/promotion/confirmation/salary revision/manager change) via effective-dated actions with approvals & letters (EN-039 templates, e-sign EN-016) → history retained → Event `hr.employee.updated`.

### 3.2 Credentialing, licences & privileging (`hr.credentialing`) (market)
1. For doctors: NMC/State Medical Council registration no., council, valid till/renewal, qualifications verification (degree, specialty), experience verification, privileging (procedures/departments approved by credentialing committee, review period), malpractice/insurance, DEA-like narcotics authorisation (NDPS prescriber flag), ACLS/BLS validity; nurses: State Nursing Council/INC registration & renewal (every 5 yrs typically), specialty certifications; pharmacists: State Pharmacy Council; lab/radiology techs: council/AERB RSO certificate; ambulance drivers: licence/badge; all: police verification → **licence expiry engine**: alerts 90/60/30/7 days to employee/HR/HOD/MS; on expiry without renewal → configurable action: warn / block clinical actions (EN-007 permission suspension for prescribing/signing) → renewal upload with verification → Event `hr.licence.expiring|expired|renewed`.
2. Privileging feeds OT booking (IP-006: surgeon can book only privileged procedures) and EN-007 permissions; NABH HRM evidence report.

### 3.3 Attendance (consuming NC-029/NC-030)
1. NC-029 delivers daily punches (biometric/face/mobile geo-fenced `hr.geo_attendance`) mapped to NC-030 shifts → **System** computes per day: status enum(present/absent/half_day/weekly_off/holiday/leave/on_duty/tour/wfh), late minutes, early-out minutes, worked hours, OT hours (beyond shift + threshold, rounding rules), night shift allowance count, missing punch → **exceptions** to employee (ESS regularisation request with reason: forgot punch/official duty/permission) → manager approval → attendance finalised for the month (cut-off e.g. 25th; lock) → **payable days** (present + paid leave + weekly offs/holidays − LWP) → payroll input → Event `hr.attendance.month.locked`.
2. Late/early policies: grace minutes, N lates = half-day deduction; permission hours; OT approval workflow (pre-approved or post-facto by HOD, caps); comp-off credit for holiday/weekly-off work.

### 3.4 Leave management
1. Leave types & policies (config per category/grade): CL (e.g. 12/yr, non-carry), EL/PL (accrual monthly, carry-forward cap, encashment rules), SL (with medical certificate > 2 days), ML (26 weeks per Maternity Benefit Act), PL paternity, comp-off (expiry 90 days), LWP, study leave, sabbatical, special (bereavement/marriage), holidays list per branch/state (restricted holidays choice) → **Employee** applies (dates, half-day, reason, handover, attachment) → checks: balance, min notice, sandwich rule, max consecutive, blackout dates, roster conflict (NC-030 nurse-patient ratio warning) → manager approval (EN-038; auto-escalate 48 h) → balance update; cancellation/modification flows; **encashment** at year-end/F&F per policy (taxable computation) → year-end carry-forward/lapse job → Event `hr.leave.applied|approved|rejected|cancelled|encashed`.

### 3.5 Salary structure & payroll (`hr.payroll`)
1. **Structures**: components (earnings: Basic, DA, HRA, conveyance, special allowance, medical, LTA, night/shift allowance, OT, on-call, incentives (NC-034 for doctors), arrears, bonus; deductions: PF (employee), ESI, PT, TDS, LWF, loan EMI, salary advance, canteen (NC-033), staff credit (NC-001/OP-005), shortage recovery, insurance premium, other; employer contributions: PF, EPS, EDLI/admin charges, ESI, gratuity provision, NPS) with formulas (% of basic/gross, slabs, fixed, attendance-prorated flag, taxability, statutory wage inclusion), CTC templates per grade; effective-dated revisions with arrears auto-computation.
2. **Monthly run**: lock attendance → import payable days/OT/night counts → variable inputs (incentives, reimbursements approved, deductions from other modules) → compute gross → **PF** (12 % employee on PF wages ≤ ₹15,000 ceiling or full per policy; employer 12 % split EPS 8.33 % (≤ ₹1,250) + EPF; VPF) → **ESI** (0.75 %/3.25 % if gross ≤ ₹21,000; contribution period rules Apr–Sep/Oct–Mar continuity) → **PT** (state slab by work location; half-yearly/annual variants e.g. TN) → **LWF** → **TDS** (annualised projection: regime choice, declarations 12BB (HRA, 80C, 80D, home loan, NPS), previous employer income, perquisites, exemptions HRA/LTA; monthly TDS = (annual tax − TDS so far)/remaining months; year-end proof verification adjustments) → loans/advances EMI → net pay → **exception review** (negative net, > X % change vs last month, missing bank, new joiners/exits pro-rata) → approval (payroll officer → HR manager → finance) → **payslips** (PDF, WhatsApp/email/ESS), **bank file** (bank template/NEFT bulk via NC-009 payment run), **payroll JV** to NC-009 (Dr salary components by cost centre / Cr net payable, PF/ESI/PT/TDS payable, loans) → statutory files: **PF ECR** (txt per EPFO format with UAN, wages, contributions), **ESI** contribution file, **PT return** data, TDS 24Q data (NC-009) → Event `payroll.posted`. Off-cycle runs (arrears, bonus, F&F) supported; hold salary; payroll lock per month.
3. **Bonus** (Payment of Bonus Act): eligibility (≤ ₹21,000 wages), 8.33 % min on ₹7,000/min wage, computed annually; **gratuity** provisioning & payment at exit (≥ 5 years; formula 15/26 × last basic+DA × years; cap ₹20 lakh, taxable beyond exemption).
4. Contract/outsourced staff: attendance-based billing to contractor (with Contract Labour compliance docs) — payroll not run but registers maintained.

### 3.6 Loans & advances
- Request (type: salary advance/festival advance/personal loan/medical) → eligibility (tenure, max multiple of salary, existing loans) → approval → disbursement (NC-009 payment or in salary) → EMI schedule (interest, perquisite valuation for concessional loans §17(2)) → auto-deduction; prepayment/closure; F&F recovery of balance → Event `hr.loan.approved|disbursed|closed`.

### 3.7 Full & Final settlement
- Resignation (ESS)/termination/retirement/death → notice period computation (shortfall recovery/waiver), last working day → **no-dues** workflow (departments: IT (EN-007 access revoke), stores/assets (NC-002 allocations), library, finance (loans/advances/staff credit), HR (ID card), hostel/quarters, medical records for doctors (NC-003 deficiencies pending)) → F&F computation: salary till LWD, leave encashment (EL balance × per-day), gratuity, bonus pro-rata, reimbursements, deductions (notice shortfall, loans, recoveries, shortages NC-001), TDS → approval → payment (NC-009) → letters (relieving/experience, Form 16 at year-end) → user deactivation (EN-007) → Event `hr.employee.exited`.

### 3.8 Employee self-service (`hr.ess`) & mobile (NC-014)
- Profile & documents, attendance view/regularisation, leave apply/status/balances, holiday calendar, payslips/YTD/Form 16, IT declaration & proof upload, reimbursement claims, loans, letters/certificates request, licence renewal upload, announcements/policies (NC-004), helpdesk tickets (NC-028), team calendar & shift swap (NC-030), internal job postings (recruitment).

### 3.9 Recruitment (`hr.recruitment`)
- Manpower requisition (position, budget NC-022, justification) → approval → job posting (internal/external, careers page EN-012) → candidates (resume parsing later AI-003) → pipeline stages (screen/interview/offer/BGV/medical) with interview scheduling & scorecards → offer letter (e-sign) → onboarding conversion.

### 3.10 Appraisal, engagement, succession (`hr.appraisal`, `hr.engagement_survey`, `hr.succession`)
- Appraisal cycles (goals/KRAs, self, manager, 360° peers/subordinates), rating normalisation, increment/promotion recommendations → salary revision; training needs → NC-027 competency mapping; engagement surveys (anonymous, pulse); succession plans for critical roles (readiness, development plans).

### 3.11 Exceptions & edge cases
1. Employee re-hired → new employee id linked to previous (service continuity for gratuity per policy), UAN reuse, PF transfer.
2. Mid-month joiner/exit → pro-rata by calendar/working days (config); ESI/PF applicability from first day.
3. Retro salary revision effective 3 months back → arrears computed with statutory recalculation (PF/ESI/PT/TDS) and shown as separate component in the current payslip.
4. Attendance unlock after payroll computed (before approval) → payroll auto-marked stale, must recompute; after approval → off-cycle correction.
5. Employee on long leave/maternity → payroll continues per rules; ESI benefits period tracked; loans EMI hold option.
6. Death in service → F&F to nominee, gratuity full irrespective of tenure, EDLI claim assist, insurance.
7. Deputation to another branch (EN-041) → cost centre change; payroll entity may differ (inter-branch JV).
8. Doctors on retainer/consultant contract (194J TDS, no PF/ESI) → separate contract payroll run with TDS 194J via NC-009; NC-034 payouts feed variable component.
9. Biometric outage → manual attendance upload with HR approval and audit; punches later reconciled.

### 3.12 Configuration defaults (seed)
- Leave types CL 12/EL 15 (accrual 1.25/month, carry 45, encash at exit)/SL 10/ML 182 days/PL 15/comp-off 90-day expiry/LWP; grace 10 min; 3 lates = half day; OT beyond 30 min after shift, approval required; PF ceiling ₹15,000 (12 %/EPS 8.33 % ≤ ₹1,250); ESI ₹21,000 (0.75 %/3.25 %); PT slabs per state table; TDS new regime default (employee may opt old); payroll cut-off 25th, pay date 1st; loan max 3× net, tenure ≤ 24 months; notice 30/60/90 by grade; credential types & block-on-expiry (NMC/State council: block; nursing council: block; BLS/ACLS: warn); series `EMP`, `PAYRUN`, `LOAN`, `EXIT`.

## 4. Data Model (schema `hr`)
- **employees**: id, hospital_id, branch_id, emp_code, user_id? (EN-007), first/middle/last name, dob, gender, blood_group, marital_status, photo_file_id, contacts jsonb, address jsonb, emergency_contact jsonb, category enum, department_id, designation_id, grade_id, cost_centre_id, reporting_manager_id, functional_manager_id?, doj, probation_end, confirmation_date, dol?, exit_reason?, status enum(active/probation/notice/exited/suspended/long_leave), pan, aadhaar_masked, uan, pf_no, esi_no, pt_state, bank jsonb (masked), nominee jsonb, is_clinical bool, clinical_category enum(doctor/nurse/pharmacist/technician/therapist/other)?, shift_pattern_id (NC-030), weekly_off jsonb, biometric_id (NC-029), version. UNIQUE (hospital_id, emp_code); INDEX (hospital_id, branch_id, department_id, status).
- **employee_actions** (effective-dated): employee_id, action enum(join/confirm/transfer/promote/salary_revise/manager_change/suspend/reinstate/resign/terminate/retire), effective_date, from jsonb, to jsonb, approved_by, letter_file_id.
- **employee_documents**: employee_id, type enum(id_proof/address/education/experience/offer/appointment/bgv/medical/vaccination/licence/other), file_id, verified_by, verified_at, expiry_date?.
- **designations**, **grades**, **departments** (EN-027 link), **holiday_calendars** (branch/state, dates, restricted flag).
- **credentials**: id, employee_id, type enum(nmc_reg/smc_reg/nursing_council/pharmacy_council/aerb_rso/paramedical_council/driving_licence/bls_acls/other), registration_no, issuing_body, issued_on, valid_till, document_file_id, verified_by, verified_at, verification_method enum(portal/letter/self), status enum(valid/expiring/expired/suspended), block_on_expiry bool. INDEX (valid_till), (employee_id).
- **privileges**: employee_id, department_id, procedure/service_id or category, granted_by (committee), granted_on, review_due, status.
- **attendance_days**: employee_id, date, shift_id, status enum, in_at, out_at, worked_minutes, late_minutes, early_minutes, ot_minutes, ot_approved_minutes, night_shift bool, source enum(biometric/mobile/manual/roster), exception_flags text[], regularisation_id?, locked bool. UNIQUE (employee_id, date). Partitioned by month.
- **attendance_regularisations**: employee_id, date, requested_status/in/out, reason, attachment, approver_id, status.
- **attendance_month_locks**: branch_id, month, locked_by, locked_at, payable_days_snapshot.
- **leave_types**: code, name, paid bool, accrual_rule jsonb, carry_forward_cap, encashable bool, max_consecutive, min_notice_days, requires_document_after_days, sandwich_rule bool, gender/category applicability, active.
- **leave_balances**: employee_id, leave_type_id, year, opening, accrued, taken, encashed, lapsed, balance; **leave_applications**: employee_id, leave_type_id, from, to, half_day enum(none/first/second), days, reason, attachment, handover_to, status enum(applied/approved/rejected/cancelled/withdrawn), approver_id, decided_at, roster_conflict bool.
- **salary_components**: code, name, type enum(earning/deduction/employer_contribution/reimbursement), formula jsonb, taxable bool, pf_wage bool, esi_wage bool, pt_wage bool, prorate_by_attendance bool, display_order; **salary_structures**: employee_id, effective_from, template_id?, components jsonb [{code, amount/formula}], ctc_annual, approved_by; **structure_templates** per grade.
- **payroll_runs**: id, hospital_id, branch_id?, period (YYYY-MM), type enum(regular/arrears/bonus/fnf/offcycle), status enum(draft/computed/reviewed/approved/paid/posted/locked), attendance_lock_id, computed_at, approved_by[], bank_file_id, journal_id (NC-009), payment_run_id (NC-009), exceptions jsonb; **payslips**: run_id, employee_id, payable_days, lop_days, earnings jsonb, deductions jsonb, employer_contrib jsonb, gross, total_deductions, net_pay, tds_amount, pf_wages, esi_wages, pt_amount, bank jsonb, pdf_file_id, hold bool, hold_reason, sent_at. UNIQUE (run_id, employee_id).
- **statutory_files**: run_id, type enum(pf_ecr/esi/pt_return/lwf/tds_24q_data), file_id, generated_at, uploaded_ack?; **statutory_config**: pf_ceiling, pf_on_full_basic bool, esi_threshold, pt_slabs by state (effective-dated), lwf rules, bonus params, gratuity params.
- **it_declarations**: employee_id, fy, regime enum(old/new), sections jsonb (80C/80D/HRA rent/home loan/NPS/other), proofs (files, verified_by, approved_amounts), previous_employer jsonb, status; **tds_computations**: employee_id, fy, month, projected_income, exemptions, deductions, tax, cess, tds_till_date, tds_this_month.
- **loans**: employee_id, type, principal, interest_rate, tenure_months, emi, disbursed_on, outstanding, status; **loan_schedule** (loan_id, month, emi, principal_part, interest_part, paid bool, payslip_id).
- **reimbursement_claims**: employee_id, type (medical/LTA/travel/telephone/uniform), amount, bills[], approved_amount, status, paid_in_run_id.
- **exits**: employee_id, type enum(resignation/termination/retirement/death/absconding/contract_end), notice_date, lwd, notice_shortfall_days, waiver bool, no_dues jsonb [{dept, status, cleared_by, remarks}], fnf jsonb (components), fnf_run_id, status enum(initiated/no_dues/computed/approved/paid/closed), exit_interview jsonb.
- **requisitions**, **job_postings**, **candidates**, **applications** (stage, scorecards, offer_id), **offers**; **appraisal_cycles**, **appraisals** (goals, ratings, comments, final_rating, increment_pct); **surveys**, **survey_responses** (anonymous); **succession_plans**.
- **letters** (type, template_id, employee_id, generated_file_id, esign_id, issued_at).
- RLS; salary/PAN/Aadhaar/bank fields encrypted at rest (pgcrypto/app-level); payslips immutable once run approved; attendance days locked per month.

## 5. Business Rules & Validations
- Employee code unique per hospital; PAN format check & uniqueness (warn); UAN/ESI mandatory when applicable (PF wage ≤ ceiling or policy; ESI when gross ≤ threshold at contribution-period start); bank account required before payroll.
- Clinical staff cannot be marked active for clinical roles without valid credentials (`block_on_expiry` types); expiry action policy per credential type; renewal requires document & verification; privileging enforced by IP-006/EN-007.
- Attendance: computed from NC-029 punches vs NC-030 shift; grace/late rules; regularisation limit per month (config); manager approval required; month lock before payroll; unlocking requires HR manager + audit and re-run of payroll if already computed (only before approval).
- Leave: balance check (negative not allowed unless LWP), accrual monthly (pro-rata for joiners/exits), carry-forward caps and lapse at year-end, ML per Act (eligibility 80 days worked), comp-off expiry, sandwich rule config, approval by reporting manager (fallback HOD), roster conflict warns/blocks per policy (nurse ratio); cancellation before start (after start with manager approval → LWP reversal).
- Payroll: run only after attendance lock; statutory calculations per config effective for the period; PF wage ceiling & EPS split; ESI continuity in contribution period even if gross rises above threshold; PT by work location state; TDS annualised with regime; net pay ≥ 0 (else carry-forward deduction); component changes effective-dated with arrears; approvals SoD (payroll officer computes ≠ HR manager approves ≠ finance releases payment); payslips immutable after approval; re-run allowed only before approval; off-cycle for corrections.
- Loans: eligibility & caps; EMI ≤ X % of net (config); recovery in F&F.
- F&F only after all no-dues cleared or waived with approval; gratuity eligibility ≥ 5 years (or death/disablement); notice shortfall recovery per policy; user deactivated on LWD 23:59 (or immediately for termination).
- Data privacy: Aadhaar masked, salary visibility limited (own + HR/payroll/finance roles), exports audited; DPDP consent for employee data processing recorded at onboarding.
- Retention: payroll registers 8 years (IT), PF/ESI records per Acts (permanent recommended), employee files 3 years post-exit min (policy longer).

## 6. API Surface (`/api/v1/hr`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | /employees, /employees/{id} ; POST /employees/{id}/actions ; GET /employees/{id}/history | master | hr.employee.list/read/create/update | Y | cursor |
| POST | /employees/{id}/documents ; /employees/{id}/provision-user | docs, user | hr.employee.update / hr.user.provision | Y | – |
| GET/POST/PATCH | /credentials ; POST /credentials/{id}/(verify|renew) ; GET /credentials/expiring?days= | licences | hr.credential.manage / .verify | Y | cursor |
| GET/POST | /privileges | privileging | hr.privilege.manage (MS) | Y | cursor |
| GET | /attendance?employee=&month= ; POST /attendance/regularisations ; POST /regularisations/{id}/(approve|reject) ; POST /attendance/lock ; POST /attendance/unlock | attendance | hr.attendance.read (own/team/all) / .regularise / .approve / .lock | Y | cursor |
| POST | /attendance/manual (HR override) | manual entry | hr.attendance.override | Y | – |
| GET/POST/PATCH | /leave/types ; GET /leave/balances/{employee} ; POST /leave/applications ; POST /leave/applications/{id}/(approve|reject|cancel) ; POST /leave/encash ; POST /leave/year-end | leave | hr.leave.configure / .read / .apply / .approve / .encash | Y | cursor |
| GET/POST | /payroll/components, /payroll/templates ; POST /payroll/structures ; GET /payroll/structures/{employee} | structures | hr.payroll.configure / hr.payroll.structure.manage | Y | cursor |
| POST | /payroll/runs ; POST /payroll/runs/{id}/(compute|review|approve|generate-bank-file|generate-payslips|post|lock|reopen) ; GET /payroll/runs/{id}/exceptions | payroll | hr.payroll.run / .approve / .post | Y | cursor |
| GET | /payroll/payslips/{employee}?period= ; GET /payslips/{id}/pdf | payslips | hr.payslip.read (own) / hr.payroll.read | – | – |
| POST | /payroll/runs/{id}/statutory/(pf-ecr|esi|pt|lwf|tds-24q) ; GET /statutory/files | statutory | hr.statutory.generate | Y | cursor |
| GET/PUT | /statutory/config | PF/ESI/PT slabs | hr.statutory.configure | Y | – |
| GET/POST | /it-declarations/{employee}/{fy} ; POST /it-declarations/{id}/proofs ; POST /proofs/{id}/verify ; GET /tds/computation/{employee}/{fy} | TDS | hr.tds.declare (own) / hr.tds.verify | Y | – |
| POST | /loans ; POST /loans/{id}/(approve|disburse|prepay|close) | loans | hr.loan.apply (own) / .approve / .disburse | Y | cursor |
| POST | /reimbursements ; POST /reimbursements/{id}/(approve|reject) | claims | hr.reimbursement.apply / .approve | Y | cursor |
| POST | /exits ; POST /exits/{id}/no-dues/{dept} ; POST /exits/{id}/(compute-fnf|approve|pay|close) | F&F | hr.exit.initiate (own resign) / hr.exit.manage / hr.fnf.approve | Y | cursor |
| POST | /letters/generate | letters | hr.letter.generate | Y | – |
| GET/POST | /recruitment/requisitions, /postings, /candidates, /applications/{id}/stage, /offers | recruitment | hr.recruitment.manage | Y | cursor |
| GET/POST | /appraisals/cycles, /appraisals/{id}/(self|manager|peer|finalise) | appraisal | hr.appraisal.manage / .participate | Y | cursor |
| GET/POST | /surveys ; POST /surveys/{id}/respond | engagement | hr.survey.manage / .respond | Y | – |
| GET | /ess/me/(profile|attendance|leave|payslips|declarations|loans|letters|team) | ESS aggregate | hr.ess.self | – | – |
| GET | /reports/(headcount|attrition|attendance|leave|payroll-register|statutory|ctc|licence-expiry|overtime|contractor) | reports | hr.report.read | – | – |
| POST | /import/(employees|attendance|opening-leave|structures) | migration | hr.import | Y | – |

## 7. Domain Events (outbox)
- `hr.employee.joined|updated|transferred|exited|suspended` {employee_id, changes} → EN-007 (provision/roles/deactivate), NC-030 (roster pool), NC-029 (biometric enrol), NC-002 (assets), NC-004 (mandatory reads), NC-027 (inductions), NC-008 (cost centre), NC-014, NC-011.
- `hr.licence.expiring|expired|renewed` {employee_id, credential_type, valid_till} → EN-007 (permission suspension per policy), MS/HOD notifications, NC-015 (HRM indicator), IP-006 (privileging), NC-023.
- `hr.attendance.month.locked` {branch, month} → payroll; `hr.attendance.exception` → employee/manager.
- `hr.leave.applied|approved|rejected|cancelled` {employee, dates} → NC-030 (roster update), manager, NC-014.
- `payroll.computed|approved|posted` {run_id, period, totals, cost_centre_split} → NC-009 (JV, payment run, 24Q data), NC-008 (staff cost), NC-034 (doctor incentive lines consumed), NC-011.
- `payroll.statutory.computed` {pf, esi, pt, tds} → NC-009 statutory dues, NC-023 calendar.
- `hr.loan.approved|disbursed|closed`, `hr.reimbursement.approved` → NC-009.
- `hr.exit.initiated` → NC-002 (asset return), EN-007 (access schedule), NC-001 (staff credit), NC-003 (doctor pending records), IT; `hr.fnf.settled` → NC-009, EN-007.
- `hr.candidate.hired` → onboarding.
- Consumes: `attendance.punch.recorded|day.computed` (NC-029), `roster.published|shift.swapped` (NC-030), `training.completed|certification.expiring` (NC-027), `payout.approved` (NC-034 doctor variable pay), `cash.shift.closed` (NC-001 shortage recovery flags), `finance.payment.made` (salary/F&F paid), `asset.allocation.returned` (NC-002), `ticket.resolved` (NC-028), `user.deactivated` (EN-007).

## 8. Screens (UI)
- **HR dashboard** — desktop: headcount by dept/category, joiners/exits, attrition, licence expiries (red list), leave today, pending approvals, payroll status; realtime.
- **Employee 360°** — desktop: tabs profile/employment/actions/documents/credentials/attendance/leave/salary/loans/appraisals/letters; `E` edit, `Ctrl+P` print ID.
- **Credentialing console** (MS/Nursing Supt) — desktop: expiring list, verification queue, privileging matrix; bulk reminders.
- **Attendance console** — desktop: monthly grid (employee × day) with colour codes, exceptions filter, regularisation approvals, OT approvals, lock/unlock; team view for managers (phone).
- **Leave** — ESS (web/phone): balances, calendar, apply (date picker with holidays/roster), status; manager inbox (approve/reject with one tap, push).
- **Payroll workbench** — desktop: run wizard (attendance → inputs → compute → exceptions → review → approve → outputs), variance vs last month, employee drill-down, payslip preview, bank file & statutory downloads, JV preview; `Ctrl+R` recompute.
- **IT declaration & proofs** — ESS + HR verification queue.
- **Loans/reimbursements** — ESS + approvals.
- **Exit & F&F** — desktop: no-dues board (departments status), F&F computation sheet, approvals, letters.
- **Recruitment pipeline** — kanban; **Appraisal** forms; **Survey** builder/results; **Org chart** (ltree).
- **ESS home** (web + NC-014 phone): quick actions (punch via geo, apply leave, payslip, declare IT, raise ticket), announcements.
- Offline: ESS read cache (payslips, balances); leave apply queues; approvals require online.

## 9. Integrations
- NC-029 biometric/face/mobile attendance; NC-030 roster; NC-009 payroll JV/payment/24Q/statutory dues; banks (salary file templates/H2H via NC-009); EPFO ECR format (v2 txt), ESIC contribution upload format, state PT portals (data), TRACES (Form 16 Part A import) & Form 16 Part B generation, Form 12BB; EN-007 provisioning/SSO; EN-016 e-sign letters; EN-039 letter templates; EN-013 ID cards; NC-027 LMS; NC-014 mobile; NC-034 doctor payouts; NC-033 canteen deductions; NC-002 assets; NC-004 policies; NC-028 tickets; EN-012 careers page; council verification portals (NMC/State councils — manual/URL capture, API where available).

## 10. Reports & Analytics
- Headcount & demographics, joiners/exits/attrition, vacancy vs sanctioned strength (nurse-bed ratio for NABH), attendance & absenteeism, late/OT analysis, leave liability (EL balance valuation), payroll register (component-wise), CTC/cost by department & cost centre, statutory registers (PF/ESI/PT/LWF/bonus/gratuity/maternity), TDS summaries, loan outstanding, licence expiry compliance, training compliance (NC-027), contractor manpower, appraisal distribution, engagement scores, gender pay parity. Read models: `analytics.hr_headcount_daily`, `analytics.hr_attendance_monthly`, `analytics.hr_payroll_monthly`, `analytics.hr_licence_status`.

## 11. Notifications
- Employee: leave/regularisation decisions, payslip ready, IT proof deadlines, licence expiry (90/60/30/7), loan EMI, birthday/anniversary (optional), announcements (NC-014).
- Manager/HOD: pending approvals (push, escalation), team licence expiries, attendance exceptions summary.
- HR/Payroll: attendance lock reminders, payroll milestones, statutory due dates, credential expiries, probation confirmations due, contract renewals.
- MS: doctor licence expiries/blocks; Finance: payroll approved/JV; IT: joiners/exits (provisioning).

## 12. Permissions (RBAC keys)
`hr.employee.list/read/create/update/export`, `hr.user.provision`, `hr.credential.manage/verify`, `hr.privilege.manage`, `hr.attendance.read/regularise/approve/lock/override`, `hr.leave.configure/read/apply/approve/encash`, `hr.payroll.configure`, `hr.payroll.structure.manage`, `hr.payroll.run/approve/post/read`, `hr.payslip.read` (own), `hr.statutory.generate/configure`, `hr.tds.declare/verify`, `hr.loan.apply/approve/disburse`, `hr.reimbursement.apply/approve`, `hr.exit.initiate/manage`, `hr.fnf.approve`, `hr.letter.generate`, `hr.recruitment.manage`, `hr.appraisal.manage/participate`, `hr.survey.manage/respond`, `hr.ess.self`, `hr.report.read`, `hr.import`. ABAC: `self_only` (ESS), `own_team_only` (managers), `own_department_only` (HOD), salary visibility restricted to payroll/HR manager/finance; SoD compute ≠ approve ≠ pay.

## 13. Non-functional
- Volumes: 6,000–10,000 employees per 2000-bed group, 300k attendance days/month, payroll compute for 10k employees < 3 min, payslip PDFs 10k in < 15 min (worker), ECR file generation < 1 min; ESS p95 < 300 ms; leave approvals realtime push.
- Security: HR data class; field-level encryption (PAN/Aadhaar/bank/salary), masked display, 2FA for payroll roles, audit on all salary/statutory changes; DPDP purpose limitation; RLS.
- Offline: ESS caches; mobile punch (NC-029) queues; payroll online only.
- Printing: payslips, Form 16, letters, ID cards (EN-013), registers; i18n payslips (English + regional); WCAG 2.2 AA.

## 14. Acceptance Criteria
1. Given HR creates a nurse with State Nursing Council registration valid till next month, then a user is provisioned with the Nurse—Ward template, and 30-day expiry alert reaches the nurse, HOD and Nursing Superintendent.
2. Given a doctor's NMC registration expires with `block_on_expiry` policy, then EN-007 suspends prescribing/sign permissions the next day and MS is notified; uploading a verified renewal restores them.
3. Given punches 09:12 in / 17:58 out for a 09:00–18:00 shift with 10-min grace, then attendance shows late 2 min (beyond grace), early 2 min, and after 3 such lates in the month a half-day deduction rule applies per config.
4. Given a missing out-punch, when the employee regularises with reason and manager approves, then the day becomes present and appears in payable days after lock.
5. Given EL balance 4 and application for 6 days without LWP option, then rejected with balance error; with LWP allowed, 2 days become LWP after approval and roster is updated.
6. Given ML application by an eligible female employee for 26 weeks, then approved days do not deduct any other balance and payroll pays per Act.
7. Given basic ₹20,000 with PF ceiling policy, then employee PF = ₹1,800 (12 % of 15,000), employer EPS ₹1,250, EPF ₹550; with "PF on full basic" policy PF = ₹2,400.
8. Given gross ₹20,500 in April, then ESI deducted 0.75 %; when gross rises to ₹23,000 in June, ESI continues till September (contribution period) and stops from October.
9. Given an employee in Karnataka with gross ₹30,000, then PT ₹200/month per state slab; a Tamil Nadu employee gets half-yearly PT per slab.
10. Given IT declaration under old regime with HRA and 80C proofs verified, then monthly TDS equals (annual tax − TDS paid)/remaining months and Form 16 Part B matches the annual computation.
11. Given payroll computed by officer A, then approval by A is refused; after HR manager approval, payslips are immutable, a bank file and JV to NC-009 are generated with cost-centre split, and PF ECR text validates against EPFO format.
12. Given a payroll exception (net pay negative due to loan EMI), then the run flags the employee and requires resolution (EMI deferral) before approval.
13. Given a resignation with 60-day notice served 30 days, then F&F shows notice shortfall recovery unless waived; F&F approval is blocked while assets are pending return (NC-002) or loans outstanding are not recovered.
14. Given an employee with 6 years service exits, then gratuity = 15/26 × (last basic+DA) × 6 is computed and included in F&F with tax exemption applied.
15. Given an ESS user, when accessing another employee's payslip via API, then 403 and audit entry.
16. Given a manager on phone receives a leave request push, when approving offline, then the action queues and completes on reconnect with idempotency; balances update once.

## 15. Enhancements / Later phases
- From VIMS sheet: employee self-service portal (`hr.ess`, Phase 9 web + NC-014 mobile), recruitment pipeline tracker (`hr.recruitment`, Phase 9), training & competency mapping (NC-027 link, Phase 9), 360° performance appraisal (`hr.appraisal`, Phase 9/11), engagement survey module (`hr.engagement_survey`, Phase 11), succession planning (`hr.succession`, Phase 11).
- (market) HR planning & budgeting, contract hiring group salaries, user-defined formula components & rounding settings, provisions/perks, appraisal-linked increments, exit interviews, geo-fenced/face attendance (NC-029), shift swap marketplace (NC-030), duty roster analytics, resume parsing (AI-003), chat-based HR assistant (AI-001), NABH HRM evidence packs (credentialing, training, appraisal), employee wellness (PE-005 for staff), background verification API integrations.

## 16. Open Questions for the Hospital
1. Employee categories/headcount per branch, existing HRMS/payroll data (structures, balances, loans) for migration and cut-over month?
2. Salary components and formulas per grade; PF on ceiling or full basic; VPF; ESI applicability; PT states; LWF; bonus/gratuity policies?
3. Attendance rules: shifts, grace, late penalties, OT eligibility & rates, comp-off; biometric devices (NC-029) and mobile geo-attendance sites?
4. Leave policy details per category (entitlements, accrual, carry-forward, encashment) and holiday lists per branch/state?
5. Credentialing scope: which councils/certificates tracked, block-on-expiry policy, privileging committee process?
6. TDS handling: regime default, proof verification timelines, Form 16 issuance process (in-house/CA)?
7. Approval matrices (leave, loans, OT, payroll release) and payroll calendar (cut-off, pay date)?
8. Bank(s) for salary and file formats; payslip delivery channels (WhatsApp/email/ESS)?
9. Contract/outsourced staff handling (agency billing vs payroll)?
10. Recruitment/appraisal/survey needs at go-live vs later?
