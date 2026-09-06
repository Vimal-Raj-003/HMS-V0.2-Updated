/**
 * RC-003 response shapes.
 *
 * Money is a decimal **string** on the wire, everywhere, for the reason
 * `packages/contracts/src/events/registry.ts` states at length: a number goes
 * through IEEE-754 and ₹1,234.55 comes back as 1234.5499999999999. A tariff is
 * the one place in the system where that paisa becomes every bill.
 */

export interface TariffPlanView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly planType: string;
  readonly currency: string;
  readonly branchId: string | null;
  readonly payerId: string | null;
  readonly schemeId: string | null;
  readonly corporateId: string | null;
  readonly scope: string;
  readonly derivedFromPlanId: string | null;
  readonly derivationFormula: Readonly<Record<string, unknown>> | null;
  readonly priority: number;
  readonly isDefaultSelfPay: boolean;
  readonly isRateEditable: boolean;
  readonly status: string;
  readonly publishedVersionId: string | null;
}

export interface TariffVersionView {
  readonly id: string;
  readonly planId: string;
  readonly planCode: string;
  readonly versionNo: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly status: string;
  readonly changeNote: string | null;
  readonly itemCount: number;
  readonly submittedBy: string | null;
  readonly submittedAt: string | null;
  readonly publishedBy: string | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

export interface TariffItemView {
  readonly id: string;
  readonly versionId: string;
  readonly serviceId: string;
  readonly serviceCode: string;
  readonly serviceName: string;
  readonly bedClassId: string | null;
  readonly timeBand: string | null;
  readonly unit: string;
  readonly baseRate: string;
  readonly minRate: string | null;
  readonly maxRate: string | null;
  readonly hsnSac: string | null;
  readonly taxTreatment: string;
  readonly gstRate: string;
  readonly costAmount: string | null;
  readonly payerCode: string | null;
  readonly isNegotiable: boolean;
}

/**
 * One step of the resolution ladder, kept whether it matched or not.
 *
 * RC-003 §5 requires the *full attempted chain* on a miss, and it is the same
 * chain on a hit — "why this price" and "why no price" are one question asked at
 * two moments, and a screen that could only explain success would be useless in
 * exactly the case somebody calls the helpdesk about.
 */
export interface ResolutionStep {
  readonly stage: string;
  readonly detail: string;
  readonly matched: boolean;
}

export interface ResolvedRate {
  readonly outcome: 'resolved';
  readonly serviceId: string;
  readonly planId: string;
  readonly planCode: string;
  readonly versionId: string;
  readonly itemId: string;
  /** Before any plan discount or derivation. */
  readonly listRate: string;
  /** What the bill line should use. */
  readonly rate: string;
  readonly currency: string;
  readonly unit: string;
  readonly taxTreatment: string;
  readonly gstRate: string;
  readonly hsnSac: string | null;
  readonly derivedFrom: string | null;
  readonly appliedRules: readonly string[];
  readonly chain: readonly ResolutionStep[];
}

/**
 * The refusal. Deliberately not a zero.
 *
 * `phase-05 §Constraints`: "A blocked rate (`MISSING_RATE`) stops the bill and
 * raises a task — silence here becomes revenue leakage." The caller is expected
 * to hold the line, not to substitute a default.
 */
export interface MissingRate {
  readonly outcome: 'missing_rate';
  readonly serviceId: string;
  readonly attemptedPlanIds: readonly string[];
  readonly chain: readonly ResolutionStep[];
  readonly message: string;
}

export type RateResolution = ResolvedRate | MissingRate;

export interface MissingRateRow {
  readonly id: string;
  readonly serviceId: string;
  readonly serviceCode: string | null;
  readonly serviceName: string | null;
  readonly planId: string | null;
  readonly bedClassId: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly occurrences: number;
  readonly status: string;
}

export interface ChangeLogRow {
  readonly id: string;
  readonly versionId: string;
  readonly serviceId: string | null;
  readonly field: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly reason: string | null;
  readonly source: string;
}
