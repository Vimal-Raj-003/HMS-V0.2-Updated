import { ProblemType } from '@vims/contracts';
import { getContext } from '../../../core/context/request-context.js';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';

/**
 * Small pieces shared by the three scheduling services. Nothing here holds
 * state, so none of it is a Nest provider.
 */

/**
 * The branch the caller is acting in.
 *
 * Appointments, visits and slots are all branch-scoped rows: `clinical.*`
 * carries `branch_id NOT NULL` and the RLS policy narrows every read with
 * `branch_id = ANY(core.current_branch_ids())`. A session that has not chosen a
 * branch would therefore insert a row it cannot then read back, which surfaces
 * as an unexplainable empty list rather than an error. Better to say so here.
 */
export function requireBranch(): string {
  const branchId = getContext().branchId;
  if (branchId === null) {
    throw new AppError(
      ProblemType.BRANCH_NOT_GRANTED,
      'Choose a branch before working with appointments or visits.',
      { nextAction: 'Switch to a branch and retry.' },
    );
  }
  return branchId;
}

/**
 * The branch's IANA timezone, falling back to the hospital's.
 *
 * "The same day" in OP-001 §5 means the same day *in the hospital's own
 * timezone*, which is why `slot_date` is a stored branch-local date and not a
 * cast of `slot_start`. Every conversion in this module goes through this value.
 */
export async function branchTimeZone(tx: TransactionClient, branchId: string): Promise<string> {
  const row = await tx.maybeOne<{ time_zone: string | null }>(
    `SELECT COALESCE(b.timezone, h.timezone) AS time_zone
       FROM core.branches b
       JOIN core.hospitals h ON h.id = b.hospital_id
      WHERE b.id = $1`,
    [branchId],
  );
  return row?.time_zone ?? 'Asia/Kolkata';
}

/** Today, as the branch reads it off the wall. */
export async function branchToday(tx: TransactionClient, timeZone: string): Promise<string> {
  const row = await tx.one<{ today: string }>(`SELECT (now() AT TIME ZONE $1)::date::text AS today`, [
    timeZone,
  ]);
  return row.today;
}

/** PostgreSQL error code, when the thrown thing is one. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** The constraint or index a unique/check violation names. */
export function pgConstraint(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('constraint' in error)) return undefined;
  const constraint = (error as { constraint?: unknown }).constraint;
  return typeof constraint === 'string' ? constraint : undefined;
}

/**
 * Turns the database's own invariants into RFC 9457 problems.
 *
 * The capacity ceiling and the same-patient-same-day rule are enforced by a
 * CHECK constraint and a partial unique index (see the Phase-1 migration §C.4),
 * not by these services — a service check alone can be raced, and a rule only a
 * service knows is one a future caller bypasses. So the constraint is the
 * enforcement and this is the translation.
 */
export async function mapConstraints<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code = pgErrorCode(error);
    const constraint = pgConstraint(error);

    if (code === '23514' && constraint === 'schedule_slots_capacity') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'That slot is full. Choose another slot, join the waitlist, or ask somebody with the overbooking permission.',
        { nextAction: 'Pick a different slot or add the patient to the waitlist.' },
      );
    }
    if (code === '23505' && constraint === 'uq_appointments_patient_doctor_day') {
      throw new AppError(
        ProblemType.BUSINESS_RULE_VIOLATED,
        'This patient already has a live appointment with this doctor on that day (OP-001 §5).',
        { nextAction: 'Reschedule the existing appointment instead of booking a second one.' },
      );
    }
    if (code === '23P01' && constraint === 'schedule_slots_no_overlap') {
      throw AppError.conflict(
        'That schedule overlaps a slot this doctor already has. A doctor cannot be in two rooms at once.',
      );
    }
    if (code === '23514' && constraint === 'queue_token_series_offline_boundary') {
      throw new AppError(
        ProblemType.NUMBERING_SERIES_EXHAUSTED,
        'This queue has issued every token number reserved for the day.',
        { nextAction: 'Ask an administrator to widen the token series for this queue.' },
      );
    }
    throw error;
  }
}
