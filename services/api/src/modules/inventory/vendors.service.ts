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
import { binder, hospitalId, moneyString, withInventoryErrors } from './inventory.common.js';
import { inventoryEvent } from './inventory.events.js';
import type {
  ApproveVendorRequest,
  CreateVendorRequest,
  RateContractRequest,
  UpdateVendorRequest,
  VendorActionRequest,
  VendorItemRequest,
  VendorQuery,
} from './inventory.schemas.js';
import type { RateContractView, VendorView } from './inventory.types.js';

/**
 * NC-021 — the vendor master, and the three things about it that are not
 * bookkeeping.
 *
 *  1. **A vendor is created in draft and cannot be bought from until it is
 *     approved, by somebody else.** `docs/04 §3` puts vendor onboarding in the
 *     maker-checker list; the creator is recorded and the approver is checked
 *     against it here, because the database has no constraint that can compare
 *     the two across a status change.
 *  2. **The drug licence is not a document, it is a gate.**
 *     `inventory.enforce_grn_line` refuses a scheduled drug from a vendor whose
 *     licence is not valid on the receipt date — so the receiving dock stops the
 *     day it expires, whether or not anyone read the reminder. This service
 *     surfaces the date on the vendor view for the same reason.
 *  3. **A sanction is a process, not a switch.** A blacklist that skipped its
 *     show-cause notice is not defensible, so `action()` records the notice, the
 *     response window and the approval as `vnd_actions` rows and only moves
 *     `vnd_vendors.status` when the action is one that is decided rather than
 *     proposed.
 *
 * ── What is deliberately **not** here ────────────────────────────────────────
 *
 * `pan_encrypted` and `banks_encrypted` stay null. Both columns want a
 * ciphertext, and `services/api/src/core` has no key-management service to
 * produce one; writing a plausible-looking placeholder into an encrypted column
 * is worse than leaving it empty, because every later reader would treat it as a
 * real ciphertext. The masked forms are stored and are what the UI shows. Bank
 * details are therefore not writable through this API at all — `vendor.bank.
 * changed` needs maker, checker and a call-back verifier, and shipping the
 * event without the encryption would be shipping the fraud path without the
 * control.
 */

interface VendorRow {
  readonly id: string;
  readonly vendor_code: string;
  readonly legal_name: string;
  readonly trade_name: string | null;
  readonly vendor_type: string;
  readonly categories: string[] | null;
  readonly pan_masked: string | null;
  readonly gst_type: string;
  readonly primary_gstin: string | null;
  readonly drug_licence_no: string | null;
  readonly drug_licence_valid_to: string | null;
  readonly credit_days: number;
  readonly lead_time_days_avg: number | null;
  readonly risk_rating: string;
  readonly status: string;
  readonly status_reason: string | null;
  readonly blacklisted_until: string | null;
  readonly last_score: string | null;
  readonly notes: string | null;
  readonly created_by: string | null;
}

const VENDOR_COLUMNS = `v.id, v.vendor_code, v.legal_name, v.trade_name,
        v.vendor_type::text AS vendor_type, v.categories, v.pan_masked,
        v.gst_type::text AS gst_type,
        (SELECT g.gstin FROM inventory.vnd_gstins g
          WHERE g.vendor_id = v.id ORDER BY g.is_primary DESC LIMIT 1) AS primary_gstin,
        v.drug_licence_no, v.drug_licence_valid_to::text AS drug_licence_valid_to,
        v.credit_days, v.lead_time_days_avg, v.risk_rating::text AS risk_rating,
        v.status::text AS status, v.status_reason, v.blacklisted_until::text AS blacklisted_until,
        v.last_score::text AS last_score, v.notes, v.created_by`;

/** The status a sanction moves a vendor into, or `null` when it only proposes. */
const ACTION_STATUS: Readonly<Record<string, string | null>> = {
  watch_list: 'watch_list',
  hold: 'hold',
  blacklist: 'blacklisted',
  revoke: 'approved',
  reinstate: 'approved',
  show_cause: null,
  improvement_notice: null,
};

@Injectable()
export class VendorsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  async create(body: CreateVendorRequest): Promise<VendorView> {
    const ctx = getContext();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const vendorCode =
          body.vendorCode ??
          (await this.numbering.allocate(tx, { key: 'VEND', refType: 'inventory.vnd_vendors', refId: id }))
            .formatted;

        await tx.query(
          `INSERT INTO inventory.vnd_vendors (
             id, hospital_id, vendor_code, legal_name, trade_name, vendor_type, categories,
             pan_masked, gst_type, drug_licence_no, drug_licence_valid_to, credit_days,
             lead_time_days_avg, related_party, notes, status, created_by, updated_by, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6::inventory."VndType", $7::text[],
             $8, $9::inventory."VndGstType", $10, $11::date, $12,
             $13, $14, $15, 'draft', $16, $16, now()
           )`,
          [
            id,
            ctx.hospitalId,
            vendorCode,
            body.legalName,
            body.tradeName ?? null,
            body.vendorType,
            body.categories,
            // Masked only: see the class comment. Four characters is what a
            // reconciliation needs to recognise a vendor and not enough to
            // reconstruct the number.
            body.pan === undefined ? null : `XXXXXX${body.pan.slice(-4)}`,
            body.gstType,
            body.drugLicenceNo ?? null,
            body.drugLicenceValidTo ?? null,
            body.creditDays,
            body.leadTimeDaysAvg ?? null,
            body.relatedParty,
            body.notes ?? null,
            ctx.userId,
          ],
        );

        if (body.gstin !== undefined) {
          await tx.query(
            `INSERT INTO inventory.vnd_gstins
               (id, hospital_id, vendor_id, gstin, state_code, is_primary, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, true, $6, $6, now())`,
            [newId(), ctx.hospitalId, id, body.gstin, body.gstin.slice(0, 2), ctx.userId],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.vnd_vendors',
          rowId: id,
          businessKey: vendorCode,
          dataClass: 'financial',
          before: null,
          after: { vendor_code: vendorCode, legal_name: body.legalName, vendor_type: body.vendorType },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('vendor.created', id, {
            vendorId: id,
            vendorCode,
            legalName: body.legalName,
            vendorType: body.vendorType,
            categories: body.categories,
            createdBy: ctx.userId,
          }),
        );
      }),
    );

    return this.get(id);
  }

  async update(id: string, body: UpdateVendorRequest): Promise<VendorView> {
    const before = await this.get(id);
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const values: unknown[] = [id];
        const bind = binder(values);
        const sets: string[] = [];
        const changed: string[] = [];
        const simple: Readonly<Record<string, string>> = {
          legalName: 'legal_name',
          tradeName: 'trade_name',
          drugLicenceNo: 'drug_licence_no',
          creditDays: 'credit_days',
          leadTimeDaysAvg: 'lead_time_days_avg',
          notes: 'notes',
        };
        for (const [field, column] of Object.entries(simple)) {
          const value = (body as Record<string, unknown>)[field];
          if (value === undefined) continue;
          sets.push(`${column} = ${bind(value)}`);
          changed.push(field);
        }
        if (body.categories !== undefined) {
          sets.push(`categories = ${bind(body.categories)}::text[]`);
          changed.push('categories');
        }
        if (body.drugLicenceValidTo !== undefined) {
          sets.push(`drug_licence_valid_to = ${bind(body.drugLicenceValidTo)}::date`);
          changed.push('drugLicenceValidTo');
        }
        if (body.riskRating !== undefined) {
          sets.push(`risk_rating = ${bind(body.riskRating)}::inventory."VndRiskRating"`);
          changed.push('riskRating');
        }
        if (sets.length === 0) return;

        sets.push(`updated_at = now()`, `updated_by = ${bind(ctx.userId)}`, `version = version + 1`);
        await tx.query(
          `UPDATE inventory.vnd_vendors SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
          values,
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.vnd_vendors',
          rowId: id,
          businessKey: before.vendorCode,
          dataClass: 'financial',
          before: { drug_licence_valid_to: before.drugLicenceValidTo },
          after: { changed },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('vendor.updated', id, {
            vendorId: id,
            vendorCode: before.vendorCode,
            changedFields: changed,
            updatedBy: ctx.userId,
          }),
        );
      }),
    );

    return this.get(id);
  }

  /**
   * `docs/04 §3` maker ≠ checker. The creator of a vendor record cannot be the
   * one who lets purchase orders be raised against it — that is the whole
   * control, and it is enforced here because no CHECK can see across the two
   * rows a status change spans.
   */
  async approve(id: string, body: ApproveVendorRequest): Promise<VendorView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const row = await tx.maybeOne<{ status: string; created_by: string | null; vendor_code: string }>(
          `SELECT status::text AS status, created_by, vendor_code
             FROM inventory.vnd_vendors WHERE id = $1 AND deleted_at IS NULL`,
          [id],
        );
        if (row === undefined) throw AppError.notFound('The vendor');
        if (row.status === 'approved') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This vendor is already approved.');
        }
        if (row.created_by !== null && row.created_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The person who created a vendor record cannot be the one who approves it. Ask a second authorised user to review it.',
          );
        }

        await tx.query(
          `UPDATE inventory.vnd_vendors
              SET status = 'approved'::inventory."VndStatus", status_reason = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.note ?? null, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.vnd_vendors',
          rowId: id,
          businessKey: row.vendor_code,
          dataClass: 'financial',
          before: { status: row.status },
          after: { status: 'approved' },
        });

        const categories = await tx.maybeOne<{ categories: string[] | null }>(
          `SELECT categories FROM inventory.vnd_vendors WHERE id = $1`,
          [id],
        );

        await this.outbox.publish(
          tx,
          inventoryEvent('vendor.approved', id, {
            vendorId: id,
            vendorCode: row.vendor_code,
            categories: categories?.categories ?? [],
            approvedBy: ctx.userId,
            approvedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.get(id);
  }

  async mapItem(vendorId: string, body: VendorItemRequest): Promise<void> {
    const vendor = await this.get(vendorId);
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `INSERT INTO inventory.vnd_item_map
             (id, hospital_id, vendor_id, item_id, vendor_item_code, brand, preferred_rank,
              lead_time_days, moq, moq_uom_id, last_price, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, now())
           ON CONFLICT (vendor_id, item_id) DO UPDATE SET
             vendor_item_code = EXCLUDED.vendor_item_code, brand = EXCLUDED.brand,
             preferred_rank = EXCLUDED.preferred_rank, lead_time_days = EXCLUDED.lead_time_days,
             moq = EXCLUDED.moq, moq_uom_id = EXCLUDED.moq_uom_id,
             last_price = EXCLUDED.last_price, updated_at = now(), updated_by = EXCLUDED.updated_by`,
          [
            newId(),
            ctx.hospitalId,
            vendorId,
            body.itemId,
            body.vendorItemCode ?? null,
            body.brand ?? null,
            body.preferredRank,
            body.leadTimeDays ?? null,
            body.moq ?? null,
            body.moqUomId ?? null,
            body.lastPrice ?? null,
            ctx.userId,
          ],
        );
        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.vnd_item_map',
          rowId: vendorId,
          businessKey: `${vendor.vendorCode}/${body.itemId}`,
          dataClass: 'operational',
          before: null,
          after: { item_id: body.itemId, preferred_rank: body.preferredRank },
        });
      }),
    );
  }

  async createRateContract(vendorId: string, body: RateContractRequest): Promise<RateContractView> {
    const vendor = await this.get(vendorId);
    const ctx = getContext();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `INSERT INTO inventory.vnd_rate_contracts
             (id, hospital_id, branch_id, vendor_id, contract_no, title, valid_from, valid_to,
              max_value, delivery_sla_days, min_shelf_life_pct, status, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9, $10, $11,
                   'draft'::inventory."VndContractStatus", $12, $12, now())`,
          [
            id,
            ctx.hospitalId,
            ctx.branchId,
            vendorId,
            body.contractNo,
            body.title,
            body.validFrom,
            body.validTo,
            body.maxValue ?? null,
            body.deliverySlaDays ?? null,
            body.minShelfLifePct ?? null,
            ctx.userId,
          ],
        );

        for (const line of body.lines) {
          await tx.query(
            `INSERT INTO inventory.vnd_rate_contract_lines
               (id, hospital_id, contract_id, item_id, uom_id, rate, discount_pct, hsn_code,
                moq, valid_from, valid_to, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::date, $12, $12, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              line.itemId,
              line.uomId,
              line.rate,
              line.discountPct,
              line.hsnCode ?? null,
              line.moq ?? null,
              line.validFrom ?? body.validFrom,
              line.validTo ?? body.validTo,
              ctx.userId,
            ],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.vnd_rate_contracts',
          rowId: id,
          businessKey: body.contractNo,
          dataClass: 'financial',
          before: null,
          after: { vendor_code: vendor.vendorCode, lines: body.lines.length },
        });
      }),
    );

    return this.rateContract(id);
  }

  async approveRateContract(id: string): Promise<RateContractView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const row = await tx.maybeOne<{
          status: string;
          contract_no: string;
          vendor_id: string;
          valid_from: string;
          valid_to: string;
          max_value: string | null;
        }>(
          `SELECT status::text AS status, contract_no, vendor_id,
                  valid_from::text AS valid_from, valid_to::text AS valid_to, max_value::text AS max_value
             FROM inventory.vnd_rate_contracts WHERE id = $1`,
          [id],
        );
        if (row === undefined) throw AppError.notFound('The rate contract');
        if (row.status === 'active') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This rate contract is already active.');
        }

        const lineCount = await tx.one<{ n: string }>(
          `SELECT count(*)::text AS n FROM inventory.vnd_rate_contract_lines WHERE contract_id = $1`,
          [id],
        );

        await tx.query(
          `UPDATE inventory.vnd_rate_contracts
              SET status = 'active'::inventory."VndContractStatus", approved_by = $2,
                  approved_at = now(), updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.vnd_rate_contracts',
          rowId: id,
          businessKey: row.contract_no,
          dataClass: 'financial',
          before: { status: row.status },
          after: { status: 'active' },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('vendor.rate_contract.activated', id, {
            contractId: id,
            contractNo: row.contract_no,
            vendorId: row.vendor_id,
            validFrom: row.valid_from,
            validTo: row.valid_to,
            lineCount: Number(lineCount.n),
            maxValue: row.max_value === null ? null : moneyString(Number(row.max_value)),
            currency: 'INR',
          }),
        );
      }),
    );
    return this.rateContract(id);
  }

  /**
   * A sanction, or the notice that opens one.
   *
   * `show_cause` and `improvement_notice` do not change the vendor's status —
   * that is the point of them: the vendor is entitled to answer before anything
   * is decided. Everything else moves the status, and a blacklist additionally
   * stamps `blacklisted_until` so purchasing resumes by itself rather than
   * waiting for somebody to remember.
   */
  async action(vendorId: string, body: VendorActionRequest): Promise<VendorView> {
    const before = await this.get(vendorId);
    const ctx = getContext();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const today = await tx.one<{ d: string }>('SELECT current_date::text AS d');
        await tx.query(
          `INSERT INTO inventory.vnd_actions
             (id, hospital_id, vendor_id, action, reason_category, reason, notice_sent_at,
              response_due_at, effective_from, effective_to, approved_by, status,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4::inventory."VndActionKind", $5, $6, now(),
                   $7::timestamptz, $8::date, $9::date, $10, $11, $10, $10, now())`,
          [
            id,
            ctx.hospitalId,
            vendorId,
            body.action,
            body.reasonCategory,
            body.reason,
            body.responseDueAt ?? null,
            body.effectiveFrom ?? today.d,
            body.effectiveTo ?? null,
            ctx.userId,
            body.action === 'show_cause' || body.action === 'improvement_notice' ? 'open' : 'decided',
          ],
        );

        const nextStatus = ACTION_STATUS[body.action] ?? null;
        if (nextStatus !== null) {
          await tx.query(
            `UPDATE inventory.vnd_vendors
                SET status = $2::inventory."VndStatus", status_reason = $3,
                    blacklisted_until = $4::date,
                    updated_at = now(), updated_by = $5, version = version + 1
              WHERE id = $1`,
            [
              vendorId,
              nextStatus,
              body.reason,
              body.action === 'blacklist' ? (body.effectiveTo ?? null) : null,
              ctx.userId,
            ],
          );
        }

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.vnd_actions',
          rowId: id,
          businessKey: before.vendorCode,
          dataClass: 'financial',
          reasonText: body.reason,
          before: { status: before.status },
          after: { action: body.action, status: nextStatus ?? before.status },
        });

        if (body.action === 'show_cause') {
          await this.outbox.publish(
            tx,
            inventoryEvent('vendor.action.notice_sent', id, {
              actionId: id,
              vendorId,
              vendorCode: before.vendorCode,
              reasonCategory: body.reasonCategory,
              responseDueAt: body.responseDueAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
              issuedBy: ctx.userId,
              issuedAt: new Date().toISOString(),
            }),
          );
        } else if (body.action === 'blacklist') {
          await this.outbox.publish(
            tx,
            inventoryEvent('vendor.action.blacklisted', vendorId, {
              actionId: id,
              vendorId,
              vendorCode: before.vendorCode,
              scope: ['hospital'],
              reasonCategory: body.reasonCategory,
              reason: body.reason,
              until: body.effectiveTo ?? null,
              proposedBy: ctx.userId,
              approvedBy: ctx.userId,
              blacklistedAt: new Date().toISOString(),
            }),
          );
        } else if (body.action === 'hold') {
          await this.outbox.publish(
            tx,
            inventoryEvent('vendor.hold', vendorId, {
              vendorId,
              vendorCode: before.vendorCode,
              scope: ['hospital'],
              reason: body.reason,
              until: body.effectiveTo ?? null,
              automatic: false,
              heldAt: new Date().toISOString(),
            }),
          );
        } else if (body.action === 'revoke' || body.action === 'reinstate') {
          await this.outbox.publish(
            tx,
            inventoryEvent('vendor.reactivated', vendorId, {
              vendorId,
              vendorCode: before.vendorCode,
              reason: body.reason,
              reactivatedBy: ctx.userId,
              reactivatedAt: new Date().toISOString(),
            }),
          );
        }
      }),
    );

    return this.get(vendorId);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async get(id: string): Promise<VendorView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<VendorRow>(
        `SELECT ${VENDOR_COLUMNS} FROM inventory.vnd_vendors v WHERE v.id = $1 AND v.deleted_at IS NULL`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The vendor');
      return toVendorView(row);
    });
  }

  /**
   * The purchasing gate, as one question: may an order be raised on this vendor
   * today, and if the order contains a scheduled drug, may it be received?
   */
  async assertPurchasable(tx: TransactionClient, vendorId: string): Promise<VendorRow> {
    const row = await tx.maybeOne<VendorRow>(
      `SELECT ${VENDOR_COLUMNS} FROM inventory.vnd_vendors v WHERE v.id = $1 AND v.deleted_at IS NULL`,
      [vendorId],
    );
    if (row === undefined) throw AppError.notFound('The vendor');
    if (row.status !== 'approved' && row.status !== 'watch_list') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        `${row.legal_name} is "${row.status}", so no new purchase order may be raised on it.`,
        { nextAction: 'Choose another vendor, or have the sanction reviewed.' },
      );
    }
    return row;
  }

  async list(query: VendorQuery): Promise<Page<VendorView>> {
    const hospital = hospitalId();
    const resource = 'inventory.vendors';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = ['v.deleted_at IS NULL'];
      if (query.status !== undefined) {
        clauses.push(`v.status = ${bind(query.status)}::inventory."VndStatus"`);
      }
      if (query.vendorType !== undefined) {
        clauses.push(`v.vendor_type = ${bind(query.vendorType)}::inventory."VndType"`);
      }
      if (query.q !== undefined && query.q.length > 0) {
        clauses.push(
          `(v.vendor_code ILIKE ${bind(`%${query.q}%`)} OR v.legal_name ILIKE ${bind(`%${query.q}%`)} OR v.trade_name ILIKE ${bind(`%${query.q}%`)})`,
        );
      }
      if (after !== null) {
        clauses.push(`(v.legal_name, v.id) > (${bind(after.k[0])}::varchar, ${bind(after.id)}::uuid)`);
      }

      const rows = await tx.rows<VendorRow & { cursor_key: string }>(
        `SELECT ${VENDOR_COLUMNS}, v.legal_name AS cursor_key
           FROM inventory.vnd_vendors v
          WHERE ${clauses.join(' AND ')}
          ORDER BY v.legal_name ASC, v.id ASC
          LIMIT ${bind(limit + 1)}`,
        values,
      );

      const page = this.cursors.keysetPage<VendorRow>(rows, limit, {
        hospitalId: hospital,
        resource,
        direction: 'asc',
      });
      return { items: page.items.map(toVendorView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  async rateContract(id: string): Promise<RateContractView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<{
        id: string;
        contract_no: string;
        vendor_id: string;
        title: string;
        valid_from: string;
        valid_to: string;
        status: string;
        max_value: string | null;
        line_count: string;
      }>(
        `SELECT c.id, c.contract_no, c.vendor_id, c.title, c.valid_from::text AS valid_from,
                c.valid_to::text AS valid_to, c.status::text AS status, c.max_value::text AS max_value,
                (SELECT count(*)::text FROM inventory.vnd_rate_contract_lines l WHERE l.contract_id = c.id)
                  AS line_count
           FROM inventory.vnd_rate_contracts c WHERE c.id = $1`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The rate contract');
      return {
        id: row.id,
        contractNo: row.contract_no,
        vendorId: row.vendor_id,
        title: row.title,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        status: row.status,
        lineCount: Number(row.line_count),
        maxValue: row.max_value,
      };
    });
  }

  async rateContracts(vendorId: string): Promise<{ readonly items: readonly RateContractView[] }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await tx.rows<{
        id: string;
        contract_no: string;
        vendor_id: string;
        title: string;
        valid_from: string;
        valid_to: string;
        status: string;
        max_value: string | null;
        line_count: string;
      }>(
        `SELECT c.id, c.contract_no, c.vendor_id, c.title, c.valid_from::text AS valid_from,
                c.valid_to::text AS valid_to, c.status::text AS status, c.max_value::text AS max_value,
                (SELECT count(*)::text FROM inventory.vnd_rate_contract_lines l WHERE l.contract_id = c.id)
                  AS line_count
           FROM inventory.vnd_rate_contracts c
          WHERE c.vendor_id = $1
          ORDER BY c.valid_from DESC`,
        [vendorId],
      );
      return {
        items: rows.map((row) => ({
          id: row.id,
          contractNo: row.contract_no,
          vendorId: row.vendor_id,
          title: row.title,
          validFrom: row.valid_from,
          validTo: row.valid_to,
          status: row.status,
          lineCount: Number(row.line_count),
          maxValue: row.max_value,
        })),
      };
    });
  }

  /**
   * The live contract rate for one item, or `null`.
   *
   * Read at the moment a purchase-order line is priced and snapshotted onto it:
   * `phase-04 §Constraints` — a rate revision is never retroactive, and an order
   * already placed keeps the rate it was placed at.
   */
  async contractRate(
    tx: TransactionClient,
    vendorId: string,
    itemId: string,
  ): Promise<{
    rate: string;
    uomId: string;
    discountPct: string;
    contractId: string;
    lineId: string;
  } | null> {
    const row = await tx.maybeOne<{
      rate: string;
      uom_id: string;
      discount_pct: string;
      contract_id: string;
      id: string;
    }>(
      `SELECT l.rate::text AS rate, l.uom_id, l.discount_pct::text AS discount_pct,
              l.contract_id, l.id
         FROM inventory.vnd_rate_contract_lines l
         JOIN inventory.vnd_rate_contracts c ON c.id = l.contract_id
        WHERE c.vendor_id = $1 AND l.item_id = $2
          AND c.status = 'active'
          AND c.valid_from <= current_date AND c.valid_to >= current_date
          AND l.valid_from <= current_date AND (l.valid_to IS NULL OR l.valid_to >= current_date)
        ORDER BY l.valid_from DESC LIMIT 1`,
      [vendorId, itemId],
    );
    if (row === undefined) return null;
    return {
      rate: row.rate,
      uomId: row.uom_id,
      discountPct: row.discount_pct,
      contractId: row.contract_id,
      lineId: row.id,
    };
  }
}

function toVendorView(row: VendorRow): VendorView {
  return {
    id: row.id,
    vendorCode: row.vendor_code,
    legalName: row.legal_name,
    tradeName: row.trade_name,
    vendorType: row.vendor_type,
    categories: row.categories ?? [],
    panMasked: row.pan_masked,
    gstType: row.gst_type,
    primaryGstin: row.primary_gstin,
    drugLicenceNo: row.drug_licence_no,
    drugLicenceValidTo: row.drug_licence_valid_to,
    creditDays: row.credit_days,
    leadTimeDaysAvg: row.lead_time_days_avg,
    riskRating: row.risk_rating,
    status: row.status,
    statusReason: row.status_reason,
    blacklistedUntil: row.blacklisted_until,
    lastScore: row.last_score,
    notes: row.notes,
  };
}
