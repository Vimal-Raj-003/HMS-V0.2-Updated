/** TR-001 board shapes, mirroring `services/api/.../trauma/trauma.types.ts`. */

export interface TriageRecordView {
  readonly id: string;
  readonly erVisitId: string;
  readonly system: string;
  readonly sequenceNo: number;
  readonly esiLevel: number | null;
  readonly decisionPoint: string | null;
  readonly resourceCount: number | null;
  /** What the shared function returned, before any override. */
  readonly suggestedLevel: number | null;
  readonly overridden: boolean;
  readonly overrideReason: string | null;
  readonly tag: string | null;

  readonly heartRate: number | null;
  readonly respiratoryRate: number | null;
  readonly systolicBp: number | null;
  readonly diastolicBp: number | null;
  readonly spo2: number | null;
  readonly temperatureC: string | null;
  readonly painScore: number | null;
  readonly glucose: number | null;

  readonly gcsEye: number | null;
  readonly gcsVerbal: number | null;
  readonly gcsMotor: number | null;
  readonly gcsTotal: number | null;
  readonly gcsIntubated: boolean;
  /** `12T` when intubated. A verbal score cannot be observed through a tube. */
  readonly gcsDisplay: string | null;

  readonly chiefComplaint: string | null;
  readonly pathways: readonly string[];
  readonly targetSeenBy: string | null;
  readonly triagedAt: string;
  readonly triagedBy: string | null;
  readonly recordedOffline: boolean;

  /** Why the algorithm produced this level, in one sentence. */
  readonly rationale: string | null;
  /** Set when decision D upgraded a would-be level 3. */
  readonly dangerZoneVitals: readonly string[];
}

export interface ActivationPageView {
  readonly id: string;
  readonly activationId: string;
  readonly role: string;
  readonly userId: string | null;
  readonly channel: string;
  readonly status: string;
  /** Never true on a level-1 page. The database refuses it. */
  readonly suppressed: boolean;
  readonly sentAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly arrivedAt: string | null;
  readonly etaMinutes: number | null;
  readonly failureReason: string | null;
  /** Page to acknowledgement. The number the trauma audit reports. */
  readonly secondsToAcknowledge: number | null;
}

export interface TraumaActivationView {
  readonly id: string;
  readonly erVisitId: string;
  readonly erNo: string | null;
  readonly displayName: string | null;
  readonly triageRecordId: string | null;
  readonly tier: string;
  readonly status: string;
  readonly criteriaFired: readonly string[];
  readonly clinicalJudgement: boolean;
  readonly activatedAt: string;
  readonly activatedBy: string | null;
  readonly stoodDownAt: string | null;
  readonly standDownReason: string | null;
  readonly finalIss: number | null;
  readonly overTriage: boolean | null;
  readonly underTriage: boolean | null;
  readonly minutesActive: number;
  readonly pages: readonly ActivationPageView[];
  /** How many of the paged roles have answered. */
  readonly acknowledgedCount: number;
  readonly pagedCount: number;
}

export interface SurveyInterventionView {
  readonly id: string;
  readonly kind: string;
  readonly detail: string | null;
  readonly atTime: string;
  readonly byId: string | null;
  /** Minutes from the door. The golden hour is read in this column. */
  readonly minutesFromDoor: number;
}

export interface PrimarySurveyView {
  readonly id: string;
  readonly erVisitId: string;
  readonly activationId: string | null;

  readonly injuryAt: string | null;
  readonly doorAt: string;
  readonly ctAt: string | null;
  readonly otAt: string | null;

  readonly airwayPatent: boolean | null;
  readonly airwayAdjunct: string | null;
  readonly collarAt: string | null;
  readonly intubatedAt: string | null;

  readonly breathSoundsEqual: boolean | null;
  readonly needleDecompAt: string | null;
  readonly chestDrainAt: string | null;

  readonly tourniquetOnAt: string | null;
  readonly tourniquetOffAt: string | null;
  readonly tourniquetSite: string | null;
  readonly pelvicBinderAt: string | null;
  readonly ivAccessCount: number;
  readonly ioAccess: boolean;
  readonly crystalloidMl: number;
  readonly bloodUnits: number;
  readonly mtpActivatedAt: string | null;
  readonly fastResult: string | null;

  readonly pupilLeftMm: number | null;
  readonly pupilRightMm: number | null;
  readonly pupilsReactive: boolean | null;

  readonly exposedAt: string | null;
  readonly logRolledAt: string | null;
  readonly temperatureC: string | null;

  readonly tetanusAt: string | null;
  readonly txaAt: string | null;
  readonly antibioticAt: string | null;

  readonly ampleHistory: unknown;
  readonly mechanism: string | null;

  readonly interventions: readonly SurveyInterventionView[];
  readonly clocks: GoldenHourClocks;
}

/**
 * The clocks §6.4 asks for, computed rather than stored.
 *
 * Stored durations go stale the moment somebody corrects a timestamp, and every
 * one of these is a NABH indicator that has to agree with the timeline it was
 * derived from.
 */
export interface GoldenHourClocks {
  /** Injury to door. Null when the crew did not report an injury time. */
  readonly prehospitalMinutes: number | null;
  /** Door to CT. */
  readonly doorToCtMinutes: number | null;
  /** Door to theatre — the number the golden hour is actually about. */
  readonly doorToOtMinutes: number | null;
  /** Minutes since the door, for a resuscitation still running. */
  readonly elapsedMinutes: number;
  /** How long the tourniquet has been on. Alarms at 90 and 120. */
  readonly tourniquetMinutes: number | null;
  /** `none` | `warning` at 90 minutes | `critical` at 120. */
  readonly tourniquetAlarm: 'none' | 'warning' | 'critical';
}

export interface TraumaInjuryView {
  readonly id: string;
  readonly region: string;
  readonly aisSeverity: number;
  readonly aisCode: string | null;
  readonly description: string;
  readonly side: string | null;
}

export interface TraumaScoreView {
  readonly id: string;
  readonly erVisitId: string;
  readonly versionNo: number;
  readonly status: string;

  readonly arrivalGcs: number | null;
  readonly arrivalSbp: number | null;
  readonly arrivalRr: number | null;
  readonly ageYears: number | null;
  readonly mechanism: string | null;

  readonly rts: string | null;
  readonly iss: number | null;
  readonly niss: number | null;
  readonly issBand: string | null;
  readonly shockIndex: string | null;
  readonly mgap: number | null;
  readonly gap: number | null;
  readonly triss: string | null;
  /** `86.8%`. The display form, so two clients cannot round it differently. */
  readonly trissDisplay: string | null;
  readonly trissCoefficientSet: string | null;

  readonly lockedAt: string | null;
  readonly lockedBy: string | null;
  readonly supersedesId: string | null;
  readonly amendReason: string | null;
  readonly computedAt: string;
}

export interface MciIncidentView {
  readonly id: string;
  readonly incidentCode: string;
  readonly name: string;
  readonly source: string;
  readonly declaredAt: string;
  readonly declaredBy: string | null;
  readonly stoodDownAt: string | null;
  readonly minutesActive: number;
  readonly afterActionReport: unknown;
  readonly isActive: boolean;
}

export interface TraumaBoardView {
  readonly activations: readonly TraumaActivationView[];
  /** The running MCI, when there is one. The board changes shape under it. */
  readonly activeMci: MciIncidentView | null;
  readonly generatedAt: string;
}

export interface TriageResultView {
  readonly record: TriageRecordView;
  /** Set when a re-triage moved the patient to a more urgent level. */
  readonly deterioratedFrom: number | null;
  /**
   * Populated when the triage itself meets a published activation criterion.
   * A suggestion, never an automatic activation: the team is called by a person.
   */
  readonly suggestedActivation: {
    readonly tier: string;
    readonly criteria: readonly string[];
  } | null;
}
