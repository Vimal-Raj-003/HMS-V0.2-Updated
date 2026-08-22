import type {
  DoseBasis,
  DrugSearchResult,
  DurationUnit,
  OverrideInput,
  PrescriptionLineRequest,
  Timing,
} from '../api/types';

/**
 * The e-Rx grid's line model — OP-002 §3.3.
 *
 * Held as strings for the same reason the vitals form is: a half-typed dose is a
 * legitimate state of a text field, and a numeric model turns "1" on the way to
 * "1.5" into a dose the CDSS evaluates.
 *
 * `doseBasis` is the field that carries the most weight on this screen. `per_kg`
 * means the server computes the dose from the **encounter's** dosing weight —
 * the client never supplies one, and the request schema will not accept one — so
 * a line marked per-kilogram on a patient with no recorded weight is refused,
 * loudly, before anything is prescribed.
 */

export interface RxLine {
  /** Client-side identity only. Never sent; the server numbers lines itself. */
  readonly key: string;
  readonly drugKey: string | null;
  readonly genericName: string;
  readonly brandName: string | null;
  readonly strengthText: string | null;
  readonly schedule: string | null;
  readonly isHighAlert: boolean;
  readonly isLasa: boolean;
  readonly doseQty: string;
  readonly doseUnit: string;
  readonly doseBasis: DoseBasis;
  readonly frequencyCode: string;
  readonly timing: Timing | '';
  readonly durationValue: string;
  readonly durationUnit: DurationUnit;
  readonly instructionsText: string;
  readonly isPrn: boolean;
}

export function emptyLine(key: string): RxLine {
  return {
    key,
    drugKey: null,
    genericName: '',
    brandName: null,
    strengthText: null,
    schedule: null,
    isHighAlert: false,
    isLasa: false,
    doseQty: '',
    doseUnit: 'mg',
    doseBasis: 'flat',
    frequencyCode: '',
    timing: '',
    durationValue: '',
    durationUnit: 'days',
    instructionsText: '',
    isPrn: false,
  };
}

export function lineFromDrug(key: string, drug: DrugSearchResult): RxLine {
  return {
    ...emptyLine(key),
    drugKey: drug.record_key,
    // The tall-man rendering where the master has one: `predniSONE` /
    // `predniSOLONE` is the whole point of the column, and dropping it here
    // would undo a look-alike/sound-alike control at the last step.
    genericName: drug.tall_man_display ?? drug.generic_name,
    brandName: drug.brand_name,
    strengthText: drug.strength_text,
    schedule: drug.schedule,
    isHighAlert: drug.is_high_alert,
    isLasa: drug.is_lasa,
  };
}

/**
 * Frequency codes.
 *
 * A **client-side list**, and another reported gap: `frequencyCode` is a free
 * 24-character string on the wire and there is no frequency master endpoint to
 * populate a picker from. These are the standard abbreviations an Indian OPD
 * prescription uses; a hospital that codes frequencies differently will need the
 * master, not an edit here.
 */
export const FREQUENCIES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'OD', label: 'Once a day (OD)' },
  { code: 'BD', label: 'Twice a day (BD)' },
  { code: 'TDS', label: 'Three times a day (TDS)' },
  { code: 'QID', label: 'Four times a day (QID)' },
  { code: 'HS', label: 'At night (HS)' },
  { code: 'SOS', label: 'When required (SOS)' },
  { code: 'STAT', label: 'Immediately, once (STAT)' },
  { code: 'Q4H', label: 'Every 4 hours' },
  { code: 'Q6H', label: 'Every 6 hours' },
  { code: 'Q8H', label: 'Every 8 hours' },
  { code: 'WEEKLY', label: 'Once a week' },
];

export const TIMING_LABELS: Readonly<Record<Timing, string>> = {
  before_food: 'Before food',
  after_food: 'After food',
  with_food: 'With food',
  empty_stomach: 'On an empty stomach',
  bedtime: 'At bedtime',
  any: 'Any time',
};

export const DURATION_LABELS: Readonly<Record<DurationUnit, string>> = {
  days: 'days',
  weeks: 'weeks',
  months: 'months',
  continuous: 'continuing',
};

export const DOSE_BASIS_LABELS: Readonly<Record<DoseBasis, string>> = {
  flat: 'Fixed dose',
  per_kg: 'Per kilogram',
  per_m2: 'Per square metre',
};

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * One line, in request shape.
 *
 * `overrides` are attached by family, which is how the API keys them: one coded
 * reason answers every alert of that family on the prescription, because that is
 * how a prescriber thinks about it and how the fatigue report aggregates it.
 */
export function toLineRequest(line: RxLine, overrides: readonly OverrideInput[]): PrescriptionLineRequest {
  const doseQty = numberOrNull(line.doseQty);
  const durationValue = numberOrNull(line.durationValue);
  const instructions = line.instructionsText.trim();
  const frequency = line.frequencyCode.trim();
  const doseUnit = line.doseUnit.trim();

  return {
    ...(line.drugKey === null ? { genericName: line.genericName.trim() } : { drugKey: line.drugKey }),
    ...(doseQty === null ? {} : { doseQty }),
    ...(doseUnit === '' ? {} : { doseUnit }),
    doseBasis: line.doseBasis,
    ...(frequency === '' ? {} : { frequencyCode: frequency }),
    ...(line.timing === '' ? {} : { timing: line.timing }),
    ...(durationValue === null ? {} : { durationValue }),
    durationUnit: line.durationUnit,
    ...(instructions === '' ? {} : { instructionsText: instructions }),
    isPrn: line.isPrn,
    ...(overrides.length === 0 ? {} : { overrides }),
  };
}

/** Everything a line must have before it is worth asking the safety engine about. */
export function lineProblems(line: RxLine): readonly string[] {
  const problems: string[] = [];
  if (line.drugKey === null && line.genericName.trim().length < 2) {
    problems.push('Choose a drug, or type the name of the one being recommended.');
  }
  if (line.doseQty.trim() !== '' && numberOrNull(line.doseQty) === null) {
    problems.push('The dose must be a number greater than zero.');
  }
  if (line.durationValue.trim() !== '' && numberOrNull(line.durationValue) === null) {
    problems.push('The duration must be a whole number of days, weeks or months.');
  }
  return problems;
}

export function isLineReady(line: RxLine): boolean {
  return lineProblems(line).length === 0 && (line.drugKey !== null || line.genericName.trim().length >= 2);
}

/** A one-line summary of the line for a confirmation or a print. */
export function describeLine(line: RxLine): string {
  const parts = [line.genericName];
  if (line.strengthText !== null && line.strengthText !== '') parts.push(line.strengthText);
  if (line.doseQty.trim() !== '') {
    parts.push(
      line.doseBasis === 'per_kg'
        ? `${line.doseQty} ${line.doseUnit}/kg`
        : `${line.doseQty} ${line.doseUnit}`,
    );
  }
  if (line.frequencyCode !== '') parts.push(line.frequencyCode);
  if (line.durationValue.trim() !== '') {
    parts.push(`for ${line.durationValue} ${DURATION_LABELS[line.durationUnit]}`);
  }
  return parts.filter((part) => part !== '').join(' · ');
}
