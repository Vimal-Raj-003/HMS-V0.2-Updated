/**
 * Glasgow Coma Scale.
 *
 * Teasdale & Jennett (1974), with the paediatric verbal scale for children under
 * five and the `T` convention for an intubated patient.
 *
 * ── Why this is a pure function in `contracts` ──────────────────────────────
 *
 * `phase-06`'s constraint is "scores are code, not opinion": the same function
 * runs on the tablet and on the server, and the server never accepts a total the
 * client computed. A GCS that differs between the two by one point is the
 * difference between a level-2 and a level-1 trauma activation.
 */

/** Eye opening. 1–4. */
export const GCS_EYE = [
  { score: 4, label: 'Spontaneous' },
  { score: 3, label: 'To speech' },
  { score: 2, label: 'To pressure' },
  { score: 1, label: 'None' },
] as const;

/** Verbal response, five years and older. 1–5. */
export const GCS_VERBAL_ADULT = [
  { score: 5, label: 'Orientated' },
  { score: 4, label: 'Confused' },
  { score: 3, label: 'Words' },
  { score: 2, label: 'Sounds' },
  { score: 1, label: 'None' },
] as const;

/**
 * Verbal response under five years.
 *
 * A separate ladder, not a lenient reading of the adult one. A two-year-old who
 * is "confused" is a meaningless observation; "irritable, cries" is not.
 */
export const GCS_VERBAL_PAEDIATRIC = [
  { score: 5, label: 'Coos, babbles, interacts' },
  { score: 4, label: 'Irritable, cries' },
  { score: 3, label: 'Cries to pain' },
  { score: 2, label: 'Moans to pain' },
  { score: 1, label: 'None' },
] as const;

/** Best motor response. 1–6. */
export const GCS_MOTOR = [
  { score: 6, label: 'Obeys commands' },
  { score: 5, label: 'Localises to pain' },
  { score: 4, label: 'Normal flexion (withdraws)' },
  { score: 3, label: 'Abnormal flexion (decorticate)' },
  { score: 2, label: 'Extension (decerebrate)' },
  { score: 1, label: 'None' },
] as const;

export interface GcsInput {
  readonly eye: number;
  /**
   * Omit when the patient is intubated. A verbal score cannot be observed
   * through a tube, and inventing one is how a GCS gets quietly inflated.
   */
  readonly verbal?: number | undefined;
  readonly motor: number;
  /** Reports the total as `nT` — the convention, and it means "not assessable". */
  readonly intubated?: boolean | undefined;
  /** Drives which verbal ladder applies. */
  readonly ageYears?: number | undefined;
}

export interface GcsResult {
  readonly eye: number;
  readonly verbal: number | null;
  readonly motor: number;
  /**
   * 3–15, or 2–10 when intubated (eye + motor only).
   *
   * An intubated total is deliberately **not** padded to a comparable number.
   * Scoring the verbal component as 1 would make a patient look worse than they
   * are; scoring it as 5 would make them look better. `T` says the measurement
   * was not available, which is the truth.
   */
  readonly total: number;
  /** `12T` for an intubated patient, `12` otherwise. */
  readonly display: string;
  readonly intubated: boolean;
  readonly paediatricScale: boolean;
  /** `severe` ≤ 8, `moderate` 9–12, `mild` 13–15. Undefined when intubated. */
  readonly severity: 'severe' | 'moderate' | 'mild' | 'not_assessable';
}

function clamp(value: number, min: number, max: number, what: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`GCS ${what} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return value;
}

export function scoreGcs(input: GcsInput): GcsResult {
  const intubated = input.intubated === true;
  const paediatricScale = input.ageYears !== undefined && input.ageYears < 5;

  const eye = clamp(input.eye, 1, 4, 'eye opening');
  const motor = clamp(input.motor, 1, 6, 'motor response');
  const verbal = intubated ? null : clamp(input.verbal ?? 0, 1, 5, 'verbal response');

  const total = eye + motor + (verbal ?? 0);

  // The severity bands are defined on a full 3–15 score. Applying them to an
  // intubated 2–10 would classify almost every ventilated patient as severe
  // regardless of how they actually are.
  const severity: GcsResult['severity'] = intubated
    ? 'not_assessable'
    : total <= 8
      ? 'severe'
      : total <= 12
        ? 'moderate'
        : 'mild';

  return {
    eye,
    verbal,
    motor,
    total,
    display: intubated ? `${String(total)}T` : String(total),
    intubated,
    paediatricScale,
    severity,
  };
}
