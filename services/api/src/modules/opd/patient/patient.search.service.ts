import { Inject, Injectable } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService } from '../../../core/db/database.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import {
  abhaNumberVariants,
  normaliseAbhaAddress,
  normaliseIdentifierValue,
  normaliseMobile,
  normaliseUhid,
} from './patient.identity.js';
import type { SearchPatientsQuery } from './patient.schemas.js';
import type { PatientListItem } from './patient.types.js';

/**
 * MPI search — OP-001 §6 `GET /patients?q=&mobile=&uhid=&abha=`, §13's 200 ms
 * p95 over three million records.
 *
 * **This file is a routing table, not a query.** The Phase-1 migration built
 * purpose-shaped indexes for this one endpoint — exact mobile, mobile prefix
 * (`varchar_pattern_ops`), UHID prefix, name trigram, two partial ABHA indexes
 * and an identifier-value prefix — and a single query of the form
 *
 *   WHERE uhid = $1 OR mobile LIKE $2 OR full_name % $3 OR abha_number = $4
 *
 * would use none of them: PostgreSQL cannot satisfy a disjunction across four
 * columns from four indexes without a bitmap union it will usually decline in
 * favour of a sequential scan — over the one table in the hospital that reaches
 * millions of rows, on the screen with the tightest latency budget. So the
 * caller's input is *classified* into exactly one mode, and each mode is one
 * predicate against one index.
 *
 * When more than one parameter is sent the most selective wins:
 * `uhid` › `identifier` › `abha` › `mobile` › `q`. Silently ANDing them would
 * look helpful and would defeat the index of whichever one lost.
 *
 * ── A limitation this routing cannot fix on its own ─────────────────────────
 *
 * `patient.integration.spec.ts` puts each predicate to the planner at thirty
 * thousand rows, and the answer splits in two:
 *
 *  * The **equality** modes — exact mobile, ABHA number, ABHA address — become
 *    index conditions under row-level security, as intended.
 *  * The **pattern** modes — mobile prefix, UHID prefix, name trigram — do not.
 *    `~~` (LIKE) and `%` (pg_trgm) are not marked leakproof in `pg_proc`, and
 *    PostgreSQL will not evaluate a non-leakproof qualifier ahead of an RLS
 *    qualifier, because a leaky operator could reveal through an error or a
 *    timing difference the contents of a row the policy was about to hide. They
 *    therefore arrive as heap filters and the index is unreachable; the same
 *    query with the policy out of the way uses the index perfectly.
 *
 * At the three million rows `OP-001` §13 plans for, that is a sequential scan
 * on the hospital's busiest screen. The fix is outside this module — mark the
 * pattern operators `LEAKPROOF` (a deliberate trade-off only a superuser can
 * make), or restructure the policy so the tenant predicate folds to a constant
 * at plan time. The routing below is still the right shape and becomes correct
 * the moment that lands, which is why it is not contorted around the defect.
 */

const RESOURCE = 'opd.patients';

/**
 * Below this a trigram index has nothing to match on: `pg_trgm` decomposes a
 * string into three-character windows, so a two-character query produces no
 * usable trigram and `%` degenerates into a scan. Rather than quietly running
 * that scan, the caller is told to type another character.
 */
const MIN_TRIGRAM_LENGTH = 3;

export type SearchMode =
  | 'recent'
  | 'uhid_prefix'
  | 'abha_number'
  | 'abha_address'
  | 'mobile_exact'
  | 'mobile_prefix'
  | 'identifier_prefix'
  | 'name_trigram';

export interface ResolvedSearch {
  readonly mode: SearchMode;
  /** One parameterised predicate, served by one index. */
  readonly predicate: string;
}

@Injectable()
export class PatientSearchService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  async search(query: SearchPatientsQuery): Promise<Page<PatientListItem>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource: RESOURCE });

    const values: unknown[] = [];
    const bind = (value: unknown): string => `$${values.push(value)}`;
    const resolved = resolveSearch(query, bind);

    const where: string[] = ['p.deleted_at IS NULL', resolved.predicate];

    // Merged and inactive records stay findable on the *identifier* paths, and
    // only there. OP-001 §3.8 requires the losing UHID of a merge to keep
    // resolving — "victim UHID becomes alias (searchable, redirect)" — so a card
    // printed before the merge still works at the desk, and the response carries
    // `merged_into_id` for the redirect. A name search asks a different question
    // ("who is this person?") and answering it with three merged shadows of one
    // patient is noise; that path also uses the partial index that covers active
    // rows only, so widening it would cost the index as well as the clarity.
    const identifierPath = resolved.mode !== 'name_trigram' && resolved.mode !== 'recent';
    if (!query.includeInactive && !identifierPath) {
      where.push(`p.status = 'active'`);
    }

    if (after !== null) {
      where.push(`(p.created_at, p.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
    }

    // One order for every mode, so a cursor means the same thing whichever path
    // minted it and `(hospital_id, created_at DESC, id DESC)` serves the
    // tiebreak. Relevance ranking is deliberately not the sort: a similarity
    // -ordered keyset would have to carry the score in the cursor and would
    // reshuffle mid-scroll as rows are edited, and what a receptionist actually
    // wants at the top of a name search is the person registered most recently.
    const sql = `SELECT p.id, p.uhid, p.full_name, p.gender::text AS gender, p.dob,
                        p.dob_is_estimated, p.age_years, p.mobile,
                        p.category::text AS category, p.status::text AS status,
                        p.merged_into_id, p.branch_id, p.last_visit_at,
                        p.registered_at, p.created_at, p.created_at::text AS cursor_key
                   FROM patient.patients p
                  WHERE ${where.join(' AND ')}
                  ORDER BY p.created_at DESC, p.id DESC
                  LIMIT ${bind(limit + 1)}`;

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const fetched = await tx.rows<PatientListItem & { cursor_key: string }>(sql, values);
      const page = this.cursors.keysetPage<PatientListItem>(fetched, limit, {
        hospitalId,
        resource: RESOURCE,
        direction: 'desc',
      });

      // A patient search is a PHI read and `docs/04` audits it. The count and
      // the *mode* are recorded, never the search term or the identifiers
      // returned — a search term is itself PHI (`docs/04` §7), and an audit
      // table full of patient names is the leak the audit exists to detect.
      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'patient.patients',
        rowId: null,
        businessKey: null,
        dataClass: 'phi',
        before: null,
        after: null,
        rowCount: page.items.length,
        reasonCode: `search:${resolved.mode}`,
      });

      return page;
    });
  }
}

/**
 * Classifies the request into exactly one indexed predicate.
 *
 * Exported for its unit test: this is the function in the module whose mistakes
 * are invisible (a wrong branch still returns *some* rows) and expensive (a
 * wrong branch scans the MPI).
 */
export function resolveSearch(
  query: Pick<SearchPatientsQuery, 'q' | 'mobile' | 'uhid' | 'abha' | 'identifier'>,
  bind: (value: unknown) => string,
): ResolvedSearch {
  if (query.uhid !== undefined) return uhidSearch(query.uhid, bind);
  if (query.identifier !== undefined) return identifierSearch(query.identifier, bind);
  if (query.abha !== undefined) return abhaSearch(query.abha, bind);
  if (query.mobile !== undefined) return mobileSearch(query.mobile, bind);
  if (query.q !== undefined) return freeTextSearch(query.q, bind);

  // No criteria: the recent-patients list (`phase-01` §1.2), which is the keyset
  // order itself.
  return { mode: 'recent', predicate: 'true' };
}

/**
 * UHID is printed as `BLRA00000123` and typed as `blra 123` or `00000123`.
 *
 * `LIKE 'x%'` on `uhid_normalised varchar_pattern_ops` is the only form that
 * index serves, and it covers the exact case too — a complete UHID is a prefix
 * of itself and the column is unique per hospital, so the probe returns one row.
 * The input is escaped rather than interpolated: a `%` typed at the desk would
 * otherwise turn a bounded prefix scan into a full one.
 */
function uhidSearch(raw: string, bind: (value: unknown) => string): ResolvedSearch {
  const normalised = normaliseUhid(raw);
  if (normalised.length === 0) {
    throw AppError.validation([{ path: 'uhid', code: 'empty', message: 'That is not a UHID.' }]);
  }
  return {
    mode: 'uhid_prefix',
    predicate: `p.uhid_normalised LIKE ${bind(`${escapeLike(normalised)}%`)}`,
  };
}

/**
 * Passport, insurance member number, corporate employee id, legacy MRN — every
 * `patient.identifiers` row, through `idx_identifiers_value_prefix`.
 *
 * A semi-join rather than a join or an `OR`: the inner scan is the identifier
 * index and the outer lookup is the patients primary key, which is two index
 * probes. `IN (SELECT …)` also cannot duplicate a patient who holds two
 * matching identifiers, which an inner join would.
 *
 * Aadhaar has no row in that table, so it cannot be found this way — which is
 * the intended behaviour, not an omission.
 */
function identifierSearch(raw: string, bind: (value: unknown) => string): ResolvedSearch {
  const normalised = normaliseIdentifierValue(raw);
  if (normalised.length === 0) {
    throw AppError.validation([{ path: 'identifier', code: 'empty', message: 'That is not an identifier.' }]);
  }
  return {
    mode: 'identifier_prefix',
    predicate:
      `p.id IN (SELECT i.patient_id FROM patient.identifiers i ` +
      `WHERE i.deleted_at IS NULL AND i.value_normalised LIKE ${bind(`${escapeLike(normalised)}%`)})`,
  };
}

function abhaSearch(raw: string, bind: (value: unknown) => string): ResolvedSearch {
  if (raw.includes('@')) {
    return {
      mode: 'abha_address',
      predicate: `p.abha_address IS NOT NULL AND p.abha_address = ${bind(normaliseAbhaAddress(raw))}`,
    };
  }
  return {
    mode: 'abha_number',
    predicate: `p.abha_number IS NOT NULL AND p.abha_number = ANY(${bind(abhaNumberVariants(raw))}::varchar[])`,
  };
}

/**
 * A full national number is probed exactly on `mobile` (E.164); a partial one
 * gets the prefix index on `mobile_local`.
 *
 * The split matters: the exact probe is what a scanner, a caller ID and an SMS
 * reply produce and it is an index equality, while the prefix probe is what the
 * receptionist's third keystroke needs.
 */
function mobileSearch(raw: string, bind: (value: unknown) => string): ResolvedSearch {
  const { e164, local } = normaliseMobile(raw);
  if (local.length >= 10) {
    return { mode: 'mobile_exact', predicate: `p.mobile = ${bind(e164)}` };
  }
  return {
    mode: 'mobile_prefix',
    predicate: `p.mobile_local LIKE ${bind(`${escapeLike(local)}%`)}`,
  };
}

/**
 * The single search box (`F3` in OP-001 §8), which accepts anything.
 *
 * Classification is by shape, and each shape lands on the predicate its
 * dedicated parameter would have used:
 *
 *   contains `@`            → ABHA address
 *   ≥ 12 digits             → ABHA number (a mobile is at most 10 nationally)
 *   digits only             → mobile, exact or prefix
 *   letters **and** digits  → UHID prefix
 *   letters only            → name trigram
 */
function freeTextSearch(raw: string, bind: (value: unknown) => string): ResolvedSearch {
  const trimmed = raw.trim();

  if (trimmed.includes('@')) return abhaSearch(trimmed, bind);
  if (/^[0-9\s+-]+$/.test(trimmed)) {
    const digits = trimmed.replace(/[^0-9]/g, '');
    if (digits.length >= 12) return abhaSearch(trimmed, bind);
    return mobileSearch(trimmed, bind);
  }
  if (/[0-9]/.test(trimmed) && /[A-Za-z]/.test(trimmed)) return uhidSearch(trimmed, bind);

  if (trimmed.length < MIN_TRIGRAM_LENGTH) {
    throw AppError.validation([
      {
        path: 'q',
        code: 'too_short_for_name_search',
        message: `Type at least ${MIN_TRIGRAM_LENGTH} characters of the name, or search by mobile or UHID.`,
      },
    ]);
  }

  // `full_name % $1` is the only form the GIN trigram index serves. `%` uses
  // `pg_trgm.similarity_threshold` (0.3 by default), which is looser than the
  // 0.6 the *duplicate* rule uses — surfacing a near miss in a search is
  // helpful, blocking a registration on one is not.
  return { mode: 'name_trigram', predicate: `p.full_name % ${bind(trimmed)}` };
}

/**
 * `LIKE` treats `%`, `_` and `\` as syntax. A UHID or mobile fragment containing
 * one is a typo, but an un-escaped `%` turns a bounded prefix scan into a scan
 * of the whole index — so it is escaped rather than rejected.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
