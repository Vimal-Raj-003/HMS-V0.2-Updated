/** Read models for Phase 7C. */

export interface RoomChargeRow {
  readonly id: string;
  readonly admissionId: string;
  readonly occupancyId: string | null;
  readonly chargeDate: string;
  readonly chargeCode: string;
  readonly classCode: string | null;
  readonly wardName: string | null;
  readonly units: number;
  readonly unitRate: number;
  readonly amount: number;
  readonly gstRate: number;
  readonly gstAmount: number;
  readonly isExempt: boolean;
  readonly exemptReason: string | null;
  readonly policy: string;
  readonly coversFrom: string;
  readonly coversTo: string;
  readonly supersededAt: string | null;
  readonly postedAt: string;
}

export interface RunningBillView {
  readonly admissionId: string;
  readonly ipNo: string;
  readonly roomCharges: number;
  readonly roomTotal: number;
  readonly gstTotal: number;
  readonly grandTotal: number;
  readonly depositTaken: number;
  /** Positive is money the patient still owes. */
  readonly outstanding: number;
  readonly charges: readonly RoomChargeRow[];
  /** Retained corrections, so a disputed night has an answer either way. */
  readonly superseded: readonly RoomChargeRow[];
}

export interface ChargeRunView {
  readonly id: string;
  readonly forDate: string;
  readonly trigger: string;
  readonly state: string;
  readonly admissionsConsidered: number;
  readonly chargesPosted: number;
  /**
   * Charges that already existed and were left alone.
   *
   * On a correct second run this equals the first run's `chargesPosted`, which
   * is the fastest way to see that the job is idempotent without reading a bill.
   */
  readonly chargesSkipped: number;
  readonly chargesSuperseded: number;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export interface ClearanceCheck {
  readonly key: string;
  readonly label: string;
  readonly state: 'clear' | 'blocked';
  readonly detail: string | null;
}

export interface ClearanceView {
  readonly id: string;
  readonly admissionId: string;
  readonly state: string;
  readonly checks: readonly ClearanceCheck[];
  readonly blockedReasons: readonly string[];
  readonly clearedAt: string | null;
  readonly overriddenAt: string | null;
  readonly overrideReason: string | null;
}
