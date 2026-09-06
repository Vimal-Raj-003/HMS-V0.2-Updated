import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { IpBillingService } from './ipbilling.service.js';
import {
  chargeQuerySchema,
  chargeRunSchema,
  clearanceOverrideSchema,
  policySchema,
  type ChargeQuery,
  type ChargeRunRequest,
  type ClearanceOverrideRequest,
  type PolicyRequest,
} from './ipbilling.schemas.js';
import type { ChargeRunView, ClearanceView, RunningBillView } from './ipbilling.types.js';

/**
 * `/api/v1/ipbill/*` — Phase 7C.
 *
 * ── `POST /charge-runs` is safe to call twice ───────────────────────────────
 *
 * It is idempotent against a unique index on (admission, charge date, charge
 * code, occupancy), so a retry, a double-click and two overlapping workers all
 * produce the same bill. `phase-07` calls duplicate room rent "the single most
 * common source of billing disputes in Indian hospitals"; the safety is the
 * index's, not the caller's.
 *
 * ── Clearing re-evaluates first ─────────────────────────────────────────────
 *
 * `PATCH /clearance/:admissionId/clear` recomputes every check before it clears
 * anything. Clearing against a snapshot from a minute ago is how a patient
 * leaves over a test that was billed while they were putting their shoes on.
 */
@Controller('ipbill')
export class IpBillingController {
  constructor(@Inject(IpBillingService) private readonly billing: IpBillingService) {}

  @Permission('ipbill.read')
  @Get('running')
  async runningBill(@Query(new ZodBody(chargeQuerySchema)) query: ChargeQuery): Promise<RunningBillView> {
    return this.billing.runningBill(query);
  }

  @Permission('ipbill.charge.run')
  @Idempotent()
  @Post('charge-runs')
  async runCharges(@Body(new ZodBody(chargeRunSchema)) body: ChargeRunRequest): Promise<ChargeRunView> {
    return this.billing.runCharges(body);
  }

  @Permission('ipbill.charge.explain')
  @Get('charge-runs')
  async runs(): Promise<readonly ChargeRunView[]> {
    return this.billing.runs();
  }

  @Permission('ipbill.policy.manage')
  @Post('policy')
  async setPolicy(@Body(new ZodBody(policySchema)) body: PolicyRequest): Promise<{ readonly id: string }> {
    return this.billing.setPolicy(body);
  }

  @Permission('ipbill.clearance.read')
  @Get('clearance/:admissionId')
  async clearance(@Param('admissionId') admissionId: string): Promise<ClearanceView> {
    return this.billing.evaluateClearance(admissionId);
  }

  @Permission('ipbill.clearance.clear')
  @Patch('clearance/:admissionId/clear')
  async clear(@Param('admissionId') admissionId: string): Promise<ClearanceView> {
    return this.billing.clear(admissionId);
  }

  @Permission('ipbill.clearance.override')
  @Patch('clearance/:admissionId/override')
  async override(
    @Param('admissionId') admissionId: string,
    @Body(new ZodBody(clearanceOverrideSchema)) body: ClearanceOverrideRequest,
  ): Promise<ClearanceView> {
    return this.billing.override(admissionId, body);
  }
}
