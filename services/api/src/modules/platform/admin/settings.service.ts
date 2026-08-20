import { Inject, Injectable } from '@nestjs/common';
import {
  ProblemType,
  SETTING_DEFINITIONS,
  newId,
  putSettingRequestSchema,
  type SettingDefinition,
  type SettingScope,
} from '@vims/contracts';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { adminEvent } from './admin.events.js';
import {
  checkSettingWrite,
  maskIfSecret,
  resolveEffectiveSetting,
  type EffectiveSetting,
  type SettingRow,
} from './settings.logic.js';

export type PutSettingRequest = z.infer<typeof putSettingRequestSchema>;

export interface SettingsQuery {
  readonly module?: string | undefined;
  readonly q?: string | undefined;
  readonly branchId?: string | undefined;
  readonly departmentId?: string | undefined;
  readonly userId?: string | undefined;
}

const definitionsByKey = new Map<string, SettingDefinition>(SETTING_DEFINITIONS.map((d) => [d.key, d]));

/**
 * EN-007 §3.1.2 — the settings registry.
 *
 * The **definitions** come from `packages/contracts`, not from
 * `core.setting_definitions`. The table is a synced copy the seed writes (the
 * application role has no INSERT on it, by design — `_grants` revokes it so a
 * compromised service cannot invent a setting), and reading the copy rather than
 * the source would let a stale seed present the admin console with keys nothing
 * in the code reads.
 *
 * The **values** come from `core.settings` under RLS. Nothing here filters by
 * `hospital_id`: the policy does that, so a settings screen cannot accidentally
 * show another tenant's configuration.
 */
@Injectable()
export class SettingsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /**
   * The declarations alone, for the admin form renderer.
   *
   * Definitions are static, identical for every tenant, and contain no values —
   * a secret key's *definition* is public, only its value is not — so this is
   * not a tenant read and does not write an audit row.
   */
  definitions(): readonly Omit<EffectiveSetting, 'value' | 'source' | 'updatedAt' | 'updatedBy' | 'masked'>[] {
    return SETTING_DEFINITIONS.map((d) => ({
      key: d.key,
      module: d.module,
      label: d.label,
      description: d.description,
      scopes: d.scopes,
      sensitivity: d.sensitivity,
      requiresApproval: d.requiresApproval,
      dualControl: d.dualControl,
      defaultValue: maskIfSecret(d, d.defaultValue).value,
    }));
  }

  async effective(query: SettingsQuery): Promise<{ readonly items: readonly EffectiveSetting[] }> {
    const ctx = getContext();
    const scope = {
      branchId: query.branchId ?? ctx.branchId,
      departmentId: query.departmentId ?? null,
      userId: query.userId ?? null,
    };

    const definitions = SETTING_DEFINITIONS.filter((d) => {
      if (query.module !== undefined && d.module !== query.module) return false;
      if (query.q !== undefined && query.q.length > 0) {
        const needle = query.q.toLowerCase();
        return d.key.toLowerCase().includes(needle) || d.label.toLowerCase().includes(needle);
      }
      return true;
    });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await tx.rows<SettingRow>(
        `SELECT key, branch_id, department_id, user_id, value, updated_at, updated_by
           FROM core.settings
          WHERE key = ANY($1::text[])`,
        [definitions.map((d) => d.key)],
      );

      const items = definitions.map((d) => resolveEffectiveSetting(d, rows, scope));

      // Configuration is not PHI, but who read the hospital's configuration is
      // part of the admin change log EN-024 §3.3 keeps for eight years.
      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'core.settings',
        rowId: null,
        businessKey: null,
        dataClass: 'operational',
        before: null,
        after: null,
        rowCount: items.length,
      });

      return { items };
    });
  }

  async put(body: PutSettingRequest): Promise<EffectiveSetting> {
    const ctx = getContext();
    const definition = definitionsByKey.get(body.key);
    const reason = body.reason ?? ctx.reason;

    const check = checkSettingWrite({ definition, scope: body.scope, value: body.value, reason });
    if (!check.ok) {
      switch (check.code) {
        case 'unknown_key':
        case 'scope_not_allowed':
        case 'invalid_value':
          throw AppError.validation([{ path: check.code === 'invalid_value' ? 'value' : 'key', code: check.code, message: check.message }]);
        case 'needs_approval':
          throw new AppError(ProblemType.APPROVAL_REQUIRED, check.message, {
            nextAction: 'Raise an access request so a second administrator can approve the change.',
          });
        case 'reason_required':
          throw new AppError(ProblemType.BREAK_GLASS_REASON_REQUIRED, check.message, {
            nextAction: 'Send the change again with a reason.',
          });
        default:
          throw new AppError(ProblemType.INTERNAL_ERROR, 'Unhandled settings write outcome.');
      }
    }

    // Narrowed by `check.ok`; the definition is present whenever the check passed.
    const declared = definition as SettingDefinition;
    const columns = scopeColumns(body.scope, body.scopeId, ctx.branchId);

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      const before = await tx.maybeOne<{ id: string; value: unknown }>(
        `SELECT id, value FROM core.settings
          WHERE key = $1
            AND branch_id IS NOT DISTINCT FROM $2
            AND department_id IS NOT DISTINCT FROM $3
            AND user_id IS NOT DISTINCT FROM $4`,
        [body.key, columns.branchId, columns.departmentId, columns.userId],
      );

      if (before === undefined) {
        await tx.query(
          `INSERT INTO core.settings (
             id, hospital_id, branch_id, department_id, user_id, key, value,
             created_by, updated_by, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8, now())`,
          [
            newId(),
            ctx.hospitalId,
            columns.branchId,
            columns.departmentId,
            columns.userId,
            body.key,
            JSON.stringify(check.value),
            ctx.userId,
          ],
        );
      } else {
        await tx.query(
          `UPDATE core.settings
              SET value = $2::jsonb, version = version + 1, updated_by = $3, updated_at = now()
            WHERE id = $1`,
          [before.id, JSON.stringify(check.value), ctx.userId],
        );
      }

      // The diff is masked by the same rule the response is: a secret must not
      // be recoverable from the audit log, which is the one table nobody can go
      // back and clean up (EN-024 §3.1.4).
      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'core.settings',
        rowId: before?.id ?? null,
        businessKey: body.key,
        dataClass: 'operational',
        before: { value: maskIfSecret(declared, before?.value ?? declared.defaultValue).value },
        after: { value: maskIfSecret(declared, check.value).value },
        reasonText: reason,
      });

      await this.outbox.publish(
        tx,
        adminEvent('admin.settings.changed', ctx.hospitalId ?? '', {
          key: body.key,
          scope: body.scope,
          scopeId: body.scopeId,
          sensitive: declared.sensitivity !== 'normal',
        }),
      );
    });

    const refreshed = await this.effectiveOne(declared, columns);
    return refreshed;
  }

  private async effectiveOne(
    definition: SettingDefinition,
    columns: { branchId: string | null; departmentId: string | null; userId: string | null },
  ): Promise<EffectiveSetting> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const rows = await tx.rows<SettingRow>(
        `SELECT key, branch_id, department_id, user_id, value, updated_at, updated_by
           FROM core.settings WHERE key = $1`,
        [definition.key],
      );
      return resolveEffectiveSetting(definition, rows, columns);
    });
  }
}

/**
 * Maps a requested scope onto the three nullable scope columns.
 *
 * A branch-scoped setting written with no `scopeId` uses the branch the
 * administrator is acting in, because the alternative — writing NULL — would
 * silently create a *hospital*-wide setting instead, which is the most expensive
 * kind of quiet mistake this table can produce.
 */
export function scopeColumns(
  scope: SettingScope,
  scopeId: string | null,
  actingBranchId: string | null,
): { branchId: string | null; departmentId: string | null; userId: string | null } {
  switch (scope) {
    case 'hospital':
      return { branchId: null, departmentId: null, userId: null };
    case 'branch':
      return { branchId: scopeId ?? actingBranchId, departmentId: null, userId: null };
    case 'department':
      return { branchId: actingBranchId, departmentId: scopeId, userId: null };
    case 'user':
      return { branchId: null, departmentId: null, userId: scopeId };
    default:
      return { branchId: null, departmentId: null, userId: null };
  }
}
