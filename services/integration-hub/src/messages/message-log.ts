/**
 * EN-017 §4 — the message log, in `integration.ihub_messages`.
 *
 * Three properties of this table shape every method below:
 *
 *  1. **It is append-only.** `REVOKE DELETE ON integration.ihub_messages FROM
 *     hms_app` — only `hms_retention` may remove anything, and only by detaching
 *     a whole month. EN-017 §5: "status transitions are recorded, never
 *     overwritten by deletion." So a replay creates a *new* row pointing at its
 *     parent rather than resetting the old one.
 *  2. **The primary key is `(id, created_at)`.** It is partitioned monthly, so
 *     every update must carry the timestamp too. `created_at` is
 *     `timestamptz(6)` and a JS `Date` holds only milliseconds — the exact bug
 *     that made the outbox relay redeliver forever (`docs/PROGRESS.md`) — so the
 *     insert returns `created_at::text` and every later statement uses that
 *     text, never a round-tripped `Date`.
 *  3. **Only the redacted copy is stored here.** `payload_redacted` is written
 *     from `redactPayload`; the full body goes to the `PayloadStore` and only
 *     its reference is recorded. There is no code path that writes a raw payload
 *     into this table.
 */
import type { TransactionClient } from '../db/database.js';
import { redactPayload, redactText, type JsonValue } from '../redaction/phi-redactor.js';
import type { ConnectorDirection } from '../config/connector-config.js';

export type MessageStatus =
  | 'queued'
  | 'in_flight'
  | 'sent'
  | 'acknowledged'
  | 'failed'
  | 'dead_lettered'
  | 'blocked'
  | 'discarded'
  | 'replayed';

export interface MessageHandle {
  readonly id: string;
  /** `created_at` as text, exactly as stored. Half of the primary key. */
  readonly createdAt: string;
}

export interface RecordMessageInput {
  readonly id: string;
  readonly hospitalId: string;
  readonly branchId?: string | null;
  readonly connectorId: string;
  readonly connectorVersion: number;
  readonly operationId: string | null;
  readonly direction: ConnectorDirection;
  readonly correlationId: string;
  readonly parentMessageId?: string | null;
  readonly refType?: string | null;
  readonly refId?: string | null;
  readonly idempotencyKey?: string | null;
  readonly partitionKey?: string | null;
  readonly priority?: number;
  readonly status: MessageStatus;
  readonly attempts: number;
  /** The *raw* payload. Redacted here; never stored as given. */
  readonly payload: unknown;
  readonly payloadRef?: string | null;
  readonly createdAt: Date;
}

export interface MessageRow {
  id: string;
  created_at_text: string;
  hospital_id: string;
  connector_id: string;
  connector_version: number;
  operation_id: string | null;
  direction: ConnectorDirection;
  correlation_id: string;
  parent_message_id: string | null;
  idempotency_key: string | null;
  partition_key: string | null;
  status: MessageStatus;
  attempts: number;
  next_attempt_at: Date | null;
  latency_ms: number | null;
  http_status: number | null;
  ack_code: string | null;
  error_class: string | null;
  error_code: string | null;
  error_text: string | null;
  payload_redacted: JsonValue;
  payload_ref: string | null;
  response_redacted: JsonValue | null;
  size_bytes: number | null;
  contains_phi: boolean;
}

const SELECT_COLUMNS = `id, created_at::text AS created_at_text, hospital_id, connector_id,
  connector_version, operation_id, direction, correlation_id, parent_message_id,
  idempotency_key, partition_key, status, attempts, next_attempt_at, latency_ms,
  http_status, ack_code, error_class, error_code, error_text, payload_redacted,
  payload_ref, response_redacted, size_bytes, contains_phi`;

export interface CompletionInput {
  readonly status: Extract<MessageStatus, 'sent' | 'acknowledged'>;
  readonly latencyMs: number;
  readonly httpStatus?: number | undefined;
  readonly ackCode?: string | undefined;
  readonly response?: unknown;
  readonly completedAt: Date;
}

export interface FailureInput {
  readonly status: Extract<MessageStatus, 'failed' | 'dead_lettered' | 'discarded'>;
  readonly latencyMs: number;
  readonly errorClass: string;
  readonly errorCode?: string | undefined;
  readonly errorText?: string | undefined;
  readonly httpStatus?: number | undefined;
  readonly nextAttemptAt?: Date | null;
  readonly completedAt: Date | null;
}

export class MessageLog {
  /** Inserts the row and returns its composite key. Redaction happens here, once. */
  async record(tx: TransactionClient, input: RecordMessageInput): Promise<MessageHandle> {
    const redaction = redactPayload(input.payload);

    const row = await tx.one<{ id: string; created_at_text: string }>(
      `INSERT INTO integration.ihub_messages
         (id, hospital_id, branch_id, connector_id, connector_version, operation_id,
          direction, correlation_id, parent_message_id, ref_type, ref_id,
          idempotency_key, partition_key, priority, status, attempts,
          payload_redacted, payload_ref, size_bytes, contains_phi,
          created_at, sent_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6,
               $7::integration."IhubDirection", $8, $9, $10, $11,
               $12, $13, $14, $15::integration."IhubMessageStatus", $16,
               $17::jsonb, $18, $19, $20,
               $21, $22, $21)
       RETURNING id, created_at::text AS created_at_text`,
      [
        input.id,
        input.hospitalId,
        input.branchId ?? null,
        input.connectorId,
        input.connectorVersion,
        input.operationId,
        input.direction,
        input.correlationId,
        input.parentMessageId ?? null,
        input.refType ?? null,
        input.refId ?? null,
        input.idempotencyKey ?? null,
        input.partitionKey ?? null,
        input.priority ?? 5,
        input.status,
        input.attempts,
        JSON.stringify(redaction.payload),
        input.payloadRef ?? null,
        redaction.sizeBytes,
        redaction.containsPhi,
        input.createdAt,
        input.status === 'in_flight' ? input.createdAt : null,
      ],
    );
    return { id: row.id, createdAt: row.created_at_text };
  }

  async markInFlight(tx: TransactionClient, handle: MessageHandle, at: Date): Promise<void> {
    await tx.query(
      `UPDATE integration.ihub_messages
          SET status = 'in_flight'::integration."IhubMessageStatus",
              attempts = attempts + 1,
              sent_at = COALESCE(sent_at, $3),
              next_attempt_at = NULL,
              updated_at = $3
        WHERE id = $1 AND created_at = $2::timestamptz`,
      [handle.id, handle.createdAt, at],
    );
  }

  async complete(tx: TransactionClient, handle: MessageHandle, input: CompletionInput): Promise<void> {
    const response = input.response === undefined ? null : JSON.stringify(redactPayload(input.response).payload);
    await tx.query(
      `UPDATE integration.ihub_messages
          SET status = $3::integration."IhubMessageStatus",
              latency_ms = $4,
              http_status = $5,
              ack_code = $6,
              response_redacted = $7::jsonb,
              error_class = NULL, error_code = NULL, error_text = NULL,
              next_attempt_at = NULL,
              completed_at = $8,
              updated_at = $8
        WHERE id = $1 AND created_at = $2::timestamptz`,
      [
        handle.id,
        handle.createdAt,
        input.status,
        input.latencyMs,
        input.httpStatus ?? null,
        input.ackCode ?? null,
        response,
        input.completedAt,
      ],
    );
  }

  async fail(tx: TransactionClient, handle: MessageHandle, input: FailureInput): Promise<void> {
    // A partner's error body routinely quotes the request back, so the error
    // text is redacted exactly like a payload. `docs/04` §2: no PHI in error
    // messages, and `error_text` is the column most likely to be pasted into a
    // ticket.
    const errorText = input.errorText === undefined ? null : redactText(input.errorText).payload;
    await tx.query(
      `UPDATE integration.ihub_messages
          SET status = $3::integration."IhubMessageStatus",
              latency_ms = $4,
              error_class = $5,
              error_code = $6,
              error_text = $7,
              http_status = $8,
              next_attempt_at = $9,
              completed_at = $10,
              updated_at = COALESCE($10, now())
        WHERE id = $1 AND created_at = $2::timestamptz`,
      [
        handle.id,
        handle.createdAt,
        input.status,
        input.latencyMs,
        input.errorClass,
        input.errorCode ?? null,
        errorText,
        input.httpStatus ?? null,
        input.nextAttemptAt ?? null,
        input.completedAt,
      ],
    );
  }

  /** EN-017 §3.6: the original is marked replayed; the retry is a new row. */
  async markReplayed(tx: TransactionClient, handle: MessageHandle, at: Date): Promise<void> {
    await tx.query(
      `UPDATE integration.ihub_messages
          SET status = 'replayed'::integration."IhubMessageStatus", updated_at = $3
        WHERE id = $1 AND created_at = $2::timestamptz`,
      [handle.id, handle.createdAt, at],
    );
  }

  async get(tx: TransactionClient, id: string): Promise<MessageRow | undefined> {
    return tx.maybeOne<MessageRow>(
      `SELECT ${SELECT_COLUMNS} FROM integration.ihub_messages WHERE id = $1`,
      [id],
    );
  }

  /**
   * EN-017 §5 idempotency: "duplicate dispatch within the retention window
   * returns the original message id rather than sending twice."
   */
  async findByIdempotencyKey(
    tx: TransactionClient,
    connectorId: string,
    idempotencyKey: string,
  ): Promise<MessageRow | undefined> {
    const rows = await tx.rows<MessageRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.ihub_messages
        WHERE connector_id = $1
          AND idempotency_key = $2
          AND status <> 'replayed'::integration."IhubMessageStatus"
        ORDER BY created_at DESC
        LIMIT 1`,
      [connectorId, idempotencyKey],
    );
    return rows[0];
  }

  /**
   * Cursor-paged, newest first. `docs/07` §4 bans OFFSET, and the index
   * `(hospital_id, connector_id, created_at DESC)` is what makes the keyset
   * form free.
   */
  async list(
    tx: TransactionClient,
    filter: {
      readonly connectorId?: string;
      readonly status?: MessageStatus;
      readonly before?: string;
      readonly limit?: number;
    } = {},
  ): Promise<readonly MessageRow[]> {
    const limit = Math.min(filter.limit ?? 50, 500);
    return tx.rows<MessageRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.ihub_messages
        WHERE ($1::uuid IS NULL OR connector_id = $1::uuid)
          AND ($2::text IS NULL OR status = $2::integration."IhubMessageStatus")
          AND ($3::text IS NULL OR created_at < $3::timestamptz)
        ORDER BY created_at DESC
        LIMIT $4`,
      [filter.connectorId ?? null, filter.status ?? null, filter.before ?? null, limit],
    );
  }
}
