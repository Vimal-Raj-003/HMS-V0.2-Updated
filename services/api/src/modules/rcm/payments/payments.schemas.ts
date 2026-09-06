import { z } from 'zod';

/** EN-010 request contracts. */

const uuid = z.string().uuid();
const money = z.coerce.number().min(0.01).max(99_999_999.99);

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const PROVIDERS = ['razorpay', 'phonepe', 'payu', 'cashfree', 'stripe', 'bank_pg'] as const;
export const INTENT_KINDS = [
  'bill',
  'advance',
  'deposit',
  'link',
  'kiosk',
  'portal',
  'website',
  'mandate',
] as const;

export const intentQuerySchema = z.object({
  refId: uuid.optional(),
  status: z
    .enum(['created', 'pending', 'paid', 'partially_paid', 'expired', 'failed', 'cancelled', 'unapplied'])
    .optional(),
  limit: pageLimit,
});
export type IntentQuery = z.infer<typeof intentQuerySchema>;

export const createIntentSchema = z.object({
  kind: z.enum(INTENT_KINDS).default('bill'),
  refType: z.string().trim().min(1).max(24).default('bill'),
  refId: uuid,
  patientId: uuid.optional(),
  amount: money,
  currency: z.string().length(3).default('INR'),
  methodHint: z.enum(['upi_qr', 'pos', 'link', 'checkout', 'any']).default('any'),
  terminalId: uuid.optional(),
  expiresInMinutes: z.coerce.number().int().min(1).max(10_080).default(30),
});
export type CreateIntentRequest = z.infer<typeof createIntentSchema>;

export const cancelIntentSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type CancelIntentRequest = z.infer<typeof cancelIntentSchema>;

/**
 * The webhook body.
 *
 * Deliberately loose: a provider may add fields at any time and a strict schema
 * would reject a delivery we are contractually obliged to acknowledge. What is
 * *required* is only what identifies the event, because that is what makes the
 * replay guard work.
 */
export const webhookSchema = z.object({
  provider: z.enum(PROVIDERS),
  eventId: z.string().trim().min(1).max(160),
  type: z.string().trim().min(1).max(80),
  providerPaymentId: z.string().trim().max(120).optional(),
  providerOrderId: z.string().trim().max(120).optional(),
  amount: money.optional(),
  fee: z.coerce.number().min(0).optional(),
  method: z.enum(['upi', 'card', 'netbanking', 'wallet', 'emi', 'bnpl', 'international', 'pos']).optional(),
  rrn: z.string().trim().max(60).optional(),
  utr: z.string().trim().max(60).optional(),
  errorCode: z.string().trim().max(60).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type WebhookRequest = z.infer<typeof webhookSchema>;

export const requestRefundSchema = z.object({
  amount: money,
  reasonCode: z.string().trim().min(1).max(40),
  reason: z.string().trim().min(1).max(1000),
});
export type RequestRefundRequest = z.infer<typeof requestRefundSchema>;

export const approveRefundSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type ApproveRefundRequest = z.infer<typeof approveRefundSchema>;

export const reconQuerySchema = z.object({
  status: z.string().trim().max(20).optional(),
  exceptionType: z.string().trim().max(40).optional(),
  limit: pageLimit,
});
export type ReconQuery = z.infer<typeof reconQuerySchema>;

export const resolveReconSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type ResolveReconRequest = z.infer<typeof resolveReconSchema>;
