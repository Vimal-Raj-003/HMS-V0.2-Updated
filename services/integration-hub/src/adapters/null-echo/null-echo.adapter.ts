/**
 * The reference connector. **Not a vendor integration.**
 *
 * `docs/prompts/phase-00-foundation.md` §0.3 ends with "No live connectors yet",
 * and this is what that means in practice: an adapter that opens no socket,
 * resolves no DNS name, holds no credential and sends nothing anywhere. It
 * exists for three reasons:
 *
 *  1. It is the executable specification of `ConnectorAdapter`. When the HL7
 *     MLLP adapter is written in Phase 3, this file is what it is written
 *     against — every method, in the order the hub calls them.
 *  2. It is what the tests exercise. The dispatcher, the retry budget, the DLQ,
 *     the circuit breaker and the message log all need a partner that fails
 *     *on demand and reproducibly*; a real endpoint fails on its own schedule,
 *     which is the opposite of what a test needs.
 *  3. It is a legitimate production connector for exactly one purpose: a
 *     `sink`-mode instance is how a hospital turns an outbound flow off without
 *     tearing the configuration down, and how a migration dry-run proves the
 *     mapping produces something without emitting it.
 *
 * The programmed failures below are configuration, not test scaffolding: EN-017
 * §14 requires that a failure drill ("partner down, credential expired,
 * malformed payload") can be executed against a connector, and this is the
 * connector against which the drill is rehearsed before a real one is wired.
 */
import { z } from 'zod';
import {
  ERROR_CLASSES,
  isRetryableErrorClass,
  type AdapterContext,
  type CanonicalEnvelope,
  type CloseReason,
  type ConnectorAdapter,
  type ConnectorAdapterFactory,
  type ConnectorManifest,
  type DispatchResult,
  type HealthCheckKind,
  type HealthReport,
  type OutboundMessage,
  type RawInbound,
} from '../../adapter/types.js';
import type { ConnectorConfig } from '../../config/connector-config.js';

export const NULL_ECHO_ADAPTER_ID = 'vims.null-echo';
export const NULL_ECHO_ADAPTER_VERSION = '0.1.0';
export const NULL_ECHO_ADAPTER_REF = `${NULL_ECHO_ADAPTER_ID}@${NULL_ECHO_ADAPTER_VERSION}`;

const errorClassSchema = z.enum(ERROR_CLASSES);

/**
 * Rejected rather than thrown. The contract says these methods return a
 * Promise, and a caller that writes `adapter.send(…).catch(…)` — which is legal
 * against that signature — would miss a synchronous throw entirely.
 */
const NOT_CONFIGURED = 'null/echo adapter used before configure() — the hub always configures first';

export const nullEchoOptionsSchema = z
  .object({
    /** `echo` returns the payload; `sink` accepts and discards it. */
    mode: z.enum(['echo', 'sink']).default('echo'),
    /**
     * Reported, never slept. A real `setTimeout` would make every suite that
     * exercises a retry slower and flakier without testing anything the
     * dispatcher does differently.
     */
    latencyMs: z.number().int().min(0).max(60_000).default(0),
    /** Programmed failures, so a drill or a test can drive an exact sequence. */
    failures: z
      .array(
        z
          .object({
            operationKey: z.string().min(1).max(96),
            errorClass: errorClassSchema,
            code: z.string().max(64).optional(),
            /** `'always'`, or the number of consecutive attempts to fail before succeeding. */
            times: z.union([z.number().int().min(1).max(1000), z.literal('always')]).default('always'),
          })
          .strict(),
      )
      .default([]),
    healthStatus: z.enum(['pass', 'warn', 'fail']).default('pass'),
  })
  .strict();

export type NullEchoOptions = z.infer<typeof nullEchoOptionsSchema>;

const nullEchoManifest: ConnectorManifest = {
  id: NULL_ECHO_ADAPTER_ID,
  version: NULL_ECHO_ADAPTER_VERSION,
  name: 'Null / Echo (reference connector)',
  publisher: 'VIMS ENTERPRISE',
  description:
    'Loopback connector with no transport. Reference implementation of the EN-017 adapter contract; also the sink used to disable an outbound flow without deleting its configuration.',
  capabilities: {
    protocols: ['null'],
    directions: ['in', 'out', 'both'],
    healthCheckKinds: ['ping', 'echo'],
    supportsIdempotencyKey: true,
    supportsPartitionedOrdering: true,
    supportsSandbox: true,
    supportsStreamingListener: false,
    requiresInternet: false,
    maxPayloadBytes: 1_048_576,
    operations: [
      {
        key: 'echo',
        name: 'Echo',
        direction: 'both',
        encoding: 'json',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
        sideEffectFree: true,
      },
      {
        key: 'sink',
        name: 'Sink (accept and discard)',
        direction: 'out',
        encoding: 'json',
        idempotency: 'key_header',
        timeoutMs: 5_000,
        sideEffectFree: false,
      },
    ],
  },
};

export const NULL_ECHO_MANIFEST: ConnectorManifest = Object.freeze(nullEchoManifest);

export class NullEchoAdapter implements ConnectorAdapter {
  readonly manifest = NULL_ECHO_MANIFEST;

  private context: AdapterContext | undefined;
  private options: NullEchoOptions = nullEchoOptionsSchema.parse({});
  /** Consecutive failures already served, per operation. Drives `times`. */
  private readonly served = new Map<string, number>();
  private closed = false;

  configure(ctx: AdapterContext): Promise<void> {
    this.context = ctx;
    this.options = nullEchoOptionsSchema.parse(ctx.config.options);
    this.served.clear();
    this.closed = false;
    return Promise.resolve();
  }

  send(operationKey: string, message: OutboundMessage): Promise<DispatchResult> {
    const ctx = this.context;
    if (ctx === undefined) return Promise.reject(new Error(NOT_CONFIGURED));
    if (this.closed) {
      return Promise.resolve({
        status: 'failed',
        errorClass: 'network',
        message: 'adapter is closed',
        retryable: true,
        latencyMs: 0,
      });
    }

    const programmed = this.options.failures.find((f) => f.operationKey === operationKey);
    if (programmed !== undefined) {
      const already = this.served.get(operationKey) ?? 0;
      const shouldFail = programmed.times === 'always' || already < programmed.times;
      if (shouldFail) {
        this.served.set(operationKey, already + 1);
        return Promise.resolve({
          status: 'failed',
          errorClass: programmed.errorClass,
          ...(programmed.code === undefined ? {} : { code: programmed.code }),
          message: `programmed failure ${already + 1}${programmed.times === 'always' ? '' : `/${String(programmed.times)}`} for '${operationKey}'`,
          retryable: isRetryableErrorClass(programmed.errorClass),
          latencyMs: this.options.latencyMs,
        });
      }
    }

    if (!this.manifest.capabilities.operations.some((op) => op.key === operationKey)) {
      return Promise.resolve({
        status: 'failed',
        errorClass: 'not_supported',
        message: `no operation '${operationKey}' on the null/echo connector`,
        retryable: false,
        latencyMs: 0,
      });
    }

    // Sandbox mode is honoured even though there is nothing to suppress: the
    // point is that the code path a real adapter must implement is exercised.
    if (ctx.sandbox) {
      ctx.logger.debug(
        { connectorId: ctx.connectorId, operationKey, messageId: message.messageId },
        'null/echo: sandbox — call recorded, nothing sent',
      );
    }

    return Promise.resolve({
      status: 'acknowledged',
      partnerRef: message.idempotencyKey ?? message.messageId,
      latencyMs: this.options.latencyMs,
      ackCode: 'AA',
      ...(this.options.mode === 'echo' ? { response: message.payload } : {}),
    });
  }

  receive(raw: RawInbound): Promise<CanonicalEnvelope> {
    if (this.context === undefined) return Promise.reject(new Error(NOT_CONFIGURED));
    return Promise.resolve({
      canonicalType: 'Echo',
      operationKey: 'echo',
      ...(raw.sourceRef === undefined ? {} : { providerMessageId: raw.sourceRef }),
      payload: raw.body,
      receivedAt: raw.receivedAt,
    });
  }

  healthCheck(kind: HealthCheckKind): Promise<HealthReport> {
    const ctx = this.context;
    if (ctx === undefined) return Promise.reject(new Error(NOT_CONFIGURED));
    const status = this.options.healthStatus;
    return Promise.resolve({
      status,
      latencyMs: this.options.latencyMs,
      checkedAt: ctx.clock.now(),
      detail: `null/echo ${kind} check (no transport)`,
      ...(status === 'fail' ? { errorClass: 'network' as const } : {}),
    });
  }

  close(reason: CloseReason): Promise<void> {
    this.context?.logger.info({ reason }, 'null/echo adapter closed');
    this.closed = true;
    return Promise.resolve();
  }
}

export const nullEchoFactory: ConnectorAdapterFactory = Object.freeze({
  manifest: NULL_ECHO_MANIFEST,
  refineConfig(config: ConnectorConfig): readonly string[] {
    const parsed = nullEchoOptionsSchema.safeParse(config.options);
    if (parsed.success) return [];
    return parsed.error.issues.map(
      (issue) => `${issue.path.length === 0 ? 'options' : issue.path.join('.')}: ${issue.message}`,
    );
  },
  create(): ConnectorAdapter {
    return new NullEchoAdapter();
  },
});
