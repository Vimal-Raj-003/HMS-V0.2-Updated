import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { OphthalmologyService } from './ophthalmology.service.js';
import {
  acuityBatchSchema,
  diagnosisBatchSchema,
  dilateSchema,
  examSchema,
  iopBatchSchema,
  openVisitSchema,
  refractionBatchSchema,
  spectacleRxSchema,
  surgeryPlanSchema,
  surgeryStatusSchema,
  trendQuerySchema,
  visitQuerySchema,
  type AcuityBatchRequest,
  type DiagnosisBatchRequest,
  type DilateRequest,
  type ExamRequest,
  type IopBatchRequest,
  type OpenVisitRequest,
  type RefractionBatchRequest,
  type SpectacleRxRequest,
  type SurgeryPlanRequest,
  type SurgeryStatusRequest,
  type TrendQuery,
  type VisitQuery,
} from './ophthalmology.schemas.js';
import type {
  AcuityRow,
  DiagnosisRow,
  ExamRow,
  IopRow,
  RefractionRow,
  SpectacleRxRow,
  SurgeryPlanRow,
  TrendPoint,
  VisitDetail,
  VisitRow,
} from './ophthalmology.types.js';

/**
 * `/api/v1/ophtha/*` — OP-025.
 *
 * ── There is no route that orders an OCT ────────────────────────────────────
 *
 * Investigations go through `POST /specialty/device-orders`, the framework's
 * one path, and come back through its one attachment route. `phase-08` calls a
 * console with its own upload code a defect, and the way to keep that true is
 * for the console to have no such route to add a flag to later.
 *
 * ── Two routes to sign one prescription ─────────────────────────────────────
 *
 * `POST …/spectacle-rx` is the doctor's; `POST …/spectacle-rx/delegated` is the
 * optometrist's, where the hospital has delegated it. The route decides which,
 * the guard enforces it, and the prescription records which was used — a flag
 * in the body would let any client claim either.
 */
@Controller()
export class OphthalmologyController {
  constructor(@Inject(OphthalmologyService) private readonly ophtha: OphthalmologyService) {}

  // ── The visit ──────────────────────────────────────────────────────────────

  @Permission('ophtha.visit.create')
  @Idempotent()
  @Post('ophtha/visits')
  async openVisit(@Body(new ZodBody(openVisitSchema)) body: OpenVisitRequest): Promise<VisitRow> {
    return this.ophtha.openVisit(body);
  }

  @Permission('ophtha.visit.read')
  @Get('ophtha/visits')
  async listVisits(@Query(new ZodBody(visitQuerySchema)) query: VisitQuery): Promise<readonly VisitRow[]> {
    return this.ophtha.listVisits(query);
  }

  @Permission('ophtha.visit.read')
  @Get('ophtha/visits/:id')
  async visitDetail(@Param('id') id: string): Promise<VisitDetail> {
    return this.ophtha.visitDetail(id);
  }

  // ── The refraction lane ────────────────────────────────────────────────────

  @Permission('ophtha.optometry.record')
  @Post('ophtha/visits/:id/acuity')
  async recordAcuities(
    @Param('id') id: string,
    @Body(new ZodBody(acuityBatchSchema)) body: AcuityBatchRequest,
  ): Promise<readonly AcuityRow[]> {
    return this.ophtha.recordAcuities(id, body);
  }

  @Permission('ophtha.optometry.record')
  @Post('ophtha/visits/:id/refractions')
  async recordRefractions(
    @Param('id') id: string,
    @Body(new ZodBody(refractionBatchSchema)) body: RefractionBatchRequest,
  ): Promise<readonly RefractionRow[]> {
    return this.ophtha.recordRefractions(id, body);
  }

  @Permission('ophtha.optometry.record')
  @Post('ophtha/visits/:id/iop')
  async recordIop(
    @Param('id') id: string,
    @Body(new ZodBody(iopBatchSchema)) body: IopBatchRequest,
  ): Promise<readonly IopRow[]> {
    return this.ophtha.recordIop(id, body);
  }

  @Permission('ophtha.optometry.record')
  @Patch('ophtha/visits/:id/dilate')
  async dilate(
    @Param('id') id: string,
    @Body(new ZodBody(dilateSchema)) body: DilateRequest,
  ): Promise<VisitRow> {
    return this.ophtha.dilate(id, body);
  }

  // ── The examination ────────────────────────────────────────────────────────

  @Permission('ophtha.exam.record')
  @Post('ophtha/visits/:id/exam')
  async recordExam(
    @Param('id') id: string,
    @Body(new ZodBody(examSchema)) body: ExamRequest,
  ): Promise<ExamRow> {
    return this.ophtha.recordExam(id, body);
  }

  @Permission('ophtha.exam.record')
  @Post('ophtha/visits/:id/diagnoses')
  async recordDiagnoses(
    @Param('id') id: string,
    @Body(new ZodBody(diagnosisBatchSchema)) body: DiagnosisBatchRequest,
  ): Promise<readonly DiagnosisRow[]> {
    return this.ophtha.recordDiagnoses(id, body);
  }

  @Permission('ophtha.exam.sign')
  @Idempotent()
  @Post('ophtha/visits/:id/sign')
  async signVisit(@Param('id') id: string): Promise<VisitRow> {
    return this.ophtha.signVisit(id);
  }

  // ── The prescription ───────────────────────────────────────────────────────

  @Permission('ophtha.spectacle_rx.sign')
  @Idempotent()
  @Post('ophtha/visits/:id/spectacle-rx')
  async signSpectacleRx(
    @Param('id') id: string,
    @Body(new ZodBody(spectacleRxSchema)) body: SpectacleRxRequest,
  ): Promise<SpectacleRxRow> {
    return this.ophtha.signSpectacleRx(id, body, false);
  }

  /**
   * The same prescription, signed by the optometrist who refracted.
   *
   * A separate route because it is a separate permission, and the hospital
   * grants it deliberately. The row it writes says `signedUnderDelegation`, so
   * a regulator reading the register two years later can see which it was.
   */
  @Permission('ophtha.spectacle_rx.sign_delegated')
  @Idempotent()
  @Post('ophtha/visits/:id/spectacle-rx/delegated')
  async signSpectacleRxDelegated(
    @Param('id') id: string,
    @Body(new ZodBody(spectacleRxSchema)) body: SpectacleRxRequest,
  ): Promise<SpectacleRxRow> {
    return this.ophtha.signSpectacleRx(id, body, true);
  }

  // ── The operation ──────────────────────────────────────────────────────────

  @Permission('ophtha.surgery.plan')
  @Idempotent()
  @Post('ophtha/visits/:id/surgery-plans')
  async planSurgery(
    @Param('id') id: string,
    @Body(new ZodBody(surgeryPlanSchema)) body: SurgeryPlanRequest,
  ): Promise<SurgeryPlanRow> {
    return this.ophtha.planSurgery(id, body);
  }

  @Permission('ophtha.surgery.book')
  @Patch('ophtha/surgery-plans/:id')
  async updateSurgeryStatus(
    @Param('id') id: string,
    @Body(new ZodBody(surgeryStatusSchema)) body: SurgeryStatusRequest,
  ): Promise<SurgeryPlanRow> {
    return this.ophtha.updateSurgeryStatus(id, body);
  }

  // ── Trends ─────────────────────────────────────────────────────────────────

  @Permission('ophtha.visit.read')
  @Get('ophtha/patients/:patientId/trends')
  async trend(
    @Param('patientId') patientId: string,
    @Query(new ZodBody(trendQuerySchema)) query: TrendQuery,
  ): Promise<readonly TrendPoint[]> {
    return this.ophtha.trend(patientId, query);
  }
}
