/**
 * One analyzer connection, as a function from bytes to bytes.
 *
 * There is no socket in this file. `receive(chunk)` returns what to write back,
 * and `AnalyzerListener` is the thin thing that owns the `net.Socket` and
 * copies between the two. Everything that could go wrong on an interface —
 * partial frames, a checksum failure, a duplicate control id, a host query that
 * must be answered inside two seconds, a downstream that has stopped answering
 * — is exercised in tests without opening a port, and the simulator drives the
 * same code the production socket does.
 *
 * ── Where "persist before acknowledge" actually happens ─────────────────────
 *
 * Twice, in two different layers, because the two protocols differ:
 *
 *  * **HL7/MLLP** — `ingress.accept()` is awaited, and only then is the ACK
 *    frame written. The ACK cannot be produced before the commit because the
 *    decision that shapes it (`AA`/`AE`/`AR`) is the commit's return value.
 *  * **ASTM/E1381** — `AstmReceiver` withholds the link acknowledgement of the
 *    frame that completes a transmission; this session calls `confirm(stored)`
 *    with the outcome of the same awaited commit. A failed store NAKs, and the
 *    analyzer retransmits.
 *
 * If the database is unreachable, `accept()` throws — and the `catch` here
 * deliberately does **not** acknowledge. The analyzer keeps the results and
 * resends, which is the only correct behaviour when this service cannot
 * remember what it was told.
 */
import type { IntegrationDatabase, TenantContext } from '../db/database.js';
import type { AdapterLogger, Clock } from '../adapter/types.js';
import { MllpDecoder, MllpFramingError, mllpFrame } from '../hl7/mllp.js';
import { buildRejectAck } from '../hl7/ack.js';
import { AstmSender, AstmReceiver } from '../astm/session.js';
import type { AnalyzerHostQuery, AnalyzerOrder } from './canonical.js';
import { astmRecordsToBuffer, type AnalyzerDriver } from './driver.js';
import { LabIfMessageStore } from './message-store.js';
import { LabIfWorklistCache, toAnalyzerOrder } from './worklist-cache.js';
import type { AnalyzerIngress } from './ingress.js';
import type { AnalyzerInstrument } from './types.js';

export interface AnalyzerSessionDeps {
  readonly db: IntegrationDatabase;
  readonly ingress: AnalyzerIngress;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly logger: AdapterLogger;
  readonly messages?: LabIfMessageStore;
  readonly worklist?: LabIfWorklistCache;
  /** How many orders a wildcard host query may be answered with. */
  readonly wildcardLimit?: number;
  /** Notifies the gateway that a frame was stored, so it can wake the forwarder. */
  readonly onStored?: () => void;
  /** An open downtime to count buffered frames against. */
  readonly currentOutage?: () => string | undefined;
}

export class AnalyzerSession {
  private readonly mllp: MllpDecoder;
  private readonly astm = new AstmReceiver();
  private readonly messages: LabIfMessageStore;
  private readonly worklist: LabIfWorklistCache;
  /** Set while *we* are transmitting to the analyzer (ASTM is half-duplex). */
  private sender: AstmSender | undefined;
  private pendingOutbound: readonly string[][] = [];

  constructor(
    readonly instrument: AnalyzerInstrument,
    private readonly driver: AnalyzerDriver,
    private readonly ctx: TenantContext,
    private readonly deps: AnalyzerSessionDeps,
  ) {
    this.mllp = new MllpDecoder(
      instrument.connection.maxFrameBytes === undefined
        ? {}
        : { maxFrameBytes: instrument.connection.maxFrameBytes },
    );
    this.messages = deps.messages ?? new LabIfMessageStore();
    this.worklist = deps.worklist ?? new LabIfWorklistCache();
  }

  /** Feeds inbound bytes and returns the bytes to write back. */
  async receive(chunk: Buffer): Promise<Buffer> {
    return this.instrument.protocol === 'hl7_v2' ? this.receiveHl7(chunk) : this.receiveAstm(chunk);
  }

  /** Queues an outbound ASTM transmission (an order broadcast). */
  queueAstmTransmission(records: readonly string[]): void {
    this.pendingOutbound = [...this.pendingOutbound, [...records]];
  }

  /** Starts the next queued ASTM transmission, if the link is free. */
  startPendingTransmission(): Buffer {
    if (this.sender !== undefined || this.astm.awaitingConfirmation) return Buffer.alloc(0);
    const [next, ...rest] = this.pendingOutbound;
    if (next === undefined) return Buffer.alloc(0);
    this.pendingOutbound = rest;
    this.sender = new AstmSender(next);
    return this.sender.start().write;
  }

  reset(): void {
    this.mllp.reset();
    this.astm.reset();
    this.sender = undefined;
  }

  // ── HL7 v2 over MLLP ───────────────────────────────────────────────────────

  private async receiveHl7(chunk: Buffer): Promise<Buffer> {
    let frames: readonly Buffer[];
    try {
      frames = this.mllp.push(chunk);
    } catch (error) {
      if (!(error instanceof MllpFramingError)) throw error;
      this.mllp.reset();
      this.deps.logger.warn(
        { instrumentId: this.instrument.id, code: error.code },
        'MLLP framing fault: the peer sent no end block within the frame limit',
      );
      return mllpFrame(
        buildRejectAck({
          identity: {
            sendingApplication: this.instrument.connection.sendingApplication,
            sendingFacility: this.instrument.connection.sendingFacility,
            defaultVersion: this.instrument.connection.hl7Version,
          },
          reason: 'the frame exceeded the maximum size with no end block',
          errorCode: error.code,
          controlId: this.deps.newId(),
          now: this.deps.clock.now(),
        }),
      );
    }

    const replies: Buffer[] = [];
    for (const raw of frames) {
      const reply = await this.handleFrame(raw);
      if (reply.length > 0) replies.push(mllpFrame(reply));
    }
    return Buffer.concat(replies);
  }

  /** One complete application message: store it, then answer it. */
  private async handleFrame(raw: Buffer): Promise<Buffer> {
    const outage = this.deps.currentOutage?.();
    const accepted = await this.deps.ingress.accept({
      ctx: this.ctx,
      instrument: this.instrument,
      driver: this.driver,
      raw,
      ...(outage === undefined ? {} : { downtimeId: outage }),
    });

    if (accepted.inbound?.kind === 'host_query') {
      return this.answerQuery(accepted.inbound.query, raw);
    }

    if (accepted.decision.kind === 'stored') this.deps.onStored?.();

    const ack = this.driver.acknowledge({
      raw,
      decision: accepted.decision,
      instrument: this.instrument,
      controlId: this.deps.newId(),
      now: this.deps.clock.now(),
    });
    return ack ?? Buffer.alloc(0);
  }

  // ── ASTM E1381/E1394 ───────────────────────────────────────────────────────

  private async receiveAstm(chunk: Buffer): Promise<Buffer> {
    // While we hold the link, the analyzer's bytes are answers to our frames.
    if (this.sender !== undefined) {
      const step = this.sender.push(chunk);
      if (this.sender.finished) {
        if (!this.sender.succeeded) {
          this.deps.logger.warn(
            { instrumentId: this.instrument.id, detail: step.detail ?? '' },
            'ASTM order transmission failed; the order stays queued',
          );
        }
        this.sender = undefined;
      }
      return step.write;
    }

    const writes: Buffer[] = [];
    let outcome = this.astm.push(chunk);

    for (;;) {
      if (outcome.reply.length > 0) writes.push(outcome.reply);
      for (const rejected of outcome.rejected) {
        this.deps.logger.warn(
          { instrumentId: this.instrument.id, detail: rejected },
          'ASTM frame rejected; the analyzer will retransmit',
        );
      }

      const transmission = outcome.transmissions[0];
      if (transmission === undefined) break;

      const raw = astmRecordsToBuffer(transmission.records);
      const reply = await this.handleAstmTransmission(raw);
      const stored = reply.stored;
      if (reply.write.length > 0) writes.push(reply.write);

      if (!transmission.awaitingConfirmation) break;
      outcome = this.astm.confirm(stored);
    }

    const pending = this.startPendingTransmission();
    if (pending.length > 0) writes.push(pending);
    return Buffer.concat(writes);
  }

  private async handleAstmTransmission(
    raw: Buffer,
  ): Promise<{ readonly stored: boolean; readonly write: Buffer }> {
    const outage = this.deps.currentOutage?.();
    let accepted;
    try {
      accepted = await this.deps.ingress.accept({
        ctx: this.ctx,
        instrument: this.instrument,
        driver: this.driver,
        raw,
        ...(outage === undefined ? {} : { downtimeId: outage }),
      });
    } catch (error) {
      // The store is unreachable. Refuse the frame rather than acknowledge
      // something we cannot remember; the analyzer keeps it and resends.
      this.deps.logger.error(
        { instrumentId: this.instrument.id },
        'ASTM transmission could not be stored; the acknowledgement is withheld',
      );
      if (error instanceof Error) return { stored: false, write: Buffer.alloc(0) };
      return { stored: false, write: Buffer.alloc(0) };
    }

    if (accepted.inbound?.kind === 'host_query') {
      // The query itself is stored; the answer is a transmission we initiate
      // once the analyzer has released the link with its `<EOT>`.
      const orders = await this.ordersFor(accepted.inbound.query);
      const records = this.driver
        .renderQueryReply({
          query: accepted.inbound.query,
          orders,
          instrument: this.instrument,
          controlId: this.deps.newId(),
          now: this.deps.clock.now(),
        })
        .toString('latin1')
        .split('\r')
        .filter((record) => record.trim().length > 0);
      this.queueAstmTransmission(records);
      await this.recordOutbound(astmRecordsToBuffer(records), 'ASTM_O');
      return { stored: true, write: Buffer.alloc(0) };
    }

    if (accepted.decision.kind === 'stored') this.deps.onStored?.();
    const stored = accepted.decision.kind === 'stored' || accepted.decision.kind === 'duplicate';
    return { stored, write: Buffer.alloc(0) };
  }

  // ── host query ─────────────────────────────────────────────────────────────

  /**
   * `EN-004 §14.2`: the reply is due inside two seconds because the analyzer
   * times out and aspirates without the order. One indexed read of the worklist
   * cache is the whole budget.
   */
  private async ordersFor(query: AnalyzerHostQuery): Promise<readonly AnalyzerOrder[]> {
    const now = this.deps.clock.now();
    const entries = await this.deps.db.withTenant(this.ctx, async (tx) =>
      query.isWildcard
        ? this.worklist.pending(tx, this.instrument.id, now, this.deps.wildcardLimit ?? 25)
        : this.worklist.byBarcode(tx, this.instrument.id, query.specimenIdRaw, now),
    );

    if (entries.length > 0) {
      await this.deps.db.withTenant(this.ctx, (tx) =>
        this.worklist.markSent(
          tx,
          entries.map((entry) => entry.id),
          now,
        ),
      );
    }
    return entries.map(toAnalyzerOrder);
  }

  private async answerQuery(query: AnalyzerHostQuery, raw: Buffer): Promise<Buffer> {
    const orders = await this.ordersFor(query);
    const reply = this.driver.renderQueryReply({
      query,
      orders,
      instrument: this.instrument,
      controlId: this.deps.newId(),
      now: this.deps.clock.now(),
    });
    await this.recordInbound(raw, 'QUERY', query.controlId);
    await this.recordOutbound(reply, 'RSP^K11');
    return reply;
  }

  private async recordInbound(raw: Buffer, msgType: string, controlId: string): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.db.withTenant(this.ctx, (tx) =>
      this.messages.persist(tx, {
        id: this.deps.newId(),
        hospitalId: this.instrument.hospitalId,
        branchId: this.instrument.branchId,
        instrumentId: this.instrument.id,
        direction: 'inbound',
        msgType,
        controlId: controlId.length > 0 ? controlId : this.deps.newId(),
        raw,
        parsed: { kind: 'host_query' },
        status: 'parsed',
        receivedAt: now,
      }),
    );
  }

  private async recordOutbound(raw: Buffer, msgType: string): Promise<void> {
    const now = this.deps.clock.now();
    await this.deps.db.withTenant(this.ctx, (tx) =>
      this.messages.persist(tx, {
        id: this.deps.newId(),
        hospitalId: this.instrument.hospitalId,
        branchId: this.instrument.branchId,
        instrumentId: this.instrument.id,
        direction: 'outbound',
        msgType,
        controlId: this.deps.newId(),
        raw,
        parsed: { kind: 'query_reply' },
        status: 'acked',
        receivedAt: now,
      }),
    );
  }
}
