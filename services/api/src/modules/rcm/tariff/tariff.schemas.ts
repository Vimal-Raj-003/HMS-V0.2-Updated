import { z } from 'zod';

/**
 * RC-003 request contracts.
 *
 * Zod rather than class-validator, for the reason `main.ts` states: the same
 * schema object runs in the browser and here, so a rule cannot be enforced on
 * one side and forgotten on the other.
 */

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD');
const money = z.coerce.number().min(0).max(99_999_999.99);
const percent = z.coerce.number().min(0).max(100);

export const cursor = z.string().max(512).optional();
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const idSchema = uuid;

export const PLAN_TYPES = [
  'self_pay',
  'corporate',
  'tpa',
  'insurer',
  'government_scheme',
  'staff',
  'camp',
] as const;

export const TIME_BANDS = ['normal', 'after_hours', 'night', 'holiday', 'emergency'] as const;
export const TAX_TREATMENTS = ['exempt', 'taxable', 'nil_rated'] as const;

export const planQuerySchema = z.object({
  planType: z.enum(PLAN_TYPES).optional(),
  payerId: uuid.optional(),
  branchId: uuid.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  cursor,
  limit: pageLimit,
});
export type PlanQuery = z.infer<typeof planQuerySchema>;

export const createPlanSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  planType: z.enum(PLAN_TYPES),
  currency: z.string().length(3).default('INR'),
  branchId: uuid.optional(),
  payerId: uuid.optional(),
  schemeId: uuid.optional(),
  corporateId: uuid.optional(),
  scope: z.enum(['branch', 'hospital', 'group']).default('hospital'),
  derivedFromPlanId: uuid.optional(),
  derivationFormula: z.record(z.string(), z.unknown()).optional(),
  priority: z.coerce.number().int().min(0).max(999).default(0),
  isDefaultSelfPay: z.boolean().default(false),
});
export type CreatePlanRequest = z.infer<typeof createPlanSchema>;

export const versionQuerySchema = z.object({ cursor, limit: pageLimit });
export type VersionQuery = z.infer<typeof versionQuerySchema>;

export const createVersionSchema = z.object({
  effectiveFrom: isoDate,
  effectiveTo: isoDate.optional(),
  changeNote: z.string().trim().max(2000).optional(),
  /** Copy every item from this published version into the new draft. */
  cloneFromVersionId: uuid.optional(),
});
export type CreateVersionRequest = z.infer<typeof createVersionSchema>;

export const itemQuerySchema = z.object({
  serviceId: uuid.optional(),
  bedClassId: uuid.optional(),
  cursor,
  limit: pageLimit,
});
export type ItemQuery = z.infer<typeof itemQuerySchema>;

/**
 * Bulk upsert of rate rows. Capped at 5,000 per request by RC-003 §6 — a
 * revision of an entire price list is a few requests, not one that holds a
 * transaction open across a hospital's whole catalogue.
 */
export const upsertItemsSchema = z.object({
  items: z
    .array(
      z.object({
        serviceId: uuid,
        bedClassId: uuid.optional(),
        timeBand: z.enum(TIME_BANDS).optional(),
        unit: z.string().trim().max(32).default('each'),
        baseRate: money,
        minRate: money.optional(),
        maxRate: money.optional(),
        hsnSac: z.string().trim().max(16).optional(),
        taxTreatment: z.enum(TAX_TREATMENTS).default('exempt'),
        gstRate: percent.default(0),
        costAmount: money.optional(),
        payerCode: z.string().trim().max(64).optional(),
        isNegotiable: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(5000),
  reason: z.string().trim().min(1).max(1000),
});
export type UpsertItemsRequest = z.infer<typeof upsertItemsSchema>;

export const submitSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type SubmitRequest = z.infer<typeof submitSchema>;

export const publishSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  /**
   * Publishing a rate below its recorded cost is legitimate — scheme plans
   * routinely are — but RC-003 §5 requires it to be acknowledged rather than
   * slipped through. Without this the publish is refused and names the rows.
   */
  acceptBelowCost: z.boolean().default(false),
});
export type PublishRequest = z.infer<typeof publishSchema>;

export const withdrawSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type WithdrawRequest = z.infer<typeof withdrawSchema>;

/**
 * The hot path. Everything is optional except the service and the branch,
 * because a self-pay walk-in names no payer and an OPD line has no bed class.
 */
export const resolveQuerySchema = z.object({
  serviceId: uuid,
  branchId: uuid.optional(),
  payerId: uuid.optional(),
  schemeId: uuid.optional(),
  corporateId: uuid.optional(),
  bedClassId: uuid.optional(),
  timeBand: z.enum(TIME_BANDS).optional(),
  /** Defaults to today. A back-dated charge must price at the date of service. */
  at: isoDate.optional(),
});
export type ResolveQuery = z.infer<typeof resolveQuerySchema>;

export const resolveBatchSchema = z.object({
  branchId: uuid.optional(),
  payerId: uuid.optional(),
  schemeId: uuid.optional(),
  corporateId: uuid.optional(),
  bedClassId: uuid.optional(),
  at: isoDate.optional(),
  serviceIds: z.array(uuid).min(1).max(500),
});
export type ResolveBatchRequest = z.infer<typeof resolveBatchSchema>;

export const missingRateQuerySchema = z.object({
  status: z.enum(['open', 'priced', 'waived']).optional(),
  cursor,
  limit: pageLimit,
});
export type MissingRateQuery = z.infer<typeof missingRateQuerySchema>;

export const resolveMissingSchema = z.object({
  action: z.enum(['priced', 'waived']),
  reason: z.string().trim().min(1).max(1000),
});
export type ResolveMissingRequest = z.infer<typeof resolveMissingSchema>;

export const changeLogQuerySchema = z.object({
  versionId: uuid.optional(),
  serviceId: uuid.optional(),
  cursor,
  limit: pageLimit,
});
export type ChangeLogQuery = z.infer<typeof changeLogQuerySchema>;
