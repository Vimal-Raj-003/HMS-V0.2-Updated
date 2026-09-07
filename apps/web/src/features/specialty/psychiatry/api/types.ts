/**
 * What the psychiatry console returns.
 *
 * The derived facts only: whether the four limbs add up to capacity and when
 * that finding stops being evidence, when each admission's statutory authority
 * runs out, and a scale's total and band. Nothing sends any of them.
 */

export interface PsyEpisodeRow {
  readonly id: string;
  readonly patientId: string;
  readonly openedAt: string;
  readonly primaryDxIcd10: string | null;
  readonly riskLevel: string;
  readonly status: string;
  readonly capacityKnown: boolean;
  readonly hasCapacity: boolean | null;
  readonly capacityValidUntil: string | null;
  readonly capacityCurrent: boolean;
  readonly admissionType: string | null;
  readonly authorityExpiresAt: string | null;
  readonly hoursLeftOfAuthority: number | null;
  readonly mhrbIntimationDueAt: string | null;
  readonly mhrbIntimated: boolean;
  readonly lastScale: string | null;
  readonly lastScaleTotal: number | null;
  readonly suicidalityFlagged: boolean;
}

export interface RestraintRow {
  readonly id: string;
  readonly admissionId: string;
  readonly kind: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMin: number | null;
  readonly reason: string;
  readonly observations: number;
  readonly nrInformedAt: string | null;
  readonly blockedBy: readonly string[];
}

export interface CapacityRow {
  readonly id: string;
  readonly assessedAt: string;
  readonly understands: boolean;
  readonly retains: boolean;
  readonly weighs: boolean;
  readonly communicates: boolean;
  readonly hasCapacity: boolean;
  readonly decisionScope: string;
  readonly validUntil: string;
  readonly current: boolean;
}

export interface InstrumentRow {
  readonly id: string;
  readonly kind: string;
  readonly content: Record<string, unknown>;
  readonly madeAt: string;
  readonly revokedAt: string | null;
  readonly mhrbRef: string | null;
  readonly inForce: boolean;
}

export interface AdmissionRow {
  readonly id: string;
  readonly admissionType: string;
  readonly admittedAt: string;
  readonly authorityExpiresAt: string | null;
  readonly hoursLeftOfAuthority: number | null;
  readonly mhrbIntimationDueAt: string | null;
  readonly mhrbIntimatedAt: string | null;
  readonly dischargedAt: string | null;
  readonly blockedBy: readonly string[];
  readonly restraintsThisAdmission: number;
}

export interface ScaleRow {
  readonly id: string;
  readonly scale: string;
  readonly total: number | null;
  readonly severityBand: string | null;
  readonly item9Flag: boolean;
  readonly recordedAt: string;
}

export interface EpisodeDetail {
  readonly episode: PsyEpisodeRow;
  readonly capacities: readonly CapacityRow[];
  readonly instruments: readonly InstrumentRow[];
  readonly admissions: readonly AdmissionRow[];
  readonly scales: readonly ScaleRow[];
}
