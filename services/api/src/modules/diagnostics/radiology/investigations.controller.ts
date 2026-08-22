import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { z } from 'zod';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { InvestigationsService } from './investigations.service.js';
import {
  amendInvestigationReportSchema,
  cosignInvestigationReportSchema,
  createInvestigationStudySchema,
  detachMediaSchema,
  doneInvestigationSchema,
  idSchema,
  investigationMediaSchema,
  investigationReportSchema,
  investigationWorklistQuerySchema,
  signInvestigationReportSchema,
  startInvestigationSchema,
  type AmendInvestigationReportRequest,
  type CosignInvestigationReportRequest,
  type CreateInvestigationStudyRequest,
  type DetachMediaRequest,
  type DoneInvestigationRequest,
  type InvestigationMediaRequest,
  type InvestigationReportRequest,
  type InvestigationWorklistQuery,
  type SignInvestigationReportRequest,
  type StartInvestigationRequest,
} from './radiology.schemas.js';
import type { InvestigationReportView, InvestigationStudyView } from './radiology.types.js';

const criticalNotifySchema = z
  .object({
    summary: z.string().trim().min(3).max(4000),
    informedName: z.string().trim().min(2).max(200),
    method: z.enum(['phone', 'in_person', 'secure_message', 'video', 'pager', 'sms']),
  })
  .strict();

type CriticalNotifyRequest = z.infer<typeof criticalNotifySchema>;

/**
 * `/api/v1/investigations` — OP-022 §6.
 *
 * `invest.report.sign` and `invest.report.cosign` are two keys for one act, and
 * the split is the whole control: a resident holds the first and not the second,
 * so a service configured `cosign_required` cannot be finalised by them.
 * `SEGREGATION_OF_DUTIES_RULES` pairs `invest.report.create` with
 * `invest.report.cosign` as a **warn**, not a block, and the reason is worth
 * knowing — a consultant legitimately drafts their own reports and co-signs a
 * resident's, so blocking the combination would break normal practice. What
 * cannot happen is one person doing both *on the same report*, and that is
 * enforced per report by `clinical.enforce_investigation_cosign()`.
 */
@Controller()
export class InvestigationsController {
  constructor(@Inject(InvestigationsService) private readonly investigations: InvestigationsService) {}

  @Permission('invest.worklist.read')
  @Get('investigations/worklist')
  async worklist(
    @Query(new ZodBody(investigationWorklistQuerySchema)) query: InvestigationWorklistQuery,
  ): Promise<Page<InvestigationStudyView>> {
    return this.investigations.worklist(query);
  }

  @Permission('invest.schedule.manage')
  @Idempotent()
  @Post('investigations/studies')
  async createStudy(
    @Body(new ZodBody(createInvestigationStudySchema)) body: CreateInvestigationStudyRequest,
  ): Promise<InvestigationStudyView> {
    return this.investigations.createStudy(body);
  }

  @Permission('invest.worklist.read')
  @Get('investigations/studies/:id')
  async getStudy(@Param('id', new ZodBody(idSchema)) id: string): Promise<InvestigationStudyView> {
    return this.investigations.getStudy(id);
  }

  @Permission('invest.study.manage')
  @Idempotent()
  @Post('investigations/studies/:id/check-in')
  async checkIn(@Param('id', new ZodBody(idSchema)) id: string): Promise<InvestigationStudyView> {
    return this.investigations.checkIn(id);
  }

  @Permission('invest.study.manage')
  @Idempotent()
  @Post('investigations/studies/:id/start')
  async start(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(startInvestigationSchema)) body: StartInvestigationRequest,
  ): Promise<InvestigationStudyView> {
    return this.investigations.start(id, body);
  }

  @Permission('invest.study.manage')
  @Idempotent()
  @Post('investigations/studies/:id/done')
  async done(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(doneInvestigationSchema)) body: DoneInvestigationRequest,
  ): Promise<InvestigationStudyView> {
    return this.investigations.done(id, body);
  }

  @Permission('invest.media.create')
  @Idempotent()
  @Post('investigations/studies/:id/media')
  async addMedia(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(investigationMediaSchema)) body: InvestigationMediaRequest,
  ): Promise<{ readonly id: string }> {
    return this.investigations.addMedia(id, body);
  }

  @Permission('invest.media.manage')
  @Idempotent()
  @Post('investigations/media/:id/detach')
  async detachMedia(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(detachMediaSchema)) body: DetachMediaRequest,
  ): Promise<{ readonly detached: true }> {
    return this.investigations.detachMedia(id, body);
  }

  @Permission('invest.report.create')
  @Idempotent()
  @Post('investigations/studies/:id/reports')
  async createReport(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(investigationReportSchema)) body: InvestigationReportRequest,
  ): Promise<InvestigationReportView> {
    return this.investigations.createReport(id, body);
  }

  @Permission('invest.report.read')
  @Get('investigations/reports/:id')
  async getReport(@Param('id', new ZodBody(idSchema)) id: string): Promise<InvestigationReportView> {
    return this.investigations.getReport(id);
  }

  @Permission('invest.report.create')
  @Idempotent()
  @Post('investigations/reports/:id/send-for-cosign')
  async sendForCosign(@Param('id', new ZodBody(idSchema)) id: string): Promise<InvestigationReportView> {
    return this.investigations.sendForCosign(id);
  }

  @Permission('invest.report.critical')
  @Idempotent()
  @Post('investigations/reports/:id/critical')
  async critical(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(criticalNotifySchema)) body: CriticalNotifyRequest,
  ): Promise<InvestigationReportView> {
    return this.investigations.flagCritical(id, body);
  }

  @Permission('invest.report.sign')
  @Idempotent()
  @Post('investigations/reports/:id/sign')
  async sign(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(signInvestigationReportSchema)) body: SignInvestigationReportRequest,
  ): Promise<InvestigationReportView> {
    return this.investigations.sign(id, body);
  }

  @Permission('invest.report.cosign')
  @Idempotent()
  @Post('investigations/reports/:id/cosign')
  async cosign(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cosignInvestigationReportSchema)) body: CosignInvestigationReportRequest,
  ): Promise<InvestigationReportView> {
    return this.investigations.cosign(id, body);
  }

  @Permission('invest.report.amend')
  @Idempotent()
  @Post('investigations/reports/:id/amend')
  async amend(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(amendInvestigationReportSchema)) body: AmendInvestigationReportRequest,
  ): Promise<InvestigationReportView> {
    return this.investigations.amend(id, body);
  }
}
