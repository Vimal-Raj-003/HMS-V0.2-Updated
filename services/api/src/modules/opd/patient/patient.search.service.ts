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
 * ── Why the prefix modes are ranges and not `LIKE` (D-37) ───────────────────
 *
 * Routing to the right index is necessary and was not sufficient. Under
 * row-level security PostgreSQL refuses to evaluate a **non-leakproof**
 * qualifier ahead of the policy's own qualifier, because a leaky operator could
 * reveal — through an error, or through how long it took — the contents of a row
 * the policy was about to hide. Mechanically (`restriction_is_securely_promotable`
 * in `optimizer/util/restrictinfo.c`) such a clause is rejected as an *index*
 * condition and demoted to a heap filter.
 *
 * `~~` (LIKE) and `%` (`pg_trgm`) are not leakproof. So `mobile_local LIKE 'x%'`
 * entered `idx_patients_mobile_prefix` on `hospital_id` only and filtered every
 * row of the tenant: 101 ms over 176 000 patients, and over a second at the
 * three million `OP-001` §13 plans for. `=` is leakproof, which is why the exact
 * modes were always fine and the defect looked like a partial one.
 *
 * The bytewise pattern comparators **are** leakproof — `text_pattern_ge` (`~>=~`)
 * and `text_pattern_lt` (`~<~`), the same operators the planner itself derives
 * from a prefix `LIKE` in `prefix_quals()`, and exactly the ordering that
 * `varchar_pattern_ops` indexes. Writing them out by hand gets the index
 * condition back without touching a single policy:
 *
 *   mobile_local ~>=~ '894555865' AND mobile_local ~<~ '894555866'
 *
 * `[prefix, nextPrefix)` under bytewise ordering is *exactly* the set of strings
 * beginning with `prefix` — not an approximation — so this is a rewrite, not a
 * widening. The `LIKE` is nevertheless kept alongside it, so that correctness
 * never depends on the bound arithmetic in `prefixUpperBound()`; see there.
 *
 * Measured as `hms_app` with a complete tenant context on the 220 000-row
 * `volume` seed (176 000 in the tenant):
 *
 *   mobile prefix      103.7 ms  →  0.04 ms   (idx_patients_mobile_prefix)
 *   UHID prefix         82.2 ms  →  0.04 ms   (idx_patients_uhid_prefix)
 *   identifier prefix   49.4 ms  →  0.04 ms   (idx_identifiers_value_prefix)
 *
 * ── The one mode this does not fix: `name_trigram` ──────────────────────────
 *
 * There is no leakproof way to drive a trigram index. Of the eight operators
 * `gin_trgm_ops` supports (`%`, `%>`, `%>>`, `~~`, `~~*`, `~`, `~*`, `=`) only
 * `=` is leakproof, and equality on a whole name is not a name search. A name
 * search therefore still filters the tenant's rows (148 ms here). Restructuring
 * the policy does not help — that was measured too, and the reason is that
 * `restriction_is_securely_promotable` looks only at the *query's* clause, never
 * at the policy's shape. The only remaining lever is marking `similarity_op`
 * `LEAKPROOF`, which is a superuser action and a deliberate information-leak
 * trade-off; it belongs in an ADR and in the database bootstrap, not here. See
 * `docs/DECISIONS.md` D-37.
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
 * A prefix probe on `uhid_normalised varchar_pattern_ops` is the only form that
 * index serves, and it covers the exact case too — a complete UHID is a prefix
 * of itself and the column is unique per hospital, so the probe returns one row.
 * `prefixPredicate` writes it as the leakproof bytewise range that survives
 * row-level security; the `LIKE` it also emits is escaped rather than
 * interpolated, because a `%` typed at the desk would otherwise turn a bounded
 * prefix scan into a full one.
 */
function uhidSearch(raw: string, bind: (value: unknown) => string): ResolvedSearch {
  const normalised = normaliseUhid(raw);
  if (normalised.length === 0) {
    throw AppError.validation([{ path: 'uhid', code: 'empty', message: 'That is not a UHID.' }]);
  }
  return {
    mode: 'uhid_prefix',
    predicate: prefixPredicate('p.uhid_normalised', normalised, bind),
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
      `WHERE i.deleted_at IS NULL AND ${prefixPredicate('i.value_normalised', normalised, bind)})`,
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
    predicate: prefixPredicate('p.mobile_local', local, bind),
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

/**
 * The exclusive upper bound of a prefix under **bytewise** (`C`-collation)
 * ordering — the ordering `varchar_pattern_ops` indexes and `~<~` compares in.
 *
 * `null` means "no bound could be derived safely", and the caller falls back to
 * the `LIKE` alone. That is a performance fallback, never a correctness one.
 *
 * The rule is deliberately narrower than PostgreSQL's own `make_greater_string`:
 * a bound is derived only for printable ASCII whose last character is below
 * `~`, where incrementing one code unit is unambiguous and stays inside ASCII.
 * Every prefix that reaches here is already the output of a normaliser —
 * `[A-Z0-9]` for UHID, `[A-Z0-9@.]` for identifiers, `[0-9]` for mobile — so the
 * narrow rule covers every real input, and a future normaliser that starts
 * emitting Devanagari degrades to a filter rather than guessing at a bound.
 */
export function prefixUpperBound(prefix: string): string | null {
  if (prefix.length === 0) return null;
  if (!/^[ -}]*$/.test(prefix)) return null; // printable ASCII, last char below `~`
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

/**
 * The prefix predicate, in the only form that keeps its index under RLS.
 *
 * Emits the leakproof half-open range that the planner would have derived from
 * the `LIKE` itself if it were allowed to (see the file header), **and** the
 * `LIKE`. The `LIKE` is redundant — `[prefix, upper)` bytewise is exactly the
 * set of strings starting with `prefix` — and it is kept anyway, because it
 * costs a filter over the handful of rows the range already returned and it
 * means a mistake in `prefixUpperBound()` can only ever cost speed, never show a
 * receptionist a patient who does not match what they typed. Verified: the
 * plan is still `Index Scan using idx_patients_mobile_prefix` with the `LIKE`
 * present.
 */
export function prefixPredicate(column: string, prefix: string, bind: (value: unknown) => string): string {
  const upper = prefixUpperBound(prefix);
  const parts = [`${column} ~>=~ ${bind(prefix)}`];
  if (upper !== null) parts.push(`${column} ~<~ ${bind(upper)}`);
  parts.push(`${column} LIKE ${bind(`${escapeLike(prefix)}%`)}`);
  return parts.join(' AND ');
}
