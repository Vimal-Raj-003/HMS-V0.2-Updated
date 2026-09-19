import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import type {
  AccountRow,
  BalanceSheet,
  ClosePeriodRequest,
  CreateAccountRequest,
  JournalRow,
  ListAccountsQuery,
  ListJournalsQuery,
  ListPeriodsQuery,
  PeriodRow,
  PostJournalRequest,
  ProfitAndLoss,
  ProfitAndLossLine,
  ReverseJournalRequest,
  StatementQuery,
  TrialBalance,
  TrialBalanceQuery,
} from './ledger.schemas.js';

/**
 * NC-009 §3.1 — reading and writing the general ledger.
 *
 * ── What this service does not do ──────────────────────────────────────────
 *
 * It does not check that a journal balances. That is
 * `finance.a_journal_balances()`, a `DEFERRABLE INITIALLY DEFERRED` constraint
 * trigger, and the difference matters: a check here would be a second
 * implementation of the rule, and the two would disagree the first time
 * somebody wrote a path that did not call this service. What this service does
 * is translate the database's refusal into a message a human can act on.
 *
 * Nor does it edit or delete a posted journal — there is no method, because
 * there is no such operation. A posted journal is corrected by `reverse`.
 */

/** `pg` hands back `numeric` as a string, which is exactly what we want to keep. */
function asMoney(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return v.toFixed(2);
  return '0.00';
}
function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asTextOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'string' ? v.slice(0, 10) : '';
}

/**
 * Turns the ledger's own refusals into something a finance clerk can act on.
 *
 * Every one of these is raised by a trigger with `ERRCODE = 'NC009'` and a
 * message written for a person. Passing them through unchanged is deliberate:
 * the database knows exactly what went wrong and has already said so, and
 * re-wording it here would lose the detail — which period, which account, by
 * how much the entry is out.
 */
function translate(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message;

  if (code === 'NC009' && typeof message === 'string') {
    throw AppError.conflict(message);
  }
  if (code === '23505' && typeof message === 'string' && message.includes('uq_journal_source')) {
    throw AppError.conflict(
      'That event has already been posted to this book. Re-delivering it does not post it twice, which is the point.',
    );
  }
  if (code === '23505' && typeof message === 'string' && message.includes('uq_account_code')) {
    throw AppError.conflict('An account with that code already exists in this book.');
  }
  throw error;
}

@Injectable()
export class LedgerService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ── Chart of accounts ────────────────────────────────────────────────────

  async listAccounts(query: ListAccountsQuery): Promise<readonly AccountRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT id, code, name, account_type, normal_balance, is_group, parent_id, active
           FROM finance.accounts
          WHERE book_id = $1
            AND ($2::boolean IS TRUE OR active = true)
            AND ($3::text IS NULL OR account_type = $3::text)
          ORDER BY code`,
        [query.bookId, query.includeInactive, query.accountType ?? null],
      );
      return result.rows.map((r) => ({
        id: asText(r['id']),
        code: asText(r['code']),
        name: asText(r['name']),
        accountType: asText(r['account_type']),
        normalBalance: asText(r['normal_balance']),
        isGroup: r['is_group'] === true,
        parentId: asTextOrNull(r['parent_id']),
        active: r['active'] === true,
      }));
    });
  }

  async createAccount(body: CreateAccountRequest): Promise<AccountRow> {
    const id = newId();
    return this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const result = await tx.query<Record<string, unknown>>(
          `INSERT INTO finance.accounts
             (id, hospital_id, book_id, parent_id, code, name, account_type,
              is_group, is_bank_or_cash, requires_cost_centre, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
           RETURNING id, code, name, account_type, normal_balance, is_group, parent_id, active`,
          [
            id,
            getContext().hospitalId,
            body.bookId,
            body.parentId ?? null,
            body.code,
            body.name,
            body.accountType,
            body.isGroup,
            body.isBankOrCash,
            body.requiresCostCentre,
          ],
        );
        const row = result.rows[0];
        if (row === undefined) throw AppError.conflict('The account could not be created.');

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'fin_account',
          rowId: id,
          businessKey: body.code,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: null,
          before: null,
          after: { code: body.code, accountType: body.accountType },
        });

        return {
          id: asText(row['id']),
          code: asText(row['code']),
          name: asText(row['name']),
          accountType: asText(row['account_type']),
          normalBalance: asText(row['normal_balance']),
          isGroup: row['is_group'] === true,
          parentId: asTextOrNull(row['parent_id']),
          active: row['active'] === true,
        };
      })
      .catch(translate);
  }

  // ── Journals ─────────────────────────────────────────────────────────────

  /**
   * Posts a manual journal.
   *
   * The period is resolved from the date rather than accepted from the caller:
   * which month an entry belongs to is a fact about its date, not a choice, and
   * a request field for it would be a way to file January's invoice in March.
   */
  async post(body: PostJournalRequest): Promise<JournalRow> {
    const id = newId();
    return this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const periodId = await this.resolvePeriod(tx, body.bookId, body.journalDate);

        await tx.query(
          `INSERT INTO finance.journals
             (id, hospital_id, branch_id, book_id, fiscal_period_id, journal_date,
              kind, narration, status, posted_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::date, 'manual', $7, 'posted', $8, now())`,
          [
            id,
            getContext().hospitalId,
            getContext().branchId,
            body.bookId,
            periodId,
            body.journalDate,
            body.narration,
            getContext().userId,
          ],
        );

        let lineNo = 0;
        for (const line of body.lines) {
          lineNo += 1;
          await tx.query(
            `INSERT INTO finance.journal_lines
               (id, hospital_id, journal_id, line_no, account_id, cost_centre_id,
                debit, credit, narration, party_kind, party_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, $8::numeric, $9, $10, $11)`,
            [
              newId(),
              getContext().hospitalId,
              id,
              lineNo,
              line.accountId,
              line.costCentreId ?? null,
              line.debit,
              line.credit,
              line.narration ?? null,
              line.partyKind ?? null,
              line.partyId ?? null,
            ],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'fin_journal',
          rowId: id,
          businessKey: null,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: null,
          before: null,
          after: { kind: 'manual', lines: body.lines.length, date: body.journalDate },
        });

        // The balance check fires at COMMIT, after this function returns. A
        // journal that does not foot therefore fails the transaction, not this
        // line — which is why `translate` is on the outside.
        return await this.read(tx, id);
      })
      .catch(translate);
  }

  /**
   * Reverses a posted journal with a counter-entry.
   *
   * Every line is mirrored — debits become credits and credits become debits —
   * so the reversal balances for the same reason the original did. Nothing is
   * edited and nothing is deleted: `docs/04` and NC-009 §3.1 both require that
   * a statutory book only ever grows, because a book that can lose an entry
   * cannot be told apart from one that was tampered with.
   */
  async reverse(journalId: string, body: ReverseJournalRequest): Promise<JournalRow> {
    const reversalId = newId();
    const ctx = getContext();

    return this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const original = await tx.query<Record<string, unknown>>(
          `SELECT id, book_id, status, narration FROM finance.journals WHERE id = $1`,
          [journalId],
        );
        const head = original.rows[0];
        if (head === undefined) throw AppError.notFound('That journal does not exist.');
        if (asText(head['status']) !== 'posted') {
          throw AppError.conflict(
            `That journal is ${asText(head['status'])}, so there is nothing to reverse.`,
          );
        }

        const bookId = asText(head['book_id']);
        const periodId = await this.resolvePeriod(tx, bookId, body.journalDate);

        await tx.query(
          `INSERT INTO finance.journals
             (id, hospital_id, branch_id, book_id, fiscal_period_id, journal_date,
              kind, narration, reverses_journal_id, status, posted_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::date, 'reversal', $7, $8, 'posted', $9, now())`,
          [
            reversalId,
            ctx.hospitalId,
            ctx.branchId,
            bookId,
            periodId,
            body.journalDate,
            `Reversal of ${asText(head['narration'])}`.slice(0, 500),
            journalId,
            ctx.userId,
          ],
        );

        // Debit ↔ credit. One statement, so a line cannot be missed.
        await tx.query(
          `INSERT INTO finance.journal_lines
             (id, hospital_id, journal_id, line_no, account_id, cost_centre_id,
              debit, credit, narration, party_kind, party_id)
           SELECT gen_random_uuid(), l.hospital_id, $2, l.line_no, l.account_id, l.cost_centre_id,
                  l.credit, l.debit, l.narration, l.party_kind, l.party_id
             FROM finance.journal_lines l
            WHERE l.journal_id = $1`,
          [journalId, reversalId],
        );

        await tx.query(`UPDATE finance.journals SET status = 'reversed' WHERE id = $1`, [journalId]);

        await this.audit.write(tx, {
          action: 'override',
          entity: 'fin_journal',
          rowId: journalId,
          businessKey: reversalId,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: ctx.reason ?? null,
          before: { status: 'posted' },
          after: { status: 'reversed', reversalId },
        });

        return await this.read(tx, reversalId);
      })
      .catch(translate);
  }

  async list(query: ListJournalsQuery): Promise<readonly JournalRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const heads = await tx.query<Record<string, unknown>>(
        `SELECT id FROM finance.journals
          WHERE book_id = $1
            AND ($2::date IS NULL OR journal_date >= $2::date)
            AND ($3::date IS NULL OR journal_date <= $3::date)
          ORDER BY journal_date DESC, posted_at DESC
          LIMIT $4`,
        [query.bookId, query.from ?? null, query.to ?? null, query.limit],
      );
      const out: JournalRow[] = [];
      for (const head of heads.rows) out.push(await this.read(tx, asText(head['id'])));
      return out;
    });
  }

  async trialBalance(query: TrialBalanceQuery): Promise<TrialBalance> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT account_id, account_code, account_name, account_type,
                total_debit, total_credit, balance
           FROM finance.v_trial_balance
          WHERE book_id = $1
            AND ($2::uuid IS NULL OR fiscal_year_id = $2::uuid)
          ORDER BY account_code`,
        [query.bookId, query.fiscalYearId ?? null],
      );

      const rows = result.rows.map((r) => ({
        accountId: asText(r['account_id']),
        accountCode: asText(r['account_code']),
        accountName: asText(r['account_name']),
        accountType: asText(r['account_type']),
        totalDebit: asMoney(r['total_debit']),
        totalCredit: asMoney(r['total_credit']),
        balance: asMoney(r['balance']),
      }));

      // Summed in the database rather than in JavaScript: these are decimals,
      // and `reduce((a, b) => a + Number(b))` is how a trial balance ends up
      // out by a paisa that does not exist.
      const totals = await tx.query<Record<string, unknown>>(
        `SELECT coalesce(sum(total_debit), 0)::text  AS d,
                coalesce(sum(total_credit), 0)::text AS c
           FROM finance.v_trial_balance
          WHERE book_id = $1 AND ($2::uuid IS NULL OR fiscal_year_id = $2::uuid)`,
        [query.bookId, query.fiscalYearId ?? null],
      );
      const totalDebit = asMoney(totals.rows[0]?.['d']);
      const totalCredit = asMoney(totals.rows[0]?.['c']);

      return { rows, totalDebit, totalCredit, balances: totalDebit === totalCredit };
    });
  }

  // ── NC-009 §3.3 · period close ───────────────────────────────────────────

  /**
   * The periods, each carrying what stands between it and a close.
   *
   * The blockers are computed here rather than left for the controller to
   * discover by trying: `trg_a_period_closes_only_when_settled` refuses with a
   * good message, but a close screen that can only say "no" after the fact is
   * one a controller learns to fear. The same two questions the trigger asks
   * are asked here, so the answer is visible before the attempt.
   */
  async listPeriods(query: ListPeriodsQuery): Promise<readonly PeriodRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => this.readPeriods(tx, query.bookId));
  }

  /**
   * Takes the caller's transaction rather than opening one.
   *
   * `setPeriodStatus` used to finish by calling `listPeriods`, which opened a
   * second transaction while the first still held an uncommitted UPDATE on the
   * same row — so the close returned a 500 instead of a period. Anything that
   * has to be read back inside a write belongs on the write's own client.
   */
  private async readPeriods(tx: TransactionClient, bookId: string): Promise<readonly PeriodRow[]> {
    const result = await tx.query<Record<string, unknown>>(
      `SELECT p.id, p.period_no, p.starts_on, p.ends_on, p.status, p.closed_at,
                (SELECT count(*) FROM finance.journals j
                  WHERE j.fiscal_period_id = p.id AND j.status = 'draft')::int AS drafts,
                (SELECT count(*) FROM core.outbox_events e
                  WHERE e.hospital_id = p.hospital_id
                    AND e.occurred_at::date BETWEEN p.starts_on AND p.ends_on
                    AND e.event_type IN (SELECT DISTINCT event_type FROM finance.posting_rules WHERE active = true)
                    AND NOT EXISTS (
                      SELECT 1 FROM finance.journals j2
                       WHERE j2.book_id = p.book_id AND j2.source_module = 'outbox'
                         AND j2.source_event = e.event_type AND j2.source_ref_id = e.id
                    ))::int AS unposted
           FROM finance.fiscal_periods p
          WHERE p.book_id = $1
          ORDER BY p.period_no`,
      [bookId],
    );

    return result.rows.map((r) => {
      const drafts = Number(r['drafts'] ?? 0);
      const unposted = Number(r['unposted'] ?? 0);
      const blockers: string[] = [];
      if (drafts > 0) {
        blockers.push(`${String(drafts)} unfinished journal(s) — post or discard them.`);
      }
      if (unposted > 0) {
        blockers.push(
          `${String(unposted)} money event(s) have not reached the ledger. Closing now would leave that revenue in no month at all.`,
        );
      }
      return {
        id: asText(r['id']),
        periodNo: Number(r['period_no']),
        startsOn: asDate(r['starts_on']),
        endsOn: asDate(r['ends_on']),
        status: asText(r['status']),
        closedAt: r['closed_at'] instanceof Date ? r['closed_at'].toISOString() : null,
        blockers,
      };
    });
  }

  /**
   * Closes, locks or reopens a period.
   *
   * The service does not re-check the preconditions. They are triggers, and a
   * second copy here would be a second opinion that disagrees the first time
   * somebody writes a path that skips this method.
   */
  async setPeriodStatus(periodId: string, body: ClosePeriodRequest): Promise<PeriodRow> {
    const ctx = getContext();
    return this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const before = await tx.query<{ status: string; book_id: string }>(
          `SELECT status, book_id FROM finance.fiscal_periods WHERE id = $1`,
          [periodId],
        );
        const prior = before.rows[0];
        if (prior === undefined) throw AppError.notFound('That accounting period does not exist.');

        const reopening = body.status === 'open';
        await tx.query(
          // `$2::text` everywhere it appears. Used bare it is inferred as
          // `varchar` by the assignment and as `text` by the comparison, and
          // Postgres refuses a parameter it has deduced two types for.
          `UPDATE finance.fiscal_periods
              SET status = $2::text,
                  closed_by = CASE WHEN $2::text = 'open' THEN NULL ELSE $3::uuid END,
                  closed_at = CASE WHEN $2::text = 'open' THEN NULL ELSE now() END,
                  updated_at = now()
            WHERE id = $1`,
          [periodId, body.status, ctx.userId],
        );

        await this.audit.write(tx, {
          action: reopening ? 'override' : 'approve',
          entity: 'fin_fiscal_period',
          rowId: periodId,
          businessKey: null,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: ctx.reason ?? null,
          before: { status: prior.status },
          after: { status: body.status },
        });

        const rows = await this.readPeriods(tx, prior.book_id);
        const row = rows.find((p) => p.id === periodId);
        if (row === undefined) throw AppError.notFound('That accounting period does not exist.');
        return row;
      })
      .catch(translate);
  }

  // ── NC-009 §3.3 · the statements ─────────────────────────────────────────

  async profitAndLoss(query: StatementQuery): Promise<ProfitAndLoss> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT account_code, account_name, account_type, sum(amount)::text AS amount
           FROM finance.v_profit_and_loss
          WHERE book_id = $1 AND ($2::uuid IS NULL OR fiscal_year_id = $2::uuid)
          GROUP BY account_code, account_name, account_type
          ORDER BY account_code`,
        [query.bookId, query.fiscalYearId ?? null],
      );
      const lines: ProfitAndLossLine[] = result.rows.map((r) => ({
        accountCode: asText(r['account_code']),
        accountName: asText(r['account_name']),
        accountType: asText(r['account_type']),
        amount: asMoney(r['amount']),
      }));

      // Totalled in SQL, for the same reason the trial balance is: these are
      // decimals, and adding them as JavaScript numbers is how a statement
      // ends up out by a paisa that does not exist.
      const totals = await tx.query<Record<string, unknown>>(
        `SELECT coalesce(sum(amount) FILTER (WHERE account_type = 'income'), 0)::numeric(18,2)::text  AS inc,
                coalesce(sum(amount) FILTER (WHERE account_type = 'expense'), 0)::numeric(18,2)::text AS exp,
                (coalesce(sum(amount) FILTER (WHERE account_type = 'income'), 0)
                 - coalesce(sum(amount) FILTER (WHERE account_type = 'expense'), 0))::numeric(18,2)::text AS profit
           FROM finance.v_profit_and_loss
          WHERE book_id = $1 AND ($2::uuid IS NULL OR fiscal_year_id = $2::uuid)`,
        [query.bookId, query.fiscalYearId ?? null],
      );
      const t = totals.rows[0] ?? {};

      return {
        income: lines.filter((l) => l.accountType === 'income'),
        expense: lines.filter((l) => l.accountType === 'expense'),
        totalIncome: asMoney(t['inc']),
        totalExpense: asMoney(t['exp']),
        profit: asMoney(t['profit']),
      };
    });
  }

  async balanceSheet(query: StatementQuery): Promise<BalanceSheet> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT coalesce(sum(assets), 0)::numeric(18,2)::text                    AS assets,
                coalesce(sum(liabilities), 0)::numeric(18,2)::text               AS liabilities,
                coalesce(sum(equity), 0)::numeric(18,2)::text                    AS equity,
                coalesce(sum(retained_earnings_current), 0)::numeric(18,2)::text AS profit,
                (coalesce(sum(assets), 0)
                 - (coalesce(sum(liabilities), 0) + coalesce(sum(equity), 0)
                    + coalesce(sum(retained_earnings_current), 0)))::numeric(18,2)::text AS out_by
           FROM finance.v_balance_sheet
          WHERE book_id = $1 AND ($2::uuid IS NULL OR fiscal_year_id = $2::uuid)`,
        [query.bookId, query.fiscalYearId ?? null],
      );
      const r = result.rows[0] ?? {};
      const outBy = asMoney(r['out_by']);

      return {
        assets: asMoney(r['assets']),
        liabilities: asMoney(r['liabilities']),
        equity: asMoney(r['equity']),
        retainedEarningsCurrent: asMoney(r['profit']),
        outBy,
        // Zero by construction — every journal balances, so assets always
        // equal liabilities plus equity plus profit. Returned rather than
        // asserted so a caller can check rather than trust.
        balances: Number(outBy) === 0,
      };
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * Which period a date belongs to.
   *
   * Refuses rather than guesses. A hospital that has not opened the year cannot
   * post into it, and the message says so — the alternative is a journal
   * silently landing in the nearest open period, which is how a March invoice
   * ends up in April's return.
   */
  private async resolvePeriod(tx: TransactionClient, bookId: string, onDate: string): Promise<string> {
    const result = await tx.query<{ id: string }>(
      `SELECT id FROM finance.fiscal_periods
        WHERE book_id = $1 AND $2::date BETWEEN starts_on AND ends_on`,
      [bookId, onDate],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) {
      throw AppError.conflict(
        `No accounting period covers ${onDate} in this book. Open the financial year before posting into it — a journal with nowhere to land would otherwise go to the nearest open month and quietly misstate a return.`,
      );
    }
    return id;
  }

  private async read(tx: TransactionClient, id: string): Promise<JournalRow> {
    const head = await tx.query<Record<string, unknown>>(
      `SELECT j.id, j.journal_no, j.journal_date, j.kind, j.narration, j.status,
              j.source_module, j.source_event, j.source_ref_id, j.reverses_journal_id,
              coalesce((SELECT sum(debit)  FROM finance.journal_lines WHERE journal_id = j.id), 0)::text AS total_debit,
              coalesce((SELECT sum(credit) FROM finance.journal_lines WHERE journal_id = j.id), 0)::text AS total_credit
         FROM finance.journals j WHERE j.id = $1`,
      [id],
    );
    const row = head.rows[0];
    if (row === undefined) throw AppError.notFound('That journal does not exist.');

    const lines = await tx.query<Record<string, unknown>>(
      `SELECT l.line_no, l.account_id, a.code AS account_code, a.name AS account_name,
              l.cost_centre_id, l.debit::text AS debit, l.credit::text AS credit, l.narration
         FROM finance.journal_lines l
         JOIN finance.accounts a ON a.id = l.account_id
        WHERE l.journal_id = $1
        ORDER BY l.line_no`,
      [id],
    );

    return {
      id: asText(row['id']),
      journalNo: asTextOrNull(row['journal_no']),
      journalDate: asDate(row['journal_date']),
      kind: asText(row['kind']),
      narration: asTextOrNull(row['narration']),
      status: asText(row['status']),
      sourceModule: asTextOrNull(row['source_module']),
      sourceEvent: asTextOrNull(row['source_event']),
      sourceRefId: asTextOrNull(row['source_ref_id']),
      reversesJournalId: asTextOrNull(row['reverses_journal_id']),
      totalDebit: asMoney(row['total_debit']),
      totalCredit: asMoney(row['total_credit']),
      lines: lines.rows.map((l) => ({
        lineNo: Number(l['line_no']),
        accountId: asText(l['account_id']),
        accountCode: asText(l['account_code']),
        accountName: asText(l['account_name']),
        costCentreId: asTextOrNull(l['cost_centre_id']),
        debit: asMoney(l['debit']),
        credit: asMoney(l['credit']),
        narration: asTextOrNull(l['narration']),
      })),
    };
  }
}
