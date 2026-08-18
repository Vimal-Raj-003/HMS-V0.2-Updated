# PHASE 13 — NATIVE MOBILE APPS

Phases 0–12 complete: every role already has an installable PWA. This phase builds native apps only where the
browser genuinely cannot deliver — and keeps the PWA as the definition of what the product does.

## Read first
`CLAUDE.md`, `docs/PROGRESS.md`, then: **OP-019** (doctor app — read §3.5 offline and its conflict rules
carefully), **IP-010** (doctor IP mobile: rounds, orders, discharge initiation), **IP-004** (nurse app — bedside
identification, barcode MAR, offline), **OP-020** (patient app), **NC-014** (staff utility app), plus
**EN-037** (push, escalation, delivery receipts), **EN-009** (SMS fallback), **EN-013** (barcode/QR),
**EN-020** (biometric), **EN-025/EN-007** (auth, device sessions), **EN-042** (BLE devices),
**EN-040** (licence/entitlement), and `docs/02-tech-stack-decision.md` (Expo/React Native decision),
`docs/06-ui-ux-design-system.md` (tokens), `docs/04-security-compliance.md` (device security, DPDP),
`docs/07-performance-scalability.md` (offline and sync budgets).

Plan first; wait for "go". **Build order: shared foundation (contracts, tokens, auth, sync engine, push) →
nurse app (IP-004, the hardest and the most valuable) → doctor app (OP-019 + IP-010) → staff app (NC-014) →
patient app (OP-020) → store submission and MDM.** Ship one app to a real device fleet before starting the next.

## Goal

A nurse on a ward with dead Wi-Fi scans a wristband and a drug barcode, gives a dose, and it is recorded — and it
still records when she walks into the lift. A doctor's phone buzzes for a critical potassium at 2 a.m. and the
system knows whether the buzz arrived, escalating to SMS and then to a second doctor when it did not. Nothing in
these apps is a feature the PWA does not have; everything in them is a capability the browser could not deliver
reliably.

## Deliverables

### 13.1 Shared foundation — build once, use in all four apps
- **Expo (managed workflow with config plugins) + React Native + TypeScript**, in `apps/mobile-*` inside the same
  monorepo, consuming the *same* `packages/contracts` (Zod schemas, DTOs, event types, score functions) and
  `packages/ui` **design tokens** — colours, spacing, typography, elevation, semantic clinical colours — exported
  in a platform-neutral form so the native theme is generated from the same source as the web theme, not hand-copied.
  A contract change must break the mobile build in CI, not at runtime on a ward.
- Shared `packages/mobile-kit`: auth and device session, secure storage, the sync engine, the push client,
  barcode/BLE wrappers, telemetry, error reporting, feature flags and licence entitlement, i18n, and the shared
  clinical components (patient banner, allergy chip, alert card, scan field) built to the same tokens.
- **Auth**: OIDC/password login through the same EN-007 service, device registration and named device sessions,
  **biometric unlock backed by the platform keystore/Secure Enclave** (never a stored password), short-lived access
  tokens with rotating refresh and reuse detection, and re-authentication on privilege escalation.
- **Sync engine**: a local durable store (SQLite with SQLCipher), an outbox with client id, **idempotency key**,
  `base_version` and device timestamp plus monotonic offset, ordered per-aggregate delivery, exponential backoff,
  and a visible "Offline — N pending" state with per-item status and a retry/discard control (discard requires a
  reason for clinical items).
- **Conflict resolution implements the per-entity rules already written in the specs — do not invent new ones**:
  clinical documents are append-only versions and an offline draft becomes a new version or a flagged addendum,
  never an overwrite; a prescription conflicting with one signed online becomes a draft with a conflict banner; a
  duplicate order within the dedupe window is merged server-side and the user told; queue and task actions are
  last-writer-wins only if the transition is still valid; acknowledgements are idempotent with earliest-ack wins;
  **CDSS re-runs on sync and a hard-stop firing on a synced prescription puts it on hold and blocks pharmacy**;
  clock skew over 5 minutes is flagged.
- **Release and update strategy**: OTA updates for JS-only changes with a signed channel and a rollback path, a
  **minimum-supported-version check that forces an update** when a contract changes incompatibly, staged rollout,
  and crash/ANR monitoring per build.

### 13.2 What actually needs to be native — and what does not
Justify each app against this list, and do not build native screens for anything outside it:
- **Background push reliability.** Web Push cannot be trusted for a critical-result alert on a locked phone across
  Android OEM battery managers and iOS. FCM/APNs with high-priority channels, a full-screen critical alert
  category, and a bypass of Do-Not-Disturb for the clinical-critical channel.
- **Hardware.** Ruggedised barcode scanners and sled devices, camera-based scanning at ward speed, **BLE** vitals
  monitors, glucometers, temperature probes and label printers (EN-042/EN-005), NFC wristbands where used.
- **Offline durability.** A twelve-hour shift's worth of encrypted local clinical data, surviving app kills, OS
  memory pressure and reboots — beyond what IndexedDB gives reliably.
- **Biometric keystore.** Hardware-backed key storage for unlock and for signing.
- Everything else — layout, lists, forms, charts — stays in the PWA and is *linked to* from the app where useful.

### 13.3 Nurse app (IP-004)
Shift start with device and ward binding; **wristband-first bedside identification** (no patient action without a
scan); bedside vitals with BLE capture and manual fallback; **barcode medication verification enforcing the
5 Rights, high-alert second-nurse witness and coded reasons for missed or refused doses — the same server-side
rules as Phase 7, re-validated on the server on sync, never trusted from the device**; task list and completion;
wound and clinical photo capture with on-device encryption and no camera-roll persistence; push alerts with
escalation; and a full offline shift.

### 13.4 Doctor app (OP-019 + IP-010)
Live OPD queue and IP rounds lists; patient chart read with the offline cache described in OP-019 §3.5 (today's
queue, summaries of queued patients, problems/allergies/meds/last vitals, a reference-data subset, own drafts);
mobile consultation and note dictation; **mobile orders and prescriptions with server-side CDSS on sync**;
discharge initiation from the phone; critical-result and escalation push with acknowledgement; secure team chat;
and the earnings view from NC-034. PHI cache purges 24 hours after last use, on logout and on remote wipe.

### 13.5 Staff app (NC-014)
Directory, geo-fenced attendance punching (with NC-029/EN-020), leave and approvals, payslips and documents,
announcements, roster and shift swaps, helpdesk tickets, cafeteria, and the SOS button with location — the app most
staff will actually install, and therefore the one that carries enterprise enrolment for everyone else.

### 13.6 Patient app (OP-020)
Login by OTP or ABHA with biometric unlock, appointments and live queue position, records and reports, bills and
payments, family profiles, reminders and notifications, and in-app services. This app inherits the Phase 10 threat
model in full — plus mobile-specific items: certificate pinning, jailbreak/root detection with a documented policy,
screenshot restriction on record screens, deep-link validation, and no PHI in notification payloads (the
notification says "a report is ready", the app fetches it after authentication).

### 13.7 Push notification reliability for critical alerts
This is the deliverable that justifies the phase — treat it as an engineering problem with an SLA, not a feature.
- Per-channel setup: FCM and APNs with high-priority/critical categories, Android notification channels per
  severity that the user cannot silence for clinical-critical, iOS critical-alert entitlement where granted, and
  OEM battery-optimisation exemption prompts during onboarding.
- **Delivery receipts end to end**: sent → provider-accepted → device-delivered → displayed → acknowledged, each
  timestamped and stored against the EN-037 notification, with per-device and per-user reliability statistics.
- **Escalation fallback ladder**: no device acknowledgement within the alert's timer → re-push → **SMS via EN-009**
  → voice call via EN-033 where configured → escalate to the next person on the NC-030 roster → to the duty
  supervisor. Every hop recorded. **No PHI at any hop.**
- A **heartbeat**: apps register liveness so the server knows a device is unreachable *before* a critical alert is
  sent, and routes around it.
- Token lifecycle: silent re-registration, stale-token cleanup, and one user across multiple devices handled
  deterministically (acknowledge on one clears the others).

### 13.8 Store compliance, distribution and device management
- **App store compliance**: health-data declarations and privacy nutrition labels for both stores, data-safety
  forms matching what the apps actually collect, permission usage strings that are honest, account-deletion path
  required by both stores (wired to the Phase 10 DSAR flow), age rating, and medical-app review notes explaining
  that the apps are hospital-workflow tools with a named intended use (consistent with the Phase 12 SaMD ADR).
- **India data residency**: state where data is stored and processed in the store listings and the privacy policy,
  match it to the tenant's configured region, and support on-prem tenants whose apps must talk only to a
  hospital-hosted endpoint — **server URL is provisioned, not compiled in**, and is validated against an allow-list.
- **Enterprise distribution and MDM** for staff apps: Apple Business Manager / Managed Google Play, managed app
  configuration to pre-provision the tenant, server URL and branch, per-app VPN where required, and enrolment that
  does not require a personal store account. Patient app ships to the public stores.
- **Device loss and remote wipe**: an admin console listing enrolled devices with last seen, app version, OS
  version and patch state; a remote wipe that clears the encrypted local store, revokes tokens and terminates
  sessions on next contact, with an offline grace policy (local data self-destructs after N days without a
  successful server contact); automatic wipe on repeated biometric failure, on detected root/jailbreak per policy,
  and on employee exit from NC-010.

### 13.9 Testing, telemetry and the parity contract
Detox or Maestro end-to-end tests on real devices for the golden paths; **an offline test matrix** (airplane mode,
lift-flapping connectivity, app killed mid-sync, device clock changed, battery saver, OS reinstalled); barcode and
BLE tests against real hardware in CI where possible and against simulators otherwise; push-delivery tests on
physical Android OEM devices (Xiaomi, Oppo, Vivo, Samsung) because that is where push quietly dies; accessibility
(TalkBack/VoiceOver, dynamic type, contrast); and per-build crash-free-session and cold-start metrics.
**The parity contract**: a `docs/mobile-parity.md` matrix listing every mobile screen against its PWA equivalent,
with the rule that **the PWA is the source of truth for feature parity** — a capability ships on the web first (or
simultaneously), and a mobile-only capability requires an ADR justifying why it cannot exist on the web.

## Constraints & watch-outs
- **The PWA remains the source of truth.** These apps are clients of the same API, the same contracts and the same
  server-side rules. No business rule, no safety check and no calculation may exist only in the app.
- **Never trust the device.** The 5 Rights, high-alert witness, CDSS, tariff resolution and every authorisation are
  re-evaluated server-side on sync. An offline "success" is provisional until the server agrees, and the UI must
  say so.
- **Offline data is encrypted at rest and has a lifetime.** SQLCipher with a keystore-held key, PHI purged 24 hours
  after last use, on logout, on wipe, and after N days without server contact. No PHI in logs, crash reports,
  analytics events or notification payloads.
- Performance budgets: cold start < 2 s on a mid-range Android, scan-to-confirmation < 500 ms, sync of a full shift
  queue < 10 s on 3G, crash-free sessions ≥ 99.5 %, battery drain measured over a simulated 12-hour shift and
  reported per build.
- Do not fork the design system, do not fork the API client, and do not create a `mobile` branch of a domain rule.
  Four apps sharing one foundation is the whole point; four apps drifting apart is the failure mode.
- Every app is licence- and flag-gated exactly like a web module, respects tenant branding, and works in the
  hospital's languages including patient-facing strings.

## Exit gate
1. One contract change in `packages/contracts` breaks all four mobile builds in CI, and the design tokens in the
   apps are demonstrably generated from `packages/ui` rather than duplicated.
2. Nurse app: a full simulated shift offline — 40 bedside identifications, vitals, and 60 medication
   administrations with barcode scanning, including a high-alert second-nurse witness — then reconnect and every
   record lands exactly once, with server-side re-validation catching a deliberately invalid dose that had
   "succeeded" offline.
3. Kill the app mid-sync, reboot the device, change the clock, and re-open: no data loss, no duplicates, skew
   flagged.
4. Doctor app: an order and a prescription created offline sync with CDSS re-run; a hard-stop allergy fires on sync,
   the prescription goes on hold and pharmacy is blocked; a note conflicting with a version signed on desktop
   becomes a flagged addendum, never an overwrite.
5. Critical-alert delivery: on four physical Android OEM devices and one iPhone, a critical result reaches the
   locked screen, delivery receipts are recorded at every stage, and a deliberately unacknowledged alert escalates
   re-push → SMS → roster next person, with no PHI at any hop and the full ladder in the audit.
6. Kill a device (airplane mode, then powered off): the server detects unreachability by heartbeat and routes the
   next critical alert around it. Barcode scanning works with the ward's actual scanner and with the camera; a BLE
   vitals monitor and a BLE label printer pair and work; manual entry remains available everywhere.
7. Biometric unlock is backed by the hardware keystore; five failures fall back to password; a rooted device is
   handled per the documented policy.
8. Remote wipe from the admin console clears local data and revokes sessions; a device with no server contact for
   the configured period self-wipes; an employee exit in NC-010 triggers the same.
9. Staff and doctor apps install via MDM with managed configuration (tenant, server URL, branch) and no personal
    store account; the patient app passes store review with correct health-data declarations, data-safety forms,
    residency statements and a working in-app account-deletion path.
10. Performance and stability: cold start, scan-to-confirmation, shift sync, crash-free sessions and 12-hour battery
    drain all within budget and reported per build; accessibility passes with TalkBack and VoiceOver.
11. `docs/mobile-parity.md` exists, is complete, and shows no mobile-only capability without an ADR.
12. Previous gates green; `docs/PROGRESS.md` updated.
