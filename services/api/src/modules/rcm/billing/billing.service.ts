import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { TariffService } from '../tariff/tariff.service.js';
import { billingEvent } from './billing.events.js';
import type {
  BillQuery,
  CancelBillRequest,
  CreditNoteRequest,
  DecideDiscountRequest,
  ExceptionQuery,
  FinalizeRequest,
  OpenBillRequest,
  PostItemsRequest,
  RequestDiscountRequest,
} from './billing.schemas.js';
import type {
  BillDetailView,
  BillItemView,
  BillSummaryView,
  BillingExceptionView,
  DiscountRequestView,
  InvoiceView,
} from './billing.types.js';

/** Narrowing helpers — `pg` hands back `unknown` per column. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return '';
}
function asTextOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : asText(value);
}
function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(asText(value));
}

/** Round half-up on the absolute value, so a credit note mirrors its invoice. */
function round2(value: number): number {
  return (Math.sign(value) * Math.round(Math.abs(value) * 100)) / 100;
}

/**
 * OP-005 — OP billing.
 *
 * ── Charges are posted, never typed ─────────────────────────────────────────
 *
 * `postItems` takes the identity of a clinical event, not a price. It resolves
 * the price through RC-003 and stores the version and item it resolved to, so a
 * bill raised today can still be explained after ten tariff revisions. A caller
 * *may* supply `unitPrice`, and doing so marks the line `manual` — visible in
 * the exception queue rather than indistinguishable from a resolved rate.
 *
 * ── A line that cannot be priced is held, not zeroed ────────────────────────
 *
 * `MISSING_RATE` writes the line with `price_status = 'missing'` and a zero
 * amount, raises `bill.line.unpriced`, and `finalize` refuses while any such
 * line is on the bill. `phase-05 §Constraints`: "A blocked rate stops the bill
 * and raises a task — silence here becomes revenue leakage." The line is
 * deliberately *present* — a service delivered and not billed must be visible.
 *
 * ── GST is computed from the resolved item, at the date of service ──────────
 *
 * Intra-state splits CGST and SGST equally; inter-state is IGST; exempt is
 * neither. The database refuses a row that breaks any of those three, so the
 * arithmetic here is checked rather than trusted. Rounding is per invoice to the
 * nearest rupee under Section 170, recorded as `round_off` — not silently
 * absorbed into a line, which would make the lines stop adding up.
 *
 * ── Finalisation is one transaction ─────────────────────────────────────────
 *
 * Number, totals, status and GST document are all written together or not at
 * all. A bill that acquired a number and then failed to acquire an invoice is a
 * gap in a gapless series, and the register stops reconciling.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(TariffService) private readonly tariff: TariffService,
  ) {}

  private hospitalId(): string {
    const id = getContext().hospitalId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }

  private branchId(explicit?: string): string {
    const id = explicit ?? getContext().branchId;
    if (id === null || id === undefined) {
      throw AppError.conflict('This action needs a branch. Choose one and try again.');
    }
    return id;
  }

  private actorId(): string {
    const id = getContext().userId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Bills
  // ═══════════════════════════════════════════════════════════════════════════

  async listBills(query: BillQuery): Promise<Page<BillSummaryView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT b.*, p.full_name AS patient_name, p.uhid
           FROM billing.bills b
           -- LEFT, not INNER: patients are branch-scoped by RLS, and a patient
           -- registered at one branch of a group is routinely billed at
           -- another. An inner join makes that bill invisible to the desk
           -- holding it, which reads as data loss rather than as scoping.
           LEFT JOIN patient.patients p ON p.id = b.patient_id
          WHERE b.hospital_id = $1
            AND ($2::uuid IS NULL OR b.patient_id = $2)
            AND ($3::uuid IS NULL OR b.visit_id = $3)
            AND ($4::text IS NULL OR b.status::text = $4)
          ORDER BY b.created_at DESC
          LIMIT $5`,
        [
          this.hospitalId(),
          query.patientId ?? null,
          query.visitId ?? null,
          query.status ?? null,
          query.limit + 1,
        ],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toSummary(r)),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  private toSummary(r: Record<string, unknown>): BillSummaryView {
    return {
      id: asText(r['id']),
      billNo: asText(r['bill_no']),
      patientId: asText(r['patient_id']),
      patientName: asText(r['patient_name']),
      uhid: asText(r['uhid']),
      visitId: asTextOrNull(r['visit_id']),
      billType: asText(r['bill_type']),
      status: asText(r['status']),
      payerType: asText(r['payer_type']),
      currency: asText(r['currency']),
      grossAmount: asText(r['gross_amount']),
      discountAmount: asText(r['discount_amount']),
      taxableAmount: asText(r['taxable_amount']),
      cgst: asText(r['cgst']),
      sgst: asText(r['sgst']),
      igst: asText(r['igst']),
      roundOff: asText(r['round_off']),
      netAmount: asText(r['net_amount']),
      paidAmount: asText(r['paid_amount']),
      balanceAmount: asText(r['balance_amount']),
      createdAt: asText(r['created_at']),
      finalizedAt: asTextOrNull(r['finalized_at']),
    };
  }

  async openBill(body: OpenBillRequest): Promise<BillSummaryView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const branchId = this.branchId();
      const id = newId();

      const allocation = await this.numbering.allocate(tx, {
        key: 'BILL_OP',
        branchId,
        refType: 'bill',
        refId: id,
      });

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.bills
           (id, hospital_id, branch_id, bill_no, patient_id, visit_id,
            bill_type, status, payer_type, payer_id, policy_ref, remarks,
            created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::"billing"."BillType",'draft',
                 $8::"billing"."BillPayerType",$9,$10,$11, now(),$12, now(),$12)
         RETURNING *, (SELECT full_name FROM patient.patients WHERE id = $5) AS patient_name,
                      (SELECT uhid FROM patient.patients WHERE id = $5) AS uhid`,
        [
          id,
          this.hospitalId(),
          branchId,
          allocation.formatted,
          body.patientId,
          body.visitId ?? null,
          body.billType,
          body.payerType,
          body.payerId ?? null,
          body.policyRef ?? null,
          body.remarks ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The bill could not be opened.');

      await this.outbox.publish(
        tx,
        billingEvent('bill.opened', id, {
          billId: id,
          billNo: allocation.formatted,
          patientId: body.patientId,
          visitId: body.visitId ?? null,
          billType: body.billType,
        }),
      );
      await this.audit.write(tx, {
        action: 'insert',
        entity: 'billing.bills',
        rowId: id,
        businessKey: allocation.formatted,
        dataClass: 'financial',
        before: null,
        after: { bill_no: allocation.formatted, patient_id: body.patientId },
      });

      return this.toSummary(row);
    });
  }

  /**
   * Post charges. Each line is priced through RC-003 unless a price is supplied.
   *
   * A replayed event conflicts on (bill_id, source_module, source_ref_id) and is
   * skipped rather than raising — exit gate 2 replays every charge three times
   * and expects the bill unchanged, which means "already posted" is a normal
   * outcome and not an error the caller has to handle.
   */
  async postItems(
    billId: string,
    body: PostItemsRequest,
  ): Promise<{ readonly posted: number; readonly skipped: number; readonly unpriced: number }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();
      const bill = await this.loadBillForWrite(tx, billId);

      let posted = 0;
      let skipped = 0;
      let unpriced = 0;

      for (const line of body.items) {
        const performedAt = line.performedAt ?? new Date().toISOString();
        const at = performedAt.slice(0, 10);

        let unitPrice: number | null = line.unitPrice ?? null;
        let priceStatus: 'priced' | 'missing' | 'manual' = line.unitPrice === undefined ? 'priced' : 'manual';
        let gstRate = 0;
        let isExempt = true;
        let hsnSac: string | null = null;
        let tariffVersionId: string | null = null;
        let tariffItemId: string | null = null;

        if (line.unitPrice === undefined) {
          if (line.serviceId === undefined) {
            throw AppError.conflict(
              'A line with no service cannot be priced automatically. Give a service or a price.',
            );
          }
          const resolved = await this.tariff.resolve({
            serviceId: line.serviceId,
            branchId: asText(bill['branch_id']),
            at,
            ...(bill['payer_id'] === null ? {} : { payerId: asText(bill['payer_id']) }),
          });

          if (resolved.outcome === 'missing_rate') {
            // Held, not zeroed. The line exists so the delivered service is
            // visible; `finalize` refuses while it is here.
            unitPrice = 0;
            priceStatus = 'missing';
            unpriced += 1;
          } else {
            unitPrice = Number(resolved.rate);
            gstRate = Number(resolved.gstRate);
            isExempt = resolved.taxTreatment !== 'taxable';
            hsnSac = resolved.hsnSac;
            tariffVersionId = resolved.versionId;
            tariffItemId = resolved.itemId;
          }
        }

        const gross = round2((unitPrice ?? 0) * line.qty);
        const taxable = isExempt ? 0 : gross;
        // Intra-state by default: CGST and SGST are half the rate each. The
        // database refuses any row where they differ, so this is checked.
        const halfTax = isExempt ? 0 : round2((taxable * gstRate) / 200);
        const net = round2(gross + halfTax * 2);

        const itemId = newId();
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO billing.bill_items
             (id, hospital_id, bill_id, department_id, service_id, item_type, description, hsn_sac,
              qty, unit_price, tariff_version_id, tariff_item_id,
              gross, taxable_value, gst_rate, cgst, sgst, igst, cess, is_exempt, net,
              price_status, performing_doctor_id, ordering_doctor_id,
              source_module, source_ref_id, performed_at, posted_at,
              created_at, created_by, updated_at, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6::"billing"."BillItemType",$7,$8,
                   $9,$10,$11,$12,
                   $13,$14,$15,$16,$16,0,0,$17,$18,
                   $19::"billing"."BillPriceStatus",$20,$21,
                   $22,$23,$24::timestamptz, now(),
                   now(),$25, now(),$25)
           ON CONFLICT (bill_id, source_module, source_ref_id) DO NOTHING
           RETURNING id`,
          [
            itemId,
            hospital,
            billId,
            line.departmentId ?? null,
            line.serviceId ?? null,
            line.itemType,
            line.description,
            hsnSac,
            line.qty,
            (unitPrice ?? 0).toFixed(2),
            tariffVersionId,
            tariffItemId,
            gross.toFixed(2),
            taxable.toFixed(2),
            gstRate.toFixed(2),
            halfTax.toFixed(2),
            isExempt,
            net.toFixed(2),
            priceStatus,
            line.performingDoctorId ?? null,
            line.orderingDoctorId ?? null,
            line.sourceModule,
            line.sourceRefId,
            performedAt,
            actor,
          ],
        );

        if (rows[0] === undefined) {
          // The replay path. Not an error: exit gate 2 depends on it.
          skipped += 1;
          continue;
        }
        posted += 1;

        await this.outbox.publish(
          tx,
          billingEvent('bill.item.posted', billId, {
            billId,
            billItemId: itemId,
            sourceModule: line.sourceModule,
            sourceRefId: line.sourceRefId,
            net: net.toFixed(2),
            priceStatus,
          }),
        );

        if (priceStatus === 'missing') {
          await this.outbox.publish(
            tx,
            billingEvent('bill.line.unpriced', billId, {
              billId,
              billItemId: itemId,
              serviceId: line.serviceId ?? null,
              sourceModule: line.sourceModule,
            }),
          );
          await tx.query(
            `INSERT INTO billing.billing_exceptions
               (id, hospital_id, branch_id, exception_type, ref_id, amount, detail, detected_at, status)
             VALUES ($1,$2,$3,'unpriced_line',$4,0,$5, now(),'open')`,
            [
              newId(),
              hospital,
              asText(bill['branch_id']),
              itemId,
              `No tariff rate for ${line.description} on ${at}. The line is held.`,
            ],
          );
        }
      }

      await this.recomputeTotals(tx, billId);
      return { posted, skipped, unpriced };
    });
  }

  /**
   * Recompute the header from the lines.
   *
   * The single writer of a bill's money columns. The deferred constraint trigger
   * re-adds the lines at commit and refuses a header that disagrees, so this is
   * belt to that braces — but the trigger only catches a mistake, and this is
   * what stops one being made.
   */
  private async recomputeTotals(tx: TransactionClient, billId: string): Promise<void> {
    await tx.query(
      `WITH totals AS (
         SELECT COALESCE(sum(gross), 0)          AS gross,
                COALESCE(sum(discount_amount),0) AS discount,
                COALESCE(sum(taxable_value), 0)  AS taxable,
                COALESCE(sum(cgst), 0)           AS cgst,
                COALESCE(sum(sgst), 0)           AS sgst,
                COALESCE(sum(igst), 0)           AS igst,
                COALESCE(sum(cess), 0)           AS cess,
                COALESCE(sum(net), 0)            AS net
           FROM billing.bill_items
          WHERE bill_id = $1 AND status <> 'cancelled'
       )
       UPDATE billing.bills b
          SET gross_amount    = t.gross,
              discount_amount = t.discount,
              taxable_amount  = t.taxable,
              cgst = t.cgst, sgst = t.sgst, igst = t.igst, cess = t.cess,
              net_amount      = t.net + b.round_off,
              balance_amount  = (t.net + b.round_off) - b.paid_amount,
              updated_at      = now()
         FROM totals t
        WHERE b.id = $1`,
      [billId],
    );
  }

  private async loadBillForWrite(tx: TransactionClient, billId: string): Promise<Record<string, unknown>> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.bills WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
      [billId, this.hospitalId()],
    );
    const bill = rows[0];
    if (bill === undefined) throw AppError.notFound('Bill');
    const status = asText(bill['status']);
    if (status !== 'draft' && status !== 'open') {
      throw AppError.conflict(
        `This bill is ${status} and its lines are fixed. Corrections are made by credit note (OP-005 §5).`,
      );
    }
    return bill;
  }

  async getBill(billId: string): Promise<BillDetailView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT b.*, p.full_name AS patient_name, p.uhid
           FROM billing.bills b LEFT JOIN patient.patients p ON p.id = b.patient_id
          WHERE b.id = $1 AND b.hospital_id = $2`,
        [billId, this.hospitalId()],
      );
      const bill = rows[0];
      if (bill === undefined) throw AppError.notFound('Bill');

      const { rows: items } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.bill_items WHERE bill_id = $1 ORDER BY posted_at`,
        [billId],
      );
      const { rows: invoices } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.invoices WHERE bill_id = $1 ORDER BY issued_at`,
        [billId],
      );
      const { rows: discounts } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.discount_requests WHERE bill_id = $1 ORDER BY created_at DESC`,
        [billId],
      );

      return {
        ...this.toSummary(bill),
        items: items.map((r) => this.toItem(r)),
        invoices: invoices.map((r) => this.toInvoice(r)),
        discountRequests: discounts.map((r) => this.toDiscount(r)),
      };
    });
  }

  private toItem(r: Record<string, unknown>): BillItemView {
    return {
      id: asText(r['id']),
      itemType: asText(r['item_type']),
      description: asText(r['description']),
      hsnSac: asTextOrNull(r['hsn_sac']),
      qty: asText(r['qty']),
      unitPrice: asText(r['unit_price']),
      gross: asText(r['gross']),
      discountAmount: asText(r['discount_amount']),
      taxableValue: asText(r['taxable_value']),
      gstRate: asText(r['gst_rate']),
      cgst: asText(r['cgst']),
      sgst: asText(r['sgst']),
      igst: asText(r['igst']),
      isExempt: Boolean(r['is_exempt']),
      net: asText(r['net']),
      status: asText(r['status']),
      priceStatus: asText(r['price_status']),
      sourceModule: asText(r['source_module']),
      sourceRefId: asText(r['source_ref_id']),
      tariffVersionId: asTextOrNull(r['tariff_version_id']),
      performedAt: asTextOrNull(r['performed_at']),
    };
  }

  private toInvoice(r: Record<string, unknown>): InvoiceView {
    return {
      id: asText(r['id']),
      invoiceNo: asText(r['invoice_no']),
      seriesKey: asText(r['series_key']),
      docType: asText(r['doc_type']),
      isB2b: Boolean(r['is_b2b']),
      recipientGstin: asTextOrNull(r['recipient_gstin']),
      einvoiceStatus: asText(r['einvoice_status']),
      status: asText(r['status']),
      issuedAt: asText(r['issued_at']),
      originalInvoiceId: asTextOrNull(r['original_invoice_id']),
    };
  }

  private toDiscount(r: Record<string, unknown>): DiscountRequestView {
    return {
      id: asText(r['id']),
      billItemId: asTextOrNull(r['bill_item_id']),
      requestedBy: asText(r['requested_by']),
      pct: asTextOrNull(r['pct']),
      amount: asTextOrNull(r['amount']),
      reasonCode: asText(r['reason_code']),
      justification: asTextOrNull(r['justification']),
      approvedBy: asTextOrNull(r['approved_by']),
      decidedAt: asTextOrNull(r['decided_at']),
      status: asText(r['status']),
    };
  }

  /**
   * Finalise: fix the amounts, issue the GST document, make it collectable.
   *
   * Refuses while any line is unpriced — OP-005 §5, "Bill finalisation requires:
   * no `price_status=missing`". That refusal is the whole reason `missing` is a
   * state rather than an absent row.
   */
  async finalize(billId: string, body: FinalizeRequest): Promise<BillDetailView> {
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();
      const bill = await this.loadBillForWrite(tx, billId);
      const branchId = asText(bill['branch_id']);

      const { rows: held } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM billing.bill_items
          WHERE bill_id = $1 AND price_status = 'missing' AND status <> 'cancelled'`,
        [billId],
      );
      const unpriced = asNumber(held[0]?.n ?? 0);
      if (unpriced > 0) {
        throw AppError.conflict(
          `${String(unpriced)} line(s) on this bill have no tariff rate and are held. Price them or cancel them before finalising — nothing here is billed at zero (OP-005 §5).`,
        );
      }

      const { rows: lineCount } = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM billing.bill_items WHERE bill_id = $1 AND status <> 'cancelled'`,
        [billId],
      );
      if (asNumber(lineCount[0]?.n ?? 0) === 0) {
        throw AppError.conflict('A bill with no lines cannot be finalised.');
      }

      await this.recomputeTotals(tx, billId);

      // Section 170: round the whole invoice to the nearest rupee and record the
      // delta, rather than nudging a line and making the lines stop adding up.
      const { rows: totalRows } = await tx.query<{
        net: string;
        taxable: string;
        cgst: string;
        sgst: string;
        igst: string;
      }>(
        `SELECT net_amount AS net, taxable_amount AS taxable, cgst, sgst, igst
           FROM billing.bills WHERE id = $1`,
        [billId],
      );
      const raw = asNumber(totalRows[0]?.net ?? 0);
      const rounded = Math.round(raw);
      const roundOff = round2(rounded - raw);

      await tx.query(
        `UPDATE billing.bills
            SET round_off = $2, net_amount = $3, balance_amount = $3 - paid_amount,
                status = 'finalized', finalized_at = now(), finalized_by = $4,
                updated_at = now(), updated_by = $4
          WHERE id = $1`,
        [billId, roundOff.toFixed(2), rounded.toFixed(2), actor],
      );

      // Exempt healthcare gets a bill of supply; anything taxable gets a tax
      // invoice. Issuing a tax invoice for an exempt service claims tax that was
      // never charged.
      const anyTaxable = asNumber(totalRows[0]?.taxable ?? 0) > 0;
      const docType = anyTaxable ? 'tax_invoice' : 'bill_of_supply';
      // Their own series, not the bill's. Sharing `BILL_OP` would interleave
      // bill numbers with invoice numbers in one counter and the invoice
      // register would show gaps — the exact defect gapless numbering prevents.
      // A tax invoice and a bill of supply are also separate GST registers.
      const seriesKey = anyTaxable ? 'TAX_INVOICE' : 'BILL_SUPPLY';

      const invoiceId = newId();
      const invoiceNo = await this.numbering.allocate(tx, {
        key: seriesKey,
        branchId,
        refType: 'invoice',
        refId: invoiceId,
      });

      await tx.query(
        `INSERT INTO billing.invoices
           (id, hospital_id, branch_id, invoice_no, series_key, bill_id, doc_type,
            is_b2b, recipient_name, recipient_gstin, place_of_supply_state,
            einvoice_status, status, issued_at, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7::"billing"."InvoiceDocType",
                 $8,$9,$10,$11,'na','issued', now(), now(),$12, now(),$12)`,
        [
          invoiceId,
          hospital,
          branchId,
          invoiceNo.formatted,
          seriesKey,
          billId,
          docType,
          body.recipientGstin !== undefined,
          body.recipientName ?? null,
          body.recipientGstin ?? null,
          body.placeOfSupplyState ?? null,
          actor,
        ],
      );

      await this.outbox.publish(
        tx,
        billingEvent('bill.finalized', billId, {
          billId,
          billNo: asText(bill['bill_no']),
          patientId: asText(bill['patient_id']),
          netAmount: rounded.toFixed(2),
          taxableAmount: asText(totalRows[0]?.taxable ?? '0'),
          cgst: asText(totalRows[0]?.cgst ?? '0'),
          sgst: asText(totalRows[0]?.sgst ?? '0'),
          igst: asText(totalRows[0]?.igst ?? '0'),
          payerType: asText(bill['payer_type']),
          finalizedBy: actor,
        }),
      );
      await this.outbox.publish(
        tx,
        billingEvent('invoice.issued', invoiceId, {
          invoiceId,
          invoiceNo: invoiceNo.formatted,
          seriesKey,
          billId,
          docType,
          isB2b: body.recipientGstin !== undefined,
          netAmount: rounded.toFixed(2),
        }),
      );
      await this.audit.write(tx, {
        action: 'update',
        entity: 'billing.bills',
        rowId: billId,
        businessKey: asText(bill['bill_no']),
        dataClass: 'financial',
        reasonText: body.reason,
        before: { status: asText(bill['status']) },
        after: { status: 'finalized', invoice_no: invoiceNo.formatted },
      });
    });

    return this.getBill(billId);
  }

  async cancelBill(billId: string, body: CancelBillRequest): Promise<BillSummaryView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.bills
            SET status = 'cancelled', cancelled_at = now(), cancelled_by = $3,
                cancel_reason = $4, updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2 AND status IN ('draft','open')
          RETURNING *, (SELECT full_name FROM patient.patients WHERE id = patient_id) AS patient_name,
                       (SELECT uhid FROM patient.patients WHERE id = patient_id) AS uhid`,
        [billId, this.hospitalId(), this.actorId(), body.reason],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict(
          'Only a draft or open bill can be cancelled. A finalised bill is reversed by credit note.',
        );
      }
      await this.outbox.publish(
        tx,
        billingEvent('bill.cancelled', billId, {
          billId,
          billNo: asText(row['bill_no']),
          reason: body.reason,
          cancelledBy: this.actorId(),
        }),
      );
      return this.toSummary(row);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Discounts — maker and checker
  // ═══════════════════════════════════════════════════════════════════════════

  async requestDiscount(billId: string, body: RequestDiscountRequest): Promise<DiscountRequestView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.discount_requests
           (id, hospital_id, bill_id, bill_item_id, requested_by, pct, amount,
            reason_code, justification, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending', now(), now())
         RETURNING *`,
        [
          id,
          this.hospitalId(),
          billId,
          body.billItemId ?? null,
          this.actorId(),
          body.pct === undefined ? null : body.pct.toFixed(2),
          body.amount === undefined ? null : body.amount.toFixed(2),
          body.reasonCode,
          body.justification ?? null,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The discount request could not be raised.');

      await this.outbox.publish(
        tx,
        billingEvent('bill.discount.requested', id, {
          requestId: id,
          billId,
          requestedBy: this.actorId(),
          pct: body.pct === undefined ? null : body.pct.toFixed(2),
          amount: body.amount === undefined ? null : body.amount.toFixed(2),
          reasonCode: body.reasonCode,
        }),
      );
      return this.toDiscount(row);
    });
  }

  /**
   * Decide a discount. The database refuses `approved_by = requested_by`, so
   * the maker-checker rule holds even if a role somehow acquires both keys.
   */
  async decideDiscount(id: string, body: DecideDiscountRequest): Promise<DiscountRequestView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.discount_requests
            SET status = $3::"billing"."DiscountRequestStatus", approved_by = $4, decided_at = now(),
                updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status = 'pending'
          RETURNING *`,
        [id, this.hospitalId(), body.decision, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('Only a pending discount request can be decided.');
      }

      // Applying it is a separate step, and only on approval.
      if (body.decision === 'approved') {
        const billId = asText(row['bill_id']);
        const pct = row['pct'] === null ? null : asNumber(row['pct']);
        const amount = row['amount'] === null ? null : asNumber(row['amount']);
        await tx.query(
          `UPDATE billing.bill_items
              SET discount_amount = LEAST(
                    CASE WHEN $2::numeric IS NOT NULL THEN round(gross * $2 / 100, 2)
                         ELSE $3::numeric END,
                    gross),
                  net = gross - LEAST(
                    CASE WHEN $2::numeric IS NOT NULL THEN round(gross * $2 / 100, 2)
                         ELSE $3::numeric END,
                    gross) + cgst + sgst + igst,
                  discount_approved_by = $4,
                  updated_at = now()
            WHERE bill_id = $1
              AND ($5::uuid IS NULL OR id = $5)`,
          [billId, pct, amount, this.actorId(), row['bill_item_id'] ?? null],
        );
        await this.recomputeTotals(tx, billId);
      }

      await this.outbox.publish(
        tx,
        billingEvent('bill.discount.decided', id, {
          requestId: id,
          billId: asText(row['bill_id']),
          approvedBy: this.actorId(),
          decision: body.decision,
          reason: body.reason,
        }),
      );
      await this.audit.write(tx, {
        action: 'update',
        entity: 'billing.discount_requests',
        rowId: id,
        businessKey: asText(row['reason_code']),
        dataClass: 'financial',
        reasonText: body.reason,
        before: { status: 'pending' },
        after: { status: body.decision },
      });

      return this.toDiscount(row);
    });
  }

  /** The correction path for anything already finalised. */
  async creditNote(billId: string, body: CreditNoteRequest): Promise<InvoiceView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows: originals } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.invoices
          WHERE bill_id = $1 AND hospital_id = $2 AND status = 'issued'
            AND doc_type IN ('tax_invoice','bill_of_supply')
          ORDER BY issued_at DESC LIMIT 1`,
        [billId, hospital],
      );
      const original = originals[0];
      if (original === undefined) {
        throw AppError.conflict('There is no issued invoice on this bill to credit.');
      }

      const id = newId();
      const branchId = asText(original['branch_id']);
      const number = await this.numbering.allocate(tx, {
        key: 'CREDIT_NOTE',
        branchId,
        refType: 'invoice',
        refId: id,
      });

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.invoices
           (id, hospital_id, branch_id, invoice_no, series_key, bill_id, doc_type,
            original_invoice_id, status, issued_at, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,'CREDIT_NOTE',$5,'credit_note',$6,'issued', now(), now(),$7, now(),$7)
         RETURNING *`,
        [id, hospital, branchId, number.formatted, billId, asText(original['id']), actor],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The credit note could not be issued.');

      await this.outbox.publish(
        tx,
        billingEvent('invoice.credit_note.issued', id, {
          invoiceId: id,
          invoiceNo: number.formatted,
          originalInvoiceId: asText(original['id']),
          billId,
          amount: body.amount.toFixed(2),
          reason: body.reason,
        }),
      );
      await this.audit.write(tx, {
        action: 'insert',
        entity: 'billing.invoices',
        rowId: id,
        businessKey: number.formatted,
        dataClass: 'financial',
        reasonText: body.reason,
        before: null,
        after: { doc_type: 'credit_note', amount: body.amount.toFixed(2) },
      });

      return this.toInvoice(row);
    });
  }

  async listExceptions(query: ExceptionQuery): Promise<Page<BillingExceptionView>> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.billing_exceptions
          WHERE hospital_id = $1 AND ($2::text IS NULL OR status = $2)
          ORDER BY detected_at DESC LIMIT $3`,
        [this.hospitalId(), query.status ?? null, query.limit + 1],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => ({
          id: asText(r['id']),
          exceptionType: asText(r['exception_type']),
          refId: asTextOrNull(r['ref_id']),
          amount: asTextOrNull(r['amount']),
          detail: asTextOrNull(r['detail']),
          detectedAt: asText(r['detected_at']),
          status: asText(r['status']),
        })),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }
}
