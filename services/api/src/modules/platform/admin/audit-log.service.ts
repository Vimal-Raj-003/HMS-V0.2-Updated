import { Inject, Injectable } from '@nestjs/common';
import { auditActionSchema, auditSearchQuerySchema, type Page } from '@vims/contracts';
import type { z } from 'zod';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';

export type AuditSearchQuery = z.infer<typeof auditSearchQuerySchema>;

const RESOURCE = 'admin.audit';

export interface AuditEntry {
  readonly id: string;
  readonly occurred_at: Date;
  readonly actor_user_id: string | null;
  readonly actor_role: string | null;
  readonly impersonator_user_id: string | null;
  readonly entity: string;
  readonly row_id: string | null;
  readonly business_key: string | null;
  readonly action: string;
  readonly patient_id: string | null;
  readonly data_class: string;
  readonly sensitivity: string;
  readonly result: string;
  readonly denial_reason: string | null;
  readonly reason_code: string | null;
  readonly reason_text: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly changed_fields: readonly string[];
  readonly row_count: number | null;
  readonly trace_id: string | null;
  readonly api_route: string | null;
  readonly sealed_at: Date | null;
}

/**
 * The audit viewer (EN-007 §3.6 over EN-024 §6).
 *
 * Three things this deliberately does **not** do:
 *
 *  - It has no write path, and never will. `EN-024 §12` is explicit: "No role
 *    can update or delete audit entries — the permission does not exist." The
 *    database agrees — `_grants` revokes UPDATE and DELETE on `core.audit_log`
 *    from the application role, and a trigger raises on either.
 *  - It does not offer a lookup by id alone. `core.audit_log` is partitioned by
 *    `occurred_at`, so an id-only lookup scans every partition; the search
 *    always carries a time window and prunes.
 *  - It does not skip rows to reach a page. Keyset on `(occurred_at, id)`
 *    descending, which is also the shape of the table's primary index.
 *
 * And one thing it does that reads oddly for a GET: it writes an audit row of
 * its own. `EN-024 §5`: "Audit reads are themselves audited when they touch
 * PHI-bearing entries" — looking up who opened a patient's chart is itself an
 * access event, and the catalogue marks `admin.audit.read` as `phiRead`.
 */
@Injectable()
export class AuditLogService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  async search(query: AuditSearchQuery): Promise<Page<AuditEntry>> {
    const hospitalId = getContext().hospitalId ?? '';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource: RESOURCE });

    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      throw AppError.validation([
        { path: 'from', code: 'range_inverted', message: 'The start of the range is after its end.' },
      ]);
    }

    const where: string[] = [];
    const values: unknown[] = [];
    const bind = (value: unknown): string => `$${values.push(value)}`;

    if (query.from !== undefined) where.push(`a.occurred_at >= ${bind(query.from)}::timestamptz`);
    if (query.to !== undefined) where.push(`a.occurred_at <= ${bind(query.to)}::timestamptz`);
    if (query.userId !== undefined) where.push(`a.actor_user_id = ${bind(query.userId)}::uuid`);
    if (query.patientId !== undefined) where.push(`a.patient_id = ${bind(query.patientId)}::uuid`);
    if (query.entity !== undefined) where.push(`a.entity = ${bind(query.entity)}`);
    if (query.rowId !== undefined) where.push(`a.row_id = ${bind(query.rowId)}::uuid`);
    if (query.businessKey !== undefined) where.push(`a.business_key = ${bind(query.businessKey)}`);
    if (query.action !== undefined) {
      // The action column is an enum; an unparseable value would otherwise
      // surface as a Postgres cast error rather than a field error.
      const action = auditActionSchema.safeParse(query.action);
      if (!action.success) {
        throw AppError.validation([
          { path: 'action', code: 'unknown_action', message: `"${query.action}" is not an audit action.` },
        ]);
      }
      where.push(`a.action = ${bind(action.data)}::core."AuditActionType"`);
    }
    if (query.breakGlassOnly === true) where.push(`a.action = 'break_glass'::core."AuditActionType"`);
    if (query.impersonatedOnly === true) where.push('a.impersonator_user_id IS NOT NULL');
    if (query.deniedOnly === true) where.push(`a.result = 'denied'::core."AuditResult"`);
    if (query.q !== undefined && query.q.length > 0) {
      where.push(`a.reason_text ILIKE ${bind(`%${query.q}%`)}`);
    }
    if (after !== null) {
      where.push(`(a.occurred_at, a.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
    }

    const sql = `SELECT a.id, a.occurred_at, a.actor_user_id, a.actor_role, a.impersonator_user_id,
                        a.entity, a.row_id, a.business_key, a.action::text AS action, a.patient_id,
                        a.data_class::text AS data_class, a.sensitivity::text AS sensitivity,
                        a.result::text AS result, a.denial_reason, a.reason_code, a.reason_text,
                        a.before, a.after, a.changed_fields, a.row_count, a.trace_id, a.api_route,
                        a.sealed_at, a.occurred_at::text AS cursor_key
                   FROM core.audit_log a
                  ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
                  ORDER BY a.occurred_at DESC, a.id DESC
                  LIMIT ${bind(limit + 1)}`;

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const fetched = await tx.rows<AuditEntry & { cursor_key: string }>(sql, values);
      const page = this.cursors.keysetPage<AuditEntry>(fetched, limit, {
        hospitalId,
        resource: RESOURCE,
        direction: 'desc',
      });

      // `EN-024 §3.2.5`: record the count and the filter, never the identifiers
      // the search returned. Writing 50 patient ids into the audit table to
      // record that somebody looked at 50 rows would multiply the exposure the
      // log exists to detect.
      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'core.audit_log',
        rowId: null,
        businessKey: null,
        dataClass: 'phi',
        before: null,
        after: null,
        rowCount: page.items.length,
        reasonText: describeFilter(query),
      });

      return page;
    });
  }
}

/**
 * A one-line, identifier-free description of what was searched for.
 *
 * The filter is evidence — "who went looking for this patient's record?" is a
 * question a Privacy Officer asks — but the *values* are not recorded, because a
 * patient id in the reason text of an audit row is the same disclosure the row
 * is meant to be evidence of.
 */
export function describeFilter(query: AuditSearchQuery): string {
  const used = (
    [
      ['patient', query.patientId],
      ['user', query.userId],
      ['entity', query.entity],
      ['row', query.rowId],
      ['action', query.action],
      ['businessKey', query.businessKey],
      ['from', query.from],
      ['to', query.to],
      ['text', query.q],
      ['breakGlassOnly', query.breakGlassOnly === true ? 'yes' : undefined],
      ['impersonatedOnly', query.impersonatedOnly === true ? 'yes' : undefined],
      ['deniedOnly', query.deniedOnly === true ? 'yes' : undefined],
    ] as const
  )
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name);

  return used.length === 0 ? 'audit search: no filter' : `audit search filtered by ${used.join(', ')}`;
}
