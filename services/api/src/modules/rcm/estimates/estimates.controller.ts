import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { EstimatesService } from './estimates.service.js';
import {
  createEstimateSchema,
  createTemplateSchema,
  estimateQuerySchema,
  idSchema,
  issueEstimateSchema,
  recordOutcomeSchema,
  recordVarianceSchema,
  shareEstimateSchema,
  templateQuerySchema,
  updateEstimateSchema,
  varianceQuerySchema,
  type CreateEstimateRequest,
  type CreateTemplateRequest,
  type EstimateQuery,
  type IssueEstimateRequest,
  type RecordOutcomeRequest,
  type RecordVarianceRequest,
  type ShareEstimateRequest,
  type TemplateQuery,
  type UpdateEstimateRequest,
  type VarianceQuery,
} from './estimates.schemas.js';
import type {
  EstimateDetailView,
  EstimateView,
  TemplateView,
  VarianceSampleView,
  VarianceSummaryRow,
} from './estimates.types.js';

/**
 * `/api/v1/estimates/*` — RC-008.
 *
 * ── There is no route that changes an issued estimate ───────────────────────
 *
 * `PATCH /:id` refuses anything that is not a draft, and the database refuses it
 * again. The only way to change a number a family has been given is
 * `POST /:id/revise`, which creates a successor and leaves both readable. That
 * is not process for its own sake: a family who was told ₹1,80,000 and is billed
 * ₹2,40,000 is entitled to see exactly what changed and when, and a system that
 * overwrote the first number cannot show them.
 *
 * ── `POST /:id/variance` is exit gate 8 ─────────────────────────────────────
 *
 * It is on its own permission held by finance and quality rather than by the
 * desk that wrote the quote. Measuring the estimator is how a hospital learns
 * its quotes run light, and that is not a measurement to leave with the people
 * being measured.
 */
@Controller('estimates')
export class EstimatesController {
  constructor(@Inject(EstimatesService) private readonly estimates: EstimatesService) {}

  // ── Templates ──────────────────────────────────────────────────────────────

  @Permission('est.template.read')
  @Get('templates')
  async listTemplates(
    @Query(new ZodBody(templateQuerySchema)) query: TemplateQuery,
  ): Promise<Page<TemplateView>> {
    return this.estimates.listTemplates(query);
  }

  @Permission('est.template.manage')
  @Idempotent()
  @Post('templates')
  async createTemplate(
    @Body(new ZodBody(createTemplateSchema)) body: CreateTemplateRequest,
  ): Promise<TemplateView> {
    return this.estimates.createTemplate(body);
  }

  // ── Variance (before `/:id`, so the literal path is not eaten by the param) ─

  @Permission('est.variance.read')
  @Get('variance')
  async listVariance(
    @Query(new ZodBody(varianceQuerySchema)) query: VarianceQuery,
  ): Promise<Page<VarianceSampleView>> {
    return this.estimates.listVariance(query);
  }

  @Permission('est.variance.read')
  @Get('variance/summary')
  async varianceSummary(): Promise<{ readonly items: readonly VarianceSummaryRow[] }> {
    return this.estimates.varianceSummary();
  }

  // ── Estimates ──────────────────────────────────────────────────────────────

  @Permission('est.list')
  @Get()
  async listEstimates(
    @Query(new ZodBody(estimateQuerySchema)) query: EstimateQuery,
  ): Promise<Page<EstimateView>> {
    return this.estimates.listEstimates(query);
  }

  @Permission('est.create')
  @Idempotent()
  @Post()
  async createEstimate(
    @Body(new ZodBody(createEstimateSchema)) body: CreateEstimateRequest,
  ): Promise<EstimateDetailView> {
    return this.estimates.createEstimate(body);
  }

  @Permission('est.read')
  @Get(':id')
  async getEstimate(@Param('id', new ZodBody(idSchema)) id: string): Promise<EstimateDetailView> {
    return this.estimates.getEstimate(id);
  }

  /** Drafts only. An issued estimate is revised, not edited. */
  @Permission('est.update')
  @Patch(':id')
  async updateEstimate(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateEstimateSchema)) body: UpdateEstimateRequest,
  ): Promise<EstimateDetailView> {
    return this.estimates.updateEstimate(id, body);
  }

  /** From here the number is fixed and the hospital is held to it. */
  @Permission('est.issue')
  @Idempotent()
  @Post(':id/issue')
  async issueEstimate(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(issueEstimateSchema)) body: IssueEstimateRequest,
  ): Promise<EstimateDetailView> {
    return this.estimates.issueEstimate(id, body);
  }

  @Permission('est.share')
  @Idempotent()
  @Post(':id/share')
  async shareEstimate(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(shareEstimateSchema)) body: ShareEstimateRequest,
  ): Promise<EstimateDetailView> {
    return this.estimates.shareEstimate(id, body);
  }

  @Permission('est.outcome.record')
  @Idempotent()
  @Post(':id/outcome')
  async recordOutcome(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(recordOutcomeSchema)) body: RecordOutcomeRequest,
  ): Promise<EstimateDetailView> {
    return this.estimates.recordOutcome(id, body);
  }

  /** The only way to change a number a family already has. See the class note. */
  @Permission('est.create')
  @Idempotent()
  @Post(':id/revise')
  async reviseEstimate(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(createEstimateSchema)) body: CreateEstimateRequest,
  ): Promise<EstimateDetailView> {
    return this.estimates.reviseEstimate(id, body);
  }

  /** Exit gate 8. Held by finance, not by the desk that wrote the quote. */
  @Permission('est.variance.record')
  @Idempotent()
  @Post(':id/variance')
  async recordVariance(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(recordVarianceSchema)) body: RecordVarianceRequest,
  ): Promise<VarianceSampleView> {
    return this.estimates.recordVariance(id, body);
  }
}
