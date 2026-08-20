/**
 * `vims.whatsapp-cloud` — Meta WhatsApp Cloud API (`docs/08` §104).
 *
 * ### Why this adapter only sends templates
 * A business cannot open a WhatsApp conversation with free text. Outside the
 * 24-hour customer-service window that a patient's own message opens, Meta
 * accepts **only** a pre-approved template, identified by name and language, with
 * positional parameters. EN-009 §5 states the rule ("WhatsApp free-form
 * (non-template) only within 24-h window of last inbound; otherwise template")
 * and every business-initiated message this hub sends — appointment, token,
 * receipt, report-ready — is business-initiated by definition. So `sendTemplate`
 * is the only outbound operation, and a session-reply operation is deliberately
 * absent until EN-009 §3.4's inbox lands with the window tracking that would
 * make it safe.
 *
 * ### The failure that matters is not a failure
 * Error `131026` — "Message undeliverable" — is what Meta returns when the
 * number is not on WhatsApp, has blocked the business, or cannot receive the
 * template. It is an HTTP 400. Treated as a generic 4xx it dead-letters and the
 * patient is never told about their appointment; classified properly it is the
 * trigger for the SMS fallback in EN-009 §3.3.2 and §14.3. The code map below is
 * therefore load-bearing, not decoration.
 *
 * Webhooks are verified against `X-Hub-Signature-256` over the **raw** body.
 * Re-serialising the parsed JSON changes key order and the HMAC never matches,
 * so `receive()` requires `raw.body` to be the original text.
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
  type ErrorClass,
  type HealthCheckKind,
  type HealthReport,
  type OutboundMessage,
  type RawInbound,
} from '../../adapter/types.js';
import { secretRefSchema } from '../../config/connector-config.js';
import { failureFromResponse, failureFromTransport, parseJson } from '../../messaging/http/errors.js';
import { verifyMetaSignature } from '../../messaging/http/signature.js';
import { fetchHttpTransport, type HttpTransport } from '../../messaging/http/transport.js';
import { outboundWhatsAppPayloadSchema } from '../../messaging/payload-schemas.js';
import {
  CANONICAL_DELIVERY_RECEIPT,
  WHATSAPP_CATEGORIES,
  WebhookSignatureError,
  type DeliveryEnvelopePayload,
  type DeliveryReceipt,
  type DeliveryStatus,
  type InboundMessage,
  type WhatsAppCategory,
} from '../../messaging/types.js';
import { headerValue } from '../msg91/msg91.adapter.js';

export const WHATSAPP_ADAPTER_ID = 'vims.whatsapp-cloud';
export const WHATSAPP_ADAPTER_VERSION = '0.1.0';
export const WHATSAPP_ADAPTER_REF = `${WHATSAPP_ADAPTER_ID}@${WHATSAPP_ADAPTER_VERSION}`;

const NOT_CONFIGURED = 'WhatsApp Cloud adapter used before configure()';

export const whatsAppOptionsSchema = z
  .object({
    wabaId: z.string().min(1).max(64),
    phoneNumberId: z.string().min(1).max(64),
    /** Graph API version. Pinned: Meta deprecates versions on a schedule. */
    graphVersion: z.string().regex(/^v\d+\.\d+$/).default('v20.0'),
    /** App secret for `X-Hub-Signature-256`. A reference, never the value. */
    appSecretRef: secretRefSchema,
  })
  .strict();

export type WhatsAppOptions = z.infer<typeof whatsAppOptionsSchema>;

const manifest: ConnectorManifest = {
  id: WHATSAPP_ADAPTER_ID,
  version: WHATSAPP_ADAPTER_VERSION,
  name: 'WhatsApp Cloud API (Meta)',
  publisher: 'VIMS ENTERPRISE',
  description:
    'EN-009 WhatsApp connector using Meta Cloud API template messages, with signed status/inbound webhooks and SMS-fallback error classification.',
  capabilities: {
    protocols: ['rest'],
    directions: ['in', 'out', 'both'],
    healthCheckKinds: ['ping', 'expect_traffic'],
    supportsIdempotencyKey: false,
    supportsPartitionedOrdering: false,
    supportsSandbox: true,
    supportsStreamingListener: false,
    requiresInternet: true,
    maxPayloadBytes: 64_000,
    operations: [
      {
        key: 'sendTemplate',
        name: 'Send template message',
        direction: 'out',
        method: 'POST',
        path: '/{phone_number_id}/messages',
        encoding: 'json',
        idempotency: 'natural_key',
        timeoutMs: 10_000,
        sideEffectFree: false,
      },
      {
        key: 'deliveryReceipt',
        name: 'Status and inbound webhook',
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

export const WHATSAPP_MANIFEST: ConnectorManifest = Object.freeze(manifest);

/**
 * Meta error codes worth distinguishing. `131026` is the one the fallback
 * depends on; the rest keep a configuration mistake out of the retry budget.
 */
const META_ERROR_CLASS: Readonly<Record<number, ErrorClass>> = Object.freeze({
  // Recipient cannot receive the message: not on WhatsApp, blocked, or the
  // number is not reachable for this template. EN-009 §14.3: fall back to SMS.
  131026: 'semantic_4xx',
  131047: 'semantic_4xx', // re-engagement required (outside the 24-hour window)
  131051: 'not_supported', // unsupported message type
  132000: 'validation', // template parameter count mismatch
  132001: 'validation', // template does not exist in this language
  132005: 'validation', // template hydrated text is too long
  132007: 'validation', // template format character policy violated
  132012: 'validation', // template parameter format mismatch
  132015: 'semantic_4xx', // template is paused
  132016: 'semantic_4xx', // template is disabled
  130429: 'rate_limited',
  131048: 'rate_limited', // spam rate limit hit
  131056: 'rate_limited', // pair rate limit hit
  190: 'auth', // access token expired/invalid
  10: 'auth', // permission denied
  100: 'validation', // invalid parameter
  131000: 'partner_5xx', // generic Meta internal error
});

/** Codes that mean "this recipient will never get it here" — the SMS fallback trigger. */
export const WHATSAPP_UNDELIVERABLE_CODES: ReadonlySet<number> = new Set([131026, 131047, 132015, 132016]);

const META_STATUS: Readonly<Record<string, DeliveryStatus>> = Object.freeze({
  accepted: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  deleted: 'expired',
  warning: 'sent',
});

function mapMetaStatus(raw: string): DeliveryStatus {
  return META_STATUS[raw.toLowerCase()] ?? 'failed';
}

const metaWebhookSchema = z.object({
  entry: z
    .array(
      z.object({
        changes: z
          .array(
            z.object({
              value: z.object({
                statuses: z
                  .array(
                    z.object({
                      id: z.string(),
                      status: z.string(),
                      timestamp: z.union([z.string(), z.number()]).optional(),
                      errors: z
                        .array(z.object({ code: z.number().optional(), title: z.string().optional() }))
                        .optional(),
                      pricing: z.object({ category: z.string().optional() }).optional(),
                      conversation: z.object({ id: z.string().optional() }).optional(),
                    }),
                  )
                  .optional(),
                messages: z
                  .array(
                    z.object({
                      id: z.string(),
                      from: z.string(),
                      timestamp: z.union([z.string(), z.number()]).optional(),
                      type: z.string().optional(),
                      text: z.object({ body: z.string().optional() }).optional(),
                      button: z.object({ payload: z.string().optional(), text: z.string().optional() }).optional(),
                    }),
                  )
                  .optional(),
              }),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

function epochToDate(value: string | number | undefined, fallback: Date): Date {
  if (value === undefined) return fallback;
  const seconds = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(seconds) ? new Date(seconds * 1000) : fallback;
}

function asWhatsAppCategory(value: string | undefined): WhatsAppCategory | undefined {
  if (value === undefined) return undefined;
  const upper = value.toUpperCase();
  return (WHATSAPP_CATEGORIES as readonly string[]).includes(upper) ? (upper as WhatsAppCategory) : undefined;
}

export class WhatsAppCloudAdapter implements ConnectorAdapter {
  readonly manifest = WHATSAPP_MANIFEST;

  private context: AdapterContext | undefined;
  private options: WhatsAppOptions | undefined;
  private accessToken = '';
  private appSecret = '';
  private closed = false;

  constructor(private readonly transport: HttpTransport) {}

  async configure(ctx: AdapterContext): Promise<void> {
    this.context = ctx;
    this.options = whatsAppOptionsSchema.parse(ctx.config.options);
    this.closed = false;

    const auth = ctx.config.auth;
    if (auth.type !== 'api_key') {
      throw new Error(
        `WhatsApp Cloud uses a bearer access token, configured as an 'api_key' auth block with header 'Authorization', not '${auth.type}'`,
      );
    }
    this.accessToken = await ctx.secrets.resolve(auth.secretRef);
    this.appSecret = await ctx.secrets.resolve(this.options.appSecretRef);
  }

  async send(operationKey: string, message: OutboundMessage): Promise<DispatchResult> {
    const ctx = this.context;
    const options = this.options;
    if (ctx === undefined || options === undefined) throw new Error(NOT_CONFIGURED);
    if (this.closed) {
      return { status: 'failed', errorClass: 'network', message: 'adapter is closed', retryable: true, latencyMs: 0 };
    }
    if (operationKey !== 'sendTemplate') {
      return {
        status: 'failed',
        errorClass: 'not_supported',
        message: `no operation '${operationKey}' on the WhatsApp Cloud connector`,
        retryable: false,
        latencyMs: 0,
      };
    }

    const parsed = outboundWhatsAppPayloadSchema.safeParse(message.payload);
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
      ctx.logger.debug(
        { connectorId: ctx.connectorId, templateKey: payload.templateKey },
        'WhatsApp: sandbox/replay — call recorded, nothing sent',
      );
      return { status: 'acknowledged', partnerRef: `sandbox:${message.messageId}`, latencyMs: 0, response: { sandbox: true } };
    }

    const components: unknown[] = [];
    if (payload.templateParameters.length > 0) {
      components.push({
        type: 'body',
        parameters: payload.templateParameters.map((text) => ({ type: 'text', text })),
      });
    }
    if (payload.templateButtonParameters !== undefined) {
      payload.templateButtonParameters.forEach((text, index) => {
        components.push({
          type: 'button',
          sub_type: 'url',
          index: String(index),
          parameters: [{ type: 'text', text }],
        });
      });
    }

    const base = (ctx.config.endpoint.url ?? '').replace(/\/+$/, '');
    const url = `${base}/${options.graphVersion}/${options.phoneNumberId}/messages`;
    const started = ctx.clock.now();

    let response;
    try {
      response = await this.transport.send(
        {
          method: 'POST',
          url,
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: payload.mobile.replace(/^\+/, ''),
            type: 'template',
            template: {
              name: payload.templateName,
              language: { code: payload.languageCode },
              ...(components.length === 0 ? {} : { components }),
            },
          }),
        },
        message.timeoutMs,
      );
    } catch (error) {
      return failureFromTransport(error, elapsed(ctx, started));
    }

    const latencyMs = elapsed(ctx, started);
    const decoded = parseJson(response.body);

    if (response.status >= 400) {
      const error = z
        .object({
          error: z.object({
            message: z.string().optional(),
            code: z.number().optional(),
            error_subcode: z.number().optional(),
            error_data: z.object({ details: z.string().optional() }).optional(),
          }),
        })
        .safeParse(decoded);

      const code = error.success ? error.data.error.code : undefined;
      const mapped = code === undefined ? undefined : META_ERROR_CLASS[code];
      if (mapped !== undefined) {
        return {
          status: 'failed',
          errorClass: mapped,
          code: `META_${String(code)}`,
          message:
            error.success
              ? error.data.error.error_data?.details ?? error.data.error.message ?? 'WhatsApp Cloud rejected the message'
              : 'WhatsApp Cloud rejected the message',
          // `rate_limited`, `auth` and `partner_5xx` are the hub's retryable set;
          // an undeliverable recipient is not retryable, it is a fallback.
          retryable: mapped === 'rate_limited' || mapped === 'auth' || mapped === 'partner_5xx',
          latencyMs,
          httpStatus: response.status,
        };
      }
      return failureFromResponse({
        response,
        latencyMs,
        now: ctx.clock.now(),
        ...(code === undefined ? {} : { code: `META_${String(code)}` }),
        ...(error.success && error.data.error.message !== undefined ? { message: error.data.error.message } : {}),
      });
    }

    const accepted = z
      .object({ messages: z.array(z.object({ id: z.string().min(1) })).min(1) })
      .safeParse(decoded);
    if (!accepted.success) {
      return {
        status: 'failed',
        errorClass: 'schema_drift',
        code: 'META_NO_WAMID',
        message: 'WhatsApp Cloud answered 2xx without a message id, so no status webhook could ever be matched',
        retryable: false,
        latencyMs,
        httpStatus: response.status,
      };
    }

    const wamid = accepted.data.messages[0]?.id ?? '';
    return {
      status: 'sent',
      partnerRef: wamid,
      latencyMs,
      httpStatus: response.status,
      response: { providerMessageId: wamid },
    };
  }

  /**
   * Status and inbound webhooks. `raw.body` must be the raw request text: the
   * HMAC is over the bytes Meta sent, not over a re-serialisation of them.
   */
  receive(raw: RawInbound): Promise<CanonicalEnvelope> {
    if (this.context === undefined || this.options === undefined) return Promise.reject(new Error(NOT_CONFIGURED));

    const text = typeof raw.body === 'string' ? raw.body : '';
    const signature = headerValue(raw.headers, 'x-hub-signature-256');
    if (
      !verifyMetaSignature({
        rawBody: text,
        header: signature,
        appSecret: this.appSecret,
      })
    ) {
      return Promise.reject(
        new WebhookSignatureError(
          'Meta',
          'X-Hub-Signature-256 did not match the HMAC-SHA256 of the raw body with the app secret',
        ),
      );
    }

    const parsed = metaWebhookSchema.safeParse(parseJson(text));
    if (!parsed.success) {
      return Promise.resolve({
        canonicalType: CANONICAL_DELIVERY_RECEIPT,
        operationKey: 'deliveryReceipt',
        payload: { receipts: [], inbound: [] } satisfies DeliveryEnvelopePayload,
        receivedAt: raw.receivedAt,
      });
    }

    const receipts: DeliveryReceipt[] = [];
    const inbound: InboundMessage[] = [];

    for (const entry of parsed.data.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const status of change.value.statuses ?? []) {
          const firstError = status.errors?.[0];
          const category = asWhatsAppCategory(status.pricing?.category);
          receipts.push({
            providerMessageId: status.id,
            status: mapMetaStatus(status.status),
            at: epochToDate(status.timestamp, raw.receivedAt),
            providerStatus: status.status,
            ...(firstError?.code === undefined ? {} : { errorCode: `META_${String(firstError.code)}` }),
            ...(firstError?.title === undefined ? {} : { errorText: firstError.title }),
            ...(category === undefined ? {} : { conversationCategory: category }),
          });
        }
        for (const inboundMessage of change.value.messages ?? []) {
          const buttonPayload = inboundMessage.button?.payload ?? inboundMessage.button?.text;
          inbound.push({
            providerMessageId: inboundMessage.id,
            from: inboundMessage.from.startsWith('+') ? inboundMessage.from : `+${inboundMessage.from}`,
            at: epochToDate(inboundMessage.timestamp, raw.receivedAt),
            kind: inboundMessage.type === 'button' ? 'button' : inboundMessage.type === 'text' ? 'text' : 'media',
            ...(inboundMessage.text?.body === undefined ? {} : { text: inboundMessage.text.body }),
            ...(buttonPayload === undefined ? {} : { buttonPayload }),
          });
        }
      }
    }

    return Promise.resolve({
      canonicalType: CANONICAL_DELIVERY_RECEIPT,
      operationKey: 'deliveryReceipt',
      ...(receipts[0] === undefined ? {} : { providerMessageId: receipts[0].providerMessageId }),
      payload: { receipts, inbound } satisfies DeliveryEnvelopePayload,
      receivedAt: raw.receivedAt,
    });
  }

  async healthCheck(kind: HealthCheckKind): Promise<HealthReport> {
    const ctx = this.context;
    const options = this.options;
    if (ctx === undefined || options === undefined) throw new Error(NOT_CONFIGURED);
    const started = ctx.clock.now();
    const base = (ctx.config.endpoint.url ?? '').replace(/\/+$/, '');
    try {
      // Reading the phone number resource also returns the quality rating, which
      // is the metric that silently throttles a hospital's WhatsApp traffic.
      const response = await this.transport.send(
        {
          method: 'GET',
          url: `${base}/${options.graphVersion}/${options.phoneNumberId}?fields=quality_rating,verified_name,throughput`,
          headers: { authorization: `Bearer ${this.accessToken}`, accept: 'application/json' },
        },
        5_000,
      );
      const latencyMs = elapsed(ctx, started);
      if (response.status >= 400) {
        return {
          status: 'fail',
          latencyMs,
          checkedAt: ctx.clock.now(),
          detail: `WhatsApp ${kind}: HTTP ${String(response.status)}`,
          errorClass: response.status === 401 || response.status === 403 ? 'auth' : 'partner_5xx',
        };
      }
      const info = z.object({ quality_rating: z.string().optional() }).safeParse(parseJson(response.body));
      const quality = info.success ? info.data.quality_rating : undefined;
      if (quality !== undefined && quality.toUpperCase() !== 'GREEN') {
        return {
          status: 'warn',
          latencyMs,
          checkedAt: ctx.clock.now(),
          detail: `WhatsApp number quality rating is ${quality}; Meta throttles below GREEN`,
        };
      }
      return { status: 'pass', latencyMs, checkedAt: ctx.clock.now(), detail: `WhatsApp ${kind} ok` };
    } catch (error) {
      return {
        status: 'fail',
        latencyMs: elapsed(ctx, started),
        checkedAt: ctx.clock.now(),
        detail: error instanceof Error ? error.message : 'WhatsApp probe failed',
        errorClass: 'network',
      };
    }
  }

  close(reason: CloseReason): Promise<void> {
    this.context?.logger.info({ reason }, 'WhatsApp Cloud adapter closed');
    this.closed = true;
    this.accessToken = '';
    this.appSecret = '';
    return Promise.resolve();
  }
}

function elapsed(ctx: AdapterContext, started: Date): number {
  return Math.max(0, ctx.clock.now().getTime() - started.getTime());
}

export function createWhatsAppCloudFactory(
  transport: HttpTransport = fetchHttpTransport(),
): ConnectorAdapterFactory {
  return Object.freeze({
    manifest: WHATSAPP_MANIFEST,
    refineConfig(config: ConnectorConfig): readonly string[] {
      const parsed = whatsAppOptionsSchema.safeParse(config.options);
      if (!parsed.success) {
        return parsed.error.issues.map(
          (issue) => `${issue.path.length === 0 ? 'options' : issue.path.join('.')}: ${issue.message}`,
        );
      }
      if (config.auth.type !== 'api_key') {
        return ["WhatsApp Cloud uses a bearer token, so auth.type must be 'api_key' with header 'Authorization'"];
      }
      // A cross-border flow to Meta is exactly what EN-017 §5 wants recorded.
      if (!config.dpdp.crossBorder) {
        return [
          'a WhatsApp Cloud connector sends personal data to Meta outside India, so dpdp.crossBorder must be true and a DPA reference recorded (EN-017 §5, DPDP Act 2023 §16)',
        ];
      }
      return [];
    },
    create(): ConnectorAdapter {
      return new WhatsAppCloudAdapter(transport);
    },
  });
}

export const whatsAppCloudFactory: ConnectorAdapterFactory = createWhatsAppCloudFactory();
