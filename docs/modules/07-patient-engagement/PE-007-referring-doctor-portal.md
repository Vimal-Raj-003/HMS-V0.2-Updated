# PE-007 — Referring Doctor Portal (Referral Submission, Status Tracking, Consent-Gated Outcome Summaries, Report Access, Referral Analytics, Payout Statements with NMC Anti-Kickback Guardrails, CME & Engagement)

| Field | Value |
|---|---|
| Domain | Patient Engagement |
| Module ID | PE-007 |
| Phase | 10 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | **OP-021 (Referral Management — owns the internal referral workflow, TAT and feedback loop; PE-007 is the *external* self-service surface for referring practitioners)**, OP-001 (patient registration with referrer attribution, appointment booking), OP-002/IP-002 (consultation notes and discharge summaries — the outcome the referrer wants), OP-004/OP-008/OP-022 (lab and imaging reports), IP-001/IP-006 (admission and surgery status for a referred patient), **EN-028 (patient consent — the gate on every clinical disclosure to an external doctor)**, EN-011 (ABDM: the correct long-term channel for sharing records with another provider, with consent artefacts), **NC-034 (Doctor Fee / Payout & Incentive Management — the only place any payment is computed; PE-007 merely displays statements and enforces the compliance gate)**, NC-026 (referrer relationship management, referral-source master shared with OP-021), NC-021/NC-031 (vendor/contract records for any professional-services agreement), EN-025 (SSO optional), EN-032/EN-009 (invitations, notifications), EN-016 (agreement e-sign), EN-038 (approvals for payout release), NC-023 (legal/compliance), EN-024 (audit), NC-011/EN-001 (analytics), OP-036 (second opinion), OP-018 (tele-consult between referrer and specialist) |
| Feature flag | `module.referrer_portal.enabled` (sub: `referrer.outcome_summaries`, `referrer.report_access`, `referrer.payouts` (**default OFF**), `referrer.cme`, `referrer.teleconsult_bridge`, `referrer.sso`) |
| Primary roles | **Visiting / Referring Doctor (15)** — external practitioner, their clinic staff (delegate sub-user), Referral Coordinator (hospital side, Front office 24 / Marketing 55 family) |
| Secondary roles | Treating Consultant (6/9 — sends the outcome back), MRD (43 — record release), Medical Superintendent (4 — governance of what is shared and of any professional-services agreement), Finance Manager (46 — payout statements, TDS), Marketing/BD (55 — relationship management within ethical limits), Privacy Officer / DPO (57), Hospital Admin (2), Legal (NC-023), Auditor (58) |
| Regulatory | **NMC (formerly MCI) Code of Ethics Regulations 2002 §6.4 & the National Medical Commission (Registered Medical Practitioner Professional Conduct) framework — "Rebates and Commission": a registered medical practitioner shall not give, solicit or receive any gift, gratuity, commission or bonus in consideration of, or return for, referring, recommending or procuring any patient; "fee splitting" / cut practice is professional misconduct punishable by suspension or removal from the register**; **Indian Medical Council (Professional Conduct) provisions on advertising and solicitation**; **Prevention of Corruption Act / Indian Penal Code** where a government-employed doctor is involved; **Income-tax §194J** (professional fees) and **§194R** (benefits/perquisites — CME sponsorship, gifts and hospitality to doctors are taxable perquisites requiring TDS and reporting), **UCPMP 2024** principles by analogy for hospitality and sponsorship; **DPDP Act 2023 & Rules 2025** — sharing a patient's clinical record with an external doctor requires the patient's specific consent and purpose limitation; the referrer is a separate data fiduciary; **ABDM V3** consent-artefact framework as the compliant sharing channel; **NABH** (referral documentation, continuity of care); **IT Act** (external portal security) |

## 1. Purpose
PE-007 gives external referring practitioners a proper channel into the hospital: submit a referral with clinical context, know what happened to their patient, receive a consent-gated outcome summary and reports, see their own referral analytics, participate in CME, and — **only where the hospital operates a lawful, documented professional-services arrangement** — view statements for services actually rendered. Its most important design property is what it refuses to do: it makes **per-referral commissions structurally impossible**, because the single fastest way to destroy a hospital's licence and its doctors' registrations in India is an automated referral-payout feature.

## 2. Users & Jobs-to-be-done
- **Referring doctor (GP, specialist, small nursing home)** (phone/desktop, a few minutes at a time): send a patient with the clinical story attached, get told when they arrived, were admitted, were operated and were discharged, receive the discharge summary and reports so they can continue care, and reach the treating consultant when they need to.
- **Referrer's clinic staff (delegate)**: submit referrals and book slots on the doctor's behalf, with clearly scoped permissions and no clinical access unless the doctor and the patient permit it.
- **Treating consultant**: close the loop with a short outcome note — one screen, two minutes — because a referrer who never hears back stops referring, and that is a continuity-of-care failure as much as a commercial one.
- **Referral coordinator**: onboard and verify referrers (NMC registration number), route incoming referrals to the right department, chase unclosed loops, keep relationships warm within ethical limits.
- **Privacy Officer**: evidence that every clinical disclosure to an external doctor had the patient's consent.
- **Finance / MS / Legal**: ensure that if any money moves, it is for documented professional services under a signed agreement with TDS — never per referral, never per test, never a share of the bill.

## 3. Core Workflows

### 3.1 Referrer onboarding & verification
1. The hospital invites a practitioner (email/SMS with a single-use expiring link) or the practitioner applies from the website (EN-012). Registration captures: name, qualifications, **NMC/State Medical Council registration number and state**, speciality, clinic name and address, contact details, GSTIN/PAN if any professional agreement is envisaged, and preferred branches/departments.
2. **Verification**: the coordinator verifies the registration number (against the NMC/HPR register where available via EN-011's HPR lookup, else manual with a document upload) → status `verified`. An unverified referrer may submit referrals but receives **no clinical data** until verified.
3. **Agreements** (only if applicable): a professional-services agreement (e.g. for a visiting consultant who actually conducts clinics, reads scans, or provides on-call cover) is uploaded, e-signed (EN-016) and linked to NC-031; the agreement defines the *service*, the rate and the schedule. **There is no agreement type in the system for "payment per referral"** — the option does not exist.
4. Delegates: the referrer may add clinic staff sub-users with scoped permissions (submit referrals, book slots; clinical access only if explicitly granted by the referrer **and** permitted by the patient's consent).

### 3.2 Referral submission
1. The referrer creates a referral: patient details (name, age, sex, mobile — with the patient's knowledge), reason for referral, provisional diagnosis (ICD-10 optional), clinical summary, current medications, allergies, attachments (prior reports, images), urgency enum(routine/urgent/emergency), preferred department/consultant/branch, and preferred date.
2. **Patient consent for record sharing** is captured up front in one of three ways: the patient signs/e-signs at the referrer's clinic (uploaded), the patient confirms by OTP on their phone (EN-028 flow initiated from the referral), or consent is captured at the hospital's registration desk on arrival. **No clinical information flows back to the referrer until a valid consent exists** — the referral itself can proceed without it; only the return of information is gated.
3. Submission produces a **referral number** and, where the hospital allows it, an **appointment slot** booked directly (OP-001) or a callback request; the patient receives an SMS/WhatsApp with the appointment and what to bring. Emergency referrals additionally trigger an ER pre-alert (OP-006/TR-009) and a phone-call path — the portal never becomes the only channel for an emergency.
4. Referral attribution is written to the patient's registration (`referral_source` in OP-001, shared master with NC-026/OP-021) at the point of arrival — the honest basis for analytics, and the *only* thing attribution is used for in this module.

### 3.3 Status tracking (the loop)
- The referrer sees a status timeline for each referral, limited to **operational milestones by default** (which are not clinical detail and are shown once the patient is linked): received → appointment booked → patient arrived → consulted → investigations in progress → admitted → operated → discharged → outcome summary available. Timestamps and the treating consultant's name are shown; anything clinical requires consent (§3.4).
- Not-arrived referrals are visible to the referrer and to the coordinator, with a reason where known (patient declined, went elsewhere, no contact) — closing this loop is what makes referrers trust the channel.

### 3.4 Consent-gated outcome summaries & report access (`referrer.outcome_summaries`, `referrer.report_access`)
1. When consent exists, the referrer receives: the **outcome summary** (a short structured note written by the treating consultant: what was found, what was done, what the referrer should do next, medications, red flags, follow-up plan), the **discharge summary** (IP-002), and the **reports** the patient consented to (lab OP-004, imaging OP-008 with a viewer link via EN-008).
2. Release rules mirror PE-001's: critical results are communicated by the clinical team first; sensitive categories (psychiatry, HIV/STI, fertility, oncology genetics, MLC) require an **explicit additional consent tick** naming those categories; the patient can revoke access at any time from their portal, and revocation takes effect on the next request.
3. **Preferred channel**: where both parties are on ABDM, sharing occurs through **EN-011 consent artefacts** rather than portal downloads, which is both compliant and auditable at the national level. Portal access remains for practitioners not yet on ABDM.
4. Every view and download by a referrer is logged with the consent reference and is visible to the patient in PE-001's "who accessed my records".

### 3.5 Referral analytics (for the referrer)
- The referrer sees their own activity: referrals by month, by department, arrived vs not arrived, outcome mix (OPD only / admitted / operated), average time from referral to consultation, and outcome summaries received. This is professional feedback, not a sales scoreboard, and it deliberately contains **no revenue figures** — showing a referring doctor how much revenue they generated is exactly the framing that turns a lawful relationship into an unlawful inducement.

### 3.6 Payout statements — the compliance gate (`referrer.payouts`, default OFF)
1. If, and only if, the hospital operates a lawful arrangement, PE-007 can display **statements for professional services actually rendered** — computed entirely in **NC-034** and merely presented here. Permitted service types: clinics conducted at the hospital, procedures performed, scan/ECG reporting, on-call cover, teaching sessions, panel/committee work. Each statement line references the service, the date, the volume and the contracted rate from the signed agreement, with TDS (§194J) and GST shown.
2. **Structural prohibitions, enforced by the data model and by tests**: there is no field, rule or import path that can compute a payout as a function of *referrals made*, *bills raised for referred patients*, *tests ordered*, or *revenue generated*; a payout line **must** reference a rendered-service record; a referrer with no signed professional-services agreement can have no statement at all; and the referral tables and the payout tables share no computational path (a contract test asserts that NC-034 cannot read `ref_referrals`).
3. **Governance**: enabling `referrer.payouts` for a hospital requires MS + Finance + Legal sign-off recorded in the system; every statement release is approved (EN-038); §194R applicability for any non-cash benefit (CME sponsorship, hospitality) is flagged for finance; the compliance banner explaining the anti-kickback position is permanently displayed on the statement screen.
4. Non-clinician referral sources (corporate HR, insurance facilitators, transport partners, camps) are handled in NC-026/NC-035 with their own lawful commercial terms; they are **not** registered practitioners and must never be conflated with them in this module.

### 3.7 CME & engagement (`referrer.cme`)
- Academic and clinical-relationship activity, kept scrupulously educational: CME events and webinars with registration and attendance certificates, case discussions and journal-club invitations, clinical protocol updates and new-service announcements (factual), and a **"discuss a case" bridge** to the relevant consultant (`referrer.teleconsult_bridge`, OP-018 — with the patient's consent where identifiable details are involved).
- **§194R note**: any sponsorship, hospitality, travel or gift to a practitioner is a taxable perquisite and is recorded for TDS and disclosure; the system makes recording it mandatory rather than optional, and the MS approves it.

### 3.8 Exceptions
- Referral for a patient who never arrives → closed after the configured period with a reason; the referrer is told.
- Consent absent or withdrawn → operational status only; the referrer is shown an honest "the patient has not consented to share clinical details" message rather than a blank screen, and can ask the patient directly.
- Referrer's registration lapses or is suspended → clinical access is suspended automatically; referrals may continue as contact-only until resolved.
- Suspected inducement solicitation ("what is your commission?") → recorded as a compliance incident, routed to MS/Legal, never handled informally by marketing.
- Emergency referral → phone-first with ER pre-alert; the portal records but never gates it.
- Duplicate referral of the same patient → merged with the earlier referral, both referrers visible to the coordinator.

## 4. Data Model (schema `engage`, prefix `ref_`; internal referral workflow in OP-021; all money in NC-034)
- **ref_referrers** — id, hospital_id, name, qualifications, **nmc_registration_no**, registration_state, registration_verified_at, verification_method enum(hpr_lookup/manual_document), registration_status enum(verified/pending/lapsed/suspended/rejected), speciality, clinic_name, address, city, phone, email citext, gstin?, pan?, preferred_branches uuid[], source enum(invited/self_registered/imported), status enum(invited/active/suspended/inactive), onboarded_by, onboarded_at, agreement_id? (NC-031), audit cols. UNIQUE(hospital_id, nmc_registration_no) where present.
- **ref_referrer_users** — id, referrer_id, email citext, name, role enum(doctor/delegate), permissions jsonb {submit_referral, book_slot, view_status, view_clinical (requires doctor + consent), view_statements}, mfa_enabled, sso_subject?, status, invited_at, last_login_at. UNIQUE(referrer_id, email).
- **ref_referrals** — id, hospital_id, branch_id, referral_no, referrer_id, referrer_user_id, patient_id? (linked on arrival), patient_name, patient_age, patient_sex, patient_mobile_hash, reason, provisional_diagnosis?, clinical_summary, medications, allergies, urgency enum(routine/urgent/emergency), preferred_department_id?, preferred_consultant_id?, preferred_date, attachments jsonb, status enum(submitted/acknowledged/appointment_booked/arrived/consulted/investigations/admitted/operated/discharged/outcome_sent/not_arrived/cancelled/duplicate), appointment_id?, encounter_ids uuid[], treating_consultant_id?, consent_id? (EN-028), consent_scope jsonb {summary, reports, sensitive_categories[]}, consent_status enum(none/requested/granted/withdrawn/expired), not_arrived_reason?, closed_at, op021_referral_id (link to the internal workflow), audit cols. Indexes (hospital_id, referrer_id, created_at desc), (status), (patient_id).
- **ref_referral_events** — referral_id, at, event enum(submitted/acknowledged/booked/arrived/consulted/admitted/operated/discharged/outcome_sent/not_arrived/cancelled), actor_type enum(referrer/staff/system), actor_id, note, visible_to_referrer bool (operational milestones true; clinical detail never).
- **ref_outcome_summaries** — id, referral_id, encounter_id, written_by (treating consultant), written_at, findings, procedure_done, medications_on_discharge, advice_to_referrer, red_flags, follow_up_plan, attachments jsonb (report ids), sent_at, channel enum(portal/abdm/email/print), consent_ref, acknowledged_by_referrer_at?, sha256.
- **ref_record_access_log** — referral_id, referrer_user_id, artefact_type enum(outcome_summary/discharge_summary/lab_report/imaging_report/image_study), artefact_ref, accessed_at, consent_ref, ip_hash, action enum(view/download/print). (Surfaced to the patient in PE-001 §3.9.)
- **ref_professional_agreements** — id, referrer_id, agreement_no, service_types text[] enum(clinic_conducted/procedure_performed/reporting/on_call/teaching/committee), rate_basis jsonb (per session/per procedure/monthly retainer), contract_file_id, signed_at, valid_from, valid_to, tds_pct, gst_applicable, approved_by (MS + Finance + Legal), nc031_contract_id, status. **Schema deliberately contains no referral-volume or revenue-share fields.**
- **ref_service_records** — agreement_id, referrer_id, service_type, service_date, reference (session id / procedure id / report id), volume, verified_by (hospital staff), verified_at. (The only permissible basis for a payout line.)
- **ref_statement_publications** — id, referrer_id, period, nc034_payout_id (**source of truth**), gross, tds, net, statement_file_id, approval_id (EN-038), published_at, viewed_at, service_record_ids uuid[] (every line traces to a rendered service).
- **ref_benefits_register** (§194R) — referrer_id, benefit_type enum(cme_sponsorship/travel/hospitality/gift/honorarium), description, value, event_id?, date, approved_by (MS), tds_flagged bool, finance_ref. (Mandatory recording; the register exists so that what is legitimate is documented and what is not is visible.)
- **ref_compliance_incidents** — id, referrer_id?, staff_user_id?, type enum(commission_solicited/commission_offered/unlawful_agreement_attempt/consent_bypass_attempt/registration_lapsed_access), detail, reported_by, occurred_at, status, reviewed_by (MS/Legal), action_taken.
- **ref_cme_events** — id, hospital_id, title, type enum(cme/webinar/case_discussion/workshop/protocol_update), starts_at, mode, capacity, credits?, faculty, registration_open, materials_ids uuid[], feedback_form_id; **ref_cme_registrations** — event_id, referrer_id, registered_at, attended_at, certificate_file_id, benefit_register_id? (if sponsored).
- RLS on `hospital_id` **and** `referrer_id`; clinical artefacts are served only through a consent check at request time (not cached authorisation). Retention: referrals and outcome summaries 8 years with the clinical record; access log 3 years; agreements and benefit register per statute (8 years).

## 5. Business Rules & Validations
- **No clinical information is released to a referrer without (a) a verified registration, (b) a valid patient consent covering the artefact type, and (c) a request-time consent check.** Consent withdrawal is effective immediately on the next request. Sensitive categories require explicit, itemised consent.
- **Anti-kickback, enforced structurally**: no payout may be computed from referral counts, referred-patient billing, tests ordered or revenue; every payout line must reference a `ref_service_records` row under a signed `ref_professional_agreements`; `referrer.payouts` is OFF by default and can be enabled only with recorded MS + Finance + Legal approval; NC-034 has no read path to `ref_referrals` (contract test); and referral analytics shown to the referrer contain **no revenue figures**.
- Any non-cash benefit to a practitioner (CME sponsorship, travel, hospitality, gift, honorarium) must be recorded in the benefits register with MS approval and flagged for §194R/TDS assessment — the system does not permit an unrecorded benefit to be arranged through it.
- A referrer whose registration lapses or is suspended loses clinical access automatically (daily verification job plus event-driven where HPR lookup is available).
- Emergency referrals must never depend solely on the portal: the submission screen shows the ER phone number prominently and an emergency submission triggers a call-back task in addition to the ER pre-alert.
- Delegate users may never hold `view_clinical` unless the doctor grants it **and** the patient's consent scope permits it; delegate access is separately logged.
- Attribution (`referral_source`) is used for operational routing and aggregate analytics only; it must not be visible to, or actionable by, anyone computing clinician compensation (segregation with NC-034 verified).
- Outcome summaries are written by the treating consultant (not by marketing or coordinators), are versioned and hashed, and are sent only after consent is confirmed.
- Compliance incidents (a solicitation of commission, an attempt to bypass consent) are non-deletable, routed to MS/Legal, and reported quarterly to Admin.
- Duplicate referrals for the same patient in the window are merged; both referrers see the status they are entitled to, and the coordinator sees both.
- External-portal security: MFA mandatory for clinical access, short sessions, single-use invitations, rate limits, and full audit.

## 6. API Surface (`/api/v1/referrer-portal`) — referrer-scoped by ABAC
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /auth/invite-accept ; /auth/login ; /auth/sso/callback | external auth (MFA for clinical) | public / referrer.self | Y | – |
| GET/PATCH | /me ; GET/POST /me/delegates | profile & delegate users | referrer.self / referrer.delegate.manage | Y | cursor |
| POST | /registration/verify-document | upload registration proof | referrer.self | Y | – |
| POST | /referrals | submit a referral | referrer.referral.create | Y | – |
| GET | /referrals?status=&from= ; GET /referrals/{id} | my referrals & status timeline | referrer.referral.read | – | cursor |
| POST | /referrals/{id}/consent-request | ask the patient for consent by OTP (EN-028) | referrer.referral.create | Y | – |
| POST | /referrals/{id}/attachments | add prior records | referrer.referral.create | Y | – |
| GET | /referrals/{id}/outcome | outcome summary (**consent-checked**) | referrer.clinical.read | – | – |
| GET | /referrals/{id}/reports ; GET /reports/{id}/pdf ; GET /studies/{id}/viewer | reports & imaging (**consent-checked**) | referrer.clinical.read | – | cursor |
| POST | /referrals/{id}/book-slot | book an appointment (OP-001) | referrer.slot.book | Y | – |
| POST | /referrals/{id}/message | message the treating consultant | referrer.message.send | Y | – |
| POST | /teleconsult/request | case discussion with a consultant (OP-018) | referrer.teleconsult.request | Y | – |
| GET | /analytics/my-referrals?period= | own activity (**no revenue figures**) | referrer.analytics.read | – | – |
| GET | /statements?period= ; GET /statements/{id}/pdf | professional-services statements (NC-034) | referrer.statement.read (gated by `referrer.payouts` + agreement) | – | cursor |
| GET/POST | /cme/events ; POST /cme/events/{id}/register ; GET /cme/certificates | CME | referrer.cme.read / .register | Y | cursor |
| GET | /my-access-log | what I viewed (transparency) | referrer.self | – | cursor |

Hospital-side (`/api/v1/referrals-admin/...`): referrer onboarding and registration verification, referral routing and acknowledgement, not-arrived closure, outcome-summary composition (consultant), consent status monitoring, agreement and benefits-register management (MS/Finance/Legal), compliance incidents, and the **referral analytics** the hospital uses (which *may* include revenue, internally only).

## 7. Domain Events (outbox)
- `referrer.onboarded|verified|suspended|registration_lapsed` → access recalculation, coordinator notification.
- `referral.submitted` {referral_no, urgency, department} → OP-021 internal workflow, coordinator queue, ER pre-alert if emergency.
- `referral.appointment_booked|patient_arrived|consulted|admitted|operated|discharged` → referrer status timeline (operational only), analytics.
- `referral.consent.requested|granted|withdrawn` {scope} → **access gate recalculation**, PE-001 patient view.
- `referral.outcome.sent` {channel, consent_ref} → referrer notification, OP-021 loop closure metric, patient's access log.
- `referral.clinical.accessed` {artefact, referrer_user, consent_ref} → patient-visible access log, EN-024.
- `referral.not_arrived` {reason} → referrer notification, coordinator follow-up.
- `referrer.statement.published` {period, net, approval_id} → referrer notification (only when `referrer.payouts` is on).
- `referrer.benefit.recorded` {type, value} → finance §194R assessment, MS oversight.
- **`referrer.compliance.incident`** {type} → **MS + Legal (immediate)**, quarterly compliance report.
- `referrer.cme.registered|attended` → certificate issue, benefits register if sponsored.
- Consumes: `patient.registered` with referral attribution (OP-001), `visit.consult.completed`, `ip.admitted`, `ot.completed`, `ip.discharge.completed`, `lab.result.validated`, `rad.report.signed` (availability, not auto-release), `consent.granted|withdrawn` (EN-028), `payout.published` (NC-034), `hpr.registration.status_changed` (EN-011 where available).

## 8. Screens (external, phone- and desktop-responsive; a referring GP will use this on a phone between patients)
- **Referrer dashboard**: my referrals this month with status chips, patients not yet arrived, outcome summaries awaiting my review, upcoming CME, and a prominent emergency phone number. No revenue anywhere.
- **New Referral** (phone-optimised, under 90 seconds): patient details (with mobile), reason and clinical summary (voice-to-text friendly), attachments from the camera, urgency, department/consultant preference, preferred date, and the **consent step** — "Does the patient consent to receiving their reports back? Sign here / send OTP to the patient / capture at the hospital". Submit → referral number, booked slot or callback promise, and a shareable message for the patient.
- **Referral detail**: status timeline with timestamps and the treating consultant's name; a clearly labelled clinical section that either shows the outcome summary and reports, or shows the honest state — "The patient has not yet consented to share clinical details"; message-the-consultant action; request a case discussion.
- **Reports viewer**: consent-checked report list with PDF view/download and an imaging viewer link (EN-008); every access is logged and the referrer is told so.
- **My analytics**: referrals by month and department, arrived vs not arrived, admitted/operated mix, average time to consultation, outcome summaries received — presented as professional feedback, explicitly without financial figures.
- **Statements** (only when `referrer.payouts` is enabled and an agreement exists): period statement with service lines (session/procedure/report, date, volume, rate), gross, TDS, net, download PDF — with a permanent banner: "Payments relate solely to professional services rendered under agreement no. X. No payment is made for referring patients (NMC Code of Ethics §6.4)."
- **CME**: event list, registration, join link, attendance certificate, materials.
- **Profile & delegates**: registration details and verification status, clinic details, delegate users with scoped permissions, MFA, and **my access log**.
- **Hospital-side coordinator console** (desktop): incoming referrals queue with urgency and routing, referrer verification tasks, not-arrived follow-up list, consent-status board (which referrals are blocked awaiting consent), outcome-summary chase list ("14 referrals discharged, 9 summaries not yet written"), compliance incidents, and the internal analytics (including revenue, which the referrer never sees).
- **Consultant's outcome composer** (desktop/tablet/phone, two minutes): patient and referral context, structured fields (findings, what was done, medications, advice to the referrer, red flags, follow-up), attach reports, send — with the consent status shown so the consultant knows whether it will actually reach the referrer.
- WCAG 2.2 AA; multilingual UI (referrers in tier-2/3 towns often prefer the local language); print-friendly summaries.

## 9. Integrations
- **OP-021** (internal referral workflow, TAT, feedback loop — PE-007 must not duplicate it), **OP-001** (registration attribution, slot booking), **EN-028** (consent, including OTP-based patient consent initiated from a referral), **EN-011** (ABDM consent artefacts as the preferred sharing channel; HPR lookup for registration verification), **OP-002/IP-002/OP-004/OP-008/EN-008** (clinical artefacts, always through their own authorisation plus the consent gate), **NC-034** (payout computation — display only here, with the structural separation described in §5), **NC-031/EN-016** (agreements, e-sign), **NC-026** (referrer relationship management, shared external-referrer master), **OP-018** (case discussion/tele-consult bridge), **OP-036** (second opinion), **EN-032/EN-009** (invitations, status notifications), **EN-025** (SSO for larger referring institutions), **NC-023** (legal), **EN-024** (audit), **EN-001** (hospital-side analytics).
- Fallbacks: HPR lookup unavailable → manual verification with document upload; ABDM unavailable → portal delivery under the same consent; imaging viewer unavailable → report PDF only.

## 10. Reports & Analytics
- **For the referrer** (no financials): referrals, arrival rate, outcome mix, time to consultation, summaries received.
- **For the hospital**: referrals by referrer/speciality/geography/department, conversion (referred → arrived → admitted → operated), revenue by referral source (internal only, restricted to Finance/Marketing/Admin), **loop-closure rate** (percentage of referrals with an outcome summary sent within N days — the single best measure of whether the programme is real), time-to-outcome by consultant, consent-capture rate (how often a referral proceeds without consent, which is a service-design problem), not-arrived reasons, referrer churn and reactivation, CME participation.
- **Compliance reports** (MS/Legal/Auditor): agreements in force and their service basis, statements published with approvals, benefits register with §194R flags, compliance incidents, and an assertion report showing that no payout line lacks a rendered-service reference.
- Read models: `analytics.mv_referral_funnel`, `mv_referral_loop_closure`, `mv_referrer_activity`, `mv_referrer_compliance`.

## 11. Notifications
- **Referrer**: referral received and acknowledged, appointment booked (with date/time), patient arrived, patient admitted/operated (operational milestones), **outcome summary available**, patient did not arrive (with reason), consent granted/withdrawn by the patient, report available, CME invitation and certificate, statement published (where applicable), registration verification status.
- **Patient** (through PE-001/EN-009): "Dr X has referred you to <hospital>; your appointment is on …", the **consent request** with a plain explanation of what will be shared with the referring doctor and a one-tap grant/decline, and a notification each time the referrer accesses their records (configurable, default on — it is their data).
- **Treating consultant**: outcome summary pending for a referred patient (gentle, batched — nagging clinicians produces empty summaries, not good ones), case-discussion request.
- **Coordinator**: new referral to route, urgent/emergency referral (immediate), referrer verification pending, consent blocked referrals, loop-closure backlog.
- **MS / Legal / Finance**: compliance incident (immediate), agreement expiring, statement approval pending, benefits register entry requiring §194R assessment.

## 12. Permissions (RBAC keys)
External (role 15, ABAC scoped to `referrer_id`): `referrer.self`, `referrer.delegate.manage` (doctor only), `referrer.referral.create|read`, `referrer.slot.book`, `referrer.clinical.read` (**requires verified registration + patient consent at request time**), `referrer.message.send`, `referrer.teleconsult.request`, `referrer.analytics.read` (no financial fields exist in the response schema), `referrer.statement.read` (gated by `referrer.payouts` + a signed agreement), `referrer.cme.read|register`.
Hospital-side: `referral.admin.onboard|verify` (Referral coordinator), `referral.admin.route|acknowledge|close` (Coordinator), `referral.outcome.compose` (**Treating consultant only**), `referral.consent.monitor` (Coordinator, DPO), `referral.agreement.manage` (**MS + Finance + Legal jointly**), `referral.benefit.record` (MS approval), `referral.compliance.read` (MS, Legal, Admin, Auditor), `referral.analytics.read_financial` (**Finance, Marketing lead, Admin only — never exposed to any referrer-facing endpoint**).
No referrer role holds any `patient.*` permission; clinical access is entirely mediated by the consent-checked referral endpoints.

## 13. Non-functional
- **Volumes**: 200–2,000 registered referrers per hospital; 50–500 referrals/month; 10–40 CME events/year; outcome summaries roughly equal to referral volume.
- **Performance**: referral submission (with 3 attachments) < 3 s on a 4G phone; status timeline < 200 ms; consent check on every clinical request < 50 ms (indexed, not cached authorisation — a stale cache would leak data after withdrawal); report list < 300 ms.
- **Security** (external surface): MFA mandatory before any clinical access, single-use expiring invitations, short sessions with device list, rate limits and bot protection (EN-026), strict `referrer_id` filtering verified by cross-tenant tests, all clinical access logged and surfaced to the patient, annual penetration test.
- **Offline**: referral drafting works offline on a phone and submits on reconnect (attachments queue); clinical viewing requires connectivity by design.
- **Accessibility/i18n**: WCAG 2.2 AA; UI available in local languages; print-friendly outcome summaries for referrers who keep paper files.
- **Auditability**: the compliance posture must be demonstrable to a regulator on demand — agreements, service records, statements, benefits and incidents all exportable as a signed pack.

## 14. Acceptance Criteria
1. Given an unverified referrer, when they request any clinical artefact, then access is denied with the verification reason, while referral submission and operational status remain available.
2. Given a referral without patient consent, when the referrer opens the referral, then only operational milestones are shown with an honest explanation, and every clinical endpoint returns 403 with the consent reason.
3. Given the patient grants consent by OTP for "summary and lab reports" but not for sensitive categories, then the referrer sees the outcome summary and lab reports, and a psychiatry note remains inaccessible and is not even listed.
4. Given the patient withdraws consent, then the referrer's next clinical request fails immediately (no cached authorisation) and the withdrawal appears in the patient's access log.
5. Given a referrer views a discharge summary, then the access is logged with the consent reference and appears in the patient's "who accessed my records" view in PE-001.
6. Given `referrer.payouts` is disabled (default), then no statement endpoint or screen exists for any referrer.
7. Given `referrer.payouts` is enabled without recorded MS + Finance + Legal approval, then the feature cannot be activated.
8. Given a payout line, then it must reference a `ref_service_records` row under a signed agreement; a line without one is rejected at creation.
9. Given the NC-034 payout engine, then a contract test proves it has no read path to `ref_referrals` and cannot compute any amount from referral counts, referred-patient bills, tests ordered or revenue.
10. Given a referrer opens their analytics, then no revenue or billing amount appears anywhere in the response schema (schema test).
11. Given CME sponsorship is arranged for a referrer, then a benefits-register entry with value and MS approval is mandatory and is flagged for §194R assessment.
12. Given a referrer's registration lapses, then clinical access is suspended automatically within one day and the referrer and coordinator are notified.
13. Given a referral is marked emergency, then the ER pre-alert fires, a call-back task is created, and the submission screen displays the ER phone number prominently.
14. Given a patient never arrives, then the referral is closed after the configured period with a reason and the referrer is notified.
15. Given a treating consultant writes an outcome summary, then it is versioned and hashed, sent only if consent is valid, and the loop-closure metric updates.
16. Given a delegate user without `view_clinical`, then they can submit referrals and see status but every clinical request returns 403 and is logged.
17. Given a referrer solicits a commission and a staff member records it, then a compliance incident is created, MS and Legal are notified immediately, and the record cannot be deleted.
18. Given a cross-referrer request (referrer A requesting referrer B's referral), then 404 is returned and the attempt is audited.
19. Given the compliance pack is exported, then it contains agreements, service records, statements with approvals, the benefits register and incidents, signed with a hash.
20. Given a user without `referral.analytics.read_financial`, then no endpoint returns revenue-by-referrer data.

## 15. Enhancements / Later phases
- Origin: architect-added (M), extending OP-021 (referral management) and NC-026 (referrer relationships) with an external self-service surface. Competitors offer "referral information entry", "referred-by auto-fill", "referral agent register", "commission management with auto payout calculation and agent-wise reports" (SmartHospital) and "auto SMS to referral" (PCS Prodoc) — **PE-007 deliberately does not implement per-referral commission for registered medical practitioners**, because that is professional misconduct under the NMC Code of Ethics; non-clinician commercial arrangements belong in NC-026/NC-034 with their own lawful basis.
- Later: full **ABDM-native sharing** so outcome summaries flow as consent-artefact-backed FHIR bundles rather than portal downloads; HPR-verified onboarding with automatic registration-status monitoring; two-way case discussion threads with the consultant (async, consent-scoped); referrer mobile app; scheduled "your patient's report is ready" pushes; referral pathway templates by condition (what to send with a suspected fracture, a suspected MI); joint clinics and shared-care plans for chronic patients; academic collaboration (case series, registries) with proper ethics approval; referrer satisfaction surveys (EN-030) and a service-quality loop; geographic referral-network analytics for capacity planning (internal); automated §194R computation and Form 16A generation for professional-services referrers; integration with the hospital's second-opinion service (OP-036).

## 16. Open Questions for the Hospital
1. How many referring practitioners do you work with, and how do referrals reach you today (phone, letter, WhatsApp, walk-in with a chit)?
2. What do you send back to a referring doctor today, and how — and do you take the patient's consent for it in writing?
3. Do you want the patient's consent captured at the referrer's clinic, by OTP, or at your registration desk? (We support all three; the default matters.)
4. Which artefacts may a consented referrer see — outcome summary only, or discharge summary and reports as well? What about imaging?
5. Do you have any **professional-services agreements** with visiting or referring doctors (clinics conducted, reporting, on-call)? Can we see one, so the statement lines match reality?
6. Confirm the hospital's position: no payment of any kind is made to a registered medical practitioner for referring patients. (The system is built on this assumption and blocks the alternative.)
7. Do you sponsor CME, travel or hospitality for doctors? Who approves it, and is §194R TDS being applied today?
8. Who verifies a referrer's NMC/State Council registration, and how often is it re-checked?
9. Who writes the outcome summary — the treating consultant, a resident, or the coordinator? (It must be the clinician; we need to know who to design the screen for.)
10. What is your current loop-closure rate (referrals where the referrer was actually told the outcome)? What target should the dashboard show?
11. Do you want a case-discussion/tele-consult bridge between referrers and consultants, and which consultants would participate?
12. Which non-clinician referral sources exist (corporates, facilitators, transport, camps), and where should their commercial arrangements live? (Not here.)
