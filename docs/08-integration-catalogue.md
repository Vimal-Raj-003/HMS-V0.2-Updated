# 08 — Integration Catalogue

> Every external system Vim's HMS talks to, in one place. **All of them run through `services/integration-hub`
> (EN-017)** — no module opens its own socket, holds its own credentials, or writes its own retry loop.
> Read with: EN-017 (hub, DLQ, mapping DSL), EN-019 (HL7/FHIR semantics), EN-026 (inbound API gateway),
> `04-security-compliance.md` (DPDP data-flow register, PHI redaction), `12-module-index.md` (module IDs).

---

## 0. How to read the catalogue

**Retry policy classes** (configured per connector operation, EN-017 §3.2):
| Code | Policy |
|---|---|
| **R0** | No retry. Non-idempotent operation without partner idempotency support → single attempt, then DLQ for a human decision. |
| **R1** | Hub default: 5 attempts, `5 s → 10 s → 40 s → 3 min → 15 min` with jitter; retry only on network/5xx/429/timeout. |
| **R2** | Long-horizon: 8 attempts over 24 h (`5 m, 15 m, 1 h, 3 h, 6 h, 12 h, 24 h`) for government/payer endpoints with maintenance windows. |
| **R3** | Persistent listener reconnect loop: backoff 1 s → 60 s cap, forever; connection-state events; no message loss (peer buffers). |
| **R4** | Scheduled: next cron run with a watermark overlap window; manual back-fill by date range available. |
| **R5** | Local buffering: the device/agent buffers on-site and drains in order at a rate cap on restore. |

**Test strategy classes:**
| Code | Strategy |
|---|---|
| **T1** | Vendor/government sandbox + contract tests in CI against recorded fixtures. |
| **T2** | Simulator shipped in `packages/testing` (HL7 sender/receiver, ASTM emulator, DICOM SCU/SCP, webhook signer, ESC-POS/ZPL null printer, MQTT publisher). |
| **T3** | Hardware loopback in the lab bench (scanner, label/thermal printer, biometric reader, POS terminal, kiosk). |
| **T4** | Formal external certification before production (ABDM STQC/CERT-In, NHCX, PMJAY, TRAI-DLT, Meta WhatsApp, ISBT/e-RaktKosh). |
| **T5** | Parallel run against the incumbent system for N days with a reconciliation report. |

**Standard go-live checklist (every connector, no exceptions).** Per-connector extras are in the tables.
1. Connector registered in EN-017 with owner, vendor contact and escalation path.
2. Credentials in Vault/SSM (never in `.env` committed, never displayed after save); rotation date recorded.
3. Environment separation proven: sandbox connector retired or paused before production activation.
4. Mapping activated with **all stored samples passing**; value-set/code translations mapped via EN-027.
5. Health check defined (ping/echo or `expect_traffic`) + SLA thresholds + RAG on the EN-017 dashboard.
6. Retry + circuit-breaker + DLQ policy set; DLQ owner named; alert routes to on-call (EN-037).
7. DPDP metadata captured (purpose, data categories, PHI flag, cross-border, DPA reference, retention at processor) and Hospital-Admin approved if PHI-bearing; entry appears in the data-flow register.
8. PHI redaction verified on the searchable message copy; full-payload access gated by `ihub.payload.read`.
9. Idempotency key strategy agreed with the partner (or R0 declared).
10. Firewall/egress change completed (proxy IPs, ports, VPN/leased line); NTP synced (CERT-In).
11. Failure drill executed: partner down, credential expired, malformed payload — each produces the documented fallback and no silent loss.
12. Runbook in `infra/runbooks/` + user-facing degraded-mode message written and localised.

---

## 1. National digital health & government

| System | Protocol · Direction | Trigger | Data | Owner | Failure mode → fallback | Retry · Test |
|---|---|---|---|---|---|---|
| **ABDM M1 — ABHA create/verify, Scan & Share** | REST/JSON over TLS, ABDM V3, out + callback in | Registration desk creates/links ABHA; kiosk/QR scan at OPD | Aadhaar/mobile OTP flow, ABHA number & address, demographic, QR token | **EN-011** | Gateway down → registration continues **without** ABHA, "ABHA pending" chip, retry job; never block registration | R2 · T1→**T4** |
| **ABDM M2 — HIP (care-context linking, data push)** | REST + Fidelius/ECDH encrypted FHIR R4 bundles, out; consent notifications in | `visit.consult.completed`, `discharge.completed`, `lab.result.validated`, `rad.report.finalized` | OPConsultRecord, DischargeSummary, DiagnosticReport, Prescription, ImagingStudy, ImmunizationRecord, WellnessRecord, HealthDocumentRecord (NRCeS profiles) | **EN-011** + EN-019 | Link/push failure → queued, care context marked unlinked, daily reconciliation report; clinical record unaffected | R2 · **T4** |
| **ABDM M3 — HIU (consent request, fetch)** | REST + Fidelius, out; data in | Doctor requests external records | Consent artefact, fetched bundles rendered read-only in the timeline | **EN-011** | Fetch fails → "external records unavailable" state, retry; never merges partial data silently | R2 · **T4** |
| **ABDM M4 / NHCX claims** | REST/JSON (FHIR-based claim), bi-directional | `preauth.submitted`, `claim.submitted`; payer responses inbound | Coverage eligibility, pre-auth, claim, payment notice | **RC-001** + EN-002 | Exchange down → fall back to the payer's portal/email channel; claim state `submission_pending` | R2 · **T4** |
| **HFR / HPR registration & sync** | REST, out | Facility/practitioner onboarding; HPR id captured in staff profile | Facility id, department list, practitioner HPR ids | **EN-011** | Manual entry of ids with verification flag | R2 · T1 |
| **e-Hospital / NIC push** | REST or SFTP/XML, out (per NIC spec) | Nightly + on discharge (government hospitals) | Registration, OP/IP census, diagnosis, discharge counts | **EN-017** (adapter) + NC-011 | Batch fails → exception file, manual portal upload path documented | R4 · T1, T5 |
| **CoWIN / U-WIN** | REST, bi-directional | Vaccination recorded; certificate requested | Beneficiary, dose, batch, AEFI, certificate PDF/QR | **OP-013** | Portal down → local record + certificate deferred, retry queue; local immunisation card printable | R2 · T1 |
| **e-RaktKosh (NBTC/SBTC)** | REST/portal upload (state-dependent), out | Donation, component prep, issue, discard, monthly return | Donor (de-identified per rules), bag/component, TTI results, stock, returns | **IP-007** | Portal down → statutory register maintained locally, upload back-filled with date range | R4 · T1, T5 |
| **NOTTO / SOTTO / ROTTO** | REST/portal, bi-directional | Waitlist registration, brain-death declaration, organ allocation, transplant outcome | Recipient/donor registry ids, HLA/ABO, allocation decisions, follow-up | **IP-019** | Portal down → phone/fax statutory process + retro entry, all timestamps flagged | R2 · T1 |
| **PMJAY / Ayushman (NHA TMS + BIS)** | REST/portal, bi-directional | Beneficiary verification at admission; pre-auth; claim; discharge | Beneficiary ID/e-card, package codes, pre-auth, documents, claim, payment | **RC-007** | TMS down → admit under scheme with `verification_pending`, **no cash collected** (no-cash rule enforced), verify within SLA | R2 · **T4** |
| **CGHS / ECHS / ESIC** | Portal/REST/file per scheme, bi-directional | Eligibility check, referral validation, claim submission | Card/referral no., package/rate list, claim pack | **RC-007** | Manual portal submission with claim pack PDF generated by RC-001 | R2 · T1, T5 |
| **State health schemes** (e.g. Aarogyasri, MJPJAY, Chief Minister's funds) | Portal/REST/file, bi-directional | Scheme-specific | Beneficiary, package, pre-auth, claim | **RC-007** | As above; scheme rules are configuration, not code | R2 · T1 |
| **IDSP / notifiable disease reporting** | Portal/file, out | `diagnosis.recorded` with a notifiable code | Case line list (de-identified per state rules) | **NC-015** | Register maintained locally; weekly manual submission | R4 · T1 |
| **SPCB — BMW Form IV & manifests** | Portal/file, out | Daily waste log; annual Form IV | Category-wise quantities, operator manifests, barcode bag ids | **NC-016** | Local register + printed manifests | R4 · T1 |
| **AERB eLORA** | Portal, out (manual-assisted) | Equipment licence, dose records, personnel TLD | Equipment registration, licence dates, QA test records | **NC-023** + NC-020 | Licence tracker alerts; manual portal filing | R4 · T1 |
| **PC-PNDT Form F returns** | Portal/file, out | Every obstetric ultrasound | Form F data, machine & doctor registration, monthly return | **OP-008**/OP-040 | Local Form F register printed and filed; product-level sex-determination block is never bypassable | R4 · T1 |

**Credentials the hospital must provide:** ABDM — HFR facility id, HPR ids, client id/secret, encryption key pair, gateway callback URL allow-listed, STQC/CERT-In audit report. NHCX — participant code, keys. PMJAY — hospital empanelment id, TMS user, digital signature. CGHS/ECHS/ESIC/state — empanelment numbers and portal users. e-RaktKosh/NOTTO — licence/registration numbers and portal users. NIC — e-Hospital instance URL and API key. SPCB/AERB/PNDT — registration numbers and authorised-signatory credentials.

---

## 2. Payers, TPAs & RCM

| System | Protocol · Direction | Trigger | Data | Owner | Failure mode → fallback | Retry · Test |
|---|---|---|---|---|---|---|
| **IRDAI / ROHINI registry** | Reference file/REST, in | Master refresh (quarterly) | ROHINI hospital ids, payer master | **EN-002** | Cached master; stale flag after 120 days | R4 · T1 |
| **TPA portals** (Medi Assist, Paramount, Health India, FHPL, Vidal, MDIndia…) | REST where available, else SFTP/email + RPA-free manual, bi-directional | Pre-auth submit, query response, claim submit, status poll | Pre-auth form, clinical notes, estimates, bills, discharge summary, claim pack | **EN-002**, RC-001, RC-002, RC-004 | Portal down → generated PDF pack + email/manual channel; status poll resumes on watermark | R2/R4 · T1, T5 |
| **Corporate/B2B client portals** | REST/SFTP, out | Monthly invoicing, utilisation reports | Invoice, SOA, employee utilisation (consented) | **NC-012**, PE-006 | Email fallback with signed PDF | R2 · T1 |
| **Payer eligibility (NHCX coverage-eligibility)** | REST, out | Admission/registration with insurance | Coverage check request/response | **RC-001** | Manual card verification; `eligibility_unknown` flag | R2 · T4 |

---

## 3. Payments & POS

| System | Protocol · Direction | Trigger | Data | Owner | Failure mode → fallback | Retry · Test |
|---|---|---|---|---|---|---|
| **Razorpay** (primary) | REST + signed webhooks, bi-directional | Bill payment, payment link, UPI dynamic QR, refund, settlement fetch | Order, payment, refund, settlement, method/VPA/last-4 (**never full card data — we are never in PCI scope**) | **EN-010** | Gateway down → cash/card-POS/cheque path stays open; QR shows "try again"; **never mark a bill paid without a confirmed webhook or a status poll** | R1 (+ status reconcile job) · T1, T5 |
| **PayU / PhonePe / Cashfree / bank PG (HDFC, ICICI)** | REST + webhooks, bi-directional | Same as above (adapter parity) | Same canonical Payment object | **EN-010** | Switch active gateway by config; queued links re-issued | R1 · T1 |
| **Stripe** (international deployments) | REST + webhooks | Same | Same | **EN-010** | Same | R1 · T1 |
| **POS / EDC terminals** (Pine Labs, Ezetap, Razorpay POS, bank EDC) | Cloud API push-to-device or local TCP/USB via print-agent host, bi-directional | Cashier sends amount to the terminal | Amount, invoice ref, txn id, auth code, card last-4 | **EN-010** + NC-001 | Terminal offline → manual card swipe, txn id keyed in with `manual_entry` flag + supervisor approval | R0 (money) · **T3** |
| **UPI dynamic QR** (counters, kiosks, bedside) | REST QR issue + webhook, bi-directional | Bill/advance/kiosk payment | QR payload, txn ref, payer VPA | **EN-010**, EN-034 | Static QR + manual reconciliation (flagged, requires reconciliation before shift close) | R1 · T1, T3 |
| **Bank statement / settlement reconciliation** | SFTP CSV/MT940 or PG settlement API, in | Nightly | Settlement lines, UTR, charges, TDS | **EN-010** → NC-009 | Manual statement upload (EN-036 template) | R4 · T1, T5 |

**Money rules for every payment connector:** idempotency key per user intent (not per retry); no optimistic receipt; webhook signature verified and replay-protected; a payment is posted **once** (`idem:{connector}:{key}`); mismatches go to a reconciliation exception queue, never auto-adjusted; refunds require maker-checker (`04` §3).

---

## 4. Messaging, email, voice

| System | Protocol · Direction | Trigger | Data | Owner | Failure mode → fallback | Retry · Test |
|---|---|---|---|---|---|---|
| **SMS — MSG91 / Gupshup / Kaleyra / Twilio / Exotel** | HTTPS REST (or SMPP), out; DLR webhooks in | Appointment, token, OTP, report ready, bill, follow-up, critical escalation | Mobile no., DLT template id + variables, sender header | **EN-009** | Gateway down → failover to secondary gateway; OTP falls back to voice OTP (EN-033); critical alerts additionally use in-app + TV | R1 · T1, **T4 (DLT)** |
| **TRAI-DLT registration** | Portal (one-time + per template), out | Entity/header/template registration & scrubbing | Principal entity id, header, template ids, category | **EN-009** | Unregistered template = hard block on send (no silent drop, item queued as `template_pending`) | R4 · **T4** |
| **WhatsApp Cloud API** (Meta) or BSP (Gupshup/MSG91/360dialog) | HTTPS REST + webhooks, bi-directional | Rx PDF, report link, appointment, feedback survey, payment link, patient replies | Template name + params, media (presigned, short-lived), 24-h session messages | **EN-009** | Template rejected/quality-throttled → fall back to SMS with a link; media fails → link-only message | R1 · **T4** |
| **Email — SMTP / Amazon SES / SendGrid** | SMTP/REST, out; bounce & complaint webhooks in | Reports, invoices, statements, staff notifications, DSAR responses | Templated HTML + attachments (PHI attachments encrypted/password per policy) | **EN-032** | Provider down → secondary SMTP; hard bounces → suppression list; PHI never sent to an unverified address | R1 · T1 |
| **Web Push / FCM** | Web Push (VAPID) / FCM, out | Critical alerts, tasks, orders, results | Non-PHI payload + deep link only | **EN-037** | Push undelivered → in-app bell + SMS escalation ladder; critical alerts have no error budget | R1 · T2 |
| **IVR / cloud telephony** (Exotel, Knowlarity, Ozonetel, on-prem SIP/Asterisk) | REST + SIP/WebRTC, bi-directional | Inbound patient call, appointment by phone, report status, click-to-call, voice OTP | Call metadata, DTMF inputs, recording (consented), disposition | **EN-033** | Telephony down → call centre falls back to direct lines; recordings buffered locally | R1/R3 · T1, T3 |

---

## 5. Diagnostics — laboratory analyzers

| System | Protocol · Direction | Trigger | Data | Owner | Failure mode → fallback | Retry · Test |
|---|---|---|---|---|---|---|
| **Analyzers — HL7 v2.x over MLLP** (Roche cobas, Abbott Architect/Alinity, Siemens Atellica, Beckman, Mindray, Sysmex XN) | MLLP/TCP (TLS where supported), bi-directional | Order download on sample receipt; result on run completion | ORM^O01/OMG^O19 out; ORU^R01 in; ACK both ways | **EN-004** + EN-019 | Interface down → **manual result entry is always available**; analyzer buffers; backlog replays on recovery with duplicate suppression on MSH-10 | R3 (listener) / R1 (send) · **T2**, T3 |
| **Analyzers — ASTM E1381/E1394 (LIS2-A2)** serial RS-232 or TCP | Serial via Moxa/Digi converter or raw TCP, bi-directional | Host query / order download; result frames | H/P/O/R/C/Q/L records with ENQ-ACK-EOT framing and checksums | **EN-004** | Same as above; serial converter failure raises an NC-028 IT ticket and an NC-020 biomedical breakdown record | R3 · **T2**, T3 |
| **POCT devices** (glucometers, blood gas, HbA1c) | POCT1-A / vendor REST / docking station | Docking or real-time | Patient id, operator id, result, QC | **EN-004** + EN-042 | Manual entry with operator competency check | R5 · T2, T3 |
| **Vendor middleware** (cobas infinity, Sysmex WAM, Abbott ALL, Beckman REMISOL, Data Innovations IM) | Single HL7 endpoint fronting many analyzers | As above | As above | **EN-004** | Treated as one connector; per-analyzer identity carried in MSH-3/OBX-18 | R3 · T2 |
| **Legacy readers (ELISA, semi-auto)** | FTP/SFTP or watched folder, CSV/fixed-width, in | File drop | Result rows keyed by accession | **EN-004** + EN-017 | Parse error → quarantine folder + DLQ item with the raw file preserved | R4 · T2 |

### 5.1 Concrete message examples

**Outbound `ORM^O01` — HMS/LIS → analyzer (order download).** Encoding UTF-8, MLLP framing `<VT> … <FS><CR>`:
```
MSH|^~\&|VIMSHMS|VIMS0001^BLR^L|COBAS8000|LAB01|20260818103215+0530||ORM^O01^ORM_O01|MSG00021547|P|2.5.1|||AL|NE|IND|UNICODE UTF-8
PID|1||0021-45871^^^VIMS^MR~91234567890123^^^ABDM^NI||SHARMA^RAMESH^KUMAR||19810312|M|||12 MG Road^^BENGALURU^KA^560001^IND||^PRN^PH^^91^80^41234567
PV1|1|O|OPD^ROOM3^^VIMS0001||||MED0142^MENON^ARJUN^^^DR^^^NMC|||||||||||OP|OPV2026081800417
ORC|NW|ORD-2026-0000184471|ACC-2026-0000318842||CM||^^^20260818103000^^R||20260818103210|USR0091^KUMAR^ANIL||MED0142^MENON^ARJUN
OBR|1|ORD-2026-0000184471|ACC-2026-0000318842|2160-0^Creatinine [Mass/volume] in Serum or Plasma^LN|||20260818102800||||||Fasting: no|20260818102955|SER^Serum^HL70070|MED0142^MENON^ARJUN|||||||||R
```
`ORC-1 NW` new order · `ORC-2` placer (HMS order no.) · `ORC-3` filler (accession, our numbering series `LAB_ACC`) · `OBR-4` LOINC-coded test from EN-027 · `OBR-27.6 R` routine (`S` = STAT).

**Inbound `ORU^R01` — analyzer → HMS/LIS (result upload with a critical value):**
```
MSH|^~\&|COBAS8000|LAB01|VIMSHMS|VIMS0001^BLR^L|20260818110412+0530||ORU^R01^ORU_R01|A8000-99182|P|2.5.1|||AL|NE
PID|1||0021-45871^^^VIMS^MR||SHARMA^RAMESH^KUMAR||19810312|M
OBR|1|ORD-2026-0000184471|ACC-2026-0000318842|2160-0^Creatinine^LN|||20260818102800|||||||20260818103512|SER|MED0142^MENON^ARJUN||||||20260818110400||CH|F
OBX|1|NM|2160-0^Creatinine^LN|1|2.9|mg/dL^milligram per deciliter^UCUM|0.7-1.3|HH|||F|||20260818110358||LAB01^COBAS8000^1
NTE|1|L|Delta +1.6 mg/dL vs 17-08-2026. Critical — documented call-back required (NABL 112).
OBX|2|NM|33914-3^eGFR MDRD^LN|1|24|mL/min/1.73m2^^UCUM|>=60|L|||F|||20260818110358
```
Handling: `OBX-8 = HH` maps to `--flag-critical-high` and raises `lab.result.critical` → EN-037 must-acknowledge with escalation + documented read-back (OP-004, `04` §7). Our ACK:
```
MSH|^~\&|VIMSHMS|VIMS0001|COBAS8000|LAB01|20260818110413+0530||ACK^R01^ACK|ACK-77120|P|2.5.1
MSA|AA|A8000-99182
```

**ASTM E1394 frames — analyzer → HMS** (each frame `<STX>` seq · text · `<ETX>` · 2-hex checksum · `<CR><LF>`; session `ENQ → ACK → frames → EOT`):
```
<STX>1H|\^&|||SYSMEX^XN-1000^1.7|||||VIMSHMS||P|E1394-97|20260818110000<CR><ETX>C3<CR><LF>
<STX>2P|1||0021-45871||SHARMA^RAMESH^KUMAR||19810312|M<CR><ETX>1F<CR><LF>
<STX>3O|1|ACC-2026-0000318901||^^^CBC|R||20260818104500|||||N||||SER<CR><ETX>2A<CR><LF>
<STX>4R|1|^^^718-7^Haemoglobin^LN|9.4|g/dL|13.0to17.0|L||F||||20260818110000<CR><ETX>0B<CR><LF>
<STX>5L|1|N<CR><ETX>07<CR><LF>
```
Adapter responsibilities: checksum verify + NAK on mismatch, frame-number continuity, `<ETB>` continuation frames for long records, per-analyzer test-code → LOINC mapping (EN-027 concept map), unit conversion via UCUM, unmatched accession → EN-004 error queue (never auto-create a patient).

---

## 6. Imaging — PACS, DICOM, viewer

| Capability | Protocol · Direction | Trigger | Data | Owner | Failure mode → fallback | Retry · Test |
|---|---|---|---|---|---|---|
| **Modality Worklist (MWL)** | DICOM C-FIND on Worklist SOP, in (modality queries us) | Radiology order placed (`order.rad.created`) | Accession, patient id/name/DOB/sex, procedure code, scheduled AE/station, requesting physician | **EN-008** + OP-008 | MWL down → technologist enters patient manually; accession printed on the requisition barcode to avoid typos | R3 · **T2**, T3 |
| **Image storage** | DICOM **C-STORE** to Orthanc SCP (DICOM TLS where supported), in | Modality sends the study | Full study instances | **EN-008** | Modality buffers locally; storage-commit not acknowledged until written; disk-full alarms page IT | R3/R5 · T2 |
| **Query/Retrieve (priors)** | **C-FIND / C-MOVE / C-GET**, out | Radiologist opens a study; prior-fetch rule | Study/series/instance metadata, prior images | **EN-008** | Prior unavailable → viewer shows "priors not retrieved", reporting continues | R1 · T2 |
| **MPPS** | DICOM N-CREATE / N-SET, in | Exam start/complete on the modality | Performed procedure status, start/end, dose fields | **EN-008** → OP-008 status | Status derived from C-STORE arrival instead | R3 · T2 |
| **DICOMweb** | **WADO-RS / QIDO-RS / STOW-RS** over HTTPS, bi-directional | OHIF viewer, mobile view, AI vendor, tele-radiology, share link | Instances, metadata, thumbnails | **EN-008** | Viewer degrades to JPEG thumbnails + report text; share links expire ≤ 7 days | R1 · T2 |
| **Orthanc archive & OHIF viewer** | REST/Lua plugins (PostgreSQL, S3, DICOMweb, Transfers) | Continuous | Study index, tiering to S3 | **EN-008** | S3 unreachable → hot tier only, tiering job retries; never delete before a verified copy exists | R1 · T2 |
| **Radiation dose (RDSR)** | DICOM SR object, in | After CT/IR exam | DLP/CTDIvol, DRL comparison | **OP-008** + NC-020 | OCR of dose screen capture as fallback (flagged low-confidence) | R3 · T2 |
| **CD/DVD burn & patient share** | Local burn-station agent (PDI export) / signed share link | Patient request | Study + viewer + report | **EN-008** | Share link via WhatsApp/email; burn station offline → USB export with audit | R0 · T3 |
| **Tele-radiology / AI vendor** | DICOMweb or vendor REST, out | Study routed by rule | De-identified or identified per contract (DPDP cross-border check) | **EN-008**, AI-007 | Route to the in-house queue; SLA timer visible on the worklist | R1 · T1 |

**AE titles/ports to collect from the hospital:** for each modality — AE title, IP, port, supported SOP classes, transfer syntaxes, TLS support, MWL support (and query keys it sends), MPPS support. Ours: `VIMS_PACS` (C-STORE 4242), `VIMS_MWL` (11112), `VIMS_SCU` (Q/R), DICOMweb base `/dicom-web`.

---

## 7. Devices, printers, hardware

| System | Protocol · Direction | Trigger | Data | Owner | Failure mode → fallback | Retry · Test |
|---|---|---|---|---|---|---|
| **Barcode/QR scanners** (USB HID wedge, Bluetooth, PWA camera) | Keyboard-wedge / BLE HID / `BarcodeDetector`, in | Any scan | UHID, accession, GS1-128 drug pack, UDI implant, ISBT-128 blood bag, asset tag, token | **EN-013** | Manual entry with reason (scan-compliance % is a KPI); camera fallback in the PWA | R0 · **T3** |
| **Label printers** (Zebra, TSC, Godex) | **ZPL/EPL/TSPL** over the print agent (LAN/USB) | Sample label, drug label, wristband, asset tag | Template + variables, barcode payload | **EN-005** + EN-013 | Job stays queued with "print elsewhere" option; reprint audited | R1 · **T3** |
| **Thermal token/receipt printers** | **ESC-POS** 80/58 mm via print agent | Token issue, cash receipt, kiosk slip | Token, counter, amount, QR | **EN-005**, EN-006, NC-001 | Browser/PDF fallback on A4/A5; token can be read from the board | R1 · **T3** |
| **Laser A4/A5 printers** | IPP/system printer via agent, or browser print | Reports, summaries, claim packs | Rendered PDF (Playwright) | **EN-005** | Browser print dialogue; PDF download | R1 · T3 |
| **Print Service Agent** | WebSocket/poll to the hub, bi-directional | Job dispatch, printer health | Job payloads, printer status/queue | **EN-005** | Agent offline > 60 s → banner in the status strip, jobs queue, browser fallback offered | R3 · T2, T3 |
| **Biometric devices** (Mantra/Morpho/Startek fingerprint, face, iris) | Vendor SDK / RD service / local HTTP, in | Staff punch, patient identity/dedupe, witness auth | Encrypted template or match result (**templates encrypted at rest, never exported**) | **EN-020**, NC-029 | PIN/password fallback for witness auth; manual attendance regularisation | R5 · **T3** |
| **Biometric attendance terminals** (eSSL, Matrix, ZKTeco) | Vendor SDK/TCP push or pull, in | Punch events; scheduled pull | Employee id, timestamp, device id, in/out | **NC-029** + EN-017 | Device buffers; pull back-fills by date range; manual regularisation workflow | R5/R4 · T3 |
| **Biomedical device gateway** — monitors, ventilators, infusion pumps, dialysis machines, incubators, autoclaves, RO plant, cold-chain sensors | **MQTT**, **Modbus TCP/RTU**, serial RS-232/485, BLE, vendor SDK, HL7 device profiles, OPC-UA | Continuous streams / periodic reads | Canonical observations (LOINC + UCUM), alarms, device status | **EN-042** | Store-and-forward buffer on the gateway; **a device reading is evidence, not truth — a human validates before charting**; manual entry always available | R5/R3 · T2, T3 |
| **Vitals monitors & spot-check devices** | HL7 ORU^R01 via EN-042 or vendor SDK | Spot check / continuous | HR, BP, SpO2, temp, RR with device + timestamp | **EN-042** → IP-003/OP-007 | Manual vitals entry; back-filled device data flagged | R5 · T2, T3 |
| **Weighing scales / height / BP kiosks** | Serial/BLE/USB HID, in | Vitals room, kiosk, paediatric OPD | Weight, height, BMI, BP | **EN-042**, OP-007 | Manual entry (weight is mandatory for paediatric dosing — blocking empty state, not a default) | R5 · T3 |
| **Nurse-call systems & smart beds** | Vendor TCP/REST/MQTT, in | Call raised, bed exit, weight alarm | Bed, priority, timestamps | **IP-003** + EN-042 | Physical call system continues independently; SLA metrics degrade gracefully | R3 · T3 |
| **Kiosks** (self check-in, payment, report print, feedback) | Our PWA + device token; peripherals via local agent | Patient interaction | Check-in, token, payment, report, feedback | **EN-034** | Kiosk offline → reception counter; heartbeat alerts IT after 90 s | R3 · T3 |
| **TVs / digital signage / Chromecast / Android TV** | PWA over WebSocket (SSE/long-poll fallback), device token, in | Board state changes | Rendered board state deltas (masked labels) | **EN-018** | Last-known state with amber→red staleness chip; static content keeps rotating | R3 · T2, T3 |
| **CCTV** (ONVIF/RTSP NVR) | ONVIF discovery + RTSP streams + event bookmarks, bi-directional | Security dashboard; HMS event tagging (code blue, MLC, incident, narcotic access) | Camera registry, stream URLs, bookmark timestamps (**no video stored in the HMS**) | **EN-021** | Dashboard shows camera offline; bookmarks stored locally for later correlation; privacy zones/no-record areas enforced | R3 · T3 |
| **GPS / ambulance telematics** | Vendor REST/MQTT + device SIM, in | Trip start/ping/end | Lat/long, speed, ETA, trip state, pre-hospital vitals relay | **NC-013**, TR-009 | Driver app GPS as fallback; ETA estimated from the last known position with a staleness marker | R5 · T2, T3 |
| **108/112 emergency services** | State-specific API/phone, bi-directional | Inbound emergency pre-alert | Patient count, triage category, ETA | **TR-009** | Phone pre-alert entered manually into the ER board | R2 · T1 |

---

## 8. Enterprise / back-office

| System | Protocol · Direction | Trigger | Data | Owner | Failure mode → fallback | Retry · Test |
|---|---|---|---|---|---|---|
| **Tally ERP 9 / Prime** | Tally XML over HTTP (or file import), out | Nightly journal export; on `bill.finalized`/`payment.received` batch | Vouchers (sales, receipt, payment, journal), ledgers, GST fields, cost centres | **NC-009** + EN-017 | Export file downloadable for manual import; exception file lists unmapped ledgers; export blocked during month-end close window | R4 · T1, **T5** |
| **SAP (IDoc) / Oracle Financials / MS Dynamics** | IDoc via SFTP/RFC, REST, or file, out | Nightly/periodic | GL journals, AP invoices, vendor master, asset master | **NC-009** | Same as Tally; mapping is EN-017 configuration | R4 · T1, T5 |
| **GST e-invoicing (IRP)** — where threshold applies | REST via GSP, out | B2B invoice above threshold | Invoice JSON → IRN + signed QR | **NC-009** + OP-005 | Invoice issued without IRN is blocked for B2B; retry queue; manual IRP portal path | R2 · T1 |
| **Payroll bank files** | Bank-format file (SFTP/portal), out | Monthly payroll run | Salary credit file, PF/ESI/PT/TDS challans | **NC-010** | Manual upload of the generated file | R4 · T5 |
| **Legacy HIS/LIS/RIS (migration & parallel run)** | JDBC read-only pull, CSV/SFTP, HL7 | One-time + delta during cut-over | Patients, visits, balances, stock, historical results | **EN-036** + EN-017 | Staging schema with validation and rollback per batch; never write to the legacy system | R4 · **T5** |
| **Hospital website** | REST widgets + webhooks, bi-directional | Online booking, report download, payment link, lead capture | Appointment, patient contact, package enquiry | **EN-012** | Widget shows "call us" fallback; leads buffered | R1 · T1 |
| **Google Business Profile reviews** | Google API / deep link, out | `feedback.submitted` with rating ≥ threshold | Review invitation link (no PHI) | **EN-030** | Direct link sent by WhatsApp/SMS; routing rule is configuration | R1 · T1 |
| **Product analytics (PostHog)** | REST, out | Staff UI events only | **Staff usage events only — never PHI, never patient identifiers** | EN-001 | Analytics failure never affects the app (fire-and-forget, sampled) | R0 · T1 |

---

## 9. Terminology, knowledge & identity

| System | Protocol · Direction | Trigger | Data | Owner | Failure mode → fallback | Retry · Test |
|---|---|---|---|---|---|---|
| **SNOMED CT India (NRCeS)** | Release file import (RF2) / terminology server REST, in | Release update (biannual) | Concepts, descriptions, relationships, Indian extension, value sets | **EN-027** | Cached local terminology; new release staged and diffed before activation | R4 · T1 |
| **LOINC** | Release file import, in | Release update | Lab/observation codes, units, panels | **EN-027** | As above; local test master mapping is authoritative for existing tests | R4 · T1 |
| **ICD-10 / ICD-11 (WHO ICD-API)** | File import + optional REST, in | Version adoption | Codes, titles, synonyms, Indian colloquial aliases (local), ICD-10↔11 map | **EN-027** | Fully local; the API is only for enrichment | R4 · T1 |
| **Drug knowledge base (CIMS India / First Databank / Medi-Span)** | Licensed file or REST, in | Monthly refresh | Molecules, brands, strengths, interactions, dose ranges, pregnancy/renal flags, allergy classes | **EN-027** + EN-029 | **CDSS-offline banner + audit flag** (OP-002 §9); hospital-curated fallback list; hard-stop rules never disappear silently | R4 · T1 |
| **UCUM** | Static, in | Build time | Units + conversions | EN-027 | Bundled | — · T2 |
| **Aadhaar eSign (ESP: NSDL / eMudhra / Protean)** | REST (ASP↔ESP), out + redirect | Consent, discharge summary, claim, certificate signing | Document hash, ESP transaction, signed PKCS#7, LTV timestamp (**never the Aadhaar number**) | **EN-016** | Fall back to DSC (PKCS#11 USB token) or system signature with NMC reg no.; document remains valid per the hospital's signing policy | R1 · T1, **T4** |
| **DSC / USB token** | PKCS#11 local, out | Signing at a workstation | Detached signature | **EN-016** | Aadhaar eSign or system signature | R0 · T3 |
| **Trusted timestamping (TSA)** | RFC 3161, out | Signing, audit anchoring | Hash → timestamp token | **EN-016** | Local hash chain continues; timestamps back-filled | R1 · T1 |
| **DigiLocker** | REST + OAuth, bi-directional | Patient pulls ID/insurance docs; hospital pushes discharge summary/certificate | Issued document URIs, consented pulls | **PE-001** + EN-011 | Manual upload by the patient; never a blocker | R1 · T1 |
| **UIDAI Aadhaar authentication** (via AUA/KUA, where legally permitted) | REST via licensed AUA, out | Scheme beneficiary verification, ABHA creation | Auth request/response only — **we store masked last-4 + hash, never the full number** (`04` §4) | **EN-011**, RC-007 | Alternate ID verification path; never mandatory for treatment | R1 · **T4** |

---

## 10. Connector implementation pattern (mandatory for every connector)

Consistent with EN-017 §3.8. A connector is **a manifest + a thin adapter + declarative mappings + samples** — never bespoke code inside a business module.

**10.1 Adapter interface** (`packages/contracts/integration/adapter.ts`):
```ts
export interface ConnectorAdapter<C extends ConnectorConfig = ConnectorConfig> {
  readonly manifest: ConnectorManifest;            // id, version, protocols, operations, capabilities
  connect(ctx: AdapterContext<C>): Promise<void>;  // open pools/sockets/listeners; idempotent
  dispatch(op: OperationKey, msg: OutboundMessage): Promise<DispatchResult>;   // outbound, must be idempotent
  receive?(raw: RawInbound, ctx: AdapterContext<C>): Promise<CanonicalEnvelope>; // inbound listeners/webhooks
  healthCheck(ctx: AdapterContext<C>): Promise<HealthReport>;                  // ping/echo, ≤ 5 s
  close(reason: 'shutdown' | 'reconfigure' | 'revoked'): Promise<void>;        // graceful drain
}

export type DispatchResult =
  | { status: 'sent' | 'acknowledged'; partnerRef?: string; latencyMs: number; response?: unknown }
  | { status: 'failed'; errorClass: ErrorClass; code?: string; retryable: boolean; retryAfterMs?: number };

export type ErrorClass =
  | 'network' | 'timeout' | 'auth' | 'rate_limited' | 'partner_5xx'      // retryable
  | 'validation' | 'semantic_4xx' | 'mapping_error' | 'schema_drift'
  | 'not_supported' | 'poison';                                          // non-retryable → DLQ
```
Rules: adapters receive and return **canonical objects only** (Patient, Encounter, Order, Result, Document, Charge, Payment, Item, StockMove, Employee, Attendance) — they have no DB access, no direct module imports, and no knowledge of tenants beyond the injected context. They run inside the worker with CPU/memory limits and a `sandbox` mode that records outbound calls without sending. Packages are signed and installed per tenant.

**10.2 Config schema** (Zod, rendered automatically into the EN-017 connector wizard):
```ts
export const ConnectorConfigSchema = z.object({
  key: z.string().regex(/^[a-z0-9_.-]+$/),
  category: z.enum(['clinical','diagnostic','financial','messaging','government','erp','device','security','other']),
  protocol: z.enum(['rest','soap','hl7v2_mllp','astm','fhir','dicom','sftp','file','jdbc','smpp','mqtt','websocket','webhook']),
  direction: z.enum(['in','out','both']),
  environment: z.enum(['sandbox','production']),
  endpoint: z.object({ url: z.string().url().optional(), host: z.string().optional(), port: z.number().int().optional(),
                       path: z.string().optional(), topic: z.string().optional(), aeTitle: z.string().optional() }),
  auth: z.discriminatedUnion('type', [
    z.object({ type: z.literal('none') }),
    z.object({ type: z.literal('api_key'), header: z.string(), secretRef: z.string() }),
    z.object({ type: z.literal('basic'), secretRef: z.string() }),
    z.object({ type: z.literal('oauth2_cc'), tokenUrl: z.string().url(), scope: z.string().optional(), secretRef: z.string() }),
    z.object({ type: z.literal('jwt_bearer'), issuer: z.string(), keyRef: z.string() }),
    z.object({ type: z.literal('mtls'), clientCertRef: z.string(), caRef: z.string().optional() }),
    z.object({ type: z.literal('hmac'), algorithm: z.enum(['sha256','sha512']), secretRef: z.string() }),
    z.object({ type: z.literal('sftp_key'), username: z.string(), keyRef: z.string() }),
  ]),
  tls: z.object({ verify: z.boolean().default(true), caRef: z.string().optional(), pinnedSha256: z.string().optional() }),
  retry: z.object({ policy: z.enum(['R0','R1','R2','R3','R4','R5']).default('R1'), maxAttempts: z.number().int().max(12).default(5) }),
  circuit: z.object({ failureThreshold: z.number().int().default(10), errorRatePct: z.number().default(50), coolDownSec: z.number().default(60) }),
  rateLimit: z.object({ perMinute: z.number().int().optional(), concurrency: z.number().int().default(8) }),
  health: z.object({ kind: z.enum(['ping','echo','expect_traffic']), intervalSec: z.number().default(60),
                     expectTrafficWindowMin: z.number().optional() }),
  dpdp: z.object({ containsPhi: z.boolean(), purpose: z.string().min(10), dataCategories: z.array(z.string()).min(1),
                   crossBorder: z.boolean().default(false), dpaRef: z.string().optional(),
                   retentionAtProcessorDays: z.number().int().optional() }),
  requiresInternet: z.boolean().default(true),   // on-prem: `false` connectors must work WAN-down
});
```
**Secrets are references only** (`secretRef` → Vault/SSM path). A config containing a literal secret fails validation and CI secret-scanning.

**10.3 Health check.** Every connector declares one of: `ping` (TCP/TLS connect or `C-ECHO`), `echo` (a real, side-effect-free operation such as `GET /status` or an HL7 `QRY`), or `expect_traffic` (alarm when no message arrives inside a working-hours window — the only way to catch a *silently* dead analyzer). Output feeds `ihub_health_checks`: RAG state, uptime 24 h/7 d/30 d, latency p95, consecutive failures. Transitions raise `integration.health.degraded|restored` → EN-037 on-call + the EN-018 IT ops board. Credential/certificate expiry is checked by the same job and alerts at **30 / 7 / 1 days**.

**10.4 DLQ handling.** Non-retryable classes and exhausted retries land in `ihub_dlq`, **grouped by fingerprint** (`hash(errorClass + code + mapping path)`) so 500 identical failures are one triage item with an occurrence count and a sample payload. Actions: *Retry now* · *Retry with edited payload* (requires `ihub.message.edit`, audited) · *Replay range* (dry-run count first; > 1000 needs a second confirmation) · *Discard with reason* · *Create ticket* (NC-028) · *Suppress fingerprint* with expiry. Replay reuses the **original idempotency key** and defaults `suppressSideEffects = true` so patients are not re-notified. Poison messages auto-quarantine after 3 handler crashes and never block the queue. **A message is never silently dropped** — every terminal state is a visible, owned item (`04` §7 "no silent failures").

**10.5 Observability & privacy for all connectors.** W3C `traceparent` propagated end to end; correlation id on every log line; RED metrics per connector exported to Prometheus; **no PHI in traces, metrics or logs**; the searchable message copy is redacted to typed tokens (`«name»`, `«phone:9876»`) with the full payload encrypted and gated behind `ihub.payload.read` (itself audited as a PHI read).

---

## 11. Credentials & artefacts to collect from the hospital (procurement checklist)

ABDM (HFR/HPR ids, client id+secret, keys, STQC audit) · NHCX participant code · PMJAY/CGHS/ECHS/ESIC/state empanelment ids + portal users · e-RaktKosh & NOTTO registrations · NIC e-Hospital endpoint + key · SPCB/AERB/PNDT registration numbers · TPA portal accounts and SFTP keys per payer · payment gateway merchant id + key/secret + webhook secret + settlement account · POS terminal vendor + TID/MID · SMS gateway account + **DLT principal entity id, header, template ids** · WhatsApp WABA id + phone id + permanent token + approved templates · SMTP/SES credentials + verified sending domain with SPF/DKIM/DMARC · analyzer inventory (model, protocol, HL7/ASTM version, bidirectional yes/no, IP/serial port) · modality inventory (AE title, IP, port, SOP classes, MWL/MPPS support, TLS) · printer inventory (make, model, language ZPL/ESC-POS, IP/USB, location) · biometric device models + SDK licences · biomedical device list with protocol and vendor SDK licences · CCTV NVR ONVIF credentials + privacy-zone policy · ambulance GPS vendor API key · accounting system (Tally/SAP/Oracle) version + export format + cut-off + ledger map · SNOMED CT India licence, LOINC registration, drug-KB licence (**budget line item**) · eSign ESP contract + DSC tokens · DigiLocker partner id · egress/proxy IPs, firewall change process, VPN/leased line to government endpoints, NTP source · on-call owner per connector class.

## 12. Open questions for the hospital

1. Full inventory of external systems at go-live, including any legacy HIS/LIS/RIS running in parallel and for how long.
2. Which analyzers/modalities are bidirectional, and which need a serial-to-IP converter or an on-prem gateway box?
3. Accounting/ERP system, export format, frequency, and month-end blackout window.
4. Which payers accept API/SFTP submission versus portal-only? Which support webhooks and idempotency keys?
5. Data residency: does any connector send personal data outside India, and is a DPA signed with each processor?
6. Drug knowledge base vendor decision (CIMS / FDB / Medi-Span / hospital-curated) — this gates EN-029 hard-stop quality.
7. Payment: primary gateway, POS vendor, and whether UPI QR is per counter, per kiosk or per bed.
8. SMS/WhatsApp: which gateway, whose DLT entity, and who owns template approval turnaround?
9. eSign: is Aadhaar eSign contracted, or is a system signature with NMC registration number sufficient per document type?
10. Network topology: VLAN segmentation for devices, egress proxy IPs, whether WebSocket is permitted end to end, and the NTP source (CERT-In requirement).
11. On-call owner and escalation path per connector class (lab, imaging, payments, government, devices) outside working hours.
12. Is there an existing enterprise ESB/iPaaS the hospital wants EN-017 to sit behind rather than replace?
