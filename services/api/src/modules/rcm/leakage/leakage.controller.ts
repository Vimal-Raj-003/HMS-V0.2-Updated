import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { LeakageService } from './leakage.service.js';
import {
  acceptFindingSchema,
  dischargeCheckSchema,
  dismissFindingSchema,
  findingQuerySchema,
  idSchema,
  overrideDischargeSchema,
  recordRecoverySchema,
  ruleQuerySchema,
  runScanSchema,
  scanQuerySchema,
  upsertRuleSchema,
  type AcceptFindingRequest,
  type DischargeCheckRequest,
  type DismissFindingRequest,
  type FindingQuery,
  type OverrideDischargeRequest,
  type RecordRecoveryRequest,
  type RuleQuery,
  type RunScanRequest,
  type ScanQuery,
  type UpsertRuleRequest,
} from './leakage.schemas.js';
import type {
  DischargeCheckView,
  LeakDashboardView,
  LeakFindingDetailView,
  LeakFindingView,
  LeakRuleView,
  LeakScanResultView,
  LeakScanView,
} from './leakage.types.js';

/**
 * `/api/v1/leakage/*` — RC-006.
 *
 * ── There is no endpoint that bills anything ────────────────────────────────
 *
 * `phase-05` §5.7: "Never auto-post — propose to a human." Nothing on this
 * controller raises a charge. `POST /findings/:id/accept` agrees a gap is real —
 * which is the *permission* to bill it — and `POST /findings/:id/recovery`
 * records that somebody did. Two calls on two permissions, because a single
 * button that agrees and bills at once is the auto-post the rule forbids, just
 * wearing a person's name.
 *
 * ── `POST /discharge-check` is exit gate 9 ──────────────────────────────────
 *
 * It runs the reconcilers over one encounter synchronously, at the moment
 * somebody asks whether the patient can leave. Clearing it with a gap still
 * open is `POST /discharge-checks/:id/override`, on its own permission, because
 * that is the hospital choosing to lose the money.
 */
@Controller('leakage')
export class LeakageController {
  constructor(@Inject(LeakageService) private readonly leakage: LeakageService) {}

  // ── Rules ──────────────────────────────────────────────────────────────────

  @Permission('leak.rule.read')
  @Get('rules')
  async listRules(@Query(new ZodBody(ruleQuerySchema)) query: RuleQuery): Promise<Page<LeakRuleView>> {
    return this.leakage.listRules(query);
  }

  @Permission('leak.rule.manage')
  @Idempotent()
  @Post('rules')
  async upsertRule(@Body(new ZodBody(upsertRuleSchema)) body: UpsertRuleRequest): Promise<LeakRuleView> {
    return this.leakage.upsertRule(body);
  }

  // ── Scanning ───────────────────────────────────────────────────────────────

  @Permission('leak.scan.read')
  @Get('scans')
  async listScans(@Query(new ZodBody(scanQuerySchema)) query: ScanQuery): Promise<Page<LeakScanView>> {
    return this.leakage.listScans(query);
  }

  @Permission('leak.scan.run')
  @Idempotent()
  @Post('scans')
  async runScan(@Body(new ZodBody(runScanSchema)) body: RunScanRequest): Promise<LeakScanResultView> {
    return this.leakage.runScan(body);
  }

  // ── The worklist ───────────────────────────────────────────────────────────

  @Permission('leak.report.read')
  @Get('dashboard')
  async dashboard(): Promise<LeakDashboardView> {
    return this.leakage.dashboard();
  }

  @Permission('leak.finding.list')
  @Get('findings')
  async listFindings(
    @Query(new ZodBody(findingQuerySchema)) query: FindingQuery,
  ): Promise<Page<LeakFindingView>> {
    return this.leakage.listFindings(query);
  }

  @Permission('leak.finding.read')
  @Get('findings/:id')
  async getFinding(@Param('id', new ZodBody(idSchema)) id: string): Promise<LeakFindingDetailView> {
    return this.leakage.getFinding(id);
  }

  /** The permission to bill it, not the billing. See the class note. */
  @Permission('leak.finding.accept')
  @Idempotent()
  @Post('findings/:id/accept')
  async acceptFinding(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(acceptFindingSchema)) body: AcceptFindingRequest,
  ): Promise<LeakFindingDetailView> {
    return this.leakage.acceptFinding(id, body);
  }

  @Permission('leak.finding.dismiss')
  @Idempotent()
  @Post('findings/:id/dismiss')
  async dismissFinding(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(dismissFindingSchema)) body: DismissFindingRequest,
  ): Promise<LeakFindingDetailView> {
    return this.leakage.dismissFinding(id, body);
  }

  /** Refused unless the finding was accepted first — by the database, not here. */
  @Permission('leak.recovery.record')
  @Idempotent()
  @Post('findings/:id/recovery')
  async recordRecovery(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(recordRecoverySchema)) body: RecordRecoveryRequest,
  ): Promise<LeakFindingDetailView> {
    return this.leakage.recordRecovery(id, body);
  }

  // ── Exit gate 9 ────────────────────────────────────────────────────────────

  @Permission('leak.discharge.check')
  @Idempotent()
  @Post('discharge-check')
  async dischargeCheck(
    @Body(new ZodBody(dischargeCheckSchema)) body: DischargeCheckRequest,
  ): Promise<DischargeCheckView> {
    return this.leakage.dischargeCheck(body);
  }

  /** The hospital choosing to lose the money. Its own permission and a reason. */
  @Permission('leak.discharge.override')
  @Idempotent()
  @Post('discharge-checks/:id/override')
  async overrideDischarge(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(overrideDischargeSchema)) body: OverrideDischargeRequest,
  ): Promise<DischargeCheckView> {
    return this.leakage.overrideDischarge(id, body);
  }
}
