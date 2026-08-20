/**
 * `vims.sms-dry-run` — an SMS connector that renders, prices, logs and never sends.
 *
 * ### Why a hospital would run this in production
 * TRAI DLT registration takes weeks: a principal entity id, then headers, then
 * every content template, each with its own approval queue. A hospital going
 * live before that finishes still needs the rest of the messaging system
 * working — templates authored and approved internally, triggers wired to
 * `appointment.booked` and `queue.token.issued`, the message log filling, the
 * cost model calibrated, the delivery dashboard showing something. Pointing all
 * of that at a live gateway would send real messages from an unregistered
 * header, which the operator drops silently and which counts against the
 * hospital's DLT standing. Pointing it here does everything except the wire.
 *
 * **The DLT gate is not bypassed.** This adapter takes exactly the payload MSG91
 * takes, and the payload only exists if `DltTemplateRegistry` produced it. A
 * hospital mid-registration configures a provisional entity, registers its
 * templates against it, and watches which ones the registry refuses — which is
 * the list it needs to take to the DLT portal. When the real ids arrive the
 * templates are re-registered and the connector is swapped to MSG91 or Twilio;
 * nothing else in the send path changes.
 *
 * ### And why the test suite uses it
 * The same reason `null-echo` exists: a partner that succeeds and fails on
 * demand and reproducibly. This one additionally understands the messaging
 * payload, so a test can assert what *would* have gone out — including that the
 * DLT template id and the rendered body are the ones the registry approved.
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
  type ConnectorConfig,
  type ConnectorManifest,
  type DispatchResult,
  type HealthCheckKind,
  type HealthReport,
  type OutboundMessage,
  type RawInbound,
} from '../../adapter/types.js';
import { outboundSmsPayloadSchema } from '../../messaging/payload-schemas.js';
import { CANONICAL_DELIVERY_RECEIPT, type DeliveryEnvelopePayload, type DeliveryStatus } from '../../messaging/types.js';

export const DRY_RUN_SMS_ADAPTER_ID = 'vims.sms-dry-run';
export const DRY_RUN_SMS_ADAPTER_VERSION = '0.1.0';
export const DRY_RUN_SMS_ADAPTER_REF = `${DRY_RUN_SMS_ADAPTER_ID}@${DRY_RUN_SMS_ADAPTER_VERSION}`;

const NOT_CONFIGURED = 'dry-run SMS adapter used before configure() — the hub always configures first';

export const dryRunSmsOptionsSchema = z
  .object({
    /**
     * What a delivery webhook would eventually say. `delivered` is the useful
     * default; `undelivered` is how a test drives the WhatsApp -> SMS fallback's
     * own failure path.
     */
    simulatedDeliveryStatus: z
      .enum(['queued', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'expired'])
      .default('delivered'),
    /** Programmed dispatch failures, in the shape `null-echo` uses. */
    failures: z
      .array(
        z
          .object({
            errorClass: z.enum(ERROR_CLASSES),
            code: z.string().max(64).optional(),
            times: z.union([z.number().int().min(1).max(1000), z.literal('always')]).default('always'),
          })
          .strict(),
      )
      .default([]),
    /**
     * How many rendered messages to keep in memory for inspection. Bodies are
     * PHI-bearing by construction (a patient's name is a legitimate DLT
     * variable), so the buffer is small, bounded and never persisted.
     */
    outboxLimit: z.number().int().min(0).max(1000).default(50),
    healthStatus: z.enum(['pass', 'warn', 'fail']).default('pass'),
  })
  .strict();

export type DryRunSmsOptions = z.infer<typeof dryRunSmsOptionsSchema>;

export interface DryRunSmsRecord {
  readonly messageId: string;
  readonly providerMessageId: string;
  readonly mobile: string;
  readonly body: string;
  readonly senderId: string;
  readonly dltTemplateId: string;
  readonly dltEntityId: string;
  readonly templateKey: string;
  readonly segments: number;
  readonly at: Date;
}

const manifest: ConnectorManifest = {
  id: DRY_RUN_SMS_ADAPTER_ID,
  version: DRY_RUN_SMS_ADAPTER_VERSION,
  name: 'SMS (dry run — renders and records, never sends)',
  publisher: 'VIMS ENTERPRISE',
  description:
    'EN-009 SMS connector that performs every step except the network call. Used during DLT onboarding and by the test suite; the DLT template gate applies unchanged.',
  capabilities: {
    // No transport at all, so `null` rather than `rest` — the same reasoning as
    // the reference connector: a `rest` entry here would be a falsehood in the
    // DPDP data-flow register a DPO reads as a statement of fact.
    protocols: ['null'],
    directions: ['in', 'out', 'both'],
    healthCheckKinds: ['ping', 'echo'],
    supportsIdempotencyKey: false,
    supportsPartitionedOrdering: true,
    supportsSandbox: true,
    supportsStreamingListener: false,
    requiresInternet: false,
    maxPayloadBytes: 64_000,
    operations: [
      {
        key: 'sendSms',
        name: 'Send SMS (dry run)',
        direction: 'out',
        encoding: 'json',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
        // Nothing leaves the process, so this genuinely is side-effect free —
        // which is what makes an `echo` health check legal here and not on the
        // adapters that actually reach a gateway.
        sideEffectFree: true,
      },
      {
        key: 'deliveryReceipt',
        name: 'Delivery receipt (simulated)',
        direction: 'in',
        encoding: 'json',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
        sideEffectFree: true,
      },
    ],
  },
};

export const DRY_RUN_SMS_MANIFEST: ConnectorManifest = Object.freeze(manifest);

export class DryRunSmsAdapter implements ConnectorAdapter {
  readonly manifest = DRY_RUN_SMS_MANIFEST;

  private context: AdapterContext | undefined;
  private options: DryRunSmsOptions = dryRunSmsOptionsSchema.parse({});
  private readonly outboxBuffer: DryRunSmsRecord[] = [];
  private served = 0;
  private closed = false;

  configure(ctx: AdapterContext): Promise<void> {
    this.context = ctx;
    this.options = dryRunSmsOptionsSchema.parse(ctx.config.options);
    this.outboxBuffer.length = 0;
    this.served = 0;
    this.closed = false;
    return Promise.resolve();
  }

  /** What would have been sent, newest last. Bounded by `outboxLimit`. */
  get outbox(): readonly DryRunSmsRecord[] {
    return this.outboxBuffer;
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
    if (operationKey !== 'sendSms') {
      return Promise.resolve({
        status: 'failed',
        errorClass: 'not_supported',
        message: `no operation '${operationKey}' on the dry-run SMS connector`,
        retryable: false,
        latencyMs: 0,
      });
    }

    const programmed = this.options.failures[0];
    if (programmed !== undefined) {
      const shouldFail = programmed.times === 'always' || this.served < programmed.times;
      if (shouldFail) {
        this.served += 1;
        return Promise.resolve({
          status: 'failed',
          errorClass: programmed.errorClass,
          ...(programmed.code === undefined ? {} : { code: programmed.code }),
          message: 'programmed dry-run failure',
          retryable: isRetryableErrorClass(programmed.errorClass),
          latencyMs: 0,
        });
      }
    }

    const parsed = outboundSmsPayloadSchema.safeParse(message.payload);
    if (!parsed.success) {
      // Exactly what a real gateway would reject, caught before a hospital
      // discovers it on the day it switches to one.
      return Promise.resolve({
        status: 'failed',
        errorClass: 'validation',
        code: 'PAYLOAD_INVALID',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        retryable: false,
        latencyMs: 0,
        mappingPath: parsed.error.issues[0]?.path.join('.') ?? 'payload',
      });
    }

    const payload = parsed.data;
    const providerMessageId = `dryrun:${message.messageId}`;
    if (this.options.outboxLimit > 0) {
      this.outboxBuffer.push({
        messageId: message.messageId,
        providerMessageId,
        mobile: payload.mobile,
        body: payload.body,
        senderId: payload.senderId,
        dltTemplateId: payload.dltTemplateId,
        dltEntityId: payload.dltEntityId,
        templateKey: payload.templateKey,
        segments: payload.segments,
        at: ctx.clock.now(),
      });
      while (this.outboxBuffer.length > this.options.outboxLimit) this.outboxBuffer.shift();
    }

    ctx.logger.debug(
      {
        connectorId: ctx.connectorId,
        templateKey: payload.templateKey,
        dltTemplateId: payload.dltTemplateId,
        segments: payload.segments,
      },
      'dry-run SMS: rendered and recorded, nothing sent',
    );

    return Promise.resolve({
      status: 'acknowledged',
      partnerRef: providerMessageId,
      latencyMs: 0,
      ackCode: 'AA',
      response: { providerMessageId, dryRun: true },
    });
  }

  /**
   * Turns a simulated callback into the same canonical envelope a real gateway
   * produces, so the delivery-status path is exercised without a webhook.
   * `raw.body` is `{ providerMessageId, status? }`.
   */
  receive(raw: RawInbound): Promise<CanonicalEnvelope> {
    if (this.context === undefined) return Promise.reject(new Error(NOT_CONFIGURED));

    const shape = z
      .object({
        providerMessageId: z.string().min(1),
        status: z
          .enum(['queued', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'expired'])
          .optional(),
        errorCode: z.string().max(64).optional(),
      })
      .strict()
      .safeParse(raw.body);

    if (!shape.success) {
      return Promise.reject(
        new Error(
          `dry-run SMS receive() expects { providerMessageId, status? }: ${shape.error.issues
            .map((i) => i.message)
            .join('; ')}`,
        ),
      );
    }

    const status: DeliveryStatus = shape.data.status ?? this.options.simulatedDeliveryStatus;
    const payload: DeliveryEnvelopePayload = {
      receipts: [
        {
          providerMessageId: shape.data.providerMessageId,
          status,
          at: raw.receivedAt,
          providerStatus: `dryrun:${status}`,
          ...(shape.data.errorCode === undefined ? {} : { errorCode: shape.data.errorCode }),
        },
      ],
      inbound: [],
    };

    return Promise.resolve({
      canonicalType: CANONICAL_DELIVERY_RECEIPT,
      operationKey: 'deliveryReceipt',
      providerMessageId: shape.data.providerMessageId,
      payload,
      receivedAt: raw.receivedAt,
    });
  }

  healthCheck(kind: HealthCheckKind): Promise<HealthReport> {
    const ctx = this.context;
    if (ctx === undefined) return Promise.reject(new Error(NOT_CONFIGURED));
    const status = this.options.healthStatus;
    return Promise.resolve({
      status,
      latencyMs: 0,
      checkedAt: ctx.clock.now(),
      detail: `dry-run SMS ${kind} check (no gateway)`,
      ...(status === 'fail' ? { errorClass: 'network' as const } : {}),
    });
  }

  close(reason: CloseReason): Promise<void> {
    this.context?.logger.info({ reason }, 'dry-run SMS adapter closed');
    this.closed = true;
    this.outboxBuffer.length = 0;
    return Promise.resolve();
  }
}

export const dryRunSmsFactory: ConnectorAdapterFactory = Object.freeze({
  manifest: DRY_RUN_SMS_MANIFEST,
  refineConfig(config: ConnectorConfig): readonly string[] {
    const parsed = dryRunSmsOptionsSchema.safeParse(config.options);
    if (parsed.success) return [];
    return parsed.error.issues.map(
      (issue) => `${issue.path.length === 0 ? 'options' : issue.path.join('.')}: ${issue.message}`,
    );
  },
  create(): ConnectorAdapter {
    return new DryRunSmsAdapter();
  },
});
