import type { Pool } from 'pg';

/**
 * NC-009 §3.2 — turning domain events into journals.
 *
 * ── Why this polls the outbox instead of consuming a stream ───────────────
 *
 * The relay already moves `core.outbox_events` onto Redis Streams, and a
 * consumer group would be the textbook answer. It is the wrong one here for a
 * reason specific to a ledger: a stream consumer that falls behind, crashes
 * mid-batch or has its group trimmed loses its place, and the recovery story
 * for "did we post that receipt?" is a reconciliation nobody wants to run
 * against a statutory book.
 *
 * Reading the outbox table directly makes the question trivial. An event is
 * unposted exactly when no journal names it as its source, which is a LEFT JOIN
 * — restartable, resumable, and answerable at any moment by a controller with
 * `psql`. The same `uq_journal_source` index that makes the query correct also
 * makes a double-post impossible, so two poster instances racing produce one
 * journal and one unique-violation, not two entries.
 *
 * ── One transaction per event, never one per batch ────────────────────────
 *
 * A batch transaction would mean one unpostable event — a closed period, a
 * missing account — rolling back every good journal beside it, and the next run
 * hitting the same poison row for ever. Each event commits or fails alone, and
 * a failure is reported rather than retried into a loop.
 *
 * ── Derived amounts ───────────────────────────────────────────────────────
 *
 * A leg names the payload field it is measured from. Two keys are computed
 * rather than read, because the events carry components and the ledger needs
 * the sum: `taxTotal` is CGST + SGST + IGST, and `netOfTax` is the bill's net
 * less that. Most clinical services are GST-exempt in India, so a bill's net is
 * the exempt portion plus the taxable portion plus tax — crediting
 * `taxableAmount` as income would book ₹100 on a ₹693 bill.
 *
 * An amount key the payload does not carry is an error, not a zero. A rule that
 * silently posts nothing is how a ledger ends up quietly short.
 */

export interface LedgerPostResult {
  readonly posted: number;
  readonly skipped: number;
  /** One line per event that could not be posted, for the exception worklist. */
  readonly problems: readonly string[];
}

interface PendingEvent {
  readonly id: string;
  readonly hospital_id: string;
  readonly branch_id: string | null;
  readonly event_type: string;
  readonly payload: Record<string, unknown>;
  readonly occurred_at: Date;
}

interface Leg {
  readonly leg_no: number;
  readonly side: string;
  readonly account_id: string;
  readonly amount_key: string;
  readonly narration_template: string | null;
}

/** Money is compared and summed in paise, so no float ever touches a rupee. */
function toPaise(value: unknown): number | null {
  if (typeof value === 'number') return Math.round(value * 100);
  if (typeof value !== 'string') return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  return Math.round(Number(value) * 100);
}

function fromPaise(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${String(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * The amount a leg is worth, in paise, or `null` when the payload cannot
 * answer — which is a problem to report, never a zero to post.
 */
function resolveAmount(payload: Record<string, unknown>, key: string): number | null {
  if (key === 'taxTotal' || key === 'netOfTax') {
    const cgst = toPaise(payload['cgst'] ?? '0');
    const sgst = toPaise(payload['sgst'] ?? '0');
    const igst = toPaise(payload['igst'] ?? '0');
    if (cgst === null || sgst === null || igst === null) return null;
    const tax = cgst + sgst + igst;
    if (key === 'taxTotal') return tax;
    const net = toPaise(payload['netAmount']);
    return net === null ? null : net - tax;
  }
  if (!(key in payload)) return null;
  return toPaise(payload[key]);
}

/**
 * Posts every money event that has not yet reached the ledger.
 *
 * `limit` bounds a single run so a hospital switching the ledger on after a
 * year of trading does not attempt one enormous catch-up; the job simply runs
 * again on its next tick.
 */
export async function postLedgerEntries(
  pool: Pool,
  options: { readonly limit?: number } = {},
): Promise<LedgerPostResult> {
  const limit = options.limit ?? 200;
  const problems: string[] = [];
  let posted = 0;
  let skipped = 0;

  // Unposted = no journal names it. The LEFT JOIN is the whole bookkeeping of
  // "where did we get to", which is why there is no cursor to lose.
  const pending = await pool.query<PendingEvent>(
    `SELECT e.id, e.hospital_id, e.branch_id, e.event_type, e.payload, e.occurred_at
       FROM core.outbox_events e
       JOIN finance.books b
         ON b.hospital_id = e.hospital_id AND b.active = true
      WHERE e.event_type IN (SELECT DISTINCT event_type FROM finance.posting_rules WHERE active = true)
        AND NOT EXISTS (
          SELECT 1 FROM finance.journals j
           WHERE j.book_id = b.id
             AND j.source_module = 'outbox'
             AND j.source_event = e.event_type
             AND j.source_ref_id = e.id
        )
      ORDER BY e.occurred_at
      LIMIT $1`,
    [limit],
  );

  for (const event of pending.rows) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const book = await client.query<{ id: string }>(
        `SELECT id FROM finance.books WHERE hospital_id = $1 AND active = true ORDER BY code LIMIT 1`,
        [event.hospital_id],
      );
      const bookId = book.rows[0]?.id;
      if (bookId === undefined) {
        await client.query('ROLLBACK');
        skipped += 1;
        continue;
      }

      const onDate = event.occurred_at.toISOString().slice(0, 10);

      const rules = await client.query<Leg>(
        `SELECT leg_no, side, account_id, amount_key, narration_template
           FROM finance.posting_rules
          WHERE book_id = $1 AND event_type = $2 AND active = true
            AND effective_from <= $3::date
            AND (effective_to IS NULL OR effective_to > $3::date)
          ORDER BY leg_no`,
        [bookId, event.event_type, onDate],
      );
      if (rules.rows.length === 0) {
        await client.query('ROLLBACK');
        skipped += 1;
        continue;
      }

      // Resolve every amount before writing anything: a rule that cannot be
      // valued must not leave half a journal behind.
      const legs: { leg: Leg; paise: number }[] = [];
      let unresolved: string | null = null;
      for (const leg of rules.rows) {
        const paise = resolveAmount(event.payload, leg.amount_key);
        if (paise === null) {
          unresolved = leg.amount_key;
          break;
        }
        // A zero leg is skipped, not posted. An intra-state bill has no IGST,
        // and a zero line violates the debit-or-credit constraint anyway.
        if (paise !== 0) legs.push({ leg, paise });
      }

      if (unresolved !== null) {
        await client.query('ROLLBACK');
        problems.push(
          `${event.event_type} ${event.id}: the payload carries no "${unresolved}", so the journal was not posted. Fix the posting rule or the event.`,
        );
        continue;
      }
      if (legs.length < 2) {
        await client.query('ROLLBACK');
        problems.push(
          `${event.event_type} ${event.id}: only ${String(legs.length)} non-zero leg(s), which is not an entry.`,
        );
        continue;
      }

      const period = await client.query<{ id: string }>(
        `SELECT id FROM finance.fiscal_periods
          WHERE book_id = $1 AND $2::date BETWEEN starts_on AND ends_on`,
        [bookId, onDate],
      );
      const periodId = period.rows[0]?.id;
      if (periodId === undefined) {
        await client.query('ROLLBACK');
        problems.push(
          `${event.event_type} ${event.id}: no accounting period covers ${onDate}. Open the financial year.`,
        );
        continue;
      }

      const journal = await client.query<{ id: string }>(
        `INSERT INTO finance.journals
           (id, hospital_id, branch_id, book_id, fiscal_period_id, journal_date, kind,
            narration, source_module, source_event, source_ref_id, status, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::date, 'automatic',
                 $6, 'outbox', $7, $8, 'posted', now())
         RETURNING id`,
        [
          event.hospital_id,
          event.branch_id,
          bookId,
          periodId,
          onDate,
          `Automatic posting of ${event.event_type}`,
          event.event_type,
          event.id,
        ],
      );
      const journalId = journal.rows[0]?.id;
      if (journalId === undefined) throw new Error('journal insert returned no id');

      let lineNo = 0;
      for (const { leg, paise } of legs) {
        lineNo += 1;
        const amount = fromPaise(Math.abs(paise));
        await client.query(
          `INSERT INTO finance.journal_lines
             (id, hospital_id, journal_id, line_no, account_id, debit, credit, narration)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5::numeric, $6::numeric, $7)`,
          [
            event.hospital_id,
            journalId,
            lineNo,
            leg.account_id,
            leg.side === 'DR' ? amount : '0',
            leg.side === 'CR' ? amount : '0',
            leg.narration_template,
          ],
        );
      }

      // The balance check fires here. An unbalanced set of rules therefore
      // fails this one event and reports itself, rather than being discovered
      // at a period close three weeks later.
      await client.query('COMMIT');
      posted += 1;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Already broken; the original error is the one worth reporting.
      }
      const message = error instanceof Error ? error.message : 'unknown error';
      problems.push(`${event.event_type} ${event.id}: ${message}`);
    } finally {
      client.release();
    }
  }

  return { posted, skipped, problems };
}
