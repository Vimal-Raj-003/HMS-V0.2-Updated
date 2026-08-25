/**
 * The shapes this module returns.
 *
 * Deliberately hand-written rather than derived from the row types: a view is
 * the API's contract and a row is the table's, and letting one become the other
 * means every column added to a table becomes a field in a response nobody
 * decided to publish. Money and quantity are decimal **strings** for the reason
 * `docs/01 §5` gives about events and which applies equally to a response body:
 * `numeric(18,4)` through IEEE-754 and back is not the number that was stored.
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

/** What one scan resolved to — item, pack, batch, expiry, serial. */
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

export interface ComparativeView {
  readonly rfqId: string;
  readonly generatedAt: string;
  readonly lines: readonly {
    readonly rfqLineId: string;
    readonly itemId: string;
    readonly itemCode: string;
    readonly itemName: string;
    readonly qtyBase: string;
    readonly quotes: {
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
    }[];
  }[];
}

export interface InvoiceMatchView {
  readonly invoiceId: string;
  readonly invoiceNo: string;
  readonly vendorId: string;
  readonly matchStatus: string;
  readonly total: string;
  readonly lines: readonly {
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
  }[];
}

export interface IntegrityRow {
  readonly storeId: string;
  readonly itemId: string;
  readonly batchId: string | null;
  readonly ledgerSum: string;
  readonly balanceQty: string;
  readonly difference: string;
}

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
