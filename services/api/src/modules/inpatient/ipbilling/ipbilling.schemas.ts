import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

const uuid = z.string().uuid();

export const chargeRunSchema = z.object({
  /** The service day to charge. Defaults to yesterday, which is what the schedule asks for. */
  forDate: z.string().date().optional(),
  admissionId: uuid.optional(),
  trigger: z.enum(['schedule', 'manual', 'transfer', 'discharge']).default('manual'),
});
export type ChargeRunRequest = z.infer<typeof chargeRunSchema>;

export const policySchema = z.object({
  policy: z.enum(['day_boundary', 'higher_class', 'hourly_proration']),
  cutoffHour: z.number().int().min(0).max(23).default(0),
  dischargeGraceMinutes: z.number().int().min(0).max(1440).default(120),
  admissionGraceMinutes: z.number().int().min(0).max(1440).default(0),
  minimumDays: z.number().int().min(1).max(30).default(1),
  dayCareFlat: z.number().nonnegative().optional(),
  gstThresholdPerDay: z.number().nonnegative().default(5000),
  roomGstRate: z.number().min(0).max(28).default(5),
});
export type PolicyRequest = z.infer<typeof policySchema>;

export const clearanceOverrideSchema = z.object({
  acknowledgement: z.string().trim().min(12).max(2000),
});
export type ClearanceOverrideRequest = z.infer<typeof clearanceOverrideSchema>;

export const chargeQuerySchema = z.object({
  admissionId: uuid,
  includeSuperseded: queryFlag().default(false),
});
export type ChargeQuery = z.infer<typeof chargeQuerySchema>;
