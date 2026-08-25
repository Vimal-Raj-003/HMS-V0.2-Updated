/**
 * `integration.lab_if_worklist_cache` — what a host-query analyzer is answered
 * from.
 *
 * `EN-004 §14.2` puts a hard two-second budget on the reply, because the
 * analyzer times out and aspirates the tube without the order. That budget is
 * the entire reason this table exists: the reply is one indexed read of a row
 * OP-004 wrote when the specimen was accessioned, not a live query across the
 * order, the panel and the test master.
 *
 * ── What is deliberately not cached ─────────────────────────────────────────
 *
 * Patient demographics. `EN-004 §3.2.1` allows an order to carry
 * "patient id/name/sex/DOB (as configured)", and some analyzers print the name
 * on the run log — but `payload` here is plain JSONB with no encryption and a
 * `hms_retention` DELETE grant, which is not somewhere `docs/04` §5 permits a
 * name to sit. The cached payload therefore carries the specimen identifier,
 * the tests, the priority and the container, and nothing that identifies a
 * person. An instrument that genuinely needs demographics has to be fed them on
 * the order-send path, where the payload store's encryption applies. This is a
 * deliberate narrowing of the spec, not an omission.
 */
import type { TransactionClient } from '../db/database.js';
import type { AnalyzerOrder, AnalyzerOrderTest } from './canonical.js';

/** The cached order. Structurally an `AnalyzerOrder` minus the patient block. */
export interface CachedOrder {
  readonly specimenId: string;
  readonly accessionNo?: string;
  readonly priority: 'stat' | 'routine';
  readonly collectedAt?: string;
  readonly specimenTypeCode?: string;
  readonly containerCode?: string;
  readonly tests: readonly AnalyzerOrderTest[];
  readonly isRerun?: boolean;
}

export interface WorklistEntry {
  readonly id: string;
  readonly instrumentId: string;
  readonly sampleId: string;
  readonly barcode: string;
  readonly order: CachedOrder;
  readonly sentAt: Date | null;
  readonly ackedAt: Date | null;
  readonly expiresAt: Date;
}

interface WorklistRow {
  id: string;
  instrument_id: string;
  sample_id: string;
  barcode: string;
  payload: unknown;
  sent_at: Date | null;
  acked_at: Date | null;
  expires_at: Date;
}

const SELECT_COLUMNS = `id, instrument_id, sample_id, barcode, payload, sent_at, acked_at, expires_at`;

function toOrder(payload: unknown, barcode: string): CachedOrder {
  if (payload === null || typeof payload !== 'object') {
    return { specimenId: barcode, priority: 'routine', tests: [] };
  }
  const source = payload as Partial<CachedOrder>;
  const rawTests: readonly unknown[] = Array.isArray(source.tests) ? source.tests : [];
  const tests = rawTests.filter((test): test is AnalyzerOrderTest => {
    if (typeof test !== 'object' || test === null) return false;
    return typeof (test as { instrumentCode?: unknown }).instrumentCode === 'string';
  });
  return {
    specimenId: typeof source.specimenId === 'string' ? source.specimenId : barcode,
    ...(typeof source.accessionNo === 'string' ? { accessionNo: source.accessionNo } : {}),
    priority: source.priority === 'stat' ? 'stat' : 'routine',
    ...(typeof source.collectedAt === 'string' ? { collectedAt: source.collectedAt } : {}),
    ...(typeof source.specimenTypeCode === 'string' ? { specimenTypeCode: source.specimenTypeCode } : {}),
    ...(typeof source.containerCode === 'string' ? { containerCode: source.containerCode } : {}),
    tests,
    ...(source.isRerun === true ? { isRerun: true } : {}),
  };
}

function toEntry(row: WorklistRow): WorklistEntry {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    sampleId: row.sample_id,
    barcode: row.barcode,
    order: toOrder(row.payload, row.barcode),
    sentAt: row.sent_at,
    ackedAt: row.acked_at,
    expiresAt: row.expires_at,
  };
}

/** The cached order as the drivers want it: an `AnalyzerOrder` with no patient. */
export function toAnalyzerOrder(entry: WorklistEntry): AnalyzerOrder {
  const collectedAt = entry.order.collectedAt === undefined ? undefined : new Date(entry.order.collectedAt);
  return {
    specimenId: entry.order.specimenId,
    ...(entry.order.accessionNo === undefined ? {} : { accessionNo: entry.order.accessionNo }),
    priority: entry.order.priority,
    ...(collectedAt === undefined || Number.isNaN(collectedAt.getTime()) ? {} : { collectedAt }),
    ...(entry.order.specimenTypeCode === undefined ? {} : { specimenTypeCode: entry.order.specimenTypeCode }),
    ...(entry.order.containerCode === undefined ? {} : { containerCode: entry.order.containerCode }),
    tests: entry.order.tests,
    action: 'new',
    isRerun: entry.order.isRerun === true,
  };
}

export class LabIfWorklistCache {
  /** Upserted on `(instrument_id, sample_id)`: an add-on test replaces the entry. */
  async put(
    tx: TransactionClient,
    input: {
      readonly id: string;
      readonly hospitalId: string;
      readonly instrumentId: string;
      readonly sampleId: string;
      readonly barcode: string;
      readonly order: CachedOrder;
      readonly expiresAt: Date;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO integration.lab_if_worklist_cache
         (id, hospital_id, instrument_id, sample_id, barcode, payload, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (instrument_id, sample_id) DO UPDATE SET
         barcode    = EXCLUDED.barcode,
         payload    = EXCLUDED.payload,
         expires_at = EXCLUDED.expires_at,
         sent_at    = NULL,
         acked_at   = NULL`,
      [
        input.id,
        input.hospitalId,
        input.instrumentId,
        input.sampleId,
        input.barcode.slice(0, 64),
        JSON.stringify(input.order),
        input.expiresAt,
        input.at,
      ],
    );
  }

  /** The host-query lookup. Expired entries are invisible rather than deleted. */
  async byBarcode(
    tx: TransactionClient,
    instrumentId: string,
    barcode: string,
    now: Date,
  ): Promise<readonly WorklistEntry[]> {
    const rows = await tx.rows<WorklistRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.lab_if_worklist_cache
        WHERE instrument_id = $1 AND barcode = $2 AND expires_at > $3
        ORDER BY created_at`,
      [instrumentId, barcode.slice(0, 64), now],
    );
    return rows.map(toEntry);
  }

  /** The wildcard query ("send me everything pending"), capped. */
  async pending(
    tx: TransactionClient,
    instrumentId: string,
    now: Date,
    limit = 50,
  ): Promise<readonly WorklistEntry[]> {
    const rows = await tx.rows<WorklistRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM integration.lab_if_worklist_cache
        WHERE instrument_id = $1 AND expires_at > $2 AND acked_at IS NULL
        ORDER BY created_at
        LIMIT $3`,
      [instrumentId, now, Math.min(limit, 200)],
    );
    return rows.map(toEntry);
  }

  async markSent(tx: TransactionClient, ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await tx.query(`UPDATE integration.lab_if_worklist_cache SET sent_at = $2 WHERE id = ANY($1::uuid[])`, [
      [...ids],
      at,
    ]);
  }

  async markAcked(tx: TransactionClient, ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) return;
    await tx.query(`UPDATE integration.lab_if_worklist_cache SET acked_at = $2 WHERE id = ANY($1::uuid[])`, [
      [...ids],
      at,
    ]);
  }
}
