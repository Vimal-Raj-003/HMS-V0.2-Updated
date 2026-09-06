import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { SchemesService } from './schemes.service.js';
import {
  addCasePackageSchema,
  appealShortfallSchema,
  approveWriteOffSchema,
  assembleClaimSchema,
  attachDocumentSchema,
  captureBeneficiarySchema,
  cashAttemptQuerySchema,
  cashCheckSchema,
  caseQuerySchema,
  claimQuerySchema,
  closeCaseSchema,
  createSchemeSchema,
  idSchema,
  openCaseSchema,
  packageQuerySchema,
  recordClaimDecisionSchema,
  schemeQuerySchema,
  shortfallQuerySchema,
  submitClaimSchema,
  updateCaseSchema,
  verifyBeneficiarySchema,
  type AddCasePackageRequest,
  type AppealShortfallRequest,
  type ApproveWriteOffRequest,
  type AssembleClaimRequest,
  type AttachDocumentRequest,
  type CaptureBeneficiaryRequest,
  type CashAttemptQuery,
  type CashCheckRequest,
  type ClaimQuery,
  type CloseSchemeCaseRequest,
  type CreateSchemeRequest,
  type OpenSchemeCaseRequest,
  type PackageQuery,
  type RecordClaimDecisionRequest,
  type SchemeCaseQuery,
  type SchemeQuery,
  type ShortfallQuery,
  type SubmitClaimRequest,
  type UpdateSchemeCaseRequest,
  type VerifyBeneficiaryRequest,
} from './schemes.schemas.js';
import type {
  BeneficiaryView,
  CasePackageView,
  CashAttemptView,
  CashCheckView,
  ClaimDetailView,
  ClaimView,
  SchemeCaseDetailView,
  SchemeCaseView,
  SchemePackageView,
  SchemeView,
  ShortfallView,
} from './schemes.types.js';

/**
 * `/api/v1/schemes/*` — RC-007.
 *
 * ── `POST /cash-check` is the route the rest of the system depends on ───────
 *
 * Every collection point calls it before taking money. It is deliberately a
 * POST rather than a GET: it has a side effect — a refused tender is recorded —
 * and that record is the evidence an NHA audit asks for. The guarantee itself is
 * a trigger on `billing.payment_lines`, so a caller that skips this route is
 * still refused; what it would lose is the explanation and the audit row.
 *
 * ── Two `block` pairs ───────────────────────────────────────────────────────
 *
 * `claims/:id/submit` vs `claims/:id/decision`, and
 * `shortfalls/:id/appeal` vs `shortfalls/:id/writeoff`. Same reason in both
 * cases: the person chasing the money must not be the one who declares it
 * arrived, or the one who declares it never will.
 *
 * ── Closing a case is its own route ─────────────────────────────────────────
 *
 * `PATCH /cases/:id` deliberately refuses `status: 'closed'`. Closing lifts the
 * cash block, which is a materially different act from recording a discharge
 * date, and burying it in a general update would make it reachable by anyone who
 * can edit a case.
 */
@Controller('schemes')
export class SchemesController {
  constructor(@Inject(SchemesService) private readonly schemes: SchemesService) {}

  // ── Masters ────────────────────────────────────────────────────────────────

  @Permission('scheme.list')
  @Get()
  async listSchemes(@Query(new ZodBody(schemeQuerySchema)) query: SchemeQuery): Promise<Page<SchemeView>> {
    return this.schemes.listSchemes(query);
  }

  @Permission('scheme.configure')
  @Idempotent()
  @Post()
  async createScheme(@Body(new ZodBody(createSchemeSchema)) body: CreateSchemeRequest): Promise<SchemeView> {
    return this.schemes.createScheme(body);
  }

  @Permission('scheme.package.read')
  @Get('packages')
  async listPackages(
    @Query(new ZodBody(packageQuerySchema)) query: PackageQuery,
  ): Promise<Page<SchemePackageView>> {
    return this.schemes.listPackages(query);
  }

  // ── Beneficiaries ──────────────────────────────────────────────────────────

  @Permission('scheme.beneficiary.read')
  @Get('beneficiaries/:patientId')
  async listBeneficiaries(
    @Param('patientId', new ZodBody(idSchema)) patientId: string,
  ): Promise<Page<BeneficiaryView>> {
    return this.schemes.listBeneficiaries(patientId);
  }

  @Permission('scheme.beneficiary.capture')
  @Idempotent()
  @Post('beneficiaries')
  async captureBeneficiary(
    @Body(new ZodBody(captureBeneficiarySchema)) body: CaptureBeneficiaryRequest,
  ): Promise<BeneficiaryView> {
    return this.schemes.captureBeneficiary(body);
  }

  /** Verification is what turns the cash block on, so it carries a reason. */
  @Permission('scheme.beneficiary.verify')
  @Idempotent()
  @Post('beneficiaries/:id/verify')
  async verifyBeneficiary(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(verifyBeneficiarySchema)) body: VerifyBeneficiaryRequest,
  ): Promise<BeneficiaryView> {
    return this.schemes.verifyBeneficiary(id, body);
  }

  // ── Cases ──────────────────────────────────────────────────────────────────

  @Permission('scheme.case.list')
  @Get('cases')
  async listCases(
    @Query(new ZodBody(caseQuerySchema)) query: SchemeCaseQuery,
  ): Promise<Page<SchemeCaseView>> {
    return this.schemes.listCases(query);
  }

  @Permission('scheme.case.read')
  @Get('cases/:id')
  async getCase(@Param('id', new ZodBody(idSchema)) id: string): Promise<SchemeCaseDetailView> {
    return this.schemes.getCase(id);
  }

  @Permission('scheme.case.open')
  @Idempotent()
  @Post('cases')
  async openCase(@Body(new ZodBody(openCaseSchema)) body: OpenSchemeCaseRequest): Promise<SchemeCaseView> {
    return this.schemes.openCase(body);
  }

  @Permission('scheme.case.manage')
  @Idempotent()
  @Post('cases/:id/packages')
  async addCasePackage(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(addCasePackageSchema)) body: AddCasePackageRequest,
  ): Promise<CasePackageView> {
    return this.schemes.addCasePackage(id, body);
  }

  @Permission('scheme.case.manage')
  @Patch('cases/:id')
  async updateCase(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateCaseSchema)) body: UpdateSchemeCaseRequest,
  ): Promise<SchemeCaseView> {
    return this.schemes.updateCase(id, body);
  }

  /** Its own key: closing lifts the cash block. See the class note. */
  @Permission('scheme.case.close')
  @Idempotent()
  @Post('cases/:id/close')
  async closeCase(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(closeCaseSchema)) body: CloseSchemeCaseRequest,
  ): Promise<SchemeCaseView> {
    return this.schemes.closeCase(id, body);
  }

  // ── The cash block ─────────────────────────────────────────────────────────

  /**
   * Exit gate 6. Called by every collection point before the drawer opens.
   *
   * On `scheme.case.read` rather than a key of its own: a cashier who can see
   * the case must be able to ask this, and a collection point that cannot ask
   * would simply proceed and hit the trigger with no explanation for the family
   * standing at the counter.
   */
  @Permission('scheme.case.read')
  @Post('cash-check')
  async checkCash(@Body(new ZodBody(cashCheckSchema)) body: CashCheckRequest): Promise<CashCheckView> {
    return this.schemes.checkCash(body);
  }

  @Permission('scheme.cash.attempt.read')
  @Get('cash-attempts')
  async listCashAttempts(
    @Query(new ZodBody(cashAttemptQuerySchema)) query: CashAttemptQuery,
  ): Promise<Page<CashAttemptView>> {
    return this.schemes.listCashAttempts(query);
  }

  // ── Claims ─────────────────────────────────────────────────────────────────

  @Permission('scheme.claim.list')
  @Get('claims')
  async listClaims(@Query(new ZodBody(claimQuerySchema)) query: ClaimQuery): Promise<Page<ClaimView>> {
    return this.schemes.listClaims(query);
  }

  @Permission('scheme.claim.read')
  @Get('claims/:id')
  async getClaim(@Param('id', new ZodBody(idSchema)) id: string): Promise<ClaimDetailView> {
    return this.schemes.getClaim(id);
  }

  @Permission('scheme.claim.assemble')
  @Idempotent()
  @Post('claims')
  async assembleClaim(
    @Body(new ZodBody(assembleClaimSchema)) body: AssembleClaimRequest,
  ): Promise<ClaimDetailView> {
    return this.schemes.assembleClaim(body);
  }

  @Permission('scheme.claim.assemble')
  @Idempotent()
  @Post('claims/:id/documents')
  async attachDocument(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(attachDocumentSchema)) body: AttachDocumentRequest,
  ): Promise<ClaimDetailView> {
    return this.schemes.attachDocument(id, body);
  }

  /** Refused while a mandatory document is missing — by the database, not here. */
  @Permission('scheme.claim.submit')
  @Idempotent()
  @Post('claims/:id/submit')
  async submitClaim(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(submitClaimSchema)) body: SubmitClaimRequest,
  ): Promise<ClaimDetailView> {
    return this.schemes.submitClaim(id, body);
  }

  /** A draft that was never sent. See the service note for why it is not a delete. */
  @Permission('scheme.claim.assemble')
  @Idempotent()
  @Post('claims/:id/discard')
  async discardClaim(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(submitClaimSchema)) body: SubmitClaimRequest,
  ): Promise<ClaimDetailView> {
    return this.schemes.discardClaim(id, body);
  }

  /** A different key from submit, held by finance. See the class note. */
  @Permission('scheme.claim.decision.record')
  @Idempotent()
  @Post('claims/:id/decision')
  async recordDecision(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(recordClaimDecisionSchema)) body: RecordClaimDecisionRequest,
  ): Promise<ClaimDetailView> {
    return this.schemes.recordDecision(id, body);
  }

  // ── Shortfalls ─────────────────────────────────────────────────────────────

  @Permission('scheme.shortfall.read')
  @Get('shortfalls')
  async listShortfalls(
    @Query(new ZodBody(shortfallQuerySchema)) query: ShortfallQuery,
  ): Promise<Page<ShortfallView>> {
    return this.schemes.listShortfalls(query);
  }

  @Permission('scheme.shortfall.appeal')
  @Idempotent()
  @Post('shortfalls/:id/appeal')
  async appealShortfall(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(appealShortfallSchema)) body: AppealShortfallRequest,
  ): Promise<ShortfallView> {
    return this.schemes.appealShortfall(id, body);
  }

  /** The second pair of hands. Maker-checker against the appeal key. */
  @Permission('scheme.shortfall.writeoff.approve')
  @Idempotent()
  @Post('shortfalls/:id/writeoff')
  async approveWriteOff(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(approveWriteOffSchema)) body: ApproveWriteOffRequest,
  ): Promise<ShortfallView> {
    return this.schemes.approveWriteOff(id, body);
  }
}
