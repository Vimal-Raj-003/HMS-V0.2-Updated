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
import { binder, hospitalId, moneyString, quantityString, withInventoryErrors } from './inventory.common.js';
import { inventoryEvent } from './inventory.events.js';
import type {
  BlockItemRequest,
  CreateItemRequest,
  ItemPriceRequest,
  ItemQuery,
  MapBarcodeRequest,
  StoreParamsRequest,
  UpdateItemRequest,
} from './inventory.schemas.js';
import type { ItemView, ItemUomView, ScanResolution } from './inventory.types.js';
import { UomService } from './uom.service.js';

/**
 * NC-006 §3.1 — the item master, and the two things that make it more than a
 * table of names.
 *
 * **The conversion ladder is written with the item, and its base rung is not the
 * caller's to supply.** `inventory.enforce_item_uom` requires exactly one rung
 * marked `is_base`, with `factor_to_base = 1`, naming the item's own
 * `base_uom_id`, in the same dimension. Every one of those is derivable from
 * `baseUomId`, so this service derives them: there is no request shape in which
 * a client can create an item whose ladder is malformed, which means the trigger
 * is a backstop here rather than a routine failure mode.
 *
 * **A barcode resolves to an item, a pack size, a batch and an expiry in one
 * scan.** `EN-013 §3` and `phase-04 §4.4` both want the counter driven by the
 * scanner, and a GS1 DataMatrix on a medicine pack already carries all four in
 * its application identifiers. `resolveScan` parses them rather than asking the
 * pharmacist to read an expiry off a foil and type it — which is the step that
 * goes wrong at 11 a.m. on a Monday.
 */

interface ItemRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly short_name: string | null;
  readonly generic_name: string | null;
  readonly drug_key: string | null;
  readonly category_id: string;
  readonly item_type: string;
  readonly manufacturer_id: string | null;
  readonly base_uom_id: string;
  readonly purchase_uom_id: string | null;
  readonly issue_uom_id: string | null;
  readonly dispense_uom_id: string | null;
  readonly hsn_code: string | null;
  readonly schedule: string;
  readonly is_narcotic: boolean;
  readonly is_high_alert: boolean;
  readonly is_lasa: boolean;
  readonly dpco_scheduled: boolean;
  readonly storage_condition: string;
  readonly tracking: string;
  readonly min_shelf_life_days: number | null;
  readonly shelf_life_days: number | null;
  readonly lead_time_days: number | null;
  readonly is_consignment_allowed: boolean;
  readonly is_returnable: boolean;
  readonly is_billable: boolean;
  readonly abc_class: string;
  readonly ved_class: string;
  readonly fsn_class: string;
  readonly status: string;
  readonly notes: string | null;
}

/** The columns an update may reach, and the column each request field writes. */
const UPDATABLE: Readonly<Record<string, string>> = {
  name: 'name',
  shortName: 'short_name',
  genericName: 'generic_name',
  categoryId: 'category_id',
  manufacturerId: 'manufacturer_id',
  hsnCode: 'hsn_code',
  minShelfLifeDays: 'min_shelf_life_days',
  leadTimeDays: 'lead_time_days',
  isConsignmentAllowed: 'is_consignment_allowed',
  isReturnable: 'is_returnable',
  isBillable: 'is_billable',
  isNarcotic: 'is_narcotic',
  isHighAlert: 'is_high_alert',
  isLasa: 'is_lasa',
  notes: 'notes',
  purchaseUomId: 'purchase_uom_id',
  issueUomId: 'issue_uom_id',
  dispenseUomId: 'dispense_uom_id',
};

/** The same, for the columns that need an explicit enum cast. */
const UPDATABLE_ENUMS: Readonly<Record<string, readonly [string, string]>> = {
  schedule: ['schedule', 'mdm."MdmDrugSchedule"'],
  storageCondition: ['storage_condition', 'inventory."InvStorageCondition"'],
  abcClass: ['abc_class', 'inventory."InvAbcClass"'],
  vedClass: ['ved_class', 'inventory."InvVedClass"'],
  fsnClass: ['fsn_class', 'inventory."InvFsnClass"'],
  status: ['status', 'inventory."InvMasterStatus"'],
};

@Injectable()
export class ItemsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(UomService) private readonly uoms: UomService,
  ) {}

  async create(body: CreateItemRequest): Promise<ItemView> {
    const ctx = getContext();
    const id = newId();

    const created = await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const code =
          body.code ??
          (await this.numbering.allocate(tx, { key: 'ITEM', refType: 'inventory.items', refId: id }))
            .formatted;

        await tx.query(
          `INSERT INTO inventory.items (
             id, hospital_id, code, name, short_name, generic_name, drug_key, category_id,
             item_type, manufacturer_id, base_uom_id, hsn_code, schedule, is_narcotic,
             is_high_alert, is_lasa, dpco_scheduled, storage_condition, tracking,
             min_shelf_life_days, shelf_life_days, lead_time_days, is_consignment_allowed,
             is_returnable, is_billable, abc_class, ved_class, notes, status,
             created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9::inventory."InvItemType", $10, $11, $12, $13::mdm."MdmDrugSchedule", $14,
             $15, $16, $17, $18::inventory."InvStorageCondition", $19::inventory."InvTracking",
             $20, $21, $22, $23,
             $24, $25, $26::inventory."InvAbcClass", $27::inventory."InvVedClass", $28, 'active',
             $29, $29, now()
           )`,
          [
            id,
            ctx.hospitalId,
            code,
            body.name,
            body.shortName ?? null,
            body.genericName ?? null,
            body.drugKey ?? null,
            body.categoryId,
            body.itemType,
            body.manufacturerId ?? null,
            body.baseUomId,
            body.hsnCode ?? null,
            body.schedule,
            body.isNarcotic,
            body.isHighAlert,
            body.isLasa,
            body.dpcoScheduled,
            body.storageCondition,
            body.tracking,
            body.minShelfLifeDays ?? null,
            body.shelfLifeDays ?? null,
            body.leadTimeDays ?? null,
            body.isConsignmentAllowed,
            body.isReturnable,
            body.isBillable,
            body.abcClass,
            body.vedClass,
            body.notes ?? null,
            ctx.userId,
          ],
        );

        // The base rung, derived rather than requested. A caller who also listed
        // the base unit gets one rung, not two: the unique index on
        // `(item_id) WHERE is_base` would otherwise refuse the second, and the
        // refusal would be about an index rather than about a duplicate.
        await this.insertRung(tx, id, {
          uomId: body.baseUomId,
          factorToBase: 1,
          packLevel: 'base',
          isBase: true,
          isPurchaseDefault: false,
          isIssueDefault: false,
          isDispenseDefault: true,
          gtin: null,
        });

        for (const rung of body.uoms) {
          if (rung.uomId === body.baseUomId) continue;
          await this.insertRung(tx, id, {
            uomId: rung.uomId,
            factorToBase: rung.factorToBase,
            packLevel: rung.packLevel,
            isBase: false,
            isPurchaseDefault: rung.isPurchaseDefault,
            isIssueDefault: rung.isIssueDefault,
            isDispenseDefault: false,
            gtin: rung.gtin ?? null,
          });
        }

        const purchaseDefault = body.uoms.find((u) => u.isPurchaseDefault)?.uomId ?? body.baseUomId;
        const issueDefault = body.uoms.find((u) => u.isIssueDefault)?.uomId ?? body.baseUomId;
        await tx.query(
          `UPDATE inventory.items
              SET purchase_uom_id = $2, issue_uom_id = $3, dispense_uom_id = $4, updated_at = now()
            WHERE id = $1`,
          [id, purchaseDefault, issueDefault, body.baseUomId],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.items',
          rowId: id,
          businessKey: code,
          dataClass: 'operational',
          before: null,
          after: {
            code,
            name: body.name,
            item_type: body.itemType,
            schedule: body.schedule,
            is_narcotic: body.isNarcotic,
            tracking: body.tracking,
          },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.item.created', id, {
            itemId: id,
            code,
            name: body.name,
            itemType: body.itemType,
            schedule: body.schedule,
            isNarcotic: body.isNarcotic,
            tracking: body.tracking,
            baseUomId: body.baseUomId,
            createdBy: ctx.userId,
          }),
        );

        return id;
      }),
    );

    return this.get(created);
  }

  async update(id: string, body: UpdateItemRequest): Promise<ItemView> {
    const before = await this.get(id);
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const values: unknown[] = [id];
        const bind = binder(values);
        const sets: string[] = [];
        const changed: string[] = [];

        for (const [field, column] of Object.entries(UPDATABLE)) {
          const value = (body as Record<string, unknown>)[field];
          if (value === undefined) continue;
          sets.push(`${column} = ${bind(value)}`);
          changed.push(field);
        }
        for (const [field, [column, cast]] of Object.entries(UPDATABLE_ENUMS)) {
          const value = (body as Record<string, unknown>)[field];
          if (value === undefined) continue;
          sets.push(`${column} = ${bind(value)}::${cast}`);
          changed.push(field);
        }
        if (sets.length === 0) return;

        sets.push(`updated_at = now()`, `updated_by = ${bind(ctx.userId)}`, `version = version + 1`);
        await tx.query(
          `UPDATE inventory.items SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
          values,
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.items',
          rowId: id,
          businessKey: before.code,
          dataClass: 'operational',
          before: { schedule: before.schedule, isNarcotic: before.isNarcotic, status: before.status },
          after: { changed },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.item.updated', id, {
            itemId: id,
            code: before.code,
            changedFields: changed,
            updatedBy: ctx.userId,
          }),
        );
      }),
    );

    return this.get(id);
  }

  /**
   * NC-006 §5 — an item is not blocked while stock of it is on a shelf.
   *
   * Blocking an item with stock is how a ward discovers, at 3 a.m., that the
   * thing in its cupboard cannot be issued and cannot be written off either.
   * The balance is read first and the refusal names the quantity, so the answer
   * is "issue or write off these 240 first", not "no".
   */
  async block(id: string, body: BlockItemRequest): Promise<ItemView> {
    const before = await this.get(id);
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const onHand = await tx.maybeOne<{ qty: string | null }>(
          `SELECT sum(qty_on_hand)::text AS qty FROM inventory.stock_balances WHERE item_id = $1`,
          [id],
        );
        const qty = Number(onHand?.qty ?? 0);
        if (qty > 0) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `${before.code} still has ${qty} base units on hand across the hospital’s stores. Issue, transfer or write that off before blocking the item — a blocked item with stock is stock nobody can move.`,
          );
        }

        await tx.query(
          `UPDATE inventory.items
              SET status = 'blocked'::inventory."InvMasterStatus", notes = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1 AND deleted_at IS NULL`,
          [id, body.reason, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.items',
          rowId: id,
          businessKey: before.code,
          dataClass: 'operational',
          reasonText: body.reason,
          before: { status: before.status },
          after: { status: 'blocked' },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.item.blocked', id, {
            itemId: id,
            code: before.code,
            reason: body.reason,
            qtyOnHandBase: quantityString(qty),
            blockedBy: ctx.userId,
          }),
        );
      }),
    );

    return this.get(id);
  }

  async activate(id: string): Promise<ItemView> {
    const before = await this.get(id);
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `UPDATE inventory.items
              SET status = 'active'::inventory."InvMasterStatus",
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1 AND deleted_at IS NULL`,
          [id, ctx.userId],
        );
        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.items',
          rowId: id,
          businessKey: before.code,
          dataClass: 'operational',
          before: { status: before.status },
          after: { status: 'active' },
        });
        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.item.updated', id, {
            itemId: id,
            code: before.code,
            changedFields: ['status'],
            updatedBy: ctx.userId,
          }),
        );
      }),
    );
    return this.get(id);
  }

  /** Adds a rung to an existing ladder — a new pack size the vendor started shipping. */
  async addUom(
    id: string,
    rung: {
      readonly uomId: string;
      readonly factorToBase: number;
      readonly packLevel: string;
      readonly isPurchaseDefault: boolean;
      readonly isIssueDefault: boolean;
      readonly gtin?: string;
    },
  ): Promise<readonly ItemUomView[]> {
    await this.get(id);
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await this.insertRung(tx, id, {
          uomId: rung.uomId,
          factorToBase: rung.factorToBase,
          packLevel: rung.packLevel,
          isBase: false,
          isPurchaseDefault: rung.isPurchaseDefault,
          isIssueDefault: rung.isIssueDefault,
          isDispenseDefault: false,
          gtin: rung.gtin ?? null,
        });
        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.item_uoms',
          rowId: id,
          businessKey: rung.uomId,
          dataClass: 'operational',
          before: null,
          after: { uom_id: rung.uomId, factor_to_base: rung.factorToBase },
        });
      }),
    );
    return this.laddersFor([id]).then((m) => m.get(id) ?? []);
  }

  async mapBarcode(id: string, body: MapBarcodeRequest): Promise<ScanResolution> {
    const item = await this.get(id);
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `INSERT INTO inventory.item_barcodes
             (id, hospital_id, item_id, item_uom_id, symbology, value, carries_batch_expiry,
              is_primary, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, now())`,
          [
            newId(),
            ctx.hospitalId,
            id,
            body.itemUomId ?? null,
            body.symbology,
            body.value,
            body.carriesBatchExpiry,
            body.isPrimary,
            ctx.userId,
          ],
        );
        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.item_barcodes',
          rowId: id,
          businessKey: body.value,
          dataClass: 'operational',
          before: null,
          after: { item_code: item.code, value: body.value, symbology: body.symbology },
        });
      }),
    );
    return this.resolveScan(body.value);
  }

  /**
   * `EN-013 §3` — one scan to an item, a pack size and, where the pack carries
   * them, a batch and an expiry.
   *
   * Three sources are tried in order, and the order is the point: a mapped
   * barcode is a decision somebody made, a GTIN on the ladder is a fact about
   * the pack, and a raw item code is a fallback for the label printer's own
   * barcodes. A GS1 payload is parsed first so that the batch and expiry it
   * carries reach the caller — that is what removes the typing step at the
   * counter, and the typing step is where the wrong expiry gets recorded.
   */
  async resolveScan(scanned: string): Promise<ScanResolution> {
    const gs1 = parseGs1(scanned);
    const key = gs1?.gtin ?? scanned.trim();

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const byBarcode = await tx.maybeOne<{ item_id: string; item_uom_id: string | null }>(
        `SELECT item_id, item_uom_id FROM inventory.item_barcodes
          WHERE value = $1 AND active ORDER BY is_primary DESC LIMIT 1`,
        [key],
      );

      const byGtin =
        byBarcode !== undefined
          ? undefined
          : await tx.maybeOne<{ item_id: string; uom_id: string }>(
              `SELECT item_id, uom_id FROM inventory.item_uoms WHERE gtin = $1 AND active LIMIT 1`,
              [key],
            );

      const byCode =
        byBarcode !== undefined || byGtin !== undefined
          ? undefined
          : await tx.maybeOne<{ id: string }>(
              `SELECT id FROM inventory.items WHERE code = $1 AND deleted_at IS NULL`,
              [key],
            );

      const itemId = byBarcode?.item_id ?? byGtin?.item_id ?? byCode?.id;
      if (itemId === undefined) {
        throw new AppError(
          ProblemType.NOT_FOUND,
          'Nothing in the item master answers to that barcode. Map it to an item before scanning it again — an unmapped pack at a counter is a stop, not a guess.',
          { nextAction: 'Map the barcode to its item, then rescan.' },
        );
      }

      const item = await this.uoms.item(tx, itemId);
      const uomId = byBarcode?.item_uom_id ?? byGtin?.uom_id ?? null;

      // A batch named by the scan is looked up rather than created: goods
      // receipt is the only place a batch enters the system, and a counter that
      // could invent one could dispense stock that was never received.
      const batch =
        gs1?.batchNo === undefined
          ? undefined
          : await tx.maybeOne<{ id: string; batch_no: string; expiry_date: string | null; status: string }>(
              `SELECT id, batch_no, expiry_date::text AS expiry_date, status::text AS status
                 FROM inventory.item_batches
                WHERE item_id = $1 AND batch_no = $2
                ORDER BY received_at DESC LIMIT 1`,
              [itemId, gs1.batchNo],
            );

      return {
        itemId: item.id,
        itemCode: item.code,
        itemName: item.name,
        schedule: item.schedule,
        isNarcotic: item.is_narcotic,
        tracking: item.tracking,
        uomId: uomId ?? item.base_uom_id,
        batchId: batch?.id ?? null,
        batchNo: batch?.batch_no ?? gs1?.batchNo ?? null,
        batchStatus: batch?.status ?? null,
        expiryDate: batch?.expiry_date ?? gs1?.expiryDate ?? null,
        serialNo: gs1?.serialNo ?? null,
        source: byBarcode !== undefined ? 'barcode_map' : byGtin !== undefined ? 'gtin' : 'item_code',
      };
    });
  }

  async setStoreParams(itemId: string, storeId: string, body: StoreParamsRequest): Promise<void> {
    const item = await this.get(itemId);
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `INSERT INTO inventory.item_store_params (
             id, hospital_id, item_id, store_id, min_qty, max_qty, reorder_level, reorder_qty,
             safety_stock, par_level, lead_days, bin_location_id, auto_indent, is_stocked,
             abc_class, ved_class, fsn_class, classified_at, created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8,
             $9, $10, $11, $12, $13, $14,
             COALESCE($15::inventory."InvAbcClass", 'unclassified'),
             COALESCE($16::inventory."InvVedClass", 'unclassified'),
             COALESCE($17::inventory."InvFsnClass", 'unclassified'),
             now(), $18, $18, now()
           )
           ON CONFLICT (item_id, store_id) DO UPDATE SET
             min_qty = EXCLUDED.min_qty, max_qty = EXCLUDED.max_qty,
             reorder_level = EXCLUDED.reorder_level, reorder_qty = EXCLUDED.reorder_qty,
             safety_stock = EXCLUDED.safety_stock, par_level = EXCLUDED.par_level,
             lead_days = EXCLUDED.lead_days, bin_location_id = EXCLUDED.bin_location_id,
             auto_indent = EXCLUDED.auto_indent, is_stocked = EXCLUDED.is_stocked,
             abc_class = EXCLUDED.abc_class, ved_class = EXCLUDED.ved_class,
             fsn_class = EXCLUDED.fsn_class, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [
            newId(),
            ctx.hospitalId,
            itemId,
            storeId,
            body.minQty,
            body.maxQty ?? null,
            body.reorderLevel ?? null,
            body.reorderQty ?? null,
            body.safetyStock ?? null,
            body.parLevel ?? null,
            body.leadDays ?? null,
            body.binLocationId ?? null,
            body.autoIndent,
            body.isStocked,
            body.abcClass ?? null,
            body.vedClass ?? null,
            body.fsnClass ?? null,
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.item_store_params',
          rowId: itemId,
          businessKey: `${item.code}@${storeId}`,
          dataClass: 'operational',
          before: null,
          after: { reorder_level: body.reorderLevel ?? null, par_level: body.parLevel ?? null },
        });
      }),
    );
  }

  /**
   * A selling price, dated into force.
   *
   * `phase-04 §Constraints`: "price changes are effective-dated, never
   * retroactive". `inventory.refuse_retroactive_price` refuses a row dated
   * before today, so `effectiveFrom` defaults to the *database's* today rather
   * than Node's — a clock and a time zone between the value and the check is
   * how a seed that works in Bengaluru refuses in CI at 20:00 UTC.
   */
  async addPrice(itemId: string, body: ItemPriceRequest): Promise<void> {
    const item = await this.get(itemId);
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const today = await tx.one<{ d: string }>('SELECT current_date::text AS d');
        const effectiveFrom = body.effectiveFrom ?? today.d;
        const id = newId();

        await tx.query(
          `INSERT INTO inventory.item_prices
             (id, hospital_id, branch_id, item_id, price_kind, unit_price, max_discount_pct,
              effective_from, approved_by, approved_at, reason, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, now(), $10, $9, $9, now())`,
          [
            id,
            ctx.hospitalId,
            body.branchId ?? ctx.branchId,
            itemId,
            body.priceKind,
            body.unitPrice,
            body.maxDiscountPct,
            effectiveFrom,
            ctx.userId,
            body.reason ?? null,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.item_prices',
          rowId: id,
          businessKey: item.code,
          dataClass: 'financial',
          before: null,
          after: { price_kind: body.priceKind, unit_price: body.unitPrice, effective_from: effectiveFrom },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('inventory.item.price_scheduled', itemId, {
            itemId,
            priceKind: body.priceKind,
            unitPrice: moneyString(body.unitPrice),
            currency: 'INR',
            effectiveFrom,
            branchId: body.branchId ?? ctx.branchId,
            approvedBy: ctx.userId,
          }),
        );
      }),
    );
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<ItemView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<ItemRow>(
        `SELECT ${ITEM_COLUMNS} FROM inventory.items i WHERE i.id = $1 AND i.deleted_at IS NULL`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The item');
      const ladders = await this.ladderRows(tx, [id]);
      return toItemView(row, ladders.get(id) ?? []);
    });
  }

  async list(query: ItemQuery): Promise<Page<ItemView>> {
    const hospital = hospitalId();
    const resource = 'inventory.items';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = ['i.deleted_at IS NULL'];

      if (query.itemType !== undefined) {
        clauses.push(`i.item_type = ${bind(query.itemType)}::inventory."InvItemType"`);
      }
      if (query.categoryId !== undefined) clauses.push(`i.category_id = ${bind(query.categoryId)}::uuid`);
      if (query.schedule !== undefined) {
        clauses.push(`i.schedule = ${bind(query.schedule)}::mdm."MdmDrugSchedule"`);
      }
      if (query.status !== undefined) {
        clauses.push(`i.status = ${bind(query.status)}::inventory."InvMasterStatus"`);
      }
      if (query.narcoticOnly === true) clauses.push(`i.is_narcotic`);
      if (query.q !== undefined && query.q.length > 0) {
        // `pg_trgm` on name and generic name, plus an exact code hit: the
        // pharmacist types three letters of a brand, and the person doing a
        // stock take types the code.
        const q = bind(query.q);
        clauses.push(
          `(i.code = ${q} OR i.name ILIKE ${bind(`%${query.q}%`)} OR i.generic_name ILIKE ${bind(`%${query.q}%`)})`,
        );
      }
      if (after !== null) {
        clauses.push(`(i.name, i.id) > (${bind(after.k[0])}::varchar, ${bind(after.id)}::uuid)`);
      }

      const rows = await tx.rows<ItemRow & { cursor_key: string }>(
        `SELECT ${ITEM_COLUMNS}, i.name AS cursor_key
           FROM inventory.items i
          WHERE ${clauses.join(' AND ')}
          ORDER BY i.name ASC, i.id ASC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<ItemRow>(rows, limit, {
        hospitalId: hospital,
        resource,
        direction: 'asc',
      });
      const ladders = await this.ladderRows(
        tx,
        page.items.map((i) => i.id),
      );

      return {
        items: page.items.map((row) => toItemView(row, ladders.get(row.id) ?? [])),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  async substitutes(itemId: string): Promise<{
    readonly items: readonly {
      readonly itemId: string;
      readonly code: string;
      readonly name: string;
      readonly kind: string;
      readonly isPreferred: boolean;
      readonly requiresPrescriberApproval: boolean;
      readonly equivalenceFactor: string;
    }[];
  }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await tx.rows<{
        substitute_item_id: string;
        code: string;
        name: string;
        kind: string;
        is_preferred: boolean;
        requires_prescriber_approval: boolean;
        equivalence_factor: string;
      }>(
        `SELECT s.substitute_item_id, i.code, i.name, s.kind, s.is_preferred,
                s.requires_prescriber_approval, s.equivalence_factor::text AS equivalence_factor
           FROM inventory.item_substitutes s
           JOIN inventory.items i ON i.id = s.substitute_item_id AND i.deleted_at IS NULL
          WHERE s.item_id = $1 AND s.active
          ORDER BY s.is_preferred DESC, i.name`,
        [itemId],
      );
      return {
        items: rows.map((r) => ({
          itemId: r.substitute_item_id,
          code: r.code,
          name: r.name,
          kind: r.kind,
          isPreferred: r.is_preferred,
          requiresPrescriberApproval: r.requires_prescriber_approval,
          equivalenceFactor: r.equivalence_factor,
        })),
      };
    });
  }

  async laddersFor(itemIds: readonly string[]): Promise<Map<string, ItemUomView[]>> {
    return this.db.withTenant(currentTenantContext(), (tx) => this.ladderRows(tx, itemIds));
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async insertRung(
    tx: TransactionClient,
    itemId: string,
    rung: {
      readonly uomId: string;
      readonly factorToBase: number;
      readonly packLevel: string;
      readonly isBase: boolean;
      readonly isPurchaseDefault: boolean;
      readonly isIssueDefault: boolean;
      readonly isDispenseDefault: boolean;
      readonly gtin: string | null;
    },
  ): Promise<void> {
    const ctx = getContext();
    await tx.query(
      `INSERT INTO inventory.item_uoms
         (id, hospital_id, item_id, uom_id, pack_level, factor_to_base, is_base,
          is_purchase_default, is_issue_default, is_dispense_default, gtin,
          created_by, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5::mdm."MdmPackLevel", $6, $7, $8, $9, $10, $11, $12, $12, now())`,
      [
        newId(),
        ctx.hospitalId,
        itemId,
        rung.uomId,
        rung.packLevel,
        rung.factorToBase,
        rung.isBase,
        rung.isPurchaseDefault,
        rung.isIssueDefault,
        rung.isDispenseDefault,
        rung.gtin,
        ctx.userId,
      ],
    );
  }

  private async ladderRows(
    tx: TransactionClient,
    itemIds: readonly string[],
  ): Promise<Map<string, ItemUomView[]>> {
    const map = new Map<string, ItemUomView[]>();
    if (itemIds.length === 0) return map;
    const rows = await tx.rows<{
      item_id: string;
      uom_id: string;
      code: string;
      name: string;
      pack_level: string;
      factor_to_base: string;
      is_base: boolean;
      gtin: string | null;
    }>(
      `SELECT iu.item_id, iu.uom_id, u.code, u.name, iu.pack_level::text AS pack_level,
              iu.factor_to_base::text AS factor_to_base, iu.is_base, iu.gtin
         FROM inventory.item_uoms iu
         JOIN mdm.mdm_uoms u ON u.id = iu.uom_id
        WHERE iu.item_id = ANY($1::uuid[]) AND iu.active
        ORDER BY iu.factor_to_base ASC`,
      [[...itemIds]],
    );
    for (const row of rows) {
      const list = map.get(row.item_id) ?? [];
      list.push({
        uomId: row.uom_id,
        code: row.code,
        name: row.name,
        packLevel: row.pack_level,
        factorToBase: row.factor_to_base,
        isBase: row.is_base,
        gtin: row.gtin,
      });
      map.set(row.item_id, list);
    }
    return map;
  }
}

const ITEM_COLUMNS = `i.id, i.code, i.name, i.short_name, i.generic_name, i.drug_key, i.category_id,
        i.item_type::text AS item_type, i.manufacturer_id, i.base_uom_id, i.purchase_uom_id,
        i.issue_uom_id, i.dispense_uom_id, i.hsn_code, i.schedule::text AS schedule,
        i.is_narcotic, i.is_high_alert, i.is_lasa, i.dpco_scheduled,
        i.storage_condition::text AS storage_condition, i.tracking::text AS tracking,
        i.min_shelf_life_days, i.shelf_life_days, i.lead_time_days, i.is_consignment_allowed,
        i.is_returnable, i.is_billable, i.abc_class::text AS abc_class, i.ved_class::text AS ved_class,
        i.fsn_class::text AS fsn_class, i.status::text AS status, i.notes`;

function toItemView(row: ItemRow, uoms: readonly ItemUomView[]): ItemView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    shortName: row.short_name,
    genericName: row.generic_name,
    drugKey: row.drug_key,
    categoryId: row.category_id,
    itemType: row.item_type,
    manufacturerId: row.manufacturer_id,
    baseUomId: row.base_uom_id,
    purchaseUomId: row.purchase_uom_id,
    issueUomId: row.issue_uom_id,
    dispenseUomId: row.dispense_uom_id,
    hsnCode: row.hsn_code,
    schedule: row.schedule,
    isNarcotic: row.is_narcotic,
    isHighAlert: row.is_high_alert,
    isLasa: row.is_lasa,
    dpcoScheduled: row.dpco_scheduled,
    storageCondition: row.storage_condition,
    tracking: row.tracking,
    minShelfLifeDays: row.min_shelf_life_days,
    shelfLifeDays: row.shelf_life_days,
    leadTimeDays: row.lead_time_days,
    isConsignmentAllowed: row.is_consignment_allowed,
    isReturnable: row.is_returnable,
    isBillable: row.is_billable,
    abcClass: row.abc_class,
    vedClass: row.ved_class,
    fsnClass: row.fsn_class,
    status: row.status,
    notes: row.notes,
    uoms,
  };
}

/**
 * A GS1 element string, as a medicine pack carries it.
 *
 * Handles the four application identifiers that matter at a hospital counter:
 * `01` GTIN (14, fixed), `17` expiry `YYMMDD` (fixed), `10` batch (variable,
 * up to 20) and `21` serial (variable, up to 20). Variable-length fields end at
 * the GS1 group separator (ASCII 29) or at the end of the string.
 *
 * `YYMMDD` with `DD = 00` means "end of that month", which is what a foil often
 * prints; it is resolved to the last day, because the alternative — treating it
 * as day zero — makes a pack expire a month early and quietly loses stock.
 *
 * Returns `null` for anything that is not a GS1 payload, so a plain item code
 * still scans.
 */
export function parseGs1(
  raw: string,
): { gtin?: string; expiryDate?: string; batchNo?: string; serialNo?: string } | null {
  const text = raw.replace(/^\]d2/i, '').replace(/^\]C1/i, '');
  if (!text.startsWith('01') || text.length < 16) return null;

  const out: { gtin?: string; expiryDate?: string; batchNo?: string; serialNo?: string } = {};
  let i = 0;
  const SEPARATOR = String.fromCharCode(29);

  while (i < text.length) {
    const ai = text.slice(i, i + 2);
    i += 2;
    if (ai === '01') {
      out.gtin = text.slice(i, i + 14);
      i += 14;
    } else if (ai === '17' || ai === '11' || ai === '15') {
      const value = text.slice(i, i + 6);
      i += 6;
      if (ai === '17') {
        const parsed = gs1Date(value);
        if (parsed !== null) out.expiryDate = parsed;
      }
    } else if (ai === '10' || ai === '21') {
      const end = text.indexOf(SEPARATOR, i);
      const value = end === -1 ? text.slice(i) : text.slice(i, end);
      i = end === -1 ? text.length : end + 1;
      if (ai === '10') out.batchNo = value;
      else out.serialNo = value;
    } else {
      // An identifier this parser does not know: stop rather than guess a
      // length. Everything read so far is still returned, and a partial scan
      // that names the item is more useful than none.
      break;
    }
  }

  return out.gtin === undefined ? null : out;
}

function gs1Date(yymmdd: string): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const year = 2000 + Number(yymmdd.slice(0, 2));
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  if (month < 1 || month > 12) return null;
  const resolved = day === 0 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : day;
  return `${year}-${String(month).padStart(2, '0')}-${String(resolved).padStart(2, '0')}`;
}
