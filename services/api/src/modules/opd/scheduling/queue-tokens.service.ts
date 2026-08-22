import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId } from '@vims/contracts';
import { getContext } from '../../../core/context/request-context.js';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { mapConstraints } from './scheduling.common.js';
import { schedulingEvent } from './scheduling.events.js';
import { priorityFor, type PriorityInput } from './slot-grid.js';

/**
 * Token issue, as OP-001 §3.5 needs it: **inside the check-in transaction**.
 *
 * "Creates the OP visit and issues the token" is one fact, not two. Issuing the
 * token afterwards, over a second connection, produces the two failure modes a
 * front office cannot absorb: a visit with no token (the patient is registered
 * and invisible to the queue board) or a token with no visit (a number is called
 * and nobody knows who it belongs to). So every method here takes the caller's
 * `tx`.
 *
 * This is a **minimal issuer for the check-in path only** — EN-006 owns calling,
 * recalling, skipping, holding, fairness ratios and the display feeds. What is
 * implemented is what OP-001 §3.5 requires to hand a patient a slip.
 */

export interface QueueDefinition {
  readonly id: string;
  readonly branch_id: string;
  readonly series_prefix: string;
  readonly series_scope: string;
  readonly number_width: number;
  readonly start_number: number;
  readonly offline_block_size: number;
  readonly practitioner_key: string | null;
  readonly room_key: string | null;
}

export interface IssuedToken {
  readonly id: string;
  readonly queueId: string;
  readonly tokenNo: number;
  readonly tokenDisplay: string;
  readonly priorityRank: number;
  readonly tokenClass: string;
  readonly seriesDate: string;
}

export interface IssueTokenInput {
  readonly branchId: string;
  readonly queue: QueueDefinition;
  readonly seriesDate: string;
  readonly patientId: string;
  readonly visitId: string;
  readonly appointmentId: string | null;
  readonly practitionerKey: string;
  readonly roomKey: string | null;
  readonly source: string;
  readonly priority: PriorityInput;
  readonly appointmentDueAt: Date | null;
}

@Injectable()
export class QueueTokensService {
  constructor(@Inject(OutboxService) private readonly outbox: OutboxService) {}

  /**
   * The queue a visit belongs in: the one the caller named, else the doctor's
   * own queue at this branch.
   *
   * Refusing when neither exists is deliberate. A visit created with no token is
   * a patient who never appears on the board and is never called, and that is
   * discovered by the patient rather than by the system.
   */
  async resolveQueue(
    tx: TransactionClient,
    branchId: string,
    practitionerKey: string,
    queueId: string | undefined,
  ): Promise<QueueDefinition> {
    const found =
      queueId === undefined
        ? await tx.maybeOne<QueueDefinition>(
            `SELECT q.id, q.branch_id, q.series_prefix, q.series_scope::text AS series_scope,
                    q.number_width, q.start_number, q.offline_block_size,
                    q.practitioner_key, q.room_key
               FROM queue.queue_definitions q
              WHERE q.branch_id = $1::uuid AND q.kind = 'doctor'
                AND q.practitioner_key = $2::uuid
                AND q.active AND q.deleted_at IS NULL
              ORDER BY q.created_at
              LIMIT 1`,
            [branchId, practitionerKey],
          )
        : await tx.maybeOne<QueueDefinition>(
            `SELECT q.id, q.branch_id, q.series_prefix, q.series_scope::text AS series_scope,
                    q.number_width, q.start_number, q.offline_block_size,
                    q.practitioner_key, q.room_key
               FROM queue.queue_definitions q
              WHERE q.id = $1::uuid AND q.active AND q.deleted_at IS NULL`,
            [queueId],
          );

    if (found === undefined) {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'No active queue is configured for this doctor at this branch, so no token can be issued.',
        { nextAction: 'Ask an administrator to configure the doctor’s OPD queue (EN-006).' },
      );
    }
    if (found.branch_id !== branchId) {
      // Another branch's queue would put the patient on a board in a different
      // building. RLS lets it through — same hospital — so this is a real check.
      throw new AppError(ProblemType.BUSINESS_RULE_VIOLATED, 'That queue belongs to a different branch.');
    }
    return found;
  }

  /**
   * Allocates the next number and writes the token, its queue event and its
   * `queue.token.issued` outbox row.
   *
   * The number comes from an `UPDATE … RETURNING` on `queue.queue_token_series`,
   * which takes the row lock and holds it until the caller commits: two counters
   * checking patients in at the same instant cannot be handed the same number.
   * `queue_token_series_offline_boundary` is the backstop — the online allocator
   * may never reach into the block reserved for offline counters (EN-006 §3.6).
   */
  async issue(tx: TransactionClient, input: IssueTokenInput): Promise<IssuedToken> {
    const ctx = getContext();
    const scopeKey = input.queue.series_scope === 'per_doctor' ? input.practitionerKey : input.queue.id;

    await tx.query(
      `INSERT INTO queue.queue_token_series (
         id, hospital_id, branch_id, queue_id, scope_key, series_date, prefix,
         number_width, start_number, last_number, offline_reserved_from, issued_count, updated_at
       ) VALUES ($1, $2, $3::uuid, $4::uuid, $5, $6::date, $7, $8, $9, 0, $10, 0, now())
       ON CONFLICT (queue_id, scope_key, series_date) DO NOTHING`,
      [
        newId(),
        ctx.hospitalId,
        input.branchId,
        input.queue.id,
        scopeKey,
        input.seriesDate,
        input.queue.series_prefix,
        input.queue.number_width,
        input.queue.start_number,
        // Everything at or above this belongs to the offline counters' blocks.
        Math.max(input.queue.start_number + 1, 900),
      ],
    );

    const series = await mapConstraints(async () =>
      tx.one<{ last_number: number; prefix: string; number_width: number }>(
        `UPDATE queue.queue_token_series
            SET last_number = GREATEST(last_number + 1, start_number),
                issued_count = issued_count + 1,
                updated_at = now(), version = version + 1
          WHERE queue_id = $1::uuid AND scope_key = $2 AND series_date = $3::date
          RETURNING last_number, prefix, number_width`,
        [input.queue.id, scopeKey, input.seriesDate],
      ),
    );

    const decision = priorityFor(input.priority);
    const tokenId = newId();
    const tokenDisplay = `${series.prefix}${String(series.last_number).padStart(series.number_width, '0')}`;

    await tx.query(
      `INSERT INTO queue.queue_tokens (
         id, hospital_id, branch_id, queue_id, series_date, token_no, token_display,
         patient_id, visit_id, appointment_id, practitioner_key, room_key,
         source, class, priority_rank, priority_reason, status,
         appointment_due_at, issued_by, updated_at
       ) VALUES (
         $1, $2, $3::uuid, $4::uuid, $5::date, $6, $7,
         $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid,
         $13::queue."QueueTokenSource", $14::queue."QueueTokenClass", $15, $16, 'waiting',
         $17::timestamptz, $18, now()
       )`,
      [
        tokenId,
        ctx.hospitalId,
        input.branchId,
        input.queue.id,
        input.seriesDate,
        series.last_number,
        tokenDisplay,
        input.patientId,
        input.visitId,
        input.appointmentId,
        input.practitionerKey,
        input.roomKey ?? input.queue.room_key,
        input.source,
        decision.tokenClass,
        decision.rank,
        decision.reason,
        input.appointmentDueAt,
        ctx.userId,
      ],
    );

    await this.writeQueueEvent(tx, {
      queueId: input.queue.id,
      branchId: input.branchId,
      tokenId,
      tokenDisplay,
      event: 'issued',
      fromStatus: null,
      toStatus: 'waiting',
      reason: decision.reason,
    });

    await this.outbox.publish(
      tx,
      // `queue.token.issued` carries the token number as a *string* because the
      // display value ("A007") is what the TV board and the SMS show; the integer
      // is an implementation detail of the series.
      schedulingEvent('queue.token.issued', tokenId, {
        tokenId,
        queueId: input.queue.id,
        tokenNo: tokenDisplay,
        priorityWeight: decision.rank,
        issuedAt: new Date().toISOString(),
      }),
    );

    return {
      id: tokenId,
      queueId: input.queue.id,
      tokenNo: series.last_number,
      tokenDisplay,
      priorityRank: decision.rank,
      tokenClass: decision.tokenClass,
      seriesDate: input.seriesDate,
    };
  }

  /** Voids a live token — used when the visit behind it is cancelled. */
  async cancel(tx: TransactionClient, tokenId: string, branchId: string, reason: string): Promise<void> {
    const token = await tx.maybeOne<{
      id: string;
      queue_id: string;
      token_display: string;
      status: string;
    }>(
      `UPDATE queue.queue_tokens
          SET status = 'cancelled', cancel_reason = $2, updated_at = now(), version = version + 1
        WHERE id = $1::uuid
          AND status NOT IN ('served', 'cancelled', 'expired', 'transferred')
        RETURNING id, queue_id, token_display, status::text AS status`,
      [tokenId, reason],
    );
    if (token === undefined) return;

    await this.writeQueueEvent(tx, {
      queueId: token.queue_id,
      branchId,
      tokenId: token.id,
      tokenDisplay: token.token_display,
      event: 'cancelled',
      fromStatus: null,
      toStatus: 'cancelled',
      reason,
    });
  }

  /**
   * Moves a waiting patient to another doctor's queue (OP-001 §3.5.4).
   *
   * A transfer issues a *new* number in the destination queue rather than
   * carrying the old one across: the two queues have independent series, and a
   * duplicate number on a board is a patient called by the wrong room.
   */
  async transfer(
    tx: TransactionClient,
    input: {
      readonly fromTokenId: string;
      readonly branchId: string;
      readonly queue: QueueDefinition;
      readonly seriesDate: string;
      readonly patientId: string;
      readonly visitId: string;
      readonly appointmentId: string | null;
      readonly practitionerKey: string;
      readonly roomKey: string | null;
      readonly source: string;
      readonly priority: PriorityInput;
      readonly reason: string;
    },
  ): Promise<IssuedToken> {
    const previous = await tx.maybeOne<{ queue_id: string; token_display: string }>(
      `UPDATE queue.queue_tokens
          SET status = 'transferred', transfer_reason = $2, updated_at = now(), version = version + 1
        WHERE id = $1::uuid
          AND status NOT IN ('served', 'cancelled', 'expired')
        RETURNING queue_id, token_display`,
      [input.fromTokenId, input.reason],
    );
    if (previous === undefined) {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'That token has already been served or cancelled and cannot be transferred.',
      );
    }

    const issued = await this.issue(tx, {
      branchId: input.branchId,
      queue: input.queue,
      seriesDate: input.seriesDate,
      patientId: input.patientId,
      visitId: input.visitId,
      appointmentId: input.appointmentId,
      practitionerKey: input.practitionerKey,
      roomKey: input.roomKey,
      source: input.source,
      priority: input.priority,
      appointmentDueAt: null,
    });

    await tx.query(
      `UPDATE queue.queue_tokens
          SET transfer_to_token_id = $2::uuid, updated_at = now()
        WHERE id = $1::uuid`,
      [input.fromTokenId, issued.id],
    );
    await tx.query(
      `UPDATE queue.queue_tokens
          SET transfer_from_token_id = $2::uuid, updated_at = now()
        WHERE id = $1::uuid`,
      [issued.id, input.fromTokenId],
    );

    await this.writeQueueEvent(tx, {
      queueId: previous.queue_id,
      branchId: input.branchId,
      tokenId: input.fromTokenId,
      tokenDisplay: previous.token_display,
      event: 'transferred',
      fromStatus: null,
      toStatus: 'transferred',
      reason: input.reason,
    });

    await this.outbox.publish(
      tx,
      schedulingEvent('queue.token.transferred', input.fromTokenId, {
        tokenId: input.fromTokenId,
        fromQueueId: previous.queue_id,
        toQueueId: issued.queueId,
        reason: input.reason,
      }),
    );

    return issued;
  }

  private async writeQueueEvent(
    tx: TransactionClient,
    input: {
      readonly queueId: string;
      readonly branchId: string;
      readonly tokenId: string;
      readonly tokenDisplay: string;
      readonly event: string;
      readonly fromStatus: string | null;
      readonly toStatus: string | null;
      readonly reason: string;
    },
  ): Promise<void> {
    const ctx = getContext();
    await tx.query(
      `INSERT INTO queue.queue_events (
         id, hospital_id, branch_id, queue_id, token_id, token_display, event,
         from_status, to_status, actor_id, actor_type, reason
       ) VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6, $7::queue."QueueEventKind",
                 $8::queue."QueueTokenStatus", $9::queue."QueueTokenStatus", $10, $11, $12)`,
      [
        newId(),
        ctx.hospitalId,
        input.branchId,
        input.queueId,
        input.tokenId,
        input.tokenDisplay,
        input.event,
        input.fromStatus,
        input.toStatus,
        ctx.userId,
        ctx.userId === null ? 'system' : 'user',
        input.reason,
      ],
    );
  }
}
