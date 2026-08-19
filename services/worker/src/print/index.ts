/**
 * EN-005 print pipeline for `services/worker` — the renderer, the emulator, the
 * queue and the registry resolution that `phase-00 §0.4` asks the worker for
 * ("Playwright PDF renderer, print dispatcher to `print-agent` (EN-005) with
 * ZPL/ESC-POS support") and that exit gate 6 is proved against.
 *
 * The document *templates* are not here: they live in `@vims/print-templates` as
 * pure functions, so a letterhead can be asserted byte-for-byte without a
 * browser. This package consumes them.
 */

export { printLogger, printJobLogContext, type PrintJobLogContext } from './logger.js';

export {
  PlaywrightPdfRenderer,
  type PdfMargin,
  type PdfPaper,
  type PdfRendererOptions,
  type PdfRendererPort,
  type PdfRenderRequest,
} from './pdf-renderer.js';

export {
  PAPER_POINTS,
  countPdfPages,
  extractPdfText,
  extractPdfTextPages,
  isPdf,
  pdfPageGeometries,
  pdfVersion,
  type PdfPageGeometry,
  type PdfTextPage,
} from './pdf-inspect.js';

export {
  EscPosEmulator,
  decodeEscPos,
  scanEscPosControls,
  splitEscPosOnCut,
  type DecodedEscPos,
  type EmulatorFault,
  type EscPosControl,
  type EscPosControlName,
  type EscPosEmulatorOptions,
} from './escpos-emulator.js';

export {
  AGENT_HEARTBEAT_STALE_MS,
  PrintScopeError,
  findPrinter,
  listAlternativePrinters,
  loadPrintMappings,
  printerUnavailableReason,
  rankMappings,
  resolvePrinter,
  withPrintScope,
  type PrintMappingRow,
  type PrintTenantScope,
  type PrinterResolution,
  type PrinterResolutionContext,
} from './printer-registry.js';

export {
  cancelStalePrintJobs,
  createPrintJob,
  emitPrintEvent,
  findPrintJob,
  lockPrintJob,
  updatePrintJobStatus,
  type CreatePrintJobInput,
  type PrintEventInput,
  type PrintJobRecord,
  type PrintJobStatusPatch,
} from './print-job-repository.js';

export {
  MapTransportResolver,
  StaticPayloadSource,
  assertDriverAccepts,
  dispatchArtifact,
  renderPrintArtifact,
  type DispatchInput,
  type PrintPayloadEnvelope,
  type PrintPayloadSource,
  type TransportResolver,
} from './print-dispatcher.js';

export {
  DEFAULT_PRINT_RETRY,
  PRINT_QUEUE_NAME,
  PRINT_QUEUE_PRIORITY,
  STALE_JOB_HOURS,
  cancelStalePrintJobsForTenant,
  createPrintQueue,
  createPrintWorker,
  enqueuePrintJob,
  maxAttemptsFor,
  printJobOptions,
  processPrintJob,
  type PrintJobOutcome,
  type PrintJobRef,
  type PrintProcessorDeps,
  type PrintRetryPolicy,
} from './print-queue.js';

export {
  MAPPING_SPECIFICITY,
  NOT_READY_PRINTER_STATUSES,
  PrintPermanentError,
  PrinterUnavailableError,
  type PrintAgentStatus,
  type PrintArtifact,
  type PrintJobStatus,
  type PrintMappingScope,
  type PrintWireFormat,
  type PrinterDriverMode,
  type PrinterKind,
  type PrinterStatus,
  type PrinterTarget,
  type PrinterTransport,
  type PrinterUnavailableReason,
  type TransportRequest,
  type TransportResult,
} from './types.js';
