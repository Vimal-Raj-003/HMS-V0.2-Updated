import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  acknowledgeAlertSchema,
  correctVitalsSchema,
  createVitalsSchema,
  idSchema,
  listVitalsQuerySchema,
  recheckRequestSchema,
  referenceRangeQuerySchema,
  type AcknowledgeAlertRequest,
  type CorrectVitalsRequest,
  type CreateVitalsRequest,
  type ListVitalsQuery,
  type RecheckRequest,
  type ReferenceRangeQuery,
} from './vitals.schemas.js';
import { VitalsService, type VitalsAlertView, type VitalsDetail, type VitalsRow } from './vitals.service.js';

/**
 * `/api/v1/vitals` — OP-007 §6.
 *
 * Every route carries a permission key from the catalogue in
 * `packages/contracts`, and `assertRegisteredPermission` runs when this module
 * loads, so an invented key stops the process at boot rather than denying
 * everyone at 2 a.m.
 *
 * The permission split is the clinically meaningful one from OP-007 §12 and is
 * worth stating: `vitals.record.create` is a **nurse's** key and appears on no
 * prescribing route; `vitals.alert.acknowledge` and `vitals.recheck.request`
 * are the **doctor's** half of the same loop. Neither is licence-gated — the
 * catalogue marks the alert keys `clinicalSafetyExempt`, because a hospital
 * with an unpaid invoice still gets its critical-value alert (EN-040 §5).
 *
 * **Route order matters.** `records/reference-ranges` would be swallowed by
 * `records/:id` if it were declared after it, so the literal segments come
 * first — the same rule `PatientController` follows.
 */
@Controller('vitals')
export class VitalsController {
  constructor(@Inject(VitalsService) private readonly vitals: VitalsService) {}

  /** OP-007 §6 `GET /vitals/reference-ranges` — the configured bands, read-only. */
  @Permission('vitals.configure')
  @Get('reference-ranges')
  async referenceRanges(
    @Query(new ZodBody(referenceRangeQuerySchema)) query: ReferenceRangeQuery,
  ): Promise<Page<Record<string, unknown>>> {
    return this.vitals.referenceRanges(query);
  }

  /** OP-007 §6 `GET /vitals/records` — history and trends. */
  @Permission('vitals.record.read')
  @Get('records')
  async list(@Query(new ZodBody(listVitalsQuerySchema)) query: ListVitalsQuery): Promise<Page<VitalsRow>> {
    return this.vitals.list(query);
  }

  /**
   * OP-007 §6 `POST /vitals/records` — save the observation set.
   *
   * Idempotent: a tablet that loses its network mid-save and retries must not
   * produce two readings a doctor then has to reconcile.
   */
  @Permission('vitals.record.create')
  @Idempotent()
  @Post('records')
  async record(@Body(new ZodBody(createVitalsSchema)) body: CreateVitalsRequest): Promise<VitalsDetail> {
    return this.vitals.record(body);
  }

  /** OP-007 §6 `POST /vitals/recheck-requests` — the doctor asks for a repeat. */
  @Permission('vitals.recheck.request')
  @Idempotent()
  @Post('recheck-requests')
  async requestRecheck(
    @Body(new ZodBody(recheckRequestSchema)) body: RecheckRequest,
  ): Promise<{ readonly requested: true }> {
    return this.vitals.requestRecheck(body);
  }

  /** OP-007 §6 `GET /vitals/records/{id}`. */
  @Permission('vitals.record.read')
  @Get('records/:id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<VitalsDetail> {
    return this.vitals.get(id);
  }

  /**
   * OP-007 §6 `PATCH /vitals/records/{id}` — a correction.
   *
   * The verb is the spec's; the effect is an insert. Readings are never edited
   * (§5), so this writes a new version pointing at the old one with a mandatory
   * reason and leaves the original readable.
   */
  @Permission('vitals.record.correct')
  @Patch('records/:id')
  async correct(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(correctVitalsSchema)) body: CorrectVitalsRequest,
  ): Promise<VitalsDetail> {
    return this.vitals.correct(id, body);
  }

  /** OP-007 §6 `POST /vitals/records/{id}/alerts/{alert}/ack`. */
  @Permission('vitals.alert.acknowledge')
  @Idempotent()
  @Post('records/:id/alerts/:alertId/ack')
  async acknowledgeAlert(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Param('alertId', new ZodBody(idSchema)) alertId: string,
    @Body(new ZodBody(acknowledgeAlertSchema)) body: AcknowledgeAlertRequest,
  ): Promise<VitalsAlertView> {
    return this.vitals.acknowledgeAlert(id, alertId, body);
  }
}
