/**
 * What the two ends of life return.
 *
 * Every number that matters is derived: the centile and the nutrition band, the
 * dose after the adult ceiling and whether it bit, the day of life and the
 * volume that hangs, the anticholinergic burden and the Beers flags, the
 * frailty and falls bands. Nothing sends any of them.
 */

export interface GrowthRow {
  readonly id: string;
  readonly patientId: string;
  readonly measuredAt: string;
  readonly ageDays: number;
  readonly sex: string;
  /** Grams. There is no kilogram field on a child anywhere in this build. */
  readonly weightG: number | null;
  readonly lengthCm: number | null;
  readonly hcCm: number | null;
  readonly weightForAgeZ: number | null;
  readonly weightCentile: number | null;
  readonly nutritionBand: string | null;
  /** Grams gained a day since the previous measurement, when there is one. */
  readonly gainGPerDay: number | null;
}

export interface PaedDoseRow {
  readonly id: string;
  readonly patientId: string;
  readonly drugName: string;
  readonly weightG: number;
  readonly ageDays: number;
  readonly doseMgPerKg: number;
  readonly frequency: string;
  readonly route: string;
  readonly dosesPerDay: number;
  /** The weight-based figure, before the ceiling. */
  readonly calcSingleMg: number | null;
  /** What is actually given. */
  readonly finalSingleMg: number | null;
  readonly finalDailyMg: number | null;
  readonly adultMaxSingleMg: number | null;
  readonly adultMaxDailyMg: number | null;
  /** True when the adult ceiling bit — the child is being dosed as an adult. */
  readonly capApplied: boolean;
  /** The arithmetic, spelled out, so it can be checked rather than trusted. */
  readonly workingOut: string;
}

export interface NicuAdmissionRow {
  readonly id: string;
  readonly patientId: string;
  readonly birthAt: string;
  readonly gaWeeksAtBirth: number;
  readonly gaDaysAtBirth: number;
  readonly birthWeightG: number;
  readonly gestationBand: string | null;
  readonly birthWeightBand: string | null;
  readonly admittedAt: string;
  readonly dischargedAt: string | null;
  /** Days since birth, and the corrected gestation today. */
  readonly dayOfLife: number;
  readonly correctedGaWeeks: number;
  readonly latestWeightG: number | null;
}

export interface NicuFluidRow {
  readonly id: string;
  readonly nicuAdmissionId: string;
  readonly forDate: string;
  /** Derived from the birth. Day one is the day of birth. */
  readonly dayOfLife: number;
  readonly weightG: number;
  readonly mlPerKgPerDay: number;
  readonly totalMlPerDay: number | null;
  readonly enteralMl: number;
  readonly ivMlPerDay: number | null;
  readonly mlPerHour: number | null;
  readonly fluid: string;
  /** What a standard schedule would give on this day of life, for comparison. */
  readonly expectedMlPerKg: number;
}

export interface GeriAssessmentRow {
  readonly id: string;
  readonly patientId: string;
  readonly assessedAt: string;
  readonly ageYears: number;
  readonly friedItems: Record<string, unknown>;
  /** Derived, 0–5. */
  readonly friedScore: number | null;
  readonly frailtyBand: string | null;
  readonly fallsLastYear: number;
  readonly fallsInjury: boolean;
  readonly fallsRisk: string | null;
  readonly adlBarthel: number | null;
}

export interface MedicationReviewRow {
  readonly id: string;
  readonly patientId: string;
  readonly reviewedAt: string;
  readonly ageYears: number;
  readonly medications: readonly Record<string, unknown>[];
  readonly drugCount: number | null;
  /** Derived by lookup, not by memory. */
  readonly acbScore: number | null;
  readonly acbDrugs: readonly Record<string, unknown>[];
  readonly beersFlags: readonly Record<string, unknown>[];
  readonly beersCount: number | null;
  /** True past three, which is where the burden starts causing the falls. */
  readonly burdenHigh: boolean;
  /** Five is where polypharmacy starts; ten is where it becomes the diagnosis. */
  readonly polypharmacy: boolean;
}
