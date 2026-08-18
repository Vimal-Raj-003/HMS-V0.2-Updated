# IP-019 — Transplant Module (recipient waitlist & registry, living/deceased donor registry, brain-death certification & donation coordination, NOTTO/SOTTO/ROTTO allocation, matching (ABO/HLA/crossmatch), authorisation committee, retrieval & transplant episode, post-transplant follow-up & immunosuppression, THOTA compliance)

| Field | Value |
|---|---|
| Domain | IP / Inpatient |
| Module ID | IP-019 |
| Phase | 8 |
| Priority | P2 |
| Complexity | High |
| Depends on | IP-009 (brain-death assessments/apnoea tests, donor maintenance in ICU), IP-017 (body handover after retrieval), IP-006/TR-004 (retrieval & transplant OT scheduling, WHO checklist, green corridor coordination), IP-007 (blood bank: ABO, crossmatch, components; HLA lab if in-house via OP-004), OP-004 (labs: HLA typing, PRA, viral markers, DSA, tacrolimus levels), OP-008/EN-008 (imaging), OP-002 (CPOE: immunosuppression protocols, order sets), IP-014 (immunosuppressants, high-cost drugs), OP-012/IP-022 (dialysis link for renal candidates), OP-029 (cardiology for heart), IP-001/IP-002 (admissions/discharge), EN-028 (consents: donor Form 7/8/10, recipient, authorisation committee forms), EN-016 (e-sign), EN-039 (THOTA forms), NC-013/TR-009 (organ transport, ambulance/green corridor), IP-018 (recipient/donor transfers), IP-005/RC-007/EN-002 (transplant packages, scheme funding e.g., state CM funds), PE-001/PE-002 (recipient follow-up reminders, drug adherence), OP-021 (referrals), NC-015 (outcomes/registry), NC-023 (legal/licence: transplant centre registration), EN-017 (NOTTO/SOTTO portal exchange), EN-024, EN-037, TR-008 (MLC donors: police NOC/PM coordination), IP-012 (donor-derived infection screening) |
| Feature flag | `module.transplant.enabled` (sub-flags: `transplant.deceased_donor`, `transplant.living_donor`, `transplant.tissue_bank`, `transplant.notto_exchange`, organ flags `transplant.kidney|liver|heart|lung|pancreas|cornea|bone_marrow`) |
| Primary roles | Transplant coordinator (custom role under 25/42 "Transplant Coordinator"), Transplant surgeon (9), Nephrologist/Hepatologist/Cardiologist (6/7), Intensivist (11: donor maintenance/brain death), Anaesthetist (10), Nurse — ICU/OT (18/20), Resident (14) |
| Secondary roles | Blood bank/HLA lab (37/13), Pharmacist (31/32), MS (4: authorisation committee, appropriate authority liaison), MRD (43), Billing/TPA (27/28), Legal (NC-023), Counsellor (42), Social worker, Quality (54), Patient/Family (59/60), Auditor (58), NOTTO/SOTTO/ROTTO (external portal), Police (TR-008) |
| Regulatory | Transplantation of Human Organs & Tissues Act 1994 (THOTA) & Rules 2014 (Forms 1–21: Form 1–3 near-relative/spouse/other donor consent, Form 4 psychiatric evaluation, Form 5 HLA, Form 6 authorisation committee, Form 7 pledge, Form 8 consent for deceased donation by NOK, Form 9 unclaimed body, Form 10 brain-stem death certification (panel of 4, two examinations ≥ 6 h apart, minors 12/24 h), Form 11 recipient joint application, Form 12 registration of hospital, Form 13/14/15/16 registration, Form 18 authorisation committee decision, Form 19–21 registers/reports), NOTTO/ROTTO/SOTTO allocation & organ-sharing guidelines (state allocation policies e.g., TN/KA/MH/TS/DL), NOTTO national registry data submission, Appropriate Authority inspection & licence renewal (5-yearly), Human tissue rules (cornea/skin/bone banks), Drugs & Cosmetics (immunosuppressants), NABH 5th ed. (COP transplant services where applicable, PRE consents), MTP/CrPC (MLC donors: police NOC, PM), DPDP (highly sensitive donor/recipient data, anonymity between deceased donor family & recipient), ICMR/DGHS living-donor guidelines |

## 1. Purpose
IP-019 runs the transplant programme end-to-end and legally: recipient evaluation and waitlisting with organ-specific scores, living-donor evaluation with THOTA authorisation-committee workflow, deceased-donor identification from ICU brain-death certification through family counselling/consent, SOTTO/NOTTO registration and allocation, matching and organ offer/acceptance, retrieval and transplant OT episodes with green-corridor logistics, and lifelong post-transplant follow-up (immunosuppression levels, rejection/infection surveillance, graft outcomes) with THOTA registers/forms and NOTTO reporting.

## 2. Users & Jobs-to-be-done
- **Transplant coordinator** (desktop/phone 24×7): maintain recipient waitlist & documents, screen potential deceased donors (GCS ≤ 5/ventilated triggers), coordinate brain-death panel, counsel families & capture consent forms, register donor/recipient on SOTTO/NOTTO, manage organ offers/acceptances and logistics (retrieval team, OT, transport, police NOC), collect follow-up data.
- **Transplant surgeon / physician**: evaluate candidates, decide listing/status, accept organ offers (matching data), operative record, immunosuppression protocol, follow-up clinics.
- **Intensivist**: donor identification, brain-death certification (IP-009 Form 10), donor maintenance bundle (haemodynamics, hormones, ventilation, temperature), organ-function labs/imaging.
- **Living-donor team**: work-up checklist (medical, psychiatric Form 4, HLA Form 5, imaging), relationship proof, authorisation committee dossier and hearing (Form 6/18), donor safety follow-up.
- **HLA/blood bank**: ABO, HLA typing, PRA/DSA, crossmatch (CDC/flow), virtual crossmatch data.
- **MS/legal**: committee scheduling, appropriate-authority reporting, licence tracking (NC-023).
- **Billing**: packages, scheme funding, organ transport charges.
- **Recipient** (PE-001): waitlist status (per policy), appointment/drug reminders, home-monitoring diaries.

## 3. Core Workflows

### 3.1 Recipient evaluation, listing & waitlist
1. **Referral** (OP-021/OP-002) → **coordinator** opens transplant candidate file (`transplant_candidates`): organ (kidney/liver/heart/lung/pancreas/cornea/bone marrow), aetiology (ICD-10), blood group, height/weight/BMI, comorbidities, dialysis vintage (IP-022/OP-012), viral markers, HLA typing/PRA (OP-004), imaging, cardiac fitness, psychosocial & financial assessment, counselling; **evaluation checklist** template per organ (configurable) with status.
2. **Listing decision** by transplant board (meeting record, decision, urgency status: e.g., liver MELD-Na/PELD auto-computed from labs, heart status categories, kidney: dialysis time & waiting time, lung LAS optional); **consent for listing**; **SOTTO/NOTTO registration** (`transplant.notto_exchange`: export per state format / portal ID captured; API when available) → `waitlist_entries` with state registry id, listing date, status (active/temporarily inactive/removed/transplanted/died), score updates (MELD auto from latest labs; alerts to update ≥ per schedule), documents; multi-organ listing allowed.
3. Waitlist maintenance: periodic re-evaluation tasks (e.g., q3–6 months), status changes with reasons (inactive: infection/finance/unfit), death/removal; patient portal shows non-ranked status only (allocation ranks are registry-controlled).

### 3.2 Living-donor pathway (`transplant.living_donor`)
1. **Donor registration** (`donors` type=living): identity (Aadhaar/passport), relationship to recipient (near-relative: spouse/parent/child/sibling/grandparent/grandchild — or other with altruism justification), proof documents, photos, consent for evaluation; **work-up checklist** (blood group, HLA & crossmatch, GFR/liver volumetry, imaging, cardiac, psychiatric evaluation Form 4, infectious markers, pregnancy test, anaesthesia PAC IP-024).
2. **Authorisation committee** (hospital-based or state/district per case type): dossier auto-assembled (Forms 1/2/3 as applicable, Form 4, Form 5 (HLA), Form 11 (joint application), Form 6 (near-relative certification), relationship proofs, financial affidavits, video-recorded interview file link, foreign national embassy letter where needed) → **meeting scheduling**, quorum, hearing record, decision **Form 18** (approved/rejected/deferred with reasons), signatures/e-sign, appeal path; interpreter/counsellor attendance logged. Committee register maintained (THOTA).
3. Donor **surgery** episode (IP-006 case linked as `donor_nephrectomy/hepatectomy`), post-op donor care, **donor follow-up** registry (lifelong: BP, creatinine/LFT, psychosocial) with reminders (PE-002); donor safety incidents to NC-015.

### 3.3 Deceased-donor identification, certification & consent (`transplant.deceased_donor`)
1. **Trigger**: IP-009 events (GCS ≤ 5 + ventilated + catastrophic brain injury flag; `icu.brain_death.suspected`) → coordinator worklist "potential donor" (required-request policy: every brain death to be assessed & family approached per THOTA amendment / state rules); **donor screening**: absolute/relative contraindications (malignancy, HIV, sepsis, age), organ-function labs/imaging (CT/echo/bronchoscopy), donor-derived infection screening (IP-012).
2. **Brain-stem death certification** (IP-009 `brain_death_assessments`, Form 10): panel of four (RMO in-charge, treating doctor, neurologist/neurosurgeon or nominated specialist per state, independent doctor from panel approved by Appropriate Authority) → two examinations ≥ 6 h apart (children per rules) with pre-conditions/exclusions, brain-stem reflexes, apnoea test data (PaCO2 values), ancillary tests; time of death = second exam; **Form 10 PDF** e-signed by four; family informed of death first, donation request separate (decoupled discussion).
3. **Family counselling & consent**: counselling sessions logged (who, when, language, questions), grief support; **Form 8** consent by NOK/person in lawful possession (specific organs/tissues ticked, research/teaching allowed y/n), witnesses, video consent optional (EN-028), donor pledge check (Form 7/NOTTO pledge registry); refusal recorded with reason (registry stats). MLC donor → **police NOC** & PM coordination (TR-008): PM at hospital by forensic doctor after retrieval, inquest completed first; **Form 9** for unclaimed bodies (rare).
4. **Donor maintenance bundle** (IP-009 protocol): targets (MAP, urine output, Na, glucose, temperature, PaO2), hormone replacement, lung-protective ventilation, checklist compliance; donor labs schedule; ABO/HLA/viral markers → SOTTO **donor registration** (donor id) → **allocation** per state policy: local hospital's recipient list first (as per rules) → SOTTO waitlist ranking (portal) → offers to other hospitals; coordinator records **organ offers** (`organ_offers`: organ, offered_to (hospital), at, response accept/decline reason, deadline), sequential offer log for audit; national sharing via ROTTO/NOTTO for unused organs; tissues (corneas/skin/bone/heart valves) to tissue banks (`transplant.tissue_bank`).

### 3.4 Matching & recipient selection
1. For in-house recipients: **match run** for offered organ: ABO compatibility (incl. ABO-incompatible protocol flag), size/weight/age constraints, HLA typing & DSA/PRA (virtual crossmatch), waiting time & score (MELD/status), medical urgency, geographic/logistic factors, `unacceptable antigens` list, sensitisation, paediatric priority — ranked candidate list with reasons; **prospective crossmatch** ordered (IP-007/OP-004; CDC/flow) with TAT tracking; final selection recorded with rationale, backup recipient designated; SOTTO ranking overrides in-house ranking where policy dictates (state list); all decisions time-stamped for audit.
2. Recipient call-in: notify (phone log + SMS), NPO, admission (IP-001 `source=transplant_call`), pre-op labs, consent (recipient transplant consent + risks/organ-specific + Form 11 where living), pre-auth/scheme funding (RC-007), OT booking; if final crossmatch positive/unfit → next candidate, event logged.

### 3.5 Retrieval, transport & transplant episode
1. **Retrieval planning**: retrieval teams (in-house/visiting from recipient hospitals per organ), OT slot (IP-006/TR-004 emergency priority), sequence (heart/lungs → liver/pancreas → kidneys → tissues), cold ischaemia clocks per organ (cross-clamp time), perfusion solution/lot, packaging & labelling (organ label with donor id, ABO, organ, times; sealed containers), **transport** (NC-013 ambulance/green corridor request to police/traffic, air transport, chain-of-custody signatures at each hand-off), organ **received** at recipient hospital (time, condition, temperature log where available), unused organ disposition.
2. **Transplant OT** (IP-006 case type `transplant_{organ}`): anaesthesia (IP-024), operative record with anastomosis times, warm ischaemia, reperfusion, immediate graft function, implants/devices, blood products (IP-007), complications; **post-op ICU** (IP-009) transplant bundle.
3. **Immunosuppression protocol** (OP-002 order sets: induction — basiliximab/ATG; maintenance — tacrolimus/MMF/steroids; target trough levels by phase; prophylaxis — CMV/PJP/fungal) with drug-level monitoring schedule (OP-004 tacrolimus levels; auto-flag out of range → dose task), drug interactions (EN-029), high-cost drug procurement (IP-014).
4. Donor body: reconstruction, respectful handover via IP-017 (release checklist includes retrieval complete & PM if MLC); anonymity between donor family and recipient enforced (no cross-linking in portals/notifications).

### 3.6 Post-transplant follow-up & registry
1. **Follow-up schedule** auto-created (organ-specific: e.g., kidney twice weekly × 4 wk → weekly → monthly → q3 mo → yearly): visits (OP-002 clinic template with graft function labs, drug levels, BP, weight, urine protein, viral PCR CMV/BK, DSA yearly, biopsy records), rejection episodes (type/grade Banff, treatment), infections, malignancy screening, adherence check, quality of life; PE-002 reminders and PE-001 home diary (BP/weight/urine output/temperature).
2. **Outcomes registry**: graft survival, patient survival, delayed graft function, rejection rate, infection, readmissions, donor complications; **NOTTO/SOTTO reporting** (periodic returns, transplant registry data), THOTA registers (Forms 19–21: donor register, recipient register, annual report to Appropriate Authority) auto-generated; licence renewal reminders (NC-023).
3. **Living-donor follow-up** lifelong (see §3.2).

### 3.7 Exceptions
- Family declines donation → recorded, ICU proceeds with IP-002 death path; withdrawn consent before retrieval → stop, log.
- Donor becomes unstable/organ non-viable → offer withdrawn, SOTTO informed.
- Recipient not reachable/unfit at call → backup; no-show recorded.
- Positive final crossmatch → cancel, next candidate.
- MLC donor with police objection → retrieval blocked (TR-008 status).
- Committee rejection → appeal or closure; audit retains dossier.
- Post-transplant graft loss/death → waitlist re-listing where applicable, registry updates.

## 4. Data Model (schema `transplant`; highly restricted RLS + column encryption)
- **transplant.programmes** (hospital_id, branch_id, organ enum, licence_no (Appropriate Authority), licence_valid_till, sotto_hospital_id, notto_id, committee_type enum(hospital/state/district), active).
- **transplant.candidates** (id, hospital_id, branch_id, patient_id, organ, aetiology_icd10, blood_group, height, weight, bmi, comorbidities jsonb, dialysis_vintage_months?, hla jsonb {a,b,c,dr,dq,dp}, pra_pct, unacceptable_antigens jsonb, viral_markers jsonb, evaluation_checklist jsonb [{item, status, doc_id}], psychosocial jsonb, financial jsonb, board_decision enum(pending/listed/not_listed/deferred), board_meeting_id?, status enum(evaluating/listed/inactive/transplanted/removed/died), consent_listing_id) — index (hospital_id, organ, status).
- **transplant.waitlist_entries** (id, candidate_id, registry enum(sotto/notto/in_house), registry_id, listed_at, status enum(active/inactive/removed/transplanted/died), inactive_reason?, urgency_status, score_type enum(meld_na/peld/las/heart_status/kidney_points/none), score numeric, score_at, score_inputs jsonb, next_review_due, removed_reason?, removed_at) — index (registry, status).
- **transplant.donors** (id, hospital_id, branch_id, donor_type enum(living/deceased_brain_death/deceased_dcd/tissue_only), patient_id? (living donor is a patient; deceased donor links admission), admission_id?, blood_group, hla jsonb, viral_markers jsonb, demographics jsonb, relationship_to_recipient?, relationship_proofs jsonb, contraindications jsonb, screening_status, brain_death_cert_id? (IP-009 Form 10), time_of_death?, consent_form8_id?, consent_refused bool, refusal_reason?, mlc bool, police_noc jsonb, pledge_ref?, sotto_donor_id?, maintenance_bundle_compliance jsonb, status enum(potential/evaluating/certified/consented/registered/retrieval_scheduled/retrieved/closed/declined/unfit)) — index (hospital_id, donor_type, status).
- **transplant.living_donor_workups** (donor_id, checklist jsonb, psychiatric_form4_id, hla_form5_id, forms jsonb {form1/2/3, form11, form6}, video_interview_file_id, status).
- **transplant.authorisation_committees** (id, hospital_id, type, meeting_at, members jsonb, quorum_ok, cases jsonb [{donor_id, candidate_id, decision, form18_id, reasons}], minutes_file_id, signed_at, register_no).
- **transplant.counselling_sessions** (donor_id?/candidate_id?, at, by, language, attendees jsonb, notes, outcome enum(consented/declined/undecided)).
- **transplant.organ_offers** (id, donor_id, organ, offered_to enum(in_house/hospital), hospital_id?, external_hospital_id?, offered_at, deadline_at, response enum(accepted/declined/expired), response_reason, responded_at, sequence_no, sotto_ref).
- **transplant.match_runs** (id, donor_id, organ, run_at, run_by, criteria jsonb, candidates jsonb [{candidate_id, rank, abo_ok, size_ok, hla_mismatch, dsa_flag, virtual_xm, score, reasons}], selected_candidate_id, backup_candidate_id, rationale, sotto_rank_used bool).
- **transplant.crossmatches** (donor_id, candidate_id, type enum(cdc/flow/virtual), ordered_at, lab_order_id, result enum(negative/positive/indeterminate), result_at, by).
- **transplant.episodes** (id, donor_id?, candidate_id, organ, recipient_admission_id, ot_case_id (IP-006), retrieval_ot_case_id?, cross_clamp_at, cold_ischaemia_start, organ_received_at, anastomosis_at, reperfusion_at, cold_ischaemia_min, warm_ischaemia_min, perfusion_solution jsonb, transport jsonb {mode, trip_id, custody[]}, immediate_graft_function enum(immediate/delayed/primary_non_function), complications jsonb, immunosuppression_protocol_id, outcome enum(functioning/graft_loss/death), version) — index (candidate_id), (donor_id).
- **transplant.followups** (episode_id, due_at, done_at?, visit_id?, labs jsonb {creatinine/egfr/lft/tacrolimus_level…}, rejection jsonb?, infection jsonb?, adherence, notes, status enum(due/done/missed)) ; **transplant.rejection_episodes** (episode_id, at, type, grade_banff?, biopsy_id?, treatment, outcome).
- **transplant.donor_followups** (donor_id, due_at, done_at, labs jsonb, bp, complications, status).
- **transplant.registry_reports** (programme_id, period, type enum(notto_return/sotto_return/annual_report/form19/form20/form21), generated_at, file_id, submitted_at, ref).
- **transplant.tissue_bank_items** (`transplant.tissue_bank`: donor_id, tissue enum(cornea/skin/bone/heart_valve/other), retrieved_at, processing jsonb, storage_location, expiry, issued_to, issued_at, status).
- Read models: `analytics.mv_transplant_outcomes` (graft/patient survival by organ/year), `analytics.mv_donation_funnel` (potential → certified → consented → retrieved; refusal reasons), `analytics.mv_waitlist_summary`.

## 5. Business Rules & Validations
- Programme per organ must have valid Appropriate Authority licence (`licence_valid_till` ≥ today) to list/transplant; expiry ≤ 90 d → NC-023 alert; hard-block on expired (MS override with reason for emergency continuity documented).
- Brain-death certification enforces: four-member panel composition rule (state-configurable), ≥ 6 h between exams (12/24 h for children per rules), pre-condition/exclusion checklist complete, apnoea test data, all four e-signatures → Form 10; time of death = second exam; family informed of death recorded before consent request timestamp.
- Form 8 consent must be by person in lawful possession/NOK with witnesses; organs retrieved cannot exceed consented set (hard-stop at retrieval record); refusal recorded with reason.
- MLC donor: retrieval blocked until police NOC recorded (TR-008); PM arrangements logged.
- Living donation: near-relative proof or authorisation committee approval (Form 18) required before OT booking; foreign donor/recipient additional documents; committee quorum enforced; video interview stored encrypted.
- Match run: ABO incompatibility hard-stop unless ABOi protocol flagged & consented; positive final crossmatch hard-stop; selection rationale mandatory; SOTTO ranking precedence configurable per state policy; all offers/declines time-stamped, sequence immutable.
- Cold ischaemia clocks visible with organ-specific max (kidney 24 h, liver 12 h, heart/lung 4–6 h) — warnings.
- Recipient anonymity: no PHI of donor to recipient/family and vice versa in any UI/notification; separate access scopes; access to transplant schema restricted to programme roles with break-glass audit.
- Immunosuppressant levels out of range → task within 1 h of result; missed follow-up → reminder + coordinator task; annual DSA/biopsy per protocol.
- Registers Forms 19–21 generated from data, immutable snapshots per period; annual report reminder.
- Retention: permanent; DPDP: highest sensitivity class; consent for portal display; deletion requests not applicable (legal hold).

## 6. API Surface (`/api/v1/transplant`)
| Method | Path | Purpose | Permission |
|---|---|---|---|
| GET/POST/PATCH | `/programmes` | licence/config | `transplant.programme.manage` |
| POST/GET/PATCH | `/candidates` , `/candidates/{id}` ; POST `/candidates/{id}/board-decision` | evaluation/listing | `transplant.candidate.write` / `.read` |
| POST/PATCH/GET | `/waitlist` , `/waitlist/{id}/status` , `/waitlist/{id}/score/recompute` | waitlist | `transplant.waitlist.write` |
| POST/GET/PATCH | `/donors` ; POST `/donors/{id}/screening` , `/donors/{id}/counselling` , `/donors/{id}/consent` , `/donors/{id}/police-noc` , `/donors/{id}/register-sotto` | donor pathway | `transplant.donor.write` |
| POST/GET | `/living-donors/{id}/workup` ; POST `/committees` , `/committees/{id}/decision` ; GET `/committees/{id}/dossier.zip` | living donor & committee | `transplant.committee.manage` |
| POST/GET | `/donors/{id}/offers` ; POST `/offers/{id}/respond` | organ offers | `transplant.offer.write` |
| POST | `/donors/{id}/match-run` ; POST `/match-runs/{id}/select` ; POST `/crossmatches` | matching | `transplant.match.run` |
| POST | `/episodes` ; PATCH `/episodes/{id}` (times, transport, custody, outcome) | transplant episode | `transplant.episode.write` |
| GET/POST | `/episodes/{id}/followups` ; POST `/episodes/{id}/rejections` ; GET/POST `/donors/{id}/followups` | follow-up | `transplant.followup.write` |
| GET | `/forms/{form}/{entityId}.pdf` (10, 8, 18, 19–21…) ; POST `/registry-reports/generate` | THOTA forms/reports | `transplant.report.read` |
| GET | `/dashboard` , `/reports/*` | | `transplant.report.read` |
All endpoints under `transplant.*` require programme-role membership (ABAC) plus break-glass audit for others.

## 7. Domain Events (outbox)
- `transplant.candidate.listed|status_changed` {organ, registry_id} → PE-001 (status), coordinator tasks.
- `transplant.waitlist.score_updated` {score} → registry sync.
- `transplant.donor.potential` (from IP-009 `icu.brain_death.suspected`) → coordinator worklist; `transplant.donor.certified` (Form 10) → family counselling task, IP-002 death time; `transplant.donor.consented|declined` → SOTTO registration / IP-002 & IP-017 normal path.
- `transplant.offer.made|accepted|declined|expired` → coordinator, SOTTO log.
- `transplant.match.selected` {candidate} → recipient call-in tasks (IP-001 admission, IP-006 OT request, RC-007), backup notified.
- `transplant.crossmatch.result` {result} → selection flow.
- `transplant.retrieval.scheduled|completed` {organs, cross_clamp_at} → IP-006/TR-004, NC-013 (transport/green corridor), IP-017 (release checklist), tissue bank.
- `transplant.episode.completed` {organ, immediate_function} → follow-up schedule creation, registry, IP-009 bundle.
- `transplant.followup.due|missed` , `transplant.drug_level.out_of_range` → PE-002, doctor task.
- `transplant.licence.expiring` → NC-023, MS.
- Consumed: `icu.brain_death.suspected|certified` (IP-009), `lab.result.final` (HLA/levels/crossmatch), `ot.case.completed` (IP-006), `ambulance.trip.*` (NC-013), `mlc.police_noc.received` (TR-008), `ip.death.declared`, `mortuary.body.released` (IP-017), `patient.deceased`.

## 8. Screens (UI)
- **Transplant Coordinator Dashboard** (desktop; phone summary): potential donors (ICU triggers), active donor cases with stage timeline & clocks, offers pending, recipients on call-in, follow-ups due, licence/registry reminders; live.
- **Candidate File & Waitlist** (desktop): evaluation checklist with document uploads, scores (MELD auto), board decisions, registry ids, status history; list view with filters (organ, status, blood group, PRA).
- **Deceased Donor Case** (desktop/tablet): tabs Screening | Brain-death (IP-009 Form 10 panel view) | Counselling & Consent (Form 8 capture with witnesses, video) | Maintenance bundle | Labs/Imaging | SOTTO & Offers (sequence log) | Match run (ranked table with reasons) | Retrieval plan (organ clocks, teams, OT, transport, custody) | Body handover.
- **Living Donor & Committee** (desktop): work-up checklist, dossier builder, committee scheduler, hearing record, Form 18 decision with e-sign.
- **Transplant Episode Record** (desktop/tablet in OT): ischaemia timers, times, transport custody, immediate function.
- **Follow-up Clinic View** (desktop; recipient PE-001 diary): schedule, labs/levels trend, rejection/infection log, adherence.
- **Registry & Forms** (desktop): generate/print THOTA forms & returns; audit trail.

## 9. Integrations
- SOTTO/NOTTO portals (manual/CSV now; API via EN-017 when provided), HLA lab (OP-004/LIS or external), IP-007, IP-009 brain-death module, IP-006/TR-004 OT, NC-013/TR-009 transport & green corridor (police/traffic request template), TR-008 police NOC, EN-016 e-sign (Form 10/8/18), EN-028 consent/video, RC-007 scheme funding, PE-001/PE-002, NC-023 licence tracker, EN-039 THOTA form templates (state variants).

## 10. Reports & Analytics
- Donation funnel (potential → certified → approached → consented → retrieved; refusal reasons; conversion rate), organs retrieved/utilised, cold ischaemia times, waitlist size/mortality/median waiting time by organ & blood group, transplants by type (living/deceased), graft & patient survival (1/3/5 y KM), rejection/infection rates, DGF, readmissions, living-donor complications, committee TATs, follow-up compliance, drug-level in-range %, THOTA registers (19–21), annual report, NOTTO returns.
- MVs: `analytics.mv_transplant_outcomes`, `analytics.mv_donation_funnel`, `analytics.mv_waitlist_summary`.

## 11. Notifications
- Push/phone-log: potential donor alert to coordinator (24×7), certification exam due (6 h timer), offer deadline, crossmatch result, recipient call-in (SMS + call log), OT/transport readiness, follow-up due/missed, drug level out of range, licence expiring.
- Recipient (PE-001/EN-009): appointment/lab reminders, medication reminders (opt-in), status "active on list" only.
- No donor-identifying info to recipients or vice versa.

## 12. Permissions (RBAC keys; ABAC programme membership)
`transplant.programme.manage` (4, 3), `transplant.candidate.write` (transplant surgeon 9, physicians 6/7, coordinator), `transplant.candidate.read` (programme roles, 27/28 limited billing view, 58), `transplant.waitlist.write` (coordinator, 9), `transplant.donor.write` (coordinator, 11, 9), `transplant.committee.manage` (4, coordinator, legal), `transplant.offer.write` (coordinator, 9), `transplant.match.run` (9, coordinator, 13 HLA read), `transplant.episode.write` (9, 10, 20, 11), `transplant.followup.write` (9, 6/7, coordinator, 17), `transplant.report.read` (4, 54, 43, 58, coordinator).

## 13. Non-functional
- Volumes: 100–400 transplants/y programme; waitlist 500–3000; follow-ups 20k/y; timers/clocks accurate to seconds (server time); dashboard p95 < 300 ms; dossier zip generation async.
- Security: dedicated schema, RLS + role membership, column encryption for identity docs/videos, break-glass logging, no PHI in notifications; retention permanent; legal hold.
- Offline: OT ischaemia timers continue offline (client) and sync; consent capture requires online (e-sign).
- Print: THOTA forms (state variants via EN-039), organ labels (EN-005), registers A4.

## 14. Acceptance Criteria
1. Given IP-009 flags a ventilated patient GCS 3 with catastrophic brain injury, then a potential-donor item appears on the coordinator dashboard within 1 min with screening checklist.
2. Given first brain-death examination at 10:00, when a second is attempted at 14:00, then the system blocks (< 6 h) and shows earliest allowed time; with four valid panel members and both exams complete, Form 10 PDF is generated with e-signatures and time of death set to the second exam.
3. Given family consent Form 8 for kidneys and corneas only, when retrieval record tries to add liver, then hard-stop.
4. Given an MLC donor without police NOC, then retrieval scheduling is blocked and TR-008 task is shown.
5. Given a match run for a B+ donor kidney, then A+ candidates are excluded (ABO), candidates with DSA against donor HLA are flagged, ranking shows reasons, and selection requires rationale + backup.
6. Given final CDC crossmatch positive for the selected candidate, then the episode cannot proceed and the backup is promoted with event log.
7. Given cross-clamp at 02:10 for a liver, then the cold-ischaemia clock shows on all screens and warns at 10 h.
8. Given a living-donor case with a non-near-relative donor, then OT booking is blocked until Form 18 approval is recorded with committee quorum.
9. Given transplant completed, then organ-specific follow-up schedule is generated, and a tacrolimus level below range triggers a doctor task within 1 h of result.
10. Given a recipient portal user, when viewing status, then only "Active on waitlist" is shown, never rank or donor details.
11. Given a user outside programme roles, when accessing /transplant/donors, then 403 unless break-glass with reason (audited to DPO).
12. Given the annual report request, then Forms 19–21 are generated from data with immutable snapshot and listed in registry reports.

## 15. Enhancements / Later phases
- Direct NOTTO/SOTTO API integration and national waitlist sync; organ perfusion machine telemetry (EN-042); AI donor-recipient outcome prediction (AI-005); tissue-bank inventory expansion; recipient app with adherence gamification (PE-005); tele-follow-up (OP-018); paired kidney exchange (swap) matching; multi-centre registry benchmarking (EN-041); public pledge (Form 7) capture via website (EN-012).

## 16. Open Questions for the Hospital
1. Organs/tissues licensed and licence numbers/validity; SOTTO/ROTTO region and portal access; committee type (hospital-based/state)?
2. State allocation policy specifics (local list precedence, ranking rules) and forms/register formats used?
3. Brain-death panel composition approved by Appropriate Authority; apnoea test protocol?
4. Family counselling process, languages, video consent practice, grief support staff?
5. HLA lab in-house or external (which); crossmatch methods; virtual crossmatch use?
6. Immunosuppression protocols per organ; drug-level monitoring schedule; high-cost drug funding (schemes)?
7. Follow-up schedule per organ and portal/home-monitoring expectations?
8. Green-corridor/transport arrangements with police/airport; tissue bank operations?
9. Data sharing rules with NOTTO registry and research (consent)?
