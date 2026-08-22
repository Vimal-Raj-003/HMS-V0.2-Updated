import { z } from 'zod';

/**
 * Request contracts for NC-001 §6.
 *
 * Every amount is a **decimal string**, never a JSON number. `docs/09 §2` and
 * `primitives/money.ts`: ₹1,234.55 round-tripped through IEEE-754 can arrive as
 * 1234.5499999999999, and a cashier's drawer cannot be reconciled against a
 * number that is nearly right.
 */

export const uuidSchema = z.string().uuid();

/** `numeric(14,2)`: at most 12 integer digits and 2 decimals, no sign. */
export const positiveMoneySchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'amount must be a positive decimal string, e.g. "1234.55"');

export const paymentModeSchema = z.enum([
  'cash',
  'card',
  'upi',
  'netbanking',
  'wallet',
  'cheque',
  'dd',
  'gateway_link',
  'advance_adjust',
  'patient_wallet',
  'credit',
  'staff_credit',
  'emi',
  'forex',
]);

export const denominationLineSchema = z.object({
  denomination: positiveMoneySchema,
  count: z.number().int().min(0).max(100_000),
});

export const openShiftRequestSchema = z.object({
  counterId: uuidSchema,
  denominations: z.array(denominationLineSchema).max(40).default([]),
  floatSource: z.enum(['main_cash', 'previous_shift', 'none']).default('main_cash'),
  previousShiftId: uuidSchema.optional(),
});

export const listShiftsQuerySchema = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  counterId: uuidSchema.optional(),
  status: z.enum(['open', 'closing', 'closed', 'force_closed']).optional(),
  businessDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'businessDate must be YYYY-MM-DD')
    .optional(),
});

export const paymentLineSchema = z.object({
  mode: paymentModeSchema,
  amount: positiveMoneySchema,
  /** Cash only: what the patient handed over, so the change is computed and stored. */
  tendered: positiveMoneySchema.optional(),
  reference: z.string().max(120).optional(),
  gatewayTxnId: z.string().max(120).optional(),
  cardLast4: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
  cardNetwork: z.string().max(24).optional(),
  bank: z.string().max(120).optional(),
  chequeDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /**
   * Digital tenders that the gateway has not confirmed yet (NC-001 §3.3): the
   * receipt exists, the money does not, and the shift cannot close until every
   * one of these is resolved.
   */
  pending: z.boolean().default(false),
});

export const collectPaymentRequestSchema = z.object({
  shiftId: uuidSchema,
  patientId: uuidSchema.optional(),
  visitId: uuidSchema.optional(),
  appointmentId: uuidSchema.optional(),
  kind: z.enum(['payment', 'advance']).default('payment'),
  purpose: z.string().min(2).max(32).default('consultation'),
  amount: positiveMoneySchema,
  payerName: z.string().max(200).optional(),
  /**
   * Who the cash is coming from, for the §269ST per-payer daily aggregate. It
   * defaults to the patient; a corporate or a relative paying for someone else
   * is a different payer and must be named as one, otherwise the cap is trivially
   * evaded by splitting receipts across patients.
   */
  payerRefId: uuidSchema.optional(),
  payerType: z.enum(['patient', 'corporate', 'other']).default('patient'),
  remarks: z.string().max(500).optional(),
  lines: z.array(paymentLineSchema).min(1).max(10),
});

export const closeShiftRequestSchema = z.object({
  denominations: z.array(denominationLineSchema).max(40).default([]),
  varianceReason: z.string().min(3).max(500).optional(),
  handoverTo: z.enum(['main_cash', 'next_shift']).optional(),
  handoverBagNo: z.string().max(48).optional(),
  handoverReceivedBy: uuidSchema.optional(),
});

/**
 * The co-signer block (docs/06 §6.9 friction level 6).
 *
 * `receipt.void` and `receipt.refund.pay` are both flagged `requiresSecondPerson`
 * in the permission catalogue, which means the acting user's own session can
 * never satisfy them.
 */
export const coSignerSchema = z.object({
  identifier: z.string().min(3).max(120),
  credential: z.string().min(4).max(200),
  credentialKind: z.enum(['password', 'pin', 'totp']).default('password'),
});

export const payRefundRequestSchema = z.object({
  shiftId: uuidSchema,
  coSigner: coSignerSchema,
  identityMethod: z.enum(['otp', 'photo_id', 'in_person']).default('in_person'),
});

export const voidReceiptRequestSchema = z.object({
  reason: z.string().min(3).max(500),
  coSigner: coSignerSchema,
});

export type OpenShiftRequest = z.infer<typeof openShiftRequestSchema>;
export type ListShiftsQuery = z.infer<typeof listShiftsQuerySchema>;
export type CollectPaymentRequest = z.infer<typeof collectPaymentRequestSchema>;
export type CloseShiftRequest = z.infer<typeof closeShiftRequestSchema>;
export type PayRefundRequest = z.infer<typeof payRefundRequestSchema>;
export type VoidReceiptRequest = z.infer<typeof voidReceiptRequestSchema>;
export type CoSignerInput = z.infer<typeof coSignerSchema>;
