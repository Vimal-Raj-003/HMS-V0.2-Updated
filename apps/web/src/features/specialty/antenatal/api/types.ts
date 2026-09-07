/**
 * What the antenatal clinic returns.
 *
 * Note what is not here, in a file that would be the obvious place for it:
 * there is no field for the sex of a foetus, because there is no column, no
 * request and no route. The PC-PNDT Act is enforced by inspecting records, and
 * a type that named it would be a type somebody could populate.
 */

export interface PregnancyRow {
  readonly id: string;
  readonly patientId: string;
  readonly ancNo: string;
  readonly workingEdd: string;
  readonly eddSource: string;
  readonly eddRationale: string | null;
  readonly formula: string;
  readonly bloodGroup: string | null;
  readonly rhNegative: boolean | null;
  readonly riskCategory: string;
  readonly status: string;
  readonly gaDays: number;
  readonly gaLabel: string;
  readonly trimester: number;
  readonly weeksToTerm: number;
  readonly dueItems: number;
  readonly overdueItems: number;
  readonly antiDStatus: string;
  readonly lastVisitAt: string | null;
  readonly nextVisitAt: string | null;
}

export interface AncVisitRow {
  readonly id: string;
  readonly visitNo: number;
  readonly visitedAt: string;
  readonly gaLabel: string;
  readonly dangerSigns: readonly string[];
  readonly bpSys: number | null;
  readonly bpDia: number | null;
  readonly sfhCm: number | null;
  readonly sfhDeviationCm: number | null;
  readonly sfhFlag: string | null;
  readonly meowsScore: number | null;
  readonly meowsAction: string | null;
  readonly plan: string | null;
  readonly signedAt: string | null;
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
  readonly status: string;
  readonly waivedReason: string | null;
  readonly daysOverdue: number | null;
}

export interface DeliveryPlanRow {
  readonly id: string;
  readonly version: number;
  readonly plannedMode: string;
  readonly indication: string | null;
  readonly plannedDate: string | null;
}

export interface PncVisitRow {
  readonly id: string;
  readonly dayNo: number;
  readonly visitedAt: string;
  readonly epdsTotal: number | null;
  readonly epdsItem10: number | null;
  readonly epdsReferral: boolean;
}

export interface PregnancyDetail {
  readonly pregnancy: PregnancyRow;
  readonly visits: readonly AncVisitRow[];
  readonly schedule: readonly ScheduleItemRow[];
  readonly plans: readonly DeliveryPlanRow[];
  readonly pnc: readonly PncVisitRow[];
}
