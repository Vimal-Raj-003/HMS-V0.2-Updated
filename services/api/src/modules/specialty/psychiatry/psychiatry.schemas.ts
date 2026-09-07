import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request shapes for OP-032.
 *
 * ── There is no `hasCapacity` field ─────────────────────────────────────────
 *
 * Capacity is the four limbs the Act names — understand, retain, weigh,
 * communicate — and the verdict follows from them. A clinician who could type
 * the verdict has decided before applying the test, which is exactly what the
 * Act was written to stop being sufficient.
 *
 * ── And no `authorityExpiresAt` ─────────────────────────────────────────────
 *
 * Seventy-two hours, thirty days or ninety, from the section. A date somebody
 * types is a date somebody can extend, and holding a person past their
 * authority is unlawful detention rather than a late task.
 *
 * ── And no way to record unmodified electroconvulsive therapy ───────────────
 *
 * The anaesthetic agent and the muscle relaxant are both required on every
 * session. There is no flag, no omission path and no override: §95 prohibits
 * unmodified ECT outright, and the strongest thing this build can say is that
 * nothing here can express it.
 */

const uuid = z.string().uuid();

export const episodeSchema = z.object({
  patientId: uuid,
  openedAt: z.string().optional(),
  primaryDxIcd10: z.string().max(16).optional(),
  dxHistory: z.array(z.record(z.string(), z.unknown())).max(30).default([]),
  riskLevel: z.enum(['low', 'moderate', 'high']).default('low'),
  leadClinicianId: uuid,
  careTeam: z.array(uuid).max(20).default([]),
  /** High by default: these records are excluded from outbound sharing. */
  sensitivity: z.enum(['standard', 'high']).default('high'),
});
export type EpisodeRequest = z.infer<typeof episodeSchema>;

export const scaleSchema = z.object({
  patientId: uuid,
  episodeId: uuid.optional(),
  scale: z.enum([
    'phq9',
    'gad7',
    'mmse',
    'moca',
    'hamd',
    'hama',
    'ymrs',
    'panss',
    'madrs',
    'ybocs',
    'pcl5',
    'audit',
    'cssrs',
    'ciwa',
    'cows',
    'epds',
    'other',
  ]),
  /** Item number to score. The total and the band come out of these. */
  items: z.record(z.string(), z.number()),
  completedBy: z.enum(['patient', 'clinician', 'caregiver']).default('patient'),
  recordedAt: z.string().optional(),
});
export type ScaleRequest = z.infer<typeof scaleSchema>;

/**
 * The four limbs. All four are required, and the verdict is not among them.
 */
export const capacitySchema = z.object({
  episodeId: uuid,
  patientId: uuid,
  understands: z.boolean(),
  retains: z.boolean(),
  weighs: z.boolean(),
  communicates: z.boolean(),
  /** Capacity is decision-specific. Name the decision. */
  decisionScope: z.string().min(4).max(120),
  rationale: z.string().min(8).max(4000),
});
export type CapacityRequest = z.infer<typeof capacitySchema>;

export const instrumentSchema = z.object({
  patientId: uuid,
  kind: z.enum(['advance_directive', 'nominated_representative']),
  content: z.record(z.string(), z.unknown()),
  madeAt: z.string(),
  validFrom: z.string().date(),
  witnessedBy: z.array(z.record(z.string(), z.unknown())).max(4).default([]),
  documentId: uuid.optional(),
  reason: z.string().min(8).max(2000),
});
export type InstrumentRequest = z.infer<typeof instrumentSchema>;

/**
 * Revoking. Only the Review Board can set an instrument aside; a hospital
 * records either the person's own revocation or the Board's reference.
 */
export const revokeSchema = z
  .object({
    reason: z.string().min(8).max(2000),
    mhrbRef: z.string().max(80).optional(),
  })
  .refine((v) => v.reason.trim().length >= 8 || v.mhrbRef !== undefined, {
    message: 'A revocation names either the person’s own decision or the Board’s reference.',
  });
export type RevokeRequest = z.infer<typeof revokeSchema>;

export const admissionSchema = z.object({
  episodeId: uuid,
  patientId: uuid,
  admissionId: uuid.optional(),
  admissionType: z.enum(['independent_86', 'supported_89', 'supported_90', 'minor_87', 'emergency_94']),
  admittedAt: z.string().optional(),
  /** A supported admission rests on one, and an expired one is not one. */
  capacityAssessmentId: uuid.optional(),
  nrInstrumentId: uuid.optional(),
  /** §90 is the Board's authority, not the hospital's. */
  mhrbRef: z.string().max(80).optional(),
  reason: z.string().min(8).max(2000),
});
export type AdmissionRequest = z.infer<typeof admissionSchema>;

export const intimationSchema = z.object({
  mhrbRef: z.string().min(1).max(80),
});
export type IntimationRequest = z.infer<typeof intimationSchema>;

export const dischargeSchema = z.object({
  outcome: z.string().min(2).max(40),
});
export type DischargeRequest = z.infer<typeof dischargeSchema>;

/** Ordering. §97 permits one ground, and the reason has to name the harm. */
export const restraintSchema = z.object({
  admissionId: uuid,
  kind: z.enum(['physical', 'chemical', 'seclusion']),
  startedAt: z.string().optional(),
  reason: z.string().min(12).max(2000),
});
export type RestraintRequest = z.infer<typeof restraintSchema>;

export const observationSchema = z.object({
  state: z.string().min(1).max(200),
  at: z.string().optional(),
});
export type ObservationRequest = z.infer<typeof observationSchema>;

export const restraintCloseSchema = z.object({
  nrInformedAt: z.string().optional(),
});
export type RestraintCloseRequest = z.infer<typeof restraintCloseSchema>;

export const ectCourseSchema = z.object({
  episodeId: uuid,
  patientId: uuid,
  indication: z.string().min(8).max(2000),
  consentId: uuid.optional(),
  nrConsentId: uuid.optional(),
  capacityAssessmentId: uuid.optional(),
  minor: z.boolean().default(false),
  /** Required before the first session on a minor. §95 permits no other route. */
  mhrbPermissionRef: z.string().max(80).optional(),
  maxSessions: z.number().int().min(1).max(30).default(12),
  reason: z.string().min(8).max(2000),
});
export type EctCourseRequest = z.infer<typeof ectCourseSchema>;

/**
 * A session. Both halves of "modified" are required and neither is optional:
 * unmodified electroconvulsive therapy is prohibited outright.
 */
export const ectSessionSchema = z.object({
  placement: z.enum(['bitemporal', 'bifrontal', 'right_unilateral']),
  anaesthesia: z.object({
    agent: z.string().min(1).max(120),
    relaxant: z.string().min(1).max(120),
    anaesthetistId: uuid.optional(),
  }),
  chargeMc: z.number().min(0).max(2000).optional(),
  seizureSec: z.number().int().min(0).max(600).optional(),
  complications: z.array(z.record(z.string(), z.unknown())).max(10).default([]),
  aldrete: z.number().int().min(0).max(10).optional(),
  cognitionPre: z.record(z.string(), z.unknown()).optional(),
  cognitionPost: z.record(z.string(), z.unknown()).optional(),
});
export type EctSessionRequest = z.infer<typeof ectSessionSchema>;

export const episodeQuerySchema = z.object({
  patientId: uuid.optional(),
  activeOnly: queryFlag().default(false),
  highRiskOnly: queryFlag().default(false),
  authorityExpiringOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type EpisodeQuery = z.infer<typeof episodeQuerySchema>;

export const restraintQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/u)
    .optional(),
  openOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(300).default(200),
});
export type RestraintQuery = z.infer<typeof restraintQuerySchema>;
