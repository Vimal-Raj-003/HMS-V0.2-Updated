import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { InsuranceService } from './insurance.service.js';
import {
  capturePolicySchema,
  caseQuerySchema,
  createPayerSchema,
  createPreauthSchema,
  idSchema,
  openCaseSchema,
  payerQuerySchema,
  preauthQuerySchema,
  raiseQuerySchema,
  recordDecisionSchema,
  replyQuerySchema,
  submitPreauthSchema,
  withdrawPreauthSchema,
  type CapturePolicyRequest,
  type CaseQuery,
  type CreatePayerRequest,
  type CreatePreauthRequest,
  type OpenCaseRequest,
  type PayerQuery,
  type PreauthListQuery,
  type RaiseQueryRequest,
  type RecordDecisionRequest,
  type ReplyQueryRequest,
  type SubmitPreauthRequest,
  type WithdrawPreauthRequest,
} from './insurance.schemas.js';
import type {
  InsCaseView,
  PayerView,
  PolicyView,
  PreauthDetailView,
  PreauthQueryView,
  PreauthView,
} from './insurance.types.js';

/**
 * `/api/v1/insurance/*` — EN-002 and RC-002.
 *
 * `POST /preauths/:id/submit` and `POST /preauths/:id/decision` are two routes
 * on two keys held by two roles with a `block` rule behind them. That is not
 * ceremony: a recorded approval becomes a credit limit billing honours and a
 * ward acts on, so the person waiting for the payer must not be able to type in
 * what the payer said.
 *
 * `POST /preauths/:id/queries` records an *inbound* payer question. It is on the
 * reply key rather than a create key because the desk is transcribing what the
 * insurer asked, not asking anything.
 */
@Controller('insurance')
export class InsuranceController {
  constructor(@Inject(InsuranceService) private readonly insurance: InsuranceService) {}

  @Permission('ins.payer.list')
  @Get('payers')
  async listPayers(@Query(new ZodBody(payerQuerySchema)) query: PayerQuery): Promise<Page<PayerView>> {
    return this.insurance.listPayers(query);
  }

  @Permission('ins.payer.configure')
  @Idempotent()
  @Post('payers')
  async createPayer(@Body(new ZodBody(createPayerSchema)) body: CreatePayerRequest): Promise<PayerView> {
    return this.insurance.createPayer(body);
  }

  @Permission('ins.policy.manage')
  @Idempotent()
  @Post('policies')
  async capturePolicy(
    @Body(new ZodBody(capturePolicySchema)) body: CapturePolicyRequest,
  ): Promise<PolicyView> {
    return this.insurance.capturePolicy(body);
  }

  @Permission('ins.case.list')
  @Get('cases')
  async listCases(@Query(new ZodBody(caseQuerySchema)) query: CaseQuery): Promise<Page<InsCaseView>> {
    return this.insurance.listCases(query);
  }

  @Permission('ins.case.manage')
  @Idempotent()
  @Post('cases')
  async openCase(@Body(new ZodBody(openCaseSchema)) body: OpenCaseRequest): Promise<InsCaseView> {
    return this.insurance.openCase(body);
  }

  @Permission('preauth.list')
  @Get('preauths')
  async listPreauths(
    @Query(new ZodBody(preauthQuerySchema)) query: PreauthListQuery,
  ): Promise<Page<PreauthView>> {
    return this.insurance.listPreauths(query);
  }

  @Permission('preauth.read')
  @Get('preauths/:id')
  async getPreauth(@Param('id', new ZodBody(idSchema)) id: string): Promise<PreauthDetailView> {
    return this.insurance.getPreauth(id);
  }

  @Permission('preauth.create')
  @Idempotent()
  @Post('preauths')
  async createPreauth(
    @Body(new ZodBody(createPreauthSchema)) body: CreatePreauthRequest,
  ): Promise<PreauthView> {
    return this.insurance.createPreauth(body);
  }

  /** Starts the decision clock. */
  @Permission('preauth.submit')
  @Idempotent()
  @Post('preauths/:id/submit')
  async submitPreauth(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(submitPreauthSchema)) body: SubmitPreauthRequest,
  ): Promise<PreauthView> {
    return this.insurance.submitPreauth(id, body);
  }

  /** A different key from submit, held by finance. See the class note. */
  @Permission('preauth.decision.record')
  @Idempotent()
  @Post('preauths/:id/decision')
  async recordDecision(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(recordDecisionSchema)) body: RecordDecisionRequest,
  ): Promise<PreauthView> {
    return this.insurance.recordDecision(id, body);
  }

  @Permission('preauth.query.reply')
  @Idempotent()
  @Post('preauths/:id/queries')
  async raiseQuery(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(raiseQuerySchema)) body: RaiseQueryRequest,
  ): Promise<PreauthQueryView> {
    return this.insurance.raiseQuery(id, body);
  }

  @Permission('preauth.query.reply')
  @Idempotent()
  @Post('queries/:id/reply')
  async replyQuery(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(replyQuerySchema)) body: ReplyQueryRequest,
  ): Promise<PreauthQueryView> {
    return this.insurance.replyQuery(id, body);
  }

  @Permission('preauth.withdraw')
  @Idempotent()
  @Post('preauths/:id/withdraw')
  async withdrawPreauth(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(withdrawPreauthSchema)) body: WithdrawPreauthRequest,
  ): Promise<PreauthView> {
    return this.insurance.withdrawPreauth(id, body);
  }
}
