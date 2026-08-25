import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { getContext } from '../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../core/db/database.service.js';
import { NumberingService } from '../../core/numbering/numbering.service.js';
import { OutboxService } from '../../core/outbox/outbox.service.js';
import { CursorService } from '../../core/pagination/cursor.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';
import {
  assertStatus,
  binder,
  hospitalId,
  moneyString,
  quantityString,
  requireBranch,
  withInventoryErrors,
} from './inventory.common.js';
import { inventoryEvent } from './inventory.events.js';
import type {
  ApproveInvoiceRequest,
  CaptureInvoiceRequest,
  CreateGrnRequest,
  DisputeInvoiceRequest,
  GrnQcRequest,
  GrnQuery,
  InvoiceQuery,
  PurchaseReturnRequest,
  RejectRequest,
} from './inventory.schemas.js';
import type { DocumentLineView, DocumentView, InvoiceMatchView } from './inventory.types.js';
import { PurchaseService } from './purchase.service.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { UomService } from './uom.service.js';
import { VendorsService } from './vendors.service.js';

/**
 * NC-005 §3 — goods receipt, quality check, the 3-way match, and the exception
 * queue that `phase-04` exit gate 1 ends on.
 *
 * ── Receipt is where a batch and an expiry enter the system ─────────────────
 *
 * Everything downstream — FEFO, the near-expiry report, a recall trace, the
 * refusal to dispense an expired strip — is vacuous if a batch can arrive
 * without them. `inventory.enforce_grn_line` therefore refuses a batch-tracked
 * line with no batch number, an expiry-tracked line with no expiry, stock that
 * is already expired, stock with less shelf life than the item requires, and a
 * scheduled drug from a vendor whose drug licence is not valid that day. This
 * service creates the `item_batches` row from those fields rather than accepting
 * a batch id, so there is no path in which a counter can name a batch nothing
 * ever received.
 *
 * ── Stock moves at `post`, not at `create` ──────────────────────────────────
 *
 * A GRN in `qc_pending` is a claim about what is on the dock. The ledger row is
 * written when it is posted, after the quality check the hospital's settings ask
 * for. That is also what makes a *rejected* line harmless: it never became
 * stock, so nothing has to be un-become.
 *
 * ── The match is the database's verdict, not this service's ────────────────
 *
 * `inventory.compute_invoice_match` computes qty, rate and tax differences
 * against the hospital's tolerances and stamps a status on every line;
 * `roll_up_invoice_match` rolls the worst one onto the invoice. This service
 * builds the lines and reads the verdict back. Recomputing it here would create
 * a second opinion, and the exception queue and the buyer's screen would
 * eventually disagree about the same invoice.
 */
@Injectable()
export class GrnService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(UomService) private readonly uoms: UomService,
    @Inject(VendorsService) private readonly vendors: VendorsService,
    @Inject(PurchaseService) private readonly purchase: PurchaseService,
  ) {}

  async create(body: CreateGrnRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await this.vendors.assertPurchasable(tx, body.vendorId);
        const settings = await this.purchase.settings(tx);

        if (body.poId !== undefined) {
          const po = await tx.maybeOne<{ status: string; is_current: boolean; vendor_id: string }>(
            `SELECT status::text AS status, is_current, vendor_id
               FROM inventory.pur_purchase_orders WHERE id = $1`,
            [body.poId],
          );
          if (po === undefined) throw AppError.notFound('The purchase order');
          if (!po.is_current) {
            throw new AppError(
              ProblemType.CONFLICT,
              'That version of the purchase order has been superseded. Receive against the current version.',
            );
          }
          if (po.vendor_id !== body.vendorId) {
            throw new AppError(
              ProblemType.VALIDATION_FAILED,
              'The purchase order was raised on a different vendor from the one delivering.',
            );
          }
          assertStatus(
            'This purchase order',
            po.status,
            ['approved', 'sent', 'acknowledged', 'partially_received'],
            'received against',
          );
        } else if (!body.withoutPo) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            'A goods receipt names the purchase order it is against, or says explicitly that there is none. A receipt with neither cannot be matched to an invoice.',
          );
        }

        const grnNo = (
          await this.numbering.allocate(tx, {
            key: 'GRN',
            branchId,
            refType: 'inventory.pur_grns',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.pur_grns
             (id, hospital_id, branch_id, grn_no, po_id, po_version, vendor_id, store_id,
              invoice_no, invoice_date, dc_no, eway_bill_no, received_at, received_by,
              status, without_po, remarks, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5,
                   (SELECT po_version FROM inventory.pur_purchase_orders WHERE id = $5),
                   $6, $7, $8, $9::date, $10, $11, now(), $12,
                   $13::inventory."PurGrnStatus", $14, $15, $12, $12, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            grnNo,
            body.poId ?? null,
            body.vendorId,
            body.storeId,
            body.invoiceNo ?? null,
            body.invoiceDate ?? null,
            body.dcNo ?? null,
            body.ewayBillNo ?? null,
            ctx.userId,
            settings.requireQcBeforeAccept ? 'qc_pending' : 'draft',
            body.withoutPo,
            body.remarks ?? null,
          ],
        );

        let lineNo = 1;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const received = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          const rejected = await this.uoms.toBase(tx, item, line.uomId, line.qtyRejectedEntered);
          const acceptedBase = (Number(received.qtyBase) - Number(rejected.qtyBase)).toFixed(4);
          if (Number(acceptedBase) < 0) {
            throw new AppError(
              ProblemType.VALIDATION_FAILED,
              `More of ${item.code} was rejected than was received.`,
            );
          }

          const net = line.unitCost * Number(received.qtyEntered);
          const tax = net * (line.gstRate / 100);

          await tx.query(
            `INSERT INTO inventory.pur_grn_lines
               (id, hospital_id, grn_id, line_no, po_line_id, item_id, uom_id,
                qty_received_entered, qty_received_base, qty_accepted_base, qty_rejected_base,
                free_qty_base, reject_reason, reject_note, batch_no, mfg_date, expiry_date, mrp,
                unit_cost, hsn_code, gst_rate, taxable, tax_amount, line_total, serials, udis,
                quarantine, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7,
                     $8::numeric, $9::numeric, $10::numeric, $11::numeric,
                     $12::numeric, $13::inventory."PurRejectReason", $14, $15, $16::date, $17::date,
                     $18::numeric, $19::numeric, $20, $21::numeric, $22::numeric, $23::numeric,
                     $24::numeric, $25::jsonb, '[]'::jsonb, $26, $27, $27, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              lineNo,
              line.poLineId ?? null,
              line.itemId,
              received.uomId,
              received.qtyEntered,
              received.qtyBase,
              acceptedBase,
              rejected.qtyBase,
              line.freeQtyBase,
              Number(rejected.qtyBase) > 0 ? (line.rejectReason ?? 'other') : null,
              line.rejectNote ?? null,
              line.batchNo ?? null,
              line.mfgDate ?? null,
              line.expiryDate ?? null,
              line.mrp ?? null,
              line.unitCost,
              line.hsnCode ?? item.hsn_code,
              line.gstRate,
              net.toFixed(2),
              tax.toFixed(2),
              (net + tax).toFixed(2),
              JSON.stringify(line.serials),
              line.quarantine,
              ctx.userId,
            ],
          );
          lineNo += 1;
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.pur_grns',
          rowId: id,
          businessKey: grnNo,
          dataClass: 'financial',
          before: null,
          after: { vendor_id: body.vendorId, store_id: body.storeId, lines: body.lines.length },
        });
      }),
    );

    return this.get(id);
  }

  /** The quality check. A rejection here is a rejection of the whole receipt. */
  async qc(id: string, body: GrnQcRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        assertStatus('This goods receipt', header.status, ['draft', 'qc_pending'], 'quality-checked');
        if (header.received_by !== null && header.received_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The person who received the goods cannot be the one who passes them on quality. That is the check.',
          );
        }

        await tx.query(
          `UPDATE inventory.pur_grns
              SET status = $2::inventory."PurGrnStatus", qc_by = $3, qc_at = now(), qc_notes = $4,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.outcome, ctx.userId, body.notes ?? null],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.pur_grns',
          rowId: id,
          businessKey: header.grn_no,
          dataClass: 'financial',
          reasonText: body.notes ?? null,
          before: { status: header.status },
          after: { status: body.outcome },
        });

        if (body.outcome === 'rejected') {
          const reason = await tx.maybeOne<{ reject_reason: string | null }>(
            `SELECT reject_reason::text AS reject_reason FROM inventory.pur_grn_lines
              WHERE grn_id = $1 AND reject_reason IS NOT NULL LIMIT 1`,
            [id],
          );
          await this.outbox.publish(
            tx,
            inventoryEvent('purchase.grn.rejected', id, {
              grnId: id,
              grnNo: header.grn_no,
              poId: header.po_id,
              vendorId: header.vendor_id,
              reason: reason?.reject_reason ?? 'quality_fail',
              note: body.notes ?? null,
              rejectedAt: new Date().toISOString(),
            }),
          );
        }
      }),
    );

    return this.get(id);
  }

  /**
   * Posting: the accepted quantity becomes stock, batch by batch.
   *
   * The `item_batches` row is created here — this is the only place in the
   * application that creates one, which is what makes "every batch was
   * received" true rather than aspirational. A line flagged `quarantine` creates
   * the batch in `quarantined`, so it is on the books and cannot reach a
   * patient, which is the correct state for stock awaiting a certificate of
   * analysis.
   */
  async post(id: string): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        assertStatus(
          'This goods receipt',
          header.status,
          ['draft', 'accepted', 'partially_accepted'],
          'posted',
        );
        if (header.posted_at !== null) {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This goods receipt has already been posted.');
        }

        const lines = await tx.rows<GrnLineRow>(GRN_LINE_SQL, [id]);
        let acceptedValue = 0;
        let acceptedLines = 0;
        let rejectedLines = 0;
        const eventLines: {
          grnLineId: string;
          itemId: string;
          batchNo: string | null;
          expiryDate: string | null;
          qtyAcceptedBase: string;
          unitCost: string;
        }[] = [];

        for (const line of lines) {
          if (Number(line.qty_rejected_base) > 0) rejectedLines += 1;
          if (Number(line.qty_accepted_base) <= 0) continue;
          acceptedLines += 1;

          const batchId = await this.ensureBatch(tx, header, line);
          const accepted = await this.uoms.fromBase(tx, line.item_id, line.uom_id, line.qty_accepted_base);

          const posted = await this.ledger.post(tx, {
            storeId: header.store_id,
            branchId: header.branch_id,
            itemId: line.item_id,
            batchId,
            movementType: 'grn',
            qtyEntered: accepted ?? line.qty_accepted_base,
            uomId: accepted === null ? undefined : line.uom_id,
            unitCost: Number(line.landed_unit_cost ?? line.unit_cost),
            refType: 'grn',
            refId: id,
            refLineId: line.id,
          });

          await tx.query(
            `UPDATE inventory.pur_grn_lines SET batch_id = $2, ledger_id = $3, updated_at = now()
              WHERE id = $1`,
            [line.id, batchId, posted.ledgerId],
          );

          if (line.free_qty_base !== null && Number(line.free_qty_base) > 0) {
            const free = await this.uoms.fromBase(tx, line.item_id, line.uom_id, line.free_qty_base);
            await this.ledger.post(tx, {
              storeId: header.store_id,
              branchId: header.branch_id,
              itemId: line.item_id,
              batchId,
              movementType: 'purchase_free',
              qtyEntered: free ?? line.free_qty_base,
              uomId: free === null ? undefined : line.uom_id,
              unitCost: 0,
              refType: 'grn',
              refId: id,
              refLineId: line.id,
              remarks: 'Free quantity supplied with the order',
            });
          }

          if (line.po_line_id !== null) {
            await tx.query(
              `UPDATE inventory.pur_po_lines
                  SET qty_received_base = qty_received_base + $2::numeric,
                      qty_rejected_base = qty_rejected_base + $3::numeric,
                      status = CASE WHEN qty_received_base + $2::numeric >= qty_base
                                    THEN 'received' ELSE 'partial' END,
                      updated_at = now()
                WHERE id = $1`,
              [line.po_line_id, line.qty_accepted_base, line.qty_rejected_base],
            );
          }

          acceptedValue += Number(line.taxable ?? 0) + Number(line.tax_amount ?? 0);
          eventLines.push({
            grnLineId: line.id,
            itemId: line.item_id,
            batchNo: line.batch_no,
            expiryDate: line.expiry_date,
            qtyAcceptedBase: quantityString(Number(line.qty_accepted_base)),
            unitCost: moneyString(Number(line.unit_cost)),
          });
        }

        const status = rejectedLines > 0 ? 'partially_accepted' : 'accepted';
        await tx.query(
          `UPDATE inventory.pur_grns
              SET status = $2::inventory."PurGrnStatus", posted_at = now(),
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, status, ctx.userId],
        );

        if (header.po_id !== null) {
          await tx.query(
            `UPDATE inventory.pur_purchase_orders po
                SET status = CASE
                      WHEN NOT EXISTS (SELECT 1 FROM inventory.pur_po_lines l
                                        WHERE l.po_id = po.id AND l.qty_received_base < l.qty_base)
                        THEN 'received'::inventory."PurPoStatus"
                      ELSE 'partially_received'::inventory."PurPoStatus"
                    END,
                    updated_at = now()
              WHERE po.id = $1 AND po.status NOT IN ('cancelled', 'short_closed')`,
            [header.po_id],
          );
        }

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.pur_grns',
          rowId: id,
          businessKey: header.grn_no,
          dataClass: 'financial',
          before: { status: header.status },
          after: { status, accepted_lines: acceptedLines, rejected_lines: rejectedLines },
        });

        if (rejectedLines > 0) {
          await this.outbox.publish(
            tx,
            inventoryEvent('purchase.grn.partial', id, {
              grnId: id,
              grnNo: header.grn_no,
              poId: header.po_id,
              vendorId: header.vendor_id,
              storeId: header.store_id,
              acceptedLines,
              rejectedLines,
              acceptedValue: moneyString(acceptedValue),
              currency: 'INR',
              receivedAt: new Date(header.received_at).toISOString(),
            }),
          );
        } else {
          await this.outbox.publish(
            tx,
            inventoryEvent('purchase.grn.accepted', id, {
              grnId: id,
              grnNo: header.grn_no,
              poId: header.po_id,
              vendorId: header.vendor_id,
              storeId: header.store_id,
              lineCount: acceptedLines,
              acceptedValue: moneyString(acceptedValue),
              currency: 'INR',
              lines: eventLines,
              receivedAt: new Date(header.received_at).toISOString(),
            }),
          );
        }
      }),
    );

    return this.get(id);
  }

  /**
   * Reversal. NC-005 §5 refuses it once the received stock has been issued, and
   * that check has to be here rather than in the database because the question
   * is about a *later* movement of the same batch, which no constraint on this
   * row can see.
   */
  async reverse(id: string, body: RejectRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        if (header.posted_at === null) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'This goods receipt has not been posted, so there is nothing to reverse. Cancel it instead.',
          );
        }

        const lines = await tx.rows<GrnLineRow>(GRN_LINE_SQL, [id]);
        for (const line of lines) {
          if (line.batch_id === null || Number(line.qty_accepted_base) <= 0) continue;
          const moved = await tx.one<{ n: string }>(
            `SELECT COALESCE(sum(-qty_base), 0)::text AS n
               FROM inventory.stock_ledger
              WHERE batch_id = $1 AND qty_base < 0 AND movement_type <> 'correction'`,
            [line.batch_id],
          );
          if (Number(moved.n) > 0) {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              `Batch ${line.batch_no ?? ''} has already been issued or dispensed, so this receipt cannot be reversed. Raise a purchase return for what is still on the shelf.`,
              { nextAction: 'Raise a purchase return instead.' },
            );
          }
          if (line.ledger_id === null) continue;

          await this.ledger.correct(tx, line.ledger_id, {
            qtyEntered: line.qty_accepted_base,
            direction: 'out',
            reason: `Goods receipt ${header.grn_no} reversed: ${body.reason}`,
          });
        }

        await tx.query(
          `UPDATE inventory.pur_grns
              SET status = 'cancelled'::inventory."PurGrnStatus", remarks = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.reason, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.pur_grns',
          rowId: id,
          businessKey: header.grn_no,
          dataClass: 'financial',
          reasonText: body.reason,
          before: { status: header.status },
          after: { status: 'cancelled' },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.grn.reversed', id, {
            grnId: id,
            grnNo: header.grn_no,
            reason: body.reason,
            reversedBy: ctx.userId,
            reversedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(id);
  }

  // ── purchase return ──────────────────────────────────────────────────────

  async createReturn(body: PurchaseReturnRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const returnNo = (
          await this.numbering.allocate(tx, {
            key: 'PRN',
            branchId,
            refType: 'inventory.pur_returns',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.pur_returns
             (id, hospital_id, branch_id, return_no, vendor_id, store_id, grn_id, reason,
              reason_note, debit_note_no, status, dispatched_at, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'dispatched', now(), $11, $11, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            returnNo,
            body.vendorId,
            body.storeId,
            body.grnId ?? null,
            body.reason,
            body.reasonNote ?? null,
            body.debitNoteNo ?? null,
            ctx.userId,
          ],
        );

        let lineNo = 1;
        let totalValue = 0;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          const balance = await this.ledger.balance(tx, body.storeId, line.itemId, line.batchId ?? null);
          const unitCost = line.unitCost ?? (balance === undefined ? 0 : Number(balance.avg_cost));
          const value = unitCost * Number(converted.qtyBase);
          totalValue += value;

          const lineId = newId();
          await tx.query(
            `INSERT INTO inventory.pur_return_lines
               (id, hospital_id, return_id, line_no, item_id, batch_id, uom_id, qty_entered,
                qty_base, unit_cost, gst_rate, value, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric,
                     $11::numeric, $12::numeric, $13, $13, now())`,
            [
              lineId,
              ctx.hospitalId,
              id,
              lineNo,
              line.itemId,
              line.batchId ?? null,
              converted.uomId,
              converted.qtyEntered,
              converted.qtyBase,
              unitCost,
              line.gstRate,
              value.toFixed(2),
              ctx.userId,
            ],
          );

          await this.ledger.post(tx, {
            storeId: body.storeId,
            itemId: line.itemId,
            batchId: line.batchId ?? null,
            movementType: 'vendor_return',
            qtyEntered: converted.qtyEntered,
            uomId: converted.uomId,
            unitCost,
            refType: 'purchase_return',
            refId: id,
            refLineId: lineId,
            reason: body.reasonNote ?? body.reason,
          });

          if (line.batchId !== undefined) {
            await tx.query(
              `UPDATE inventory.item_batches
                  SET status = 'returned_to_vendor'::inventory."InvBatchStatus", updated_at = now(),
                      updated_by = $2, version = version + 1
                WHERE id = $1
                  AND NOT EXISTS (SELECT 1 FROM inventory.stock_balances sb
                                   WHERE sb.batch_id = $1 AND sb.qty_on_hand > 0)`,
              [line.batchId, ctx.userId],
            );
          }
          lineNo += 1;
        }

        await tx.query(`UPDATE inventory.pur_returns SET total_value = $2::numeric WHERE id = $1`, [
          id,
          totalValue.toFixed(2),
        ]);

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.pur_returns',
          rowId: id,
          businessKey: returnNo,
          dataClass: 'financial',
          reasonText: body.reasonNote ?? body.reason,
          before: null,
          after: { vendor_id: body.vendorId, lines: body.lines.length, value: totalValue.toFixed(2) },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.return.dispatched', id, {
            returnId: id,
            returnNo,
            vendorId: body.vendorId,
            storeId: body.storeId,
            lineCount: body.lines.length,
            value: moneyString(totalValue),
            currency: 'INR',
            reason: body.reason,
            dispatchedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.purchaseReturn(id);
  }

  // ── the three-way match ──────────────────────────────────────────────────

  async captureInvoice(body: CaptureInvoiceRequest): Promise<InvoiceMatchView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const fy = await tx.one<{ fy: string }>(
          `SELECT CASE WHEN extract(month FROM $1::date) >= 4
                       THEN to_char($1::date, 'YYYY') || '-' || to_char($1::date + interval '1 year', 'YY')
                       ELSE to_char($1::date - interval '1 year', 'YYYY') || '-' || to_char($1::date, 'YY')
                  END AS fy`,
          [body.invoiceDate],
        );

        await tx.query(
          `INSERT INTO inventory.pur_vendor_invoices
             (id, hospital_id, branch_id, vendor_id, invoice_no, invoice_date, fy, gstin, irn,
              subtotal, tax_total, total, po_id, grn_ids, match_status,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9,
                   $10::numeric, $11::numeric, $12::numeric, $13, $14::uuid[],
                   'pending'::inventory."PurMatchStatus", $15, $15, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.vendorId,
            body.invoiceNo,
            body.invoiceDate,
            fy.fy,
            body.gstin ?? null,
            body.irn ?? null,
            body.subtotal,
            body.taxTotal,
            body.total,
            body.poId ?? null,
            body.grnIds,
            ctx.userId,
          ],
        );

        let lineNo = 1;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);

          const grn =
            line.grnLineId === undefined
              ? undefined
              : await tx.maybeOne<{ qty_accepted_base: string; unit_cost: string }>(
                  `SELECT qty_accepted_base::text AS qty_accepted_base, unit_cost::text AS unit_cost
                     FROM inventory.pur_grn_lines WHERE id = $1`,
                  [line.grnLineId],
                );
          const po =
            line.poLineId === undefined
              ? undefined
              : await tx.maybeOne<{ qty_base: string; rate_per_base: string | null; tax_amount: string }>(
                  `SELECT qty_base::text AS qty_base, rate_per_base::text AS rate_per_base,
                          tax_amount::text AS tax_amount
                     FROM inventory.pur_po_lines WHERE id = $1`,
                  [line.poLineId],
                );

          await tx.query(
            `INSERT INTO inventory.pur_invoice_match_lines
               (id, hospital_id, invoice_id, line_no, item_id, po_line_id, grn_line_id, uom_id,
                inv_qty_base, grn_qty_base, po_qty_base, inv_rate_per_base, po_rate_per_base,
                inv_tax, po_tax, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                     $9::numeric, $10::numeric, $11::numeric, $12::numeric, $13::numeric,
                     $14::numeric, $15::numeric, $16, $16, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              lineNo,
              line.itemId,
              line.poLineId ?? null,
              line.grnLineId ?? null,
              converted.uomId,
              converted.qtyBase,
              grn?.qty_accepted_base ?? '0',
              po?.qty_base ?? '0',
              line.ratePerBase,
              po?.rate_per_base ?? null,
              line.tax,
              po?.tax_amount ?? '0',
              ctx.userId,
            ],
          );

          if (line.poLineId !== undefined) {
            await tx.query(
              `UPDATE inventory.pur_po_lines
                  SET qty_invoiced_base = qty_invoiced_base + $2::numeric, updated_at = now()
                WHERE id = $1`,
              [line.poLineId, converted.qtyBase],
            );
          }
          lineNo += 1;
        }

        // The verdict is the trigger's. Read back rather than computed.
        const verdict = await tx.one<{ match_status: string }>(
          `SELECT match_status::text AS match_status FROM inventory.pur_vendor_invoices WHERE id = $1`,
          [id],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.pur_vendor_invoices',
          rowId: id,
          businessKey: body.invoiceNo,
          dataClass: 'financial',
          before: null,
          after: { vendor_id: body.vendorId, total: body.total, match_status: verdict.match_status },
        });

        const exceptionLines = await tx.one<{ n: string }>(
          `SELECT count(*)::text AS n FROM inventory.pur_invoice_match_lines
            WHERE invoice_id = $1 AND status NOT IN ('matched', 'approved_for_payment', 'posted')`,
          [id],
        );

        if (verdict.match_status === 'matched') {
          const withinTolerance = await tx.one<{ n: string }>(
            `SELECT count(*)::text AS n FROM inventory.pur_invoice_match_lines
              WHERE invoice_id = $1 AND within_tolerance`,
            [id],
          );
          await this.outbox.publish(
            tx,
            inventoryEvent('purchase.invoice.matched', id, {
              invoiceId: id,
              invoiceNo: body.invoiceNo,
              vendorId: body.vendorId,
              grossValue: moneyString(body.total),
              currency: 'INR',
              withinTolerance: Number(withinTolerance.n) > 0,
              matchedAt: new Date().toISOString(),
            }),
          );
        } else {
          await this.outbox.publish(
            tx,
            inventoryEvent('purchase.invoice.disputed', id, {
              invoiceId: id,
              invoiceNo: body.invoiceNo,
              vendorId: body.vendorId,
              matchStatus: verdict.match_status,
              exceptionLines: Math.max(1, Number(exceptionLines.n)),
              disputedValue: moneyString(body.total),
              currency: 'INR',
              raisedAt: new Date().toISOString(),
            }),
          );
        }
      }),
    );

    return this.invoice(id);
  }

  /**
   * Release to accounts payable.
   *
   * Refused while the match is anything but `matched`: an exception is not an
   * inconvenience to be clicked past, it is the control `phase-04` exit gate 1
   * tests. An exception that a hospital decides to pay anyway goes through
   * `dispute` first, which records why — and that record is what an auditor
   * reads.
   */
  async approveInvoice(id: string, body: ApproveInvoiceRequest): Promise<InvoiceMatchView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{
          match_status: string;
          invoice_no: string;
          vendor_id: string;
          total: string;
          created_by: string | null;
        }>(
          `SELECT match_status::text AS match_status, invoice_no, vendor_id, total::text AS total,
                  created_by
             FROM inventory.pur_vendor_invoices WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The vendor invoice');
        if (header.match_status === 'approved_for_payment' || header.match_status === 'posted') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This invoice is already released for payment.');
        }
        if (header.match_status !== 'matched' && header.match_status !== 'disputed') {
          throw new AppError(
            ProblemType.APPROVAL_REQUIRED,
            `This invoice is "${header.match_status}" against its purchase order and goods receipt. Resolve the exception, or record a dispute decision, before releasing it for payment.`,
            { nextAction: 'Open the exception queue and settle the difference with the vendor.' },
          );
        }
        if (header.created_by !== null && header.created_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The person who captured an invoice cannot be the one who releases it for payment (NC-005 §12).',
          );
        }

        await tx.query(
          `UPDATE inventory.pur_vendor_invoices
              SET match_status = 'approved_for_payment'::inventory."PurMatchStatus",
                  approved_by = $2, approved_at = now(), exception_note = COALESCE($3, exception_note),
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId, body.note ?? null],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.pur_vendor_invoices',
          rowId: id,
          businessKey: header.invoice_no,
          dataClass: 'financial',
          reasonText: body.note ?? null,
          before: { match_status: header.match_status },
          after: { match_status: 'approved_for_payment' },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.invoice.approved_for_payment', id, {
            invoiceId: id,
            invoiceNo: header.invoice_no,
            vendorId: header.vendor_id,
            payableValue: moneyString(Number(header.total)),
            currency: 'INR',
            dueDate: body.dueDate ?? null,
            approvedBy: ctx.userId,
            approvedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.invoice(id);
  }

  async disputeInvoice(id: string, body: DisputeInvoiceRequest): Promise<InvoiceMatchView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{ match_status: string; invoice_no: string }>(
          `SELECT match_status::text AS match_status, invoice_no
             FROM inventory.pur_vendor_invoices WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The vendor invoice');

        await tx.query(
          `UPDATE inventory.pur_vendor_invoices
              SET match_status = 'disputed'::inventory."PurMatchStatus", exception_note = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.reason, ctx.userId],
        );
        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.pur_vendor_invoices',
          rowId: id,
          businessKey: header.invoice_no,
          dataClass: 'financial',
          reasonText: body.reason,
          before: { match_status: header.match_status },
          after: { match_status: 'disputed' },
        });
      }),
    );
    return this.invoice(id);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<GrnHeaderRow>(GRN_HEADER_SQL, [id]);
      if (header === undefined) throw AppError.notFound('The goods receipt');
      const lines = await tx.rows<GrnLineRow & { item_code: string; item_name: string }>(
        `${GRN_LINE_SQL_WITH_ITEM}`,
        [id],
      );

      const views: DocumentLineView[] = lines.map((l) => ({
        id: l.id,
        lineNo: l.line_no,
        itemId: l.item_id,
        itemCode: l.item_code,
        itemName: l.item_name,
        batchId: l.batch_id,
        batchNo: l.batch_no,
        uomId: l.uom_id,
        qtyEntered: l.qty_received_entered,
        qtyBase: l.qty_received_base,
        status: Number(l.qty_rejected_base) > 0 ? 'partially_rejected' : 'accepted',
        extra: {
          qtyAcceptedBase: l.qty_accepted_base,
          qtyRejectedBase: l.qty_rejected_base,
          rejectReason: l.reject_reason,
          expiryDate: l.expiry_date,
          unitCost: l.unit_cost,
          lineTotal: l.line_total,
          ledgerId: l.ledger_id,
        },
      }));

      return {
        id: header.id,
        documentNo: header.grn_no,
        status: header.status,
        storeId: header.store_id,
        counterpartyId: header.vendor_id,
        createdAt: new Date(header.created_at).toISOString(),
        lines: views,
        header: {
          poId: header.po_id,
          invoiceNo: header.invoice_no,
          receivedAt: new Date(header.received_at).toISOString(),
          postedAt: header.posted_at === null ? null : new Date(header.posted_at).toISOString(),
          withoutPo: header.without_po,
          qcBy: header.qc_by,
        },
      };
    });
  }

  async purchaseReturn(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<{
        id: string;
        return_no: string;
        status: string;
        vendor_id: string;
        store_id: string;
        reason: string;
        total_value: string | null;
        created_at: string;
      }>(
        `SELECT id, return_no, status, vendor_id, store_id, reason, total_value::text AS total_value,
                created_at::text AS created_at
           FROM inventory.pur_returns WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The purchase return');

      const rows = await tx.rows<{
        id: string;
        line_no: number;
        item_id: string;
        item_code: string;
        item_name: string;
        batch_id: string | null;
        batch_no: string | null;
        uom_id: string;
        qty_entered: string;
        qty_base: string;
        value: string | null;
      }>(
        `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name,
                l.batch_id, b.batch_no, l.uom_id, l.qty_entered::text AS qty_entered,
                l.qty_base::text AS qty_base, l.value::text AS value
           FROM inventory.pur_return_lines l
           JOIN inventory.items i ON i.id = l.item_id
           LEFT JOIN inventory.item_batches b ON b.id = l.batch_id
          WHERE l.return_id = $1 ORDER BY l.line_no`,
        [id],
      );

      return {
        id: header.id,
        documentNo: header.return_no,
        status: header.status,
        storeId: header.store_id,
        counterpartyId: header.vendor_id,
        createdAt: new Date(header.created_at).toISOString(),
        lines: rows.map((r) => ({
          id: r.id,
          lineNo: r.line_no,
          itemId: r.item_id,
          itemCode: r.item_code,
          itemName: r.item_name,
          batchId: r.batch_id,
          batchNo: r.batch_no,
          uomId: r.uom_id,
          qtyEntered: r.qty_entered,
          qtyBase: r.qty_base,
          status: null,
          extra: { value: r.value },
        })),
        header: { reason: header.reason, totalValue: header.total_value },
      };
    });
  }

  async invoice(id: string): Promise<InvoiceMatchView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<{
        id: string;
        invoice_no: string;
        vendor_id: string;
        match_status: string;
        total: string;
      }>(
        `SELECT id, invoice_no, vendor_id, match_status::text AS match_status, total::text AS total
           FROM inventory.pur_vendor_invoices WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The vendor invoice');

      const lines = await tx.rows<{
        id: string;
        item_id: string;
        item_code: string;
        status: string;
        inv_qty_base: string;
        grn_qty_base: string;
        po_qty_base: string;
        qty_diff_base: string;
        rate_diff: string;
        tax_diff: string;
        within_tolerance: boolean;
      }>(
        `SELECT l.id, l.item_id, i.code AS item_code, l.status::text AS status,
                l.inv_qty_base::text AS inv_qty_base, l.grn_qty_base::text AS grn_qty_base,
                l.po_qty_base::text AS po_qty_base, l.qty_diff_base::text AS qty_diff_base,
                l.rate_diff::text AS rate_diff, l.tax_diff::text AS tax_diff, l.within_tolerance
           FROM inventory.pur_invoice_match_lines l
           JOIN inventory.items i ON i.id = l.item_id
          WHERE l.invoice_id = $1 ORDER BY l.line_no`,
        [id],
      );

      return {
        invoiceId: header.id,
        invoiceNo: header.invoice_no,
        vendorId: header.vendor_id,
        matchStatus: header.match_status,
        total: header.total,
        lines: lines.map((l) => ({
          id: l.id,
          itemId: l.item_id,
          itemCode: l.item_code,
          status: l.status,
          invQtyBase: l.inv_qty_base,
          grnQtyBase: l.grn_qty_base,
          poQtyBase: l.po_qty_base,
          qtyDiffBase: l.qty_diff_base,
          rateDiff: l.rate_diff,
          taxDiff: l.tax_diff,
          withinTolerance: l.within_tolerance,
        })),
      };
    });
  }

  async listGrns(query: GrnQuery): Promise<Page<DocumentView>> {
    const hospital = hospitalId();
    const resource = 'inventory.grns';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    const ids = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.vendorId !== undefined) clauses.push(`g.vendor_id = ${bind(query.vendorId)}::uuid`);
      if (query.storeId !== undefined) clauses.push(`g.store_id = ${bind(query.storeId)}::uuid`);
      if (query.poId !== undefined) clauses.push(`g.po_id = ${bind(query.poId)}::uuid`);
      if (query.status !== undefined) clauses.push(`g.status::text = ${bind(query.status)}`);
      if (after !== null) {
        clauses.push(`(g.created_at, g.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      return tx.rows<{ id: string; cursor_key: string }>(
        `SELECT g.id, g.created_at::text AS cursor_key FROM inventory.pur_grns g
         ${where} ORDER BY g.created_at DESC, g.id DESC LIMIT ${bind(limit + 1)}`,
        values,
      );
    });

    const page = this.cursors.keysetPage<{ id: string }>(ids, limit, {
      hospitalId: hospital,
      resource,
      direction: 'desc',
    });
    const items: DocumentView[] = [];
    for (const row of page.items) items.push(await this.get(row.id));
    return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  /** The exception queue — `phase-04` exit gate 1's final sentence. */
  async listInvoices(query: InvoiceQuery): Promise<Page<InvoiceMatchView>> {
    const hospital = hospitalId();
    const resource = 'inventory.invoices';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    const ids = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.vendorId !== undefined) clauses.push(`v.vendor_id = ${bind(query.vendorId)}::uuid`);
      if (query.matchStatus !== undefined) clauses.push(`v.match_status::text = ${bind(query.matchStatus)}`);
      if (query.exceptionsOnly) {
        clauses.push(
          `v.match_status IN ('qty_mismatch','price_mismatch','tax_mismatch','no_grn','duplicate','disputed')`,
        );
      }
      if (after !== null) {
        clauses.push(`(v.created_at, v.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      return tx.rows<{ id: string; cursor_key: string }>(
        `SELECT v.id, v.created_at::text AS cursor_key FROM inventory.pur_vendor_invoices v
         ${where} ORDER BY v.created_at DESC, v.id DESC LIMIT ${bind(limit + 1)}`,
        values,
      );
    });

    const page = this.cursors.keysetPage<{ id: string }>(ids, limit, {
      hospitalId: hospital,
      resource,
      direction: 'desc',
    });
    const items: InvoiceMatchView[] = [];
    for (const row of page.items) items.push(await this.invoice(row.id));
    return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async lock(tx: TransactionClient, id: string): Promise<GrnHeaderRow> {
    const header = await tx.maybeOne<GrnHeaderRow>(`${GRN_HEADER_SQL} FOR UPDATE`, [id]);
    if (header === undefined) throw AppError.notFound('The goods receipt');
    return header;
  }

  /**
   * The batch, created here or matched to one already received from the same
   * vendor with the same number.
   *
   * Matching rather than always creating is what makes two deliveries of the
   * same lot one batch on the shelf — which is what a recall needs, and what a
   * pharmacist expects when they scan two boxes with the same number printed on
   * them.
   */
  private async ensureBatch(
    tx: TransactionClient,
    header: GrnHeaderRow,
    line: GrnLineRow,
  ): Promise<string | null> {
    const ctx = getContext();
    const item = await this.uoms.item(tx, line.item_id);
    if (item.tracking === 'none') return null;
    if (line.batch_id !== null) return line.batch_id;
    if (line.batch_no === null) {
      // Unreachable for a tracked item: `enforce_grn_line` refuses it. Kept
      // because the alternative to a refusal here is a batch called "null".
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `${item.code} is batch-tracked and this receipt line names no batch number.`,
      );
    }

    const existing = await tx.maybeOne<{ id: string }>(
      `SELECT id FROM inventory.item_batches
        WHERE item_id = $1 AND batch_no = $2 AND vendor_id IS NOT DISTINCT FROM $3`,
      [line.item_id, line.batch_no, header.vendor_id],
    );
    if (existing !== undefined) return existing.id;

    const id = newId();
    await tx.query(
      `INSERT INTO inventory.item_batches
         (id, hospital_id, item_id, batch_no, mfg_date, expiry_date, mrp, unit_cost, vendor_id,
          grn_line_id, status, received_at, created_by, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5::date, $6::date, $7::numeric, $8::numeric, $9, $10,
               $11::inventory."InvBatchStatus", $12::timestamptz, $13, $13, now())`,
      [
        id,
        ctx.hospitalId,
        line.item_id,
        line.batch_no,
        line.mfg_date,
        line.expiry_date,
        line.mrp,
        line.landed_unit_cost ?? line.unit_cost,
        header.vendor_id,
        line.id,
        line.quarantine ? 'quarantined' : 'active',
        header.received_at,
        ctx.userId,
      ],
    );

    if (line.quarantine) {
      await tx.query(
        `INSERT INTO inventory.quarantines
           (id, hospital_id, batch_id, scope, store_id, reason, started_at, decision,
            created_by, updated_by, updated_at)
         VALUES ($1, $2, $3, 'store', $4, 'quality'::inventory."InvQuarantineReason",
                 now(), 'pending', $5, $5, now())`,
        [newId(), ctx.hospitalId, id, header.store_id, ctx.userId],
      );
    }

    // Serial and UDI capture for implants (NC-007 §3): one row per serial, so
    // "which implant went into which patient" has somewhere to be recorded.
    const serials = Array.isArray(line.serials) ? line.serials : [];
    for (const entry of serials) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as { serialNo?: unknown; udi?: unknown };
      if (typeof record.serialNo !== 'string') continue;
      await tx.query(
        `INSERT INTO inventory.item_serials
           (id, hospital_id, item_id, batch_id, serial_no, udi_full, status, current_store_id,
            created_by, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'in_stock'::inventory."InvSerialStatus", $7, $8, $8, now())`,
        [
          newId(),
          ctx.hospitalId,
          line.item_id,
          id,
          record.serialNo,
          typeof record.udi === 'string' ? record.udi : null,
          header.store_id,
          ctx.userId,
        ],
      );
    }

    return id;
  }
}

const GRN_HEADER_SQL = `SELECT id, grn_no, status::text AS status, po_id, vendor_id, store_id, branch_id,
        invoice_no, invoice_date::text AS invoice_date, received_at::text AS received_at,
        received_by, qc_by, posted_at::text AS posted_at, without_po, created_at::text AS created_at
   FROM inventory.pur_grns WHERE id = $1`;

const GRN_LINE_COLUMNS = `l.id, l.line_no, l.po_line_id, l.item_id, l.uom_id,
        l.qty_received_entered::text AS qty_received_entered,
        l.qty_received_base::text AS qty_received_base,
        l.qty_accepted_base::text AS qty_accepted_base,
        l.qty_rejected_base::text AS qty_rejected_base,
        l.free_qty_base::text AS free_qty_base,
        l.reject_reason::text AS reject_reason, l.batch_no, l.batch_id,
        l.mfg_date::text AS mfg_date, l.expiry_date::text AS expiry_date, l.mrp::text AS mrp,
        l.unit_cost::text AS unit_cost, l.landed_unit_cost::text AS landed_unit_cost,
        l.taxable::text AS taxable, l.tax_amount::text AS tax_amount,
        l.line_total::text AS line_total, l.serials, l.quarantine, l.ledger_id`;

const GRN_LINE_SQL = `SELECT ${GRN_LINE_COLUMNS}
   FROM inventory.pur_grn_lines l WHERE l.grn_id = $1 ORDER BY l.line_no`;

const GRN_LINE_SQL_WITH_ITEM = `SELECT ${GRN_LINE_COLUMNS}, i.code AS item_code, i.name AS item_name
   FROM inventory.pur_grn_lines l JOIN inventory.items i ON i.id = l.item_id
  WHERE l.grn_id = $1 ORDER BY l.line_no`;

interface GrnHeaderRow {
  readonly id: string;
  readonly grn_no: string;
  readonly status: string;
  readonly po_id: string | null;
  readonly vendor_id: string;
  readonly store_id: string;
  readonly branch_id: string;
  readonly invoice_no: string | null;
  readonly invoice_date: string | null;
  readonly received_at: string;
  readonly received_by: string | null;
  readonly qc_by: string | null;
  readonly posted_at: string | null;
  readonly without_po: boolean;
  readonly created_at: string;
}

interface GrnLineRow {
  readonly id: string;
  readonly line_no: number;
  readonly po_line_id: string | null;
  readonly item_id: string;
  readonly uom_id: string;
  readonly qty_received_entered: string;
  readonly qty_received_base: string;
  readonly qty_accepted_base: string;
  readonly qty_rejected_base: string;
  readonly free_qty_base: string | null;
  readonly reject_reason: string | null;
  readonly batch_no: string | null;
  readonly batch_id: string | null;
  readonly mfg_date: string | null;
  readonly expiry_date: string | null;
  readonly mrp: string | null;
  readonly unit_cost: string;
  readonly landed_unit_cost: string | null;
  readonly taxable: string | null;
  readonly tax_amount: string | null;
  readonly line_total: string | null;
  readonly serials: unknown;
  readonly quarantine: boolean;
  readonly ledger_id: string | null;
}
