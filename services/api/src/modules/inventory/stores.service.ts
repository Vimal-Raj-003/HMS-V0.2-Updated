import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../core/audit/audit.service.js';
import { getContext } from '../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../core/db/database.service.js';
import { CursorService } from '../../core/pagination/cursor.service.js';
import { AppError } from '../../core/problem/app-error.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';
import { binder, hospitalId, requireBranch, withInventoryErrors } from './inventory.common.js';
import type {
  CreateLocationRequest,
  CreateStoreRequest,
  StoreQuery,
  UpdateStoreRequest,
} from './inventory.schemas.js';
import type { StoreLocationView, StoreView } from './inventory.types.js';

/**
 * NC-006 §3.2 — the store hierarchy, its bin locations, and the two flags on a
 * store that everything downstream refuses on.
 *
 * `holds_narcotics` is the one that matters most: `enforce_ledger_
 * preconditions()` refuses *any* movement of a controlled drug through a store
 * that does not have it, so the flag is not a label, it is the designation under
 * which the safe legally exists. Turning it off while controlled stock is on the
 * shelf would strand that stock — nothing could issue it, dispense it or even
 * write it off — so this service refuses that, and names the quantity.
 *
 * `negative_stock_policy` is the other: `block` is the default and the only safe
 * setting for a dispensing counter (`phase-04 §Constraints`: "fail closed on
 * stock integrity"). Relaxing it is a configuration decision a hospital may
 * legitimately make for a ward trolley, and it is audited as one.
 */

interface StoreRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly store_type: string;
  readonly branch_id: string;
  readonly parent_store_id: string | null;
  readonly custodian_user_id: string | null;
  readonly cost_centre_id: string | null;
  readonly drug_licence_no: string | null;
  readonly drug_licence_expiry: string | null;
  readonly negative_stock_policy: string;
  readonly valuation_method: string;
  readonly is_consignment: boolean;
  readonly holds_narcotics: boolean;
  readonly is_24x7: boolean;
  readonly active: boolean;
}

const STORE_COLUMNS = `s.id, s.code, s.name, s.store_type::text AS store_type, s.branch_id,
        s.parent_store_id, s.custodian_user_id, s.cost_centre_id, s.drug_licence_no,
        s.drug_licence_expiry::text AS drug_licence_expiry,
        s.negative_stock_policy::text AS negative_stock_policy,
        s.valuation_method::text AS valuation_method, s.is_consignment, s.holds_narcotics,
        s.is_24x7, s.active`;

@Injectable()
export class StoresService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  async create(body: CreateStoreRequest): Promise<StoreView> {
    const ctx = getContext();
    const branchId = requireBranch(body.branchId);
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `INSERT INTO inventory.stores (
             id, hospital_id, branch_id, code, name, store_type, parent_store_id,
             custodian_user_id, cost_centre_id, drug_licence_no, drug_licence_expiry,
             negative_stock_policy, valuation_method, is_consignment, holds_narcotics, is_24x7,
             created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6::inventory."InvStoreType", $7,
             $8, $9, $10, $11::date,
             $12::inventory."InvNegativeStockPolicy", $13::inventory."InvValuationMethod",
             $14, $15, $16, $17, $17, now()
           )`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.code,
            body.name,
            body.storeType,
            body.parentStoreId ?? null,
            body.custodianUserId ?? null,
            body.costCentreId ?? null,
            body.drugLicenceNo ?? null,
            body.drugLicenceExpiry ?? null,
            body.negativeStockPolicy,
            body.valuationMethod,
            body.isConsignment,
            body.holdsNarcotics,
            body.is24x7,
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.stores',
          rowId: id,
          businessKey: body.code,
          dataClass: 'operational',
          before: null,
          after: {
            code: body.code,
            store_type: body.storeType,
            holds_narcotics: body.holdsNarcotics,
            negative_stock_policy: body.negativeStockPolicy,
          },
        });
      }),
    );

    return this.get(id);
  }

  async update(id: string, body: UpdateStoreRequest): Promise<StoreView> {
    const before = await this.get(id);
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        if (body.holdsNarcotics === false && before.holdsNarcotics) {
          const held = await tx.maybeOne<{ qty: string | null }>(
            `SELECT sum(b.qty_on_hand)::text AS qty
               FROM inventory.stock_balances b
               JOIN inventory.items i ON i.id = b.item_id
              WHERE b.store_id = $1 AND b.qty_on_hand > 0
                AND (i.is_narcotic OR i.schedule IN ('ndps_narcotic', 'ndps_psychotropic'))`,
            [id],
          );
          if (Number(held?.qty ?? 0) > 0) {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              `${before.code} still holds ${Number(held?.qty ?? 0)} base units of controlled stock. Removing the narcotic designation would strand it: nothing could issue it, dispense it or write it off. Move or destroy the stock first, under the register.`,
            );
          }
        }

        const values: unknown[] = [id];
        const bind = binder(values);
        const sets: string[] = [];
        const changed: string[] = [];
        const simple: Readonly<Record<string, string>> = {
          name: 'name',
          custodianUserId: 'custodian_user_id',
          costCentreId: 'cost_centre_id',
          drugLicenceNo: 'drug_licence_no',
          holdsNarcotics: 'holds_narcotics',
          is24x7: 'is_24x7',
          active: 'active',
        };
        for (const [field, column] of Object.entries(simple)) {
          const value = (body as Record<string, unknown>)[field];
          if (value === undefined) continue;
          sets.push(`${column} = ${bind(value)}`);
          changed.push(field);
        }
        if (body.drugLicenceExpiry !== undefined) {
          sets.push(`drug_licence_expiry = ${bind(body.drugLicenceExpiry)}::date`);
          changed.push('drugLicenceExpiry');
        }
        if (body.negativeStockPolicy !== undefined) {
          sets.push(
            `negative_stock_policy = ${bind(body.negativeStockPolicy)}::inventory."InvNegativeStockPolicy"`,
          );
          changed.push('negativeStockPolicy');
        }
        if (body.valuationMethod !== undefined) {
          sets.push(`valuation_method = ${bind(body.valuationMethod)}::inventory."InvValuationMethod"`);
          changed.push('valuationMethod');
        }
        if (sets.length === 0) return;

        sets.push(`updated_at = now()`, `updated_by = ${bind(ctx.userId)}`, `version = version + 1`);
        await tx.query(
          `UPDATE inventory.stores SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
          values,
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.stores',
          rowId: id,
          businessKey: before.code,
          dataClass: 'operational',
          before: {
            holds_narcotics: before.holdsNarcotics,
            negative_stock_policy: before.negativeStockPolicy,
          },
          after: { changed },
        });
      }),
    );

    return this.get(id);
  }

  async addLocation(storeId: string, body: CreateLocationRequest): Promise<StoreLocationView> {
    await this.get(storeId);
    const ctx = getContext();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `INSERT INTO inventory.store_locations
             (id, hospital_id, store_id, code, name, path, is_quarantine, is_expired_hold,
              is_controlled_safe, barcode, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, now())`,
          [
            id,
            ctx.hospitalId,
            storeId,
            body.code,
            body.name ?? null,
            body.path,
            body.isQuarantine,
            body.isExpiredHold,
            body.isControlledSafe,
            body.barcode ?? null,
            ctx.userId,
          ],
        );
        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.store_locations',
          rowId: id,
          businessKey: body.code,
          dataClass: 'operational',
          before: null,
          after: { store_id: storeId, code: body.code, path: body.path },
        });
      }),
    );

    const locations = await this.locations(storeId);
    const created = locations.items.find((l) => l.id === id);
    if (created === undefined) throw AppError.notFound('The bin location');
    return created;
  }

  async locations(storeId: string): Promise<{ readonly items: readonly StoreLocationView[] }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await tx.rows<{
        id: string;
        store_id: string;
        code: string;
        name: string | null;
        path: string;
        is_quarantine: boolean;
        is_expired_hold: boolean;
        is_controlled_safe: boolean;
        barcode: string | null;
        active: boolean;
      }>(
        `SELECT id, store_id, code, name, path, is_quarantine, is_expired_hold,
                is_controlled_safe, barcode, active
           FROM inventory.store_locations
          WHERE store_id = $1
          ORDER BY path`,
        [storeId],
      );
      return {
        items: rows.map((r) => ({
          id: r.id,
          storeId: r.store_id,
          code: r.code,
          name: r.name,
          path: r.path,
          isQuarantine: r.is_quarantine,
          isExpiredHold: r.is_expired_hold,
          isControlledSafe: r.is_controlled_safe,
          barcode: r.barcode,
          active: r.active,
        })),
      };
    });
  }

  async get(id: string): Promise<StoreView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => this.load(tx, id));
  }

  /** For services that already hold a transaction and need the store's flags. */
  async load(tx: TransactionClient, id: string): Promise<StoreView> {
    const row = await tx.maybeOne<StoreRow>(
      `SELECT ${STORE_COLUMNS} FROM inventory.stores s WHERE s.id = $1 AND s.deleted_at IS NULL`,
      [id],
    );
    if (row === undefined) throw AppError.notFound('The store');
    return toStoreView(row);
  }

  async list(query: StoreQuery): Promise<Page<StoreView>> {
    const hospital = hospitalId();
    const resource = 'inventory.stores';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = ['s.deleted_at IS NULL'];
      if (query.storeType !== undefined) {
        clauses.push(`s.store_type = ${bind(query.storeType)}::inventory."InvStoreType"`);
      }
      if (query.parentStoreId !== undefined) {
        clauses.push(`s.parent_store_id = ${bind(query.parentStoreId)}::uuid`);
      }
      if (query.q !== undefined && query.q.length > 0) {
        clauses.push(`(s.code ILIKE ${bind(`%${query.q}%`)} OR s.name ILIKE ${bind(`%${query.q}%`)})`);
      }
      if (after !== null) {
        clauses.push(`(s.code, s.id) > (${bind(after.k[0])}::varchar, ${bind(after.id)}::uuid)`);
      }

      const rows = await tx.rows<StoreRow & { cursor_key: string }>(
        `SELECT ${STORE_COLUMNS}, s.code AS cursor_key
           FROM inventory.stores s
          WHERE ${clauses.join(' AND ')}
          ORDER BY s.code ASC, s.id ASC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<StoreRow>(rows, limit, {
        hospitalId: hospital,
        resource,
        direction: 'asc',
      });
      return { items: page.items.map(toStoreView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }
}

function toStoreView(row: StoreRow): StoreView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    storeType: row.store_type,
    branchId: row.branch_id,
    parentStoreId: row.parent_store_id,
    custodianUserId: row.custodian_user_id,
    costCentreId: row.cost_centre_id,
    drugLicenceNo: row.drug_licence_no,
    drugLicenceExpiry: row.drug_licence_expiry,
    negativeStockPolicy: row.negative_stock_policy,
    valuationMethod: row.valuation_method,
    isConsignment: row.is_consignment,
    holdsNarcotics: row.holds_narcotics,
    is24x7: row.is_24x7,
    active: row.active,
  };
}
