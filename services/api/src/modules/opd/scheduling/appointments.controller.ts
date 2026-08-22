import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { z } from 'zod';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  AppointmentsService,
  type AppointmentDetail,
  type AppointmentListItem,
  type CheckInResult,
} from './appointments.service.js';
import {
  bookAppointmentSchema,
  cancelAppointmentSchema,
  checkInSchema,
  confirmAppointmentSchema,
  listAppointmentsQuerySchema,
  rescheduleAppointmentSchema,
  type BookAppointmentRequest,
  type CancelAppointmentRequest,
  type CheckInRequest,
  type ConfirmAppointmentRequest,
  type ListAppointmentsQuery,
  type RescheduleAppointmentRequest,
} from './dto/scheduling.dto.js';

const idSchema = z.string().uuid();

/**
 * `/api/v1/appointments` — OP-001 §6.
 *
 * The permission on each route is the one OP-001 §12 names, and every key is
 * checked against the catalogue in `packages/contracts` when this file is
 * loaded, so an invented key stops the process at boot rather than denying every
 * receptionist at 08:00.
 *
 * Two of them are worth a note:
 *
 *  - **cancel is `appointment.cancel`, not `appointment.update`.** The catalogue
 *    marks it `requiresReason`, so the policy engine refuses a cancellation that
 *    arrives without `x-reason` *before* the handler runs — which is what makes
 *    "the reason drives the refund policy" enforceable rather than aspirational.
 *  - **check-in is `visit.create`, not an appointment key.** Checking in creates
 *    an OP visit and a queue token; the authority it needs is the authority to
 *    open a visit, which a call-centre agent who may book appointments does not
 *    have.
 *
 * `Idempotency-Key` is honoured on the two routes that create rows: OP-001 §6
 * marks them `Idem = Y`, and a retried booking that produces a second
 * appointment costs a patient their slot and the hospital a refund.
 */
@Controller('appointments')
export class AppointmentsController {
  constructor(@Inject(AppointmentsService) private readonly appointments: AppointmentsService) {}

  @Permission('appointment.list')
  @Get()
  async list(
    @Query(new ZodBody(listAppointmentsQuerySchema)) query: ListAppointmentsQuery,
  ): Promise<Page<AppointmentListItem>> {
    return this.appointments.list(query);
  }

  @Permission('appointment.list')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<AppointmentDetail> {
    return this.appointments.get(id);
  }

  @Permission('appointment.create')
  @Post()
  async book(
    @Body(new ZodBody(bookAppointmentSchema)) body: BookAppointmentRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<AppointmentDetail> {
    return this.appointments.book(body, idempotencyKey ?? null);
  }

  @Permission('appointment.update')
  @Patch(':id/confirm')
  async confirm(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(confirmAppointmentSchema)) body: ConfirmAppointmentRequest,
  ): Promise<AppointmentDetail> {
    return this.appointments.confirm(id, body);
  }

  @Permission('appointment.update')
  @Patch(':id/reschedule')
  async reschedule(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(rescheduleAppointmentSchema)) body: RescheduleAppointmentRequest,
  ): Promise<AppointmentDetail> {
    return this.appointments.reschedule(id, body);
  }

  @Permission('appointment.cancel')
  @Patch(':id/cancel')
  async cancel(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelAppointmentSchema)) body: CancelAppointmentRequest,
  ): Promise<AppointmentDetail> {
    return this.appointments.cancel(id, body);
  }

  @Permission('visit.create')
  @Post(':id/check-in')
  async checkIn(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(checkInSchema)) body: CheckInRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CheckInResult> {
    return this.appointments.checkIn(id, body, idempotencyKey ?? null);
  }
}
