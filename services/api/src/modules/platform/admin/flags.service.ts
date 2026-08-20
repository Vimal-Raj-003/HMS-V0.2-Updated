import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, putFeatureFlagRequestSchema } from '@vims/contracts';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { adminEvent } from './admin.events.js';
import {
  checkFlagToggle,
  resolveFlags,
  scopeOfFlag,
  type FlagRow,
  type ResolvedFlag,
} from './entitlements.logic.js';
import { LicenceService } from './licence.service.js';

export type PutFeatureFlagRequest = z.infer<typeof putFeatureFlagRequestSchema>;

/**
 * EN-007 §3.7 — feature flags, gated by the licence.
 *
 * The load-bearing rule is `EN-007 §14 AC-14`: "Given a module not in the
 * licence, when an admin toggles its flag, then the toggle is blocked with an
 * upgrade message **and no event is emitted**." Emitting the event anyway would
 * tell every downstream consumer the module is on while the entitlement check
 * still says no — a split-brain that is far harder to diagnose than a refusal.
 *
 * The list read is `admin.flags.configure` rather than a separate read key
 * because EN-007 §6 assigns that one key to both `GET` and `PUT /flags`; there
 * is no `admin.flags.read` in the catalogue to use instead, and inventing one
 * would fail the boot check.
 */
@Injectable()
export class FlagsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(LicenceService) private readonly licence: LicenceService,
  ) {}

  async list(): Promise<{ readonly items: readonly ResolvedFlag[] }> {
    const entitlements = await this.licence.entitlements();
    const rows = await this.db.withTenant(currentTenantContext(), (tx) =>
      tx.rows<FlagRow>(
        `SELECT id, key, hospital_id, branch_id, role_key, user_id, enabled,
                rollout_pct, expires_at, note, updated_at
           FROM core.feature_flags`,
      ),
    );
    return { items: resolveFlags(rows, entitlements, new Date()) };
  }

  async put(key: string, body: PutFeatureFlagRequest): Promise<ResolvedFlag> {
    const ctx = getContext();

    const entitlements = await this.licence.entitlements();
    const verdict = checkFlagToggle(key, body.enabled, entitlements);
    if (!verdict.ok) {
      throw new AppError(ProblemType.NOT_LICENSED, verdict.reason, {
        ...(verdict.upgradeCta === null ? {} : { nextAction: verdict.upgradeCta }),
      });
    }

    const branchId = body.branchId ?? null;
    const roleKey = body.roleKey ?? null;
    const userId = body.userId ?? null;

    await this.db.withTenant(currentTenantContext(), async (tx) => {
      // `core.feature_flags` has no unique index over the nullable scope tuple,
      // so the upsert is an explicit update-then-insert inside the transaction
      // rather than an ON CONFLICT that has nothing to conflict on.
      const existing = await tx.maybeOne<{ id: string; enabled: boolean }>(
        `SELECT id, enabled FROM core.feature_flags
          WHERE key = $1
            AND branch_id IS NOT DISTINCT FROM $2
            AND role_key IS NOT DISTINCT FROM $3
            AND user_id IS NOT DISTINCT FROM $4
          FOR UPDATE`,
        [key, branchId, roleKey, userId],
      );

      const id = existing?.id ?? newId();
      if (existing === undefined) {
        await tx.query(
          `INSERT INTO core.feature_flags (
             id, key, hospital_id, branch_id, role_key, user_id, enabled,
             rollout_pct, expires_at, note, created_by, updated_by, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, now())`,
          [
            id,
            key,
            ctx.hospitalId,
            branchId,
            roleKey,
            userId,
            body.enabled,
            body.rolloutPct ?? null,
            body.expiresAt ?? null,
            body.note ?? null,
            ctx.userId,
          ],
        );
      } else {
        await tx.query(
          `UPDATE core.feature_flags
              SET enabled = $2, rollout_pct = $3, expires_at = $4, note = $5,
                  updated_by = $6, updated_at = now()
            WHERE id = $1`,
          [id, body.enabled, body.rolloutPct ?? null, body.expiresAt ?? null, body.note ?? null, ctx.userId],
        );
      }

      await this.audit.write(tx, {
        action: 'config_change',
        entity: 'core.feature_flags',
        rowId: id,
        businessKey: key,
        dataClass: 'operational',
        before: existing === undefined ? null : { enabled: existing.enabled },
        after: { enabled: body.enabled, rollout_pct: body.rolloutPct ?? null },
        reasonText: body.note ?? ctx.reason,
      });

      await this.outbox.publish(
        tx,
        adminEvent('admin.flag.changed', id, {
          key,
          enabled: body.enabled,
          scope: scopeOfFlag({
            id,
            key,
            hospital_id: ctx.hospitalId,
            branch_id: branchId,
            role_key: roleKey,
            user_id: userId,
            enabled: body.enabled,
            rollout_pct: body.rolloutPct ?? null,
            expires_at: null,
            note: null,
            updated_at: null,
          }),
        }),
      );
    });

    const refreshed = (await this.list()).items.find((flag) => flag.key === key);
    if (refreshed === undefined) throw AppError.notFound('The feature flag');
    return refreshed;
  }
}
