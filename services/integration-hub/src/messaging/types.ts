/**
 * EN-009 — the vocabulary the messaging connectors share.
 *
 * Everything here is deliberately provider-neutral. MSG91 calls a sender header
 * a `sender`, Twilio calls it a `From`, Meta has no such concept at all and uses
 * an approved template name instead; the send path must not care, because the
 * policy decisions that precede a send — is this template registered with DLT,
 * has this person opted out, is 21:30 too late for a promotional message — are
 * identical whichever wire the message eventually leaves on.
 *
 * Two vocabularies are kept apart on purpose:
 *
 *  * **`MessageClass`** is *ours*: what kind of business fact this is, which is
 *    what EN-009 §5 keys the consent rules to ("critical/transactional …
 *    sendable 24×7 … promotional/marketing requires explicit marketing opt-in +
 *    DND scrub + 9AM–9PM").
 *  * **`DltCategory`** is *TRAI's*: the category the content template was
 *    actually registered under on the DLT portal, which the carrier matches
 *    against the sender header. A hospital cannot send a promotional message
 *    from a header registered for service traffic, and the carrier does not say
 *    so — it drops the message.
 *
 * They are related but not the same, and conflating them is how a template gets
 * registered under a category its content is not allowed to carry.
 */
import { z } from 'zod';
import { MESSAGING_LOCALE_CODES, type LocaleCode } from './locales.js';

export type { LocaleCode };

/** EN-009 §1. RCS is `messaging.rcs`, a later phase; voice is EN-033. */
export const MESSAGE_CHANNELS = ['sms', 'whatsapp'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];
export const messageChannelSchema = z.enum(MESSAGE_CHANNELS);

/**
 * EN-009 §4 `msg_templates.class`, §5 "Class rules".
 *
 * `service` in the spec's data model is spelled `service_explicit` here, because
 * that is the name §5 and the DLT portal both use for the thing that needs
 * recorded consent, and a class called `service` next to a DLT category called
 * `service_explicit` invites exactly the mix-up this file exists to prevent.
 */
export const MESSAGE_CLASSES = ['critical', 'transactional', 'service_explicit', 'promotional'] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];
export const messageClassSchema = z.enum(MESSAGE_CLASSES);

/** TRAI DLT content-template categories. */
export const DLT_CATEGORIES = [
  'transactional',
  'service_implicit',
  'service_explicit',
  'promotional',
] as const;
export type DltCategory = (typeof DLT_CATEGORIES)[number];
export const dltCategorySchema = z.enum(DLT_CATEGORIES);

/**
 * Which DLT categories a class may legitimately be registered under.
 *
 * TRAI reserves the literal `transactional` category for OTP traffic of
 * registered entities (banks, and by extension an OTP for accessing a health
 * record); everything else a hospital sends without marketing consent is
 * *service implicit*. Registering a reminder as `transactional` to dodge the
 * consent rule is the abuse the category system exists to stop, so the registry
 * refuses it rather than letting a hospital discover it in a TRAI complaint.
 */
export const CLASS_TO_DLT_CATEGORIES: Readonly<Record<MessageClass, readonly DltCategory[]>> = Object.freeze({
  critical: ['transactional', 'service_implicit'],
  transactional: ['transactional', 'service_implicit'],
  service_explicit: ['service_explicit'],
  promotional: ['promotional'],
});

/** Meta's template categories (`POST /message_templates`). */
export const WHATSAPP_CATEGORIES = ['AUTHENTICATION', 'UTILITY', 'MARKETING'] as const;
export type WhatsAppCategory = (typeof WHATSAPP_CATEGORIES)[number];
export const whatsAppCategorySchema = z.enum(WHATSAPP_CATEGORIES);

export const CLASS_TO_WHATSAPP_CATEGORY: Readonly<Record<MessageClass, WhatsAppCategory>> = Object.freeze({
  critical: 'AUTHENTICATION',
  transactional: 'UTILITY',
  service_explicit: 'UTILITY',
  promotional: 'MARKETING',
});

/**
 * The closed set of things a template variable may hold.
 *
 * **This is the enforcement point for the rule that matters most.** A template
 * can only interpolate a value whose *type* is on this list, and nothing on this
 * list can carry a diagnosis, a drug or a result. `docs/prompts/phase-01`
 * ("No PHI in SMS/WhatsApp content beyond what the template approval allows")
 * and EN-037 §135 ("a type whose external template contains clinical
 * placeholders fails publication") are both satisfied by the absence of a
 * `clinical`, `result`, `drug` or `diagnosis` member — a template asking for one
 * cannot even be expressed, let alone registered.
 */
export const TEMPLATE_VARIABLE_TYPES = [
  'name',
  'date',
  'time',
  'datetime',
  'amount',
  'code',
  'url',
  'number',
  'place',
  'reference',
] as const;
export type TemplateVariableType = (typeof TEMPLATE_VARIABLE_TYPES)[number];
export const templateVariableTypeSchema = z.enum(TEMPLATE_VARIABLE_TYPES);

/**
 * TRAI's 2024 traceability rules cap a DLT variable at 30 characters. Longer
 * content is silently truncated or dropped by the carrier, so it is refused
 * here — EN-009 §14.10.
 */
export const DLT_VARIABLE_MAX_LENGTH = 30;

/** EN-009 §3.2: the placeholder the DLT portal stores. */
export const DLT_PLACEHOLDER = '{#var#}';

/** How the hub's template body marks a variable: `{{1}}`, `{{2}}`, … */
export const BODY_PLACEHOLDER_RE = /\{\{(\d+)\}\}/g;

/**
 * The normalised delivery lifecycle. Every provider's own vocabulary
 * (`DELIVRD`, `delivered`, `sent`, `read`, `failed`, `undelivered`, `Rejected`)
 * maps onto exactly one of these before it reaches the hub — EN-009 §3.3.2.
 */
export const DELIVERY_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'undelivered',
  'expired',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export const deliveryStatusSchema = z.enum(DELIVERY_STATUSES);

/**
 * Webhooks arrive out of order — a `sent` callback routinely lands after the
 * `delivered` one it precedes. Status is therefore applied by rank, never by
 * arrival: a lower rank can never overwrite a higher one, so a late `sent` does
 * not un-deliver a message the patient has already read.
 */
const DELIVERY_RANK: Readonly<Record<DeliveryStatus, number>> = Object.freeze({
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  // Terminal failures outrank the successes they contradict: a carrier that
  // says `undelivered` after saying `sent` is correcting itself.
  expired: 4,
  undelivered: 5,
  failed: 5,
});

export function deliveryRank(status: DeliveryStatus): number {
  return DELIVERY_RANK[status];
}

/** `true` when `next` is allowed to replace `current`. */
export function supersedesDeliveryStatus(current: DeliveryStatus | undefined, next: DeliveryStatus): boolean {
  if (current === undefined) return true;
  return DELIVERY_RANK[next] > DELIVERY_RANK[current];
}

export const TERMINAL_DELIVERY_FAILURES: ReadonlySet<DeliveryStatus> = new Set<DeliveryStatus>([
  'failed',
  'undelivered',
  'expired',
]);

export function isDeliveryFailure(status: DeliveryStatus): boolean {
  return TERMINAL_DELIVERY_FAILURES.has(status);
}

/**
 * The canonical outbound payload. **This is what is written to
 * `ihub_messages`**, so every field name here is chosen so that the existing
 * redactor tokenises it: `mobile` hits the shared field policy directly (any
 * number in any format becomes `«phone:3210»`, not only the ones the value
 * scanner recognises), and `body`/`templateVars` hit the hub's messaging
 * additions in `phi-redactor.ts`. EN-009 §4 stores `body_rendered` encrypted and
 * only a `vars_hash` in the clear; the encrypted copy here is the payload store.
 */
export interface OutboundSmsPayload {
  readonly channel: 'sms';
  readonly mobile: string;
  readonly body: string;
  readonly senderId: string;
  readonly dltEntityId: string;
  readonly dltTemplateId: string;
  readonly dltCategory: DltCategory;
  readonly templateKey: string;
  readonly locale: LocaleCode;
  readonly messageClass: MessageClass;
  readonly encoding: 'gsm7' | 'ucs2';
  readonly segments: number;
  readonly templateVars: Readonly<Record<string, string>>;
  readonly varsHash: string;
}

export interface OutboundWhatsAppPayload {
  readonly channel: 'whatsapp';
  readonly mobile: string;
  readonly templateName: string;
  readonly languageCode: string;
  readonly category: WhatsAppCategory;
  readonly templateKey: string;
  readonly locale: LocaleCode;
  readonly messageClass: MessageClass;
  /** Positional body parameters, in `{{1}}…{{n}}` order. */
  readonly templateParameters: readonly string[];
  /** URL-button suffixes, when the approved template has a dynamic URL button. */
  readonly templateButtonParameters?: readonly string[];
  readonly templateVars: Readonly<Record<string, string>>;
  readonly varsHash: string;
  /** Rendered for the log and for the SMS fallback; never sent to Meta. */
  readonly body: string;
}

export type OutboundMessagingPayload = OutboundSmsPayload | OutboundWhatsAppPayload;

/** One normalised delivery callback, whatever provider it came from. */
export interface DeliveryReceipt {
  readonly providerMessageId: string;
  readonly status: DeliveryStatus;
  readonly at: Date;
  readonly providerStatus: string;
  readonly errorCode?: string;
  readonly errorText?: string;
  /** Some providers report the billed segment/conversation count on the DLR. */
  readonly segments?: number;
  readonly conversationCategory?: WhatsAppCategory;
}

export const CANONICAL_DELIVERY_RECEIPT = 'MessagingDeliveryReceipt';
export const CANONICAL_INBOUND_MESSAGE = 'MessagingInboundMessage';

/** An inbound patient reply — `STOP`, a button payload, free text (EN-009 §3.4). */
export interface InboundMessage {
  readonly providerMessageId: string;
  readonly from: string;
  readonly at: Date;
  readonly kind: 'text' | 'button' | 'media';
  readonly text?: string;
  readonly buttonPayload?: string;
}

export interface DeliveryEnvelopePayload {
  readonly receipts: readonly DeliveryReceipt[];
  readonly inbound: readonly InboundMessage[];
}

export class WebhookSignatureError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider} webhook signature rejected: ${detail}`);
    this.name = 'WebhookSignatureError';
  }
}

export const localeCodeSchema = z.enum(MESSAGING_LOCALE_CODES);
