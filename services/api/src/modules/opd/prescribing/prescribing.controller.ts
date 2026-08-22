import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { DrugsService } from './drugs.service.js';
import { PrescriptionService } from './prescription.service.js';
import {
  amendPrescriptionSchema,
  cancelPrescriptionSchema,
  cosignPrescriptionSchema,
  createPrescriptionSchema,
  drugSearchSchema,
  idSchema,
  signPrescriptionSchema,
  type AmendPrescriptionRequest,
  type CancelPrescriptionRequest,
  type CosignPrescriptionRequest,
  type CreatePrescriptionRequest,
  type DrugSearchQuery,
  type SignPrescriptionRequest,
} from './prescribing.schemas.js';
import type { DrugSearchResult, EvaluationView, PrescriptionView } from './prescribing.types.js';

/**
 * `/api/v1/prescriptions` and `/api/v1/drugs` — OP-002 §6.
 *
 * Every write is `@Idempotent()`. `CLAUDE.md` §3 requires it on "order-creating
 * endpoints", and a prescription is the order that matters most: a tablet
 * retried over a flaky ward Wi-Fi must not become two prescriptions, and a
 * pharmacist must not see the same narcotic script twice.
 *
 * **On the read key.** `GET /prescriptions/{id}` is gated on `rx.print` rather
 * than on `rx.create`. The catalogue has no separate read key, and `rx.print` is
 * the one that means "may see this prescription" — it is held by nursing
 * precisely so a patient is never sent away without their Rx. Gating the read on
 * a *write* key would deny the people whose job is to hand it over.
 */
@Controller()
export class PrescribingController {
  constructor(
    @Inject(PrescriptionService) private readonly prescriptions: PrescriptionService,
    @Inject(DrugsService) private readonly drugs: DrugsService,
  ) {}

  /** OP-002 §6 `GET /drugs/search` — generic or brand, with the safety flags. */
  @Permission('rx.drug.search')
  @Get('drugs/search')
  async searchDrugs(
    @Query(new ZodBody(drugSearchSchema)) query: DrugSearchQuery,
  ): Promise<{ readonly items: readonly DrugSearchResult[] }> {
    return this.drugs.search(query);
  }

  /**
   * OP-002 §6 `POST /prescriptions` — create the draft.
   *
   * Refuses with 422 `clinical-hard-stop` when a floor rule fires and no
   * countersignature clears it, and with 422 `business-rule-violated` when a
   * soft stop arrived without a coded reason. Both refusals happen *after* the
   * alert rows are committed, so the evidence outlives the refusal.
   */
  @Permission('rx.create')
  @Idempotent()
  @Post('prescriptions')
  async create(
    @Body(new ZodBody(createPrescriptionSchema)) body: CreatePrescriptionRequest,
  ): Promise<PrescriptionView> {
    return this.prescriptions.create(body);
  }

  /** OP-002 §6 `GET /prescriptions/{id}`. */
  @Permission('rx.print')
  @Get('prescriptions/:id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<PrescriptionView> {
    return this.prescriptions.get(id);
  }

  /**
   * OP-002 §6 `POST /prescriptions/{id}/cdss-check` — re-run the rules over the
   * stored draft without changing it.
   */
  @Permission('rx.create')
  @Post('prescriptions/:id/cdss-check')
  async check(@Param('id', new ZodBody(idSchema)) id: string): Promise<EvaluationView> {
    return this.prescriptions.recheck(id);
  }

  /** OP-002 §6 `POST /prescriptions/{id}/sign` — release it to the pharmacy. */
  @Permission('rx.sign')
  @Idempotent()
  @Post('prescriptions/:id/sign')
  async sign(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(signPrescriptionSchema)) body: SignPrescriptionRequest,
  ): Promise<PrescriptionView> {
    return this.prescriptions.sign(id, body);
  }

  /** OP-002 §14 AC-5 `POST /prescriptions/{id}/cosign` — the consultant's signature. */
  @Permission('rx.cosign')
  @Idempotent()
  @Post('prescriptions/:id/cosign')
  async cosign(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cosignPrescriptionSchema)) body: CosignPrescriptionRequest,
  ): Promise<PrescriptionView> {
    return this.prescriptions.cosign(id, body);
  }

  /**
   * OP-002 §6 `POST /prescriptions/{id}/amend` — a new revision, never an edit.
   *
   * `rx.amend` is `requiresReason` in the catalogue, so the policy guard demands
   * an `x-reason` header before the handler runs; the body's `reason` is the one
   * printed on the amended PDF and stored on the row.
   */
  @Permission('rx.amend')
  @Idempotent()
  @Post('prescriptions/:id/amend')
  async amend(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(amendPrescriptionSchema)) body: AmendPrescriptionRequest,
  ): Promise<PrescriptionView> {
    return this.prescriptions.amend(id, body);
  }

  /** OP-002 §6 `POST /prescriptions/{id}/cancel`. */
  @Permission('rx.cancel')
  @Idempotent()
  @Post('prescriptions/:id/cancel')
  async cancel(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelPrescriptionSchema)) body: CancelPrescriptionRequest,
  ): Promise<PrescriptionView> {
    return this.prescriptions.cancel(id, body);
  }
}
