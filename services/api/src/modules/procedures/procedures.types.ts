/** Row shapes the procedure board and the nursing rooms read. */

export interface RoomRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly subStoreId: string | null;
  readonly isActive: boolean;
}

export interface OrderRow {
  readonly id: string;
  readonly orderNo: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly procedureCode: string;
  readonly procedureName: string;
  readonly category: string;
  readonly side: string;
  readonly siteText: string | null;
  readonly urgency: string;
  readonly requiresConsent: boolean;
  readonly consentId: string | null;
  readonly sedationRequested: boolean;
  readonly status: string;
  readonly sourceModule: string | null;
  readonly orderedAt: string;
  readonly orderedBy: string;
  /**
   * What is standing between this order and the knife, in the order a theatre
   * asks. Derived from the same facts the trigger reads, so the screen and the
   * refusal cannot disagree.
   */
  readonly blockers: readonly string[];
  readonly readyToStart: boolean;
}

export interface BookingRow {
  readonly id: string;
  readonly orderId: string;
  readonly roomId: string;
  readonly roomName: string | null;
  readonly startAt: string;
  readonly endAt: string;
  readonly status: string;
  readonly doctorId: string | null;
}

export interface ChecklistRow {
  readonly id: string;
  readonly templateKey: string;
  readonly items: unknown;
  readonly ready: boolean;
  readonly readyAt: string | null;
  readonly overrideReason: string | null;
  readonly overrideBy: string | null;
}

export interface TimeoutRow {
  readonly id: string;
  readonly confirmedBy1: string;
  readonly confirmedBy2: string;
  readonly confirmedAt: string;
}

export interface ProcedureRow {
  readonly id: string;
  readonly orderId: string;
  readonly patientId: string;
  readonly performedBy: string;
  readonly assistants: readonly string[];
  readonly anaesthetistId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly anaesthesia: string;
  readonly findings: string | null;
  readonly technique: string | null;
  readonly eblMl: number | null;
  readonly specimens: unknown;
  readonly complications: unknown;
  readonly outcome: string | null;
  readonly signedAt: string | null;
  readonly signedBy: string | null;
}

export interface RecoveryRow {
  readonly id: string;
  readonly procedureId: string;
  readonly aldreteScore: number | null;
  readonly escortName: string | null;
  readonly escortRelationship: string | null;
  readonly dischargedAt: string | null;
  readonly dischargedBy: string | null;
  readonly instructions: string | null;
}

export interface OrderDetail {
  readonly order: OrderRow;
  readonly bookings: readonly BookingRow[];
  readonly checklists: readonly ChecklistRow[];
  readonly timeouts: readonly TimeoutRow[];
  readonly procedures: readonly ProcedureRow[];
}

export interface TaskRow {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly orderId: string | null;
  readonly type: string;
  readonly roomType: string;
  readonly roomId: string | null;
  readonly dayNo: number | null;
  readonly dayTotal: number | null;
  readonly scheduledAt: string | null;
  readonly priority: string;
  readonly status: string;
  readonly holdReason: string | null;
  readonly assignedNurseId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly notes: string | null;
  /** Given but still inside the watching window. The room's own worklist chip. */
  readonly underObservation: number;
}

export interface AdministrationRow {
  readonly id: string;
  readonly taskId: string;
  readonly patientId: string;
  readonly drugName: string;
  readonly orderedDose: number;
  readonly givenDose: number;
  readonly doseUnit: string;
  readonly doseChangeReason: string | null;
  readonly route: string;
  readonly site: string | null;
  readonly batchNo: string | null;
  readonly expiry: string | null;
  readonly barcodeVerified: boolean;
  readonly identityMethod: string;
  readonly highAlert: boolean;
  readonly verifierId: string | null;
  readonly startedAt: string;
  readonly givenBy: string;
  readonly observationUntil: string | null;
  readonly observationOutcome: string | null;
}

export interface DressingRow {
  readonly id: string;
  readonly taskId: string;
  readonly patientId: string;
  readonly site: string;
  readonly assessment: unknown;
  readonly suturesRemoved: number | null;
  readonly suturesRetained: number | null;
  readonly infectionSigns: boolean;
  readonly nextDueAt: string | null;
  readonly recordedAt: string;
}
