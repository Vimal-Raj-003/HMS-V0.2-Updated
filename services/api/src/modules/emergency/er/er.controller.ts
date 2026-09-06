import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { ErService } from './er.service.js';
import {
  assignBaySchema,
  boardQuerySchema,
  cleanBaySchema,
  createBaySchema,
  createZoneSchema,
  disposeSchema,
  idSchema,
  mergeIdentitySchema,
  preAlertSchema,
  quickRegSchema,
  updateVisitSchema,
  type AssignBayRequest,
  type BoardQuery,
  type CleanBayRequest,
  type CreateBayRequest,
  type CreateZoneRequest,
  type DisposeRequest,
  type MergeIdentityRequest,
  type PreAlertRequest,
  type QuickRegRequest,
  type UpdateVisitRequest,
} from './er.schemas.js';
import type { ErBayView, ErBoardView, ErVisitDetailView, ErZoneView } from './er.types.js';

/**
 * `/api/v1/er/*` — OP-006.
 *
 * ── `POST /visits` asks for almost nothing ──────────────────────────────────
 *
 * An arrival mode, and that is all that is required. No name, no identifier, no
 * payer, no payment. A patient on a trolley who cannot speak gets a tag, a
 * wristband and a bay, and the desk fills in the rest hours later through
 * `POST /visits/:id/merge`.
 *
 * That is not a convenience. *Parmanand Katara v. Union of India* (1989) makes
 * emergency treatment a duty that cannot be conditioned on formalities, and a
 * required field here would be a formality with a person behind it.
 *
 * ── Nothing on this controller touches billing ──────────────────────────────
 *
 * By construction: the OP-006 schema has no column that references a bill, a
 * payer or a balance, so there is nowhere for a "pay first" gate to be added
 * later by somebody who did not read this comment.
 */
@Controller('er')
export class ErController {
  constructor(@Inject(ErService) private readonly er: ErService) {}

  // ── The board ──────────────────────────────────────────────────────────────

  @Permission('er.board.read')
  @Get('board')
  async board(@Query(new ZodBody(boardQuerySchema)) query: BoardQuery): Promise<ErBoardView> {
    return this.er.board(query);
  }

  // ── Layout (before `/visits/:id`, so the literal paths win) ────────────────

  @Permission('er.board.read')
  @Get('zones')
  async listZones(): Promise<Page<ErZoneView>> {
    return this.er.listZones();
  }

  @Permission('er.bay.manage')
  @Idempotent()
  @Post('zones')
  async createZone(@Body(new ZodBody(createZoneSchema)) body: CreateZoneRequest): Promise<ErZoneView> {
    return this.er.createZone(body);
  }

  @Permission('er.bay.manage')
  @Idempotent()
  @Post('bays')
  async createBay(@Body(new ZodBody(createBaySchema)) body: CreateBayRequest): Promise<ErBayView> {
    return this.er.createBay(body);
  }

  /** Housekeeping says the trolley is wiped. A vacated bay is never free until then. */
  @Permission('er.bay.assign')
  @Post('bays/clean')
  async markBayClean(@Body(new ZodBody(cleanBaySchema)) body: CleanBayRequest): Promise<ErBayView> {
    return this.er.markBayClean(body);
  }

  // ── Arrival ────────────────────────────────────────────────────────────────

  /** The thirty-second path. An arrival mode is the only required field. */
  @Permission('er.quickreg')
  @Idempotent()
  @Post('visits')
  async quickReg(@Body(new ZodBody(quickRegSchema)) body: QuickRegRequest): Promise<ErVisitDetailView> {
    return this.er.quickReg(body);
  }

  /** An ambulance is on its way. Exit gate 1 starts here. */
  @Permission('er.prealert.receive')
  @Idempotent()
  @Post('pre-alerts')
  async preAlert(@Body(new ZodBody(preAlertSchema)) body: PreAlertRequest): Promise<ErVisitDetailView> {
    return this.er.preAlert(body);
  }

  @Permission('er.visit.read')
  @Get('visits/:id')
  async getVisit(@Param('id', new ZodBody(idSchema)) id: string): Promise<ErVisitDetailView> {
    return this.er.getVisit(id);
  }

  @Permission('er.visit.update')
  @Patch('visits/:id')
  async updateVisit(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateVisitSchema)) body: UpdateVisitRequest,
  ): Promise<ErVisitDetailView> {
    return this.er.updateVisit(id, body);
  }

  @Permission('er.bay.assign')
  @Idempotent()
  @Post('visits/:id/bay')
  async assignBay(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(assignBaySchema)) body: AssignBayRequest,
  ): Promise<ErVisitDetailView> {
    return this.er.assignBay(id, body);
  }

  /**
   * A tag becomes a real patient. Exit gate 2.
   *
   * The ER number does not change and nothing is recreated, so every triage,
   * MLC and imaging record that already points at this visit keeps pointing at
   * it.
   */
  @Permission('er.identity.merge')
  @Idempotent()
  @Post('visits/:id/merge')
  async mergeIdentity(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(mergeIdentitySchema)) body: MergeIdentityRequest,
  ): Promise<ErVisitDetailView> {
    return this.er.mergeIdentity(id, body);
  }

  @Permission('er.disposition.decide')
  @Idempotent()
  @Post('visits/:id/disposition')
  async dispose(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(disposeSchema)) body: DisposeRequest,
  ): Promise<ErVisitDetailView> {
    return this.er.dispose(id, body);
  }
}
