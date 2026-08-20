import { Inject, Injectable } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';

const RESOURCE = 'admin.branches';

export interface BranchListItem {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly short_name: string;
  readonly kind: string;
  readonly status: string;
  readonly parent_branch_id: string | null;
  readonly timezone: string;
  readonly currency: string;
  readonly bed_count: number;
  readonly module_profile: string;
  readonly colour_token: string;
  readonly go_live_at: Date | null;
  readonly created_at: Date;
}

export interface BranchDetail extends BranchListItem {
  readonly address: unknown;
  readonly state_code: string | null;
  readonly gstin: string | null;
  readonly working_hours: unknown;
  readonly hfr_id: string | null;
  readonly rohini_id: string | null;
  readonly residency_zone: string;
  readonly serves_from_branch_id: string | null;
  readonly version: number;
  /** Whether the calling session is granted a role in this branch (EN-041 §3.7). */
  readonly granted_to_caller: boolean;
}

/**
 * Branches, read-only (EN-041 §6 `org.read`).
 *
 * Creating, suspending and closing a branch is `org.branch.manage` and carries a
 * whole onboarding workflow (EN-041 §3.9) — a wizard, a config clone and a
 * go-live smoke test that includes an RLS-isolation check. Shipping a bare
 * `POST /branches` that skips all of it would let somebody create a live branch
 * that has never been proved isolated, so the write half waits for the workflow.
 *
 * `core.branches` has no `branch_id` column of its own, so the RLS policy is the
 * plain tenant one: an administrator sees every branch of their hospital, which
 * is what the branch picker and the role-assignment screen both need.
 */
@Injectable()
export class BranchesService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  async list(cursor: string | undefined, requestedLimit: number): Promise<Page<BranchListItem>> {
    const hospitalId = getContext().hospitalId ?? '';
    const limit = this.cursors.pageSize(requestedLimit);
    const after = this.cursors.start(cursor, { hospitalId, resource: RESOURCE });

    const values: unknown[] = [];
    const bind = (value: unknown): string => `$${values.push(value)}`;
    const keyset =
      after === null
        ? ''
        : `AND (b.created_at, b.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`;

    const sql = `SELECT b.id, b.code, b.name, b.short_name, b.kind::text AS kind, b.status::text AS status,
                        b.parent_branch_id, b.timezone, b.currency, b.bed_count,
                        b.module_profile::text AS module_profile, b.colour_token, b.go_live_at, b.created_at,
                        b.created_at::text AS cursor_key
                   FROM core.branches b
                  WHERE true ${keyset}
                  ORDER BY b.created_at DESC, b.id DESC
                  LIMIT ${bind(limit + 1)}`;

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const fetched = await tx.rows<BranchListItem & { cursor_key: string }>(sql, values);
      return this.cursors.keysetPage<BranchListItem>(fetched, limit, {
        hospitalId,
        resource: RESOURCE,
        direction: 'desc',
      });
    });
  }

  async get(id: string): Promise<BranchDetail> {
    const ctx = getContext();
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const branch = await tx.maybeOne<Omit<BranchDetail, 'granted_to_caller'>>(
        `SELECT b.id, b.code, b.name, b.short_name, b.kind::text AS kind, b.status::text AS status,
                b.parent_branch_id, b.serves_from_branch_id, b.timezone, b.currency, b.bed_count,
                b.module_profile::text AS module_profile, b.colour_token, b.go_live_at, b.created_at,
                b.address, b.state_code, b.gstin, b.working_hours, b.hfr_id, b.rohini_id,
                b.residency_zone, b.version
           FROM core.branches b
          WHERE b.id = $1`,
        [id],
      );
      // Another hospital's branch id is filtered out by RLS, so it arrives here
      // as absent and leaves as a 404 — never a 403, which would confirm it
      // exists (docs/09 §3.1 case 2).
      if (branch === undefined) throw AppError.notFound('The branch');

      return { ...branch, granted_to_caller: ctx.grantedBranchIds.includes(id) };
    });
  }
}
