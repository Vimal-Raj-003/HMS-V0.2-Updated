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
  assertPatientVisible,
  binder,
  hospitalId,
  moneyString,
  requireBranch,
  withInventoryErrors,
} from './inventory.common.js';
import { inventoryEvent } from './inventory.events.js';
import type {
  ConsumptionQuery,
  CostCentreQuery,
  CostCentreRequest,
  RecordConsumptionRequest,
  ReverseRequest,
} from './inventory.schemas.js';
import type { CostCentreView, DocumentView } from './inventory.types.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { UomService } from './uom.service.js';

/**
 * NC-008 — consumption entries and cost centres.
 *
 * ── Why `billingStatus` is on every line ────────────────────────────────────
 *
 * NC-008 §5 forbids a consumable silently disappearing. On a stock report a
 * non-payable item and an unbilled billable item look identical; on a revenue
 * report they are opposite facts. So every line carries a billing status from
 * the moment it is written: `pending` for something Phase 5 must charge for,
 * `not_billable` for something the item master says is never charged. Nothing
 * is left null, because null is the state in which a consumable can go missing
 * between two modules that each assume the other handled it.
 *
 * ── Reversal, never editing ─────────────────────────────────────────────────
 *
 * `cons_entries_reversal_documented` requires a reversal to name what it
 * reverses and say why, and the stock half goes back through
 * `StockLedgerService.correct()`. That is the same rule the ledger has, for the
 * same reason: the entry is a claim about something that physically happened.
 *
 * ── The cost centre ─────────────────────────────────────────────────────────
 *
 * Resolved from `finance.cost_centre_mappings` when the caller does not name
 * one, effective-dated, with `cost_centre_mappings_no_overlap` guaranteeing one
 * answer per entity per day. That is what lets a ward's consumption be costed
 * without every scan asking a nurse which cost centre they are standing in.
 */
@Injectable()
export class ConsumptionService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(UomService) private readonly uoms: UomService,
  ) {}

  async record(body: RecordConsumptionRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        if (body.entryType === 'patient' && body.patientId === undefined) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            'A patient consumption entry names the patient. Without one the consumable is charged to nobody and traced to nobody.',
          );
        }
        if (body.patientId !== undefined) await assertPatientVisible(tx, body.patientId);

        const costCentreId = body.costCentreId ?? (await this.costCentreForStore(tx, body.storeId));
        const entryNo = (
          await this.numbering.allocate(tx, {
            key: 'CONS',
            branchId,
            refType: 'inventory.cons_entries',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.cons_entries
             (id, hospital_id, branch_id, entry_no, store_id, cost_centre_id, entry_type,
              patient_id, encounter_id, performed_by, recorded_by, recorded_at, source, status,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::inventory."ConsEntryType",
                   $8, $9, $10, $11, now(), $12, 'posted'::inventory."ConsEntryStatus",
                   $11, $11, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            entryNo,
            body.storeId,
            costCentreId,
            body.entryType,
            body.patientId ?? null,
            body.encounterId ?? null,
            body.performedBy ?? null,
            ctx.userId,
            body.source,
          ],
        );

        let lineNo = 1;
        let totalValue = 0;
        const billingStatuses: string[] = [];

        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          const batchId =
            line.batchId ?? (await this.firstBatch(tx, body.storeId, line.itemId, item.tracking));
          const balance = await this.ledger.balance(tx, body.storeId, line.itemId, batchId);
          const unitCost = balance === undefined ? null : Number(balance.avg_cost);
          const value = unitCost === null ? 0 : unitCost * Number(converted.qtyBase);

          // Billable only when the item master says so *and* somebody is going to
          // be charged. Department consumption of a billable item is a cost, not
          // a charge, and marking it `pending` would leave a charge intent Phase 5
          // could never resolve to a patient.
          const isBillable =
            (line.isBillable ?? item.is_billable) &&
            body.entryType === 'patient' &&
            body.patientId !== undefined;
          const billingStatus = isBillable ? 'pending' : 'not_billable';
          billingStatuses.push(billingStatus);

          const lineId = newId();
          const posted = await this.ledger.post(tx, {
            storeId: body.storeId,
            branchId,
            itemId: line.itemId,
            batchId,
            movementType: 'consumption',
            qtyEntered: converted.qtyEntered,
            uomId: converted.uomId,
            unitCost,
            refType: 'consumption',
            refId: id,
            refLineId: lineId,
            patientId: body.patientId ?? null,
            encounterId: body.encounterId ?? null,
            costCentreId,
          });

          await tx.query(
            `INSERT INTO inventory.cons_entry_lines
               (id, hospital_id, entry_id, line_no, item_id, batch_id, uom_id, qty_entered, qty_base,
                unit_cost, value, is_billable, billing_status, expense_head, ledger_id,
                created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric,
                     $11::numeric, $12, $13::inventory."ConsBillingStatus", $14, $15, $16, $16, now())`,
            [
              lineId,
              ctx.hospitalId,
              id,
              lineNo,
              line.itemId,
              batchId,
              converted.uomId,
              converted.qtyEntered,
              converted.qtyBase,
              unitCost,
              value.toFixed(2),
              isBillable,
              billingStatus,
              line.expenseHead ?? null,
              posted.ledgerId,
              ctx.userId,
            ],
          );

          totalValue += value;
          lineNo += 1;
        }

        await tx.query(`UPDATE inventory.cons_entries SET total_value = $2::numeric WHERE id = $1`, [
          id,
          totalValue.toFixed(2),
        ]);

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.cons_entries',
          rowId: id,
          businessKey: entryNo,
          dataClass: body.patientId === undefined ? 'operational' : 'phi',
          patientId: body.patientId ?? null,
          encounterId: body.encounterId ?? null,
          before: null,
          after: { entry_type: body.entryType, lines: body.lines.length, value: totalValue.toFixed(2) },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('consumption.recorded', id, {
            entryId: id,
            entryNo,
            storeId: body.storeId,
            costCentreId,
            departmentKey: null,
            entryType: body.entryType,
            patientId: body.patientId ?? null,
            encounterId: body.encounterId ?? null,
            lineCount: body.lines.length,
            totalValue: moneyString(totalValue),
            currency: 'INR',
            billingStatuses,
            recordedBy: ctx.userId,
            recordedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(id);
  }

  async reverse(id: string, body: ReverseRequest): Promise<DocumentView> {
    const ctx = getContext();
    const reversalId = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const original = await tx.maybeOne<{
          id: string;
          entry_no: string;
          status: string;
          store_id: string;
          branch_id: string;
          cost_centre_id: string | null;
          entry_type: string;
          patient_id: string | null;
          encounter_id: string | null;
        }>(
          `SELECT id, entry_no, status::text AS status, store_id, branch_id, cost_centre_id,
                  entry_type::text AS entry_type, patient_id, encounter_id
             FROM inventory.cons_entries WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (original === undefined) throw AppError.notFound('The consumption entry');
        if (original.status === 'reversed') {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'This consumption entry has already been reversed.',
          );
        }

        const lines = await tx.rows<{
          id: string;
          item_id: string;
          batch_id: string | null;
          uom_id: string;
          qty_entered: string;
          qty_base: string;
          unit_cost: string | null;
          value: string | null;
          ledger_id: string | null;
        }>(
          `SELECT id, item_id, batch_id, uom_id, qty_entered::text AS qty_entered,
                  qty_base::text AS qty_base, unit_cost::text AS unit_cost, value::text AS value,
                  ledger_id
             FROM inventory.cons_entry_lines WHERE entry_id = $1 ORDER BY line_no`,
          [id],
        );

        const entryNo = (
          await this.numbering.allocate(tx, {
            key: 'CONS',
            branchId: original.branch_id,
            refType: 'inventory.cons_entries',
            refId: reversalId,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.cons_entries
             (id, hospital_id, branch_id, entry_no, store_id, cost_centre_id, entry_type,
              patient_id, encounter_id, recorded_by, recorded_at, source, status, reversal_of,
              reversal_reason, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::inventory."ConsEntryType",
                   $8, $9, $10, now(), 'manual_scan', 'reversed'::inventory."ConsEntryStatus",
                   $11, $12, $10, $10, now())`,
          [
            reversalId,
            ctx.hospitalId,
            original.branch_id,
            entryNo,
            original.store_id,
            original.cost_centre_id,
            original.entry_type,
            original.patient_id,
            original.encounter_id,
            ctx.userId,
            id,
            body.reason,
          ],
        );

        let lineNo = 1;
        let totalValue = 0;
        for (const line of lines) {
          if (line.ledger_id !== null) {
            await this.ledger.correct(tx, line.ledger_id, {
              qtyEntered: line.qty_entered,
              direction: 'in',
              reason: `Consumption ${original.entry_no} reversed: ${body.reason}`,
            });
          }
          await tx.query(
            `INSERT INTO inventory.cons_entry_lines
               (id, hospital_id, entry_id, line_no, item_id, batch_id, uom_id, qty_entered, qty_base,
                unit_cost, value, is_billable, billing_status, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric,
                     $11::numeric, false, 'reversed'::inventory."ConsBillingStatus", $12, $12, now())`,
            [
              newId(),
              ctx.hospitalId,
              reversalId,
              lineNo,
              line.item_id,
              line.batch_id,
              line.uom_id,
              line.qty_entered,
              line.qty_base,
              line.unit_cost,
              line.value,
              ctx.userId,
            ],
          );
          totalValue += Number(line.value ?? 0);
          lineNo += 1;
        }

        await tx.query(
          `UPDATE inventory.cons_entry_lines
              SET billing_status = 'reversed'::inventory."ConsBillingStatus", updated_at = now()
            WHERE entry_id = $1`,
          [id],
        );
        await tx.query(`UPDATE inventory.cons_entries SET total_value = $2::numeric WHERE id = $1`, [
          reversalId,
          totalValue.toFixed(2),
        ]);

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.cons_entries',
          rowId: reversalId,
          businessKey: entryNo,
          dataClass: original.patient_id === null ? 'operational' : 'phi',
          patientId: original.patient_id,
          reasonText: body.reason,
          before: { entry_no: original.entry_no, status: original.status },
          after: { status: 'reversed', reversal_of: id },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('consumption.reversed', reversalId, {
            entryId: reversalId,
            reversalOf: id,
            patientId: original.patient_id,
            reason: body.reason,
            reversedBy: ctx.userId,
            reversedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(reversalId);
  }

  // ── cost centres ─────────────────────────────────────────────────────────

  async createCostCentre(body: CostCentreRequest): Promise<CostCentreView> {
    const ctx = getContext();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `INSERT INTO finance.cost_centres
             (id, hospital_id, branch_id, code, name, parent_id, centre_type, owner_user_id,
              allocation_basis, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::finance."FinCostCentreType", $8,
                   $9::finance."FinAllocationBasis", $10, $10, now())`,
          [
            id,
            ctx.hospitalId,
            body.branchId ?? ctx.branchId,
            body.code,
            body.name,
            body.parentId ?? null,
            body.centreType,
            body.ownerUserId ?? null,
            body.allocationBasis,
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'finance.cost_centres',
          rowId: id,
          businessKey: body.code,
          dataClass: 'financial',
          before: null,
          after: { code: body.code, centre_type: body.centreType },
        });

        const today = await tx.one<{ d: string }>('SELECT current_date::text AS d');
        await this.outbox.publish(
          tx,
          inventoryEvent('costcentre.updated', id, {
            costCentreId: id,
            code: body.code,
            changedFields: ['created'],
            effectiveFrom: today.d,
            updatedBy: ctx.userId,
          }),
        );
      }),
    );

    return this.costCentre(id);
  }

  async costCentre(id: string): Promise<CostCentreView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<CostCentreRow>(
        `SELECT id, code, name, centre_type::text AS centre_type, parent_id, branch_id,
                owner_user_id, allocation_basis::text AS allocation_basis, active
           FROM finance.cost_centres WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The cost centre');
      return toCostCentreView(row);
    });
  }

  async listCostCentres(query: CostCentreQuery): Promise<Page<CostCentreView>> {
    const hospital = hospitalId();
    const resource = 'finance.cost_centres';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = ['c.deleted_at IS NULL'];
      if (query.centreType !== undefined) {
        clauses.push(`c.centre_type = ${bind(query.centreType)}::finance."FinCostCentreType"`);
      }
      if (after !== null) {
        clauses.push(`(c.code, c.id) > (${bind(after.k[0])}::varchar, ${bind(after.id)}::uuid)`);
      }
      const rows = await tx.rows<CostCentreRow & { cursor_key: string }>(
        `SELECT c.id, c.code, c.name, c.centre_type::text AS centre_type, c.parent_id, c.branch_id,
                c.owner_user_id, c.allocation_basis::text AS allocation_basis, c.active,
                c.code AS cursor_key
           FROM finance.cost_centres c
          WHERE ${clauses.join(' AND ')}
          ORDER BY c.code ASC, c.id ASC
          LIMIT ${bind(limit + 1)}`,
        values,
      );
      const page = this.cursors.keysetPage<CostCentreRow>(rows, limit, {
        hospitalId: hospital,
        resource,
        direction: 'asc',
      });
      return { items: page.items.map(toCostCentreView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  /** Consumption by cost centre for a period — the per-department cost report. */
  async byCostCentre(period: string): Promise<{
    readonly items: readonly {
      readonly costCentreId: string | null;
      readonly code: string | null;
      readonly name: string | null;
      readonly entries: number;
      readonly value: string;
    }[];
  }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await tx.rows<{
        cost_centre_id: string | null;
        code: string | null;
        name: string | null;
        entries: string;
        value: string;
      }>(
        `SELECT e.cost_centre_id, c.code, c.name, count(*)::text AS entries,
                COALESCE(sum(e.total_value), 0)::text AS value
           FROM inventory.cons_entries e
           LEFT JOIN finance.cost_centres c ON c.id = e.cost_centre_id
          WHERE to_char(e.recorded_at, 'YYYY-MM') = $1 AND e.status = 'posted'
          GROUP BY e.cost_centre_id, c.code, c.name
          ORDER BY sum(e.total_value) DESC NULLS LAST`,
        [period],
      );
      return {
        items: rows.map((r) => ({
          costCentreId: r.cost_centre_id,
          code: r.code,
          name: r.name,
          entries: Number(r.entries),
          value: r.value,
        })),
      };
    });
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<{
        id: string;
        entry_no: string;
        status: string;
        store_id: string;
        cost_centre_id: string | null;
        entry_type: string;
        patient_id: string | null;
        encounter_id: string | null;
        total_value: string | null;
        reversal_of: string | null;
        created_at: string;
      }>(
        `SELECT id, entry_no, status::text AS status, store_id, cost_centre_id,
                entry_type::text AS entry_type, patient_id, encounter_id,
                total_value::text AS total_value, reversal_of, created_at::text AS created_at
           FROM inventory.cons_entries WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The consumption entry');

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
        billing_status: string;
        value: string | null;
      }>(
        `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name, l.batch_id,
                b.batch_no, l.uom_id, l.qty_entered::text AS qty_entered, l.qty_base::text AS qty_base,
                l.billing_status::text AS billing_status, l.value::text AS value
           FROM inventory.cons_entry_lines l
           JOIN inventory.items i ON i.id = l.item_id
           LEFT JOIN inventory.item_batches b ON b.id = l.batch_id
          WHERE l.entry_id = $1 ORDER BY l.line_no`,
        [id],
      );

      return {
        id: header.id,
        documentNo: header.entry_no,
        status: header.status,
        storeId: header.store_id,
        counterpartyId: header.cost_centre_id,
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
          status: r.billing_status,
          extra: { value: r.value },
        })),
        header: {
          entryType: header.entry_type,
          patientId: header.patient_id,
          encounterId: header.encounter_id,
          totalValue: header.total_value,
          reversalOf: header.reversal_of,
        },
      };
    });
  }

  async list(query: ConsumptionQuery): Promise<Page<DocumentView>> {
    const hospital = hospitalId();
    const resource = 'inventory.consumption';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    const ids = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.storeId !== undefined) clauses.push(`e.store_id = ${bind(query.storeId)}::uuid`);
      if (query.costCentreId !== undefined)
        clauses.push(`e.cost_centre_id = ${bind(query.costCentreId)}::uuid`);
      if (query.patientId !== undefined) clauses.push(`e.patient_id = ${bind(query.patientId)}::uuid`);
      if (query.entryType !== undefined) clauses.push(`e.entry_type::text = ${bind(query.entryType)}`);
      if (after !== null) {
        clauses.push(`(e.created_at, e.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      return tx.rows<{ id: string; cursor_key: string }>(
        `SELECT e.id, e.created_at::text AS cursor_key FROM inventory.cons_entries e
         ${where} ORDER BY e.created_at DESC, e.id DESC LIMIT ${bind(limit + 1)}`,
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

  private async costCentreForStore(tx: TransactionClient, storeId: string): Promise<string | null> {
    const mapped = await tx.maybeOne<{ cost_centre_id: string }>(
      `SELECT cost_centre_id FROM finance.cost_centre_mappings
        WHERE entity_type = 'store' AND entity_id = $1
          AND effective_from <= current_date
          AND (effective_to IS NULL OR effective_to > current_date)
        LIMIT 1`,
      [storeId],
    );
    if (mapped !== undefined) return mapped.cost_centre_id;
    const store = await tx.maybeOne<{ cost_centre_id: string | null }>(
      `SELECT cost_centre_id FROM inventory.stores WHERE id = $1 AND deleted_at IS NULL`,
      [storeId],
    );
    return store?.cost_centre_id ?? null;
  }

  private async firstBatch(
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
      'There is no issuable batch of that item in this store, so nothing can be consumed from it.',
    );
  }
}

interface CostCentreRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly centre_type: string;
  readonly parent_id: string | null;
  readonly branch_id: string | null;
  readonly owner_user_id: string | null;
  readonly allocation_basis: string;
  readonly active: boolean;
}

function toCostCentreView(row: CostCentreRow): CostCentreView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    centreType: row.centre_type,
    parentId: row.parent_id,
    branchId: row.branch_id,
    ownerUserId: row.owner_user_id,
    allocationBasis: row.allocation_basis,
    active: row.active,
  };
}
