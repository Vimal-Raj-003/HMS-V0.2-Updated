/**
 * What the antenatal clinic returns.
 *
 * The derived numbers are here and in no request: the estimated date of
 * delivery and where it came from, the gestational age at every visit, the
 * early warning score and the action it obliges, the MTP category and its
 * serial, and the postnatal depression referral.
 *
 * The forward view is here too — `weeksToTerm`, `overdueItems`, `antiDStatus`,
 * `mtpBlockedBy` — because the whole of this module is a calendar, and a
 * calendar that only tells you what has already gone wrong is a record rather
 * than a clinic.
 */

export interface PregnancyRow {
  readonly id: string;
  readonly patientId: string;
  readonly ancNo: string;
  readonly lmp: string | null;
  readonly lmpCertain: boolean;
  readonly cycleDays: number;
  readonly eddLmp: string | null;
  readonly eddUsg: string | null;
  readonly usgDating: Record<string, unknown> | null;
  /** The date everything else is arithmetic on. Derived. */
  readonly workingEdd: string;
  readonly eddSource: string;
  /** Why the working date is what it is, in a sentence written by the database. */
  readonly eddRationale: string | null;

  readonly gravida: number;
  readonly para: number;
  readonly living: number;
  readonly abortions: number;
  readonly ectopic: number;
  /** G3 P1 L1 A1 — the one word a clinician actually reads. */
  readonly formula: string;

  readonly bookingBmi: number | null;
  readonly bloodGroup: string | null;
  readonly rhNegative: boolean | null;
  readonly riskCategory: string;
  readonly riskFlags: readonly Record<string, unknown>[];
  readonly status: string;
  readonly closedAt: string | null;

  /** Today's gestation, computed the same way every visit's is. */
  readonly gaDays: number;
  readonly gaLabel: string;
  readonly trimester: number;
  readonly weeksToTerm: number;

  /** What is due, what is late, and — separately — whether anti-D is settled. */
  readonly dueItems: number;
  readonly overdueItems: number;
  /**
   * `not_applicable` when she is Rhesus positive; otherwise `due`, `overdue`,
   * `done` or `waived`. The pregnancy cannot be closed while it is `due` or
   * `overdue`, and this is that rule read forwards.
   */
  readonly antiDStatus: string;
  readonly lastVisitAt: string | null;
  readonly nextVisitAt: string | null;
}

export interface AncVisitRow {
  readonly id: string;
  readonly pregnancyId: string;
  readonly visitNo: number;
  readonly visitedAt: string;
  /** Derived from the working date and the visit date. No request field. */
  readonly gaDays: number | null;
  readonly gaLabel: string;
  readonly complaints: Record<string, unknown>;
  readonly dangerSigns: readonly string[];
  readonly bpSys: number | null;
  readonly bpDia: number | null;
  readonly pulse: number | null;
  readonly respRate: number | null;
  readonly temperatureC: number | null;
  readonly consciousness: string | null;
  readonly weightKg: number | null;
  readonly urineAlbumin: string | null;
  readonly urineSugar: string | null;
  readonly sfhCm: number | null;
  readonly lie: string | null;
  readonly presentation: string | null;
  readonly fhr: number | null;
  readonly fetalMovements: string | null;
  /** Derived, and so is the sentence saying what it obliges. */
  readonly meowsScore: number | null;
  readonly meowsAction: string | null;
  /**
   * Symphysio-fundal height against gestation. More than three centimetres
   * either way is growth restriction or excess liquor, and this is the one
   * measurement that finds both in a clinic with no scanner.
   */
  readonly sfhDeviationCm: number | null;
  readonly sfhFlag: string | null;
  readonly plan: string | null;
  readonly nextVisitAt: string | null;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  /** What stands between this visit and a signature. */
  readonly blockedBy: readonly string[];
}

export interface ScheduleItemRow {
  readonly id: string;
  readonly pregnancyId: string;
  readonly kind: string;
  readonly code: string;
  readonly name: string;
  readonly dueGaWeeks: number;
  readonly dueAt: string;
  readonly orderId: string | null;
  readonly status: string;
  readonly waivedReason: string | null;
  readonly daysOverdue: number | null;
}

export interface DeliveryPlanRow {
  readonly id: string;
  readonly pregnancyId: string;
  readonly version: number;
  readonly plannedMode: string;
  readonly indication: string | null;
  readonly plannedDate: string | null;
  readonly place: string | null;
  readonly consents: Record<string, unknown>;
  readonly newbornPlan: Record<string, unknown>;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
}

export interface FormFRow {
  readonly id: string;
  readonly scanOrderId: string;
  readonly patientId: string;
  readonly pregnancyId: string | null;
  readonly machineId: string;
  readonly centreRegNo: string;
  readonly sonologistId: string;
  readonly referringDoctor: string;
  readonly indicationCode: string;
  readonly declaration: Record<string, unknown>;
  readonly resultSummary: string | null;
  readonly signedAt: string | null;
  readonly locked: boolean;
  /** Whether the named sonologist is on the register today. */
  readonly sonologistRegistered: boolean;
}

export interface SonologistRow {
  readonly id: string;
  readonly userId: string;
  readonly registrationNo: string;
  readonly qualification: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly current: boolean;
  readonly daysToExpiry: number | null;
}

export interface MtpCaseRow {
  readonly id: string;
  readonly patientId: string;
  /** Gapless, per centre, assigned by the database. */
  readonly mtpSerial: number;
  readonly gaDaysByUsg: number;
  readonly gaLabel: string;
  /** Derived from the gestation. Not a choice. */
  readonly category: string;
  readonly grounds: string | null;
  readonly minor: boolean;
  readonly opinionIds: readonly string[];
  readonly medicalBoardRef: string | null;
  readonly method: string | null;
  readonly performedAt: string | null;
  readonly antiDGiven: boolean;
  readonly registerLocked: boolean;
  /** What the Act still wants before this case can be performed. */
  readonly blockedBy: readonly string[];
}

export interface PncVisitRow {
  readonly id: string;
  readonly pregnancyId: string;
  readonly dayNo: number;
  readonly visitedAt: string;
  readonly bpSys: number | null;
  readonly bpDia: number | null;
  readonly epdsTotal: number | null;
  readonly epdsItem10: number | null;
  /** Derived from both, because the tenth question is about self-harm. */
  readonly epdsReferral: boolean;
  readonly breastfeeding: string | null;
  readonly referral: string | null;
}

export interface PregnancyDetail {
  readonly pregnancy: PregnancyRow;
  readonly visits: readonly AncVisitRow[];
  readonly schedule: readonly ScheduleItemRow[];
  readonly plans: readonly DeliveryPlanRow[];
  readonly pnc: readonly PncVisitRow[];
}
