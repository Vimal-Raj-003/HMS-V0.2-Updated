/** Row shapes the eye clinic's screens read. */

export interface AcuityRow {
  readonly id: string;
  readonly eye: string;
  readonly context: string;
  readonly notation: string;
  readonly value: string;
  /** Derived by the database. Null where the notation has no equivalent. */
  readonly logmar: number | null;
  readonly recordedAt: string;
  readonly recordedBy: string;
}

export interface RefractionRow {
  readonly id: string;
  readonly eye: string;
  readonly kind: string;
  readonly sph: number | null;
  readonly cyl: number | null;
  readonly axis: number | null;
  readonly add: number | null;
  readonly prism: number | null;
  readonly base: string | null;
  readonly vaAchieved: string | null;
  readonly pdMono: number | null;
  readonly pdBino: number | null;
  readonly k1: number | null;
  readonly k2: number | null;
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
  /**
   * `normal`, `raised` or `urgent`, computed from the reading against the
   * hospital's thresholds. On the row rather than in the client, so a banner
   * and a report cannot disagree about which pressures were high.
   */
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
  readonly drawingKey: string | null;
  readonly recordedAt: string;
}

export interface DiagnosisRow {
  readonly id: string;
  readonly eye: string;
  readonly icd10: string;
  readonly snomed: string | null;
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
  readonly signedBy: string | null;
  readonly createdAt: string;
  /** The worst pressure recorded this visit, for the worklist chip. */
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
  readonly patientId: string;
  readonly visitId: string;
  readonly kind: string;
  readonly lines: unknown;
  readonly pdMono: number | null;
  readonly pdBino: number | null;
  readonly validUntil: string;
  readonly signedBy: string;
  readonly signedAt: string;
  readonly signedUnderDelegation: boolean;
  readonly printedAt: string | null;
}

export interface SurgeryPlanRow {
  readonly id: string;
  readonly patientId: string;
  readonly visitId: string;
  readonly procedureCode: string;
  readonly eye: string;
  readonly anaesthesia: string;
  readonly iolModel: string | null;
  readonly iolPower: number | null;
  readonly iolFormula: string | null;
  readonly targetRefraction: number | null;
  readonly biometry: unknown;
  readonly biometryAt: string | null;
  readonly status: string;
  readonly otCaseId: string | null;
  readonly npcbviFlag: boolean;
  /**
   * Days since the biometry, and whether that is past the six-month convention.
   * A warning, not a refusal: six months is a convention, and a stable eye is a
   * stable eye — but the surgeon should be the one deciding that, knowingly.
   */
  readonly biometryAgeDays: number | null;
  readonly biometryStale: boolean;
}

export interface TrendPoint {
  readonly at: string;
  readonly eye: string;
  readonly value: number;
}
