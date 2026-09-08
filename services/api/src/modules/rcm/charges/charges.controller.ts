import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { ChargesService } from './charges.service.js';
import {
  pendingQuerySchema,
  postChargesSchema,
  reverseChargeSchema,
  type PendingQuery,
  type PostChargesRequest,
  type ReverseChargeRequest,
} from './charges.schemas.js';
import type { ChargeIntentRow, PostChargesResult } from './charges.types.js';

/**
 * `/api/v1/charges/*` — RC-006, the bridge from a clinical act to a bill line.
 *
 * ── No route raises a charge ───────────────────────────────────────────────
 *
 * Intents are raised by the module that did the work, in the transaction that
 * recorded it. A route here that could raise one would be a route that bills a
 * patient for something no console has any record of.
 *
 * ── And none prices one ────────────────────────────────────────────────────
 *
 * Posting resolves the rate through RC-003 against the tariff in force on the
 * day and the payer on the bill. There is no `unitPrice` field, because a
 * biller who could type a price would be a second pricing engine.
 */
@Controller()
export class ChargesController {
  constructor(@Inject(ChargesService) private readonly svc: ChargesService) {}

  /** What has been done and not yet billed. */
  @Permission('bill.read')
  @Get('billing/charges/pending')
  async listPending(
    @Query(new ZodBody(pendingQuerySchema)) query: PendingQuery,
  ): Promise<readonly ChargeIntentRow[]> {
    return this.svc.listPending(query);
  }

  @Permission('bill.item.post')
  @Idempotent()
  @Post('billing/bills/:id/post-charges')
  async post(
    @Param('id') id: string,
    @Body(new ZodBody(postChargesSchema)) body: PostChargesRequest,
  ): Promise<PostChargesResult> {
    return this.svc.post(id, body);
  }

  /** A billed line is reversed with a reason, never cancelled. */
  @Permission('bill.item.reverse')
  @Post('billing/charges/:id/reverse')
  async reverse(
    @Param('id') id: string,
    @Body(new ZodBody(reverseChargeSchema)) body: ReverseChargeRequest,
  ): Promise<ChargeIntentRow> {
    return this.svc.reverse(id, body);
  }
}
