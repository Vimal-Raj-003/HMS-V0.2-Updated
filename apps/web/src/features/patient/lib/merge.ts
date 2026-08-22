import type { PatientDetail } from '../api/types';
import { formatBloodGroup, formatDate, humaniseFieldName } from './format';

/**
 * The side-by-side comparison behind the merge tool (OP-001 §3.8, §8 "Dedupe/Merge:
 * side-by-side compare, field-level pick").
 *
 * All of it is pure, because the decision it supports is irreversible for thirty
 * days and a rule that only exists inside a component is a rule nobody can test.
 * `merge.spec.ts` asserts each one.
 */

/** Every field the officer is asked to adjudicate, in the order they read them. */
export const COMPARED_FIELDS = [
  'full_name',
  'gender',
  'dob',
  'mobile',
  'alt_phone',
  'email',
  'blood_group',
  'marital_status',
  'address_line1',
  'city',
  'district',
  'state',
  'pincode',
  'category',
  'payer_type',
  'payer_ref',
  'abha_number',
  'abha_address',
  'preferred_language',
] as const;

export type ComparedField = (typeof COMPARED_FIELDS)[number];

export type SurvivorChoice = 'survivor' | 'victim';

export interface ComparisonRow {
  readonly field: ComparedField;
  readonly label: string;
  readonly survivorValue: string | null;
  readonly victimValue: string | null;
  /**
   * True when the two records disagree and **both** hold something. A field the
   * victim alone has filled in is not a contest — it is information the survivor
   * is missing, and the merge should keep it without asking.
   */
  readonly contested: boolean;
  /** True when only one side has a value; the non-empty side is the obvious keep. */
  readonly onlyOneSide: boolean;
}

/**
 * One compared field's value, read by name.
 *
 * Indexed rather than switched over nineteen cases because the field list is the
 * contract and a `switch` would let the two drift. Only the primitive shapes the
 * compared columns actually hold are stringified; anything else is treated as
 * absent rather than rendered as `[object Object]` and offered as a choice.
 */
function raw(patient: PatientDetail, field: ComparedField): string | null {
  const value: unknown = (patient as unknown as Record<string, unknown>)[field];
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return null;
}

function display(field: ComparedField, value: string | null): string | null {
  if (value === null) return null;
  if (field === 'dob') return formatDate(value);
  if (field === 'blood_group') return formatBloodGroup(value);
  return value;
}

const LABELS: Partial<Record<ComparedField, string>> = {
  full_name: 'Name',
  dob: 'Date of birth',
  mobile: 'Mobile',
  alt_phone: 'Alternate phone',
  address_line1: 'Address',
  abha_number: 'ABHA number',
  abha_address: 'ABHA address',
  payer_ref: 'Payer reference',
};

export function compareForMerge(survivor: PatientDetail, victim: PatientDetail): readonly ComparisonRow[] {
  return COMPARED_FIELDS.map((field) => {
    const survivorRaw = raw(survivor, field);
    const victimRaw = raw(victim, field);
    const both = survivorRaw !== null && victimRaw !== null;
    return {
      field,
      label: LABELS[field] ?? humaniseFieldName(field),
      survivorValue: display(field, survivorRaw),
      victimValue: display(field, victimRaw),
      contested: both && survivorRaw !== victimRaw,
      onlyOneSide: (survivorRaw === null) !== (victimRaw === null),
    };
  });
}

/**
 * The default pick for every row: the survivor, except where only the victim has
 * a value.
 *
 * Defaulting a blank survivor field to the survivor would discard the only copy
 * of a mobile number or an ABHA address the hospital holds, and the officer would
 * have to notice a blank-versus-filled row to prevent it. Defaulting the other
 * way round loses nothing: the officer can still choose the survivor explicitly.
 */
export function defaultFieldChoices(
  rows: readonly ComparisonRow[],
): Readonly<Record<string, SurvivorChoice>> {
  const choices: Record<string, SurvivorChoice> = {};
  for (const row of rows) {
    if (row.contested || row.onlyOneSide) {
      choices[row.field] = row.survivorValue === null && row.victimValue !== null ? 'victim' : 'survivor';
    }
  }
  return choices;
}

/** Rows the officer actually has to look at. Identical fields are not decisions. */
export function decidableRows(rows: readonly ComparisonRow[]): readonly ComparisonRow[] {
  return rows.filter((row) => row.contested || row.onlyOneSide);
}

export interface MergeEligibility {
  readonly allowed: boolean;
  /** Why not, in ward language. Empty when allowed. */
  readonly refusals: readonly string[];
}

/**
 * Whether these two records may be merged at all, checked before the API is asked.
 *
 * These are not duplicates of the server's rules for the sake of it — each one
 * turns a 422 that arrives after the officer has typed a reason into a sentence
 * shown while they are still choosing the pair.
 */
export function assessMerge(
  survivor: PatientDetail | undefined,
  victim: PatientDetail | undefined,
): MergeEligibility {
  const refusals: string[] = [];
  if (survivor === undefined || victim === undefined) {
    return { allowed: false, refusals: ['Choose both records before merging.'] };
  }
  if (survivor.id === victim.id) {
    refusals.push('A record cannot be merged into itself.');
  }
  if (survivor.merged_into_id !== null) {
    refusals.push(
      `The surviving record has itself already been merged into another (${survivor.uhid}). Merge into the record that survived that merge instead.`,
    );
  }
  if (victim.merged_into_id !== null) {
    refusals.push(`${victim.uhid} has already been merged. Merging it again would hide the first merge.`);
  }
  if (survivor.is_deceased && !victim.is_deceased) {
    refusals.push(
      'The surviving record is marked deceased and the other is not. Confirm which record is correct before merging — a living patient must not inherit a death record.',
    );
  }
  return { allowed: refusals.length === 0, refusals };
}

/**
 * What the merge will re-point, said in words rather than table names.
 *
 * OP-001 §3.8 makes the fan-out the whole point of a merge: "re-points
 * visits/bills/orders via event fan-out (each module reacts to `patient.merged`)".
 * The impact list the API returns names *its own* tables; the sentence below says
 * what that means for the person deciding, including the part this module cannot
 * count — everything downstream that reacts to the event.
 */
export function describeImpact(
  impact: readonly { readonly table: string; readonly rows: number }[],
): readonly string[] {
  const lines = impact
    .filter((entry) => entry.rows > 0)
    .map((entry) => `${String(entry.rows)} × ${humaniseFieldName(entry.table)}`);
  return lines;
}
