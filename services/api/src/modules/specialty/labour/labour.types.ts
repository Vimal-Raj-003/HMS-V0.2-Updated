/**
 * What the labour room returns.
 *
 * Every derived number is here and in no request: the alert and action lines,
 * the uterotonic delay, whether tranexamic acid fell inside three hours, and
 * whether a wristband pair matched.
 *
 * The forward view matters more here than anywhere else in the build, because
 * the room is loud and nobody is reading. `chartBlocked`, `expectedCm`,
 * `hoursBehind`, `secondStageMinutesLeft` are the same arithmetic the triggers
 * do, shown before the refusal rather than after it.
 */

export interface LabourEpisodeRow {
  readonly id: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly pregnancyId: string | null;
  readonly eddAtAdmission: string | null;
  readonly gpal: Record<string, unknown>;
  readonly riskFlags: readonly string[];
  readonly bloodGroup: string | null;
  readonly rhNegative: boolean | null;
  readonly onsetAt: string | null;
  readonly membraneStatus: string | null;
  readonly membraneRuptureAt: string | null;
  readonly liquor: string | null;
  readonly presentation: string | null;
  readonly parity: number;
  readonly partographStandard: string;
  readonly activePhaseFrom: string | null;
  readonly secondStageFrom: string | null;
  readonly epidural: boolean;
  readonly companionPresent: boolean;
  readonly outcome: string | null;
  readonly completedAt: string | null;

  /** Where the alert line says she should be right now. */
  readonly expectedCm: number | null;
  readonly latestCm: number | null;
  readonly hoursBehind: number | null;
  /**
   * True when an action-line alert stands with no decision. The chart will not
   * advance, and this is that refusal shown before it happens.
   */
  readonly chartBlocked: boolean;
  readonly blockedSince: string | null;
  /** Minutes left on the second-stage clock, and what the limit is. */
  readonly secondStageMinutesLeft: number | null;
  readonly secondStageLimitMin: number | null;
  readonly openAlerts: number;
  readonly babies: number;
}

export interface PartographEntryRow {
  readonly id: string;
  readonly episodeId: string;
  readonly recordedAt: string;
  readonly param: string;
  readonly value: Record<string, unknown>;
  readonly dilatationCm: number | null;
  readonly fhr: number | null;
  readonly source: string;
  readonly recordedBy: string;
}

export interface PartographAlertRow {
  readonly id: string;
  readonly episodeId: string;
  readonly raisedAt: string;
  readonly kind: string;
  readonly details: Record<string, unknown>;
  readonly blocking: boolean;
  readonly acknowledgedBy: string | null;
  readonly acknowledgedAt: string | null;
  readonly decision: string | null;
  readonly decisionNote: string | null;
}

export interface DeliveryRow {
  readonly id: string;
  readonly episodeId: string;
  readonly babySeq: number;
  readonly mode: string;
  readonly deliveredAt: string;
  readonly place: string | null;
  readonly indication: string | null;
  readonly episiotomy: boolean;
  readonly tearDegree: string | null;
  readonly uterotonicDrug: string | null;
  readonly uterotonicAt: string | null;
  /** Derived. The one-minute window, measured rather than assumed. */
  readonly uterotonicDelaySec: number | null;
  readonly uterotonicWithin1Min: boolean | null;
  readonly eblMl: number | null;
  readonly eblMethod: string | null;
  /** The figure this birth's loss is measured against: 500 or 1000. */
  readonly pphThresholdMl: number;
  readonly complications: readonly Record<string, unknown>[];
  readonly signedAt: string | null;
}

export interface PphActivationRow {
  readonly id: string;
  readonly deliveryId: string;
  readonly activatedAt: string;
  readonly trigger: string;
  readonly eblAtTrigger: number | null;
  readonly steps: readonly Record<string, unknown>[];
  readonly txaAt: string | null;
  /** Derived from the *birth*, not from the activation. */
  readonly txaWithin3h: boolean | null;
  /** How long is left of the three hours in which it still helps. */
  readonly txaMinutesLeft: number | null;
  readonly outcome: string | null;
  readonly deactivatedAt: string | null;
}

export interface NewbornRow {
  readonly id: string;
  readonly patientId: string;
  readonly motherPatientId: string;
  readonly deliveryId: string;
  readonly birthAt: string;
  readonly sex: string;
  readonly status: string;
  readonly birthWeightG: number | null;
  readonly gaWeeks: number | null;
  readonly apgar1: number | null;
  readonly apgar5: number | null;
  readonly apgar10: number | null;
  readonly resuscitation: Record<string, unknown>;
  readonly vitaminKAt: string | null;
  readonly firstFeedAt: string | null;
  readonly wristbandPairCode: string;
  readonly nicuAdmitted: boolean;
  readonly tempName: boolean;

  /** Whether the last identity check matched, which is what lets them move. */
  readonly lastCheckMatched: boolean | null;
  readonly lastCheckAt: string | null;
  /** What stands between this baby and a handover, in the refusal's own words. */
  readonly blockedBy: readonly string[];
  /** The birth report's statutory window. */
  readonly reportDueBy: string | null;
  readonly reportDaysLeft: number | null;
  readonly reportSubmitted: boolean;
}

export interface IdentityCheckRow {
  readonly id: string;
  readonly newbornId: string;
  readonly checkedAt: string;
  readonly motherBandScan: string;
  readonly babyBandScan: string;
  /** Derived. What was scanned, judged against the pair code. */
  readonly matched: boolean;
  readonly context: string;
  readonly checkedBy: string;
}

export interface BirthReportRow {
  readonly id: string;
  readonly newbornId: string;
  readonly form1: Record<string, unknown>;
  readonly dueBy: string;
  readonly daysLeft: number;
  readonly verifiedAt: string | null;
  readonly submittedAt: string | null;
  readonly crsRegNo: string | null;
}

export interface LabourEpisodeDetail {
  readonly episode: LabourEpisodeRow;
  readonly entries: readonly PartographEntryRow[];
  readonly alerts: readonly PartographAlertRow[];
  readonly deliveries: readonly DeliveryRow[];
  readonly newborns: readonly NewbornRow[];
}
