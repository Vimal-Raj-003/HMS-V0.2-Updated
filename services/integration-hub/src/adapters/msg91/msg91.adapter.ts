/**
 * `vims.msg91` — MSG91 SMS, the default Indian gateway (`docs/08` §102).
 *
 * ### Two MSG91 behaviours this adapter exists to contain
 *
 *  1. **A failure arrives as HTTP 200.** `POST /api/v2/sendsms` answers
 *     `{"type":"error","message":"..."}` with a 200 status for an invalid
 *     authkey, an unregistered DLT template id, a bad sender header and an
 *     unroutable number. An adapter that classifies on status code alone
 *     reports every one of those as `sent`, the message log shows a healthy
 *     connector, and the hospital finds out from a patient. So the body is
 *     inspected before the status is trusted.
 *  2. **There is no webhook signature.** MSG91 publishes no HMAC scheme for its
 *     delivery reports. The honest response is not to pretend: the connector is
 *     refused at registration unless a shared webhook token is configured, and
 *     the token is compared in constant time (`http/signature.ts`). An
 *     IP allowlist at the edge is the second half and belongs in the ingress,
 *     not here.
 *
 * `DLT_TE_ID` is sent explicitly rather than using MSG91's flow templates: the
 * body we render is the one `DltTemplateRegistry` proved equal to the registered
 * content, and letting MSG91 re-render from its own copy of the template would
 * put a second, unverified source of truth between us and the operator.
 */
import { z } from 'zod';
import {
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
import { secretRefSchema } from '../../config/connector-config.js';
import { failureFromResponse, failureFromTransport, parseJson } from '../../messaging/http/errors.js';
import { verifySharedToken } from '../../messaging/http/signature.js';
import { fetchHttpTransport, type HttpTransport } from '../../messaging/http/transport.js';
import { outboundSmsPayloadSchema } from '../../messaging/payload-schemas.js';
import {
  CANONICAL_DELIVERY_RECEIPT,
  WebhookSignatureError,
  type DeliveryEnvelopePayload,
  type DeliveryReceipt,
  type DeliveryStatus,
  type InboundMessage,
} from '../../messaging/types.js';

export const MSG91_ADAPTER_ID = 'vims.msg91';
export const MSG91_ADAPTER_VERSION = '0.1.0';
export const MSG91_ADAPTER_REF = `${MSG91_ADAPTER_ID}@${MSG91_ADAPTER_VERSION}`;

const NOT_CONFIGURED = 'MSG91 adapter used before configure()';

export const msg91OptionsSchema = z
  .object({
    /**
     * MSG91 has no webhook HMAC. A shared token on the callback URL is the only
     * thing standing between a public endpoint and anyone who can mark a
     * critical alert delivered, so it is required rather than optional.
     */
    webhookTokenRef: secretRefSchema,
    /** Header name the callback carries the shared token in. */
    webhookTokenHeader: z.string().min(1).max(64).default('x-vims-webhook-token'),
    /** Default country for numbers MSG91 wants without a `+`. */
    country: z
      .string()
      .regex(/^\d{1,3}$/)
      .default('91'),
    /** MSG91 route ids. 4 = transactional/service, 1 = promotional. */
    transactionalRoute: z.string().min(1).max(8).default('4'),
    promotionalRoute: z.string().min(1).max(8).default('1'),
  })
  .strict();

export type Msg91Options = z.infer<typeof msg91OptionsSchema>;

const manifest: ConnectorManifest = {
  id: MSG91_ADAPTER_ID,
  version: MSG91_ADAPTER_VERSION,
  name: 'MSG91 (SMS)',
  publisher: 'VIMS ENTERPRISE',
  description: 'EN-009 SMS gateway adapter for MSG91, with DLT template id passthrough and delivery reports.',
  capabilities: {
    protocols: ['rest'],
    directions: ['in', 'out', 'both'],
    healthCheckKinds: ['ping', 'expect_traffic'],
    /**
     * MSG91 honours no idempotency key. `validateConnectorConfig` turns this
     * into a hard rule at registration: the connector must be retry policy R0
     * with a single attempt. That is the correct outcome and EN-017 §5 says why
     * — "retrying against a partner with no idempotency support is how a patient
     * receives three SMS". Recovery is the WhatsApp/SMS fallback and DLQ replay,
     * both of which a human or a policy decides, not a loop.
     */
    supportsIdempotencyKey: false,
    supportsPartitionedOrdering: false,
    supportsSandbox: true,
    supportsStreamingListener: false,
    requiresInternet: true,
    maxPayloadBytes: 32_000,
    operations: [
      {
        key: 'sendSms',
        name: 'Send SMS',
        direction: 'out',
        method: 'POST',
        path: '/api/v2/sendsms',
        encoding: 'json',
        idempotency: 'natural_key',
        timeoutMs: 10_000,
        sideEffectFree: false,
      },
      {
        key: 'deliveryReceipt',
        name: 'Delivery report webhook',
        direction: 'in',
        method: 'POST',
        encoding: 'json',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
        sideEffectFree: true,
      },
    ],
  },
};

export const MSG91_MANIFEST: ConnectorManifest = Object.freeze(manifest);

/**
 * MSG91 delivery-report codes. Anything unlisted is treated as `failed` rather
 * than ignored: an unknown code from a gateway is a message whose fate is
 * unknown, and `docs/04` §7 forbids treating that as success.
 */
const MSG91_STATUS: Readonly<Record<string, DeliveryStatus>> = Object.freeze({
  '1': 'delivered',
  delivered: 'delivered',
  DELIVRD: 'delivered',
  '2': 'failed',
  failed: 'failed',
  FAILED: 'failed',
  '9': 'queued',
  queued: 'queued',
  '17': 'undelivered',
  blocked: 'undelivered',
  '16': 'undelivered',
  rejected: 'undelivered',
  REJECTD: 'undelivered',
  '25': 'undelivered',
  '7': 'expired',
  EXPIRED: 'expired',
  expired: 'expired',
  sent: 'sent',
  '3': 'sent',
});

function mapMsg91Status(raw: string): DeliveryStatus {
  return MSG91_STATUS[raw] ?? MSG91_STATUS[raw.toUpperCase()] ?? 'failed';
}

const msg91ReportSchema = z.object({
  requestId: z.string().min(1).optional(),
  request_id: z.string().min(1).optional(),
  report: z
    .array(
      z.object({
        number: z.string().optional(),
        status: z.union([z.string(), z.number()]),
        desc: z.string().optional(),
        date: z.string().optional(),
      }),
    )
    .optional(),
  // The flat form MSG91 uses for single reports.
  status: z.union([z.string(), z.number()]).optional(),
  desc: z.string().optional(),
  date: z.string().optional(),
});

export class Msg91Adapter implements ConnectorAdapter {
  readonly manifest = MSG91_MANIFEST;

  private context: AdapterContext | undefined;
  private options: Msg91Options = msg91OptionsSchema.parse({ webhookTokenRef: 'vault://placeholder' });
  private authKey = '';
  private webhookToken = '';
  private closed = false;

  constructor(private readonly transport: HttpTransport) {}

  async configure(ctx: AdapterContext): Promise<void> {
    this.context = ctx;
    this.options = msg91OptionsSchema.parse(ctx.config.options);
    this.closed = false;

    const auth = ctx.config.auth;
    if (auth.type !== 'api_key') {
      throw new Error(`MSG91 needs an 'api_key' auth block carrying the authkey, not '${auth.type}'`);
    }
    // Resolved once. The value never lands on the config object, so serialising
    // the config — which is what an error reporter does — cannot leak it.
    this.authKey = await ctx.secrets.resolve(auth.secretRef);
    this.webhookToken = await ctx.secrets.resolve(this.options.webhookTokenRef);
  }

  async send(operationKey: string, message: OutboundMessage): Promise<DispatchResult> {
    const ctx = this.context;
    if (ctx === undefined) throw new Error(NOT_CONFIGURED);
    if (this.closed) {
      return {
        status: 'failed',
        errorClass: 'network',
        message: 'adapter is closed',
        retryable: true,
        latencyMs: 0,
      };
    }
    if (operationKey !== 'sendSms') {
      return {
        status: 'failed',
        errorClass: 'not_supported',
        message: `no operation '${operationKey}' on the MSG91 connector`,
        retryable: false,
        latencyMs: 0,
      };
    }

    const parsed = outboundSmsPayloadSchema.safeParse(message.payload);
    if (!parsed.success) {
      return {
        status: 'failed',
        errorClass: 'validation',
        code: 'PAYLOAD_INVALID',
        message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        retryable: false,
        latencyMs: 0,
        mappingPath: parsed.error.issues[0]?.path.join('.') ?? 'payload',
      };
    }
    const payload = parsed.data;

    if (message.sandbox || message.suppressSideEffects) {
      // EN-017 §3.8 / §3.6: record the call, do not make it. A replay must not
      // re-notify a patient about an appointment they attended a week ago.
      ctx.logger.debug(
        { connectorId: ctx.connectorId, templateKey: payload.templateKey },
        'MSG91: sandbox/replay — call recorded, nothing sent',
      );
      return {
        status: 'acknowledged',
        partnerRef: `sandbox:${message.messageId}`,
        latencyMs: 0,
        response: { sandbox: true },
      };
    }

    const base = (ctx.config.endpoint.url ?? '').replace(/\/+$/, '');
    const started = ctx.clock.now();
    const body = JSON.stringify({
      sender: payload.senderId,
      route:
        payload.dltCategory === 'promotional'
          ? this.options.promotionalRoute
          : this.options.transactionalRoute,
      country: this.options.country,
      DLT_TE_ID: payload.dltTemplateId,
      // MSG91 wants the entity id on the account, but echoing it makes the
      // outbound call self-describing in a packet capture during onboarding.
      PE_ID: payload.dltEntityId,
      sms: [{ message: payload.body, to: [payload.mobile.replace(/^\+/, '')] }],
    });

    let response;
    try {
      response = await this.transport.send(
        {
          method: 'POST',
          url: `${base}/api/v2/sendsms`,
          headers: { authkey: this.authKey, 'content-type': 'application/json', accept: 'application/json' },
          body,
        },
        message.timeoutMs,
      );
    } catch (error) {
      return failureFromTransport(error, elapsed(ctx, started));
    }

    const latencyMs = elapsed(ctx, started);
    const parsedBody = parseJson(response.body);
    const envelope = z
      .object({ type: z.string().optional(), message: z.string().optional() })
      .safeParse(parsedBody);

    if (response.status >= 400) {
      return failureFromResponse({
        response,
        latencyMs,
        now: ctx.clock.now(),
        code: 'MSG91_HTTP',
        ...(envelope.success && envelope.data.message !== undefined
          ? { message: envelope.data.message }
          : {}),
      });
    }

    // The 200-with-error case. Everything about this adapter's error handling
    // exists because of this branch.
    if (envelope.success && envelope.data.type === 'error') {
      const detail = envelope.data.message ?? 'MSG91 reported an error with no message';
      const errorClass = /authkey|auth/i.test(detail)
        ? ('auth' as const)
        : /template|dlt|sender|header/i.test(detail)
          ? ('validation' as const)
          : ('semantic_4xx' as const);
      return {
        status: 'failed',
        errorClass,
        code: 'MSG91_ERROR',
        message: detail,
        retryable: false,
        latencyMs,
        httpStatus: response.status,
      };
    }

    const providerMessageId = envelope.success ? envelope.data.message : undefined;
    if (providerMessageId === undefined || providerMessageId.length === 0) {
      return {
        status: 'failed',
        errorClass: 'schema_drift',
        code: 'MSG91_NO_REQUEST_ID',
        message: 'MSG91 answered 2xx without a request id, so the delivery report could never be matched',
        retryable: false,
        latencyMs,
        httpStatus: response.status,
      };
    }

    return {
      status: 'sent',
      partnerRef: providerMessageId,
      latencyMs,
      httpStatus: response.status,
      response: { providerMessageId },
    };
  }

  /**
   * Delivery reports. `raw.body` must be the **raw request text** so the shared
   * token can be checked before anything is parsed.
   */
  receive(raw: RawInbound): Promise<CanonicalEnvelope> {
    if (this.context === undefined) return Promise.reject(new Error(NOT_CONFIGURED));

    const presented = headerValue(raw.headers, this.options.webhookTokenHeader);
    if (!verifySharedToken({ presented, expected: this.webhookToken })) {
      return Promise.reject(
        new WebhookSignatureError(
          'MSG91',
          `the shared token in '${this.options.webhookTokenHeader}' is missing or wrong. MSG91 publishes no HMAC scheme, so this token and an ingress IP allowlist are the whole of the authentication.`,
        ),
      );
    }

    const text = typeof raw.body === 'string' ? raw.body : JSON.stringify(raw.body);
    const decoded = parseJson(text);
    const list = Array.isArray(decoded) ? decoded : [decoded];

    const receipts: DeliveryReceipt[] = [];
    for (const item of list) {
      const parsed = msg91ReportSchema.safeParse(item);
      if (!parsed.success) continue;
      const requestId = parsed.data.requestId ?? parsed.data.request_id;
      if (requestId === undefined) continue;

      const rows =
        parsed.data.report ??
        (parsed.data.status === undefined
          ? []
          : [
              {
                status: parsed.data.status,
                ...(parsed.data.desc === undefined ? {} : { desc: parsed.data.desc }),
                ...(parsed.data.date === undefined ? {} : { date: parsed.data.date }),
              },
            ]);

      for (const row of rows) {
        const providerStatus = String(row.status);
        receipts.push({
          providerMessageId: requestId,
          status: mapMsg91Status(providerStatus),
          at: parseDate(row.date) ?? raw.receivedAt,
          providerStatus,
          ...(row.desc === undefined ? {} : { errorText: row.desc }),
          ...(row.desc === undefined ? {} : { errorCode: providerStatus }),
        });
      }
    }

    const payload: DeliveryEnvelopePayload = { receipts, inbound: [] as readonly InboundMessage[] };
    return Promise.resolve({
      canonicalType: CANONICAL_DELIVERY_RECEIPT,
      operationKey: 'deliveryReceipt',
      ...(receipts[0] === undefined ? {} : { providerMessageId: receipts[0].providerMessageId }),
      payload,
      receivedAt: raw.receivedAt,
    });
  }

  async healthCheck(kind: HealthCheckKind): Promise<HealthReport> {
    const ctx = this.context;
    if (ctx === undefined) throw new Error(NOT_CONFIGURED);
    const started = ctx.clock.now();
    const base = (ctx.config.endpoint.url ?? '').replace(/\/+$/, '');
    try {
      // Balance is the natural probe: read-only, cheap, and a low balance is the
      // failure that stops a hospital's messaging without anything erroring.
      const response = await this.transport.send(
        {
          method: 'GET',
          url: `${base}/api/balance.php?type=4`,
          headers: { authkey: this.authKey, accept: 'application/json' },
        },
        5_000,
      );
      const latencyMs = elapsed(ctx, started);
      if (response.status >= 400) {
        return {
          status: 'fail',
          latencyMs,
          checkedAt: ctx.clock.now(),
          detail: `MSG91 ${kind}: HTTP ${String(response.status)}`,
          errorClass: response.status === 401 ? 'auth' : 'partner_5xx',
        };
      }
      const balance = Number.parseFloat(response.body.trim());
      if (Number.isFinite(balance) && balance <= 0) {
        return {
          status: 'warn',
          latencyMs,
          checkedAt: ctx.clock.now(),
          detail: 'MSG91 credit balance is zero',
        };
      }
      return { status: 'pass', latencyMs, checkedAt: ctx.clock.now(), detail: `MSG91 ${kind} ok` };
    } catch (error) {
      return {
        status: 'fail',
        latencyMs: elapsed(ctx, started),
        checkedAt: ctx.clock.now(),
        detail: error instanceof Error ? error.message : 'MSG91 probe failed',
        errorClass: 'network',
      };
    }
  }

  close(reason: CloseReason): Promise<void> {
    this.context?.logger.info({ reason }, 'MSG91 adapter closed');
    this.closed = true;
    this.authKey = '';
    this.webhookToken = '';
    return Promise.resolve();
  }
}

export function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

export function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

function elapsed(ctx: AdapterContext, started: Date): number {
  return Math.max(0, ctx.clock.now().getTime() - started.getTime());
}

/**
 * The transport is injected into the factory rather than reached for inside
 * `send()`, which is what makes the adapter testable with no network.
 */
export function createMsg91Factory(transport: HttpTransport = fetchHttpTransport()): ConnectorAdapterFactory {
  return Object.freeze({
    manifest: MSG91_MANIFEST,
    refineConfig(config: ConnectorConfig): readonly string[] {
      const parsed = msg91OptionsSchema.safeParse(config.options);
      if (!parsed.success) {
        return parsed.error.issues.map(
          (issue) => `${issue.path.length === 0 ? 'options' : issue.path.join('.')}: ${issue.message}`,
        );
      }
      if (config.auth.type !== 'api_key') {
        return ["MSG91 authenticates with an `authkey`, so auth.type must be 'api_key'"];
      }
      return [];
    },
    create(): ConnectorAdapter {
      return new Msg91Adapter(transport);
    },
  });
}

export const msg91Factory: ConnectorAdapterFactory = createMsg91Factory();
