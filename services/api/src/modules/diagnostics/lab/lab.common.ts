import { ProblemType, newId } from '@vims/contracts';
import { getContext } from '../../../core/context/request-context.js';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';

/**
 * The small things every service in this module needs, in one place.
 *
 * The interesting one is `mapLabDatabaseError`. Most of this phase's safety is
 * in the database — the D-10 evidence CHECK, the QC release gate, the
 * append-only result chain, the rejected-sample guard — and a trigger that
 * raises reaches Nest as an unrecognised throw, which `ProblemFilter` turns into
 * a 500 with the deliberately generic body it gives everything it does not know.
 *
 * A 500 is the wrong answer to "this critical value has not been called through
 * yet". It tells the pathologist the system is broken rather than telling them
 * what to do, and a laboratory that learns to retry on 500 is a laboratory that
 * will eventually retry past a guard. So every constraint and trigger this
 * module can provoke is translated here into the refusal it actually is, with a
 * message written for the person holding the tube.
 *
 * The services still check the same rules **before** they write. This is the
 * backstop for the paths a check cannot cover — a concurrent rejection, a
 * trigger a future migration adds — and the reason the messages are written
 * here rather than passed through: a database message can name a table, a
 * constraint or a row, and `docs/04 §7` keeps all of that out of a response.
 */

interface PostgresErrorShape {
  readonly code: string;
  readonly constraint: string | undefined;
  readonly message: string | undefined;
}

function asPostgresError(error: unknown): PostgresErrorShape | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  if (typeof candidate.code !== 'string') return null;
  return {
    code: candidate.code,
    constraint: typeof candidate.constraint === 'string' ? candidate.constraint : undefined,
    message: typeof candidate.message === 'string' ? candidate.message : undefined,
  };
}

interface Translation {
  readonly type: (typeof ProblemType)[keyof typeof ProblemType];
  readonly detail: string;
}

/**
 * Ordered: the first match wins, so the most specific fragments come first.
 * Matched on our own migration's wording, which is the only thing that raises
 * these — a fragment rather than the whole message so a typo fix in the
 * migration does not silently demote a guard to a 500.
 */
const TRIGGER_TRANSLATIONS: readonly (readonly [string, Translation])[] = [
  [
    'cannot be authorised until the communication is documented',
    {
      type: ProblemType.CLINICAL_HARD_STOP,
      detail:
        'The result is released and already visible — what is blocked is the signature. Record the call-back first: either a read-back from a named clinician, or "clinician unreachable" with the tier it was escalated to (docs/DECISIONS.md D-10).',
    },
  ],
  [
    'does not permit release',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'This analyte’s quality control does not permit releasing patient results. Run and pass QC, or have the Lab Director authorise the release in the QC action log — retrying will not change the answer (EN-031 §5).',
    },
  ],
  [
    'is not a Director authorisation to release',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'The QC action named here is not an authorisation to release. EN-031 §5 needs a Lab Director’s entry with a written reason before any result goes out under an out-of-control control.',
    },
  ],
  [
    'so it cannot produce a result',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'That sample was rejected, so it cannot carry a result. The recollection is what produces the value; a result arriving for a rejected specimen belongs in the interface error queue.',
    },
  ],
  [
    'critical alert(s) on this order are not yet acknowledged',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'The results are released and the report is available, but the order stays open while a critical value on it is still unacknowledged (OP-004 §5).',
    },
  ],
  [
    'and not rejected, so this is not a recollection',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'Only a rejected specimen is recollected. Record a repeat draw as a new sample on the order instead — calling it a recollection would flatter the rejection indicator.',
    },
  ],
  [
    'nothing links that order back to the original order',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'A recollection has to lead back to the order it replaces. Put it on the original order, or chain the replacement line to the line it replaces.',
    },
  ],
  [
    'is not an active reason for this hospital',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'That rejection reason is not one this laboratory currently uses. Pick one from the active list — the rejection rate is a NABL indicator and it is counted by code.',
    },
  ],
  [
    'already has a result for this analyte',
    {
      type: ProblemType.CONFLICT,
      detail:
        'This order line already has a result for that analyte. A repeat measurement is a new version of it, not a second result.',
    },
  ],
  [
    'is immutable',
    {
      type: ProblemType.CONFLICT,
      detail:
        'A stored result cannot be edited. Amend it — that writes the next version with a reason, and the original stays.',
    },
  ],
  [
    'is append-only',
    {
      type: ProblemType.CONFLICT,
      detail: 'This record is append-only. A correction is another row, never an edit of this one.',
    },
  ],
  [
    'are write-once',
    {
      type: ProblemType.CONFLICT,
      detail:
        'This result has already been through that step and its attribution is fixed. Releasing it again is an amendment.',
    },
  ],
];

const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  lab_critical_value_callbacks_evidence: {
    type: ProblemType.BUSINESS_RULE_VIOLATED,
    detail:
      'A critical-value call-back is either a confirmed read-back from a named clinician, or a documented "clinician unreachable — escalated to <tier>". There is no third answer and no way to record both (docs/DECISIONS.md D-10).',
  },
  lab_samples_two_identifier_check: {
    type: ProblemType.BUSINESS_RULE_VIOLATED,
    detail:
      'A collection is confirmed by scanning the patient and the container, or by recording why that was impossible. OP-004 §5 allows no third answer.',
  },
  lab_samples_rejection_reason_pairing: {
    type: ProblemType.BUSINESS_RULE_VIOLATED,
    detail: 'A rejected sample carries a coded reason, and a reason belongs only to a rejected sample.',
  },
  lab_samples_rejection_attributed: {
    type: ProblemType.BUSINESS_RULE_VIOLATED,
    detail: 'A rejection names who rejected the specimen and when. "It was rejected" is not a record.',
  },
  lab_order_tests_recollection_free: {
    type: ProblemType.BUSINESS_RULE_VIOLATED,
    detail:
      'A recollection is free. Billing a patient for the laboratory’s own pre-analytical failure is not permitted (OP-004 §5).',
  },
  lab_result_versions_value_typed: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The value does not match the result type. A numeric result needs a number, a coded result needs a code — a potassium stored as text cannot be compared against a panic limit.',
  },
  lab_result_versions_amendment_reason: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'An amendment says why. A version with no reason is an overwrite wearing a version number.',
  },
  lab_result_versions_segregation_of_duty: {
    type: ProblemType.SEGREGATION_OF_DUTIES,
    detail:
      'The person who entered a manual result cannot be the one who verifies it (OP-004 §5, segregation of duty).',
  },
  lab_result_versions_ref_order: {
    type: ProblemType.BUSINESS_RULE_VIOLATED,
    detail:
      'The reference interval used for this result is inverted — the panic bounds must sit outside the normal band. Fix the range master before resulting this analyte.',
  },
  labq_westgard_config_1_2s_is_warning: {
    type: ProblemType.BUSINESS_RULE_VIOLATED,
    detail:
      '1-2s may only ever be a warning. Configuring it as a rejection rule fails roughly one run in twenty by chance, and a laboratory that repeats one run in twenty stops believing its own QC (EN-031 §5).',
  },
};

export function mapLabDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const pg = asPostgresError(error);
  if (pg === null) return error;

  if (pg.constraint !== undefined) {
    const byConstraint = CONSTRAINT_TRANSLATIONS[pg.constraint];
    if (byConstraint !== undefined) return new AppError(byConstraint.type, byConstraint.detail);
  }

  const message = pg.message ?? '';
  for (const [fragment, translation] of TRIGGER_TRANSLATIONS) {
    if (message.includes(fragment)) return new AppError(translation.type, translation.detail);
  }

  // A duplicate accession, sample number or barcode is a retry, not a bug. Two
  // specimens resolving to one barcode is the single worst outcome in the
  // pre-analytical phase, so the unique index is doing its job and the caller
  // needs to know it was refused rather than silently merged.
  if (pg.code === '23505') {
    return new AppError(
      ProblemType.CONFLICT,
      'That identifier is already in use in this hospital. Nothing was written — re-read the record and try again.',
    );
  }

  return error;
}

/** Runs `fn` and translates anything the database refuses into a stated refusal. */
export async function withLabErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapLabDatabaseError(error);
  }
}

/**
 * The branch a laboratory action happens in.
 *
 * A lab order, a specimen and a report are all branch-scoped rows, and RLS
 * refuses an insert whose branch is outside the session's scope. Resolving it in
 * one place means the failure is "choose a branch" rather than a `WITH CHECK`
 * violation from inside an audit write.
 */
export function requireBranch(explicit?: string): string {
  const ctx = getContext();
  const branchId = explicit ?? ctx.branchId;
  if (branchId === null || branchId === undefined) {
    throw AppError.conflict(
      'This session is not acting in a branch, and a laboratory order belongs to one. Choose a branch and try again.',
    );
  }
  return branchId;
}

/** A patient in another hospital is filtered by RLS and reads as missing. */
export async function assertPatientVisible(tx: TransactionClient, patientId: string): Promise<void> {
  const row = await tx.maybeOne<{ id: string }>(
    `SELECT id FROM patient.patients WHERE id = $1 AND deleted_at IS NULL`,
    [patientId],
  );
  if (row === undefined) throw AppError.notFound('The patient');
}

/**
 * `docs/03 §Table rules`: every order/result table keeps a status history with
 * actor and timestamp. `lab.lab_order_events` is append-only (§D revokes UPDATE
 * and DELETE), so this is the only way a status change is recorded and there is
 * no way to rewrite one.
 */
export async function writeOrderEvent(
  tx: TransactionClient,
  input: {
    readonly orderId: string;
    readonly orderTestId?: string | null;
    readonly sampleId?: string | null;
    readonly from?: string | null;
    readonly to: string;
    readonly reason?: string | null;
  },
): Promise<void> {
  const ctx = getContext();
  await tx.query(
    `INSERT INTO lab.lab_order_events
       (id, hospital_id, order_id, order_test_id, sample_id, from_status, to_status, reason,
        actor_user_id, actor_role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      newId(),
      ctx.hospitalId,
      input.orderId,
      input.orderTestId ?? null,
      input.sampleId ?? null,
      input.from ?? null,
      input.to,
      input.reason ?? null,
      ctx.userId,
      ctx.roleKeys[0] ?? null,
    ],
  );
}

/** Postgres `numeric` arrives as a string. Null stays null; a number stays exact enough. */
export function toNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

/** Money and quantity in an event payload are decimal strings, never floats. */
export function decimalString(value: number, places: number): string {
  return value.toFixed(places);
}

/** The actor, for an event payload that requires a non-null uuid. */
export function actorId(): string {
  return getContext().userId ?? '';
}
