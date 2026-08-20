import { Inject, Injectable } from '@nestjs/common';
import {
  PERMISSION_CATALOGUE,
  ProblemType,
  SEGREGATION_OF_DUTIES_RULES,
  createRoleRequestSchema,
  isRegisteredPermission,
  newId,
  updateRoleRequestSchema,
  type Page,
  type PermissionDefinition,
  type SodRule,
} from '@vims/contracts';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { adminEvent } from './admin.events.js';

export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

const RESOURCE = 'admin.roles';

export interface RoleListItem {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly template_key: string | null;
  readonly home_workspace: string;
  readonly category: string;
  readonly is_system: boolean;
  readonly sensitive_grant: boolean;
  readonly version: number;
  readonly active: boolean;
  readonly created_at: Date;
  readonly assigned_users: number;
}

export interface RoleDetail extends RoleListItem {
  readonly abac_defaults: unknown;
  readonly permissions: readonly string[];
}

/**
 * The permission catalogue as the matrix editor needs it.
 *
 * It is served from `PERMISSION_CATALOGUE` in code, not from `core.permissions`,
 * and that is deliberate: `docs/DECISIONS` D-26 makes the code the author of the
 * catalogue and the database a verified copy. Serving the copy would let a drift
 * that `PermissionRegistryService` is meant to fail the boot on instead show up
 * as a matrix editor offering keys no route can ever check.
 */
export interface PermissionCatalogueModule {
  readonly module: string;
  readonly permissions: readonly PermissionDefinition[];
}

export interface PermissionCatalogueResponse {
  readonly modules: readonly PermissionCatalogueModule[];
  /** `docs/05` §Segregation of duties — shown inline in the editor as warnings. */
  readonly segregationOfDuties: readonly SodRule[];
  readonly total: number;
}

export function groupPermissionsByModule(
  catalogue: readonly PermissionDefinition[],
): readonly PermissionCatalogueModule[] {
  const byModule = new Map<string, PermissionDefinition[]>();
  for (const permission of catalogue) {
    const bucket = byModule.get(permission.module);
    if (bucket === undefined) byModule.set(permission.module, [permission]);
    else bucket.push(permission);
  }
  return [...byModule.entries()]
    .map(([module, permissions]) => ({ module, permissions }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

/**
 * `EN-007 §3.3.1`: "modules cannot use unregistered keys". A role may not grant
 * one either — `core.role_permissions` has a foreign key to `core.permissions`,
 * so an unknown key would fail deep inside an INSERT with a constraint name for
 * a message. Checking here turns that into a field error on the right input.
 */
export function unregisteredPermissions(keys: readonly string[]): readonly string[] {
  return keys.filter((key) => !isRegisteredPermission(key));
}

/**
 * `docs/05`: "Segregation of duties enforced in policy: creator ≠ approver …".
 * `EN-007 §3.3.4` puts the same rules on the *role*: a role holding both halves
 * of a conflicting pair hands one person both ends of a control.
 */
export interface SodFinding {
  readonly permA: string;
  readonly permB: string;
  readonly mode: 'warn' | 'block';
  readonly reason: string;
}

export function sodFindings(keys: readonly string[], rules: readonly SodRule[] = SEGREGATION_OF_DUTIES_RULES): readonly SodFinding[] {
  const held = new Set(keys);
  return rules.filter((rule) => held.has(rule.permA) && held.has(rule.permB));
}

@Injectable()
export class RolesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  catalogue(): PermissionCatalogueResponse {
    return {
      modules: groupPermissionsByModule(PERMISSION_CATALOGUE),
      segregationOfDuties: SEGREGATION_OF_DUTIES_RULES,
      total: PERMISSION_CATALOGUE.length,
    };
  }

  async list(cursor: string | undefined, requestedLimit: number): Promise<Page<RoleListItem>> {
    const hospitalId = getContext().hospitalId ?? '';
    const limit = this.cursors.pageSize(requestedLimit);
    const after = this.cursors.start(cursor, { hospitalId, resource: RESOURCE });

    const values: unknown[] = [];
    const bind = (value: unknown): string => `$${values.push(value)}`;
    const keyset =
      after === null ? '' : `AND (r.created_at, r.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`;

    const sql = `SELECT r.id, r.key, r.name, r.description, r.template_key, r.home_workspace,
                        r.category, r.is_system, r.sensitive_grant, r.version, r.active, r.created_at,
                        r.created_at::text AS cursor_key,
                        (SELECT count(*)::int FROM core.user_roles ur
                          WHERE ur.role_id = r.id AND ur.active) AS assigned_users
                   FROM core.roles r
                  WHERE true ${keyset}
                  ORDER BY r.created_at DESC, r.id DESC
                  LIMIT ${bind(limit + 1)}`;

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      // No hospital predicate: the RLS policy on `core.roles` is the mixed one —
      // this hospital's custom roles plus the read-only system templates whose
      // `hospital_id` is NULL. Writing the predicate by hand would either
      // duplicate that or, more likely, get the template half wrong.
      const fetched = await tx.rows<RoleListItem & { cursor_key: string }>(sql, values);
      return this.cursors.keysetPage<RoleListItem>(fetched, limit, {
        hospitalId,
        resource: RESOURCE,
        direction: 'desc',
      });
    });
  }

  async get(id: string): Promise<RoleDetail & { readonly segregationOfDuties: readonly SodFinding[] }> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const role = await tx.maybeOne<Omit<RoleDetail, 'permissions'>>(
        `SELECT r.id, r.key, r.name, r.description, r.template_key, r.home_workspace,
                r.category, r.is_system, r.sensitive_grant, r.version, r.active, r.created_at,
                r.abac_defaults,
                (SELECT count(*)::int FROM core.user_roles ur
                  WHERE ur.role_id = r.id AND ur.active) AS assigned_users
           FROM core.roles r
          WHERE r.id = $1`,
        [id],
      );
      if (role === undefined) throw AppError.notFound('The role');

      const rows = await tx.rows<{ permission_key: string }>(
        `SELECT permission_key FROM core.role_permissions WHERE role_id = $1 ORDER BY permission_key`,
        [id],
      );
      const permissions = rows.map((r) => r.permission_key);

      return { ...role, permissions, segregationOfDuties: sodFindings(permissions) };
    });
  }

  async create(body: CreateRoleRequest): Promise<RoleDetail> {
    const ctx = getContext();
    const id = newId();

    this.assertPermissionsRegistered(body.permissions);

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const clash = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM core.roles WHERE key = $1 AND hospital_id = $2`,
        [body.key, ctx.hospitalId],
      );
      if (clash !== undefined) throw AppError.conflict('A role with that key already exists.');

      await tx.query(
        `INSERT INTO core.roles (
           id, hospital_id, key, name, description, template_key, abac_defaults,
           home_workspace, category, is_system, version, active, created_by, updated_by, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'custom', false, 1, true, $9, $9, now())`,
        [
          id,
          ctx.hospitalId,
          body.key,
          body.name,
          body.description,
          body.templateKey ?? null,
          JSON.stringify(body.abacDefaults),
          body.homeWorkspace,
          ctx.userId,
        ],
      );

      for (const key of body.permissions) {
        await tx.query(
          `INSERT INTO core.role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, key],
        );
      }

      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'core.roles',
        rowId: id,
        businessKey: body.key,
        dataClass: 'operational',
        before: null,
        after: { key: body.key, name: body.name, permissions: body.permissions },
      });

      await this.outbox.publish(
        tx,
        adminEvent('admin.role.created', id, {
          roleId: id,
          key: body.key,
          clonedFromTemplate: body.templateKey ?? null,
        }),
      );
    });

    return this.get(id);
  }

  async update(id: string, body: UpdateRoleRequest): Promise<RoleDetail> {
    const ctx = getContext();
    if (body.permissions !== undefined) this.assertPermissionsRegistered(body.permissions);

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const before = await tx.maybeOne<{
        key: string;
        name: string;
        description: string;
        home_workspace: string;
        version: number;
        is_system: boolean;
        hospital_id: string | null;
      }>(
        `SELECT key, name, description, home_workspace, version, is_system, hospital_id
           FROM core.roles WHERE id = $1`,
        [id],
      );
      if (before === undefined) throw AppError.notFound('The role');

      // `EN-007 §3.3.2` seeds the 64 role templates read-only. RLS would reject
      // the write anyway (the WITH CHECK on the mixed policy requires
      // `hospital_id = ANY(accessible)`), but a constraint error is a worse
      // explanation than a sentence.
      if (before.is_system || before.hospital_id === null) {
        throw AppError.conflict('System role templates are read-only. Clone the template and edit the copy.');
      }
      if (before.version !== body.version) {
        throw new AppError(
          ProblemType.OPTIMISTIC_LOCK_CONFLICT,
          'This role was changed by somebody else while you were editing.',
          { nextAction: 'Reload the role and reapply your change.' },
        );
      }

      const existing = await tx.rows<{ permission_key: string }>(
        `SELECT permission_key FROM core.role_permissions WHERE role_id = $1`,
        [id],
      );
      const held = existing.map((r) => r.permission_key);
      const target = body.permissions ?? held;
      const added = target.filter((k) => !held.includes(k));
      const removed = held.filter((k) => !target.includes(k));

      await tx.query(
        `UPDATE core.roles
            SET name = COALESCE($2, name),
                description = COALESCE($3, description),
                home_workspace = COALESCE($4, home_workspace),
                abac_defaults = COALESCE($5::jsonb, abac_defaults),
                version = version + 1, updated_by = $6, updated_at = now()
          WHERE id = $1`,
        [
          id,
          body.name ?? null,
          body.description ?? null,
          body.homeWorkspace ?? null,
          body.abacDefaults === undefined ? null : JSON.stringify(body.abacDefaults),
          ctx.userId,
        ],
      );

      if (removed.length > 0) {
        await tx.query(
          `DELETE FROM core.role_permissions WHERE role_id = $1 AND permission_key = ANY($2::text[])`,
          [id, removed],
        );
      }
      for (const key of added) {
        await tx.query(
          `INSERT INTO core.role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [id, key],
        );
      }

      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'core.roles',
        rowId: id,
        businessKey: before.key,
        dataClass: 'operational',
        before: { name: before.name, description: before.description, permissions: held },
        after: { name: body.name ?? before.name, description: body.description ?? before.description, permissions: target },
        reasonText: body.reason,
      });

      // `EN-007 §5`: "role edits … re-evaluate sessions (permission cache
      // invalidation via Redis pub/sub within 5 s)". This event is what carries
      // that instruction; the added/removed lists let a consumer invalidate
      // precisely rather than flushing every session in the hospital.
      await this.outbox.publish(
        tx,
        adminEvent('admin.role.updated', id, {
          roleId: id,
          key: before.key,
          version: before.version + 1,
          added,
          removed,
        }),
      );
    });

    return this.get(id);
  }

  private assertPermissionsRegistered(keys: readonly string[]): void {
    const unknown = unregisteredPermissions(keys);
    if (unknown.length === 0) return;
    throw AppError.validation(
      unknown.map((key) => ({
        path: 'permissions',
        code: 'unregistered_permission',
        message: `"${key}" is not in the permission catalogue, so no route could ever check it.`,
      })),
    );
  }
}
