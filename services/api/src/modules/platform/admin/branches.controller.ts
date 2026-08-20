import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { z } from 'zod';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { BranchesService, type BranchDetail, type BranchListItem } from './branches.service.js';

export const listBranchesQuerySchema = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const idSchema = z.string().uuid();

/**
 * `/api/v1/admin/branches` — EN-041 §6.
 *
 * `org.read` ("Read your own group/hospital/branch hierarchy") rather than an
 * `admin.*` key, because the branch tree belongs to EN-041 and is read by more
 * than the admin console: the branch picker at login and the role-assignment
 * screen both need it.
 */
@Controller('admin/branches')
export class BranchesController {
  constructor(@Inject(BranchesService) private readonly branches: BranchesService) {}

  @Permission('org.read')
  @Get()
  async list(
    @Query(new ZodBody(listBranchesQuerySchema)) query: z.infer<typeof listBranchesQuerySchema>,
  ): Promise<Page<BranchListItem>> {
    return this.branches.list(query.cursor, query.limit);
  }

  @Permission('org.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<BranchDetail> {
    return this.branches.get(id);
  }
}
