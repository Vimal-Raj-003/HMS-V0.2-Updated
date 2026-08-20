import { Inject, Injectable } from '@nestjs/common';
import {
  ProblemType,
  assignRoleRequestSchema,
  createUserRequestSchema,
  deactivateUserRequestSchema,
  listUsersQuerySchema,
  newId,
  updateUserRequestSchema,
  type Page,
} from '@vims/contracts';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit/audit.service.js';
import { PasswordService } from '../../../core/auth/password.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { adminEvent } from './admin.events.js';

/**
 * `packages/contracts` exports the schemas but only some of their inferred
 * types. Deriving them here keeps one definition of the shape — the schema —
 * rather than a hand-written interface that can drift from what is validated.
 */
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;
export type DeactivateUserRequest = z.infer<typeof deactivateUserRequestSchema>;
export type AssignRoleRequest = z.infer<typeof assignRoleRequestSchema>;

/**
 * EN-007 §3.2 — the user lifecycle.
 *
 * Three properties are load-bearing and are the reason this file is longer than
 * its CRUD surface suggests:
 *
 *  - **Nothing is hard-deleted.** `EN-007 §5`: "Deactivated users: cannot be
 *    deleted; historical audit preserved." There is no DELETE route on a user,
 *    only `deactivate`, and `deleted_at` is left alone.
 *  - **Every mutation writes exactly one audit row in its own transaction**
 *    (`EN-024 §5` — an audit failure rolls back the change), and publishes its
 *    domain event to the outbox in that same transaction, so a user cannot be
 *    deactivated without the downstream session revocation being announced.
 *  - **No query carries a `hospital_id` predicate.** Isolation is row-level
 *    security acting on the scope stamped by `withTenant`, which is why a
 *    cross-tenant id reads as "not found" rather than "forbidden" — `docs/09`
 *    §3.1 case 2 forbids leaking existence.
 */

export interface UserListItem {
  readonly id: string;
  readonly username: string;
  readonly display_name: string;
  readonly email: string | null;
  readonly employee_id: string | null;
  readonly type: string;
  readonly status: string;
  readonly mfa_enabled: boolean;
  readonly last_login_at: Date | null;
  readonly created_at: Date;
  readonly version: number;
}

export interface UserRoleAssignment {
  readonly id: string;
  readonly role_id: string;
  readonly role_key: string;
  readonly role_name: string;
  readonly branch_id: string | null;
  readonly scope: unknown;
  readonly conditions: unknown;
  readonly valid_from: Date;
  readonly valid_to: Date | null;
  readonly active: boolean;
}

export interface UserDetail extends UserListItem {
  readonly mobile: string | null;
  readonly name: unknown;
  readonly professional: unknown;
  readonly preferences: unknown;
  readonly must_change_password: boolean;
  readonly deactivated_at: Date | null;
  readonly deactivation_reason: string | null;
  readonly roles: readonly UserRoleAssignment[];
}

export interface ResetPasswordRequest {
  readonly newPassword: string;
  readonly mustChangePassword: boolean;
}

/** The resource name bound into every cursor this service mints. */
const RESOURCE = 'admin.users';

/**
 * `EN-007 §5`: "Sensitive role grants (admin, discount approver, narcotics,
 * blood issue, insurance write-off, finance post, impersonation) require dual
 * approval and MFA on the grantee."
 *
 * The approval engine (EN-038) is not wired yet, so the only correct answer for
 * a role flagged `sensitive_grant` is to refuse it — granting it single-handed
 * would be the exact control this rule exists to impose, quietly skipped.
 */
export function sensitiveGrantRefusal(roleKey: string): AppError {
  return new AppError(
    ProblemType.APPROVAL_REQUIRED,
    `The role "${roleKey}" is flagged as a sensitive grant and needs two approvers (EN-007 §5). ` +
      'Single-handed assignment is refused until the approval workflow is available.',
    { nextAction: 'Raise an access request so a second administrator can approve it.' },
  );
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  async list(query: ListUsersQuery): Promise<Page<UserListItem>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource: RESOURCE });

    const where: string[] = ['u.deleted_at IS NULL'];
    const values: unknown[] = [];
    const bind = (value: unknown): string => `$${values.push(value)}`;

    if (query.status !== undefined) where.push(`u.status = ${bind(query.status)}::core."UserStatus"`);
    if (query.q !== undefined && query.q.length > 0) {
      const like = `%${query.q}%`;
      const p = bind(like);
      where.push(`(u.display_name ILIKE ${p} OR u.username ILIKE ${p} OR u.employee_id ILIKE ${p})`);
    }
    if (query.branchId !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM core.user_roles ur WHERE ur.user_id = u.id AND ur.active AND ur.branch_id = ${bind(query.branchId)}::uuid)`,
      );
    }
    if (query.roleKey !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
                  WHERE ur.user_id = u.id AND ur.active AND r.key = ${bind(query.roleKey)})`,
      );
    }
    if (query.departmentId !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM core.user_roles ur WHERE ur.user_id = u.id AND ur.active
                  AND ur.scope -> 'departmentIds' @> to_jsonb(${bind(query.departmentId)}::text))`,
      );
    }
    if (query.noLoginSinceDays !== undefined) {
      where.push(
        `(u.last_login_at IS NULL OR u.last_login_at < now() - (${bind(String(query.noLoginSinceDays))} || ' days')::interval)`,
      );
    }
    if (after !== null) {
      // Keyset, never a row skip: `docs/07` §4 bans skipping rows for paging
      // because the skip cost grows with the page number and the page silently
      // shifts when a row is inserted mid-scroll.
      where.push(`(u.created_at, u.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
    }

    const sql = `SELECT u.id, u.username, u.display_name, u.email, u.employee_id,
                        u.type::text AS type, u.status::text AS status, u.mfa_enabled,
                        u.last_login_at, u.created_at, u.created_at::text AS cursor_key, u.version
                   FROM core.users u
                  WHERE ${where.join(' AND ')}
                  ORDER BY u.created_at DESC, u.id DESC
                  LIMIT ${bind(limit + 1)}`;

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const fetched = await tx.rows<UserListItem & { cursor_key: string }>(sql, values);
      const page = this.cursors.keysetPage<UserListItem>(fetched, limit, {
        hospitalId,
        resource: RESOURCE,
        direction: 'desc',
      });

      // A staff list is HR-class data and reading it is auditable (docs/05
      // §Data classes). The count and the filter are recorded, never the
      // identifiers — EN-024 §3.2.5.
      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'core.users',
        rowId: null,
        businessKey: null,
        dataClass: 'hr',
        before: null,
        after: null,
        rowCount: page.items.length,
      });

      return page;
    });
  }

  async get(id: string): Promise<UserDetail> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const user = await tx.maybeOne<Omit<UserDetail, 'roles'>>(
        `SELECT u.id, u.username, u.display_name, u.email, u.mobile, u.employee_id,
                u.name, u.professional, u.preferences,
                u.type::text AS type, u.status::text AS status, u.mfa_enabled,
                u.must_change_password, u.last_login_at, u.created_at, u.version,
                u.deactivated_at, u.deactivation_reason
           FROM core.users u
          WHERE u.id = $1 AND u.deleted_at IS NULL`,
        [id],
      );

      // Row-level security already removed another tenant's row, so "no row"
      // covers both "no such user" and "not your hospital" — and the caller
      // cannot tell which, which is the point (docs/09 §3.1 case 2).
      if (user === undefined) throw AppError.notFound('The user');

      const roles = await tx.rows<UserRoleAssignment>(
        `SELECT ur.id, ur.role_id, r.key AS role_key, r.name AS role_name, ur.branch_id,
                ur.scope, ur.conditions, ur.valid_from, ur.valid_to, ur.active
           FROM core.user_roles ur
           JOIN core.roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1
          ORDER BY r.key`,
        [id],
      );

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'core.users',
        rowId: id,
        businessKey: user.username,
        dataClass: 'hr',
        before: null,
        after: null,
        rowCount: 1,
      });

      return { ...user, roles };
    });
  }

  async rolesFor(id: string): Promise<readonly UserRoleAssignment[]> {
    return (await this.get(id)).roles;
  }

  // ── writes ────────────────────────────────────────────────────────────────

  async create(body: CreateUserRequest): Promise<UserDetail> {
    // The body grants roles, and `admin.role.assign` is a different authority
    // from `admin.user.create` — see PolicyService for why one decorator is not
    // enough here.
    await this.policy.assert('admin.role.assign');

    const ctx = getContext();
    const id = newId();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const clash = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM core.users WHERE lower(username) = lower($1) AND deleted_at IS NULL`,
        [body.username],
      );
      if (clash !== undefined) throw AppError.conflict('That username is already in use.');

      const hospital = await tx.one<{ id: string; group_id: string | null }>(
        `SELECT id, group_id FROM core.hospitals WHERE id = $1`,
        [ctx.hospitalId],
      );

      // The uniqueness check above is scoped by RLS to this hospital, but the
      // index behind it is per *group* (EN-041 §3.7: one person, one login across
      // the group). A username taken in a sibling hospital is therefore invisible
      // to the check and shows up here — as a conflict, not as a 500.
      await insertOrConflict(tx, 'That username is already in use.', () =>
        tx.query(
          `INSERT INTO core.users (
           id, hospital_id, group_id, username, email, mobile, name, display_name,
           employee_id, type, status, professional, preferences,
           must_change_password, created_by, updated_by, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::jsonb, $8,
           $9, $10::core."UserType", 'invited'::core."UserStatus", $11::jsonb, $12::jsonb,
           true, $13, $13, now()
         )`,
          [
            id,
            ctx.hospitalId,
            hospital.group_id,
            body.username,
            body.email ?? null,
            body.mobile ?? null,
            JSON.stringify(body.name),
            displayNameOf(body),
            body.employeeId ?? null,
            body.type,
            JSON.stringify(body.professional ?? {}),
            JSON.stringify(body.preferences ?? {}),
            ctx.userId,
          ],
        ),
      );

      const grants: Array<{ userRoleId: string; roleId: string; branchId: string | null }> = [];
      for (const assignment of body.roleAssignments) {
        const role = await this.loadAssignableRole(tx, assignment.roleId);
        await this.assertBranchAssignable(tx, assignment.branchId);
        const userRoleId = newId();
        await tx.query(
          `INSERT INTO core.user_roles (
             id, hospital_id, user_id, role_id, branch_id, scope, conditions,
             valid_from, valid_to, granted_by, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, COALESCE($7::timestamptz, now()), $8, $9, now())`,
          [
            userRoleId,
            ctx.hospitalId,
            id,
            role.id,
            assignment.branchId,
            JSON.stringify(assignment.scope),
            assignment.validFrom ?? null,
            assignment.validTo ?? null,
            ctx.userId,
          ],
        );
        grants.push({ userRoleId, roleId: role.id, branchId: assignment.branchId });
      }

      // One audit row for the whole creation, with the grants in the `after`
      // payload — a role assignment made as part of a create is part of that
      // single fact, not a second one. `password_hash` is absent because the
      // account has none yet, and would never be recorded if it did
      // (DEFAULT_AUDIT_FIELD_POLICIES marks it `exclude`).
      await this.audit.write(tx, {
        action: 'insert',
        entity: 'core.users',
        rowId: id,
        businessKey: body.username,
        dataClass: 'hr',
        before: null,
        after: {
          username: body.username,
          display_name: displayNameOf(body),
          type: body.type,
          status: 'invited',
          role_ids: grants.map((g) => g.roleId),
        },
      });

      await this.outbox.publish(
        tx,
        adminEvent('admin.user.created', id, {
          userId: id,
          username: body.username,
          type: body.type,
          invitedBy: ctx.userId,
        }),
      );

      for (const grant of grants) {
        await this.outbox.publish(
          tx,
          adminEvent('admin.role.assigned', grant.userRoleId, {
            userRoleId: grant.userRoleId,
            userId: id,
            roleId: grant.roleId,
            branchId: grant.branchId,
            validFrom: new Date().toISOString(),
            validTo: null,
            approvalId: null,
          }),
        );
      }
    });

    return this.get(id);
  }

  async update(id: string, body: UpdateUserRequest): Promise<UserDetail> {
    const ctx = getContext();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const before = await tx.maybeOne<{
        username: string;
        email: string | null;
        mobile: string | null;
        display_name: string;
        employee_id: string | null;
        version: number;
      }>(
        `SELECT username, email, mobile, display_name, employee_id, version
           FROM core.users WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (before === undefined) throw AppError.notFound('The user');
      if (before.version !== body.version) {
        throw new AppError(
          ProblemType.OPTIMISTIC_LOCK_CONFLICT,
          'This user was changed by somebody else while you were editing.',
          { nextAction: 'Reload the user and reapply your change.' },
        );
      }

      const beforeValues: Record<string, unknown> = {
        email: before.email,
        mobile: before.mobile,
        employee_id: before.employee_id,
        display_name: before.display_name,
      };
      const after: Record<string, unknown> = {
        email: body.email ?? before.email,
        mobile: body.mobile ?? before.mobile,
        employee_id: body.employeeId ?? before.employee_id,
        display_name: body.name === undefined ? before.display_name : displayNameOf({ name: body.name }),
      };

      await tx.query(
        `UPDATE core.users
            SET email = $2, mobile = $3, employee_id = $4, display_name = $5,
                name = COALESCE($6::jsonb, name),
                professional = COALESCE($7::jsonb, professional),
                preferences = COALESCE($8::jsonb, preferences),
                version = version + 1, updated_by = $9, updated_at = now()
          WHERE id = $1`,
        [
          id,
          after.email,
          after.mobile,
          after.employee_id,
          after.display_name,
          body.name === undefined ? null : JSON.stringify(body.name),
          body.professional === undefined ? null : JSON.stringify(body.professional),
          body.preferences === undefined ? null : JSON.stringify(body.preferences),
          ctx.userId,
        ],
      );

      const changedFields = changedKeys(beforeValues, after);

      await this.audit.write(tx, {
        action: 'update',
        entity: 'core.users',
        rowId: id,
        businessKey: before.username,
        dataClass: 'hr',
        // Changed columns only (EN-024 §3.1.3): an unchanged field in a diff is
        // noise an investigator has to read past.
        before: pick(beforeValues, changedFields),
        after: pick(after, changedFields),
      });

      await this.outbox.publish(
        tx,
        adminEvent('admin.user.updated', id, {
          userId: id,
          username: before.username,
          changedFields,
        }),
      );
    });

    return this.get(id);
  }

  async deactivate(id: string, body: DeactivateUserRequest): Promise<{ readonly sessionsRevoked: number }> {
    const ctx = getContext();

    // Deactivating yourself is how a hospital ends up with no administrator at
    // all on a Sunday. It is refused here rather than left to policy, because it
    // is a property of the *target*, which the policy engine never sees.
    if (id === ctx.userId) {
      throw AppError.conflict('You cannot deactivate your own account. Ask another administrator.');
    }

    // Silently ignoring a field the caller filled in is worse than refusing it:
    // an administrator who asked for the leaver's approvals to be reassigned
    // would believe it happened. EN-038 is not wired yet, so say so.
    if (body.reassignApprovalsToUserId !== undefined) {
      throw new AppError(
        ProblemType.NOT_IMPLEMENTED,
        'Reassigning pending approvals needs the approval engine (EN-038), which is not available yet.',
        { nextAction: 'Deactivate without reassignment, then reassign the approvals manually.' },
      );
    }

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const before = await tx.maybeOne<{ username: string; status: string }>(
        `SELECT username, status::text AS status FROM core.users WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (before === undefined) throw AppError.notFound('The user');
      if (before.status === 'deactivated') {
        throw AppError.conflict('That account is already deactivated.');
      }

      await tx.query(
        `UPDATE core.users
            SET status = 'deactivated'::core."UserStatus",
                deactivated_at = now(), deactivation_reason = $2,
                version = version + 1, updated_by = $3, updated_at = now()
          WHERE id = $1`,
        [id, body.reason, ctx.userId],
      );

      // EN-007 §3.2.4: "immediate session revocation". The UPDATE is subject to
      // the same RLS predicate as any other statement, so it reaches the
      // sessions in the branches this administrator is granted. A session in a
      // branch outside their grant survives until its absolute lifetime expires
      // — which is why the count returned is what was actually revoked rather
      // than an assumption, and why the event carries it.
      const revoked = await tx.rows<{ id: string }>(
        `UPDATE core.sessions
            SET revoked_at = now(), revoke_reason = 'user deactivated'
          WHERE user_id = $1 AND revoked_at IS NULL
          RETURNING id`,
        [id],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'core.users',
        rowId: id,
        businessKey: before.username,
        dataClass: 'hr',
        before: { status: before.status },
        after: { status: 'deactivated', sessions_revoked: revoked.length },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        adminEvent('admin.user.deactivated', id, {
          userId: id,
          username: before.username,
          reason: body.reason,
          sessionsRevoked: revoked.length,
        }),
      );

      return { sessionsRevoked: revoked.length };
    });
  }

  async resetPassword(
    id: string,
    body: ResetPasswordRequest,
  ): Promise<{ readonly mustChangePassword: boolean }> {
    const ctx = getContext();

    const failures = this.passwords.validateStrength(body.newPassword);
    if (failures.length > 0) {
      throw AppError.validation(
        failures.map((message) => ({ path: 'newPassword', code: 'password_policy', message })),
      );
    }

    const hash = await this.passwords.hash(body.newPassword);

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const before = await tx.maybeOne<{ username: string; password_hash: string | null }>(
        `SELECT username, password_hash FROM core.users WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (before === undefined) throw AppError.notFound('The user');

      await tx.query(
        `UPDATE core.users
            SET password_hash = $2, password_changed_at = now(),
                must_change_password = $3, failed_attempts = 0, locked_until = NULL,
                version = version + 1, updated_by = $4, updated_at = now()
          WHERE id = $1`,
        [id, hash, body.mustChangePassword, ctx.userId],
      );

      // `docs/05`: password history 5. Keeping the *previous* hash is what makes
      // a reuse check possible later; the new one is already on the user row.
      if (before.password_hash !== null) {
        await tx.query(
          `INSERT INTO core.password_history (id, hospital_id, user_id, password_hash)
           VALUES ($1, $2, $3, $4)`,
          [newId(), ctx.hospitalId, id, before.password_hash],
        );
      }

      await tx.query(
        `UPDATE core.sessions
            SET revoked_at = now(), revoke_reason = 'password reset by administrator'
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [id],
      );

      // The hash never appears in the diff, in either direction:
      // DEFAULT_AUDIT_FIELD_POLICIES marks `password_hash` `exclude`, and the
      // audit table is the one table nobody can go back and clean up.
      await this.audit.write(tx, {
        action: 'update',
        entity: 'core.users',
        rowId: id,
        businessKey: before.username,
        dataClass: 'operational',
        before: { password_changed: false },
        after: { password_changed: true, must_change_password: body.mustChangePassword },
      });

      await this.outbox.publish(
        tx,
        adminEvent('admin.user.password_reset', id, {
          userId: id,
          username: before.username,
          initiatedBy: 'admin',
        }),
      );

      return { mustChangePassword: body.mustChangePassword };
    });
  }

  async assignRole(userId: string, body: AssignRoleRequest): Promise<readonly UserRoleAssignment[]> {
    const ctx = getContext();
    const userRoleId = newId();

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const user = await tx.maybeOne<{ username: string }>(
        `SELECT username FROM core.users WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
      );
      if (user === undefined) throw AppError.notFound('The user');

      const role = await this.loadAssignableRole(tx, body.roleId);
      await this.assertBranchAssignable(tx, body.branchId);

      const duplicate = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM core.user_roles
          WHERE user_id = $1 AND role_id = $2 AND branch_id IS NOT DISTINCT FROM $3 AND active`,
        [userId, body.roleId, body.branchId],
      );
      if (duplicate !== undefined) throw AppError.conflict('That role is already assigned for this branch.');

      await tx.query(
        `INSERT INTO core.user_roles (
           id, hospital_id, user_id, role_id, branch_id, scope, conditions,
           valid_from, valid_to, granted_by, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, '{}'::jsonb, COALESCE($7::timestamptz, now()), $8, $9, now())`,
        [
          userRoleId,
          ctx.hospitalId,
          userId,
          body.roleId,
          body.branchId,
          JSON.stringify(body.scope),
          body.validFrom ?? null,
          body.validTo ?? null,
          ctx.userId,
        ],
      );

      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'core.user_roles',
        rowId: userRoleId,
        businessKey: `${user.username}:${role.key}`,
        dataClass: 'operational',
        before: null,
        after: {
          user_id: userId,
          role_id: body.roleId,
          branch_id: body.branchId,
          valid_to: body.validTo ?? null,
        },
        reasonText: body.justification,
      });

      await this.outbox.publish(
        tx,
        adminEvent('admin.role.assigned', userRoleId, {
          userRoleId,
          userId,
          roleId: body.roleId,
          branchId: body.branchId,
          validFrom: body.validFrom ?? new Date().toISOString(),
          validTo: body.validTo ?? null,
          approvalId: null,
        }),
      );
    });

    return this.rolesFor(userId);
  }

  async revokeRole(
    userId: string,
    userRoleId: string,
    reason: string,
  ): Promise<readonly UserRoleAssignment[]> {
    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const grant = await tx.maybeOne<{ role_id: string; role_key: string; active: boolean }>(
        `SELECT ur.role_id, r.key AS role_key, ur.active
           FROM core.user_roles ur JOIN core.roles r ON r.id = ur.role_id
          WHERE ur.id = $1 AND ur.user_id = $2`,
        [userRoleId, userId],
      );
      if (grant === undefined) throw AppError.notFound('The role assignment');
      if (!grant.active) throw AppError.conflict('That role assignment is already revoked.');

      // Deactivated, never deleted: the grant is the evidence an access review
      // and a medico-legal enquiry both read (EN-007 §3.2.5).
      await tx.query(
        `UPDATE core.user_roles SET active = false, version = version + 1, updated_at = now() WHERE id = $1`,
        [userRoleId],
      );

      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'core.user_roles',
        rowId: userRoleId,
        businessKey: grant.role_key,
        dataClass: 'operational',
        before: { active: true },
        after: { active: false },
        reasonText: reason,
      });

      await this.outbox.publish(
        tx,
        adminEvent('admin.role.revoked', userRoleId, {
          userRoleId,
          userId,
          roleId: grant.role_id,
          reason,
        }),
      );
    });

    return this.rolesFor(userId);
  }

  // ── shared checks ─────────────────────────────────────────────────────────

  private async loadAssignableRole(
    tx: TransactionClient,
    roleId: string,
  ): Promise<{ id: string; key: string; sensitive_grant: boolean }> {
    const role = await tx.maybeOne<{ id: string; key: string; sensitive_grant: boolean }>(
      `SELECT id, key, sensitive_grant FROM core.roles WHERE id = $1 AND active`,
      [roleId],
    );
    // RLS lets a session read its own hospital's roles and the read-only system
    // templates, and nothing else — so a role id from another tenant is simply
    // absent here.
    if (role === undefined) throw AppError.notFound('The role');
    if (role.sensitive_grant) throw sensitiveGrantRefusal(role.key);
    return role;
  }

  private async assertBranchAssignable(tx: TransactionClient, branchId: string | null): Promise<void> {
    if (branchId === null) return;
    const branch = await tx.maybeOne<{ id: string }>(`SELECT id FROM core.branches WHERE id = $1`, [
      branchId,
    ]);
    if (branch === undefined) throw AppError.notFound('The branch');

    const ctx = getContext();
    if (ctx.grantedBranchIds.length > 0 && !ctx.grantedBranchIds.includes(branchId)) {
      throw new AppError(
        ProblemType.BRANCH_NOT_GRANTED,
        'You cannot grant a role in a branch you do not administer.',
      );
    }
  }
}

/**
 * Turns a Postgres unique-violation into a conflict the caller can act on.
 *
 * `23505` is the only class of insert failure here that is a *user* error; every
 * other one is ours and must keep its stack.
 */
export async function insertOrConflict(
  _tx: TransactionClient,
  message: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw AppError.conflict(message);
    }
    throw error;
  }
}

/** Family name first, matching how the name is rendered on documents (docs/06 §4.2). */
export function displayNameOf(input: {
  readonly name: { readonly given: string; readonly family: string; readonly prefix?: string | undefined };
}): string {
  const parts = [input.name.prefix, input.name.given, input.name.family].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return parts.join(' ');
}

/** The keys whose value actually moved. Used to keep audit diffs to changed columns. */
export function changedKeys<T extends Record<string, unknown>>(before: T, after: T): string[] {
  return Object.keys(after).filter((key) => before[key] !== after[key]);
}

export function pick<T extends Record<string, unknown>>(
  source: T,
  keys: readonly string[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) result[key] = source[key];
  return result;
}
