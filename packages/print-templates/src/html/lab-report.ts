/**
 * The laboratory report — `OP-004 §3.6.1`, A4, one per order or per discipline.
 *
 * The mandatory content is not a design choice: NABL 112 (ISO 15189:2022)
 * §7.4.1.3 fixes it, and `OP-004 §3.6.1` restates it as the field list this
 * payload mirrors — two patient identifiers, specimen type, collection, receipt
 * and report times, result with unit and biological reference interval, flags,
 * method, the authorised signatory with registration number, accreditation
 * marking, page *n* of *N*, and a verification QR.
 *
 * ── The three things that make this document safe ───────────────────────────
 *
 * **A critical value is impossible to miss.** It appears three times: in a
 * boxed call-out above the results, as an inverted chip in the flag column, and
 * as a heavy rule down the inside edge of its row. The call-out also prints the
 * call-back — who was told, when, and whether the read-back was confirmed —
 * because `OP-004 §3.5` makes the communication, not the number, the deliverable.
 *
 * **An unauthorised print cannot pass for a report.** The seal, the banner and
 * the missing signature block all come from `status.release`, and
 * `assertReleaseConsistency()` refuses the combinations that would let them
 * disagree.
 *
 * **Accreditation is marked, not assumed.** `OP-004 §5`: the NABL logo prints
 * only when every test on the report is in accredited scope, and out-of-scope
 * results carry a footnote. Both come from the payload, which the API freezes
 * onto the report version at issue time so a reprint matches the original even
 * after the scope changes.
 */

import { z } from 'zod';

import { defineTemplate, type PrintContext, type RegisteredTemplate, type RenderedHtml } from '../types.js';
import { bdi, escapeHtml } from './letterhead.js';
import {
  HEIGHT,
  authBlockMm,
  authoriserSchema,
  assertReleaseConsistency,
  closeDocument,
  firstPageBudgetMm,
  forbiddenInQr,
  linesFor,
  metaMm,
  openDocument,
  paginate,
  patientBannerMm,
  patientBannerSchema,
  proseMm,
  statusBannerMm,
  amendmentBlocks,
  renderAuthorisers,
  renderEndOfReport,
  renderMetaGrid,
  renderPatientBanner,
  renderReportPages,
  renderStatusBanner,
  renderVerifyBlock,
  reportStatusSchema,
  verifySchema,
  type PageBlock,
} from './report-shell.js';

// ── Flags ───────────────────────────────────────────────────────────────────

/** Exactly the vocabulary of `services/api/.../lab/result-flags.ts`. */
export const resultFlagSchema = z.enum([
  'normal',
  'low',
  'high',
  'critical_low',
  'critical_high',
  'abnormal',
  'positive',
  'negative',
  'reactive',
  'non_reactive',
  'indeterminate',
]);

export type ResultFlagKey = z.infer<typeof resultFlagSchema>;

const FLAG_TEXT: Readonly<Record<ResultFlagKey, string>> = Object.freeze({
  normal: '',
  low: 'L',
  high: 'H',
  critical_low: '▼ CRITICAL LOW',
  critical_high: '▲ CRITICAL HIGH',
  abnormal: 'ABNORMAL',
  positive: 'POSITIVE',
  negative: '',
  reactive: 'REACTIVE',
  non_reactive: '',
  indeterminate: 'INDETERMINATE',
});

export function isCriticalFlag(flag: ResultFlagKey): boolean {
  return flag === 'critical_low' || flag === 'critical_high';
}

function isAbnormalFlag(flag: ResultFlagKey): boolean {
  return FLAG_TEXT[flag].length > 0 && !isCriticalFlag(flag);
}

function renderFlagCell(flag: ResultFlagKey): string {
  const text = FLAG_TEXT[flag];
  if (text.length === 0) return '<td></td>';
  const className = isCriticalFlag(flag) ? 'flag flag-critical' : 'flag flag-abnormal';
  return `<td><span class="${className}">${escapeHtml(text)}</span></td>`;
}

// ── Payload ─────────────────────────────────────────────────────────────────

export const labResultRowSchema = z.object({
  analyte: z.string().min(1),
  loincCode: z.string().optional(),
  /** Pre-formatted: `6.9`, `< 0.01`, `Growth of E. coli`. Never a number. */
  value: z.string().min(1),
  unit: z.string().optional(),
  /** `3.5 – 5.1`, `Non-reactive`, `< 200`. The interval in force when resulted. */
  referenceInterval: z.string().optional(),
  flag: resultFlagSchema.default('normal'),
  method: z.string().optional(),
  analyser: z.string().optional(),
  comment: z.string().optional(),
  /** `OP-004 §3.3.3` delta check — printed so the clinician sees the movement. */
  previousValue: z.string().optional(),
  previousAtLabel: z.string().optional(),
  deltaFlagged: z.boolean().default(false),
  /** This analyte changed in this amendment. */
  amended: z.boolean().default(false),
  /** Out of the laboratory's accredited scope — drives the footnote. */
  outsideNablScope: z.boolean().default(false),
  outsourcedTo: z.string().optional(),
});

export type LabResultRow = z.infer<typeof labResultRowSchema>;

export const labResultGroupSchema = z.object({
  /** Sub-department or panel: "Biochemistry", "Complete Blood Count". */
  heading: z.string().min(1),
  specimen: z.string().optional(),
  method: z.string().optional(),
  analyser: z.string().optional(),
  rows: z.array(labResultRowSchema).min(1),
  /** Free-text interpretive paragraphs — micro/histopath narratives live here. */
  notes: z.array(z.string().min(1)).default([]),
  interpretation: z.string().optional(),
});

export const labSpecimenSchema = z.object({
  sampleNo: z.string().min(1),
  specimenType: z.string().min(1),
  container: z.string().optional(),
  collectedAtLabel: z.string().min(1),
  receivedAtLabel: z.string().optional(),
  conditionOnReceipt: z.string().optional(),
});

export const labCriticalValueSchema = z.object({
  analyte: z.string().min(1),
  value: z.string().min(1),
  unit: z.string().optional(),
  flag: resultFlagSchema,
  detectedAtLabel: z.string().min(1),
  notifiedToName: z.string().optional(),
  notifiedToRole: z.string().optional(),
  notifiedAtLabel: z.string().optional(),
  notifiedByName: z.string().optional(),
  method: z.string().optional(),
  readBackConfirmed: z.boolean().default(false),
  clinicianUnreachable: z.boolean().default(false),
  escalatedTo: z.string().optional(),
});

const labLabelsSchema = z
  .object({
    investigation: z.string().min(1),
    result: z.string().min(1),
    flag: z.string().min(1),
    unit: z.string().min(1),
    referenceInterval: z.string().min(1),
    method: z.string().min(1),
    criticalHeading: z.string().min(1),
    specimensHeading: z.string().min(1),
    notesHeading: z.string().min(1),
  })
  .partial()
  .default({});

/**
 * Column and section headings, overridable per hospital and per locale.
 *
 * `OP-004 §13` keeps the report language English with bilingual headers as an
 * option, and `CLAUDE.md §4` requires every string to be translatable. The
 * package still holds no locale engine (see `types.ts`): the caller passes the
 * translated headings in, and these are the `en-IN` fallbacks.
 */
export interface LabReportLabels {
  readonly investigation: string;
  readonly result: string;
  readonly flag: string;
  readonly unit: string;
  readonly referenceInterval: string;
  readonly method: string;
  readonly criticalHeading: string;
  readonly specimensHeading: string;
  readonly notesHeading: string;
}

const DEFAULT_LABELS: LabReportLabels = Object.freeze({
  investigation: 'Investigation',
  result: 'Result',
  flag: 'Flag',
  unit: 'Unit',
  referenceInterval: 'Biological reference interval',
  method: 'Method / Instrument',
  criticalHeading: 'Critical values in this report',
  specimensHeading: 'Specimens',
  notesHeading: 'Interpretive notes',
});

function mergeLabels(overrides: z.infer<typeof labLabelsSchema>): LabReportLabels {
  return {
    investigation: overrides.investigation ?? DEFAULT_LABELS.investigation,
    result: overrides.result ?? DEFAULT_LABELS.result,
    flag: overrides.flag ?? DEFAULT_LABELS.flag,
    unit: overrides.unit ?? DEFAULT_LABELS.unit,
    referenceInterval: overrides.referenceInterval ?? DEFAULT_LABELS.referenceInterval,
    method: overrides.method ?? DEFAULT_LABELS.method,
    criticalHeading: overrides.criticalHeading ?? DEFAULT_LABELS.criticalHeading,
    specimensHeading: overrides.specimensHeading ?? DEFAULT_LABELS.specimensHeading,
    notesHeading: overrides.notesHeading ?? DEFAULT_LABELS.notesHeading,
  };
}

export const labReportPayloadSchema = z
  .object({
    title: z.string().min(1).default('Laboratory Report'),
    subtitle: z.string().optional(),
    reportNo: z.string().min(1),
    accessionNo: z.string().min(1),
    status: reportStatusSchema,
    patient: patientBannerSchema,
    order: z.object({
      orderedAtLabel: z.string().min(1),
      orderedBy: z.string().optional(),
      priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
      clinicalNotes: z.string().optional(),
      source: z.string().optional(),
    }),
    specimens: z.array(labSpecimenSchema).default([]),
    reportedAtLabel: z.string().min(1),
    criticalValues: z.array(labCriticalValueSchema).default([]),
    groups: z.array(labResultGroupSchema).min(1),
    notes: z.array(z.string().min(1)).default([]),
    authorisers: z.array(authoriserSchema).default([]),
    accreditation: z
      .object({
        nablLogoPrinted: z.boolean().default(false),
        scopeNote: z.string().optional(),
        outOfScopeNote: z.string().optional(),
      })
      .default({ nablLogoPrinted: false }),
    verify: verifySchema,
    footerNote: z.string().optional(),
    labels: labLabelsSchema,
  })
  .superRefine((payload, ctx) => {
    assertReleaseConsistency(payload.status, payload.authorisers, ctx);

    const criticalRows = payload.groups.flatMap((group) =>
      group.rows.filter((row) => isCriticalFlag(row.flag)).map((row) => row.analyte),
    );
    const declared = new Set(payload.criticalValues.map((entry) => entry.analyte));
    for (const analyte of criticalRows) {
      if (!declared.has(analyte)) {
        ctx.addIssue({
          code: 'custom',
          path: ['criticalValues'],
          message: `"${analyte}" is flagged critical in the results but is missing from criticalValues, so the report would print the number without the call-back. OP-004 §3.5 makes the documented communication part of the result.`,
        });
      }
    }

    if (payload.status.release === 'amended') {
      const amendedRows = payload.groups.flatMap((group) => group.rows.filter((row) => row.amended));
      if (amendedRows.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['groups'],
          message:
            'An amended report must mark the rows that changed. A version 2 that looks identical to version 1 is how a corrected result gets missed.',
        });
      }
    }

    if (payload.accreditation.nablLogoPrinted) {
      const outOfScope = payload.groups.flatMap((group) => group.rows.filter((row) => row.outsideNablScope));
      if (outOfScope.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['accreditation', 'nablLogoPrinted'],
          message:
            'The NABL accreditation mark may only be printed when every result on the report is within accredited scope (OP-004 §5). This report carries out-of-scope results.',
        });
      }
    }
  });

export type LabReportPayload = z.infer<typeof labReportPayloadSchema>;

// ── Body ────────────────────────────────────────────────────────────────────

const TABLE_COLGROUP =
  '<colgroup><col style="width:28%"/><col style="width:14%"/><col style="width:13%"/><col style="width:9%"/><col style="width:20%"/><col style="width:16%"/></colgroup>';

function tableHead(labels: LabReportLabels): string {
  return [
    '<thead><tr>',
    `<th>${escapeHtml(labels.investigation)}</th>`,
    `<th class="num">${escapeHtml(labels.result)}</th>`,
    `<th>${escapeHtml(labels.flag)}</th>`,
    `<th>${escapeHtml(labels.unit)}</th>`,
    `<th>${escapeHtml(labels.referenceInterval)}</th>`,
    `<th>${escapeHtml(labels.method)}</th>`,
    '</tr></thead>',
  ].join('');
}

function rowSubtext(row: LabResultRow): readonly string[] {
  const parts: string[] = [];
  if (row.previousValue !== undefined) {
    const when = row.previousAtLabel === undefined ? '' : ` on ${row.previousAtLabel}`;
    parts.push(`Previous: ${row.previousValue}${when}${row.deltaFlagged ? ' — delta check flagged' : ''}`);
  }
  if (row.comment !== undefined) parts.push(row.comment);
  if (row.outsourcedTo !== undefined) parts.push(`Performed at ${row.outsourcedTo}`);
  return parts;
}

function renderRowBlock(row: LabResultRow): PageBlock {
  const classes: string[] = [];
  if (isCriticalFlag(row.flag)) classes.push('row-critical');
  else if (isAbnormalFlag(row.flag)) classes.push('row-abnormal');
  if (row.amended) classes.push('row-amended');

  const analyte = [
    bdi(row.analyte),
    row.outsideNablScope ? '<sup>†</sup>' : '',
    row.amended ? '<span class="amended-tag">AMENDED</span>' : '',
    row.loincCode === undefined ? '' : `<div class="row-comment">LOINC ${bdi(row.loincCode)}</div>`,
  ].join('');

  const methodCell = [row.method, row.analyser]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .map(bdi)
    .join('<br />');

  const main = [
    `<tr class="${classes.join(' ')}">`,
    `<td>${analyte}</td>`,
    `<td class="num">${bdi(row.value)}</td>`,
    renderFlagCell(row.flag),
    `<td>${row.unit === undefined ? '' : bdi(row.unit)}</td>`,
    `<td>${row.referenceInterval === undefined ? '' : bdi(row.referenceInterval)}</td>`,
    `<td>${methodCell}</td>`,
    '</tr>',
  ].join('');

  const subtext = rowSubtext(row);
  const extra =
    subtext.length === 0
      ? ''
      : `<tr class="${classes.join(' ')} row-comment"><td colspan="6">${subtext.map(escapeHtml).join(' &middot; ')}</td></tr>`;

  const commentLines = subtext.length === 0 ? 0 : linesFor(subtext.join(' · '));
  const heightMm =
    HEIGHT.tableRow +
    (row.loincCode === undefined ? 0 : HEIGHT.tableRowSubline) +
    (isCriticalFlag(row.flag) ? HEIGHT.tableRowCritical : 0) +
    (commentLines === 0 ? 0 : HEIGHT.commentRowBase + commentLines * HEIGHT.commentRowLine);

  return { html: main + extra, heightMm };
}

function renderCriticalBlocks(payload: LabReportPayload, labels: LabReportLabels): readonly PageBlock[] {
  if (payload.criticalValues.length === 0) return [];
  const container = {
    id: 'criticals',
    open: `<div class="critical-callout"><h2>${escapeHtml(labels.criticalHeading)}</h2><ul>`,
    close: '</ul></div>',
  };

  return payload.criticalValues.map((entry) => {
    const value = `${entry.value}${entry.unit === undefined ? '' : ` ${entry.unit}`}`;
    const head = `<strong>${bdi(entry.analyte)} ${bdi(value)} — ${escapeHtml(FLAG_TEXT[entry.flag] || 'CRITICAL')}</strong>`;
    const detected = ` Detected ${escapeHtml(entry.detectedAtLabel)}.`;
    let communication: string;
    if (entry.clinicianUnreachable) {
      communication = ` <strong>Clinician unreachable — escalated to ${escapeHtml(entry.escalatedTo ?? 'the on-call tier')}${entry.notifiedAtLabel === undefined ? '' : ` at ${escapeHtml(entry.notifiedAtLabel)}`}.</strong>`;
    } else if (entry.notifiedToName === undefined || entry.notifiedAtLabel === undefined) {
      communication = ' <strong>Communication to the ordering clinician is still pending.</strong>';
    } else {
      const role = entry.notifiedToRole === undefined ? '' : ` (${escapeHtml(entry.notifiedToRole)})`;
      const by = entry.notifiedByName === undefined ? '' : ` by ${escapeHtml(entry.notifiedByName)}`;
      const how = entry.method === undefined ? '' : ` via ${escapeHtml(entry.method)}`;
      const readBack = entry.readBackConfirmed
        ? ' Read-back confirmed.'
        : ' <strong>Read-back not confirmed.</strong>';
      communication = ` Communicated to ${escapeHtml(entry.notifiedToName)}${role}${how}${by} at ${escapeHtml(entry.notifiedAtLabel)}.${readBack}`;
    }

    const plain = `${entry.analyte} ${value} ${FLAG_TEXT[entry.flag]}${detected}${communication}`;
    return {
      html: `<li>${head}${detected}${communication}</li>`,
      heightMm: linesFor(plain) * HEIGHT.line + HEIGHT.calloutParagraphGap,
      container,
    };
  });
}

function renderSpecimenBlocks(payload: LabReportPayload, labels: LabReportLabels): readonly PageBlock[] {
  if (payload.specimens.length === 0) return [];
  const container = {
    id: 'specimens',
    open: `<section class="section"><h2 class="section-heading">${escapeHtml(labels.specimensHeading)}</h2>`,
    close: '</section>',
  };
  return payload.specimens.map((specimen, index) => ({
    html: renderMetaGrid([
      ['Sample No.', specimen.sampleNo],
      ['Specimen', specimen.specimenType],
      ['Container', specimen.container],
      ['Collected', specimen.collectedAtLabel],
      ['Received', specimen.receivedAtLabel],
      ['Condition on receipt', specimen.conditionOnReceipt],
    ]),
    heightMm: metaMm(6, 2) + (index === 0 ? HEIGHT.sectionHeading : 0),
    container,
  }));
}

function renderGroupBlocks(
  group: z.infer<typeof labResultGroupSchema>,
  index: number,
  labels: LabReportLabels,
): readonly PageBlock[] {
  const context = [group.specimen, group.method, group.analyser]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .map(escapeHtml)
    .join(' &middot; ');

  const blocks: PageBlock[] = [
    {
      html: [
        '<h2 class="section-heading">',
        escapeHtml(group.heading),
        '</h2>',
        context.length === 0 ? '' : `<div class="row-comment">${context}</div>`,
      ].join(''),
      // The table head is reprinted whenever a table starts on a page, so the
      // heading that introduces it pays for it.
      heightMm: HEIGHT.sectionHeading + HEIGHT.tableHead + (context.length === 0 ? 0 : HEIGHT.line),
      keepWithNext: true,
    },
  ];

  const container = {
    id: `g${String(index)}`,
    open: `<table class="doc">${TABLE_COLGROUP}${tableHead(labels)}<tbody>`,
    close: '</tbody></table>',
  };
  for (const row of group.rows) {
    blocks.push({ ...renderRowBlock(row), container });
  }

  for (const note of group.notes) {
    blocks.push({ html: `<div class="prose"><p>${escapeHtml(note)}</p></div>`, heightMm: proseMm([note]) });
  }
  if (group.interpretation !== undefined) {
    blocks.push({
      html: `<div class="prose impression"><p>${escapeHtml(group.interpretation)}</p></div>`,
      heightMm: proseMm([group.interpretation]),
    });
  }

  return blocks;
}

function buildBlocks(payload: LabReportPayload): readonly PageBlock[] {
  const labels = mergeLabels(payload.labels);
  const blocks: PageBlock[] = [];

  const banner = renderStatusBanner(payload.status);
  if (banner.length > 0) blocks.push({ html: banner, heightMm: statusBannerMm(payload.status) });

  blocks.push({ html: renderPatientBanner(payload.patient), heightMm: patientBannerMm(payload.patient) });

  blocks.push({
    html: renderMetaGrid([
      ['Accession No.', payload.accessionNo],
      ['Report No.', `${payload.reportNo} · v${String(payload.status.version)}`],
      ['Ordered', payload.order.orderedAtLabel],
      ['Ordered by', payload.order.orderedBy],
      ['Priority', payload.order.priority.toUpperCase()],
      ['Source', payload.order.source],
      ['Reported', payload.reportedAtLabel],
      ['Clinical notes', payload.order.clinicalNotes],
    ]),
    heightMm: metaMm(8, 2),
  });

  blocks.push(...renderCriticalBlocks(payload, labels));

  if (payload.status.amendment !== undefined) {
    blocks.push(...amendmentBlocks(payload.status.amendment));
  }

  blocks.push(...renderSpecimenBlocks(payload, labels));

  payload.groups.forEach((group, index) => {
    blocks.push(...renderGroupBlocks(group, index, labels));
  });

  const anyOutOfScope = payload.groups.some((group) => group.rows.some((row) => row.outsideNablScope));
  const notes: string[] = [...payload.notes];
  if (payload.accreditation.scopeNote !== undefined) notes.push(payload.accreditation.scopeNote);
  if (anyOutOfScope) {
    notes.push(
      payload.accreditation.outOfScopeNote ??
        '† This investigation is not within the laboratory’s NABL accredited scope. The accreditation mark on this report does not extend to it.',
    );
  }
  if (notes.length > 0) {
    const container = {
      id: 'notes',
      open: `<section class="section"><h2 class="section-heading">${escapeHtml(labels.notesHeading)}</h2><div class="prose">`,
      close: '</div></section>',
    };
    notes.forEach((note, index) => {
      blocks.push({
        html: `<p>${escapeHtml(note)}</p>`,
        heightMm: proseMm([note]) + (index === 0 ? HEIGHT.sectionHeading : 0),
        container,
      });
    });
  }

  blocks.push({ html: renderEndOfReport(), heightMm: HEIGHT.endOfReport, keepWithNext: true });
  blocks.push({
    html: renderAuthorisers(payload.status, payload.authorisers),
    heightMm: authBlockMm(payload.authorisers),
    mayNotStartPage: true,
  });
  blocks.push({
    html: renderVerifyBlock(
      payload.verify,
      forbiddenInQr(payload.patient, [payload.accessionNo, payload.reportNo]),
    ),
    heightMm: HEIGHT.qrBlock,
  });
  if (payload.footerNote !== undefined) {
    blocks.push({
      html: `<div class="footer-note">${escapeHtml(payload.footerNote)}</div>`,
      heightMm: HEIGHT.footerNote,
    });
  }

  return blocks;
}

export function renderLabReport(payload: LabReportPayload, context: PrintContext): RenderedHtml {
  const accreditationNote = payload.accreditation.nablLogoPrinted
    ? (payload.accreditation.scopeNote ?? 'NABL accredited scope — ISO 15189:2022')
    : undefined;
  const pages = paginate(buildBlocks(payload), {
    firstPageBudgetMm: firstPageBudgetMm({
      subtitle: payload.subtitle !== undefined,
      accreditationNote: accreditationNote !== undefined,
    }),
  });

  const html = [
    openDocument(context, `${payload.title} ${payload.reportNo}`),
    renderReportPages(pages, context, {
      title: payload.title,
      subtitle: payload.subtitle,
      reportNo: payload.reportNo,
      accessionNo: payload.accessionNo,
      status: payload.status,
      patient: payload.patient,
      accreditationNote,
    }),
    closeDocument(),
  ].join('');

  return { format: 'a4', contentType: 'text/html', paper: 'A4', html };
}

export const labReportTemplate: RegisteredTemplate = defineTemplate({
  key: 'lab_report.html.v1',
  docType: 'lab_report',
  format: 'a4',
  paper: 'A4',
  version: 1,
  description:
    'A4 laboratory report — NABL 112 §7.4 content set, critical-value call-out, amendment history, accreditation marking and a QR verification block (OP-004 §3.6.1, EN-005 §4.1).',
  phi: true,
  payloadSchema: labReportPayloadSchema,
  render: renderLabReport,
});
