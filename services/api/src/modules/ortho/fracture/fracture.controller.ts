import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { FractureService } from './fracture.service.js';
import {
  bundleSchema,
  complicationSchema,
  confirmSchema,
  createFractureSchema,
  episodeSchema,
  eventSchema,
  examSchema,
  filmSchema,
  findingSchema,
  followupSchema,
  idSchema,
  planSchema,
  promSchema,
  registryQuerySchema,
  unionSchema,
  updateFractureSchema,
  type BundleRequest,
  type ComplicationRequest,
  type ConfirmRequest,
  type CreateFractureRequest,
  type EpisodeRequest,
  type ExamRequest,
  type FilmRequest,
  type FindingRequest,
  type FollowupRequest,
  type FractureEventRequest,
  type PlanRequest,
  type PromRequest,
  type RegistryQuery,
  type UnionRequest,
  type UpdateFractureRequest,
} from './fracture.schemas.js';
import type { FractureDetailView, FractureView, OrthoEpisodeView } from './fracture.types.js';

/**
 * `/api/v1/ortho/*` — TR-002 and OP-009.
 *
 * ── Registering is easy; confirming is not ──────────────────────────────────
 *
 * `POST /fractures` needs `fracture.record.create`, which every clinician who
 * looks at a film holds, because a fracture nobody registered is one the
 * registry never counts and nobody follows up. `POST /:id/confirm` needs the
 * surgeon's key: an AO code is a treatment decision written as a number, and it
 * cannot be signed off on an open fracture without its Gustilo grade.
 *
 * ── There is no endpoint that sets the side on a plan independently ─────────
 *
 * `POST /:id/plan` takes the side and the database compares it against the
 * fracture. The comparison exists precisely because four documents written by
 * four modules disagree, and a wrong-site operation is what that disagreement
 * turns into.
 */
@Controller('ortho')
export class FractureController {
  constructor(@Inject(FractureService) private readonly fractures: FractureService) {}

  // ── The registry ───────────────────────────────────────────────────────────

  @Permission('fracture.record.list')
  @Get('fractures')
  async registry(@Query(new ZodBody(registryQuerySchema)) query: RegistryQuery): Promise<Page<FractureView>> {
    return this.fractures.registry(query);
  }

  @Permission('fracture.record.create')
  @Idempotent()
  @Post('fractures')
  async create(
    @Body(new ZodBody(createFractureSchema)) body: CreateFractureRequest,
  ): Promise<FractureDetailView> {
    return this.fractures.createFracture(body);
  }

  @Permission('fracture.record.read')
  @Get('fractures/:id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<FractureDetailView> {
    return this.fractures.getFracture(id);
  }

  /** Every change keeps a snapshot of what the classification said before. */
  @Permission('fracture.record.update')
  @Patch('fractures/:id')
  async update(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateFractureSchema)) body: UpdateFractureRequest,
  ): Promise<FractureDetailView> {
    return this.fractures.updateFracture(id, body);
  }

  @Permission('fracture.classification.confirm')
  @Post('fractures/:id/confirm')
  async confirm(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(confirmSchema)) body: ConfirmRequest,
  ): Promise<FractureDetailView> {
    return this.fractures.confirm(id, body);
  }

  /** The side is checked against the fracture. A mismatch is refused. */
  @Permission('fracture.plan.set')
  @Post('fractures/:id/plan')
  async setPlan(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(planSchema)) body: PlanRequest,
  ): Promise<FractureDetailView> {
    return this.fractures.setPlan(id, body);
  }

  @Permission('fracture.event.record')
  @Post('fractures/:id/events')
  async event(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(eventSchema)) body: FractureEventRequest,
  ): Promise<FractureDetailView> {
    return this.fractures.recordEvent(id, body);
  }

  @Permission('fracture.imaging.assess')
  @Post('fractures/:id/films')
  async attachFilm(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(filmSchema)) body: FilmRequest,
  ): Promise<FractureDetailView> {
    return this.fractures.attachFilm(id, body);
  }

  @Permission('fracture.imaging.assess')
  @Post('fractures/:id/findings')
  async recordFinding(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(findingSchema)) body: FindingRequest,
  ): Promise<FractureDetailView> {
    return this.fractures.recordFinding(id, body);
  }

  /** Non-union before six months needs grounds in `x-reason`. */
  @Permission('fracture.union.declare')
  @Post('fractures/:id/union')
  async union(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(unionSchema)) body: UnionRequest,
  ): Promise<FractureDetailView> {
    return this.fractures.declareUnion(id, body);
  }

  @Permission('fracture.complication.record')
  @Post('fractures/:id/complications')
  async complication(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(complicationSchema)) body: ComplicationRequest,
  ): Promise<FractureDetailView> {
    return this.fractures.recordComplication(id, body);
  }

  /** The breaches come back computed by the database, not by the caller. */
  @Permission('fracture.event.record')
  @Post('fractures/:id/open-bundle')
  async bundle(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(bundleSchema)) body: BundleRequest,
  ): Promise<FractureDetailView> {
    return this.fractures.recordBundle(id, body);
  }

  // ── OP-009 ─────────────────────────────────────────────────────────────────

  @Permission('ortho.episode.create')
  @Idempotent()
  @Post('episodes')
  async createEpisode(@Body(new ZodBody(episodeSchema)) body: EpisodeRequest): Promise<OrthoEpisodeView> {
    return this.fractures.createEpisode(body);
  }

  @Permission('ortho.episode.read')
  @Get('episodes/:id')
  async getEpisode(@Param('id', new ZodBody(idSchema)) id: string): Promise<OrthoEpisodeView> {
    return this.fractures.getEpisode(id);
  }

  @Permission('ortho.exam.record')
  @Post('episodes/:id/exams')
  async exam(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(examSchema)) body: ExamRequest,
  ): Promise<OrthoEpisodeView> {
    return this.fractures.recordExam(id, body);
  }

  /** Offsets from the episode's anchor, never from today. */
  @Permission('ortho.followup.schedule')
  @Post('episodes/:id/followups')
  async followups(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(followupSchema)) body: FollowupRequest,
  ): Promise<OrthoEpisodeView> {
    return this.fractures.scheduleFollowups(id, body);
  }

  @Permission('ortho.prom.collect')
  @Post('episodes/:id/proms')
  async prom(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(promSchema)) body: PromRequest,
  ): Promise<OrthoEpisodeView> {
    return this.fractures.recordProm(id, body);
  }
}
