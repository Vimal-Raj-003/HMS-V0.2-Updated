/**
 * The shapes OP-003 returns and accepts, mirrored from
 * `services/api/src/modules/pharmacy/pharmacy.types.ts` and `.schemas.ts`.
 *
 * They are hand-written here rather than imported for the reason the API's own
 * file gives for not deriving its views from its row types: a view is a
 * contract, and a contract that follows a table follows every column somebody
 * adds to it. `packages/contracts` does not yet publish the Phase-4 views, and
 * `packages/*` is outside this change's remit — so this file is the client's
 * half of that contract and is reported as a gap rather than smuggled upstream.
 *
 * **Money and quantity are decimal strings, never numbers.** `numeric(18,4)`
 * through IEEE-754 and back is not the number that was stored, and a pharmacy
 * bill that is out by a paisa per line is out by a great deal by close of day.
 * Nothing in this feature parses one into a `number` except to compare it.
 */

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
  /** The CDSS `subjectCode`. This is what an acknowledgement is keyed on. */
  readonly key: string;
  /** `allergy`, `ddi`, `schedule_guardrail`, … — the family decides who it stops. */
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
  /** Hard stops with no recorded acknowledgement, across every family. */
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
  readonly instructions: string;
  readonly warnings: readonly string[];
}

export interface SaleReturnLineView {
  readonly id: string;
  readonly dispenseItemId: string;
  readonly itemId: string;
  readonly batchId: string | null;
  readonly qtyBase: string;
  readonly disposition: string;
  readonly refundAmount: string;
}

export interface SaleReturnView {
  readonly id: string;
  readonly returnNo: string;
  readonly originalDispenseId: string;
  readonly patientId: string | null;
  readonly status: string;
  readonly reasonCode: string;
  readonly refundAmount: string;
  readonly lines: readonly SaleReturnLineView[];
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

/** `GET /pharmacy/stock` — the counter's shelf, not the ledger. */
export interface PharmacyStockRow {
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly schedule: string;
  readonly batchId: string | null;
  readonly batchNo: string | null;
  readonly expiryDate: string | null;
  readonly qtyOnHand: string;
  readonly mrp: string | null;
}

export interface PharmacyExpiryRow {
  readonly storeId: string;
  readonly itemId: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly batchId: string;
  readonly batchNo: string;
  readonly expiryDate: string;
  readonly daysToExpiry: number;
  readonly qtyOnHand: string;
  readonly valueAtCost: string;
}

// ── request bodies ───────────────────────────────────────────────────────────

/**
 * The second person, as a **credential** rather than an identifier.
 *
 * A user id is something the first pharmacist can type; a control one person can
 * satisfy is not a control. `credentialKind` exists because the API's schema has
 * it, but `services/api` verifies only `password` — it refuses `pin` and `totp`
 * with `not-implemented` rather than accepting a factor it cannot check — so the
 * dialog offers exactly one.
 */
export interface CoSignerInput {
  readonly identifier: string;
  readonly credentialKind: 'password';
  readonly credential: string;
}

export type IdentityMethod =
  | 'uhid_scan'
  | 'wristband_scan'
  | 'abha_verified'
  | 'photo_id'
  | 'two_identifiers_verbal'
  | 'attendant_verified';

export type DispenseType = 'rx' | 'otc' | 'ip_issue' | 'ward_stock' | 'sample' | 'emergency_box';

export interface CreateDispenseRequest {
  readonly pharmacyStoreId: string;
  readonly dispenseType: DispenseType;
  readonly prescriptionId?: string;
  readonly rxQueueId?: string;
  readonly patientId?: string;
  readonly encounterId?: string;
  readonly walkInName?: string;
  readonly walkInPhone?: string;
  readonly prescriberName?: string;
  readonly prescriberRegNo?: string;
  readonly payerType?: 'cash' | 'credit' | 'insurance' | 'corporate' | 'scheme';
  readonly notes?: string;
}

export interface AddDispenseItemRequest {
  readonly scanned?: string;
  readonly itemId?: string;
  readonly batchId?: string;
  readonly uomId?: string;
  readonly qtyEntered: number;
  readonly prescriptionItemId?: string;
  readonly qtyOrderedBase?: number;
  readonly partialReason?: string;
  readonly substitutionRequestId?: string;
  readonly fefoOverrideReason?: string;
  readonly sellingPrice?: number;
  readonly discount?: number;
}

export interface DeclineDispenseItemRequest {
  readonly itemId: string;
  readonly prescriptionItemId?: string;
  readonly status: 'declined' | 'backordered' | 'external';
  readonly reason: string;
  readonly qtyOrderedBase?: number;
  readonly uomId?: string;
}

export interface AcknowledgementInput {
  readonly dispenseItemId: string;
  readonly alertKey: string;
  readonly reason: string;
}

export interface CompleteDispenseRequest {
  readonly acknowledgements: readonly AcknowledgementInput[];
  readonly counselling?: {
    readonly counselled: boolean;
    readonly language?: string;
    readonly points?: readonly string[];
  };
  readonly coSigner?: CoSignerInput;
}

export interface RequestSubstitutionRequest {
  readonly prescriptionItemId?: string;
  readonly fromItemId: string;
  readonly toItemId: string;
  readonly reason: string;
  readonly prescriberUserId?: string;
  readonly decisionMinutes?: number;
}

export interface CreateSaleReturnRequest {
  readonly originalDispenseId: string;
  readonly reasonCode: string;
  readonly reason?: string;
  readonly lines: readonly {
    readonly dispenseItemId: string;
    readonly qtyEntered: number;
    readonly uomId?: string;
    readonly disposition: 'restock' | 'quarantine' | 'destroy';
  }[];
}

export type ExpiryAction =
  'return_to_supplier' | 'transfer' | 'discount' | 'quarantine' | 'writeoff' | 'disposal';

export interface ExpiryActionRequest {
  readonly storeId: string;
  readonly batchId: string;
  readonly itemId: string;
  readonly action: ExpiryAction;
  readonly qtyEntered: number;
  readonly uomId?: string;
  readonly reason: string;
  readonly bmwRecordRef?: string;
}

export type RecallSource = 'cdsco' | 'manufacturer' | 'internal' | 'vendor' | 'state_fda';

export interface RaiseRecallRequest {
  readonly source: RecallSource;
  readonly sourceRef?: string;
  readonly itemId: string;
  readonly batchNo: string;
  readonly recallClass: 'class_i' | 'class_ii' | 'class_iii';
  readonly reason: string;
}

export interface RegisterEntryRequest {
  readonly storeId: string;
  readonly itemId: string;
  readonly batchId?: string;
  readonly txnType: 'receipt' | 'issue' | 'return_in';
  readonly qtyEntered: number;
  readonly uomId?: string;
  readonly patientId?: string;
  readonly patientName?: string;
  readonly prescriberName?: string;
  readonly prescriberRegNo?: string;
  readonly rxRef?: string;
  readonly remarks?: string;
  readonly coSigner: CoSignerInput;
}

export interface CustodyCheckRequest {
  readonly storeId: string;
  readonly itemId: string;
  readonly batchId?: string;
  readonly shiftLabel: string;
  readonly physicalCountEntered: number;
  readonly uomId?: string;
  readonly incidentRef?: string;
  readonly explanation?: string;
  readonly adjustmentId?: string;
  readonly coSigner: CoSignerInput;
}

export interface DayCloseRequest {
  readonly pharmacyStoreId: string;
  readonly businessDate: string;
  readonly shiftLabel?: string;
  readonly cashCounted: number;
  readonly notes?: string;
}
