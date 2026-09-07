import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for OP-013 and OP-014.
 *
 * ── There is no field for a discard time, a dose count or a health score ────
 *
 * A vial's discard time comes from the vaccine's own open-vial policy at the
 * puncture; the doses drawn from it are counted from the administrations; the
 * health score is weighted from the domain scores. All three are the database's,
 * and no request can express any of them.
 *
 * ── And no field that skips a station quietly ───────────────────────────────
 *
 * `skipReason` is required whenever a station is skipped, and it appears on the
 * report. The failure this console exists to prevent is a report that reads as
 * complete over a scan nobody did, and a silent skip is exactly how that
 * happens.
 */

const uuid = z.string().uuid();

// ═══════════════════════════════════════════════════════════════════════════
// OP-013 · Immunisation
// ═══════════════════════════════════════════════════════════════════════════

export const openVialSchema = z.object({
  vaccineId: uuid,
  batchNo: z.string().min(1).max(60),
  expiryDate: z.string().date(),
  itemId: uuid.optional(),
  /**
   * Absent means the vaccine's own doses-per-vial. There is deliberately no
   * `discardDueAt`: the clock starts at the puncture, from the vaccine's
   * policy, and a typed one is a vial that has been on a bench since morning.
   */
  dosesTotal: z.number().int().min(1).max(200).optional(),
});
export type OpenVialRequest = z.infer<typeof openVialSchema>;

export const discardVialSchema = z.object({
  reason: z.enum(['time_expired', 'vvm', 'cold_chain_breach', 'contaminated', 'empty']),
  wastageDoses: z.number().int().min(0).max(200).optional(),
});
export type DiscardVialRequest = z.infer<typeof discardVialSchema>;

export const administerSchema = z.object({
  patientId: uuid,
  visitId: uuid.optional(),
  planDoseId: uuid.optional(),
  vaccineId: uuid,
  antigenCode: z.string().min(1).max(24),
  doseNo: z.number().int().min(1).max(20),
  batchNo: z.string().min(1).max(60),
  expiryDate: z.string().date(),
  vvmStage: z.number().int().min(1).max(4).optional(),
  vialId: uuid.optional(),
  diluentBatch: z.string().max(60).optional(),
  site: z.string().min(1).max(40),
  route: z.string().min(1).max(24),
  doseMl: z.number().positive().max(20),
  administeredAt: z.string().datetime(),
  orderedBy: uuid.optional(),
  consentId: uuid.optional(),
  /** Temperature and the contraindication answers. */
  screening: z.record(z.string(), z.unknown()).default({}),
  observationMinutes: z.number().int().min(0).max(240).optional(),
  campId: uuid.optional(),
  /**
   * `external_history` records a dose from a card the family brought. The
   * interval rules still apply to it — a previous dose is a previous dose
   * wherever it was given — but the vial and cold chain rules do not, because
   * it came from somebody else's vial.
   */
  source: z.enum(['in_house', 'camp', 'external_history', 'registry_sync']).default('in_house'),
  externalFacility: z.string().max(160).optional(),
});
export type AdministerRequest = z.infer<typeof administerSchema>;

export const voidDoseSchema = z.object({
  reason: z.string().trim().min(8).max(2000),
});
export type VoidDoseRequest = z.infer<typeof voidDoseSchema>;

export const planDoseUpdateSchema = z.object({
  status: z.enum(['due', 'skipped', 'contraindicated', 'refused', 'given_elsewhere']),
  /** Required by the database for the three that are not "due". */
  reason: z.string().max(2000).optional(),
  nextReminderAt: z.string().date().optional(),
});
export type PlanDoseUpdateRequest = z.infer<typeof planDoseUpdateSchema>;

export const breachSchema = z.object({
  unitId: uuid,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  peakC: z.number().min(-90).max(90),
  /** The batches inside. Every dose from them is refused while the hold stands. */
  batchesAffected: z.array(z.string().max(60)).min(1).max(200),
  note: z.string().max(2000).optional(),
});
export type BreachRequest = z.infer<typeof breachSchema>;

export const breachDecisionSchema = z.object({
  action: z.enum(['released', 'discarded']),
  reason: z.string().trim().min(8).max(2000),
});
export type BreachDecisionRequest = z.infer<typeof breachDecisionSchema>;

export const aefiSchema = z.object({
  patientId: uuid,
  vaccinationRecordIds: z.array(uuid).min(1).max(20),
  onsetAt: z.string().datetime(),
  symptoms: z.record(z.string(), z.unknown()).default({}),
  severity: z.enum(['minor', 'severe', 'serious']),
  category: z
    .enum(['vaccine_reaction', 'programme_error', 'immunisation_anxiety', 'coincidental', 'unknown'])
    .optional(),
  treatment: z.string().max(4000).optional(),
  outcome: z.string().max(24).optional(),
});
export type AefiRequest = z.infer<typeof aefiSchema>;

export const immunisationQuerySchema = z.object({
  patientId: uuid.optional(),
  /** Only doses that are overdue. The recall list. */
  overdueOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ImmunisationQuery = z.infer<typeof immunisationQuerySchema>;

export const vialQuerySchema = z.object({
  /** Only vials still open and still inside their clock. */
  usableOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type VialQuery = z.infer<typeof vialQuerySchema>;

// ═══════════════════════════════════════════════════════════════════════════
// OP-014 · Health check-ups
// ═══════════════════════════════════════════════════════════════════════════

export const hcBookingSchema = z.object({
  patientId: uuid.optional(),
  corporateId: uuid.optional(),
  employeeRef: z.string().max(60).optional(),
  packageId: uuid,
  addOns: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  scheduledAt: z.string().datetime(),
  channel: z.enum(['front_office', 'web', 'app', 'corporate_portal', 'camp', 'call_centre']),
});
export type HcBookingRequest = z.infer<typeof hcBookingSchema>;

export const hcCheckInSchema = z.object({
  patientId: uuid,
  visitId: uuid.optional(),
  consentId: uuid.optional(),
});
export type HcCheckInRequest = z.infer<typeof hcCheckInSchema>;

export const stationUpdateSchema = z
  .object({
    status: z.enum(['called', 'in_progress', 'done', 'skipped', 'not_applicable']),
    /** Required by the database for `skipped` and `not_applicable`. */
    skipReason: z.string().max(2000).optional(),
    sourceRef: uuid.optional(),
  })
  .superRefine((v, ctx) => {
    if (
      (v.status === 'skipped' || v.status === 'not_applicable') &&
      (v.skipReason === undefined || v.skipReason.trim().length < 4)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['skipReason'],
        message:
          'A station that was not done records why, and the reason goes on the report. A silent skip is how a report comes to read as complete over a scan nobody did.',
      });
    }
  });
export type StationUpdateRequest = z.infer<typeof stationUpdateSchema>;

/**
 * A report.
 *
 * `domainScores` goes up; `healthScore` comes back, weighted by the package's
 * model. There is no field for the score itself.
 */
export const hcReportSchema = z.object({
  domainScores: z.record(z.string(), z.number()).default({}),
  riskCalcs: z.record(z.string(), z.unknown()).default({}),
  comparison: z.record(z.string(), z.unknown()).default({}),
  summary: z.string().max(8000).optional(),
  recommendations: z.array(z.record(z.string(), z.unknown())).max(40).default([]),
  referrals: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
});
export type HcReportRequest = z.infer<typeof hcReportSchema>;

export const hcQuerySchema = z.object({
  patientId: uuid.optional(),
  /** Only checks still walking the building. */
  inProgressOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type HcQuery = z.infer<typeof hcQuerySchema>;
