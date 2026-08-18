# EN-012 — Website Integration (Booking Widget, Doctor & Department Pages, Report Download, Chatbot, Payment Links, SEO, Health Packages, Lead Capture)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-012 |
| Phase | 10 |
| Priority | P2 |
| Complexity | Medium |
| Depends on | OP-001 (doctor schedules, appointment slots, registration), PE-001/OP-020 (portal/app handoff), OP-004/OP-008 (report download), EN-010 (payment links/checkout), EN-009 (OTP/WhatsApp), AI-001 (chatbot), OP-014 (health packages), NC-026 (leads/CRM), EN-011 (ABDM scan & share QR/deep link), EN-026 (API gateway/keys), EN-030 (feedback), EN-007 (branding, settings), EN-024 (audit), OP-021 (referral form), OP-018 (telemedicine booking), NC-035 (camps) |
| Feature flag | `module.website.enabled` (sub: `website.booking`, `website.reports`, `website.chatbot`, `website.builder`, `website.payments`) |
| Primary roles | Marketing / CRM Executive (55), IT Admin (56), Call Centre (25 — web leads), Hospital Admin |
| Secondary roles | Patient/prospective patient (public), Doctors (profile content approval), Front office (web appointments), Referring doctors (referral form) |
| Regulatory | DPDP (cookie/consent banner, purpose-limited forms, privacy notice), IT Act (secure OTP), NMC advertising ethics (doctor profiles: no superlatives/testimonial rules), Clinical Establishments Act display of rates (optional public tariff pages), Consumer Protection (e-commerce rules for online payments/refunds), WCAG 2.2 AA (public site), GST on online payments (EN-010), TRAI DLT (OTP), Google/Meta platform policies for tracking (consent mode) |

## 1. Purpose
EN-012 exposes safe, embeddable public capabilities of the HMS to the hospital's website (any CMS: WordPress, Webflow, Next.js) and optionally a lightweight **hospital website builder**: online appointment booking widget with live slots, doctor and department directory pages generated from masters, lab/radiology report download with OTP, health package purchase, payment links/checkout, chatbot hand-off (AI-001), enquiry/lead forms feeding CRM, ABDM scan & share deep-links, and SEO structured data — all through EN-026 API keys with rate limits and no PHI leakage.

## 2. Users & Jobs-to-be-done
- **Prospective/registered patient** (phone/desktop web): find doctor, book/reschedule appointment with OTP, pay consult fee, download report by UHID/OTP, buy health package, chat, request callback, view services/tariffs.
- **Marketing** (desktop): manage doctor/department content overrides, packages listing, banners/campaign UTM tracking, leads, SEO fields; publish site (builder mode).
- **IT Admin**: issue widget API keys/domains, embed snippets, CSP/allowed origins, analytics; monitor errors.
- **Call centre/front office**: process web bookings/leads, confirm/cancel, callback queue.
- **Doctor**: approve own profile (photo, bio, qualifications, timings) via OP-019/EN-007 profile.

## 3. Core Workflows

### 3.1 Widget provisioning
1. IT creates **web integration key** (EN-026): allowed origins (CORS), scopes (`web.slots.read`, `web.appointments.create`, `web.reports.otp`, `web.packages.read`, `web.payments.create`, `web.leads.create`, `web.chat`), rate limits, branding theme → embed snippets (`<script src=".../widget.js" data-key>` for booking, doctor grid, package cards; iframe fallback) → `web_integrations`.
2. Domains verified (DNS TXT or meta tag); CSP/CORS enforced; keys rotatable; usage analytics.

### 3.2 Doctor & department directory
- Public read model `web_doctor_profiles` built from OP-001/EN-007 (name, photo, designation, department, specialties, qualifications, languages, registration no (NMC-compliant), OPD timings per branch, tele-consult availability, fee (optional display), profile slug) with **marketing overrides** (bio, SEO title/description, tags) approved by doctor/admin; department pages (services, facilities, HOD, contact); JSON API + SSR pages (builder) with `schema.org/Physician`, `MedicalOrganization`, `Hospital` JSON-LD; sitemap; personal micro-site per doctor (market: "personal website per doctor") using slug subpaths.

### 3.3 Online appointment booking
1. Visitor selects department/doctor/branch (or symptom → specialty suggestion via AI-001 later) → **live slots** (OP-001 slot engine: availability minus booked/held; web quota per session e.g. 30 % of slots; lead time rules) → picks slot → enters mobile → **OTP** (EN-009) → existing patient match (mobile → list of masked family profiles → pick) or new pre-registration (name, gender, DOB/age, email; DPDP notice + consent) → optional **pay consult fee** (EN-010 checkout; policy: mandatory/optional/pay-at-hospital) → **slot hold** (5 min TTL) → confirm → appointment created (`source=website`, UTM captured) → confirmation page + WhatsApp/SMS with QR (check-in at kiosk/reception → token EN-006) + calendar (.ics) → Event `web.appointment.created`.
2. Manage: reschedule/cancel via link (OTP), refund policy per EN-010/OP-005; no-show rules; tele-consult booking routes to OP-018 with join link.
3. Waitlist when no slots (notify on opening) — enhancement; ABDM scan & share deep-link/QR on booking page (EN-011).

### 3.4 Report download (`website.reports`)
- Enter UHID/registered mobile + report/bill no (or from SMS link) → OTP → list of released reports (lab final, radiology signed, discharge summaries per policy) → download PDF (watermarked "downloaded via web on <date>", presigned URL 10 min) → audit (`READ_PHI` self-access) → Event `web.report.downloaded`; abuse protection (rate limits, CAPTCHA/turnstile after 3 attempts); QR on printed report links to verification page (report authenticity: hash + issue date, no content) (market: QR report verification).

### 3.5 Health packages & payments
- Package catalogue (OP-014/OP-023) public cards (inclusions, price, prep instructions, branches) → book slot + pay online (EN-010) → order created; corporate codes; payment links generated by staff (billing/insurance) land on hosted pay page (EN-010) with hospital branding; tariff enquiry page (optional public rates per CEA).

### 3.6 Leads, forms & chatbot
- Enquiry/callback/second-opinion/international patient/referral doctor forms → `web_leads` → NC-026 CRM with source/UTM, auto-assign, SLA; spam protection; DPDP consent checkbox with purpose text; **chatbot** widget (AI-001) with FAQ, booking, report status hand-off; live chat hand-off to call centre (EN-033) hours; WhatsApp click-to-chat button (EN-009 template start).

### 3.7 SEO, analytics & consent
- Structured data, meta, canonical, hreflang for languages, sitemap.xml, robots; performance budgets (LCP < 2.5 s); consent-mode analytics (GA4/Meta pixel only after consent), server-side event relay for conversions (booking, package purchase) without PHI; UTM → appointment attribution reports.

### 3.8 Website builder (`website.builder`, optional)
- Next.js multi-tenant public site (`www.<hospital>.com` custom domain via Cloudflare) with themeable sections (hero, departments, doctors, packages, testimonials (policy-checked), news, careers link, contact/maps, emergency numbers banner), page editor with drafts/publish/versioning, multilingual, media library; falls back to widgets for hospitals with existing sites.

### 3.9 Exceptions
- Slot taken during hold → offer nearest alternatives; payment success but appointment creation failed → auto-retry, else refund + alert; OTP delivery failure → email fallback; API key abuse → key auto-suspend + IT alert.

## 4. Data Model (schema `engage`, prefix `web_`)
- `web_integrations` — id, hospital_id, name, api_key_id (EN-026), allowed_origins[], scopes[], theme jsonb, rate_limits jsonb, status, verified_domains[].
- `web_doctor_profiles` — id, hospital_id, user_id (doctor), slug UNIQUE(hospital_id, slug), display jsonb (name, photo_id, designation, qualifications, specialties[], languages[], reg_no), branches jsonb (timings, fee_display), telemed bool, bio_html (sanitised), seo jsonb, status (draft/approved/published), approved_by/at, version.
- `web_department_pages` — hospital_id, department_id, slug, content jsonb, seo, status.
- `web_slot_policies` — hospital_id, doctor_id?/department_id?, web_quota_pct, min_lead_min, max_days_ahead, payment_mode (mandatory/optional/none), cancel_window_h, refund_policy_ref.
- `web_bookings` — id, hospital_id, appointment_id (OP-001), patient_id?, prereg jsonb (masked), mobile_e164, otp_verified_at, hold_expires_at, payment_intent_id (EN-010), source (widget/builder/chatbot), utm jsonb, ip_hash, ua, status (held/confirmed/cancelled/rescheduled/failed), created_at.
- `web_report_access` — id, hospital_id, patient_id, document_ref, channel, otp_verified_at, downloaded_at, ip_hash, ua; `web_report_verifications` (report_hash, verified_at, ip_hash).
- `web_leads` — id, hospital_id, type (enquiry/callback/second_opinion/international/referral/package/career?), payload jsonb, consent_id, source_page, utm, status, crm_lead_id (NC-026), created_at.
- `web_pages` (builder) — hospital_id, slug, locale, sections jsonb, seo, status, version, published_at; `web_media` (file refs), `web_domains` (custom domain, ssl status).
- `web_analytics_events` — hospital_id, event (page_view/slot_view/booking_started/booking_confirmed/package_purchase/report_download/lead), props jsonb (no PHI), utm, at; partitioned monthly.

## 5. Business Rules & Validations
- Public APIs return no PHI without OTP; doctor pages show only approved fields; NMC ethics: no "best/No.1" claims, no patient testimonials with identifiable info unless consented & policy allows.
- Slot hold 5 min; web quota per policy; booking requires OTP-verified mobile; new patient pre-registration creates temporary record merged/verified at first visit (OP-001 dedupe by mobile+name+DOB).
- Payment mandatory policies enforce checkout before confirmation; refunds per policy on cancel within window; failed post-payment creation auto-refunds within 24 h if unrecoverable.
- Report download only for finalised documents; MLC/psychiatry/restricted categories excluded per policy; watermark + short-lived URLs; max 10 downloads/day/UHID; CAPTCHA after 3 failed OTPs.
- Rate limits per key/IP; CORS strict; CSP nonce for widgets; sanitised HTML in bios; image size limits.
- Consent: DPDP notice on all forms; analytics tags fire only after consent; leads retention 24 months unless converted.
- i18n: pages/widgets in hospital languages; RTL support; accessibility AA.

## 6. API Surface (`/api/v1/web` public via EN-026 keys; admin under `/api/v1/web/admin`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET | /public/doctors?dept&branch&q ; /public/doctors/:slug ; /public/departments ; /public/packages | directory | api key `web.*.read` | cached 5 min, no PHI |
| GET | /public/slots?doctorId&branch&date | live slots | `web.slots.read` | rate-limited |
| POST | /public/otp/request ; /public/otp/verify | OTP | `web.appointments.create` | 3/10 min |
| POST | /public/bookings/hold ; POST /public/bookings/confirm ; POST /public/bookings/:id/reschedule|cancel (OTP) ; GET /public/bookings/:id (token) | booking | `web.appointments.create` | Idempotency-Key |
| POST | /public/reports/otp ; POST /public/reports/list ; GET /public/reports/:docId/download (signed) ; GET /public/reports/verify/:hash | reports | `web.reports.otp` | audited |
| POST | /public/packages/:id/book | package booking + payment | `web.payments.create` | EN-010 |
| POST | /public/leads | forms | `web.leads.create` | spam-protected |
| POST | /public/chat/session ; WS /public/chat | chatbot | `web.chat` | AI-001 |
| POST | /public/events | analytics beacon | key | no PHI |
| GET/POST/PATCH | /admin/integrations ; /admin/doctor-profiles ; POST /:id/approve|publish ; /admin/department-pages ; /admin/slot-policies ; /admin/pages ; /admin/domains ; /admin/leads | admin | web.content.manage / web.content.approve / web.integration.configure / web.lead.read | |
| GET | /admin/reports/bookings ; /conversion ; /leads ; /downloads | analytics | web.report.read | MV |

## 7. Domain Events (outbox)
- `web.appointment.created|rescheduled|cancelled|payment_failed` → OP-001, EN-009 confirmations, NC-026 attribution.
- `web.report.downloaded|verification_checked` → EN-024 (self READ_PHI).
- `web.package.purchased` → OP-014/OP-023, EN-010.
- `web.lead.created|assigned` → NC-026, call centre.
- `web.profile.published|unpublished` → cache purge, sitemap regen.
- `web.key.suspended` → IT.

## 8. Screens
- **Booking widget** (embedded; phone-first): steps Doctor/Dept → Date/Slot → Mobile OTP → Patient select/pre-reg → Pay (optional) → Confirmation; accessible, keyboard navigable, i18n; error/alt-slot states; countdown for hold.
- **Doctor directory & profile pages** (public web): filters, cards, timings, "Book" CTA, JSON-LD.
- **Report download page** (public, phone): UHID/mobile + OTP → list → download; verify-report page (QR).
- **Package pages & checkout** (public): cards, inclusions, prep, buy → EN-010 hosted checkout.
- **Chat widget** (public): AI-001 with hand-off.
- **Web Admin** (desktop): integrations/keys/domains, doctor profile editor with approval workflow & preview, department pages, slot policies, leads inbox (assign/status), analytics (bookings funnel, UTM attribution, downloads), builder page editor (drafts/publish, sections, media, multilingual) if enabled.
- **Call centre web-bookings queue** (desktop): today's web appointments, unpaid, callbacks.

## 9. Integrations
- CMS embeds (script/iframe), Next.js builder with ISR, Cloudflare (custom domains, WAF, Turnstile CAPTCHA), GA4/Meta pixel via consent mode + server-side relay, Google Business Profile booking link, WhatsApp click-to-chat, EN-010 checkout, EN-009 OTP/notifications, AI-001 chatbot, NC-026 CRM, EN-011 ABDM QR/deep link, EN-026 keys/rate limits, EN-030 feedback widget, .ics/Google Calendar links.

## 10. Reports & Analytics
- Web bookings by doctor/dept/day, conversion funnel (slot view → hold → confirm → paid → arrived), no-show rate for web bookings, report downloads & failures, leads by source/UTM & conversion, package sales online, chatbot deflection, key usage/errors, page performance (Core Web Vitals). MV `analytics.mv_web_daily`.

## 11. Notifications
- Patient: OTP, booking confirmation/reschedule/cancel with QR & directions, payment receipt (EN-010), report ready link (from OP-004 policy), lead acknowledgement.
- Staff: new web lead (call centre), unpaid web booking reminders, doctor profile awaiting approval, key abuse/suspension (IT).

## 12. Permissions (RBAC keys)
`web.integration.configure` (IT Admin) · `web.content.manage` (Marketing) · `web.content.approve` (Hospital Admin; doctor for own profile `web.profile.self`) · `web.lead.read/update` (Call centre, Marketing) · `web.report.read` (Marketing, Admin) · public scopes via API keys (`web.slots.read`, `web.appointments.create`, `web.reports.otp`, `web.packages.read`, `web.payments.create`, `web.leads.create`, `web.chat`).

## 13. Non-functional
- Public endpoints cached (CDN 60–300 s for directory), slots p95 < 300 ms, booking confirm < 1 s; 50k page views/day, 1000 web bookings/day; widget bundle < 80 kB gzip; Core Web Vitals green on 3G.
- Security: API keys per origin, rate limits, Turnstile, no PHI in public payloads/logs, signed download URLs, OTP throttles, CSP; DPDP consent records; pen-test before launch.
- Accessibility WCAG 2.2 AA; i18n/RTL; SEO best practices.

## 14. Acceptance Criteria
1. Given the booking widget on the hospital site, when a visitor selects a doctor and date, then only web-quota slots not booked/held are shown and refresh in real time.
2. Given a slot held, when 5 min pass without confirmation, then the hold releases and the slot is bookable again.
3. Given OTP verified for a mobile with two family profiles, when listed, then names are masked (e.g. "R***a S.") until the visitor selects and confirms DOB/year.
4. Given payment mandatory policy, when checkout succeeds, then the appointment is confirmed exactly once (idempotent) and confirmation SMS/WhatsApp with QR is sent; on creation failure the payment auto-refunds within 24 h.
5. Given a report download request, when OTP is verified, then only finalised, non-restricted reports are listed and the PDF is watermarked and served via a 10-min signed URL with an audit entry.
6. Given 3 failed OTP attempts, when a 4th is tried, then a CAPTCHA is required and the attempt is rate-limited.
7. Given a doctor profile edited by marketing, when saved, then it stays draft until the doctor/admin approves; published pages update within 5 min and JSON-LD validates.
8. Given a lead form submitted with UTM parameters, when saved, then NC-026 receives the lead with source attribution and DPDP consent id.
9. Given an API key used from a non-allowed origin, when called, then CORS blocks and the request is logged; sustained abuse suspends the key with IT alert.
10. Given the report QR verify page, when a hash is checked, then it returns issue date and validity only (no content).
11. Given analytics consent not granted, when the booking page loads, then no third-party tags fire; the server-side conversion relay still records PHI-free events.
12. Given the builder enabled with a custom domain, when published, then the site is served with valid TLS, sitemap and hreflang, and edits are versioned/rollbackable.

## 15. Enhancements / Later phases
- Symptom-based doctor suggestion (AI-001), waitlist & auto-fill of cancellations, Google Reserve/Business Profile booking integration, multilingual voice bot (EN-033), international patient portal (visa letters, estimates RC-008), doctor personal micro-sites & video intros (market), online second opinion (OP-036), reviews management (Google routing EN-030), careers portal (NC-010), health blog with CMS, PWA install prompt for OP-020, ABDM UHI listing.

## 16. Open Questions for the Hospital
1. Existing website platform/agency? Embed widgets vs full builder? Custom domain & DNS control?
2. Online booking policy: web slot quota, prepayment mandatory, cancellation/refund window, lead time?
3. Doctor profile content owners; fee display on website allowed? NMC ethics review process?
4. Which reports may be downloaded online (lab/rad/discharge) and any exclusions; watermark text?
5. Health packages to sell online, pricing/discount codes, corporate portal needs?
6. Chatbot languages/scope; call-centre hours for live hand-off?
7. Analytics tools (GA4/Meta) and consent banner vendor; SEO priorities/local languages?
