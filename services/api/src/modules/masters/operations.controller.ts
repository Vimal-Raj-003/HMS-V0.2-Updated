import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import {
  listCashCountersQuerySchema,
  listQueuesQuerySchema,
  type ListCashCountersQuery,
  type ListQueuesQuery,
} from './masters.schemas.js';
import {
  MastersOperationsService,
  type CashCounterListItem,
  type QueueDefinitionListItem,
} from './operations.service.js';

/**
 * `/api/v1/queues` — the queue definitions of a branch (EN-006 §6).
 *
 * The queue module owns `/queue/**` (tokens, calling, the live board) and this
 * route is `/queues`, so nothing collides: `QueueController` mounts
 * `/queue/queues/{id}/live`, not `/queues`.
 */
@Controller('queues')
export class QueueDefinitionsController {
  constructor(@Inject(MastersOperationsService) private readonly masters: MastersOperationsService) {}

  @Permission('queue.board.read')
  @Get()
  async list(
    @Query(new ZodBody(listQueuesQuerySchema)) query: ListQueuesQuery,
  ): Promise<Page<QueueDefinitionListItem>> {
    return this.masters.listQueues(query);
  }
}

/**
 * `/api/v1/cash/counters` — NC-001 §6.
 *
 * The prefix is shared with `CashController`, which owns `/cash/shifts/**`,
 * `/cash/payments`, `/cash/refunds/**` and `/cash/receipts/**`. `GET
 * /cash/counters` is not among them, so this mounts alongside rather than
 * shadowing — Fastify would refuse the route outright if it did.
 */
@Controller('cash')
export class CashCountersController {
  constructor(@Inject(MastersOperationsService) private readonly masters: MastersOperationsService) {}

  @Permission('receipt.shift.open')
  @Get('counters')
  async list(
    @Query(new ZodBody(listCashCountersQuerySchema)) query: ListCashCountersQuery,
  ): Promise<Page<CashCounterListItem>> {
    return this.masters.listCashCounters(query);
  }
}
