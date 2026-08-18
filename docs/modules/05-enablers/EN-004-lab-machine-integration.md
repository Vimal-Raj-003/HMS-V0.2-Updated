# EN-004 — Lab Machine Integration (Instrument Master, HL7 v2 / ASTM Interfaces, Bi-directional Worklist, Middleware, LOINC Mapping, Auto-validation, Delta, QC Levey-Jennings/Westgard, Error Queue, Uptime)

| Field | Value |
|---|---|
| Domain | Enabler |
| Module ID | EN-004 |
| Phase | 3 |
| Priority | P1 (P0 for the first 5 high-volume analyzers at go-live) |
| Complexity | High |
| Depends on | OP-004 (LIS — orders, samples, results, validation), EN-017 (Integration Hub — connector runtime, DLQ, monitoring), EN-027 (test master, LOINC), EN-031 (NABL/QC/EQA policies), EN-013 (sample barcodes), NC-006 (reagent inventory), NC-020 (analyzer assets/PM), EN-037 (alerts), EN-024 (audit), EN-042 (device gateway hardware on-prem) |
| Feature flag | `module.lab_interface.enabled` (sub: `lab_interface.astm`, `lab_interface.hl7`, `lab_interface.autovalidate`, `lab_interface.qc`, `lab_interface.middleware_routing`) |
| Primary roles | Lab Technician (33), Lab Quality Manager (35), IT Admin / Helpdesk (56) |
| Secondary roles | Pathologist (13 — exceptions review), Biomedical Engineer (48), Vendor engineer (supervised), Auditor |
| Regulatory | NABL 112 / ISO 15189:2022 (interface verification, IQC with Westgard rules, EQA, uptime & downtime records, auto-verification validation), CLSI AUTO10/AUTO15 (auto-verification), CLSI LIS01/LIS02 (ASTM E1381/E1394 → LIS1-A/LIS2-A2), HL7 v2.5.1 (ORU^R01, OML^O21/ORL, QBP/RSP host query, ACK), IHE LAW profile (Laboratory Analytical Workflow), LOINC, DPDP (PHI in messages; message logs encrypted, no PHI in app logs) |

## 1. Purpose
EN-004 connects laboratory analyzers to the LIS bi-directionally: instrument master and connection management (TCP/MLLP, serial RS-232 via on-prem gateway, file/FTP), protocol drivers (HL7 v2.x, ASTM E1394/LIS2-A2, vendor CSV), order download/host query, result upload with test-code and unit mapping to LOINC-coded LIS tests, auto-validation rules with delta checks, instrument QC capture with Levey-Jennings charts and Westgard rules (lockout), an error queue for unmatched/rejected messages, and analyzer uptime/downtime SLA reporting — for 30 analyzers and 20k tests/day.

## 2. Users & Jobs-to-be-done
- **Lab technician** (bench desktop, scanner): see interface status per analyzer, resend worklist, resolve unmatched results (wrong/missing sample id), rerun/dilution, run QC and view L-J, review auto-validation exceptions only.
- **Lab quality manager**: define QC materials/lots/targets, Westgard rule sets per test/analyzer, review violations & CAPA, verify auto-validation rule changes (NABL evidence), monthly QC/uptime reports.
- **IT admin / integration engineer**: onboard analyzers (wizard), configure ports/protocol/mapping, monitor message flow, replay from DLQ, downtime logs.
- **Pathologist**: approve auto-validation rules and thresholds; review exception queue.
- **Biomedical engineer**: analyzer breakdown/PM link (NC-020).

## 3. Core Workflows

### 3.1 Instrument onboarding (wizard)
1. IT/lab admin creates **instrument**: name, make/model (driver template picked from library: e.g. Sysmex XN, Beckman AU/DxH, Roche cobas, Abbott Architect/Alinity, Mindray BS/BC, Siemens Dimension, Bio-Rad D-10, Horiba, Erba, Transasia, i-STAT/blood gas), serial, department/bench, protocol (HL7 v2.x / ASTM E1394 / LIS2-A2 / vendor CSV/file), transport (TCP server or client with host/port, MLLP framing; serial via gateway device — COM port, baud, parity, stop bits, flow control; FTP/SMB folder), direction (uni/bi), encoding, timeouts/retries, heartbeat interval, message log retention → `lab_instruments` → Event `lab_if.instrument.created`.
2. **Test-code mapping**: instrument test/channel code → LIS test parameter (LOINC-coded in EN-027) with unit conversion factor, decimal precision, result type (numeric/qualitative/text), flags mapping (H/L/A/*, instrument abnormal codes), dilution handling, sample type mapping (S/P/U/WB) → `lab_instrument_test_maps`; unmapped codes surface in error queue.
3. **Verification run**: send test order to analyzer / receive sample results for 20 samples; side-by-side comparison with manual entry; sign-off (NABL interface verification record, `lab_interface_verifications`) → status `live`.
4. Connection health: listener/connector process in `services/integration-hub` (per instrument worker), heartbeat/ENQ, auto-reconnect with backoff; status `connected/disconnected/error/maintenance`.

### 3.2 Outbound worklist (orders → analyzer)
1. On `lab.sample.received`/accessioned in OP-004 for tests mapped to a live analyzer → System builds message: HL7 **OML^O21** (or ORM^O01 for legacy) / ASTM Order record (O) with sample id (barcode), patient id/name/sex/DOB (as configured), test codes, priority (STAT), collection time → sends (broadcast mode) or stores in worklist cache for **host query** mode (analyzer sends QRY/Q record on barcode read → system replies with orders within 2 s; ASTM Q → O records; HL7 QBP^Q11 → RSP^K11).
2. ACK handling: application ACK/NAK; NAK → retry 3× exponential → error queue; message log row with raw payload (encrypted at rest), direction, status.
3. Order cancellation/add-on → OML with cancel code / new order; rerun requests from tech → resend order flagged rerun.

### 3.3 Inbound results (analyzer → LIS)
1. Analyzer completes → HL7 **ORU^R01** / ASTM R records (with C comments, M manufacturer records) → listener parses (per driver: segment/field maps, escapes, repeats) → **match** sample id → OP-004 sample/order (barcode = accession+container); patient identity cross-check (if PID sent: name/sex/DOB fuzzy match; mismatch → error queue "patient mismatch") → per result: map test code → LIS parameter, unit conversion, flags, dilution factor, instrument id, run id, result time, operator; **duplicate handling** (same sample/test: keep latest as rerun with history; configurable "first wins" for some analyzers).
2. Results land as `unverified` in OP-004 with source=instrument → Event `lab.result.instrument_received` → auto-validation (3.4).
3. Unmatched sample id (not accessioned yet, mistyped) → **error queue** (`lab_if_error_queue`) with raw message; tech can **assign** to a sample (search by patient/accession) or **reject**; auto-retry match every 5 min for 24 h (late accessioning). Test code unmapped → error queue "unmapped code" → admin maps and replays.
4. QC results (control sample ids matching QC lot pattern) routed to 3.5 not to patients. Calibration messages logged.
5. Instrument flags (clot, short sample, error codes) → result marked `instrument_error`, tech prompted rerun; images/histograms (haematology) stored as attachments if provided.

### 3.4 Auto-validation (auto-verification) rules
1. Rule set per test (and optionally per analyzer/department/patient group): all must pass → result auto-verified (level 1) and, if configured & NABL-approved, auto-authorised (final) without human review; else routed to exception worklist:
   - result within **auto-validation range** (narrower than reference range, e.g. Na 133–146),
   - **no critical value**, no absurd/implausible (< analytic range),
   - **delta check** pass vs previous result within window (absolute/% per test, e.g. K ± 1.0 mmol/L in 7 days; Hb ± 3 g/dL in 3 days),
   - instrument flags clear, dilution not applied (or allowed), sample quality indices (HIL – haemolysis/icterus/lipaemia) below thresholds,
   - **QC in control** for that analyte on that analyzer since last run (Westgard),
   - order not STAT/ICU/paediatric (configurable exclusions), patient not on "review all" list,
   - correlation/consistency rules (e.g. MCH/MCHC/RBC-Hb consistency, anion gap, eGFR calc; indirect bilirubin < total).
2. Rule engine expression stored as JSON (operators, thresholds), versioned; every auto-validated result records rule_set_version and passed rules; exceptions record failing rule ids and reasons for the technician (`lab_if_autoval_decisions`).
3. Rule change → draft → validated by Lab QM + Pathologist sign (NABL evidence) → active from date; audit.
4. Auto-validation rate KPI per test/analyzer; monthly review report.

### 3.5 Instrument QC (IQC): Levey-Jennings & Westgard
1. QC material master: manufacturer, lot, level (1/2/3), expiry, assayed target mean/SD per analyte per analyzer; lab-established mean/SD after ≥ 20 runs (auto-calc with cumulative option) → `lab_qc_lots`, `lab_qc_targets`.
2. QC results captured from analyzer messages (control sample id pattern) or manual entry → z-score computed → **Westgard rules** configurable per test: 1-2s (warning), 1-3s, 2-2s (within/across runs, across levels), R-4s, 4-1s, 10x (or 8x/12x), 7T; multi-rule combos; per-analyte "acceptable" run decision → `lab_qc_results` with rule violations.
3. Violation → run **rejected**; **analyte lockout** on that analyzer (`lab_if_lockouts`): patient results for that analyte since last good QC held (`qc_hold` in OP-004) and new results routed to hold; alert to bench/QM; corrective action recorded (recalibrate, new control, maintenance) → rerun QC → pass → unlock; held results released for review (never silently) → Event `lab_if.qc.violation|lockout|unlock`.
4. **Levey-Jennings chart** per analyte/level/lot with ±1/2/3 SD bands, run points colour-coded, rule annotations, lot changes, shift/trend detection; monthly QC summary (CV %, bias vs peer where EQA data (EN-031)); Sigma metric optional.
5. EQA/PT samples flagged and reported via EN-031.

### 3.6 Middleware routing (`lab_interface.middleware_routing`)
- Rules: route by test/priority to a specific analyzer (load balancing among identical analyzers, e.g. 3 chemistry lines), reflex/repeat rules (auto rerun on flags, auto-dilution rerun), reagent lot tracking per result (from message or manual), **multi-analyzer averaging/comparison** for duplicate testing (enhancement), track & sort automation lines (aliquot/track messages), POCT devices (blood gas, glucometers via POCT1-A) treated as instruments with location.

### 3.7 Error handling, downtime & uptime
1. Communication failure (socket drop, no ACK, checksum error, serial framing) → auto-retry with backoff → after threshold: instrument `error`, alert IT + bench (EN-037), **manual entry fallback** in OP-004 flagged `manual_due_to_interface_down`; when reconnected, backlog processed; duplicates suppressed by message id/hash.
2. Downtime log (`lab_instrument_downtime`): auto (connection lost) + manual (breakdown/PM/reagent-out, from NC-020) with reason, start/end → uptime % SLA per analyzer per month; vendor SLA breach flag.
3. Result mismatch (patient identity/sample) → reject & rerun with reason; all rejections audited.
4. Message replay from log/DLQ (idempotent, cannot overwrite validated results without amendment path).

## 4. Data Model (schema `integration`, prefix `lab_`)
- `lab_instruments` — id, hospital_id, branch_id, code, name, make, model, serial, department_id, bench_id, driver_key, protocol (hl7v2/astm_e1394/lis2a2/csv/poct1a), transport (tcp_server/tcp_client/serial/file), conn jsonb (host, port, mllp, com_port, baud, parity, stop_bits, flow, folder), direction, encoding, host_query_mode (bool), send_demographics (bool), timeouts jsonb, status, last_heartbeat_at, asset_id (NC-020), retention_days, active.
- `lab_instrument_test_maps` — instrument_id, instrument_code, sample_type_code, lis_test_id (EN-027, LOINC), unit_factor, precision, result_type, flag_map jsonb, dilution_rule, active; UNIQUE(instrument_id, instrument_code, sample_type_code).
- `lab_if_messages` — id, hospital_id, instrument_id, direction (in/out), msg_type (ORU/OML/QBP/RSP/ACK/ASTM_R/O/Q/M), control_id, sample_id, raw bytea (encrypted), parsed jsonb, status (received/parsed/matched/applied/acked/nak/error/replayed), error_code, error_text, received_at, processed_at, attempts; partitioned monthly; index (hospital_id, instrument_id, received_at desc), (sample_id).
- `lab_if_error_queue` — id, hospital_id, message_id, instrument_id, type (unmatched_sample/unmapped_code/patient_mismatch/parse_error/duplicate/nak/qc_unassigned), sample_id_raw, suggested_sample_id, status (open/assigned/rejected/auto_resolved), resolved_by/at, resolution.
- `lab_if_worklist_cache` — instrument_id, sample_id, order payload, sent_at, acked_at, expires_at (host-query mode).
- `lab_if_autoval_rulesets` — id, hospital_id, lis_test_id, instrument_id?, version, rules jsonb, status (draft/active/retired), approved_by (QM), signed_by (pathologist), effective_from; `lab_if_autoval_decisions` — result_id, ruleset_version, outcome (auto_verified/auto_final/exception), failed_rules jsonb, evaluated_at.
- `lab_qc_materials`, `lab_qc_lots` (material_id, lot_no, level, expiry, open_date), `lab_qc_targets` (lot_id, instrument_id, lis_test_id, mean, sd, source (assayed/lab_established), n, effective_from), `lab_qc_results` (id, instrument_id, lot_id, lis_test_id, value, z_score, run_no, run_at, entered_by/source, rules_violated text[], accepted bool, corrective_action, reviewed_by), `lab_qc_rule_config` (lis_test_id/instrument_id, rules jsonb e.g. {"1_3s":"reject","2_2s":"reject","R_4s":"reject","4_1s":"reject","10x":"reject","1_2s":"warn"}).
- `lab_if_lockouts` — instrument_id, lis_test_id, locked_at, reason, qc_result_id, unlocked_at/by, held_result_count.
- `lab_instrument_downtime` — instrument_id, start_at, end_at, type (comm/breakdown/pm/reagent/other), reason, source (auto/manual), ticket_id (NC-020).
- `lab_interface_verifications` — instrument_id, performed_at, samples_compared, discrepancies, approved_by, document_id.
- `lab_reagent_usage` (enhancement) — instrument_id, reagent_item_id, lot, tests_run, period.

## 5. Business Rules & Validations
- Only `live` instruments receive orders/produce patient results; `verification` instruments write to sandbox worklists.
- Result cannot overwrite a validated/final LIS result; new instrument result for a final test → stored as new run and flagged for pathologist (amendment path in OP-004).
- Sample id must resolve to a sample in `received/accessioned/in_process` state; results for `rejected` samples → error queue.
- Auto-validation only for tests with active, signed rule sets; STAT/ICU/paediatric/critical/delta/QC-hold never auto-final unless explicitly configured; every auto decision recorded (NABL traceability); rule set edits require QM approval + pathologist sign.
- Westgard: rejection rules block release; warning rules flag; lockout scope = analyte × instrument; unlock only after passing QC and corrective action note; held patient results released to review queue.
- QC target changes effective forward only; lot expiry blocks use; ≥ 20 points before lab-established SD replaces assayed.
- Delta check uses last final result of same test for patient within window (from OP-004), ignoring different specimen types.
- Message logs retained 90 days raw (encrypted), 2 years parsed metadata; PHI never in application logs (only message ids).
- Idempotency: inbound message hash + control id; outbound resend uses same control id family with retry counter.
- Downtime auto-start after `heartbeat_miss × 3` (default 3 min); auto-end at reconnect.

## 6. API Surface (`/api/v1/lab-interface`)
| Method | Path | Purpose | Permission | Notes |
|---|---|---|---|---|
| GET/POST/PATCH | /instruments ; /instruments/:id ; POST /instruments/:id/test-connection ; POST /instruments/:id/status (maintenance/live) | instrument master | integration.lab.configure | |
| GET/PUT | /instruments/:id/test-maps ; POST /instruments/:id/test-maps/import (CSV) | mapping | integration.lab.configure | |
| POST | /instruments/:id/verification | interface verification record | lab.qc.configure | |
| GET | /instruments/status | live health board | integration.lab.read | WS channel `labif:<hospital>` |
| POST | /orders/send | (internal) push worklist for sample | integration.lab.send | called by OP-004 events |
| POST | /orders/:sampleId/resend | resend order | lab.sample.update | |
| GET | /messages?instrument&sample&status&from&to ; GET /messages/:id (raw masked) ; POST /messages/:id/replay | message log | integration.lab.read / integration.lab.replay | paginated |
| GET | /error-queue ; POST /error-queue/:id/assign {sampleId} ; POST /error-queue/:id/reject | error resolution | lab.interface.errors.resolve | |
| GET/POST/PATCH | /autoval/rulesets ; POST /:id/submit ; POST /:id/approve ; POST /:id/sign | auto-validation rules | lab.autoval.configure / lab.autoval.approve (QM) / lab.autoval.sign (pathologist) | |
| GET | /autoval/exceptions?bench | exception worklist (joins OP-004) | lab.result.verify | |
| GET/POST | /qc/materials ; /qc/lots ; /qc/targets ; /qc/rules | QC config | lab.qc.configure | |
| POST | /qc/results (manual) ; GET /qc/results?test&instrument&lot&from&to | QC data | lab.qc.record / lab.qc.read | |
| GET | /qc/levey-jennings?test&instrument&lot | chart series with bands & violations | lab.qc.read | |
| POST | /qc/lockouts/:id/unlock {corrective_action} | unlock | lab.qc.unlock (QM/senior tech) | |
| GET/POST/PATCH | /downtime | downtime log | integration.lab.read / lab.instrument.downtime.record | |
| GET | /reports/uptime ; /reports/autoval-rate ; /reports/qc-summary ; /reports/interface-log | reports | lab.qc.read / integration.lab.read | MV |

## 7. Domain Events (outbox)
- `lab_if.instrument.created|updated|connected|disconnected|error|maintenance` → EN-037 IT/bench, EN-018 lab board.
- `lab_if.order.sent|acked|nak|failed` → OP-004 sample timeline.
- `lab.result.instrument_received` (payload: sample_id, test ids, instrument, run id) → OP-004.
- `lab_if.result.unmatched|unmapped|patient_mismatch` → error queue UI, bench alert.
- `lab_if.autoval.verified|final|exception` → OP-004 status, KPI.
- `lab_if.qc.result_recorded|violation|lockout|unlock` → OP-004 (`qc_hold`), EN-031 (NABL), EN-037.
- `lab_if.downtime.started|ended` → NC-020, EN-018 lab TAT board ("analyzer down" note).

## 8. Screens
- **Interface Health Board** (desktop/TV in lab, dark): tiles per analyzer (connected/last msg age/queue depth/errors today/lockouts), throughput sparkline, downtime banner; click → instrument console. Real-time WS.
- **Instrument Console** (desktop): connection details, start/stop/test connection, message log (search by sample id, filter direction/status, raw view with PHI masked unless `integration.lab.raw.read`), replay, worklist cache, mapping tab, verification tab.
- **Onboarding Wizard** (desktop): 5 steps (identity → transport → protocol/driver → mapping import → verification); test message tool.
- **Error Queue** (bench desktop + scanner): unmatched/unmapped list; scan sample to assign; bulk reject; keyboard `A` assign, `R` reject, `↑/↓` navigate.
- **Auto-validation Exceptions worklist** (inside OP-004 bench): reason chips (delta, range, flag, QC hold), quick actions verify/rerun/comment; `V` verify, `N` next.
- **Rule Set Editor** (desktop): per test rules form (ranges, delta, flags, exclusions), version diff, approve/sign workflow.
- **QC Workstation** (desktop): enter/import QC, L-J chart (Recharts; bands, points, violation markers, lot boundaries), Westgard config, lockout panel with corrective action form, monthly summary; `Ctrl+Enter` accept run.
- **Downtime & Uptime** (desktop): calendar/gantt per analyzer, SLA %, vendor breach flags.
- Offline: not applicable (server-side listeners); bench UI shows cached status.

## 9. Integrations
- Analyzers via TCP/MLLP (HL7), TCP/serial (ASTM E1394 with ENQ/ACK/EOT framing, checksums, frame numbers), serial-to-IP converters (Moxa/Digi) or on-prem `services/integration-hub` gateway box (EN-042); vendor middleware (Roche cobas infinity, Sysmex WAM, Abbott ALL, Beckman REMISOL, Data Innovations Instrument Manager) as a single HL7 endpoint when present; POCT1-A for glucometers/blood gas; FTP/CSV drop for legacy ELISA readers.
- OP-004 for samples/results, EN-027 test master (LOINC), EN-031 EQA, NC-006 reagent lots, NC-020 breakdown tickets, EN-017 monitoring/DLQ, EN-018 lab board.

## 10. Reports & Analytics
- Interface log (per instrument/day), auto-validation report (rate by test/analyzer, exceptions by reason), QC charts & monthly summary (mean/SD/CV, violations, corrective actions), error log & resolution TAT, machine uptime/downtime & SLA, tests per analyzer per day (throughput), turnaround contribution (received → result), reagent consumption per machine (enhancement), onboarding/verification records for NABL. MVs: `analytics.mv_lab_if_daily`, `mv_lab_qc_monthly`.

## 11. Notifications
- Instrument disconnected > 3 min / NAK storm → IT + bench push; error queue > 20 open → bench; QC violation/lockout → bench, QM; unlock → bench; auto-validation rule awaiting approval → QM/pathologist; downtime > SLA → BME/vendor email; daily QC not run by 09:00 → QM.

## 12. Permissions (RBAC keys)
`integration.lab.configure` (IT Admin, Lab QM) · `integration.lab.read` · `integration.lab.raw.read` (audited PHI) · `integration.lab.replay` (IT Admin) · `integration.lab.send` (system) · `lab.interface.errors.resolve` (technician) · `lab.autoval.configure` (QM) · `lab.autoval.approve` (QM) · `lab.autoval.sign` (Pathologist) · `lab.qc.configure` (QM) · `lab.qc.record` (technician) · `lab.qc.read` · `lab.qc.unlock` (QM/senior tech) · `lab.instrument.downtime.record` (technician/BME) · `lab.sample.update` (resend).

## 13. Non-functional
- 30 analyzers, 20k tests/day (~2000 messages/hour peak, bursts of 200 results/min from haematology lines); parse+match+apply p95 < 300 ms per message; host-query response < 2 s (hard, analyzers time out); no message loss (persist raw before ACK); at-least-once with idempotent apply.
- Listener processes supervised (restart < 5 s), per-instrument isolation (one bad feed cannot block others), backpressure to disk queue.
- On-prem requirement: listeners run inside hospital LAN (integration-hub container or gateway appliance) even for cloud tenants; outbound HTTPS to cloud API with mTLS; store-and-forward during WAN outage.
- Security: no PHI in logs; raw messages encrypted (pgcrypto); serial gateway hardened; role-gated raw view.
- Accessibility: L-J charts have tabular alternative; colour + shape encoding for violations.

## 14. Acceptance Criteria
1. Given a live HL7 analyzer in broadcast mode, when a mapped sample is accessioned, then an OML^O21 is sent within 5 s and an application ACK is logged; on NAK it retries 3× and lands in the error queue with alert.
2. Given an ASTM host-query analyzer reading barcode S123, when the Q record arrives, then the O record reply is sent within 2 s with the pending tests for S123.
3. Given an ORU^R01 with sample id not yet accessioned, when received, then it is stored in the error queue "unmatched" and auto-resolves when the sample is accessioned within 24 h.
4. Given a result whose PID name does not fuzzy-match the sample's patient, when parsed, then it is queued as patient mismatch and no result is written to the patient.
5. Given an instrument code with no mapping, when received, then it appears as "unmapped code" and after mapping + replay the result applies without duplication.
6. Given a potassium result 4.1 with previous 4.0 three days ago, no flags, QC in control, non-STAT patient and an active signed rule set, when auto-validation runs, then the result becomes auto-verified with the rule set version recorded.
7. Given the same test with a critical value or a failed delta, when evaluated, then it routes to the exception worklist with the failing rule ids shown.
8. Given a QC run violating 2-2s across levels, when recorded, then the run is rejected, the analyte is locked on that instrument, subsequent patient results for that analyte are held, and QM + bench are alerted.
9. Given a lockout, when QC passes after corrective action and QM unlocks, then held results move to the review queue (not auto-final) and the lockout row is closed with actor/time.
10. Given the L-J chart request for a lot/analyte, when rendered, then points, ±1/2/3 SD bands, violation markers and lot change lines display, and a table view is available.
11. Given a socket drop, when heartbeats are missed for 3 min, then a downtime row auto-opens, the health board shows disconnected, IT is alerted, and manual entry in OP-004 is flagged as interface-down fallback.
12. Given a replay of an already applied message, when executed, then no duplicate result rows are created (idempotent by control id/hash).
13. Given a rule set edit, when saved, then it stays draft until QM approval and pathologist signature; the previous version remains active meanwhile.
14. Given a month-end, when the uptime report is generated, then per-analyzer uptime %, downtime by type and SLA breaches are listed and exportable.
15. Given a user without `integration.lab.raw.read`, when opening a message, then PHI fields are masked and a raw view request is denied.

## 15. Enhancements / Later phases
- New analyzer onboarding wizard (delivered) with driver marketplace/community templates; multi-analyzer result averaging & comparison (duplicate testing); middleware for complex routing/track automation (`middleware_routing`); reagent consumption per machine & cost per test (NC-006 link); uptime SLA monitoring per analyzer with vendor scorecards; auto-dilution rerun orchestration; moving averages (patient-based QC, Bull's algorithm) for haematology; AI anomaly detection on result streams (AI-005); POCT device fleet management; digital pathology/microbiology instrument (blood culture, ID/AST) interfaces; EQA import automation (EN-031).

## 16. Open Questions for the Hospital
1. Analyzer inventory: make/model, protocol (HL7/ASTM), connection (serial/TCP), host-query vs broadcast, existing middleware (Data Innovations, cobas infinity)?
2. Which analyzers must be live at go-live (top 5 by volume) and vendor engineer availability for interface testing?
3. Auto-validation policy: which tests may auto-final without human review; exclusion groups (ICU/paediatrics/STAT); NABL assessor expectations?
4. QC schedule (levels/day per analyzer), materials in use (Bio-Rad/Randox), Westgard rule combinations currently applied; lockout policy?
5. Serial ports: are serial-to-Ethernet converters available or should the on-prem gateway host serial ports?
6. Retention for raw messages; can vendor engineers see raw logs (PHI)?
7. POCT devices (glucometers, blood gas) in scope now or later; locations?
8. Uptime SLA per vendor contract (for breach reporting)?
