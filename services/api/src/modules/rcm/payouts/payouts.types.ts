/** NC-034 response shapes. */

export interface PayoutRuleView {
  readonly id: string;
  readonly name: string;
  readonly basis: string;
  readonly serviceId: string | null;
  readonly departmentId: string | null;
  readonly payerType: string | null;
  readonly itemType: string | null;
  readonly sharePct: string | null;
  readonly flatAmount: string | null;
  readonly priority: number;
  readonly isActive: boolean;
}

export interface PayoutContractView {
  readonly id: string;
  readonly doctorId: string;
  readonly registrationNo: string | null;
  readonly model: string;
  readonly monthlyRetainer: string | null;
  readonly sessionRate: string | null;
  readonly panOnRecord: boolean;
  readonly tdsRatePct: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly isActive: boolean;
  readonly ruleCount: number;
  readonly rules: readonly PayoutRuleView[];
}

export interface PayoutPeriodView {
  readonly id: string;
  readonly label: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly status: string;
  readonly statementCount: number;
  readonly grossTotal: string;
  readonly tdsTotal: string;
  readonly netTotal: string;
  readonly computedAt: string | null;
  readonly paidAt: string | null;
}

export interface PayoutLineView {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceRefId: string | null;
  readonly description: string;
  readonly serviceName: string | null;
  readonly baseAmount: string;
  readonly sharePct: string | null;
  readonly earnedAmount: string;
  readonly occurredAt: string | null;
}

export interface PayoutDisputeView {
  readonly id: string;
  readonly category: string;
  readonly claim: string;
  readonly claimedAmount: string | null;
  readonly status: string;
  readonly resolution: string | null;
  readonly adjustment: string | null;
  readonly raisedAt: string;
  readonly resolvedAt: string | null;
}

export interface PayoutTdsView {
  readonly id: string;
  readonly financialYear: string;
  readonly grossThisPeriod: string;
  readonly grossYearToDate: string;
  readonly thresholdAmount: string;
  readonly rateApplied: string;
  readonly panOnRecord: boolean;
  readonly deducted: string;
  readonly challanNo: string | null;
}

export interface PayoutStatementView {
  readonly id: string;
  readonly statementNo: string;
  readonly periodId: string;
  readonly doctorId: string;
  readonly status: string;
  readonly grossEarnings: string;
  readonly otherDeductions: string;
  readonly tdsAmount: string;
  readonly netPayable: string;
  readonly lineCount: number;
  readonly preparedBy: string | null;
  readonly approvedBy: string | null;
  readonly paidAt: string | null;
  readonly paymentRef: string | null;
  /** A statement with one of these open cannot be approved or paid. */
  readonly openDisputes: number;
  readonly createdAt: string;
}

export interface PayoutStatementDetailView extends PayoutStatementView {
  readonly lines: readonly PayoutLineView[];
  readonly disputes: readonly PayoutDisputeView[];
  readonly tds: PayoutTdsView | null;
}

/**
 * What the compute run did, including what it refused.
 *
 * `referralsRefused` is the number that matters to a compliance officer: a rule
 * that would have paid a doctor for a service somebody else performed. The
 * database refuses each one, so this is a count of attempts rather than of
 * payments — but a non-zero count means somebody's rules need looking at.
 */
export interface ComputeResultView {
  readonly periodId: string;
  readonly statementsCreated: number;
  readonly linesCreated: number;
  readonly grossTotal: string;
  readonly tdsTotal: string;
  readonly netTotal: string;
  readonly referralsRefused: number;
  readonly statements: readonly PayoutStatementView[];
}
