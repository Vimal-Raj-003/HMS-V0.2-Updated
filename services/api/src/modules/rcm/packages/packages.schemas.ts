import { z } from 'zod';

/** OP-023 request contracts. */
const uuid = z.string().uuid();
const money = z.coerce.number().min(0).max(99_999_999.99);

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const PACKAGE_KINDS = [
  'surgical',
  'maternity',
  'health_checkup',
  'dialysis',
  'chemotherapy',
  'physiotherapy',
  'diagnostic',
  'wellness',
  'other',
] as const;
export const PACKAGE_SCOPES = ['op', 'ip', 'day_care', 'any'] as const;
export const VARIANCE_REASONS = [
  'complication',
  'patient_choice',
  'upgrade',
  'clinical_need',
  'error',
  'other',
] as const;
export const BILL_ACTIONS = ['bill_patient', 'bill_insurer', 'absorb', 'convert'] as const;

export const packageQuerySchema = z.object({
  kind: z.enum(PACKAGE_KINDS).optional(),
  status: z.enum(['draft', 'pending_approval', 'active', 'retired']).optional(),
  limit: pageLimit,
});
export type PackageQuery = z.infer<typeof packageQuerySchema>;

export const createPackageSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(200),
  kind: z.enum(PACKAGE_KINDS),
  scope: z.enum(PACKAGE_SCOPES).default('any'),
  departmentId: uuid.optional(),
  losDaysIncluded: z.coerce.number().int().min(0).max(365).optional(),
  validityDays: z.coerce.number().int().min(1).max(3650).default(365),
  maxUnits: z.coerce.number().int().min(1).max(1000).optional(),
  description: z.string().trim().max(4000).optional(),
  isPublic: z.boolean().default(false),
});
export type CreatePackageRequest = z.infer<typeof createPackageSchema>;

export const publishVersionSchema = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  components: z.array(z.record(z.string(), z.unknown())).default([]),
  exclusions: z.array(z.record(z.string(), z.unknown())).default([]),
  rules: z.record(z.string(), z.unknown()).default({}),
  price: money,
  payerPlanId: uuid.optional(),
  aLaCarteTotal: money.optional(),
  reason: z.string().trim().min(1).max(1000),
});
export type PublishVersionRequest = z.infer<typeof publishVersionSchema>;

export const bookSchema = z.object({
  patientId: uuid,
  packageVersionId: uuid,
  payerPlanId: uuid.optional(),
  doctorId: uuid.optional(),
  plannedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  advanceRequired: money.default(0),
});
export type BookRequest = z.infer<typeof bookSchema>;

export const activateSchema = z.object({
  bookingId: uuid.optional(),
  packageVersionId: uuid,
  patientId: uuid,
  encounterId: uuid.optional(),
  admissionId: uuid.optional(),
  unitsTotal: z.coerce.number().int().min(1).max(1000).default(1),
});
export type ActivateRequest = z.infer<typeof activateSchema>;

/**
 * Evaluate one charge against a live activation.
 *
 * The caller passes the charge; the service decides covered, capped, excluded or
 * over. It never guesses — an unmatched component is `excluded`, which puts the
 * amount on the patient's bill *visibly* rather than quietly absorbing it.
 */
export const evaluateChargeSchema = z.object({
  chargeEventId: uuid.optional(),
  serviceId: uuid.optional(),
  amount: money,
  componentType: z.string().trim().max(32).default('service'),
});
export type EvaluateChargeRequest = z.infer<typeof evaluateChargeSchema>;

export const requestVarianceSchema = z.object({
  itemRef: uuid.optional(),
  amount: money,
  reasonCode: z.enum(VARIANCE_REASONS),
  justification: z.string().trim().max(2000).optional(),
  reason: z.string().trim().min(1).max(1000),
});
export type RequestVarianceRequest = z.infer<typeof requestVarianceSchema>;

export const decideVarianceSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'absorbed']),
  billAction: z.enum(BILL_ACTIONS),
  reason: z.string().trim().min(1).max(1000),
});
export type DecideVarianceRequest = z.infer<typeof decideVarianceSchema>;

export const closeActivationSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type CloseActivationRequest = z.infer<typeof closeActivationSchema>;
