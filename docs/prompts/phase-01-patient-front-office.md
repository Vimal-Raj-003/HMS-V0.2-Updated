# PHASE 1 — PATIENT & FRONT OFFICE CORE

Phase 0 is complete and its exit gate passed. Now the hospital's front door.

## Read first

`CLAUDE.md`, `docs/PROGRESS.md`, then the specs:
**OP-001** (front office & registration), **EN-006** (queue), **EN-018** (TV/signage), **EN-009** (SMS & WhatsApp),
**EN-011** (ABDM/ABHA — M1 only in this phase), **EN-013** (barcode/QR), **EN-028** (consent),
**EN-027** (master data), **NC-001** (cash counter), **EN-036** (data import — patient bulk load only),
**EN-005** (printers), **EN-037** (notifications).
Also `docs/06-ui-ux-design-system.md` §PatientBanner and the worklist archetype.

Plan first, then wait for my "go".

## Goal

A real patient can walk in, be registered once and never re-keyed, get an appointment or a walk-in token, be
called to the right room, pay at a counter, and receive messages — on desktop, tablet and the lobby TV.

## Deliverables

### 1.1 Master data (EN-027)

Departments, specialities, doctors (with schedule templates, fees, registration numbers), service catalogue,
rooms/counters, holidays, ID types, relationships, occupation/religion/area masters, ICD-10 loader,
title/language/nationality. Effective-dated with approval (EN-038). Import via EN-036 templates.

### 1.2 Patient master / MPI (OP-001)

- Registration form: mandatory minimum vs full; photo capture (webcam/phone); ID capture with **Aadhaar stored
  masked (last 4 + hash) only**; address with PIN-code lookup; emergency contact; payer type (self/corporate/
  insurance/scheme); consent capture (EN-028) with DPDP notice text.
- **UHID** from numbering series; barcode/QR patient card + wristband template (EN-013).
- **Search that is actually fast:** mobile / UHID / name / ABHA / ID, trigram + prefix indexes, ≤ 200 ms p95 on
  1 M patients. Recent-patients list. Scan-to-find.
- **Duplicate prevention on create** (deterministic mobile+DOB+name, fuzzy score) and a governed **merge workflow**
  (preview impact, reversible, fully audited, events emitted so downstream modules re-point).
- Patient 360 header (`PatientBanner`), demographics edit with audit, alerts/allergies (structured, drives EN-029
  later), relationships & family linking, VIP/staff/employee flags, deceased handling.
- Bulk import of legacy patients (EN-036) with a reconciliation report.

### 1.3 ABDM M1 (EN-011)

ABHA create (Aadhaar OTP / mobile OTP / demographic), ABHA verify & link to patient, **scan & share QR** intake,
care-context linking with V3 linking-token persistence, HFR facility registration config, HPR practitioner mapping,
consent artefacts stored. Sandbox config toggle. M2/M3 are **not** in this phase — leave the interfaces.

### 1.4 Appointments (OP-001)

Doctor schedule templates (weekly slots, session capacity, buffer, overbooking policy, leave/blocks), slot search
across doctors/specialities, book/reschedule/cancel with reason, waitlist, recurring appointments, teleconsult slot
type (flag only), no-show marking, online-booking API for the website/portal (used in Phase 10), advance payment
link (EN-010 arrives Phase 5 — leave a stub that records "payment pending"), reminders via EN-009.

### 1.5 Queue & tokens (EN-006 + EN-018)

Check-in (counter, kiosk stub, QR self check-in), token issue per service/doctor, priority rules (emergency, senior
citizen, differently-abled, appointment vs walk-in ratio), call-next / recall / skip / hold / transfer, room
assignment, live position + estimated wait, realtime push to doctor dashboard (built in Phase 2) and to
**TV boards** with TTS announcements in the hospital's languages, queue analytics (wait time, throughput, no-show).
Daily auto-reset. Offline degradation: tokens keep issuing from a local sequence block.

### 1.6 Cash counter (NC-001)

Counter setup, shift open with opening float, collections by mode (cash/card/UPI/cheque/wallet), split payment,
advance collection, refunds (with approval via EN-038), denomination sheet, shift close with variance,
daily collection summary, handover to accounts, **§269ST cash cap enforcement**, receipt printing (thermal + A5).
Bills themselves come in Phase 5 — this phase records receipts against advances and consultation fees.

### 1.7 Messaging (EN-009 + EN-037)

Gateway adapters (MSG91/Gupshup/Twilio + WhatsApp Cloud API), DLT template registry, template master with
variables, event-driven triggers (registered, appointment booked/reminder/cancelled, token called, receipt),
delivery webhooks & status, DND/opt-out ledger (DPDP + TRAI), retry & fallback (WhatsApp → SMS), cost tracking,
per-tenant sender config. Multi-language templates.

### 1.8 Screens

Registration desk (single-screen, keyboard-first, ⌘K, scanner-ready), appointment book (day/week, drag to
reschedule), queue console, TV board (from `apps/tv-kiosk`), cash counter, patient 360, merge tool, admin masters,
messaging templates & logs. All responsive; registration must be fully operable **without a mouse**.

## Constraints & watch-outs

- Registration is the highest-traffic screen in the hospital: **budget ≤ 90 seconds for a new patient, ≤ 20 seconds
  for a repeat**, and prove it in the demo.
- Never block registration on ABHA, payment, or an external service being down — degrade and queue.
- Every write emits its domain events (`patient.registered`, `appointment.booked`, `queue.token.issued`, …); later
  phases depend on them.
- No PHI in SMS/WhatsApp content beyond what the template approval allows.

## Exit gate

1. Register 3 patients (new, repeat, emergency-minimal) end-to-end; UHID card and wristband print correctly.
2. A deliberate duplicate is caught on create; a merge is performed and fully audited; nothing is lost.
3. Book, reschedule and cancel an appointment; the patient receives all three messages; delivery status shown.
4. Walk-in and appointment patients interleave correctly in the queue; TV board calls the token with audio in
   English + one Indian language; doctor room display updates within 1 second.
5. Cashier opens a shift, takes cash + UPI + split payment, issues a refund with approval, closes with a variance
   of zero, and the denomination sheet balances.
6. ABHA created via mobile OTP in sandbox and linked; scan & share intake works; linking token persisted.
7. 1 M-row patient search stays under 200 ms p95 (k6 script committed).
8. Kill the SMS provider and the internet: registration, tokens and cash still work; messages queue and flush on recovery.
9. All Phase-0 gates still green; `docs/PROGRESS.md` updated.
