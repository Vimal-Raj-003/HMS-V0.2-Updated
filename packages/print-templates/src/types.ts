/**
 * The print/PDF template contract.
 *
 * `EN-005 §3.5`: "Templates in `packages/print-templates`: ZPL (label printers
 * 203/300 dpi with GS1 barcodes), ESC/POS (58/80 mm), A4/A5 HTML (letterhead,
 * header/footer, page numbers). Variables from payload; preview in admin;
 * per-hospital overrides (EN-039); test print."
 *
 * Two boundaries this file deliberately draws:
 *
 *  - **No renderer here.** The Playwright HTML→PDF renderer lives in
 *    `services/worker` (`phase-00 §0.4`). This package produces the *markup* and
 *    the *control-code strings*, which is what makes every template unit-testable
 *    without a printer, a browser or a queue.
 *  - **No clock and no locale engine.** Everything the template prints is already
 *    a string in `PrintContext`/payload — the caller formats dates and money with
 *    `@vims/i18n` first. A template that formatted its own dates would render
 *    differently in CI than on a ward server, and a GST invoice cannot do that.
 */

import type { z } from 'zod';

/** How the bytes reach the printer (`print_printers.driver_mode` in EN-005 §4). */
export type PrintFormat = 'a4' | 'a5' | 'escpos' | 'zpl';

export type PaperSize =
  | 'A4'
  | 'A5'
  | 'thermal_58mm'
  | 'thermal_80mm'
  | 'label_50x25'
  | 'label_50x30'
  | 'wristband';

/** The document-type catalogue of `EN-005 §4.1`. Hospitals may add more. */
export type DocType =
  | 'token'
  | 'appointment_slip'
  | 'op_receipt'
  | 'advance_receipt'
  | 'bill_a4'
  | 'ip_final_bill'
  | 'gst_invoice'
  | 'lab_label'
  | 'lab_report'
  | 'rad_report'
  | 'wristband'
  | 'patient_card'
  | 'prescription'
  | 'discharge_summary'
  | 'consent_form'
  | 'med_label'
  | 'iv_label'
  | 'stores_label'
  | 'asset_tag'
  | 'cssd_label'
  | 'dispatch_note'
  | 'visitor_pass'
  | 'queue_ticket_kiosk';

export type TextDirection = 'ltr' | 'rtl';

export interface HospitalIdentity {
  readonly name: string;
  /** Registered entity name, where it differs from the brand (GST invoices). */
  readonly legalName?: string | undefined;
  readonly addressLines: readonly string[];
  readonly phone?: string | undefined;
  readonly email?: string | undefined;
  readonly website?: string | undefined;
  /** Printed on every tax document (`EN-005 §Regulatory`). */
  readonly gstin?: string | undefined;
  /** Data URI. Never a remote URL — the renderer must work air-gapped. */
  readonly logoDataUri?: string | undefined;
  readonly accreditationLine?: string | undefined;
}

export interface BranchIdentity {
  readonly name: string;
  readonly addressLines: readonly string[];
  readonly phone?: string | undefined;
}

/**
 * Everything a template needs that is not document payload. Pre-formatted on
 * purpose — see the note at the top of this file.
 */
export interface PrintContext {
  readonly hospital: HospitalIdentity;
  readonly branch: BranchIdentity;
  /** BCP-47 tag for `<html lang>`. From `@vims/i18n`. */
  readonly locale: string;
  readonly direction: TextDirection;
  /** Already formatted, e.g. `20-Aug-2026 09:14`. */
  readonly printedAtLabel: string;
  readonly printedBy: string;
  /** Bill number, accession number, IP number… `null` where the document has none. */
  readonly documentRef: string | null;
  /**
   * `EN-005 §5`: reprints of receipts, GST invoices and reports must carry a
   * "DUPLICATE" mark and a reason.
   */
  readonly duplicate: boolean;
  readonly duplicateReason?: string | undefined;
}

export interface RenderedHtml {
  readonly format: 'a4' | 'a5';
  readonly contentType: 'text/html';
  readonly paper: PaperSize;
  readonly html: string;
}

export interface RenderedEscPos {
  readonly format: 'escpos';
  readonly contentType: 'application/octet-stream';
  readonly paper: PaperSize;
  readonly bytes: Uint8Array;
}

export interface RenderedZpl {
  readonly format: 'zpl';
  readonly contentType: 'application/vnd.zpl';
  readonly paper: PaperSize;
  readonly zpl: string;
  /** `^PQ` quantity — labels are frequently printed n-up per container. */
  readonly copies: number;
}

export type RenderedDocument = RenderedHtml | RenderedEscPos | RenderedZpl;

export class PrintTemplateError extends Error {
  override readonly name = 'PrintTemplateError';
}

/** What a template author writes. */
export interface TemplateDefinition<TPayload> {
  /** Stable identifier, `<docType>.<format>.v<version>`; referenced by `print_mappings`. */
  readonly key: string;
  readonly docType: DocType;
  readonly format: PrintFormat;
  readonly paper: PaperSize;
  readonly version: number;
  readonly description: string;
  /** True when the rendered document contains PHI — drives the EN-024 print audit. */
  readonly phi: boolean;
  readonly payloadSchema: z.ZodType<TPayload>;
  render(payload: TPayload, context: PrintContext): RenderedDocument;
}

export interface PayloadIssue {
  readonly path: string;
  readonly message: string;
}

export type PayloadValidation = { readonly ok: true } | { readonly ok: false; readonly issues: readonly PayloadIssue[] };

/** What the registry stores: the same template with its payload type erased. */
export interface RegisteredTemplate {
  readonly key: string;
  readonly docType: DocType;
  readonly format: PrintFormat;
  readonly paper: PaperSize;
  readonly version: number;
  readonly description: string;
  readonly phi: boolean;
  /** Check a payload without rendering — admin preview and contract tests. */
  validate(payload: unknown): PayloadValidation;
  /** Validate then render. Throws `PrintTemplateError` on a bad payload. */
  render(payload: unknown, context: PrintContext): RenderedDocument;
}

/** Erase the payload type so templates of different shapes share one registry. */
export function defineTemplate<TPayload>(definition: TemplateDefinition<TPayload>): RegisteredTemplate {
  return {
    key: definition.key,
    docType: definition.docType,
    format: definition.format,
    paper: definition.paper,
    version: definition.version,
    description: definition.description,
    phi: definition.phi,
    validate(payload: unknown): PayloadValidation {
      const result = definition.payloadSchema.safeParse(payload);
      if (result.success) return { ok: true };
      return {
        ok: false,
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
    },
    render(payload: unknown, context: PrintContext): RenderedDocument {
      const result = definition.payloadSchema.safeParse(payload);
      if (!result.success) {
        const detail = result.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ');
        throw new PrintTemplateError(`Payload rejected by template "${definition.key}" — ${detail}`);
      }
      return definition.render(result.data, context);
    },
  };
}
