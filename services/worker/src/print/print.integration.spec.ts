import {
  a4DocumentTemplate,
  renderA4Document,
  sampleContext,
  tokenSlipTemplate,
  type A4DocumentPayload,
} from '@vims/print-templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EscPosEmulator } from './escpos-emulator.js';
import {
  PAPER_POINTS,
  countPdfPages,
  extractPdfText,
  isPdf,
  pdfPageGeometries,
  pdfVersion,
} from './pdf-inspect.js';
import { PlaywrightPdfRenderer } from './pdf-renderer.js';
import type { PrintArtifact, PrinterTarget } from './types.js';

/**
 * **Phase 0 exit gate 6** — "a test job printed a token to the ESC/POS emulator
 * and a PDF rendered with a hospital letterhead".
 *
 * This runs a real Chromium. It is the only test in the print pipeline that
 * does, and it exists because everything else in the pipeline is a pure function
 * over strings: a suite of green unit tests proves the *templates* are right and
 * says nothing about whether a browser can turn them into paper. The assertions
 * are therefore made on the rendered artefacts — the PDF is parsed back and its
 * text decoded through the font CMaps, and the ESC/POS stream is decoded back to
 * the characters and control sequences a counter would receive.
 */

const CONTEXT = sampleContext();

const BILL_PAYLOAD: A4DocumentPayload = {
  title: 'Tax Invoice',
  subtitle: 'Outpatient consultation and investigations',
  meta: [
    { label: 'Bill No', value: 'OPB-2026-000481' },
    { label: 'Date', value: '20-Aug-2026 09:14' },
    { label: 'UHID', value: 'CBE-000123456' },
    { label: 'Payer', value: 'Self' },
  ],
  sections: [
    {
      heading: 'Charges',
      table: {
        columns: [{ label: 'Service' }, { label: 'Qty', align: 'end' }, { label: 'Amount', align: 'end' }],
        rows: [
          ['Orthopaedic consultation', '1', '600.00'],
          ['X-Ray, knee AP/Lateral', '1', '450.00'],
        ],
        footRows: [['Total', '', '1050.00']],
      },
    },
  ],
  signature: { name: 'R. Devi', designation: 'Front Office' },
};

const PRINTER: PrinterTarget = {
  printerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  name: 'OPD Counter 3 thermal',
  kind: 'thermal',
  driverMode: 'raw_escpos',
  paper: 'thermal_80mm',
  status: 'online',
  agentId: null,
  agentStatus: null,
  agentLastHeartbeatAt: null,
  branchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

let renderer: PlaywrightPdfRenderer;

beforeAll(async () => {
  renderer = new PlaywrightPdfRenderer();
  // Fail here, loudly, if the browser is missing — rather than in every test.
  await renderer.renderHtml({ html: '<!doctype html><html><body>warm-up</body></html>', paper: 'A4' });
}, 120_000);

afterAll(async () => {
  await renderer?.close();
});

function within(actual: number, expected: number, tolerancePt = 2): boolean {
  return Math.abs(actual - expected) <= tolerancePt;
}

describe('gate 6 · a PDF rendered with a hospital letterhead', () => {
  it('produces a structurally valid PDF of non-trivial size', async () => {
    const rendered = a4DocumentTemplate.render(BILL_PAYLOAD, CONTEXT);
    if (rendered.format !== 'a4') throw new Error('the A4 template must render HTML');

    const artifact = await renderer.renderDocument(rendered);

    expect(isPdf(artifact.bytes)).toBe(true);
    expect(pdfVersion(artifact.bytes)).toMatch(/^1\./);
    // A blank page is ~5 kB; an embedded-font letterhead is an order more.
    expect(artifact.bytes.byteLength).toBeGreaterThan(20_000);
    expect(artifact.contentType).toBe('application/pdf');
    expect(artifact.pages).toBe(1);
    expect(countPdfPages(artifact.bytes)).toBe(1);
  });

  it('lays the page out at A4, from the template stylesheet', async () => {
    const rendered = a4DocumentTemplate.render(BILL_PAYLOAD, CONTEXT);
    if (rendered.format !== 'a4') throw new Error('unreachable');

    const artifact = await renderer.renderDocument(rendered);
    const box = pdfPageGeometries(artifact.bytes)[0];

    expect(box).toBeDefined();
    expect(within(box?.widthPt ?? 0, PAPER_POINTS.A4.widthPt)).toBe(true);
    expect(within(box?.heightPt ?? 0, PAPER_POINTS.A4.heightPt)).toBe(true);
  });

  it('lays the same document out at A5 when the template asks for A5', async () => {
    const rendered = renderA4Document(BILL_PAYLOAD, CONTEXT, 'A5');
    const artifact = await renderer.renderDocument(rendered);
    const box = pdfPageGeometries(artifact.bytes)[0];

    expect(rendered.format).toBe('a5');
    expect(within(box?.widthPt ?? 0, PAPER_POINTS.A5.widthPt)).toBe(true);
    expect(within(box?.heightPt ?? 0, PAPER_POINTS.A5.heightPt)).toBe(true);
  });

  /**
   * The gate's actual claim. A PDF that is valid but blank would pass every
   * structural check above, so the letterhead is read back out of the file.
   */
  it('carries the hospital letterhead as readable text', async () => {
    const rendered = a4DocumentTemplate.render(BILL_PAYLOAD, CONTEXT);
    if (rendered.format !== 'a4') throw new Error('unreachable');

    const artifact = await renderer.renderDocument(rendered);
    const text = extractPdfText(artifact.bytes);

    expect(text).toContain(CONTEXT.hospital.name);
    expect(text).toContain(CONTEXT.hospital.legalName ?? '');
    expect(text).toContain(CONTEXT.branch.name);
    expect(text).toContain('Coimbatore 641004, Tamil Nadu');
    expect(text).toContain(CONTEXT.hospital.gstin ?? '');
    expect(text).toContain('NABH accredited');
  });

  it('carries the document body: title, metadata, charge lines and the print footer', async () => {
    const rendered = a4DocumentTemplate.render(BILL_PAYLOAD, CONTEXT);
    if (rendered.format !== 'a4') throw new Error('unreachable');

    const text = extractPdfText((await renderer.renderDocument(rendered)).bytes);

    expect(text).toContain('Tax Invoice');
    expect(text).toContain('OPB-2026-000481');
    expect(text).toContain('Orthopaedic consultation');
    expect(text).toContain('1050.00');
    expect(text).toContain('Printed by R. Devi (Front Office)');
  });

  /** `EN-005 §5`: a reprint must be visibly marked and carry its reason. */
  it('stamps DUPLICATE and the reason on a reprint', async () => {
    const duplicateContext = sampleContext({ duplicate: true, duplicateReason: 'Patient lost the original' });
    const rendered = a4DocumentTemplate.render(BILL_PAYLOAD, duplicateContext);
    if (rendered.format !== 'a4') throw new Error('unreachable');

    const text = extractPdfText((await renderer.renderDocument(rendered)).bytes);

    expect(text).toContain('DUPLICATE');
    expect(text).toContain('Patient lost the original');
  });

  /** `pages` is what `EN-005 §3.6` bills a department by, so it must be real. */
  it('paginates a long document and reports the page count', async () => {
    const long: A4DocumentPayload = {
      ...BILL_PAYLOAD,
      sections: Array.from({ length: 12 }, (_unused, index) => ({
        heading: `Section ${index + 1}`,
        paragraphs: Array.from({ length: 8 }, (_line, line) => `Line ${line + 1} of section ${index + 1}.`),
      })),
    };

    const rendered = a4DocumentTemplate.render(long, CONTEXT);
    if (rendered.format !== 'a4') throw new Error('unreachable');
    const artifact = await renderer.renderDocument(rendered);

    expect(artifact.pages).toBeGreaterThan(1);
    expect(countPdfPages(artifact.bytes)).toBe(artifact.pages);
    expect(pdfPageGeometries(artifact.bytes)).toHaveLength(artifact.pages ?? 0);
  });

  it('refuses to render an empty document rather than emitting a blank sheet', async () => {
    await expect(renderer.renderHtml({ html: '   ', paper: 'A4' })).rejects.toThrow(/empty document/);
  });
});

describe('gate 6 · a token printed to the ESC/POS emulator', () => {
  const payload = {
    tokenNumber: 'C-45',
    counterName: 'Counter 3',
    departmentName: 'Orthopaedics OPD',
    doctorName: 'Dr S. Iyer',
    queueAhead: 4,
    issuedAtLabel: '20-08-2026 09:14',
    qrData: 'https://hms.example.invalid/t/C-45',
  };

  function tokenArtifact(): PrintArtifact {
    const rendered = tokenSlipTemplate.render(payload, CONTEXT);
    if (rendered.format !== 'escpos') throw new Error('the token template must render ESC/POS');
    return { format: 'escpos', contentType: rendered.contentType, bytes: rendered.bytes, pages: null };
  }

  it('decodes back to a slip containing the token number, the counter and a cut', async () => {
    const emulator = new EscPosEmulator();
    const result = await emulator.send({
      jobId: 'gate-6',
      printer: PRINTER,
      artifact: tokenArtifact(),
      copies: 1,
    });

    expect(result.state).toBe('printed');

    const slip = emulator.lastSlip;
    expect(slip).toBeDefined();
    expect(slip?.text).toContain('C-45');
    expect(slip?.text).toContain('Counter 3');
    expect(slip?.text).toContain('Ahead of you');
    expect(slip?.text).toContain(CONTEXT.hospital.name);
    expect(slip?.hasControl('CUT_PARTIAL')).toBe(true);
    expect(slip?.controls.at(-1)?.hex).toBe('1D 56 42 03');
    expect(slip?.qrPayloads).toEqual([payload.qrData]);
  });

  it('leaves the slip unprinted and the fault visible when the printer is out of paper', async () => {
    const emulator = new EscPosEmulator({ fault: 'paper_out' });
    await expect(
      emulator.send({ jobId: 'gate-6-offline', printer: PRINTER, artifact: tokenArtifact(), copies: 1 }),
    ).rejects.toMatchObject({ name: 'PrinterUnavailableError', reason: 'paper_out' });
    expect(emulator.slips).toHaveLength(0);
  });
});
