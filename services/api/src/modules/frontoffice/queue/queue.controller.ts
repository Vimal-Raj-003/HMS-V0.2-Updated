import { Body, Controller, Get, Headers, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { QueueService, type BoardView, type TokenView } from './queue.service.js';
import {
  callNextRequestSchema,
  issueTokenRequestSchema,
  listTokensQuerySchema,
  skipTokenRequestSchema,
  transferTokenRequestSchema,
  uuidSchema,
  type CallNextRequest,
  type IssueTokenRequest,
  type ListTokensQuery,
  type SkipTokenRequest,
  type TransferTokenRequest,
} from './queue.schemas.js';

/**
 * `/api/v1/queue` — EN-006 §6.
 *
 * The three keys used here are graded the way the module spec grades them:
 * `queue.token.issue` and `queue.board.read` are marked `clinicalSafetyExempt`
 * in the catalogue, so an unpaid licence or a degraded tier can never stop a
 * hospital handing out a token or a board showing who is next (EN-040 §5).
 * `queue.token.call` is the console key and carries the ABAC `ownQueueOnly`
 * condition; `queue.token.manage` is the supervisor key for transfers and
 * carries `requiresReason`, which is why those routes need an `x-reason` header.
 */
@Controller('queue')
export class QueueController {
  constructor(@Inject(QueueService) private readonly queue: QueueService) {}

  @Permission('queue.token.issue')
  @Post('tokens')
  async issue(
    @Body(new ZodBody(issueTokenRequestSchema)) body: IssueTokenRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<TokenView> {
    const key = typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : null;
    return this.queue.issue(body, key);
  }

  @Permission('queue.token.read')
  @Get('tokens')
  async list(@Query(new ZodBody(listTokensQuerySchema)) query: ListTokensQuery): Promise<Page<TokenView>> {
    return this.queue.list(query);
  }

  @Permission('queue.token.read')
  @Get('tokens/:id')
  async get(@Param('id', new ZodBody(uuidSchema)) id: string): Promise<TokenView> {
    return this.queue.get(id);
  }

  @Permission('queue.board.read')
  @Get('queues/:id/live')
  async board(@Param('id', new ZodBody(uuidSchema)) id: string): Promise<BoardView> {
    return this.queue.board(id);
  }

  @Permission('queue.token.call')
  @Post('queues/:id/call-next')
  async callNext(
    @Param('id', new ZodBody(uuidSchema)) id: string,
    @Body(new ZodBody(callNextRequestSchema)) body: CallNextRequest,
  ): Promise<TokenView> {
    return this.queue.callNext(id, body);
  }

  @Permission('queue.token.call')
  @Post('tokens/:id/recall')
  async recall(@Param('id', new ZodBody(uuidSchema)) id: string): Promise<TokenView> {
    return this.queue.recall(id);
  }

  @Permission('queue.token.call')
  @Post('tokens/:id/skip')
  async skip(
    @Param('id', new ZodBody(uuidSchema)) id: string,
    @Body(new ZodBody(skipTokenRequestSchema)) body: SkipTokenRequest,
  ): Promise<TokenView> {
    return this.queue.skip(id, body);
  }

  @Permission('queue.token.call')
  @Post('tokens/:id/complete')
  async complete(@Param('id', new ZodBody(uuidSchema)) id: string): Promise<TokenView> {
    return this.queue.complete(id);
  }

  @Permission('queue.token.manage')
  @Post('tokens/:id/transfer')
  async transfer(
    @Param('id', new ZodBody(uuidSchema)) id: string,
    @Body(new ZodBody(transferTokenRequestSchema)) body: TransferTokenRequest,
  ): Promise<TokenView> {
    return this.queue.transfer(id, body);
  }
}
