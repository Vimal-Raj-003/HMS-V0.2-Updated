/**
 * Trauma scores: RTS, ISS, NISS, shock index, MGAP/GAP and TRISS.
 *
 * All pure, all shared between the tablet and the server. `phase-06`: "Never let
 * a UI compute a score the server does not agree with."
 *
 * ── Why the arrival values are frozen ───────────────────────────────────────
 *
 * TRISS is a survival probability computed from the patient's physiology *on
 * arrival*. Recomputing it from current observations two hours into a
 * resuscitation produces a number that says the patient was always going to
 * survive, because by then you have resuscitated them. The caller is responsible
 * for passing the arrival set; `TR-001` stores them separately for exactly this
 * reason.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Revised Trauma Score — Champion et al. (1989)
// ─────────────────────────────────────────────────────────────────────────────

/** RTS component weights. Fixed by the published model; not configuration. */
const RTS_WEIGHT_GCS = 0.9368;
const RTS_WEIGHT_SBP = 0.7326;
const RTS_WEIGHT_RR = 0.2908;

export interface RtsInput {
  /** Total GCS, 3–15. An intubated patient's eye+motor total is not valid here. */
  readonly gcs: number;
  /** Systolic blood pressure, mmHg. */
  readonly systolicBp: number;
  /** Respiratory rate, breaths per minute. */
  readonly respiratoryRate: number;
}

export interface RtsResult {
  readonly gcsCoded: 0 | 1 | 2 | 3 | 4;
  readonly sbpCoded: 0 | 1 | 2 | 3 | 4;
  readonly rrCoded: 0 | 1 | 2 | 3 | 4;
  /** 0 – 7.8408. Higher is better. */
  readonly rts: number;
  /** The unweighted sum, 0–12, used for triage in the field. */
  readonly codedSum: number;
}

function codeGcs(gcs: number): 0 | 1 | 2 | 3 | 4 {
  if (gcs >= 13) return 4;
  if (gcs >= 9) return 3;
  if (gcs >= 6) return 2;
  if (gcs >= 4) return 1;
  return 0;
}

function codeSbp(sbp: number): 0 | 1 | 2 | 3 | 4 {
  if (sbp > 89) return 4;
  if (sbp >= 76) return 3;
  if (sbp >= 50) return 2;
  if (sbp >= 1) return 1;
  return 0;
}

function codeRr(rr: number): 0 | 1 | 2 | 3 | 4 {
  // Note the shape: both too slow and too fast are abnormal, but a rate above 29
  // codes 3 while 6–9 codes 2. Tachypnoea is compensating; bradypnoea is failing.
  if (rr >= 10 && rr <= 29) return 4;
  if (rr > 29) return 3;
  if (rr >= 6) return 2;
  if (rr >= 1) return 1;
  return 0;
}

export function scoreRts(input: RtsInput): RtsResult {
  const gcsCoded = codeGcs(input.gcs);
  const sbpCoded = codeSbp(input.systolicBp);
  const rrCoded = codeRr(input.respiratoryRate);

  const rts = RTS_WEIGHT_GCS * gcsCoded + RTS_WEIGHT_SBP * sbpCoded + RTS_WEIGHT_RR * rrCoded;

  return {
    gcsCoded,
    sbpCoded,
    rrCoded,
    // Four places: TRISS is sensitive to RTS, and rounding to two shifts the
    // survival probability in the third decimal.
    rts: Math.round(rts * 10_000) / 10_000,
    codedSum: gcsCoded + sbpCoded + rrCoded,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Injury Severity Score — Baker et al. (1974) — and NISS — Osler et al. (1997)
// ─────────────────────────────────────────────────────────────────────────────

/** The six AIS body regions. ISS takes the worst injury in each. */
export const ISS_REGIONS = ['head_neck', 'face', 'chest', 'abdomen', 'extremity', 'external'] as const;
export type IssRegion = (typeof ISS_REGIONS)[number];

export interface AisInjury {
  readonly region: IssRegion;
  /** Abbreviated Injury Scale severity, 1–6. */
  readonly severity: number;
}

export interface IssResult {
  /** 1–75. */
  readonly iss: number;
  /** 1–75. Osler's variant: three highest anywhere, same region allowed. */
  readonly niss: number;
  /** The three regions ISS actually used, worst first. */
  readonly issRegions: readonly IssRegion[];
  /**
   * True when any injury is AIS 6 — an unsurvivable injury. ISS is defined as 75
   * outright in that case rather than by the sum of squares, and NISS follows.
   */
  readonly unsurvivable: boolean;
  /** `minor` < 9, `moderate` 9–15, `severe` 16–24, `profound` ≥ 25. */
  readonly band: 'minor' | 'moderate' | 'severe' | 'profound';
}

/**
 * The ISS severity band, from the score alone.
 *
 * Exported because a stored ISS has to band the same way a freshly computed one
 * does. Deriving it at compute time and dropping it on reload made the badge
 * appear and then disappear on a page refresh, which reads as the record having
 * changed.
 */
export function issBand(iss: number): IssResult['band'] {
  if (iss >= 25) return 'profound';
  if (iss >= 16) return 'severe';
  if (iss >= 9) return 'moderate';
  return 'minor';
}

export function scoreIss(injuries: readonly AisInjury[]): IssResult {
  for (const injury of injuries) {
    if (!Number.isInteger(injury.severity) || injury.severity < 1 || injury.severity > 6) {
      throw new RangeError('AIS severity must be an integer between 1 and 6');
    }
  }

  if (injuries.length === 0) {
    return { iss: 0, niss: 0, issRegions: [], unsurvivable: false, band: 'minor' };
  }

  // An AIS 6 is an injury described as unsurvivable. Both scores go to 75 by
  // definition — arithmetic on the other regions would understate it.
  if (injuries.some((i) => i.severity === 6)) {
    const region = injuries.find((i) => i.severity === 6)?.region;
    return {
      iss: 75,
      niss: 75,
      issRegions: region === undefined ? [] : [region],
      unsurvivable: true,
      band: 'profound',
    };
  }

  // ISS: worst injury per region, then the three highest of those.
  const worstPerRegion = new Map<IssRegion, number>();
  for (const injury of injuries) {
    const current = worstPerRegion.get(injury.region) ?? 0;
    if (injury.severity > current) worstPerRegion.set(injury.region, injury.severity);
  }
  const topRegions = [...worstPerRegion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const iss = topRegions.reduce((sum, [, severity]) => sum + severity * severity, 0);

  // NISS: the three highest injuries anywhere, even all in one region. Osler's
  // point was that three severe chest injuries kill you regardless of the fact
  // that ISS only counts the worst one.
  const niss = [...injuries]
    .map((i) => i.severity)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, severity) => sum + severity * severity, 0);

  return {
    iss,
    niss,
    issRegions: topRegions.map(([region]) => region),
    unsurvivable: false,
    band: issBand(iss),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shock index, MGAP and GAP
// ─────────────────────────────────────────────────────────────────────────────

export interface ShockIndexResult {
  readonly value: number;
  /**
   * Above 0.9 predicts transfusion and mortality better than either heart rate
   * or blood pressure alone — it catches the compensating young patient whose
   * pressure has not dropped yet.
   */
  readonly elevated: boolean;
}

export function shockIndex(heartRate: number, systolicBp: number): ShockIndexResult {
  if (systolicBp <= 0) throw new RangeError('Shock index needs a systolic pressure above zero');
  const value = Math.round((heartRate / systolicBp) * 100) / 100;
  return { value, elevated: value > 0.9 };
}

export interface MgapInput {
  readonly gcs: number;
  readonly systolicBp: number;
  readonly ageYears: number;
  readonly blunt: boolean;
}

export interface MgapResult {
  /** MGAP 3–29. Higher is better. */
  readonly mgap: number;
  /** GAP 3–24 — MGAP without the mechanism term. */
  readonly gap: number;
  /** MGAP risk bands from Sartorius et al. (2010). */
  readonly mgapRisk: 'low' | 'intermediate' | 'high';
}

export function scoreMgap(input: MgapInput): MgapResult {
  const mechanism = input.blunt ? 4 : 0;
  const age = input.ageYears < 60 ? 5 : 0;
  const bp = input.systolicBp > 120 ? 5 : input.systolicBp >= 60 ? 3 : 0;

  const gap = input.gcs + age + bp;
  const mgap = gap + mechanism;

  return {
    mgap,
    gap,
    mgapRisk: mgap >= 23 ? 'low' : mgap >= 18 ? 'intermediate' : 'high',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRISS — Boyd et al. (1987)
// ─────────────────────────────────────────────────────────────────────────────

export interface TrissCoefficients {
  readonly label: string;
  readonly b0: number;
  readonly bRts: number;
  readonly bIss: number;
  readonly bAge: number;
}

/**
 * The MTOS coefficient sets, blunt and penetrating.
 *
 * These are the published defaults and are the wrong numbers for most Indian
 * trauma populations — MTOS was derived from North American registries in the
 * 1980s. `phase-06` requires a local coefficient set to be loadable and
 * versioned for exactly that reason; until a hospital has one, these are what
 * comparisons in the literature use, and using them knowingly beats inventing
 * something.
 */
export const TRISS_MTOS: Readonly<Record<'blunt' | 'penetrating', TrissCoefficients>> = {
  blunt: { label: 'MTOS blunt', b0: -1.247, bRts: 0.9544, bIss: -0.0768, bAge: -1.9052 },
  penetrating: { label: 'MTOS penetrating', b0: -0.6029, bRts: 1.143, bIss: -0.1516, bAge: -2.6676 },
};

export interface TrissInput {
  /** Weighted RTS from the **arrival** observations. */
  readonly rts: number;
  readonly iss: number;
  readonly ageYears: number;
  readonly mechanism: 'blunt' | 'penetrating';
  /** A hospital's own validated set, if it has one. */
  readonly coefficients?: TrissCoefficients | undefined;
}

export interface TrissResult {
  /** Probability of survival, 0–1. */
  readonly probabilityOfSurvival: number;
  /** The same as a percentage to one place, for display. */
  readonly displayPct: string;
  /** 0 under 55, 1 at 55 and over. The model has no finer age term. */
  readonly ageIndex: 0 | 1;
  readonly coefficientSet: string;
  readonly b: number;
}

export function scoreTriss(input: TrissInput): TrissResult {
  const coefficients = input.coefficients ?? TRISS_MTOS[input.mechanism];
  // The age term is a step at 55, not a gradient. A 54-year-old and a
  // 56-year-old with identical injuries get materially different predictions,
  // which is a known crudeness of the model rather than a bug here.
  const ageIndex: 0 | 1 = input.ageYears >= 55 ? 1 : 0;

  const b =
    coefficients.b0 +
    coefficients.bRts * input.rts +
    coefficients.bIss * input.iss +
    coefficients.bAge * ageIndex;

  const ps = 1 / (1 + Math.exp(-b));

  return {
    probabilityOfSurvival: Math.round(ps * 10_000) / 10_000,
    displayPct: `${(ps * 100).toFixed(1)}%`,
    ageIndex,
    coefficientSet: coefficients.label,
    b: Math.round(b * 10_000) / 10_000,
  };
}
