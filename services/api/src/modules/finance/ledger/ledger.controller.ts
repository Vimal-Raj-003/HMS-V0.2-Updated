import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { LedgerService } from './ledger.service.js';
import {
  createAccountSchema,
  listAccountsQuerySchema,
  listJournalsQuerySchema,
  postJournalSchema,
  reverseJournalSchema,
  trialBalanceQuerySchema,
  type AccountRow,
  type CreateAccountRequest,
  type JournalRow,
  type ListAccountsQuery,
  type ListJournalsQuery,
  type PostJournalRequest,
  type ReverseJournalRequest,
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
}
