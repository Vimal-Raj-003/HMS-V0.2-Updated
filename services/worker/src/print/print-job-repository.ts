import { assertRegisteredEvent } from '@vims/contracts/events';
import { newId } from '@vims/contracts/primitives';
import type { PoolClient } from 'pg';

import type { PrintJobStatus, PrintWireFormat } from './types.js';

/**
 * Persistence for `core.print_jobs` (`EN-005 §4`).
 *
 * One shape here is not incidental and is the reason this is a module rather
 * than four inline queries: **`print_jobs` is partitioned monthly on
 * `created_at`, so its primary key is `(id, created_at)`.** Every UPDATE must
 * therefore carry the creation timestamp as well as the id, and it must carry it
 * as *text*: `created_at` is `timestamptz(6)` while a JavaScript `Date` holds
 * only milliseconds, so a round-tripped `Date` silently loses the microseconds,
 * matches zero rows, and the job is retried forever while appearing to succeed.
 * `services/worker/src/relay/outbox-relay.ts` learned the same lesson on
 * `outbox_events`; this follows its convention deliberately.
 */

export interface PrintJobRecord {
  readonly id: string;
  readonly createdAt: Date;
  /** The stored value verbatim — the other half of the partitioned key. */
  readonly createdAtText: string;
  readonly hospitalId: string;
  readonly branchId: string;
  readonly docType: string;
  readonly templateKey: string | null;
  readonly printerId: string | null;
  readonly agentId: string | null;
  readonly requestedBy: string | null;
  readonly workstationId: string | null;
  readonly sourceModule: string;
  readonly sourceRefType: string | null;
  readonly sourceRefId: string | null;
  readonly patientId: string | null;
  readonly phi: boolean;
  readonly fileId: string | null;
  readonly renderJobId: string | null;
  readonly format: PrintWireFormat;
  readonly copies: number;
  readonly pages: number | null;
  readonly status: PrintJobStatus;
  readonly priority: number;
  readonly attempts: number;
  readonly error: string | null;
  readonly isReprint: boolean;
  readonly reprintReason: string | null;
}

interface JobQueryRow {
  id: string;
  created_at: Date;
  created_at_text: string;
  hospital_id: string;
  branch_id: string;
  doc_type: string;
  template_key: string | null;
  printer_id: string | null;
  agent_id: string | null;
  requested_by: string | null;
  workstation_id: string | null;
  source_module: string;
  source_ref_type: string | null;
  source_ref_id: string | null;
  patient_id: string | null;
  phi: boolean;
  file_id: string | null;
  render_job_id: string | null;
  format: string;
  copies: number;
  pages: number | null;
  status: string;
  priority: number;
  attempts: number;
  error: string | null;
  is_reprint: boolean;
  reprint_reason: string | null;
  [column: string]: unknown;
}

const JOB_COLUMNS = `
  id, created_at, created_at::text AS created_at_text, hospital_id, branch_id, doc_type, template_key,
  printer_id, agent_id, requested_by, workstation_id, source_module, source_ref_type, source_ref_id,
  patient_id, phi, file_id, render_job_id, format, copies, pages, status, priority, attempts, error,
  is_reprint, reprint_reason
`;

function toRecord(row: JobQueryRow): PrintJobRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    createdAtText: row.created_at_text,
    hospitalId: row.hospital_id,
    branchId: row.branch_id,
    docType: row.doc_type,
    templateKey: row.template_key,
    printerId: row.printer_id,
    agentId: row.agent_id,
    requestedBy: row.requested_by,
    workstationId: row.workstation_id,
    sourceModule: row.source_module,
    sourceRefType: row.source_ref_type,
    sourceRefId: row.source_ref_id,
    patientId: row.patient_id,
    phi: row.phi,
    fileId: row.file_id,
    renderJobId: row.render_job_id,
    format: row.format as PrintWireFormat,
    copies: row.copies,
    pages: row.pages,
    status: row.status as PrintJobStatus,
    priority: row.priority,
    attempts: row.attempts,
    error: row.error,
    isReprint: row.is_reprint,
    reprintReason: row.reprint_reason,
  };
}

export interface CreatePrintJobInput {
  readonly hospitalId: string;
  readonly branchId: string;
  readonly docType: string;
  readonly format: PrintWireFormat;
  readonly templateKey?: string | null;
  readonly printerId?: string | null;
  readonly agentId?: string | null;
  readonly requestedBy?: string | null;
  readonly workstationId?: string | null;
  readonly sourceModule: string;
  readonly sourceRefType?: string | null;
  readonly sourceRefId?: string | null;
  readonly patientId?: string | null;
  readonly phi?: boolean;
  readonly copies?: number;
  /** `docs/07 §4` queue classes: token/receipt printing is `interactive` (2). */
  readonly priority?: number;
  readonly isReprint?: boolean;
  readonly reprintReason?: string | null;
}

export async function createPrintJob(
  client: PoolClient,
  input: CreatePrintJobInput,
): Promise<PrintJobRecord> {
  const { rows } = await client.query<JobQueryRow>(
    `INSERT INTO core.print_jobs
       (id, hospital_id, branch_id, doc_type, template_key, printer_id, agent_id, requested_by,
        workstation_id, source_module, source_ref_type, source_ref_id, patient_id, phi, format,
        copies, priority, is_reprint, reprint_reason, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::core."PrintFormat",
             $16, $17, $18, $19, now())
     RETURNING ${JOB_COLUMNS}`,
    [
      newId(),
      input.hospitalId,
      input.branchId,
      input.docType,
      input.templateKey ?? null,
      input.printerId ?? null,
      input.agentId ?? null,
      input.requestedBy ?? null,
      input.workstationId ?? null,
      input.sourceModule,
      input.sourceRefType ?? null,
      input.sourceRefId ?? null,
      input.patientId ?? null,
      input.phi ?? false,
      input.format,
      input.copies ?? 1,
      input.priority ?? 2,
      input.isReprint ?? false,
      input.reprintReason ?? null,
    ],
  );

  const row = rows[0];
  if (row === undefined) throw new Error('INSERT INTO core.print_jobs returned no row.');
  return toRecord(row);
}

/** Reads a job without locking — status displays and idempotency checks. */
export async function findPrintJob(
  client: PoolClient,
  jobId: string,
  createdAtText: string,
): Promise<PrintJobRecord | null> {
  const { rows } = await client.query<JobQueryRow>(
    `SELECT ${JOB_COLUMNS} FROM core.print_jobs WHERE id = $1 AND created_at = $2::timestamptz`,
    [jobId, createdAtText],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

/**
 * Takes the job for processing.
 *
 * `FOR UPDATE` and not `SKIP LOCKED`: BullMQ has already guaranteed that only
 * one worker holds this job, so a second lock holder means something genuinely
 * wrong (a manual retry racing the queue) and waiting a few milliseconds is the
 * behaviour that keeps a receipt from printing twice.
 */
export async function lockPrintJob(
  client: PoolClient,
  jobId: string,
  createdAtText: string,
): Promise<PrintJobRecord | null> {
  const { rows } = await client.query<JobQueryRow>(
    `SELECT ${JOB_COLUMNS} FROM core.print_jobs
      WHERE id = $1 AND created_at = $2::timestamptz
      FOR UPDATE`,
    [jobId, createdAtText],
  );
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

export interface PrintJobStatusPatch {
  readonly status: PrintJobStatus;
  readonly attempts?: number | undefined;
  readonly error?: string | null | undefined;
  readonly pages?: number | null | undefined;
  readonly printerId?: string | null | undefined;
  readonly agentId?: string | null | undefined;
  readonly completed?: boolean | undefined;
}

/**
 * Writes the outcome back.
 *
 * `error` is truncated rather than trusted: it may be a driver message, and an
 * unbounded string on a row that is written on every retry is how a queue table
 * turns into a disk-full incident.
 */
export async function updatePrintJobStatus(
  client: PoolClient,
  job: PrintJobRecord,
  patch: PrintJobStatusPatch,
): Promise<PrintJobRecord> {
  const { rows } = await client.query<JobQueryRow>(
    `UPDATE core.print_jobs
        SET status       = $3::core."PrintJobStatus",
            attempts     = COALESCE($4, attempts),
            error        = $5,
            pages        = COALESCE($6, pages),
            printer_id   = COALESCE($7, printer_id),
            agent_id     = COALESCE($8, agent_id),
            completed_at = CASE WHEN $9 THEN now() ELSE completed_at END,
            updated_at   = now()
      WHERE id = $1 AND created_at = $2::timestamptz
      RETURNING ${JOB_COLUMNS}`,
    [
      job.id,
      job.createdAtText,
      patch.status,
      patch.attempts ?? null,
      patch.error === undefined ? null : (patch.error?.slice(0, 2000) ?? null),
      patch.pages ?? null,
      patch.printerId ?? null,
      patch.agentId ?? null,
      patch.completed ?? false,
    ],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `Print job ${job.id} disappeared during update — the (id, created_at) partition key did not match any row.`,
    );
  }
  return toRecord(row);
}

/**
 * `EN-005 §5`: "jobs older than 24 h in `queued` auto-cancel with notification".
 *
 * A token slip issued yesterday must never print itself today when the agent
 * reconnects: the patient has gone home and the number has been reissued.
 */
export async function cancelStalePrintJobs(
  client: PoolClient,
  hospitalId: string,
  olderThanHours = 24,
): Promise<readonly PrintJobRecord[]> {
  const { rows } = await client.query<JobQueryRow>(
    `UPDATE core.print_jobs
        SET status = 'cancelled', error = $3, completed_at = now(), updated_at = now()
      WHERE hospital_id = $1
        AND status = 'queued'
        AND created_at < now() - make_interval(hours => $2::int)
      RETURNING ${JOB_COLUMNS}`,
    [hospitalId, olderThanHours, `Auto-cancelled: queued for more than ${olderThanHours} h (EN-005 §5).`],
  );
  return rows.map(toRecord);
}

export interface PrintEventInput {
  readonly hospitalId: string;
  readonly branchId: string | null;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
  readonly correlationId?: string;
  readonly causationId?: string | null;
}

/**
 * Writes a `print.*` domain event to the outbox, **in the caller's transaction**.
 *
 * That is the whole point of the outbox (`docs/01 §4`): the event and the status
 * change it describes commit together or not at all, so there is never a
 * "completed" job with no `print.job.completed` event, nor an event for a job
 * whose transaction rolled back. `services/worker/src/relay/outbox-relay.ts`
 * publishes it afterwards.
 *
 * The type is validated against the registry in `@vims/contracts` and the
 * payload against that entry's schema, so an unregistered event or a renamed
 * field fails here rather than at a consumer that silently never fires.
 */
export async function emitPrintEvent(client: PoolClient, input: PrintEventInput): Promise<string> {
  const definition = assertRegisteredEvent(input.eventType);
  const payload = definition.schema.parse(input.payload);
  const id = newId();

  await client.query(
    `INSERT INTO core.outbox_events
       (id, hospital_id, branch_id, aggregate, aggregate_id, event_type, schema_version, payload,
        contains_phi, actor_type, correlation_id, causation_id, retention_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'system', $10, $11, $12)`,
    [
      id,
      input.hospitalId,
      input.branchId,
      definition.aggregate,
      input.aggregateId,
      definition.type,
      definition.schemaVersion,
      JSON.stringify(payload),
      definition.containsPhi,
      input.correlationId ?? id,
      input.causationId ?? null,
      definition.retentionDays,
    ],
  );

  return id;
}
