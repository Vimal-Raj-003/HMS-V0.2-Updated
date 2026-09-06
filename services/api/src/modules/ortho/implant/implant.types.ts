/** Read models for TR-003 and TR-005. */

export interface CatalogueView {
  readonly id: string;
  readonly udiDi: string | null;
  readonly gtin: string | null;
  readonly catalogueNo: string | null;
  readonly manufacturer: string;
  readonly brand: string | null;
  readonly kind: string;
  readonly description: string;
  readonly sizeLabel: string | null;
  readonly laterality: string;
  readonly material: string | null;
  readonly mriConditionality: string;
  readonly mriConditions: unknown;
  readonly shelfLifeMonths: number | null;
  readonly ownership: string;
  readonly consignmentPrice: number | null;
  readonly isActive: boolean;
  /** How many are on the shelf right now — the number the OT list actually needs. */
  readonly available: number;
}

export interface StockView {
  readonly id: string;
  readonly catalogueId: string;
  readonly description: string;
  readonly manufacturer: string;
  readonly udiDi: string | null;
  readonly serialNo: string | null;
  readonly lotNo: string | null;
  readonly udiPi: string | null;
  readonly expiryOn: string | null;
  readonly status: string;
  readonly location: string | null;
  readonly grnRef: string | null;
  readonly receivedAt: string | null;
  /** Negative once it is past. Rendered as an expiry warning rather than a date to subtract. */
  readonly daysToExpiry: number | null;
}

export interface UsageView {
  readonly id: string;
  readonly stockItemId: string;
  readonly patientId: string;
  readonly fractureId: string | null;
  readonly procedureName: string;
  readonly side: string | null;
  readonly surgeonId: string;
  readonly implantedAt: string;
  readonly scanned: boolean;
  readonly manualReason: string | null;
  readonly chargedPrice: number | null;
  readonly explantedAt: string | null;
  readonly explantReason: string | null;
  readonly serialNo: string | null;
  readonly lotNo: string | null;
  readonly udiDi: string | null;
  readonly description: string;
  readonly manufacturer: string;
  readonly kind: string;
  /**
   * Carried on every usage row because it is the answer to the question asked
   * at the scanner door, and the person asking has no reason to open a
   * catalogue screen to find it.
   */
  readonly mriConditionality: string;
  readonly mriConditions: unknown;
  /** Set when an open recall names this device or its lot. */
  readonly recalled: boolean;
}

export interface RecallView {
  readonly id: string;
  readonly reference: string;
  readonly catalogueId: string | null;
  readonly udiDi: string | null;
  readonly lotNos: readonly string[];
  readonly manufacturer: string;
  readonly kind: string;
  readonly severity: string;
  readonly summary: string;
  readonly actionRequired: string;
  readonly issuedOn: string;
  readonly receivedAt: string | null;
  readonly patientsIdentifiedAt: string | null;
  readonly closedAt: string | null;
  readonly patients: number;
  readonly pending: number;
  readonly unreachable: number;
}

export interface RecallCaseView {
  readonly id: string;
  readonly recallId: string;
  readonly usageId: string;
  readonly patientId: string;
  readonly surgeonId: string | null;
  readonly notifiedPatientAt: string | null;
  readonly notifiedSurgeonAt: string | null;
  readonly response: string;
  readonly responseAt: string | null;
  readonly contactAttempts: number;
  readonly notes: string | null;
  readonly serialNo: string | null;
  readonly lotNo: string | null;
  readonly implantedAt: string;
  readonly explantedAt: string | null;
}

export interface RecallDetailView extends RecallView {
  readonly cases: readonly RecallCaseView[];
}

/** One row of the recall query: a person, a device, and who put it in. */
export interface TraceRow {
  readonly usageId: string;
  readonly patientId: string;
  readonly surgeonId: string;
  readonly implantedAt: string;
  readonly explantedAt: string | null;
  readonly side: string | null;
  readonly procedureName: string;
  readonly serialNo: string | null;
  readonly lotNo: string | null;
  readonly udiDi: string | null;
  readonly description: string;
  readonly manufacturer: string;
  readonly scanned: boolean;
}

export interface TraceResult {
  readonly rows: readonly TraceRow[];
  readonly total: number;
  /**
   * How many of these were entered by hand rather than scanned.
   *
   * Reported with every trace because it is the confidence interval on the
   * list: a lot with eleven matches and four manual entries is a lot where four
   * serials were typed and may not be the serials that were used.
   */
  readonly manualEntries: number;
  readonly inSitu: number;
}

export interface CastRequestView {
  readonly id: string;
  readonly patientId: string;
  readonly fractureId: string | null;
  readonly kind: string;
  readonly side: string;
  readonly bodyRegion: string;
  readonly position: string | null;
  readonly material: string | null;
  readonly weightBearing: string | null;
  readonly urgency: string;
  readonly instructions: string | null;
  readonly status: string;
  readonly requestedAt: string;
  readonly requestedBy: string | null;
}

export interface CastCheckView {
  readonly id: string;
  readonly applicationId: string;
  readonly at: string;
  readonly byId: string | null;
  readonly kind: string | null;
  readonly painOutOfProportion: boolean;
  readonly painOnPassiveStretch: boolean;
  readonly paraesthesia: boolean;
  readonly pallor: boolean;
  readonly pulselessness: boolean;
  readonly otherFindings: readonly string[];
  readonly capillaryRefillSec: number | null;
  readonly skinIntact: boolean;
  readonly castIntact: boolean;
  readonly neurovascularIntact: boolean;
  /** Computed by the database from the findings, never taken from the form. */
  readonly redFlag: boolean;
  readonly actionTaken: string | null;
  readonly escalatedTo: string | null;
  readonly notes: string | null;
}

export interface PinSiteView {
  readonly id: string;
  readonly applicationId: string;
  readonly pinLabel: string;
  readonly intervalDays: number;
  readonly lastCareAt: string | null;
  readonly nextDueAt: string;
  readonly infectionGrade: number | null;
  readonly notes: string | null;
  readonly isActive: boolean;
  readonly overdue: boolean;
}

export interface CastApplicationView {
  readonly id: string;
  readonly requestId: string;
  readonly patientId: string;
  readonly kind: string;
  readonly side: string;
  readonly material: string;
  readonly position: string | null;
  readonly padding: string | null;
  readonly appliedIn: string;
  readonly appliedAt: string | null;
  readonly appliedBy: string | null;
  readonly nextCheckDueAt: string | null;
  readonly plannedRemovalAt: string | null;
  readonly removedAt: string | null;
  readonly removedBy: string | null;
  readonly removalNotes: string | null;
  readonly bodyRegion: string;
  readonly fractureId: string | null;
  readonly weightBearing: string | null;
  /** The check is due or past due. What the plaster-room worklist sorts on. */
  readonly checkDue: boolean;
  readonly lastCheckRedFlag: boolean;
}

export interface CastDetailView extends CastApplicationView {
  readonly request: CastRequestView;
  readonly checks: readonly CastCheckView[];
  readonly pinSites: readonly PinSiteView[];
}
