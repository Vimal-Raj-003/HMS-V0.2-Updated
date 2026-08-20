/**
 * Runtime validation of the canonical messaging payloads.
 *
 * An adapter receives `payload: unknown` (that is what makes one interface cover
 * HL7, DICOM and an SMS gateway), so every messaging adapter parses before it
 * touches a field. The alternative — trusting the caller and reading
 * `payload.mobile` — turns a mapping bug into a message sent to `undefined`,
 * which MSG91 accepts, bills for, and delivers nowhere.
 *
 * The schemas are `.strict()` so an unexpected field is an error rather than
 * something quietly dropped on the way to the provider: an extra `attachmentUrl`
 * that no adapter forwards is a feature that appears to work in review and does
 * nothing in production.
 */
import { z } from 'zod';
import {
  DELIVERY_STATUSES,
  DLT_CATEGORIES,
  MESSAGE_CLASSES,
  WHATSAPP_CATEGORIES,
  type OutboundSmsPayload,
  type OutboundWhatsAppPayload,
} from './types.js';
import { MESSAGING_LOCALE_CODES } from './locales.js';

const e164 = z
  .string()
  .regex(/^\+[1-9]\d{7,14}$/, 'recipient must be normalised to E.164 before it reaches an adapter');

export const outboundSmsPayloadSchema = z
  .object({
    channel: z.literal('sms'),
    mobile: e164,
    body: z.string().min(1).max(2000),
    senderId: z.string().min(1).max(11),
    dltEntityId: z.string().min(1).max(64),
    dltTemplateId: z.string().min(1).max(64),
    dltCategory: z.enum(DLT_CATEGORIES),
    templateKey: z.string().min(1).max(96),
    locale: z.enum(MESSAGING_LOCALE_CODES),
    messageClass: z.enum(MESSAGE_CLASSES),
    encoding: z.enum(['gsm7', 'ucs2']),
    segments: z.number().int().min(1).max(20),
    templateVars: z.record(z.string(), z.string()),
    varsHash: z.string().min(1).max(64),
  })
  .strict();

export const outboundWhatsAppPayloadSchema = z
  .object({
    channel: z.literal('whatsapp'),
    mobile: e164,
    templateName: z.string().min(1).max(512),
    languageCode: z.string().min(2).max(10),
    category: z.enum(WHATSAPP_CATEGORIES),
    templateKey: z.string().min(1).max(96),
    locale: z.enum(MESSAGING_LOCALE_CODES),
    messageClass: z.enum(MESSAGE_CLASSES),
    templateParameters: z.array(z.string().max(1024)).readonly(),
    templateButtonParameters: z.array(z.string().max(1024)).readonly().optional(),
    templateVars: z.record(z.string(), z.string()),
    varsHash: z.string().min(1).max(64),
    body: z.string().min(1).max(4096),
  })
  .strict();

/**
 * Compile-time proof that the hand-written interfaces in `types.ts` and the
 * schemas here have not drifted. Exported so `noUnusedLocals` does not delete
 * the check, and never called.
 */
export function assertSmsPayloadShape(payload: OutboundSmsPayload): z.infer<typeof outboundSmsPayloadSchema> {
  return payload;
}

export function assertWhatsAppPayloadShape(
  payload: OutboundWhatsAppPayload,
): z.infer<typeof outboundWhatsAppPayloadSchema> {
  return payload;
}

export const deliveryStatusValues = DELIVERY_STATUSES;
