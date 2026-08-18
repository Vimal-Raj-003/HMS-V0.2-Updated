# NC-027 — Training & Development (Training Calendar & Needs, Attendance, Certifications (BLS/ACLS/Fire/Infection Control), Competency Assessment, E-Learning/LMS, NABH Training Records)

| Field | Value |
|---|---|
| Domain | Non-Clinical / ERP |
| Module ID | NC-027 |
| Phase | 9 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | NC-010 (employee master, designations, joining/induction triggers, credentialing & licence expiry, appraisal link, exit), NC-029/NC-030 (attendance/roster to schedule sessions and mark training attendance; release from duty), NC-014 (staff mobile: my trainings, e-learning, certificates), NC-015 (NABH HRM.4–HRM.7 training/competency evidence, quality indicators; incident → training CAPA), NC-020 (equipment user training records), IP-012 (infection control/hand-hygiene training), IP-013 (BLS/ACLS/code blue drills), NC-019 (fire safety/code drills), NC-016 (BMW training — mandatory annual), NC-004 (SOP/policy read-and-acknowledge, training materials), EN-039 (assessment/quiz templates & certificates), EN-016 (e-signed certificates), NC-025 (training room booking), NC-033 (refreshments), NC-021 (external trainers/vendors, AHA/NRC training centres), NC-022 (training budget), NC-026 (CME events for external doctors), EN-037/EN-032/EN-009 (notifications), EN-018 (TV notices), NC-011, EN-024, EN-007 (login/roles for e-learning) |
| Feature flag | `module.training.enabled` (sub: `training.lms`, `training.competency`, `training.external_certs`, `training.cme_credits`, `training.scorm`) |
| Primary roles | Training Coordinator / L&D Manager, Nursing Educator, HR (47), Department trainers/HODs |
| Secondary roles | All employees (learners), Quality Manager (54; NABH evidence), Infection Control Nurse (21), Fire/Safety officer (NC-019), Biomedical (48; equipment training), MS (4), Contract staff supervisors (NC-021), Auditor (58) |
| Regulatory | NABH 6th ed. HRM.4 (induction), HRM.5 (ongoing training: safety, infection control, BLS/ACLS as per role, fire, BMW, patient rights, code of conduct), HRM.6 (competency assessment), HRM.7 (medical staff CME), NABL ISO 15189 §6.2 (lab personnel competency & records), BMW Rules 2016 Rule 4(k) (annual training, records), Fire safety training & drills (state rules/NBC), NMC/State Medical Council CME credit requirements for licence renewal (e.g. 30 credits/5 yrs), INC/State Nursing Council CNE (continuing nursing education), POSH Act 2013 (mandatory awareness training), DPDP Rules 2025 (staff privacy training), Blood bank (SBTC training), Radiation safety (AERB RSO/technologist training — NC-020), Occupational safety (Hep B vaccination linked to NC-010), Apprentices Act (if applicable), Data retention (training records for accreditation cycles) |

## 1. Purpose
NC-027 manages staff learning end-to-end: **training needs & annual calendar** (mandatory by role: induction, BLS/ACLS, fire safety, infection control/hand hygiene, BMW, patient safety/NABH, POSH, DPDP/privacy, equipment-specific; plus departmental & soft skills), **session scheduling** (trainer, room NC-025, roster release NC-030), **attendance** (QR/biometric/mobile), **assessments & competency** (pre/post tests, skill checklists/OSCE, sign-offs by educator), **certification tracking** with expiry (BLS 2 yrs, ACLS 2 yrs, fire annual, BMW annual, NALS/PALS, ATLS, radiation safety…) and renewal alerts, **e-learning/LMS** (video/SCORM/quizzes, mobile), **CME/CNE credit** logging for doctors/nurses, external training records, training effectiveness (Kirkpatrick levels), and NABH-ready **training records per employee/department**.

## 2. Users & Jobs-to-be-done
- **Training coordinator/Nursing educator** (desktop): build annual calendar from role matrix & needs (TNA), schedule sessions, assign trainers, publish, take attendance, upload materials/quizzes, record scores & competencies, issue certificates, chase overdue mandatory training, prepare NABH reports.
- **Employee** (NC-014 mobile/web): see my mandatory & assigned trainings, register/nominate, join (QR check-in), take e-learning & quizzes, download certificates, log external CME/CNE with proof, view competency status.
- **HOD/Manager**: nominate staff, approve external training/travel, view team compliance, conduct on-the-job competency assessments.
- **HR**: induction workflow, link to appraisal/increment eligibility, training hours per employee, cost centre charging.
- **Quality/ICN/Safety officer/BME**: run mandatory programmes, evidence for audits, drill records (link NC-019/IP-013).
- **External trainer/vendor**: session delivery, participant lists, certificates (AHA cards) upload.

## 3. Core Workflows
### 3.1 Training matrix & needs analysis
1. **Coordinator** defines **programmes** (code, title, category enum(induction/mandatory_safety/clinical_skill/equipment/soft_skill/leadership/compliance/it_system/department_specific/cme), delivery enum(classroom/online/blended/on_the_job/simulation/drill), duration, validity_months (recertification), passing criteria (score %, skill checklist), trainer pool, materials (NC-004), cost) → **role matrix**: which designations/departments/categories (NC-010) need which programmes, within X days of joining, and recurrence (e.g. BLS every 24 months for all clinical; fire annually all staff; BMW annually all; ACLS for ICU/ER/OT/anaesthesia; NALS labour room/NICU; hand hygiene 6-monthly; POSH annual; equipment: ventilator for ICU nurses (NC-020 list)) → **System** computes per-employee **requirements & due dates** (joining, last completion + validity) → gap report; **TNA** inputs: appraisal recommendations (NC-010), incident CAPA (NC-015), new equipment (NC-020), new modules (IT), department requests → annual plan & budget (NC-022) → Event `training.plan.published`.

### 3.2 Calendar & session scheduling
1. Create **session** for programme: date/time, venue (NC-025 room booking auto), capacity, trainer(s) (internal/external NC-021), target audience (auto-invite due employees; nominations by HODs; self-enrol), materials, pre-reading (LMS), assessment template → publish → invitations (EN-037/EN-009/email) → registration/waitlist → roster conflict check (NC-030: on-duty staff → release request to in-charge; night-shift-friendly slots) → reminders → Event `training.session.scheduled`.
2. Recurring sessions (monthly BLS batches), department-wise batches, simulation lab bookings, drills (link NC-019 fire drill/IP-013 mock code) recorded as sessions with participants.

### 3.3 Attendance & delivery
- Check-in via QR (session code) on mobile / biometric (NC-029 device in training hall) / manual by trainer; late/partial attendance rules; no-shows → notify HOD; online sessions (link; attendance via join time/quiz completion) → Event `training.attendance.recorded`.

### 3.4 Assessment, competency & certification (`training.competency`)
1. Pre/post tests (EN-039 quiz templates: MCQ, true/false, scenario; question banks; randomisation) → auto-score → pass/fail → retake policy; **skill checklists/OSCE** (e.g. BLS steps, hand-hygiene 5 moments, IV cannulation, ventilator setup, crash-cart check, safe injection) assessed by educator on tablet with sign-off (e-sign) → **competency status** per employee per skill (competent/needs supervision/not assessed) with validity → used by NC-030 (skill-based rostering: ICU-competent nurses), NC-020 (equipment users), NC-018 (terminal clean certified) → **certificate** issued (template EN-039, QR-verifiable, e-signed EN-016), stored in employee record (NC-010) → expiry tracking & renewal reminders (90/30/7 days) → lapsed → status `expired` + HOD alert; **external certifications** (`training.external_certs`: AHA BLS/ACLS cards, ATLS, NALS, PALS, FCCS, infection control diploma, radiation safety) uploaded by employee/HR with number/validity/issuer → verified → same tracking.
2. **CME/CNE credits** (`training.cme_credits`): doctors/nurses log credits (internal CME events NC-026/NC-027, external conferences with certificates) → credit ledger per licence renewal period → shortfall alerts (with NC-010 credentialing).

### 3.5 E-learning / LMS (`training.lms`)
- Courses (modules: video (S3/HLS), PDF, SCORM/xAPI packages `training.scorm`, quizzes), enrolment rules (auto by role matrix; self), progress tracking, completion → auto-issue certificate; mobile-first (NC-014) with offline download of videos (DRM-light), multi-language; micro-learning nudges; policy read-and-acknowledge (NC-004 documents assigned as mandatory reads with quiz).

### 3.6 Effectiveness, feedback & reports
- Session feedback (learner rating of trainer/content), Kirkpatrick L1 (reaction), L2 (test gain), L3 (behaviour: supervisor follow-up checklist after 30–90 days), L4 (results: link indicators e.g. hand-hygiene compliance IP-012, incident rates NC-015); trainer performance; training hours per employee/department; cost per training hour; NABH HRM evidence packs (induction records, mandatory training compliance %, competency assessments, CME).

### 3.7 Induction & exit
- On `hr.employee.joined` → induction plan (general + department + role) with checklist & timeline (day 1/7/30), buddy, mandatory e-learning; completion feeds probation confirmation (NC-010). On exit → training records archived (retention).

## 4. Data Model (schema `hr`, prefix `trn_`)
- **trn_programmes**: id, hospital_id, code, title, category enum, delivery enum, duration_hours, validity_months?, passing_score?, skill_checklist_template_id?, quiz_template_id?, materials jsonb, trainer_pool uuid[], cost_per_head?, cme_credits?, is_mandatory bool, active. UNIQUE (hospital_id, code).
- **trn_role_matrix**: id, hospital_id, programme_id, applies_to jsonb {designations[], departments[], categories[], branches[]}, due_within_days_of_joining, recurrence_months, effective_from.
- **trn_requirements** (materialised per employee): employee_id, programme_id, due_at, status enum(due/scheduled/completed/overdue/expired/exempt), last_completed_at, valid_until, exemption_reason. UNIQUE (employee_id, programme_id); INDEX (status, due_at).
- **trn_sessions**: id, hospital_id, branch_id, programme_id, session_no, title, starts_at, ends_at, venue_booking_id? (NC-025), online_link?, capacity, trainers jsonb [{user_id/vendor_id, name}], audience_rule jsonb, materials jsonb, assessment_template_id?, status enum(draft/published/ongoing/completed/cancelled), is_drill bool, drill_ref? (NC-019/IP-013), cost, created_by. INDEX (hospital_id, starts_at), (programme_id).
- **trn_enrolments**: session_id, employee_id, source enum(auto/nomination/self/waitlist), nominated_by?, roster_release_status enum(n/a/requested/approved/denied), status enum(enrolled/waitlisted/attended/partial/no_show/cancelled), checkin_at, checkout_at, feedback jsonb. UNIQUE (session_id, employee_id).
- **trn_assessments**: id, employee_id, programme_id, session_id?, kind enum(pre_test/post_test/skill_checklist/osce/observation), template_id, responses jsonb, score numeric, max_score, result enum(pass/fail/competent/needs_supervision), assessor_user_id, assessed_at, signature_ref, attempt_no. INDEX (employee_id, programme_id).
- **trn_competencies** (employee_id, skill_code, level enum(not_assessed/needs_supervision/competent/expert), assessed_at, valid_until, assessment_id, assessor). UNIQUE (employee_id, skill_code); INDEX (skill_code, level).
- **trn_certificates**: id, employee_id, programme_id?/external_name, certificate_no, issuer enum(internal/aha/nrc/atls/college/other) + issuer_name, issued_at, valid_until, file_id, qr_verify_code, esign_ref?, verified_by?, status enum(valid/expiring/expired/revoked). INDEX (employee_id), (valid_until).
- **trn_cme_ledger** (employee_id, licence_period_start/end, credits_required, entries jsonb [{event, date, credits, proof_file_id, verified}], total, status).
- **trn_courses** (LMS): id, title, modules jsonb [{type: video/pdf/scorm/quiz, ref, duration, order}], programme_id?, languages text[], enrol_rule jsonb, active; **trn_course_progress** (course_id, employee_id, module_progress jsonb, pct, completed_at, score, cert_id); **trn_scorm_tracking** (course_id, employee_id, cmi jsonb).
- **trn_question_bank** (EN-039 refs: programme_id, questions jsonb, difficulty), **trn_feedback** (session_id, employee_id, ratings jsonb, comments), **trn_l3_followups** (employee_id, programme_id, due_at, supervisor_id, checklist jsonb, result), **trn_induction_plans** (employee_id, checklist jsonb, buddy_id, status, completed_at), **trn_external_requests** (employee_id, programme/conference, cost, approvals, travel, outcome).
- **analytics.training_compliance** (branch, department, month: employees, mandatory_due, completed_pct, expired_certs, hours_per_employee, sessions, avg_feedback, cost).
- RLS; certificates & training records retained employee tenure + 5 years (NABH cycles).

## 5. Business Rules & Validations
- Requirements engine recomputes on employee join/transfer/designation change and on completion; mandatory overdue → visible on employee ESS/HOD dashboards; configurable consequences (e.g. block roster to ICU without valid BLS/ACLS competency via NC-030 warning/hard-stop; equipment use flag NC-020).
- Certification validity from programme (BLS/ACLS 24 months etc.); expiring alerts 90/30/7 days; expired → competency downgraded to `needs_supervision` (config).
- Attendance: check-in within ± window; partial < 80 % duration → not counted as completed; no-shows notified; roster release needed for on-duty staff (NC-030 approval).
- Assessment: passing criteria per programme; max attempts then remedial session; skill sign-off only by authorised assessors (role/competency `assessor` for that skill); e-sign on checklists.
- Certificates QR-verifiable at public verify endpoint (no PHI: name, programme, validity); revocation supported.
- CME: credits verified by coordinator; shortfall alerts 6 months before licence renewal (NC-010).
- Drill sessions flagged `is_drill` link to NC-019/IP-013 records — single source of participants.
- Costs to department cost centre (NC-008); external training approvals via EN-038 with bond/service agreement note (NC-010).
- Numbering `TRN_SESSION`, `CERT`; audit on assessments/certificates.

## 6. API Surface (`/api/v1/training`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET/POST/PATCH | /programmes ; /role-matrix ; POST /requirements/recompute | catalogue & matrix | training.programme.manage / .read | Y | cursor |
| GET | /requirements?employee=&status=&dept= ; GET /me/requirements | due/overdue | training.requirement.read (HOD ABAC dept; self) | – | cursor |
| POST/GET/PATCH | /sessions ; POST /sessions/{id}/(publish|cancel|complete) ; GET /calendar?from=&to= | sessions | training.session.manage / .read | Y | cursor |
| POST | /sessions/{id}/enrol {employee_ids} ; POST /sessions/{id}/self-enrol ; POST /sessions/{id}/nominate ; POST /enrolments/{id}/roster-release | enrolment | training.enrol.manage / training.self.enrol / training.nominate (HOD) | Y | – |
| POST | /sessions/{id}/checkin {qr|employee_id} ; POST /sessions/{id}/attendance (bulk) | attendance | training.attendance.record (trainer) / self checkin | Y | – |
| POST/GET | /assessments ; POST /assessments/{id}/sign ; GET /competencies?skill=&level= ; GET /employees/{id}/competencies | assessment/competency | training.assessment.record (assessor) / training.competency.read | Y | cursor |
| POST/GET | /certificates ; POST /certificates/external ; POST /certificates/{id}/(verify|revoke) ; GET /verify/{code} (public) | certificates | training.certificate.manage / self upload / – | Y | cursor |
| POST/GET | /cme ; POST /cme/{id}/verify | CME ledger | training.cme.log (self) / .verify | Y | cursor |
| GET/POST | /courses ; POST /courses/{id}/enrol ; POST /courses/{id}/progress ; POST /scorm/{course}/commit | LMS | training.course.manage / training.course.learn (self) | Y | cursor |
| POST/GET | /feedback ; /l3-followups ; /induction ; /external-requests | effectiveness/induction | training.feedback.submit / training.followup.record / training.induction.manage / training.external.request|approve | Y | cursor |
| GET | /dashboard ; /reports/(compliance|expiring-certs|hours|competency-matrix|session-feedback|trainer|nabh-hrm|cme-status|cost) ; GET /employees/{id}/training-record (PDF) | analytics | training.report.read | – | – |

## 7. Domain Events (outbox)
- `training.plan.published`, `training.session.scheduled|published|cancelled|completed` {session_id, programme, when, venue} → EN-037 invites, NC-025 (room), NC-030 (roster release), NC-014.
- `training.enrolment.created|waitlisted|roster_release_requested|approved` → employee, in-charge.
- `training.attendance.recorded` {session_id, employee_id, status} → requirements engine, NC-010 (hours), NC-029 (on-duty training).
- `training.assessment.recorded|competency.updated` {employee_id, skill, level, valid_until} → NC-030 (skill rostering), NC-020 (equipment users), NC-018 (certified cleaners), NC-010 (appraisal), NC-015 (indicators).
- `training.certificate.issued|expiring|expired|revoked` {employee_id, programme, valid_until} → employee, HOD, NC-010 credentialing, NC-030.
- `training.requirement.overdue` {employee_id, programme} → employee/HOD/HR; NC-015 compliance %.
- `training.cme.shortfall` → doctor/nurse, NC-010.
- Consumes: `hr.employee.joined|transferred|designation.changed|exited` (NC-010), `roster.published` (NC-030), `attendance.punch.recorded` (NC-029 hall device), `incident.capa.training_required` (NC-015), `bme.equipment.registered` (NC-020 → user training need), `security.drill.recorded|code.blue.drill` (NC-019/IP-013 → session), `document.published.mandatory_read` (NC-004), `crm.event.created` (NC-026 CME), `facility.booking.approved` (NC-025).

## 8. Screens (UI)
- **Training Calendar** (desktop; mobile agenda): month/week views by programme/department, session cards (seats left, trainer), publish, clone; `N` new session.
- **Session Console** (tablet at venue): participant list, QR check-in scanner/QR display for self check-in, attendance toggles, launch quiz, upload materials, feedback QR, complete session → certificates batch.
- **My Learning** (NC-014 mobile/web): mandatory due list with due dates & progress, enrol/self-check-in, e-learning player (video/PDF/SCORM), quizzes, certificates wallet (QR), competencies, CME ledger, external cert upload.
- **Assessor App** (tablet): skill checklist with step ticks, comments, signature; OSCE stations.
- **Compliance Dashboard** (desktop; HOD scoped): mandatory training compliance % by department/programme (heatmap), overdue employees, expiring certifications, competency matrix (employees × skills), drill records; NABH HRM evidence export.
- **Programme & Matrix Admin**, **Question Bank/Quiz Builder** (EN-039), **LMS Course Builder** (upload video/SCORM, modules, languages), **Reports**.
- Empty/error states; WCAG 2.2 AA; i18n (content multi-language; captions).

## 9. Integrations
- NC-010 employee/credentialing/appraisal; NC-029 hall biometric; NC-030 roster release & skill flags; NC-025 rooms; NC-021 external trainers/vendors (AHA/NRC centres); EN-039 quiz/certificate templates; EN-016 e-sign; S3/HLS video streaming; SCORM 1.2/2004 & xAPI runtime; video conferencing links (Zoom/Meet/Teams — join tracking via API where available); NC-004 policy reads; NC-015 CAPA & indicators; NC-020 equipment; IP-012 hand hygiene audits (L4 link); NC-019/IP-013 drills; NC-026 CME events; NC-014 mobile; NC-022/NC-008 costs; council CME portals (manual/URL); EN-018 TV notices for sessions.

## 10. Reports & Analytics
- Mandatory training compliance % (by programme/department/branch; NABH HRM.5), induction completion within timeline (HRM.4), competency matrix & gaps (HRM.6), certification expiry calendar (BLS/ACLS/fire/BMW…), training hours per employee/FTE, session utilisation (capacity vs attendance), no-show rate, assessment pass rates & score gain (pre/post), trainer ratings, e-learning completion, CME/CNE credit status (HRM.7), drill participation, training cost per head & vs budget, L3 follow-up outcomes, employee training record (PDF for audits). Read model `analytics.training_compliance`.

## 11. Notifications
- Employee: new requirement, session invite/reminder (T-3/T-1/T-2h), enrolment confirmed/waitlist, quiz results, certificate issued, expiring cert (90/30/7), overdue mandatory, CME shortfall; HOD: nominations due, team overdue, roster release requests, no-shows; Trainer: session assigned, roster; Coordinator: low enrolment, venue conflicts, feedback summary; HR/Quality: monthly compliance digest; TV: upcoming sessions.

## 12. Permissions (RBAC keys)
`training.programme.manage|read`, `training.requirement.read` (self; HOD ABAC department; coordinator all), `training.session.manage|read`, `training.enrol.manage`, `training.self.enrol`, `training.nominate` (HOD), `training.attendance.record` (trainer), `training.assessment.record` (authorised assessors per skill), `training.competency.read`, `training.certificate.manage`, `training.cme.log|verify`, `training.course.manage|learn`, `training.feedback.submit`, `training.followup.record` (supervisors), `training.induction.manage`, `training.external.request|approve`, `training.report.read`, `training.export`, `training.configure`. Defaults: Training coordinator/Nursing educator all; HR (47) manage; HOD (5) nominate/read; all employees self; Quality (54)/ICN (21)/BME (48) session manage for own programmes; Auditor (58) read.

## 13. Non-functional
- Volumes: 5,000 employees, 300 sessions/month, 30k requirements rows, 2k e-learning completions/month, video streaming to 500 concurrent (CDN); requirements recompute nightly < 5 min; dashboards from read model.
- Offline: mobile e-learning downloads; assessor app checklists queue; check-in offline with sync.
- Security: RLS; records data class HR; certificate verify endpoint minimal data; audit.
- Printing: certificates (PDF, QR), attendance sheets, NABH packs; i18n; WCAG 2.2 AA (captions, keyboard quiz).

## 14. Acceptance Criteria
1. Given a new ICU nurse joins, then requirements auto-create: induction (30 days), BLS & ACLS (60 days), fire, BMW, hand hygiene, ventilator training (NC-020), POSH, DPDP with due dates on her My Learning list.
2. Given a BLS session published for 20 seats with 25 due nurses, then 20 auto-enrol by due-date priority and 5 waitlist; on-duty enrollees get roster-release requests to in-charges.
3. Given a learner checks in via QR at 09:05 for a 09:00 session and stays till end, then attendance is `attended`; leaving after 40 % marks `partial` and requirement stays due.
4. Given a post-test score 65 % with pass 70 %, then result fail, retake offered (max 2), and no certificate issued.
5. Given a skill checklist for "hand hygiene 5 moments" signed by an authorised assessor, then competency = competent valid 6 months; a non-authorised user cannot sign (403).
6. Given a BLS certificate expiring in 30 days, then employee and HOD are notified; on expiry, competency downgrades and NC-030 shows a warning when rostering to ICU (or blocks per config).
7. Given an external AHA ACLS card uploaded with validity, when verified by coordinator, then requirement ACLS is satisfied till validity.
8. Given a mandatory policy (NC-004) assigned with quiz, then completion appears in training record and compliance % updates.
9. Given a fire drill recorded in NC-019 with 40 participants, then a training session `is_drill` is created and participants' fire-safety requirement is updated per policy.
10. Given the NABH HRM report for June, then compliance % by programme/department, expiring certs and competency gaps export to PDF/xlsx.
11. Given a doctor with 12/30 CME credits and licence renewal in 6 months, then a shortfall alert is sent and shown in NC-010 credentialing.

## 15. Enhancements / Later phases
- From VIMS sheet: training calendar, attendance, certification track, e-learning (Phase 9 core above).
- (market) Simulation-lab scheduling & scenario library, AI-generated quizzes from SOPs (AI), adaptive micro-learning nudges, gamification/leaderboards, virtual classroom integration with auto-attendance, skills-based staffing optimisation with NC-030, learning paths for career ladders (nursing clinical ladder), external LMS integrations (Moodle/xAPI LRS), CME accreditation workflow with councils, multilingual voice-over content, VR training modules.

## 16. Open Questions for the Hospital
1. Mandatory training matrix by role (programmes, validity, due-within-joining) — provide the current NABH training plan; assessors list?
2. Existing LMS/content (videos, SCORM) to migrate; languages needed?
3. Certification providers (AHA/NRC centres in-house?) and certificate templates/signatories?
4. Roster release policy for training during duty; training hours target per employee?
5. Consequences for overdue mandatory training (roster blocks, appraisal impact)?
6. CME/CNE credit rules per council applicable to your doctors/nurses?
7. Training budget & external training approval matrix; bond policy?

