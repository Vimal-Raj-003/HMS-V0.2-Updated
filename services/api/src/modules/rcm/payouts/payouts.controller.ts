import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { PayoutsService } from './payouts.service.js';
import {
  approveStatementSchema,
  computePeriodSchema,
  contractQuerySchema,
  createContractSchema,
  createRuleSchema,
  idSchema,
  openPeriodSchema,
  payStatementSchema,
  periodQuerySchema,
  raiseDisputeSchema,
  resolveDisputeSchema,
  statementQuerySchema,
  tdsQuerySchema,
  type ApproveStatementRequest,
  type ComputePeriodRequest,
  type ContractQuery,
  type CreateContractRequest,
  type CreateRuleRequest,
  type OpenPeriodRequest,
  type PayStatementRequest,
  type PeriodQuery,
  type RaiseDisputeRequest,
  type ResolveDisputeRequest,
  type StatementQuery,
  type TdsQuery,
} from './payouts.schemas.js';
import type {
  ComputeResultView,
  PayoutContractView,
  PayoutPeriodView,
  PayoutStatementDetailView,
  PayoutStatementView,
  PayoutTdsView,
} from './payouts.types.js';

/**
 * `/api/v1/payouts/*` — NC-034.
 *
 * ── There is no route that pays for a referral ──────────────────────────────
 *
 * Not because one is blocked, but because the shape does not exist: the basis
 * enum has no `per_referral`, the source enum has no `referral`, and the
 * database refuses a line whose bill item names the earning doctor as the
 * referrer with somebody else as the performer. §5.7 asked for
 * *unrepresentable*, and that is three layers rather than a validation.
 *
 * `POST /periods/:id/compute` reports `referralsRefused`. A non-zero count is
 * not a bug report — it means somebody's fee-share rules are reaching for
 * services the doctor did not perform, and that is worth someone looking at.
 *
 * ── Compute and approve are two keys held by two roles ──────────────────────
 *
 * A payout statement is an outbound payment authorised on the strength of a
 * calculation nobody else has checked. Finance computes and pays; the hospital
 * admin approves. The catalogue carries a `block` rule and the database carries
 * the same check.
 */
@Controller('payouts')
export class PayoutsController {
  constructor(@Inject(PayoutsService) private readonly payouts: PayoutsService) {}

  // ── Contracts ──────────────────────────────────────────────────────────────

  @Permission('payout.contract.read')
  @Get('contracts')
  async listContracts(
    @Query(new ZodBody(contractQuerySchema)) query: ContractQuery,
  ): Promise<Page<PayoutContractView>> {
    return this.payouts.listContracts(query);
  }

  @Permission('payout.contract.manage')
  @Idempotent()
  @Post('contracts')
  async createContract(
    @Body(new ZodBody(createContractSchema)) body: CreateContractRequest,
  ): Promise<PayoutContractView> {
    return this.payouts.createContract(body);
  }

  @Permission('payout.contract.manage')
  @Idempotent()
  @Post('rules')
  async createRule(
    @Body(new ZodBody(createRuleSchema)) body: CreateRuleRequest,
  ): Promise<PayoutContractView> {
    return this.payouts.createRule(body);
  }

  // ── Periods ────────────────────────────────────────────────────────────────

  @Permission('payout.period.read')
  @Get('periods')
  async listPeriods(
    @Query(new ZodBody(periodQuerySchema)) query: PeriodQuery,
  ): Promise<Page<PayoutPeriodView>> {
    return this.payouts.listPeriods(query);
  }

  @Permission('payout.period.manage')
  @Idempotent()
  @Post('periods')
  async openPeriod(@Body(new ZodBody(openPeriodSchema)) body: OpenPeriodRequest): Promise<PayoutPeriodView> {
    return this.payouts.openPeriod(body);
  }

  /** Builds every statement from what each doctor performed. See the class note. */
  @Permission('payout.statement.compute')
  @Idempotent()
  @Post('periods/:id/compute')
  async computePeriod(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(computePeriodSchema)) body: ComputePeriodRequest,
  ): Promise<ComputeResultView> {
    return this.payouts.computePeriod(id, body);
  }

  // ── Statements ─────────────────────────────────────────────────────────────

  @Permission('payout.tds.read')
  @Get('tds')
  async listTds(@Query(new ZodBody(tdsQuerySchema)) query: TdsQuery): Promise<Page<PayoutTdsView>> {
    return this.payouts.listTds(query);
  }

  @Permission('payout.statement.list')
  @Get('statements')
  async listStatements(
    @Query(new ZodBody(statementQuerySchema)) query: StatementQuery,
  ): Promise<Page<PayoutStatementView>> {
    return this.payouts.listStatements(query);
  }

  @Permission('payout.statement.read')
  @Get('statements/:id')
  async getStatement(@Param('id', new ZodBody(idSchema)) id: string): Promise<PayoutStatementDetailView> {
    return this.payouts.getStatement(id);
  }

  /** The second pair of hands. Refused while a dispute is open. */
  @Permission('payout.statement.approve')
  @Idempotent()
  @Post('statements/:id/approve')
  async approveStatement(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveStatementSchema)) body: ApproveStatementRequest,
  ): Promise<PayoutStatementDetailView> {
    return this.payouts.approveStatement(id, body);
  }

  @Permission('payout.statement.pay')
  @Idempotent()
  @Post('statements/:id/pay')
  async payStatement(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(payStatementSchema)) body: PayStatementRequest,
  ): Promise<PayoutStatementDetailView> {
    return this.payouts.payStatement(id, body);
  }

  // ── Disputes ───────────────────────────────────────────────────────────────

  @Permission('payout.dispute.raise')
  @Idempotent()
  @Post('statements/:id/disputes')
  async raiseDispute(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(raiseDisputeSchema)) body: RaiseDisputeRequest,
  ): Promise<PayoutStatementDetailView> {
    return this.payouts.raiseDispute(id, body);
  }

  @Permission('payout.dispute.resolve')
  @Idempotent()
  @Post('disputes/:id/resolve')
  async resolveDispute(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(resolveDisputeSchema)) body: ResolveDisputeRequest,
  ): Promise<PayoutStatementDetailView> {
    return this.payouts.resolveDispute(id, body);
  }
}
