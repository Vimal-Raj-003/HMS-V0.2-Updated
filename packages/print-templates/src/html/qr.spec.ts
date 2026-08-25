import { describe, expect, it } from 'vitest';

import { PrintTemplateError } from '../types.js';
import {
  encodeQr,
  formatInformation,
  generatorPolynomial,
  renderQrSvg,
  versionInformation,
  type QrSymbol,
} from './qr.js';

/**
 * Two kinds of check live here, and only the second one is worth much.
 *
 *  1. **Against the standard.** The Reed–Solomon generator polynomials, the
 *     15-bit format strings and the 18-bit version strings are printed in
 *     ISO/IEC 18004 and reproduced in every published implementation. If the
 *     Galois field or a BCH divisor is wrong, these fail first and precisely.
 *
 *  2. **Round trip through an independent decoder.** `decodeQr()` below is
 *     written from the specification rather than from `qr.ts`: it recomputes
 *     which modules are function patterns, reads the format information back
 *     out, un-masks, walks the zig-zag itself and parses the byte-mode stream.
 *     It shares no code with the encoder, so agreement between the two means
 *     placement, masking, padding and block interleaving are all right — which
 *     no amount of "the SVG has the expected length" would tell us.
 */

// ── An independent decoder ──────────────────────────────────────────────────

const ALIGNMENT_CENTRES: readonly (readonly number[])[] = [
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
];

function functionModuleMap(size: number, version: number): boolean[] {
  const map = new Array<boolean>(size * size).fill(false);
  const mark = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    map[y * size + x] = true;
  };

  for (const [left, top] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ] as const) {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) mark(left + dx, top + dy);
    }
  }

  for (let i = 0; i < size; i += 1) {
    mark(i, 6);
    mark(6, i);
  }

  const centres = ALIGNMENT_CENTRES[version - 1] ?? [];
  const last = size - 8;
  for (const cy of centres) {
    for (const cx of centres) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === last) || (cx === last && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) mark(cx + dx, cy + dy);
      }
    }
  }

  for (let i = 0; i < 9; i += 1) {
    mark(i, 8);
    mark(8, i);
  }
  for (let i = 0; i < 8; i += 1) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }

  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      mark(a, b);
      mark(b, a);
    }
  }

  return map;
}

function maskPredicate(mask: number, x: number, y: number): boolean {
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

interface BlockLayout {
  readonly blocks: number;
  readonly dataPerBlock: number;
  readonly ecPerBlock: number;
}

/**
 * Read a symbol back. `layout` is supplied by the caller from the published
 * table for that version and level, so the decoder does not import the
 * encoder's copy of it.
 */
function decodeQr(symbol: QrSymbol, layout: BlockLayout): string {
  const { size, modules } = symbol;
  const version = (size - 17) / 4;
  const at = (x: number, y: number): number => modules[y * size + x] ?? 0;

  let formatBits = 0;
  const formatPositions: readonly (readonly [number, number])[] = [
    [0, 8],
    [1, 8],
    [2, 8],
    [3, 8],
    [4, 8],
    [5, 8],
    [7, 8],
    [8, 8],
    [8, 7],
    [8, 5],
    [8, 4],
    [8, 3],
    [8, 2],
    [8, 1],
    [8, 0],
  ];
  formatPositions.forEach(([x, y], index) => {
    formatBits |= at(x, y) << index;
  });
  const format = formatBits ^ 0x5412;
  const mask = (format >>> 10) & 7;

  const functions = functionModuleMap(size, version);
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (functions[y * size + x] === true) continue;
        const raw = at(x, y);
        bits.push(maskPredicate(mask, x, y) ? raw ^ 1 : raw);
      }
    }
    upward = !upward;
  }

  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (bits[i + j] ?? 0);
    codewords.push(byte);
  }

  // Undo the interleave: data codewords come first, round-robin across blocks.
  const blockData: number[][] = Array.from({ length: layout.blocks }, () => []);
  let cursor = 0;
  for (let i = 0; i < layout.dataPerBlock; i += 1) {
    for (let block = 0; block < layout.blocks; block += 1) {
      blockData[block]?.push(codewords[cursor++] ?? 0);
    }
  }
  const data = blockData.flat();

  const countBits = version >= 10 ? 16 : 8;
  const stream: number[] = [];
  for (const byte of data) {
    for (let i = 7; i >= 0; i -= 1) stream.push((byte >>> i) & 1);
  }
  const take = (offset: number, length: number): number => {
    let value = 0;
    for (let i = 0; i < length; i += 1) value = (value << 1) | (stream[offset + i] ?? 0);
    return value;
  };

  const mode = take(0, 4);
  if (mode !== 0b0100) throw new Error(`Expected byte mode, read mode ${String(mode)}`);
  const length = take(4, countBits);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = take(4 + countBits + i * 8, 8);
  return new TextDecoder().decode(bytes);
}

// ── Against the published tables ────────────────────────────────────────────

/** Log-form generator polynomials from ISO/IEC 18004 Annex A. */
const GENERATOR_LOGS: Readonly<Record<number, readonly number[]>> = {
  7: [0, 87, 229, 146, 149, 238, 102, 21],
  10: [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45],
};

function toLogForm(poly: Uint8Array): number[] {
  const exp = new Uint8Array(256);
  const log = new Uint8Array(256);
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    exp[i] = value;
    log[value] = i;
    value <<= 1;
    if ((value & 0x100) !== 0) value ^= 0x11d;
  }
  return [...poly].map((coefficient) => log[coefficient] ?? 0);
}

describe('the Reed–Solomon core', () => {
  it('reproduces the generator polynomials printed in the standard', () => {
    for (const [degree, expected] of Object.entries(GENERATOR_LOGS)) {
      const poly = generatorPolynomial(Number(degree));
      expect(poly.length, `degree ${degree}`).toBe(Number(degree) + 1);
      expect(toLogForm(poly), `degree ${degree}`).toEqual([...expected]);
    }
  });
});

describe('the BCH-protected metadata', () => {
  it('reproduces the 15-bit format strings of ISO/IEC 18004 Table 25', () => {
    // Level M, masks 0–7.
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((mask) => formatInformation('M', mask))).toEqual([
      0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
    ]);
    // Level L and H, first entry of each row.
    expect(formatInformation('L', 0)).toBe(0x77c4);
    expect(formatInformation('Q', 0)).toBe(0x355f);
    expect(formatInformation('H', 0)).toBe(0x1689);
  });

  it('reproduces the 18-bit version strings for versions 7–10', () => {
    expect([7, 8, 9, 10].map(versionInformation)).toEqual([0x07c94, 0x085bc, 0x09a99, 0x0a4d3]);
  });
});

// ── Round trip ──────────────────────────────────────────────────────────────

describe('encoding a verification URL', () => {
  const url = 'https://verify.vims-hospital.example/r/Zk9tQ3RXbFJ4YlZ1TnNBMlk3RGpQZzFF';

  it('chooses the smallest version that fits and decodes back to the same string', () => {
    const symbol = encodeQr(url, { ecc: 'M' });
    // 66 bytes needs version 5 at level M (84-byte capacity); version 4 holds 62.
    expect(symbol.version).toBe(5);
    expect(symbol.size).toBe(37);
    expect(decodeQr(symbol, { blocks: 2, dataPerBlock: 43, ecPerBlock: 24 })).toBe(url);
  });

  it('round-trips a single-block symbol', () => {
    const short = 'https://v.example/r/abcdefghijklmnop';
    const symbol = encodeQr(short, { ecc: 'M' });
    expect(symbol.version).toBe(3);
    expect(decodeQr(symbol, { blocks: 1, dataPerBlock: 44, ecPerBlock: 26 })).toBe(short);
  });

  it('round-trips a four-block symbol, which is what proves the interleave', () => {
    const long = `https://verify.vims-hospital.example/report/${'A1b2C3d4'.repeat(7)}`;
    const symbol = encodeQr(long, { ecc: 'M' });
    expect(symbol.version).toBe(6);
    expect(decodeQr(symbol, { blocks: 4, dataPerBlock: 27, ecPerBlock: 16 })).toBe(long);
  });

  it('round-trips at every error-correction level, each at its own version', () => {
    // Version and block layout for a 30-byte payload, from ISO/IEC 18004
    // Table 9 — the stronger the level, the smaller the payload each version
    // holds, so the four levels land on three different versions.
    const expected: Readonly<Record<'L' | 'M' | 'Q' | 'H', { version: number; layout: BlockLayout }>> = {
      L: { version: 2, layout: { blocks: 1, dataPerBlock: 34, ecPerBlock: 10 } },
      M: { version: 3, layout: { blocks: 1, dataPerBlock: 44, ecPerBlock: 26 } },
      Q: { version: 3, layout: { blocks: 2, dataPerBlock: 17, ecPerBlock: 18 } },
      H: { version: 4, layout: { blocks: 4, dataPerBlock: 9, ecPerBlock: 16 } },
    };
    const text = 'https://v.example/r/abcdefghij';
    expect(text).toHaveLength(30);
    for (const level of ['L', 'M', 'Q', 'H'] as const) {
      const symbol = encodeQr(text, { ecc: level });
      expect(symbol.version, level).toBe(expected[level].version);
      expect(decodeQr(symbol, expected[level].layout), level).toBe(text);
    }
  });

  it('round-trips a version-7 symbol, which carries version information modules', () => {
    const text = `https://verify.example/r/${'x'.repeat(93)}`;
    const symbol = encodeQr(text, { ecc: 'M' });
    expect(symbol.version).toBe(7);
    expect(decodeQr(symbol, { blocks: 4, dataPerBlock: 31, ecPerBlock: 18 })).toBe(text);
  });
});

describe('determinism', () => {
  it('produces identical modules for identical input', () => {
    const a = encodeQr('https://v.example/r/token-one-two-three');
    const b = encodeQr('https://v.example/r/token-one-two-three');
    expect(a.mask).toBe(b.mask);
    expect([...a.modules]).toEqual([...b.modules]);
    expect(renderQrSvg('https://v.example/r/token')).toBe(renderQrSvg('https://v.example/r/token'));
  });
});

describe('the SVG', () => {
  const svg = renderQrSvg('https://v.example/r/abcdefghijkl');

  it('is self-contained, sized in millimetres and labelled without a payload', () => {
    expect(svg.startsWith('<svg class="qr"')).toBe(true);
    expect(svg).toContain('width="22mm"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('aria-label="QR code linking to the report verification page"');
    // Nothing to fetch: the SVG namespace URI is a namespace, not a resource.
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('href');
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toContain('http');
    // The payload is drawn, never written out as text.
    expect(svg).not.toContain('abcdefghijkl');
    expect(svg).toContain('</svg>');
  });

  it('leaves a four-module quiet zone, and refuses a smaller one', () => {
    const symbol = encodeQr('https://v.example/r/abcdefghijkl');
    expect(svg).toContain(`viewBox="0 0 ${String(symbol.size + 8)} ${String(symbol.size + 8)}"`);
    // The first dark run cannot start before the quiet zone.
    expect(svg).toContain('d="M4 4h7');
    expect(() => renderQrSvg('https://v.example/r/abc', { quietModules: 2 })).toThrow(PrintTemplateError);
  });

  it('draws the three finder patterns', () => {
    const symbol = encodeQr('https://v.example/r/abcdefghijkl');
    const at = (x: number, y: number): number => symbol.modules[y * symbol.size + x] ?? 0;
    for (const [left, top] of [
      [0, 0],
      [symbol.size - 7, 0],
      [0, symbol.size - 7],
    ] as const) {
      expect(at(left, top), 'outer corner').toBe(1);
      expect(at(left + 1, top + 1), 'inner ring').toBe(0);
      expect(at(left + 3, top + 3), 'core').toBe(1);
    }
  });
});

describe('refusals', () => {
  it('refuses an empty payload', () => {
    expect(() => encodeQr('')).toThrow(PrintTemplateError);
  });

  it('refuses a payload too large for the version range this encoder covers', () => {
    expect(() => encodeQr('x'.repeat(300), { ecc: 'M' })).toThrow(PrintTemplateError);
    expect(() => encodeQr('x'.repeat(300), { ecc: 'M' })).toThrow(/opaque token/);
  });
});
