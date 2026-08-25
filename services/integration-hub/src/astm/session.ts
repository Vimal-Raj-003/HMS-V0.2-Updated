/**
 * The E1381 session state machines, one for each side of the link.
 *
 * They are written as *reducers over bytes* — feed them what arrived, take back
 * what to write and what completed — with no sockets, no timers and no
 * `setTimeout`. Two reasons:
 *
 *  1. `docs/09` §2 bans ambient time in a test. A session that owned its own
 *     timers could only be tested by sleeping, which is how an interface suite
 *     becomes both slow and flaky.
 *  2. The same machine drives a TCP socket, a serial port behind a Moxa
 *     converter, and the in-memory simulator. Only the transport differs.
 *
 * ── Persist-before-ACK, in a protocol with no application acknowledgement ───
 *
 * MLLP makes this easy: one frame is one message and the ACK is an application
 * message you choose to send after the row is committed. ASTM has no such
 * thing — its `<ACK>` is a *link* acknowledgement, one per frame, and the
 * records only become a transmission at the `L` record.
 *
 * So the receiver **withholds the acknowledgement of the frame that completes
 * the transmission** until the caller says the frame is stored. If the store
 * fails, that frame is NAK'd, the analyzer retransmits it (E1381 §6.4 allows
 * six attempts), and nothing has been half-applied. `confirm()` is the only way
 * to release that ACK, which makes the ordering structural rather than a matter
 * of remembering to await in the right place.
 *
 * The honest limitation, stated rather than hidden: an analyzer that ends a
 * transmission with `<EOT>` and no `L` record gives the receiver nothing to
 * withhold — `<EOT>` is not acknowledged in either direction. Such a
 * transmission is reported with `awaitingConfirmation: false`, and the
 * guarantee for it is at-least-once by the analyzer's own retry behaviour
 * rather than by this handshake.
 */
import {
  ASTM_ACK,
  ASTM_ENQ,
  ASTM_EOT,
  ASTM_NAK,
  AstmFrameDecoder,
  buildAstmFrame,
  splitAstmRecord,
  type AstmEvent,
} from './framing.js';

/** E1381 §6.4: six failed attempts on one frame and the sender aborts. */
export const ASTM_MAX_FRAME_RETRIES = 6;

export interface AstmTransmission {
  /** The records between `<ENQ>` and the `L` record (or `<EOT>`), in order. */
  readonly records: readonly string[];
  /**
   * `true` when the ACK for the frame that completed this transmission is being
   * withheld and `confirm()` must be called. `false` when the transmission was
   * completed by an unacknowledgeable `<EOT>`.
   */
  readonly awaitingConfirmation: boolean;
}

export interface AstmReceiverOutcome {
  /** Bytes to write back now. */
  readonly reply: Buffer;
  readonly transmissions: readonly AstmTransmission[];
  /** Frames rejected in this step. Non-empty means the link is unhealthy. */
  readonly rejected: readonly string[];
}

interface HeldFrame {
  readonly frameNumber: number;
  readonly records: readonly string[];
}

function isTerminatorRecord(record: string): boolean {
  return /^[Ll]/.test(record.trim());
}

export class AstmReceiver {
  private readonly decoder = new AstmFrameDecoder();
  private queue: AstmEvent[] = [];
  private expectedFrame = 1;
  private lastAccepted = -1;
  private partial = '';
  private records: string[] = [];
  private consecutiveRejects = 0;
  private held: HeldFrame | undefined;
  private delivered = false;

  /** True while an acknowledgement is being withheld pending a durable write. */
  get awaitingConfirmation(): boolean {
    return this.held !== undefined;
  }

  push(chunk: Buffer): AstmReceiverOutcome {
    this.queue.push(...this.decoder.push(chunk));
    return this.drain();
  }

  /**
   * Releases the withheld acknowledgement.
   *
   * `stored === true` ACKs the completing frame and accepts the transmission.
   * `stored === false` NAKs it and rewinds, so the analyzer's retransmission is
   * treated as a fresh frame rather than as a duplicate — which is the whole
   * point: the results must still be somewhere after the store failed.
   */
  confirm(stored: boolean): AstmReceiverOutcome {
    const held = this.held;
    if (held === undefined) return { reply: Buffer.alloc(0), transmissions: [], rejected: [] };
    this.held = undefined;

    if (stored) {
      this.records = [...held.records];
      this.lastAccepted = held.frameNumber;
      this.expectedFrame = (held.frameNumber + 1) % 8;
      this.consecutiveRejects = 0;
      this.partial = '';
      const rest = this.drain();
      return { ...rest, reply: Buffer.concat([Buffer.of(ASTM_ACK), rest.reply]) };
    }

    // Rewind: the frame was never accepted, so the sender's retry is expected.
    this.partial = '';
    this.consecutiveRejects += 1;
    const rest = this.drain();
    return {
      reply: Buffer.concat([Buffer.of(ASTM_NAK), rest.reply]),
      transmissions: rest.transmissions,
      rejected: ['the frame could not be stored, so it was not acknowledged', ...rest.rejected],
    };
  }

  /** True once the peer has failed the same frame more times than E1381 allows. */
  get exhausted(): boolean {
    return this.consecutiveRejects >= ASTM_MAX_FRAME_RETRIES;
  }

  /** Records held for a transmission that never completed. Never applied. */
  abandonedRecords(): readonly string[] {
    return [...this.records];
  }

  reset(): void {
    this.queue = [];
    this.expectedFrame = 1;
    this.lastAccepted = -1;
    this.partial = '';
    this.records = [];
    this.consecutiveRejects = 0;
    this.held = undefined;
    this.delivered = false;
    this.decoder.reset();
  }

  private drain(): AstmReceiverOutcome {
    const replies: Buffer[] = [];
    const transmissions: AstmTransmission[] = [];
    const rejected: string[] = [];

    while (this.queue.length > 0 && this.held === undefined) {
      const event = this.queue.shift();
      if (event === undefined) break;

      switch (event.kind) {
        case 'enq':
          this.begin();
          replies.push(Buffer.of(ASTM_ACK));
          break;

        case 'frame': {
          const frame = event.frame;
          if (frame.frameNumber === this.lastAccepted) {
            // The analyzer did not see our ACK and sent the frame again. ACK it
            // and drop the duplicate: applying it twice is precisely the
            // duplicate result `EN-004 §5` makes idempotency a rule about.
            replies.push(Buffer.of(ASTM_ACK));
            break;
          }
          if (frame.frameNumber !== this.expectedFrame) {
            rejected.push(
              `frame ${String(frame.frameNumber)} out of sequence, expected ${String(this.expectedFrame)}`,
            );
            replies.push(Buffer.of(ASTM_NAK));
            this.consecutiveRejects += 1;
            break;
          }

          const assembled = this.partial + frame.text;
          if (!frame.final) {
            // An `<ETB>` frame continues the record; nothing is complete yet.
            this.partial = assembled;
            this.lastAccepted = frame.frameNumber;
            this.expectedFrame = (frame.frameNumber + 1) % 8;
            this.consecutiveRejects = 0;
            replies.push(Buffer.of(ASTM_ACK));
            break;
          }

          const completed = assembled.split('\r').filter((record) => record.trim().length > 0);
          const candidate = [...this.records, ...completed];
          const last = completed[completed.length - 1];

          if (last !== undefined && isTerminatorRecord(last)) {
            // The `L` record ends the transmission: withhold this ACK until the
            // caller has durably stored what we assembled.
            this.held = { frameNumber: frame.frameNumber, records: candidate };
            this.delivered = true;
            transmissions.push({ records: candidate, awaitingConfirmation: true });
            break;
          }

          this.records = candidate;
          this.partial = '';
          this.lastAccepted = frame.frameNumber;
          this.expectedFrame = (frame.frameNumber + 1) % 8;
          this.consecutiveRejects = 0;
          replies.push(Buffer.of(ASTM_ACK));
          break;
        }

        case 'bad_frame':
          rejected.push(`${event.reason}: ${event.detail}`);
          this.consecutiveRejects += 1;
          replies.push(Buffer.of(ASTM_NAK));
          break;

        case 'eot':
          if (!this.delivered && this.records.length > 0) {
            // No `L` record: there is no acknowledgement left to withhold.
            transmissions.push({ records: [...this.records], awaitingConfirmation: false });
          }
          this.reset();
          break;

        case 'ack':
        case 'nak':
          // A receiver has no use for the sender's own handshake bytes.
          break;

        default:
          break;
      }
    }

    return { reply: Buffer.concat(replies), transmissions, rejected };
  }

  private begin(): void {
    this.expectedFrame = 1;
    this.lastAccepted = -1;
    this.partial = '';
    this.records = [];
    this.consecutiveRejects = 0;
    this.held = undefined;
    this.delivered = false;
  }
}

export type AstmSenderState = 'idle' | 'establishing' | 'sending' | 'done' | 'failed';

export interface AstmSenderStep {
  readonly write: Buffer;
  readonly state: AstmSenderState;
  /** Set when the transmission finished or gave up, with the reason. */
  readonly detail?: string;
}

/**
 * The sending half: `<ENQ>` → frames → `<EOT>`, one frame in flight at a time.
 *
 * `start()` returns the `<ENQ>`; every subsequent step is driven by a byte from
 * the peer. A `<NAK>` retransmits the same frame up to `ASTM_MAX_FRAME_RETRIES`,
 * after which the transmission fails **visibly** — an order that could not be
 * delivered has to become an error somebody sees, never a silent no-op.
 */
export class AstmSender {
  private readonly decoder = new AstmFrameDecoder();
  private readonly frames: readonly { readonly text: string; readonly final: boolean }[];
  private index = 0;
  private frameNumber = 1;
  private retries = 0;
  private state: AstmSenderState = 'idle';

  constructor(records: readonly string[]) {
    const frames: { text: string; final: boolean }[] = [];
    for (const record of records) {
      const parts = splitAstmRecord(record);
      parts.forEach((text, i) => {
        frames.push({ text, final: i === parts.length - 1 });
      });
    }
    this.frames = frames;
  }

  start(): AstmSenderStep {
    this.state = 'establishing';
    return { write: Buffer.of(ASTM_ENQ), state: this.state };
  }

  push(chunk: Buffer): AstmSenderStep {
    const writes: Buffer[] = [];
    let detail: string | undefined;

    for (const event of this.decoder.push(chunk)) {
      const step = this.apply(event);
      if (step.write.length > 0) writes.push(step.write);
      if (step.detail !== undefined) detail = step.detail;
    }

    return {
      write: Buffer.concat(writes),
      state: this.state,
      ...(detail === undefined ? {} : { detail }),
    };
  }

  get finished(): boolean {
    return this.state === 'done' || this.state === 'failed';
  }

  get succeeded(): boolean {
    return this.state === 'done';
  }

  private apply(event: AstmEvent): { readonly write: Buffer; readonly detail?: string } {
    switch (event.kind) {
      case 'ack': {
        if (this.state === 'establishing') {
          this.state = 'sending';
          return { write: this.currentFrame() };
        }
        if (this.state !== 'sending') return { write: Buffer.alloc(0) };
        this.index += 1;
        this.frameNumber = (this.frameNumber + 1) % 8;
        this.retries = 0;
        if (this.index >= this.frames.length) {
          this.state = 'done';
          return { write: Buffer.of(ASTM_EOT) };
        }
        return { write: this.currentFrame() };
      }

      case 'nak': {
        this.retries += 1;
        if (this.state === 'establishing') {
          if (this.retries >= ASTM_MAX_FRAME_RETRIES) {
            this.state = 'failed';
            return { write: Buffer.alloc(0), detail: 'the receiver refused the link six times' };
          }
          return { write: Buffer.of(ASTM_ENQ) };
        }
        if (this.retries >= ASTM_MAX_FRAME_RETRIES) {
          this.state = 'failed';
          return {
            write: Buffer.of(ASTM_EOT),
            detail: `frame ${String(this.index + 1)} of ${String(this.frames.length)} was rejected six times`,
          };
        }
        return { write: this.currentFrame() };
      }

      case 'eot':
        this.state = 'failed';
        return { write: Buffer.alloc(0), detail: 'the receiver terminated the transmission' };

      case 'enq':
      case 'frame':
      case 'bad_frame':
        // A sender has no use for the receiver's own frames: E1381 is
        // half-duplex, and anything but a handshake byte here is line noise.
        return { write: Buffer.alloc(0) };

      default:
        return { write: Buffer.alloc(0) };
    }
  }

  private currentFrame(): Buffer {
    const frame = this.frames[this.index];
    if (frame === undefined) return Buffer.of(ASTM_EOT);
    return buildAstmFrame(this.frameNumber, frame.text, frame.final);
  }
}
