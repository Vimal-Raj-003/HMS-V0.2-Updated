# ADR-0005 — PWA first, React Native later

**Status:** Accepted · 2026-08-17

## Context
Four mobile personas are required (doctor, nurse, patient, staff). Building four native apps before the hospital
can use the system at all would delay go-live by months.

## Decision
Ship an installable, offline-tolerant PWA from Phase 0 covering desktop, tablet, phone, TV and kiosk. Build Expo
React Native apps in Phase 13, sharing `packages/contracts` and design tokens, only where native is genuinely
better: background push reliability, BLE/hardware barcode, durable offline storage, biometric keystore, MDM.

## Consequences
- One codebase reaches a working hospital fastest; feature parity is defined by the PWA.
- Some native-grade experiences (guaranteed background push) are deferred; critical alerts therefore also fall back
  to SMS until Phase 13.
