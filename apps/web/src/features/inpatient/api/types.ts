/** Phase 7A read models, mirroring `services/api/src/modules/inpatient/beds`. */

export interface BedBoardRow {
  readonly bedId: string;
  readonly bedCode: string;
  readonly status: string;
  readonly wardId: string;
  readonly wardCode: string;
  readonly wardName: string;
  readonly wardType: string;
  readonly roomCode: string;
  readonly classId: string;
  readonly classCode: string;
  readonly tier: number;
  readonly isolationCapable: boolean;
  readonly hasOxygenPoint: boolean;
  readonly hasMonitor: boolean;
  readonly hasVentilatorPoint: boolean;
  readonly hasAttendantBed: boolean;
  readonly admissionId: string | null;
  readonly patientId: string | null;
  readonly ipNo: string | null;
  readonly occupiedSince: string | null;
  readonly expectedDischargeAt: string | null;
  readonly attendingDoctorId: string | null;
  readonly holdId: string | null;
  readonly holdExpiresAt: string | null;
  readonly holdReason: string | null;
  readonly cleaningTaskId: string | null;
  readonly cleaningState: string | null;
  readonly cleaningDueAt: string | null;
  readonly cleaningBreached: boolean;
}

export interface CensusRow {
  readonly wardId: string;
  readonly wardCode: string;
  readonly wardName: string;
  readonly wardType: string;
  readonly total: number;
  readonly occupied: number;
  readonly available: number;
  readonly cleaning: number;
  readonly blocked: number;
  readonly held: number;
  readonly occupancyPct: string;
  readonly cleaningBreached: number;
  readonly dueForDischargeToday: number;
}

export interface AdmissionView {
  readonly id: string;
  readonly ipNo: string;
  readonly patientId: string;
  readonly erVisitId: string | null;
  readonly kind: string;
  readonly status: string;
  readonly registrationComplete: boolean;
  readonly attendingDoctorId: string | null;
  readonly department: string | null;
  readonly provisionalDiagnosis: string | null;
  readonly payerId: string | null;
  readonly entitledClassId: string | null;
  readonly depositSuggested: number | null;
  readonly depositTaken: number;
  readonly requestedAt: string;
  readonly admittedAt: string | null;
  readonly expectedDischargeAt: string | null;
  readonly dischargedAt: string | null;
  readonly outcome: string | null;
  readonly bedId: string | null;
  readonly bedCode: string | null;
  readonly wardName: string | null;
  readonly classId: string | null;
  readonly classCode: string | null;
  readonly aboveEntitlement: boolean;
  readonly lengthOfStayHours: number | null;
}

export interface TransferView {
  readonly id: string;
  readonly admissionId: string;
  readonly kind: string;
  readonly reason: string;
  readonly fromBedCode: string | null;
  readonly toBedCode: string | null;
  readonly fromClassCode: string | null;
  readonly toClassCode: string | null;
  readonly situation: string | null;
  readonly background: string | null;
  readonly assessment: string | null;
  readonly recommendation: string | null;
  readonly linesAndTubes: readonly string[];
  readonly infusions: readonly string[];
  readonly pendingResults: readonly string[];
  readonly allergies: readonly string[];
  readonly destinationFacility: string | null;
  readonly stabilityNote: string | null;
  readonly handedOverBy: string | null;
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
  readonly at: string;
}

export interface AdmissionDetailView extends AdmissionView {
  readonly notes: string | null;
  readonly transfers: readonly TransferView[];
  readonly occupancies: readonly {
    readonly id: string;
    readonly bedCode: string;
    readonly wardName: string;
    readonly classCode: string;
    readonly fromAt: string;
    readonly toAt: string | null;
    readonly endReason: string | null;
    readonly hours: number;
  }[];
}

export interface CleaningTaskView {
  readonly id: string;
  readonly bedId: string;
  readonly bedCode: string;
  readonly wardId: string;
  readonly wardName: string;
  readonly kind: string;
  readonly state: string;
  readonly slaMinutes: number;
  readonly requestedAt: string;
  readonly dueAt: string;
  readonly acceptedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly inspectedAt: string | null;
  readonly failReason: string | null;
  readonly minutesRemaining: number;
  readonly breached: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7B
// ─────────────────────────────────────────────────────────────────────────────

export interface WardPatientRow {
  readonly admissionId: string;
  readonly patientId: string;
  readonly ipNo: string;
  readonly bedCode: string | null;
  readonly wardId: string | null;
  readonly wardName: string | null;
  readonly attendingDoctorId: string | null;
  readonly expectedDischargeAt: string | null;
  readonly news2Score: number | null;
  readonly news2Band: string | null;
  readonly lastVitalsAt: string | null;
  readonly vitalsOverdueMinutes: number | null;
  readonly escalationId: string | null;
  readonly escalationRung: string | null;
  readonly escalationOverdue: boolean;
  readonly dosesDue: number;
  readonly dosesOverdue: number;
  readonly assessmentsOverdue: number;
  readonly isolation: readonly string[];
  readonly fallsBand: string | null;
  readonly pressureBand: string | null;
  readonly devices: readonly string[];
  readonly nurseId: string | null;
}

export interface MarDoseRow {
  readonly id: string;
  readonly orderId: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly ipNo: string;
  readonly bedCode: string | null;
  readonly drugName: string;
  readonly dose: string;
  readonly doseUnit: string;
  readonly route: string;
  readonly frequency: string;
  readonly isHighAlert: boolean;
  readonly isNarcotic: boolean;
  readonly isPrn: boolean;
  readonly verified: boolean;
  readonly dueAt: string | null;
  readonly state: string;
  readonly administeredAt: string | null;
  readonly administeredBy: string | null;
  readonly witnessedBy: string | null;
  readonly reasonCode: string | null;
  readonly reasonNote: string | null;
  readonly givenDose: string | null;
  readonly minutesUntilDue: number | null;
  readonly overdue: boolean;
}

export interface EscalationRow {
  readonly id: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly ipNo: string;
  readonly bedCode: string | null;
  readonly wardName: string | null;
  readonly score: number;
  readonly band: string;
  readonly rung: string;
  readonly raisedAt: string;
  readonly dueAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedBy: string | null;
  readonly resolvedAt: string | null;
  readonly outcome: string | null;
  readonly ladder: unknown;
  readonly minutesUnanswered: number;
  readonly overdue: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7C
// ─────────────────────────────────────────────────────────────────────────────

export interface RoomChargeRow {
  readonly id: string;
  readonly admissionId: string;
  readonly occupancyId: string | null;
  readonly chargeDate: string;
  readonly chargeCode: string;
  readonly classCode: string | null;
  readonly wardName: string | null;
  readonly units: number;
  readonly unitRate: number;
  readonly amount: number;
  readonly gstRate: number;
  readonly gstAmount: number;
  readonly isExempt: boolean;
  readonly exemptReason: string | null;
  readonly policy: string;
  readonly coversFrom: string;
  readonly coversTo: string;
  readonly supersededAt: string | null;
  readonly postedAt: string;
}

export interface RunningBillView {
  readonly admissionId: string;
  readonly ipNo: string;
  readonly roomCharges: number;
  readonly roomTotal: number;
  readonly gstTotal: number;
  readonly grandTotal: number;
  readonly depositTaken: number;
  readonly outstanding: number;
  readonly charges: readonly RoomChargeRow[];
  readonly superseded: readonly RoomChargeRow[];
}

export interface ChargeRunView {
  readonly id: string;
  readonly forDate: string;
  readonly trigger: string;
  readonly state: string;
  readonly admissionsConsidered: number;
  readonly chargesPosted: number;
  readonly chargesSkipped: number;
  readonly chargesSuperseded: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export interface ClearanceCheck {
  readonly key: string;
  readonly label: string;
  readonly state: 'clear' | 'blocked';
  readonly detail: string | null;
}

export interface ClearanceView {
  readonly id: string;
  readonly admissionId: string;
  readonly state: string;
  readonly checks: readonly ClearanceCheck[];
  readonly blockedReasons: readonly string[];
  readonly clearedAt: string | null;
  readonly overriddenAt: string | null;
  readonly overrideReason: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7D
// ─────────────────────────────────────────────────────────────────────────────

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
  readonly blockedBy: string | null;
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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 7E + 7F
// ─────────────────────────────────────────────────────────────────────────────

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
  readonly daysToExpiry: number;
  readonly ttiPending: readonly string[];
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
  readonly blockedBy: string | null;
}
