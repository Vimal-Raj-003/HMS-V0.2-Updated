# ADR-0001 — Modular monolith for the API, not microservices

**Status:** Accepted · 2026-08-17

## Context
A single hospital transaction spans many domains (an admission touches patient, bed, billing, insurance, pharmacy,
diet, nursing). The team is small (1–3 developers plus Claude Code). The system must be operable inside a hospital
data centre by that hospital's IT staff.

## Options
1. Microservices per domain from day one.
2. Modular monolith with hard internal boundaries.
3. Unstructured monolith.

## Decision
Option 2. One deployable `services/api` with module boundaries enforced by ESLint import rules, per-module owned
tables, typed service interfaces and domain events. Separate processes only where the runtime demands it:
realtime (WebSockets), worker (queues), integration-hub (TCP/MLLP, vendor SDKs), ai (Phase 12), print-agent (LAN).

## Consequences
- Transactional integrity across domains stays simple and correct.
- Deployment and on-prem handover stay simple (fewer moving parts for hospital IT).
- We must actively police boundaries or the monolith rots — hence the CI boundary test.
- Extracting a hot module later (LIS, billing) is mechanical because schema, interface and events already exist.
