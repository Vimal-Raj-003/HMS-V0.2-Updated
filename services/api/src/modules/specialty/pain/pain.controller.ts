import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { PainService } from './pain.service.js';
import {
  agreementSchema,
  interventionSchema,
  opioidQuerySchema,
  opioidSchema,
  painAssessmentSchema,
  painEpisodeSchema,
  painQuerySchema,
  revokeAgreementSchema,
  secondReviewSchema,
  type AgreementRequest,
  type InterventionRequest,
  type OpioidQuery,
  type OpioidRequest,
  type PainAssessmentRequest,
  type PainEpisodeRequest,
  type PainQuery,
  type RevokeAgreementRequest,
  type SecondReviewRequest,
} from './pain.schemas.js';
import type {
  AgreementRow,
  InterventionRow,
  OpioidRow,
  PainAssessmentRow,
  PainEpisodeDetail,
  PainEpisodeRow,
  PainThresholds,
} from './pain.types.js';

/**
 * `/api/v1/pain/*` — OP-016.
 *
 * ── The countersignature is a route, not a field ───────────────────────────
 *
 * `POST pain/opioids/:id/review` exists because a review is a second person's
 * act at a second moment. A `secondReviewerId` on the prescription body would
 * let the prescriber name a colleague who has not looked at it, and the
 * threshold that triggered the review would have bought nothing.
 *
 * ── There is no route that exceeds the steroid ceiling ─────────────────────
 *
 * Every other console in this phase has one documented way past its rule.
 * This one does not, and the absence is the decision: the ceiling already sits
 * at the permissive end of the published range, the harm is cumulative and
 * silent, and a clinic that needs to exceed it needs a different treatment
 * rather than a different permission.
 *
 * ── The thresholds are readable ────────────────────────────────────────────
 *
 * `GET pain/thresholds` returns what the database will actually enforce, so a
 * screen showing "above 90 mg needs a second signature" is showing the number
 * the trigger uses rather than a constant compiled beside it.
 */
@Controller()
export class PainController {
  constructor(@Inject(PainService) private readonly pain: PainService) {}

  @Permission('pain.episode.read')
  @Get('pain/thresholds')
  async thresholds(): Promise<PainThresholds> {
    return this.pain.thresholds();
  }

  @Permission('pain.episode.create')
  @Idempotent()
  @Post('pain/episodes')
  async openEpisode(@Body(new ZodBody(painEpisodeSchema)) body: PainEpisodeRequest): Promise<PainEpisodeRow> {
    return this.pain.openEpisode(body);
  }

  @Permission('pain.episode.read')
  @Get('pain/episodes')
  async listEpisodes(
    @Query(new ZodBody(painQuerySchema)) query: PainQuery,
  ): Promise<readonly PainEpisodeRow[]> {
    return this.pain.listEpisodes(query);
  }

  @Permission('pain.episode.read')
  @Get('pain/episodes/:id')
  async episodeDetail(@Param('id') id: string): Promise<PainEpisodeDetail> {
    return this.pain.episodeDetail(id);
  }

  @Permission('pain.assessment.record')
  @Idempotent()
  @Post('pain/episodes/:id/assessments')
  async recordAssessment(
    @Param('id') id: string,
    @Body(new ZodBody(painAssessmentSchema)) body: PainAssessmentRequest,
  ): Promise<PainAssessmentRow> {
    return this.pain.recordAssessment(id, body);
  }

  // ── The agreement ──────────────────────────────────────────────────────────

  @Permission('pain.agreement.sign')
  @Idempotent()
  @Post('pain/episodes/:id/agreement')
  async signAgreement(
    @Param('id') id: string,
    @Body(new ZodBody(agreementSchema)) body: AgreementRequest,
  ): Promise<AgreementRow> {
    return this.pain.signAgreement(id, body);
  }

  /** Ends every future opioid on the episode, so it carries a reason. */
  @Permission('pain.agreement.revoke')
  @Post('pain/agreements/:id/revoke')
  async revokeAgreement(
    @Param('id') id: string,
    @Body(new ZodBody(revokeAgreementSchema)) body: RevokeAgreementRequest,
  ): Promise<AgreementRow> {
    return this.pain.revokeAgreement(id, body);
  }

  // ── Opioids ────────────────────────────────────────────────────────────────

  @Permission('pain.opioid.prescribe')
  @Idempotent()
  @Post('pain/episodes/:id/opioids')
  async prescribe(
    @Param('id') id: string,
    @Body(new ZodBody(opioidSchema)) body: OpioidRequest,
  ): Promise<OpioidRow> {
    return this.pain.prescribe(id, body);
  }

  @Permission('pain.opioid.read')
  @Get('pain/opioids')
  async listOpioids(
    @Query(new ZodBody(opioidQuerySchema)) query: OpioidQuery,
  ): Promise<readonly OpioidRow[]> {
    return this.pain.listOpioids(query);
  }

  /** A second prescriber, in their own session. Never the person who wrote it. */
  @Permission('pain.opioid.second_review')
  @Post('pain/opioids/:id/review')
  async secondReview(
    @Param('id') id: string,
    @Body(new ZodBody(secondReviewSchema)) body: SecondReviewRequest,
  ): Promise<OpioidRow> {
    return this.pain.secondReview(id, body);
  }

  // ── Interventions ──────────────────────────────────────────────────────────

  @Permission('pain.intervention.perform')
  @Idempotent()
  @Post('pain/episodes/:id/interventions')
  async performIntervention(
    @Param('id') id: string,
    @Body(new ZodBody(interventionSchema)) body: InterventionRequest,
  ): Promise<InterventionRow> {
    return this.pain.performIntervention(id, body);
  }
}
