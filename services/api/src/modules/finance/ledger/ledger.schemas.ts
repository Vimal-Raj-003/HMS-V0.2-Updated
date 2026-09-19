import { z } from 'zod';

/** NC-009 · the ledger's request and response contracts. */

const uuid = z.string().uuid();
/**
 * Money, as a string.
 *
 * A JSON number is an IEEE double, and `0.1 + 0.2` is where ledgers go wrong.
 * `docs/03` keeps money in `numeric(14,2)`; the wire format matches it so a
 * rupee survives the round trip that a float would quietly round.
 */
const money = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'A money amount with at most two decimal places.');

export const accountTypes = ['asset', 'liability', 'equity', 'income', 'expense'] as const;

export const createAccountSchema = z.object({
  bookId: uuid,
  parentId: uuid.optional(),
  code: z.string().min(1).max(32),
  name: z.string().min(1).max(200),
  accountType: z.enum(accountTypes),
  isGroup: z.boolean().default(false),
  isBankOrCash: z.boolean().default(false),
  requiresCostCentre: z.boolean().default(false),
  // `normalBalance` is deliberately absent. It is derived from `accountType`
  // by a trigger, and a request field for it would be a way to disagree with
  // the database about what an asset is.
});
export type CreateAccountRequest = z.infer<typeof createAccountSchema>;

export const listAccountsQuerySchema = z.object({
  bookId: uuid,
  accountType: z.enum(accountTypes).optional(),
  includeInactive: z.coerce.boolean().default(false),
});
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

export const journalLineSchema = z.object({
  accountId: uuid,
  costCentreId: uuid.optional(),
  debit: money.default('0'),
  credit: money.default('0'),
  narration: z.string().max(500).optional(),
  partyKind: z.string().max(24).optional(),
  partyId: uuid.optional(),
});

export const postJournalSchema = z.object({
  bookId: uuid,
  journalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  narration: z.string().min(1).max(500),
  // Two lines is the floor the database enforces anyway; rejecting one here
  // gives the caller the message rather than a constraint violation.
  lines: z.array(journalLineSchema).min(2).max(200),
});
export type PostJournalRequest = z.infer<typeof postJournalSchema>;

export const reverseJournalSchema = z.object({
  /** The date the reversal lands on. A reversal into a closed period is refused. */
  journalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type ReverseJournalRequest = z.infer<typeof reverseJournalSchema>;

export const listJournalsQuerySchema = z.object({
  bookId: uuid,
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type ListJournalsQuery = z.infer<typeof listJournalsQuerySchema>;

export const trialBalanceQuerySchema = z.object({
  bookId: uuid,
  fiscalYearId: uuid.optional(),
});
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuerySchema>;

export interface AccountRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: string;
  readonly normalBalance: string;
  readonly isGroup: boolean;
  readonly parentId: string | null;
  readonly active: boolean;
}

export interface JournalLineRow {
  readonly lineNo: number;
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly costCentreId: string | null;
  readonly debit: string;
  readonly credit: string;
  readonly narration: string | null;
}

export interface JournalRow {
  readonly id: string;
  readonly journalNo: string | null;
  readonly journalDate: string;
  readonly kind: string;
  readonly narration: string | null;
  readonly status: string;
  readonly sourceModule: string | null;
  readonly sourceEvent: string | null;
  readonly sourceRefId: string | null;
  readonly reversesJournalId: string | null;
  readonly totalDebit: string;
  readonly totalCredit: string;
  readonly lines: readonly JournalLineRow[];
}

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly totalDebit: string;
  readonly totalCredit: string;
  readonly balance: string;
}

export interface TrialBalance {
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebit: string;
  readonly totalCredit: string;
  /** Always true, given the deferred constraint. Returned so a caller can assert it. */
  readonly balances: boolean;
}
