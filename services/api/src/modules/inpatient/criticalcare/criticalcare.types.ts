/** Read models for Phase 7E and 7F. */

export interface FlowsheetRow {
  readonly id: string;
  readonly admissionId: string;
  readonly atHour: string;
  readonly heartRate: number | null;
  readonly systolicBp: number | null;
  readonly meanArterialBp: number | null;
  readonly spo2: number | null;
  readonly fio2: number | null;
  readonly ventMode: string | null;
  readonly gcs: number | null;
  readonly rass: number | null;
  readonly urineOutputMl: number | null;
  readonly infusions: unknown;
  readonly sources: unknown;
  readonly recordedBy: string;
}

export interface CodeRow {
  readonly id: string;
  readonly codeNo: string;
  readonly location: string;
  readonly patientId: string | null;
  readonly state: string;
  readonly calledAt: string;
  readonly calledBy: string;
  readonly teamArrivedAt: string | null;
  readonly cprStartedAt: string | null;
  readonly firstShockAt: string | null;
  readonly firstDrugAt: string | null;
  readonly roscAt: string | null;
  readonly outcome: string | null;
  readonly cartRestockedAt: string | null;
  /** The two numbers a code is judged on, derived rather than entered. */
  readonly secondsToFirstShock: number | null;
  readonly secondsToFirstDrug: number | null;
  readonly secondsToCpr: number | null;
  readonly elapsedSeconds: number;
}

export interface CodeEventRow {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly rhythm: string | null;
  readonly joules: number | null;
  readonly drug: string | null;
  readonly dose: string | null;
  readonly route: string | null;
  readonly note: string | null;
  readonly recordedBy: string;
  /** Seconds from the call, so the flowsheet reads as a clock. */
  readonly secondsFromCall: number;
}

export interface CodeDetail extends CodeRow {
  readonly debriefNote: string | null;
  readonly ceaseReason: string | null;
  readonly events: readonly CodeEventRow[];
}

export interface BloodUnitRow {
  readonly id: string;
  readonly unitNo: string;
  readonly component: string;
  readonly bloodGroup: string;
  readonly volumeMl: number;
  readonly collectedOn: string;
  readonly expiresOn: string;
  readonly state: string;
  readonly storageLocation: string | null;
  readonly temperatureExcursion: boolean;
  /** Negative once expired, so the fridge list sorts on one number. */
  readonly daysToExpiry: number;
  /** Which screens are still outstanding. Empty means the unit can be released. */
  readonly ttiPending: readonly string[];
}

export interface BloodRequestRow {
  readonly id: string;
  readonly requestNo: string;
  readonly patientId: string;
  readonly component: string;
  readonly unitsRequested: number;
  readonly urgency: string;
  readonly indication: string;
  readonly state: string;
  readonly groupSample1: string | null;
  readonly groupSample2: string | null;
  /**
   * True when two samples exist, agree, and were drawn by different people.
   * The bank reads this before issuing anything.
   */
  readonly groupCheckSatisfied: boolean;
  readonly requestedAt: string;
  readonly unitsIssued: number;
}

export interface BloodIssueRow {
  readonly id: string;
  readonly requestId: string;
  readonly unitId: string;
  readonly unitNo: string;
  readonly component: string;
  readonly bloodGroup: string;
  readonly patientId: string;
  readonly issuedAt: string;
  readonly issuedBy: string;
  readonly issueCheckedBy: string;
  readonly bedsideCheckedBy1: string | null;
  readonly bedsideCheckedBy2: string | null;
  readonly bedsideCheckedAt: string | null;
  readonly transfusionStartedAt: string | null;
  readonly transfusionEndedAt: string | null;
  /** What is still needed before the first drop, or null when nothing is. */
  readonly blockedBy: string | null;
}
