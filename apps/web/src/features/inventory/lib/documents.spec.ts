import { describe, expect, it } from 'vitest';
import type {
  DocumentLineView,
  DocumentView,
  FefoBatchView,
  InvoiceMatchLine,
  InvoiceMatchView,
} from '../api/types';
import {
  countApprovalProblems,
  countVariances,
  extraText,
  fefoVerdict,
  invoiceVerdict,
  isInTransit,
  isMatchException,
  matchExceptions,
  transferStage,
} from './documents';

function batch(overrides: Partial<FefoBatchView> = {}): FefoBatchView {
  return {
    batchId: 'b-1',
    batchNo: 'B-2201',
    expiryDate: '2026-11-30',
    qtyAvailable: '120',
    unitCost: '4.20',
    mrp: '8.00',
    isConsignment: false,
    ...overrides,
  };
}

function invoiceLine(overrides: Partial<InvoiceMatchLine> = {}): InvoiceMatchLine {
  return {
    id: 'l-1',
    itemId: 'i-1',
    itemCode: 'AMOX500',
    status: 'matched',
    invQtyBase: '100',
    grnQtyBase: '100',
    poQtyBase: '100',
    qtyDiffBase: '0',
    rateDiff: '0',
    taxDiff: '0',
    withinTolerance: true,
    ...overrides,
  };
}

function invoice(lines: readonly InvoiceMatchLine[], matchStatus = 'matched'): InvoiceMatchView {
  return {
    invoiceId: 'inv-1',
    invoiceNo: 'V/2026/91',
    vendorId: 'v-1',
    matchStatus,
    total: '8400.00',
    lines,
  };
}

function countLine(overrides: Partial<DocumentLineView> = {}): DocumentLineView {
  return {
    id: 'cl-1',
    lineNo: 1,
    itemId: 'i-1',
    itemCode: 'AMOX500',
    itemName: 'Amoxicillin 500 mg capsule',
    batchId: null,
    batchNo: null,
    uomId: 'u-1',
    qtyEntered: '98',
    qtyBase: '98',
    status: 'counted',
    extra: {},
    ...overrides,
  };
}

function plan(lines: readonly DocumentLineView[]): DocumentView {
  return {
    id: 'cp-1',
    documentNo: 'CNT/2026/4',
    status: 'counted',
    storeId: 's-1',
    counterpartyId: null,
    createdAt: '2026-08-25T04:00:00.000Z',
    lines,
    header: { countType: 'cycle', blind: true },
  };
}

describe('FEFO (exit gate 2 — "stock reduces by exact batches, FEFO respected")', () => {
  const earliest = batch({ batchId: 'b-early', batchNo: 'B-EARLY', expiryDate: '2026-09-30' });
  const later = batch({ batchId: 'b-late', batchNo: 'B-LATE', expiryDate: '2027-06-30' });

  it('takes the first row as the suggestion, because the API returns them in FEFO order', () => {
    const verdict = fefoVerdict([earliest, later], null);
    expect(verdict.kind).toBe('fefo');
    if (verdict.kind !== 'fefo') throw new Error('expected fefo');
    expect(verdict.batch.batchNo).toBe('B-EARLY');
  });

  it('agrees when the picker chose the FEFO batch', () => {
    expect(fefoVerdict([earliest, later], 'b-early').kind).toBe('fefo');
  });

  it('calls a later batch an override and says what it costs', () => {
    const verdict = fefoVerdict([earliest, later], 'b-late');
    expect(verdict.kind).toBe('override');
    if (verdict.kind !== 'override') throw new Error('expected override');
    expect(verdict.message).toContain('B-EARLY');
    expect(verdict.message).toMatch(/expire on the shelf/iu);
    expect(verdict.message).toMatch(/needs a reason/iu);
  });

  it('refuses a batch that is not on this shelf at all', () => {
    expect(fefoVerdict([earliest], 'b-somewhere-else').kind).toBe('no_stock');
  });

  it('says so plainly when the store holds nothing', () => {
    const verdict = fefoVerdict([], null);
    expect(verdict.kind).toBe('no_stock');
    if (verdict.kind !== 'no_stock') throw new Error('expected no_stock');
    expect(verdict.message).toMatch(/no usable batch/iu);
  });
});

describe('the three-way match (exit gate 1 — "a quantity mismatch is caught and queued")', () => {
  it('passes a clean invoice', () => {
    const clean = invoice([invoiceLine()]);
    expect(matchExceptions(clean)).toHaveLength(0);
    expect(isMatchException(clean)).toBe(false);
    expect(invoiceVerdict(clean)).toEqual({ kind: 'payable' });
  });

  it('catches a quantity mismatch and says which way it went', () => {
    const short = invoice([
      invoiceLine({ invQtyBase: '100', grnQtyBase: '90', qtyDiffBase: '10', withinTolerance: false }),
    ]);
    const exceptions = matchExceptions(short);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.kind).toBe('quantity');
    expect(exceptions[0]?.detail).toMatch(/more than arrived/iu);
  });

  it('holds an invoice that does not match, and names the only two lawful paths', () => {
    const short = invoice([invoiceLine({ qtyDiffBase: '10', withinTolerance: false })], 'exception');
    const verdict = invoiceVerdict(short);
    expect(verdict.kind).toBe('held');
    if (verdict.kind !== 'held') throw new Error('expected held');
    expect(verdict.message).toMatch(/Resolve the difference|dispute the invoice/iu);
    expect(verdict.message).toMatch(/cannot be passed for payment/iu);
  });

  /** A tolerance the hospital configured is the API's to apply, not the UI's. */
  it('does not second-guess a difference the API called within tolerance', () => {
    const tolerated = invoice([invoiceLine({ qtyDiffBase: '1', rateDiff: '0.05', withinTolerance: true })]);
    expect(matchExceptions(tolerated)).toHaveLength(0);
  });

  it('treats an API match status of "exception" as an exception even with clean lines', () => {
    expect(isMatchException(invoice([invoiceLine()], 'exception'))).toBe(true);
  });

  it('reports rate and tax differences separately from quantity', () => {
    const mixed = invoice([
      invoiceLine({ qtyDiffBase: '0', rateDiff: '2.50', taxDiff: '0.30', withinTolerance: false }),
    ]);
    expect(matchExceptions(mixed).map((e) => e.kind)).toEqual(['rate', 'tax']);
  });
});

describe('the in-transit state', () => {
  it('places dispatched stock between the two stores rather than in either', () => {
    expect(isInTransit('in_transit')).toBe(true);
    expect(isInTransit('dispatched')).toBe(true);
    expect(isInTransit('partially_received')).toBe(true);
    expect(isInTransit('received')).toBe(false);
    expect(isInTransit('draft')).toBe(false);
  });

  it('orders the stages so the rail cannot go backwards', () => {
    expect(transferStage('draft')).toBe(0);
    expect(transferStage('approved')).toBe(1);
    expect(transferStage('in_transit')).toBe(2);
    expect(transferStage('dispatched')).toBe(2);
    expect(transferStage('received')).toBe(3);
    expect(transferStage('something-new')).toBe(0);
  });
});

describe('the cycle count', () => {
  it('reads the API’s variance whichever way it spelled the key', () => {
    const camel = countLine({ extra: { varianceQtyBase: '-2', systemQtyBase: '100' } });
    const snake = countLine({ id: 'cl-2', extra: { variance_qty_base: '-2', system_qty_base: '100' } });
    expect(extraText(camel, 'varianceQtyBase', 'variance_qty_base')).toBe('-2');
    expect(extraText(snake, 'varianceQtyBase', 'variance_qty_base')).toBe('-2');
  });

  it('lists only the lines that disagree', () => {
    const variances = countVariances(
      plan([
        countLine({ extra: { varianceQtyBase: '0' } }),
        countLine({ id: 'cl-2', itemCode: 'PARA650', extra: { varianceQtyBase: '-2' } }),
      ]),
    );
    expect(variances).toHaveLength(1);
    expect(variances[0]?.itemCode).toBe('PARA650');
  });

  /** A blind count hides the system figure. Showing it turns counting into confirming. */
  it('keeps a blind count blind', () => {
    const variances = countVariances(
      plan([countLine({ extra: { varianceQtyBase: '-2', systemQtyBase: null } })]),
    );
    expect(variances[0]?.system).toBeNull();
  });

  it('refuses to approve a variance without a reason', () => {
    const variances = countVariances(plan([countLine({ extra: { varianceQtyBase: '-2' } })]));
    expect(countApprovalProblems('', variances).length).toBeGreaterThan(0);
    expect(countApprovalProblems('Two strips found in the fridge after the count.', variances)).toHaveLength(
      0,
    );
  });
});
