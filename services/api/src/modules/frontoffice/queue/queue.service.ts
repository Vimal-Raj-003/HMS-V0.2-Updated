import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { queueEvent } from './queue.events.js';
import {
  ACTIVE_TOKEN_STATUSES,
  elapsedSeconds,
  estimateWaitSeconds,
  formatTokenDisplay,
  priorityRankFor,
  statusAfterSkip,
  type TokenClass,
} from './queue.logic.js';
import type {
  CallNextRequest,
  IssueTokenRequest,
  ListTokensQuery,
  SkipTokenRequest,
  TransferTokenRequest,
} from './queue.schemas.js';

const RESOURCE = 'queue.tokens';

/** The columns every token response carries. No name, no UHID — see `boardFor`. */
export interface TokenView {
  readonly id: string;
  readonly queue_id: string;
  readonly branch_id: string;
  readonly series_date: string;
  readonly token_no: number;
  readonly token_display: string;
  readonly patient_id: string | null;
  readonly visit_id: string | null;
  readonly appointment_id: string | null;
  readonly counter_id: string | null;
  readonly room_key: string | null;
  readonly source: string;
  readonly class: string;
  readonly priority_rank: number;
  readonly status: string;
  readonly est_wait_sec_at_issue: number | null;
  readonly actual_wait_sec: number | null;
  readonly skip_count: number;
  readonly recall_count: number;
  readonly issued_at: Date;
  readonly called_at: Date | null;
  readonly service_end_at: Date | null;
}

export interface BoardEntry {
  readonly tokenDisplay: string;
  readonly status: string;
  readonly counterId: string | null;
  readonly roomKey: string | null;
  readonly isPriority: boolean;
}

/**
 * The TV-board payload (EN-018 §4 privacy rule).
 *
 * Token, room and counts only. `EN-006 §5` — "Display privacy: default shows
 * token + first name initial + room" — and `EN-018 §5` make a public board a
 * *disclosure* under the DPDP Act, so this endpoint returns no patient
 * identifier at all: not a name, not an initial, not a UHID fragment. A hospital
 * that has documented a decision to show more can add it to the board renderer,
 * where the decision is visible, rather than getting it by default from the API.
 */
export interface BoardView {
  readonly queueId: string;
  readonly queueCode: string;
  readonly queueName: string;
  readonly seriesDate: string;
  readonly nowServing: readonly BoardEntry[];
  readonly next: readonly BoardEntry[];
  readonly waiting: number;
  readonly served: number;
  readonly noShow: number;
  readonly avgWaitSeconds: number;
  readonly doctorStatus: string | null;
}

interface QueueDefinitionRow {
  readonly id: string;
  readonly hospital_id: string;
  readonly branch_id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly stage_key: string | null;
  readonly practitioner_key: string | null;
  readonly room_key: string | null;
  readonly member_refs: unknown;
  readonly series_prefix: string;
  readonly series_scope: string;
  readonly number_width: number;
  readonly start_number: number;
  readonly avg_service_sec_seed: number;
  readonly max_length: number | null;
  readonly skip_policy: unknown;
  readonly active: boolean;
  readonly tz: string;
  readonly series_date: string;
}

interface SeriesRow {
  readonly id: string;
  readonly prefix: string;
  readonly number_width: number;
  readonly start_number: number;
  readonly last_number: number;
  readonly offline_reserved_from: number;
}

interface TokenRow extends TokenView {
  readonly hospital_id: string;
  readonly called_by: string | null;
  readonly service_start_at: Date | null;
  /**
   * `issued_at` rendered by PostgreSQL, kept verbatim.
   *
   * `queue_tokens` is partitioned on `issued_at` and its primary key is
   * `(id, issued_at)`, so every update has to name both. A JavaScript `Date`
   * cannot be that second value: `timestamptz(6)` holds microseconds and a
   * `Date` holds milliseconds, so a row read into Node and written back matches
   * nothing — the update silently affects zero rows. Passing the text back
   * through `::timestamptz` round-trips exactly. Same reasoning as the cursor
   * keys in `CursorService.keysetPage`.
   */
  readonly issued_at_key: string;
}

/** The public shape. Internal columns — the tenant id, the partition key — stay inside. */
function toView(row: TokenRow): TokenView {
  return {
    id: row.id,
    queue_id: row.queue_id,
    branch_id: row.branch_id,
    series_date: row.series_date,
    token_no: row.token_no,
    token_display: row.token_display,
    patient_id: row.patient_id,
    visit_id: row.visit_id,
    appointment_id: row.appointment_id,
    counter_id: row.counter_id,
    room_key: row.room_key,
    source: row.source,
    class: row.class,
    priority_rank: row.priority_rank,
    status: row.status,
    est_wait_sec_at_issue: row.est_wait_sec_at_issue,
    actual_wait_sec: row.actual_wait_sec,
    skip_count: row.skip_count,
    recall_count: row.recall_count,
    issued_at: row.issued_at,
    called_at: row.called_at,
    service_end_at: row.service_end_at,
  };
}

/**
 * EN-006 — tokens, calling and the board.
 *
 * Three properties in this file are load-bearing and are why it is longer than
 * the endpoint list suggests.
 *
 * **One active token per patient per queue per day.** PostgreSQL cannot express
 * it: a unique index on a partitioned table may not be partial, and the rule
 * only bites on the *active* statuses. So `issue` checks it while holding the
 * row lock on `queue.queue_token_series` that it already needs in order to
 * allocate the number — no extra lock, no window between the check and the
 * insert — and `idx_queue_tokens_patient_day` turns the check into a probe. Two
 * receptionists pressing F2 for the same patient at the same instant therefore
 * produce one token and one conflict, not two tokens.
 *
 * **Tokens do not come from `core.numbering_series`.** A daily-reset series
 * cannot be recorded there (`fy` is `varchar(9)`, a date needs 10), so
 * `NumberingService` refuses a `day` reset policy by design and says so. Tokens
 * come from `queue.queue_token_series`, one row per queue per scope per day.
 *
 * **The online allocator never reaches into the offline block.** The database
 * enforces `last_number < offline_reserved_from`; this service refuses one
 * allocation earlier so the failure is a readable 422 rather than a check
 * violation, but the constraint is the actual guarantee.
 */
@Injectable()
export class QueueService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  async list(query: ListTokensQuery): Promise<Page<TokenView>> {
    const hospitalId = getContext().hospitalId ?? '';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource: RESOURCE });

    const where: string[] = ['true'];
    const values: unknown[] = [];
    const bind = (value: unknown): string => `$${values.push(value)}`;

    if (query.queueId !== undefined) where.push(`t.queue_id = ${bind(query.queueId)}::uuid`);
    if (query.date !== undefined) where.push(`t.series_date = ${bind(query.date)}::date`);
    if (query.status !== undefined) {
      where.push(`t.status = ${bind(query.status)}::queue."QueueTokenStatus"`);
    }
    if (query.patientId !== undefined) where.push(`t.patient_id = ${bind(query.patientId)}::uuid`);
    if (after !== null) {
      where.push(`(t.issued_at, t.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
    }

    const sql = `${selectToken('t')}, t.issued_at::text AS cursor_key
                   FROM queue.queue_tokens t
                  WHERE ${where.join(' AND ')}
                  ORDER BY t.issued_at DESC, t.id DESC
                  LIMIT ${bind(limit + 1)}`;

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const fetched = await tx.rows<TokenRow & { cursor_key: string }>(sql, values);
      const page = this.cursors.keysetPage<TokenRow>(fetched, limit, {
        hospitalId,
        resource: RESOURCE,
        direction: 'desc',
      });
      return { items: page.items.map(toView), nextCursor: page.nextCursor, hasMore: page.hasMore };
    });
  }

  async get(id: string): Promise<TokenView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      return toView(await this.loadToken(tx, id, { forUpdate: false }));
    });
  }

  /** The live board — EN-006 §6 `GET /queues/:id/live`. */
  async board(queueId: string): Promise<BoardView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const definition = await this.loadDefinition(tx, queueId);

      const entries = await tx.rows<{
        token_display: string;
        status: string;
        counter_id: string | null;
        room_key: string | null;
        priority_rank: number;
      }>(
        `SELECT t.token_display, t.status::text AS status, t.counter_id, t.room_key, t.priority_rank
           FROM queue.queue_tokens t
          WHERE t.queue_id = $1 AND t.series_date = $2::date
            AND t.status IN ('called', 'recalled', 'in_service', 'waiting', 'held')
          ORDER BY t.priority_rank DESC, t.appointment_due_at ASC NULLS LAST, t.issued_at ASC`,
        [definition.id, definition.series_date],
      );

      const counts = await tx.one<{ waiting: number; served: number; no_show: number; avg_wait: number }>(
        `SELECT count(*) FILTER (WHERE status IN ('waiting', 'held', 'skipped'))::int AS waiting,
                count(*) FILTER (WHERE status = 'served')::int                        AS served,
                count(*) FILTER (WHERE status = 'no_show')::int                       AS no_show,
                COALESCE(avg(actual_wait_sec) FILTER (WHERE actual_wait_sec IS NOT NULL), 0)::int AS avg_wait
           FROM queue.queue_tokens
          WHERE queue_id = $1 AND series_date = $2::date`,
        [definition.id, definition.series_date],
      );

      const doctor =
        definition.practitioner_key === null
          ? undefined
          : await tx.maybeOne<{ status: string }>(
              `SELECT status::text AS status FROM queue.queue_doctor_status
                WHERE practitioner_key = $1 ORDER BY since DESC LIMIT 1`,
              [definition.practitioner_key],
            );

      const toEntry = (row: (typeof entries)[number]): BoardEntry => ({
        tokenDisplay: row.token_display,
        status: row.status,
        counterId: row.counter_id,
        roomKey: row.room_key,
        isPriority: row.priority_rank > 0,
      });

      return {
        queueId: definition.id,
        queueCode: definition.code,
        queueName: definition.name,
        seriesDate: definition.series_date,
        nowServing: entries
          .filter((e) => e.status === 'called' || e.status === 'recalled' || e.status === 'in_service')
          .map(toEntry),
        next: entries
          .filter((e) => e.status === 'waiting' || e.status === 'held')
          .slice(0, 3)
          .map(toEntry),
        waiting: counts.waiting,
        served: counts.served,
        noShow: counts.no_show,
        avgWaitSeconds: counts.avg_wait,
        doctorStatus: doctor?.status ?? null,
      };
    });
  }

  // ── writes ────────────────────────────────────────────────────────────────

  /** EN-006 §3.2 — issue a token. */
  async issue(body: IssueTokenRequest, idempotencyKey: string | null): Promise<TokenView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const definition = await this.loadDefinition(tx, body.queueId);
      if (!definition.active) {
        throw AppError.conflict(`Queue "${definition.code}" is not accepting tokens.`);
      }

      if (idempotencyKey !== null) {
        const replay = await tx.maybeOne<TokenRow>(
          `${selectToken('t')} FROM queue.queue_tokens t
             WHERE t.idempotency_key = $1 AND t.queue_id = $2 AND t.series_date = $3::date`,
          [idempotencyKey, definition.id, definition.series_date],
        );
        if (replay !== undefined) return toView(replay);
      }

      // The series row lock. `ON CONFLICT DO UPDATE` locks the existing row for
      // the rest of this transaction, which is what makes the duplicate check
      // below and the allocation after it a single atomic decision.
      const series = await tx.one<SeriesRow>(
        `INSERT INTO queue.queue_token_series
           (id, hospital_id, branch_id, queue_id, scope_key, series_date,
            prefix, number_width, start_number, last_number, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, GREATEST($9 - 1, 0), now())
         ON CONFLICT (queue_id, scope_key, series_date) DO UPDATE SET updated_at = now()
         RETURNING id, prefix, number_width, start_number, last_number, offline_reserved_from`,
        [
          newId(),
          definition.hospital_id,
          definition.branch_id,
          definition.id,
          scopeKeyFor(definition),
          definition.series_date,
          definition.series_prefix,
          definition.number_width,
          definition.start_number,
        ],
      );

      // EN-006 §5, under the lock we already hold.
      if (body.patientId !== undefined) {
        const active = await tx.maybeOne<{ token_display: string; status: string }>(
          `SELECT t.token_display, t.status::text AS status
             FROM queue.queue_tokens t
            WHERE t.queue_id = $1 AND t.series_date = $2::date AND t.patient_id = $3
              AND t.status = ANY($4::queue."QueueTokenStatus"[])
            LIMIT 1`,
          [definition.id, definition.series_date, body.patientId, [...ACTIVE_TOKEN_STATUSES]],
        );
        if (active !== undefined) {
          throw new AppError(
            ProblemType.CONFLICT,
            `This patient already holds token ${active.token_display} in this queue today (${active.status}).`,
            {
              nextAction: 'Use the existing token, or complete/cancel it at the desk before issuing another.',
            },
          );
        }
      }

      const nextNumber = Math.max(series.last_number, series.start_number - 1) + 1;
      if (nextNumber >= series.offline_reserved_from) {
        // The database enforces this too (`queue_token_series_offline_boundary`).
        // Refusing one number earlier turns a check violation into a readable
        // refusal that names the fix.
        throw new AppError(
          ProblemType.NUMBERING_SERIES_EXHAUSTED,
          `Queue "${definition.code}" has issued every number below its offline block (${series.offline_reserved_from}).`,
          { nextAction: 'Raise the offline reserve or reset the series for the day.' },
        );
      }

      const allocated = await tx.one<{ last_number: number }>(
        `UPDATE queue.queue_token_series
            SET last_number = $2, issued_count = issued_count + 1, updated_at = now(), version = version + 1
          WHERE id = $1
          RETURNING last_number`,
        [series.id, nextNumber],
      );

      const tokenClass: TokenClass = body.class ?? 'regular';
      const display = formatTokenDisplay(series.prefix, allocated.last_number, series.number_width);
      const serviceSeconds = await this.serviceSecondsFor(tx, definition);
      const ahead = await tx.one<{ ahead: number }>(
        `SELECT count(*)::int AS ahead FROM queue.queue_tokens
          WHERE queue_id = $1 AND series_date = $2::date AND status IN ('waiting', 'held', 'skipped')`,
        [definition.id, definition.series_date],
      );

      const inserted = await tx.one<TokenRow>(
        `INSERT INTO queue.queue_tokens (
           id, hospital_id, branch_id, queue_id, journey_id, stage_key, series_date,
           token_no, token_display, patient_id, visit_id, appointment_id,
           practitioner_key, room_key, source, "class", priority_rank, priority_reason,
           status, appointment_due_at, activated_at, est_wait_sec_at_issue,
           idempotency_key, issued_by, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::date,
           $8, $9, $10, $11, $12,
           $13, $14, $15::queue."QueueTokenSource", $16::queue."QueueTokenClass", $17, $18,
           'waiting'::queue."QueueTokenStatus", $19::timestamptz, now(), $20,
           $21, $22, now()
         )
         RETURNING ${RETURNING_TOKEN}`,
        [
          newId(),
          definition.hospital_id,
          definition.branch_id,
          definition.id,
          body.journeyId ?? null,
          definition.stage_key,
          definition.series_date,
          allocated.last_number,
          display,
          body.patientId ?? null,
          body.visitId ?? null,
          body.appointmentId ?? null,
          definition.practitioner_key,
          definition.room_key,
          body.source ?? 'desk',
          tokenClass,
          priorityRankFor(tokenClass),
          body.priorityReason ?? null,
          body.appointmentDueAt ?? null,
          estimateWaitSeconds(ahead.ahead, serviceSeconds),
          idempotencyKey,
          getContext().userId,
        ],
      );

      await this.recordQueueEvent(tx, inserted, 'issued', null, 'waiting', {
        reason: body.priorityReason ?? null,
      });
      await this.audit.write(tx, {
        action: 'insert',
        entity: 'queue.queue_tokens',
        rowId: inserted.id,
        businessKey: inserted.token_display,
        dataClass: 'phi',
        before: null,
        after: { queueId: definition.id, status: 'waiting', class: tokenClass },
        patientId: inserted.patient_id,
      });
      await this.outbox.publish(
        tx,
        queueEvent('queue.token.issued', inserted.id, {
          tokenId: inserted.id,
          queueId: definition.id,
          tokenNo: inserted.token_display,
          priorityWeight: inserted.priority_rank,
          issuedAt: inserted.issued_at.toISOString(),
        }),
      );

      return toView(inserted);
    });
  }

  /** EN-006 §3.3 — call the head of the queue. */
  async callNext(queueId: string, body: CallNextRequest): Promise<TokenView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const definition = await this.loadDefinition(tx, queueId);
      await this.assertOwnQueue(definition);

      // `FOR UPDATE SKIP LOCKED` is the whole answer to EN-006 AC2: two consoles
      // pressing Call Next at the same instant take two different tokens,
      // because the second one skips the row the first has locked instead of
      // waiting for it and then reading the same head.
      const head = await tx.maybeOne<TokenRow>(
        `${selectToken('t')} FROM queue.queue_tokens t
           WHERE t.queue_id = $1 AND t.series_date = $2::date
             AND t.status IN ('waiting', 'held', 'skipped')
           ORDER BY t.priority_rank DESC, t.appointment_due_at ASC NULLS LAST, t.issued_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
        [definition.id, definition.series_date],
      );
      if (head === undefined) {
        throw AppError.conflict(`No token is waiting in queue "${definition.code}".`);
      }

      const called = await tx.one<TokenRow>(
        `UPDATE queue.queue_tokens
            SET status = 'called'::queue."QueueTokenStatus",
                called_at = now(), called_by = $3, counter_id = $4, room_key = COALESCE($5, room_key),
                updated_at = now(), version = version + 1
          WHERE id = $1 AND issued_at = $2::timestamptz
          RETURNING ${RETURNING_TOKEN}`,
        [head.id, head.issued_at_key, getContext().userId, body.counterId ?? null, body.roomKey ?? null],
      );

      if (body.counterId !== undefined) {
        await tx.query(
          `UPDATE queue.queue_counters
              SET status = 'busy'::queue."QueueCounterStatus", current_token_id = $2,
                  current_user_id = $3, updated_at = now(), version = version + 1
            WHERE id = $1`,
          [body.counterId, called.id, getContext().userId],
        );
      }

      await this.afterStateChange(tx, called, head.status, 'called', 'called', {
        counterId: body.counterId ?? null,
      });
      await this.outbox.publish(
        tx,
        queueEvent('queue.token.called', called.id, {
          tokenId: called.id,
          queueId: definition.id,
          tokenNo: called.token_display,
          counterOrRoom: body.counterId ?? body.roomKey ?? definition.code,
          calledAt: (called.called_at ?? new Date()).toISOString(),
        }),
      );
      return toView(called);
    });
  }

  /** EN-006 §3.3 — announce the same token again. */
  async recall(tokenId: string): Promise<TokenView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const token = await this.loadToken(tx, tokenId, { forUpdate: true });
      if (token.status !== 'called' && token.status !== 'recalled') {
        throw AppError.conflict(`Token ${token.token_display} is ${token.status} and cannot be recalled.`);
      }
      const definition = await this.loadDefinition(tx, token.queue_id);
      await this.assertOwnQueue(definition);

      const updated = await tx.one<TokenRow>(
        `UPDATE queue.queue_tokens
            SET status = 'recalled'::queue."QueueTokenStatus",
                recall_count = recall_count + 1, called_at = now(), called_by = $3,
                updated_at = now(), version = version + 1
          WHERE id = $1 AND issued_at = $2::timestamptz
          RETURNING ${RETURNING_TOKEN}`,
        [token.id, token.issued_at_key, getContext().userId],
      );

      await this.afterStateChange(tx, updated, token.status, 'recalled', 'recalled', {});
      await this.outbox.publish(
        tx,
        queueEvent('queue.token.recalled', updated.id, {
          tokenId: updated.id,
          attempt: updated.recall_count,
        }),
      );
      return toView(updated);
    });
  }

  /**
   * EN-006 §3.3 — skip a token that did not answer.
   *
   * A skip is never silent: it costs a reason and it records the actor, because
   * "the patient was skipped" is the complaint the front office has to answer at
   * the end of the day and `queue_events` is where the answer lives.
   */
  async skip(tokenId: string, body: SkipTokenRequest): Promise<TokenView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const token = await this.loadToken(tx, tokenId, { forUpdate: true });
      if (token.status !== 'called' && token.status !== 'recalled' && token.status !== 'waiting') {
        throw AppError.conflict(`Token ${token.token_display} is ${token.status} and cannot be skipped.`);
      }
      const definition = await this.loadDefinition(tx, token.queue_id);
      await this.assertOwnQueue(definition);

      const maxSkips = maxSkipsOf(definition.skip_policy);
      const nextStatus = statusAfterSkip(token.skip_count + 1, maxSkips);

      const updated = await tx.one<TokenRow>(
        `UPDATE queue.queue_tokens
            SET status = $3::queue."QueueTokenStatus", skip_count = skip_count + 1,
                notes = COALESCE(notes, '') || $4, updated_at = now(), version = version + 1
          WHERE id = $1 AND issued_at = $2::timestamptz
          RETURNING ${RETURNING_TOKEN}`,
        [token.id, token.issued_at_key, nextStatus, `skip: ${body.reason}\n`],
      );

      await this.afterStateChange(
        tx,
        updated,
        token.status,
        nextStatus,
        nextStatus === 'no_show' ? 'no_show' : 'skipped',
        { reason: body.reason },
      );
      await this.outbox.publish(
        tx,
        queueEvent('queue.token.skipped', updated.id, { tokenId: updated.id, reason: body.reason }),
      );
      return toView(updated);
    });
  }

  /** EN-006 §3.3 — the consult/collection finished. */
  async complete(tokenId: string): Promise<TokenView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const token = await this.loadToken(tx, tokenId, { forUpdate: true });
      if (!['called', 'recalled', 'in_service', 'held'].includes(token.status)) {
        throw AppError.conflict(`Token ${token.token_display} is ${token.status} and cannot be completed.`);
      }
      const definition = await this.loadDefinition(tx, token.queue_id);
      await this.assertOwnQueue(definition);

      const waitSeconds = elapsedSeconds(token.issued_at, token.called_at ?? new Date());
      const updated = await tx.one<TokenRow>(
        `UPDATE queue.queue_tokens
            SET status = 'served'::queue."QueueTokenStatus",
                service_start_at = COALESCE(service_start_at, called_at, now()),
                service_end_at = now(), actual_wait_sec = $3,
                updated_at = now(), version = version + 1
          WHERE id = $1 AND issued_at = $2::timestamptz
          RETURNING ${RETURNING_TOKEN}`,
        [token.id, token.issued_at_key, waitSeconds],
      );

      if (token.counter_id !== null) {
        await tx.query(
          `UPDATE queue.queue_counters
              SET status = 'free'::queue."QueueCounterStatus", current_token_id = NULL,
                  updated_at = now(), version = version + 1
            WHERE id = $1 AND current_token_id = $2`,
          [token.counter_id, token.id],
        );
      }

      await this.afterStateChange(tx, updated, token.status, 'served', 'served', {});
      await this.outbox.publish(
        tx,
        queueEvent('queue.token.completed', updated.id, {
          tokenId: updated.id,
          servedAt: (updated.service_end_at ?? new Date()).toISOString(),
          waitSeconds,
        }),
      );
      return toView(updated);
    });
  }

  /**
   * EN-006 §3.3 — move a waiting patient to another queue.
   *
   * The old token ends as `transferred` and a **new** token is issued in the
   * target queue carrying the original priority, because the target queue has
   * its own series and its own board. Both facts are announced: the new token is
   * a `queue.token.issued` for the target board, and the move itself is a
   * `queue.token.transferred` for the source.
   */
  async transfer(tokenId: string, body: TransferTokenRequest): Promise<TokenView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const token = await this.loadToken(tx, tokenId, { forUpdate: true });
      if (!['waiting', 'called', 'recalled', 'held', 'skipped'].includes(token.status)) {
        throw AppError.conflict(`Token ${token.token_display} is ${token.status} and cannot be transferred.`);
      }
      if (body.toQueueId === token.queue_id) {
        throw AppError.conflict('A token cannot be transferred to the queue it is already in.');
      }

      const target = await this.loadDefinition(tx, body.toQueueId);
      if (!target.active) throw AppError.conflict(`Queue "${target.code}" is not accepting tokens.`);

      const series = await tx.one<SeriesRow>(
        `INSERT INTO queue.queue_token_series
           (id, hospital_id, branch_id, queue_id, scope_key, series_date,
            prefix, number_width, start_number, last_number, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, $9, GREATEST($9 - 1, 0), now())
         ON CONFLICT (queue_id, scope_key, series_date) DO UPDATE SET updated_at = now()
         RETURNING id, prefix, number_width, start_number, last_number, offline_reserved_from`,
        [
          newId(),
          target.hospital_id,
          target.branch_id,
          target.id,
          scopeKeyFor(target),
          target.series_date,
          target.series_prefix,
          target.number_width,
          target.start_number,
        ],
      );

      if (token.patient_id !== null) {
        const active = await tx.maybeOne<{ token_display: string }>(
          `SELECT t.token_display FROM queue.queue_tokens t
            WHERE t.queue_id = $1 AND t.series_date = $2::date AND t.patient_id = $3
              AND t.status = ANY($4::queue."QueueTokenStatus"[])
            LIMIT 1`,
          [target.id, target.series_date, token.patient_id, [...ACTIVE_TOKEN_STATUSES]],
        );
        if (active !== undefined) {
          throw AppError.conflict(
            `This patient already holds token ${active.token_display} in the target queue today.`,
          );
        }
      }

      const nextNumber = Math.max(series.last_number, series.start_number - 1) + 1;
      if (nextNumber >= series.offline_reserved_from) {
        throw new AppError(
          ProblemType.NUMBERING_SERIES_EXHAUSTED,
          `Queue "${target.code}" has issued every number below its offline block.`,
        );
      }
      const allocated = await tx.one<{ last_number: number }>(
        `UPDATE queue.queue_token_series
            SET last_number = $2, issued_count = issued_count + 1, updated_at = now(), version = version + 1
          WHERE id = $1 RETURNING last_number`,
        [series.id, nextNumber],
      );

      const created = await tx.one<TokenRow>(
        `INSERT INTO queue.queue_tokens (
           id, hospital_id, branch_id, queue_id, journey_id, stage_key, series_date,
           token_no, token_display, patient_id, visit_id, appointment_id,
           practitioner_key, room_key, source, "class", priority_rank, priority_reason,
           status, activated_at, transfer_from_token_id, transfer_reason, issued_by, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7::date,
           $8, $9, $10, $11, $12,
           $13, $14, 'auto_forward'::queue."QueueTokenSource", $15::queue."QueueTokenClass", $16, $17,
           'waiting'::queue."QueueTokenStatus", now(), $18, $19, $20, now()
         )
         RETURNING ${RETURNING_TOKEN}`,
        [
          newId(),
          target.hospital_id,
          target.branch_id,
          target.id,
          null,
          target.stage_key,
          target.series_date,
          allocated.last_number,
          formatTokenDisplay(series.prefix, allocated.last_number, series.number_width),
          token.patient_id,
          token.visit_id,
          token.appointment_id,
          target.practitioner_key,
          target.room_key,
          token.class,
          token.priority_rank,
          body.reason,
          token.id,
          body.reason,
          getContext().userId,
        ],
      );

      const source = await tx.one<TokenRow>(
        `UPDATE queue.queue_tokens
            SET status = 'transferred'::queue."QueueTokenStatus", transfer_to_token_id = $3,
                transfer_reason = $4, updated_at = now(), version = version + 1
          WHERE id = $1 AND issued_at = $2::timestamptz
          RETURNING ${RETURNING_TOKEN}`,
        [token.id, token.issued_at_key, created.id, body.reason],
      );

      await this.afterStateChange(tx, source, token.status, 'transferred', 'transferred', {
        reason: body.reason,
        toQueueId: target.id,
      });
      await this.recordQueueEvent(tx, created, 'issued', null, 'waiting', { reason: body.reason });
      await this.outbox.publish(
        tx,
        queueEvent('queue.token.transferred', source.id, {
          tokenId: source.id,
          fromQueueId: token.queue_id,
          toQueueId: target.id,
          reason: body.reason,
        }),
      );
      await this.outbox.publish(
        tx,
        queueEvent('queue.token.issued', created.id, {
          tokenId: created.id,
          queueId: target.id,
          tokenNo: created.token_display,
          priorityWeight: created.priority_rank,
          issuedAt: created.issued_at.toISOString(),
        }),
      );

      return toView(created);
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Loads the queue and, with it, the **business date of its series**.
   *
   * The date is computed in PostgreSQL from the branch's own timezone and the
   * queue's reset time, not in Node: a queue that resets at 07:00 puts a 06:30
   * token on yesterday's series, and doing that arithmetic in the API would use
   * the server's clock zone, which in a cloud deployment is UTC and therefore
   * wrong for every Indian hospital between 18:30 and midnight.
   */
  private async loadDefinition(tx: TransactionClient, queueId: string): Promise<QueueDefinitionRow> {
    const definition = await tx.maybeOne<QueueDefinitionRow>(
      `SELECT q.id, q.hospital_id, q.branch_id, q.code, q.name, q.kind::text AS kind, q.stage_key,
              q.practitioner_key, q.room_key, q.member_refs, q.series_prefix,
              q.series_scope::text AS series_scope, q.number_width, q.start_number,
              q.avg_service_sec_seed, q.max_length, q.skip_policy, q.active,
              COALESCE(b.timezone, h.timezone) AS tz,
              ((timezone(COALESCE(b.timezone, h.timezone), now()) - q.reset_time::interval))::date::text
                AS series_date
         FROM queue.queue_definitions q
         LEFT JOIN core.branches  b ON b.id = q.branch_id
         LEFT JOIN core.hospitals h ON h.id = q.hospital_id
        WHERE q.id = $1 AND q.deleted_at IS NULL`,
      [queueId],
    );
    // Another hospital's queue is filtered out by RLS, so it arrives absent and
    // leaves as a 404 rather than a 403 — a 403 would confirm it exists
    // (docs/09 §3.1 case 2).
    if (definition === undefined) throw AppError.notFound('The queue');
    return definition;
  }

  private async loadToken(
    tx: TransactionClient,
    id: string,
    options: { forUpdate: boolean },
  ): Promise<TokenRow> {
    const token = await tx.maybeOne<TokenRow>(
      `${selectToken('t')} FROM queue.queue_tokens t WHERE t.id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
      [id],
    );
    if (token === undefined) throw AppError.notFound('The token');
    return token;
  }

  /**
   * ABAC `ownQueueOnly` (EN-006 §12, AC15).
   *
   * The route guard evaluates the permission without a resource — it cannot know
   * which queue is being called until the handler has loaded it — so the check
   * is repeated here with the queue's owner attached. It runs only when the
   * queue actually declares an owner in `member_refs.ownerUserId`; a department
   * or counter pool has no single owner and the condition does not apply to it.
   */
  private async assertOwnQueue(definition: QueueDefinitionRow): Promise<void> {
    const owner = ownerUserIdOf(definition.member_refs);
    if (owner === null) return;
    await this.policy.assert('queue.token.call', {
      branchId: definition.branch_id,
      queueOwnerUserId: owner,
    });
  }

  private async serviceSecondsFor(tx: TransactionClient, definition: QueueDefinitionRow): Promise<number> {
    const stats = await tx.maybeOne<{ ewma_service_sec: number }>(
      `SELECT ewma_service_sec FROM queue.queue_wait_stats
        WHERE queue_id = $1 ORDER BY bucket_start DESC LIMIT 1`,
      [definition.id],
    );
    const ewma = stats?.ewma_service_sec ?? 0;
    return ewma > 0 ? ewma : definition.avg_service_sec_seed;
  }

  /** One `queue_events` row + one audit row for a state change. */
  private async afterStateChange(
    tx: TransactionClient,
    token: TokenRow,
    from: string,
    to: string,
    kind: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.recordQueueEvent(tx, token, kind, from, to, meta);
    await this.audit.write(tx, {
      action: 'update',
      entity: 'queue.queue_tokens',
      rowId: token.id,
      businessKey: token.token_display,
      dataClass: 'phi',
      before: { status: from },
      after: { status: to },
      patientId: token.patient_id,
      reasonText: typeof meta['reason'] === 'string' ? meta['reason'] : null,
    });
  }

  private async recordQueueEvent(
    tx: TransactionClient,
    token: TokenRow,
    kind: string,
    from: string | null,
    to: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO queue.queue_events
         (id, hospital_id, branch_id, queue_id, token_id, token_display, event,
          from_status, to_status, counter_id, room_key, actor_id, actor_type, reason, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::queue."QueueEventKind",
               $8::queue."QueueTokenStatus", $9::queue."QueueTokenStatus", $10, $11, $12, $13, $14, $15::jsonb)`,
      [
        newId(),
        token.hospital_id,
        token.branch_id,
        token.queue_id,
        token.id,
        token.token_display,
        kind,
        from,
        to,
        token.counter_id,
        token.room_key,
        getContext().userId,
        getContext().userId === null ? 'system' : 'user',
        typeof meta['reason'] === 'string' ? meta['reason'] : null,
        JSON.stringify(meta),
      ],
    );
  }
}

const TOKEN_COLUMNS: readonly string[] = Object.freeze([
  'id',
  'hospital_id',
  'queue_id',
  'branch_id',
  'series_date::text AS series_date',
  'token_no',
  'token_display',
  'patient_id',
  'visit_id',
  'appointment_id',
  'counter_id',
  'room_key',
  'source::text AS source',
  '"class"::text AS "class"',
  'priority_rank',
  'status::text AS status',
  'est_wait_sec_at_issue',
  'actual_wait_sec',
  'skip_count',
  'recall_count',
  'issued_at',
  'called_at',
  'called_by',
  'service_start_at',
  'service_end_at',
  'issued_at::text AS issued_at_key',
]);

/** The column list for `RETURNING`, where nothing is aliased. */
const RETURNING_TOKEN = TOKEN_COLUMNS.join(', ');

/** The same list qualified by a table alias, for `SELECT ... FROM ... t`. */
function selectToken(alias: string): string {
  return `SELECT ${TOKEN_COLUMNS.map((column) => `${alias}.${column}`).join(', ')}`;
}

/**
 * Which series a token comes out of (EN-006 §4 `series_scope`).
 *
 * Per-doctor series (`D12-001`) and per-branch series (`A-001` shared across
 * every counter) are both in the field, so the scope key is data rather than an
 * assumption.
 */
function scopeKeyFor(definition: QueueDefinitionRow): string {
  switch (definition.series_scope) {
    case 'per_doctor':
      return definition.practitioner_key ?? definition.id;
    case 'per_branch':
      return definition.branch_id;
    default:
      return definition.id;
  }
}

function maxSkipsOf(skipPolicy: unknown): number {
  if (skipPolicy !== null && typeof skipPolicy === 'object') {
    const value = (skipPolicy as Record<string, unknown>)['max_skips'];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  }
  return 2;
}

function ownerUserIdOf(memberRefs: unknown): string | null {
  if (memberRefs !== null && typeof memberRefs === 'object') {
    const value = (memberRefs as Record<string, unknown>)['ownerUserId'];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
