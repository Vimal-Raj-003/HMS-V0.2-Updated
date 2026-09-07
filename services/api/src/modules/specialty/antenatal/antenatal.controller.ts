import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { AntenatalService } from './antenatal.service.js';
import {
  deliveryPlanSchema,
  eddOverrideSchema,
  formFSchema,
  formFSignSchema,
  mtpPerformSchema,
  mtpQuerySchema,
  mtpSchema,
  pncSchema,
  pregnancyQuerySchema,
  pregnancySchema,
  pregnancyUpdateSchema,
  scheduleItemSchema,
  scheduleQuerySchema,
  scheduleUpdateSchema,
  sonologistSchema,
  visitSchema,
  type DeliveryPlanRequest,
  type EddOverrideRequest,
  type FormFRequest,
  type FormFSignRequest,
  type MtpPerformRequest,
  type MtpQuery,
  type MtpRequest,
  type PncRequest,
  type PregnancyQuery,
  type PregnancyRequest,
  type PregnancyUpdateRequest,
  type ScheduleItemRequest,
  type ScheduleQuery,
  type ScheduleUpdateRequest,
  type SonologistRequest,
  type VisitRequest,
} from './antenatal.schemas.js';
import type {
  AncVisitRow,
  DeliveryPlanRow,
  FormFRow,
  MtpCaseRow,
  PncVisitRow,
  PregnancyDetail,
  PregnancyRow,
  ScheduleItemRow,
  SonologistRow,
} from './antenatal.types.js';

/**
 * `/api/v1/obg/*` — OP-040.
 *
 * ── One route is the documented way past a derivation ──────────────────────
 *
 * `POST pregnancies/:id/edd` sets the working estimated date of delivery by
 * clinical judgement. Two scans four weeks apart can genuinely disagree, and a
 * clinician who has looked at both is entitled to decide — so the override
 * exists, carries a rationale that lands on the record rather than only in
 * audit, and marks the dating `clinical` so every later reader knows it is a
 * judgement. Every scheduled visit, test and scan moves with it.
 *
 * ── And there is no route that reports the sex of a foetus ─────────────────
 *
 * Nor one that skips a Medical Board, records a husband's consent, or forces a
 * Form F past the register. Each of those is the thing its statute exists to
 * prevent, and a route for it would be that thing with a permission attached.
 */
@Controller()
export class AntenatalController {
  constructor(@Inject(AntenatalService) private readonly antenatal: AntenatalService) {}

  // ── The pregnancy ─────────────────────────────────────────────────────────

  @Permission('obg.pregnancy.register')
  @Idempotent()
  @Post('obg/pregnancies')
  async register(@Body(new ZodBody(pregnancySchema)) body: PregnancyRequest): Promise<PregnancyRow> {
    return this.antenatal.register(body);
  }

  @Permission('obg.pregnancy.read')
  @Get('obg/pregnancies')
  async list(
    @Query(new ZodBody(pregnancyQuerySchema)) query: PregnancyQuery,
  ): Promise<readonly PregnancyRow[]> {
    return this.antenatal.list(query);
  }

  @Permission('obg.pregnancy.read')
  @Get('obg/pregnancies/:id')
  async detail(@Param('id') id: string): Promise<PregnancyDetail> {
    return this.antenatal.detail(id);
  }

  @Permission('obg.pregnancy.update')
  @Post('obg/pregnancies/:id')
  async update(
    @Param('id') id: string,
    @Body(new ZodBody(pregnancyUpdateSchema)) body: PregnancyUpdateRequest,
  ): Promise<PregnancyRow> {
    return this.antenatal.update(id, body);
  }

  /** Every date in the record moves with it, so it is a named act with a reason. */
  @Permission('obg.edd.override')
  @Post('obg/pregnancies/:id/edd')
  async overrideEdd(
    @Param('id') id: string,
    @Body(new ZodBody(eddOverrideSchema)) body: EddOverrideRequest,
  ): Promise<PregnancyRow> {
    return this.antenatal.overrideEdd(id, body);
  }

  // ── The visit ─────────────────────────────────────────────────────────────

  @Permission('obg.visit.record')
  @Idempotent()
  @Post('obg/pregnancies/:id/visits')
  async recordVisit(
    @Param('id') id: string,
    @Body(new ZodBody(visitSchema)) body: VisitRequest,
  ): Promise<AncVisitRow> {
    return this.antenatal.recordVisit(id, body);
  }

  /** A visit carrying a danger sign cannot be signed without a plan. */
  @Permission('obg.visit.sign')
  @Post('obg/visits/:id/sign')
  async signVisit(@Param('id') id: string): Promise<AncVisitRow> {
    return this.antenatal.signVisit(id);
  }

  // ── The schedule ──────────────────────────────────────────────────────────

  @Permission('obg.pregnancy.read')
  @Get('obg/schedule')
  async listSchedule(
    @Query(new ZodBody(scheduleQuerySchema)) query: ScheduleQuery,
  ): Promise<readonly ScheduleItemRow[]> {
    return this.antenatal.listSchedule(query);
  }

  @Permission('obg.schedule.manage')
  @Post('obg/pregnancies/:id/schedule')
  async addScheduleItem(
    @Param('id') id: string,
    @Body(new ZodBody(scheduleItemSchema)) body: ScheduleItemRequest,
  ): Promise<ScheduleItemRow> {
    return this.antenatal.addScheduleItem(id, body);
  }

  @Permission('obg.schedule.manage')
  @Post('obg/schedule/:id')
  async updateScheduleItem(
    @Param('id') id: string,
    @Body(new ZodBody(scheduleUpdateSchema)) body: ScheduleUpdateRequest,
  ): Promise<ScheduleItemRow> {
    return this.antenatal.updateScheduleItem(id, body);
  }

  @Permission('obg.delivery_plan.write')
  @Idempotent()
  @Post('obg/pregnancies/:id/delivery-plan')
  async writeDeliveryPlan(
    @Param('id') id: string,
    @Body(new ZodBody(deliveryPlanSchema)) body: DeliveryPlanRequest,
  ): Promise<DeliveryPlanRow> {
    return this.antenatal.writeDeliveryPlan(id, body);
  }

  @Permission('obg.pnc.record')
  @Idempotent()
  @Post('obg/pregnancies/:id/pnc')
  async recordPnc(
    @Param('id') id: string,
    @Body(new ZodBody(pncSchema)) body: PncRequest,
  ): Promise<PncVisitRow> {
    return this.antenatal.recordPnc(id, body);
  }

  // ── PC-PNDT ───────────────────────────────────────────────────────────────

  @Permission('pcpndt.form_f.write')
  @Idempotent()
  @Post('obg/form-f')
  async draftFormF(@Body(new ZodBody(formFSchema)) body: FormFRequest): Promise<FormFRow> {
    return this.antenatal.draftFormF(body);
  }

  @Permission('obg.pregnancy.read')
  @Get('obg/form-f')
  async listFormF(): Promise<readonly FormFRow[]> {
    return this.antenatal.listFormF();
  }

  /**
   * Signing needs both declarations, and the signer has to be on the centre's
   * statutory register — which the database checks rather than this key.
   */
  @Permission('pcpndt.form_f.sign')
  @Post('obg/form-f/:id/sign')
  async signFormF(
    @Param('id') id: string,
    @Body(new ZodBody(formFSignSchema)) body: FormFSignRequest,
  ): Promise<FormFRow> {
    return this.antenatal.signFormF(id, body);
  }

  @Permission('pcpndt.register.manage')
  @Post('obg/sonologists')
  async addSonologist(@Body(new ZodBody(sonologistSchema)) body: SonologistRequest): Promise<SonologistRow> {
    return this.antenatal.addSonologist(body);
  }

  @Permission('obg.pregnancy.read')
  @Get('obg/sonologists')
  async listSonologists(): Promise<readonly SonologistRow[]> {
    return this.antenatal.listSonologists();
  }

  // ── MTP ───────────────────────────────────────────────────────────────────

  @Permission('obg.mtp.record')
  @Idempotent()
  @Post('obg/mtp')
  async recordMtp(@Body(new ZodBody(mtpSchema)) body: MtpRequest): Promise<MtpCaseRow> {
    return this.antenatal.recordMtp(body);
  }

  @Permission('obg.mtp.record')
  @Post('obg/mtp/:id/perform')
  async performMtp(
    @Param('id') id: string,
    @Body(new ZodBody(mtpPerformSchema)) body: MtpPerformRequest,
  ): Promise<MtpCaseRow> {
    return this.antenatal.performMtp(id, body);
  }

  @Permission('obg.mtp.read')
  @Get('obg/mtp')
  async listMtp(@Query(new ZodBody(mtpQuerySchema)) query: MtpQuery): Promise<readonly MtpCaseRow[]> {
    return this.antenatal.listMtp(query);
  }
}
