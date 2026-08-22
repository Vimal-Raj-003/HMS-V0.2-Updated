import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  idSchema,
  recordAllergySchema,
  timelineQuerySchema,
  type RecordAllergyRequest,
  type TimelineQuery,
} from './encounter.schemas.js';
import {
  TimelineService,
  type AllergyItem,
  type MedicationItem,
  type ProblemItem,
  type TimelineItem,
} from './timeline.service.js';

/**
 * `/api/v1/patients/{id}/…` — the clinical half of the patient record
 * (OP-002 §6).
 *
 * This controller shares the `patients` prefix with OP-001's
 * `PatientController` and adds no route that could collide with it: Fastify's
 * radix router matches on full paths, and every path here carries a second
 * segment OP-001 does not own.
 *
 * Every route on it goes through `CareTeamService`, so a clinician outside the
 * care team is asked for a reason and the access is recorded as break-glass
 * (§14 AC-10) rather than silently allowed or flatly refused.
 */
@Controller('patients')
export class PatientClinicalController {
  constructor(@Inject(TimelineService) private readonly timeline: TimelineService) {}

  /** OP-002 §6 `GET /patients/{id}/timeline`. Exit gate 6: 5 years < 1 s p95. */
  @Permission('patient.record.read')
  @Get(':id/timeline')
  async items(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Query(new ZodBody(timelineQuerySchema)) query: TimelineQuery,
  ): Promise<Page<TimelineItem>> {
    return this.timeline.timeline(id, query);
  }

  @Permission('patient.record.read')
  @Get(':id/problems')
  async problems(@Param('id', new ZodBody(idSchema)) id: string): Promise<readonly ProblemItem[]> {
    return this.timeline.problems(id);
  }

  @Permission('patient.record.read')
  @Get(':id/medications')
  async medications(@Param('id', new ZodBody(idSchema)) id: string): Promise<readonly MedicationItem[]> {
    return this.timeline.medications(id);
  }

  @Permission('patient.record.read')
  @Get(':id/allergies')
  async allergies(@Param('id', new ZodBody(idSchema)) id: string): Promise<readonly AllergyItem[]> {
    return this.timeline.allergies(id);
  }

  /**
   * OP-002 §6 `POST /patients/{id}/allergies`.
   *
   * `opd.allergy.update` is marked `clinicalSafetyExempt` in the catalogue: the
   * allergy list is what the prescribing hard stop evaluates against, so a
   * licence state may never stand between a clinician and recording one
   * (EN-040 §5).
   */
  @Permission('opd.allergy.update')
  @Idempotent()
  @Post(':id/allergies')
  async recordAllergy(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(recordAllergySchema)) body: RecordAllergyRequest,
  ): Promise<AllergyItem> {
    return this.timeline.recordAllergy(id, body);
  }
}
