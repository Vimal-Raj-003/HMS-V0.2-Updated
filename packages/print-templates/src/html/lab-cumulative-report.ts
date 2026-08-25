/**
 * The cumulative (serial) laboratory report — `OP-004 §3.6.1` "cumulative report
 * (selected analytes across visits table/graph)" and acceptance criterion 12,
 * "cumulative report requested for HbA1c over 2 years → a table+graph PDF".
 *
 * This is the report a clinician actually asks for. A stack of seven single-
 * order reports answers "what was the creatinine on the 4th"; one cumulative
 * sheet answers "is the creatinine climbing", which is the question that changes
 * management. So the document is built around the *series*: one row per analyte,
 * one column per collection, and a sparkline with the reference band drawn
 * behind it.
 *
 * ── Design decisions worth knowing ──────────────────────────────────────────
 *
 * **Columns are chunked, not shrunk.** Twenty collections across 186 mm would
 * give each column 8 mm and make every value unreadable. Instead the table is
 * emitted in runs of at most eight collections, each run repeating the analyte
 * column and headed with the range it covers. A clinician reads left to right
 * through time, which survives being split; a 4-point font does not.
 *
 * **The graph is drawn, not charted.** An inline SVG polyline over a shaded
 * reference band, with critical points marked as filled squares. No chart
 * library, no fonts inside the SVG, no runtime — which keeps the document
 * self-contained (`EN-005 §3.5`) and the output byte-stable.
 *
 * **Nothing here re-decides anything clinical.** The flags come from the
 * payload, computed once by `lab/result-flags.ts` against the reference interval
 * that was in force *at the time of each result* (`OP-004 §5`: "reference ranges
 * effective-dated; report prints the range used at that time"). Recomputing a
 * two-year-old result against today's interval is how a cumulative report ends
 * up disagreeing with the report it was compiled from.
 */

import { z } from 'zod';

import { defineTemplate, type PrintContext, type RegisteredTemplate, type RenderedHtml } from '../types.js';
import { bdi, escapeHtml } from './letterhead.js';
import { isCriticalFlag, resultFlagSchema, type ResultFlagKey } from './lab-report.js';
import {
  HEIGHT,
  authBlockMm,
  authoriserSchema,
  assertReleaseConsistency,
  closeDocument,
  firstPageBudgetMm,
  forbiddenInQr,
  metaMm,
  openDocument,
  paginate,
  patientBannerMm,
  patientBannerSchema,
  proseMm,
  statusBannerMm,
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

// ── Payload ─────────────────────────────────────────────────────────────────

export const cumulativeColumnSchema = z.object({
  /** `12-Aug-2026 07:40` — pre-formatted, like every other date in this package. */
  dateLabel: z.string().min(1),
  accessionNo: z.string().optional(),
  note: z.string().optional(),
});

export const cumulativeCellSchema = z.object({
  /** Pre-formatted display value. `null` cells are printed as a dash. */
  value: z.string().min(1),
  flag: resultFlagSchema.default('normal'),
  /** The same value as a number, for the sparkline. Omit for non-numeric results. */
  numeric: z.number().optional(),
  /** The result was amended after first release — the cell is marked. */
  amended: z.boolean().default(false),
});

export const cumulativeAnalyteSchema = z.object({
  analyte: z.string().min(1),
  unit: z.string().optional(),
  loincCode: z.string().optional(),
  /** The interval printed alongside the row. */
  referenceInterval: z.string().optional(),
  /** Numeric bounds for the shaded band behind the sparkline. */
  referenceLow: z.number().optional(),
  referenceHigh: z.number().optional(),
  /** One entry per column, in the same order. `null` where no result exists. */
  cells: z.array(cumulativeCellSchema.nullable()),
});

export type CumulativeAnalyte = z.infer<typeof cumulativeAnalyteSchema>;

export const labCumulativeReportPayloadSchema = z
  .object({
    title: z.string().min(1).default('Cumulative Laboratory Report'),
    subtitle: z.string().optional(),
    reportNo: z.string().min(1),
    /** The compilation's own reference; individual collections carry their own. */
    accessionNo: z.string().min(1),
    status: reportStatusSchema,
    patient: patientBannerSchema,
    periodLabel: z.string().min(1),
    compiledAtLabel: z.string().min(1),
    columns: z.array(cumulativeColumnSchema).min(1),
    analytes: z.array(cumulativeAnalyteSchema).min(1),
    /** Draw the sparkline section. Off for a purely categorical compilation. */
    showTrend: z.boolean().default(true),
    notes: z.array(z.string().min(1)).default([]),
    authorisers: z.array(authoriserSchema).default([]),
    verify: verifySchema,
    footerNote: z.string().optional(),
  })
  .superRefine((payload, ctx) => {
    assertReleaseConsistency(payload.status, payload.authorisers, ctx);

    payload.analytes.forEach((analyte, index) => {
      if (analyte.cells.length !== payload.columns.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['analytes', index, 'cells'],
          message: `"${analyte.analyte}" has ${String(analyte.cells.length)} cells for ${String(payload.columns.length)} collections. A cumulative row whose cells do not line up with the dates would print each value under the wrong date, which is worse than printing nothing.`,
        });
      }
    });
  });

export type LabCumulativeReportPayload = z.infer<typeof labCumulativeReportPayloadSchema>;

// ── Layout constants ────────────────────────────────────────────────────────

const MAX_COLUMNS_PER_TABLE = 8;
/**
 * The serial table's header is two or three lines tall — a date over an
 * accession number — so it is reserved separately from the ordinary 13 mm one.
 * Measured at 30 mm for eight date columns.
 */
const CUMULATIVE_TABLE_HEAD_MM = 32;
/** Label line + a 16 mm sparkline + a two-line legend, measured at 26.9 mm. */
const TREND_MM = 30;

// ── Sparkline ───────────────────────────────────────────────────────────────

const CHART_WIDTH = 400;
const CHART_HEIGHT = 60;
const CHART_PAD = 4;

function round(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

interface TrendPoint {
  readonly index: number;
  readonly value: number;
  readonly critical: boolean;
}

function numericPoints(analyte: CumulativeAnalyte): readonly TrendPoint[] {
  const points: TrendPoint[] = [];
  analyte.cells.forEach((cell, index) => {
    if (cell === null || cell.numeric === undefined) return;
    points.push({ index, value: cell.numeric, critical: isCriticalFlag(cell.flag) });
  });
  return points;
}

/**
 * A sparkline for one analyte. Pure arithmetic on the payload's numbers, with
 * every coordinate rounded to two decimals so the markup is byte-stable across
 * platforms rather than depending on the printer of a float.
 */
export function renderSparkline(analyte: CumulativeAnalyte, columnCount: number): string {
  const points = numericPoints(analyte);
  if (points.length < 2) return '';

  const values = points.map((point) => point.value);
  const candidates = [...values];
  if (analyte.referenceLow !== undefined) candidates.push(analyte.referenceLow);
  if (analyte.referenceHigh !== undefined) candidates.push(analyte.referenceHigh);
  const rawMin = Math.min(...candidates);
  const rawMax = Math.max(...candidates);
  const span = rawMax - rawMin === 0 ? Math.abs(rawMax) || 1 : rawMax - rawMin;
  const min = rawMin - span * 0.1;
  const max = rawMax + span * 0.1;

  const x = (index: number): number =>
    columnCount <= 1
      ? CHART_WIDTH / 2
      : CHART_PAD + (index / (columnCount - 1)) * (CHART_WIDTH - CHART_PAD * 2);
  const y = (value: number): number =>
    CHART_HEIGHT - CHART_PAD - ((value - min) / (max - min)) * (CHART_HEIGHT - CHART_PAD * 2);

  const band =
    analyte.referenceLow === undefined || analyte.referenceHigh === undefined
      ? ''
      : `<rect x="0" y="${round(y(analyte.referenceHigh))}" width="${String(CHART_WIDTH)}" height="${round(Math.max(0.5, y(analyte.referenceLow) - y(analyte.referenceHigh)))}" fill="#d9d9d9"/>`;

  const path = points.map((point) => `${round(x(point.index))},${round(y(point.value))}`).join(' ');
  const marks = points
    .map((point) =>
      point.critical
        ? `<rect x="${round(x(point.index) - 3)}" y="${round(y(point.value) - 3)}" width="6" height="6" fill="#000"/>`
        : `<circle cx="${round(x(point.index))}" cy="${round(y(point.value))}" r="2.2" fill="#000"/>`,
    )
    .join('');

  return [
    `<svg class="trend" viewBox="0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}" preserveAspectRatio="none" role="img"`,
    ` aria-label="${escapeHtml(`Trend of ${analyte.analyte} across ${String(points.length)} collections`)}">`,
    band,
    `<polyline fill="none" stroke="#000" stroke-width="1.4" points="${path}"/>`,
    marks,
    '</svg>',
  ].join('');
}

const TREND_GLYPH: Readonly<Record<'up' | 'down' | 'flat', string>> = Object.freeze({
  up: '▲',
  down: '▼',
  flat: '—',
});

/** Direction of travel between the first and last numeric point. RTL-safe glyphs. */
export function trendDirection(analyte: CumulativeAnalyte): 'up' | 'down' | 'flat' | null {
  const points = numericPoints(analyte);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || points.length < 2) return null;
  if (last.value > first.value) return 'up';
  if (last.value < first.value) return 'down';
  return 'flat';
}

// ── Table ───────────────────────────────────────────────────────────────────

function cellHtml(cell: z.infer<typeof cumulativeCellSchema> | null): string {
  if (cell === null) return '<td class="num">&mdash;</td>';
  const classes = ['num'];
  if (isCriticalFlag(cell.flag)) classes.push('cell-critical');
  const marks = [
    cell.amended ? '<sup>a</sup>' : '',
    isCriticalFlag(cell.flag) ? '<span class="flag flag-critical">!</span>' : flagSuffix(cell.flag),
  ].join('');
  return `<td class="${classes.join(' ')}">${bdi(cell.value)}${marks}</td>`;
}

/**
 * Every flag is listed and there is no `default`, deliberately.
 *
 * A `default: return ''` makes adding a flag to the enum a silent change here:
 * the new one renders with no marker at all, on a clinical report, and nothing
 * fails. Exhaustiveness turns that into a compile error instead — which is what
 * `@typescript-eslint/switch-exhaustiveness-check` is for, and why the rule is
 * worth satisfying rather than suppressing.
 *
 * `critical_low` and `critical_high` never reach here — `cellHtml` renders them
 * through `isCriticalFlag` first — but they are answered anyway, because relying
 * on a caller's ordering to keep a branch unreachable is how it becomes reachable.
 */
function flagSuffix(flag: ResultFlagKey): string {
  switch (flag) {
    case 'low':
      return '<sup>L</sup>';
    case 'high':
      return '<sup>H</sup>';
    case 'critical_low':
      return '<sup>LL</sup>';
    case 'critical_high':
      return '<sup>HH</sup>';
    case 'abnormal':
    case 'positive':
    case 'reactive':
    case 'indeterminate':
      return '<sup>*</sup>';
    case 'normal':
    case 'negative':
    case 'non_reactive':
      return '';
  }
}

interface ColumnRun {
  readonly from: number;
  readonly to: number;
}

function columnRuns(total: number): readonly ColumnRun[] {
  const runs: ColumnRun[] = [];
  for (let from = 0; from < total; from += MAX_COLUMNS_PER_TABLE) {
    runs.push({ from, to: Math.min(total, from + MAX_COLUMNS_PER_TABLE) });
  }
  return runs;
}

function runColgroup(width: number): string {
  const dateWidth = ((100 - 34) / width).toFixed(3);
  const cols = Array.from({ length: width }, () => `<col style="width:${dateWidth}%"/>`).join('');
  return `<colgroup><col style="width:22%"/><col style="width:12%"/>${cols}</colgroup>`;
}

function runHead(payload: LabCumulativeReportPayload, run: ColumnRun): string {
  const headers = payload.columns
    .slice(run.from, run.to)
    .map((column) => {
      const accession =
        column.accessionNo === undefined ? '' : `<div class="row-comment">${bdi(column.accessionNo)}</div>`;
      return `<th class="num">${escapeHtml(column.dateLabel)}${accession}</th>`;
    })
    .join('');
  return `<thead><tr><th>Analyte</th><th>Reference</th>${headers}</tr></thead>`;
}

function buildBlocks(payload: LabCumulativeReportPayload): readonly PageBlock[] {
  const blocks: PageBlock[] = [];

  const banner = renderStatusBanner(payload.status);
  if (banner.length > 0) blocks.push({ html: banner, heightMm: statusBannerMm(payload.status) });

  blocks.push({ html: renderPatientBanner(payload.patient), heightMm: patientBannerMm(payload.patient) });
  blocks.push({
    html: renderMetaGrid([
      ['Report No.', `${payload.reportNo} · v${String(payload.status.version)}`],
      ['Reference', payload.accessionNo],
      ['Period', payload.periodLabel],
      ['Collections', String(payload.columns.length)],
      ['Analytes', String(payload.analytes.length)],
      ['Compiled', payload.compiledAtLabel],
    ]),
    heightMm: metaMm(6, 2),
  });

  const runs = columnRuns(payload.columns.length);
  runs.forEach((run, runIndex) => {
    const width = run.to - run.from;
    const heading =
      runs.length === 1
        ? 'Serial results'
        : `Serial results — collections ${String(run.from + 1)}–${String(run.to)} of ${String(payload.columns.length)}`;
    blocks.push({
      html: `<h2 class="section-heading">${escapeHtml(heading)}</h2>`,
      heightMm: HEIGHT.sectionHeading + CUMULATIVE_TABLE_HEAD_MM,
      keepWithNext: true,
    });

    const container = {
      id: `run${String(runIndex)}`,
      open: `<table class="doc">${runColgroup(width)}${runHead(payload, run)}<tbody>`,
      close: '</tbody></table>',
    };
    for (const analyte of payload.analytes) {
      const cells = analyte.cells.slice(run.from, run.to).map(cellHtml).join('');
      const reference = [analyte.referenceInterval, analyte.unit]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .map(bdi)
        .join('<br />');
      const hasCritical = analyte.cells
        .slice(run.from, run.to)
        .some((cell) => cell !== null && isCriticalFlag(cell.flag));
      blocks.push({
        html: [
          `<tr class="${hasCritical ? 'row-critical' : ''}">`,
          `<td>${bdi(analyte.analyte)}${analyte.loincCode === undefined ? '' : `<div class="row-comment">LOINC ${bdi(analyte.loincCode)}</div>`}</td>`,
          `<td>${reference}</td>`,
          cells,
          '</tr>',
        ].join(''),
        // Measured at 12.1 mm: the reference cell stacks the interval over the
        // unit, so a serial row is a line taller than a single-order one even
        // before a LOINC subline is added.
        heightMm:
          HEIGHT.tableRow +
          (reference.includes('<br />') ? HEIGHT.tableRowSubline : 0) +
          (analyte.loincCode === undefined ? 0 : HEIGHT.tableRowSubline) +
          (hasCritical ? HEIGHT.tableRowCritical : 0),
        container,
      });
    }
  });

  if (payload.showTrend) {
    const trended = payload.analytes.filter((analyte) => numericPoints(analyte).length >= 2);
    if (trended.length > 0) {
      blocks.push({
        html: '<h2 class="section-heading">Trend</h2>',
        heightMm: HEIGHT.sectionHeading,
        keepWithNext: true,
      });
      for (const analyte of trended) {
        const direction = trendDirection(analyte);
        const glyph = direction === null ? '' : TREND_GLYPH[direction];
        const points = numericPoints(analyte);
        const first = points[0];
        const last = points[points.length - 1];
        const summary =
          first === undefined || last === undefined
            ? ''
            : `${String(first.value)} → ${String(last.value)}${analyte.unit === undefined ? '' : ` ${analyte.unit}`}`;
        blocks.push({
          html: [
            '<div class="trend-row">',
            `<div class="trend-label"><strong>${bdi(analyte.analyte)}</strong> <span class="trend-glyph">${glyph}</span> <span class="row-comment">${bdi(summary)}</span></div>`,
            renderSparkline(analyte, payload.columns.length),
            analyte.referenceLow === undefined || analyte.referenceHigh === undefined
              ? ''
              : `<div class="legend">Shaded band: reference interval ${escapeHtml(String(analyte.referenceLow))} – ${escapeHtml(String(analyte.referenceHigh))}${analyte.unit === undefined ? '' : ` ${escapeHtml(analyte.unit)}`}. Filled squares mark critical results.</div>`,
            '</div>',
          ].join(''),
          heightMm: TREND_MM,
        });
      }
    }
  }

  const notes: string[] = [
    ...payload.notes,
    'Compiled from previously authorised reports. Each value carries the flag and the biological reference interval that were in force when that result was released; intervals may differ between collections.',
    'Superscript a marks a value that was amended after its original report was issued. Superscript L / H mark results outside the reference interval; ! marks a critical value.',
  ];
  const notesContainer = {
    id: 'notes',
    open: '<h2 class="section-heading">Notes</h2><div class="prose">',
    close: '</div>',
  };
  notes.forEach((note, index) => {
    blocks.push({
      html: `<p>${escapeHtml(note)}</p>`,
      heightMm: proseMm([note]) + (index === 0 ? HEIGHT.sectionHeading : 0),
      container: notesContainer,
    });
  });

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

function cumulativeStyles(): string {
  return `
.trend-row { break-inside: avoid; margin-block-end: 4pt; }
.trend-label { font-size: 9pt; display: flex; gap: 6pt; align-items: baseline; }
.trend-glyph { font-weight: 800; }
td.cell-critical { font-weight: 800; }
td.cell-critical .flag-critical { margin-inline-start: 2pt; }
table.doc td sup { font-weight: 800; }
`.trim();
}

export function renderLabCumulativeReport(
  payload: LabCumulativeReportPayload,
  context: PrintContext,
): RenderedHtml {
  const pages = paginate(buildBlocks(payload), {
    firstPageBudgetMm: firstPageBudgetMm({ subtitle: true, accreditationNote: false }),
    repeatedTableHeadMm: CUMULATIVE_TABLE_HEAD_MM,
  });
  const html = [
    openDocument(context, `${payload.title} ${payload.reportNo}`),
    `<style>${cumulativeStyles()}</style>`,
    renderReportPages(pages, context, {
      title: payload.title,
      subtitle: payload.subtitle ?? payload.periodLabel,
      reportNo: payload.reportNo,
      accessionNo: payload.accessionNo,
      status: payload.status,
      patient: payload.patient,
    }),
    closeDocument(),
  ].join('');

  return { format: 'a4', contentType: 'text/html', paper: 'A4', html };
}

export const labCumulativeReportTemplate: RegisteredTemplate = defineTemplate({
  key: 'lab_report_cumulative.html.v1',
  docType: 'lab_report_cumulative',
  format: 'a4',
  paper: 'A4',
  version: 1,
  description:
    'A4 cumulative laboratory report — selected analytes across collections as a chunked table plus per-analyte sparklines with the reference band (OP-004 §3.6.1, acceptance criterion 12).',
  phi: true,
  payloadSchema: labCumulativeReportPayloadSchema,
  render: renderLabCumulativeReport,
});
