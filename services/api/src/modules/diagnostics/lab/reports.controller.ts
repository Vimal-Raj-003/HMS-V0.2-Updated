import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { generateReportSchema, idSchema, type GenerateReportRequest } from './lab.schemas.js';
import type { LabReportView } from './lab.types.js';
import { LabReportsService } from './reports.service.js';

/**
 * `/api/v1/lab/reports` — OP-004 §3.6.
 *
 * The route produces the report *record*: its version, its scope, whether the
 * NABL logo may lawfully print on it, and the token behind the QR block. The PDF
 * is rendered by the worker, so there is no endpoint here that blocks a request
 * thread on Chromium.
 */
@Controller('lab/reports')
export class LabReportsController {
  constructor(@Inject(LabReportsService) private readonly reports: LabReportsService) {}

  @Permission('lab.report.generate')
  @Idempotent()
  @Post(':orderId/generate')
  async generate(
    @Param('orderId', new ZodBody(idSchema)) orderId: string,
    @Body(new ZodBody(generateReportSchema)) body: GenerateReportRequest,
  ): Promise<LabReportView> {
    return this.reports.generate(orderId, body);
  }

  @Permission('lab.report.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<LabReportView> {
    return this.reports.get(id);
  }
}
