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
  requireBranch,
  withInventoryErrors,
} from './inventory.common.js';
import { inventoryEvent } from './inventory.events.js';
import type {
  CreateTransferRequest,
  DispatchTransferRequest,
  ReceiveTransferRequest,
  RejectRequest,
  TransferQuery,
} from './inventory.schemas.js';
import type { DocumentLineView, DocumentView } from './inventory.types.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { UomService } from './uom.service.js';

/**
 * NC-006 §3.6 — inter-store and inter-branch transfers, with a real in-transit
 * state.
 *
 * The state machine is `requested → approved → dispatched/in_transit →
 * received`, and the stock moves at exactly two of those transitions: out of the
 * sending store on dispatch, into the receiving store on receipt. Between them
 * the units are in neither balance and `sum(ledger)` for the pair is short by
 * exactly what is on the van — which is the number a reconciliation is looking
 * for, and which a one-step transfer destroys.
 *
 * **A discrepancy is raised, never absorbed.** If what arrives is not what left,
 * the difference is stock that is *somewhere*, and `inventory.transfer.
 * discrepancy` says so with both stores named. Quietly writing the shortfall off
 * at the receiving end would turn a theft, a mis-pick and a miscount into the
 * same invisible event.
 *
 * A transfer that crosses branches is also a GST-relevant supply — the schema
 * carries `tax_invoice_no` and `eway_bill_no` for it — so the dispatch step
 * takes them and records them on the document rather than inventing them.
 */
@Injectable()
export class TransfersService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(UomService) private readonly uoms: UomService,
  ) {}

  async create(body: CreateTransferRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        if (body.fromStoreId === body.toStoreId) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            'A transfer moves stock between two stores. Naming one store twice moves nothing.',
          );
        }

        const from = await this.storeBranch(tx, body.fromStoreId);
        const to = await this.storeBranch(tx, body.toStoreId);
        const transferNo = (
          await this.numbering.allocate(tx, {
            key: 'TRANSFER',
            branchId,
            refType: 'inventory.transfers',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.transfers
             (id, hospital_id, transfer_no, from_branch_id, to_branch_id, from_store_id, to_store_id,
              status, remarks, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested'::inventory."InvTransferStatus",
                   $8, $9, $9, now())`,
          [
            id,
            ctx.hospitalId,
            transferNo,
            from,
            body.toBranchId ?? to,
            body.fromStoreId,
            body.toStoreId,
            body.remarks ?? null,
            ctx.userId,
          ],
        );

        let lineNo = 1;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          const batchId =
            line.batchId ?? (await this.firstExpiring(tx, body.fromStoreId, line.itemId, item.tracking));
          const balance = await this.ledger.balance(tx, body.fromStoreId, line.itemId, batchId);
          const unitCost = balance === undefined ? null : Number(balance.avg_cost);

          await tx.query(
            `INSERT INTO inventory.transfer_lines
               (id, hospital_id, transfer_id, line_no, item_id, batch_id, uom_id, qty_entered,
                qty_base, unit_cost, taxable_value, hsn_code, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric,
                     $11::numeric, $12, $13, $13, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              lineNo,
              line.itemId,
              batchId,
              converted.uomId,
              converted.qtyEntered,
              converted.qtyBase,
              unitCost,
              unitCost === null ? null : (Number(converted.qtyBase) * unitCost).toFixed(2),
              item.hsn_code,
              ctx.userId,
            ],
          );
          lineNo += 1;
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.transfers',
          rowId: id,
          businessKey: transferNo,
          dataClass: 'operational',
          before: null,
          after: { from_store_id: body.fromStoreId, to_store_id: body.toStoreId, lines: body.lines.length },
        });
      }),
    );

    return this.get(id);
  }

  async approve(id: string): Promise<DocumentView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        assertStatus('This transfer', header.status, ['requested', 'pending_approval'], 'approved');
        if (header.created_by !== null && header.created_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The person who raised a transfer cannot be the one who approves it.',
          );
        }
        await tx.query(
          `UPDATE inventory.transfers
              SET status = 'approved'::inventory."InvTransferStatus",
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId],
        );
        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.transfers',
          rowId: id,
          businessKey: header.transfer_no,
          dataClass: 'operational',
          before: { status: header.status },
          after: { status: 'approved' },
        });
      }),
    );
    return this.get(id);
  }

  /** Stock leaves the sending store here, and belongs to no store until receipt. */
  async dispatch(id: string, body: DispatchTransferRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        assertStatus('This transfer', header.status, ['approved'], 'dispatched');

        const lines = await this.lineRows(tx, id);
        let totalValue = 0;
        for (const line of lines) {
          await this.ledger.post(tx, {
            storeId: header.from_store_id,
            branchId: header.from_branch_id,
            itemId: line.item_id,
            batchId: line.batch_id,
            movementType: 'transfer_out',
            qtyEntered: line.qty_entered,
            uomId: line.uom_id,
            unitCost: line.unit_cost === null ? null : Number(line.unit_cost),
            refType: 'transfer',
            refId: id,
            refLineId: line.id,
            counterStoreId: header.to_store_id,
          });
          totalValue += line.unit_cost === null ? 0 : Number(line.qty_base) * Number(line.unit_cost);
        }

        await tx.query(
          `UPDATE inventory.transfers
              SET status = 'in_transit'::inventory."InvTransferStatus", dispatched_at = now(),
                  gate_pass_no = $2, eway_bill_no = $3, tax_invoice_no = $4, total_value = $5::numeric,
                  updated_at = now(), updated_by = $6, version = version + 1
            WHERE id = $1`,
          [
            id,
            body.gatePassNo ?? null,
            body.ewayBillNo ?? null,
            body.taxInvoiceNo ?? null,
            totalValue.toFixed(2),
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.transfers',
          rowId: id,
          businessKey: header.transfer_no,
          dataClass: 'operational',
          before: { status: header.status },
          after: { status: 'in_transit', gate_pass_no: body.gatePassNo ?? null },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.transfer.dispatched', id, {
            transferId: id,
            transferNo: header.transfer_no,
            fromStoreId: header.from_store_id,
            toStoreId: header.to_store_id,
            lineCount: lines.length,
            value: moneyString(totalValue),
            dispatchedBy: ctx.userId,
            dispatchedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(id);
  }

  /** What arrived enters the receiving store; what did not is raised, not absorbed. */
  async receive(id: string, body: ReceiveTransferRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        assertStatus(
          'This transfer',
          header.status,
          ['dispatched', 'in_transit', 'partially_received'],
          'received',
        );

        let shortLines = 0;
        let excessLines = 0;
        const reasons: string[] = [];

        for (const decision of body.lines) {
          const line = await tx.maybeOne<TransferLineRow>(
            `SELECT id, item_id, batch_id, uom_id, qty_entered::text AS qty_entered,
                    qty_base::text AS qty_base, qty_received_base::text AS qty_received_base,
                    unit_cost::text AS unit_cost
               FROM inventory.transfer_lines WHERE id = $1 AND transfer_id = $2`,
            [decision.lineId, id],
          );
          if (line === undefined) throw AppError.notFound('The transfer line');

          const item = await this.uoms.item(tx, line.item_id);
          const converted = await this.uoms.toBase(tx, item, decision.uomId, decision.qtyReceivedEntered);
          const received = Number(converted.qtyBase);
          const dispatched = Number(line.qty_base);

          if (received < dispatched) shortLines += 1;
          if (received > dispatched) excessLines += 1;
          if (decision.discrepancyReason !== undefined) reasons.push(decision.discrepancyReason);

          if (received > 0) {
            await this.ledger.post(tx, {
              storeId: header.to_store_id,
              branchId: header.to_branch_id,
              itemId: line.item_id,
              batchId: line.batch_id,
              movementType: 'transfer_in',
              qtyEntered: converted.qtyEntered,
              uomId: converted.uomId,
              unitCost: line.unit_cost === null ? null : Number(line.unit_cost),
              refType: 'transfer',
              refId: id,
              refLineId: line.id,
              counterStoreId: header.from_store_id,
              reason: decision.discrepancyReason ?? null,
            });
          }

          await tx.query(
            `UPDATE inventory.transfer_lines
                SET qty_received_base = $2::numeric, discrepancy_reason = $3,
                    updated_at = now(), updated_by = $4
              WHERE id = $1`,
            [line.id, converted.qtyBase, decision.discrepancyReason ?? null, ctx.userId],
          );
        }

        const discrepancy = shortLines > 0 || excessLines > 0;
        await tx.query(
          `UPDATE inventory.transfers
              SET status = $2::inventory."InvTransferStatus", received_at = now(),
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, discrepancy ? 'partially_received' : 'received', ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.transfers',
          rowId: id,
          businessKey: header.transfer_no,
          dataClass: 'operational',
          before: { status: header.status },
          after: {
            status: discrepancy ? 'partially_received' : 'received',
            short_lines: shortLines,
            excess_lines: excessLines,
          },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.transfer.received', id, {
            transferId: id,
            transferNo: header.transfer_no,
            toStoreId: header.to_store_id,
            receivedBy: ctx.userId,
            receivedAt: new Date().toISOString(),
            fullyReceived: !discrepancy,
          }),
        );

        if (discrepancy) {
          await this.outbox.publish(
            tx,
            inventoryEvent('inventory.transfer.discrepancy', id, {
              transferId: id,
              transferNo: header.transfer_no,
              fromStoreId: header.from_store_id,
              toStoreId: header.to_store_id,
              shortLines,
              excessLines,
              reason:
                reasons.length > 0
                  ? reasons.join('; ')
                  : 'What arrived does not match what was dispatched, and no reason was recorded at the receiving end.',
              reportedBy: ctx.userId,
              reportedAt: new Date().toISOString(),
            }),
          );
        }
      }),
    );

    return this.get(id);
  }

  async cancel(id: string, body: RejectRequest): Promise<DocumentView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lock(tx, id);
        // Once stock is on a van it cannot be cancelled — it can only be
        // received, short or otherwise. Cancelling would leave the units in no
        // store at all, permanently.
        assertStatus(
          'This transfer',
          header.status,
          ['requested', 'pending_approval', 'approved'],
          'cancelled',
        );
        await tx.query(
          `UPDATE inventory.transfers
              SET status = 'cancelled'::inventory."InvTransferStatus", remarks = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.reason, ctx.userId],
        );
        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.transfers',
          rowId: id,
          businessKey: header.transfer_no,
          dataClass: 'operational',
          reasonText: body.reason,
          before: { status: header.status },
          after: { status: 'cancelled' },
        });
      }),
    );
    return this.get(id);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<TransferHeaderRow>(
        `SELECT id, transfer_no, status::text AS status, from_store_id, to_store_id,
                from_branch_id, to_branch_id, gate_pass_no, eway_bill_no, tax_invoice_no,
                total_value::text AS total_value, created_by, created_at::text AS created_at
           FROM inventory.transfers WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The transfer');

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
        qty_received_base: string;
        discrepancy_reason: string | null;
      }>(
        `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name,
                l.batch_id, b.batch_no, l.uom_id, l.qty_entered::text AS qty_entered,
                l.qty_base::text AS qty_base, l.qty_received_base::text AS qty_received_base,
                l.discrepancy_reason
           FROM inventory.transfer_lines l
           JOIN inventory.items i ON i.id = l.item_id
           LEFT JOIN inventory.item_batches b ON b.id = l.batch_id
          WHERE l.transfer_id = $1 ORDER BY l.line_no`,
        [id],
      );

      const lines: DocumentLineView[] = rows.map((r) => ({
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
        extra: { qtyReceivedBase: r.qty_received_base, discrepancyReason: r.discrepancy_reason },
      }));

      return {
        id: header.id,
        documentNo: header.transfer_no,
        status: header.status,
        storeId: header.from_store_id,
        counterpartyId: header.to_store_id,
        createdAt: new Date(header.created_at).toISOString(),
        lines,
        header: {
          fromBranchId: header.from_branch_id,
          toBranchId: header.to_branch_id,
          gatePassNo: header.gate_pass_no,
          ewayBillNo: header.eway_bill_no,
          taxInvoiceNo: header.tax_invoice_no,
          totalValue: header.total_value,
        },
      };
    });
  }

  async list(query: TransferQuery): Promise<Page<DocumentView>> {
    const hospital = hospitalId();
    const resource = 'inventory.transfers';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    const ids = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.fromStoreId !== undefined) clauses.push(`t.from_store_id = ${bind(query.fromStoreId)}::uuid`);
      if (query.toStoreId !== undefined) clauses.push(`t.to_store_id = ${bind(query.toStoreId)}::uuid`);
      if (query.status !== undefined) clauses.push(`t.status::text = ${bind(query.status)}`);
      if (after !== null) {
        clauses.push(`(t.created_at, t.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      return tx.rows<{ id: string; cursor_key: string }>(
        `SELECT t.id, t.created_at::text AS cursor_key FROM inventory.transfers t
         ${where} ORDER BY t.created_at DESC, t.id DESC LIMIT ${bind(limit + 1)}`,
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

  // ── helpers ──────────────────────────────────────────────────────────────

  private async lock(tx: TransactionClient, id: string): Promise<TransferHeaderRow> {
    const header = await tx.maybeOne<TransferHeaderRow>(
      `SELECT id, transfer_no, status::text AS status, from_store_id, to_store_id,
              from_branch_id, to_branch_id, gate_pass_no, eway_bill_no, tax_invoice_no,
              total_value::text AS total_value, created_by, created_at::text AS created_at
         FROM inventory.transfers WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (header === undefined) throw AppError.notFound('The transfer');
    return header;
  }

  private async lineRows(tx: TransactionClient, id: string): Promise<readonly TransferLineRow[]> {
    return tx.rows<TransferLineRow>(
      `SELECT id, item_id, batch_id, uom_id, qty_entered::text AS qty_entered,
              qty_base::text AS qty_base, qty_received_base::text AS qty_received_base,
              unit_cost::text AS unit_cost
         FROM inventory.transfer_lines WHERE transfer_id = $1 ORDER BY line_no`,
      [id],
    );
  }

  private async storeBranch(tx: TransactionClient, storeId: string): Promise<string> {
    const row = await tx.maybeOne<{ branch_id: string }>(
      `SELECT branch_id FROM inventory.stores WHERE id = $1 AND deleted_at IS NULL`,
      [storeId],
    );
    if (row === undefined) throw AppError.notFound('The store');
    return row.branch_id;
  }

  private async firstExpiring(
    tx: TransactionClient,
    storeId: string,
    itemId: string,
    tracking: string,
  ): Promise<string | null> {
    const batches = await this.ledger.fefo(tx, storeId, itemId);
    const first = batches[0];
    if (first !== undefined) return first.batch_id;
    if (tracking === 'none') return null;
    throw new AppError(
      ProblemType.BUSINESS_RULE_VIOLATED,
      'There is no issuable batch of that item in the sending store — every batch is empty, expired or quarantined.',
    );
  }
}

interface TransferHeaderRow {
  readonly id: string;
  readonly transfer_no: string;
  readonly status: string;
  readonly from_store_id: string;
  readonly to_store_id: string;
  readonly from_branch_id: string;
  readonly to_branch_id: string;
  readonly gate_pass_no: string | null;
  readonly eway_bill_no: string | null;
  readonly tax_invoice_no: string | null;
  readonly total_value: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
}

interface TransferLineRow {
  readonly id: string;
  readonly item_id: string;
  readonly batch_id: string | null;
  readonly uom_id: string;
  readonly qty_entered: string;
  readonly qty_base: string;
  readonly qty_received_base: string;
  readonly unit_cost: string | null;
}
