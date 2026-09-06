/** RC-006 response shapes. */

export interface LeakRuleView {
  readonly id: string;
  readonly reconciler: string;
  readonly name: string;
  readonly minGapAmount: string;
  readonly severity: string;
  readonly lookbackDays: number;
  readonly isActive: boolean;
  readonly notes: string | null;
}

export interface LeakScanView {
  readonly id: string;
  readonly trigger: string;
  readonly encounterId: string | null;
  readonly windowFrom: string | null;
  readonly windowTo: string | null;
  readonly status: string;
  readonly rulesRun: number;
  readonly rowsExamined: number;
  readonly findingsNew: number;
  readonly findingsTotal: number;
  readonly gapTotal: string;
  readonly error: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface LeakFindingView {
  readonly id: string;
  readonly reconciler: string;
  readonly severity: string;
  readonly patientId: string | null;
  readonly encounterId: string | null;
  readonly sourceRefType: string;
  readonly sourceRefId: string;
  readonly description: string;
  readonly serviceName: string | null;
  readonly expectedAmount: string;
  readonly billedAmount: string;
  readonly gapAmount: string;
  readonly occurredAt: string | null;
  readonly status: string;
  readonly acceptedBy: string | null;
  readonly dismissReason: string | null;
  readonly recoveredAmount: string;
  readonly createdAt: string;
}

export interface LeakActionView {
  readonly id: string;
  readonly kind: string;
  readonly reason: string | null;
  readonly amount: string | null;
  readonly at: string;
}

export interface LeakFindingDetailView extends LeakFindingView {
  readonly actions: readonly LeakActionView[];
}

export interface LeakScanResultView extends LeakScanView {
  readonly findings: readonly LeakFindingView[];
}

/**
 * The answer the discharge desk gets.
 *
 * `cleared` false with a gap is the whole point of exit gate 9 — the moment
 * before the patient leaves is the last one at which a missed charge can be
 * settled without chasing a family who has gone home.
 */
export interface DischargeCheckView {
  readonly id: string;
  readonly encounterId: string;
  readonly openFindings: number;
  readonly gapTotal: string;
  readonly cleared: boolean;
  readonly overrideReason: string | null;
  readonly checkedAt: string;
  readonly findings: readonly LeakFindingView[];
}

/** What the audit found, and what came back. §5.7's recovered-amount dashboard. */
export interface LeakDashboardView {
  readonly openCount: number;
  readonly openGap: string;
  readonly acceptedCount: number;
  readonly acceptedGap: string;
  readonly recoveredCount: number;
  readonly recoveredAmount: string;
  readonly dismissedCount: number;
  readonly dismissedGap: string;
  readonly byReconciler: ReadonlyArray<{
    readonly reconciler: string;
    readonly openCount: number;
    readonly openGap: string;
    readonly recoveredAmount: string;
    /** Of everything this reconciler raised, how much was agreed to be real. */
    readonly acceptanceRatePct: string;
  }>;
}
