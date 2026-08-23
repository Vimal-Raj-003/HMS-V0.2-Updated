import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  idSchema,
  qcActionSchema,
  qcRunSchema,
  qcStateQuerySchema,
  qcUnlockSchema,
  type QcActionRequest,
  type QcRunRequest,
  type QcStateQuery,
  type QcUnlockRequest,
} from './lab.schemas.js';
import type { LabQcRunView, LabQcStateView } from './lab.types.js';
import { LabQcService } from './qc.service.js';

/**
 * `/api/v1/lab/qc` — EN-031.
 *
 * There is deliberately **no** endpoint that releases a held result. Release is
 * `POST /lab/results/verify` and `POST /lab/results/authorise`, gated by the
 * database; what lives here is the evidence that changes the gate's answer — a
 * QC run, a corrective action, a lockout lifted against a passing control. The
 * one route around a closed gate is `POST /lab/qc/actions` with
 * `patientImpact: released_with_authorisation`, which asserts
 * `labq.qc.release_override` — Lab Director, step-up, written reason — and
 * produces an action id the caller then names on the release. It is not a retry
 * and it is not shaped like one.
 */
@Controller('lab/qc')
export class LabQcController {
  constructor(@Inject(LabQcService) private readonly qc: LabQcService) {}

  /** The blocked-analyte dashboard. `never_evaluated` shows as not releasable. */
  @Permission('labq.qc.read')
  @Get('state')
  async state(
    @Query(new ZodBody(qcStateQuerySchema)) query: QcStateQuery,
  ): Promise<{ readonly items: readonly LabQcStateView[] }> {
    return this.qc.state(query);
  }

  @Permission('labq.qc.enter')
  @Idempotent()
  @Post('runs')
  async recordRun(@Body(new ZodBody(qcRunSchema)) body: QcRunRequest): Promise<LabQcRunView> {
    return this.qc.recordRun(body);
  }

  @Permission('labq.qc.read')
  @Get('runs/:id')
  async getRun(@Param('id', new ZodBody(idSchema)) id: string): Promise<LabQcRunView> {
    return this.qc.getRun(id);
  }

  /**
   * The corrective action. On the `released_with_authorisation` arm the service
   * additionally asserts `labq.qc.release_override`, which a route decorator
   * cannot do on its own — the ordinary arm must stay open to a bench
   * technician recording a root cause.
   */
  @Permission('labq.qc.action')
  @Idempotent()
  @Post('actions')
  async recordAction(
    @Body(new ZodBody(qcActionSchema)) body: QcActionRequest,
  ): Promise<{ readonly actionId: string }> {
    return this.qc.recordAction(body);
  }

  @Permission('lab.qc.unlock')
  @Idempotent()
  @Post('lockouts/:id/unlock')
  async unlock(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(qcUnlockSchema)) body: QcUnlockRequest,
  ): Promise<{ readonly state: string }> {
    return this.qc.unlock(id, body);
  }
}
