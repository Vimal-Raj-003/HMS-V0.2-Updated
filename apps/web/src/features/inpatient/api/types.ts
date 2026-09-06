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
