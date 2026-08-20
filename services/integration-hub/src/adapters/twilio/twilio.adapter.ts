/**
 * `vims.twilio` — Twilio Programmable SMS (`docs/08` §102).
 *
 * Twilio is the secondary gateway in most Indian deployments and the primary one
 * in the Gulf and Africa deployments `CLAUDE.md` §1 requires the architecture to
 * reach without redesign. It differs from MSG91 in three ways that matter here:
 *
 *  * **Form encoding, not JSON.** `application/x-www-form-urlencoded`, and the
 *    signature scheme below depends on the exact parameter set, so the body is
 *    built once and reused for both.
 *  * **Errors are honest.** A failure is a 4xx with `{ code, message }`, so the
 *    status code can be trusted — unlike MSG91's 200-with-error.
 *  * **Webhooks are signed.** `X-Twilio-Signature` is base64 HMAC-SHA1 over the
 *    callback URL concatenated with the sorted POST parameters. That means the
 *    adapter must know its own public callback URL, which is why it is a
 *    required option rather than something inferred from the request: inferring
 *    it from a `Host` header lets an attacker choose the string being signed.
 *
 * India-specific: Twilio passes DLT through `dlt_entity_id`/`dlt_template_id`
 * parameters on the Message resource. They are sent for every message, not only
 * Indian ones, because a hospital's Indian numbers and Gulf numbers share one
 * connector and Twilio ignores them outside India.
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
import { failureFromResponse, failureFromTransport, parseJson } from '../../messaging/http/errors.js';
import { verifyTwilioSignature } from '../../messaging/http/signature.js';
import { fetchHttpTransport, type HttpTransport } from '../../messaging/http/transport.js';
import { outboundSmsPayloadSchema } from '../../messaging/payload-schemas.js';
import {
  CANONICAL_DELIVERY_RECEIPT,
  WebhookSignatureError,
  type DeliveryEnvelopePayload,
  type DeliveryReceipt,
  type DeliveryStatus,
} from '../../messaging/types.js';
import { headerValue, parseDate } from '../msg91/msg91.adapter.js';

export const TWILIO_ADAPTER_ID = 'vims.twilio';
export const TWILIO_ADAPTER_VERSION = '0.1.0';
export const TWILIO_ADAPTER_REF = `${TWILIO_ADAPTER_ID}@${TWILIO_ADAPTER_VERSION}`;

const NOT_CONFIGURED = 'Twilio adapter used before configure()';

export const twilioOptionsSchema = z
  .object({
    accountSid: z
      .string()
      .regex(/^AC[0-9a-fA-F]{32}$/, 'a Twilio Account SID looks like `AC` + 32 hex characters'),
    /** Either a Messaging Service (preferred: it carries the sender pool) or a single from-number. */
    messagingServiceSid: z
      .string()
      .regex(/^MG[0-9a-fA-F]{32}$/)
      .optional(),
    fromNumber: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .optional(),
    /**
     * The public URL Twilio will POST status callbacks to. Required because the
     * signature is computed over it; inferring it from the inbound request would
     * let a caller choose what gets signed.
     */
    statusCallbackUrl: z.url(),
  })
  .strict()
  .refine((o) => o.messagingServiceSid !== undefined || o.fromNumber !== undefined, {
    message: 'Twilio needs either a messagingServiceSid or a fromNumber to send from',
  });

export type TwilioOptions = z.infer<typeof twilioOptionsSchema>;

const manifest: ConnectorManifest = {
  id: TWILIO_ADAPTER_ID,
  version: TWILIO_ADAPTER_VERSION,
  name: 'Twilio (SMS)',
  publisher: 'VIMS ENTERPRISE',
  description:
    'EN-009 SMS gateway adapter for Twilio Programmable Messaging, with DLT parameters and signed status callbacks.',
  capabilities: {
    protocols: ['rest'],
    directions: ['in', 'out', 'both'],
    healthCheckKinds: ['ping', 'expect_traffic'],
    /** Twilio's Messages resource honours no idempotency key. See MSG91 for why that forces R0. */
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
        path: '/2010-04-01/Accounts/{AccountSid}/Messages.json',
        encoding: 'form',
        idempotency: 'natural_key',
        timeoutMs: 10_000,
        sideEffectFree: false,
      },
      {
        key: 'deliveryReceipt',
        name: 'Status callback',
        direction: 'in',
        method: 'POST',
        encoding: 'form',
        idempotency: 'natural_key',
        timeoutMs: 5_000,
        sideEffectFree: true,
      },
    ],
  },
};

export const TWILIO_MANIFEST: ConnectorManifest = Object.freeze(manifest);

const TWILIO_STATUS: Readonly<Record<string, DeliveryStatus>> = Object.freeze({
  accepted: 'queued',
  scheduled: 'queued',
  queued: 'queued',
  sending: 'sent',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  receiving: 'queued',
  received: 'delivered',
  undelivered: 'undelivered',
  failed: 'failed',
  canceled: 'expired',
});

function mapTwilioStatus(raw: string): DeliveryStatus {
  return TWILIO_STATUS[raw.toLowerCase()] ?? 'failed';
}

/** Parses `a=1&b=2` into a record, which is both the body and the signature input. */
export function parseFormBody(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) out[key] = value;
  return out;
}

export class TwilioAdapter implements ConnectorAdapter {
  readonly manifest = TWILIO_MANIFEST;

  private context: AdapterContext | undefined;
  private options: TwilioOptions | undefined;
  private accountSid = '';
  private authToken = '';
  private closed = false;

  constructor(private readonly transport: HttpTransport) {}

  async configure(ctx: AdapterContext): Promise<void> {
    this.context = ctx;
    this.options = twilioOptionsSchema.parse(ctx.config.options);
    this.closed = false;

    const auth = ctx.config.auth;
    if (auth.type !== 'basic') {
      throw new Error(`Twilio authenticates with HTTP basic (SID:token), not '${auth.type}'`);
    }
    // The secret holds `AC…:auth_token` — one reference, because the SID alone
    // is not a credential and splitting them across two references invites a
    // deployment where only one of them rotates.
    const resolved = await ctx.secrets.resolve(auth.secretRef);
    const separator = resolved.indexOf(':');
    if (separator <= 0) {
      throw new Error('the Twilio secret must be `AccountSid:AuthToken`');
    }
    this.accountSid = resolved.slice(0, separator);
    this.authToken = resolved.slice(separator + 1);
    if (this.accountSid !== this.options.accountSid) {
      throw new Error(
        'the Account SID in the resolved secret does not match the one in the connector options — one of them is from another account',
      );
    }
  }

  async send(operationKey: string, message: OutboundMessage): Promise<DispatchResult> {
    const ctx = this.context;
    const options = this.options;
    if (ctx === undefined || options === undefined) throw new Error(NOT_CONFIGURED);
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
        message: `no operation '${operationKey}' on the Twilio connector`,
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
      ctx.logger.debug(
        { connectorId: ctx.connectorId, templateKey: payload.templateKey },
        'Twilio: sandbox/replay — call recorded, nothing sent',
      );
      return {
        status: 'acknowledged',
        partnerRef: `sandbox:${message.messageId}`,
        latencyMs: 0,
        response: { sandbox: true },
      };
    }

    const form = new URLSearchParams({
      To: payload.mobile,
      Body: payload.body,
      StatusCallback: options.statusCallbackUrl,
      dlt_entity_id: payload.dltEntityId,
      dlt_template_id: payload.dltTemplateId,
    });
    if (options.messagingServiceSid !== undefined) {
      form.set('MessagingServiceSid', options.messagingServiceSid);
    } else if (options.fromNumber !== undefined) {
      form.set('From', options.fromNumber);
    }

    const base = (ctx.config.endpoint.url ?? '').replace(/\/+$/, '');
    const url = `${base}/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const started = ctx.clock.now();

    let response;
    try {
      response = await this.transport.send(
        {
          method: 'POST',
          url,
          headers: {
            authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`, 'utf8').toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: form.toString(),
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
        .object({ code: z.number().optional(), message: z.string().optional() })
        .safeParse(decoded);
      return failureFromResponse({
        response,
        latencyMs,
        now: ctx.clock.now(),
        ...(error.success && error.data.code !== undefined
          ? { code: `TWILIO_${String(error.data.code)}` }
          : {}),
        ...(error.success && error.data.message !== undefined ? { message: error.data.message } : {}),
      });
    }

    const created = z.object({ sid: z.string().min(1), status: z.string().optional() }).safeParse(decoded);
    if (!created.success) {
      return {
        status: 'failed',
        errorClass: 'schema_drift',
        code: 'TWILIO_NO_SID',
        message: 'Twilio answered 2xx without a message SID, so no status callback could ever be matched',
        retryable: false,
        latencyMs,
        httpStatus: response.status,
      };
    }

    return {
      status: 'sent',
      partnerRef: created.data.sid,
      latencyMs,
      httpStatus: response.status,
      response: { providerMessageId: created.data.sid, providerStatus: created.data.status ?? 'queued' },
    };
  }

  /** Status callbacks. `raw.body` is the raw form-encoded text, needed for the signature. */
  receive(raw: RawInbound): Promise<CanonicalEnvelope> {
    const options = this.options;
    if (this.context === undefined || options === undefined) return Promise.reject(new Error(NOT_CONFIGURED));

    const text = typeof raw.body === 'string' ? raw.body : '';
    const params = parseFormBody(text);
    const signature = headerValue(raw.headers, 'x-twilio-signature');

    if (
      !verifyTwilioSignature({
        url: options.statusCallbackUrl,
        params,
        header: signature,
        authToken: this.authToken,
      })
    ) {
      return Promise.reject(
        new WebhookSignatureError(
          'Twilio',
          'X-Twilio-Signature did not match the HMAC-SHA1 of the callback URL and sorted parameters',
        ),
      );
    }

    const sid = params['MessageSid'] ?? params['SmsSid'];
    const status = params['MessageStatus'] ?? params['SmsStatus'];
    if (sid === undefined || status === undefined) {
      return Promise.resolve({
        canonicalType: CANONICAL_DELIVERY_RECEIPT,
        operationKey: 'deliveryReceipt',
        payload: { receipts: [], inbound: [] } satisfies DeliveryEnvelopePayload,
        receivedAt: raw.receivedAt,
      });
    }

    const errorCode = params['ErrorCode'];
    const receipt: DeliveryReceipt = {
      providerMessageId: sid,
      status: mapTwilioStatus(status),
      at: parseDate(params['Timestamp']) ?? raw.receivedAt,
      providerStatus: status,
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(params['ErrorMessage'] === undefined ? {} : { errorText: params['ErrorMessage'] }),
    };

    return Promise.resolve({
      canonicalType: CANONICAL_DELIVERY_RECEIPT,
      operationKey: 'deliveryReceipt',
      providerMessageId: sid,
      payload: { receipts: [receipt], inbound: [] } satisfies DeliveryEnvelopePayload,
      receivedAt: raw.receivedAt,
    });
  }

  async healthCheck(kind: HealthCheckKind): Promise<HealthReport> {
    const ctx = this.context;
    if (ctx === undefined) throw new Error(NOT_CONFIGURED);
    const started = ctx.clock.now();
    const base = (ctx.config.endpoint.url ?? '').replace(/\/+$/, '');
    try {
      const response = await this.transport.send(
        {
          method: 'GET',
          url: `${base}/2010-04-01/Accounts/${this.accountSid}.json`,
          headers: {
            authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`, 'utf8').toString('base64')}`,
            accept: 'application/json',
          },
        },
        5_000,
      );
      const latencyMs = elapsed(ctx, started);
      if (response.status >= 400) {
        return {
          status: 'fail',
          latencyMs,
          checkedAt: ctx.clock.now(),
          detail: `Twilio ${kind}: HTTP ${String(response.status)}`,
          errorClass: response.status === 401 ? 'auth' : 'partner_5xx',
        };
      }
      const account = z.object({ status: z.string().optional() }).safeParse(parseJson(response.body));
      if (account.success && account.data.status !== undefined && account.data.status !== 'active') {
        return {
          status: 'warn',
          latencyMs,
          checkedAt: ctx.clock.now(),
          detail: `Twilio account status is '${account.data.status}'`,
        };
      }
      return { status: 'pass', latencyMs, checkedAt: ctx.clock.now(), detail: `Twilio ${kind} ok` };
    } catch (error) {
      return {
        status: 'fail',
        latencyMs: elapsed(ctx, started),
        checkedAt: ctx.clock.now(),
        detail: error instanceof Error ? error.message : 'Twilio probe failed',
        errorClass: 'network',
      };
    }
  }

  close(reason: CloseReason): Promise<void> {
    this.context?.logger.info({ reason }, 'Twilio adapter closed');
    this.closed = true;
    this.authToken = '';
    return Promise.resolve();
  }
}

function elapsed(ctx: AdapterContext, started: Date): number {
  return Math.max(0, ctx.clock.now().getTime() - started.getTime());
}

export function createTwilioFactory(
  transport: HttpTransport = fetchHttpTransport(),
): ConnectorAdapterFactory {
  return Object.freeze({
    manifest: TWILIO_MANIFEST,
    refineConfig(config: ConnectorConfig): readonly string[] {
      const parsed = twilioOptionsSchema.safeParse(config.options);
      if (!parsed.success) {
        return parsed.error.issues.map(
          (issue) => `${issue.path.length === 0 ? 'options' : issue.path.join('.')}: ${issue.message}`,
        );
      }
      if (config.auth.type !== 'basic') {
        return [
          "Twilio authenticates with HTTP basic, so auth.type must be 'basic' with a `AccountSid:AuthToken` secret",
        ];
      }
      return [];
    },
    create(): ConnectorAdapter {
      return new TwilioAdapter(transport);
    },
  });
}

export const twilioFactory: ConnectorAdapterFactory = createTwilioFactory();
