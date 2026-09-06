/**
 * Emergency Severity Index, version 4.
 *
 * Gilboy, Tanabe, Travers & Rosenau, AHRQ. A four-decision-point algorithm that
 * a nurse walks in under a minute: A, is the patient dying? B, should they not
 * wait? C, how many resources will they need? D, are the vital signs in the
 * danger zone?
 *
 * ── The order is the safety property ────────────────────────────────────────
 *
 * A and B are asked before anyone counts resources, because the whole point is
 * that a patient who is dying is not triaged by how much work they will be. The
 * implementation below evaluates in that order and returns at the first decision
 * point that fires, and the returned `decisionPoint` says which — so a nurse
 * overriding a level can see what the algorithm actually keyed on.
 *
 * ── Danger-zone vitals are age-banded ───────────────────────────────────────
 *
 * A heart rate of 150 is a resuscitation in a 40-year-old and unremarkable in a
 * three-month-old. Applying adult thresholds to children is the single most
 * common way a paediatric triage goes wrong, so the bands below are explicit and
 * the age is required whenever vitals are supplied.
 */

export interface EsiVitals {
  readonly heartRate?: number | undefined;
  readonly respiratoryRate?: number | undefined;
  /** Room-air saturation, percent. */
  readonly spo2?: number | undefined;
  readonly temperatureC?: number | undefined;
}

export interface EsiInput {
  /**
   * Decision point A. Intubated, apnoeic, pulseless, severe respiratory
   * distress, SpO2 under 90, acute mental-status change, or any patient who
   * needs an immediate life-saving intervention.
   */
  readonly needsLifeSavingIntervention: boolean;
  /**
   * Decision point B. A high-risk situation, new confusion/lethargy/
   * disorientation, or severe pain or distress. "Would I give this patient my
   * last open bed?" is the published heuristic.
   */
  readonly highRisk: boolean;
  /**
   * Decision point C. How many *different* resources will this patient need —
   * labs, imaging, IV fluids, specialty consult, procedures. Not counting
   * history, examination, point-of-care tests, oral medication or a dressing.
   */
  readonly resourceCount: number;
  readonly ageYears: number;
  readonly vitals?: EsiVitals | undefined;
  /** Severe pain alone does not force level 2, but it is part of decision B. */
  readonly painScore?: number | undefined;
}

export interface EsiResult {
  readonly level: 1 | 2 | 3 | 4 | 5;
  /** `A` | `B` | `C` | `D` — which decision point produced this level. */
  readonly decisionPoint: 'A' | 'B' | 'C' | 'D';
  readonly rationale: string;
  /** Minutes within which the patient should be seen. Level 1 is immediate. */
  readonly targetMinutes: number;
  /** Set when decision D upgraded a level-3 to a level-2. */
  readonly dangerZoneVitals: readonly string[];
}

export const ESI_TARGET_MINUTES: Readonly<Record<1 | 2 | 3 | 4 | 5, number>> = {
  1: 0,
  2: 10,
  3: 30,
  4: 60,
  5: 120,
};

interface VitalBand {
  readonly maxAgeYears: number;
  readonly hr: readonly [number, number];
  readonly rr: readonly [number, number];
}

/**
 * ESI v4 danger-zone thresholds by age. A value outside the band is in the
 * danger zone.
 */
const ADULT_BAND: VitalBand = { maxAgeYears: Number.POSITIVE_INFINITY, hr: [40, 100], rr: [8, 20] };

const VITAL_BANDS: readonly VitalBand[] = [
  { maxAgeYears: 0.25, hr: [100, 180], rr: [30, 60] },
  { maxAgeYears: 1, hr: [100, 160], rr: [25, 50] },
  { maxAgeYears: 3, hr: [90, 140], rr: [20, 40] },
  { maxAgeYears: 5, hr: [80, 120], rr: [20, 30] },
  { maxAgeYears: 12, hr: [70, 120], rr: [15, 30] },
  ADULT_BAND,
];

function bandFor(ageYears: number): VitalBand {
  // The adult band is unbounded, so the `find` always hits it in the worst case.
  // Naming it separately means the fallback is a real band rather than an
  // index-and-assert that a future edit to the table could invalidate.
  return VITAL_BANDS.find((band) => ageYears < band.maxAgeYears) ?? ADULT_BAND;
}

function dangerZone(ageYears: number, vitals: EsiVitals): string[] {
  const band = bandFor(ageYears);
  const found: string[] = [];

  if (vitals.heartRate !== undefined) {
    if (vitals.heartRate > band.hr[1]) found.push(`heart rate ${String(vitals.heartRate)} above the band`);
    if (vitals.heartRate < band.hr[0]) found.push(`heart rate ${String(vitals.heartRate)} below the band`);
  }
  if (vitals.respiratoryRate !== undefined) {
    if (vitals.respiratoryRate > band.rr[1]) {
      found.push(`respiratory rate ${String(vitals.respiratoryRate)} above the band`);
    }
    if (vitals.respiratoryRate < band.rr[0]) {
      found.push(`respiratory rate ${String(vitals.respiratoryRate)} below the band`);
    }
  }
  // 92 rather than 90: below 90 is decision point A, an immediate intervention.
  // The 90–92 window is the one that should stop a patient waiting thirty
  // minutes without being a resus call.
  if (vitals.spo2 !== undefined && vitals.spo2 < 92) {
    found.push(`oxygen saturation ${String(vitals.spo2)}%`);
  }

  return found;
}

export function scoreEsi(input: EsiInput): EsiResult {
  // A — is the patient dying?
  if (input.needsLifeSavingIntervention) {
    return {
      level: 1,
      decisionPoint: 'A',
      rationale: 'Needs an immediate life-saving intervention.',
      targetMinutes: ESI_TARGET_MINUTES[1],
      dangerZoneVitals: [],
    };
  }

  // B — should they not wait?
  if (input.highRisk) {
    return {
      level: 2,
      decisionPoint: 'B',
      rationale: 'High-risk situation, new confusion or lethargy, or severe pain or distress.',
      targetMinutes: ESI_TARGET_MINUTES[2],
      dangerZoneVitals: [],
    };
  }

  // C — how many resources?
  if (input.resourceCount === 0) {
    return {
      level: 5,
      decisionPoint: 'C',
      rationale: 'No resources anticipated.',
      targetMinutes: ESI_TARGET_MINUTES[5],
      dangerZoneVitals: [],
    };
  }
  if (input.resourceCount === 1) {
    return {
      level: 4,
      decisionPoint: 'C',
      rationale: 'One resource anticipated.',
      targetMinutes: ESI_TARGET_MINUTES[4],
      dangerZoneVitals: [],
    };
  }

  // D — the vital signs check, which only ever upgrades a would-be level 3.
  const danger = input.vitals === undefined ? [] : dangerZone(input.ageYears, input.vitals);
  if (danger.length > 0) {
    return {
      level: 2,
      decisionPoint: 'D',
      rationale: `Two or more resources, and vital signs in the danger zone: ${danger.join('; ')}.`,
      targetMinutes: ESI_TARGET_MINUTES[2],
      dangerZoneVitals: danger,
    };
  }

  return {
    level: 3,
    decisionPoint: 'C',
    rationale: 'Two or more resources, vital signs within the band for age.',
    targetMinutes: ESI_TARGET_MINUTES[3],
    dangerZoneVitals: [],
  };
}
