# TR-007 — Polytrauma Coordination Dashboard (multi-specialty consults, surgical priority queue, blood requirement, consent tracking, team paging)

| Field | Value |
|---|---|
| Domain | Trauma & Orthopaedics |
| Module ID | TR-007 |
| Phase | 6 |
| Priority | P0 |
| Complexity | High |
| Depends on | TR-001 (episode, injuries, scores, activation), OP-006 (ER visit, disposition, on-call alerts), TR-002 (fractures & plans, sequencing proposal), TR-004/IP-006 (emergency OT queue, cases), TR-006/IP-009 (ICU physiology, surgery-readiness), IP-007 (blood requirement/cross-match/MTP status), IP-001 (beds/ICU holds), OP-021 (referral/consult engine), OP-002/IP-003 (consult notes, orders), EN-028 (consent tracking), EN-037 (paging/escalation), NC-030 (rosters), EN-018 (TV boards), TR-008 (MLC status), TR-003 (implant readiness), OP-008/OP-004 (pending diagnostics), IP-018 (transfer), IP-005/EN-002/RC-008 (estimates, pre-auth for multi-procedure), TR-010 (rehab entry), TR-011 (registry), EN-038 (workflow/SLA), EN-024 |
| Feature flag | `module.polytrauma_board.enabled` (sub: `ptb.sequencing_assist`, `ptb.family_view`, `ptb.tv_board`) |
| Primary roles | Trauma team leader / Trauma surgeon (9), Emergency physician (8), Intensivist (11), Orthopaedic/Neuro/General/Vascular/Plastic/CTVS/Maxillofacial surgeons (9), Anaesthetist (10), Trauma coordinator nurse (22/19) |
| Secondary roles | Blood bank (37), OT coordinator (20/22), Radiologist (12), Nurse ICU/ward (18/17), Physiotherapist (40), Counsellor, Insurance/TPA desk (28), Billing (27), MRD (43), Quality (54), MS (4), Family (60, family view), Auditor (58) |
| Regulatory | NABH 5th ed. COP.3/COP.4/COP.14 (multidisciplinary care planning, consent, safe surgery), ATLS/damage-control resuscitation & DCO principles (Pape/Giannoudis), NPPMTBI trauma-centre coordination norms, ACS-COT "Resources for Optimal Care" (trauma service, consult response times), informed consent law (patient/relative/emergency doctrine, MS approval), MV Act §162 golden-hour scheme & PMJAY emergency (multi-procedure pre-auth), MLC (CrPC/BNSS), DPDP (family access with consent) |

## 1. Purpose
TR-007 is the single shared "air-traffic control" view for a polytrauma patient: one card per patient aggregating injuries and scores (TR-001/TR-002), physiology and surgery-readiness (TR-006), **surgical priority queue** across specialties with damage-control vs definitive sequencing (life → limb → function), consult requests with response SLAs and paging, blood requirement vs available (IP-007), consent status per planned procedure (EN-028), pending diagnostics, team assignments, timers and MLC/insurance flags. It runs on the trauma bay/ICU wall boards, surgeons' phones and the trauma coordinator's desktop, and it is where the multidisciplinary trauma round is documented and disagreements/priorities are resolved.

## 2. Users & Jobs-to-be-done
- **Trauma team leader** (tablet/desktop): open the polytrauma case, set overall phase (resuscitation → damage control → ICU stabilisation → definitive → rehab), pull consults, order priorities in the surgical queue, run the multidisciplinary huddle, hand ownership to admitting service, keep the family informed.
- **Specialty surgeons** (phone push + tablet): receive consult with SLA, acknowledge/ETA, document consult note & recommendation (operate now / delay / non-operative), propose case into queue with urgency class (feeds TR-004), see readiness window from ICU.
- **Anaesthetist/intensivist**: physiology & readiness view, sequencing input, blood/MTP planning, sedation for procedures.
- **Trauma coordinator nurse** (desktop): keep the board accurate — consents obtained/pending, blood units cross-matched/issued, implants/loaners ready (TR-003), diagnostics pending, transport bookings, family contact & counselling, insurance/pre-auth for multiple procedures (RC-008/EN-002), MLC status (TR-008), rehab referral (TR-010) at the right time.
- **Blood bank**: see aggregate blood requirement of all active polytrauma cases (units by component and group), MTP status, upcoming surgeries needing blood.
- **OT coordinator**: see priority queue → TR-004 scheduling.
- **Family** (`ptb.family_view`; phone/kiosk with token): consented, plain-language status stages (in ER / in surgery / in ICU / stable), next update time — no clinical detail.
- **Quality/MS**: consult response times, time-to-definitive-care, consent completeness, disputes.

## 3. Core Workflows

### 3.1 Case creation & card composition
1. **System** auto-creates a **polytrauma case** when TR-001 activation Level 1/2 fires, or ISS (provisional) ≥ 16, or ≥ 2 body regions with AIS ≥ 2, or manual creation by team leader ("open on board") → **card** aggregates in real time: identity (tag/UHID, age/sex, MLC), mechanism, injuries by region with AIS (TR-001), fractures/plans (TR-002), scores (GCS/RTS/ISS/TRISS), interventions & timers (tourniquet, binder, MTP), physiology + readiness (TR-006 or ER vitals), pending diagnostics (OP-004/OP-008 with status), blood (requirement/cross-matched/issued/MTP), consents, consults, surgical queue entries, location (bay/CT/OT/ICU/ward), assigned team, phase, insurance/scheme, family contact/next update, rehab status → Event `polytrauma.case.opened`.
2. Case **phase** set by team leader; phase changes emit events (drives checklists: e.g. definitive phase → rehab referral prompt).
3. Ownership: primary service (trauma surgery/ortho/neuro) & consultant; hand-over between services requires acceptance (SBAR + acknowledgment).

### 3.2 Multi-specialty consults with SLA
1. **Team leader/EM physician** requests consult(s) from card (specialty, urgency: immediate ≤ 15 min bedside / urgent ≤ 60 min / routine ≤ 4 h; question; relevant injuries auto-attached) → **System** resolves on-call (NC-030) → pages (EN-037: push/SMS/WhatsApp/IVR) → **Specialist** acknowledges with ETA (phone) → arrival scan/mark → consult note (OP-002 consult template: findings, diagnosis, recommendation: operate now/delayed/non-op/transfer, proposed procedure with urgency class, blood/implant needs, consent needed) → **System** turns recommendation into **queue proposal** (§3.3) → Event `polytrauma.consult.completed`; SLA breach → escalation ladder (backup, HOD, MS) via EN-038 & logged (OP-006 `on_call_alerts` reused for delivery, TR-007 owns consult record).
2. Consult disagreements/priorities → **huddle** (§3.4).

### 3.3 Surgical priority queue & sequencing (`ptb.sequencing_assist`)
1. Each proposed procedure becomes a **queue item**: procedure, specialty, surgeon, urgency class (TR-004 classes), estimated duration, dependencies (e.g. "after laparotomy", "needs vascular first", "same anaesthetic as"), blood/implant/equipment needs, consent status, readiness gate (physiology from TR-006: damage-control allowed vs definitive requires ready).
2. **System suggests order** by rule set: airway/breathing/haemorrhage control > neurosurgical decompression (GCS/CT) > vascular/limb ischaemia > open fractures/debridement > unstable pelvis/long-bone stabilisation (ex-fix in DCO; nail if physiology allows) > spine stabilisation > soft-tissue cover > maxillofacial/others; combined-session suggestions (same anaesthetic, two teams) and DCO vs ETC (early total care) hint from physiology (lactate, temp, INR, platelets, ISS, chest injury) → **Team leader** confirms/edits order with reason (audited) → confirmed items pushed to TR-004 emergency queue with priority score; readiness re-evaluated hourly (TR-006) — a definitive item auto-holds while "not ready" and re-alerts when ready.
3. Sequencing changes (new finding, deterioration) → re-order with reason → all teams notified; completed cases (TR-004 events) update card; relooks/planned second stages appear as scheduled queue items.

### 3.4 Multidisciplinary huddle / trauma round
- Team leader starts **huddle** (bedside/virtual): attendees (scan/pick), agenda auto-built (open decisions, queue, readiness, consents, blood, pending results, family, MLC, disposition), decisions recorded per item (owner, due), disagreements escalated to trauma director/MS; note signed; tasks to IP-003/EN-038; next huddle time set (daily for phase ICU) → Event `polytrauma.huddle.recorded`.

### 3.5 Blood requirement & consent tracking
1. **Blood**: card shows requirement aggregated from queue items & MTP (units by component: PRBC/FFP/platelets/cryo; group & antibody screen status; cross-matched/reserved/issued via IP-007) → coordinator/blood bank see hospital-wide **polytrauma blood demand** panel (next 24 h) with shortage flags → requests to IP-007 with priority; MTP status (active/cooler out/stood down) and ratio compliance shown.
2. **Consent** per planned procedure/blood/anaesthesia/high-risk: status (not started/explained/signed/refused/emergency-doctrine/MS-approved) with signer relation & ID, language, interpreter, e-sign (EN-028/EN-016), expiry (re-consent if plan changes), MLC-specific consents (examination/photography), organ-donation (later); missing consent blocks TR-004 Sign In (readiness item) — coordinator worklist "consents pending".

### 3.6 Team assignment, tasks & communication
- Named team per case (leader, primary surgeon, anaesthetist, intensivist, coordinator nurse, consultants) with on-call rotation auto-suggestions; task list (EN-038: e.g. "cross-match 6 units", "book CT angio", "arrange loaner nail set", "counsel family 18:00", "pre-auth for 3 procedures"); secure group chat/thread per case (in-app, audited, no external messengers) with @mentions and read receipts (EN-037); broadcast to team on phase change/deterioration.

### 3.7 Insurance, cost & administrative coordination
- Multi-procedure **estimate** (RC-008) and pre-auth bundle (EN-002; PMJAY multi-package RC-007; MV Act golden-hour cashless) tracked on card with status/expiry; MLC status & police intimation (TR-008) badge; unknown-patient identification tasks; transfer-out coordination (IP-018) when capability lacking; rehab referral (TR-010) & discharge planning entry once phase = definitive/recovery.

### 3.8 Family communication (`ptb.family_view`)
- Coordinator records family contacts + consent for updates; **family status view** (kiosk/phone link with token, no login) shows stage and next update time; scheduled updates & counselling notes; bereavement/complaint pathway links (NC-032); interpreter needs.

### 3.9 Exceptions & edge cases
1. **Specialist not on roster / all busy in OT**: consult routes to backup, then HOD, then "any available" pool with broadcast; if none, tele-consult (OP-018) or transfer-out decision by team leader with MS notification.
2. **Conflicting recommendations** (neuro says operate now, ortho says stabilise first): both recorded; huddle mandatory within 30 min; team leader decision with rationale; disagreement escalation to trauma director; audit trail for M&M.
3. **Patient/relative refuses a procedure**: queue item cancelled with refusal consent (EN-028); alternatives documented; family counselling task; item can be re-proposed later.
4. **Deterioration during OT of another item**: TR-004 events update card; queue auto-holds definitive items; team leader re-sequences.
5. **Insurance pre-auth denied mid-course**: card shows financial risk flag; MSW/insurance desk tasks; care continues (no gating), scheme alternatives (PMJAY/MV Act) explored.
6. **Unknown patient identified**: card re-points to UHID; family view enabled only after identity confirmation & consent.
7. **Case spans branches** (transfer within group): case exported/imported with `transferred_from_case_id`; consult history preserved (EN-041).
8. **Board network outage**: cached snapshot with age banner; consult paging falls back to SMS/IVR; queue changes disabled until reconnect (no stale writes).

### 3.10 Closure
- Case closes at ICU/ward discharge to rehab or transfer/death; closure checklist: all queue items done/cancelled, consents archived, registry fields (TR-011) complete, family debrief done, M&M flag if unexpected outcome (TRISS) → Event `polytrauma.case.closed`.

## 4. Data Model (schema `trauma`)
- **polytrauma_cases**: id, hospital_id, branch_id, patient_id?, temp_tag_id?, trauma_episode_id (TR-001) unique, er_visit_id, admission_id?, opened_at, opened_by, open_reason enum(activation/iss/regions/manual), phase enum(resuscitation/damage_control/icu_stabilisation/definitive/recovery/closed), phase_history jsonb[], primary_service, primary_consultant_id, team_leader_id, coordinator_id, location_type enum(er_bay/ct/ot/icu/ward/transfer), location_ref, is_mlc, mlc_id?, insurance_status jsonb (payer, preauth ids, statuses), family_consent_ref?, next_family_update_at?, closed_at?, closure_checklist jsonb, outcome enum(discharged_rehab/discharged_home/transferred/died/lama)?, version.
- **pt_consults**: id, case_id, specialty, urgency enum(immediate/urgent/routine), sla_minutes, question, requested_by, requested_at, on_call_user_id, alert_id (OP-006 on_call_alerts), acknowledged_at, eta_min, arrived_at, completed_at, note_doc_id (OP-002 consult), recommendation enum(operate_now/operate_delayed/non_operative/transfer/follow_up), proposed_procedure jsonb, status enum(requested/acknowledged/arrived/completed/cancelled/escalated), escalation_log jsonb[], breached bool.
- **pt_queue_items**: id, case_id, procedure_code, procedure_display, specialty, surgeon_id, urgency_class enum(immediate/urgent/expedited/elective), est_duration_min, dependencies uuid[], same_session_group?, needs jsonb (blood, implants (TR-003 reservation ids), equipment), consent_id?, readiness_gate enum(none/dco_ok/definitive_requires_ready), readiness_status enum(ready/not_ready/na), suggested_rank int, confirmed_rank int, rank_reason, ot_request_id? (TR-004), ot_case_id?, status enum(proposed/confirmed/held/scheduled/in_ot/completed/cancelled), created_by, created_at, updated_at.
- **pt_sequencing_runs**: case_id, at, inputs jsonb (physiology, injuries), suggested_order jsonb, rules_version, confirmed_by, confirmed_at, diff jsonb.
- **pt_huddles**: id, case_id, started_at, ended_at, attendees uuid[], agenda jsonb, decisions jsonb[] ({item, decision, owner, due_at, task_id}), disagreements jsonb, signed_by, signed_at, next_at.
- **pt_blood_requirements**: case_id, component enum(prbc/ffp/platelets/cryo/whole), units_required, units_crossmatched, units_issued, source enum(queue_item/mtp/manual), queue_item_id?, updated_at (denormalised from IP-007 events).
- **pt_consents**: id, case_id, subject_type enum(procedure/anaesthesia/blood/high_risk/photography/mlc_exam/organ_donation/other), subject_ref (queue_item_id?), status enum(not_started/explained/signed/refused/emergency_doctrine/ms_approved/expired), consent_doc_id (EN-028), signer_name, signer_relation, signer_id_type, language, interpreter bool, obtained_by, obtained_at, expires_at, notes.
- **pt_team_members**: case_id, role enum(leader/primary_surgeon/anaesthetist/intensivist/coordinator/consultant/nurse), user_id, from_at, to_at, source enum(auto/manual).
- **pt_tasks** (EN-038 workflow refs): case_id, task_id, title, owner_role/user, due_at, status.
- **pt_threads/pt_messages**: case_id, author, body, mentions uuid[], attachments (file ids), read_by jsonb, at (append-only, audited).
- **pt_family_contacts**: case_id, name, relation, phone, consent_ref, preferred_language, is_primary; **pt_family_updates**: case_id, at, by, stage_shown enum(er/surgery/icu/ward/stable/critical), note, delivered_via, next_at.
- **pt_board_snapshot** (read model, refreshed on events / ≤ 15 s): case_id, card jsonb.
- Indexes: polytrauma_cases (hospital_id, branch_id, phase, opened_at desc), (patient_id); pt_consults (case_id, status), (on_call_user_id, status); pt_queue_items (case_id, status, confirmed_rank), (hospital_id, status, urgency_class); pt_consents (case_id, status). RLS; huddles/messages append-only; retention ≥ 10 y (permanent if MLC).

## 5. Business Rules & Validations
- Auto-open criteria configurable (defaults §3.1); duplicate cases per trauma episode prevented (unique); manual open requires reason.
- Consult SLA defaults: immediate 15 min to bedside, urgent 60 min, routine 4 h; ack required within 5/10/30 min; breach → escalation ladder (backup on-call → HOD → MS) with each step logged; a consult cannot be "completed" without a signed note.
- Queue: every confirmed item must have surgeon, urgency class, consent status and readiness gate; definitive (non-DCO) items are auto-held while readiness = not_ready (TR-006) unless team leader overrides with reason (audited, Quality report); order changes require reason; only team leader/trauma director can confirm order; TR-004 receives confirmed items only.
- Sequencing rules versioned (EN-029 DSL) with defaults per §3.3; suggestions are advisory — never auto-schedule surgery.
- Blood requirement recomputed on queue/MTP change; if required > cross-matched at T-60 min of scheduled OT → alert blood bank & coordinator; MTP ratio compliance (1:1:1 target) shown from IP-007.
- Consent statuses: emergency doctrine requires two doctors (TR-004 rule) and MS notification; refusal documented with counselling; consent expires when the plan (procedure/side) changes → re-consent task; missing consent = readiness blocker in TR-004.
- Family view: token-based, no clinical detail, only for consented contacts; revoke on request; MLC/unknown patients — family view only after identity confirmed and per police/MS policy.
- Ownership hand-over between services requires acceptance within 30 min else escalates; card always shows a responsible consultant.
- Case closure requires: no open queue items (done/cancelled), consents archived, TR-011 mandatory fields complete (or flagged), family debrief recorded (or NA); unexpected outcome (death with TRISS Ps > 0.5, or major complication) auto-adds M&M flag.
- Board visibility: specialists see all cases in branch; ward/ICU nurses see cases in their unit; family view is separate; TV boards show bed/tag/initials & stage only.
- Numbering: polytrauma case no `PTC` series (branch/FY).

## 6. API Surface (`/api/v1/trauma/polytrauma`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /cases | open case (manual) | trauma.ptb.case.create | Y | – |
| GET | /cases/{id} | full card | trauma.ptb.case.read | – | – |
| GET | /board?unit=&phase= | board read model | trauma.ptb.board.read | – | – |
| PATCH | /cases/{id}/phase, /ownership, /team | phase/ownership/team | trauma.ptb.case.manage | Y | – |
| POST | /cases/{id}/consults | request consult(s) | trauma.ptb.consult.request | Y | – |
| POST | /consults/{id}/ack, /arrive, /complete, /escalate, /cancel | consult lifecycle | trauma.ptb.consult.respond / request | Y | – |
| GET | /consults?mine=&status= | specialist's consults | trauma.ptb.consult.respond | – | cursor |
| POST | /cases/{id}/queue | propose queue item | trauma.ptb.queue.propose | Y | – |
| POST | /cases/{id}/queue/suggest | run sequencing suggestion | trauma.ptb.queue.confirm | – | – |
| POST | /cases/{id}/queue/confirm | confirm order (ranks, reasons) → TR-004 | trauma.ptb.queue.confirm | Y | – |
| PATCH | /queue/{itemId} | edit/hold/cancel item | trauma.ptb.queue.propose / confirm | Y | – |
| GET | /queue?branch=&status= | hospital-wide surgical priority queue | trauma.ptb.board.read | – | cursor |
| POST | /cases/{id}/huddles, PATCH /huddles/{id}, POST /huddles/{id}/sign | huddle record | trauma.ptb.huddle.write / sign | Y | – |
| GET | /blood-demand?hours=24 | aggregated blood requirement | trauma.ptb.blood.read | – | – |
| POST/PATCH | /cases/{id}/consents[/{cid}] | consent tracking | trauma.ptb.consent.manage | Y | – |
| POST/GET | /cases/{id}/tasks, /messages | tasks & thread | trauma.ptb.case.manage / read | Y | cursor |
| POST/GET | /cases/{id}/family-contacts, /family-updates | family comms | trauma.ptb.family.manage | Y | – |
| GET | /family/{token} | family status view (public, token) | – (token) | – | – |
| POST | /cases/{id}/close | closure with checklist | trauma.ptb.case.close | Y | – |
| GET | /reports/kpi?from=&to= | consult SLA, time-to-definitive, consents | trauma.ptb.report.read | – | – |
| GET/PUT | /config/open-criteria, /config/sla, /config/sequencing-rules | config | trauma.ptb.configure | Y | – |

## 7. Domain Events (outbox)
- `polytrauma.case.opened|phase_changed|ownership_changed|closed` → EN-018 boards, TR-010 (rehab entry on recovery), TR-011, IP-001.
- `polytrauma.consult.requested|acknowledged|arrived|completed|breached|escalated` → EN-037 pages, OP-006 on-call KPIs, Quality.
- `polytrauma.queue.proposed|confirmed|reordered|held|released|cancelled` → TR-004 emergency queue, TR-003 reservations, IP-007 blood planning, EN-018.
- `polytrauma.huddle.recorded` {decisions[]} → EN-038 tasks, IP-003.
- `polytrauma.blood.requirement_updated` {components, shortfall} → IP-007.
- `polytrauma.consent.updated` {subject, status} → TR-004 readiness, EN-028 ledger.
- `polytrauma.family_update.sent`; `polytrauma.task.created|completed`.
- Consumes: `trauma.team.activated|score.updated|injury.recorded|kpi.breached` (TR-001), `ortho.fracture.created|plan_set` (TR-002 incl. sequencing proposals), `icu.surgery_readiness.updated|score.computed|admitted|discharged` (TR-006), `trauma_ot.request.decided|override.applied|ot.case.incision|completed|cancelled` (TR-004), `blood.crossmatch.ready|issued|mtp.activated|stood_down` (IP-007), `lab.result.available|critical`, `rad.study.completed|reported`, `implant.reserved` (TR-003), `consent.signed|refused` (EN-028), `er.disposition.*` (OP-006), `er.mlc.flagged` (TR-008), `bed.assigned` (IP-001), `preauth.status.changed` (EN-002).

## 8. Screens (UI)
- **Polytrauma board** (desktop wall in trauma bay/ICU + EN-018 TV; tablet): cards in phase lanes (Resus | DCO | ICU | Definitive | Recovery); card shows tag/UHID, ISS/GCS/TRISS chips, timers, readiness light, next surgery, consults pending (with SLA colour), blood status, consent gaps, alerts; filters by service; sort by acuity/time; real-time; TV shows initials/bed/stage only; keyboard `/` search, `C` consult, `Q` queue, `H` huddle, `F` family, `P` phase.
- **Case card detail** (desktop 3-pane; tablet 2-pane): left injuries/scores/plans (from TR-001/002), centre queue & consults & huddle notes & thread, right timers/blood/consents/tasks/family; all sections deep-link to owning modules; offline: read-only cached snapshot with age banner.
- **Consult inbox** (phone/tablet for specialists): pages with case summary, Ack/ETA/Arrived buttons, consult note template; SLA countdown; escalation banner.
- **Surgical priority queue** (OT coordinator desktop; surgeon tablet): hospital-wide list with rank, class countdown, readiness, dependencies, consent/blood/implant lights; drag to reorder (team leader) with reason dialog; push to TR-004.
- **Sequencing assist dialog**: suggested order with rule rationale per item and physiology snapshot; accept/modify.
- **Huddle screen** (tablet at bedside/desktop): agenda auto-list, decisions grid, attendees, sign; timer.
- **Blood demand panel** (blood bank desktop): 24 h demand vs stock by group/component, shortfalls, MTP actives.
- **Consent tracker** (coordinator desktop): matrix procedure × status, capture link (EN-028 e-sign on tablet), interpreter flag.
- **Family status view** (phone/kiosk; token): stage graphic, next update time, hospital contact; multilingual.
- **KPI dashboard** (desktop): consult SLA compliance by specialty, time-to-definitive-care, DCO conversion times, consent completeness, huddle compliance.
- Print: huddle note, case summary sheet, consent status list.

## 9. Integrations
- EN-037 paging (push/SMS/WhatsApp/IVR), NC-030 roster, EN-038 tasks/SLA, EN-028/EN-016 consent e-sign, IP-007 blood, TR-004/IP-006 OT, TR-006/IP-009 ICU, TR-001/002/003/008/010/011, OP-002 consult notes, OP-021 referral records, EN-002/RC-007/RC-008 pre-auth & estimates, IP-018 transfers, EN-018 TV, EN-009 family messages, NC-032 grievance, EN-029 sequencing rules DSL.
- Fallbacks: paging failure → IVR + phone tree; roster missing → manual pick with alert; board offline → printed queue snapshot.

## 10. Reports & Analytics
- Consult response (request→ack→arrival) by specialty/doctor & SLA compliance; time to first surgery, time to definitive fixation (e.g. femur nail ≤ 24 h in ETC vs DCO conversion ≤ 14 d); queue reorders & override reasons; readiness holds & durations; blood demand vs shortfall events; MTP ratio compliance; consent completeness at Sign In & emergency-doctrine rate; huddle frequency & decision closure; ownership hand-over delays; family update compliance; case volume by phase; outcomes by ISS band (with TR-011); M&M flags.
- Read models: `analytics.mv_ptb_cases`, `analytics.mv_ptb_consult_sla`, `analytics.mv_ptb_queue`, `analytics.mv_ptb_blood_demand`.

## 11. Notifications
- Specialists: consult pages & escalations; readiness reached for their held item; queue order changes; huddle invites.
- Team leader/coordinator: SLA breaches, consent gaps before OT, blood shortfall, pre-auth expiry, family update due, ownership acceptance pending.
- Blood bank/OT coordinator: demand changes; ICU: incoming after surgery; Family: consented stage updates (WhatsApp/SMS link, no clinical detail); MS/Quality: overrides of readiness holds, disputes escalated, unexpected outcomes.

## 12. Permissions (RBAC keys)
`trauma.ptb.case.create|read|manage|close`, `trauma.ptb.board.read`, `trauma.ptb.consult.request|respond`, `trauma.ptb.queue.propose|confirm`, `trauma.ptb.huddle.write|sign`, `trauma.ptb.blood.read`, `trauma.ptb.consent.manage`, `trauma.ptb.family.manage`, `trauma.ptb.report.read|export`, `trauma.ptb.configure`.
Defaults: Trauma team leader/trauma director: all; Surgeons/consultants: board.read, case.read, consult.respond, queue.propose, huddle.write; EM physician: case.create, consult.request, board.read; Intensivist/anaesthetist: case.read, queue.propose (readiness input), huddle.write; Coordinator nurse: case.manage (team/tasks), consent.manage, family.manage, blood.read; Blood bank: blood.read; OT coordinator: board.read (queue); ICU/ward nurses: board.read (unit scope); Insurance desk: case.read (admin fields); Quality/MS: report.*; Family: token view; Admin: configure; Auditor: read.

## 13. Non-functional
- Volumes: 40–80 active polytrauma cases at a time in a 2000-bed centre; 200 consults/day; 100 queue items/day; board 60 concurrent viewers.
- p95: board read model < 250 ms; card detail < 300 ms; consult page dispatch < 5 s; queue confirm → TR-004 visible < 2 s; snapshot refresh ≤ 15 s after upstream event.
- Offline: consult ack/ETA from phone requires network (SMS keyword fallback via EN-009); board cached read-only.
- Accessibility: colour + text SLA states; large touch; dark TV theme; i18n family view in local languages.
- Security: family token scoped/revocable; thread messages audited & retained; PHI-free pages; MLC ABAC.

- Seed data: default open criteria (Level 1/2 activation, ISS ≥ 16, ≥ 2 regions AIS ≥ 2), consult SLA table, sequencing rule set v1 (life > limb > function with DCO physiology thresholds), consent subject types, phase lanes, family-view stage labels (en + hi + state language), notification templates (pages, family updates).
- Test fixtures: 10 synthetic polytrauma cases spanning all phases; consult escalation timelines; queue with dependencies & readiness holds; family token flows; k6 smoke on `/board` (60 concurrent) and `/queue`.
- Observability: board snapshot lag (event→snapshot), page dispatch latency, SLA breach counts, family-view token usage; alert if snapshot lag > 30 s.
- Read-model strategy: `pt_board_snapshot` maintained by a worker consuming outbox events (idempotent upserts) with periodic full rebuild nightly; Redis pub/sub for Socket.IO fan-out per branch room.
- Feature-flag defaults: `ptb.sequencing_assist=true` (advisory), `ptb.family_view=false` until consent policy configured, `ptb.tv_board=true`.
- Accessibility: SLA colours paired with text ("15 min left") and icons; screen-reader summaries for cards.

## 14. Acceptance Criteria
1. Given TR-001 emits Level 1 activation, then a polytrauma case opens within 2 s with the card populated (mechanism, injuries, scores, timers) and appears in the Resus lane on all boards.
2. Given an urgent neurosurgery consult requested at 10:00, then the on-call neurosurgeon is paged; no ack by 10:10 → backup paged and escalation logged; ack with ETA 20 min shows on card; arrival scan at 10:25 records response time 25 min and marks SLA (60 min) met.
3. Given consult recommendation "operate now — decompressive craniectomy, Class Immediate", then a queue item is created with consent status not_started and blood need, and it is ranked above a proposed femur nail by the sequencing suggestion with rationale shown.
4. Given team leader confirms order [craniectomy, laparotomy, femur ex-fix], then three TR-004 requests are created with the same relative priority; reordering later requires a reason and notifies all three surgeons.
5. Given femoral nailing (definitive) confirmed while TR-006 readiness = not_ready (lactate 3.4), then the item is auto-held with blockers displayed; when readiness becomes ready, the item releases and the surgeon and OT coordinator are notified; a leader override to proceed anyway requires reason and appears in the Quality report.
6. Given queue items needing 6 PRBC + 4 FFP and MTP active, then blood requirement shows 6/4 with cross-matched counts from IP-007; at T-60 min before OT with only 3 PRBC cross-matched, blood bank and coordinator receive a shortfall alert.
7. Given a procedure consent signed for "left tibia ORIF" and the plan changes to "right", then the consent flips to expired and a re-consent task is created; TR-004 Sign In shows the blocker.
8. Given emergency-doctrine consent recorded, then two doctor signatures and MS notification are required before status is accepted.
9. Given a huddle recorded with 4 decisions and owners, then EN-038 tasks are created and appear on the card; unsigned huddle after 2 h reminds the leader.
10. Given family contact with consent, then the family status link shows "In surgery" during TR-004 case and updates to "In ICU" on `icu.admitted`, showing no clinical detail; revoking consent disables the link immediately.
11. Given ownership hand-over from trauma surgery to ortho, then ortho consultant must accept within 30 min else escalation; the card always shows a responsible consultant.
12. Given case closure attempted with one queue item still `proposed`, then closure is blocked listing the item; after cancelling it with reason, closure succeeds and TR-011 record completes.
13. Given the TV board, then only bed/tag, initials, phase lane and lights are shown.
14. Given a ward nurse in unit B, then the board shows only cases located in unit B; a surgeon sees all cases in the branch.
15. Given a death with TRISS Ps 0.85, then the case gets an M&M flag on closure and appears in TR-011's review list.
16. Given the KPI report, then consult SLA compliance per specialty equals recomputation from `pt_consults` timestamps on test data.
17. Given neurosurgery recommends "operate now" and orthopaedics "stabilise first", then both recommendations are visible on the card, a huddle task is created within 30 min, and the team leader's decision with rationale is stored and visible to TR-011.
18. Given no neurosurgeon on roster or reachable after the escalation ladder, then the team leader is offered tele-consult (OP-018) or transfer-out (IP-018) actions, and MS is notified automatically.
19. Given a relative refuses a proposed laparotomy, then the queue item is cancelled with a refusal consent document, a counselling task is created, and re-proposal later links to the original item.
20. Given the board client loses network, then it shows the cached snapshot with an age banner, queue reordering is disabled, and paging falls back to SMS/IVR.

## 15. Enhancements / Later phases
- From Added-Modules sheet: multi-specialty view, surgical priority queue, blood requirement, team assignment (all here, Phase 6).
- (market) No competitor offers a polytrauma board; later: AI sequencing/outcome prediction (AI-005/AI-002), voice huddle capture (AI-004), tele-consult with external specialists (OP-018), hospital-network transfer marketplace (IP-018), digital twin/timeline visualisation, integration with regional trauma system dashboards (EN-019/FHIR), family video updates.

## 16. Open Questions for the Hospital
1. Auto-open criteria (activation tier, ISS threshold) and who acts as team leader/trauma director per shift.
2. Consult SLA targets per urgency and escalation chain; specialties on-call in-house vs on-call from home.
3. Sequencing rule preferences (DCO vs ETC thresholds), combined-session policy, two-team availability.
4. Consent policy details: emergency doctrine, MS approval, languages, interpreters, e-sign acceptance.
5. Blood bank capacity and MTP protocol; demand-planning horizon (24 h?).
6. Family communication policy (channels, frequency, kiosk in waiting area?), unknown-patient identity handling.
7. Insurance/pre-auth practice for multi-procedure trauma; PMJAY/MV Act participation.
8. TV boards in trauma bay/ICU; huddle frequency and documentation expectations for NABH.
9. Which KPIs matter most (time-to-definitive-care targets by injury)?
10. Disagreement resolution: trauma director availability 24×7 and documentation expectations for M&M.
11. Tele-consult with external specialists permitted (OP-018) and with which partner hospitals?
12. Should the family status view be offered by default or opt-in per family; kiosk in waiting area?
13. Secure in-app thread vs existing hospital messaging — migration/adoption plan for surgeons.
14. Which insurance/pre-auth statuses should appear on the clinical board (financial risk flag) — acceptable to clinicians?
