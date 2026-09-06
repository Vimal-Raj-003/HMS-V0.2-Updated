/** OP-023 response shapes. Money is a decimal string throughout. */

export interface PackageView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: string;
  readonly scope: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly validityDays: number;
  readonly maxUnits: number | null;
  readonly isPublic: boolean;
  readonly livePrice: string | null;
}

export interface PackageActivationView {
  readonly id: string;
  readonly bookingId: string | null;
  readonly packageVersionId: string;
  readonly patientId: string;
  readonly status: string;
  readonly unitsTotal: number;
  readonly unitsUsed: number;
  readonly coveredAmount: string;
  readonly excessAmount: string;
  readonly exclusionsAmount: string;
  readonly activatedAt: string;
  readonly closedAt: string | null;
}

export interface PackageBookingView {
  readonly id: string;
  readonly bookingNo: string;
  readonly patientId: string;
  readonly packageVersionId: string;
  readonly status: string;
  readonly advanceRequired: string;
  readonly advancePaid: string;
  readonly plannedDate: string | null;
  readonly createdAt: string;
}

/** What the package did to one charge, and why. */
export interface ChargeEvaluationView {
  readonly id: string;
  readonly decision: string;
  readonly amount: string;
  readonly coveredAmount: string;
  readonly patientAmount: string;
  readonly ruleRef: string | null;
  readonly evaluatedAt: string;
}

export interface VarianceRequestView {
  readonly id: string;
  readonly activationId: string;
  readonly amount: string;
  readonly reasonCode: string;
  readonly justification: string | null;
  readonly status: string;
  readonly requestedBy: string;
  readonly decisionBy: string | null;
  readonly billAction: string | null;
  readonly decidedAt: string | null;
}
