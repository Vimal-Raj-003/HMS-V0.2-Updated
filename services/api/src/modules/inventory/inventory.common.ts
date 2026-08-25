import { ProblemType } from '@vims/contracts';
import { getContext } from '../../core/context/request-context.js';
import type { TransactionClient } from '../../core/db/database.service.js';
import { AppError } from '../../core/problem/app-error.js';

/**
 * The small things every service in `inventory` and `pharmacy` needs.
 *
 * The centre of gravity is `mapInventoryDatabaseError`. Phase 4 ships more
 * write-time refusals than any phase before it — the append-only ledger, the
 * UoM ladder, the expiry and quarantine gates, the narcotic store designation,
 * the negative-stock block, the OTC schedule refusal, the NDPS dual-signature
 * rule — and every one of them reaches Nest as a bare `pg` throw that
 * `ProblemFilter` would otherwise turn into a 500.
 *
 * A 500 is the wrong answer to "that batch expired last Tuesday". It tells the
 * pharmacist the system is broken rather than telling them what to do, and a
 * counter that learns to retry on 500 is a counter that will eventually retry
 * past a guard. So each refusal is translated here into the sentence it
 * actually is, written for the person holding the strip.
 *
 * The services still check the same rules **before** they write, wherever a
 * check can be made cheaply. This is the backstop for the paths a check cannot
 * cover — a concurrent dispense taking the last unit, a trigger a future
 * migration adds — and the reason the wording lives here rather than being
 * passed through: a Postgres message names tables, constraints and row values,
 * and `docs/04 §7` keeps all of that out of a response body.
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
  readonly nextAction?: string;
}

/**
 * Ordered: the first match wins, so the most specific fragments come first.
 * Matched on the migration's own wording — a fragment rather than the whole
 * message, so a typo fix in the migration does not silently demote a guard to a
 * 500, but a rewrite of the sentence is caught by the integration suite.
 */
const TRIGGER_TRANSLATIONS: readonly (readonly [string, Translation])[] = [
  // ── the ledger ────────────────────────────────────────────────────────────
  [
    'is append-only: movement',
    {
      type: ProblemType.CONFLICT,
      detail:
        'A stock movement is a statement about something that physically happened, so it cannot be edited or deleted. Post a compensating entry instead — a correction that names the movement it corrects and says why.',
      nextAction: 'Raise a correction against the original movement.',
    },
  ],
  [
    'is a statutory register',
    {
      type: ProblemType.CONFLICT,
      detail:
        'A controlled-drug register entry cannot be edited or deleted. A register that can be rewritten documents nothing — post an adjustment entry with a remark instead.',
      nextAction: 'Post an adjustment entry naming the mistake.',
    },
  ],
  [
    'is itself a correction',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'That movement is itself a correction. Correct the original movement rather than the correction of it — a chain of corrections is unreadable to whoever has to reconstruct what happened.',
    },
  ],
  [
    'a correction must be for the same item in the same store',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail: 'A correction belongs to the same item in the same store as the movement it corrects.',
    },
  ],
  [
    'correction names movement',
    {
      type: ProblemType.NOT_FOUND,
      detail: 'The movement this correction names does not exist.',
    },
  ],
  // ── UoM ───────────────────────────────────────────────────────────────────
  [
    'an unconvertible quantity is not a quantity',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail:
        'That unit of measure is not on this item’s conversion ladder, so the quantity cannot be converted to base units. Add the pack size to the item master first — a quantity nothing can convert is not a quantity.',
      nextAction: 'Add the unit to the item’s UoM ladder, then retry.',
    },
  ],
  [
    'do not assume 1',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail:
        'The base quantity does not equal the entered quantity times the item’s own conversion factor. Convert with the item’s factor rather than assuming one unit per pack.',
    },
  ],
  [
    'a conversion factor between different dimensions',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail:
        'That conversion crosses unit dimensions — a bottle of syrup measures volume and a strip of tablets measures count, and nothing converts one to the other. Fix the pack definition.',
    },
  ],
  [
    'must have factor_to_base = 1',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail: 'The base rung of an item’s UoM ladder has a factor of 1 by definition.',
    },
  ],
  [
    'is_base must be true for exactly',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail:
        'Exactly one rung of an item’s UoM ladder is the base rung, and it is the one naming the item’s own base unit.',
    },
  ],
  [
    'factor_to_base must be > 0',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail: 'A pack size is a positive number. Zero or less is not a pack.',
    },
  ],
  [
    'the base UoM of',
    {
      type: ProblemType.CONFLICT,
      detail:
        'The base unit of an item cannot change once stock has moved: every historic quantity is expressed in the old unit, so the change would silently restate the whole ledger. Retire the item and create a new one.',
    },
  ],
  [
    'is not on the conversion ladder of item',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail:
        'That unit of measure is not on this item’s conversion ladder. A default the ladder does not contain produces a quantity nothing can convert.',
    },
  ],
  // ── stock preconditions — phase-04 exit gate 3 ────────────────────────────
  [
    'cannot be dispensed or issued',
    {
      type: ProblemType.CLINICAL_HARD_STOP,
      detail:
        'That batch has expired and cannot go to a patient or a department. Write it off, or return it to the supplier — those are the two ways expired stock is allowed to leave the shelf.',
      nextAction: 'Pick a different batch, or raise an expiry write-off for this one.',
    },
  ],
  [
    'does not leave the shelf towards a patient',
    {
      type: ProblemType.CLINICAL_HARD_STOP,
      detail:
        'That batch is quarantined, recalled, expired, written off or already returned. Stock in any of those states does not go to a patient.',
      nextAction: 'Choose another batch.',
    },
  ],
  [
    'an undecided quarantine is not a released one',
    {
      type: ProblemType.CLINICAL_HARD_STOP,
      detail:
        'That batch is under an open quarantine that nobody has decided yet. Release it, return it or destroy it — an undecided quarantine is not a released one.',
    },
  ],
  [
    'is invisible to a recall',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail:
        'This item is batch-tracked, so every movement of it names a batch. A movement with no batch is one no recall can ever reach.',
    },
  ],
  [
    'is not designated to hold narcotics',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'That is a controlled drug and this store is not designated to hold narcotics. Controlled stock is stored and reconciled separately.',
    },
  ],
  [
    'blocks negative stock',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'There is not enough of that item in this store, and the store does not permit a negative balance. Count the shelf and post an adjustment before issuing what is not there.',
      nextAction: 'Check the physical stock and raise an adjustment if the balance is wrong.',
    },
  ],
  [
    'disagrees with the batch it names',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'Consignment stock is never valued as ours. The movement’s consignment flag disagrees with the batch it names, which would book the vendor’s stock as our asset — or write ours off.',
    },
  ],
  [
    'is owned stock, not consignment',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'That batch is stock we already own, so it cannot be consumed through the consignment path — doing so would invoice the vendor for something already paid for.',
    },
  ],
  // ── the counter — phase-04 exit gates 3 and 4 ────────────────────────────
  [
    'cannot be sold over the counter',
    {
      type: ProblemType.STATUTORY_LIMIT,
      detail:
        'This is a scheduled drug and it cannot be sold over the counter. Rule 65(9)(a) of the Drugs and Cosmetics Rules 1945 permits retail sale of a Schedule H, H1 or X substance only against a registered practitioner’s prescription.',
      nextAction: 'Record the prescription on the dispense, then dispense against it.',
    },
  ],
  [
    'never dispense without a successful batch validation',
    {
      type: ProblemType.CLINICAL_HARD_STOP,
      detail:
        'This item is batch-tracked and the line names no batch. Scan the pack — a dispense with no validated batch is not a dispense.',
      nextAction: 'Scan or choose the batch, then add the line again.',
    },
  ],
  [
    'a controlled dispense with no traceable prescriber',
    {
      type: ProblemType.STATUTORY_LIMIT,
      detail:
        'A Schedule X or NDPS dispense carries the prescriber’s registration number, or references an internal prescription. That traceability is what the register exists for.',
    },
  ],
  [
    'has no valid drug licence',
    {
      type: ProblemType.STATUTORY_LIMIT,
      detail:
        'This counter has no drug licence (Form 20/21) valid today on record, so it may not dispense a scheduled drug.',
      nextAction: 'Update the counter’s licence details before dispensing scheduled drugs.',
    },
  ],
  [
    'no valid NDPS recognition',
    {
      type: ProblemType.STATUTORY_LIMIT,
      detail:
        'This counter has no NDPS recognition valid today on record. NDPS Rules 1985 r.52Q allows only a Recognised Medical Institution to dispense an essential narcotic drug.',
    },
  ],
  [
    'Two signatures from one person are one signature',
    {
      type: ProblemType.SECOND_PERSON_REQUIRED,
      detail:
        'A controlled drug needs a second authorising pharmacist, different from the first. Two signatures from one person are one signature.',
      nextAction: 'Ask a second authorised pharmacist to countersign on this screen.',
    },
  ],
  [
    'A controlled-drug register cannot go negative',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'That entry would take the register balance below zero. Count the safe and post a witnessed adjustment first — the register never goes negative.',
    },
  ],
  [
    'does not belong in the NDPS register',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail: 'That item is not a narcotic or psychotropic, so it does not belong in the NDPS register.',
    },
  ],
  [
    'does not belong in the Schedule X register',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail: 'That item is not a Schedule X drug, so it does not belong in the Schedule X register.',
    },
  ],
  [
    'does not belong in the Schedule H1 register',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail: 'That item is not an H1, X or NDPS drug, so it does not belong in the Schedule H1 register.',
    },
  ],
  [
    'narcotic custody variance(s) on',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'A controlled-drug count on this date still disagrees with the register and has not been adjusted. A shift does not close over an unresolved narcotic variance.',
      nextAction: 'Resolve the custody variance with a witnessed adjustment, then close the day.',
    },
  ],
  // ── goods receipt ────────────────────────────────────────────────────────
  [
    'it is a rejection',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'That batch expires on or before the receipt date. Accepting expired stock into a hospital store is not a partial receipt, it is a rejection.',
    },
  ],
  [
    'days of shelf life left',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'That batch has less shelf life left than the item requires. Reject it, or record a documented waiver on the purchase-order line.',
    },
  ],
  [
    'has no drug licence valid on the receipt date',
    {
      type: ProblemType.STATUTORY_LIMIT,
      detail:
        'This is a scheduled drug and the vendor holds no drug licence valid on the receipt date. The receipt cannot be accepted.',
    },
  ],
  [
    'this receipt names no batch number',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail:
        'This item is batch-tracked and the receipt names no batch number. Goods receipt is where a batch enters the system.',
    },
  ],
  [
    'this receipt names no expiry date',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail:
        'This item is expiry-tracked and the receipt names no expiry date. Without it no expiry check downstream can ever fire.',
    },
  ],
  // ── documents that are frozen once acted upon ────────────────────────────
  [
    'has been superseded and cannot be edited',
    {
      type: ProblemType.CONFLICT,
      detail:
        'That version of the purchase order has been superseded and the vendor holds a copy of it. Amend by issuing a new version.',
    },
  ],
  [
    'has been posted and its ledger entries exist',
    {
      type: ProblemType.CONFLICT,
      detail:
        'That adjustment has already posted its ledger entries. Post a further adjustment rather than editing this one.',
    },
  ],
  [
    'a statutory limit is not a tenant',
    {
      type: ProblemType.PERMISSION_DENIED,
      detail:
        'A statutory controlled-substance limit is the same in every hospital and is not a tenant’s to author. Add a stricter hospital policy instead.',
    },
  ],
  [
    'would become its own ancestor',
    {
      type: ProblemType.VALIDATION_FAILED,
      detail: 'That parent would make the record its own ancestor.',
    },
  ],
  [
    'hierarchy deeper than 20 levels',
    { type: ProblemType.VALIDATION_FAILED, detail: 'The hierarchy is too deep — 20 levels is the limit.' },
  ],
  [
    'a price change is not retroactive',
    {
      type: ProblemType.BUSINESS_RULE_VIOLATED,
      detail:
        'A price change is dated into force and is never retroactive: a bill already printed stays reproducible.',
    },
  ],
];

const CONSTRAINT_TRANSLATIONS: Readonly<Record<string, Translation>> = {
  stock_ledger_sign_matches_movement: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'The sign of the quantity disagrees with the kind of movement: a receipt is positive, an issue is negative, and neither may be zero. Only a correction may carry either sign.',
  },
  stock_ledger_correction_documented: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A correction names the movement it corrects and says why — both together or neither. A compensating entry with no explanation is indistinguishable from a fresh error.',
  },
  dispense_items_partial_documented: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A partial fill says why only part of the prescribed quantity was given. The prescriber has to be able to read it.',
  },
  dispense_items_substitution_traced: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A substituted line names the item it replaced, and a line naming a replaced item is a substitution. The two travel together.',
  },
  dispense_items_fefo_override_documented: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Taking a batch other than the first to expire needs a reason somebody can review.',
  },
  dispense_items_qty_non_negative: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A dispensed quantity is not negative, and no more can be returned than was dispensed.',
  },
  dispenses_someone_identified: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A dispense identifies somebody — a registered patient or a named walk-in. An anonymous sale of a prescription medicine is not a record of anything.',
  },
  controlled_drug_register_in_xor_out: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A register entry is a receipt or an issue, never both and never neither.',
  },
  controlled_drug_register_dual_auth: {
    type: ProblemType.SECOND_PERSON_REQUIRED,
    detail:
      'An NDPS register entry carries two different authorising users. Two signatures from one person are one signature.',
  },
  controlled_drug_register_dispense_identified: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A controlled dispense names the patient and the prescriber, and for NDPS and Schedule X the prescriber’s registration number as well. That is what the register is for.',
  },
  narcotic_custody_two_people: {
    type: ProblemType.SEGREGATION_OF_DUTIES,
    detail: 'A controlled-drug count is signed by two different people.',
  },
  narcotic_custody_variance_computed: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'The variance is the physical count minus the system balance; it is derived, not typed.',
  },
  narcotic_custody_variance_escalated: {
    type: ProblemType.BUSINESS_RULE_VIOLATED,
    detail:
      'A controlled-drug count that disagrees with the register cannot be filed without an incident reference and an explanation. The only way to record a discrepancy is to escalate it.',
    nextAction: 'Raise an incident, then record the count with its reference and an explanation.',
  },
  pur_grn_lines_qty_reconciles: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Accepted plus rejected must equal received on every goods-receipt line.',
  },
  pur_grn_lines_rejection_coded: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A rejected quantity carries a coded reason, and a reason belongs only to a line that rejected something.',
  },
  pur_quotation_lines_l2_justified: {
    type: ProblemType.BUSINESS_RULE_VIOLATED,
    detail:
      'Selecting a quote that is not the lowest needs a written justification. "Why did we not take L1" must never depend on somebody remembering to type it.',
  },
  adjustments_maker_is_not_checker: {
    type: ProblemType.SEGREGATION_OF_DUTIES,
    detail: 'The person who requested an adjustment cannot be the one who approves it.',
  },
  pick_list_lines_override_documented: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'Picking a batch other than the one FEFO suggested needs a reason.',
  },
  csn_usages_reversal_documented: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A reversed consignment usage names the usage it reverses and says why.',
  },
  csn_usages_wastage_documented: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A wasted consignment item carries a reason — who pays for it is the whole question.',
  },
  csn_usages_used_names_patient: {
    type: ProblemType.VALIDATION_FAILED,
    detail:
      'A consignment item recorded as used names the patient it was used on. Usage with no patient and no reversal is stock that has simply gone.',
  },
  cons_entries_reversal_documented: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A reversed consumption entry names the entry it reverses and says why.',
  },
  cons_entries_patient_named: {
    type: ProblemType.VALIDATION_FAILED,
    detail: 'A patient consumption entry names the patient.',
  },
  cost_centre_mappings_no_overlap: {
    type: ProblemType.CONFLICT,
    detail: 'That entity already has a cost centre for an overlapping period.',
  },
};

export function mapInventoryDatabaseError(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const pg = asPostgresError(error);
  if (pg === null) return error;

  if (pg.constraint !== undefined) {
    const byConstraint = CONSTRAINT_TRANSLATIONS[pg.constraint];
    if (byConstraint !== undefined) {
      return new AppError(byConstraint.type, byConstraint.detail, {
        ...(byConstraint.nextAction === undefined ? {} : { nextAction: byConstraint.nextAction }),
      });
    }
  }

  const message = pg.message ?? '';
  for (const [fragment, translation] of TRIGGER_TRANSLATIONS) {
    if (message.includes(fragment)) {
      return new AppError(translation.type, translation.detail, {
        ...(translation.nextAction === undefined ? {} : { nextAction: translation.nextAction }),
      });
    }
  }

  // A duplicate item code, store code, document number or register serial is a
  // retry, not a bug. The unique index is doing its job and the caller needs to
  // know it was refused rather than silently merged.
  if (pg.code === '23505') {
    return new AppError(
      ProblemType.CONFLICT,
      'That identifier is already in use in this hospital. Nothing was written — re-read the record and try again.',
    );
  }

  return error;
}

/** Runs `fn` and translates anything the database refuses into a stated refusal. */
export async function withInventoryErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw mapInventoryDatabaseError(error);
  }
}

/**
 * The branch a supply-chain action happens in.
 *
 * A store, an issue, a purchase order and a dispense are all branch-scoped
 * rows, and RLS refuses an insert whose branch is outside the session's scope.
 * Resolving it in one place makes the failure "choose a branch" rather than a
 * `WITH CHECK` violation from inside an audit write.
 */
export function requireBranch(explicit?: string): string {
  const ctx = getContext();
  const branchId = explicit ?? ctx.branchId;
  if (branchId === null || branchId === undefined) {
    throw AppError.conflict(
      'This session is not acting in a branch, and a stock movement belongs to one. Choose a branch and try again.',
    );
  }
  return branchId;
}

/** The acting user, for a payload field or a column that must not be null. */
export function actorId(): string {
  const id = getContext().userId;
  if (id === null) throw AppError.unauthenticated();
  return id;
}

/** The hospital, for a cursor binding or a function argument. */
export function hospitalId(): string {
  const id = getContext().hospitalId;
  if (id === null) throw AppError.unauthenticated();
  return id;
}

/** Postgres `numeric` arrives as a string; `null` stays null. */
export function toNumber(value: string | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * A quantity, as the event registry wants it.
 *
 * **`quantity` in `packages/contracts/src/events/registry.ts` is
 * `/^\d+(\.\d{1,4})?$/` — it refuses a leading minus.** A ledger row's
 * `qty_base` is signed (positive in, negative out, and `sum()` is therefore the
 * balance), so the magnitude is what travels on the event and the direction is
 * carried by `movementType`, whose sign the `stock_ledger_sign_matches_movement`
 * CHECK fixes for every type but `correction`.
 *
 * That asymmetry is a defect in the registry rather than a design: publishing
 * `"-5"` would fail its own schema and refuse a movement that has physically
 * happened. It is reported with this phase.
 */
export function quantityString(value: number): string {
  // Signed, now that the contract's `quantity` accepts a minus.
  //
  // It emitted `Math.abs()` because the pattern was `^\d+...` and publishing a
  // negative would have failed the event's own schema and rolled back a movement
  // that had physically happened. The cost was that a consumer had to recover
  // direction from `movementType` — workable for `stock.moved`, impossible for
  // `stock.corrected`, which carries no movement type. The sign is the thing
  // that makes `sum(qty_base)` a balance, so it travels with the quantity.
  return value.toFixed(4);
}

/** Money in an event payload is a decimal string, never a float (docs/01 §5). */
export function moneyString(value: number): string {
  return value.toFixed(2);
}

/**
 * `docs/03 §Table rules`: a row that carries a status carries who changed it.
 * Phase 4's documents keep that on the row itself (`approved_by`, `posted_at`),
 * so this is the shared guard rather than a shared writer: a status transition
 * that is not one of the allowed ones is refused with the states named, which is
 * what turns a 500 into "this purchase order is already approved".
 */
export function assertStatus(
  what: string,
  current: string,
  allowed: readonly string[],
  action: string,
): void {
  if (allowed.includes(current)) return;
  throw new AppError(
    ProblemType.ALREADY_DECIDED,
    `${what} is "${current}", and only ${allowed.map((s) => `"${s}"`).join(' or ')} can be ${action}.`,
  );
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
 * The `$n` binder every list query in this module uses.
 *
 * `docs/04 §6` bans SQL string concatenation; this is the shape that satisfies
 * it — the *predicate* is assembled from fixed fragments and every *value* goes
 * through a placeholder, so no caller-supplied text ever reaches the parser.
 */
export function binder(values: unknown[]): (value: unknown) => string {
  return (value: unknown) => `$${values.push(value)}`;
}
