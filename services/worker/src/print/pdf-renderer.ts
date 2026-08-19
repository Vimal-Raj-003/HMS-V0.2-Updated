import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { RenderedHtml } from '@vims/print-templates';

import { countPdfPages } from './pdf-inspect.js';
import { PrintPermanentError, type PrintArtifact } from './types.js';

/**
 * HTML → PDF, the laser half of `EN-005 §3.3` and `phase-00 §0.4`
 * ("Playwright PDF renderer").
 *
 * The templates in `@vims/print-templates` are pure functions returning markup;
 * this is the only place a browser is involved, and it does four things that a
 * naive `page.pdf()` call does not:
 *
 *  - **`setContent`, never a URL.** The markup is already self-contained (the
 *    logo is a data URI, the CSS is inline) because `docs/01 §7` requires an
 *    on-prem deployment to print with the internet down. Loading from a URL
 *    would reintroduce the dependency the templates were written to avoid, and
 *    `waitUntil: 'load'` with no network is deterministic.
 *  - **`emulateMedia({ media: 'print' })`.** Chromium applies print styles to
 *    `page.pdf()` anyway, but not to a screenshot or to `matchMedia` inside the
 *    page; setting it explicitly means what a preview shows is what prints.
 *  - **`preferCSSPageSize`.** The template owns its geometry:
 *    `letterheadStyles()` declares `@page { size: A4; margin: 12mm 12mm 16mm }`,
 *    and that rule — size *and* margins — is what the page is laid out to.
 *    `print.integration.spec.ts` reads the `/MediaBox` back to prove an A4
 *    template really produced an A4 page and an A5 one an A5 page.
 *  - **One browser, many pages.** Launching Chromium costs ~300 ms; `EN-005 §13`
 *    budgets 1.5 s for a whole A4 render, so the browser is started once and
 *    each job gets a fresh page (a fresh *context* per job would cost most of
 *    the launch again, and there is no cross-job state in a `setContent` page).
 */

export type PdfPaper = 'A4' | 'A5';

export interface PdfMargin {
  readonly top?: string | undefined;
  readonly right?: string | undefined;
  readonly bottom?: string | undefined;
  readonly left?: string | undefined;
}

export interface PdfRenderRequest {
  readonly html: string;
  readonly paper: PdfPaper;
  readonly landscape?: boolean | undefined;
  /**
   * Margins for a template that declares none.
   *
   * Measured, not assumed: with `preferCSSPageSize` set, Chromium lets a CSS
   * `@page { margin: … }` rule win over this option, so it has no effect on the
   * built-in templates (which all declare their own). It exists for a hospital
   * override whose stylesheet omits `@page`.
   */
  readonly margin?: PdfMargin | undefined;
  readonly timeoutMs?: number | undefined;
}

/** The port the dispatcher depends on, so a unit test needs no browser. */
export interface PdfRendererPort {
  renderHtml(request: PdfRenderRequest): Promise<PrintArtifact>;
}

export interface PdfRendererOptions {
  /** `EN-005 §13`: A4 render < 1.5 s. The ceiling is generous; the budget is not. */
  readonly timeoutMs?: number;
  readonly executablePath?: string;
}

/**
 * Drop unset sides. Playwright's `margin` is exact-optional, so passing
 * `{ top: undefined }` is a type error and, worse, would read as "no margin".
 */
function definedMargin(margin: PdfMargin): { top?: string; right?: string; bottom?: string; left?: string } {
  const out: { top?: string; right?: string; bottom?: string; left?: string } = {};
  if (margin.top !== undefined) out.top = margin.top;
  if (margin.right !== undefined) out.right = margin.right;
  if (margin.bottom !== undefined) out.bottom = margin.bottom;
  if (margin.left !== undefined) out.left = margin.left;
  return out;
}

export class PlaywrightPdfRenderer implements PdfRendererPort {
  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  readonly #timeoutMs: number;
  readonly #executablePath: string | undefined;

  constructor(options: PdfRendererOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#executablePath = options.executablePath;
  }

  async #ready(): Promise<BrowserContext> {
    if (this.#context !== null) return this.#context;
    const browser = await chromium.launch(
      this.#executablePath === undefined
        ? { args: ['--font-render-hinting=none'] }
        : { args: ['--font-render-hinting=none'], executablePath: this.#executablePath },
    );
    // A fixed viewport and DPR keep a CI render byte-comparable with a ward
    // server's; `page.pdf()` uses the print layout, but images and any
    // viewport-relative CSS in a hospital's custom template do not.
    const context = await browser.newContext({
      viewport: { width: 1240, height: 1754 },
      deviceScaleFactor: 1,
    });
    this.#browser = browser;
    this.#context = context;
    return context;
  }

  async renderHtml(request: PdfRenderRequest): Promise<PrintArtifact> {
    if (request.html.trim().length === 0) {
      throw new PrintPermanentError(
        'Refusing to render an empty document: a blank page is never a valid print job.',
      );
    }

    const context = await this.#ready();
    const page = await context.newPage();
    try {
      const timeout = request.timeoutMs ?? this.#timeoutMs;
      await page.setContent(request.html, { waitUntil: 'load', timeout });
      await page.emulateMedia({ media: 'print' });

      const bytes = await page.pdf({
        format: request.paper,
        landscape: request.landscape ?? false,
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        ...(request.margin === undefined ? {} : { margin: definedMargin(request.margin) }),
      });

      const artifact: PrintArtifact = {
        format: 'pdf',
        contentType: 'application/pdf',
        bytes: new Uint8Array(bytes),
        pages: countPdfPages(bytes),
      };
      return artifact;
    } finally {
      await page.close();
    }
  }

  /** Render what a template produced, keeping its declared paper size. */
  async renderDocument(document: RenderedHtml): Promise<PrintArtifact> {
    return this.renderHtml({ html: document.html, paper: document.paper === 'A5' ? 'A5' : 'A4' });
  }

  async close(): Promise<void> {
    await this.#context?.close();
    await this.#browser?.close();
    this.#context = null;
    this.#browser = null;
  }
}
