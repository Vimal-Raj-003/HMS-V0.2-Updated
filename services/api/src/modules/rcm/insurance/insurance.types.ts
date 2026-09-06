/** EN-002 + RC-002 response shapes. */

export interface PayerView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly payerType: string;
  readonly irdaiRegNo: string | null;
  readonly portalUrl: string | null;
  readonly active: boolean;
}

export interface PolicyView {
  readonly id: string;
  readonly patientId: string;
  readonly payerId: string;
  readonly policyNo: string;
  readonly memberId: string | null;
  readonly holderName: string | null;
  readonly sumInsured: string | null;
  readonly remainingSi: string | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly verifiedStatus: string | null;
}

export interface InsCaseView {
  readonly id: string;
  readonly patientId: string;
  readonly payerId: string;
  readonly payerName: string | null;
  readonly policyId: string | null;
  readonly mode: string;
  readonly status: string;
  readonly priority: number;
  readonly approvedAmountTotal: string;
  readonly createdAt: string;
}

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
  /** True once the decision clock has run out. The moment cashless is at risk. */
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
