import { pino, type Logger } from 'pino';

/**
 * The print logger.
 *
 * `docs/04 §7` and `EN-005 §13` are the same instruction from two directions:
 * **no PHI in logs**, "no PHI in agent logs (job ids only)". A print job is the
 * single most tempting place to break that rule, because the thing being printed
 * is a patient's name, and the obvious debug line is "printing bill for X".
 *
 * Two mechanisms enforce it here rather than relying on discipline:
 *
 *  1. `printJobLogContext()` is an **allow-list**. Log lines take its output, so
 *     a field can only be logged if someone deliberately added it to a list whose
 *     every entry is an identifier or a status.
 *  2. `redact` is the belt to that braces: if a payload ever reaches a log call
 *     by another route, pino removes the known-PHI paths before serialising.
 */

const PHI_REDACT_PATHS = [
  'payload',
  'context',
  'patientName',
  'patient',
  'uhid',
  'doctorName',
  'html',
  '*.payload',
  '*.patientName',
  '*.uhid',
  '*.html',
];

export const printLogger: Logger = pino({
  name: 'print',
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'worker', module: 'EN-005' },
  redact: { paths: PHI_REDACT_PATHS, remove: true },
});

/** Every field of a print job that is safe to write to a log or a trace. */
export interface PrintJobLogContext {
  readonly jobId: string;
  readonly docType: string;
  readonly templateKey: string | null;
  readonly format: string;
  readonly status: string;
  readonly attempts: number;
  readonly copies: number;
  readonly phi: boolean;
  readonly printerId: string | null;
  readonly agentId: string | null;
  readonly hospitalId: string;
  readonly branchId: string;
}

/**
 * Narrow anything job-shaped to the fields above.
 *
 * `patientId` is deliberately absent even though it is only a UUID: `docs/04 §7`
 * keeps identifiers out of logs too, because a job id plus a patient id in the
 * same line reconstructs "who was printed for" from log storage that is not
 * access-controlled like the database is.
 */
export function printJobLogContext(job: {
  readonly id: string;
  readonly docType: string;
  readonly templateKey: string | null;
  readonly format: string;
  readonly status: string;
  readonly attempts: number;
  readonly copies: number;
  readonly phi: boolean;
  readonly printerId: string | null;
  readonly agentId: string | null;
  readonly hospitalId: string;
  readonly branchId: string;
}): PrintJobLogContext {
  return {
    jobId: job.id,
    docType: job.docType,
    templateKey: job.templateKey,
    format: job.format,
    status: job.status,
    attempts: job.attempts,
    copies: job.copies,
    phi: job.phi,
    printerId: job.printerId,
    agentId: job.agentId,
    hospitalId: job.hospitalId,
    branchId: job.branchId,
  };
}
