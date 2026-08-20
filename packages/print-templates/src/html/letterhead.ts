/**
 * The hospital-letterhead layout primitive.
 *
 * Every A4/A5 document in Vim's HMS is this letterhead plus a body: bills, GST
 * invoices, prescriptions, lab reports, discharge summaries and consent forms.
 * Keeping it in one place is what makes "change the letterhead" a one-line
 * change instead of a sweep through twenty templates.
 *
 * Rules it encodes:
 *  - `docs/06 §8` RTL readiness: **logical** CSS properties only
 *    (`margin-inline-start`, `padding-block`), never `left`/`right`, and `dir`
 *    comes from the context.
 *  - `EN-005 §5`: a reprint carries a visible DUPLICATE mark and its reason.
 *  - Self-contained output: the logo is a data URI and there are no external
 *    stylesheets or fonts, because the renderer runs air-gapped on-prem.
 */

import type { PrintContext } from '../types.js';

const ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/** Escape text for an HTML text node or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/**
 * Latin drug names, UHIDs and amounts must stay LTR inside an RTL paragraph
 * (`docs/06 §8`), which is exactly what `<bdi>` is for.
 */
export function bdi(value: string): string {
  return `<bdi>${escapeHtml(value)}</bdi>`;
}

function logoBlock(context: PrintContext): string {
  const logo = context.hospital.logoDataUri;
  if (logo === undefined || logo.length === 0) return '';
  return `<img class="lh-logo" src="${escapeHtml(logo)}" alt="${escapeHtml(context.hospital.name)}" />`;
}

function contactLine(context: PrintContext): string {
  const parts = [
    context.branch.phone ?? context.hospital.phone,
    context.hospital.email,
    context.hospital.website,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .map(escapeHtml);
  return parts.length === 0 ? '' : `<div class="lh-contact">${parts.join(' &middot; ')}</div>`;
}

function taxLine(context: PrintContext): string {
  const parts: string[] = [];
  if (context.hospital.gstin !== undefined) parts.push(`GSTIN: ${escapeHtml(context.hospital.gstin)}`);
  if (context.hospital.accreditationLine !== undefined) {
    parts.push(escapeHtml(context.hospital.accreditationLine));
  }
  return parts.length === 0 ? '' : `<div class="lh-tax">${parts.join(' &middot; ')}</div>`;
}

/**
 * The `<header>` block. Rendered once per document; the PDF renderer repeats it
 * on continuation pages via `@page` running headers where the printer supports it.
 */
export function renderLetterhead(context: PrintContext): string {
  const address = [...context.branch.addressLines, ...context.hospital.addressLines]
    .filter((line) => line.length > 0)
    .map(escapeHtml)
    .join('<br />');

  const legalName =
    context.hospital.legalName !== undefined && context.hospital.legalName !== context.hospital.name
      ? `<div class="lh-legal">${escapeHtml(context.hospital.legalName)}</div>`
      : '';

  return [
    '<header class="lh">',
    `<div class="lh-brand">${logoBlock(context)}<div class="lh-names">`,
    `<h1 class="lh-name">${escapeHtml(context.hospital.name)}</h1>`,
    legalName,
    `<div class="lh-branch">${escapeHtml(context.branch.name)}</div>`,
    `<div class="lh-address">${address}</div>`,
    contactLine(context),
    taxLine(context),
    '</div></div>',
    '</header>',
  ].join('');
}

/** The DUPLICATE watermark and its mandatory reason (`EN-005 §5`). */
export function renderDuplicateMark(context: PrintContext): string {
  if (!context.duplicate) return '';
  const reason =
    context.duplicateReason !== undefined && context.duplicateReason.length > 0
      ? `<div class="dup-reason">Reason: ${escapeHtml(context.duplicateReason)}</div>`
      : '';
  return `<div class="dup-watermark" aria-hidden="true">DUPLICATE</div><div class="dup-banner">DUPLICATE COPY${reason}</div>`;
}

/** Printed-by / printed-at / document reference strip that closes every page. */
export function renderPrintFooter(context: PrintContext): string {
  const ref =
    context.documentRef === null ? '' : `<span class="pf-ref">Ref: ${bdi(context.documentRef)}</span>`;
  return [
    '<footer class="pf">',
    ref,
    `<span class="pf-by">Printed by ${escapeHtml(context.printedBy)}</span>`,
    `<span class="pf-at">${escapeHtml(context.printedAtLabel)}</span>`,
    '<span class="pf-page"></span>',
    '</footer>',
  ].join('');
}

/**
 * Base stylesheet. Inline, because a hospital PC rendering this offline has no
 * CDN, and Playwright must produce the same pixels in CI as on the ward.
 */
export function letterheadStyles(paper: 'A4' | 'A5'): string {
  return `
@page { size: ${paper}; margin: 12mm 12mm 16mm; }
* { box-sizing: border-box; }
body { font-family: "Noto Sans", "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; line-height: 1.45; color: #111; margin: 0; }
.lh { display: flex; align-items: flex-start; border-block-end: 1.5pt solid #111; padding-block-end: 6pt; margin-block-end: 10pt; }
.lh-brand { display: flex; gap: 10pt; align-items: center; }
.lh-logo { block-size: 46px; inline-size: auto; }
.lh-name { font-size: 16pt; margin: 0; letter-spacing: 0.2pt; }
.lh-legal, .lh-branch { font-size: 9.5pt; font-weight: 600; }
.lh-address, .lh-contact, .lh-tax { font-size: 8.5pt; color: #333; }
.doc-title { font-size: 12.5pt; font-weight: 700; text-align: center; margin-block: 6pt; text-transform: none; }
.doc-subtitle { font-size: 9.5pt; text-align: center; color: #333; margin-block-end: 8pt; }
.meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 2pt 12pt; margin-block-end: 8pt; }
.meta-row { display: flex; gap: 6pt; }
.meta-label { color: #444; min-inline-size: 90pt; }
.meta-value { font-weight: 600; }
.section { margin-block-end: 10pt; break-inside: avoid; }
.section-heading { font-size: 10.5pt; font-weight: 700; border-block-end: 0.5pt solid #999; margin-block-end: 4pt; padding-block-end: 2pt; }
.section p { margin: 0 0 4pt; }
table.doc { inline-size: 100%; border-collapse: collapse; font-size: 9.5pt; }
table.doc th, table.doc td { border: 0.5pt solid #999; padding: 3pt 5pt; vertical-align: top; }
table.doc th { background: #f0f0f0; text-align: start; }
td.num, th.num { text-align: end; font-variant-numeric: tabular-nums; }
tfoot td { font-weight: 700; }
.signature { margin-block-start: 24pt; text-align: end; }
.signature-name { font-weight: 700; }
.signature-meta { font-size: 8.5pt; color: #333; }
.pf { position: fixed; inset-block-end: 0; inset-inline: 0; display: flex; gap: 10pt; justify-content: space-between; font-size: 7.5pt; color: #444; border-block-start: 0.5pt solid #bbb; padding-block-start: 3pt; }
.dup-watermark { position: fixed; inset-block-start: 40%; inset-inline-start: 15%; font-size: 62pt; font-weight: 800; color: rgba(0,0,0,0.08); transform: rotate(-24deg); pointer-events: none; }
.dup-banner { border: 1pt solid #111; padding: 3pt 6pt; font-weight: 700; font-size: 9pt; margin-block-end: 6pt; text-align: center; }
.dup-reason { font-weight: 400; font-size: 8pt; }
`.trim();
}
