import {
  sampleContext,
  sampleCumulativeReport,
  sampleLabReport,
  sampleRadReport,
} from '@vims/print-templates';
import { labCumulativeReportTemplate, labReportTemplate, radReportTemplate } from '@vims/print-templates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightPdfRenderer } from './pdf-renderer.js';

/**
 * Phase 3 exit gate 8, second clause: **report PDF generation < 3 s p95**.
 *
 * The templates have unit tests; nothing measured what happens when Chromium is
 * handed one. That gap matters because the expensive part of a report is not the
 * string-building this package tests — it is layout, font shaping and
 * pagination, none of which a template test exercises.
 *
 * Measured, not estimated. If Chromium cannot launch here the suite fails rather
 * than skipping: a performance gate that quietly does not run is the same as one
 * that was never written, and this whole file exists because of the second kind.
 *
 * The number is a floor, not a promise about production. It is one warm browser
 * on a developer machine with no contention, which is the *best* case; a ward
 * server under load will be slower, and the budget has to hold there. Treating a
 * comfortable local margin as headroom is how a budget gets missed in the field.
 */
let renderer: PlaywrightPdfRenderer;

const ITERATIONS = Number(process.env['PDF_BUDGET_ITERATIONS'] ?? 12);
const P95_BUDGET_MS = 3_000;

beforeAll(async () => {
  renderer = new PlaywrightPdfRenderer();
  // Warm the browser outside the measurement. A cold Chromium launch is ~1 s and
  // happens once per worker process, not once per report; charging it to the
  // first report would measure process start-up and call it a render.
  await renderer.renderHtml({ html: '<p>warm-up</p>', paper: 'A4' });
}, 300_000);

afterAll(async () => {
  await renderer?.close?.();
});

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank, the same definition k6 reports, so the two numbers are
  // comparable rather than nearly comparable.
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? 0;
}

describe('report PDF rendering stays inside the exit gate 8 budget', () => {
  /**
   * A ward's worst realistic report, not its typical one.
   *
   * The stock fixtures are three analytes over four collections and render in
   * tens of milliseconds — measuring only those would report a 40x margin that
   * says nothing about the document a diabetologist actually opens. Forty
   * analytes over twenty collections is three column runs across a dozen pages
   * with a sparkline per row, which is where layout and font shaping actually
   * cost something.
   */
  function largeCumulative(analytes: number, collections: number) {
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

  const CASES = [
    ['lab report', () => labReportTemplate.render(sampleLabReport(), sampleContext())],
    ['radiology report', () => radReportTemplate.render(sampleRadReport(), sampleContext())],
    [
      'cumulative report',
      () => labCumulativeReportTemplate.render(sampleCumulativeReport(), sampleContext()),
    ],
    [
      'cumulative report, 40 analytes over 20 collections',
      () => labCumulativeReportTemplate.render(largeCumulative(40, 20), sampleContext()),
    ],
  ] as const;

  it.each(CASES)(
    'renders a %s under 3 s at p95',
    async (name, build) => {
      const document = build();
      if (document.format !== 'a4') throw new Error(`${name} did not render as A4`);

      const samples: number[] = [];
      for (let i = 0; i < ITERATIONS; i += 1) {
        const started = performance.now();
        const artifact = await renderer.renderDocument(document);
        samples.push(performance.now() - started);
        // A "fast" render that produced nothing is not a fast render.
        expect(artifact.bytes.byteLength).toBeGreaterThan(1_000);
        expect(artifact.pages).toBeGreaterThan(0);
      }

      const p95 = percentile(samples, 95);
      const p50 = percentile(samples, 50);
      // Reported unconditionally: the margin is the interesting number, and a
      // gate that only speaks when it fails cannot show a trend.
      process.stdout.write(
        `  ${name}: p50 ${p50.toFixed(0)} ms, p95 ${p95.toFixed(0)} ms, max ${Math.max(...samples).toFixed(0)} ms over ${String(ITERATIONS)} renders\n`,
      );
      expect(p95, `${name} p95 exceeded the exit gate 8 budget`).toBeLessThan(P95_BUDGET_MS);
    },
    300_000,
  );
});
