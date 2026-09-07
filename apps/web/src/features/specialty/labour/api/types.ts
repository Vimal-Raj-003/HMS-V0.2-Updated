/**
 * What the labour room returns.
 *
 * The derived numbers — the alert line, the uterotonic delay, the tranexamic
 * acid window, whether two bands matched — are all here and in no request. So
 * is the forward view: `chartBlocked`, `secondStageMinutesLeft`,
 * `txaMinutesLeft`, `blockedBy`. The room is loud and nobody is reading, which
 * is why a refusal shown ten minutes early is worth more than one shown as an
 * error.
 */

export interface LabourEpisodeRow {
  readonly id: string;
  readonly patientId: string;
  readonly parity: number;
  readonly epidural: boolean;
  readonly riskFlags: readonly string[];
  readonly membraneStatus: string | null;
  readonly liquor: string | null;
  readonly activePhaseFrom: string | null;
  readonly secondStageFrom: string | null;
  readonly outcome: string | null;
  readonly completedAt: string | null;
  readonly expectedCm: number | null;
  readonly latestCm: number | null;
  readonly hoursBehind: number | null;
  readonly chartBlocked: boolean;
  readonly blockedSince: string | null;
  readonly secondStageMinutesLeft: number | null;
  readonly secondStageLimitMin: number | null;
  readonly openAlerts: number;
  readonly babies: number;
}

export interface PartographEntryRow {
  readonly id: string;
  readonly recordedAt: string;
  readonly param: string;
  readonly value: Record<string, unknown>;
  readonly dilatationCm: number | null;
  readonly fhr: number | null;
}

export interface PartographAlertRow {
  readonly id: string;
  readonly raisedAt: string;
  readonly kind: string;
  readonly details: Record<string, unknown>;
  readonly blocking: boolean;
  readonly acknowledgedAt: string | null;
  readonly decision: string | null;
  readonly decisionNote: string | null;
}

export interface DeliveryRow {
  readonly id: string;
  readonly babySeq: number;
  readonly mode: string;
  readonly deliveredAt: string;
  readonly uterotonicDrug: string | null;
  readonly uterotonicDelaySec: number | null;
  readonly uterotonicWithin1Min: boolean | null;
  readonly eblMl: number | null;
  readonly eblMethod: string | null;
  readonly pphThresholdMl: number;
}

export interface NewbornRow {
  readonly id: string;
  readonly patientId: string;
  readonly birthAt: string;
  readonly sex: string;
  readonly status: string;
  readonly birthWeightG: number | null;
  readonly apgar1: number | null;
  readonly apgar5: number | null;
  readonly apgar10: number | null;
  readonly wristbandPairCode: string;
  readonly nicuAdmitted: boolean;
  readonly lastCheckMatched: boolean | null;
  readonly lastCheckAt: string | null;
  readonly blockedBy: readonly string[];
  readonly reportDueBy: string | null;
  readonly reportDaysLeft: number | null;
  readonly reportSubmitted: boolean;
}

export interface PphActivationRow {
  readonly id: string;
  readonly deliveryId: string;
  readonly activatedAt: string;
  readonly trigger: string;
  readonly eblAtTrigger: number | null;
  readonly steps: readonly Record<string, unknown>[];
  readonly txaAt: string | null;
  readonly txaWithin3h: boolean | null;
  readonly txaMinutesLeft: number | null;
  readonly deactivatedAt: string | null;
}

export interface LabourEpisodeDetail {
  readonly episode: LabourEpisodeRow;
  readonly entries: readonly PartographEntryRow[];
  readonly alerts: readonly PartographAlertRow[];
  readonly deliveries: readonly DeliveryRow[];
  readonly newborns: readonly NewbornRow[];
}
