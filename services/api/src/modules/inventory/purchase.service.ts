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
  AmendPoRequest,
  ApproveComparativeRequest,
  ApprovePoRequest,
  ApproveIndentRequest,
  ClosePoRequest,
  CreatePoRequest,
  CreatePurchaseIndentRequest,
  CreateRfqRequest,
  EmergencyPurchaseRequest,
  EnterQuotationRequest,
  PoQuery,
  PurchaseIndentQuery,
  RejectRequest,
  RfqQuery,
  SendPoRequest,
} from './inventory.schemas.js';
import type { ComparativeView, DocumentLineView, DocumentView } from './inventory.types.js';
import { UomService } from './uom.service.js';
import { VendorsService } from './vendors.service.js';

/**
 * NC-005 — indent → RFQ → quotation → comparative → purchase order, and the
 * approval and versioning rules that make each step mean something.
 *
 * ── Three rules, and why each is here rather than in a screen ────────────────
 *
 * **A purchase order is versioned and the superseded version is frozen.** The
 * vendor holds a copy of what they were sent, so an amendment cannot be an
 * `UPDATE`: `inventory.refuse_superseded_po_edit` refuses one, and `amend()`
 * writes a new row with `po_version + 1`, flips `is_current`, and records a
 * `pur_po_amendments` row with the reason. `uq_pur_po_one_current` guarantees
 * exactly one live version per PO number.
 *
 * **Not taking the lowest quote is a decision that has to be written down.**
 * `pur_quotation_lines_l2_justified` refuses a selected line that is neither L1
 * nor justified. The comparative is computed here — landed cost per base unit,
 * so quotes in different pack sizes are actually comparable — and L1 is derived
 * from that rather than from the headline rate, because a cheaper rate on a
 * bigger pack is not a cheaper price.
 *
 * **A rate contract prices the line at the moment the order is placed, and the
 * rate is snapshotted onto it.** `phase-04 §Constraints`: a rate revision is
 * never retroactive.
 *
 * ── The budget hook ─────────────────────────────────────────────────────────
 *
 * `budget_line_ref` is carried through indent and order and is *not* checked
 * against anything: NC-022 is Phase 9. The column travels so that when the
 * budget module arrives it has the reference it needs on every historic order —
 * which is the difference between switching the check on and backfilling a
 * year of purchasing.
 */
@Injectable()
export class PurchaseService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(UomService) private readonly uoms: UomService,
    @Inject(VendorsService) private readonly vendors: VendorsService,
  ) {}

  // ── purchase indents ─────────────────────────────────────────────────────

  async createIndent(body: CreatePurchaseIndentRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const indentNo = (
          await this.numbering.allocate(tx, {
            key: 'IND',
            branchId,
            refType: 'inventory.pur_indents',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.pur_indents
             (id, hospital_id, branch_id, indent_no, store_id, cost_centre_id, urgency, required_by,
              justification, status, source, requested_by, submitted_at,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::inventory."PurUrgency", $8::date, $9,
                   'submitted'::inventory."PurIndentStatus", $10::inventory."PurIndentSource",
                   $11, now(), $11, $11, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            indentNo,
            body.storeId,
            body.costCentreId ?? null,
            body.urgency,
            body.requiredBy ?? null,
            body.justification ?? null,
            body.source,
            ctx.userId,
          ],
        );

        let lineNo = 1;
        let estimated = 0;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          const onHand = await tx.maybeOne<{ qty: string | null }>(
            `SELECT sum(qty_on_hand)::text AS qty FROM inventory.stock_balances
              WHERE store_id = $1 AND item_id = $2`,
            [body.storeId, line.itemId],
          );

          await tx.query(
            `INSERT INTO inventory.pur_indent_lines
               (id, hospital_id, indent_id, line_no, item_id, uom_id, qty_entered, qty_base,
                stock_on_hand_snapshot, last_price, specs, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10::numeric,
                     $11, $12, $12, now())`,
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
              line.lastPrice ?? null,
              line.specs ?? null,
              ctx.userId,
            ],
          );
          estimated += (line.lastPrice ?? 0) * Number(converted.qtyEntered);
          lineNo += 1;
        }

        await tx.query(`UPDATE inventory.pur_indents SET estimated_value = $2::numeric WHERE id = $1`, [
          id,
          estimated.toFixed(2),
        ]);

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.pur_indents',
          rowId: id,
          businessKey: indentNo,
          dataClass: 'financial',
          before: null,
          after: { store_id: body.storeId, urgency: body.urgency, lines: body.lines.length },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.indent.submitted', id, {
            indentId: id,
            indentNo,
            departmentKey: null,
            storeId: body.storeId,
            urgency: body.urgency,
            source: body.source,
            lineCount: body.lines.length,
            estimatedValue: moneyString(estimated),
            currency: 'INR',
            submittedBy: ctx.userId,
            submittedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.indent(id);
  }

  async approveIndent(id: string, body: ApproveIndentRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{
          status: string;
          indent_no: string;
          requested_by: string | null;
          estimated_value: string | null;
        }>(
          `SELECT status::text AS status, indent_no, requested_by, estimated_value::text AS estimated_value
             FROM inventory.pur_indents WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The purchase indent');
        assertStatus('This indent', header.status, ['submitted', 'pending_approval'], 'approved');
        if (header.requested_by !== null && header.requested_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The person who raised a purchase indent cannot be the one who approves it.',
          );
        }

        await tx.query(
          `UPDATE inventory.pur_indent_lines
              SET qty_approved_base = qty_base, status = 'approved', updated_at = now(), updated_by = $2
            WHERE indent_id = $1`,
          [id, ctx.userId],
        );

        let partial = false;
        for (const line of body.lines) {
          const row = await tx.maybeOne<{ item_id: string; qty_base: string }>(
            `SELECT item_id, qty_base::text AS qty_base FROM inventory.pur_indent_lines
              WHERE id = $1 AND indent_id = $2`,
            [line.lineId, id],
          );
          if (row === undefined) throw AppError.notFound('The indent line');
          const item = await this.uoms.item(tx, row.item_id);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyApprovedEntered);
          if (Number(converted.qtyBase) < Number(row.qty_base)) partial = true;
          await tx.query(
            `UPDATE inventory.pur_indent_lines
                SET qty_approved_base = $2::numeric,
                    status = CASE WHEN $2::numeric = 0 THEN 'rejected' ELSE 'approved' END,
                    updated_at = now(), updated_by = $3
              WHERE id = $1`,
            [line.lineId, converted.qtyBase, ctx.userId],
          );
        }

        await tx.query(
          `UPDATE inventory.pur_indents
              SET status = $2::inventory."PurIndentStatus", approved_by = $3, approved_at = now(),
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, partial ? 'partially_approved' : 'approved', ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.pur_indents',
          rowId: id,
          businessKey: header.indent_no,
          dataClass: 'financial',
          reasonText: body.note ?? null,
          before: { status: header.status },
          after: { status: partial ? 'partially_approved' : 'approved' },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.indent.approved', id, {
            indentId: id,
            indentNo: header.indent_no,
            approvedValue:
              header.estimated_value === null ? null : moneyString(Number(header.estimated_value)),
            currency: 'INR',
            partial,
            approvedBy: ctx.userId,
            approvedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.indent(id);
  }

  async rejectIndent(id: string, body: RejectRequest): Promise<DocumentView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{ status: string; indent_no: string }>(
          `SELECT status::text AS status, indent_no FROM inventory.pur_indents WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The purchase indent');
        assertStatus('This indent', header.status, ['submitted', 'pending_approval'], 'rejected');

        await tx.query(
          `UPDATE inventory.pur_indents
              SET status = 'rejected'::inventory."PurIndentStatus", rejected_reason = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.reason, ctx.userId],
        );
        await this.audit.write(tx, {
          action: 'reject',
          entity: 'inventory.pur_indents',
          rowId: id,
          businessKey: header.indent_no,
          dataClass: 'financial',
          reasonText: body.reason,
          before: { status: header.status },
          after: { status: 'rejected' },
        });
        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.indent.rejected', id, {
            indentId: id,
            indentNo: header.indent_no,
            reason: body.reason,
            rejectedBy: ctx.userId,
            rejectedAt: new Date().toISOString(),
          }),
        );
      }),
    );
    return this.indent(id);
  }

  // ── RFQ and quotations ───────────────────────────────────────────────────

  async createRfq(body: CreateRfqRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const settings = await this.settings(tx);
        if (body.vendorIds.length < settings.minVendors) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `This hospital requires at least ${settings.minVendors} vendors on a request for quotation, and ${body.vendorIds.length} were named. Fewer than that is a single-source purchase and needs its own justification (NC-005 §3.14).`,
          );
        }

        const rfqNo = (
          await this.numbering.allocate(tx, {
            key: 'RFQ',
            branchId,
            refType: 'inventory.pur_rfqs',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.pur_rfqs
             (id, hospital_id, branch_id, rfq_no, title, due_at, sealed, status,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, 'draft'::inventory."PurRfqStatus",
                   $8, $8, now())`,
          [id, ctx.hospitalId, branchId, rfqNo, body.title, body.dueAt, body.sealed, ctx.userId],
        );

        let lineNo = 1;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          await tx.query(
            `INSERT INTO inventory.pur_rfq_lines
               (id, hospital_id, rfq_id, line_no, item_id, uom_id, qty_entered, qty_base, specs,
                indent_line_ids, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9, '{}'::uuid[], $10, $10, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              lineNo,
              line.itemId,
              converted.uomId,
              converted.qtyEntered,
              converted.qtyBase,
              line.specs ?? null,
              ctx.userId,
            ],
          );
          lineNo += 1;
        }

        for (const vendorId of body.vendorIds) {
          await this.vendors.assertPurchasable(tx, vendorId);
          await tx.query(
            `INSERT INTO inventory.pur_rfq_vendors
               (id, hospital_id, rfq_id, vendor_id, channel, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, 'email', $5, $5, now())`,
            [newId(), ctx.hospitalId, id, vendorId, ctx.userId],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.pur_rfqs',
          rowId: id,
          businessKey: rfqNo,
          dataClass: 'financial',
          before: null,
          after: { vendors: body.vendorIds.length, lines: body.lines.length },
        });
      }),
    );

    return this.rfq(id);
  }

  async sendRfq(id: string): Promise<DocumentView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{ status: string; rfq_no: string; due_at: string }>(
          `SELECT status::text AS status, rfq_no, due_at::text AS due_at
             FROM inventory.pur_rfqs WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The request for quotation');
        assertStatus('This RFQ', header.status, ['draft'], 'sent');

        await tx.query(
          `UPDATE inventory.pur_rfq_vendors SET sent_at = now(), updated_at = now(), updated_by = $2
            WHERE rfq_id = $1`,
          [id, ctx.userId],
        );
        await tx.query(
          `UPDATE inventory.pur_rfqs
              SET status = 'sent'::inventory."PurRfqStatus", updated_at = now(), updated_by = $2,
                  version = version + 1
            WHERE id = $1`,
          [id, ctx.userId],
        );

        const counts = await tx.one<{ vendors: string; lines: string }>(
          `SELECT (SELECT count(*)::text FROM inventory.pur_rfq_vendors WHERE rfq_id = $1) AS vendors,
                  (SELECT count(*)::text FROM inventory.pur_rfq_lines WHERE rfq_id = $1) AS lines`,
          [id],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.pur_rfqs',
          rowId: id,
          businessKey: header.rfq_no,
          dataClass: 'financial',
          before: { status: header.status },
          after: { status: 'sent' },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.rfq.sent', id, {
            rfqId: id,
            rfqNo: header.rfq_no,
            vendorCount: Number(counts.vendors),
            lineCount: Number(counts.lines),
            closesAt: new Date(header.due_at).toISOString(),
            sentBy: ctx.userId,
            sentAt: new Date().toISOString(),
          }),
        );
      }),
    );
    return this.rfq(id);
  }

  /**
   * A quotation, priced per base unit so it can be compared.
   *
   * `landed_unit_cost_base` is the number the comparative sorts on: rate, less
   * discount, plus tax, divided by the base units the quoted pack contains. Two
   * vendors quoting "₹120" for a box of 10 and a box of 12 are not quoting the
   * same price, and a comparison that sorted on the headline rate would award to
   * the more expensive one roughly half the time.
   */
  async enterQuotation(rfqId: string, body: EnterQuotationRequest): Promise<DocumentView> {
    const ctx = getContext();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const rfq = await tx.maybeOne<{ status: string; rfq_no: string }>(
          `SELECT status::text AS status, rfq_no FROM inventory.pur_rfqs WHERE id = $1`,
          [rfqId],
        );
        if (rfq === undefined) throw AppError.notFound('The request for quotation');
        assertStatus('This RFQ', rfq.status, ['sent'], 'quoted against');
        await this.vendors.assertPurchasable(tx, body.vendorId);

        await tx.query(
          `INSERT INTO inventory.pur_quotations
             (id, hospital_id, rfq_id, vendor_id, quote_no, quote_date, valid_till, delivery_days,
              payment_terms, freight, status, entered_by, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10::numeric,
                   'received'::inventory."PurQuotationStatus", $11, $11, $11, now())`,
          [
            id,
            ctx.hospitalId,
            rfqId,
            body.vendorId,
            body.quoteNo,
            body.quoteDate,
            body.validTill ?? null,
            body.deliveryDays ?? null,
            body.paymentTerms ?? null,
            body.freight,
            ctx.userId,
          ],
        );

        let total = 0;
        for (const line of body.lines) {
          const rfqLine = await tx.maybeOne<{ item_id: string; qty_base: string; qty_entered: string }>(
            `SELECT item_id, qty_base::text AS qty_base, qty_entered::text AS qty_entered
               FROM inventory.pur_rfq_lines WHERE id = $1 AND rfq_id = $2`,
            [line.rfqLineId, rfqId],
          );
          if (rfqLine === undefined) throw AppError.notFound('The RFQ line');

          const item = await this.uoms.item(tx, rfqLine.item_id);
          const quotedUom = line.uomId ?? item.purchase_uom_id ?? item.base_uom_id;
          const onePack = await this.uoms.toBase(tx, item, quotedUom, 1);
          const net = line.unitPrice * (1 - line.discountPct / 100);
          const withTax = net * (1 + line.gstRate / 100);
          const perBase = withTax / Number(onePack.qtyBase);
          total += net * (Number(rfqLine.qty_base) / Number(onePack.qtyBase));

          await tx.query(
            `INSERT INTO inventory.pur_quotation_lines
               (id, hospital_id, quotation_id, rfq_line_id, item_id, brand, uom_id, unit_price,
                discount_pct, gst_rate, free_qty, landed_unit_cost_base, tech_score,
                created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric,
                     $11::numeric, $12::numeric, $13::numeric, $14, $14, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              line.rfqLineId,
              rfqLine.item_id,
              line.brand ?? null,
              quotedUom,
              line.unitPrice,
              line.discountPct,
              line.gstRate,
              line.freeQty,
              perBase.toFixed(4),
              line.techScore ?? null,
              ctx.userId,
            ],
          );
        }

        // L1 is recomputed across every quotation on the RFQ each time one
        // arrives, so the flag never depends on the order the quotes were typed.
        await this.markL1(tx, rfqId);

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.pur_quotations',
          rowId: id,
          businessKey: body.quoteNo,
          dataClass: 'financial',
          before: null,
          after: { rfq_no: rfq.rfq_no, vendor_id: body.vendorId, lines: body.lines.length },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.quote.received', id, {
            quotationId: id,
            rfqId,
            vendorId: body.vendorId,
            totalValue: moneyString(total),
            currency: 'INR',
            validUntil: body.validTill ?? null,
            receivedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.rfq(rfqId);
  }

  /** The comparative statement — every quote per line, cheapest landed cost first. */
  async comparative(rfqId: string): Promise<ComparativeView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await tx.rows<{
        rfq_line_id: string;
        item_id: string;
        item_code: string;
        item_name: string;
        qty_base: string;
        quotation_line_id: string | null;
        quotation_id: string | null;
        vendor_id: string | null;
        vendor_name: string | null;
        brand: string | null;
        unit_price: string | null;
        discount_pct: string | null;
        gst_rate: string | null;
        landed_unit_cost_base: string | null;
        delivery_days: number | null;
        tech_score: string | null;
        is_l1: boolean | null;
        selected: boolean | null;
      }>(
        `SELECT rl.id AS rfq_line_id, rl.item_id, i.code AS item_code, i.name AS item_name,
                rl.qty_base::text AS qty_base,
                ql.id AS quotation_line_id, q.id AS quotation_id, q.vendor_id, v.legal_name AS vendor_name,
                ql.brand, ql.unit_price::text AS unit_price, ql.discount_pct::text AS discount_pct,
                ql.gst_rate::text AS gst_rate,
                ql.landed_unit_cost_base::text AS landed_unit_cost_base,
                q.delivery_days, ql.tech_score::text AS tech_score, ql.is_l1, ql.selected
           FROM inventory.pur_rfq_lines rl
           JOIN inventory.items i ON i.id = rl.item_id
           LEFT JOIN inventory.pur_quotation_lines ql ON ql.rfq_line_id = rl.id
           LEFT JOIN inventory.pur_quotations q ON q.id = ql.quotation_id
           LEFT JOIN inventory.vnd_vendors v ON v.id = q.vendor_id
          WHERE rl.rfq_id = $1
          ORDER BY rl.line_no, ql.landed_unit_cost_base NULLS LAST`,
        [rfqId],
      );

      const byLine = new Map<string, ComparativeView['lines'][number]>();
      for (const row of rows) {
        let line = byLine.get(row.rfq_line_id);
        if (line === undefined) {
          line = {
            rfqLineId: row.rfq_line_id,
            itemId: row.item_id,
            itemCode: row.item_code,
            itemName: row.item_name,
            qtyBase: row.qty_base,
            quotes: [],
          };
          byLine.set(row.rfq_line_id, line);
        }
        if (row.quotation_line_id === null || row.quotation_id === null || row.vendor_id === null) continue;
        line.quotes.push({
          quotationLineId: row.quotation_line_id,
          quotationId: row.quotation_id,
          vendorId: row.vendor_id,
          vendorName: row.vendor_name ?? '',
          brand: row.brand,
          unitPrice: row.unit_price ?? '0',
          discountPct: row.discount_pct ?? '0',
          gstRate: row.gst_rate ?? '0',
          landedUnitCostBase: row.landed_unit_cost_base ?? '0',
          deliveryDays: row.delivery_days,
          techScore: row.tech_score,
          isL1: row.is_l1 ?? false,
          selected: row.selected ?? false,
        });
      }

      return { rfqId, generatedAt: new Date().toISOString(), lines: [...byLine.values()] };
    });
  }

  /**
   * Awarding. A selection that is not L1 needs a justification, and the database
   * refuses the row without one — this method turns that into a field error and
   * records the comparative that the award was made from.
   */
  async approveComparative(rfqId: string, body: ApproveComparativeRequest): Promise<ComparativeView> {
    const ctx = getContext();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const rfq = await tx.maybeOne<{ status: string; rfq_no: string }>(
          `SELECT status::text AS status, rfq_no FROM inventory.pur_rfqs WHERE id = $1 FOR UPDATE`,
          [rfqId],
        );
        if (rfq === undefined) throw AppError.notFound('The request for quotation');
        assertStatus('This RFQ', rfq.status, ['sent'], 'awarded');

        const matrix = await this.comparative(rfqId);
        let selectedVendorId: string | null = null;
        let l1Selected = true;
        let justification: string | null = null;
        let total = 0;

        for (const selection of body.selections) {
          const line = await tx.maybeOne<{
            is_l1: boolean;
            vendor_id: string;
            landed_unit_cost_base: string | null;
            rfq_line_id: string;
          }>(
            `SELECT ql.is_l1, q.vendor_id, ql.landed_unit_cost_base::text AS landed_unit_cost_base,
                    ql.rfq_line_id
               FROM inventory.pur_quotation_lines ql
               JOIN inventory.pur_quotations q ON q.id = ql.quotation_id
              WHERE ql.id = $1 AND q.rfq_id = $2`,
            [selection.quotationLineId, rfqId],
          );
          if (line === undefined) throw AppError.notFound('The quotation line');
          if (!line.is_l1 && (selection.justification ?? '').trim().length === 0) {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              'This is not the lowest landed cost on the line. Selecting it needs a written justification — "why did we not take L1" must never depend on somebody remembering to type it.',
              { nextAction: 'Add a justification to the selection, or select the L1 quote.' },
            );
          }
          if (!line.is_l1) {
            l1Selected = false;
            justification = selection.justification ?? null;
          }
          selectedVendorId = line.vendor_id;

          const rfqLine = matrix.lines.find((l) => l.rfqLineId === line.rfq_line_id);
          total += Number(line.landed_unit_cost_base ?? 0) * Number(rfqLine?.qtyBase ?? 0);

          await tx.query(
            `UPDATE inventory.pur_quotation_lines
                SET selected = true, selection_justification = $2, updated_at = now(), updated_by = $3
              WHERE id = $1`,
            [selection.quotationLineId, selection.justification ?? null, ctx.userId],
          );
        }

        if (selectedVendorId === null) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            'A comparative award selects at least one quote.',
          );
        }

        await tx.query(
          `INSERT INTO inventory.pur_comparatives
             (id, hospital_id, rfq_id, matrix, scoring_model, generated_at, generated_by,
              approved_by, approved_at, status, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, '{}'::jsonb, now(), $5, $5, now(), 'approved', $5, $5, now())`,
          [id, ctx.hospitalId, rfqId, JSON.stringify(matrix), ctx.userId],
        );

        await tx.query(
          `UPDATE inventory.pur_rfqs
              SET status = 'awarded'::inventory."PurRfqStatus", opened_by = $2, opened_at = now(),
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [rfqId, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.pur_comparatives',
          rowId: id,
          businessKey: rfq.rfq_no,
          dataClass: 'financial',
          reasonText: body.note ?? justification,
          before: null,
          after: { selected_vendor_id: selectedVendorId, l1_selected: l1Selected },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.comparative.approved', id, {
            comparativeId: id,
            rfqId,
            selectedVendorId,
            l1Selected,
            justification,
            totalValue: moneyString(total),
            currency: 'INR',
            approvedBy: ctx.userId,
            approvedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.comparative(rfqId);
  }

  // ── purchase orders ──────────────────────────────────────────────────────

  async createPo(body: CreatePoRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const vendor = await this.vendors.assertPurchasable(tx, body.vendorId);
        const poNo = (
          await this.numbering.allocate(tx, {
            key: 'PO',
            branchId,
            refType: 'inventory.pur_purchase_orders',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.pur_purchase_orders
             (id, hospital_id, branch_id, po_no, po_version, is_current, po_type, vendor_id,
              vendor_gstin, ship_to_store_id, payment_terms, delivery_terms, expected_delivery,
              tolerance_pct, rate_contract_id, rfq_id, indent_ids, budget_line_ref, freight,
              other_charges, status, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, 1, true, $5::inventory."PurPoType", $6,
                   $7, $8, $9, $10, $11::date,
                   $12::numeric, $13, $14, $15::uuid[], $16, $17::numeric,
                   $18::numeric, 'draft'::inventory."PurPoStatus", $19, $19, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            poNo,
            body.poType,
            body.vendorId,
            vendor.primary_gstin,
            body.shipToStoreId,
            body.paymentTerms ?? null,
            body.deliveryTerms ?? null,
            body.expectedDelivery ?? null,
            body.tolerancePct,
            body.rateContractId ?? null,
            body.rfqId ?? null,
            body.indentIds,
            body.budgetLineRef ?? null,
            body.freight,
            body.otherCharges,
            ctx.userId,
          ],
        );

        await this.writePoLines(tx, id, body.vendorId, body.lines, body.freight, body.otherCharges);

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.pur_purchase_orders',
          rowId: id,
          businessKey: poNo,
          dataClass: 'financial',
          before: null,
          after: { vendor_id: body.vendorId, po_type: body.poType, lines: body.lines.length },
        });
      }),
    );

    return this.po(id);
  }

  async approvePo(id: string, body: ApprovePoRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lockPo(tx, id);
        assertStatus('This purchase order', header.status, ['draft', 'pending_approval'], 'approved');
        if (header.created_by !== null && header.created_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The buyer who raised a purchase order cannot be the one who approves it (docs/04 §3).',
          );
        }

        await tx.query(
          `UPDATE inventory.pur_purchase_orders
              SET status = 'approved'::inventory."PurPoStatus",
                  approved_by = array_append(approved_by, $2::uuid), approved_at = now(),
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId],
        );

        const lineCount = await tx.one<{ n: string }>(
          `SELECT count(*)::text AS n FROM inventory.pur_po_lines WHERE po_id = $1`,
          [id],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.pur_purchase_orders',
          rowId: id,
          businessKey: header.po_no,
          dataClass: 'financial',
          reasonText: body.note ?? null,
          before: { status: header.status },
          after: { status: 'approved', total: header.total },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.po.approved', id, {
            poId: id,
            poNo: header.po_no,
            poVersion: header.po_version,
            vendorId: header.vendor_id,
            poType: header.po_type,
            lineCount: Number(lineCount.n),
            netValue: moneyString(Number(header.taxable ?? 0)),
            taxValue: moneyString(
              Number(header.cgst ?? 0) + Number(header.sgst ?? 0) + Number(header.igst ?? 0),
            ),
            grossValue: moneyString(Number(header.total ?? 0)),
            currency: 'INR',
            budgetLine: header.budget_line_ref,
            approvedBy: ctx.userId,
            approvedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.po(id);
  }

  async sendPo(id: string, body: SendPoRequest): Promise<DocumentView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lockPo(tx, id);
        assertStatus('This purchase order', header.status, ['approved'], 'sent');
        await tx.query(
          `UPDATE inventory.pur_purchase_orders
              SET status = 'sent'::inventory."PurPoStatus", sent_at = now(),
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId],
        );
        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.pur_purchase_orders',
          rowId: id,
          businessKey: header.po_no,
          dataClass: 'financial',
          before: { status: header.status },
          after: { status: 'sent', channel: body.channel },
        });
        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.po.sent', id, {
            poId: id,
            poNo: header.po_no,
            poVersion: header.po_version,
            vendorId: header.vendor_id,
            channel: body.channel,
            sentBy: ctx.userId,
            sentAt: new Date().toISOString(),
          }),
        );
      }),
    );
    return this.po(id);
  }

  /**
   * An amendment is a new version, never an edit.
   *
   * The superseded row keeps `is_current = false` and is frozen by
   * `inventory.refuse_superseded_po_edit` — the vendor holds a copy of it, and a
   * purchase order that changes underneath the person holding it is not a
   * contract. `uq_pur_po_one_current` then guarantees the new row is the only
   * live version.
   */
  async amendPo(id: string, body: AmendPoRequest): Promise<DocumentView> {
    const ctx = getContext();
    const newVersionId = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lockPo(tx, id);
        assertStatus(
          'This purchase order',
          header.status,
          ['approved', 'sent', 'acknowledged', 'partially_received'],
          'amended',
        );
        if (!header.is_current) {
          throw new AppError(
            ProblemType.CONFLICT,
            'That version of the purchase order has already been superseded. Amend the current version.',
          );
        }

        // Order matters: the old row must stop being current before the new one
        // claims it, or `uq_pur_po_one_current` refuses the insert.
        await tx.query(
          `UPDATE inventory.pur_purchase_orders
              SET is_current = false, status = 'amended'::inventory."PurPoStatus",
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId],
        );

        await tx.query(
          `INSERT INTO inventory.pur_purchase_orders
             (id, hospital_id, branch_id, po_no, po_version, is_current, po_type, vendor_id,
              vendor_gstin, ship_to_store_id, payment_terms, delivery_terms, expected_delivery,
              tolerance_pct, rate_contract_id, rfq_id, indent_ids, budget_line_ref, freight,
              other_charges, status, approved_by, created_by, updated_by, updated_at)
           SELECT $2, hospital_id, branch_id, po_no, po_version + 1, true, po_type, vendor_id,
                  vendor_gstin, ship_to_store_id, payment_terms, delivery_terms,
                  COALESCE($3::date, expected_delivery),
                  tolerance_pct, rate_contract_id, rfq_id, indent_ids, budget_line_ref, freight,
                  other_charges, 'draft'::inventory."PurPoStatus", '{}'::uuid[], $4, $4, now()
             FROM inventory.pur_purchase_orders WHERE id = $1`,
          [id, newVersionId, body.expectedDelivery ?? null, ctx.userId],
        );

        await this.writePoLines(
          tx,
          newVersionId,
          header.vendor_id,
          body.lines.map((l) => ({ ...l, freeQtyBase: 0 })),
          Number(header.freight ?? 0),
          Number(header.other_charges ?? 0),
        );

        const updated = await this.lockPo(tx, newVersionId);
        const delta = Number(updated.total ?? 0) - Number(header.total ?? 0);

        await tx.query(
          `INSERT INTO inventory.pur_po_amendments
             (id, hospital_id, po_id, po_no, from_version, to_version, changed_fields, reason,
              requested_by, approved_by, amended_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9, now(), $9)`,
          [
            newId(),
            ctx.hospitalId,
            newVersionId,
            header.po_no,
            header.po_version,
            header.po_version + 1,
            JSON.stringify({ lines: body.lines.length, valueDelta: delta.toFixed(2) }),
            body.reason,
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.pur_purchase_orders',
          rowId: newVersionId,
          businessKey: header.po_no,
          dataClass: 'financial',
          reasonText: body.reason,
          before: { po_version: header.po_version, total: header.total },
          after: { po_version: header.po_version + 1, total: updated.total },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.po.amended', newVersionId, {
            poId: newVersionId,
            poNo: header.po_no,
            fromVersion: header.po_version,
            toVersion: header.po_version + 1,
            reason: body.reason,
            valueDelta: moneyString(delta),
            currency: 'INR',
            amendedBy: ctx.userId,
            amendedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.po(newVersionId);
  }

  async shortClosePo(id: string, body: ClosePoRequest): Promise<DocumentView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lockPo(tx, id);
        assertStatus(
          'This purchase order',
          header.status,
          ['approved', 'sent', 'acknowledged', 'partially_received'],
          'short-closed',
        );

        const open = await tx.one<{ released: string }>(
          `SELECT COALESCE(sum((qty_base - qty_received_base) * COALESCE(rate_per_base, 0)), 0)::text
                    AS released
             FROM inventory.pur_po_lines WHERE po_id = $1`,
          [id],
        );

        await tx.query(
          `UPDATE inventory.pur_purchase_orders
              SET status = 'short_closed'::inventory."PurPoStatus", short_closed_reason = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.reason, ctx.userId],
        );
        await tx.query(`UPDATE inventory.pur_po_lines SET status = 'closed' WHERE po_id = $1`, [id]);

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.pur_purchase_orders',
          rowId: id,
          businessKey: header.po_no,
          dataClass: 'financial',
          reasonText: body.reason,
          before: { status: header.status },
          after: { status: 'short_closed' },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.po.short_closed', id, {
            poId: id,
            poNo: header.po_no,
            reason: body.reason,
            releasedValue: moneyString(Number(open.released)),
            currency: 'INR',
            closedBy: ctx.userId,
            closedAt: new Date().toISOString(),
          }),
        );
      }),
    );
    return this.po(id);
  }

  async cancelPo(id: string, body: ClosePoRequest): Promise<DocumentView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await this.lockPo(tx, id);
        assertStatus(
          'This purchase order',
          header.status,
          ['draft', 'pending_approval', 'approved', 'sent', 'acknowledged'],
          'cancelled',
        );
        const received = await tx.one<{ n: string }>(
          `SELECT COALESCE(sum(qty_received_base), 0)::text AS n
             FROM inventory.pur_po_lines WHERE po_id = $1`,
          [id],
        );
        if (Number(received.n) > 0) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            'Stock has already been received against this order, so it cannot be cancelled. Short-close it instead — the balance will never arrive, but what did arrive still has to be paid for.',
          );
        }

        await tx.query(
          `UPDATE inventory.pur_purchase_orders
              SET status = 'cancelled'::inventory."PurPoStatus", cancel_reason = $2,
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.reason, ctx.userId],
        );
        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.pur_purchase_orders',
          rowId: id,
          businessKey: header.po_no,
          dataClass: 'financial',
          reasonText: body.reason,
          before: { status: header.status },
          after: { status: 'cancelled' },
        });
        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.po.cancelled', id, {
            poId: id,
            poNo: header.po_no,
            vendorId: header.vendor_id,
            reason: body.reason,
            cancelledBy: ctx.userId,
            cancelledAt: new Date().toISOString(),
          }),
        );
      }),
    );
    return this.po(id);
  }

  /**
   * NC-005 §3 emergency fast-track: buy now, regularise within the configured
   * window. The clock starts here and the deadline is stored, so an
   * unregularised purchase past its date is a query anybody can run rather than
   * a thing somebody remembers.
   */
  async emergencyPurchase(body: EmergencyPurchaseRequest): Promise<{
    readonly id: string;
    readonly reference: string;
    readonly regulariseDueAt: string;
  }> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    const result = await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const settings = await this.settings(tx);
        const reference = (
          await this.numbering.allocate(tx, {
            key: 'IND',
            branchId,
            refType: 'inventory.pur_emergency_purchases',
            refId: id,
          })
        ).formatted;
        const due = new Date(Date.now() + settings.emergencyRegulariseDays * 86_400_000);

        await tx.query(
          `INSERT INTO inventory.pur_emergency_purchases
             (id, hospital_id, branch_id, ref_no, indent_id, raised_by, reason,
              clinical_justification, cap_amount, vendor_id, amount, regularise_due_at, status,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11::numeric, $12::timestamptz,
                   'open', $6, $6, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            reference,
            body.indentId ?? null,
            ctx.userId,
            body.reason,
            body.clinicalJustification ?? null,
            body.capAmount ?? null,
            body.vendorId ?? null,
            body.amount ?? null,
            due.toISOString(),
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.pur_emergency_purchases',
          rowId: id,
          businessKey: reference,
          dataClass: 'financial',
          reasonText: body.reason,
          before: null,
          after: { amount: body.amount ?? null, regularise_due_at: due.toISOString() },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('purchase.emergency.raised', id, {
            emergencyId: id,
            reference,
            vendorId: body.vendorId ?? null,
            value: moneyString(body.amount ?? 0),
            currency: 'INR',
            reason: body.reason,
            regulariseBy: due.toISOString(),
            raisedBy: ctx.userId,
            raisedAt: new Date().toISOString(),
          }),
        );

        return { id, reference, regulariseDueAt: due.toISOString() };
      }),
    );

    return result;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async indent(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<{
        id: string;
        indent_no: string;
        status: string;
        store_id: string;
        urgency: string;
        required_by: string | null;
        estimated_value: string | null;
        requested_by: string | null;
        approved_by: string | null;
        rejected_reason: string | null;
        created_at: string;
      }>(
        `SELECT id, indent_no, status::text AS status, store_id, urgency::text AS urgency,
                required_by::text AS required_by, estimated_value::text AS estimated_value,
                requested_by, approved_by, rejected_reason, created_at::text AS created_at
           FROM inventory.pur_indents WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The purchase indent');

      const rows = await tx.rows<LineRow>(
        `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name,
                NULL::uuid AS batch_id, NULL::varchar AS batch_no, l.uom_id,
                l.qty_entered::text AS qty_entered, l.qty_base::text AS qty_base, l.status,
                l.qty_approved_base::text AS qty_approved_base,
                l.qty_ordered_base::text AS qty_ordered_base,
                l.qty_received_base::text AS qty_received_base, l.specs
           FROM inventory.pur_indent_lines l JOIN inventory.items i ON i.id = l.item_id
          WHERE l.indent_id = $1 ORDER BY l.line_no`,
        [id],
      );

      return {
        id: header.id,
        documentNo: header.indent_no,
        status: header.status,
        storeId: header.store_id,
        counterpartyId: null,
        createdAt: new Date(header.created_at).toISOString(),
        lines: rows.map((r) =>
          toLineView(r, ['qty_approved_base', 'qty_ordered_base', 'qty_received_base', 'specs']),
        ),
        header: {
          urgency: header.urgency,
          requiredBy: header.required_by,
          estimatedValue: header.estimated_value,
          requestedBy: header.requested_by,
          approvedBy: header.approved_by,
          rejectedReason: header.rejected_reason,
        },
      };
    });
  }

  async rfq(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<{
        id: string;
        rfq_no: string;
        status: string;
        title: string;
        due_at: string;
        sealed: boolean;
        created_at: string;
      }>(
        `SELECT id, rfq_no, status::text AS status, title, due_at::text AS due_at, sealed,
                created_at::text AS created_at
           FROM inventory.pur_rfqs WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The request for quotation');

      const rows = await tx.rows<LineRow>(
        `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name,
                NULL::uuid AS batch_id, NULL::varchar AS batch_no, l.uom_id,
                l.qty_entered::text AS qty_entered, l.qty_base::text AS qty_base,
                NULL::text AS status, l.specs
           FROM inventory.pur_rfq_lines l JOIN inventory.items i ON i.id = l.item_id
          WHERE l.rfq_id = $1 ORDER BY l.line_no`,
        [id],
      );

      const vendors = await tx.rows<{ vendor_id: string; sent_at: string | null }>(
        `SELECT vendor_id, sent_at::text AS sent_at FROM inventory.pur_rfq_vendors WHERE rfq_id = $1`,
        [id],
      );

      return {
        id: header.id,
        documentNo: header.rfq_no,
        status: header.status,
        storeId: null,
        counterpartyId: null,
        createdAt: new Date(header.created_at).toISOString(),
        lines: rows.map((r) => toLineView(r, ['specs'])),
        header: {
          title: header.title,
          dueAt: new Date(header.due_at).toISOString(),
          sealed: header.sealed,
          vendorCount: vendors.length,
          sentCount: vendors.filter((v) => v.sent_at !== null).length,
        },
      };
    });
  }

  async po(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<PoHeaderRow>(POH_SQL, [id]);
      if (header === undefined) throw AppError.notFound('The purchase order');

      const rows = await tx.rows<LineRow>(
        `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name,
                NULL::uuid AS batch_id, NULL::varchar AS batch_no, l.uom_id,
                l.qty_entered::text AS qty_entered, l.qty_base::text AS qty_base, l.status,
                l.rate::text AS rate, l.rate_per_base::text AS rate_per_base,
                l.gst_rate::text AS gst_rate, l.line_total::text AS line_total,
                l.qty_received_base::text AS qty_received_base,
                l.qty_invoiced_base::text AS qty_invoiced_base, l.hsn_code
           FROM inventory.pur_po_lines l JOIN inventory.items i ON i.id = l.item_id
          WHERE l.po_id = $1 ORDER BY l.line_no`,
        [id],
      );

      return {
        id: header.id,
        documentNo: `${header.po_no} v${header.po_version}`,
        status: header.status,
        storeId: header.ship_to_store_id,
        counterpartyId: header.vendor_id,
        createdAt: new Date(header.created_at).toISOString(),
        lines: rows.map((r) =>
          toLineView(r, [
            'rate',
            'rate_per_base',
            'gst_rate',
            'line_total',
            'qty_received_base',
            'qty_invoiced_base',
            'hsn_code',
          ]),
        ),
        header: {
          poNo: header.po_no,
          poVersion: header.po_version,
          isCurrent: header.is_current,
          poType: header.po_type,
          subtotal: header.subtotal,
          taxable: header.taxable,
          cgst: header.cgst,
          sgst: header.sgst,
          igst: header.igst,
          total: header.total,
          expectedDelivery: header.expected_delivery,
          tolerancePct: header.tolerance_pct,
          budgetLineRef: header.budget_line_ref,
        },
      };
    });
  }

  async listIndents(query: PurchaseIndentQuery): Promise<Page<DocumentView>> {
    return this.page(
      'inventory.pur_indents',
      `SELECT d.id, d.created_at::text AS cursor_key FROM inventory.pur_indents d`,
      query,
      (id) => this.indent(id),
      (bind, clauses) => {
        if (query.storeId !== undefined) clauses.push(`d.store_id = ${bind(query.storeId)}::uuid`);
        if (query.urgency !== undefined) clauses.push(`d.urgency::text = ${bind(query.urgency)}`);
      },
    );
  }

  async listRfqs(query: RfqQuery): Promise<Page<DocumentView>> {
    return this.page(
      'inventory.pur_rfqs',
      `SELECT d.id, d.created_at::text AS cursor_key FROM inventory.pur_rfqs d`,
      query,
      (id) => this.rfq(id),
      () => undefined,
    );
  }

  async listPos(query: PoQuery): Promise<Page<DocumentView>> {
    return this.page(
      'inventory.pur_purchase_orders',
      `SELECT d.id, d.created_at::text AS cursor_key FROM inventory.pur_purchase_orders d`,
      query,
      (id) => this.po(id),
      (bind, clauses) => {
        if (query.vendorId !== undefined) clauses.push(`d.vendor_id = ${bind(query.vendorId)}::uuid`);
        if (query.storeId !== undefined) clauses.push(`d.ship_to_store_id = ${bind(query.storeId)}::uuid`);
      },
    );
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** The hospital's purchase settings, with the safe defaults the schema implies. */
  async settings(tx: TransactionClient): Promise<{
    readonly minVendors: number;
    readonly emergencyRegulariseDays: number;
    readonly requireQcBeforeAccept: boolean;
    readonly receiptTolerancePct: number;
  }> {
    const ctx = getContext();
    const row = await tx.maybeOne<{
      min_vendors_for_rfq: number;
      emergency_regularise_days: number;
      require_qc_before_accept: boolean;
      receipt_tolerance_pct: string;
    }>(
      `SELECT min_vendors_for_rfq, emergency_regularise_days, require_qc_before_accept,
              receipt_tolerance_pct::text AS receipt_tolerance_pct
         FROM inventory.pur_settings
        WHERE branch_id = $1::uuid OR branch_id IS NULL
        ORDER BY branch_id NULLS LAST LIMIT 1`,
      [ctx.branchId],
    );
    return {
      minVendors: row?.min_vendors_for_rfq ?? 3,
      emergencyRegulariseDays: row?.emergency_regularise_days ?? 7,
      requireQcBeforeAccept: row?.require_qc_before_accept ?? true,
      receiptTolerancePct: Number(row?.receipt_tolerance_pct ?? 0),
    };
  }

  private async writePoLines(
    tx: TransactionClient,
    poId: string,
    vendorId: string,
    lines: readonly {
      readonly itemId: string;
      readonly qtyEntered: number;
      readonly uomId?: string | undefined;
      readonly rate?: number | undefined;
      readonly discountPct: number;
      readonly gstRate?: number | undefined;
      readonly hsnCode?: string | undefined;
      readonly freeQtyBase: number;
      readonly minShelfLifeDays?: number | undefined;
      readonly indentLineId?: string | undefined;
      readonly description?: string | undefined;
    }[],
    freight: number,
    otherCharges: number,
  ): Promise<void> {
    const ctx = getContext();
    let lineNo = 1;
    let subtotal = 0;
    let taxable = 0;
    let taxTotal = 0;

    for (const line of lines) {
      const item = await this.uoms.item(tx, line.itemId);
      const uomId = line.uomId ?? item.purchase_uom_id ?? item.base_uom_id;
      const converted = await this.uoms.toBase(tx, item, uomId, line.qtyEntered);
      const onePack = await this.uoms.toBase(tx, item, uomId, 1);

      // Rate contract first, caller's rate second. A contract that exists and is
      // live is the price the hospital already agreed; letting a buyer type over
      // it silently is how a rate contract stops meaning anything.
      const contract = await this.vendors.contractRate(tx, vendorId, line.itemId);
      const rate = line.rate ?? (contract === null ? undefined : Number(contract.rate));
      if (rate === undefined) {
        throw new AppError(
          ProblemType.VALIDATION_FAILED,
          `No rate was given for ${item.code} and no live rate contract with this vendor covers it.`,
          { nextAction: 'Enter a rate on the line, or activate a rate contract for the item.' },
        );
      }

      const gstRate = line.gstRate ?? 0;
      const net = rate * Number(converted.qtyEntered) * (1 - line.discountPct / 100);
      const tax = net * (gstRate / 100);
      subtotal += rate * Number(converted.qtyEntered);
      taxable += net;
      taxTotal += tax;

      await tx.query(
        `INSERT INTO inventory.pur_po_lines
           (id, hospital_id, po_id, line_no, item_id, description, uom_id, qty_entered, qty_base,
            rate, rate_per_base, discount_pct, free_qty_base, hsn_code, gst_rate, taxable,
            tax_amount, line_total, min_shelf_life_days, indent_line_id, rate_contract_line_id,
            created_by, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric,
                 $10::numeric, $11::numeric, $12::numeric, $13::numeric, $14, $15::numeric,
                 $16::numeric, $17::numeric, $18::numeric, $19, $20, $21, $22, $22, now())`,
        [
          newId(),
          ctx.hospitalId,
          poId,
          lineNo,
          line.itemId,
          line.description ?? null,
          converted.uomId,
          converted.qtyEntered,
          converted.qtyBase,
          rate,
          (rate / Number(onePack.qtyBase)).toFixed(4),
          line.discountPct,
          line.freeQtyBase,
          line.hsnCode ?? item.hsn_code,
          gstRate,
          net.toFixed(2),
          tax.toFixed(2),
          (net + tax).toFixed(2),
          line.minShelfLifeDays ?? item.min_shelf_life_days,
          line.indentLineId ?? null,
          contract?.lineId ?? null,
          ctx.userId,
        ],
      );

      if (line.indentLineId !== undefined) {
        await tx.query(
          `UPDATE inventory.pur_indent_lines
              SET qty_ordered_base = qty_ordered_base + $2::numeric, status = 'ordered',
                  updated_at = now(), updated_by = $3
            WHERE id = $1`,
          [line.indentLineId, converted.qtyBase, ctx.userId],
        );
      }
      lineNo += 1;
    }

    // Intra-state until a branch/vendor state comparison exists to say otherwise
    // — `vnd_gstins.state_code` carries the vendor's, and the hospital's is
    // Phase 5's `docs/06` billing entity. Splitting CGST/SGST evenly and leaving
    // IGST at zero is the correct default for the single-state deployments this
    // phase ships to, and the columns are there for Phase 5 to set properly.
    await tx.query(
      `UPDATE inventory.pur_purchase_orders
          SET subtotal = $2::numeric, taxable = $3::numeric,
              cgst = $4::numeric, sgst = $4::numeric, igst = 0,
              total = $5::numeric, updated_at = now()
        WHERE id = $1`,
      [
        poId,
        subtotal.toFixed(2),
        taxable.toFixed(2),
        (taxTotal / 2).toFixed(2),
        (taxable + taxTotal + freight + otherCharges).toFixed(2),
      ],
    );
  }

  private async markL1(tx: TransactionClient, rfqId: string): Promise<void> {
    await tx.query(
      `UPDATE inventory.pur_quotation_lines ql
          SET is_l1 = (ql.id = best.id), updated_at = now()
         FROM (
           SELECT DISTINCT ON (l.rfq_line_id) l.id, l.rfq_line_id
             FROM inventory.pur_quotation_lines l
             JOIN inventory.pur_quotations q ON q.id = l.quotation_id
            WHERE q.rfq_id = $1 AND q.status <> 'rejected'
            ORDER BY l.rfq_line_id, l.landed_unit_cost_base ASC NULLS LAST, l.id
         ) AS best
        WHERE ql.rfq_line_id = best.rfq_line_id`,
      [rfqId],
    );
  }

  private async lockPo(tx: TransactionClient, id: string): Promise<PoHeaderRow> {
    const header = await tx.maybeOne<PoHeaderRow>(`${POH_SQL} FOR UPDATE`, [id]);
    if (header === undefined) throw AppError.notFound('The purchase order');
    return header;
  }

  private async page(
    resource: string,
    selectSql: string,
    query: {
      readonly cursor?: string | undefined;
      readonly limit: number;
      readonly status?: string | undefined;
    },
    load: (id: string) => Promise<DocumentView>,
    extra: (bind: (value: unknown) => string, clauses: string[]) => void,
  ): Promise<Page<DocumentView>> {
    const hospital = hospitalId();
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    const ids = await this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.status !== undefined) clauses.push(`d.status::text = ${bind(query.status)}`);
      extra(bind, clauses);
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

const POH_SQL = `SELECT id, po_no, po_version, is_current, status::text AS status,
        po_type::text AS po_type, vendor_id, ship_to_store_id, subtotal::text AS subtotal,
        taxable::text AS taxable, cgst::text AS cgst, sgst::text AS sgst, igst::text AS igst,
        total::text AS total, freight::text AS freight, other_charges::text AS other_charges,
        expected_delivery::text AS expected_delivery, tolerance_pct::text AS tolerance_pct,
        budget_line_ref, created_by, created_at::text AS created_at
   FROM inventory.pur_purchase_orders WHERE id = $1`;

interface PoHeaderRow {
  readonly id: string;
  readonly po_no: string;
  readonly po_version: number;
  readonly is_current: boolean;
  readonly status: string;
  readonly po_type: string;
  readonly vendor_id: string;
  readonly ship_to_store_id: string;
  readonly subtotal: string | null;
  readonly taxable: string | null;
  readonly cgst: string | null;
  readonly sgst: string | null;
  readonly igst: string | null;
  readonly total: string | null;
  readonly freight: string | null;
  readonly other_charges: string | null;
  readonly expected_delivery: string | null;
  readonly tolerance_pct: string | null;
  readonly budget_line_ref: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
}

type LineRow = Record<string, string | number | boolean | null>;

function toLineView(row: LineRow, extraColumns: readonly string[]): DocumentLineView {
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
}
