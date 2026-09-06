import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  acknowledgePageSchema,
  activateSchema,
  amendScoreSchema,
  computeScoresSchema,
  declareMciSchema,
  idSchema,
  injurySchema,
  interventionSchema,
  standDownMciSchema,
  standDownSchema,
  surveySchema,
  traumaBoardQuerySchema,
  triageSchema,
  type AcknowledgePageRequest,
  type ActivateRequest,
  type AmendScoreRequest,
  type ComputeScoresRequest,
  type DeclareMciRequest,
  type InjuryRequest,
  type InterventionRequest,
  type StandDownMciRequest,
  type StandDownRequest,
  type SurveyRequest,
  type TraumaBoardQuery,
  type TriageRequest,
} from './trauma.schemas.js';
import { TraumaService } from './trauma.service.js';
import type {
  MciIncidentView,
  PrimarySurveyView,
  TraumaActivationView,
  TraumaBoardView,
  TraumaInjuryView,
  TraumaScoreView,
  TriageRecordView,
  TriageResultView,
} from './trauma.types.js';

/**
 * `/api/v1/trauma/*` — TR-001.
 *
 * ── There is no endpoint that edits a triage or a locked score ──────────────
 *
 * Not an oversight and not a backlog item. A re-triage is `POST` on the same
 * path, producing a second record; an amendment is `POST /scores/amend`,
 * producing a second version. The first triage is the only evidence of whether
 * the wait that followed was reasonable, and the database refuses to lose it
 * whatever this controller offers.
 *
 * ── `POST /activations` is cheap and `standdown` is not ─────────────────────
 *
 * Calling the team needs `trauma.activation.create`, which is `low` risk and
 * held by every nurse on the floor. Releasing them needs a reason in the
 * `x-reason` header. That asymmetry is the module's whole opinion: under-triage
 * is the failure mode, so the easy action is the safe one.
 */
@Controller('trauma')
export class TraumaController {
  constructor(@Inject(TraumaService) private readonly trauma: TraumaService) {}

  // ── The board ──────────────────────────────────────────────────────────────

  @Permission('trauma.activation.list')
  @Get('board')
  async board(@Query(new ZodBody(traumaBoardQuerySchema)) query: TraumaBoardQuery): Promise<TraumaBoardView> {
    return this.trauma.board(query);
  }

  // ── Triage ─────────────────────────────────────────────────────────────────

  /**
   * Triage, or re-triage. Never an edit.
   *
   * The permission checked is `triage.record.create` even when the body carries
   * an override, because refusing the whole triage for want of the override key
   * would leave the patient with no triage at all. The override itself is
   * refused by the database if the reason is missing.
   */
  @Permission('triage.record.create')
  @Idempotent()
  @Post('visits/:id/triage')
  async triage(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(triageSchema)) body: TriageRequest,
  ): Promise<TriageResultView> {
    return this.trauma.applyTriage(id, body);
  }

  @Permission('triage.record.list')
  @Get('visits/:id/triage')
  async listTriage(@Param('id', new ZodBody(idSchema)) id: string): Promise<Page<TriageRecordView>> {
    return this.trauma.listTriage(id);
  }

  // ── Activation ─────────────────────────────────────────────────────────────

  @Permission('trauma.activation.create')
  @Idempotent()
  @Post('activations')
  async activate(@Body(new ZodBody(activateSchema)) body: ActivateRequest): Promise<TraumaActivationView> {
    return this.trauma.activate(body);
  }

  @Permission('trauma.activation.read')
  @Get('activations/:id')
  async getActivation(@Param('id', new ZodBody(idSchema)) id: string): Promise<TraumaActivationView> {
    return this.trauma.getActivation(id);
  }

  /** The acknowledgement is the point of the page. */
  @Permission('trauma.page.acknowledge')
  @Post('pages/:id/acknowledge')
  async acknowledgePage(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(acknowledgePageSchema)) body: AcknowledgePageRequest,
  ): Promise<TraumaActivationView> {
    return this.trauma.acknowledgePage(id, body);
  }

  /** Needs the reason in `x-reason`. A silent stand-down teaches people to ignore pages. */
  @Permission('trauma.activation.standdown')
  @Post('activations/:id/standdown')
  async standDown(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(standDownSchema)) body: StandDownRequest,
  ): Promise<TraumaActivationView> {
    return this.trauma.standDown(id, body);
  }

  // ── The primary survey ─────────────────────────────────────────────────────

  @Permission('trauma.survey.record')
  @Post('surveys')
  async recordSurvey(@Body(new ZodBody(surveySchema)) body: SurveyRequest): Promise<PrimarySurveyView> {
    return this.trauma.recordSurvey(body);
  }

  @Permission('trauma.survey.read')
  @Get('visits/:id/survey')
  async getSurvey(@Param('id', new ZodBody(idSchema)) id: string): Promise<PrimarySurveyView> {
    return this.trauma.getSurvey(id);
  }

  /** Append-only. There is no endpoint that edits or removes one. */
  @Permission('trauma.survey.record')
  @Post('visits/:id/interventions')
  async addIntervention(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(interventionSchema)) body: InterventionRequest,
  ): Promise<PrimarySurveyView> {
    return this.trauma.addIntervention(id, body);
  }

  // ── Injuries and scores ────────────────────────────────────────────────────

  @Permission('trauma.injury.record')
  @Post('visits/:id/injuries')
  async addInjury(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(injurySchema)) body: InjuryRequest,
  ): Promise<Page<TraumaInjuryView>> {
    return this.trauma.addInjury(id, body);
  }

  @Permission('trauma.injury.record')
  @Delete('visits/:id/injuries/:injuryId')
  async removeInjury(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Param('injuryId', new ZodBody(idSchema)) injuryId: string,
  ): Promise<Page<TraumaInjuryView>> {
    return this.trauma.removeInjury(id, injuryId);
  }

  @Permission('trauma.score.read')
  @Get('visits/:id/injuries')
  async listInjuries(@Param('id', new ZodBody(idSchema)) id: string): Promise<Page<TraumaInjuryView>> {
    return this.trauma.listInjuries(id);
  }

  @Permission('trauma.score.compute')
  @Post('scores')
  async computeScores(
    @Body(new ZodBody(computeScoresSchema)) body: ComputeScoresRequest,
  ): Promise<TraumaScoreView> {
    return this.trauma.computeScores(body);
  }

  @Permission('trauma.score.read')
  @Get('visits/:id/scores')
  async listScores(@Param('id', new ZodBody(idSchema)) id: string): Promise<Page<TraumaScoreView>> {
    return this.trauma.listScores(id);
  }

  @Permission('trauma.score.lock')
  @Post('scores/:id/lock')
  async lockScore(@Param('id', new ZodBody(idSchema)) id: string): Promise<TraumaScoreView> {
    return this.trauma.lockScore(id);
  }

  /** Needs the reason in `x-reason`. The superseded version stays. */
  @Permission('trauma.score.amend')
  @Post('scores/amend')
  async amendScore(@Body(new ZodBody(amendScoreSchema)) body: AmendScoreRequest): Promise<TraumaScoreView> {
    return this.trauma.amendScore(body);
  }

  // ── Mass casualty ──────────────────────────────────────────────────────────

  @Permission('mci.incident.read')
  @Get('mci')
  async listMci(): Promise<Page<MciIncidentView>> {
    return this.trauma.listMci();
  }

  @Permission('mci.incident.declare')
  @Idempotent()
  @Post('mci')
  async declareMci(@Body(new ZodBody(declareMciSchema)) body: DeclareMciRequest): Promise<MciIncidentView> {
    return this.trauma.declareMci(body);
  }

  @Permission('mci.incident.standdown')
  @Post('mci/:id/standdown')
  async standDownMci(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(standDownMciSchema)) body: StandDownMciRequest,
  ): Promise<MciIncidentView> {
    return this.trauma.standDownMci(id, body);
  }
}
