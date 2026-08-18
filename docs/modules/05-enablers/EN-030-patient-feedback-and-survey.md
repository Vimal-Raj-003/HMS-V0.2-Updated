# EN-030 — Patient Feedback & Survey (NPS, Post-OPD & Post-Discharge Triggers, Survey Builder, Star-Threshold Google-Review Routing, Ward/Doctor/Department Scoring, Close-the-Loop to NC-032, NABH PRE Indicators, Multi-language, Kiosk/QR/WhatsApp/IVR/Email Channels)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-030 |
| Phase | 10 |
| Priority | P1 |
| Complexity | Medium |
| Depends on | EN-009 (SMS/WhatsApp send + opt-in ledger + DLT templates), EN-032 (email), EN-039 (survey form builder widgets & rendering), EN-037 (staff notifications & escalation), EN-034 (kiosk channel), EN-033 (IVR channel), EN-027 (department/doctor/ward masters), EN-028 (consent for contact & for publishing testimonials), NC-032 (Patient Grievance/Complaint — the resolution system of record), EN-041 (branch scoping & group roll-up), EN-001 (BI) |
| Consumed by | PE-001 (patient portal feedback tile), PE-002 (follow-up calls can carry a survey), NC-032 (auto-created grievance from a low score), NC-015 (quality/NABH indicators), EN-012 (website testimonial widget), EN-018 (score board in staff areas), OP-005/IP-002 (billing & discharge as trigger points) |
| Feature flag | `module.feedback.enabled` (sub: `feedback.nps`, `feedback.google_routing`, `feedback.ivr`, `feedback.kiosk`, `feedback.staff_survey`) |
| Primary roles | Patient (59) & Family/Attendant (60), Quality Manager NABH (54), Marketing/CRM Executive (55), Front Office (24), Nurse Supervisor/Matron (22) |
| Secondary roles | Hospital/Branch Admin (2/3), HOD (5), Doctor (6/7 — own scores), Call Centre Agent (25 — telephonic surveys), Medical Superintendent (4), Housekeeping Supervisor (50 — cleanliness scores), Auditor (58) |
| Regulatory | **NABH 6th edn PRE (Patient Rights & Education) and CQI chapters** — patient satisfaction must be measured, analysed, and acted upon with documented corrective action; **DPDP Act 2023 & Rules 2025** — feedback invitations are a legitimate-use/consent question, free-text responses may contain health data, and testimonials require explicit publishing consent; **TRAI DLT** — survey SMS are transactional only when tied to a completed visit, otherwise they are promotional and DND applies (EN-009); consumer-protection norms on review solicitation (no incentivising positive reviews); Google Business Profile policy (no review gating that filters out negative reviewers from *reviewing* — see §5) |

## 1. Purpose
EN-030 collects structured patient experience data at the right moments (post-OPD consult, post-discharge, post-procedure, post-lab-report, post-emergency), scores it (NPS, CSAT, service-level stars, NABH-aligned domains), routes it (delighted patients toward a public review, dissatisfied patients toward a fast private resolution), and closes the loop by handing every actionable complaint to NC-032 with an SLA. It is a survey *platform* — the builder, channels, scheduling, anti-spam rules and analytics — not a one-off form; ward, doctor, department and branch scorecards derive from it.

## 2. Users & Jobs-to-be-done
- **Patient / attendant (phone, kiosk, IVR)**: answer 3–5 questions in under 45 seconds, in their own language, without logging in, and be heard when something went wrong.
- **Quality Manager (54, desktop, daily/weekly)**: watch NPS and domain scores by ward/department/doctor, see which responses became complaints, evidence NABH CQI with trend charts and closed CAPAs.
- **Nurse Supervisor / HOD (22/5, desktop+phone)**: get pinged the same hour a patient rates their ward ≤2★, see the free text, act, and record what was done.
- **Marketing/CRM (55)**: run the Google-review funnel, collect consented testimonials for the website (EN-012), measure response rates per channel and campaign.
- **Doctor (6/7)**: see own patient-experience score and comments (moderated, non-identifying by default) in the doctor dashboard.
- **Front office / call centre (24/25)**: hand a kiosk/QR to a departing patient; run telephonic surveys for patients without smartphones; log verbal feedback on a patient's behalf with attribution `captured_by_staff`.
- **Hospital Admin (2)**: compare branches, set the star threshold and the survey cadence, and cap how often any patient is surveyed.

## 3. Core Workflows

### 3.1 Survey design (builder)
1. Quality/Marketing creates a **survey definition**: type (`nps` / `csat` / `domain_star` / `custom` / `staff_pulse`), audience (OPD, IP, ER, day-care, diagnostics-only, corporate health check), branch scope, languages, and an **anonymity mode** (identified / pseudonymous / fully anonymous).
2. Questions are added from typed widgets rendered by EN-039: NPS 0–10, star 1–5, single/multi choice, Likert, yes/no, free text (with length cap), staff picker (which doctor/nurse), NABH domain matrix (cleanliness, staff courtesy, waiting time, pain management, information & explanation, food, billing clarity, discharge process), and photo upload (optional, for facility issues).
3. **Conditional logic**: "if any domain ≤2 → show 'what went wrong?' free text and 'may we call you?' consent"; "if NPS ≥9 → show review-routing card"; branch/department-specific question sets.
4. **Versioning**: a survey has immutable published versions; responses always store `survey_version_id` so a question change never corrupts historical trends. Changing a scored question's scale forces a new version and a visible break in trend charts.
5. **Preview & test send** to a staff test number for each channel and each language before publishing; publish requires Quality Manager approval (EN-038).

### 3.2 Triggering & scheduling
- **Event triggers** (via outbox → EN-030 scheduler): `opd.consultation.completed` (+2 h, or on bill closure), `ip.discharge.completed` (+24 h), `procedure.completed` (+24 h), `er.visit.closed` (+12 h), `lab.report.delivered` (+4 h), `daycare.session.completed`, `ambulance.trip.completed`, plus a manual/bulk send.
- **Anti-fatigue rules** (enforced centrally): max 1 survey per patient per **7 days** and 4 per 90 days across all surveys; never within 2 h of another hospital message; never between 21:00–08:00 (quiet hours honoured from EN-037/EN-009); a patient who ignores 3 consecutive invitations is auto-rested for 90 days.
- **Channel cascade** per patient preference and available identifiers: WhatsApp (template, deep-link) → SMS with short link (DLT template) → email (EN-032) → IVR outbound (EN-033) → call-centre agent list; each step only if the previous returned no response within its window (default 24 h). Kiosk/QR are **pull** channels available at all times.
- **Reminders**: at most one reminder, at +24 h, on the same channel; then stop.
- **Token links** are single-use, signed, expire in 7 days, carry no PHI in the URL (opaque `response_token`), and open a no-login mobile page.

### 3.3 Response capture
1. Patient opens the link / taps the kiosk / answers the IVR → the survey renders in the patient's preferred language (fallback English) with large tap targets and a progress dots row.
2. Answers are saved **per question** (partial responses count as partial data; abandonment point is recorded for funnel analysis).
3. On submit → `feedback_responses` row finalised → derived scores computed (NPS bucket, mean star, per-domain score) → Event `feedback.response.submitted`.
4. **Staff-captured feedback**: front office or a call-centre agent can record feedback verbally on the patient's behalf; the response is tagged `captured_by_staff` with the staff id and is **excluded from NPS by default** (configurable) to avoid coercion bias.
5. **Anonymous kiosk mode**: no patient link — visit context is limited to branch/department/date/time slot; such responses feed department scores but not doctor scores.

### 3.4 Star-threshold routing (delight vs recovery) *(market — SmartHospital India dual-path routing)*
1. On submit, the **routing rule** evaluates the primary score against the tenant threshold (default: NPS ≥9 or overall ≥4★).
2. **Above threshold** → a "thank you" screen offers a one-tap **public review** link (Google Business Profile, Practo, JustDial, Facebook — configurable per branch, deep-linked to the branch's own profile) and, separately, an opt-in **testimonial consent** (EN-028) allowing the hospital to publish the quoted text and first name on the website (EN-012). Nothing is auto-posted; the patient always writes their own review.
3. **Below threshold** → a "we're sorry — tell us more" screen with a free-text box, an optional callback request with preferred time, and an immediate promise of contact within the SLA. Event `feedback.low_score.received`.
4. **Compliance guard (important)**: the public-review link is *offered* to high scorers, but **every** respondent can reach the public review links from the same thank-you page footer ("Leave a public review") — the system must never make it impossible for a dissatisfied patient to review publicly, and must never offer any incentive for a positive review. This is enforced in the template and is not configurable off.
5. Review-click-through is tracked (link click only — the hospital never sees whether a review was actually posted, nor its content, beyond public listing metrics manually entered by Marketing).

### 3.5 Closing the loop (service recovery)
1. Any response that is (a) below threshold, (b) contains a flagged keyword (`negligence`, `rude`, `dirty`, `bribe`, `wrong medicine`, `infection`, `police`, `legal` — configurable multilingual list), or (c) requests a callback → creates a **grievance in NC-032** with category, department, ward/doctor context, the verbatim text and the response link. Event `feedback.grievance.raised`.
2. Ownership routes by rule: ward issues → Nurse Supervisor; billing → Billing Manager; cleanliness → Housekeeping Supervisor; clinical/doctor → HOD then Medical Superintendent; food → Canteen; the fallback owner is the Quality Manager.
3. **SLA** (tenant-configurable, default): first contact ≤4 working hours, resolution ≤48 h for service issues, ≤7 days for clinical/billing investigations; breaches escalate through EN-037 (owner → HOD → Medical Superintendent/Admin).
4. Resolution is recorded in NC-032 (action taken, root cause, CAPA link to NC-015) and the outcome is optionally messaged back to the patient ("we spoke to the team; here's what changed"). A **re-survey** may be sent 7 days after resolution to measure recovery. Event `feedback.loop.closed`.
5. Responses that generate no action still count toward NABH evidence that all feedback was reviewed — a "reviewed, no action needed" disposition with reviewer and date is required for every low score.

### 3.6 Exceptions
- **Wrong recipient / patient deceased**: an invitation must never be sent when `patient.deceased = true`, when the encounter ended in mortality, or for MLC/forensic and psychiatric encounters unless explicitly enabled per survey.
- **Opt-out**: honouring EN-009's opt-out ledger is absolute; a `STOP` reply suppresses feedback invitations permanently across channels.
- **Duplicate submission**: token single-use; a second open shows the already-recorded answers read-only.
- **Abuse/spam on kiosk**: rate-limit per kiosk device (max 1 response/40 s), CAPTCHA-free but bot-checked by timing heuristics; kiosk responses without a scanned token are marked `anonymous_kiosk`.
- **Free text containing PHI or third-party names**: stored as clinical-sensitivity data, redaction applied before any export to marketing/website use, and never included in a public testimonial without EN-028 consent and Quality moderation.

## 4. Data Model (schema `engage`, prefix `feedback_`)
- `feedback_surveys` — id, hospital_id, branch_id?, key citext, name, type enum(nps/csat/domain_star/custom/staff_pulse), audience enum(opd/ip/er/daycare/diagnostics/health_check/ambulance/staff), anonymity enum(identified/pseudonymous/anonymous), status enum(draft/active/paused/retired), current_version, languages text[], routing jsonb (threshold, review_links, testimonial_consent_template_id), anti_fatigue jsonb, created…; UNIQUE(hospital_id, key).
- `feedback_survey_versions` — id, survey_id, version, questions jsonb (typed widget list with logic), scoring jsonb (which question drives NPS/overall, domain map), published_by/at, immutable.
- `feedback_triggers` — id, survey_id, event_type, delay_minutes, filter jsonb (department, payer, ward, doctor, age band), channel_cascade jsonb, reminder jsonb, quiet_hours jsonb, enabled.
- `feedback_invitations` — id, hospital_id, survey_id, survey_version_id, patient_id?, encounter_id?, branch_id, department_id?, doctor_id?, ward_id?, channel enum(whatsapp/sms/email/ivr/kiosk/qr/portal/agent), response_token (hashed), sent_at, delivered_at, opened_at, reminder_sent_at, expires_at, status enum(queued/sent/delivered/opened/responded/expired/failed/suppressed), suppress_reason, msg_ref (EN-009/EN-032 id); index (hospital_id, sent_at desc), (status, expires_at).
- `feedback_responses` — id uuidv7, hospital_id, branch_id, invitation_id?, survey_id, survey_version_id, patient_id?, encounter_id?, department_id?, doctor_id?, ward_id?, channel, language, started_at, submitted_at, completion_pct, abandoned_at_question?, answers jsonb, nps_score int?, nps_bucket enum(promoter/passive/detractor)?, overall_star numeric(2,1)?, domain_scores jsonb, free_text text (encrypted), keyword_flags text[], captured_by_staff_id?, is_anonymous bool, device_ref (kiosk id), created…; **partitioned monthly**; indexes (hospital_id, submitted_at desc), (doctor_id, submitted_at), (ward_id, submitted_at), GIN on keyword_flags.
- `feedback_routing_events` — response_id, decision enum(review_offered/recovery_path/neutral), review_link_clicked bool, clicked_at, testimonial_consent_id?, at.
- `feedback_actions` — id, response_id, grievance_id (NC-032), disposition enum(action_required/reviewed_no_action), owner_role, owner_user_id, sla_due_at, first_contact_at, resolved_at, resolution_note, capa_ref (NC-015), resurvey_invitation_id?, status.
- `feedback_testimonials` — id, response_id, consent_id (EN-028), quoted_text, display_name, moderated_by, moderated_at, status enum(pending/approved/rejected/published/withdrawn), published_channels text[] (website/social), withdrawn_at.
- `feedback_scorecards` (read model, refreshed 15 min) — hospital_id, branch_id, dimension enum(hospital/branch/department/ward/doctor/service/channel), dimension_id, period (day/week/month), responses, nps, promoters, passives, detractors, avg_star, domain_scores jsonb, response_rate, low_score_count, loop_closed_pct, median_first_contact_hours.
- Retention: responses 5 years (NABH evidence + trend), invitations 1 year, free text encrypted at rest with column-level key; anonymised aggregates retained indefinitely.

## 5. Business Rules & Validations
- **One survey per patient per 7 days**, max 4 per 90 days, no invitations in quiet hours (21:00–08:00 local), none to opted-out or deceased patients, none for MLC/forensic/psychiatric encounters unless the survey explicitly opts in with Medical Superintendent approval.
- **Review routing must not gate reviews**: the public-review link is present for all respondents; only its *prominence* differs by score. No incentive (discount, gift, points) may be attached to a review — the field does not exist in the model.
- **NPS is computed only from identified or pseudonymous, patient-submitted responses**; staff-captured and anonymous-kiosk responses are reported separately and excluded from the headline NPS by default.
- **Doctor-level scores are suppressed below n=10 responses in the period** (small-sample suppression) and are never published outside the hospital; comments shown to a doctor are moderated by Quality first if they name other staff.
- Every response with a low score or a flagged keyword **must** reach a disposition (`action_required` → NC-032 grievance, or `reviewed_no_action` with reviewer + reason) within 7 days; unresolved dispositions appear in the NABH audit gap list.
- **Survey versions are immutable**; trend charts annotate version changes; scale changes break the series visibly rather than silently rescaling.
- Free text is treated as **sensitive personal data**: encrypted, access-controlled (`feedback.freetext.read`), redacted in exports, never sent to third-party analytics, and excluded from any AI processing without DPDP purpose approval.
- Testimonials require an explicit, revocable EN-028 consent; withdrawal removes the testimonial from all published channels within 24 h.
- Token links carry no patient identifier; a leaked link exposes only that one survey, is single-use and expires in 7 days.
- Response-rate and score data are **branch-scoped by RLS**; group roll-ups require a group role (EN-041).
- Channel cascade must respect EN-009 template/DLT registration — an unregistered template cannot be used for SMS, and WhatsApp must use an approved utility template.

## 6. API Surface (`/api/v1/feedback`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET/POST/PATCH | /surveys ; /surveys/:id | survey definitions | `feedback.survey.manage` | draft only until publish |
| POST | /surveys/:id/publish \| /pause \| /retire | lifecycle | `feedback.survey.publish` (Quality) | EN-038 approval |
| POST | /surveys/:id/preview \| /test-send | preview & test | `feedback.survey.manage` | per channel & language |
| GET/POST/PATCH | /triggers | event triggers & cascade | `feedback.survey.manage` | |
| POST | /invitations/send {surveyId, encounterIds[] \| filter} | manual/bulk send | `feedback.invitation.send` | idempotent, anti-fatigue enforced |
| GET | /invitations?status&channel&from&to | invitation log | `feedback.invitation.read` | cursor |
| GET | /public/s/:token | render survey (no auth) | public, token-scoped | rate-limited, single-use |
| POST | /public/s/:token/answer ; /submit | save partial / submit | public, token-scoped | per-question save |
| POST | /responses/manual | staff-captured response | `feedback.response.capture` (24/25) | tagged captured_by_staff |
| GET | /responses?dimension&from&to&score&flag | response list | `feedback.response.read` | free text needs `feedback.freetext.read` |
| GET | /responses/:id | detail | `feedback.response.read` | PHI-audited |
| POST | /responses/:id/disposition | action_required / reviewed_no_action | `feedback.response.action` | creates NC-032 grievance |
| GET | /scorecards?dimension&period&from&to | NPS/star scorecards | `feedback.report.read` | read model, branch-scoped |
| GET | /analytics/response-rate ; /analytics/funnel ; /analytics/keywords | analytics | `feedback.report.read` | funnel = sent→opened→submitted |
| GET/POST | /testimonials ; POST /testimonials/:id/moderate \| /publish \| /withdraw | testimonial workflow | `feedback.testimonial.manage` (Marketing + Quality) | consent-gated |
| GET | /nabh/pre-indicators?period | NABH PRE/CQI indicator pack | `feedback.report.read` | PDF/CSV |
| POST | /kiosk/session | start an anonymous kiosk survey | device token (EN-034) | rate-limited per device |
| POST | /ivr/response | IVR DTMF result ingestion | service token (EN-033) | maps keypress → score |

## 7. Domain Events (outbox)
- `feedback.invitation.sent|delivered|opened|expired|suppressed` → EN-001, channel cost analytics.
- `feedback.response.submitted` → scorecard refresh, EN-018 board, doctor dashboard, PE-001.
- `feedback.low_score.received` → NC-032 grievance creation, EN-037 alert to owner role.
- `feedback.grievance.raised` / `feedback.loop.closed` → NC-032, NC-015 CAPA, quality dashboard.
- `feedback.review.link_clicked` → marketing analytics (EN-012).
- `feedback.testimonial.consented|published|withdrawn` → EN-012 website widget, EN-028 consent ledger.
- `feedback.survey.published|retired` → EN-024 audit.
- Consumes: `opd.consultation.completed`, `ip.discharge.completed`, `er.visit.closed`, `procedure.completed`, `lab.report.delivered`, `ambulance.trip.completed`, `bill.finalized`, `patient.optout.recorded`.

## 8. Screens (UI)
- **Patient survey page** (phone-first PWA, also kiosk & tablet): one question per screen with progress dots, 44 px+ tap targets, NPS as a 0–10 pill row (colour-coded), stars as large touch icons, language switcher top-right (en/hi/ta/te/ml/kn/mr/bn + RTL-ready), no login, completes in <45 s. Offline: answers cached in localStorage and posted on reconnect. Error state: "This link has expired — scan the QR at the front desk to give feedback."
- **Thank-you / routing screen** (phone/kiosk): high score → prominent "Share your experience on Google" button + testimonial consent toggle; low score → "Tell us what went wrong" text box + callback time picker + "A manager will contact you within 4 hours"; both variants show the public-review links in the footer.
- **Feedback Inbox** (desktop, Quality/Supervisors): virtualised list of responses with score chip, department/ward/doctor, channel, keyword flags, SLA countdown for actionable ones; filters (score band, department, ward, doctor, date, flag, disposition); row drawer with full answers, verbatim text, patient contact (permission-gated), `Create grievance`, `Mark reviewed`, `Call back`. Shortcuts `F` filter, `G` grievance, `R` reviewed, `J/K` next/prev.
- **Scorecards Dashboard** (desktop + TV EN-018): NPS gauge with trend, promoter/passive/detractor stacked bar, domain radar (cleanliness, courtesy, waiting time, information, pain, food, billing, discharge), heatmap by ward × week, top/bottom departments, response-rate funnel by channel; drill-down to responses; period comparison. TV variant shows branch NPS and "days since last unresolved low score".
- **Survey Builder** (desktop): left question palette, centre canvas with drag-reorder, right properties (scale, required, logic, translations per language with a completeness meter); preview pane rendering phone/kiosk/IVR script; `Ctrl+P` preview, `Ctrl+S` save draft.
- **Doctor's Experience Widget** (doctor dashboard, desktop/phone): own NPS/star for the period vs department median, response count (with n<10 suppression notice), latest moderated comments.
- **Testimonial Moderation** (desktop, Marketing + Quality): pending quotes, consent status chip, edit-for-length (verbatim preserved separately), approve/reject with reason, publish targets.
- **Kiosk feedback screen** (kiosk, EN-034): 3-question express survey with emoji faces, auto-reset 15 s after submit, accessibility mode (large text, audio prompt).
- Empty/error states: "No responses yet — 128 invitations sent, first responses usually arrive within 2 hours", "Free text hidden — you do not have permission to view verbatim comments".

## 9. Integrations
- **EN-009** WhatsApp utility templates & DLT-registered SMS (survey invite, reminder, resolution update) and the opt-out ledger; **EN-032** email invites with the same token; **EN-033** outbound IVR survey (DTMF 1–5 mapping, recorded verbatim optional) and agent-assisted telephonic surveys; **EN-034** kiosk express survey; **EN-012** website testimonial widget & review-link landing pages; QR posters generated by EN-013 per department/ward.
- **Public review platforms**: Google Business Profile, Practo, JustDial, Facebook — outbound deep links only (per branch profile id). The system does not read or write reviews via API in Phase 1; Marketing records monthly public rating/volume manually for correlation.
- **NC-032** grievance API for loop closure; **NC-015** for CAPA linkage and NABH evidence packs; **EN-001** for enterprise dashboards.

## 10. Reports & Analytics
- NPS (overall, by branch/department/ward/doctor/service/channel/payer), promoter-passive-detractor mix, average star and per-domain scores, trend with version annotations.
- Response funnel: sent → delivered → opened → started → submitted, by channel and language; median time-to-respond; abandonment by question (which question loses people).
- Service recovery: low scores raised, grievances created, median time to first contact, SLA compliance %, loop-closure %, re-survey score improvement (recovery delta).
- Keyword/topic frequency from free text (rules-based multilingual keyword sets in Phase 1; NLP topic modelling later), correlated with department and shift.
- Correlation views: waiting-time score vs actual queue wait (EN-006), cleanliness score vs housekeeping tasks (NC-024), NPS vs doctor consultation duration.
- **NABH PRE/CQI pack**: patient satisfaction index by domain and quarter, complaints per 1000 patients, % complaints resolved within SLA, evidence of committee review — exportable PDF.
- Read models: `analytics.mv_feedback_scorecard_daily`, `analytics.mv_feedback_funnel_daily`.

## 11. Notifications
- **Patient**: survey invitation (WhatsApp/SMS/email), one reminder at +24 h, "thank you — we've logged your concern, ref #NNN, a manager will call by HH:MM", resolution update, optional re-survey.
- **Staff**: low-score alert to the owning supervisor within 5 minutes (EN-037, respecting staff quiet hours except for `severe` flags); SLA breach escalation to HOD then Medical Superintendent; daily digest of new responses to Quality; weekly scorecard email to HODs and Admin; monthly board pack.
- **TV (EN-018)**: staff-area board with branch NPS, this week's compliments (moderated) and open recovery count.

## 12. Permissions (RBAC keys)
`feedback.survey.manage` (Quality 54, Marketing 55) · `feedback.survey.publish` (Quality Manager) · `feedback.invitation.send` (Quality, Marketing, Front Office bulk-limited) · `feedback.invitation.read` · `feedback.response.read` (Quality, HOD/Supervisor scoped to own department/ward via ABAC, Doctor scoped to own) · `feedback.freetext.read` (Quality, Supervisor; audited) · `feedback.response.capture` (Front Office 24, Call Centre 25) · `feedback.response.action` (Quality, Supervisors) · `feedback.report.read` (Admin, Quality, HOD, Medical Superintendent, Auditor) · `feedback.testimonial.manage` (Marketing + Quality dual) · `feedback.patient_contact.read` (permission-gated reveal of phone for callback; audited) · `feedback.admin.settings` (Hospital Admin — thresholds, cadence, review links).

## 13. Non-functional
- **Volumes (2000-bed, 5000 OP/day)**: ~5500 invitations/day, expected response rate 18–30 % on WhatsApp, 6–12 % on SMS, 40 %+ on kiosk-at-exit ⇒ ~1200–1800 responses/day, ~500k/year. Peak send burst 2000 messages in 10 minutes (post-OPD close) — must be queued and rate-limited by EN-009, never a thundering herd.
- Survey page TTI < 1.5 s on 3G-class phones; page weight < 120 KB (no heavy fonts/images); per-question autosave < 200 ms.
- Scorecard read models refresh every 15 minutes; dashboard queries p95 < 400 ms from materialised views only.
- **Accessibility**: WCAG 2.2 AA, minimum 44 px targets, contrast-safe score colours with icons + labels (never colour alone), full keyboard operation, screen-reader labels for star/NPS controls, kiosk audio-prompt mode.
- **i18n**: all patient-facing strings and every question/option translated per survey version with a per-language completeness meter; missing translation falls back to English and is flagged to the author; IVR prompts recorded per language.
- **Privacy**: free text encrypted at rest; token URLs contain no PHI; exports for marketing are aggregate/anonymised by default; DPDP purpose recorded for feedback processing.
- Offline: kiosk caches the active survey definition and queues responses locally for up to 24 h.

## 14. Acceptance Criteria
1. **Given** an OPD consultation is completed, **when** 2 hours elapse and the patient has WhatsApp opt-in, **then** exactly one invitation is sent via WhatsApp with a single-use 7-day token, and no SMS is sent unless WhatsApp returns no response within 24 hours.
2. **Given** a patient already received a survey 3 days ago, **when** a new trigger fires, **then** the invitation is suppressed with reason `anti_fatigue` and recorded in the invitation log.
3. **Given** a patient submits NPS 10, **when** the thank-you screen renders, **then** a prominent Google review link for that branch is shown, a testimonial consent toggle is offered, and the public-review links remain visible in the footer for every score band.
4. **Given** a patient submits an overall rating of 2★ with the comment "the ward was dirty", **then** a grievance is created in NC-032 with category cleanliness routed to the Housekeeping Supervisor, an alert reaches the owner within 5 minutes, and a 4-hour first-contact SLA countdown starts.
5. **Given** a low-score response, **when** 7 days pass without a disposition, **then** it appears in the NABH audit gap list and escalates to the Quality Manager.
6. **Given** a doctor has 7 responses in the month, **when** the doctor scorecard is viewed, **then** the score is suppressed with an "n<10 — not enough responses" notice rather than displaying a misleading average.
7. **Given** a survey version is republished with a changed star scale, **when** the trend chart renders, **then** the series shows a version boundary annotation and does not silently rescale historical points.
8. **Given** a patient has replied STOP to hospital messaging, **when** any feedback trigger fires, **then** no invitation is sent on any channel and the suppression reason is `opted_out`.
9. **Given** an anonymous kiosk response, **when** scorecards are computed, **then** it contributes to department and branch scores but not to doctor scores or the headline NPS.
10. **Given** a survey token link is opened twice, **when** the second open occurs, **then** the previously submitted answers are shown read-only and no duplicate response row is created.
11. **Given** a testimonial consent is withdrawn, **when** the withdrawal is recorded, **then** the testimonial is removed from the website widget and all published channels within 24 hours and the status is `withdrawn` with an audit entry.
12. **Given** a user without `feedback.freetext.read`, **when** they open a response, **then** scores and metadata are visible but verbatim comments are masked.
13. **Given** the survey page is opened on a 3G phone in Tamil, **when** it loads, **then** every question and option renders in Tamil, TTI is under 1.5 s, and completing 4 questions takes fewer than 6 taps.
14. **Given** 2000 OPD visits close within 10 minutes, **when** invitations are queued, **then** they are rate-limited through EN-009 without exceeding the gateway throughput and none are sent inside quiet hours.
15. **Given** a resolved grievance, **when** the re-survey is enabled, **then** a recovery survey is sent 7 days after resolution and the recovery delta appears in the service-recovery report.
16. **Given** an encounter flagged MLC or psychiatric, **when** a trigger fires, **then** no invitation is created unless that survey has an explicit Medical Superintendent-approved opt-in.

## 15. Enhancements / Later phases
- **NLP on verbatim comments**: multilingual sentiment and topic clustering (AI-003/AI-005) replacing keyword rules, with per-topic trend and auto-routing suggestions.
- **Real-time in-visit pulse**: a 1-question "how is your wait going?" push while the patient is still in the queue (EN-006), enabling recovery before the patient leaves.
- **Closed-loop with public reviews**: Google Business Profile API to read review volume/rating and correlate with internal NPS (Phase 11), still never auto-posting.
- **Staff pulse surveys** (eNPS) and 360° feedback for clinical teams, reusing the same builder.
- **Referring-doctor and corporate-client satisfaction** surveys via PE-006/PE-007.
- **Benchmarking**: anonymised cross-tenant NPS percentiles for the SaaS product (opt-in, aggregate only).
- **Video/voice feedback** capture at kiosk and via WhatsApp voice notes with transcription.
- Reward-free **loyalty linkage** (PE-005) — recognising engaged patients without incentivising ratings.

## 16. Open Questions for the Hospital
1. What is the **star/NPS threshold** for the public-review path, and which review platforms (Google/Practo/JustDial) and per-branch profile links should be used?
2. Which survey **cadence and anti-fatigue caps** are acceptable (default 1 per 7 days, 4 per 90 days), and what are the local quiet hours?
3. Which **NABH PRE domains** does the quality committee want measured, and is there an existing satisfaction questionnaire (paper) to be digitised verbatim for trend continuity?
4. Who **owns service recovery** per category (ward, billing, housekeeping, clinical, food), and what are the first-contact and resolution SLAs?
5. Should **doctor-level scores** be visible to the doctor only, to the HOD, or to Admin — and what is the minimum sample size before display?
6. Are **staff-captured (verbal) responses** to be included in the headline NPS, or reported separately?
7. Which **languages** must be supported at go-live, and who supplies the professional translations and IVR voice recordings?
8. Does the hospital want survey invitations for **ER, psychiatry, oncology and mortality-adjacent encounters**, and with what sensitivity rules?
9. What is the policy for **publishing testimonials** — who moderates, is the patient's first name allowed, and how are withdrawals handled?
10. Should feedback be tied to **billing closure** or to clinical completion (they differ for credit/TPA patients)?
11. Is there an existing CRM or feedback vendor (e.g. a third-party NPS tool) whose historical data must be migrated (EN-036)?
12. Who receives the **weekly and monthly scorecards**, and should branch NPS appear on staff-area TV boards?
