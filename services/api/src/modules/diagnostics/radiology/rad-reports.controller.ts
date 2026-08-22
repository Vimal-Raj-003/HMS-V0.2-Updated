import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { RadReportsService, type ReadingWorklistItem } from './rad-reports.service.js';
import {
  amendReportSchema,
  createReportSchema,
  criticalCallbackSchema,
  criticalFindingSchema,
  idSchema,
  peerReviewSchema,
  signReportSchema,
  updateReportSchema,
  worklistQuerySchema,
  type AmendReportRequest,
  type CreateReportRequest,
  type CriticalCallbackRequest,
  type CriticalFindingRequest,
  type PeerReviewRequest,
  type SignReportRequest,
  type UpdateReportRequest,
  type WorklistQuery,
} from './radiology.schemas.js';
import type { CriticalFindingView, RadReportView } from './radiology.types.js';

/**
 * `/api/v1/rad` — OP-008 §6, the reading half.
 *
 * The interesting gating is on the critical path. `rad.critical.notify` and
 * `rad.critical.read` are `clinicalSafetyExempt` in the catalogue, which means
 * the licence check in the policy engine can never refuse them: EN-040 §5 puts
 * the panic-value loop outside licence enforcement, and this is its imaging
 * twin. A hospital whose subscription has lapsed still gets its intracranial
 * haemorrhage to a human.
 *
 * `rad.report.sign` is `requiresStepUp`. `rad.report.amend` is `requiresReason`,
 * so the guard demands an `x-reason` header before the handler runs and the
 * body's reason is the one that prints on the amended report.
 */
@Controller()
export class RadReportsController {
  constructor(@Inject(RadReportsService) private readonly reports: RadReportsService) {}

  /** OP-008 §3.4.1 — STAT first, then urgent, then routine by age. */
  @Permission('rad.report.create')
  @Get('rad/reading-worklist')
  async worklist(
    @Query(new ZodBody(worklistQuerySchema)) query: WorklistQuery,
  ): Promise<Page<ReadingWorklistItem>> {
    return this.reports.readingWorklist(query);
  }

  @Permission('rad.report.create')
  @Idempotent()
  @Post('rad/reports')
  async create(@Body(new ZodBody(createReportSchema)) body: CreateReportRequest): Promise<RadReportView> {
    return this.reports.createDraft(body);
  }

  @Permission('rad.report.read')
  @Get('rad/reports/:id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<RadReportView> {
    return this.reports.get(id);
  }

  /** Autosave. Not idempotent: an autosave is a last-write-wins overwrite by design. */
  @Permission('rad.report.create')
  @Patch('rad/reports/:id')
  async update(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateReportSchema)) body: UpdateReportRequest,
  ): Promise<RadReportView> {
    return this.reports.updateDraft(id, body);
  }

  @Permission('rad.report.preliminary')
  @Idempotent()
  @Post('rad/reports/:id/preliminary')
  async preliminary(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(signReportSchema)) body: SignReportRequest,
  ): Promise<RadReportView> {
    return this.reports.issuePreliminary(id, body);
  }

  @Permission('rad.report.sign')
  @Idempotent()
  @Post('rad/reports/:id/sign')
  async sign(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(signReportSchema)) body: SignReportRequest,
  ): Promise<RadReportView> {
    return this.reports.sign(id, body);
  }

  @Permission('rad.report.amend')
  @Idempotent()
  @Post('rad/reports/:id/amend')
  async amend(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(amendReportSchema)) body: AmendReportRequest,
  ): Promise<RadReportView> {
    return this.reports.amend(id, body);
  }

  @Permission('rad.critical.notify')
  @Idempotent()
  @Post('rad/reports/:id/critical')
  async raiseCritical(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(criticalFindingSchema)) body: CriticalFindingRequest,
  ): Promise<CriticalFindingView> {
    return this.reports.raiseCritical(id, body);
  }

  /** D-10: the read-back, or the documented escalation. There is no third option. */
  @Permission('rad.critical.notify')
  @Idempotent()
  @Post('rad/critical-findings/:id/callbacks')
  async callback(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(criticalCallbackSchema)) body: CriticalCallbackRequest,
  ): Promise<CriticalFindingView> {
    return this.reports.recordCallback(id, body);
  }

  @Permission('rad.critical.read')
  @Get('rad/critical-findings')
  async listCriticals(
    @Query(new ZodBody(worklistQuerySchema)) query: WorklistQuery,
  ): Promise<Page<CriticalFindingView>> {
    return this.reports.listCriticals(query);
  }

  @Permission('rad.critical.read')
  @Get('rad/critical-findings/:id')
  async getCritical(@Param('id', new ZodBody(idSchema)) id: string): Promise<CriticalFindingView> {
    return this.reports.getFinding(id);
  }

  @Permission('rad.peer_review.create')
  @Idempotent()
  @Post('rad/reports/:id/peer-review')
  async peerReview(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(peerReviewSchema)) body: PeerReviewRequest,
  ): Promise<{ readonly id: string }> {
    return this.reports.peerReview(id, body);
  }
}
