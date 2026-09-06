/** Read models for Phase 7D. */

export interface OtCaseRow {
  readonly id: string;
  readonly caseNo: string;
  readonly patientId: string;
  readonly admissionId: string | null;
  readonly theatreId: string | null;
  readonly theatreCode: string | null;
  readonly plannedProcedure: string;
  readonly specialty: string;
  readonly side: string | null;
  readonly urgency: string;
  readonly state: string;
  readonly anaesthesiaType: string | null;
  readonly asaGrade: number | null;
  readonly surgeonId: string | null;
  readonly anaesthetistId: string | null;
  readonly scheduledStart: string | null;
  readonly estimatedMinutes: number | null;
  readonly signInAt: string | null;
  readonly timeOutAt: string | null;
  readonly signOutAt: string | null;
  readonly incisionAt: string | null;
  readonly closureAt: string | null;
  readonly countDiscrepancy: boolean;
  readonly bumpedCaseId: string | null;
  readonly bumpReason: string | null;
  /**
   * What the case is waiting on, in one sentence, or null when nothing.
   *
   * Computed in the service so the board, the case screen and the huddle all
   * say the same thing — a theatre where two screens disagree about why a case
   * has not started is a theatre where the list runs late for no visible reason.
   */
  readonly blockedBy: string | null;
  /** Pre-op checks, each a fact with a time rather than a tick. */
  readonly preop: {
    readonly consent: boolean;
    readonly siteMarked: boolean;
    readonly fasting: boolean;
    readonly pacCleared: boolean;
    readonly crossmatch: boolean;
    readonly antibiotic: boolean;
  };
}

export interface OtCaseDetail extends OtCaseRow {
  readonly signInItems: unknown;
  readonly timeOutItems: unknown;
  readonly signOutItems: unknown;
  readonly swabCountIn: number | null;
  readonly swabCountOut: number | null;
  readonly instrumentCountIn: number | null;
  readonly instrumentCountOut: number | null;
  readonly sharpsCountIn: number | null;
  readonly sharpsCountOut: number | null;
  readonly countResolution: string | null;
  readonly performedProcedure: string | null;
  readonly findings: string | null;
  readonly bloodLossMl: number | null;
  readonly specimens: readonly string[];
  readonly fluoroscopyMinutes: number | null;
  readonly fluoroscopyDoseMgy: number | null;
  readonly operativeNote: string | null;
  readonly postOpOrders: string | null;
  readonly sets: readonly { readonly id: string; readonly code: string; readonly name: string }[];
}

export interface CssdLoadRow {
  readonly id: string;
  readonly loadNo: string;
  readonly autoclaveId: string;
  readonly cycleNo: string | null;
  readonly state: string;
  readonly peakTemperatureC: number | null;
  readonly holdMinutes: number | null;
  readonly bowieDick: string | null;
  readonly chemicalIndicator: string | null;
  readonly biologicalIndicator: string;
  readonly startedAt: string;
  readonly releasedAt: string | null;
  readonly recalledAt: string | null;
  readonly recallNote: string | null;
  readonly setsInLoad: number;
  readonly setsIssued: number;
}

/** One row of the sterilisation recall: a set, a case, a patient. */
export interface RecallRow {
  readonly issueId: string;
  readonly setCode: string;
  readonly setName: string;
  readonly issuedAt: string;
  readonly otCaseId: string | null;
  readonly caseNo: string | null;
  readonly procedure: string | null;
  readonly patientId: string | null;
  readonly returnedAt: string | null;
}

export interface RecallResult {
  readonly loadId: string;
  readonly loadNo: string;
  readonly setsRecalled: number;
  readonly casesAffected: number;
  readonly patientsAffected: number;
  readonly rows: readonly RecallRow[];
}
