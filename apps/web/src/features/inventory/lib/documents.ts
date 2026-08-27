import type { DocumentLineView, DocumentView, FefoBatchView, InvoiceMatchView } from '../api/types';

/**
 * NC-005 and NC-006 document logic, expressed where the screen can read it.
 *
 * Everything here mirrors a rule the API enforces anyway; the point is to make
 * the refusal legible before a round trip rather than to be the enforcement.
 * Where the two ever disagree the API wins and the screen renders its
 * `ProblemDetails`.
 */

/**
 * Read one of a document line's `extra` fields.
 *
 * `extra` is the API's escape hatch for the columns that differ per document
 * type, and **it is not spelled consistently**: `indents.service.ts` and
 * `purchase.service.ts` copy raw column names in (`qty_approved_base`), while
 * `grn.service.ts`, `transfers.service.ts` and `adjustments.service.ts` build
 * camelCase objects by hand (`qtyAcceptedBase`). Rather than pick one and be
 * wrong for half the screens, this accepts every spelling a caller offers and
 * returns the first that is present. The inconsistency is the API's and is
 * reported as such; this is the client not pretending it does not exist.
 */
export function extraValue(
  line: DocumentLineView,
  ...keys: readonly string[]
): string | number | boolean | null {
  for (const key of keys) {
    const value = line.extra[key];
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

/** The same, as a display string. */
export function extraText(line: DocumentLineView, ...keys: readonly string[]): string | null {
  const value = extraValue(line, ...keys);
  return value === null ? null : String(value);
}

export function headerText(document: DocumentView, ...keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = document.header[key];
    if (value !== undefined && value !== null) return String(value);
  }
  return null;
}

// ── FEFO (NC-006 §3.3, `phase-04` exit gate 2 "FEFO respected") ─────────────

export type FefoVerdict =
  | { readonly kind: 'no_stock'; readonly message: string }
  | { readonly kind: 'fefo'; readonly batch: FefoBatchView }
  | {
      readonly kind: 'override';
      readonly batch: FefoBatchView;
      readonly suggested: FefoBatchView;
      readonly message: string;
    };

/**
 * Whether the batch a picker chose is the one FEFO would have chosen.
 *
 * `GET /inventory/stock/{itemId}/batches` returns the batches already in FEFO
 * order — earliest expiry first — so the first row *is* the suggestion. Choosing
 * any other is an override, and the API demands a reason for it
 * (`fefoOverrideReason`, and `pick_list_lines_override_documented` in the
 * database). This function produces the sentence that says so, rather than
 * leaving the picker to discover it from a 400.
 *
 * It deliberately does **not** decide *for* the picker: a later-expiring batch
 * is sometimes the right answer (the earlier one is on a ward, or reserved, or
 * a different strength on the same shelf). What is never right is doing it
 * silently.
 */
export function fefoVerdict(batches: readonly FefoBatchView[], chosenBatchId: string | null): FefoVerdict {
  const suggested = batches[0];
  if (suggested === undefined) {
    return {
      kind: 'no_stock',
      message: 'This store holds no usable batch of this item. Nothing can be picked against it.',
    };
  }
  if (chosenBatchId === null || chosenBatchId === suggested.batchId) {
    return { kind: 'fefo', batch: suggested };
  }
  const chosen = batches.find((batch) => batch.batchId === chosenBatchId);
  if (chosen === undefined) {
    return {
      kind: 'no_stock',
      message:
        'That batch is not on this store’s shelf. Pick from the batches listed, earliest expiry first.',
    };
  }
  return {
    kind: 'override',
    batch: chosen,
    suggested,
    message: `FEFO would pick batch ${suggested.batchNo} (expires ${suggested.expiryDate ?? 'unknown'}). Choosing ${chosen.batchNo} instead leaves the earlier batch to expire on the shelf, so it needs a reason somebody can read a year from now.`,
  };
}

// ── the three-way match (NC-005, `phase-04` exit gate 1) ────────────────────

export interface MatchException {
  readonly lineId: string;
  readonly itemCode: string;
  readonly kind: 'quantity' | 'rate' | 'tax';
  readonly detail: string;
}

/**
 * Every line of an invoice that failed the PO ↔ GRN ↔ invoice match.
 *
 * `withinTolerance` is the API's verdict, computed against the hospital's own
 * tolerance rules; this only turns it into words. A quantity mismatch is named
 * first because that is exit gate 1's example and because it is the one that
 * means goods were paid for that nobody received.
 */
export function matchExceptions(invoice: InvoiceMatchView): readonly MatchException[] {
  const out: MatchException[] = [];
  for (const line of invoice.lines) {
    if (line.withinTolerance) continue;
    const qtyDiff = Number(line.qtyDiffBase);
    if (Number.isFinite(qtyDiff) && qtyDiff !== 0) {
      out.push({
        lineId: line.id,
        itemCode: line.itemCode,
        kind: 'quantity',
        detail:
          qtyDiff > 0
            ? `Invoiced ${line.invQtyBase} against a receipt of ${line.grnQtyBase} — ${line.qtyDiffBase} more than arrived.`
            : `Invoiced ${line.invQtyBase} against a receipt of ${line.grnQtyBase} — ${String(Math.abs(qtyDiff))} less than arrived.`,
      });
    }
    const rateDiff = Number(line.rateDiff);
    if (Number.isFinite(rateDiff) && rateDiff !== 0) {
      out.push({
        lineId: line.id,
        itemCode: line.itemCode,
        kind: 'rate',
        detail: `The rate differs from the purchase order by ${line.rateDiff} per base unit.`,
      });
    }
    const taxDiff = Number(line.taxDiff);
    if (Number.isFinite(taxDiff) && taxDiff !== 0) {
      out.push({
        lineId: line.id,
        itemCode: line.itemCode,
        kind: 'tax',
        detail: `The tax on this line differs from the order by ${line.taxDiff}.`,
      });
    }
  }
  return out;
}

export function isMatchException(invoice: InvoiceMatchView): boolean {
  return matchExceptions(invoice).length > 0 || invoice.matchStatus === 'exception';
}

/**
 * Whether this invoice may be sent for payment.
 *
 * The API refuses an approval on an unmatched invoice; this says so in advance,
 * and names the only two lawful paths — resolve the exception, or dispute the
 * invoice with the vendor. "Approve anyway" is not one of them, and there is no
 * request shape for it.
 */
export type InvoiceVerdict =
  | { readonly kind: 'payable' }
  | { readonly kind: 'held'; readonly message: string; readonly exceptions: readonly MatchException[] };

export function invoiceVerdict(invoice: InvoiceMatchView): InvoiceVerdict {
  const exceptions = matchExceptions(invoice);
  if (exceptions.length === 0 && invoice.matchStatus !== 'exception') return { kind: 'payable' };
  return {
    kind: 'held',
    exceptions,
    message: `This invoice does not match its purchase order and its goods receipt on ${String(exceptions.length)} line(s). Resolve the difference with the store, or dispute the invoice with the vendor — it cannot be passed for payment as it stands.`,
  };
}

// ── the in-transit state (NC-006 §3.6) ─────────────────────────────────────

export const TRANSFER_STAGES = ['draft', 'approved', 'in_transit', 'received'] as const;
export type TransferStage = (typeof TRANSFER_STAGES)[number];

/**
 * Which stage a transfer has reached, for the progress rail.
 *
 * `in_transit` is the one that matters and the one an inventory system usually
 * gets wrong: between dispatch and receipt the stock belongs to **neither**
 * store. A UI that showed it as still in the sending store would let somebody
 * pick it twice; one that showed it as already received would let the receiving
 * store issue what it does not have.
 */
export function transferStage(status: string): number {
  const index = (TRANSFER_STAGES as readonly string[]).indexOf(status);
  if (index >= 0) return index;
  if (status === 'dispatched') return 2;
  if (status === 'partially_received') return 2;
  return 0;
}

export function isInTransit(status: string): boolean {
  return status === 'in_transit' || status === 'dispatched' || status === 'partially_received';
}

// ── cycle counts (NC-006 §3.7, `phase-04` exit gate 6) ─────────────────────

export interface CountVariance {
  readonly lineId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly system: string | null;
  readonly counted: string;
  readonly variance: string;
}

/**
 * The lines of a count plan whose physical count disagreed with the system.
 *
 * A **blind** count returns `systemQtyBase: null` until it is posted — that is
 * the point of a blind count, and a screen that displayed the system figure
 * beside the entry box would quietly turn every count into a confirmation. So
 * the system column renders as "not shown — blind count" rather than as a
 * missing value, and the variance is whatever the API computed.
 */
export function countVariances(plan: DocumentView): readonly CountVariance[] {
  const out: CountVariance[] = [];
  for (const line of plan.lines) {
    const variance = extraText(line, 'varianceQtyBase', 'variance_qty_base');
    if (variance === null) continue;
    if (Number(variance) === 0) continue;
    out.push({
      lineId: line.id,
      itemCode: line.itemCode,
      itemName: line.itemName,
      system: extraText(line, 'systemQtyBase', 'system_qty_base'),
      counted: line.qtyBase,
      variance,
    });
  }
  return out;
}

/**
 * `phase-04` exit gate 6 — a count with a variance is approved, not adjusted
 * away. The approval carries a reason and posts a compensating ledger entry; it
 * never edits a ledger row, because `stock_ledger` never gets an `UPDATE`.
 */
export function countApprovalProblems(
  reason: string,
  variances: readonly CountVariance[],
): readonly string[] {
  const problems: string[] = [];
  if (reason.trim().length < 8) {
    problems.push('Give a reason somebody reading this count in a year can act on.');
  }
  if (variances.length > 0 && reason.trim().length < 8) {
    problems.push(
      `${String(variances.length)} line(s) disagree with the system. The adjustment that reconciles them is posted under this reason, so it has to say what happened.`,
    );
  }
  return problems;
}

// ── status vocabulary ───────────────────────────────────────────────────────

/**
 * `docs/06` §1.2 rule 3 — colour is never the only signal, so every status
 * carries a word as well. These are tone class names, not colours.
 */
export function statusTone(status: string): string {
  if (['rejected', 'cancelled', 'disputed', 'exception', 'blacklisted', 'blocked'].includes(status)) {
    return 'text-danger-fg';
  }
  if (
    [
      'pending_approval',
      'in_transit',
      'dispatched',
      'partially_received',
      'draft',
      'hold',
      'watch_list',
    ].includes(status)
  ) {
    return 'text-warning-fg';
  }
  if (['approved', 'posted', 'received', 'matched', 'completed', 'active', 'closed'].includes(status)) {
    return 'text-success-fg';
  }
  return 'text-fg-muted';
}
