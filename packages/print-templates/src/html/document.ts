/**
 * The generic A4/A5 letterhead document: title, metadata grid, sections of prose
 * and/or tables, an optional signature block, and the print footer.
 *
 * Bills, prescriptions, discharge summaries and consent forms are all this shape
 * with different payloads, which is why it is a *layout primitive* rather than a
 * document-specific template.
 */

import { z } from 'zod';

import { defineTemplate, type PrintContext, type RegisteredTemplate, type RenderedHtml } from '../types.js';
import { bdi, escapeHtml, letterheadStyles, renderDuplicateMark, renderLetterhead, renderPrintFooter } from './letterhead.js';

const alignSchema = z.enum(['start', 'end']);

const columnSchema = z.object({
  label: z.string().min(1),
  align: alignSchema.optional(),
});

const tableSchema = z.object({
  columns: z.array(columnSchema).min(1),
  rows: z.array(z.array(z.string())),
  /** Rendered in `<tfoot>` — totals, tax splits, amount in words. */
  footRows: z.array(z.array(z.string())).optional(),
});

const sectionSchema = z.object({
  heading: z.string().optional(),
  paragraphs: z.array(z.string()).optional(),
  table: tableSchema.optional(),
});

export const a4DocumentPayloadSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  /** Label/value pairs: patient banner fields, bill number, dates, payer. */
  meta: z.array(z.object({ label: z.string().min(1), value: z.string() })).default([]),
  sections: z.array(sectionSchema).default([]),
  footerNote: z.string().optional(),
  signature: z
    .object({
      name: z.string().min(1),
      designation: z.string().optional(),
      registrationNo: z.string().optional(),
    })
    .optional(),
});

export type A4DocumentPayload = z.infer<typeof a4DocumentPayloadSchema>;

function renderMeta(meta: A4DocumentPayload['meta']): string {
  if (meta.length === 0) return '';
  const rows = meta
    .map(
      (entry) =>
        `<div class="meta-row"><span class="meta-label">${escapeHtml(entry.label)}</span><span class="meta-value">${bdi(entry.value)}</span></div>`,
    )
    .join('');
  return `<div class="meta">${rows}</div>`;
}

function renderTable(table: NonNullable<A4DocumentPayload['sections'][number]['table']>): string {
  const head = table.columns
    .map((column) => `<th class="${column.align === 'end' ? 'num' : ''}">${escapeHtml(column.label)}</th>`)
    .join('');

  const cell = (value: string, index: number): string => {
    const align = table.columns[index]?.align;
    return `<td class="${align === 'end' ? 'num' : ''}">${bdi(value)}</td>`;
  };

  const body = table.rows.map((row) => `<tr>${row.map(cell).join('')}</tr>`).join('');
  const foot =
    table.footRows === undefined || table.footRows.length === 0
      ? ''
      : `<tfoot>${table.footRows.map((row) => `<tr>${row.map(cell).join('')}</tr>`).join('')}</tfoot>`;

  return `<table class="doc"><thead><tr>${head}</tr></thead><tbody>${body}</tbody>${foot}</table>`;
}

function renderSection(section: A4DocumentPayload['sections'][number]): string {
  const heading =
    section.heading === undefined ? '' : `<h2 class="section-heading">${escapeHtml(section.heading)}</h2>`;
  const paragraphs = (section.paragraphs ?? []).map((text) => `<p>${escapeHtml(text)}</p>`).join('');
  const table = section.table === undefined ? '' : renderTable(section.table);
  return `<section class="section">${heading}${paragraphs}${table}</section>`;
}

function renderSignature(signature: A4DocumentPayload['signature']): string {
  if (signature === undefined) return '';
  const meta = [signature.designation, signature.registrationNo]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .map(escapeHtml)
    .join(' &middot; ');
  return [
    '<div class="signature">',
    `<div class="signature-name">${escapeHtml(signature.name)}</div>`,
    meta.length > 0 ? `<div class="signature-meta">${meta}</div>` : '',
    '</div>',
  ].join('');
}

/**
 * Produce the page markup. The worker wraps nothing around this: it hands the
 * string straight to Playwright's `page.setContent`, so the `<html>` element and
 * its `lang`/`dir` are part of the template's responsibility.
 */
export function renderA4Document(
  payload: A4DocumentPayload,
  context: PrintContext,
  paper: 'A4' | 'A5' = 'A4',
): RenderedHtml {
  const subtitle =
    payload.subtitle === undefined ? '' : `<div class="doc-subtitle">${escapeHtml(payload.subtitle)}</div>`;
  const footerNote =
    payload.footerNote === undefined ? '' : `<p class="footer-note">${escapeHtml(payload.footerNote)}</p>`;

  const html = [
    `<!doctype html><html lang="${escapeHtml(context.locale)}" dir="${context.direction}"><head>`,
    '<meta charset="utf-8" />',
    `<title>${escapeHtml(payload.title)}</title>`,
    `<style>${letterheadStyles(paper)}</style>`,
    '</head><body>',
    renderLetterhead(context),
    renderDuplicateMark(context),
    `<h1 class="doc-title">${escapeHtml(payload.title)}</h1>`,
    subtitle,
    renderMeta(payload.meta),
    payload.sections.map(renderSection).join(''),
    renderSignature(payload.signature),
    footerNote,
    renderPrintFooter(context),
    '</body></html>',
  ].join('');

  return { format: paper === 'A4' ? 'a4' : 'a5', contentType: 'text/html', paper, html };
}

export const a4DocumentTemplate: RegisteredTemplate = defineTemplate({
  key: 'bill_a4.html.v1',
  docType: 'bill_a4',
  format: 'a4',
  paper: 'A4',
  version: 1,
  description:
    'Generic A4 letterhead document — bills, GST invoices, prescriptions, discharge summaries and consent forms share this layout (EN-005 §4.1, EN-039 §5).',
  phi: true,
  payloadSchema: a4DocumentPayloadSchema,
  render: (payload, context) => renderA4Document(payload, context, 'A4'),
});
