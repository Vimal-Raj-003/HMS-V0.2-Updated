/**
 * ASTM E1381 — the low-level link layer that carries E1394 records.
 *
 * Half the analyzers in an Indian laboratory speak only this: an ERBA
 * semi-auto, a Mindray BA-88, a Bio-Rad D-10, anything reached through a
 * serial-to-Ethernet converter. It is a 1991 protocol and its assumptions show —
 * a single-byte handshake, 240-character frames, a two-digit modulo-256
 * checksum — but the properties that matter are exactly the ones this interface
 * needs: every frame is acknowledged individually, and a frame whose checksum
 * fails is *retransmitted by the sender* rather than lost.
 *
 * That last property is what makes `fail closed` cheap here. A frame that does
 * not verify is NAK'd; the analyzer sends it again; nothing is half-applied and
 * nothing is dropped. The only case that needs care is the sender that keeps
 * failing, which is why `AstmFrameDecoder` counts consecutive rejects and the
 * session gives up rather than looping forever.
 *
 * Checksum, per E1381 §6.3.3: the arithmetic sum, modulo 256, of every byte
 * after `<STX>` up to and **including** the terminating `<ETX>` or `<ETB>`,
 * rendered as two upper-case hexadecimal digits.
 */

export const ASTM_ENQ = 0x05;
export const ASTM_ACK = 0x06;
export const ASTM_NAK = 0x15;
export const ASTM_EOT = 0x04;
export const ASTM_STX = 0x02;
export const ASTM_ETX = 0x03;
export const ASTM_ETB = 0x17;
export const ASTM_CR = 0x0d;
export const ASTM_LF = 0x0a;

/** E1381 §6.3.2: 240 characters of record text per frame, excluding the frame number. */
export const ASTM_MAX_TEXT_BYTES = 240;

/** A wildly oversized frame is a peer fault, not a long result. */
const MAX_FRAME_BYTES = 8_192;

export interface AstmFrame {
  /** `0`–`7`, cycling. */
  readonly frameNumber: number;
  /** The record text, without the frame number and without the terminator. */
  readonly text: string;
  /** `false` for an `<ETB>` intermediate frame that continues in the next one. */
  readonly final: boolean;
}

export type AstmEvent =
  | { readonly kind: 'enq' }
  | { readonly kind: 'ack' }
  | { readonly kind: 'nak' }
  | { readonly kind: 'eot' }
  | { readonly kind: 'frame'; readonly frame: AstmFrame }
  | {
      readonly kind: 'bad_frame';
      readonly reason: 'checksum' | 'framing' | 'frame_number' | 'too_large';
      readonly detail: string;
    };

export function astmChecksum(bytes: Buffer): string {
  let sum = 0;
  for (const byte of bytes) sum = (sum + byte) % 256;
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

/** `<STX> FN text <ETX|ETB> C1 C2 <CR><LF>`. */
export function buildAstmFrame(frameNumber: number, text: string, final = true): Buffer {
  const body = Buffer.from(`${String(frameNumber % 8)}${text}`, 'latin1');
  const terminator = Buffer.of(final ? ASTM_ETX : ASTM_ETB);
  const checksum = Buffer.from(astmChecksum(Buffer.concat([body, terminator])), 'latin1');
  return Buffer.concat([Buffer.of(ASTM_STX), body, terminator, checksum, Buffer.of(ASTM_CR, ASTM_LF)]);
}

/**
 * Splits one record into frame texts.
 *
 * A haematology analyzer's `R` record with a full differential and a histogram
 * comment routinely exceeds 240 characters, and an implementation that assumed
 * one record equals one frame would truncate it — silently, because the
 * checksum of the truncated frame is perfectly valid.
 */
export function splitAstmRecord(record: string, maxTextBytes = ASTM_MAX_TEXT_BYTES): readonly string[] {
  const withTerminator = `${record}\r`;
  if (withTerminator.length <= maxTextBytes) return [withTerminator];
  const parts: string[] = [];
  for (let i = 0; i < withTerminator.length; i += maxTextBytes) {
    parts.push(withTerminator.slice(i, i + maxTextBytes));
  }
  return parts;
}

/**
 * Byte-stream decoder. Same reasoning as the MLLP decoder: a serial gateway
 * delivers a frame in three chunks whenever the analyzer's buffer is under
 * pressure, and a decoder that assumed chunk boundaries were frame boundaries
 * would corrupt exactly the busiest runs.
 */
export class AstmFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): readonly AstmEvent[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const events: AstmEvent[] = [];

    for (;;) {
      if (this.buffer.length === 0) return events;
      const first = this.buffer[0];

      if (first === ASTM_ENQ) {
        this.buffer = this.buffer.subarray(1);
        events.push({ kind: 'enq' });
        continue;
      }
      if (first === ASTM_ACK) {
        this.buffer = this.buffer.subarray(1);
        events.push({ kind: 'ack' });
        continue;
      }
      if (first === ASTM_NAK) {
        this.buffer = this.buffer.subarray(1);
        events.push({ kind: 'nak' });
        continue;
      }
      if (first === ASTM_EOT) {
        this.buffer = this.buffer.subarray(1);
        events.push({ kind: 'eot' });
        continue;
      }
      if (first !== ASTM_STX) {
        // Line noise, or the `<LF>` left over from a frame whose `<CR>` we
        // already consumed. Dropped, never guessed at.
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      const located = this.findTerminator();
      const terminator = located?.index ?? -1;
      if (located === undefined) {
        if (this.buffer.length > MAX_FRAME_BYTES) {
          const size = this.buffer.length;
          this.buffer = Buffer.alloc(0);
          events.push({
            kind: 'bad_frame',
            reason: 'too_large',
            detail: `no <ETX>/<ETB> within ${String(size)} bytes; the peer is not framing`,
          });
          continue;
        }
        return events;
      }

      // <STX> body <ETX|ETB> C1 C2 [<CR>] [<LF>]
      if (this.buffer.length < terminator + 3) return events;

      const body = this.buffer.subarray(1, terminator);
      const declared = this.buffer.subarray(terminator + 1, terminator + 3).toString('latin1');
      const expected = astmChecksum(this.buffer.subarray(1, terminator + 1));

      let end = terminator + 3;
      if (this.buffer[end] === ASTM_CR) end += 1;
      if (this.buffer[end] === ASTM_LF) end += 1;
      this.buffer = this.buffer.subarray(end);

      if (declared.toUpperCase() !== expected) {
        events.push({
          kind: 'bad_frame',
          reason: 'checksum',
          detail: `declared ${JSON.stringify(declared)}, computed ${expected}`,
        });
        continue;
      }

      const text = body.toString('latin1');
      const frameNumber = Number(text.slice(0, 1));
      if (!Number.isInteger(frameNumber) || frameNumber < 0 || frameNumber > 7) {
        events.push({
          kind: 'bad_frame',
          reason: 'framing',
          detail: `frame number ${JSON.stringify(text.slice(0, 1))} is not 0-7`,
        });
        continue;
      }

      events.push({
        kind: 'frame',
        frame: { frameNumber, text: text.slice(1), final: located.final },
      });
    }
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }

  /** `<ETX>` ends a record; `<ETB>` says the record continues in the next frame. */
  private findTerminator(): { readonly index: number; readonly final: boolean } | undefined {
    for (let i = 1; i < this.buffer.length; i += 1) {
      const byte = this.buffer[i];
      if (byte === ASTM_ETX) return { index: i, final: true };
      if (byte === ASTM_ETB) return { index: i, final: false };
    }
    return undefined;
  }
}
