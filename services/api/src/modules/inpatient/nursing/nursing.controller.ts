import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { NursingService } from './nursing.service.js';
import {
  administerSchema,
  assessmentSchema,
  assignmentSchema,
  deviceRemoveSchema,
  deviceSchema,
  escalationAckSchema,
  escalationQuerySchema,
  escalationResolveSchema,
  fluidSchema,
  haiAdjudicateSchema,
  handoverSchema,
  handoverSignSchema,
  isolationSchema,
  marOrderSchema,
  marQuerySchema,
  noteSchema,
  omitSchema,
  verifySchema,
  wardQuerySchema,
  type AdministerRequest,
  type AssessmentRequest,
  type AssignmentRequest,
  type DeviceRemoveRequest,
  type DeviceRequest,
  type EscalationAckRequest,
  type EscalationQuery,
  type EscalationResolveRequest,
  type FluidRequest,
  type HaiAdjudicateRequest,
  type HandoverRequest,
  type HandoverSignRequest,
  type IsolationRequest,
  type MarOrderRequest,
  type MarQuery,
  type NoteRequest,
  type OmitRequest,
  type VerifyRequest,
  type WardQuery,
} from './nursing.schemas.js';
import type {
  AssessmentRow,
  DeviceRow,
  EscalationRow,
  FluidBalanceView,
  HaiRow,
  HandoverView,
  IsolationRow,
  MarDoseRow,
  WardPatientRow,
} from './nursing.types.js';

/**
 * `/api/v1/nursing/*` — Phase 7B.
 *
 * ── There is no route that marks a dose given without scanning ──────────────
 *
 * `POST /doses/:id/administer` takes the two scan payloads and nothing that
 * could stand in for them. There is no `force`, no `override`, no `skipScan`,
 * and the database refuses a `given` row without both payloads regardless of
 * how it was written. `phase-07`: no feature flag, no configuration value and
 * no emergency mode may bypass the 5 Rights.
 *
 * ── Verifying and administering are different routes and different keys ─────
 *
 * The pharmacist verifies; the nurse gives. Neither role holds the other's key,
 * and a test in `phase7-grants.spec.ts` fails if that ever changes.
 */
@Controller('nursing')
export class NursingController {
  constructor(@Inject(NursingService) private readonly nursing: NursingService) {}

  // ── The ward ───────────────────────────────────────────────────────────────

  @Permission('nursing.ward.read')
  @Get('ward')
  async ward(@Query(new ZodBody(wardQuerySchema)) query: WardQuery): Promise<Page<WardPatientRow>> {
    return this.nursing.wardScreen(query);
  }

  @Permission('nursing.assignment.manage')
  @Idempotent()
  @Post('assignments')
  async assign(
    @Body(new ZodBody(assignmentSchema)) body: AssignmentRequest,
  ): Promise<{ readonly id: string; readonly patients: number }> {
    return this.nursing.assign(body);
  }

  // ── Assessments ────────────────────────────────────────────────────────────

  @Permission('nursing.assessment.record')
  @Post('assessments')
  async assess(@Body(new ZodBody(assessmentSchema)) body: AssessmentRequest): Promise<AssessmentRow> {
    return this.nursing.assess(body);
  }

  @Permission('nursing.ward.read')
  @Get('assessments/:admissionId')
  async assessments(@Param('admissionId') admissionId: string): Promise<readonly AssessmentRow[]> {
    return this.nursing.assessments(admissionId);
  }

  // ── The MAR ────────────────────────────────────────────────────────────────

  @Permission('mar.read')
  @Get('mar')
  async marRound(@Query(new ZodBody(marQuerySchema)) query: MarQuery): Promise<Page<MarDoseRow>> {
    return this.nursing.marRound(query);
  }

  @Permission('mar.order.write')
  @Idempotent()
  @Post('mar/orders')
  async writeOrder(
    @Body(new ZodBody(marOrderSchema)) body: MarOrderRequest,
  ): Promise<{ readonly id: string; readonly doses: number }> {
    return this.nursing.writeOrder(body);
  }

  @Permission('mar.order.verify')
  @Patch('mar/orders/:id/verify')
  async verify(
    @Param('id') id: string,
    @Body(new ZodBody(verifySchema)) body: VerifyRequest,
  ): Promise<{ readonly verified: boolean }> {
    return this.nursing.verifyOrder(id, body);
  }

  @Permission('mar.order.discontinue')
  @Patch('mar/orders/:id/discontinue')
  async discontinue(@Param('id') id: string): Promise<{ readonly discontinued: boolean }> {
    return this.nursing.discontinueOrder(id);
  }

  @Permission('mar.administer')
  @Post('mar/doses/:id/administer')
  async administer(
    @Param('id') id: string,
    @Body(new ZodBody(administerSchema)) body: AdministerRequest,
  ): Promise<MarDoseRow> {
    return this.nursing.administer(id, body);
  }

  @Permission('mar.omit')
  @Patch('mar/doses/:id/omit')
  async omit(@Param('id') id: string, @Body(new ZodBody(omitSchema)) body: OmitRequest): Promise<MarDoseRow> {
    return this.nursing.omit(id, body);
  }

  // ── Escalation ─────────────────────────────────────────────────────────────

  @Permission('escalation.read')
  @Get('escalations')
  async escalations(
    @Query(new ZodBody(escalationQuerySchema)) query: EscalationQuery,
  ): Promise<Page<EscalationRow>> {
    return this.nursing.escalations(query);
  }

  @Permission('escalation.acknowledge')
  @Patch('escalations/:id/acknowledge')
  async acknowledge(
    @Param('id') id: string,
    @Body(new ZodBody(escalationAckSchema)) body: EscalationAckRequest,
  ): Promise<EscalationRow> {
    return this.nursing.acknowledgeEscalation(id, body);
  }

  @Permission('escalation.resolve')
  @Patch('escalations/:id/resolve')
  async resolve(
    @Param('id') id: string,
    @Body(new ZodBody(escalationResolveSchema)) body: EscalationResolveRequest,
  ): Promise<EscalationRow> {
    return this.nursing.resolveEscalation(id, body);
  }

  // ── Fluids, notes, handover ────────────────────────────────────────────────

  @Permission('nursing.io.record')
  @Post('fluids')
  async recordFluid(@Body(new ZodBody(fluidSchema)) body: FluidRequest): Promise<FluidBalanceView> {
    return this.nursing.recordFluid(body);
  }

  @Permission('nursing.ward.read')
  @Get('fluids/:admissionId')
  async fluidBalance(@Param('admissionId') admissionId: string): Promise<FluidBalanceView> {
    return this.nursing.fluidBalance(admissionId);
  }

  @Permission('nursing.note.write')
  @Post('notes')
  async writeNote(@Body(new ZodBody(noteSchema)) body: NoteRequest): Promise<{ readonly id: string }> {
    return this.nursing.writeNote(body);
  }

  @Permission('nursing.handover.compose')
  @Idempotent()
  @Post('handovers')
  async compose(@Body(new ZodBody(handoverSchema)) body: HandoverRequest): Promise<HandoverView> {
    return this.nursing.composeHandover(body);
  }

  @Permission('nursing.handover.sign')
  @Patch('handovers/:id/sign')
  async sign(
    @Param('id') id: string,
    @Body(new ZodBody(handoverSignSchema)) body: HandoverSignRequest,
  ): Promise<HandoverView> {
    return this.nursing.signHandover(id, body);
  }

  // ── Infection control ──────────────────────────────────────────────────────

  @Permission('infection.device.record')
  @Idempotent()
  @Post('devices')
  async insertDevice(@Body(new ZodBody(deviceSchema)) body: DeviceRequest): Promise<DeviceRow> {
    return this.nursing.insertDevice(body);
  }

  @Permission('infection.device.record')
  @Patch('devices/:id/remove')
  async removeDevice(
    @Param('id') id: string,
    @Body(new ZodBody(deviceRemoveSchema)) body: DeviceRemoveRequest,
  ): Promise<DeviceRow> {
    return this.nursing.removeDevice(id, body);
  }

  @Permission('infection.isolation.manage')
  @Idempotent()
  @Post('isolation')
  async startIsolation(@Body(new ZodBody(isolationSchema)) body: IsolationRequest): Promise<IsolationRow> {
    return this.nursing.startIsolation(body);
  }

  @Permission('infection.hai.read')
  @Get('hai')
  async haiCases(): Promise<readonly HaiRow[]> {
    return this.nursing.haiCases();
  }

  @Permission('infection.hai.adjudicate')
  @Patch('hai/:id')
  async adjudicate(
    @Param('id') id: string,
    @Body(new ZodBody(haiAdjudicateSchema)) body: HaiAdjudicateRequest,
  ): Promise<HaiRow> {
    return this.nursing.adjudicateHai(id, body);
  }
}
