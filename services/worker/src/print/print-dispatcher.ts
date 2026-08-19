import {
  PrintTemplateError,
  defaultTemplateFor,
  requireTemplate,
  type DocType,
  type PrintContext,
  type RenderedDocument,
} from '@vims/print-templates';

import type { PdfRendererPort } from './pdf-renderer.js';
import type { PrintJobRecord } from './print-job-repository.js';
import {
  PrintPermanentError,
  type PrintArtifact,
  type PrinterDriverMode,
  type PrinterTarget,
  type PrinterTransport,
  type PrintWireFormat,
  type TransportResult,
} from './types.js';

/**
 * The dispatcher: template + payload → bytes → a device.
 *
 * `@vims/print-templates` deliberately stops at the string boundary — it returns
 * markup, ESC/POS bytes and ZPL text, and knows nothing about browsers, queues
 * or printers. This module is the other side of that boundary, and it is where
 * the two failure modes that matter are separated:
 *
 *  - **Permanent** (a payload the template rejects, a template key that does not
 *    exist, a printer whose driver cannot speak the format): retrying prints
 *    nothing but burns the queue. `EN-005 §3.3.2`: "permanent errors immediate
 *    fail".
 *  - **Transient** (the device): handled by the transport, which raises
 *    `PrinterUnavailableError` and leaves the job queued.
 */

/** Everything the template needs, fetched for a job. */
export interface PrintPayloadEnvelope {
  readonly payload: unknown;
  readonly context: PrintContext;
}

/**
 * Where a job's render payload comes from.
 *
 * `core.print_jobs` stores `file_id` / `render_job_id` / `source_ref`, never the
 * document itself — `EN-005 §5`: "job payload never contains raw PHI beyond what
 * the document shows". So the payload is fetched, and by *whom* is a Phase-1
 * decision (the EN-039 render-job cache, or the owning module's service). Making
 * it a port keeps that decision out of the dispatcher and lets every test here
 * run without a file store.
 */
export interface PrintPayloadSource {
  load(job: PrintJobRecord): Promise<PrintPayloadEnvelope>;
}

/** Picks the transport for a printer: LAN agent, raw TCP socket, or emulator. */
export interface TransportResolver {
  transportFor(printer: PrinterTarget): PrinterTransport | undefined;
}

/** Driver mode → the artifact format that mode can actually consume. */
const DRIVER_FORMAT: Readonly<Record<PrinterDriverMode, PrintWireFormat>> = Object.freeze({
  raw_escpos: 'escpos',
  raw_zpl: 'zpl',
  raw_tspl: 'tspl',
  pdf: 'pdf',
});

function templateKeyFor(job: PrintJobRecord): string {
  if (job.templateKey !== null && job.templateKey.length > 0) return job.templateKey;
  const fallback = defaultTemplateFor(job.docType as DocType);
  if (fallback === undefined) {
    throw new PrintPermanentError(
      `Print job ${job.id} names no template and document type "${job.docType}" has no built-in default (EN-005 §4.1).`,
    );
  }
  return fallback.key;
}

async function toArtifact(rendered: RenderedDocument, pdf: PdfRendererPort): Promise<PrintArtifact> {
  switch (rendered.format) {
    case 'a4':
    case 'a5':
      return pdf.renderHtml({ html: rendered.html, paper: rendered.format === 'a4' ? 'A4' : 'A5' });
    case 'escpos':
      return {
        format: 'escpos',
        contentType: rendered.contentType,
        bytes: rendered.bytes,
        // Continuous roll: there are no sheets to bill, and reporting 1 "page"
        // per token would corrupt the cost report of EN-005 §3.6.
        pages: null,
      };
    case 'zpl':
      return {
        format: 'zpl',
        contentType: rendered.contentType,
        bytes: new Uint8Array(Buffer.from(rendered.zpl, 'utf8')),
        pages: rendered.copies,
      };
  }
}

/**
 * Render a job to bytes.
 *
 * A `PrintTemplateError` — the template's Zod schema rejecting the payload — is
 * translated to `PrintPermanentError` here rather than propagated: to the queue
 * it is indistinguishable from any other permanent failure, and leaving it as a
 * template error would tempt a caller into retrying a document that can never
 * render.
 */
export async function renderPrintArtifact(
  job: PrintJobRecord,
  envelope: PrintPayloadEnvelope,
  pdf: PdfRendererPort,
): Promise<PrintArtifact> {
  const key = templateKeyFor(job);
  try {
    const template = requireTemplate(key);
    const rendered = template.render(envelope.payload, envelope.context);
    return await toArtifact(rendered, pdf);
  } catch (error) {
    if (error instanceof PrintTemplateError) {
      throw new PrintPermanentError(`Template "${key}" cannot render print job ${job.id}: ${error.message}`);
    }
    throw error;
  }
}

/** Refuse to send ZPL to a thermal printer, or a PDF to a label printer. */
export function assertDriverAccepts(printer: PrinterTarget, artifact: PrintArtifact): void {
  const expected = DRIVER_FORMAT[printer.driverMode];
  if (expected !== artifact.format) {
    throw new PrintPermanentError(
      `Printer "${printer.name}" is driver mode ${printer.driverMode} (expects ${expected}) but the job rendered ${artifact.format}; fix the mapping in core.print_mappings (EN-005 §3.2).`,
    );
  }
}

export interface DispatchInput {
  readonly job: PrintJobRecord;
  readonly printer: PrinterTarget;
  readonly artifact: PrintArtifact;
  readonly copies: number;
}

/** Hand the bytes to the device. Transient device faults propagate unchanged. */
export async function dispatchArtifact(
  input: DispatchInput,
  transports: TransportResolver,
): Promise<TransportResult> {
  assertDriverAccepts(input.printer, input.artifact);

  const transport = transports.transportFor(input.printer);
  if (transport === undefined) {
    throw new PrintPermanentError(
      `No transport can reach printer "${input.printer.name}" (agent ${input.printer.agentId ?? 'none'}). A workstation with no agent must fall back to browser printing (EN-005 §3.3.3).`,
    );
  }

  return transport.send({
    jobId: input.job.id,
    printer: input.printer,
    artifact: input.artifact,
    copies: input.copies,
  });
}

/**
 * A resolver backed by a map from printer id to transport, with an optional
 * default. This is what an on-prem deployment builds from the agent registry at
 * start-up, and what a test builds from one emulator.
 */
export class MapTransportResolver implements TransportResolver {
  readonly #byPrinter = new Map<string, PrinterTransport>();
  readonly #fallback: PrinterTransport | undefined;

  constructor(fallback?: PrinterTransport) {
    this.#fallback = fallback;
  }

  register(printerId: string, transport: PrinterTransport): this {
    this.#byPrinter.set(printerId, transport);
    return this;
  }

  transportFor(printer: PrinterTarget): PrinterTransport | undefined {
    return this.#byPrinter.get(printer.printerId) ?? this.#fallback;
  }
}

/**
 * A payload source holding pre-supplied envelopes, keyed by job id.
 *
 * The Phase-0 stand-in for the EN-039 render-job cache: it lets the queue, the
 * registry and the emulator be tested end to end before a file store exists,
 * and it fails loudly for an unknown job rather than rendering an empty
 * document.
 */
export class StaticPayloadSource implements PrintPayloadSource {
  readonly #envelopes = new Map<string, PrintPayloadEnvelope>();

  set(jobId: string, envelope: PrintPayloadEnvelope): this {
    this.#envelopes.set(jobId, envelope);
    return this;
  }

  load(job: PrintJobRecord): Promise<PrintPayloadEnvelope> {
    const envelope = this.#envelopes.get(job.id);
    if (envelope === undefined) {
      return Promise.reject(new PrintPermanentError(`No render payload registered for print job ${job.id}.`));
    }
    return Promise.resolve(envelope);
  }
}
