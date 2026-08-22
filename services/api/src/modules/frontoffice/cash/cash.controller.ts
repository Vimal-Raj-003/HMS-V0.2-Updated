import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { PaymentsService, type PaymentView, type RefundView } from './payments.service.js';
import { ShiftsService, type ShiftView } from './shifts.service.js';
import {
  closeShiftRequestSchema,
  collectPaymentRequestSchema,
  listShiftsQuerySchema,
  openShiftRequestSchema,
  payRefundRequestSchema,
  uuidSchema,
  voidReceiptRequestSchema,
  type CloseShiftRequest,
  type CollectPaymentRequest,
  type ListShiftsQuery,
  type OpenShiftRequest,
  type PayRefundRequest,
  type VoidReceiptRequest,
} from './cash.schemas.js';

/**
 * `/api/v1/cash` — NC-001 §6.
 *
 * **Why the two money-out routes are decorated `receipt.collect`.** Their real
 * authorities — `receipt.refund.pay` and `receipt.void` — are both flagged
 * `requiresSecondPerson` in the permission catalogue, and the global
 * `PolicyGuard` evaluates a route's key with no co-signer available to it, so a
 * route carrying either key would be refused for everybody, always. The keys are
 * therefore asserted inside the service through the same policy engine with the
 * co-signer attached (see `CoSignService`), and the decorator here holds the
 * genuine precondition: you cannot take money out of a drawer you are not
 * operating. A cashier who holds `receipt.collect` and not `receipt.refund.pay`
 * passes this decorator and is refused by the service — which is the intended
 * outcome, and is what the integration suite asserts.
 */
@Controller('cash')
export class CashController {
  constructor(
    @Inject(ShiftsService) private readonly shifts: ShiftsService,
    @Inject(PaymentsService) private readonly payments: PaymentsService,
  ) {}

  @Permission('receipt.shift.open')
  @Post('shifts/open')
  async openShift(@Body(new ZodBody(openShiftRequestSchema)) body: OpenShiftRequest): Promise<ShiftView> {
    return this.shifts.open(body);
  }

  @Permission('receipt.shift.list')
  @Get('shifts')
  async listShifts(
    @Query(new ZodBody(listShiftsQuerySchema)) query: ListShiftsQuery,
  ): Promise<Page<unknown>> {
    return this.shifts.list(query);
  }

  @Permission('receipt.shift.read')
  @Get('shifts/:id')
  async getShift(@Param('id', new ZodBody(uuidSchema)) id: string): Promise<ShiftView> {
    return this.shifts.get(id);
  }

  @Permission('receipt.shift.close')
  @Get('shifts/:id/close-preview')
  async closePreview(@Param('id', new ZodBody(uuidSchema)) id: string): Promise<ShiftView> {
    return this.shifts.closePreview(id);
  }

  @Permission('receipt.shift.close')
  @Post('shifts/:id/close')
  async closeShift(
    @Param('id', new ZodBody(uuidSchema)) id: string,
    @Body(new ZodBody(closeShiftRequestSchema)) body: CloseShiftRequest,
  ): Promise<ShiftView> {
    return this.shifts.close(id, body);
  }

  @Permission('receipt.shift.variance.approve')
  @Post('shifts/:id/variance/approve')
  async approveVariance(@Param('id', new ZodBody(uuidSchema)) id: string): Promise<ShiftView> {
    return this.shifts.approveVariance(id);
  }

  @Permission('receipt.collect')
  @Post('payments')
  async collect(
    @Body(new ZodBody(collectPaymentRequestSchema)) body: CollectPaymentRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PaymentView> {
    const key = typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : null;
    return this.payments.collect(body, key);
  }

  @Permission('receipt.collect')
  @Post('refunds/:id/pay')
  async payRefund(
    @Param('id', new ZodBody(uuidSchema)) id: string,
    @Body(new ZodBody(payRefundRequestSchema)) body: PayRefundRequest,
  ): Promise<RefundView> {
    return this.payments.payRefund(id, body);
  }

  @Permission('receipt.collect')
  @Post('receipts/:id/void')
  async voidReceipt(
    @Param('id', new ZodBody(uuidSchema)) id: string,
    @Body(new ZodBody(voidReceiptRequestSchema)) body: VoidReceiptRequest,
  ): Promise<PaymentView> {
    return this.payments.voidReceipt(id, body);
  }
}
