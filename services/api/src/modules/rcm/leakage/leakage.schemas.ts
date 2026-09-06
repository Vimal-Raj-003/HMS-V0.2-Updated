import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/** RC-006 request contracts. */
const uuid = z.string().uuid();
const money = z.coerce.number().min(0).max(99_999_999.99);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date is YYYY-MM-DD');

export const idSchema = uuid;
export const pageLimit = z.coerce.number().int().min(1).max(200).default(50);

export const RECONCILERS = [
  'orders_vs_charges',
  'dispense_vs_charges',
  'consignment_vs_charges',
  'discount_without_approval',
] as const;
export const SEVERITIES = ['low', 'medium', 'high'] as const;
export const FINDING_STATUSES = ['open', 'accepted', 'dismissed', 'recovered', 'expired'] as const;
export const RECOVERY_ROUTES = ['billed_to_patient', 'billed_to_payer', 'absorbed', 'written_off'] as const;

export const ruleQuerySchema = z.object({ limit: pageLimit });
export type RuleQuery = z.infer<typeof ruleQuerySchema>;

export const upsertRuleSchema = z.object({
  reconciler: z.enum(RECONCILERS),
  name: z.string().trim().min(1).max(200),
  /**
   * Below this the finding is not raised. A ₹5 gap costs more to work than it
   * recovers, and a worklist full of them is one nobody opens — which is how a
   * ₹40,000 implant gap ends up buried.
   */
  minGapAmount: money.default(0),
  severity: z.enum(SEVERITIES).default('medium'),
  lookbackDays: z.coerce.number().int().min(1).max(3650).default(30),
  isActive: queryFlag().default(true),
  notes: z.string().trim().max(2000).optional(),
});
export type UpsertRuleRequest = z.infer<typeof upsertRuleSchema>;

/**
 * Run the reconciliations.
 *
 * `encounterId` narrows it to one episode, which is what the pre-discharge
 * check does; without it the scan sweeps the window.
 */
export const runScanSchema = z.object({
  encounterId: uuid.optional(),
  windowFrom: isoDate.optional(),
  windowTo: isoDate.optional(),
  trigger: z.enum(['nightly', 'on_demand', 'pre_discharge']).default('on_demand'),
  reconcilers: z.array(z.enum(RECONCILERS)).max(10).default([]),
});
export type RunScanRequest = z.infer<typeof runScanSchema>;

export const scanQuerySchema = z.object({
  encounterId: uuid.optional(),
  limit: pageLimit,
});
export type ScanQuery = z.infer<typeof scanQuerySchema>;

export const findingQuerySchema = z.object({
  status: z.enum(FINDING_STATUSES).optional(),
  reconciler: z.enum(RECONCILERS).optional(),
  encounterId: uuid.optional(),
  limit: pageLimit,
});
export type FindingQuery = z.infer<typeof findingQuerySchema>;

/** Accepting is the permission to bill, not the billing. */
export const acceptFindingSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type AcceptFindingRequest = z.infer<typeof acceptFindingSchema>;

export const dismissFindingSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type DismissFindingRequest = z.infer<typeof dismissFindingSchema>;

export const recordRecoverySchema = z.object({
  amount: money,
  route: z.enum(RECOVERY_ROUTES).default('billed_to_patient'),
  billId: uuid.optional(),
  reason: z.string().trim().min(1).max(1000),
});
export type RecordRecoveryRequest = z.infer<typeof recordRecoverySchema>;

/**
 * Exit gate 9: the pre-discharge missed-charge check.
 *
 * Runs the reconcilers over one encounter and records what was open. `cleared`
 * comes back false when there is anything outstanding — clearing it anyway is a
 * separate call on a separate permission, because letting a patient leave with
 * money on the table is a decision, not a formality.
 */
export const dischargeCheckSchema = z.object({
  encounterId: uuid,
  patientId: uuid.optional(),
});
export type DischargeCheckRequest = z.infer<typeof dischargeCheckSchema>;

export const overrideDischargeSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
export type OverrideDischargeRequest = z.infer<typeof overrideDischargeSchema>;
