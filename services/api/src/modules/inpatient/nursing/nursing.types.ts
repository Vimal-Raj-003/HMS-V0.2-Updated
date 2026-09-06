/** Read models for Phase 7B. */

export interface WardPatientRow {
  readonly admissionId: string;
  readonly patientId: string;
  readonly ipNo: string;
  readonly bedCode: string | null;
  readonly wardId: string | null;
  readonly wardName: string | null;
  readonly attendingDoctorId: string | null;
  readonly expectedDischargeAt: string | null;
  /** The last NEWS2, and how long ago. A stale score is its own signal. */
  readonly news2Score: number | null;
  readonly news2Band: string | null;
  readonly lastVitalsAt: string | null;
  readonly vitalsOverdueMinutes: number | null;
  /** Open escalation, if any. */
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
  /** Negative once overdue, so the round list says "40 min late" without arithmetic. */
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

export interface AssessmentRow {
  readonly id: string;
  readonly admissionId: string;
  readonly scale: string;
  readonly score: number;
  readonly band: string;
  readonly items: unknown;
  readonly interventions: readonly string[];
  readonly assessedAt: string;
  readonly assessedBy: string;
  readonly reassessDueAt: string | null;
  readonly overdue: boolean;
}

export interface FluidBalanceView {
  readonly admissionId: string;
  readonly windowHours: number;
  readonly intakeMl: number;
  readonly outputMl: number;
  /** Intake minus output. Positive is a patient accumulating fluid. */
  readonly balanceMl: number;
  readonly entries: readonly {
    readonly id: string;
    readonly direction: string;
    readonly kind: string;
    readonly volumeMl: number;
    readonly at: string;
    readonly notes: string | null;
  }[];
}

export interface HandoverView {
  readonly id: string;
  readonly wardId: string;
  readonly fromShift: string;
  readonly toShift: string;
  readonly shiftDate: string;
  readonly composed: unknown;
  readonly additions: string | null;
  readonly handedOverBy: string | null;
  readonly handedOverAt: string | null;
  readonly receivedBy: string | null;
  readonly receivedAt: string | null;
}

export interface DeviceRow {
  readonly id: string;
  readonly admissionId: string;
  readonly deviceType: string;
  readonly site: string | null;
  readonly insertedAt: string;
  readonly removedAt: string | null;
  readonly removalReason: string | null;
  /** Whole days in situ. The denominator of every HAI rate. */
  readonly deviceDays: number;
}

export interface HaiRow {
  readonly id: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly kind: string;
  readonly detectedAt: string;
  readonly adjudication: string;
  readonly organism: string | null;
  readonly rationale: string | null;
  readonly trigger: unknown;
}

export interface IsolationRow {
  readonly id: string;
  readonly admissionId: string;
  readonly precaution: string;
  readonly organism: string | null;
  readonly indication: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
}
