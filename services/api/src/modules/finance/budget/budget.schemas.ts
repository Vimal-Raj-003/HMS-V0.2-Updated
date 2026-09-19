import { z } from 'zod';

/** NC-022 · budgets and commitment control, over the wire. */

const uuid = z.string().uuid();
/** Money as a string, for the reason `ledger.schemas.ts` gives: doubles lose paise. */
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'A money amount with at most two decimals.');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const createCycleSchema = z
  .object({
    bookId: uuid,
    code: z.string().min(1).max(24),
    name: z.string().min(1).max(200),
    startsOn: isoDate,
    endsOn: isoDate,
  })
  .refine((v) => v.endsOn > v.startsOn, {
    message: 'A budget cycle has to end after it starts.',
    path: ['endsOn'],
  });
export type CreateCycleRequest = z.infer<typeof createCycleSchema>;

export const setCycleStatusSchema = z.object({
  /**
   * `draft` while it is argued over, `active` once it binds, `closed` when the
   * year is done. Only `active` accepts commitments.
   */
  status: z.enum(['draft', 'active', 'closed']),
});
export type SetCycleStatusRequest = z.infer<typeof setCycleStatusSchema>;

export const createLineSchema = z.object({
  cycleId: uuid,
  costCentreId: uuid,
  accountId: uuid,
  code: z.string().min(1).max(64),
  budgetKind: z.enum(['operating', 'capital']).default('operating'),
  /**
   * The opening figure. It is written to both `original_amount` and
   * `revised_amount`, and `original` never moves again — variance can only ask
   * "by how much did we miss the plan?" if the plan is still on the row.
   */
  amount: money,
  alertThresholdPct: z.coerce.number().int().min(0).max(100).default(80),
});
export type CreateLineRequest = z.infer<typeof createLineSchema>;

export const reviseLineSchema = z.object({
  /**
   * The new figure, not a delta. A delta sent twice by a retrying client
   * raises the budget twice; an absolute amount sent twice is idempotent in
   * effect even before the idempotency key catches it.
   */
  toAmount: money,
  reason: z.string().min(3).max(500),
});
export type ReviseLineRequest = z.infer<typeof reviseLineSchema>;

export const virementSchema = z
  .object({
    cycleId: uuid,
    reason: z.string().min(3).max(500),
    reference: z.string().max(40).optional(),
    /**
     * At least two legs, each an absolute new amount for its line. The sum of
     * the movements must be zero and the database checks it at COMMIT; sending
     * amounts rather than "move X from A to B" keeps a three-way virement
     * expressible without inventing a syntax for it.
     */
    legs: z
      .array(
        z.object({
          lineId: uuid,
          toAmount: money,
          note: z.string().min(3).max(500),
        }),
      )
      .min(2)
      .max(20),
    /**
     * Who asked. The approver is the authenticated user, and the database
     * refuses the case where they are the same person.
     */
    requestedBy: uuid,
  })
  .refine((v) => new Set(v.legs.map((l) => l.lineId)).size === v.legs.length, {
    message: 'Each line may appear once in a virement. Two legs on one line is a single net movement.',
    path: ['legs'],
  });
export type VirementRequest = z.infer<typeof virementSchema>;

export const commitSchema = z.object({
  lineId: uuid,
  sourceKind: z.enum(['indent', 'purchase_order', 'capex_request', 'manual']),
  sourceId: uuid,
  sourceRef: z.string().max(64).optional(),
  amount: money,
});
export type CommitRequest = z.infer<typeof commitSchema>;

export const releaseSchema = z.object({
  releasedReason: z.string().min(3).max(300),
  /** `realised` when a GRN turned it into a real cost; `released` otherwise. */
  becomes: z.enum(['released', 'realised']).default('released'),
});
export type ReleaseRequest = z.infer<typeof releaseSchema>;

export const checkSchema = z.object({
  lineId: uuid,
  amount: money,
  /** Excluded from the check, so amending a PO is tested on the difference. */
  excludeSourceId: uuid.optional(),
});
export type CheckRequest = z.infer<typeof checkSchema>;

export interface CycleRow {
  readonly id: string;
  readonly bookId: string;
  readonly code: string;
  readonly name: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: string;
  readonly lineCount: number;
}

export interface BudgetPositionRow {
  readonly lineId: string;
  readonly lineCode: string;
  readonly cycleCode: string;
  readonly budgetKind: string;
  readonly costCentreId: string;
  readonly costCentreName: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly originalAmount: string;
  readonly revisedAmount: string;
  readonly committedAmount: string;
  readonly actualAmount: string;
  /** `revised − committed − actual`. Computed in SQL; never stored. */
  readonly available: string;
  /** `revised − original`: what the revisions and virements did to the plan. */
  readonly revisionMovement: string;
  readonly usedPct: number;
  readonly overAlertThreshold: boolean;
}

export interface CommitmentRow {
  readonly id: string;
  readonly lineId: string;
  readonly lineCode: string;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly sourceRef: string | null;
  readonly amount: string;
  readonly status: string;
  readonly releasedReason: string | null;
  readonly createdAt: string;
}

export interface RevisionRow {
  readonly id: string;
  readonly lineId: string;
  readonly lineCode: string;
  readonly revisionNo: number;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly movement: string;
  readonly reason: string;
  readonly virementId: string | null;
  readonly approvedAt: string;
}

/**
 * The answer to "can I raise this order?", given before the order exists.
 *
 * It is advisory and says so. The binding answer is the trigger that fires
 * when the commitment is actually written, because between this call and that
 * write somebody else may have spent the line.
 */
export interface CheckResult {
  readonly lineId: string;
  readonly lineCode: string;
  readonly requested: string;
  readonly available: string;
  readonly wouldFit: boolean;
  readonly message: string;
}
