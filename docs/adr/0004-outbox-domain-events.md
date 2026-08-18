# ADR-0004 — Transactional outbox for domain events

**Status:** Accepted · 2026-08-17

## Context
Modules must react to each other (an order creates a charge intent; a discharge frees a bed and dispatches
housekeeping) without reaching into each other's tables, and without losing events when a process dies.

## Decision
Every business fact is written to `core.outbox_events` in the *same transaction* as the state change. A worker
relays to Redis Streams; consumers are idempotent (event-id dedupe) and retryable, with a dead-letter queue.

## Consequences
- At-least-once delivery with no dual-write inconsistency.
- Consumers must be written idempotently — this is a review checklist item.
- Event schemas live in `packages/contracts` and are versioned like any other API.
