/**
 * The print domain's shared vocabulary (`EN-005 §4`).
 *
 * Every string union here is the *database* enum or check-constrained column
 * from `packages/db/prisma/migrations/20260819064500_phase0_platform_modules`,
 * restated in TypeScript. They are restated rather than imported because
 * `packages/db` exports a Prisma client, and a worker that had to instantiate
 * Prisma to know what `'paper_out'` means would couple a byte-pushing dispatcher
 * to an ORM it never uses. The unit tests below assert the two stay in step.
 */

/** `core."PrintJobStatus"`. */
export type PrintJobStatus =
  'queued' | 'sent' | 'printing' | 'completed' | 'failed' | 'cancelled' | 'fallback_browser';

/** `core."PrintFormat"` — how the bytes reach the device, not what they contain. */
export type PrintWireFormat = 'zpl' | 'escpos' | 'tspl' | 'pdf';

/** `core.print_printers.driver_mode`. */
export type PrinterDriverMode = 'raw_zpl' | 'raw_escpos' | 'raw_tspl' | 'pdf';

/** `core.print_printers.kind`. */
export type PrinterKind = 'thermal' | 'label' | 'laser' | 'dot_matrix' | 'pdf_virtual';

/** `core.print_printers.status` (SNMP / OS spooler, `EN-005 §3.1`). */
export type PrinterStatus =
  'unknown' | 'online' | 'offline' | 'paper_out' | 'toner_low' | 'door_open' | 'error';

/** `core.print_agents.status`. */
export type PrintAgentStatus = 'unpaired' | 'online' | 'offline' | 'disabled';

/**
 * `core.print_mappings.scope_type`, ordered by the specificity rule of
 * `EN-005 §3.2`: "user override → counter/workstation → location/department →
 * branch default".
 */
export type PrintMappingScope = 'user' | 'workstation' | 'counter' | 'location' | 'department' | 'branch';

/**
 * Lower wins. The ordering is the whole point of the mapping table: a cashier
 * who has chosen a printer for this session must beat the counter default, which
 * must beat the branch default, or "print elsewhere" silently stops working.
 */
export const MAPPING_SPECIFICITY: Readonly<Record<PrintMappingScope, number>> = Object.freeze({
  user: 1,
  workstation: 2,
  counter: 3,
  location: 4,
  department: 5,
  branch: 6,
});

/** Printer states that mean "the bytes will not print right now" (`EN-005 §3.3.2`). */
export const NOT_READY_PRINTER_STATUSES: ReadonlySet<PrinterStatus> = new Set<PrinterStatus>([
  'offline',
  'paper_out',
  'door_open',
  'error',
]);

/** Why a job could not be handed over. Drives the retry-vs-fail decision. */
export type PrinterUnavailableReason =
  'printer_offline' | 'paper_out' | 'door_open' | 'printer_error' | 'agent_down';

/**
 * A transient failure: the document is fine, the device is not.
 *
 * `EN-005 §3.3.2` and `docs/01 §7` both require the *job to stay queued* — never
 * failed, never dropped — while the user is offered another printer. Modelling
 * that as its own error type is what keeps a paper-out from being counted as a
 * lost receipt.
 */
export class PrinterUnavailableError extends Error {
  override readonly name = 'PrinterUnavailableError';
  readonly printerId: string | null;
  readonly reason: PrinterUnavailableReason;

  constructor(reason: PrinterUnavailableReason, printerId: string | null, message?: string) {
    super(message ?? `Printer unavailable (${reason}).`);
    this.reason = reason;
    this.printerId = printerId;
  }
}

/**
 * A failure that retrying cannot fix: a payload the template rejects, a template
 * key that does not exist, a format the transport cannot speak.
 * `EN-005 §3.3.2`: "permanent errors immediate fail".
 */
export class PrintPermanentError extends Error {
  override readonly name = 'PrintPermanentError';
}

/** A resolved physical destination: one printer, reachable through one agent. */
export interface PrinterTarget {
  readonly printerId: string;
  readonly name: string;
  readonly kind: PrinterKind;
  readonly driverMode: PrinterDriverMode;
  readonly paper: string;
  readonly status: PrinterStatus;
  readonly agentId: string | null;
  readonly agentStatus: PrintAgentStatus | null;
  readonly agentLastHeartbeatAt: Date | null;
  readonly branchId: string;
}

/** What the dispatcher produced and is about to push at a device. */
export interface PrintArtifact {
  readonly format: PrintWireFormat;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** Physical sheets, for cost tracking (`EN-005 §3.6`). `null` for continuous media. */
  readonly pages: number | null;
}

/**
 * Outcome of handing an artifact to a transport.
 *
 * `accepted` and `printed` are genuinely different states and collapsing them
 * would be a lie in the audit trail: a LAN agent acknowledges the spool
 * (`sent`), and only its later callback proves paper moved (`completed`).
 */
export interface TransportResult {
  readonly state: 'accepted' | 'printed';
  readonly pages?: number | undefined;
}

export interface TransportRequest {
  readonly jobId: string;
  readonly printer: PrinterTarget;
  readonly artifact: PrintArtifact;
  readonly copies: number;
}

/**
 * How bytes leave the worker. The LAN print agent, the raw-TCP:9100 socket and
 * the ESC/POS emulator are all just implementations of this.
 */
export interface PrinterTransport {
  readonly id: string;
  /** Throws `PrinterUnavailableError` for a transient device fault. */
  send(request: TransportRequest): Promise<TransportResult>;
}
