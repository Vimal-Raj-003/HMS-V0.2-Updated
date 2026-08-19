import { inflateSync } from 'node:zlib';

/**
 * A minimal PDF reader — enough to *prove* something about a PDF we just made.
 *
 * Phase 0 exit gate 6 is "a PDF rendered with a hospital letterhead". A test
 * that asserts only `%PDF-` and a byte length proves Chromium started, not that
 * the letterhead reached the page: a blank A4 satisfies it exactly as well. So
 * this module reads back the three things that make the claim real — the page
 * geometry, the page count, and the actual text, decoded through each font's
 * `/ToUnicode` CMap.
 *
 * It is deliberately *not* a general PDF parser and never will be. It handles
 * what Skia (Chromium's PDF backend) emits: uncompressed object headers,
 * `FlateDecode` content streams, Identity CID fonts with a `/ToUnicode` CMap.
 * Anything else it declines to decode rather than guessing, because a text
 * extractor that silently returns "" would turn gate 6 into a test that passes
 * when the renderer is broken.
 */

const PDF_MAGIC = '%PDF-';

function toLatin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');
}

/** The file signature. The cheapest possible "is this actually a PDF". */
export function isPdf(bytes: Uint8Array): boolean {
  return toLatin1(bytes.subarray(0, PDF_MAGIC.length)) === PDF_MAGIC;
}

export function pdfVersion(bytes: Uint8Array): string | null {
  const header = toLatin1(bytes.subarray(0, 16));
  const match = /^%PDF-(\d+\.\d+)/.exec(header);
  return match?.[1] ?? null;
}

export interface PdfPageGeometry {
  readonly widthPt: number;
  readonly heightPt: number;
}

/** ISO 216 sizes in PostScript points, for asserting "this really is A4". */
export const PAPER_POINTS: Readonly<Record<'A4' | 'A5', PdfPageGeometry>> = Object.freeze({
  A4: { widthPt: 595.28, heightPt: 841.89 },
  A5: { widthPt: 419.53, heightPt: 595.28 },
});

/** Every `/MediaBox` in the file, in document order. */
export function pdfPageGeometries(bytes: Uint8Array): readonly PdfPageGeometry[] {
  const raw = toLatin1(bytes);
  const found: PdfPageGeometry[] = [];
  const re = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g;
  let match = re.exec(raw);
  while (match !== null) {
    const x0 = Number(match[1]);
    const y0 = Number(match[2]);
    const x1 = Number(match[3]);
    const y1 = Number(match[4]);
    found.push({ widthPt: Math.abs(x1 - x0), heightPt: Math.abs(y1 - y0) });
    match = re.exec(raw);
  }
  return found;
}

/**
 * Page count.
 *
 * Read from the page tree's `/Count` where present — counting `/Type /Page`
 * occurrences alone would also match `/Type /Pages` and inflate the total, which
 * matters because `pages` is what `EN-005 §3.6` bills departments by.
 */
export function countPdfPages(bytes: Uint8Array): number {
  const raw = toLatin1(bytes);
  const counts = [...raw.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const alternate = [...raw.matchAll(/\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map((m) => Number(m[1]));
  const all = [...counts, ...alternate].filter((n) => Number.isFinite(n) && n > 0);
  if (all.length > 0) return Math.max(...all);
  return (raw.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

// ── object graph ─────────────────────────────────────────────────────────────

interface PdfObject {
  readonly num: number;
  readonly header: string;
  readonly stream: Buffer | null;
}

function parseObjects(raw: string): ReadonlyMap<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let match = re.exec(raw);
  while (match !== null) {
    const num = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const end = raw.indexOf('endobj', bodyStart);
    const body = raw.slice(bodyStart, end < 0 ? undefined : end);

    const streamMatch = /stream\r?\n/.exec(body);
    let header = body;
    let stream: Buffer | null = null;
    if (streamMatch !== null) {
      header = body.slice(0, streamMatch.index);
      const dataStart = streamMatch.index + streamMatch[0].length;
      const dataEnd = body.indexOf('endstream', dataStart);
      stream = Buffer.from(body.slice(dataStart, dataEnd < 0 ? undefined : dataEnd), 'latin1');
    }

    objects.set(num, { num, header, stream });
    match = re.exec(raw);
  }
  return objects;
}

function decodeStream(object: PdfObject): string | null {
  if (object.stream === null) return null;
  if (/\/FlateDecode/.test(object.header)) {
    try {
      return inflateSync(object.stream).toString('latin1');
    } catch {
      // A stream we cannot inflate contributes nothing; returning null keeps the
      // caller honest instead of yielding partial gibberish as if it were text.
      return null;
    }
  }
  return object.stream.toString('latin1');
}

// ── /ToUnicode CMaps ─────────────────────────────────────────────────────────

interface UnicodeCMap {
  /** Bytes per character code — 2 for the Identity CID fonts Chromium emits. */
  readonly codeBytes: number;
  readonly map: ReadonlyMap<number, string>;
}

function hexToCodePoints(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  let out = '';
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    out += String.fromCharCode(Number.parseInt(clean.slice(i, i + 4), 16));
  }
  return out;
}

function parseCMap(source: string): UnicodeCMap {
  const map = new Map<number, string>();

  const codespace = /begincodespacerange\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(source);
  const codeBytes = codespace?.[1] !== undefined ? Math.max(1, codespace[1].length / 2) : 2;

  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const body = block[1] ?? '';
    for (const pair of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(Number.parseInt(pair[1] ?? '0', 16), hexToCodePoints(pair[2] ?? ''));
    }
  }

  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? '';
    for (const entry of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const lo = Number.parseInt(entry[1] ?? '0', 16);
      const hi = Number.parseInt(entry[2] ?? '0', 16);
      const start = Number.parseInt(entry[3] ?? '0', 16);
      for (let code = lo; code <= hi && code - lo < 0xffff; code += 1) {
        map.set(code, String.fromCharCode(start + (code - lo)));
      }
    }
    for (const entry of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = Number.parseInt(entry[1] ?? '0', 16);
      const items = [...(entry[3] ?? '').matchAll(/<([0-9A-Fa-f]+)>/g)];
      items.forEach((item, index) => {
        map.set(lo + index, hexToCodePoints(item[1] ?? ''));
      });
    }
  }

  return { codeBytes, map };
}

/**
 * Resource name (`/F4`) → CMap, **per page**.
 *
 * Merging every font's CMap into one table looks simpler and is wrong: subset
 * fonts assign glyph ids independently, so code `0x0037` is `T` in one font and
 * something else in the next. A merged table decodes most documents correctly
 * and mangles exactly the multi-font ones — which is every real letterhead.
 */
function fontCMapsFor(
  pageHeader: string,
  objects: ReadonlyMap<number, PdfObject>,
): ReadonlyMap<string, UnicodeCMap> {
  const cmaps = new Map<string, UnicodeCMap>();

  let resources = pageHeader;
  const indirectResources = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageHeader);
  if (indirectResources !== null) {
    resources = objects.get(Number(indirectResources[1]))?.header ?? pageHeader;
  }

  const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources);
  if (fontDict === null) return cmaps;

  for (const entry of (fontDict[1] ?? '').matchAll(/\/([A-Za-z0-9_.+-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const name = entry[1];
    const fontObject = objects.get(Number(entry[2]));
    if (name === undefined || fontObject === undefined) continue;

    // A composite font points at a descendant; the /ToUnicode lives on either.
    const candidates: PdfObject[] = [fontObject];
    for (const descendant of fontObject.header.matchAll(/\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/g)) {
      const child = objects.get(Number(descendant[1]));
      if (child !== undefined) candidates.push(child);
    }

    for (const candidate of candidates) {
      const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(candidate.header);
      if (ref === null) continue;
      const cmapObject = objects.get(Number(ref[1]));
      if (cmapObject === undefined) continue;
      const source = decodeStream(cmapObject);
      if (source === null) continue;
      cmaps.set(name, parseCMap(source));
      break;
    }
  }

  return cmaps;
}

// ── content stream → text ────────────────────────────────────────────────────

function decodeHexString(hex: string, cmap: UnicodeCMap | undefined): string {
  const clean = hex.replace(/\s+/g, '');
  if (cmap === undefined) {
    // No CMap: the codes are single bytes in the font's built-in encoding, which
    // for the Latin text this system prints is close enough to ASCII to be read.
    let out = '';
    for (let i = 0; i + 2 <= clean.length; i += 2)
      out += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16));
    return out;
  }
  const width = cmap.codeBytes * 2;
  let out = '';
  for (let i = 0; i + width <= clean.length; i += width) {
    const code = Number.parseInt(clean.slice(i, i + width), 16);
    out += cmap.map.get(code) ?? '';
  }
  return out;
}

function decodeLiteralString(literal: string): string {
  return literal.replace(/\\([nrtbf()\\])/g, (_all, char: string) => {
    switch (char) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return char;
    }
  });
}

const TOKEN_RE =
  /\/([A-Za-z0-9_.+-]+)\s+[-\d.]+\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:[^[\]]|\\.)*)\]\s*TJ|\bET\b/g;

function contentToText(content: string, cmaps: ReadonlyMap<string, UnicodeCMap>): string {
  let current: UnicodeCMap | undefined;
  let out = '';

  for (const token of content.matchAll(TOKEN_RE)) {
    const [all, fontName, hexRun, literalRun, arrayRun] = token;

    if (fontName !== undefined) {
      current = cmaps.get(fontName);
      continue;
    }
    if (hexRun !== undefined) {
      out += decodeHexString(hexRun, current);
      continue;
    }
    if (literalRun !== undefined) {
      out += decodeLiteralString(literalRun);
      continue;
    }
    if (arrayRun !== undefined) {
      // Kerning numbers inside a TJ array only move the pen; the glyphs are the
      // string operands.
      for (const item of arrayRun.matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\)])*)\)/g)) {
        if (item[1] !== undefined) out += decodeHexString(item[1], current);
        else if (item[2] !== undefined) out += decodeLiteralString(item[2]);
      }
      continue;
    }
    if (all === 'ET') out += '\n';
  }

  return out;
}

export interface PdfTextPage {
  readonly pageIndex: number;
  readonly text: string;
}

/**
 * Extract the visible text of every page, NFKC-normalised.
 *
 * Newlines mark `ET` (end of a text object), which is one visual line in
 * Chromium's output; horizontal repositioning inside a line is *not* turned into
 * whitespace, because Skia splits a single word across several `Td` runs and
 * inserting a space there would corrupt every word it renders.
 */
export function extractPdfTextPages(bytes: Uint8Array): readonly PdfTextPage[] {
  const raw = toLatin1(bytes);
  const objects = parseObjects(raw);
  const pages: PdfTextPage[] = [];

  let pageIndex = 0;
  for (const object of objects.values()) {
    if (!/\/Type\s*\/Page[^s]/.test(`${object.header} `)) continue;

    const cmaps = fontCMapsFor(object.header, objects);
    const contentRefs: number[] = [];
    const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(object.header);
    if (single !== null) contentRefs.push(Number(single[1]));
    const array = /\/Contents\s*\[([^\]]*)\]/.exec(object.header);
    if (array !== null) {
      for (const ref of (array[1] ?? '').matchAll(/(\d+)\s+\d+\s+R/g)) contentRefs.push(Number(ref[1]));
    }

    let text = '';
    for (const ref of contentRefs) {
      const contentObject = objects.get(ref);
      if (contentObject === undefined) continue;
      const content = decodeStream(contentObject);
      if (content === null) continue;
      text += contentToText(content, cmaps);
    }

    // NFKC folds the Latin ligatures the font substitutes — Chromium maps the
    // "ffi" glyph to U+FB03, which is correct Unicode and never what a caller
    // searching for "Office" expects. Nothing else about the text changes.
    pages.push({ pageIndex, text: text.normalize('NFKC') });
    pageIndex += 1;
  }

  return pages;
}

/** All pages' text, joined. Convenience for "does the hospital name appear?". */
export function extractPdfText(bytes: Uint8Array): string {
  return extractPdfTextPages(bytes)
    .map((page) => page.text)
    .join('\n');
}
