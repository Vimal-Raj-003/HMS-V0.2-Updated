/**
 * What the programme consoles return.
 *
 * The derived facts — a vial's discard time and the doses drawn from it, the
 * dates an adverse-event report is due, a health score — all arrive read-only.
 */

export interface VialRow {
  readonly id: string;
  readonly vaccineId: string;
  readonly batchNo: string;
  readonly expiryDate: string;
  readonly openedAt: string;
  readonly openedBy: string;
  readonly dosesTotal: number;
  /** Counted from the administrations. Not writable. */
  readonly dosesUsed: number;
  /** Derived at the puncture from the vaccine's own policy. */
  readonly discardDueAt: string;
  readonly discardedAt: string | null;
  readonly discardReason: string | null;
  readonly wastageDoses: number | null;
  /** Open, inside its clock, and with doses left. What a nurse can draw from. */
  readonly usable: boolean;
  readonly dosesLeft: number;
  readonly minutesLeft: number | null;
}

export interface VaccinationRow {
  readonly id: string;
  readonly patientId: string;
  readonly vaccineId: string;
  readonly antigenCode: string;
  readonly doseNo: number;
  readonly batchNo: string;
  readonly expiryDate: string;
  readonly vialId: string | null;
  readonly site: string;
  readonly route: string;
  readonly doseMl: number;
  readonly administeredAt: string;
  readonly administeredBy: string;
  readonly observationUntil: string | null;
  readonly source: string;
  readonly voided: boolean;
  readonly voidReason: string | null;
  /** Still inside the post-vaccination observation window. */
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
  /** Days past due, when it is. The recall list is sorted on this. */
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
  /** True while every dose from these batches is refused. */
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
  /** All three derived from the report date by the programme's own clock. */
  readonly firSentAt: string | null;
  readonly pirDueAt: string | null;
  readonly cifDueAt: string | null;
  readonly status: string;
  /** A serious event whose first information report has not gone. */
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
  /** Whether everything it depends on is resolved. What the board acts on. */
  readonly ready: boolean;
  /** Which dependencies are still outstanding, in the words the refusal uses. */
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
  /** What still blocks a report, in the words the refusal would use. */
  readonly reportBlockedBy: readonly string[];
}

export interface HcEpisodeDetail {
  readonly episode: HcEpisodeRow;
  readonly stations: readonly HcStationRow[];
  readonly reports: readonly HcReportRow[];
}

export interface HcReportRow {
  readonly id: string;
  readonly episodeId: string;
  readonly patientId: string;
  readonly version: number;
  readonly domainScores: Record<string, unknown>;
  /** Weighted from the domain scores by the package's model. Never sent. */
  readonly healthScore: number | null;
  readonly riskCalcs: Record<string, unknown>;
  readonly summary: string | null;
  readonly status: string;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
}
