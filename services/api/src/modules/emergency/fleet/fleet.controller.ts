import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { FleetService } from './fleet.service.js';
import {
  acknowledgePrealertSchema,
  boardQuerySchema,
  checklistSchema,
  closeTripSchema,
  crewSchema,
  createVehicleSchema,
  dispatchSchema,
  divertPrealertSchema,
  divertSchema,
  documentSchema,
  drugSchema,
  fleetQuerySchema,
  fuelSchema,
  handoverSchema,
  idSchema,
  interventionSchema,
  milestoneSchema,
  pcrSchema,
  positionSchema,
  prealertSchema,
  requestSchema,
  shiftSchema,
  vehicleStatusSchema,
  vitalsSchema,
  type AcknowledgePrealertRequest,
  type BoardQuery,
  type ChecklistRequest,
  type CloseTripRequest,
  type CrewRequest,
  type CreateVehicleRequest,
  type DispatchRequest,
  type DivertPrealertRequest,
  type DivertRequest,
  type DocumentRequest,
  type FleetQuery,
  type FleetRequestRequest,
  type FuelRequest,
  type HandoverRequest,
  type MilestoneRequest,
  type PcrRequest,
  type PhDrugRequest,
  type PhInterventionRequest,
  type PositionRequest,
  type PrealertRequest,
  type ShiftRequest,
  type VehicleStatusRequest,
  type VitalsRequest,
} from './fleet.schemas.js';
import type {
  DispatchBoardView,
  FleetRequestView,
  FleetVehicleView,
  PrealertView,
  TripDetailView,
} from './fleet.types.js';

/**
 * `/api/v1/fleet/*` and `/api/v1/prehospital/*` — NC-013 and TR-009.
 *
 * One controller for two modules because they write to one trip. Splitting it
 * would mean two services holding the same row, which is the thing the schema
 * comment argues against at length.
 *
 * ── The permissions are the boundary, not the path ──────────────────────────
 *
 * `fleet.*` is operational and a dispatcher holds it; `prehospital.*` is PHI
 * and only the crew and the receiving team do. A call-centre agent can dispatch
 * an ambulance and cannot read the patient record it comes back with, and the
 * spec asserts that rather than describing it.
 */
@Controller()
export class FleetController {
  constructor(@Inject(FleetService) private readonly fleet: FleetService) {}

  // ── The dispatch board ─────────────────────────────────────────────────────

  @Permission('fleet.trip.read')
  @Get('fleet/board')
  async board(@Query(new ZodBody(boardQuerySchema)) query: BoardQuery): Promise<DispatchBoardView> {
    return this.fleet.board(query);
  }

  // ── The register ───────────────────────────────────────────────────────────

  @Permission('fleet.vehicle.read')
  @Get('fleet/vehicles')
  async listVehicles(
    @Query(new ZodBody(fleetQuerySchema)) query: FleetQuery,
  ): Promise<Page<FleetVehicleView>> {
    return this.fleet.listVehicles(query);
  }

  @Permission('fleet.vehicle.manage')
  @Idempotent()
  @Post('fleet/vehicles')
  async createVehicle(
    @Body(new ZodBody(createVehicleSchema)) body: CreateVehicleRequest,
  ): Promise<FleetVehicleView> {
    return this.fleet.createVehicle(body);
  }

  @Permission('fleet.vehicle.manage')
  @Post('fleet/vehicles/:id/status')
  async setStatus(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(vehicleStatusSchema)) body: VehicleStatusRequest,
  ): Promise<FleetVehicleView> {
    return this.fleet.setVehicleStatus(id, body);
  }

  /** Renewals. An expired mandatory document stops dispatch at the database. */
  @Permission('fleet.document.manage')
  @Post('fleet/vehicles/:id/documents')
  async recordDocument(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(documentSchema)) body: DocumentRequest,
  ): Promise<FleetVehicleView> {
    return this.fleet.recordDocument(id, body);
  }

  @Permission('fleet.crew.manage')
  @Post('fleet/crew')
  async addCrew(@Body(new ZodBody(crewSchema)) body: CrewRequest): Promise<{ readonly id: string }> {
    return this.fleet.addCrew(body);
  }

  @Permission('fleet.crew.manage')
  @Post('fleet/shifts')
  async openShift(@Body(new ZodBody(shiftSchema)) body: ShiftRequest): Promise<{ readonly id: string }> {
    return this.fleet.openShift(body);
  }

  /** A pass on the shift-start check is what makes a vehicle available. */
  @Permission('fleet.checklist.record')
  @Post('fleet/checklists')
  async recordChecklist(
    @Body(new ZodBody(checklistSchema)) body: ChecklistRequest,
  ): Promise<FleetVehicleView> {
    return this.fleet.recordChecklist(body);
  }

  /** Sending it out anyway. Needs a reason in `x-reason`. */
  @Permission('fleet.checklist.override')
  @Post('fleet/checklists/:id/override')
  async overrideChecklist(@Param('id', new ZodBody(idSchema)) id: string): Promise<FleetVehicleView> {
    return this.fleet.overrideChecklist(id);
  }

  @Permission('fleet.fuel.record')
  @Post('fleet/fuel')
  async recordFuel(
    @Body(new ZodBody(fuelSchema)) body: FuelRequest,
  ): Promise<{ readonly kmPerLitre: string | null }> {
    return this.fleet.recordFuel(body);
  }

  // ── Requests and trips ─────────────────────────────────────────────────────

  @Permission('fleet.request.create')
  @Idempotent()
  @Post('fleet/requests')
  async createRequest(
    @Body(new ZodBody(requestSchema)) body: FleetRequestRequest,
  ): Promise<FleetRequestView> {
    return this.fleet.createRequest(body);
  }

  @Permission('fleet.trip.dispatch')
  @Idempotent()
  @Post('fleet/trips')
  async dispatch(@Body(new ZodBody(dispatchSchema)) body: DispatchRequest): Promise<TripDetailView> {
    return this.fleet.dispatch(body);
  }

  @Permission('fleet.trip.read')
  @Get('fleet/trips/:id')
  async getTrip(@Param('id', new ZodBody(idSchema)) id: string): Promise<TripDetailView> {
    return this.fleet.getTrip(id);
  }

  /** En route, at scene, patient on board, arrived. Idempotent per milestone. */
  @Permission('fleet.trip.update')
  @Post('fleet/trips/:id/milestone')
  async milestone(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(milestoneSchema)) body: MilestoneRequest,
  ): Promise<TripDetailView> {
    return this.fleet.recordMilestone(id, body);
  }

  /** Needs a reason in `x-reason`. */
  @Permission('fleet.trip.divert')
  @Post('fleet/trips/:id/divert')
  async divert(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(divertSchema)) body: DivertRequest,
  ): Promise<TripDetailView> {
    return this.fleet.divert(id, body);
  }

  @Permission('fleet.trip.close')
  @Post('fleet/trips/:id/close')
  async closeTrip(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(closeTripSchema)) body: CloseTripRequest,
  ): Promise<TripDetailView> {
    return this.fleet.closeTrip(id, body);
  }

  /** A batch of breadcrumbs, because a tablet with no signal queues them. */
  @Permission('fleet.trip.update')
  @Post('fleet/vehicles/:id/positions')
  async positions(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(positionSchema)) body: PositionRequest,
  ): Promise<{ readonly written: number }> {
    return this.fleet.recordPositions(id, body);
  }

  // ── The patient care record ────────────────────────────────────────────────

  @Permission('prehospital.pcr.write')
  @Post('prehospital/records')
  async openPcr(@Body(new ZodBody(pcrSchema)) body: PcrRequest): Promise<TripDetailView> {
    return this.fleet.openPcr(body);
  }

  /** What the receiving team needs, on their own key. */
  @Permission('prehospital.prealert.read')
  @Get('prehospital/inbound')
  async inbound(): Promise<Page<PrealertView>> {
    return this.fleet.inbound();
  }

  @Permission('prehospital.pcr.read')
  @Get('prehospital/trips/:id')
  async readTrip(@Param('id', new ZodBody(idSchema)) id: string): Promise<TripDetailView> {
    return this.fleet.getTrip(id);
  }

  /** Append-only. There is no endpoint that edits a road observation. */
  @Permission('prehospital.pcr.write')
  @Post('prehospital/trips/:id/vitals')
  async vitals(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(vitalsSchema)) body: VitalsRequest,
  ): Promise<TripDetailView> {
    return this.fleet.recordVitals(id, body);
  }

  @Permission('prehospital.pcr.write')
  @Post('prehospital/trips/:id/interventions')
  async intervention(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(interventionSchema)) body: PhInterventionRequest,
  ): Promise<TripDetailView> {
    return this.fleet.recordIntervention(id, body);
  }

  @Permission('prehospital.pcr.write')
  @Post('prehospital/trips/:id/drugs')
  async drug(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(drugSchema)) body: PhDrugRequest,
  ): Promise<TripDetailView> {
    return this.fleet.recordDrug(id, body);
  }

  /** An unsigned record is a draft, and a trip cannot close on one. */
  @Permission('prehospital.pcr.sign')
  @Post('prehospital/trips/:id/sign')
  async signPcr(@Param('id', new ZodBody(idSchema)) id: string): Promise<TripDetailView> {
    return this.fleet.signPcr(id);
  }

  // ── Pre-alert and handover ─────────────────────────────────────────────────

  /**
   * ATMIST to the ER. Creates the inbound OP-006 visit — exit gate 1 begins
   * here, and the board shows a patient who has not arrived yet.
   */
  @Permission('prehospital.prealert.raise')
  @Idempotent()
  @Post('prehospital/trips/:id/prealert')
  async prealert(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(prealertSchema)) body: PrealertRequest,
  ): Promise<TripDetailView> {
    return this.fleet.raisePrealert(id, body);
  }

  @Permission('prehospital.prealert.acknowledge')
  @Post('prehospital/prealerts/:id/acknowledge')
  async acknowledge(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(acknowledgePrealertSchema)) body: AcknowledgePrealertRequest,
  ): Promise<PrealertView> {
    return this.fleet.acknowledgePrealert(id, body);
  }

  /** The patient is not coming after all. Needs a reason in `x-reason`. */
  @Permission('prehospital.prealert.acknowledge')
  @Post('prehospital/prealerts/:id/stand-down')
  async standDownPrealert(@Param('id', new ZodBody(idSchema)) id: string): Promise<PrealertView> {
    return this.fleet.standDownPrealert(id);
  }

  /** Needs a reason in `x-reason`. */
  @Permission('prehospital.prealert.divert')
  @Post('prehospital/prealerts/:id/divert')
  async divertPrealert(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(divertPrealertSchema)) body: DivertPrealertRequest,
  ): Promise<PrealertView> {
    return this.fleet.divertPrealert(id, body);
  }

  /**
   * The handover. **Exit gate 1 ends here.**
   *
   * `carryVitalsIntoTriage` defaults true, and that default is the gate: the
   * last road observation set becomes the first triage record rather than being
   * shown to a nurse to retype.
   */
  @Permission('prehospital.handover.complete')
  @Post('prehospital/trips/:id/handover')
  async handover(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(handoverSchema)) body: HandoverRequest,
  ): Promise<TripDetailView> {
    return this.fleet.completeHandover(id, body);
  }
}
