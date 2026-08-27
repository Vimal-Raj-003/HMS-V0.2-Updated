import type { Page } from '@vims/contracts';
import { newIdempotencyKey, queryString, request } from './http';
import type {
  ApproveCountRequest,
  ApproveIndentRequest,
  AvailabilityRow,
  BatchTraceView,
  CaptureInvoiceRequest,
  ComparativeView,
  CountLinesRequest,
  CreateAdjustmentRequest,
  CreateCountPlanRequest,
  CreateGrnRequest,
  CreateIssueRequest,
  CreatePoRequest,
  CreatePurchaseIndentRequest,
  CreateStoreIndentRequest,
  CreateTransferRequest,
  CreateVendorRequest,
  DispatchTransferRequest,
  DocumentView,
  FefoBatchView,
  IntegrityRow,
  InvoiceMatchView,
  ItemView,
  LedgerEntryView,
  RateContractView,
  ReceiveIssueRequest,
  ReceiveLinesRequest,
  ScanResolution,
  StockBalanceView,
  StoreView,
  SubstituteView,
  VendorView,
} from './types';

/**
 * Every call the store, purchase and vendor screens make.
 *
 * The rules are the pharmacy client's, and for the same reasons:
 *
 *  1. **Nothing catches, nothing retries.** A refused approval is a decision. A
 *     re-posted GRN is a second delivery that never arrived.
 *  2. **Every write carries an idempotency key**, minted once per intent; the
 *     API's interceptor fails closed without one.
 *  3. **Every list is cursor-paginated with a bounded limit** — `docs/07 §4`
 *     bans `OFFSET`, and a client that concatenated pages until `hasMore` went
 *     false would be an `OFFSET` scan wearing a different hat.
 *  4. **Only coded filters and opaque tokens in a query string.** Nothing under
 *     `/inventory` is patient data, but `GET /inventory/batches/{id}/trace`
 *     returns some — so that route is a POST-free read whose *response* is
 *     handled as PHI by the screen, and no patient identifier is ever a filter.
 */

const V1 = '/api/v1';

interface Signal {
  readonly signal?: AbortSignal;
}

function withSignal(options: Signal): { signal?: AbortSignal } {
  return options.signal === undefined ? {} : { signal: options.signal };
}

/** The API's own `limit` ceiling, and `PAGE_SIZE_MAX_INTERACTIVE`. */
export const PAGE_LIMIT = 50;

// ═════════════════════════════════════════════════════════════════════════════
// NC-006 §3.1 — the item master
// ═════════════════════════════════════════════════════════════════════════════

export async function listItems(
  filters: {
    readonly q?: string | undefined;
    readonly itemType?: string | undefined;
    readonly schedule?: string | undefined;
    readonly status?: string | undefined;
    readonly narcoticOnly?: boolean | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<ItemView>> {
  return request(
    `${V1}/inventory/items${queryString({
      q: filters.q,
      itemType: filters.itemType,
      schedule: filters.schedule,
      status: filters.status,
      narcoticOnly: filters.narcoticOnly,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getItem(id: string, options: Signal = {}): Promise<ItemView> {
  return request(`${V1}/inventory/items/${id}`, withSignal(options));
}

/**
 * One scan → item, pack, batch, expiry, serial (EN-013 §3).
 *
 * Gated on `inventory.item.read` rather than on a configuration key, and
 * deliberately: a pharmacist scanning a pack is not editing a master, and asking
 * them to hold an administrator's role to identify a box would put the whole
 * counter behind one.
 */
export async function resolveBarcode(barcode: string, options: Signal = {}): Promise<ScanResolution> {
  return request(`${V1}/inventory/items/resolve${queryString({ barcode })}`, withSignal(options));
}

export async function listSubstitutes(
  itemId: string,
  options: Signal = {},
): Promise<{ readonly items: readonly SubstituteView[] }> {
  return request(`${V1}/inventory/items/${itemId}/substitutes`, withSignal(options));
}

// ═════════════════════════════════════════════════════════════════════════════
// NC-006 §3.2 — stores
// ═════════════════════════════════════════════════════════════════════════════

export async function listStores(
  filters: {
    readonly storeType?: string | undefined;
    readonly q?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<StoreView>> {
  return request(
    `${V1}/inventory/stores${queryString({
      storeType: filters.storeType,
      q: filters.q,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// NC-006 §3.3 — stock, batches and the ledger
// ═════════════════════════════════════════════════════════════════════════════

export async function listStock(
  filters: {
    readonly storeId?: string | undefined;
    readonly itemId?: string | undefined;
    readonly expiringInDays?: number | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<StockBalanceView>> {
  return request(
    `${V1}/inventory/stock${queryString({
      storeId: filters.storeId,
      itemId: filters.itemId,
      expiringInDays: filters.expiringInDays,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getAvailability(
  itemId: string,
  options: Signal = {},
): Promise<{ readonly items: readonly AvailabilityRow[] }> {
  return request(`${V1}/inventory/stock/${itemId}/availability`, withSignal(options));
}

/** FEFO order, from `inventory.fefo_batches`. The first row is the one to pick. */
export async function listFefoBatches(
  itemId: string,
  storeId: string,
  options: Signal = {},
): Promise<{ readonly items: readonly FefoBatchView[] }> {
  return request(`${V1}/inventory/stock/${itemId}/batches${queryString({ storeId })}`, withSignal(options));
}

export async function listLedger(
  filters: {
    readonly storeId?: string | undefined;
    readonly itemId?: string | undefined;
    readonly batchId?: string | undefined;
    readonly movementType?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<LedgerEntryView>> {
  return request(
    `${V1}/inventory/ledger${queryString({
      storeId: filters.storeId,
      itemId: filters.itemId,
      batchId: filters.batchId,
      movementType: filters.movementType,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function listExpiring(
  filters: {
    readonly storeId?: string | undefined;
    readonly days?: number | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<StockBalanceView>> {
  return request(
    `${V1}/inventory/expiry${queryString({
      storeId: filters.storeId,
      days: filters.days,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

/**
 * `phase-04` exit gate 6, on demand: `sum(ledger) = on_hand` for every
 * item/batch/store. An empty `rows` is the pass.
 */
export async function checkStockIntegrity(
  options: Signal = {},
): Promise<{ readonly ok: boolean; readonly rows: readonly IntegrityRow[] }> {
  return request(`${V1}/inventory/integrity`, withSignal(options));
}

/**
 * Where a batch has been, and — for a recall — who received some of it.
 *
 * The `patients` array of the response **is** patient data. It is never rendered
 * on a shared screen without the recall context that justifies it, and never put
 * in a URL.
 */
export async function traceBatch(id: string, options: Signal = {}): Promise<BatchTraceView> {
  return request(`${V1}/inventory/batches/${id}/trace`, withSignal(options));
}

// ═════════════════════════════════════════════════════════════════════════════
// NC-006 §3.5 — store indent → issue → receipt
// ═════════════════════════════════════════════════════════════════════════════

export async function listStoreIndents(
  filters: {
    readonly storeType?: string | undefined;
    readonly q?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<DocumentView>> {
  return request(
    `${V1}/inventory/indents${queryString({
      storeType: filters.storeType,
      q: filters.q,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getStoreIndent(id: string, options: Signal = {}): Promise<DocumentView> {
  return request(`${V1}/inventory/indents/${id}`, withSignal(options));
}

export async function createStoreIndent(
  body: CreateStoreIndentRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/indents`, { method: 'POST', body, idempotencyKey });
}

export async function approveStoreIndent(
  id: string,
  body: ApproveIndentRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/indents/${id}/approve`, { method: 'POST', body, idempotencyKey });
}

export async function rejectStoreIndent(
  id: string,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/indents/${id}/reject`, {
    method: 'POST',
    body: { reason },
    idempotencyKey,
  });
}

/** FEFO's suggestion, written down, so that an override has to be justified. */
export async function generatePickList(
  id: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/indents/${id}/pick-list`, { method: 'POST', idempotencyKey });
}

export async function listIssues(
  filters: { readonly storeType?: string | undefined; readonly cursor?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<DocumentView>> {
  return request(
    `${V1}/inventory/issues${queryString({
      storeType: filters.storeType,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function createIssue(
  body: CreateIssueRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/issues`, { method: 'POST', body, idempotencyKey });
}

export async function receiveIssue(
  id: string,
  body: ReceiveIssueRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/issues/${id}/receive`, { method: 'POST', body, idempotencyKey });
}

// ═════════════════════════════════════════════════════════════════════════════
// NC-006 §3.6 — inter-store transfers, and the in-transit state
// ═════════════════════════════════════════════════════════════════════════════

export async function listTransfers(
  filters: {
    readonly fromStoreId?: string | undefined;
    readonly toStoreId?: string | undefined;
    readonly status?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<DocumentView>> {
  return request(
    `${V1}/inventory/transfers${queryString({
      fromStoreId: filters.fromStoreId,
      toStoreId: filters.toStoreId,
      status: filters.status,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getTransfer(id: string, options: Signal = {}): Promise<DocumentView> {
  return request(`${V1}/inventory/transfers/${id}`, withSignal(options));
}

export async function createTransfer(
  body: CreateTransferRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/transfers`, { method: 'POST', body, idempotencyKey });
}

export async function approveTransfer(
  id: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/transfers/${id}/approve`, { method: 'POST', idempotencyKey });
}

/** Stock leaves the sending store here and belongs to neither until receipt. */
export async function dispatchTransfer(
  id: string,
  body: DispatchTransferRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/transfers/${id}/dispatch`, { method: 'POST', body, idempotencyKey });
}

export async function receiveTransfer(
  id: string,
  body: ReceiveLinesRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/transfers/${id}/receive`, { method: 'POST', body, idempotencyKey });
}

export async function cancelTransfer(
  id: string,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/transfers/${id}/cancel`, {
    method: 'POST',
    body: { reason },
    idempotencyKey,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// NC-006 §3.7 — adjustments and counts
// ═════════════════════════════════════════════════════════════════════════════

export async function listAdjustments(
  filters: {
    readonly storeId?: string | undefined;
    readonly status?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<DocumentView>> {
  return request(
    `${V1}/inventory/adjustments${queryString({
      storeId: filters.storeId,
      status: filters.status,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getAdjustment(id: string, options: Signal = {}): Promise<DocumentView> {
  return request(`${V1}/inventory/adjustments/${id}`, withSignal(options));
}

export async function createAdjustment(
  body: CreateAdjustmentRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/adjustments`, { method: 'POST', body, idempotencyKey });
}

/** Approves and posts. Maker ≠ checker, in the service and in the database. */
export async function approveAdjustment(
  id: string,
  note: string | undefined,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/adjustments/${id}/approve`, {
    method: 'POST',
    body: note === undefined || note === '' ? {} : { note },
    idempotencyKey,
  });
}

export async function listCountPlans(
  filters: {
    readonly storeId?: string | undefined;
    readonly status?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<DocumentView>> {
  return request(
    `${V1}/inventory/counts/plans${queryString({
      storeId: filters.storeId,
      status: filters.status,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getCountPlan(id: string, options: Signal = {}): Promise<DocumentView> {
  return request(`${V1}/inventory/counts/plans/${id}`, withSignal(options));
}

export async function createCountPlan(
  body: CreateCountPlanRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/counts/plans`, { method: 'POST', body, idempotencyKey });
}

export async function recordCount(
  sheetId: string,
  body: CountLinesRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/counts/sheets/${sheetId}/lines`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

/** The variance approval. It posts the adjustment that reconciles the shelf. */
export async function approveCount(
  id: string,
  body: ApproveCountRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/counts/plans/${id}/approve`, { method: 'POST', body, idempotencyKey });
}

// ═════════════════════════════════════════════════════════════════════════════
// NC-005 — purchase indent → RFQ → comparative → PO
// ═════════════════════════════════════════════════════════════════════════════

export async function listPurchaseIndents(
  filters: {
    readonly storeId?: string | undefined;
    readonly status?: string | undefined;
    readonly urgency?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<DocumentView>> {
  return request(
    `${V1}/inventory/purchase/indents${queryString({
      storeId: filters.storeId,
      status: filters.status,
      urgency: filters.urgency,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getPurchaseIndent(id: string, options: Signal = {}): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/indents/${id}`, withSignal(options));
}

export async function createPurchaseIndent(
  body: CreatePurchaseIndentRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/indents`, { method: 'POST', body, idempotencyKey });
}

export async function approvePurchaseIndent(
  id: string,
  body: ApproveIndentRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/indents/${id}/approve`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export async function rejectPurchaseIndent(
  id: string,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/indents/${id}/reject`, {
    method: 'POST',
    body: { reason },
    idempotencyKey,
  });
}

export async function listRfqs(
  filters: { readonly status?: string | undefined; readonly cursor?: string | undefined } = {},
  options: Signal = {},
): Promise<Page<DocumentView>> {
  return request(
    `${V1}/inventory/purchase/rfqs${queryString({
      status: filters.status,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

/** Landed cost per base unit, so quotes in different pack sizes compare. */
export async function getComparative(rfqId: string, options: Signal = {}): Promise<ComparativeView> {
  return request(`${V1}/inventory/purchase/rfqs/${rfqId}/comparative`, withSignal(options));
}

export async function approveComparative(
  rfqId: string,
  body: {
    readonly selections: readonly {
      readonly rfqLineId: string;
      readonly quotationLineId: string;
      readonly justification?: string;
    }[];
    readonly note?: string;
  },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<ComparativeView> {
  return request(`${V1}/inventory/purchase/rfqs/${rfqId}/comparative/approve`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export async function listPurchaseOrders(
  filters: {
    readonly vendorId?: string | undefined;
    readonly storeId?: string | undefined;
    readonly status?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<DocumentView>> {
  return request(
    `${V1}/inventory/purchase/orders${queryString({
      vendorId: filters.vendorId,
      storeId: filters.storeId,
      status: filters.status,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getPurchaseOrder(id: string, options: Signal = {}): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/orders/${id}`, withSignal(options));
}

export async function createPurchaseOrder(
  body: CreatePoRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/orders`, { method: 'POST', body, idempotencyKey });
}

/** Maker ≠ checker: the raiser of a purchase order may not approve it. */
export async function approvePurchaseOrder(
  id: string,
  note: string | undefined,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/orders/${id}/approve`, {
    method: 'POST',
    body: note === undefined || note === '' ? {} : { note },
    idempotencyKey,
  });
}

export async function sendPurchaseOrder(
  id: string,
  channel: 'email' | 'portal' | 'print' | 'edi',
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/orders/${id}/send`, {
    method: 'POST',
    body: { channel },
    idempotencyKey,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// NC-005 — goods receipt and the three-way match
// ═════════════════════════════════════════════════════════════════════════════

export async function listGrns(
  filters: {
    readonly vendorId?: string | undefined;
    readonly storeId?: string | undefined;
    readonly poId?: string | undefined;
    readonly status?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<DocumentView>> {
  return request(
    `${V1}/inventory/purchase/grns${queryString({
      vendorId: filters.vendorId,
      storeId: filters.storeId,
      poId: filters.poId,
      status: filters.status,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getGrn(id: string, options: Signal = {}): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/grns/${id}`, withSignal(options));
}

export async function createGrn(
  body: CreateGrnRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/grns`, { method: 'POST', body, idempotencyKey });
}

export async function qcGrn(
  id: string,
  body: { readonly outcome: 'accepted' | 'partially_accepted' | 'rejected'; readonly notes?: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/grns/${id}/qc`, { method: 'POST', body, idempotencyKey });
}

/** The accepted quantity becomes stock, and its batches are created here. */
export async function postGrn(
  id: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<DocumentView> {
  return request(`${V1}/inventory/purchase/grns/${id}/post`, { method: 'POST', idempotencyKey });
}

export async function listInvoices(
  filters: {
    readonly vendorId?: string | undefined;
    readonly matchStatus?: string | undefined;
    readonly exceptionsOnly?: boolean | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<InvoiceMatchView>> {
  return request(
    `${V1}/inventory/purchase/invoices${queryString({
      vendorId: filters.vendorId,
      matchStatus: filters.matchStatus,
      exceptionsOnly: filters.exceptionsOnly,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getInvoice(id: string, options: Signal = {}): Promise<InvoiceMatchView> {
  return request(`${V1}/inventory/purchase/invoices/${id}`, withSignal(options));
}

export async function captureInvoice(
  body: CaptureInvoiceRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvoiceMatchView> {
  return request(`${V1}/inventory/purchase/invoices`, { method: 'POST', body, idempotencyKey });
}

export async function approveInvoice(
  id: string,
  body: { readonly note?: string; readonly dueDate?: string },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvoiceMatchView> {
  return request(`${V1}/inventory/purchase/invoices/${id}/approve`, {
    method: 'POST',
    body,
    idempotencyKey,
  });
}

export async function disputeInvoice(
  id: string,
  reason: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<InvoiceMatchView> {
  return request(`${V1}/inventory/purchase/invoices/${id}/dispute`, {
    method: 'POST',
    body: { reason },
    idempotencyKey,
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// NC-021 — vendors
// ═════════════════════════════════════════════════════════════════════════════

export async function listVendors(
  filters: {
    readonly q?: string | undefined;
    readonly status?: string | undefined;
    readonly vendorType?: string | undefined;
    readonly cursor?: string | undefined;
  } = {},
  options: Signal = {},
): Promise<Page<VendorView>> {
  return request(
    `${V1}/vendors${queryString({
      q: filters.q,
      status: filters.status,
      vendorType: filters.vendorType,
      cursor: filters.cursor,
      limit: PAGE_LIMIT,
    })}`,
    withSignal(options),
  );
}

export async function getVendor(id: string, options: Signal = {}): Promise<VendorView> {
  return request(`${V1}/vendors/${id}`, withSignal(options));
}

export async function createVendor(
  body: CreateVendorRequest,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<VendorView> {
  return request(`${V1}/vendors`, { method: 'POST', body, idempotencyKey });
}

/** Maker ≠ checker: the creator of a vendor record may not approve it. */
export async function approveVendor(
  id: string,
  note: string | undefined,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<VendorView> {
  return request(`${V1}/vendors/${id}/approve`, {
    method: 'POST',
    body: note === undefined || note === '' ? {} : { note },
    idempotencyKey,
  });
}

export async function listRateContracts(
  vendorId: string,
  options: Signal = {},
): Promise<{ readonly items: readonly RateContractView[] }> {
  return request(`${V1}/vendors/${vendorId}/rate-contracts`, withSignal(options));
}
