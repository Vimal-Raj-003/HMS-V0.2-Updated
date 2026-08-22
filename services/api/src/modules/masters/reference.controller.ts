import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Permission } from '../../core/policy/permission.decorator.js';
import { ZodBody } from '../../core/validation/zod.pipe.js';
import {
  listAreasQuerySchema,
  listReferenceQuerySchema,
  referenceKindSchema,
  type ListAreasQuery,
  type ListReferenceQuery,
  type ReferenceKind,
} from './masters.schemas.js';
import { ReferenceService, type AreaListItem, type ReferenceListItem } from './reference.service.js';

/**
 * `/api/v1/masters/{kind}` — the eight small demographic lookups behind one
 * route, exactly as EN-027 §6 describes it (`GET /:master?asOf&status&q&…`).
 *
 * `kind` is a validated enum, so an unknown value is a 400 naming the eight that
 * are valid rather than a 404 that leaves the caller guessing.
 */
@Controller('masters')
export class ReferenceListsController {
  constructor(@Inject(ReferenceService) private readonly reference: ReferenceService) {}

  @Permission('mdm.read')
  @Get(':kind')
  async list(
    @Param('kind', new ZodBody(referenceKindSchema)) kind: ReferenceKind,
    @Query(new ZodBody(listReferenceQuerySchema)) query: ListReferenceQuery,
  ): Promise<Page<ReferenceListItem>> {
    return this.reference.listReference(kind, query);
  }
}

/**
 * `/api/v1/areas` — the PIN-code gazetteer `AddressForm` in `packages/ui`
 * already calls (OP-001 §3.1, "address with PIN-code lookup").
 */
@Controller('areas')
export class AreasController {
  constructor(@Inject(ReferenceService) private readonly reference: ReferenceService) {}

  @Permission('mdm.read')
  @Get()
  async list(@Query(new ZodBody(listAreasQuerySchema)) query: ListAreasQuery): Promise<Page<AreaListItem>> {
    return this.reference.listAreas(query);
  }
}
