import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for OP-033, IP-015 and OP-034.
 *
 * ── Every weight is in grams ────────────────────────────────────────────────
 *
 * There is no `weightKg` on a child or a neonate anywhere in this module. A
 * newborn's weight entered in kilograms is a dose out by a factor of a
 * thousand, and a range check does not catch it — 3 passes any range written
 * for kilograms. The way to prevent it is to have nowhere to put the number.
 *
 * ── And no dose, no centile, no burden ──────────────────────────────────────
 *
 * The dose after the adult ceiling, the centile against the WHO standard, the
 * anticholinergic sum and the Beers flags are all the database's. The ceiling in
 * particular has no override field: a child who needs more than an adult dose
 * needs a different drug, and a field for it would turn the commonest
 * paediatric overdose into a permitted one.
 */

const uuid = z.string().uuid();

export const growthSchema = z.object({
  patientId: uuid,
  measuredAt: z.string().optional(),
  /** Days, because a chart at three weeks and at three months are different charts. */
  ageDays: z.number().int().min(0).max(7300),
  /** WHO publishes separate standards, and the wrong one shifts a centile by half a band. */
  sex: z.enum(['male', 'female']),
  weightG: z.number().int().min(1).max(200000).optional(),
  lengthCm: z.number().min(20).max(200).optional(),
  hcCm: z.number().min(20).max(70).optional(),
});
export type GrowthRequest = z.infer<typeof growthSchema>;

export const paedDoseSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  drugKey: z.string().min(1).max(80),
  drugName: z.string().min(1).max(160),
  weightG: z.number().int().min(1).max(200000),
  ageDays: z.number().int().min(0).max(7300),
  doseMgPerKg: z.number().positive().max(10000),
  frequency: z.string().min(1).max(24),
  route: z.enum(['po', 'iv', 'im', 'sc', 'pr', 'topical', 'inhaled', 'neb']),
  dosesPerDay: z.number().int().min(1).max(24).default(1),
  /** The ceiling. Not a suggestion, and there is no field that lifts it. */
  adultMaxSingleMg: z.number().positive().max(100000).optional(),
  adultMaxDailyMg: z.number().positive().max(100000).optional(),
});
export type PaedDoseRequest = z.infer<typeof paedDoseSchema>;

export const nicuAdmissionSchema = z.object({
  patientId: uuid,
  admissionId: uuid.optional(),
  newbornId: uuid.optional(),
  birthAt: z.string(),
  gaWeeksAtBirth: z.number().int().min(20).max(45),
  gaDaysAtBirth: z.number().int().min(0).max(6).default(0),
  birthWeightG: z.number().int().min(200).max(8000),
  admittedAt: z.string().optional(),
});
export type NicuAdmissionRequest = z.infer<typeof nicuAdmissionSchema>;

export const nicuFluidSchema = z.object({
  forDate: z.string().date(),
  /** Today's weight, in grams. */
  weightG: z.number().int().min(200).max(10000),
  mlPerKgPerDay: z.number().min(20).max(220),
  fluid: z.string().min(1).max(80),
  additives: z.array(z.record(z.string(), z.unknown())).max(10).default([]),
  /** Enteral feeds, subtracted from the intravenous total. */
  enteralMl: z.number().min(0).max(2000).default(0),
});
export type NicuFluidRequest = z.infer<typeof nicuFluidSchema>;

export const geriAssessmentSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  ageYears: z.number().int().min(0).max(130),
  /** The five limbs of the Fried phenotype. The score is not among them. */
  friedItems: z.object({
    weightLoss: z.boolean(),
    exhaustion: z.boolean(),
    lowActivity: z.boolean(),
    slowGait: z.boolean(),
    weakGrip: z.boolean(),
  }),
  fallsLastYear: z.number().int().min(0).max(365).default(0),
  fallsInjury: z.boolean().default(false),
  /** Barthel, in fives. */
  adlBarthel: z.number().int().min(0).max(100).multipleOf(5).optional(),
  cognition: z.record(z.string(), z.unknown()).default({}),
  mood: z.record(z.string(), z.unknown()).default({}),
  continence: z.record(z.string(), z.unknown()).default({}),
  social: z.record(z.string(), z.unknown()).default({}),
});
export type GeriAssessmentRequest = z.infer<typeof geriAssessmentSchema>;

export const medicationReviewSchema = z.object({
  patientId: uuid,
  assessmentId: uuid.optional(),
  ageYears: z.number().int().min(0).max(130),
  /** The list. The burden and the flags come out of it. */
  medications: z
    .array(
      z.object({
        drugKey: z.string().min(1).max(80),
        drugName: z.string().min(1).max(160),
        dose: z.string().max(80).optional(),
        indication: z.string().max(160).optional(),
      }),
    )
    .min(1)
    .max(60),
  actions: z.array(z.record(z.string(), z.unknown())).max(60).default([]),
  /**
   * A Beers criterion is a prompt rather than a prohibition, and continuing a
   * flagged drug is often right. This is where the reason goes.
   */
  justifications: z.array(z.record(z.string(), z.unknown())).max(60).default([]),
});
export type MedicationReviewRequest = z.infer<typeof medicationReviewSchema>;

export const growthQuerySchema = z.object({
  patientId: uuid.optional(),
  falteringOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(300).default(100),
});
export type GrowthQuery = z.infer<typeof growthQuerySchema>;

export const nicuQuerySchema = z.object({
  currentOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type NicuQuery = z.infer<typeof nicuQuerySchema>;

export const geriQuerySchema = z.object({
  patientId: uuid.optional(),
  highBurdenOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type GeriQuery = z.infer<typeof geriQuerySchema>;
