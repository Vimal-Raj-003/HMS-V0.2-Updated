/** OP-025 row shapes, mirroring the API's. */

export interface AcuityRow {
  readonly id: string;
  readonly eye: string;
  readonly context: string;
  readonly notation: string;
  readonly value: string;
  /** Derived by the database. Null where the notation has no equivalent. */
  readonly logmar: number | null;
  readonly recordedAt: string;
}

export interface RefractionRow {
  readonly id: string;
  readonly eye: string;
  readonly kind: string;
  readonly sph: number | null;
  readonly cyl: number | null;
  readonly axis: number | null;
  readonly add: number | null;
  readonly vaAchieved: string | null;
  readonly pdBino: number | null;
  readonly source: string;
  readonly recordedAt: string;
}

export interface IopRow {
  readonly id: string;
  readonly eye: string;
  readonly method: string;
  readonly valueMmhg: number;
  readonly cctUm: number | null;
  readonly correctedMmhg: number | null;
  readonly postDilation: boolean;
  readonly recordedAt: string;
  readonly band: 'normal' | 'raised' | 'urgent';
}

export interface ExamRow {
  readonly id: string;
  readonly segment: string;
  readonly eye: string;
  readonly findings: unknown;
  readonly drGrade: string | null;
  readonly dme: boolean | null;
  readonly cdrVertical: number | null;
  readonly recordedAt: string;
}

export interface DiagnosisRow {
  readonly id: string;
  readonly eye: string;
  readonly icd10: string;
  readonly isPrimary: boolean;
  readonly note: string | null;
}

export interface VisitRow {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly stage: string;
  readonly dilatedAt: string | null;
  readonly dilatingDrug: string | null;
  readonly cycloplegic: boolean;
  readonly signedAt: string | null;
  readonly createdAt: string;
  readonly highestIop: number | null;
}

export interface VisitDetail {
  readonly visit: VisitRow;
  readonly acuities: readonly AcuityRow[];
  readonly refractions: readonly RefractionRow[];
  readonly iop: readonly IopRow[];
  readonly exam: readonly ExamRow[];
  readonly diagnoses: readonly DiagnosisRow[];
}

export interface SpectacleRxRow {
  readonly id: string;
  readonly rxNo: string;
  readonly kind: string;
  readonly lines: unknown;
  readonly pdBino: number | null;
  readonly validUntil: string;
  readonly signedAt: string;
  readonly signedUnderDelegation: boolean;
}

export interface SurgeryPlanRow {
  readonly id: string;
  readonly procedureCode: string;
  readonly eye: string;
  readonly anaesthesia: string;
  readonly iolModel: string | null;
  readonly iolPower: number | null;
  readonly iolFormula: string | null;
  readonly targetRefraction: number | null;
  readonly status: string;
  readonly npcbviFlag: boolean;
  readonly biometryAgeDays: number | null;
  readonly biometryStale: boolean;
}

export interface TrendPoint {
  readonly at: string;
  readonly eye: string;
  readonly value: number;
}
