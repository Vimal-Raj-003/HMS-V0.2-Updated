import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import { ProceduresService } from './procedures.service.js';
import {
  administerSchema,
  bookingSchema,
  cancelOrderSchema,
  checklistSchema,
  completeSchema,
  consentSchema,
  consumableSchema,
  dressingSchema,
  observationOutcomeSchema,
  orderQuerySchema,
  orderSchema,
  overrideSchema,
  performSchema,
  recoverySchema,
  roomSchema,
  taskQuerySchema,
  taskSchema,
  taskStatusSchema,
  timeoutSchema,
  type AdministerRequest,
  type BookingRequest,
  type CancelOrderRequest,
  type ChecklistRequest,
  type CompleteRequest,
  type ConsentRequest,
  type ConsumableRequest,
  type DressingRequest,
  type ObservationOutcomeRequest,
  type OrderQuery,
  type OrderRequest,
  type OverrideRequest,
  type PerformRequest,
  type RecoveryRequest,
  type RoomRequest,
  type TaskQuery,
  type TaskRequest,
  type TaskStatusRequest,
  type TimeoutRequest,
} from './procedures.schemas.js';
import type {
  AdministrationRow,
  BookingRow,
  ChecklistRow,
  DressingRow,
  OrderDetail,
  OrderRow,
  ProcedureRow,
  RecoveryRow,
  RoomRow,
  TaskRow,
  TimeoutRow,
} from './procedures.types.js';

/**
 * `/api/v1/procedures/*` and `/api/v1/opd-nursing/*` — OP-010 and OP-039.
 *
 * ── There is no route that proceeds without consent ─────────────────────────
 *
 * Not a flag on `perform`, not an urgency, not an override endpoint. OP-010 §5
 * gives the checklist an override and gives consent none, and this is what that
 * looks like in a URL space: `POST …/checklist/override` exists and takes a
 * reason; nothing corresponding exists for consent.
 *
 * ── The time-out names the second person ────────────────────────────────────
 *
 * The caller is the first confirmer and the request names the second, because
 * they are standing in the room. The database refuses them when they are the
 * same, which is the only version of this rule that cannot be talked out of.
 */
@Controller()
export class ProceduresController {
  constructor(@Inject(ProceduresService) private readonly procedures: ProceduresService) {}

  // ── Rooms ──────────────────────────────────────────────────────────────────

  @Permission('procedure.room.configure')
  @Idempotent()
  @Post('procedures/rooms')
  async createRoom(@Body(new ZodBody(roomSchema)) body: RoomRequest): Promise<RoomRow> {
    return this.procedures.createRoom(body);
  }

  @Permission('procedure.order.read')
  @Get('procedures/rooms')
  async listRooms(): Promise<readonly RoomRow[]> {
    return this.procedures.listRooms();
  }

  // ── Orders ─────────────────────────────────────────────────────────────────

  @Permission('procedure.order.create')
  @Idempotent()
  @Post('procedures/orders')
  async order(@Body(new ZodBody(orderSchema)) body: OrderRequest): Promise<OrderRow> {
    return this.procedures.order(body);
  }

  @Permission('procedure.order.read')
  @Get('procedures/orders')
  async listOrders(@Query(new ZodBody(orderQuerySchema)) query: OrderQuery): Promise<readonly OrderRow[]> {
    return this.procedures.listOrders(query);
  }

  @Permission('procedure.order.read')
  @Get('procedures/orders/:id')
  async orderDetail(@Param('id') id: string): Promise<OrderDetail> {
    return this.procedures.orderDetail(id);
  }

  @Permission('procedure.order.create')
  @Post('procedures/orders/:id/cancel')
  async cancelOrder(
    @Param('id') id: string,
    @Body(new ZodBody(cancelOrderSchema)) body: CancelOrderRequest,
  ): Promise<OrderRow> {
    return this.procedures.cancelOrder(id, body);
  }

  /** Attaches the consent that was signed. It does not create or waive one. */
  @Permission('procedure.order.create')
  @Patch('procedures/orders/:id/consent')
  async recordConsent(
    @Param('id') id: string,
    @Body(new ZodBody(consentSchema)) body: ConsentRequest,
  ): Promise<OrderRow> {
    return this.procedures.recordConsent(id, body);
  }

  @Permission('procedure.booking.manage')
  @Idempotent()
  @Post('procedures/orders/:id/bookings')
  async book(
    @Param('id') id: string,
    @Body(new ZodBody(bookingSchema)) body: BookingRequest,
  ): Promise<BookingRow> {
    return this.procedures.book(id, body);
  }

  // ── The checklist and the pause ────────────────────────────────────────────

  @Permission('procedure.checklist.record')
  @Post('procedures/orders/:id/checklist')
  async saveChecklist(
    @Param('id') id: string,
    @Body(new ZodBody(checklistSchema)) body: ChecklistRequest,
  ): Promise<ChecklistRow> {
    return this.procedures.saveChecklist(id, body);
  }

  @Permission('procedure.checklist.override')
  @Post('procedures/orders/:id/checklist/override')
  async overrideChecklist(
    @Param('id') id: string,
    @Body(new ZodBody(overrideSchema)) body: OverrideRequest,
  ): Promise<ChecklistRow> {
    return this.procedures.overrideChecklist(id, body);
  }

  @Permission('procedure.timeout.confirm')
  @Idempotent()
  @Post('procedures/orders/:id/timeout')
  async confirmTimeout(
    @Param('id') id: string,
    @Body(new ZodBody(timeoutSchema)) body: TimeoutRequest,
  ): Promise<TimeoutRow> {
    return this.procedures.confirmTimeout(id, body);
  }

  // ── The procedure ──────────────────────────────────────────────────────────

  @Permission('procedure.perform')
  @Idempotent()
  @Post('procedures/orders/:id/start')
  async perform(
    @Param('id') id: string,
    @Body(new ZodBody(performSchema)) body: PerformRequest,
  ): Promise<ProcedureRow> {
    return this.procedures.perform(id, body);
  }

  @Permission('procedure.perform')
  @Patch('procedures/:id/complete')
  async complete(
    @Param('id') id: string,
    @Body(new ZodBody(completeSchema)) body: CompleteRequest,
  ): Promise<ProcedureRow> {
    return this.procedures.complete(id, body);
  }

  @Permission('procedure.sign')
  @Idempotent()
  @Post('procedures/:id/sign')
  async sign(@Param('id') id: string): Promise<ProcedureRow> {
    return this.procedures.sign(id);
  }

  @Permission('procedure.recovery.record')
  @Post('procedures/:id/recovery')
  async recovery(
    @Param('id') id: string,
    @Body(new ZodBody(recoverySchema)) body: RecoveryRequest,
  ): Promise<RecoveryRow> {
    return this.procedures.recovery(id, body);
  }

  @Permission('procedure.consumable.record')
  @Post('procedures/:id/consumables')
  async consumables(
    @Param('id') id: string,
    @Body(new ZodBody(consumableSchema)) body: ConsumableRequest,
  ): Promise<{ readonly count: number }> {
    return this.procedures.recordConsumables(id, body);
  }

  // ── OP-039, the nursing rooms ──────────────────────────────────────────────

  @Permission('opdnursing.task.manage')
  @Idempotent()
  @Post('opd-nursing/tasks')
  async createTask(@Body(new ZodBody(taskSchema)) body: TaskRequest): Promise<TaskRow> {
    return this.procedures.createTask(body);
  }

  @Permission('opdnursing.task.read')
  @Get('opd-nursing/tasks')
  async listTasks(@Query(new ZodBody(taskQuerySchema)) query: TaskQuery): Promise<readonly TaskRow[]> {
    return this.procedures.listTasks(query);
  }

  @Permission('opdnursing.task.manage')
  @Patch('opd-nursing/tasks/:id/status')
  async setTaskStatus(
    @Param('id') id: string,
    @Body(new ZodBody(taskStatusSchema)) body: TaskStatusRequest,
  ): Promise<TaskRow> {
    return this.procedures.setTaskStatus(id, body);
  }

  @Permission('opdnursing.administer')
  @Idempotent()
  @Post('opd-nursing/tasks/:id/administer')
  async administer(
    @Param('id') id: string,
    @Body(new ZodBody(administerSchema)) body: AdministerRequest,
  ): Promise<AdministrationRow> {
    return this.procedures.administer(id, body);
  }

  @Permission('opdnursing.administer')
  @Patch('opd-nursing/administrations/:id/observation')
  async closeObservation(
    @Param('id') id: string,
    @Body(new ZodBody(observationOutcomeSchema)) body: ObservationOutcomeRequest,
  ): Promise<AdministrationRow> {
    return this.procedures.closeObservation(id, body);
  }

  @Permission('opdnursing.dressing.record')
  @Post('opd-nursing/tasks/:id/dressing')
  async recordDressing(
    @Param('id') id: string,
    @Body(new ZodBody(dressingSchema)) body: DressingRequest,
  ): Promise<DressingRow> {
    return this.procedures.recordDressing(id, body);
  }
}
