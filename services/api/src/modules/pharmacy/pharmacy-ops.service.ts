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
  binder,
  hospitalId,
  moneyString,
  quantityString,
  requireBranch,
} from '../inventory/inventory.common.js';
import { StockLedgerService } from '../inventory/stock-ledger.service.js';
import { UomService } from '../inventory/uom.service.js';
import { pharmacyEvent, withPharmacyErrors } from './pharmacy.common.js';
import type {
  ApproveSaleReturnRequest,
  CloseRecallRequest,
  ColdChainReadingRequest,
  CreateSaleReturnRequest,
  DayCloseQuery,
  DayCloseRequest,
  ExpiryActionRequest,
  InterventionRequest,
  PharmacyExpiryQuery,
  PharmacyStockQuery,
  RaiseRecallRequest,
  RecallQuery,
} from './pharmacy.schemas.js';
import type {
  DayCloseView,
  ExpiryActionView,
  InterventionView,
  RecallTraceView,
  RecallView,
  SaleReturnView,
} from './pharmacy.types.js';

/**
 * OP-003 §3 — everything the counter does that is not a dispense: returns,
 * near-expiry decisions, recalls, cold chain, interventions and the day close.
 *
 * ── Why a returned strip is not automatically stock again ───────────────────
 *
 * `phase-04 §4.4`. A box that has been in a patient's bag for a week is not the
 * same asset as one that never left the shelf, and only somebody looking at it
 * can say which. So the return records the units coming back — the patient no
 * longer has them, and the record has to say so — and the disposition decides
 * whether they go back to saleable stock or are written off. `quarantine` and
 * `destroy` both write the units off rather than quarantining the whole batch:
 * the rest of that batch never left the counter, and blocking it because one
 * strip came back would empty a shelf for no reason.
 *
 * ── Why a recall is two steps ───────────────────────────────────────────────
 *
 * `phase-04` exit gate 5: "Recall a batch → the list of affected patients is
 * produced and notifications go out." Raising the recall stops the batch moving
 * *immediately* — an undecided quarantine, which
 * `inventory.enforce_ledger_preconditions` refuses to let past towards a patient.
 * Producing the patient list is a separate, permissioned act
 * (`pharmacy.recall.trace`), because that list is PHI and the person who raises
 * a recall is not always the person entitled to read who received the drug.
 *
 * ── What the day close can and cannot yet reconcile ─────────────────────────
 *
 * The tender split — cash, card, UPI — belongs to Phase 5's payment records,
 * which do not exist yet. What is reconciled here is what Phase 4 owns: the
 * value dispensed by payer type, the returns against it, the stock exceptions,
 * and the narcotic count. The last of those is a hard gate:
 * `pharmacy.enforce_day_close_preconditions` refuses the close while a
 * controlled-drug variance on that date is unresolved.
 */
@Injectable()
export class PharmacyOpsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(UomService) private readonly uoms: UomService,
  ) {}

  // ── sale returns ─────────────────────────────────────────────────────────

  async createReturn(body: CreateSaleReturnRequest): Promise<SaleReturnView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const dispense = await tx.maybeOne<{
          id: string;
          status: string;
          patient_id: string | null;
          pharmacy_store_id: string;
          store_id: string;
          dispense_no: string;
        }>(
          `SELECT id, status::text AS status, patient_id, pharmacy_store_id, store_id, dispense_no
             FROM pharmacy.dispenses WHERE id = $1`,
          [body.originalDispenseId],
        );
        if (dispense === undefined) throw AppError.notFound('The dispense');
        if (!['dispensed', 'partially_dispensed', 'partially_returned'].includes(dispense.status)) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `That dispense is "${dispense.status}". Only something that was actually given to the patient can be returned.`,
          );
        }

        const returnNo = (
          await this.numbering.allocate(tx, {
            key: 'PHRET',
            branchId,
            refType: 'pharmacy.sale_returns',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO pharmacy.sale_returns
             (id, hospital_id, branch_id, pharmacy_store_id, return_no, original_dispense_id,
              patient_id, reason_code, reason, status, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $10, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            dispense.pharmacy_store_id,
            returnNo,
            body.originalDispenseId,
            dispense.patient_id,
            body.reasonCode,
            body.reason ?? null,
            ctx.userId,
          ],
        );

        let lineNo = 1;
        let refund = 0;
        for (const line of body.lines) {
          const original = await tx.maybeOne<{
            item_id: string;
            batch_id: string | null;
            uom_id: string;
            qty_base: string;
            qty_returned_base: string;
            selling_price: string | null;
            is_returnable: boolean;
            item_code: string;
          }>(
            `SELECT di.item_id, di.batch_id, di.uom_id, di.qty_base::text AS qty_base,
                    di.qty_returned_base::text AS qty_returned_base,
                    di.selling_price::text AS selling_price, i.is_returnable, i.code AS item_code
               FROM pharmacy.dispense_items di
               JOIN inventory.items i ON i.id = di.item_id
              WHERE di.id = $1 AND di.dispense_id = $2`,
            [line.dispenseItemId, body.originalDispenseId],
          );
          if (original === undefined) throw AppError.notFound('The dispensed line');
          if (!original.is_returnable) {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              `${original.item_code} is marked not returnable in the item master. A cold-chain or opened item does not come back onto a shelf.`,
            );
          }

          const item = await this.uoms.item(tx, original.item_id);
          const converted = await this.uoms.toBase(tx, item, line.uomId ?? original.uom_id, line.qtyEntered);
          const alreadyBack = Number(original.qty_returned_base);
          if (alreadyBack + Number(converted.qtyBase) > Number(original.qty_base)) {
            throw new AppError(
              ProblemType.VALIDATION_FAILED,
              `More of ${original.item_code} is being returned than was dispensed on that line.`,
            );
          }

          const unitPrice = Number(original.selling_price ?? 0);
          const lineRefund = unitPrice * Number(converted.qtyEntered);
          refund += lineRefund;

          await tx.query(
            `INSERT INTO pharmacy.sale_return_items
               (id, hospital_id, sale_return_id, line_no, dispense_item_id, item_id, batch_id,
                uom_id, qty_entered, qty_base, disposition, refund_amount,
                created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11, $12::numeric,
                     $13, $13, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              lineNo,
              line.dispenseItemId,
              original.item_id,
              original.batch_id,
              converted.uomId,
              converted.qtyEntered,
              converted.qtyBase,
              line.disposition,
              lineRefund.toFixed(2),
              ctx.userId,
            ],
          );
          lineNo += 1;
        }

        await tx.query(`UPDATE pharmacy.sale_returns SET refund_amount = $2::numeric WHERE id = $1`, [
          id,
          refund.toFixed(2),
        ]);

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.sale_returns',
          rowId: id,
          businessKey: returnNo,
          dataClass: 'phi',
          patientId: dispense.patient_id,
          reasonText: body.reason ?? body.reasonCode,
          before: null,
          after: { dispense_no: dispense.dispense_no, lines: body.lines.length, refund: refund.toFixed(2) },
        });
      }),
    );

    return this.saleReturn(id);
  }

  /** Approval is what moves the stock. Maker ≠ checker, as for any money-out. */
  async approveReturn(id: string, body: ApproveSaleReturnRequest): Promise<SaleReturnView> {
    const ctx = getContext();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{
          status: string;
          return_no: string;
          patient_id: string | null;
          pharmacy_store_id: string;
          original_dispense_id: string;
          reason_code: string;
          refund_amount: string;
          created_by: string | null;
          branch_id: string;
        }>(
          `SELECT status, return_no, patient_id, pharmacy_store_id, original_dispense_id, reason_code,
                  refund_amount::text AS refund_amount, created_by, branch_id
             FROM pharmacy.sale_returns WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The return');
        if (header.status !== 'draft') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This return has already been decided.');
        }
        if (header.created_by !== null && header.created_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The person who raised a return cannot be the one who approves the refund.',
          );
        }

        const counter = await tx.one<{ store_id: string }>(
          `SELECT store_id FROM pharmacy.pharmacy_stores WHERE id = $1`,
          [header.pharmacy_store_id],
        );

        const lines = await tx.rows<{
          id: string;
          dispense_item_id: string;
          item_id: string;
          batch_id: string | null;
          uom_id: string;
          qty_entered: string;
          qty_base: string;
          disposition: string;
        }>(
          `SELECT id, dispense_item_id, item_id, batch_id, uom_id, qty_entered::text AS qty_entered,
                  qty_base::text AS qty_base, disposition
             FROM pharmacy.sale_return_items WHERE sale_return_id = $1 ORDER BY line_no`,
          [id],
        );

        let restocked = 0;
        for (const line of lines) {
          const posted = await this.ledger.post(tx, {
            storeId: counter.store_id,
            branchId: header.branch_id,
            itemId: line.item_id,
            batchId: line.batch_id,
            movementType: 'patient_return',
            qtyEntered: line.qty_entered,
            uomId: line.uom_id,
            refType: 'sale_return',
            refId: id,
            refLineId: line.id,
            patientId: header.patient_id,
            reason: `Patient return (${header.reason_code})`,
          });
          await tx.query(`UPDATE pharmacy.sale_return_items SET ledger_id = $2 WHERE id = $1`, [
            line.id,
            posted.ledgerId,
          ]);

          if (line.disposition === 'restock') {
            restocked += 1;
          } else {
            // Back into the record, then written off. The patient no longer has
            // it and the shelf must not sell it — and the batch as a whole is
            // untouched, because the rest of it never left the counter.
            await this.ledger.post(tx, {
              storeId: counter.store_id,
              branchId: header.branch_id,
              itemId: line.item_id,
              batchId: line.batch_id,
              movementType: line.disposition === 'destroy' ? 'wastage' : 'damage_writeoff',
              qtyEntered: line.qty_entered,
              uomId: line.uom_id,
              refType: 'sale_return',
              refId: id,
              refLineId: line.id,
              reason: `Returned medicine not fit for resale (${header.reason_code})`,
            });
          }

          await tx.query(
            `UPDATE pharmacy.dispense_items
                SET qty_returned_base = qty_returned_base + $2::numeric, updated_at = now()
              WHERE id = $1`,
            [line.dispense_item_id, line.qty_base],
          );
        }

        await tx.query(
          `UPDATE pharmacy.sale_returns
              SET status = 'approved', approved_by = $2, approved_at = now(),
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId],
        );
        await tx.query(
          `UPDATE pharmacy.dispenses
              SET status = CASE
                    WHEN NOT EXISTS (SELECT 1 FROM pharmacy.dispense_items di
                                      WHERE di.dispense_id = $1 AND di.qty_returned_base < di.qty_base)
                      THEN 'returned'::pharmacy."PhDispenseStatus"
                    ELSE 'partially_returned'::pharmacy."PhDispenseStatus"
                  END,
                  updated_at = now()
            WHERE id = $1`,
          [header.original_dispense_id],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'pharmacy.sale_returns',
          rowId: id,
          businessKey: header.return_no,
          dataClass: 'financial',
          patientId: header.patient_id,
          reasonText: body.note ?? null,
          before: { status: header.status },
          after: { status: 'approved', restocked_lines: restocked },
        });

        await this.outbox.publish(
          tx,
          pharmacyEvent('pharmacy.return.completed', id, {
            returnId: id,
            returnNo: header.return_no,
            dispenseId: header.original_dispense_id,
            patientId: header.patient_id,
            pharmacyStoreId: header.pharmacy_store_id,
            reasonCode: header.reason_code,
            lineCount: lines.length,
            restockedLines: restocked,
            refundValue: moneyString(Number(header.refund_amount)),
            currency: 'INR',
            completedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.saleReturn(id);
  }

  // ── expiry ───────────────────────────────────────────────────────────────

  async expiring(query: PharmacyExpiryQuery): Promise<{
    readonly items: readonly {
      readonly storeId: string;
      readonly itemId: string;
      readonly itemCode: string;
      readonly itemName: string;
      readonly batchId: string;
      readonly batchNo: string;
      readonly expiryDate: string;
      readonly daysToExpiry: number;
      readonly qtyOnHand: string;
      readonly valueAtCost: string;
    }[];
  }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [query.days];
      const bind = binder(values);
      const clauses = [
        'b.qty_on_hand > 0',
        'ib.expiry_date IS NOT NULL',
        'ib.expiry_date <= current_date + $1::int',
      ];
      if (query.pharmacyStoreId !== undefined) {
        clauses.push(
          `b.store_id = (SELECT store_id FROM pharmacy.pharmacy_stores WHERE id = ${bind(query.pharmacyStoreId)}::uuid)`,
        );
      }

      const rows = await tx.rows<{
        store_id: string;
        item_id: string;
        item_code: string;
        item_name: string;
        batch_id: string;
        batch_no: string;
        expiry_date: string;
        days_to_expiry: string;
        qty_on_hand: string;
        value: string;
      }>(
        `SELECT b.store_id, b.item_id, i.code AS item_code, i.name AS item_name, b.batch_id,
                ib.batch_no, ib.expiry_date::text AS expiry_date,
                (ib.expiry_date - current_date)::text AS days_to_expiry,
                b.qty_on_hand::text AS qty_on_hand, b.value::text AS value
           FROM inventory.stock_balances b
           JOIN inventory.items i ON i.id = b.item_id
           JOIN inventory.item_batches ib ON ib.id = b.batch_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY ib.expiry_date ASC
          LIMIT 500`,
        values,
      );

      return {
        items: rows.map((r) => ({
          storeId: r.store_id,
          itemId: r.item_id,
          itemCode: r.item_code,
          itemName: r.item_name,
          batchId: r.batch_id,
          batchNo: r.batch_no,
          expiryDate: r.expiry_date,
          daysToExpiry: Number(r.days_to_expiry),
          qtyOnHand: r.qty_on_hand,
          valueAtCost: r.value,
        })),
      };
    });
  }

  /**
   * A near-expiry or expired batch decided upon: returned, transferred,
   * discounted, quarantined or written off.
   *
   * `writeoff` and `disposal` move stock immediately, because an expired strip
   * on a shelf is a dispensing error waiting for a busy morning — the ledger
   * refuses to let it go to a patient, but it still shows as stock until it is
   * written off. `discount` and `transfer` are decisions recorded here and
   * carried out by the pricing and transfer paths, which own those movements.
   */
  async actOnExpiry(body: ExpiryActionRequest): Promise<ExpiryActionView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const item = await this.uoms.item(tx, body.itemId);
        const converted = await this.uoms.toBase(tx, item, body.uomId, body.qtyEntered);
        const balance = await this.ledger.balance(tx, body.storeId, body.itemId, body.batchId);
        const unitCost = balance === undefined ? 0 : Number(balance.avg_cost);
        const value = unitCost * Number(converted.qtyBase);

        const moves = body.action === 'writeoff' || body.action === 'disposal';
        await tx.query(
          `INSERT INTO pharmacy.expiry_actions
             (id, hospital_id, branch_id, store_id, batch_id, item_id, action, uom_id,
              qty_entered, qty_base, value_at_cost, reason, approved_by, approved_at,
              bmw_record_ref, status, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::pharmacy."PhExpiryAction", $8,
                   $9::numeric, $10::numeric, $11::numeric, $12, $13, now(),
                   $14, $15, $13, $13, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.storeId,
            body.batchId,
            body.itemId,
            body.action,
            converted.uomId,
            converted.qtyEntered,
            converted.qtyBase,
            value.toFixed(2),
            body.reason,
            ctx.userId,
            body.bmwRecordRef ?? null,
            moves ? 'completed' : 'approved',
          ],
        );

        if (moves) {
          await this.ledger.post(tx, {
            storeId: body.storeId,
            branchId,
            itemId: body.itemId,
            batchId: body.batchId,
            movementType: 'expiry_writeoff',
            qtyEntered: converted.qtyEntered,
            uomId: converted.uomId,
            unitCost,
            refType: 'writeoff',
            refId: id,
            reason: body.reason,
            remarks: body.bmwRecordRef ?? null,
          });
          await tx.query(
            `UPDATE inventory.item_batches
                SET status = 'written_off'::inventory."InvBatchStatus", updated_at = now(),
                    updated_by = $2, version = version + 1
              WHERE id = $1
                AND NOT EXISTS (SELECT 1 FROM inventory.stock_balances sb
                                 WHERE sb.batch_id = $1 AND sb.qty_on_hand > 0)`,
            [body.batchId, ctx.userId],
          );
        } else if (body.action === 'quarantine') {
          await tx.query(
            `INSERT INTO inventory.quarantines
               (id, hospital_id, batch_id, scope, store_id, reason, started_at, decision,
                created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, 'store', $4, 'expiry'::inventory."InvQuarantineReason",
                     now(), 'pending', $5, $5, now())`,
            [newId(), ctx.hospitalId, body.batchId, body.storeId, ctx.userId],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.expiry_actions',
          rowId: id,
          businessKey: item.code,
          dataClass: 'financial',
          reasonText: body.reason,
          before: null,
          after: { action: body.action, qty_base: converted.qtyBase, value: value.toFixed(2) },
        });

        await this.outbox.publish(
          tx,
          pharmacyEvent('pharmacy.expiry.action_taken', id, {
            actionId: id,
            pharmacyStoreId: body.storeId,
            itemId: body.itemId,
            batchId: body.batchId,
            action: body.action,
            qtyBase: quantityString(Number(converted.qtyBase)),
            value: moneyString(value),
            currency: 'INR',
            reason: body.reason,
            approvedBy: ctx.userId,
            actionedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.expiryAction(id);
  }

  // ── recall — phase-04 exit gate 5 ────────────────────────────────────────

  async raiseRecall(body: RaiseRecallRequest): Promise<RecallView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const item = await this.uoms.item(tx, body.itemId);
        const recallNo = (
          await this.numbering.allocate(tx, {
            key: 'PHRET',
            branchId,
            refType: 'pharmacy.recalls',
            refId: id,
          })
        ).formatted;

        const batches = await tx.rows<{ id: string }>(
          `SELECT id FROM inventory.item_batches WHERE item_id = $1 AND batch_no = $2`,
          [body.itemId, body.batchNo],
        );

        await tx.query(
          `INSERT INTO pharmacy.recalls
             (id, hospital_id, recall_no, source, source_ref, item_id, batch_id, batch_no,
              recall_class, reason, raised_at, raised_by, quarantined_at, status,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4::pharmacy."PhRecallSource", $5, $6, $7, $8,
                   $9, $10, now(), $11, now(), 'open', $11, $11, now())`,
          [
            id,
            ctx.hospitalId,
            recallNo,
            body.source,
            body.sourceRef ?? null,
            body.itemId,
            batches[0]?.id ?? null,
            body.batchNo,
            body.recallClass,
            body.reason,
            ctx.userId,
          ],
        );

        // Stop it moving now. `decision = 'pending'` is what
        // `inventory.enforce_ledger_preconditions` refuses to let past towards a
        // patient — the batch is frozen before anybody has produced a list.
        for (const batch of batches) {
          await tx.query(
            `INSERT INTO inventory.quarantines
               (id, hospital_id, batch_id, scope, reason, source_ref_type, source_ref_id,
                started_at, decision, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, 'all_stores', 'recall'::inventory."InvQuarantineReason",
                     'recall', $4, now(), 'pending', $5, $5, now())`,
            [newId(), ctx.hospitalId, batch.id, id, ctx.userId],
          );
          await tx.query(
            `UPDATE inventory.item_batches
                SET status = 'recalled'::inventory."InvBatchStatus", quarantine_reason = $2,
                    updated_at = now(), updated_by = $3, version = version + 1
              WHERE id = $1`,
            [batch.id, body.reason, ctx.userId],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.recalls',
          rowId: id,
          businessKey: recallNo,
          dataClass: 'operational',
          reasonText: body.reason,
          before: null,
          after: { item_code: item.code, batch_no: body.batchNo, batches_quarantined: batches.length },
        });

        await this.outbox.publish(
          tx,
          pharmacyEvent('pharmacy.recall.raised', id, {
            recallId: id,
            recallNo,
            source: body.source,
            itemId: body.itemId,
            batchNo: body.batchNo,
            severity: body.recallClass,
            reason: body.reason,
            raisedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.recall(id);
  }

  /**
   * The patient list — `phase-04` exit gate 5.
   *
   * Reads the ledger's partial patient index, which exists precisely so this
   * query does not scan the busiest table in the phase. Every trace row is
   * written, so the list is a record rather than a report that can be re-run
   * differently tomorrow, and `pharmacy.recall.traced` carries counts only: the
   * names are PHI and are read from the trace by somebody holding
   * `pharmacy.recall.trace`.
   */
  async traceRecall(id: string): Promise<RecallTraceView> {
    const ctx = getContext();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const recall = await tx.maybeOne<{
          id: string;
          recall_no: string;
          item_id: string | null;
          batch_no: string | null;
          status: string;
        }>(`SELECT id, recall_no, item_id, batch_no, status FROM pharmacy.recalls WHERE id = $1 FOR UPDATE`, [
          id,
        ]);
        if (recall === undefined) throw AppError.notFound('The recall');

        const batchIds = await tx.rows<{ id: string }>(
          `SELECT id FROM inventory.item_batches WHERE item_id = $1 AND batch_no = $2`,
          [recall.item_id, recall.batch_no],
        );
        const ids = batchIds.map((b) => b.id);

        const dispensed =
          ids.length === 0
            ? []
            : await tx.rows<{
                dispense_item_id: string;
                patient_id: string | null;
                qty_base: string;
                dispensed_at: string | null;
              }>(
                `SELECT di.id AS dispense_item_id, d.patient_id, di.qty_base::text AS qty_base,
                        d.dispensed_at::text AS dispensed_at
                   FROM pharmacy.dispense_items di
                   JOIN pharmacy.dispenses d ON d.id = di.dispense_id
                  WHERE di.batch_id = ANY($1::uuid[])
                    AND d.status IN ('dispensed', 'partially_dispensed', 'partially_returned')`,
                [ids],
              );

        for (const row of dispensed) {
          await tx.query(
            `INSERT INTO pharmacy.recall_traces
               (id, hospital_id, recall_id, dispense_item_id, patient_id, qty_dispensed_base,
                dispensed_at, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::timestamptz, $8, $8, now())
             ON CONFLICT DO NOTHING`,
            [
              newId(),
              ctx.hospitalId,
              id,
              row.dispense_item_id,
              row.patient_id,
              row.qty_base,
              row.dispensed_at,
              ctx.userId,
            ],
          );
        }

        const held =
          ids.length === 0
            ? { qty: '0', stores: '0' }
            : await tx.one<{ qty: string; stores: string }>(
                `SELECT COALESCE(sum(qty_on_hand), 0)::text AS qty,
                        count(DISTINCT store_id)::text AS stores
                   FROM inventory.stock_balances
                  WHERE batch_id = ANY($1::uuid[]) AND qty_on_hand > 0`,
                [ids],
              );

        const patientCount = new Set(dispensed.map((d) => d.patient_id).filter((p) => p !== null)).size;

        await tx.query(
          `UPDATE pharmacy.recalls
              SET patients_identified = $2, status = 'tracing', updated_at = now(), updated_by = $3,
                  version = version + 1
            WHERE id = $1`,
          [id, patientCount, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'read_phi',
          entity: 'pharmacy.recall_traces',
          rowId: id,
          businessKey: recall.recall_no,
          dataClass: 'phi',
          rowCount: dispensed.length,
          before: null,
          after: { patients_identified: patientCount, quarantined_qty: held.qty },
        });

        await this.outbox.publish(
          tx,
          pharmacyEvent('pharmacy.recall.traced', id, {
            recallId: id,
            recallNo: recall.recall_no,
            quarantinedQtyBase: quantityString(Number(held.qty)),
            dispensedPatientCount: patientCount,
            openStoreCount: Number(held.stores),
            tracedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.recallTrace(id);
  }

  async closeRecall(id: string, body: CloseRecallRequest): Promise<RecallView> {
    const ctx = getContext();
    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const recall = await tx.maybeOne<{ status: string; recall_no: string }>(
          `SELECT status, recall_no FROM pharmacy.recalls WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (recall === undefined) throw AppError.notFound('The recall');
        if (recall.status === 'closed') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This recall is already closed.');
        }

        const contacted = await tx.one<{ contacted: string; total: string }>(
          `SELECT count(*) FILTER (WHERE contacted_at IS NOT NULL)::text AS contacted,
                  count(*)::text AS total
             FROM pharmacy.recall_traces WHERE recall_id = $1`,
          [id],
        );

        await tx.query(
          `UPDATE pharmacy.recalls
              SET status = 'closed', closed_at = now(), closed_by = $2, patients_contacted = $3,
                  updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId, Number(contacted.contacted)],
        );

        await this.audit.write(tx, {
          action: 'update',
          entity: 'pharmacy.recalls',
          rowId: id,
          businessKey: recall.recall_no,
          dataClass: 'operational',
          reasonText: body.reason,
          before: { status: recall.status },
          after: { status: 'closed' },
        });

        await this.outbox.publish(
          tx,
          pharmacyEvent('pharmacy.recall.closed', id, {
            recallId: id,
            recallNo: recall.recall_no,
            patientsNotified: Number(contacted.contacted),
            patientsUncontactable: Number(contacted.total) - Number(contacted.contacted),
            closedBy: ctx.userId,
            closedAt: new Date().toISOString(),
          }),
        );
      }),
    );
    return this.recall(id);
  }

  // ── cold chain ───────────────────────────────────────────────────────────

  async recordTemperature(body: ColdChainReadingRequest): Promise<{ readonly excursion: boolean }> {
    const ctx = getContext();

    return withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const zone = await tx.maybeOne<{
          id: string;
          store_id: string;
          code: string;
          min_c: string;
          max_c: string;
        }>(
          `SELECT id, store_id, code, min_c::text AS min_c, max_c::text AS max_c
             FROM inventory.temp_zones WHERE id = $1 AND active`,
          [body.zoneId],
        );
        if (zone === undefined) throw AppError.notFound('The temperature zone');

        const excursion = body.valueC < Number(zone.min_c) || body.valueC > Number(zone.max_c);
        const at = body.recordedAt === undefined ? new Date() : new Date(body.recordedAt);

        await tx.query(
          `INSERT INTO inventory.temp_readings
             (id, hospital_id, zone_id, value_c, humidity_pct, source, is_excursion, recorded_by,
              recorded_at)
           VALUES ($1, $2, $3, $4::numeric, $5::numeric, 'manual', $6, $7, $8::timestamptz)`,
          [
            newId(),
            ctx.hospitalId,
            body.zoneId,
            body.valueC,
            body.humidityPct ?? null,
            excursion,
            ctx.userId,
            at.toISOString(),
          ],
        );
        await tx.query(
          `UPDATE inventory.temp_zones
              SET last_reading_c = $2::numeric, last_reading_at = $3::timestamptz,
                  status = $4, updated_at = now(), updated_by = $5
            WHERE id = $1`,
          [body.zoneId, body.valueC, at.toISOString(), excursion ? 'excursion' : 'ok', ctx.userId],
        );

        if (!excursion) return { excursion: false };

        const excursionId = newId();
        const affected = await tx.rows<{ batch_id: string }>(
          `SELECT DISTINCT b.batch_id
             FROM inventory.stock_balances b
             JOIN inventory.items i ON i.id = b.item_id
            WHERE b.store_id = $1 AND b.qty_on_hand > 0 AND b.batch_id IS NOT NULL
              AND i.temp_zone_required`,
          [zone.store_id],
        );

        await tx.query(
          `INSERT INTO inventory.temp_excursions
             (id, hospital_id, zone_id, started_at, min_c, max_c, affected_batch_ids, decision,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4::timestamptz, $5::numeric, $5::numeric, $6::uuid[], 'pending',
                   $7, $7, now())`,
          [
            excursionId,
            ctx.hospitalId,
            body.zoneId,
            at.toISOString(),
            body.valueC,
            affected.map((a) => a.batch_id),
            ctx.userId,
          ],
        );

        await this.outbox.publish(
          tx,
          pharmacyEvent('pharmacy.coldchain.excursion', excursionId, {
            excursionId,
            pharmacyStoreId: zone.store_id,
            zoneId: body.zoneId,
            readingC: body.valueC.toFixed(2),
            minC: Number(zone.min_c).toFixed(2),
            maxC: Number(zone.max_c).toFixed(2),
            durationMinutes: 0,
            affectedBatchCount: affected.length,
            startedAt: at.toISOString(),
          }),
        );

        return { excursion: true };
      }),
    );
  }

  // ── interventions ────────────────────────────────────────────────────────

  async recordIntervention(body: InterventionRequest): Promise<InterventionView> {
    const ctx = getContext();
    const id = newId();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `INSERT INTO pharmacy.pharmacy_interventions
             (id, hospital_id, dispense_id, prescription_id, patient_id, intervention_type, detail,
              outcome, doctor_contacted, doctor_user_id, pharmacist_user_id, occurred_at,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), $11, $11, now())`,
          [
            id,
            ctx.hospitalId,
            body.dispenseId ?? null,
            body.prescriptionId ?? null,
            body.patientId,
            body.interventionType,
            body.detail,
            body.outcome,
            body.doctorContacted,
            body.doctorUserId ?? null,
            ctx.userId,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.pharmacy_interventions',
          rowId: id,
          businessKey: body.interventionType,
          dataClass: 'phi',
          patientId: body.patientId,
          before: null,
          after: { intervention_type: body.interventionType, outcome: body.outcome },
        });

        await this.outbox.publish(
          tx,
          pharmacyEvent('pharmacy.intervention.recorded', id, {
            interventionId: id,
            dispenseId: body.dispenseId ?? null,
            prescriptionId: body.prescriptionId ?? null,
            patientId: body.patientId,
            category: body.interventionType,
            outcome: body.outcome,
            pharmacistUserId: ctx.userId ?? id,
            recordedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.intervention(id);
  }

  // ── day close ────────────────────────────────────────────────────────────

  async dayClose(body: DayCloseRequest): Promise<DayCloseView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withPharmacyErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const counter = await tx.one<{ store_id: string; code: string }>(
          `SELECT store_id, code FROM pharmacy.pharmacy_stores WHERE id = $1`,
          [body.pharmacyStoreId],
        );

        const sales = await tx.one<{
          dispense_count: string;
          gross: string;
          cash: string;
          credit: string;
        }>(
          `SELECT count(*)::text AS dispense_count,
                  COALESCE(sum(total_amount), 0)::text AS gross,
                  COALESCE(sum(total_amount) FILTER (WHERE payer_type = 'cash'), 0)::text AS cash,
                  COALESCE(sum(total_amount) FILTER (WHERE payer_type <> 'cash'), 0)::text AS credit
             FROM pharmacy.dispenses
            WHERE pharmacy_store_id = $1 AND dispensed_at::date = $2::date
              AND status IN ('dispensed', 'partially_dispensed', 'partially_returned', 'returned')`,
          [body.pharmacyStoreId, body.businessDate],
        );

        const returns = await tx.one<{ value: string }>(
          `SELECT COALESCE(sum(refund_amount), 0)::text AS value
             FROM pharmacy.sale_returns
            WHERE pharmacy_store_id = $1 AND approved_at::date = $2::date AND status = 'approved'`,
          [body.pharmacyStoreId, body.businessDate],
        );

        const exceptions = await this.exceptionsFor(tx, counter.store_id, body.businessDate);
        const narcoticChecks = await tx.one<{ n: string }>(
          `SELECT count(*)::text AS n FROM pharmacy.narcotic_custody_checks
            WHERE store_id = $1 AND checked_at::date = $2::date`,
          [counter.store_id, body.businessDate],
        );

        const cashVariance = body.cashCounted - Number(sales.cash);

        await tx.query(
          `INSERT INTO pharmacy.pharmacy_day_close
             (id, hospital_id, branch_id, pharmacy_store_id, business_date, shift_label,
              dispense_count, gross_sales, returns_value, cash_collected, credit_value,
              cash_counted, cash_variance, stock_exceptions, narcotic_checks_done,
              closed_by, closed_at, status, notes, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5::date, $6,
                   $7, $8::numeric, $9::numeric, $10::numeric, $11::numeric,
                   $12::numeric, $13::numeric, $14::jsonb, $15,
                   $16, now(), 'closed', $17, $16, $16, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.pharmacyStoreId,
            body.businessDate,
            body.shiftLabel ?? null,
            Number(sales.dispense_count),
            sales.gross,
            returns.value,
            sales.cash,
            sales.credit,
            body.cashCounted.toFixed(2),
            cashVariance.toFixed(2),
            JSON.stringify(exceptions),
            Number(narcoticChecks.n) > 0,
            ctx.userId,
            body.notes ?? null,
          ],
        );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'pharmacy.pharmacy_day_close',
          rowId: id,
          businessKey: `${counter.code}/${body.businessDate}`,
          dataClass: 'financial',
          before: null,
          after: {
            dispense_count: Number(sales.dispense_count),
            gross_sales: sales.gross,
            cash_variance: cashVariance.toFixed(2),
            exceptions: exceptions.length,
          },
        });

        await this.outbox.publish(
          tx,
          pharmacyEvent('pharmacy.day_close.completed', id, {
            dayCloseId: id,
            pharmacyStoreId: body.pharmacyStoreId,
            businessDate: body.businessDate,
            dispenseCount: Number(sales.dispense_count),
            cashCollected: moneyString(Number(sales.cash)),
            creditValue: moneyString(Number(sales.credit)),
            currency: 'INR',
            exceptionCount: exceptions.length,
            closedBy: ctx.userId,
            closedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.dayCloseById(id);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async saleReturn(id: string): Promise<SaleReturnView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<{
        id: string;
        return_no: string;
        original_dispense_id: string;
        patient_id: string | null;
        status: string;
        reason_code: string;
        refund_amount: string;
      }>(
        `SELECT id, return_no, original_dispense_id, patient_id, status, reason_code,
                refund_amount::text AS refund_amount
           FROM pharmacy.sale_returns WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The return');
      const lines = await tx.rows<{
        id: string;
        dispense_item_id: string;
        item_id: string;
        batch_id: string | null;
        qty_base: string;
        disposition: string;
        refund_amount: string;
      }>(
        `SELECT id, dispense_item_id, item_id, batch_id, qty_base::text AS qty_base, disposition,
                refund_amount::text AS refund_amount
           FROM pharmacy.sale_return_items WHERE sale_return_id = $1 ORDER BY line_no`,
        [id],
      );
      return {
        id: header.id,
        returnNo: header.return_no,
        originalDispenseId: header.original_dispense_id,
        patientId: header.patient_id,
        status: header.status,
        reasonCode: header.reason_code,
        refundAmount: header.refund_amount,
        lines: lines.map((l) => ({
          id: l.id,
          dispenseItemId: l.dispense_item_id,
          itemId: l.item_id,
          batchId: l.batch_id,
          qtyBase: l.qty_base,
          disposition: l.disposition,
          refundAmount: l.refund_amount,
        })),
      };
    });
  }

  async expiryAction(id: string): Promise<ExpiryActionView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<{
        id: string;
        store_id: string;
        item_id: string;
        batch_id: string;
        action: string;
        qty_base: string;
        value_at_cost: string | null;
        reason: string;
        status: string;
        approved_by: string | null;
      }>(
        `SELECT id, store_id, item_id, batch_id, action::text AS action, qty_base::text AS qty_base,
                value_at_cost::text AS value_at_cost, reason, status, approved_by
           FROM pharmacy.expiry_actions WHERE id = $1`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The expiry action');
      return {
        id: row.id,
        storeId: row.store_id,
        itemId: row.item_id,
        batchId: row.batch_id,
        action: row.action,
        qtyBase: row.qty_base,
        valueAtCost: row.value_at_cost,
        reason: row.reason,
        status: row.status,
        approvedBy: row.approved_by,
      };
    });
  }

  async recall(id: string): Promise<RecallView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<RecallRow>(`${RECALL_SQL} WHERE r.id = $1`, [id]);
      if (row === undefined) throw AppError.notFound('The recall');
      return toRecallView(row);
    });
  }

  async recallTrace(id: string): Promise<RecallTraceView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<RecallRow>(`${RECALL_SQL} WHERE r.id = $1`, [id]);
      if (row === undefined) throw AppError.notFound('The recall');

      const traces = await tx.rows<{
        id: string;
        patient_id: string | null;
        dispense_item_id: string | null;
        qty_dispensed_base: string;
        dispensed_at: string | null;
        contacted_at: string | null;
      }>(
        `SELECT id, patient_id, dispense_item_id, qty_dispensed_base::text AS qty_dispensed_base,
                dispensed_at::text AS dispensed_at, contacted_at::text AS contacted_at
           FROM pharmacy.recall_traces WHERE recall_id = $1 ORDER BY dispensed_at DESC NULLS LAST`,
        [id],
      );

      const held = await tx.one<{ qty: string; stores: string }>(
        `SELECT COALESCE(sum(b.qty_on_hand), 0)::text AS qty,
                count(DISTINCT b.store_id)::text AS stores
           FROM inventory.stock_balances b
           JOIN inventory.item_batches ib ON ib.id = b.batch_id
          WHERE ib.item_id = $1 AND ib.batch_no = $2 AND b.qty_on_hand > 0`,
        [row.item_id, row.batch_no],
      );

      return {
        recall: toRecallView(row),
        patients: traces.map((t) => ({
          traceId: t.id,
          patientId: t.patient_id,
          dispenseItemId: t.dispense_item_id,
          qtyDispensedBase: t.qty_dispensed_base,
          dispensedAt: t.dispensed_at === null ? null : new Date(t.dispensed_at).toISOString(),
          contactedAt: t.contacted_at === null ? null : new Date(t.contacted_at).toISOString(),
        })),
        quarantinedQtyBase: held.qty,
        openStoreCount: Number(held.stores),
      };
    });
  }

  async listRecalls(query: RecallQuery): Promise<Page<RecallView>> {
    const hospital = hospitalId();
    const resource = 'pharmacy.recalls';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.status !== undefined) clauses.push(`r.status = ${bind(query.status)}`);
      if (after !== null) {
        clauses.push(`(r.raised_at, r.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      const rows = await tx.rows<RecallRow & { cursor_key: string }>(
        `${RECALL_SQL} ${where} ORDER BY r.raised_at DESC, r.id DESC LIMIT ${bind(limit + 1)}`,
        values,
      );
      const page = this.cursors.keysetPage<RecallRow>(rows, limit, {
        hospitalId: hospital,
        resource,
        direction: 'desc',
      });
      return { items: page.items.map(toRecallView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  async intervention(id: string): Promise<InterventionView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<{
        id: string;
        dispense_id: string | null;
        prescription_id: string | null;
        patient_id: string | null;
        intervention_type: string;
        detail: string;
        outcome: string | null;
        doctor_contacted: boolean;
        pharmacist_user_id: string;
        occurred_at: string;
      }>(
        `SELECT id, dispense_id, prescription_id, patient_id, intervention_type, detail, outcome,
                doctor_contacted, pharmacist_user_id, occurred_at::text AS occurred_at
           FROM pharmacy.pharmacy_interventions WHERE id = $1`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The intervention');
      return {
        id: row.id,
        dispenseId: row.dispense_id,
        prescriptionId: row.prescription_id,
        patientId: row.patient_id,
        interventionType: row.intervention_type,
        detail: row.detail,
        outcome: row.outcome,
        doctorContacted: row.doctor_contacted,
        pharmacistUserId: row.pharmacist_user_id,
        occurredAt: new Date(row.occurred_at).toISOString(),
      };
    });
  }

  async dayCloseById(id: string): Promise<DayCloseView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<DayCloseRow>(`${DAY_CLOSE_SQL} WHERE c.id = $1`, [id]);
      if (row === undefined) throw AppError.notFound('The day close');
      return toDayCloseView(row);
    });
  }

  async listDayCloses(query: DayCloseQuery): Promise<Page<DayCloseView>> {
    const hospital = hospitalId();
    const resource = 'pharmacy.day_close';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId: hospital, resource });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses: string[] = [];
      if (query.pharmacyStoreId !== undefined) {
        clauses.push(`c.pharmacy_store_id = ${bind(query.pharmacyStoreId)}::uuid`);
      }
      if (after !== null) {
        clauses.push(`(c.created_at, c.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
      }
      const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`;
      const rows = await tx.rows<DayCloseRow & { cursor_key: string }>(
        `${DAY_CLOSE_SQL} ${where} ORDER BY c.created_at DESC, c.id DESC LIMIT ${bind(limit + 1)}`,
        values,
      );
      const page = this.cursors.keysetPage<DayCloseRow>(rows, limit, {
        hospitalId: hospital,
        resource,
        direction: 'desc',
      });
      return { items: page.items.map(toDayCloseView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  /** Stock on one counter's shelf, batch by batch. */
  async stock(query: PharmacyStockQuery): Promise<{
    readonly items: readonly {
      readonly itemId: string;
      readonly itemCode: string;
      readonly itemName: string;
      readonly schedule: string;
      readonly batchId: string | null;
      readonly batchNo: string | null;
      readonly expiryDate: string | null;
      readonly qtyOnHand: string;
      readonly mrp: string | null;
    }[];
  }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [query.pharmacyStoreId];
      const bind = binder(values);
      const clauses = [
        'b.store_id = (SELECT store_id FROM pharmacy.pharmacy_stores WHERE id = $1)',
        'b.qty_on_hand > 0',
      ];
      if (query.q !== undefined && query.q.length > 0) {
        clauses.push(
          `(i.code ILIKE ${bind(`%${query.q}%`)} OR i.name ILIKE ${bind(`%${query.q}%`)} OR i.generic_name ILIKE ${bind(`%${query.q}%`)})`,
        );
      }
      if (query.expiringWithin !== undefined) {
        clauses.push(
          `ib.expiry_date IS NOT NULL AND ib.expiry_date <= current_date + ${bind(query.expiringWithin)}::int`,
        );
      }

      const rows = await tx.rows<{
        item_id: string;
        item_code: string;
        item_name: string;
        schedule: string;
        batch_id: string | null;
        batch_no: string | null;
        expiry_date: string | null;
        qty_on_hand: string;
        mrp: string | null;
      }>(
        `SELECT b.item_id, i.code AS item_code, i.name AS item_name, i.schedule::text AS schedule,
                b.batch_id, ib.batch_no, ib.expiry_date::text AS expiry_date,
                b.qty_on_hand::text AS qty_on_hand, ib.mrp::text AS mrp
           FROM inventory.stock_balances b
           JOIN inventory.items i ON i.id = b.item_id
           LEFT JOIN inventory.item_batches ib ON ib.id = b.batch_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY i.name, ib.expiry_date NULLS LAST
          LIMIT ${bind(this.cursors.pageSize(query.limit))}`,
        values,
      );

      return {
        items: rows.map((r) => ({
          itemId: r.item_id,
          itemCode: r.item_code,
          itemName: r.item_name,
          schedule: r.schedule,
          batchId: r.batch_id,
          batchNo: r.batch_no,
          expiryDate: r.expiry_date,
          qtyOnHand: r.qty_on_hand,
          mrp: r.mrp,
        })),
      };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** The exception report the day close carries: what somebody has to look at. */
  private async exceptionsFor(
    tx: TransactionClient,
    storeId: string,
    businessDate: string,
  ): Promise<readonly { kind: string; detail: string; count: number }[]> {
    const negative = await tx.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory.stock_balances
        WHERE store_id = $1 AND qty_on_hand < 0`,
      [storeId],
    );
    const expired = await tx.one<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM inventory.stock_balances b
         JOIN inventory.item_batches ib ON ib.id = b.batch_id
        WHERE b.store_id = $1 AND b.qty_on_hand > 0
          AND ib.expiry_date IS NOT NULL AND ib.expiry_date <= current_date`,
      [storeId],
    );
    const openVariance = await tx.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM pharmacy.narcotic_custody_checks
        WHERE store_id = $1 AND checked_at::date = $2::date AND variance_base <> 0
          AND adjustment_id IS NULL`,
      [storeId, businessDate],
    );
    const integrity = await tx.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM inventory.verify_stock_integrity()
        WHERE store_id = $1`,
      [storeId],
    );

    const out: { kind: string; detail: string; count: number }[] = [];
    if (Number(negative.n) > 0) {
      out.push({
        kind: 'negative_balance',
        detail: 'Positions with a negative balance — something was issued that was not there.',
        count: Number(negative.n),
      });
    }
    if (Number(expired.n) > 0) {
      out.push({
        kind: 'expired_on_shelf',
        detail: 'Expired batches still showing stock. They cannot be dispensed; write them off.',
        count: Number(expired.n),
      });
    }
    if (Number(openVariance.n) > 0) {
      out.push({
        kind: 'narcotic_variance',
        detail: 'Controlled-drug counts that disagree with the register and have not been adjusted.',
        count: Number(openVariance.n),
      });
    }
    if (Number(integrity.n) > 0) {
      out.push({
        kind: 'ledger_balance_mismatch',
        detail:
          'Positions where the ledger sum and the on-hand balance disagree. This is a defect, not data.',
        count: Number(integrity.n),
      });
    }
    return out;
  }
}

const RECALL_SQL = `SELECT r.id, r.recall_no, r.source::text AS source, r.item_id, r.batch_id, r.batch_no,
        r.recall_class, r.reason, r.status, r.patients_identified, r.patients_contacted,
        r.units_returned::text AS units_returned, r.raised_at::text AS raised_at,
        r.closed_at::text AS closed_at, r.raised_at::text AS cursor_key
   FROM pharmacy.recalls r`;

const DAY_CLOSE_SQL = `SELECT c.id, c.pharmacy_store_id, c.business_date::text AS business_date,
        c.shift_label, c.dispense_count, c.gross_sales::text AS gross_sales,
        c.returns_value::text AS returns_value, c.cash_collected::text AS cash_collected,
        c.card_collected::text AS card_collected, c.upi_collected::text AS upi_collected,
        c.credit_value::text AS credit_value, c.cash_counted::text AS cash_counted,
        c.cash_variance::text AS cash_variance, c.stock_exceptions, c.narcotic_checks_done,
        c.status, c.closed_at::text AS closed_at, c.created_at::text AS cursor_key
   FROM pharmacy.pharmacy_day_close c`;

interface RecallRow {
  readonly id: string;
  readonly recall_no: string;
  readonly source: string;
  readonly item_id: string | null;
  readonly batch_id: string | null;
  readonly batch_no: string | null;
  readonly recall_class: string | null;
  readonly reason: string;
  readonly status: string;
  readonly patients_identified: number;
  readonly patients_contacted: number;
  readonly units_returned: string;
  readonly raised_at: string;
  readonly closed_at: string | null;
}

interface DayCloseRow {
  readonly id: string;
  readonly pharmacy_store_id: string;
  readonly business_date: string;
  readonly shift_label: string | null;
  readonly dispense_count: number;
  readonly gross_sales: string;
  readonly returns_value: string;
  readonly cash_collected: string;
  readonly card_collected: string;
  readonly upi_collected: string;
  readonly credit_value: string;
  readonly cash_counted: string;
  readonly cash_variance: string;
  readonly stock_exceptions: unknown;
  readonly narcotic_checks_done: boolean;
  readonly status: string;
  readonly closed_at: string | null;
}

function toRecallView(row: RecallRow): RecallView {
  return {
    id: row.id,
    recallNo: row.recall_no,
    source: row.source,
    itemId: row.item_id,
    batchId: row.batch_id,
    batchNo: row.batch_no,
    recallClass: row.recall_class,
    reason: row.reason,
    status: row.status,
    patientsIdentified: row.patients_identified,
    patientsContacted: row.patients_contacted,
    unitsReturned: row.units_returned,
    raisedAt: new Date(row.raised_at).toISOString(),
    closedAt: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
  };
}

function toDayCloseView(row: DayCloseRow): DayCloseView {
  const exceptions: { kind: string; detail: string; count: number }[] = [];
  if (Array.isArray(row.stock_exceptions)) {
    for (const entry of row.stock_exceptions) {
      if (typeof entry !== 'object' || entry === null) continue;
      const record = entry as Record<string, unknown>;
      exceptions.push({
        kind: typeof record.kind === 'string' ? record.kind : '',
        detail: typeof record.detail === 'string' ? record.detail : '',
        count: typeof record.count === 'number' ? record.count : 0,
      });
    }
  }
  return {
    id: row.id,
    pharmacyStoreId: row.pharmacy_store_id,
    businessDate: row.business_date,
    shiftLabel: row.shift_label,
    dispenseCount: row.dispense_count,
    grossSales: row.gross_sales,
    returnsValue: row.returns_value,
    cashCollected: row.cash_collected,
    cardCollected: row.card_collected,
    upiCollected: row.upi_collected,
    creditValue: row.credit_value,
    cashCounted: row.cash_counted,
    cashVariance: row.cash_variance,
    narcoticChecksDone: row.narcotic_checks_done,
    stockExceptions: exceptions,
    status: row.status,
    closedAt: row.closed_at === null ? null : new Date(row.closed_at).toISOString(),
  };
}
