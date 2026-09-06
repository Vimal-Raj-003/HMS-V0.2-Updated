/**
 * RC-003 wire types, mirroring `services/api/src/modules/rcm/tariff/tariff.types.ts`.
 *
 * Money is a decimal **string** in every field, and the screen never converts
 * one to a number to display it. A tariff is where a rounding error becomes
 * every bill priced from it.
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

/** One rung of the resolution ladder, kept whether it matched or not. */
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
  readonly listRate: string;
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

export interface CreateVersionRequest {
  readonly effectiveFrom: string;
  readonly effectiveTo?: string;
  readonly changeNote?: string;
  readonly cloneFromVersionId?: string;
}

export interface PublishRequest {
  readonly reason: string;
  readonly acceptBelowCost?: boolean;
}

export interface ReasonRequest {
  readonly reason: string;
}

export interface ResolveMissingRequest {
  readonly action: 'priced' | 'waived';
  readonly reason: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-005 — billing
// ═════════════════════════════════════════════════════════════════════════════

export interface BillSummaryView {
  readonly id: string;
  readonly billNo: string;
  readonly patientId: string;
  readonly patientName: string;
  readonly uhid: string;
  readonly visitId: string | null;
  readonly billType: string;
  readonly status: string;
  readonly payerType: string;
  readonly currency: string;
  readonly grossAmount: string;
  readonly discountAmount: string;
  readonly taxableAmount: string;
  readonly cgst: string;
  readonly sgst: string;
  readonly igst: string;
  readonly roundOff: string;
  readonly netAmount: string;
  readonly paidAmount: string;
  readonly balanceAmount: string;
  readonly createdAt: string;
  readonly finalizedAt: string | null;
}

export interface BillItemView {
  readonly id: string;
  readonly itemType: string;
  readonly description: string;
  readonly hsnSac: string | null;
  readonly qty: string;
  readonly unitPrice: string;
  readonly gross: string;
  readonly discountAmount: string;
  readonly taxableValue: string;
  readonly gstRate: string;
  readonly cgst: string;
  readonly sgst: string;
  readonly igst: string;
  readonly isExempt: boolean;
  readonly net: string;
  readonly status: string;
  /** `missing` means the line is held — no rate resolved, nothing billed. */
  readonly priceStatus: string;
  readonly sourceModule: string;
  readonly sourceRefId: string;
  readonly tariffVersionId: string | null;
  readonly performedAt: string | null;
}

export interface InvoiceView {
  readonly id: string;
  readonly invoiceNo: string;
  readonly seriesKey: string;
  readonly docType: string;
  readonly isB2b: boolean;
  readonly recipientGstin: string | null;
  readonly einvoiceStatus: string;
  readonly status: string;
  readonly issuedAt: string;
  readonly originalInvoiceId: string | null;
}

export interface DiscountRequestView {
  readonly id: string;
  readonly billItemId: string | null;
  readonly requestedBy: string;
  readonly pct: string | null;
  readonly amount: string | null;
  readonly reasonCode: string;
  readonly justification: string | null;
  readonly approvedBy: string | null;
  readonly decidedAt: string | null;
  readonly status: string;
}

export interface BillDetailView extends BillSummaryView {
  readonly items: readonly BillItemView[];
  readonly invoices: readonly InvoiceView[];
  readonly discountRequests: readonly DiscountRequestView[];
}

export interface BillingExceptionView {
  readonly id: string;
  readonly exceptionType: string;
  readonly refId: string | null;
  readonly amount: string | null;
  readonly detail: string | null;
  readonly detectedAt: string;
  readonly status: string;
}

export interface FinalizeRequest {
  readonly reason: string;
  readonly recipientGstin?: string;
  readonly recipientName?: string;
  readonly placeOfSupplyState?: string;
}

export interface RequestDiscountRequest {
  readonly billItemId?: string;
  readonly pct?: number;
  readonly amount?: number;
  readonly reasonCode: string;
  readonly justification?: string;
}

export interface DecideDiscountRequest {
  readonly decision: 'approved' | 'rejected';
  readonly reason: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// EN-010 — payments
// ═════════════════════════════════════════════════════════════════════════════

export interface PayIntentView {
  readonly id: string;
  readonly kind: string;
  readonly refType: string;
  readonly refId: string;
  readonly amount: string;
  readonly currency: string;
  readonly methodHint: string;
  readonly status: string;
  readonly qrImageUrl: string | null;
  readonly linkUrl: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface PayPaymentView {
  readonly id: string;
  readonly intentId: string;
  readonly providerPaymentId: string;
  readonly method: string;
  readonly amount: string;
  readonly fee: string;
  readonly status: string;
  readonly capturedAt: string | null;
  readonly rrn: string | null;
  readonly utr: string | null;
}

export interface PayRefundView {
  readonly id: string;
  readonly paymentId: string;
  readonly amount: string;
  readonly reasonCode: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly approvedBy: string | null;
  readonly processedAt: string | null;
}

export interface PayReconExceptionView {
  readonly id: string;
  readonly exceptionType: string;
  readonly amount: string | null;
  readonly refs: Readonly<Record<string, unknown>>;
  readonly status: string;
  readonly notes: string | null;
  readonly createdAt: string;
}

// ═════════════════════════════════════════════════════════════════════════════
// OP-023 — packages
// ═════════════════════════════════════════════════════════════════════════════

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

// ═════════════════════════════════════════════════════════════════════════════
// EN-002 + RC-002 — insurance and pre-authorisation
// ═════════════════════════════════════════════════════════════════════════════

export interface PreauthView {
  readonly id: string;
  readonly preauthNo: string;
  readonly caseId: string;
  readonly patientId: string;
  readonly type: string;
  readonly status: string;
  readonly isEmergency: boolean;
  readonly requestedAmount: string;
  readonly approvedAmount: string | null;
  readonly approvedLosDays: number | null;
  readonly validTill: string | null;
  readonly payerRefNo: string | null;
  readonly denialReasonCode: string | null;
  readonly channel: string;
  readonly submittedAt: string | null;
  readonly decidedAt: string | null;
  readonly decisionDueAt: string | null;
  /** The clock has run out. The moment cashless is at risk of becoming reimbursement. */
  readonly slaBreached: boolean;
  readonly openQueries: number;
}

export interface PreauthQueryView {
  readonly id: string;
  readonly queryNo: number;
  readonly category: string;
  readonly text: string;
  readonly raisedAt: string;
  readonly slaDueAt: string | null;
  readonly repliedAt: string | null;
  readonly replyText: string | null;
  readonly isOpen: boolean;
}

export interface PreauthDetailView extends PreauthView {
  readonly queries: readonly PreauthQueryView[];
  readonly history: readonly {
    readonly toStatus: string;
    readonly actorType: string;
    readonly at: string;
    readonly reason: string | null;
  }[];
}

// ── RC-007 · government schemes ──────────────────────────────────────────────

export interface SchemeView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly authority: string | null;
  readonly empanelmentNo: string | null;
  readonly cashBlockScope: string;
  readonly requiresPreauth: boolean;
  readonly claimFormat: string;
  readonly claimWindowDays: number;
  readonly isActive: boolean;
  readonly packageCount: number;
}

export interface SchemePackageView {
  readonly id: string;
  readonly schemeId: string;
  readonly schemeCode: string;
  readonly packageCode: string;
  readonly name: string;
  readonly specialty: string | null;
  readonly procedureType: string;
  readonly baseRate: string;
  readonly implantAllowed: boolean;
  readonly implantCap: string | null;
  readonly preAuthRequired: boolean;
  readonly losDays: number | null;
}

export interface SchemeBeneficiaryView {
  readonly id: string;
  readonly patientId: string;
  readonly schemeId: string;
  readonly schemeCode: string;
  readonly schemeName: string;
  readonly memberIdMasked: string;
  readonly nameOnCard: string | null;
  readonly relation: string;
  readonly entitlementAmount: string;
  readonly entitlementBalance: string;
  readonly validFrom: string | null;
  readonly validTill: string | null;
  readonly status: string;
  readonly verifiedAt: string | null;
  readonly verificationMethod: string | null;
  readonly blocksCash: boolean;
}

export interface SchemeCaseView {
  readonly id: string;
  readonly caseNo: string;
  readonly schemeId: string;
  readonly schemeCode: string;
  readonly patientId: string;
  readonly beneficiaryId: string;
  readonly encounterId: string | null;
  readonly status: string;
  readonly authorityCaseNo: string | null;
  readonly admittedAt: string | null;
  readonly dischargedAt: string | null;
  readonly packageAmount: string;
  readonly claimedAmount: string;
  readonly settledAmount: string;
  readonly shortfallAmount: string;
  readonly createdAt: string;
}

export interface SchemeCasePackageView {
  readonly id: string;
  readonly packageCode: string;
  readonly packageName: string;
  readonly rate: string;
  readonly quantity: number;
  readonly amount: string;
  readonly implantAmount: string;
  readonly isPrimary: boolean;
  readonly approved: boolean;
}

export interface SchemeCaseDetailView extends SchemeCaseView {
  readonly packages: readonly SchemeCasePackageView[];
  readonly claims: readonly SchemeClaimView[];
}

export interface SchemeCashAttemptView {
  readonly id: string;
  readonly patientId: string;
  readonly schemeId: string;
  readonly schemeCode: string;
  readonly collectionPoint: string;
  readonly mode: string;
  readonly amount: string;
  readonly outcome: string;
  readonly reason: string;
  readonly attemptedAt: string;
}

export interface SchemeClaimView {
  readonly id: string;
  readonly claimNo: string;
  readonly caseId: string;
  readonly caseNo: string | null;
  readonly schemeCode: string | null;
  readonly format: string;
  readonly status: string;
  readonly claimedAmount: string;
  readonly approvedAmount: string;
  readonly paidAmount: string;
  readonly shortfallAmount: string;
  readonly windowClosesOn: string | null;
  readonly daysLeftInWindow: number | null;
  readonly submittedAt: string | null;
  readonly paidAt: string | null;
  readonly authorityClaimNo: string | null;
  readonly utr: string | null;
}

export interface SchemeClaimLineView {
  readonly id: string;
  readonly packageCode: string;
  readonly description: string;
  readonly quantity: number;
  readonly rate: string;
  readonly claimedAmount: string;
  readonly approvedAmount: string;
  readonly disallowedAmount: string;
  readonly disallowReason: string | null;
  readonly decidedAt: string | null;
}

export interface SchemeClaimDocumentView {
  readonly id: string;
  readonly docType: string;
  readonly isMandatory: boolean;
  readonly attached: boolean;
  readonly uploadedAt: string | null;
}

export interface SchemeShortfallView {
  readonly id: string;
  readonly claimId: string;
  readonly claimNo: string | null;
  readonly amount: string;
  readonly category: string;
  readonly reasonCode: string;
  readonly narrative: string | null;
  readonly status: string;
  readonly appealRef: string | null;
  readonly recoveredAmount: string;
  readonly writeOffRequestedBy: string | null;
  readonly writeOffApprovedBy: string | null;
  readonly createdAt: string;
}

export interface SchemeClaimDetailView extends SchemeClaimView {
  readonly lines: readonly SchemeClaimLineView[];
  readonly documents: readonly SchemeClaimDocumentView[];
  readonly shortfalls: readonly SchemeShortfallView[];
  readonly missingDocuments: readonly string[];
}

// ── RC-008 · cost estimator ──────────────────────────────────────────────────

export interface EstimateLineView {
  readonly id: string;
  readonly serviceId: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unitRate: string;
  readonly amount: string;
  readonly discount: string;
  readonly confidence: string;
  readonly source: string;
  readonly taxTreatment: string;
  readonly gstRate: string;
}

export interface EstimateScenarioView {
  readonly id: string;
  readonly bedClassId: string | null;
  readonly label: string;
  readonly totalPayable: string;
  readonly patientShare: string;
  readonly deltaVsChosen: string;
  readonly isChosen: boolean;
}

export interface EstimateEventView {
  readonly id: string;
  readonly kind: string;
  readonly channel: string | null;
  readonly note: string | null;
  readonly at: string;
}

export interface EstimateView {
  readonly id: string;
  readonly estimateNo: string;
  readonly title: string;
  readonly patientId: string | null;
  readonly enquirerName: string | null;
  readonly procedureCode: string | null;
  readonly status: string;
  readonly losDays: number;
  readonly totalGross: string;
  readonly totalDiscount: string;
  readonly totalPayable: string;
  readonly patientShare: string;
  readonly payerShare: string;
  readonly coPayPct: string;
  readonly deductible: string;
  readonly currency: string;
  readonly validTill: string | null;
  readonly daysLeft: number | null;
  readonly issuedAt: string | null;
  readonly supersedesId: string | null;
  readonly convertedAt: string | null;
  readonly convertedEncounterId: string | null;
  readonly declineReason: string | null;
  readonly createdAt: string;
}

export interface EstimateVarianceView {
  readonly id: string;
  readonly estimateId: string;
  readonly estimateNo: string | null;
  readonly procedureCode: string | null;
  readonly estimatedTotal: string;
  readonly actualTotal: string;
  readonly estimatedPatientShare: string;
  readonly actualPatientShare: string;
  readonly varianceAmount: string;
  readonly variancePct: string;
  readonly estimatedLos: number;
  readonly actualLos: number | null;
  readonly explanation: string | null;
  readonly recordedAt: string;
}

export interface EstimateDetailView extends EstimateView {
  readonly lines: readonly EstimateLineView[];
  readonly scenarios: readonly EstimateScenarioView[];
  readonly events: readonly EstimateEventView[];
  readonly variance: EstimateVarianceView | null;
  readonly softLineCount: number;
  readonly unpricedLineCount: number;
}

export interface EstimateVarianceSummaryRow {
  readonly procedureCode: string;
  readonly sampleCount: number;
  readonly meanVariancePct: string;
  readonly medianVariancePct: string;
  readonly p90VariancePct: string;
  readonly overrunRatePct: string;
  readonly worstVariancePct: string;
}

// ── RC-006 · revenue leakage audit ───────────────────────────────────────────

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

export interface LeakScanView {
  readonly id: string;
  readonly trigger: string;
  readonly encounterId: string | null;
  readonly status: string;
  readonly rulesRun: number;
  readonly rowsExamined: number;
  readonly findingsNew: number;
  readonly findingsTotal: number;
  readonly gapTotal: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

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
    readonly acceptanceRatePct: string;
  }>;
}

// ── NC-034 · doctor payouts ──────────────────────────────────────────────────

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
  readonly openDisputes: number;
  readonly createdAt: string;
}

export interface PayoutStatementDetailView extends PayoutStatementView {
  readonly lines: readonly PayoutLineView[];
  readonly disputes: readonly PayoutDisputeView[];
  readonly tds: PayoutTdsView | null;
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
