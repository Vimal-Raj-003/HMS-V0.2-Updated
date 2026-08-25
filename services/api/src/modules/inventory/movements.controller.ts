import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import { AdjustmentsService } from './adjustments.service.js';
import { IndentsService } from './indents.service.js';
import {
  adjustmentQuerySchema,
  approveAdjustmentSchema,
  approveCountSchema,
  approveIndentSchema,
  countLinesSchema,
  countQuerySchema,
  createAdjustmentSchema,
  createCountPlanSchema,
  createIssueSchema,
  createReturnToStoreSchema,
  createStoreIndentSchema,
  createTransferSchema,
  dispatchTransferSchema,
  idSchema,
  inspectReturnSchema,
  receiveIssueSchema,
  receiveTransferSchema,
  rejectSchema,
  storeQuerySchema,
  transferQuerySchema,
  type AdjustmentQuery,
  type ApproveAdjustmentRequest,
  type ApproveCountRequest,
  type ApproveIndentRequest,
  type CountLinesRequest,
  type CountQuery,
  type CreateAdjustmentRequest,
  type CreateCountPlanRequest,
  type CreateIssueRequest,
  type CreateReturnToStoreRequest,
  type CreateStoreIndentRequest,
  type CreateTransferRequest,
  type DispatchTransferRequest,
  type InspectReturnRequest,
  type ReceiveIssueRequest,
  type ReceiveTransferRequest,
  type RejectRequest,
  type StoreQuery,
  type TransferQuery,
} from './inventory.schemas.js';
import type { DocumentView } from './inventory.types.js';
import { TransfersService } from './transfers.service.js';

/**
 * `/api/v1/inventory/*` — the documents that move stock inside the hospital.
 *
 * Every POST here is `@Idempotent()` without exception. A retried issue is a
 * second issue: the ward gets twice the stock and the store's shelf is short by
 * the same, and the retry is exactly what a tablet on a ward's Wi-Fi does when
 * the lift doors close. The same argument applies in reverse to a receipt, an
 * adjustment and a count posting.
 */
@Controller('inventory')
export class InventoryMovementsController {
  constructor(
    @Inject(IndentsService) private readonly indents: IndentsService,
    @Inject(TransfersService) private readonly transfers: TransfersService,
    @Inject(AdjustmentsService) private readonly adjustments: AdjustmentsService,
  ) {}

  // ── store indents ────────────────────────────────────────────────────────

  @Permission('inventory.store_indent.create')
  @Idempotent()
  @Post('indents')
  async createIndent(
    @Body(new ZodBody(createStoreIndentSchema)) body: CreateStoreIndentRequest,
  ): Promise<DocumentView> {
    return this.indents.createIndent(body);
  }

  @Permission('inventory.store_indent.list')
  @Get('indents')
  async listIndents(@Query(new ZodBody(storeQuerySchema)) query: StoreQuery): Promise<Page<DocumentView>> {
    return this.indents.listIndents(query);
  }

  @Permission('inventory.store_indent.read')
  @Get('indents/:id')
  async indent(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.indents.indent(id);
  }

  @Permission('inventory.store_indent.approve')
  @Idempotent()
  @Post('indents/:id/approve')
  async approveIndent(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveIndentSchema)) body: ApproveIndentRequest,
  ): Promise<DocumentView> {
    return this.indents.approveIndent(id, body);
  }

  @Permission('inventory.store_indent.approve')
  @Idempotent()
  @Post('indents/:id/reject')
  async rejectIndent(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(rejectSchema)) body: RejectRequest,
  ): Promise<DocumentView> {
    return this.indents.rejectIndent(id, body);
  }

  /** FEFO's suggestion, written down so an override has to be justified. */
  @Permission('inventory.issue.pick')
  @Idempotent()
  @Post('indents/:id/pick-list')
  async pickList(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.indents.pickList(id);
  }

  // ── issues ───────────────────────────────────────────────────────────────

  @Permission('inventory.issue.create')
  @Idempotent()
  @Post('issues')
  async createIssue(@Body(new ZodBody(createIssueSchema)) body: CreateIssueRequest): Promise<DocumentView> {
    return this.indents.createIssue(body);
  }

  @Permission('inventory.issue.list')
  @Get('issues')
  async listIssues(@Query(new ZodBody(storeQuerySchema)) query: StoreQuery): Promise<Page<DocumentView>> {
    return this.indents.listIssues(query);
  }

  @Permission('inventory.issue.receive')
  @Idempotent()
  @Post('issues/:id/receive')
  async receiveIssue(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(receiveIssueSchema)) body: ReceiveIssueRequest,
  ): Promise<DocumentView> {
    return this.indents.receiveIssue(id, body);
  }

  // ── returns to store ─────────────────────────────────────────────────────

  @Permission('inventory.return.create')
  @Idempotent()
  @Post('returns')
  async createReturn(
    @Body(new ZodBody(createReturnToStoreSchema)) body: CreateReturnToStoreRequest,
  ): Promise<DocumentView> {
    return this.indents.createReturn(body);
  }

  @Permission('inventory.return.read')
  @Get('returns/:id')
  async storeReturn(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.indents.storeReturn(id);
  }

  @Permission('inventory.return.inspect')
  @Idempotent()
  @Post('returns/:id/inspect')
  async inspectReturn(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(inspectReturnSchema)) body: InspectReturnRequest,
  ): Promise<DocumentView> {
    return this.indents.inspectReturn(id, body);
  }

  // ── transfers ────────────────────────────────────────────────────────────

  @Permission('inventory.transfer.create')
  @Idempotent()
  @Post('transfers')
  async createTransfer(
    @Body(new ZodBody(createTransferSchema)) body: CreateTransferRequest,
  ): Promise<DocumentView> {
    return this.transfers.create(body);
  }

  @Permission('inventory.transfer.list')
  @Get('transfers')
  async listTransfers(
    @Query(new ZodBody(transferQuerySchema)) query: TransferQuery,
  ): Promise<Page<DocumentView>> {
    return this.transfers.list(query);
  }

  @Permission('inventory.transfer.read')
  @Get('transfers/:id')
  async transfer(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.transfers.get(id);
  }

  @Permission('inventory.transfer.approve')
  @Idempotent()
  @Post('transfers/:id/approve')
  async approveTransfer(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.transfers.approve(id);
  }

  /** Stock leaves the sending store here and belongs to neither until receipt. */
  @Permission('inventory.transfer.dispatch')
  @Idempotent()
  @Post('transfers/:id/dispatch')
  async dispatchTransfer(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(dispatchTransferSchema)) body: DispatchTransferRequest,
  ): Promise<DocumentView> {
    return this.transfers.dispatch(id, body);
  }

  @Permission('inventory.transfer.receive')
  @Idempotent()
  @Post('transfers/:id/receive')
  async receiveTransfer(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(receiveTransferSchema)) body: ReceiveTransferRequest,
  ): Promise<DocumentView> {
    return this.transfers.receive(id, body);
  }

  @Permission('inventory.transfer.approve')
  @Idempotent()
  @Post('transfers/:id/cancel')
  async cancelTransfer(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(rejectSchema)) body: RejectRequest,
  ): Promise<DocumentView> {
    return this.transfers.cancel(id, body);
  }

  // ── adjustments ──────────────────────────────────────────────────────────

  @Permission('inventory.adjustment.create')
  @Idempotent()
  @Post('adjustments')
  async createAdjustment(
    @Body(new ZodBody(createAdjustmentSchema)) body: CreateAdjustmentRequest,
  ): Promise<DocumentView> {
    return this.adjustments.create(body);
  }

  @Permission('inventory.adjustment.list')
  @Get('adjustments')
  async listAdjustments(
    @Query(new ZodBody(adjustmentQuerySchema)) query: AdjustmentQuery,
  ): Promise<Page<DocumentView>> {
    return this.adjustments.list(query);
  }

  @Permission('inventory.adjustment.read')
  @Get('adjustments/:id')
  async adjustment(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.adjustments.get(id);
  }

  /** Approves and posts. Maker ≠ checker, in this service and in the database. */
  @Permission('inventory.adjustment.approve')
  @Idempotent()
  @Post('adjustments/:id/approve')
  async approveAdjustment(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveAdjustmentSchema)) body: ApproveAdjustmentRequest,
  ): Promise<DocumentView> {
    return this.adjustments.approve(id, body);
  }

  // ── counts ───────────────────────────────────────────────────────────────

  @Permission('inventory.count.plan')
  @Idempotent()
  @Post('counts/plans')
  async createCount(
    @Body(new ZodBody(createCountPlanSchema)) body: CreateCountPlanRequest,
  ): Promise<DocumentView> {
    return this.adjustments.createCountPlan(body);
  }

  @Permission('inventory.count.list')
  @Get('counts/plans')
  async listCounts(@Query(new ZodBody(countQuerySchema)) query: CountQuery): Promise<Page<DocumentView>> {
    return this.adjustments.listCounts(query);
  }

  @Permission('inventory.count.read')
  @Get('counts/plans/:id')
  async count(@Param('id', new ZodBody(idSchema)) id: string): Promise<DocumentView> {
    return this.adjustments.countPlan(id);
  }

  @Permission('inventory.count.count')
  @Idempotent()
  @Post('counts/sheets/:id/lines')
  async recordCount(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(countLinesSchema)) body: CountLinesRequest,
  ): Promise<DocumentView> {
    return this.adjustments.recordCount(id, body);
  }

  @Permission('inventory.count.approve')
  @Idempotent()
  @Post('counts/plans/:id/approve')
  async approveCount(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveCountSchema)) body: ApproveCountRequest,
  ): Promise<DocumentView> {
    return this.adjustments.approveCount(id, body);
  }
}
