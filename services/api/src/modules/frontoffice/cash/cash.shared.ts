import { Money, newId, type CurrencyCode } from '@vims/contracts';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { moneyFromDb, toCurrencyCode } from './cash.money.js';

/** A cashier shift as every path in this module reads it. */
export interface ShiftRow {
  readonly id: string;
  readonly hospital_id: string;
  readonly branch_id: string;
  readonly counter_id: string;
  readonly cashier_user_id: string;
  readonly business_date: string;
  readonly status: string;
  readonly opening_float: string;
  readonly currency: string;
  readonly expected_cash: string;
  readonly counted_cash: string | null;
  readonly variance: string | null;
  readonly variance_reason: string | null;
  readonly variance_approved_by: string | null;
  readonly receipts_count: number;
  readonly voids_count: number;
  readonly refunds_count: number;
  readonly opened_at: Date;
  readonly closed_at: Date | null;
  readonly version: number;
}

export const SHIFT_COLUMNS = `id, hospital_id, branch_id, counter_id, cashier_user_id,
       business_date::text AS business_date, status::text AS status, opening_float::text AS opening_float,
       currency, expected_cash::text AS expected_cash, counted_cash::text AS counted_cash,
       variance::text AS variance, variance_reason, variance_approved_by,
       receipts_count, voids_count, refunds_count, opened_at, closed_at, version`;

export interface CounterRow {
  readonly id: string;
  readonly branch_id: string;
  readonly code: string;
  readonly counter_type: string;
  readonly allowed_modes: string[] | null;
  readonly float_limit: string;
  readonly currency: string;
  readonly receipt_series_key: string;
  readonly is_active: boolean;
  readonly is_virtual: boolean;
}

export const COUNTER_COLUMNS = `id, branch_id, code, counter_type::text AS counter_type,
       allowed_modes::text[] AS allowed_modes, float_limit::text AS float_limit, currency,
       receipt_series_key, is_active, is_virtual`;

export async function loadCounter(tx: TransactionClient, counterId: string): Promise<CounterRow> {
  const counter = await tx.maybeOne<CounterRow>(
    `SELECT ${COUNTER_COLUMNS} FROM billing.cash_counters WHERE id = $1 AND deleted_at IS NULL`,
    [counterId],
  );
  // RLS has already removed another hospital's counter, so "absent" covers both
  // "no such counter" and "not yours" — and the caller cannot tell which
  // (docs/09 §3.1 case 2).
  if (counter === undefined) throw AppError.notFound('The counter');
  return counter;
}

export async function loadShift(
  tx: TransactionClient,
  shiftId: string,
  options: { forUpdate: boolean },
): Promise<ShiftRow> {
  const shift = await tx.maybeOne<ShiftRow>(
    `SELECT ${SHIFT_COLUMNS} FROM billing.cash_shifts WHERE id = $1${options.forUpdate ? ' FOR UPDATE' : ''}`,
    [shiftId],
  );
  if (shift === undefined) throw AppError.notFound('The shift');
  return shift;
}

export interface ModeTotal {
  readonly mode: string;
  readonly collections: string;
  readonly refunds: string;
  readonly advances: string;
  readonly voids: string;
  readonly count: number;
  readonly pending_confirmation_amount: string;
}

export async function modeTotals(tx: TransactionClient, shiftId: string): Promise<ModeTotal[]> {
  return tx.rows<ModeTotal>(
    `SELECT mode::text AS mode, collections::text AS collections, refunds::text AS refunds,
            advances::text AS advances, voids::text AS voids, count,
            pending_confirmation_amount::text AS pending_confirmation_amount
       FROM billing.cash_shift_totals WHERE shift_id = $1 ORDER BY mode`,
    [shiftId],
  );
}

/**
 * Expected cash in the drawer: opening float + cash taken − cash paid back.
 *
 * Derived from the event-sourced per-mode totals rather than kept as a running
 * column somebody could edit — NC-001 §5: "shift totals derived from payment
 * events, never edited by hand".
 */
export function expectedCashOf(shift: ShiftRow, totals: readonly ModeTotal[]): Money {
  const currency = toCurrencyCode(shift.currency);
  const cash = totals.find((t) => t.mode === 'cash');
  let expected = moneyFromDb(shift.opening_float, currency);
  if (cash !== undefined) {
    expected = expected.add(moneyFromDb(cash.collections, currency));
    expected = expected.subtract(moneyFromDb(cash.refunds, currency));
    expected = expected.subtract(moneyFromDb(cash.voids, currency));
  }
  return expected;
}

export interface TotalsDelta {
  readonly collections?: Money;
  readonly refunds?: Money;
  readonly advances?: Money;
  readonly voids?: Money;
  readonly pending?: Money;
  readonly countDelta?: number;
}

/** Applies a signed delta to one `(shift, mode)` row, creating it on first use. */
export async function applyModeDelta(
  tx: TransactionClient,
  shift: ShiftRow,
  mode: string,
  delta: TotalsDelta,
  currency: CurrencyCode,
): Promise<void> {
  const zero = Money.zero(currency);
  await tx.query(
    `INSERT INTO billing.cash_shift_totals
       (id, hospital_id, shift_id, mode, collections, refunds, advances, voids, count,
        pending_confirmation_amount, currency, updated_at)
     VALUES ($1, $2, $3, $4::billing."PaymentMode", $5::numeric, $6::numeric, $7::numeric, $8::numeric, $9,
             $10::numeric, $11, now())
     ON CONFLICT (shift_id, mode) DO UPDATE
       SET collections = billing.cash_shift_totals.collections + EXCLUDED.collections,
           refunds     = billing.cash_shift_totals.refunds     + EXCLUDED.refunds,
           advances    = billing.cash_shift_totals.advances    + EXCLUDED.advances,
           voids       = billing.cash_shift_totals.voids       + EXCLUDED.voids,
           count       = billing.cash_shift_totals.count       + EXCLUDED.count,
           pending_confirmation_amount = billing.cash_shift_totals.pending_confirmation_amount
                                       + EXCLUDED.pending_confirmation_amount,
           updated_at  = now()`,
    [
      newId(),
      shift.hospital_id,
      shift.id,
      mode,
      (delta.collections ?? zero).toDecimalString(),
      (delta.refunds ?? zero).toDecimalString(),
      (delta.advances ?? zero).toDecimalString(),
      (delta.voids ?? zero).toDecimalString(),
      delta.countDelta ?? 0,
      (delta.pending ?? zero).toDecimalString(),
      currency,
    ],
  );
}

/**
 * NC-001 §5 and §3.10: every drawer opening is logged, with or without a sale.
 *
 * "Drawer opens without a sale above a threshold" is one of the three named
 * fraud indicators, and it can only be computed if the boring case is recorded
 * too.
 */
export async function recordDrawerEvent(
  tx: TransactionClient,
  shift: ShiftRow,
  reason: 'sale' | 'refund' | 'no_sale' | 'change' | 'float' | 'count',
  actorId: string | null,
  receiptId: string | null,
  note: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO billing.cash_drawer_events
       (id, hospital_id, branch_id, counter_id, shift_id, reason, triggered_by, receipt_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      newId(),
      shift.hospital_id,
      shift.branch_id,
      shift.counter_id,
      shift.id,
      reason,
      actorId,
      receiptId,
      note,
    ],
  );
}

/** Writes a denomination sheet and returns its id. */
export async function recordDenominationSheet(
  tx: TransactionClient,
  shift: ShiftRow,
  kind: 'opening' | 'closing' | 'handover' | 'deposit' | 'night_envelope',
  lines: readonly { denomination: string; count: number; amount: string }[],
  total: Money,
  countedBy: string,
): Promise<string> {
  const id = newId();
  await tx.query(
    `INSERT INTO billing.cash_denomination_sheets
       (id, hospital_id, branch_id, shift_id, kind, currency, lines, total, counted_by)
     VALUES ($1, $2, $3, $4, $5::billing."DenominationSheetKind", $6, $7::jsonb, $8::numeric, $9)`,
    [
      id,
      shift.hospital_id,
      shift.branch_id,
      shift.id,
      kind,
      total.currency,
      JSON.stringify(lines),
      total.toDecimalString(),
      countedBy,
    ],
  );
  return id;
}
