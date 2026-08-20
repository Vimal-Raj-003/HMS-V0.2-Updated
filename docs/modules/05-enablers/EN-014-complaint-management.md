# EN-014 — Complaint Management (Shared Engine → see NC-032 Patient Grievance / Complaint & Feedback)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Module ID       | EN-014                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Phase           | 10                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Complexity      | Low (thin façade over NC-032)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Depends on      | NC-032 (owner of the complaint/grievance engine: register, categories, auto-assignment, escalation matrix, SLA timers, resolution, feedback loop, analytics), EN-038 (SLA/escalation engine), EN-037 (notifications), EN-009 (SMS/WhatsApp), EN-030 (satisfaction survey), NC-015 (NABH indicators/CAPA), NC-028 (IT helpdesk tickets — staff IT complaints), EN-012 (public complaint portal form), EN-034 (kiosk), AI-001 (NLP categorisation, later) |
| Feature flag    | `module.complaints.enabled` (same flag as NC-032; EN-014 has no separate flag)                                                                                                                                                                                                                                                                                                                                                                          |
| Primary roles   | Quality Manager (54), Hospital Admin, HODs, Front office/Call centre (registration), all staff (raise)                                                                                                                                                                                                                                                                                                                                                  |
| Secondary roles | Patient/family (portal/kiosk/website/WhatsApp), Auditor                                                                                                                                                                                                                                                                                                                                                                                                 |
| Regulatory      | NABH PRE (patient rights: grievance redressal, displayed process, TAT), Clinical Establishments Act grievance officer, DPDP grievance officer & complaint timelines, Consumer Protection Act record-keeping                                                                                                                                                                                                                                             |

## 1. Purpose

The VIMS master sheet lists "Complaint Management" both as a non-clinical module and as an enabler. Vim's HMS implements **one shared complaint/grievance engine in NC-032**; EN-014 exists only as an index-level alias so that enabler-domain integrations (website form, kiosk, WhatsApp inbound, staff IT complaints, TV/QR "raise a complaint" codes) plug into that engine. Do **not** build separate tables, APIs or screens for EN-014 — implement everything in NC-032 and reference this file for the enabler touch-points below.

## 2. Users & Jobs-to-be-done

- Same as NC-032. From the enabler side: patients raise complaints via website form (EN-012), kiosk (EN-034), WhatsApp keyword/button (EN-009), QR posters (EN-013 signed token → complaint form pre-filled with location/ward); staff raise from any screen (`Ctrl+Shift+C` quick "Report an issue" that captures screen context) — IT/system issues route to NC-028 helpdesk, service/behaviour/facility issues to NC-032.

## 3. Core Workflows (owned by NC-032 — summarised here only for the enabler channels)

1. **Channel intake** → normalised payload {source: patient/family/staff/doctor, channel: in_person/phone/app/website/kiosk/whatsapp/qr, complainant, category (Clinical/Administrative/Facility/Staff behaviour/Billing/Other), priority (Low/Medium/High/Critical), description, attachments, location/ward, related encounter} → `POST /api/v1/complaints` (NC-032) → ticket no → acknowledgement via channel of origin (SMS/WhatsApp/email/on-screen) → Event `complaint.registered`.
2. **Auto-assignment** by category→department/person map; **escalation matrix** with SLA (Low 72 h, Medium 48 h, High 24 h, Critical 4 h; L1 HOD → L2 Admin → L3 Director) via EN-038 timers; **resolution** with root cause & corrective action; **feedback loop** (complainant notified, satisfaction survey via EN-030); **analytics** (volume trend, category distribution, avg resolution time, repeat complaints, department-wise TAT) in EN-001 widgets — all per NC-032 spec.
3. Enabler-specific rules: website/kiosk submissions require OTP-verified mobile (spam control) and DPDP consent; WhatsApp intake uses EN-009 inbox → "Create complaint" action; QR poster tokens encode location so tickets auto-tag ward/floor; staff quick-report attaches screen/route id (no PHI) for triage.

## 4. Data Model

None owned. Uses NC-032 tables (`engage.complaints`, `complaint_categories`, `complaint_assignments`, `complaint_escalations`, `complaint_resolutions`, `complaint_feedback`). Enabler channels only add `source_channel` and `intake_meta jsonb` (utm/kiosk id/qr location/whatsapp conversation id) — columns defined in NC-032.

## 5. Business Rules & Validations

As NC-032. Additional: public channels rate-limited (5 tickets/day/mobile), attachments virus-scanned, anonymous complaints allowed only through the in-hospital kiosk/QR channel if hospital policy enables (`complaints.allow_anonymous`), and staff-vs-IT routing decided by category (IT categories → NC-028 with cross-reference id).

## 6. API Surface

No new endpoints. Enabler channels call NC-032 endpoints: `POST /api/v1/complaints` (public variant `POST /api/v1/web/public/complaints` via EN-012 API key + OTP), `GET /api/v1/complaints/:ticketNo/status` (public, token), WhatsApp inbox action → same. Permission keys are NC-032's (`complaint.ticket.create/read/assign/resolve/escalate/close`, `complaint.report.read`).

## 7. Domain Events

NC-032 events (`complaint.registered|assigned|escalated|resolved|closed|reopened|feedback_received`); enabler consumers: EN-009 (acknowledgement/status messages), EN-012 (status page), EN-034 (kiosk confirmation), NC-028 (IT cross-tickets), NC-015 (indicator feed).

## 8. Screens

No separate screens. Enabler entry points: website complaint form + status page (EN-012), kiosk "Feedback/Complaint" tile (EN-034), WhatsApp keyword flow (EN-009), QR poster landing page (phone), staff quick-report dialog (all screens, `Ctrl+Shift+C`). Management console, escalation board, analytics live in NC-032.

## 9. Integrations

EN-012 public form/status page (API key + OTP), EN-034 kiosk tile, EN-009 WhatsApp inbox action & acknowledgement templates (`complaint_ack`, `complaint_resolved`), EN-013 signed QR tokens for location posters, NC-028 helpdesk cross-tickets, NC-015 indicator/CAPA feed, EN-038 SLA timers, EN-030 satisfaction survey.

## 10. Reports & Analytics

Owned by NC-032 (volume trend, category distribution, avg resolution time, repeat complaints, department TAT). Enabler-only addition: complaints by intake channel and QR location heatmap (widget in EN-001).

## 11. Notifications

Acknowledgement and status updates on the channel of origin (WhatsApp/SMS/email/portal); escalation alerts per NC-032; grievance officer daily digest.

## 12. Permissions

NC-032 keys (`complaint.ticket.create/read/assign/resolve/escalate/close`, `complaint.report.read`); public scopes `web.complaints.create` / `web.complaints.status` via EN-026 keys; kiosk device token scope `complaint.ticket.create`.

## 13. Non-functional

Public form/QR endpoints respond < 500 ms, work on 3G phones, support 8 languages and WCAG AA; complaint QR tokens are signed (EN-013) and non-PHI; attachments ≤ 10 MB, virus-scanned; public endpoints rate-limited and CAPTCHA-protected after 3 submissions/hour/IP.

## 14. Acceptance Criteria (enabler channels only; core ACs in NC-032)

1. Given a website complaint form submitted with OTP-verified mobile, when saved, then an NC-032 ticket is created with `source_channel=website`, the complainant receives an acknowledgement with ticket no within 1 min, and the status page shows it.
2. Given a QR poster scanned in Ward 4B, when the complaint is submitted, then the ticket is auto-tagged with that location and routed to the ward's assignee map.
3. Given a WhatsApp inbound "COMPLAINT" keyword, when the agent uses "Create complaint" in the inbox, then the conversation id is stored in `intake_meta` and status updates go back on WhatsApp.
4. Given a staff quick-report categorised as "IT/System", when submitted, then an NC-028 helpdesk ticket is created and cross-referenced instead of a grievance ticket.
5. Given 6 public submissions from one mobile in a day, when the 6th arrives, then it is rate-limited with a message to call the grievance officer.

## 15. Enhancements / Later phases

Tracked in NC-032: AI sentiment analysis, NLP auto-categorisation (AI-001/AI-003), repeat complaint correlation, NABH indicator linkage (NC-015), public complaint portal (EN-012), complaint-to-improvement (CAPA) workflow.

## 16. Open Questions for the Hospital

1. Confirm a single grievance process for patients and staff (vs separate staff grievance under HR NC-010)?
2. Which public channels to enable at launch (website, kiosk, WhatsApp, QR posters) and anonymous complaints policy?
3. Grievance officer details for DPDP/CEA display and acknowledgement templates/languages.
