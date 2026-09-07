import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for the four therapy consoles.
 *
 * ── There is no field for a derived number, again ───────────────────────────
 *
 * No wound `areaCm2`, no `areaReductionPct`, no `trajectory`, no diet plan
 * `totals`, no episode `closedAt`. Each is a trigger's output, and the proof
 * that it cannot be overridden is that no request can express it.
 *
 * ── And no field for an acknowledgement on the order that needs one ─────────
 *
 * `swallowOrderSchema` carries the levels and the strategies; it does not carry
 * `ackKitchenBy`. Acknowledging is a separate route with a separate permission
 * held by the kitchen and the ward, because a therapist acknowledging their own
 * order on behalf of a kitchen that has not seen it is the failure the rule
 * exists to catch, done with better paperwork.
 */

const uuid = z.string().uuid();

// ═══════════════════════════════════════════════════════════════════════════
// The therapy spine — OP-015, shared by all four
// ═══════════════════════════════════════════════════════════════════════════

export const episodeSchema = z.object({
  patientId: uuid,
  discipline: z.enum(['physio', 'wound', 'nutrition', 'speech']),
  setting: z.enum(['op', 'ip', 'icu', 'tele', 'home']).default('op'),
  referralId: uuid.optional(),
  source: z.enum(['opd', 'ip', 'icu', 'er', 'self', 'external']).default('opd'),
  referringDoctorId: uuid.optional(),
  diagnosisIcd10: z.string().max(16).optional(),
  precautions: z.record(z.string(), z.unknown()).default({}),
  /**
   * How many sessions the referral, package or payer authorised. Absent means
   * open-ended, which is a decision rather than an oversight — the database
   * counts against it only when it is set.
   */
  sessionsAuthorised: z.number().int().min(1).max(500).optional(),
  leadTherapistId: uuid.optional(),
  slaDueAt: z.string().datetime().optional(),
});
export type EpisodeRequest = z.infer<typeof episodeSchema>;

export const assessmentSchema = z.object({
  patientId: uuid,
  kind: z.enum(['initial', 'reassessment', 'discharge']),
  encounterId: uuid.optional(),
  admissionId: uuid.optional(),
  findings: z.record(z.string(), z.unknown()).default({}),
  scores: z.record(z.string(), z.unknown()).default({}),
  impression: z.string().max(4000).optional(),
  formResponseId: uuid.optional(),
});
export type AssessmentRequest = z.infer<typeof assessmentSchema>;

/**
 * A goal, with the three fields that make it reportable.
 *
 * `metric`, `baseline` and `target` are required here and NOT NULL in the
 * database. "Improve mobility" is a sentiment; a department's outcome report
 * over sentiments is empty.
 */
export const goalSchema = z.object({
  description: z.string().min(4).max(400),
  metric: z.string().min(1).max(80),
  baseline: z.string().min(1).max(80),
  target: z.string().min(1).max(80),
  code: z.string().max(24).optional(),
  targetDate: z.string().date().optional(),
});
export type GoalRequest = z.infer<typeof goalSchema>;

export const resolveGoalSchema = z.object({
  status: z.enum(['met', 'partially_met', 'not_met', 'revised', 'discontinued']),
  outcomeNote: z.string().min(4).max(2000),
});
export type ResolveGoalRequest = z.infer<typeof resolveGoalSchema>;

export const planSchema = z.object({
  assessmentId: uuid,
  items: z.array(z.record(z.string(), z.unknown())).max(80).default([]),
  frequencyPerWeek: z.number().int().min(1).max(14).optional(),
  sessionsPlanned: z.number().int().min(1).max(500).optional(),
  homeProgramme: z.record(z.string(), z.unknown()).default({}),
});
export type PlanRequest = z.infer<typeof planSchema>;

export const sessionSchema = z.object({
  planId: uuid,
  setting: z.enum(['op', 'ip', 'icu', 'tele', 'home']).default('op'),
  scheduledAt: z.string().datetime(),
  durationMin: z.number().int().min(1).max(480).optional(),
  workDone: z.array(z.record(z.string(), z.unknown())).max(60).default([]),
  response: z.string().max(4000).optional(),
  homework: z.string().max(4000).optional(),
  painPre: z.number().int().min(0).max(10).optional(),
  painPost: z.number().int().min(0).max(10).optional(),
  caregiverPresent: z.boolean().default(false),
  chargeIntentId: uuid.optional(),
  units: z.number().min(0).max(99).optional(),
});
export type SessionRequest = z.infer<typeof sessionSchema>;

export const attendSchema = z.object({
  durationMin: z.number().int().min(1).max(480),
  workDone: z.array(z.record(z.string(), z.unknown())).max(60).default([]),
  response: z.string().max(4000).optional(),
  homework: z.string().max(4000).optional(),
  painPre: z.number().int().min(0).max(10).optional(),
  painPost: z.number().int().min(0).max(10).optional(),
  caregiverPresent: z.boolean().default(false),
  chargeIntentId: uuid.optional(),
});
export type AttendRequest = z.infer<typeof attendSchema>;

export const extendAuthorisationSchema = z.object({
  sessionsAuthorised: z.number().int().min(1).max(500),
  reason: z.string().trim().min(8).max(2000),
});
export type ExtendAuthorisationRequest = z.infer<typeof extendAuthorisationSchema>;

export const dischargeSchema = z.object({
  outcome: z.enum([
    'goals_met',
    'goals_partly_met',
    'plateaued',
    'transferred',
    'declined_further',
    'lost_to_followup',
    'died',
  ]),
});
export type DischargeRequest = z.infer<typeof dischargeSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// OP-017 · Wound care
// ═══════════════════════════════════════════════════════════════════════════

export const woundSchema = z.object({
  patientId: uuid,
  episodeId: uuid.optional(),
  locationText: z.string().min(2).max(160),
  locationSnomed: z.string().max(40).optional(),
  side: z.enum(['left', 'right', 'bilateral', 'not_applicable']).default('not_applicable'),
  aetiology: z.enum([
    'pressure',
    'diabetic_foot',
    'venous',
    'arterial',
    'mixed_ulcer',
    'traumatic',
    'surgical',
    'ssi',
    'burn',
    'malignant',
    'other',
  ]),
  onsetDate: z.string().date().optional(),
  cause: z.string().max(240).optional(),
  classification: z.record(z.string(), z.unknown()).default({}),
  hospitalAcquired: z.boolean().default(false),
  incidentId: uuid.optional(),
});
export type WoundRequest = z.infer<typeof woundSchema>;

/**
 * A wound measurement.
 *
 * Length and width in centimetres; the area, the reduction against baseline and
 * the trajectory are computed from them by a trigger. There is no field for any
 * of the three — the whole referral logic of a wound clinic is a threshold on
 * the second one, and a percentage somebody typed agrees with whatever the
 * clinic hoped.
 */
export const woundAssessmentSchema = z.object({
  assessedAt: z.string().datetime().optional(),
  context: z.enum(['opd', 'ward', 'icu', 'home', 'tele']).default('opd'),
  lengthCm: z.number().min(0).max(200).optional(),
  widthCm: z.number().min(0).max(200).optional(),
  depthCm: z.number().min(0).max(50).optional(),
  undermining: z.record(z.string(), z.unknown()).default({}),
  tunnelling: z.record(z.string(), z.unknown()).default({}),
  /** Shares of one wound bed. The database requires them to total 100. */
  tissuePct: z.record(z.string(), z.number().min(0).max(100)).default({}),
  exudate: z.record(z.string(), z.unknown()).default({}),
  infectionSigns: z.record(z.string(), z.unknown()).default({}),
  periwound: z.record(z.string(), z.unknown()).default({}),
  painNrs: z.number().int().min(0).max(10).optional(),
  odour: z.boolean().default(false),
  probeToBone: z.boolean().default(false),
  exposedStructures: z.array(z.string().max(40)).max(10).default([]),
  scores: z.record(z.string(), z.unknown()).default({}),
  cultureOrderId: uuid.optional(),
  notes: z.string().max(4000).optional(),
});
export type WoundAssessmentRequest = z.infer<typeof woundAssessmentSchema>;

export const woundPhotoSchema = z.object({
  s3Key: z.string().min(1).max(500),
  thumbKey: z.string().max(500).optional(),
  assessmentId: uuid.optional(),
  device: z.string().max(80).optional(),
  stage: z.enum(['pre_debridement', 'post_debridement', 'routine', 'home_upload']).default('routine'),
  /** Whether a ruler is in the frame. Only one kind can be the source of a size. */
  hasScaleMarker: z.boolean(),
  calibration: z.record(z.string(), z.unknown()).default({}),
  consentId: uuid.optional(),
});
export type WoundPhotoRequest = z.infer<typeof woundPhotoSchema>;

export const dressingSchema = z.object({
  sessionId: uuid.optional(),
  location: z.enum(['dressing_room', 'ward', 'home', 'procedure_room']).default('dressing_room'),
  consumables: z.array(z.record(z.string(), z.unknown())).max(40).default([]),
  consumptionId: uuid.optional(),
  npwtCanisterChanged: z.boolean().default(false),
  painPre: z.number().int().min(0).max(10).optional(),
  painPost: z.number().int().min(0).max(10).optional(),
  notes: z.string().max(2000).optional(),
  nextDueAt: z.string().datetime().optional(),
  chargeIntentId: uuid.optional(),
});
export type DressingRequest = z.infer<typeof dressingSchema>;

export const closeWoundSchema = z.object({
  /** `healed` needs a closing measurement; every other close does not. */
  status: z.enum(['healed', 'amputated', 'deceased', 'lost_to_followup']),
});
export type CloseWoundRequest = z.infer<typeof closeWoundSchema>;

export const overrideWoundSchema = z.object({
  reason: z.string().trim().min(8).max(2000),
});
export type OverrideWoundRequest = z.infer<typeof overrideWoundSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// OP-011 · Dietetics
// ═══════════════════════════════════════════════════════════════════════════

export const nutritionAssessmentSchema = z.object({
  patientId: uuid,
  episodeId: uuid.optional(),
  encounterId: uuid.optional(),
  admissionId: uuid.optional(),
  anthropometry: z.record(z.string(), z.unknown()).default({}),
  bmi: z.number().min(5).max(100).optional(),
  weightLossPct3m: z.number().min(0).max(100).optional(),
  bmr: z.number().int().min(200).max(6000).optional(),
  tdee: z.number().int().min(200).max(9000).optional(),
  requirements: z.record(z.string(), z.unknown()).default({}),
  recall24h: z.record(z.string(), z.unknown()).default({}),
  intakeTotals: z.record(z.string(), z.unknown()).default({}),
  malnutritionClass: z.enum(['none', 'moderate', 'severe']).default('none'),
  sga: z.enum(['A', 'B', 'C']).optional(),
  nrs2002: z.number().int().min(0).max(7).optional(),
  pesStatement: z.string().max(2000).optional(),
  preferences: z.record(z.string(), z.unknown()).default({}),
  foodAllergies: z.array(z.string().max(60)).max(30).default([]),
  formResponseId: uuid.optional(),
});
export type NutritionAssessmentRequest = z.infer<typeof nutritionAssessmentSchema>;

/**
 * A diet plan.
 *
 * `meals` is the single source of what the patient eats; there is no `totals`
 * field, because the energy, macros and minerals are summed from the meals by a
 * trigger. A plan whose header says 1,800 kcal while its meals add to 2,400 is
 * the ordinary state of a plan edited six times in a consultation, and this is
 * the only thing that catches it.
 */
export const dietPlanSchema = z.object({
  patientId: uuid,
  assessmentId: uuid,
  name: z.string().min(2).max(160),
  meals: z
    .array(
      z.object({
        meal: z.string().min(1).max(40),
        items: z
          .array(
            z.object({ foodId: uuid, qty: z.number().min(0).max(5000), unit: z.string().max(24).optional() }),
          )
          .max(40),
      }),
    )
    .max(12)
    .default([]),
  kcalTarget: z.number().int().min(200).max(9000).optional(),
  macroTargets: z.record(z.string(), z.unknown()).default({}),
  /**
   * `{naMg, kMg, po4Mg, kcalMax, proteinMaxG, fluidMl}`. The database refuses a
   * plan whose meals exceed its own restriction, and names the nutrient.
   */
  restrictions: z.record(z.string(), z.number().min(0)).default({}),
  supplements: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  instructions: z.string().max(4000).optional(),
  costPerDay: z.number().min(0).max(100000).optional(),
  validFrom: z.string().date(),
  validTo: z.string().date().optional(),
});
export type DietPlanRequest = z.infer<typeof dietPlanSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// OP-035 · Speech and swallow
// ═══════════════════════════════════════════════════════════════════════════

export const slpAssessmentSchema = z.object({
  patientId: uuid,
  episodeId: uuid,
  encounterId: uuid.optional(),
  domains: z
    .array(
      z.enum([
        'swallow',
        'articulation',
        'language',
        'voice',
        'fluency',
        'motor_speech',
        'cognitive_communication',
        'aac',
      ]),
    )
    .min(1)
    .max(8),
  kind: z.string().min(2).max(24),
  tools: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
  swallow: z.record(z.string(), z.unknown()).default({}),
  voice: z.record(z.string(), z.unknown()).default({}),
  fluency: z.record(z.string(), z.unknown()).default({}),
  language: z.record(z.string(), z.unknown()).default({}),
  articulation: z.record(z.string(), z.unknown()).default({}),
  severity: z.string().max(24).optional(),
  dxCodes: z.array(z.string().max(24)).max(20).default([]),
  reportDocId: uuid.optional(),
  formResponseId: uuid.optional(),
});
export type SlpAssessmentRequest = z.infer<typeof slpAssessmentSchema>;

/**
 * An IDDSI swallow order.
 *
 * Both levels or neither, enforced here and in the database. The framework
 * numbers foods 3–7 and drinks 0–4 and the numbers overlap without meaning the
 * same thing, so a half-specified order is a kitchen guessing.
 *
 * There is no acknowledgement field. That is a different route held by
 * different people.
 */
export const swallowOrderSchema = z
  .object({
    patientId: uuid,
    episodeId: uuid,
    assessmentId: uuid,
    admissionId: uuid.optional(),
    npo: z.boolean().default(false),
    foodLevel: z.number().int().min(3).max(7).optional(),
    fluidLevel: z.number().int().min(0).max(4).optional(),
    strategies: z.record(z.string(), z.unknown()).default({}),
    /** Required when this replaces a live order. */
    supersedesId: uuid.optional(),
    changeReason: z.string().max(2000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.npo && (v.foodLevel !== undefined || v.fluidLevel !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['npo'],
        message: 'Nil by mouth carries no IDDSI levels. One of the two is wrong.',
      });
    }
    if (!v.npo && (v.foodLevel === undefined || v.fluidLevel === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['foodLevel'],
        message:
          'An IDDSI order names a food level (3–7) and a fluid level (0–4). The numbers overlap without meaning the same thing, so a kitchen cannot infer the missing one.',
      });
    }
    if (v.supersedesId !== undefined && (v.changeReason === undefined || v.changeReason.trim().length < 4)) {
      ctx.addIssue({
        code: 'custom',
        path: ['changeReason'],
        message:
          'Replacing a live swallow order records why. A downgrade nobody can explain is one the ward will ignore.',
      });
    }
  });
export type SwallowOrderRequest = z.infer<typeof swallowOrderSchema>;

/**
 * Acknowledging as the kitchen or as the ward.
 *
 * `party` says which, and the actor comes from the session. There is no field
 * for who acknowledged: a kitchen supervisor recording that a ward has read the
 * order is the failure this whole mechanism exists to prevent.
 */
export const acknowledgeSchema = z.object({
  party: z.enum(['kitchen', 'ward']),
});
export type AcknowledgeRequest = z.infer<typeof acknowledgeSchema>;

// ═══════════════════════════════════════════════════════════════════════════
// Queries
// ═══════════════════════════════════════════════════════════════════════════

export const episodeQuerySchema = z.object({
  patientId: uuid.optional(),
  discipline: z.enum(['physio', 'wound', 'nutrition', 'speech']).optional(),
  openOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type EpisodeQuery = z.infer<typeof episodeQuerySchema>;

export const woundQuerySchema = z.object({
  patientId: uuid.optional(),
  openOnly: queryFlag().default(false),
  /** Only wounds the trajectory calls stalled or deteriorating. */
  needsReview: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type WoundQuery = z.infer<typeof woundQuerySchema>;

export const patientQuerySchema = z.object({
  patientId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type PatientQuery = z.infer<typeof patientQuerySchema>;

export const swallowQuerySchema = z.object({
  patientId: uuid.optional(),
  /** Orders written and not yet acknowledged by both. The kitchen's worklist. */
  awaitingAckOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SwallowQuery = z.infer<typeof swallowQuerySchema>;
