import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { LifespanService } from './lifespan.service.js';
import {
  geriAssessmentSchema,
  geriQuerySchema,
  growthQuerySchema,
  growthSchema,
  medicationReviewSchema,
  nicuAdmissionSchema,
  nicuFluidSchema,
  nicuQuerySchema,
  paedDoseSchema,
  type GeriAssessmentRequest,
  type GeriQuery,
  type GrowthQuery,
  type GrowthRequest,
  type MedicationReviewRequest,
  type NicuAdmissionRequest,
  type NicuFluidRequest,
  type NicuQuery,
  type PaedDoseRequest,
} from './lifespan.schemas.js';
import type {
  GeriAssessmentRow,
  GrowthRow,
  MedicationReviewRow,
  NicuAdmissionRow,
  NicuFluidRow,
  PaedDoseRow,
} from './lifespan.types.js';

/**
 * `/api/v1/lifespan/*` — OP-033, IP-015 and OP-034.
 *
 * ── No route raises a paediatric dose past the adult ceiling ───────────────
 *
 * Because there is no clinical circumstance. A child who needs more than an
 * adult dose needs a different drug or a different diagnosis, and a route for
 * it would turn the commonest paediatric overdose into a permitted one.
 *
 * ── And no route takes a weight in kilograms ───────────────────────────────
 *
 * Everything about a child here is in grams. A newborn's weight entered in
 * kilograms is a dose out by a factor of a thousand, and a range check does not
 * catch it — 3 passes anything written for kilograms. The way to prevent it is
 * to have nowhere to put the number.
 */
@Controller()
export class LifespanController {
  constructor(@Inject(LifespanService) private readonly lifespan: LifespanService) {}

  // ── Growth ────────────────────────────────────────────────────────────────

  @Permission('paed.growth.record')
  @Idempotent()
  @Post('lifespan/growth')
  async recordGrowth(@Body(new ZodBody(growthSchema)) body: GrowthRequest): Promise<GrowthRow> {
    return this.lifespan.recordGrowth(body);
  }

  @Permission('lifespan.read')
  @Get('lifespan/growth')
  async listGrowth(@Query(new ZodBody(growthQuerySchema)) query: GrowthQuery): Promise<readonly GrowthRow[]> {
    return this.lifespan.listGrowth(query);
  }

  // ── The dose ──────────────────────────────────────────────────────────────

  /** Milligrams per kilogram in, the adult ceiling applied, the arithmetic out. */
  @Permission('paed.dose.calculate')
  @Idempotent()
  @Post('lifespan/paed-doses')
  async calculateDose(@Body(new ZodBody(paedDoseSchema)) body: PaedDoseRequest): Promise<PaedDoseRow> {
    return this.lifespan.calculateDose(body);
  }

  // ── The neonatal unit ─────────────────────────────────────────────────────

  @Permission('nicu.admission.manage')
  @Idempotent()
  @Post('lifespan/nicu-admissions')
  async admitNicu(
    @Body(new ZodBody(nicuAdmissionSchema)) body: NicuAdmissionRequest,
  ): Promise<NicuAdmissionRow> {
    return this.lifespan.admitNicu(body);
  }

  @Permission('lifespan.read')
  @Get('lifespan/nicu-admissions')
  async listNicu(
    @Query(new ZodBody(nicuQuerySchema)) query: NicuQuery,
  ): Promise<readonly NicuAdmissionRow[]> {
    return this.lifespan.listNicu(query);
  }

  @Permission('nicu.fluids.prescribe')
  @Post('lifespan/nicu-admissions/:id/fluids')
  async prescribeFluids(
    @Param('id') id: string,
    @Body(new ZodBody(nicuFluidSchema)) body: NicuFluidRequest,
  ): Promise<NicuFluidRow> {
    return this.lifespan.prescribeFluids(id, body);
  }

  @Permission('lifespan.read')
  @Get('lifespan/nicu-admissions/:id/fluids')
  async listFluids(@Param('id') id: string): Promise<readonly NicuFluidRow[]> {
    return this.lifespan.listFluids(id);
  }

  // ── The other end ─────────────────────────────────────────────────────────

  @Permission('geri.assessment.record')
  @Idempotent()
  @Post('lifespan/geri-assessments')
  async recordAssessment(
    @Body(new ZodBody(geriAssessmentSchema)) body: GeriAssessmentRequest,
  ): Promise<GeriAssessmentRow> {
    return this.lifespan.recordAssessment(body);
  }

  /** The burden is summed and the Beers criteria matched. Neither is remembered. */
  @Permission('geri.medication.review')
  @Idempotent()
  @Post('lifespan/medication-reviews')
  async reviewMedications(
    @Body(new ZodBody(medicationReviewSchema)) body: MedicationReviewRequest,
  ): Promise<MedicationReviewRow> {
    return this.lifespan.reviewMedications(body);
  }

  @Permission('lifespan.read')
  @Get('lifespan/medication-reviews')
  async listReviews(
    @Query(new ZodBody(geriQuerySchema)) query: GeriQuery,
  ): Promise<readonly MedicationReviewRow[]> {
    return this.lifespan.listReviews(query);
  }
}
