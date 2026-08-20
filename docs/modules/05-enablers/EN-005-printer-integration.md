# EN-005 — Printer Integration (Print Service Agent, Print Queue, Template Mapping, ZPL/ESC-POS, Auto-print Rules, Browser Fallback, Kiosk)

| Field           | Value                                                                                                                                                                                                                                                                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain          | Enabler                                                                                                                                                                                                                                                                                                                                                                              |
| Module ID       | EN-005                                                                                                                                                                                                                                                                                                                                                                               |
| Phase           | 0/1                                                                                                                                                                                                                                                                                                                                                                                  |
| Priority        | P1 (token/receipt/label printing needed from Phase 1 go-live)                                                                                                                                                                                                                                                                                                                        |
| Complexity      | Low–Medium                                                                                                                                                                                                                                                                                                                                                                           |
| Depends on      | EN-039 (print templates/letterheads), EN-013 (barcode/label content), EN-007 (locations, devices, settings), EN-024 (print audit for PHI), EN-037 (alerts), NC-028 (helpdesk tickets), EN-034 (kiosk), consumers: EN-006 (tokens), OP-005/NC-001 (bills/receipts), OP-004 (labels/reports), OP-003 (Rx/med labels), IP-001 (wristbands), OP-002 (prescriptions), NC-002 (asset tags) |
| Feature flag    | `module.print.enabled` (sub: `print.agent`, `print.autoprint`, `print.cloud`, `print.cost_tracking`)                                                                                                                                                                                                                                                                                 |
| Primary roles   | IT Admin / Helpdesk (56), Receptionist (24), Cashier (26), Lab Technician (33), Pharmacist (30), Nurse (17), Branch Admin (3)                                                                                                                                                                                                                                                        |
| Secondary roles | all staff who print; Hospital Admin (policies); Auditor (print logs)                                                                                                                                                                                                                                                                                                                 |
| Regulatory      | DPDP (PHI on paper — print audit, secure release), GST invoice format (OP-005), NABL report format (OP-004), NABH wristband ID standard (2 identifiers), CDSCO/Drugs Rules label content (OP-003)                                                                                                                                                                                    |

## 1. Purpose

EN-005 lets a browser-based cloud/on-prem HMS print reliably to local thermal (ESC/POS), label (ZPL/EPL/TSPL), laser (A4/A5 PDF) and dot-matrix printers on the hospital LAN through a lightweight **Print Service Agent** (Windows service/Linux daemon/Docker) that polls or receives jobs over WebSocket, plus a central print queue with retries, per-document-type printer mapping by location/user/counter, auto-print rules on events, print logs, printer discovery/health, and browser-print fallback when no agent is available.

## 2. Users & Jobs-to-be-done

- **Receptionist/Cashier** (desktop + thermal): token slip, OP receipt, appointment slip auto-printed with zero dialogs; reprint with reason.
- **Lab tech/phlebotomist** (desktop/tablet + label printer): sample labels (2–6 per order) printed at the collection point.
- **Pharmacist**: bill + medication labels; **Nurse**: wristbands, IV labels; **Doctor**: prescription/report to nearest A4.
- **IT Admin**: register printers, install agents, map document types per location/counter, monitor queue/health, resolve failures, cost reports.
- **Kiosk** (EN-034): unattended token/receipt printing via device token.

## 3. Core Workflows

### 3.1 Printer & agent registration

1. IT installs **Print Agent** on a PC/server on the LAN → agent shows pairing code → IT enters code in Admin console → agent gets scoped device token (`print.agent`) → agent registers itself, OS printers detected (auto-discovery: local, USB, IPP/LPD/RAW 9100 network printers via mDNS/SNMP scan) → IT confirms/one-click adds → `print_printers` (name, type thermal/label/laser/dot_matrix, driver mode: raw ZPL/ESC-POS/PDF-to-driver, paper size, DPI, location, department, counter, capabilities: duplex/colour/cutter/cash-drawer kick) → Event `print.printer.registered`.
2. Health: agent heartbeat 30 s, printer status (SNMP/OS spooler: online/offline/paper-out/toner-low/door-open) → dashboard; offline → alert IT (EN-037), auto-fallback printer per mapping.

### 3.2 Document type → printer mapping

- Admin maps **document type** (token, op_receipt, ip_receipt, bill_a4, lab_label, lab_report, wristband, med_label, prescription, discharge_summary, asset_tag, dispatch_note, queue_ticket, cssd_label…) → **printer resolution rule** ordered by specificity: user override → counter/workstation → location/department → branch default; with per-type template (EN-039), copies, tray/paper, duplex policy (eco: default duplex for A4 internal docs) → `print_mappings`.
- Workstation identity: browser gets a `workstation_id` (cookie/device registration in EN-007) so mappings can target a physical desk; kiosks/TVs use device tokens.

### 3.3 Print job flow

1. Module calls `PrintService.print({docType, payload|fileId, context:{hospital,branch,workstation,user}, copies, priority})` → server renders (Playwright HTML→PDF for laser; template engine → ZPL/ESC-POS bytes for label/thermal; PDF-to-raster for thermal images e.g. QR) → job row `print_jobs` (status `queued`) → routed to printer via mapping → pushed to agent over WebSocket (fallback: agent polls every 5 s) → agent spools → status `printing → completed` (or `failed` with error) → Event `print.job.completed|failed`.
2. Retry policy: transient (offline/paper-out) retries every 30 s for 10 min then failed with alert & UI toast offering reprint/other printer; permanent errors immediate fail.
3. **Browser fallback**: if no agent covers the workstation → open print-ready PDF/HTML in new tab with auto `window.print()` (silent print for kiosk Chrome `--kiosk-printing`); thermal ESC/POS via WebUSB/Web Serial optional (Chrome) as secondary fallback.
4. Reprint: from job history with reason (mandatory for receipts/bills/reports; audited); reprints watermark "DUPLICATE" where legally required (receipts, GST invoices, reports).
5. Secure/pull printing (option): PHI documents held until user badges/scan at printer (agent-side release) — enhancement.

### 3.4 Auto-print rules

- Admin configures rules: event → doc type → condition → target (e.g. `queue.token.issued` → token → counter printer; `bill.finalized` → receipt (1 copy) + bill A4 if amount > X; `lab.result.final` → report at collection centre printer if patient opted "collect print"; `ip.admission.created` → wristband at ward printer; `rx.dispensed` → med labels; `cssd.pack.created` → label) → `print_rules`; consumers via outbox events; per-user toggle "auto-print on my counter".

### 3.5 Label & thermal template engine

- Templates in `packages/print-templates`: ZPL (label printers 203/300 dpi with GS1 barcodes: `^BC` Code128, `^BX` DataMatrix, `^BQ` QR), ESC/POS (58/80 mm: logo bitmap, bold, QR via `GS ( k`, cutter, drawer kick), A4/A5 HTML (letterhead, header/footer, page numbers). Variables from payload; preview in admin; per-hospital overrides (EN-039); test print.

### 3.6 Print log & cost tracking

- Every job: who, when, doc type, printer, pages, copies, PHI flag, patient id (hashed link), reprint reason → `print_jobs` (retained 1 year) → EN-024 for PHI documents; **cost tracking** (`print.cost_tracking`): per-printer cost per page (mono/colour/label) → department cost report; eco policy (duplex default, colour restrictions by role).

### 3.7 Kiosk & mobile

- Kiosk (EN-034): local thermal via agent on kiosk PC or USB WebUSB; mobile apps (OP-019/IP-004): "print to nearest" chooses printer by location/Bluetooth-paired label printer (Zebra/TSC via Web Bluetooth) — enhancement.

## 4. Data Model (schema `core`, prefix `print_`)

- `print_agents` — id, hospital_id, branch_id, name, host, os, version, device_token_id, last_heartbeat_at, status, ip, capabilities jsonb.
- `print_printers` — id, hospital_id, branch_id, agent_id, name, type (thermal/label/laser/dot_matrix/pdf_virtual), connection (agent_os_printer/raw_tcp/ipp/usb/bluetooth), address, driver_mode (raw_zpl/raw_escpos/raw_tspl/pdf), paper (58mm/80mm/A4/A5/label_2x1/label_4x6/wristband), dpi, location_id, department_id, counter_id, capabilities jsonb, cost_per_page jsonb, status, last_status_at, active. UNIQUE(hospital_id, name).
- `print_mappings` — id, hospital_id, branch_id, doc_type, scope_type (user/workstation/counter/location/department/branch), scope_id, printer_id, template_key, copies, options jsonb (duplex, tray, colour), priority.
- `print_rules` — id, hospital_id, event_type, doc_type, condition jsonb, target_scope, copies, active.
- `print_jobs` — id, hospital_id, branch_id, doc_type, template_key, printer_id, agent_id, requested_by, workstation_id, source_module, source_ref (bill_id/sample_id…), patient_id?, phi (bool), payload_ref/file_id, format (zpl/escpos/pdf), copies, pages, status (queued/sent/printing/completed/failed/cancelled/fallback_browser), attempts, error, is_reprint, reprint_reason, created_at, completed_at; partitioned monthly; index (hospital_id, created_at desc), (printer_id, status).
- `print_templates` (owned by EN-039; keyed by doc_type/format/version) referenced here.
- `print_workstations` — id, hospital_id, branch_id, name, fingerprint, counter_id, location_id, default_printers jsonb, last_seen.

### 4.1 Document type catalogue (defaults; hospital may add)

| doc_type                                              | Format              | Default printer class               | Default auto-print event             | Copies                 | Legal/duplicate rule              |
| ----------------------------------------------------- | ------------------- | ----------------------------------- | ------------------------------------ | ---------------------- | --------------------------------- |
| `token`                                               | ESC/POS 58/80 mm    | thermal at counter/kiosk            | `queue.token.issued`                 | 1                      | reprint free                      |
| `appointment_slip`                                    | ESC/POS or A5       | thermal/laser                       | on demand                            | 1                      | —                                 |
| `op_receipt` / `advance_receipt`                      | ESC/POS 80 mm or A5 | thermal/laser                       | `receipt.created`                    | 1 (+1 office copy opt) | DUPLICATE watermark, reason       |
| `bill_a4` / `ip_final_bill` / `gst_invoice`           | A4 PDF              | laser                               | `bill.finalized` (IP: on demand)     | 1–2                    | gapless numbering; DUPLICATE      |
| `lab_label`                                           | ZPL 50×25           | label at collection point           | `lab.order.collection_started`       | per container          | relabel workflow after collection |
| `lab_report` / `rad_report`                           | A4 PDF              | laser at lab/collection centre      | `lab.result.final` (if opted)        | 1                      | DUPLICATE + "reprint" audit       |
| `wristband`                                           | ZPL band            | wristband printer at ward/admission | `ip.admission.created`               | 1                      | reissue deactivates old           |
| `patient_card`                                        | PVC/A4              | card/laser                          | `patient.registered` (policy)        | 1                      | —                                 |
| `prescription` / `discharge_summary` / `consent_form` | A4/A5 PDF           | laser near doctor/ward              | on demand / `ip.discharge.finalized` | 1                      | versions marked                   |
| `med_label` / `iv_label`                              | ZPL 50×30           | pharmacy/ward label                 | `rx.dispensed`                       | per item               | —                                 |
| `stores_label` / `asset_tag` / `cssd_label`           | ZPL                 | stores/BME/CSSD label               | GRN / asset create / pack            | per item               | —                                 |
| `dispatch_note` / `indent` / `po` / `grn`             | A4                  | laser                               | on demand                            | 1                      | —                                 |
| `visitor_pass`                                        | ESC/POS or card     | gate thermal                        | `pass.issued`                        | 1                      | —                                 |
| `queue_ticket_kiosk`                                  | ESC/POS             | kiosk thermal                       | kiosk token                          | 1                      | —                                 |

## 5. Business Rules & Validations

- Reprint of receipts/GST invoices/lab reports requires reason and prints "DUPLICATE"; original print count tracked.
- PHI documents printed to a printer in another branch require `print.cross_branch` (default deny).
- Auto-print rules only for whitelisted events; per-workstation opt-out; STAT lab labels bypass queue priority (priority 1).
- Job payload never contains raw PHI beyond what the document shows; jobs older than 24 h in `queued` auto-cancel with notification.
- Agent tokens scoped per branch; agent can only fetch jobs for its printers; mutual TLS/pinned cert optional on-prem.
- Duplex default for A4 internal documents (eco), simplex for patient-facing legal docs (configurable).
- Retention: job metadata 1 year; rendered files 7 days (S3 lifecycle) except regenerated on demand from source.

## 6. API Surface (`/api/v1/print`)

| Method         | Path                                                                                                                                           | Purpose                                     | Permission                                            | Notes                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------- | ---------------------------------- |
| POST           | /agents/pair {code} ; GET /agents ; PATCH /agents/:id                                                                                          | agent lifecycle                             | admin.print.configure                                 |                                    |
| WS             | /agents/stream (device token)                                                                                                                  | job push, heartbeat, status                 | print.agent (device)                                  | fallback GET /agents/:id/jobs/poll |
| POST           | /agents/:id/discover                                                                                                                           | trigger printer discovery                   | admin.print.configure                                 |                                    |
| GET/POST/PATCH | /printers ; /printers/:id ; POST /printers/:id/test                                                                                            | printers                                    | admin.print.configure                                 |                                    |
| GET/PUT        | /mappings ; /rules                                                                                                                             | mapping & auto-print rules                  | admin.print.configure                                 |                                    |
| POST           | /jobs                                                                                                                                          | create job (module-internal + user "print") | print.job.create                                      | Idempotency-Key                    |
| GET            | /jobs?status&printer&user&from ; GET /jobs/:id ; POST /jobs/:id/reprint {reason} ; POST /jobs/:id/cancel ; POST /jobs/:id/redirect {printerId} | queue ops                                   | print.job.read / print.job.reprint / print.job.manage |                                    |
| POST           | /agents/:id/jobs/:jobId/status                                                                                                                 | agent status callback                       | print.agent                                           |                                    |
| GET            | /resolve?docType&workstation                                                                                                                   | which printer would be used                 | print.job.create                                      | UI hint                            |
| GET            | /templates/:docType/preview                                                                                                                    | render preview                              | admin.print.configure                                 |                                    |
| GET            | /reports/volume ; /reports/cost ; /reports/health                                                                                              | analytics                                   | admin.print.read                                      | MV                                 |
| GET            | /me/workstation ; PUT /me/workstation                                                                                                          | register this browser as workstation        | print.job.create                                      |                                    |

## 7. Domain Events (outbox)

- `print.printer.registered|offline|online|paper_out|error` → EN-037 IT, NC-028 auto-ticket after 15 min offline.
- `print.job.queued|sent|completed|failed|cancelled|reprinted` → source module UI toast; EN-024 for PHI docs.
- `print.rule.triggered` → trace.

## 8. Screens

- **Print Admin Console** (desktop): agents list (status, version, update), printers grid (status chips, location, type, test print), discovery wizard, mapping matrix (doc type × scope), auto-print rules, template preview.
- **Print Queue Dashboard** (desktop, IT/TV): live queue by printer, failed jobs with retry/redirect, throughput; real-time WS; filters.
- **User Print Panel** (in-app drawer, all devices): my recent jobs, status, reprint with reason, choose printer override for this session, "auto-print on this counter" toggle; shortcut `Ctrl+P` intercepts to HMS print for supported screens; `Ctrl+Shift+P` printer picker.
- **Kiosk**: silent print status icon; out-of-paper message with staff call.
- Offline (PWA): print requests queued in IndexedDB and flushed; browser fallback prints locally cached PDF if present.

## 9. Integrations

- Print Agent (Node/Go binary, MSI/DEB/Docker): OS spooler (Windows GDI/IPP, CUPS), raw TCP 9100, USB (libusb), Bluetooth (label printers); auto-update channel; logs to Loki. Zebra/TSC/Godex label printers (ZPL/TSPL), Epson/TVS/Bixolon thermal (ESC/POS), HP/Canon lasers (PDF/IPP), Epson LQ dot-matrix (ESC/P). Cloud printing (`print.cloud`): agent at remote clinic pulls jobs over internet (mTLS). Playwright PDF renderer in worker; EN-039 templates; EN-013 barcode symbologies.

## 10. Reports & Analytics

- Print volume by printer/department/doc type/user, failure rate & reasons, printer uptime, cost per department (pages × rate), reprint audit (PHI documents), consumables alerts (toner/label roll low), eco compliance (duplex %). MV `analytics.mv_print_daily`.

## 11. Notifications

- IT: printer offline/paper-out/error, agent down, job failure spike; user toast: job failed → retry/redirect; helpdesk auto-ticket (NC-028) on persistent failure; monthly cost report to Admin.

## 12. Permissions (RBAC keys)

`admin.print.configure` (IT Admin, Branch Admin) · `admin.print.read` · `print.job.create` (all staff) · `print.job.read` (own; IT all) · `print.job.reprint` (role-scoped: cashier receipts, lab reports…) · `print.job.manage` (IT: cancel/redirect any) · `print.cross_branch` · `print.agent` (device token) · `print.template.configure` (Admin via EN-039).

## 13. Non-functional

- 5000 OP visits/day → ~25k print jobs/day (tokens, receipts, labels, reports); job creation → agent delivery p95 < 500 ms; token/label render < 100 ms; A4 PDF render < 1.5 s (pre-rendered on event where possible).
- Agent memory < 100 MB, restart-safe, offline buffer of jobs; supports 50 printers per agent.
- Security: device tokens, TLS, no PHI in agent logs (job ids only), rendered files short-lived signed URLs.
- Accessibility/i18n: templates multilingual (labels English + local language lines), RTL support in HTML templates; wristband font/contrast per NABH.

## 14. Acceptance Criteria

1. Given a mapped thermal printer on a counter, when a token is issued at that counter, then the slip prints within 1 s with no browser dialog.
2. Given the printer is out of paper, when a job is sent, then it retries every 30 s for 10 min, the user sees a toast with "redirect to another printer", and IT gets an alert.
3. Given no agent for the workstation, when a user prints a bill, then a print-ready PDF opens with the browser print dialog (fallback) and the job is logged as `fallback_browser`.
4. Given a receipt already printed, when reprinted, then a reason is required, the copy shows "DUPLICATE" and the audit log records user/reason.
5. Given a lab order with 4 containers, when collection labels are printed, then 4 ZPL labels with correct barcodes print in order on the phlebotomy label printer.
6. Given an auto-print rule for `bill.finalized`, when the bill is finalised at counter C3, then the receipt prints on C3's mapped printer only.
7. Given an agent offline, when it reconnects, then queued jobs (< 24 h) are delivered once (idempotent) and older ones are cancelled with notice.
8. Given a kiosk device token, when a token is issued at kiosk, then it prints silently and the kiosk shows the job status.
9. Given a user without `print.cross_branch`, when selecting a printer in another branch for a PHI document, then the request is denied.
10. Given the printer discovery run, when network printers respond via mDNS/SNMP, then they appear as candidates with model & IP for one-click registration.
11. Given a template preview, when rendered with sample data, then ZPL/ESC-POS output and PDF preview both display and a test print can be sent.
12. Given month-end, when the cost report runs, then pages per department × cost/page totals are shown with duplex compliance %.

## 15. Enhancements / Later phases

- Mobile printing from doctor/nurse apps (Bluetooth label printers, "print to nearest"), patient self-service report kiosk (EN-034: print reports by UHID+OTP), print cost tracking per department (`print.cost_tracking`), eco-friendly print policy (duplex/greyscale defaults, quotas), cloud printing for remote locations (`print.cloud`), secure pull-printing with badge release, PDF/A archival of printed legal documents, printer consumables auto-reorder (NC-006), e-receipt-first mode (WhatsApp receipt instead of paper, EN-009).

## 16. Open Questions for the Hospital

1. Printer inventory by location: models, connection (USB/network), thermal widths (58/80 mm), label sizes, wristband printers?
2. Is a Windows PC available per counter/collection point to host the agent, or a central print server per floor?
3. Which documents must auto-print vs print-on-demand (tokens, receipts, labels, reports)? Number of copies for receipts/bills?
4. Duplicate print policy for receipts/GST invoices/reports and who may reprint?
5. Letterhead/pre-printed stationery vs full-page rendering for bills and reports?
6. Any remote clinics/collection centres needing cloud printing?
7. Print cost tracking requirement and current page rates (mono/colour/label)?
