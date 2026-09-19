import { z } from 'zod';

/** NC-012 + RC-005 · corporate credit and collections, over the wire. */

const uuid = z.string().uuid();
/** Money as a string, for the reason `ledger.schemas.ts` gives: doubles lose paise. */
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'A money amount with at most two decimals.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const upsertAccountSchema = z.object({
  payerId: uuid,
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(200),
  /** Zero means cash-only. There is no "unlimited" — that must not be a blank field. */
  creditLimit: money.default('0'),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
  tdsApplicable: z.boolean().default(true),
});
export type UpsertAccountRequest = z.infer<typeof upsertAccountSchema>;

export const setHoldSchema = z.object({
  onHold: z.boolean(),
  /**
   * Required when putting an account on hold, and the CHECK constraint says so
   * too. A hold nobody can explain is a hold nobody can lift: the person who
   * set it has gone home and the client is on the phone.
   */
  holdReason: z.string().min(3).max(300).optional(),
});
export type SetHoldRequest = z.infer<typeof setHoldSchema>;

export const raiseInvoiceSchema = z.object({
  accountId: uuid,
  invoiceDate: isoDate,
  periodFrom: isoDate.optional(),
  periodTo: isoDate.optional(),
  /**
   * The bills to consolidate. Amounts are not sent: they are read from the
   * bills themselves, because a caller who could state the amount could state
   * a different one from the bill it names.
   */
  billIds: z.array(uuid).min(1).max(500),
});
export type RaiseInvoiceRequest = z.infer<typeof raiseInvoiceSchema>;

export const cancelInvoiceSchema = z.object({
  cancelReason: z.string().min(3).max(300),
});
export type CancelInvoiceRequest = z.infer<typeof cancelInvoiceSchema>;

export const recordFollowupSchema = z
  .object({
    channel: z.enum(['call', 'email', 'letter', 'visit', 'legal_notice', 'agency_referral']),
    outcome: z.enum(['no_answer', 'promised', 'disputed', 'paid', 'refused', 'escalated']),
    promisedOn: isoDate.optional(),
    promisedAmount: money.optional(),
    note: z.string().max(1000).optional(),
  })
  .refine((v) => v.outcome !== 'promised' || (v.promisedOn !== undefined && v.promisedAmount !== undefined), {
    // The database refuses this too. Saying it here means the caller gets a
    // field-level 400 rather than a constraint name.
    message: 'A promise needs a date and an amount, or it is a note rather than a promise.',
    path: ['promisedOn'],
  });
export type RecordFollowupRequest = z.infer<typeof recordFollowupSchema>;

export const writeOffSchema = z.object({
  amount: money,
  reason: z.string().min(10).max(500),
  /**
   * The person who asked. The approver is the authenticated caller, and the
   * database refuses the case where they are the same — which is the whole
   * point of the table.
   */
  requestedBy: uuid,
});
export type WriteOffRequest = z.infer<typeof writeOffSchema>;

export const ageingQuerySchema = z.object({
  accountId: uuid.optional(),
  bucket: z.enum(['current', '1-30', '31-60', '61-90', '90+']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AgeingQuery = z.infer<typeof ageingQuerySchema>;

export interface CorporateAccountRow {
  readonly id: string;
  readonly payerId: string;
  readonly code: string;
  readonly name: string;
  readonly creditLimit: string;
  readonly paymentTermsDays: number;
  readonly onHold: boolean;
  readonly holdReason: string | null;
  /** Computed from the open invoices, never stored. */
  readonly exposure: string;
  readonly headroom: string;
}

export interface InvoiceRow {
  readonly id: string;
  readonly invoiceNo: string;
  readonly accountId: string;
  readonly invoiceDate: string;
  readonly dueOn: string;
  readonly netAmount: string;
  readonly paidAmount: string;
  readonly tdsDeducted: string;
  readonly writtenOff: string;
  readonly outstanding: string;
  readonly status: string;
  readonly lineCount: number;
}

export interface AgeingRow {
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly dueOn: string;
  readonly outstanding: string;
  readonly daysOverdue: number;
  readonly bucket: string;
  /**
   * Where this invoice sits on the dunning ladder, derived from how overdue it
   * is. Stored on each follow-up when one is logged, so history survives the
   * ladder being reconfigured.
   */
  readonly dunningStage: number;
  readonly nextAction: string;
}

export interface FollowupRow {
  readonly id: string;
  readonly at: string;
  readonly channel: string;
  readonly outcome: string;
  readonly dunningStage: number;
  readonly promisedOn: string | null;
  readonly promisedAmount: string | null;
  readonly note: string | null;
}
