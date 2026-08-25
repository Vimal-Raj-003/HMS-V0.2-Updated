/**
 * `integration.lab_if_messages` — every frame, in both directions, and the
 * store-and-forward buffer that exit gate 7 is about.
 *
 * ── The status ladder, stated once ──────────────────────────────────────────
 *
 *  * `buffered`  durably stored and acknowledged to the analyzer, **not yet
 *                delivered to the laboratory**. This is the store-and-forward
 *                state, and `idx_lab_if_messages_buffered` exists for exactly
 *                the query that drains it.
 *  * `applied`   the laboratory accepted it. Terminal for an inbound message.
 *  * `error`     a human must decide (unmatched barcode, unmapped code,
 *                identity mismatch, rejected specimen, result after final).
 *                Retained with `error_text`, paired with an `lab_if_error_queue`
 *                row. Terminal until somebody resolves it.
 *  * `nak`       we refused the frame — it did not parse, or its checksum
 *                failed. Retained; the analyzer will resend.
 *  * `acked`     an **outbound** message the analyzer acknowledged.
 *  * `replayed`  superseded: a later row carries `replayed_from_id` pointing
 *                here. The original is never rewritten, because
 *                `lab_if_messages` is the evidence a disputed result is traced
 *                through (`EN-004 §5`).
 *
 * ── Two things this file must get right ─────────────────────────────────────
 *
 * **`received_at` is half the primary key.** The table is partitioned monthly
 * on a `timestamptz(3)`, so every later statement carries the timestamp as the
 * text the INSERT returned — never a round-tripped `Date`. D-31 in
 * `docs/PROGRESS.md` is the bug this avoids: an UPDATE that matches zero rows
 * is not an error, so the failure is silent.
 *
 * **`parsed` never holds PHI.** `raw` is the frame, retained 90 days under the
 * `integration.lab.raw.read` gate; `parsed` is the searchable projection kept
 * for two years and is written through `redactPayload`, exactly as
 * `ihub_messages.payload_redacted` is. There is no code path here that writes
 * an unredacted object into `parsed`.
 */
import { createHash } from 'node:crypto';
import type { TransactionClient } from '../db/database.js';
import { redactPayload, redactText, type JsonValue } from '../redaction/phi-redactor.js';
import type { LabIfDirection, LabIfMessageStatus } from './types.js';

export interface LabIfMessageHandle {
  readonly id: string;
  /** `received_at` as text, exactly as stored. The other half of the key. */
  readonly receivedAt: string;
}

export interface PersistMessageInput {
  readonly id: string;
  readonly hospitalId: string;
  readonly branchId: string;
  readonly instrumentId: string;
  readonly direction: LabIfDirection;
  readonly msgType: string;
  readonly controlId: string;
  readonly sampleIdRaw?: string | null;
  /** The frame exactly as it arrived, or exactly as it will be sent. */
  readonly raw: Buffer;
  /** Redacted here; the caller passes the canonical object, never a redacted one. */
  readonly parsed: unknown;
  readonly status: LabIfMessageStatus;
  readonly errorCode?: string | null;
  readonly errorText?: string | null;
  readonly replayedFromId?: string | null;
  readonly receivedAt: Date;
}

export interface LabIfMessageRow {
  id: string;
  received_at_text: string;
  hospital_id: string;
  branch_id: string;
  instrument_id: string;
  direction: LabIfDirection;
  msg_type: string;
  control_id: string | null;
  sample_id: string | null;
  sample_id_raw: string | null;
  raw: Buffer | null;
  parsed: JsonValue | null;
  status: LabIfMessageStatus;
  error_code: string | null;
  error_text: string | null;
  content_sha256: string | null;
  attempts: number;
  replayed_from_id: string | null;
  raw_purged_at: Date | null;
}

const SELECT_COLUMNS = `id, received_at::text AS received_at_text, hospital_id, branch_id, instrument_id,
  direction, msg_type, control_id, sample_id, sample_id_raw, raw, parsed, status, error_code,
  error_text, content_sha256, attempts, replayed_from_id, raw_purged_at`;

/** `varchar(16)` on `msg_type`; a longer type name is truncated rather than refused. */
function clamp(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

export function contentDigest(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}

export class LabIfMessageStore {
  /**
   * Inserts the frame. **This is the write that must complete before an
   * acknowledgement is sent**, and it is a single statement in a single
   * transaction so that "stored" and "acknowledged" cannot be reordered by a
   * later refactor without deleting this comment.
   */
  async persist(tx: TransactionClient, input: PersistMessageInput): Promise<LabIfMessageHandle> {
    const redaction = redactPayload(input.parsed);
    const errorText = input.errorText == null ? null : redactText(input.errorText).payload;

    const row = await tx.one<{ id: string; received_at_text: string }>(
      `INSERT INTO integration.lab_if_messages
         (id, hospital_id, branch_id, instrument_id, direction, msg_type, control_id,
          sample_id_raw, raw, parsed, status, error_code, error_text, content_sha256,
          attempts, replayed_from_id, received_at)
       VALUES ($1, $2, $3, $4, $5::integration."LabIfDirection", $6, $7,
               $8, $9, $10::jsonb, $11::integration."LabIfMessageStatus", $12, $13, $14,
               0, $15, $16)
       RETURNING id, received_at::text AS received_at_text`,
      [
        input.id,
        input.hospitalId,
        input.branchId,
        input.instrumentId,
        input.direction,
        clamp(input.msgType, 16),
        clamp(input.controlId, 64),
        input.sampleIdRaw == null ? null : clamp(input.sampleIdRaw, 120),
        input.raw,
        JSON.stringify(redaction.payload),
        input.status,
        input.errorCode == null ? null : clamp(input.errorCode, 64),
        errorText,
        contentDigest(input.raw),
        input.replayedFromId ?? null,
        input.receivedAt,
      ],
    );
    return { id: row.id, receivedAt: row.received_at_text };
  }

  /**
   * `EN-004 §5`: "Idempotency: inbound message hash + control id."
   *
   * The partial unique index on the table cannot do this on its own — a
   * partitioned table's unique index has to include the partition key, so
   * `received_at` is in it, and a frame replayed a minute later lands in a
   * different row without conflicting. The index makes this lookup free; the
   * lookup is what makes the replay idempotent, and removing it is exactly how
   * a reconnecting analyzer puts a second copy of every result on the bench.
   */
  async findDuplicate(
    tx: TransactionClient,
    key: {
      readonly hospitalId: string;
      readonly instrumentId: string;
      readonly direction: LabIfDirection;
      readonly controlId: string;
      readonly contentSha256: string;
    },
  ): Promise<LabIfMessageRow | undefined> {
    const rows = await tx.rows<LabIfMessageRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.lab_if_messages
        WHERE hospital_id = $1
          AND instrument_id = $2
          AND direction = $3::integration."LabIfDirection"
          AND control_id = $4
          AND content_sha256 = $5
        ORDER BY received_at DESC
        LIMIT 1`,
      [key.hospitalId, key.instrumentId, key.direction, clamp(key.controlId, 64), key.contentSha256],
    );
    return rows[0];
  }

  /**
   * The drain query: buffered frames for one instrument, **oldest first**.
   *
   * Ordering is the point. An analyzer that sends a preliminary result and then
   * its correction must have them applied in that order, or the report carries
   * the preliminary value. `(received_at, id)` is total because `id` is a
   * time-ordered UUIDv7, so two frames in the same millisecond still have a
   * defined order.
   */
  async claimBuffered(
    tx: TransactionClient,
    instrumentId: string,
    limit = 100,
  ): Promise<readonly LabIfMessageRow[]> {
    return tx.rows<LabIfMessageRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.lab_if_messages
        WHERE instrument_id = $1
          AND direction = 'inbound'::integration."LabIfDirection"
          AND status = 'buffered'::integration."LabIfMessageStatus"
        ORDER BY received_at, id
        LIMIT $2`,
      [instrumentId, Math.min(limit, 500)],
    );
  }

  /** Outbound orders waiting for a link. Same ordering rule, same reason. */
  async claimOutbound(
    tx: TransactionClient,
    instrumentId: string,
    limit = 100,
  ): Promise<readonly LabIfMessageRow[]> {
    return tx.rows<LabIfMessageRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.lab_if_messages
        WHERE instrument_id = $1
          AND direction = 'outbound'::integration."LabIfDirection"
          AND status = 'buffered'::integration."LabIfMessageStatus"
        ORDER BY received_at, id
        LIMIT $2`,
      [instrumentId, Math.min(limit, 500)],
    );
  }

  async countBuffered(tx: TransactionClient, instrumentId: string): Promise<number> {
    const row = await tx.one<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM integration.lab_if_messages
        WHERE instrument_id = $1
          AND status = 'buffered'::integration."LabIfMessageStatus"`,
      [instrumentId],
    );
    return Number(row.count);
  }

  async get(tx: TransactionClient, id: string): Promise<LabIfMessageRow | undefined> {
    const rows = await tx.rows<LabIfMessageRow>(
      `SELECT ${SELECT_COLUMNS} FROM integration.lab_if_messages WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0];
  }

  /** Applied, matched, or acknowledged by the peer. Records the resolved sample. */
  async settle(
    tx: TransactionClient,
    handle: LabIfMessageHandle,
    input: {
      readonly status: Extract<LabIfMessageStatus, 'applied' | 'matched' | 'acked' | 'parsed'>;
      readonly sampleId?: string | null;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.query(
      `UPDATE integration.lab_if_messages
          SET status = $3::integration."LabIfMessageStatus",
              sample_id = COALESCE($4, sample_id),
              error_code = NULL,
              error_text = NULL,
              attempts = attempts + 1,
              processed_at = $5
        WHERE id = $1 AND received_at = $2::timestamptz`,
      [handle.id, handle.receivedAt, input.status, input.sampleId ?? null, input.at],
    );
  }

  /**
   * A terminal problem a human owns. `error_text` is mandatory by CHECK, and it
   * goes through the redactor because a parser's complaint routinely quotes the
   * field it choked on.
   */
  async fail(
    tx: TransactionClient,
    handle: LabIfMessageHandle,
    input: {
      readonly status: Extract<LabIfMessageStatus, 'error' | 'nak'>;
      readonly errorCode: string;
      readonly errorText: string;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.query(
      `UPDATE integration.lab_if_messages
          SET status = $3::integration."LabIfMessageStatus",
              error_code = $4,
              error_text = $5,
              attempts = attempts + 1,
              processed_at = $6
        WHERE id = $1 AND received_at = $2::timestamptz`,
      [
        handle.id,
        handle.receivedAt,
        input.status,
        clamp(input.errorCode, 64),
        redactText(input.errorText).payload,
        input.at,
      ],
    );
  }

  /**
   * A transient failure: the laboratory could not be reached.
   *
   * The row stays `buffered` — only the attempt counter moves — because the
   * whole promise of exit gate 7 is that a message survives the outage that
   * prevented its delivery.
   */
  async deferred(tx: TransactionClient, handle: LabIfMessageHandle, reason: string): Promise<void> {
    await tx.query(
      `UPDATE integration.lab_if_messages
          SET attempts = attempts + 1,
              error_code = 'downstream_unavailable',
              error_text = $3
        WHERE id = $1 AND received_at = $2::timestamptz`,
      [handle.id, handle.receivedAt, redactText(reason).payload],
    );
  }

  /** The original of a replay. Never rewritten, only marked. */
  async markReplayed(tx: TransactionClient, handle: LabIfMessageHandle, at: Date): Promise<void> {
    await tx.query(
      `UPDATE integration.lab_if_messages
          SET status = 'replayed'::integration."LabIfMessageStatus", processed_at = $3
        WHERE id = $1 AND received_at = $2::timestamptz`,
      [handle.id, handle.receivedAt, at],
    );
  }

  /** The message log screen (`EN-004 §8`), newest first, keyset-paged. */
  async list(
    tx: TransactionClient,
    filter: {
      readonly instrumentId?: string;
      readonly status?: LabIfMessageStatus;
      readonly sampleIdRaw?: string;
      readonly before?: string;
      readonly limit?: number;
    } = {},
  ): Promise<readonly LabIfMessageRow[]> {
    return tx.rows<LabIfMessageRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.lab_if_messages
        WHERE ($1::uuid IS NULL OR instrument_id = $1::uuid)
          AND ($2::text IS NULL OR status = $2::integration."LabIfMessageStatus")
          AND ($3::text IS NULL OR sample_id_raw = $3::text)
          AND ($4::text IS NULL OR received_at < $4::timestamptz)
        ORDER BY received_at DESC, id DESC
        LIMIT $5`,
      [
        filter.instrumentId ?? null,
        filter.status ?? null,
        filter.sampleIdRaw ?? null,
        filter.before ?? null,
        Math.min(filter.limit ?? 50, 500),
      ],
    );
  }
}
