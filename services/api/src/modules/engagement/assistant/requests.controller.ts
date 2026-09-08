import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { AppointmentRequestService } from './requests.service.js';
import {
  requestConvertSchema,
  requestListQuerySchema,
  requestUpdateSchema,
  type AppointmentRequestRow,
  type RequestConvertBody,
  type RequestListQuery,
  type RequestUpdateBody,
} from './assistant.schemas.js';

/**
 * `/api/v1/appointment-requests/*` — the staff half of PE-009.
 *
 * These exist because a queue nobody can read is worse than a queue that was
 * never collected: the hospital would be gathering names and phone numbers from
 * its own website into a table with no screen and no owner, which is a DPDP
 * problem as much as an operational one.
 *
 * `convert` does not book. It records which enquiry an appointment came from,
 * after somebody booked that appointment through the ordinary route with the
 * ordinary permission — the route that knows about slots, capacity and
 * overbooking. Two booking engines is one too many.
 */
@Controller('appointment-requests')
export class AppointmentRequestController {
  constructor(@Inject(AppointmentRequestService) private readonly svc: AppointmentRequestService) {}

  @Permission('appointment.request.list')
  @Get()
  async list(
    @Query(new ZodBody(requestListQuerySchema)) query: RequestListQuery,
  ): Promise<readonly AppointmentRequestRow[]> {
    return this.svc.list(query);
  }

  @Permission('appointment.request.update')
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body(new ZodBody(requestUpdateSchema)) body: RequestUpdateBody,
  ): Promise<AppointmentRequestRow> {
    return this.svc.update(id, body);
  }

  @Permission('appointment.request.convert')
  @Post(':id/convert')
  async convert(
    @Param('id') id: string,
    @Body(new ZodBody(requestConvertSchema)) body: RequestConvertBody,
  ): Promise<AppointmentRequestRow> {
    return this.svc.convert(id, body);
  }
}
