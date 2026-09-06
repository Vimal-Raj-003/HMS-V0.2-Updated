/**
 * The shapes NC-005, NC-006 and NC-021 return, mirrored from
 * `services/api/src/modules/inventory/inventory.types.ts`.
 *
 * Hand-written here rather than imported for the reason the API's own file gives
 * for not deriving its views from its row types: a view is a contract, and a
 * contract that follows a table follows every column somebody adds to it.
 * `packages/contracts` does not yet publish the Phase-4 views and `packages/*`
 * is outside this change's remit, so this is the client's half of that contract
 * and is reported as a gap.
 *
 * Money and quantity are decimal **strings** throughout. `numeric(18,4)` through
 * IEEE-754 and back is not the number that was stored, and a stock ledger that
 * rounds is a stock ledger that does not reconcile.
 */

export interface ItemUomView {
  readonly uomId: string;
  readonly code: string;
  readonly name: string;
  readonly packLevel: string;
  readonly factorToBase: string;
  readonly isBase: boolean;
  readonly gtin: string | null;
}

export interface ItemView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly shortName: string | null;
  readonly genericName: string | null;
  readonly drugKey: string | null;
  readonly categoryId: string;
  readonly itemType: string;
  readonly manufacturerId: string | null;
  readonly baseUomId: string;
  readonly purchaseUomId: string | null;
  readonly issueUomId: string | null;
  readonly dispenseUomId: string | null;
  readonly hsnCode: string | null;
  readonly schedule: string;
  readonly isNarcotic: boolean;
  readonly isHighAlert: boolean;
  readonly isLasa: boolean;
  readonly dpcoScheduled: boolean;
  readonly storageCondition: string;
  readonly tracking: string;
  readonly minShelfLifeDays: number | null;
  readonly shelfLifeDays: number | null;
  readonly leadTimeDays: number | null;
  readonly isConsignmentAllowed: boolean;
  readonly isReturnable: boolean;
  readonly isBillable: boolean;
  readonly abcClass: string;
  readonly vedClass: string;
  readonly fsnClass: string;
  readonly status: string;
  readonly notes: string | null;
  readonly uoms: readonly ItemUomView[];
}

export interface ScanResolution {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly schedule: string;
  readonly isNarcotic: boolean;
  readonly tracking: string;
  readonly uomId: string;
  readonly batchId: string | null;
  readonly batchNo: string | null;
  readonly batchStatus: string | null;
  readonly expiryDate: string | null;
  readonly serialNo: string | null;
  readonly source: 'barcode_map' | 'gtin' | 'item_code';
}

export interface SubstituteView {
  readonly itemId: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly isPreferred: boolean;
  readonly requiresPrescriberApproval: boolean;
  readonly equivalenceFactor: string;
}

export interface StoreView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly storeType: string;
  readonly branchId: string;
  readonly parentStoreId: string | null;
  readonly custodianUserId: string | null;
  readonly costCentreId: string | null;
  readonly drugLicenceNo: string | null;
  readonly drugLicenceExpiry: string | null;
  readonly negativeStockPolicy: string;
  readonly valuationMethod: string;
  readonly isConsignment: boolean;
  readonly holdsNarcotics: boolean;
  readonly is24x7: boolean;
  readonly active: boolean;
}

export interface StoreLocationView {
  readonly id: string;
  readonly storeId: string;
  readonly code: string;
  readonly name: string | null;
  readonly path: string;
  readonly isQuarantine: boolean;
  readonly isExpiredHold: boolean;
  readonly isControlledSafe: boolean;
  readonly barcode: string | null;
  readonly active: boolean;
}

export interface StockBalanceView {
  readonly id: string;
  readonly storeId: string;
  readonly locationId: string | null;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly batchId: string | null;
  readonly batchNo: string | null;
  readonly expiryDate: string | null;
  readonly qtyOnHand: string;
  readonly qtyReserved: string;
  readonly qtyAvailable: string;
  readonly avgCost: string;
  readonly value: string;
  readonly isConsignment: boolean;
  readonly uomId: string;
  readonly lastMovementAt: string | null;
}

export interface LedgerEntryView {
  readonly id: string;
  readonly storeId: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly batchId: string | null;
  readonly batchNo: string | null;
  readonly movementType: string;
  readonly qtyBase: string;
  readonly qtyEntered: string;
  readonly uomId: string;
  readonly unitCost: string | null;
  readonly value: string | null;
  readonly refType: string;
  readonly refId: string;
  readonly correctsLedgerId: string | null;
  readonly reason: string | null;
  readonly isConsignment: boolean;
  readonly actorId: string | null;
  readonly secondActorId: string | null;
  readonly movedAt: string;
}

export interface FefoBatchView {
  readonly batchId: string;
  readonly batchNo: string;
  readonly expiryDate: string | null;
  readonly qtyAvailable: string;
  readonly unitCost: string | null;
  readonly mrp: string | null;
  readonly isConsignment: boolean;
}

export interface AvailabilityRow {
  readonly storeId: string;
  readonly storeCode: string;
  readonly storeName: string;
  readonly qtyAvailable: string;
  readonly batchCount: number;
  readonly earliestExpiry: string | null;
}

/**
 * A line of any store or purchase document.
 *
 * `extra` is the API's own escape hatch — approved quantities, rates, batch
 * numbers, rejection reasons — and it is typed as a record of scalars rather
 * than `unknown` so a screen can render it without an `any` and without
 * pretending to know more than the API said.
 */
export interface DocumentLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly batchId: string | null;
  readonly batchNo: string | null;
  readonly uomId: string;
  readonly qtyEntered: string;
  readonly qtyBase: string;
  readonly status: string | null;
  readonly extra: Readonly<Record<string, string | number | boolean | null>>;
}

export interface DocumentView {
  readonly id: string;
  readonly documentNo: string;
  readonly status: string;
  readonly storeId: string | null;
  readonly counterpartyId: string | null;
  readonly createdAt: string;
  readonly lines: readonly DocumentLineView[];
  readonly header: Readonly<Record<string, string | number | boolean | null>>;
}

export interface VendorView {
  readonly id: string;
  readonly vendorCode: string;
  readonly legalName: string;
  readonly tradeName: string | null;
  readonly vendorType: string;
  readonly categories: readonly string[];
  readonly panMasked: string | null;
  readonly gstType: string;
  readonly primaryGstin: string | null;
  readonly drugLicenceNo: string | null;
  readonly drugLicenceValidTo: string | null;
  readonly creditDays: number;
  readonly leadTimeDaysAvg: number | null;
  readonly riskRating: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly blacklistedUntil: string | null;
  readonly lastScore: string | null;
  readonly notes: string | null;
}

export interface RateContractView {
  readonly id: string;
  readonly contractNo: string;
  readonly vendorId: string;
  readonly title: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly status: string;
  readonly lineCount: number;
  readonly maxValue: string | null;
}

export interface ComparativeQuote {
  readonly quotationLineId: string;
  readonly quotationId: string;
  readonly vendorId: string;
  readonly vendorName: string;
  readonly brand: string | null;
  readonly unitPrice: string;
  readonly discountPct: string;
  readonly gstRate: string;
  readonly landedUnitCostBase: string;
  readonly deliveryDays: number | null;
  readonly techScore: string | null;
  readonly isL1: boolean;
  readonly selected: boolean;
}

export interface ComparativeView {
  readonly rfqId: string;
  readonly generatedAt: string;
  readonly lines: readonly {
    readonly rfqLineId: string;
    readonly itemId: string;
    readonly itemCode: string;
    readonly itemName: string;
    readonly qtyBase: string;
    readonly quotes: readonly ComparativeQuote[];
  }[];
}

export interface InvoiceMatchLine {
  readonly id: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly status: string;
  readonly invQtyBase: string;
  readonly grnQtyBase: string;
  readonly poQtyBase: string;
  readonly qtyDiffBase: string;
  readonly rateDiff: string;
  readonly taxDiff: string;
  readonly withinTolerance: boolean;
}

export interface InvoiceMatchView {
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly vendorId: string;
  readonly matchStatus: string;
  readonly total: string;
  readonly lines: readonly InvoiceMatchLine[];
}

export interface IntegrityRow {
  readonly storeId: string;
  readonly itemId: string;
  readonly batchId: string | null;
  readonly ledgerSum: string;
  readonly balanceQty: string;
  readonly difference: string;
}

export interface BatchTraceView {
  readonly batch: {
    readonly id: string;
    readonly batchNo: string;
    readonly itemId: string;
    readonly itemCode: string;
    readonly expiryDate: string | null;
    readonly status: string;
  };
  readonly movements: readonly LedgerEntryView[];
  readonly patients: readonly {
    readonly patientId: string;
    readonly qtyBase: string;
    readonly lastAt: string;
  }[];
  readonly stores: readonly { readonly storeId: string; readonly qtyOnHand: string }[];
}

// ── request bodies ───────────────────────────────────────────────────────────

/** Every quantity carries its unit. Omitting `uomId` means the item's base unit. */
export interface QtyLine {
  readonly qtyEntered: number;
  readonly uomId?: string;
}

export interface CreateStoreIndentRequest {
  readonly fromStoreId: string;
  readonly toStoreId: string;
  readonly indentType: 'regular' | 'par_topup' | 'emergency' | 'scheduled';
  readonly requiredBy?: string;
  readonly justification?: string;
  readonly lines: readonly (QtyLine & { readonly itemId: string; readonly remarks?: string })[];
}

export interface ApproveIndentRequest {
  readonly lines: readonly {
    readonly lineId: string;
    readonly qtyApprovedEntered: number;
    readonly uomId?: string;
  }[];
  readonly note?: string;
}

export interface CreateIssueRequest {
  readonly indentId?: string;
  readonly fromStoreId: string;
  readonly toStoreId: string;
  readonly gatePassNo?: string;
  readonly remarks?: string;
  readonly lines: readonly (QtyLine & {
    readonly itemId: string;
    readonly indentLineId?: string;
    /** Omit to let FEFO choose. Naming one is an override and needs a reason. */
    readonly batchId?: string;
    readonly fefoOverrideReason?: string;
  })[];
}

export interface ReceiveLinesRequest {
  readonly lines: readonly {
    readonly lineId: string;
    readonly qtyReceivedEntered: number;
    readonly uomId?: string;
    readonly discrepancyReason?: string;
  }[];
}

export interface ReceiveIssueRequest {
  readonly lines: readonly {
    readonly issueLineId: string;
    readonly qtyReceivedEntered: number;
    readonly uomId?: string;
    readonly discrepancyReason?: string;
  }[];
}

export interface CreateTransferRequest {
  readonly fromStoreId: string;
  readonly toStoreId: string;
  readonly toBranchId?: string;
  readonly remarks?: string;
  readonly lines: readonly (QtyLine & { readonly itemId: string; readonly batchId?: string })[];
}

export interface DispatchTransferRequest {
  readonly gatePassNo?: string;
  readonly ewayBillNo?: string;
  readonly taxInvoiceNo?: string;
}

export type AdjustmentType =
  | 'plus'
  | 'minus'
  | 'writeoff_expiry'
  | 'writeoff_damage'
  | 'writeoff_recall'
  | 'repack'
  | 'opening'
  | 'donation'
  | 'sample'
  | 'count_variance';

export interface CreateAdjustmentRequest {
  readonly storeId: string;
  readonly adjustmentType: AdjustmentType;
  readonly reasonCode: string;
  readonly reason: string;
  readonly countPlanId?: string;
  readonly bmwDisposalRef?: string;
  readonly lines: readonly (QtyLine & {
    readonly itemId: string;
    readonly batchId?: string;
    readonly lineReason?: string;
  })[];
}

export interface CreateCountPlanRequest {
  readonly storeId: string;
  readonly countType: 'cycle' | 'full' | 'narcotic' | 'par' | 'spot';
  readonly scheduledFor: string;
  readonly blind: boolean;
  readonly freezeMovements: boolean;
  readonly itemIds?: readonly string[];
  readonly assignedTo?: string;
  readonly secondCounterId?: string;
}

export interface CountLinesRequest {
  readonly lines: readonly {
    readonly lineId: string;
    readonly countedEntered: number;
    readonly uomId?: string;
    readonly reason?: string;
  }[];
}

export interface ApproveCountRequest {
  readonly reason: string;
  readonly postAdjustment: boolean;
}

export interface CreatePurchaseIndentRequest {
  readonly storeId: string;
  readonly urgency: 'routine' | 'urgent' | 'emergency';
  readonly requiredBy?: string;
  readonly justification?: string;
  readonly lines: readonly (QtyLine & { readonly itemId: string; readonly specs?: string })[];
}

export interface CreatePoRequest {
  readonly vendorId: string;
  /** The API calls this `shipToStoreId`: a PO delivers somewhere specific. */
  readonly shipToStoreId: string;
  readonly poType: string;
  readonly rfqId?: string;
  readonly indentIds?: readonly string[];
  readonly expectedDelivery?: string;
  readonly paymentTerms?: string;
  readonly tolerancePct?: number;
  readonly lines: readonly (QtyLine & {
    readonly itemId: string;
    /** Omit to take the vendor's live rate contract, if one covers this item. */
    readonly rate?: number;
    readonly discountPct?: number;
    readonly gstRate?: number;
    readonly hsnCode?: string;
    readonly indentLineId?: string;
  })[];
}

export interface GrnLineInput {
  readonly poLineId?: string;
  readonly itemId: string;
  readonly qtyEntered: number;
  readonly uomId?: string;
  readonly qtyRejectedEntered?: number;
  readonly rejectReason?: string;
  readonly rejectNote?: string;
  readonly batchNo?: string;
  readonly mfgDate?: string;
  readonly expiryDate?: string;
  readonly mrp?: number;
  readonly unitCost: number;
  readonly hsnCode?: string;
  readonly gstRate?: number;
  readonly freeQtyBase?: number;
  readonly serials?: readonly { readonly serialNo: string; readonly udi?: string }[];
  readonly quarantine?: boolean;
}

export interface CreateGrnRequest {
  readonly poId?: string;
  readonly vendorId: string;
  readonly storeId: string;
  readonly invoiceNo?: string;
  readonly invoiceDate?: string;
  readonly dcNo?: string;
  readonly withoutPo?: boolean;
  readonly remarks?: string;
  readonly lines: readonly GrnLineInput[];
}

export interface CaptureInvoiceRequest {
  readonly vendorId: string;
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly poId?: string;
  readonly grnIds?: readonly string[];
  readonly gstin?: string;
  readonly subtotal: number;
  readonly taxTotal?: number;
  readonly total: number;
  readonly lines: readonly {
    readonly itemId: string;
    readonly poLineId?: string;
    readonly grnLineId?: string;
    readonly uomId?: string;
    readonly qtyEntered: number;
    readonly ratePerBase: number;
    readonly tax?: number;
  }[];
}

export interface CreateVendorRequest {
  readonly vendorCode?: string;
  readonly legalName: string;
  readonly tradeName?: string;
  readonly vendorType: string;
  readonly categories?: readonly string[];
  readonly pan?: string;
  readonly gstin?: string;
  readonly gstType?: string;
  readonly drugLicenceNo?: string;
  readonly drugLicenceValidTo?: string;
  readonly creditDays?: number;
  readonly leadTimeDaysAvg?: number;
  readonly notes?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// NC-007 — consignment
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A row of stock standing on our shelf that the hospital does not own.
 *
 * `value` is what the vendor will invoice if it is used, not what the hospital
 * has spent — nothing here has been paid for yet. It is a decimal string for the
 * reason every money field on this wire is: a number round-trips through
 * IEEE-754 and ₹1,234.55 comes back as 1234.5499999999999.
 */
export interface ConsignmentStockRow {
  readonly storeId: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly batchId: string | null;
  readonly batchNo: string | null;
  readonly expiryDate: string | null;
  readonly qtyOnHand: string;
  readonly vendorId: string | null;
  readonly value: string;
}

export interface ConsignmentAgreementLineRequest {
  readonly itemId: string;
  readonly vendorPrice: number;
  readonly mrp?: number;
  readonly gstRate?: number;
  readonly minStockBase?: number;
  readonly udiDi?: string;
}

export interface CreateConsignmentAgreementRequest {
  readonly vendorId: string;
  readonly agreementNo: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly invoicingCycle?: string;
  readonly paymentTermsDays?: number;
  readonly expiryReturnDaysBefore?: number;
  readonly replenishmentSlaDays?: number;
  readonly wastagePolicy?: 'hospital' | 'vendor' | 'case_by_case';
  readonly items: readonly ConsignmentAgreementLineRequest[];
}

/**
 * The scan at the operating table.
 *
 * `status: 'wasted'` is not an error path: an implant opened and not used is a
 * routine event with a liability question attached, which is why
 * `wasteLiability` defaults to `pending` rather than silently to the hospital.
 */
export interface RecordConsignmentUsageRequest {
  readonly agreementId: string;
  readonly storeId: string;
  readonly itemId: string;
  readonly batchId: string;
  readonly serialId?: string;
  readonly qtyEntered: number;
  readonly uomId?: string;
  readonly patientId?: string;
  readonly encounterId?: string;
  readonly surgeonUserId?: string;
  readonly side?: 'left' | 'right' | 'bilateral' | 'not_applicable';
  readonly site?: string;
  readonly status?: 'used' | 'wasted';
  readonly wasteReason?: string;
  readonly wasteLiability?: 'hospital' | 'vendor' | 'pending';
}

export interface CreateConsignmentReturnRequest {
  readonly agreementId: string;
  readonly vendorId: string;
  readonly storeId: string;
  readonly reason: 'near_expiry' | 'expired' | 'excess' | 'recall' | 'agreement_end' | 'damaged';
  readonly lines: readonly {
    readonly itemId: string;
    readonly batchId: string;
    readonly qtyEntered: number;
    readonly uomId?: string;
  }[];
}

export interface CreateConsignmentReconciliationRequest {
  readonly vendorId: string;
  readonly agreementId: string;
  /** `YYYY-MM`. */
  readonly period: string;
}

export interface SignReconciliationRequest {
  readonly vendorSignedBy: string;
  readonly agreed: boolean;
  readonly note?: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// NC-008 — consumption and cost centres
// ═════════════════════════════════════════════════════════════════════════════

export interface CostCentreView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly centreType: string;
  readonly parentId: string | null;
  readonly branchId: string | null;
  readonly ownerUserId: string | null;
  readonly allocationBasis: string;
  readonly active: boolean;
}

/** One period's consumption rolled up per cost centre. */
export interface CostCentreConsumptionRow {
  readonly costCentreId: string | null;
  readonly code: string | null;
  readonly name: string | null;
  readonly entries: number;
  readonly value: string;
}

export interface RecordConsumptionRequest {
  readonly storeId: string;
  readonly entryType: string;
  readonly costCentreId?: string;
  readonly patientId?: string;
  readonly encounterId?: string;
  readonly performedBy?: string;
  readonly source?: 'manual_scan' | 'kit' | 'bom' | 'auto_billing' | 'import';
  readonly lines: readonly {
    readonly itemId: string;
    readonly batchId?: string;
    readonly qtyEntered: number;
    readonly uomId?: string;
    readonly isBillable?: boolean;
    readonly expenseHead?: string;
  }[];
}

export interface CreateCostCentreRequest {
  readonly code: string;
  readonly name: string;
  readonly centreType: string;
  readonly parentId?: string;
  readonly branchId?: string;
  readonly ownerUserId?: string;
  readonly allocationBasis?: string;
}

/** Every write that only needs a reason. Reversal is never an edit (NC-008 §5). */
export interface ReverseRequest {
  readonly reason: string;
}
