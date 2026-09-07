/** OP-010 and OP-039 row shapes, mirroring the API's. */

export interface RoomRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
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
  /** What is standing between this order and the knife, in the order a theatre asks. */
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
}

export interface ChecklistRow {
  readonly id: string;
  readonly templateKey: string;
  readonly items: unknown;
  readonly ready: boolean;
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
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly anaesthesia: string;
  readonly findings: string | null;
  readonly outcome: string | null;
  readonly signedAt: string | null;
}

export interface OrderDetail {
  readonly order: OrderRow;
  readonly bookings: readonly BookingRow[];
  readonly checklists: readonly ChecklistRow[];
  readonly timeouts: readonly TimeoutRow[];
  readonly procedures: readonly ProcedureRow[];
}

export interface RecoveryRow {
  readonly id: string;
  readonly aldreteScore: number | null;
  readonly escortName: string | null;
  readonly dischargedAt: string | null;
}

export interface TaskRow {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly type: string;
  readonly roomType: string;
  readonly dayNo: number | null;
  readonly dayTotal: number | null;
  readonly scheduledAt: string | null;
  readonly priority: string;
  readonly status: string;
  readonly holdReason: string | null;
  readonly notes: string | null;
  /** Given but still inside the watching window. */
  readonly underObservation: number;
}

export interface AdministrationRow {
  readonly id: string;
  readonly drugName: string;
  readonly givenDose: number;
  readonly doseUnit: string;
  readonly route: string;
  readonly highAlert: boolean;
  readonly verifierId: string | null;
  readonly barcodeVerified: boolean;
  readonly observationUntil: string | null;
  readonly observationOutcome: string | null;
}

export interface DressingRow {
  readonly id: string;
  readonly site: string;
  readonly suturesRemoved: number | null;
  readonly suturesRetained: number | null;
  readonly infectionSigns: boolean;
  readonly nextDueAt: string | null;
}
