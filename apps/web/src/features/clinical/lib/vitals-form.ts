import type { CreateVitalsRequest, GlucoseType, VitalFlag } from '../api/types';
import { flagFor, plausibilityBreach, selectRange, type ParsedRange, type RangeSubject } from './ranges';

/**
 * The vitals station's form, as state and as a request.
 *
 * Held as **strings**, not numbers. A half-typed "3" on the way to "37.2" is a
 * legitimate intermediate state of a text field, and a numeric state would turn
 * it into a value that flags as critical hypothermia while the nurse is still
 * typing. Parsing happens once, at the edges: `parsedValue` for the live
 * preview, `toCreateRequest` for the save.
 *
 * The `parameter` on each field is the name the API scores against
 * (`clinical.vitals_reference_ranges.parameter`), copied from
 * `vitals.service.ts`'s own reading list — including the one that is not a
 * simple rename: glucose is scored as `glucose_rbs` / `glucose_fbs` / … , one
 * band per test type, because 140 mg/dL is unremarkable after a meal and
 * abnormal fasting.
 *
 * There is **no threshold anywhere in this file.** The `min`/`max` on the inputs
 * are the *storage* bounds the migration already enforces — a value outside them
 * cannot be persisted at all — so a nurse gets a field message instead of a 500
 * from a CHECK. The clinical bands live in the database and arrive through
 * `GET /vitals/reference-ranges`.
 */

export interface VitalsFormState {
  readonly systolic: string;
  readonly diastolic: string;
  readonly pulse: string;
  readonly spo2: string;
  readonly onOxygen: boolean;
  readonly temperatureC: string;
  readonly respRate: string;
  readonly glucoseMgdl: string;
  readonly glucoseType: GlucoseType | '';
  readonly heightCm: string;
  readonly weightKg: string;
  readonly painScore: string;
  readonly notes: string;
}

export const EMPTY_VITALS_FORM: VitalsFormState = {
  systolic: '',
  diastolic: '',
  pulse: '',
  spo2: '',
  onOxygen: false,
  temperatureC: '',
  respRate: '',
  glucoseMgdl: '',
  glucoseType: '',
  heightCm: '',
  weightKg: '',
  painScore: '',
  notes: '',
};

export type NumericField = Exclude<keyof VitalsFormState, 'onOxygen' | 'glucoseType' | 'notes'>;

export interface FieldSpec {
  readonly key: NumericField;
  /** The reference-range parameter, or `null` where the API scores it under another name. */
  readonly parameter: string | null;
  readonly label: string;
  readonly unit: string;
  /** Storage bounds from the migration, so a refusal is a field message not a 500. */
  readonly min: number;
  readonly max: number;
  readonly step: string;
  /** `decimal` puts a full keypad on a tablet; `numeric` puts digits only. */
  readonly inputMode: 'numeric' | 'decimal';
}

/**
 * Tab order is OP-007 §8's: BP → pulse → SpO2 → temp → RR → glucose → height →
 * weight → pain. It is the order the devices sit in on the trolley, which is why
 * it is not alphabetical and must not be "tidied".
 */
export const VITALS_FIELDS: readonly FieldSpec[] = [
  {
    key: 'systolic',
    parameter: 'systolic',
    label: 'Systolic BP',
    unit: 'mmHg',
    min: 40,
    max: 300,
    step: '1',
    inputMode: 'numeric',
  },
  {
    key: 'diastolic',
    parameter: 'diastolic',
    label: 'Diastolic BP',
    unit: 'mmHg',
    min: 10,
    max: 200,
    step: '1',
    inputMode: 'numeric',
  },
  {
    key: 'pulse',
    parameter: 'pulse',
    label: 'Pulse',
    unit: '/min',
    min: 20,
    max: 300,
    step: '1',
    inputMode: 'numeric',
  },
  {
    key: 'spo2',
    parameter: 'spo2',
    label: 'SpO₂',
    unit: '%',
    min: 0,
    max: 100,
    step: '1',
    inputMode: 'numeric',
  },
  {
    key: 'temperatureC',
    parameter: 'temperature_c',
    label: 'Temperature',
    unit: '°C',
    min: 30,
    max: 45,
    step: '0.1',
    inputMode: 'decimal',
  },
  {
    key: 'respRate',
    parameter: 'resp_rate',
    label: 'Respiratory rate',
    unit: '/min',
    min: 4,
    max: 80,
    step: '1',
    inputMode: 'numeric',
  },
  // Scored as `glucose_{type}`; resolved by `parameterFor` once the type is known.
  {
    key: 'glucoseMgdl',
    parameter: null,
    label: 'Blood glucose',
    unit: 'mg/dL',
    min: 0,
    max: 2000,
    step: '1',
    inputMode: 'numeric',
  },
  {
    key: 'heightCm',
    parameter: 'height_cm',
    label: 'Height',
    unit: 'cm',
    min: 30,
    max: 250,
    step: '0.1',
    inputMode: 'decimal',
  },
  // Never zero: the storage CHECK starts at 0.3 kg, and that is the point —
  // "we do not know the weight" and "the weight is zero" must never be the same
  // value, because the second one silently unblocks a per-kilogram dose.
  {
    key: 'weightKg',
    parameter: 'weight_kg',
    label: 'Weight',
    unit: 'kg',
    min: 0.3,
    max: 400,
    step: '0.1',
    inputMode: 'decimal',
  },
  {
    key: 'painScore',
    parameter: 'pain_score',
    label: 'Pain score',
    unit: 'NRS 0–10',
    min: 0,
    max: 10,
    step: '1',
    inputMode: 'numeric',
  },
];

/** The reference-range parameter for a field, given the rest of the form. */
export function parameterFor(field: FieldSpec, state: VitalsFormState): string | null {
  if (field.key === 'glucoseMgdl') {
    return state.glucoseType === '' ? null : `glucose_${state.glucoseType}`;
  }
  return field.parameter;
}

/** `null` for an empty or unparseable field — never `NaN`, which compares false silently. */
export function parsedValue(state: VitalsFormState, key: NumericField): number | null {
  const raw = state[key].trim();
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface FieldVerdict {
  readonly field: FieldSpec;
  readonly value: number | null;
  /** `null` means "not scored" — no band is configured — and is never drawn as normal. */
  readonly flag: VitalFlag | null;
  /** Set when the value is outside the *plausible* band: a typo, not a finding. */
  readonly implausible: string | null;
  /** Set when the value is outside the storage bounds the migration enforces. */
  readonly outOfRange: string | null;
}

/**
 * The live preview a nurse sees while typing.
 *
 * `ranges === null` means the bands could not be read — which happens routinely,
 * because `GET /vitals/reference-ranges` is gated on `vitals.configure` and the
 * vitals nurse does not hold it. In that case every flag is `null`: the screen
 * shows no colour and says why, and the server's verdict arrives with the saved
 * record. It does **not** fall back to a built-in threshold.
 */
export function previewVerdicts(
  state: VitalsFormState,
  ranges: readonly ParsedRange[] | null,
  subject: RangeSubject,
): readonly FieldVerdict[] {
  return VITALS_FIELDS.map((field) => {
    const value = parsedValue(state, field.key);
    const outOfRange =
      value === null || (value >= field.min && value <= field.max)
        ? null
        : `${field.label} must be between ${String(field.min)} and ${String(field.max)} ${field.unit}.`;

    if (value === null || ranges === null) {
      return { field, value, flag: null, implausible: null, outOfRange };
    }

    const parameter = parameterFor(field, state);
    const range = parameter === null ? null : selectRange(ranges, parameter, subject);
    const breach = parameter === null ? null : plausibilityBreach(range, parameter, value);

    return {
      field,
      value,
      flag: breach === null ? flagFor(range, value) : null,
      implausible:
        breach === null
          ? null
          : `${field.label} of ${String(value)} ${field.unit} is outside the range this hospital treats as possible. Check the reading.`,
      outOfRange,
    };
  });
}

/** Everything the form must fix before a save is worth attempting. */
export function blockingMessages(
  verdicts: readonly FieldVerdict[],
  state: VitalsFormState,
): readonly string[] {
  const messages: string[] = [];
  for (const verdict of verdicts) {
    if (verdict.outOfRange !== null) messages.push(verdict.outOfRange);
    if (verdict.implausible !== null) messages.push(verdict.implausible);
  }

  const systolic = parsedValue(state, 'systolic');
  const diastolic = parsedValue(state, 'diastolic');
  // OP-007 §14 AC-7. The database refuses it too; saying so here saves the nurse
  // a round trip and a refusal that reads like a system fault.
  if (systolic !== null && diastolic !== null && diastolic >= systolic) {
    messages.push('Diastolic pressure must be lower than systolic. Check which figure went in which box.');
  }

  if (state.glucoseMgdl.trim() !== '' && state.glucoseType === '') {
    messages.push('Say which glucose test this is (RBS, FBS, PPBS or point-of-care HbA1c).');
  }

  return messages;
}

export function hasAnyMeasurement(state: VitalsFormState): boolean {
  return VITALS_FIELDS.some((field) => state[field.key].trim() !== '');
}

/**
 * The save payload.
 *
 * Empty fields are **omitted**, never sent as `0` or `null`. A nurse who could
 * not take a temperature must be able to save what they did take, and a zero
 * weight would be read downstream as a weight.
 */
export function toCreateRequest(
  state: VitalsFormState,
  context: { readonly patientId: string; readonly visitId?: string; readonly encounterId?: string },
): CreateVitalsRequest {
  // Written out one field at a time rather than through a loop. `exactOptionalPropertyTypes`
  // is on, so "absent" and "present but undefined" are different types — and
  // that is exactly the distinction this function exists to preserve: an omitted
  // weight must reach the API as an omitted weight, never as `undefined` in a
  // JSON body and never as zero.
  const systolic = parsedValue(state, 'systolic');
  const diastolic = parsedValue(state, 'diastolic');
  const pulse = parsedValue(state, 'pulse');
  const spo2 = parsedValue(state, 'spo2');
  const temperatureC = parsedValue(state, 'temperatureC');
  const respRate = parsedValue(state, 'respRate');
  const glucoseMgdl = parsedValue(state, 'glucoseMgdl');
  const heightCm = parsedValue(state, 'heightCm');
  const weightKg = parsedValue(state, 'weightKg');
  const painScore = parsedValue(state, 'painScore');
  const notes = state.notes.trim();
  const { glucoseType } = state;
  const visitId = context.visitId ?? '';
  const encounterId = context.encounterId ?? '';

  return {
    patientId: context.patientId,
    ...(visitId === '' ? {} : { visitId }),
    ...(encounterId === '' ? {} : { encounterId }),
    context: 'opd_vitals_room',
    ...(systolic === null ? {} : { systolic }),
    ...(diastolic === null ? {} : { diastolic }),
    ...(pulse === null ? {} : { pulse }),
    ...(spo2 === null ? {} : { spo2 }),
    onOxygen: state.onOxygen,
    ...(temperatureC === null ? {} : { temperatureC }),
    ...(respRate === null ? {} : { respRate }),
    ...(glucoseMgdl === null || glucoseType === '' ? {} : { glucoseMgdl, glucoseType }),
    ...(heightCm === null ? {} : { heightCm }),
    ...(weightKg === null ? {} : { weightKg }),
    ...(painScore === null ? {} : { painScore }),
    ...(notes === '' ? {} : { notes }),
  };
}

export const GLUCOSE_TYPE_LABELS: Readonly<Record<GlucoseType, string>> = {
  rbs: 'Random (RBS)',
  fbs: 'Fasting (FBS)',
  ppbs: 'Post-prandial (PPBS)',
  hba1c_poc: 'HbA1c (point of care)',
};
