import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import { DatabaseService, type TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import type {
  BudgetPositionRow,
  CheckRequest,
  CheckResult,
  CommitRequest,
  CommitmentRow,
  CreateCycleRequest,
  CreateLineRequest,
  CycleRow,
  ReleaseRequest,
  ReviseLineRequest,
  RevisionRow,
  SetCycleStatusRequest,
  VirementRequest,
} from './budget.schemas.js';

/**
 * NC-022 — the budget, and what it refuses to let anyone spend.
 *
 * ── This service does not decide whether a commitment fits ────────────────
 *
 * `finance.a_commitment_fits_the_budget()` does, on every INSERT, whatever
 * path wrote the row. The alternative — checking here — is a control that
 * protects only the callers who remember to ask, and the caller that forgets
 * is always the batch job written eighteen months later.
 *
 * `check()` exists, and is advisory on purpose: it tells a buyer before they
 * fill in twenty lines that the money is not there. It is not the control,
 * and it says so in its own message, because between the check and the write
 * another branch may have spent the line.
 *
 * ── Nor whether a virement balances ───────────────────────────────────────
 *
 * The legs go in one at a time and cannot balance until the last one lands,
 * so the check is a DEFERRABLE constraint trigger that fires at COMMIT — the
 * same shape as double entry in `ledger.service.ts`, for the same reason.
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
function asStamp(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' ? v : '';
}
function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number.parseFloat(v);
  return 0;
}

/**
 * Turn the database's refusals into problem+json.
 *
 * Every message here was written once, in the migration, next to the rule it
 * describes. Rewording it would give the user a different explanation
 * depending on which path they took to the same constraint.
 */
function translate(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as { message?: string } | null)?.message;

  if (code === 'NC022' && typeof message === 'string') {
    throw AppError.conflict(message);
  }
  if (code === '23505' && typeof message === 'string') {
    if (message.includes('uq_commitment_per_source')) {
      throw AppError.conflict(
        'That document already holds a live commitment against a budget line. Release the old one before committing again, or the same order would reserve the money twice.',
      );
    }
    if (message.includes('uq_budget_line_dimensions')) {
      throw AppError.conflict(
        'That cost centre already has a line for this account and budget kind in this cycle. One line per combination, so a department has one number to answer for rather than several that have to be added up.',
      );
    }
    if (message.includes('uq_budget_line_code')) {
      throw AppError.conflict('That budget line code is already used in this cycle.');
    }
    if (message.includes('uq_budget_cycle_code')) {
      throw AppError.conflict('That budget cycle code is already used in this book.');
    }
    if (message.includes('uq_budget_revision_no')) {
      throw AppError.conflict('Two revisions of that line were written at once. Try again.');
    }
  }
  if (code === '23514' && typeof message === 'string') {
    if (message.includes('a_virement_needs_a_second_person')) {
      throw AppError.conflict(
        'A virement cannot be approved by the person who requested it. Moving budget between departments is the moment one department loses money to another; the second person is the control.',
      );
    }
    if (message.includes('a_budget_cycle_runs_forwards')) {
      throw AppError.conflict('A budget cycle has to end after it starts.');
    }
    if (message.includes('a_commitment_is_positive')) {
      throw AppError.conflict('A commitment reserves money, so it cannot be zero or negative.');
    }
    if (message.includes('a_budget_amounts_are_not_negative')) {
      throw AppError.conflict('A budget cannot be negative.');
    }
  }
  throw error;
}

@Injectable()
export class BudgetService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ── Cycles ───────────────────────────────────────────────────────────────

  async listCycles(): Promise<readonly CycleRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query(
        `SELECT c.id, c.book_id, c.code, c.name, c.starts_on, c.ends_on, c.status,
                count(l.id) AS line_count
           FROM finance.budget_cycles c
           LEFT JOIN finance.budget_lines l ON l.cycle_id = c.id AND l.active = true
          GROUP BY c.id
          ORDER BY c.starts_on DESC, c.code`,
        [],
      );
      return rows.map((r) => ({
        id: asText(r['id']),
        bookId: asText(r['book_id']),
        code: asText(r['code']),
        name: asText(r['name']),
        startsOn: asDate(r['starts_on']),
        endsOn: asDate(r['ends_on']),
        status: asText(r['status']),
        lineCount: asNumber(r['line_count']),
      }));
    });
  }

  async createCycle(body: CreateCycleRequest): Promise<CycleRow> {
    const id = newId();
    await this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const ctx = currentTenantContext();
        await tx.query(
          `INSERT INTO finance.budget_cycles
             (id, hospital_id, book_id, code, name, starts_on, ends_on, status, updated_at)
           VALUES ($1, $2, $3::uuid, $4::text, $5::text, $6::date, $7::date, 'draft', now())`,
          [id, ctx.hospitalId, body.bookId, body.code, body.name, body.startsOn, body.endsOn],
        );
        await this.audit.write(tx, {
          action: 'insert',
          entity: 'fin_budget_cycle',
          rowId: id,
          businessKey: body.code,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: getContext().reason ?? null,
          before: null,
          after: { code: body.code, startsOn: body.startsOn, endsOn: body.endsOn },
        });
      })
      .catch(translate);
    return this.requireCycle(id);
  }

  /**
   * Activating a cycle is what makes its lines binding, so it is audited as a
   * decision rather than as a settings change.
   */
  async setCycleStatus(id: string, body: SetCycleStatusRequest): Promise<CycleRow> {
    await this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const result = await tx.query(
          `UPDATE finance.budget_cycles SET status = $2::text, updated_at = now() WHERE id = $1`,
          [id, body.status],
        );
        if (result.rowCount === 0) throw AppError.notFound('That budget cycle does not exist.');
        await this.audit.write(tx, {
          action: 'update',
          entity: 'fin_budget_cycle',
          rowId: id,
          businessKey: null,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: getContext().reason ?? null,
          before: null,
          after: { status: body.status },
        });
      })
      .catch(translate);
    return this.requireCycle(id);
  }

  private async requireCycle(id: string): Promise<CycleRow> {
    const row = (await this.listCycles()).find((c) => c.id === id);
    if (row === undefined) throw AppError.notFound('That budget cycle does not exist.');
    return row;
  }

  // ── Lines and position ───────────────────────────────────────────────────

  /**
   * The position of every line in a cycle: budget, committed, actual, left.
   *
   * Read from `v_budget_position` rather than assembled here, so the arithmetic
   * that decides `available` is the same arithmetic the trigger enforces.
   */
  async position(cycleId?: string): Promise<readonly BudgetPositionRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query(
        `SELECT * FROM finance.v_budget_position
          WHERE ($1::uuid IS NULL OR cycle_id = $1::uuid)
          ORDER BY cycle_code, budget_kind, line_code`,
        [cycleId ?? null],
      );
      return rows.map((r) => ({
        lineId: asText(r['line_id']),
        lineCode: asText(r['line_code']),
        cycleCode: asText(r['cycle_code']),
        budgetKind: asText(r['budget_kind']),
        costCentreId: asText(r['cost_centre_id']),
        costCentreName: asText(r['cost_centre_name']),
        accountCode: asText(r['account_code']),
        accountName: asText(r['account_name']),
        originalAmount: asMoney(r['original_amount']),
        revisedAmount: asMoney(r['revised_amount']),
        committedAmount: asMoney(r['committed_amount']),
        actualAmount: asMoney(r['actual_amount']),
        available: asMoney(r['available']),
        revisionMovement: asMoney(r['revision_movement']),
        usedPct: asNumber(r['used_pct']),
        overAlertThreshold: r['over_alert_threshold'] === true,
      }));
    });
  }

  async createLine(body: CreateLineRequest): Promise<BudgetPositionRow> {
    const id = newId();
    await this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const ctx = currentTenantContext();
        await tx.query(
          `INSERT INTO finance.budget_lines
             (id, hospital_id, cycle_id, cost_centre_id, account_id, code, budget_kind,
              original_amount, revised_amount, alert_threshold_pct, updated_at)
           VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::text, $7::text,
                   $8::numeric, $8::numeric, $9::smallint, now())`,
          [
            id,
            ctx.hospitalId,
            body.cycleId,
            body.costCentreId,
            body.accountId,
            body.code,
            body.budgetKind,
            body.amount,
            body.alertThresholdPct,
          ],
        );
        await this.audit.write(tx, {
          action: 'insert',
          entity: 'fin_budget_line',
          rowId: id,
          businessKey: body.code,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: getContext().reason ?? null,
          before: null,
          after: { code: body.code, amount: body.amount, budgetKind: body.budgetKind },
        });
      })
      .catch(translate);
    return this.requireLine(id);
  }

  private async requireLine(id: string): Promise<BudgetPositionRow> {
    const row = (await this.position()).find((l) => l.lineId === id);
    if (row === undefined) throw AppError.notFound('That budget line does not exist, or is closed.');
    return row;
  }

  /**
   * Move one line, on its own authority.
   *
   * `revised_amount` is not written here: inserting the revision moves it, by
   * trigger. Writing both would let the history and the line disagree, and the
   * history is the part an auditor reads.
   */
  async reviseLine(lineId: string, body: ReviseLineRequest): Promise<BudgetPositionRow> {
    await this.db
      .withTenant(currentTenantContext(), async (tx) => {
        await this.insertRevision(tx, lineId, body.toAmount, body.reason, null);
      })
      .catch(translate);
    return this.requireLine(lineId);
  }

  /**
   * One leg of a revision. Shared with `virement`, which is the same insert
   * repeated with a virement id attached — so the two cannot drift apart in
   * what they record.
   */
  private async insertRevision(
    tx: TransactionClient,
    lineId: string,
    toAmount: string,
    reason: string,
    virementId: string | null,
  ): Promise<void> {
    const ctx = currentTenantContext();
    const { rows } = await tx.query(
      `SELECT revised_amount,
              coalesce((SELECT max(revision_no) FROM finance.budget_revisions WHERE line_id = $1), 0) + 1 AS next_no
         FROM finance.budget_lines WHERE id = $1`,
      [lineId],
    );
    const current = rows[0];
    if (current === undefined) throw AppError.notFound('That budget line does not exist.');

    const id = newId();
    await tx.query(
      `INSERT INTO finance.budget_revisions
         (id, hospital_id, line_id, revision_no, from_amount, to_amount, reason, approved_by, virement_id)
       VALUES ($1, $2, $3::uuid, $4::smallint, $5::numeric, $6::numeric, $7::text, $8::uuid, $9::uuid)`,
      [
        id,
        ctx.hospitalId,
        lineId,
        asNumber(current['next_no']),
        asMoney(current['revised_amount']),
        toAmount,
        reason,
        getContext().userId,
        virementId,
      ],
    );
    await this.audit.write(tx, {
      action: 'update',
      entity: 'fin_budget_line',
      rowId: lineId,
      businessKey: null,
      dataClass: 'financial',
      patientId: null,
      encounterId: null,
      reasonText: reason,
      before: { revisedAmount: asMoney(current['revised_amount']) },
      after: { revisedAmount: toAmount, virementId },
    });
  }

  // ── Virements ────────────────────────────────────────────────────────────

  /**
   * Move budget between lines. The legs are written one at a time; the
   * database refuses the whole transaction at COMMIT unless they net to zero.
   */
  async virement(body: VirementRequest): Promise<readonly BudgetPositionRow[]> {
    const virementId = newId();
    await this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const ctx = currentTenantContext();
        await tx.query(
          `INSERT INTO finance.budget_virements
             (id, hospital_id, cycle_id, reference, reason, requested_by, approved_by)
           VALUES ($1, $2, $3::uuid, $4::text, $5::text, $6::uuid, $7::uuid)`,
          [
            virementId,
            ctx.hospitalId,
            body.cycleId,
            body.reference ?? null,
            body.reason,
            body.requestedBy,
            getContext().userId,
          ],
        );
        for (const leg of body.legs) {
          await this.insertRevision(tx, leg.lineId, leg.toAmount, leg.note, virementId);
        }
        await this.audit.write(tx, {
          action: 'insert',
          entity: 'fin_budget_virement',
          rowId: virementId,
          businessKey: body.reference ?? null,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: body.reason,
          before: null,
          after: { legs: body.legs.length, requestedBy: body.requestedBy },
        });
      })
      .catch(translate);

    const all = await this.position(body.cycleId);
    const touched = new Set(body.legs.map((l) => l.lineId));
    return all.filter((l) => touched.has(l.lineId));
  }

  async listRevisions(lineId: string): Promise<readonly RevisionRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.id, r.line_id, l.code AS line_code, r.revision_no,
                r.from_amount, r.to_amount, (r.to_amount - r.from_amount) AS movement,
                r.reason, r.virement_id, r.approved_at
           FROM finance.budget_revisions r
           JOIN finance.budget_lines l ON l.id = r.line_id
          WHERE r.line_id = $1::uuid
          ORDER BY r.revision_no`,
        [lineId],
      );
      return rows.map((r) => ({
        id: asText(r['id']),
        lineId: asText(r['line_id']),
        lineCode: asText(r['line_code']),
        revisionNo: asNumber(r['revision_no']),
        fromAmount: asMoney(r['from_amount']),
        toAmount: asMoney(r['to_amount']),
        movement: asMoney(r['movement']),
        reason: asText(r['reason']),
        virementId: asTextOrNull(r['virement_id']),
        approvedAt: asStamp(r['approved_at']),
      }));
    });
  }

  // ── Commitment control ───────────────────────────────────────────────────

  /**
   * Advisory. Tells a buyer the money is not there before they fill in twenty
   * lines; it is not the control, and `wouldFit: true` is not a promise.
   */
  async check(body: CheckRequest): Promise<CheckResult> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query(
        `SELECT p.line_id, p.line_code,
                p.available
                  + coalesce((SELECT sum(c.amount) FROM finance.budget_commitments c
                               WHERE c.line_id = p.line_id AND c.status = 'open'
                                 AND c.source_id = $2::uuid), 0) AS available
           FROM finance.v_budget_position p
          WHERE p.line_id = $1::uuid`,
        [body.lineId, body.excludeSourceId ?? null],
      );
      const row = rows[0];
      if (row === undefined) throw AppError.notFound('That budget line does not exist, or is closed.');

      const available = asMoney(row['available']);
      const wouldFit = Number.parseFloat(body.amount) <= Number.parseFloat(available);
      return {
        lineId: asText(row['line_id']),
        lineCode: asText(row['line_code']),
        requested: body.amount,
        available,
        wouldFit,
        message: wouldFit
          ? `${available} is available on ${asText(row['line_code'])}. This is advisory — the line is only reserved when the commitment is written, and another branch may spend it first.`
          : `${asText(row['line_code'])} has ${available} left and this needs ${body.amount}. Raise the line, move budget from another, or reduce the order.`,
      };
    });
  }

  async listCommitments(lineId?: string): Promise<readonly CommitmentRow[]> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const { rows } = await tx.query(
        `SELECT c.id, c.line_id, l.code AS line_code, c.source_kind, c.source_id, c.source_ref,
                c.amount, c.status, c.released_reason, c.created_at
           FROM finance.budget_commitments c
           JOIN finance.budget_lines l ON l.id = c.line_id
          WHERE ($1::uuid IS NULL OR c.line_id = $1::uuid)
          ORDER BY c.created_at DESC
          LIMIT 500`,
        [lineId ?? null],
      );
      return rows.map((r) => ({
        id: asText(r['id']),
        lineId: asText(r['line_id']),
        lineCode: asText(r['line_code']),
        sourceKind: asText(r['source_kind']),
        sourceId: asText(r['source_id']),
        sourceRef: asTextOrNull(r['source_ref']),
        amount: asMoney(r['amount']),
        status: asText(r['status']),
        releasedReason: asTextOrNull(r['released_reason']),
        createdAt: asStamp(r['created_at']),
      }));
    });
  }

  /** Reserve budget. Refused by trigger if the line has no room. */
  async commit(body: CommitRequest): Promise<CommitmentRow> {
    const id = newId();
    await this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const ctx = currentTenantContext();
        await tx.query(
          `INSERT INTO finance.budget_commitments
             (id, hospital_id, line_id, source_kind, source_id, source_ref, amount, created_by, updated_at)
           VALUES ($1, $2, $3::uuid, $4::text, $5::uuid, $6::text, $7::numeric, $8::uuid, now())`,
          [
            id,
            ctx.hospitalId,
            body.lineId,
            body.sourceKind,
            body.sourceId,
            body.sourceRef ?? null,
            body.amount,
            getContext().userId,
          ],
        );
        await this.audit.write(tx, {
          action: 'insert',
          entity: 'fin_budget_commitment',
          rowId: id,
          businessKey: body.sourceRef ?? null,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: getContext().reason ?? null,
          before: null,
          after: { lineId: body.lineId, amount: body.amount, sourceKind: body.sourceKind },
        });
      })
      .catch(translate);

    const row = (await this.listCommitments(body.lineId)).find((c) => c.id === id);
    if (row === undefined) throw AppError.notFound('That commitment was not written.');
    return row;
  }

  /**
   * Give the money back. `realised` when a GRN turned the reservation into a
   * real cost, `released` when the order went away.
   */
  async release(id: string, body: ReleaseRequest): Promise<CommitmentRow> {
    let lineId = '';
    await this.db
      .withTenant(currentTenantContext(), async (tx) => {
        const { rows } = await tx.query(
          `UPDATE finance.budget_commitments
              SET status = $2::text, released_reason = $3::text, updated_at = now()
            WHERE id = $1 AND status = 'open'
            RETURNING line_id`,
          [id, body.becomes, body.releasedReason],
        );
        const row = rows[0];
        if (row === undefined) {
          throw AppError.notFound('That commitment does not exist, or has already been released.');
        }
        lineId = asText(row['line_id']);

        await this.audit.write(tx, {
          action: 'update',
          entity: 'fin_budget_commitment',
          rowId: id,
          businessKey: null,
          dataClass: 'financial',
          patientId: null,
          encounterId: null,
          reasonText: body.releasedReason,
          before: { status: 'open' },
          after: { status: body.becomes },
        });
      })
      .catch(translate);

    const row = (await this.listCommitments(lineId)).find((c) => c.id === id);
    if (row === undefined) throw AppError.notFound('That commitment does not exist.');
    return row;
  }
}
