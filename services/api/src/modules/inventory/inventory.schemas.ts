import { z } from 'zod';
import { queryFlag } from '@vims/contracts';

/**
 * Request contracts for NC-005, NC-006, NC-007, NC-008 and NC-021.
 *
 * Three rules shape everything below, and each of them exists so a caller gets
 * a field error rather than a constraint violation from four layers down:
 *
 *  * **A quantity is never accepted without a unit.** `qtyLine` pairs
 *    `qtyEntered` with an optional `uomId` that defaults to the item's base
 *    unit — and `UomService` refuses a unit absent from the item's ladder before
 *    the row is built. `inventory.enforce_qty_uom` says the same thing in SQL;
 *    saying it here turns "23503" into "add the pack size to the item master".
 *  * **A quantity is a magnitude.** Nothing in this file accepts a negative
 *    quantity. The direction of a movement is the movement's type, and
 *    `StockLedgerService` is the only thing that applies a sign.
 *  * **Anything that undoes something carries a reason**, at a length somebody
 *    can act on. A one-character reason satisfies a `length > 0` CHECK and tells
 *    an auditor nothing, so the floor is set here where the message can say why.
 */

const uuid = z.string().uuid();
const cursor = z.string().max(2000).optional();
const pageLimit = z.coerce.number().int().min(1).max(100).default(25);
const reason = z
  .string()
  .trim()
  .min(8, 'Give a reason somebody reading the register in a year can act on')
  .max(2000);
const shortText = z.string().trim().min(1).max(300);
const code = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'A code is letters, digits, dot, dash, slash or underscore');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date, e.g. 2026-08-25');
const qty = z.coerce.number().positive().max(1e12);
const money = z.coerce.number().min(0).max(1e12);
const percent = z.coerce.number().min(0).max(100);

// ── enumerations, mirrored from the migration ────────────────────────────────

export const ITEM_TYPES = [
  'drug',
  'consumable',
  'surgical',
  'implant',
  'reagent',
  'blood_component_consumable',
  'linen',
  'stationery',
  'housekeeping',
  'engineering',
  'it_consumable',
  'food',
  'asset_spare',
  'instrument',
  'other',
] as const;

export const TRACKING = ['none', 'batch', 'batch_expiry', 'serial', 'udi'] as const;

export const DRUG_SCHEDULES = ['otc', 'g', 'h', 'h1', 'x', 'ndps_narcotic', 'ndps_psychotropic'] as const;

export const STORAGE_CONDITIONS = [
  'ambient',
  'cool_below_25',
  'cold_2_8',
  'frozen_minus_20',
  'deep_frozen_minus_70',
  'protect_from_light',
  'protect_from_moisture',
  'flammable_cabinet',
  'controlled_substance_safe',
] as const;

export const STORE_TYPES = [
  'main',
  'pharmacy',
  'ward',
  'icu',
  'ot',
  'er',
  'lab',
  'radiology',
  'cssd',
  'dialysis',
  'blood_bank',
  'kitchen',
  'housekeeping',
  'engineering',
  'it',
  'ambulance',
  'consignment',
  'quarantine',
  'expired_hold',
  'other',
] as const;

export const ABC_CLASSES = ['a', 'b', 'c', 'unclassified'] as const;
export const VED_CLASSES = ['vital', 'essential', 'desirable', 'unclassified'] as const;
export const FSN_CLASSES = ['fast', 'slow', 'non_moving', 'unclassified'] as const;
export const PACK_LEVELS = ['base', 'inner', 'outer', 'shipper'] as const;

export const ADJUSTMENT_TYPES = [
  'plus',
  'minus',
  'writeoff_expiry',
  'writeoff_damage',
  'writeoff_recall',
  'repack',
  'opening',
  'donation',
  'sample',
  'count_variance',
] as const;

export const QUARANTINE_REASONS = [
  'recall',
  'quality',
  'temperature_excursion',
  'expiry',
  'complaint',
  'regulatory_hold',
  'damage',
] as const;

export const COUNT_TYPES = ['cycle', 'full', 'narcotic', 'par', 'spot'] as const;
export const URGENCIES = ['routine', 'urgent', 'emergency'] as const;
export const PO_TYPES = [
  'standard',
  'blanket',
  'rate_contract',
  'emergency',
  'capital',
  'consignment_replenishment',
  'service',
] as const;
export const REJECT_REASONS = [
  'damaged',
  'short_supply',
  'near_expiry',
  'wrong_item',
  'quality_fail',
  'excess',
  'no_coa',
  'temperature_breach',
  'other',
] as const;
export const VENDOR_TYPES = [
  'manufacturer',
  'distributor',
  'stockist',
  'importer',
  'service_provider',
  'consignment',
  'contractor',
  'transporter',
  'other',
] as const;
export const VENDOR_ACTIONS = [
  'watch_list',
  'hold',
  'blacklist',
  'revoke',
  'show_cause',
  'improvement_notice',
  'reinstate',
] as const;
export const CONSIGNMENT_CYCLES = ['per_usage', 'weekly', 'fortnightly', 'monthly'] as const;
export const CONSUMPTION_TYPES = [
  'patient',
  'department_general',
  'derived',
  'kit',
  'bom_on_billing',
  'return',
] as const;
export const COST_CENTRE_TYPES = ['revenue', 'service', 'overhead'] as const;

export const idSchema = uuid;

/** A quantity with the unit it was counted in. Never one without the other. */
export const qtyLine = z.object({ qtyEntered: qty, uomId: uuid.optional() });

// ── item master (NC-006 §3.1) ────────────────────────────────────────────────

export const itemUomSchema = z.object({
  uomId: uuid,
  factorToBase: z.coerce.number().positive().max(1e12),
  packLevel: z.enum(PACK_LEVELS).default('inner'),
  isPurchaseDefault: z.boolean().default(false),
  isIssueDefault: z.boolean().default(false),
  isDispenseDefault: z.boolean().default(false),
  gtin: z.string().trim().min(8).max(20).optional(),
});

export const createItemSchema = z.object({
  code: code.optional(),
  name: shortText,
  shortName: z.string().trim().max(120).optional(),
  genericName: z.string().trim().max(300).optional(),
  drugKey: uuid.optional(),
  categoryId: uuid,
  itemType: z.enum(ITEM_TYPES),
  manufacturerId: uuid.optional(),
  baseUomId: uuid,
  hsnCode: z.string().trim().max(16).optional(),
  schedule: z.enum(DRUG_SCHEDULES).default('otc'),
  isNarcotic: z.boolean().default(false),
  isHighAlert: z.boolean().default(false),
  isLasa: z.boolean().default(false),
  dpcoScheduled: z.boolean().default(false),
  storageCondition: z.enum(STORAGE_CONDITIONS).default('ambient'),
  tracking: z.enum(TRACKING).default('batch_expiry'),
  minShelfLifeDays: z.coerce.number().int().min(0).max(3650).optional(),
  shelfLifeDays: z.coerce.number().int().min(0).max(3650).optional(),
  leadTimeDays: z.coerce.number().int().min(0).max(365).optional(),
  isConsignmentAllowed: z.boolean().default(false),
  isReturnable: z.boolean().default(true),
  isBillable: z.boolean().default(true),
  abcClass: z.enum(ABC_CLASSES).default('unclassified'),
  vedClass: z.enum(VED_CLASSES).default('unclassified'),
  notes: z.string().trim().max(2000).optional(),
  /**
   * The ladder, written with the item. The base rung is added automatically —
   * `inventory.enforce_item_uom` requires exactly one, with factor 1, naming the
   * item's own base unit, so there is nothing for a caller to get right here.
   */
  uoms: z.array(itemUomSchema).max(8).default([]),
});
export type CreateItemRequest = z.infer<typeof createItemSchema>;

export const updateItemSchema = z
  .object({
    name: shortText.optional(),
    shortName: z.string().trim().max(120).optional(),
    genericName: z.string().trim().max(300).optional(),
    categoryId: uuid.optional(),
    manufacturerId: uuid.optional(),
    hsnCode: z.string().trim().max(16).optional(),
    schedule: z.enum(DRUG_SCHEDULES).optional(),
    isNarcotic: z.boolean().optional(),
    isHighAlert: z.boolean().optional(),
    isLasa: z.boolean().optional(),
    storageCondition: z.enum(STORAGE_CONDITIONS).optional(),
    minShelfLifeDays: z.coerce.number().int().min(0).max(3650).optional(),
    leadTimeDays: z.coerce.number().int().min(0).max(365).optional(),
    isConsignmentAllowed: z.boolean().optional(),
    isReturnable: z.boolean().optional(),
    isBillable: z.boolean().optional(),
    abcClass: z.enum(ABC_CLASSES).optional(),
    vedClass: z.enum(VED_CLASSES).optional(),
    fsnClass: z.enum(FSN_CLASSES).optional(),
    status: z.enum(['draft', 'pending_approval', 'active', 'inactive']).optional(),
    notes: z.string().trim().max(2000).optional(),
    purchaseUomId: uuid.optional(),
    issueUomId: uuid.optional(),
    dispenseUomId: uuid.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change.' });
export type UpdateItemRequest = z.infer<typeof updateItemSchema>;

export const blockItemSchema = z.object({ reason });
export type BlockItemRequest = z.infer<typeof blockItemSchema>;

export const itemQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  itemType: z.enum(ITEM_TYPES).optional(),
  categoryId: uuid.optional(),
  schedule: z.enum(DRUG_SCHEDULES).optional(),
  status: z.enum(['draft', 'pending_approval', 'active', 'inactive', 'blocked']).optional(),
  narcoticOnly: queryFlag().optional(),
  cursor,
  limit: pageLimit,
});
export type ItemQuery = z.infer<typeof itemQuerySchema>;

export const barcodeQuerySchema = z.object({ barcode: z.string().trim().min(1).max(64) });
export type BarcodeQuery = z.infer<typeof barcodeQuerySchema>;

export const mapBarcodeSchema = z.object({
  value: z.string().trim().min(1).max(64),
  symbology: z.string().trim().max(32).default('gs1_datamatrix'),
  itemUomId: uuid.optional(),
  carriesBatchExpiry: queryFlag().default(false),
  isPrimary: queryFlag().default(false),
});
export type MapBarcodeRequest = z.infer<typeof mapBarcodeSchema>;

export const storeParamsSchema = z.object({
  minQty: z.coerce.number().min(0).default(0),
  maxQty: z.coerce.number().min(0).optional(),
  reorderLevel: z.coerce.number().min(0).optional(),
  reorderQty: z.coerce.number().min(0).optional(),
  safetyStock: z.coerce.number().min(0).optional(),
  parLevel: z.coerce.number().min(0).optional(),
  leadDays: z.coerce.number().int().min(0).max(365).optional(),
  binLocationId: uuid.optional(),
  autoIndent: z.boolean().default(false),
  isStocked: z.boolean().default(true),
  abcClass: z.enum(ABC_CLASSES).optional(),
  vedClass: z.enum(VED_CLASSES).optional(),
  fsnClass: z.enum(FSN_CLASSES).optional(),
});
export type StoreParamsRequest = z.infer<typeof storeParamsSchema>;

export const itemPriceSchema = z.object({
  priceKind: z.enum(['sale', 'purchase', 'mrp']).default('sale'),
  unitPrice: money,
  maxDiscountPct: percent.default(0),
  /** Never in the past: `inventory.refuse_retroactive_price` refuses it. */
  effectiveFrom: isoDate.optional(),
  branchId: uuid.optional(),
  reason: z.string().trim().max(1000).optional(),
});
export type ItemPriceRequest = z.infer<typeof itemPriceSchema>;

// ── stores (NC-006 §3.2) ─────────────────────────────────────────────────────

export const createStoreSchema = z.object({
  code,
  name: shortText,
  storeType: z.enum(STORE_TYPES),
  parentStoreId: uuid.optional(),
  branchId: uuid.optional(),
  custodianUserId: uuid.optional(),
  costCentreId: uuid.optional(),
  drugLicenceNo: z.string().trim().max(64).optional(),
  drugLicenceExpiry: isoDate.optional(),
  negativeStockPolicy: z.enum(['block', 'allow_with_approval']).default('block'),
  valuationMethod: z.enum(['weighted_average', 'fifo']).default('weighted_average'),
  isConsignment: z.boolean().default(false),
  holdsNarcotics: z.boolean().default(false),
  is24x7: z.boolean().default(false),
});
export type CreateStoreRequest = z.infer<typeof createStoreSchema>;

export const updateStoreSchema = z
  .object({
    name: shortText.optional(),
    custodianUserId: uuid.optional(),
    costCentreId: uuid.optional(),
    drugLicenceNo: z.string().trim().max(64).optional(),
    drugLicenceExpiry: isoDate.optional(),
    negativeStockPolicy: z.enum(['block', 'allow_with_approval']).optional(),
    valuationMethod: z.enum(['weighted_average', 'fifo']).optional(),
    holdsNarcotics: z.boolean().optional(),
    is24x7: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change.' });
export type UpdateStoreRequest = z.infer<typeof updateStoreSchema>;

export const storeQuerySchema = z.object({
  storeType: z.enum(STORE_TYPES).optional(),
  parentStoreId: uuid.optional(),
  q: z.string().trim().max(120).optional(),
  cursor,
  limit: pageLimit,
});
export type StoreQuery = z.infer<typeof storeQuerySchema>;

export const createLocationSchema = z.object({
  code: z.string().trim().min(1).max(48),
  name: z.string().trim().max(160).optional(),
  path: z.string().trim().min(1).max(512),
  isQuarantine: z.boolean().default(false),
  isExpiredHold: z.boolean().default(false),
  isControlledSafe: z.boolean().default(false),
  barcode: z.string().trim().max(64).optional(),
});
export type CreateLocationRequest = z.infer<typeof createLocationSchema>;

// ── stock reads ──────────────────────────────────────────────────────────────

export const stockQuerySchema = z.object({
  storeId: uuid.optional(),
  itemId: uuid.optional(),
  batchId: uuid.optional(),
  expiringInDays: z.coerce.number().int().min(0).max(3650).optional(),
  includeConsignment: queryFlag().default(true),
  onlyPositive: queryFlag().default(true),
  cursor,
  limit: pageLimit,
});
export type StockQuery = z.infer<typeof stockQuerySchema>;

export const ledgerQuerySchema = z.object({
  storeId: uuid.optional(),
  itemId: uuid.optional(),
  batchId: uuid.optional(),
  movementType: z.string().trim().max(32).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor,
  limit: pageLimit,
});
export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

export const batchesQuerySchema = z.object({ storeId: uuid });
export type BatchesQuery = z.infer<typeof batchesQuerySchema>;

export const quarantineSchema = z.object({
  reason: z.enum(QUARANTINE_REASONS),
  note: reason,
  scope: z.enum(['store', 'all_stores']).default('all_stores'),
  storeId: uuid.optional(),
});
export type QuarantineRequest = z.infer<typeof quarantineSchema>;

export const releaseQuarantineSchema = z.object({ decisionNote: reason });
export type ReleaseQuarantineRequest = z.infer<typeof releaseQuarantineSchema>;

export const putawaySchema = z.object({
  storeId: uuid,
  locationId: uuid,
  lines: z
    .array(z.object({ itemId: uuid, batchId: uuid.optional(), ...qtyLine.shape }))
    .min(1)
    .max(200),
});
export type PutawayRequest = z.infer<typeof putawaySchema>;

export const expiryQuerySchema = z.object({
  storeId: uuid.optional(),
  days: z.coerce.number().int().min(0).max(3650).default(90),
  cursor,
  limit: pageLimit,
});
export type ExpiryQuery = z.infer<typeof expiryQuerySchema>;

// ── store indent → issue → return (NC-006 §3.5) ──────────────────────────────

const documentLine = z.object({
  itemId: uuid,
  ...qtyLine.shape,
  remarks: z.string().trim().max(500).optional(),
});

export const createStoreIndentSchema = z.object({
  fromStoreId: uuid,
  toStoreId: uuid,
  indentType: z.enum(['regular', 'par_topup', 'emergency', 'scheduled']).default('regular'),
  requiredBy: isoDate.optional(),
  justification: z.string().trim().max(2000).optional(),
  lines: z.array(documentLine).min(1).max(200),
});
export type CreateStoreIndentRequest = z.infer<typeof createStoreIndentSchema>;

export const approveIndentSchema = z.object({
  lines: z
    .array(z.object({ lineId: uuid, qtyApprovedEntered: z.coerce.number().min(0), uomId: uuid.optional() }))
    .max(200)
    .default([]),
  note: z.string().trim().max(1000).optional(),
});
export type ApproveIndentRequest = z.infer<typeof approveIndentSchema>;

export const rejectSchema = z.object({ reason });
export type RejectRequest = z.infer<typeof rejectSchema>;

export const createIssueSchema = z.object({
  indentId: uuid.optional(),
  fromStoreId: uuid,
  toStoreId: uuid,
  gatePassNo: z.string().trim().max(48).optional(),
  remarks: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        indentLineId: uuid.optional(),
        ...qtyLine.shape,
        /** Omit to let FEFO choose; naming one is an override and needs a reason. */
        batchId: uuid.optional(),
        fefoOverrideReason: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type CreateIssueRequest = z.infer<typeof createIssueSchema>;

export const receiveIssueSchema = z.object({
  lines: z
    .array(
      z.object({
        issueLineId: uuid,
        qtyReceivedEntered: z.coerce.number().min(0),
        uomId: uuid.optional(),
        discrepancyReason: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type ReceiveIssueRequest = z.infer<typeof receiveIssueSchema>;

export const createReturnToStoreSchema = z.object({
  fromStoreId: uuid,
  toStoreId: uuid,
  reason: z.string().trim().min(2).max(48),
  remarks: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        batchId: uuid.optional(),
        ...qtyLine.shape,
        condition: z.enum(['good', 'damaged', 'opened', 'expired', 'temperature_breach']).default('good'),
      }),
    )
    .min(1)
    .max(200),
});
export type CreateReturnToStoreRequest = z.infer<typeof createReturnToStoreSchema>;

export const inspectReturnSchema = z.object({
  lines: z
    .array(z.object({ lineId: uuid, restock: z.boolean() }))
    .min(1)
    .max(200),
  remarks: z.string().trim().max(1000).optional(),
});
export type InspectReturnRequest = z.infer<typeof inspectReturnSchema>;

// ── adjustments and counts ───────────────────────────────────────────────────

export const createAdjustmentSchema = z.object({
  storeId: uuid,
  adjustmentType: z.enum(ADJUSTMENT_TYPES),
  reasonCode: z.string().trim().min(2).max(48),
  reason,
  countPlanId: uuid.optional(),
  bmwDisposalRef: z.string().trim().max(64).optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        batchId: uuid.optional(),
        ...qtyLine.shape,
        lineReason: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type CreateAdjustmentRequest = z.infer<typeof createAdjustmentSchema>;

export const approveAdjustmentSchema = z.object({ note: z.string().trim().max(1000).optional() });
export type ApproveAdjustmentRequest = z.infer<typeof approveAdjustmentSchema>;

export const adjustmentQuerySchema = z.object({
  storeId: uuid.optional(),
  status: z.enum(['draft', 'pending_approval', 'approved', 'posted', 'rejected', 'cancelled']).optional(),
  cursor,
  limit: pageLimit,
});
export type AdjustmentQuery = z.infer<typeof adjustmentQuerySchema>;

export const createCountPlanSchema = z.object({
  storeId: uuid,
  countType: z.enum(COUNT_TYPES),
  scheduledFor: isoDate,
  blind: z.boolean().default(true),
  freezeMovements: z.boolean().default(true),
  itemIds: z.array(uuid).max(2000).default([]),
  assignedTo: uuid.optional(),
  secondCounterId: uuid.optional(),
});
export type CreateCountPlanRequest = z.infer<typeof createCountPlanSchema>;

export const countLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: uuid,
        countedEntered: z.coerce.number().min(0),
        uomId: uuid.optional(),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type CountLinesRequest = z.infer<typeof countLinesSchema>;

export const approveCountSchema = z.object({ reason, postAdjustment: z.boolean().default(true) });
export type ApproveCountRequest = z.infer<typeof approveCountSchema>;

export const countQuerySchema = z.object({
  storeId: uuid.optional(),
  status: z.string().trim().max(24).optional(),
  cursor,
  limit: pageLimit,
});
export type CountQuery = z.infer<typeof countQuerySchema>;

// ── transfers (NC-006 §3.6) ──────────────────────────────────────────────────

export const createTransferSchema = z.object({
  fromStoreId: uuid,
  toStoreId: uuid,
  toBranchId: uuid.optional(),
  remarks: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        batchId: uuid.optional(),
        ...qtyLine.shape,
      }),
    )
    .min(1)
    .max(200),
});
export type CreateTransferRequest = z.infer<typeof createTransferSchema>;

export const dispatchTransferSchema = z.object({
  gatePassNo: z.string().trim().max(48).optional(),
  ewayBillNo: z.string().trim().max(24).optional(),
  taxInvoiceNo: z.string().trim().max(48).optional(),
});
export type DispatchTransferRequest = z.infer<typeof dispatchTransferSchema>;

export const receiveTransferSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: uuid,
        qtyReceivedEntered: z.coerce.number().min(0),
        uomId: uuid.optional(),
        discrepancyReason: z.string().trim().max(500).optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type ReceiveTransferRequest = z.infer<typeof receiveTransferSchema>;

export const transferQuerySchema = z.object({
  fromStoreId: uuid.optional(),
  toStoreId: uuid.optional(),
  status: z.string().trim().max(24).optional(),
  cursor,
  limit: pageLimit,
});
export type TransferQuery = z.infer<typeof transferQuerySchema>;

// ── vendors (NC-021) ─────────────────────────────────────────────────────────

export const createVendorSchema = z.object({
  vendorCode: code.optional(),
  legalName: shortText,
  tradeName: z.string().trim().max(300).optional(),
  vendorType: z.enum(VENDOR_TYPES),
  categories: z.array(z.string().trim().max(48)).max(24).default([]),
  /** Validated for shape here; verification against the PAN service is EN-036. */
  pan: z
    .string()
    .trim()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'A PAN is five letters, four digits and a letter')
    .optional(),
  gstin: z
    .string()
    .trim()
    .regex(
      /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Zz][0-9A-Z]$/,
      'A GSTIN is 15 characters: state code, PAN, entity code, Z and a checksum',
    )
    .optional(),
  gstType: z
    .enum(['regular', 'composition', 'unregistered', 'sez', 'overseas', 'government'])
    .default('regular'),
  drugLicenceNo: z.string().trim().max(64).optional(),
  drugLicenceValidTo: isoDate.optional(),
  creditDays: z.coerce.number().int().min(0).max(365).default(30),
  leadTimeDaysAvg: z.coerce.number().int().min(0).max(365).optional(),
  relatedParty: z.boolean().default(false),
  notes: z.string().trim().max(2000).optional(),
});
export type CreateVendorRequest = z.infer<typeof createVendorSchema>;

export const updateVendorSchema = z
  .object({
    legalName: shortText.optional(),
    tradeName: z.string().trim().max(300).optional(),
    categories: z.array(z.string().trim().max(48)).max(24).optional(),
    drugLicenceNo: z.string().trim().max(64).optional(),
    drugLicenceValidTo: isoDate.optional(),
    creditDays: z.coerce.number().int().min(0).max(365).optional(),
    leadTimeDaysAvg: z.coerce.number().int().min(0).max(365).optional(),
    riskRating: z.enum(['low', 'medium', 'high']).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change.' });
export type UpdateVendorRequest = z.infer<typeof updateVendorSchema>;

export const vendorQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  status: z
    .enum(['draft', 'pending_approval', 'approved', 'hold', 'watch_list', 'blacklisted', 'inactive'])
    .optional(),
  vendorType: z.enum(VENDOR_TYPES).optional(),
  cursor,
  limit: pageLimit,
});
export type VendorQuery = z.infer<typeof vendorQuerySchema>;

export const approveVendorSchema = z.object({ note: z.string().trim().max(1000).optional() });
export type ApproveVendorRequest = z.infer<typeof approveVendorSchema>;

export const vendorItemSchema = z.object({
  itemId: uuid,
  vendorItemCode: z.string().trim().max(64).optional(),
  brand: z.string().trim().max(200).optional(),
  preferredRank: z.coerce.number().int().min(1).max(20).default(1),
  leadTimeDays: z.coerce.number().int().min(0).max(365).optional(),
  moq: z.coerce.number().min(0).optional(),
  moqUomId: uuid.optional(),
  lastPrice: money.optional(),
});
export type VendorItemRequest = z.infer<typeof vendorItemSchema>;

export const rateContractSchema = z.object({
  contractNo: z.string().trim().min(1).max(48),
  title: shortText,
  validFrom: isoDate,
  validTo: isoDate,
  maxValue: money.optional(),
  deliverySlaDays: z.coerce.number().int().min(0).max(365).optional(),
  minShelfLifePct: percent.optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        uomId: uuid,
        rate: money,
        discountPct: percent.default(0),
        hsnCode: z.string().trim().max(16).optional(),
        moq: z.coerce.number().min(0).optional(),
        validFrom: isoDate.optional(),
        validTo: isoDate.optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type RateContractRequest = z.infer<typeof rateContractSchema>;

export const vendorActionSchema = z.object({
  action: z.enum(VENDOR_ACTIONS),
  reasonCategory: z.string().trim().min(2).max(48),
  reason,
  effectiveFrom: isoDate.optional(),
  effectiveTo: isoDate.optional(),
  responseDueAt: z.string().datetime({ offset: true }).optional(),
});
export type VendorActionRequest = z.infer<typeof vendorActionSchema>;

// ── purchase to pay (NC-005) ─────────────────────────────────────────────────

export const createPurchaseIndentSchema = z.object({
  storeId: uuid,
  urgency: z.enum(URGENCIES).default('routine'),
  requiredBy: isoDate.optional(),
  justification: z.string().trim().max(2000).optional(),
  costCentreId: uuid.optional(),
  source: z.enum(['manual', 'auto_reorder', 'consignment', 'project', 'emergency']).default('manual'),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        ...qtyLine.shape,
        specs: z.string().trim().max(1000).optional(),
        lastPrice: money.optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type CreatePurchaseIndentRequest = z.infer<typeof createPurchaseIndentSchema>;

export const purchaseIndentQuerySchema = z.object({
  storeId: uuid.optional(),
  status: z.string().trim().max(32).optional(),
  urgency: z.enum(URGENCIES).optional(),
  cursor,
  limit: pageLimit,
});
export type PurchaseIndentQuery = z.infer<typeof purchaseIndentQuerySchema>;

export const createRfqSchema = z.object({
  title: shortText,
  dueAt: z.string().datetime({ offset: true }),
  vendorIds: z.array(uuid).min(1).max(50),
  indentIds: z.array(uuid).max(50).default([]),
  sealed: z.boolean().default(false),
  lines: z
    .array(z.object({ itemId: uuid, ...qtyLine.shape, specs: z.string().trim().max(1000).optional() }))
    .min(1)
    .max(200),
});
export type CreateRfqRequest = z.infer<typeof createRfqSchema>;

export const rfqQuerySchema = z.object({
  status: z.enum(['draft', 'sent', 'closed', 'awarded', 'cancelled']).optional(),
  cursor,
  limit: pageLimit,
});
export type RfqQuery = z.infer<typeof rfqQuerySchema>;

export const enterQuotationSchema = z.object({
  vendorId: uuid,
  quoteNo: z.string().trim().min(1).max(64),
  quoteDate: isoDate,
  validTill: isoDate.optional(),
  deliveryDays: z.coerce.number().int().min(0).max(365).optional(),
  paymentTerms: z.string().trim().max(200).optional(),
  freight: money.default(0),
  lines: z
    .array(
      z.object({
        rfqLineId: uuid,
        unitPrice: money,
        uomId: uuid.optional(),
        discountPct: percent.default(0),
        gstRate: percent.default(0),
        freeQty: z.coerce.number().min(0).default(0),
        brand: z.string().trim().max(200).optional(),
        techScore: z.coerce.number().min(0).max(100).optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type EnterQuotationRequest = z.infer<typeof enterQuotationSchema>;

export const approveComparativeSchema = z.object({
  selections: z
    .array(
      z.object({
        rfqLineId: uuid,
        quotationLineId: uuid,
        justification: z.string().trim().max(1000).optional(),
      }),
    )
    .min(1)
    .max(200),
  note: z.string().trim().max(1000).optional(),
});
export type ApproveComparativeRequest = z.infer<typeof approveComparativeSchema>;

export const createPoSchema = z.object({
  vendorId: uuid,
  shipToStoreId: uuid,
  poType: z.enum(PO_TYPES).default('standard'),
  rfqId: uuid.optional(),
  rateContractId: uuid.optional(),
  indentIds: z.array(uuid).max(50).default([]),
  expectedDelivery: isoDate.optional(),
  paymentTerms: z.string().trim().max(200).optional(),
  deliveryTerms: z.string().trim().max(200).optional(),
  tolerancePct: percent.default(0),
  freight: money.default(0),
  otherCharges: money.default(0),
  budgetLineRef: z.string().trim().max(64).optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        ...qtyLine.shape,
        /** Omit to take the vendor's live rate contract, if one covers this item. */
        rate: money.optional(),
        discountPct: percent.default(0),
        gstRate: percent.optional(),
        hsnCode: z.string().trim().max(16).optional(),
        freeQtyBase: z.coerce.number().min(0).default(0),
        minShelfLifeDays: z.coerce.number().int().min(0).max(3650).optional(),
        indentLineId: uuid.optional(),
        description: z.string().trim().max(300).optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type CreatePoRequest = z.infer<typeof createPoSchema>;

export const poQuerySchema = z.object({
  vendorId: uuid.optional(),
  storeId: uuid.optional(),
  status: z.string().trim().max(32).optional(),
  cursor,
  limit: pageLimit,
});
export type PoQuery = z.infer<typeof poQuerySchema>;

export const approvePoSchema = z.object({ note: z.string().trim().max(1000).optional() });
export type ApprovePoRequest = z.infer<typeof approvePoSchema>;

export const sendPoSchema = z.object({
  channel: z.enum(['email', 'portal', 'print', 'edi']).default('email'),
});
export type SendPoRequest = z.infer<typeof sendPoSchema>;

export const amendPoSchema = z.object({
  reason,
  lines: z
    .array(
      z.object({
        itemId: uuid,
        ...qtyLine.shape,
        rate: money,
        discountPct: percent.default(0),
        gstRate: percent.optional(),
        hsnCode: z.string().trim().max(16).optional(),
      }),
    )
    .min(1)
    .max(200),
  expectedDelivery: isoDate.optional(),
});
export type AmendPoRequest = z.infer<typeof amendPoSchema>;

export const closePoSchema = z.object({ reason });
export type ClosePoRequest = z.infer<typeof closePoSchema>;

export const createGrnSchema = z.object({
  poId: uuid.optional(),
  vendorId: uuid,
  storeId: uuid,
  invoiceNo: z.string().trim().max(64).optional(),
  invoiceDate: isoDate.optional(),
  dcNo: z.string().trim().max(64).optional(),
  ewayBillNo: z.string().trim().max(24).optional(),
  withoutPo: z.boolean().default(false),
  remarks: z.string().trim().max(1000).optional(),
  lines: z
    .array(
      z.object({
        poLineId: uuid.optional(),
        itemId: uuid,
        ...qtyLine.shape,
        qtyRejectedEntered: z.coerce.number().min(0).default(0),
        rejectReason: z.enum(REJECT_REASONS).optional(),
        rejectNote: z.string().trim().max(500).optional(),
        batchNo: z.string().trim().max(64).optional(),
        mfgDate: isoDate.optional(),
        expiryDate: isoDate.optional(),
        mrp: money.optional(),
        unitCost: money,
        hsnCode: z.string().trim().max(16).optional(),
        gstRate: percent.default(0),
        freeQtyBase: z.coerce.number().min(0).default(0),
        serials: z
          .array(z.object({ serialNo: z.string().trim().max(96), udi: z.string().max(256).optional() }))
          .max(500)
          .default([]),
        quarantine: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(200),
});
export type CreateGrnRequest = z.infer<typeof createGrnSchema>;

export const grnQcSchema = z.object({
  outcome: z.enum(['accepted', 'partially_accepted', 'rejected']),
  notes: z.string().trim().max(2000).optional(),
});
export type GrnQcRequest = z.infer<typeof grnQcSchema>;

export const grnQuerySchema = z.object({
  vendorId: uuid.optional(),
  storeId: uuid.optional(),
  poId: uuid.optional(),
  status: z.string().trim().max(32).optional(),
  cursor,
  limit: pageLimit,
});
export type GrnQuery = z.infer<typeof grnQuerySchema>;

export const purchaseReturnSchema = z.object({
  vendorId: uuid,
  storeId: uuid,
  grnId: uuid.optional(),
  reason: z.string().trim().min(2).max(48),
  reasonNote: z.string().trim().max(1000).optional(),
  debitNoteNo: z.string().trim().max(48).optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        batchId: uuid.optional(),
        ...qtyLine.shape,
        unitCost: money.optional(),
        gstRate: percent.default(0),
      }),
    )
    .min(1)
    .max(200),
});
export type PurchaseReturnRequest = z.infer<typeof purchaseReturnSchema>;

export const captureInvoiceSchema = z.object({
  vendorId: uuid,
  invoiceNo: z.string().trim().min(1).max(64),
  invoiceDate: isoDate,
  poId: uuid.optional(),
  grnIds: z.array(uuid).max(50).default([]),
  gstin: z.string().trim().max(15).optional(),
  irn: z.string().trim().max(64).optional(),
  subtotal: money,
  taxTotal: money.default(0),
  total: money,
  lines: z
    .array(
      z.object({
        itemId: uuid,
        poLineId: uuid.optional(),
        grnLineId: uuid.optional(),
        uomId: uuid.optional(),
        qtyEntered: qty,
        ratePerBase: money,
        tax: money.default(0),
      }),
    )
    .min(1)
    .max(200),
});
export type CaptureInvoiceRequest = z.infer<typeof captureInvoiceSchema>;

export const invoiceQuerySchema = z.object({
  vendorId: uuid.optional(),
  matchStatus: z.string().trim().max(32).optional(),
  exceptionsOnly: queryFlag().default(false),
  cursor,
  limit: pageLimit,
});
export type InvoiceQuery = z.infer<typeof invoiceQuerySchema>;

export const approveInvoiceSchema = z.object({
  note: z.string().trim().max(1000).optional(),
  dueDate: isoDate.optional(),
});
export type ApproveInvoiceRequest = z.infer<typeof approveInvoiceSchema>;

export const disputeInvoiceSchema = z.object({ reason });
export type DisputeInvoiceRequest = z.infer<typeof disputeInvoiceSchema>;

export const emergencyPurchaseSchema = z.object({
  reason,
  clinicalJustification: z.string().trim().max(2000).optional(),
  vendorId: uuid.optional(),
  amount: money.optional(),
  capAmount: money.optional(),
  indentId: uuid.optional(),
});
export type EmergencyPurchaseRequest = z.infer<typeof emergencyPurchaseSchema>;

// ── consignment (NC-007) ─────────────────────────────────────────────────────

export const consignmentAgreementSchema = z.object({
  vendorId: uuid,
  agreementNo: z.string().trim().min(1).max(48),
  startDate: isoDate,
  endDate: isoDate,
  invoicingCycle: z.enum(CONSIGNMENT_CYCLES).default('per_usage'),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(45),
  expiryReturnDaysBefore: z.coerce.number().int().min(0).max(365).default(90),
  replenishmentSlaDays: z.coerce.number().int().min(0).max(90).default(3),
  wastagePolicy: z.enum(['hospital', 'vendor', 'case_by_case']).default('case_by_case'),
  items: z
    .array(
      z.object({
        itemId: uuid,
        vendorPrice: money,
        mrp: money.optional(),
        gstRate: percent.default(0),
        minStockBase: z.coerce.number().min(0).default(0),
        udiDi: z.string().trim().max(32).optional(),
        gtin: z.string().trim().max(20).optional(),
        priceValidFrom: isoDate.optional(),
      }),
    )
    .min(1)
    .max(500),
});
export type ConsignmentAgreementRequest = z.infer<typeof consignmentAgreementSchema>;

export const consignmentReceiptSchema = z.object({
  agreementId: uuid,
  storeId: uuid,
  challanNo: z.string().trim().max(64).optional(),
  challanDate: isoDate.optional(),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        ...qtyLine.shape,
        lotNo: z.string().trim().max(64),
        expiryDate: isoDate.optional(),
        gtin: z.string().trim().max(20).optional(),
        serialNo: z.string().trim().max(96).optional(),
        udiFull: z.string().trim().max(256).optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type ConsignmentReceiptRequest = z.infer<typeof consignmentReceiptSchema>;

export const consignmentUsageSchema = z.object({
  agreementId: uuid,
  storeId: uuid,
  itemId: uuid,
  batchId: uuid,
  serialId: uuid.optional(),
  ...qtyLine.shape,
  patientId: uuid.optional(),
  encounterId: uuid.optional(),
  surgeonUserId: uuid.optional(),
  side: z.enum(['left', 'right', 'bilateral', 'not_applicable']).optional(),
  site: z.string().trim().max(96).optional(),
  status: z.enum(['used', 'wasted']).default('used'),
  wasteReason: z.string().trim().max(1000).optional(),
  wasteLiability: z.enum(['hospital', 'vendor', 'pending']).default('pending'),
});
export type ConsignmentUsageRequest = z.infer<typeof consignmentUsageSchema>;

export const consignmentUsageQuerySchema = z.object({
  agreementId: uuid.optional(),
  vendorId: uuid.optional(),
  patientId: uuid.optional(),
  status: z.enum(['used', 'wasted', 'reversed']).optional(),
  cursor,
  limit: pageLimit,
});
export type ConsignmentUsageQuery = z.infer<typeof consignmentUsageQuerySchema>;

export const reverseSchema = z.object({ reason });
export type ReverseRequest = z.infer<typeof reverseSchema>;

export const consignmentReturnSchema = z.object({
  agreementId: uuid,
  vendorId: uuid,
  storeId: uuid,
  reason: z.enum(['near_expiry', 'expired', 'excess', 'recall', 'agreement_end', 'damaged']),
  lines: z
    .array(z.object({ itemId: uuid, batchId: uuid, ...qtyLine.shape }))
    .min(1)
    .max(200),
});
export type ConsignmentReturnRequest = z.infer<typeof consignmentReturnSchema>;

export const consignmentReconciliationSchema = z.object({
  vendorId: uuid,
  agreementId: uuid,
  period: z.string().regex(/^\d{4}-\d{2}$/, 'A period is YYYY-MM'),
});
export type ConsignmentReconciliationRequest = z.infer<typeof consignmentReconciliationSchema>;

export const signReconciliationSchema = z.object({
  vendorSignedBy: z.string().trim().min(1).max(200),
  agreed: z.boolean(),
  note: z.string().trim().max(1000).optional(),
});
export type SignReconciliationRequest = z.infer<typeof signReconciliationSchema>;

// ── consumption and cost centres (NC-008) ────────────────────────────────────

export const recordConsumptionSchema = z.object({
  storeId: uuid,
  entryType: z.enum(CONSUMPTION_TYPES),
  costCentreId: uuid.optional(),
  patientId: uuid.optional(),
  encounterId: uuid.optional(),
  performedBy: uuid.optional(),
  source: z.enum(['manual_scan', 'kit', 'bom', 'auto_billing', 'import']).default('manual_scan'),
  lines: z
    .array(
      z.object({
        itemId: uuid,
        batchId: uuid.optional(),
        ...qtyLine.shape,
        isBillable: z.boolean().optional(),
        expenseHead: z.string().trim().max(48).optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type RecordConsumptionRequest = z.infer<typeof recordConsumptionSchema>;

export const consumptionQuerySchema = z.object({
  storeId: uuid.optional(),
  costCentreId: uuid.optional(),
  patientId: uuid.optional(),
  entryType: z.enum(CONSUMPTION_TYPES).optional(),
  cursor,
  limit: pageLimit,
});
export type ConsumptionQuery = z.infer<typeof consumptionQuerySchema>;

export const costCentreSchema = z.object({
  code,
  name: shortText,
  centreType: z.enum(COST_CENTRE_TYPES),
  parentId: uuid.optional(),
  branchId: uuid.optional(),
  ownerUserId: uuid.optional(),
  allocationBasis: z
    .enum(['none', 'bed_days', 'sqft', 'headcount', 'tests', 'weight_kg', 'patient_days', 'manual'])
    .default('none'),
});
export type CostCentreRequest = z.infer<typeof costCentreSchema>;

export const costCentreQuerySchema = z.object({
  centreType: z.enum(COST_CENTRE_TYPES).optional(),
  cursor,
  limit: pageLimit,
});
export type CostCentreQuery = z.infer<typeof costCentreQuerySchema>;
