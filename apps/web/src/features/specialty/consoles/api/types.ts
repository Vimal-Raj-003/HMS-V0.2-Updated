/**
 * What the five device consoles return.
 *
 * Mirrors `services/api/src/modules/specialty/consoles/consoles.types.ts`. The
 * asymmetry there is the asymmetry here: every derived number is on the way
 * back and none of them is on the way out, so a form has nowhere to put a QTc,
 * a ratio, a four-frequency average, a PASI or a chart state.
 */

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
  readonly awaitingAcknowledgement: boolean;
  readonly qtcProlonged: boolean;
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
  readonly inRange: boolean | null;
  readonly ttrPct: number | null;
}

export interface PftRow {
  readonly id: string;
  readonly patientId: string;
  readonly performedAt: string;
  readonly tests: readonly string[];
  readonly qualityGrade: string | null;
  readonly preFvc: number | null;
  readonly preFev1: number | null;
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
  readonly unsignable: boolean;
  readonly obstructed: boolean | null;
}

export interface SleepStudyRow {
  readonly id: string;
  readonly patientId: string;
  readonly type: string;
  readonly scheduledAt: string;
  readonly ahi: number | null;
  readonly severity: string | null;
  readonly interpretation: string | null;
  readonly status: string;
  readonly signedAt: string | null;
}

export interface PapRxRow {
  readonly id: string;
  readonly patientId: string;
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
  readonly adherent: boolean | null;
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
  readonly ptaAvg: number | null;
  readonly degree: string | null;
  readonly type: string | null;
  readonly srt: number | null;
  readonly sdsPct: number | null;
  readonly tympType: string | null;
  readonly interpretation: string | null;
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
  readonly priceLocked: boolean;
  readonly items: readonly DentalPlanItemRow[];
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
  readonly growthMm: number | null;
}

export interface DermScoreRow {
  readonly id: string;
  readonly patientId: string;
  readonly scoreType: string;
  readonly components: Record<string, unknown>;
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
  readonly suggestedNextDoseMj: number | null;
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
