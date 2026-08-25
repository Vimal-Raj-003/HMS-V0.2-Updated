/**
 * Persist, then acknowledge. This file is the whole of exit gate 7's first half.
 *
 * `EN-004 §13`: "no message loss (persist raw before ACK); at-least-once with
 * idempotent apply." Every ordering decision below follows from taking that
 * literally.
 *
 * ── The order of operations, and why it cannot be rearranged ────────────────
 *
 *   1. digest the frame                      — cheap, and the idempotency key
 *   2. parse it                              — a frame that cannot be read is
 *                                              retained and rejected, never
 *                                              half-applied
 *   3. look for an identical frame already   — `EN-004 §5`: "inbound message
 *      stored                                  hash + control id"
 *   4. INSERT … COMMIT                       — the durable write
 *   5. **return**, and only then does the    — the caller sends the ACK
 *      caller acknowledge
 *
 * Step 5 is enforced structurally: `accept()` returns an `IngressDecision` and
 * has no way to write to a socket. The listener holds the socket and cannot
 * obtain a decision without having awaited the commit. An implementation that
 * acknowledged first would have to be rewritten, not merely reordered — which
 * is the point, because "we ACK after we store" is a sentence that survives
 * exactly one refactor when it is only a comment.
 *
 * ── What is *not* done here ─────────────────────────────────────────────────
 *
 * Nothing is delivered to the laboratory. The message lands in `buffered` and
 * `AnalyzerForwarder` drains it. That separation is what makes a downstream
 * outage a queue rather than an incident: the analyzer's ACK depends on this
 * service's own database, and on nothing else.
 */
import type { IntegrationDatabase, TenantContext, TransactionClient } from '../db/database.js';
import type { AdapterLogger, Clock } from '../adapter/types.js';
import type { AnalyzerInbound } from './canonical.js';
import { DriverParseError, type AnalyzerDriver } from './driver.js';
import { LabIfErrorQueue } from './error-queue.js';
import { LabIfMessageStore, contentDigest, type LabIfMessageHandle } from './message-store.js';
import { LabInstrumentDowntimeLog } from './downtime-log.js';
import type { AnalyzerInstrument, IngressDecision } from './types.js';

export interface AnalyzerIngressDeps {
  readonly db: IntegrationDatabase;
  readonly clock: Clock;
  readonly newId: () => string;
  readonly logger: AdapterLogger;
  readonly messages?: LabIfMessageStore;
  readonly errors?: LabIfErrorQueue;
  readonly downtime?: LabInstrumentDowntimeLog;
}

export interface AcceptInput {
  readonly ctx: TenantContext;
  readonly instrument: AnalyzerInstrument;
  readonly driver: AnalyzerDriver;
  /** The complete application message, exactly as it arrived. */
  readonly raw: Buffer;
  /** An open downtime to count this frame against, when the sink is down. */
  readonly downtimeId?: string;
}

export interface AcceptResult {
  readonly decision: IngressDecision;
  /** What the driver decided the frame was, for a caller that must answer it. */
  readonly inbound?: AnalyzerInbound;
}

export class AnalyzerIngress {
  private readonly messages: LabIfMessageStore;
  private readonly errors: LabIfErrorQueue;
  private readonly downtime: LabInstrumentDowntimeLog;

  constructor(private readonly deps: AnalyzerIngressDeps) {
    this.messages = deps.messages ?? new LabIfMessageStore();
    this.errors = deps.errors ?? new LabIfErrorQueue();
    this.downtime = deps.downtime ?? new LabInstrumentDowntimeLog();
  }

  /**
   * Stores one inbound frame and says what the caller should acknowledge.
   *
   * Returns rather than throws for every *expected* failure — an unparseable
   * frame, an instrument that is not live, a duplicate — because each of those
   * has an acknowledgement the analyzer needs to receive. A thrown error here
   * means the database is unreachable, and in that case the caller must **not**
   * acknowledge, which is what an exception makes it do.
   */
  async accept(input: AcceptInput): Promise<AcceptResult> {
    const now = this.deps.clock.now();
    const digest = contentDigest(input.raw);

    let inbound: AnalyzerInbound;
    try {
      inbound = input.driver.read(input.raw, input.instrument);
    } catch (error) {
      const code = error instanceof DriverParseError ? error.code : 'parse_error';
      const detail = error instanceof Error ? error.message : 'the frame could not be read';
      // Fail closed, but keep the evidence: `EN-004 §5` retains raw frames for
      // 90 days precisely so an interface fault can be diagnosed from bytes.
      await this.retainRejected(input, { code, detail, digest, now });
      this.deps.logger.warn(
        { instrumentId: input.instrument.id, errorCode: code },
        'analyzer frame rejected: it could not be parsed',
      );
      return { decision: { kind: 'rejected', errorCode: code, detail, controlId: '' } };
    }

    const controlId = controlIdOf(inbound, digest);

    if (inbound.kind === 'acknowledgement') {
      // The analyzer acknowledging *our* order. Handled by the egress path.
      return { decision: { kind: 'duplicate', messageId: '', controlId }, inbound };
    }

    if (inbound.kind === 'host_query') {
      // A query holds no result and must not enter the store-and-forward queue;
      // the listener answers it from the worklist cache within `EN-004 §14.2`'s
      // two seconds.
      return {
        decision: { kind: 'stored', messageId: '', receivedAt: '', messageType: 'QUERY', controlId },
        inbound,
      };
    }

    const messageType = inbound.kind === 'results' ? (inbound.batches[0]?.messageType ?? 'ORU') : 'IGNORED';
    const specimenIdRaw = inbound.kind === 'results' ? (inbound.batches[0]?.specimenIdRaw ?? null) : null;

    return this.deps.db.withTenant(input.ctx, async (tx) => {
      const existing = await this.messages.findDuplicate(tx, {
        hospitalId: input.instrument.hospitalId,
        instrumentId: input.instrument.id,
        direction: 'inbound',
        controlId,
        contentSha256: digest,
      });

      // A frame we previously *rejected* is allowed back in: the analyzer is
      // retrying after a NAK and the results must still land somewhere.
      if (existing !== undefined && existing.status !== 'nak') {
        this.deps.logger.debug(
          { instrumentId: input.instrument.id, messageId: existing.id },
          'analyzer frame already received; acknowledged without re-applying',
        );
        return { decision: { kind: 'duplicate', messageId: existing.id, controlId }, inbound };
      }

      const notLive = input.instrument.status !== 'live';
      const messageId = this.deps.newId();

      const handle = await this.messages.persist(tx, {
        id: messageId,
        hospitalId: input.instrument.hospitalId,
        branchId: input.instrument.branchId,
        instrumentId: input.instrument.id,
        direction: 'inbound',
        msgType: messageType,
        controlId,
        sampleIdRaw: specimenIdRaw,
        raw: input.raw,
        parsed: inbound,
        // `EN-004 §5`: "Only `live` instruments … produce patient results."
        // A verification instrument's frame is kept and queued for a human
        // rather than applied to a patient.
        status: notLive ? 'error' : inbound.kind === 'results' ? 'buffered' : 'parsed',
        ...(notLive
          ? {
              errorCode: 'instrument_not_live',
              errorText: `instrument status is '${input.instrument.status}', which may not produce patient results`,
            }
          : {}),
        receivedAt: now,
      });

      if (notLive) {
        await this.queueError(tx, input.instrument, handle, {
          type: 'instrument_not_live',
          sampleIdRaw: specimenIdRaw,
          at: now,
        });
        return {
          decision: {
            kind: 'rejected' as const,
            errorCode: 'instrument_not_live',
            detail: `instrument status is '${input.instrument.status}'`,
            controlId,
          },
          inbound,
        };
      }

      if (input.downtimeId !== undefined && inbound.kind === 'results') {
        await this.downtime.recordBuffered(tx, input.downtimeId, 1, now);
      }

      return {
        decision: {
          kind: 'stored' as const,
          messageId: handle.id,
          receivedAt: handle.receivedAt,
          messageType,
          controlId,
        },
        inbound,
      };
    });
  }

  /**
   * Re-admits a frame that is already in the log — the operator's "replay"
   * button (`EN-004 §6`, `POST /messages/:id/replay`) and the retry the
   * unmatched queue performs once a specimen is accessioned.
   *
   * The original row is marked `replayed` and a **new** row is written carrying
   * `replayed_from_id`, because `lab_if_messages` is the evidence trail for a
   * disputed result and rewriting history through it would destroy exactly what
   * it is kept for.
   */
  async replay(input: {
    readonly ctx: TenantContext;
    readonly instrument: AnalyzerInstrument;
    readonly driver: AnalyzerDriver;
    readonly messageId: string;
  }): Promise<IngressDecision> {
    const now = this.deps.clock.now();

    return this.deps.db.withTenant(input.ctx, async (tx) => {
      const original = await this.messages.get(tx, input.messageId);
      if (original === undefined) {
        return {
          kind: 'rejected' as const,
          errorCode: 'not_found',
          detail: 'no such message',
          controlId: '',
        };
      }
      if (original.raw === null) {
        // `EN-004 §5` purges raw frames at 90 days. A replay after that cannot
        // reconstruct what the analyzer said, and inventing it would be worse
        // than refusing — the same reasoning as `payload_purged` in EN-017 §4.
        return {
          kind: 'rejected' as const,
          errorCode: 'raw_purged',
          detail: 'the raw frame is past its 90-day retention and cannot be replayed',
          controlId: original.control_id ?? '',
        };
      }

      let inbound: AnalyzerInbound;
      try {
        inbound = input.driver.read(original.raw, input.instrument);
      } catch (error) {
        return {
          kind: 'rejected' as const,
          errorCode: 'parse_error',
          detail: error instanceof Error ? error.message : 'the retained frame no longer parses',
          controlId: original.control_id ?? '',
        };
      }

      await this.messages.markReplayed(tx, { id: original.id, receivedAt: original.received_at_text }, now);

      const messageId = this.deps.newId();
      const handle = await this.messages.persist(tx, {
        id: messageId,
        hospitalId: original.hospital_id,
        branchId: original.branch_id,
        instrumentId: original.instrument_id,
        direction: 'inbound',
        msgType: original.msg_type,
        controlId: original.control_id ?? contentDigest(original.raw).slice(0, 32),
        sampleIdRaw: original.sample_id_raw,
        raw: original.raw,
        parsed: inbound,
        status: 'buffered',
        replayedFromId: original.id,
        receivedAt: now,
      });

      return {
        kind: 'stored' as const,
        messageId: handle.id,
        receivedAt: handle.receivedAt,
        messageType: original.msg_type,
        controlId: original.control_id ?? '',
      };
    });
  }

  /** Keeps an unreadable frame and opens the queue item a human will look at. */
  private async retainRejected(
    input: AcceptInput,
    detail: { readonly code: string; readonly detail: string; readonly digest: string; readonly now: Date },
  ): Promise<void> {
    try {
      await this.deps.db.withTenant(input.ctx, async (tx) => {
        const handle = await this.messages.persist(tx, {
          id: this.deps.newId(),
          hospitalId: input.instrument.hospitalId,
          branchId: input.instrument.branchId,
          instrumentId: input.instrument.id,
          direction: 'inbound',
          msgType: 'UNPARSED',
          controlId: detail.digest.slice(0, 32),
          raw: input.raw,
          parsed: { unparsed: true, errorCode: detail.code },
          status: 'nak',
          errorCode: detail.code,
          errorText: detail.detail,
          receivedAt: detail.now,
        });
        await this.queueError(tx, input.instrument, handle, {
          type: 'parse_error',
          sampleIdRaw: null,
          at: detail.now,
        });
      });
    } catch (error) {
      // The frame could not be parsed *and* could not be stored. Both are
      // reportable; neither may be swallowed (`docs/04` §7).
      this.deps.logger.error(
        { instrumentId: input.instrument.id, errorCode: detail.code },
        'analyzer frame could not be parsed and could not be retained',
      );
      throw error;
    }
  }

  private async queueError(
    tx: TransactionClient,
    instrument: AnalyzerInstrument,
    handle: LabIfMessageHandle,
    input: {
      readonly type: Parameters<LabIfErrorQueue['record']>[1]['type'];
      readonly sampleIdRaw: string | null;
      readonly at: Date;
    },
  ): Promise<void> {
    await this.errors.record(tx, {
      id: this.deps.newId(),
      hospitalId: instrument.hospitalId,
      branchId: instrument.branchId,
      instrumentId: instrument.id,
      messageId: handle.id,
      messageReceivedAt: handle.receivedAt,
      type: input.type,
      sampleIdRaw: input.sampleIdRaw,
      at: input.at,
    });
  }
}

function controlIdOf(inbound: AnalyzerInbound, digest: string): string {
  switch (inbound.kind) {
    case 'results': {
      const first = inbound.batches[0]?.controlId ?? '';
      return first.length > 0 ? first : digest.slice(0, 32);
    }
    case 'host_query':
      return inbound.query.controlId.length > 0 ? inbound.query.controlId : digest.slice(0, 32);
    case 'acknowledgement':
      return inbound.controlId.length > 0 ? inbound.controlId : digest.slice(0, 32);
    case 'ignored':
      return inbound.controlId.length > 0 ? inbound.controlId : digest.slice(0, 32);
    default:
      return digest.slice(0, 32);
  }
}
