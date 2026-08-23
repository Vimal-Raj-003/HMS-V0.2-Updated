import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  amendResultSchema,
  benchWorklistQuerySchema,
  enterResultsSchema,
  idSchema,
  patientResultsQuerySchema,
  releaseResultsSchema,
  type AmendResultRequest,
  type BenchWorklistQuery,
  type EnterResultsRequest,
  type PatientResultsQuery,
  type ReleaseResultsRequest,
} from './lab.schemas.js';
import type { LabResultChainLink, LabResultView, LabWorklistItem } from './lab.types.js';
import { LabResultsService } from './results.service.js';

/**
 * `/api/v1/lab/results` and `/api/v1/lab/worklists` — OP-004 §3.3–§3.4.
 *
 * The permission split is `docs/05`'s segregation of duty made routable:
 * entering (`lab.result.enter`), technical verification (`lab.result.verify`)
 * and medical authorisation (`lab.result.validate`) are three different keys, so
 * a role that can produce a number cannot be the one that releases it. The
 * service additionally refuses a verifier who is the enterer, which a route
 * decorator cannot express because it depends on the row.
 */
@Controller('lab')
export class LabResultsController {
  constructor(@Inject(LabResultsService) private readonly results: LabResultsService) {}

  /** `docs/07 §2.1` class B — 150 ms p95, served by the partial status indexes. */
  @Permission('lab.result.enter')
  @Get('worklists/bench')
  async worklist(
    @Query(new ZodBody(benchWorklistQuerySchema)) query: BenchWorklistQuery,
  ): Promise<Page<LabWorklistItem>> {
    return this.results.worklist(query);
  }

  @Permission('lab.result.enter')
  @Idempotent()
  @Post('results')
  async enter(
    @Body(new ZodBody(enterResultsSchema)) body: EnterResultsRequest,
  ): Promise<{ readonly results: readonly LabResultView[] }> {
    return this.results.enter(body);
  }

  /** Level 1 — technical verification. */
  @Permission('lab.result.verify')
  @Idempotent()
  @Post('results/verify')
  async verify(
    @Body(new ZodBody(releaseResultsSchema)) body: ReleaseResultsRequest,
  ): Promise<{ readonly results: readonly LabResultView[] }> {
    return this.results.verify(body);
  }

  /**
   * Level 2 — medical authorisation, the step that releases a result to a
   * report. For a critical value this is the only step D-10 gates, and the
   * database is what refuses it until the call-back is on file.
   */
  @Permission('lab.result.validate')
  @Idempotent()
  @Post('results/authorise')
  async authorise(
    @Body(new ZodBody(releaseResultsSchema)) body: ReleaseResultsRequest,
  ): Promise<{ readonly results: readonly LabResultView[] }> {
    return this.results.authorise(body);
  }

  @Permission('lab.result.amend')
  @Idempotent()
  @Post('results/:id/amend')
  async amend(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(amendResultSchema)) body: AmendResultRequest,
  ): Promise<LabResultView> {
    return this.results.amend(id, body);
  }

  /** `docs/07 §2.1` class C — 250 ms p95. */
  @Permission('lab.result.read')
  @Get('results/:id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<LabResultView> {
    return this.results.get(id);
  }

  /** The chain, re-derived by the database. What a NABL assessor asks for. */
  @Permission('lab.result.read')
  @Get('results/:id/chain')
  async chain(
    @Param('id', new ZodBody(idSchema)) id: string,
  ): Promise<{ readonly links: readonly LabResultChainLink[] }> {
    return this.results.chain(id);
  }

  /** `OP-004 §3.6.1` — the cumulative view across visits. */
  @Permission('lab.result.read')
  @Get('patients/:id/results')
  async forPatient(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Query(new ZodBody(patientResultsQuerySchema)) query: PatientResultsQuery,
  ): Promise<Page<LabResultView>> {
    return this.results.forPatient(id, query);
  }
}
