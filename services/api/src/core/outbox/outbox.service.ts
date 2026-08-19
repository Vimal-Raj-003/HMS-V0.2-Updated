import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { getContext } from '../context/request-context.js';
import type { TransactionClient } from '../db/database.service.js';

/**
 * The transactional outbox — `docs/01` §3 step 8, relayed at step 10.
 *
 * The event row is written in the **same transaction** as the fact it announces.
 * Publishing to Redis directly from the request would create the one failure mode
 * a hospital cannot tolerate: a bill finalised but no `bill.finalized` event, so
 * the claim is never raised and nobody notices for a month. Either both land or
 * neither does. `services/worker` relays committed rows to Redis Streams at least
 * once, and consumers dedupe on event id.
 */
export interface OutboxEvent {
  /** `<aggregate>.<past-tense-fact>`, from the registry in packages/contracts. */
  readonly eventType: string;
  readonly aggregate: string;
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly aggregateVersion?: number | null;
  readonly schemaVersion?: number;
  /** Marks the row PHI-bearing so retention and redaction treat it correctly. */
  readonly containsPhi?: boolean;
  /** The event that caused this one, for tracing a chain of consequences. */
  readonly causationId?: string | null;
  /** Days to keep after publish. Compliance-evidence events outlive the 7-day purge. */
  readonly retentionDays?: number;
}

@Injectable()
export class OutboxService {
  async publish(tx: TransactionClient, event: OutboxEvent): Promise<string> {
    const ctx = getContext();
    const id = newId();

    await tx.query(
      `INSERT INTO core.outbox_events (
         id, hospital_id, branch_id,
         aggregate, aggregate_id, aggregate_version,
         event_type, schema_version, payload, contains_phi,
         actor_user_id, actor_type,
         correlation_id, causation_id, trace_id,
         occurred_at, retention_days
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6,
         $7, $8, $9::jsonb, $10,
         $11, $12,
         $13, $14, $15,
         now(), $16
       )`,
      [
        id,
        ctx.hospitalId,
        ctx.branchId,
        event.aggregate,
        event.aggregateId,
        event.aggregateVersion ?? null,
        event.eventType,
        event.schemaVersion ?? 1,
        JSON.stringify(event.payload),
        event.containsPhi ?? false,
        ctx.userId,
        ctx.userId === null ? 'system' : 'user',
        // `correlation_id` is NOT NULL: every event must be traceable back to the
        // request that produced it, or an integration failure cannot be explained.
        ctx.traceId,
        event.causationId ?? null,
        ctx.traceId,
        event.retentionDays ?? 7,
      ],
    );

    return id;
  }
}
