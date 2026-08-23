import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { LabCriticalValueService } from './critical.service.js';
import {
  acknowledgeCriticalSchema,
  criticalCallbackSchema,
  criticalQuerySchema,
  idSchema,
  type AcknowledgeCriticalRequest,
  type CriticalCallbackRequest,
  type CriticalQuery,
} from './lab.schemas.js';
import type { LabCriticalAlertView } from './lab.types.js';

/**
 * `/api/v1/lab/critical-values` — OP-004 §3.5 and `docs/DECISIONS.md` D-10.
 *
 * `lab.critical.notify` and `lab.critical.read` are both `clinicalSafetyExempt`
 * in the permission catalogue, and `EN-040 §5` is the reason: a hospital in
 * arrears on its licence still gets its panic-value loop. An alert nobody can
 * open is not an alert, and a call-back nobody can record is a result released
 * without communication.
 */
@Controller('lab/critical-values')
export class LabCriticalValueController {
  constructor(@Inject(LabCriticalValueService) private readonly critical: LabCriticalValueService) {}

  @Permission('lab.critical.read')
  @Get()
  async list(
    @Query(new ZodBody(criticalQuerySchema)) query: CriticalQuery,
  ): Promise<Page<LabCriticalAlertView>> {
    return this.critical.list(query);
  }

  @Permission('lab.critical.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<LabCriticalAlertView> {
    return this.critical.get(id);
  }

  /**
   * One documented communication attempt: a read-back from a named clinician,
   * or "clinician unreachable — escalated to <tier>". The request body is a
   * discriminated union, so the ambiguous middle cannot even be posted.
   */
  @Permission('lab.critical.notify')
  @Idempotent()
  @Post(':id/notify')
  async notify(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(criticalCallbackSchema)) body: CriticalCallbackRequest,
  ): Promise<LabCriticalAlertView> {
    return this.critical.notify(id, body);
  }

  /** The ordering clinician closing the loop from their inbox. */
  @Permission('lab.critical.notify')
  @Idempotent()
  @Post(':id/acknowledge')
  async acknowledge(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(acknowledgeCriticalSchema)) body: AcknowledgeCriticalRequest,
  ): Promise<LabCriticalAlertView> {
    return this.critical.acknowledge(id, body);
  }
}
