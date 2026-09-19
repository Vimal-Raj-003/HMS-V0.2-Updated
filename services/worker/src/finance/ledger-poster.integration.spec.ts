import { newId } from '@vims/contracts';
import { runSeed } from '@vims/db/seed';
import { startTestPostgres, type TestPostgres } from '@vims/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postLedgerEntries } from './ledger-poster.js';

/**
 * NC-009 §3.2 — money events becoming journals.
 *
 * The assertions are the ones that decide whether a controller can trust the
 * ledger: that a bill posts its tax to the right three accounts and its income
 * net of them, that a zero component is left out rather than posted as a zero
 * line, that re-running posts nothing, and that an event the rules cannot value
 * is reported rather than quietly posted as nought.
 */

let pg: TestPostgres;
let hospitalId = '';
let branchId = '';

beforeAll(async () => {
  pg = await startTestPostgres();
  process.env['DATABASE_MIGRATE_URL'] = pg.connectionString('migrator');
  await runSeed(pg.pool('migrator'), 'demo');

  const pool = pg.pool('migrator');
  hospitalId = (await pool.query<{ id: string }>(`SELECT id FROM core.hospitals WHERE code = 'VIMS-BLR'`))
    .rows[0]!.id;
  branchId = (
    await pool.query<{ id: string }>(`SELECT id FROM core.branches WHERE hospital_id = $1 LIMIT 1`, [
      hospitalId,
    ])
  ).rows[0]!.id;
}, 300_000);

afterAll(async () => {
  await pg?.stop();
});

/** Puts one event on the outbox, the way the module that owns it would. */
async function emit(eventType: string, payload: Record<string, unknown>): Promise<string> {
  const id = newId();
  await pg.pool('migrator').query(
    `INSERT INTO core.outbox_events
       (id, hospital_id, branch_id, aggregate, aggregate_id, aggregate_version,
        event_type, schema_version, payload, contains_phi, actor_type,
        correlation_id, occurred_at)
     VALUES ($1,$2,$3,'test',$4,1,$5,1,$6::jsonb,false,'system',$7, now())`,
    // One placeholder per column even where the value repeats: `id` is uuid
    // while `aggregate_id` and `correlation_id` are text, and Postgres deduces
    // a single type per parameter.
    [id, hospitalId, branchId, id, eventType, JSON.stringify(payload), id],
  );
  return id;
}

describe('the ledger poster', () => {
  it('splits a taxed bill into income and the three GST accounts', async () => {
    const eventId = await emit('bill.finalized', {
      billId: newId(),
      billNo: 'TEST/001',
      netAmount: '693.00',
      taxableAmount: '100.00',
      cgst: '9.00',
      sgst: '9.00',
      igst: '0.00',
      patientId: null,
      payerType: 'self',
      finalizedBy: null,
    });

    const result = await postLedgerEntries(pg.pool('migrator'));
    expect(result.problems).toEqual([]);
    expect(result.posted).toBeGreaterThanOrEqual(1);

    const lines = await pg.pool('migrator').query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, l.debit::text, l.credit::text
         FROM finance.journals j
         JOIN finance.journal_lines l ON l.journal_id = j.id
         JOIN finance.accounts a ON a.id = l.account_id
        WHERE j.source_ref_id = $1 ORDER BY l.line_no`,
      [eventId],
    );
    const by = new Map(lines.rows.map((r) => [r.code, r]));

    expect(by.get('1200')?.debit).toBe('693.00');
    // Income is net of tax, not `taxableAmount`: most clinical services are
    // GST-exempt, so crediting the taxable portion would book 100 on a 693 bill.
    expect(by.get('4900')?.credit).toBe('675.00');
    expect(by.get('2300')?.credit).toBe('9.00');
    expect(by.get('2301')?.credit).toBe('9.00');
    // Zero IGST is left out entirely, not posted as a zero line.
    expect(by.has('2302')).toBe(false);
  });

  it('posts an exempt bill as a clean two-line entry', async () => {
    const eventId = await emit('bill.finalized', {
      billId: newId(),
      billNo: 'TEST/002',
      netAmount: '500.00',
      taxableAmount: '0.00',
      cgst: '0.00',
      sgst: '0.00',
      igst: '0.00',
      patientId: null,
      payerType: 'self',
      finalizedBy: null,
    });
    const result = await postLedgerEntries(pg.pool('migrator'));
    expect(result.problems).toEqual([]);

    const lines = await pg.pool('migrator').query<{ code: string }>(
      `SELECT a.code FROM finance.journals j
         JOIN finance.journal_lines l ON l.journal_id = j.id
         JOIN finance.accounts a ON a.id = l.account_id
        WHERE j.source_ref_id = $1`,
      [eventId],
    );
    expect(lines.rows).toHaveLength(2);
  });

  it('clears the receivable when cash arrives, and does not book income twice', async () => {
    const eventId = await emit('receipt.issued', {
      receiptId: newId(),
      receiptNo: 'RCPT/001',
      patientId: null,
      amount: '693.00',
      modes: ['cash'],
      shiftId: newId(),
    });
    await postLedgerEntries(pg.pool('migrator'));

    const lines = await pg.pool('migrator').query<{ code: string; debit: string; credit: string }>(
      `SELECT a.code, l.debit::text, l.credit::text
         FROM finance.journals j
         JOIN finance.journal_lines l ON l.journal_id = j.id
         JOIN finance.accounts a ON a.id = l.account_id
        WHERE j.source_ref_id = $1`,
      [eventId],
    );
    const by = new Map(lines.rows.map((r) => [r.code, r]));
    expect(by.get('1100')?.debit).toBe('693.00');
    expect(by.get('1200')?.credit).toBe('693.00');
    // Income was recognised when the bill was finalised. Crediting it again
    // here is how revenue gets counted twice.
    expect(by.has('4900')).toBe(false);
  });

  it('posts nothing on a second run', async () => {
    const before = await pg
      .pool('migrator')
      .query<{ c: string }>(`SELECT count(*)::text AS c FROM finance.journals`);
    const result = await postLedgerEntries(pg.pool('migrator'));
    const after = await pg
      .pool('migrator')
      .query<{ c: string }>(`SELECT count(*)::text AS c FROM finance.journals`);

    expect(result.posted).toBe(0);
    expect(after.rows[0]?.c).toBe(before.rows[0]?.c);
  });

  it('reports an event it cannot value instead of posting a zero', async () => {
    // `netAmount` missing entirely. A rule that silently posted nought is how
    // a ledger ends up quietly short.
    const eventId = await emit('bill.finalized', {
      billId: newId(),
      billNo: 'TEST/003',
      taxableAmount: '100.00',
      cgst: '0.00',
      sgst: '0.00',
      igst: '0.00',
      patientId: null,
      payerType: 'self',
      finalizedBy: null,
    });

    const result = await postLedgerEntries(pg.pool('migrator'));
    expect(result.problems.some((p) => p.includes(eventId))).toBe(true);

    const journals = await pg
      .pool('migrator')
      .query(`SELECT 1 FROM finance.journals WHERE source_ref_id = $1`, [eventId]);
    expect(journals.rows).toHaveLength(0);
  });

  it('leaves the books balancing, which is the only thing that matters', async () => {
    const tb = await pg.pool('migrator').query<{ total: string }>(
      // Cast to the money scale before text: an empty sum is `0`, not
      // `0.00`, and the assertion should be about the value not the rendering.
      `SELECT coalesce(sum(balance), 0)::numeric(18,2)::text AS total FROM finance.v_trial_balance`,
    );
    expect(tb.rows[0]?.total).toBe('0.00');
  });
});
