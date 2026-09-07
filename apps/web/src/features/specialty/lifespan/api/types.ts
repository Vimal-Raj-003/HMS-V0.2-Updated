/**
 * What the two ends of life return.
 *
 * All of it derived: the centile and the band, the dose after the adult ceiling
 * and whether it bit, the day of life and the volume, the anticholinergic
 * burden and the Beers flags. And every weight in grams, because a newborn's
 * weight in kilograms is a dose out by a factor of a thousand.
 */

export interface GrowthRow {
  readonly id: string;
  readonly patientId: string;
  readonly measuredAt: string;
  readonly ageDays: number;
  readonly sex: string;
  readonly weightG: number | null;
  readonly weightForAgeZ: number | null;
  readonly weightCentile: number | null;
  readonly nutritionBand: string | null;
  readonly gainGPerDay: number | null;
}

export interface NicuAdmissionRow {
  readonly id: string;
  readonly patientId: string;
  readonly birthAt: string;
  readonly gaWeeksAtBirth: number;
  readonly birthWeightG: number;
  readonly gestationBand: string | null;
  readonly birthWeightBand: string | null;
  readonly dischargedAt: string | null;
  readonly dayOfLife: number;
  readonly correctedGaWeeks: number;
  readonly latestWeightG: number | null;
}

export interface NicuFluidRow {
  readonly id: string;
  readonly forDate: string;
  readonly dayOfLife: number;
  readonly weightG: number;
  readonly mlPerKgPerDay: number;
  readonly totalMlPerDay: number | null;
  readonly enteralMl: number;
  readonly ivMlPerDay: number | null;
  readonly mlPerHour: number | null;
  readonly fluid: string;
  readonly expectedMlPerKg: number;
}

export interface MedicationReviewRow {
  readonly id: string;
  readonly patientId: string;
  readonly reviewedAt: string;
  readonly ageYears: number;
  readonly drugCount: number | null;
  readonly acbScore: number | null;
  readonly acbDrugs: readonly Record<string, unknown>[];
  readonly beersFlags: readonly Record<string, unknown>[];
  readonly beersCount: number | null;
  readonly burdenHigh: boolean;
  readonly polypharmacy: boolean;
}
