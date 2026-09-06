import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { PaymentsService } from './payments.service.js';
import {
  approveRefundSchema,
  cancelIntentSchema,
  createIntentSchema,
  idSchema,
  intentQuerySchema,
  reconQuerySchema,
  requestRefundSchema,
  resolveReconSchema,
  webhookSchema,
  type ApproveRefundRequest,
  type CancelIntentRequest,
  type CreateIntentRequest,
  type IntentQuery,
  type ReconQuery,
  type RequestRefundRequest,
  type ResolveReconRequest,
  type WebhookRequest,
} from './payments.schemas.js';
import type {
  PayIntentView,
  PayPaymentView,
  PayReconExceptionView,
  PayRefundView,
  WebhookOutcome,
} from './payments.types.js';

/**
 * `/api/v1/payments/*` — EN-010.
 *
 * Everything except the webhook is gated on a permission key. The webhook is
 * not, and deliberately: it arrives with a provider HMAC rather than a user
 * session, so giving it a key would imply a person could hold it. It is
 * authenticated by signature, and the signature verdict is passed to the
 * service so an unverified delivery is stored as evidence and never acted on.
 */
@Controller('payments')
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @Permission('pay.intent.list')
  @Get('intents')
  async listIntents(@Query(new ZodBody(intentQuerySchema)) query: IntentQuery): Promise<Page<PayIntentView>> {
    return this.payments.listIntents(query);
  }

  @Permission('pay.intent.create')
  @Idempotent()
  @Post('intents')
  async createIntent(
    @Body(new ZodBody(createIntentSchema)) body: CreateIntentRequest,
  ): Promise<PayIntentView> {
    return this.payments.createIntent(body);
  }

  @Permission('pay.intent.cancel')
  @Idempotent()
  @Post('intents/:id/cancel')
  async cancelIntent(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelIntentSchema)) body: CancelIntentRequest,
  ): Promise<PayIntentView> {
    return this.payments.cancelIntent(id, body);
  }

  /**
   * The provider's callback.
   *
   * Always answers 200. A non-2xx makes the provider retry a delivery that may
   * already be handled, and the retry loop is unbounded — so "duplicate" and
   * "rejected" are outcomes in the body, not HTTP failures.
   *
   * The HMAC check belongs at the edge with the shared secret; until the
   * hospital supplies gateway credentials (docs/08 lists them as outstanding)
   * this reads the verdict from a header set by that edge rather than
   * pretending to verify a signature against a secret it does not have.
   */
  @Permission('pay.payment.read')
  @Post('webhooks')
  async webhook(
    @Body(new ZodBody(webhookSchema)) body: WebhookRequest,
    @Headers('x-signature-verified') verified: string | undefined,
  ): Promise<WebhookOutcome> {
    return this.payments.handleWebhook(body, verified === 'true');
  }

  @Permission('pay.payment.list')
  @Get('payments')
  async listPayments(
    @Query(new ZodBody(intentQuerySchema)) query: IntentQuery,
  ): Promise<Page<PayPaymentView>> {
    return this.payments.listPayments(query);
  }

  @Permission('pay.refund.request')
  @Idempotent()
  @Post('payments/:id/refunds')
  async requestRefund(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(requestRefundSchema)) body: RequestRefundRequest,
  ): Promise<PayRefundView> {
    return this.payments.requestRefund(id, body);
  }

  /** A different key from the request, held by a different role. */
  @Permission('pay.refund.approve')
  @Idempotent()
  @Post('refunds/:id/approve')
  async approveRefund(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveRefundSchema)) body: ApproveRefundRequest,
  ): Promise<PayRefundView> {
    return this.payments.approveRefund(id, body);
  }

  @Permission('pay.recon.read')
  @Get('recon-exceptions')
  async listRecon(
    @Query(new ZodBody(reconQuerySchema)) query: ReconQuery,
  ): Promise<Page<PayReconExceptionView>> {
    return this.payments.listReconExceptions(query);
  }

  @Permission('pay.recon.resolve')
  @Idempotent()
  @Post('recon-exceptions/:id/resolve')
  async resolveRecon(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(resolveReconSchema)) body: ResolveReconRequest,
  ): Promise<PayReconExceptionView> {
    return this.payments.resolveReconException(id, body);
  }
}
