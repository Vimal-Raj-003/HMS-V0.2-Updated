/** Read models for Phase 7A. */

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
  /** Occupied over usable — blocked and retired beds are not capacity. */
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
  /** Where they are now, from the occupancy table. */
  readonly bedId: string | null;
  readonly bedCode: string | null;
  readonly wardName: string | null;
  readonly classId: string | null;
  readonly classCode: string | null;
  /**
   * Set when the class they are in is dearer than the class their payer covers.
   * A proportionate deduction is applied to the *whole* bill in India, not just
   * to the room line, so this is a warning at admission rather than a surprise
   * at settlement.
   */
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
  /** Negative once overdue, so the screen says "12 min over" without arithmetic. */
  readonly minutesRemaining: number;
  readonly breached: boolean;
}
