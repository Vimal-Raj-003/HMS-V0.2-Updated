import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { PatientMergeService } from './patient.merge.service.js';
import {
  dedupeQueueQuerySchema,
  historyQuerySchema,
  idSchema,
  mergeRequestSchema,
  registerPatientSchema,
  searchPatientsQuerySchema,
  unmergeRequestSchema,
  updatePatientSchema,
  type DedupeQueueQuery,
  type HistoryQuery,
  type MergeRequest,
  type RegisterPatientRequest,
  type SearchPatientsQuery,
  type UnmergeRequest,
  type UpdatePatientRequest,
} from './patient.schemas.js';
import { PatientSearchService } from './patient.search.service.js';
import { PatientService } from './patient.service.js';
import type {
  DedupeCandidateItem,
  DemographicHistoryItem,
  MergePreview,
  MergeResult,
  PatientDetail,
  PatientListItem,
  UnmergeResult,
} from './patient.types.js';

/**
 * `/api/v1/patients` — OP-001 §6.
 *
 * Every route carries a permission key from the catalogue in
 * `packages/contracts`. `assertRegisteredPermission` runs when this module is
 * loaded, so an invented key stops the process at boot rather than denying
 * everyone at 2 a.m.
 *
 * Three of the keys used here are **reason-required** in the catalogue —
 * `patient.record.update`, `patient.record.create_override` and
 * `patient.merge.execute` — which the policy engine enforces by reading the
 * `x-reason` header before the handler runs. The body carries a structured
 * reason as well, and that is the one written to `patient.demographic_history`,
 * to `patient.merges.reason` and into the audit register: the header exists to
 * satisfy the policy, the body to explain the decision to whoever reads the
 * register later. This is the same split `admin/users` uses.
 *
 * `patient.merge.execute` is additionally `requiresStepUp`, so the session must
 * have authenticated recently.
 *
 * **Route order matters here.** `patients/dedupe` and `patients/merge` are
 * declared before `patients/:id`, so a literal segment can never be swallowed by
 * the parameter — a `GET /patients/dedupe` answered by the "read one patient"
 * handler would 404 confusingly rather than returning the queue.
 */
@Controller('patients')
export class PatientController {
  constructor(
    @Inject(PatientService) private readonly patients: PatientService,
    @Inject(PatientSearchService) private readonly search: PatientSearchService,
    @Inject(PatientMergeService) private readonly merges: PatientMergeService,
  ) {}

  /**
   * OP-001 §6 `GET /patients` — the MPI search, and with no criteria the
   * recent-patients list.
   */
  @Permission('patient.record.list')
  @Get()
  async list(
    @Query(new ZodBody(searchPatientsQuerySchema)) query: SearchPatientsQuery,
  ): Promise<Page<PatientListItem>> {
    return this.search.search(query);
  }

  /** OP-001 §6 `GET /patients/dedupe` — the MRD duplicate queue. */
  @Permission('patient.merge.review')
  @Get('dedupe')
  async dedupeQueue(
    @Query(new ZodBody(dedupeQueueQuerySchema)) query: DedupeQueueQuery,
  ): Promise<Page<DedupeCandidateItem>> {
    return this.merges.dedupeQueue(query);
  }

  /**
   * OP-001 §6 `POST /patients` — register, allocating the UHID.
   *
   * A duplicate at or above 0.85 refuses the request with 422 and the candidate
   * list; passing it needs `patient.record.create_override`, an explicit
   * acknowledgement of those exact records, and a reason (§3.1, §14 AC-2).
   */
  @Permission('patient.record.create')
  @Post()
  async register(
    @Body(new ZodBody(registerPatientSchema)) body: RegisterPatientRequest,
  ): Promise<PatientDetail> {
    return this.patients.register(body);
  }

  /**
   * OP-001 §6 `POST /patients/merge` — two-step, both steps on this route.
   *
   * `step: 'prepare'` writes the pending merge and its snapshots and returns the
   * impact; `step: 'commit'` executes that specific prepared merge by id. See
   * `PatientMergeService` for why the two are separated.
   */
  @Permission('patient.merge.execute')
  @Post('merge')
  async merge(
    @Body(new ZodBody(mergeRequestSchema)) body: MergeRequest,
  ): Promise<MergePreview | MergeResult> {
    return this.merges.merge(body);
  }

  /** OP-001 §6 `POST /patients/unmerge` — reverse within the 30-day window. */
  @Permission('patient.merge.execute')
  @Post('unmerge')
  async unmerge(@Body(new ZodBody(unmergeRequestSchema)) body: UnmergeRequest): Promise<UnmergeResult> {
    return this.merges.unmerge(body);
  }

  /** OP-001 §6 `GET /patients/{id}` — the full record and its safety banner. */
  @Permission('patient.record.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<PatientDetail> {
    return this.patients.get(id);
  }

  /**
   * OP-001 §6 `PATCH /patients/{id}` — a demographic change.
   *
   * `version` in the body is the optimistic-lock check; the reason is mandatory
   * and is written to `patient.demographic_history` (§14 AC-14).
   */
  @Permission('patient.record.update')
  @Patch(':id')
  async update(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updatePatientSchema)) body: UpdatePatientRequest,
  ): Promise<PatientDetail> {
    return this.patients.update(id, body);
  }

  /**
   * OP-001 §6 `GET /patients/{id}/history`.
   *
   * `patient.record.read`, per §6 — the history is the same record, versioned,
   * and anyone allowed to open the record is allowed to see how it got there.
   */
  @Permission('patient.record.read')
  @Get(':id/history')
  async history(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Query(new ZodBody(historyQuerySchema)) query: HistoryQuery,
  ): Promise<Page<DemographicHistoryItem>> {
    return this.patients.history(id, query);
  }
}
