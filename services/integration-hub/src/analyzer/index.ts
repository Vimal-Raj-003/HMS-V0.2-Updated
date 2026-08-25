/**
 * EN-004 — the laboratory analyzer interface.
 *
 * Two protocol stacks (`hl7/`, `astm/`), one canonical vocabulary
 * (`canonical.ts`), one store-and-forward pipeline (`ingress.ts` →
 * `forwarder.ts`), and one place where a result crosses out of transport and
 * into the laboratory (`LabResultSink`).
 *
 * `docs/prompts/phase-03` exit gate 7 — "analyzer disconnected for 30 minutes →
 * messages buffer and replay with zero loss; unmatched queue works" — is a
 * property of two files: `ingress.ts` persists before anything is
 * acknowledged, and `forwarder.ts` keeps the queue in order across a
 * downstream outage. `analyzer.integration.spec.ts` proves it against a real
 * PostgreSQL and a real socket.
 */
export * from './canonical.js';
export * from './types.js';
export * from './driver.js';
export * from './mapping.js';
export * from './instrument-store.js';
export * from './message-store.js';
export * from './error-queue.js';
export * from './worklist-cache.js';
export * from './downtime-log.js';
export * from './ingress.js';
export * from './forwarder.js';
export * from './session.js';
export * from './listener.js';
export * from './gateway.js';
export * from './simulator.js';
