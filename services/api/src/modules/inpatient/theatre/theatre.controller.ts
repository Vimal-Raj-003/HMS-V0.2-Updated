import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { TheatreService } from './theatre.service.js';
import {
  boardQuerySchema,
  caseSchema,
  checklistSchema,
  closeSchema,
  countsSchema,
  indicatorSchema,
  intraopSchema,
  issueSchema,
  loadQuerySchema,
  loadSchema,
  preopSchema,
  returnSchema,
  setSchema,
  type BoardQuery,
  type CaseRequest,
  type ChecklistRequest,
  type CloseRequest,
  type CountsRequest,
  type IndicatorRequest,
  type IntraopRequest,
  type IssueRequest,
  type LoadQuery,
  type LoadRequest,
  type PreopRequest,
  type ReturnRequest,
  type SetRequest,
} from './theatre.schemas.js';
import type { CssdLoadRow, OtCaseDetail, OtCaseRow, RecallResult } from './theatre.types.js';

/**
 * `/api/v1/theatre/*` and `/api/v1/cssd/*` — Phase 7D.
 *
 * ── There is no route that skips a checklist phase ──────────────────────────
 *
 * No `force`, no `emergencyMode`, no `skipTimeout`. Recording an incision on a
 * case whose time-out has not been run is refused by a trigger regardless of
 * how the row was written. An emergency case gets a *bumped elective case* with
 * a recorded reason — not a shorter checklist.
 *
 * ── The recall takes a reason for the same purpose the implant trace does ───
 *
 * It produces a list of patients, and who asked for it and why is part of the
 * record.
 */
@Controller()
export class TheatreController {
  constructor(@Inject(TheatreService) private readonly theatre: TheatreService) {}

  @Permission('ot.board.read')
  @Get('theatre/board')
  async board(@Query(new ZodBody(boardQuerySchema)) query: BoardQuery): Promise<Page<OtCaseRow>> {
    return this.theatre.board(query);
  }

  @Permission('ot.case.book')
  @Idempotent()
  @Post('theatre/cases')
  async book(@Body(new ZodBody(caseSchema)) body: CaseRequest): Promise<OtCaseDetail> {
    return this.theatre.book(body);
  }

  @Permission('ot.board.read')
  @Get('theatre/cases/:id')
  async getCase(@Param('id') id: string): Promise<OtCaseDetail> {
    return this.theatre.getCase(id);
  }

  @Permission('ot.preop.record')
  @Patch('theatre/cases/:id/preop')
  async preop(
    @Param('id') id: string,
    @Body(new ZodBody(preopSchema)) body: PreopRequest,
  ): Promise<OtCaseDetail> {
    return this.theatre.recordPreop(id, body);
  }

  /**
   * One route for all three phases, gated on the phase-specific key.
   *
   * The alternative — three routes — would let a hospital grant two of the
   * three, which is a shape that should not exist. Here the phase is in the
   * body and the guard reads the widest of the three; the triggers still
   * enforce the order.
   */
  @Permission('ot.checklist.timeout')
  @Post('theatre/cases/:id/checklist')
  async checklist(
    @Param('id') id: string,
    @Body(new ZodBody(checklistSchema)) body: ChecklistRequest,
  ): Promise<OtCaseDetail> {
    return this.theatre.runChecklist(id, body);
  }

  @Permission('ot.intraop.record')
  @Patch('theatre/cases/:id/intraop')
  async intraop(
    @Param('id') id: string,
    @Body(new ZodBody(intraopSchema)) body: IntraopRequest,
  ): Promise<OtCaseDetail> {
    return this.theatre.recordIntraop(id, body);
  }

  @Permission('ot.checklist.signout')
  @Patch('theatre/cases/:id/counts')
  async counts(
    @Param('id') id: string,
    @Body(new ZodBody(countsSchema)) body: CountsRequest,
  ): Promise<OtCaseDetail> {
    return this.theatre.recordCounts(id, body);
  }

  @Permission('ot.case.close')
  @Patch('theatre/cases/:id/close')
  async close(
    @Param('id') id: string,
    @Body(new ZodBody(closeSchema)) body: CloseRequest,
  ): Promise<OtCaseDetail> {
    return this.theatre.close(id, body);
  }

  // ── Sterile supply ─────────────────────────────────────────────────────────

  @Permission('cssd.set.manage')
  @Idempotent()
  @Post('cssd/sets')
  async createSet(@Body(new ZodBody(setSchema)) body: SetRequest): Promise<{ readonly id: string }> {
    return this.theatre.createSet(body);
  }

  @Permission('cssd.load.run')
  @Idempotent()
  @Post('cssd/loads')
  async startLoad(@Body(new ZodBody(loadSchema)) body: LoadRequest): Promise<CssdLoadRow> {
    return this.theatre.startLoad(body);
  }

  @Permission('cssd.load.run')
  @Get('cssd/loads')
  async loads(@Query(new ZodBody(loadQuerySchema)) query: LoadQuery): Promise<Page<CssdLoadRow>> {
    return this.theatre.loads(query);
  }

  @Permission('cssd.indicator.record')
  @Patch('cssd/loads/:id/indicators')
  async indicators(
    @Param('id') id: string,
    @Body(new ZodBody(indicatorSchema)) body: IndicatorRequest,
  ): Promise<CssdLoadRow> {
    return this.theatre.recordIndicators(id, body);
  }

  @Permission('cssd.load.release')
  @Patch('cssd/loads/:id/release')
  async release(@Param('id') id: string): Promise<CssdLoadRow> {
    return this.theatre.releaseLoad(id);
  }

  @Permission('cssd.issue')
  @Idempotent()
  @Post('cssd/issues')
  async issue(@Body(new ZodBody(issueSchema)) body: IssueRequest): Promise<{ readonly id: string }> {
    return this.theatre.issue(body);
  }

  @Permission('cssd.issue')
  @Patch('cssd/issues/:id/return')
  async returnSet(
    @Param('id') id: string,
    @Body(new ZodBody(returnSchema)) body: ReturnRequest,
  ): Promise<{ readonly returned: boolean }> {
    return this.theatre.returnSet(id, body);
  }

  @Permission('cssd.recall.run')
  @Patch('cssd/loads/:id/recall')
  async recall(@Param('id') id: string): Promise<RecallResult> {
    return this.theatre.recall(id);
  }
}
