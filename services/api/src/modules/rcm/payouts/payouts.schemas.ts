import { z } from 'zod';
import { queryFlag } from '@vims/contracts';

/** NC-034 request contracts. */
const uuid = z.string().uuid();
const money = z.coerce.number().min(0).max(99_999_999.99);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD');

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const PAYOUT_MODELS = ['retainer', 'fee_share', 'visiting_session', 'salaried'] as const;
/**
 * The four bases a doctor can be paid on.
 *
 * There is no `per_referral`, and there is no way to add one here without also
 * adding it to `billing."PayoutBasis"` — which is the point. NC-034 §5.7 asks
 * that a referral commission be *unrepresentable*, not merely rejected.
 */
export const PAYOUT_BASES = [
  'percent_of_net',
  'flat_per_service',
  'per_session',
  'monthly_retainer',
] as const;
export const DISPUTE_CATEGORIES = [
  'missing_line',
  'wrong_rate',
  'wrong_patient',
  'deduction',
  'other',
] as const;

export const contractQuerySchema = z.object({
  doctorId: uuid.optional(),
  activeOnly: queryFlag().default(true),
  limit: pageLimit,
});
export type ContractQuery = z.infer<typeof contractQuerySchema>;

export const createContractSchema = z
  .object({
    doctorId: uuid,
    /**
     * NMC or state council registration. Required for a fee-share arrangement
     * because the anti-kickback rule is specifically about registered
     * practitioners, and a payout to somebody whose registration we never
     * recorded is one nobody can check.
     */
    registrationNo: z.string().trim().max(64).optional(),
    model: z.enum(PAYOUT_MODELS),
    monthlyRetainer: money.optional(),
    sessionRate: money.optional(),
    /** False means 20% under section 206AA rather than 194J's 10%. */
    panOnRecord: z.boolean().default(false),
    tdsExemptionRef: z.string().trim().max(64).optional(),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.optional(),
    notes: z.string().trim().max(2000).optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .refine((v) => v.model !== 'retainer' || v.monthlyRetainer !== undefined, {
    message: 'A retainer contract needs the monthly amount.',
  })
  .refine((v) => v.model !== 'visiting_session' || v.sessionRate !== undefined, {
    message: 'A visiting-session contract needs the per-session rate.',
  })
  .refine((v) => v.model !== 'fee_share' || v.registrationNo !== undefined, {
    message:
      'A fee-share contract records the council registration. The anti-kickback rule applies to registered practitioners, and a payout to somebody whose registration was never recorded cannot be checked against it.',
  });
export type CreateContractRequest = z.infer<typeof createContractSchema>;

export const createRuleSchema = z
  .object({
    contractId: uuid,
    name: z.string().trim().min(1).max(200),
    basis: z.enum(PAYOUT_BASES),
    serviceId: uuid.optional(),
    departmentId: uuid.optional(),
    payerType: z.string().trim().max(24).optional(),
    itemType: z.string().trim().max(24).optional(),
    sharePct: z.coerce.number().min(0.01).max(100).optional(),
    flatAmount: money.optional(),
    priority: z.coerce.number().int().min(0).max(1000).default(0),
    slabs: z
      .array(
        z.object({
          fromAmount: money,
          toAmount: money.optional(),
          sharePct: z.coerce.number().min(0.01).max(100),
        }),
      )
      .max(10)
      .default([]),
  })
  .refine((v) => v.basis !== 'percent_of_net' || v.sharePct !== undefined, {
    message: 'A percentage rule needs a percentage.',
  })
  .refine((v) => v.basis === 'percent_of_net' || v.flatAmount !== undefined, {
    message: 'A flat, per-session or retainer rule needs an amount.',
  });
export type CreateRuleRequest = z.infer<typeof createRuleSchema>;

export const periodQuerySchema = z.object({ limit: pageLimit });
export type PeriodQuery = z.infer<typeof periodQuerySchema>;

export const openPeriodSchema = z.object({
  label: z.string().trim().min(1).max(24),
  periodFrom: isoDate,
  periodTo: isoDate,
});
export type OpenPeriodRequest = z.infer<typeof openPeriodSchema>;

/**
 * Compute the period's statements.
 *
 * Every line is built from a bill item the doctor **performed**. The database
 * refuses anything else, so a rule that would pay for a referral produces a
 * refusal at compute time rather than a payment nobody notices.
 */
export const computePeriodSchema = z.object({
  doctorIds: z.array(uuid).max(200).default([]),
});
export type ComputePeriodRequest = z.infer<typeof computePeriodSchema>;

export const statementQuerySchema = z.object({
  periodId: uuid.optional(),
  doctorId: uuid.optional(),
  status: z.string().trim().max(24).optional(),
  limit: pageLimit,
});
export type StatementQuery = z.infer<typeof statementQuerySchema>;

export const approveStatementSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type ApproveStatementRequest = z.infer<typeof approveStatementSchema>;

export const payStatementSchema = z.object({
  paymentRef: z.string().trim().min(1).max(64),
  reason: z.string().trim().min(1).max(1000),
});
export type PayStatementRequest = z.infer<typeof payStatementSchema>;

export const raiseDisputeSchema = z.object({
  category: z.enum(DISPUTE_CATEGORIES),
  claim: z.string().trim().min(1).max(4000),
  claimedAmount: money.optional(),
});
export type RaiseDisputeRequest = z.infer<typeof raiseDisputeSchema>;

export const resolveDisputeSchema = z.object({
  outcome: z.enum(['upheld', 'rejected']),
  adjustment: money.optional(),
  reason: z.string().trim().min(1).max(2000),
});
export type ResolveDisputeRequest = z.infer<typeof resolveDisputeSchema>;

export const tdsQuerySchema = z.object({
  financialYear: z.string().trim().max(9).optional(),
  doctorId: uuid.optional(),
  limit: pageLimit,
});
export type TdsQuery = z.infer<typeof tdsQuerySchema>;
