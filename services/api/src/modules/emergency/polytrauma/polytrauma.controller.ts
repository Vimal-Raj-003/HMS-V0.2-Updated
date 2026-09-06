import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { PolytraumaService } from './polytrauma.service.js';
import {
  bloodSchema,
  bloodUpdateSchema,
  boardQuerySchema,
  closeCaseSchema,
  consentSchema,
  consultResponseSchema,
  consultSchema,
  waiverSchema,
  escalateSchema,
  familyUpdateSchema,
  huddleSchema,
  openCaseSchema,
  planProcedureSchema,
  procedureStateChangeSchema,
  sequenceSchema,
  taskCompleteSchema,
  taskSchema,
  teamSchema,
  type BloodRequest,
  type BloodUpdateRequest,
  type BoardQuery,
  type CloseCaseRequest,
  type ConsentRequest,
  type ConsultRequestBody,
  type ConsultResponseRequest,
  type EscalateRequest,
  type FamilyUpdateRequest,
  type HuddleRequest,
  type OpenCaseRequest,
  type PlanProcedureRequest,
  type ProcedureStateRequest,
  type SequenceRequest,
  type TaskCompleteRequest,
  type TaskRequest,
  type TeamRequest,
  type WaiverRequest,
} from './polytrauma.schemas.js';
import type { BoardCardView, BoardDetailView } from './polytrauma.types.js';

/**
 * `/api/v1/polytrauma/*` — TR-007.
 *
 * ── Reading is easy; reordering is not ──────────────────────────────────────
 *
 * `GET /` and `GET /:id` need only `polytrauma.case.read`, held by everybody
 * who touches the patient, because a board only the trauma lead can read is a
 * whiteboard with extra steps. `PATCH /:id/sequence` needs a `high`-risk key
 * and a reason: the arrangement of the queue is the decision this module exists
 * to make visible.
 *
 * ── The waiver has its own route and its own key ────────────────────────────
 *
 * `PATCH /:id/procedures/:pid/consent` records an ordinary consent.
 * `PATCH /:id/procedures/:pid/waiver` records the emergency one. Splitting them
 * means the waiver can be granted to consultants without giving them a
 * different consent screen, and means the waivers are countable.
 */
@Controller('polytrauma')
export class PolytraumaController {
  constructor(@Inject(PolytraumaService) private readonly boards: PolytraumaService) {}

  @Permission('polytrauma.case.list')
  @Get()
  async list(@Query(new ZodBody(boardQuerySchema)) query: BoardQuery): Promise<Page<BoardCardView>> {
    return this.boards.listBoards(query);
  }

  @Permission('polytrauma.case.open')
  @Idempotent()
  @Post()
  async open(@Body(new ZodBody(openCaseSchema)) body: OpenCaseRequest): Promise<BoardDetailView> {
    return this.boards.openBoard(body);
  }

  @Permission('polytrauma.case.read')
  @Get(':id')
  async get(@Param('id') id: string): Promise<BoardDetailView> {
    return this.boards.getBoard(id);
  }

  @Permission('polytrauma.case.close')
  @Patch(':id/close')
  async close(
    @Param('id') id: string,
    @Body(new ZodBody(closeCaseSchema)) body: CloseCaseRequest,
  ): Promise<BoardDetailView> {
    return this.boards.closeBoard(id, body);
  }

  // ── The queue ──────────────────────────────────────────────────────────────

  @Permission('polytrauma.procedure.plan')
  @Idempotent()
  @Post(':id/procedures')
  async plan(
    @Param('id') id: string,
    @Body(new ZodBody(planProcedureSchema)) body: PlanProcedureRequest,
  ): Promise<BoardDetailView> {
    return this.boards.planProcedure(id, body);
  }

  @Permission('polytrauma.procedure.sequence')
  @Patch(':id/sequence')
  async resequence(
    @Param('id') id: string,
    @Body(new ZodBody(sequenceSchema)) body: SequenceRequest,
  ): Promise<BoardDetailView> {
    return this.boards.resequence(id, body);
  }

  @Permission('polytrauma.procedure.state')
  @Patch(':id/procedures/:procedureId')
  async setState(
    @Param('id') id: string,
    @Param('procedureId') procedureId: string,
    @Body(new ZodBody(procedureStateChangeSchema)) body: ProcedureStateRequest,
  ): Promise<BoardDetailView> {
    return this.boards.setProcedureState(id, procedureId, body);
  }

  // ── Consent ────────────────────────────────────────────────────────────────

  @Permission('polytrauma.consent.record')
  @Patch(':id/procedures/:procedureId/consent')
  async consent(
    @Param('id') id: string,
    @Param('procedureId') procedureId: string,
    @Body(new ZodBody(consentSchema)) body: ConsentRequest,
  ): Promise<BoardDetailView> {
    return this.boards.recordConsent(id, procedureId, body);
  }

  @Permission('polytrauma.consent.waive')
  @Patch(':id/procedures/:procedureId/waiver')
  async waive(
    @Param('id') id: string,
    @Param('procedureId') procedureId: string,
    @Body(new ZodBody(waiverSchema)) body: WaiverRequest,
  ): Promise<BoardDetailView> {
    return this.boards.recordWaiver(id, procedureId, body);
  }

  // ── Blood ──────────────────────────────────────────────────────────────────

  @Permission('polytrauma.blood.plan')
  @Idempotent()
  @Post(':id/blood')
  async planBlood(
    @Param('id') id: string,
    @Body(new ZodBody(bloodSchema)) body: BloodRequest,
  ): Promise<BoardDetailView> {
    return this.boards.planBlood(id, body);
  }

  @Permission('polytrauma.blood.plan')
  @Patch(':id/blood/:bloodId')
  async updateBlood(
    @Param('id') id: string,
    @Param('bloodId') bloodId: string,
    @Body(new ZodBody(bloodUpdateSchema)) body: BloodUpdateRequest,
  ): Promise<BoardDetailView> {
    return this.boards.updateBlood(id, bloodId, body);
  }

  // ── Consults ───────────────────────────────────────────────────────────────

  @Permission('polytrauma.consult.request')
  @Idempotent()
  @Post(':id/consults')
  async requestConsult(
    @Param('id') id: string,
    @Body(new ZodBody(consultSchema)) body: ConsultRequestBody,
  ): Promise<BoardDetailView> {
    return this.boards.requestConsult(id, body);
  }

  @Permission('polytrauma.consult.respond')
  @Patch(':id/consults/:consultId')
  async respond(
    @Param('id') id: string,
    @Param('consultId') consultId: string,
    @Body(new ZodBody(consultResponseSchema)) body: ConsultResponseRequest,
  ): Promise<BoardDetailView> {
    return this.boards.respondToConsult(id, consultId, body);
  }

  @Permission('polytrauma.consult.escalate')
  @Patch(':id/consults/:consultId/escalate')
  async escalate(
    @Param('id') id: string,
    @Param('consultId') consultId: string,
    @Body(new ZodBody(escalateSchema)) body: EscalateRequest,
  ): Promise<BoardDetailView> {
    return this.boards.escalateConsult(id, consultId, body);
  }

  // ── Team, tasks, huddles, family ───────────────────────────────────────────

  @Permission('polytrauma.team.assign')
  @Post(':id/team')
  async assign(
    @Param('id') id: string,
    @Body(new ZodBody(teamSchema)) body: TeamRequest,
  ): Promise<BoardDetailView> {
    return this.boards.assignTeam(id, body);
  }

  @Permission('polytrauma.task.manage')
  @Post(':id/tasks')
  async addTask(
    @Param('id') id: string,
    @Body(new ZodBody(taskSchema)) body: TaskRequest,
  ): Promise<BoardDetailView> {
    return this.boards.addTask(id, body);
  }

  @Permission('polytrauma.task.manage')
  @Patch(':id/tasks/:taskId')
  async completeTask(
    @Param('id') id: string,
    @Param('taskId') taskId: string,
    @Body(new ZodBody(taskCompleteSchema)) body: TaskCompleteRequest,
  ): Promise<BoardDetailView> {
    return this.boards.completeTask(id, taskId, body);
  }

  @Permission('polytrauma.huddle.record')
  @Post(':id/huddles')
  async huddle(
    @Param('id') id: string,
    @Body(new ZodBody(huddleSchema)) body: HuddleRequest,
  ): Promise<BoardDetailView> {
    return this.boards.recordHuddle(id, body);
  }

  @Permission('polytrauma.family.update')
  @Post(':id/family-updates')
  async familyUpdate(
    @Param('id') id: string,
    @Body(new ZodBody(familyUpdateSchema)) body: FamilyUpdateRequest,
  ): Promise<BoardDetailView> {
    return this.boards.recordFamilyUpdate(id, body);
  }
}
