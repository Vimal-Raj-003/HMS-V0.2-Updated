import { describe, expect, it } from 'vitest';

import { sampleContext, sampleCumulativeReport } from '../fixtures.js';
import { PrintTemplateError } from '../types.js';
import {
  labCumulativeReportTemplate,
  renderLabCumulativeReport,
  renderSparkline,
  trendDirection,
  type LabCumulativeReportPayload,
} from './lab-cumulative-report.js';
import { buildVerifyUrl } from './report-shell.js';

const CONTEXT = sampleContext();

function render(payload: LabCumulativeReportPayload): string {
  return renderLabCumulativeReport(payload, CONTEXT).html;
}

function pageCount(html: string): number {
  return html.split('<section class="page">').length - 1;
}

/** `n` analytes × `m` collections, so the column-chunking can be exercised. */
function grid(analytes: number, collections: number): LabCumulativeReportPayload {
  return sampleCumulativeReport({
    columns: Array.from({ length: collections }, (_, i) => ({
      dateLabel: `${String((i % 28) + 1).padStart(2, '0')}-Jan-2026`,
      accessionNo: `LAB-2026-${String(1000 + i)}`,
    })),
    analytes: Array.from({ length: analytes }, (_, a) => ({
      analyte: `Analyte ${String(a + 1)}`,
      unit: 'mg/dL',
      referenceInterval: '0.10 – 9.90',
      referenceLow: 0.1,
      referenceHigh: 9.9,
      cells: Array.from({ length: collections }, (_, i) => ({
        value: (((a + i) % 20) / 2).toFixed(2),
        flag: 'normal' as const,
        numeric: ((a + i) % 20) / 2,
        amended: false,
      })),
    })),
  });
}

describe('the cumulative report — the series is the document', () => {
  const html = render(sampleCumulativeReport());

  it('is a self-contained A4 page', () => {
    const result = renderLabCumulativeReport(sampleCumulativeReport(), CONTEXT);
    expect(result.format).toBe('a4');
    expect(result.paper).toBe('A4');
    expect(html).toContain('@page { size: A4; margin: 12mm 12mm 16mm; }');
    expect(html).not.toContain('<link');
    expect(html).not.toContain('<script');
  });

  it('heads the table with one column per collection, dated and accessioned', () => {
    expect(html).toContain('<th>Analyte</th><th>Reference</th>');
    for (const date of ['12-Sep-2024', '18-Dec-2024', '20-Aug-2026']) {
      expect(html, date).toContain(`<th class="num">${date}`);
    }
    expect(html).toContain('<bdi>LAB-2024-1000</bdi>');
  });

  it('prints the period, the collection count and the analyte count', () => {
    expect(html).toContain('<bdi>12-Sep-2024 to 20-Aug-2026</bdi>');
    expect(html).toContain('<span class="meta-value"><bdi>8</bdi></span>');
    expect(html).toContain('<span class="meta-value"><bdi>2</bdi></span>');
  });

  it('lines every value up under its own date', () => {
    const row = html.slice(html.indexOf('<bdi>HbA1c</bdi>'));
    const cells = row.slice(0, row.indexOf('</tr>')).match(/<td class="num[^"]*">(?:<bdi>)?([^<]*)/g) ?? [];
    expect(cells).toHaveLength(8);
    expect(row).toContain('<bdi>7.8</bdi>');
    expect(row).toContain('<bdi>7.1</bdi>');
  });

  it('marks a value that was amended after its original report', () => {
    expect(html).toContain('<sup>a</sup>');
    expect(html).toContain('Superscript a marks a value that was amended');
  });

  it('flags out-of-range values without shouting about every one of them', () => {
    expect(html).toContain('<sup>H</sup>');
    expect(html).toContain('Superscript L / H mark results outside the reference interval');
  });

  it('says which reference interval each value was flagged against', () => {
    expect(html).toContain(
      'Each value carries the flag and the biological reference interval that were in force when that result was released',
    );
  });

  it('numbers every page and identifies the patient on continuation pages', () => {
    const total = pageCount(html);
    for (let page = 1; page <= total; page += 1) {
      expect(html).toContain(`Page ${String(page)} of ${String(total)}`);
    }
    expect(html.split('<div class="cont-strip">').length - 1).toBe(total - 1);
  });

  it('renders byte-identically for the same input', () => {
    expect(render(sampleCumulativeReport())).toBe(render(sampleCumulativeReport()));
  });
});

describe('the graph', () => {
  const html = render(sampleCumulativeReport());

  it('draws one sparkline per numeric analyte, with the reference band behind it', () => {
    expect(html).toContain('<h2 class="section-heading">Trend</h2>');
    expect(html.split('<svg class="trend"').length - 1).toBe(2);
    expect(html).toContain('<polyline fill="none" stroke="#000"');
    expect(html).toContain('fill="#d9d9d9"'); // the reference band
    expect(html).toContain('Shaded band: reference interval 4 – 5.6 %');
  });

  it('labels each sparkline for a screen reader without leaking a value', () => {
    expect(html).toContain('aria-label="Trend of HbA1c across 8 collections"');
  });

  it('shows the direction of travel as a non-directional glyph, so RTL is safe', () => {
    expect(html).toContain('<span class="trend-glyph">▼</span>'); // HbA1c falling
    expect(html).toContain('<span class="trend-glyph">▲</span>'); // creatinine climbing
    expect(html).not.toContain('→</span>');
  });

  it('computes the direction from the first and last numeric point', () => {
    const payload = sampleCumulativeReport();
    const hba1c = payload.analytes[0];
    const creatinine = payload.analytes[1];
    if (hba1c === undefined || creatinine === undefined) throw new Error('fixture regression');
    expect(trendDirection(hba1c)).toBe('down');
    expect(trendDirection(creatinine)).toBe('up');
    expect(
      trendDirection({
        analyte: 'Flat',
        cells: [
          { value: '1', flag: 'normal', numeric: 1, amended: false },
          { value: '1', flag: 'normal', numeric: 1, amended: false },
        ],
      }),
    ).toBe('flat');
  });

  it('draws nothing for an analyte with fewer than two numeric points', () => {
    const payload = sampleCumulativeReport();
    const first = payload.analytes[0];
    if (first === undefined) throw new Error('fixture regression');
    const single: LabCumulativeReportPayload['analytes'][number] = {
      ...first,
      cells: first.cells.map((cell, index) => (index === 0 && cell !== null ? cell : null)),
    };
    expect(renderSparkline(single, 8)).toBe('');
    expect(trendDirection(single)).toBeNull();
  });

  it('marks a critical point as a filled square rather than a dot', () => {
    const payload = sampleCumulativeReport();
    const first = payload.analytes[0];
    if (first === undefined) throw new Error('fixture regression');
    const withCritical: LabCumulativeReportPayload['analytes'][number] = {
      ...first,
      cells: first.cells.map((cell, index) =>
        cell === null ? null : index === 3 ? { ...cell, flag: 'critical_high' as const } : cell,
      ),
    };
    const svg = renderSparkline(withCritical, 8);
    expect(svg.split('<rect').length - 1).toBe(2); // the band, plus one critical marker
    expect(svg.split('<circle').length - 1).toBe(7);
  });

  it('produces coordinates that do not depend on float formatting', () => {
    const payload = sampleCumulativeReport();
    const first = payload.analytes[0];
    if (first === undefined) throw new Error('fixture regression');
    const svg = renderSparkline(first, 8);
    expect(svg).toMatch(/points="[\d., ]+"/);
    for (const coordinate of (svg.match(/points="([^"]+)"/)?.[1] ?? '').split(/[ ,]/)) {
      expect(coordinate, coordinate).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('draws a flat line rather than dividing by zero when every value is identical', () => {
    const svg = renderSparkline(
      {
        analyte: 'Constant',
        cells: [
          { value: '5', flag: 'normal', numeric: 5, amended: false },
          { value: '5', flag: 'normal', numeric: 5, amended: false },
          { value: '5', flag: 'normal', numeric: 5, amended: false },
        ],
      },
      3,
    );
    expect(svg).toContain('<polyline');
    expect(svg).not.toContain('NaN');
    expect(svg).not.toContain('Infinity');
  });
});

describe('column chunking', () => {
  /**
   * The header-repetition property, stated the way the document is actually
   * built.
   *
   * The first version of both these tests asserted
   * `count('<th>Analyte</th>') === pageCount(html)` — "one analyte heading per
   * page". That is only true if every page is a table page, and it is not: the
   * trend section puts seven sparklines on a page with no table at all, which
   * the sparkline tests in this same file rely on. A 40-analyte report is four
   * table pages followed by six trend pages, so the assertion failed on a
   * correct document.
   *
   * What must actually hold is narrower and is the thing a reader depends on: a
   * page carrying a table carries that table's column headings, so a row on
   * page 3 can still be read as a potassium. Counting per page rather than per
   * document also catches the regression the loose version could not — two
   * tables on one page with only one header between them.
   */
  const tablePages = (html: string): readonly string[] =>
    html
      .split('<section class="page">')
      .slice(1)
      .filter((page) => page.includes('<table'));

  function expectEveryTableCarriesItsHeadings(html: string): void {
    const pages = tablePages(html);
    expect(pages.length, 'pages containing a table').toBeGreaterThan(0);
    for (const [index, page] of pages.entries()) {
      const tables = page.split('<table').length - 1;
      const headings = page.split('<th>Analyte</th>').length - 1;
      expect(headings, `table page ${String(index + 1)}: ${String(tables)} table(s)`).toBe(tables);
    }
  }

  it('keeps every collection on one table while there are eight or fewer', () => {
    const html = render(grid(3, 8));
    expect(html).toContain('<h2 class="section-heading">Serial results</h2>');
    // One run, so one table, and it fits on a single page.
    expect(html.split('<th>Analyte</th>').length - 1).toBe(1);
    expectEveryTableCarriesItsHeadings(html);
  });

  it('splits into runs of eight and names the range each run covers', () => {
    const html = render(grid(3, 20));
    expect(html).toContain('Serial results — collections 1–8 of 20');
    expect(html).toContain('Serial results — collections 9–16 of 20');
    expect(html).toContain('Serial results — collections 17–20 of 20');
  });

  it('never splits a row and never leaves a table unclosed on a page', () => {
    const html = render(grid(30, 20));
    expect(pageCount(html)).toBeGreaterThan(2);
    for (const page of html.split('<section class="page">').slice(1)) {
      expect(page.split('<tr').length - 1).toBe(page.split('</tr>').length - 1);
      expect(page.split('<table').length - 1).toBe(page.split('</table>').length - 1);
    }
  });

  it('repeats the column headings on every page a run spans', () => {
    const html = render(grid(40, 8));
    // Forty analytes cannot fit on one page, so the run genuinely spans several
    // and each continuation must reprint the dates.
    expect(tablePages(html).length).toBeGreaterThan(1);
    expectEveryTableCarriesItsHeadings(html);
  });

  it('repeats them again when the columns are also chunked', () => {
    // Both axes at once: 30 analytes over 20 collections is three column runs,
    // each spanning several pages. This is where a page ends up with two tables
    // on it, and where one shared header would be wrong.
    expectEveryTableCarriesItsHeadings(render(grid(30, 20)));
  });
});

describe('refusals', () => {
  it('refuses a row whose cells do not line up with the collection dates', () => {
    const payload = sampleCumulativeReport();
    const first = payload.analytes[0];
    if (first === undefined) throw new Error('fixture regression');
    const result = labCumulativeReportTemplate.validate({
      ...payload,
      analytes: [{ ...first, cells: first.cells.slice(0, 5) }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/under the wrong date/);
    }
  });

  it('refuses a compilation with no collections and one with no analytes', () => {
    expect(() =>
      labCumulativeReportTemplate.render({ ...sampleCumulativeReport(), columns: [] }, CONTEXT),
    ).toThrow(PrintTemplateError);
    expect(() =>
      labCumulativeReportTemplate.render({ ...sampleCumulativeReport(), analytes: [] }, CONTEXT),
    ).toThrow(PrintTemplateError);
  });

  it('refuses to release as final without an authorising signatory', () => {
    const result = labCumulativeReportTemplate.validate(sampleCumulativeReport({ authorisers: [] }));
    expect(result.ok).toBe(false);
  });
});

describe('status and verification', () => {
  it('stamps PROVISIONAL on an unauthorised compilation', () => {
    const html = render(
      sampleCumulativeReport({
        status: { release: 'provisional', version: 1, provisionalReason: 'Draft compilation' },
        authorisers: [],
      }),
    );
    expect(html).toContain('class="seal seal-provisional"');
    expect(html).toContain('PROVISIONAL<br />NOT FOR CLINICAL USE');
    expect(html).toContain('Not authorised');
    expect(html).not.toContain('Authorised by');
  });

  it('encodes exactly the verify base plus the opaque token, and no identifier', () => {
    const payload = sampleCumulativeReport();
    const html = render(payload);
    const url = buildVerifyUrl(payload.verify, []);
    expect(url).toBe('https://verify.vims-hospital.example/r/Q3VtdWxhdGl2ZVRva2VuXzAwMDAwMDAwMDE');
    const start = html.indexOf('<div class="qr-block">');
    const block = html.slice(start, html.indexOf('</div></div>', start));
    for (const identifier of ['Ramesh', 'CBE-000123456', '14-Feb-1968']) {
      expect(block, identifier).not.toContain(identifier);
    }
  });
});

describe('the registered template', () => {
  it('validates and renders the fixture', () => {
    expect(labCumulativeReportTemplate.validate(sampleCumulativeReport())).toEqual({ ok: true });
    expect(labCumulativeReportTemplate.render(sampleCumulativeReport(), CONTEXT).format).toBe('a4');
  });
});
