/**
 * What the psychiatry console returns.
 *
 * The derived facts are here and in no request: whether the four limbs add up
 * to capacity, when that finding expires, when each admission's statutory
 * authority runs out, when the Review Board has to have been told, a scale's
 * total and band, and whether the ninth question was positive.
 *
 * The forward view — `hoursLeftOfAuthority`, `capacityCurrent`, `blockedBy` —
 * matters more here than clinically, because the thing it prevents is a person
 * being held past a date nobody was watching.
 */

export interface PsyEpisodeRow {
  readonly id: string;
  readonly patientId: string;
  readonly openedAt: string;
  readonly primaryDxIcd10: string | null;
  readonly riskLevel: string;
  readonly leadClinicianId: string;
  readonly status: string;
  readonly sensitivity: string;
  /** The most recent capacity finding, and whether it still stands. */
  readonly capacityKnown: boolean;
  readonly hasCapacity: boolean | null;
  readonly capacityValidUntil: string | null;
  readonly capacityCurrent: boolean;
  /** A live admission under the Act, if there is one. */
  readonly admissionType: string | null;
  readonly authorityExpiresAt: string | null;
  readonly hoursLeftOfAuthority: number | null;
  readonly mhrbIntimationDueAt: string | null;
  readonly mhrbIntimated: boolean;
  /** The last scored instrument, and whether it flagged. */
  readonly lastScale: string | null;
  readonly lastScaleTotal: number | null;
  readonly suicidalityFlagged: boolean;
}

export interface CapacityRow {
  readonly id: string;
  readonly episodeId: string;
  readonly assessedAt: string;
  readonly assessedBy: string;
  readonly understands: boolean;
  readonly retains: boolean;
  readonly weighs: boolean;
  readonly communicates: boolean;
  /** Derived from the four. */
  readonly hasCapacity: boolean;
  readonly decisionScope: string;
  readonly rationale: string;
  /** Derived. The day this stops being evidence. */
  readonly validUntil: string;
  readonly current: boolean;
}

export interface InstrumentRow {
  readonly id: string;
  readonly patientId: string;
  readonly kind: string;
  readonly content: Record<string, unknown>;
  readonly madeAt: string;
  readonly validFrom: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly mhrbRef: string | null;
  readonly inForce: boolean;
}

export interface AdmissionRow {
  readonly id: string;
  readonly episodeId: string;
  readonly patientId: string;
  readonly admissionType: string;
  readonly admittedAt: string;
  readonly capacityAssessmentId: string | null;
  /** Derived from the section. */
  readonly authorityExpiresAt: string | null;
  readonly hoursLeftOfAuthority: number | null;
  readonly mhrbIntimationDueAt: string | null;
  readonly mhrbIntimatedAt: string | null;
  readonly mhrbRef: string | null;
  readonly dischargedAt: string | null;
  /** What has to happen before this authority lapses. */
  readonly blockedBy: readonly string[];
  readonly restraintsThisAdmission: number;
}

export interface RestraintRow {
  readonly id: string;
  readonly admissionId: string;
  readonly kind: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Derived. The figure the monthly Board return is made of. */
  readonly durationMin: number | null;
  readonly reason: string;
  readonly orderedBy: string | null;
  readonly orderedAt: string | null;
  readonly observations: number;
  readonly nrInformedAt: string | null;
  readonly reportedAt: string | null;
  /** What stands between this restraint and being closed. */
  readonly blockedBy: readonly string[];
}

export interface EctCourseRow {
  readonly id: string;
  readonly episodeId: string;
  readonly patientId: string;
  readonly indication: string;
  readonly minor: boolean;
  readonly mhrbPermissionRef: string | null;
  readonly maxSessions: number;
  readonly sessionsGiven: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** What would refuse the next session, before it does. */
  readonly blockedBy: readonly string[];
}

export interface EctSessionRow {
  readonly id: string;
  readonly courseId: string;
  readonly seq: number;
  readonly givenAt: string;
  readonly placement: string;
  readonly seizureSec: number | null;
  readonly anaesthesia: Record<string, unknown>;
}

export interface ScaleRow {
  readonly id: string;
  readonly patientId: string;
  readonly scale: string;
  readonly items: Record<string, unknown>;
  /** Derived from the answers, both of them. */
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
