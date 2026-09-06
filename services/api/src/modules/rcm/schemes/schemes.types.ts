/** RC-007 response shapes. */

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

export interface BeneficiaryView {
  readonly id: string;
  readonly patientId: string;
  readonly schemeId: string;
  readonly schemeCode: string;
  readonly schemeName: string;
  /**
   * Masked. `docs/04` keeps a scheme card number out of the payloads a support
   * engineer reads; the desk confirms the last four against the card in hand.
   */
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
  /** True when this entitlement is currently stopping cash at the counters. */
  readonly blocksCash: boolean;
}

export interface VerificationView {
  readonly id: string;
  readonly method: string;
  readonly outcome: string;
  readonly message: string | null;
  readonly balanceReported: string | null;
  readonly at: string;
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

export interface CasePackageView {
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
  readonly packages: readonly CasePackageView[];
  readonly claims: readonly ClaimView[];
}

/** The answer a collection point gets before it opens the drawer. */
export interface CashCheckView {
  readonly allowed: boolean;
  /** Set when the tender is refused: which scheme, so the cashier can explain. */
  readonly schemeCode: string | null;
  readonly schemeName: string | null;
  readonly caseNo: string | null;
  readonly reason: string;
  /** The id of the row that recorded the refusal, when one was written. */
  readonly attemptId: string | null;
}

export interface CashAttemptView {
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

export interface ClaimView {
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
  /** Negative once the window has closed, which is the number that matters. */
  readonly daysLeftInWindow: number | null;
  readonly submittedAt: string | null;
  readonly paidAt: string | null;
  readonly authorityClaimNo: string | null;
  readonly utr: string | null;
}

export interface ClaimLineView {
  readonly id: string;
  readonly packageCode: string;
  readonly description: string;
  readonly quantity: number;
  readonly rate: string;
  readonly claimedAmount: string;
  readonly approvedAmount: string;
  readonly disallowedAmount: string;
  readonly disallowReason: string | null;
  /** Null until the authority has ruled on this line. */
  readonly decidedAt: string | null;
}

export interface ClaimDocumentView {
  readonly id: string;
  readonly docType: string;
  readonly isMandatory: boolean;
  readonly attached: boolean;
  readonly uploadedAt: string | null;
}

export interface ClaimDetailView extends ClaimView {
  readonly lines: readonly ClaimLineView[];
  readonly documents: readonly ClaimDocumentView[];
  readonly shortfalls: readonly ShortfallView[];
  /** What still has to be attached before submission will be accepted. */
  readonly missingDocuments: readonly string[];
}

export interface ShortfallView {
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
