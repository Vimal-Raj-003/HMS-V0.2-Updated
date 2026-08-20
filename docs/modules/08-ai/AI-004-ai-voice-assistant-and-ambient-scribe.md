# AI-004 — AI Voice Assistant & Ambient Scribe (Indian-Language & Code-Mixed Speech-to-Text, Ambient Consultation Capture with Dual Consent, SOAP Note Drafting, Voice Commands with Confirmation, Radiology Dictation, Nursing Voice Notes, On-Prem STT Option)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain          | AI & Advanced Tech                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Module ID       | AI-004                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Phase           | 12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Complexity      | Very High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Depends on      | **AI-001 §0 (AI Platform Foundation — mandatory)**, OP-002 (consultation note, CPOE), OP-008 (radiology reporting & dictation), IP-003 (nursing notes, SBAR handover), IP-006/IP-024 (op notes, anaesthesia record), EN-039 (note templates & macros), EN-028 (consent — **dual consent for ambient recording**), EN-027 (drug/test/diagnosis vocabulary), EN-029 (all voice-created orders pass full deterministic checks), EN-024 (audit), EN-007 (settings, secrets), AI-002 (structuring assistance), AI-006 (coding from the drafted note)                                                                                                                                                                                                                                            |
| Consumed by     | OP-002, OP-008, IP-003, IP-002 (discharge summary drafting), IP-006, NC-003 (MRD documentation completeness), AI-006                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Feature flag    | `module.ai_voice.enabled` (sub: `voice.dictation`, `voice.ambient_scribe`, `voice.commands`, `voice.radiology`, `voice.nursing`, `voice.onprem_stt`, `voice.diarisation`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Primary roles   | Doctor — Consultant/IP/Emergency (6/7/8), Radiologist (12), Surgeon (9), Nurse — Ward/ICU (17/18), Resident (14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Secondary roles | Pathologist (13), Anaesthetist (10), MRD Officer (43 — transcription QA), Medical Superintendent (4), DPO (57 — recording governance), IT Admin (56)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Regulatory      | **DPDP Act 2023 & Rules 2025** (voice is personal data; ambient recording of a consultation requires explicit, informed, separately-recorded consent from **both** patient and clinician, purpose-limited, with withdrawal and erasure); NMC Telemedicine Practice Guidelines 2020 & the NMC Code of Ethics (consultation recording, confidentiality); **NMC/MCI records rules — the signed note, not the transcript, is the medical record**; NABH 6th edn IMS/COP (legible, timely, authenticated documentation); Indian Telegraph/IT Act interception rules (no covert recording — a visible indicator is mandatory); CDSCO — transcription and drafting are documentation aids, explicitly not SaMD (AI-001 §0.8); ABDM/EHR Standards (final note stored as structured FHIR resources) |

## 1. Purpose

AI-004 lets clinicians speak instead of type: push-to-talk dictation into any clinical field, ambient capture of the
whole consultation that is turned into a **draft** SOAP note for the doctor to edit and sign, voice commands for
navigation and order entry with explicit confirmation, radiology dictation into OP-008 structured reports, and nursing
voice notes at the bedside. It handles Indian-accented English, eight Indian languages and the code-mixed speech that
real consultations are conducted in. Nothing it produces is a record until a human signs it, and nothing is recorded
without both parties consenting.

## 2. Users & Jobs-to-be-done

- **OPD consultant (6, desktop/tablet, 40–60 patients/day)**: talk to the patient normally; get a structured SOAP
  draft with history, examination, assessment and plan pre-filled when the patient leaves; edit for 30 seconds; sign.
  The job is to reclaim the 3–4 minutes/patient currently spent typing.
- **IP doctor / resident (7/14, tablet on rounds)**: dictate the progress note at the bedside, dictate orders which
  then go through OP-002's normal signing and EN-029's checks.
- **Radiologist (12, reading room, headset + foot pedal)**: dictate into the OP-008 structured report with template
  macros ("normal chest" expands), navigate fields by voice, correct by voice, sign by hand.
- **Surgeon / anaesthetist (9/10)**: dictate the operative note immediately after the case (IP-006) — the highest-value
  documentation window and the one most often delayed.
- **Ward/ICU nurse (17/18, phone, gloved hands)**: speak a nursing note or a wound observation instead of finding a
  free terminal; the note lands as a draft in IP-003 for confirmation.
- **MRD (43)**: audit transcript-vs-signed-note divergence and documentation completeness.
- **DPO (57)**: prove that every ambient recording had valid dual consent and was deleted on schedule.

## 3. Core Workflows

### 3.1 Consent (the gate for everything ambient)

1. **Ambient capture is off by default per doctor, per room and per patient.** Enabling it requires three things:
   (a) the hospital has enabled the sub-flag, (b) the clinician has opted in (a signed acceptable-use acknowledgement
   stored in EN-028), and (c) the **patient consents for this encounter**.
2. Patient consent is captured before the microphone opens: a short plain-language script in the patient's language
   (on the consultation-room tablet, kiosk or the patient's own phone via PE-001) explaining what is recorded, that
   the recording is deleted after the note is signed (default), that they may decline without any effect on their
   care, and that they may stop it at any moment. Recorded as an EN-028 consent artefact + `ai_consents(purpose=
ambient_recording)` → Event `voice.consent.granted`.
3. **Dual consent**: the clinician also confirms on-screen ("Start ambient note"). Both identities, both timestamps
   and the consent artefact id are written on the session. A session cannot start with only one.
4. **Visible recording indicator is mandatory and non-dismissible**: a red pulsing bar across the top of the screen,
   a physical indicator on the room device where one exists, plus an audible tone at start and stop. Covert recording
   is a blocking defect.
5. **Stop/pause is always one tap** and is also available to the patient on the room tablet ("Pause recording").
   Anything spoken while paused is not captured. Withdrawal mid-consultation deletes the audio immediately and keeps
   only what the clinician has already accepted into the note (with a note that capture was withdrawn).
6. Minors, patients unable to consent (unconscious, altered sensorium), MLC cases, psychiatry/counselling sessions
   (OP-032/42) and any consultation involving a legally sensitive topic default to **ambient disabled**; enabling
   requires an explicit hospital policy decision recorded per department.

### 3.2 Dictation (push-to-talk, no ambient recording)

1. Clinician focuses any clinical text field and holds the mic hotkey (`F4` hold-to-talk, or a foot pedal / headset
   button) → streaming ASR shows an **interim transcript** within 800 ms and a stabilised transcript within 1.5 s of
   speech end.
2. Medical vocabulary boosting: the recogniser is biased with the hospital's own drug master, test names, doctor
   names, department names, common diagnoses and the clinician's personal frequent terms (learned from their signed
   notes) — this is the single biggest accuracy lever for Indian drug names.
3. Formatting commands are recognised inline: "new line", "next paragraph", "full stop", "comma", "bullet",
   "open bracket…close bracket", "scratch that" (deletes the last utterance), "correct <word> to <word>".
4. Template macros from EN-039 expand by voice ("insert normal cardiovascular examination").
5. The transcript lands in the field as **editable draft text**, visually marked as dictated until the clinician
   touches the field. Nothing is signed by voice.
6. No audio is retained for pure dictation by default (streamed, transcribed, discarded), unless the hospital opts
   into a short retention window for QA — which requires the same consent treatment as ambient.

### 3.3 Ambient consultation capture → SOAP draft

1. Consent (§3.1) → **Start** → session opens with the encounter context (patient age/sex, chief complaint, problem
   list, current meds, recent results) supplied as structured context, not as audio.
2. **Speaker diarisation** separates clinician / patient / attendant / other; the clinician's channel is preferred for
   clinical statements and the patient's for symptoms. Where a dedicated room mic array exists, channel separation is
   used; otherwise diarisation is model-based and its confidence is exposed.
3. Streaming transcript is visible to the clinician during the consult (a small, unobtrusive panel they can ignore).
4. On **Stop**, the transcript is redacted (AI-001 §0.5) and passed to the note-generation prompt, which produces a
   **schema-validated SOAP draft**: `subjective` (HPI, associated symptoms, negatives, relevant history), `objective`
   (examination findings actually stated aloud + auto-inserted structured vitals from OP-007), `assessment`
   (working impression **as stated by the clinician** — the model may not invent a diagnosis), `plan` (investigations,
   medications, advice, follow-up), plus `patient_instructions` in the patient's language and a
   `not_documented_prompts[]` list ("allergy status was not discussed", "no examination findings stated").
5. **Every generated sentence is linked to its transcript span**; hovering a sentence highlights the source utterance.
   Sentences with no supporting utterance are not generated (grounding guardrail); if the model produces one it is
   dropped and counted.
6. The doctor reviews in a diff-friendly editor, edits freely, and **signs**. Signing creates the OP-002 clinical note
   version (append-only, per CLAUDE.md §3) with `source = ai_scribe`, the session id and the prompt/model versions.
   Orders and prescriptions mentioned in the plan are **not** created automatically — they are offered as one-click
   drafts that go through OP-002 + EN-029 exactly as typed orders do.
7. **Audio retention default: delete on note signature** (or 24 h, whichever is first). Retaining audio longer is a
   per-hospital setting with a hard ceiling (default max 7 days), a stated purpose, and DPO sign-off. Transcripts
   default to 30 days and are then reduced to the signed note alone.
8. If the doctor never signs within 24 h, the draft expires and the audio is deleted; the encounter falls back to
   manual documentation (an unsigned AI draft must not linger as a shadow record).

### 3.4 Voice commands (navigation & order entry)

1. Wake action is explicit (hotkey or "Hey Vim" only where a dedicated room device is configured — never
   always-listening on a shared clinical workstation).
2. Command grammar is a **closed set** resolved to tools, never free generation: `open patient <UHID/name>`,
   `show last labs`, `show X-ray`, `go to prescription`, `add diagnosis <term>`, `order CBC and creatinine`,
   `prescribe <drug> <strength> <frequency> <duration>`, `admit to <ward>`, `schedule follow-up in 2 weeks`,
   `mark vitals abnormal`, `start dictation`, `sign` (blocked — see below).
3. **Every state-changing command requires an explicit visual confirmation step**: the parsed command is rendered as a
   structured card ("Order: CBC, Serum creatinine — Confirm?") and the clinician confirms by click/keyboard/voice
   ("confirm"), with a 3-second undo. Ambiguous or low-confidence parses are never executed — they open the search UI
   pre-filled.
4. **Voice can never**: sign a note, sign a prescription, authorise a discharge, apply a discount, override an EN-029
   alert, administer a medication, or perform any two-person-verification step. These require the normal
   authenticated UI action.
5. Prescribing by voice produces a **draft order line** that then runs the full EN-029 synchronous evaluation; any
   hard-stop blocks exactly as it would for typed entry. Dose is never inferred from context — an incomplete spoken
   order leaves the missing fields blank and focused.
6. Patient-context safety: a command that would open a different patient's record requires re-confirmation showing
   name, UHID and photo, to prevent wrong-patient documentation.

### 3.5 Radiology dictation (OP-008)

1. Radiologist opens a study in the OHIF/PACS viewer (EN-008); the dictation panel binds to the OP-008 structured
   report template for that modality/body part.
2. Foot pedal or headset controls record/pause/rewind; voice navigates fields ("findings", "impression",
   "next field"), macros expand ("normal CT head" fills the template's normal statements).
3. Draft report is generated with the dictated findings placed in the correct template sections; **the impression is
   never auto-generated from the findings** — the radiologist dictates or writes it (this is the boundary between a
   documentation aid and an interpretive claim).
4. Critical findings still follow OP-008/EN-029's critical-result pathway, triggered by the radiologist's action.
5. Turnaround (dictation → signed report) is measured as a headline KPI.

### 3.6 Nursing voice notes (IP-003)

1. Nurse holds the mic button on the phone PWA at the bedside → speaks the observation → transcript becomes a **draft
   nursing note** attached to the patient and shift, with any recognised structured elements (pain score, wound
   appearance, intake/output figures) offered as chips to confirm into the flowsheet.
2. Nothing enters the flowsheet or the MAR by voice without confirmation; medication administration is never
   voice-recorded (5-Rights and barcode verification stand, IP-003/IP-004).
3. Works with gloves and in noisy wards; noise-robust model profile; offline capture queues the audio locally
   (encrypted) and transcribes on reconnect, with the note remaining a draft until the nurse confirms.

### 3.7 Exceptions

- **ASR unavailable / low audio quality** → the field falls back to typing with a clear banner; ambient sessions
  refuse to start rather than record audio that cannot be transcribed.
- **Consent withdrawn mid-session** → immediate stop, audio purged, partial draft retained only if already accepted.
- **Wrong patient detected** (context mismatch between the spoken name and the open encounter) → session paused with a
  hard warning.
- **Multiple speakers / crosstalk / attendant dominating** → diarisation confidence shown; low confidence marks the
  affected spans "speaker uncertain" and excludes them from the `subjective` section.
- **Code-mixed speech the model cannot resolve** → the untranscribed span is preserved as `[inaudible 00:03:12]` in
  the transcript and flagged in the draft; the model never invents content to fill a gap.

## 4. Data Model (schema `ai`, prefix `voice_`; shared tables per AI-001 §0.10)

- `voice_sessions` — id uuidv7, hospital_id, branch_id, mode enum(dictation/ambient/command/radiology/nursing),
  patient_id?, encounter_id?, study_id?, clinician_user_id, device_ref, room_ref?, language_primary,
  languages_detected[], started_at, ended_at, duration_sec, consent_artefact_id? (mandatory for ambient),
  patient_consent_at?, clinician_consent_at?, indicator_shown bool, paused_sec, status enum(active/completed/
  aborted/consent_withdrawn/failed), audio_ref?, audio_retention_until?, audio_deleted_at, asr_engine, asr_model_id,
  wer_estimate, diarisation_confidence, cost_amount; indexes (hospital_id, clinician_user_id, started_at desc),
  (patient_id, started_at desc); partitioned monthly.
- `voice_transcripts` — id, session_id, seq, speaker enum(clinician/patient/attendant/other/unknown),
  speaker_confidence, start_ms, end_ms, text, language, confidence, redacted bool, inaudible bool; index (session_id, seq).
- `voice_note_drafts` — id, session_id, target enum(op_note/ip_progress/discharge_summary/radiology_report/
  nursing_note/op_record), template_id (EN-039), payload jsonb (SOAP sections, schema-validated),
  sentence_provenance jsonb (sentence → transcript span ids), not_documented_prompts jsonb, status
  enum(draft/edited/signed/discarded/expired), generated_at, prompt_version_id, model_id, edited_by, edited_at,
  edit_distance_pct, signed_note_ref, signed_at, discard_reason.
- `voice_commands` — id, session_id?, hospital_id, user_id, utterance_text, parsed_intent, parsed_args jsonb,
  confidence, state enum(parsed/confirmed/executed/rejected/ambiguous/blocked), blocked_reason?, target_ref,
  confirmed_at, executed_at, undo_used bool; index (hospital_id, user_id, created_at desc).
- `voice_vocabulary` — id, hospital_id, term, phonetic_hints[], category enum(drug/test/diagnosis/procedure/person/
  department/local_term), source enum(master/learned/manual), boost_weight, language, active — the medical-vocabulary
  customisation store, seeded from EN-027 and grown from corrections.
- `voice_corrections` — id, session_id, transcript_id?, original_text, corrected_text, field_path, corrected_by,
  corrected_at, term_extracted? — feeds `voice_vocabulary` and the golden dataset.
- `voice_consent_log` — id, hospital_id, patient_id, encounter_id, clinician_user_id, script_version, language,
  captured_via enum(room_tablet/kiosk/patient_phone/verbal_witnessed), granted bool, withdrawn_at?, witness_user_id?,
  artefact_ref (EN-028), created_at — the DPO's evidence table; **append-only**.
- `voice_quality_samples` — session_id, sampled_at, auditor_id, wer_measured, medical_term_error_count,
  hallucination_count, verdict — the ongoing accuracy measurement.
- Retention: audio per §3.3 (default delete on signature, hard ceiling 7 days); transcripts 30 days default (max 1
  year with DPO sign-off); drafts until signed or expired at 24 h; consent log 10 years; corrections and vocabulary
  indefinitely.

## 5. Business Rules & Validations

- **No recording without dual consent, and no covert recording ever.** The indicator is non-dismissible; a session
  that cannot render the indicator must not start.
- **The signed note is the record; the transcript and draft are not.** Transcripts are working material, are labelled
  as such, are excluded from the legal medical record export unless a court orders otherwise, and are deleted on
  schedule. MRD's retention policy (NC-003) governs the signed note only.
- **The model may not invent clinical content.** Every generated sentence must be traceable to a transcript span;
  ungrounded sentences are dropped. Diagnoses appear only if the clinician stated them; a "possible diagnosis" the
  patient mentioned is placed in `subjective`, never in `assessment`.
- **Voice never signs anything** and never bypasses EN-029, two-person verification, or barcode med administration.
- Every state-changing voice command requires visual confirmation with a 3-second undo; ambiguity opens the UI rather
  than guessing.
- Drug names dictated are matched against EN-027 with the same **LASA guard** as AI-003 §3.2 — if two candidates are
  a LASA pair, neither is auto-filled.
- Numbers spoken in doses, rates and volumes are transcribed digit-by-digit with a confirmation display ("15 mg —
  confirm") because ASR digit errors are the classic voice-safety failure.
- Ambient capture is prohibited by default in psychiatry/counselling, MLC, paediatric-without-guardian and
  incapacitated-patient contexts; enabling requires a recorded departmental policy decision.
- An unsigned ambient draft expires at 24 h and the audio is deleted; it never becomes a record by inaction.
- Clinician-level opt-out is always available and is never reported as a performance metric to management (adoption is
  tracked in aggregate only) — this is a trust rule, not a technical one, and it is stated in the model card.
- On-prem STT is mandatory for tenants with `egress_policy = none`; the accuracy delta is measured per language and
  published in the model card.
- No audio, transcript or note text may appear in application logs, and audio objects are encrypted at rest with
  per-tenant keys and object-lock disabled (so scheduled deletion actually deletes).

## 6. API Surface (`/api/v1/voice`)

| Method    | Path                                                             | Purpose                                             | Permission                                           | Notes                                               |
| --------- | ---------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| POST      | /sessions                                                        | start a session (mode, context, consent refs)       | `voice.session.start`                                | ambient requires consent artefact; returns WS token |
| WS        | /stream/:sessionId                                               | bidirectional audio in / interim transcript out     | session token                                        | Opus 16 kHz mono; backpressure-aware                |
| POST      | /sessions/:id/pause \| /resume \| /stop                          | session control                                     | `voice.session.start`                                | pause is instant, audio-gated                       |
| POST      | /sessions/:id/withdraw-consent                                   | patient withdrawal                                  | patient/room device                                  | purges audio immediately                            |
| GET       | /sessions/:id/transcript                                         | working transcript                                  | `voice.transcript.read`                              | PHI-audited, watermark "working material"           |
| POST      | /sessions/:id/generate-note                                      | produce the SOAP/report draft                       | `voice.note.generate`                                | schema-validated, grounded                          |
| GET/PATCH | /drafts/:id                                                      | review & edit the draft                             | `voice.note.edit`                                    | records edit distance                               |
| POST      | /drafts/:id/sign                                                 | hand to the owning module to create the signed note | `voice.note.sign` + the module's own note permission | creates OP-002/OP-008/IP-003 version                |
| POST      | /drafts/:id/discard                                              | discard with reason                                 | `voice.note.edit`                                    |                                                     |
| POST      | /commands/parse ; POST /commands/:id/confirm \| /reject \| /undo | voice command lifecycle                             | `voice.command.use`                                  | confirm mandatory before execution                  |
| GET/POST  | /vocabulary ; POST /vocabulary/import                            | medical vocabulary customisation                    | `voice.vocabulary.manage` (12, 32, 56)               | seeded from EN-027                                  |
| POST      | /corrections                                                     | submit a transcript correction                      | `voice.note.edit`                                    | feeds vocabulary + golden set                       |
| GET       | /consent-log?patient&from&to                                     | DPO evidence                                        | `voice.consent.audit` (57, 58, 4)                    | append-only                                         |
| GET       | /metrics/wer ; /metrics/adoption ; /metrics/time-saved           | KPIs                                                | `voice.report.read`                                  | aggregate only for adoption                         |
| POST      | /quality-samples/:id/audit                                       | manual WER/hallucination audit                      | `voice.quality.audit` (43, 54)                       |                                                     |

## 7. Domain Events (outbox)

- `voice.consent.granted|withdrawn` → EN-028 ledger, DPO dashboard, audit. **Withdrawal triggers immediate purge.**
- `voice.session.started|stopped|aborted` → audit, cost metering.
- `voice.note.drafted` → clinician task ("draft ready"), MRD documentation-timeliness metric.
- `voice.note.signed` → OP-002/OP-008/IP-003 note version created; AI-006 coding trigger; `ai.suggestion.accepted`
  with the edit distance as the quality signal.
- `voice.note.expired` → audio purge job, documentation-gap alert to the clinician.
- `voice.command.executed|blocked` → audit; blocked signing/override attempts are security-relevant.
- `voice.audio.purged` → DPO evidence trail (with the retention rule applied).
- `voice.transcription.failed` / `voice.quality.degraded` → IT Admin.
- Consumes: `encounter.opened`, `study.opened`, `vitals.recorded` (to inject into the objective section),
  `consent.granted`, `note.signed`.

## 8. Screens (UI)

- **Dictation affordance** (every clinical text field, desktop/tablet): mic icon with level meter, hold-to-talk
  (`F4`), interim text in grey italic → stabilised in normal weight, "dictated" chip until edited. `Esc` cancels the
  utterance, `Ctrl+Z` reverts. Works with a headset button and a USB foot pedal.
- **Ambient Scribe bar** (consultation screen, desktop + room tablet): non-dismissible red recording bar with elapsed
  time, speaker chips lighting as people talk, one-tap Pause/Stop, and the patient-facing tablet showing
  "Recording — you can pause this at any time" in their language.
- **Consent capture screen** (room tablet / patient phone, phone-first): plain-language script in 8 languages, large
  Accept/Decline buttons, "what happens to the recording" expander, and a Decline path that visibly changes nothing
  else about the consultation.
- **Note Review editor** (desktop primary, tablet supported): SOAP sections; each generated sentence hoverable to
  reveal its transcript span and timestamp (click to play the audio while it still exists); an amber
  "not documented" prompt strip (allergies, red flags, follow-up) the doctor can dismiss or address; a
  transcript side-panel toggle; word-level diff against the model output shown to the doctor before signing.
  Shortcuts: `Ctrl+Enter` sign, `Alt+T` transcript, `Alt+N` next unreviewed section, `Alt+P` play span.
- **Voice command confirmation card** (all clinical screens): the parsed action rendered structurally with Confirm
  (`Enter`) / Cancel (`Esc`) and a 3-second undo toast after execution. Blocked commands state why ("signing must be
  done manually").
- **Radiology dictation panel** (reading room, dual-monitor): template sections list, current field highlighted,
  waveform + pedal state, macro palette, "impression must be dictated" guard, TAT timer since study assignment.
- **Nursing voice note** (phone, IP-003): big mic button, live level meter, transcript preview, chips for structured
  values detected (pain 6/10, output 350 mL) requiring a tap to confirm into the flowsheet; offline badge.
- **Voice Admin console** (desktop, IT/Radiology lead): engine selection (cloud/on-prem) per language, vocabulary
  manager with test box, per-room device registry and mic health, retention settings with the hard ceiling shown,
  WER dashboard by language/accent/department.
- **DPO Recording Register** (desktop, DPO/Auditor): every ambient session with consent evidence, retention state,
  purge timestamp, and any withdrawal — exportable for a DPDP audit.
- Error/empty states: "Microphone blocked — check browser permissions", "Audio too noisy to transcribe reliably —
  dictation paused", "Consent not captured — ambient capture unavailable for this encounter", "Draft expired and
  audio deleted — please document manually".

## 9. Integrations

- **ASR engines** behind one adapter: cloud (Deepgram Nova / AssemblyAI / Whisper-large via provider, chosen per
  language and per tenant) and **on-prem** (Whisper-large-v3 or an Indic-tuned model served on the hospital's GPU
  node, plus a lightweight streaming model for interim results). Engine choice is per language and recorded on every
  session; switching engines forces a fresh WER measurement.
- **TTS** (optional) for read-back of confirmations and for the AI-001 IVR bridge.
- **Devices**: USB/Bluetooth headsets, dictation microphones (Philips SpeechMike class) with programmable buttons,
  USB foot pedals, room mic arrays for ambient capture, tablet mics. Device registry with health checks (EN-042).
- **EN-039** template/macro library; **EN-027** vocabulary seeding; **OP-007** vitals injection into the objective
  section; **EN-008/OP-008** for radiology binding; **AI-002** for optional structuring assistance; **AI-006**
  consumes the signed note for coding.
- **Audio transport**: WebRTC/WS with Opus, 16 kHz mono, adaptive bitrate, jitter buffer; on-prem deployments keep
  audio entirely inside the hospital network.

## 10. Reports & Analytics

- **Accuracy**: word error rate overall and for **medical terms specifically** (the number that matters), by
  language, accent cluster, department, speaker and engine; hallucination rate from quality samples (target 0);
  diarisation accuracy.
- **Documentation quality & time**: median edit distance between draft and signed note (a proxy for draft usefulness),
  time from consultation end to signed note, notes signed same-day %, documentation completeness (NC-003), radiology
  dictation-to-sign TAT.
- **Time saved**: measured, not assumed — a controlled comparison of typed vs scribed consultations per doctor
  (opt-in), reported in aggregate only.
- **Adoption**: sessions/clinician/day, opt-in rate, abandonment rate mid-session, dictation vs ambient mix.
- **Safety**: blocked voice commands, wrong-patient warnings, LASA guards triggered, digit-confirmation corrections.
- **Privacy**: ambient sessions with valid dual consent (must be 100 %), withdrawals, audio purged on schedule (must
  be 100 %), overdue purges (must be 0).
- **Cost**: ₹ per consultation scribed, ₹ per dictated minute, cloud vs on-prem.
- Read models: `analytics.mv_voice_wer_daily`, `mv_voice_adoption_daily`, `mv_voice_note_turnaround`.

## 11. Notifications

- "Your note draft is ready" → clinician in-app (never SMS — it references a patient encounter).
- Draft expiring in 4 hours / expired with audio deleted → clinician.
- Consent withdrawal → clinician (immediate, in-session) + DPO log.
- Overdue audio purge or a retention-policy breach → **immediate DPO + IT security alert** (this is a compliance
  incident, not a warning).
- Mic/device failure in a consultation room → IT Admin + the room's clinician.
- WER regression after an engine/model change → Radiology lead, IT Admin, Governance Committee.

## 12. Permissions (RBAC keys)

`voice.session.start` (6/7/8/9/10/11/12/13/14/17/18, per sub-flag) · `voice.transcript.read` (session owner; MRD 43
and Auditor 58 with PHI audit) · `voice.note.generate` / `voice.note.edit` (session owner + covering clinician) ·
`voice.note.sign` (only roles already permitted to sign that note type — voice adds no signing rights) ·
`voice.command.use` (clinical roles) · `voice.vocabulary.manage` (12, 32, 56) · `voice.consent.audit` (57, 58, 4) ·
`voice.quality.audit` (43, 54) · `voice.report.read` (4, 5, 54, 56) · `voice.settings.manage` (56 + 4 for retention
changes) · plus AI-001 §0.13.

## 13. Non-functional

- **Volumes (2000-bed)**: 5000 OP consultations/day with 20 % ambient adoption ⇒ ~1000 ambient sessions/day averaging
  9 minutes ⇒ ~150 audio-hours/day; plus ~3000 dictation bursts/day, ~800 radiology dictations/day, ~2000 nursing
  voice notes/day. Peak 60 concurrent streams.
- **Latency**: interim transcript < 800 ms p95; final utterance stabilised < 1.5 s after speech end; note draft
  generated < 20 s after Stop for a 10-minute consultation (streamed section by section so the doctor can start
  reviewing at ~5 s); voice command parse-to-confirmation-card < 1.2 s.
- **Accuracy acceptance thresholds (production gates)**: overall WER ≤ 12 % on Indian-accented English, ≤ 18 % on
  each supported Indian language, and **medical-term error rate ≤ 3 %** on the golden set of 200 consultations
  (multi-accent, code-mixed, noisy-ward subsets); diarisation speaker accuracy ≥ 90 %; hallucinated-sentence rate 0
  (any occurrence blocks release); digit/dose transcription accuracy ≥ 99 % with mandatory confirmation display.
- **Languages**: en-IN plus hi, ta, te, ml, kn, mr, bn, with explicit **code-mixing** support (English clinical terms
  inside an Indian-language sentence is the normal case, not an edge case) and Romanised input in the review editor.
- **Availability**: ASR failure degrades to typing; ambient sessions refuse to start rather than record un-transcribable
  audio; the WS reconnects with buffered audio (up to 60 s) without losing the session.
- **Offline**: nursing voice notes record locally (encrypted IndexedDB, max 5 min per note, 20 notes) and transcribe
  on reconnect; ambient capture requires connectivity (or an on-prem engine on the LAN, which is the normal on-prem
  case).
- **Security**: audio encrypted in transit (DTLS/TLS) and at rest (per-tenant KMS keys), never in logs, purge jobs
  verified by a daily reconciliation report, room devices authenticated as device identities (EN-007), microphone
  permission scoped per origin.
- **Accessibility**: full keyboard parity for every voice action (voice is never the only way to do anything); visual
  transcript for hearing-impaired clinicians; adjustable interim-text size; the recording indicator is
  non-colour-dependent (icon + text + motion).
- **Testing**: golden set of 200 consultations across accents/languages/noise; a hallucination regression suite where
  the transcript deliberately omits content the model might be tempted to add; e2e Playwright for consent →
  record → draft → edit → sign; a nightly purge-verification job that fails CI if any audio outlives its retention.

## 14. Acceptance Criteria

1. **Given** ambient capture is requested, **when** either the patient's or the clinician's consent is missing,
   **then** the session cannot start, the microphone is never opened, and the reason is shown.
2. **Given** an ambient session is running, **when** the screen is rendered, **then** a non-dismissible recording
   indicator with elapsed time is visible on both the clinician's screen and the patient-facing device, and an
   audible tone played at start.
3. **Given** a patient taps "Stop recording" mid-consultation, **when** processed, **then** capture stops within
   1 second, the audio is purged immediately, `voice.consent.withdrawn` is emitted, and only content the clinician
   had already accepted remains in the draft.
4. **Given** a generated SOAP draft, **when** any sentence has no supporting transcript span, **then** that sentence
   is not shown, and the hallucination counter increments; **and** every displayed sentence reveals its transcript
   span and timestamp on hover.
5. **Given** the patient mentioned a possible diagnosis and the clinician did not state one, **when** the draft is
   generated, **then** the mention appears in `subjective` and the `assessment` section remains empty with a
   "not documented" prompt.
6. **Given** a draft is never signed, **when** 24 hours elapse, **then** the draft expires, the audio and transcript
   are deleted, the clinician is notified, and no record is created.
7. **Given** a voice command "prescribe amoxicillin 500 mg TDS for 5 days", **when** parsed, **then** a confirmation
   card is displayed, execution requires an explicit confirm, the resulting draft order runs the full EN-029
   evaluation, and any hard-stop blocks signing exactly as for typed entry.
8. **Given** a voice command "sign the note" or "override this alert", **when** parsed, **then** it is blocked with an
   explanation, and the block is audited.
9. **Given** two LASA drug candidates from a dictated drug name, **when** matched, **then** neither is auto-filled and
   the clinician chooses from tall-man-lettered options.
10. **Given** a dictated dose "fifteen milligrams", **when** transcribed, **then** the numeric value is displayed for
    explicit confirmation before it can enter an order field.
11. **Given** a radiology dictation, **when** the draft report is produced, **then** findings are placed in the
    template sections and the **impression is empty** until the radiologist dictates or types it.
12. **Given** the ASR engine is unavailable, **when** a clinician tries to dictate, **then** the field falls back to
    typing with a visible banner and no audio is captured.
13. **Given** an audio object has passed its retention time, **when** the nightly purge reconciliation runs, **then**
    zero objects remain past retention, and any exception raises a DPO compliance alert.
14. **Given** a DPDP audit request, **when** the recording register is exported, **then** every ambient session shows
    both consent timestamps, the consent script version and language, the retention rule applied and the purge
    timestamp.
15. **Given** a tenant with `egress_policy = none`, **when** any voice feature runs, **then** audio never leaves the
    hospital network, the on-prem engine is used, and the model card shows its measured WER for each language.
16. **Given** a signed note, **when** audited, **then** it records that it originated from an AI draft, the edit
    distance from the draft, the ASR engine, the prompt/model versions and the session id — and the transcript is
    excluded from the legal medical record export.

## 15. Enhancements / Later phases

- **Ambient order extraction**: propose the orders and prescriptions discussed in the consultation as a pre-filled
  basket (still requiring EN-029 checks and a signature) — the biggest remaining time saving after the note itself.
- **Discharge summary drafting** from the whole admission's notes (IP-002), and **operative note drafting** from the
  surgeon's dictation plus OT structured data (IP-006).
- **Patient-facing visit summary** generated in the patient's language and sent via PE-001/AI-001 after the doctor
  approves it.
- **Real-time coding hints** during the consultation (AI-006) so documentation supports the codes.
- **Multilingual live interpretation** for clinician–patient language mismatch (high value in a referral hospital,
  high risk — requires its own safety evaluation and probably a human interpreter fallback).
- **Voice biometric speaker verification** for clinician identification at shared workstations (replacing the
  clinician-channel assumption in diarisation).
- **Aosta-style "just speak" full-workflow voice** (market: Aosta BackBone "ava — Doctors just speak, ava handles the
  rest") — we deliberately implement it as _speak-then-confirm_ rather than _speak-and-commit_.
- **Sentiment/empathy feedback** for communication-skills training, opt-in per clinician and never management-visible.

## 16. Open Questions for the Hospital

1. Is ambient recording of consultations acceptable to the medical staff and the ethics committee at all? If yes, in
   which departments, and which are excluded (psychiatry, counselling, MLC, paediatrics, gynaecology)?
2. Who drafts and approves the patient consent script, in which languages, and is it captured on a room tablet, a
   kiosk or the patient's phone?
3. What is the maximum audio retention the hospital's legal and privacy teams will accept — delete on signature
   (recommended default), 24 hours, or longer with a stated purpose?
4. Must all audio processing stay on-premises? If yes, is there budget for a GPU node, and does the hospital accept
   the measured accuracy difference per language?
5. Which languages must be supported at go-live, and can the hospital provide 20–30 hours of consented, de-identified
   local audio to measure real WER before enablement?
6. Which clinicians will pilot, and do they have dictation microphones/headsets/foot pedals, or must these be procured?
7. For radiology: which templates and macros exist today, and is a foot pedal workflow expected?
8. Should voice commands be enabled at all, or is dictation-only the safer starting scope for phase 1?
9. Who audits transcript-vs-signed-note divergence and how often (MRD? Quality?), and what divergence would trigger
   pulling the feature?
10. Is the clinician-level opt-out and the no-management-visibility rule for adoption metrics acceptable, and who
    guarantees it?
11. Do consultation rooms have adequate acoustics and network, and is a room mic array budgeted, or is a headset the
    assumption?
12. Should the patient receive a copy of the AI-generated visit summary, and who approves that text before sending?
