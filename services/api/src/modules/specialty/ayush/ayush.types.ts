/**
 * What the AYUSH consoles return.
 *
 * The derived facts are the boundaries: which systems this practitioner may
 * actually work in, whether a course has been oleated enough to proceed, and
 * when a heavy-metal course's monitoring falls due. All three are read out of
 * the database rather than judged here, and all three are surfaced early —
 * a therapist who learns at the door that the physician has not reviewed
 * yesterday's reaction has already brought the patient in.
 */

export interface AyushRegistrationRow {
  readonly id: string;
  readonly practitionerId: string;
  readonly system: string;
  readonly council: string;
  readonly registrationNo: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  /** Derived. A lapsed registration is not a registration. */
  readonly live: boolean;
  /** Negative once it has lapsed; null when it does not expire. */
  readonly daysRemaining: number | null;
}

export interface AyushConsultRow {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string | null;
  readonly practitionerId: string;
  readonly system: string;
  readonly assessment: Record<string, unknown>;
  readonly diagnoses: readonly Record<string, unknown>[];
  readonly plan: Record<string, unknown>;
  readonly pathyaApathya: Record<string, unknown>;
  readonly lifestyle: Record<string, unknown>;
  readonly notes: string | null;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly prescriptionLines: number;
  /** What stands between this consultation and a signature. */
  readonly blockedBy: readonly string[];
}

export interface AyushPrescriptionLineRow {
  readonly id: string;
  readonly consultId: string;
  readonly medicineId: string;
  readonly medicineName: string;
  readonly form: string | null;
  readonly dose: string;
  readonly unit: string;
  readonly anupana: string | null;
  readonly kala: string | null;
  readonly potency: string | null;
  readonly scale: string | null;
  readonly repetition: string | null;
  readonly durationDays: number;
  /** Stamped from the master at the moment of prescribing. */
  readonly scheduleE1: boolean;
  readonly heavyMetal: boolean;
  readonly monitoringOrderId: string | null;
  /** Derived. Null unless this is a heavy-metal preparation. */
  readonly monitoringDueAt: string | null;
}

export interface AyushMedicineRow {
  readonly id: string;
  readonly system: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly form: string | null;
  readonly manufacturer: string | null;
  readonly scheduleE1: boolean;
  readonly heavyMetal: boolean;
  readonly contraindications: readonly unknown[];
  /** True when this consultation's system can reach it at all. */
  readonly reachable: boolean;
  readonly reason: string | null;
}

export interface AyushProcedureRow {
  readonly code: string;
  readonly system: string;
  readonly name: string;
  readonly phase: string;
  readonly defaultDurationMin: number;
  readonly roomType: string;
  readonly requiresConsent: boolean;
  readonly genderMatchRequired: boolean;
  readonly invasive: boolean;
  readonly contraindications: readonly unknown[];
}

export interface AyushCourseRow {
  readonly id: string;
  readonly patientId: string;
  readonly consultId: string;
  readonly admissionId: string | null;
  readonly system: string;
  readonly name: string;
  readonly planDays: readonly Record<string, unknown>[];
  readonly consentId: string | null;
  readonly status: string;
  readonly startDate: string;
  readonly endDate: string | null;
  readonly abortReason: string | null;
  readonly sessionsDone: number;
  readonly sessionsPlanned: number;
  /**
   * Whether a pradhana karma may be performed on this course today: a
   * completed purvakarma session showing samyak lakshana, and a consent.
   */
  readonly readyForPradhana: boolean;
  /** What is standing in the way, in the words the refusal would use. */
  readonly blockedBy: readonly string[];
}

export interface AyushSessionRow {
  readonly id: string;
  readonly courseId: string;
  readonly dayNo: number;
  readonly procedureCode: string;
  readonly procedureName: string | null;
  readonly phase: string | null;
  readonly roomId: string | null;
  readonly therapistIds: readonly string[];
  readonly therapistGenders: readonly string[];
  readonly genderWaiverConsentId: string | null;
  readonly prechecks: Record<string, unknown>;
  readonly medicinesUsed: readonly unknown[];
  readonly params: Record<string, unknown>;
  readonly lakshana: string | null;
  readonly adverseEvent: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly reviewNote: string | null;
  readonly tolerance: string | null;
  readonly postAdvice: string | null;
  readonly skipReason: string | null;
  readonly status: string;
  readonly performedAt: string | null;
  /** True when this session is what is currently stopping the course. */
  readonly blocksCourse: boolean;
}
