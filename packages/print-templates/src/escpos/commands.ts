/**
 * ESC/POS command builder for 58 mm and 80 mm thermal printers
 * (Epson, TVS, Bixolon — `EN-005 §9`).
 *
 * Pure: every method appends bytes to an array and returns `this`, and `build()`
 * hands back a `Uint8Array`. No printer, no transport, no side effects — so the
 * exact control sequence a counter will receive can be asserted in a unit test,
 * which is the only way to catch "the cutter stopped firing" before a hospital does.
 */

export const ESC = 0x1b;
export const GS = 0x1d;
export const LF = 0x0a;

export type Alignment = 'left' | 'center' | 'right';

const ALIGNMENT: Readonly<Record<Alignment, number>> = Object.freeze({ left: 0, center: 1, right: 2 });

/** Characters no single-byte thermal code page carries, mapped to a safe form. */
const TRANSLITERATIONS: ReadonlyMap<string, string> = new Map([
  ['₹', 'Rs.'],
  ['—', '-'],
  ['–', '-'],
  ['…', '...'],
  ['·', '-'],
  ['’', "'"],
  ['‘', "'"],
  ['“', '"'],
  ['”', '"'],
]);

/**
 * Encode to the printer's single-byte code page.
 *
 * Anything outside ASCII becomes `?` rather than a random glyph: a token slip
 * that prints mojibake for a patient's name is worse than one that prints `?`,
 * and `EN-005 §13` puts the local-language line on the *label* templates, which
 * are ZPL with a UTF-8 code page, not here.
 */
export function encodeEscPosText(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const replacement = TRANSLITERATIONS.get(char);
    const source = replacement ?? char;
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      bytes.push(code >= 0x20 && code <= 0x7e ? code : 0x3f);
    }
  }
  return bytes;
}

export class EscPosBuilder {
  readonly #bytes: number[] = [];

  /** `ESC @` — reset. Every job starts here so a previous job cannot bleed style. */
  init(): this {
    this.#bytes.push(ESC, 0x40);
    return this;
  }

  /** `ESC t n` — select character code page (19 = CP858, the usual Indian default). */
  codePage(page: number): this {
    this.#bytes.push(ESC, 0x74, page & 0xff);
    return this;
  }

  /** `ESC a n` */
  align(alignment: Alignment): this {
    this.#bytes.push(ESC, 0x61, ALIGNMENT[alignment]);
    return this;
  }

  /** `ESC E n` */
  bold(on: boolean): this {
    this.#bytes.push(ESC, 0x45, on ? 1 : 0);
    return this;
  }

  /** `ESC - n` */
  underline(on: boolean): this {
    this.#bytes.push(ESC, 0x2d, on ? 1 : 0);
    return this;
  }

  /** `GS ! n` — width and height multipliers, 1–8 each. */
  size(width: number, height: number): this {
    const clamp = (value: number): number => Math.min(8, Math.max(1, Math.trunc(value))) - 1;
    this.#bytes.push(GS, 0x21, (clamp(width) << 4) | clamp(height));
    return this;
  }

  text(value: string): this {
    this.#bytes.push(...encodeEscPosText(value));
    return this;
  }

  /** Print the buffer and advance one line (`LF`). */
  line(value = ''): this {
    this.text(value);
    this.#bytes.push(LF);
    return this;
  }

  /** `ESC d n` — feed n lines. */
  feed(lines: number): this {
    this.#bytes.push(ESC, 0x64, Math.min(255, Math.max(0, Math.trunc(lines))));
    return this;
  }

  /** A full-width rule, e.g. `--------------------------------`. */
  rule(width: number, char = '-'): this {
    return this.line(char.repeat(Math.max(1, Math.trunc(width))));
  }

  /**
   * Two-column row: label flush start, value flush end, padded to `width`.
   * Used for "Counter … C3" and receipt amount lines.
   */
  keyValue(label: string, value: string, width: number): this {
    const gap = Math.max(1, width - label.length - value.length);
    return this.line(`${label}${' '.repeat(gap)}${value}`);
  }

  /**
   * `GS ( k` QR code: model 2, size `moduleSize`, error correction M, then store
   * and print. The four calls must be issued in this order.
   */
  qr(data: string, moduleSize = 6): this {
    const payload = encodeEscPosText(data);
    const length = payload.length + 3;
    this.#bytes.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00); // model 2
    this.#bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, Math.min(16, Math.max(1, moduleSize))); // size
    this.#bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31); // error correction level M
    this.#bytes.push(GS, 0x28, 0x6b, length & 0xff, (length >> 8) & 0xff, 0x31, 0x50, 0x30, ...payload); // store
    this.#bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30); // print
    return this;
  }

  /** `GS h n` / `GS w n` / `GS k 73` — Code 128 barcode, code set B. */
  code128(data: string, height = 60): this {
    const payload = encodeEscPosText(`{B${data}`);
    this.#bytes.push(GS, 0x68, Math.min(255, Math.max(1, Math.trunc(height)))); // height
    this.#bytes.push(GS, 0x77, 0x02); // module width
    this.#bytes.push(GS, 0x48, 0x02); // HRI text below the bars
    this.#bytes.push(GS, 0x6b, 0x49, payload.length, ...payload);
    return this;
  }

  /** `GS V 66 n` — partial cut after feeding n lines. */
  cut(feedLines = 3): this {
    this.#bytes.push(GS, 0x56, 0x42, Math.min(255, Math.max(0, Math.trunc(feedLines))));
    return this;
  }

  /** `ESC p m t1 t2` — cash-drawer kick (`EN-005 §3.1` capability `cash-drawer`). */
  openCashDrawer(pin: 0 | 1 = 0): this {
    this.#bytes.push(ESC, 0x70, pin, 0x19, 0xfa);
    return this;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

export function escpos(): EscPosBuilder {
  return new EscPosBuilder();
}

/** Hex dump — how the tests and the admin preview read a byte stream. */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/**
 * The text a customer would read, with the control sequences removed.
 *
 * A naive "keep the printable bytes" filter is wrong: half of ESC/POS command
 * bytes (`a`, `E`, `d`, `!`, `V`) are themselves printable ASCII, so it would
 * sprinkle stray letters through the output and hide real layout bugs. This is a
 * small scanner that knows how long each command it emits is, which is also what
 * the admin console's preview needs.
 */
export function toPrintableText(bytes: Uint8Array): string {
  /** Argument-byte counts for the `ESC x` / `GS x` commands this builder emits. */
  const ESC_ARGS: Readonly<Record<number, number>> = { 0x40: 0, 0x61: 1, 0x45: 1, 0x2d: 1, 0x64: 1, 0x74: 1, 0x70: 3 };
  const GS_ARGS: Readonly<Record<number, number>> = { 0x21: 1, 0x56: 2, 0x68: 1, 0x77: 1, 0x48: 1 };

  let out = '';
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index];
    if (byte === undefined) break;

    if (byte === ESC && index + 1 < bytes.length) {
      const command = bytes[index + 1] ?? 0;
      index += 2 + (ESC_ARGS[command] ?? 0);
      continue;
    }

    if (byte === GS && index + 1 < bytes.length) {
      const command = bytes[index + 1] ?? 0;
      if (command === 0x6b) {
        // GS k <symbology> <len> <data…> — the Code 128 form this builder emits.
        const length = bytes[index + 3] ?? 0;
        index += 4 + length;
        continue;
      }
      if (command === 0x28) {
        // GS ( k pL pH <data…>
        const pL = bytes[index + 3] ?? 0;
        const pH = bytes[index + 4] ?? 0;
        index += 5 + (pL | (pH << 8));
        continue;
      }
      index += 2 + (GS_ARGS[command] ?? 0);
      continue;
    }

    if (byte === LF) {
      out += '\n';
    } else if (byte >= 0x20 && byte <= 0x7e) {
      out += String.fromCharCode(byte);
    }
    index += 1;
  }
  return out;
}

/** Characters per line at the two standard widths, in Font A. */
export const LINE_WIDTH: Readonly<Record<'thermal_58mm' | 'thermal_80mm', number>> = Object.freeze({
  thermal_58mm: 32,
  thermal_80mm: 48,
});
