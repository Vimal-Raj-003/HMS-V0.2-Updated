import { Inject, Injectable } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { getContext } from '../../core/context/request-context.js';
import { MastersQueryService } from './masters.query.js';
import type { ListCashCountersQuery, ListQueuesQuery } from './masters.schemas.js';

/**
 * The two operational pickers that are not `mdm` tables: queue definitions
 * (`queue`, EN-006) and cash counters (`billing`, NC-001).
 *
 * They sit in this module because they are *masters* in the sense that matters
 * here — configured once, read on every screen load, never written by the
 * screens that read them — and because the alternative is a `GET` on the queue
 * console's own controller that duplicates the pagination and the projection.
 *
 * They are **not** effective-dated. Neither table carries `effective_from` /
 * `effective_to`; both use a plain `active` flag and a soft delete, and
 * inventing a version history for them here would be a lie about what the
 * database can prove. What the two lists share with the `mdm` ones is the
 * projection discipline: a picker sees what it needs to pick, and configuration
 * stays behind the permission that configures it.
 */

export interface QueueDefinitionListItem {
  readonly id: string;
  readonly branch_id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly stage_key: string | null;
  readonly department_key: string | null;
  readonly practitioner_key: string | null;
  readonly room_key: string | null;
  readonly service_key: string | null;
  readonly series_prefix: string;
  readonly calling_mode: string;
  readonly avg_service_sec_seed: number;
  readonly max_length: number | null;
  readonly allow_unpaid: boolean;
  readonly active: boolean;
}

export interface CashCounterListItem {
  readonly id: string;
  readonly branch_id: string;
  readonly code: string;
  readonly name: string;
  readonly location: string | null;
  readonly counter_type: string;
  readonly allowed_modes: readonly string[];
  readonly allowed_doc_types: readonly string[];
  readonly currency: string;
  readonly department_key: string | null;
  readonly is_virtual: boolean;
  readonly is_active: boolean;
}

@Injectable()
export class MastersOperationsService {
  constructor(@Inject(MastersQueryService) private readonly query: MastersQueryService) {}

  /**
   * `GET /queues` — the queues of a branch.
   *
   * Read with `queue.board.read`, which the receptionist, the calling clinician
   * and the TV display device all hold (`role-templates.ts` `QUEUE_DESK` /
   * `QUEUE_CALLER`). That key is defensible here only because of what the
   * projection leaves out: `priority_rules`, `skip_policy`, `member_refs`,
   * `display_config`, `fixed_hours` and the offline-block size are queue
   * *policy*, and reading them is `queue.config.manage`. What is returned is the
   * identity of the queue and the handful of facts a console needs to render a
   * chooser — which queue, whose, where, what its tokens look like.
   */
  async listQueues(q: ListQueuesQuery): Promise<Page<QueueDefinitionListItem>> {
    const branchId = q.branchId ?? getContext().branchId;
    return this.query.list<QueueDefinitionListItem>(
      {
        resource: 'queue.definitions',
        from: 'queue.queue_definitions m',
        alias: 'm',
        columns: `m.id, m.branch_id, m.code, m.name, m.kind::text AS kind, m.stage_key,
                  m.department_key, m.practitioner_key, m.room_key, m.service_key,
                  m.series_prefix, m.calling_mode::text AS calling_mode, m.avg_service_sec_seed,
                  m.max_length, m.allow_unpaid, m.active`,
        label: 'm.name',
        effectiveDated: false,
      },
      q,
      (bind) => {
        // A soft-deleted queue is gone as far as every screen is concerned; the
        // row survives only so that yesterday's tokens still resolve their
        // queue's name.
        const where: string[] = ['m.deleted_at IS NULL'];
        if (q.includeInactive !== true) where.push('m.active');
        if (branchId !== null) where.push(`m.branch_id = ${bind(branchId)}::uuid`);
        if (q.kind !== undefined) where.push(`m.kind = ${bind(q.kind)}::queue."QueueKind"`);
        if (q.departmentId !== undefined) where.push(`m.department_key = ${bind(q.departmentId)}::uuid`);
        if (q.practitionerId !== undefined)
          where.push(`m.practitioner_key = ${bind(q.practitionerId)}::uuid`);
        return where;
      },
    );
  }

  /**
   * `GET /cash/counters` — the counters a cashier may open a shift at.
   *
   * **On the permission.** There is no `receipt.counter.read` in the catalogue;
   * the only counter key is `receipt.counter.configure`, which is held by
   * Hospital and Branch Admin and by nobody who actually stands at a counter. So
   * this route is gated on `receipt.shift.open`, held by `CASHIER_BASE`.
   *
   * That is the same argument the catalogue already makes one line above it, for
   * `receipt.shift.list`: "a cashier cannot find their own open shift without
   * this — `.read` needs an id the cashier has no way to obtain, so the omission
   * did not restrict a sensitive action, it made the role's first action of the
   * day impossible." A cashier who cannot list counters cannot open a shift at
   * one either. The gap is reported rather than papered over by minting a key.
   *
   * The float limit, the drawer alert limit, the receipt series, the printer and
   * drawer profiles and the POS terminal id are **not** returned: those are
   * `receipt.counter.configure`'s business, and the drawer profile in particular
   * is the sort of thing that should not travel to every browser that opens the
   * cash screen.
   */
  async listCashCounters(q: ListCashCountersQuery): Promise<Page<CashCounterListItem>> {
    const branchId = q.branchId ?? getContext().branchId;
    return this.query.list<CashCounterListItem>(
      {
        resource: 'billing.cash_counters',
        from: 'billing.cash_counters m',
        alias: 'm',
        columns: `m.id, m.branch_id, m.code, m.name, m.location,
                  m.counter_type::text AS counter_type,
                  ARRAY(SELECT unnest(m.allowed_modes)::text) AS allowed_modes,
                  m.allowed_doc_types, m.currency, m.department_key, m.is_virtual, m.is_active`,
        label: 'm.name',
        effectiveDated: false,
      },
      q,
      (bind) => {
        const where: string[] = ['m.deleted_at IS NULL'];
        if (q.includeInactive !== true) where.push('m.is_active');
        if (branchId !== null) where.push(`m.branch_id = ${bind(branchId)}::uuid`);
        return where;
      },
    );
  }
}
