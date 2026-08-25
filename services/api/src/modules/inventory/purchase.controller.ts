import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import { GrnService } from './grn.service.js';
import {
  amendPoSchema,
  approveComparativeSchema,
  approveIndentSchema,
  approveInvoiceSchema,
  approvePoSchema,
  captureInvoiceSchema,
  closePoSchema,
  createGrnSchema,
  createPoSchema,
  createPurchaseIndentSchema,
  createRfqSchema,
  disputeInvoiceSchema,
  emergencyPurchaseSchema,
  enterQuotationSchema,
  grnQcSchema,
  grnQuerySchema,
  idSchema,
  invoiceQuerySchema,
  poQuerySchema,
  purchaseIndentQuerySchema,
  purchaseReturnSchema,
  rejectSchema,
  rfqQuerySchema,
  sendPoSchema,
  type AmendPoRequest,
  type ApproveComparativeRequest,
  type ApproveIndentRequest,
  type ApproveInvoiceRequest,
  type ApprovePoRequest,
  type CaptureInvoiceRequest,
  type ClosePoRequest,
  type CreateGrnRequest,
  type CreatePoRequest,
  type CreatePurchaseIndentRequest,
  type CreateRfqRequest,
  type DisputeInvoiceRequest,
  type EmergencyPurchaseRequest,
  type EnterQuotationRequest,
  type GrnQcRequest,
  type GrnQuery,
  type InvoiceQuery,
  type PoQuery,
  type PurchaseIndentQuery,
  type PurchaseReturnRequest,
  type RejectRequest,
  type RfqQuery,
  type SendPoRequest,
} from './inventory.schemas.js';
import type { ComparativeView, DocumentView, InvoiceMatchView } from './inventory.types.js';
import { PurchaseService } from './purchase.service.js';

/**
 * `/api/v1/inventory/purchase/*` — NC-005, indent to payment.
 *
 * The approval routes are all `@Idempotent()` and all assert maker ≠ checker
 * inside their service. That is deliberate duplication of intent: the decorator
 * says "this is the authority", the service says "and not by the same hands",
 * and `docs/04 §3` requires both for a purchase order.
 */
@Controller('inventory/purchase')
export class PurchaseController {
  constructor(
    @Inject(PurchaseService) private readonly purchase: PurchaseService,
    @Inject(GrnService) private readonly grn: GrnService,
  ) {}

  // ── indents ──────────────────────────────────────────────────────────────

  @Permission('inventory.indent.create')
  @Idempotent()
  @Post('indents')
  async createIndent(
    @Body(new ZodBody(createPurchaseIndentSchema)) body: CreatePurchaseIndentRequest,
  ): Promise<DocumentView> {
    return this.purchase.createIndent(body);
  }

  @Permission('inventory.indent.list')
  @Get('indents')
  async listIndents(
    @Query(new ZodBody(purchaseIndentQuerySchema)) query: PurchaseIndentQuery,
  ): Promise<Page<DocumentView>> {
    return this.purchase.listIndents(query);
  }

  @Permission('inventory.indent.read')
  @Get('indents/:id')
  async indent(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.purchase.indent(id);
  }

  @Permission('inventory.indent.approve')
  @Idempotent()
  @Post('indents/:id/approve')
  async approveIndent(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveIndentSchema)) body: ApproveIndentRequest,
  ): Promise<DocumentView> {
    return this.purchase.approveIndent(id, body);
  }

  @Permission('inventory.indent.approve')
  @Idempotent()
  @Post('indents/:id/reject')
  async rejectIndent(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(rejectSchema)) body: RejectRequest,
  ): Promise<DocumentView> {
    return this.purchase.rejectIndent(id, body);
  }

  // ── RFQ, quotations, comparative ─────────────────────────────────────────

  @Permission('inventory.rfq.create')
  @Idempotent()
  @Post('rfqs')
  async createRfq(@Body(new ZodBody(createRfqSchema)) body: CreateRfqRequest): Promise<DocumentView> {
    return this.purchase.createRfq(body);
  }

  @Permission('inventory.rfq.list')
  @Get('rfqs')
  async listRfqs(@Query(new ZodBody(rfqQuerySchema)) query: RfqQuery): Promise<Page<DocumentView>> {
    return this.purchase.listRfqs(query);
  }

  @Permission('inventory.rfq.read')
  @Get('rfqs/:id')
  async rfq(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.purchase.rfq(id);
  }

  @Permission('inventory.rfq.send')
  @Idempotent()
  @Post('rfqs/:id/send')
  async sendRfq(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.purchase.sendRfq(id);
  }

  @Permission('inventory.quotation.enter')
  @Idempotent()
  @Post('rfqs/:id/quotations')
  async enterQuotation(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(enterQuotationSchema)) body: EnterQuotationRequest,
  ): Promise<DocumentView> {
    return this.purchase.enterQuotation(id, body);
  }

  /** Landed cost per base unit, so quotes in different pack sizes compare. */
  @Permission('inventory.comparative.compare')
  @Get('rfqs/:id/comparative')
  async comparative(@Param('id', new ZodBody(idSchema)) id: string): Promise<ComparativeView> {
    return this.purchase.comparative(id);
  }

  @Permission('inventory.comparative.approve')
  @Idempotent()
  @Post('rfqs/:id/comparative/approve')
  async approveComparative(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveComparativeSchema)) body: ApproveComparativeRequest,
  ): Promise<ComparativeView> {
    return this.purchase.approveComparative(id, body);
  }

  // ── purchase orders ──────────────────────────────────────────────────────

  @Permission('inventory.po.create')
  @Idempotent()
  @Post('orders')
  async createPo(@Body(new ZodBody(createPoSchema)) body: CreatePoRequest): Promise<DocumentView> {
    return this.purchase.createPo(body);
  }

  @Permission('inventory.po.list')
  @Get('orders')
  async listPos(@Query(new ZodBody(poQuerySchema)) query: PoQuery): Promise<Page<DocumentView>> {
    return this.purchase.listPos(query);
  }

  @Permission('inventory.po.read')
  @Get('orders/:id')
  async po(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.purchase.po(id);
  }

  @Permission('inventory.po.approve')
  @Idempotent()
  @Post('orders/:id/approve')
  async approvePo(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approvePoSchema)) body: ApprovePoRequest,
  ): Promise<DocumentView> {
    return this.purchase.approvePo(id, body);
  }

  @Permission('inventory.po.send')
  @Idempotent()
  @Post('orders/:id/send')
  async sendPo(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(sendPoSchema)) body: SendPoRequest,
  ): Promise<DocumentView> {
    return this.purchase.sendPo(id, body);
  }

  /** A new version. The superseded one is frozen — the vendor holds a copy. */
  @Permission('inventory.po.amend')
  @Idempotent()
  @Post('orders/:id/amend')
  async amendPo(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(amendPoSchema)) body: AmendPoRequest,
  ): Promise<DocumentView> {
    return this.purchase.amendPo(id, body);
  }

  @Permission('inventory.po.short_close')
  @Idempotent()
  @Post('orders/:id/short-close')
  async shortClosePo(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(closePoSchema)) body: ClosePoRequest,
  ): Promise<DocumentView> {
    return this.purchase.shortClosePo(id, body);
  }

  @Permission('inventory.po.cancel')
  @Idempotent()
  @Post('orders/:id/cancel')
  async cancelPo(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(closePoSchema)) body: ClosePoRequest,
  ): Promise<DocumentView> {
    return this.purchase.cancelPo(id, body);
  }

  @Permission('inventory.purchase.emergency.create')
  @Idempotent()
  @Post('emergency')
  async emergency(
    @Body(new ZodBody(emergencyPurchaseSchema)) body: EmergencyPurchaseRequest,
  ): Promise<{ readonly id: string; readonly reference: string; readonly regulariseDueAt: string }> {
    return this.purchase.emergencyPurchase(body);
  }

  // ── goods receipt ────────────────────────────────────────────────────────

  @Permission('inventory.grn.create')
  @Idempotent()
  @Post('grns')
  async createGrn(@Body(new ZodBody(createGrnSchema)) body: CreateGrnRequest): Promise<DocumentView> {
    return this.grn.create(body);
  }

  @Permission('inventory.grn.list')
  @Get('grns')
  async listGrns(@Query(new ZodBody(grnQuerySchema)) query: GrnQuery): Promise<Page<DocumentView>> {
    return this.grn.listGrns(query);
  }

  @Permission('inventory.grn.read')
  @Get('grns/:id')
  async grnById(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.grn.get(id);
  }

  @Permission('inventory.grn.qc')
  @Idempotent()
  @Post('grns/:id/qc')
  async qc(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(grnQcSchema)) body: GrnQcRequest,
  ): Promise<DocumentView> {
    return this.grn.qc(id, body);
  }

  /** The accepted quantity becomes stock, and its batches are created here. */
  @Permission('inventory.grn.post')
  @Idempotent()
  @Post('grns/:id/post')
  async postGrn(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.grn.post(id);
  }

  @Permission('inventory.grn.reverse')
  @Idempotent()
  @Post('grns/:id/reverse')
  async reverseGrn(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(rejectSchema)) body: RejectRequest,
  ): Promise<DocumentView> {
    return this.grn.reverse(id, body);
  }

  @Permission('inventory.purchase_return.manage')
  @Idempotent()
  @Post('returns')
  async createPurchaseReturn(
    @Body(new ZodBody(purchaseReturnSchema)) body: PurchaseReturnRequest,
  ): Promise<DocumentView> {
    return this.grn.createReturn(body);
  }

  @Permission('inventory.purchase_return.read')
  @Get('returns/:id')
  async purchaseReturn(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.grn.purchaseReturn(id);
  }

  // ── the three-way match ──────────────────────────────────────────────────

  @Permission('inventory.invoice.capture')
  @Idempotent()
  @Post('invoices')
  async captureInvoice(
    @Body(new ZodBody(captureInvoiceSchema)) body: CaptureInvoiceRequest,
  ): Promise<InvoiceMatchView> {
    return this.grn.captureInvoice(body);
  }

  /** The exception queue — `phase-04` exit gate 1's final sentence. */
  @Permission('inventory.invoice.list')
  @Get('invoices')
  async listInvoices(
    @Query(new ZodBody(invoiceQuerySchema)) query: InvoiceQuery,
  ): Promise<Page<InvoiceMatchView>> {
    return this.grn.listInvoices(query);
  }

  @Permission('inventory.invoice.read')
  @Get('invoices/:id')
  async invoice(@Param('id', new ZodBody(idSchema)) id: string): Promise<InvoiceMatchView> {
    return this.grn.invoice(id);
  }

  @Permission('inventory.invoice.approve')
  @Idempotent()
  @Post('invoices/:id/approve')
  async approveInvoice(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveInvoiceSchema)) body: ApproveInvoiceRequest,
  ): Promise<InvoiceMatchView> {
    return this.grn.approveInvoice(id, body);
  }

  @Permission('inventory.invoice.match')
  @Idempotent()
  @Post('invoices/:id/dispute')
  async disputeInvoice(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(disputeInvoiceSchema)) body: DisputeInvoiceRequest,
  ): Promise<InvoiceMatchView> {
    return this.grn.disputeInvoice(id, body);
  }
}
