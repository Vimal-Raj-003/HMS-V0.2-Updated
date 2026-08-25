/**
 * The template registry.
 *
 * `EN-005 §3.2` resolves a document type to a printer *and a template key*, and
 * `EN-039 §5` keeps the template itself as data with per-hospital overrides. So
 * the registry here is the **built-in default set**: what a hospital gets before
 * anybody customises anything, and what the admin console's "test print" and
 * preview screens render.
 *
 * A hospital override (a different letterhead, an extra footer line) is stored in
 * `core.print_templates` and resolved by the API; it never edits this file.
 */

import { a4DocumentTemplate } from './html/document.js';
import { labCumulativeReportTemplate } from './html/lab-cumulative-report.js';
import { labReportTemplate } from './html/lab-report.js';
import { radReportTemplate } from './html/rad-report.js';
import { tokenSlipTemplate } from './escpos/token-slip.js';
import { labLabelTemplate } from './zpl/lab-label.js';
import { wristbandTemplate } from './zpl/wristband.js';
import { PrintTemplateError, type DocType, type PrintFormat, type RegisteredTemplate } from './types.js';

export const BUILT_IN_TEMPLATES: readonly RegisteredTemplate[] = Object.freeze([
  a4DocumentTemplate,
  labReportTemplate,
  labCumulativeReportTemplate,
  radReportTemplate,
  tokenSlipTemplate,
  labLabelTemplate,
  wristbandTemplate,
]);

const byKey = new Map(BUILT_IN_TEMPLATES.map((template) => [template.key, template]));

if (byKey.size !== BUILT_IN_TEMPLATES.length) {
  throw new PrintTemplateError('Duplicate template key in BUILT_IN_TEMPLATES.');
}

export function getTemplate(key: string): RegisteredTemplate | undefined {
  return byKey.get(key);
}

/** Throwing lookup for a print job, whose `template_key` came from a mapping row. */
export function requireTemplate(key: string): RegisteredTemplate {
  const template = byKey.get(key);
  if (template === undefined) {
    throw new PrintTemplateError(
      `No print template "${key}". Known keys: ${[...byKey.keys()].join(', ')}. A hospital override must still name a built-in key (EN-039 §5).`,
    );
  }
  return template;
}

export interface TemplateFilter {
  readonly docType?: DocType | undefined;
  readonly format?: PrintFormat | undefined;
}

export function listTemplates(filter: TemplateFilter = {}): readonly RegisteredTemplate[] {
  return BUILT_IN_TEMPLATES.filter(
    (template) =>
      (filter.docType === undefined || template.docType === filter.docType) &&
      (filter.format === undefined || template.format === filter.format),
  );
}

/** The default template for a document type — what `print_mappings` seeds with. */
export function defaultTemplateFor(docType: DocType): RegisteredTemplate | undefined {
  return BUILT_IN_TEMPLATES.find((template) => template.docType === docType);
}
