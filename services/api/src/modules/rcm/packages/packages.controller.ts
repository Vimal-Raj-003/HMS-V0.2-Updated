import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { PackagesService } from './packages.service.js';
import {
  activateSchema,
  bookSchema,
  closeActivationSchema,
  createPackageSchema,
  decideVarianceSchema,
  evaluateChargeSchema,
  idSchema,
  packageQuerySchema,
  publishVersionSchema,
  requestVarianceSchema,
  type ActivateRequest,
  type BookRequest,
  type CloseActivationRequest,
  type CreatePackageRequest,
  type DecideVarianceRequest,
  type EvaluateChargeRequest,
  type PackageQuery,
  type PublishVersionRequest,
  type RequestVarianceRequest,
} from './packages.schemas.js';
import type {
  ChargeEvaluationView,
  PackageActivationView,
  PackageBookingView,
  PackageView,
  VarianceRequestView,
} from './packages.types.js';

/**
 * `/api/v1/packages/*` — OP-023.
 *
 * `POST /activations/:id/evaluate` is the busiest route: OP-005 calls it for
 * every charge on a patient who holds a package, and its answer decides whether
 * the line reaches the patient's bill. Idempotent, because a retried charge post
 * must not consume the cap twice.
 *
 * Variance request and decision are two routes on two keys held by two roles,
 * with a `block` rule behind them — deciding who pays an overrun on a
 * fixed-price promise is finance's call, never the desk that sold it.
 */
@Controller('packages')
export class PackagesController {
  constructor(@Inject(PackagesService) private readonly packages: PackagesService) {}

  @Permission('pkg.list')
  @Get()
  async list(@Query(new ZodBody(packageQuerySchema)) query: PackageQuery): Promise<Page<PackageView>> {
    return this.packages.listPackages(query);
  }

  @Permission('pkg.configure')
  @Idempotent()
  @Post()
  async create(@Body(new ZodBody(createPackageSchema)) body: CreatePackageRequest): Promise<PackageView> {
    return this.packages.createPackage(body);
  }

  @Permission('pkg.version.publish')
  @Idempotent()
  @Post(':id/versions')
  async publishVersion(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(publishVersionSchema)) body: PublishVersionRequest,
  ): Promise<{ readonly versionId: string; readonly version: number }> {
    return this.packages.publishVersion(id, body);
  }

  @Permission('pkg.booking.create')
  @Idempotent()
  @Post('bookings')
  async book(@Body(new ZodBody(bookSchema)) body: BookRequest): Promise<PackageBookingView> {
    return this.packages.book(body);
  }

  @Permission('pkg.activate')
  @Idempotent()
  @Post('activations')
  async activate(@Body(new ZodBody(activateSchema)) body: ActivateRequest): Promise<PackageActivationView> {
    return this.packages.activate(body);
  }

  @Permission('pkg.activation.read')
  @Get('activations/:id')
  async getActivation(@Param('id', new ZodBody(idSchema)) id: string): Promise<PackageActivationView> {
    return this.packages.getActivation(id);
  }

  /** Called by OP-005 for every charge on a patient who holds a package. */
  @Permission('pkg.activation.read')
  @Idempotent()
  @Post('activations/:id/evaluate')
  async evaluate(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(evaluateChargeSchema)) body: EvaluateChargeRequest,
  ): Promise<ChargeEvaluationView> {
    return this.packages.evaluateCharge(id, body);
  }

  @Permission('pkg.activation.close')
  @Idempotent()
  @Post('activations/:id/close')
  async close(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(closeActivationSchema)) body: CloseActivationRequest,
  ): Promise<PackageActivationView> {
    return this.packages.closeActivation(id, body);
  }

  @Permission('pkg.variance.request')
  @Idempotent()
  @Post('activations/:id/variances')
  async requestVariance(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(requestVarianceSchema)) body: RequestVarianceRequest,
  ): Promise<VarianceRequestView> {
    return this.packages.requestVariance(id, body);
  }

  /**
   * Reading the overrun list is not the same act as raising one, and gating it
   * on `pkg.variance.request` locked finance — who hold `approve` and, by the
   * segregation rule, deliberately not `request` — out of the queue built for
   * them. `pkg.activation.read` is what both halves hold.
   */
  @Permission('pkg.activation.read')
  @Get('variances')
  async listVariances(
    @Query('activationId') activationId: string | undefined,
  ): Promise<Page<VarianceRequestView>> {
    return this.packages.listVariances(activationId ?? 'all');
  }

  /** A different key from the request, held by finance. */
  @Permission('pkg.variance.approve')
  @Idempotent()
  @Post('variances/:id/decide')
  async decideVariance(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(decideVarianceSchema)) body: DecideVarianceRequest,
  ): Promise<VarianceRequestView> {
    return this.packages.decideVariance(id, body);
  }
}
