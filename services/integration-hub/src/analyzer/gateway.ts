/**
 * The analyzer gateway: one object that owns the listeners, the ingress, the
 * store-and-forward loop and the unmatched queue, in the same spirit as
 * `hub.ts` owns the connector side.
 *
 * ── Why this is not an EN-017 connector ─────────────────────────────────────
 *
 * `ihub_connectors` is the right home for a partner reached by *us*: it has a
 * key, credentials, a retry policy and a circuit breaker, and `Dispatcher`
 * drives it. An analyzer is not that. Its configuration of record is
 * `integration.lab_instruments` — the table `EN-004 §4` defines, with its own
 * status ladder (`draft → verification → live → maintenance`), its own driver
 * key, its own connection block and its own downtime log — and the traffic that
 * matters flows *inbound*, from a socket the analyzer dials, which no
 * dispatcher can model.
 *
 * What is shared is deliberate rather than accidental: the same
 * `IntegrationDatabase`, the same `Clock` and id generator, the same
 * `redaction/phi-redactor.ts` on every stored payload, and the same rule that a
 * failure becomes a visible, owned row rather than a log line. Outbound orders
 * to a *middleware* endpoint (Data Innovations, cobas infinity) are a genuine
 * EN-017 connector and belong on the dispatcher; orders to an analyzer holding
 * an open socket go back down that socket, which is what `queueOrder` does.
 */
import type { Pool } from 'pg';
import { newId as defaultNewId } from '@vims/contracts';
import type { AdapterLogger, Clock } from '../adapter/types.js';
import { systemClock } from '../adapter/types.js';
import { IntegrationDatabase, type TenantContext } from '../db/database.js';
import { silentLogger } from '../logger.js';
import { driverFor } from './driver.js';
import { LabInstrumentDowntimeLog } from './downtime-log.js';
import { LabIfErrorQueue } from './error-queue.js';
import { AnalyzerForwarder, type DrainReport } from './forwarder.js';
import { AnalyzerIngress } from './ingress.js';
import { InstrumentStore } from './instrument-store.js';
import { AnalyzerListener } from './listener.js';
import { LabIfMessageStore } from './message-store.js';
import { AnalyzerSession } from './session.js';
import { LabIfWorklistCache, type CachedOrder } from './worklist-cache.js';
import type { AnalyzerInstrument, LabResultSink } from './types.js';

export interface AnalyzerGatewayOptions {
  readonly pool: Pool;
  readonly sink: LabResultSink;
  /**
   * The actor recorded on rows this service writes on its own initiative.
   * A real user id, provisioned per hospital — not a literal `'system'`, which
   * `core.accessible_hospital_ids()` would not resolve.
   */
  readonly systemUserId: string;
  readonly clock?: Clock;
  readonly newId?: () => string;
  readonly logger?: AdapterLogger;
  /** How many buffered messages one drain pass moves. */
  readonly drainBatchSize?: number;
}

export class AnalyzerGateway {
  readonly db: IntegrationDatabase;
  readonly instruments: InstrumentStore;
  readonly messages = new LabIfMessageStore();
  readonly errors = new LabIfErrorQueue();
  readonly worklist = new LabIfWorklistCache();
  readonly downtime = new LabInstrumentDowntimeLog();
  readonly ingress: AnalyzerIngress;
  readonly forwarder: AnalyzerForwarder;

  private readonly listeners = new Map<string, AnalyzerListener>();
  private readonly clock: Clock;
  private readonly newId: () => string;
  private readonly logger: AdapterLogger;
  private readonly drainBatchSize: number;

  constructor(private readonly options: AnalyzerGatewayOptions) {
    this.clock = options.clock ?? systemClock;
    this.newId = options.newId ?? defaultNewId;
    this.logger = options.logger ?? silentLogger;
    this.drainBatchSize = options.drainBatchSize ?? 100;

    this.db = new IntegrationDatabase(options.pool);
    this.instruments = new InstrumentStore(this.db);

    this.ingress = new AnalyzerIngress({
      db: this.db,
      clock: this.clock,
      newId: this.newId,
      logger: this.logger,
      messages: this.messages,
      errors: this.errors,
      downtime: this.downtime,
    });

    this.forwarder = new AnalyzerForwarder({
      db: this.db,
      sink: options.sink,
      instruments: this.instruments,
      clock: this.clock,
      newId: this.newId,
      logger: this.logger,
      messages: this.messages,
      errors: this.errors,
      downtime: this.downtime,
    });
  }

  /** The tenant scope an instrument's rows live in. */
  contextFor(instrument: AnalyzerInstrument): TenantContext {
    return {
      hospitalId: instrument.hospitalId,
      userId: this.options.systemUserId,
      scope: 'branch',
      branchIds: [instrument.branchId],
    };
  }

  /** A session for one connection. Framing state never survives a reconnect. */
  sessionFor(instrument: AnalyzerInstrument): AnalyzerSession {
    return new AnalyzerSession(instrument, driverFor(instrument), this.contextFor(instrument), {
      db: this.db,
      ingress: this.ingress,
      clock: this.clock,
      newId: this.newId,
      logger: this.logger,
      messages: this.messages,
      worklist: this.worklist,
      currentOutage: () => this.forwarder.currentOutage(instrument.id),
    });
  }

  /** Binds a listener for one instrument. Returns the port it is on. */
  async listen(instrument: AnalyzerInstrument, port?: number, host?: string): Promise<number> {
    const listener = new AnalyzerListener(instrument, {
      logger: this.logger,
      sessionFor: (target) => this.sessionFor(target),
      onDisconnect: (target, reason) => {
        this.logger.info(
          { instrumentId: target.id, instrumentCode: target.code, reason },
          'analyzer disconnected',
        );
      },
    });
    const bound = await listener.listen(port, host);
    this.listeners.set(instrument.id, listener);
    return bound;
  }

  /** Moves one instrument's buffered frames to the laboratory, oldest first. */
  async drain(instrument: AnalyzerInstrument): Promise<DrainReport> {
    return this.forwarder.drain(this.contextFor(instrument), instrument, driverFor(instrument), {
      limit: this.drainBatchSize,
    });
  }

  /**
   * Drains until the queue is empty or it stops making progress.
   *
   * "Stops making progress" is the recovery condition after an outage: the
   * first pass that reports `stopped` means the laboratory is still down, and
   * hammering it would only lengthen the outage.
   */
  async drainUntilIdle(instrument: AnalyzerInstrument, maxPasses = 100): Promise<DrainReport> {
    let report = await this.drain(instrument);
    let passes = 1;
    while (!report.stopped && report.remaining > 0 && passes < maxPasses) {
      report = await this.drain(instrument);
      passes += 1;
    }
    return report;
  }

  /**
   * `EN-004 §6` — `POST /messages/:id/replay`.
   *
   * The operator's button, and what the unmatched queue calls once a specimen
   * has been accessioned. Idempotent by the same key as a live frame: a replay
   * of an already-applied message is recognised, not re-applied.
   */
  async replay(instrument: AnalyzerInstrument, messageId: string): Promise<DrainReport | undefined> {
    const decision = await this.ingress.replay({
      ctx: this.contextFor(instrument),
      instrument,
      driver: driverFor(instrument),
      messageId,
    });
    if (decision.kind !== 'stored') {
      this.logger.warn({ instrumentId: instrument.id, messageId }, 'analyzer message could not be replayed');
      return undefined;
    }
    return this.drainUntilIdle(instrument);
  }

  /**
   * A technologist attaches an unmatched result to a specimen and it is applied.
   *
   * The assignment is written with the actor before anything is replayed, so
   * the audit trail names a person even if the replay then fails.
   */
  async assignUnmatched(
    instrument: AnalyzerInstrument,
    input: {
      readonly itemId: string;
      readonly sampleId: string;
      readonly resolvedBy: string;
      readonly resolution: string;
    },
  ): Promise<DrainReport | undefined> {
    const ctx = this.contextFor(instrument);
    const now = this.clock.now();
    const item = await this.db.withTenant(ctx, async (tx) => {
      const found = await this.errors.get(tx, input.itemId);
      if (found === undefined) return undefined;
      await this.errors.assign(tx, input.itemId, {
        sampleId: input.sampleId,
        resolvedBy: input.resolvedBy,
        resolution: input.resolution,
        at: now,
      });
      return found;
    });
    if (item?.messageId == null) return undefined;
    return this.replay(instrument, item.messageId);
  }

  /**
   * Publishes an order for a host-query analyzer to collect.
   *
   * `EN-004 §3.2.1`: a broadcast instrument is sent the order; a host-query one
   * is answered when it reads the barcode. This writes the cache entry both
   * kinds are served from, and the session sends it down the open socket for
   * the broadcast case.
   */
  async queueOrder(
    instrument: AnalyzerInstrument,
    input: {
      readonly sampleId: string;
      readonly barcode: string;
      readonly order: CachedOrder;
      readonly expiresAt: Date;
    },
  ): Promise<void> {
    const now = this.clock.now();
    await this.db.withTenant(this.contextFor(instrument), (tx) =>
      this.worklist.put(tx, {
        id: this.newId(),
        hospitalId: instrument.hospitalId,
        instrumentId: instrument.id,
        sampleId: input.sampleId,
        barcode: input.barcode,
        order: input.order,
        expiresAt: input.expiresAt,
        at: now,
      }),
    );
  }

  async shutdown(): Promise<void> {
    for (const listener of this.listeners.values()) await listener.close();
    this.listeners.clear();
  }
}
