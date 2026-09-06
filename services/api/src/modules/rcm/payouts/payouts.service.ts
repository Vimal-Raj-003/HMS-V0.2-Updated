import { Inject, Injectable } from '@nestjs/common';
import { newId, type Page } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { NumberingService } from '../../../core/numbering/numbering.service.js';
import { OutboxService } from '../../../core/outbox/outbox.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import { payoutEvent } from './payouts.events.js';
import { withPayoutErrors } from './payouts.errors.js';
import type {
  ApproveStatementRequest,
  ComputePeriodRequest,
  ContractQuery,
  CreateContractRequest,
  CreateRuleRequest,
  OpenPeriodRequest,
  PayStatementRequest,
  PeriodQuery,
  RaiseDisputeRequest,
  ResolveDisputeRequest,
  StatementQuery,
  TdsQuery,
} from './payouts.schemas.js';
import type {
  ComputeResultView,
  PayoutContractView,
  PayoutPeriodView,
  PayoutStatementDetailView,
  PayoutStatementView,
  PayoutTdsView,
} from './payouts.types.js';

function asText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  return '';
}
function asTextOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : asText(v);
}
function asNumber(v: unknown): number {
  return typeof v === 'number' ? v : Number(asText(v));
}
function asDay(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : asText(v);
}
function money(n: number): string {
  return n.toFixed(2);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Section 194J: 10% on professional fees, 20% with no PAN (section 206AA). */
const TDS_RATE_WITH_PAN = 10;
const TDS_RATE_NO_PAN = 20;
/** Per payee per financial year. Below it, nothing is deducted. */
const TDS_ANNUAL_THRESHOLD = 30_000;

/** India's financial year runs April to March. */
function financialYearOf(date: Date): string {
  const y = date.getUTCFullYear();
  const startYear = date.getUTCMonth() >= 3 ? y : y - 1;
  return `${String(startYear)}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/**
 * NC-034 — doctor payouts.
 *
 * ── The anti-kickback guard is below this service, not in it ────────────────
 *
 * `phase-05` §5.7 asks that no per-referral payment be *representable*. This
 * file cannot deliver that on its own — a rule it enforced would be a rule the
 * next module forgets. What makes it true is the trigger on
 * `billing.payout_lines`: a line whose bill item names the earning doctor as the
 * referrer, with somebody else as the performer, is refused by Postgres.
 *
 * What this service adds is that the refusal is *counted* rather than swallowed.
 * `computePeriod` catches it, raises `payout.referral.refused`, and reports the
 * number — because a rule that keeps trying to pay for referrals is a compliance
 * problem, and a silent skip would hide it.
 *
 * ── TDS is cumulative ───────────────────────────────────────────────────────
 *
 * 194J's ₹30,000 threshold and 206AA's no-PAN rate both depend on the year to
 * date, so the running total is stored rather than recomputed each month. A
 * figure recomputed from a sum drifts, and the one place that must never drift
 * is the one that gets filed.
 */
@Injectable()
export class PayoutsService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(NumberingService) private readonly numbering: NumberingService,
  ) {}

  private hospitalId(): string {
    const id = getContext().hospitalId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }
  private branchId(): string {
    const id = getContext().branchId;
    if (id === null || id === undefined) {
      throw AppError.conflict('This action needs a branch. Choose one and try again.');
    }
    return id;
  }
  private actorId(): string {
    const id = getContext().userId;
    if (id === null) throw AppError.unauthenticated();
    return id;
  }

  private guard<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return withPayoutErrors(() => this.db.withTenant(currentTenantContext(), fn));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Contracts and rules
  // ═══════════════════════════════════════════════════════════════════════════

  async listContracts(query: ContractQuery): Promise<Page<PayoutContractView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT c.*, (SELECT count(*) FROM billing.payout_rules r WHERE r.contract_id = c.id) AS rule_count
           FROM billing.payout_contracts c
          WHERE c.hospital_id = $1
            AND ($2::uuid IS NULL OR c.doctor_id = $2)
            AND (NOT $3::boolean OR c.is_active)
          ORDER BY c.effective_from DESC
          LIMIT $4`,
        [this.hospitalId(), query.doctorId ?? null, query.activeOnly, query.limit],
      );
      return {
        items: rows.map((r) => this.toContract(r, [])),
        nextCursor: null,
        hasMore: false,
      };
    });
  }

  private toContract(
    r: Record<string, unknown>,
    rules: ReadonlyArray<Record<string, unknown>>,
  ): PayoutContractView {
    return {
      id: asText(r['id']),
      doctorId: asText(r['doctor_id']),
      registrationNo: asTextOrNull(r['registration_no']),
      model: asText(r['model']),
      monthlyRetainer: asTextOrNull(r['monthly_retainer']),
      sessionRate: asTextOrNull(r['session_rate']),
      panOnRecord: Boolean(r['pan_on_record']),
      tdsRatePct: asText(r['tds_rate_pct']),
      effectiveFrom: asDay(r['effective_from']) ?? '',
      effectiveTo: asDay(r['effective_to']),
      isActive: Boolean(r['is_active']),
      ruleCount: asNumber(r['rule_count'] ?? rules.length),
      rules: rules.map((x) => ({
        id: asText(x['id']),
        name: asText(x['name']),
        basis: asText(x['basis']),
        serviceId: asTextOrNull(x['service_id']),
        departmentId: asTextOrNull(x['department_id']),
        payerType: asTextOrNull(x['payer_type']),
        itemType: asTextOrNull(x['item_type']),
        sharePct: asTextOrNull(x['share_pct']),
        flatAmount: asTextOrNull(x['flat_amount']),
        priority: asNumber(x['priority']),
        isActive: Boolean(x['is_active']),
      })),
    };
  }

  async createContract(body: CreateContractRequest): Promise<PayoutContractView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const id = newId();
      // 206AA: no PAN on record means 20%, not 10%.
      const tdsRate = body.panOnRecord ? TDS_RATE_WITH_PAN : TDS_RATE_NO_PAN;

      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.payout_contracts
           (id, hospital_id, branch_id, doctor_id, registration_no, model,
            monthly_retainer, session_rate, pan_on_record, tds_rate_pct, tds_exemption_ref,
            effective_from, effective_to, notes, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6::"billing"."PayoutModel",
                 $7::numeric,$8::numeric,$9,$10::numeric,$11,
                 $12::date,$13::date,$14, now(),$15, now(),$15)
         RETURNING *`,
        [
          id,
          hospital,
          this.branchId(),
          body.doctorId,
          body.registrationNo ?? null,
          body.model,
          body.monthlyRetainer === undefined ? null : body.monthlyRetainer.toFixed(2),
          body.sessionRate === undefined ? null : body.sessionRate.toFixed(2),
          body.panOnRecord,
          tdsRate.toFixed(2),
          body.tdsExemptionRef ?? null,
          body.effectiveFrom,
          body.effectiveTo ?? null,
          body.notes ?? null,
          this.actorId(),
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The contract could not be created.');

      await this.audit.write(tx, {
        action: 'insert',
        entity: 'payout_contract',
        rowId: id,
        businessKey: body.registrationNo ?? body.doctorId,
        dataClass: 'hr',
        before: null,
        after: { model: body.model, tdsRatePct: tdsRate },
        reasonText: body.reason,
      });

      return this.loadContract(tx, id);
    });
  }

  private async loadContract(tx: TransactionClient, id: string): Promise<PayoutContractView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.payout_contracts WHERE id = $1 AND hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Payout contract');

    const { rows: rules } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.payout_rules WHERE contract_id = $1 ORDER BY priority DESC, name`,
      [id],
    );
    return this.toContract({ ...row, rule_count: rules.length }, rules);
  }

  async createRule(body: CreateRuleRequest): Promise<PayoutContractView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const ruleId = newId();

      await tx.query(
        `INSERT INTO billing.payout_rules
           (id, hospital_id, contract_id, name, basis, service_id, department_id, payer_type, item_type,
            share_pct, flat_amount, priority, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5::"billing"."PayoutBasis",$6,$7,$8,$9,
                 $10::numeric,$11::numeric,$12, now(),$13, now(),$13)`,
        [
          ruleId,
          hospital,
          body.contractId,
          body.name,
          body.basis,
          body.serviceId ?? null,
          body.departmentId ?? null,
          body.payerType ?? null,
          body.itemType ?? null,
          body.sharePct === undefined ? null : body.sharePct.toFixed(2),
          body.flatAmount === undefined ? null : body.flatAmount.toFixed(2),
          body.priority,
        ].concat([this.actorId()]),
      );

      for (const slab of body.slabs) {
        await tx.query(
          `INSERT INTO billing.payout_slabs (id, hospital_id, rule_id, from_amount, to_amount, share_pct, created_at)
           VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6::numeric, now())`,
          [
            newId(),
            hospital,
            ruleId,
            slab.fromAmount.toFixed(2),
            slab.toAmount === undefined ? null : slab.toAmount.toFixed(2),
            slab.sharePct.toFixed(2),
          ],
        );
      }

      return this.loadContract(tx, body.contractId);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Periods
  // ═══════════════════════════════════════════════════════════════════════════

  async listPeriods(query: PeriodQuery): Promise<Page<PayoutPeriodView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.payout_periods WHERE hospital_id = $1
          ORDER BY period_from DESC LIMIT $2`,
        [this.hospitalId(), query.limit],
      );
      return { items: rows.map((r) => this.toPeriod(r)), nextCursor: null, hasMore: false };
    });
  }

  private toPeriod(r: Record<string, unknown>): PayoutPeriodView {
    return {
      id: asText(r['id']),
      label: asText(r['label']),
      periodFrom: asDay(r['period_from']) ?? '',
      periodTo: asDay(r['period_to']) ?? '',
      status: asText(r['status']),
      statementCount: asNumber(r['statement_count']),
      grossTotal: asText(r['gross_total']),
      tdsTotal: asText(r['tds_total']),
      netTotal: asText(r['net_total']),
      computedAt: asTextOrNull(r['computed_at']),
      paidAt: asTextOrNull(r['paid_at']),
    };
  }

  async openPeriod(body: OpenPeriodRequest): Promise<PayoutPeriodView> {
    return this.guard(async (tx) => {
      const id = newId();
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO billing.payout_periods
           (id, hospital_id, branch_id, label, period_from, period_to, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,$3,$4,$5::date,$6::date, now(),$7, now(),$7)
         ON CONFLICT ("hospital_id","branch_id","period_from","period_to") DO NOTHING
         RETURNING *`,
        [id, this.hospitalId(), this.branchId(), body.label, body.periodFrom, body.periodTo, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('That period is already open.');
      return this.toPeriod(row);
    });
  }

  /**
   * Build every doctor's statement for the period.
   *
   * The join is the whole thing: a candidate earning is a `bill_items` row whose
   * **performing** doctor is the one being paid. A doctor who only referred the
   * work never appears, and if a rule somehow produces such a line the trigger
   * refuses it and we count the attempt.
   */
  async computePeriod(periodId: string, body: ComputePeriodRequest): Promise<ComputeResultView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const branch = this.branchId();
      const actor = this.actorId();

      const { rows: periods } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.payout_periods WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [periodId, hospital],
      );
      const period = periods[0];
      if (period === undefined) throw AppError.notFound('Payout period');
      if (!['open', 'computing', 'computed'].includes(asText(period['status']))) {
        throw AppError.conflict('This period has been approved or paid and cannot be recomputed.');
      }

      const from = asDay(period['period_from']) ?? '';
      const to = asDay(period['period_to']) ?? '';

      const { rows: contracts } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.payout_contracts
          WHERE hospital_id = $1 AND is_active
            AND effective_from <= $3::date
            AND (effective_to IS NULL OR effective_to >= $2::date)
            AND (cardinality($4::uuid[]) = 0 OR doctor_id = ANY($4::uuid[]))
          ORDER BY doctor_id`,
        [hospital, from, to, body.doctorIds],
      );

      let statementsCreated = 0;
      let linesCreated = 0;
      let referralsRefused = 0;
      let grossTotal = 0;
      let tdsTotal = 0;
      let netTotal = 0;
      const statements: PayoutStatementView[] = [];

      for (const contract of contracts) {
        const doctorId = asText(contract['doctor_id']);
        const contractId = asText(contract['id']);

        const { rows: existing } = await tx.query<{ id: string; status: string }>(
          `SELECT id, status::text AS status FROM billing.payout_statements
            WHERE period_id = $1 AND doctor_id = $2`,
          [periodId, doctorId],
        );
        const already = existing[0];
        if (already !== undefined && already.status !== 'draft') {
          // Approved or paid: recomputing would rewrite a number somebody has
          // already signed off, so it is left alone.
          continue;
        }

        const statementId = already?.id ?? newId();
        if (already === undefined) {
          const allocation = await this.numbering.allocate(tx, {
            key: 'PAYOUT',
            branchId: branch,
            refType: 'payout_statement',
            refId: statementId,
          });
          await tx.query(
            `INSERT INTO billing.payout_statements
               (id, hospital_id, branch_id, statement_no, period_id, contract_id, doctor_id,
                status, prepared_by, prepared_at, created_at, updated_at, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',$8, now(), now(), now(),$8)`,
            [statementId, hospital, branch, allocation.formatted, periodId, contractId, doctorId, actor],
          );
        } else {
          await tx.query(`DELETE FROM billing.payout_lines WHERE statement_id = $1`, [statementId]);
        }

        const { rows: rules } = await tx.query<Record<string, unknown>>(
          `SELECT * FROM billing.payout_rules WHERE contract_id = $1 AND is_active
            ORDER BY priority DESC, created_at`,
          [contractId],
        );

        let gross = 0;
        let lines = 0;

        // The retainer, if any, is a line of its own with no bill item behind it.
        const retainer = contract['monthly_retainer'];
        if (retainer !== null && retainer !== undefined) {
          const amount = asNumber(retainer);
          const retainerRule = rules.find((r) => asText(r['basis']) === 'monthly_retainer');
          if (retainerRule !== undefined && amount > 0) {
            await tx.query(
              `INSERT INTO billing.payout_lines
                 (id, hospital_id, statement_id, rule_id, source_type, source_ref_id, description,
                  base_amount, earned_amount, created_at)
               VALUES ($1,$2,$3,$4,'retainer',NULL,$5,$6::numeric,$6::numeric, now())`,
              [newId(), hospital, statementId, asText(retainerRule['id']), 'Monthly retainer', money(amount)],
            );
            gross += amount;
            lines += 1;
          }
        }

        for (const rule of rules) {
          const basis = asText(rule['basis']);
          if (basis === 'monthly_retainer' || basis === 'per_session') continue;

          // Only what this doctor performed. `performing_doctor_id` is the join,
          // and it is the reason a referral cannot be paid for.
          const { rows: items } = await tx.query<Record<string, unknown>>(
            `SELECT bi.id, bi.description, bi.net, bi.item_type::text AS item_type,
                    bi.service_id, bi.department_id, b.payer_type::text AS payer_type,
                    b.patient_id, bi.created_at
               FROM billing.bill_items bi
               JOIN billing.bills b ON b.id = bi.bill_id
              WHERE bi.hospital_id = $1
                AND bi.performing_doctor_id = $2
                AND b.status NOT IN ('cancelled','void')
                AND bi.created_at >= $3::date
                AND bi.created_at < ($4::date + 1)
                AND ($5::uuid IS NULL OR bi.service_id = $5)
                AND ($6::uuid IS NULL OR bi.department_id = $6)
                AND ($7::text IS NULL OR b.payer_type::text = $7)
                AND ($8::text IS NULL OR bi.item_type::text = $8)
                AND NOT EXISTS (
                  SELECT 1 FROM billing.payout_lines pl
                   WHERE pl.statement_id = $9 AND pl.source_ref_id = bi.id
                )
              ORDER BY bi.created_at`,
            [
              hospital,
              doctorId,
              from,
              to,
              rule['service_id'] ?? null,
              rule['department_id'] ?? null,
              rule['payer_type'] ?? null,
              rule['item_type'] ?? null,
              statementId,
            ],
          );

          for (const item of items) {
            const base = asNumber(item['net']);
            if (base <= 0) continue;

            const sharePct = rule['share_pct'] === null ? null : asNumber(rule['share_pct']);
            const earned =
              basis === 'percent_of_net'
                ? round2((base * (sharePct ?? 0)) / 100)
                : Math.min(base, asNumber(rule['flat_amount']));
            if (earned <= 0) continue;

            try {
              await tx.query(
                `INSERT INTO billing.payout_lines
                   (id, hospital_id, statement_id, rule_id, source_type, source_ref_id, description,
                    service_name, patient_id, base_amount, share_pct, earned_amount, occurred_at, created_at)
                 VALUES ($1,$2,$3,$4,'bill_item',$5,$6,$7,$8,$9::numeric,$10::numeric,$11::numeric,$12, now())`,
                [
                  newId(),
                  hospital,
                  statementId,
                  asText(rule['id']),
                  asText(item['id']),
                  asText(item['description']),
                  asText(item['description']),
                  item['patient_id'] ?? null,
                  money(base),
                  sharePct === null ? null : sharePct.toFixed(2),
                  money(earned),
                  item['created_at'],
                ],
              );
              gross += earned;
              lines += 1;
            } catch (error) {
              // The trigger refused it. That means a rule matched a service this
              // doctor referred rather than performed — which the join above
              // should already prevent, so reaching here is a signal that
              // somebody's rules are trying to pay for referrals. Counted and
              // published rather than swallowed.
              const code = (error as { code?: unknown }).code;
              if (code !== 'NC034') throw error;
              referralsRefused += 1;
              await this.outbox.publish(
                tx,
                payoutEvent('payout.referral.refused', statementId, {
                  statementId,
                  doctorId,
                  billItemId: asText(item['id']),
                  attemptedAmount: money(earned),
                }),
              );
            }
          }
        }

        gross = round2(gross);
        const tds = await this.computeTds(tx, statementId, doctorId, contract, gross, to);
        const net = round2(gross - tds);

        const { rows: updated } = await tx.query<Record<string, unknown>>(
          `UPDATE billing.payout_statements
              SET status = 'computed', gross_earnings = $2::numeric, tds_amount = $3::numeric,
                  net_payable = $4::numeric, line_count = $5, updated_at = now(), updated_by = $6
            WHERE id = $1
            RETURNING *`,
          [statementId, money(gross), money(tds), money(net), lines, actor],
        );
        const stRow = updated[0];
        if (stRow === undefined) throw AppError.conflict('The statement could not be written.');

        statementsCreated += 1;
        linesCreated += lines;
        grossTotal += gross;
        tdsTotal += tds;
        netTotal += net;
        statements.push(this.toStatement(stRow, 0));

        await this.outbox.publish(
          tx,
          payoutEvent('payout.statement.computed', statementId, {
            statementId,
            statementNo: asText(stRow['statement_no']),
            doctorId,
            periodId,
            grossEarnings: money(gross),
            lineCount: lines,
          }),
        );
      }

      await tx.query(
        `UPDATE billing.payout_periods
            SET status = 'computed', computed_at = now(), statement_count = $2,
                gross_total = $3::numeric, tds_total = $4::numeric, net_total = $5::numeric,
                updated_at = now(), updated_by = $6
          WHERE id = $1`,
        [periodId, statementsCreated, money(grossTotal), money(tdsTotal), money(netTotal), actor],
      );

      return {
        periodId,
        statementsCreated,
        linesCreated,
        grossTotal: money(grossTotal),
        tdsTotal: money(tdsTotal),
        netTotal: money(netTotal),
        referralsRefused,
        statements,
      };
    });
  }

  /**
   * Section 194J, against the year to date.
   *
   * Nothing is deducted until the year's professional fees cross ₹30,000, and
   * the rate is 20% rather than 10% where no PAN is on record. Both need the
   * cumulative figure, which is why it is stored on the entry rather than summed
   * at read time — the number that gets filed must not move.
   */
  private async computeTds(
    tx: TransactionClient,
    statementId: string,
    doctorId: string,
    contract: Record<string, unknown>,
    gross: number,
    periodTo: string,
  ): Promise<number> {
    const hospital = this.hospitalId();
    const fy = financialYearOf(new Date(periodTo));
    const panOnRecord = Boolean(contract['pan_on_record']);
    const rate = panOnRecord ? TDS_RATE_WITH_PAN : TDS_RATE_NO_PAN;

    const { rows: prior } = await tx.query<{ ytd: string }>(
      `SELECT COALESCE(sum(gross_this_period), 0) AS ytd
         FROM billing.payout_tds_entries
        WHERE hospital_id = $1 AND doctor_id = $2 AND financial_year = $3 AND statement_id <> $4`,
      [hospital, doctorId, fy, statementId],
    );
    const ytd = round2(asNumber(prior[0]?.ytd ?? 0) + gross);

    // A section 197 certificate means a lower rate the assessing officer set; we
    // record the reference and deduct nothing here rather than guessing at it.
    const exempt = contract['tds_exemption_ref'] !== null && contract['tds_exemption_ref'] !== undefined;
    const deducted = exempt || ytd < TDS_ANNUAL_THRESHOLD ? 0 : round2((gross * rate) / 100);

    await tx.query(
      `INSERT INTO billing.payout_tds_entries
         (id, hospital_id, statement_id, doctor_id, financial_year, gross_this_period, gross_year_to_date,
          threshold_amount, rate_applied, pan_on_record, deducted, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8::numeric,$9::numeric,$10,$11::numeric, now())
       ON CONFLICT ("statement_id") DO UPDATE
         SET gross_this_period = EXCLUDED.gross_this_period,
             gross_year_to_date = EXCLUDED.gross_year_to_date,
             rate_applied = EXCLUDED.rate_applied,
             pan_on_record = EXCLUDED.pan_on_record,
             deducted = EXCLUDED.deducted`,
      [
        newId(),
        hospital,
        statementId,
        doctorId,
        fy,
        money(gross),
        money(ytd),
        money(TDS_ANNUAL_THRESHOLD),
        rate.toFixed(2),
        panOnRecord,
        money(deducted),
      ],
    );

    if (deducted > 0) {
      await this.outbox.publish(
        tx,
        payoutEvent('payout.tds.deducted', statementId, {
          entryId: statementId,
          statementId,
          financialYear: fy,
          rateApplied: rate.toFixed(2),
          deducted: money(deducted),
          panOnRecord,
        }),
      );
    }

    return deducted;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Statements
  // ═══════════════════════════════════════════════════════════════════════════

  async listStatements(query: StatementQuery): Promise<Page<PayoutStatementView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT s.*,
                (SELECT count(*) FROM billing.payout_disputes d
                  WHERE d.statement_id = s.id AND d.status = 'open') AS open_disputes
           FROM billing.payout_statements s
          WHERE s.hospital_id = $1
            AND ($2::uuid IS NULL OR s.period_id = $2)
            AND ($3::uuid IS NULL OR s.doctor_id = $3)
            AND ($4::text IS NULL OR s.status::text = $4)
          ORDER BY s.created_at DESC
          LIMIT $5`,
        [
          this.hospitalId(),
          query.periodId ?? null,
          query.doctorId ?? null,
          query.status ?? null,
          query.limit + 1,
        ],
      );
      const page = rows.slice(0, query.limit);
      return {
        items: page.map((r) => this.toStatement(r, asNumber(r['open_disputes'] ?? 0))),
        nextCursor: null,
        hasMore: rows.length > query.limit,
      };
    });
  }

  private toStatement(r: Record<string, unknown>, openDisputes: number): PayoutStatementView {
    return {
      id: asText(r['id']),
      statementNo: asText(r['statement_no']),
      periodId: asText(r['period_id']),
      doctorId: asText(r['doctor_id']),
      status: asText(r['status']),
      grossEarnings: asText(r['gross_earnings']),
      otherDeductions: asText(r['other_deductions']),
      tdsAmount: asText(r['tds_amount']),
      netPayable: asText(r['net_payable']),
      lineCount: asNumber(r['line_count']),
      preparedBy: asTextOrNull(r['prepared_by']),
      approvedBy: asTextOrNull(r['approved_by']),
      paidAt: asTextOrNull(r['paid_at']),
      paymentRef: asTextOrNull(r['payment_ref']),
      openDisputes,
      createdAt: asText(r['created_at']),
    };
  }

  async getStatement(id: string): Promise<PayoutStatementDetailView> {
    return this.guard((tx) => this.loadStatement(tx, id));
  }

  private async loadStatement(tx: TransactionClient, id: string): Promise<PayoutStatementDetailView> {
    const { rows } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.payout_statements WHERE id = $1 AND hospital_id = $2`,
      [id, this.hospitalId()],
    );
    const row = rows[0];
    if (row === undefined) throw AppError.notFound('Payout statement');

    const { rows: lines } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.payout_lines WHERE statement_id = $1 ORDER BY earned_amount DESC`,
      [id],
    );
    const { rows: disputes } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.payout_disputes WHERE statement_id = $1 ORDER BY raised_at DESC`,
      [id],
    );
    const { rows: tds } = await tx.query<Record<string, unknown>>(
      `SELECT * FROM billing.payout_tds_entries WHERE statement_id = $1`,
      [id],
    );

    return {
      ...this.toStatement(row, disputes.filter((d) => asText(d['status']) === 'open').length),
      lines: lines.map((l) => ({
        id: asText(l['id']),
        sourceType: asText(l['source_type']),
        sourceRefId: asTextOrNull(l['source_ref_id']),
        description: asText(l['description']),
        serviceName: asTextOrNull(l['service_name']),
        baseAmount: asText(l['base_amount']),
        sharePct: asTextOrNull(l['share_pct']),
        earnedAmount: asText(l['earned_amount']),
        occurredAt: asTextOrNull(l['occurred_at']),
      })),
      disputes: disputes.map((d) => ({
        id: asText(d['id']),
        category: asText(d['category']),
        claim: asText(d['claim']),
        claimedAmount: asTextOrNull(d['claimed_amount']),
        status: asText(d['status']),
        resolution: asTextOrNull(d['resolution']),
        adjustment: asTextOrNull(d['adjustment']),
        raisedAt: asText(d['raised_at']),
        resolvedAt: asTextOrNull(d['resolved_at']),
      })),
      tds: tds[0] === undefined ? null : this.toTds(tds[0]),
    };
  }

  private toTds(r: Record<string, unknown>): PayoutTdsView {
    return {
      id: asText(r['id']),
      financialYear: asText(r['financial_year']),
      grossThisPeriod: asText(r['gross_this_period']),
      grossYearToDate: asText(r['gross_year_to_date']),
      thresholdAmount: asText(r['threshold_amount']),
      rateApplied: asText(r['rate_applied']),
      panOnRecord: Boolean(r['pan_on_record']),
      deducted: asText(r['deducted']),
      challanNo: asTextOrNull(r['challan_no']),
    };
  }

  /** The second pair of hands. Refused while a dispute is open — by the database. */
  async approveStatement(id: string, body: ApproveStatementRequest): Promise<PayoutStatementDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows: before } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.payout_statements WHERE id = $1 AND hospital_id = $2 FOR UPDATE`,
        [id, hospital],
      );
      const prior = before[0];
      if (prior === undefined) throw AppError.notFound('Payout statement');
      if (asText(prior['status']) !== 'computed') {
        throw AppError.conflict(`A statement in status "${asText(prior['status'])}" cannot be approved.`);
      }
      if (asTextOrNull(prior['prepared_by']) === actor) {
        throw AppError.conflict(
          'The person who computed a statement cannot also release it. A payout is an outbound payment authorised on a calculation nobody else has checked.',
        );
      }

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.payout_statements
            SET status = 'approved', approved_by = $3, approved_at = now(), updated_at = now(), updated_by = $3
          WHERE id = $1 AND hospital_id = $2
          RETURNING *`,
        [id, hospital, actor],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('The statement could not be approved.');

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'payout_statement',
        rowId: id,
        businessKey: asText(row['statement_no']),
        dataClass: 'financial',
        before: { status: 'computed' },
        after: { status: 'approved', netPayable: asText(row['net_payable']) },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        payoutEvent('payout.statement.approved', id, {
          statementId: id,
          statementNo: asText(row['statement_no']),
          netPayable: asText(row['net_payable']),
          approvedBy: actor,
        }),
      );

      return this.loadStatement(tx, id);
    });
  }

  async payStatement(id: string, body: PayStatementRequest): Promise<PayoutStatementDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.payout_statements
            SET status = 'paid', paid_at = now(), payment_ref = $3, updated_at = now(), updated_by = $4
          WHERE id = $1 AND hospital_id = $2 AND status = 'approved'
          RETURNING *`,
        [id, hospital, body.paymentRef, this.actorId()],
      );
      const row = rows[0];
      if (row === undefined) {
        throw AppError.conflict('Only an approved statement can be paid.');
      }

      await this.audit.write(tx, {
        action: 'update',
        entity: 'payout_statement',
        rowId: id,
        businessKey: asText(row['statement_no']),
        dataClass: 'financial',
        before: { status: 'approved' },
        after: { status: 'paid', paymentRef: body.paymentRef },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        payoutEvent('payout.statement.paid', id, {
          statementId: id,
          statementNo: asText(row['statement_no']),
          doctorId: asText(row['doctor_id']),
          netPayable: asText(row['net_payable']),
          tdsAmount: asText(row['tds_amount']),
          paymentRef: body.paymentRef,
        }),
      );

      return this.loadStatement(tx, id);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Disputes
  // ═══════════════════════════════════════════════════════════════════════════

  async raiseDispute(statementId: string, body: RaiseDisputeRequest): Promise<PayoutStatementDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const id = newId();

      const { rows: st } = await tx.query<{ status: string }>(
        `SELECT status::text AS status FROM billing.payout_statements WHERE id = $1 AND hospital_id = $2`,
        [statementId, hospital],
      );
      const s = st[0];
      if (s === undefined) throw AppError.notFound('Payout statement');
      if (s.status === 'paid') {
        throw AppError.conflict(
          'This statement has already been paid. A correction goes on the next period rather than reopening a payment that has left.',
        );
      }

      await tx.query(
        `INSERT INTO billing.payout_disputes
           (id, hospital_id, statement_id, raised_by, category, claim, claimed_amount, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::numeric, now(), now())`,
        [
          id,
          hospital,
          statementId,
          this.actorId(),
          body.category,
          body.claim,
          body.claimedAmount === undefined ? null : body.claimedAmount.toFixed(2),
        ],
      );

      await tx.query(
        `UPDATE billing.payout_statements SET status = 'disputed', updated_at = now()
          WHERE id = $1 AND status IN ('draft','computed')`,
        [statementId],
      );

      await this.outbox.publish(
        tx,
        payoutEvent('payout.dispute.raised', id, {
          disputeId: id,
          statementId,
          category: body.category,
          claimedAmount: body.claimedAmount === undefined ? null : body.claimedAmount.toFixed(2),
        }),
      );

      return this.loadStatement(tx, statementId);
    });
  }

  async resolveDispute(id: string, body: ResolveDisputeRequest): Promise<PayoutStatementDetailView> {
    return this.guard(async (tx) => {
      const hospital = this.hospitalId();
      const actor = this.actorId();

      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE billing.payout_disputes
            SET status = $3::"billing"."PayoutDisputeStatus", resolution = $4,
                adjustment = $5::numeric, resolved_by = $6, resolved_at = now(), updated_at = now()
          WHERE id = $1 AND hospital_id = $2 AND status = 'open'
          RETURNING *`,
        [
          id,
          hospital,
          body.outcome,
          body.reason,
          body.adjustment === undefined ? null : body.adjustment.toFixed(2),
          actor,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.conflict('Only an open dispute can be settled.');

      const statementId = asText(row['statement_id']);

      // An upheld dispute with an adjustment raises the gross; the statement
      // goes back to `computed` so the approver sees the corrected number.
      if (body.outcome === 'upheld' && body.adjustment !== undefined && body.adjustment > 0) {
        await tx.query(
          `UPDATE billing.payout_statements
              SET gross_earnings = gross_earnings + $2::numeric,
                  net_payable = net_payable + $2::numeric,
                  updated_at = now(), updated_by = $3
            WHERE id = $1`,
          [statementId, body.adjustment.toFixed(2), actor],
        );
      }

      await tx.query(
        `UPDATE billing.payout_statements SET status = 'computed', updated_at = now()
          WHERE id = $1 AND status = 'disputed'
            AND NOT EXISTS (SELECT 1 FROM billing.payout_disputes d
                             WHERE d.statement_id = $1 AND d.status = 'open')`,
        [statementId],
      );

      // An upheld adjustment changes the statement, so the period's totals are
      // now stale. Recomputed from the statements rather than incremented:
      // an aggregate maintained by arithmetic drifts the first time a path
      // forgets to update it, and this one is read by the screen next to the
      // numbers it is supposed to summarise.
      await this.refreshPeriodTotals(tx, statementId);

      await this.audit.write(tx, {
        action: 'approve',
        entity: 'payout_dispute',
        rowId: id,
        businessKey: asText(row['category']),
        dataClass: 'financial',
        before: { status: 'open' },
        after: { status: body.outcome, adjustment: body.adjustment ?? 0 },
        reasonText: body.reason,
      });

      await this.outbox.publish(
        tx,
        payoutEvent('payout.dispute.resolved', id, {
          disputeId: id,
          statementId,
          status: body.outcome,
          adjustment: body.adjustment === undefined ? null : body.adjustment.toFixed(2),
        }),
      );

      return this.loadStatement(tx, statementId);
    });
  }

  /**
   * Recompute a period's totals from its statements.
   *
   * From the rows rather than by adding a delta: an aggregate maintained by
   * arithmetic drifts the first time a path forgets it, and this one is shown
   * directly above the statements it claims to total.
   */
  private async refreshPeriodTotals(tx: TransactionClient, statementId: string): Promise<void> {
    await tx.query(
      `UPDATE billing.payout_periods p
          SET statement_count = t.n, gross_total = t.gross, tds_total = t.tds, net_total = t.net,
              updated_at = now()
         FROM (
           SELECT s.period_id,
                  count(*)                          AS n,
                  COALESCE(sum(s.gross_earnings), 0) AS gross,
                  COALESCE(sum(s.tds_amount), 0)     AS tds,
                  COALESCE(sum(s.net_payable), 0)    AS net
             FROM billing.payout_statements s
            WHERE s.period_id = (SELECT period_id FROM billing.payout_statements WHERE id = $1)
            GROUP BY s.period_id
         ) t
        WHERE p.id = t.period_id`,
      [statementId],
    );
  }

  /** The section 194J register, for filing. */
  async listTds(query: TdsQuery): Promise<Page<PayoutTdsView>> {
    return this.guard(async (tx) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `SELECT * FROM billing.payout_tds_entries
          WHERE hospital_id = $1
            AND ($2::text IS NULL OR financial_year = $2)
            AND ($3::uuid IS NULL OR doctor_id = $3)
          ORDER BY created_at DESC
          LIMIT $4`,
        [this.hospitalId(), query.financialYear ?? null, query.doctorId ?? null, query.limit],
      );
      return { items: rows.map((r) => this.toTds(r)), nextCursor: null, hasMore: false };
    });
  }
}
