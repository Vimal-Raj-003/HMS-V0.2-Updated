import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { getContext } from '../../core/context/request-context.js';
import { DatabaseService } from '../../core/db/database.service.js';
import { OutboxService } from '../../core/outbox/outbox.service.js';
import { CursorService } from '../../core/pagination/cursor.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';
import { binder, hospitalId, quantityString, withInventoryErrors } from './inventory.common.js';
import { inventoryEvent } from './inventory.events.js';
import type {
  ExpiryQuery,
  LedgerQuery,
  PutawayRequest,
  QuarantineRequest,
  ReleaseQuarantineRequest,
  StockQuery,
} from './inventory.schemas.js';
import type { FefoBatchView, IntegrityRow, LedgerEntryView, StockBalanceView } from './inventory.types.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { UomService } from './uom.service.js';

/**
 * NC-006 §3.3, §3.4 and §3.7 — reading the ledger, and the two writes that are
 * about *where* stock is rather than how much of it there is.
 *
 * **Quarantine is a hold on a batch, not a movement of it.** Putting a batch on
 * hold does not change any balance: the units are still on the shelf, still
 * counted, still owned. What changes is that `enforce_ledger_preconditions()`
 * will refuse to let them go towards a patient while an *undecided* quarantine
 * exists — so the release decision is the thing that must be recorded, and an
 * undecided quarantine is not a released one.
 *
 * **Putaway is a movement of one unit of stock from one bin to another**, and it
 * is written as two ledger rows rather than as an update to a balance, because
 * `stock_balances` has exactly one writer and it is a trigger. The two rows
 * cancel in total and net to nothing in the store's balance, which is correct:
 * shelving something does not create or destroy it.
 *
 * `verifyIntegrity` is `phase-04` exit gate 6, exposed as a route rather than
 * left as a test fixture: `sum(ledger) = on_hand` is the invariant the whole
 * phase rests on, and a hospital should be able to ask the question at 2 a.m.
 * without a developer.
 */
@Injectable()
export class StockService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(UomService) private readonly uoms: UomService,
  ) {}

  async balances(query: StockQuery): Promise<Page<StockBalanceView>> {
    const hospital = hospitalId();
    const resource = 'inventory.stock';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.storeId !== undefined) clauses.push(`b.store_id = ${bind(query.storeId)}::uuid`);
      if (query.itemId !== undefined) clauses.push(`b.item_id = ${bind(query.itemId)}::uuid`);
      if (query.batchId !== undefined) clauses.push(`b.batch_id = ${bind(query.batchId)}::uuid`);
      if (query.onlyPositive) clauses.push(`b.qty_on_hand > 0`);
      if (!query.includeConsignment) clauses.push(`NOT b.is_consignment`);
      if (query.expiringInDays !== undefined) {
        clauses.push(
          `ib.expiry_date IS NOT NULL AND ib.expiry_date <= current_date + ${bind(query.expiringInDays)}::int`,
        );
      }
      if (after !== null) {
        clauses.push(`(b.id::text) > ${bind(after.k[0])}`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<BalanceRow & { cursor_key: string }>(
        `SELECT b.id, b.store_id, b.location_id, b.item_id, i.code AS item_code, i.name AS item_name,
                i.base_uom_id AS uom_id, b.batch_id, ib.batch_no,
                ib.expiry_date::text AS expiry_date,
                b.qty_on_hand::text AS qty_on_hand, b.qty_reserved::text AS qty_reserved,
                (b.qty_on_hand - b.qty_reserved)::text AS qty_available,
                b.avg_cost::text AS avg_cost, b.value::text AS value, b.is_consignment,
                b.last_movement_at::text AS last_movement_at,
                b.id::text AS cursor_key
           FROM inventory.stock_balances b
           JOIN inventory.items i ON i.id = b.item_id
           LEFT JOIN inventory.item_batches ib ON ib.id = b.batch_id
           ${where}
          ORDER BY b.id ASC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<BalanceRow>(rows, limit, {
        hospitalId: hospital,
        resource,
        direction: 'asc',
      });
      return { items: page.items.map(toBalanceView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  /** Cross-store availability for one item — the "who else has it" question. */
  async availability(itemId: string): Promise<{
    readonly items: readonly {
      readonly storeId: string;
      readonly storeCode: string;
      readonly storeName: string;
      readonly qtyAvailable: string;
      readonly batchCount: number;
      readonly earliestExpiry: string | null;
    }[];
  }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await tx.rows<{
        store_id: string;
        code: string;
        name: string;
        qty_available: string;
        batch_count: string;
        earliest_expiry: string | null;
      }>(
        `SELECT b.store_id, s.code, s.name,
                sum(b.qty_on_hand - b.qty_reserved)::text AS qty_available,
                count(DISTINCT b.batch_id)::text AS batch_count,
                min(ib.expiry_date)::text AS earliest_expiry
           FROM inventory.stock_balances b
           JOIN inventory.stores s ON s.id = b.store_id AND s.deleted_at IS NULL
           LEFT JOIN inventory.item_batches ib ON ib.id = b.batch_id AND ib.status = 'active'
          WHERE b.item_id = $1 AND b.qty_on_hand > 0
          GROUP BY b.store_id, s.code, s.name
          ORDER BY sum(b.qty_on_hand - b.qty_reserved) DESC`,
        [itemId],
      );
      return {
        items: rows.map((r) => ({
          storeId: r.store_id,
          storeCode: r.code,
          storeName: r.name,
          qtyAvailable: r.qty_available,
          batchCount: Number(r.batch_count),
          earliestExpiry: r.earliest_expiry,
        })),
      };
    });
  }

  /** FEFO, from the database function, so the suggestion cannot outrun the guard. */
  async fefoBatches(storeId: string, itemId: string): Promise<{ readonly items: readonly FefoBatchView[] }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await this.ledger.fefo(tx, storeId, itemId);
      if (rows.length === 0) return { items: [] };
      const details = await tx.rows<{
        id: string;
        batch_no: string;
        mrp: string | null;
        is_consignment: boolean;
      }>(
        `SELECT id, batch_no, mrp::text AS mrp, is_consignment
           FROM inventory.item_batches WHERE id = ANY($1::uuid[])`,
        [rows.map((r) => r.batch_id)],
      );
      const byId = new Map(details.map((d) => [d.id, d]));
      return {
        items: rows.map((r) => {
          const detail = byId.get(r.batch_id);
          return {
            batchId: r.batch_id,
            batchNo: detail?.batch_no ?? '',
            expiryDate: r.expiry_date,
            qtyAvailable: r.qty_available,
            unitCost: r.unit_cost,
            mrp: detail?.mrp ?? null,
            isConsignment: detail?.is_consignment ?? false,
          };
        }),
      };
    });
  }

  async ledgerEntries(query: LedgerQuery): Promise<Page<LedgerEntryView>> {
    const hospital = hospitalId();
    const resource = 'inventory.ledger';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.storeId !== undefined) clauses.push(`l.store_id = ${bind(query.storeId)}::uuid`);
      if (query.itemId !== undefined) clauses.push(`l.item_id = ${bind(query.itemId)}::uuid`);
      if (query.batchId !== undefined) clauses.push(`l.batch_id = ${bind(query.batchId)}::uuid`);
      if (query.movementType !== undefined) {
        clauses.push(`l.movement_type = ${bind(query.movementType)}::inventory."InvMovementType"`);
      }
      if (query.from !== undefined) clauses.push(`l.moved_at >= ${bind(query.from)}::timestamptz`);
      if (query.to !== undefined) clauses.push(`l.moved_at <= ${bind(query.to)}::timestamptz`);
      if (after !== null) {
        clauses.push(`(l.moved_at, l.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;

      const rows = await tx.rows<LedgerRow & { cursor_key: string }>(
        `SELECT l.id, l.store_id, l.item_id, i.code AS item_code, l.batch_id, ib.batch_no,
                l.movement_type::text AS movement_type, l.qty_base::text AS qty_base,
                l.qty_entered::text AS qty_entered, l.uom_id, l.unit_cost::text AS unit_cost,
                l.value::text AS value, l.ref_type::text AS ref_type, l.ref_id,
                l.corrects_ledger_id, l.reason, l.is_consignment, l.actor_id, l.second_actor_id,
                l.moved_at::text AS moved_at, l.moved_at::text AS cursor_key
           FROM inventory.stock_ledger l
           JOIN inventory.items i ON i.id = l.item_id
           LEFT JOIN inventory.item_batches ib ON ib.id = l.batch_id
           ${where}
          ORDER BY l.moved_at DESC, l.id DESC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<LedgerRow>(rows, limit, {
        hospitalId: hospital,
        resource,
        direction: 'desc',
      });
      return { items: page.items.map(toLedgerView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  /**
   * `inventory.batch.trace` — everywhere a batch has been, and everyone who got
   * some of it.
   *
   * The patient half is the reason this permission is separate: a recall needs
   * it, and nothing else does. It reads through the partial index
   * `idx_stock_ledger_patient_trace`, which exists precisely so this query does
   * not scan the busiest table in the phase.
   */
  async traceBatch(batchId: string): Promise<{
    readonly batch: {
      readonly id: string;
      readonly batchNo: string;
      readonly itemId: string;
      readonly itemCode: string;
      readonly expiryDate: string | null;
      readonly status: string;
    };
    readonly movements: readonly LedgerEntryView[];
    readonly patients: readonly {
      readonly patientId: string;
      readonly qtyBase: string;
      readonly lastAt: string;
    }[];
    readonly stores: readonly { readonly storeId: string; readonly qtyOnHand: string }[];
  }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const batch = await tx.maybeOne<{
        id: string;
        batch_no: string;
        item_id: string;
        item_code: string;
        expiry_date: string | null;
        status: string;
      }>(
        `SELECT b.id, b.batch_no, b.item_id, i.code AS item_code,
                b.expiry_date::text AS expiry_date, b.status::text AS status
           FROM inventory.item_batches b
           JOIN inventory.items i ON i.id = b.item_id
          WHERE b.id = $1`,
        [batchId],
      );
      if (batch === undefined) throw AppError.notFound('The batch');

      const movements = await tx.rows<LedgerRow>(
        `SELECT l.id, l.store_id, l.item_id, i.code AS item_code, l.batch_id, ib.batch_no,
                l.movement_type::text AS movement_type, l.qty_base::text AS qty_base,
                l.qty_entered::text AS qty_entered, l.uom_id, l.unit_cost::text AS unit_cost,
                l.value::text AS value, l.ref_type::text AS ref_type, l.ref_id,
                l.corrects_ledger_id, l.reason, l.is_consignment, l.actor_id, l.second_actor_id,
                l.moved_at::text AS moved_at
           FROM inventory.stock_ledger l
           JOIN inventory.items i ON i.id = l.item_id
           LEFT JOIN inventory.item_batches ib ON ib.id = l.batch_id
          WHERE l.batch_id = $1
          ORDER BY l.moved_at DESC, l.id DESC
          LIMIT 500`,
        [batchId],
      );

      const patients = await tx.rows<{ patient_id: string; qty: string; last_at: string }>(
        `SELECT l.patient_id, sum(-l.qty_base)::text AS qty, max(l.moved_at)::text AS last_at
           FROM inventory.stock_ledger l
          WHERE l.batch_id = $1 AND l.patient_id IS NOT NULL AND l.qty_base < 0
          GROUP BY l.patient_id
          ORDER BY max(l.moved_at) DESC`,
        [batchId],
      );

      const stores = await tx.rows<{ store_id: string; qty: string }>(
        `SELECT store_id, sum(qty_on_hand)::text AS qty
           FROM inventory.stock_balances
          WHERE batch_id = $1
          GROUP BY store_id
         HAVING sum(qty_on_hand) <> 0`,
        [batchId],
      );

      return {
        batch: {
          id: batch.id,
          batchNo: batch.batch_no,
          itemId: batch.item_id,
          itemCode: batch.item_code,
          expiryDate: batch.expiry_date,
          status: batch.status,
        },
        movements: movements.map(toLedgerView),
        patients: patients.map((p) => ({
          patientId: p.patient_id,
          qtyBase: p.qty,
          lastAt: new Date(p.last_at).toISOString(),
        })),
        stores: stores.map((s) => ({ storeId: s.store_id, qtyOnHand: s.qty })),
      };
    });
  }

  // ── quarantine ───────────────────────────────────────────────────────────

  async quarantine(batchId: string, body: QuarantineRequest): Promise<{ readonly quarantineId: string }> {
    const ctx = getContext();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const batch = await tx.maybeOne<{
          batch_no: string;
          item_id: string;
          item_code: string;
          expiry_date: string | null;
          status: string;
        }>(
          `SELECT b.batch_no, b.item_id, i.code AS item_code, b.expiry_date::text AS expiry_date,
                  b.status::text AS status
             FROM inventory.item_batches b JOIN inventory.items i ON i.id = b.item_id
            WHERE b.id = $1`,
          [batchId],
        );
        if (batch === undefined) throw AppError.notFound('The batch');

        await tx.query(
          `INSERT INTO inventory.quarantines
             (id, hospital_id, batch_id, scope, store_id, reason, started_at, decision,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::inventory."InvQuarantineReason", now(), 'pending', $7, $7, now())`,
          [id, ctx.hospitalId, batchId, body.scope, body.storeId ?? null, body.reason, ctx.userId],
        );

        await tx.query(
          `UPDATE inventory.item_batches
              SET status = 'quarantined'::inventory."InvBatchStatus", quarantine_reason = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [batchId, body.note, ctx.userId],
        );

        const held = await tx.maybeOne<{ qty: string | null }>(
          `SELECT sum(qty_on_hand)::text AS qty FROM inventory.stock_balances WHERE batch_id = $1`,
          [batchId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.quarantines',
          rowId: id,
          businessKey: batch.batch_no,
          dataClass: 'operational',
          reasonText: body.note,
          before: { status: batch.status },
          after: { scope: body.scope, reason: body.reason },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.batch.quarantined', batchId, {
            storeId: body.storeId ?? ctx.branchId ?? batchId,
            itemId: batch.item_id,
            itemCode: batch.item_code,
            batchId,
            batchNo: batch.batch_no,
            expiryDate: batch.expiry_date,
            quarantineId: id,
            scope: body.scope,
            reason: body.reason,
            qtyHeldBase: quantityString(Number(held?.qty ?? 0)),
            quarantinedBy: ctx.userId,
            quarantinedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return { quarantineId: id };
  }

  async releaseQuarantine(batchId: string, body: ReleaseQuarantineRequest): Promise<void> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const batch = await tx.maybeOne<{
          batch_no: string;
          item_id: string;
          item_code: string;
          expiry_date: string | null;
          status: string;
        }>(
          `SELECT b.batch_no, b.item_id, i.code AS item_code, b.expiry_date::text AS expiry_date,
                  b.status::text AS status
             FROM inventory.item_batches b JOIN inventory.items i ON i.id = b.item_id
            WHERE b.id = $1`,
          [batchId],
        );
        if (batch === undefined) throw AppError.notFound('The batch');

        const open = await tx.rows<{ id: string }>(
          `SELECT id FROM inventory.quarantines WHERE batch_id = $1 AND decision = 'pending'`,
          [batchId],
        );
        if (open.length === 0) {
          throw new AppError(
            ProblemType.ALREADY_DECIDED,
            'There is no undecided quarantine on this batch to release.',
          );
        }

        await tx.query(
          `UPDATE inventory.quarantines
              SET decision = 'released', decided_by = $2, decision_note = $3,
                  released_at = now(), updated_at = now(), updated_by = $2
            WHERE batch_id = $1 AND decision = 'pending'`,
          [batchId, ctx.userId, body.decisionNote],
        );

        // An expired batch never goes back to `active`, whatever the decision on
        // the quarantine was: the ledger would refuse to move it towards a
        // patient anyway, and a batch marked active that cannot be dispensed is
        // a lie the shelf label will repeat.
        await tx.query(
          `UPDATE inventory.item_batches
              SET status = CASE
                    WHEN expiry_date IS NOT NULL AND expiry_date <= current_date
                      THEN 'expired'::inventory."InvBatchStatus"
                    ELSE 'active'::inventory."InvBatchStatus"
                  END,
                  quarantine_reason = NULL, updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1 AND status = 'quarantined'`,
          [batchId, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.quarantines',
          rowId: batchId,
          businessKey: batch.batch_no,
          dataClass: 'operational',
          reasonText: body.decisionNote,
          before: { status: batch.status },
          after: { decision: 'released' },
        });

        const first = open[0];
        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.batch.released', batchId, {
            storeId: batchId,
            itemId: batch.item_id,
            itemCode: batch.item_code,
            batchId,
            batchNo: batch.batch_no,
            expiryDate: batch.expiry_date,
            quarantineId: first === undefined ? batchId : first.id,
            reason: body.decisionNote,
            releasedBy: ctx.userId,
            releasedAt: new Date().toISOString(),
          }),
        );
      }),
    );
  }

  // ── putaway ──────────────────────────────────────────────────────────────

  /**
   * Shelving received stock: out of the receiving position, into a bin.
   *
   * Two compensating ledger rows per line, not an update: `stock_balances` has
   * one writer and it is a trigger, and an update here would put a second writer
   * beside it — at which point `sum(ledger) = on_hand` stops being an invariant
   * and becomes a hope.
   */
  async putaway(body: PutawayRequest): Promise<{ readonly moved: number }> {
    return withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const ref = newId();
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);

          await this.ledger.post(tx, {
            storeId: body.storeId,
            itemId: line.itemId,
            batchId: line.batchId ?? null,
            movementType: 'repack_out',
            qtyEntered: converted.qtyEntered,
            uomId: converted.uomId,
            refType: 'repack',
            refId: ref,
            remarks: 'Put away from the receiving bay',
          });
          await this.ledger.post(tx, {
            storeId: body.storeId,
            locationId: body.locationId,
            itemId: line.itemId,
            batchId: line.batchId ?? null,
            movementType: 'repack_in',
            qtyEntered: converted.qtyEntered,
            uomId: converted.uomId,
            refType: 'repack',
            refId: ref,
            remarks: 'Put away to bin',
          });
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.stock_ledger',
          rowId: ref,
          businessKey: `putaway/${body.storeId}`,
          dataClass: 'operational',
          before: null,
          after: { store_id: body.storeId, location_id: body.locationId, lines: body.lines.length },
        });

        return { moved: body.lines.length };
      }),
    );
  }

  // ── expiry and integrity ─────────────────────────────────────────────────

  async expiring(query: ExpiryQuery): Promise<Page<StockBalanceView>> {
    return this.balances({
      ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
      expiringInDays: query.days,
      includeConsignment: true,
      onlyPositive: true,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: query.limit,
    });
  }

  /**
   * `phase-04` exit gate 6, as an endpoint.
   *
   * An empty result is the pass condition. Anything else is a defect in the
   * projection trigger rather than in the data, which is why the response says
   * so rather than offering to "fix" it — a repair that wrote to
   * `stock_balances` would be the second writer this design does not have.
   */
  async verifyIntegrity(): Promise<{ readonly ok: boolean; readonly rows: readonly IntegrityRow[] }> {
    const hospital = hospitalId();
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await tx.rows<{
        store_id: string;
        item_id: string;
        batch_id: string | null;
        ledger_sum: string;
        balance_qty: string;
        difference: string;
      }>(
        `SELECT store_id, item_id, batch_id, ledger_sum::text AS ledger_sum,
                balance_qty::text AS balance_qty, difference::text AS difference
           FROM inventory.verify_stock_integrity($1::uuid)
          LIMIT 200`,
        [hospital],
      );
      return {
        ok: rows.length === 0,
        rows: rows.map((r) => ({
          storeId: r.store_id,
          itemId: r.item_id,
          batchId: r.batch_id,
          ledgerSum: r.ledger_sum,
          balanceQty: r.balance_qty,
          difference: r.difference,
        })),
      };
    });
  }
}

interface BalanceRow {
  readonly id: string;
  readonly store_id: string;
  readonly location_id: string | null;
  readonly item_id: string;
  readonly item_code: string;
  readonly item_name: string;
  readonly uom_id: string;
  readonly batch_id: string | null;
  readonly batch_no: string | null;
  readonly expiry_date: string | null;
  readonly qty_on_hand: string;
  readonly qty_reserved: string;
  readonly qty_available: string;
  readonly avg_cost: string;
  readonly value: string;
  readonly is_consignment: boolean;
  readonly last_movement_at: string | null;
}

interface LedgerRow {
  readonly id: string;
  readonly store_id: string;
  readonly item_id: string;
  readonly item_code: string;
  readonly batch_id: string | null;
  readonly batch_no: string | null;
  readonly movement_type: string;
  readonly qty_base: string;
  readonly qty_entered: string;
  readonly uom_id: string;
  readonly unit_cost: string | null;
  readonly value: string | null;
  readonly ref_type: string;
  readonly ref_id: string;
  readonly corrects_ledger_id: string | null;
  readonly reason: string | null;
  readonly is_consignment: boolean;
  readonly actor_id: string | null;
  readonly second_actor_id: string | null;
  readonly moved_at: string;
}

function toBalanceView(row: BalanceRow): StockBalanceView {
  return {
    id: row.id,
    storeId: row.store_id,
    locationId: row.location_id,
    itemId: row.item_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    batchId: row.batch_id,
    batchNo: row.batch_no,
    expiryDate: row.expiry_date,
    qtyOnHand: row.qty_on_hand,
    qtyReserved: row.qty_reserved,
    qtyAvailable: row.qty_available,
    avgCost: row.avg_cost,
    value: row.value,
    isConsignment: row.is_consignment,
    uomId: row.uom_id,
    lastMovementAt: row.last_movement_at === null ? null : new Date(row.last_movement_at).toISOString(),
  };
}

function toLedgerView(row: LedgerRow): LedgerEntryView {
  return {
    id: row.id,
    storeId: row.store_id,
    itemId: row.item_id,
    itemCode: row.item_code,
    batchId: row.batch_id,
    batchNo: row.batch_no,
    movementType: row.movement_type,
    qtyBase: row.qty_base,
    qtyEntered: row.qty_entered,
    uomId: row.uom_id,
    unitCost: row.unit_cost,
    value: row.value,
    refType: row.ref_type,
    refId: row.ref_id,
    correctsLedgerId: row.corrects_ledger_id,
    reason: row.reason,
    isConsignment: row.is_consignment,
    actorId: row.actor_id,
    secondActorId: row.second_actor_id,
    movedAt: new Date(row.moved_at).toISOString(),
  };
}
