import { Body, Controller, Delete, Get, Inject, Param, Post, Patch, Query } from '@nestjs/common';
import {
  assignRoleRequestSchema,
  createUserRequestSchema,
  deactivateUserRequestSchema,
  listUsersQuerySchema,
  updateUserRequestSchema,
  type Page,
} from '@vims/contracts';
import { z } from 'zod';
import { getContext } from '../../../core/context/request-context.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import {
  UsersService,
  type UserDetail,
  type UserListItem,
  type UserRoleAssignment,
} from './users.service.js';

/**
 * `/api/v1/admin/users` — EN-007 §6, the user rows of the admin console.
 *
 * Every route carries a permission key from the catalogue in
 * `packages/contracts`; `assertRegisteredPermission` runs when this module is
 * loaded, so an invented key stops the process at boot rather than denying every
 * user at 2 a.m.
 *
 * The reason-required keys (`admin.user.deactivate`, `admin.user.reset`,
 * `admin.role.assign`) are enforced by the policy engine reading the `x-reason`
 * header, which the guard has already placed on the request context — so a
 * mutation without a reason is refused **before** the handler runs. The body
 * also carries a structured reason, and that is the one recorded in the audit
 * row and the domain event: the header exists to satisfy the policy, the body to
 * explain the decision to whoever reads the register later.
 */

/**
 * Declared here rather than in `packages/contracts` because the admin reset flow
 * has no shared client counterpart yet: EN-007 §3.4.1's real path is an
 * invitation link over email/SMS, which needs EN-032/EN-009. Setting a password
 * directly is the interim administrator path, and it always forces a change at
 * next login unless explicitly told otherwise.
 */
export const resetPasswordSchema = z.object({
  newPassword: z.string().min(1).max(512),
  mustChangePassword: z.boolean().default(true),
});

const idSchema = z.string().uuid();

@Controller('admin/users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Permission('admin.user.read')
  @Get()
  async list(
    @Query(new ZodBody(listUsersQuerySchema)) query: z.infer<typeof listUsersQuerySchema>,
  ): Promise<Page<UserListItem>> {
    return this.users.list(query);
  }

  @Permission('admin.user.read')
  @Get(':id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<UserDetail> {
    return this.users.get(id);
  }

  @Permission('admin.user.create')
  @Post()
  async create(
    @Body(new ZodBody(createUserRequestSchema)) body: z.infer<typeof createUserRequestSchema>,
  ): Promise<UserDetail> {
    return this.users.create(body);
  }

  @Permission('admin.user.update')
  @Patch(':id')
  async update(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(updateUserRequestSchema)) body: z.infer<typeof updateUserRequestSchema>,
  ): Promise<UserDetail> {
    return this.users.update(id, body);
  }

  /**
   * Deactivation, never deletion (`EN-007 §5`). A POST rather than a DELETE for
   * exactly that reason: the resource does not go away, its status changes.
   */
  @Permission('admin.user.deactivate')
  @Post(':id/deactivate')
  async deactivate(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(deactivateUserRequestSchema)) body: z.infer<typeof deactivateUserRequestSchema>,
  ): Promise<{ sessionsRevoked: number }> {
    return this.users.deactivate(id, body);
  }

  @Permission('admin.user.reset')
  @Post(':id/reset-password')
  async resetPassword(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
  ): Promise<{ mustChangePassword: boolean }> {
    return this.users.resetPassword(id, body);
  }

  @Permission('admin.user.read')
  @Get(':id/roles')
  async roles(
    @Param('id', new ZodBody(idSchema)) id: string,
  ): Promise<{ items: readonly UserRoleAssignment[] }> {
    return { items: await this.users.rolesFor(id) };
  }

  @Permission('admin.role.assign')
  @Post(':id/roles')
  async assignRole(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(assignRoleRequestSchema)) body: z.infer<typeof assignRoleRequestSchema>,
  ): Promise<{ items: readonly UserRoleAssignment[] }> {
    return { items: await this.users.assignRole(id, body) };
  }

  /**
   * A DELETE that deactivates. The row survives — `EN-007 §3.2.5` runs access
   * reviews against historical grants, and a deleted grant is a review that can
   * never be answered.
   */
  @Permission('admin.role.assign')
  @Delete(':id/roles/:userRoleId')
  async revokeRole(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Param('userRoleId', new ZodBody(idSchema)) userRoleId: string,
  ): Promise<{ items: readonly UserRoleAssignment[] }> {
    // No body: a DELETE that carries one is awkward for every HTTP client, and
    // the reason is already mandatory here — `admin.role.assign` is
    // reason-required, so the policy engine refused this request unless
    // `x-reason` was present. Reading it back is reading what was enforced.
    const reason = getContext().reason ?? '';
    return { items: await this.users.revokeRole(id, userRoleId, reason) };
  }
}
