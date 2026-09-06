import { z } from 'zod';

/** RC-008 request contracts. */
const uuid = z.string().uuid();
const money = z.coerce.number().min(0).max(99_999_999.99);

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const CONFIDENCES = ['firm', 'capped', 'indicative', 'contingent'] as const;
export const SOURCES = ['tariff', 'package', 'scheme', 'template', 'manual'] as const;
export const SHARE_CHANNELS = ['whatsapp', 'sms', 'email', 'print', 'portal', 'counter'] as const;
export const ESTIMATE_STATUSES = [
  'draft',
  'issued',
  'accepted',
  'declined',
  'expired',
  'converted',
  'superseded',
] as const;

export const templateQuerySchema = z.object({
  activeOnly: z.coerce.boolean().default(true),
  limit: pageLimit,
});
export type TemplateQuery = z.infer<typeof templateQuerySchema>;

export const createTemplateSchema = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  specialty: z.string().trim().max(120).optional(),
  procedureCode: z.string().trim().max(40).optional(),
  assumedLosDays: z.coerce.number().int().min(0).max(365).default(1),
  notes: z.string().trim().max(2000).optional(),
  lines: z
    .array(
      z.object({
        serviceId: uuid.optional(),
        description: z.string().trim().min(1).max(300),
        quantity: z.coerce.number().min(0.001).max(9999).default(1),
        /** A bed charge or nursing line multiplies by the length of stay. */
        perDay: z.boolean().default(false),
        confidence: z.enum(CONFIDENCES).default('firm'),
      }),
    )
    .min(1)
    .max(200),
});
export type CreateTemplateRequest = z.infer<typeof createTemplateSchema>;

export const estimateQuerySchema = z.object({
  status: z.enum(ESTIMATE_STATUSES).optional(),
  patientId: uuid.optional(),
  procedureCode: z.string().trim().max(40).optional(),
  limit: pageLimit,
});
export type EstimateQuery = z.infer<typeof estimateQuerySchema>;

/**
 * Build a draft.
 *
 * Either a template or an explicit line list. Both accept a length of stay,
 * because the per-day lines are where most of the variance lives and a quote
 * that assumes three days when the surgeon expects seven is wrong before it is
 * printed.
 *
 * `patientId` is optional on purpose: a walk-in enquiry is quoted before anyone
 * is registered, and refusing until then is how a family goes to the hospital
 * that would quote them.
 */
export const createEstimateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    patientId: uuid.optional(),
    enquirerName: z.string().trim().max(200).optional(),
    enquirerPhone: z.string().trim().max(20).optional(),
    encounterId: uuid.optional(),
    templateId: uuid.optional(),
    procedureCode: z.string().trim().max(40).optional(),
    losDays: z.coerce.number().int().min(0).max(365).default(1),
    payerId: uuid.optional(),
    schemeId: uuid.optional(),
    packageId: uuid.optional(),
    bedClassId: uuid.optional(),
    coPayPct: z.coerce.number().min(0).max(100).default(0),
    deductible: money.default(0),
    notes: z.string().trim().max(4000).optional(),
    lines: z
      .array(
        z.object({
          serviceId: uuid.optional(),
          description: z.string().trim().min(1).max(300),
          quantity: z.coerce.number().min(0.001).max(9999).default(1),
          /** Omitted means "price it through the tariff", like a bill line. */
          unitRate: money.optional(),
          perDay: z.boolean().default(false),
          confidence: z.enum(CONFIDENCES).default('firm'),
        }),
      )
      .max(200)
      .default([]),
  })
  .refine((v) => v.templateId !== undefined || v.lines.length > 0, {
    message: 'An estimate needs either a template or at least one line.',
  });
export type CreateEstimateRequest = z.infer<typeof createEstimateSchema>;

export const updateEstimateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  losDays: z.coerce.number().int().min(0).max(365).optional(),
  coPayPct: z.coerce.number().min(0).max(100).optional(),
  deductible: money.optional(),
  notes: z.string().trim().max(4000).optional(),
  patientId: uuid.optional(),
  enquirerName: z.string().trim().max(200).optional(),
  enquirerPhone: z.string().trim().max(20).optional(),
});
export type UpdateEstimateRequest = z.infer<typeof updateEstimateSchema>;

/**
 * Issue it.
 *
 * `validDays` rather than a date: an estimate's shelf life is a policy of the
 * hospital, not a choice the desk makes per family, and a typed date is how one
 * quote ends up valid for a year.
 *
 * `scenarioBedClassIds` prices the same lines in other room classes. "What if we
 * take a general ward bed?" is the commonest question a family asks, and
 * answering it on the printed quote saves them a second trip.
 */
export const issueEstimateSchema = z.object({
  validDays: z.coerce.number().int().min(1).max(365).default(30),
  scenarioBedClassIds: z.array(uuid).max(6).default([]),
  reason: z.string().trim().min(1).max(1000),
});
export type IssueEstimateRequest = z.infer<typeof issueEstimateSchema>;

/**
 * `reason` is required because `est.share` is an `export` action, and EN-024 §5
 * makes every export carry one. Sending a quote is routine, but it puts a
 * costing for a named person onto a phone number somebody typed by hand, and
 * the reason is what makes a misdirected send traceable afterwards.
 */
export const shareEstimateSchema = z.object({
  channel: z.enum(SHARE_CHANNELS),
  reason: z.string().trim().min(1).max(1000),
});
export type ShareEstimateRequest = z.infer<typeof shareEstimateSchema>;

export const recordOutcomeSchema = z
  .object({
    outcome: z.enum(['accepted', 'declined', 'converted', 'expired']),
    encounterId: uuid.optional(),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((v) => v.outcome !== 'converted' || v.encounterId !== undefined, {
    message: 'A converted estimate names the encounter it became.',
  })
  .refine((v) => v.outcome !== 'declined' || (v.reason !== undefined && v.reason.length > 0), {
    message: 'A declined estimate records why. A run of declines on one procedure is a pricing signal.',
  });
export type RecordOutcomeRequest = z.infer<typeof recordOutcomeSchema>;

/**
 * Exit gate 8: reconcile the quote against the bill it became.
 *
 * `actualTotal` is passed rather than read from `billing.bills` so the same
 * endpoint works for an episode billed across several documents, and so a
 * reconciliation can be recorded for a bill that has not been finalised yet.
 * The arithmetic is checked by the database either way.
 */
export const recordVarianceSchema = z.object({
  actualTotal: money,
  actualPatientShare: money,
  billId: uuid.optional(),
  actualLos: z.coerce.number().int().min(0).max(365).optional(),
  explanation: z.string().trim().max(2000).optional(),
});
export type RecordVarianceRequest = z.infer<typeof recordVarianceSchema>;

export const varianceQuerySchema = z.object({
  procedureCode: z.string().trim().max(40).optional(),
  limit: pageLimit,
});
export type VarianceQuery = z.infer<typeof varianceQuerySchema>;
