import { Body, Controller, Get, Headers, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { z } from 'zod';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  cancelVisitSchema,
  closeVisitSchema,
  createVisitSchema,
  listVisitsQuerySchema,
  transferVisitSchema,
  type CancelVisitRequest,
  type CloseVisitRequest,
  type CreateVisitRequest,
  type ListVisitsQuery,
  type TransferVisitRequest,
} from './dto/scheduling.dto.js';
import { VisitsService, type VisitDetail, type VisitListItem } from './visits.service.js';

const idSchema = z.string().uuid();

/**
 * `/api/v1/visits` — OP-001 §6.
 *
 * OP-001's routes table puts `cancel`, `transfer` and `close` under a single
 * `visit.update`, while OP-001 §12 and the permission catalogue define
 * `visit.cancel` and `visit.transfer` as keys of their own, both
 * `requiresReason`. This controller follows §12 and the catalogue: cancelling a
 * visit reverses a consultation fee and voids a token, transferring one moves a
 * patient between doctors with a fee difference, and both are decisions somebody
 * has to be able to explain. Using the blanket `visit.update` for them would
 * drop the reason requirement the catalogue attaches — and would leave two
 * catalogued keys unreachable. The receptionist role template
 * (`role-templates.ts` `VISIT_DESK`) already grants all five, so no real user
 * loses access.
 */
@Controller('visits')
export class VisitsController {
  constructor(@Inject(VisitsService) private readonly visits: VisitsService) {}

  @Permission('visit.list')
  @Get()
  async list(
    @Query(new ZodBody(listVisitsQuerySchema)) query: ListVisitsQuery,
  ): Promise<Page<VisitListItem>> {
    return this.visits.list(query);
  }

  @Permission('visit.list')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<VisitDetail> {
    return this.visits.get(id);
  }

  /** Walk-in: register, open a visit and issue a token in one transaction. */
  @Permission('visit.create')
  @Post()
  async create(
    @Body(new ZodBody(createVisitSchema)) body: CreateVisitRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<VisitDetail> {
    return this.visits.createWalkIn(body, idempotencyKey ?? null);
  }

  @Permission('visit.cancel')
  @Patch(':id/cancel')
  async cancel(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(cancelVisitSchema)) body: CancelVisitRequest,
  ): Promise<VisitDetail> {
    return this.visits.cancel(id, body);
  }

  @Permission('visit.transfer')
  @Patch(':id/transfer')
  async transfer(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(transferVisitSchema)) body: TransferVisitRequest,
  ): Promise<VisitDetail> {
    return this.visits.transfer(id, body);
  }

  @Permission('visit.update')
  @Patch(':id/close')
  async close(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(closeVisitSchema)) body: CloseVisitRequest,
  ): Promise<VisitDetail> {
    return this.visits.close(id, body);
  }
}
