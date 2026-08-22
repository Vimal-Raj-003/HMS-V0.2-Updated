import { z } from 'zod';

/**
 * Request contracts for OP-002 §3.3 (e-Rx), §3.4 (CPOE) and EN-029 §6 (CDSS).
 *
 * Two of these schemas carry a clinical rule rather than a shape rule, and both
 * are here on purpose so the caller gets a field error instead of a constraint
 * violation from four layers down:
 *
 *  * `overrideSchema` requires a **coded** reason. `note` alone does not parse.
 *    EN-029 §5: "free text alone is not accepted" — and exit gate 8's
 *    override-rate-by-reason report is only possible if the code is mandatory at
 *    the door, not merely preferred.
 *  * `prescriptionLineSchema` refuses a `per_kg` line whose weight the service
 *    would have to guess: the weight is not accepted from the client at all, it
 *    is read from the encounter, so a client cannot supply a convenient one.
 */

const uuid = z.string().uuid();
const reason = z.string().trim().min(8, 'Give a reason somebody reading the register can act on').max(1000);

export const DOSE_BASES = ['flat', 'per_kg', 'per_m2'] as const;
export const TIMINGS = ['before_food', 'after_food', 'with_food', 'empty_stomach', 'bedtime', 'any'] as const;
export const DURATION_UNITS = ['days', 'weeks', 'months', 'continuous'] as const;
export const ORDER_CATEGORIES = [
  'lab',
  'radiology',
  'procedure',
  'nursing',
  'referral',
  'admission',
  'diet',
  'physio',
  'therapy',
  'other',
] as const;
export const ORDER_PRIORITIES = ['routine', 'urgent', 'stat'] as const;
export const LATERALITIES = ['left', 'right', 'bilateral', 'not_applicable'] as const;
export const PREGNANCY_STATUSES = ['unknown', 'no', 'yes', 'possible'] as const;
export const ALERT_RESPONSES = ['acknowledged', 'overridden', 'order_changed', 'order_abandoned'] as const;

/**
 * A clinician's response to one soft stop, carried inline on the line it belongs
 * to so a prescription is one round trip rather than three.
 *
 * `reasonCode` is required. That is the whole point: the reason is a foreign key
 * into `clinical.cdss_override_reasons` (the column is NOT NULL for an override),
 * so a free-text-only response is refused here, again by the service against the
 * master, and again by the CHECK on `cdss_alert_actions`.
 */
export const overrideSchema = z.object({
  /** The family the override answers: `ddi`, `dose_range`, `duplicate_therapy`… */
  family: z.string().trim().min(2).max(48),
  reasonCode: z.string().trim().min(1).max(48),
  note: z.string().trim().max(2000).optional(),
});

export const prescriptionLineSchema = z.object({
  /** `mdm_drugs.record_key`. Null only for an external/OTC recommendation line. */
  drugKey: uuid.optional(),
  brandKey: uuid.optional(),
  /** Required when no `drugKey` is given: the printed identity of the line. */
  genericName: z.string().trim().min(2).max(300).optional(),
  doseQty: z.number().positive().max(100000).optional(),
  doseUnit: z.string().trim().max(24).optional(),
  doseBasis: z.enum(DOSE_BASES).default('flat'),
  frequencyCode: z.string().trim().max(24).optional(),
  timing: z.enum(TIMINGS).optional(),
  durationValue: z.number().int().positive().max(3650).optional(),
  durationUnit: z.enum(DURATION_UNITS).optional(),
  quantity: z.number().nonnegative().max(100000).optional(),
  quantityUnit: z.string().trim().max(24).optional(),
  refills: z.number().int().min(0).max(12).default(0),
  isPrn: z.boolean().default(false),
  prnReason: z.string().trim().max(300).optional(),
  instructionsText: z.string().trim().max(2000).optional(),
  doNotSubstitute: z.boolean().default(false),
  externalOnly: z.boolean().default(false),
  overrides: z.array(overrideSchema).max(20).default([]),
});

export const createPrescriptionSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  visitId: uuid.optional(),
  branchId: uuid.optional(),
  pharmacyStoreId: uuid.optional(),
  notes: z.string().trim().max(4000).optional(),
  /**
   * OP-002 AC-5: a resident marks the draft ready and it waits for a
   * consultant. Signing is a different permission (`rx.sign`), so this is how a
   * prescriber without it hands over.
   */
  requestCosign: z.boolean().default(false),
  items: z.array(prescriptionLineSchema).min(1).max(50),
});

export const signPrescriptionSchema = z.object({
  /** `system` (the NMC registration on file) or `dsc` / `aadhaar_esign` via EN-016. */
  signMethod: z.enum(['system', 'dsc', 'aadhaar_esign', 'webauthn']).default('system'),
  pharmacyStoreId: uuid.optional(),
});

export const amendPrescriptionSchema = z.object({
  reason,
  notes: z.string().trim().max(4000).optional(),
  items: z.array(prescriptionLineSchema).min(1).max(50),
});

export const cancelPrescriptionSchema = z.object({ reason });

export const cosignPrescriptionSchema = z.object({
  /** `countersign` is the honest default here: this signature is a second one. */
  signMethod: z.enum(['countersign', 'system', 'dsc', 'aadhaar_esign', 'webauthn']).default('countersign'),
});

/** EN-029 §6 `POST /cdss/evaluate` — a draft bundle, before persistence. */
export const evaluateSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  items: z.array(prescriptionLineSchema).min(1).max(50),
});

export const alertResponseSchema = z.object({
  /** Both halves of the alert's composite key; the table is partitioned by time. */
  firedAt: z.string().datetime(),
  kind: z.enum(ALERT_RESPONSES),
  reasonCode: z.string().trim().min(1).max(48).optional(),
  note: z.string().trim().max(2000).optional(),
});

export const alertQuerySchema = z.object({
  patientId: uuid.optional(),
  encounterId: uuid.optional(),
  family: z.string().trim().max(48).optional(),
  outcome: z.string().trim().max(32).optional(),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const fatigueQuerySchema = z.object({
  /** Bounded: the live aggregate is a governance report, not a dashboard tick. */
  days: z.coerce.number().int().min(1).max(31).default(7),
});

export const drugSearchSchema = z.object({
  q: z.string().trim().min(2).max(80),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const orderLineSchema = z.object({
  serviceKey: uuid.optional(),
  serviceName: z.string().trim().min(2).max(300),
  catalogueCode: z.string().trim().max(64).optional(),
  modalityCode: z.string().trim().max(16).optional(),
  bodyPartCode: z.string().trim().max(64).optional(),
  qty: z.number().positive().max(999).default(1),
  laterality: z.enum(LATERALITIES).default('not_applicable'),
  contrast: z.boolean().default(false),
  fastingRequired: z.boolean().default(false),
  /** The tariff snapshot, when the caller has one. Phase 5 prices the rest. */
  unitPrice: z.number().nonnegative().max(10_000_000).optional(),
});

export const createOrderSchema = z.object({
  patientId: uuid,
  encounterId: uuid.optional(),
  visitId: uuid.optional(),
  branchId: uuid.optional(),
  category: z.enum(ORDER_CATEGORIES),
  priority: z.enum(ORDER_PRIORITIES).default('routine'),
  /** Mandatory for radiology — AERB justification the database also checks. */
  clinicalNotes: z.string().trim().max(4000).optional(),
  diagnosisCodes: z.array(z.string().trim().max(16)).max(20).default([]),
  isBillable: z.boolean().default(true),
  pregnancyStatus: z.enum(PREGNANCY_STATUSES).optional(),
  radiationJustification: z.string().trim().max(2000).optional(),
  items: z.array(orderLineSchema).min(1).max(50),
});

export const cancelOrderSchema = z.object({ reason });

export const orderQuerySchema = z.object({
  patientId: uuid.optional(),
  category: z.enum(ORDER_CATEGORIES).optional(),
  status: z.string().trim().max(24).optional(),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const idSchema = z.string().uuid('That is not a valid identifier.');

export type PrescriptionLineRequest = z.infer<typeof prescriptionLineSchema>;
export type CreatePrescriptionRequest = z.infer<typeof createPrescriptionSchema>;
export type SignPrescriptionRequest = z.infer<typeof signPrescriptionSchema>;
export type AmendPrescriptionRequest = z.infer<typeof amendPrescriptionSchema>;
export type CancelPrescriptionRequest = z.infer<typeof cancelPrescriptionSchema>;
export type CosignPrescriptionRequest = z.infer<typeof cosignPrescriptionSchema>;
export type EvaluateRequest = z.infer<typeof evaluateSchema>;
export type AlertResponseRequest = z.infer<typeof alertResponseSchema>;
export type AlertQuery = z.infer<typeof alertQuerySchema>;
export type FatigueQuery = z.infer<typeof fatigueQuerySchema>;
export type DrugSearchQuery = z.infer<typeof drugSearchSchema>;
export type CreateOrderRequest = z.infer<typeof createOrderSchema>;
export type CancelOrderRequest = z.infer<typeof cancelOrderSchema>;
export type OrderQuery = z.infer<typeof orderQuerySchema>;
export type OverrideRequest = z.infer<typeof overrideSchema>;
