import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { LabourService } from './labour.service.js';
import {
  birthReportSchema,
  birthReportSubmitSchema,
  decisionSchema,
  deliverySchema,
  episodeQuerySchema,
  episodeSchema,
  episodeUpdateSchema,
  examSchema,
  identityCheckSchema,
  newbornQuerySchema,
  newbornUpdateSchema,
  partographSchema,
  pphCloseSchema,
  pphStepSchema,
  type BirthReportRequest,
  type BirthReportSubmitRequest,
  type DecisionRequest,
  type DeliveryRequest,
  type EpisodeQuery,
  type EpisodeRequest,
  type EpisodeUpdateRequest,
  type ExamRequest,
  type IdentityCheckRequest,
  type NewbornQuery,
  type NewbornUpdateRequest,
  type PartographRequest,
  type PphCloseRequest,
  type PphStepRequest,
} from './labour.schemas.js';
import type {
  BirthReportRow,
  IdentityCheckRow,
  LabourEpisodeDetail,
  LabourEpisodeRow,
  NewbornRow,
  PartographAlertRow,
  PphActivationRow,
} from './labour.types.js';

/**
 * `/api/v1/obs/*` — IP-011.
 *
 * ── One route releases the chart, and it is a decision rather than a bypass ─
 *
 * `POST alerts/:id/decide`. The action line stops the partograph until one of
 * five things is recorded: augment, assist, caesarean, refer, or continue
 * expectantly with a reason. Continuing is a real and sometimes correct choice
 * — what it is not is silence.
 *
 * ── And there is no route that forces a handover ───────────────────────────
 *
 * A wristband pair releases when a scan matches, and nothing else. Babies are
 * swapped in busy units, it is discovered years later or never, and there is no
 * remedy — so there is no override either.
 */
@Controller()
export class LabourController {
  constructor(@Inject(LabourService) private readonly labour: LabourService) {}

  // ── The labour ────────────────────────────────────────────────────────────

  @Permission('obs.labour.admit')
  @Idempotent()
  @Post('obs/labour-episodes')
  async admit(@Body(new ZodBody(episodeSchema)) body: EpisodeRequest): Promise<LabourEpisodeRow> {
    return this.labour.admit(body);
  }

  @Permission('obs.labour.read')
  @Get('obs/labour-episodes')
  async list(
    @Query(new ZodBody(episodeQuerySchema)) query: EpisodeQuery,
  ): Promise<readonly LabourEpisodeRow[]> {
    return this.labour.listEpisodes(query);
  }

  @Permission('obs.labour.read')
  @Get('obs/labour-episodes/:id')
  async detail(@Param('id') id: string): Promise<LabourEpisodeDetail> {
    return this.labour.episodeDetail(id);
  }

  @Permission('obs.labour.admit')
  @Post('obs/labour-episodes/:id')
  async update(
    @Param('id') id: string,
    @Body(new ZodBody(episodeUpdateSchema)) body: EpisodeUpdateRequest,
  ): Promise<LabourEpisodeRow> {
    return this.labour.updateEpisode(id, body);
  }

  // ── The chart ─────────────────────────────────────────────────────────────

  /** Observations are taken together, so they are written together. */
  @Permission('obs.partograph.write')
  @Post('obs/labour-episodes/:id/partograph')
  async plot(
    @Param('id') id: string,
    @Body(new ZodBody(partographSchema)) body: PartographRequest,
  ): Promise<LabourEpisodeDetail> {
    return this.labour.plot(id, body);
  }

  /** What releases the chart. Five choices, one of which is to continue. */
  @Permission('obs.partograph.decide')
  @Post('obs/partograph-alerts/:id/decide')
  async decide(
    @Param('id') id: string,
    @Body(new ZodBody(decisionSchema)) body: DecisionRequest,
  ): Promise<PartographAlertRow> {
    return this.labour.decide(id, body);
  }

  // ── The birth ─────────────────────────────────────────────────────────────

  /**
   * Records the delivery and creates the baby's own patient record, in one
   * transaction, because the gap between two saves is where a wristband goes on
   * unrecorded.
   */
  @Permission('obs.delivery.write')
  @Idempotent()
  @Post('obs/labour-episodes/:id/deliveries')
  async recordDelivery(
    @Param('id') id: string,
    @Body(new ZodBody(deliverySchema)) body: DeliveryRequest,
  ): Promise<LabourEpisodeDetail> {
    return this.labour.recordDelivery(id, body);
  }

  // ── The haemorrhage ───────────────────────────────────────────────────────

  @Permission('obs.labour.read')
  @Get('obs/pph-activations')
  async listActivations(): Promise<readonly PphActivationRow[]> {
    return this.labour.listActivations();
  }

  @Permission('obs.pph.manage')
  @Post('obs/pph-activations/:id/steps')
  async addStep(
    @Param('id') id: string,
    @Body(new ZodBody(pphStepSchema)) body: PphStepRequest,
  ): Promise<PphActivationRow> {
    return this.labour.addPphStep(id, body);
  }

  @Permission('obs.pph.manage')
  @Post('obs/pph-activations/:id/close')
  async closePph(
    @Param('id') id: string,
    @Body(new ZodBody(pphCloseSchema)) body: PphCloseRequest,
  ): Promise<PphActivationRow> {
    return this.labour.closePph(id, body);
  }

  // ── The baby ──────────────────────────────────────────────────────────────

  @Permission('obs.labour.read')
  @Get('obs/newborns')
  async listNewborns(
    @Query(new ZodBody(newbornQuerySchema)) query: NewbornQuery,
  ): Promise<readonly NewbornRow[]> {
    return this.labour.listNewborns(query);
  }

  @Permission('obs.newborn.write')
  @Post('obs/newborns/:id')
  async updateNewborn(
    @Param('id') id: string,
    @Body(new ZodBody(newbornUpdateSchema)) body: NewbornUpdateRequest,
  ): Promise<NewbornRow> {
    return this.labour.updateNewborn(id, body);
  }

  @Permission('obs.newborn.write')
  @Idempotent()
  @Post('obs/newborns/:id/exams')
  async recordExam(
    @Param('id') id: string,
    @Body(new ZodBody(examSchema)) body: ExamRequest,
  ): Promise<NewbornRow> {
    return this.labour.recordExam(id, body);
  }

  /** `matched` is not in the body. It is what the scanner read, not what was believed. */
  @Permission('obs.identity.verify')
  @Post('obs/newborns/:id/identity-check')
  async checkIdentity(
    @Param('id') id: string,
    @Body(new ZodBody(identityCheckSchema)) body: IdentityCheckRequest,
  ): Promise<IdentityCheckRow> {
    return this.labour.checkIdentity(id, body);
  }

  // ── Form 1 ────────────────────────────────────────────────────────────────

  @Permission('obs.birth.report')
  @Post('obs/newborns/:id/birth-report')
  async draftReport(
    @Param('id') id: string,
    @Body(new ZodBody(birthReportSchema)) body: BirthReportRequest,
  ): Promise<BirthReportRow> {
    return this.labour.draftBirthReport(id, body);
  }

  @Permission('obs.birth.report')
  @Post('obs/newborns/:id/birth-report/verify')
  async verifyReport(@Param('id') id: string): Promise<BirthReportRow> {
    return this.labour.verifyBirthReport(id);
  }

  @Permission('obs.birth.report')
  @Post('obs/newborns/:id/birth-report/submit')
  async submitReport(
    @Param('id') id: string,
    @Body(new ZodBody(birthReportSubmitSchema)) body: BirthReportSubmitRequest,
  ): Promise<BirthReportRow> {
    return this.labour.submitBirthReport(id, body);
  }
}
