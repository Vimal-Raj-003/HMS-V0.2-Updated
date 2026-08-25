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
  AdjustmentQuery,
  ApproveAdjustmentRequest,
  ApproveCountRequest,
  CountLinesRequest,
  CountQuery,
  CreateAdjustmentRequest,
  CreateCountPlanRequest,
} from './inventory.schemas.js';
import type { DocumentLineView, DocumentView } from './inventory.types.js';
import { StockLedgerService, type MovementType } from './stock-ledger.service.js';
import { UomService } from './uom.service.js';

/**
 * NC-006 §3.9 and §3.14 — adjustments, write-offs, and the physical count that
 * produces most of them.
 *
 * ── Why an adjustment is three steps and not one ─────────────────────────────
 *
 * `create → approve → post`. The ledger row appears only at `post`, and
 * `adjustments_maker_is_not_checker` makes the approver a different person from
 * the requester. A one-step adjustment is a licence for anybody with stores
 * access to reconcile a theft, and `docs/04 §3` puts write-offs in the
 * maker-checker list for that reason.
 *
 * `inventory.refuse_posted_adjustment_edit` then freezes the document once it
 * has posted: the ledger rows exist and the two must not be allowed to disagree.
 *
 * ── Why the count builds its own adjustment ──────────────────────────────────
 *
 * A count produces gains and losses in the same sheet, and an adjustment header
 * carries one type. So an approved count writes **two** adjustments — one
 * `count_variance` for the gains, one for the losses — and posts them in the
 * same transaction. That is also why `count_variance` is refused on the manual
 * path: an adjustment of that type with no count behind it is a variance nobody
 * counted.
 */

/** The movement each adjustment type posts. `null` means "not from this path". */
const MOVEMENT_FOR: Readonly<Record<string, MovementType | null>> = {
  plus: 'adjustment_plus',
  opening: 'opening',
  donation: 'adjustment_plus',
  minus: 'adjustment_minus',
  sample: 'adjustment_minus',
  writeoff_expiry: 'expiry_writeoff',
  writeoff_damage: 'damage_writeoff',
  // There is no `recall_writeoff` movement type. A recall write-off is a damage
  // write-off whose reason names the recall, and the reason is mandatory on the
  // adjustment header — so the recall is on the row an auditor reads.
  writeoff_recall: 'damage_writeoff',
  repack: null,
  count_variance: null,
};

const WRITE_OFF_TYPES = new Set(['writeoff_expiry', 'writeoff_damage', 'writeoff_recall']);

@Injectable()
export class AdjustmentsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(UomService) private readonly uoms: UomService,
  ) {}

  // ── adjustments ──────────────────────────────────────────────────────────

  async create(body: CreateAdjustmentRequest): Promise<DocumentView> {
    const movement = MOVEMENT_FOR[body.adjustmentType];
    if (movement === null || movement === undefined) {
      throw new AppError(
        ProblemType.VALIDATION_FAILED,
        body.adjustmentType === 'count_variance'
          ? 'A count variance is posted by approving the count that found it, not by typing an adjustment. An adjustment of this type with no count behind it is a variance nobody counted.'
          : 'A repack is recorded through put-away, which writes the two compensating movements the shelf actually saw.',
      );
    }

    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const adjustmentNo = (
          await this.numbering.allocate(tx, {
            key: 'ADJ',
            branchId,
            refType: 'inventory.adjustments',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.adjustments
             (id, hospital_id, branch_id, store_id, adjustment_no, adjustment_type, reason_code,
              reason, status, requested_by, count_plan_id, bmw_disposal_ref,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::inventory."InvAdjustmentType", $7, $8,
                   'pending_approval'::inventory."InvAdjustmentStatus", $9, $10, $11, $9, $9, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.storeId,
            adjustmentNo,
            body.adjustmentType,
            body.reasonCode,
            body.reason,
            ctx.userId,
            body.countPlanId ?? null,
            body.bmwDisposalRef ?? null,
          ],
        );

        let lineNo = 1;
        let totalValue = 0;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          const balance = await this.ledger.balance(tx, body.storeId, line.itemId, line.batchId ?? null);
          const unitCost = balance === undefined ? null : Number(balance.avg_cost);
          const value = unitCost === null ? null : Number(converted.qtyBase) * unitCost;
          totalValue += value ?? 0;

          await tx.query(
            `INSERT INTO inventory.adjustment_lines
               (id, hospital_id, adjustment_id, line_no, item_id, batch_id, uom_id, qty_entered,
                qty_base, unit_cost, value, line_reason, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric,
                     $11::numeric, $12, $13, $13, now())`,
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
              unitCost,
              value === null ? null : value.toFixed(2),
              line.lineReason ?? null,
              ctx.userId,
            ],
          );
          lineNo += 1;
        }

        await tx.query(`UPDATE inventory.adjustments SET total_value = $2::numeric WHERE id = $1`, [
          id,
          totalValue.toFixed(2),
        ]);

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.adjustments',
          rowId: id,
          businessKey: adjustmentNo,
          dataClass: 'financial',
          reasonText: body.reason,
          before: null,
          after: {
            adjustment_type: body.adjustmentType,
            store_id: body.storeId,
            lines: body.lines.length,
          },
        });
      }),
    );

    return this.get(id);
  }

  /**
   * Approve **and** post, in one transaction.
   *
   * Separating them would create a window in which an adjustment is authorised
   * but the stock has not moved — and the shelf is already in the state the
   * adjustment describes, because somebody counted it. The check that matters is
   * maker ≠ checker, and that is asserted here and again by
   * `adjustments_maker_is_not_checker`.
   */
  async approve(id: string, body: ApproveAdjustmentRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<AdjustmentHeaderRow>(
          `SELECT id, adjustment_no, status::text AS status, store_id, branch_id,
                  adjustment_type::text AS adjustment_type, reason_code, reason,
                  requested_by, approved_by, total_value::text AS total_value,
                  count_plan_id, created_at::text AS created_at
             FROM inventory.adjustments WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The adjustment');
        assertStatus('This adjustment', header.status, ['draft', 'pending_approval'], 'approved');
        if (header.requested_by !== null && header.requested_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The person who raised an adjustment cannot be the one who approves it. A write-off that one person can authorise alone is not a control.',
          );
        }

        await tx.query(
          `UPDATE inventory.adjustments
              SET status = 'approved'::inventory."InvAdjustmentStatus", approved_by = $2,
                  approved_at = now(), updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId],
        );

        await this.post(tx, header, ctx.userId, body.note ?? null);
      }),
    );

    return this.get(id);
  }

  // ── physical and cycle counts ────────────────────────────────────────────

  /**
   * A count plan snapshots what the system believes, item by item, at the moment
   * the sheet is printed.
   *
   * `blind` is the default: the counter does not see the system quantity, which
   * is the only way a count measures anything. A sheet that shows the expected
   * number measures whether the counter can read.
   */
  async createCountPlan(body: CreateCountPlanRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();
    const sheetId = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const countNo = (
          await this.numbering.allocate(tx, {
            key: 'COUNT',
            branchId,
            refType: 'inventory.count_plans',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.count_plans
             (id, hospital_id, branch_id, store_id, count_no, count_type, scope, scheduled_for,
              freeze_movements, blind, status, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::inventory."InvCountType", $7::jsonb, $8::date,
                   $9, $10, 'in_progress'::inventory."InvCountStatus", $11, $11, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.storeId,
            countNo,
            body.countType,
            JSON.stringify({ itemIds: body.itemIds }),
            body.scheduledFor,
            body.freezeMovements,
            body.blind,
            ctx.userId,
          ],
        );

        await tx.query(
          `INSERT INTO inventory.count_sheets
             (id, hospital_id, plan_id, assigned_to, second_counter_id, status,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'open', $6, $6, now())`,
          [
            sheetId,
            ctx.hospitalId,
            id,
            body.assignedTo ?? ctx.userId,
            body.secondCounterId ?? null,
            ctx.userId,
          ],
        );

        // The snapshot. A narcotic count is scoped to controlled items whether or
        // not the caller listed them: `phase-04 §4.2` keeps narcotics reconciled
        // separately, and a "narcotic count" that swept in the paracetamol would
        // be a general count wearing the word.
        const values: unknown[] = [body.storeId];
        const bind = binder(values);
        const filters: string[] = ['b.store_id = $1', 'b.qty_on_hand <> 0'];
        if (body.itemIds.length > 0) filters.push(`b.item_id = ANY(${bind(body.itemIds)}::uuid[])`);
        if (body.countType === 'narcotic') {
          filters.push(`(i.is_narcotic OR i.schedule IN ('ndps_narcotic', 'ndps_psychotropic'))`);
        }

        const positions = await tx.rows<{
          item_id: string;
          batch_id: string | null;
          uom_id: string;
          qty: string;
        }>(
          `SELECT b.item_id, b.batch_id, i.base_uom_id AS uom_id, sum(b.qty_on_hand)::text AS qty
             FROM inventory.stock_balances b
             JOIN inventory.items i ON i.id = b.item_id
            WHERE ${filters.join(' AND ')}
            GROUP BY b.item_id, b.batch_id, i.base_uom_id`,
          values,
        );

        for (const position of positions) {
          await tx.query(
            `INSERT INTO inventory.count_lines
               (id, hospital_id, sheet_id, item_id, batch_id, uom_id, system_qty_base,
                created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $8, now())`,
            [
              newId(),
              ctx.hospitalId,
              sheetId,
              position.item_id,
              position.batch_id,
              position.uom_id,
              position.qty,
              ctx.userId,
            ],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.count_plans',
          rowId: id,
          businessKey: countNo,
          dataClass: 'operational',
          before: null,
          after: { store_id: body.storeId, count_type: body.countType, lines: positions.length },
        });
      }),
    );

    return this.countPlan(id);
  }

  async recordCount(sheetId: string, body: CountLinesRequest): Promise<DocumentView> {
    const ctx = getContext();

    const planId = await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const sheet = await tx.maybeOne<{ plan_id: string; status: string }>(
          `SELECT plan_id, status FROM inventory.count_sheets WHERE id = $1 FOR UPDATE`,
          [sheetId],
        );
        if (sheet === undefined) throw AppError.notFound('The count sheet');
        assertStatus('This count sheet', sheet.status, ['open', 'counting'], 'counted');

        for (const line of body.lines) {
          const row = await tx.maybeOne<{ item_id: string; system_qty_base: string }>(
            `SELECT item_id, system_qty_base::text AS system_qty_base
               FROM inventory.count_lines WHERE id = $1 AND sheet_id = $2`,
            [line.lineId, sheetId],
          );
          if (row === undefined) throw AppError.notFound('The count line');

          const item = await this.uoms.item(tx, row.item_id);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.countedEntered);
          const variance = Number(converted.qtyBase) - Number(row.system_qty_base);

          await tx.query(
            `UPDATE inventory.count_lines
                SET counted_entered = $2::numeric, counted_qty_base = $3::numeric,
                    variance_qty_base = $4::numeric, reason = COALESCE($5, reason),
                    counted_by = $6, counted_at = now(), updated_at = now(), updated_by = $6
              WHERE id = $1`,
            [
              line.lineId,
              converted.qtyEntered,
              converted.qtyBase,
              variance.toFixed(4),
              line.reason ?? null,
              ctx.userId,
            ],
          );
        }

        await tx.query(
          `UPDATE inventory.count_sheets
              SET status = 'counted', counted_at = now(), updated_at = now(), updated_by = $2
            WHERE id = $1`,
          [sheetId, ctx.userId],
        );
        await tx.query(
          `UPDATE inventory.count_plans
              SET status = 'variance_review'::inventory."InvCountStatus",
                  updated_at = now(), updated_by = $2
            WHERE id = $1`,
          [sheet.plan_id, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.count_sheets',
          rowId: sheetId,
          businessKey: sheetId,
          dataClass: 'operational',
          before: { status: sheet.status },
          after: { status: 'counted', lines: body.lines.length },
        });

        return sheet.plan_id;
      }),
    );

    return this.countPlan(planId);
  }

  /**
   * Approving a count is what turns its variances into ledger movements.
   *
   * Two adjustments, because gains and losses are different movement types and
   * an adjustment header carries one. Both are created, approved and posted
   * here — the approval is the act, and the maker-checker control is the count's
   * own: the person who counted may not be the person who approves the variance.
   */
  async approveCount(planId: string, body: ApproveCountRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const plan = await tx.maybeOne<{
          id: string;
          count_no: string;
          status: string;
          store_id: string;
          branch_id: string;
          count_type: string;
        }>(
          `SELECT id, count_no, status::text AS status, store_id, branch_id,
                  count_type::text AS count_type
             FROM inventory.count_plans WHERE id = $1 FOR UPDATE`,
          [planId],
        );
        if (plan === undefined) throw AppError.notFound('The count');
        assertStatus('This count', plan.status, ['counted', 'variance_review', 'recount'], 'approved');

        const counters = await tx.rows<{ counted_by: string | null }>(
          `SELECT DISTINCT l.counted_by
             FROM inventory.count_lines l
             JOIN inventory.count_sheets s ON s.id = l.sheet_id
            WHERE s.plan_id = $1 AND l.counted_by IS NOT NULL`,
          [planId],
        );
        if (counters.length === 1 && counters[0]?.counted_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The person who counted the shelf cannot be the only one who approves its variance.',
          );
        }

        const lines = await tx.rows<{
          id: string;
          item_id: string;
          batch_id: string | null;
          uom_id: string;
          variance_qty_base: string | null;
          counted_qty_base: string | null;
        }>(
          `SELECT l.id, l.item_id, l.batch_id, l.uom_id,
                  l.variance_qty_base::text AS variance_qty_base,
                  l.counted_qty_base::text AS counted_qty_base
             FROM inventory.count_lines l
             JOIN inventory.count_sheets s ON s.id = l.sheet_id
            WHERE s.plan_id = $1 AND l.counted_qty_base IS NOT NULL`,
          [planId],
        );

        const gains = lines.filter((l) => Number(l.variance_qty_base ?? 0) > 0);
        const losses = lines.filter((l) => Number(l.variance_qty_base ?? 0) < 0);
        let varianceValue = 0;
        let adjustmentId: string | null = null;

        for (const [group, movement] of [
          [gains, 'count_gain'],
          [losses, 'count_loss'],
        ] as const) {
          if (group.length === 0) continue;
          const id = newId();
          adjustmentId = id;
          const adjustmentNo = (
            await this.numbering.allocate(tx, {
              key: 'ADJ',
              branchId: plan.branch_id,
              refType: 'inventory.adjustments',
              refId: id,
            })
          ).formatted;

          await tx.query(
            `INSERT INTO inventory.adjustments
               (id, hospital_id, branch_id, store_id, adjustment_no, adjustment_type, reason_code,
                reason, status, requested_by, approved_by, approved_at, count_plan_id,
                created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'count_variance'::inventory."InvAdjustmentType",
                     $6, $7, 'approved'::inventory."InvAdjustmentStatus", $8, $9, now(), $10,
                     $8, $9, now())`,
            [
              id,
              ctx.hospitalId,
              plan.branch_id,
              plan.store_id,
              adjustmentNo,
              movement === 'count_gain' ? 'count_gain' : 'count_loss',
              body.reason,
              counters[0]?.counted_by ?? ctx.userId,
              ctx.userId,
              planId,
            ],
          );

          let lineNo = 1;
          let groupValue = 0;
          for (const line of group) {
            const magnitude = Math.abs(Number(line.variance_qty_base ?? 0));
            const item = await this.uoms.item(tx, line.item_id);
            const converted = await this.uoms.toBase(tx, item, line.uom_id, magnitude);
            const balance = await this.ledger.balance(tx, plan.store_id, line.item_id, line.batch_id);
            const unitCost = balance === undefined ? null : Number(balance.avg_cost);
            const value = unitCost === null ? 0 : magnitude * unitCost;
            groupValue += movement === 'count_gain' ? value : -value;

            await tx.query(
              `INSERT INTO inventory.adjustment_lines
                 (id, hospital_id, adjustment_id, line_no, item_id, batch_id, uom_id, qty_entered,
                  qty_base, unit_cost, value, line_reason, created_by, updated_by, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric,
                       $11::numeric, $12, $13, $13, now())`,
              [
                newId(),
                ctx.hospitalId,
                id,
                lineNo,
                line.item_id,
                line.batch_id,
                converted.uomId,
                converted.qtyEntered,
                converted.qtyBase,
                unitCost,
                value.toFixed(2),
                'Physical count variance',
                ctx.userId,
              ],
            );

            if (body.postAdjustment) {
              await this.ledger.post(tx, {
                storeId: plan.store_id,
                branchId: plan.branch_id,
                itemId: line.item_id,
                batchId: line.batch_id,
                movementType: movement,
                qtyEntered: converted.qtyEntered,
                uomId: converted.uomId,
                unitCost,
                refType: 'count',
                refId: planId,
                refLineId: line.id,
                reason: body.reason,
              });
            }
            lineNo += 1;
          }

          varianceValue += groupValue;
          await tx.query(
            `UPDATE inventory.adjustments
                SET total_value = $2::numeric,
                    status = $3::inventory."InvAdjustmentStatus",
                    posted_at = CASE WHEN $4::boolean THEN now() ELSE NULL END
              WHERE id = $1`,
            [id, groupValue.toFixed(2), body.postAdjustment ? 'posted' : 'approved', body.postAdjustment],
          );
        }

        await tx.query(
          `UPDATE inventory.count_plans
              SET status = $2::inventory."InvCountStatus", approved_by = $3, approved_at = now(),
                  variance_value = $4::numeric, adjustment_id = $5,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [
            planId,
            body.postAdjustment ? 'posted' : 'approved',
            ctx.userId,
            varianceValue.toFixed(2),
            adjustmentId,
          ],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.count_plans',
          rowId: planId,
          businessKey: plan.count_no,
          dataClass: 'financial',
          reasonText: body.reason,
          before: { status: plan.status },
          after: {
            status: body.postAdjustment ? 'posted' : 'approved',
            variance_value: varianceValue.toFixed(2),
            lines_with_variance: gains.length + losses.length,
          },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.count.completed', planId, {
            countPlanId: planId,
            storeId: plan.store_id,
            countType: plan.count_type,
            linesCounted: lines.length,
            linesWithVariance: gains.length + losses.length,
            varianceValue: moneyString(varianceValue),
            approvedBy: ctx.userId,
            completedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.countPlan(planId);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<AdjustmentHeaderRow>(
        `SELECT id, adjustment_no, status::text AS status, store_id, branch_id,
                adjustment_type::text AS adjustment_type, reason_code, reason,
                requested_by, approved_by, total_value::text AS total_value,
                count_plan_id, created_at::text AS created_at
           FROM inventory.adjustments WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The adjustment');

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
        line_reason: string | null;
      }>(
        `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name,
                l.batch_id, b.batch_no, l.uom_id, l.qty_entered::text AS qty_entered,
                l.qty_base::text AS qty_base, l.value::text AS value, l.line_reason
           FROM inventory.adjustment_lines l
           JOIN inventory.items i ON i.id = l.item_id
           LEFT JOIN inventory.item_batches b ON b.id = l.batch_id
          WHERE l.adjustment_id = $1 ORDER BY l.line_no`,
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
        extra: { value: r.value, lineReason: r.line_reason },
      }));

      return {
        id: header.id,
        documentNo: header.adjustment_no,
        status: header.status,
        storeId: header.store_id,
        counterpartyId: null,
        createdAt: new Date(header.created_at).toISOString(),
        lines,
        header: {
          adjustmentType: header.adjustment_type,
          reasonCode: header.reason_code,
          reason: header.reason,
          requestedBy: header.requested_by,
          approvedBy: header.approved_by,
          totalValue: header.total_value,
          countPlanId: header.count_plan_id,
        },
      };
    });
  }

  async list(query: AdjustmentQuery): Promise<Page<DocumentView>> {
    const hospital = hospitalId();
    const resource = 'inventory.adjustments';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    const ids = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.storeId !== undefined) clauses.push(`a.store_id = ${bind(query.storeId)}::uuid`);
      if (query.status !== undefined) clauses.push(`a.status::text = ${bind(query.status)}`);
      if (after !== null) {
        clauses.push(`(a.created_at, a.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      return tx.rows<{ id: string; cursor_key: string }>(
        `SELECT a.id, a.created_at::text AS cursor_key FROM inventory.adjustments a
         ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${bind(limit + 1)}`,
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

  async countPlan(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const plan = await tx.maybeOne<{
        id: string;
        count_no: string;
        status: string;
        store_id: string;
        count_type: string;
        scheduled_for: string;
        blind: boolean;
        variance_value: string | null;
        adjustment_id: string | null;
        created_at: string;
      }>(
        `SELECT id, count_no, status::text AS status, store_id, count_type::text AS count_type,
                scheduled_for::text AS scheduled_for, blind, variance_value::text AS variance_value,
                adjustment_id, created_at::text AS created_at
           FROM inventory.count_plans WHERE id = $1`,
        [id],
      );
      if (plan === undefined) throw AppError.notFound('The count');

      const rows = await tx.rows<{
        id: string;
        sheet_id: string;
        item_id: string;
        item_code: string;
        item_name: string;
        batch_id: string | null;
        batch_no: string | null;
        uom_id: string;
        system_qty_base: string;
        counted_qty_base: string | null;
        variance_qty_base: string | null;
        reason: string | null;
      }>(
        `SELECT l.id, l.sheet_id, l.item_id, i.code AS item_code, i.name AS item_name,
                l.batch_id, b.batch_no, l.uom_id, l.system_qty_base::text AS system_qty_base,
                l.counted_qty_base::text AS counted_qty_base,
                l.variance_qty_base::text AS variance_qty_base, l.reason
           FROM inventory.count_lines l
           JOIN inventory.count_sheets s ON s.id = l.sheet_id
           JOIN inventory.items i ON i.id = l.item_id
           LEFT JOIN inventory.item_batches b ON b.id = l.batch_id
          WHERE s.plan_id = $1
          ORDER BY i.code`,
        [id],
      );

      // `blind` withholds the system quantity from an uncounted line, which is
      // the whole point of a blind count. Once a line is counted the number is
      // released, because the variance is what the reviewer has to see.
      const lines: DocumentLineView[] = rows.map((r, index) => ({
        id: r.id,
        lineNo: index + 1,
        itemId: r.item_id,
        itemCode: r.item_code,
        itemName: r.item_name,
        batchId: r.batch_id,
        batchNo: r.batch_no,
        uomId: r.uom_id,
        qtyEntered: r.counted_qty_base ?? '0',
        qtyBase: r.counted_qty_base ?? '0',
        status: r.counted_qty_base === null ? 'pending' : 'counted',
        extra: {
          sheetId: r.sheet_id,
          systemQtyBase: plan.blind && r.counted_qty_base === null ? null : r.system_qty_base,
          varianceQtyBase: r.variance_qty_base,
          reason: r.reason,
        },
      }));

      return {
        id: plan.id,
        documentNo: plan.count_no,
        status: plan.status,
        storeId: plan.store_id,
        counterpartyId: null,
        createdAt: new Date(plan.created_at).toISOString(),
        lines,
        header: {
          countType: plan.count_type,
          scheduledFor: plan.scheduled_for,
          blind: plan.blind,
          varianceValue: plan.variance_value,
          adjustmentId: plan.adjustment_id,
        },
      };
    });
  }

  async listCounts(query: CountQuery): Promise<Page<DocumentView>> {
    const hospital = hospitalId();
    const resource = 'inventory.counts';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    const ids = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.storeId !== undefined) clauses.push(`c.store_id = ${bind(query.storeId)}::uuid`);
      if (query.status !== undefined) clauses.push(`c.status::text = ${bind(query.status)}`);
      if (after !== null) {
        clauses.push(`(c.created_at, c.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      return tx.rows<{ id: string; cursor_key: string }>(
        `SELECT c.id, c.created_at::text AS cursor_key FROM inventory.count_plans c
         ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT ${bind(limit + 1)}`,
        values,
      );
    });

    const page = this.cursors.keysetPage<{ id: string }>(ids, limit, {
      hospitalId: hospital,
      resource,
      direction: 'desc',
    });
    const items: DocumentView[] = [];
    for (const row of page.items) items.push(await this.countPlan(row.id));
    return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  // ── posting ──────────────────────────────────────────────────────────────

  private async post(
    tx: TransactionClient,
    header: AdjustmentHeaderRow,
    actorId: string | null,
    note: string | null,
  ): Promise<void> {
    const movement = MOVEMENT_FOR[header.adjustment_type];
    if (movement === null || movement === undefined) {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        `An adjustment of type "${header.adjustment_type}" is not posted through this path.`,
      );
    }

    const lines = await tx.rows<{
      id: string;
      item_id: string;
      item_code: string;
      batch_id: string | null;
      batch_no: string | null;
      expiry_date: string | null;
      uom_id: string;
      qty_entered: string;
      qty_base: string;
      unit_cost: string | null;
      value: string | null;
    }>(
      `SELECT l.id, l.item_id, i.code AS item_code, l.batch_id, b.batch_no,
              b.expiry_date::text AS expiry_date, l.uom_id,
              l.qty_entered::text AS qty_entered, l.qty_base::text AS qty_base,
              l.unit_cost::text AS unit_cost, l.value::text AS value
         FROM inventory.adjustment_lines l
         JOIN inventory.items i ON i.id = l.item_id
         LEFT JOIN inventory.item_batches b ON b.id = l.batch_id
        WHERE l.adjustment_id = $1 ORDER BY l.line_no`,
      [header.id],
    );

    let totalValue = 0;
    for (const line of lines) {
      await this.ledger.post(tx, {
        storeId: header.store_id,
        branchId: header.branch_id,
        itemId: line.item_id,
        batchId: line.batch_id,
        movementType: movement,
        qtyEntered: line.qty_entered,
        uomId: line.uom_id,
        unitCost: line.unit_cost === null ? null : Number(line.unit_cost),
        refType: WRITE_OFF_TYPES.has(header.adjustment_type) ? 'writeoff' : 'adjustment',
        refId: header.id,
        refLineId: line.id,
        reason: header.reason,
        remarks: note,
      });
      totalValue += Number(line.value ?? 0);

      if (WRITE_OFF_TYPES.has(header.adjustment_type) && line.batch_id !== null) {
        await tx.query(
          `UPDATE inventory.item_batches
              SET status = 'written_off'::inventory."InvBatchStatus", updated_at = now(),
                  updated_by = $2, version = version + 1
            WHERE id = $1
              AND NOT EXISTS (SELECT 1 FROM inventory.stock_balances sb
                               WHERE sb.batch_id = $1 AND sb.qty_on_hand > 0)`,
          [line.batch_id, actorId],
        );

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.batch.written_off', line.batch_id, {
            storeId: header.store_id,
            itemId: line.item_id,
            itemCode: line.item_code,
            batchId: line.batch_id,
            batchNo: line.batch_no,
            expiryDate: line.expiry_date,
            adjustmentId: header.id,
            qtyBase: quantityString(Number(line.qty_base)),
            value: line.value === null ? null : moneyString(Number(line.value)),
            reason: header.reason,
            approvedBy: actorId,
            writtenOffAt: new Date().toISOString(),
          }),
        );
      }
    }

    await tx.query(
      `UPDATE inventory.adjustments
          SET status = 'posted'::inventory."InvAdjustmentStatus", posted_at = now(),
              updated_at = now(), updated_by = $2
        WHERE id = $1`,
      [header.id, actorId],
    );

    await this.outbox.publish(
      tx,
      inventoryEvent('inventory.adjustment.posted', header.id, {
        adjustmentId: header.id,
        adjustmentNo: header.adjustment_no,
        storeId: header.store_id,
        adjustmentType: header.adjustment_type,
        reasonCode: header.reason_code,
        reason: header.reason,
        lineCount: lines.length,
        value: moneyString(totalValue),
        requestedBy: header.requested_by,
        approvedBy: actorId,
        postedAt: new Date().toISOString(),
      }),
    );
  }
}

interface AdjustmentHeaderRow {
  readonly id: string;
  readonly adjustment_no: string;
  readonly status: string;
  readonly store_id: string;
  readonly branch_id: string;
  readonly adjustment_type: string;
  readonly reason_code: string;
  readonly reason: string;
  readonly requested_by: string | null;
  readonly approved_by: string | null;
  readonly total_value: string | null;
  readonly count_plan_id: string | null;
  readonly created_at: string;
}
