# OP-038 — Patient Education Portal (Condition guides, Pre/Post-op & procedure instructions, Video library, Multilingual content, Prescription-linked delivery, Comprehension tracking)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain          | OPD Clinical / Patient Engagement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Module ID       | OP-038                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Phase           | 10 (content engine usable from Phase 2 for Rx/discharge leaflets)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Complexity      | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Depends on      | **OP-025 §0.5/§0.6 (framework: consoles attach education to visit summaries)**, PE-003 (Health Education Library — OP-038 is the clinical-facing prescribing/delivery layer; PE-003 the public library/CMS; shared content store), OP-002 (education orders from consultation, Rx-linked leaflets), IP-002 (discharge instructions), IP-006/OP-010 (pre/post-op & procedure instructions by procedure code), OP-003 (medication leaflets per drug/class, inhaler/insulin technique), OP-013/OP-033/OP-040 (immunisation, child health, ANC classes), all specialty consoles OP-025–OP-037 (condition-specific packs), EN-039 (print templates), EN-009/EN-032 (WhatsApp/SMS/email delivery with DLT templates), PE-001/OP-020 (portal/app player), EN-018 (TV waiting-area content), EN-034 (kiosk), NC-004 (document approval workflow for content), EN-028 (consent for messaging), EN-030 (comprehension quiz/feedback), NC-027 (staff training content overlap), AI-001 (chatbot Q&A later), EN-024 (audit) |
| Feature flag    | `module.patient_education.enabled` (sub: `edu.video_streaming`, `edu.tv_channel`, `edu.quiz`, `edu.classes`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Primary roles   | Doctor (6/9), Nurse/educator (16/17: `patient_educator`), Pharmacist (30), Physio/dietician/therapists (39/40), Content editor (55/54 family: `content_editor`), Content approver (HOD 5 / Quality 54)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Secondary roles | Patient/family (59/60), Reception (24, class booking), Marketing (55, public content), IT (56), Privacy Officer (57)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Regulatory      | NABH PRE (Patient Rights & Education: information in understandable language, education on medications/diet/procedures documented), Consumer Protection/Clinical Establishments (informed consent support), Copyright (licensed content), TRAI-DLT (templated messages), DPDP (consent for communications; minimal PHI in messages), Accessibility (WCAG 2.2 AA; RPwD), Drugs & Magic Remedies (Objectionable Advertisements) Act (content claims)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 1. Purpose

OP-038 lets clinicians **prescribe education** the way they prescribe drugs: a curated, versioned, multilingual **content library** (condition guides, pre-/post-op and procedure instructions, medication & device technique guides, diet/lifestyle, ANC/child care, rehab exercises, discharge care) in text/PDF/image/video/audio, mapped to ICD-10/procedure/drug/service codes so the right material auto-suggests during consultation, discharge, procedure booking and dispensing; delivered to the patient's portal/app/WhatsApp/print/kiosk/TV, with **delivery, read/watch and comprehension tracking** documented back into the record (NABH education evidence). PE-003 hosts the public/CMS side; both share one content store.

## 2. Users & Jobs-to-be-done

- **Doctor/nurse/pharmacist/therapist** (desktop/tablet during visit): one-click attach suggested materials, personalise (language, notes), print/send, mark "education given & understood", schedule reinforcement.
- **Patient educator/counsellor**: run education sessions/classes (diabetes, ANC, pre-op, CKD, cardiac rehab), document attendance and teach-back, manage FAQs.
- **Content editor/approver**: author (WYSIWYG + media), translate, version, clinical review & approval workflow, retire, map codes, licence tracking.
- **Patient/family** (phone/portal/kiosk/TV): read/watch in own language, quiz/acknowledge, ask follow-up (chatbot later), find in "My education" timeline.
- **Quality**: NABH evidence reports (education documented %), content review due dates.

## 3. Core Workflows

### 3.1 Content authoring & governance

1. Editor creates **content item**: type (article/leaflet PDF/video/audio/infographic/checklist/interactive quiz/exercise set), title, summary, body (rich text with sections & images), media (S3 via OP-022 uploader; video transcoded to HLS in worker; captions/subtitles per language), reading level target (≤ grade 6), languages (en-IN + regional; translation workflow with reviewer per language), audience (patient/caregiver/child), tags & **code mappings** (ICD-10 codes/ranges, SNOMED, procedure codes, drug ids/classes, service codes, specialty console, care stage: pre-op/post-op/discharge/chronic), sources/references, licence (own/licensed with expiry), disclaimers → clinical review (department HOD) → approval (Quality) via NC-004/EN-038 workflow → published version n; scheduled review (annual) & retirement; change log; A/B variants optional.
2. Content packs (bundles): e.g. "Total knee replacement journey" (pre-op prep, admission checklist, post-op exercises weeks 1–6, warning signs), "Newly diagnosed T2DM starter pack".

### 3.2 Prescribing education in clinical flows

- In OP-002/discharge/procedure/dispensing screens: **suggested materials rail** based on diagnosis/procedure/drugs/console (ranked by mapping specificity & language availability) → clinician selects/edits (add personal note e.g. "start exercises from day 3", set reinforcement schedule) → **education order** (`clinical.education_orders`) → delivery channels: print (with visit summary; QR to video), portal/app push, WhatsApp/SMS link (tokenised, expiring), email, kiosk QR; documented in the visit summary/discharge (NABH) → `education.prescribed`.
- Auto rules (config): e.g. every antibiotic Rx → "complete the course" leaflet; every surgery booking → pre-op pack at booking & T−2 days reminder; discharge → medication schedule + red flags; new inhaler → technique video; ANC visit → trimester pack (OP-040); vaccination → AEFI advice (OP-013).

### 3.3 Delivery, consumption & teach-back

- Patient opens (portal/app/web link with OTP-less tokenised access for the specific item; PHI-free URL) → view/watch tracked (opened, % watched, completed) → optional **comprehension quiz** (`edu.quiz`, 3–5 questions; retry) or acknowledgement ("I understood"); caregiver access if consented → **teach-back** documented by nurse (understood/needs re-education) → reinforcement schedule (PE-002: day 3, day 7) → results visible to clinician (rail chip: "watched 80 %, quiz 4/5") → `education.consumed`.
- Offline/print-only patients: printed leaflet with pictorials; kiosk (EN-034) print by token; TV (EN-018) waiting-area playlist by department (`edu.tv_channel`).

### 3.4 Group classes (`edu.classes`)

- Class catalogue (diabetes education, ANC/Lamaze, pre-op joint class, CKD, cardiac rehab education, breastfeeding), sessions (venue/online OP-018), booking (OP-001/portal), attendance (QR), materials, feedback (EN-030), billing if chargeable (OP-005), certificates.

### 3.5 Exceptions

- Content retired while prescribed → patient sees successor version; licence expired → auto-unpublish & notify; patient without smartphone → print + IVR audio option (EN-033); language missing → fallback language + translation request task; message opt-out → in-app/print only.

## 4. Data Model (schema `engage` shared with PE-003)

- **edu_content_items**: id, hospital_id (null = global/vendor library), code, type enum(article/leaflet/video/audio/infographic/checklist/quiz/exercise_set/pack), title, summary, audience enum, reading_level, status enum(draft/review/approved/published/retired), current_version, licence jsonb (source, expiry), review_due_at, tags text[], created_by, approved_by/at; index (hospital_id, status), FTS on title/summary.
- **edu_content_versions**: id, item_id, version, language, body jsonb (blocks), media jsonb ([{kind, s3_key, hls_key?, duration_s, captions{lang: key}}]), pdf_key?, translation_of_version_id?, reviewer_id, published_at, checksum; unique (item_id, version, language).
- **edu_code_mappings**: item_id, code_system enum(icd10/snomed/procedure/drug/drug_class/service/console/care_stage/vaccine), code, specificity smallint; index (code_system, code).
- **edu_packs**: id, name, items jsonb ([{item_id, order, day_offset?}]), mappings.
- **education_orders** (schema clinical): id, hospital_id, branch_id, patient_id, encounter_id?, admission_id?, ordered_by, item_ids/pack_id, language, note, channels text[], reinforcement jsonb ([{day_offset, channel}]), status enum(ordered/delivered/partially_consumed/completed/declined/expired), documented_in_summary bool, at; index (hospital_id, patient_id, at desc).
- **education_deliveries**: id, order_id, item_id, channel enum(print/portal/app/whatsapp/sms/email/kiosk/tv), token (hashed), sent_at, delivered_at, opened_at, progress_pct, completed_at, device, expires_at; index (order_id), (token).
- **education_assessments**: id, order_id, item_id, type enum(quiz/ack/teach_back), score, max, passed bool, by (patient/nurse), notes, at.
- **edu_classes**: id, hospital_id, branch_id, name, description, capacity, mode enum(onsite/online), sessions jsonb ([{at, venue/link, educator_ids}]), fee?, materials uuid[]; **edu_class_bookings**: class_id, session_idx, patient_id, status, attended_at, feedback_id, certificate_key.
- **edu_tv_playlists**: branch_id, department_id, items uuid[], schedule jsonb.
- Enums: `edu_content_type`, `edu_status`, `edu_channel`, `assessment_type`.

## 5. Business Rules & Validations

- Only `published` versions can be prescribed; prescribing pins version but patients always see latest published in same lineage (with "updated" note) unless clinician pins strictly (config); retired → successor redirect.
- Approval workflow mandatory (author ≠ approver); clinical claims require reference; licence expiry auto-unpublish 7 days before with alert; annual review due → task.
- Reading-level check (Flesch-Kincaid ≤ grade 6 target; warn), image alt-text mandatory, video captions mandatory for publish (accessibility), file size/transcode limits (video ≤ 2 GB, HLS 360p/720p).
- Delivery links: tokenised, no PHI in URL, expiry (default 30 days), rate-limited, single-patient scope; WhatsApp/SMS via approved DLT templates only; opt-out honoured; caregiver delivery requires consent.
- Education order counts as NABH documentation when at least one delivery + acknowledgement/teach-back recorded; visit/discharge summary prints "Education provided: …" list.
- Auto-rules configurable per hospital; suggestions ranked (exact code > range > class > console); max 5 auto-attached items per encounter (config) to avoid overload.
- Quiz pass threshold config (default 60 %); failed twice → nurse re-education task.
- Content items immutable per version; consumption data retained as clinical documentation; analytics anonymised for content performance.

## 6. API Surface (`/api/v1/education`)

| Method         | Path                                                   | Purpose                                                   | Permission                 | Idem   | Pag                  |
| -------------- | ------------------------------------------------------ | --------------------------------------------------------- | -------------------------- | ------ | -------------------- |
| GET            | /content?q=&code=&lang=&type=                          | search/suggest                                            | edu.content.read           | –      | cursor               |
| POST/PUT/PATCH | /content, /content/{id}/versions, /content/{id}/submit | approve                                                   | publish                    | retire | authoring & workflow | edu.content.author / edu.content.approve / edu.content.publish | Y   | –   |
| POST           | /content/{id}/media (resumable)                        | media upload → transcode                                  | edu.content.author         | Y      | –                    |
| GET            | /suggest?encounter=                                    | ranked suggestions for encounter (codes/drugs/procedures) | edu.order.create           | –      | –                    |
| POST/GET       | /orders, /orders?patient=                              | education orders                                          | edu.order.create/read      | Y      | cursor               |
| POST           | /orders/{id}/deliver                                   | (re)send via channels                                     | edu.order.create           | Y      | –                    |
| GET            | /public/e/{token}                                      | patient content access (tokenised)                        | public                     | –      | –                    |
| POST           | /public/e/{token}/progress, /quiz                      | consumption tracking                                      | public                     | Y      | –                    |
| POST           | /orders/{id}/teach-back                                | nurse teach-back                                          | edu.order.assess           | Y      | –                    |
| GET/POST       | /classes, /classes/{id}/book, /attend                  | classes                                                   | edu.class.manage / patient | Y      | cursor               |
| GET/PUT        | /tv/playlists                                          | TV playlists                                              | edu.tv.manage              | Y      | –                    |
| GET            | /reports/nabh?period=, /reports/content-performance    | reports                                                   | edu.report.read            | –      | –                    |

## 7. Domain Events (outbox)

- `education.content.published|retired|licence_expiring|review_due`, `education.prescribed` {items, channels}, `education.delivered|opened|completed`, `education.quiz.passed|failed`, `education.teach_back.recorded`, `education.reinforcement.due` (PE-002), `education.class.booked|attended`.
- Consumes: `encounter.signed` (auto-rules), `rx.created`, `procedure.booked`, `admission.discharge_planned`, `vaccine.administered`, `anc.visit.recorded` (OP-040), `consent.updated`, `message.opt_out` (EN-009).

## 8. Screens (UI)

1. **Suggested education rail** (in OP-002/IP-002/OP-010/OP-003 screens; desktop/tablet): ranked cards with language badges, one-click add, note field, channel toggles, "given & understood" checkbox; `Ctrl+E` open.
2. **Patient education timeline** (portal/app; phone): items by date, progress, quiz, ask question (later), language switch, offline download.
3. **Content studio** (desktop; editor): WYSIWYG blocks, media manager, translation side-by-side, mapping picker (ICD/procedure/drug), readability meter, preview per device, workflow status, version diff.
4. **Educator console** (tablet): today's patients needing education (from orders/discharges), teach-back forms, class attendance QR.
5. **Class scheduler & booking** (desktop/portal).
6. **TV playlist manager** (EN-018) and **kiosk print** (EN-034).
7. **Quality dashboard**: education documented % by department, top content, quiz pass rates, review-due content.

- Empty states: "No content mapped for this code — request content" creates editor task.

## 9. Integrations

- PE-003 shared store/CMS & public website (EN-012), OP-022 uploads & worker transcoding (ffmpeg → HLS), EN-009/EN-032 messaging (DLT templates, WhatsApp media messages), EN-018 TV, EN-034 kiosk, OP-018 online classes, EN-033 IVR audio playback (later), licensed content vendors (import API/CSV; e.g. multilingual leaflet libraries), AI-001 chatbot Q&A over content (later), EN-011 (DocumentReference optional).

## 10. Reports & Analytics

- NABH: % encounters/discharges with education documented, teach-back rate, by department; content performance (opens, completion, quiz pass, ratings), language coverage gaps, auto-rule hit rates, class attendance & feedback, licence/review compliance, delivery failures/opt-outs. Read model `analytics.education_monthly`.

## 11. Notifications

- Patient: content links (WhatsApp/SMS/app push), reinforcement reminders, class reminders, quiz nudges. Staff: teach-back pending, quiz failed twice, content review due/licence expiring, translation requests, delivery failures.

## 12. Permissions (RBAC keys)

`edu.content.read|author|approve|publish|retire`, `edu.order.create|read|assess`, `edu.class.manage`, `edu.tv.manage`, `edu.report.read`, `edu.configure`, patient scope `edu.own`. Defaults: Clinicians — content.read, order.create/read; Nurse/educator — + order.assess, class.manage (attendance); Content editor — author; HOD — approve; Quality — publish/retire, report; IT — tv.manage; Patient — own.

## 13. Non-functional

- Volumes: 5 000 education orders/day, 20 000 deliveries/day, video streaming peak 500 concurrent (HLS via CDN/Cloudflare); suggestion query < 100 ms (mapping index cached); public token endpoints rate-limited & no PHI; offline: app caches downloaded items; print: leaflets A4/A5 with pictograms & QR; accessibility: captions, alt-text, large-font mode, audio versions; i18n: all UI languages + content languages.

## 14. Acceptance Criteria

1. Given a consultation signed with ICD-10 E11.9 and metformin Rx, then the suggestion rail ranks the T2DM starter pack and metformin leaflet in the patient's language on top; the doctor adds both in one click.
2. Given a procedure booking for total knee replacement, then the pre-op pack is auto-ordered at booking and a reminder is sent at T−2 days via WhatsApp (opt-in) with a tokenised link containing no PHI.
3. Given a patient opens the video link and watches 85 %, then the delivery shows progress 85 % and the clinician rail displays it; a quiz score 4/5 marks completed.
4. Given a quiz failed twice, then a nurse re-education task is created; teach-back recorded closes it and the discharge summary lists "Education provided".
5. Given a content item pending approval, then it cannot be prescribed; after HOD approval and Quality publish, it appears in suggestions.
6. Given a video without captions in a language, then publish in that language is blocked with an accessibility error.
7. Given a licensed item expiring in 7 days, then editors are alerted; on expiry it unpublishes and prescribed links redirect to a successor or a notice.
8. Given a patient opted out of WhatsApp, then delivery falls back to app/print and no message is sent (audit).
9. Given a caregiver without consent, then education links are not sent to the caregiver number.
10. Given the NABH report for a month, then it shows % of discharges with documented education per department, matching underlying orders/assessments.
11. Given a class with capacity 20, then the 21st booking goes to waitlist and attendance QR scan marks attendance and issues certificate if configured.
12. Given a content editor tries to approve their own item, then blocked (author ≠ approver).

## 15. Enhancements / Later phases

- Sheet row 79 (Condition guides, Pre/Post-op instructions, Video library) — core. Market: prescription-linked delivery, comprehension tracking, NABH evidence, classes, TV/kiosk channels.
- Later: AI-001 chatbot Q&A grounded on approved content, AI-generated first drafts with mandatory clinical review, personalised journeys (post-op day-by-day pushes with PROMs), gamification/loyalty points (PE-005), community forums (PE-004), sign-language videos, voice assistants.

## 16. Open Questions for the Hospital

1. Existing education material & languages; licensed libraries in use? Video hosting/CDN preference?
2. Approval workflow owners (HOD/Quality); annual review policy?
3. Which auto-rules to enable at go-live (antibiotics, surgeries, discharge, inhalers, ANC)?
4. Channels & DLT templates; caregiver delivery consent policy?
5. Group classes offered (chargeable?), TV/kiosk availability?
