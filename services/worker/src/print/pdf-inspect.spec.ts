import { describe, expect, it } from 'vitest';

import {
  PAPER_POINTS,
  countPdfPages,
  extractPdfText,
  extractPdfTextPages,
  isPdf,
  pdfPageGeometries,
  pdfVersion,
} from './pdf-inspect.js';

/**
 * These fixtures are hand-written PDFs with **uncompressed** streams, so the
 * parser is tested against a known-correct document rather than against
 * whatever Chromium happened to emit today. The Chromium round trip is the job
 * of `print.integration.spec.ts`; this is the unit that proves the CMap and
 * content-stream logic, including the per-font case a merged CMap gets wrong.
 */

function cmap(entries: ReadonlyArray<readonly [string, string]>): string {
  const chars = entries.map(([code, unicode]) => `<${code}> <${unicode}>`).join('\n');
  return [
    '/CIDInit /ProcSet findresource begin',
    'begincmap',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${entries.length} beginbfchar`,
    chars,
    'endbfchar',
    'endcmap',
    'end',
  ].join('\n');
}

function object(num: number, header: string, stream?: string): string {
  if (stream === undefined) return `${num} 0 obj\n${header}\nendobj\n`;
  return `${num} 0 obj\n${header}\nstream\n${stream}\nendstream\nendobj\n`;
}

function buildPdf(): Uint8Array {
  const parts = [
    '%PDF-1.4\n',
    object(1, '<< /Type /Pages /Count 2 /Kids [2 0 R 6 0 R] >>'),
    object(
      2,
      '<< /Type /Page /Parent 1 0 R /MediaBox [0 0 595.28 841.89] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    ),
    object(3, '<< /Type /Font /Subtype /Type0 /ToUnicode 4 0 R >>'),
    object(
      4,
      '<< /Length 200 >>',
      cmap([
        ['0001', '0048'],
        ['0002', '0069'],
        ['0003', '0021'],
      ]),
    ),
    object(
      5,
      '<< /Length 120 >>',
      'BT\n/F1 12 Tf\n<000100020003> Tj\nET\nBT\n/F1 12 Tf\n[<0001> -220 <0002>] TJ\nET\n',
    ),
    // A second page whose font assigns *different* meanings to the same codes.
    object(
      6,
      '<< /Type /Page /Parent 1 0 R /MediaBox [0 0 419.53 595.28] /Resources << /Font << /F1 7 0 R >> >> /Contents 9 0 R >>',
    ),
    object(7, '<< /Type /Font /Subtype /Type0 /DescendantFonts [8 0 R] >>'),
    object(8, '<< /Type /Font /ToUnicode 10 0 R >>'),
    object(9, '<< /Length 60 >>', 'BT\n/F1 10 Tf\n<00010002> Tj\nET\n'),
    object(
      10,
      '<< /Length 200 >>',
      cmap([
        ['0001', '005A'],
        ['0002', '005A'],
      ]),
    ),
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  ];
  return new Uint8Array(Buffer.from(parts.join(''), 'latin1'));
}

const PDF = buildPdf();

describe('PDF structure', () => {
  it('recognises the signature and version', () => {
    expect(isPdf(PDF)).toBe(true);
    expect(pdfVersion(PDF)).toBe('1.4');
    expect(isPdf(new Uint8Array(Buffer.from('<html></html>')))).toBe(false);
  });

  /** `/Type /Pages` must not be counted as a page — pages are what get billed. */
  it('reads the page count from the page tree, not by counting /Type /Page', () => {
    expect(countPdfPages(PDF)).toBe(2);
  });

  it('reads each page box, so "this is A4" is checkable', () => {
    const boxes = pdfPageGeometries(PDF);
    expect(boxes[0]?.widthPt).toBeCloseTo(PAPER_POINTS.A4.widthPt, 1);
    expect(boxes[0]?.heightPt).toBeCloseTo(PAPER_POINTS.A4.heightPt, 1);
    expect(boxes[1]?.widthPt).toBeCloseTo(PAPER_POINTS.A5.widthPt, 1);
  });
});

describe('PDF text extraction', () => {
  it('decodes hex-encoded glyph ids through the font ToUnicode CMap', () => {
    const pages = extractPdfTextPages(PDF);
    expect(pages[0]?.text).toContain('Hi!');
  });

  it('takes the string operands of a TJ array and ignores its kerning numbers', () => {
    expect(extractPdfTextPages(PDF)[0]?.text).toContain('Hi\n');
    expect(extractPdfText(PDF)).not.toContain('220');
  });

  /**
   * The reason CMaps are resolved per page and per font: subset fonts number
   * their glyphs independently, so code 0x0001 is `H` in one font and `Z` in
   * the next. A merged table would decode this document as "HiH".
   */
  it('resolves a second page through its own font, including a descendant font', () => {
    expect(extractPdfTextPages(PDF)[1]?.text).toContain('ZZ');
    expect(extractPdfTextPages(PDF)[1]?.text).not.toContain('Hi');
  });
});
