import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { DischargeService } from './discharge.service.js';
import {
  amendSummarySchema,
  completeSchema,
  damaSchema,
  declareDeathSchema,
  dischargeQuerySchema,
  draftSummarySchema,
  initiateSchema,
  mccdSchema,
  mortuaryQuerySchema,
  postMortemSchema,
  receiveBodySchema,
  reconcileBatchSchema,
  releaseSchema,
  verifyNokSchema,
  type AmendSummaryRequest,
  type CompleteRequest,
  type DamaRequest,
  type DeclareDeathRequest,
  type DischargeQuery,
  type DraftSummaryRequest,
  type InitiateRequest,
  type MccdRequest,
  type MortuaryQuery,
  type PostMortemRequest,
  type ReceiveBodyRequest,
  type ReconcileBatchRequest,
  type ReleaseRequest,
  type VerifyNokRequest,
} from './discharge.schemas.js';
import type {
  DischargeDetail,
  DischargeRow,
  MortuaryRow,
  ReconciliationRow,
  ReleaseChecklist,
  SummaryRow,
} from './discharge.types.js';

/**
 * `/api/v1/ip/discharge/*` and `/api/v1/mortuary/*` — Phase 7G.
 *
 * ── There is no route that signs an unreconciled summary ────────────────────
 *
 * Not a flag on `sign`, not a second endpoint, not a query parameter. The
 * doctor's way past the block is to decide about the medicine, which is the
 * point. `GET /:id` returns the unresolved count so the screen can say which
 * medicine is holding the discharge up before the signature is attempted.
 *
 * ── Nor one that releases a body early ──────────────────────────────────────
 *
 * `GET /mortuary/:id/release-checklist` exists so the custodian can tell a
 * family what is outstanding and roughly how long it will take. It reports; it
 * does not authorise. The four gates are in `body_release_is_lawful`, and the
 * only way through them is to satisfy them.
 */
@Controller()
export class DischargeController {
  constructor(@Inject(DischargeService) private readonly discharge: DischargeService) {}

  // ── IP-002 ─────────────────────────────────────────────────────────────────

  @Permission('ip.discharge.initiate')
  @Idempotent()
  @Post('ip/discharge')
  async initiate(@Body(new ZodBody(initiateSchema)) body: InitiateRequest): Promise<DischargeRow> {
    return this.discharge.initiate(body);
  }

  @Permission('ip.discharge.read')
  @Get('ip/discharge')
  async list(@Query(new ZodBody(dischargeQuerySchema)) query: DischargeQuery): Promise<Page<DischargeRow>> {
    return this.discharge.list(query);
  }

  @Permission('ip.discharge.read')
  @Get('ip/discharge/:id')
  async detail(@Param('id') id: string): Promise<DischargeDetail> {
    return this.discharge.detail(id);
  }

  /**
   * Assembles the three lists from the record, every row undecided.
   *
   * Held by `ip.discharge.read` and not by `reconcile`: pulling the lists
   * together decides nothing, and a ward clerk opening the screen ahead of the
   * round should not need the key that stops somebody’s medicine.
   */
  @Permission('ip.discharge.read')
  @Post('ip/discharge/:id/reconciliation/prefill')
  async prefillReconciliation(@Param('id') id: string): Promise<readonly ReconciliationRow[]> {
    return this.discharge.prefillReconciliation(id);
  }

  @Permission('ip.discharge.reconcile')
  @Idempotent()
  @Post('ip/discharge/:id/reconciliation')
  async reconcile(
    @Param('id') id: string,
    @Body(new ZodBody(reconcileBatchSchema)) body: ReconcileBatchRequest,
  ): Promise<readonly ReconciliationRow[]> {
    return this.discharge.reconcile(id, body);
  }

  @Permission('ip.discharge.summary.write')
  @Post('ip/discharge/:id/summary')
  async draftSummary(
    @Param('id') id: string,
    @Body(new ZodBody(draftSummarySchema)) body: DraftSummaryRequest,
  ): Promise<SummaryRow> {
    return this.discharge.draftSummary(id, body);
  }

  @Permission('ip.discharge.summary.sign')
  @Idempotent()
  @Post('ip/discharge/summaries/:summaryId/sign')
  async signSummary(@Param('summaryId') summaryId: string): Promise<SummaryRow> {
    return this.discharge.signSummary(summaryId);
  }

  @Permission('ip.discharge.summary.cosign')
  @Idempotent()
  @Post('ip/discharge/summaries/:summaryId/cosign')
  async cosignSummary(@Param('summaryId') summaryId: string): Promise<SummaryRow> {
    return this.discharge.cosignSummary(summaryId);
  }

  @Permission('ip.discharge.summary.amend')
  @Idempotent()
  @Post('ip/discharge/summaries/:summaryId/amend')
  async amendSummary(
    @Param('summaryId') summaryId: string,
    @Body(new ZodBody(amendSummarySchema)) body: AmendSummaryRequest,
  ): Promise<SummaryRow> {
    return this.discharge.amendSummary(summaryId, body);
  }

  @Permission('ip.discharge.dama')
  @Idempotent()
  @Post('ip/discharge/:id/dama')
  async recordDama(
    @Param('id') id: string,
    @Body(new ZodBody(damaSchema)) body: DamaRequest,
  ): Promise<DischargeRow> {
    return this.discharge.recordDama(id, body);
  }

  @Permission('ip.discharge.complete')
  @Idempotent()
  @Post('ip/discharge/:id/left')
  async complete(
    @Param('id') id: string,
    @Body(new ZodBody(completeSchema)) body: CompleteRequest,
  ): Promise<DischargeRow> {
    return this.discharge.complete(id, body);
  }

  // ── IP-017 ─────────────────────────────────────────────────────────────────

  @Permission('mortuary.case.create')
  @Idempotent()
  @Post('mortuary/cases')
  async declareDeath(@Body(new ZodBody(declareDeathSchema)) body: DeclareDeathRequest): Promise<MortuaryRow> {
    return this.discharge.declareDeath(body);
  }

  @Permission('mortuary.case.read')
  @Get('mortuary/cases')
  async mortuaryList(
    @Query(new ZodBody(mortuaryQuerySchema)) query: MortuaryQuery,
  ): Promise<Page<MortuaryRow>> {
    return this.discharge.mortuaryList(query);
  }

  @Permission('mortuary.body.operate')
  @Idempotent()
  @Post('mortuary/cases/:id/receive')
  async receiveBody(
    @Param('id') id: string,
    @Body(new ZodBody(receiveBodySchema)) body: ReceiveBodyRequest,
  ): Promise<MortuaryRow> {
    return this.discharge.receiveBody(id, body);
  }

  @Permission('mortuary.mccd.write')
  @Idempotent()
  @Post('mortuary/cases/:id/mccd')
  async issueMccd(
    @Param('id') id: string,
    @Body(new ZodBody(mccdSchema)) body: MccdRequest,
  ): Promise<MortuaryRow> {
    return this.discharge.issueMccd(id, body);
  }

  @Permission('mortuary.pm.write')
  @Idempotent()
  @Post('mortuary/cases/:id/post-mortem')
  async recordPostMortem(
    @Param('id') id: string,
    @Body(new ZodBody(postMortemSchema)) body: PostMortemRequest,
  ): Promise<MortuaryRow> {
    return this.discharge.recordPostMortem(id, body);
  }

  @Permission('mortuary.release.manage')
  @Idempotent()
  @Post('mortuary/cases/:id/nok-verify')
  async verifyNok(
    @Param('id') id: string,
    @Body(new ZodBody(verifyNokSchema)) body: VerifyNokRequest,
  ): Promise<MortuaryRow> {
    return this.discharge.verifyNok(id, body);
  }

  @Permission('mortuary.case.read')
  @Get('mortuary/cases/:id/release-checklist')
  async releaseChecklist(@Param('id') id: string): Promise<ReleaseChecklist> {
    return this.discharge.releaseChecklist(id);
  }

  @Permission('mortuary.release.manage')
  @Idempotent()
  @Post('mortuary/cases/:id/release')
  async release(
    @Param('id') id: string,
    @Body(new ZodBody(releaseSchema)) body: ReleaseRequest,
  ): Promise<MortuaryRow> {
    return this.discharge.release(id, body);
  }
}
