import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { createRoleRequestSchema, updateRoleRequestSchema, type Page } from '@vims/contracts';
import { z } from 'zod';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  RolesService,
  type PermissionCatalogueResponse,
  type RoleDetail,
  type RoleListItem,
  type SodFinding,
} from './roles.service.js';

/**
 * `/api/v1/admin/roles` and `/api/v1/admin/permissions` — the role list and the
 * permission-matrix editor (EN-007 §6, §8 "Roles & Permissions").
 *
 * `admin.role.read` is the viewing key (Admin, HOD, Auditor per EN-007 §12);
 * `admin.role.configure` is `critical`, `sensitiveGrant` and step-up, because
 * editing a role's permission set changes what everybody holding it may do.
 *
 * There is no delete route. `EN-007 §5` never permits a role to be removed once
 * it has been assigned — historical grants must stay resolvable — so a role is
 * retired by editing, not erased.
 */
export const listRolesQuerySchema = z.object({
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const idSchema = z.string().uuid();

@Controller('admin')
export class RolesController {
  constructor(@Inject(RolesService) private readonly roles: RolesService) {}

  /**
   * The whole catalogue, grouped by module, plus the segregation-of-duties
   * pairs. Static data from `packages/contracts`, so no tenant read is involved
   * and no audit row is due — nothing about this response is tenant-specific.
   */
  @Permission('admin.role.read')
  @Get('permissions')
  catalogue(): PermissionCatalogueResponse {
    return this.roles.catalogue();
  }

  @Permission('admin.role.read')
  @Get('roles')
  async list(
    @Query(new ZodBody(listRolesQuerySchema)) query: z.infer<typeof listRolesQuerySchema>,
  ): Promise<Page<RoleListItem>> {
    return this.roles.list(query.cursor, query.limit);
  }

  @Permission('admin.role.read')
  @Get('roles/:id')
  async get(
    @Param('id', new ZodBody(idSchema)) id: string,
  ): Promise<RoleDetail & { segregationOfDuties: readonly SodFinding[] }> {
    return this.roles.get(id);
  }

  @Permission('admin.role.configure')
  @Post('roles')
  async create(
    @Body(new ZodBody(createRoleRequestSchema)) body: z.infer<typeof createRoleRequestSchema>,
  ): Promise<RoleDetail> {
    return this.roles.create(body);
  }

  @Permission('admin.role.configure')
  @Patch('roles/:id')
  async update(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateRoleRequestSchema)) body: z.infer<typeof updateRoleRequestSchema>,
  ): Promise<RoleDetail> {
    return this.roles.update(id, body);
  }
}
