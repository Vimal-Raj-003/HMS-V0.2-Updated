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
  ConsignmentAgreementRequest,
  ConsignmentReceiptRequest,
  ConsignmentReconciliationRequest,
  ConsignmentReturnRequest,
  ConsignmentUsageQuery,
  ConsignmentUsageRequest,
  ReverseRequest,
  SignReconciliationRequest,
} from './inventory.schemas.js';
import type { DocumentView } from './inventory.types.js';
import { StockLedgerService } from './stock-ledger.service.js';
import { UomService } from './uom.service.js';
import { VendorsService } from './vendors.service.js';

/**
 * NC-007 — consignment stock and implants.
 *
 * ── The one thing that must never be true ───────────────────────────────────
 *
 * Consignment stock is the **vendor's** until it is used. If a single ledger row
 * for it carries `is_consignment = false`, the month-end valuation books the
 * vendor's implants as our asset. `inventory.enforce_consignment_flag` refuses
 * that row, and `StockLedgerService` reads the flag from the batch rather than
 * accepting it from a caller, so there is nothing to disagree with. The batches
 * this service creates are stamped `is_consignment = true` at receipt and cannot
 * be created any other way.
 *
 * ── Usage is one atomic act with four consequences ──────────────────────────
 *
 * `phase-04` exit gate 7: "Consignment implant used → auto-PO raised → vendor
 * reconciliation statement correct." A scan at the OT table has to produce the
 * ledger movement, the replenishment order, the charge intent and the implant
 * traceability record — or none of them. They are in one transaction for that
 * reason. `csn_usages_used_names_patient` makes the traceability half
 * unskippable: a consignment item recorded as used names the patient it went
 * into, permanently.
 *
 * ── Reversal, never deletion ────────────────────────────────────────────────
 *
 * The wrong serial gets scanned. `csn_usages_reversal_documented` requires the
 * reversal to name what it reverses and say why, and the compensating ledger
 * entry is `StockLedgerService.correct()` — because the original movement cannot
 * be edited either.
 *
 * ── Billing ─────────────────────────────────────────────────────────────────
 *
 * `charge_intent_id` is left null and `billed_amount` carries the agreed vendor
 * price. Phase 5 owns the tariff engine and the charge intent; recording a
 * charge here would be inventing a price the billing module has not agreed to.
 * The column and the price snapshot travel so Phase 5 has what it needs.
 */
@Injectable()
export class ConsignmentService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(StockLedgerService) private readonly ledger: StockLedgerService,
    @Inject(UomService) private readonly uoms: UomService,
    @Inject(VendorsService) private readonly vendors: VendorsService,
  ) {}

  // ── agreements ───────────────────────────────────────────────────────────

  async createAgreement(body: ConsignmentAgreementRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        await this.vendors.assertPurchasable(tx, body.vendorId);

        await tx.query(
          `INSERT INTO inventory.csn_agreements
             (id, hospital_id, branch_id, vendor_id, agreement_no, start_date, end_date,
              invoicing_cycle, payment_terms_days, expiry_return_days_before, wastage_policy,
              replenishment_sla_days, status, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7::date,
                   $8::inventory."CsnInvoicingCycle", $9, $10, $11, $12,
                   'draft'::inventory."CsnAgreementStatus", $13, $13, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            body.vendorId,
            body.agreementNo,
            body.startDate,
            body.endDate,
            body.invoicingCycle,
            body.paymentTermsDays,
            body.expiryReturnDaysBefore,
            body.wastagePolicy,
            body.replenishmentSlaDays,
            ctx.userId,
          ],
        );

        for (const item of body.items) {
          const facts = await this.uoms.item(tx, item.itemId);
          if (!facts.is_consignment_allowed) {
            throw new AppError(
              ProblemType.BUSINESS_RULE_VIOLATED,
              `${facts.code} is not marked as available on consignment in the item master. Consignment changes who owns the stock, so it is an item-master decision rather than an agreement one.`,
            );
          }
          await tx.query(
            `INSERT INTO inventory.csn_agreement_items
               (id, hospital_id, agreement_id, item_id, udi_di, gtin, vendor_price, mrp, gst_rate,
                min_stock_base, price_valid_from, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9::numeric, $10::numeric,
                     $11::date, $12, $12, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              item.itemId,
              item.udiDi ?? null,
              item.gtin ?? null,
              item.vendorPrice,
              item.mrp ?? null,
              item.gstRate,
              item.minStockBase,
              item.priceValidFrom ?? body.startDate,
              ctx.userId,
            ],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.csn_agreements',
          rowId: id,
          businessKey: body.agreementNo,
          dataClass: 'financial',
          before: null,
          after: { vendor_id: body.vendorId, items: body.items.length },
        });
      }),
    );

    return this.agreement(id);
  }

  async approveAgreement(id: string): Promise<DocumentView> {
    const ctx = getContext();
    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{
          status: string;
          agreement_no: string;
          vendor_id: string;
          start_date: string;
          end_date: string;
          invoicing_cycle: string;
          created_by: string | null;
        }>(
          `SELECT status::text AS status, agreement_no, vendor_id, start_date::text AS start_date,
                  end_date::text AS end_date, invoicing_cycle::text AS invoicing_cycle, created_by
             FROM inventory.csn_agreements WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The consignment agreement');
        assertStatus('This agreement', header.status, ['draft', 'pending_approval'], 'activated');
        if (header.created_by !== null && header.created_by === ctx.userId) {
          throw new AppError(
            ProblemType.SEGREGATION_OF_DUTIES,
            'The person who drafted a consignment agreement cannot be the one who activates it.',
          );
        }

        const itemCount = await tx.one<{ n: string }>(
          `SELECT count(*)::text AS n FROM inventory.csn_agreement_items WHERE agreement_id = $1`,
          [id],
        );

        await tx.query(
          `UPDATE inventory.csn_agreements
              SET status = 'active'::inventory."CsnAgreementStatus", approved_by = $2,
                  approved_at = now(), updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $1`,
          [id, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.csn_agreements',
          rowId: id,
          businessKey: header.agreement_no,
          dataClass: 'financial',
          before: { status: header.status },
          after: { status: 'active' },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('consignment.agreement.activated', id, {
            agreementId: id,
            agreementNo: header.agreement_no,
            vendorId: header.vendor_id,
            validFrom: header.start_date,
            validTo: header.end_date,
            invoicingCycle: header.invoicing_cycle,
            itemCount: Number(itemCount.n),
            approvedBy: ctx.userId,
          }),
        );
      }),
    );
    return this.agreement(id);
  }

  // ── receipt ──────────────────────────────────────────────────────────────

  /**
   * Consignment stock arriving. The batch is created here, stamped as the
   * vendor's, and the ledger row that follows inherits the flag from it.
   */
  async receive(body: ConsignmentReceiptRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const agreement = await this.liveAgreement(tx, body.agreementId);
        const store = await tx.maybeOne<{ is_consignment: boolean; code: string }>(
          `SELECT is_consignment, code FROM inventory.stores WHERE id = $1 AND deleted_at IS NULL`,
          [body.storeId],
        );
        if (store === undefined) throw AppError.notFound('The store');
        if (!store.is_consignment) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `Store ${store.code} is not a consignment location. The vendor's stock is held separately from ours so that a month-end valuation can tell them apart.`,
          );
        }

        const receiptNo = (
          await this.numbering.allocate(tx, {
            key: 'CSN_IN',
            branchId,
            refType: 'inventory.csn_receipts',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.csn_receipts
             (id, hospital_id, branch_id, receipt_no, agreement_id, vendor_id, store_id,
              challan_no, challan_date, received_by, received_at, status,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, now(), 'received', $10, $10, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            receiptNo,
            body.agreementId,
            agreement.vendor_id,
            body.storeId,
            body.challanNo ?? null,
            body.challanDate ?? null,
            ctx.userId,
          ],
        );

        let lineNo = 1;
        let totalValue = 0;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          const agreed = await this.agreedPrice(tx, body.agreementId, line.itemId);

          const batchId = newId();
          await tx.query(
            `INSERT INTO inventory.item_batches
               (id, hospital_id, item_id, batch_no, expiry_date, mrp, unit_cost, gtin, vendor_id,
                status, is_consignment, consignment_vendor_id, received_at,
                created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5::date, $6::numeric, $7::numeric, $8, $9,
                     'active'::inventory."InvBatchStatus", true, $9, now(), $10, $10, now())`,
            [
              batchId,
              ctx.hospitalId,
              line.itemId,
              line.lotNo,
              line.expiryDate ?? null,
              agreed.mrp,
              agreed.price,
              line.gtin ?? null,
              agreement.vendor_id,
              ctx.userId,
            ],
          );

          let serialId: string | null = null;
          if (line.serialNo !== undefined) {
            serialId = newId();
            await tx.query(
              `INSERT INTO inventory.item_serials
                 (id, hospital_id, item_id, batch_id, serial_no, udi_full, status, current_store_id,
                  created_by, updated_by, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, 'in_stock'::inventory."InvSerialStatus", $7, $8, $8, now())`,
              [
                serialId,
                ctx.hospitalId,
                line.itemId,
                batchId,
                line.serialNo,
                line.udiFull ?? null,
                body.storeId,
                ctx.userId,
              ],
            );
          }

          await tx.query(
            `INSERT INTO inventory.csn_receipt_lines
               (id, hospital_id, receipt_id, line_no, item_id, batch_id, serial_id, gtin, lot_no,
                expiry_date, uom_id, qty_entered, qty_base, vendor_price_snapshot,
                created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12::numeric, $13::numeric,
                     $14::numeric, $15, $15, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              lineNo,
              line.itemId,
              batchId,
              serialId,
              line.gtin ?? null,
              line.lotNo,
              line.expiryDate ?? null,
              converted.uomId,
              converted.qtyEntered,
              converted.qtyBase,
              agreed.price,
              ctx.userId,
            ],
          );

          await this.ledger.post(tx, {
            storeId: body.storeId,
            branchId,
            itemId: line.itemId,
            batchId,
            serialId,
            movementType: 'consignment_in',
            qtyEntered: converted.qtyEntered,
            uomId: converted.uomId,
            unitCost: agreed.price,
            refType: 'consignment_receipt',
            refId: id,
          });

          totalValue += agreed.price * Number(converted.qtyBase);
          lineNo += 1;
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.csn_receipts',
          rowId: id,
          businessKey: receiptNo,
          dataClass: 'financial',
          before: null,
          after: { vendor_id: agreement.vendor_id, lines: body.lines.length },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('consignment.stock.received', id, {
            receiptId: id,
            receiptNo,
            agreementId: body.agreementId,
            vendorId: agreement.vendor_id,
            storeId: body.storeId,
            lineCount: body.lines.length,
            value: moneyString(totalValue),
            currency: 'INR',
            receivedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.receipt(id);
  }

  // ── usage ────────────────────────────────────────────────────────────────

  /**
   * The scan at the table. `phase-04` exit gate 7 runs through here.
   *
   * Everything is one transaction: the ledger movement out of consignment stock,
   * the usage record with the patient and the serial, and — for a `per_usage`
   * agreement — the replenishment order to the vendor. A partial success would
   * mean an implant in a patient with no order to replace it, or an order for an
   * implant nobody used.
   */
  async recordUsage(body: ConsignmentUsageRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const agreement = await this.liveAgreement(tx, body.agreementId);
        if (body.status === 'used' && body.patientId === undefined) {
          throw new AppError(
            ProblemType.VALIDATION_FAILED,
            'A consignment item recorded as used names the patient it was used on. Implant traceability is permanent and starts here.',
          );
        }
        if (body.patientId !== undefined) await assertPatientVisible(tx, body.patientId);

        const item = await this.uoms.item(tx, body.itemId);
        const converted = await this.uoms.toBase(tx, item, body.uomId, body.qtyEntered);
        const agreed = await this.agreedPrice(tx, body.agreementId, body.itemId);

        const usageNo = (
          await this.numbering.allocate(tx, {
            key: 'CSN_IN',
            branchId,
            refType: 'inventory.csn_usages',
            refId: id,
          })
        ).formatted;

        const posted = await this.ledger.post(tx, {
          storeId: body.storeId,
          branchId,
          itemId: body.itemId,
          batchId: body.batchId,
          serialId: body.serialId ?? null,
          movementType: 'consignment_used',
          qtyEntered: converted.qtyEntered,
          uomId: converted.uomId,
          unitCost: agreed.price,
          refType: 'consignment_usage',
          refId: id,
          patientId: body.patientId ?? null,
          encounterId: body.encounterId ?? null,
          reason: body.status === 'wasted' ? body.wasteReason : null,
        });

        await tx.query(
          `INSERT INTO inventory.csn_usages
             (id, hospital_id, branch_id, usage_no, agreement_id, vendor_id, store_id, item_id,
              batch_id, serial_id, uom_id, qty_entered, qty_base, patient_id, encounter_id,
              surgeon_user_id, scanned_by, scanned_at, side, site, status, waste_reason,
              waste_liability, billed_amount, vendor_price_snapshot, ledger_id,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   $9, $10, $11, $12::numeric, $13::numeric, $14, $15,
                   $16, $17, now(), $18, $19, $20::inventory."CsnUsageStatus", $21,
                   $22::inventory."CsnLiability", $23::numeric, $24::numeric, $25,
                   $17, $17, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            usageNo,
            body.agreementId,
            agreement.vendor_id,
            body.storeId,
            body.itemId,
            body.batchId,
            body.serialId ?? null,
            converted.uomId,
            converted.qtyEntered,
            converted.qtyBase,
            body.patientId ?? null,
            body.encounterId ?? null,
            body.surgeonUserId ?? null,
            ctx.userId,
            body.side ?? null,
            body.site ?? null,
            body.status,
            body.status === 'wasted' ? body.wasteReason : null,
            body.wasteLiability,
            (agreed.price * Number(converted.qtyBase)).toFixed(2),
            agreed.price,
            posted.ledgerId,
          ],
        );

        if (body.serialId !== undefined) {
          await tx.query(
            `UPDATE inventory.item_serials
                SET status = 'used'::inventory."InvSerialStatus", patient_id = $2,
                    usage_ref_type = 'csn_usage', usage_ref_id = $3, used_at = now(),
                    updated_at = now(), updated_by = $4
              WHERE id = $1`,
            [body.serialId, body.patientId ?? null, id, ctx.userId],
          );
        }

        const serial =
          body.serialId === undefined
            ? undefined
            : await tx.maybeOne<{ serial_no: string; udi_full: string | null }>(
                `SELECT serial_no, udi_full FROM inventory.item_serials WHERE id = $1`,
                [body.serialId],
              );

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.csn_usages',
          rowId: id,
          businessKey: usageNo,
          dataClass: 'phi',
          patientId: body.patientId ?? null,
          encounterId: body.encounterId ?? null,
          before: null,
          after: {
            item_id: body.itemId,
            batch_id: body.batchId,
            status: body.status,
            serial_no: serial?.serial_no ?? null,
          },
        });

        if (body.status === 'used' && body.patientId !== undefined) {
          await this.outbox.publish(
            tx,
            inventoryEvent('consignment.usage.recorded', id, {
              usageId: id,
              usageNo,
              agreementId: body.agreementId,
              vendorId: agreement.vendor_id,
              patientId: body.patientId,
              encounterId: body.encounterId ?? null,
              itemId: body.itemId,
              batchId: body.batchId,
              serialNo: serial?.serial_no ?? null,
              udiFull: serial?.udi_full ?? null,
              qtyBase: quantityString(Number(converted.qtyBase)),
              unitPrice: moneyString(agreed.price),
              currency: 'INR',
              surgeonUserId: body.surgeonUserId ?? null,
              usedAt: new Date().toISOString(),
            }),
          );
        } else {
          await this.outbox.publish(
            tx,
            inventoryEvent('consignment.usage.wasted', id, {
              usageId: id,
              agreementId: body.agreementId,
              vendorId: agreement.vendor_id,
              itemId: body.itemId,
              qtyBase: quantityString(Number(converted.qtyBase)),
              value: moneyString(agreed.price * Number(converted.qtyBase)),
              currency: 'INR',
              reason: body.wasteReason ?? '',
              liability: body.wasteLiability,
              approvedBy: ctx.userId,
              recordedAt: new Date().toISOString(),
            }),
          );
        }

        await this.replenish(
          tx,
          agreement,
          id,
          body.itemId,
          converted.qtyEntered,
          converted.uomId,
          agreed.price,
        );
      }),
    );

    return this.usage(id);
  }

  async reverseUsage(id: string, body: ReverseRequest): Promise<DocumentView> {
    const ctx = getContext();
    const reversalId = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const original = await tx.maybeOne<{
          id: string;
          usage_no: string;
          status: string;
          agreement_id: string;
          vendor_id: string;
          store_id: string;
          branch_id: string;
          item_id: string;
          batch_id: string | null;
          serial_id: string | null;
          uom_id: string;
          qty_entered: string;
          qty_base: string;
          patient_id: string | null;
          vendor_price_snapshot: string;
          ledger_id: string | null;
        }>(
          `SELECT id, usage_no, status::text AS status, agreement_id, vendor_id, store_id, branch_id,
                  item_id, batch_id, serial_id, uom_id, qty_entered::text AS qty_entered,
                  qty_base::text AS qty_base, patient_id,
                  vendor_price_snapshot::text AS vendor_price_snapshot, ledger_id
             FROM inventory.csn_usages WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (original === undefined) throw AppError.notFound('The consignment usage');
        if (original.status === 'reversed') {
          throw new AppError(ProblemType.ALREADY_DECIDED, 'This usage has already been reversed.');
        }
        if (original.ledger_id === null) {
          throw new AppError(
            ProblemType.CONFLICT,
            'This usage has no ledger movement to compensate, so it cannot be reversed.',
          );
        }

        await this.ledger.correct(tx, original.ledger_id, {
          qtyEntered: original.qty_entered,
          direction: 'in',
          reason: `Consignment usage ${original.usage_no} reversed: ${body.reason}`,
        });

        const usageNo = (
          await this.numbering.allocate(tx, {
            key: 'CSN_IN',
            branchId: original.branch_id,
            refType: 'inventory.csn_usages',
            refId: reversalId,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.csn_usages
             (id, hospital_id, branch_id, usage_no, agreement_id, vendor_id, store_id, item_id,
              batch_id, serial_id, uom_id, qty_entered, qty_base, patient_id, scanned_by,
              scanned_at, status, reversal_of, reversed_reason, vendor_price_snapshot,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                   $9, $10, $11, $12::numeric, $13::numeric, $14, $15,
                   now(), 'reversed'::inventory."CsnUsageStatus", $16, $17, $18::numeric,
                   $15, $15, now())`,
          [
            reversalId,
            ctx.hospitalId,
            original.branch_id,
            usageNo,
            original.agreement_id,
            original.vendor_id,
            original.store_id,
            original.item_id,
            original.batch_id,
            original.serial_id,
            original.uom_id,
            original.qty_entered,
            original.qty_base,
            original.patient_id,
            ctx.userId,
            id,
            body.reason,
            original.vendor_price_snapshot,
          ],
        );

        if (original.serial_id !== null) {
          await tx.query(
            `UPDATE inventory.item_serials
                SET status = 'in_stock'::inventory."InvSerialStatus", patient_id = NULL,
                    usage_ref_type = NULL, usage_ref_id = NULL, used_at = NULL,
                    updated_at = now(), updated_by = $2
              WHERE id = $1`,
            [original.serial_id, ctx.userId],
          );
        }

        await this.audit.write(tx, {
          action: 'update',
          entity: 'inventory.csn_usages',
          rowId: reversalId,
          businessKey: usageNo,
          dataClass: 'phi',
          patientId: original.patient_id,
          reasonText: body.reason,
          before: { usage_no: original.usage_no, status: original.status },
          after: { status: 'reversed', reversal_of: id },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('consignment.usage.reversed', reversalId, {
            usageId: reversalId,
            reversalOf: id,
            patientId: original.patient_id ?? reversalId,
            reason: body.reason,
            reversedBy: ctx.userId,
            reversedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.usage(reversalId);
  }

  // ── returns ──────────────────────────────────────────────────────────────

  async createReturn(body: ConsignmentReturnRequest): Promise<DocumentView> {
    const ctx = getContext();
    const branchId = requireBranch();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const returnNo = (
          await this.numbering.allocate(tx, {
            key: 'CSN_IN',
            branchId,
            refType: 'inventory.csn_returns',
            refId: id,
          })
        ).formatted;

        await tx.query(
          `INSERT INTO inventory.csn_returns
             (id, hospital_id, branch_id, return_no, vendor_id, agreement_id, store_id, reason,
              status, dispatched_at, created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'dispatched', now(), $9, $9, now())`,
          [
            id,
            ctx.hospitalId,
            branchId,
            returnNo,
            body.vendorId,
            body.agreementId,
            body.storeId,
            body.reason,
            ctx.userId,
          ],
        );

        let lineNo = 1;
        let totalValue = 0;
        for (const line of body.lines) {
          const item = await this.uoms.item(tx, line.itemId);
          const converted = await this.uoms.toBase(tx, item, line.uomId, line.qtyEntered);
          const agreed = await this.agreedPrice(tx, body.agreementId, line.itemId);

          await tx.query(
            `INSERT INTO inventory.csn_return_lines
               (id, hospital_id, return_id, line_no, item_id, batch_id, uom_id, qty_entered,
                qty_base, value, created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::numeric, $11, $11, now())`,
            [
              newId(),
              ctx.hospitalId,
              id,
              lineNo,
              line.itemId,
              line.batchId,
              converted.uomId,
              converted.qtyEntered,
              converted.qtyBase,
              (agreed.price * Number(converted.qtyBase)).toFixed(2),
              ctx.userId,
            ],
          );

          await this.ledger.post(tx, {
            storeId: body.storeId,
            branchId,
            itemId: line.itemId,
            batchId: line.batchId,
            movementType: 'consignment_return',
            qtyEntered: converted.qtyEntered,
            uomId: converted.uomId,
            unitCost: agreed.price,
            refType: 'consignment_return',
            refId: id,
            reason: `Consignment return: ${body.reason}`,
          });

          await tx.query(
            `UPDATE inventory.item_batches
                SET status = 'returned_to_vendor'::inventory."InvBatchStatus", updated_at = now(),
                    updated_by = $2, version = version + 1
              WHERE id = $1
                AND NOT EXISTS (SELECT 1 FROM inventory.stock_balances sb
                                 WHERE sb.batch_id = $1 AND sb.qty_on_hand > 0)`,
            [line.batchId, ctx.userId],
          );

          totalValue += agreed.price * Number(converted.qtyBase);
          lineNo += 1;
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.csn_returns',
          rowId: id,
          businessKey: returnNo,
          dataClass: 'financial',
          before: null,
          after: { vendor_id: body.vendorId, reason: body.reason, lines: body.lines.length },
        });

        await this.outbox.publish(
          tx,
          inventoryEvent('consignment.return.dispatched', id, {
            returnId: id,
            returnNo,
            agreementId: body.agreementId,
            vendorId: body.vendorId,
            lineCount: body.lines.length,
            value: moneyString(totalValue),
            currency: 'INR',
            reason: body.reason,
            dispatchedAt: new Date().toISOString(),
          }),
        );
      }),
    );

    return this.consignmentReturn(id);
  }

  // ── reconciliation ───────────────────────────────────────────────────────

  /**
   * The monthly statement: everything received, used, wasted and returned in the
   * period, priced at the agreed price snapshotted on each row.
   *
   * Built from the usage rows rather than recomputed from the ledger, because
   * the price is a fact about the agreement on the day, and a recomputation at
   * today's price would restate a month the vendor has already invoiced.
   */
  async reconcile(body: ConsignmentReconciliationRequest): Promise<DocumentView> {
    const ctx = getContext();
    const id = newId();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const usages = await tx.rows<{
          item_id: string;
          item_code: string;
          qty: string;
          value: string;
          status: string;
        }>(
          `SELECT u.item_id, i.code AS item_code, sum(u.qty_base)::text AS qty,
                  sum(u.qty_base * u.vendor_price_snapshot)::text AS value, u.status::text AS status
             FROM inventory.csn_usages u
             JOIN inventory.items i ON i.id = u.item_id
            WHERE u.agreement_id = $1
              AND to_char(u.scanned_at, 'YYYY-MM') = $2
              AND u.status <> 'reversed'
              AND NOT EXISTS (SELECT 1 FROM inventory.csn_usages r WHERE r.reversal_of = u.id)
            GROUP BY u.item_id, i.code, u.status`,
          [body.agreementId, body.period],
        );

        const total = usages.reduce((sum, row) => sum + Number(row.value), 0);
        const statement = {
          period: body.period,
          lines: usages.map((u) => ({
            itemId: u.item_id,
            itemCode: u.item_code,
            status: u.status,
            qtyBase: u.qty,
            value: u.value,
          })),
          total: total.toFixed(2),
        };

        await tx.query(
          `INSERT INTO inventory.csn_reconciliations
             (id, hospital_id, vendor_id, agreement_id, period, system_statement, status,
              created_by, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'matching'::inventory."CsnReconStatus", $7, $7, now())`,
          [
            id,
            ctx.hospitalId,
            body.vendorId,
            body.agreementId,
            body.period,
            JSON.stringify(statement),
            ctx.userId,
          ],
        );

        for (const line of usages) {
          await tx.query(
            `INSERT INTO inventory.csn_reconciliation_lines
               (id, hospital_id, reconciliation_id, item_id, source, system_qty_base, system_price,
                created_by, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, 'system', $5::numeric, $6::numeric, $7, $7, now())`,
            [newId(), ctx.hospitalId, id, line.item_id, line.qty, line.value, ctx.userId],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'inventory.csn_reconciliations',
          rowId: id,
          businessKey: `${body.period}/${body.vendorId}`,
          dataClass: 'financial',
          before: null,
          after: { period: body.period, lines: usages.length, total: total.toFixed(2) },
        });
      }),
    );

    return this.reconciliation(id);
  }

  async signReconciliation(id: string, body: SignReconciliationRequest): Promise<DocumentView> {
    const ctx = getContext();

    await withInventoryErrors(async () =>
      this.db.withTenant(currentTenantContext(), async (tx) => {
        const header = await tx.maybeOne<{
          status: string;
          vendor_id: string;
          agreement_id: string | null;
          period: string;
          system_statement: unknown;
        }>(
          `SELECT status::text AS status, vendor_id, agreement_id, period, system_statement
             FROM inventory.csn_reconciliations WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (header === undefined) throw AppError.notFound('The reconciliation');
        assertStatus('This reconciliation', header.status, ['draft', 'matching', 'disputed'], 'signed');

        const total = Number((header.system_statement as { total?: unknown } | null)?.total ?? 0);

        await tx.query(
          `UPDATE inventory.csn_reconciliations
              SET status = $2::inventory."CsnReconStatus",
                  hospital_signed_by = $3, hospital_signed_at = now(),
                  vendor_signed_by = $4, vendor_signed_at = now(),
                  difference_value = COALESCE(difference_value, 0),
                  updated_at = now(), updated_by = $3, version = version + 1
            WHERE id = $1`,
          [id, body.agreed ? 'signed' : 'disputed', ctx.userId, body.vendorSignedBy],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'inventory.csn_reconciliations',
          rowId: id,
          businessKey: header.period,
          dataClass: 'financial',
          reasonText: body.note ?? null,
          before: { status: header.status },
          after: { status: body.agreed ? 'signed' : 'disputed' },
        });

        if (body.agreed) {
          await this.outbox.publish(
            tx,
            inventoryEvent('consignment.reconciliation.signed', id, {
              reconciliationId: id,
              agreementId: header.agreement_id ?? id,
              vendorId: header.vendor_id,
              period: header.period,
              agreedValue: moneyString(total),
              currency: 'INR',
              hospitalSignedBy: ctx.userId ?? id,
              vendorSignedAt: new Date().toISOString(),
              signedAt: new Date().toISOString(),
            }),
          );
        } else {
          const openLines = await tx.one<{ n: string }>(
            `SELECT count(*)::text AS n FROM inventory.csn_reconciliation_lines
              WHERE reconciliation_id = $1 AND resolution = 'pending'`,
            [id],
          );
          await this.outbox.publish(
            tx,
            inventoryEvent('consignment.reconciliation.disputed', id, {
              reconciliationId: id,
              agreementId: header.agreement_id ?? id,
              vendorId: header.vendor_id,
              period: header.period,
              openLines: Math.max(1, Number(openLines.n)),
              disputedValue: moneyString(total),
              currency: 'INR',
              raisedAt: new Date().toISOString(),
            }),
          );
        }
      }),
    );

    return this.reconciliation(id);
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async agreement(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<{
        id: string;
        agreement_no: string;
        status: string;
        vendor_id: string;
        start_date: string;
        end_date: string;
        invoicing_cycle: string;
        created_at: string;
      }>(
        `SELECT id, agreement_no, status::text AS status, vendor_id, start_date::text AS start_date,
                end_date::text AS end_date, invoicing_cycle::text AS invoicing_cycle,
                created_at::text AS created_at
           FROM inventory.csn_agreements WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The consignment agreement');

      const rows = await tx.rows<{
        id: string;
        item_id: string;
        item_code: string;
        item_name: string;
        vendor_price: string;
        min_stock_base: string;
        udi_di: string | null;
      }>(
        `SELECT a.id, a.item_id, i.code AS item_code, i.name AS item_name,
                a.vendor_price::text AS vendor_price, a.min_stock_base::text AS min_stock_base, a.udi_di
           FROM inventory.csn_agreement_items a
           JOIN inventory.items i ON i.id = a.item_id
          WHERE a.agreement_id = $1 AND a.active
          ORDER BY i.code`,
        [id],
      );

      return {
        id: header.id,
        documentNo: header.agreement_no,
        status: header.status,
        storeId: null,
        counterpartyId: header.vendor_id,
        createdAt: new Date(header.created_at).toISOString(),
        lines: rows.map((r, index) => ({
          id: r.id,
          lineNo: index + 1,
          itemId: r.item_id,
          itemCode: r.item_code,
          itemName: r.item_name,
          batchId: null,
          batchNo: null,
          uomId: '',
          qtyEntered: r.min_stock_base,
          qtyBase: r.min_stock_base,
          status: null,
          extra: { vendorPrice: r.vendor_price, udiDi: r.udi_di },
        })),
        header: {
          startDate: header.start_date,
          endDate: header.end_date,
          invoicingCycle: header.invoicing_cycle,
        },
      };
    });
  }

  async receipt(id: string): Promise<DocumentView> {
    return this.simpleDocument(
      id,
      `SELECT id, receipt_no AS document_no, status, store_id, vendor_id AS counterparty_id,
              created_at::text AS created_at, agreement_id
         FROM inventory.csn_receipts WHERE id = $1`,
      `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name, l.batch_id,
              b.batch_no, l.uom_id, l.qty_entered::text AS qty_entered, l.qty_base::text AS qty_base,
              l.lot_no, l.expiry_date::text AS expiry_date,
              l.vendor_price_snapshot::text AS vendor_price_snapshot
         FROM inventory.csn_receipt_lines l
         JOIN inventory.items i ON i.id = l.item_id
         LEFT JOIN inventory.item_batches b ON b.id = l.batch_id
        WHERE l.receipt_id = $1 ORDER BY l.line_no`,
      'The consignment receipt',
    );
  }

  async consignmentReturn(id: string): Promise<DocumentView> {
    return this.simpleDocument(
      id,
      `SELECT id, return_no AS document_no, status, store_id, vendor_id AS counterparty_id,
              created_at::text AS created_at, reason
         FROM inventory.csn_returns WHERE id = $1`,
      `SELECT l.id, l.line_no, l.item_id, i.code AS item_code, i.name AS item_name, l.batch_id,
              b.batch_no, l.uom_id, l.qty_entered::text AS qty_entered, l.qty_base::text AS qty_base,
              l.value::text AS value
         FROM inventory.csn_return_lines l
         JOIN inventory.items i ON i.id = l.item_id
         LEFT JOIN inventory.item_batches b ON b.id = l.batch_id
        WHERE l.return_id = $1 ORDER BY l.line_no`,
      'The consignment return',
    );
  }

  async usage(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const row = await tx.maybeOne<{
        id: string;
        usage_no: string;
        status: string;
        store_id: string;
        vendor_id: string;
        item_id: string;
        item_code: string;
        item_name: string;
        batch_id: string | null;
        batch_no: string | null;
        serial_no: string | null;
        uom_id: string;
        qty_entered: string;
        qty_base: string;
        patient_id: string | null;
        billed_amount: string | null;
        auto_po_id: string | null;
        reversal_of: string | null;
        created_at: string;
      }>(
        `SELECT u.id, u.usage_no, u.status::text AS status, u.store_id, u.vendor_id, u.item_id,
                i.code AS item_code, i.name AS item_name, u.batch_id, b.batch_no, s.serial_no,
                u.uom_id, u.qty_entered::text AS qty_entered, u.qty_base::text AS qty_base,
                u.patient_id, u.billed_amount::text AS billed_amount, u.auto_po_id, u.reversal_of,
                u.created_at::text AS created_at
           FROM inventory.csn_usages u
           JOIN inventory.items i ON i.id = u.item_id
           LEFT JOIN inventory.item_batches b ON b.id = u.batch_id
           LEFT JOIN inventory.item_serials s ON s.id = u.serial_id
          WHERE u.id = $1`,
        [id],
      );
      if (row === undefined) throw AppError.notFound('The consignment usage');

      return {
        id: row.id,
        documentNo: row.usage_no,
        status: row.status,
        storeId: row.store_id,
        counterpartyId: row.vendor_id,
        createdAt: new Date(row.created_at).toISOString(),
        lines: [
          {
            id: row.id,
            lineNo: 1,
            itemId: row.item_id,
            itemCode: row.item_code,
            itemName: row.item_name,
            batchId: row.batch_id,
            batchNo: row.batch_no,
            uomId: row.uom_id,
            qtyEntered: row.qty_entered,
            qtyBase: row.qty_base,
            status: row.status,
            extra: { serialNo: row.serial_no, billedAmount: row.billed_amount },
          },
        ],
        header: {
          patientId: row.patient_id,
          autoPoId: row.auto_po_id,
          reversalOf: row.reversal_of,
        },
      };
    });
  }

  async reconciliation(id: string): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<{
        id: string;
        period: string;
        status: string;
        vendor_id: string;
        difference_value: string | null;
        system_statement: unknown;
        created_at: string;
      }>(
        `SELECT id, period, status::text AS status, vendor_id,
                difference_value::text AS difference_value, system_statement,
                created_at::text AS created_at
           FROM inventory.csn_reconciliations WHERE id = $1`,
        [id],
      );
      if (header === undefined) throw AppError.notFound('The reconciliation');

      const rows = await tx.rows<{
        id: string;
        item_id: string | null;
        item_code: string | null;
        item_name: string | null;
        system_qty_base: string;
        system_price: string | null;
        vendor_qty: string;
        difference: string;
        resolution: string;
      }>(
        `SELECT l.id, l.item_id, i.code AS item_code, i.name AS item_name,
                l.system_qty_base::text AS system_qty_base, l.system_price::text AS system_price,
                l.vendor_qty::text AS vendor_qty, l.difference::text AS difference, l.resolution
           FROM inventory.csn_reconciliation_lines l
           LEFT JOIN inventory.items i ON i.id = l.item_id
          WHERE l.reconciliation_id = $1
          ORDER BY i.code NULLS LAST`,
        [id],
      );

      const statement = header.system_statement as { total?: unknown } | null;
      return {
        id: header.id,
        documentNo: header.period,
        status: header.status,
        storeId: null,
        counterpartyId: header.vendor_id,
        createdAt: new Date(header.created_at).toISOString(),
        lines: rows.map((r, index) => ({
          id: r.id,
          lineNo: index + 1,
          itemId: r.item_id ?? '',
          itemCode: r.item_code ?? '',
          itemName: r.item_name ?? '',
          batchId: null,
          batchNo: null,
          uomId: '',
          qtyEntered: r.system_qty_base,
          qtyBase: r.system_qty_base,
          status: r.resolution,
          extra: {
            systemPrice: r.system_price,
            vendorQty: r.vendor_qty,
            difference: r.difference,
          },
        })),
        header: {
          differenceValue: header.difference_value,
          statementTotal: typeof statement?.total === 'string' ? statement.total : null,
        },
      };
    });
  }

  async listAgreements(query: {
    readonly cursor?: string | undefined;
    readonly limit: number;
  }): Promise<Page<DocumentView>> {
    return this.page(
      'inventory.csn_agreements',
      `SELECT d.id, d.created_at::text AS cursor_key FROM inventory.csn_agreements d`,
      query,
      (id) => this.agreement(id),
      () => undefined,
    );
  }

  async listUsages(query: ConsignmentUsageQuery): Promise<Page<DocumentView>> {
    return this.page(
      'inventory.csn_usages',
      `SELECT d.id, d.created_at::text AS cursor_key FROM inventory.csn_usages d`,
      query,
      (id) => this.usage(id),
      (bind, clauses) => {
        if (query.agreementId !== undefined)
          clauses.push(`d.agreement_id = ${bind(query.agreementId)}::uuid`);
        if (query.vendorId !== undefined) clauses.push(`d.vendor_id = ${bind(query.vendorId)}::uuid`);
        if (query.patientId !== undefined) clauses.push(`d.patient_id = ${bind(query.patientId)}::uuid`);
        if (query.status !== undefined) clauses.push(`d.status::text = ${bind(query.status)}`);
      },
    );
  }

  /** Consignment stock on our shelves, which is not ours. */
  async stock(storeId?: string): Promise<{
    readonly items: readonly {
      readonly storeId: string;
      readonly itemId: string;
      readonly itemCode: string;
      readonly batchId: string | null;
      readonly batchNo: string | null;
      readonly expiryDate: string | null;
      readonly qtyOnHand: string;
      readonly vendorId: string | null;
      readonly value: string;
    }[];
  }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const values: unknown[] = [];
      const bind = binder(values);
      const clauses = ['b.is_consignment', 'b.qty_on_hand > 0'];
      if (storeId !== undefined) clauses.push(`b.store_id = ${bind(storeId)}::uuid`);

      const rows = await tx.rows<{
        store_id: string;
        item_id: string;
        item_code: string;
        batch_id: string | null;
        batch_no: string | null;
        expiry_date: string | null;
        qty_on_hand: string;
        vendor_id: string | null;
        value: string;
      }>(
        `SELECT b.store_id, b.item_id, i.code AS item_code, b.batch_id, ib.batch_no,
                ib.expiry_date::text AS expiry_date, b.qty_on_hand::text AS qty_on_hand,
                ib.consignment_vendor_id AS vendor_id, b.value::text AS value
           FROM inventory.stock_balances b
           JOIN inventory.items i ON i.id = b.item_id
           LEFT JOIN inventory.item_batches ib ON ib.id = b.batch_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY i.code`,
        values,
      );

      return {
        items: rows.map((r) => ({
          storeId: r.store_id,
          itemId: r.item_id,
          itemCode: r.item_code,
          batchId: r.batch_id,
          batchNo: r.batch_no,
          expiryDate: r.expiry_date,
          qtyOnHand: r.qty_on_hand,
          vendorId: r.vendor_id,
          value: r.value,
        })),
      };
    });
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async liveAgreement(
    tx: TransactionClient,
    id: string,
  ): Promise<{ readonly vendor_id: string; readonly invoicing_cycle: string; readonly id: string }> {
    const row = await tx.maybeOne<{
      id: string;
      vendor_id: string;
      status: string;
      invoicing_cycle: string;
      agreement_no: string;
    }>(
      `SELECT id, vendor_id, status::text AS status, invoicing_cycle::text AS invoicing_cycle,
              agreement_no
         FROM inventory.csn_agreements WHERE id = $1`,
      [id],
    );
    if (row === undefined) throw AppError.notFound('The consignment agreement');
    if (row.status !== 'active' && row.status !== 'expiring') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        `Consignment agreement ${row.agreement_no} is "${row.status}". Stock may only move under a live agreement — it is somebody else's stock, and the agreement is what says on what terms we hold it.`,
      );
    }
    return row;
  }

  private async agreedPrice(
    tx: TransactionClient,
    agreementId: string,
    itemId: string,
  ): Promise<{ readonly price: number; readonly mrp: number | null }> {
    const row = await tx.maybeOne<{ vendor_price: string; mrp: string | null }>(
      `SELECT vendor_price::text AS vendor_price, mrp::text AS mrp
         FROM inventory.csn_agreement_items
        WHERE agreement_id = $1 AND item_id = $2 AND active
          AND price_valid_from <= current_date
          AND (price_valid_to IS NULL OR price_valid_to >= current_date)
        ORDER BY price_valid_from DESC LIMIT 1`,
      [agreementId, itemId],
    );
    if (row === undefined) {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'That item is not on this consignment agreement at a price valid today, so there is no agreed price to invoice the vendor at.',
      );
    }
    return { price: Number(row.vendor_price), mrp: row.mrp === null ? null : Number(row.mrp) };
  }

  /**
   * Usage-triggered replenishment.
   *
   * For a `per_usage` agreement the order goes out immediately, which is the
   * whole reason a hospital accepts consignment terms on implants: the box is
   * refilled before the next case. For a cycled agreement the usage accumulates
   * into an open batch and the order is raised when the cycle closes.
   */
  private async replenish(
    tx: TransactionClient,
    agreement: { readonly id: string; readonly vendor_id: string; readonly invoicing_cycle: string },
    usageId: string,
    itemId: string,
    qtyEntered: string,
    uomId: string,
    price: number,
  ): Promise<void> {
    const ctx = getContext();
    const period = new Date().toISOString().slice(0, 7);

    let batch = await tx.maybeOne<{ id: string; lines_count: number; value: string }>(
      `SELECT id, lines_count, value::text AS value FROM inventory.csn_auto_po_batches
        WHERE agreement_id = $1 AND cycle_period = $2 AND status = 'open' FOR UPDATE`,
      [agreement.id, period],
    );
    if (batch === undefined) {
      const id = newId();
      await tx.query(
        `INSERT INTO inventory.csn_auto_po_batches
           (id, hospital_id, vendor_id, agreement_id, cycle_period, status,
            created_by, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'open', $6, $6, now())`,
        [id, ctx.hospitalId, agreement.vendor_id, agreement.id, period, ctx.userId],
      );
      batch = { id, lines_count: 0, value: '0' };
    }

    const lineValue = price * Number(qtyEntered);
    await tx.query(
      `UPDATE inventory.csn_auto_po_batches
          SET lines_count = lines_count + 1, value = value + $2::numeric, updated_at = now()
        WHERE id = $1`,
      [batch.id, lineValue.toFixed(2)],
    );
    await tx.query(`UPDATE inventory.csn_usages SET auto_po_id = $2 WHERE id = $1`, [usageId, batch.id]);

    if (agreement.invoicing_cycle !== 'per_usage') return;

    // A replenishment order is raised approved: the agreement is the approval,
    // and an implant box that waits for a buyer to click is a box that is empty
    // for the next case.
    const poId = newId();
    const branchId = requireBranch();
    const poNo = (
      await this.numbering.allocate(tx, {
        key: 'PO',
        branchId,
        refType: 'inventory.pur_purchase_orders',
        refId: poId,
      })
    ).formatted;

    const store = await tx.maybeOne<{ store_id: string }>(
      `SELECT store_id FROM inventory.csn_usages WHERE id = $1`,
      [usageId],
    );

    await tx.query(
      `INSERT INTO inventory.pur_purchase_orders
         (id, hospital_id, branch_id, po_no, po_version, is_current, po_type, vendor_id,
          ship_to_store_id, status, approved_by, approved_at, created_by, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, 1, true, 'consignment_replenishment'::inventory."PurPoType", $5,
               $6, 'approved'::inventory."PurPoStatus", ARRAY[$7]::uuid[], now(), $7, $7, now())`,
      [poId, ctx.hospitalId, branchId, poNo, agreement.vendor_id, store?.store_id ?? null, ctx.userId],
    );

    const item = await this.uoms.item(tx, itemId);
    const converted = await this.uoms.toBase(tx, item, uomId, qtyEntered);
    const onePack = await this.uoms.toBase(tx, item, uomId, 1);

    await tx.query(
      `INSERT INTO inventory.pur_po_lines
         (id, hospital_id, po_id, line_no, item_id, uom_id, qty_entered, qty_base, rate,
          rate_per_base, taxable, line_total, hsn_code, created_by, updated_by, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::numeric,
               $10::numeric, $10::numeric, $11, $12, $12, now())`,
      [
        newId(),
        ctx.hospitalId,
        poId,
        itemId,
        converted.uomId,
        converted.qtyEntered,
        converted.qtyBase,
        price,
        (price / Number(onePack.qtyBase)).toFixed(4),
        lineValue.toFixed(2),
        item.hsn_code,
        ctx.userId,
      ],
    );

    await tx.query(
      `UPDATE inventory.pur_purchase_orders
          SET subtotal = $2::numeric, taxable = $2::numeric, total = $2::numeric
        WHERE id = $1`,
      [poId, lineValue.toFixed(2)],
    );
    await tx.query(`UPDATE inventory.csn_auto_po_batches SET po_id = $2 WHERE id = $1`, [batch.id, poId]);
    await tx.query(`UPDATE inventory.csn_usages SET auto_po_line_id = NULL WHERE id = $1`, [usageId]);

    await this.outbox.publish(
      tx,
      inventoryEvent('consignment.auto_po.created', batch.id, {
        batchId: batch.id,
        agreementId: agreement.id,
        vendorId: agreement.vendor_id,
        poId,
        poNo,
        usageCount: batch.lines_count + 1,
        value: moneyString(lineValue),
        currency: 'INR',
        createdAt: new Date().toISOString(),
      }),
    );
  }

  private async simpleDocument(
    id: string,
    headerSql: string,
    lineSql: string,
    label: string,
  ): Promise<DocumentView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const header = await tx.maybeOne<Record<string, string | null>>(headerSql, [id]);
      if (header === undefined) throw AppError.notFound(label);
      const rows = await tx.rows<Record<string, string | number | boolean | null>>(lineSql, [id]);

      const known = new Set([
        'id',
        'line_no',
        'item_id',
        'item_code',
        'item_name',
        'batch_id',
        'batch_no',
        'uom_id',
        'qty_entered',
        'qty_base',
      ]);

      return {
        id: String(header.id),
        documentNo: String(header.document_no),
        status: String(header.status),
        storeId: header.store_id ?? null,
        counterpartyId: header.counterparty_id ?? null,
        createdAt: new Date(String(header.created_at)).toISOString(),
        lines: rows.map((row) => {
          const extra: Record<string, string | number | boolean | null> = {};
          for (const [key, value] of Object.entries(row)) if (!known.has(key)) extra[key] = value;
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
            status: null,
            extra,
          };
        }),
        header: Object.fromEntries(
          Object.entries(header).filter(
            ([key]) => !['id', 'document_no', 'status', 'store_id', 'counterparty_id'].includes(key),
          ),
        ),
      };
    });
  }

  private async page(
    resource: string,
    selectSql: string,
    query: { readonly cursor?: string | undefined; readonly limit: number },
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
