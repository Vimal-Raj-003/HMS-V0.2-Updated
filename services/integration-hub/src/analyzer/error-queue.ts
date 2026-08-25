/**
 * `integration.lab_if_error_queue` — the unmatched queue.
 *
 * `docs/prompts/phase-03` §Constraints, in full, because everything in this
 * file is a consequence of it: *"Never let a result exist without a patient
 * identity check. Unmatched analyzer results go to a queue, never auto-assigned
 * by name similarity."*
 *
 * So there is no code path here that resolves an item. `assign()` demands an
 * actor and writes it, and the database refuses the alternative:
 * `lab_if_error_queue_assignment_is_human` makes `resolved_sample_id`
 * unsettable without a `resolved_by`. A suggestion may be *computed* and stored
 * in `suggested_sample_id` for an operator to look at; accepting it is a
 * keystroke by a person, recorded as one.
 *
 * The queued item always points at the message, and the message always still
 * holds the frame. That pairing is what makes "reviewable and re-playable once
 * the sample is accessioned" true rather than aspirational: the bytes are
 * there, the parse is repeatable, and the replay goes through the same ingress
 * as a live frame.
 */
import type { TransactionClient } from '../db/database.js';
import type { LabIfErrorType } from './types.js';

export type ErrorQueueStatus = 'open' | 'assigned' | 'rejected' | 'auto_resolved';

export interface ErrorQueueItem {
  readonly id: string;
  readonly hospitalId: string;
  readonly branchId: string;
  readonly instrumentId: string;
  readonly messageId: string | null;
  readonly messageReceivedAt: string | null;
  readonly type: LabIfErrorType;
  readonly sampleIdRaw: string | null;
  readonly instrumentCodeRaw: string | null;
  readonly suggestedSampleId: string | null;
  readonly suggestionBasis: string | null;
  readonly status: ErrorQueueStatus;
  readonly resolvedSampleId: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: Date | null;
  readonly resolution: string | null;
  readonly createdAt: Date;
}

interface ErrorQueueRow {
  id: string;
  hospital_id: string;
  branch_id: string;
  instrument_id: string;
  message_id: string | null;
  message_received_at_text: string | null;
  type: LabIfErrorType;
  sample_id_raw: string | null;
  instrument_code_raw: string | null;
  suggested_sample_id: string | null;
  suggestion_basis: string | null;
  status: ErrorQueueStatus;
  resolved_sample_id: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution: string | null;
  created_at: Date;
}

const SELECT_COLUMNS = `id, hospital_id, branch_id, instrument_id, message_id,
  message_received_at::text AS message_received_at_text, type, sample_id_raw, instrument_code_raw,
  suggested_sample_id, suggestion_basis, status, resolved_sample_id, resolved_by, resolved_at,
  resolution, created_at`;

function toItem(row: ErrorQueueRow): ErrorQueueItem {
  return {
    id: row.id,
    hospitalId: row.hospital_id,
    branchId: row.branch_id,
    instrumentId: row.instrument_id,
    messageId: row.message_id,
    messageReceivedAt: row.message_received_at_text,
    type: row.type,
    sampleIdRaw: row.sample_id_raw,
    instrumentCodeRaw: row.instrument_code_raw,
    suggestedSampleId: row.suggested_sample_id,
    suggestionBasis: row.suggestion_basis,
    status: row.status,
    resolvedSampleId: row.resolved_sample_id,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolution: row.resolution,
    createdAt: row.created_at,
  };
}

export interface RecordErrorInput {
  readonly id: string;
  readonly hospitalId: string;
  readonly branchId: string;
  readonly instrumentId: string;
  readonly messageId: string;
  /** The message's `received_at`, as text. Half of its primary key. */
  readonly messageReceivedAt: string;
  readonly type: LabIfErrorType;
  readonly sampleIdRaw?: string | null;
  readonly instrumentCodeRaw?: string | null;
  /** Computed, never applied. See the note at the top of this file. */
  readonly suggestedSampleId?: string | null;
  readonly suggestionBasis?: string | null;
  readonly at: Date;
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export class LabIfErrorQueue {
  async record(tx: TransactionClient, input: RecordErrorInput): Promise<ErrorQueueItem> {
    const row = await tx.one<ErrorQueueRow>(
      `INSERT INTO integration.lab_if_error_queue
         (id, hospital_id, branch_id, instrument_id, message_id, message_received_at, type,
          sample_id_raw, instrument_code_raw, suggested_sample_id, suggestion_basis,
          status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::integration."LabIfErrorType",
               $8, $9, $10, $11,
               'open', $12, $12)
       RETURNING ${SELECT_COLUMNS}`,
      [
        input.id,
        input.hospitalId,
        input.branchId,
        input.instrumentId,
        input.messageId,
        input.messageReceivedAt,
        input.type,
        input.sampleIdRaw == null ? null : clamp(input.sampleIdRaw, 120),
        input.instrumentCodeRaw == null ? null : clamp(input.instrumentCodeRaw, 64),
        input.suggestedSampleId ?? null,
        input.suggestionBasis == null ? null : clamp(input.suggestionBasis, 120),
        input.at,
      ],
    );
    return toItem(row);
  }

  async get(tx: TransactionClient, id: string): Promise<ErrorQueueItem | undefined> {
    const row = await tx.maybeOne<ErrorQueueRow>(
      `SELECT ${SELECT_COLUMNS} FROM integration.lab_if_error_queue WHERE id = $1`,
      [id],
    );
    return row === undefined ? undefined : toItem(row);
  }

  /** The bench's queue: open and assigned items, oldest first — a work list, not a feed. */
  async list(
    tx: TransactionClient,
    filter: {
      readonly instrumentId?: string;
      readonly status?: ErrorQueueStatus;
      readonly type?: LabIfErrorType;
      readonly sampleIdRaw?: string;
      readonly limit?: number;
    } = {},
  ): Promise<readonly ErrorQueueItem[]> {
    const rows = await tx.rows<ErrorQueueRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.lab_if_error_queue
        WHERE ($1::uuid IS NULL OR instrument_id = $1::uuid)
          AND ($2::text IS NULL OR status = $2::text)
          AND ($3::text IS NULL OR type = $3::integration."LabIfErrorType")
          AND ($4::text IS NULL OR sample_id_raw = $4::text)
        ORDER BY created_at, id
        LIMIT $5`,
      [
        filter.instrumentId ?? null,
        filter.status ?? null,
        filter.type ?? null,
        filter.sampleIdRaw ?? null,
        Math.min(filter.limit ?? 100, 500),
      ],
    );
    return rows.map(toItem);
  }

  /**
   * The one open item for a barcode, if there is one.
   *
   * `EN-004 §3.3.3` has the interface retry the match for 24 hours because the
   * common cause of an unmatched result is a specimen accessioned a few minutes
   * after the analyzer ran it. Finding the existing item is what stops a
   * retrying frame from opening forty queue rows for the same tube.
   */
  async openForSpecimen(
    tx: TransactionClient,
    instrumentId: string,
    sampleIdRaw: string,
  ): Promise<ErrorQueueItem | undefined> {
    const rows = await tx.rows<ErrorQueueRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.lab_if_error_queue
        WHERE instrument_id = $1 AND sample_id_raw = $2 AND status = 'open'
        ORDER BY created_at
        LIMIT 1`,
      [instrumentId, clamp(sampleIdRaw, 120)],
    );
    const row = rows[0];
    return row === undefined ? undefined : toItem(row);
  }

  /**
   * A person attaches the result to a specimen.
   *
   * `resolvedBy` is not optional and is not defaulted. There is no "system"
   * actor here: the moment a result acquires a patient is the moment somebody
   * takes responsibility for it, and the database agrees.
   */
  async assign(
    tx: TransactionClient,
    id: string,
    input: {
      readonly sampleId: string;
      readonly resolvedBy: string;
      readonly resolution: string;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.query(
      `UPDATE integration.lab_if_error_queue
          SET status = 'assigned',
              resolved_sample_id = $2,
              resolved_by = $3,
              resolved_at = $4,
              resolution = $5,
              updated_by = $3,
              updated_at = $4
        WHERE id = $1 AND status IN ('open', 'assigned')`,
      [id, input.sampleId, input.resolvedBy, input.at, input.resolution],
    );
  }

  /** A person decides the result belongs to nobody. Also attributed, also final. */
  async reject(
    tx: TransactionClient,
    id: string,
    input: { readonly resolvedBy: string; readonly resolution: string; readonly at: Date },
  ): Promise<void> {
    await tx.query(
      `UPDATE integration.lab_if_error_queue
          SET status = 'rejected',
              resolved_by = $2,
              resolved_at = $3,
              resolution = $4,
              updated_by = $2,
              updated_at = $3
        WHERE id = $1 AND status IN ('open', 'assigned')`,
      [id, input.resolvedBy, input.at, input.resolution],
    );
  }

  /**
   * The single automatic outcome the schema allows: a duplicate frame whose
   * content digest matches one already applied. No judgement was exercised, so
   * no name is recorded — and `auto_resolved` is the only status the CHECK
   * exempts from attribution for exactly that reason.
   */
  async autoResolve(tx: TransactionClient, id: string, at: Date): Promise<void> {
    await tx.query(
      `UPDATE integration.lab_if_error_queue
          SET status = 'auto_resolved', updated_at = $2
        WHERE id = $1 AND status = 'open'`,
      [id, at],
    );
  }

  async countOpen(tx: TransactionClient, instrumentId?: string): Promise<number> {
    const row = await tx.one<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM integration.lab_if_error_queue
        WHERE status IN ('open', 'assigned')
          AND ($1::uuid IS NULL OR instrument_id = $1::uuid)`,
      [instrumentId ?? null],
    );
    return Number(row.count);
  }
}
