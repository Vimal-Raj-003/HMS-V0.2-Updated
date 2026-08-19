/**
 * `@vims/print-templates` — the template contract and the built-in A4/A5,
 * ESC/POS and ZPL templates (`EN-005 §3.5`, `phase-00 §0.6`).
 *
 * Everything here is a pure function from payload + context to a string or a
 * byte array. The Playwright HTML→PDF renderer, the print queue and the print
 * agent live in `services/worker` and `services/api`; keeping them out means
 * every template can be asserted byte-for-byte in a unit test.
 */

export {
  PrintTemplateError,
  defineTemplate,
  type BranchIdentity,
  type DocType,
  type HospitalIdentity,
  type PaperSize,
  type PayloadIssue,
  type PayloadValidation,
  type PrintContext,
  type PrintFormat,
  type RegisteredTemplate,
  type RenderedDocument,
  type RenderedEscPos,
  type RenderedHtml,
  type RenderedZpl,
  type TemplateDefinition,
  type TextDirection,
} from './types.js';

export {
  BUILT_IN_TEMPLATES,
  defaultTemplateFor,
  getTemplate,
  listTemplates,
  requireTemplate,
  type TemplateFilter,
} from './registry.js';

export { sampleContext } from './fixtures.js';

export * from './html/index.js';
export * from './escpos/index.js';
export * from './zpl/index.js';
