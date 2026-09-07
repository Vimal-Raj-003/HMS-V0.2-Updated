/**
 * What the dialysis floor returns.
 *
 * Every derived number is here and in no request: the isolation zone, the
 * ultrafiltration goal and rate, URR, Kt/V, and the use number a filter is on.
 * A screen reads them; nothing sends them.
 *
 * The *forward* view is here too — `suggestedUfGoalL`, `minutesNeededForGoal`,
 * `usesRemaining`, `blockedBy` — because a refusal a nurse can see coming is a
 * refusal that never happens. The server computes them from the same figures
 * the triggers refuse against, so the chip and the exception can never
 * disagree.
 */

export interface DialysisProgramRow {
  readonly id: string;
  readonly patientId: string;
  readonly branchId: string;
  readonly modality: string;
  readonly aetiologyIcd10: string | null;
  readonly startDate: string;
  readonly dryWeightKg: number;
  readonly dryWeightUpdatedAt: string;
  readonly viralStatus: Record<string, unknown>;
  /** Derived from the serology by the database. Never chosen. */
  readonly isolationZone: string;
  readonly bloodGroup: string | null;
  readonly nephrologistId: string | null;
  readonly transportNeeded: boolean;
  readonly status: string;

  /** How long since the dry weight was reviewed, and whether that is too long. */
  readonly dryWeightAgeDays: number;
  readonly dryWeightStale: boolean;
  /** How long since the serology was drawn, and whether it is due again. */
  readonly serologyAgeDays: number | null;
  readonly serologyDue: boolean;
  /** The live prescription, if there is one. */
  readonly prescriptionId: string | null;
  readonly durationMin: number | null;
  readonly frequencyPerWeek: number | null;
  readonly ufMaxRateMlKgH: number | null;
  readonly dialyserMaxUses: number | null;
  /** The access that may be cannulated today, if exactly one is active. */
  readonly activeAccessId: string | null;
  readonly activeAccessLabel: string | null;
  /** What would stop this patient being connected right now, in plain words. */
  readonly blockedBy: readonly string[];
}

export interface VascularAccessRow {
  readonly id: string;
  readonly programId: string;
  readonly type: string;
  readonly site: string;
  readonly side: string;
  readonly createdOn: string | null;
  readonly status: string;
  readonly complications: readonly Record<string, unknown>[];
  readonly lastAssessed: string | null;
  /** Days since it was formed. A fistula needs six to eight weeks. */
  readonly ageDays: number | null;
}

export interface DialysisPrescriptionRow {
  readonly id: string;
  readonly programId: string;
  readonly version: number;
  readonly frequencyPerWeek: number;
  readonly durationMin: number;
  readonly dialyserItemId: string | null;
  readonly dialyserMaxUses: number;
  readonly qb: number;
  readonly qd: number;
  readonly dialysate: Record<string, unknown>;
  readonly ufMaxRateMlKgH: number;
  readonly heparin: Record<string, unknown>;
  readonly anticoagMode: string;
  readonly targetKtv: number | null;
  readonly effectiveFrom: string;
  readonly prescribedBy: string;
}

export interface DialysisMachineRow {
  readonly id: string;
  readonly code: string;
  readonly model: string | null;
  readonly serial: string | null;
  readonly zone: string;
  readonly status: string;
  readonly hoursRun: number;
  readonly lastServiceAt: string | null;
  readonly nextServiceDueAt: string | null;
  /** Bookings still live on this machine. What re-zoning or servicing it costs. */
  readonly liveSessions: number;
  /** True when it could take a patient right now. */
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
  readonly chairNo: string | null;
  readonly admissionId: string | null;
  readonly accessId: string | null;
  readonly prescriptionId: string;
  readonly scheduledAt: string;
  readonly scheduledEnd: string;
  readonly shift: string | null;
  readonly status: string;

  readonly preWeightKg: number | null;
  readonly pre: Record<string, unknown>;
  /** Derived when not supplied: the excess over the dry weight. */
  readonly ufGoalL: number | null;
  /** Derived always: millilitres per kilogram per hour. */
  readonly ufRateMlKgH: number | null;
  readonly connectAt: string | null;
  readonly disconnectAt: string | null;
  readonly postWeightKg: number | null;
  readonly post: Record<string, unknown>;
  readonly actualUfL: number | null;
  readonly dialyserLabel: string | null;
  readonly dialyserUseNo: number | null;
  readonly complications: readonly Record<string, unknown>[];
  readonly medsGiven: readonly Record<string, unknown>[];
  readonly urr: number | null;
  readonly ktv: number | null;
  readonly adequacyLabs: Record<string, unknown>;
  readonly abortReason: string | null;
  readonly technicianId: string | null;
  readonly nurseId: string | null;

  /** The excess over dry weight, before anybody decides to take less. */
  readonly suggestedUfGoalL: number | null;
  /** The ceiling this session is checked against. */
  readonly ufMaxRateMlKgH: number;
  /**
   * How long the session would have to run for the current goal to be within
   * the rate limit. Null when it already is — this is the number the refusal
   * would have named, shown before the refusal.
   */
  readonly minutesNeededForGoal: number | null;
  /** What stands between this session and a patient on the machine. */
  readonly blockedBy: readonly string[];
  readonly minutesRun: number | null;
}

export interface DialysisSessionDetail {
  readonly session: DialysisSessionRow;
  readonly program: DialysisProgramRow;
  readonly accesses: readonly VascularAccessRow[];
  readonly dialysers: readonly DialyserUseRow[];
  readonly observations: readonly DialysisObservationRow[];
}

export interface DialysisObservationRow {
  readonly id: string;
  readonly sessionId: string;
  readonly recordedAt: string;
  readonly recordedBy: string;
  readonly systolic: number | null;
  readonly diastolic: number | null;
  readonly pulse: number | null;
  readonly temperatureC: number | null;
  readonly qb: number | null;
  readonly qd: number | null;
  readonly arterialMmhg: number | null;
  readonly venousMmhg: number | null;
  readonly tmpMmhg: number | null;
  readonly ufRemovedL: number | null;
  readonly ufRateLh: number | null;
  readonly conductivity: number | null;
  readonly symptoms: readonly Record<string, unknown>[];
  readonly intervention: string | null;
  /**
   * How far behind the fluid the session needs to be off by now. Negative means
   * the machine is ahead of plan, which on a patient who is cramping is the
   * thing to notice.
   */
  readonly ufBehindL: number | null;
}

export interface DialyserUseRow {
  readonly id: string;
  readonly programId: string;
  readonly label: string;
  readonly itemId: string | null;
  readonly useNo: number;
  readonly sessionId: string | null;
  readonly reprocessedAt: string | null;
  readonly tcvPct: number | null;
  readonly integrityOk: boolean | null;
  readonly chemical: string | null;
  readonly discardedAt: string | null;
  readonly discardReason: string | null;

  /** How many uses are left on this label under the live prescription. */
  readonly usesRemaining: number | null;
  /** True when the next use would be accepted. */
  readonly nextUseLicensed: boolean;
  /** And why not, when it would not. */
  readonly blockedBy: readonly string[];
}

/** The unit's board: what is on each machine and what is waiting. */
export interface DialysisBoardRow {
  readonly machine: DialysisMachineRow;
  readonly current: DialysisSessionRow | null;
  readonly next: DialysisSessionRow | null;
}
