import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { HealthCheckService } from './healthcheck.service.js';
import { ImmunisationService } from './immunisation.service.js';
import {
  administerSchema,
  aefiSchema,
  breachDecisionSchema,
  breachSchema,
  discardVialSchema,
  hcBookingSchema,
  hcCheckInSchema,
  hcQuerySchema,
  hcReportSchema,
  immunisationQuerySchema,
  openVialSchema,
  planDoseUpdateSchema,
  stationUpdateSchema,
  vialQuerySchema,
  voidDoseSchema,
  type AdministerRequest,
  type AefiRequest,
  type BreachDecisionRequest,
  type BreachRequest,
  type DiscardVialRequest,
  type HcBookingRequest,
  type HcCheckInRequest,
  type HcQuery,
  type HcReportRequest,
  type ImmunisationQuery,
  type OpenVialRequest,
  type PlanDoseUpdateRequest,
  type StationUpdateRequest,
  type VialQuery,
  type VoidDoseRequest,
} from './programme.schemas.js';
import type {
  AefiRow,
  BreachRow,
  HcEpisodeDetail,
  HcEpisodeRow,
  HcReportRow,
  PlanDoseRow,
  VaccinationRow,
  VialRow,
} from './programme.types.js';

/**
 * `/api/v1/immunisation/*` and `/healthcheck/*` — OP-013, OP-014.
 *
 * ── Two routes are the documented way past a rule ──────────────────────────
 *
 * `POST immunisation/breaches/:id/decide` releases or condemns the vaccine a
 * cold chain hold is refusing, and `POST immunisation/records/:id/void` strikes
 * a dose from a child's record. Both are `high` keys with a reason, and both
 * exist because the alternative is a hold nobody can lift and a wrong dose
 * nobody can correct.
 *
 * ── And there is no route that forces a health check report ────────────────
 *
 * A station is done or skipped with a reason that goes on the report. There is
 * no `force_sign`, because the failure this console exists to prevent is a
 * report that reads as complete over a scan nobody did — and a key for it would
 * be that failure with a permission attached.
 */
@Controller()
export class ProgrammeController {
  constructor(
    @Inject(ImmunisationService) private readonly immunisation: ImmunisationService,
    @Inject(HealthCheckService) private readonly healthcheck: HealthCheckService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-013 · Immunisation
  // ═══════════════════════════════════════════════════════════════════════════

  @Permission('immunisation.vial.open')
  @Idempotent()
  @Post('immunisation/vials')
  async openVial(@Body(new ZodBody(openVialSchema)) body: OpenVialRequest): Promise<VialRow> {
    return this.immunisation.openVial(body);
  }

  /** What a session can actually draw from, with the clock on each. */
  @Permission('immunisation.record.read')
  @Get('immunisation/vials')
  async listVials(@Query(new ZodBody(vialQuerySchema)) query: VialQuery): Promise<readonly VialRow[]> {
    return this.immunisation.listVials(query);
  }

  @Permission('immunisation.vial.discard')
  @Post('immunisation/vials/:id/discard')
  async discardVial(
    @Param('id') id: string,
    @Body(new ZodBody(discardVialSchema)) body: DiscardVialRequest,
  ): Promise<VialRow> {
    return this.immunisation.discardVial(id, body);
  }

  @Permission('immunisation.dose.administer')
  @Idempotent()
  @Post('immunisation/records')
  async administer(@Body(new ZodBody(administerSchema)) body: AdministerRequest): Promise<VaccinationRow> {
    return this.immunisation.administer(body);
  }

  @Permission('immunisation.record.read')
  @Get('immunisation/records')
  async listRecords(
    @Query(new ZodBody(immunisationQuerySchema)) query: ImmunisationQuery,
  ): Promise<readonly VaccinationRow[]> {
    return this.immunisation.listRecords(query);
  }

  /** Strikes the dose and puts it back on the recall list. Never a delete. */
  @Permission('immunisation.record.void')
  @Post('immunisation/records/:id/void')
  async voidDose(
    @Param('id') id: string,
    @Body(new ZodBody(voidDoseSchema)) body: VoidDoseRequest,
  ): Promise<VaccinationRow> {
    return this.immunisation.voidDose(id, body);
  }

  @Permission('immunisation.record.read')
  @Get('immunisation/plan-doses')
  async listPlanDoses(
    @Query(new ZodBody(immunisationQuerySchema)) query: ImmunisationQuery,
  ): Promise<readonly PlanDoseRow[]> {
    return this.immunisation.listPlanDoses(query);
  }

  @Permission('immunisation.plan.manage')
  @Post('immunisation/plan-doses/:id')
  async updatePlanDose(
    @Param('id') id: string,
    @Body(new ZodBody(planDoseUpdateSchema)) body: PlanDoseUpdateRequest,
  ): Promise<PlanDoseRow> {
    return this.immunisation.updatePlanDose(id, body);
  }

  @Permission('immunisation.coldchain.record')
  @Idempotent()
  @Post('immunisation/breaches')
  async recordBreach(@Body(new ZodBody(breachSchema)) body: BreachRequest): Promise<BreachRow> {
    return this.immunisation.recordBreach(body);
  }

  @Permission('immunisation.coldchain.record')
  @Get('immunisation/breaches')
  async listBreaches(): Promise<readonly BreachRow[]> {
    return this.immunisation.listBreaches();
  }

  /** The moment the hold means anything. Releasing puts the doses back into arms. */
  @Permission('immunisation.breach.decide')
  @Post('immunisation/breaches/:id/decide')
  async decideBreach(
    @Param('id') id: string,
    @Body(new ZodBody(breachDecisionSchema)) body: BreachDecisionRequest,
  ): Promise<BreachRow> {
    return this.immunisation.decideBreach(id, body);
  }

  @Permission('immunisation.aefi.report')
  @Idempotent()
  @Post('immunisation/aefi')
  async reportAefi(@Body(new ZodBody(aefiSchema)) body: AefiRequest): Promise<AefiRow> {
    return this.immunisation.reportAefi(body);
  }

  @Permission('immunisation.record.read')
  @Get('immunisation/aefi')
  async listAefi(): Promise<readonly AefiRow[]> {
    return this.immunisation.listAefi();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OP-014 · Health check-ups
  // ═══════════════════════════════════════════════════════════════════════════

  @Permission('healthcheck.booking.create')
  @Idempotent()
  @Post('healthcheck/bookings')
  async book(
    @Body(new ZodBody(hcBookingSchema)) body: HcBookingRequest,
  ): Promise<{ readonly id: string; readonly status: string }> {
    return this.healthcheck.book(body);
  }

  /** Raises the routing slip from the package, once, at the door. */
  @Permission('healthcheck.episode.checkin')
  @Idempotent()
  @Post('healthcheck/bookings/:id/check-in')
  async checkIn(
    @Param('id') id: string,
    @Body(new ZodBody(hcCheckInSchema)) body: HcCheckInRequest,
  ): Promise<HcEpisodeDetail> {
    return this.healthcheck.checkIn(id, body);
  }

  @Permission('healthcheck.episode.read')
  @Get('healthcheck/episodes')
  async listEpisodes(@Query(new ZodBody(hcQuerySchema)) query: HcQuery): Promise<readonly HcEpisodeRow[]> {
    return this.healthcheck.listEpisodes(query);
  }

  @Permission('healthcheck.episode.read')
  @Get('healthcheck/episodes/:id')
  async episodeDetail(@Param('id') id: string): Promise<HcEpisodeDetail> {
    return this.healthcheck.episodeDetail(id);
  }

  @Permission('healthcheck.station.record')
  @Post('healthcheck/stations/:id')
  async updateStation(
    @Param('id') id: string,
    @Body(new ZodBody(stationUpdateSchema)) body: StationUpdateRequest,
  ): Promise<HcEpisodeDetail> {
    return this.healthcheck.updateStation(id, body);
  }

  @Permission('healthcheck.report.write')
  @Idempotent()
  @Post('healthcheck/episodes/:id/reports')
  async draftReport(
    @Param('id') id: string,
    @Body(new ZodBody(hcReportSchema)) body: HcReportRequest,
  ): Promise<HcReportRow> {
    return this.healthcheck.draftReport(id, body);
  }

  @Permission('healthcheck.report.sign')
  @Post('healthcheck/reports/:id/sign')
  async signReport(@Param('id') id: string): Promise<HcReportRow> {
    return this.healthcheck.signReport(id);
  }
}
