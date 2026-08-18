# PE-003 — Health Education Library (Content Model & CMS, Multilingual, Video/PDF/Infographic, Condition & Procedure Mapping, Auto-Share on Diagnosis/Discharge, Read Receipts, Doctor-Authored Articles, Website Sync)

| Field | Value |
|---|---|
| Domain | Patient Engagement |
| Module ID | PE-003 |
| Phase | 10 (content store usable from Phase 2 so OP-038 can attach leaflets to prescriptions and discharges) |
| Priority | P2 |
| Complexity | Medium |
| Depends on | **OP-038 (Patient Education Portal — the clinical-facing *prescribing & delivery* layer; PE-003 is the *library, CMS and public surface*; both share one content store, one version history and one translation workflow — PE-003 owns `edu_content`, OP-038 owns `clinical.education_orders`)**, PE-001/OP-020 (patient portal & app player, "My education" timeline), EN-012 (website sync — the same articles power the public site and SEO), EN-018 (waiting-area TV playlists), EN-034 (kiosk print/QR), EN-009/EN-032 (WhatsApp/SMS/email delivery of tokenised links), NC-004 (document approval workflow & version control), EN-038 (approval matrix for clinical content), EN-039 (print templates for leaflets), EN-027 (ICD-10/SNOMED/procedure/drug code masters for mapping), OP-002/IP-002/OP-003/OP-010 (attachment points: consultation, discharge, dispensing, procedure), PE-002 (education reinforcement in follow-up cadences), PE-004 (community links to library articles), PE-005 (wellness content), OP-013/OP-040/OP-033 (immunisation, ANC, paediatric packs), NC-015 (NABH patient-education evidence), NC-027 (staff training content shares the media pipeline), EN-030 (comprehension quiz results), EN-028 (communication consent), EN-024 (audit) |
| Feature flag | `module.health_education.enabled` (sub: `edu.video_streaming`, `edu.translations_workflow`, `edu.website_sync`, `edu.read_receipts`, `edu.doctor_articles`) |
| Primary roles | Content Editor (custom role, Marketing 55 / Quality 54 family), Patient Educator / Counsellor (nursing 16/17 family), Doctor as author (6/9 — `edu.doctor_articles`) |
| Secondary roles | HOD (5) & Medical Superintendent (4) — clinical review and approval; Quality Manager (54) — NABH evidence; Marketing (55) — website and campaigns; Pharmacist (30), Dietician (39), Physiotherapist (40) — domain content; Patient/Family (59/60); IT (56); Auditor (58) |
| Regulatory | **NABH 6th edition PRE (Patient Rights & Education)** — patients and families are educated about their condition, medication, diet, procedure and follow-up **in a language and manner they understand**, and the education is documented; **Drugs and Magic Remedies (Objectionable Advertisements) Act 1954** — no claims of cure for the listed conditions, and no content that reads as an advertisement for a treatment; **Consumer Protection Act 2019 / ASCI code** — no misleading health claims; **NMC Code of Ethics** — doctor-authored content must be informational, not self-promotional or solicitation; **PC-PNDT** — no content that could be construed as sex-determination related; **Copyright Act** — licensed images/videos tracked with expiry; **DPDP Act 2023 & Rules 2025** — read receipts tie content to a patient (health inference), so consent and purpose limitation apply, and no behavioural tracking of children; **TRAI TCCCPR** — education pushes on service templates only, never promotional; **RPwD Act / WCAG 2.2 AA** — captions, transcripts, screen-reader compatibility; **IT Rules 2021** (intermediary/publisher obligations for the public website portion) |

## 1. Purpose
PE-003 is the hospital's single, governed store of patient-facing health information: condition guides, procedure and pre/post-operative instructions, medication and device technique material, diet and lifestyle, maternal and child health, rehabilitation exercises — authored or curated once, translated properly, clinically reviewed and versioned, mapped to ICD-10/procedure/drug/service codes so the right material can be surfaced automatically at diagnosis, discharge, dispensing and booking, delivered to the portal, WhatsApp, print, kiosk and waiting-room TV, tracked for reading/watching and comprehension, and published to the public website as the hospital's credible health-content presence.

## 2. Users & Jobs-to-be-done
- **Content editor**: author or curate a piece, add media, request translations, run it through clinical review, publish, schedule the annual review, retire it when superseded — with no ability to publish clinical content unreviewed.
- **Clinical reviewer (HOD/MS)**: check accuracy, reading level and claim compliance; approve or send back with comments; approve translations.
- **Doctor author** (`edu.doctor_articles`): write a short article in their specialty, submit for review, see how many patients read it — a low-effort, high-value engagement channel that also feeds the website.
- **Patient educator / counsellor**: build packs for classes and programmes, check who has actually read what before a teach-back session.
- **Patient/family**: find material in their own language, at a readable level, on their phone, without an account (public) or inside their record ("My education").
- **Marketing**: publish the same governed content to the website with SEO metadata — one source of truth, no rogue health claims.
- **Quality**: evidence that education was provided and understood (NABH PRE).

## 3. Core Workflows

### 3.1 Content model & authoring
1. A **content item** has: type enum(article/leaflet_pdf/video/audio/infographic/checklist/exercise_set/quiz/faq), title, subtitle, summary (≤ 240 chars), body (structured sections: what it is, why it happens, what to expect, what to do, warning signs, when to call us, FAQs), media assets, target audience enum(patient/caregiver/child/adolescent/elderly), **reading level target** (plain language, aim ≤ grade 6–8 equivalent; the editor sees a readability indicator), estimated read/watch time, tags, and a **licence** record (own/licensed/CC with attribution and expiry).
2. **Code mappings** (the mechanism that makes content findable automatically): ICD-10 codes and ranges, SNOMED CT concepts, procedure codes, drug ids/classes (OP-003), service and package codes, specialty console (OP-025–OP-037), and **care stage** enum(pre_diagnosis/newly_diagnosed/pre_op/post_op/discharge/chronic_management/end_of_life/prevention). Mapping specificity drives ranking when OP-038 suggests material.
3. **Media pipeline**: images optimised and served responsively; **video** uploaded to S3, transcoded to HLS ladders in the worker (`edu.video_streaming`), with mandatory captions per language and an auto-generated transcript that the editor corrects; audio for low-literacy and visually impaired users; PDFs generated from the same body via EN-039 templates so print and screen never diverge.

### 3.2 Translation workflow (`edu.translations_workflow`)
- Every item has a source language (usually en-IN) and target languages per the hospital's population (hi, ta, te, ml, kn, mr, bn, ur, or as deployed). A translation is a **child version** with its own reviewer (a clinician or educator fluent in that language), its own approval, and its own captions/transcript for video. Machine translation may pre-fill (AI later) but **a human clinical reviewer must approve before publication** — a mistranslated dose instruction is a safety event. Missing-translation gaps are visible on a coverage matrix (content × language) so the hospital can see, honestly, that 40 % of its patients are being served material they cannot read.

### 3.3 Review, approval and lifecycle
- Draft → clinical review (department HOD or a nominated reviewer) → compliance check (claims, copyright, Drugs & Magic Remedies screen — a checklist the reviewer ticks) → approval (Quality/MS per the EN-038 matrix; NC-004 provides the document workflow) → **published version n** with an effective date. Every published version is immutable; edits create version n+1 with a change note and a diff. Scheduled **annual review** with owner reminders; expiry of a licence auto-unpublishes with notification; **retirement** leaves a tombstone that redirects patients to the successor version (a patient who bookmarked a leaflet must not hit a dead end).

### 3.4 Auto-share on diagnosis, discharge and dispensing
- PE-003 exposes a **suggestion API** consumed by OP-038 and the clinical modules: given diagnosis codes, procedure codes, drugs, service, care stage and the patient's language, return ranked content. Configurable **auto-share rules** then deliver without a click where the hospital wants it: on `diagnosis.recorded` for a defined code set (e.g. new T2DM → starter pack), on `ip.discharge.completed` (discharge care pack for the procedure), on `rx.dispensed` for defined drug classes (inhaler technique video, anticoagulant safety leaflet), on `ot.booking.created` (pre-op preparation pack plus a T−2 day reminder), on `immunisation.given` (AEFI advice), on `anc.visit.completed` (trimester pack).
- Delivery channels: portal/app card and "My education" timeline, WhatsApp/SMS tokenised link (service template, no diagnosis in the body), email, printed leaflet with the visit summary carrying a **QR to the video**, kiosk print, and waiting-area TV playlist by department (EN-018). Every dispatch respects consent and language preference; the clinician's personal note ("start these exercises from day 3") rides along.

### 3.5 Consumption, read receipts and comprehension (`edu.read_receipts`)
- Opening a tokenised link (no login needed, PHI-free URL) or the portal card records: opened, scroll depth or % watched, completed, device, language used. An optional 3–5 question **comprehension quiz** or a simple "I understood" acknowledgement follows; results and the **teach-back** documented by a nurse (understood / needs re-education) return to the clinical record as NABH evidence and show as a chip on the clinician's rail ("watched 80 %, quiz 4/5"). Reinforcement is scheduled through PE-002 (day 3, day 7).
- Aggregate consumption (which content is opened, abandoned, or never read) drives content improvement — an item with an 8 % completion rate is a writing problem, not a patient problem.

### 3.6 Doctor-authored articles (`edu.doctor_articles`)
- A doctor writes in a simple editor (or dictates, transcribed later by AI-004), tags the specialty and codes, submits → the same review chain (a peer or HOD, plus the compliance checklist for NMC solicitation and Drugs & Magic Remedies) → published with the doctor's byline and profile link. Authors see read counts, average completion and patient questions raised on the article (routed to PE-004 Q&A or to the desk). Articles sync to the website's doctor profile (EN-012), which is both patient education and legitimate professional presence.

### 3.7 Website sync & public library (`edu.website_sync`)
- Published items flagged `public` are exposed to EN-012 with SEO metadata (slug, meta description, structured data), canonical URLs, hreflang for each language, and an "information reviewed by Dr X, reviewed on <date>" trust block. Unpublishing or retiring an item updates the website within the sync interval and leaves a redirect. Public content carries a disclaimer and never includes patient data.

### 3.8 Packs, classes and campaigns
- **Content packs** bundle a journey (e.g. "Total knee replacement: pre-op prep → admission checklist → post-op exercises weeks 1–6 → warning signs"; "Newly diagnosed T2DM starter pack"; "First trimester pack"). Packs can be scheduled as a drip over days via PE-002. Group **classes** (diabetes education, ANC, pre-op joint class, cardiac rehab) are run in OP-038; PE-003 supplies the materials, attendance handouts and certificates.

### 3.9 Exceptions
- Content retired while patients hold links → successor served with a notice.
- Licence expired → auto-unpublish, editor notified, public URL returns a "temporarily unavailable" page, not a 404 storm.
- Language unavailable → fallback language served with a visible note and an automatic translation request task.
- Patient opted out of messaging → material still available in the portal and printed at the desk.
- Low-bandwidth or feature phone → text/SMS summary and printed leaflet; audio version via IVR (EN-033) for low-literacy patients.

## 4. Data Model (schema `engage`, prefix `edu_`)
- **edu_content** — id, hospital_id (null = group/global library), code, type enum(article/leaflet_pdf/video/audio/infographic/checklist/exercise_set/quiz/faq), source_language, title, subtitle, summary, body jsonb (sections), audience enum, reading_level_score numeric(4,1)?, estimated_minutes, specialty_id?, department_id?, is_public bool, seo jsonb (slug, meta_description, structured_data), licence jsonb (type, source, attribution, expiry_date), author_type enum(editor/doctor/licensed), author_user_id?, status enum(draft/in_review/approved/published/retired/unpublished_licence), current_version int, owner_user_id, next_review_due date, retired_at, successor_content_id?, audit cols. UNIQUE(hospital_id, code). GIN trigram on title/summary for search.
- **edu_content_versions** — content_id, version, body jsonb, media_manifest jsonb, change_note, reviewed_by, review_comments, compliance_checklist jsonb (claims/copyright/DMRA/NMC ticks), approved_by, approved_at, published_at, effective_from, sha256, superseded_by. Published versions immutable.
- **edu_translations** — id, content_id, language, version, title, body jsonb, caption_file_id?, transcript, translator_user_id, reviewer_user_id, status enum(requested/in_progress/in_review/approved/published), approved_at, published_at, machine_assisted bool.
- **edu_media** — id, content_id, kind enum(image/video/audio/pdf), file_id, hls_manifest_ref?, duration_s?, size_bytes, language?, caption_file_id?, alt_text, licence_ref, transcode_status.
- **edu_mappings** — content_id, map_type enum(icd10/snomed/procedure/drug/drug_class/service/package/specialty/care_stage/pathway), code_or_id, specificity smallint (drives ranking), added_by. Index (map_type, code_or_id).
- **edu_auto_share_rules** — id, hospital_id, trigger enum(diagnosis_recorded/discharge_completed/rx_dispensed/ot_booked/immunisation_given/anc_visit/package_booked), criteria jsonb, content_ids uuid[] or pack_id, channels text[], delay_hours, language_policy enum(patient_preferred/fallback_en), requires_clinician_confirm bool, active, approved_by.
- **edu_packs** — id, hospital_id, name, description, items jsonb [{content_id, sequence, drip_offset_days}], mapped_procedures text[], mapped_conditions text[], status, version.
- **edu_deliveries** — id, hospital_id, patient_id, encounter_id?, content_id, version, language, channel enum(portal/app/whatsapp/sms/email/print/kiosk/tv), delivered_at, delivered_by enum(clinician/auto_rule/patient_self), education_order_id? (OP-038), token_hash?, token_expires_at, message_id?, consent_ref. Partitioned monthly. Index (patient_id, delivered_at desc).
- **edu_consumption** — delivery_id, content_id, patient_id, opened_at, completion_pct, completed_at, device_type, quiz_id?, quiz_score?, quiz_attempts, acknowledged bool, teach_back_status enum(understood/needs_reeducation/not_assessed)?, teach_back_by, teach_back_at. (PHI — read-audited.)
- **edu_quizzes** — content_id, version, questions jsonb [{text, options, correct_index, explanation}], pass_mark, language.
- **edu_feedback** — content_id, patient_id?, helpful bool, comment, at, moderated_by (light-touch: "was this helpful?" is the cheapest content-improvement signal).
- **edu_website_sync_log** — content_id, version, action enum(publish/update/unpublish/redirect), synced_at, target_url, status, error.
- Read models: `analytics.mv_edu_consumption` (content × opens × completion × language), `mv_edu_coverage` (condition × language coverage %), `mv_edu_nabh_evidence` (encounters with documented education %).
- RLS on `hospital_id` (global library rows readable by all tenants, editable only by the platform owner). Consumption rows are PHI. Retention: content indefinitely with versions; consumption 8 years with the clinical record; anonymous public-site analytics 13 months.

## 5. Business Rules & Validations
- **No clinical content is published without clinical review and approval.** Editors may draft; publication requires the reviewer + approver chain and a completed compliance checklist (claims, copyright, Drugs & Magic Remedies, NMC solicitation for doctor articles).
- A **translation is published only after review by a reviewer competent in that language**; machine translation alone can never reach `published`.
- Published versions are immutable; a change is a new version with a change note; patients holding an old link see the current published version with a "this was updated on <date>" note.
- Licence expiry auto-unpublishes and notifies; content with expired licence cannot be delivered or synced to the website.
- Auto-share rules may only reference **published** content in a language the patient can read (or an explicitly approved fallback), require consent for messaging channels, and carry no diagnosis in the message body.
- Tokenised links are opaque, expiring (default 90 days for education, longer than clinical artefacts because reference value persists), view-capped, and contain no PHI; opening one records consumption but never reveals other records.
- Reading level: publication warns (does not block) if the readability score exceeds the target; the reviewer must acknowledge.
- Accessibility gates: a video cannot be published without captions in its language; an image cannot be published without alt text; a PDF must be tagged/selectable text, not a scan.
- Children's content: no behavioural tracking, no personalisation, no marketing tie-in (DPDP).
- Doctor-authored articles carry a byline and a review date and are screened for solicitation; they may not name proprietary drug brands promotionally or contain fee/offer information.
- Public content excludes any patient-identifiable material and carries the standard disclaimer and "reviewed by / reviewed on" block.
- Retirement always defines a successor or an explicit "no successor" decision — silent dead links are not permitted.

## 6. API Surface (`/api/v1/education`)
| Method | Path | Purpose | Permission | Idem | Pag |
|---|---|---|---|---|---|
| GET | /content?q=&type=&specialty=&language=&status= | library search | edu.content.list | – | cursor |
| POST | /content ; GET/PATCH /content/{id} | author/edit draft | edu.content.create/update | Y | – |
| POST | /content/{id}/versions ; POST /versions/{v}/submit | new version / submit for review | edu.content.update | Y | – |
| POST | /versions/{v}/review ; /versions/{v}/approve ; /versions/{v}/publish | review chain | edu.content.review / .approve / .publish | Y | – |
| POST | /content/{id}/retire | retire with successor | edu.content.publish | Y | – |
| POST | /content/{id}/media | upload image/video/audio/pdf (presigned) | edu.media.upload | Y | – |
| GET/POST | /content/{id}/translations ; POST /translations/{id}/approve | translation workflow | edu.translation.manage / .approve | Y | cursor |
| GET/PUT | /content/{id}/mappings | ICD/procedure/drug/service mapping | edu.mapping.manage | Y | – |
| **GET** | **/suggest?icd=&procedure=&drug=&careStage=&language=&limit=** | ranked suggestions (consumed by OP-038/clinical screens) | edu.content.suggest | – | – |
| GET/POST/PATCH | /auto-share-rules | auto-delivery rules | edu.rule.configure | Y | cursor |
| GET/POST | /packs ; PATCH /packs/{id} | content packs | edu.pack.manage | Y | cursor |
| POST | /deliver | deliver to a patient (channel, language, note) | edu.deliver | Y | – |
| GET | /patients/{id}/education | "My education" timeline | edu.delivery.read / patient self | – | cursor |
| GET | /share/{token} | public tokenised view (records consumption) | public (token) | – | – |
| POST | /consumption/{deliveryId}/event | opened/progress/completed | public (token) / patient self | Y | – |
| POST | /consumption/{deliveryId}/quiz | quiz submission | patient self | Y | – |
| POST | /consumption/{deliveryId}/teach-back | nurse-documented teach-back | edu.teachback.record | Y | – |
| GET | /public/library?lang=&specialty= ; GET /public/article/{slug} | public website content | public (cached, CDN) | – | cursor |
| POST | /website/sync | force a sync to EN-012 | edu.website.sync | Y | – |
| GET | /reports/consumption ; /reports/coverage ; /reports/nabh-evidence | analytics | edu.report.read | – | – |

## 7. Domain Events (outbox)
- `education.content.published|updated|retired|unpublished_licence` {content_id, version, languages} → EN-012 website sync, EN-018 TV playlists, PE-001 library refresh, OP-038 suggestion cache invalidation.
- `education.translation.published` {language} → coverage matrix, notification to the requesting clinician.
- `education.delivered` {patient, content, channel, language} → PE-001 timeline, clinical record note (NABH evidence), PE-002 reinforcement schedule.
- `education.consumed` {opened, completion_pct, quiz_score} → clinician rail chip, analytics.
- `education.teachback.recorded` {status} → clinical record, NABH evidence.
- `education.content.review_due` {content_id, due} → owner notification.
- `education.feedback.received` {helpful, comment} → editor queue.
- Consumes: `diagnosis.recorded`, `ip.discharge.completed`, `rx.dispensed`, `ot.booking.created`, `immunisation.given`, `anc.visit.completed`, `package.booked`, `education.prescribed` (OP-038 — the clinician's explicit order), `patient.language.changed`.

## 8. Screens
- **Library** (desktop editor view / responsive patient view): search and filter by condition, procedure, specialty, type, language and audience; cards with type icon, read time, language chips and "reviewed on" date. Patient view is the same data with a plain, calm layout and a big search box.
- **Content Editor** (desktop): structured section editor (what it is / why / what to expect / what to do / warning signs / when to call us / FAQ), media manager with drag-drop and transcode status, readability meter, mapping panel (ICD/procedure/drug pickers with specificity), licence panel, SEO panel for public items, preview as phone/print/TV. Shortcuts: `Ctrl+S` save, `Ctrl+Shift+P` preview, `Ctrl+Enter` submit for review.
- **Review & Approval** (desktop + tablet for HODs): side-by-side diff against the previous version, compliance checklist (claims, copyright, DMRA, NMC), comment threads on sections, Approve/Send back. Mobile-friendly because HODs review between clinics.
- **Translation Workspace**: source and target side by side, glossary of clinical terms, caption editor for video with timecodes, reviewer sign-off; coverage matrix (content × language) with gaps highlighted.
- **Auto-Share Rules** (desktop): trigger, criteria, content/pack, channels, delay, language policy, "requires clinician confirmation" toggle, simulate ("this rule would have delivered to 214 patients last month").
- **Patient reader** (phone/desktop/kiosk/TV): distraction-free article or HLS video player with captions and speed control, language switcher, text-size control, "I understood" and quiz, print/save, "was this helpful?", and a link to ask a question (PE-004/desk). Works offline once opened (PWA cache); TV mode is a full-screen playlist with no interaction.
- **Clinician suggestion rail** (embedded in OP-002/IP-002/OP-003 via OP-038): ranked material for this diagnosis/procedure/drug in the patient's language, with a one-tap attach and a personal note field, plus consumption chips for previously sent items.
- **Analytics** (desktop): most/least consumed content, completion rates, quiz pass rates, language coverage and gaps, delivery by channel, NABH education-documented %, doctor-article leaderboards, website traffic from EN-012.

## 9. Integrations
- **OP-038** (the clinical prescribing layer — shares this content store; PE-003 must never duplicate `education_orders`), **PE-001/OP-020** (player and timeline), **EN-012** (website sync with SEO, hreflang, redirects), **EN-018** (TV playlists per department), **EN-034** (kiosk print/QR), **EN-009/EN-032** (tokenised link delivery on service templates), **NC-004/EN-038** (document approval workflow), **EN-039** (leaflet print templates), **EN-027** (code masters for mapping), **PE-002** (reinforcement drips), **EN-030** (quiz/feedback instrumentation), **NC-015** (NABH evidence), **NC-027** (staff training reuses the media pipeline), **EN-024** (audit).
- Media: S3 + CloudFront/CDN for public assets, HLS transcoding in the worker, captions as WebVTT; licensed-content sources tracked with expiry.
- Fallbacks: transcode failure → item stays in draft with a clear error; CDN outage → origin serve with degraded quality; website sync failure → retry queue with an editor-visible status.

## 10. Reports & Analytics
- Consumption: opens, completion rate and average watch time per content item, by language, channel and department; abandoned-at points for videos (where patients stop tells you where the script is bad).
- **Coverage**: percentage of the hospital's top 50 conditions and top 30 procedures with published material, per language — the honest measure of whether the library serves the actual patient population.
- **NABH evidence**: percentage of discharges and of defined diagnoses with documented education delivered and teach-back recorded, by department.
- Quiz pass rates and re-education triggers; "was this helpful?" scores; feedback comments queue.
- Doctor-article performance (reads, completion) and website traffic attribution (EN-012).
- Content health: items overdue for annual review, licences expiring in 60 days, retired items still receiving traffic, translation backlog.

## 11. Notifications
- **Patient** (service templates, consent-aware, no diagnosis in body): "Dr X has shared information about your treatment — tap to read", reinforcement nudge at day 3/7 (PE-002), "new material in your language is available".
- **Editor/owner**: review due in 30 days, licence expiring, translation requested/completed, transcode failed, feedback comment awaiting moderation, website sync error.
- **Reviewer (HOD/MS)**: content awaiting your review (with an SLA), translation awaiting language review.
- **Clinician**: your patient completed the education and scored 4/5 on the quiz; teach-back pending before discharge.
- **Quality**: monthly NABH education-documented percentage by department.

## 12. Permissions (RBAC keys)
`edu.content.list|suggest` (all clinical and front-office roles; patients via portal scope) · `edu.content.create|update` (Content editor, Doctor author) · `edu.content.review` (HOD, nominated reviewers) · `edu.content.approve|publish` (Quality Manager / MS per EN-038) · `edu.media.upload` (Editor) · `edu.translation.manage` (Editor, Translator) / `edu.translation.approve` (language-competent clinical reviewer) · `edu.mapping.manage` (Editor with clinical input) · `edu.rule.configure` (Editor lead + MS approval) · `edu.pack.manage` (Editor, Patient educator) · `edu.deliver` (Doctor, Nurse, Pharmacist, Educator, Front office) · `edu.delivery.read` (care team; patient self for their own) · `edu.teachback.record` (Nurse, Educator, Doctor) · `edu.website.sync` (Marketing + Editor lead) · `edu.report.read` (Quality, Admin, Marketing, HOD for own department).

## 13. Non-functional
- **Volumes**: 300–800 content items at maturity × 3–6 languages ≈ 2,000–4,000 published versions; 100–200 videos (2–8 min each); 5,000–15,000 deliveries/month at a 2000-bed hospital; public site traffic potentially far larger than internal use.
- **Performance**: library search p95 < 200 ms (trigram + filters); suggestion API < 100 ms (mapping index, cached per code set — it sits inside the consultation screen and must never make the doctor wait); article render < 1.5 s on 3G; video start-up < 3 s on 3G at the lowest ladder rung; public pages served from CDN with < 500 ms TTFB.
- **Offline**: opened articles and downloaded PDFs available in the PWA cache; video is streaming-only (with an explicit "download not available" note) except where a low-bandwidth MP4 is offered.
- **Printing**: A4/A5 leaflet from the same body content (never a separate document that can drift), with a QR to the video and the "reviewed on" date.
- **Accessibility**: WCAG 2.2 AA — captions and transcripts for all video, alt text for all images, tagged PDFs, adjustable text size, high contrast, screen-reader tested; audio versions for low-literacy patients; pictorial leaflets where literacy is a barrier.
- **i18n**: full multilingual content model (not just UI strings); Indic typography and line-breaking verified; language fallback explicit and visible.
- **Security/privacy**: public content has no PHI; tokenised patient links are opaque, expiring and view-capped; consumption records are PHI with read audit; children's content is not personalised or tracked; media assets scanned on upload.

## 14. Acceptance Criteria
1. Given a draft article, when an editor attempts to publish it without clinical review, then publication is blocked and the required reviewer chain is shown.
2. Given a Tamil translation prefilled by machine translation, when it is submitted, then it cannot reach `published` until a Tamil-competent clinical reviewer approves it.
3. Given a video without captions in its language, when publishing, then the accessibility gate blocks publication with the reason.
4. Given a published version, when the editor edits it, then a new version is created and the previous published version remains immutable and retrievable.
5. Given a licence expires, then the item is auto-unpublished within the daily job, the editor is notified, and the public URL shows a "temporarily unavailable" page rather than a 404.
6. Given a consultation coded E11.9 in a Tamil-speaking patient, when the clinician opens the suggestion rail, then Tamil-language T2DM material ranks above English equivalents and the API responds in < 100 ms.
7. Given an auto-share rule for discharge after knee arthroplasty, then the post-op pack is delivered on `ip.discharge.completed` in the patient's preferred language, the message body contains no diagnosis, and the delivery is recorded against the encounter as NABH evidence.
8. Given a patient with communication consent withdrawn, then no message is sent, but the material remains available in their portal and can be printed at the desk.
9. Given a tokenised education link, then the URL contains no PHI, expires after the configured period, enforces the view cap, and opening it records opened/completion without exposing any other record.
10. Given a patient completes the comprehension quiz with 4/5, then the score appears on the clinician's rail chip and in the clinical record.
11. Given a nurse records teach-back as "needs re-education", then a reinforcement follow-up is scheduled through PE-002 and the discharge checklist reflects it.
12. Given content is retired, then a successor is required (or an explicit no-successor decision), and existing links resolve to the successor with a notice.
13. Given a doctor-authored article, then the compliance checklist including the NMC solicitation screen must be completed before approval, and the published article carries the byline and review date.
14. Given a published public item, then it appears on the website within the sync interval with correct slug, meta description and hreflang for each language, and unpublishing removes it and leaves a redirect.
15. Given the coverage report is run, then it shows, per language, the percentage of the hospital's top 50 conditions with published material, and the gaps are listed.
16. Given a video item, when played on a 3G connection, then playback starts in < 3 s at the lowest ladder rung and captions are available.
17. Given a user without `edu.content.publish`, when publishing, then 403 and an audit entry are recorded.
18. Given a child's profile, then no personalised recommendation or behavioural tracking occurs on the education content served.

## 15. Enhancements / Later phases
- From the VIMS sheet (row 142): condition library, video, multilingual content, push notify — all core above.
- (market) patient education/video library and website content sync (competitors treat this as a website feature; running it as a governed, code-mapped, versioned clinical asset is the differentiator).
- Later: **AI-assisted drafting and translation** (AI-002/AI-004) with mandatory clinical review; automatic reading-level simplification with a clinician diff; text-to-speech in Indian languages for low-literacy patients (AI-004); personalised packs assembled from the patient's actual problem list and medicines; interactive decision aids for elective surgery (shared decision-making, with outcome and risk figures from the hospital's own registry data); AR/3D anatomy explainers for surgical consent; comprehension analytics driving automatic rewrite suggestions; content effectiveness studies (does the group receiving the pack have fewer readmissions/queries?); syndication of the library to the hospital's WhatsApp channel and YouTube with governance; sign-language video for deaf patients; integration with national health-content sources (NHP/MoHFW) as a curated baseline.

## 16. Open Questions for the Hospital
1. Which 30 conditions and 20 procedures should the library cover first, and which languages does your patient population actually read?
2. Who authors content — an in-house editor, doctors, or a licensed content vendor? If licensed, which vendor and what are the licence terms and expiry?
3. Who clinically reviews and approves patient content, and what turnaround can they commit to?
4. Do you want doctor-authored articles published under their byline on the website (NMC solicitation boundaries need agreement)?
5. Should education be auto-shared on diagnosis/discharge/dispensing, or only when a clinician explicitly attaches it?
6. Do you want comprehension quizzes and teach-back documentation (recommended for NABH PRE evidence), and for which patient groups?
7. Which channels: portal only, WhatsApp, print with the visit summary, kiosk, waiting-room TV? Do you have DLT/WhatsApp templates approved for education links?
8. Is your website managed by us (EN-012) or by an external agency — and who owns the content there today?
9. What is your policy on printed leaflets — do you want every article to also produce a print-ready A4/A5 leaflet?
10. For low-literacy patients, do you want audio/IVR versions and pictorial leaflets, and in which languages?
11. Who owns the annual content review calendar, and what happens if a review lapses?
12. Do you run group education classes today (diabetes, ANC, pre-op)? Which ones, and who runs them?
