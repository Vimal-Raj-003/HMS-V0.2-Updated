import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  createScheduleExceptionSchema,
  doctorSlotsQuerySchema,
  publishScheduleSchema,
  putScheduleTemplatesSchema,
  type CreateScheduleExceptionRequest,
  type DoctorSlotsQuery,
  type PublishScheduleRequest,
  type PutScheduleTemplatesRequest,
} from './dto/scheduling.dto.js';
import {
  SchedulesService,
  type PublishResult,
  type ScheduleExceptionRow,
  type ScheduleTemplateRow,
  type SlotView,
} from './schedules.service.js';

const idSchema = z.string().uuid();

/**
 * `/api/v1/doctors/{id}/…` — OP-001 §6 slot and schedule routes.
 *
 * `{id}` is the practitioner's **`record_key`** from `mdm.mdm_practitioners`,
 * not the row id: master data is effective-dated and versioned, so the row id
 * changes when a doctor's profile is amended while the identity the schedule
 * hangs off must not.
 *
 * The permission split is OP-001 §12's and is the point of this controller:
 * `schedule.configure` edits the draft grid — a doctor or HOD may hold it for
 * their own profile — and `schedule.publish` is what makes a version bookable,
 * which OP-001 §12 gives to the Branch Admin. They are never merged, because a
 * doctor who could publish their own grid could open a clinic nobody staffed.
 */
@Controller('doctors')
export class DoctorSchedulesController {
  constructor(@Inject(SchedulesService) private readonly schedules: SchedulesService) {}

  @Permission('appointment.slot.read')
  @Get(':id/slots')
  async slots(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Query(new ZodBody(doctorSlotsQuerySchema)) query: DoctorSlotsQuery,
  ): Promise<{ items: readonly SlotView[] }> {
    return this.schedules.slotsFor(id, query);
  }

  @Permission('schedule.configure')
  @Get(':id/schedule-templates')
  async templates(
    @Param('id', new ZodBody(idSchema)) id: string,
  ): Promise<{ items: readonly ScheduleTemplateRow[] }> {
    return this.schedules.templatesFor(id);
  }

  @Permission('schedule.configure')
  @Put(':id/schedule-templates')
  async putTemplates(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(putScheduleTemplatesSchema)) body: PutScheduleTemplatesRequest,
  ): Promise<{ items: readonly ScheduleTemplateRow[] }> {
    return this.schedules.putTemplates(id, body);
  }

  @Permission('schedule.configure')
  @Get(':id/schedule-exceptions')
  async exceptions(
    @Param('id', new ZodBody(idSchema)) id: string,
  ): Promise<{ items: readonly ScheduleExceptionRow[] }> {
    return this.schedules.exceptionsFor(id);
  }

  /**
   * OP-001 §6 lists this as `PUT /schedule-exceptions`. It is a `POST` because
   * leave and holidays accumulate: a PUT that replaced the set would delete last
   * month's approved leave every time somebody filed a new day off, and those
   * rows explain why a clinic was closed.
   */
  @Permission('schedule.configure')
  @Post(':id/schedule-exceptions')
  async createException(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(createScheduleExceptionSchema)) body: CreateScheduleExceptionRequest,
  ): Promise<ScheduleExceptionRow> {
    return this.schedules.createException(id, body);
  }

  @Permission('schedule.publish')
  @Post(':id/schedule/publish')
  async publish(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(publishScheduleSchema)) body: PublishScheduleRequest,
  ): Promise<PublishResult> {
    return this.schedules.publish(id, body);
  }
}
