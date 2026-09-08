/**
 * What OP-018, OP-021 and IP-020 return. Mirrors
 * `services/api/src/modules/specialty/handoffs/handoffs.types.ts`.
 */

export interface TeleConsultRow {
  readonly id: string;
  readonly patientId: string;
  readonly practitionerId: string;
  readonly practitionerRegNo: string;
  readonly mode: string;
  readonly firstConsult: boolean;
  readonly followsConsultId: string | null;
  readonly initiatedBy: string;
  readonly identityVerified: boolean;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly complaint: string | null;
  readonly advice: string | null;
  readonly referredInPerson: boolean;
  readonly prescriptionLines: number;
  readonly reachableLists: readonly string[];
  readonly blockedBy: readonly string[];
}

export interface TeleDrugRuleRow {
  readonly drugKey: string;
  readonly drugName: string;
  readonly listCode: string;
  readonly note: string | null;
  readonly reachable: boolean;
  readonly reason: string | null;
}

export interface ReferralRow {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly fromUserId: string;
  readonly toDepartmentKey: string | null;
  readonly toPractitionerKey: string | null;
  readonly externalFacility: string | null;
  readonly urgency: string;
  readonly reason: string;
  readonly status: string;
  readonly createdAt: string;
  readonly replyDueAt: string;
  readonly acknowledgedAt: string | null;
  readonly repliedAt: string | null;
  readonly replyText: string | null;
  readonly overdue: boolean;
  readonly hoursRemaining: number;
}

export interface PathwayInstanceRow {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string | null;
  readonly pathwayKey: string;
  readonly pathwayName: string;
  readonly version: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly adherencePct: string | null;
  readonly varianceCount: number;
  readonly stepsRecorded: number;
  readonly stepsDefined: number;
  readonly outstanding: readonly string[];
}

export interface VarianceTallyRow {
  readonly varianceCategory: string;
  readonly count: number;
  readonly hospitalOwned: boolean;
}
