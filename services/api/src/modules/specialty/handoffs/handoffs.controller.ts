import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { HandoffsService } from './handoffs.service.js';
import {
  pathwayQuerySchema,
  pathwaySchema,
  pathwayStepSchema,
  referralCancelSchema,
  referralQuerySchema,
  referralReplySchema,
  referralSchema,
  teleConsultCloseSchema,
  teleConsultSchema,
  telePrescriptionSchema,
  teleQuerySchema,
  type PathwayQuery,
  type PathwayRequest,
  type PathwayStepRequest,
  type ReferralCancelRequest,
  type ReferralQuery,
  type ReferralReplyRequest,
  type ReferralRequest,
  type TeleConsultCloseRequest,
  type TeleConsultRequest,
  type TelePrescriptionRequest,
  type TeleQuery,
} from './handoffs.schemas.js';
import type {
  PathwayInstanceRow,
  PathwayStepRecordRow,
  ReferralRow,
  TeleConsultRow,
  TeleDrugRuleRow,
  TelePrescriptionLineRow,
  VarianceTallyRow,
} from './handoffs.types.js';

/**
 * `/api/v1/tele/*`, `/referrals/*` and `/pathways/*` — OP-018, OP-021, IP-020.
 *
 * ── There is no route that reaches the prohibited list ─────────────────────
 *
 * No override, no waive, no "prescribe anyway". Nothing scheduled under the
 * NDPS Act may be prescribed by telemedicine in any mode, on any consultation,
 * by anybody — it is the one absolute in the Telemedicine Practice Guidelines,
 * and the honest way to hold an absolute is to have no shape that expresses an
 * exception to it.
 *
 * ── And none that closes a referral ────────────────────────────────────────
 *
 * Closure is a flag on the *reply*, not a route of its own. A `POST /close`
 * would be a route somebody eventually calls without a reply; the database
 * would refuse it, but a shape that only exists to be refused is a shape worth
 * not offering.
 */
@Controller()
export class HandoffsController {
  constructor(@Inject(HandoffsService) private readonly svc: HandoffsService) {}

  // ── Telemedicine ──────────────────────────────────────────────────────────

  @Permission('tele.consult.conduct')
  @Idempotent()
  @Post('tele/consults')
  async openConsult(@Body(new ZodBody(teleConsultSchema)) body: TeleConsultRequest): Promise<TeleConsultRow> {
    return this.svc.openConsult(body);
  }

  @Permission('tele.consult.conduct')
  @Post('tele/consults/:id/close')
  async closeConsult(
    @Param('id') id: string,
    @Body(new ZodBody(teleConsultCloseSchema)) body: TeleConsultCloseRequest,
  ): Promise<TeleConsultRow> {
    return this.svc.closeConsult(id, body);
  }

  @Permission('tele.read')
  @Get('tele/consults')
  async listConsults(
    @Query(new ZodBody(teleQuerySchema)) query: TeleQuery,
  ): Promise<readonly TeleConsultRow[]> {
    return this.svc.listConsults(query);
  }

  /** Which drugs are reachable follows from the lists and the mode, not this key. */
  @Permission('tele.prescribe')
  @Idempotent()
  @Post('tele/consults/:id/prescriptions')
  async prescribe(
    @Param('id') id: string,
    @Body(new ZodBody(telePrescriptionSchema)) body: TelePrescriptionRequest,
  ): Promise<TelePrescriptionLineRow> {
    return this.svc.prescribe(id, body);
  }

  @Permission('tele.read')
  @Get('tele/consults/:id/prescriptions')
  async listPrescriptions(@Param('id') id: string): Promise<readonly TelePrescriptionLineRow[]> {
    return this.svc.listPrescriptions(id);
  }

  /**
   * The four lists read against one consultation, so the doctor sees what is
   * out of reach before they type a drug rather than after.
   */
  @Permission('tele.read')
  @Get('tele/drug-rules')
  async listDrugRules(@Query('consultId') consultId?: string): Promise<readonly TeleDrugRuleRow[]> {
    return this.svc.listDrugRules(consultId);
  }

  // ── Referrals ─────────────────────────────────────────────────────────────

  @Permission('referral.raise')
  @Idempotent()
  @Post('referrals')
  async raiseReferral(@Body(new ZodBody(referralSchema)) body: ReferralRequest): Promise<ReferralRow> {
    return this.svc.raiseReferral(body);
  }

  @Permission('referral.reply')
  @Post('referrals/:id/acknowledge')
  async acknowledgeReferral(@Param('id') id: string): Promise<ReferralRow> {
    return this.svc.acknowledgeReferral(id);
  }

  @Permission('referral.reply')
  @Post('referrals/:id/reply')
  async replyToReferral(
    @Param('id') id: string,
    @Body(new ZodBody(referralReplySchema)) body: ReferralReplyRequest,
  ): Promise<ReferralRow> {
    return this.svc.replyToReferral(id, body);
  }

  /**
   * Cancelling is not closing, and the reason is mandatory because it is the
   * only record of why a patient who was referred somewhere never went.
   */
  @Permission('referral.raise')
  @Post('referrals/:id/cancel')
  async cancelReferral(
    @Param('id') id: string,
    @Body(new ZodBody(referralCancelSchema)) body: ReferralCancelRequest,
  ): Promise<ReferralRow> {
    return this.svc.cancelReferral(id, body);
  }

  @Permission('referral.read')
  @Get('referrals')
  async listReferrals(
    @Query(new ZodBody(referralQuerySchema)) query: ReferralQuery,
  ): Promise<readonly ReferralRow[]> {
    return this.svc.listReferrals(query);
  }

  // ── Clinical pathways ─────────────────────────────────────────────────────

  @Permission('pathway.start')
  @Idempotent()
  @Post('pathways')
  async startPathway(@Body(new ZodBody(pathwaySchema)) body: PathwayRequest): Promise<PathwayInstanceRow> {
    return this.svc.startPathway(body);
  }

  @Permission('pathway.step.record')
  @Post('pathways/:id/steps')
  async recordStep(
    @Param('id') id: string,
    @Body(new ZodBody(pathwayStepSchema)) body: PathwayStepRequest,
  ): Promise<PathwayInstanceRow> {
    return this.svc.recordStep(id, body);
  }

  @Permission('pathway.read')
  @Get('pathways')
  async listPathways(
    @Query(new ZodBody(pathwayQuerySchema)) query: PathwayQuery,
  ): Promise<readonly PathwayInstanceRow[]> {
    return this.svc.listPathways(query);
  }

  @Permission('pathway.read')
  @Get('pathways/variance-report')
  async varianceReport(@Query('pathwayKey') pathwayKey?: string): Promise<readonly VarianceTallyRow[]> {
    return this.svc.varianceReport(pathwayKey);
  }

  @Permission('pathway.read')
  @Get('pathways/:id/steps')
  async listSteps(@Param('id') id: string): Promise<readonly PathwayStepRecordRow[]> {
    return this.svc.listSteps(id);
  }
}
