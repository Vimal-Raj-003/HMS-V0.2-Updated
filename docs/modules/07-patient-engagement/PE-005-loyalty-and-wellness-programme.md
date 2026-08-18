# PE-005 — Loyalty & Wellness Programme (Points & Tier Engine, Health Goals & Wearables, Rewards Catalogue, Annual Check-Up Reminders, Patient Referral Rewards, Redemption at Billing, Programme P&L, Regulatory Guardrails)

| Field | Value |
|---|---|
| Domain | Patient Engagement |
| Module ID | PE-005 |
| Phase | 10 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | PE-001/OP-020 (member surface: wallet, goals, rewards), OP-005/IP-005 (earn events from billed & collected amounts; **redemption at billing** as a discount/credit line), NC-001 (counter redemption), EN-010 (gateway credits/refunds where a reward is monetary), RC-003 (rewards priced as rate plans/packages, never ad-hoc discounts), OP-014 (annual health-check packages — the core wellness product), OP-013 (immunisation due), PE-002 (reminder/recall engine — PE-005 supplies the *occasion*, PE-002 the delivery), PE-003 (wellness education), EN-009/EN-032/EN-037 (messages, consent-aware), EN-028 (separate programme consent; marketing consent kept distinct), NC-026 (campaigns & segments — PE-005 owns the points/tier engine that `crm.loyalty` uses), NC-012/PE-006 (corporate wellness variants), NC-009 (deferred-revenue liability for unredeemed points, GST treatment of discounts/vouchers), NC-034 (**never** clinician incentives — hard boundary), NC-021 (reward vendors), EN-042 (wearable/home-device ingestion, later), EN-024 (audit), NC-011/EN-001 (analytics) |
| Feature flag | `module.loyalty.enabled` (sub: `loyalty.points`, `loyalty.tiers`, `loyalty.rewards_catalogue`, `loyalty.health_goals`, `loyalty.wearables`, `loyalty.patient_referral`, `loyalty.corporate_tieup`) — all default OFF; each is a commercial and regulatory decision |
| Primary roles | Patient / Member (59), Marketing / CRM Executive (55), Programme Manager (custom role, Marketing/Finance family) |
| Secondary roles | Cashier (26) & Billing Executive (27) — redemption at the counter, Front office (24) — enrolment, Finance Manager (46) — liability, P&L and approvals, Health check-up coordinator (OP-014), Dietician/Physio (39/40 — goal content), Hospital Admin (2), Privacy Officer (57), Auditor (58) |
| Regulatory | **NMC Professional Conduct Regulations (Code of Ethics 2002 §6.4 / RMP Regulations 2023)** — **no commission, cut practice or inducement to or from a registered medical practitioner for referrals**: PE-005 may reward *patients* for personal referrals but must make clinician referral rewards structurally impossible (NC-034 boundary); **Clinical Establishments Act / MCI position & state PC-PNDT and ART rules** — no inducement may be attached to a diagnostic or clinical service where the law or the hospital's ethics policy prohibits it (e.g. no reward tied to a scan, a scheme-covered service, or a service under PC-PNDT/ART); **Drugs and Magic Remedies Act 1954 & ASCI** — wellness offers may not claim cure or guarantee outcomes; **DPDP Act 2023 & Rules 2025** — loyalty profiling is a distinct purpose needing separate consent; wearable and goal data are health data; children may not be enrolled or profiled; withdrawal must be as easy as joining; **TRAI TCCCPR** — programme offers are **promotional** (DLT promotional templates, DND scrubbing, 10:00–21:00) whereas health-check *due* reminders may be service category — the two must never be merged in one message; **GST** — treatment of vouchers, points redemption and discounts on invoices (discount must be shown on the tax invoice per §15(3); vouchers are a separate supply question — CA sign-off required); **Ind AS 115** — points create a **contract liability (deferred revenue)** that must be recognised, not treated as free marketing; **Income-tax §194R** (benefits/perquisites) where reward value crosses thresholds; **PMJAY/scheme rules** — no inducement or reward to scheme beneficiaries (RC-007 zero-cash regime); **Consumer Protection Act 2019** — programme terms must be clear, not unilaterally revocable to the member's detriment without notice |

## 1. Purpose
PE-005 runs a health-first loyalty and wellness programme: members earn points for the behaviours the hospital actually wants (completing an annual health check, closing a care gap, attending a follow-up, meeting a goal, referring a family member), rise through tiers with meaningful non-clinical benefits, set and track health goals (later with wearable data), receive annual check-up and screening reminders, and redeem points at billing against **wellness and non-clinical** services — with hard regulatory guardrails that prevent it becoming a kickback scheme, a scheme-beneficiary inducement, or an unrecognised balance-sheet liability.

## 2. Users & Jobs-to-be-done
- **Member (patient/family)**: understand their points and tier in one glance, know what to do next for their health, book the annual check-up they are being reminded about, redeem points without an argument at the counter, and leave the programme cleanly if they wish.
- **Programme manager**: design earn and burn rules, price the catalogue, watch the liability and the margin, run the annual check-up campaign, prove the programme returns more than it costs.
- **Cashier / billing executive**: apply a redemption in seconds with a clear audit trail and no discretion (the system decides eligibility, not the counter).
- **Finance manager**: see the deferred-revenue liability, the breakage, the GST treatment and the programme P&L; approve rule changes and high-value redemptions.
- **Marketing**: use tiers and cohorts as segments (through NC-026, consent-checked) without touching clinical data.
- **Privacy Officer**: evidence that loyalty profiling has its own consent and that health-goal/wearable data is not repurposed.

## 3. Core Workflows

### 3.1 Enrolment
1. Opt-in from PE-001/OP-020, the front desk, a kiosk or a health-check booking. Requires a **separate DPDP consent** naming the purpose (loyalty profiling and programme communications), distinct from care and from marketing consent, with a plain-language summary of the terms and a one-tap exit.
2. Member number issued; the household may be linked (family points pooling, if enabled) with each adult's own consent. **Under-18s are not enrolled** and are never profiled; a parent may hold points that fund a child's wellness service.
3. **Ineligibility rules** are enforced at enrolment and at every earn/redeem: scheme beneficiaries (RC-007) for scheme-covered episodes, staff where the hospital's HR policy excludes them, and any patient category the hospital's ethics policy excludes.

### 3.2 Earn rules (`loyalty.points`)
- Earn events are **configured, versioned and approved** (Finance + Marketing + MS for anything clinical-adjacent). Two families, deliberately separated:
  - **Health-behaviour earns** (the ones the hospital should prefer): annual health check completed (OP-014), preventive screening done, immunisation taken (OP-013), follow-up attended (PE-002), care gap closed (HbA1c done, retinal screening done), goal streak achieved, education completed with quiz passed (PE-003), feedback survey completed (EN-030), blood donation (IP-007).
  - **Spend-based earns**: points per ₹100 of **collected** (not merely billed) amount on eligible service categories. Exclusions are the point: **no points on** scheme-covered episodes, insurance-paid portions where the payer contract forbids inducements, implants and high-cost consumables (pass-through), pharmacy where price control applies (hospital's choice), diagnostics if the hospital's ethics policy excludes inducement on investigations, and any service under PC-PNDT/ART restrictions.
- Points post on the **collection** event with a maturity delay (default 7 days) so refunds and cancellations claw back cleanly; reversal is automatic on refund/credit note.
- Caps: per transaction, per month, per member per year; anti-gaming checks (split billing to multiply points, self-referral loops).

### 3.3 Tiers (`loyalty.tiers`)
- Tiers (e.g. Blue → Silver → Gold) qualified on a rolling 12-month window by points earned *or* by health-behaviour milestones (a member who completes their annual check and closes their care gaps can reach a tier without spending — a deliberate design choice that keeps the programme health-first). Tier benefits are **non-clinical**: priority appointment slots within fairness rules, dedicated helpline, lounge/valet, free follow-up-visit administrative fees, discounted health-check packages (priced via RC-003 plans), extended report validity, complimentary diet or physio consultation where clinically appropriate. **Clinical priority in emergencies, ICU beds, OT slots or triage is never a tier benefit** — this is a hard, tested rule.
- Tier review monthly with grace, downgrade notice, and a clear statement of what changes.

### 3.4 Health goals & wearables (`loyalty.health_goals`, `loyalty.wearables`)
- Goals (steps, weight, BP logging, medication adherence streak, smoking-cessation days, sleep) are set by the member, or suggested by a clinician for a chronic cohort (PE-002). Progress is self-entered or, later, synced from wearables/home devices via EN-042 (Google Fit/Apple Health/BLE BP monitors and glucometers).
- **Guardrails**: goals are motivational, not diagnostic; wearable data is labelled patient-generated and never mixed into validated clinical results; abnormal self-reported readings (e.g. BP > 180/110, glucose < 54 mg/dL) trigger a **clinical safety message and a care-team task**, not a points award; no reward is contingent on a *clinical outcome* (rewarding "HbA1c < 7" penalises the sickest patients and is excluded by policy — reward the *action* of testing, not the result).

### 3.5 Rewards catalogue & redemption (`loyalty.rewards_catalogue`)
1. Catalogue items: health-check package upgrades, wellness services (diet consultation, physiotherapy assessment, yoga/fitness sessions), pharmacy OTC/wellness vouchers where legally permissible, non-clinical services (room upgrade on a planned admission, attendant meal, parking, lounge), partner offers (gym, optical, nutrition — vendors managed in NC-021), and charity donation of points (a popular, liability-clean option).
2. **What may never be redeemed against**: emergency care, ICU, surgery, implants, blood products, scheme-covered services, insurance co-pay where the payer forbids it, narcotics/prescription drugs, and anything that would function as an inducement for a clinical decision. The catalogue's eligibility matrix is enforced server-side at billing.
3. **Redemption at billing**: at OP-005/IP-005 the cashier sees the member's available points and eligible items; redemption converts points to a **discount/credit line on the invoice** at the configured conversion rate, shown transparently on the tax invoice (GST discount treatment per §15(3)), with an idempotent points debit inside the same transaction as the bill posting — a redemption can never be applied twice or debited without a corresponding bill line.
4. Voucher issue (where used) has a code, validity, single-use enforcement and a vendor settlement path.

### 3.6 Annual check-up & care-gap reminders
- The programme owns the *occasion* ("your annual health check is due on 12 Aug, last done 11 Aug last year; your tier includes 15 % off package X"), PE-002 owns delivery. Critically, **clinical due reminders (service category) and promotional offers (promotional category) are separate messages on separate DLT template types** — merging them is a TRAI violation and also destroys the clinical credibility of the reminder. Care-gap reminders for chronic members are generated from PE-002 cohorts and never carry an offer.

### 3.7 Patient referral rewards (`loyalty.patient_referral`)
- A member may refer a friend or family member and earn points when the referee completes a first paid, eligible visit. Guardrails, all system-enforced: referrer must be a **patient, never a clinician or hospital employee** (checked against HR and HPR/NMC registries where available); rewards are points, not cash; caps per member per year; no rewards for referrals into emergency, scheme-covered or PC-PNDT/ART-restricted services; referee consent is required before their visit is attributed; and the whole ledger is auditable. Any referral involving a registered medical practitioner is routed to NC-034/PE-007's compliance path and is **not** rewardable here.

### 3.8 Programme economics & liability
- Every point issued creates a **deferred-revenue liability** at the configured redemption value (Ind AS 115), posted to NC-009 monthly with a breakage estimate reviewed by finance; redemption releases it. The programme P&L shows: cost of rewards redeemed, liability movement, incremental revenue from members vs a matched non-member cohort, health-check conversion uplift, retention/repeat-visit rate, and net contribution. A programme that cannot show this after two quarters should be paused — the module reports the truth rather than a vanity "points issued" number.

### 3.9 Exceptions
- Refund/cancellation of an earning transaction → automatic points clawback; if points were already redeemed, the shortfall becomes a negative balance settled per policy (never a surprise charge to the patient).
- Member deceased → account frozen, no messages, points lapse or transfer to a linked family member per policy.
- Consent withdrawn → earning and messaging stop; the balance is honoured for the configured grace period and then lapses with notice.
- Scheme beneficiary episode → earning and redemption both blocked for that episode with a clear explanation.
- Programme closure or rule change to the member's detriment → advance notice per the published terms; existing points honoured for the notice period.
- Suspected gaming (split bills, referral rings) → account flagged, earning paused pending review, with a documented appeal path.

## 4. Data Model (schema `engage`, prefix `loy_`)
- **loy_programmes** — id, hospital_id, name, currency_of_points, earn_conversion jsonb, redeem_value_per_point numeric(10,4), expiry_policy jsonb (months, rolling/annual, lapse notice days), terms_version, terms_file_id, status enum(draft/active/paused/closed), effective_from, approved_by (Finance + Marketing + MS), audit cols.
- **loy_members** — id, hospital_id, patient_id, account_id (PE-001), member_no, programme_id, enrolled_at, consent_id (EN-028), status enum(active/paused/suspended/left/frozen), tier_id, tier_since, tier_review_at, points_balance int, points_lifetime int, points_expiring_next jsonb, household_id?, exclusion_reason enum(scheme_beneficiary/staff_policy/under_18/clinician/other)?, left_at, audit cols. UNIQUE(hospital_id, patient_id).
- **loy_tiers** — id, programme_id, code, name, sequence, qualify_points_12m, qualify_behaviours jsonb (e.g. annual_check_completed + 2 care gaps closed), benefits jsonb (non-clinical only; validated against a blocked-benefit list), grace_days, downgrade_notice_days.
- **loy_earn_rules** — id, programme_id, code, family enum(health_behaviour/spend), trigger enum(health_check_completed/screening_done/immunisation_given/followup_attended/care_gap_closed/goal_streak/education_completed/feedback_submitted/blood_donated/payment_collected/referral_converted), criteria jsonb, points_formula jsonb (fixed or per ₹100 collected), eligible_service_categories text[], excluded_categories text[] (scheme/insurance_paid/implants/pharmacy/diagnostics per policy), caps jsonb (per_txn, per_month, per_year), maturity_days smallint default 7, active, version, effective range, approved_by.
- **loy_points_ledger** (append-only, partitioned monthly) — id, hospital_id, member_id, entry_type enum(earn/redeem/expire/adjust/clawback/transfer/lapse), points int (signed), rule_id?, source_type enum(bill/payment/event/referral/goal/manual), source_ref_id, bill_item_id?, matured_at?, expires_at?, balance_after int, reason, actor_id, approval_id?, idempotency_key, created_at. UNIQUE(hospital_id, idempotency_key).
- **loy_rewards** — id, programme_id, code, name, type enum(service_package/service_discount/wellness_service/voucher/partner_offer/upgrade/charity_donation), points_cost, cash_top_up?, linked_service_id?/package_id?, rate_plan_id (RC-003), eligibility_matrix jsonb (allowed payer types, excluded service categories, tier minimum, once_per_year etc.), stock/quota?, vendor_id (NC-021)?, validity_days, terms, status, approved_by.
- **loy_redemptions** — id, member_id, reward_id, points_debited, cash_component, bill_id?, bill_item_id?, invoice_id?, voucher_code_hash?, status enum(reserved/applied/cancelled/expired/settled), redeemed_at, redeemed_by (cashier), branch_id, reversal_of?, vendor_settlement_ref?.
- **loy_goals** — id, member_id, goal_type enum(steps/weight/bp_logging/glucose_logging/medication_streak/smoking_free_days/sleep/activity_minutes), target, unit, period, set_by enum(member/clinician), cohort_id?, start_date, end_date, status enum(active/achieved/missed/abandoned), streak_days, last_entry_at.
- **loy_goal_entries** — goal_id, member_id, entry_date, value, source enum(self/wearable/device/staff), device_ref? (EN-042), abnormal_flag bool, clinical_task_id? (raised when out of safe range). Partitioned monthly; **labelled patient-generated, never merged into clinical results**.
- **loy_referrals** — id, referrer_member_id, referee_patient_id?, referee_contact_hash, referral_code, shared_at, channel, status enum(shared/registered/visited/converted/rewarded/rejected), first_visit_encounter_id?, converted_at, points_awarded, rejection_reason enum(referrer_is_clinician/staff/scheme_service/restricted_service/duplicate/consent_missing/cap_exceeded)?, compliance_checked_by.
- **loy_liability_periods** — programme_id, period, points_outstanding, liability_amount, breakage_pct, breakage_basis, journal_id (NC-009), computed_at, approved_by.
- **loy_campaign_links** — campaign_id (NC-026), programme_segment jsonb, members_targeted, consent_filtered_out, launched_at (proves consent filtering happened).
- Read models: `analytics.mv_loy_membership`, `mv_loy_earn_burn`, `mv_loy_liability`, `mv_loy_programme_pl`, `mv_loy_health_outcomes` (check-up completion, care-gap closure among members vs matched non-members).
- RLS on `hospital_id`; goal entries and care-gap data are PHI (read-audited); ledger is append-only with idempotency. Retention: ledger 8 years (financial), goals 3 years or per consent.

## 5. Business Rules & Validations
- **Hard prohibitions (system-enforced, tested):** no points earned or redeemed on **scheme-covered** episodes (RC-007); no reward, point or benefit may ever reach a **registered medical practitioner or hospital employee** for a referral (checked against HR/NMC; violations route to compliance, never to the ledger); no redemption against emergency care, ICU, surgery, implants, blood products, prescription drugs or narcotics; no reward contingent on a **clinical outcome** or on choosing a particular investigation where the ethics policy prohibits inducement; no tier benefit may affect clinical priority, triage, bed allocation or OT scheduling.
- **Children** are not enrolled or profiled; family pooling operates only between consenting adults.
- Earning is on **collected** amounts with a maturity delay; refunds and credit notes automatically claw back, and clawback may drive a negative balance which is settled per the published terms (never billed as a surprise).
- **Idempotency** on every ledger entry (`idempotency_key`); the ledger is append-only — corrections are compensating entries with a reason and, above a threshold, an approval.
- Redemption debits points and posts the bill discount **in one transaction**; a failure rolls back both. Redemption eligibility is evaluated server-side from the reward's eligibility matrix — the counter has no discretion.
- Points expiry follows the published policy with a lapse notice (default 30 days before) — silent expiry is a consumer-protection problem.
- **Message category separation**: clinical due reminders are service templates; programme offers are promotional templates requiring marketing consent and DND scrubbing, sent 10:00–21:00. The system rejects any template that mixes both.
- **Accounting**: points issued create a deferred-revenue liability at the configured value; monthly liability and breakage are computed, approved and posted to NC-009; redemption discounts appear on the tax invoice per GST §15(3); vouchers follow the CA-approved treatment; §194R thresholds are monitored for high-value rewards.
- Programme rule changes require Finance + Marketing approval (and MS where clinical-adjacent), are versioned, and take effect prospectively with member notice.
- Anti-gaming: caps, split-bill detection (multiple invoices, same patient, same day, just under a cap), referral-ring detection (circular or clustered referrals), and a documented review/appeal process before any suspension.
- Consent withdrawal stops earning and messaging immediately; the balance is honoured for the grace period then lapses with notice.

## 6. API Surface (`/api/v1/loyalty`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /enrol ; POST /leave | join/leave with consent | loyalty.member.self | Y | – |
| GET | /me | balance, tier, expiring points, goals | loyalty.member.self | – | – |
| GET | /members?tier=&status= ; GET /members/{id} | staff view | loyalty.member.read | – | cursor |
| GET | /members/{id}/ledger | points statement | loyalty.ledger.read / member self | – | cursor |
| POST | /points/earn | internal earn posting (event-driven) | loyalty.points.post (service) | Y | – |
| POST | /points/adjust | manual adjustment with reason | loyalty.points.adjust (approval) | Y | – |
| GET | /rewards?tier=&type= | catalogue (eligibility-filtered) | loyalty.reward.read | – | cursor |
| POST | /redemptions/quote | check eligibility & points cost for a bill | loyalty.redeem.quote | – | – |
| POST | /redemptions | redeem at billing (atomic with bill line) | loyalty.redeem.apply | Y | – |
| POST | /redemptions/{id}/cancel | reverse a redemption | loyalty.redeem.apply | Y | – |
| GET/POST/PATCH | /rewards (admin) ; /earn-rules ; /tiers | programme configuration | loyalty.programme.configure | Y | cursor |
| POST | /earn-rules/{id}/simulate | projected points & cost | loyalty.programme.configure | Y | – |
| GET/POST | /goals ; POST /goals/{id}/entries | health goals | loyalty.goal.manage / member self | Y | cursor |
| POST | /wearables/sync | device/app data ingestion (EN-042) | loyalty.wearable.sync | Y | – |
| POST | /referrals ; GET /referrals?status= | patient referral | loyalty.referral.create / .read | Y | cursor |
| POST | /referrals/{id}/verify | compliance check before reward | loyalty.referral.verify | Y | – |
| GET | /reminders/due?type=annual_check | occasions for PE-002 | loyalty.reminder.read | – | cursor |
| POST | /liability/run?period= ; POST /liability/{id}/post | deferred revenue to NC-009 | loyalty.liability.run / .post | Y | – |
| GET | /reports/earn-burn ; /reports/liability ; /reports/programme-pl ; /reports/health-impact | analytics | loyalty.report.read | – | – |

## 7. Domain Events (outbox)
- `loyalty.member.enrolled|left|suspended|frozen` → PE-001, NC-026 segments (consent-filtered).
- `loyalty.points.earned|matured|clawed_back|expired|adjusted` {points, rule, balance_after} → member notification, NC-009 liability accrual.
- `loyalty.tier.upgraded|downgraded` {from, to} → member notification, benefit activation.
- `loyalty.redemption.applied|cancelled` {reward, points, bill_id} → OP-005/IP-005 invoice line, NC-009 liability release, vendor settlement (NC-021).
- `loyalty.goal.set|achieved|missed`, `loyalty.goal.abnormal_reading` {value, threshold} → **care-team task (clinical safety, not a reward event)**.
- `loyalty.referral.shared|converted|rewarded|rejected` {reason} → compliance log; rejection reason `referrer_is_clinician` raises a compliance alert.
- `loyalty.reminder.due` {type: annual_check/screening/immunisation} → **PE-002** (delivery), never sent directly by PE-005.
- `loyalty.liability.computed|posted` {period, amount, breakage} → NC-009, finance dashboard.
- `loyalty.rule.changed` {version, approvers} → member notice job.
- Consumes: `payment.received` (earn on collection), `billing.refund.processed` / `credit_note.issued` (clawback), `healthcheck.completed` (OP-014), `immunisation.given` (OP-013), `followup.attended` (PE-002), `education.consumed` (PE-003), `feedback.submitted` (EN-030), `blood.donation.completed` (IP-007), `scheme.case.created` (block earning), `patient.deceased` (freeze), `consent.withdrawn`.

## 8. Screens
- **Member wallet** (phone, PE-001/OP-020): points balance with the next-tier progress bar and what is expiring when; "your next best action" card (annual check due, care gap open, goal streak); goals with simple progress rings; rewards catalogue filtered to what they can actually redeem; statement; terms; leave programme (one tap, honest about consequences).
- **Rewards catalogue** (phone/desktop): cards with points cost, eligibility note ("cannot be used for emergency or insurance-covered services"), validity, and a Reserve action that generates the redemption for use at billing.
- **Goals** (phone): set/track, manual entry, wearable connect (`loyalty.wearables`), streaks, and an explicit note that this is wellness tracking, not medical monitoring, with what to do if a reading is abnormal.
- **Cashier redemption panel** (desktop, inside OP-005/IP-005 billing): member chip with balance, eligible rewards for *this* bill, one-key apply (`F6`), the discount line appearing on the invoice with the points debited, and a clear ineligibility message when blocked (scheme/insurance/excluded category) — the cashier never has to argue or improvise.
- **Programme Admin** (desktop): earn rules with simulation ("this rule would issue 1.2 M points/month costing ₹6 lakh"), tiers and benefits (with the blocked-benefit validator), catalogue with eligibility matrix, terms versioning and member-notice scheduling, approval trail.
- **Referral console** (member phone + staff desktop): share a code, track status, compliance flags; staff view shows rejected referrals and the reason (with clinician-referral attempts escalated to compliance).
- **Programme P&L dashboard** (desktop, finance/marketing): points issued vs redeemed vs expired, **liability and breakage**, cost of rewards, incremental revenue vs a matched non-member cohort, health-check conversion uplift, retention, net contribution, and a plain verdict on whether the programme is worth running.
- **Health impact view** (desktop, quality/marketing): annual-check completion, care-gap closure and follow-up attendance among members vs matched non-members — the honest justification for a *health* loyalty programme.
- All member screens WCAG 2.2 AA, multilingual, plain-language; the terms are readable, not a wall of legalese.

## 9. Integrations
- **OP-005/IP-005/NC-001** (earn on collection; redemption as an invoice discount line, atomic), **RC-003** (reward pricing as rate plans/packages — never ad-hoc discounts), **OP-014/OP-013** (health-check and immunisation occasions), **PE-002** (all reminder delivery), **PE-003** (wellness content), **EN-028** (programme consent), **EN-009/EN-032/EN-037** (messages, promotional vs service separation), **NC-026** (campaigns using tier/behaviour segments, consent-filtered), **NC-009** (deferred-revenue liability, breakage, GST treatment), **NC-021** (reward vendors and settlement), **EN-042** (wearables/home devices, later), **PE-006/NC-012** (corporate wellness variants), **EN-024** (audit).
- Hard non-integration: **NC-034 (doctor payouts) must never consume loyalty or referral data**, and no PE-005 event may create a clinician-directed benefit — enforced by contract tests, not by convention.

## 10. Reports & Analytics
- Membership: enrolments, active rate, churn, tier distribution, consent withdrawals.
- Earn/burn: points issued by rule, redeemed by reward, expired (breakage %), average balance, redemption rate — the four numbers that describe a loyalty programme's health.
- **Liability**: outstanding points value by period, breakage assumption and its back-testing, journal postings.
- **Programme P&L**: reward cost, operational cost, incremental revenue vs matched cohort, ROI, cost per incremental visit.
- **Health impact**: annual health-check completion, screening and immunisation uptake, care-gap closure, follow-up attendance, chronic-cohort retention — members vs matched non-members.
- Referral: shared, converted, reward cost per conversion, rejections by reason (with clinician-referral attempts reported separately to compliance).
- Compliance: blocked earn/redeem attempts by reason (scheme, excluded service, clinician referral), rule-change approvals, member notices sent.

## 11. Notifications
- **Member** (promotional templates with marketing consent, 10:00–21:00; separate from clinical reminders): welcome and how it works, points earned, tier upgraded (and what changed), points expiring in 30 days, reward available, referral converted, programme terms updated.
- **Clinical occasions via PE-002** (service templates, no offer content): annual health check due, screening due, immunisation due, follow-up due.
- **Safety**: abnormal self-reported reading → clinical guidance message plus a care-team task (never framed as a programme message).
- **Staff**: cashier — member eligible for a redemption on this bill; programme manager — liability threshold breached, earn-rule simulation ready, gaming flag raised; finance — monthly liability posting due; compliance — clinician-referral attempt detected.

## 12. Permissions (RBAC keys)
`loyalty.member.self` (Patient — enrol, view, goals, redeem-reserve, leave) · `loyalty.member.read` (Front office, Cashier, Programme manager) · `loyalty.ledger.read` (member self, Programme manager, Finance, Auditor) · `loyalty.points.post` (service account only — no human posts earn entries) · `loyalty.points.adjust` (Programme manager with approval; Finance above the threshold) · `loyalty.reward.read` (all member-facing roles) · `loyalty.redeem.quote|apply` (Cashier, Billing executive) · `loyalty.programme.configure` (Programme manager + **Finance and Marketing approval; MS for clinical-adjacent rules**) · `loyalty.goal.manage` (member self; clinician for cohort goals) · `loyalty.wearable.sync` (member self / device service) · `loyalty.referral.create` (member self) / `loyalty.referral.verify` (Programme manager, Compliance) · `loyalty.liability.run` (Accountant) / `loyalty.liability.post` (Finance Manager; poster ≠ approver) · `loyalty.report.read` (Finance, Marketing, Admin, Quality) · `loyalty.compliance.read` (Admin, MS, Auditor).

## 13. Non-functional
- **Volumes**: 50k–200k members at a large group; 5k–15k ledger entries/day; 200–800 redemptions/day; monthly liability computation over the full ledger.
- **Performance**: balance and eligibility lookup at the billing counter p95 < 100 ms (balance is a maintained column reconciled nightly against the ledger — the cashier cannot wait for a ledger scan); redemption apply < 250 ms including the bill line; catalogue load < 200 ms; liability run over 5 M ledger rows < 10 min (partitioned, incremental).
- **Correctness**: nightly reconciliation of `points_balance` against the append-only ledger with a control alert on any mismatch; idempotency keys prevent double-earn on event replay.
- **Offline**: member wallet readable from PWA cache; redemption requires connectivity (points must be debited atomically with the invoice).
- **Printing**: points statement, reward voucher with QR, programme terms.
- **Accessibility/i18n**: WCAG 2.2 AA, plain-language terms in every supported language, currency and points formatted for `en-IN`.
- **Security/privacy**: loyalty profiling has its own consent; goal and wearable data are PHI-adjacent health data with read audit and no secondary use; tier and behaviour segments are shared with NC-026 only in de-identified or consent-filtered form; the ledger is append-only and auditable end-to-end.

## 14. Acceptance Criteria
1. Given a patient enrols, then a separate loyalty consent is recorded in EN-028 distinct from care and marketing consent, and withdrawing it stops earning and messaging on the next cycle.
2. Given a patient under 18, when enrolment is attempted, then it is blocked with the children's-data reason and no profile is created.
3. Given a PMJAY scheme episode, then no points are earned on it and no redemption may be applied to it; both attempts are blocked with a clear message and logged.
4. Given a payment of ₹10,000 collected on eligible services with a 1-point-per-₹100 rule, then 100 points post with a 7-day maturity, and a subsequent refund of ₹4,000 claws back 40 points automatically.
5. Given a duplicated `payment.received` event, then only one earn entry exists (idempotency key test).
6. Given a member redeems 2,000 points against a wellness service on a bill, then the points debit and the invoice discount line are written in one transaction, the discount appears on the tax invoice per GST §15(3), and a failure of either rolls both back.
7. Given a redemption is attempted against an ICU or surgery charge, then it is rejected server-side regardless of what the counter selects, with the eligibility reason shown.
8. Given a tier benefit is configured that would grant clinical priority (OT slot, ICU bed, triage), then the configuration is rejected by the blocked-benefit validator.
9. Given a referral where the referrer is a registered medical practitioner or a hospital employee, then no points are awarded, the referral is rejected with `referrer_is_clinician`, and a compliance alert is raised.
10. Given a member logs a self-reported BP of 190/115, then no points are awarded for the reading, a clinical safety message is shown, and a care-team task is created.
11. Given wearable data is synced, then it is stored as patient-generated, is visibly labelled as such, and never appears among validated clinical results.
12. Given points are due to expire in 30 days, then a lapse notice is sent, and expiry occurs only after the notice period.
13. Given the monthly liability run, then the deferred-revenue liability and breakage are computed, approved and posted to NC-009 exactly once per period (idempotent re-run).
14. Given the nightly reconciliation, then `points_balance` equals the sum of the member's ledger entries for every member, and any mismatch raises a control alert.
15. Given an annual health-check due reminder, then it is sent on a **service** template with no offer content, while the tier discount offer is a separate **promotional** message requiring marketing consent — a template mixing both is rejected.
16. Given a member is recorded deceased, then the account is frozen and no programme message is ever sent.
17. Given split billing designed to multiply points (three invoices for one patient on one day just under the cap), then the anti-gaming rule flags the account for review before further earning.
18. Given the programme P&L report, then it shows incremental revenue against a matched non-member cohort, liability movement and net contribution — not merely points issued.
19. Given a user without `loyalty.points.adjust`, when attempting a manual adjustment, then 403 and an audit entry are recorded.
20. Given NC-034 (doctor payouts), then a contract test proves it cannot consume loyalty or referral data.

## 15. Enhancements / Later phases
- From the VIMS sheet (row 145): points system, health goals, rewards, annual check-up reminders — all core above, with the regulatory, accounting and health-impact layers the source did not anticipate.
- (market) customer loyalty in pharmacy billing (1 point per ₹100) and "customer loyalty + udhar credit" (SmartHospital); loyalty programme as a listed backbone module (Aosta) — both are retail-style schemes; PE-005's health-behaviour earn family and the clinician-inducement guardrails are the differentiators, and are what makes the programme defensible under NMC and DPDP.
- Later: wearable and home-device integration at scale (EN-042: BP monitors, glucometers, weighing scales, Google Fit/Apple Health); family/household plans with pooled points; employer-sponsored wellness tie-ups (`loyalty.corporate_tieup` with PE-006, where the employer funds member incentives); gamified chronic-care programmes co-designed with clinicians (PE-002 cohorts); partner ecosystem (gym, optical, nutrition) with vendor settlement; AI-driven "next best health action" personalisation (AI-005) with an explicit no-inducement policy check; points-for-charity with a public impact counter; outcome studies published internally to justify continuation or closure.

## 16. Open Questions for the Hospital
1. Do you want a loyalty programme at all, and is the objective health behaviour (check-ups, adherence) or spend retention? The design differs substantially.
2. Which services may earn points, and which must be excluded (diagnostics? pharmacy? insurance-paid portions?) — your ethics policy and payer contracts decide this, not marketing.
3. What earn rate and redemption value do you want, and has Finance accepted that points create a deferred-revenue liability?
4. Which rewards may points be redeemed against? Please confirm the exclusion list (emergency, ICU, surgery, implants, prescription drugs, scheme services).
5. Do you want tiers, and what benefits — strictly non-clinical? Who signs off that no benefit affects clinical priority?
6. Do you want **patient** referral rewards? (Clinician referral rewards are prohibited and will be blocked by the system.)
7. Are staff and their dependants eligible? What does your HR policy say?
8. Who owns the programme operationally — marketing, finance, or a wellness team?
9. Which GST treatment has your CA approved for points redemption and vouchers, and is §194R relevant at your reward values?
10. What points expiry policy and lapse notice period do you want?
11. Do you want wearable/home-device integration at launch, and are you prepared for the clinical-safety obligations that come with abnormal self-reported readings?
12. What would make you close the programme? (Define the P&L and health-impact thresholds now, so the dashboard reports against them.)
