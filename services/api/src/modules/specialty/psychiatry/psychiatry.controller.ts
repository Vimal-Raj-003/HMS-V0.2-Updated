import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { PsychiatryService } from './psychiatry.service.js';
import {
  admissionSchema,
  capacitySchema,
  dischargeSchema,
  ectCourseSchema,
  ectSessionSchema,
  episodeQuerySchema,
  episodeSchema,
  instrumentSchema,
  intimationSchema,
  observationSchema,
  restraintCloseSchema,
  restraintQuerySchema,
  restraintSchema,
  revokeSchema,
  scaleSchema,
  type AdmissionRequest,
  type CapacityRequest,
  type DischargeRequest,
  type EctCourseRequest,
  type EctSessionRequest,
  type EpisodeQuery,
  type EpisodeRequest,
  type InstrumentRequest,
  type IntimationRequest,
  type ObservationRequest,
  type RestraintCloseRequest,
  type RestraintQuery,
  type RestraintRequest,
  type RevokeRequest,
  type ScaleRequest,
} from './psychiatry.schemas.js';
import type {
  AdmissionRow,
  CapacityRow,
  EctCourseRow,
  EctSessionRow,
  EpisodeDetail,
  InstrumentRow,
  PsyEpisodeRow,
  RestraintRow,
  ScaleRow,
} from './psychiatry.types.js';

/**
 * `/api/v1/psy/*` — OP-032.
 *
 * ── There is no route that extends an authority ────────────────────────────
 *
 * Thirty days is thirty days. Past it the choices are discharge, an independent
 * admission the person consents to, or the Review Board's authority under §90 —
 * which is a different admission with a Board reference on it, not a longer
 * version of this one.
 *
 * ── And none that records unmodified electroconvulsive therapy ─────────────
 *
 * Every session names the anaesthetic agent and the muscle relaxant, in the
 * schema and again in the database. §95 prohibits it outright, and the
 * strongest thing this build can say is that nothing here can express it.
 */
@Controller()
export class PsychiatryController {
  constructor(@Inject(PsychiatryService) private readonly psy: PsychiatryService) {}

  // ── The episode ───────────────────────────────────────────────────────────

  @Permission('psy.episode.manage')
  @Idempotent()
  @Post('psy/episodes')
  async openEpisode(@Body(new ZodBody(episodeSchema)) body: EpisodeRequest): Promise<PsyEpisodeRow> {
    return this.psy.openEpisode(body);
  }

  @Permission('psy.episode.read')
  @Get('psy/episodes')
  async listEpisodes(
    @Query(new ZodBody(episodeQuerySchema)) query: EpisodeQuery,
  ): Promise<readonly PsyEpisodeRow[]> {
    return this.psy.listEpisodes(query);
  }

  @Permission('psy.episode.read')
  @Get('psy/episodes/:id')
  async episodeDetail(@Param('id') id: string): Promise<EpisodeDetail> {
    return this.psy.episodeDetail(id);
  }

  // ── Scales ────────────────────────────────────────────────────────────────

  @Permission('psy.scale.record')
  @Idempotent()
  @Post('psy/scales')
  async recordScale(@Body(new ZodBody(scaleSchema)) body: ScaleRequest): Promise<ScaleRow> {
    return this.psy.recordScale(body);
  }

  // ── Capacity ──────────────────────────────────────────────────────────────

  /** The four limbs go in; the verdict comes out. */
  @Permission('psy.capacity.assess')
  @Post('psy/capacity')
  async assessCapacity(@Body(new ZodBody(capacitySchema)) body: CapacityRequest): Promise<CapacityRow> {
    return this.psy.assessCapacity(body);
  }

  // ── Instruments ───────────────────────────────────────────────────────────

  @Permission('psy.instrument.manage')
  @Idempotent()
  @Post('psy/instruments')
  async recordInstrument(
    @Body(new ZodBody(instrumentSchema)) body: InstrumentRequest,
  ): Promise<InstrumentRow> {
    return this.psy.recordInstrument(body);
  }

  /** Revoked, never removed. Only the Board can set one aside. */
  @Permission('psy.instrument.manage')
  @Post('psy/instruments/:id/revoke')
  async revokeInstrument(
    @Param('id') id: string,
    @Body(new ZodBody(revokeSchema)) body: RevokeRequest,
  ): Promise<InstrumentRow> {
    return this.psy.revokeInstrument(id, body);
  }

  // ── Admission under the Act ───────────────────────────────────────────────

  @Permission('psy.admission.manage')
  @Idempotent()
  @Post('psy/admissions')
  async admit(@Body(new ZodBody(admissionSchema)) body: AdmissionRequest): Promise<AdmissionRow> {
    return this.psy.admit(body);
  }

  @Permission('psy.admission.record')
  @Post('psy/admissions/:id/intimation')
  async recordIntimation(
    @Param('id') id: string,
    @Body(new ZodBody(intimationSchema)) body: IntimationRequest,
  ): Promise<AdmissionRow> {
    return this.psy.recordIntimation(id, body);
  }

  @Permission('psy.admission.record')
  @Post('psy/admissions/:id/discharge')
  async discharge(
    @Param('id') id: string,
    @Body(new ZodBody(dischargeSchema)) body: DischargeRequest,
  ): Promise<AdmissionRow> {
    return this.psy.discharge(id, body);
  }

  // ── Restraint ─────────────────────────────────────────────────────────────

  /** The psychiatrist who orders it is whoever is signed in. */
  @Permission('psy.restraint.order')
  @Post('psy/restraints')
  async orderRestraint(@Body(new ZodBody(restraintSchema)) body: RestraintRequest): Promise<RestraintRow> {
    return this.psy.orderRestraint(body);
  }

  @Permission('psy.restraint.record')
  @Post('psy/restraints/:id/observations')
  async observe(
    @Param('id') id: string,
    @Body(new ZodBody(observationSchema)) body: ObservationRequest,
  ): Promise<RestraintRow> {
    return this.psy.observe(id, body);
  }

  @Permission('psy.restraint.record')
  @Post('psy/restraints/:id/close')
  async closeRestraint(
    @Param('id') id: string,
    @Body(new ZodBody(restraintCloseSchema)) body: RestraintCloseRequest,
  ): Promise<RestraintRow> {
    return this.psy.closeRestraint(id, body);
  }

  @Permission('psy.episode.read')
  @Get('psy/restraints')
  async listRestraints(
    @Query(new ZodBody(restraintQuerySchema)) query: RestraintQuery,
  ): Promise<readonly RestraintRow[]> {
    return this.psy.listRestraints(query);
  }

  // ── Electroconvulsive therapy ─────────────────────────────────────────────

  @Permission('psy.ect.manage')
  @Idempotent()
  @Post('psy/ect-courses')
  async openEctCourse(@Body(new ZodBody(ectCourseSchema)) body: EctCourseRequest): Promise<EctCourseRow> {
    return this.psy.openEctCourse(body);
  }

  @Permission('psy.episode.read')
  @Get('psy/ect-courses/:id')
  async ectCourse(@Param('id') id: string): Promise<EctCourseRow> {
    return this.psy.ectCourse(id);
  }

  /** The anaesthetic agent and the muscle relaxant are both required. */
  @Permission('psy.ect.session.record')
  @Post('psy/ect-courses/:id/sessions')
  async recordEctSession(
    @Param('id') id: string,
    @Body(new ZodBody(ectSessionSchema)) body: EctSessionRequest,
  ): Promise<EctSessionRow> {
    return this.psy.recordEctSession(id, body);
  }
}
