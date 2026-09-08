/** What the charge-intent desk returns. */

export interface ChargeIntentRow {
  readonly id: string;
  readonly patientId: string;
  readonly visitId: string | null;
  readonly encounterId: string | null;
  readonly admissionId: string | null;
  readonly sourceModule: string;
  readonly sourceTable: string;
  readonly sourceId: string;
  readonly serviceKey: string | null;
  readonly description: string;
  readonly qty: string;
  readonly currency: string;
  readonly status: string;
  readonly billId: string | null;
  readonly billLineId: string | null;
  readonly postedAt: string | null;
  readonly reversedAt: string | null;
  readonly reversalReason: string | null;
  readonly createdAt: string;
  /**
   * True when the intent names no service. RC-003 cannot price what it cannot
   * name, so these are the ones a biller has to look at rather than post.
   */
  readonly unpriceable: boolean;
}

export interface PostChargesResult {
  readonly posted: number;
  readonly skipped: number;
  readonly unpriced: number;
  /** Intents that named no service and were left where they were. */
  readonly unpriceable: number;
  readonly billId: string;
}
