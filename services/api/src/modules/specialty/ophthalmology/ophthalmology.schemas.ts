import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * OP-025 request schemas.
 *
 * ── An eye, never "both", on anything measured ──────────────────────────────
 *
 * `bilateral` is absent from every measurement schema and present on the
 * diagnosis one. Two eyes that measure the same are two measurements that
 * agree, and the day they stop agreeing a single row has nowhere to put the
 * difference. The database refuses it too; the schema means the screen never
 * offers it.
 *
 * ── No `logmar` field ───────────────────────────────────────────────────────
 *
 * The trigger derives it. A caller that could supply it could put a point on
 * a trend that disagrees with the note beside it.
 */

const uuid = z.string().uuid();
/** One eye. Not both, not neither. */
const measuredEye = z.enum(['left', 'right']);

export const openVisitSchema = z.object({
  patientId: uuid,
  encounterId: uuid,
  chiefComplaintCodes: z.array(z.string().trim().min(1).max(12)).max(10).default([]),
});
export type OpenVisitRequest = z.infer<typeof openVisitSchema>;

export const acuitySchema = z.object({
  eye: measuredEye,
  context: z.enum(['ucva', 'bcva', 'pinhole', 'with_glasses', 'near', 'post_op']),
  notation: z.enum([
    'snellen_6',
    'snellen_20',
    'logmar',
    'etdrs',
    'n_notation',
    'cf',
    'hm',
    'pl',
    'pl_proj',
    'nlp',
    'csm',
  ]),
  /** As written: `6/18`, `20/60`, `N6`, `CF 2m`. */
  value: z.string().trim().min(1).max(24),
  distanceM: z.number().min(0.1).max(20).optional(),
});
export type AcuityRequest = z.infer<typeof acuitySchema>;

export const acuityBatchSchema = z.object({
  readings: z.array(acuitySchema).min(1).max(24),
});
export type AcuityBatchRequest = z.infer<typeof acuityBatchSchema>;

/** A quarter-dioptre step. The lab grinds nothing finer. */
const quarterStep = z
  .number()
  .refine((v) => Number.isInteger(Math.round(v * 4)) && Math.abs(v * 4 - Math.round(v * 4)) < 1e-9, {
    message: 'Powers come in quarter-dioptre steps.',
  });

export const refractionSchema = z.object({
  eye: measuredEye,
  kind: z.enum([
    'auto',
    'retinoscopy',
    'subjective',
    'cycloplegic',
    'old_glasses',
    'final_rx',
    'contact_lens',
  ]),
  sph: quarterStep.min(-30).max(30).optional(),
  cyl: quarterStep.min(-12).max(12).optional(),
  /** 1–180. Zero is written as 180 — the same meridian, spelled once. */
  axis: z.number().int().min(1).max(180).optional(),
  add: quarterStep.min(0).max(6).optional(),
  prism: z.number().min(0).max(20).optional(),
  base: z.enum(['up', 'down', 'in', 'out']).optional(),
  vaAchieved: z.string().trim().max(24).optional(),
  pdMono: z.number().min(15).max(45).optional(),
  pdBino: z.number().min(30).max(90).optional(),
  vertexMm: z.number().min(0).max(30).optional(),
  k1: z.number().min(30).max(60).optional(),
  k1Axis: z.number().int().min(1).max(180).optional(),
  k2: z.number().min(30).max(60).optional(),
  k2Axis: z.number().int().min(1).max(180).optional(),
  /** `device` when the autorefractor pushed it, `manual` when somebody typed it. */
  source: z.enum(['device', 'manual']).default('manual'),
});
export type RefractionRequest = z.infer<typeof refractionSchema>;

export const refractionBatchSchema = z.object({
  refractions: z.array(refractionSchema).min(1).max(12),
});
export type RefractionBatchRequest = z.infer<typeof refractionBatchSchema>;

export const iopSchema = z.object({
  eye: measuredEye,
  method: z.enum(['nct', 'goldmann', 'icare', 'tonopen', 'schiotz']),
  valueMmhg: z.number().min(0).max(80),
  cctUm: z.number().int().min(300).max(800).optional(),
  postDilation: z.boolean().default(false),
});
export type IopRequest = z.infer<typeof iopSchema>;

export const iopBatchSchema = z.object({
  readings: z.array(iopSchema).min(1).max(12),
});
export type IopBatchRequest = z.infer<typeof iopBatchSchema>;

export const examSchema = z.object({
  segment: z.enum(['anterior', 'posterior', 'adnexa', 'motility']),
  eye: measuredEye,
  findings: z.record(z.string(), z.unknown()).default({}),
  drGrade: z.enum(['none', 'mild_npdr', 'moderate_npdr', 'severe_npdr', 'pdr']).optional(),
  dme: z.boolean().optional(),
  cdrVertical: z.number().min(0).max(1).optional(),
  drawingKey: z.string().trim().max(200).optional(),
});
export type ExamRequest = z.infer<typeof examSchema>;

export const diagnosisSchema = z.object({
  /** A diagnosis may be of both eyes; a measurement may not. */
  eye: z.enum(['left', 'right', 'bilateral']),
  icd10: z.string().trim().min(2).max(12),
  snomed: z.string().trim().max(24).optional(),
  isPrimary: z.boolean().default(false),
  note: z.string().trim().max(2000).optional(),
});
export type DiagnosisRequest = z.infer<typeof diagnosisSchema>;

export const diagnosisBatchSchema = z.object({
  diagnoses: z.array(diagnosisSchema).min(1).max(12),
});
export type DiagnosisBatchRequest = z.infer<typeof diagnosisBatchSchema>;

export const dilateSchema = z.object({
  drug: z.string().trim().min(2).max(120),
  cycloplegic: z.boolean().default(false),
});
export type DilateRequest = z.infer<typeof dilateSchema>;

const rxLineSchema = z.object({
  sph: quarterStep.min(-30).max(30).optional(),
  cyl: quarterStep.min(-12).max(12).optional(),
  axis: z.number().int().min(1).max(180).optional(),
  add: quarterStep.min(0).max(6).optional(),
  prism: z.number().min(0).max(20).optional(),
  base: z.enum(['up', 'down', 'in', 'out']).optional(),
});

export const spectacleRxSchema = z.object({
  kind: z.enum(['spectacle', 'contact_lens']).default('spectacle'),
  right: z.object({ distance: rxLineSchema.optional(), near: rxLineSchema.optional() }).optional(),
  left: z.object({ distance: rxLineSchema.optional(), near: rxLineSchema.optional() }).optional(),
  pdMono: z.number().min(15).max(45).optional(),
  pdBino: z.number().min(30).max(90).optional(),
  lensAdvice: z.record(z.string(), z.unknown()).optional(),
  /** Months. Twelve by default; the database refuses anything past five years. */
  validMonths: z.number().int().min(1).max(60).default(12),
});
export type SpectacleRxRequest = z.infer<typeof spectacleRxSchema>;

export const surgeryPlanSchema = z.object({
  procedureCode: z.string().trim().min(2).max(40),
  eye: measuredEye,
  anaesthesia: z.enum(['topical', 'peribulbar', 'retrobulbar', 'subtenon', 'general']),
  iolModel: z.string().trim().max(120).optional(),
  iolPower: z.number().min(-10).max(40).optional(),
  iolFormula: z.enum(['srk_t', 'barrett', 'hoffer_q', 'haigis', 'holladay_2']).optional(),
  targetRefraction: z.number().min(-6).max(3).optional(),
  backupPower: z.number().min(-10).max(40).optional(),
  /** Axial length, keratometry, anterior chamber depth — and when measured. */
  biometry: z
    .object({
      al: z.number().min(15).max(35),
      k1: z.number().min(30).max(60),
      k2: z.number().min(30).max(60),
      acd: z.number().min(1).max(6).optional(),
    })
    .optional(),
  biometryAt: z.string().datetime({ offset: true }).optional(),
  preopChecklist: z.record(z.string(), z.unknown()).optional(),
  npcbviFlag: z.boolean().default(false),
});
export type SurgeryPlanRequest = z.infer<typeof surgeryPlanSchema>;

export const surgeryStatusSchema = z.object({
  status: z.enum(['counselled', 'booked', 'done', 'cancelled']),
  otCaseId: uuid.optional(),
  reason: z.string().trim().min(4).max(2000).optional(),
});
export type SurgeryStatusRequest = z.infer<typeof surgeryStatusSchema>;

export const trendQuerySchema = z.object({
  metric: z.enum(['iop', 'logmar', 'cdr']),
  eye: z.enum(['left', 'right', 'both']).default('both'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type TrendQuery = z.infer<typeof trendQuerySchema>;

export const visitQuerySchema = z.object({
  openOnly: queryFlag().default(true),
  stage: z
    .enum(['registered', 'refraction', 'dilating', 'doctor', 'imaging', 'counselling', 'done'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});
export type VisitQuery = z.infer<typeof visitQuerySchema>;
