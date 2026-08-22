import { Inject, Injectable } from '@nestjs/common';
import { ProblemType, newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { CursorService } from '../../../core/pagination/cursor.service.js';
import { PolicyService } from '../../../core/policy/policy.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { cashEvent } from './cash.events.js';
import { countSheet, moneyFromDb, toCurrencyCode } from './cash.money.js';
import {
  SHIFT_COLUMNS,
  expectedCashOf,
  loadCounter,
  loadShift,
  modeTotals,
  recordDenominationSheet,
  recordDrawerEvent,
  type ModeTotal,
  type ShiftRow,
} from './cash.shared.js';
import type { CloseShiftRequest, ListShiftsQuery, OpenShiftRequest } from './cash.schemas.js';

const RESOURCE = 'cash.shifts';

export interface ShiftView {
  readonly id: string;
  readonly counterId: string;
  readonly branchId: string;
  readonly cashierUserId: string;
  readonly businessDate: string;
  readonly status: string;
  readonly currency: string;
  readonly openingFloat: string;
  readonly expectedCash: string;
  readonly countedCash: string | null;
  readonly variance: string | null;
  readonly varianceReason: string | null;
  readonly varianceApprovedBy: string | null;
  readonly receiptsCount: number;
  readonly voidsCount: number;
  readonly refundsCount: number;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
  readonly totals: readonly ModeTotal[];
  readonly pendingConfirmations: number;
  /** Set when the close was refused; the console shows it as the next step. */
  readonly blockedBy: 'variance_approval' | 'pending_confirmations' | null;
}

interface ShiftListItem {
  readonly id: string;
  readonly counter_id: string;
  readonly cashier_user_id: string;
  readonly business_date: string;
  readonly status: string;
  readonly opening_float: string;
  readonly counted_cash: string | null;
  readonly variance: string | null;
  readonly opened_at: Date;
  readonly closed_at: Date | null;
}

/**
 * NC-001 §3.2 / §3.6 — shifts, the denomination sheet and the close.
 *
 * The two rules that shape this file:
 *
 * **A shift never closes with an unexplained variance.** A close whose counted
 * cash differs from the expected figure does not fail — failing would throw away
 * the count the cashier has just keyed in — it parks the shift in `closing` with
 * the count, the variance and the reason recorded, and refuses to finish. Only a
 * different person holding `receipt.shift.variance.approve` can unblock it, and
 * if the cashier recounts to a different figure the approval is discarded and
 * the approver has to look again.
 *
 * **The approver is never the cashier.** NC-001 §5: "cashier ≠ variance
 * approver". The permission is a separate key held by the head cashier and
 * finance, and the identity check here is what stops a cashier who happens to
 * hold both keys approving their own shortage.
 */
@Injectable()
export class ShiftsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(CursorService) private readonly cursors: CursorService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────

  async list(query: ListShiftsQuery): Promise<Page<ShiftListItem>> {
    const hospitalId = getContext().hospitalId ?? '';
    const limit = this.cursors.pageSize(query.limit);
    const after = this.cursors.start(query.cursor, { hospitalId, resource: RESOURCE });

    const where: string[] = ['true'];
    const values: unknown[] = [];
    const bind = (value: unknown): string => `$${values.push(value)}`;

    if (query.counterId !== undefined) where.push(`s.counter_id = ${bind(query.counterId)}::uuid`);
    if (query.status !== undefined) where.push(`s.status = ${bind(query.status)}::billing."CashShiftStatus"`);
    if (query.businessDate !== undefined) where.push(`s.business_date = ${bind(query.businessDate)}::date`);
    if (after !== null) {
      where.push(`(s.opened_at, s.id) < (${bind(after.k[0])}::timestamptz, ${bind(after.id)}::uuid)`);
    }

    const sql = `SELECT s.id, s.counter_id, s.cashier_user_id, s.business_date::text AS business_date,
                        s.status::text AS status, s.opening_float::text AS opening_float,
                        s.counted_cash::text AS counted_cash, s.variance::text AS variance,
                        s.opened_at, s.closed_at, s.opened_at::text AS cursor_key
                   FROM billing.cash_shifts s
                  WHERE ${where.join(' AND ')}
                  ORDER BY s.opened_at DESC, s.id DESC
                  LIMIT ${bind(limit + 1)}`;

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const fetched = await tx.rows<ShiftListItem & { cursor_key: string }>(sql, values);
      return this.cursors.keysetPage<ShiftListItem>(fetched, limit, {
        hospitalId,
        resource: RESOURCE,
        direction: 'desc',
      });
    });
  }

  async get(shiftId: string): Promise<ShiftView> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const shift = await loadShift(tx, shiftId, { forUpdate: false });
      return this.viewOf(tx, shift, null);
    });
  }

  /** NC-001 §6 `POST /shifts/{id}/close/preview` — what the close will say. */
  async closePreview(shiftId: string): Promise<ShiftView> {
    return this.get(shiftId);
  }

  // ── writes ────────────────────────────────────────────────────────────────

  async open(body: OpenShiftRequest): Promise<ShiftView> {
    const ctx = getContext();
    const userId = ctx.userId ?? '';

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const counter = await loadCounter(tx, body.counterId);
      if (!counter.is_active) throw AppError.conflict(`Counter ${counter.code} is not active.`);

      const assigned = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM billing.cash_counter_assignments
          WHERE counter_id = $1 AND user_id = $2
            AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
          LIMIT 1`,
        [counter.id, userId],
      );
      if (assigned === undefined) {
        // NC-001 §3.1: ABAC `assigned_counter_only`, overridable only by the
        // explicit key — which itself requires a reason, so the override is
        // never silent.
        try {
          await this.policy.assert('receipt.shift.open_any', { branchId: counter.branch_id });
        } catch {
          throw new AppError(
            ProblemType.PERMISSION_DENIED,
            `You are not assigned to counter ${counter.code}.`,
            { nextAction: 'Ask the branch administrator to assign you, or have a supervisor open it.' },
          );
        }
      }

      const mine = await tx.maybeOne<{ id: string }>(
        `SELECT id FROM billing.cash_shifts
          WHERE cashier_user_id = $1 AND branch_id = $2 AND status IN ('open', 'closing') LIMIT 1`,
        [userId, counter.branch_id],
      );
      if (mine !== undefined) {
        throw AppError.conflict('You already have an open shift in this branch. Close it first.');
      }

      const occupied = await tx.maybeOne<{ id: string; cashier_user_id: string }>(
        `SELECT id, cashier_user_id FROM billing.cash_shifts
          WHERE counter_id = $1 AND status IN ('open', 'closing') LIMIT 1`,
        [counter.id],
      );
      if (occupied !== undefined) {
        throw AppError.conflict(
          `Counter ${counter.code} already has an open shift. It must be closed, or taken over by a supervisor.`,
        );
      }

      const currency = toCurrencyCode(counter.currency);
      const float = countSheet(body.denominations, currency);
      const limit = moneyFromDb(counter.float_limit, currency);
      if (limit.isPositive && float.total.greaterThan(limit)) {
        throw AppError.conflict(
          `The opening float ${float.total.toDecimalString()} is above this counter's limit of ${limit.toDecimalString()}.`,
        );
      }

      const businessDate = await tx.one<{ business_date: string }>(
        `SELECT (timezone(COALESCE(b.timezone, h.timezone), now()))::date::text AS business_date
           FROM core.branches b JOIN core.hospitals h ON h.id = b.hospital_id
          WHERE b.id = $1`,
        [counter.branch_id],
      );

      const shift = await tx.one<ShiftRow>(
        `INSERT INTO billing.cash_shifts
           (id, hospital_id, branch_id, counter_id, cashier_user_id, business_date, status,
            opening_float, float_source, previous_shift_id, currency, expected_cash,
            created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::date, 'open'::billing."CashShiftStatus",
                 $7::numeric, $8, $9, $10, $7::numeric, $5, now())
         RETURNING ${SHIFT_COLUMNS}`,
        [
          newId(),
          ctx.hospitalId,
          counter.branch_id,
          counter.id,
          userId,
          businessDate.business_date,
          float.total.toDecimalString(),
          body.floatSource,
          body.previousShiftId ?? null,
          currency,
        ],
      );

      await recordDenominationSheet(tx, shift, 'opening', float.lines, float.total, userId);
      await recordDrawerEvent(tx, shift, 'float', userId, null, 'shift opened');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'billing.cash_shifts',
        rowId: shift.id,
        businessKey: counter.code,
        dataClass: 'financial',
        before: null,
        after: { counterId: counter.id, openingFloat: float.total.toDecimalString(), status: 'open' },
      });
      await this.outbox.publish(
        tx,
        cashEvent('cash.shift.opened', shift.id, {
          shiftId: shift.id,
          counterId: counter.id,
          cashierUserId: userId,
          openingFloat: float.total.toDecimalString(),
        }),
      );

      return this.viewOf(tx, shift, null);
    });
  }

  /** NC-001 §3.6 — count the drawer and close, or park the shift for approval. */
  async close(shiftId: string, body: CloseShiftRequest): Promise<ShiftView> {
    const ctx = getContext();
    const userId = ctx.userId ?? '';

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const shift = await loadShift(tx, shiftId, { forUpdate: true });
      if (shift.status === 'closed' || shift.status === 'force_closed') {
        throw AppError.conflict('This shift is already closed. Corrections go on an adjustment voucher.');
      }
      if (shift.cashier_user_id !== userId) {
        // Closing somebody else's drawer is `receipt.shift.force_close`, which
        // carries step-up and dual custody (NC-001 §3.6.2) and is not
        // implemented here — so it is refused rather than approximated.
        throw new AppError(
          ProblemType.PERMISSION_DENIED,
          'Only the cashier who opened this shift can close it.',
          { nextAction: 'A supervisor must force-close it, which requires two people and a reason.' },
        );
      }

      const currency = toCurrencyCode(shift.currency);
      const totals = await modeTotals(tx, shift.id);

      const pending = await tx.one<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM billing.payment_lines pl
           JOIN billing.payments p ON p.id = pl.payment_id AND p.paid_at = pl.payment_paid_at
          WHERE p.shift_id = $1 AND pl.status = 'pending'`,
        [shift.id],
      );
      if (pending.count > 0) {
        // NC-001 AC3: a UPI that never confirmed is money the hospital does not
        // have. Closing over it books revenue that may never arrive.
        return {
          ...(await this.viewOf(tx, shift, null)),
          pendingConfirmations: pending.count,
          blockedBy: 'pending_confirmations',
        };
      }

      const counted = countSheet(body.denominations, currency);
      const expected = expectedCashOf(shift, totals);
      const variance = counted.total.subtract(expected);

      await recordDenominationSheet(tx, shift, 'closing', counted.lines, counted.total, userId);
      await recordDrawerEvent(tx, shift, 'count', userId, null, 'shift close count');

      if (!variance.isZero) {
        if (body.varianceReason === undefined) {
          throw new AppError(
            ProblemType.BUSINESS_RULE_VIOLATED,
            `The drawer is ${variance.toDecimalString()} against an expected ${expected.toDecimalString()}. A variance needs a reason.`,
            { nextAction: 'Recount, then explain the difference and ask a supervisor to approve it.' },
          );
        }

        const alreadyApproved =
          shift.variance_approved_by !== null &&
          shift.variance !== null &&
          moneyFromDb(shift.variance, currency).equals(variance);

        if (!alreadyApproved) {
          const parked = await tx.one<ShiftRow>(
            `UPDATE billing.cash_shifts
                SET status = 'closing'::billing."CashShiftStatus",
                    counted_cash = $2::numeric, expected_cash = $3::numeric, variance = $4::numeric,
                    variance_reason = $5,
                    variance_approved_by = NULL,
                    updated_at = now(), updated_by = $6, version = version + 1
              WHERE id = $1
              RETURNING ${SHIFT_COLUMNS}`,
            [
              shift.id,
              counted.total.toDecimalString(),
              expected.toDecimalString(),
              variance.toDecimalString(),
              body.varianceReason,
              userId,
            ],
          );

          await this.audit.write(tx, {
            action: 'update',
            entity: 'billing.cash_shifts',
            rowId: shift.id,
            businessKey: shift.id,
            dataClass: 'financial',
            before: { status: shift.status, variance: shift.variance },
            after: { status: 'closing', variance: variance.toDecimalString() },
            reasonText: body.varianceReason,
          });

          return { ...(await this.viewOf(tx, parked, totals)), blockedBy: 'variance_approval' };
        }
      }

      const closed = await tx.one<ShiftRow>(
        `UPDATE billing.cash_shifts
            SET status = 'closed'::billing."CashShiftStatus", closed_at = now(), closed_by = $6,
                counted_cash = $2::numeric, expected_cash = $3::numeric, variance = $4::numeric,
                variance_reason = COALESCE($5, variance_reason),
                handover_to = $7, handover_bag_no = $8, handover_received_by = $9,
                updated_at = now(), updated_by = $6, version = version + 1
          WHERE id = $1
          RETURNING ${SHIFT_COLUMNS}`,
        [
          shift.id,
          counted.total.toDecimalString(),
          expected.toDecimalString(),
          variance.toDecimalString(),
          body.varianceReason ?? null,
          userId,
          body.handoverTo ?? null,
          body.handoverBagNo ?? null,
          body.handoverReceivedBy ?? null,
        ],
      );

      if (body.handoverTo !== undefined && counted.total.isPositive) {
        await tx.query(
          `INSERT INTO billing.cash_handovers
             (id, hospital_id, branch_id, from_shift_id, to_main_cash, amount, currency, bag_no,
              given_by, given_at, status, created_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, now(), 'pending', $9, now())`,
          [
            newId(),
            shift.hospital_id,
            shift.branch_id,
            shift.id,
            body.handoverTo === 'main_cash',
            counted.total.toDecimalString(),
            currency,
            body.handoverBagNo ?? null,
            userId,
          ],
        );
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'billing.cash_shifts',
        rowId: shift.id,
        businessKey: shift.id,
        dataClass: 'financial',
        before: { status: shift.status },
        after: {
          status: 'closed',
          counted: counted.total.toDecimalString(),
          expected: expected.toDecimalString(),
          variance: variance.toDecimalString(),
        },
        reasonText: body.varianceReason ?? null,
      });
      await this.outbox.publish(
        tx,
        cashEvent('cash.shift.closed', shift.id, {
          shiftId: shift.id,
          declared: counted.total.toDecimalString(),
          expected: expected.toDecimalString(),
          variance: variance.toDecimalString(),
        }),
      );

      return this.viewOf(tx, closed, totals);
    });
  }

  /** NC-001 §3.6 / §5 — a variance is approved by somebody other than the cashier. */
  async approveVariance(shiftId: string): Promise<ShiftView> {
    const ctx = getContext();
    const userId = ctx.userId ?? '';

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const shift = await loadShift(tx, shiftId, { forUpdate: true });

      if (shift.cashier_user_id === userId) {
        throw new AppError(
          ProblemType.SEGREGATION_OF_DUTIES,
          'A cashier may not approve the variance on their own shift.',
          {
            nextAction: 'Ask the head cashier or finance to approve it.',
          },
        );
      }
      if (shift.variance === null || moneyFromDb(shift.variance, toCurrencyCode(shift.currency)).isZero) {
        throw AppError.conflict('This shift has no variance to approve.');
      }
      if (shift.status !== 'closing') {
        throw AppError.conflict(
          `A variance can only be approved while the shift is closing; this one is ${shift.status}.`,
        );
      }

      const approved = await tx.one<ShiftRow>(
        `UPDATE billing.cash_shifts
            SET variance_approved_by = $2, updated_at = now(), updated_by = $2, version = version + 1
          WHERE id = $1
          RETURNING ${SHIFT_COLUMNS}`,
        [shift.id, userId],
      );

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'billing.cash_shifts',
        rowId: shift.id,
        businessKey: shift.id,
        dataClass: 'financial',
        before: { varianceApprovedBy: null },
        after: { varianceApprovedBy: userId, variance: shift.variance },
        reasonText: ctx.reason,
      });

      return this.viewOf(tx, approved, null);
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async viewOf(
    tx: TransactionClient,
    shift: ShiftRow,
    known: readonly ModeTotal[] | null,
  ): Promise<ShiftView> {
    const totals = known ?? (await modeTotals(tx, shift.id));
    const currency = toCurrencyCode(shift.currency);
    const expected = expectedCashOf(shift, totals);
    const pending = await tx.one<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM billing.payment_lines pl
         JOIN billing.payments p ON p.id = pl.payment_id AND p.paid_at = pl.payment_paid_at
        WHERE p.shift_id = $1 AND pl.status = 'pending'`,
      [shift.id],
    );

    return {
      id: shift.id,
      counterId: shift.counter_id,
      branchId: shift.branch_id,
      cashierUserId: shift.cashier_user_id,
      businessDate: shift.business_date,
      status: shift.status,
      currency,
      openingFloat: moneyFromDb(shift.opening_float, currency).toDecimalString(),
      expectedCash: expected.toDecimalString(),
      countedCash:
        shift.counted_cash === null ? null : moneyFromDb(shift.counted_cash, currency).toDecimalString(),
      variance: shift.variance === null ? null : moneyFromDb(shift.variance, currency).toDecimalString(),
      varianceReason: shift.variance_reason,
      varianceApprovedBy: shift.variance_approved_by,
      receiptsCount: shift.receipts_count,
      voidsCount: shift.voids_count,
      refundsCount: shift.refunds_count,
      openedAt: shift.opened_at,
      closedAt: shift.closed_at,
      totals,
      pendingConfirmations: pending.count,
      blockedBy: null,
    };
  }
}
