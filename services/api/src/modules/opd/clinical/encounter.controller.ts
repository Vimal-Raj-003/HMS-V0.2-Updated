import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import type { ChainVerification, DocumentVersionView } from './documents.service.js';
import {
  amendEncounterSchema,
  cancelEncounterSchema,
  completeEncounterSchema,
  dosingCheckSchema,
  idSchema,
  listEncountersQuerySchema,
  pauseEncounterSchema,
  recordDiagnosesSchema,
  setDosingWeightSchema,
  startEncounterSchema,
  updateEncounterSchema,
  type AmendEncounterRequest,
  type CancelEncounterRequest,
  type CompleteEncounterRequest,
  type DosingCheckRequest,
  type ListEncountersQuery,
  type PauseEncounterRequest,
  type RecordDiagnosesRequest,
  type SetDosingWeightRequest,
  type StartEncounterRequest,
  type UpdateEncounterRequest,
} from './encounter.schemas.js';
import {
  EncounterService,
  type DosingContext,
  type EncounterDetail,
  type EncounterRow,
} from './encounter.service.js';

/**
 * `/api/v1/encounters` — OP-002 §6.
 *
 * The permission split is the one the catalogue draws, and it is clinical
 * rather than administrative:
 *
 *  - `opd.encounter.create/update` is the working surface — start, autosave,
 *    pause, resume, cancel.
 *  - `opd.encounter.sign` is completion, because that is the act that produces
 *    an immutable, hash-chained document.
 *  - `opd.encounter.amend` is `requiresReason` in the catalogue, so the policy
 *    guard demands an `x-reason` header *before* the handler runs, in addition
 *    to the reason in the body and the one the database insists on.
 *  - `opd.diagnosis.update` is separate because MRD holds it too: a coder
 *    verifies codes without holding the doctor's other keys.
 *
 * **Route order matters.** Literal segments are declared before `:id`.
 */
@Controller('encounters')
export class EncounterController {
  constructor(@Inject(EncounterService) private readonly encounters: EncounterService) {}

  /** OP-002 §6 — the doctor's encounters, keyset-paginated. */
  @Permission('opd.encounter.read')
  @Get()
  async list(
    @Query(new ZodBody(listEncountersQuerySchema)) query: ListEncountersQuery,
  ): Promise<Page<EncounterRow>> {
    return this.encounters.list(query);
  }

  /** OP-002 §6 `POST /encounters` — start the consultation. */
  @Permission('opd.encounter.create')
  @Idempotent()
  @Post()
  async start(
    @Body(new ZodBody(startEncounterSchema)) body: StartEncounterRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<EncounterDetail> {
    return this.encounters.start(body, idempotencyKey ?? null);
  }

  /** OP-002 §6 `GET /encounters/{id}`. Break-glass applies (§14 AC-10). */
  @Permission('opd.encounter.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<EncounterDetail> {
    return this.encounters.get(id);
  }

  /** The note's version history with its hash chain re-verified. */
  @Permission('opd.encounter.read')
  @Get(':id/note-versions')
  async noteVersions(@Param('id', new ZodBody(idSchema)) id: string): Promise<{
    readonly documentId: string;
    readonly versions: readonly DocumentVersionView[];
    readonly chain: ChainVerification;
  }> {
    return this.encounters.noteHistory(id);
  }

  /** OP-002 §6 `PATCH /encounters/{id}` — autosave. Not idempotency-keyed: it is a patch. */
  @Permission('opd.encounter.update')
  @Patch(':id')
  async update(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateEncounterSchema)) body: UpdateEncounterRequest,
  ): Promise<EncounterDetail> {
    return this.encounters.update(id, body);
  }

  @Permission('opd.encounter.update')
  @Idempotent()
  @Post(':id/pause')
  async pause(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(pauseEncounterSchema)) body: PauseEncounterRequest,
  ): Promise<EncounterDetail> {
    return this.encounters.setPaused(id, true, body);
  }

  @Permission('opd.encounter.update')
  @Idempotent()
  @Post(':id/resume')
  async resume(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(pauseEncounterSchema)) body: PauseEncounterRequest,
  ): Promise<EncounterDetail> {
    return this.encounters.setPaused(id, false, body);
  }

  @Permission('opd.encounter.update')
  @Idempotent()
  @Post(':id/cancel')
  async cancel(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelEncounterSchema)) body: CancelEncounterRequest,
  ): Promise<EncounterDetail> {
    return this.encounters.cancel(id, body);
  }

  /** OP-002 §6 `POST /encounters/{id}/diagnoses`. */
  @Permission('opd.diagnosis.update')
  @Idempotent()
  @Post(':id/diagnoses')
  async diagnoses(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(recordDiagnosesSchema)) body: RecordDiagnosesRequest,
  ): Promise<EncounterDetail> {
    return this.encounters.recordDiagnoses(id, body);
  }

  /**
   * The dosing weight (`docs/04` §7). Idempotent: a retried save must not
   * produce two different assertions about what the patient weighs.
   */
  @Permission('opd.encounter.update')
  @Idempotent()
  @Post(':id/dosing-weight')
  async setDosingWeight(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(setDosingWeightSchema)) body: SetDosingWeightRequest,
  ): Promise<EncounterDetail> {
    return this.encounters.setDosingWeight(id, body);
  }

  /**
   * The per-kilogram dose precondition — phase-02 exit gate 3.
   *
   * A read of the encounter's dosing context that refuses rather than returning
   * a number when there is no weight. `opd.encounter.read` rather than a
   * prescribing key, because the question is about the encounter and the answer
   * is needed by the Rx grid, the order composer and the nurse alike.
   */
  @Permission('opd.encounter.read')
  @Post(':id/dosing-weight/check')
  async dosingCheck(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(dosingCheckSchema)) body: DosingCheckRequest,
  ): Promise<DosingContext> {
    return this.encounters.dosingCheck(id, body);
  }

  /** OP-002 §6 `POST /encounters/{id}/complete` — sign the note and finish. */
  @Permission('opd.encounter.sign')
  @Idempotent()
  @Post(':id/complete')
  async complete(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(completeEncounterSchema)) body: CompleteEncounterRequest,
  ): Promise<EncounterDetail> {
    return this.encounters.complete(id, body);
  }

  /**
   * OP-002 §6 `POST /encounters/{id}/reopen` — the amendment.
   *
   * Spelt `/amend` as well as `/reopen`: §6 names the route `reopen` and §14
   * AC-9 calls the act an amendment, and both words appear on the doctor's
   * screen. One handler, so they cannot diverge.
   */
  @Permission('opd.encounter.amend')
  @Idempotent()
  @Post(':id/amend')
  async amend(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(amendEncounterSchema)) body: AmendEncounterRequest,
  ): Promise<EncounterDetail> {
    return this.encounters.amend(id, body);
  }

  @Permission('opd.encounter.amend')
  @Idempotent()
  @Post(':id/reopen')
  async reopen(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(amendEncounterSchema)) body: AmendEncounterRequest,
  ): Promise<EncounterDetail> {
    return this.encounters.amend(id, body);
  }
}
