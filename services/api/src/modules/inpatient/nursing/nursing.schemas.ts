import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Phase 7B request schemas.
 *
 * ── `administer` has no `state` field ───────────────────────────────────────
 *
 * It takes the two scans and, for a high-alert drug, the witness. There is no
 * way to express "mark this given without scanning" in the shape, and no flag
 * anywhere that turns the requirement off. `phase-07` puts it plainly: no
 * feature flag, no configuration value and no emergency mode may bypass the
 * 5 Rights scan. A field that could be set to `given` directly would be exactly
 * such a bypass, so there is not one.
 */

const uuid = z.string().uuid();

export const riskScaleSchema = z.enum([
  'morse_falls',
  'braden_pressure',
  'pain',
  'restraint',
  'nutrition',
  'dvt',
]);

export const assignmentSchema = z.object({
  wardId: uuid,
  nurseId: uuid,
  shift: z.enum(['morning', 'evening', 'night']),
  shiftDate: z.string().date(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  role: z.enum(['bedside', 'in_charge', 'float', 'medication']).default('bedside'),
  admissionIds: z.array(uuid).max(30).default([]),
});
export type AssignmentRequest = z.infer<typeof assignmentSchema>;

export const assessmentSchema = z.object({
  admissionId: uuid,
  scale: riskScaleSchema,
  /** The individual answers. The score is computed from them, never sent. */
  items: z.record(z.string(), z.number().int().min(0).max(60)),
  reassessInHours: z.number().int().min(1).max(720).optional(),
  interventions: z.array(z.string().trim().min(1).max(160)).max(20).default([]),
  notes: z.string().trim().max(2000).optional(),
});
export type AssessmentRequest = z.infer<typeof assessmentSchema>;

export const marOrderSchema = z.object({
  admissionId: uuid,
  patientId: uuid,
  drugId: uuid.optional(),
  drugName: z.string().trim().min(1).max(200),
  drugBarcode: z.string().trim().max(120).optional(),
  dose: z.string().trim().min(1).max(80),
  doseUnit: z.string().trim().min(1).max(20),
  route: z.string().trim().min(1).max(40),
  frequency: z.string().trim().min(1).max(40),
  isHighAlert: z.boolean().default(false),
  isNarcotic: z.boolean().default(false),
  isPrn: z.boolean().default(false),
  prnIndication: z.string().trim().max(500).optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  endsAt: z.string().datetime({ offset: true }).optional(),
  /** Times of day to schedule, e.g. `["08:00","14:00","22:00"]`. */
  times: z
    .array(z.string().regex(/^\d{2}:\d{2}$/u))
    .max(12)
    .default([]),
  days: z.number().int().min(1).max(30).default(3),
});
export type MarOrderRequest = z.infer<typeof marOrderSchema>;

export const verifySchema = z.object({ note: z.string().trim().max(1000).optional() });
export type VerifyRequest = z.infer<typeof verifySchema>;

/**
 * Giving a dose.
 *
 * Both scans are required by the schema and compared by the service against the
 * wristband and the drug barcode. A mismatch is refused *and recorded* — a near
 * miss nobody counts is a near miss that becomes an error.
 */
export const administerSchema = z.object({
  /** What the scanner read off the wristband. */
  patientScan: z.string().trim().min(1).max(200),
  /** What the scanner read off the drug. */
  drugScan: z.string().trim().min(1).max(200),
  /** The second nurse, required for a high-alert drug and refused if it is you. */
  witnessedBy: uuid.optional(),
  givenDose: z.string().trim().max(80).optional(),
  site: z.string().trim().max(80).optional(),
  /** Required for a when-required drug. */
  prnIndication: z.string().trim().max(500).optional(),
  at: z.string().datetime({ offset: true }).optional(),
});
export type AdministerRequest = z.infer<typeof administerSchema>;

export const MAR_REASON_CODES = [
  'patient_asleep',
  'patient_refused',
  'patient_absent',
  'patient_nbm',
  'drug_unavailable',
  'iv_access_lost',
  'held_for_procedure',
  'held_for_level',
  'held_clinical',
  'vomited',
  'allergy_suspected',
  'duplicate',
  'order_changed',
  'not_required',
  'other',
] as const;

export const omitSchema = z.object({
  state: z.enum(['missed', 'refused', 'held', 'not_required']),
  reasonCode: z.enum(MAR_REASON_CODES),
  note: z.string().trim().max(1000).optional(),
});
export type OmitRequest = z.infer<typeof omitSchema>;

export const escalationAckSchema = z.object({ note: z.string().trim().max(1000).optional() });
export type EscalationAckRequest = z.infer<typeof escalationAckSchema>;

export const escalationResolveSchema = z.object({
  outcome: z.string().trim().min(4).max(2000),
});
export type EscalationResolveRequest = z.infer<typeof escalationResolveSchema>;

export const fluidSchema = z.object({
  admissionId: uuid,
  direction: z.enum(['intake', 'output']),
  kind: z.enum(['oral', 'iv', 'ng', 'urine', 'drain', 'vomit', 'stool', 'blood', 'other']),
  volumeMl: z.number().int().min(1).max(20_000),
  at: z.string().datetime({ offset: true }).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type FluidRequest = z.infer<typeof fluidSchema>;

export const noteSchema = z.object({
  admissionId: uuid,
  kind: z.enum(['sbar', 'progress', 'wound', 'drain', 'incident']).default('progress'),
  situation: z.string().trim().max(2000).optional(),
  background: z.string().trim().max(2000).optional(),
  assessment: z.string().trim().max(2000).optional(),
  recommendation: z.string().trim().max(2000).optional(),
  body: z.string().trim().max(8000).optional(),
  photoRef: z.string().trim().max(200).optional(),
});
export type NoteRequest = z.infer<typeof noteSchema>;

export const handoverSchema = z.object({
  wardId: uuid,
  fromShift: z.enum(['morning', 'evening', 'night']),
  toShift: z.enum(['morning', 'evening', 'night']),
  additions: z.string().trim().max(4000).optional(),
});
export type HandoverRequest = z.infer<typeof handoverSchema>;

export const handoverSignSchema = z.object({
  side: z.enum(['give', 'receive']),
});
export type HandoverSignRequest = z.infer<typeof handoverSignSchema>;

export const deviceSchema = z.object({
  admissionId: uuid,
  deviceType: z.enum(['central_line', 'urinary_catheter', 'ventilator', 'peripheral_line', 'drain']),
  site: z.string().trim().max(80).optional(),
  insertedAt: z.string().datetime({ offset: true }).optional(),
});
export type DeviceRequest = z.infer<typeof deviceSchema>;

export const deviceRemoveSchema = z.object({
  removalReason: z.enum(['no_longer_needed', 'infection', 'blocked', 'dislodged', 'died', 'other']),
  at: z.string().datetime({ offset: true }).optional(),
});
export type DeviceRemoveRequest = z.infer<typeof deviceRemoveSchema>;

export const isolationSchema = z.object({
  admissionId: uuid,
  precaution: z.enum(['contact', 'droplet', 'airborne', 'protective', 'enteric']),
  organism: z.string().trim().max(120).optional(),
  indication: z.string().trim().min(4).max(1000),
});
export type IsolationRequest = z.infer<typeof isolationSchema>;

export const haiAdjudicateSchema = z.object({
  adjudication: z.enum(['confirmed', 'rejected', 'withdrawn']),
  rationale: z.string().trim().min(4).max(2000),
});
export type HaiAdjudicateRequest = z.infer<typeof haiAdjudicateSchema>;

export const wardQuerySchema = z.object({
  wardId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type WardQuery = z.infer<typeof wardQuerySchema>;

export const marQuerySchema = z.object({
  admissionId: uuid.optional(),
  wardId: uuid.optional(),
  dueOnly: queryFlag().default(false),
  overdueOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type MarQuery = z.infer<typeof marQuerySchema>;

export const escalationQuerySchema = z.object({
  wardId: uuid.optional(),
  openOnly: queryFlag().default(true),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type EscalationQuery = z.infer<typeof escalationQuerySchema>;
