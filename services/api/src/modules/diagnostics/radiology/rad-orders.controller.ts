import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { RadOrdersService } from './rad-orders.service.js';
import {
  cancelRadOrderSchema,
  checkInSchema,
  createAppointmentSchema,
  createRadOrderSchema,
  idSchema,
  publishMwlSchema,
  radOrderQuerySchema,
  safetyScreenSchema,
  withdrawMwlSchema,
  type CancelRadOrderRequest,
  type CheckInRequest,
  type CreateAppointmentRequest,
  type CreateRadOrderRequest,
  type PublishMwlRequest,
  type RadOrderQuery,
  type SafetyScreenRequest,
  type WithdrawMwlRequest,
} from './radiology.schemas.js';
import type { RadOrderView } from './radiology.types.js';

/**
 * `/api/v1/rad` — OP-008 §6, the order and schedule half.
 *
 * Every write is `@Idempotent()`. `CLAUDE.md` §3 requires it on order-creating
 * endpoints, and imaging has a second reason on top of the usual one: a retried
 * order would burn a second `RAD_ACC` accession number, and two accessions for
 * one exposure is the state in which a modality worklist offers the technologist
 * a choice between two identical patients.
 *
 * The read routes are gated on `rad.order.read` / `rad.order.list` rather than
 * on the write key, so the front desk and the technologist — who never create an
 * order — can still open the one in front of them.
 */
@Controller()
export class RadOrdersController {
  constructor(@Inject(RadOrdersService) private readonly orders: RadOrdersService) {}

  @Permission('rad.order.create')
  @Idempotent()
  @Post('rad/orders')
  async create(@Body(new ZodBody(createRadOrderSchema)) body: CreateRadOrderRequest): Promise<RadOrderView> {
    return this.orders.create(body);
  }

  @Permission('rad.order.list')
  @Get('rad/orders')
  async list(@Query(new ZodBody(radOrderQuerySchema)) query: RadOrderQuery): Promise<Page<RadOrderView>> {
    return this.orders.list(query);
  }

  @Permission('rad.order.read')
  @Get('rad/orders/:id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<RadOrderView> {
    return this.orders.get(id);
  }

  /** OP-008 §3.1.2 — pregnancy, contrast/renal, allergy and MRI answers. */
  @Permission('rad.order.update')
  @Idempotent()
  @Patch('rad/orders/:id/safety-screen')
  async safetyScreen(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(safetyScreenSchema)) body: SafetyScreenRequest,
  ): Promise<RadOrderView> {
    return this.orders.safetyScreen(id, body);
  }

  /**
   * `rad.order.cancel` is `requiresReason` in the catalogue, so the policy guard
   * demands an `x-reason` header before the handler runs; the body's `reason` is
   * the one stored on the order and shown to the referring doctor.
   */
  @Permission('rad.order.cancel')
  @Idempotent()
  @Post('rad/orders/:id/cancel')
  async cancel(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelRadOrderSchema)) body: CancelRadOrderRequest,
  ): Promise<RadOrderView> {
    return this.orders.cancel(id, body);
  }

  @Permission('rad.schedule.manage')
  @Idempotent()
  @Post('rad/appointments')
  async schedule(
    @Body(new ZodBody(createAppointmentSchema)) body: CreateAppointmentRequest,
  ): Promise<RadOrderView> {
    return this.orders.schedule(body);
  }

  @Permission('rad.schedule.manage')
  @Idempotent()
  @Post('rad/orders/:id/check-in')
  async checkIn(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(checkInSchema)) body: CheckInRequest,
  ): Promise<RadOrderView> {
    return this.orders.checkIn(id, body);
  }

  /** OP-008 §3.3.1 — the worklist the scanners query. EN-035 §2 puts it in EN-008. */
  @Permission('rad.mwl.manage')
  @Idempotent()
  @Post('rad/order-items/:id/mwl/publish')
  async publishMwl(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(publishMwlSchema)) body: PublishMwlRequest,
  ): Promise<{ readonly entryId: string }> {
    return this.orders.publishMwl(id, body);
  }

  @Permission('rad.mwl.manage')
  @Idempotent()
  @Post('rad/order-items/:id/mwl/withdraw')
  async withdrawMwl(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(withdrawMwlSchema)) body: WithdrawMwlRequest,
  ): Promise<{ readonly withdrawn: number }> {
    return this.orders.withdrawMwl(id, body);
  }
}
