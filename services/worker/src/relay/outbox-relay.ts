import type { Pool } from 'pg';
import type Redis from 'ioredis';

/**
 * Step 10 of `docs/01` §3 — relays committed outbox rows to Redis Streams.
 *
 * Three properties make this safe to run continuously, and each exists because
 * the obvious implementation is wrong in a way that only shows up in production:
 *
 * **`FOR UPDATE SKIP LOCKED`.** Several worker replicas poll the same table. A
 * plain `SELECT … LIMIT n` would hand the same rows to every replica and publish
 * each event as many times as there are workers. `SKIP LOCKED` lets each replica
 * take a disjoint slice without any of them waiting.
 *
 * **At least once, never at most once.** The row is marked published only after
 * the stream write returns. A crash between the two republishes the event, which
 * consumers absorb by deduping on event id (`docs/01` §5). The opposite ordering
 * would lose events silently — a bill finalised with no claim ever raised.
 *
 * **Failures are counted, not swallowed.** `attempts` and `last_error` are
 * written back, and a row that exhausts its attempts is dead-lettered rather than
 * retried forever, so one poisoned payload cannot stall the queue behind it.
 */
export interface OutboxRelayOptions {
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  /** Stream key per hospital keeps one busy tenant from starving the others. */
  readonly streamKey?: (hospitalId: string) => string;
  /**
   * Approximate cap on entries kept per hospital stream.
   *
   * The stream is a **transport, not a store**: `core.outbox_events` is the
   * record and it is retained on its own schedule. Until this existed the
   * relay wrote with no cap at all, so every event a hospital had ever emitted
   * stayed in Redis for ever -- unbounded memory on the same instance that
   * holds sessions, rate limits and the BullMQ queues.
   *
   * It also bounds the one-off replay a new consumer group takes when it starts
   * at the beginning of a stream, which is what
   * `services/realtime`'s consumer does so that an event written moments before
   * it discovered the stream is not silently lost.
   *
   * `~` is deliberate: exact trimming makes XADD O(N) in the number of entries
   * removed, approximate trimming lets Redis drop whole macro-nodes and stay
   * O(1). Slightly more than `maxLen` may survive, which costs nothing.
   */
  readonly maxLen?: number;
}

interface OutboxRow {
  id: string;
  hospital_id: string;
  branch_id: string | null;
  aggregate: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number;
  payload: unknown;
  contains_phi: boolean;
  correlation_id: string;
  trace_id: string | null;
  occurred_at: Date;
  /**
   * The exact stored value as text. `occurred_at` is `timestamptz(6)` and a JS
   * `Date` holds only milliseconds, so a round-tripped Date silently loses the
   * microseconds — and since `occurred_at` is half of the partitioned primary
   * key, an UPDATE keyed on it would match zero rows and every event would be
   * relayed forever.
   */
  occurred_at_text: string;
  attempts: number;
}

export interface RelayResult {
  readonly published: number;
  readonly failed: number;
  readonly deadLettered: number;
}

export async function relayOnce(
  pool: Pool,
  redis: Redis,
  options: OutboxRelayOptions = {},
): Promise<RelayResult> {
  const batchSize = options.batchSize ?? 200;
  const maxAttempts = options.maxAttempts ?? 10;
  const streamKey = options.streamKey ?? ((hospitalId: string) => `hms:events:${hospitalId}`);
  const maxLen = options.maxLen ?? 10_000;

  const client = await pool.connect();
  let published = 0;
  let failed = 0;
  let deadLettered = 0;

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<OutboxRow>(
      `SELECT id, hospital_id, branch_id, aggregate, aggregate_id, event_type,
              schema_version, payload, contains_phi, correlation_id, trace_id,
              occurred_at, occurred_at::text AS occurred_at_text, attempts
         FROM core.outbox_events
        WHERE published_at IS NULL
          AND dead_lettered_at IS NULL
        ORDER BY occurred_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
    );

    for (const row of rows) {
      try {
        await redis.xadd(
          streamKey(row.hospital_id),
          'MAXLEN',
          '~',
          maxLen,
          '*',
          'id',
          row.id,
          'type',
          row.event_type,
          'aggregate',
          row.aggregate,
          'aggregateId',
          row.aggregate_id,
          'schemaVersion',
          String(row.schema_version),
          'hospitalId',
          row.hospital_id,
          'branchId',
          row.branch_id ?? '',
          'correlationId',
          row.correlation_id,
          'traceId',
          row.trace_id ?? '',
          'occurredAt',
          row.occurred_at.toISOString(),
          'containsPhi',
          row.contains_phi ? '1' : '0',
          'payload',
          JSON.stringify(row.payload),
        );

        await client.query(
          `UPDATE core.outbox_events SET published_at = now()
            WHERE id = $1 AND occurred_at = $2::timestamptz`,
          [row.id, row.occurred_at_text],
        );
        published += 1;
      } catch (error) {
        const attempts = row.attempts + 1;
        const message = error instanceof Error ? error.message : String(error);
        const exhausted = attempts >= maxAttempts;

        await client.query(
          `UPDATE core.outbox_events
              SET attempts = $3,
                  last_error = $4,
                  dead_lettered_at = CASE WHEN $5 THEN now() ELSE dead_lettered_at END
            WHERE id = $1 AND occurred_at = $2::timestamptz`,
          [row.id, row.occurred_at_text, attempts, message.slice(0, 2000), exhausted],
        );

        if (exhausted) deadLettered += 1;
        else failed += 1;
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  return { published, failed, deadLettered };
}
