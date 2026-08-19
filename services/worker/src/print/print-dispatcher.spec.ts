import { labLabelTemplate, sampleContext, tokenSlipTemplate } from '@vims/print-templates';
import { describe, expect, it } from 'vitest';

import { EscPosEmulator, decodeEscPos } from './escpos-emulator.js';
import type { PdfRenderRequest, PdfRendererPort } from './pdf-renderer.js';
import {
  MapTransportResolver,
  StaticPayloadSource,
  assertDriverAccepts,
  dispatchArtifact,
  renderPrintArtifact,
} from './print-dispatcher.js';
import type { PrintJobRecord } from './print-job-repository.js';
import { PrintPermanentError, type PrintArtifact, type PrinterTarget } from './types.js';

/** A PDF renderer that records what it was asked for and needs no browser. */
class FakePdfRenderer implements PdfRendererPort {
  readonly requests: PdfRenderRequest[] = [];

  renderHtml(request: PdfRenderRequest): Promise<PrintArtifact> {
    this.requests.push(request);
    return Promise.resolve({
      format: 'pdf',
      contentType: 'application/pdf',
      bytes: new Uint8Array(Buffer.from('%PDF-1.4 fake')),
      pages: 1,
    });
  }
}

function job(overrides: Partial<PrintJobRecord> = {}): PrintJobRecord {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    createdAt: new Date('2026-08-20T09:14:00Z'),
    createdAtText: '2026-08-20 09:14:00+00',
    hospitalId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    branchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    docType: 'token',
    templateKey: null,
    printerId: null,
    agentId: null,
    requestedBy: null,
    workstationId: null,
    sourceModule: 'EN-006',
    sourceRefType: null,
    sourceRefId: null,
    patientId: null,
    phi: false,
    fileId: null,
    renderJobId: null,
    format: 'escpos',
    copies: 1,
    pages: null,
    status: 'queued',
    priority: 2,
    attempts: 0,
    error: null,
    isReprint: false,
    reprintReason: null,
    ...overrides,
  };
}

function printer(overrides: Partial<PrinterTarget> = {}): PrinterTarget {
  return {
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
    ...overrides,
  };
}

const TOKEN_PAYLOAD = {
  tokenNumber: 'C-45',
  counterName: 'Counter 3',
  departmentName: 'Orthopaedics OPD',
  queueAhead: 4,
  issuedAtLabel: '20-08-2026 09:14',
};

describe('renderPrintArtifact', () => {
  it('falls back to the built-in template for the document type when the job names none', async () => {
    const artifact = await renderPrintArtifact(
      job(),
      { payload: TOKEN_PAYLOAD, context: sampleContext() },
      new FakePdfRenderer(),
    );
    expect(artifact.format).toBe('escpos');
    expect(decodeEscPos(artifact.bytes).text).toContain('C-45');
    // Continuous roll: no sheets to bill (EN-005 §3.6).
    expect(artifact.pages).toBeNull();
  });

  it('routes an HTML template through the PDF renderer at its declared paper size', async () => {
    const pdf = new FakePdfRenderer();
    const artifact = await renderPrintArtifact(
      job({ docType: 'bill_a4', templateKey: 'bill_a4.html.v1', format: 'pdf' }),
      { payload: { title: 'Tax Invoice', meta: [], sections: [] }, context: sampleContext() },
      pdf,
    );

    expect(pdf.requests[0]?.paper).toBe('A4');
    // The letterhead is in the markup handed to Chromium; the apostrophe in the
    // hospital name arrives HTML-escaped, which is itself worth pinning down.
    expect(pdf.requests[0]?.html).toContain('Multispeciality Hospital');
    expect(pdf.requests[0]?.html).toContain('Vim&#39;s Trauma');
    expect(artifact.format).toBe('pdf');
    expect(artifact.pages).toBe(1);
  });

  it('serialises ZPL as text and carries the label quantity as its page count', async () => {
    const artifact = await renderPrintArtifact(
      job({ docType: 'lab_label', templateKey: labLabelTemplate.key, format: 'zpl' }),
      {
        payload: {
          accessionNo: 'L4471',
          patientName: 'Synthetic Test',
          uhid: 'UH-9001',
          ageSex: '45/M',
          testName: 'CBC',
          containerLabel: 'EDTA 1 of 3',
          collectedAtLabel: '20-08-2026 09:20',
          copies: 3,
        },
        context: sampleContext(),
      },
      new FakePdfRenderer(),
    );

    expect(artifact.format).toBe('zpl');
    expect(artifact.pages).toBe(3);
    expect(Buffer.from(artifact.bytes).toString('utf8')).toContain('^XA');
  });

  /** `EN-005 §3.3.2`: "permanent errors immediate fail" — retrying cannot help. */
  it('turns a payload the template rejects into a permanent failure', async () => {
    await expect(
      renderPrintArtifact(
        job(),
        { payload: { tokenNumber: '' }, context: sampleContext() },
        new FakePdfRenderer(),
      ),
    ).rejects.toBeInstanceOf(PrintPermanentError);
  });

  it('fails permanently when the document type has no template at all', async () => {
    await expect(
      renderPrintArtifact(
        job({ docType: 'visitor_pass' }),
        { payload: {}, context: sampleContext() },
        new FakePdfRenderer(),
      ),
    ).rejects.toBeInstanceOf(PrintPermanentError);
  });
});

describe('driver compatibility', () => {
  const escposArtifact: PrintArtifact = {
    format: 'escpos',
    contentType: 'application/octet-stream',
    bytes: new Uint8Array([0x1b, 0x40]),
    pages: null,
  };

  it('accepts ESC/POS bytes on a raw_escpos printer', () => {
    expect(() => assertDriverAccepts(printer(), escposArtifact)).not.toThrow();
  });

  it('refuses ESC/POS bytes on a PDF printer instead of spraying control codes at a laser', () => {
    expect(() => assertDriverAccepts(printer({ driverMode: 'pdf', kind: 'laser' }), escposArtifact)).toThrow(
      PrintPermanentError,
    );
  });
});

describe('dispatchArtifact', () => {
  const artifact: PrintArtifact = (() => {
    const rendered = tokenSlipTemplate.render(TOKEN_PAYLOAD, sampleContext());
    if (rendered.format !== 'escpos') throw new Error('unreachable');
    return { format: 'escpos', contentType: rendered.contentType, bytes: rendered.bytes, pages: null };
  })();

  it('sends through the transport registered for that printer', async () => {
    const target = printer();
    const emulator = new EscPosEmulator();
    const other = new EscPosEmulator({ id: 'other' });
    const resolver = new MapTransportResolver(other).register(target.printerId, emulator);

    const result = await dispatchArtifact({ job: job(), printer: target, artifact, copies: 1 }, resolver);

    expect(result.state).toBe('printed');
    expect(emulator.slips).toHaveLength(1);
    expect(other.slips).toHaveLength(0);
  });

  /**
   * `EN-005 §3.3.3`: a workstation no agent covers must fall back to the
   * browser. Failing loudly here is what makes that fallback reachable instead
   * of the job disappearing into a queue nobody serves.
   */
  it('fails permanently when no transport can reach the printer', async () => {
    await expect(
      dispatchArtifact({ job: job(), printer: printer(), artifact, copies: 1 }, new MapTransportResolver()),
    ).rejects.toBeInstanceOf(PrintPermanentError);
  });
});

describe('StaticPayloadSource', () => {
  it('fails loudly for a job it has no payload for, rather than printing a blank', async () => {
    const source = new StaticPayloadSource();
    await expect(source.load(job())).rejects.toBeInstanceOf(PrintPermanentError);
  });

  it('returns the envelope registered for a job', async () => {
    const envelope = { payload: TOKEN_PAYLOAD, context: sampleContext() };
    const source = new StaticPayloadSource().set(job().id, envelope);
    await expect(source.load(job())).resolves.toBe(envelope);
  });
});

describe('MapTransportResolver', () => {
  it('falls back to the default transport for an unregistered printer', () => {
    const fallback = new EscPosEmulator({ id: 'fallback' });
    const resolver = new MapTransportResolver(fallback);
    expect(resolver.transportFor(printer())?.id).toBe('fallback');
  });

  it('has no transport at all when none is registered and there is no default', () => {
    expect(new MapTransportResolver().transportFor(printer())).toBeUndefined();
  });
});
