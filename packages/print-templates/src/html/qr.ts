/**
 * A QR Code (ISO/IEC 18004) byte-mode encoder, versions 1–10, rendering to
 * inline SVG.
 *
 * ── Why this is written here rather than installed ──────────────────────────
 *
 * `EN-013 §4` puts a verification QR on every report and receipt, and `EN-005
 * §3.5` requires the A4 pipeline to be self-contained: the renderer runs
 * air-gapped on a ward server, so a remote QR service is not an option and a
 * `<img src="https://…/qr">` is not an option. That leaves "generate the bitmap
 * in-process", and the payload we generate for is *one short opaque URL* — the
 * verify base plus a token. Versions 1–10 at level M carry 213 bytes, roughly
 * three times the longest verify URL a hospital can configure, so the version
 * table stops at 10 instead of 40 and the module is ~400 lines instead of a
 * dependency.
 *
 * ── Properties the rest of the package relies on ────────────────────────────
 *
 *  - **Pure and deterministic.** No clock, no randomness. Mask selection is the
 *    standard penalty score with ties broken by the lower mask number, so the
 *    same string always produces the same modules and therefore the same bytes
 *    of SVG. `docs/09 §11` wants a template's output diffable in review; a QR
 *    that moved between renders would make every report diff.
 *  - **No PHI, enforced elsewhere.** This file encodes whatever string it is
 *    handed. The rule that only an opaque token may reach it lives in
 *    `report-shell.ts`, next to the payload that knows what the identifiers are.
 *  - **Vector, not raster.** A thermal-fused laser print of a 6 mm QR needs
 *    crisp module edges; an SVG path with `shape-rendering: crispEdges` gives
 *    the printer the geometry instead of a resampled bitmap.
 *
 * ── Verification ────────────────────────────────────────────────────────────
 *
 * `qr.spec.ts` checks the arithmetic against values published in the standard
 * rather than against this implementation: the log-form generator polynomials
 * for 7 and 10 EC codewords, the 15-bit format strings (`0x5412` for M/mask 0),
 * and the 18-bit version strings for versions 7–10. Those three tables are what
 * a wrong Galois field or a wrong BCH divisor breaks first.
 */

import { escapeHtml } from './letterhead.js';

import { PrintTemplateError } from '../types.js';

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

/** `[ecCodewordsPerBlock, blocksInGroup1, dataPerBlock1, blocksInGroup2, dataPerBlock2]` */
type BlockSpec = readonly [number, number, number, number, number];

const MAX_VERSION = 10;

/** ISO/IEC 18004 Table 9, versions 1–10. */
const BLOCK_TABLE: Readonly<Record<QrEcc, readonly BlockSpec[]>> = Object.freeze({
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ],
  Q: [
    [13, 1, 13, 0, 0],
    [22, 1, 22, 0, 0],
    [18, 2, 17, 0, 0],
    [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0],
    [18, 2, 14, 4, 15],
    [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17],
    [24, 6, 19, 2, 20],
  ],
  H: [
    [17, 1, 9, 0, 0],
    [28, 1, 16, 0, 0],
    [22, 2, 13, 0, 0],
    [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0],
    [26, 4, 13, 1, 14],
    [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13],
    [28, 6, 15, 2, 16],
  ],
});

/** Alignment-pattern centre coordinates by version (ISO/IEC 18004 Annex E). */
const ALIGNMENT_CENTRES: readonly (readonly number[])[] = Object.freeze([
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]);

/** Unused bits after the last codeword (ISO/IEC 18004 Table 1). */
function remainderBits(version: number): number {
  return version === 1 || version >= 7 ? 0 : 7;
}

// ── GF(256), primitive polynomial x⁸ + x⁴ + x³ + x² + 1 (0x11D) ─────────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255] ?? 0;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

/**
 * The generator polynomial for `degree` error-correction codewords, in
 * coefficient form, highest power first. Exported so the spec can compare it
 * with the log-form table printed in the standard.
 */
export function generatorPolynomial(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      const coefficient = poly[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ coefficient;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(coefficient, GF_EXP[i] ?? 0);
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon remainder — the error-correction codewords for one block. */
export function reedSolomonCodewords(data: Uint8Array, ecLength: number): Uint8Array {
  const generator = generatorPolynomial(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] ?? 0);
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    for (let i = 0; i < ecLength; i += 1) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMul(generator[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}

// ── BCH-protected metadata ──────────────────────────────────────────────────

const ECC_INDICATOR: Readonly<Record<QrEcc, number>> = Object.freeze({ L: 0b01, M: 0b00, Q: 0b11, H: 0b10 });

/** The 15-bit format string for an EC level and mask (ISO/IEC 18004 §8.9). */
export function formatInformation(ecc: QrEcc, mask: number): number {
  const data = (ECC_INDICATOR[ecc] << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 9) & 1) * 0x537);
  }
  return ((data << 10) | (remainder & 0x3ff)) ^ 0x5412;
}

/** The 18-bit version string, present from version 7 (ISO/IEC 18004 §8.10). */
export function versionInformation(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ (((remainder >>> 11) & 1) * 0x1f25);
  }
  return (version << 12) | (remainder & 0xfff);
}

// ── Bit stream ──────────────────────────────────────────────────────────────

class BitBuffer {
  readonly #bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.#bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.#bits.length;
  }

  toCodewords(total: number): Uint8Array {
    const out = new Uint8Array(total);
    for (let i = 0; i < this.#bits.length; i += 1) {
      if ((this.#bits[i] ?? 0) === 1) {
        const index = i >>> 3;
        out[index] = (out[index] ?? 0) | (0x80 >>> (i & 7));
      }
    }
    return out;
  }
}

/** UTF-8 bytes. Byte mode is the only mode this encoder speaks — see the header. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function dataCapacityBytes(version: number, ecc: QrEcc): number {
  const spec = BLOCK_TABLE[ecc][version - 1];
  if (spec === undefined) return 0;
  const [, blocks1, data1, blocks2, data2] = spec;
  const dataCodewords = blocks1 * data1 + blocks2 * data2;
  const countBits = version >= 10 ? 16 : 8;
  return Math.floor((dataCodewords * 8 - 4 - countBits) / 8);
}

function chooseVersion(byteLength: number, ecc: QrEcc, minVersion: number): number {
  for (let version = Math.max(1, minVersion); version <= MAX_VERSION; version += 1) {
    if (byteLength <= dataCapacityBytes(version, ecc)) return version;
  }
  throw new PrintTemplateError(
    `A QR payload of ${String(byteLength)} bytes does not fit in version ${String(MAX_VERSION)} at level ${ecc}. ` +
      'A report verification URL is meant to be a base URL plus an opaque token; anything this long is carrying data it should not.',
  );
}

function buildCodewords(
  text: string,
  ecc: QrEcc,
  minVersion: number,
): { version: number; codewords: Uint8Array } {
  const bytes = utf8(text);
  const version = chooseVersion(bytes.length, ecc, minVersion);
  const spec = BLOCK_TABLE[ecc][version - 1];
  if (spec === undefined)
    throw new PrintTemplateError(`No QR block specification for version ${String(version)}.`);
  const [ecPerBlock, blocks1, data1, blocks2, data2] = spec;
  const dataCodewords = blocks1 * data1 + blocks2 * data2;

  const buffer = new BitBuffer();
  buffer.push(0b0100, 4);
  buffer.push(bytes.length, version >= 10 ? 16 : 8);
  for (const byte of bytes) buffer.push(byte, 8);

  const capacityBits = dataCodewords * 8;
  buffer.push(0, Math.min(4, capacityBits - buffer.length));
  if (buffer.length % 8 !== 0) buffer.push(0, 8 - (buffer.length % 8));

  const raw = buffer.toCodewords(dataCodewords);
  for (let i = buffer.length / 8, pad = 0; i < dataCodewords; i += 1, pad += 1) {
    raw[i] = pad % 2 === 0 ? 0xec : 0x11;
  }

  // Split into blocks, error-correct each, then interleave — §8.6.
  const blocks: { data: Uint8Array; ec: Uint8Array }[] = [];
  let offset = 0;
  for (const [count, size] of [
    [blocks1, data1],
    [blocks2, data2],
  ] as const) {
    for (let i = 0; i < count; i += 1) {
      const data = raw.slice(offset, offset + size);
      offset += size;
      blocks.push({ data, ec: reedSolomonCodewords(data, ecPerBlock) });
    }
  }

  const total = blocks.reduce((sum, block) => sum + block.data.length + block.ec.length, 0);
  const codewords = new Uint8Array(total);
  let cursor = 0;
  const maxData = Math.max(data1, data2);
  for (let i = 0; i < maxData; i += 1) {
    for (const block of blocks) {
      if (i < block.data.length) codewords[cursor++] = block.data[i] ?? 0;
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of blocks) codewords[cursor++] = block.ec[i] ?? 0;
  }

  return { version, codewords };
}

// ── Module placement ────────────────────────────────────────────────────────

/**
 * A finished symbol. `size` counts modules, excluding the quiet zone; `modules`
 * is row-major with `1` for dark.
 */
export interface QrSymbol {
  readonly version: number;
  readonly ecc: QrEcc;
  readonly mask: number;
  readonly size: number;
  readonly modules: Uint8Array;
}

class Canvas {
  readonly size: number;
  readonly modules: Uint8Array;
  readonly reserved: Uint8Array;

  constructor(size: number) {
    this.size = size;
    this.modules = new Uint8Array(size * size);
    this.reserved = new Uint8Array(size * size);
  }

  set(x: number, y: number, dark: number, reserve = true): void {
    this.modules[y * this.size + x] = dark;
    if (reserve) this.reserved[y * this.size + x] = 1;
  }

  isReserved(x: number, y: number): boolean {
    return (this.reserved[y * this.size + x] ?? 0) === 1;
  }
}

function placeFinder(canvas: Canvas, left: number, top: number): void {
  for (let dy = -1; dy <= 7; dy += 1) {
    for (let dx = -1; dx <= 7; dx += 1) {
      const x = left + dx;
      const y = top + dy;
      if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) continue;
      const onRing = (dx === 0 || dx === 6) && dy >= 0 && dy <= 6;
      const onBar = (dy === 0 || dy === 6) && dx >= 0 && dx <= 6;
      const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
      canvas.set(x, y, onRing || onBar || inCore ? 1 : 0);
    }
  }
}

function placeAlignment(canvas: Canvas, version: number): void {
  const centres = ALIGNMENT_CENTRES[version - 1] ?? [];
  const last = canvas.size - 8;
  for (const cy of centres) {
    for (const cx of centres) {
      const nearFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === last) || (cx === last && cy === 6);
      if (nearFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          canvas.set(cx + dx, cy + dy, ring === 1 ? 0 : 1);
        }
      }
    }
  }
}

function placeFunctionPatterns(canvas: Canvas, version: number): void {
  placeFinder(canvas, 0, 0);
  placeFinder(canvas, canvas.size - 7, 0);
  placeFinder(canvas, 0, canvas.size - 7);
  placeAlignment(canvas, version);

  for (let i = 8; i < canvas.size - 8; i += 1) {
    const dark = i % 2 === 0 ? 1 : 0;
    canvas.set(i, 6, dark);
    canvas.set(6, i, dark);
  }

  // The one module that is dark in every symbol (§8.9).
  canvas.set(8, canvas.size - 8, 1);

  // Reserve the format areas so data placement skips them.
  for (let i = 0; i < 9; i += 1) {
    if (!canvas.isReserved(i, 8)) canvas.set(i, 8, 0);
    if (!canvas.isReserved(8, i)) canvas.set(8, i, 0);
  }
  for (let i = 0; i < 8; i += 1) {
    if (!canvas.isReserved(canvas.size - 1 - i, 8)) canvas.set(canvas.size - 1 - i, 8, 0);
    if (!canvas.isReserved(8, canvas.size - 1 - i)) canvas.set(8, canvas.size - 1 - i, 0);
  }

  if (version >= 7) {
    const bits = versionInformation(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = (bits >>> i) & 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + canvas.size - 11;
      canvas.set(a, b, dark);
      canvas.set(b, a, dark);
    }
  }
}

function placeData(canvas: Canvas, codewords: Uint8Array, version: number): void {
  const bitCount = codewords.length * 8 + remainderBits(version);
  let bit = 0;
  let upward = true;

  for (let right = canvas.size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern: the pair of columns jumps over
    // it rather than straddling it, or column 4 would be visited twice.
    if (right === 6) right = 5;
    for (let step = 0; step < canvas.size; step += 1) {
      const y = upward ? canvas.size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (canvas.isReserved(x, y)) continue;
        let dark = 0;
        if (bit < bitCount) {
          const byte = codewords[bit >>> 3] ?? 0;
          dark = (byte >>> (7 - (bit & 7))) & 1;
        }
        canvas.set(x, y, dark, false);
        bit += 1;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(canvas: Canvas, mask: number): Uint8Array {
  const masked = Uint8Array.from(canvas.modules);
  for (let y = 0; y < canvas.size; y += 1) {
    for (let x = 0; x < canvas.size; x += 1) {
      if (canvas.isReserved(x, y)) continue;
      if (maskBit(mask, x, y)) masked[y * canvas.size + x] = (masked[y * canvas.size + x] ?? 0) ^ 1;
    }
  }
  return masked;
}

function writeFormat(canvas: Canvas, modules: Uint8Array, ecc: QrEcc, mask: number): void {
  const bits = formatInformation(ecc, mask);
  const size = canvas.size;
  const put = (x: number, y: number, dark: number): void => {
    modules[y * size + x] = dark;
  };

  for (let i = 0; i <= 5; i += 1) put(i, 8, (bits >>> i) & 1);
  put(7, 8, (bits >>> 6) & 1);
  put(8, 8, (bits >>> 7) & 1);
  put(8, 7, (bits >>> 8) & 1);
  for (let i = 9; i < 15; i += 1) put(8, 14 - i, (bits >>> i) & 1);

  for (let i = 0; i <= 7; i += 1) put(size - 1 - i, 8, (bits >>> i) & 1);
  for (let i = 8; i < 15; i += 1) put(8, size - 15 + i, (bits >>> i) & 1);

  put(8, size - 8, 1);
}

function penalty(modules: Uint8Array, size: number): number {
  const at = (x: number, y: number): number => modules[y * size + x] ?? 0;
  let score = 0;

  // Rule 1 — runs of five or more.
  for (let a = 0; a < size; a += 1) {
    for (const horizontal of [true, false]) {
      let run = 1;
      let previous = horizontal ? at(0, a) : at(a, 0);
      for (let b = 1; b < size; b += 1) {
        const current = horizontal ? at(b, a) : at(a, b);
        if (current === previous) {
          run += 1;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
          previous = current;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2 — 2 × 2 blocks of one colour.
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const v = at(x, y);
      if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) score += 3;
    }
  }

  // Rule 3 — the finder-like 1:1:3:1:1 pattern with a four-module gap.
  const patterns = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ];
  for (let a = 0; a < size; a += 1) {
    for (let b = 0; b <= size - 11; b += 1) {
      for (const pattern of patterns) {
        let horizontalMatch = true;
        let verticalMatch = true;
        for (let i = 0; i < 11; i += 1) {
          if (at(b + i, a) !== pattern[i]) horizontalMatch = false;
          if (at(a, b + i) !== pattern[i]) verticalMatch = false;
        }
        if (horizontalMatch) score += 40;
        if (verticalMatch) score += 40;
      }
    }
  }

  // Rule 4 — deviation from an even split of dark and light.
  let dark = 0;
  for (const module of modules) dark += module;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

export interface QrOptions {
  readonly ecc?: QrEcc | undefined;
  /** Force at least this version, e.g. to keep a module grid stable across reports. */
  readonly minVersion?: number | undefined;
}

/** Encode a string into a QR symbol. Pure: the same input always yields the same modules. */
export function encodeQr(text: string, options: QrOptions = {}): QrSymbol {
  if (text.length === 0) throw new PrintTemplateError('Refusing to encode an empty QR payload.');
  const ecc = options.ecc ?? 'M';
  const { version, codewords } = buildCodewords(text, ecc, options.minVersion ?? 1);

  const canvas = new Canvas(17 + 4 * version);
  placeFunctionPatterns(canvas, version);
  placeData(canvas, codewords, version);

  let best: { mask: number; modules: Uint8Array; score: number } | null = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const modules = applyMask(canvas, mask);
    writeFormat(canvas, modules, ecc, mask);
    const score = penalty(modules, canvas.size);
    // Strictly-less keeps the lowest mask number on a tie, which is what makes
    // the choice reproducible rather than dependent on iteration order.
    if (best === null || score < best.score) best = { mask, modules, score };
  }
  if (best === null) throw new PrintTemplateError('QR mask selection produced no candidate.');

  return { version, ecc, mask: best.mask, size: canvas.size, modules: best.modules };
}

export interface QrSvgOptions extends QrOptions {
  /** Printed edge length including the quiet zone. Default `22mm` — scannable at 600 dpi. */
  readonly sizeCss?: string | undefined;
  /** Quiet zone in modules. The standard requires 4; never print fewer. */
  readonly quietModules?: number | undefined;
  /** Screen-reader text. Must describe the QR, never its payload. */
  readonly ariaLabel?: string | undefined;
  readonly className?: string | undefined;
}

/**
 * Render a symbol as inline SVG.
 *
 * Dark modules are emitted as horizontal runs in a single `<path>`: a 37 × 37
 * symbol is ~700 dark modules but only ~250 runs, and one path also means one
 * fill, which is what keeps `print-color-adjust: exact` from being applied
 * hundreds of times by the print pipeline.
 */
export function renderQrSvg(text: string, options: QrSvgOptions = {}): string {
  const symbol = encodeQr(text, options);
  const quiet = options.quietModules ?? 4;
  if (quiet < 4) {
    throw new PrintTemplateError(
      'A QR quiet zone below 4 modules is outside ISO/IEC 18004 and scanners miss it.',
    );
  }
  const extent = symbol.size + quiet * 2;

  const segments: string[] = [];
  for (let y = 0; y < symbol.size; y += 1) {
    let x = 0;
    while (x < symbol.size) {
      if ((symbol.modules[y * symbol.size + x] ?? 0) === 0) {
        x += 1;
        continue;
      }
      let run = 1;
      while (x + run < symbol.size && (symbol.modules[y * symbol.size + x + run] ?? 0) === 1) run += 1;
      segments.push(`M${String(x + quiet)} ${String(y + quiet)}h${String(run)}v1h-${String(run)}z`);
      x += run;
    }
  }

  const size = options.sizeCss ?? '22mm';
  const label = options.ariaLabel ?? 'QR code linking to the report verification page';
  const className = options.className ?? 'qr';

  return [
    `<svg class="${escapeHtml(className)}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(extent)} ${String(extent)}"`,
    ` width="${escapeHtml(size)}" height="${escapeHtml(size)}" shape-rendering="crispEdges" role="img"`,
    ` aria-label="${escapeHtml(label)}">`,
    `<rect width="${String(extent)}" height="${String(extent)}" fill="#ffffff"/>`,
    `<path fill="#000000" d="${segments.join('')}"/>`,
    '</svg>',
  ].join('');
}
