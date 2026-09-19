import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import type {
  AccountRow,
  CreateAccountRequest,
  JournalRow,
  ListAccountsQuery,
  ListJournalsQuery,
  PostJournalRequest,
  ReverseJournalRequest,
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
