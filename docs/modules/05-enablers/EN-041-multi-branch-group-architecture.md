# EN-041 — Multi-branch / Group Architecture (Group → Hospital → Branch → Unit Hierarchy, Shared vs Isolated Data Domains, Shared MPI & Clinical Record, Cross-branch Lookup with Consent, Central Masters with Branch Overrides, Inter-branch Transfers & Referrals, Consolidated Group Reporting, Branch Onboarding Wizard (<24 h), Data Residency, Per-branch Numbering & Tariffs, RLS Policy Design for Group Roles)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-041 |
| Phase | 0 |
| Priority | P0 |
| Complexity | Very High |
| Depends on | EN-007 (tenants, users, roles, sessions, numbering series, settings), EN-027 (MDM — which masters are group-wide vs branch-local, effective-dated distribution), EN-024 (audit — cross-branch access is a sensitive event), EN-028 (consent for cross-branch clinical access), EN-040 (branch count is a billable entitlement), EN-022 (per-branch backup/restore and residency), EN-001 (group consolidated analytics), EN-036 (branch data migration & onboarding loads), EN-038 (group-vs-branch approval tiers), EN-011 (ABDM facility/HIP registration per branch), EN-019 (FHIR `Organization`/`Location` hierarchy) |
| Consumed by | **Every module** — every business table carries `hospital_id` + `branch_id` and obeys the policies defined here. Notably OP-001 (MPI & UHID strategy), OP-005/IP-005/RC-003 (branch-scoped billing and tariffs), NC-006 (branch stores & inter-branch transfer), NC-009 (branch cost centres, consolidated financials), NC-010 (employees working across branches), EN-006/EN-018 (branch queues and boards), OP-004/OP-008 (branch labs feeding a central lab), EN-002/RC-001 (payer contracts at group or branch level) |
| Feature flag | `module.multi_branch.enabled` (sub: `mb.shared_mpi`, `mb.cross_branch_clinical`, `mb.inter_branch_transfer`, `mb.group_reporting`, `mb.data_residency`) |
| Primary roles | Group Admin / Hospital Admin (2), Branch Admin (3), Super Admin (1 — SaaS provisioning of new branches) |
| Secondary roles | Group Medical Director (4 at group scope), Group CFO / Finance (46), Group HR (47), Group Quality (54), Group Purchase (45), IT Admin (56), MRD (43 — cross-branch record governance), DPO (57 — cross-branch and cross-border disclosure), Auditor (58), every clinical role (cross-branch patient lookup) |
| Regulatory | **DPDP Act 2023 & Rules 2025** — a group is one or many data fiduciaries; sharing a patient record between legally distinct entities is a disclosure requiring notice and (usually) consent; cross-border transfer rules for overseas branches; **Clinical Establishments Act** and state licensing are **per facility** (each branch has its own registration, drug licence, BMW authorisation, AERB licence, fire NOC); **ABDM** — each facility has its own HFR/HIP id and consent is facility-scoped (EN-011); **NABH/NABL accreditation is per site**, never group-wide; **GST** — each state registration is a distinct GSTIN with separate invoice series, e-way bills for inter-branch stock movement above threshold, and inter-branch supply of goods/services between distinct GSTINs is a taxable supply; **Companies Act** — branches may be separate legal entities requiring separate books and consolidation; **Drugs & Cosmetics Rules** — stock transfer between licensed premises requires the receiving licence and documentation |

## 1. Purpose
EN-041 defines how one deployment serves a hospital group: the organisational hierarchy, which data is shared across branches and which is strictly isolated, how a patient's record follows them between branches with consent, how central masters are distributed with branch overrides, how stock and patients move between branches, how the group sees consolidated numbers while a branch sees only its own, how a new branch goes live in under a day, and — the foundation under all of it — the Row-Level Security policy design that makes cross-branch leakage structurally impossible rather than merely unlikely.

## 2. Users & Jobs-to-be-done
- **Group Admin (2, desktop)**: add a new branch and have it operational the same day; decide which masters are group-controlled; compare branches on one dashboard; move a doctor's schedule between branches.
- **Branch Admin (3, desktop)**: run their branch with local tariffs, counters, wards and numbering, without being able to see or affect another branch's operations.
- **Doctor / Nurse (6/7/17, any branch)**: when a patient presents at Branch B having been treated at Branch A, see their history — with the patient's consent captured and recorded — rather than starting from zero.
- **Front office (24)**: find a patient by mobile and discover they already have a UHID from another branch, avoiding a duplicate registration.
- **Group CFO (46)**: one consolidated P&L with per-branch drill-down, correct handling of inter-branch transactions and eliminations, and per-GSTIN tax reporting.
- **Group Purchase / Stores (45/44)**: a central item master, rate contracts negotiated once, and stock transferred between branches with proper documentation and tax treatment.
- **Group Quality (54)**: NABH indicators per site (accreditation is per site) plus a group scorecard; incidents visible at group level for learning.
- **DPO (57)**: prove what patient data crossed which legal-entity boundary, on what basis, and be able to restrict a branch in a different country from seeing Indian patient data.
- **Super Admin (1)**: provision a branch under a group's subscription and confirm it is entitled and isolated.

## 3. Core Workflows

### 3.1 The hierarchy
```
Group (legal/brand parent, optional)
 └── Hospital / Legal Entity   ← the tenant boundary (hospital_id), owns GSTIN(s), licences, books
      └── Branch / Facility    ← the operational boundary (branch_id), one physical site, own registrations
           └── Unit / Block / Wing  ← wards, OT complexes, day-care, satellite collection centres
                └── Location     ← room, bed, counter, store, service point
```
- **`hospital_id` is the tenancy boundary** and the RLS anchor (CLAUDE.md §3). A group with several legal entities is modelled as several `hospitals` linked by a `group_id`; a group that is one legal entity with many sites is one `hospital` with many `branches`. **Which of these applies is a per-customer decision with large consequences** (books, GST, consent, accreditation) and is the first open question in §16.
- `org_groups` → `core.hospitals` → `org_branches` → `org_units` → `mdm_locations`, stored as an `ltree` path (`group.hosp.branch.unit`) so ancestor/descendant queries are index-fast, plus explicit FK columns for RLS.
- Each **branch** carries its own: legal registrations (Clinical Establishment no., drug licence, BMW authorisation, AERB licence, fire NOC, PC-PNDT registration) with expiry tracking, **ABDM HFR/HIP id** (EN-011), NABH/NABL certificate and scope (EN-031), GSTIN and state, address, timezone, currency, working calendar, contact and escalation tree.
- A **satellite** (collection centre, polyclinic, day-care) is a branch with a reduced module profile (EN-040 entitlement) and may depend on a parent branch for lab processing or reporting — modelled as `serves_from_branch_id`.

### 3.2 Shared vs isolated data domains (the core design decision)
| Domain | Default | Rationale |
|---|---|---|
| **Patient identity (MPI)** — demographics, UHID, ABHA, identifiers, allergies, blood group | **Shared across the group** | one patient, one identity; prevents duplicate UHIDs and unsafe blind spots |
| **Clinical record** — encounters, notes, results, images, prescriptions, problems | **Shared, consent-gated** (§3.4) | continuity of care; but access is an event, not a right |
| **Billing, receipts, invoices, GST** | **Branch-isolated** | invoices belong to a GSTIN and a legal entity; series are per branch |
| **Tariffs & payer contracts** | **Group catalogue, branch prices** | one service catalogue, different rates per city/branch |
| **Inventory & stock** | **Branch-isolated** (item master shared) | stock is physical and licensed per premises |
| **Pharmacy dispensing & narcotic registers** | **Branch-isolated** | statutory registers are per licensed premises |
| **HR & payroll** | **Branch-isolated employment, group-visible directory** | a person is employed by one entity; multi-branch duty is modelled explicitly (§3.7) |
| **Accounts / GL** | **Branch cost centres, entity books, group consolidation** | statutory books per entity; consolidation with eliminations |
| **Appointments & queues** | **Branch-isolated** operationally, **group-visible** for booking | a patient may book at any branch from one interface |
| **Masters (drug, test, service, ICD, department types)** | **Group-controlled with branch overrides** | consistency with local reality (§3.5) |
| **Users & roles** | **Group identity, branch-scoped access** | one login, explicit branch grants |
| **Audit, security, integrations config** | **Group-visible to IT, branch-filterable** | one security posture |
| **Quality/NABH records** | **Branch-owned** (accreditation is per site), group dashboard | assessors audit a site |
| **Documents/SOPs** | **Group-published with branch acknowledgement** | one policy, evidence of local adoption |

Each domain's rule is declared in `org_data_domains` (domain key, sharing mode `group|entity|branch`, override policy, consent requirement, residency constraint) so the choice is configuration and auditable, not scattered code.

### 3.3 RLS policy design (how isolation is enforced)
1. Every business table has `hospital_id uuid not null` and, where operationally scoped, `branch_id uuid`. Composite indexes always start with `hospital_id` (docs/03).
2. Per request the API sets, inside the transaction:
   ```sql
   SET LOCAL app.hospital_id = '<uuid>';
   SET LOCAL app.branch_ids  = '{b1,b2}';   -- branches this user may touch
   SET LOCAL app.scope       = 'branch';    -- branch | entity | group
   SET LOCAL app.user_id     = '<uuid>';
   SET LOCAL app.role        = '<role>';
   ```
3. **Three policy shapes**:
   - *Branch-isolated table*: `USING (hospital_id = current_setting('app.hospital_id')::uuid AND branch_id = ANY(current_setting('app.branch_ids')::uuid[]))`.
   - *Entity-shared table* (e.g. patients): `USING (hospital_id = current_setting('app.hospital_id')::uuid)`.
   - *Group-shared table* (MPI index, group masters): `USING (hospital_id = ANY(current_setting('app.hospital_ids')::uuid[]))`, where the array is populated **only** for roles holding a group scope.
   Separate `WITH CHECK` clauses prevent writing a row into a branch the user cannot access — a common oversight that makes read isolation useless.
4. **Group roles** (`group_admin`, `group_finance`, `group_quality`, `group_medical_director`) receive a widened `app.hospital_ids`/`app.branch_ids` and, for clinical data, still pass through the **cross-branch access rules** of §3.4 — a group role is not a licence to browse patient charts.
5. **Analytics** run on a read replica with a group-scoped role reading `analytics.*` materialised views that are pre-aggregated and, where they contain patient-level rows, subject to the same policies.
6. **Testing is mandatory**: a generated test suite asserts, for every business table, that a user scoped to Branch A cannot read or write a Branch B row through any endpoint, and that a missing `SET LOCAL` results in zero rows rather than all rows (RLS default-deny, no `BYPASSRLS` on application roles).

### 3.4 Shared MPI & cross-branch clinical access with consent
1. **One patient, one UHID across the group** (recommended default): the UHID series is group-level with a branch prefix for readability (`BLR/2026/000123`) but the number is unique group-wide; registration at any branch first searches the **group MPI** by mobile, name+DOB, ABHA and identifiers (using the EN-036 deterministic + fuzzy scorer) and offers "this patient exists at Whitefield branch — link?".
   - The alternative (per-branch UHID with a cross-reference index) is supported for groups of separate legal entities that must not share identity; it is chosen once per deployment.
2. **Cross-branch clinical access** is an explicit, logged event:
   - Within the **same legal entity**, viewing a patient's record from another branch is permitted for a treating clinician with a **care-relationship check** (the patient has an active or recent encounter at the accessing branch) and is written to the audit as `READ_PHI cross_branch`.
   - Across **different legal entities** in the group, access requires a **consent artefact** (EN-028): recorded at registration ("may we share your record across our group hospitals?"), revocable, time-bounded, and purpose-limited. Without consent, the clinician sees only that records exist elsewhere (an existence indicator with the branch name and date, never content) and can request access.
   - **Break-glass** for emergencies: a clinician may override with a reason; the patient and the DPO are notified, the access is flagged for review, and it is prominent in the audit. Emergency care is never blocked waiting for consent.
3. **Sensitive-record shielding**: psychiatry (OP-032), HIV/STI, MTP/fertility (OP-024/OP-040), MLC (TR-008) and any record the patient marks confidential are excluded from cross-branch visibility by default and require a separate, explicit consent or break-glass.
4. **Patient-controlled view**: in PE-001 the patient can see which branches hold their records and which accessed them, and can withdraw the group-sharing consent — withdrawal takes effect immediately for future access and is recorded (past access is not retro-hidden but remains audited).
5. **Merge across branches**: a patient found to exist twice (once per branch) is merged through OP-001's merge service; the merge is a group-level event propagating to billing, PACS (ADT A40), ABDM links and every branch's queues.

### 3.5 Central masters with branch overrides
1. EN-027 owns the masters; EN-041 defines **scope and override policy** per master (`org_master_scopes`): `group_locked` (branches may not change — drug master, ICD, LOINC, service catalogue codes), `group_default_branch_override` (branches may override specified attributes — service price, test availability, department names, reorder levels), `branch_owned` (wards, beds, counters, stores, staff rosters).
2. **Distribution**: a group master change is published with an **effective date**; branches receive it through the sync job; a branch override is stored as a delta row (`override_of_key`, changed attributes, reason, approver) so the group can always see "12 branches, 3 have overridden the price of ECG".
3. **Override governance**: overridable attributes are declared per master; an override requires branch-admin approval and is visible in a group **divergence report** (which branches differ from the group standard and by how much) — this is how a group prevents silent drift.
4. **Conflict handling**: if a group change touches an attribute a branch has overridden, the branch keeps its override but is notified and the divergence report flags it; the group can force-reset an override with approval (audited).
5. **New branch inherits** the current group masters at onboarding, with an optional "copy from Branch X" for tariffs and configuration.

### 3.6 Per-branch numbering series & tariffs
- **Numbering** (EN-007 `core.numbering_series`): every human-facing series is defined per hospital **and** per branch, per financial year, with a pattern like `{BR}/{FY}/{SEQ:6}` — UHID (group-unique but branch-prefixed), OP visit, IP number, bill/invoice (**gapless per GSTIN**, a statutory requirement), receipt, credit note, lab accession, sample, PO, GRN, MLC, blood bag, token. Series never overlap between branches, and a branch cannot issue into another branch's series.
- **Invoice series are legally per GSTIN** — where two branches share a GSTIN they may share a series (with a branch segment), where they differ they must not.
- **Tariffs** (RC-003): one group service catalogue; price lists are versioned and effective-dated **per branch and per payer**, with group-default price lists that a branch may adopt or override. A tariff change published at group level cascades to branches that have not overridden it, on the effective date.
- **Packages, discount policies and approval matrices** (EN-038) likewise have group defaults and branch overrides with the same governance.

### 3.7 Staff across branches
- A user has **one identity** (EN-007) and explicit **branch grants** (`org_user_branch_access`: branch, roles at that branch, from/to, granted_by). The role a person holds may differ per branch (consultant at A, HOD at B).
- **Primary employment** (NC-010) is at one branch/entity for payroll, PF/ESI and statutory purposes; **duty at other branches** is recorded as a posting/visiting arrangement with its own attendance and, where applicable, cross-charging of the doctor's cost to the serving branch.
- **Branch switcher** in the UI: a single control that changes the active branch context; the active branch is shown persistently in the header (colour-coded per branch) because "which branch am I in?" errors cause real harm (ordering for the wrong site).
- Doctor schedules (OP-001) can span branches with travel-time buffers; a doctor's OPD at two branches on the same day is a schedule constraint, not a duplicate profile.

### 3.8 Inter-branch transfers & referrals
1. **Patient transfer** (clinical): Branch A initiates a transfer/referral to Branch B (OP-021 for outpatient referral, IP-001/IP-002 for admission transfer) → the receiving branch sees the clinical summary (consent per §3.4), the transfer is tracked with acceptance, bed allocation, ambulance (NC-013) and a handover document (EN-039); billing splits at the transfer instant, and each branch bills its own services under its own GSTIN.
2. **Stock transfer** (NC-006): an inter-branch indent → approval (EN-038, group tier above a value) → issue from the sending store with batch/expiry → **documentation**: delivery challan, and where the branches have different GSTINs a **tax invoice with GST and an e-way bill** above the threshold; the receiving branch performs a GRN against the challan, with variance handling. Drug transfers require the receiving premises' drug licence to be recorded. FEFO and cold-chain (EN-042) rules travel with the consignment.
3. **Service sharing**: a satellite collection centre sends samples to a central lab (OP-004) — the order stays with the originating branch for billing, the processing branch owns QC and TAT, and the report shows both facilities. Similarly for teleradiology between branches (EN-008).
4. **Inter-branch financial settlement**: cross-charges (a doctor serving another branch, a shared lab, transferred stock) post to inter-branch control accounts in NC-009 and are **eliminated in consolidation** — the group P&L must not double-count internal revenue.

### 3.9 Branch onboarding wizard (target: live in <24 h)
*(market benchmark: SMART HMIS/IQRAA — 18 branches with rapid branch implementation within 24 hours)*
A guided, checkpointed wizard that a Group Admin can complete without engineering:
1. **Identity & legal** (15 min): branch name, code, address, state, timezone, currency, GSTIN, legal entity, licences with expiry dates, ABDM HFR/HIP registration, accreditation status, contacts.
2. **Entitlement** (2 min): EN-040 confirms the branch is within the plan (or triggers an add-on approval); module profile selected (full hospital / OPD-only / collection centre / day-care).
3. **Copy configuration** (10 min): "clone from Branch X" — departments, service catalogue mapping, tariffs, approval matrices, forms/templates, print templates and letterhead (with the new branch's identity merged), notification routing, queue and token configuration, working calendar.
4. **Physical setup** (30 min): units/wards/beds/room classes, counters, stores, service points, kiosks, TV boards, printers with device profiles (EN-005), lab/radiology equipment (if any).
5. **People** (30 min): bulk user import (EN-036 template) with roles and branch grants, doctor schedules, on-call roster skeleton (NC-030).
6. **Numbering & finance** (10 min): numbering series per the branch pattern, opening cash counters, cost centres, GL mapping, opening balances (EN-036) if the branch is not greenfield.
7. **Data load** (variable): existing patients/stock/history via EN-036 batches, or none for a greenfield branch.
8. **Integrations** (20 min): payment gateway sub-merchant, SMS/WhatsApp sender for the branch, email identity, ABDM, TPA/payer mapping, analyzers/PACS if present.
9. **Smoke test & go-live checklist** (30 min): the wizard runs a scripted verification — register a test patient, book an appointment, issue a token, create a bill and receipt (voided afterwards), place a lab order, print a token and a receipt, send a test SMS, confirm RLS isolation from other branches — and produces a **go-live report**. The branch flips from `provisioning` to `live` only when every mandatory check passes.
10. **Rollback**: a branch in `provisioning` can be deleted cleanly; a `live` branch can only be `suspended` or `closed` (never deleted), with data retained per retention policy.

### 3.10 Consolidated group reporting
- **Roll-up dimensions**: group → entity → branch → unit → department, with a consistent date and currency basis (multi-currency groups convert at a declared rate table with the rate source and date shown).
- **Comparability**: branch scorecards on standard KPIs (OP footfall, IP admissions, ALOS, bed occupancy, OT utilisation, revenue per bed, collection efficiency, TAT, NPS, infection rate, staff cost ratio) with benchmarking and outlier highlighting; per-capita and per-bed normalisation so a 60-bed branch is comparable with a 500-bed one.
- **Eliminations**: inter-branch revenue/cost pairs are matched and eliminated in the group P&L; an unmatched inter-branch balance is a reconciliation exception, reported daily.
- **Patient-level group analytics** (e.g. patients treated at more than one branch, group-wide readmission) run only for roles with group clinical scope and are subject to the same consent rules; aggregate reporting is unrestricted.
- **Per-site compliance reporting** stays per site — NABH/NABL indicators, BMW returns, AERB, PC-PNDT and state health-department returns are filed by facility, never as a group total.

### 3.11 Data residency & cross-border
- Each branch declares a **residency zone** (`in`, `ae`, `qa`, `ke`, …). A group operating across countries can run: one deployment with logical separation (simplest, acceptable where law allows), **separate deployments federated for identity and reporting** (common for UAE/Qatar), or **per-country database clusters** with a residency-aware routing layer.
- `org_residency_policies` declares, per zone pair, whether patient data may be read, whether only aggregates may cross, and the legal basis; the entitlement of a group role is intersected with residency so a group finance user in Dubai cannot read Indian patient records unless the policy permits.
- **Aggregate-only crossing** is the default for cross-border group reporting: numbers cross, patients do not.
- Backups and object storage follow the branch's zone (EN-022); DPDP significant-data-fiduciary obligations and any local equivalents are tracked per zone.

### 3.12 Exceptions
- **Branch offline / WAN outage**: a branch must keep operating locally for registration, orders, dispensing and billing. Where the deployment is cloud-hosted, this means the documented degradation (queue-and-sync for non-critical writes, cached masters, local printing); where on-prem-per-branch, it means autonomous operation with deferred group sync. Group reporting simply lags.
- **Branch closure/merger**: `closed` branches retain data, stop new transactions, and their patients are re-pointed to the successor branch with a recorded mapping; numbering series are closed, not reused.
- **Legal-entity change** (a branch is sold or transferred): a documented data-separation procedure exports the branch's data, removes group sharing, revokes cross-branch consents and reissues identifiers where required — planned via EN-036 with DPO sign-off.
- **Duplicate patient across entities where identity is not shared**: a cross-reference index links them without merging, and clinicians see both with an explicit "records at another entity" indicator.

## 4. Data Model (schema `core`, prefix `org_`)
- `org_groups` — id, name, legal_name, brand, logo_ref, default_currency, default_timezone, hq_address jsonb, status, created…
- `core.hospitals` (existing, extended) — id, group_id?, legal_name, entity_type, pan, cin, primary_gstin, books_currency, residency_zone, is_tenant_boundary bool, status.
- `org_branches` — id, hospital_id, group_id, code citext, name, short_name, path ltree, parent_branch_id?, kind enum(hospital/branch/satellite/collection_centre/daycare/polyclinic/warehouse), serves_from_branch_id?, address jsonb, state_code, gstin, timezone, currency, residency_zone, bed_count, module_profile, colour_token, go_live_at, status enum(provisioning/live/suspended/closed), closed_at, successor_branch_id?, created…; UNIQUE(hospital_id, code); index (group_id, status), GiST on path.
- `org_units` — id, branch_id, code, name, kind enum(ward/icu/ot_complex/block/floor/wing/department_unit), path ltree, capacity, active.
- `org_branch_registrations` — id, branch_id, kind enum(clinical_establishment/drug_licence/bmw/aerb/pcpndt/fire_noc/nabh/nabl/abdm_hfr/gstin/pollution/lift/other), number, issuing_authority, valid_from, valid_to, document_ref, status, renewal_owner; drives expiry alerts.
- `org_data_domains` — id, hospital_id?, domain_key (patient_identity/clinical_record/billing/tariff/inventory/pharmacy/hr/accounts/appointments/masters/users/audit/quality/documents), sharing_mode enum(group/entity/branch), override_policy jsonb, consent_required bool, residency_constraint enum(none/same_zone/aggregate_only), notes, updated_by; the declarative source of §3.2.
- `org_master_scopes` — master_key (from EN-027), scope enum(group_locked/group_default_branch_override/branch_owned), overridable_attributes text[], approval_required bool.
- `org_master_overrides` — id, branch_id, master_key, record_key, attributes jsonb, reason, approved_by, effective_from, effective_to, status; feeds the divergence report.
- `org_user_branch_access` — id, user_id, branch_id, roles text[], scope enum(branch/entity/group), is_primary bool, from_at, to_at, granted_by, reason; UNIQUE(user_id, branch_id, from_at).
- `org_cross_branch_access_log` — id, actor_user_id, actor_branch_id, patient_id, target_branch_id, target_entity_id, basis enum(care_relationship/consent/break_glass/group_role), consent_ref?, reason, resources jsonb (what was viewed), at, reviewed_by?, reviewed_at; **partitioned monthly**; feeds DPO reporting and patient transparency.
- `org_patient_branch_links` — patient_id, branch_id, first_seen_at, last_seen_at, encounter_count, has_active_episode; the fast "which branches hold this patient" index that powers the existence indicator without exposing content.
- `org_transfers` — id, kind enum(patient_clinical/stock/asset/staff_posting/sample), from_branch_id, to_branch_id, ref_type, ref_id, initiated_by, initiated_at, accepted_by, accepted_at, status enum(initiated/in_transit/accepted/rejected/cancelled/completed), documents jsonb (challan, invoice, eway_bill, handover), tax_treatment jsonb, settlement_ref (NC-009), notes.
- `org_interbranch_settlements` — id, period, from_branch_id, to_branch_id, category enum(stock/service/staff/overhead), amount, currency, gl_ref, matched bool, eliminated_in_consolidation bool, variance, status.
- `org_residency_policies` — id, group_id, from_zone, to_zone, patient_data enum(allow/aggregate_only/deny), legal_basis, dpa_ref, approved_by, effective_from.
- `org_branch_onboarding` — id, branch_id, template_source_branch_id?, steps jsonb (step, status, owner, completed_at, notes), smoke_test jsonb (checks with pass/fail), go_live_report_ref, started_at, completed_at, elapsed_minutes.
- `org_branch_kpis` (read model, refreshed 15 min/daily) — group_id, hospital_id, branch_id, date, kpi_key, value, target, rank_in_group, normalised_value; powers the group scorecard.
- Retention: organisational records permanent; cross-branch access log **7 years** (DPDP/audit); onboarding records permanent as commissioning evidence.

## 5. Business Rules & Validations
- **`hospital_id` is on every business row and RLS is default-deny.** Application database roles never hold `BYPASSRLS`; a missing `SET LOCAL` yields zero rows, never all rows. Both `USING` and `WITH CHECK` clauses are present on every policy.
- **A user can only act in branches explicitly granted to them**; the active branch is always visible in the UI and is recorded on every transaction. Writing a row into a non-granted branch is impossible at the database level, not merely blocked in code.
- **Group roles do not confer clinical browsing rights**: cross-branch clinical access always passes the care-relationship / consent / break-glass check and is logged as a PHI read.
- **Cross-entity clinical sharing requires consent** (EN-028), is revocable, and is purpose- and time-limited; without it only an existence indicator is shown. **Emergency break-glass is always available** and always notified and reviewed — care is never delayed by a consent gate.
- **Sensitive categories** (psychiatry, HIV/STI, MTP/fertility, MLC, patient-flagged confidential) are excluded from cross-branch visibility by default.
- **Invoice numbering is gapless per GSTIN** and never shared across GSTINs; a branch cannot issue into another branch's series; UHID is unique group-wide when shared MPI is enabled.
- **Inter-branch stock movement between different GSTINs is a taxable supply** requiring a tax invoice and, above threshold, an e-way bill; drug transfers require the receiving premises' drug licence on record. The system blocks a transfer that lacks the mandatory documentation.
- **Inter-branch transactions must be matched and eliminated** in group consolidation; unmatched balances are a daily reconciliation exception.
- **Master overrides are explicit, approved and visible**; a branch cannot silently diverge on a `group_locked` master, and divergence on overridable attributes is reported.
- **Accreditation, licences and statutory returns are per facility** — the system never produces a "group NABH score" as a compliance artefact, and licence expiry is tracked per branch with escalating alerts.
- **Residency policies intersect with permissions**: a role in one zone cannot read patient data from a `deny` zone regardless of its role scope; only aggregates cross where `aggregate_only` applies.
- **A live branch is never deleted**; closure retains data, closes series and records a successor for patient re-pointing.
- **Branch go-live requires a passed smoke test** including an explicit RLS-isolation check; the go-live report is retained as commissioning evidence.
- Every cross-branch action (access, transfer, master override, user grant) is audited with actor, branches, basis and reason.

## 6. API Surface (`/api/v1/org`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET | /hierarchy?depth | group → entity → branch → unit tree | `org.read` | ltree-backed, cached |
| GET/POST/PATCH | /branches ; /branches/:id | branch registry | `org.branch.manage` (Group Admin 2) | code immutable after go-live |
| POST | /branches/:id/onboard/start \| /step \| /smoke-test \| /go-live | onboarding wizard | `org.branch.onboard` | go-live gated by smoke test |
| POST | /branches/:id/clone-config {sourceBranchId, sections[]} | copy configuration | `org.branch.onboard` | preview of what will be copied |
| POST | /branches/:id/suspend \| /close | lifecycle | `org.branch.manage` | reason; successor mapping on close |
| GET/POST/PATCH | /branches/:id/registrations | licences & accreditations | `org.registration.manage` (Branch Admin 3) | expiry alerts |
| GET/PUT | /data-domains | sharing mode per domain | `org.policy.manage` (Group Admin + DPO) | audited; changes are significant |
| GET/PUT | /master-scopes ; GET /master-overrides ; POST /master-overrides | scope & branch overrides | `org.master.override` (Branch Admin + approval) | divergence report source |
| GET | /divergence?master&branch | where branches differ from group standard | `org.report.read` | |
| GET/POST/DELETE | /users/:id/branch-access | branch grants & roles per branch | `org.access.manage` (Group/Hospital Admin) | audited; effective-dated |
| POST | /context/switch {branchId} | switch active branch | authenticated (granted branches only) | new session scope, logged |
| GET | /patients/:id/branches | which branches hold records (existence only) | `org.patient.locate` | no clinical content |
| POST | /patients/:id/cross-branch-access {targetBranchId, basis, reason, consentRef?} | request/exercise cross-branch access | `org.patient.cross_access` | logs PHI read; break-glass notifies |
| GET | /cross-access-log?patient&branch&from&to | disclosure log | `org.audit.read` (DPO 57, Auditor 58) | patient-visible subset in PE-001 |
| POST | /transfers {kind, from, to, ref} ; POST /transfers/:id/accept \| /reject \| /complete | inter-branch transfers | `org.transfer.manage` (+ domain permission) | documentation validated |
| GET | /settlements?period&branch | inter-branch balances & eliminations | `org.finance.read` (Group Finance 46) | reconciliation exceptions |
| GET | /reports/group-scorecard?period ; /reports/branch-comparison?kpi | consolidated reporting | `org.report.read` (group scope) | normalised metrics |
| GET/PUT | /residency-policies | cross-zone data rules | `org.policy.manage` (DPO + Group Admin) | intersects permissions |
| GET | /rls/self-test | run the isolation assertion suite for this tenant | `org.policy.manage` | used at go-live and in CI |

## 7. Domain Events (outbox)
- `org.branch.created|onboarding_step_completed|smoke_test_passed|went_live|suspended|closed` → EN-040 (billable branch count), EN-027 (master seeding), EN-007 (numbering series creation), EN-022 (backup scope), EN-011 (HFR registration task), EN-001 (analytics dimension).
- `org.branch.registration_expiring` (90/60/30/7 days) → Branch Admin, Group Compliance.
- `org.user.branch_access_granted|revoked` / `org.context.switched` → EN-024 audit, session scope refresh.
- `org.patient.cross_branch_accessed` (with basis) → EN-024, DPO register, PE-001 patient transparency feed; `org.patient.break_glass_used` → immediate DPO + Medical Superintendent alert.
- `org.master.override_created|reset` → EN-027 distribution, divergence report.
- `org.transfer.initiated|accepted|rejected|completed` → NC-006 stock ledgers, NC-009 settlements, IP-001/OP-021 clinical transfer, NC-013 ambulance.
- `org.settlement.unmatched` → Group Finance daily exception.
- `org.residency.policy_changed` → security posture review, EN-023.
- Consumes: `patient.registered|merged` (branch links), `bill.finalized` (settlement matching), `licence.entitlement.changed` (branch count), `user.deactivated` (grant cleanup).

## 8. Screens (UI)
- **Branch Switcher** (app header, all devices): current branch name with a **branch colour band** across the top of the shell (each branch has a distinct colour token) so a user can never mistake context; the switcher lists only granted branches, shows the entity and city, and a switch is logged. On phones the branch appears in the bottom-nav context chip.
- **Group Dashboard** (desktop + TV, Group Admin/CFO/Medical Director): map or grid of branches with live tiles (OP footfall today, IP census, occupancy %, revenue, collection %, ER load, critical alerts open), colour-coded RAG against targets, drill-down to a branch dashboard; period comparison and normalised per-bed views.
- **Branch Comparison** (desktop): KPI selector × branches matrix with sparklines, rank, best/worst highlighting, and an "explain the gap" drill-through to the underlying transactions.
- **Branch Registry & Compliance** (desktop): branch list with status, go-live date, bed count, module profile, and a **licence expiry board** (registrations with days-to-expiry, owner, renewal status) — the screen a group compliance officer lives on.
- **Branch Onboarding Wizard** (desktop, 9 steps with a progress rail and elapsed-time counter against the <24 h target): each step shows required vs optional fields, a "clone from branch" picker, and a live checklist; the final step runs the smoke test with a pass/fail list and produces the go-live report PDF. Steps can be assigned to different owners and completed in parallel where independent.
- **Data-Domain Policy** (desktop, Group Admin + DPO): the §3.2 table as an editable matrix with plain-language consequences shown per choice ("Sharing the clinical record across entities requires patient consent; without it clinicians will see only that records exist elsewhere"), change history and an approval requirement.
- **Cross-branch patient lookup** (embedded in OP-001 search and the patient banner): when a patient has records elsewhere, a chip reads "Records at Whitefield (last visit 12-Mar)" — clicking it either opens the record (care relationship/consent satisfied) or opens the access-request/break-glass dialog with a mandatory reason and a clear statement that the access will be logged and reviewed.
- **Cross-access Log** (desktop, DPO/Auditor): who accessed which patient across which branch boundary, on what basis, with break-glass entries pinned and a review workflow.
- **Master Divergence Report** (desktop, Group Admin): per master, which branches have overridden which attributes, the value delta, when and why — with a bulk "reset to group standard" action requiring approval.
- **Inter-branch Transfers** (desktop): outgoing/incoming queues with status, documentation completeness chips (challan / invoice / e-way bill / licence on file), acceptance and variance handling.
- **Inter-branch Settlements** (desktop, Group Finance): matched/unmatched pairs by period and category, elimination status, and a drill to source documents.
- Empty/error states: "You do not have access to this branch — request access from your administrator", "This patient has records at 2 other group hospitals. Consent for group sharing was withdrawn on 04-Feb; use emergency access if clinically necessary (this will be reviewed)", "Branch cannot go live: 3 smoke-test checks failed (numbering series, printer profile, RLS isolation)".

## 9. Integrations
- **EN-007** for the numbering-series engine (per branch, per FY), session scope and the feature-flag catalogue; **EN-027** for master scope and distribution; **EN-028** for group-sharing consent artefacts; **EN-040** for branch entitlement; **EN-022** for per-branch/per-zone backup and restore; **EN-024** for the audit spine.
- **EN-011/ABDM**: each branch registers as a facility in HFR and acts as its own HIP; consent under ABDM is facility-scoped and does not substitute for the group-sharing consent (and vice versa). **EN-019** exposes the hierarchy as FHIR `Organization` (group/entity) and `Location` (branch/unit) resources with `partOf` links.
- **GST/e-way bill**: inter-branch supplies between distinct GSTINs generate invoices and e-way bills through NC-009/NC-006 with the government portal as an EN-017 connector.
- **NC-009** for inter-branch control accounts, consolidation and eliminations; **NC-010** for cross-branch postings and cost cross-charging; **EN-001** for the group analytics layer reading branch-partitioned read models.
- **Deployment topology**: a single cluster with logical isolation (default), branch-local edge nodes for on-prem hybrid (Postgres logical replication or store-and-forward for offline tolerance), or per-country clusters with a federation layer for residency — chosen per customer and recorded as an ADR.

## 10. Reports & Analytics
- **Group scorecard**: OP footfall, IP admissions, ALOS, occupancy, OT utilisation, ER volume and door-to-doctor, revenue and revenue per bed, collection efficiency, AR days, case mix, lab/radiology volumes and TAT, NPS, HAI rate, staff cost ratio, doctor productivity — all per branch with group totals, normalised views and outlier flags.
- **Branch benchmarking**: same-KPI ranking with peer grouping by size/type, month-on-month movement, and "if branch X matched the group median, the impact would be ₹Y".
- **Patient mobility**: patients treated at more than one branch, referral flows between branches (a Sankey view), leakage (patients who went elsewhere after a referral), and catchment overlap.
- **Financial consolidation**: entity-wise and consolidated P&L with inter-branch eliminations, per-GSTIN tax summaries, inter-branch balance ageing, cross-charge analysis.
- **Governance**: master divergence, licence/registration expiry pipeline, cross-branch access volume by basis (care relationship vs consent vs break-glass — a rising break-glass share is a red flag), branch onboarding elapsed time vs the 24-hour target, RLS self-test results per branch.
- Read models: `analytics.mv_org_branch_kpi_daily`, `analytics.mv_org_patient_mobility_monthly`, `analytics.mv_org_settlement_period`.

## 11. Notifications
- **Group Admin/Compliance**: branch registration expiring (90/60/30/7 days), branch went live, smoke test failed, master divergence created, branch KPI breached target for 3 consecutive periods.
- **DPO/Medical Superintendent**: break-glass cross-branch access (immediate), unusual cross-branch access volume, residency policy changed, consent withdrawal affecting active care.
- **Branch Admin**: masters updated at group level and effective from a date, override conflicts, incoming transfer awaiting acceptance, licence renewal due.
- **Group Finance**: unmatched inter-branch settlements at period close, e-way bill missing on a dispatched transfer.
- **Users**: "you have been granted access to Branch X", "your access to Branch Y expires on…".

## 12. Permissions (RBAC keys)
`org.read` (all staff — see their own hierarchy) · `org.branch.manage` (Group/Hospital Admin 2) · `org.branch.onboard` (Group Admin, Implementation lead) · `org.registration.manage` (Branch Admin 3, Group Compliance) · `org.policy.manage` (Group Admin + DPO 57 dual — data domains, residency) · `org.master.override` (Branch Admin, with approval) · `org.access.manage` (Group/Hospital Admin — branch grants) · `org.patient.locate` (front office, clinicians — existence indicator only) · `org.patient.cross_access` (clinicians; logged as PHI read) · `org.patient.break_glass` (clinicians in emergency roles; notified & reviewed) · `org.transfer.manage` (Stores 44, Nursing 22, Branch Admin per kind) · `org.finance.read` (Group Finance 46) · `org.report.read` (group-scoped roles: Group Admin, CFO, Medical Director, Quality 54) · `org.audit.read` (DPO 57, Auditor 58).

## 13. Non-functional
- **Scale**: designed for a group of **up to 50 branches, 20 000 beds aggregate, 30 000 OP visits/day and 10 M patients in the shared MPI**; the reference case is 18 branches / 5000 OP visits per day (SMART HMIS IQRAA benchmark).
- **Query performance under tenancy**: every hot query must remain index-first with `hospital_id` (and `branch_id` where applicable) as the leading column; RLS predicates must be `EXPLAIN`-verified not to force sequential scans — an RLS-induced full scan on a 100 M-row table is the classic multi-tenant failure and is a CI check.
- **Branch context switch < 500 ms** including session re-scope and cache warm; branch colour band renders in the first paint so context is never ambiguous.
- **Group dashboard from read models only** (never live joins across branches): p95 < 800 ms for a 20-branch scorecard; refresh every 15 minutes with a visible "as of" timestamp.
- **Cross-branch patient lookup p95 < 300 ms** using `org_patient_branch_links` (an index, not a scan of every branch's encounters).
- **Branch onboarding target < 24 hours** wall-clock including data load, with the configuration steps completable in under 3 hours of active work; the wizard measures and reports elapsed time so the target is auditable.
- **Isolation testing**: an automated per-tenant suite asserts branch isolation on every business table and runs at go-live and in CI; a failure blocks release. Penetration-style tests attempt cross-branch access through every endpoint including reports and exports.
- **Availability & partition tolerance**: a branch must continue local operations during a WAN outage per the deployment topology; group reporting degrades to "last synced" rather than failing.
- **Residency**: object storage, backups and read replicas follow the branch's zone; cross-zone replication is explicitly configured and never implicit.
- **i18n & locale**: per-branch timezone, currency, working calendar, language default and print letterhead; a group spanning countries formats each branch's documents in its own locale while group reports use the declared group currency with a visible conversion basis.

## 14. Acceptance Criteria
1. **Given** a user granted access only to Branch A, **when** they query any endpoint (including reports and exports) for Branch B data, **then** zero rows are returned, the attempt is logged, and no error message reveals the existence of Branch B data.
2. **Given** the API omits `SET LOCAL app.hospital_id`, **when** a query executes, **then** RLS returns zero rows (default deny) rather than all rows, and the request fails safely.
3. **Given** a user attempts to write a row with a `branch_id` outside their grant, **when** the insert executes, **then** the `WITH CHECK` policy rejects it at the database level.
4. **Given** a patient registered at Branch A presents at Branch B, **when** front office searches by mobile, **then** the existing group UHID is found, no duplicate is created, and the patient's branch links are shown without exposing clinical content.
5. **Given** two branches in different legal entities and no group-sharing consent, **when** a clinician at Branch B opens the patient, **then** only an existence indicator is shown, and viewing content requires either a recorded consent or a break-glass with reason.
6. **Given** break-glass cross-branch access is used, **when** it is executed, **then** access is granted immediately, the DPO and Medical Superintendent are notified within 60 seconds, the event is flagged for review, and it appears in the patient's transparency log in PE-001.
7. **Given** a patient marks their psychiatry records confidential, **when** a clinician at another branch views the patient, **then** those records are excluded from cross-branch visibility even with group-sharing consent.
8. **Given** a group-level tariff change with an effective date, **when** the date arrives, **then** branches without an override adopt the new price automatically, overriding branches keep their price and are listed in the divergence report, and historical bills still resolve their original tariff version.
9. **Given** a branch attempts to issue an invoice, **when** the numbering series is resolved, **then** it uses that branch's gapless series for its GSTIN and cannot consume another branch's series.
10. **Given** a stock transfer between branches with different GSTINs, **when** the dispatch is attempted without a tax invoice or a required e-way bill, **then** the transfer is blocked with a specific message naming the missing document.
11. **Given** an inter-branch service cross-charge, **when** the group P&L is consolidated, **then** the matched pair is eliminated and any unmatched balance appears as a reconciliation exception.
12. **Given** a new branch is created from the onboarding wizard cloning Branch X, **when** the steps complete, **then** departments, tariffs, templates, approval matrices, numbering patterns and notification routing exist for the new branch with its own identity merged into letterheads, and the elapsed time is recorded.
13. **Given** the branch smoke test, **when** any mandatory check fails (including the RLS isolation check), **then** go-live is blocked and the failing checks are listed with remediation hints.
14. **Given** a group finance user in a `deny` residency zone, **when** they open a group report containing patient-level rows from India, **then** only aggregates are returned and the patient-level drill-through is refused with a residency explanation.
15. **Given** a doctor holds different roles at two branches, **when** they switch branch context, **then** their permissions, dashboards and menus change accordingly, the branch colour band changes, and the switch is audited.
16. **Given** a branch is closed, **when** closure completes, **then** no new transactions are possible, all data remains queryable to authorised roles, numbering series are closed permanently, and patients are re-pointed to the successor branch with a recorded mapping.
17. **Given** a group role, **when** it accesses a patient chart at another branch, **then** the care-relationship/consent/break-glass check still applies — the group role alone does not grant clinical read.
18. **Given** the group dashboard, **when** it renders for 20 branches, **then** it reads only from read models, completes within 800 ms at p95, and displays the "data as of" timestamp.
19. **Given** a branch registration (drug licence) expires in 30 days, **when** the scheduler runs, **then** the Branch Admin and Group Compliance are notified, and the compliance board shows it in the amber band.
20. **Given** a WAN outage at a branch, **when** staff continue working, **then** registration, orders, dispensing and billing continue per the documented topology, and group reporting shows the branch as "last synced at HH:MM" rather than failing.

## 15. Enhancements / Later phases
- **Group-wide clinical continuity views**: a single longitudinal chart across branches with source-branch provenance on every entry, plus group-level problem and medication reconciliation.
- **Cross-branch resource optimisation**: shared doctor rostering across branches with travel constraints, group OT/ICU capacity balancing, and "nearest branch with a free ICU bed" routing for referrals.
- **Group procurement intelligence**: consolidated demand forecasting, group rate contracts, price-paid variance across branches for the same item, and automatic stock rebalancing suggestions from slow-moving to high-consumption branches.
- **Federated deployment mode**: per-country clusters with an identity and reporting federation layer for strict residency regimes, plus a group data warehouse fed by aggregate-only pipelines.
- **Group-level AI**: cross-branch benchmarking models, demand and staffing prediction per site, and outlier detection on clinical and financial patterns (AI-005).
- **Franchise/partner branches** with restricted data sharing, separate branding and their own subscription under the group umbrella.
- **Branch performance league with incentives**: quality-adjusted scorecards feeding management incentive schemes (with safeguards against gaming clinical metrics).
- **Automated legal-entity separation toolkit** for divestment: one guided workflow to carve out a branch's data, revoke sharing and hand over an export package with DPO sign-off.

## 16. Open Questions for the Hospital
1. Is the group **one legal entity with multiple sites, or multiple legal entities**? (This determines the tenancy boundary, GST treatment, consent requirements and consolidation — please confirm per branch.)
2. Should the **UHID be group-unique** with a branch prefix, or per-branch with a cross-reference index? Is the hospital comfortable with a shared MPI?
3. Should the **clinical record be shared across branches by default** with consent, or isolated per branch with explicit sharing only on referral?
4. What **consent wording and capture point** does the group want for cross-branch sharing, and who may revoke it?
5. Which **masters must be group-controlled** (drug, service, test, ICD) and which attributes may a branch override (price, availability, reorder level)?
6. Are branches on **different GSTINs**, and does the group already have an inter-branch transfer pricing and documentation practice?
7. How are **inter-branch cross-charges** (shared doctors, central lab, transferred stock) settled today, and who owns the elimination in consolidation?
8. How many branches exist now, how many are planned in 24 months, and what is the **expected go-live time per branch** (target <24 h)?
9. Are any branches **outside India**? If so, in which countries, and what are the data-residency and cross-border rules the group must satisfy?
10. Which staff work across branches, and should their **primary employment** stay at one branch for payroll while duty is recorded elsewhere?
11. Do branches need to **operate during a WAN outage**, and is the deployment cloud-only, on-prem per branch, or hybrid?
12. Who holds **group-scope roles** (Group Admin, CFO, Medical Director, Quality), and should any of them be able to open a patient chart — and under what basis?
13. Which **KPIs** should the group scorecard carry, and what are the targets per branch size/type?
14. What is the policy for **break-glass cross-branch access** — who may use it, who reviews it, and within what timeframe?
