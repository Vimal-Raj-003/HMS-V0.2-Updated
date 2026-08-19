/**
 * Test support: a valid null/echo connector configuration, and the knobs a test
 * needs to make it misbehave.
 *
 * Shared rather than duplicated because a fixture copied into three suites
 * drifts, and the copy that drifts is always the one asserting the security
 * property. Exported from the package so `services/api` can register a
 * loopback connector in its own integration tests without re-deriving a valid
 * DPDP block.
 */
import type { ConnectorConfigInput } from '../config/connector-config.js';
import type { ErrorClass } from '../adapter/types.js';
import { NULL_ECHO_ADAPTER_REF } from '../adapters/null-echo/null-echo.adapter.js';

export interface NullEchoFailure {
  readonly operationKey: string;
  readonly errorClass: ErrorClass;
  readonly code?: string;
  readonly times?: number | 'always';
}

export interface NullEchoFixtureOptions {
  readonly key?: string;
  readonly failures?: readonly NullEchoFailure[];
  readonly maxAttempts?: number;
  readonly failureThreshold?: number;
  readonly coolDownSec?: number;
  readonly healthStatus?: 'pass' | 'warn' | 'fail';
  readonly containsPhi?: boolean;
}

/** A configuration that passes `validateConnectorConfig` against `nullEchoFactory`. */
export function nullEchoConnectorConfig(options: NullEchoFixtureOptions = {}): ConnectorConfigInput {
  return {
    key: options.key ?? 'echo-reference',
    name: 'Echo (reference connector)',
    category: 'other',
    protocol: 'null',
    direction: 'out',
    environment: 'production',
    adapter: NULL_ECHO_ADAPTER_REF,
    endpoint: {},
    auth: { type: 'none' },
    tls: { verify: true },
    retry: {
      policy: 'R1',
      maxAttempts: options.maxAttempts ?? 3,
      baseDelayMs: 1_000,
      backoffFactor: 2,
      maxDelayMs: 60_000,
      jitterMs: 0,
    },
    circuit: {
      failureThreshold: options.failureThreshold ?? 3,
      errorRatePct: 50,
      coolDownSec: options.coolDownSec ?? 60,
      halfOpenMaxProbes: 1,
    },
    rateLimit: { concurrency: 4 },
    health: { kind: 'ping', intervalSec: 60 },
    dpdp: {
      containsPhi: options.containsPhi ?? true,
      purpose: 'Phase 0 reference loopback used to exercise the integration hub end to end.',
      dataCategories: ['demographics'],
      crossBorder: false,
    },
    requiresInternet: false,
    retainPayloadDays: 30,
    operations: [
      {
        key: 'echo',
        name: 'Echo',
        direction: 'both',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
      },
    ],
    options: {
      mode: 'echo',
      latencyMs: 0,
      healthStatus: options.healthStatus ?? 'pass',
      failures: (options.failures ?? []).map((f) => ({
        operationKey: f.operationKey,
        errorClass: f.errorClass,
        ...(f.code === undefined ? {} : { code: f.code }),
        times: f.times ?? 'always',
      })),
    },
  };
}

/**
 * A payload carrying the identifiers `docs/04` §2 forbids in a log: an ABHA
 * number, an Indian mobile, an Aadhaar, a name, an address, a date of birth and
 * a free-text clinical note — plus the same identifiers buried inside an HL7 v2
 * string, which is the case a key-based policy alone would miss.
 */
export const PHI_SAMPLE = Object.freeze({
  abhaNumber: '11-2233-4455-6677',
  mobile: '+91 98765 43210',
  aadhaar: '4321 8765 2109',
  patientName: 'Ramesh Kumar Iyer',
  addressLine1: '14/2 Nehru Nagar, Coimbatore',
  dob: '1987-03-11',
  uhid: 'CBE-2026-004821',
  email: 'ramesh.iyer@example.com',
  clinicalNotes: 'Complains of chest pain radiating to the left arm since 06:00.',
  hl7: 'MSH|^~\\&|LAB|CBE|HIS|CBE|20260819||ORU^R01|MSG7\rPID|1||CBE-2026-004821||IYER^RAMESH||19870311|M|||14/2 Nehru Nagar^^Coimbatore^TN^641012||9876543210|||||11-2233-4455-6677',
  orderNumber: 'ORD-99213',
  amount: 1450.5,
});
