/**
 * What the three hand-off modules return.
 *
 * Every derived field here answers the same question in a different register:
 * *is anybody still waiting for this?* A tele-consultation says which lists it
 * can reach before a doctor tries; a referral says how long is left and whether
 * that time has already gone; a pathway says what fraction of its steps
 * happened and how many did not.
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
  /**
   * Which of the four lists this consultation can reach, said before the
   * doctor tries rather than after. The prohibited list is absent from this
   * shape because it is absent from every consultation: there is no mode and
   * no permission that reaches it.
   */
  readonly reachableLists: readonly string[];
  /** Why a list is out of reach, in the words the refusal would have used. */
  readonly blockedBy: readonly string[];
}

export interface TelePrescriptionLineRow {
  readonly id: string;
  readonly consultId: string;
  readonly drugKey: string;
  readonly drugName: string;
  readonly dose: string;
  readonly frequency: string;
  readonly durationDays: number;
  /** Recorded at the moment of prescribing, so a later list change does not rewrite it. */
  readonly listCode: string | null;
}

export interface TeleDrugRuleRow {
  readonly drugKey: string;
  readonly drugName: string;
  readonly listCode: string;
  readonly note: string | null;
  /** True when *this* consultation could prescribe it. */
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
  /** Derived by the database from the urgency. Nothing sets it. */
  readonly replyDueAt: string;
  readonly acknowledgedAt: string | null;
  readonly repliedAt: string | null;
  readonly replyText: string | null;
  readonly overdue: boolean;
  /** Negative once the clock has run out; that is the number worth showing. */
  readonly hoursRemaining: number;
}

export interface PathwayStepRecordRow {
  readonly id: string;
  readonly instanceId: string;
  readonly stepKey: string;
  readonly dayNo: number;
  readonly outcome: string;
  readonly doneAt: string | null;
  readonly varianceReason: string | null;
  readonly varianceCategory: string | null;
  readonly recordedBy: string;
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
  /** The database's arithmetic over the step records. Nobody types it. */
  readonly adherencePct: string | null;
  readonly varianceCount: number;
  readonly stepsRecorded: number;
  readonly stepsDefined: number;
  /** The steps the pathway defines that have no record yet, in day order. */
  readonly outstanding: readonly string[];
}

export interface VarianceTallyRow {
  readonly varianceCategory: string;
  readonly count: number;
  /** Three of the four are the hospital's problem; one is not. */
  readonly hospitalOwned: boolean;
}
