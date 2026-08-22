/**
 * NEWS2 (RCP 2017), as tabulated in OP-007 §5.2.
 *
 * This is the one place in the module where numbers are compiled in, and the
 * reason is that NEWS2 is **not** a hospital-configurable band: it is a named,
 * published national early-warning score, and a hospital that "tunes" it is no
 * longer computing NEWS2. OP-007 §5.2 reproduces the RCP table and §5 requires
 * the score on every observation set, so the table lives here where it can be
 * unit-tested against the published chart rather than in a data row where a
 * typo would silently change what the score means.
 *
 * Two notes on the edges of the specification:
 *
 *  - **Scale 2.** OP-007 §5.2 says "Scale 2 SpO2 used only when hypercapnic-COPD
 *    flag set by a doctor" but does not reproduce the scale-2 rows. They are
 *    taken from the same cited source (RCP, *National Early Warning Score
 *    (NEWS) 2*, 2017), because implementing "NEWS2 scale 2" as anything other
 *    than the published scale 2 would be inventing a score.
 *  - **Consciousness.** An OPD vitals station rarely records AVPU on a patient
 *    who walked in. A missing AVPU is therefore scored as `alert` (0) and the
 *    result says so through `consciousnessAssumed`, which the service writes
 *    into the audit entry — a score that quietly assumed alertness must never
 *    be indistinguishable from one that observed it.
 */

export interface News2Input {
  readonly respRate: number | null;
  readonly spo2: number | null;
  readonly onOxygen: boolean;
  readonly systolic: number | null;
  readonly pulse: number | null;
  readonly temperatureC: number | null;
  /** `clinical.AvpuLevel`, or `null` when it was not observed. */
  readonly avpu: string | null;
  /** Doctor-set hypercapnic-COPD flag: switches SpO2 to scale 2. */
  readonly copdScale2: boolean;
}

export type News2Band = 'low' | 'medium' | 'high';

export interface News2Result {
  readonly score: number;
  readonly band: News2Band;
  /** Per-parameter sub-scores, so a clinician can see where the score came from. */
  readonly components: Readonly<Record<string, number>>;
  /** True when AVPU was absent and alertness was assumed rather than observed. */
  readonly consciousnessAssumed: boolean;
}

function respRateScore(value: number): number {
  if (value <= 8) return 3;
  if (value <= 11) return 1;
  if (value <= 20) return 0;
  if (value <= 24) return 2;
  return 3;
}

/** RCP scale 1 — the default target range of 94–98 %. */
function spo2Scale1Score(value: number): number {
  if (value <= 91) return 3;
  if (value <= 93) return 2;
  if (value <= 95) return 1;
  return 0;
}

/**
 * RCP scale 2 — the 88–92 % target range for hypercapnic respiratory failure.
 * Above the target band the score depends on whether the patient is on oxygen:
 * a COPD patient at 97 % on air is at their own baseline, the same patient at
 * 97 % on oxygen is over-oxygenated.
 */
function spo2Scale2Score(value: number, onOxygen: boolean): number {
  if (value <= 83) return 3;
  if (value <= 85) return 2;
  if (value <= 87) return 1;
  if (value <= 92) return 0;
  if (!onOxygen) return 0;
  if (value <= 94) return 1;
  if (value <= 96) return 2;
  return 3;
}

function systolicScore(value: number): number {
  if (value <= 90) return 3;
  if (value <= 100) return 2;
  if (value <= 110) return 1;
  if (value <= 219) return 0;
  return 3;
}

function pulseScore(value: number): number {
  if (value <= 40) return 3;
  if (value <= 50) return 1;
  if (value <= 90) return 0;
  if (value <= 110) return 1;
  if (value <= 130) return 2;
  return 3;
}

function temperatureScore(value: number): number {
  if (value <= 35.0) return 3;
  if (value <= 36.0) return 1;
  if (value <= 38.0) return 0;
  if (value <= 39.0) return 1;
  return 2;
}

/**
 * Scores an observation set, or returns `null` when it is incomplete.
 *
 * A partial NEWS2 is worse than none: five of the seven parameters can total 2
 * on a patient whose missing respiratory rate would have scored 3, and the
 * chart would then read "low risk". So the score is computed only when
 * respiratory rate, SpO2, systolic pressure, pulse and temperature are all
 * present. Oxygen delivery is a NOT NULL boolean and is therefore always known.
 */
export function scoreNews2(input: News2Input): News2Result | null {
  const { respRate, spo2, systolic, pulse, temperatureC } = input;
  if (respRate === null || spo2 === null || systolic === null || pulse === null || temperatureC === null) {
    return null;
  }

  const consciousnessAssumed = input.avpu === null;
  const components: Record<string, number> = {
    resp_rate: respRateScore(respRate),
    spo2: input.copdScale2 ? spo2Scale2Score(spo2, input.onOxygen) : spo2Scale1Score(spo2),
    oxygen: input.onOxygen ? 2 : 0,
    systolic: systolicScore(systolic),
    pulse: pulseScore(pulse),
    temperature_c: temperatureScore(temperatureC),
    consciousness: input.avpu === null || input.avpu === 'alert' ? 0 : 3,
  };

  const values = Object.values(components);
  const score = values.reduce((total, part) => total + part, 0);
  // OP-007 §5.2: "0–4 low, 5–6 **or any single 3** = medium, ≥ 7 high." The
  // single-3 clause is the clinically important half: a respiratory rate of 7
  // on an otherwise well patient totals 3 and is still an urgent review.
  const hasSingleThree = values.some((part) => part === 3);
  const band: News2Band = score >= 7 ? 'high' : score >= 5 || hasSingleThree ? 'medium' : 'low';

  return { score, band, components, consciousnessAssumed };
}
