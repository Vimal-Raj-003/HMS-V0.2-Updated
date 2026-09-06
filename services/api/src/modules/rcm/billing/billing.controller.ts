import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { BillingService } from './billing.service.js';
import {
  billQuerySchema,
  cancelBillSchema,
  creditNoteSchema,
  decideDiscountSchema,
  exceptionQuerySchema,
  finalizeSchema,
  idSchema,
  openBillSchema,
  postItemsSchema,
  requestDiscountSchema,
  type BillQuery,
  type CancelBillRequest,
  type CreditNoteRequest,
  type DecideDiscountRequest,
  type ExceptionQuery,
  type FinalizeRequest,
  type OpenBillRequest,
  type PostItemsRequest,
  type RequestDiscountRequest,
} from './billing.schemas.js';
import type {
  BillDetailView,
  BillSummaryView,
  BillingExceptionView,
  DiscountRequestView,
  InvoiceView,
} from './billing.types.js';

/**
 * `/api/v1/billing/*` — OP-005.
 *
 * `POST /bills/:id/items` is the busiest write in the phase and is
 * `@Idempotent()` twice over: the interceptor deduplicates a retried *request*,
 * and the database deduplicates a replayed *event* on
 * (bill_id, source_module, source_ref_id). Those are different failures — a
 * tablet retrying on bad Wi-Fi, and a queue redelivering a charge — and exit
 * gate 2 tests the second one.
 *
 * Discount request and approval are two routes on two keys held by two roles,
 * with a `block` segregation rule behind them. One route with a `decision`
 * parameter would have been smaller and would have made the rule unenforceable.
 */
@Controller('billing')
export class BillingController {
  constructor(@Inject(BillingService) private readonly billing: BillingService) {}

  @Permission('bill.list')
  @Get('bills')
  async listBills(@Query(new ZodBody(billQuerySchema)) query: BillQuery): Promise<Page<BillSummaryView>> {
    return this.billing.listBills(query);
  }

  @Permission('bill.read')
  @Get('bills/:id')
  async getBill(@Param('id', new ZodBody(idSchema)) id: string): Promise<BillDetailView> {
    return this.billing.getBill(id);
  }

  @Permission('bill.create')
  @Idempotent()
  @Post('bills')
  async openBill(@Body(new ZodBody(openBillSchema)) body: OpenBillRequest): Promise<BillSummaryView> {
    return this.billing.openBill(body);
  }

  /** A replayed charge is skipped, not rejected — exit gate 2 depends on it. */
  @Permission('bill.item.post')
  @Idempotent()
  @Post('bills/:id/items')
  async postItems(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(postItemsSchema)) body: PostItemsRequest,
  ): Promise<{ readonly posted: number; readonly skipped: number; readonly unpriced: number }> {
    return this.billing.postItems(id, body);
  }

  @Permission('bill.finalize')
  @Idempotent()
  @Post('bills/:id/finalize')
  async finalize(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(finalizeSchema)) body: FinalizeRequest,
  ): Promise<BillDetailView> {
    return this.billing.finalize(id, body);
  }

  @Permission('bill.cancel')
  @Idempotent()
  @Post('bills/:id/cancel')
  async cancelBill(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelBillSchema)) body: CancelBillRequest,
  ): Promise<BillSummaryView> {
    return this.billing.cancelBill(id, body);
  }

  @Permission('bill.discount.request')
  @Idempotent()
  @Post('bills/:id/discount-requests')
  async requestDiscount(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(requestDiscountSchema)) body: RequestDiscountRequest,
  ): Promise<DiscountRequestView> {
    return this.billing.requestDiscount(id, body);
  }

  /** Deliberately a different key from the request, held by a different role. */
  @Permission('bill.discount.approve')
  @Idempotent()
  @Post('discount-requests/:id/decide')
  async decideDiscount(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(decideDiscountSchema)) body: DecideDiscountRequest,
  ): Promise<DiscountRequestView> {
    return this.billing.decideDiscount(id, body);
  }

  @Permission('invoice.credit_note')
  @Idempotent()
  @Post('bills/:id/credit-notes')
  async creditNote(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(creditNoteSchema)) body: CreditNoteRequest,
  ): Promise<InvoiceView> {
    return this.billing.creditNote(id, body);
  }

  @Permission('billing.exception.read')
  @Get('exceptions')
  async listExceptions(
    @Query(new ZodBody(exceptionQuerySchema)) query: ExceptionQuery,
  ): Promise<Page<BillingExceptionView>> {
    return this.billing.listExceptions(query);
  }
}
