# PE-004 — Patient Community (Moderated Support Groups, Doctor Q&A, Events Calendar, Moderation & Medical-Advice Guardrails, Abuse Reporting, Privacy)

| Field | Value |
|---|---|
| Domain | Patient Engagement |
| Module ID | PE-004 |
| Phase | 10 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | PE-001/OP-020 (identity, login, notification preferences — community is a tab in the portal, never a separate account), PE-003/OP-038 (education library — the canonical answer to most questions is an article, not a forum reply), PE-002 (chronic-care cohorts map naturally to support groups), EN-028 (explicit, separate consent to participate — a community post is a public disclosure of health status), EN-030 (feedback; community sentiment is distinct from NPS), NC-032 (grievance — a complaint posted in the community must be routed, not moderated away), EN-009/EN-032/EN-037 (digests, event reminders, moderation alerts), NC-026 (events promotion, but strictly consent-based and never inside the community feed), OP-014/OP-013/NC-035 (health check-up, immunisation and camp events), OP-018 (tele-consult hand-off from a Q&A that needs a real consultation), EN-039 (event/certificate templates), NC-027 (staff moderator training), AI-001 (chatbot triage of questions, later), EN-024 (audit) |
| Feature flag | `module.patient_community.enabled` (sub: `community.support_groups`, `community.doctor_qa`, `community.events`, `community.peer_messaging`) — **all sub-flags default OFF**; the hospital must consciously switch on each surface |
| Primary roles | Patient (59), Family / Attendant (60), **Community Moderator** (custom role: Patient Educator / Counsellor 42 / Nurse 17 family, trained), Doctor answering Q&A (6/9, opt-in) |
| Secondary roles | Medical Superintendent (4 — clinical governance of published answers), Quality Manager (54), Privacy Officer / DPO (57), Marketing (55 — events only), Hospital Admin (2), IT (56), Legal (NC-023 — escalations), Auditor (58) |
| Regulatory | **NMC Code of Ethics & Telemedicine Practice Guidelines 2020** — a doctor may give *general health information* publicly, but any **individual diagnosis, prescription or treatment advice creates a doctor–patient relationship** and must move to a proper consultation (tele or in-person) with records; consequently every public answer carries a general-information disclaimer and prescribing in the community is hard-blocked; **Drugs and Magic Remedies (Objectionable Advertisements) Act 1954** and **ASCI** — no cure claims, no treatment advertising in community content; **DPDP Act 2023 & Rules 2025** — participation requires separate, informed, withdrawable consent because posting reveals health status; children under 18 may not participate (no accounts, no tracking); erasure requests must remove the member's content or de-identify it; **IT Act 2000 §79 & IT (Intermediary Guidelines and Digital Media Ethics Code) Rules 2021** — the hospital is an intermediary for user content: publish rules of participation, appoint a **Grievance Officer** with a published contact, acknowledge complaints within **24 hours** and resolve within **15 days**, take down unlawful content within **36 hours** of a valid order, and retain records as prescribed; **Mental Healthcare Act 2017** — heightened duty where a member expresses suicidal ideation or crisis (escalation pathway, never a moderation queue); **Consumer Protection Act 2019** (misleading claims by any participant); **Copyright** (member-posted material) |

## 1. Purpose
PE-004 gives patients a safe, moderated place inside the hospital's own portal to find people with the same condition, ask the hospital's doctors general questions, and discover events — without it becoming an unsupervised medical-advice channel, a marketing surface, or a privacy incident. Every design decision favours safety over engagement: pre-moderation by default, no peer direct messaging unless deliberately enabled, hard blocks on individual medical advice and prescribing, an explicit crisis-escalation pathway, and full intermediary compliance.

## 2. Users & Jobs-to-be-done
- **Patient / family member**: find others living with the same condition (diabetes, cancer survivorship, dialysis, post-transplant, parents of NICU graduates, caregivers of stroke patients), ask a general question and get a trustworthy answer, register for a hospital event, and leave when they want with their data removed.
- **Community moderator** (trained counsellor or nurse, this is a real job, not a side task): approve or reject posts against a published policy, redirect medical questions to consultations, escalate crises immediately, keep tone safe, publish weekly digests.
- **Doctor (opt-in)**: answer a small, curated batch of general questions in their specialty with a template and a disclaimer — 15 minutes a week, visible to hundreds, and a legitimate professional presence.
- **Privacy Officer**: evidence consent, handle erasure of community content, respond to intermediary grievances within the statutory timelines.
- **Marketing**: publish events (camps, classes, awareness days) — read-only access to the community, never posting rights in support groups.

## 3. Core Workflows

### 3.1 Joining, identity and consent
1. Community is a tab inside PE-001/OP-020; there is no separate login. Joining requires a **separate DPDP consent** with a plain-language notice covering: what others will see, that posts may be visible to all members (or to the group only), that the hospital moderates and retains records as an intermediary, that this is not medical care, and how to leave and erase.
2. **Display identity** options at join: real first name, a chosen pseudonym, or "anonymous member" (a stable per-member alias so conversations remain coherent). The hospital always knows the real identity internally; other members never see the UHID, phone, or any clinical data. Staff members post under a verified badge (name, designation, department) — never anonymously.
3. **Age gate**: under-18 accounts cannot join (DPDP children's provisions); a parent may participate in a caregiver group in their own capacity.
4. Leaving: one action; choose to keep posts as "former member" (de-identified) or delete them; erasure requests via PE-001 §3.9 are honoured here within the DSAR SLA.

### 3.2 Support groups (`community.support_groups`)
1. Groups are **created by the hospital only** (never by members): name, condition/cohort scope, description, rules, visibility enum(open_to_members/closed_request_to_join/clinician_curated), assigned moderator(s), assigned clinical adviser (a doctor or specialist nurse who is the escalation point), language, and whether it is linked to a PE-002 chronic cohort.
2. Membership: self-join for open groups (after consent), request-to-join for closed groups (moderator approves), or clinician invitation for curated groups (e.g. a bariatric-surgery journey group).
3. Posting: a member writes a post or reply → **pre-moderation by default** (nothing is publicly visible until approved; configurable to post-moderation for mature, low-risk groups) → automated pre-screen (banned-terms list, contact-details detector, drug-brand and dosage detector, self-harm/crisis language detector, spam/link heuristics) assigns a risk score and routes accordingly → moderator approves, edits with a note, rejects with a reason, or escalates.
4. Reactions and thanks are allowed; **peer direct messaging is off by default** (`community.peer_messaging`) because unmoderated one-to-one channels between vulnerable patients are where harm and solicitation occur; if enabled, it carries reporting, rate limits and retention.

### 3.3 Doctor Q&A (`community.doctor_qa`)
1. A member asks a **general** question, tagged to a specialty. The submission form itself does the teaching: "This is for general information. For advice about your own treatment, book a consultation." Personal identifiers and clinical detail are discouraged and stripped where detected.
2. Triage: the moderator (or AI-001 later, always with human confirmation) checks whether the question is (a) answerable from PE-003 — reply with the article, (b) general and specialty-appropriate — route to an opted-in doctor's queue, (c) individual medical advice — **redirect to a consultation** with a one-tap booking link (OP-001/OP-018), or (d) urgent/crisis — escalate (§3.5).
3. The doctor answers from a template with a mandatory **general-information disclaimer**; the answer is reviewed by the moderator (and by the MS for defined sensitive topics) before publication; it is published with the doctor's byline, specialty and date, and is searchable — a good answer serves hundreds of future readers.
4. **Hard blocks**: an answer may not contain a prescription, a specific dose for the asker, a definitive individual diagnosis, or a claim of cure. The composer detects and blocks these patterns and requires the doctor to convert to a consultation instead.

### 3.4 Events (`community.events`)
- Hospital events: patient education classes (OP-038), support-group meet-ups (online via OP-018 or on campus), health camps (NC-035), awareness days, screening drives, immunisation days (OP-013), health-check offers (OP-014 — described factually, not as marketing copy inside a support group). Each event has date/time, venue or link, capacity, target audience, registration with confirmation and reminders, attendance capture (QR), materials (PE-003) and a post-event feedback form (EN-030). Registrations respect the patient's communication preferences; event promotion beyond the community requires marketing consent (NC-026).

### 3.5 Moderation, guardrails and crisis escalation
1. **Moderation queue** with SLA (default: 4 working hours for posts, 1 hour for flagged/high-risk, immediate for crisis). Actions: approve, edit-with-note, reject with a reason from a published list, hide, warn the member, suspend, ban, and escalate.
2. **Guardrail rules** (automated pre-screen, human decision): individual medical advice from a peer ("stop your metformin"), drug brand/dose mentions, contact details or attempts to move off-platform, sale or solicitation (including donor/organ solicitation, which is illegal), alternative-cure claims, defamation of staff or other patients, images containing identifiable third parties or clinical documents with PHI, and any content naming another patient.
3. **Crisis pathway** (non-negotiable): language suggesting suicidal ideation, self-harm, abuse, or an acute medical emergency triggers an **immediate** escalation — the post is withheld from public view, the assigned clinical adviser and the counsellor on duty are alerted in real time (EN-037, with phone escalation if unacknowledged), the member is shown crisis-support information and helpline numbers on screen straight away, and the incident is recorded. This path never waits in a moderation queue and is never closed by a moderator alone.
4. **Member reporting**: every post and reply has a Report action with categories (medical advice, harassment, spam, privacy breach, misinformation, self-harm concern); reports enter the queue at elevated priority with the reporter's identity visible only to moderators.
5. **Intermediary compliance**: published rules of participation and a **Grievance Officer** with contact details; complaints acknowledged within **24 hours** and resolved within **15 days**; unlawful content removed within **36 hours** of a valid order; a takedown and action register maintained for audit.

### 3.6 Exceptions
- Member deceased → account frozen; posts retained or de-identified per the family's request and hospital policy; no automated messages.
- Erasure request → member's posts deleted or de-identified within the DSAR SLA; replies that quote them are edited; the audit trail of moderation actions is retained as an intermediary record.
- Group falls quiet or becomes unsafe → the hospital may archive it (read-only) with notice; members are told where to go instead.
- Moderator unavailable (leave, night) → coverage roster; if no moderator is available, posting is paused with an honest message rather than left unmoderated.
- A grievance about hospital service posted publicly → routed to NC-032 with a reference number and a public, non-defensive acknowledgement; it is not silently deleted.

## 4. Data Model (schema `engage`, prefix `comm_`)
- **comm_members** — id, hospital_id, account_id (PE-001), patient_id, display_mode enum(real_name/pseudonym/anonymous), display_name, avatar_file_id?, joined_at, consent_id (EN-028), status enum(active/suspended/banned/left/frozen), suspension_until, strikes smallint, left_at, erasure_mode enum(keep_deidentified/delete_all)?, is_staff bool, staff_role_label. UNIQUE(hospital_id, account_id).
- **comm_groups** — id, hospital_id, code, name, description, rules_text, condition_tags text[], cohort_id? (PE-002), visibility enum(open/closed/curated), language, moderator_user_ids uuid[], clinical_adviser_user_id, status enum(active/archived), member_count, created_by, audit cols.
- **comm_group_members** — group_id, member_id, joined_at, role enum(member/moderator/adviser), approved_by?, left_at, muted bool.
- **comm_posts** — id, hospital_id, group_id?, thread_id?, parent_post_id?, member_id, kind enum(post/reply/question/answer), title?, body, attachments jsonb, language, status enum(pending_moderation/published/edited/rejected/hidden/withdrawn/deleted), risk_score numeric(4,2), auto_flags text[], moderated_by, moderated_at, moderation_note, rejection_reason_code?, published_at, edited_at, reaction_count, report_count, is_crisis bool, audit cols. Indexes (hospital_id, group_id, published_at desc), (status, risk_score desc), GIN trigram on body for search and duplicate detection. Partitioned by month.
- **comm_questions** — post_id, specialty_id, triage_status enum(pending/answered_by_article/routed_to_doctor/redirected_to_consult/escalated/closed), routed_to_doctor_id?, article_content_id? (PE-003), consult_link_appointment_id?, answered_post_id?, sla_due_at, closed_at.
- **comm_answers** — post_id, doctor_id, template_id, disclaimer_version, reviewed_by_moderator, reviewed_by_ms?, published_at, blocked_patterns_detected text[] (evidence that the composer's guardrails ran).
- **comm_reports** — id, post_id, reported_by_member_id, category enum(medical_advice/harassment/spam/privacy_breach/misinformation/self_harm/other), note, at, status enum(open/actioned/dismissed), actioned_by, action enum(none/edit/hide/reject/warn/suspend/ban/escalate), actioned_at, sla_due_at.
- **comm_moderation_actions** (append-only intermediary register) — id, target_type enum(post/member/group), target_id, action, reason_code, note, by_user_id, at, legal_order_ref?, takedown_deadline?, completed_at.
- **comm_crisis_incidents** — id, post_id?, member_id, detected_by enum(auto/moderator/member_report), detected_at, indicators text[], notified_users jsonb, acknowledged_by, acknowledged_at, action_taken, outcome enum(contacted/referred_to_counsellor/emergency_services/no_contact_possible/false_positive), clinical_note_ref?, closed_by, closed_at. (Restricted access: clinical adviser, counsellor, MS, DPO.)
- **comm_events** — id, hospital_id, title, type enum(class/support_meetup/camp/awareness/screening/immunisation/webinar), description, starts_at, ends_at, mode enum(onsite/online/hybrid), venue, join_link (OP-018), capacity, registration_required bool, target_groups uuid[], materials_content_ids uuid[] (PE-003), status, created_by, feedback_form_id (EN-030).
- **comm_event_registrations** — event_id, member_id?, patient_id?, registered_at, status enum(registered/waitlisted/attended/no_show/cancelled), qr_token_hash, attended_at, feedback_id?.
- **comm_rules** (published policy) — hospital_id, version, rules_text, grievance_officer_name, grievance_contact, effective_from, published_by (the intermediary-compliance artefact).
- **comm_banned_terms** — hospital_id, term, category enum(drug/dose/contact/solicitation/abuse/self_harm/claim), action enum(flag/block), language, active.
- Read models: `analytics.mv_comm_activity`, `mv_comm_moderation_sla`, `mv_comm_qa_outcomes`, `mv_comm_events`.
- RLS on `hospital_id`. Member identity mapping (member ↔ patient) is restricted to moderators, DPO and admins. Crisis incidents are PHI with restricted access and full audit. Retention: posts and moderation register per intermediary rules and hospital policy (default 3 years for content, 8 years for the moderation/takedown register and crisis incidents).

## 5. Business Rules & Validations
- **Participation requires a separate, explicit, withdrawable DPDP consent**; joining is never implied by having a portal account. Under-18 accounts are barred.
- **Pre-moderation is the default** for every new group and every new member (a member may be promoted to post-moderation after a configured number of clean posts, if the hospital enables it).
- **No individual medical advice, ever** — from staff or peers. The composer blocks prescription-like content (drug + dose + route patterns), definitive individual diagnoses and cure claims; the doctor's only permitted response to an individual clinical question is "please book a consultation" with the link. Every published answer carries the current disclaimer version.
- **Crisis content bypasses the queue**: withheld from public view, escalated in real time to the clinical adviser and the on-duty counsellor with phone escalation if unacknowledged in the configured minutes, crisis resources shown to the member immediately, and the incident recorded and clinically reviewed. A moderator may never close a crisis incident alone.
- **No PHI exposure**: display names never reveal UHID or contact details; the platform strips or blocks phone numbers, email addresses and document images containing identifiers; a post naming another patient is rejected.
- **No marketing inside support groups.** Events are factual listings; promotional campaigns live in NC-026 and require marketing consent. A member's presence in a condition group may never be used to target them (a diabetes group membership is health data).
- **Intermediary obligations are system-enforced**: rules of participation published and versioned; Grievance Officer contact displayed; complaint acknowledgement within 24 h and resolution within 15 days tracked with SLA timers; valid takedown orders completed within 36 h and registered.
- Moderation actions require a reason code from the published list and are append-only; a rejected post's reason is shown to its author (fair process reduces conflict).
- Staff post under verified identity only; a staff member may not participate anonymously or argue with patients — escalation to the moderator lead is the required path.
- Service complaints found in the community are routed to NC-032 with a reference; deleting a complaint without routing it is a policy violation and is itself audited.
- Rate limits: posts per member per hour, reports per member per day, links per post; new members have stricter limits.
- If no moderator is on duty (roster gap), posting is paused with an honest message rather than published unmoderated.

## 6. API Surface (`/api/v1/community`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| POST | /join ; POST /leave | join/leave with consent & erasure choice | community.member.self | Y | – |
| GET/PATCH | /me | display identity & preferences | community.member.self | Y | – |
| GET | /groups ; POST /groups/{id}/join ; DELETE /groups/{id}/leave | group discovery & membership | community.group.read / .join | Y | cursor |
| GET | /groups/{id}/posts ; POST /groups/{id}/posts | read/create posts | community.post.read / .create | Y | cursor |
| POST | /posts/{id}/replies ; POST /posts/{id}/react | replies & reactions | community.post.create | Y | – |
| POST | /posts/{id}/report | report content | community.post.report | Y | – |
| DELETE | /posts/{id} | withdraw own post | community.post.create | Y | – |
| POST | /questions | ask a general question | community.question.ask | Y | – |
| GET | /questions?specialty=&status= | Q&A browse | community.question.read | – | cursor |
| POST | /questions/{id}/triage | moderator triage (article/route/redirect/escalate) | community.moderate | Y | – |
| POST | /questions/{id}/answer | doctor answer (guardrails applied) | community.answer.create | Y | – |
| POST | /answers/{id}/review ; /publish | moderator/MS review | community.moderate / community.answer.publish | Y | – |
| GET | /moderation/queue?risk=&group=&sla= | moderation worklist | community.moderate | – | cursor |
| POST | /moderation/{postId}/action | approve/edit/reject/hide/warn/suspend/ban | community.moderate | Y | – |
| POST | /moderation/takedown | record a legal takedown order | community.takedown.execute | Y | – |
| GET | /crisis/incidents ; POST /crisis/{id}/acknowledge ; /close | crisis pathway | community.crisis.manage (restricted) | Y | cursor |
| GET/POST/PATCH | /events ; POST /events/{id}/register ; POST /events/{id}/attendance | events | community.event.read / .manage / .register | Y | cursor |
| GET/PUT | /rules | rules of participation & grievance officer | community.rules.configure | Y | – |
| GET/PUT | /banned-terms | guardrail dictionary | community.rules.configure | Y | cursor |
| GET | /reports/activity ; /reports/moderation-sla ; /reports/qa | analytics | community.report.read | – | – |
| GET | /public/rules ; /public/grievance-officer | statutory display | public | – | – |

## 7. Domain Events (outbox)
- `community.member.joined|left|suspended|banned` {member, reason} → EN-024 audit, PE-001 state.
- `community.post.submitted` {risk_score, auto_flags} → moderation queue, EN-037 moderator alert.
- `community.post.published|rejected|hidden` {reason_code} → author notification, group feed.
- `community.post.reported` {category} → elevated queue, SLA timer.
- **`community.crisis.detected`** {member, indicators} → **clinical adviser + counsellor real-time alert (phone escalation)**, crisis resources shown to the member, restricted incident record.
- `community.question.asked|triaged|answered|redirected_to_consult` → doctor queue, OP-001 booking link, PE-003 article suggestion, analytics.
- `community.event.published|registration.created|attendance.recorded` → EN-009 reminders, OP-014/NC-035, EN-030 feedback.
- `community.grievance.raised` → **NC-032** with the community reference.
- `community.takedown.executed` {order_ref, within_hours} → compliance register.
- `community.moderation.sla_breach` {queue_age} → moderator lead, Admin.
- Consumes: `patient.deceased` (freeze), `consent.withdrawn` (leave/erase), `dsar.erasure.approved` (PE-001 → content removal), `cohort.enrolled` (PE-002 → suggest the matching group), `education.content.published` (PE-003 → suggested reading in groups).

## 8. Screens
- **Community home** (phone-first, inside PE-001): my groups, recent activity, upcoming events, "ask a doctor" entry point, and a standing banner: "This community is for support and general information. It is not medical advice. In an emergency call <number>."
- **Group feed**: posts with author display name, time, reactions, replies; "pending review" state for the author's own unpublished posts (honest, not silent); report action on every item; pinned rules and the group's clinical adviser named; language filter.
- **Composer**: plain editor with live guardrail hints ("Please do not include medicine names and doses — ask your doctor instead"), attachment scanning, and a pre-submit reminder of the rules. Blocked content explains *why*, with a "book a consultation" alternative.
- **Ask a Doctor**: question form with specialty picker, a prominent "for advice about your own treatment, book a consultation" path, expected response time, and a search of already-answered questions before submitting (deflection is a feature).
- **Doctor answering console** (desktop/tablet, 10-minute weekly session): batch of triaged questions in the doctor's specialty, template with mandatory disclaimer, guardrail warnings inline, "convert to consultation" button, publish for moderator review; shows the doctor how many people read their previous answers.
- **Moderation queue** (desktop, moderator's home): tabs *Crisis (red)*, *Reported*, *High risk*, *Pending*, *Appeals*; each item with the auto-flags, the risk score, the member's history and one-key actions (`A` approve, `E` edit, `R` reject with reason, `H` hide, `S` suspend, `X` escalate); SLA timers visible; a roster indicator showing who is on duty. Crisis items are visually unmissable and cannot be bulk-actioned.
- **Crisis console** (restricted, counsellor/clinical adviser): the withheld post, the member's contact (revealed with justification and audit), the escalation checklist, helpline scripts, and the outcome record.
- **Events** (phone/desktop): calendar and list, registration with capacity and waitlist, QR ticket, add-to-calendar, join link for online events, materials, post-event feedback.
- **Rules & Grievance page** (public + in-app): rules of participation, moderation policy, Grievance Officer name and contact, complaint form with a reference number and the statutory timelines stated.
- **Admin analytics** (desktop): activity by group, moderation volume and SLA, rejection reasons, Q&A outcomes (answered / redirected to consult / article), crisis incidents (count and response times), event attendance, member growth and churn.
- All screens WCAG 2.2 AA, multilingual, phone-first; the crisis banner and helpline are always reachable in one tap.

## 9. Integrations
- **PE-001/OP-020** (identity, notifications, preference centre), **EN-028** (participation consent, withdrawal, erasure), **PE-003** (articles as answers and group reading), **PE-002** (cohort ↔ group linkage), **OP-001/OP-018** (convert a question into a consultation or tele-consult), **NC-032** (grievance routing with reference), **EN-030** (event feedback), **EN-037/EN-009/EN-032** (moderator alerts, phone escalation for crisis, event reminders, weekly digests), **NC-035/OP-014/OP-013** (camps, health checks, immunisation events), **NC-023** (legal escalations and takedown orders), **NC-027** (moderator training records), **AI-001** (question triage suggestions later, always human-confirmed), **EN-024** (audit).
- Content safety: banned-term dictionaries per language, PII detectors (phone/email/Aadhaar patterns), image scanning for embedded documents; all decisions surfaced to a human moderator rather than acting silently.

## 10. Reports & Analytics
- Participation: members, active members, posts and replies per group, growth and churn, language mix.
- **Moderation**: queue volume, SLA compliance (posts within 4 h, reports within 1 h), rejection reasons Pareto, appeals and outcomes, moderator workload — this is the report that tells the hospital whether the community is safely staffed.
- **Safety**: crisis incidents (count, detection source, time to acknowledge, outcome), self-harm false-positive rate, harassment and privacy-breach reports, takedown orders and compliance within 36 h.
- **Q&A**: questions asked, answered, deflected to articles, **redirected to consultations** (and how many of those actually booked — the clinical and commercial justification for the feature), average time to answer, most-read answers, doctor participation.
- Events: registrations, attendance, no-show, feedback scores, conversion to services where relevant (camps → follow-up visits, with NC-035).
- Sentiment and themes (light-touch, human-reviewed) feeding EN-030 and quality improvement.

## 11. Notifications
- **Member**: your post is live / was not published (with the reason and how to edit), a reply to your post, a doctor answered your question, group digest (weekly, opt-in), event reminder T−1 day and T−2 h, rules updated.
- **Moderator**: new item in the queue, reported content (elevated), SLA breach warning, roster handover summary.
- **Clinical adviser / counsellor**: **crisis alert (immediate push + call escalation if unacknowledged in the configured minutes)**, question escalated for clinical view.
- **Doctor**: questions waiting in your specialty (batched weekly, never nagging), your answer was published and has been read N times.
- **Admin/DPO**: intermediary grievance received (24 h acknowledgement clock), takedown order (36 h clock), monthly safety report.
- All member-facing notifications respect the PE-001 preference centre; community digests are opt-in and are never used as a marketing channel.

## 12. Permissions (RBAC keys)
`community.member.self` (Patient/Family — join, leave, manage own identity and posts) · `community.group.read|join` (members) · `community.post.read|create|report` (members) · `community.question.ask|read` (members) · `community.answer.create` (**opted-in Doctors only**) / `community.answer.publish` (Moderator; MS for defined sensitive topics) · `community.moderate` (Community Moderator — trained and rostered; includes triage, approve/reject, warn, suspend) · `community.member.ban` (Moderator lead / Admin) · `community.crisis.manage` (**restricted**: Clinical adviser, Counsellor, MS, DPO) · `community.takedown.execute` (Admin/Legal, audited) · `community.event.read|register` (members) / `community.event.manage` (Educator, Marketing, Admin) · `community.rules.configure` (Admin + DPO; publishes the intermediary policy and Grievance Officer details) · `community.report.read` (Admin, Quality, DPO, MS) · `community.identity.reveal` (Moderator, DPO — mapping a display name to a patient, with justification and audit).

## 13. Non-functional
- **Volumes** (a realistic P2 surface): 2,000–10,000 members, 50–300 posts/day, 20–60 questions/week, 5–15 events/month; moderation queue must be workable by 1–2 trained moderators per shift — if volume exceeds that, groups are throttled or paused rather than left unmoderated.
- **Performance**: feed p95 < 250 ms (cursor pagination, cached counts); composer guardrail check < 150 ms client+server; moderation queue < 200 ms; crisis alert dispatched < 5 s from detection to the adviser's device.
- **Availability**: if the moderation service or the roster is unavailable, posting pauses with a clear message; read access remains.
- **Offline**: read-only cached feed; composing offline is allowed but posts submit only when online (and still pre-moderated).
- **Accessibility/i18n**: WCAG 2.2 AA, screen-reader friendly threads, per-group language, translation of rules and crisis resources into every supported language; crisis helpline numbers localised by state.
- **Security/privacy**: member↔patient mapping restricted and audited; no clinical data ever rendered in community surfaces; attachments scanned and stripped of EXIF/location; rate limits and bot protection; the moderation and takedown register is append-only and exportable for legal proceedings.
- **Staffing note (non-negotiable)**: this module must not be enabled without a named moderator roster, a named clinical adviser per group, a named Grievance Officer, and trained crisis handling — the feature flags default OFF for exactly this reason.

## 14. Acceptance Criteria
1. Given a portal user without community consent, when they open the community tab, then they see the rules and a consent step, and no posts are visible until consent is recorded in EN-028.
2. Given an account belonging to a person under 18, when joining is attempted, then it is blocked with the children's-data reason.
3. Given a new member's first post, then it is held in `pending_moderation`, the author sees an honest "pending review" state, and it is not visible to others.
4. Given a post containing a drug name with a dose ("take metformin 1000 mg twice daily"), then the composer blocks it with an explanation and offers a consultation link; if submitted via API, it is auto-flagged and cannot be published without moderator override with a reason.
5. Given a post containing language indicating suicidal ideation, then it is withheld from public view, a crisis incident is created, the clinical adviser and on-duty counsellor are alerted within 5 s with phone escalation if unacknowledged, and crisis helpline information is displayed to the member immediately.
6. Given a crisis incident, when a moderator attempts to close it, then closure is denied — only `community.crisis.manage` holders may close it, with a recorded outcome.
7. Given a member asks an individual clinical question, then the triage routes it to "redirect to consultation" with a one-tap booking link, and the redirect-to-booking conversion is reported.
8. Given a doctor drafts an answer containing a definitive individual diagnosis, then the guardrail blocks publication and records the detected pattern.
9. Given any published answer, then it carries the current disclaimer version, the doctor's byline and date, and is searchable by other members.
10. Given a member reports a post as harassment, then it enters the queue at elevated priority with a 1-hour SLA and the reporter's identity is visible only to moderators.
11. Given a valid legal takedown order, then the content is removed within 36 hours, the order reference and completion time are recorded in the append-only register.
12. Given an intermediary grievance is submitted, then it is acknowledged within 24 hours and resolution is tracked against the 15-day limit, with the Grievance Officer's contact publicly displayed.
13. Given a member requests erasure through PE-001, then their community content is deleted or de-identified per their choice within the DSAR SLA, while the moderation register is retained.
14. Given a patient is recorded deceased, then the member account is frozen and no community notification is ever sent.
15. Given a service complaint is posted publicly, then it is routed to NC-032 with a reference number and the member is told the reference; deleting it without routing is blocked.
16. Given no moderator is on duty per the roster, then posting is paused with an honest message and read access continues.
17. Given a member's group memberships, then they are never used for marketing segmentation (verified by an NC-026 exclusion test).
18. Given a user without `community.identity.reveal`, when attempting to map a display name to a patient record, then 403 and an audit entry are recorded.

## 15. Enhancements / Later phases
- From the VIMS sheet (row 144): support groups, forum, doctor Q&A, event calendar — all covered, with the safety, moderation and intermediary-compliance layer the source did not anticipate (and which is the reason most hospitals abandon community features).
- Later: **AI-assisted triage and pre-moderation** (AI-001/AI-002) proposing article answers and risk scores, always with human confirmation; multilingual auto-translation of posts so a Tamil and a Hindi member can support each other (human-reviewed for clinical terms); condition-specific peer-mentor programmes (trained volunteer patients with a code of conduct and hospital oversight); live moderated webinars with Q&A (OP-018); integration with validated PROMs so a group can see anonymised aggregate progress; survivorship and caregiver-burnout programmes with counsellor involvement; sentiment and theme analytics feeding quality improvement; a WhatsApp-group bridge (only if moderation parity can be guaranteed — otherwise explicitly out of scope, because unmoderated WhatsApp groups are where hospital-branded communities usually go wrong).

## 16. Open Questions for the Hospital
1. Do you actually want a patient community? Who will moderate it, on which shifts, and are they trained? (Without a named roster this module should stay switched off.)
2. Which condition groups would you start with, and who is the clinical adviser for each?
3. Will doctors participate in Q&A, how many hours per week, and who reviews their answers before publication?
4. Pre-moderation for everything, or post-moderation for mature groups? What is your acceptable moderation SLA?
5. Who is your **Grievance Officer** for intermediary compliance, and where will the contact be published?
6. What is your crisis pathway today — who is called when a patient expresses suicidal ideation, at 02:00 on a Sunday?
7. Do you want peer-to-peer direct messaging? (Default off; it materially increases risk.)
8. Should support-group members be allowed to post photographs? (Wound photos and reports are the usual privacy accidents.)
9. Which events do you want to publish here — classes, camps, awareness days, screening drives — and who manages the calendar?
10. What is your policy when a patient posts a public complaint about the hospital?
11. Which languages must the community, rules and crisis resources support?
12. Retention: how long should community content be kept, and what happens to a member's posts when they leave?
