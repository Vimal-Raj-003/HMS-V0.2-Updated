import { lateralitySchema, queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * OP-010 and OP-039 request schemas.
 *
 * ── There is no field that starts a procedure without consent ───────────────
 *
 * Not a flag, not a reason, not an urgency. `phase-08` and OP-010 §5 are
 * explicit that consent has no override, and a request field that could
 * express one would be the bypass — the trigger would still refuse, but the
 * screen would have promised something it cannot do, and somebody would
 * eventually make the trigger match the screen.
 *
 * The checklist override *is* here, because it is a real clinical act. It
 * carries a reason and the caller's identity, which is the whole control.
 */

const uuid = z.string().uuid();

export const roomSchema = z.object({
  code: z.string().trim().min(1).max(24),
  name: z.string().trim().min(1).max(120),
  type: z.enum([
    'minor_ot',
    'procedure_room',
    'injection_room',
    'dressing',
    'plaster',
    'endoscopy',
    'eye_laser',
    'observation_bay',
    'nebulisation',
  ]),
  subStoreId: uuid.optional(),
  openHours: z.record(z.string(), z.unknown()).optional(),
});
export type RoomRequest = z.infer<typeof roomSchema>;

export const orderSchema = z.object({
  patientId: uuid,
  encounterId: uuid,
  visitId: uuid.optional(),
  procedureCode: z.string().trim().min(1).max(40),
  procedureName: z.string().trim().min(1).max(200),
  category: z.enum(['diagnostic', 'therapeutic', 'invasive', 'cosmetic', 'screening']),
  side: lateralitySchema.default('not_applicable'),
  siteText: z.string().trim().max(200).optional(),
  indicationIcd10: z.string().trim().max(12).optional(),
  urgency: z.enum(['routine', 'urgent', 'stat']).default('routine'),
  /** Copied from the master at order time, so a later edit cannot rewrite history. */
  requiresConsent: z.boolean().default(false),
  sedationRequested: z.boolean().default(false),
  /** Which console asked. */
  sourceModule: z.string().trim().max(24).optional(),
});
export type OrderRequest = z.infer<typeof orderSchema>;

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(4).max(2000),
});
export type CancelOrderRequest = z.infer<typeof cancelOrderSchema>;

/** The consent, once it exists. Recording it is not the same as waiving it. */
export const consentSchema = z.object({
  consentId: uuid,
});
export type ConsentRequest = z.infer<typeof consentSchema>;

export const bookingSchema = z.object({
  roomId: uuid,
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  doctorId: uuid.optional(),
  anaesthetistId: uuid.optional(),
});
export type BookingRequest = z.infer<typeof bookingSchema>;

export const checklistSchema = z.object({
  templateKey: z.string().trim().min(1).max(60),
  items: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(60),
        label: z.string().trim().min(1).max(200),
        required: z.boolean().default(true),
        value: z.union([z.boolean(), z.string()]).optional(),
      }),
    )
    .max(60)
    .default([]),
  ready: z.boolean().default(false),
});
export type ChecklistRequest = z.infer<typeof checklistSchema>;

export const overrideSchema = z.object({
  reason: z.string().trim().min(8).max(2000),
});
export type OverrideRequest = z.infer<typeof overrideSchema>;

/**
 * The time-out.
 *
 * Five booleans and a second person. The second person comes from the request
 * because they are standing there; the first is the caller. There is no field
 * that records a "no" — a "no" stops the procedure and is not filed.
 */
export const timeoutSchema = z.object({
  confirmedBy2: uuid,
  patientOk: z.literal(true),
  procedureOk: z.literal(true),
  sideOk: z.literal(true),
  consentOk: z.literal(true),
  allergyOk: z.literal(true),
});
export type TimeoutRequest = z.infer<typeof timeoutSchema>;

export const performSchema = z.object({
  assistants: z.array(uuid).max(10).default([]),
  anaesthesia: z.enum(['none', 'local', 'regional', 'sedation', 'general']).default('none'),
  anaesthetistId: uuid.optional(),
  sedationRecord: z.record(z.string(), z.unknown()).optional(),
});
export type PerformRequest = z.infer<typeof performSchema>;

export const completeSchema = z.object({
  findings: z.string().trim().min(4).max(20_000),
  technique: z.string().trim().max(20_000).optional(),
  eblMl: z.number().int().min(0).max(10_000).optional(),
  specimens: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  complications: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  outcome: z.enum(['completed', 'abandoned']).default('completed'),
});
export type CompleteRequest = z.infer<typeof completeSchema>;

export const recoverySchema = z.object({
  aldreteScore: z.number().int().min(0).max(10).optional(),
  escortName: z.string().trim().max(160).optional(),
  escortRelationship: z.string().trim().max(60).optional(),
  instructions: z.string().trim().max(4000).optional(),
  discharge: z.boolean().default(false),
});
export type RecoveryRequest = z.infer<typeof recoverySchema>;

export const consumableSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: uuid,
        batchId: uuid.optional(),
        qty: z.number().positive().max(10_000),
        uom: z.string().trim().min(1).max(16),
        source: z.enum(['kit', 'scanned', 'manual']).default('manual'),
        chargeable: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(60),
});
export type ConsumableRequest = z.infer<typeof consumableSchema>;

export const orderQuerySchema = z.object({
  openOnly: queryFlag().default(true),
  status: z
    .enum([
      'ordered',
      'scheduled',
      'checked_in',
      'ready',
      'in_progress',
      'completed',
      'abandoned',
      'cancelled',
      'no_show',
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});
export type OrderQuery = z.infer<typeof orderQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// OP-039
// ─────────────────────────────────────────────────────────────────────────────

export const taskSchema = z.object({
  patientId: uuid,
  encounterId: uuid,
  orderId: uuid.optional(),
  type: z.enum([
    'injection',
    'iv_fluid',
    'infusion',
    'nebulisation',
    'oxygen',
    'dressing',
    'suture_removal',
    'plaster_apply',
    'plaster_check',
    'plaster_remove',
    'catheter',
    'ear_syringing',
    'ecg',
    'cannulation',
    'minor_ot_prep',
    'observation',
    'other',
  ]),
  roomType: z.enum([
    'minor_ot',
    'procedure_room',
    'injection_room',
    'dressing',
    'plaster',
    'endoscopy',
    'eye_laser',
    'observation_bay',
    'nebulisation',
  ]),
  roomId: uuid.optional(),
  dayNo: z.number().int().min(1).max(365).optional(),
  dayTotal: z.number().int().min(1).max(365).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
  notes: z.string().trim().max(2000).optional(),
});
export type TaskRequest = z.infer<typeof taskSchema>;

export const taskStatusSchema = z.object({
  status: z.enum([
    'released',
    'queued',
    'in_progress',
    'observation',
    'completed',
    'missed',
    'cancelled',
    'held',
  ]),
  reason: z.string().trim().min(4).max(2000).optional(),
});
export type TaskStatusRequest = z.infer<typeof taskStatusSchema>;

/**
 * A drug given in an OPD room.
 *
 * `verifierId` is the second person on a high-alert drug, and the database
 * refuses it when it equals the giver. There is no `skipVerification`, no
 * `singleNurse`, and no way to say the batch was expired but fine.
 */
export const administerSchema = z.object({
  drugName: z.string().trim().min(1).max(200),
  drugId: uuid.optional(),
  orderedDose: z.number().positive().max(100_000),
  givenDose: z.number().positive().max(100_000),
  doseUnit: z.string().trim().min(1).max(16),
  doseChangeReason: z.string().trim().min(4).max(2000).optional(),
  route: z.enum(['im', 'iv_push', 'iv_infusion', 'sc', 'id', 'inhalation', 'topical', 'oral', 'other']),
  site: z.string().trim().max(60).optional(),
  batchNo: z.string().trim().max(60).optional(),
  expiry: z.string().date().optional(),
  barcodeVerified: z.boolean().default(false),
  identityMethod: z.enum(['qr', 'wristband', 'two_identifiers']),
  highAlert: z.boolean().default(false),
  verifierId: uuid.optional(),
  /** The allergy list was read. There is no route that gives a drug without it. */
  allergyChecked: z.literal(true),
  observationMinutes: z.number().int().min(0).max(240).default(0),
});
export type AdministerRequest = z.infer<typeof administerSchema>;

export const observationOutcomeSchema = z.object({
  outcome: z.enum(['uneventful', 'reaction', 'left_early']),
  reaction: z.record(z.string(), z.unknown()).optional(),
});
export type ObservationOutcomeRequest = z.infer<typeof observationOutcomeSchema>;

export const dressingSchema = z.object({
  patientId: uuid,
  woundId: uuid.optional(),
  site: z.string().trim().min(1).max(120),
  assessment: z.record(z.string(), z.unknown()).default({}),
  materials: z.array(z.record(z.string(), z.unknown())).max(30).optional(),
  suturesRemoved: z.number().int().min(0).max(200).optional(),
  suturesRetained: z.number().int().min(0).max(200).optional(),
  infectionSigns: z.boolean().default(false),
  nextDueAt: z.string().datetime({ offset: true }).optional(),
});
export type DressingRequest = z.infer<typeof dressingSchema>;

export const taskQuerySchema = z.object({
  roomType: z
    .enum([
      'minor_ot',
      'procedure_room',
      'injection_room',
      'dressing',
      'plaster',
      'endoscopy',
      'eye_laser',
      'observation_bay',
      'nebulisation',
    ])
    .optional(),
  openOnly: queryFlag().default(true),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});
export type TaskQuery = z.infer<typeof taskQuerySchema>;
