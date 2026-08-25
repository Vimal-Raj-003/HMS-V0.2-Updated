import { z } from 'zod';

/**
 * Request contracts for OP-003 — the pharmacy counter.
 *
 * Three shapes here carry a safety rule rather than a shape rule:
 *
 *  * `coSignerSchema` is the second pharmacist's own credential. It is never a
 *    user id alone: an id is something the first pharmacist can type, and a
 *    control that one person can satisfy is not a control.
 *  * `addDispenseItemSchema` accepts either a **scan** or an explicit item and
 *    batch, and nothing else. There is no "quantity of a drug" shape without a
 *    batch on a batch-tracked item, which is `phase-04 §Constraints`' "never
 *    dispense without a successful batch validation" expressed where a client
 *    can see it.
 *  * `completeDispenseSchema` carries the acknowledgements for any CDSS hard
 *    stop rather than a flag that says the check was done. The check is re-run
 *    server-side at completion regardless; what the client sends is the
 *    pharmacist's *reason*, which is the only thing a re-run cannot produce.
 */

const uuid = z.string().uuid();
const cursor = z.string().max(2000).optional();
const pageLimit = z.coerce.number().int().min(1).max(100).default(25);
const reason = z
  .string()
  .trim()
  .min(8, 'Give a reason somebody reviewing this in a year can act on')
  .max(2000);
const qty = z.coerce.number().positive().max(1e9);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date, e.g. 2026-08-25');

export const idSchema = uuid;

export const DISPENSE_TYPES = ['rx', 'otc', 'ip_issue', 'ward_stock', 'sample', 'emergency_box'] as const;
export const QUEUE_STATUSES = [
  'pending',
  'patient_arrived',
  'in_progress',
  'on_hold',
  'awaiting_approval',
  'completed',
  'partial',
  'not_collected',
  'cancelled',
] as const;
export const REGISTER_TXN_TYPES = [
  'opening',
  'receipt',
  'issue',
  'dispense',
  'return_in',
  'destruction',
  'adjustment',
] as const;
export const EXPIRY_ACTIONS = [
  'return_to_supplier',
  'transfer',
  'discount',
  'quarantine',
  'writeoff',
  'disposal',
] as const;
export const RECALL_SOURCES = ['cdsco', 'manufacturer', 'internal', 'vendor', 'state_fda'] as const;

/**
 * The second person, as a credential rather than an identifier.
 *
 * `frontoffice/cash/cosign.service.ts` established this shape and the reason it
 * is a password and not a PIN: neither a PIN verifier nor a TOTP verifier exists
 * in `services/api`, and accepting the field while ignoring the factor would be
 * worse than refusing it.
 */
export const coSignerSchema = z.object({
  identifier: z.string().trim().min(1).max(120),
  credentialKind: z.enum(['password', 'pin', 'totp']).default('password'),
  credential: z.string().min(1).max(256),
});
export type CoSignerInput = z.infer<typeof coSignerSchema>;

// ── the queue (OP-003 §3) ────────────────────────────────────────────────────

export const enqueueRxSchema = z.object({
  prescriptionId: uuid,
  pharmacyStoreId: uuid,
  priority: z.coerce.number().int().min(0).max(9).default(0),
  slaMinutes: z.coerce.number().int().min(1).max(1440).optional(),
});
export type EnqueueRxRequest = z.infer<typeof enqueueRxSchema>;

export const queueQuerySchema = z.object({
  pharmacyStoreId: uuid.optional(),
  status: z.enum(QUEUE_STATUSES).optional(),
  assignedTo: uuid.optional(),
  cursor,
  limit: pageLimit,
});
export type QueueQuery = z.infer<typeof queueQuerySchema>;

/**
 * Patient identity verification at the counter (OP-003 §3).
 *
 * The method is recorded, not merely a boolean: "we checked" is not evidence,
 * and the difference between a scanned wristband and "asked their name" is the
 * difference between a verified identity and a good-faith belief.
 */
export const arriveSchema = z.object({
  identityMethod: z.enum([
    'uhid_scan',
    'wristband_scan',
    'abha_verified',
    'photo_id',
    'two_identifiers_verbal',
    'attendant_verified',
  ]),
});
export type ArriveRequest = z.infer<typeof arriveSchema>;

export const assignSchema = z.object({ assignedTo: uuid });
export type AssignRequest = z.infer<typeof assignSchema>;

export const holdSchema = z.object({ reason });
export type HoldRequest = z.infer<typeof holdSchema>;

// ── dispensing (OP-003 §3) ───────────────────────────────────────────────────

export const createDispenseSchema = z
  .object({
    pharmacyStoreId: uuid,
    dispenseType: z.enum(DISPENSE_TYPES),
    prescriptionId: uuid.optional(),
    rxQueueId: uuid.optional(),
    patientId: uuid.optional(),
    encounterId: uuid.optional(),
    walkInName: z.string().trim().min(1).max(200).optional(),
    walkInPhone: z.string().trim().max(20).optional(),
    prescriberName: z.string().trim().max(200).optional(),
    prescriberRegNo: z.string().trim().max(64).optional(),
    payerType: z.enum(['cash', 'credit', 'insurance', 'corporate', 'scheme']).default('cash'),
    notes: z.string().trim().max(2000).optional(),
  })
  // A prescription identifies its own patient, and the service takes it from
  // there rather than from the request: a dispense that could name a different
  // patient from the prescription it cites is the wrong-patient error with a
  // paper trail saying it was right.
  .refine(
    (body) =>
      body.patientId !== undefined || body.walkInName !== undefined || body.prescriptionId !== undefined,
    {
      message:
        'A dispense identifies somebody — a registered patient, a named walk-in, or the prescription it is filling. An anonymous sale of a prescription medicine is not a record of anything.',
      path: ['patientId'],
    },
  )
  .refine((body) => body.dispenseType !== 'rx' || body.prescriptionId !== undefined, {
    message: 'A prescription dispense names the prescription it is filling.',
    path: ['prescriptionId'],
  });
export type CreateDispenseRequest = z.infer<typeof createDispenseSchema>;

export const addDispenseItemSchema = z
  .object({
    /** A GS1 payload or a plain barcode. Resolves item, pack, batch and expiry. */
    scanned: z.string().trim().min(1).max(200).optional(),
    itemId: uuid.optional(),
    batchId: uuid.optional(),
    uomId: uuid.optional(),
    qtyEntered: qty,
    prescriptionItemId: uuid.optional(),
    qtyOrderedBase: z.coerce.number().min(0).optional(),
    /** `phase-04 §4.4`: a partial fill says why. */
    partialReason: z.string().trim().min(4).max(500).optional(),
    substitutionRequestId: uuid.optional(),
    fefoOverrideReason: z.string().trim().min(4).max(500).optional(),
    sellingPrice: z.coerce.number().min(0).optional(),
    discount: z.coerce.number().min(0).optional(),
  })
  .refine((body) => body.scanned !== undefined || body.itemId !== undefined, {
    message: 'Scan the pack, or name the item explicitly. A dispense line needs one of the two.',
    path: ['scanned'],
  });
export type AddDispenseItemRequest = z.infer<typeof addDispenseItemSchema>;

export const declineDispenseItemSchema = z.object({
  itemId: uuid,
  prescriptionItemId: uuid.optional(),
  status: z.enum(['declined', 'backordered', 'external']),
  reason,
  qtyOrderedBase: z.coerce.number().min(0).default(0),
  uomId: uuid.optional(),
});
export type DeclineDispenseItemRequest = z.infer<typeof declineDispenseItemSchema>;

export const secondAuthoriserSchema = z.object({
  coSigner: coSignerSchema,
  /** What the second pharmacist is signing for; recorded on the audit row. */
  note: z.string().trim().max(500).optional(),
});
export type SecondAuthoriserRequest = z.infer<typeof secondAuthoriserSchema>;

export const completeDispenseSchema = z.object({
  /**
   * One entry per CDSS hard stop the pharmacist is clearing. The check is re-run
   * server-side at completion, so an acknowledgement for an alert that no longer
   * fires is simply unused — and an alert with no acknowledgement blocks.
   */
  acknowledgements: z
    .array(z.object({ dispenseItemId: uuid, alertKey: z.string().trim().min(1).max(120), reason }))
    .max(50)
    .default([]),
  counselling: z
    .object({
      counselled: z.boolean().default(false),
      language: z.string().trim().max(16).optional(),
      points: z.array(z.string().trim().max(200)).max(20).default([]),
    })
    .optional(),
  /** Required when any line is a narcotic or psychotropic. */
  coSigner: coSignerSchema.optional(),
});
export type CompleteDispenseRequest = z.infer<typeof completeDispenseSchema>;

export const cancelDispenseSchema = z.object({ reason });
export type CancelDispenseRequest = z.infer<typeof cancelDispenseSchema>;

export const dispenseQuerySchema = z.object({
  patientId: uuid.optional(),
  pharmacyStoreId: uuid.optional(),
  status: z.string().trim().max(32).optional(),
  prescriptionId: uuid.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  cursor,
  limit: pageLimit,
});
export type DispenseQuery = z.infer<typeof dispenseQuerySchema>;

export const labelSchema = z.object({
  locales: z.array(z.string().trim().min(2).max(16)).min(1).max(4).default(['en-IN']),
});
export type LabelRequest = z.infer<typeof labelSchema>;

// ── substitution (OP-003 §3) ─────────────────────────────────────────────────

export const requestSubstitutionSchema = z.object({
  prescriptionItemId: uuid.optional(),
  fromItemId: uuid,
  toItemId: uuid,
  reason,
  prescriberUserId: uuid.optional(),
  decisionMinutes: z.coerce.number().int().min(1).max(1440).default(30),
});
export type RequestSubstitutionRequest = z.infer<typeof requestSubstitutionSchema>;

export const decideSubstitutionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(1000).optional(),
});
export type DecideSubstitutionRequest = z.infer<typeof decideSubstitutionSchema>;

// ── returns (OP-003 §3) ──────────────────────────────────────────────────────

export const createSaleReturnSchema = z.object({
  originalDispenseId: uuid,
  reasonCode: z.string().trim().min(2).max(48),
  reason: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        dispenseItemId: uuid,
        qtyEntered: qty,
        uomId: uuid.optional(),
        /** Whether the units go back on the shelf, or into quarantine. */
        disposition: z.enum(['restock', 'quarantine', 'destroy']).default('quarantine'),
      }),
    )
    .min(1)
    .max(50),
});
export type CreateSaleReturnRequest = z.infer<typeof createSaleReturnSchema>;

export const approveSaleReturnSchema = z.object({ note: z.string().trim().max(1000).optional() });
export type ApproveSaleReturnRequest = z.infer<typeof approveSaleReturnSchema>;

// ── expiry, recall and cold chain ────────────────────────────────────────────

export const expiryQuerySchema = z.object({
  pharmacyStoreId: uuid.optional(),
  days: z.coerce.number().int().min(0).max(3650).default(90),
  cursor,
  limit: pageLimit,
});
export type PharmacyExpiryQuery = z.infer<typeof expiryQuerySchema>;

export const expiryActionSchema = z.object({
  storeId: uuid,
  batchId: uuid,
  itemId: uuid,
  action: z.enum(EXPIRY_ACTIONS),
  qtyEntered: qty,
  uomId: uuid.optional(),
  reason,
  bmwRecordRef: z.string().trim().max(64).optional(),
});
export type ExpiryActionRequest = z.infer<typeof expiryActionSchema>;

export const raiseRecallSchema = z.object({
  source: z.enum(RECALL_SOURCES),
  sourceRef: z.string().trim().max(160).optional(),
  itemId: uuid,
  batchNo: z.string().trim().min(1).max(64),
  recallClass: z.enum(['class_i', 'class_ii', 'class_iii']).default('class_ii'),
  reason,
});
export type RaiseRecallRequest = z.infer<typeof raiseRecallSchema>;

export const recallQuerySchema = z.object({
  status: z.string().trim().max(24).optional(),
  cursor,
  limit: pageLimit,
});
export type RecallQuery = z.infer<typeof recallQuerySchema>;

export const closeRecallSchema = z.object({ reason });
export type CloseRecallRequest = z.infer<typeof closeRecallSchema>;

export const coldChainReadingSchema = z.object({
  zoneId: uuid,
  valueC: z.coerce.number().min(-90).max(60),
  humidityPct: z.coerce.number().min(0).max(100).optional(),
  recordedAt: z.string().datetime({ offset: true }).optional(),
});
export type ColdChainReadingRequest = z.infer<typeof coldChainReadingSchema>;

// ── the controlled-drug register ─────────────────────────────────────────────

export const registerEntrySchema = z.object({
  storeId: uuid,
  itemId: uuid,
  batchId: uuid.optional(),
  /**
   * `adjustment` and `opening` are deliberately absent. An adjustment to a
   * controlled balance is a stock adjustment first — maker, checker, and a
   * ledger row — and `phase-04` exit gate 4 says a mismatch "cannot be silently
   * adjusted". It reaches the register through the custody check that found it.
   */
  txnType: z.enum(['receipt', 'issue', 'return_in']),
  qtyEntered: qty,
  uomId: uuid.optional(),
  patientId: uuid.optional(),
  patientName: z.string().trim().max(200).optional(),
  prescriberName: z.string().trim().max(200).optional(),
  prescriberRegNo: z.string().trim().max(64).optional(),
  rxRef: z.string().trim().max(64).optional(),
  remarks: z.string().trim().max(1000).optional(),
  /** The second authorising pharmacist. Mandatory for the NDPS register. */
  coSigner: coSignerSchema,
});
export type RegisterEntryRequest = z.infer<typeof registerEntrySchema>;

export const registerQuerySchema = z.object({
  storeId: uuid.optional(),
  registerType: z.enum(['ndps', 'schedule_x', 'schedule_h1']).optional(),
  itemId: uuid.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  cursor,
  limit: pageLimit,
});
export type RegisterQuery = z.infer<typeof registerQuerySchema>;

export const custodyCheckSchema = z.object({
  storeId: uuid,
  itemId: uuid,
  batchId: uuid.optional(),
  shiftLabel: z.string().trim().min(1).max(32),
  physicalCountEntered: z.coerce.number().min(0),
  uomId: uuid.optional(),
  /**
   * All three are mandatory when the count disagrees with the register.
   *
   * `adjustmentId` is the posted, maker-checked stock adjustment that reconciles
   * the shelf. It is required **at the moment the count is filed** rather than
   * added afterwards, because `pharmacy.narcotic_custody_checks` has UPDATE
   * revoked: a row filed without it can never acquire one, and
   * `pharmacy.enforce_day_close_preconditions` would then refuse that business
   * date's close for ever. Requiring it up front costs nothing in rigour — the
   * adjustment carries its own reason, its own approver and its own ledger row —
   * and it keeps the shift closeable.
   */
  incidentRef: z.string().trim().max(64).optional(),
  explanation: z.string().trim().max(2000).optional(),
  adjustmentId: uuid.optional(),
  coSigner: coSignerSchema,
});
export type CustodyCheckRequest = z.infer<typeof custodyCheckSchema>;

export const destructionSchema = z.object({
  storeId: uuid,
  itemId: uuid,
  batchId: uuid,
  qtyEntered: qty,
  uomId: uuid.optional(),
  reason,
  bmwRecordRef: z.string().trim().max(64).optional(),
  coSigner: coSignerSchema,
});
export type DestructionRequest = z.infer<typeof destructionSchema>;

// ── interventions and day close ──────────────────────────────────────────────

export const interventionSchema = z.object({
  dispenseId: uuid.optional(),
  prescriptionId: uuid.optional(),
  patientId: uuid,
  interventionType: z.enum([
    'dose_query',
    'interaction',
    'duplicate_therapy',
    'allergy',
    'formulation',
    'route',
    'frequency',
    'substitution',
    'other',
  ]),
  detail: z.string().trim().min(4).max(2000),
  outcome: z.enum(['accepted', 'rejected', 'modified', 'no_change', 'referred']),
  doctorContacted: z.boolean().default(false),
  doctorUserId: uuid.optional(),
});
export type InterventionRequest = z.infer<typeof interventionSchema>;

export const dayCloseSchema = z.object({
  pharmacyStoreId: uuid,
  businessDate: isoDate,
  shiftLabel: z.string().trim().max(32).optional(),
  cashCounted: z.coerce.number().min(0).default(0),
  notes: z.string().trim().max(2000).optional(),
});
export type DayCloseRequest = z.infer<typeof dayCloseSchema>;

export const dayCloseQuerySchema = z.object({
  pharmacyStoreId: uuid.optional(),
  cursor,
  limit: pageLimit,
});
export type DayCloseQuery = z.infer<typeof dayCloseQuerySchema>;

export const stockQuerySchema = z.object({
  pharmacyStoreId: uuid,
  q: z.string().trim().max(120).optional(),
  expiringWithin: z.coerce.number().int().min(0).max(3650).optional(),
  cursor,
  limit: pageLimit,
});
export type PharmacyStockQuery = z.infer<typeof stockQuerySchema>;
