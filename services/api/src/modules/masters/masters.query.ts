import { Inject, Injectable } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { getContext } from '../../core/context/request-context.js';
import { DatabaseService } from '../../core/db/database.service.js';
import { CursorService } from '../../core/pagination/cursor.service.js';
import { currentTenantContext } from '../../core/tenancy/tenant-context.js';

/**
 * The one place a master list is turned into SQL.
 *
 * Every endpoint in EN-027's read half is the same query with a different
 * projection: "the rows of table X that are in effect at instant T, ordered by a
 * human label, keyset-paged". Writing that once rather than eleven times is not
 * only less code — it is the only way the two rules that are easy to get subtly
 * wrong (§2 effective dating, `docs/07` §4 no `OFFSET`) can be got wrong in
 * exactly one place, and therefore right in exactly one place.
 */

/** Appends a value to the parameter list and returns its `$n` placeholder. */
export type Bind = (value: unknown) => string;

export interface MasterListSpec {
  /** Binds the cursor to one list so it cannot be replayed against another. */
  readonly resource: string;
  /** `FROM` clause, alias included — e.g. `mdm.mdm_services m`. */
  readonly from: string;
  /** The alias used in `from`. */
  readonly alias: string;
  /** The projected columns, alias-qualified. Never `*`: see §5 of the brief. */
  readonly columns: string;
  /**
   * The sort key — a **text-typed, NOT NULL** expression. It is both the
   * `ORDER BY` and the cursor key, so the two cannot drift apart; making it text
   * is what lets `CursorService.keysetPage` round-trip it exactly.
   */
  readonly label: string;
  /** False for the operational tables (`queue`, `billing`) that carry no effective range. */
  readonly effectiveDated: boolean;
}

export interface MasterListRequest {
  readonly asOf?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

/**
 * "In effect at T", as a SQL predicate.
 *
 * The subtlety worth stating: a master row that has been replaced is not
 * deleted, it is left behind with `status = 'superseded'` and a closed
 * `effective_to`. A list that filtered on the range alone would return the old
 * row **and** its replacement side by side; a list that filtered on
 * `status = 'active'` alone would return a version whose range starts next
 * month. Both are wrong, and the second is the one that silently prices a
 * consultation from a tariff that has not started yet.
 *
 * So the predicate is always range + status, and the status set depends on the
 * question being asked:
 *
 *  - **now** (no `asOf`): only `active`. A row in effect at this instant is
 *    active by definition, and restricting to it lets Postgres use the partial
 *    indexes (`idx_mdm_areas_pincode_prefix`) and the leading columns of
 *    `(hospital_id, branch_id, status, effective_from)`.
 *  - **`asOf` in the past**: `active` *or* `superseded`. The row that was in
 *    effect in March has since been replaced, and excluding superseded rows
 *    would answer "what applied in March" with "nothing".
 *
 * `draft`, `pending_approval` and `retired` are never returned by either: an
 * unapproved master must not reach a picker, and a retired one is withdrawn.
 * The `btree_gist` exclusion constraint each table carries over
 * `(record_key, tstzrange(effective_from, effective_to)) WHERE status IN
 * ('active','superseded')` is what guarantees this returns **at most one
 * version per `record_key`** — the invariant is in the database, not here.
 */
export function effectivePredicate(alias: string, asOf: string | undefined, bind: Bind): string {
  if (asOf === undefined) {
    return (
      `${alias}.status = 'active' AND ${alias}.effective_from <= now() ` +
      `AND (${alias}.effective_to IS NULL OR ${alias}.effective_to > now())`
    );
  }
  const at = `${bind(asOf)}::timestamptz`;
  return (
    `${alias}.status IN ('active', 'superseded') AND ${alias}.effective_from <= ${at} ` +
    `AND (${alias}.effective_to IS NULL OR ${alias}.effective_to > ${at})`
  );
}

/**
 * Strips the LIKE metacharacters from a free-text search term.
 *
 * The term is a bound parameter, so this is not an injection control — it is a
 * correctness one: a stray `%` typed into a doctor picker would otherwise widen
 * the pattern instead of matching a literal per cent sign, and `\` would consume
 * the following character.
 */
export function likeTerm(value: string): string {
  return value.replace(/[\\%_]/g, '');
}

@Injectable()
export class MastersQueryService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  /**
   * Runs one master list.
   *
   * `filters` receives the binder and returns extra `WHERE` fragments, so a
   * caller can add predicates without ever concatenating a value into SQL —
   * `docs/04` §6.
   *
   * There is deliberately **no `hospital_id` predicate** anywhere in here. RLS
   * supplies it (`tenant_isolation` on every `mdm`, `queue` and `billing`
   * table), and adding a second one in the application would mean an isolation
   * test could pass while the policy was missing.
   */
  async list<T extends { readonly id: string }>(
    spec: MasterListSpec,
    request: MasterListRequest,
    filters: (bind: Bind) => readonly string[] = () => [],
  ): Promise<Page<T>> {
    const hospitalId = getContext().hospitalId ?? '';
    const limit = this.cursors.pageSize(request.limit);
    const after = this.cursors.start(request.cursor, { hospitalId, resource: spec.resource });

    const values: unknown[] = [];
    const bind: Bind = (value) => `$${values.push(value)}`;

    const where: string[] = [];
    if (spec.effectiveDated) where.push(effectivePredicate(spec.alias, request.asOf, bind));
    where.push(...filters(bind));
    if (after !== null) {
      // Ascending keyset on `(label, id)`. The tuple comparison is what makes
      // pages non-overlapping when two rows share a label — without the `id`
      // tie-break, a page boundary that falls between two identically-named
      // rows either repeats one or drops one.
      where.push(`(${spec.label}, ${spec.alias}.id) > (${bind(after.k[0])}, ${bind(after.id)}::uuid)`);
    }

    const sql = `SELECT ${spec.columns}, ${spec.label} AS cursor_key
                   FROM ${spec.from}
                  ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
                  ORDER BY ${spec.label} ASC, ${spec.alias}.id ASC
                  LIMIT ${bind(limit + 1)}`;

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      // `pg` types a row as an index signature, and `T` is a type parameter, so
      // the compiler cannot see that the projection matches. The cast is
      // confined to this one line — every caller above it is fully typed.
      const fetched = (await tx.rows(sql, values)) as unknown as readonly (T & {
        readonly cursor_key: string;
      })[];
      return this.cursors.keysetPage<T>(fetched, limit, {
        hospitalId,
        resource: spec.resource,
        direction: 'asc',
      });
    });
  }
}
