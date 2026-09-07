import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { NutritionService } from './nutrition.service.js';
import { SpeechService } from './speech.service.js';
import { TherapyService } from './therapy.service.js';
import { WoundService } from './wound.service.js';
import {
  acknowledgeSchema,
  assessmentSchema,
  attendSchema,
  closeWoundSchema,
  dietPlanSchema,
  dischargeSchema,
  dressingSchema,
  episodeQuerySchema,
  episodeSchema,
  extendAuthorisationSchema,
  goalSchema,
  nutritionAssessmentSchema,
  overrideWoundSchema,
  patientQuerySchema,
  planSchema,
  resolveGoalSchema,
  sessionSchema,
  slpAssessmentSchema,
  swallowOrderSchema,
  swallowQuerySchema,
  woundAssessmentSchema,
  woundPhotoSchema,
  woundQuerySchema,
  woundSchema,
  type AcknowledgeRequest,
  type AssessmentRequest,
  type AttendRequest,
  type CloseWoundRequest,
  type DietPlanRequest,
  type DischargeRequest,
  type DressingRequest,
  type EpisodeQuery,
  type EpisodeRequest,
  type ExtendAuthorisationRequest,
  type GoalRequest,
  type NutritionAssessmentRequest,
  type OverrideWoundRequest,
  type PatientQuery,
  type PlanRequest,
  type ResolveGoalRequest,
  type SessionRequest,
  type SlpAssessmentRequest,
  type SwallowOrderRequest,
  type SwallowQuery,
  type WoundAssessmentRequest,
  type WoundPhotoRequest,
  type WoundQuery,
  type WoundRequest,
} from './therapy.schemas.js';
import type {
  AssessmentRow,
  DietPlanRow,
  EpisodeDetail,
  EpisodeRow,
  GoalRow,
  NutritionAssessmentRow,
  PlanRow,
  SessionRow,
  SlpAssessmentRow,
  SwallowOrderRow,
  WoundDetail,
  WoundPhotoRow,
  WoundRow,
} from './therapy.types.js';

/**
 * `/api/v1/therapy/*`, `/wounds/*`, `/nutrition/*`, `/slp/*` — OP-015, OP-017,
 * OP-011, OP-035.
 *
 * ── One URL space for the spine, four for the disciplines ──────────────────
 *
 * Episodes, goals, plans and sessions are `therapy/*` whichever console the
 * patient is in, because they are the same rows. What is under `wounds/*`,
 * `nutrition/*` and `slp/*` is what only that discipline has.
 *
 * ── No route sets a derived number ─────────────────────────────────────────
 *
 * No `PATCH …/area`, no `PUT …/totals`, no way to write a trajectory. And no
 * route closes an episode past its open goals, because the alternative to a
 * refusal there is outcome data that quietly does not exist.
 *
 * ── Two routes are the documented way past a rule ──────────────────────────
 *
 * `POST therapy/episodes/:id/authorisation` extends what a payer allowed, and
 * `POST wounds/:id/close/override` closes a wound whose last measurement is not
 * zero. Both demand a reason; the second writes the closing measurement it is
 * standing in for, so nothing ends up in an impossible state.
 *
 * ── And the acknowledgement is not on the order ────────────────────────────
 *
 * `POST slp/orders/:id/acknowledge` is a separate route behind a key held by
 * the kitchen and the ward. A `party` field on the order body would let the
 * therapist tick both boxes for departments that have never seen it.
 */
@Controller()
export class TherapyController {
  constructor(
    @Inject(TherapyService) private readonly therapy: TherapyService,
    @Inject(WoundService) private readonly wounds: WoundService,
    @Inject(NutritionService) private readonly nutrition: NutritionService,
    @Inject(SpeechService) private readonly speech: SpeechService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-015 · the spine
  // ═══════════════════════════════════════════════════════════════════════════

  @Permission('therapy.episode.create')
  @Idempotent()
  @Post('therapy/episodes')
  async openEpisode(@Body(new ZodBody(episodeSchema)) body: EpisodeRequest): Promise<EpisodeRow> {
    return this.therapy.openEpisode(body);
  }

  @Permission('therapy.episode.read')
  @Get('therapy/episodes')
  async listEpisodes(
    @Query(new ZodBody(episodeQuerySchema)) query: EpisodeQuery,
  ): Promise<readonly EpisodeRow[]> {
    return this.therapy.listEpisodes(query);
  }

  @Permission('therapy.episode.read')
  @Get('therapy/episodes/:id')
  async episodeDetail(@Param('id') id: string): Promise<EpisodeDetail> {
    return this.therapy.episodeDetail(id);
  }

  @Permission('therapy.assessment.record')
  @Idempotent()
  @Post('therapy/episodes/:id/assessments')
  async recordAssessment(
    @Param('id') id: string,
    @Body(new ZodBody(assessmentSchema)) body: AssessmentRequest,
  ): Promise<AssessmentRow> {
    return this.therapy.recordAssessment(id, body);
  }

  @Permission('therapy.assessment.sign')
  @Post('therapy/assessments/:id/sign')
  async signAssessment(@Param('id') id: string): Promise<AssessmentRow> {
    return this.therapy.signAssessment(id);
  }

  @Permission('therapy.goal.manage')
  @Idempotent()
  @Post('therapy/episodes/:id/goals')
  async addGoal(@Param('id') id: string, @Body(new ZodBody(goalSchema)) body: GoalRequest): Promise<GoalRow> {
    return this.therapy.addGoal(id, body);
  }

  @Permission('therapy.goal.manage')
  @Post('therapy/goals/:id/resolve')
  async resolveGoal(
    @Param('id') id: string,
    @Body(new ZodBody(resolveGoalSchema)) body: ResolveGoalRequest,
  ): Promise<GoalRow> {
    return this.therapy.resolveGoal(id, body);
  }

  @Permission('therapy.plan.write')
  @Idempotent()
  @Post('therapy/episodes/:id/plans')
  async writePlan(
    @Param('id') id: string,
    @Body(new ZodBody(planSchema)) body: PlanRequest,
  ): Promise<PlanRow> {
    return this.therapy.writePlan(id, body);
  }

  @Permission('therapy.session.record')
  @Idempotent()
  @Post('therapy/episodes/:id/sessions')
  async bookSession(
    @Param('id') id: string,
    @Body(new ZodBody(sessionSchema)) body: SessionRequest,
  ): Promise<SessionRow> {
    return this.therapy.bookSession(id, body);
  }

  @Permission('therapy.session.record')
  @Post('therapy/sessions/:id/attend')
  async attend(
    @Param('id') id: string,
    @Body(new ZodBody(attendSchema)) body: AttendRequest,
  ): Promise<SessionRow> {
    return this.therapy.attend(id, body);
  }

  @Permission('therapy.session.record')
  @Post('therapy/sessions/:id/no-show')
  async noShow(@Param('id') id: string): Promise<SessionRow> {
    return this.therapy.markNoShow(id);
  }

  /** The eleventh session of a package of ten. */
  @Permission('therapy.authorisation.extend')
  @Post('therapy/episodes/:id/authorisation')
  async extendAuthorisation(
    @Param('id') id: string,
    @Body(new ZodBody(extendAuthorisationSchema)) body: ExtendAuthorisationRequest,
  ): Promise<EpisodeRow> {
    return this.therapy.extendAuthorisation(id, body);
  }

  @Permission('therapy.episode.discharge')
  @Post('therapy/episodes/:id/discharge')
  async discharge(
    @Param('id') id: string,
    @Body(new ZodBody(dischargeSchema)) body: DischargeRequest,
  ): Promise<EpisodeRow> {
    return this.therapy.discharge(id, body);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-017 · wound care
  // ═══════════════════════════════════════════════════════════════════════════

  @Permission('wound.record')
  @Idempotent()
  @Post('wounds')
  async openWound(@Body(new ZodBody(woundSchema)) body: WoundRequest): Promise<WoundRow> {
    return this.wounds.openWound(body);
  }

  @Permission('wound.read')
  @Get('wounds')
  async listWounds(@Query(new ZodBody(woundQuerySchema)) query: WoundQuery): Promise<readonly WoundRow[]> {
    return this.wounds.list(query);
  }

  @Permission('wound.read')
  @Get('wounds/:id')
  async woundDetail(@Param('id') id: string): Promise<WoundDetail> {
    return this.wounds.detail(id);
  }

  @Permission('wound.record')
  @Post('wounds/:id/assessments')
  async assessWound(
    @Param('id') id: string,
    @Body(new ZodBody(woundAssessmentSchema)) body: WoundAssessmentRequest,
  ): Promise<WoundDetail> {
    return this.wounds.assess(id, body);
  }

  @Permission('wound.photo.capture')
  @Idempotent()
  @Post('wounds/:id/photos')
  async addWoundPhoto(
    @Param('id') id: string,
    @Body(new ZodBody(woundPhotoSchema)) body: WoundPhotoRequest,
  ): Promise<WoundPhotoRow> {
    return this.wounds.addPhoto(id, body);
  }

  @Permission('wound.dressing.record')
  @Idempotent()
  @Post('wounds/:id/dressings')
  async recordDressing(
    @Param('id') id: string,
    @Body(new ZodBody(dressingSchema)) body: DressingRequest,
  ): Promise<WoundDetail> {
    return this.wounds.recordDressing(id, body);
  }

  @Permission('wound.plan.write')
  @Post('wounds/:id/close')
  async closeWound(
    @Param('id') id: string,
    @Body(new ZodBody(closeWoundSchema)) body: CloseWoundRequest,
  ): Promise<WoundRow> {
    return this.wounds.close(id, body);
  }

  /** The wound that healed elsewhere, or was last seen by somebody with no ruler. */
  @Permission('wound.status.override')
  @Post('wounds/:id/close/override')
  async overrideCloseWound(
    @Param('id') id: string,
    @Body(new ZodBody(overrideWoundSchema)) body: OverrideWoundRequest,
  ): Promise<WoundRow> {
    return this.wounds.overrideClose(id, body);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-011 · dietetics
  // ═══════════════════════════════════════════════════════════════════════════

  @Permission('nutrition.assessment.record')
  @Idempotent()
  @Post('nutrition/assessments')
  async recordNutritionAssessment(
    @Body(new ZodBody(nutritionAssessmentSchema)) body: NutritionAssessmentRequest,
  ): Promise<NutritionAssessmentRow> {
    return this.nutrition.recordAssessment(body);
  }

  @Permission('nutrition.assessment.read')
  @Get('nutrition/assessments')
  async listNutritionAssessments(
    @Query(new ZodBody(patientQuerySchema)) query: PatientQuery,
  ): Promise<readonly NutritionAssessmentRow[]> {
    return this.nutrition.listAssessments(query);
  }

  @Permission('nutrition.assessment.record')
  @Post('nutrition/assessments/:id/sign')
  async signNutritionAssessment(@Param('id') id: string): Promise<NutritionAssessmentRow> {
    return this.nutrition.signAssessment(id);
  }

  @Permission('nutrition.plan.write')
  @Idempotent()
  @Post('nutrition/plans')
  async draftDietPlan(@Body(new ZodBody(dietPlanSchema)) body: DietPlanRequest): Promise<DietPlanRow> {
    return this.nutrition.draftPlan(body);
  }

  @Permission('nutrition.assessment.read')
  @Get('nutrition/plans')
  async listDietPlans(
    @Query(new ZodBody(patientQuerySchema)) query: PatientQuery,
  ): Promise<readonly DietPlanRow[]> {
    return this.nutrition.listPlans(query);
  }

  @Permission('nutrition.plan.write')
  @Post('nutrition/plans/:id/activate')
  async activateDietPlan(@Param('id') id: string): Promise<DietPlanRow> {
    return this.nutrition.activatePlan(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-035 · speech and swallow
  // ═══════════════════════════════════════════════════════════════════════════

  @Permission('slp.assessment.record')
  @Idempotent()
  @Post('slp/assessments')
  async recordSlpAssessment(
    @Body(new ZodBody(slpAssessmentSchema)) body: SlpAssessmentRequest,
  ): Promise<SlpAssessmentRow> {
    return this.speech.recordAssessment(body);
  }

  @Permission('slp.assessment.sign')
  @Post('slp/assessments/:id/sign')
  async signSlpAssessment(@Param('id') id: string): Promise<SlpAssessmentRow> {
    return this.speech.signAssessment(id);
  }

  @Permission('slp.swallow_order.write')
  @Idempotent()
  @Post('slp/orders')
  async issueSwallowOrder(
    @Body(new ZodBody(swallowOrderSchema)) body: SwallowOrderRequest,
  ): Promise<SwallowOrderRow> {
    return this.speech.issueOrder(body);
  }

  @Permission('slp.swallow_order.read')
  @Get('slp/orders')
  async listSwallowOrders(
    @Query(new ZodBody(swallowQuerySchema)) query: SwallowQuery,
  ): Promise<readonly SwallowOrderRow[]> {
    return this.speech.listOrders(query);
  }

  /**
   * The kitchen and the ward. Not the therapist, and not the same person twice.
   */
  @Permission('slp.swallow_order.acknowledge')
  @Post('slp/orders/:id/acknowledge')
  async acknowledgeSwallowOrder(
    @Param('id') id: string,
    @Body(new ZodBody(acknowledgeSchema)) body: AcknowledgeRequest,
  ): Promise<SwallowOrderRow> {
    return this.speech.acknowledge(id, body);
  }
}
