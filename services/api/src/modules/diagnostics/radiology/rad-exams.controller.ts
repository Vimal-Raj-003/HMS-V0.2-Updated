import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { RadExamsService } from './rad-exams.service.js';
import {
  completeExamSchema,
  contrastSchema,
  doseSchema,
  formFSchema,
  idSchema,
  repeatExposureSchema,
  startExamSchema,
  type CompleteExamRequest,
  type ContrastRequest,
  type DoseRequest,
  type FormFRequest,
  type RepeatExposureRequest,
  type StartExamRequest,
} from './radiology.schemas.js';
import type { DoseSummaryView, RadExamView } from './radiology.types.js';

/**
 * `/api/v1/rad` — OP-008 §6, the technologist and dose half.
 *
 * `rad.study.complete` covers the whole acquisition workflow — start, repeats,
 * contrast, completion — and it is the key a radiologist's role does not need
 * and a technologist's role does. It is also one half of a `block` pair in
 * `SEGREGATION_OF_DUTIES_RULES`: no role may hold both it and
 * `rad.report.sign`, because "the person who chose the exposure is not an
 * independent reader of it".
 *
 * Form F sits behind `rad.pnpdt.manage`, which is `sensitiveGrant`,
 * `requiresReason` and `requiresStepUp` — three kinds of friction on one key,
 * and the catalogue is right to put them there: the Act makes the recording
 * clinician personally liable.
 */
@Controller()
export class RadExamsController {
  constructor(@Inject(RadExamsService) private readonly exams: RadExamsService) {}

  @Permission('rad.study.complete')
  @Idempotent()
  @Post('rad/order-items/:id/exam')
  async start(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(startExamSchema)) body: StartExamRequest,
  ): Promise<RadExamView> {
    return this.exams.start(id, body);
  }

  @Permission('rad.study.complete')
  @Get('rad/exams/:id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<RadExamView> {
    return this.exams.get(id);
  }

  /**
   * The Form F gate fires on this route for an obstetric ultrasound, and the
   * refusal arrives as `statutory-limit` rather than as a validation error.
   */
  @Permission('rad.study.complete')
  @Idempotent()
  @Post('rad/exams/:id/complete')
  async complete(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(completeExamSchema)) body: CompleteExamRequest,
  ): Promise<RadExamView> {
    return this.exams.complete(id, body);
  }

  @Permission('rad.study.complete')
  @Idempotent()
  @Post('rad/exams/:id/repeats')
  async repeat(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(repeatExposureSchema)) body: RepeatExposureRequest,
  ): Promise<RadExamView> {
    return this.exams.logRepeat(id, body);
  }

  @Permission('rad.study.complete')
  @Idempotent()
  @Post('rad/exams/:id/contrast')
  async contrast(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(contrastSchema)) body: ContrastRequest,
  ): Promise<RadExamView> {
    return this.exams.recordContrast(id, body);
  }

  /** OP-008 §3.6 — RDSR, header, MPPS, OCR or a documented manual entry. */
  @Permission('rad.dose.record')
  @Idempotent()
  @Post('rad/exams/:id/dose')
  async dose(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(doseSchema)) body: DoseRequest,
  ): Promise<DoseSummaryView> {
    return this.exams.recordDose(id, body);
  }

  @Permission('rad.dose.read')
  @Get('rad/patients/:id/dose-summary')
  async doseSummary(@Param('id', new ZodBody(idSchema)) id: string): Promise<DoseSummaryView> {
    return this.exams.doseSummary(id);
  }

  @Permission('rad.pnpdt.manage')
  @Idempotent()
  @Post('rad/order-items/:id/form-f')
  async formF(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(formFSchema)) body: FormFRequest,
  ): Promise<{ readonly formSerialNo: string }> {
    return this.exams.recordFormF(id, body);
  }
}
