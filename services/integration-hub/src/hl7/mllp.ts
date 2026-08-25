/**
 * MLLP — Minimal Lower Layer Protocol, the framing every HL7-over-TCP analyzer
 * speaks: `<VT> message <FS><CR>`.
 *
 * The decoder is a state machine over a byte stream rather than a function over
 * a buffer, because TCP gives no message boundaries: a Sysmex XN sending forty
 * results in a burst will deliver two and a half frames in one `data` event and
 * the remaining half in the next, and a decoder that assumed one chunk equals
 * one message would lose the tail of every burst. That failure is silent, which
 * is what makes it worth a state machine.
 *
 * Three defences, all of them fail-closed:
 *
 *  * **Bytes before `<VT>` are junk.** A reconnecting analyzer that resends the
 *    tail of a half-written frame must not have it treated as a message. They
 *    are counted and dropped, and the count is surfaced so a driver can log
 *    that it happened without logging what it was (PHI).
 *  * **A frame larger than `maxFrameBytes` aborts.** Without a cap, a peer that
 *    never sends `<FS>` grows the buffer until the process dies — which takes
 *    the other twenty-nine analyzers down with it.
 *  * **`<FS>` not followed by `<CR>`** is accepted, because a handful of
 *    analyzers omit the trailing carriage return, and rejecting the frame would
 *    discard a real result over a byte that carries no information.
 */

export const MLLP_START_BLOCK = 0x0b;
export const MLLP_END_BLOCK = 0x1c;
export const MLLP_CARRIAGE_RETURN = 0x0d;

/** 1 MB. An HL7 message is kilobytes; anything at this size is a fault, not a result. */
export const DEFAULT_MAX_FRAME_BYTES = 1_048_576;

export class MllpFramingError extends Error {
  constructor(
    readonly code: 'frame_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'MllpFramingError';
  }
}

/** Wraps a payload for the wire. */
export function mllpFrame(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.of(MLLP_START_BLOCK), body, Buffer.of(MLLP_END_BLOCK, MLLP_CARRIAGE_RETURN)]);
}

export interface MllpDecoderOptions {
  readonly maxFrameBytes?: number;
}

export class MllpDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private inFrame = false;
  private discarded = 0;
  private readonly maxFrameBytes: number;

  constructor(options: MllpDecoderOptions = {}) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  /** Bytes seen outside a frame since the last reset. Non-zero means a peer fault. */
  get discardedBytes(): number {
    return this.discarded;
  }

  /** Bytes currently held for an incomplete frame. Non-zero at close means a truncated frame. */
  get pendingBytes(): number {
    return this.inFrame ? this.buffer.length : 0;
  }

  /** Feeds a chunk and returns every *complete* frame payload it completed. */
  push(chunk: Buffer): readonly Buffer[] {
    const frames: Buffer[] = [];
    let input = chunk;

    for (;;) {
      if (!this.inFrame) {
        const start = input.indexOf(MLLP_START_BLOCK);
        if (start === -1) {
          this.discarded += input.length;
          return frames;
        }
        this.discarded += start;
        this.inFrame = true;
        this.buffer = Buffer.alloc(0);
        input = input.subarray(start + 1);
      }

      const end = input.indexOf(MLLP_END_BLOCK);
      if (end === -1) {
        this.buffer = Buffer.concat([this.buffer, input]);
        this.assertSize();
        return frames;
      }

      const payload = Buffer.concat([this.buffer, input.subarray(0, end)]);
      this.buffer = Buffer.alloc(0);
      this.inFrame = false;
      frames.push(payload);

      // Consume the `<FS>` and, when present, the `<CR>` that should follow it.
      let next = end + 1;
      if (input[next] === MLLP_CARRIAGE_RETURN) next += 1;
      input = input.subarray(next);
      if (input.length === 0) return frames;
    }
  }

  /** Drops any partial frame — what a driver calls when the socket closes. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
    this.inFrame = false;
    this.discarded = 0;
  }

  private assertSize(): void {
    if (this.buffer.length > this.maxFrameBytes) {
      const size = this.buffer.length;
      this.reset();
      throw new MllpFramingError(
        'frame_too_large',
        `MLLP frame exceeded ${String(this.maxFrameBytes)} bytes (${String(size)}) with no end block; the peer is not framing`,
      );
    }
  }
}
