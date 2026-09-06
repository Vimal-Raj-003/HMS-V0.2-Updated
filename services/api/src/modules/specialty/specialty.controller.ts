import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import {
  attachSchema,
  cancelOrderSchema,
  consoleQuerySchema,
  deviceOrderQuerySchema,
  deviceTypeSchema,
  moveStageSchema,
  orderDeviceResultSchema,
  performSchema,
  registerConsoleSchema,
  updateConsoleSchema,
  worklistQuerySchema,
  type AttachRequest,
  type CancelOrderRequest,
  type ConsoleQuery,
  type DeviceOrderQuery,
  type DeviceTypeRequest,
  type MoveStageRequest,
  type OrderDeviceResultRequest,
  type PerformRequest,
  type RegisterConsoleRequest,
  type UpdateConsoleRequest,
  type WorklistQuery,
} from './specialty.schemas.js';
import { SpecialtyService } from './specialty.service.js';
import type {
  ConsoleDetail,
  ConsoleRow,
  DeviceOrderRow,
  DeviceTypeRow,
  StageRow,
  WorklistRow,
} from './specialty.types.js';

/**
 * `/api/v1/specialty/*` — OP-025 §0, the framework thirty consoles share.
 *
 * ── One upload path, deliberately ───────────────────────────────────────────
 *
 * `phase-08`: "A console that ships its own worklist, its own upload path or
 * its own print pipeline is a defect, not a feature." Ophthalmology's OCT,
 * cardiology's ECG and ENT's audiogram all arrive through
 * `POST /specialty/device-orders/:id/attach` and all stay unreviewed until
 * somebody says otherwise.
 *
 * ── `review` takes no body ──────────────────────────────────────────────────
 *
 * The reviewer is the caller and the moment is now. A `reviewedBy` in the
 * request would let the technician who uploaded a scan record the doctor as
 * having read it, and the rail of unlooked-at results would be permanently
 * empty — which is the same as not having one.
 */
@Controller()
export class SpecialtyController {
  constructor(@Inject(SpecialtyService) private readonly specialty: SpecialtyService) {}

  // ── The registry ───────────────────────────────────────────────────────────

  @Permission('console.registry.read')
  @Get('specialty/consoles')
  async listConsoles(
    @Query(new ZodBody(consoleQuerySchema)) query: ConsoleQuery,
  ): Promise<readonly ConsoleRow[]> {
    return this.specialty.listConsoles(query);
  }

  @Permission('console.registry.read')
  @Get('specialty/consoles/:code')
  async consoleDetail(@Param('code') code: string): Promise<ConsoleDetail> {
    return this.specialty.consoleDetail(code);
  }

  @Permission('console.registry.configure')
  @Idempotent()
  @Post('specialty/consoles')
  async registerConsole(
    @Body(new ZodBody(registerConsoleSchema)) body: RegisterConsoleRequest,
  ): Promise<ConsoleRow> {
    return this.specialty.registerConsole(body);
  }

  @Permission('console.registry.configure')
  @Patch('specialty/consoles/:id')
  async updateConsole(
    @Param('id') id: string,
    @Body(new ZodBody(updateConsoleSchema)) body: UpdateConsoleRequest,
  ): Promise<ConsoleRow> {
    return this.specialty.updateConsole(id, body);
  }

  @Permission('console.device_type.configure')
  @Idempotent()
  @Post('specialty/device-types')
  async declareDeviceType(
    @Body(new ZodBody(deviceTypeSchema)) body: DeviceTypeRequest,
  ): Promise<DeviceTypeRow> {
    return this.specialty.declareDeviceType(body);
  }

  // ── The shared device path ─────────────────────────────────────────────────

  @Permission('device.result.order')
  @Idempotent()
  @Post('specialty/device-orders')
  async order(
    @Body(new ZodBody(orderDeviceResultSchema)) body: OrderDeviceResultRequest,
  ): Promise<DeviceOrderRow> {
    return this.specialty.orderDeviceResult(body);
  }

  @Permission('device.result.order')
  @Get('specialty/device-orders')
  async listOrders(
    @Query(new ZodBody(deviceOrderQuerySchema)) query: DeviceOrderQuery,
  ): Promise<readonly DeviceOrderRow[]> {
    return this.specialty.listDeviceOrders(query);
  }

  @Permission('device.result.attach')
  @Patch('specialty/device-orders/:id/perform')
  async perform(
    @Param('id') id: string,
    @Body(new ZodBody(performSchema)) body: PerformRequest,
  ): Promise<DeviceOrderRow> {
    return this.specialty.performDeviceResult(id, body);
  }

  @Permission('device.result.attach')
  @Patch('specialty/device-orders/:id/attach')
  async attach(
    @Param('id') id: string,
    @Body(new ZodBody(attachSchema)) body: AttachRequest,
  ): Promise<DeviceOrderRow> {
    return this.specialty.attachDeviceResult(id, body);
  }

  @Permission('device.result.review')
  @Patch('specialty/device-orders/:id/review')
  async review(@Param('id') id: string): Promise<DeviceOrderRow> {
    return this.specialty.reviewDeviceResult(id);
  }

  @Permission('device.result.cancel')
  @Post('specialty/device-orders/:id/cancel')
  async cancel(
    @Param('id') id: string,
    @Body(new ZodBody(cancelOrderSchema)) body: CancelOrderRequest,
  ): Promise<DeviceOrderRow> {
    return this.specialty.cancelDeviceOrder(id, body);
  }

  // ── Stages and the worklist ────────────────────────────────────────────────

  @Permission('console.worklist.read')
  @Get('specialty/worklist')
  async worklist(
    @Query(new ZodBody(worklistQuerySchema)) query: WorklistQuery,
  ): Promise<readonly WorklistRow[]> {
    return this.specialty.worklist(query);
  }

  @Permission('console.stage.record')
  @Post('specialty/stages')
  async moveStage(@Body(new ZodBody(moveStageSchema)) body: MoveStageRequest): Promise<StageRow> {
    return this.specialty.moveStage(body);
  }

  @Permission('console.worklist.read')
  @Get('specialty/stages/:encounterId')
  async stages(@Param('encounterId') encounterId: string): Promise<readonly StageRow[]> {
    return this.specialty.stagesFor(encounterId);
  }
}
