import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { BudgetService } from './budget.service.js';
import {
  checkSchema,
  commitSchema,
  createCycleSchema,
  createLineSchema,
  releaseSchema,
  reviseLineSchema,
  setCycleStatusSchema,
  virementSchema,
  type BudgetPositionRow,
  type CheckRequest,
  type CheckResult,
  type CommitRequest,
  type CommitmentRow,
  type CreateCycleRequest,
  type CreateLineRequest,
  type CycleRow,
  type ReleaseRequest,
  type ReviseLineRequest,
  type RevisionRow,
  type SetCycleStatusRequest,
  type VirementRequest,
} from './budget.schemas.js';

/**
 * `/api/v1/finance/budget/*` — NC-022.
 *
 * ── There is no route that overrides the limit ────────────────────────────
 *
 * A commitment that exceeds its line is refused by a trigger, and no endpoint
 * here can ask it not to be. An override — even one behind a permission — is a
 * way to make the control optional, and a control that can be waived under
 * pressure is waived exactly when it matters: at the year end, by the person
 * with the most authority and the least time.
 *
 * The legitimate answers are all here and all leave a record: revise the line,
 * virement budget from another, or reduce the order.
 *
 * ── `POST /check` is advisory and says so ─────────────────────────────────
 *
 * It exists so a buyer learns the money is gone before filling in twenty
 * lines. Its own message tells the caller it is not a promise.
 */
@Controller('finance/budget')
export class BudgetController {
  constructor(@Inject(BudgetService) private readonly svc: BudgetService) {}

  @Permission('finance.budget.read')
  @Get('cycles')
  async listCycles(): Promise<readonly CycleRow[]> {
    return this.svc.listCycles();
  }

  @Permission('finance.budget.manage')
  @Post('cycles')
  async createCycle(@Body(new ZodBody(createCycleSchema)) body: CreateCycleRequest): Promise<CycleRow> {
    return this.svc.createCycle(body);
  }

  /** Activating a cycle is what makes its lines binding. */
  @Permission('finance.budget.manage')
  @Patch('cycles/:id/status')
  async setCycleStatus(
    @Param('id') id: string,
    @Body(new ZodBody(setCycleStatusSchema)) body: SetCycleStatusRequest,
  ): Promise<CycleRow> {
    return this.svc.setCycleStatus(id, body);
  }

  /** Budget, committed, actual and what is left — the whole worklist. */
  @Permission('finance.budget.read')
  @Get('position')
  async position(@Query('cycleId') cycleId?: string): Promise<readonly BudgetPositionRow[]> {
    return this.svc.position(cycleId);
  }

  @Permission('finance.budget.manage')
  @Post('lines')
  async createLine(@Body(new ZodBody(createLineSchema)) body: CreateLineRequest): Promise<BudgetPositionRow> {
    return this.svc.createLine(body);
  }

  @Permission('finance.budget.read')
  @Get('lines/:id/revisions')
  async listRevisions(@Param('id') id: string): Promise<readonly RevisionRow[]> {
    return this.svc.listRevisions(id);
  }

  /** The new figure, not a delta — see the schema for why. */
  @Permission('finance.budget.revise')
  @Idempotent()
  @Post('lines/:id/revisions')
  async reviseLine(
    @Param('id') id: string,
    @Body(new ZodBody(reviseLineSchema)) body: ReviseLineRequest,
  ): Promise<BudgetPositionRow> {
    return this.svc.reviseLine(id, body);
  }

  /**
   * Idempotent: a retried virement that moved money once must not move it
   * twice. The approver is the authenticated user and may not be
   * `requestedBy`.
   */
  @Permission('finance.budget.virement')
  @Idempotent()
  @Post('virements')
  async virement(
    @Body(new ZodBody(virementSchema)) body: VirementRequest,
  ): Promise<readonly BudgetPositionRow[]> {
    return this.svc.virement(body);
  }

  /** Advisory. The binding answer is the trigger on the commitment itself. */
  @Permission('finance.budget.read')
  @Post('check')
  async check(@Body(new ZodBody(checkSchema)) body: CheckRequest): Promise<CheckResult> {
    return this.svc.check(body);
  }

  @Permission('finance.budget.read')
  @Get('commitments')
  async listCommitments(@Query('lineId') lineId?: string): Promise<readonly CommitmentRow[]> {
    return this.svc.listCommitments(lineId);
  }

  /** Idempotent: a retried indent must not reserve the budget twice. */
  @Permission('finance.budget.commit')
  @Idempotent()
  @Post('commitments')
  async commit(@Body(new ZodBody(commitSchema)) body: CommitRequest): Promise<CommitmentRow> {
    return this.svc.commit(body);
  }

  @Permission('finance.budget.release')
  @Patch('commitments/:id/release')
  async release(
    @Param('id') id: string,
    @Body(new ZodBody(releaseSchema)) body: ReleaseRequest,
  ): Promise<CommitmentRow> {
    return this.svc.release(id, body);
  }
}
