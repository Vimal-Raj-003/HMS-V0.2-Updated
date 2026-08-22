import { Inject, Injectable } from '@nestjs/common';
import { Money, ProblemType, newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { cashEvent } from './cash.events.js';
import { assertSplitBalances, moneyFromDb, toCurrencyCode } from './cash.money.js';
import {
  applyModeDelta,
  expectedCashOf,
  loadCounter,
  loadShift,
  modeTotals,
  recordDrawerEvent,
  type ShiftRow,
} from './cash.shared.js';
import { CoSignService } from './cosign.service.js';
import type { CollectPaymentRequest, PayRefundRequest, VoidReceiptRequest } from './cash.schemas.js';

export interface PaymentLineView {
  readonly mode: string;
  readonly amount: string;
  readonly status: string;
  readonly reference: string | null;
}

export interface PaymentView {
  readonly id: string;
  readonly receiptNo: string;
  readonly seriesKey: string;
  readonly kind: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly shiftId: string;
  readonly counterId: string;
  readonly patientId: string | null;
  readonly advanceId: string | null;
  readonly paidAt: Date;
  readonly lines: readonly PaymentLineView[];
}

export interface RefundView {
  readonly id: string;
  readonly refundNo: string;
  readonly amount: string;
  readonly currency: string;
  readonly mode: string;
  readonly status: string;
  readonly shiftId: string | null;
  readonly processedAt: Date | null;
}

interface PaymentRow {
  readonly id: string;
  readonly receipt_no: string;
  readonly series_key: string;
  readonly kind: string;
  readonly amount: string;
  readonly currency: string;
  readonly status: string;
  readonly shift_id: string | null;
  readonly counter_id: string | null;
  readonly patient_id: string | null;
  readonly paid_at: Date;
  /**
   * `paid_at` rendered by PostgreSQL, kept verbatim.
   *
   * `billing.payments` is partitioned on `paid_at` and its primary key is
   * `(id, paid_at)`, so both the child rows and every later update have to name
   * it exactly. A JavaScript `Date` cannot: `timestamptz(6)` holds microseconds
   * and a `Date` holds milliseconds, so a value read into Node and written back
   * matches nothing — the void would update zero rows, and a payment line
   * written from the truncated value would never join back to its own receipt.
   * The text round-trips exactly.
   */
  readonly paid_at_key: string;
  readonly voided_at: Date | null;
}

const PAYMENT_COLUMNS = `id, receipt_no, series_key, kind::text AS kind, amount::text AS amount, currency,
       status::text AS status, shift_id, counter_id, patient_id, paid_at, paid_at::text AS paid_at_key,
       voided_at`;

/**
 * NC-001 §3.3–§3.5 — taking money, paying it back, and unmaking a receipt.
 *
 * Four rules are enforced here and nowhere else:
 *
 * **Split tenders must balance.** The sum of the lines equals the receipt, in
 * minor units, at write time.
 *
 * **§269ST.** Cash from one payer on one business date is capped at ₹2,00,000.
 * The running total is a row in `billing.cash_payer_day_totals`, incremented
 * inside this transaction: the `ON CONFLICT DO UPDATE ... RETURNING` takes the
 * row lock, so two counters collecting from the same payer at the same instant
 * cannot each see ₹1,50,000 and each accept ₹60,000. Exceeding the cap rolls the
 * whole receipt back — including the number, which is why the number is
 * allocated in this transaction rather than before it.
 *
 * **Receipt numbers are gapless.** `NumberingService.allocate` runs inside the
 * caller's transaction and holds the series row lock until commit, so a receipt
 * that fails for any reason — the cap, a bad line, a dropped connection — gives
 * its number back instead of leaving a hole an auditor will ask about.
 *
 * **Money out needs two people.** `receipt.refund.pay` and `receipt.void` are
 * both `requiresSecondPerson`; see `CoSignService` for how that is discharged
 * and why the route decorator cannot be the key itself.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
    @Inject(CoSignService) private readonly cosign: CoSignService,
  ) {}

  /** NC-001 §3.3 — collect at the counter and issue the receipt. */
  async collect(body: CollectPaymentRequest, idempotencyKey: string | null): Promise<PaymentView> {
    const ctx = getContext();
    const userId = ctx.userId ?? '';

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      if (idempotencyKey !== null) {
        const replay = await tx.maybeOne<PaymentRow>(
          `SELECT ${PAYMENT_COLUMNS} FROM billing.payments WHERE idempotency_key = $1`,
          [idempotencyKey],
        );
        // NC-001 §3.3.2: "duplicate submissions return the same receipt" — the
        // patient must never be charged twice because a tablet retried.
        if (replay !== undefined) return this.viewOf(tx, replay, null);
      }

      const shift = await loadShift(tx, body.shiftId, { forUpdate: true });
      if (shift.status !== 'open') {
        throw AppError.conflict(`Shift is ${shift.status}; a payment can only be taken on an open shift.`);
      }
      if (shift.cashier_user_id !== userId) {
        throw new AppError(
          ProblemType.PERMISSION_DENIED,
          'A payment can only be recorded on your own open shift.',
        );
      }

      const counter = await loadCounter(tx, shift.counter_id);
      const currency = toCurrencyCode(shift.currency);
      const total = Money.parse(body.amount, currency);

      const allowed = counter.allowed_modes ?? [];
      for (const line of body.lines) {
        if (allowed.length > 0 && !allowed.includes(line.mode)) {
          throw AppError.conflict(`Counter ${counter.code} does not accept ${line.mode}.`);
        }
      }
      assertSplitBalances(
        total,
        body.lines.map((line) => Money.parse(line.amount, currency)),
      );

      if (body.kind === 'advance' && body.patientId === undefined) {
        throw AppError.conflict('An advance must be collected against a patient.');
      }

      // ── §269ST, before the money is recorded ─────────────────────────────
      const cash = body.lines
        .filter((line) => line.mode === 'cash')
        .reduce((sum, line) => sum.add(Money.parse(line.amount, currency)), Money.zero(currency));

      if (cash.isPositive) {
        const payerRefId = body.payerRefId ?? body.patientId;
        if (payerRefId === undefined) {
          throw new AppError(
            ProblemType.STATUTORY_LIMIT,
            'Cash cannot be accepted without identifying the payer: §269ST is a per-payer daily limit.',
            { nextAction: 'Record the patient or the paying party, or take the payment digitally.' },
          );
        }
        await this.assertCashCap(tx, shift, body.payerType, payerRefId, cash, currency);
      }

      // ── the number, inside this transaction, so a failure returns it ─────
      const paymentId = newId();
      const allocation = await this.numbering.allocate(tx, {
        key: counter.receipt_series_key,
        branchId: shift.branch_id,
        refType: 'billing.payments',
        refId: paymentId,
      });

      const payment = await tx.one<PaymentRow>(
        `INSERT INTO billing.payments
           (id, hospital_id, branch_id, receipt_no, series_key, patient_id, visit_id, appointment_id,
            purpose, kind, amount, currency, status, counter_id, shift_id, cashier_id,
            payer_name, remarks, idempotency_key, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 $9, $10::billing."PaymentKind", $11::numeric, $12, 'confirmed'::billing."PaymentStatus",
                 $13, $14, $15, $16, $17, $18, $15, now())
         RETURNING ${PAYMENT_COLUMNS}`,
        [
          paymentId,
          shift.hospital_id,
          shift.branch_id,
          allocation.formatted,
          counter.receipt_series_key,
          body.patientId ?? null,
          body.visitId ?? null,
          body.appointmentId ?? null,
          body.purpose,
          body.kind === 'advance' ? 'advance' : 'payment',
          total.toDecimalString(),
          currency,
          counter.id,
          shift.id,
          userId,
          body.payerName ?? null,
          body.remarks ?? null,
          idempotencyKey,
        ],
      );

      for (const line of body.lines) {
        const amount = Money.parse(line.amount, currency);
        const tendered = line.tendered === undefined ? null : Money.parse(line.tendered, currency);
        if (tendered !== null && tendered.lessThan(amount)) {
          throw AppError.conflict('The cash tendered is less than the amount being collected.');
        }
        await tx.query(
          `INSERT INTO billing.payment_lines
             (id, hospital_id, branch_id, payment_id, payment_paid_at, mode, amount, currency,
              tendered, change_given, reference, gateway_txn_id, card_last4, card_network, bank,
              cheque_date, status, confirmed_at, created_by, updated_at)
           VALUES ($1, $2, $3, $4, $5::timestamptz, $6::billing."PaymentMode", $7::numeric, $8,
                   $9::numeric, $10::numeric, $11, $12, $13, $14, $15,
                   $16::date, $17::billing."PaymentStatus", $18, $19, now())`,
          [
            newId(),
            shift.hospital_id,
            shift.branch_id,
            payment.id,
            payment.paid_at_key,
            line.mode,
            amount.toDecimalString(),
            currency,
            tendered?.toDecimalString() ?? null,
            tendered === null ? null : tendered.subtract(amount).toDecimalString(),
            line.reference ?? null,
            line.gatewayTxnId ?? null,
            line.cardLast4 ?? null,
            line.cardNetwork ?? null,
            line.bank ?? null,
            line.chequeDate ?? null,
            line.pending ? 'pending' : 'confirmed',
            line.pending ? null : new Date(),
            userId,
          ],
        );

        await applyModeDelta(
          tx,
          shift,
          line.mode,
          {
            collections: amount,
            countDelta: 1,
            ...(body.kind === 'advance' ? { advances: amount } : {}),
            ...(line.pending ? { pending: amount } : {}),
          },
          currency,
        );
      }

      let advanceId: string | null = null;
      if (body.kind === 'advance' && body.patientId !== undefined) {
        advanceId = newId();
        await tx.query(
          `INSERT INTO billing.advances
             (id, hospital_id, branch_id, advance_no, patient_id, payment_id, payment_paid_at,
              visit_id, appointment_id, amount, balance, currency, purpose, status, created_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9, $10::numeric, $10::numeric, $11, $12,
                   'open', $13, now())`,
          [
            advanceId,
            shift.hospital_id,
            shift.branch_id,
            // NC-001 §3.11 allows the advance to share the `RECEIPT` series; a
            // separate `ADV` series is a hospital configuration decision, and
            // inventing one here would mint numbers in a shape the hospital's
            // accountant has never seen.
            allocation.formatted,
            body.patientId,
            payment.id,
            payment.paid_at_key,
            body.visitId ?? null,
            body.appointmentId ?? null,
            total.toDecimalString(),
            currency,
            body.purpose.slice(0, 24),
            userId,
          ],
        );
      }

      await tx.query(
        `UPDATE billing.cash_shifts
            SET receipts_count = receipts_count + 1, updated_at = now(), version = version + 1
          WHERE id = $1`,
        [shift.id],
      );

      if (cash.isPositive) {
        await recordDrawerEvent(tx, shift, 'sale', userId, payment.id, null);
      }

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'billing.payments',
        rowId: payment.id,
        businessKey: payment.receipt_no,
        dataClass: 'financial',
        before: null,
        after: {
          amount: total.toDecimalString(),
          modes: body.lines.map((line) => line.mode),
          shiftId: shift.id,
        },
        patientId: body.patientId ?? null,
      });
      await this.outbox.publish(
        tx,
        cashEvent('receipt.issued', payment.id, {
          receiptId: payment.id,
          receiptNo: payment.receipt_no,
          patientId: body.patientId ?? null,
          amount: total.toDecimalString(),
          modes: body.lines.map((line) => line.mode),
          shiftId: shift.id,
        }),
      );

      return this.viewOf(tx, payment, advanceId);
    });
  }

  /** NC-001 §3.5 — pay an approved refund out of the drawer. */
  async payRefund(refundId: string, body: PayRefundRequest): Promise<RefundView> {
    const ctx = getContext();
    const userId = ctx.userId ?? '';

    const amountForPolicy = await this.db.withTenant(currentTenantContext(), (tx) =>
      tx.maybeOne<{ amount: string }>(`SELECT amount::text AS amount FROM billing.refunds WHERE id = $1`, [
        refundId,
      ]),
    );
    if (amountForPolicy === undefined) throw AppError.notFound('The refund');

    const coSignerId = await this.cosign.authorise('receipt.refund.pay', body.coSigner, {
      amount: amountForPolicy.amount,
    });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const refund = await tx.maybeOne<{
        id: string;
        refund_no: string;
        amount: string;
        currency: string;
        mode: string;
        status: string;
        patient_id: string | null;
        payment_id: string | null;
        approved_by: string | null;
      }>(
        `SELECT id, refund_no, amount::text AS amount, currency, mode::text AS mode,
                status::text AS status, patient_id, payment_id, approved_by
           FROM billing.refunds WHERE id = $1 FOR UPDATE`,
        [refundId],
      );
      if (refund === undefined) throw AppError.notFound('The refund');

      if (refund.status !== 'approved') {
        throw AppError.conflict(`This refund is ${refund.status}; only an approved refund can be paid out.`);
      }
      if (refund.approved_by === null) {
        throw new AppError(
          ProblemType.APPROVAL_REQUIRED,
          'This refund carries no approver and cannot be paid.',
        );
      }
      if (refund.approved_by === userId) {
        // NC-001 §3.5: "segregation requester ≠ approver"; paying out one's own
        // approval collapses the control back to a single pair of hands.
        throw new AppError(
          ProblemType.SEGREGATION_OF_DUTIES,
          'The person who approved a refund may not also pay it out.',
        );
      }
      if (refund.payment_id === null) {
        throw AppError.conflict('This refund does not reference the receipt it reverses.');
      }

      const shift = await loadShift(tx, body.shiftId, { forUpdate: true });
      if (shift.status !== 'open') throw AppError.conflict(`Shift is ${shift.status}.`);
      if (shift.cashier_user_id !== userId) {
        throw new AppError(ProblemType.PERMISSION_DENIED, 'A refund is paid from your own open shift.');
      }

      const currency = toCurrencyCode(shift.currency);
      const amount = moneyFromDb(refund.amount, currency);

      if (refund.mode === 'cash') {
        const available = expectedCashOf(shift, await modeTotals(tx, shift.id));
        if (available.lessThan(amount)) {
          // NC-001 §5: "refund never exceeds drawer cash for cash mode".
          throw AppError.conflict(
            `The drawer holds ${available.toDecimalString()}; this refund of ${amount.toDecimalString()} must come from main cash.`,
          );
        }
      }

      const paid = await tx.one<{ processed_at: Date }>(
        `UPDATE billing.refunds
            SET status = 'processed'::billing."RefundStatus", counter_id = $2, shift_id = $3,
                cashier_id = $4, processed_at = now(), identity_verified_by = $4,
                identity_method = $5, updated_at = now(), updated_by = $4, version = version + 1
          WHERE id = $1
          RETURNING processed_at`,
        [refund.id, shift.counter_id, shift.id, userId, body.identityMethod],
      );

      await applyModeDelta(tx, shift, refund.mode, { refunds: amount }, currency);
      await tx.query(
        `UPDATE billing.cash_shifts
            SET refunds_count = refunds_count + 1, updated_at = now(), version = version + 1
          WHERE id = $1`,
        [shift.id],
      );
      if (refund.mode === 'cash') {
        await recordDrawerEvent(tx, shift, 'refund', userId, refund.payment_id, refund.refund_no);
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'billing.refunds',
        rowId: refund.id,
        businessKey: refund.refund_no,
        dataClass: 'financial',
        before: { status: refund.status },
        after: {
          status: 'processed',
          amount: amount.toDecimalString(),
          shiftId: shift.id,
          coSignedBy: coSignerId,
        },
        patientId: refund.patient_id,
        reasonText: ctx.reason,
      });
      await this.outbox.publish(
        tx,
        cashEvent('refund.issued', refund.id, {
          refundId: refund.id,
          receiptId: refund.payment_id,
          amount: amount.toDecimalString(),
          approvedBy: refund.approved_by,
        }),
      );

      return {
        id: refund.id,
        refundNo: refund.refund_no,
        amount: amount.toDecimalString(),
        currency,
        mode: refund.mode,
        status: 'processed',
        shiftId: shift.id,
        processedAt: paid.processed_at,
      };
    });
  }

  /** NC-001 §3.3.4 — void a receipt before the shift closes. The number is kept. */
  async voidReceipt(paymentId: string, body: VoidReceiptRequest): Promise<PaymentView> {
    const ctx = getContext();
    const userId = ctx.userId ?? '';

    const amountForPolicy = await this.db.withTenant(currentTenantContext(), (tx) =>
      tx.maybeOne<{ amount: string }>(`SELECT amount::text AS amount FROM billing.payments WHERE id = $1`, [
        paymentId,
      ]),
    );
    if (amountForPolicy === undefined) throw AppError.notFound('The receipt');

    const coSignerId = await this.cosign.authorise('receipt.void', body.coSigner, {
      amount: amountForPolicy.amount,
    });

    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const payment = await tx.maybeOne<PaymentRow>(
        `SELECT ${PAYMENT_COLUMNS} FROM billing.payments WHERE id = $1 FOR UPDATE`,
        [paymentId],
      );
      if (payment === undefined) throw AppError.notFound('The receipt');
      if (payment.status !== 'confirmed' || payment.voided_at !== null) {
        throw AppError.conflict(`Receipt ${payment.receipt_no} is ${payment.status} and cannot be voided.`);
      }
      if (payment.shift_id === null) {
        throw AppError.conflict('This receipt was not taken at a counter shift.');
      }

      const shift = await loadShift(tx, payment.shift_id, { forUpdate: true });
      if (shift.status !== 'open') {
        // NC-001 §3.3.4: after the close, the correction is a refund with a
        // credit note — the closed shift's totals are evidence and are not
        // rewritten.
        throw AppError.conflict(
          'The shift that issued this receipt is no longer open. Raise a refund instead of a void.',
        );
      }
      if (shift.cashier_user_id !== userId) {
        throw new AppError(
          ProblemType.PERMISSION_DENIED,
          'A receipt is voided on the shift that issued it, by the cashier holding it.',
        );
      }

      const currency = toCurrencyCode(payment.currency);
      const amount = moneyFromDb(payment.amount, currency);

      const voided = await tx.one<PaymentRow>(
        `UPDATE billing.payments
            SET status = 'voided'::billing."PaymentStatus", voided_at = now(),
                updated_at = now(), updated_by = $3, version = version + 1
          WHERE id = $1 AND paid_at = $2::timestamptz
          RETURNING ${PAYMENT_COLUMNS}`,
        [payment.id, payment.paid_at_key, userId],
      );

      const lines = await tx.rows<{ mode: string; amount: string }>(
        `UPDATE billing.payment_lines
            SET status = 'voided'::billing."PaymentStatus", updated_at = now(), version = version + 1
          WHERE payment_id = $1 AND payment_paid_at = $2::timestamptz
          RETURNING mode::text AS mode, amount::text AS amount`,
        [payment.id, payment.paid_at_key],
      );

      let cashVoided = false;
      for (const line of lines) {
        if (line.mode === 'cash') cashVoided = true;
        await applyModeDelta(tx, shift, line.mode, { voids: moneyFromDb(line.amount, currency) }, currency);
      }

      await tx.query(
        `INSERT INTO billing.cash_receipt_voids
           (id, hospital_id, receipt_id, shift_id, amount, reason, voided_by, approved_by)
         VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8)`,
        [
          newId(),
          shift.hospital_id,
          payment.id,
          shift.id,
          amount.toDecimalString(),
          body.reason,
          userId,
          coSignerId,
        ],
      );
      await tx.query(
        `UPDATE billing.cash_shifts
            SET voids_count = voids_count + 1, updated_at = now(), version = version + 1
          WHERE id = $1`,
        [shift.id],
      );
      if (cashVoided) {
        await recordDrawerEvent(tx, shift, 'refund', userId, payment.id, 'void');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'billing.payments',
        rowId: payment.id,
        businessKey: payment.receipt_no,
        dataClass: 'financial',
        before: { status: payment.status },
        after: { status: 'voided', coSignedBy: coSignerId },
        patientId: payment.patient_id,
        reasonText: body.reason,
      });
      await this.outbox.publish(
        tx,
        cashEvent('receipt.voided', payment.id, {
          receiptId: payment.id,
          reason: body.reason,
          approvedBy: coSignerId,
        }),
      );

      return this.viewOf(tx, voided, null);
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Income-tax §269ST: no person may *receive* ₹2,00,000 or more in cash from
   * one person in one day.
   *
   * The running total is incremented and read back under the row lock the upsert
   * takes, so the check cannot be raced across counters. A receipt that breaches
   * the cap throws, which rolls back the increment along with the receipt — the
   * hospital's exposure is never recorded as accepted.
   *
   * Note what is deliberately absent: nothing here ever *decrements* the running
   * total. A refund or a void does not restore headroom, because "pay ₹2 lakh,
   * take ₹1 lakh back, pay ₹1 lakh again" is exactly the split the section
   * exists to forbid. The conservative direction is the legal one.
   */
  private async assertCashCap(
    tx: TransactionClient,
    shift: ShiftRow,
    payerType: string,
    payerRefId: string,
    cash: Money,
    currency: ReturnType<typeof toCurrencyCode>,
  ): Promise<void> {
    const row = await tx.one<{ cash_total: string; cap_amount: string }>(
      `INSERT INTO billing.cash_payer_day_totals
         (id, hospital_id, branch_id, business_date, payer_type, payer_ref_id,
          cash_total, receipt_count, currency, updated_at)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7::numeric, 1, $8, now())
       ON CONFLICT (hospital_id, business_date, payer_type, payer_ref_id) DO UPDATE
         SET cash_total    = billing.cash_payer_day_totals.cash_total + EXCLUDED.cash_total,
             receipt_count = billing.cash_payer_day_totals.receipt_count + 1,
             updated_at    = now()
       RETURNING cash_total::text AS cash_total, cap_amount::text AS cap_amount`,
      [
        newId(),
        shift.hospital_id,
        shift.branch_id,
        shift.business_date,
        payerType,
        payerRefId,
        cash.toDecimalString(),
        currency,
      ],
    );

    const total = moneyFromDb(row.cash_total, currency);
    const cap = moneyFromDb(row.cap_amount, currency);
    // `>=`, not `>`. §269ST forbids receiving "two lakh rupees **or more**", so
    // the cap amount itself is already a breach, and §271DA's penalty is equal
    // to the whole sum received -- the boundary rupee costs ₹2,00,000.
    if (total.greaterThanOrEqual(cap)) {
      throw new AppError(
        ProblemType.STATUTORY_LIMIT,
        `Cash from this payer today would reach ${total.toDecimalString()}, which meets or exceeds the §269ST limit of ${cap.toDecimalString()}.`,
        {
          clinicalImpact: 'None — care is unaffected; only the tender is refused.',
          nextAction: 'Take the balance by card, UPI, cheque or bank transfer.',
        },
      );
    }
  }

  private async viewOf(
    tx: TransactionClient,
    payment: PaymentRow,
    advanceId: string | null,
  ): Promise<PaymentView> {
    const lines = await tx.rows<PaymentLineView>(
      `SELECT mode::text AS mode, amount::text AS amount, status::text AS status, reference
         FROM billing.payment_lines
        WHERE payment_id = $1 AND payment_paid_at = $2::timestamptz
        ORDER BY created_at`,
      [payment.id, payment.paid_at_key],
    );

    return {
      id: payment.id,
      receiptNo: payment.receipt_no,
      seriesKey: payment.series_key,
      kind: payment.kind,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      shiftId: payment.shift_id ?? '',
      counterId: payment.counter_id ?? '',
      patientId: payment.patient_id,
      advanceId,
      paidAt: payment.paid_at,
      lines,
    };
  }
}
