# EN-038 — Workflow & Approval Engine (Configurable Approval Matrices, Rule Conditions, Serial/Parallel/Quorum Approvals, Delegation & Out-of-Office, SLA Timers with Auto-Escalation, Reminders, Mobile Approvals, Matrix Versioning, Simulation & Preview)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Module ID       | EN-038                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Phase           | 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Priority        | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Complexity      | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Depends on      | EN-007 (users, roles, org hierarchy, settings), EN-024 (audit — every approval decision), EN-037 (Notification Centre — requests, reminders, escalations), EN-027 (department/cost-centre/service masters used in conditions), NC-030 (duty roster — who is available to approve now), EN-041 (branch/group scoping of matrices), EN-016 (e-signature on approvals that legally require one), EN-039 (approval-request card & form rendering), EN-040 (entitlement — which approval features the plan includes)                                                                                                                                                                                                                                                                             |
| Consumed by     | OP-005/IP-005 (discount, write-off, rate override), RC-003 (tariff change), NC-001 (refund), OP-003/IP-014 (narcotic issue, high-value drug), NC-005 (indent, PO, rate contract, emergency purchase), NC-006 (stock write-off, inter-store transfer above value), NC-009 (payment voucher, journal, credit note, budget override), NC-010 (leave, overtime, payroll release, loan, F&F), NC-012 (credit limit, corporate onboarding), EN-002/RC-002 (pre-auth enhancement above limit), EN-027 (master-data change sets), EN-029 (clinical rule publication), EN-036 (import batch commits), NC-015 (CAPA closure), IP-002 (discharge against medical advice, LAMA), IP-006 (OT slot override), NC-002 (asset disposal), NC-004 (document publication), EN-023 (privileged-access requests) |
| Feature flag    | `module.workflow.enabled` (always on; sub-flags `wf.parallel`, `wf.quorum`, `wf.delegation`, `wf.mobile_approval`, `wf.simulation`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Primary roles   | Every approver role — HOD (5), Medical Superintendent (4), Hospital/Branch Admin (2/3), Finance Manager (46), Purchase Officer (45), Pharmacy In-charge (32), HR Manager (47), Nurse Supervisor (22), Billing Manager (27)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Secondary roles | Any requester (all staff roles), Auditor (58 — approval evidence), Quality (54), IT Admin (56 — matrix configuration support), Super Admin (1 — shipped default matrices)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Regulatory      | **NABH** (documented authorisation for discounts, waivers, high-risk procedures, LAMA/DAMA, medication overrides), **Companies Act 2013 / internal financial controls** — delegation of authority (DoA) matrix, segregation of duties, maker-checker on payments; **Income Tax & GST** (approval evidence for write-offs, credit notes); **NDPS & Drugs Rules** (two-person authorisation for narcotics); **Labour law / Shops & Establishments** (leave and overtime authorisation records); **DPDP Act 2023** (approval workflows carrying patient data must minimise what an approver sees); IT Act §65B (electronic records as evidence — hence signed, immutable decision records)                                                                                                     |

## 1. Purpose

EN-038 removes approval logic from every module and puts it in one configurable, auditable engine. A module says "this action needs authorisation" with a typed context; the engine decides _who_ must approve (by amount band, department, payer, role, risk), in what _shape_ (serial chain, parallel set, quorum, any-one-of), with what _deadline_ (SLA timers, reminders, auto-escalation, auto-approve/auto-reject on expiry), handles _delegation and out-of-office_, and records an immutable decision trail. Matrices are versioned, effective-dated and simulate-able, so a CFO can see exactly what a proposed change would have done to last month's approvals before publishing it.

## 2. Users & Jobs-to-be-done

- **Billing executive (27, desktop, many times a day)**: apply a 25 % discount, see instantly "this needs HOD + Finance approval, typical turnaround 40 minutes", submit with a reason, and track it without phoning anyone.
- **HOD / Medical Superintendent (5/4, phone between rounds)**: open a push notification, see the request with just enough context (patient initials, service, amount, reason, requester, prior approvals), approve or reject with a reason in two taps, and delegate for a week when travelling.
- **Finance Manager (46, desktop)**: approve payment vouchers and credit notes with maker-checker separation, see the budget impact inline, and never be the person who both created and approved.
- **Purchase Officer / Store (45/44)**: route indents and POs through the value-band matrix, with an emergency-purchase path that is faster but louder (post-facto ratification required).
- **Pharmacy In-charge (32)**: two-person authorisation for narcotics with a legally sound record.
- **HR Manager (47)**: leave and overtime approvals that follow the reporting hierarchy, with automatic routing to the next level when a manager is on leave themselves.
- **Requester (any role)**: know before submitting who will approve, how long it usually takes, and be able to withdraw or add information without starting over.
- **Admin / CFO (2/46)**: change an approval matrix with confidence — versioned, effective-dated, and simulated against historical requests.
- **Auditor (58)**: reconstruct any approval — who, when, on what basis, with what matrix version, and what they could see.

## 3. Core Workflows

### 3.1 Requesting approval (the module-facing contract)

1. A module calls `Workflow.request({ processKey, context, refType, refId, requestedBy, idempotencyKey })`. The **context** is a typed object declared by the process definition (e.g. discount: `{ amount, discountPct, billTotal, department, payerType, patientId, serviceCategories[], reason }`).
2. The engine **resolves the matrix version** effective at request time, evaluates conditions in priority order, and produces an **approval plan**: ordered stages, each with its rule (serial / parallel / quorum / any-one-of), resolved approver set, SLA, reminders and escalation.
3. **Pre-submission preview** (`POST /preview`) returns the plan without creating anything — the UI shows "Approvers: Dr Menon (HOD Cardiology) → Finance Manager. Median turnaround 38 min" _before_ the user commits. This single feature removes most "where is my approval?" traffic.
4. On submit: `wf_requests` row created (`pending`), stage 1 activated, notifications dispatched (EN-037), SLA timer started, and the calling module receives a `requestId` and holds its action in `awaiting_approval` state. Event `workflow.request.created`.
5. **Auto-approval**: if the resolved plan has zero stages (the action is within the requester's own authority), the engine returns `auto_approved` synchronously with the reason ("within your 10 % discount authority") and still writes a decision record — self-authorised actions are audited exactly like approved ones.
6. **Idempotency**: the same `(processKey, refType, refId, idempotencyKey)` never creates a second request; the existing one is returned.

### 3.2 Approval matrices & rule conditions

A **process definition** (`wf_processes`) declares the context schema, the default matrix, and the outcome contract. A **matrix** (`wf_matrices` + `wf_matrix_versions`) is an ordered list of **rules**; the first matching rule wins (with an explicit `continue` flag for stacking):

| Condition dimension                | Examples                                                                                                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Amount bands**                   | discount ≤ 10 % → none; 10–25 % → HOD; 25–50 % → HOD + Medical Superintendent; > 50 % → + Hospital Admin. PO ≤ ₹50 k → Purchase Officer; ₹50 k–5 L → + Finance Manager; > ₹5 L → + Hospital Admin (+ Board above ₹50 L) |
| **Percentage & absolute together** | "25 % **or** ₹25 000, whichever is lower, triggers the next tier" — both expressible                                                                                                                                    |
| **Department / cost centre**       | ICU consumables route to the Intensivist; radiology contrast to the Radiology HOD                                                                                                                                       |
| **Payer / scheme**                 | cash discounts need Finance; PMJAY/CGHS write-offs need the Insurance Desk + Finance; corporate credit needs NC-012 owner                                                                                               |
| **Role & grade of requester**      | a resident's medication override needs consultant countersign; a consultant's does not                                                                                                                                  |
| **Risk / category**                | narcotics → two-person; high-alert drug → Pharmacy In-charge; implant above ₹1 L → Surgeon + Admin                                                                                                                      |
| **Time & state**                   | after 20:00 or on a holiday → duty officer path; during month-end close → Finance blocks non-urgent journals                                                                                                            |
| **Cumulative behaviour**           | "third discount for the same patient this month" or "requester's total approved discounts this month > ₹1 L" escalates a tier — computed from the engine's own history                                                  |
| **Budget**                         | expense within budget → normal path; over budget → Finance + Admin (NC-009 budget check as a condition input)                                                                                                           |
| **Branch / group**                 | branch-level up to X, group office above (EN-041)                                                                                                                                                                       |

Rule expressions are a typed AST built in a visual condition builder (no free-form code), validated against the process's context schema at publish time, with a **`when` / `then`** shape: `when amount > 25000 and payer_type = 'cash' then stages = [HOD, FINANCE]`.

### 3.3 Stage shapes: serial, parallel, quorum, any-one-of

- **Serial** (default): stage 2 activates only after stage 1 approves. Used where seniority matters (HOD then MS then Admin).
- **Parallel**: all stage members are notified at once and **all** must approve (e.g. Clinical + Finance sign-off on a package change). The stage completes when the last one approves; any rejection ends it immediately (configurable: `reject_stops_all` default true).
- **Quorum / N-of-M**: e.g. "any 2 of the 4 credit committee members" or "3 of 5 for a tender above ₹50 L"; the engine tracks progress (`2 of 3 received`) and closes the stage on quorum.
- **Any-one-of**: a pool (e.g. "any Duty Medical Officer") where the first responder takes it and it disappears from the others' queues (with an optimistic-lock so two simultaneous approvals cannot both apply).
- **Conditional stages**: a stage can be skipped when a condition evaluates false at activation time (e.g. skip Finance if the amount after a prior partial approval falls below the band).
- **Segregation of duties**: the engine enforces `requester ≠ approver` and configurable exclusions ("the person who created the PO may not approve the GRN"); a rule that would resolve to the requester **promotes to the next tier automatically** and logs why (never silently approves).
- **Approve-with-modification**: where the process allows it (discount, purchase quantity, pre-auth amount), an approver may approve a _different value_ ("approve 20 % instead of 30 %"); this creates a counter-offer that the requester must accept, or it re-enters the matrix at the band appropriate to the modified value.

### 3.4 SLA timers, reminders & escalation

1. Each stage carries an **SLA** (business hours or calendar hours, per hospital calendar with holidays and shift definitions) — e.g. clinical overrides 30 min, discounts 4 business hours, POs 2 business days, leave 3 business days.
2. **Reminders** at configurable fractions (default 50 % and 80 % of SLA) go to the pending approver via EN-037 with escalating prominence.
3. On **breach**, one of four configured behaviours fires:
   - **Escalate** (default): add the next tier as an approver _in addition to_ the current one, notify both, restart a shorter SLA. Repeats up to a maximum tier.
   - **Auto-approve**: only permitted for explicitly low-risk processes (e.g. `low`-value internal transfers) and never for financial disbursement, clinical safety or statutory approvals; requires Admin sign-off to configure and is loudly reported.
   - **Auto-reject**: for time-bound requests where inaction means "no" (e.g. an OT slot swap).
   - **Hold & alert**: keep pending, alert the requester and the approver's manager.
4. **Availability-aware routing**: when a stage activates, the engine checks the roster/leave calendar (NC-030, NC-010); if the sole approver is on leave without a delegate, the stage routes to their configured backup and logs a `delegation_gap`.
5. **Urgency flag**: a requester may mark a request **urgent** with a mandatory reason; this shortens the SLA, elevates the notification severity and is reported (abuse of urgency is a visible metric).
6. All timers are **durable** (persisted `next_action_at` polled by the worker), survive restarts, and are computed in the hospital's timezone with the business-hours calendar.

### 3.5 Delegation & out-of-office

- Any approver can set **out-of-office** (from, to, reason) with a **delegate** who must hold an equal-or-higher authority for the processes delegated; delegation can be scoped per process family (e.g. delegate purchases but not clinical overrides).
- **Clinical-safety approvals are not delegable to a lower authority**; where the process is marked `non_delegable`, the OOO instead routes to the role's structural backup (deputy HOD, duty MS).
- Delegated decisions are recorded as "**A. Kumar (on behalf of Dr Menon, delegation #123)**" — never as the delegator; the delegation record is part of the audit evidence.
- **Auto-delegation on inactivity**: if an approver has been inactive (no login) for longer than a configured threshold while requests are pending, the engine can auto-escalate rather than let requests rot.
- **Bulk reassignment**: an admin can reassign all pending requests from a departed employee to a successor, with reason and audit.

### 3.6 Decision, outcome & callback

1. An approver opens the request, sees the **context card** (only the fields the process declares — DPDP minimisation: an approver of a discount sees patient initials, UHID last 4, service categories and the amount, not the diagnosis), the requester's reason, attachments, prior decisions, and the policy excerpt that triggered this approval.
2. Actions: **Approve**, **Approve with modification**, **Reject** (reason mandatory), **Request more information** (returns to the requester without losing the chain; SLA pauses), **Abstain** (quorum stages only), **Reassign** (to a peer, with reason).
3. Where the process demands legal weight (payment release, narcotic issue, statutory documents), an **e-signature** (EN-016) or a re-authentication step-up is required at decision time.
4. When the final stage completes, the engine writes the outcome and **calls back** the originating module (`workflow.request.approved|rejected|expired|cancelled` event + a synchronous webhook for latency-sensitive callers), which then performs the action it was holding. The engine never performs the business action itself — it only authorises.
5. **Post-decision immutability**: a decision cannot be edited or deleted. A wrong approval is corrected by a **reversal request** (its own process, usually one tier higher), which links to the original.
6. **Withdrawal**: the requester may withdraw while pending (reason recorded); the module releases its hold.

### 3.7 Matrix versioning, simulation & governance

- Matrices are **versioned and effective-dated**; a request is forever bound to the matrix version in force when it was raised, so an audit three years later reproduces the exact authority chain.
- **Simulation** (`wf.simulation`): before publishing a new version, run it against the last N days of historical requests and see — how many requests would have needed an extra tier, which approvers' load changes, projected turnaround impact, and a sample of 20 requests with old-vs-new plans side by side. A version cannot be published without a simulation run attached (configurable, default on for financial matrices).
- **Publishing** a matrix version is itself an approval (Hospital Admin + Finance for financial matrices) — the engine governs its own configuration.
- **Preview/dry-run** for any single context is always available (§3.1.3).
- **Deprecation**: old versions remain queryable; a matrix cannot be deleted while requests reference it.

### 3.8 Exceptions

- **No approver resolves** (vacant role, empty roster, everyone excluded by SoD) → the stage promotes to the configured fallback authority and raises `workflow.approver_gap` to Admin; the request never dead-ends.
- **Approver has lost the permission** since the request was raised → their pending item is withdrawn and re-resolved.
- **Context changed after submission** (the bill was edited, the PO quantity changed) → the request is invalidated and must be re-raised; approving a stale context is prevented by a context hash check at decision time.
- **Two approvers act simultaneously** on an any-one-of stage → optimistic lock; the second sees "already decided by X at HH:MM".
- **System downtime past an SLA** → SLA clocks are adjusted by recorded downtime windows so nobody is escalated for a system outage.
- **Emergency bypass**: a narrow, role-restricted "break-glass approval" exists for genuinely time-critical clinical/operational cases (emergency purchase at 02:00, emergency narcotic release). It requires a reason, notifies the full escalation chain immediately, and creates a **mandatory post-facto ratification request** within 24 hours; unratified bypasses are a reported governance exception.

## 4. Data Model (schema `core`, prefix `wf_`)

- `wf_processes` — id, hospital_id (null = system), key citext, name, domain enum(billing/finance/purchase/pharmacy/hr/clinical/quality/master_data/it/other), context_schema jsonb (typed fields, PHI classification per field), outcome_contract jsonb, allows_modification bool, non_delegable bool, requires_esign bool, sod_rules jsonb, breach_default enum(escalate/auto_approve/auto_reject/hold), urgency_allowed bool, bypass_allowed bool, active_matrix_id, status; UNIQUE(hospital_id, key).
- `wf_matrices` — id, hospital_id, branch_id?, process_key, name, current_version, status enum(draft/active/superseded/retired), owner_role.
- `wf_matrix_versions` — id, matrix_id, version, rules jsonb[] (priority, condition_ast, stages[]{ kind enum(serial/parallel/quorum/any_of), approvers[] (role@scope | user | dynamic:hod_of(department) | dynamic:oncall(...) | dynamic:manager_of(requester) | dynamic:cost_centre_owner), quorum_n, sla jsonb{hours, calendar}, reminders[], breach_action, skip_condition, requires_esign }, continue_evaluation bool), effective_from, effective_to, published_by, published_at, approval_ref, simulation_ref, checksum, immutable; index (matrix_id, effective_from desc).
- `wf_requests` — id uuidv7, hospital_id, branch_id?, process_key, matrix_version_id, ref_type, ref_id, idempotency_key, requested_by, requested_at, context jsonb, context_hash, reason, urgency enum(normal/urgent), attachments jsonb, status enum(pending/approved/rejected/withdrawn/expired/auto_approved/bypassed/invalidated), current_stage int, plan jsonb (resolved stages snapshot), decided_at, outcome_note, modified_value jsonb?, sla_due_at, escalation_level, total_turnaround_sec, business_turnaround_sec; **partitioned monthly**; indexes (hospital_id, status, sla_due_at), (ref_type, ref_id), (requested_by, requested_at desc), UNIQUE(hospital_id, process_key, ref_type, ref_id, idempotency_key).
- `wf_stages` — id, request_id, stage_no, kind, quorum_n, required_count, received_count, status enum(waiting/active/approved/rejected/skipped/expired), activated_at, completed_at, sla_due_at, reminders_sent int, escalated_to jsonb, skip_reason.
- `wf_stage_approvers` — id, stage_id, user_id, resolved_from enum(role/dynamic/explicit/delegate/escalation), on_behalf_of_user_id?, delegation_id?, notified_at, viewed_at, decision enum(pending/approved/rejected/abstained/reassigned/info_requested), decided_at, reason, esign_ref, decision_latency_sec, device enum(desktop/mobile), context_hash_at_decision; index (user_id, decision, stage_id) — the "my pending approvals" query.
- `wf_actions` — id, request_id, actor_user_id, action enum(created/submitted/viewed/approved/rejected/modified/info_requested/info_provided/withdrawn/reassigned/escalated/reminded/expired/bypassed/ratified/reversed), at, from_state, to_state, reason, payload jsonb, ip_class; append-only timeline; partitioned monthly.
- `wf_delegations` — id, hospital_id, delegator_user_id, delegate_user_id, process_keys text[] (null = all delegable), from_at, to_at, reason, status enum(active/expired/revoked), created_by, revoked_by, revoked_at; validation: delegate authority ≥ delegator for those processes.
- `wf_out_of_office` — user_id, from_at, to_at, note, delegation_id?, auto_escalate bool.
- `wf_business_calendars` — id, hospital_id, branch_id?, name, working_days jsonb, working_hours jsonb, holidays date[], timezone; used for SLA computation.
- `wf_downtime_windows` — id, hospital_id, from_at, to_at, reason; SLA clocks pause across these.
- `wf_simulations` — id, matrix_version_id, run_by, run_at, sample_from, sample_to, requests_evaluated, changed_plan_count, extra_tier_count, approver_load_delta jsonb, projected_turnaround_delta, samples jsonb, notes.
- `wf_bypasses` — id, request_id?, process_key, ref_type, ref_id, actor_user_id, reason, at, ratification_request_id?, ratified bool, ratified_at, ratified_by.
- `wf_metrics` (read model, 15-min) — hospital_id, process_key, matrix_version_id, day, requests, approved, rejected, expired, auto_approved, bypassed, median_turnaround_sec, p90_turnaround_sec, sla_breach_pct, escalation_pct, per_approver jsonb (pending, median decision time, load).
- Retention: requests, stages, approver decisions and actions **7 years** (financial/statutory evidence); clinical approvals follow the clinical record (10 years); simulations 2 years.

## 5. Business Rules & Validations

- **The engine authorises; it never executes.** The calling module holds its action and performs it only on the approved callback — so an approval can never accidentally post a payment.
- **Requester ≠ approver, always.** A rule resolving to the requester promotes to the next tier with a logged reason; maker-checker on financial processes is enforced structurally, not by convention.
- **A request is bound to its matrix version and its context hash.** If the underlying record changes materially after submission, the request is invalidated and must be re-raised — approving a stale context is impossible.
- **Decisions are immutable.** Corrections happen through a linked reversal request at a higher tier. No edit, no delete, ever.
- **Auto-approve on SLA breach is prohibited** for financial disbursement, clinical safety, statutory and narcotic processes; where permitted it requires Hospital Admin configuration approval and appears in a monthly exception report.
- **Non-delegable processes** (clinical safety, narcotics, statutory sign-offs) route to structural backups on OOO, never to a delegate of lower authority; a delegate must hold equal-or-higher authority for the delegated processes.
- **Emergency bypass** is role-restricted, reason-mandatory, notifies the entire chain immediately, and creates a mandatory ratification request within 24 h; unratified bypasses escalate to the Medical Superintendent/Hospital Admin and are reported.
- **PHI minimisation**: the approver sees only the context fields the process declares; fields classified PHI are masked unless the approver's role has clinical access, and approval views of patient data are audited.
- **Every stage must resolve to at least one reachable person**; matrix publication is blocked if any rule can resolve to an empty set, and at runtime an empty stage promotes to the fallback authority with an alert.
- **SLA clocks use business calendars** and pause during recorded downtime and while `info_requested` is outstanding.
- **Urgency is measured**: the % of requests marked urgent per requester is a reported metric; urgency cannot skip stages, only shorten SLAs and raise notification severity.
- **Matrix changes are themselves approved** and, for financial matrices, require a simulation run attached to the publication.
- **Quorum arithmetic is strict**: a quorum stage cannot be configured with N > M, and abstentions do not count toward quorum but are recorded.
- Concurrency: any-one-of and quorum stages use optimistic locking; a duplicate decision returns "already decided by X" rather than double-counting.

## 6. API Surface (`/api/v1/workflow`)

| Method          | Path                                                                                                     | Purpose                                                            | Permission                                            | Notes                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
| POST            | /preview                                                                                                 | resolve the approval plan for a context without creating a request | `wf.request.create`                                   | powers the "who will approve" UI                                               |
| POST            | /requests                                                                                                | raise an approval request                                          | `wf.request.create` (service + role)                  | Idempotency-Key; returns auto_approved when within authority                   |
| GET             | /requests?status&process&requester&ref&from&to                                                           | search requests                                                    | `wf.request.read` (own by default, wider by role)     | cursor                                                                         |
| GET             | /requests/:id                                                                                            | full detail incl. plan, stages, timeline                           | `wf.request.read`                                     | PHI-minimised per process                                                      |
| POST            | /requests/:id/withdraw                                                                                   | requester withdraws                                                | `wf.request.create` (owner)                           | reason                                                                         |
| POST            | /requests/:id/provide-info                                                                               | respond to an information request                                  | requester                                             | resumes SLA                                                                    |
| GET             | /me/pending?process&urgency                                                                              | my approval queue                                                  | authenticated                                         | the most-hit endpoint; p95 <150 ms                                             |
| POST            | /requests/:id/approve \| /reject \| /approve-with-modification \| /request-info \| /abstain \| /reassign | decisions                                                          | `wf.decide` + resolved-approver check                 | reason mandatory on reject/modify; e-sign where required; context-hash checked |
| POST            | /requests/bulk-decide                                                                                    | approve/reject several homogeneous requests                        | `wf.decide.bulk`                                      | same process only, per-item reasons, hard cap 50                               |
| POST            | /requests/:id/bypass                                                                                     | emergency bypass                                                   | `wf.bypass` (restricted roles)                        | reason; creates ratification request                                           |
| POST            | /requests/:id/reverse                                                                                    | raise a reversal of an approved request                            | `wf.request.create`                                   | routes one tier higher                                                         |
| GET/POST/PATCH  | /processes ; /processes/:key                                                                             | process definitions                                                | `wf.process.manage` (Super Admin/IT + owner)          | context schema versioned                                                       |
| GET/POST        | /matrices ; /matrices/:id/versions                                                                       | matrix authoring                                                   | `wf.matrix.manage`                                    | draft only                                                                     |
| POST            | /matrices/:id/versions/:v/simulate                                                                       | run against historical requests                                    | `wf.matrix.manage`                                    | required before financial publish                                              |
| POST            | /matrices/:id/versions/:v/publish \| /rollback                                                           | lifecycle                                                          | `wf.matrix.publish` (Admin + Finance)                 | effective-dated; self-approved via EN-038                                      |
| GET/POST/DELETE | /delegations ; /out-of-office                                                                            | delegation & OOO                                                   | `wf.delegation.manage` (self) / `wf.delegation.admin` | authority validation                                                           |
| POST            | /reassign-bulk {fromUser, toUser, processes}                                                             | reassign a departed approver's queue                               | `wf.delegation.admin`                                 | audited                                                                        |
| GET/PUT         | /calendars ; /downtime-windows                                                                           | business calendars & SLA pauses                                    | `wf.calendar.manage` (Admin)                          |                                                                                |
| GET             | /metrics/turnaround ; /metrics/approvers ; /metrics/sla ; /metrics/bypasses                              | analytics                                                          | `wf.report.read`                                      | read models                                                                    |
| GET             | /audit/:requestId                                                                                        | full evidence pack (plan, decisions, matrix version, signatures)   | `wf.audit.read` (Auditor)                             | PDF export                                                                     |

## 7. Domain Events (outbox)

- `workflow.request.created|submitted|auto_approved` → EN-037 notifications, calling module state.
- `workflow.stage.activated|approved|rejected|skipped|expired|escalated` → notifications, metrics.
- `workflow.request.approved|rejected|withdrawn|expired|invalidated` → **calling module callback** (the module performs or abandons its held action), EN-024 audit.
- `workflow.request.modified` (approve-with-modification) → requester acceptance flow.
- `workflow.sla.reminder_sent|breached` → EN-037 with escalating severity.
- `workflow.approver_gap` / `workflow.delegation_gap` → Admin, HR, roster owner.
- `workflow.bypass.used` / `workflow.bypass.ratified|unratified_overdue` → Medical Superintendent, Hospital Admin, governance report.
- `workflow.matrix.published|rolled_back` → EN-024, affected module owners, EN-041 branch sync.
- `workflow.delegation.created|revoked|expired` → EN-024, delegate & delegator.
- Consumes: `user.deactivated` (reassign pending), `roster.shift.changed` (dynamic approver resolution), `leave.approved` (OOO auto-creation), `system.downtime.recorded` (SLA pause), `mdm.department.changed` (re-resolve dynamic approvers).

## 8. Screens (UI)

- **My Approvals inbox** (desktop + phone, the workhorse): grouped by urgency and ageing, each card showing process, requester, amount/subject, reason snippet, SLA countdown chip (green/amber/red), and inline `Approve` / `Reject` buttons; opening a card shows the full context, policy excerpt ("this needs you because the discount exceeds 25 %"), attachments, prior decisions and the remaining chain. **Bulk select** for homogeneous items with a per-item reason field. Keyboard: `J/K` navigate, `A` approve, `R` reject, `I` request info, `Enter` open, `Ctrl+Enter` submit. Mobile: two-tap approve with biometric/step-up where the process requires it, works on a 3G connection, offline queueing of decisions with a conflict check on sync.
- **Request tracker** (requester view, desktop/phone): status stepper showing each stage, who is pending, how long they've had it, and a nudge button (rate-limited to one per SLA half-life); withdraw and provide-info actions.
- **Pre-submission preview panel** (embedded in every requesting screen — billing, purchase, HR): "This will need: HOD Cardiology → Finance Manager. Median turnaround 38 min." with an option to add a note for approvers.
- **Matrix Designer** (desktop, Admin/Finance): rules table with drag-to-reorder priority; per-rule condition builder (field → operator → value, with AND/OR groups and value pickers from EN-027); stage editor with approver-type pickers (role@scope, dynamic HOD-of, manager-of-requester, on-call, explicit user), kind (serial/parallel/quorum/any-of), quorum N, SLA with calendar selector, reminders, breach action; a right rail showing **live resolution** ("HOD of Cardiology = Dr Menon; Finance Manager = 2 users"). Validation panel blocks unresolvable rules. `Ctrl+S` save draft, `Ctrl+M` simulate, `Ctrl+P` request publish.
- **Simulation Report** (desktop): old vs new plan counts, requests that would gain/lose a tier, approver load delta bar chart, projected turnaround change, and a scrollable list of 20 sample requests with side-by-side plans.
- **Delegation & OOO** (desktop/phone, self-service): date range, delegate picker (filtered to eligible authority), process scope toggles, and a plain-language summary ("From 3–10 Aug, Dr Rao will approve your purchase and leave requests; clinical overrides will route to the Deputy HOD").
- **Approval Analytics** (desktop, Admin/Finance/Quality): turnaround by process and approver, SLA breach %, escalation %, bottleneck approvers, requests by band, discount value approved by department, urgency-flag abuse, bypass register with ratification status.
- **Audit Evidence view** (desktop, Auditor): a single printable page per request — context, matrix version with the exact rule that matched, every notification and decision with timestamps, signatures, delegation records and the resulting business action reference.
- Empty/error states: "Nothing awaiting your approval", "This request was invalidated because the bill was edited after submission — the requester must resubmit", "No approver could be resolved for stage 2 (HOD Radiology vacant) — escalated to the Medical Superintendent", "You cannot approve your own request; it has been escalated to Finance".

## 9. Integrations

- **EN-037** for every request, reminder, escalation and outcome notification, including mobile push with actionable buttons and the escalation ladder for breached SLAs.
- **NC-030 / NC-010** for roster and leave data driving dynamic approver resolution and OOO auto-creation; **EN-007** for the org hierarchy (`manager_of`, `hod_of`, `cost_centre_owner`).
- **EN-016** for e-signatures on decisions requiring legal weight; **EN-024** for the immutable audit trail; **EN-027** for masters used in conditions; **NC-009** for budget-availability checks as a condition input; **EN-041** for group-vs-branch matrix scoping and for group-office approval tiers.
- **Module callbacks**: synchronous webhook + outbox event so latency-sensitive callers (billing at a cash counter) can resume immediately while durable delivery is guaranteed.
- **External**: none by default; an optional adapter can push approvals to a corporate ERP's DoA system for hospitals that must mirror group-level authority (via EN-017).

## 10. Reports & Analytics

- **Turnaround**: median/p90 by process, stage, approver, branch, hour-of-day; business vs calendar time; time spent waiting on `info_requested`.
- **SLA**: breach % by process and approver, escalation counts by tier, requests auto-approved/auto-rejected on breach (with a hard look at whether that policy is safe).
- **Approver load**: pending count and ageing per approver, decisions per day, median decision latency, mobile vs desktop mix, "approve without opening" rate (a rubber-stamping signal: decisions made in under 5 seconds without viewing the detail).
- **Financial exposure**: value of discounts/write-offs/refunds approved by band, department, payer and approver; trend vs policy limits; top requesters.
- **Governance**: bypass register with ratification status and overdue items; urgency-flag usage by requester; delegation usage and gaps; segregation-of-duties promotions (how often a rule hit the requester).
- **Matrix effectiveness**: % of requests auto-approved within authority (a high number means the matrix is well-calibrated; a low one means the hospital is drowning in approvals), tier distribution, and rules that never match (dead configuration).
- Read models: `analytics.mv_wf_process_daily`, `analytics.mv_wf_approver_daily`, `analytics.mv_wf_financial_exposure_monthly`.

## 11. Notifications

- **To approvers**: new request (severity by process and urgency), reminders at 50 %/80 % of SLA, escalation notice ("this has been escalated to your senior — please act"), delegation started/ended, bulk digest option for low-severity processes (twice daily).
- **To requesters**: submitted with the expected chain, each stage decision, information requested, approved/rejected with reason, expired, invalidated (with why), and counter-offer to accept.
- **To admins/finance**: SLA breach summary, bypass used (immediate), bypass unratified after 24 h, approver gap, matrix published, auto-approve-on-breach fired.
- **To HR/roster owners**: delegation gap when an approver is on leave with no delegate and requests are pending.

## 12. Permissions (RBAC keys)

`wf.request.create` (all staff, scoped by process) · `wf.request.read` (own requests always; wider by role/department via ABAC; Auditor 58 tenant-wide) · `wf.decide` (granted implicitly by being a resolved approver; the key gates the endpoint) · `wf.decide.bulk` (approvers with high volume — Finance 46, Purchase 45, HR 47) · `wf.bypass` (Medical Superintendent 4, Hospital Admin 2, Duty Officer role — narrowly granted) · `wf.process.manage` (Super Admin 1, IT Admin 56 with module-owner sign-off) · `wf.matrix.manage` (Hospital Admin 2, Finance Manager 46, HR Manager 47 for their domains) · `wf.matrix.publish` (Hospital Admin + Finance dual, itself an approval) · `wf.delegation.manage` (self) · `wf.delegation.admin` (HR 47, Hospital Admin — reassign a departed approver) · `wf.calendar.manage` (Hospital Admin) · `wf.report.read` (Admin, Finance, HODs scoped, Quality 54) · `wf.audit.read` (Auditor 58, DPO 57).

## 13. Non-functional

- **Volumes (2000-bed enterprise)**: ~**3000–5000 approval requests/day** (discounts ~1200, purchase ~250, HR ~400, clinical overrides ~600, refunds ~150, master data ~100, the rest operational), ~8000 decisions/day across ~250 active approvers; peak 400 requests/hour at the 11:00–13:00 billing crest.
- **Latency**: `POST /preview` p95 **< 80 ms** (it sits inline in the billing screen and must feel instant); `POST /requests` p95 < 150 ms; `/me/pending` p95 < 150 ms with unread counts cached in Redis; decision write p95 < 200 ms including callback enqueue.
- **Timers**: SLA/reminder/escalation timers are durable (persisted `next_action_at`, polled every 15 s) — accuracy within 30 s; they survive worker restarts and are correct across DST and hospital holidays.
- **Consistency**: decisions use optimistic locking on the stage row; the module callback is delivered at-least-once with idempotency so a duplicate callback cannot double-post a payment.
- **Storage**: ~1.5 M requests/year plus stages, approvers and actions; monthly partitions; 7-year retention with cold archival after 2 years.
- **Mobile**: the approval inbox must be fully usable on a 3G phone — payload < 60 KB per page, decisions queue offline and sync with a context-hash conflict check.
- **Accessibility**: approval cards keyboard-navigable, SLA state conveyed by icon + text + colour, decision dialogs screen-reader labelled, and reason fields never auto-focused away from assistive tech.
- **i18n**: process names, rule explanations ("why am I seeing this?") and notification text localised; amounts formatted per locale with Indian digit grouping.
- **Testing**: every shipped matrix has fixtures; a golden-path e2e covers submit → escalate → approve → callback; a chaos test kills the timer worker mid-escalation and asserts no missed or duplicated rung.

## 14. Acceptance Criteria

1. **Given** a billing executive applies a 30 % discount, **when** the preview is requested before submission, **then** the exact approver chain and median turnaround are shown without creating a request.
2. **Given** the matrix requires HOD then Finance, **when** the HOD approves, **then** Finance is activated and notified, and the request remains pending until Finance decides.
3. **Given** a parallel stage with three required approvers, **when** two approve and one rejects, **then** the request is rejected immediately, the reason is recorded, and the remaining approver is told it is closed.
4. **Given** a quorum stage of "any 2 of 4", **when** the second approval is received, **then** the stage completes, the remaining two see it as decided, and no further decisions are accepted.
5. **Given** an any-one-of stage, **when** two approvers submit simultaneously, **then** exactly one decision is applied and the other receives "already decided by X at HH:MM".
6. **Given** a matrix rule resolves to the requester, **when** the plan is built, **then** the stage is promoted to the next tier with a logged segregation-of-duties reason and the requester is never an approver of their own request.
7. **Given** an SLA of 4 business hours, **when** 50 % and 80 % elapse, **then** reminders are sent, and on breach the configured escalation adds the next tier while keeping the original approver active.
8. **Given** a financial disbursement process, **when** an admin attempts to configure auto-approve on SLA breach, **then** the configuration is rejected as prohibited for that process class.
9. **Given** an approver is on out-of-office with a valid delegate, **when** a request activates, **then** it routes to the delegate, the decision is recorded as "on behalf of", and the delegation record is part of the audit trail.
10. **Given** a non-delegable clinical process, **when** the approver is on OOO, **then** it routes to the structural backup, not the delegate.
11. **Given** a bill is edited after an approval request was raised, **when** an approver tries to approve, **then** the context-hash check fails, the request is invalidated, and the requester is told to resubmit.
12. **Given** an approver approves with a modification (20 % instead of 30 %), **when** the modification is submitted, **then** the requester must accept it, and if the modified value falls in a lower band the remaining stages are re-evaluated.
13. **Given** an emergency bypass is used at 02:00, **when** it is executed, **then** the reason is captured, the full chain is notified immediately, a ratification request is created, and failure to ratify within 24 hours escalates and appears in the governance report.
14. **Given** a new matrix version, **when** publication is attempted for a financial process without a simulation run, **then** publication is blocked.
15. **Given** a request approved under matrix version 3, **when** version 4 is published later, **then** the audit view still shows version 3's rule as the basis for that decision.
16. **Given** the timer worker restarts during an escalation, **when** it recovers, **then** the escalation fires at its persisted time with no missed or duplicated tier.
17. **Given** an approver views a discount request, **when** the context card renders, **then** it shows only the fields declared by the process, with clinical details masked unless their role has clinical access, and the view is audited.
18. **Given** an approver decides in under 5 seconds without opening the detail repeatedly over a month, **when** the analytics run, **then** their rubber-stamping indicator appears in the governance report for the Hospital Admin.
19. **Given** an employee leaves, **when** their pending queue is bulk-reassigned, **then** every pending request moves to the successor with an audit entry and the original approver's name preserved on the timeline.
20. **Given** a request is approved, **when** the callback fires, **then** the calling module performs its held action exactly once even if the callback is delivered twice.

## 15. Enhancements / Later phases

- **Full BPMN-style workflow designer** beyond approvals — multi-step business processes with tasks, forms, timers, gateways and sub-processes (a natural extension once the approval core is stable).
- **Policy-as-code import/export** so a group can version its Delegation of Authority in Git and publish it to 18 branches (pairs with EN-041).
- **AI-assisted approvals** (AI-005): risk scoring of a request from historical patterns, "this discount pattern resembles 12 previously rejected requests", and auto-drafted rejection reasons — always advisory, never deciding.
- **Anomaly detection** on approver behaviour (sudden spike in approvals, out-of-hours patterns, always-approve behaviour) feeding internal audit.
- **WhatsApp/Teams/Slack actionable approvals** for executives who live outside the HMS, with signed deep links and step-up authentication.
- **Conditional auto-approval with learned thresholds**: propose (never apply) matrix band changes based on the observed 99 % approval rate in a band.
- **Multi-currency and multi-entity DoA** for international group deployments.
- **Approval SLAs tied to contractual penalties** for vendor-facing processes, and integration with corporate ERP DoA systems.

## 16. Open Questions for the Hospital

1. What is the current **Delegation of Authority matrix** — the exact amount bands and approvers for discounts, refunds, write-offs, purchase orders, payments, credit limits and budget overrides? (Please provide the signed document; it becomes the seed configuration.)
2. Which approvals are **statutory or clinical** and therefore must never auto-approve on SLA breach or be delegated?
3. What **SLAs** does the hospital want per process, and are they in business hours or calendar hours? What are the working days, shift hours and the holiday calendar per branch?
4. Who are the **structural backups** for each approver role (deputy HOD, duty medical officer, acting Finance Manager) when someone is unavailable?
5. Should an **emergency bypass** exist at all? If yes, for which processes, which roles may use it, and who ratifies it?
6. Is **approve-with-modification** wanted for discounts, purchase quantities and pre-auth amounts, or should approvers only approve/reject as submitted?
7. How much **patient context** may a non-clinical approver (Finance, Admin) see on a clinical or billing approval?
8. Are approvals expected on **mobile**, and is a biometric/step-up re-authentication required at decision time for financial approvals?
9. Which processes need an **e-signature** (EN-016) rather than an authenticated click?
10. What **cumulative rules** does the hospital want (e.g. escalate the third discount for the same patient this month, or when a requester exceeds a monthly approved value)?
11. Who owns each **matrix** (which department head may change which rules), and who publishes?
12. For a multi-branch group: which approvals stay at the **branch** and which go to the **group office**, and at what thresholds?
13. What retention does the auditor require for approval evidence, and is a printable per-request evidence pack acceptable as the audit artefact?
