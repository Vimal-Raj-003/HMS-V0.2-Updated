/**
 * `integration.lab_instrument_downtime` — the evidence half of exit gate 7.
 *
 * The gate says "analyzer disconnected for 30 minutes → messages buffer and
 * replay with zero loss". A test can assert that; a laboratory cannot re-run the
 * test six months later when an assessor asks. What it can do is read a
 * downtime row, and the CHECK constraint
 * `lab_instrument_downtime_replay_accounts` forces that row to add up:
 *
 *     end_at IS NULL OR replayed_count + lost_count = buffered_count
 *
 * So closing a downtime requires accounting for every buffered frame as either
 * replayed or lost. "Zero loss" then means `lost_count = 0` on a row whose
 * arithmetic the database checked — a claim somebody can verify rather than a
 * sentence in a report.
 *
 * `EN-004 §3.7.2` also wants the uptime KPI off this table, which is why a
 * downtime is opened by the transport (`comm`) and may later be reclassified by
 * a human (`source = 'manual'`, `type = 'breakdown'`) without losing the
 * automatic detection.
 */
import type { TransactionClient } from '../db/database.js';

export type DowntimeType = 'comm' | 'breakdown' | 'pm' | 'reagent' | 'other';

export interface DowntimeRow {
  readonly id: string;
  readonly instrumentId: string;
  readonly type: DowntimeType;
  readonly source: 'auto' | 'manual';
  readonly startAt: Date;
  readonly endAt: Date | null;
  readonly bufferedCount: number;
  readonly replayedCount: number;
  readonly lostCount: number;
  readonly reason: string | null;
}

interface Row {
  id: string;
  instrument_id: string;
  type: DowntimeType;
  source: 'auto' | 'manual';
  start_at: Date;
  end_at: Date | null;
  buffered_count: number;
  replayed_count: number;
  lost_count: number;
  reason: string | null;
}

const SELECT_COLUMNS = `id, instrument_id, type, source, start_at, end_at, buffered_count,
  replayed_count, lost_count, reason`;

function toRow(row: Row): DowntimeRow {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    type: row.type,
    source: row.source,
    startAt: row.start_at,
    endAt: row.end_at,
    bufferedCount: row.buffered_count,
    replayedCount: row.replayed_count,
    lostCount: row.lost_count,
    reason: row.reason,
  };
}

export class LabInstrumentDowntimeLog {
  /** Idempotent: an instrument that flaps must not open six downtime rows. */
  async open(
    tx: TransactionClient,
    input: {
      readonly id: string;
      readonly hospitalId: string;
      readonly branchId: string;
      readonly instrumentId: string;
      readonly type: DowntimeType;
      readonly reason: string;
      readonly at: Date;
    },
  ): Promise<DowntimeRow> {
    const existing = await this.current(tx, input.instrumentId);
    if (existing !== undefined) return existing;

    const row = await tx.one<Row>(
      `INSERT INTO integration.lab_instrument_downtime
         (id, hospital_id, branch_id, instrument_id, type, source, reason, start_at,
          buffered_count, replayed_count, lost_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'auto', $6, $7, 0, 0, 0, $7, $7)
       RETURNING ${SELECT_COLUMNS}`,
      [input.id, input.hospitalId, input.branchId, input.instrumentId, input.type, input.reason, input.at],
    );
    return toRow(row);
  }

  async current(tx: TransactionClient, instrumentId: string): Promise<DowntimeRow | undefined> {
    const rows = await tx.rows<Row>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.lab_instrument_downtime
        WHERE instrument_id = $1 AND end_at IS NULL
        ORDER BY start_at DESC
        LIMIT 1`,
      [instrumentId],
    );
    const row = rows[0];
    return row === undefined ? undefined : toRow(row);
  }

  /** Counts frames buffered during the outage as they are buffered. */
  async recordBuffered(tx: TransactionClient, id: string, delta: number, at: Date): Promise<void> {
    await tx.query(
      `UPDATE integration.lab_instrument_downtime
          SET buffered_count = buffered_count + $2, updated_at = $3
        WHERE id = $1 AND end_at IS NULL`,
      [id, delta, at],
    );
  }

  async recordReplayed(tx: TransactionClient, id: string, delta: number, at: Date): Promise<void> {
    await tx.query(
      `UPDATE integration.lab_instrument_downtime
          SET replayed_count = replayed_count + $2, updated_at = $3
        WHERE id = $1 AND end_at IS NULL`,
      [id, delta, at],
    );
  }

  /**
   * Closes the downtime. The caller supplies `lostCount` explicitly rather than
   * letting it default to zero, because the CHECK makes the arithmetic close
   * either way and a silent zero would be the interface marking its own
   * homework.
   */
  async close(
    tx: TransactionClient,
    id: string,
    input: { readonly at: Date; readonly lostCount: number },
  ): Promise<DowntimeRow | undefined> {
    const rows = await tx.rows<Row>(
      `UPDATE integration.lab_instrument_downtime
          SET end_at = $2,
              lost_count = $3,
              replayed_count = buffered_count - $3,
              updated_at = $2
        WHERE id = $1 AND end_at IS NULL
        RETURNING ${SELECT_COLUMNS}`,
      [id, input.at, input.lostCount],
    );
    const row = rows[0];
    return row === undefined ? undefined : toRow(row);
  }

  async list(tx: TransactionClient, instrumentId: string, limit = 50): Promise<readonly DowntimeRow[]> {
    const rows = await tx.rows<Row>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.lab_instrument_downtime
        WHERE instrument_id = $1
        ORDER BY start_at DESC
        LIMIT $2`,
      [instrumentId, Math.min(limit, 200)],
    );
    return rows.map(toRow);
  }
}
