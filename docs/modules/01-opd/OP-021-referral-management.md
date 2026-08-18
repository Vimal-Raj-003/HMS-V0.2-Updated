# OP-021 — Referral Management (Internal/External referral, Tracking, TAT monitoring, Feedback loop, Specialist routing)

| Field | Value |
|---|---|
| Domain | OPD Clinical |
| Module ID | OP-021 |
| Phase | 8 (referral entity used from Phase 2 by OP-002; console Phase 8) |
| Priority | P2 |
| Complexity | Low–Medium |
| Depends on | OP-002 (create referral from consult), OP-001 (appointments for referred patient), EN-006 (priority routing), IP-003/IP-001 (IP consults/cross-referrals, admissions from external referrals), OP-006 (ER referrals in/out), IP-018 (inter-facility transfer for external out-referrals), OP-009/OP-011/OP-015/OP-016/OP-017/OP-032/OP-035 (specialty queues consuming referrals), PE-007 (Referring Doctor Portal — external doctors track & get reports), NC-034 (referral payouts/commissions rules — compliant), NC-026 (CRM: referral sources, camps), OP-036 (second opinion), EN-009 (SMS/WhatsApp), EN-032 (email), EN-037 (alerts), EN-038 (SLA/escalation), EN-011 (ABDM: referral note as OPConsultRecord/FHIR ServiceRequest), EN-019 (FHIR ServiceRequest/ReferralRequest), NC-003 (MRD), OP-005 (referral fee/consult charges), TR-007 (polytrauma multi-specialty consults), NC-035 (camp referrals) |
| Feature flag | `module.referral.enabled` (sub: `referral.external_portal`, `referral.payout_link`) |
| Primary roles | Doctor — any (6/7/8/9), Receptionist/Referral desk (24), Call centre (25) |
| Secondary roles | Referring/Visiting doctor (15, portal), HOD (5), Marketing/CRM (55), MRD (43), Billing (27), Quality (54: TAT), Patient (portal status), Auditor |
| Regulatory | NABH 5th ed. (continuity of care, referral/transfer documentation, TAT for consults), NMC Code of Ethics (no fee-splitting/kickbacks — referral incentives must be transparent, documented, legal; PCPNDT/anti-kickback constraints), Clinical Establishments Act (referral records), ABDM (interoperable referral notes), DPDP (sharing PHI with external doctors only with consent/purpose), IRDAI (referral for cashless networks), Consumer Protection (delayed referral liability) |

## 1. Purpose
OP-021 is the shared referral engine used by every clinical module: create internal referrals (department/specialist/allied service) and external referrals (out to another facility/doctor, or in from referring doctors/camps/other hospitals), route them to the right queue with priority and SLA timers, track status (sent → accepted → seen → report back → closed) with TAT dashboards and escalation, close the loop with structured feedback/report to the referrer, provide the referring-doctor portal (PE-007) view, and feed marketing/payout analytics compliantly.

## 2. Users & Jobs-to-be-done
- **Referring doctor (internal)** (desktop/phone): refer in ≤ 30 s from consult with reason/urgency/question, get notified when seen, read specialist's reply inline.
- **Receiving specialist/department**: see referral queue with SLA colours, accept/reject/redirect, book/see patient, write reply, close.
- **Referral desk/receptionist**: convert referrals into appointments, coordinate external in-referrals (documents, appointment, arrival), send out-referral letters/summaries.
- **External referring doctor** (PE-007 portal/WhatsApp): send referral, track, receive reports/feedback.
- **HOD/Quality**: TAT compliance, rejections, leakage (referred but not seen).
- **Marketing/CRM**: referral source performance (aggregate).

## 3. Core Workflows
### 3.1 Create referral (internal)
1. Doctor in OP-002/IP/ER clicks Refer (`Ctrl+R`) → target: department/specialty or named doctor / allied service (physio, diet, wound, pain, psychology, speech, social work) / diagnostic advice; **type**: opinion only / take over care / co-manage / procedure request / IP consult (bedside) / tele opinion; **urgency**: emergency (≤ 1 h), urgent (≤ 4 h / same day), routine (≤ 72 h — configurable per target); clinical question, summary auto-attached (diagnosis, meds, allergies, key results, images links), precautions (structured for physio etc.), preferred date; consent flag if PHI leaves care team → Event `referral.created` (payload consumed by target module queue).
2. **Specialist routing**: rules (EN-038) map target + urgency + branch to queue/doctor roster (on-call for emergency; sub-specialty tags e.g. hand surgery, paediatric ortho); load balancing optional; patient preference for named doctor.
3. Patient side: referral slip printed/pushed with instructions; receptionist books appointment (auto-suggest slot within SLA) or IP consult task created (IP-003 consult list).
### 3.2 Receive & act
1. Target queue card: SLA timer, reason, source; actions **accept** (assign doctor/date), **redirect** (to another department with reason), **reject** (reason: not appropriate/duplicate/insufficient info → back to referrer), **request info**.
2. Seen: the receiving consult (OP-002 encounter / IP consult note) is linked to the referral; **reply/feedback** structured: opinion, diagnosis, plan, medications suggested, follow-up with whom, "care taken over" flag → referrer notified & sees reply in their timeline; referral status `replied` → `closed` (auto after reply if opinion-only; else when care episode ends).
3. Escalations: SLA breach → EN-037 to HOD; unbooked > X days → referral desk; patient no-show → referrer informed; leakage list.
### 3.3 External referrals — outbound
- Out-referral to another hospital/doctor (higher centre, unavailable specialty, patient choice): generate **referral letter** (template EN-039: summary, reason, investigations, meds, vitals, contact), attach reports (PDF/DICOM share links EN-008), consent for sharing (EN-028/DPDP), send via WhatsApp/email/ABDM (FHIR ServiceRequest/DocumentReference) or print; if transfer → IP-018 (ambulance TR-009); track acknowledgement/outcome (manual/portal), close.
### 3.4 External referrals — inbound
- Sources: referring doctors (PE-007 portal or WhatsApp/phone/email → desk enters), camps (NC-035), other hospitals (transfer-in IP-018), corporate/insurers; capture **referrer master** (doctor/clinic/hospital, registration no., contact, agreement/payout rules if any per NC-034 & legal), reason, documents; create pre-registration/appointment; on arrival link visit; on report finalisation → **feedback to referrer** (report copy with patient consent, summary) via portal/WhatsApp/email; referrer sees status timeline; commission/payout computed by NC-034 only if configured (transparent, GST/TDS compliant, no clinical-decision impact); marketing sees source analytics.
### 3.5 Tracking & TAT
- Status: draft → sent → acknowledged/accepted → scheduled → seen → replied → closed / rejected / cancelled / expired (no action in N days); timestamps each; TAT metrics: create→accept, accept→seen, seen→reply; SLA per urgency & target; dashboards; reminders to receiver; referral history on patient timeline & banner chip ("Referred to Cardio — pending").
### 3.6 Exceptions
- Wrong target → redirect keeps original SLA clock (config); duplicate active referral same target → warn; patient declines referral → documented; external referrer without consent to receive reports → summary only per policy; offline: referral creation queued (OP-019).

## 4. Data Model (schema `clinical`)
- **referrals**: id, hospital_id, branch_id, referral_no (series `REF`), patient_id, encounter_id?, admission_id?, direction enum(internal/external_out/external_in), kind enum(opinion/takeover/co_manage/procedure/ip_consult/tele_opinion/allied/diagnostic), source_type enum(doctor/department/external_doctor/external_facility/camp/self/insurer), referrer_user_id?, external_referrer_id?, target_department_id?, target_service enum?, target_doctor_id?, external_target jsonb?, urgency enum(emergency/urgent/routine), sla_due_at, clinical_question, summary_snapshot jsonb, precautions jsonb, attachments jsonb (doc ids/share links), consent_id?, status enum(draft/sent/acknowledged/accepted/scheduled/seen/replied/closed/rejected/redirected/cancelled/expired), status_history jsonb, appointment_id?, receiving_encounter_id?, reply jsonb ({opinion, diagnosis, plan, meds, followup, care_taken_over}), replied_by, replied_at, closed_at, closure_reason, rejection_reason, redirected_to_id?, redirected_from_id?, patient_declined bool, created_by, version; index (hospital_id, status, sla_due_at), (hospital_id, target_department_id, status), (patient_id, created_at desc), (external_referrer_id).
- **referral_routing_rules**: hospital_id, branch_id?, target_department_id/service, urgency, queue_key, roster_source enum(on_call/roster/round_robin/named), sla_minutes, escalation_chain jsonb, is_active.
- **external_referrers** (shared with PE-007/NC-026): id, hospital_id (group), type enum(doctor/clinic/hospital/lab/corporate/insurer/other), name, registration_no, specialty, phone (citext), email, address, portal_account_id?, agreement jsonb (payout rule ref NC-034, validity), consent_to_receive_reports bool, status enum(active/inactive/blacklisted), source_tag; trigram index on name/phone.
- **referral_messages** (thread): referral_id, at, by (internal user/external), text, attachments; **referral_feedback_deliveries**: referral_id, channel, sent_at, status, document_id.
- **referral_letters** (documents via clinical.documents with type referral_letter).
- Read models: `analytics.referral_tat_daily`, `analytics.referral_sources_monthly`.

## 5. Business Rules & Validations
- Every referral has target, urgency, clinical question; emergency referrals notify on-call immediately (push + call escalation) and cannot be routed to a queue without a responsible person.
- SLA defaults: emergency 60 min accept/seen; urgent 4 h; routine 72 h (accept) / 7 days (seen) — per target overrides; SLA clock pauses only when awaiting patient (scheduled future date) — configurable.
- Redirect max 2 hops then HOD; reject requires reason and notifies referrer.
- Reply mandatory for opinion/co-manage before closure; auto-close for allied services on their discharge event; expiry after N days with notification (default 30).
- External sharing of PHI requires patient consent record (or legal transfer basis); reports to external referrers only if `consent_to_receive_reports` and patient consent; DPDP purpose logged.
- Payout linkage (NC-034) is optional, must reference a signed agreement, computed post-payment realisation, visible to finance/audit; never displayed to clinicians during referral creation; blacklisted referrers blocked.
- Duplicate active referral (same patient, target, kind) → warn/merge.
- Referral numbering series `REF`; records versioned; referral history is part of the medical record (NC-003).
- IP consults: SLA measured from creation to note; nights/holidays roster (NC-030).

## 6. API Surface (`/api/v1/referrals`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /referrals | create (internal/external) | referral.create | Y | – |
| GET | /referrals?direction=&status=&target=&patient=&sla=breached | lists/queues | referral.read (scoped: own/department) | – | cursor |
| GET | /referrals/{id} | detail + thread | referral.read | – | – |
| POST | /referrals/{id}/accept, /reject, /redirect, /request-info, /schedule, /mark-seen, /reply, /close, /cancel | transitions | referral.manage (target) / referral.create (own cancel) | Y | – |
| POST | /referrals/{id}/messages | thread | referral.read (participants) | Y | cursor |
| POST | /referrals/{id}/letter, /send (channel, consent) | external letter/delivery | referral.external.send | Y | – |
| POST | /inbound | desk/portal creates in-referral (+ pre-reg) | referral.inbound.create (staff/portal) | Y | – |
| GET/POST/PATCH | /external-referrers | referrer master | referral.referrer.manage | Y | cursor |
| GET/PUT | /routing-rules | config | referral.configure | Y | – |
| GET | /stats/tat?from=&to=&department= , /stats/sources | analytics | referral.report.read | – | – |
| GET | /portal/referrals (PE-007 scope) | external referrer view (own referrals) | portal.referrer.read | – | cursor |
| POST | /fhir/ServiceRequest (EN-019) | interop create/receive | integration.fhir | Y | – |

## 7. Domain Events (outbox)
- `referral.created` {referral_id, patient_id, target, urgency, kind, precautions} → target module queues (OP-015/OP-011/OP-016/OP-017/OP-032/OP-035/OP-009…), EN-006, EN-037, IP-003 (consult list), OP-001 (booking task); `referral.accepted|rejected|redirected|scheduled|seen|replied|closed|expired|sla_breached` → referrer notifications, analytics, HOD escalation; `referral.external.sent|acknowledged` → PE-007, NC-026; `referral.inbound.received` → front office pre-registration, NC-026; `referral.feedback.delivered` → PE-007, NC-034 (payout eligibility).
- Consumes: `encounter.signed` (link reply), `appointment.booked|no_show`, `physio.discharged`/`diet.plan.closed` etc. (auto-close), `ip.discharged`, `report.released` (external feedback), `consent.signed`, `transfer.completed` (IP-018).

## 8. Screens (UI)
1. **Refer dialog** (in OP-002/IP/ER; desktop/tablet/phone): target picker (search departments/doctors/services with on-call badge), kind & urgency chips, question, auto-summary preview (toggle items), precautions form for allied targets, consent toggle for external; `Ctrl+R` open, `Ctrl+Enter` send.
2. **Referral inbox** (per department/doctor; desktop/tablet): SLA colour bars, filters, bulk accept, `A` accept, `X` reject, `D` redirect; real-time.
3. **Referral detail** (desktop/phone): timeline, patient summary, thread, reply form (structured), documents; print letter.
4. **My referrals (sent)** (doctor): status chips, replies inline, overdue highlight.
5. **Referral desk console** (reception): unbooked referrals, inbound queue (portal/WhatsApp/phone), pre-registration & booking wizard, document intake, feedback deliveries.
6. **External referrer portal** (PE-007; web/phone): create referral, upload docs, track status, download reports (consented), payout statements (if applicable).
7. **TAT & sources dashboard** (desktop dark): SLA compliance by department/urgency, breaches, rejections, leakage, source volumes/conversion (aggregate).
8. **Patient portal/app** (PE-001/OP-020): "You have been referred to X — book now" card.

## 9. Integrations
- EN-038 SLA/escalation, EN-037 push, EN-009 WhatsApp/SMS (DLT templates for referral letters/links), EN-032 email (S/MIME optional), EN-011 ABDM (referral note), EN-019 FHIR ServiceRequest/DocumentReference (inbound/outbound with partner hospitals), PE-007 portal, NC-026 CRM, NC-034 payouts, IP-018 transfers, NC-035 camps, EN-008 image share links, NC-030 on-call rosters.

## 10. Reports & Analytics
- Referral volumes by direction/kind/department, TAT (create→accept→seen→reply) percentiles, SLA compliance %, rejections/redirects with reasons, leakage (referred not seen within N days), IP consult response times (NABH indicator), external in-referral sources (top referrers, conversion, revenue — aggregate; access restricted), out-referral reasons (capability gaps), feedback delivery rate, referral-to-admission conversion. Read models `analytics.referral_tat_daily`, `analytics.referral_sources_monthly`.

## 11. Notifications
- Receiver: new referral (push; emergency → call escalation), SLA nearing/breached, info received; Referrer: accepted/rejected/redirected/seen/replied, patient no-show; Referral desk: unbooked > 24 h, inbound received; Patient: referral instructions & booking link, appointment confirmation; External referrer: acknowledgement, patient arrived, report/feedback ready (consented); HOD: breaches.

## 12. Permissions (RBAC keys)
`referral.create`, `referral.read` (ABAC own/department/care-team), `referral.manage` (target department/doctor), `referral.external.send`, `referral.inbound.create`, `referral.referrer.manage`, `referral.configure`, `referral.report.read`, `referral.export`, `portal.referrer.read` (PE-007). Defaults: Doctors — create/read/manage (own targets); Reception/referral desk — inbound.create, read (non-clinical fields), external.send (with doctor-signed letter); HOD — manage/report for department; Marketing — report (aggregate sources only); Finance — payout views via NC-034; External referrer — portal scope.

## 13. Non-functional
- Volumes: 1500 internal referrals/day enterprise, 200 external in/out; inbox p95 < 200 ms; SLA timers via EN-038 scheduler (1-min granularity); notification latency < 5 s.
- Offline: create queued from OP-019; inbox read-only cached.
- Print: referral letter (A4, letterhead), referral slip (thermal).
- Privacy: external sharing consent enforced; referrer portal scoped to own referrals; payout data segregated; audit on external sends.
- i18n: patient-facing referral instructions in local language.

## 14. Acceptance Criteria
1. Given a doctor sends an emergency referral to Cardiology, then the on-call cardiologist receives push within 5 s and, if not acknowledged in 10 min, escalation calls/pushes the HOD; SLA due = 60 min.
2. Given a routine physio referral with precautions, then it appears in the OP-015 queue with precautions structured and SLA 72 h; acceptance updates the referrer's "My referrals".
3. Given a referral rejected with reason, then the referrer is notified and can edit & resend as a new linked referral.
4. Given a referral redirected twice, then a third redirect is blocked and HOD is notified.
5. Given the specialist signs the receiving encounter and submits a structured reply, then status = replied, the reply shows in the referrer's timeline and the referral auto-closes for opinion-only kind.
6. Given an out-referral letter with attached reports and no patient consent recorded, then sending externally is blocked until consent is captured; with consent, WhatsApp/email delivery is logged.
7. Given an inbound referral from portal referrer R, when the patient's report is released and consents exist, then R sees the report in PE-007 and a WhatsApp notification is sent; without consent only "patient seen" status is shown.
8. Given a referral not booked in 24 h, then it appears in the referral desk console "unbooked" list with a booking wizard.
9. Given the TAT dashboard for last month, then it shows SLA compliance per department computed from the read model (< 1 s).
10. Given a marketing user, when opening referral sources, then only aggregate counts/conversion appear (no patient names); export is audited.
11. Given a blacklisted external referrer, then inbound creation is blocked with reason.
12. Given a duplicate active referral to the same target, then the system warns and offers to open the existing one.

## 15. Enhancements / Later phases
- Sheet row 76 (internal/external referral, tracking, TAT, feedback loop) and costed proposal line 1576 (+ specialist routing) — core.
- Later: FHIR-based referral exchange with partner networks (EN-019, Phase 11), referral network marketplace/PE-007 mobile app (Phase 13), AI routing suggestion (AI-002), e-referral to government facilities (ABDM), second-opinion bundling (OP-036), automated leakage recovery campaigns (NC-026/PE-002).
- (market) PCS Prodoc referral information entry & auto SMS to referral; SmartHospital referral agent register/source analysis; MocDoc incentive management — covered with compliance guardrails.

## 16. Open Questions for the Hospital
1. SLA targets per urgency/department and escalation chains; on-call roster source?
2. External referrer programme: do you pay referral fees/commissions? Under what agreements (legal review)? Who may view payout data?
3. Report sharing with external referrers: default consent capture at registration ("share reports with referring doctor")?
4. Referral letter template/letterhead and delivery channels (WhatsApp/email/print/ABDM)?
5. Should allied-service referrals (physio/diet) auto-close on their discharge, or require referrer acknowledgement?
6. Inbound sources to onboard at go-live (list of referring doctors/clinics/camps)?
