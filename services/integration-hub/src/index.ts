/**
 * `@vims/integration-hub` — EN-017 skeleton.
 *
 * Phase 0 deliberately ships **no live connector**: the registry, the adapter
 * contract, the config schema, the PHI-redacted message log, the DLQ, the
 * circuit breaker and the health checks, plus one loopback adapter to prove all
 * of them work. Protocol adapters (HL7 v2 MLLP, ASTM, FHIR R4, DICOM MWL, ABDM,
 * payments, SMS) arrive in Phases 1–3 as new `ConnectorAdapter`s and require no
 * change to anything exported here.
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
export * from './db/database.js';
export * from './logger.js';
export * from './hub.js';
