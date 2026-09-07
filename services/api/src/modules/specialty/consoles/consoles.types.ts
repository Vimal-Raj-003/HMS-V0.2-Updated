/**
 * What the five consoles return.
 *
 * Every derived number is present and read-only: `qtcMs`, `preRatio`,
 * `reversible`, `severity`, `ptaAvg`, `degree`, `type`, a score's `value` and
 * the dental `state` all come back so a screen can show them, and none of them
 * appears in a request shape. That asymmetry is the design.
 */

export interface CardioConsultRow {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly nyha: number | null;
  readonly ccs: number | null;
  readonly scores: Record<string, unknown>;
  readonly problemCodes: readonly string[];
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly createdAt: string;
}

export interface EcgRow {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string | null;
  readonly source: string;
  readonly acquiredAt: string;
  readonly hr: number | null;
  readonly prMs: number | null;
  readonly qrsMs: number | null;
  readonly qtMs: number | null;
  /** Bazett, computed by a trigger. */
  readonly qtcMs: number | null;
  readonly axisDeg: number | null;
  readonly machineInterp: readonly string[];
  readonly readInterp: readonly string[];
  readonly readBy: string | null;
  readonly readAt: string | null;
  readonly critical: boolean;
  readonly criticalAckBy: string | null;
  readonly criticalAckAt: string | null;
  readonly criticalAckTo: string | null;
  readonly status: string;
  /** True while a critical tracing is waiting for somebody to be told. */
  readonly awaitingAcknowledgement: boolean;
  /** Derived on read: over 500 ms is the line most drug interaction checks use. */
  readonly qtcProlonged: boolean;
}

export interface EchoRow {
  readonly id: string;
  readonly patientId: string;
  readonly type: string;
  readonly efPct: number | null;
  readonly measurements: Record<string, unknown>;
  readonly conclusions: string | null;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly createdAt: string;
}

export interface StressTestRow {
  readonly id: string;
  readonly patientId: string;
  readonly protocol: string;
  readonly targetHr: number | null;
  readonly dukeScore: number | null;
  readonly terminationReason: string | null;
  readonly result: string | null;
  readonly physicianId: string;
  readonly signedAt: string | null;
  readonly createdAt: string;
}

export interface AnticoagRow {
  readonly id: string;
  readonly patientId: string;
  readonly drug: string;
  readonly indication: string;
  readonly targetInrLow: number | null;
  readonly targetInrHigh: number | null;
  readonly startDate: string;
  readonly status: string;
}

export interface InrVisitRow {
  readonly id: string;
  readonly enrolmentId: string;
  readonly measuredAt: string;
  readonly inr: number;
  readonly source: string;
  readonly weeklyDoseMg: number;
  readonly doseGrid: readonly number[];
  readonly nextAt: string | null;
  /** Whether this reading sat inside the enrolment's window. */
  readonly inRange: boolean | null;
  /** Time in therapeutic range across this enrolment's readings, per cent. */
  readonly ttrPct: number | null;
}

export interface PulmoConsultRow {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly goldGroup: string | null;
  readonly ginaStep: number | null;
  readonly scores: Record<string, unknown>;
  readonly dxCodes: readonly string[];
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly createdAt: string;
}

export interface PftRow {
  readonly id: string;
  readonly patientId: string;
  readonly performedAt: string;
  readonly tests: readonly string[];
  readonly qualityGrade: string | null;
  readonly preFvc: number | null;
  readonly preFev1: number | null;
  /** Derived. */
  readonly preRatio: number | null;
  readonly postFvc: number | null;
  readonly postFev1: number | null;
  readonly postRatio: number | null;
  readonly revFev1Pct: number | null;
  readonly revFev1Ml: number | null;
  readonly reversible: boolean | null;
  readonly interpretation: string | null;
  readonly status: string;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  /** True when the effort was unacceptable and no signature is possible. */
  readonly unsignable: boolean;
  /** Obstruction on the fixed-ratio criterion, for the screen's chip. */
  readonly obstructed: boolean | null;
}

export interface SleepStudyRow {
  readonly id: string;
  readonly patientId: string;
  readonly type: string;
  readonly scheduledAt: string;
  readonly ahi: number | null;
  /** Derived from the index. */
  readonly severity: string | null;
  readonly scored: Record<string, unknown>;
  readonly interpretation: string | null;
  readonly status: string;
  readonly signedAt: string | null;
}

export interface PapRxRow {
  readonly id: string;
  readonly patientId: string;
  readonly studyId: string | null;
  readonly mode: string;
  readonly pressureCm: number | null;
  readonly pressureMin: number | null;
  readonly pressureMax: number | null;
  readonly epap: number | null;
  readonly ipap: number | null;
  readonly mask: string | null;
  readonly ownership: string;
  readonly startDate: string;
  readonly status: string;
  /** The insurer's threshold across the latest period, when one is filed. */
  readonly adherent: boolean | null;
}

export interface EntExamRow {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly ear: Record<string, unknown>;
  readonly nose: Record<string, unknown>;
  readonly throat: Record<string, unknown>;
  readonly neck: Record<string, unknown>;
  readonly stopBang: number | null;
  readonly epworth: number | null;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
  readonly createdAt: string;
}

export interface ThresholdRow {
  readonly ear: string;
  readonly conduction: string;
  readonly freqHz: number;
  readonly thresholdDb: number;
  readonly masked: boolean;
  readonly noResponse: boolean;
}

export interface AudiologyResultRow {
  readonly id: string;
  readonly ear: string;
  /** All three derived from the thresholds. */
  readonly ptaAvg: number | null;
  readonly degree: string | null;
  readonly type: string | null;
  readonly srt: number | null;
  readonly sdsPct: number | null;
  readonly tympType: string | null;
  readonly interpretation: string | null;
  /** Air minus bone at the four-frequency average, when both are complete. */
  readonly airBoneGapDb: number | null;
}

export interface AudiologyTestRow {
  readonly id: string;
  readonly patientId: string;
  readonly testType: string;
  readonly performedAt: string;
  readonly boothId: string | null;
  readonly audiologistId: string;
  readonly calibrationOk: boolean;
  readonly status: string;
  readonly signedBy: string | null;
  readonly signedAt: string | null;
}

export interface AudiologyTestDetail {
  readonly test: AudiologyTestRow;
  readonly thresholds: readonly ThresholdRow[];
  readonly results: readonly AudiologyResultRow[];
}

export interface HearingAidRow {
  readonly id: string;
  readonly patientId: string;
  readonly ear: string;
  readonly model: string;
  readonly serial: string;
  readonly status: string;
  readonly dispensedAt: string | null;
  readonly warrantyUntil: string | null;
}

export interface ToothEventRow {
  readonly id: string;
  readonly patientId: string;
  readonly toothFdi: number;
  readonly surfaces: readonly string[];
  readonly conditionCode: string;
  readonly status: string;
  readonly notes: string | null;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface DentalChartRow {
  readonly patientId: string;
  readonly dentition: string;
  /** Materialised from the log by a trigger. Never written by this service. */
  readonly state: Record<string, unknown>;
  readonly dmft: number | null;
  readonly rebuiltAt: string;
}

export interface DentalChartDetail {
  readonly chart: DentalChartRow | null;
  readonly events: readonly ToothEventRow[];
}

export interface DentalPlanItemRow {
  readonly id: string;
  readonly seq: number;
  readonly procedureCode: string;
  readonly description: string;
  readonly teeth: readonly number[];
  readonly quantity: number;
  readonly unitPrice: number;
  readonly discount: number;
  readonly tax: number;
  readonly lineTotal: number;
  readonly sittingsPlanned: number;
  readonly sittingsDone: number;
  readonly status: string;
  readonly altGroup: string | null;
}

export interface DentalPlanRow {
  readonly id: string;
  readonly planNo: string;
  readonly patientId: string;
  readonly status: string;
  readonly total: number;
  readonly acceptedTotal: number;
  readonly acceptedVia: string | null;
  readonly acceptedAt: string | null;
  readonly presentedAt: string | null;
  readonly version: number;
  /** True once prices are immutable. */
  readonly priceLocked: boolean;
  readonly items: readonly DentalPlanItemRow[];
}

export interface DentalSittingRow {
  readonly id: string;
  readonly patientId: string;
  readonly planId: string | null;
  readonly procedureId: string | null;
  readonly performedAt: string;
  readonly performedBy: string;
  readonly nextVisitDays: number | null;
}

export interface LesionRow {
  readonly id: string;
  readonly patientId: string;
  readonly lesionNo: number;
  readonly regionKey: string;
  readonly side: string;
  readonly morphology: string;
  readonly sizeMm: number | null;
  readonly status: string;
  readonly sensitive: boolean;
  readonly observationCount: number;
  readonly lastObservedAt: string | null;
  /** Millimetres of growth since the first recorded size, when there are two. */
  readonly growthMm: number | null;
}

export interface LesionObservationRow {
  readonly id: string;
  readonly lesionId: string;
  readonly findings: Record<string, unknown>;
  readonly itchNrs: number | null;
  readonly photos: readonly string[];
  readonly observedAt: string;
  readonly observedBy: string;
}

export interface DermScoreRow {
  readonly id: string;
  readonly patientId: string;
  readonly scoreType: string;
  readonly components: Record<string, unknown>;
  /** Derived for PASI, EASI, SCORAD and BSA; as recorded for the rest. */
  readonly value: number | null;
  readonly derived: boolean;
  readonly recordedAt: string;
}

export interface BiopsyRow {
  readonly id: string;
  readonly patientId: string;
  readonly lesionId: string;
  readonly specimenNo: string | null;
  readonly type: string;
  readonly status: string;
  readonly resultSummary: string | null;
  readonly malignancyFlag: boolean;
  readonly margins: string | null;
  readonly followupTaskId: string | null;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
  /** A malignant report that has not been closed against a follow-up yet. */
  readonly awaitingFollowup: boolean;
}

export interface PhototherapyCourseRow {
  readonly id: string;
  readonly patientId: string;
  readonly modality: string;
  readonly skinType: number;
  readonly startDoseMj: number;
  readonly incrementPct: number;
  readonly maxDoseMj: number;
  readonly freqPerWeek: number;
  readonly cumulativeDoseMj: number;
  readonly sessionsCount: number;
  readonly status: string;
  /** What the protocol would give next, already clipped to the ceiling. */
  readonly suggestedNextDoseMj: number | null;
  /** Why the suggestion is not simply the last dose plus the increment. */
  readonly suggestionReason: string;
}

export interface PhototherapySessionRow {
  readonly id: string;
  readonly courseId: string;
  readonly seq: number;
  readonly doseMj: number;
  readonly erythemaGrade: number;
  readonly technicianId: string;
  readonly administeredAt: string;
}
