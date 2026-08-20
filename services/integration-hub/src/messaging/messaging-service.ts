/**
 * EN-009 §3.3 — the send pipeline, and the only entry point a module uses.
 *
 * A module calls `send({templateKey, to, values})`. It does not choose a
 * channel, a provider, a language or a DLT template id, and it never writes a
 * retry loop — the whole point of EN-017 is that there is one obvious thing to
 * call. What happens between that call and the wire is a fixed sequence of
 * refusals followed by exactly one dispatch:
 *
 *   1. **Normalise the number** (E.164). An unnormalised number defeats the
 *      opt-out ledger, which is keyed by it.
 *   2. **Resolve the template**, which carries the message *class*. The class is
 *      a property of the template, never of the caller — otherwise a marketing
 *      module sends a camp invitation labelled `transactional` and the consent
 *      rules evaporate.
 *   3. **Consent / DND / window** (`consent-ledger.ts`). Refusal here is
 *      recorded twice: in the ledger for the Privacy Officer, and as a `blocked`
 *      row in `ihub_messages` so the sending module can see its notification
 *      never left. `docs/04` §7: no silent failures.
 *   4. **Choose the channel.** WhatsApp when there is an approved template and
 *      the policy allows it, otherwise SMS.
 *   5. **Render through the DLT gate** (`dlt-registry.ts`), which refuses an
 *      unregistered or drifted template rather than emitting a message the
 *      operator will silently drop.
 *   6. **Price it** (`cost-ledger.ts`), then dispatch through the existing
 *      `Dispatcher` — which is what gives the message its idempotency check, its
 *      circuit-breaker gate, its PHI-redacted log row and its DLQ entry.
 *
 * ### Retry and fallback
 * There is no retry loop here, and adding one would be a bug. The SMS and
 * WhatsApp adapters all report `supportsIdempotencyKey: false`, so
 * `validateConnectorConfig` forces those connectors to retry policy R0 — a
 * failure goes straight to the DLQ rather than sending a patient the same
 * message three times. What this file adds is the *channel* fallback EN-009
 * §3.3.2 specifies: when WhatsApp cannot deliver, the SMS variant goes out once,
 * linked to the WhatsApp message by `parentMessageId`, and its cost is recorded
 * separately. The circuit breaker still gates both, so a dead WhatsApp endpoint
 * stops being tried at all and every message takes the SMS path until it
 * recovers.
 */
import type { TenantContext } from '../db/database.js';
import type { AdapterLogger, Clock, RawInbound } from '../adapter/types.js';
import type { ConnectorRegistry } from '../registry/connector-registry.js';
import type { Dispatcher } from '../dispatch/dispatcher.js';
import type { IntegrationDatabase } from '../db/database.js';
import { MessageLog, type MessageHandle } from '../messages/message-log.js';
import { DeadLetterQueue } from '../dlq/dead-letter-queue.js';
import type { PayloadStore } from '../payload/payload-store.js';
import { MESSAGING_DEFAULT_LOCALE as DEFAULT_LOCALE } from './locales.js';
import type { ConsentLedger } from './consent-ledger.js';
import { type ConsentRefusal } from './consent-ledger.js';
import type { CostLedger } from './cost-ledger.js';
import { type PricedMessage } from './cost-ledger.js';
import type { DltTemplateRegistry } from './dlt-registry.js';
import { hashValues, type DltSendRefusal } from './dlt-registry.js';
import { countSegments } from './segments.js';
import { maskPhone, normaliseToE164 } from './phone.js';
import type { TemplateCatalogue } from './template-catalogue.js';
import { type TemplateVersion } from './template-catalogue.js';
import type { MessageDirectory, SentMessageRef } from './directory.js';
import {
  CLASS_TO_WHATSAPP_CATEGORY,
  isDeliveryFailure,
  supersedesDeliveryStatus,
  type DeliveryEnvelopePayload,
  type DeliveryReceipt,
  type DeliveryStatus,
  type InboundMessage,
  type LocaleCode,
  type MessageChannel,
  type OutboundSmsPayload,
  type OutboundWhatsAppPayload,
} from './types.js';

/** Per-hospital knobs EN-009 §3.1/§5 make configuration rather than code. */
export interface MessagingSettings {
  readonly hospitalId: string;
  /** IANA zone. The promotional 9AM-9PM window is local time, not UTC. */
  readonly timeZone: string;
  readonly defaultCountryCode: string;
  /** EN-009 §5: "Dedupe window per template (default 10 min)". */
  readonly dedupeWindowSeconds: number;
  /** EN-009 §3.3.2. Off means a WhatsApp failure dead-letters instead. */
  readonly whatsAppToSmsFallback: boolean;
  /**
   * Which SMS connector a *webhook-driven* fallback uses.
   *
   * A synchronous fallback reuses the connector the caller named. A fallback
   * triggered minutes later by a delivery callback has no caller, so the
   * connector has to come from configuration — picking "the first active SMS
   * connector" would make a hospital with a primary and a failover gateway send
   * its fallbacks down whichever one happened to sort first, which is a routing
   * decision made by an accident of ordering.
   */
  readonly fallbackSmsConnectorKey?: string;
}

export const DEFAULT_MESSAGING_SETTINGS: Omit<MessagingSettings, 'hospitalId'> = Object.freeze({
  timeZone: 'Asia/Kolkata',
  defaultCountryCode: '91',
  dedupeWindowSeconds: 600,
  whatsAppToSmsFallback: true,
});

export interface MessagingSettingsStore {
  put(settings: MessagingSettings): Promise<void>;
  get(hospitalId: string): Promise<MessagingSettings | undefined>;
}

export class InMemoryMessagingSettingsStore implements MessagingSettingsStore {
  private readonly items = new Map<string, MessagingSettings>();

  put(settings: MessagingSettings): Promise<void> {
    this.items.set(settings.hospitalId, settings);
    return Promise.resolve();
  }

  get(hospitalId: string): Promise<MessagingSettings | undefined> {
    return Promise.resolve(this.items.get(hospitalId));
  }
}

export type ChannelPolicy = 'wa_then_sms' | 'sms_only' | 'wa_only';

export interface MessagingSendRequest {
  readonly templateKey: string;
  /** Raw, as typed at the desk. Normalised here. */
  readonly to: string;
  readonly values: Readonly<Record<string, string>>;
  readonly module: string;
  readonly smsConnectorKey: string;
  readonly whatsAppConnectorKey?: string;
  readonly locale?: LocaleCode;
  readonly channelPolicy?: ChannelPolicy;
  readonly branchId?: string | null;
  readonly refType?: string | null;
  readonly refId?: string | null;
  readonly campaignId?: string | null;
  readonly at?: Date;
}

export type MessagingRefusal =
  | 'invalid_number'
  | 'no_template'
  | 'no_whatsapp_template'
  | 'channel_unavailable'
  | ConsentRefusal
  | DltSendRefusal;

export type MessagingSendOutcome =
  | {
      readonly status: 'sent';
      readonly channel: MessageChannel;
      readonly messageId: string;
      readonly providerMessageId: string | undefined;
      readonly locale: LocaleCode;
      readonly fellBackToDefaultLocale: boolean;
      readonly cost: PricedMessage;
      /** Set when this send is the SMS half of a WhatsApp fallback. */
      readonly fallbackOfMessageId?: string;
    }
  | { readonly status: 'duplicate'; readonly messageId: string }
  | {
      readonly status: 'refused';
      readonly reason: MessagingRefusal;
      readonly detail: string;
      /** The `blocked` row written so the refusal is visible, not silent. */
      readonly messageId: string | null;
    }
  | {
      readonly status: 'failed';
      readonly channel: MessageChannel;
      readonly messageId: string;
      readonly detail: string;
    };

export interface MessagingServiceDeps {
  readonly db: IntegrationDatabase;
  readonly registry: ConnectorRegistry;
  readonly dispatcher: Dispatcher;
  readonly templates: TemplateCatalogue;
  readonly dlt: DltTemplateRegistry;
  readonly consent: ConsentLedger;
  readonly costs: CostLedger;
  readonly directory: MessageDirectory;
  readonly settings: MessagingSettingsStore;
  /**
   * The same encrypted store the dispatcher writes to. Needed because a
   * webhook-driven fallback arrives minutes after the caller has gone, so the
   * SMS variant has to be rendered from the values of the WhatsApp message that
   * failed — and those live here, never in the redacted log copy.
   */
  readonly payloads: PayloadStore;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly logger: AdapterLogger;
  readonly messageLog?: MessageLog;
  readonly dlq?: DeadLetterQueue;
}

/** EN-009 §3.4: the keywords that mean "stop", across the languages a desk sees. */
const STOP_KEYWORDS = new Set([
  'stop',
  'unsubscribe',
  'optout',
  'opt-out',
  'opt out',
  'cancel',
  'quit',
  'band',
  'band karo',
  'nirodh',
]);

export class MessagingService {
  private readonly messages: MessageLog;
  private readonly dlq: DeadLetterQueue;

  constructor(private readonly deps: MessagingServiceDeps) {
    this.messages = deps.messageLog ?? new MessageLog();
    this.dlq = deps.dlq ?? new DeadLetterQueue(deps.newId);
  }

  async configureHospital(settings: MessagingSettings): Promise<void> {
    await this.deps.settings.put(settings);
  }

  async send(ctx: TenantContext, request: MessagingSendRequest): Promise<MessagingSendOutcome> {
    const now = request.at ?? this.deps.clock.now();
    const settings: MessagingSettings = {
      hospitalId: ctx.hospitalId,
      ...DEFAULT_MESSAGING_SETTINGS,
      ...((await this.deps.settings.get(ctx.hospitalId)) ?? {}),
    };
    const locale = request.locale ?? DEFAULT_LOCALE;

    // ── 1. the number ─────────────────────────────────────────────────────────
    const phone = normaliseToE164(request.to, settings.defaultCountryCode);
    if (!phone.ok) {
      return this.refuse(ctx, {
        request,
        reason: 'invalid_number',
        detail: `${phone.reason}: ${phone.detail}`,
        phoneE164: null,
        messageClass: 'transactional',
        channel: 'sms',
        now,
      });
    }

    // ── 2. the template, which carries the class ──────────────────────────────
    const policy: ChannelPolicy = request.channelPolicy ?? 'wa_then_sms';
    const smsTemplate = await this.deps.templates.resolve(ctx.hospitalId, request.templateKey, 'sms', locale);
    const waTemplate =
      policy === 'sms_only'
        ? undefined
        : await this.deps.templates.resolve(ctx.hospitalId, request.templateKey, 'whatsapp', locale);

    const anyTemplate = smsTemplate.ok
      ? smsTemplate.template
      : waTemplate?.ok === true
        ? waTemplate.template
        : undefined;
    if (anyTemplate === undefined) {
      return this.refuse(ctx, {
        request,
        reason: 'no_template',
        detail: smsTemplate.ok ? 'no template for this key' : smsTemplate.detail,
        phoneE164: phone.e164,
        messageClass: 'transactional',
        channel: 'sms',
        now,
      });
    }
    const messageClass = anyTemplate.messageClass;

    // ── 3. consent, DND and the promotional window ────────────────────────────
    const decision = await this.deps.consent.decide({
      hospitalId: ctx.hospitalId,
      phoneE164: phone.e164,
      channel: policy === 'sms_only' ? 'sms' : 'whatsapp',
      messageClass,
      at: now,
      timeZone: settings.timeZone,
    });

    if (!decision.allowed) {
      const outcome = await this.refuse(ctx, {
        request,
        reason: decision.reason,
        detail: decision.detail,
        phoneE164: phone.e164,
        messageClass,
        channel: 'sms',
        now,
      });
      await this.deps.consent.recordDecision({
        hospitalId: ctx.hospitalId,
        phoneE164: phone.e164,
        channel: policy === 'sms_only' ? 'sms' : 'whatsapp',
        messageClass,
        templateKey: request.templateKey,
        allowed: false,
        reason: decision.reason,
        detail: decision.detail,
        at: now,
        ...(outcome.status === 'refused' && outcome.messageId !== null
          ? { messageId: outcome.messageId }
          : {}),
      });
      return outcome;
    }

    await this.deps.consent.recordDecision({
      hospitalId: ctx.hospitalId,
      phoneE164: phone.e164,
      channel: policy === 'sms_only' ? 'sms' : 'whatsapp',
      messageClass,
      templateKey: request.templateKey,
      allowed: true,
      reason: 'allowed',
      detail: decision.overrodeDnd ? (decision.note ?? 'allowed with override') : 'allowed',
      at: now,
    });

    // ── 4. channel ────────────────────────────────────────────────────────────
    const whatsAppUsable =
      policy !== 'sms_only' &&
      request.whatsAppConnectorKey !== undefined &&
      waTemplate?.ok === true &&
      waTemplate.template.whatsapp?.status === 'approved';

    if (policy === 'wa_only' && !whatsAppUsable) {
      return this.refuse(ctx, {
        request,
        reason: 'no_whatsapp_template',
        detail:
          'the channel policy is WhatsApp-only but there is no approved WhatsApp template (or no WhatsApp connector) for this key and language',
        phoneE164: phone.e164,
        messageClass,
        channel: 'whatsapp',
        now,
      });
    }

    if (whatsAppUsable && waTemplate?.ok === true && request.whatsAppConnectorKey !== undefined) {
      const attempt = await this.sendWhatsApp(ctx, {
        request,
        settings,
        template: waTemplate.template,
        resolvedLocale: waTemplate.resolvedLocale,
        fellBack: waTemplate.fellBackToDefault,
        phoneE164: phone.e164,
        connectorKey: request.whatsAppConnectorKey,
        now,
      });
      if (attempt.status !== 'failed') return attempt;

      if (!settings.whatsAppToSmsFallback || policy === 'wa_only' || !smsTemplate.ok) {
        return attempt;
      }
      this.deps.logger.info(
        { templateKey: request.templateKey, to: maskPhone(phone.e164), whatsAppMessageId: attempt.messageId },
        'WhatsApp send failed; falling back to SMS (EN-009 §3.3.2)',
      );
      const fallback = await this.sendSms(ctx, {
        request,
        settings,
        template: smsTemplate.template,
        resolvedLocale: smsTemplate.resolvedLocale,
        fellBack: smsTemplate.fellBackToDefault,
        phoneE164: phone.e164,
        countryCode: phone.countryCode,
        connectorKey: request.smsConnectorKey,
        now,
        fallbackOfMessageId: attempt.messageId,
      });
      if (fallback.status === 'sent') {
        await this.deps.directory.update(attempt.messageId, { fallbackMessageId: fallback.messageId });
      }
      return fallback;
    }

    if (!smsTemplate.ok) {
      return this.refuse(ctx, {
        request,
        reason: 'no_template',
        detail: smsTemplate.detail,
        phoneE164: phone.e164,
        messageClass,
        channel: 'sms',
        now,
      });
    }

    return this.sendSms(ctx, {
      request,
      settings,
      template: smsTemplate.template,
      resolvedLocale: smsTemplate.resolvedLocale,
      fellBack: smsTemplate.fellBackToDefault,
      phoneE164: phone.e164,
      countryCode: phone.countryCode,
      connectorKey: request.smsConnectorKey,
      now,
    });
  }

  // ── the two channel paths ───────────────────────────────────────────────────

  private async sendSms(
    ctx: TenantContext,
    args: {
      readonly request: MessagingSendRequest;
      readonly settings: MessagingSettings;
      readonly template: TemplateVersion;
      readonly resolvedLocale: LocaleCode;
      readonly fellBack: boolean;
      readonly phoneE164: string;
      readonly countryCode: string;
      readonly connectorKey: string;
      readonly now: Date;
      readonly fallbackOfMessageId?: string;
    },
  ): Promise<MessagingSendOutcome> {
    const rendered = await this.deps.dlt.renderForSend({
      template: args.template,
      locale: args.resolvedLocale,
      values: args.request.values,
    });
    if (!rendered.ok) {
      return this.refuse(ctx, {
        request: args.request,
        reason: rendered.reason,
        detail: rendered.detail,
        phoneE164: args.phoneE164,
        messageClass: args.template.messageClass,
        channel: 'sms',
        now: args.now,
      });
    }

    const segmentation = countSegments(rendered.body);
    const payload: OutboundSmsPayload = {
      channel: 'sms',
      mobile: args.phoneE164,
      body: rendered.body,
      senderId: rendered.registration.headerId,
      dltEntityId: rendered.registration.dltEntityId,
      dltTemplateId: rendered.registration.dltTemplateId,
      dltCategory: rendered.registration.dltCategory,
      templateKey: args.template.key,
      locale: args.resolvedLocale,
      messageClass: args.template.messageClass,
      encoding: segmentation.encoding,
      segments: segmentation.segments,
      templateVars: args.request.values,
      varsHash: rendered.varsHash,
    };

    const price = await this.deps.costs.priceSms({
      hospitalId: ctx.hospitalId,
      segments: segmentation.segments,
      destinationCountryCode: args.countryCode,
    });

    return this.dispatchAndRecord(ctx, {
      ...args,
      channel: 'sms',
      operationKey: 'sendSms',
      payload,
      price,
      segments: segmentation.segments,
    });
  }

  private async sendWhatsApp(
    ctx: TenantContext,
    args: {
      readonly request: MessagingSendRequest;
      readonly settings: MessagingSettings;
      readonly template: TemplateVersion;
      readonly resolvedLocale: LocaleCode;
      readonly fellBack: boolean;
      readonly phoneE164: string;
      readonly connectorKey: string;
      readonly now: Date;
    },
  ): Promise<MessagingSendOutcome> {
    const binding = args.template.whatsapp;
    if (binding === undefined) {
      return this.refuse(ctx, {
        request: args.request,
        reason: 'no_whatsapp_template',
        detail: 'the WhatsApp template variant carries no Meta template binding',
        phoneE164: args.phoneE164,
        messageClass: args.template.messageClass,
        channel: 'whatsapp',
        now: args.now,
      });
    }

    // WhatsApp is not DLT-governed, but the *content* rules are identical:
    // parameters are checked for clinical content and length exactly as an SMS
    // variable is, because EN-037 §135 covers every external channel.
    const parameters: string[] = [];
    for (const variable of [...args.template.variables].sort((a, b) => a.index - b.index)) {
      const value = args.request.values[variable.name];
      if (value === undefined) {
        return this.refuse(ctx, {
          request: args.request,
          reason: 'variable_missing',
          detail: `no value supplied for WhatsApp template variable '${variable.name}'`,
          phoneE164: args.phoneE164,
          messageClass: args.template.messageClass,
          channel: 'whatsapp',
          now: args.now,
        });
      }
      parameters.push(value);
    }

    const body = args.template.body.replace(/\{\{(\d+)\}\}/g, (_match, digits: string) => {
      const index = Number.parseInt(digits, 10);
      const variable = args.template.variables.find((v) => v.index === index);
      return variable === undefined ? '' : (args.request.values[variable.name] ?? '');
    });

    const category = binding.category;
    const payload: OutboundWhatsAppPayload = {
      channel: 'whatsapp',
      mobile: args.phoneE164,
      templateName: binding.templateName,
      languageCode: binding.languageCode,
      category,
      templateKey: args.template.key,
      locale: args.resolvedLocale,
      messageClass: args.template.messageClass,
      templateParameters: parameters,
      templateVars: args.request.values,
      varsHash: hashValues(args.request.values),
      body,
    };

    const price = await this.deps.costs.priceWhatsApp({
      hospitalId: ctx.hospitalId,
      phoneE164: args.phoneE164,
      category: CLASS_TO_WHATSAPP_CATEGORY[args.template.messageClass] ?? category,
      at: args.now,
    });

    return this.dispatchAndRecord(ctx, {
      ...args,
      channel: 'whatsapp',
      operationKey: 'sendTemplate',
      payload,
      price,
      segments: 1,
    });
  }

  private async dispatchAndRecord(
    ctx: TenantContext,
    args: {
      readonly request: MessagingSendRequest;
      readonly settings: MessagingSettings;
      readonly template: TemplateVersion;
      readonly resolvedLocale: LocaleCode;
      readonly fellBack: boolean;
      readonly phoneE164: string;
      readonly connectorKey: string;
      readonly channel: MessageChannel;
      readonly operationKey: string;
      readonly payload: OutboundSmsPayload | OutboundWhatsAppPayload;
      readonly price: PricedMessage;
      readonly segments: number;
      readonly now: Date;
      readonly fallbackOfMessageId?: string;
    },
  ): Promise<MessagingSendOutcome> {
    const outcome = await this.deps.dispatcher.dispatch(ctx, {
      connectorKey: args.connectorKey,
      operationKey: args.operationKey,
      payload: args.payload,
      idempotencyKey: this.dedupeKey(args),
      branchId: args.request.branchId ?? null,
      refType: args.request.refType ?? null,
      refId: args.request.refId ?? null,
      ...(args.fallbackOfMessageId === undefined ? {} : { parentMessageId: args.fallbackOfMessageId }),
      priority:
        args.template.messageClass === 'critical' ? 1 : args.template.messageClass === 'promotional' ? 8 : 5,
    });

    if (outcome.status === 'duplicate') return { status: 'duplicate', messageId: outcome.messageId };

    if (outcome.status === 'blocked') {
      return {
        status: 'failed',
        channel: args.channel,
        messageId: outcome.messageId,
        detail: outcome.reason,
      };
    }
    if (outcome.status === 'failed' || outcome.status === 'dead_lettered') {
      return {
        status: 'failed',
        channel: args.channel,
        messageId: outcome.messageId,
        detail: `${outcome.errorClass} from ${args.connectorKey}`,
      };
    }

    const providerMessageId = outcome.partnerRef;
    if (providerMessageId !== undefined) {
      const row = await this.deps.db.withTenant(ctx, (tx) => this.messages.get(tx, outcome.messageId));
      const ref: SentMessageRef = {
        providerMessageId,
        messageId: outcome.messageId,
        createdAt: row?.created_at_text ?? args.now.toISOString(),
        hospitalId: ctx.hospitalId,
        branchId: args.request.branchId ?? null,
        connectorKey: args.connectorKey,
        channel: args.channel,
        templateKey: args.template.key,
        messageClass: args.template.messageClass,
        phoneE164: args.phoneE164,
        locale: args.resolvedLocale,
        module: args.request.module,
        sentAt: args.now,
        status: 'sent',
      };
      await this.deps.directory.put(ref);
    }

    await this.deps.costs.record({
      hospitalId: ctx.hospitalId,
      branchId: args.request.branchId ?? null,
      messageId: outcome.messageId,
      channel: args.channel,
      module: args.request.module,
      templateKey: args.template.key,
      campaignId: args.request.campaignId ?? null,
      segments: args.segments,
      amount: args.price.amount,
      currency: args.price.currency,
      freeInsideConversation: args.price.freeInsideConversation,
      isFallback: args.fallbackOfMessageId !== undefined,
      at: args.now,
    });

    return {
      status: 'sent',
      channel: args.channel,
      messageId: outcome.messageId,
      providerMessageId,
      locale: args.resolvedLocale,
      fellBackToDefaultLocale: args.fellBack,
      cost: args.price,
      ...(args.fallbackOfMessageId === undefined ? {} : { fallbackOfMessageId: args.fallbackOfMessageId }),
    };
  }

  /**
   * EN-009 §5: "Dedupe window per template (default 10 min) keyed by (template,
   * recipient, ref)". The window is a floor-division bucket rather than a
   * timestamp comparison because `findByIdempotencyKey` matches on equality —
   * two sends inside the same bucket collide, one in the next bucket does not.
   */
  private dedupeKey(args: {
    readonly request: MessagingSendRequest;
    readonly settings: MessagingSettings;
    readonly channel: MessageChannel;
    readonly phoneE164: string;
    readonly now: Date;
    readonly fallbackOfMessageId?: string;
  }): string {
    const bucket = Math.floor(args.now.getTime() / (args.settings.dedupeWindowSeconds * 1000));
    const ref = `${args.request.refType ?? '-'}:${args.request.refId ?? '-'}`;
    const suffix = args.fallbackOfMessageId === undefined ? '' : `:fb:${args.fallbackOfMessageId}`;
    return `msg:${args.channel}:${args.request.templateKey}:${args.phoneE164}:${ref}:${String(bucket)}${suffix}`.slice(
      0,
      200,
    );
  }

  /**
   * A refusal is written as a `blocked` row in `ihub_messages` through the same
   * `MessageLog` every other message uses — same redaction, same tenancy, same
   * append-only guarantees. The payload records *why*, and carries the mask
   * rather than the number.
   */
  private async refuse(
    ctx: TenantContext,
    args: {
      readonly request: MessagingSendRequest;
      readonly reason: MessagingRefusal;
      readonly detail: string;
      readonly phoneE164: string | null;
      readonly messageClass: string;
      readonly channel: MessageChannel;
      readonly now: Date;
    },
  ): Promise<MessagingSendOutcome> {
    const connector = await this.deps.registry.get(ctx, args.request.smsConnectorKey);
    if (connector === undefined) {
      // Nothing to attach the row to. Still not silent: it is logged and
      // returned, and the caller sees `messageId: null`.
      this.deps.logger.warn(
        { templateKey: args.request.templateKey, reason: args.reason },
        'messaging send refused before a connector could be resolved',
      );
      return { status: 'refused', reason: args.reason, detail: args.detail, messageId: null };
    }

    const operation = connector.operations.find((op) => op.key === 'sendSms') ?? connector.operations[0];
    const messageId = this.deps.newId();

    await this.deps.db.withTenant(ctx, (tx) =>
      this.messages.record(tx, {
        id: messageId,
        hospitalId: ctx.hospitalId,
        branchId: args.request.branchId ?? null,
        connectorId: connector.id,
        connectorVersion: connector.version,
        operationId: operation?.id ?? null,
        direction: 'out',
        correlationId: messageId,
        refType: args.request.refType ?? null,
        refId: args.request.refId ?? null,
        status: 'blocked',
        attempts: 0,
        payload: {
          channel: args.channel,
          templateKey: args.request.templateKey,
          messageClass: args.messageClass,
          module: args.request.module,
          // The mask, never the number: `docs/04` §2 and the same token the
          // redactor would have produced anyway.
          recipient: args.phoneE164 === null ? '«phone»' : maskPhone(args.phoneE164),
          droppedPolicy: args.reason,
          reason: args.detail,
        },
        createdAt: args.now,
      }),
    );

    this.deps.logger.info(
      {
        templateKey: args.request.templateKey,
        reason: args.reason,
        channel: args.channel,
        messageId,
      },
      'messaging send refused and recorded as dropped_policy',
    );

    return { status: 'refused', reason: args.reason, detail: args.detail, messageId };
  }

  // ── delivery webhooks ───────────────────────────────────────────────────────

  /**
   * EN-009 §3.3.2 / §6 `POST /webhooks/:provider`.
   *
   * `raw.body` must be the **raw request text**: every provider that signs its
   * callbacks signs the bytes it sent, and a re-serialised body never verifies.
   * The adapter verifies and normalises; this method applies.
   */
  async handleDeliveryWebhook(
    ctx: TenantContext,
    connectorKey: string,
    raw: RawInbound,
  ): Promise<{
    readonly applied: number;
    readonly ignored: number;
    readonly optOuts: number;
    readonly fallbacksTriggered: number;
  }> {
    const { adapter } = await this.deps.registry.resolveAdapter(ctx, connectorKey);
    if (adapter.receive === undefined) {
      throw new Error(`connector '${connectorKey}' has no inbound path`);
    }
    const envelope = await adapter.receive(raw);
    const payload = envelope.payload as DeliveryEnvelopePayload;

    let applied = 0;
    let ignored = 0;
    let fallbacksTriggered = 0;

    for (const receipt of payload.receipts ?? []) {
      const result = await this.applyReceipt(ctx, receipt);
      if (result.applied) applied += 1;
      else ignored += 1;
      if (result.fallbackTriggered) fallbacksTriggered += 1;
    }

    let optOuts = 0;
    for (const inbound of payload.inbound ?? []) {
      if (await this.applyInbound(ctx, inbound)) optOuts += 1;
    }

    return { applied, ignored, optOuts, fallbacksTriggered };
  }

  private async applyReceipt(
    ctx: TenantContext,
    receipt: DeliveryReceipt,
  ): Promise<{ readonly applied: boolean; readonly fallbackTriggered: boolean }> {
    const ref = await this.deps.directory.byProviderMessageId(ctx.hospitalId, receipt.providerMessageId);
    if (ref === undefined) {
      // Unmatched, never invented. A callback for a message this process did not
      // send is logged and dropped rather than creating a phantom row.
      this.deps.logger.warn(
        { providerStatus: receipt.providerStatus },
        'delivery receipt for an unknown provider message id',
      );
      return { applied: false, fallbackTriggered: false };
    }

    if (!supersedesDeliveryStatus(ref.status, receipt.status)) {
      // Out-of-order callback. A late `sent` must not un-deliver a read message.
      return { applied: false, fallbackTriggered: false };
    }

    const handle: MessageHandle = { id: ref.messageId, createdAt: ref.createdAt };
    const row = await this.deps.db.withTenant(ctx, (tx) => this.messages.get(tx, ref.messageId));
    const latencyMs = row?.latency_ms ?? 0;

    if (isDeliveryFailure(receipt.status)) {
      await this.deps.db.withTenant(ctx, (tx) =>
        this.messages.fail(tx, handle, {
          status: 'failed',
          latencyMs,
          // The carrier accepted it and then could not deliver it: a partner-side
          // outcome, not a payload defect.
          errorClass: receipt.status === 'expired' ? 'timeout' : 'partner_5xx',
          errorCode: receipt.errorCode ?? receipt.providerStatus,
          errorText: receipt.errorText ?? `delivery ${receipt.status} reported by the provider`,
          completedAt: receipt.at,
        }),
      );
    } else {
      await this.deps.db.withTenant(ctx, (tx) =>
        this.messages.complete(tx, handle, {
          status: 'acknowledged',
          latencyMs,
          // `ack_code` is `varchar(16)`; every normalised delivery status fits,
          // and this is the column the message-log timeline reads.
          ackCode: receipt.status,
          response: { providerStatus: receipt.providerStatus, deliveryStatus: receipt.status },
          completedAt: receipt.at,
        }),
      );
    }

    await this.deps.directory.update(ref.messageId, { status: receipt.status });

    let fallbackTriggered = false;
    if (isDeliveryFailure(receipt.status)) {
      fallbackTriggered = await this.fallbackAfterDeliveryFailure(ctx, ref, receipt);
      if (!fallbackTriggered) {
        // No fallback available: the failure reaches a human rather than
        // disappearing (`docs/04` §7, EN-009 §11).
        const connector = await this.deps.registry.get(ctx, ref.connectorKey);
        if (connector !== undefined) {
          await this.deps.db.withTenant(ctx, (tx) =>
            this.dlq.record(tx, {
              hospitalId: ctx.hospitalId,
              connectorId: connector.id,
              operationId: connector.operations[0]?.id ?? null,
              messageId: ref.messageId,
              errorClass: 'partner_5xx',
              errorCode: receipt.errorCode ?? receipt.providerStatus,
              mappingPath: `delivery/${ref.channel}/${receipt.status}`,
              at: receipt.at,
            }),
          );
        }
      }
    }

    return { applied: true, fallbackTriggered };
  }

  /** EN-009 §14.3: a WhatsApp `undelivered` sends the SMS variant, exactly once. */
  private async fallbackAfterDeliveryFailure(
    ctx: TenantContext,
    ref: SentMessageRef,
    receipt: DeliveryReceipt,
  ): Promise<boolean> {
    if (ref.channel !== 'whatsapp') return false;
    if (ref.fallbackMessageId !== undefined) return false;

    const settings: MessagingSettings = {
      hospitalId: ctx.hospitalId,
      ...DEFAULT_MESSAGING_SETTINGS,
      ...((await this.deps.settings.get(ctx.hospitalId)) ?? {}),
    };
    if (!settings.whatsAppToSmsFallback) return false;

    const smsConnectors = (await this.deps.registry.list(ctx, { status: 'active' }))
      .filter((c) => c.category === 'messaging' && c.operations.some((op) => op.key === 'sendSms'))
      .sort((a, b) => a.key.localeCompare(b.key));
    const smsConnector =
      settings.fallbackSmsConnectorKey === undefined
        ? smsConnectors[0]
        : smsConnectors.find((c) => c.key === settings.fallbackSmsConnectorKey);
    if (smsConnector === undefined) {
      this.deps.logger.warn(
        { templateKey: ref.templateKey, configured: settings.fallbackSmsConnectorKey ?? '(none)' },
        'WhatsApp delivery failed but no active SMS connector is available for the fallback',
      );
      return false;
    }

    const template = await this.deps.templates.resolve(
      ctx.hospitalId,
      ref.templateKey,
      'sms',
      ref.locale as LocaleCode,
    );
    if (!template.ok) return false;

    this.deps.logger.info(
      { templateKey: ref.templateKey, providerStatus: receipt.providerStatus, to: maskPhone(ref.phoneE164) },
      'WhatsApp delivery failed; sending the SMS variant (EN-009 §14.3)',
    );

    // The values are not in the directory: they are PHI and belong in the
    // encrypted payload store. A webhook-driven fallback happens long after the
    // caller has gone, so the SMS variant is rendered from the stored payload of
    // the WhatsApp message that failed — and once that payload has passed its
    // retention window there is nothing to render from, which is refused rather
    // than guessed.
    const payloadValues = await this.originalValues(ctx, ref);
    if (payloadValues === undefined) return false;

    const outcome = await this.send(ctx, {
      templateKey: ref.templateKey,
      to: ref.phoneE164,
      values: payloadValues,
      module: ref.module,
      smsConnectorKey: smsConnector.key,
      channelPolicy: 'sms_only',
      locale: ref.locale as LocaleCode,
      branchId: ref.branchId,
      at: receipt.at,
    });

    if (outcome.status === 'sent') {
      await this.deps.directory.update(ref.messageId, { fallbackMessageId: outcome.messageId });
      return true;
    }
    return false;
  }

  /**
   * The variable values of a sent message, read back from the encrypted payload
   * store through the dispatcher's own retention rules. Returns `undefined` once
   * the payload has been purged, which is the correct answer: a fallback cannot
   * be rendered from a redacted copy.
   */
  private async originalValues(
    ctx: TenantContext,
    ref: SentMessageRef,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    const row = await this.deps.db.withTenant(ctx, (tx) => this.messages.get(tx, ref.messageId));
    if (row?.payload_ref === null || row?.payload_ref === undefined) return undefined;
    const stored = await this.deps.payloads.get(row.payload_ref);
    if (stored === undefined) return undefined;
    const body = stored.body;
    if (typeof body !== 'object' || body === null || !('templateVars' in body)) return undefined;
    const vars = (body as { templateVars?: unknown }).templateVars;
    if (typeof vars !== 'object' || vars === null) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(vars)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }

  /** EN-009 §14.6: a `STOP` reply records a marketing opt-out. */
  private async applyInbound(ctx: TenantContext, inbound: InboundMessage): Promise<boolean> {
    const text = (inbound.buttonPayload ?? inbound.text ?? '').trim().toLowerCase();
    if (!STOP_KEYWORDS.has(text)) return false;

    for (const consentClass of ['promotional', 'service_explicit'] as const) {
      await this.deps.consent.optOut({
        hospitalId: ctx.hospitalId,
        phoneE164: inbound.from,
        channel: 'whatsapp',
        consentClass,
        source: 'whatsapp_reply',
        at: inbound.at,
        evidence: { keyword: text, providerMessageId: inbound.providerMessageId },
      });
      await this.deps.consent.optOut({
        hospitalId: ctx.hospitalId,
        phoneE164: inbound.from,
        channel: 'sms',
        consentClass,
        source: 'whatsapp_reply',
        at: inbound.at,
        evidence: { keyword: text, providerMessageId: inbound.providerMessageId },
      });
    }
    this.deps.logger.info({ to: maskPhone(inbound.from) }, 'inbound STOP recorded as a marketing opt-out');
    return true;
  }

  /** Exposed for the delivery dashboard: the normalised status the hub last saw. */
  async deliveryStatusOf(messageId: string): Promise<DeliveryStatus | undefined> {
    return (await this.deps.directory.byMessageId(messageId))?.status;
  }
}
