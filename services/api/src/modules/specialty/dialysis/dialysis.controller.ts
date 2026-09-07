import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { DialysisService } from './dialysis.service.js';
import {
  abortSchema,
  accessSchema,
  accessUpdateSchema,
  dialyserQuerySchema,
  dialyserSchema,
  discardSchema,
  machineRezoneSchema,
  machineSchema,
  machineStatusSchema,
  observationSchema,
  prescriptionSchema,
  programQuerySchema,
  programSchema,
  programUpdateSchema,
  reprocessSchema,
  sessionQuerySchema,
  sessionSchema,
  sessionUpdateSchema,
  type AbortRequest,
  type AccessRequest,
  type AccessUpdateRequest,
  type DialyserQuery,
  type DialyserRequest,
  type DiscardRequest,
  type MachineRequest,
  type MachineRezoneRequest,
  type MachineStatusRequest,
  type ObservationRequest,
  type PrescriptionRequest,
  type ProgramQuery,
  type ProgramRequest,
  type ProgramUpdateRequest,
  type ReprocessRequest,
  type SessionQuery,
  type SessionRequest,
  type SessionUpdateRequest,
} from './dialysis.schemas.js';
import type {
  DialyserUseRow,
  DialysisBoardRow,
  DialysisMachineRow,
  DialysisObservationRow,
  DialysisPrescriptionRow,
  DialysisProgramRow,
  DialysisSessionDetail,
  DialysisSessionRow,
  VascularAccessRow,
} from './dialysis.types.js';

/**
 * `/api/v1/dialysis/*` — OP-012 and IP-022.
 *
 * ── One route is the documented way past a rule, and it is the zone ────────
 *
 * `POST machines/:id/rezone`. Every other rule in this module protects one
 * patient; the zone protects the next four people on that chair. So it is a
 * `high` key with a mandatory reason, an audit row, and a database that refuses
 * it outright while the machine still holds a booking.
 *
 * ── And no route forces a session onto the wrong machine ───────────────────
 *
 * There is no `force`, no `override`, no `ignore_zone`. A hepatitis-positive
 * patient is never correctly placed on a general machine, so there is nothing
 * for such a route to be for.
 *
 * ── The ultrafiltration ceiling has its escape in the right place ──────────
 *
 * `POST prescriptions` — because a faster rate, when one is genuinely needed,
 * is a nephrologist's prescribing decision with a version number and an author,
 * not a checkbox at the chair four hours into a shift.
 */
@Controller()
export class DialysisController {
  constructor(@Inject(DialysisService) private readonly dialysis: DialysisService) {}

  // ── The programme ─────────────────────────────────────────────────────────

  @Permission('dialysis.program.manage')
  @Idempotent()
  @Post('dialysis/programs')
  async createProgram(@Body(new ZodBody(programSchema)) body: ProgramRequest): Promise<DialysisProgramRow> {
    return this.dialysis.createProgram(body);
  }

  @Permission('dialysis.program.read')
  @Get('dialysis/programs')
  async listPrograms(
    @Query(new ZodBody(programQuerySchema)) query: ProgramQuery,
  ): Promise<readonly DialysisProgramRow[]> {
    return this.dialysis.listPrograms(query);
  }

  @Permission('dialysis.program.read')
  @Get('dialysis/programs/:id')
  async programDetail(@Param('id') id: string): Promise<{
    readonly program: DialysisProgramRow;
    readonly accesses: readonly VascularAccessRow[];
    readonly prescriptions: readonly DialysisPrescriptionRow[];
    readonly sessions: readonly DialysisSessionRow[];
  }> {
    return this.dialysis.programDetail(id);
  }

  /**
   * Revising the dry weight or the serology. A serology that turns positive
   * moves the patient's zone and releases every machine they were booked on —
   * because those bookings are now on the wrong machines.
   */
  @Permission('dialysis.program.manage')
  @Post('dialysis/programs/:id')
  async updateProgram(
    @Param('id') id: string,
    @Body(new ZodBody(programUpdateSchema)) body: ProgramUpdateRequest,
  ): Promise<DialysisProgramRow> {
    return this.dialysis.updateProgram(id, body);
  }

  // ── The access ────────────────────────────────────────────────────────────

  @Permission('dialysis.access.manage')
  @Idempotent()
  @Post('dialysis/accesses')
  async createAccess(@Body(new ZodBody(accessSchema)) body: AccessRequest): Promise<VascularAccessRow> {
    return this.dialysis.createAccess(body);
  }

  /** Marking an access active is what permits a needle into it. */
  @Permission('dialysis.access.manage')
  @Post('dialysis/accesses/:id')
  async updateAccess(
    @Param('id') id: string,
    @Body(new ZodBody(accessUpdateSchema)) body: AccessUpdateRequest,
  ): Promise<VascularAccessRow> {
    return this.dialysis.updateAccess(id, body);
  }

  // ── The prescription ──────────────────────────────────────────────────────

  @Permission('dialysis.prescription.write')
  @Idempotent()
  @Post('dialysis/prescriptions')
  async writePrescription(
    @Body(new ZodBody(prescriptionSchema)) body: PrescriptionRequest,
  ): Promise<DialysisPrescriptionRow> {
    return this.dialysis.writePrescription(body);
  }

  // ── The machines ──────────────────────────────────────────────────────────

  @Permission('dialysis.machine.manage')
  @Idempotent()
  @Post('dialysis/machines')
  async createMachine(@Body(new ZodBody(machineSchema)) body: MachineRequest): Promise<DialysisMachineRow> {
    return this.dialysis.createMachine(body);
  }

  @Permission('dialysis.program.read')
  @Get('dialysis/machines')
  async listMachines(): Promise<readonly DialysisMachineRow[]> {
    return this.dialysis.listMachines();
  }

  @Permission('dialysis.machine.manage')
  @Post('dialysis/machines/:id/status')
  async setMachineStatus(
    @Param('id') id: string,
    @Body(new ZodBody(machineStatusSchema)) body: MachineStatusRequest,
  ): Promise<DialysisMachineRow> {
    return this.dialysis.setMachineStatus(id, body);
  }

  /** A decommission and a re-commission, not a reassignment. */
  @Permission('dialysis.machine.rezone')
  @Post('dialysis/machines/:id/rezone')
  async rezoneMachine(
    @Param('id') id: string,
    @Body(new ZodBody(machineRezoneSchema)) body: MachineRezoneRequest,
  ): Promise<DialysisMachineRow> {
    return this.dialysis.rezoneMachine(id, body);
  }

  /** The unit's board: every machine, who is on it, who is next. */
  @Permission('dialysis.program.read')
  @Get('dialysis/board')
  async board(): Promise<readonly DialysisBoardRow[]> {
    return this.dialysis.board();
  }

  // ── The session ───────────────────────────────────────────────────────────

  @Permission('dialysis.session.schedule')
  @Idempotent()
  @Post('dialysis/sessions')
  async scheduleSession(@Body(new ZodBody(sessionSchema)) body: SessionRequest): Promise<DialysisSessionRow> {
    return this.dialysis.scheduleSession(body);
  }

  @Permission('dialysis.program.read')
  @Get('dialysis/sessions')
  async listSessions(
    @Query(new ZodBody(sessionQuerySchema)) query: SessionQuery,
  ): Promise<readonly DialysisSessionRow[]> {
    return this.dialysis.listSessions(query);
  }

  @Permission('dialysis.program.read')
  @Get('dialysis/sessions/:id')
  async sessionDetail(@Param('id') id: string): Promise<DialysisSessionDetail> {
    return this.dialysis.sessionDetail(id);
  }

  @Permission('dialysis.session.record')
  @Post('dialysis/sessions/:id')
  async updateSession(
    @Param('id') id: string,
    @Body(new ZodBody(sessionUpdateSchema)) body: SessionUpdateRequest,
  ): Promise<DialysisSessionRow> {
    return this.dialysis.updateSession(id, body);
  }

  /** A different clinical fact from a cancellation, and the one a review reads. */
  @Permission('dialysis.session.abort')
  @Post('dialysis/sessions/:id/abort')
  async abortSession(
    @Param('id') id: string,
    @Body(new ZodBody(abortSchema)) body: AbortRequest,
  ): Promise<DialysisSessionRow> {
    return this.dialysis.abortSession(id, body);
  }

  @Permission('dialysis.session.record')
  @Post('dialysis/sessions/:id/observations')
  async recordObservation(
    @Param('id') id: string,
    @Body(new ZodBody(observationSchema)) body: ObservationRequest,
  ): Promise<DialysisObservationRow> {
    return this.dialysis.recordObservation(id, body);
  }

  // ── The dialyser ──────────────────────────────────────────────────────────

  /**
   * Logging a use. The use number is not in the request — it is one more than
   * the last one on that label — and this route is the only door to a filter
   * reaching a session.
   */
  @Permission('dialysis.dialyser.log')
  @Idempotent()
  @Post('dialysis/dialysers')
  async logDialyserUse(@Body(new ZodBody(dialyserSchema)) body: DialyserRequest): Promise<DialyserUseRow> {
    return this.dialysis.logDialyserUse(body);
  }

  @Permission('dialysis.program.read')
  @Get('dialysis/dialysers')
  async listDialysers(
    @Query(new ZodBody(dialyserQuerySchema)) query: DialyserQuery,
  ): Promise<readonly DialyserUseRow[]> {
    return this.dialysis.listDialysers(query);
  }

  /** The test that licenses the next use. */
  @Permission('dialysis.dialyser.reprocess')
  @Post('dialysis/dialysers/:id/reprocess')
  async reprocess(
    @Param('id') id: string,
    @Body(new ZodBody(reprocessSchema)) body: ReprocessRequest,
  ): Promise<DialyserUseRow> {
    return this.dialysis.reprocess(id, body);
  }

  @Permission('dialysis.dialyser.discard')
  @Post('dialysis/dialysers/:id/discard')
  async discardDialyser(
    @Param('id') id: string,
    @Body(new ZodBody(discardSchema)) body: DiscardRequest,
  ): Promise<DialyserUseRow> {
    return this.dialysis.discardDialyser(id, body);
  }
}
