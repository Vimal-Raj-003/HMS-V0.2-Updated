import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { RoomName } from '../rooms/rooms.js';
import { routeEvent, type StreamEvent } from './event-router.js';

/**
 * The missing half of `docs/01 §3` step 10.
 *
 * `services/worker` relays committed outbox rows to `hms:events:<hospitalId>`.
 * Nothing read them. This does, and hands each event to the router, which
 * decides the rooms.
 *
 * **A consumer group, not `XREAD`.** Several realtime pods run at once; a plain
 * `XREAD` would deliver every event to every pod and push each board update N
 * times. `XREADGROUP` with one group and a per-pod consumer name gives each pod
 * a disjoint slice — the same reasoning as `FOR UPDATE SKIP LOCKED` in the
 * relay.
 *
 * **Acknowledged after delivery, not before.** A crash between read and push
 * redelivers, and a board that receives the same diff twice renders the same
 * state twice. The opposite ordering loses a bed release or a critical alert.
 *
 * **One stream per hospital, discovered.** The relay's key is per tenant so one
 * busy hospital cannot starve the others, so there is no single stream to read.
 * Keys are rediscovered on a slow interval; a hospital that registers between
 * scans starts flowing on the next one, which is the right trade for a `SCAN`
 * that must not run on every tick.
 *
 * **PHI is never logged.** Every log line here carries ids, types and counts.
 * The payload is not logged at any level, including on the error path, which is
 * where it is usually leaked.
 */

export interface StreamConsumerOptions {
  readonly redis: Redis;
  readonly logger: Logger;
  /** Where a routed event goes. Injected so this never imports the gateway. */
  readonly deliver: (room: RoomName, event: StreamEvent) => void;
  readonly group?: string;
  /** Unique per pod. Two pods sharing a name would split one pod's backlog. */
  readonly consumer: string;
  readonly batchSize?: number;
  /** How long `XREADGROUP` blocks when there is nothing to read. */
  readonly blockMs?: number;
  /** How often the key set is rescanned. */
  readonly discoveryIntervalMs?: number;
  /**
   * How long an entry may sit unacknowledged before another pod reclaims it.
   *
   * Acknowledging only after delivery is worthless on its own: it leaves the
   * entry pending, and a pending entry is redelivered to nobody. `XREADGROUP`
   * with `'>'` returns *new* entries only, so a pod that died mid-batch takes
   * its slice of the backlog to the grave -- including a critical alert. This
   * is the interval after which a surviving pod claims that work.
   */
  readonly reclaimIdleMs?: number;
  readonly keyPattern?: string;
}

export interface ConsumerTickResult {
  readonly streams: number;
  readonly delivered: number;
  /** Of `delivered`, how many were reclaimed from a pod that did not finish. */
  readonly reclaimed: number;
  readonly pushes: number;
  readonly unrouted: number;
  readonly withheldFromDisplays: number;
}

export interface StreamConsumer {
  /** One pass over every known stream. Exposed so a test drives it directly. */
  tick(): Promise<ConsumerTickResult>;
  discover(): Promise<readonly string[]>;
  start(): void;
  stop(): Promise<void>;
  readonly running: boolean;
}

function fieldsToEvent(id: string, fields: readonly string[]): StreamEvent | null {
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const key = fields[i];
    const value = fields[i + 1];
    if (key !== undefined && value !== undefined) map.set(key, value);
  }

  const type = map.get('type');
  const hospitalId = map.get('hospitalId');
  if (type === undefined || hospitalId === undefined) return null;

  let payload: Record<string, unknown> = {};
  try {
    const raw: unknown = JSON.parse(map.get('payload') ?? '{}');
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      payload = raw as Record<string, unknown>;
    }
  } catch {
    // A payload that will not parse is still routable by type, and dropping the
    // whole record would silently lose a critical alert because of a quoting
    // bug. The event goes on with an empty payload; rules that need a field
    // return no rooms rather than a wrong one.
    payload = {};
  }

  const branchId = map.get('branchId');
  return {
    id: map.get('id') ?? id,
    type,
    aggregate: map.get('aggregate') ?? '',
    aggregateId: map.get('aggregateId') ?? '',
    hospitalId,
    branchId: branchId === undefined || branchId === '' ? null : branchId,
    containsPhi: map.get('containsPhi') === '1',
    occurredAt: map.get('occurredAt') ?? new Date(0).toISOString(),
    payload,
  };
}

export function createStreamConsumer(options: StreamConsumerOptions): StreamConsumer {
  const {
    redis,
    logger,
    deliver,
    consumer,
    group = 'realtime',
    batchSize = 200,
    blockMs = 1_000,
    discoveryIntervalMs = 30_000,
    reclaimIdleMs = 60_000,
    keyPattern = 'hms:events:*',
  } = options;

  let streams: string[] = [];
  let lastDiscovery = 0;
  let stopped = true;
  let inFlight: Promise<void> | null = null;

  async function discover(): Promise<readonly string[]> {
    const found: string[] = [];
    let cursor = '0';
    do {
      // SCAN rather than KEYS: KEYS blocks the whole server, and this runs
      // against the same Redis the queues and sessions use.
      const [next, batch] = await redis.scan(cursor, 'MATCH', keyPattern, 'COUNT', 200);
      cursor = next;
      found.push(...batch);
    } while (cursor !== '0');

    streams = [...new Set(found)].sort();
    lastDiscovery = Date.now();
    return streams;
  }

  async function ensureGroup(stream: string): Promise<void> {
    try {
      // `MKSTREAM` so a stream the relay has not written to yet still gets a
      // group.
      //
      // **`'0'`, not `'$'`.** `'$'` means "everything already in this stream is
      // history, start from the next entry", and that quietly loses every event
      // written between the relay creating the stream and this pod discovering
      // it -- a window of up to `discoveryIntervalMs`, and the first thing a
      // brand-new hospital emits falls squarely inside it. For a board that is a
      // stale tile; for `lab.result.critical` it is an alert nobody was shown.
      //
      // The cost is a one-off replay of whatever the stream still holds, which
      // happens once per stream ever, because the group's position is persisted
      // and `XACK`ed entries are not redelivered. It is bounded because the
      // relay now writes with `MAXLEN ~ 10000`; before that the stream was
      // unbounded and this choice would have replayed a hospital's entire
      // history onto every screen.
      //
      // A duplicate diff is absorbed by a board; a missed critical alert is not
      // absorbed by anything.
      await redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('BUSYGROUP')) throw error;
    }
  }

  interface Totals {
    delivered: number;
    reclaimed: number;
    pushes: number;
    unrouted: number;
    withheld: number;
  }

  /**
   * Route one batch and acknowledge it.
   *
   * Returns the ids handled. Acknowledgement happens **after** every delivery in
   * the batch, never before: a crash between the two redelivers a diff, which a
   * board absorbs, whereas acknowledging first drops the entry on the floor.
   */
  async function handle(stream: string, entries: [string, string[]][], totals: Totals): Promise<void> {
    const acknowledge: string[] = [];
    for (const [entryId, fields] of entries) {
      const event = fieldsToEvent(entryId, fields);
      if (event === null) {
        // Unparseable beyond recovery. Acknowledged so it cannot block the
        // group forever, and logged loudly with no payload.
        logger.warn({ event: 'realtime.stream.undecodable', stream, entryId });
        acknowledge.push(entryId);
        continue;
      }

      const decision = routeEvent(event);
      if (decision.unrouted) totals.unrouted += 1;
      totals.withheld += decision.withheldFromDisplays;
      for (const room of decision.rooms) {
        deliver(room, event);
        totals.pushes += 1;
      }
      totals.delivered += 1;
      acknowledge.push(entryId);
    }

    if (acknowledge.length > 0) await redis.xack(stream, group, ...acknowledge);
  }

  /**
   * Take over entries a pod read and never acknowledged.
   *
   * Without this, "acknowledge after delivery" is a comment rather than a
   * guarantee -- the entry stays pending and `'>'` never returns it again.
   */
  async function reclaim(stream: string, totals: Totals): Promise<void> {
    const [, entries] = (await redis.xautoclaim(
      stream,
      group,
      consumer,
      reclaimIdleMs,
      '0',
      'COUNT',
      batchSize,
    )) as [string, [string, string[]][]];

    if (entries.length === 0) return;
    logger.warn({ event: 'realtime.stream.reclaimed', stream, count: entries.length });
    const before = totals.delivered;
    await handle(stream, entries, totals);
    totals.reclaimed += totals.delivered - before;
  }

  async function drain(stream: string, result: Totals): Promise<void> {
    await ensureGroup(stream);
    await reclaim(stream, result);

    const response = (await redis.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      batchSize,
      'BLOCK',
      blockMs,
      'STREAMS',
      stream,
      '>',
    )) as [string, [string, string[]][]][] | null;

    if (response === null) return;

    for (const [, entries] of response) {
      await handle(stream, entries, result);
    }
  }

  async function tick(): Promise<ConsumerTickResult> {
    if (streams.length === 0 || Date.now() - lastDiscovery > discoveryIntervalMs) {
      await discover();
    }

    const totals: Totals = { delivered: 0, reclaimed: 0, pushes: 0, unrouted: 0, withheld: 0 };
    for (const stream of streams) {
      await drain(stream, totals);
    }

    return {
      streams: streams.length,
      delivered: totals.delivered,
      reclaimed: totals.reclaimed,
      pushes: totals.pushes,
      unrouted: totals.unrouted,
      withheldFromDisplays: totals.withheld,
    };
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await tick();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ event: 'realtime.stream.tick_failed', message });
        // Back off rather than hot-loop through a Redis outage.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }

  return {
    tick,
    discover,
    start(): void {
      if (!stopped) return;
      stopped = false;
      inFlight = loop();
    },
    async stop(): Promise<void> {
      stopped = true;
      await inFlight;
      inFlight = null;
    },
    get running(): boolean {
      return !stopped;
    },
  };
}
