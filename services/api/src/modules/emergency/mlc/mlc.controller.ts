import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { MlcService } from './mlc.service.js';
import {
  acknowledgeSchema,
  addendumSchema,
  answerRequestSchema,
  cancelCaseSchema,
  custodySchema,
  deathSchema,
  dispatchSchema,
  dyingDeclarationSchema,
  evidenceSchema,
  handoverSchema,
  idSchema,
  injurySchema,
  intimationSchema,
  openCaseSchema,
  overrideGateSchema,
  registerQuerySchema,
  reportSchema,
  requestSchema,
  sexualAssaultSchema,
  signReportSchema,
  updateCaseSchema,
  worklistQuerySchema,
  type AcknowledgeRequest,
  type AddendumRequest,
  type AnswerRequestRequest,
  type CustodyRequest,
  type DeathRequest,
  type DispatchRequest,
  type DyingDeclarationRequest,
  type EvidenceRequest,
  type HandoverRequest,
  type InjuryRequest,
  type IntimationRequest,
  type OpenCaseRequest,
  type RegisterQuery,
  type ReportRequest,
  type RequestRequest,
  type SexualAssaultRequest,
  type SignReportRequest,
  type UpdateCaseRequest,
  type WorklistQuery,
} from './mlc.schemas.js';
import type {
  MlcCaseDetailView,
  MlcCaseView,
  MlcDischargeGateView,
  MlcEvidenceView,
  MlcWorklistRow,
} from './mlc.types.js';

/**
 * `/api/v1/mlc/*` — TR-008.
 *
 * ── Nothing on this controller can stop treatment ───────────────────────────
 *
 * There is no endpoint here that an order, a prescription or a procedure passes
 * through. The only gate is `POST /cases/:id/override-gate`, and what it
 * overrides is a trigger on the ER *disposition* — the way out of the
 * department. *Parmanand Katara v. Union of India* (1989) makes emergency
 * treatment a duty that cannot be conditioned on formalities, and the way this
 * module honours that is by having nowhere to attach one.
 *
 * ── Sensitive cases are gated twice ─────────────────────────────────────────
 *
 * `mlc.case.read` opens an ordinary case. A sexual-assault, POCSO, dowry or
 * custodial case needs `mlc.sensitive.read` as well, and a caller without it
 * gets the *same* refusal as for a case that does not exist — telling somebody
 * that a sexual-assault case exists for this patient is itself the disclosure.
 *
 * ── What has no endpoint ────────────────────────────────────────────────────
 *
 * Editing a custody entry, un-flagging a case, deleting evidence, and editing a
 * signed report. Not omitted from this file — refused by the database, so the
 * absence here is a consequence rather than a promise.
 */
@Controller('mlc')
export class MlcController {
  constructor(
    @Inject(MlcService) private readonly mlc: MlcService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  /**
   * Whether this caller holds `mlc.sensitive.read`.
   *
   * Asked rather than assumed, and asked *here* rather than in the service, so
   * the service takes a plain boolean and cannot be called from somewhere that
   * forgot to check. `assert` throws on denial, which is exactly the wrong
   * behaviour for a filter — hence the catch.
   */
  private async maySeeSensitive(): Promise<boolean> {
    try {
      await this.policy.assert('mlc.sensitive.read');
      return true;
    } catch {
      return false;
    }
  }

  // ── The register ───────────────────────────────────────────────────────────

  @Permission('mlc.register.read')
  @Get('register')
  async register(@Query(new ZodBody(registerQuerySchema)) query: RegisterQuery): Promise<Page<MlcCaseView>> {
    return this.mlc.register(query, await this.maySeeSensitive());
  }

  @Permission('mlc.case.read')
  @Get('worklists')
  async worklist(
    @Query(new ZodBody(worklistQuerySchema)) query: WorklistQuery,
  ): Promise<Page<MlcWorklistRow>> {
    return this.mlc.worklist(query);
  }

  /** OP-006 and IP-002 call this before offering a discharge button. */
  @Permission('mlc.case.read')
  @Get('discharge-gate/:erVisitId')
  async dischargeGate(
    @Param('erVisitId', new ZodBody(idSchema)) erVisitId: string,
  ): Promise<MlcDischargeGateView | null> {
    return this.mlc.dischargeGateFor(erVisitId);
  }

  @Permission('mlc.case.create')
  @Idempotent()
  @Post('cases')
  async openCase(@Body(new ZodBody(openCaseSchema)) body: OpenCaseRequest): Promise<MlcCaseDetailView> {
    return this.mlc.openCase(body);
  }

  @Permission('mlc.case.read')
  @Get('cases/:id')
  async getCase(@Param('id', new ZodBody(idSchema)) id: string): Promise<MlcCaseDetailView> {
    return this.mlc.getCase(id, await this.maySeeSensitive());
  }

  @Permission('mlc.case.update')
  @Patch('cases/:id')
  async updateCase(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateCaseSchema)) body: UpdateCaseRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.updateCase(id, body);
  }

  /** MS only, with a reason. The number stays burnt and the entry stays. */
  @Permission('mlc.case.cancel')
  @Post('cases/:id/cancel')
  async cancelCase(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelCaseSchema)) _body: unknown,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.cancelCase(id);
  }

  // ── Police intimation ──────────────────────────────────────────────────────

  @Permission('mlc.intimation.create')
  @Idempotent()
  @Post('cases/:id/intimations')
  async createIntimation(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(intimationSchema)) body: IntimationRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.createIntimation(id, body);
  }

  @Permission('mlc.intimation.dispatch')
  @Post('intimations/:id/dispatch')
  async dispatch(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(dispatchSchema)) body: DispatchRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.dispatchIntimation(id, body);
  }

  /** The constable's name and number. Without it the hospital can prove nothing. */
  @Permission('mlc.intimation.dispatch')
  @Post('intimations/:id/acknowledge')
  async acknowledge(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(acknowledgeSchema)) body: AcknowledgeRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.acknowledgeIntimation(id, body);
  }

  // ── The body map ───────────────────────────────────────────────────────────

  @Permission('mlc.injury.write')
  @Post('cases/:id/injuries')
  async recordInjury(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(injurySchema)) body: InjuryRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.recordInjury(id, body);
  }

  // ── Evidence and custody ───────────────────────────────────────────────────

  @Permission('mlc.evidence.capture')
  @Idempotent()
  @Post('cases/:id/evidence')
  async captureEvidence(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(evidenceSchema)) body: EvidenceRequest,
  ): Promise<MlcEvidenceView> {
    return this.mlc.captureEvidence(id, body);
  }

  @Permission('mlc.evidence.read')
  @Get('cases/:id/evidence')
  async listEvidence(@Param('id', new ZodBody(idSchema)) id: string): Promise<Page<MlcEvidenceView>> {
    return this.mlc.listEvidence(id);
  }

  /**
   * Record a transfer. The response carries the chain *and its verification* —
   * `chainIntact` is recomputed on every read rather than trusted.
   */
  @Permission('mlc.custody.transfer')
  @Post('evidence/:id/custody')
  async recordCustody(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(custodySchema)) body: CustodyRequest,
  ): Promise<MlcEvidenceView> {
    return this.mlc.recordCustody(id, body);
  }

  /** Evidence leaves the hospital once, against a requisition, with a reason. */
  @Permission('mlc.evidence.handover')
  @Post('cases/:id/handovers')
  async handOver(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(handoverSchema)) body: HandoverRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.handOver(id, body);
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  @Permission('mlc.report.create')
  @Post('cases/:id/reports')
  async createReport(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(reportSchema)) body: ReportRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.createReport(id, body);
  }

  @Permission('mlc.report.sign')
  @Post('reports/:id/sign')
  async signReport(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(signReportSchema)) body: SignReportRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.signReport(id, body);
  }

  /** A signed report is corrected by addendum. Both versions survive. */
  @Permission('mlc.report.create')
  @Post('cases/:id/reports/addendum')
  async addendum(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(addendumSchema)) body: AddendumRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.addendum(id, body);
  }

  @Permission('mlc.report.export')
  @Post('reports/:id/certified-copy')
  async certifiedCopy(@Param('id', new ZodBody(idSchema)) id: string): Promise<MlcCaseDetailView> {
    return this.mlc.issueCertifiedCopy(id);
  }

  // ── Requests, declarations, the protocol and death ─────────────────────────

  @Permission('mlc.request.manage')
  @Post('cases/:id/requests')
  async registerRequest(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(requestSchema)) body: RequestRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.registerRequest(id, body);
  }

  @Permission('mlc.request.manage')
  @Post('requests/:id/answer')
  async answerRequest(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(answerRequestSchema)) body: AnswerRequestRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.answerRequest(id, body);
  }

  @Permission('mlc.case.update')
  @Post('cases/:id/dying-declaration')
  async dyingDeclaration(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(dyingDeclarationSchema)) body: DyingDeclarationRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.recordDyingDeclaration(id, body);
  }

  /** The MoHFW protocol. There is no field here for a two-finger test. */
  @Permission('mlc.sensitive.write')
  @Post('cases/:id/sexual-assault')
  async sexualAssault(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(sexualAssaultSchema)) body: SexualAssaultRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.recordSexualAssault(id, body);
  }

  @Permission('mlc.death.write')
  @Post('cases/:id/death')
  async recordDeath(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(deathSchema)) body: DeathRequest,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.recordDeath(id, body);
  }

  /** MS only, with a reason. Lands on the case, where the register shows it. */
  @Permission('mlc.discharge.override')
  @Post('cases/:id/override-gate')
  async overrideGate(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(overrideGateSchema)) _body: unknown,
  ): Promise<MlcCaseDetailView> {
    return this.mlc.overrideGate(id);
  }
}
