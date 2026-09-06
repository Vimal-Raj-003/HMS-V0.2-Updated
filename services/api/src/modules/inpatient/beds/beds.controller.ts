import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { BedsService } from './beds.service.js';
import {
  admissionQuerySchema,
  admissionRequestSchema,
  admitSchema,
  bedClassSchema,
  bedSchema,
  blockSchema,
  boardQuerySchema,
  buildingSchema,
  cleaningActionSchema,
  cleaningQuerySchema,
  dischargeSchema,
  holdSchema,
  releaseHoldSchema,
  roomSchema,
  transferSchema,
  wardSchema,
  type AdmissionQuery,
  type AdmissionRequestBody,
  type AdmitRequest,
  type BedClassRequest,
  type BedRequest,
  type BlockRequest,
  type BoardQuery,
  type BuildingRequest,
  type CleaningActionRequest,
  type CleaningQuery,
  type DischargeRequest,
  type HoldRequest,
  type ReleaseHoldRequest,
  type RoomRequest,
  type TransferRequest,
  type WardRequest,
} from './beds.schemas.js';
import type {
  AdmissionDetailView,
  AdmissionView,
  BedBoardRow,
  CensusRow,
  CleaningTaskView,
} from './beds.types.js';

/**
 * `/api/v1/ip/*` — Phase 7A.
 *
 * ── Admitting names a class, not a bed ──────────────────────────────────────
 *
 * `POST /admissions/:id/admit` takes the requirements — the class, isolation, a
 * ventilator point — and the server picks a bed under `FOR UPDATE SKIP LOCKED`.
 * A client naming a bed read the board a moment ago and is about to lose a race
 * it cannot see; naming one is still possible as a *preference*, tried first.
 *
 * ── The census has no endpoint that writes it ───────────────────────────────
 *
 * `GET /census` is a query over the occupancy table. There is no counter to
 * increment and therefore no route that could increment it wrongly.
 */
@Controller('ip')
export class BedsController {
  constructor(@Inject(BedsService) private readonly beds: BedsService) {}

  // ── The board ──────────────────────────────────────────────────────────────

  @Permission('bed.board.read')
  @Get('board')
  async board(@Query(new ZodBody(boardQuerySchema)) query: BoardQuery): Promise<Page<BedBoardRow>> {
    return this.beds.board(query);
  }

  @Permission('census.read')
  @Get('census')
  async census(): Promise<readonly CensusRow[]> {
    return this.beds.census();
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  @Permission('bed.config.manage')
  @Idempotent()
  @Post('buildings')
  async createBuilding(
    @Body(new ZodBody(buildingSchema)) body: BuildingRequest,
  ): Promise<{ readonly id: string }> {
    return this.beds.createBuilding(body);
  }

  @Permission('bed.config.manage')
  @Idempotent()
  @Post('wards')
  async createWard(@Body(new ZodBody(wardSchema)) body: WardRequest): Promise<{ readonly id: string }> {
    return this.beds.createWard(body);
  }

  @Permission('bed.config.manage')
  @Idempotent()
  @Post('bed-classes')
  async createBedClass(
    @Body(new ZodBody(bedClassSchema)) body: BedClassRequest,
  ): Promise<{ readonly id: string }> {
    return this.beds.createBedClass(body);
  }

  @Permission('bed.config.manage')
  @Idempotent()
  @Post('rooms')
  async createRoom(@Body(new ZodBody(roomSchema)) body: RoomRequest): Promise<{ readonly id: string }> {
    return this.beds.createRoom(body);
  }

  @Permission('bed.config.manage')
  @Idempotent()
  @Post('beds')
  async createBed(@Body(new ZodBody(bedSchema)) body: BedRequest): Promise<{ readonly id: string }> {
    return this.beds.createBed(body);
  }

  // ── Admission ──────────────────────────────────────────────────────────────

  @Permission('admission.list')
  @Get('admissions')
  async listAdmissions(
    @Query(new ZodBody(admissionQuerySchema)) query: AdmissionQuery,
  ): Promise<Page<AdmissionView>> {
    return this.beds.listAdmissions(query);
  }

  @Permission('admission.request')
  @Idempotent()
  @Post('admissions')
  async requestAdmission(
    @Body(new ZodBody(admissionRequestSchema)) body: AdmissionRequestBody,
  ): Promise<AdmissionDetailView> {
    return this.beds.requestAdmission(body);
  }

  @Permission('admission.read')
  @Get('admissions/:id')
  async getAdmission(@Param('id') id: string): Promise<AdmissionDetailView> {
    return this.beds.getAdmission(id);
  }

  @Permission('admission.admit')
  @Idempotent()
  @Post('admissions/:id/admit')
  async admit(
    @Param('id') id: string,
    @Body(new ZodBody(admitSchema)) body: AdmitRequest,
  ): Promise<AdmissionDetailView> {
    return this.beds.admit(id, body);
  }

  @Permission('transfer.execute')
  @Post('admissions/:id/transfers')
  async transfer(
    @Param('id') id: string,
    @Body(new ZodBody(transferSchema)) body: TransferRequest,
  ): Promise<AdmissionDetailView> {
    return this.beds.transfer(id, body);
  }

  @Permission('admission.update')
  @Patch('admissions/:id/discharge')
  async discharge(
    @Param('id') id: string,
    @Body(new ZodBody(dischargeSchema)) body: DischargeRequest,
  ): Promise<AdmissionDetailView> {
    return this.beds.discharge(id, body);
  }

  // ── Holds and blocks ───────────────────────────────────────────────────────

  @Permission('bed.hold.create')
  @Idempotent()
  @Post('holds')
  async hold(
    @Body(new ZodBody(holdSchema)) body: HoldRequest,
  ): Promise<{ readonly id: string; readonly expiresAt: string }> {
    return this.beds.hold(body);
  }

  @Permission('bed.hold.release')
  @Patch('holds/:id/release')
  async releaseHold(
    @Param('id') id: string,
    @Body(new ZodBody(releaseHoldSchema)) body: ReleaseHoldRequest,
  ): Promise<{ readonly released: boolean }> {
    return this.beds.releaseHold(id, body);
  }

  @Permission('bed.block')
  @Patch('beds/:id/block')
  async block(
    @Param('id') id: string,
    @Body(new ZodBody(blockSchema)) body: BlockRequest,
  ): Promise<{ readonly status: string }> {
    return this.beds.block(id, body);
  }

  // ── Housekeeping ───────────────────────────────────────────────────────────

  @Permission('housekeeping.task.read')
  @Get('cleaning')
  async cleaningWorklist(
    @Query(new ZodBody(cleaningQuerySchema)) query: CleaningQuery,
  ): Promise<Page<CleaningTaskView>> {
    return this.beds.cleaningWorklist(query);
  }

  @Permission('housekeeping.task.accept')
  @Patch('cleaning/:id')
  async cleaningAction(
    @Param('id') id: string,
    @Body(new ZodBody(cleaningActionSchema)) body: CleaningActionRequest,
  ): Promise<CleaningTaskView> {
    return this.beds.cleaningAction(id, body);
  }

  @Permission('housekeeping.override')
  @Patch('beds/:id/skip-cleaning')
  async overrideCleaning(@Param('id') id: string): Promise<{ readonly status: string }> {
    return this.beds.overrideCleaning(id);
  }
}
