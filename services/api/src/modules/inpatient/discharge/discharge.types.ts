/** Row shapes the discharge and mortuary screens read. */

export interface DischargeRow {
  readonly id: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly kind: string;
  readonly destination: string | null;
  readonly initiatedAt: string;
  readonly initiatedBy: string;
  readonly completedAt: string | null;
  readonly followUpAt: string | null;
  readonly followUpWith: string | null;
  readonly gatePassNo: string | null;
  /** Medicines with no decision yet. Non-zero means the summary cannot be signed. */
  readonly unresolvedMedicines: number;
  readonly summaryVersion: number | null;
  readonly summarySignedAt: string | null;
}

export interface ReconciliationRow {
  readonly id: string;
  readonly drugName: string;
  readonly homeDose: string | null;
  readonly inpatientDose: string | null;
  readonly dischargeDose: string | null;
  readonly action: string;
  readonly reason: string | null;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
}

export interface SummaryRow {
  readonly id: string;
  readonly dischargeId: string;
  readonly version: number;
  readonly supersedesId: string | null;
  readonly amendReason: string | null;
  readonly admissionDiagnosis: string | null;
  readonly finalDiagnosis: string;
  readonly icd10Codes: readonly string[];
  readonly proceduresPerformed: readonly string[];
  readonly courseInHospital: string;
  readonly significantFindings: string | null;
  readonly conditionOnDischarge: string;
  readonly dischargeMedications: unknown;
  readonly followUpPlan: string;
  readonly redFlagAdvice: string;
  readonly dietAdvice: string | null;
  readonly patientCopyLocale: string | null;
  readonly draftedBy: string;
  readonly draftedAt: string;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly cosignedBy: string | null;
  readonly cosignedAt: string | null;
  readonly contentHash: string | null;
}

export interface DischargeDetail {
  readonly discharge: DischargeRow;
  readonly reconciliation: readonly ReconciliationRow[];
  readonly summaries: readonly SummaryRow[];
}

export interface MortuaryRow {
  readonly id: string;
  readonly recordNo: string;
  readonly patientId: string;
  readonly admissionId: string | null;
  readonly mlcId: string | null;
  readonly bodyTagNo: string;
  readonly declaredAt: string;
  readonly declaredBy: string;
  readonly causeOfDeath: string;
  readonly lastOfficeAt: string | null;
  readonly receivedAt: string | null;
  readonly coldStorageUnit: string | null;
  readonly mccdForm: string | null;
  readonly mccdNo: string | null;
  readonly mccdIssuedAt: string | null;
  readonly postMortemRequired: boolean;
  readonly postMortemAt: string | null;
  readonly postMortemRef: string | null;
  readonly nokName: string | null;
  readonly nokRelationship: string | null;
  readonly nokVerifiedAt: string | null;
  readonly releasedAt: string | null;
  readonly releasedBy: string | null;
  readonly unclaimed: boolean;
}

/**
 * What is standing between this body and the door, in the order the family will
 * be told it.
 *
 * The screen computes nothing: it renders what the server says, and the server
 * derives it from the same four facts the trigger reads. A checklist that
 * disagrees with the trigger is worse than no checklist, because the custodian
 * promises a release the database then refuses in front of the family.
 */
export interface ReleaseChecklist {
  readonly recordId: string;
  readonly bodyTagNo: string;
  readonly certificateIssued: boolean;
  readonly nextOfKinVerified: boolean;
  readonly mlcCleared: boolean;
  readonly postMortemSettled: boolean;
  readonly releasable: boolean;
  readonly blockers: readonly string[];
}
