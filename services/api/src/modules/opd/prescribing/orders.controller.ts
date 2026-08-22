import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { OrdersService } from './orders.service.js';
import {
  cancelOrderSchema,
  createOrderSchema,
  idSchema,
  orderQuerySchema,
  type CancelOrderRequest,
  type CreateOrderRequest,
  type OrderQuery,
} from './prescribing.schemas.js';
import type { OrderView } from './prescribing.types.js';

/**
 * `/api/v1/orders` — OP-002 §3.4, CPOE.
 *
 * `POST /orders` is `@Idempotent()` because it creates both an order and the
 * money that follows it: a retried radiology order is a second scan and a second
 * charge. Cancellation is idempotent for the same reason in reverse — a retried
 * cancel must not reverse the charge twice.
 */
@Controller('orders')
export class OrdersController {
  constructor(@Inject(OrdersService) private readonly orders: OrdersService) {}

  @Permission('order.create')
  @Idempotent()
  @Post()
  async create(@Body(new ZodBody(createOrderSchema)) body: CreateOrderRequest): Promise<OrderView> {
    return this.orders.create(body);
  }

  @Permission('order.list')
  @Get()
  async list(@Query(new ZodBody(orderQuerySchema)) query: OrderQuery): Promise<Page<OrderView>> {
    return this.orders.list(query);
  }

  @Permission('order.list')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<OrderView> {
    return this.orders.get(id);
  }

  /** OP-002 §3.4.7 — cancellation always carries a reason, and reverses the charge. */
  @Permission('order.cancel')
  @Idempotent()
  @Post(':id/cancel')
  async cancel(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelOrderSchema)) body: CancelOrderRequest,
  ): Promise<OrderView> {
    return this.orders.cancel(id, body);
  }
}
