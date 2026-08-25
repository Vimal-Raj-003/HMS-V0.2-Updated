/**
 * `@vims/integration-hub` — EN-017 skeleton.
 *
 * Phase 0 deliberately ships **no live connector**: the registry, the adapter
 * contract, the config schema, the PHI-redacted message log, the DLQ, the
 * circuit breaker and the health checks, plus one loopback adapter to prove all
 * of them work. Protocol adapters (HL7 v2 MLLP, ASTM, FHIR R4, DICOM MWL, ABDM,
 * payments) arrive in Phases 1–3 as new `ConnectorAdapter`s and require no
 * change to anything exported here.
 *
 * Phase 1 adds the first live ones: EN-009 messaging — MSG91, Twilio, WhatsApp
 * Cloud and a dry-run SMS connector — plus the TRAI DLT template registry, the
 * consent/DND ledger and the cost ledger they sit behind. They are
 * `ConnectorAdapter`s like any other, and adding them changed nothing in the
 * contract, which was the point of writing the contract first.
 */
export * from './adapter/types.js';
export * from './config/connector-config.js';
export * from './config/validate.js';
export * from './redaction/phi-redactor.js';
export * from './registry/adapter-registry.js';
export * from './registry/connector-registry.js';
export * from './messages/message-log.js';
export * from './circuit/circuit-breaker.js';
export * from './circuit/circuit-store.js';
export * from './dlq/dead-letter-queue.js';
export * from './dispatch/dispatcher.js';
export * from './health/health-check-runner.js';
export * from './payload/payload-store.js';
export * from './adapters/null-echo/null-echo.adapter.js';
export * from './adapters/dry-run-sms/dry-run-sms.adapter.js';
export * from './adapters/msg91/msg91.adapter.js';
export * from './adapters/twilio/twilio.adapter.js';
export * from './adapters/whatsapp-cloud/whatsapp-cloud.adapter.js';
export * from './messaging/index.js';
export * from './db/database.js';
export * from './logger.js';
export * from './hub.js';

// EN-004 — the laboratory analyzer interface (Phase 3).
export * from './hl7/index.js';
export * from './astm/index.js';
export * from './analyzer/index.js';
