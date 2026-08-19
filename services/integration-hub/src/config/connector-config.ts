/**
 * EN-017 §3.1 / `docs/08` §10.2 — the connector configuration schema.
 *
 * The whole reason this file is strict is stated in EN-017 §14 and in the
 * on-call reality behind it: a connector is configured once, by a person, at
 * 16:00, and then fails at 03:00 in front of nobody. Every check that can be
 * moved to registration time is a page that never happens. So the schema
 * refuses, at registration:
 *
 *   * a literal secret where a Vault reference belongs (§10.2 "secrets are
 *     references only" — a config carrying a real key would then be readable
 *     from `ihub_connectors.endpoint`, which is plain JSONB);
 *   * an endpoint missing the field its own protocol cannot work without
 *     (`host`+`port` for MLLP, `aeTitle` for DICOM, `topic` for MQTT);
 *   * a cross-border flow with no DPA reference (EN-017 §5 blocks these by
 *     default — DPDP Act 2023 requires the transfer basis to be recorded);
 *   * a PHI-bearing connector with no stated purpose (DPDP purpose limitation);
 *   * a retry policy that would retry a non-idempotent operation (EN-017 §5:
 *     "retries never apply to non-idempotent operations without a
 *     partner-supported idempotency key").
 */
import { z } from 'zod';

/** `docs/08` §10.2, plus `null` for the Phase 0 reference connector. */
export const connectorProtocolSchema = z.enum([
  'rest',
  'soap',
  'hl7v2_mllp',
  'astm',
  'fhir',
  'dicom',
  'sftp',
  'file',
  'jdbc',
  'smpp',
  'mqtt',
  'websocket',
  'webhook',
  /**
   * Not in `docs/08` §10.2. Phase 0 ships no live connector and the reference
   * adapter is a loopback with no transport at all; registering it as `rest`
   * would put a falsehood into the DPDP data-flow register, which a DPO reads
   * as a statement of fact about where data goes.
   */
  'null',
]);
export type ConnectorProtocol = z.infer<typeof connectorProtocolSchema>;

export const connectorDirectionSchema = z.enum(['in', 'out', 'both']);
export type ConnectorDirection = z.infer<typeof connectorDirectionSchema>;

export const connectorCategorySchema = z.enum([
  'clinical',
  'diagnostic',
  'financial',
  'messaging',
  'government',
  'erp',
  'device',
  'security',
  'other',
]);
export type ConnectorCategory = z.infer<typeof connectorCategorySchema>;

export const healthCheckKindSchema = z.enum(['ping', 'echo', 'expect_traffic']);
export type HealthCheckKind = z.infer<typeof healthCheckKindSchema>;

/**
 * A pointer into the secret store, never a secret.
 *
 * The scheme is mandatory precisely so that a pasted API key fails validation:
 * `sk_live_9f2…` has no `vault://` prefix, so it can never be mistaken for a
 * reference and silently persisted into a JSONB column that the message log,
 * the connector list endpoint and every backup would then carry.
 */
export const secretRefSchema = z
  .string()
  .min(1)
  .max(300)
  .regex(
    /^(vault|ssm|env|file):\/\/[A-Za-z0-9_\-./:]+$/,
    'must be a secret *reference* such as `vault://hms/connectors/<key>/api_key` — docs/08 §10.2 forbids literal secrets in a connector config',
  );

export const endpointSchema = z
  .object({
    url: z.url().max(2000).optional(),
    host: z.string().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    path: z.string().max(500).optional(),
    topic: z.string().max(255).optional(),
    /** DICOM called-AE title (EN-008 / Orthanc MWL). */
    aeTitle: z.string().max(16).optional(),
    soapAction: z.string().max(255).optional(),
  })
  .strict();
export type ConnectorEndpoint = z.infer<typeof endpointSchema>;

export const authConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('api_key'), header: z.string().min(1).max(64), secretRef: secretRefSchema }),
  z.object({ type: z.literal('basic'), secretRef: secretRefSchema }),
  z.object({
    type: z.literal('oauth2_cc'),
    tokenUrl: z.url(),
    scope: z.string().max(300).optional(),
    secretRef: secretRefSchema,
  }),
  z.object({ type: z.literal('jwt_bearer'), issuer: z.string().min(1).max(255), keyRef: secretRefSchema }),
  z.object({ type: z.literal('mtls'), clientCertRef: secretRefSchema, caRef: secretRefSchema.optional() }),
  z.object({ type: z.literal('hmac'), algorithm: z.enum(['sha256', 'sha512']), secretRef: secretRefSchema }),
  z.object({ type: z.literal('sftp_key'), username: z.string().min(1).max(64), keyRef: secretRefSchema }),
]);
export type ConnectorAuth = z.infer<typeof authConfigSchema>;

export const tlsSchema = z
  .object({
    verify: z.boolean().default(true),
    caRef: secretRefSchema.optional(),
    pinnedSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, 'a pinned certificate fingerprint is 64 hex characters')
      .optional(),
  })
  .strict();

/** `docs/08` §0 retry policy classes R0–R5. */
export const retryPolicyClassSchema = z.enum(['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
export type RetryPolicyClass = z.infer<typeof retryPolicyClassSchema>;

export const retrySchema = z
  .object({
    policy: retryPolicyClassSchema.default('R1'),
    maxAttempts: z.number().int().min(1).max(12).default(5),
    /** R1 default from EN-017 §3.2: 5 s → 10 s → 40 s → 3 min → 15 min. */
    baseDelayMs: z.number().int().min(100).max(3_600_000).default(5_000),
    backoffFactor: z.number().min(1).max(10).default(2),
    maxDelayMs: z.number().int().min(1_000).max(86_400_000).default(900_000),
    /** Deterministic jitter span; the value is derived from the message id, never `Math.random`. */
    jitterMs: z.number().int().min(0).max(300_000).default(2_000),
  })
  .strict();
export type RetryConfig = z.infer<typeof retrySchema>;

export const circuitSchema = z
  .object({
    failureThreshold: z.number().int().min(1).max(1000).default(10),
    errorRatePct: z.number().min(1).max(100).default(50),
    coolDownSec: z.number().int().min(1).max(86_400).default(60),
    /** Half-open lets exactly this many probes through at a time (EN-017 §3.2). */
    halfOpenMaxProbes: z.number().int().min(1).max(10).default(1),
  })
  .strict();
export type CircuitConfig = z.infer<typeof circuitSchema>;

export const rateLimitSchema = z
  .object({
    perMinute: z.number().int().min(1).max(1_000_000).optional(),
    concurrency: z.number().int().min(1).max(256).default(8),
  })
  .strict();

export const healthSchema = z
  .object({
    kind: healthCheckKindSchema,
    intervalSec: z.number().int().min(5).max(86_400).default(60),
    /** Only meaningful for `expect_traffic`: the silence that counts as a fault. */
    expectTrafficWindowMin: z.number().int().min(1).max(1440).optional(),
    /** The side-effect-free operation an `echo` check calls. */
    operationKey: z.string().max(96).optional(),
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
  })
  .strict();
export type HealthConfig = z.infer<typeof healthSchema>;

/**
 * The DPDP record of processing for this flow (EN-017 §3.1.5, §5).
 * `purpose` has a length floor because "integration" is not a purpose.
 */
export const dpdpSchema = z
  .object({
    containsPhi: z.boolean(),
    purpose: z.string().min(10).max(500),
    dataCategories: z.array(z.string().min(1).max(64)).min(1),
    crossBorder: z.boolean().default(false),
    dpaRef: z.string().max(200).optional(),
    legalBasis: z.string().max(200).optional(),
    retentionAtProcessorDays: z.number().int().min(0).max(3650).optional(),
  })
  .strict();

export const operationConfigSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
    name: z.string().min(1).max(200),
    direction: connectorDirectionSchema.default('out'),
    method: z.string().max(32).optional(),
    path: z.string().max(500).optional(),
    timeoutMs: z.number().int().min(100).max(600_000).default(30_000),
    idempotency: z.enum(['none', 'key_header', 'natural_key']).default('none'),
    partitionKeyExpr: z.string().max(300).optional(),
    active: z.boolean().default(true),
  })
  .strict();
export type OperationConfig = z.infer<typeof operationConfigSchema>;

const baseConnectorConfigSchema = z
  .object({
    key: z
      .string()
      .min(1)
      .max(96)
      .regex(/^[a-z0-9_.-]+$/, 'connector keys are lower-case, `[a-z0-9_.-]`'),
    name: z.string().min(1).max(200),
    category: connectorCategorySchema,
    protocol: connectorProtocolSchema,
    direction: connectorDirectionSchema.default('out'),
    environment: z.enum(['sandbox', 'production']).default('sandbox'),
    /** `packageId@version` resolved against the adapter registry. */
    adapter: z.string().min(1).max(160),
    endpoint: endpointSchema.prefault({}),
    auth: authConfigSchema,
    tls: tlsSchema.prefault({}),
    retry: retrySchema.prefault({}),
    circuit: circuitSchema.prefault({}),
    rateLimit: rateLimitSchema.prefault({}),
    health: healthSchema,
    dpdp: dpdpSchema,
    /** EN-017 §5: on-prem connectors must work with the WAN down unless flagged. */
    requiresInternet: z.boolean().default(true),
    /** EN-017 §4: full payloads 30 days unless a legal reason says otherwise. */
    retainPayloadDays: z.number().int().min(1).max(3650).default(30),
    operations: z.array(operationConfigSchema).min(1),
    /** Adapter-specific knobs. Validated by the adapter, opaque to the hub. */
    options: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/** Which endpoint fields a protocol cannot function without. */
const ENDPOINT_REQUIREMENTS: Readonly<Record<ConnectorProtocol, readonly (keyof ConnectorEndpoint)[]>> = {
  rest: ['url'],
  soap: ['url'],
  fhir: ['url'],
  webhook: ['url'],
  hl7v2_mllp: ['host', 'port'],
  astm: ['host', 'port'],
  dicom: ['host', 'port', 'aeTitle'],
  mqtt: ['host', 'port', 'topic'],
  websocket: ['url'],
  smpp: ['host', 'port'],
  sftp: ['host', 'port'],
  jdbc: ['url'],
  file: ['path'],
  null: [],
};

export const connectorConfigSchema = baseConnectorConfigSchema.superRefine((config, ctx) => {
  for (const field of ENDPOINT_REQUIREMENTS[config.protocol]) {
    if (config.endpoint[field] === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['endpoint', field],
        message: `protocol '${config.protocol}' cannot connect without endpoint.${field}`,
      });
    }
  }

  // EN-017 §5 / DPDP Act 2023 §16: a transfer out of India must record its basis.
  if (config.dpdp.crossBorder && (config.dpdp.dpaRef === undefined || config.dpdp.dpaRef.length === 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['dpdp', 'dpaRef'],
      message:
        'a cross-border connector must reference its data-processing agreement before it can be registered (EN-017 §5)',
    });
  }

  // EN-017 §5: retrying a non-idempotent operation is how a partner ends up with
  // three of the same payment. Such an operation must be declared R0.
  if (config.retry.policy !== 'R0' && config.retry.maxAttempts > 1) {
    const unsafe = config.operations.filter((op) => op.idempotency === 'none' && op.direction !== 'in');
    for (const op of unsafe) {
      ctx.addIssue({
        code: 'custom',
        path: ['operations'],
        message: `operation '${op.key}' declares no idempotency, so it may not be retried: set retry.policy to 'R0' or give the operation an idempotency strategy (EN-017 §5)`,
      });
    }
  }

  if (config.health.kind === 'expect_traffic' && config.health.expectTrafficWindowMin === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['health', 'expectTrafficWindowMin'],
      message:
        "an 'expect_traffic' check needs the silence window that counts as a fault — otherwise a dead analyzer never turns amber (EN-017 §3.7)",
    });
  }

  if (config.health.kind === 'echo') {
    const key = config.health.operationKey;
    const target = config.operations.find((op) => op.key === key);
    if (target === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['health', 'operationKey'],
        message: "an 'echo' health check must name one of the connector's operations",
      });
    }
  }

  const seen = new Set<string>();
  for (const op of config.operations) {
    if (seen.has(op.key)) {
      ctx.addIssue({ code: 'custom', path: ['operations'], message: `duplicate operation key '${op.key}'` });
    }
    seen.add(op.key);
  }
});

export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;
export type ConnectorConfigInput = z.input<typeof connectorConfigSchema>;
