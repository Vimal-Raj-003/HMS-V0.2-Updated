/** What the programme consoles return. Every derived fact, read-only. */

export interface VialRow {
  readonly id: string;
  readonly vaccineId: string;
  readonly batchNo: string;
  readonly expiryDate: string;
  readonly openedAt: string;
  readonly openedBy: string;
  readonly dosesTotal: number;
  readonly dosesUsed: number;
  readonly discardDueAt: string;
  readonly discardedAt: string | null;
  readonly discardReason: string | null;
  readonly wastageDoses: number | null;
  readonly usable: boolean;
  readonly dosesLeft: number;
  readonly minutesLeft: number | null;
}

export interface VaccinationRow {
  readonly id: string;
  readonly patientId: string;
  readonly antigenCode: string;
  readonly doseNo: number;
  readonly batchNo: string;
  readonly site: string;
  readonly route: string;
  readonly doseMl: number;
  readonly administeredAt: string;
  readonly administeredBy: string;
  readonly observationUntil: string | null;
  readonly source: string;
  readonly voided: boolean;
  readonly voidReason: string | null;
  readonly underObservation: boolean;
}

export interface PlanDoseRow {
  readonly id: string;
  readonly patientId: string;
  readonly antigenCode: string;
  readonly doseNo: number;
  readonly dueDate: string;
  readonly status: string;
  readonly reason: string | null;
  readonly daysOverdue: number | null;
}

export interface BreachRow {
  readonly id: string;
  readonly unitId: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly peakC: number;
  readonly durationMin: number | null;
  readonly batchesAffected: readonly string[];
  readonly action: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly note: string | null;
  readonly holding: boolean;
}

export interface AefiRow {
  readonly id: string;
  readonly patientId: string;
  readonly vaccinationRecordIds: readonly string[];
  readonly onsetAt: string;
  readonly reportedAt: string;
  readonly severity: string;
  readonly category: string | null;
  readonly outcome: string | null;
  readonly firSentAt: string | null;
  readonly pirDueAt: string | null;
  readonly cifDueAt: string | null;
  readonly status: string;
  readonly firOverdue: boolean;
}

export interface HcStationRow {
  readonly id: string;
  readonly station: string;
  readonly seq: number;
  readonly dependsOn: readonly string[];
  readonly status: string;
  readonly calledAt: string | null;
  readonly startedAt: string | null;
  readonly doneAt: string | null;
  readonly skipReason: string | null;
  readonly waitMin: number | null;
  readonly ready: boolean;
  readonly blockedBy: readonly string[];
}

export interface HcEpisodeRow {
  readonly id: string;
  readonly bookingId: string;
  readonly patientId: string;
  readonly routingSlipNo: string;
  readonly checkedInAt: string;
  readonly completedAt: string | null;
  readonly physicianId: string | null;
  readonly stationsTotal: number;
  readonly stationsResolved: number;
  readonly reportBlockedBy: readonly string[];
}

export interface HcReportRow {
  readonly id: string;
  readonly episodeId: string;
  readonly patientId: string;
  readonly version: number;
  readonly domainScores: Record<string, unknown>;
  readonly healthScore: number | null;
  readonly riskCalcs: Record<string, unknown>;
  readonly summary: string | null;
  readonly status: string;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
}

export interface HcEpisodeDetail {
  readonly episode: HcEpisodeRow;
  readonly stations: readonly HcStationRow[];
  readonly reports: readonly HcReportRow[];
}
