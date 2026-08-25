/** The shapes OP-003 returns. Money and quantity are decimal strings, never floats. */

export interface RxQueueView {
  readonly id: string;
  readonly pharmacyStoreId: string;
  readonly prescriptionId: string;
  readonly patientId: string;
  readonly encounterId: string | null;
  readonly prescriberUserId: string | null;
  readonly status: string;
  readonly priority: number;
  readonly itemCount: number;
  readonly hasAllergyFlag: boolean;
  readonly hasControlled: boolean;
  readonly assignedTo: string | null;
  readonly identityVerified: boolean;
  readonly identityMethod: string | null;
  readonly queuedAt: string;
  readonly arrivedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly slaDueAt: string | null;
  readonly cancelReason: string | null;
}

export interface DispenseAlertView {
  readonly key: string;
  readonly family: string;
  readonly severity: string;
  readonly interruption: string;
  readonly title: string;
  readonly detail: string;
  readonly acknowledged: boolean;
}

export interface DispenseItemView {
  readonly id: string;
  readonly lineNo: number;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly schedule: string;
  readonly batchId: string | null;
  readonly batchNo: string | null;
  readonly expiryDate: string | null;
  readonly uomId: string;
  readonly qtyEntered: string;
  readonly qtyBase: string;
  readonly qtyOrderedBase: string;
  readonly qtyReturnedBase: string;
  readonly status: string;
  readonly partialReason: string | null;
  readonly substitutedFromItemId: string | null;
  readonly mrp: string | null;
  readonly sellingPrice: string | null;
  readonly discount: string;
  readonly gstRate: string;
  readonly taxAmount: string;
  readonly lineTotal: string;
  readonly scanned: boolean;
  readonly fefoOverride: boolean;
  readonly ledgerId: string | null;
  readonly alerts: readonly DispenseAlertView[];
}

export interface DispenseView {
  readonly id: string;
  readonly dispenseNo: string;
  readonly dispenseType: string;
  readonly status: string;
  readonly pharmacyStoreId: string;
  readonly storeId: string;
  readonly prescriptionId: string | null;
  readonly rxQueueId: string | null;
  readonly patientId: string | null;
  readonly walkInName: string | null;
  readonly encounterId: string | null;
  readonly prescriberName: string | null;
  readonly prescriberRegNo: string | null;
  readonly pharmacistUserId: string;
  readonly secondAuthUserId: string | null;
  readonly payerType: string | null;
  readonly subtotal: string;
  readonly discount: string;
  readonly taxAmount: string;
  readonly totalAmount: string;
  readonly currency: string;
  readonly dispensedAt: string | null;
  readonly items: readonly DispenseItemView[];
  /** Hard stops with no recorded acknowledgement. Completion is refused while any remain. */
  readonly blockingAlerts: readonly DispenseAlertView[];
}

export interface SubstitutionView {
  readonly id: string;
  readonly dispenseId: string | null;
  readonly prescriptionItemId: string | null;
  readonly patientId: string | null;
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly reason: string;
  readonly status: string;
  readonly requestedBy: string;
  readonly prescriberUserId: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionNote: string | null;
  readonly expiresAt: string | null;
}

export interface LabelView {
  readonly dispenseItemId: string;
  readonly itemName: string;
  readonly batchNo: string | null;
  readonly expiryDate: string | null;
  readonly qty: string;
  readonly patientName: string;
  readonly locale: string;
  /** Dosage instructions in the locale, or the English text when none exists. */
  readonly instructions: string;
  readonly warnings: readonly string[];
}

export interface SaleReturnView {
  readonly id: string;
  readonly returnNo: string;
  readonly originalDispenseId: string;
  readonly patientId: string | null;
  readonly status: string;
  readonly reasonCode: string;
  readonly refundAmount: string;
  readonly lines: readonly {
    readonly id: string;
    readonly dispenseItemId: string;
    readonly itemId: string;
    readonly batchId: string | null;
    readonly qtyBase: string;
    readonly disposition: string;
    readonly refundAmount: string;
  }[];
}

export interface RegisterEntryView {
  readonly id: string;
  readonly registerType: string;
  readonly serialNo: string;
  readonly fy: string;
  readonly storeId: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly batchId: string | null;
  readonly txnType: string;
  readonly qtyInBase: string;
  readonly qtyOutBase: string;
  readonly balanceAfterBase: string;
  readonly patientId: string | null;
  readonly patientName: string | null;
  readonly prescriberName: string | null;
  readonly prescriberRegNo: string | null;
  readonly firstAuthUserId: string;
  readonly secondAuthUserId: string | null;
  readonly remarks: string | null;
  readonly enteredAt: string;
}

export interface CustodyCheckView {
  readonly id: string;
  readonly storeId: string;
  readonly itemId: string;
  readonly batchId: string | null;
  readonly shiftLabel: string;
  readonly systemBalanceBase: string;
  readonly physicalCountBase: string;
  readonly varianceBase: string;
  readonly checkedBy1: string;
  readonly checkedBy2: string;
  readonly incidentRef: string | null;
  readonly explanation: string | null;
  readonly checkedAt: string;
}

export interface RecallView {
  readonly id: string;
  readonly recallNo: string;
  readonly source: string;
  readonly itemId: string | null;
  readonly batchId: string | null;
  readonly batchNo: string | null;
  readonly recallClass: string | null;
  readonly reason: string;
  readonly status: string;
  readonly patientsIdentified: number;
  readonly patientsContacted: number;
  readonly unitsReturned: string;
  readonly raisedAt: string;
  readonly closedAt: string | null;
}

export interface RecallTraceView {
  readonly recall: RecallView;
  readonly patients: readonly {
    readonly traceId: string;
    readonly patientId: string | null;
    readonly dispenseItemId: string | null;
    readonly qtyDispensedBase: string;
    readonly dispensedAt: string | null;
    readonly contactedAt: string | null;
  }[];
  readonly quarantinedQtyBase: string;
  readonly openStoreCount: number;
}

export interface ExpiryActionView {
  readonly id: string;
  readonly storeId: string;
  readonly itemId: string;
  readonly batchId: string;
  readonly action: string;
  readonly qtyBase: string;
  readonly valueAtCost: string | null;
  readonly reason: string;
  readonly status: string;
  readonly approvedBy: string | null;
}

export interface DayCloseView {
  readonly id: string;
  readonly pharmacyStoreId: string;
  readonly businessDate: string;
  readonly shiftLabel: string | null;
  readonly dispenseCount: number;
  readonly grossSales: string;
  readonly returnsValue: string;
  readonly cashCollected: string;
  readonly cardCollected: string;
  readonly upiCollected: string;
  readonly creditValue: string;
  readonly cashCounted: string;
  readonly cashVariance: string;
  readonly narcoticChecksDone: boolean;
  readonly stockExceptions: readonly {
    readonly kind: string;
    readonly detail: string;
    readonly count: number;
  }[];
  readonly status: string;
  readonly closedAt: string | null;
}

export interface InterventionView {
  readonly id: string;
  readonly dispenseId: string | null;
  readonly prescriptionId: string | null;
  readonly patientId: string | null;
  readonly interventionType: string;
  readonly detail: string;
  readonly outcome: string | null;
  readonly doctorContacted: boolean;
  readonly pharmacistUserId: string;
  readonly occurredAt: string;
}
