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
  ApproveIndentRequest,
  CreateIssueRequest,
  CreateReturnToStoreRequest,
  CreateStoreIndentRequest,
  InspectReturnRequest,
  ReceiveIssueRequest,
  RejectRequest,
  StoreQuery,
} from './inventory.schemas.js';
import type { DocumentLineView, DocumentView } from './inventory.types.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { UomService } from './uom.service.js';

/**
 * NC-006 §3.5 — indent → pick → issue → acknowledge → return, and the
 * in-transit state in the middle of it.
 *
 * **Stock leaves the issuing store when it is issued, and arrives at the
 * receiving store when it is acknowledged — not before.** Two ledger rows in two
 * different transactions, minutes or hours apart, with the units belonging to
 * neither store in between. That gap is not an accounting inconvenience; it is
 * the physical truth (the box is on a trolley in a corridor) and it is the only
 * arrangement in which a discrepancy is visible at all. A design that moved the
 * stock in one step would make a short delivery indistinguishable from a
 * miscount at the far end, which is exactly the argument the two stores will be
 * having.
 *
 * **FEFO is the default and an override is a documented decision.** The pick
 * list carries `suggested_batch_id` from `inventory.fefo_batches`, and
 * `pick_list_lines_override_documented` refuses a picked batch that differs from
 * the suggestion without a reason. This service applies the same rule to a
 * direct issue, so the two paths cannot disagree about what an override is.
 */
@Injectable()
export class IndentsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(UomService) private readonly uoms: UomService,
  ) {}

  // ── store indents ────────────────────────────────────────────────────────

  async createIndent(body: CreateStoreIndentRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        if (body.fromStoreId === body.toStoreId) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            'An indent asks one store for stock on behalf of another. Naming the same store twice is a stock take, not an indent.',
          );
        }

        const indentNo = (
          await this.numbering.allocate(tx, {
            key: 'INDENT',
            branchId,
            refType: 'inventory.store_indents',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.store_indents
             (id, hospital_id, branch_id, indent_no, from_store_id, to_store_id, indent_type,
              status, required_by, justification, requested_by, submitted_at,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::inventory."InvIndentType",
                   'submitted'::inventory."InvIndentStatus", $8::date, $9, $10, now(), $10, $10, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            indentNo,
            body.fromStoreId,
            body.toStoreId,
            body.indentType,
            body.requiredBy ?? null,
            body.justification ?? null,
            ctx.userId,
          ],
        );

        let lineNo = 1;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          const onHand = await tx.maybeOne<{ qty: string | null }>(
            `SELECT sum(qty_on_hand)::text AS qty FROM inventory.stock_balances
              WHERE store_id = $1 AND item_id = $2`,
            [body.toStoreId, line.itemId],
          );

          await tx.query(
            `INSERT INTO inventory.store_indent_lines
               (id, hospital_id, indent_id, line_no, item_id, uom_id, qty_entered, qty_base,
                stock_on_hand_snapshot, remarks, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10, $11, $11, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              lineNo,
              line.itemId,
              converted.uomId,
              converted.qtyEntered,
              converted.qtyBase,
              onHand?.qty ?? '0',
              line.remarks ?? null,
              ctx.userId,
            ],
          );
          lineNo += 1;
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.store_indents',
          rowId: id,
          businessKey: indentNo,
          dataClass: 'operational',
          before: null,
          after: {
            from_store_id: body.fromStoreId,
            to_store_id: body.toStoreId,
            lines: body.lines.length,
          },
        });
      }),
    );

    return this.indent(id);
  }

  async approveIndent(id: string, body: ApproveIndentRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{ status: string; indent_no: string; requested_by: string | null }>(
          `SELECT status::text AS status, indent_no, requested_by
             FROM inventory.store_indents WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The indent');
        assertStatus('This indent', header.status, ['submitted', 'pending_approval'], 'approved');
        if (header.requested_by !== null && header.requested_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The person who raised an indent cannot be the one who approves it.',
          );
        }

        // Lines nobody restricted are approved in full: the approver's job is to
        // say what they will *not* give, and a screen that made them retype every
        // line would be a screen they approve without reading.
        await tx.query(
          `UPDATE inventory.store_indent_lines
              SET qty_approved_base = qty_base, status = 'approved', updated_at = now(), updated_by = $2
            WHERE indent_id = $1`,
          [id, ctx.userId],
        );

        let partial = false;
        for (const line of body.lines) {
          const row = await tx.maybeOne<{ item_id: string; qty_base: string }>(
            `SELECT item_id, qty_base::text AS qty_base
               FROM inventory.store_indent_lines WHERE id = $1 AND indent_id = $2`,
            [line.lineId, id],
          );
          if (row === undefined) throw AppError.notFound('The indent line');
          const item = await this.uoms.item(tx, row.item_id);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyApprovedEntered);
          if (Number(converted.qtyBase) < Number(row.qty_base)) partial = true;

          await tx.query(
            `UPDATE inventory.store_indent_lines
                SET qty_approved_base = $2::numeric,
                    status = CASE WHEN $2::numeric = 0 THEN 'rejected' ELSE 'approved' END,
                    updated_at = now(), updated_by = $3
              WHERE id = $1`,
            [line.lineId, converted.qtyBase, ctx.userId],
          );
        }

        await tx.query(
          `UPDATE inventory.store_indents
              SET status = $2::inventory."InvIndentStatus", approved_by = $3, approved_at = now(),
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, partial ? 'partially_approved' : 'approved', ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.store_indents',
          rowId: id,
          businessKey: header.indent_no,
          dataClass: 'operational',
          reasonText: body.note ?? null,
          before: { status: header.status },
          after: { status: partial ? 'partially_approved' : 'approved' },
        });
      }),
    );

    return this.indent(id);
  }

  async rejectIndent(id: string, body: RejectRequest): Promise<DocumentView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{ status: string; indent_no: string }>(
          `SELECT status::text AS status, indent_no FROM inventory.store_indents WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The indent');
        assertStatus('This indent', header.status, ['submitted', 'pending_approval'], 'rejected');

        await tx.query(
          `UPDATE inventory.store_indents
              SET status = 'rejected'::inventory."InvIndentStatus", rejected_reason = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.reason, ctx.userId],
        );
        await this.audit.write(tx, {
          action: 'reject',
          entity: 'inventory.store_indents',
          rowId: id,
          businessKey: header.indent_no,
          dataClass: 'operational',
          reasonText: body.reason,
          before: { status: header.status },
          after: { status: 'rejected' },
        });
      }),
    );
    return this.indent(id);
  }

  /**
   * The pick list — FEFO's suggestion for every approved line, written down so
   * that a picker who takes a different batch has to say why.
   */
  async pickList(indentId: string): Promise<DocumentView> {
    const ctx = getContext();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{ status: string; from_store_id: string; indent_no: string }>(
          `SELECT status::text AS status, from_store_id, indent_no
             FROM inventory.store_indents WHERE id = $1`,
          [indentId],
        );
        if (header === undefined) throw AppError.notFound('The indent');
        assertStatus('This indent', header.status, ['approved', 'partially_approved'], 'picked');

        await tx.query(
          `INSERT INTO inventory.pick_lists
             (id, hospital_id, store_id, ref_type, ref_id, status, assigned_to,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, 'store_indent', $4, 'open', $5, $5, $5, now())`,
          [id, ctx.hospitalId, header.from_store_id, indentId, ctx.userId],
        );

        const lines = await tx.rows<{
          id: string;
          line_no: number;
          item_id: string;
          qty_approved_base: string | null;
          qty_base: string;
        }>(
          `SELECT id, line_no, item_id, qty_approved_base::text AS qty_approved_base,
                  qty_base::text AS qty_base
             FROM inventory.store_indent_lines
            WHERE indent_id = $1 AND status <> 'rejected'
            ORDER BY line_no`,
          [indentId],
        );

        for (const line of lines) {
          const needed = line.qty_approved_base ?? line.qty_base;
          const allocation = await this.ledger.allocateFefo(tx, header.from_store_id, line.item_id, needed);
          const first = allocation.picks[0];

          await tx.query(
            `INSERT INTO inventory.pick_list_lines
               (id, hospital_id, pick_list_id, line_no, item_id, suggested_batch_id,
                qty_to_pick_base, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $8, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              line.line_no,
              line.item_id,
              first?.batchId ?? null,
              needed,
              ctx.userId,
            ],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.pick_lists',
          rowId: id,
          businessKey: header.indent_no,
          dataClass: 'operational',
          before: null,
          after: { indent_id: indentId, lines: lines.length },
        });

        await tx.query(
          `UPDATE inventory.store_indents
              SET status = 'picking'::inventory."InvIndentStatus", updated_at = now(), updated_by = $2
            WHERE id = $1`,
          [indentId, ctx.userId],
        );
      }),
    );

    return this.indent(indentId);
  }

  // ── issues ───────────────────────────────────────────────────────────────

  /**
   * The issuing half: stock leaves the issuing store now, and is in transit
   * until the receiving store acknowledges it.
   */
  async createIssue(body: CreateIssueRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const issueNo = (
          await this.numbering.allocate(tx, {
            key: 'ISSUE',
            branchId,
            refType: 'inventory.issues',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.issues
             (id, hospital_id, branch_id, issue_no, indent_id, from_store_id, to_store_id,
              status, issued_by, issued_at, gate_pass_no, remarks, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'in_transit'::inventory."InvIssueStatus",
                   $8, now(), $9, $10, $8, $8, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            issueNo,
            body.indentId ?? null,
            body.fromStoreId,
            body.toStoreId,
            ctx.userId,
            body.gatePassNo ?? null,
            body.remarks ?? null,
          ],
        );

        let lineNo = 1;
        let totalValue = 0;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          const batchId = await this.resolveIssueBatch(
            tx,
            body.fromStoreId,
            line,
            converted.qtyBase,
            item.code,
          );
          const balance = await this.ledger.balance(tx, body.fromStoreId, line.itemId, batchId);
          const unitCost = balance === undefined ? null : Number(balance.avg_cost);

          const lineId = newId();
          await tx.query(
            `INSERT INTO inventory.issue_lines
               (id, hospital_id, issue_id, line_no, indent_line_id, item_id, batch_id, uom_id,
                qty_entered, qty_base, unit_cost, value, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11::numeric,
                     $12::numeric, $13, $13, now())`,
            [
              lineId,
              ctx.hospitalId,
              id,
              lineNo,
              line.indentLineId ?? null,
              line.itemId,
              batchId,
              converted.uomId,
              converted.qtyEntered,
              converted.qtyBase,
              unitCost,
              unitCost === null ? null : (Number(converted.qtyBase) * unitCost).toFixed(2),
              ctx.userId,
            ],
          );

          await this.ledger.post(tx, {
            storeId: body.fromStoreId,
            itemId: line.itemId,
            batchId,
            movementType: 'issue_out',
            qtyEntered: converted.qtyEntered,
            uomId: converted.uomId,
            unitCost,
            refType: 'issue',
            refId: id,
            refLineId: lineId,
            counterStoreId: body.toStoreId,
            reason: line.fefoOverrideReason ?? null,
          });

          if (line.indentLineId !== undefined) {
            await tx.query(
              `UPDATE inventory.store_indent_lines
                  SET qty_issued_base = qty_issued_base + $2::numeric, status = 'issued',
                      updated_at = now(), updated_by = $3
                WHERE id = $1`,
              [line.indentLineId, converted.qtyBase, ctx.userId],
            );
          }

          totalValue += unitCost === null ? 0 : Number(converted.qtyBase) * unitCost;
          lineNo += 1;
        }

        if (body.indentId !== undefined) {
          await tx.query(
            `UPDATE inventory.store_indents
                SET status = 'issued'::inventory."InvIndentStatus", updated_at = now(), updated_by = $2
              WHERE id = $1`,
            [body.indentId, ctx.userId],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.issues',
          rowId: id,
          businessKey: issueNo,
          dataClass: 'operational',
          before: null,
          after: {
            from_store_id: body.fromStoreId,
            to_store_id: body.toStoreId,
            lines: body.lines.length,
          },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.issue.completed', id, {
            issueId: id,
            issueNo,
            fromStoreId: body.fromStoreId,
            toStoreId: body.toStoreId,
            indentId: body.indentId ?? null,
            lineCount: body.lines.length,
            value: moneyString(totalValue),
            issuedBy: ctx.userId,
            issuedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.issue(id);
  }

  /** The receiving half: what arrived enters the receiving store's balance. */
  async receiveIssue(id: string, body: ReceiveIssueRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{
          status: string;
          issue_no: string;
          to_store_id: string;
          from_store_id: string;
        }>(
          `SELECT status::text AS status, issue_no, to_store_id, from_store_id
             FROM inventory.issues WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The issue');
        assertStatus('This issue', header.status, ['issued', 'in_transit', 'partially_received'], 'received');

        let short = false;
        for (const line of body.lines) {
          const row = await tx.maybeOne<{
            item_id: string;
            batch_id: string | null;
            qty_base: string;
            qty_received_base: string;
            unit_cost: string | null;
            indent_line_id: string | null;
          }>(
            `SELECT item_id, batch_id, qty_base::text AS qty_base,
                    qty_received_base::text AS qty_received_base, unit_cost::text AS unit_cost,
                    indent_line_id
               FROM inventory.issue_lines WHERE id = $1 AND issue_id = $2`,
            [line.issueLineId, id],
          );
          if (row === undefined) throw AppError.notFound('The issue line');

          const item = await this.uoms.item(tx, row.item_id);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyReceivedEntered);
          if (Number(converted.qtyBase) === 0) continue;
          if (Number(converted.qtyBase) < Number(row.qty_base)) short = true;

          await this.ledger.post(tx, {
            storeId: header.to_store_id,
            itemId: row.item_id,
            batchId: row.batch_id,
            movementType: 'issue_in',
            qtyEntered: converted.qtyEntered,
            uomId: converted.uomId,
            unitCost: row.unit_cost === null ? null : Number(row.unit_cost),
            refType: 'issue',
            refId: id,
            refLineId: line.issueLineId,
            counterStoreId: header.from_store_id,
            reason: line.discrepancyReason ?? null,
          });

          await tx.query(
            `UPDATE inventory.issue_lines
                SET qty_received_base = qty_received_base + $2::numeric,
                    discrepancy_reason = COALESCE($3, discrepancy_reason),
                    updated_at = now(), updated_by = $4
              WHERE id = $1`,
            [line.issueLineId, converted.qtyBase, line.discrepancyReason ?? null, ctx.userId],
          );

          if (row.indent_line_id !== null) {
            await tx.query(
              `UPDATE inventory.store_indent_lines
                  SET qty_received_base = qty_received_base + $2::numeric,
                      updated_at = now(), updated_by = $3
                WHERE id = $1`,
              [row.indent_line_id, converted.qtyBase, ctx.userId],
            );
          }
        }

        await tx.query(
          `UPDATE inventory.issues
              SET status = $2::inventory."InvIssueStatus", received_by = $3, received_at = now(),
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, short ? 'discrepancy' : 'received', ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.issues',
          rowId: id,
          businessKey: header.issue_no,
          dataClass: 'operational',
          before: { status: header.status },
          after: { status: short ? 'discrepancy' : 'received' },
        });
      }),
    );

    return this.issue(id);
  }

  // ── returns to store ─────────────────────────────────────────────────────

  /**
   * A ward or department sending stock back.
   *
   * Nothing moves on creation. The inspection is what decides whether each line
   * goes back on the shelf or into quarantine, and `phase-04 §4.4`'s "a strip
   * that left the counter is not automatically stock again" is why: a box that
   * has been on a ward for a fortnight is not the same asset as a box that never
   * left the store, and only somebody looking at it can say which.
   */
  async createReturn(body: CreateReturnToStoreRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const returnNo = (
          await this.numbering.allocate(tx, {
            key: 'ISSUE',
            branchId,
            refType: 'inventory.returns_to_store',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.returns_to_store
             (id, hospital_id, branch_id, return_no, from_store_id, to_store_id, reason,
              status, remarks, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $9, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            returnNo,
            body.fromStoreId,
            body.toStoreId,
            body.reason,
            body.remarks ?? null,
            ctx.userId,
          ],
        );

        let lineNo = 1;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          await tx.query(
            `INSERT INTO inventory.return_to_store_lines
               (id, hospital_id, return_id, line_no, item_id, batch_id, uom_id, qty_entered,
                qty_base, condition, restock, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10, $11, $12, $12, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              lineNo,
              line.itemId,
              line.batchId ?? null,
              converted.uomId,
              converted.qtyEntered,
              converted.qtyBase,
              line.condition,
              line.condition === 'good',
              ctx.userId,
            ],
          );
          lineNo += 1;
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.returns_to_store',
          rowId: id,
          businessKey: returnNo,
          dataClass: 'operational',
          before: null,
          after: { from_store_id: body.fromStoreId, to_store_id: body.toStoreId, lines: body.lines.length },
        });
      }),
    );

    return this.storeReturn(id);
  }

  async inspectReturn(id: string, body: InspectReturnRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{
          status: string;
          return_no: string;
          from_store_id: string;
          to_store_id: string;
        }>(
          `SELECT status, return_no, from_store_id, to_store_id
             FROM inventory.returns_to_store WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The return');
        assertStatus('This return', header.status, ['draft', 'submitted'], 'inspected');

        for (const decision of body.lines) {
          await tx.query(
            `UPDATE inventory.return_to_store_lines
                SET restock = $2, updated_at = now(), updated_by = $3
              WHERE id = $1 AND return_id = $4`,
            [decision.lineId, decision.restock, ctx.userId, id],
          );
        }

        const lines = await tx.rows<{
          id: string;
          item_id: string;
          batch_id: string | null;
          uom_id: string;
          qty_entered: string;
          restock: boolean;
          condition: string;
        }>(
          `SELECT id, item_id, batch_id, uom_id, qty_entered::text AS qty_entered, restock, condition
             FROM inventory.return_to_store_lines WHERE return_id = $1 ORDER BY line_no`,
          [id],
        );

        let quarantined = 0;
        for (const line of lines) {
          // Out of the returning store on every line: the ward no longer has it
          // whatever the inspector decides.
          await this.ledger.post(tx, {
            storeId: header.from_store_id,
            itemId: line.item_id,
            batchId: line.batch_id,
            movementType: 'issue_out',
            qtyEntered: line.qty_entered,
            uomId: line.uom_id,
            refType: 'issue',
            refId: id,
            refLineId: line.id,
            counterStoreId: header.to_store_id,
            remarks: `Returned to store (${line.condition})`,
          });

          if (line.restock) {
            await this.ledger.post(tx, {
              storeId: header.to_store_id,
              itemId: line.item_id,
              batchId: line.batch_id,
              movementType: 'return_in',
              qtyEntered: line.qty_entered,
              uomId: line.uom_id,
              refType: 'issue',
              refId: id,
              refLineId: line.id,
              counterStoreId: header.from_store_id,
            });
          } else {
            quarantined += 1;
            // Not restocked: it still has to leave the ward's balance, so it
            // goes to the receiving store and is quarantined there rather than
            // vanishing. A line that was neither restocked nor accounted for is
            // how stock disappears with a document to prove it did not.
            await this.ledger.post(tx, {
              storeId: header.to_store_id,
              itemId: line.item_id,
              batchId: line.batch_id,
              movementType: 'return_in',
              qtyEntered: line.qty_entered,
              uomId: line.uom_id,
              refType: 'issue',
              refId: id,
              refLineId: line.id,
              counterStoreId: header.from_store_id,
              remarks: 'Held for inspection — not returned to saleable stock',
            });
            if (line.batch_id !== null) {
              await tx.query(
                `INSERT INTO inventory.quarantines
                   (id, hospital_id, batch_id, scope, store_id, reason, started_at, decision,
                    created_by, updated_by, updated_at)
                 VALUES ($1, $2, $3, 'store', $4, 'quality'::inventory."InvQuarantineReason",
                         now(), 'pending', $5, $5, now())`,
                [newId(), ctx.hospitalId, line.batch_id, header.to_store_id, ctx.userId],
              );
            }
          }
        }

        await tx.query(
          `UPDATE inventory.returns_to_store
              SET status = 'received', inspected_by = $2, inspected_at = now(),
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.returns_to_store',
          rowId: id,
          businessKey: header.return_no,
          dataClass: 'operational',
          before: { status: header.status },
          after: { status: 'received', quarantined_lines: quarantined },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.return.received', id, {
            returnId: id,
            returnNo: header.return_no,
            fromStoreId: header.from_store_id,
            toStoreId: header.to_store_id,
            lineCount: lines.length,
            quarantinedLines: quarantined,
            returnedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.storeReturn(id);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async indent(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<IndentHeaderRow>(
        `SELECT id, indent_no, status::text AS status, from_store_id, to_store_id,
                indent_type::text AS indent_type, required_by::text AS required_by, justification,
                requested_by, approved_by, rejected_reason, created_at::text AS created_at
           FROM inventory.store_indents WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The indent');
      const lines = await this.linesOf(
        tx,
        `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name,
                NULL::uuid AS batch_id, NULL::varchar AS batch_no, l.uom_id,
                l.qty_entered::text AS qty_entered, l.qty_base::text AS qty_base, l.status,
                l.qty_approved_base::text AS qty_approved_base,
                l.qty_issued_base::text AS qty_issued_base,
                l.qty_received_base::text AS qty_received_base
           FROM inventory.store_indent_lines l JOIN inventory.items i ON i.id = l.item_id
          WHERE l.indent_id = $1 ORDER BY l.line_no`,
        [id],
        ['qty_approved_base', 'qty_issued_base', 'qty_received_base'],
      );
      return {
        id: header.id,
        documentNo: header.indent_no,
        status: header.status,
        storeId: header.from_store_id,
        counterpartyId: header.to_store_id,
        createdAt: new Date(header.created_at).toISOString(),
        lines,
        header: {
          indentType: header.indent_type,
          requiredBy: header.required_by,
          justification: header.justification,
          requestedBy: header.requested_by,
          approvedBy: header.approved_by,
          rejectedReason: header.rejected_reason,
        },
      };
    });
  }

  async issue(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<{
        id: string;
        issue_no: string;
        status: string;
        from_store_id: string;
        to_store_id: string;
        indent_id: string | null;
        gate_pass_no: string | null;
        created_at: string;
      }>(
        `SELECT id, issue_no, status::text AS status, from_store_id, to_store_id, indent_id,
                gate_pass_no, created_at::text AS created_at
           FROM inventory.issues WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The issue');
      const lines = await this.linesOf(
        tx,
        `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name,
                l.batch_id, b.batch_no, l.uom_id, l.qty_entered::text AS qty_entered,
                l.qty_base::text AS qty_base, NULL::text AS status,
                l.qty_received_base::text AS qty_received_base,
                l.unit_cost::text AS unit_cost, l.discrepancy_reason
           FROM inventory.issue_lines l
           JOIN inventory.items i ON i.id = l.item_id
           LEFT JOIN inventory.item_batches b ON b.id = l.batch_id
          WHERE l.issue_id = $1 ORDER BY l.line_no`,
        [id],
        ['qty_received_base', 'unit_cost', 'discrepancy_reason'],
      );
      return {
        id: header.id,
        documentNo: header.issue_no,
        status: header.status,
        storeId: header.from_store_id,
        counterpartyId: header.to_store_id,
        createdAt: new Date(header.created_at).toISOString(),
        lines,
        header: { indentId: header.indent_id, gatePassNo: header.gate_pass_no },
      };
    });
  }

  async storeReturn(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<{
        id: string;
        return_no: string;
        status: string;
        from_store_id: string;
        to_store_id: string;
        reason: string;
        created_at: string;
      }>(
        `SELECT id, return_no, status, from_store_id, to_store_id, reason, created_at::text AS created_at
           FROM inventory.returns_to_store WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The return');
      const lines = await this.linesOf(
        tx,
        `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name,
                l.batch_id, b.batch_no, l.uom_id, l.qty_entered::text AS qty_entered,
                l.qty_base::text AS qty_base, l.condition AS status, l.restock
           FROM inventory.return_to_store_lines l
           JOIN inventory.items i ON i.id = l.item_id
           LEFT JOIN inventory.item_batches b ON b.id = l.batch_id
          WHERE l.return_id = $1 ORDER BY l.line_no`,
        [id],
        ['restock'],
      );
      return {
        id: header.id,
        documentNo: header.return_no,
        status: header.status,
        storeId: header.from_store_id,
        counterpartyId: header.to_store_id,
        createdAt: new Date(header.created_at).toISOString(),
        lines,
        header: { reason: header.reason },
      };
    });
  }

  async listIndents(
    query: StoreQuery & { readonly status?: string | undefined },
  ): Promise<Page<DocumentView>> {
    return this.pageOf(
      'inventory.store_indents',
      `SELECT d.id, d.created_at::text AS cursor_key FROM inventory.store_indents d`,
      query,
      (id) => this.indent(id),
    );
  }

  async listIssues(query: StoreQuery): Promise<Page<DocumentView>> {
    return this.pageOf(
      'inventory.issues',
      `SELECT d.id, d.created_at::text AS cursor_key FROM inventory.issues d`,
      query,
      (id) => this.issue(id),
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * FEFO, or a named batch with a documented reason.
   *
   * A caller that names no batch gets the first to expire. A caller that names
   * one that is *not* the first to expire is overriding FEFO, and the override
   * needs a reason for the same reason `pick_list_lines_override_documented`
   * demands one: taking the newer box is how the older one reaches its expiry
   * date on the shelf.
   */
  private async resolveIssueBatch(
    tx: TransactionClient,
    storeId: string,
    line: {
      readonly itemId: string;
      readonly batchId?: string | undefined;
      readonly fefoOverrideReason?: string | undefined;
    },
    neededBase: string,
    itemCode: string,
  ): Promise<string | null> {
    const batches = await this.ledger.fefo(tx, storeId, line.itemId);
    const first = batches[0];

    if (line.batchId === undefined) {
      if (first === undefined) {
        const item = await this.uoms.item(tx, line.itemId);
        if (item.tracking === 'none') return null;
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `There is no issuable batch of ${itemCode} in this store. Every batch is either empty, expired or quarantined.`,
          { nextAction: 'Check the shelf, or transfer stock in from another store.' },
        );
      }
      if (Number(first.qty_available) < Number(neededBase) && batches.length === 1) {
        throw new AppError(
          ProblemType.BUSINESS_RULE_VIOLATED,
          `The oldest batch of ${itemCode} holds ${first.qty_available} base units and this line needs ${neededBase}. Split the line across batches, or issue what is there.`,
        );
      }
      return first.batch_id;
    }

    if (first !== undefined && first.batch_id !== line.batchId && line.fefoOverrideReason === undefined) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        `Batch ${first.batch_id} of ${itemCode} expires sooner than the one named. Taking the later batch needs a reason — it is how the older one reaches its expiry date on the shelf.`,
        { nextAction: 'Issue the first-expiring batch, or give a reason for the override.' },
      );
    }
    return line.batchId;
  }

  private async linesOf(
    tx: TransactionClient,
    sql: string,
    values: readonly unknown[],
    extraColumns: readonly string[],
  ): Promise<readonly DocumentLineView[]> {
    const rows = await tx.rows<Record<string, string | number | boolean | null>>(sql, values);
    return rows.map((row) => {
      const extra: Record<string, string | number | boolean | null> = {};
      for (const column of extraColumns) extra[column] = row[column] ?? null;
      return {
        id: String(row.id),
        lineNo: Number(row.line_no),
        itemId: String(row.item_id),
        itemCode: String(row.item_code),
        itemName: String(row.item_name),
        batchId: row.batch_id === null || row.batch_id === undefined ? null : String(row.batch_id),
        batchNo: row.batch_no === null || row.batch_no === undefined ? null : String(row.batch_no),
        uomId: String(row.uom_id),
        qtyEntered: String(row.qty_entered),
        qtyBase: String(row.qty_base),
        status: row.status === null || row.status === undefined ? null : String(row.status),
        extra,
      };
    });
  }

  private async pageOf(
    resource: string,
    selectSql: string,
    query: {
      readonly cursor?: string | undefined;
      readonly limit: number;
      readonly status?: string | undefined;
    },
    load: (id: string) => Promise<DocumentView>,
  ): Promise<Page<DocumentView>> {
    const hospital = hospitalId();
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    const ids = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.status !== undefined) clauses.push(`d.status::text = ${bind(query.status)}`);
      if (after !== null) {
        clauses.push(`(d.created_at, d.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      return tx.rows<{ id: string; cursor_key: string }>(
        `${selectSql} ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT ${bind(limit + 1)}`,
        values,
      );
    });

    const page = this.cursors.keysetPage<{ id: string }>(ids, limit, {
      hospitalId: hospital,
      resource,
      direction: 'desc',
    });

    const items: DocumentView[] = [];
    for (const row of page.items) items.push(await load(row.id));
    return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }
}

interface IndentHeaderRow {
  readonly id: string;
  readonly indent_no: string;
  readonly status: string;
  readonly from_store_id: string;
  readonly to_store_id: string;
  readonly indent_type: string;
  readonly required_by: string | null;
  readonly justification: string | null;
  readonly requested_by: string | null;
  readonly approved_by: string | null;
  readonly rejected_reason: string | null;
  readonly created_at: string;
}
