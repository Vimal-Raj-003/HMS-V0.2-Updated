# EN-016 — E-Sign / Digital Signature (Aadhaar eSign via ESP, DSC/USB Token PKCS#11, PKCS#7 Detached Signatures, PDF LTV, Document Hash Chain, Timestamping, Verification Portal)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Module ID       | EN-016                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Phase           | 5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Priority        | P2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Complexity      | Medium–High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Depends on      | EN-028 (Consent Management — the largest consumer), EN-024 (audit trail & hash chain infrastructure), EN-039 (Forms & Template Builder — document rendering/letterheads), EN-007 (users, signature images, professional registration, step-up auth), EN-013 (verification QR on printed documents), EN-005 (printing), EN-017 (ESP/CA connector adapters, retries, DLQ), EN-009/EN-032 (OTP delivery for eSign journeys), OP-002/IP-002/OP-004/OP-008 (clinical documents to sign), IP-006 (op notes, consent), OP-005/NC-009 (invoices, vouchers), NC-005 (POs), NC-010 (HR letters), EN-011 (ABDM FHIR bundle signing), EN-026 (verification API exposure)                                                                         |
| Feature flag    | `module.esign.enabled` (sub: `esign.aadhaar`, `esign.dsc`, `esign.otp_signature`, `esign.biometric_capture`, `esign.ltv_timestamp`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Primary roles   | Doctor (6/7/9 — sign clinical documents), Pathologist (13)/Radiologist (12) — sign reports, Hospital Admin (2 — sign policies/letters), Accountant (46 — sign invoices/vouchers), Patient (59 — sign consents)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Secondary roles | Nurse (witness signature), MRD Officer (43 — verify completeness), Legal/Compliance (NC-023), Auditor (58 — verify signatures), IT Admin (56 — ESP/DSC configuration)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Regulatory      | **IT Act 2000 §3 (digital signature), §3A (electronic signature), §5 (legal recognition), §35 (DSC issuance) & Second Schedule (Aadhaar eKYC eSign)**; CCA India (Controller of Certifying Authorities) — eSign API v2.1/v3.1 through licensed ESPs (e.g. NSDL, eMudhra, C-DAC, Protean); X.509 Class 2/3 DSC on FIPS 140-2 Level 2 crypto tokens; RFC 5652 (CMS/PKCS#7), RFC 3161 (TSA timestamping), PAdES B-LT/B-LTA for PDFs; UIDAI Aadhaar Act §8 (consent for authentication, no biometric storage); DPDP Act 2023 & Rules 2025; NABH MOM/IMS (authenticated clinical records); MCI/NMC Telemedicine Practice Guidelines 2020 (signed prescriptions); GST rules (digitally signed e-invoices); Companies Act (signed vouchers) |

## 1. Purpose

EN-016 provides one signing service for every document the hospital must authenticate: clinician sign-off on clinical documents, patient/guardian signatures on consent forms (EN-028), administrative and financial signatures on invoices, POs and HR letters. It supports three legally distinct mechanisms — **Aadhaar eSign** (OTP/biometric via a licensed ESP, IT Act §3A), **DSC** (Class 3 X.509 certificate on a USB crypto token, IT Act §3), and **captured/electronic signature** (drawn signature, PIN, or OTP acknowledgement — evidentiary, not a "digital signature") — and records every signature with a hash chain, RFC 3161 timestamp and a public verification portal so any printed or shared copy can be proven authentic.

## 2. Users & Jobs-to-be-done

- **Doctor / Radiologist / Pathologist** (desktop/tablet): sign discharge summaries, op notes, lab/radiology reports, prescriptions — usually in bulk at end of session; needs 2-click signing with step-up PIN and a visible signature block on the PDF.
- **Patient / Guardian** (tablet at bedside, kiosk, or own phone): sign consent forms with Aadhaar OTP eSign or a drawn signature captured on a signature pad/touchscreen after reading the form in their language.
- **Witness / Nurse**: co-sign consent (thumb-impression cases, illiterate patients, telephonic consent).
- **Accountant / Purchase Officer**: DSC-sign GST invoices, POs, statutory filings.
- **Hospital Admin / Medical Superintendent**: sign policies, medico-legal replies, court report covering letters (TR-008).
- **Auditor / external verifier**: scan the verification QR or paste a document id → see who signed, when, with which mechanism, and whether the file is unaltered.
- **IT Admin**: configure ESP credentials, register DSC tokens to users, monitor signing failures and certificate expiry.

## 3. Core Workflows

### 3.1 Signature request lifecycle (common envelope)

1. **Any module** calls `Esign.request({documentId, version, signers[], purpose, mechanismPolicy, dueAt, sequence})` → System renders the final PDF (EN-039), computes `sha256`, creates a `sign_envelope` with one `sign_request` per signer (role, order, required mechanism, signature-field coordinates) → status `pending` → Event `esign.envelope.created`.
2. **Signer notified** (in-app task EN-037, SMS/WhatsApp link for patients EN-009 with a tokenised short-lived URL).
3. **Signer opens** the document → mandatory scroll-to-end (configurable) / read-aloud playback for patients (EN-028) → declares intent ("I have read and understood") → chooses/receives the allowed mechanism.
4. **Signature applied** (see 3.2–3.4) → detached PKCS#7 stored, PDF stamped with the visible signature appearance (name, designation, registration no, mechanism, timestamp, verification QR), document version marked `signed`, hash chained to the previous signature → Event `esign.document.signed`.
5. **Envelope completion**: when all required signers have signed → envelope `completed` → callback to the originating module (`esign.envelope.completed`) → the module finalises (e.g. EN-028 activates the consent, OP-004 releases the report, NC-005 issues the PO).
6. **Exceptions**: decline (reason captured → `esign.request.declined`), expiry (`dueAt` passed → `expired`, re-issue allowed), void/cancel by originator before completion, **amendment** (signed document cannot be edited — a new version is created and re-signed with `supersedes` link).

### 3.2 Aadhaar eSign (ESP, `esign.aadhaar`)

1. Signer chooses Aadhaar eSign → System shows the **UIDAI-mandated consent text** (multilingual) and captures explicit consent → builds an **eSign XML request** containing the document hash (SHA-256, never the document), ASP id (hospital), transaction id, response URL, signature type (`pkcs7` detached), auth mode (`OTP` or `Biometric FP/IRIS`) → signs the request with the ASP's own DSC → redirects the signer to the ESP gateway.
2. Signer enters Aadhaar / VID + OTP on the **ESP's** page (never on ours) → ESP performs eKYC with UIDAI, generates a one-time key pair + certificate in the signer's name, signs the hash → returns a **PKCS#7 signature blob + eKYC name/masked Aadhaar (last 4) + response code** to our callback.
3. System verifies the ESP response signature, embeds the PKCS#7 into the PDF (or stores it detached for non-PDF payloads), applies an **RFC 3161 timestamp**, and records `esp_txn_id`, `certificate_serial`, `auth_mode`, `esign_response_code`.
4. **VID/consent rules**: we store only the **masked Aadhaar (XXXX XXXX 1234)** and the eKYC name — never the full number, never the biometric, never the OTP. Aadhaar is never a mandatory route: an alternative mechanism must always be offered.
5. Failure/timeouts (ESP down, OTP mismatch, Aadhaar not linked to mobile) → retry ≤ 3, then automatic fallback to the next allowed mechanism per policy; every attempt logged.

### 3.3 DSC / USB crypto token (`esign.dsc`)

1. Signer's Class 3 DSC is registered once: IT Admin records holder, CA, certificate serial, subject DN, validity, thumbprint, key usage → `sign_certificates`; expiry alerts at 60/30/7 days.
2. Signing happens **client-side**: a small signed desktop helper (the same agent family as the EN-005 print agent) or a browser flow using PKCS#11/WebCrypto talks to the token. Server sends only the **hash to be signed**; the private key never leaves the token (FIPS 140-2 L2).
3. Helper returns the PKCS#7/CAdES signature → server validates: chain to a CCA-licensed root, **CRL/OCSP revocation check**, certificate validity at signing time, subject DN matches the registered holder → embeds into PDF as a **PAdES B-LT** signature (DSS with OCSP/CRL) and adds a TSA timestamp (B-LTA) for long-term validity.
4. Bulk signing: a doctor/accountant selects N documents → one token PIN prompt → sequential hash signing with a progress bar; partial failures leave the rest unsigned and reportable.
5. Server-held **HSM/soft-token signing** is supported only for _organisational_ signatures (e.g. GST e-invoice, ABDM bundle signing) with keys in Vault/HSM and dual-control activation — never for a personal clinician signature.

### 3.4 Electronic (captured) signature — `esign.otp_signature`

- **Drawn signature**: signature pad (Wacom/Topaz) or touchscreen canvas → SVG/PNG stroke data + pressure/timing metadata + device id captured, plus the signer's identity assertion (staff session or patient OTP/UHID verification) → the _document hash + signature image + metadata_ are sealed with the **hospital's organisational key** (server-side), producing a tamper-evident evidence package.
- **OTP acknowledgement**: patient receives OTP on the registered mobile → entering it constitutes the electronic signature; evidence stores mobile (masked), OTP challenge id, timestamp, IP/device.
- **Thumb impression**: captured image + witness signature (mandatory) for illiterate signers; text is read aloud (EN-028 read-aloud) and the witness attests that it was read.
- These are **§3A-adjacent evidentiary signatures**, not "digital signatures" under §3; the system labels them exactly as such on the document and in the verification portal so legal weight is never overstated.

### 3.5 Document hash chain & tamper evidence

- Every signed document version stores `sha256`, `prev_sha256` (previous version of the same document), `chain_seq`, and the signature blobs. A nightly job re-computes hashes for a sample plus all documents signed that day, verifies chain continuity and signature validity, and writes a `sign_integrity_runs` row; any mismatch raises a P1 security incident (EN-023) and blocks further signing on that document.
- Signed PDFs are stored immutably (S3 object-lock / WORM bucket where available); re-rendering is never allowed — the exact signed byte stream is what is served and printed.

### 3.6 Verification portal

- Every signed PDF carries a **verification QR** (EN-013) and a human-readable code → public URL `/verify/<code>` (no login) shows: document type (not content), hospital, signer name(s) + designation + registration no, mechanism (Aadhaar eSign / DSC Class 3 / Electronic), signing timestamp (with TSA), certificate serial & CA, current validity (`valid` / `revoked-certificate` / `hash-mismatch`), and a "file check" upload box where a copy can be uploaded to confirm byte-identity.
- **No PHI** is displayed; content is only shown to authenticated users with rights, or to a patient logging in with OTP.

### 3.7 Exceptions

- Certificate expired/revoked at signing → hard block with message; already-signed documents remain valid because of the TSA timestamp (LTV).
- ESP outage → queue with retry and fallback mechanism; if a consent is clinically urgent, EN-028's emergency/implied-consent path applies instead (never silently downgrade).
- Signer unavailable (doctor on leave) → delegate/co-sign rules from the originating module (e.g. a co-signing consultant) — EN-016 only enforces that the delegate is authorised.
- Lost/damaged token → revoke registration, re-register new certificate; previously signed documents unaffected.

## 4. Data Model (schema `core`, prefix `sign_`)

- `sign_policies` — id, hospital_id, document_type (enum/lookup: consent_general, consent_surgery, consent_anaesthesia, blood_transfusion, hiv_test, discharge_summary, op_note, lab_report, rad_report, prescription, invoice, purchase_order, hr_letter, mlc_report, policy_doc, abdm_bundle), allowed_mechanisms text[] (aadhaar_esign/dsc/electronic_drawn/electronic_otp/thumb_impression), preferred_mechanism, requires_witness bool, requires_timestamp bool, requires_ltv bool, min_signers, sequence enum(parallel/serial), expiry_hours, read_confirm_required bool, effective_from, version.
- `sign_envelopes` — id, hospital_id, branch_id, document_id (clinical.documents / billing / hr ref), document_type, document_version, sha256, render_file_id, purpose, status enum(pending/partially_signed/completed/declined/expired/voided), sequence, due_at, created_by, module, ref_type/ref_id, patient_id?, completed_at, created_at; index (hospital_id, status, due_at), (document_id).
- `sign_requests` — id, envelope_id, hospital_id, signer_type enum(staff/patient/guardian/witness/external), signer_user_id?, signer_patient_id?, signer_name, signer_role, signer_designation, registration_no?, order_no, mechanism_required, mechanism_used, status enum(pending/sent/opened/signed/declined/expired), sent_at, opened_at, signed_at, decline_reason, token_hash (for external link), ip, user_agent, device_id, geo?, notified_channels jsonb.
- `sign_signatures` — id, sign_request_id, hospital_id, mechanism, pkcs7 bytea (or file_id), signature_format enum(pkcs7_detached/pades_b_lt/pades_b_lta/evidence_package), signed_hash, hash_algo default 'SHA-256', certificate_id?, esp_txn_id?, esp_response_code?, auth_mode enum(otp/fp/iris/na)?, aadhaar_masked?, ekyc_name?, tsa_token bytea?, tsa_authority, signed_at timestamptz, appearance jsonb (page, x, y, w, h, text), image_file_id? (drawn signature), stroke_metadata jsonb?, witness_signature_id?, verification_code citext UNIQUE, created_at.
- `sign_certificates` — id, hospital_id, user_id?, org_level bool, subject_dn, issuer_dn, serial_no, thumbprint_sha256, ca_name, class enum(class2/class3/org), valid_from, valid_to, key_usage jsonb, token_model, registered_by, status enum(active/expired/revoked/suspended), revoked_at, revocation_reason, last_ocsp_check_at, last_ocsp_status.
- `sign_esp_configs` — id, hospital_id, esp_name, asp_id, endpoint_url, api_version, asp_cert_ref (Vault), callback_url, environment enum(sandbox/production), rate_limit, active, health jsonb.
- `sign_attempts` — id, sign_request_id, mechanism, outcome enum(success/otp_failed/esp_error/cert_invalid/revoked/timeout/user_cancelled/token_absent), error_code, error_text, at; index (sign_request_id, at).
- `sign_integrity_runs` — id, hospital_id, run_at, scope, documents_checked, mismatches int, revoked_certs int, details jsonb, status.
- `sign_document_chain` — document_id, version, sha256, prev_sha256, chain_seq, signed_at; UNIQUE(document_id, version).
- Retention: signatures, certificates and evidence packages retained for the life of the record + statutory period (clinical 8 years / MLC & minors longer per NC-003; financial 8 years); **never** purged while the parent record exists.

## 5. Business Rules & Validations

- Signing is always over a **hash**; the document bytes never leave the hospital boundary for Aadhaar eSign, and the private key never leaves the token for DSC.
- A finalised, signed document is immutable. Any correction produces a new version with `amendment_reason` and requires re-signing; the superseded version stays retrievable and is marked "Superseded on <date>" on print.
- Mechanism legality labelling is mandatory: PDFs and the verification page state exactly `Digital Signature (DSC, IT Act §3)`, `Aadhaar eSign (IT Act §3A)`, or `Electronic signature — captured (evidentiary)`.
- Certificate must be valid **at signing time**, chain to a CCA-licensed root, and pass OCSP/CRL (cached ≤ 6 h); an RFC 3161 timestamp is mandatory for all §3/§3A signatures so validity survives certificate expiry (LTV).
- Aadhaar route: explicit UIDAI consent text shown and stored; full Aadhaar number and biometrics are never stored or logged; an alternative mechanism must always be offered (no Aadhaar compulsion).
- Serial envelopes enforce order; a later signer cannot sign before the earlier one. Witness signature must be captured in the same session as a thumb impression (max 10-minute gap) and the witness cannot be the treating clinician for consent documents.
- Step-up authentication (EN-007) is required before any staff signature: PIN/TOTP/passkey re-auth within 5 minutes.
- Bulk signing caps at 100 documents per token PIN entry; each document gets its own signature and audit entry.
- Verification codes are 12-character base32 (no ambiguous characters), unguessable, rate-limited (10 lookups/min/IP), and reveal no PHI.
- Organisational (server/HSM) keys can sign only document types marked `org_level=true` (e-invoice, ABDM bundle, hospital policy) and require dual control to activate.
- Declines and expiries never delete the envelope; they are terminal states with reasons retained for audit.

## 6. API Surface (`/api/v1/esign`)

| Method         | Path                                                                                                   | Purpose                          | Permission                              | Notes                       |
| -------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------- | --------------------------------------- | --------------------------- |
| GET/POST/PATCH | /policies ; /policies/:id                                                                              | per-document-type signing policy | `esign.policy.configure`                | versioned                   |
| POST           | /envelopes                                                                                             | create signing envelope          | `esign.envelope.create` (module-scoped) | Idempotency-Key             |
| GET            | /envelopes?status&type&signer&from&to ; GET /envelopes/:id                                             | list/detail                      | `esign.envelope.read`                   | cursor                      |
| POST           | /envelopes/:id/void ; /remind ; /extend                                                                | envelope admin                   | `esign.envelope.manage`                 | reason                      |
| GET            | /requests/mine                                                                                         | my pending signatures            | `esign.sign`                            | doctor sign-queue           |
| POST           | /requests/:id/open                                                                                     | mark opened, fetch render URL    | `esign.sign` / token link               | presigned, short TTL        |
| POST           | /requests/:id/decline                                                                                  | decline with reason              | `esign.sign`                            |                             |
| POST           | /requests/:id/aadhaar/initiate ; POST /esp/callback                                                    | Aadhaar eSign journey            | `esign.sign` / ESP-signed callback      | callback signature-verified |
| POST           | /requests/:id/dsc/challenge ; POST /requests/:id/dsc/complete                                          | DSC hash-sign exchange           | `esign.sign`                            | helper agent, device-bound  |
| POST           | /requests/:id/electronic                                                                               | drawn/OTP/thumb signature submit | `esign.sign`                            | image ≤ 200 KB              |
| POST           | /bulk-sign                                                                                             | sign N documents (DSC/PIN)       | `esign.sign.bulk`                       | max 100, per-doc results    |
| GET/POST/PATCH | /certificates ; /certificates/:id/revoke ; POST /certificates/:id/ocsp-check                           | DSC registry                     | `esign.certificate.manage` (IT Admin)   | expiry alerts               |
| GET/PUT        | /esp-configs ; POST /esp-configs/:id/test                                                              | ESP setup                        | `esign.config.manage`                   | secrets masked              |
| GET            | /verify/:code (public) ; POST /verify/upload                                                           | public verification              | public, rate-limited                    | no PHI                      |
| GET            | /documents/:id/signatures ; GET /documents/:id/verify                                                  | signature detail & validity      | `esign.verify.read`                     |                             |
| GET            | /integrity/runs ; POST /integrity/run                                                                  | hash-chain check                 | `esign.integrity.run` (IT/Auditor)      |                             |
| GET            | /reports/pending-signatures ; /reports/mechanism-mix ; /reports/certificate-expiry ; /reports/failures | reports                          | `esign.report.read`                     |                             |

## 7. Domain Events (outbox)

- `esign.envelope.created|completed|voided|expired` → originating module callback (EN-028 consent activation, OP-004 report release, NC-005 PO issue, IP-002 discharge finalisation).
- `esign.document.signed` → EN-024 audit, EN-013 (verification QR), EN-011 (signed FHIR bundle push), EN-009 (patient copy link).
- `esign.request.declined` → originating module + EN-037 to the requester.
- `esign.signature.failed` (with mechanism + error code) → EN-037 to signer + IT, EN-023 if repeated.
- `esign.certificate.expiring|expired|revoked` → IT Admin, affected user, blocks new signing.
- `esign.integrity.mismatch` → EN-023 security incident (P1), Privacy Officer, blocks the document.
- Consumes: `document.finalised` (from clinical/billing modules), `consent.form.rendered` (EN-028), `hr.employee.exited` (revoke certificate registration).

## 8. Screens (UI)

- **My Sign Queue** (desktop/tablet — doctors, accountants): grouped by document type with counts, preview pane, "Sign all" with step-up PIN, per-document decline; shortcuts `J/K` navigate, `S` sign, `D` decline, `Ctrl+Enter` bulk sign. Real-time: queue count badge updates via WS.
- **Patient Signing View** (tablet at bedside / kiosk / patient phone): full-screen document in the patient's language with font-size control and read-aloud button, scroll-progress bar with "Sign" disabled until the end is reached, mechanism chooser (Aadhaar eSign / draw signature / OTP), large signature canvas with "Clear/Redo", witness panel; offline: signature captured locally in an encrypted queue and submitted on reconnect (evidence records the offline capture time and device).
- **DSC Helper Prompt** (desktop): token detection, certificate selection, PIN entry, progress for bulk signing, clear errors ("token not detected", "PIN blocked", "certificate expired on <date>").
- **Signature Configuration** (desktop, IT/Admin): per-document-type policy matrix, ESP credentials (masked), TSA endpoint, certificate registry with expiry chips, test signing sandbox.
- **Verification Portal** (public, phone-friendly): code entry / QR landing → verdict card (green valid / amber certificate-expired-but-timestamped / red tampered), signer table, "upload a copy to compare" box, print-friendly.
- **Document Signature Panel** (embedded in any document viewer): who signed, when, mechanism badges, chain status, "download signed PDF", "verify now".
- Empty/error states: "No documents awaiting your signature", "ESP temporarily unavailable — you can sign with <alternative>", "This document was superseded on <date> — view current version".

## 9. Integrations

- **ESP (Aadhaar eSign)**: NSDL / eMudhra / C-DAC / Protean eSign API v2.1/v3.1 over HTTPS with ASP-signed XML requests, sandbox + production environments, per-hospital ASP id; adapter lives in EN-017 with retry/DLQ.
- **CA / DSC**: X.509 Class 3 tokens (ePass2003, mToken, SafeNet) via PKCS#11 through a signed desktop helper; OCSP/CRL endpoints of Indian CAs.
- **TSA**: RFC 3161 timestamping authority (CCA-recognised or eMudhra/DigiCert) — configurable, with a local fallback that queues documents for timestamping if the TSA is unreachable.
- **PDF engine**: Playwright render (EN-039) + PDF signing library supporting PAdES B-LT/B-LTA and incremental updates (signature never re-flows the document).
- **HSM/Vault** for organisational keys (GST e-invoice IRN signing, ABDM bundle signing per EN-011, ABHA-linked care-context signing).
- Consumers: EN-028 (consents), OP-004/OP-008 (report sign-off), IP-002/IP-006 (discharge & op notes), NC-005/NC-009 (POs, vouchers, e-invoices), NC-010 (offer/relieving letters), TR-008 (MLC/court documents).

## 10. Reports & Analytics

- Pending-signature ageing per doctor/department (documents unsigned > 24/48/72 h — an NABH MRD deficiency indicator feeding NC-003), signature turnaround time, mechanism mix (Aadhaar vs DSC vs electronic), eSign success/failure rates by ESP and error code, certificate expiry calendar, integrity-run results, verification-portal lookup volume, declined-signature log with reasons. MV `analytics.mv_esign_daily`.

## 11. Notifications

- Signer: "3 documents awaiting your signature" digest (configurable time), urgent single-document push, OTP for patient eSign, "your signed copy is ready" link to patient.
- IT Admin: ESP failure spike, certificate expiring in 60/30/7 days, TSA unreachable, integrity mismatch.
- Originating module owner: envelope completed / declined / expired.
- MRD/HOD: weekly unsigned-document deficiency list.

## 12. Permissions (RBAC keys)

`esign.policy.configure` (Hospital Admin, Legal) · `esign.envelope.create` (modules + Doctor, MRD, Purchase, HR, Billing) · `esign.envelope.read` (originator, Admin, Auditor) · `esign.envelope.manage` (Admin — void/remind/extend) · `esign.sign` (any user who is a designated signer; patients via OTP-scoped token) · `esign.sign.bulk` (Doctor, Radiologist, Pathologist, Accountant) · `esign.certificate.manage` (IT Admin) · `esign.config.manage` (IT Admin + Hospital Admin dual control) · `esign.verify.read` (staff; public portal is unauthenticated but PHI-free) · `esign.integrity.run` (IT Admin, Auditor) · `esign.report.read` (Admin, MRD, Auditor).

## 13. Non-functional

- 2000-bed enterprise: ~4000 signature operations/day (2500 clinical report/summary signatures, 1200 consents, 300 financial). Hash-and-sign p95 < 400 ms server-side; Aadhaar eSign round trip depends on ESP (target < 20 s end-to-end); bulk sign of 50 documents < 60 s.
- Signed artefacts stored in WORM/object-lock storage; signature blobs ≤ 30 KB each; PDFs never re-generated after signing.
- Availability: signing must degrade gracefully — if ESP/TSA are down, DSC and electronic paths continue and timestamping is queued (documents marked `timestamp_pending`, resolved within 24 h).
- Security: no private keys server-side except HSM/Vault org keys under dual control; all ESP traffic mTLS where supported; callbacks verified by signature and replay-protected (nonce + 5-min window); no Aadhaar number, OTP or biometric ever written to logs.
- Accessibility: WCAG 2.2 AA signing screens; signature canvas usable with a stylus or finger; read-aloud in `en, hi, ta, te, ml, kn, mr, bn`; high-contrast document viewer; minimum 16 pt body text for patient-facing consents.

## 14. Acceptance Criteria

1. Given a discharge summary is finalised, when the envelope is created for the treating consultant, then it appears in the consultant's sign queue within 5 seconds and the summary cannot be released until signed.
2. Given a doctor signs with a registered Class 3 DSC, when signing completes, then the PDF contains a PAdES B-LT signature with an RFC 3161 timestamp, and the verification portal reports `valid` with the correct certificate serial and CA.
3. Given a DSC certificate expired yesterday, when the doctor attempts to sign, then signing is blocked with "certificate expired on <date>" and no partial signature is stored.
4. Given a document signed 3 years ago with a now-expired certificate, when it is verified today, then the portal reports `valid at time of signing` using the embedded timestamp, not `invalid`.
5. Given a patient chooses Aadhaar eSign, when the ESP returns the PKCS#7, then only the masked Aadhaar (last 4) and eKYC name are stored, no full Aadhaar number or biometric appears anywhere in the database or logs, and the UIDAI consent text shown is retained with the signature.
6. Given the ESP is unreachable, when the patient attempts Aadhaar eSign, then after 3 retries the system offers the configured fallback mechanism, the attempt log records `esp_error`, and the consent is not silently downgraded without the patient re-confirming.
7. Given a signed consent PDF, when a single byte is altered outside the system and the file is uploaded to the verification portal, then the portal reports `hash-mismatch / not authentic`.
8. Given a serial envelope with surgeon → anaesthetist → patient, when the anaesthetist attempts to sign before the surgeon, then the action is rejected with "waiting for previous signer".
9. Given an illiterate patient signs with a thumb impression, when the signature is submitted without a witness signature captured within 10 minutes, then the envelope stays incomplete and the UI blocks completion.
10. Given a doctor bulk-signs 50 lab reports, when one report's document hash no longer matches its stored version, then that report is skipped with an explicit error while the other 49 are signed successfully.
11. Given a staff member attempts to sign without a step-up re-authentication in the last 5 minutes, when they press Sign, then a PIN/TOTP prompt appears before any signature is created.
12. Given the nightly integrity run detects a broken hash chain, when the run completes, then a P1 security incident is raised in EN-023, the Privacy Officer is notified, and further signing on that document is blocked.
13. Given a signed document is amended, when the new version is created, then the old version remains retrievable, is marked superseded on print, and a new signing envelope is required for the new version.
14. Given a verification code is looked up 20 times in a minute from one IP, when the 11th request arrives, then it is rate-limited, and no request ever discloses patient identity or clinical content.

## 15. Enhancements / Later phases

- DigiLocker issuance of signed discharge summaries, certificates and reports directly to the patient's locker.
- ABDM-signed FHIR bundles and care-context linking signature (EN-011), and NDHM-compliant document provenance.
- Remote signing (server-held keys with SCA under CCA's "remote signing" model) so doctors can sign from mobile without a physical token.
- Video consent recording attached as a signature evidence artefact (market — SmartHospital India) for high-risk procedures.
- Long-term archival service (PAdES B-LTA re-timestamping every 5 years) to keep decades-old records verifiable.
- Blockchain/notary anchoring of the daily document hash-chain root for external tamper proof (source enhancement: "blockchain audit trail for consent").
- e-Stamping integration for agreements requiring stamp duty; eSign for corporate/TPA contracts through the vendor portal.
- Biometric (fingerprint) Aadhaar eSign at the bedside using a registered device (EN-020) for patients without a linked mobile.
- Signature-appearance designer (position, logo, QR size) per document type in EN-039.

## 16. Open Questions for the Hospital

1. Which licensed ESP is preferred for Aadhaar eSign (NSDL / eMudhra / C-DAC / Protean), and does the hospital already hold an ASP registration and ASP DSC?
2. How many Class 3 DSC tokens exist today, for whom (doctors, accounts, authorised signatory), and which CA issued them?
3. Is a physical USB token acceptable at clinical workstations, or must clinicians sign from tablets/mobile (which requires remote signing or eSign)?
4. Which document types legally require a §3/§3A signature at this hospital versus an evidentiary electronic signature (state medico-legal advice)?
5. Preferred TSA (timestamping authority) and whether long-term validity (LTV/archival re-timestamping) is required.
6. Consent forms: is Aadhaar eSign acceptable to the hospital's legal counsel for patient consents, or should drawn signature + witness remain the default?
7. Who is authorised to hold the organisational signing key (GST e-invoice, ABDM), and what dual-control process is acceptable?
8. Turnaround SLA for clinician signatures (24 h? 48 h?) and the escalation path for unsigned documents (feeds MRD deficiency reporting).
9. Should the verification portal be publicly reachable from the internet, or restricted to the hospital network / patient-portal login?
10. Retention and archival storage location for signed artefacts (on-prem WORM vs S3 object-lock) and who audits the integrity runs.
