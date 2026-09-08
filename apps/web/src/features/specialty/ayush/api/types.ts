/** Mirrors `services/api/src/modules/specialty/ayush/ayush.types.ts`. */

export interface AyushRegistrationRow {
  readonly id: string;
  readonly practitionerId: string;
  readonly system: string;
  readonly council: string;
  readonly registrationNo: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly live: boolean;
  readonly daysRemaining: number | null;
}

export interface AyushConsultRow {
  readonly id: string;
  readonly patientId: string;
  readonly practitionerId: string;
  readonly system: string;
  readonly diagnoses: readonly Record<string, unknown>[];
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly prescriptionLines: number;
  readonly blockedBy: readonly string[];
}

export interface AyushCourseRow {
  readonly id: string;
  readonly patientId: string;
  readonly system: string;
  readonly name: string;
  readonly consentId: string | null;
  readonly status: string;
  readonly startDate: string;
  readonly sessionsDone: number;
  readonly sessionsPlanned: number;
  readonly readyForPradhana: boolean;
  readonly blockedBy: readonly string[];
}

export interface AyushSessionRow {
  readonly id: string;
  readonly courseId: string;
  readonly dayNo: number;
  readonly procedureCode: string;
  readonly procedureName: string | null;
  readonly phase: string | null;
  readonly therapistGenders: readonly string[];
  readonly genderWaiverConsentId: string | null;
  readonly lakshana: string | null;
  readonly adverseEvent: string | null;
  readonly reviewedAt: string | null;
  readonly status: string;
  readonly performedAt: string | null;
  readonly blocksCourse: boolean;
}

export interface HeavyMetalLimits {
  readonly maxDays: number;
  readonly monitoringAfterDays: number;
}
