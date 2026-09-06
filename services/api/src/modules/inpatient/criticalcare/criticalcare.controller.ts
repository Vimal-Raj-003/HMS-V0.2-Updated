import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { CriticalCareService } from './criticalcare.service.js';
import {
  bloodIssueSchema,
  bloodRequestSchema,
  bundleSchema,
  cartCheckSchema,
  cartSchema,
  codeCloseSchema,
  codeEventSchema,
  codeQuerySchema,
  codeSchema,
  donorSchema,
  flowsheetSchema,
  inventoryQuerySchema,
  reactionSchema,
  sampleSchema,
  scoreSchema,
  transfuseSchema,
  ttiSchema,
  unitSchema,
  type BloodIssueRequest,
  type BloodRequestBody,
  type BundleRequest,
  type CartCheckRequest,
  type CartRequest,
  type CodeCloseRequest,
  type CodeEventRequest,
  type CodeQuery,
  type CodeRequest,
  type DonorRequest,
  type FlowsheetRequest,
  type InventoryQuery,
  type ReactionRequest,
  type SampleRequest,
  type ScoreRequest,
  type TransfuseRequest,
  type TtiRequest,
  type UnitRequest,
} from './criticalcare.schemas.js';
import type {
  BloodIssueRow,
  BloodRequestRow,
  BloodUnitRow,
  CodeDetail,
  CodeRow,
  FlowsheetRow,
} from './criticalcare.types.js';

/**
 * `/api/v1/icu/*`, `/api/v1/code/*` and `/api/v1/blood/*` — Phase 7E and 7F.
 *
 * ── `POST /blood/issues/:id/transfuse` takes four things ────────────────────
 *
 * A second nurse, the wristband scan and the bag scan — and nothing that could
 * stand in for any of them. There is no `override`, no `emergency`, no
 * `singleCheck`. `phase-07`: the bedside check "cannot be skipped, deferred or
 * configured away", and the database refuses a start without all four whatever
 * the caller sends.
 *
 * ── Anybody may call a code ─────────────────────────────────────────────────
 *
 * `code.call` is `low` and held widely. The person who finds somebody arrested
 * is whoever walked in, and a permission check at that moment is a permission
 * check during a cardiac arrest.
 */
@Controller()
export class CriticalCareController {
  constructor(@Inject(CriticalCareService) private readonly care: CriticalCareService) {}

  // ── Intensive care ─────────────────────────────────────────────────────────

  @Permission('icu.flowsheet.record')
  @Post('icu/flowsheet')
  async recordFlowsheet(@Body(new ZodBody(flowsheetSchema)) body: FlowsheetRequest): Promise<FlowsheetRow> {
    return this.care.recordFlowsheet(body);
  }

  @Permission('icu.flowsheet.read')
  @Get('icu/flowsheet/:admissionId')
  async flowsheet(@Param('admissionId') admissionId: string): Promise<readonly FlowsheetRow[]> {
    return this.care.flowsheet(admissionId);
  }

  @Permission('icu.score.compute')
  @Post('icu/scores')
  async score(@Body(new ZodBody(scoreSchema)) body: ScoreRequest): Promise<{ readonly score: number }> {
    return this.care.recordScore(body);
  }

  @Permission('icu.bundle.record')
  @Post('icu/bundles')
  async bundle(
    @Body(new ZodBody(bundleSchema)) body: BundleRequest,
  ): Promise<{ readonly complete: boolean }> {
    return this.care.recordBundle(body);
  }

  // ── The cart and the code ──────────────────────────────────────────────────

  @Permission('cart.reseal')
  @Idempotent()
  @Post('code/carts')
  async createCart(@Body(new ZodBody(cartSchema)) body: CartRequest): Promise<{ readonly id: string }> {
    return this.care.createCart(body);
  }

  @Permission('cart.check.record')
  @Post('code/carts/:id/checks')
  async checkCart(
    @Param('id') id: string,
    @Body(new ZodBody(cartCheckSchema)) body: CartCheckRequest,
  ): Promise<{ readonly id: string }> {
    return this.care.checkCart(id, body);
  }

  @Permission('code.call')
  @Idempotent()
  @Post('code/calls')
  async callCode(@Body(new ZodBody(codeSchema)) body: CodeRequest): Promise<CodeDetail> {
    return this.care.callCode(body);
  }

  @Permission('code.record')
  @Get('code/calls')
  async codes(@Query(new ZodBody(codeQuerySchema)) query: CodeQuery): Promise<Page<CodeRow>> {
    return this.care.codes(query);
  }

  @Permission('code.record')
  @Get('code/calls/:id')
  async getCode(@Param('id') id: string): Promise<CodeDetail> {
    return this.care.getCode(id);
  }

  @Permission('code.record')
  @Post('code/calls/:id/events')
  async codeEvent(
    @Param('id') id: string,
    @Body(new ZodBody(codeEventSchema)) body: CodeEventRequest,
  ): Promise<CodeDetail> {
    return this.care.recordCodeEvent(id, body);
  }

  @Permission('cart.reseal')
  @Patch('code/calls/:id/restock')
  async restock(
    @Param('id') id: string,
    @Body(new ZodBody(cartCheckSchema)) body: CartCheckRequest,
  ): Promise<CodeDetail> {
    return this.care.restockCart(id, body.resealedNo ?? 'resealed');
  }

  @Permission('code.close')
  @Patch('code/calls/:id/close')
  async closeCode(
    @Param('id') id: string,
    @Body(new ZodBody(codeCloseSchema)) body: CodeCloseRequest,
  ): Promise<CodeDetail> {
    return this.care.closeCode(id, body);
  }

  // ── Blood ──────────────────────────────────────────────────────────────────

  @Permission('blood.donor.manage')
  @Idempotent()
  @Post('blood/donors')
  async donor(@Body(new ZodBody(donorSchema)) body: DonorRequest): Promise<{ readonly id: string }> {
    return this.care.registerDonor(body);
  }

  @Permission('blood.unit.manage')
  @Idempotent()
  @Post('blood/units')
  async bookUnit(@Body(new ZodBody(unitSchema)) body: UnitRequest): Promise<{ readonly id: string }> {
    return this.care.bookUnit(body);
  }

  @Permission('blood.unit.manage')
  @Patch('blood/units/:id/tti')
  async tti(@Param('id') id: string, @Body(new ZodBody(ttiSchema)) body: TtiRequest): Promise<BloodUnitRow> {
    return this.care.recordTti(id, body);
  }

  @Permission('blood.inventory.read')
  @Get('blood/inventory')
  async inventory(
    @Query(new ZodBody(inventoryQuerySchema)) query: InventoryQuery,
  ): Promise<Page<BloodUnitRow>> {
    return this.care.inventory(query);
  }

  @Permission('blood.request.create')
  @Idempotent()
  @Post('blood/requests')
  async request(@Body(new ZodBody(bloodRequestSchema)) body: BloodRequestBody): Promise<BloodRequestRow> {
    return this.care.requestBlood(body);
  }

  @Permission('blood.sample.record')
  @Post('blood/requests/:id/samples')
  async sample(
    @Param('id') id: string,
    @Body(new ZodBody(sampleSchema)) body: SampleRequest,
  ): Promise<BloodRequestRow> {
    return this.care.recordSample(id, body);
  }

  @Permission('blood.issue')
  @Idempotent()
  @Post('blood/issues')
  async issue(@Body(new ZodBody(bloodIssueSchema)) body: BloodIssueRequest): Promise<BloodIssueRow> {
    return this.care.issueBlood(body);
  }

  @Permission('blood.transfuse')
  @Post('blood/issues/:id/transfuse')
  async transfuse(
    @Param('id') id: string,
    @Body(new ZodBody(transfuseSchema)) body: TransfuseRequest,
  ): Promise<BloodIssueRow> {
    return this.care.transfuse(id, body);
  }

  @Permission('blood.reaction.report')
  @Post('blood/issues/:id/reactions')
  async reaction(
    @Param('id') id: string,
    @Body(new ZodBody(reactionSchema)) body: ReactionRequest,
  ): Promise<{ readonly id: string }> {
    return this.care.reportReaction(id, body);
  }
}
