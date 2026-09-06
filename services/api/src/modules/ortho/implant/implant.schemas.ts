import { queryFlag } from '@vims/contracts';
import { z } from 'zod';

/**
 * TR-003 + TR-005 request schemas.
 *
 * ── Why `scanned` is not a boolean the client picks freely ──────────────────
 *
 * The pair (`scanned`, `scanPayload`) is checked by the database: scanned means
 * a payload, unscanned means a reason. The schema mirrors that as a discriminated
 * shape so the refusal is a 422 with a field rather than a 409 from Postgres —
 * but the database still holds the line, because this schema is not the only
 * way a row can be written.
 */

const uuid = z.string().uuid();
const shortText = z.string().trim().min(1).max(200);

/** A UDI-DI is a GS1/HIBCC device identifier. Digits for GS1, alphanumeric for HIBCC. */
const udi = z
  .string()
  .trim()
  .min(6)
  .max(64)
  .regex(/^[A-Za-z0-9+./-]+$/u, 'A device identifier is alphanumeric — check the scan.');

export const implantKindSchema = z.enum([
  'plate',
  'screw',
  'intramedullary_nail',
  'external_fixator',
  'k_wire',
  'prosthesis',
  'spinal_construct',
  'cement',
  'graft',
  'suture_anchor',
  'other',
]);

export const mriConditionalitySchema = z.enum(['safe', 'conditional', 'unsafe', 'unknown']);
export const ownershipSchema = z.enum(['owned', 'consignment', 'loan_set']);
export const stockStatusSchema = z.enum([
  'available',
  'reserved',
  'implanted',
  'wasted',
  'returned',
  'expired',
  'quarantined',
]);

export const catalogueSchema = z.object({
  udiDi: udi.optional(),
  gtin: z.string().trim().max(20).optional(),
  catalogueNo: z.string().trim().max(60).optional(),
  manufacturer: shortText,
  brand: z.string().trim().max(120).optional(),
  kind: implantKindSchema,
  description: shortText,
  sizeLabel: z.string().trim().max(80).optional(),
  laterality: z.enum(['left', 'right', 'either']).default('either'),
  material: z.string().trim().max(120).optional(),
  mriConditionality: mriConditionalitySchema.default('unknown'),
  mriConditions: z.record(z.string(), z.unknown()).optional(),
  shelfLifeMonths: z.number().int().min(1).max(600).optional(),
  ownership: ownershipSchema.default('owned'),
  vendorId: uuid.optional(),
  consignmentPrice: z.number().nonnegative().optional(),
});
export type CatalogueRequest = z.infer<typeof catalogueSchema>;

export const receiveStockSchema = z
  .object({
    catalogueId: uuid,
    serialNo: z.string().trim().max(80).optional(),
    lotNo: z.string().trim().max(80).optional(),
    udiPi: z.string().trim().max(120).optional(),
    expiryOn: z.string().date().optional(),
    location: z.string().trim().max(120).optional(),
    grnRef: z.string().trim().max(60).optional(),
    /** Booking in a box of ten identical screws should not need ten requests. */
    quantity: z.number().int().min(1).max(200).default(1),
  })
  .refine((v) => v.serialNo !== undefined || v.lotNo !== undefined, {
    message:
      'A device needs a serial number or a lot number. One with neither cannot be found again when a field safety notice names it.',
    path: ['serialNo'],
  })
  .refine((v) => v.quantity === 1 || v.serialNo === undefined, {
    message: 'A serial number identifies one device. Book serialised items in one at a time.',
    path: ['quantity'],
  });
export type ReceiveStockRequest = z.infer<typeof receiveStockSchema>;

export const adjustStockSchema = z.object({
  status: z.enum(['available', 'reserved', 'wasted', 'returned', 'quarantined']),
  location: z.string().trim().max(120).optional(),
  reservedForCaseId: uuid.optional(),
});
export type AdjustStockRequest = z.infer<typeof adjustStockSchema>;

export const recordUsageSchema = z
  .object({
    stockItemId: uuid,
    patientId: uuid,
    fractureId: uuid.optional(),
    otCaseId: uuid.optional(),
    admissionId: uuid.optional(),
    procedureCode: z.string().trim().max(40).optional(),
    procedureName: shortText,
    // Required, and `not_applicable` is one of the answers. A cement plug has
    // no side; a nail does. Leaving it blank makes those two look the same, and
    // laterality is the one field this module refuses to let go unstated.
    side: z.enum(['left', 'right', 'bilateral', 'not_applicable']),
    surgeonId: uuid,
    implantedAt: z.string().datetime({ offset: true }).optional(),
    scanned: z.boolean(),
    scanPayload: z.string().trim().max(400).optional(),
    /** Required when `scanned` is false. Kept with the record, not in a log. */
    manualReason: z.string().trim().min(12).max(400).optional(),
    chargedPrice: z.number().nonnegative().optional(),
  })
  .refine((v) => !v.scanned || (v.scanPayload !== undefined && v.scanPayload.length > 0), {
    message: 'A scanned device carries what the scanner read. Without it the scan is a claim, not evidence.',
    path: ['scanPayload'],
  })
  .refine((v) => v.scanned || v.manualReason !== undefined, {
    message:
      'A device entered by hand records why it was not scanned. This is the population a recall will struggle to match.',
    path: ['manualReason'],
  });
export type RecordUsageRequest = z.infer<typeof recordUsageSchema>;

export const explantSchema = z.object({
  explantedAt: z.string().datetime({ offset: true }).optional(),
  reason: z.string().trim().min(8).max(400),
});
export type ExplantRequest = z.infer<typeof explantSchema>;

export const recallSchema = z
  .object({
    reference: shortText,
    catalogueId: uuid.optional(),
    udiDi: udi.optional(),
    lotNos: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
    manufacturer: shortText,
    kind: z.enum(['recall', 'field_safety_notice', 'advisory', 'withdrawal']).default('recall'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
    summary: z.string().trim().min(8).max(2000),
    actionRequired: z.string().trim().min(8).max(2000),
    issuedOn: z.string().date(),
  })
  .refine((v) => v.catalogueId !== undefined || v.udiDi !== undefined || v.lotNos.length > 0, {
    message:
      'A recall names a device or a list of lots. One that names neither cannot produce a patient list, which is the only thing it is for.',
    path: ['lotNos'],
  });
export type RecallRequest = z.infer<typeof recallSchema>;

export const recallContactSchema = z.object({
  response: z.enum(['pending', 'informed', 'reviewed', 'revised', 'declined', 'unreachable', 'deceased']),
  notifiedPatient: z.boolean().default(false),
  notifiedSurgeon: z.boolean().default(false),
  notes: z.string().trim().max(1000).optional(),
});
export type RecallContactRequest = z.infer<typeof recallContactSchema>;

export const traceQuerySchema = z
  .object({
    udiDi: udi.optional(),
    lotNo: z.string().trim().max(80).optional(),
    catalogueId: uuid.optional(),
    /** Explanted devices are in the list by default — they were once implanted. */
    inSituOnly: queryFlag().default(false),
  })
  .refine((v) => v.udiDi !== undefined || v.lotNo !== undefined || v.catalogueId !== undefined, {
    message: 'The trace needs a device identifier, a lot number or a catalogue entry.',
    path: ['udiDi'],
  });
export type TraceQuery = z.infer<typeof traceQuerySchema>;

// ─────────────────────────────────────────────────────────────────────────────
// TR-005
// ─────────────────────────────────────────────────────────────────────────────

export const immobilisationKindSchema = z.enum([
  'cast',
  'backslab',
  'splint',
  'brace',
  'traction',
  'external_fixator',
  'sling',
  'other',
]);

export const castRequestSchema = z.object({
  patientId: uuid,
  fractureId: uuid.optional(),
  erVisitId: uuid.optional(),
  admissionId: uuid.optional(),
  kind: immobilisationKindSchema,
  side: z.enum(['left', 'right', 'bilateral', 'not_applicable']),
  bodyRegion: shortText,
  position: z.string().trim().max(120).optional(),
  material: z.string().trim().max(60).optional(),
  /** The fracture plan's own vocabulary, so the two cannot give one leg two instructions. */
  weightBearing: z.enum(['nwb', 'ttwb', 'pwb', 'wbat', 'fwb']).optional(),
  urgency: z.enum(['routine', 'urgent', 'immediate']).default('routine'),
  instructions: z.string().trim().max(2000).optional(),
});
export type CastRequestBody = z.infer<typeof castRequestSchema>;

export const castApplySchema = z.object({
  requestId: uuid,
  kind: immobilisationKindSchema,
  side: z.enum(['left', 'right', 'bilateral', 'not_applicable']),
  material: shortText,
  position: z.string().trim().max(120).optional(),
  padding: z.string().trim().max(200).optional(),
  appliedIn: z.string().trim().max(40).default('plaster_room'),
  appliedAt: z.string().datetime({ offset: true }).optional(),
  instructionsGivenLocale: z.string().trim().max(12).optional(),
  /** Hours until the first neurovascular check. The ward list is built from it. */
  firstCheckHours: z.number().int().min(1).max(168).default(24),
  plannedRemovalAt: z.string().datetime({ offset: true }).optional(),
});
export type CastApplyRequest = z.infer<typeof castApplySchema>;

export const castCheckSchema = z.object({
  kind: z
    .enum(['first_check', 'ward_round', 'clinic', 'patient_reported', 'discharge'])
    .default('ward_round'),
  painOutOfProportion: z.boolean().default(false),
  painOnPassiveStretch: z.boolean().default(false),
  paraesthesia: z.boolean().default(false),
  pallor: z.boolean().default(false),
  pulselessness: z.boolean().default(false),
  otherFindings: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  capillaryRefillSec: z.number().int().min(0).max(60).optional(),
  skinIntact: z.boolean().default(true),
  castIntact: z.boolean().default(true),
  neurovascularIntact: z.boolean().default(true),
  /**
   * What was done. Not optional in practice: the database refuses a check that
   * found a red flag and records no action, and it decides what a red flag is.
   */
  actionTaken: z.string().trim().max(1000).optional(),
  escalatedTo: uuid.optional(),
  photoRef: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type CastCheckRequest = z.infer<typeof castCheckSchema>;

export const castRemoveSchema = z.object({
  removedAt: z.string().datetime({ offset: true }).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type CastRemoveRequest = z.infer<typeof castRemoveSchema>;

export const pinSiteSchema = z.object({
  pinLabel: shortText,
  intervalDays: z.number().int().min(1).max(30).default(3),
  solution: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type PinSiteRequest = z.infer<typeof pinSiteSchema>;

export const pinCareSchema = z.object({
  /** Checketts-Otterburn 1 to 6. Grade 3 needs antibiotics; grade 5 usually means the pin comes out. */
  infectionGrade: z.number().int().min(1).max(6).optional(),
  notes: z.string().trim().max(1000).optional(),
  isActive: z.boolean().optional(),
});
export type PinCareRequest = z.infer<typeof pinCareSchema>;

export const idSchema = z.object({ id: uuid });

export const stockQuerySchema = z.object({
  catalogueId: uuid.optional(),
  status: stockStatusSchema.optional(),
  lotNo: z.string().trim().max(80).optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(3650).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type StockQuery = z.infer<typeof stockQuerySchema>;

export const catalogueQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  kind: implantKindSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;

export const castQuerySchema = z.object({
  patientId: uuid.optional(),
  status: z.enum(['requested', 'applied', 'changed', 'removed', 'cancelled']).optional(),
  dueOnly: queryFlag().default(false),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type CastQuery = z.infer<typeof castQuerySchema>;
