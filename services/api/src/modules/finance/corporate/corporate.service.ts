import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import type {
  AgeingQuery,
  AgeingRow,
  CancelInvoiceRequest,
  CorporateAccountRow,
  FollowupRow,
  InvoiceRow,
  RaiseInvoiceRequest,
  RecordFollowupRequest,
  SetHoldRequest,
  UpsertAccountRequest,
  WriteOffRequest,
} from './corporate.schemas.js';

/**
 * NC-012 + RC-005 — what a company owes, and getting it.
 *
 * ── The amounts come from the bills, not from the caller ──────────────────
 *
 * `raiseInvoice` takes bill ids and reads the money out of `billing.bills`. A
 * request field for the amount would be a way for the invoice to disagree with
 * the bills it names, and the client reconciling the two would be right and
 * the hospital wrong.
 *
 * ── And the refusals belong to the database ───────────────────────────────
 *
 * Credit limit, hold, one-invoice-per-bill, maker-checker on a write-off: all
 * constraints and triggers. This service translates them; it does not
 * re-implement them, because a second copy disagrees with the first the moment
 * somebody writes a path that skips this file.
 */

function asText(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function asTextOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}
function asMoney(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return v.toFixed(2);
  return '0.00';
}
function asDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return typeof v === 'string' ? v.slice(0, 10) : '';
}

/**
 * The dunning ladder, as days overdue.
 *
 * Deliberately gentle at the top: the commonest reason a corporate invoice is
 * unpaid at day 10 is that it has not reached the right desk, and a legal
 * notice for that costs more than the invoice. Escalation is for the ones that
 * survive a reminder and a statement.
 */
const LADDER: readonly { readonly from: number; readonly stage: number; readonly action: string }[] = [
  { from: 90, stage: 4, action: 'Escalate: legal notice or collection agency, with approval.' },
  { from: 60, stage: 3, action: 'Call the finance contact and put the account on hold for new credit.' },
  { from: 30, stage: 2, action: 'Send a statement of account and call.' },
  { from: 7, stage: 1, action: 'Send a reminder — most of these have simply not reached the right desk.' },
  { from: 0, stage: 0, action: 'Not yet due for chasing.' },
];

function ladderFor(daysOverdue: number): { stage: number; action: string } {
  for (const rung of LADDER) {
    if (daysOverdue >= rung.from) return { stage: rung.stage, action: rung.action };
  }
  return { stage: 0, action: LADDER[LADDER.length - 1]?.action ?? '' };
}

function translate(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message;

  if ((code === 'NC012' || code === 'RC005') && typeof message === 'string') {
    throw AppError.conflict(message);
  }
  if (code === '23505' && typeof message === 'string') {
    if (message.includes('uq_bill_invoiced_once')) {
      throw AppError.conflict(
        'At least one of those bills is already on a corporate invoice. Billing a company twice for one admission is the fastest way to lose the contract, so the database refuses it — cancel the earlier invoice if it was wrong.',
      );
    }
    if (message.includes('uq_corporate_account_payer')) {
      throw AppError.conflict('That payer already has a corporate account.');
    }
    if (message.includes('uq_corporate_invoice_no')) {
      throw AppError.conflict('That invoice number has already been used.');
    }
  }
  if (code === '23514' && typeof message === 'string') {
    if (message.includes('a_write_off_needs_a_second_person')) {
      throw AppError.conflict(
        'A write-off cannot be approved by the person who requested it. Bad debt is where money leaves a hospital quietly; the second person is the control.',
      );
    }
    if (message.includes('a_hold_says_why')) {
      throw AppError.conflict('Say why the account is on hold, or nobody will know when to lift it.');
    }
    if (message.includes('a_settlement_never_exceeds_the_invoice')) {
      throw AppError.conflict('That would settle more than the invoice is for.');
    }
  }
  throw error;
}

@Injectable()
export class CorporateService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {}

  // ── Accounts ─────────────────────────────────────────────────────────────

  async listAccounts(): Promise<readonly CorporateAccountRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT a.id, a.payer_id, a.code, a.name, a.credit_limit::text, a.payment_terms_days,
                a.on_hold, a.hold_reason,
                coalesce((
                  SELECT sum(i.net_amount - i.paid_amount - i.tds_deducted - i.written_off)
                    FROM finance.corporate_invoices i
                   WHERE i.account_id = a.id
                     AND i.status NOT IN ('cancelled', 'paid', 'written_off')
                ), 0)::numeric(16,2)::text AS exposure
           FROM finance.corporate_accounts a
          WHERE a.active = true
          ORDER BY a.name`,
      );
      return result.rows.map((r) => {
        const limit = asMoney(r['credit_limit']);
        const exposure = asMoney(r['exposure']);
        return {
          id: asText(r['id']),
          payerId: asText(r['payer_id']),
          code: asText(r['code']),
          name: asText(r['name']),
          creditLimit: limit,
          paymentTermsDays: Number(r['payment_terms_days']),
          onHold: r['on_hold'] === true,
          holdReason: asTextOrNull(r['hold_reason']),
          exposure,
          // Negative headroom is possible and is not an error: a limit can be
          // lowered below what is already outstanding, and hiding that would
          // be the one moment it mattered.
          headroom: (Number(limit) - Number(exposure)).toFixed(2),
        };
      });
    });
  }

  async upsertAccount(body: UpsertAccountRequest): Promise<CorporateAccountRow> {
    const id = newId();
    await this.db
      .withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `INSERT INTO finance.corporate_accounts
             (id, hospital_id, payer_id, code, name, credit_limit, payment_terms_days, tds_applicable, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8, now())
           ON CONFLICT (hospital_id, payer_id) DO UPDATE
             SET code = EXCLUDED.code, name = EXCLUDED.name,
                 credit_limit = EXCLUDED.credit_limit,
                 payment_terms_days = EXCLUDED.payment_terms_days,
                 tds_applicable = EXCLUDED.tds_applicable,
                 updated_at = now()`,
          [
            id,
            getContext().hospitalId,
            body.payerId,
            body.code,
            body.name,
            body.creditLimit,
            body.paymentTermsDays,
            body.tdsApplicable,
          ],
        );
        await this.audit.write(tx, {
          action: 'update',
          entity: 'fin_corporate_account',
          rowId: id,
          businessKey: body.code,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: getContext().reason ?? null,
          before: null,
          after: { code: body.code, creditLimit: body.creditLimit },
        });
      })
      .catch(translate);

    const all = await this.listAccounts();
    const row = all.find((a) => a.payerId === body.payerId);
    if (row === undefined) throw AppError.notFound('The account was not found after saving.');
    return row;
  }

  async setHold(accountId: string, body: SetHoldRequest): Promise<CorporateAccountRow> {
    await this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const result = await tx.query(
          `UPDATE finance.corporate_accounts
              SET on_hold = $2, hold_reason = CASE WHEN $2 THEN $3 ELSE NULL END, updated_at = now()
            WHERE id = $1`,
          [accountId, body.onHold, body.holdReason ?? null],
        );
        if (result.rowCount === 0) throw AppError.notFound('That corporate account does not exist.');

        await this.audit.write(tx, {
          action: 'update',
          entity: 'fin_corporate_account',
          rowId: accountId,
          businessKey: null,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: body.holdReason ?? getContext().reason ?? null,
          before: null,
          after: { onHold: body.onHold },
        });
      })
      .catch(translate);

    const all = await this.listAccounts();
    const row = all.find((a) => a.id === accountId);
    if (row === undefined) throw AppError.notFound('That corporate account does not exist.');
    return row;
  }

  // ── Invoices ─────────────────────────────────────────────────────────────

  /**
   * Consolidates finalised bills into one invoice.
   *
   * The bills are re-read here and their money is taken from the rows, not
   * from the request. A caller who could state the amount could state one that
   * differs from the bill it names, and the client who reconciles the two
   * would be right.
   */
  async raiseInvoice(body: RaiseInvoiceRequest): Promise<InvoiceRow> {
    const invoiceId = newId();
    const ctx = getContext();

    return this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const account = await tx.query<{ payment_terms_days: number }>(
          `SELECT payment_terms_days FROM finance.corporate_accounts WHERE id = $1 AND active = true`,
          [body.accountId],
        );
        const terms = account.rows[0]?.payment_terms_days;
        if (terms === undefined) throw AppError.notFound('That corporate account does not exist.');

        // Only finalised, uncancelled bills, and only ones that belong to this
        // hospital — RLS guarantees the last, the WHERE says the rest.
        const bills = await tx.query<Record<string, unknown>>(
          `SELECT id, bill_no, patient_id, net_amount, gross_amount,
                  (cgst + sgst + igst + cess) AS tax_amount, finalized_at
             FROM billing.bills
            WHERE id = ANY($1::uuid[])
              AND status = 'finalized'
              AND cancelled_at IS NULL`,
          [body.billIds],
        );
        if (bills.rows.length === 0) {
          throw AppError.conflict(
            'None of those bills can be invoiced. A bill must be finalised and not cancelled before it can go to a company.',
          );
        }
        if (bills.rows.length !== body.billIds.length) {
          throw AppError.conflict(
            `${String(body.billIds.length - bills.rows.length)} of the ${String(body.billIds.length)} bills are not finalised or have been cancelled, so the invoice was not raised. Consolidating a partial list silently would leave the rest unbilled.`,
          );
        }

        let gross = 0;
        let tax = 0;
        let net = 0;
        for (const bill of bills.rows) {
          gross += Number(asMoney(bill['gross_amount']));
          tax += Number(asMoney(bill['tax_amount']));
          net += Number(asMoney(bill['net_amount']));
        }

        // Gapless per branch per FY: a company's accounts payable files these
        // and their auditor asks about a gap.
        const allocation = await this.numbering.allocate(tx, {
          key: 'CORP_INVOICE',
          branchId: ctx.branchId ?? undefined,
          refType: 'corporate_invoice',
          refId: invoiceId,
        });
        const invoiceNo = allocation.formatted;

        await tx.query(
          `INSERT INTO finance.corporate_invoices
             (id, hospital_id, branch_id, account_id, invoice_no, invoice_date, due_on,
              period_from, period_to, gross_amount, tax_amount, net_amount, created_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6::date, ($6::date + $7::int),
                   $8::date, $9::date, $10::numeric, $11::numeric, $12::numeric, $13, now())`,
          [
            invoiceId,
            ctx.hospitalId,
            ctx.branchId,
            body.accountId,
            invoiceNo,
            body.invoiceDate,
            terms,
            body.periodFrom ?? null,
            body.periodTo ?? null,
            gross.toFixed(2),
            tax.toFixed(2),
            net.toFixed(2),
            ctx.userId,
          ],
        );

        for (const bill of bills.rows) {
          await tx.query(
            `INSERT INTO finance.corporate_invoice_lines
               (id, hospital_id, invoice_id, bill_id, patient_id, bill_no, service_date,
                gross_amount, tax_amount, net_amount)
             VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::numeric,$9::numeric,$10::numeric)`,
            [
              newId(),
              ctx.hospitalId,
              invoiceId,
              asText(bill['id']),
              asTextOrNull(bill['patient_id']),
              asTextOrNull(bill['bill_no']),
              bill['finalized_at'] instanceof Date ? bill['finalized_at'].toISOString().slice(0, 10) : null,
              asMoney(bill['gross_amount']),
              asMoney(bill['tax_amount']),
              asMoney(bill['net_amount']),
            ],
          );
        }

        await this.audit.write(tx, {
          action: 'insert',
          entity: 'fin_corporate_invoice',
          rowId: invoiceId,
          businessKey: invoiceNo,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: null,
          before: null,
          after: { invoiceNo, bills: bills.rows.length, net: net.toFixed(2) },
        });

        return await this.readInvoice(tx, invoiceId);
      })
      .catch(translate);
  }

  async listInvoices(accountId?: string): Promise<readonly InvoiceRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const ids = await tx.query<{ id: string }>(
        `SELECT id FROM finance.corporate_invoices
          WHERE ($1::uuid IS NULL OR account_id = $1::uuid)
          ORDER BY invoice_date DESC, invoice_no DESC
          LIMIT 200`,
        [accountId ?? null],
      );
      const out: InvoiceRow[] = [];
      for (const row of ids.rows) out.push(await this.readInvoice(tx, row.id));
      return out;
    });
  }

  /**
   * Cancels an invoice so its bills can be consolidated again.
   *
   * Refused once anything has been settled against it. A cancelled invoice
   * with a payment on it is a payment against nothing, and the client's
   * remittance advice no longer matches anything the hospital holds.
   */
  async cancelInvoice(invoiceId: string, body: CancelInvoiceRequest): Promise<InvoiceRow> {
    const ctx = getContext();
    return this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const current = await tx.query<Record<string, unknown>>(
          `SELECT status, paid_amount::text, tds_deducted::text, written_off::text
             FROM finance.corporate_invoices WHERE id = $1`,
          [invoiceId],
        );
        const row = current.rows[0];
        if (row === undefined) throw AppError.notFound('That invoice does not exist.');
        if (asText(row['status']) === 'cancelled') {
          throw AppError.conflict('That invoice is already cancelled.');
        }
        const settled =
          Number(asMoney(row['paid_amount'])) +
          Number(asMoney(row['tds_deducted'])) +
          Number(asMoney(row['written_off']));
        if (settled > 0) {
          throw AppError.conflict(
            `₹${settled.toFixed(2)} has already been settled against this invoice, so it cannot be cancelled. Raise a credit note instead — a cancelled invoice carrying a payment is a payment against nothing.`,
          );
        }

        await tx.query(
          `UPDATE finance.corporate_invoices
              SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
                  cancel_reason = $3, updated_at = now()
            WHERE id = $1`,
          [invoiceId, ctx.userId, body.cancelReason],
        );
        // The lines go with it, which is what frees the bills: the partial
        // unique index counts lines, not invoices.
        await tx.query(`DELETE FROM finance.corporate_invoice_lines WHERE invoice_id = $1`, [invoiceId]);

        await this.audit.write(tx, {
          action: 'delete',
          entity: 'fin_corporate_invoice',
          rowId: invoiceId,
          businessKey: null,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: body.cancelReason,
          before: { status: asText(row['status']) },
          after: { status: 'cancelled' },
        });

        return await this.readInvoice(tx, invoiceId);
      })
      .catch(translate);
  }

  // ── Collections ──────────────────────────────────────────────────────────

  /**
   * The worklist, worst first.
   *
   * Ordered by how overdue rather than by how large: a ₹2,000 invoice at 120
   * days is a relationship that has stopped working, and a ₹200,000 one at 10
   * days is a company whose accounts payable runs fortnightly.
   */
  async ageing(query: AgeingQuery): Promise<readonly AgeingRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT invoice_id, invoice_no, account_code, account_name, due_on,
                outstanding::text, days_overdue, bucket
           FROM finance.v_corporate_ageing
          WHERE ($1::uuid IS NULL OR account_id = $1::uuid)
            AND ($2::text IS NULL OR bucket = $2::text)
            AND outstanding > 0
          ORDER BY days_overdue DESC, outstanding DESC
          LIMIT $3`,
        [query.accountId ?? null, query.bucket ?? null, query.limit],
      );
      return result.rows.map((r) => {
        const daysOverdue = Number(r['days_overdue'] ?? 0);
        const rung = ladderFor(daysOverdue);
        return {
          invoiceId: asText(r['invoice_id']),
          invoiceNo: asText(r['invoice_no']),
          accountCode: asText(r['account_code']),
          accountName: asText(r['account_name']),
          dueOn: asDate(r['due_on']),
          outstanding: asMoney(r['outstanding']),
          daysOverdue,
          bucket: asText(r['bucket']),
          dunningStage: rung.stage,
          nextAction: rung.action,
        };
      });
    });
  }

  async recordFollowup(invoiceId: string, body: RecordFollowupRequest): Promise<FollowupRow> {
    const id = newId();
    return this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const overdue = await tx.query<{ days_overdue: number }>(
          `SELECT GREATEST((current_date - due_on), 0) AS days_overdue
             FROM finance.corporate_invoices WHERE id = $1`,
          [invoiceId],
        );
        const days = overdue.rows[0]?.days_overdue;
        if (days === undefined) throw AppError.notFound('That invoice does not exist.');

        // Stamped at the time. The ladder can be reconfigured, and the history
        // must still say what stage this attempt actually was.
        const stage = ladderFor(Number(days)).stage;

        await tx.query(
          `INSERT INTO finance.ar_followups
             (id, hospital_id, invoice_id, by_user_id, channel, dunning_stage, outcome,
              promised_on, promised_amount, note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::numeric,$10)`,
          [
            id,
            getContext().hospitalId,
            invoiceId,
            getContext().userId,
            body.channel,
            stage,
            body.outcome,
            body.promisedOn ?? null,
            body.promisedAmount ?? null,
            body.note ?? null,
          ],
        );

        const result = await tx.query<Record<string, unknown>>(
          `SELECT id, at, channel, outcome, dunning_stage, promised_on,
                  promised_amount::text, note
             FROM finance.ar_followups WHERE id = $1`,
          [id],
        );
        const row = result.rows[0];
        if (row === undefined) throw AppError.notFound('The follow-up was not recorded.');
        return {
          id: asText(row['id']),
          at: row['at'] instanceof Date ? row['at'].toISOString() : '',
          channel: asText(row['channel']),
          outcome: asText(row['outcome']),
          dunningStage: Number(row['dunning_stage']),
          promisedOn: row['promised_on'] instanceof Date ? asDate(row['promised_on']) : null,
          promisedAmount: asTextOrNull(row['promised_amount']),
          note: asTextOrNull(row['note']),
        };
      })
      .catch(translate);
  }

  async listFollowups(invoiceId: string): Promise<readonly FollowupRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const result = await tx.query<Record<string, unknown>>(
        `SELECT id, at, channel, outcome, dunning_stage, promised_on, promised_amount::text, note
           FROM finance.ar_followups WHERE invoice_id = $1 ORDER BY at DESC`,
        [invoiceId],
      );
      return result.rows.map((r) => ({
        id: asText(r['id']),
        at: r['at'] instanceof Date ? r['at'].toISOString() : '',
        channel: asText(r['channel']),
        outcome: asText(r['outcome']),
        dunningStage: Number(r['dunning_stage']),
        promisedOn: r['promised_on'] instanceof Date ? asDate(r['promised_on']) : null,
        promisedAmount: asTextOrNull(r['promised_amount']),
        note: asTextOrNull(r['note']),
      }));
    });
  }

  /**
   * Writes a debt off.
   *
   * The approver is the authenticated caller and `requestedBy` comes from the
   * body, so the database's `approved_by <> requested_by` CHECK is doing real
   * work rather than comparing a value to itself.
   */
  async writeOff(invoiceId: string, body: WriteOffRequest): Promise<InvoiceRow> {
    const ctx = getContext();
    return this.db
      .withTenant(currentTenantContext(), async (tx) => {
        await tx.query(
          `INSERT INTO finance.ar_write_offs
             (id, hospital_id, invoice_id, amount, reason, requested_by, approved_by)
           VALUES ($1,$2,$3,$4::numeric,$5,$6,$7)`,
          [newId(), ctx.hospitalId, invoiceId, body.amount, body.reason, body.requestedBy, ctx.userId],
        );

        await this.audit.write(tx, {
          action: 'approve',
          entity: 'fin_ar_write_off',
          rowId: invoiceId,
          businessKey: null,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: body.reason,
          before: null,
          after: { amount: body.amount, requestedBy: body.requestedBy },
        });

        return await this.readInvoice(tx, invoiceId);
      })
      .catch(translate);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async readInvoice(tx: TransactionClient, id: string): Promise<InvoiceRow> {
    const result = await tx.query<Record<string, unknown>>(
      `SELECT i.id, i.invoice_no, i.account_id, i.invoice_date, i.due_on,
              i.net_amount::text, i.paid_amount::text, i.tds_deducted::text,
              i.written_off::text, i.status,
              (i.net_amount - i.paid_amount - i.tds_deducted - i.written_off)::numeric(16,2)::text AS outstanding,
              (SELECT count(*) FROM finance.corporate_invoice_lines l WHERE l.invoice_id = i.id)::int AS line_count
         FROM finance.corporate_invoices i WHERE i.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw AppError.notFound('That invoice does not exist.');
    return {
      id: asText(row['id']),
      invoiceNo: asText(row['invoice_no']),
      accountId: asText(row['account_id']),
      invoiceDate: asDate(row['invoice_date']),
      dueOn: asDate(row['due_on']),
      netAmount: asMoney(row['net_amount']),
      paidAmount: asMoney(row['paid_amount']),
      tdsDeducted: asMoney(row['tds_deducted']),
      writtenOff: asMoney(row['written_off']),
      outstanding: asMoney(row['outstanding']),
      status: asText(row['status']),
      lineCount: Number(row['line_count'] ?? 0),
    };
  }
}
