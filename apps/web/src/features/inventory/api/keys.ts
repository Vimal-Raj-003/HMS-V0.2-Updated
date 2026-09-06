/**
 * TanStack Query cache keys for the store and purchase screens, scoped to the
 * tenant (`CLAUDE.md` §2).
 *
 * The `hospitalId` prefix is not decoration: a group materials manager switches
 * hospitals inside one browser tab, and a stock balance served from the wrong
 * tenant's cache is an indent raised against a shelf in another building.
 *
 * **The cursor is part of the key.** TanStack refetches on a key change, so a
 * cursor held only in a closure changes the request the query *would* make
 * without ever making it — the operator presses "Load the next page" and the
 * same page comes back.
 */
export function inventoryKeys(hospitalId: string) {
  const root = ['vims', hospitalId, 'inventory'] as const;

  return {
    root,

    items: (term: string, itemType: string, cursor: string) =>
      [...root, 'items', itemType, term, cursor] as const,
    itemsRoot: () => [...root, 'items'] as const,
    item: (id: string) => [...root, 'item', id] as const,
    substitutes: (id: string) => [...root, 'item', id, 'substitutes'] as const,
    scan: (barcode: string) => [...root, 'scan', barcode] as const,

    stores: (storeType: string, cursor: string) => [...root, 'stores', storeType, cursor] as const,
    storesRoot: () => [...root, 'stores'] as const,

    stock: (storeId: string, itemId: string, cursor: string) =>
      [...root, 'stock', storeId, itemId, cursor] as const,
    stockRoot: () => [...root, 'stock'] as const,
    availability: (itemId: string) => [...root, 'availability', itemId] as const,
    batches: (storeId: string, itemId: string) => [...root, 'batches', storeId, itemId] as const,
    ledger: (storeId: string, itemId: string, cursor: string) =>
      [...root, 'ledger', storeId, itemId, cursor] as const,
    ledgerRoot: () => [...root, 'ledger'] as const,
    expiring: (storeId: string, days: number, cursor: string) =>
      [...root, 'expiring', storeId, String(days), cursor] as const,
    integrity: () => [...root, 'integrity'] as const,
    batchTrace: (id: string) => [...root, 'batch-trace', id] as const,

    storeIndents: (storeId: string, cursor: string) => [...root, 'store-indents', storeId, cursor] as const,
    storeIndentsRoot: () => [...root, 'store-indents'] as const,
    storeIndent: (id: string) => [...root, 'store-indent', id] as const,
    issues: (storeId: string, cursor: string) => [...root, 'issues', storeId, cursor] as const,
    issuesRoot: () => [...root, 'issues'] as const,

    transfers: (status: string, cursor: string) => [...root, 'transfers', status, cursor] as const,
    transfersRoot: () => [...root, 'transfers'] as const,
    transfer: (id: string) => [...root, 'transfer', id] as const,

    adjustments: (storeId: string, status: string, cursor: string) =>
      [...root, 'adjustments', storeId, status, cursor] as const,
    adjustmentsRoot: () => [...root, 'adjustments'] as const,
    adjustment: (id: string) => [...root, 'adjustment', id] as const,
    counts: (storeId: string, cursor: string) => [...root, 'counts', storeId, cursor] as const,
    countsRoot: () => [...root, 'counts'] as const,
    count: (id: string) => [...root, 'count', id] as const,

    purchaseIndents: (storeId: string, status: string, cursor: string) =>
      [...root, 'purchase-indents', storeId, status, cursor] as const,
    purchaseIndentsRoot: () => [...root, 'purchase-indents'] as const,
    rfqs: (status: string, cursor: string) => [...root, 'rfqs', status, cursor] as const,
    rfqsRoot: () => [...root, 'rfqs'] as const,
    comparative: (rfqId: string) => [...root, 'comparative', rfqId] as const,
    pos: (vendorId: string, status: string, cursor: string) =>
      [...root, 'pos', vendorId, status, cursor] as const,
    posRoot: () => [...root, 'pos'] as const,
    po: (id: string) => [...root, 'po', id] as const,

    grns: (storeId: string, status: string, cursor: string) =>
      [...root, 'grns', storeId, status, cursor] as const,
    grnsRoot: () => [...root, 'grns'] as const,
    grn: (id: string) => [...root, 'grn', id] as const,

    invoices: (matchStatus: string, exceptionsOnly: boolean, cursor: string) =>
      [...root, 'invoices', matchStatus, exceptionsOnly ? 'exceptions' : 'all', cursor] as const,
    invoicesRoot: () => [...root, 'invoices'] as const,
    invoice: (id: string) => [...root, 'invoice', id] as const,

    vendors: (term: string, status: string, cursor: string) =>
      [...root, 'vendors', status, term, cursor] as const,
    vendorsRoot: () => [...root, 'vendors'] as const,
    vendor: (id: string) => [...root, 'vendor', id] as const,
    rateContracts: (vendorId: string) => [...root, 'vendor', vendorId, 'rate-contracts'] as const,

    // NC-007 — consignment. The vendor filter is part of the key because a
    // materials manager switching vendors must not be served the last one's
    // usages from cache: a usage attributed to the wrong vendor is an invoice
    // dispute.
    agreements: (storeId: string, cursor: string) => [...root, 'cn-agreements', storeId, cursor] as const,
    agreementsRoot: () => [...root, 'cn-agreements'] as const,
    agreement: (id: string) => [...root, 'cn-agreement', id] as const,
    consignmentStock: (storeId: string) => [...root, 'cn-stock', storeId] as const,
    consignmentStockRoot: () => [...root, 'cn-stock'] as const,
    usages: (agreementId: string, vendorId: string, status: string, cursor: string) =>
      [...root, 'cn-usages', agreementId, vendorId, status, cursor] as const,
    usagesRoot: () => [...root, 'cn-usages'] as const,
    usage: (id: string) => [...root, 'cn-usage', id] as const,
    reconciliation: (id: string) => [...root, 'cn-reconciliation', id] as const,

    // NC-008 — consumption and cost centres.
    consumption: (storeId: string, costCentreId: string, entryType: string, cursor: string) =>
      [...root, 'consumption', storeId, costCentreId, entryType, cursor] as const,
    consumptionRoot: () => [...root, 'consumption'] as const,
    consumptionEntry: (id: string) => [...root, 'consumption-entry', id] as const,
    costCentres: (centreType: string, cursor: string) =>
      [...root, 'cost-centres', centreType, cursor] as const,
    costCentresRoot: () => [...root, 'cost-centres'] as const,
    costCentreConsumption: (period: string) => [...root, 'cost-centre-consumption', period] as const,
  };
}

export type InventoryKeys = ReturnType<typeof inventoryKeys>;
