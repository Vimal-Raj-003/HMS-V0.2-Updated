/**
 * What the dialysis floor returns.
 *
 * Every derived number is here and in no request: the zone, the goal, the rate,
 * URR, Kt/V, the use number. And the forward view alongside them — `blockedBy`,
 * `minutesNeededForGoal`, `usesRemaining` — computed by the server from the
 * same figures the database refuses against, so a chip and an exception can
 * never disagree.
 */

export interface DialysisProgramRow {
  readonly id: string;
  readonly patientId: string;
  readonly modality: string;
  readonly dryWeightKg: number;
  readonly dryWeightUpdatedAt: string;
  readonly isolationZone: string;
  readonly status: string;
  readonly dryWeightAgeDays: number;
  readonly dryWeightStale: boolean;
  readonly serologyAgeDays: number | null;
  readonly serologyDue: boolean;
  readonly prescriptionId: string | null;
  readonly durationMin: number | null;
  readonly ufMaxRateMlKgH: number | null;
  readonly dialyserMaxUses: number | null;
  readonly activeAccessId: string | null;
  readonly activeAccessLabel: string | null;
  readonly blockedBy: readonly string[];
}

export interface DialysisMachineRow {
  readonly id: string;
  readonly code: string;
  readonly model: string | null;
  readonly zone: string;
  readonly status: string;
  readonly hoursRun: number;
  readonly nextServiceDueAt: string | null;
  readonly liveSessions: number;
  readonly free: boolean;
  readonly serviceOverdue: boolean;
}

export interface DialysisSessionRow {
  readonly id: string;
  readonly programId: string;
  readonly patientId: string;
  readonly machineId: string | null;
  readonly machineCode: string | null;
  readonly machineZone: string | null;
  readonly patientZone: string;
  readonly accessId: string | null;
  readonly scheduledAt: string;
  readonly scheduledEnd: string;
  readonly shift: string | null;
  readonly status: string;
  readonly preWeightKg: number | null;
  readonly ufGoalL: number | null;
  readonly ufRateMlKgH: number | null;
  readonly connectAt: string | null;
  readonly disconnectAt: string | null;
  readonly postWeightKg: number | null;
  readonly actualUfL: number | null;
  readonly dialyserLabel: string | null;
  readonly dialyserUseNo: number | null;
  readonly urr: number | null;
  readonly ktv: number | null;
  readonly abortReason: string | null;
  readonly suggestedUfGoalL: number | null;
  readonly ufMaxRateMlKgH: number;
  readonly minutesNeededForGoal: number | null;
  readonly blockedBy: readonly string[];
  readonly minutesRun: number | null;
}

export interface DialysisObservationRow {
  readonly id: string;
  readonly recordedAt: string;
  readonly systolic: number | null;
  readonly diastolic: number | null;
  readonly pulse: number | null;
  readonly venousMmhg: number | null;
  readonly tmpMmhg: number | null;
  readonly ufRemovedL: number | null;
  readonly symptoms: readonly Record<string, unknown>[];
  readonly intervention: string | null;
  readonly ufBehindL: number | null;
}

export interface VascularAccessRow {
  readonly id: string;
  readonly programId: string;
  readonly type: string;
  readonly site: string;
  readonly side: string;
  readonly status: string;
  readonly ageDays: number | null;
}

export interface DialyserUseRow {
  readonly id: string;
  readonly programId: string;
  readonly label: string;
  readonly useNo: number;
  readonly reprocessedAt: string | null;
  readonly tcvPct: number | null;
  readonly integrityOk: boolean | null;
  readonly discardedAt: string | null;
  readonly discardReason: string | null;
  readonly usesRemaining: number | null;
  readonly nextUseLicensed: boolean;
  readonly blockedBy: readonly string[];
}

export interface DialysisSessionDetail {
  readonly session: DialysisSessionRow;
  readonly program: DialysisProgramRow;
  readonly accesses: readonly VascularAccessRow[];
  readonly dialysers: readonly DialyserUseRow[];
  readonly observations: readonly DialysisObservationRow[];
}

export interface DialysisBoardRow {
  readonly machine: DialysisMachineRow;
  readonly current: DialysisSessionRow | null;
  readonly next: DialysisSessionRow | null;
}
