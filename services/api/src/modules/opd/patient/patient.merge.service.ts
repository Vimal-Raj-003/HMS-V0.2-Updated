import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { patientEvent } from './patient.events.js';
import type { DedupeQueueQuery, MergeRequest, UnmergeRequest } from './patient.schemas.js';
import type { DedupeCandidateItem, MergePreview, MergeResult, UnmergeResult } from './patient.types.js';

/**
 * The MRD dedupe queue and the merge — OP-001 §3.8, §5 and §14 AC-11.
 *
 * A merge is the most dangerous operation in this module and possibly in the
 * product: it takes two clinical records and declares them one person. Get it
 * wrong and one patient's allergies, results and prescriptions are attached to
 * another patient's timeline, and every downstream module has already been told
 * to re-point. Five properties make that survivable, and each one is a
 * deliberate cost paid here.
 *
 * **Two steps, on the same comparison.** `step: 'prepare'` writes a `pending`
 * merge row carrying a full snapshot of *both* records as they are at that
 * instant, and returns it. `step: 'commit'` names that row by id. The officer is
 * therefore confirming the specific comparison they were shown; a record that
 * changed in between cannot be merged unseen, and the snapshot is what an
 * enquiry reads years later. OP-001 §5: "Merge only by MRD role with 2-step
 * confirm."
 *
 * **The victim UHID is never reissued and never disappears.** The losing record
 * survives with `status = 'merged'` and `merged_into_id` set; the migration
 * revokes DELETE on `patient.patients` so it could not be removed even by
 * mistake. A card printed before the merge still resolves at the desk, and the
 * search returns it with the pointer to follow (§3.8: "victim UHID becomes
 * alias (searchable, redirect)").
 *
 * **Every row moved is written down.** `patient.merge_repoints` records the
 * table, the count and the individual row ids. That list is not bookkeeping —
 * it is the instruction set an unmerge replays in reverse. Without it, "reverse
 * the merge" would mean guessing which of the survivor's contacts used to belong
 * to the victim.
 *
 * **The event carries both ids and the victim UHID.** `patient.merged` is the
 * only notice every other module gets that a patient_id it holds is now stale;
 * OP-001 §5 gives them five minutes. The UHID travels with it because a module
 * that keyed on the human identifier — a printed label, an external interface —
 * needs it too.
 *
 * **Reversible for thirty days.** `unmerge_deadline` is stored, not computed at
 * read time, so shortening the policy later cannot retroactively strand a merge
 * somebody was told they could reverse.
 */

const RESOURCE = 'opd.patients.dedupe';

/** OP-001 §3.8: "Unmerge within 30 days if wrong (approval by MRD head)." */
const UNMERGE_WINDOW_DAYS = 30;

/**
 * The tables this module owns and therefore moves itself.
 *
 * Everything else — visits, bills, orders, results — belongs to another module,
 * and `docs/01` §3 forbids reaching into another module's tables. They act on
 * `patient.merged` and acknowledge into `patient.merge_repoints` themselves,
 * which is what makes the five-minute SLA measurable rather than assumed.
 *
 * `patient.demographic_history` is **not** in this list and cannot be: the
 * migration revokes UPDATE on it. That is correct — the history of the victim's
 * demographics belongs to the victim's record, and rewriting it to point at the
 * survivor would falsify who was edited.
 */
const OWNED_TABLES = ['identifiers', 'contacts', 'alerts', 'allergies'] as const;

interface MergePartyRow {
  readonly id: string;
  readonly uhid: string;
  readonly status: string;
  readonly full_name: string;
  readonly gender: string;
  readonly dob_text: string | null;
  readonly mobile: string;
  readonly abha_number: string | null;
  readonly branch_id: string;
  readonly registered_at: Date;
  readonly allergy_statement: string;
  readonly version: number;
}

interface MergeRow {
  readonly id: string;
  readonly survivor_id: string;
  readonly victim_id: string;
  readonly survivor_uhid: string;
  readonly victim_uhid: string;
  readonly status: string;
  readonly reason: string;
  readonly requested_at: Date;
  readonly unmerge_deadline: Date;
}

@Injectable()
export class PatientMergeService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
  ) {}

  // ── the review queue ──────────────────────────────────────────────────────

  /**
   * OP-001 §6 `GET /patients/dedupe` — the MRD worklist.
   *
   * Ordered by score descending, which is the order the officer should work it
   * in and the order `idx_dedupe_candidates_open` is built for. The keyset is
   * the full `(score, created_at, id)` tuple rather than `created_at` alone,
   * because two candidates can share a score and a millisecond and one of them
   * would otherwise be skipped between pages.
   */
  async dedupeQueue(query: DedupeQueueQuery): Promise<Page<DedupeCandidateItem>> {
    const ctx = getContext();
    const hospitalId = ctx.hospitalId ?? '';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource: RESOURCE });

    const values: unknown[] = [];
    const bind = (value: unknown): string => `$${values.push(value)}`;
    const where: string[] = [
      `d.status = ${bind(query.status)}::patient."PatientDedupeStatus"`,
      `d.score >= ${bind(query.minScore.toFixed(3))}::numeric`,
    ];

    if (after !== null) {
      where.push(
        `(d.score, d.created_at, d.id) < ` +
          `(${bind(after.k[0])}::numeric, ${bind(after.k[1])}::timestamptz, ${bind(after.id)}::uuid)`,
      );
    }

    const sql = `SELECT d.id, d.patient_a_id, d.patient_b_id,
                        a.uhid AS patient_a_uhid, a.full_name AS patient_a_name,
                        b.uhid AS patient_b_uhid, b.full_name AS patient_b_name,
                        d.score::text AS score, d.rule_hits, d.detected_by,
                        d.status::text AS status, d.reviewed_by, d.reviewed_at,
                        d.merge_id, d.created_at,
                        d.score::text AS cursor_score, d.created_at::text AS cursor_key
                   FROM patient.dedupe_candidates d
                   JOIN patient.patients a ON a.id = d.patient_a_id
                   JOIN patient.patients b ON b.id = d.patient_b_id
                  WHERE ${where.join(' AND ')}
                  ORDER BY d.score DESC, d.created_at DESC, d.id DESC
                  LIMIT ${bind(limit + 1)}`;

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const fetched = await tx.rows<
        DedupeCandidateItem & { readonly cursor_score: string; readonly cursor_key: string }
      >(sql, values);

      const page = this.cursors.page(fetched, limit, {
        hospitalId,
        resource: RESOURCE,
        direction: 'desc',
        sortKeys: (row) => [row.cursor_score, row.cursor_key],
      });

      await this.audit.write(tx, {
        action: 'read_phi',
        entity: 'patient.dedupe_candidates',
        rowId: null,
        businessKey: null,
        dataClass: 'phi',
        before: null,
        after: null,
        rowCount: page.items.length,
      });

      return {
        items: page.items.map(({ cursor_score: _s, cursor_key: _k, ...rest }) => rest),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    });
  }

  // ── merge ─────────────────────────────────────────────────────────────────

  async merge(body: MergeRequest): Promise<MergePreview | MergeResult> {
    return body.step === 'prepare' ? this.prepare(body) : this.commit(body.mergeId);
  }

  /**
   * Step one. Writes the `pending` merge row with both snapshots and returns the
   * impact. Nothing is re-pointed and no patient row moves.
   */
  private async prepare(body: Extract<MergeRequest, { step: 'prepare' }>): Promise<MergePreview> {
    const ctx = getContext();
    const mergeId = newId();

    if (body.survivorId === body.victimId) {
      throw AppError.conflict('A record cannot be merged into itself.');
    }

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const survivor = await this.loadParty(tx, body.survivorId, 'survivor');
      const victim = await this.loadParty(tx, body.victimId, 'victim');

      const impact = await this.countOwnedRows(tx, victim.id);
      const requestedAt = new Date();
      const deadline = new Date(requestedAt.getTime() + UNMERGE_WINDOW_DAYS * 86_400_000);

      await tx.query(
        `INSERT INTO patient.merges
           (id, hospital_id, survivor_id, victim_id, survivor_uhid, victim_uhid, status, reason,
            survivor_snapshot, victim_snapshot, field_choices, requested_by, requested_at,
            unmerge_deadline, details, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7,
                 $8::jsonb, $9::jsonb, $10::jsonb, $11, $12, $13, $14::jsonb, $11, now())`,
        [
          mergeId,
          ctx.hospitalId,
          survivor.id,
          victim.id,
          survivor.uhid,
          victim.uhid,
          body.reason,
          JSON.stringify(survivor),
          JSON.stringify(victim),
          JSON.stringify(body.fieldChoices),
          ctx.userId,
          requestedAt,
          deadline,
          JSON.stringify({ impact }),
        ],
      );

      // A prepared merge is a fact about who proposed what, and it is the row an
      // enquiry reads if the merge is later disputed — so it is audited even
      // though nothing has moved yet. `approve` rather than `update`: this is the
      // request half of a two-step approval, not a change to a record.
      await this.audit.write(tx, {
        action: 'approve',
        entity: 'patient.merges',
        rowId: mergeId,
        businessKey: `${survivor.uhid}<-${victim.uhid}`,
        dataClass: 'phi',
        patientId: victim.id,
        before: null,
        after: {
          step: 'prepare',
          survivor_id: survivor.id,
          victim_id: victim.id,
          victim_uhid: victim.uhid,
          impact,
        },
        reasonText: body.reason,
      });

      return {
        mergeId,
        status: 'pending',
        survivorId: survivor.id,
        survivorUhid: survivor.uhid,
        victimId: victim.id,
        victimUhid: victim.uhid,
        reason: body.reason,
        unmergeDeadline: deadline,
        impact,
      };
    });
  }

  /**
   * Step two. Moves the rows this module owns, marks the victim, and announces
   * the merge — all in one transaction, so a module that reacts to the event
   * cannot see a half-merged pair.
   */
  private async commit(mergeId: string): Promise<MergeResult> {
    const ctx = getContext();

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const merge = await tx.maybeOne<MergeRow>(
        `SELECT id, survivor_id, victim_id, survivor_uhid, victim_uhid, status::text AS status,
                reason, requested_at, unmerge_deadline
           FROM patient.merges WHERE id = $1 FOR UPDATE`,
        [mergeId],
      );
      if (merge === undefined) throw AppError.notFound('The merge');
      if (merge.status !== 'pending') {
        throw new AppError(
          ProblemType.ALREADY_DECIDED,
          `This merge is already ${merge.status}. Prepare a new one if the records still need merging.`,
        );
      }

      // Both rows are locked before anything moves, in **uuid order** rather
      // than survivor-then-victim, so two officers committing overlapping merges
      // serialise instead of deadlocking on each other's first lock.
      const lockOrder =
        merge.survivor_id < merge.victim_id
          ? [merge.survivor_id, merge.victim_id]
          : [merge.victim_id, merge.survivor_id];
      const parties = new Map<string, MergePartyRow>();
      for (const partyId of lockOrder) {
        parties.set(
          partyId,
          await this.loadParty(tx, partyId, partyId === merge.survivor_id ? 'survivor' : 'victim', true),
        );
      }

      const victimRow = parties.get(merge.victim_id);
      const survivorRow = parties.get(merge.survivor_id);
      if (victimRow === undefined || survivorRow === undefined) throw AppError.notFound('The patient');

      if (victimRow.status !== 'active') {
        throw AppError.conflict(
          `The record being merged away is ${victimRow.status}, not active. It may already have been merged.`,
        );
      }
      if (survivorRow.status !== 'active') {
        throw AppError.conflict(
          `The surviving record is ${survivorRow.status}, not active. Merging into it would hide both records.`,
        );
      }

      const repointed = await this.repoint(tx, mergeId, merge.victim_id, merge.survivor_id);

      await tx.query(
        `UPDATE patient.patients
            SET status = 'merged', merged_into_id = $2, merged_at = now(),
                version = version + 1, updated_by = $3, updated_at = now()
          WHERE id = $1`,
        [merge.victim_id, merge.survivor_id, ctx.userId],
      );

      const mergedAt = new Date();
      await tx.query(
        `UPDATE patient.merges
            SET status = 'completed', merged_by = $2, merged_at = $3,
                details = details || $4::jsonb, version = version + 1, updated_at = now()
          WHERE id = $1`,
        [mergeId, ctx.userId, mergedAt, JSON.stringify({ repointed })],
      );

      // Any open dedupe candidate for this pair is now answered.
      await tx.query(
        `UPDATE patient.dedupe_candidates
            SET status = 'merged', reviewed_by = $3, reviewed_at = now(), merge_id = $4,
                version = version + 1, updated_at = now()
          WHERE status = 'open'
            AND patient_a_id = LEAST($1::uuid, $2::uuid)
            AND patient_b_id = GREATEST($1::uuid, $2::uuid)`,
        [merge.survivor_id, merge.victim_id, ctx.userId, mergeId],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'patient.merges',
        rowId: mergeId,
        businessKey: `${merge.survivor_uhid}<-${merge.victim_uhid}`,
        dataClass: 'phi',
        patientId: merge.victim_id,
        before: { status: 'pending', victim_status: 'active' },
        after: {
          status: 'completed',
          victim_status: 'merged',
          survivor_id: merge.survivor_id,
          victim_id: merge.victim_id,
          victim_uhid: merge.victim_uhid,
          repointed,
        },
        reasonText: merge.reason,
      });

      // Both ids **and** the victim UHID: every module holding a patient_id has
      // to re-point, and one that keyed on the printed identifier needs that too.
      await this.outbox.publish(
        tx,
        patientEvent('patient.merged', merge.survivor_id, {
          survivorId: merge.survivor_id,
          victimId: merge.victim_id,
          victimUhid: merge.victim_uhid,
          mergedBy: ctx.userId,
          mergedAt: mergedAt.toISOString(),
        }),
      );

      return {
        mergeId,
        status: 'completed',
        survivorId: merge.survivor_id,
        survivorUhid: merge.survivor_uhid,
        victimId: merge.victim_id,
        victimUhid: merge.victim_uhid,
        reason: merge.reason,
        unmergeDeadline: merge.unmerge_deadline,
        mergedAt,
        impact: repointed,
        repointed,
      };
    });
  }

  // ── unmerge ───────────────────────────────────────────────────────────────

  /**
   * OP-001 §3.8 / §14 AC-11 — reverse a merge inside its window.
   *
   * The reversal is driven entirely by `patient.merge_repoints.row_ids`: exactly
   * the rows that were moved go back, and nothing else. Reconstructing the split
   * from the data instead — "return the survivor's contacts that look like the
   * victim's" — would be a guess, and a guess about which allergies belong to
   * which patient is not a guess anybody should make.
   */
  async unmerge(body: UnmergeRequest): Promise<UnmergeResult> {
    const ctx = getContext();

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const merge = await tx.maybeOne<MergeRow>(
        `SELECT id, survivor_id, victim_id, survivor_uhid, victim_uhid, status::text AS status,
                reason, requested_at, unmerge_deadline
           FROM patient.merges WHERE id = $1 FOR UPDATE`,
        [body.mergeId],
      );
      if (merge === undefined) throw AppError.notFound('The merge');
      if (merge.status !== 'completed') {
        throw new AppError(
          ProblemType.ALREADY_DECIDED,
          `Only a completed merge can be reversed; this one is ${merge.status}.`,
        );
      }
      if (merge.unmerge_deadline.getTime() < Date.now()) {
        // A 410, not a 409: the ability to reverse genuinely existed and is now
        // gone, and the caller should stop retrying.
        throw new AppError(
          ProblemType.GONE,
          `The ${UNMERGE_WINDOW_DAYS}-day window to reverse this merge closed on ` +
            `${merge.unmerge_deadline.toISOString().slice(0, 10)}.`,
          {
            nextAction:
              'Raise an MRD correction instead: the merge stays, and the correction is recorded against it.',
          },
        );
      }

      const restored: { table: string; rows: number }[] = [];
      const repoints = await tx.rows<{ id: string; table_name: string; row_ids: string[] }>(
        `SELECT id, table_name, row_ids FROM patient.merge_repoints
          WHERE merge_id = $1 AND status = 'applied' FOR UPDATE`,
        [body.mergeId],
      );

      for (const repoint of repoints) {
        if (!isOwnedTable(repoint.table_name)) {
          // A row acknowledged by another module cannot be reversed from here —
          // that module owns its own reversal and reacts to `patient.unmerged`.
          continue;
        }
        const moved = await tx.rows<{ id: string }>(
          `UPDATE patient.${repoint.table_name} SET patient_id = $2, updated_at = now()
            WHERE id = ANY($1::uuid[]) RETURNING id`,
          [repoint.row_ids, merge.victim_id],
        );
        await tx.query(
          `UPDATE patient.merge_repoints
              SET status = 'reversed', reversed_at = now(), updated_at = now()
            WHERE id = $1`,
          [repoint.id],
        );
        restored.push({ table: repoint.table_name, rows: moved.length });
      }

      await tx.query(
        `UPDATE patient.patients
            SET status = 'active', merged_into_id = NULL, merged_at = NULL,
                version = version + 1, updated_by = $2, updated_at = now()
          WHERE id = $1`,
        [merge.victim_id, ctx.userId],
      );

      const unmergedAt = new Date();
      await tx.query(
        `UPDATE patient.merges
            SET status = 'unmerged', unmerged_by = $2, unmerged_at = $3, unmerge_reason = $4,
                version = version + 1, updated_at = now()
          WHERE id = $1`,
        [body.mergeId, ctx.userId, unmergedAt, body.reason],
      );

      // The pair goes back to the queue rather than to "not a duplicate": the
      // officer reversed a decision, they did not make the opposite one.
      await tx.query(
        `UPDATE patient.dedupe_candidates
            SET status = 'open', merge_id = NULL, reviewed_by = NULL, reviewed_at = NULL,
                version = version + 1, updated_at = now()
          WHERE merge_id = $1`,
        [body.mergeId],
      );

      await this.audit.write(tx, {
        action: 'update',
        entity: 'patient.merges',
        rowId: body.mergeId,
        businessKey: `${merge.survivor_uhid}<-${merge.victim_uhid}`,
        dataClass: 'phi',
        patientId: merge.victim_id,
        before: { status: 'completed', victim_status: 'merged' },
        after: { status: 'unmerged', victim_status: 'active', restored },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        patientEvent('patient.unmerged', merge.survivor_id, {
          survivorId: merge.survivor_id,
          victimId: merge.victim_id,
          unmergedBy: ctx.userId,
          reason: body.reason,
        }),
      );

      return {
        mergeId: body.mergeId,
        survivorId: merge.survivor_id,
        victimId: merge.victim_id,
        victimUhid: merge.victim_uhid,
        unmergedAt,
        restored,
      };
    });
  }

  // ── shared ────────────────────────────────────────────────────────────────

  /**
   * Loads one side of the merge.
   *
   * No `hospital_id` predicate: row-level security has already removed another
   * tenant's patient, so a cross-tenant id arrives here as absent and leaves as
   * a 404. That is the whole reason a merge cannot be used as an existence
   * oracle for another hospital's records.
   */
  private async loadParty(
    tx: TransactionClient,
    id: string,
    role: 'survivor' | 'victim',
    lock = false,
  ): Promise<MergePartyRow> {
    const party = await tx.maybeOne<MergePartyRow>(
      `SELECT p.id, p.uhid, p.status::text AS status, p.full_name, p.gender::text AS gender,
              p.dob::text AS dob_text, p.mobile, p.abha_number, p.branch_id, p.registered_at,
              p.allergy_statement::text AS allergy_statement, p.version
         FROM patient.patients p
        WHERE p.id = $1 AND p.deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [id],
    );
    if (party === undefined) {
      throw AppError.notFound(role === 'survivor' ? 'The surviving patient' : 'The patient to merge away');
    }
    return party;
  }

  private async countOwnedRows(
    tx: TransactionClient,
    patientId: string,
  ): Promise<{ table: string; rows: number }[]> {
    const impact: { table: string; rows: number }[] = [];
    for (const table of OWNED_TABLES) {
      const row = await tx.one<{ n: string }>(
        `SELECT count(*)::text AS n FROM patient.${table} WHERE patient_id = $1`,
        [patientId],
      );
      impact.push({ table, rows: Number(row.n) });
    }
    return impact;
  }

  /**
   * Moves the victim's rows onto the survivor, recording each row id.
   *
   * `patient.identifiers` is unique on `(hospital_id, type, value_normalised)`
   * — per *hospital*, not per patient — so two live records cannot both hold the
   * same ABHA and the collision is not reachable through this module's own
   * routes. It is reachable through EN-036's bulk import and through any
   * backfill that predates the constraint, and it is caught rather than left to
   * surface as a 500, because an identifier that vanishes during a merge is an
   * identifier nobody can search for afterwards.
   */
  private async repoint(
    tx: TransactionClient,
    mergeId: string,
    victimId: string,
    survivorId: string,
  ): Promise<{ table: string; rows: number }[]> {
    const ctx = getContext();
    const moved: { table: string; rows: number }[] = [];

    for (const table of OWNED_TABLES) {
      let rows: { id: string }[];
      try {
        rows = await tx.rows<{ id: string }>(
          `UPDATE patient.${table} SET patient_id = $2, updated_at = now()
            WHERE patient_id = $1 RETURNING id`,
          [victimId, survivorId],
        );
      } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
          throw AppError.conflict(
            `Both records carry the same ${table.replace(/s$/, '')}, so it cannot be moved. ` +
              `Retire the duplicate on one record first, then merge.`,
          );
        }
        throw error;
      }

      await tx.query(
        `INSERT INTO patient.merge_repoints
           (id, hospital_id, merge_id, module, table_name, rows_repointed, row_ids, status,
            applied_at, updated_at)
         VALUES ($1, $2, $3, 'OP-001', $4, $5, $6::uuid[], 'applied', now(), now())
         ON CONFLICT (merge_id, module, table_name) DO UPDATE
            SET rows_repointed = EXCLUDED.rows_repointed,
                row_ids        = EXCLUDED.row_ids,
                status         = 'applied',
                applied_at     = now(),
                updated_at     = now()`,
        [newId(), ctx.hospitalId, mergeId, table, rows.length, rows.map((r) => r.id)],
      );

      moved.push({ table, rows: rows.length });
    }

    return moved;
  }
}

/**
 * Guards the table name that is interpolated into the reversal statement.
 *
 * `table_name` is read back out of the database, and a value that did not come
 * from `OWNED_TABLES` must never reach the SQL string — `docs/04` §6 bans raw
 * concatenation, and this is the one place a name cannot be a bind parameter.
 */
function isOwnedTable(name: string): name is (typeof OWNED_TABLES)[number] {
  return (OWNED_TABLES as readonly string[]).includes(name);
}
