import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { LedgerService } from './ledger.service.js';
import {
  closePeriodSchema,
  createAccountSchema,
  listAccountsQuerySchema,
  listJournalsQuerySchema,
  listPeriodsQuerySchema,
  postJournalSchema,
  reverseJournalSchema,
  statementQuerySchema,
  trialBalanceQuerySchema,
  type AccountRow,
  type BalanceSheet,
  type ClosePeriodRequest,
  type CreateAccountRequest,
  type JournalRow,
  type ListAccountsQuery,
  type ListJournalsQuery,
  type ListPeriodsQuery,
  type PeriodRow,
  type PostJournalRequest,
  type ProfitAndLoss,
  type ReverseJournalRequest,
  type StatementQuery,
  type TrialBalance,
  type TrialBalanceQuery,
} from './ledger.schemas.js';

/**
 * `/api/v1/finance/*` — NC-009 §3.1, the general ledger.
 *
 * ── There is no route that edits or deletes a journal ──────────────────────
 *
 * Not "there is one and it checks a permission" — there is none. A posted
 * journal is corrected by `POST /journals/:id/reverse`, which writes a
 * counter-entry, and the database refuses an UPDATE or DELETE regardless of
 * what any route might try. A statutory book that can lose an entry cannot be
 * told apart from one that was tampered with.
 *
 * ── And none that posts an automatic journal ───────────────────────────────
 *
 * `POST /journals` writes `kind = 'manual'`. Automatic journals are raised by
 * the posting engine from domain events, inside the transaction that recorded
 * the event, which is the same rule RC-006 follows for charge intents: a route
 * that could raise one would be a route that books revenue no module has any
 * record of.
 */
@Controller('finance')
export class LedgerController {
  constructor(@Inject(LedgerService) private readonly svc: LedgerService) {}

  @Permission('finance.ledger.read')
  @Get('accounts')
  async listAccounts(
    @Query(new ZodBody(listAccountsQuerySchema)) query: ListAccountsQuery,
  ): Promise<readonly AccountRow[]> {
    return this.svc.listAccounts(query);
  }

  @Permission('finance.account.manage')
  @Post('accounts')
  async createAccount(
    @Body(new ZodBody(createAccountSchema)) body: CreateAccountRequest,
  ): Promise<AccountRow> {
    return this.svc.createAccount(body);
  }

  @Permission('finance.ledger.read')
  @Get('journals')
  async listJournals(
    @Query(new ZodBody(listJournalsQuerySchema)) query: ListJournalsQuery,
  ): Promise<readonly JournalRow[]> {
    return this.svc.list(query);
  }

  /** Idempotent: a retried post must not become two entries in a statutory book. */
  @Permission('finance.journal.post')
  @Idempotent()
  @Post('journals')
  async post(@Body(new ZodBody(postJournalSchema)) body: PostJournalRequest): Promise<JournalRow> {
    return this.svc.post(body);
  }

  @Permission('finance.journal.reverse')
  @Idempotent()
  @Post('journals/:id/reverse')
  async reverse(
    @Param('id') id: string,
    @Body(new ZodBody(reverseJournalSchema)) body: ReverseJournalRequest,
  ): Promise<JournalRow> {
    return this.svc.reverse(id, body);
  }

  /** The answer to "do the books balance", which given §D.4 is always yes. */
  @Permission('finance.ledger.read')
  @Get('trial-balance')
  async trialBalance(
    @Query(new ZodBody(trialBalanceQuerySchema)) query: TrialBalanceQuery,
  ): Promise<TrialBalance> {
    return this.svc.trialBalance(query);
  }
  // ── NC-009 §3.3 · period close and the statements ────────────────────────

  /** Each period with what still stands between it and a close. */
  @Permission('finance.ledger.read')
  @Get('periods')
  async listPeriods(
    @Query(new ZodBody(listPeriodsQuerySchema)) query: ListPeriodsQuery,
  ): Promise<readonly PeriodRow[]> {
    return this.svc.listPeriods(query);
  }

  /**
   * Closes, locks or reopens a period.
   *
   * `PATCH`, not three verbs: a period has one status and this sets it. The
   * preconditions live in triggers — unfinished journals and money that has
   * not reached the ledger both refuse the close — so this route cannot be the
   * thing that forgets to check.
   */
  @Permission('finance.period.close')
  @Patch('periods/:id')
  async setPeriodStatus(
    @Param('id') id: string,
    @Body(new ZodBody(closePeriodSchema)) body: ClosePeriodRequest,
  ): Promise<PeriodRow> {
    return this.svc.setPeriodStatus(id, body);
  }

  @Permission('finance.ledger.read')
  @Get('profit-and-loss')
  async profitAndLoss(
    @Query(new ZodBody(statementQuerySchema)) query: StatementQuery,
  ): Promise<ProfitAndLoss> {
    return this.svc.profitAndLoss(query);
  }

  /** Balances by construction; `outBy` is returned so a caller can check. */
  @Permission('finance.ledger.read')
  @Get('balance-sheet')
  async balanceSheet(@Query(new ZodBody(statementQuerySchema)) query: StatementQuery): Promise<BalanceSheet> {
    return this.svc.balanceSheet(query);
  }
}
