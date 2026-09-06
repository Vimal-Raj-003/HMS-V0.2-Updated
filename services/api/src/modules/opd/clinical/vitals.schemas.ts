import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * Request contracts for OP-007 §6's `/vitals` routes.
 *
 * They live here rather than in `packages/contracts` for the same reason
 * `patient.schemas.ts` gives: that package is outside this change's remit. When
 * the vitals station screen is built they should move, unchanged, so the tablet
 * validates against the same object the server does (`docs/09` §4).
 *
 * **Nothing here encodes a clinical threshold.** The bounds below are the
 * *storage* bounds the migration already enforces — a value outside them cannot
 * be persisted at all — and they exist so the nurse gets a field error instead
 * of a 500 from a CHECK. The hospital-configurable plausibility, abnormal and
 * critical bands live in `clinical.vitals_reference_ranges` and are applied by
 * `vitals.ranges.ts`.
 */

const uuid = z.string().uuid();
const cursor = z.string().max(2048).optional();
const limit = z.coerce.number().int().min(1).max(100).default(25);

/** Free text a person will read later: long enough to be a sentence, bounded. */
const reason = z.string().trim().min(8, 'Give a reason somebody reading the record can act on').max(1000);

export const VITALS_CONTEXTS = [
  'opd_vitals_room',
  'er_triage',
  'ward',
  'icu',
  'daycare',
  'ot',
  'home',
  'kiosk',
  'telemed_self',
] as const;

export const BP_POSITIONS = ['sitting', 'standing', 'supine'] as const;
export const PULSE_RHYTHMS = ['regular', 'irregular'] as const;
export const TEMP_SITES = ['oral', 'axillary', 'tympanic', 'temporal', 'rectal', 'skin'] as const;
export const GLUCOSE_TYPES = ['rbs', 'fbs', 'ppbs', 'hba1c_poc'] as const;
export const PAIN_SCALES = ['nrs', 'wong_baker', 'flacc', 'cpot'] as const;
export const AVPU_LEVELS = ['alert', 'confusion', 'voice', 'pain', 'unresponsive'] as const;
export const PREGNANCY_STATUSES = ['unknown', 'no', 'yes', 'possible'] as const;
export const VITALS_SOURCES = ['manual', 'device', 'mixed', 'kiosk'] as const;
export const VITALS_ALERT_ACTIONS = ['repeat', 'doctor_informed', 'sent_to_er', 'none'] as const;

/**
 * Provenance for an auto-filled reading (OP-007 §3.2.2), so "the machine said
 * so" is auditable. The device must be registered and active, and the reading
 * no more than two minutes old — both checked by the service against
 * `clinical.vitals_devices`, because a client is not the authority on either.
 */
const deviceReadingSchema = z.object({
  field: z.string().trim().min(1).max(48),
  deviceId: uuid,
  raw: z.string().trim().min(1).max(200),
  at: z.string().datetime(),
});

/**
 * The nursing pre-consult assessment (OP-007 §4). Saved with the observation
 * set because it is captured in the same 45 seconds and belongs to the same
 * clinical moment.
 */
const assessmentSchema = z.object({
  allergiesVerified: z.boolean().default(false),
  medicationsReconciled: z.boolean().default(false),
  fallRiskScore: z.number().int().min(0).max(100).optional(),
  fallRiskFlag: z.boolean().default(false),
  smoking: z.string().trim().max(24).optional(),
  alcohol: z.string().trim().max(24).optional(),
  chiefComplaintText: z.string().trim().max(4000).optional(),
  remarks: z.string().trim().max(4000).optional(),
  /** OP-007 §3.1.4: forwarded without vitals, and why. */
  notDoneReason: z.string().trim().min(4).max(1000).optional(),
});

/**
 * The measurable fields, shared by `POST /records` and the correction path.
 *
 * Every one is optional: a department policy decides which are mandatory
 * (`clinical.department_vitals_policies.mandatory_fields`), and a nurse who
 * could not take a temperature must be able to save what they did take.
 */
const measurementFields = {
  systolic: z.number().int().min(40).max(300).optional(),
  diastolic: z.number().int().min(10).max(200).optional(),
  bpPosition: z.enum(BP_POSITIONS).optional(),
  bpArm: z.string().trim().max(8).optional(),
  cuffSize: z.string().trim().max(16).optional(),
  pulse: z.number().int().min(20).max(300).optional(),
  pulseRhythm: z.enum(PULSE_RHYTHMS).optional(),
  spo2: z.number().int().min(0).max(100).optional(),
  onOxygen: z.boolean().default(false),
  o2FlowLpm: z.number().min(0).max(100).optional(),
  /** Doctor-set hypercapnic-COPD flag; switches SpO2 to the scale-2 target band. */
  copdScale2: z.boolean().default(false),
  temperatureC: z.number().min(30).max(45).optional(),
  tempSite: z.enum(TEMP_SITES).optional(),
  respRate: z.number().int().min(4).max(80).optional(),
  glucoseMgdl: z.number().min(0).max(2000).optional(),
  glucoseType: z.enum(GLUCOSE_TYPES).optional(),
  heightCm: z.number().min(30).max(250).optional(),
  /**
   * Never zero — the storage CHECK starts at 0.3 kg — and that is the point:
   * "we do not know the weight" and "the weight is zero" must never be the same
   * value. Omit the field when the patient was not weighed.
   */
  weightKg: z.number().min(0.3).max(400).optional(),
  waistCm: z.number().min(20).max(300).optional(),
  headCircCm: z.number().min(10).max(80).optional(),
  painScore: z.number().int().min(0).max(10).optional(),
  painScale: z.enum(PAIN_SCALES).optional(),
  avpu: z.enum(AVPU_LEVELS).optional(),
  gcsTotal: z.number().int().min(3).max(15).optional(),
  lmpDate: z.string().date().optional(),
  pregnancyStatus: z.enum(PREGNANCY_STATUSES).default('unknown'),
  source: z.enum(VITALS_SOURCES).default('manual'),
  deviceReadings: z.array(deviceReadingSchema).max(16).default([]),
  notes: z.string().trim().max(4000).optional(),
};

/**
 * A glucose value without its type cannot be scored: 140 mg/dL is unremarkable
 * after a meal and abnormal fasting, and the reference table has a separate row
 * for each. Refusing the pair is better than silently picking one.
 */
function requireGlucosePairing(
  value: { readonly glucoseMgdl?: number | undefined; readonly glucoseType?: string | undefined },
  ctx: z.RefinementCtx,
): void {
  if (value.glucoseMgdl !== undefined && value.glucoseType === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['glucoseType'],
      message: 'Say which glucose test this is (RBS, FBS, PPBS or point-of-care HbA1c).',
    });
  }
}

export const createVitalsSchema = z
  .object({
    patientId: uuid,
    visitId: uuid.optional(),
    encounterId: uuid.optional(),
    context: z.enum(VITALS_CONTEXTS).default('opd_vitals_room'),
    stationId: uuid.optional(),
    /** The earlier reading this one repeats (OP-007 §3.2.6). */
    repeatOfId: uuid.optional(),
    ...measurementFields,
    assessment: assessmentSchema.optional(),
  })
  .superRefine(requireGlucosePairing);

export type CreateVitalsRequest = z.infer<typeof createVitalsSchema>;

/**
 * OP-007 §5: "corrections versioned; readings never deleted."
 *
 * A correction is therefore a **new observation set** that names the one it
 * replaces, not an edit — which is why this carries the whole measurement
 * block and a mandatory reason rather than a patch.
 */
export const correctVitalsSchema = z
  .object({
    reason,
    ...measurementFields,
    notes: z.string().trim().max(4000).optional(),
  })
  .superRefine(requireGlucosePairing);

export type CorrectVitalsRequest = z.infer<typeof correctVitalsSchema>;

/**
 * `GET /vitals/records` — the trend query.
 *
 * At least one of `patient`, `visit` or a `from` bound is required. Without one
 * the query has no index to stand on and no partition to prune to, and it would
 * scan every month of a table that carries every OPD, ward and ICU observation
 * in the group (OP-007 §13: ~50M rows/year).
 */
export const listVitalsQuerySchema = z
  .object({
    patient: uuid.optional(),
    visit: uuid.optional(),
    encounter: uuid.optional(),
    context: z.enum(VITALS_CONTEXTS).optional(),
    flag: z.enum(['normal', 'abnormal', 'critical']).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor,
    limit,
  })
  .superRefine((value, ctx) => {
    if (value.patient === undefined && value.visit === undefined && value.from === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['patient'],
        message: 'Ask for one patient, one visit, or a time window. An unbounded trend query is refused.',
      });
    }
  });

export type ListVitalsQuery = z.infer<typeof listVitalsQuerySchema>;

/** OP-007 §6 `POST /records/{id}/alerts/{alert}/ack`. */
export const acknowledgeAlertSchema = z.object({
  actionTaken: z.enum(VITALS_ALERT_ACTIONS).default('none'),
  note: z.string().trim().max(2000).optional(),
  /** Whether the patient/relative was told, for the closed-loop record. */
  patientInformed: queryFlag().default(false),
});

export type AcknowledgeAlertRequest = z.infer<typeof acknowledgeAlertSchema>;

/** OP-007 §6 `POST /recheck-requests` — the doctor sends the patient back. */
export const recheckRequestSchema = z.object({
  patientId: uuid,
  visitId: uuid.optional(),
  vitalsId: uuid.optional(),
  parameters: z.array(z.string().trim().min(1).max(48)).min(1).max(24),
  note: z.string().trim().max(1000).optional(),
});

export type RecheckRequest = z.infer<typeof recheckRequestSchema>;

export const referenceRangeQuerySchema = z.object({
  parameter: z.string().trim().min(1).max(48).optional(),
  cursor,
  limit,
});

export type ReferenceRangeQuery = z.infer<typeof referenceRangeQuerySchema>;

export const idSchema = uuid;
