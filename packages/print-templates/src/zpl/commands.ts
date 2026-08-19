/**
 * ZPL II command builder for Zebra/TSC-class label printers
 * (`EN-005 §3.5`: "ZPL (label printers 203/300 dpi with GS1 barcodes: `^BC`
 * Code128, `^BX` DataMatrix, `^BQ` QR)").
 *
 * Coordinates are in **dots**, so the DPI matters: a 50 × 25 mm label is
 * 400 × 200 dots at 203 dpi and 590 × 295 at 300 dpi. `labelDots()` converts, so
 * templates are written in millimetres and stay correct on both printer classes.
 */

export type LabelDpi = 203 | 300;

const DOTS_PER_MM: Readonly<Record<LabelDpi, number>> = Object.freeze({ 203: 8, 300: 11.8 });

export function mmToDots(mm: number, dpi: LabelDpi): number {
  return Math.round(mm * DOTS_PER_MM[dpi]);
}

export function labelDots(widthMm: number, heightMm: number, dpi: LabelDpi): { width: number; height: number } {
  return { width: mmToDots(widthMm, dpi), height: mmToDots(heightMm, dpi) };
}

/**
 * `^`, `~` and `\` are ZPL control characters. Rather than switch the format
 * prefix per field (which breaks as soon as a template is composed from two
 * sources), field data is sanitised: a patient's name is never worth a
 * malformed label that a phlebotomist cannot scan.
 */
export function escapeZplData(value: string): string {
  return value.replace(/[\^~\\]/g, ' ').replace(/[\r\n]+/g, ' ');
}

export type ZplRotation = 'N' | 'R' | 'I' | 'B';

export class ZplBuilder {
  readonly #parts: string[] = [];
  readonly #dpi: LabelDpi;

  constructor(dpi: LabelDpi) {
    this.#dpi = dpi;
  }

  get dpi(): LabelDpi {
    return this.#dpi;
  }

  /** `^XA` + UTF-8 code page + home position. Always the first call. */
  start(widthMm: number, heightMm: number): this {
    const { width, height } = labelDots(widthMm, heightMm, this.#dpi);
    this.#parts.push('^XA', '^CI28', '^LH0,0', `^PW${width}`, `^LL${height}`);
    return this;
  }

  raw(command: string): this {
    this.#parts.push(command);
    return this;
  }

  /** `^FO x,y ^A0<rot>,h,w ^FD…^FS` — scalable font text at a position in mm. */
  text(xMm: number, yMm: number, value: string, heightDots: number, rotation: ZplRotation = 'N'): this {
    const x = mmToDots(xMm, this.#dpi);
    const y = mmToDots(yMm, this.#dpi);
    const width = Math.round(heightDots * 0.6);
    this.#parts.push(`^FO${x},${y}^A0${rotation},${heightDots},${width}^FD${escapeZplData(value)}^FS`);
    return this;
  }

  /** `^FB` block text — wraps a long test name across `lines` lines. */
  textBlock(xMm: number, yMm: number, widthMm: number, value: string, heightDots: number, lines = 2): this {
    const x = mmToDots(xMm, this.#dpi);
    const y = mmToDots(yMm, this.#dpi);
    const width = mmToDots(widthMm, this.#dpi);
    const charWidth = Math.round(heightDots * 0.6);
    this.#parts.push(
      `^FO${x},${y}^A0N,${heightDots},${charWidth}^FB${width},${lines},0,L,0^FD${escapeZplData(value)}^FS`,
    );
    return this;
  }

  /** `^BY` + `^BC` — Code 128, the symbology every LIS analyzer reads. */
  code128(xMm: number, yMm: number, data: string, heightDots: number, printHri = true): this {
    const x = mmToDots(xMm, this.#dpi);
    const y = mmToDots(yMm, this.#dpi);
    const moduleWidth = this.#dpi === 300 ? 3 : 2;
    this.#parts.push(
      `^FO${x},${y}^BY${moduleWidth},3.0,${heightDots}^BCN,${heightDots},${printHri ? 'Y' : 'N'},N,N^FD${escapeZplData(data)}^FS`,
    );
    return this;
  }

  /** `^BQ` — QR, model 2. `QA,` selects automatic character mode. */
  qr(xMm: number, yMm: number, data: string, magnification = 4): this {
    const x = mmToDots(xMm, this.#dpi);
    const y = mmToDots(yMm, this.#dpi);
    const magnitude = Math.min(10, Math.max(1, Math.trunc(magnification)));
    this.#parts.push(`^FO${x},${y}^BQN,2,${magnitude}^FDQA,${escapeZplData(data)}^FS`);
    return this;
  }

  /** `^GB` — box or rule. */
  box(xMm: number, yMm: number, widthMm: number, heightMm: number, thicknessDots = 2): this {
    const x = mmToDots(xMm, this.#dpi);
    const y = mmToDots(yMm, this.#dpi);
    const width = mmToDots(widthMm, this.#dpi);
    const height = mmToDots(heightMm, this.#dpi);
    this.#parts.push(`^FO${x},${y}^GB${width},${height},${thicknessDots}^FS`);
    return this;
  }

  /** `^FR` inverse field — used for the STAT flag so it reads at arm's length. */
  inverseText(xMm: number, yMm: number, value: string, heightDots: number): this {
    const x = mmToDots(xMm, this.#dpi);
    const y = mmToDots(yMm, this.#dpi);
    const width = Math.round(heightDots * 0.6);
    const boxWidth = Math.round(value.length * width * 1.2);
    this.#parts.push(`^FO${x},${y}^GB${boxWidth},${heightDots + 6},${heightDots + 6}^FS`);
    this.#parts.push(`^FO${x + 4},${y + 3}^A0N,${heightDots},${width}^FR^FD${escapeZplData(value)}^FS`);
    return this;
  }

  /** `^PQ` — number of labels. One per container on a lab order (`EN-005 §14.5`). */
  quantity(copies: number): this {
    this.#parts.push(`^PQ${Math.min(999, Math.max(1, Math.trunc(copies)))},0,1,Y`);
    return this;
  }

  /** `^XZ` — end of label. */
  end(): this {
    this.#parts.push('^XZ');
    return this;
  }

  build(): string {
    return this.#parts.join('');
  }
}

export function zpl(dpi: LabelDpi = 203): ZplBuilder {
  return new ZplBuilder(dpi);
}
