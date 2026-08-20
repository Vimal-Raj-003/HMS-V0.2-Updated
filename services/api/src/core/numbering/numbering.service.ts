import { Injectable } from '@nestjs/common';
import { getContext } from '../context/request-context.js';
import type { TransactionClient } from '../db/database.service.js';
import { AppError } from '../problem/app-error.js';
import { PatternError, financialYearOf, formatNumber, tokensIn } from './pattern.js';

export interface AllocationRequest {
  /** Series key, e.g. `UHID`, `OP_VISIT`, `RECEIPT`. */
  readonly key: string;
  /** Branch the number belongs to. Required for a branch-scoped series. */
  readonly branchId?: string | undefined;
  /** What the number will be attached to, recorded for the audit trail. */
  readonly refType?: string | undefined;
  readonly refId?: string | undefined;
}

export interface Allocation {
  readonly seriesId: string;
  readonly number: bigint;
  readonly formatted: string;
  readonly allocationId: string;
}

interface SeriesRow {
  readonly id: string;
  readonly key: string;
  readonly pattern: string;
  readonly scope: string;
  readonly fy: string | null;
  readonly gapless: boolean;
  readonly reset_policy: string;
  readonly branch_id: string | null;
  readonly locked_at: Date | null;
  readonly branch_code: string | null;
  readonly hospital_code: string | null;
  readonly time_zone: string | null;
}

/**
 * Allocates the human-facing identifiers in `core.numbering_series`
 * (`docs/03 §Numbering`): UHID, OP visit number, appointment number, IP number,
 * bill, receipt, refund, credit note, MLC and blood-bag numbers.
 *
 * **Allocation always happens inside the caller's transaction.** That is the
 * whole design. `UPDATE ... RETURNING` takes a row lock on the series that is
 * held until the caller commits, so two concurrent registrations cannot read the
 * same `current_value`, and a registration that fails after allocating gives the
 * number back instead of burning it.
 *
 * The cost is that allocations on one series serialise, which is exactly the
 * trade `docs/03 §84` asks for on the gapless series: an invoice series with a
 * hole in it is a question an auditor will ask and nobody will be able to
 * answer.
 *
 * Non-gapless series (UHID, visit, appointment) currently take the same lock.
 * They are *permitted* gaps, not required to have them, so this is correct but
 * stricter than necessary; `docs/03 §84` names a PostgreSQL sequence as the
 * lock-free implementation, and that is the change to make if a busy branch ever
 * shows contention on registration. It is a performance change, not a
 * correctness one, so it needs a measurement first rather than a guess.
 */
@Injectable()
export class NumberingService {
  /**
   * Allocates the next number in `key`, formats it, and records the allocation.
   *
   * Must be called with a `tx` from `withTenant`, so RLS scopes the series to
   * the caller's hospital and the lock is released by the caller's commit.
   */
  async allocate(tx: TransactionClient, request: AllocationRequest): Promise<Allocation> {
    const ctx = getContext();
    const series = await this.lockSeries(tx, request);
    const now = new Date();
    const timeZone = series.time_zone ?? 'Asia/Kolkata';

    const needed = tokensIn(series.pattern);
    const fy = needed.includes('FY') ? financialYearOf(now, timeZone) : undefined;
    const next = await this.advance(tx, series, fy ?? null);

    let formatted: string;
    try {
      formatted = formatNumber(series.pattern, next, {
        branchCode: series.branch_code ?? undefined,
        hospitalCode: series.hospital_code ?? undefined,
        fy,
        at: now,
        timeZone,
      });
    } catch (error) {
      if (error instanceof PatternError) {
        // A misconfigured pattern must stop the transaction. Falling back to a
        // "safe" default would mint an identifier in a shape nothing else in the
        // system expects, and it would be discovered by whoever tries to look
        // the number up months later.
        throw AppError.conflict(`Numbering series "${series.key}" is misconfigured: ${error.message}`);
      }
      throw error;
    }

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO core.numbering_allocations
         (id, hospital_id, series_id, number, formatted, ref_type, ref_id, allocated_by)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        ctx.hospitalId,
        series.id,
        next.toString(10),
        formatted,
        request.refType ?? null,
        request.refId ?? null,
        ctx.userId ?? null,
      ],
    );
    const allocationId = rows[0]?.id;
    if (allocationId === undefined) {
      throw AppError.conflict(`Could not record the allocation for series "${series.key}".`);
    }

    return { seriesId: series.id, number: next, formatted, allocationId };
  }

  /**
   * Takes the row lock and returns the series with the codes its pattern needs.
   *
   * `FOR UPDATE` is on `core.numbering_series` only — the joins to branch and
   * hospital are `LEFT JOIN`s of reference data that must not be locked, because
   * locking a branch row here would serialise every module that touches it.
   */
  private async lockSeries(tx: TransactionClient, request: AllocationRequest): Promise<SeriesRow> {
    const { rows } = await tx.query<SeriesRow>(
      `SELECT s.id, s.key, s.pattern, s.scope, s.fy, s.gapless, s.reset_policy::text AS reset_policy,
              s.branch_id, s.locked_at,
              b.short_name AS branch_code, h.code AS hospital_code,
              COALESCE(b.timezone, h.timezone) AS time_zone
         FROM core.numbering_series s
         LEFT JOIN core.branches  b ON b.id = s.branch_id
         LEFT JOIN core.hospitals h ON h.id = s.hospital_id
        WHERE s.key = $1
          AND s.active
          AND s.effective_from <= now()
          AND (s.effective_to IS NULL OR s.effective_to > now())
          AND (s.branch_id = $2::uuid OR (s.branch_id IS NULL AND s.scope = 'hospital'))
        ORDER BY s.branch_id NULLS LAST
        LIMIT 1
        FOR UPDATE OF s`,
      [request.key, request.branchId ?? null],
    );

    const series = rows[0];
    if (series === undefined) {
      throw AppError.conflict(
        `No active numbering series "${request.key}" is configured for this branch. ` +
          `A hospital administrator must configure one before this action can be completed.`,
      );
    }
    if (series.locked_at !== null) {
      // EN-024: a sealed series is evidence. Allocating from it after sealing
      // would insert a number into a period an auditor has already signed off.
      throw AppError.conflict(`Numbering series "${series.key}" is sealed and cannot issue new numbers.`);
    }
    return series;
  }

  /**
   * Increments the series, applying its reset policy.
   *
   * The reset and the increment are one statement so that a financial-year
   * rollover cannot interleave with another allocation: two registrations either
   * side of midnight on 1 April must not both believe they are the first of the
   * new year.
   */
  private async advance(tx: TransactionClient, series: SeriesRow, fy: string | null): Promise<bigint> {
    if (series.reset_policy === 'day') {
      // `core.numbering_series` has no column that can hold a day marker — `fy`
      // is varchar(9) and a date needs 10 — so a daily reset cannot be recorded
      // here, and a series that cannot record its period would silently reissue
      // yesterday's numbers. Queue tokens, the only `day` series seeded, have
      // their own per-day table for exactly this reason.
      throw AppError.conflict(
        `Numbering series "${series.key}" resets daily, which core.numbering_series cannot ` +
          `express. Daily series are issued from queue.queue_token_series.`,
      );
    }

    const resetsOnFy = series.reset_policy === 'fy' && fy !== null && series.fy !== fy;
    const { rows } = await tx.query<{ current_value: string }>(
      `UPDATE core.numbering_series
          SET current_value = CASE WHEN $2::boolean THEN 1 ELSE current_value + 1 END,
              fy            = CASE WHEN $2::boolean THEN $3::varchar ELSE fy END,
              updated_at    = now(),
              updated_by    = $4::uuid
        WHERE id = $1
        RETURNING current_value`,
      [series.id, resetsOnFy, fy, getContext().userId ?? null],
    );

    const value = rows[0]?.current_value;
    if (value === undefined) {
      throw AppError.conflict(`Numbering series "${series.key}" could not be advanced.`);
    }
    return BigInt(value);
  }
}
