import { z } from 'zod';

/** OP-005 request contracts. */

const uuid = z.string().uuid();
const money = z.coerce.number().min(0).max(99_999_999.99);

export const cursor = z.string().max(512).optional();
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);
export const idSchema = uuid;

export const BILL_TYPES = [
  'op',
  'ip',
  'er',
  'daycare',
  'pharmacy_otc',
  'lab_walkin',
  'package',
  'misc',
] as const;
export const PAYER_TYPES = ['self', 'insurance', 'corporate', 'scheme', 'staff', 'charity'] as const;
export const ITEM_TYPES = [
  'consult',
  'lab',
  'rad',
  'pharmacy',
  'procedure',
  'consumable',
  'package',
  'room',
  'other',
] as const;

export const billQuerySchema = z.object({
  patientId: uuid.optional(),
  visitId: uuid.optional(),
  status: z.enum(['draft', 'open', 'finalized', 'partially_paid', 'paid', 'cancelled', 'void']).optional(),
  cursor,
  limit: pageLimit,
});
export type BillQuery = z.infer<typeof billQuerySchema>;

export const openBillSchema = z.object({
  patientId: uuid,
  visitId: uuid.optional(),
  billType: z.enum(BILL_TYPES).default('op'),
  payerType: z.enum(PAYER_TYPES).default('self'),
  payerId: uuid.optional(),
  policyRef: z.string().trim().max(64).optional(),
  remarks: z.string().trim().max(1000).optional(),
});
export type OpenBillRequest = z.infer<typeof openBillSchema>;

/**
 * Posting charges. `sourceModule` + `sourceRefId` are the identity of the
 * clinical event, and the database's UNIQUE index over them is what makes a
 * replayed event a no-op (phase-05 exit gate 2). They are required for exactly
 * that reason — a line with no provenance cannot be deduplicated, and a charge
 * nobody can trace back to an event is a charge nobody can defend.
 */
export const postItemsSchema = z.object({
  items: z
    .array(
      z.object({
        serviceId: uuid.optional(),
        itemType: z.enum(ITEM_TYPES),
        description: z.string().trim().min(1).max(300),
        qty: z.coerce.number().min(0.001).max(999_999).default(1),
        /** Omit to price through RC-003. Supplying one records `manual`. */
        unitPrice: money.optional(),
        departmentId: uuid.optional(),
        performingDoctorId: uuid.optional(),
        orderingDoctorId: uuid.optional(),
        sourceModule: z.string().trim().min(1).max(32),
        sourceRefId: uuid,
        performedAt: z.string().datetime({ offset: true }).optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type PostItemsRequest = z.infer<typeof postItemsSchema>;

export const finalizeSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  /** Intra-state unless the recipient's state differs (OP-005 §5). */
  placeOfSupplyState: z.string().length(2).optional(),
  recipientGstin: z.string().trim().max(20).optional(),
  recipientName: z.string().trim().max(200).optional(),
});
export type FinalizeRequest = z.infer<typeof finalizeSchema>;

export const cancelBillSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type CancelBillRequest = z.infer<typeof cancelBillSchema>;

export const requestDiscountSchema = z
  .object({
    billItemId: uuid.optional(),
    pct: z.coerce.number().min(0).max(100).optional(),
    amount: money.optional(),
    reasonCode: z.string().trim().min(1).max(40),
    justification: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.pct !== undefined || v.amount !== undefined, {
    message: 'Give a percentage or an amount.',
  });
export type RequestDiscountRequest = z.infer<typeof requestDiscountSchema>;

export const decideDiscountSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason: z.string().trim().min(1).max(1000),
});
export type DecideDiscountRequest = z.infer<typeof decideDiscountSchema>;

export const creditNoteSchema = z.object({
  amount: money,
  reason: z.string().trim().min(1).max(1000),
});
export type CreditNoteRequest = z.infer<typeof creditNoteSchema>;

export const exceptionQuerySchema = z.object({
  status: z.string().trim().max(24).optional(),
  cursor,
  limit: pageLimit,
});
export type ExceptionQuery = z.infer<typeof exceptionQuerySchema>;
