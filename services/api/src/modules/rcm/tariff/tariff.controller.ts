import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  changeLogQuerySchema,
  createPlanSchema,
  createVersionSchema,
  idSchema,
  itemQuerySchema,
  missingRateQuerySchema,
  planQuerySchema,
  publishSchema,
  resolveBatchSchema,
  resolveMissingSchema,
  resolveQuerySchema,
  submitSchema,
  upsertItemsSchema,
  versionQuerySchema,
  withdrawSchema,
  type ChangeLogQuery,
  type CreatePlanRequest,
  type CreateVersionRequest,
  type ItemQuery,
  type MissingRateQuery,
  type PlanQuery,
  type PublishRequest,
  type ResolveBatchRequest,
  type ResolveMissingRequest,
  type ResolveQuery,
  type SubmitRequest,
  type UpsertItemsRequest,
  type VersionQuery,
  type WithdrawRequest,
} from './tariff.schemas.js';
import { TariffService } from './tariff.service.js';
import type {
  ChangeLogRow,
  MissingRateRow,
  RateResolution,
  TariffItemView,
  TariffPlanView,
  TariffVersionView,
} from './tariff.types.js';

/**
 * `/api/v1/tariff/*` — RC-003.
 *
 * `GET /resolve` is the hot path: OP-005, IP-005, RC-008 and RC-002 all call it,
 * and `docs/07 §2.1` puts it in the class that has to answer in milliseconds. It
 * is a GET with no side effect visible to the caller, cacheable for the ≤ 60 s
 * RC-003 §5 allows, and gated on `tariff.rate.resolve` — a low-risk key granted
 * widely, because a biller who cannot resolve a rate cannot bill.
 *
 * The write endpoints are split three ways on purpose. `tariff.version.submit`
 * and `tariff.version.publish` are separate keys held by separate roles and
 * carry a `block` segregation rule, so the approval matrix RC-003 §5 describes
 * is enforced by the catalogue rather than by a convention somebody follows.
 */
@Controller('tariff')
export class TariffController {
  constructor(@Inject(TariffService) private readonly tariff: TariffService) {}

  @Permission('tariff.plan.list')
  @Get('plans')
  async listPlans(@Query(new ZodBody(planQuerySchema)) query: PlanQuery): Promise<Page<TariffPlanView>> {
    return this.tariff.listPlans(query);
  }

  @Permission('tariff.plan.configure')
  @Idempotent()
  @Post('plans')
  async createPlan(@Body(new ZodBody(createPlanSchema)) body: CreatePlanRequest): Promise<TariffPlanView> {
    return this.tariff.createPlan(body);
  }

  @Permission('tariff.version.list')
  @Get('plans/:id/versions')
  async listVersions(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Query(new ZodBody(versionQuerySchema)) query: VersionQuery,
  ): Promise<Page<TariffVersionView>> {
    return this.tariff.listVersions(id, query);
  }

  @Permission('tariff.version.create')
  @Idempotent()
  @Post('plans/:id/versions')
  async createVersion(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(createVersionSchema)) body: CreateVersionRequest,
  ): Promise<TariffVersionView> {
    return this.tariff.createVersion(id, body);
  }

  @Permission('tariff.item.list')
  @Get('versions/:id/items')
  async listItems(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Query(new ZodBody(itemQuerySchema)) query: ItemQuery,
  ): Promise<Page<TariffItemView>> {
    return this.tariff.listItems(id, query);
  }

  /**
   * Bulk upsert into a draft. The database refuses this on a published version,
   * so there is no status check here that could drift from the one that matters.
   */
  @Permission('tariff.item.update')
  @Idempotent()
  @Post('versions/:id/items')
  async upsertItems(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(upsertItemsSchema)) body: UpsertItemsRequest,
  ): Promise<{ readonly written: number }> {
    return this.tariff.upsertItems(id, body);
  }

  @Permission('tariff.version.submit')
  @Idempotent()
  @Post('versions/:id/submit')
  async submit(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(submitSchema)) body: SubmitRequest,
  ): Promise<TariffVersionView> {
    return this.tariff.submit(id, body);
  }

  /** Deliberately a different key from `submit`, held by a different role. */
  @Permission('tariff.version.publish')
  @Idempotent()
  @Post('versions/:id/publish')
  async publish(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(publishSchema)) body: PublishRequest,
  ): Promise<TariffVersionView> {
    return this.tariff.publish(id, body);
  }

  @Permission('tariff.version.withdraw')
  @Idempotent()
  @Post('versions/:id/withdraw')
  async withdraw(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(withdrawSchema)) body: WithdrawRequest,
  ): Promise<TariffVersionView> {
    return this.tariff.withdraw(id, body);
  }

  /** The hot path. Never returns zero — a miss is `outcome: "missing_rate"`. */
  @Permission('tariff.rate.resolve')
  @Get('resolve')
  async resolve(@Query(new ZodBody(resolveQuerySchema)) query: ResolveQuery): Promise<RateResolution> {
    return this.tariff.resolve(query);
  }

  @Permission('tariff.rate.resolve')
  @Post('resolve/batch')
  async resolveBatch(
    @Body(new ZodBody(resolveBatchSchema)) body: ResolveBatchRequest,
  ): Promise<{ readonly items: readonly RateResolution[] }> {
    return this.tariff.resolveBatch(body);
  }

  @Permission('tariff.missing.read')
  @Get('missing-rates')
  async missingRates(
    @Query(new ZodBody(missingRateQuerySchema)) query: MissingRateQuery,
  ): Promise<Page<MissingRateRow>> {
    return this.tariff.listMissingRates(query);
  }

  @Permission('tariff.missing.resolve')
  @Idempotent()
  @Post('missing-rates/:id/resolve')
  async resolveMissing(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(resolveMissingSchema)) body: ResolveMissingRequest,
  ): Promise<MissingRateRow> {
    return this.tariff.resolveMissing(id, body);
  }

  @Permission('tariff.audit.read')
  @Get('change-log')
  async changeLog(
    @Query(new ZodBody(changeLogQuerySchema)) query: ChangeLogQuery,
  ): Promise<Page<ChangeLogRow>> {
    return this.tariff.changeLog(query);
  }
}
